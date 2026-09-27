import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeBareRoot } from '../helpers/fixture.mjs';
import { activeLease, grantLease, safeFileName } from '../../src/leases.js';
import { openRoot } from '../../src/root.js';

test('a lease covers one session on one note, and is audited in leases.jsonl', () => {
  const root = openRoot(makeBareRoot());
  const lease = grantLease(root, { session: 'sess-1', rel: 'projects/alpha.md', minutes: 10, reason: 'a human confirmed' });
  assert.equal(activeLease(root, 'sess-1', 'projects/alpha.md')?.id, lease.id);
  assert.equal(activeLease(root, 'sess-1', 'projects/beta.md'), null, 'another note');
  assert.equal(activeLease(root, 'sess-2', 'projects/alpha.md'), null, 'another session');
  const audit = fs.readFileSync(path.join(root.stateDir, 'leases.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(audit[0]).reason, 'a human confirmed');
});

test('an expired lease no longer counts', () => {
  const root = openRoot(makeBareRoot());
  grantLease(root, { session: 's', rel: 'projects/alpha.md', minutes: 1 / 60_000, reason: 'blink' });
  const until = Date.now() + 5;
  while (Date.now() < until) { /* let one millisecond-lease expire */ }
  assert.equal(activeLease(root, 's', 'projects/alpha.md'), null);
});

test('a session id cannot steer the lease file out of its folder', () => {
  const root = openRoot(makeBareRoot());
  grantLease(root, { session: '../../escape', rel: 'projects/alpha.md', minutes: 5, reason: 'x' });
  assert.equal(fs.existsSync(path.join(root.stateDir, 'escape.json')), false);
  assert.equal(activeLease(root, '../../escape', 'projects/alpha.md')?.session, '../../escape');
  assert.match(safeFileName('../x'), /^[0-9a-f]{64}$/);
  assert.equal(safeFileName('tool_use-01'), 'tool_use-01');
});

test('a lease needs a session and a positive length; paths outside the root are refused', () => {
  const root = openRoot(makeBareRoot());
  assert.throws(() => grantLease(root, { session: '', rel: 'a.md', reason: 'x' }), { code: 'NO_SESSION' });
  assert.throws(() => grantLease(root, { session: 's', rel: 'a.md', minutes: 0, reason: 'x' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => grantLease(root, { session: 's', rel: '../a.md', reason: 'x' }), { code: 'PATH_ESCAPES_ROOT' });
});

test('an unreadable lease file is ignored and recorded, not fatal', () => {
  const root = openRoot(makeBareRoot());
  fs.mkdirSync(path.join(root.stateDir, 'run', 'leases'), { recursive: true });
  fs.writeFileSync(path.join(root.stateDir, 'run', 'leases', 's.json'), '{not json');
  assert.equal(activeLease(root, 's', 'projects/alpha.md'), null);
  assert.match(fs.readFileSync(path.join(root.stateDir, 'run', 'errors.jsonl'), 'utf8'), /unreadable lease/);
});
