// The read index of a root, under `<root>/.mneme/index/`. It is a cache: it is never the
// source of anything and can be deleted at any time.
//
//   lexical.json   per note: its sha256 and its sections (offsets + term frequencies)
//   vectors.json   per section text: its normalized embedding, for one embedder (by name)
//
// Updates are incremental: a note is re-indexed only when its sha changed. Section vectors
// are addressed by the hash of the text that was embedded, so an edit re-embeds only the
// sections whose text changed, and a renamed note re-embeds nothing.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listNotes } from '../root.js';
import { TimeoutError, checkEmbeddings, decodeVector, embedderFor, encodeVector, withTimeout } from './embeddings.js';
import { embeddingText, sectionDocs } from './lexical.js';

/** @typedef {import('../types.js').Root} Root */
/** @typedef {import('../types.js').Embedder} Embedder */
/** @typedef {import('./lexical.js').SectionDoc} SectionDoc */

/** Bump when the tokenizer, the section documents or the file format change. */
export const INDEX_VERSION = 1;
/** Notes larger than this are not indexed; the reader says so. */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
/** Texts per request to an embedder. */
const EMBED_BATCH = 32;
/** Per-request timeout floor when indexing (a cold model can take seconds to load). */
const INDEX_EMBED_TIMEOUT_MS = 60000;

/**
 * @typedef {Object} NoteEntry
 * @property {string|null} sha     sha256 of the content (null when skipped)
 * @property {number} size         bytes
 * @property {number} mtimeMs
 * @property {string} [skipped]    why it is not indexed
 * @property {SectionDoc[]} sections
 */

/**
 * The index of one root, fresh against the files on disk.
 * @typedef {Object} Snapshot
 * @property {Root} root
 * @property {Map<string, NoteEntry>} notes     every note, by rel, sorted
 * @property {Map<string, string>} contents     text of every indexed note, as read now
 * @property {number} reindexed                  notes (re)read because they are new or changed
 * @property {number} removed                    notes dropped because they no longer exist
 * @property {Array<{ rel: string, reason: string }>} skipped
 * @property {string[]} warnings
 */

/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** @param {Root} root */
const indexDir = (root) => `${root.stateDir}/index`;

/** @param {unknown} e */
const codeOf = (e) => /** @type {NodeJS.ErrnoException} */ (e)?.code ?? /** @type {Error} */ (e)?.message ?? String(e);

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `data` to `file` atomically (temporary file in the same directory + rename), with
 * a few retries for the transient locks Windows puts on a file being read.
 * @param {string} file
 * @param {string} data
 */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch (cleanup) {
        throw new Error(`${/** @type {Error} */ (e).message}; the temporary file ${tmp} could not be removed either (${codeOf(cleanup)})`, { cause: e });
      }
      throw e;
    }
  }
}

/**
 * Reads a JSON cache file. Missing → null. Unreadable → null plus a warning.
 * @param {string} file
 * @param {string[]} warnings
 * @param {string} what
 * @returns {unknown}
 */
function readCache(file, warnings, what) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    warnings.push(`could not read the ${what} (${codeOf(e)}); rebuilding it`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    warnings.push(`the ${what} was unreadable (${/** @type {Error} */ (e).message}); rebuilt it`);
    return null;
  }
}

/** In-process cache of parsed index files, keyed by file path; valid while size+mtime match. */
/** @type {Map<string, { size: number, mtimeMs: number, value: unknown }>} */
const fileCache = new Map();

/**
 * @param {string} file
 * @param {string[]} warnings
 * @param {string} what
 */
function readCached(file, warnings, what) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') warnings.push(`could not read the ${what} (${codeOf(e)}); rebuilding it`);
    fileCache.delete(file);
    return null;
  }
  const hit = fileCache.get(file);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.value;
  const value = readCache(file, warnings, what);
  if (value !== null) fileCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}

/**
 * @param {string} file
 * @param {string} data
 * @param {unknown} value  what `data` parses to, kept in the in-process cache
 * @param {string[]} warnings
 * @param {string} what
 */
function saveCache(file, data, value, warnings, what) {
  try {
    writeAtomic(file, data);
    const stat = fs.statSync(file);
    fileCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  } catch (e) {
    fileCache.delete(file);
    warnings.push(`could not save the ${what} (${codeOf(e)}); search still works and will rebuild it next time`);
  }
}

/**
 * The previous lexical index, as a Map, or an empty Map when missing, unreadable or of
 * another version.
 * @param {Root} root
 * @param {string[]} warnings
 * @returns {Map<string, NoteEntry>}
 */
function loadLexical(root, warnings) {
  const json = /** @type {{ v?: unknown, notes?: unknown } | null} */ (readCached(`${indexDir(root)}/lexical.json`, warnings, 'lexical index'));
  /** @type {Map<string, NoteEntry>} */
  const out = new Map();
  if (!json || json.v !== INDEX_VERSION || !json.notes || typeof json.notes !== 'object') return out;
  for (const [rel, entry] of Object.entries(/** @type {Record<string, NoteEntry>} */ (json.notes))) {
    if (entry && Array.isArray(entry.sections) && typeof entry.size === 'number') out.set(rel, entry);
  }
  return out;
}

