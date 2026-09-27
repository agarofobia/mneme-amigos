// The D-7 counter (docs/arquitectura/03-contratos.md §4.15): what `audit` calls a loss,
// and what it only lists. Every case is built with the store, the way sessions write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture, sleep } from '../helpers/fixture.mjs';
import { HOME_VAR, isolateHome, runCli } from '../aceptacion/l3-helpers.mjs';
import { audit } from '../../src/audit.js';
import { grantLease } from '../../src/leases.js';
import { readLedger } from '../../src/ledger.js';
import { openRoot } from '../../src/root.js';
import { recordDenial } from '../../src/sessions.js';
import { commitWrite, editNote, initRoot, moveNote, prepareWrite, restore, scanExternal, writeNote } from '../../src/store.js';

/** @typedef {import('../../src/types.js').Author} Author */
/** @typedef {import('../../src/types.js').Root} Root */
/** @type {Author} */ const A = { session: 'session-a', agent: 'claude-code' };
/** @type {Author} */ const B = { session: 'session-b', agent: 'claude-code' };
const N = 'projects/alpha.md';
const SECTION = '\n## Section A\n\nWritten by session A.\n';

async function adopted() {
  const dir = copyFixture();
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  return openRoot(dir);
}
/** @param {Root} root */
const abs = (root) => path.join(root.dir, N);
/** @param {Root} root */
const read = (root) => fs.readFileSync(abs(root), 'utf8');

/** A writes its section; then someone outside the tools removes it; scan records it. */
async function clashed() {
  const root = await adopted();
  const original = read(root);
  const a = await writeNote(root, N, original + SECTION, { author: A });
  assert.equal(a.ok, true);
  fs.writeFileSync(abs(root), original);
  const [external] = await scanExternal(root);
  assert.deepEqual(external.violations, ['## Section A']);
  return { root, original, external };
}

test('a clash whose earlier version is kept is not a loss: it is listed as open until the section comes back', async () => {
  const { root, original, external } = await clashed();
  let res = audit(root);
  assert.equal(res.losses.length, 0);
  assert.equal(res.clashes.length, 1);
  assert.equal(res.clashes[0].entry.id, external.id);
  assert.deepEqual(res.clashes[0].keys, ['## Section A']);
  assert.equal(res.clashes[0].state, 'open');
  assert.equal(res.clashes[0].rel, N);

  await writeNote(root, N, original + SECTION, { author: A, reason: 'put my section back' });
  res = audit(root);
  assert.equal(res.clashes[0].state, 'repaired');
  assert.equal(res.losses.length, 0);
});

test('a clash whose earlier version is missing from objects/ is a loss, counted once', async () => {
  const { root, external } = await clashed();
  const before = /** @type {string} */ (external.before);
  fs.rmSync(path.join(root.stateDir, 'objects', before.slice(0, 2), before));
  const res = audit(root);
  assert.equal(res.losses.length, 1, JSON.stringify(res.losses));
  assert.equal(res.losses[0].kind, 'unrestorable');
  assert.equal(res.losses[0].rel, N);
  assert.deepEqual(res.losses[0].keys, ['## Section A']);
  assert.equal(res.clashes.length, 1, 'the clash is still listed');
});

test('a version the ledger names and objects/ lacks is a loss even without a clash', async () => {
  const root = await adopted();
  const a = await writeNote(root, N, read(root) + SECTION, { author: A });
  assert.equal(a.ok, true);
  const after = /** @type {string} */ (a.ok && a.entry.after);
  fs.rmSync(path.join(root.stateDir, 'objects', after.slice(0, 2), after));
  const res = audit(root);
  assert.deepEqual(res.losses.map((l) => l.kind), ['missing-version']);
  assert.equal(res.losses[0].sha, after);
});

