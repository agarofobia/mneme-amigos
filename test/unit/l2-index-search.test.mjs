// Unit tests of the index, the embedder client and the hybrid reader. No network: the
// Ollama client gets a fake `fetch`, and the hybrid reader gets fake embedders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { STATE_DIR } from '../../src/name.js';
import {
  TimeoutError,
  decodeVector,
  encodeVector,
  normalize,
  ollamaEmbedder,
  withTimeout,
} from '../../src/readers/embeddings.js';
import { MAX_NOTE_BYTES, updateIndex } from '../../src/readers/index.js';
import { openRoot } from '../../src/root.js';
import { MAX_HIT_CHARS, defaultReader, degradedLine, formatHit, search } from '../../src/search.js';
import { snapshot } from '../helpers/fixture.mjs';

/** @typedef {import('../../src/types.js').Embedder} Embedder */
/** @typedef {import('../../src/types.js').EmbeddingsConfig} EmbeddingsConfig */

const NOW = new Date('2026-09-24T12:00:00Z');

/**
 * A governed root in a temporary directory, with invented notes.
 * @param {Record<string, string>} files
 * @param {object} [config]
 */
function tempRoot(files, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-l2-'));
  fs.mkdirSync(path.join(dir, STATE_DIR));
  if (config) fs.writeFileSync(path.join(dir, STATE_DIR, 'config.json'), JSON.stringify(config));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return openRoot(dir);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An embedder that counts its calls. Vectors: [1, 0] for texts about tea, [0, 1] otherwise.
 * @param {{ name?: string, documentDelayMs?: number }} [options]
 */
function counting(options = {}) {
  const calls = { query: 0, document: 0, texts: 0 };
  /** @type {Embedder} */
  const embedder = {
    name: options.name ?? 'counting',
    async embed(texts, role) {
      calls[role]++;
      if (role === 'document') {
        calls.texts += texts.length;
        if (options.documentDelayMs) await sleep(options.documentDelayMs);
      }
      return texts.map((t) => (/tea/i.test(t) ? [1, 0] : [0, 1]));
    },
  };
  return { calls, embedder };
}

const NOTES = {
  'kitchen/tea.md': '# Tea\n\nGreen tea steeps for two minutes.\n\n## Storage\n\nKeep the leaves dry.\n',
  'garage/bike.md': '# Bike\n\nThe chain needs oil every month.\n',
};

/** @type {EmbeddingsConfig} */
const OLLAMA = {
  provider: 'ollama',
  url: 'http://127.0.0.1:11434/',
  model: 'bge-m3',
  timeoutMs: 150,
  queryPrefix: 'query: ',
  documentPrefix: 'passage: ',
};

/** @type {string[]} */
const requested = [];

/**
 * A fake fetch for the Ollama client.
 * @param {(url: string, init: RequestInit) => Promise<Response>} answer
 * @returns {typeof fetch}
 */
const fakeFetch = (answer) =>
  /** @type {typeof fetch} */ (
    async (url, init) => {
      requested.push(String(url));
      return answer(String(url), /** @type {RequestInit} */ (init));
    }
  );

test('ollamaEmbedder posts to /api/embed with the prefix of each role and returns one vector per text', async () => {
  /** @type {Array<{ url: string, body: any, hasSignal: boolean }>} */
  const seen = [];
  const embedder = ollamaEmbedder(OLLAMA, {
    fetch: fakeFetch(async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)), hasSignal: init.signal instanceof AbortSignal });
      return new Response(JSON.stringify({ embeddings: [[3, 4], [0, 2]] }), { status: 200 });
    }),
  });
  const docs = await embedder.embed(['a', 'b'], 'document');
  assert.equal(docs.length, 2);
  assert.ok(Math.abs(docs[0][0] - 0.6) < 1e-6 && Math.abs(docs[0][1] - 0.8) < 1e-6, 'normalized');
  await embedder.embed(['a', 'b'], 'query');
  assert.equal(seen[0].url, 'http://127.0.0.1:11434/api/embed');
  assert.deepEqual(seen[0].body, { model: 'bge-m3', input: ['passage: a', 'passage: b'] });
  assert.deepEqual(seen[1].body.input, ['query: a', 'query: b']);
  assert.ok(seen.every((s) => s.hasSignal), 'every request is bounded by a timeout');
  assert.match(embedder.name, /^ollama\/bge-m3/);
});

