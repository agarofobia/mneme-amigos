// Retrieval eval: does the reader find what it has to find, and bring nothing for a query
// that is about nothing in the notes? Three kinds of checks, counted separately:
//
//   note     `want`: one of the top-k hits is in a note whose path contains one of the strings
//   section  `wantText`: one of the top-k hits (in a wanted note, when `want` is given)
//            contains that text (case- and whitespace-insensitive), outside `<!-- … -->`
//            comments: a stale marker that names the right section is not the section
//   none     `none: true`: the search returns no hit at all
//
// A superseded hit that brings its current section (`follow`) passes a note or section check
// when that current section does: what counts is that it reached the reader.
//
// A case with `session` and `ts` asks as that session did at that moment: when the search
// finds nothing, what the session had read or written by then answers, as it would have live.

import { defaultReader, search } from './search.js';

/** @typedef {import('./types.js').Root} Root */
/** @typedef {import('./types.js').Embedder} Embedder */
/** @typedef {import('./types.js').SearchHit} SearchHit */

/**
 * @typedef {Object} EvalCase
 * @property {string} query
 * @property {string[]} [want]     substrings of rel; any one is enough
 * @property {string} [wantText]   text the right section contains
 * @property {true} [none]         the query must return nothing
 * @property {'dev'|'holdout'} [split]  dev cases tune the knobs; holdout cases only measure (default: dev)
 * @property {string} [session]    the session that asked: when the search finds nothing, what it was working on answers
 * @property {string} [ts]         when it asked (ISO): the search runs as of that moment, so only what the session
 *   had read or written by then counts, as it would have live
 */

/**
 * @typedef {{ note: { hit: number, total: number }, section: { hit: number, total: number }, none: { hit: number, total: number } }} EvalCounts
 */

/**
 * @typedef {Object} EvalFailure
 * @property {number} index        position of the case
 * @property {string} query
 * @property {'note'|'section'|'none'} kind
 * @property {string} expected
 * @property {Array<{ root: string, rel: string, key: string, score: number }>} got
 */

/**
 * @typedef {Object} EvalReport
 * @property {{ hit: number, total: number }} note
 * @property {{ hit: number, total: number }} section
 * @property {{ hit: number, total: number }} none
 * @property {EvalFailure[]} failures
 * @property {{ dev: EvalCounts, holdout: EvalCounts }} bySplit  the holdout numbers are the honest ones
 * @property {Array<{ index: number, query: string, split: 'dev'|'holdout', pass: boolean, got: EvalFailure['got'] }>} results  one line per case, to commit next to the cases
 * @property {'hybrid'|'lexical'} reader
 * @property {string} [degraded]   some searches fell back to lexical only: the numbers are lexical
 */

/** @param {string} text */
const loose = (text) => text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** @param {string} text  without its HTML comments, where the stale markers live (a clipped text can end inside one) */
const prose = (text) => text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!--[\s\S]*$/, ' ');

/**
 * @param {unknown} c
 * @param {number} index
 * @returns {EvalCase}
 */
function checkCase(c, index) {
  const where = `eval case #${index + 1}`;
  if (!c || typeof c !== 'object') throw new TypeError(`${where} must be an object`);
  const x = /** @type {Record<string, unknown>} */ (c);
  if (typeof x.query !== 'string' || x.query.trim() === '') throw new TypeError(`${where} needs a non-empty "query"`);
  if (x.want !== undefined && (!Array.isArray(x.want) || x.want.length === 0 || x.want.some((w) => typeof w !== 'string' || w === ''))) {
    throw new TypeError(`${where}: "want" must be a non-empty list of non-empty strings`);
  }
  if (x.wantText !== undefined && (typeof x.wantText !== 'string' || x.wantText.trim() === '')) {
    throw new TypeError(`${where}: "wantText" must be a non-empty string`);
  }
  if (x.none !== undefined && x.none !== true) throw new TypeError(`${where}: "none" can only be true`);
  if (x.split !== undefined && x.split !== 'dev' && x.split !== 'holdout') throw new TypeError(`${where}: "split" must be "dev" or "holdout"`);
  if (x.session !== undefined && (typeof x.session !== 'string' || x.session.trim() === '')) throw new TypeError(`${where}: "session" must be a non-empty session id`);
  if (x.ts !== undefined && (typeof x.ts !== 'string' || Number.isNaN(Date.parse(x.ts)))) throw new TypeError(`${where}: "ts" must be an ISO date and time`);
  if (x.none && (x.want || x.wantText)) throw new TypeError(`${where}: "none" cannot be combined with "want" or "wantText"`);
  if (!x.none && !x.want && !x.wantText) throw new TypeError(`${where} says nothing to check: give "want", "wantText" or "none"`);
  return /** @type {EvalCase} */ (x);
}

