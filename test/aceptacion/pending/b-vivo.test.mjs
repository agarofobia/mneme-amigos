// Acceptance, lote B (contracts §4.22 delivered, §4.23 the local server, §4.24 uses and config).
// Written by the main thread BEFORE the lote; the worker does not edit it (objections go in
// `objeciones_a_tests`).   node --test test/aceptacion/pending/b-vivo.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { adoptedRoot, isolateHome, runCli } from '../l3-helpers.mjs';
import { sha256 } from '../../helpers/fixture.mjs';
import { handleHook } from '../../../src/adapters/claude-code/hooks.js';
import { loadConfig } from '../../../src/config.js';
import { configHistory, applyConfig } from '../../../src/config-store.js';
import { deliveryStats, readDelivered } from '../../../src/delivered.js';
import { startGuiServer } from '../../../src/gui/server.js';
import { STATE_DIR } from '../../../src/name.js';
import { registerRoot } from '../../../src/registry.js';
import { listNotes, openRoot } from '../../../src/root.js';
import { search } from '../../../src/search.js';
import { editNote } from '../../../src/store.js';
import { USES, measureRoot, recommend } from '../../../src/usos.js';

isolateHome();
const cfgFile = (root) => path.join(root.dir, STATE_DIR, 'config.json');
const deliveredLines = (root) => readDelivered(root, {});

// ── §4.22 delivered ───────────────────────────────────────────────────────────

test('a CLI search records what it delivered (notes and bytes, never the query); the library search does not', async () => {
  const root = await adoptedRoot();
  await search([root], 'rebuild the vector index', { reader: 'lexical' });
  assert.equal(deliveredLines(root).length, 0, 'searching to test is not delivering');
  const r = await runCli(['search', 'rebuild the vector index', '--root', root.dir]);
  assert.equal(r.code, 0, r.stderr);
  const lines = deliveredLines(root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].via, 'search');
  assert.equal(lines[0].session, null);
  assert.ok(lines[0].notes.some((n) => n.rel === 'projects/alpha.md' && n.bytes > 0));
  const raw = fs.readFileSync(path.join(root.dir, STATE_DIR, 'run', 'delivered.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /rebuild the vector index/i, 'the query is the person\'s text: it is not stored');
});

test('bundle and the wake-up record their delivery; the wake-up carries its session; opened counts later reads by that session', async () => {
  const root = await adoptedRoot();
  fs.writeFileSync(cfgFile(root), JSON.stringify({ version: 1, wakeUpBudget: 8192 }));
  registerRoot(root.dir);
  const b = await runCli(['bundle', '--root', root.dir]);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(deliveredLines(root).at(-1)?.via, 'bundle');
  await handleHook({ hook_event_name: 'SessionStart', session_id: 'wake-1', cwd: root.dir });
  const wake = deliveredLines(root).at(-1);
  assert.equal(wake?.via, 'wake-up');
  assert.equal(wake?.session, 'wake-1');
  assert.ok(wake.notes.length > 0);
  const rel = wake.notes[0].rel;
  await handleHook({ hook_event_name: 'PostToolUse', session_id: 'wake-1', tool_name: 'Read', tool_input: { file_path: path.join(root.dir, rel) }, cwd: root.dir, tool_response: {} });
  const s = deliveryStats(openRoot(root.dir), {});
  assert.ok(s.deliveries >= 2);
  assert.ok(s.opened >= 1, 'the note the wake-up delivered and the same session then read');
  assert.ok(s.bytes > 0);
});

// ── §4.24 uses and config ─────────────────────────────────────────────────────

test('recommend follows the rule of the sketch, in one place', () => {
  assert.equal(recommend({ bytes: 100_000, changed14: 0.1, language: { en: 0.9, es: 0.1 }, code: 0.5 }).id, 'small-memory');
  assert.equal(recommend({ bytes: 6e6, changed14: 0.5, language: { en: 0.02, es: 0.98 }, code: 0.27 }).id, 'second-brain');
  assert.equal(recommend({ bytes: 6e6, changed14: 0.5, language: { en: 0.9, es: 0.1 }, code: 0.4 }).id, 'technical-docs');
  assert.ok(recommend({ bytes: 6e6, changed14: 0.5, language: { en: 0.02, es: 0.98 }, code: 0.27 }).why.length > 0);
  assert.deepEqual(USES.map((u) => u.id).sort(), ['custom', 'lightweight', 'second-brain', 'small-memory', 'technical-docs']);
});

