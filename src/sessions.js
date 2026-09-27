// Sessions over a root: who is working now (presence), what each session read, the notices
// a session gets when a note it relies on changes, and the messages sessions send each
// other. Everything under `<stateDir>/run/` is ephemeral; `messages.jsonl` is durable.
//
//   run/sessions/<session>.json   presence: author, started, lastSeen, intent, paths
//   run/reads/<session>.jsonl     one line per read (rel, sha, ts); append-only, so parallel
//                                 Read hooks of the same session never lose each other's line
//   run/notices/<session>.json    cursor: the last ledger entry this session was told about
//   run/messages/<session>.json   ids of the messages already delivered to this session
//   run/messages/next-<id>.claim  who took a message sent to "next" (created with O_EXCL)
//   messages.jsonl                every message, append-only, written under the root's lock
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MnemeError } from './errors.js';
import { sid8 } from './guard.js';
import { safeFileName } from './leases.js';
import { readLedger } from './ledger.js';
import { withLock } from './lock.js';
import { NAME } from './name.js';
import { writeFileAtomic } from './objects.js';

/** @typedef {import('./types.js').Author} Author */
/** @typedef {import('./types.js').LedgerEntry} LedgerEntry */
/** @typedef {import('./types.js').Root} Root */

/**
 * @typedef {Object} Presence
 * @property {1} v
 * @property {Author} author
 * @property {string} started   ISO
 * @property {string} lastSeen  ISO
 * @property {string} [intent]  what the session said it is doing
 * @property {string[]} [paths] notes it said it will touch
 */

/**
 * A change another session (or an external write) made that this session should know.
 * @typedef {Object} Notice
 * @property {string} root       the root's dir
 * @property {string} rel        the note, by the name this session knew it
 * @property {string} id         the ledger entry
 * @property {string} ts
 * @property {LedgerEntry['op']} op
 * @property {Author} author
 * @property {string} [reason]
 * @property {string} [movedTo]  for a move: the new name
 * @property {string[]} added    protected headings added
 * @property {string[]} removed  protected headings removed
 * @property {string[]} changed  sections whose own text changed
 * @property {boolean} late      a two-phase write confirmed later by the watcher
 * @property {'read'|'owner'} why  it read the note, or it wrote a section the change touched
 * @property {string[]} [yours]  sections this session wrote that the change touched
 */

/**
 * @typedef {Object} Message
 * @property {1} v
 * @property {string} id          16 hex characters
 * @property {string} ts
 * @property {Author} from
 * @property {string} to          a session id, '*' or 'next'
 * @property {string[]} [recipients]  for '*': the sessions active when it was sent (sender excluded)
 * @property {string} body
 * @property {string} correlation the conversation it belongs to (the first message's id)
 * @property {string} [replyTo]
 * @property {'done'|'rejected'|'seen'} [status]  for an acknowledgement
 */

/** Largest message body, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 64 * 1024;
const STATUSES = ['done', 'rejected', 'seen'];

// ── small helpers ───────────────────────────────────────────────────────────

/** @param {Root} root @param {...string} parts */
const runPath = (root, ...parts) => path.join(root.stateDir, 'run', ...parts);

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');

/**
 * Local `hh:mm` of an ISO timestamp (the reader is a person or an agent at this machine).
 * @param {string} iso
 */
export function hhmm(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {string} file
 * @returns {unknown}  undefined when there is no file
 */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${/** @type {Error} */ (e).message}); delete it: it is ephemeral state.`);
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(value)}\n`);
}

/**
 * The parsed lines of a JSONL file; a torn or garbled line is skipped (a crash in the
 * middle of an append must not hide every other line).
 * @param {string} file
 * @returns {unknown[]}
 */
function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  /** @type {unknown[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn line: skipped on purpose, see the doc comment. `doctor` reports the ledger's.
    }
  }
  return out;
}

/**
 * Appends one line, closing a torn last line first so it is not glued to this one.
 * @param {string} file
 * @param {unknown} value
 */
