// The session reader: what a session was working on answers a search that found nothing.
// Its order, its candidates, what it skips, what it costs, and the CLI and MCP doors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { adoptedRoot, isolateHome, runCli } from '../aceptacion/l3-helpers.mjs';
import { createServer } from '../../src/adapters/mcp/server.js';
import { runEval } from '../../src/eval.js';
import { STATE_DIR } from '../../src/name.js';
import { openRoot } from '../../src/root.js';
import { SESSION_NOTES, sessionHits, sessionTouches, sessionsWithReads } from '../../src/readers/session.js';
import { search, sessionLine } from '../../src/search.js';
import { writeNote } from '../../src/store.js';

isolateHome();
delete process.env.CLAUDE_CODE_SESSION_ID;
const CONT = 'dale, seguí';
const MIN = 60e3;
/** @typedef {import('../../src/types.js').Root} Root */
/** @typedef {import('../../src/types.js').SearchHit} SearchHit */

/**
 * Appends raw lines to a session's reads file, as the Read hook would (plus whatever is given).
 * @param {Root} root @param {string} session @param {Array<[string, number] | string>} lines  [rel, ms ago] or a raw line
 */
function reads(root, session, lines) {
  const dir = path.join(root.dir, STATE_DIR, 'run', 'reads');
  fs.mkdirSync(dir, { recursive: true });
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify({ rel: l[0], sha: 'x', ts: new Date(Date.now() - l[1]).toISOString() })));
  fs.appendFileSync(path.join(dir, `${session}.jsonl`), text.join('\n') + '\n');
}

/**
 * A write by `session` that replaces `from` with `to` in `rel`.
 * @param {Root} root @param {string} session @param {string} rel @param {string} from @param {string} to
 */
async function edit(root, session, rel, from, to) {
  const before = fs.readFileSync(path.join(root.dir, rel), 'utf8');
  assert.ok(before.includes(from), `${rel} has "${from}"`);
  const res = await writeNote(root, rel, before.replace(from, to), { author: { session, agent: 'claude-code' }, reason: 'test' });
  assert.equal(res.ok, true);
}

/** @param {SearchHit[]} hits */
const notes = (hits) => [...new Set(hits.map((h) => h.rel))];
/** @param {SearchHit[]} hits */
const keys = (hits) => hits.map((h) => `${h.rel} ${h.section.key}`);

test('a search that finds something is not touched by the session: same result, no "via", nothing mixed in', async () => {
  const root = await adoptedRoot();
  reads(root, 'ses-a', [['manuals/backups.md', MIN]]);
  const without = await search([root], 'migration', { reader: 'lexical' });
  const withSession = await search([root], 'migration', { reader: 'lexical', session: 'ses-a' });
  assert.ok(without.hits.length > 0);
  assert.deepEqual(withSession, without);
  assert.ok(withSession.hits.every((h) => !('via' in h)));
  assert.equal(sessionLine(withSession), null);
});

/** A root whose floor no section reaches, so the plain search comes back empty and the session answers. */
async function strictRoot() {
  const adopted = await adoptedRoot();
  const file = path.join(adopted.stateDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...config, search: { ...config.search, minLexical: 999, minLexicalRatio: 1 } }));
  return openRoot(adopted.dir);
}

test('the fallback: the notes by the last touch, one per slot; the query only picks the section inside a note', async () => {
  // Measured on 11 real continuations: ordering by the query's words first lost to plain recency (3 against 4 of 11),
  // because the words of a continuation hook unrelated sections. Here the query names the OLDEST note.
  const strict = await strictRoot();
  reads(strict, 'ses-a', [['manuals/backups.md', 20 * MIN], ['projects/beta.md', 10 * MIN], ['manuals/deploy.md', 5 * MIN]]);
  assert.equal((await search([strict], 'restore', { reader: 'lexical' })).hits.length, 0, 'control: the floor empties it');
  const res = await search([strict], 'restore', { reader: 'lexical', session: 'ses-a', k: 3 });
  assert.equal(sessionLine(res), '(from what this session was working on)');
  assert.deepEqual(keys(res.hits), ['manuals/deploy.md # Deploy manual', 'projects/beta.md # Beta', 'manuals/backups.md ## Restore']);
  assert.ok(res.hits[2].score > 0 && res.hits[0].score === 0);
  const all = await search([strict], 'restore', { reader: 'lexical', session: 'ses-a', k: 20 });
  assert.deepEqual(notes(all.hits.slice(0, 3)), notes(all.hits.slice(3, 6)), 'one note per slot, round after round');
});

