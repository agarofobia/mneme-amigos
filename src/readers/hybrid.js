// Hybrid reader: fuses the lexical ranking with a semantic one (embeddings) by Reciprocal
// Rank Fusion, k = 60. RRF only uses ranks, so BM25 scores (unbounded) and cosines
// (bounded) never have to be calibrated against each other.
//
// All or nothing: when any embedder fails, times out, or the stored vectors are not
// complete, the result is the lexical ranking alone and `degraded` says why. A result is
// never half hybrid.

import { NAME, STATE_DIR } from '../name.js';
import { checkEmbeddings, dot, embedderFor, withTimeout } from './embeddings.js';
import { syncVectors } from './index.js';

/** @typedef {import('../types.js').Embedder} Embedder */
/** @typedef {import('./index.js').Snapshot} Snapshot */
/** @typedef {import('./lexical.js').SectionDoc} SectionDoc */

/** RRF constant (contract §4.12). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: each item scores the sum of 1 / (k + rank) over the rankings it
 * appears in (rank from 1).
 * @param {Array<number[]>} rankings  item ids, best first
 * @param {number} [k]
 * @returns {Map<number, number>}
 */
export function rrf(rankings, k = RRF_K) {
  /** @type {Map<number, number>} */
  const scores = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  }
  return scores;
}

/**
 * @typedef {Object} CandidateDoc
 * @property {number} snap        index of its snapshot
 * @property {string} rel
 * @property {SectionDoc} section
 */

/**
 * @typedef {Object} RankedList
 * @property {Array<{ i: number, score: number, cos?: number }>} ranked  doc indices, best first;
 *   `cos` is the section's cosine with the query (absent when the result is lexical only)
 * @property {string} [degraded]  set when the result is lexical only, with the reason
 */

/**
 * Ranks `docs` for `query` by fusing `lexical` with the semantic ranking.
 * @param {Object} input
 * @param {Snapshot[]} input.snapshots
 * @param {CandidateDoc[]} input.docs
 * @param {string} input.query
 * @param {Array<{ i: number, score: number }>} input.lexical  BM25 ranking of `docs`
 * @param {number} input.pool   how many of each ranking enter the fusion
 * @param {Embedder} [input.embedder]  used for every root; otherwise each root's config
 * @param {number} [input.rrfK]  the RRF constant (config ranking.rrfK; default RRF_K)
 * @returns {Promise<RankedList>}
 */
export async function hybridRank(input) {
  const { snapshots, docs, query, lexical, pool } = input;
  /** @param {string} reason */
  const lexicalOnly = (reason) => ({ ranked: lexical, degraded: reason });

  /** @type {Map<string, { embedder: Embedder, timeoutMs: number, snaps: number[] }>} */
  const groups = new Map();
  for (let si = 0; si < snapshots.length; si++) {
    const { root } = snapshots[si];
    const cfg = root.config.embeddings;
    let key = 'given';
    if (!input.embedder) {
      if (cfg.provider === 'none') {
        return lexicalOnly(
          `embeddings unavailable: no embedding provider is configured for ${root.dir} (embeddings.provider is "${cfg.provider}" in ${STATE_DIR}/config.json)`,
        );
      }
      // A module path is relative to its root: two roots with the same config may load two files.
      key = cfg.provider === 'module' ? `${root.dir}\n${JSON.stringify(cfg)}` : JSON.stringify(cfg);
    }
    const group = groups.get(key);
    if (group) group.snaps.push(si);
    else groups.set(key, { embedder: input.embedder ?? /** @type {Embedder} */ (embedderFor(root)), timeoutMs: cfg.timeoutMs, snaps: [si] });
  }

  /** @type {Map<number, number>} */
  const cosine = new Map();
  for (const { embedder, timeoutMs, snaps } of groups.values()) {
    /** @type {Float32Array} */
    let queryVector;
    try {
      const raw = await withTimeout(() => embedder.embed([query], 'query'), timeoutMs, `embedder "${embedder.name}"`);
      [queryVector] = checkEmbeddings(raw, 1, embedder.name);
    } catch (e) {
      return lexicalOnly(`embeddings unavailable: ${/** @type {Error} */ (e).message}`);
    }
    // Sections not embedded yet get the same time budget as the query, once.
    const deadline = Date.now() + timeoutMs;
    for (const si of snaps) {
      const snapshot = snapshots[si];
      const sync = await syncVectors(snapshot, embedder, { timeoutMs, deadline });
      if (sync.error) return lexicalOnly(`embeddings unavailable: ${sync.error}`);
      if (sync.missing > 0) {
        return lexicalOnly(
          `embeddings index incomplete: ${sync.total - sync.missing} of ${sync.total} sections of ${snapshot.root.dir} have vectors (run: ${NAME} index)`,
        );
      }
      if (sync.total > 0 && sync.dims !== queryVector.length) {
        return lexicalOnly(
          `embeddings unavailable: the stored vectors have ${sync.dims} dimensions and the query vector has ${queryVector.length}`,
        );
      }
      docs.forEach((doc, i) => {
        if (doc.snap !== si) return;
        const vec = sync.vectors.get(doc.section.vid);
        if (vec) cosine.set(i, dot(queryVector, vec));
      });
    }
  }

  const semantic = [...cosine]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, pool)
    .map(([i]) => i);
  const lexicalIds = lexical.slice(0, pool).map((h) => h.i);
  /** @type {Map<number, number>} */
  const lexicalRank = new Map(lexicalIds.map((id, r) => [id, r]));
  const far = Number.MAX_SAFE_INTEGER;
  // The RRF score orders; it cannot judge relevance (it only knows ranks). The cosine travels
  // with each item so the caller can (search.js, hitPasses).
  const ranked = [...rrf([lexicalIds, semantic], input.rrfK ?? RRF_K)]
    .map(([i, score]) => ({ i, score, cos: /** @type {number} */ (cosine.get(i)) }))
    .sort((a, b) => b.score - a.score || (lexicalRank.get(a.i) ?? far) - (lexicalRank.get(b.i) ?? far) || a.i - b.i);
  return { ranked };
}
