// Embeddings: the interface a third party implements (`Embedder`, see src/types.js), the
// built-in Ollama client, and the helpers the readers share (timeout, normalization,
// compact storage of vectors).
// A root can also bring its own embedder: `provider: "module"` (contracts §4.19).
//
// The Ollama client only ever calls `POST <url>/api/embed`. It never pulls or downloads a model:
// when the model is missing, the error says how the user can pull it themselves.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS } from '../config.js';

/** @typedef {import('../types.js').Embedder} Embedder */
/** @typedef {import('../types.js').EmbeddingsConfig} EmbeddingsConfig */
/** @typedef {import('../types.js').Root} Root */

/** What `withTimeout` rejects with, so a caller can tell "too slow" from "failed". */
export class TimeoutError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with a `TimeoutError` when `work` does not settle within `ms`. Synchronous throws
 * of `work` become rejections.
 * @template T
 * @param {() => Promise<T>} work
 * @param {number} ms
 * @param {string} what  e.g. "the embedder" — used in the error message
 * @returns {Promise<T>}
 */
export function withTimeout(work, ms, what) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} gave no answer within ${ms} ms`)), Math.max(0, ms));
  });
  const run = Promise.resolve().then(work);
  return /** @type {Promise<T>} */ (Promise.race([run, timeout])).finally(() => clearTimeout(timer));
}

/**
 * Unit-length copy of a vector (a zero vector stays zero).
 * @param {ArrayLike<number>} vec
 * @returns {Float32Array}
 */
export function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Dot product; equals the cosine for normalized vectors.
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** @param {Float32Array} vec */
export const encodeVector = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');

/** @param {string} b64 */
export function decodeVector(b64) {
  const buf = Buffer.from(b64, 'base64');
  // Copy: a Buffer may share a pool whose offset is not 4-byte aligned.
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf.subarray(0, out.byteLength));
  return out;
}

/**
 * Checks what an embedder returned and normalizes it.
 * @param {unknown} result
 * @param {number} expected  number of texts sent
 * @param {string} name  embedder name, for the message
 * @returns {Float32Array[]}
 */
export function checkEmbeddings(result, expected, name) {
  if (!Array.isArray(result) || result.length !== expected) {
    throw new Error(`embedder "${name}" returned ${Array.isArray(result) ? result.length : typeof result} vectors for ${expected} texts`);
  }
  const dims = Array.isArray(result[0]) || ArrayBuffer.isView(result[0]) ? /** @type {ArrayLike<number>} */ (result[0]).length : 0;
  return result.map((v, i) => {
    const vec = /** @type {ArrayLike<number>} */ (v);
    const ok = (Array.isArray(v) || ArrayBuffer.isView(v)) && vec.length === dims && dims > 0;
    if (!ok) throw new Error(`embedder "${name}" returned a malformed vector at position ${i}`);
    for (let j = 0; j < vec.length; j++) {
      if (!Number.isFinite(vec[j])) throw new Error(`embedder "${name}" returned a non-numeric value at position ${i}`);
    }
    return normalize(vec);
  });
}

/**
 * Human reason for a failed request, from what `fetch` throws.
 * @param {unknown} err
 * @param {string} url
 */
function describeFetchError(err, url) {
  const e = /** @type {Error & { cause?: { code?: string, message?: string } }} */ (err);
  const cause = e?.cause;
  if (cause && (cause.code || cause.message)) return `cannot reach ${url} (${cause.code ?? cause.message})`;
  return `cannot reach ${url} (${e?.message ?? String(err)})`;
}

/**
 * An `Embedder` backed by a local Ollama server (`POST <url>/api/embed`).
 * The query and document prefixes of the config are prepended by role. Every request is
 * bounded by `timeoutMs`. Never downloads a model.
 * @param {EmbeddingsConfig} config
 * @param {{ timeoutMs?: number, fetch?: typeof fetch }} [options]  `fetch` is for tests
 * @returns {Embedder}
 */
export function ollamaEmbedder(config, options = {}) {
  const base = config.url.replace(/\/+$/, '');
  const url = `${base}/api/embed`;
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const doFetch = options.fetch ?? fetch;
  const suffix = config.documentPrefix || config.queryPrefix ? ` [${config.queryPrefix}|${config.documentPrefix}]` : '';
  const name = `ollama/${config.model}${suffix}`;
  return {
    name,
    async embed(texts, role) {
      const prefix = role === 'query' ? config.queryPrefix : config.documentPrefix;
      // A plain timer, not AbortSignal.timeout(): that one is unref'd and would let the
      // process exit before firing when nothing else is pending. It also bounds the body.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      /** @type {Response} */
      let res;
      /** @type {string} */
      let body;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: config.model, input: texts.map((t) => prefix + t) }),
          signal: controller.signal,
        });
        body = await res.text();
      } catch (err) {
        if (controller.signal.aborted) throw new TimeoutError(`no answer from ${base} within ${timeoutMs} ms`);
        throw new Error(describeFetchError(err, base), { cause: err });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        if (res.status === 404 && /not found/i.test(body)) {
          throw new Error(
            `model "${config.model}" is not available in Ollama at ${base}; pull it yourself (ollama pull ${config.model}): this tool never downloads a model`,
          );
        }
        throw new Error(`Ollama at ${base} answered HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      /** @type {unknown} */
      let json;
      try {
        json = JSON.parse(body);
      } catch (err) {
        throw new Error(`Ollama at ${base} answered something that is not JSON: ${/** @type {Error} */ (err).message}`);
      }
      const embeddings = /** @type {{ embeddings?: unknown }} */ (json)?.embeddings;
      return /** @type {number[][]} */ (Array.from(checkEmbeddings(embeddings, texts.length, name), (v) => Array.from(v)));
    },
  };
}