test('measureRoot measures the real notes of a root', async () => {
  const root = await adoptedRoot();
  const s = measureRoot(root);
  assert.equal(s.notes, listNotes(root).length);
  assert.ok(s.bytes > 0 && s.language.en > s.language.es, 'the invented corpus is in English');
});

test('every use but "custom" gives a config that loads; applying one writes it with author and reason, and revert undoes it', async () => {
  const root = await adoptedRoot();
  for (const u of USES.filter((u) => u.id !== 'custom')) {
    const r = await adoptedRoot();
    const res = await applyConfig(r, u.patch(measureRoot(r), r.config), { author: { session: 'test', agent: 'cli' }, reason: `use ${u.id}` });
    assert.equal(res.ok, true, u.id);
    assert.doesNotThrow(() => loadConfig(path.join(r.dir, STATE_DIR)), u.id);
  }
  const before = fs.readFileSync(cfgFile(root), 'utf8');
  const bad = await applyConfig(root, { search: { k: 0 } }, { author: { session: 'test', agent: 'cli' }, reason: 'bad' }).catch((e) => e);
  assert.equal(/** @type {any} */ (bad).code, 'CONFIG_INVALID');
  assert.equal(fs.readFileSync(cfgFile(root), 'utf8'), before, 'an invalid patch never touches the file');
});

test('mneme config: shows, previews a use without writing, sets with a reason, refuses an invalid value, reverts', async () => {
  const root = await adoptedRoot();
  const show = await runCli(['config', '--root', root.dir]);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /recommended/i);
  const hash = sha256(fs.readFileSync(cfgFile(root), 'utf8'));
  const preview = await runCli(['config', '--use', 'lightweight', '--root', root.dir]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(sha256(fs.readFileSync(cfgFile(root), 'utf8')), hash, 'a preview writes nothing');
  const set = await runCli(['config', 'set', 'search.k', '7', '--reason', 'more hits', '--root', root.dir]);
  assert.equal(set.code, 0, set.stderr);
  assert.equal(loadConfig(path.join(root.dir, STATE_DIR)).search.k, 7);
  const noReason = await runCli(['config', 'set', 'search.k', '8', '--root', root.dir]);
  assert.notEqual(noReason.code, 0, 'a reason is required');
  const bad = await runCli(['config', 'set', 'search.k', '0', '--reason', 'x', '--root', root.dir]);
  assert.notEqual(bad.code, 0);
  assert.equal(loadConfig(path.join(root.dir, STATE_DIR)).search.k, 7);
  const back = await runCli(['config', 'revert', '--reason', 'undo', '--root', root.dir]);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(loadConfig(path.join(root.dir, STATE_DIR)).search.k, 5);
  const hist = configHistory(openRoot(root.dir));
  assert.equal(hist.length, 2, 'the set and the revert, each with author and reason');
  assert.ok(hist.every((h) => h.author && h.reason));
});

// ── §4.23 the local server ────────────────────────────────────────────────────

