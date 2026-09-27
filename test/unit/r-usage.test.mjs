// The usage log and report (lote R): the MCP door, broken lines, rotation, a failure while
// recording, the off switch, what the report counts and over which window, the error without
// roots, and its time budget. Every test points the registry home at a temporary directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HOME_VAR, adoptedRoot, isolateHome, runCli } from '../aceptacion/l3-helpers.mjs';
import { createServer } from '../../src/adapters/mcp/server.js';
import { appendEntries, newId } from '../../src/ledger.js';
import { NAME } from '../../src/name.js';
import { openRoot } from '../../src/root.js';
import { search } from '../../src/search.js';
import { recordDenial, recordRead, sendMessage, touchSession } from '../../src/sessions.js';
import { initRoot, writeNote } from '../../src/store.js';
import {
  MAX_LOG_BYTES,
  USAGE_ENV,
  buildReport,
  isSearchRecord,
  olderSearchesFile,
  readSearches,
  recordSearch,
  searchRecord,
  searchesFile,
  usageLogOn,
} from '../../src/usage.js';

isolateHome();
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env[USAGE_ENV];
const DAY = 86_400_000;

/** @typedef {import('../../src/types.js').Root} Root */
/** @typedef {import('../../src/types.js').LedgerEntry} LedgerEntry */

/** A registry home of its own. */
const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-ru-'));
/** Points this process at a registry home of its own and returns it. */
function useFreshHome() {
  const home = freshHome();
  process.env[HOME_VAR] = home;
  return home;
}
/** @param {number} t */
const iso = (t) => new Date(t).toISOString();
/** A valid log line, `ms ago`. @param {number} ago */
const good = (ago = 60e3) => ({ ts: iso(Date.now() - ago), via: 'cli', reader: 'lexical', k: 5, hits: 2, session: false, degraded: false, ms: 7, roots: 1 });
/** @param {string} file */
const logLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
/** @param {Root} root @param {string} rel */
const noteText = (root, rel) => fs.readFileSync(path.join(root.dir, rel), 'utf8');

test('the MCP door leaves one line per search, via "mcp", with nothing of the query, the session or the notes', async () => {
  useFreshHome();
  const root = await adoptedRoot();
  const { server } = createServer({ roots: [root], readOnly: true, sessionId: 'ses-QZXMCP' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'r-usage', version: '0.0.0' });
  await client.connect(clientSide);
  /** @param {Record<string, unknown>} args */
  const call = async (args) => {
    const res = await client.callTool({ name: 'search', arguments: args });
    assert.notEqual(/** @type {{ isError?: unknown }} */ (res).isError, true, JSON.stringify(res));
  };
  try {
    await call({ query: 'rollback QZXQUERY' });
    await client.callTool({ name: 'read_note', arguments: { path: 'manuals/backups.md' } });
    await call({ query: 'sí, continúa', reader: 'lexical', k: 3 });
  } finally {
    await client.close();
  }
  const text = fs.readFileSync(searchesFile(), 'utf8');
  const lines = logLines(searchesFile()).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(lines.every(isSearchRecord), text);
  assert.deepEqual(lines.map((l) => l.via), ['mcp', 'mcp']);
  assert.ok(lines[0].hits > 0);
  assert.equal(lines[0].session, false);
  assert.equal(lines[0].k, root.config.search.k, 'k not given: the root default');
  assert.equal(lines[1].session, true, "nothing matched: the server's session answered");
  assert.equal(lines[1].k, 3);
  for (const p of ['QZXQUERY', 'QZXMCP', 'continúa', 'backups', root.dir, path.basename(root.dir)]) assert.ok(!text.includes(p), `leaked: ${p}`);
});

test('the reader in a line is the one asked for, or the default; "session" when it was forced', async () => {
  useFreshHome();
  const root = await adoptedRoot();
  const res = await search([root], 'rollback');
  const line = searchRecord('cli', [root, root], {}, res, 3.6, new Date(0));
  assert.deepEqual(line, { ts: '1970-01-01T00:00:00.000Z', via: 'cli', reader: 'lexical', k: 5, hits: res.hits.length, session: false, degraded: false, ms: 4, roots: 1 });
  recordRead(root, 'ses-forced', 'projects/beta.md', 'x');
  const forced = await search([root], 'beta', { reader: 'session', session: 'ses-forced' });
  const f = searchRecord('mcp', [root], { reader: 'session', session: 'ses-forced' }, forced, 1);
  assert.equal(f.reader, 'session');
  assert.equal(f.session, true);
});