function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = '';
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(value)}\n`, 'utf8');
}

/** @param {Author|undefined} author */
function checkAuthor(author) {
  if (!author || typeof author.session !== 'string' || author.session.trim() === '') {
    throw new TypeError('a session is needed: pass an author { session, agent } with the id of the session');
  }
}

/** @param {string} session */
function checkSession(session) {
  if (typeof session !== 'string' || session.trim() === '') throw new TypeError('a session id is needed');
}

// ── who ─────────────────────────────────────────────────────────────────────

/** The OS user, or undefined where the system does not say (some containers). */
function osUser() {
  try {
    return os.userInfo().username;
  } catch {
    // No passwd entry for this uid: the author simply has no `user`.
    return process.env.USER ?? process.env.USERNAME;
  }
}

/**
 * The author of whatever a session does, with the OS user and host.
 * @param {{ session: string, agent: Author['agent'], client?: string }} who
 * @returns {Author}
 */
export function sessionAuthor({ session, agent, client }) {
  /** @type {Author} */
  const author = { session, agent };
  if (client) author.client = client;
  const user = osUser();
  if (user) author.user = user;
  author.host = os.hostname();
  return author;
}

// ── presence ────────────────────────────────────────────────────────────────

/**
 * Marks a session as seen now (creates its presence the first time). `started` is kept;
 * `intent` and `paths` are replaced only when given.
 * @param {Root} root
 * @param {Author} author
 * @param {{ intent?: string, paths?: string[] }} [what]
 * @returns {Presence}
 */
export function touchSession(root, author, { intent, paths } = {}) {
  checkAuthor(author);
  const file = runPath(root, 'sessions', `${safeFileName(author.session)}.json`);
  const now = new Date().toISOString();
  const previous = /** @type {Partial<Presence>|undefined} */ (readJson(file));
  /** @type {Presence} */
  const presence = { v: 1, author, started: previous?.started ?? now, lastSeen: now };
  const keepIntent = intent ?? previous?.intent;
  const keepPaths = paths ?? previous?.paths;
  if (keepIntent !== undefined) presence.intent = keepIntent;
  if (keepPaths !== undefined) presence.paths = keepPaths;
  writeJson(file, presence);
  return presence;
}

/**
 * Takes a session out of the presence. Its reads and delivered messages stay (a resumed
 * session keeps its notices).
 * @param {Root} root
 * @param {string} session
 */
export function endSession(root, session) {
  checkSession(session);
  fs.rmSync(runPath(root, 'sessions', `${safeFileName(session)}.json`), { force: true });
  // A mark that it ended, so a "next" message it took and left unanswered can be released
  // (§4.20): without it, "ended" and "never announced itself" look the same.
  const mark = runPath(root, 'ended', safeFileName(session));
  fs.mkdirSync(path.dirname(mark), { recursive: true });
  fs.writeFileSync(mark, new Date().toISOString(), 'utf8');
}

/**
 * A session is gone when it ended (`endSession`) or its presence went stale; one that is
 * active, or never announced itself, is not.
 * @param {Root} root
 * @param {string} session
 * @param {Set<string>} active
 */
function isGone(root, session, active) {
  if (active.has(session)) return false;
  return fs.existsSync(runPath(root, 'ended', safeFileName(session))) || fs.existsSync(runPath(root, 'sessions', `${safeFileName(session)}.json`));
}

/**
 * Every session that ever announced itself in this root, by file name: present now, ended
 * (`endSession`), or told about changes (its notice cursor, `noticesFor`). Only the hooks and
 * the MCP server write those, so these are agent sessions, never the person at the CLI. A
 * session that only talked leaves no read and no write, but it does leave these (§4.31).
 * @param {Root} root
 * @returns {string[]}
 */
export function sessionsSeen(root) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const [dir, ext] of /** @type {const} */ ([['sessions', '.json'], ['ended', ''], ['notices', '.json']])) {
    let names;
    try {
      names = fs.readdirSync(runPath(root, dir));
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') continue;
      throw e;
    }
    for (const n of names) if (n.endsWith(ext) && n.length > ext.length) ids.add(n.slice(0, n.length - ext.length));
  }
  return [...ids];
}

/**
 * Sessions seen within `activeWindowMinutes` of `now`, oldest first.
 * @param {Root} root
 * @param {{ now?: Date }} [options]
 * @returns {Presence[]}
 */
export function activeSessions(root, { now = new Date() } = {}) {
  const dir = runPath(root, 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  const windowMs = root.config.activeWindowMinutes * 60_000;
  /** @type {Presence[]} */
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let p;
    try {
      p = /** @type {Presence|undefined} */ (readJson(path.join(dir, name)));
    } catch {
      // A presence file torn by a crash: that session is simply not listed until it is seen again.
      continue;
    }
    if (!p || !p.author || typeof p.author.session !== 'string') continue;
    const seen = Date.parse(p.lastSeen);
    if (Number.isNaN(seen) || now.getTime() - seen > windowMs) continue;
    out.push(p);
  }
  return out.sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0));
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * Records that `session` read version `sha` of `rel` (the note's name now).
 * @param {Root} root
 * @param {string} session
 * @param {string} rel
 * @param {string} sha
 */
export function recordRead(root, session, rel, sha) {
  checkSession(session);
  appendJsonl(runPath(root, 'reads', `${safeFileName(session)}.jsonl`), { rel, sha, ts: new Date().toISOString() });
}

/**
 * The last read of every note by `session`.
 * @param {Root} root
 * @param {string} session
 * @returns {Map<string, { sha: string, ts: string }>}
 */
function lastReads(root, session) {
  /** @type {Map<string, { sha: string, ts: string }>} */
  const reads = new Map();
  for (const x of readJsonl(runPath(root, 'reads', `${safeFileName(session)}.jsonl`))) {
    const r = /** @type {{ rel?: unknown, sha?: unknown, ts?: unknown }} */ (x);
    if (typeof r?.rel === 'string' && typeof r.sha === 'string' && typeof r.ts === 'string') {
      reads.set(r.rel, { sha: r.sha, ts: r.ts });
    }
  }
  return reads;
}

// ── denials and session ids ─────────────────────────────────────────────────

/**
 * @typedef {Object} Denial
 * @property {string} ts
 * @property {string} session
 * @property {string} rel
 * @property {Array<{ key: string, owners: string[] }>} sections  what the guard protected, and whose ([] in denials recorded before 25/09)
 */

/**
 * Records that the guard blocked `session` on `rel`. The denial text shows only 8
 * characters of the session; this is how `allow --session <8 chars>` finds the full id.
 * `lost` (the guard's answer) says which sections it protected and whose: `audit` counts them.
 * @param {Root} root
 * @param {string} session
 * @param {string} rel
 * @param {Array<{ key: string, owners: string[] }>} [lost]
 */
export function recordDenial(root, session, rel, lost) {
  checkSession(session);
  /** @type {Record<string, unknown>} */
  const denial = { ts: new Date().toISOString(), session, rel };
  if (lost?.length) denial.sections = lost.map(({ key, owners }) => ({ key, owners: [...owners] }));
  appendJsonl(runPath(root, 'denials.jsonl'), denial);
}

/**
 * Every denial recorded in the root, oldest first; malformed lines are skipped.
 * @param {Root} root
 * @returns {Denial[]}
 */
export function readDenials(root) {
  /** @type {Denial[]} */
  const out = [];
  for (const x of readJsonl(runPath(root, 'denials.jsonl'))) {
    const d = /** @type {{ ts?: unknown, session?: unknown, rel?: unknown, sections?: unknown }} */ (x);
    if (typeof d?.ts !== 'string' || typeof d.session !== 'string' || typeof d.rel !== 'string') continue;
    /** @type {Denial['sections']} */
    const sections = [];
    for (const s of Array.isArray(d.sections) ? d.sections : []) {
      const x = /** @type {{ key?: unknown, owners?: unknown }} */ (s);
      if (typeof x?.key !== 'string' || !Array.isArray(x.owners)) continue;
      sections.push({ key: x.key, owners: x.owners.filter((o) => typeof o === 'string') });
    }
    out.push({ ts: d.ts, session: d.session, rel: d.rel, sections });
  }
  return out;
}

/**
 * Every session id the root knows, most relevant first: the ones blocked on `rel` (newest
 * first), then any blocked, then the present ones, then the authors in the ledger.
 * @param {Root} root
 * @param {{ rel?: string }} [options]
 * @returns {string[]}
 */
export function knownSessions(root, { rel } = {}) {
  /** @type {string[]} */
  const out = [];
  /** @param {unknown} s */
  const add = (s) => {
    if (typeof s === 'string' && s !== '' && !out.includes(s)) out.push(s);
  };
  const denials = /** @type {Array<{ session?: unknown, rel?: unknown }>} */ (readJsonl(runPath(root, 'denials.jsonl'))).reverse();
  for (const d of denials) if (rel !== undefined && d?.rel === rel) add(d.session);
  for (const d of denials) add(d?.session);
  for (const p of activeSessions(root).reverse()) add(p.author.session);
  for (const e of readLedger(root).entries.reverse()) if (e.author.session !== 'external') add(e.author.session);
  return out;
}

// ── notices ─────────────────────────────────────────────────────────────────

/**
 * Index of the first ledger entry this session was not told about yet.
 * @param {LedgerEntry[]} entries
 * @param {{ cursor?: string|null, at?: number }} state
 */
function firstUnseen(entries, state) {
  if (!state.cursor) return 0;
  if (typeof state.at === 'number' && entries[state.at - 1]?.id === state.cursor) return state.at;
  const i = entries.findLastIndex((e) => e.id === state.cursor);
  return i === -1 ? 0 : i + 1;
}

/**
 * Index of the entry that produced the version a session read (the last one of that note
 * with that sha, not later than the read); -1 when the ledger has none before the read.
 * @param {LedgerEntry[]} entries
 * @param {string} rel
 * @param {{ sha: string, ts: string }} read
 */
function readPosition(entries, rel, read) {
  const when = Date.parse(read.ts);
  let lastBefore = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const t = Date.parse(e.ts);
    if (t > when) continue;
    if (lastBefore === -1) lastBefore = i;
    if (e.rel === rel && e.after === read.sha) return i;
  }
  return lastBefore;
}

/**
 * @param {Root} root
 * @param {LedgerEntry} e
 * @param {string} rel
 * @param {'read'|'owner'} why
 * @returns {Notice}
 */
function toNotice(root, e, rel, why) {
  const added = Object.entries(e.delta).filter(([, n]) => n > 0).map(([k]) => k);
  const removed = Object.entries(e.delta).filter(([, n]) => n < 0).map(([k]) => k);
  const changed = e.changed.filter((k) => !added.includes(k) && !removed.includes(k));
  /** @type {Notice} */
  const notice = { root: root.dir, rel, id: e.id, ts: e.ts, op: e.op, author: e.author, added, removed, changed, late: Boolean(e.late), why };
  if (e.reason !== undefined) notice.reason = e.reason;
  if (e.op === 'move' && rel !== e.rel) notice.movedTo = e.rel;
  return notice;
}

/**
 * What changed, since this session last asked, that it should know: (a) notes it read
 * whose content another session (or an external write) changed after its read, and
 * (b) changes by others that touched a section this session wrote, even in a note it
 * never read. Each change is told once: the call moves this session's cursor.
 * @param {Root} root
 * @param {string} session
 * @returns {Notice[]}
 */
export function noticesFor(root, session) {
  checkSession(session);
  const { entries } = readLedger(root);
  const stateFile = runPath(root, 'notices', `${safeFileName(session)}.json`);
  const state = /** @type {{ cursor?: string|null, at?: number }|undefined} */ (readJson(stateFile)) ?? {};
  const start = firstUnseen(entries, state);
  /** @type {Map<string, { index: number, notice: Notice }>} */
  const found = new Map();

  // (a) notes this session read, following moves after the read.
  for (const [rel, read] of lastReads(root, session)) {
    const at = readPosition(entries, rel, read);
    let name = rel;
    for (let j = at + 1; j < entries.length; j++) {
      const e = entries[j];
      const movedAway = e.op === 'move' && e.from === name;
      if (!movedAway && e.rel !== name) continue;
      const known = name;
      if (movedAway) name = e.rel;
      if (j < start || e.author.session === session || found.has(e.id)) continue;
      found.set(e.id, { index: j, notice: toNotice(root, e, known, 'read') });
    }
  }

  // (b) sections this session owns, touched by someone else. Ownership is replayed in
  // ledger order, so it is the one right before each change.
  /** @type {Map<string, Map<string, Map<string, number>>>} */
  const owners = new Map();
  for (let j = 0; j < entries.length; j++) {
    const e = entries[j];
    if (e.op === 'move' && e.from !== undefined) {
      const carried = owners.get(e.from);
      owners.delete(e.from);
      if (carried) owners.set(e.rel, carried);
    }
    let note = owners.get(e.rel);
    if (j >= start && e.author.session !== session && note) {
      const byKey = note;
      const touched = [...new Set([...e.changed, ...(e.violations ?? [])])].filter((k) => (byKey.get(k)?.get(session) ?? 0) > 0);
      if (touched.length > 0) {
        const already = found.get(e.id);
        if (already) already.notice.yours = touched;
        else found.set(e.id, { index: j, notice: { ...toNotice(root, e, e.rel, 'owner'), yours: touched } });
      }
    }
    for (const [key, n] of Object.entries(e.delta)) {
      if (!note) owners.set(e.rel, (note = new Map()));
      let bySession = note.get(key);
      if (!bySession) note.set(key, (bySession = new Map()));
      bySession.set(e.author.session, Math.max(0, (bySession.get(e.author.session) ?? 0) + n));
    }
  }

  if (entries.length > 0) writeJson(stateFile, { cursor: entries[entries.length - 1].id, at: entries.length });
  return [...found.values()].sort((a, b) => a.index - b.index).map((x) => x.notice);
}

/**
 * `a`, `a and b`, `a, b and c` (at most 5, then "and n more").
 * @param {string[]} keys
 */
function listOf(keys) {
  const shown = keys.map((k) => (k === '' ? 'the text before the first heading' : k));
  if (shown.length > 5) return `${shown.slice(0, 5).join(', ')} and ${shown.length - 5} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** @param {Notice} n */
