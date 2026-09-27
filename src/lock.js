// One lock per root, shared by every process that writes to it: `<stateDir>/run/lock`.
// Created with O_EXCL ('wx') and a token; released only by its owner; an orphan (its
// process died, or it is older than `staleMs`) is stolen with a rename, never deleted
// blindly; stealers take turns under `run/lock.steal` and re-read the lock under it.
//
// TEST-ONLY switches (documented in docs/arquitectura/03-contratos.md §4.8):
//   MNEME_UNSAFE_NO_LOCK=1          withLock runs `fn` without the lock (negative control of TE-2).
//   MNEME_TEST_STEAL_PAUSE_MS=<n>   wait n ms between judging a lock orphaned and stealing it
//   MNEME_TEST_STEAL_GAP_MS=<n>     wait n ms between renaming a lock away and checking what it was
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MnemeError } from './errors.js';
import { NAME } from './name.js';

/** @typedef {import('./types.js').Root} Root */
/** @typedef {{ pid?: number, host?: string, ts?: string, rand?: string }} Token */

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {'MNEME_TEST_STEAL_PAUSE_MS'|'MNEME_TEST_STEAL_GAP_MS'} name */
async function testPause(name) {
  const ms = Number(process.env[name] ?? 0);
  if (ms > 0) await sleep(ms);
}

/**
 * Records an error the caller must not throw (a release, a hook) in
 * `<stateDir>/run/errors.jsonl`, where `doctor` shows it. If even that fails, stderr.
 * @param {Root} root
 * @param {string} where
 * @param {string} message
 */
export function recordError(root, where, message) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), where, pid: process.pid, message })}\n`;
  try {
    fs.mkdirSync(path.join(root.stateDir, 'run'), { recursive: true });
    fs.appendFileSync(path.join(root.stateDir, 'run', 'errors.jsonl'), line, 'utf8');
  } catch (e) {
    process.stderr.write(`[${NAME}] ${where}: ${message} (and could not record it: ${/** @type {Error} */ (e).message})\n`);
  }
}

/** @param {string} text */
function parseToken(text) {
  try {
    const t = JSON.parse(text);
    return t !== null && typeof t === 'object' ? /** @type {Token} */ (t) : {};
  } catch {
    // An empty or torn token (its writer died mid-write): it carries no owner; age decides.
    return {};
  }
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * @param {string} file
 * @param {string} token
 * @returns {boolean} true when the lock is now ours
 */
function tryCreate(file, token) {
  try {
    fs.writeFileSync(file, token, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
    // EEXIST: held. On Windows a lock being deleted answers EPERM for a moment.
    if (code === 'EEXIST' || BUSY.has(code)) return false;
    throw e;
  }
}

/**
 * @param {string} file
 * @returns {{ text: string, mtimeMs: number }|null}  null: gone or unreadable for a moment
 */
function observe(file) {
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    return { text: fs.readFileSync(file, 'utf8'), mtimeMs };
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
    if (code === 'ENOENT' || BUSY.has(code)) return null;
    throw e;
  }
}

/**
 * @param {{ text: string, mtimeMs: number }} seen
 * @param {number} staleMs
 */
function isStale(seen, staleMs) {
  if (Date.now() - seen.mtimeMs > staleMs) return true;
  const t = parseToken(seen.text);
  // Same machine and its process is gone: an orphan right now, no need to wait.
  return t.host === os.hostname() && typeof t.pid === 'number' && t.pid !== process.pid && !alive(t.pid);
}

/** A steal guard is held for a few syscalls: an older one belongs to a stealer that died. */
const GUARD_STALE_MS = 5000;

/**
 * Removes `file` only if it still holds `text`: rename it aside, and give it back if what
 * was renamed is something else. For the steal guard, whose owner is judged by age alone.
 * @param {string} file
 * @param {string} text
 */
function removeIfUnchanged(file, text) {
  const aside = `${file}.old-${randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(file, aside);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
    if (code === 'ENOENT' || BUSY.has(code)) return;
    throw e;
  }
  if (fs.readFileSync(aside, 'utf8') !== text) {
    try {
      fs.linkSync(aside, file);
    } catch {
      // a newer guard is already there: it is the one that counts
    }
  }
  fs.rmSync(aside, { force: true });
}

