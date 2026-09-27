// The ledger: `<stateDir>/ledger.jsonl`, one entry per line, append-only.
// Every line carries `prev`, the sha256 of the line before it: a line edited or deleted
// in the middle breaks the chain. It is not a signature (anyone with a shell can rebuild
// the chain); it catches accidents and clumsy rewrites.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './objects.js';

/** @typedef {import('./types.js').Root} Root */
/** @typedef {import('./types.js').LedgerEntry} LedgerEntry */
/** @typedef {Omit<LedgerEntry, 'prev'>} NewEntry */

const OPS = new Set(['adopt', 'write', 'edit', 'move', 'restore', 'external', 'delete']);
const TAIL_CHUNK = 64 * 1024;

/** @param {Root} root */
export const ledgerPath = (root) => path.join(root.stateDir, 'ledger.jsonl');

/**
 * The chain hash of a stored line. A trailing CR is ignored, so a checkout that turns
 * LF into CRLF does not break the chain.
 * @param {string} line
 */
const lineHash = (line) => sha256(line.endsWith('\r') ? line.slice(0, -1) : line);

/** Time-ordered id: `<ms in base36>-<6 random base36 characters>`. */
export function newId() {
  const bytes = randomBytes(6);
  let rand = '';
  for (const b of bytes) rand += (b % 36).toString(36);
  return `${Date.now().toString(36)}-${rand}`;
}

/**
 * Canonical key order, without undefined fields: the object returned to a caller is
 * deep-equal to the line read back.
 * @param {NewEntry} e
 * @param {string} prev
 * @returns {LedgerEntry}
 */
function canonical(e, prev) {
  /** @type {Record<string, unknown>} */
  const out = { v: 1, id: e.id, ts: e.ts, rel: e.rel, op: e.op, author: stripUndefined(e.author) };
  if (e.reason !== undefined) out.reason = e.reason;
  out.before = e.before;
  out.after = e.after;
  if (e.from !== undefined) out.from = e.from;
  out.delta = e.delta;
  out.changed = e.changed;
  if (e.override !== undefined) out.override = e.override;
  if (e.violations !== undefined && e.violations.length > 0) out.violations = e.violations;
  if (e.raced) out.raced = true;
  if (e.late) out.late = true;
  out.prev = prev;
  return /** @type {LedgerEntry} */ (out);
}

/**
 * @template {object} T
 * @param {T} obj
 * @returns {T}
 */
function stripUndefined(obj) {
  return /** @type {T} */ (Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)));
}

/**
 * The last non-empty line of the ledger as stored, and whether the file ends in a newline.
 * Reads only the tail of the file.
 * @param {string} file
 * @returns {{ line: string, endsWithNewline: boolean }}
 */
function lastLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { line: '', endsWithNewline: true };
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { line: '', endsWithNewline: true };
    for (let window = Math.min(size, TAIL_CHUNK); ; window = Math.min(size, window * 4)) {
      const buf = Buffer.alloc(window);
      fs.readSync(fd, buf, 0, window, size - window);
      const text = buf.toString('utf8');
      const endsWithNewline = text.endsWith('\n');
      const body = endsWithNewline ? text.replace(/\n+$/, '') : text;
      const nl = body.lastIndexOf('\n');
      // The line is complete when a newline precedes it inside the window, or the window is the whole file.
      if (nl !== -1 || window === size) return { line: body.slice(nl + 1), endsWithNewline };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Appends entries in one write, chaining each `prev` to the line before it on disk.
 * Call it ONLY while holding the root's lock (src/lock.js).
 * @param {Root} root
 * @param {NewEntry[]} entries
 * @returns {LedgerEntry[]} the entries as written (deep-equal to what readLedger returns)
 */
export function appendEntries(root, entries) {
  if (entries.length === 0) return [];
  const file = ledgerPath(root);
  const tail = lastLine(file);
  let prev = tail.line === '' ? '' : lineHash(tail.line);
  /** @type {LedgerEntry[]} */
  const written = [];
  // A torn last line (a crash in the middle of an append) is closed, not glued to the next one.
  let chunk = tail.endsWithNewline ? '' : '\n';
  for (const e of entries) {
    const entry = canonical(e, prev);
    const line = JSON.stringify(entry);
    chunk += `${line}\n`;
    prev = lineHash(line);
    written.push(/** @type {LedgerEntry} */ (JSON.parse(line)));
  }
  fs.appendFileSync(file, chunk, 'utf8');
  return written;
}

/**
 * Appends one entry. Call it ONLY while holding the root's lock.
 * @param {Root} root
 * @param {NewEntry} entry
 * @returns {LedgerEntry}
 */
export function appendEntry(root, entry) {
  return appendEntries(root, [entry])[0];
}

/** @param {unknown} x */
function looksLikeEntry(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const e = /** @type {Record<string, unknown>} */ (x);
  const author = /** @type {Record<string, unknown>|null} */ (e.author);
  return (
    e.v === 1 &&
    typeof e.id === 'string' &&
    typeof e.ts === 'string' &&
    typeof e.rel === 'string' &&
    typeof e.op === 'string' &&
    OPS.has(e.op) &&
    author !== null &&
    typeof author === 'object' &&
    typeof author.session === 'string' &&
    e.delta !== null &&
    typeof e.delta === 'object' &&
    Array.isArray(e.changed)
  );
}

/**
 * Reads the whole ledger. A broken line does not sink the rest: it is counted in
 * `corrupt` and skipped. `broken` counts entries whose `prev` does not match the line
 * before them (a line edited or removed in the middle).
 * @param {Root} root
 * @returns {{ entries: LedgerEntry[], corrupt: number, broken: number }}
 */
export function readLedger(root) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath(root), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { entries: [], corrupt: 0, broken: 0 };
    throw e;
  }
  /** @type {LedgerEntry[]} */
  const entries = [];
  let corrupt = 0;
  let broken = 0;
  let prev = '';
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn or garbled line: counted, never fatal. Its bytes still take part in the chain.
      parsed = undefined;
    }
    if (looksLikeEntry(parsed)) {
      const entry = /** @type {LedgerEntry} */ (parsed);
      if (entry.prev !== prev) broken++;
      entries.push(entry);
    } else {
      corrupt++;
    }
    prev = lineHash(line);
  }
  return { entries, corrupt, broken };
}

