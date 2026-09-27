// CAG reader: one fixed text of a root, meant to sit in a prompt cache.
//
// Layout: every pinned note in full (by path), then an index of one line per note (by
// path): `- <rel> — <first heading or first line>` with `[STALE: …]` marks. When it does
// not fit the budget it is cut and ends with `… <n> notes omitted (budget <b> bytes)`.
//
// Deterministic: the same content and the same UTC day of `now` give the same bytes. The
// time of day never enters (staleness only changes once a day, when something expires).

import fs from 'node:fs';
import path from 'node:path';
import { listNotes } from '../root.js';
import { parseNote } from '../sections.js';
import { MAX_NOTE_BYTES } from './index.js';
import { isPinned, staleness } from './stale.js';

/** @typedef {import('../types.js').Root} Root */

/** Budget used when the caller gives none, in bytes. */
export const DEFAULT_BUDGET = 32768;
/** Longest description on an index line, in characters. */
const MAX_TITLE = 100;

/**
 * @typedef {Object} BundleNote
 * @property {string} rel
 * @property {string} description  first heading or first line ('' when the note is empty)
 * @property {string} marks        `[STALE: …]` marks, with a leading space, or ''
 * @property {string|null} content  full text when pinned, else null
 */

/** @param {string} text */
function shorten(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_TITLE) return flat;
  let cut = MAX_TITLE - 1;
  const code = flat.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${flat.slice(0, cut)}…`;
}

/** @param {string} text */
const bytes = (text) => Buffer.byteLength(text, 'utf8');

/**
 * @param {Root} root
 * @param {string} rel
 * @param {Date} now
 * @returns {BundleNote}
 */
function describe(root, rel, now) {
  const abs = path.join(root.dir, rel);
  let content;
  try {
    const size = fs.statSync(abs).size;
    if (size > MAX_NOTE_BYTES) return { rel, description: '', marks: ' [skipped: larger than 2 MB]', content: null };
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? /** @type {Error} */ (e).message;
    return { rel, description: '', marks: ` [unreadable: ${code}]`, content: null };
  }
  const aliases = root.config.metadataAliases;
  const parsed = parseNote(content);
  const first = parsed.sections[0];
  const description = first
    ? shorten(first.title)
    : shorten(content.slice(parsed.frontmatter.end).split('\n').find((l) => l.trim() !== '') ?? '');
  const note = staleness(parsed, null, now, aliases);
  let marks = note ? ` [STALE: ${note.reason}]` : '';
  if (!note) {
    const own = [
      { title: '', text: content.slice(parsed.preamble.start, parsed.preamble.ownEnd) },
      ...parsed.sections.map((s) => ({ title: s.title, text: content.slice(s.start, s.ownEnd) })),
    ];
    for (const s of own) {
      const verdict = staleness(parsed, { text: s.text }, now, aliases);
      if (verdict) marks += s.title ? ` [STALE section "${s.title}": ${verdict.reason}]` : ` [STALE intro: ${verdict.reason}]`;
    }
  }
  return { rel, description, marks, content: isPinned(parsed, aliases) ? content : null };
}

/** @param {BundleNote} n */
const block = (n) => {
  const body = /** @type {string} */ (n.content);
  return `==> ${n.rel} <==${n.marks}\n${body}${body.endsWith('\n') ? '' : '\n'}\n`;
};

/**
 * @param {BundleNote} n
 * @param {boolean} demoted  pinned, but its full text did not fit
 */
const line = (n, demoted) =>
  `- ${n.rel}${n.description ? ` — ${n.description}` : ''}${n.marks}${demoted ? ' [pinned: full text over budget]' : ''}\n`;

/**
 * @param {number} omitted
 * @param {number} budget
 */
const footer = (omitted, budget) => `… ${omitted} notes omitted (budget ${budget} bytes)\n`;

/**
 * The CAG bundle of a root. Synchronous and deterministic; never longer than `budget`
 * bytes (UTF-8).
 * @param {Root} root
 * @param {{ budget?: number, now?: Date }} [options]
 * @returns {string}
 */
export function bundle(root, options = {}) {
  const budget = options.budget ?? DEFAULT_BUDGET;
  if (!Number.isInteger(budget) || budget < 1) throw new RangeError(`budget must be a positive integer of bytes (got ${budget})`);
  const now = options.now ?? new Date();
  const notes = listNotes(root).map((rel) => describe(root, rel, now));
  const pinned = notes.filter((n) => n.content !== null);

  const full = [...pinned.map(block), ...notes.map((n) => line(n, false))].join('');
  if (bytes(full) <= budget) return full;

  const reserve = bytes(footer(notes.length, budget));
  if (reserve > budget) {
    throw new RangeError(`budget ${budget} is too small: the bundle needs at least ${reserve} bytes to say what it left out`);
  }
  const room = budget - reserve;
  let used = 0;
  /** @type {string[]} */
  const parts = [];
  /** @type {Set<string>} */
  const demoted = new Set();
  for (const n of pinned) {
    const text = block(n);
    const size = bytes(text);
    if (used + size <= room) {
      parts.push(text);
      used += size;
    } else demoted.add(n.rel);
  }
  let omitted = 0;
  for (let i = 0; i < notes.length; i++) {
    const text = line(notes[i], demoted.has(notes[i].rel));
    const size = bytes(text);
    if (used + size > room) {
      omitted = notes.length - i;
      break;
    }
    parts.push(text);
    used += size;
  }
  if (omitted > 0) parts.push(footer(omitted, budget));
  return parts.join('');
}