function noticeLine(n) {
  const by = `session ${sid8(n.author.session)} (${n.author.agent})`;
  /** @type {Record<LedgerEntry['op'], string>} */
  const verbs = {
    write: `edited by ${by}`,
    edit: `edited by ${by}`,
    restore: `restored to an earlier version by ${by}`,
    adopt: `adopted by ${by}`,
    move: `moved to ${n.movedTo ?? n.rel} by ${by}`,
    external: 'external write (no author)',
    delete: 'deleted outside the tools (no author)',
  };
  const parts = [];
  if (n.changed.length) parts.push(`changed ${listOf(n.changed)}`);
  if (n.added.length) parts.push(`added ${listOf(n.added)}`);
  if (n.removed.length) parts.push(`removed ${listOf(n.removed)}`);
  let line = `  - ${n.rel}: ${verbs[n.op]}${n.late ? ' (confirmed late)' : ''} at ${hhmm(n.ts)}`;
  if (parts.length) line += `: ${parts.join(', ')}`;
  if (n.reason) line += `. Reason: "${n.reason}"`;
  if (n.yours?.length) line += ` (it touched ${n.yours.length === 1 ? 'a section' : 'sections'} you wrote: ${listOf(n.yours)})`;
  return line;
}

/**
 * The notices as the text of docs/diseno/02-mapa.md §④ ('' when there are none).
 * @param {Notice[]} notices
 */
