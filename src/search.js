// Search over one or more governed roots (D-P5). Every reader returns the same hit shape
// (`SearchHit`), so a caller never needs to know which one answered. Stale notes and
// sections come out marked (CA-5). The index is brought up to date first (incremental).
// A superseded hit also brings the section that replaced it (`follow`), unless the root
// says `search.stale: "mark"`. With a `session`, a search that finds nothing answers with
// what that session was working on (`via: 'session'`, src/readers/session.js).

import { findLinks, resolveTarget } from './links.js';
import { hybridRank } from './readers/hybrid.js';
import { refreshIndex } from './readers/index.js';
import { maxBM25, rankBM25 } from './readers/lexical.js';
import { sessionSections } from './readers/session.js';
import { markerScope, staleness, supersededLink } from './readers/stale.js';
import { tokenize } from './readers/tokenize.js';
import { parseNote } from './sections.js';

/** @typedef {import('./types.js').Root} Root */
/** @typedef {import('./types.js').SearchHit} SearchHit */
/** @typedef {import('./types.js').SearchFollow} SearchFollow */
/** @typedef {import('./types.js').Embedder} Embedder */
/** @typedef {import('./types.js').ParsedNote} ParsedNote */
/** @typedef {import('./readers/lexical.js').SectionDoc} SectionDoc */
/** @typedef {import('./readers/index.js').Snapshot} Snapshot */
/** @typedef {import('./readers/hybrid.js').CandidateDoc} CandidateDoc */

/** Longest `text` of a hit, in characters. */
export const MAX_HIT_CHARS = 1200;

/**
 * @typedef {Object} SearchOptions
 * @property {number} [k]          hits to return (default: `search.k` of the first root)
 * @property {'hybrid'|'lexical'|'session'} [reader]  default: hybrid when an embedder is given or configured;
 *   "session": only what `session` was working on
 * @property {Date} [now]          what "today" is for staleness (only its UTC day counts); for the
 *   session reader, also the moment up to which the session's reads and writes count
 * @property {Embedder} [embedder] used instead of the configured one, for every root
 * @property {string[]} [scope]    only notes under these relative folders (or exactly these notes), in every root
 * @property {string} [session]    a session id: when the search finds nothing, it answers with what
 *   that session was working on. Without it, the result is exactly what it was before sessions.
 */

/**
 * @typedef {Object} SearchResult
 * @property {SearchHit[]} hits
 * @property {string} [degraded]   the hybrid reader fell back to lexical only; says why
 * @property {string[]} [warnings] notes skipped or unreadable, index files not saved
 */

/**
 * The reader used when the caller does not choose one.
 * @param {Root[]} roots
 * @param {Embedder} [embedder]
 * @returns {'hybrid'|'lexical'}
 */
export function defaultReader(roots, embedder) {
  return embedder || roots.some((r) => r.config.embeddings.provider !== 'none') ? 'hybrid' : 'lexical';
}

/** Term frequencies as Maps, built once per indexed section object. */
/** @type {WeakMap<SectionDoc, Map<string, number>>} */
const tfMaps = new WeakMap();

/** @param {SectionDoc} section */
function tfOf(section) {
  let tf = tfMaps.get(section);
  if (!tf) {
    tf = new Map(section.tf);
    tfMaps.set(section, tf);
  }
  return tf;
}

/**
 * `text` cut to `max` characters, never splitting a surrogate pair.
 * @param {string} text
 * @param {number} max
 */
function clip(text, max) {
  if (text.length <= max) return text;
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}

/**
 * The absolute signals of one ranked section. The RRF score of the hybrid reader only knows
 * ranks, so it orders the hits but cannot say whether any of them is relevant: these can.
 * @typedef {Object} HitSignals
 * @property {number} lexical      the section's raw BM25 for the query (0: only the semantic side found it)
 * @property {number|null} cosine  its cosine with the query (null: lexical reader, or hybrid degraded)
 * @property {number} ceiling      the highest BM25 the query could reach (maxBM25): its scale
 */