test('the session reader asked for by name: the notes the query names come first', async () => {
  const root = await adoptedRoot();
  reads(root, 'ses-a', [['manuals/backups.md', 20 * MIN], ['projects/beta.md', 10 * MIN], ['manuals/deploy.md', 5 * MIN]]);
  const { hits } = await search([root], 'restore', { reader: 'session', session: 'ses-a', k: 3 });
  assert.deepEqual(keys(hits), ['manuals/backups.md ## Restore', 'manuals/deploy.md # Deploy manual', 'projects/beta.md # Beta']);
});

test('inside a note: the most recently written section first; a note only read, in document order', async () => {
  const root = await adoptedRoot();
  await edit(root, 'ses-w', 'projects/alpha.md', 'Rebuild the vector index', 'Rebuild the vector index twice');
  await edit(root, 'ses-w', 'projects/alpha.md', 'can double the storage', 'can triple the storage');
  const later = new Date(Date.now() + 10 * MIN);
  reads(root, 'ses-w', [['manuals/backups.md', -5 * MIN]]); // read after both writes
  const hits = await sessionHits([root], CONT, { session: 'ses-w', k: 20, now: later });
  // One note per slot: the first of each note, then the second of each, in the notes' order.
  assert.deepEqual(keys(hits), ['manuals/backups.md # Backups', 'projects/alpha.md ## Risks', 'manuals/backups.md ## Schedule', 'projects/alpha.md ## Plan', 'manuals/backups.md ## Restore']);
  assert.deepEqual(keys(hits.filter((h) => h.rel === 'projects/alpha.md')), ['projects/alpha.md ## Risks', 'projects/alpha.md ## Plan'], 'inside a note, the latest write first');
  assert.ok(hits.every((h) => h.via === 'session'));
});

test('a written section whose heading is gone leaves the note with every section, as if only read', async () => {
  const root = await adoptedRoot();
  await edit(root, 'ses-r', 'projects/alpha.md', 'Rebuild the vector index', 'Rebuild the vector index twice');
  // Renamed by hand in an editor (the guard would deny another session this removal).
  const file = path.join(root.dir, 'projects/alpha.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Plan', '## Roadmap'));
  const hits = await sessionHits([root], CONT, { session: 'ses-r', k: 20 });
  assert.deepEqual(keys(hits), ['projects/alpha.md # Alpha', 'projects/alpha.md ## Roadmap', 'projects/alpha.md ## Risks', 'projects/alpha.md ## Decisions']);
});

test(`at most ${SESSION_NOTES} notes, the most recent; an older write of a chosen note still decides its sections`, async () => {
  const root = await adoptedRoot();
  await edit(root, 'ses-n', 'projects/alpha.md', 'Rebuild the vector index', 'Rebuild the vector index twice');
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root.dir, `inbox/n${String(i).padStart(2, '0')}.md`), `# N${i}\n\nNote number ${i}.\n`);
  const later = 60 * MIN;
  // 30 notes read after the write, the oldest first; then alpha read again, last of all.
  reads(root, 'ses-n', [...Array.from({ length: 30 }, (_, i) => /** @type {[string, number]} */ ([`inbox/n${String(i).padStart(2, '0')}.md`, -(i + 1) * 1000])), ['projects/alpha.md', -later]]);
  const hits = await sessionHits([root], CONT, { session: 'ses-n', k: 100, now: new Date(Date.now() + 2 * later) });
  const got = notes(hits);
  assert.equal(got.length, SESSION_NOTES);
  assert.equal(got[0], 'projects/alpha.md');
  assert.deepEqual(keys(hits.filter((h) => h.rel === 'projects/alpha.md')), ['projects/alpha.md ## Plan'], 'its written section, not all of them');
  assert.equal(got[1], 'inbox/n29.md');
  assert.equal(got.at(-1), `inbox/n${String(30 - (SESSION_NOTES - 1)).padStart(2, '0')}.md`, 'the oldest reads fall out');
});

