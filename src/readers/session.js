// The session reader. A continuation ("go on", "you have my OK, carry on") carries its topic
// in the conversation, not in its words, so a search by text finds nothing for it. What a
// session was working on is already on disk: the notes it read (the Read hook appends them
// to run/reads/<session>.jsonl) and the ones it wrote (the ledger signs every write with its
// session). This reader returns those sections: the ones the query names first, then the
// most recent. It never looks at another session's reads or writes.
//
// `search` owns the hit shape (text, stale marks, follow) and calls `sessionSections` when
// it answers with this reader; `sessionHits` goes through `search` for the same reason. The
// two modules import each other, and each only calls the other at run time.

import fs from 'node:fs';
import path from 'node:path';
import { safeFileName } from '../leases.js';
import { readLedger } from '../ledger.js';
import { resolveInRoot } from '../paths.js';
import { search } from '../search.js';
import { rankBM25 } from './lexical.js';

/** @typedef {import('../types.js').Root} Root */
/** @typedef {import('../types.js').SearchHit} SearchHit */
/** @typedef {import('./index.js').Snapshot} Snapshot */
/** @typedef {import('./lexical.js').SectionDoc} SectionDoc */

/**
 * How many distinct notes of a session are candidates, most recent first. On real
 * continuations the note the person meant was among the last 5 the session touched in 5 of
 * 11 cases; 20 is four times that window, so a longer stretch of work still fits, while the
 * list stays about what the session is doing now and not everything it opened that day.
 * It also bounds the work: however long the session ran, only these notes are ranked.
 */
export const SESSION_NOTES = 20;

/**
 * One thing a session did to a note.
 * @typedef {Object} SessionTouch
 * @property {string} rel
 * @property {string} ts     ISO, as recorded
 * @property {'read'|'write'} kind
 * @property {string[]} keys  the sections a write changed (the ledger's `changed`); [] for a read
 */

/** @typedef {SessionTouch & { t: number }} TimedTouch */

/** @param {unknown} session */
function checkSession(session) {
  if (typeof session !== 'string' || session.trim() === '') throw new TypeError('a session id is needed');
}

/**
 * @param {unknown} when
 * @param {string} name
 * @returns {number} epoch ms
 */
function epochOf(when, name) {
  if (!(when instanceof Date) || Number.isNaN(when.getTime())) throw new TypeError(`${name} must be a valid Date`);
  return when.getTime();
}

/**
 * The reads of `session` in one root, as the Read hook recorded them. A torn or garbled line
 * is skipped: the file is appended by parallel hooks and a crash can leave half a line.
 * @param {Root} root
 * @param {string} session
 * @returns {TimedTouch[]}  in file order
 */
function readsOf(root, session) {
  const file = path.join(root.stateDir, 'run', 'reads', `${safeFileName(session)}.jsonl`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  /** @type {TimedTouch[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      continue; // a torn line, see the doc comment
    }
    const r = /** @type {{ rel?: unknown, ts?: unknown }} */ (x);
    if (typeof r?.rel !== 'string' || r.rel === '' || typeof r.ts !== 'string') continue;
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) continue;
    out.push({ rel: r.rel, ts: r.ts, kind: 'read', keys: [], t });
  }
  return out;
}

/**
 * Everything `session` read or wrote in one root up to `cutoff` (inclusive: the eval asks
 * "as of the moment of the prompt"), newest first. One pass over the ledger and one over the
 * session's reads, whatever the number of notes. Whether the notes still exist is not
 * checked here.
 * @param {Root} root
 * @param {string} session
 * @param {number} cutoff  epoch ms
 * @returns {TimedTouch[]}
 */
function touchesOf(root, session, cutoff) {
  /** @type {TimedTouch[]} */
  const out = [];
  for (const e of readLedger(root).entries) {
    if (e.author.session !== session) continue;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t) || t > cutoff) continue;
    out.push({ rel: e.rel, ts: e.ts, kind: 'write', keys: [...e.changed], t });
  }
  for (const r of readsOf(root, session)) if (r.t <= cutoff) out.push(r);
  // Newest first; at the same instant a write before a read (it says more about the work),
  // and otherwise the later line first. `sort` is stable, so reversing first keeps that.
  return out.reverse().sort((a, b) => b.t - a.t || (a.kind === b.kind ? 0 : a.kind === 'write' ? -1 : 1));
}

/**
 * Whether `rel` is still a note of the root: inside it, with a note extension, on disk.
 * @param {Root} root
 * @param {string} rel
 */
function isNoteNow(root, rel) {
  const extensions = root.config.extensions.map((x) => x.toLowerCase());
  if (!extensions.includes(path.extname(rel).toLowerCase())) return false;
  try {
    return fs.statSync(resolveInRoot(root, rel).abs).isFile();
  } catch {
    return false; // escapes the root, points into the state directory, or is gone: not a note now
  }
}

/**
 * What `session` read or wrote in `root` before `before` (default: now), newest first.
 * `keys` are the sections a write changed; a read has none. A session that touched nothing
 * gives []. Lines that cannot be read and notes that no longer exist are skipped.
 * @param {Root} root
 * @param {string} session
 * @param {{ before?: Date }} [options]
 * @returns {SessionTouch[]}
 */
export function sessionTouches(root, session, { before = new Date() } = {}) {
  checkSession(session);
  const cutoff = epochOf(before, 'before');
  /** @type {Map<string, boolean>} */
  const exists = new Map();
  /** @type {SessionTouch[]} */
  const out = [];
  for (const { rel, ts, kind, keys } of touchesOf(root, session, cutoff)) {
    let ok = exists.get(rel);
    if (ok === undefined) exists.set(rel, (ok = isNoteNow(root, rel)));
    if (ok) out.push({ rel, ts, kind, keys });
  }
  return out;
}