export function formatNotices(notices) {
  if (notices.length === 0) return '';
  return [`[${NAME}] Notes you read have changed since you read them:`, ...notices.map(noticeLine), 'Re-read them before relying on them.'].join(
    '\n',
  );
}

// ── messages ────────────────────────────────────────────────────────────────

/** @param {Root} root */
export const messagesPath = (root) => path.join(root.stateDir, 'messages.jsonl');

/** @param {unknown} x @returns {x is Message} */
function isMessage(x) {
  const m = /** @type {Record<string, unknown>|null} */ (x);
  return (
    m !== null &&
    typeof m === 'object' &&
    typeof m.id === 'string' &&
    typeof m.to === 'string' &&
    typeof m.body === 'string' &&
    m.from !== null &&
    typeof m.from === 'object' &&
    typeof (/** @type {Record<string, unknown>} */ (m.from).session) === 'string'
  );
}

/**
 * Every message of the root, oldest first.
 * @param {Root} root
 * @returns {Message[]}
 */
export function readMessages(root) {
  return readJsonl(messagesPath(root)).filter(isMessage);
}

/**
 * A message by its id or a unique prefix of at least 6 characters.
 * @param {Message[]} all
 * @param {string} id
 */
function findMessage(all, id) {
  const exact = all.find((m) => m.id === id);
  if (exact) return exact;
  const s = String(id).toLowerCase();
  const matches = s.length >= 6 ? all.filter((m) => m.id.startsWith(s)) : [];
  if (matches.length === 1) return matches[0];
  throw new MnemeError(
    'MESSAGE_NOT_FOUND',
    matches.length > 1
      ? `${matches.length} messages start with "${id}": give more characters.`
      : `No message "${id}" in this root. The ids are in the "Messages for you" lines: (id <id>).`,
  );
}