/** @param {SearchHit[]} hits */
const summary = (hits) => hits.map((h) => ({ root: h.root, rel: h.rel, key: h.section.key, score: h.score }));

/**
 * Runs every case against the roots and counts hits per kind of check.
 * @param {Root[]} roots
 * @param {unknown[]} cases
 * @param {{ k?: number, reader?: 'hybrid'|'lexical', now?: Date, embedder?: Embedder }} [options]
 * @returns {Promise<EvalReport>}
 */
export async function runEval(roots, cases, options = {}) {
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('eval needs at least one root');
  if (!Array.isArray(cases)) throw new TypeError('eval cases must be a list');
  const checked = cases.map(checkCase);
  const reader = options.reader ?? defaultReader(roots, options.embedder);
  /** @returns {EvalCounts} */
  const counts = () => ({ note: { hit: 0, total: 0 }, section: { hit: 0, total: 0 }, none: { hit: 0, total: 0 } });
  /** @type {EvalReport} */
  const report = { ...counts(), failures: [], reader, bySplit: { dev: counts(), holdout: counts() }, results: [] };
  /** @type {string[]} */
  const degraded = [];
  for (let index = 0; index < checked.length; index++) {
    const c = checked[index];
    const now = c.ts !== undefined ? new Date(c.ts) : options.now;
    const result = await search(roots, c.query, { k: options.k, reader, now, embedder: options.embedder, ...(c.session !== undefined ? { session: c.session } : {}) });
    if (result.degraded) degraded.push(result.degraded);
    const { hits } = result;
    /** What each hit puts in front of the reader: itself, and its current section if it brings one. */
    const shown = hits.flatMap((h) => (h.follow ? [h, h.follow] : [h]));
    const inWanted = (/** @type {{ rel: string }} */ h) => !c.want || c.want.some((w) => h.rel.includes(w));
    const split = c.split ?? 'dev';
    let pass = true;
    /**
     * @param {'note'|'section'|'none'} kind
     * @param {boolean} ok
     * @param {string} expected
     */
    const count = (kind, ok, expected) => {
      report[kind].total++;
      report.bySplit[split][kind].total++;
      if (ok) {
        report[kind].hit++;
        report.bySplit[split][kind].hit++;
      } else {
        pass = false;
        report.failures.push({ index, query: c.query, kind, expected, got: summary(hits) });
      }
    };
    if (c.none) count('none', hits.length === 0, 'no hits');
    if (c.want) count('note', shown.some(inWanted), `a hit in a note matching ${c.want.map((w) => `"${w}"`).join(' or ')}`);
    if (c.wantText) {
      const text = loose(c.wantText);
      count('section', shown.some((h) => inWanted(h) && loose(prose(h.text)).includes(text)), `a hit whose text contains "${c.wantText}"`);
    }
    report.results.push({ index, query: c.query, split, pass, got: summary(hits) });
  }
  if (degraded.length) report.degraded = `${degraded.length} of ${checked.length} searches were lexical only: ${degraded[0]}`;
  return report;
}