/** @returns {Promise<{ status: number, body: string }>} */
function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
/** @returns {Promise<{ status: number, body: string }>} */
function post(port, pathname, token, json) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(json);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('the server listens on 127.0.0.1 only, demands the token, and refuses a foreign Host', async () => {
  const root = await adoptedRoot();
  const srv = await startGuiServer({ roots: [root], port: 0, open: false });
  try {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/);
    assert.equal((await get(srv.port, '/api/mind')).status, 401);
    assert.equal((await get(srv.port, '/api/mind', { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await get(srv.port, `/api/mind?t=${srv.token}`, { host: `evil.example:${srv.port}` })).status, 403);
    assert.equal((await get(srv.port, `/api/mind?t=${srv.token}`, { origin: 'http://evil.example' })).status, 403);
    const ok = await get(srv.port, '/api/mind', { authorization: `Bearer ${srv.token}` });
    assert.equal(ok.status, 200);
    const mind = JSON.parse(ok.body);
    for (const k of ['generated', 'root', 'groupings', 'nodes', 'edges', 'events', 'sessions', 'stats']) assert.ok(k in mind, `/api/mind has ${k}`);
    assert.equal(mind.nodes.length, listNotes(root).length);
    const page = await get(srv.port, `/?t=${srv.token}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<html/i);
  } finally {
    await srv.close();
  }
});

test('a write by another session reaches the page over SSE in under 2 s', async () => {
  const root = await adoptedRoot();
  const srv = await startGuiServer({ roots: [root], port: 0, open: false });
  try {
    const got = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no write event within 2 s')), 2000 + 1500);
      const req = http.get({ host: '127.0.0.1', port: srv.port, path: `/api/events?t=${srv.token}` }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers['content-type']), /text\/event-stream/);
        let buf = '';
        let t0 = 0;
        res.on('data', async (d) => {
          buf += d;
          if (!t0) {
            t0 = Date.now();
            await editNote(root, 'projects/alpha.md', { old: 'Rebuild the vector index', new: 'Rebuild the index' }, { author: { session: 'other-1', agent: 'claude-code' }, reason: 'sse test' });
          }
          const m = buf.match(/event: write\r?\ndata: (.*)\r?\n/);
          if (m) {
            clearTimeout(timer);
            req.destroy();
            resolve({ data: JSON.parse(m[1]), ms: Date.now() - t0 });
          }
        });
      });
      req.on('error', (e) => { if (!/aborted|socket hang up/i.test(String(e))) reject(e); });
    });
    assert.equal(/** @type {any} */ (got).data.rel, 'projects/alpha.md');
    assert.ok(/** @type {any} */ (got).ms < 2000, `took ${/** @type {any} */ (got).ms} ms`);
  } finally {
    await srv.close();
  }
});

test('the config through the server: never shows embeddings.options, applies as author gui, refuses what is invalid, reverts', async () => {
  const root = await adoptedRoot();
  fs.writeFileSync(cfgFile(root), JSON.stringify({ version: 1, embeddings: { provider: 'none', options: { apiKey: 'sk-should-never-travel' } } }));
  const r = openRoot(root.dir);
  const srv = await startGuiServer({ roots: [r], port: 0, open: false });
  try {
    const shown = await get(srv.port, '/api/config', { authorization: `Bearer ${srv.token}` });
    assert.equal(shown.status, 200);
    assert.doesNotMatch(shown.body, /sk-should-never-travel/);
    assert.equal((await post(srv.port, '/api/config', srv.token, { patch: { search: { k: 7 } } })).status, 400, 'a reason is required');
    assert.equal((await post(srv.port, '/api/config', srv.token, { patch: { search: { k: 0 } }, reason: 'bad' })).status, 400);
    const ok = await post(srv.port, '/api/config', srv.token, { patch: { search: { k: 7 } }, reason: 'from the gui' });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(loadConfig(path.join(root.dir, STATE_DIR)).search.k, 7);
    assert.equal(loadConfig(path.join(root.dir, STATE_DIR)).embeddings.options.apiKey, 'sk-should-never-travel', 'applying never drops what it does not show');
    const last = configHistory(openRoot(root.dir)).at(-1);
    assert.equal(last?.author.session, 'gui');
    assert.doesNotMatch(JSON.stringify(configHistory(openRoot(root.dir))), /sk-should-never-travel/, 'nor does the history keep it');
    assert.equal((await post(srv.port, '/api/config/revert', srv.token, { reason: 'undo' })).status, 200);
    assert.equal(loadConfig(path.join(root.dir, STATE_DIR)).search.k, 5);
  } finally {
    await srv.close();
  }
});
