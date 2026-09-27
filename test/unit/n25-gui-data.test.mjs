// Contracts §4.17: the GUI's data layer. Read-only, one state per section, history with
// diffs, notices, audit, empty and error roots.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture } from '../helpers/fixture.mjs';
import { isolateHome } from '../aceptacion/l3-helpers.mjs';
import { collectGui } from '../../src/gui/data.js';
import { STATE_DIR } from '../../src/name.js';
import { openRoot } from '../../src/root.js';
import { recordDenial, touchSession } from '../../src/sessions.js';
import { initRoot, prepareWrite, scanExternal, writeNote } from '../../src/store.js';

isolateHome();

/** @typedef {import('../../src/types.js').Author} Author */
/** @type {Author} */ const A = { session: 'a1b2c3d4-aaaa', agent: 'claude-code' };
/** @type {Author} */ const B = { session: '718c5692-bbbb', agent: 'mcp', client: 'cursor' };
const N = 'projects/alpha.md';

/** The abanico's scene, built with the store the way sessions write. */
async function scene() {
  const dir = copyFixture();
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  const root = openRoot(dir);
  const abs = path.join(dir, N);
  const read = () => fs.readFileSync(abs, 'utf8');
  assert.equal((await writeNote(root, N, `${read()}\n## Rollout\n\nShip it in two waves.\n`, { author: A, reason: 'plan the rollout' })).ok, true);
  assert.equal((await writeNote(root, N, `${read()}\n## Owned by B\n\nB keeps this.\n`, { author: B })).ok, true);
  assert.equal((await writeNote(root, N, `${read()}\n## Old rollout\n<!-- superseded_by: [[beta]] -->\n\nThe first idea.\n`, { author: A })).ok, true);
  fs.writeFileSync(abs, read().replace('We keep the lexical fallback', 'We keep the lexical fallback, always'));
  assert.equal((await scanExternal(root)).length, 1);
  recordDenial(root, A.session, N, [{ key: '## Owned by B', owners: [B.session] }]);
  touchSession(root, A);
  touchSession(root, B, { intent: 'editing alpha', paths: [N] });
  return root;
}

/** sha256 of every file under the state directory. */
function stateBytes(/** @type {string} */ dir) {
  /** @type {Record<string, string>} */
  const out = {};
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(path.join(dir, STATE_DIR));
  return out;
}

test('each section gets its state, owners and last write; the note says who is writing it', async () => {
  const root = await scene();
  const data = await collectGui([root]);
  const view = data.roots[0];
  assert.equal(view.state, 'data');
  const note = view.notes.find((n) => n.rel === N);
  assert.ok(note);
  const st = Object.fromEntries(note.sections.map((s) => [s.key, s.st]));
  assert.equal(st['# Alpha'], 'adopted');
  assert.equal(st['## Plan'], 'adopted');
  assert.equal(st['## Rollout'], 'normal');
  assert.equal(st['## Owned by B'], 'denied');
  assert.equal(st['## Old rollout'], 'stale');
  assert.equal(st['## Decisions'], 'external');
  const rollout = note.sections.find((s) => s.key === '## Rollout');
  assert.deepEqual(rollout?.owners, [A.session]);
  assert.equal(rollout?.last?.session, A.session);
  assert.equal(rollout?.last?.reason, 'plan the rollout');
  assert.match(String(note.sections.find((s) => s.key === '## Old rollout')?.stale), /superseded by \[\[beta\]\]/);
  assert.deepEqual(note.writing.map((w) => w.session), [B.session]);
  assert.deepEqual(note.flags, { stale: true, external: true, writing: true, denied: true });
  assert.equal(note.denials.length, 1);
  assert.deepEqual(note.denials[0].sections, [{ key: '## Owned by B', owners: [B.session] }]);
  const sessions = view.sessions.map((s) => s.session).sort();
  assert.deepEqual(sessions, [B.session, A.session].sort());
  assert.deepEqual(view.sessions.find((s) => s.session === B.session)?.writing, [N]);
  assert.equal(view.initial, N, 'the note written most recently is the first one shown');
});