/**
 * Steals an orphan lock. Stealers take turns under a guard (`lock.steal`, created with
 * O_EXCL) and, under it, read the lock again: it is renamed away only if it still holds the
 * very token that was judged orphaned. An owner judged dead cannot release, and every other
 * stealer waits for the guard, so between that check and the rename nobody can put a fresh
 * lock there. (25/09: without the guard, a lock released and re-taken after it was judged
 * was renamed away, a third process took the gap, and two processes held the lock at once;
 * TE-2 lost a write under load.) Only an owner that is alive but older than `staleMs` can
 * still release in between: what was renamed is then checked and given back, as before.
 * @param {Root} root
 * @param {string} file
 * @param {string} observed
 */
async function steal(root, file, observed) {
  const guard = `${file}.steal`;
  const mine = randomBytes(8).toString('hex');
  if (!tryCreate(guard, mine)) {
    const held = observe(guard);
    if (held && Date.now() - held.mtimeMs > GUARD_STALE_MS) removeIfUnchanged(guard, held.text);
    return; // another stealer is at it: the caller looks again
  }
  try {
    const now = observe(file);
    if (now === null || now.text !== observed) return; // released or re-taken since it was judged
    const stolen = `${file}.stolen-${randomBytes(6).toString('hex')}`;
    try {
      fs.renameSync(file, stolen);
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
      if (code === 'ENOENT' || BUSY.has(code)) return;
      throw e;
    }
    await testPause('MNEME_TEST_STEAL_GAP_MS');
    const taken = fs.readFileSync(stolen, 'utf8');
    if (taken !== observed) {
      try {
        fs.linkSync(stolen, file); // fails if a newer lock exists: never clobber it
      } catch (e) {
        recordError(
          root,
          'lock',
          `a fresh lock (${taken}) was taken by mistake while stealing an orphan and could not be given back: ${/** @type {Error} */ (e).message}`,
        );
      }
    }
    fs.rmSync(stolen, { force: true });
  } finally {
    // Only our own guard: if it was judged stale and replaced, the new one is someone else's.
    try {
      if (fs.readFileSync(guard, 'utf8') === mine) fs.rmSync(guard);
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
      if (code !== 'ENOENT' && !BUSY.has(code)) recordError(root, 'lock', `could not release the steal guard: ${/** @type {Error} */ (e).message}`);
    }
  }
}

/**
 * @param {Root} root
 * @param {string} file
 * @param {string} token
 */
function release(root, file, token) {
  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (e) {
    recordError(root, 'lock', `the lock was gone at release (held too long and stolen?): ${/** @type {Error} */ (e).message}`);
    return;
  }
  if (current !== token) {
    recordError(root, 'lock', `the lock was taken over by ${current} while this process (${token}) held it; it was left alone`);
    return;
  }
  try {
    fs.rmSync(file);
  } catch (e) {
    recordError(root, 'lock', `could not release the lock: ${/** @type {Error} */ (e).message}. It will be stolen as an orphan.`);
  }
}

/**
 * Runs `fn` holding the root's lock, across processes.
 * @template T
 * @param {Root} root
 * @param {() => Promise<T>|T} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withLock(root, fn, { timeoutMs = root.config.lockTimeoutMs, staleMs = 15000 } = {}) {
  if (process.env.MNEME_UNSAFE_NO_LOCK === '1') return fn();
  const runDir = path.join(root.stateDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'lock');
  const token = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    ts: new Date().toISOString(),
    rand: randomBytes(8).toString('hex'),
  });
  const started = Date.now();
  let wait = 2;
  for (;;) {
    if (tryCreate(file, token)) break;
    const seen = observe(file);
    if (seen && isStale(seen, staleMs)) {
      await testPause('MNEME_TEST_STEAL_PAUSE_MS');
      await steal(root, file, seen.text);
      continue;
    }
    if (Date.now() - started >= timeoutMs) {
      const holder = seen ? parseToken(seen.text) : {};
      const since = holder.ts ?? (seen ? new Date(seen.mtimeMs).toISOString() : 'unknown');
      throw new MnemeError(
        'LOCK_TIMEOUT',
        `Another process holds the lock on ${root.dir} (pid ${holder.pid ?? 'unknown'}, since ${since}). Retry, or run ${NAME} doctor.`,
      );
    }
    await sleep(wait + Math.random() * wait);
    wait = Math.min(wait * 2, 40);
  }
  try {
    return await fn();
  } finally {
    release(root, file, token);
  }
}