/**
 * The only definition of "this hit is worth returning" (contract §4.12). It decides whether
 * a query about something the notes do not cover comes back empty instead of with the
 * closest noise.
 *
 * Measured on a real vault (79 queries, 24/09): raw BM25 separates relevant from unrelated
 * (relevant ≥ 15.4, unrelated ≤ 12.3); the cosine overlaps (an unrelated query reached 0.737,
 * a relevant hit 0.717); a hit only the semantic side found has `lexical` 0. But a fixed
 * floor is unreachable for a short question: "what is Mneme" can score at most 10.6 there,
 * so a 12.5 floor lost the answer to 9 of 12 short questions (most had it first). Hence the floor
 * is capped at `minLexicalRatio` of the query's own ceiling. Unrelated questions carry
 * terms the notes lack, which lifts their ceiling (25-71 against 10-23), so the cap does
 * not let them in.
 *
 * Must hold: with the defaults (`minLexical` 0) every hit passes, so an uncalibrated root
 * behaves exactly as before.
 *
 * @param {HitSignals} signals
 * @param {{ minLexical: number, minLexicalRatio: number, minCosine: number }} floors
 * @returns {boolean}
 */
export function hitPasses({ lexical, cosine, ceiling }, { minLexical, minLexicalRatio, minCosine }) {
  if (minLexical === 0) return true; // off: an uncalibrated root passes everything
  // Either signal is enough (product decision, 24/09): the lexical floor decides almost every case, and the
  // cosine keeps the semantic side useful for a query that uses other words than the note.
  // `lexical > 0`: a query of stopwords only has ceiling 0, and a floor of 0 would let every
  // semantic neighbour through; there, only the cosine can decide.
  if (lexical > 0 && lexical >= Math.min(minLexical, minLexicalRatio * ceiling)) return true;
  return cosine !== null && cosine >= minCosine;
}

/**
 * Scope entries as clean relative prefixes; `undefined` or an empty list means everywhere.
 * @param {unknown} scope
 * @returns {string[]|null}
 */