/**
 * Brings the lexical index of `root` up to date with the files on disk and returns it with
 * the text of every indexed note. Synchronous; incremental by note sha.
 * @param {Root} root
 * @param {{ onProgress?: (done: number, total: number) => void }} [options]
 *   `onProgress` is called every 100 notes
 * @returns {Snapshot}
 */
export function refreshIndex(root, options = {}) {
  /** @type {string[]} */
  const warnings = [];
  const previous = loadLexical(root, warnings);
  const rels = listNotes(root);
  /** @type {Map<string, NoteEntry>} */
  const notes = new Map();
  /** @type {Map<string, string>} */
  const contents = new Map();
  /** @type {Array<{ rel: string, reason: string }>} */
  const skipped = [];
  let reindexed = 0;
  let done = 0;
  for (const rel of rels) {
    done++;
    if (options.onProgress && done % 100 === 0) options.onProgress(done, rels.length);
    const abs = path.join(root.dir, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (e) {
      warnings.push(`could not read ${rel} (${codeOf(e)}); left out of this search`);
      continue;
    }
    const before = previous.get(rel);
    if (stat.size > MAX_NOTE_BYTES) {
      const reason = `larger than 2 MB (${(stat.size / 1048576).toFixed(1)} MB): not indexed; add it to ignorePaths to silence this`;
      skipped.push({ rel, reason });
      if (!before || before.sha !== null || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) reindexed++;
      notes.set(rel, { sha: null, size: stat.size, mtimeMs: stat.mtimeMs, skipped: reason, sections: [] });
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      warnings.push(`could not read ${rel} (${codeOf(e)}); left out of this search`);
      continue;
    }
    const sha = sha256(content);
    contents.set(rel, content);
    if (before && before.sha === sha) {
      notes.set(rel, before.size === stat.size && before.mtimeMs === stat.mtimeMs ? before : { ...before, size: stat.size, mtimeMs: stat.mtimeMs });
      continue;
    }
    reindexed++;
    notes.set(rel, { sha, size: stat.size, mtimeMs: stat.mtimeMs, sections: sectionDocs(content) });
  }
  let removed = 0;
  for (const rel of previous.keys()) if (!notes.has(rel)) removed++;
  const touched = [...notes].some(([rel, entry]) => previous.get(rel) !== entry);
  if (reindexed > 0 || removed > 0 || touched || previous.size === 0) {
    const value = { v: INDEX_VERSION, notes: Object.fromEntries(notes) };
    saveCache(`${indexDir(root)}/lexical.json`, JSON.stringify(value), value, warnings, 'lexical index');
  }
  for (const s of skipped) warnings.push(`skipped ${s.rel}: ${s.reason}`);
  return { root, notes, contents, reindexed, removed, skipped, warnings };
}

/**
 * The stored vectors of `root` for the embedder called `model`. A store made by another
 * model is discarded (the vectors are rebuilt).
 * @param {Root} root
 * @param {string} model
 * @param {string[]} warnings
 * @returns {{ dims: number, vectors: Map<string, Float32Array> }}
 */
export function loadVectors(root, model, warnings) {
  const json = /** @type {{ v?: unknown, model?: unknown, dims?: unknown, vectors?: unknown } | null} */ (
    readCached(`${indexDir(root)}/vectors.json`, warnings, 'vector index')
  );
  if (!json || json.v !== INDEX_VERSION || json.model !== model || typeof json.dims !== 'number' || !json.vectors || typeof json.vectors !== 'object') {
    return { dims: 0, vectors: new Map() };
  }
  let vectors = decodedVectors.get(json);
  if (!vectors) {
    vectors = new Map();
    for (const [vid, b64] of Object.entries(/** @type {Record<string, unknown>} */ (json.vectors))) {
      if (typeof b64 !== 'string') continue;
      const vec = decodeVector(b64);
      if (vec.length === json.dims) vectors.set(vid, vec);
    }
    decodedVectors.set(json, vectors);
  }
  // Read-only for callers: it is shared with the in-process cache.
  return { dims: json.dims, vectors };
}

/** Decoded vectors per parsed vectors.json, so a long-lived process decodes each file once. */
/** @type {WeakMap<object, Map<string, Float32Array>>} */
const decodedVectors = new WeakMap();

/**
 * @typedef {Object} VectorSync
 * @property {Map<string, Float32Array>} vectors  by section vid
 * @property {number} dims
 * @property {number} total      sections that need a vector
 * @property {number} embedded   sections embedded by this call
 * @property {number} missing    sections still without a vector
 * @property {string} [error]    why embedding stopped early
 */

/**
 * Embeds the sections of a snapshot that have no stored vector yet, and saves the store.
 * Stops at `deadline` (epoch ms) or at the first failed request; what was embedded before
 * that is kept.
 * @param {Snapshot} snapshot
 * @param {Embedder} embedder
 * @param {{ timeoutMs: number, deadline?: number }} options  per-request timeout
 * @returns {Promise<VectorSync>}
 */
export async function syncVectors(snapshot, embedder, options) {
  const { root } = snapshot;
  const warnings = snapshot.warnings;
  const stored = loadVectors(root, embedder.name, warnings);
  let dims = stored.dims;
  /** @type {Map<string, Float32Array>} */
  const vectors = new Map();
  /** @type {Map<string, string>} */
  const pending = new Map();
  for (const [rel, entry] of snapshot.notes) {
    const content = snapshot.contents.get(rel);
    if (content === undefined) continue;
    for (const s of entry.sections) {
      const have = stored.vectors.get(s.vid);
      if (have) vectors.set(s.vid, have);
      else if (!pending.has(s.vid)) pending.set(s.vid, embeddingText(content, s));
    }
  }
  const total = vectors.size + pending.size;
  const queue = [...pending];
  let embedded = 0;
  /** @type {string|undefined} */
  let error;
  for (let i = 0; i < queue.length; i += EMBED_BATCH) {
    const remaining = options.deadline === undefined ? options.timeoutMs : options.deadline - Date.now();
    if (remaining <= 0) break;
    // When the caller's deadline is shorter than the request timeout, running out of it
    // means "not finished yet", not "the embedder failed".
    const cutByDeadline = remaining < options.timeoutMs;
    const batch = queue.slice(i, i + EMBED_BATCH);
    try {
      const raw = await withTimeout(() => embedder.embed(batch.map(([, text]) => text), 'document'), Math.min(options.timeoutMs, remaining), `embedder "${embedder.name}"`);
      const vecs = checkEmbeddings(raw, batch.length, embedder.name);
      if (dims === 0) dims = vecs[0].length;
      if (vecs[0].length !== dims) {
        // A store of another size cannot be compared with the new vectors: start over.
        vectors.clear();
        dims = vecs[0].length;
        error = `embedder "${embedder.name}" changed its vector size; vectors are being rebuilt`;
      }
      batch.forEach(([vid], j) => vectors.set(vid, vecs[j]));
      embedded += batch.length;
    } catch (e) {
      if (!(e instanceof TimeoutError && cutByDeadline)) error = /** @type {Error} */ (e).message;
      break;
    }
  }
  const staleStore = stored.vectors.size !== vectors.size || [...stored.vectors.keys()].some((vid) => !vectors.has(vid));
  if (embedded > 0 || staleStore) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [vid, vec] of vectors) out[vid] = encodeVector(vec);
    const json = { v: INDEX_VERSION, model: embedder.name, dims, vectors: out };
    saveCache(`${indexDir(root)}/vectors.json`, JSON.stringify(json), json, warnings, 'vector index');
    decodedVectors.set(json, new Map(vectors));
  }
  // `vectors` only ever holds vids this snapshot needs, so what it lacks is what is missing.
  return { vectors, dims, total, embedded, missing: total - vectors.size, ...(error ? { error } : {}) };
}