/** @param {EmbeddingsConfig} config */
const prefixTag = (config) => (config.documentPrefix || config.queryPrefix ? ` [${config.queryPrefix}|${config.documentPrefix}]` : '');

/**
 * An `Embedder` from a module the person wrote (`provider: "module"`): the file exports
 * `createEmbedder(options, { root, config })`, which returns (or resolves to) an Embedder.
 * The module is imported the first time a vector is needed, so a broken module fails a
 * search (which degrades to lexical, saying why), never opening the root.
 * @param {EmbeddingsConfig} config
 * @param {Root} root
 * @returns {Embedder}
 */
export function moduleEmbedder(config, root) {
  const file = path.resolve(root.dir, config.module ?? '');
  // `model` names the vectors (their cache key); left at its default, the file name does.
  const label = config.model && config.model !== DEFAULTS.embeddings.model ? config.model : path.basename(file).replace(/\.[cm]?js$/, '');
  /** @type {Promise<Embedder>|null} */
  let loading = null;
  const load = () =>
    (loading ??= (async () => {
      /** @type {Record<string, unknown>} */
      let mod;
      try {
        mod = await import(pathToFileURL(file).href);
      } catch (e) {
        throw new Error(`the embedding module ${file} could not be loaded: ${/** @type {Error} */ (e).message}`, { cause: e });
      }
      const create = mod.createEmbedder ?? /** @type {any} */ (mod.default)?.createEmbedder;
      if (typeof create !== 'function') throw new Error(`the embedding module ${file} does not export createEmbedder(options, { root, config })`);
      const made = await create(structuredClone(config.options ?? {}), { root, config });
      if (!made || typeof (/** @type {any} */ (made).embed) !== 'function') throw new Error(`createEmbedder in ${file} did not return an object with embed(texts, role)`);
      return /** @type {Embedder} */ (made);
    })());
  return {
    name: `module/${label}${prefixTag(config)}`,
    async embed(texts, role) {
      const inner = await load();
      const prefix = role === 'query' ? config.queryPrefix : config.documentPrefix;
      return inner.embed(prefix ? texts.map((t) => prefix + t) : texts, role);
    },
  };
}

/**
 * The embedder a root's config asks for, or null for provider "none". The one place that
 * turns `embeddings.provider` into an Embedder (search, index and doctor go through it).
 * @param {Root} root
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Embedder|null}
 */
export function embedderFor(root, options = {}) {
  const cfg = root.config.embeddings;
  if (cfg.provider === 'ollama') return ollamaEmbedder(cfg, options);
  if (cfg.provider === 'module') return moduleEmbedder(cfg, root);
  return null;
}