test('the history is newest first, marks the head, and carries diffs of the last versions', async () => {
  const root = await scene();
  const note = (await collectGui([root])).roots[0].notes.find((n) => n.rel === N);
  assert.ok(note);
  assert.deepEqual(note.history.map((h) => h.op), ['external', 'write', 'write', 'write', 'adopt']);
  assert.equal(note.history[0].head, true);
  assert.equal(note.history.filter((h) => h.head).length, 1);
  const ext = note.history[0];
  assert.ok(ext.diff, 'the external write has a diff');
  assert.ok(ext.diff.some((l) => l.op === '+' && l.text.includes('always')));
  assert.ok(ext.diff.some((l) => l.op === '-' && !l.text.includes('always')));
  assert.equal(note.history[4].diff, null, 'adopt has nothing before it');
  assert.equal(note.history[0].restorable, false, 'the head is not restored onto itself');
  assert.equal(note.history[1].restorable, true);
});

test('notices of the last 24 h, the audit counts, and the searches run for --query', async () => {
  const root = await scene();
  const view = (await collectGui([root], { queries: ['vector index migration'] })).roots[0];
  assert.ok(view.notices.length >= 4);
  const ext = view.notices.find((n) => n.op === 'external');
  assert.deepEqual(ext?.changed, ['## Decisions']);
  assert.equal(view.audit?.losses, 0);
  assert.equal(view.audit?.denials, 1);
  assert.equal(view.searches.length, 1);
  assert.equal(view.searches[0].query, 'vector index migration');
  assert.ok(view.searches[0].hits.length > 0);
  assert.ok(view.searches[0].hits[0].text.length <= 240);
});

test('collecting is read-only: not a byte of the state directory changes', async () => {
  const root = await scene();
  const before = stateBytes(root.dir);
  await collectGui([root], { queries: ['migration'] });
  const after = stateBytes(root.dir);
  // The search index may be built by the query: it is a cache, not state. Everything else is identical.
  const strip = (/** @type {Record<string, string>} */ m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.includes(`${path.sep}index${path.sep}`)));
  assert.deepEqual(strip(after), strip(before));
});

test('a pending write names the sections it adds as writing', async () => {
  const root = await scene();
  const abs = path.join(root.dir, N);
  const res = await prepareWrite(root, N, `${fs.readFileSync(abs, 'utf8')}\n## Brand new\n\nx\n`, { author: B, tool: 'Edit', key: 'tool-use-1' });
  assert.equal(res.ok, true);
  const note = (await collectGui([root])).roots[0].notes.find((n) => n.rel === N);
  assert.deepEqual(note?.writing.find((w) => w.session === B.session)?.keys, ['## Brand new']);
});

test('a root with no notes is empty; a broken ledger is an error that names the command', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-empty-'));
  await initRoot(emptyDir, {});
  const empty = (await collectGui([openRoot(emptyDir)])).roots[0];
  assert.equal(empty.state, 'empty');
  assert.equal(empty.notes.length, 0);

  const root = await scene();
  const ledger = path.join(root.stateDir, 'ledger.jsonl');
  const lines = fs.readFileSync(ledger, 'utf8').split('\n');
  lines.splice(1, 1);
  fs.writeFileSync(ledger, lines.join('\n'));
  const broken = (await collectGui([root])).roots[0];
  assert.equal(broken.state, 'error');
  assert.match(String(broken.error?.message), /ledger chain is broken/);
  assert.equal(broken.error?.command, 'mneme doctor');
  assert.ok(broken.notes.length > 0, 'what is still known is still shown');
});

test('--note chooses the first note shown, and an unknown one is an error', async () => {
  const root = await scene();
  assert.equal((await collectGui([root], { note: 'manuals/deploy.md' })).roots[0].initial, 'manuals/deploy.md');
  await assert.rejects(collectGui([root], { note: 'nope.md' }), /nope\.md/);
});
