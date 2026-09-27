// Store cases beyond the acceptance tests: errors with their codes, the paths the
// acceptance suite does not walk, and the behaviors this batch had to decide.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture, sha256 } from '../helpers/fixture.mjs';
import { grantLease } from '../../src/leases.js';
import { readLedger } from '../../src/ledger.js';
import { openRoot } from '../../src/root.js';
import {
  asOf,
  commitWrite,
  editNote,
  history,
  initRoot,
  moveNote,
  pendingIdFor,
  prepareWrite,
  readNote,
  restore,
  scanExternal,
  showVersion,
  writeNote,
} from '../../src/store.js';

/** @typedef {import('../../src/types.js').Author} Author */
/** @type {Author} */ const A = { session: 'session-a', agent: 'cli' };
/** @type {Author} */ const B = { session: 'session-b', agent: 'mcp' };
const N = 'projects/gamma.md';

async function adopted() {
  const dir = copyFixture();
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  return openRoot(dir);
}
/** @param {import('../../src/types.js').Root} root @param {string} rel */
const read = (root, rel) => fs.readFileSync(path.join(root.dir, rel), 'utf8');
/** @param {import('../../src/types.js').Root} root @param {string} rel */
const entriesOf = (root, rel) => readLedger(root).entries.filter((e) => e.rel === rel);

test('init on an empty folder writes a minimal config and needs no author; progress is reported by hundreds', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-empty-'));
  const res = await initRoot(path.join(empty, 'new-root'), {});
  assert.equal(res.notes, 0);
  const root = openRoot(path.join(empty, 'new-root'));
  assert.equal(fs.readFileSync(path.join(root.stateDir, 'config.json'), 'utf8'), '{ "version": 1 }\n');
  assert.equal(fs.readFileSync(path.join(root.stateDir, '.gitignore'), 'utf8'), 'run/\nindex/\n');

  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-big-'));
  for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(big, `n${i}.md`), `# N${i}\n`);
  /** @type {number[]} */
  const seen = [];
  await initRoot(big, { adopt: true, author: A, onProgress: (done) => seen.push(done) });
  assert.deepEqual(seen, [100, 200]);
  const nothingToAdopt = await initRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-noauth-')), { adopt: true });
  assert.equal(nothingToAdopt.notes, 0, 'an empty folder needs no author, even with adopt');
});

test('adopting without an author is refused before anything is created', async () => {
  const dir = copyFixture();
  await assert.rejects(initRoot(dir, { adopt: true }), { code: 'NO_SESSION' });
  assert.equal(fs.existsSync(path.join(dir, '.mneme')), false);
});

test('writes need a session', async () => {
  const root = await adopted();
  await assert.rejects(writeNote(root, N, 'x', { author: /** @type {Author} */ ({ session: '', agent: 'cli' }) }), { code: 'NO_SESSION' });
});

test('edit errors carry their codes and a fix; replaceAll replaces every copy', async () => {
  const root = await adopted();
  await writeNote(root, N, '# G\n\ntodo todo\n', { author: A, reason: 'create' });
  await assert.rejects(editNote(root, N, { old: 'absent', new: 'x' }, { author: A }), { code: 'EDIT_NOT_FOUND', message: /Re-read/ });
  await assert.rejects(editNote(root, N, { old: 'todo', new: 'done' }, { author: A }), { code: 'EDIT_AMBIGUOUS', message: /2 times/ });
  await assert.rejects(editNote(root, N, { old: '', new: 'x' }, { author: A }), { code: 'EDIT_NOT_FOUND' });
  await assert.rejects(editNote(root, 'projects/none.md', { old: 'a', new: 'b' }, { author: A }), { code: 'NOTE_NOT_FOUND' });
  const res = await editNote(root, N, { old: 'todo', new: '$& done', replaceAll: true }, { author: A });
  assert.equal(res.ok, true);
  assert.equal(read(root, N), '# G\n\n$& done $& done\n', 'the replacement is literal, not a pattern');
  await assert.rejects(readNote(root, 'projects/none.md'), { code: 'NOTE_NOT_FOUND' });
});