test('a broken line (cut short, a field more or less, a value outside its set) is skipped without an error', async () => {
  useFreshHome();
  const root = await adoptedRoot();
  const { ms, ...lessOne } = good();
  assert.equal(typeof ms, 'number');
  const lines = [
    JSON.stringify(good()),
    JSON.stringify(good()).slice(0, 40), // cut short
    JSON.stringify({ ...good(), query: 'QZXLEAK' }), // a field more
    JSON.stringify(lessOne), // a field less
    JSON.stringify({ ...good(), via: 'QZXVIA' }), // outside its set
    JSON.stringify({ ...good(), reader: 'semantic' }),
    JSON.stringify({ ...good(), hits: -1 }),
    JSON.stringify({ ...good(), ts: 'yesterday' }),
    '[1, 2, 3]',
    'null',
    JSON.stringify({ ...good(), hits: 7 }),
  ];
  fs.mkdirSync(path.dirname(searchesFile()), { recursive: true });
  fs.writeFileSync(searchesFile(), `${lines.join('\n')}\n`);
  const read = readSearches();
  assert.equal(read.searches.length, 2);
  assert.equal(read.skipped, 9);
  const rep = buildReport([root]);
  assert.equal(rep.searches.total, 2);
  assert.equal(rep.searches.hits['6+'], 1);
  assert.equal(rep.searches.hits['1-2'], 1);
  assert.ok(!JSON.stringify(rep).includes('QZX'));

  // A torn last line without its newline: the next search starts a line of its own.
  fs.appendFileSync(searchesFile(), JSON.stringify(good()).slice(0, 30));
  assert.equal(recordSearch('cli', [root], {}, await search([root], 'rollback'), 3), true);
  assert.equal(readSearches().searches.length, 3);
});

test('the log rotates at 1 MB to searches.1.jsonl, keeps only that one, and the report reads both', async () => {
  useFreshHome();
  const root = await adoptedRoot();
  const line = `${JSON.stringify(good())}\n`;
  const n = Math.ceil(MAX_LOG_BYTES / Buffer.byteLength(line));
  fs.mkdirSync(path.dirname(searchesFile()), { recursive: true });
  fs.writeFileSync(searchesFile(), line.repeat(n - 1));
  fs.writeFileSync(olderSearchesFile(), 'the oldest one, which the rotation drops\n');
  const res = await search([root], 'rollback');

  recordSearch('cli', [root], {}, res, 5); // below 1 MB: nothing moves
  assert.equal(logLines(searchesFile()).length, n);
  assert.match(fs.readFileSync(olderSearchesFile(), 'utf8'), /^the oldest/);
  const full = fs.readFileSync(searchesFile(), 'utf8');
  assert.ok(Buffer.byteLength(full) >= MAX_LOG_BYTES);

  recordSearch('cli', [root], {}, res, 5); // at 1 MB: rotated first
  assert.equal(fs.readFileSync(olderSearchesFile(), 'utf8'), full);
  assert.equal(logLines(searchesFile()).length, 1);
  assert.equal(buildReport([root]).searches.total, n + 1);
});

test('when the log cannot be written the search answers the same, and the error goes to the home errors.jsonl', async () => {
  const root = await adoptedRoot();
  const ok = freshHome();
  const broken = freshHome();
  fs.writeFileSync(path.join(broken, 'usage'), 'a file where the usage folder should be');
  const args = ['search', 'rollback', '--root', root.dir];
  const a = await runCli(args, { env: { [HOME_VAR]: ok } });
  const b = await runCli(args, { env: { [HOME_VAR]: broken } });
  assert.equal(b.code, 0, b.stderr);
  assert.equal(b.stdout, a.stdout);
  assert.equal(b.stderr, a.stderr);
  const errors = logLines(path.join(broken, 'errors.jsonl')).map((l) => JSON.parse(l));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].where, 'usage cli');
  process.env[HOME_VAR] = broken;
  const rep = buildReport([root]);
  assert.equal(rep.errors, 1, 'the report counts it');
  assert.equal(rep.searches.total, 0);
});

