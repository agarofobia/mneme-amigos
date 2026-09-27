import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeBareRoot, sleep } from '../helpers/fixture.mjs';
import { withLock } from '../../src/lock.js';
import { openRoot } from '../../src/root.js';

const root = () => openRoot(makeBareRoot());
/** @param {import('../../src/types.js').Root} r */
const lockFile = (r) => path.join(r.stateDir, 'run', 'lock');

/** A pid that existed a moment ago and is gone now. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(child.stdout.toString());
}

test('two holders in the same process never overlap, and the lock is released', async () => {
  const r = root();
  let inside = 0;
  let maxInside = 0;
  const job = async () =>
    withLock(r, async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await sleep(15);
      inside--;
    });
  await Promise.all([job(), job(), job()]);
  assert.equal(maxInside, 1);
  assert.equal(fs.existsSync(lockFile(r)), false);
});

test('the lock is released when fn throws, and the error comes through', async () => {
  const r = root();
  await assert.rejects(withLock(r, () => { throw new Error('inner'); }), /inner/);
  assert.equal(fs.existsSync(lockFile(r)), false);
});

test('a lock held by a live process times out with its pid and what to do', async () => {
  const r = root();
  fs.mkdirSync(path.dirname(lockFile(r)), { recursive: true });
  fs.writeFileSync(lockFile(r), JSON.stringify({ pid: process.ppid, host: os.hostname(), ts: '2026-01-01T00:00:00.000Z', rand: 'x' }));
  await assert.rejects(withLock(r, () => 1, { timeoutMs: 150 }), {
    code: 'LOCK_TIMEOUT',
    message: new RegExp(`pid ${process.ppid}, since 2026-01-01T00:00:00.000Z\\). Retry, or run mneme doctor\\.`),
  });
  assert.ok(fs.existsSync(lockFile(r)), 'a live lock is never removed');
});

test('an orphan lock (its process is dead) is stolen at once', async () => {
  const r = root();
  fs.mkdirSync(path.dirname(lockFile(r)), { recursive: true });
  fs.writeFileSync(lockFile(r), JSON.stringify({ pid: deadPid(), host: os.hostname(), ts: new Date().toISOString(), rand: 'x' }));
  const t0 = Date.now();
  assert.equal(await withLock(r, () => 'got it', { timeoutMs: 2000 }), 'got it');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(fs.existsSync(lockFile(r)), false);
});

test('a lock re-taken after it was judged orphaned is not stolen (25/09: two holders at once)', async () => {
  // The race TE-2 hit under load: B reads the token of A; A releases and exits; C takes a
  // fresh lock; B judges A's token orphaned (A's pid is dead) and renames C's lock away; D
  // takes the lock in the gap, so C's lock cannot be given back: C and D both hold it.
  const r = root();
  fs.mkdirSync(path.dirname(lockFile(r)), { recursive: true });
  const token = (/** @type {string} */ rand, /** @type {number} */ pid) => JSON.stringify({ pid, host: os.hostname(), ts: new Date().toISOString(), rand });
  const fresh = token('fresh', process.ppid);
  fs.writeFileSync(lockFile(r), token('dead', deadPid()));
  process.env.MNEME_TEST_STEAL_PAUSE_MS = '120';
  process.env.MNEME_TEST_STEAL_GAP_MS = '200';
  try {
    const attempt = withLock(r, () => 'entered', { timeoutMs: 700 });
    await sleep(40); // judged orphaned; pausing before the steal
    fs.writeFileSync(lockFile(r), fresh); // meanwhile the lock was released and re-taken by a live process
    await sleep(170); // an unguarded steal has renamed the fresh lock away by now
    try {
      fs.writeFileSync(lockFile(r), token('third', process.ppid), { flag: 'wx' });
    } catch {
      // the fresh lock is still in place: there is no gap to take it in
    }
    await assert.rejects(attempt, { code: 'LOCK_TIMEOUT' }, 'a live holder keeps its lock');
  } finally {
    delete process.env.MNEME_TEST_STEAL_PAUSE_MS;
    delete process.env.MNEME_TEST_STEAL_GAP_MS;
  }
  assert.equal(fs.readFileSync(lockFile(r), 'utf8'), fresh, 'the fresh lock was never moved');
  const errors = path.join(r.stateDir, 'run', 'errors.jsonl');
  assert.ok(!fs.existsSync(errors) || !/taken by mistake/.test(fs.readFileSync(errors, 'utf8')));
  assert.equal(fs.existsSync(`${lockFile(r)}.steal`), false, 'the steal guard is released');
});

test('a steal guard left by a stealer that died does not block stealing forever', async () => {
  const r = root();
  fs.mkdirSync(path.dirname(lockFile(r)), { recursive: true });
  fs.writeFileSync(lockFile(r), JSON.stringify({ pid: deadPid(), host: os.hostname(), ts: new Date().toISOString(), rand: 'x' }));
  fs.writeFileSync(`${lockFile(r)}.steal`, 'a stealer that died');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${lockFile(r)}.steal`, old, old);
  assert.equal(await withLock(r, () => 'got it', { timeoutMs: 2000 }), 'got it');
  assert.equal(fs.existsSync(`${lockFile(r)}.steal`), false);
});

test('a lock older than staleMs is stolen even without a readable token', async () => {
  const r = root();
  fs.mkdirSync(path.dirname(lockFile(r)), { recursive: true });
  fs.writeFileSync(lockFile(r), '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile(r), old, old);
  assert.equal(await withLock(r, () => 42, { timeoutMs: 500, staleMs: 1000 }), 42);
});

test('a holder whose lock was taken over does not delete the new owner lock, and records it', async () => {
  const r = root();
  await withLock(r, () => {
    fs.writeFileSync(lockFile(r), '{"pid":1,"host":"elsewhere","rand":"theirs"}');
  });
  assert.equal(fs.readFileSync(lockFile(r), 'utf8'), '{"pid":1,"host":"elsewhere","rand":"theirs"}');
  const errors = fs.readFileSync(path.join(r.stateDir, 'run', 'errors.jsonl'), 'utf8');
  assert.match(errors, /taken over/);
});

test('MNEME_UNSAFE_NO_LOCK skips the lock (test-only negative control)', async () => {
  const r = root();
  fs.mkdirSync(path.dirname(lockFile(r)), { recursive: true });
  fs.writeFileSync(lockFile(r), JSON.stringify({ pid: process.ppid, host: os.hostname(), rand: 'held' }));
  process.env.MNEME_UNSAFE_NO_LOCK = '1';
  try {
    assert.equal(await withLock(r, () => 'no lock', { timeoutMs: 50 }), 'no lock');
  } finally {
    delete process.env.MNEME_UNSAFE_NO_LOCK;
  }
});