test('ollamaEmbedder: a missing model is an error that says to pull it by hand; it never downloads', async () => {
  const embedder = ollamaEmbedder(OLLAMA, {
    fetch: fakeFetch(async () => new Response('{"error":"model \\"bge-m3\\" not found, try pulling it first"}', { status: 404 })),
  });
  await assert.rejects(embedder.embed(['x'], 'query'), /ollama pull bge-m3.*never downloads a model/);
});

test('ollamaEmbedder: unreachable, silent and malformed servers give clear errors', async () => {
  const refused = ollamaEmbedder(OLLAMA, {
    fetch: fakeFetch(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }),
  });
  await assert.rejects(refused.embed(['x'], 'query'), /cannot reach http:\/\/127\.0\.0\.1:11434 \(ECONNREFUSED\)/);

  const silent = ollamaEmbedder(OLLAMA, {
    fetch: fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ),
  });
  const t0 = Date.now();
  await assert.rejects(silent.embed(['x'], 'query'), /no answer from http:\/\/127\.0\.0\.1:11434 within 150 ms/);
  assert.ok(Date.now() - t0 < 1500, 'the request is abandoned at its timeout');

  const garbage = ollamaEmbedder(OLLAMA, { fetch: fakeFetch(async () => new Response('<html>', { status: 200 })) });
  await assert.rejects(garbage.embed(['x'], 'query'), /not JSON/);
  const short = ollamaEmbedder(OLLAMA, { fetch: fakeFetch(async () => new Response('{"embeddings":[[1,2]]}', { status: 200 })) });
  await assert.rejects(short.embed(['x', 'y'], 'query'), /returned 1 vectors for 2 texts/);
  const server = ollamaEmbedder(OLLAMA, { fetch: fakeFetch(async () => new Response('boom', { status: 500 })) });
  await assert.rejects(server.embed(['x'], 'query'), /HTTP 500: boom/);
});

test('the embedder client only ever called /api/embed (never a pull)', () => {
  assert.ok(requested.length > 0);
  assert.ok(requested.every((u) => u.endsWith('/api/embed')), requested.join(', '));
});

test('withTimeout rejects with a TimeoutError; a synchronous throw becomes a rejection', async () => {
  await assert.rejects(withTimeout(() => new Promise(() => {}), 30, 'the thing'), (e) => e instanceof TimeoutError && /the thing gave no answer within 30 ms/.test(e.message));
  await assert.rejects(
    withTimeout(() => {
      throw new Error('sync boom');
    }, 30, 'x'),
    /sync boom/,
  );
  assert.equal(await withTimeout(async () => 7, 30, 'x'), 7);
});

test('vectors survive the storage round trip', () => {
  const v = normalize([1, 2, 2]);
  const back = decodeVector(encodeVector(v));
  assert.deepEqual([...back], [...v]);
  assert.deepEqual([...normalize([0, 0])], [0, 0]);
});

test('the index is incremental: new, changed, removed and unchanged notes', async () => {
  const root = tempRoot(NOTES);
  const first = await updateIndex(root);
  assert.deepEqual([first.reindexed, first.total, first.removed], [2, 2, 0]);
  assert.equal(first.embeddings, undefined, 'no provider, no vectors');
  assert.equal((await updateIndex(root)).reindexed, 0);
  fs.writeFileSync(path.join(root.dir, 'garage/new.md'), '# New\n\ntext\n');
  fs.rmSync(path.join(root.dir, 'kitchen/tea.md'));
  const third = await updateIndex(root);
  assert.deepEqual([third.reindexed, third.total, third.removed], [1, 2, 1]);
  const lexical = JSON.parse(fs.readFileSync(path.join(root.stateDir, 'index/lexical.json'), 'utf8'));
  assert.deepEqual(Object.keys(lexical.notes).sort(), ['garage/bike.md', 'garage/new.md']);
});