test('the off switch: 0, false, off or no turn the log off; anything else leaves it on', async () => {
  assert.equal(USAGE_ENV, `${NAME.toUpperCase()}_USAGE_LOG`);
  for (const v of ['0', 'false', 'OFF', ' no ']) assert.equal(usageLogOn({ [USAGE_ENV]: v }), false, v);
  for (const v of ['1', 'yes', '']) assert.equal(usageLogOn({ [USAGE_ENV]: v }), true, v);
  assert.equal(usageLogOn({}), true);
  useFreshHome();
  const root = await adoptedRoot();
  process.env[USAGE_ENV] = '0';
  try {
    assert.equal(recordSearch('mcp', [root], {}, await search([root], 'rollback'), 1), false);
  } finally {
    delete process.env[USAGE_ENV];
  }
  assert.equal(fs.existsSync(searchesFile()), false);
});

test('the report counts writes, sessions, reads, denials and messages inside the window; adoptions are not writes', async () => {
  useFreshHome();
  const root = await adoptedRoot();
  const w = (/** @type {string} */ session, /** @type {'claude-code'|'mcp'} */ agent, /** @type {string} */ rel) =>
    writeNote(root, rel, `${noteText(root, rel)}\nQZXTEXT ${session}\n`, { author: { session, agent }, reason: 'test' });
  assert.equal((await w('ses-a', 'claude-code', 'projects/alpha.md')).ok, true);
  assert.equal((await w('ses-b', 'mcp', 'projects/beta.md')).ok, true);
  recordRead(root, 'ses-c', 'manuals/backups.md', 'x');
  recordRead(root, 'ses-c', 'manuals/deploy.md', 'x');
  recordRead(root, 'ses-a', 'projects/alpha.md', 'x');
  recordDenial(root, 'ses-d', 'projects/alpha.md');
  await sendMessage(root, { from: { session: 'ses-e', agent: 'cli' }, to: 'next', body: 'QZXBODY' });
  touchSession(root, { session: 'ses-f', agent: 'claude-code' });
  // A write 40 days ago, by a session that did nothing else.
  /** @type {Omit<LedgerEntry, 'prev'>} */
  const old = { v: 1, id: newId(), ts: iso(Date.now() - 40 * DAY), rel: 'inbox/idea.md', op: 'edit', author: { session: 'ses-old', agent: 'cli' }, before: null, after: null, delta: {}, changed: [] };
  appendEntries(root, [old]);

  const rep = buildReport([root], { hookInstalls: 2 });
  assert.equal(rep.writes.total, 2);
  assert.deepEqual(rep.writes.byAgent, { 'claude-code': 1, mcp: 1, cli: 0, external: 0, other: 0 });
  assert.equal(Object.values(rep.writes.byOp).reduce((s, n) => s + n, 0), 2);
  assert.deepEqual(rep.sessions, { total: 6, withReads: 2, reads: 3 }, 'ses-a..f; the adopter and ses-old are not in it');
  assert.equal(rep.denials.total, 1);
  assert.equal(rep.messages.sent, 1);
  assert.equal(rep.setup.hookInstalls, 2);
  assert.equal(rep.setup.embeddings, 'none');
  assert.equal(rep.window.activeDays, 1);
  assert.equal(rep.searches.ms.p50, null, 'no searches: no percentile');

  const d60 = buildReport([root], { days: 60 });
  assert.equal(d60.writes.total, 3);
  assert.equal(d60.writes.byAgent.cli, 1);
  assert.equal(d60.sessions.total, 7);
  assert.equal(d60.window.activeDays, 2);
  assert.ok(!JSON.stringify(d60).includes('QZX'));
  assert.ok(!JSON.stringify(d60).includes('ses-'));
});