test('what cannot be read is skipped without an error: torn lines, bad times, paths outside the root or into its state', async () => {
  const root = await adoptedRoot();
  fs.writeFileSync(path.join(root.dir, 'notes.txt'), 'not a note');
  reads(root, 'ses-x', [
    '{"rel":"projects/beta.md","sha":"x","ts":"', // torn
    'garbage',
    JSON.stringify({ rel: 'manuals/deploy.md', sha: 'x', ts: 'yesterday-ish' }),
    JSON.stringify({ sha: 'x', ts: new Date().toISOString() }),
    JSON.stringify({ rel: '../outside.md', sha: 'x', ts: new Date(Date.now() - MIN).toISOString() }),
    JSON.stringify({ rel: `${STATE_DIR}/config.json`, sha: 'x', ts: new Date(Date.now() - MIN).toISOString() }),
    JSON.stringify({ rel: 'notes.txt', sha: 'x', ts: new Date(Date.now() - MIN).toISOString() }),
    JSON.stringify({ rel: 'manuals/backups.md', sha: 'x', ts: new Date(Date.now() - 2 * MIN).toISOString() }),
  ]);
  assert.deepEqual(sessionTouches(root, 'ses-x').map((t) => t.rel), ['manuals/backups.md']);
  assert.deepEqual(notes(await sessionHits([root], CONT, { session: 'ses-x' })), ['manuals/backups.md']);
});

test('two roots: one list by recency, each hit with its own root; scope limits the session too', async () => {
  const a = await adoptedRoot();
  const b = await adoptedRoot();
  reads(a, 'ses-2', [['manuals/backups.md', 10 * MIN]]);
  reads(b, 'ses-2', [['projects/beta.md', 5 * MIN], ['manuals/deploy.md', 20 * MIN]]);
  const hits = await sessionHits([a, b], CONT, { session: 'ses-2', k: 20 });
  // The first round (one note per slot) is the order of the notes across both roots.
  assert.deepEqual(hits.slice(0, 3).map((h) => [h.root === a.dir ? 'a' : 'b', h.rel]), [
    ['b', 'projects/beta.md'],
    ['a', 'manuals/backups.md'],
    ['b', 'manuals/deploy.md'],
  ]);
  const scoped = await search([a, b], CONT, { reader: 'lexical', session: 'ses-2', scope: ['manuals'], k: 20 });
  assert.deepEqual(notes(scoped.hits), ['manuals/backups.md', 'manuals/deploy.md']);
});

test('session hits carry their STALE mark, and a superseded one brings the current section', async () => {
  const root = await adoptedRoot();
  reads(root, 'ses-s', [['notes/old-plan.md', MIN], ['notes/expired.md', 2 * MIN]]);
  const hits = await sessionHits([root], CONT, { session: 'ses-s', k: 20 });
  const old = hits.find((h) => h.rel === 'notes/old-plan.md');
  const expired = hits.find((h) => h.rel === 'notes/expired.md');
  assert.match(old?.stale?.reason ?? '', /^superseded by /);
  assert.equal(old?.follow?.rel, 'projects/alpha.md');
  assert.equal(old?.follow?.section?.key, '## Plan');
  assert.match(expired?.stale?.reason ?? '', /^expired /);
});

test('an empty query with a session is what the session was working on; without one, still nothing', async () => {
  const root = await adoptedRoot();
  reads(root, 'ses-e', [['manuals/backups.md', MIN]]);
  assert.deepEqual((await search([root], '  ', { reader: 'lexical' })).hits, []);
  assert.deepEqual(notes((await search([root], '  ', { reader: 'lexical', session: 'ses-e' })).hits), ['manuals/backups.md']);
});

test('the ledger is read once per root and per search, however many notes the session touched', async () => {
  const a = await adoptedRoot();
  const b = await adoptedRoot();
  for (const root of [a, b]) {
    await edit(root, 'ses-l', 'projects/alpha.md', 'Rebuild the vector index', 'Rebuild the vector index twice');
    await edit(root, 'ses-l', 'manuals/deploy.md', 'How to ship', 'How we ship');
    reads(root, 'ses-l', [['projects/beta.md', MIN], ['manuals/backups.md', 2 * MIN], ['notes/links.md', 3 * MIN]]);
  }
  await search([a, b], 'warm', { reader: 'lexical' });
  const ledgers = new Set([a, b].map((r) => path.join(r.stateDir, 'ledger.jsonl').replace(/\\/g, '/')));
  const files = mock.method(fs, 'readFileSync');
  try {
    const hits = await sessionHits([a, b], CONT, { session: 'ses-l', k: 50 });
    assert.equal(notes(hits).length, 5, 'control: every touched note came back');
    const ledgerReads = files.mock.calls.filter((c) => ledgers.has(String(c.arguments[0]).replace(/\\/g, '/'))).length;
    assert.ok(files.mock.callCount() > 0, 'control: the counter sees the reads');
    assert.equal(ledgerReads, 2);
  } finally {
    files.mock.restore();
  }
});