test('a removal a person allowed with a lease is authorized, not a clash nor a loss', async () => {
  const root = await adopted();
  const original = read(root);
  assert.equal((await writeNote(root, N, original + SECTION, { author: A })).ok, true);
  const denied = await writeNote(root, N, original, { author: B });
  assert.equal(denied.ok, false, 'without a lease the guard blocks B');
  grantLease(root, { session: B.session, rel: N, reason: 'A left, the section is obsolete' });
  const allowed = await writeNote(root, N, original, { author: B });
  assert.equal(allowed.ok, true);
  const res = audit(root);
  assert.equal(res.losses.length, 0);
  assert.equal(res.clashes.length, 0);
  assert.equal(res.authorized.length, 1);
  assert.deepEqual(res.authorized[0].keys, ['## Section A']);
  assert.equal(res.authorized[0].entry.author.session, B.session);
});

test('a write that started from a version that was no longer current is a fork: a clash that names what it overwrote', async () => {
  // Two holders at once (25/09, the race in lock.js): both read v0; A writes vA; B writes vB
  // from v0, dropping A's section. Measured against its own `before`, B removed nothing, so
  // without the fork check audit saw neither a loss nor a clash.
  const root = await adopted();
  const original = read(root);
  const WITH_B = original + '\n## Section B\n\nWritten by session B.\n';
  Object.assign(process.env, { MNEME_UNSAFE_NO_LOCK: '1', MNEME_UNSAFE_NO_CAS: '1', MNEME_TEST_RACE_DELAY_MS: '100' });
  let results;
  try {
    results = await Promise.all([
      writeNote(root, N, original + SECTION, { author: A }),
      sleep(20).then(() => writeNote(root, N, WITH_B, { author: B })),
    ]);
  } finally {
    delete process.env.MNEME_UNSAFE_NO_LOCK;
    delete process.env.MNEME_UNSAFE_NO_CAS;
    delete process.env.MNEME_TEST_RACE_DELAY_MS;
  }
  assert.deepEqual(results.map((w) => w.ok), [true, true]);
  assert.equal(read(root), WITH_B, "A's section is gone from the file");
  const res = audit(root);
  const forks = res.clashes.filter((c) => c.fork);
  assert.equal(forks.length, 1, JSON.stringify(res.clashes));
  assert.equal(forks[0].entry.author.session, B.session);
  assert.deepEqual(forks[0].keys, ['## Section A']);
  assert.equal(forks[0].restorable, true);
  assert.equal(forks[0].state, 'open');
  assert.equal(res.losses.length, 0, 'the overwritten version is kept: a clash, not a loss');
});

test('an ordinary history has no fork: writes, edits, an external change, a restore, a two-phase write and a move', async () => {
  // The control of the fork check: if it flagged these, it would flag every vault.
  const root = await adopted();
  const original = read(root);
  const first = await writeNote(root, N, original + SECTION, { author: A });
  assert.equal(first.ok, true);
  assert.equal((await editNote(root, N, { old: 'Written by session A.', new: 'Written by session A, edited.' }, { author: A })).ok, true);
  fs.appendFileSync(abs(root), '\nfrom an editor\n');
  await scanExternal(root);
  assert.equal((await restore(root, N, /** @type {string} */ (first.ok && first.entry.after), { author: A, reason: 'back' })).ok, true);
  const next = read(root) + '\n## Section B\n\nWritten by session B.\n';
  const prep = await prepareWrite(root, N, next, { author: B, tool: 'Write', key: 'b-1' });
  assert.equal(prep.ok, true);
  fs.writeFileSync(abs(root), next);
  await commitWrite(root, 'b-1');
  await moveNote(root, N, 'projects/alpha-moved.md', { author: B, reason: 'rename' });
  assert.equal((await writeNote(root, 'projects/alpha-moved.md', `${next}\nmore\n`, { author: B })).ok, true);
  const res = audit(root);
  assert.deepEqual(res.clashes.filter((c) => c.fork), [], JSON.stringify(res.clashes.filter((c) => c.fork).map((c) => c.entry.op)));
  assert.equal(res.losses.length, 0);
});

