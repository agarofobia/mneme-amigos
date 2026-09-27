// Lexical reader: BM25 over sections. A document is one section: the titles of the
// sections that contain it, then its own text (its heading line and the text up to the
// next heading of any level). The text before the first heading is a section with key ''.

import { createHash } from 'node:crypto';
import { parseNote } from '../sections.js';
import { termFrequencies } from './tokenize.js';

/** BM25 parameters (contract §4.12). */
export const K1 = 1.2;
export const B = 0.75;

/** Longest text handed to an embedder for one section. */
const MAX_EMBED_CHARS = 6000;

/**
 * One indexed section of a note.
 * @typedef {Object} SectionDoc
 * @property {string} key      heading key ('' for the text before the first heading)
 * @property {number} occ      occurrence of `key` in the note, from 1
 * @property {string[]} path   titles from the outermost heading down to this one ([] for '')
 * @property {number} start    offset of the heading line (or of the preamble)
 * @property {number} ownEnd   offset of the next heading of any level
 * @property {number} end      offset of the next heading of the same or a higher level
 * @property {number} len      number of tokens
 * @property {Array<[string, number]>} tf  term frequencies, sorted by term
 * @property {string} vid      sha256 (32 hex) of the text an embedder receives for it
 */

/**
 * The text that represents a section, for BM25 and for an embedder alike.
 * @param {string} content  the whole note
 * @param {{ path: string[], start: number, ownEnd: number }} section
 */
export function documentText(content, section) {
  return [...section.path.slice(0, -1), content.slice(section.start, section.ownEnd)].join('\n');
}

/**
 * The text sent to an embedder for a section (capped).
 * @param {string} content
 * @param {{ path: string[], start: number, ownEnd: number }} section
 */
export function embeddingText(content, section) {
  return documentText(content, section).slice(0, MAX_EMBED_CHARS);
}

/** @param {string} text */
const vidOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

/**
 * Every section of a note that has at least one searchable token.
 * @param {string} content
 * @returns {SectionDoc[]}
 */
export function sectionDocs(content) {
  const parsed = parseNote(content);
  /** @type {Array<{ key: string, path: string[], start: number, ownEnd: number, end: number }>} */
  const raw = [
    { key: '', path: [], start: parsed.preamble.start, ownEnd: parsed.preamble.ownEnd, end: parsed.preamble.ownEnd },
    ...parsed.sections.map((s) => ({ key: s.key, path: s.path, start: s.start, ownEnd: s.ownEnd, end: s.end })),
  ];
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {SectionDoc[]} */
  const out = [];
  for (const s of raw) {
    const occ = (seen.get(s.key) ?? 0) + 1;
    seen.set(s.key, occ);
    // The titles of the enclosing sections are context, not content: a section with no
    // words of its own would only echo its parent's title.
    if (termFrequencies(content.slice(s.start, s.ownEnd)).size === 0) continue;
    const tf = termFrequencies(documentText(content, s));
    let len = 0;
    for (const n of tf.values()) len += n;
    out.push({
      ...s,
      occ,
      len,
      tf: [...tf.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      vid: vidOf(embeddingText(content, s)),
    });
  }
  return out;
}

/**
 * @typedef {Object} LexicalDoc
 * @property {number} len
 * @property {Map<string, number>} tf
 */

/**
 * The highest BM25 score the query could reach in this collection: every distinct term at
 * its saturation, idf × (k1 + 1). A section never reaches it; it is the scale the query
 * lives on (a two-word question cannot score like a paragraph), used by hitPasses.
 * @param {LexicalDoc[]} docs
 * @param {string[]} queryTokens  tokenized query (repeated terms count once)
 * @param {{ k1?: number }} [params]  config ranking.k1 (default K1)
 * @returns {number}
 */
export function maxBM25(docs, queryTokens, { k1 = K1 } = {}) {
  const terms = [...new Set(queryTokens)];
  const n = docs.length;
  let ceiling = 0;
  for (const t of terms) {
    let df = 0;
    for (const d of docs) if (d.tf.has(t)) df++;
    // Same IDF as rankBM25, but a term no section has counts too: it is exactly what says
    // "this question is about something the notes do not cover".
    ceiling += Math.log(1 + (n - df + 0.5) / (df + 0.5)) * (k1 + 1);
  }
  return ceiling;
}

/**
 * Ranks documents with BM25 (k1 = 1.2, b = 0.75, idf = ln(1 + (N - df + 0.5) / (df + 0.5))).
 * Only documents that share at least one term with the query are returned.
 * @param {LexicalDoc[]} docs  the whole collection (N and the average length come from it)
 * @param {string[]} queryTokens  tokenized query (repeated terms count once)
 * @param {{ k1?: number, b?: number }} [params]  config ranking.k1 / ranking.b (defaults K1, B)
 * @returns {Array<{ i: number, score: number }>} best first; ties keep collection order
 */
export function rankBM25(docs, queryTokens, { k1 = K1, b = B } = {}) {
  const terms = [...new Set(queryTokens)];
  if (terms.length === 0 || docs.length === 0) return [];
  const n = docs.length;
  let total = 0;
  for (const d of docs) total += d.len;
  const avgdl = total / n || 1;
  /** @type {Map<string, number>} */
  const idf = new Map();
  for (const t of terms) {
    let df = 0;
    for (const d of docs) if (d.tf.has(t)) df++;
    if (df > 0) idf.set(t, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  if (idf.size === 0) return [];
  /** @type {Array<{ i: number, score: number }>} */
  const out = [];
  docs.forEach((d, i) => {
    let score = 0;
    for (const [t, w] of idf) {
      const f = d.tf.get(t);
      if (!f) continue;
      score += (w * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgdl));
    }
    if (score > 0) out.push({ i, score });
  });
  return out.sort((a, b) => b.score - a.score || a.i - b.i);
}