test('a denied write returns the design-map text naming the owner, and changes nothing', async () => {
  const root = await adopted();
  await writeNote(root, N, '# G\n\n## Mine\n\nA\n', { author: A, reason: 'create' });
  const before = readLedger(root).entries.length;
  const res = await editNote(root, N, { old: '## Mine\n\nA\n', new: '' }, { author: B, reason: 'drop' });
  assert.equal(res.ok, false);
  if (res.ok) return;
  const lines = res.message.split('\n');
  assert.equal(lines[0], `[mneme] Blocked: this write to "${N}" removes sections written by another session:`);
  assert.match(lines[1], /^ {2}- ## Mine {3}\(session session-, cli, \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/);
  assert.match(lines[3], /--session session- --reason "<why>" \(10-minute lease, recorded\)\.$/);
  assert.equal(readLedger(root).entries.length, before);
});

test('a lease on another note does not open this one', async () => {
  const root = await adopted();
  await writeNote(root, N, '# G\n\n## Mine\n\nA\n', { author: A, reason: 'create' });
  grantLease(root, { session: B.session, rel: 'projects/alpha.md', minutes: 10, reason: 'other note' });
  const res = await writeNote(root, N, '# G\n', { author: B, reason: 'x' });
  assert.equal(res.ok, false);
});

test('restore by sha prefix; unknown versions and a deleting entry are refused', async () => {
  const root = await adopted();
  const v1 = '# G\n\none\n';
  await writeNote(root, N, v1, { author: A, reason: 'v1' });
  await writeNote(root, N, '# G\n\ntwo\n', { author: A, reason: 'v2' });
  const res = await restore(root, N, sha256(v1).slice(0, 10), { author: A, reason: 'back' });
  assert.equal(res.ok, true);
  assert.equal(read(root, N), v1);
  assert.equal(showVersion(root, sha256(v1).slice(0, 8)), v1);
  await assert.rejects(restore(root, N, 'nope', { author: A }), { code: 'VERSION_NOT_FOUND', message: /mneme history/ });
  fs.rmSync(path.join(root.dir, N));
  const [del] = await scanExternal(root);
  assert.equal(del.op, 'delete');
  await assert.rejects(restore(root, N, del.id, { author: A }), { code: 'VERSION_NOT_FOUND', message: /deleted/ });
  assert.throws(() => showVersion(root, 'ffffff'), { code: 'VERSION_NOT_FOUND' });
});

test('asOf: null before the note existed, and an invalid date is refused', async () => {
  const root = await adopted();
  const before = new Date(Date.now() - 60_000);
  await writeNote(root, N, '# G\n', { author: A, reason: 'create' });
  assert.equal(asOf(root, N, before), null);
  assert.equal(asOf(root, N, new Date(Date.now() + 1000))?.content, '# G\n');
  assert.throws(() => asOf(root, N, 'not a date'), { code: 'VERSION_NOT_FOUND' });
  assert.equal(history(root, N, { limit: 0 }).length, 0);
});

test('scanExternal records new, changed and deleted notes once, as external', async () => {
  const root = await adopted();
  fs.writeFileSync(path.join(root.dir, 'inbox', 'dropped.md'), '# Dropped\n');
  fs.appendFileSync(path.join(root.dir, 'manuals', 'deploy.md'), '\nmore\n');
  fs.rmSync(path.join(root.dir, 'manuals', 'backups.md'));
  const found = await scanExternal(root);
  assert.deepEqual(
    found.map((e) => [e.rel, e.op, e.author.session]).sort(),
    [
      ['inbox/dropped.md', 'external', 'external'],
      ['manuals/backups.md', 'delete', 'external'],
      ['manuals/deploy.md', 'external', 'external'],
    ],
  );
  assert.equal(found.find((e) => e.op === 'delete')?.after, null);
  assert.deepEqual(await scanExternal(root), [], 'nothing twice');
});

test('a section added by an external write is owned by "external": sessions cannot silently drop it', async () => {
  const root = await adopted();
  await writeNote(root, N, '# G\n', { author: A, reason: 'create' });
  fs.writeFileSync(path.join(root.dir, N), '# G\n\n## Added by hand\n\ntext\n');
  const res = await writeNote(root, N, '# G\n', { author: A, reason: 'cleanup' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.deepEqual(res.lost, [{ key: '## Added by hand', owners: ['external'] }]);
});

test('two-phase: a commit without its pending fails with a hint; a confirmed-late pending cannot be committed twice', async () => {
  const root = await adopted();
  await assert.rejects(commitWrite(root, 'never-prepared'), { code: 'PENDING_NOT_FOUND', message: /external/ });
  await writeNote(root, N, '# G\n', { author: A, reason: 'create' });
  const after = '# G\n\n## New\n';
  const prep = await prepareWrite(root, N, after, { author: A, tool: 'Edit' });
  assert.equal(prep.ok, true);
  if (!prep.ok) return;
  assert.equal(prep.pendingId, pendingIdFor(A.session, N, after));
  fs.writeFileSync(path.join(root.dir, N), after);
  await readNote(root, N); // confirms it late
  await assert.rejects(commitWrite(root, prep.pendingId), { code: 'PENDING_NOT_FOUND' });
  assert.equal(entriesOf(root, N).at(-1)?.late, true);
});

test('two-phase: a key with path characters stays inside the pending folder', async () => {
  const root = await adopted();
  const prep = await prepareWrite(root, N, '# G\n', { author: A, tool: 'Write', key: '../../../escape' });
  assert.equal(prep.ok, true);
  assert.equal(fs.existsSync(path.join(root.stateDir, 'escape.json')), false);
  assert.equal(fs.existsSync(path.join(root.dir, '..', 'escape.json')), false);
  fs.writeFileSync(path.join(root.dir, N), '# G\n');
  const done = await commitWrite(root, '../../../escape');
  assert.equal(done.entry.op, 'write');
  assert.equal(done.entry.before, null);
});

test('two-phase: a Write that lands over a section written in between is raced and names the loss', async () => {
  const root = await adopted();
  await writeNote(root, N, '# G\n', { author: A, reason: 'create' });
  const whole = '# G\n\n## A part\n';
  const prep = await prepareWrite(root, N, whole, { author: A, tool: 'Write', key: 'w1' });
  assert.equal(prep.ok, true);
  await editNote(root, N, { old: '# G\n', new: '# G\n\n## B part\n' }, { author: B, reason: 'between' });
  fs.writeFileSync(path.join(root.dir, N), whole); // the Write tool replaces the whole file
  const done = await commitWrite(root, 'w1');
  assert.equal(done.entry.raced, true);
  assert.deepEqual(done.entry.violations, ['## B part']);
  assert.deepEqual(done.entry.delta, { '## A part': 1 });
});

test('moving onto an existing note is refused; a missing source is NOTE_NOT_FOUND', async () => {
  const root = await adopted();
  await assert.rejects(moveNote(root, 'projects/alpha.md', 'projects/beta.md', { author: A }), { code: 'NOTE_EXISTS' });
  await assert.rejects(moveNote(root, 'projects/none.md', 'x/none.md', { author: A }), { code: 'NOTE_NOT_FOUND' });
  assert.ok(fs.existsSync(path.join(root.dir, 'projects/alpha.md')));
});

test('moving rewrites markdown links in other notes and re-bases the moved note own relative links', async () => {
  const root = await adopted();
  await writeNote(root, 'projects/beta.md', `${read(root, 'projects/beta.md')}\nSee [alpha](alpha.md#Plan) and [links](../notes/links.md).\n`, {
    author: A,
    reason: 'links',
  });
  const res = await moveNote(root, 'projects/beta.md', 'archive/2025/beta.md', { author: A, reason: 'archive' });
  const links = read(root, 'notes/links.md');
  assert.match(links, /\[beta panel\]\(\.\.\/archive\/2025\/beta\.md\)/);
  assert.match(links, /!\[\[beta\]\]/, 'a folderless embed keeps the (still unique) name');
  const moved = read(root, 'archive/2025/beta.md');
  assert.match(moved, /\[alpha\]\(\.\.\/\.\.\/projects\/alpha\.md#Plan\)/);
  assert.match(moved, /\[links\]\(\.\.\/\.\.\/notes\/links\.md\)/);
  assert.ok(res.entries.some((e) => e.op === 'move' && e.from === 'projects/beta.md'));
  assert.ok(res.entries.filter((e) => e.op === 'edit').every((e) => e.reason === 'link rewrite: move projects/beta.md -> archive/2025/beta.md'));
  assert.deepEqual(await scanExternal(root), [], 'every file the move touched is in the ledger');
  assert.equal(history(root, 'projects/beta.md').length, 0, 'the old name has no history of its own');
});

test('moving to a name that repeats another note uses the path in folderless links', async () => {
  const root = await adopted();
  await writeNote(root, 'inbox/alpha.md', '# Another alpha\n', { author: A, reason: 'twin' });
  await moveNote(root, 'projects/beta.md', 'archive/alpha.md', { author: A, reason: 'rename' });
  assert.match(read(root, 'notes/links.md'), /!\[\[archive\/alpha\]\]/);
});

test('ownership follows a move: the other session still cannot drop the section', async () => {
  const root = await adopted();
  await writeNote(root, N, '# G\n\n## Mine\n\nA\n', { author: A, reason: 'create' });
  await moveNote(root, N, 'archive/gamma.md', { author: B, reason: 'archive' });
  const res = await writeNote(root, 'archive/gamma.md', '# G\n', { author: B, reason: 'drop' });
  assert.equal(res.ok, false);
});