/**
 * The id of the first entry whose `prev` does not match the line before it (null when the
 * chain holds): where `readLedger` starts counting `broken`.
 * @param {Root} root
 * @returns {string|null}
 */
export function firstBrokenEntry(root) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath(root), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
  let prev = '';
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (looksLikeEntry(parsed) && /** @type {LedgerEntry} */ (parsed).prev !== prev) return /** @type {LedgerEntry} */ (parsed).id;
    prev = lineHash(line);
  }
  return null;
}

/**
 * The entries that belong to the note now at `rel`, oldest first, following moves back
 * to earlier names. An entry of a name that was later moved away belongs to the moved
 * note, not to whatever lives at that name afterwards.
 * @param {LedgerEntry[]} entries
 * @param {string} rel
 * @returns {LedgerEntry[]}
 */
export function lineage(entries, rel) {
  const names = new Set([rel]);
  /** @type {LedgerEntry[]} */
  const out = [];
  for (let i = entries.length - 1; i >= 0 && names.size > 0; i--) {
    const e = entries[i];
    if (e.op === 'move' && e.from !== undefined && names.has(e.from) && !names.has(e.rel)) {
      // `e.from` was vacated here: what came before under that name moved to e.rel.
      names.delete(e.from);
      continue;
    }
    if (!names.has(e.rel)) continue;
    out.push(e);
    if (e.op === 'move' && e.from !== undefined) {
      names.delete(e.rel);
      names.add(e.from);
    }
  }
  return out.reverse();
}

/**
 * The sha the ledger says `rel` has now (null: it does not exist).
 * @param {LedgerEntry[]} entries
 * @param {string} rel
 * @returns {string|null}
 */
export function headIn(entries, rel) {
  const own = lineage(entries, rel);
  return own.length ? own[own.length - 1].after : null;
}

/**
 * The current sha of every note the ledger knows (null entries are deleted notes).
 * @param {LedgerEntry[]} entries
 * @returns {Map<string, string|null>}
 */
export function headsIn(entries) {
  /** @type {Map<string, string|null>} */
  const heads = new Map();
  for (const e of entries) {
    if (e.op === 'move' && e.from !== undefined) heads.delete(e.from);
    heads.set(e.rel, e.after);
  }
  return heads;
}

/**
 * Who owns how many copies of each protected heading of `rel`: the sum of each session's
 * `delta`, following moves. A session never goes below zero.
 * @param {LedgerEntry[]} entries
 * @param {string} rel
 * @returns {Map<string, Map<string, number>>}  heading key -> session -> copies
 */
export function ownersIn(entries, rel) {
  /** @type {Map<string, Map<string, number>>} */
  const owners = new Map();
  for (const e of lineage(entries, rel)) {
    for (const [key, n] of Object.entries(e.delta)) {
      let bySession = owners.get(key);
      if (!bySession) owners.set(key, (bySession = new Map()));
      bySession.set(e.author.session, Math.max(0, (bySession.get(e.author.session) ?? 0) + n));
    }
  }
  for (const [key, bySession] of owners) {
    for (const [session, n] of bySession) if (n === 0) bySession.delete(session);
    if (bySession.size === 0) owners.delete(key);
  }
  return owners;
}

/**
 * The `after` of the last entry of `rel` (null when unknown or deleted).
 * @param {Root} root
 * @param {string} rel
 */
export function headOf(root, rel) {
  return headIn(readLedger(root).entries, rel);
}

/**
 * @param {Root} root
 * @param {string} rel
 */
export function owners(root, rel) {
  return ownersIn(readLedger(root).entries, rel);
}