/**
 * @typedef {Object} UpdateResult
 * @property {number} reindexed  notes (re)indexed because they were new or changed
 * @property {number} total      notes in the root
 * @property {number} removed    notes dropped from the index
 * @property {Array<{ rel: string, reason: string }>} skipped
 * @property {string[]} warnings
 * @property {{ model: string, total: number, embedded: number, missing: number, error?: string }} [embeddings]
 */

/**
 * Updates the index of `root`: the lexical part always, the vectors when there is an
 * embedder (`options.embedder`, or the one `embeddings` in the config describes; `null`
 * means none).
 * @param {Root} root
 * @param {{ embedder?: Embedder|null, onProgress?: (done: number, total: number) => void, timeoutMs?: number }} [options]
 * @returns {Promise<UpdateResult>}
 */
export async function updateIndex(root, options = {}) {
  const snapshot = refreshIndex(root, { onProgress: options.onProgress });
  const cfg = root.config.embeddings;
  const timeoutMs = options.timeoutMs ?? Math.max(cfg.timeoutMs, INDEX_EMBED_TIMEOUT_MS);
  const embedder =
    options.embedder !== undefined ? options.embedder : embedderFor(root, { timeoutMs });
  /** @type {UpdateResult} */
  const result = {
    reindexed: snapshot.reindexed,
    total: snapshot.notes.size,
    removed: snapshot.removed,
    skipped: snapshot.skipped,
    warnings: snapshot.warnings,
  };
  if (embedder) {
    const sync = await syncVectors(snapshot, embedder, { timeoutMs });
    result.embeddings = {
      model: embedder.name,
      total: sync.total,
      embedded: sync.embedded,
      missing: sync.missing,
      ...(sync.error ? { error: sync.error } : {}),
    };
  }
  return result;
}