/**
 * Sends a message to one session (`to` = its id), to every active session but the sender
 * (`'*'`), or to whichever session asks first (`'next'`). The body is text of at most
 * 64 KiB. Appended under the root's lock; a message is never edited.
 * @param {Root} root
 * @param {{ from: Author, to: string, body: string, correlation?: string, replyTo?: string, status?: 'done'|'rejected'|'seen' }} message
 * @returns {Promise<Message>}
 */
export async function sendMessage(root, { from, to, body, correlation, replyTo, status }) {
  checkAuthor(from);
  if (typeof to !== 'string' || to.trim() === '') {
    throw new TypeError('a message needs "to": a session id, "*" (every active session) or "next" (the next session to ask)');
  }
  if (typeof body !== 'string') throw new TypeError('the body of a message must be text');
  const size = Buffer.byteLength(body, 'utf8');
  if (size > MAX_BODY_BYTES) {
    throw new RangeError(`the message body is ${size} bytes; the limit is ${MAX_BODY_BYTES} (64 KiB). Put the rest in a note and send its path.`);
  }
  if (correlation !== undefined && (typeof correlation !== 'string' || correlation === '')) {
    throw new TypeError('"correlation" must be a non-empty string');
  }
  if (status !== undefined && !STATUSES.includes(status)) throw new TypeError(`"status" must be one of ${STATUSES.join(', ')}`);
  return withLock(
    root,
    () => {
      const all = readMessages(root);
      /** @type {Message|undefined} */
      let original;
      if (replyTo !== undefined) original = findMessage(all, replyTo);
      let id = randomBytes(8).toString('hex');
      while (all.some((m) => m.id === id)) id = randomBytes(8).toString('hex');
      /** @type {Message} */
      const message = { v: 1, id, ts: new Date().toISOString(), from, to, body, correlation: correlation ?? original?.correlation ?? id };
      if (to === '*') message.recipients = activeSessions(root).map((p) => p.author.session).filter((s) => s !== from.session);
      if (original) message.replyTo = original.id;
      if (status) message.status = status;
      appendJsonl(messagesPath(root), message);
      return message;
    },
    { timeoutMs: root.config.lockTimeoutMs },
  );
}