test('report takes the registered roots, or each --root once; with neither it fails saying what to do', async () => {
  const home = freshHome();
  const none = await runCli(['report'], { env: { [HOME_VAR]: home } });
  assert.equal(none.code, 1);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /--root <dir>/);
  assert.match(none.stderr, new RegExp(`${NAME} init <dir> --adopt`));

  const a = await adoptedRoot();
  const b = await adoptedRoot();
  assert.equal((await runCli(['init', a.dir], { env: { [HOME_VAR]: home } })).code, 1, 'already a root: init only registers it');
  const registered = JSON.parse((await runCli(['report'], { env: { [HOME_VAR]: home } })).stdout);
  assert.equal(registered.setup.roots, 1);
  const given = JSON.parse((await runCli(['report', '--root', a.dir, '--root', b.dir, '--root', a.dir], { env: { [HOME_VAR]: home } })).stdout);
  assert.equal(given.setup.roots, 2);
  assert.equal(given.notes.notes, registered.notes.notes * 2);
  const bad = await runCli(['report', '--days', '0', '--root', a.dir], { env: { [HOME_VAR]: home } });
  assert.equal(bad.code, 2);
});

test('report over 400 notes and 5,000 ledger entries reads the index instead of every note, in under 1 s', async (t) => {
  const home = useFreshHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-ru-perf-'));
  const body = 'alpha beta gamma delta epsilon '.repeat(20);
  for (let i = 0; i < 400; i++) {
    const sub = path.join(dir, `area-${i % 20}`);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `note-${i}.md`), `# Note ${i}\n\n## One\n\n${body}\n\n## Two\n\n${body}\n`);
  }
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  const root = openRoot(dir);
  await search([root], 'alpha'); // builds the index, as any search does
  const now = Date.now();
  // 4,600 more entries (400 adoptions + 4,600 = 5,000), appended at once: nothing else runs on this root.
  appendEntries(
    root,
    Array.from({ length: 4600 }, (_, i) => ({
      v: /** @type {const} */ (1),
      id: newId(),
      ts: iso(now - (4600 - i) * 30e3),
      rel: `area-${i % 20}/note-${i % 400}.md`,
      op: /** @type {const} */ ('edit'),
      author: { session: `ses-${i % 50}`, agent: /** @type {const} */ ('claude-code') },
      before: null,
      after: null,
      delta: {},
      changed: ['## Two'],
    })),
  );
  for (let s = 0; s < 50; s++) for (let r = 0; r < 20; r++) recordRead(root, `ses-${s}`, `area-${r}/note-${r}.md`, 'x');

  const spy = t.mock.method(fs, 'readFileSync');
  const notesRead = () => spy.mock.calls.filter((c) => String(c.arguments[0]).endsWith('.md')).length;
  const t0 = performance.now();
  const rep = buildReport([root]);
  const ms = performance.now() - t0;
  assert.equal(notesRead(), 0, 'every note is in the index at its size and mtime: none is read');
  assert.equal(rep.notes.notes, 400);
  assert.equal(rep.notes.sections, 400 * 3, '# Note i, ## One, ## Two');
  assert.equal(rep.writes.total, 4600);
  assert.equal(rep.sessions.reads, 1000);
  t.diagnostic(`buildReport: ${ms.toFixed(0)} ms (400 notes, 5,000 ledger entries, 1,000 reads)`);
  assert.ok(ms < 1000, `report took ${ms.toFixed(0)} ms`);

  // A note changed since the last index is the only one read.
  fs.appendFileSync(path.join(dir, 'area-3/note-3.md'), '\n## Three\n\nzeta eta theta\n');
  const before = notesRead();
  assert.equal(buildReport([root]).notes.sections, 400 * 3 + 1);
  assert.equal(notesRead() - before, 1);
  t.mock.restoreAll();

  // The whole command, process start included.
  const t1 = performance.now();
  const cli = await runCli(['report', '--root', dir], { env: { [HOME_VAR]: home } });
  t.diagnostic(`${NAME} report (process): ${(performance.now() - t1).toFixed(0)} ms`);
  assert.equal(cli.code, 0, cli.stderr);
});
