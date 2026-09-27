// Contracts §4.19 (D-P11): the plug points opened tonight. Bring your own embedding module,
// let the guard record instead of deny, and tune the search numbers — each off by default.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture } from '../helpers/fixture.mjs';
import { isolateHome } from '../aceptacion/l3-helpers.mjs';
import { audit } from '../../src/audit.js';
import { DEFAULTS, loadConfig } from '../../src/config.js';
import { STATE_DIR } from '../../src/name.js';
import { updateIndex } from '../../src/readers/index.js';
import { openRoot } from '../../src/root.js';
import { search } from '../../src/search.js';
import { initRoot, writeNote } from '../../src/store.js';

isolateHome();

const MODULE = `
let calls = 0;
export function createEmbedder(options, { root, config }) {
  if (!root || !config) throw new Error('the module gets the root and the config');
  const dim = options.dim;
  return {
    name: 'letters',
    async embed(texts, role) {
      calls++;
      globalThis.__mnemeModuleCalls = calls;
      globalThis.__mnemeModuleRoles = [...(globalThis.__mnemeModuleRoles ?? []), role];
      return texts.map((t) => {
        const v = new Array(dim).fill(0);
        for (const ch of t.toLowerCase()) { const i = ch.charCodeAt(0) - 97; if (i >= 0 && i < dim) v[i]++; }
        v[0] += 0.001;
        return v;
      });
    },
  };
}
`;

/**
 * An adopted copy of the fixture with this config.
 * @param {object} config
 */
async function rootWith(config) {
  const dir = copyFixture();
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  fs.writeFileSync(path.join(dir, STATE_DIR, 'config.json'), JSON.stringify({ version: 1, ...config }));
  return openRoot(dir);
}

test('the defaults do not change: guard deny, provider none, the same search numbers', () => {
  assert.equal(DEFAULTS.guard, 'deny');
  assert.equal(DEFAULTS.embeddings.provider, 'none');
  assert.deepEqual(DEFAULTS.ranking, { k1: 1.2, b: 0.75, rrfK: 60 });
});

test('provider "module": the module embeds queries and sections; its options arrive as given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-embedder-'));
  fs.writeFileSync(path.join(dir, 'letters.mjs'), MODULE);
  const root = await rootWith({ embeddings: { provider: 'module', module: path.join(dir, 'letters.mjs'), model: 'letters-26', options: { dim: 26 } } });
  const res = await search([root], 'vector index migration');
  assert.equal(res.degraded, undefined, 'the hybrid reader ran with the module');
  assert.ok(res.hits.length > 0);
  assert.ok(/** @type {any} */ (globalThis).__mnemeModuleCalls >= 2, 'queried and embedded the sections');
  assert.ok(/** @type {any} */ (globalThis).__mnemeModuleRoles.includes('query'));
  assert.ok(/** @type {any} */ (globalThis).__mnemeModuleRoles.includes('document'));
  const idx = await updateIndex(root);
  assert.equal(idx.embeddings?.model, 'module/letters-26');
  assert.equal(idx.embeddings?.missing, 0);
});

test('a module path relative to the root works; a missing module degrades to lexical and says why', async () => {
  const root = await rootWith({ embeddings: { provider: 'module', module: 'plugins/letters.mjs', options: { dim: 26 } } });
  fs.mkdirSync(path.join(root.dir, 'plugins'));
  fs.writeFileSync(path.join(root.dir, 'plugins', 'letters.mjs'), MODULE);
  assert.equal((await search([root], 'backups')).degraded, undefined);

  const broken = await rootWith({ embeddings: { provider: 'module', module: 'nope/missing.mjs' } });
  const res = await search([broken], 'backups');
  assert.match(String(res.degraded), /embeddings unavailable: .*missing\.mjs/);
  assert.ok(res.hits.length > 0, 'the lexical reader still answers');
});

test('the config checks what is new, and only that', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-cfg-'));
  const write = (/** @type {object} */ c) => fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ version: 1, ...c }));
  write({ embeddings: { provider: 'module' } });
  assert.throws(() => loadConfig(state), /embeddings\.module/);
  write({ embeddings: { provider: 'module', module: 'x.mjs', options: { anything: [1, { deep: true }] } } });
  assert.deepEqual(loadConfig(state).embeddings.options, { anything: [1, { deep: true }] }, 'options are free-form');
  write({ guard: 'maybe' });
  assert.throws(() => loadConfig(state), /"guard" must be "deny" or "record"/);
  write({ ranking: { b: 2 } });
  assert.throws(() => loadConfig(state), /ranking\.b/);
  write({ ranking: { rrfK: 0 } });
  assert.throws(() => loadConfig(state), /ranking\.rrfK/);
  write({ embeddings: { provider: 'faiss' } });
  assert.throws(() => loadConfig(state), /"none", "ollama" or "module"/);
});

test('guard "record": the write goes through, recorded as authorized by the config; "deny" still denies', async () => {
  const N = 'projects/alpha.md';
  const A = { session: 'session-a', agent: /** @type {const} */ ('claude-code') };
  const B = { session: 'session-b', agent: /** @type {const} */ ('claude-code') };
  for (const mode of ['deny', 'record']) {
    const root = await rootWith({ guard: mode });
    const original = fs.readFileSync(path.join(root.dir, N), 'utf8');
    assert.equal((await writeNote(root, N, `${original}\n## Mine\n\nA's.\n`, { author: A })).ok, true);
    const res = await writeNote(root, N, original, { author: B });
    if (mode === 'deny') {
      assert.equal(res.ok, false);
      continue;
    }
    assert.equal(res.ok, true);
    assert.ok(res.ok && res.entry.override?.lease === 'config:guard=record');
    const a = audit(root);
    assert.equal(a.losses.length, 0);
    assert.deepEqual(a.authorized.map((x) => x.keys), [['## Mine']]);
  }
});

test('ranking.k1 and ranking.b reach the lexical ranking', async () => {
  const q = 'the migration moves every document';
  const base = await search([await rootWith({})], q, { reader: 'lexical' });
  const flat = await search([await rootWith({ ranking: { k1: 0 } })], q, { reader: 'lexical' });
  assert.notDeepEqual(
    flat.hits.map((h) => h.score),
    base.hits.map((h) => h.score),
    'k1 = 0 ignores term frequency, so the scores change',
  );
  const noLen = await search([await rootWith({ ranking: { b: 0 } })], q, { reader: 'lexical' });
  assert.notDeepEqual(noLen.hits.map((h) => h.score), base.hits.map((h) => h.score), 'b = 0 ignores the length');
});

test('ranking.rrfK reaches the hybrid fusion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-embedder-'));
  fs.writeFileSync(path.join(dir, 'letters.mjs'), MODULE);
  const embeddings = { provider: 'module', module: path.join(dir, 'letters.mjs'), options: { dim: 26 } };
  const q = 'vector index migration';
  const base = await search([await rootWith({ embeddings })], q);
  const tight = await search([await rootWith({ embeddings, ranking: { rrfK: 1 } })], q);
  assert.equal(base.degraded, undefined);
  assert.equal(tight.degraded, undefined);
  assert.notDeepEqual(tight.hits.map((h) => h.score), base.hits.map((h) => h.score));
});