/**
 * Takes a message sent to "next" for `session`, atomically across processes. A claim
 * whose holder left without answering (no `done` or `rejected` reply, and gone) is
 * released (contracts §4.20). Claims are generations: `next-<id>.claim`, then
 * `.claim.1`, `.claim.2`…; each one is created with `wx`, so exactly one session wins
 * each generation, and releasing is winning the next one. Nothing is renamed or removed.
 * @param {Root} root
 * @param {string} id
 * @param {string} session
 * @param {() => { messages: Message[], active: Set<string> }} context  read once, when a claim is contested
 */
function claimNext(root, id, session, context) {
  const base = runPath(root, 'messages', `next-${safeFileName(id)}.claim`);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const fileOf = (/** @type {number} */ gen) => (gen === 0 ? base : `${base}.${gen}`);
  /** @param {number} gen */
  const take = (gen) => {
    try {
      fs.writeFileSync(fileOf(gen), session, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      return false;
    }
  };
  if (take(0)) return true;
  for (;;) {
    let gen = 0;
    while (fs.existsSync(fileOf(gen + 1))) gen++;
    // Taken: by this same session (it asked before and crashed before recording it) or another.
    const holder = fs.readFileSync(fileOf(gen), 'utf8');
    if (holder === session) return true;
    const { messages, active } = context();
    const answered = messages.some((m) => m.replyTo === id && m.from.session === holder && (m.status === 'done' || m.status === 'rejected'));
    if (answered || !isGone(root, holder, active)) return false;
    if (take(gen + 1)) {
      appendJsonl(runPath(root, 'messages', 'releases.jsonl'), { id, from: holder, to: session, ts: new Date().toISOString() });
      return true;
    }
    // Another session won that generation first: look again at who holds it now.
  }
}

/**
 * The messages for `session` that were not delivered to it yet. Each message is
 * delivered once per recipient; a "next" message is taken by the first session (not the
 * sender) that asks, and released if that session leaves without answering (§4.20).
 * @param {Root} root
 * @param {string} session
 * @returns {Message[]}
 */
export function messagesFor(root, session) {
  checkSession(session);
  const stateFile = runPath(root, 'messages', `${safeFileName(session)}.json`);
  const state = /** @type {{ delivered?: string[] }|undefined} */ (readJson(stateFile));
  const delivered = new Set(Array.isArray(state?.delivered) ? state.delivered : []);
  /** @type {Message[]} */
  const out = [];
  const messages = readMessages(root);
  /** @type {{ messages: Message[], active: Set<string> }|null} */
  let ctx = null;
  const context = () => (ctx ??= { messages, active: new Set(activeSessions(root).map((p) => p.author.session)) });
  for (const m of messages) {
    if (delivered.has(m.id)) continue;
    const mine =
      m.to === session ||
      (m.to === '*' && m.from.session !== session && Array.isArray(m.recipients) && m.recipients.includes(session)) ||
      (m.to === 'next' && m.from.session !== session && claimNext(root, m.id, session, context));
    if (mine) out.push(m);
  }
  if (out.length > 0) writeJson(stateFile, { delivered: [...delivered, ...out.map((m) => m.id)] });
  return out;
}

/**
 * Answers a message: a new message to its sender, with `replyTo` = its id and the same
 * correlation.
 * @param {Root} root
 * @param {{ from: Author, id: string, status: 'done'|'rejected'|'seen', body?: string }} ack
 * @returns {Promise<Message>}
 */
export async function ackMessage(root, { from, id, status, body }) {
  if (!STATUSES.includes(status)) throw new TypeError(`"status" must be one of ${STATUSES.join(', ')}`);
  const original = findMessage(readMessages(root), id);
  return sendMessage(root, { from, to: original.from.session, body: body ?? '', correlation: original.correlation, replyTo: original.id, status });
}

/** @param {Message} m */
function messageLine(m) {
  const reply = m.replyTo ? `, reply to ${m.replyTo.slice(0, 8)}${m.status ? `: ${m.status}` : ''}` : '';
  const to = m.to === '*' ? ', to every active session' : m.to === 'next' ? ', to the next session' : '';
  return `  - from session ${sid8(m.from.session)} (${m.from.agent}) at ${hhmm(m.ts)}: "${m.body}" (id ${m.id.slice(0, 8)}${reply}${to})`;
}

/**
 * The messages as text ('' when there are none). A message is data another session
 * wrote: it is quoted, never presented as an instruction of this tool.
 * @param {Message[]} messages
 */
export function formatMessages(messages) {
  if (messages.length === 0) return '';
  return [`[${NAME}] Messages for you:`, ...messages.map(messageLine)].join('\n');
}