function normalizeScope(scope) {
  if (scope === undefined) return null;
  if (!Array.isArray(scope) || scope.some((s) => typeof s !== 'string')) throw new TypeError('scope must be a list of relative paths');
  const clean = scope
    .map((s) => s.replace(/\\/g, '/').normalize('NFC').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
  if (clean.some((s) => s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..'))) {
    throw new RangeError('scope entries must be relative paths inside the root');
  }
  return clean.length ? clean : null;
}

/**
 * @param {string} rel
 * @param {string[]} scope
 */
const inScope = (rel, scope) => scope.some((p) => rel === p || rel.startsWith(`${p}/`));

/**
 * What a superseded mark points to: a wiki link (`[[note#Heading|alias]]`, brackets optional),
 * a relative markdown link, or a path. Null for a web address or anything that names no note.
 * @param {string} raw
 * @returns {{ target: string, heading?: string, kind: 'wiki'|'md' } | null}
 */
function readLink(raw) {
  const text = raw.trim();
  if (text === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  // Without brackets it is read as the inside of a wiki link, with the same rules.
  const link = findLinks(text)[0] ?? findLinks(`[[${text}]]`)[0];
  if (!link) return null;
  let heading = link.heading;
  if (heading !== undefined && link.kind === 'md') {
    try {
      heading = decodeURIComponent(heading);
    } catch {
      // a stray `%`: the anchor is taken as written
    }
  }
  return { target: link.target, kind: link.kind, ...(heading !== undefined ? { heading } : {}) };
}

/** @param {string} s */
const headingKey = (s) => s.normalize('NFC').trim().toLowerCase();

/**
 * The first section a link heading names, case-insensitive. `A#B` names a `B` inside an `A`.
 * @param {ParsedNote} parsed
 * @param {string|undefined} heading
 * @returns {number} its index, or -1: no heading given, or none by that name
 */
function sectionNamed(parsed, heading) {
  const want = (heading ?? '').split('#').map(headingKey).filter(Boolean);
  if (!want.length) return -1;
  return parsed.sections.findIndex(
    (s) => s.path.length >= want.length && want.every((w, j) => headingKey(s.path[s.path.length - want.length + j]) === w),
  );
}

/**
 * What one search already has at hand, so following several superseded hits reads nothing
 * twice: the note list and contents of the index snapshot, and the notes parsed so far.
 * @typedef {Object} FollowContext
 * @property {(snap: number) => Root} root
 * @property {(snap: number) => string[]} notes
 * @property {(snap: number, rel: string) => { content: string, parsed: ParsedNote } | null} note
 * @property {Date} now
 */

/**
 * The section a superseded hit's link leads to, inside the hit's own root. One hop: when the
 * current one is stale too, that is said in `stale` and not followed.
 * @param {string} link  as the mark wrote it
 * @param {Root} root
 * @param {number} snap  the root's snapshot in this search
 * @param {string} fromRel  the note that holds the link
 * @param {FollowContext} ctx
 * @returns {SearchFollow|null}  null: the link leads to no readable note of this root
 */
function followLink(link, root, snap, fromRel, ctx) {
  const parsedLink = readLink(link);
  if (!parsedLink) return null;
  const rel = resolveTarget(root, fromRel, parsedLink.target, { kind: parsedLink.kind, notes: ctx.notes(snap) });
  if (rel === null) return null;
  const found = ctx.note(snap, rel);
  if (!found) return null;
  const { content, parsed } = found;
  const index = sectionNamed(parsed, parsedLink.heading);
  const s = index >= 0 ? parsed.sections[index] : null;
  const text = s ? content.slice(s.start, s.end) : content.slice(parsed.frontmatter.end);
  const stale = staleness(parsed, markerScope(content, parsed, index), ctx.now, root.config.metadataAliases);
  return {
    rel,
    section: s ? { path: [...s.path], key: s.key, start: s.start, end: s.end } : null,
    text: clip(text.trim(), MAX_HIT_CHARS),
    ...(stale ? { stale } : {}),
  };
}

/**
 * @param {unknown} roots
 * @returns {Root[]}
 */
function checkRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('search needs at least one root');
  /** @type {Map<string, Root>} */
  const byDir = new Map();
  for (const root of roots) {
    const r = /** @type {Root} */ (root);
    if (!r || typeof r.dir !== 'string' || !r.config) throw new TypeError('every root must come from openRoot() or findRoot()');
    if (!byDir.has(r.dir)) byDir.set(r.dir, r);
  }
  return [...byDir.values()];
}

/**
 * Searches every root at once and returns the best `k` sections. With a `session`, a search
 * that returns nothing answers with what that session was working on instead (every hit
 * `via: 'session'`), and never with another session's notes.
 * @param {Root[]} roots
 * @param {string} query
 * @param {SearchOptions} [options]
 * @returns {Promise<SearchResult>}
 */
export async function search(roots, query, options = {}) {
  const list = checkRoots(roots);
  if (typeof query !== 'string') throw new TypeError('query must be a string');
  const k = options.k ?? list[0].config.search.k;
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer (got ${k})`);
  const reader = options.reader ?? defaultReader(list, options.embedder);
  if (reader !== 'hybrid' && reader !== 'lexical' && reader !== 'session') {
    throw new RangeError(`reader must be "hybrid", "lexical" or "session" (got ${reader})`);
  }
  const { session } = options;
  if (session !== undefined && (typeof session !== 'string' || session.trim() === '')) throw new TypeError('session must be a non-empty session id');
  if (reader === 'session' && session === undefined) throw new TypeError('the session reader needs a session');
  const now = options.now ?? new Date();

  const scope = normalizeScope(options.scope);
  const snapshots = list.map((root) => refreshIndex(root));
  const warnings = [...new Set(snapshots.flatMap((s) => s.warnings))];
  const extra = warnings.length ? { warnings } : {};
  if (query.trim() === '' && session === undefined) return { hits: [], ...extra };

  const ctx = followContext(snapshots, now);
  const queryTokens = tokenize(query);
  const { k1, b, rrfK } = list[0].config.ranking;
  /** @type {SearchHit[]} */
  let hits = [];
  /** @type {string|undefined} */
  let degraded;
  if (reader !== 'session' && query.trim() !== '') {
    const found = await rankedHits({ snapshots, scope, query, queryTokens, reader, k, embedder: options.embedder, rrfK, k1, b, ctx });
    hits = found.hits;
    degraded = found.degraded;
  }
  // Never mixed: the session's notes come only when the search itself brought nothing. Asked
  // for by name, the query orders the session's notes; as a fallback, their recency does.
  if (session !== undefined && hits.length === 0) {
    hits = sessionReaderHits({ snapshots, scope, queryTokens, session, now, k, k1, b, ctx, notesBy: reader === 'session' ? 'named' : 'recent' });
  }
  return { hits, ...(degraded ? { degraded } : {}), ...extra };
}

/**
 * What one search has at hand to build hits and follow superseded ones.
 * @param {Snapshot[]} snapshots
 * @param {Date} now
 * @returns {FollowContext}
 */
function followContext(snapshots, now) {
  /** @type {Map<string, ParsedNote>} */
  const parsedCache = new Map();
  /** @type {Map<number, string[]>} */
  const noteLists = new Map();
  return {
    now,
    root: (snap) => snapshots[snap].root,
    notes: (snap) => {
      let rels = noteLists.get(snap);
      if (!rels) {
        rels = [...snapshots[snap].notes.keys()];
        noteLists.set(snap, rels);
      }
      return rels;
    },
    note: (snap, rel) => {
      const content = snapshots[snap].contents.get(rel);
      if (content === undefined) return null;
      const cacheKey = `${snap}\n${rel}`;
      let parsed = parsedCache.get(cacheKey);
      if (!parsed) {
        parsed = parseNote(content);
        parsedCache.set(cacheKey, parsed);
      }
      return { content, parsed };
    },
  };
}

/**
 * The hybrid or lexical reader: the best `k` sections that pass the root's floor.
 * @param {{ snapshots: Snapshot[], scope: string[]|null, query: string, queryTokens: string[], reader: 'hybrid'|'lexical',
 *   k: number, embedder?: Embedder, rrfK: number, k1: number, b: number, ctx: FollowContext }} input
 * @returns {Promise<{ hits: SearchHit[], degraded?: string }>}
 */
async function rankedHits({ snapshots, scope, query, queryTokens, reader, k, embedder, rrfK, k1, b, ctx }) {
  /** @type {CandidateDoc[]} */
  const docs = [];
  snapshots.forEach((snapshot, snap) => {
    for (const [rel, entry] of snapshot.notes) {
      if (scope && !inScope(rel, scope)) continue;
      for (const section of entry.sections) docs.push({ snap, rel, section });
    }
  });
  const lexicalDocs = docs.map((d) => ({ len: d.section.len, tf: tfOf(d.section) }));
  const lexical = rankBM25(lexicalDocs, queryTokens, { k1, b });

  /** @type {Map<number, number>} */
  const lexicalScore = new Map(lexical.map((h) => [h.i, h.score]));
  const ceiling = maxBM25(lexicalDocs, queryTokens, { k1 });

  /** @type {Array<{ i: number, score: number, cos?: number }>} */
  let ranked = lexical;
  /** @type {string|undefined} */
  let degraded;
  if (reader === 'hybrid') {
    const fused = await hybridRank({ snapshots, docs, query, lexical, pool: Math.max(20, k * 4), embedder, rrfK });
    ranked = fused.ranked;
    degraded = fused.degraded;
  }

  /** @type {SearchHit[]} */
  const hits = [];
  for (const { i, score, cos } of ranked) {
    if (hits.length >= k) break;
    const doc = docs[i];
    if (!hitPasses({ lexical: lexicalScore.get(i) ?? 0, cosine: cos ?? null, ceiling }, ctx.root(doc.snap).config.search)) continue;
    const hit = toHit(doc.snap, doc.rel, doc.section, score, ctx);
    if (hit) hits.push(hit);
  }
  return { hits, ...(degraded ? { degraded } : {}) };
}

/**
 * What `session` was working on, as up to `k` hits (`via: 'session'`).
 * @param {{ snapshots: Snapshot[], scope: string[]|null, queryTokens: string[], session: string, now: Date,
 *   k: number, k1: number, b: number, ctx: FollowContext, notesBy: 'recent'|'named' }} input
 * @returns {SearchHit[]}
 */
function sessionReaderHits({ snapshots, scope, queryTokens, session, now, k, k1, b, ctx, notesBy }) {
  const keep = scope ? (/** @type {string} */ rel) => inScope(rel, scope) : undefined;
  /** @type {SearchHit[]} */
  const hits = [];
  for (const { snap, rel, section, score } of sessionSections(snapshots, queryTokens, { session, now, keep, k1, b, notesBy })) {
    if (hits.length >= k) break;
    const hit = toHit(snap, rel, section, score, ctx);
    if (hit) hits.push({ ...hit, via: 'session' });
  }
  return hits;
}

/**
 * One indexed section as a hit: its own text, its STALE mark and, when it was superseded and
 * the root follows, the section that replaced it.
 * @param {number} snap
 * @param {string} rel
 * @param {SectionDoc} s
 * @param {number} score
 * @param {FollowContext} ctx
 * @returns {SearchHit|null}  null: the note's text is not at hand in this search
 */
function toHit(snap, rel, s, score, ctx) {
  const found = ctx.note(snap, rel);
  if (!found) return null;
  const root = ctx.root(snap);
  const { content, parsed } = found;
  const index = s.key === '' ? -1 : parsed.sections.findIndex((x) => x.start === s.start);
  const stale = staleness(parsed, markerScope(content, parsed, index), ctx.now, root.config.metadataAliases);
  /** @type {SearchHit} */
  const hit = {
    root: root.dir,
    rel,
    section: { path: [...s.path], key: s.key, start: s.start, end: s.end },
    score,
    text: clip(content.slice(s.start, s.ownEnd).trim(), MAX_HIT_CHARS),
    ...(stale ? { stale } : {}),
  };
  // The current section rides along with the superseded hit: it takes no place in `k`
  // and moves nothing. A link that leads nowhere leaves the mark alone.
  const link = root.config.search.stale === 'follow' ? supersededLink(stale) : null;
  const follow = link === null ? null : followLink(link, root, snap, rel, ctx);
  if (follow) hit.follow = follow;
  return hit;
}

/**
 * One hit as a line of text, with its marks: `[STALE: …]` after stale sections.
 * @param {SearchHit} hit
 */
export function formatHit(hit) {
  return location(hit.rel, hit.section, hit.stale);
}

/**
 * Where a hit or its current section is, with its STALE mark.
 * @param {string} rel
 * @param {{ path: string[] } | null} section
 * @param {{ reason: string }} [stale]
 */
function location(rel, section, stale) {
  const where = section && section.path.length ? ` > ${section.path.join(' > ')}` : '';
  return `${rel}${where}${stale ? ` [STALE: ${stale.reason}]` : ''}`;
}

/**
 * The line that says where the current version of a superseded hit is:
 * `→ current: <rel> > <heading path>`, or null when the hit brings none.
 * @param {SearchHit} hit
 * @returns {string|null}
 */
export function formatFollow(hit) {
  return hit.follow ? `→ current: ${location(hit.follow.rel, hit.follow.section, hit.follow.stale)}` : null;
}

/**
 * The first line a human reader shows when the hybrid reader fell back to lexical
 * (docs/diseno/02-mapa.md §④): `(lexical only: embeddings unavailable: <reason>)`.
 * @param {SearchResult} result
 * @returns {string|null}
 */
export function degradedLine(result) {
  return result.degraded ? `(lexical only: ${result.degraded})` : null;
}

/**
 * The first line a human reader shows when the hits are what a session was working on
 * rather than matches for the query: `(from what this session was working on)`.
 * @param {SearchResult} result
 * @returns {string|null}
 */
export function sessionLine(result) {
  return result.hits.length > 0 && result.hits.every((h) => h.via === 'session') ? '(from what this session was working on)' : null;
}