/**
 * The sessions that have reads recorded in `root`, by their file names. An id that is not
 * safe as a file name is stored under its hash, which is not an id: those are left out
 * (they can still be given in full).
 * @param {Root} root
 * @returns {string[]}
 */
export function sessionsWithReads(root) {
  let names;
  try {
    names = fs.readdirSync(path.join(root.stateDir, 'run', 'reads'));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => n.slice(0, -'.jsonl'.length))
    .filter((id) => id !== '' && safeFileName(id) === id && !/^[0-9a-f]{64}$/.test(id));
}

/**
 * A section of what the session was working on, ready for `search` to turn into a hit.
 * @typedef {Object} SessionSection
 * @property {number} snap        index of the root's snapshot
 * @property {string} rel
 * @property {SectionDoc} section
 * @property {number} score       its BM25 against the query among these sections (0: the query does not name it)
 */

/**
 * The sections of the notes `session` was working on, in the order the session reader
 * returns them:
 *   - candidates: the SESSION_NOTES most recent distinct notes it touched up to `now`, in
 *     every root, that are still indexed and pass `keep`; of each, the sections it wrote,
 *     or every section when it only read the note (or none of the written ones is left);
 *   - the notes: with `notesBy: 'recent'`, by their last touch, newest first; with 'named',
 *     first the ones with a section the query names (best BM25 first), then the rest by
 *     their last touch. The search's fallback asks for 'recent': the query already found
 *     nothing in the whole root, and on real continuations trusting its words again lost
 *     to plain recency (their words hook unrelated sections);
 *   - inside a note: the sections the query names (best first), then the most recently
 *     written, then document order for a note it only read;
 *   - one note per slot: the first section of every note, then the second of every note,
 *     and so on, so a note with many sections does not take every slot.
 * BM25 is computed over these sections only: the question is which of them the query
 * names, not how rare its words are in the whole root.
 * @param {Snapshot[]} snapshots  a fresh index of each root
 * @param {string[]} queryTokens
 * @param {{ session: string, now: Date, keep?: (rel: string) => boolean, k1: number, b: number, notesBy?: 'recent'|'named' }} options
 * @returns {SessionSection[]}
 */
export function sessionSections(snapshots, queryTokens, { session, now, keep = () => true, k1, b, notesBy = 'named' }) {
  checkSession(session);
  const cutoff = epochOf(now, 'now');
  /** @type {Array<TimedTouch & { snap: number }>} */
  const touches = [];
  snapshots.forEach((snapshot, snap) => {
    for (const t of touchesOf(snapshot.root, session, cutoff)) touches.push({ ...t, snap });
  });
  touches.sort((a, b) => b.t - a.t); // stable: inside one root, touchesOf's order holds

  // `written`: each key the session wrote in the note, with the position of its latest write
  // in `touches` (0 = newest). A position, not a time: two writes in the same millisecond
  // still keep their order.
  /** @type {Map<string, { snap: number, rel: string, written: Map<string, number> }>} */
  const notes = new Map();
  touches.forEach((touch, position) => {
    const id = `${touch.snap}\n${touch.rel}`;
    let note = notes.get(id);
    if (!note) {
      if (notes.size >= SESSION_NOTES) return; // older writes of a chosen note still count below
      // Gone, ignored, too large to index, nothing searchable, or out of scope: not a candidate.
      if (!snapshots[touch.snap].notes.get(touch.rel)?.sections.length || !keep(touch.rel)) return;
      note = { snap: touch.snap, rel: touch.rel, written: new Map() };
      notes.set(id, note);
    }
    // Newest first, so the first time a key shows up is its latest write.
    for (const key of touch.keys) if (!note.written.has(key)) note.written.set(key, position);
  });

  /** Each candidate note, newest touch first, with its sections in the order written/read. */
  /** @type {SessionSection[][]} */
  const perNote = [];
  for (const { snap, rel, written } of notes.values()) {
    const sections = snapshots[snap].notes.get(rel)?.sections ?? [];
    const mine = sections
      .map((section, i) => ({ section, i, position: written.get(section.key) ?? -1 }))
      .filter((x) => x.position >= 0)
      .sort((a, b) => a.position - b.position || a.i - b.i)
      .map((x) => x.section);
    perNote.push((mine.length ? mine : sections).map((section) => ({ snap, rel, section, score: 0 })));
  }

  const flat = perNote.flat();
  const docs = flat.map((x) => ({ len: x.section.len, tf: new Map(x.section.tf) }));
  for (const { i, score } of rankBM25(docs, queryTokens, { k1, b })) flat[i].score = score;
  // `sort` is stable: sections the query does not name keep their order, and so do notes.
  for (const list of perNote) list.sort((x, y) => y.score - x.score);
  const best = (/** @type {SessionSection[]} */ list) => list[0]?.score ?? 0;
  const order = notesBy === 'named' ? [...perNote].sort((x, y) => best(y) - best(x)) : perNote;

  /** @type {SessionSection[]} */
  const out = [];
  for (let round = 0; out.length < flat.length; round++) for (const list of order) if (round < list.length) out.push(list[round]);
  return out;
}

/**
 * What `session` was working on, as search hits (`via: 'session'`), for `query`: the
 * sections the query names first, then the most recent. Only what the session touched up
 * to `now` counts, so an eval can ask as of the moment of a past prompt.
 * @param {Root[]} roots
 * @param {string} query
 * @param {{ session: string, k?: number, now?: Date, scope?: string[] }} options
 * @returns {Promise<SearchHit[]>}
 */
export async function sessionHits(roots, query, { session, k, now, scope }) {
  checkSession(session);
  return (await search(roots, query, { reader: 'session', session, k, now, scope })).hits;
}
