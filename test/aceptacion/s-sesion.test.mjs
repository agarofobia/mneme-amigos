// Acceptance, lote S (contracts §4.27, the session reader). Written by the main thread BEFORE the lote; the
// worker does not edit it (objections go in `objeciones_a_tests`).
//   node --test test/aceptacion/s-sesion.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { adoptedRoot, isolateHome, runCli } from './l3-helpers.mjs';
import { runEval } from '../../src/eval.js';
import { STATE_DIR } from '../../src/name.js';
import { sessionHits, sessionTouches } from '../../src/readers/session.js';
import { search } from '../../src/search.js';
import { writeNote } from '../../src/store.js';

isolateHome();
const CONT = 'dale, seguí'; // a continuation: none of its words is in the invented (English) corpus
const MIN = 60e3;
/** @typedef {Awaited<ReturnType<typeof adoptedRoot>>} Root */
/** Reads recorded by the Read hook, written with explicit times (the hook stamps "now"). @param {Root} root @param {string} session @param {Array<[string, number]>} lines */
function reads(root, session, lines) {
  const dir = path.join(root.dir, STATE_DIR, 'run', 'reads');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${session}.jsonl`), lines.map(([rel, msAgo]) => JSON.stringify({ rel, sha: 'x', ts: new Date(Date.now() - msAgo).toISOString() })).join('\n') + '\n');
}
/** Session ses-a: read beta 30 min ago, read backups 10 min ago, wrote alpha's Plan now. @param {Root} root */
async function sesionA(root) {
  reads(root, 'ses-a', [['projects/beta.md', 30 * MIN], ['manuals/backups.md', 10 * MIN]]);
  const alpha = fs.readFileSync(path.join(root.dir, 'projects/alpha.md'), 'utf8').replace('Rebuild the vector index before the migration.', 'Rebuild the vector index twice before the migration.');
  const res = await writeNote(root, 'projects/alpha.md', alpha, { author: { session: 'ses-a', agent: 'claude-code' }, reason: 'test' });
  assert.equal(res.ok, true);
}

test('a continuation with the session comes back with what that session was working on, most recent first', async () => {
  const root = await adoptedRoot();
  await sesionA(root);
  const { hits } = await search([root], CONT, { reader: 'lexical', session: 'ses-a' });
  assert.ok(hits.length >= 3, `got ${hits.length}`);
  assert.ok(hits.every((h) => /** @type {any} */ (h).via === 'session'), 'every hit says where it came from');
  const notas = [...new Set(hits.map((h) => h.rel))];
  assert.deepEqual(notas.slice(0, 3), ['projects/alpha.md', 'manuals/backups.md', 'projects/beta.md']);
  assert.equal(hits[0].section.key, '## Plan', 'in a written note, the written section first');
});

test('without a session nothing changes: the continuation still comes back empty', async () => {
  const root = await adoptedRoot();
  await sesionA(root);
  const { hits } = await search([root], CONT, { reader: 'lexical' });
  assert.equal(hits.length, 0);
});

test('another session never leaks in', async () => {
  const root = await adoptedRoot();
  await sesionA(root);
  reads(root, 'ses-b', [['notes/links.md', 1 * MIN]]);
  const { hits } = await search([root], CONT, { reader: 'lexical', session: 'ses-a' });
  assert.ok(!hits.some((h) => h.rel === 'notes/links.md'));
  const b = await search([root], CONT, { reader: 'lexical', session: 'ses-b' });
  assert.deepEqual([...new Set(b.hits.map((h) => h.rel))], ['notes/links.md']);
});

test('only what the session had touched before "now" counts (the eval asks as of the moment of the prompt)', async () => {
  const root = await adoptedRoot();
  await sesionA(root);
  const hits = await sessionHits([root], CONT, { session: 'ses-a', now: new Date(Date.now() - 20 * MIN) });
  assert.deepEqual([...new Set(hits.map((/** @type {{ rel: string }} */ h) => h.rel))], ['projects/beta.md']);
});

test('a query word that matches one of the session notes puts it first, even if it is not the most recent', async () => {
  const root = await adoptedRoot();
  await sesionA(root);
  const { hits } = await search([root], 'backups', { reader: 'session', session: 'ses-a' });
  assert.equal(hits[0]?.rel, 'manuals/backups.md');
  assert.ok(hits.every((h) => /** @type {any} */ (h).via === 'session'));
});

test('sessionTouches: reads and writes, newest first, with the written sections; a note that is gone is skipped', async () => {
  const root = await adoptedRoot();
  await sesionA(root);
  reads(root, 'ses-a', [['inbox/idea.md', 5 * MIN]]);
  fs.rmSync(path.join(root.dir, 'inbox/idea.md'));
  const t = sessionTouches(root, 'ses-a');
  assert.equal(t[0].rel, 'projects/alpha.md');
  assert.equal(t[0].kind, 'write');
  assert.ok(t[0].keys.includes('## Plan'));
  assert.ok(t.some((/** @type {{ rel: string, kind: string, keys: string[] }} */ x) => x.rel === 'manuals/backups.md' && x.kind === 'read' && x.keys.length === 0));
  const hits = await sessionHits([root], CONT, { session: 'ses-a' });
  assert.ok(!hits.some((/** @type {{ rel: string }} */ h) => h.rel === 'inbox/idea.md'), 'the deleted note does not come back');
  assert.deepEqual(sessionTouches(root, 'nobody'), []);
});

test('the eval counts a session case as of its time; the same case without the session misses (control)', async () => {
  const root = await adoptedRoot();
  await sesionA(root);
  const ts = new Date(Date.now() - 5 * MIN).toISOString();
  const con = await runEval([root], [{ query: CONT, want: ['backups'], session: 'ses-a', ts }], { reader: 'lexical' });
  assert.equal(con.note.hit, 1);
  const sin = await runEval([root], [{ query: CONT, want: ['backups'] }], { reader: 'lexical' });
  assert.equal(sin.note.hit, 0);
});

test('the CLI: search --session says the answer came from the session', async () => {
  const root = await adoptedRoot();
  await sesionA(root);
  const r = await runCli(['search', CONT, '--session', 'ses-a', '--reader', 'lexical', '--root', root.dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\(from what this session was working on\)/);
  assert.match(r.stdout, /projects\/alpha\.md/);
  const sin = await runCli(['search', CONT, '--reader', 'lexical', '--root', root.dir]);
  assert.doesNotMatch(sin.stdout, /from what this session was working on/);
});