test('a broken ledger chain is a loss of record, whatever --since says', async () => {
  const root = await adopted();
  assert.equal((await writeNote(root, N, read(root) + SECTION, { author: A })).ok, true);
  const file = path.join(root.stateDir, 'ledger.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // Rewriting a line in the middle: the next line's `prev` no longer matches it.
  lines[1] = lines[1].replace(/"ts":"[^"]+"/, '"ts":"2000-01-01T00:00:00.000Z"');
  fs.writeFileSync(file, lines.join('\n'));
  const res = audit(root, { since: new Date(Date.now() + 60_000) });
  assert.equal(res.ledger.broken, 1, 'the edit broke the chain once');
  assert.deepEqual(res.losses.map((l) => l.kind), ['ledger']);
});

test('denials are read with and without their sections; resumed says whether that session wrote the note afterwards', async () => {
  const root = await adopted();
  const original = read(root);
  assert.equal((await writeNote(root, N, original + SECTION, { author: A })).ok, true);
  recordDenial(root, 'session-old', N); // a denial recorded before sections were kept
  const denied = await writeNote(root, N, original, { author: B });
  assert.equal(denied.ok, false);
  recordDenial(root, B.session, N, denied.ok ? [] : denied.lost);
  let res = audit(root);
  assert.equal(res.denials.length, 2);
  const [old, b] = res.denials;
  assert.equal(old.session, 'session-old');
  assert.deepEqual(old.sections, []);
  assert.equal(old.resumed, false);
  assert.deepEqual(b.sections, [{ key: '## Section A', owners: [A.session] }]);
  assert.equal(b.resumed, false);

  assert.equal((await writeNote(root, N, read(root) + '\n## Section B\n\nB, on its own section.\n', { author: B })).ok, true);
  res = audit(root);
  assert.equal(res.denials[1].resumed, true);
  assert.equal(res.denials[0].resumed, false);
});

test('--since leaves out clashes, authorized removals and denials from before it', async () => {
  const { root } = await clashed();
  recordDenial(root, B.session, N, []);
  const later = audit(root, { since: new Date(Date.now() + 60_000) });
  assert.equal(later.clashes.length, 0);
  assert.equal(later.denials.length, 0);
  const earlier = audit(root, { since: '2000-01-01' });
  assert.equal(earlier.clashes.length, 1);
  assert.equal(earlier.denials.length, 1);
  assert.throws(() => audit(root, { since: 'not a date' }), /date/);
});

test('the CLI: exit 0 with no loss, exit 1 with one, --json parses, a bad --since is a usage error', async () => {
  const env = { [HOME_VAR]: isolateHome() };
  const { root, external } = await clashed();
  const clean = await runCli(['audit', '--root', root.dir], { env });
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /^losses: 0$/m);
  assert.match(clean.stdout, /^clashes \(.*\): 1 \(1 open\)$/m);
  assert.match(clean.stdout, /## Section A .* open {2}what was there: \S+ show "projects\/alpha\.md" --version [0-9a-f]{12}/);

  const before = /** @type {string} */ (external.before);
  fs.rmSync(path.join(root.stateDir, 'objects', before.slice(0, 2), before));
  const lost = await runCli(['audit', '--root', root.dir, '--json'], { env });
  assert.equal(lost.code, 1);
  assert.equal(JSON.parse(lost.stdout).losses[0].kind, 'unrestorable');

  const bad = await runCli(['audit', '--root', root.dir, '--since', 'yesterday-ish'], { env });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not a date/);
});

test('a note changed on disk and not yet recorded is listed, and audit itself records nothing', async () => {
  const root = await adopted();
  const entries = readLedger(root).entries.length;
  fs.appendFileSync(abs(root), '\nA line added in an editor.\n');
  const res = audit(root);
  assert.deepEqual(res.unrecorded, [N]);
  assert.equal(res.losses.length, 0);
  assert.equal(readLedger(root).entries.length, entries, 'audit is read-only');
  await scanExternal(root);
  assert.deepEqual(audit(root).unrecorded, []);
});