test('wrong input says what is wrong', async () => {
  const root = await adoptedRoot();
  await assert.rejects(search([root], CONT, { reader: 'session' }), /needs a session/);
  await assert.rejects(search([root], CONT, { session: '' }), TypeError);
  await assert.rejects(search([root], CONT, { reader: /** @type {any} */ ('graph') }), /"hybrid", "lexical" or "session"/);
  assert.throws(() => sessionTouches(root, ''), TypeError);
  assert.throws(() => sessionTouches(root, 'ses', { before: new Date('nope') }), TypeError);
  await assert.rejects(runEval([root], [{ query: 'q', want: ['x'], ts: 'sometime' }]), /"ts" must be an ISO date/);
  await assert.rejects(runEval([root], [{ query: 'q', want: ['x'], session: ' ' }]), /"session" must be a non-empty/);
  assert.deepEqual(sessionTouches(root, 'nobody'), []);
});

test('sessionsWithReads: the ids of the reads files; a hashed name is not an id', async () => {
  const root = await adoptedRoot();
  assert.deepEqual(sessionsWithReads(root), []);
  reads(root, 'ses-one', [['manuals/backups.md', MIN]]);
  reads(root, 'a'.repeat(64), [['manuals/backups.md', MIN]]);
  assert.deepEqual(sessionsWithReads(root), ['ses-one']);
});

test('CLI: a prefix names the only session that has it; two with it, or none, are said', async () => {
  const root = await adoptedRoot();
  reads(root, '0123456789abcdef-one', [['manuals/backups.md', MIN]]);
  reads(root, '0123456789abcdef-two', [['projects/beta.md', MIN]]);
  const one = await runCli(['search', CONT, '--session', '0123456789abcdef-o', '--reader', 'lexical', '--root', root.dir]);
  assert.equal(one.code, 0, one.stderr);
  assert.equal(one.stdout.split('\n')[0], '(from what this session was working on)');
  assert.match(one.stdout, /manuals\/backups\.md/);
  assert.doesNotMatch(one.stdout, /projects\/beta\.md/);
  const two = await runCli(['search', CONT, '--session', '01234567', '--root', root.dir]);
  assert.equal(two.code, 2);
  assert.match(two.stderr, /2 sessions start with "01234567"/);
  const none = await runCli(['search', CONT, '--session', 'zz-nobody', '--reader', 'lexical', '--root', root.dir]);
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stderr, /no session "zz-nobody" read or wrote notes/);
  assert.match(none.stdout, /^No results\./);
  const bare = await runCli(['search', 'backups', '--reader', 'session', '--root', root.dir]);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /--reader session needs --session/);
  const forced = await runCli(['search', 'backups', '--reader', 'session', '--session', '0123456789abcdef-two', '--root', root.dir]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /^\(from what this session was working on\)\nprojects\/beta\.md/, 'only its notes, even when the query names another');
});

test('MCP: search falls back to the server session by default, or to the one given', async () => {
  const root = await adoptedRoot();
  reads(root, 'ses-other', [['projects/beta.md', MIN]]);
  const { server } = createServer({ roots: [root], readOnly: true, sessionId: 'ses-mcp' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 's-session', version: '0.0.0' });
  await client.connect(clientSide);
  /** @param {Record<string, unknown>} args */
  const call = async (args) => {
    const res = /** @type {any} */ (await client.callTool({ name: 'search', arguments: args }));
    assert.notEqual(res.isError, true, JSON.stringify(res));
    return res.content.map((/** @type {any} */ c) => c.text).join('\n');
  };
  try {
    assert.match(await call({ query: CONT, reader: 'lexical' }), /^No results\./, 'the server session has touched nothing yet');
    await client.callTool({ name: 'read_note', arguments: { path: 'manuals/backups.md' } });
    const own = await call({ query: CONT, reader: 'lexical' });
    assert.match(own, /^\(from what this session was working on\)\nmanuals\/backups\.md/);
    const other = await call({ query: CONT, reader: 'lexical', session: 'ses-other' });
    assert.match(other, /^\(from what this session was working on\)\nprojects\/beta\.md/);
    assert.doesNotMatch(other, /backups/);
  } finally {
    await client.close();
  }
});