test('notes over 2 MB are skipped with a warning, once per change, and never become hits', async () => {
  const root = tempRoot(NOTES);
  fs.writeFileSync(path.join(root.dir, 'huge.md'), `# Huge\n\ntea ${'x'.repeat(MAX_NOTE_BYTES)}`);
  const first = await updateIndex(root);
  assert.equal(first.skipped.length, 1);
  assert.equal(first.skipped[0].rel, 'huge.md');
  assert.match(first.warnings.join('\n'), /skipped huge\.md: larger than 2 MB/);
  assert.equal((await updateIndex(root)).reindexed, 0, 'an unchanged big note is not re-read');
  const res = await search([root], 'tea', { reader: 'lexical', now: NOW });
  assert.ok(!res.hits.some((h) => h.rel === 'huge.md'));
  assert.match((res.warnings ?? []).join('\n'), /huge\.md/);
});

test('an unreadable index file is rebuilt, and says so', async () => {
  const root = tempRoot(NOTES);
  await updateIndex(root);
  const file = path.join(root.stateDir, 'index/lexical.json');
  fs.writeFileSync(file, '{ not json');
  const res = await updateIndex(root);
  assert.match(res.warnings.join('\n'), /lexical index was unreadable/);
  assert.equal(res.reindexed, 2);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('vectors are addressed by section text: only changed sections are embedded again', async () => {
  const root = tempRoot(NOTES);
  const { calls, embedder } = counting();
  const first = await updateIndex(root, { embedder });
  assert.equal(first.embeddings?.total, 3);
  assert.equal(first.embeddings?.embedded, 3);
  assert.equal(first.embeddings?.missing, 0);
  assert.equal((await updateIndex(root, { embedder })).embeddings?.embedded, 0);
  fs.writeFileSync(path.join(root.dir, 'kitchen/tea.md'), NOTES['kitchen/tea.md'].replace('dry', 'dry and dark'));
  assert.equal((await updateIndex(root, { embedder })).embeddings?.embedded, 1, 'only ## Storage changed');
  fs.renameSync(path.join(root.dir, 'garage/bike.md'), path.join(root.dir, 'garage/bicycle.md'));
  assert.equal((await updateIndex(root, { embedder })).embeddings?.embedded, 0, 'a renamed note keeps its vectors');
  const other = counting({ name: 'another-model' });
  assert.equal((await updateIndex(root, { embedder: other.embedder })).embeddings?.embedded, 3, 'another model starts over');
  assert.equal(calls.query, 0);
  assert.equal((await updateIndex(root, { embedder: null })).embeddings, undefined);
});

test('hybrid: an embedder that never answers degrades to lexical within its timeout', async () => {
  const root = tempRoot(NOTES, { embeddings: { timeoutMs: 200 } });
  /** @type {Embedder} */
  const hanging = { name: 'hanging', embed: () => new Promise(() => {}) };
  const t0 = Date.now();
  const res = await search([root], 'green tea', { reader: 'hybrid', embedder: hanging, now: NOW });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
  assert.match(res.degraded ?? '', /^embeddings unavailable: embedder "hanging" gave no answer within 200 ms$/);
  assert.equal(res.hits[0]?.rel, 'kitchen/tea.md');
  assert.equal(degradedLine(res), `(lexical only: ${res.degraded})`);
});

test('hybrid: a failing or malformed embedder degrades with its reason', async () => {
  const root = tempRoot(NOTES);
  /** @type {Embedder} */
  const failing = {
    name: 'failing',
    embed: async () => {
      throw new Error('model exploded');
    },
  };
  const a = await search([root], 'tea', { reader: 'hybrid', embedder: failing, now: NOW });
  assert.equal(a.degraded, 'embeddings unavailable: model exploded');
  /** @type {Embedder} */
  const malformed = { name: 'malformed', embed: async () => [[1, Number.NaN]] };
  const b = await search([root], 'tea', { reader: 'hybrid', embedder: malformed, now: NOW });
  assert.match(b.degraded ?? '', /non-numeric/);
  /** @type {Embedder} */
  const queryOnly = { name: 'query-only', embed: async (texts, role) => (role === 'query' ? [[1, 0]] : texts.map(() => [1, 0, 0])) };
  const c = await search([root], 'tea', { reader: 'hybrid', embedder: queryOnly, now: NOW });
  assert.match(c.degraded ?? '', /stored vectors have 3 dimensions and the query vector has 2/);
});

test('hybrid: sections not embedded in time make the result lexical and say how far it got; the next search finishes', async () => {
  /** @type {Record<string, string>} */
  const files = {};
  for (let i = 0; i < 40; i++) files[`n/${String(i).padStart(2, '0')}.md`] = `# Note ${i}\n\nword${i} tea\n`;
  const root = tempRoot(files, { embeddings: { timeoutMs: 300 } });
  const { calls, embedder } = counting({ documentDelayMs: 200 });
  const first = await search([root], 'tea', { reader: 'hybrid', embedder, now: NOW });
  assert.match(first.degraded ?? '', /^embeddings index incomplete: 32 of 40 sections of .* have vectors \(run: mneme index\)$/);
  assert.ok(first.hits.length > 0, 'still answers, lexically');
  const second = await search([root], 'tea', { reader: 'hybrid', embedder, now: NOW });
  assert.equal(second.degraded, undefined, second.degraded);
  // 32 kept + 8 sent and abandoned at the first deadline + the same 8 again.
  assert.equal(calls.texts, 48);
  const third = await search([root], 'tea', { reader: 'hybrid', embedder, now: NOW });
  assert.equal(third.degraded, undefined);
  assert.equal(calls.texts, 48, 'a warm index embeds only the query');
  assert.equal(calls.query, 3);
});

test('hybrid over several roots: one configured embedder per root, or one given for all', async () => {
  const withProvider = tempRoot(NOTES, { embeddings: { provider: 'ollama', url: 'http://127.0.0.1:9' } });
  const without = tempRoot({ 'other.md': '# Other\n\nMore tea notes.\n' });
  const res = await search([withProvider, without], 'tea', { reader: 'hybrid', now: NOW });
  assert.ok(res.degraded?.includes(without.dir) || res.degraded?.includes(withProvider.dir), res.degraded);
  const { embedder } = counting();
  const both = await search([withProvider, without], 'tea', { reader: 'hybrid', embedder, now: NOW });
  assert.equal(both.degraded, undefined);
  assert.deepEqual(new Set(both.hits.map((h) => h.root)), new Set([withProvider.dir, without.dir]));
});

test('search: minLexical, validation, empty query, duplicated roots, clipped text, and it never writes a note', async () => {
  const long = `# Long\n\n${'tea leaves '.repeat(300)}`;
  const root = tempRoot({ ...NOTES, 'long.md': long });
  const before = snapshot(root.dir);
  const strict = tempRoot(NOTES, { search: { minLexical: 1000 } });
  assert.deepEqual((await search([strict], 'tea', { reader: 'lexical', now: NOW })).hits, []);
  await assert.rejects(search([], 'tea'), TypeError);
  await assert.rejects(search([root], /** @type {any} */ (5)), TypeError);
  await assert.rejects(search([root], 'tea', { k: 0 }), RangeError);
  await assert.rejects(search([root], 'tea', { reader: /** @type {any} */ ('graph') }), RangeError);
  assert.deepEqual((await search([root], '   ', { now: NOW })).hits, []);
  const twice = await search([root, root], 'tea', { reader: 'lexical', k: 10, now: NOW });
  const ids = twice.hits.map((h) => `${h.root}|${h.rel}|${h.section.start}`);
  assert.equal(new Set(ids).size, ids.length, 'the same root twice gives no duplicated hits');
  const clipped = twice.hits.find((h) => h.rel === 'long.md');
  assert.ok(clipped);
  assert.equal(clipped.text.length, MAX_HIT_CHARS);
  assert.ok(clipped.text.endsWith('…'));
  assert.equal(formatHit(twice.hits[0]).startsWith(twice.hits[0].rel), true);
  assert.deepEqual(snapshot(root.dir), before, 'searching only writes inside the state directory');
});

test('the default reader is hybrid only when an embedder is given or configured', () => {
  const plain = tempRoot(NOTES);
  const configured = tempRoot(NOTES, { embeddings: { provider: 'ollama' } });
  const { embedder } = counting();
  assert.equal(defaultReader([plain]), 'lexical');
  assert.equal(defaultReader([plain], embedder), 'hybrid');
  assert.equal(defaultReader([configured]), 'hybrid');
});
