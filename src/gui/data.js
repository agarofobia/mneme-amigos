// The GUI's data layer (contracts §4.17): everything the page shows, as plain JSON.
// Read-only: no lock, no notice cursors, nothing written under the state directory
// (the search index, a cache, may be refreshed by a --query).
import fs from 'node:fs';
import path from 'node:path';
import { audit } from '../audit.js';
import { hasObject, getObject } from '../objects.js';
import { firstBrokenEntry, lineage, ownersIn, readLedger } from '../ledger.js';
import { NAME } from '../name.js';
import { listNotes } from '../root.js';
import { search } from '../search.js';
import { parseNote } from '../sections.js';
import { activeSessions, readDenials } from '../sessions.js';
import { markerScope, staleness } from '../readers/stale.js';

/** @typedef {import('../types.js').Root} Root */
/** @typedef {import('../types.js').LedgerEntry} LedgerEntry */
/** @typedef {import('../types.js').Author} Author */

/** @typedef {'denied'|'writing'|'stale'|'external'|'adopted'|'normal'} SectionState */
/**
 * @typedef {Object} LastWrite
 * @property {string} id
 * @property {string} ts
 * @property {LedgerEntry['op']} op
 * @property {string} session
 * @property {string} agent
 * @property {string} [client]
 * @property {string} [reason]
 */
/**
 * @typedef {Object} SectionView
 * @property {string} key
 * @property {string} title
 * @property {number} level
 * @property {string[]} owners   sessions that wrote the heading (none: adopted or deeper than the guard)
 * @property {LastWrite|null} last  the last write that touched it
 * @property {SectionState} st
 * @property {string} [stale]    the reason, when stale
 */
/**
 * @typedef {Object} DiffLine
 * @property {'+'|'-'|' '|'…'} op
 * @property {string} text
 */
/**
 * @typedef {Object} HistoryView
 * @property {string} id
 * @property {string} ts
 * @property {LedgerEntry['op']} op
 * @property {string} session
 * @property {string} agent
 * @property {string} [client]
 * @property {string} [reason]
 * @property {string|null} sha   the version's first 8 characters (null: deleted)
 * @property {boolean} head      the version the note has now
 * @property {boolean} restorable  an earlier version whose content is kept
 * @property {DiffLine[]|null} diff  against the version before it (null: none, or not kept)
 * @property {boolean} [truncated]
 * @property {string[]} [violations]
 */
/**
 * @typedef {Object} WritingView
 * @property {string} session
 * @property {string} agent
 * @property {string} [client]
 * @property {string[]} keys  sections a prepared write adds or removes ([] when unknown)
 */
/**
 * @typedef {Object} NoteView
 * @property {string} rel
 * @property {string|null} updated  ISO of the last write
 * @property {string|null} stale   the whole note is stale: the reason
 * @property {{ stale: boolean, external: boolean, writing: boolean, denied: boolean }} flags
 * @property {SectionView[]} sections
 * @property {HistoryView[]} history  newest first, at most 20
 * @property {number} versions   entries in the note's whole history
 * @property {WritingView[]} writing
 * @property {Array<{ ts: string, session: string, sections: Array<{ key: string, owners: string[] }> }>} denials  newest first, at most 5
 */
/**
 * @typedef {Object} SessionView
 * @property {string} session
 * @property {string} agent
 * @property {string} [client]
 * @property {string} started
 * @property {string} lastSeen
 * @property {string} [intent]
 * @property {string[]} writing  notes it is writing (a prepared write, or declared)
 * @property {string[]} touched  notes it wrote in the last 24 h
 */
/**
 * @typedef {Object} NoticeView
 * @property {string} id
 * @property {string} rel
 * @property {string} ts
 * @property {LedgerEntry['op']} op
 * @property {string} session
 * @property {string} agent
 * @property {string} [client]
 * @property {string} [reason]
 * @property {string[]} added
 * @property {string[]} removed
 * @property {string[]} changed
 * @property {string[]} [violations]
 */
/**
 * @typedef {Object} SearchView
 * @property {string} query
 * @property {Array<{ rel: string, key: string, path: string[], score: number, text: string, stale?: string }>} hits
 * @property {string[]} [warnings]
 * @property {string} [degraded]
 * @property {string} [error]
 */
/**
 * @typedef {Object} RootView
 * @property {string} dir
 * @property {string} label
 * @property {'data'|'empty'|'error'} state
 * @property {{ message: string, command: string }|null} error
 * @property {SessionView[]} sessions
 * @property {NoteView[]} notes
 * @property {NoticeView[]} notices  the last 24 h, newest first, at most 50
 * @property {{ entries: number, losses: number, lossDetails: string[], clashes: number, clashesOpen: number, authorized: number, denials: number, unrecorded: number }|null} audit
 * @property {SearchView[]} searches
 * @property {string|null} initial  the note shown first
 */
/**
 * @typedef {Object} GuiData
 * @property {1} v
 * @property {string} name
 * @property {string} generatedAt
 * @property {boolean} watch
 * @property {RootView[]} roots
 */

const HISTORY_ROWS = 20;
const DIFFED = 5;
const DIFF_LINES = 60;
const HIT_CHARS = 240;
const DAY_MS = 86_400_000;

/**
 * A line diff with two lines of context, at most `max` lines. Common head and tail are
 * trimmed first; a middle too large for the table is shown as removed-then-added.
 * @param {string} before
 * @param {string} after
 * @param {number} [max]
 * @returns {{ lines: DiffLine[], truncated: boolean }}
 */
export function diffLines(before, after, max = DIFF_LINES) {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  /** @type {DiffLine[]} */
  let middle = [];
  if (am.length * bm.length > 2_000_000) {
    middle = [...am.map((text) => ({ op: /** @type {const} */ ('-'), text })), ...bm.map((text) => ({ op: /** @type {const} */ ('+'), text }))];
  } else {
    const n = am.length;
    const m = bm.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = am[i] === bm[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        middle.push({ op: ' ', text: am[i] });
        i++;
        j++;
      } else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) middle.push({ op: '-', text: am[i++] });
      else middle.push({ op: '+', text: bm[j++] });
    }
  }
  /** @type {DiffLine[]} */
  const all = [...a.slice(Math.max(0, head - 2), head).map((text) => ({ op: /** @type {const} */ (' '), text })), ...middle, ...a.slice(a.length - tail, a.length - tail + 2).map((text) => ({ op: /** @type {const} */ (' '), text }))];
  if (head > 2) all.unshift({ op: '…', text: `${head - 2} unchanged line(s)` });
  if (tail > 2) all.push({ op: '…', text: `${tail - 2} unchanged line(s)` });
  // Long runs of context inside the middle collapse too.
  /** @type {DiffLine[]} */
  const lines = [];
  for (let k = 0; k < all.length; k++) {
    const line = all[k];
    if (line.op === ' ') {
      let end = k;
      while (end < all.length && all[end].op === ' ') end++;
      if (end - k > 5) {
        lines.push(all[k], all[k + 1], { op: '…', text: `${end - k - 4} unchanged line(s)` }, all[end - 2], all[end - 1]);
        k = end - 1;
        continue;
      }
    }
    lines.push(line);
  }
  return lines.length > max ? { lines: lines.slice(0, max), truncated: true } : { lines, truncated: false };
}

/** @param {Author} a @param {{ reason?: string }} [extra] */
function who(a, extra = {}) {
  return { session: a.session, agent: a.agent, ...(a.client ? { client: a.client } : {}), ...(extra.reason !== undefined ? { reason: extra.reason } : {}) };
}

/** @param {Root} root @param {string|null} sha */
function contentOf(root, sha) {
  if (sha === null || !hasObject(root, sha)) return null;
  try {
    return getObject(root, sha);
  } catch {
    return null; // a torn object: shown as "no diff"; audit and doctor report it
  }
}

/**
 * Prepared writes waiting for their commit, read raw (the store's reader records errors;
 * the GUI must not write).
 * @param {Root} root
 * @param {number} now
 * @returns {Array<{ rel: string, session: string, delta: Record<string, number>, ts: string }>}
 */
function pendingWrites(root, now) {
  const dir = path.join(root.stateDir, 'run', 'pending');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const windowMs = root.config.activeWindowMinutes * 60_000;
  /** @type {Array<{ rel: string, session: string, delta: Record<string, number>, ts: string }>} */
  const out = [];
  for (const name of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (typeof p?.rel !== 'string' || typeof p?.author?.session !== 'string' || now - Date.parse(p.ts) > windowMs) continue;
      out.push({ rel: p.rel, session: p.author.session, delta: p.delta && typeof p.delta === 'object' ? p.delta : {}, ts: p.ts });
    } catch {
      // unreadable: doctor reports it; the GUI only reads
    }
  }
  return out;
}

/** @param {string} text @param {number} n */
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * @param {Root} root
 * @param {{ now: Date, queries: string[], k?: number, reader?: 'hybrid'|'lexical' }} options
 * @returns {Promise<RootView>}
 */
async function collectRoot(root, { now, queries, k, reader }) {
  const t = now.getTime();
  /** @type {RootView} */
  const view = { dir: root.dir, label: path.basename(root.dir) || root.dir, state: 'data', error: null, sessions: [], notes: [], notices: [], audit: null, searches: [], initial: null };
  const ledger = readLedger(root);
  const { entries } = ledger;
  if (ledger.broken > 0) {
    view.state = 'error';
    view.error = { message: `The ledger chain is broken at entry ${firstBrokenEntry(root)}: a line was edited or removed.`, command: `${NAME} doctor` };
  } else if (ledger.corrupt > 0) {
    view.state = 'error';
    view.error = { message: `The ledger has ${ledger.corrupt} unreadable line(s).`, command: `${NAME} doctor` };
  }

  const active = activeSessions(root, { now });
  const pending = pendingWrites(root, t);
  const denials = readDenials(root);
  const recent = entries.filter((e) => e.op !== 'adopt' && t - Date.parse(e.ts) <= DAY_MS);

  view.sessions = active.map((p) => {
    const writing = new Set([...(p.paths ?? []), ...pending.filter((w) => w.session === p.author.session).map((w) => w.rel)]);
    const touched = new Set(recent.filter((e) => e.author.session === p.author.session).map((e) => e.rel));
    return {
      ...who(p.author),
      started: p.started,
      lastSeen: p.lastSeen,
      ...(p.intent ? { intent: p.intent } : {}),
      writing: [...writing].sort(),
      touched: [...touched].sort(),
    };
  });

  const levels = root.config.guardLevels;
  for (const rel of listNotes(root)) {
    let text;
    try {
      text = fs.readFileSync(path.join(root.dir, rel), 'utf8');
    } catch {
      continue; // vanished between the listing and the read
    }
    const parsed = parseNote(text);
    const own = lineage(entries, rel);
    const owners = ownersIn(entries, rel);
    /** @type {Map<string, LedgerEntry>} */
    const last = new Map();
    for (const e of own) {
      if (e.op === 'adopt' || (e.before === null && e.op !== 'move')) for (const s of parsed.sections) last.set(s.key, e);
      for (const key of e.changed) last.set(key, e);
      for (const [key, d] of Object.entries(e.delta)) if (d > 0) last.set(key, e);
    }
    const noteDenials = denials.filter((d) => d.rel === rel).reverse();
    const deniedKeys = new Set(noteDenials.filter((d) => t - Date.parse(d.ts) <= DAY_MS).flatMap((d) => (d.sections ?? []).map((s) => s.key)));
    /** @type {WritingView[]} */
    const writing = [];
    for (const s of view.sessions) {
      if (!s.writing.includes(rel)) continue;
      const keys = new Set(pending.filter((w) => w.session === s.session && w.rel === rel).flatMap((w) => Object.entries(w.delta).filter(([, d]) => d !== 0).map(([key]) => key)));
      writing.push({ session: s.session, agent: s.agent, ...(s.client ? { client: s.client } : {}), keys: [...keys] });
    }
    const writingKeys = new Set(writing.flatMap((w) => w.keys));
    const noteStale = staleness(parsed, null, now, root.config.metadataAliases);

    const sections = parsed.sections.map((s, i) => {
      const e = last.get(s.key) ?? null;
      const ownerIds = [...(owners.get(s.key)?.keys() ?? [])];
      const stale = staleness(parsed, markerScope(text, parsed, i), now, root.config.metadataAliases);
      /** @type {SectionState} */
      let st = 'normal';
      if (deniedKeys.has(s.key)) st = 'denied';
      else if (writingKeys.has(s.key)) st = 'writing';
      else if (stale) st = 'stale';
      else if (e && e.author.session === 'external') st = 'external';
      else if (ownerIds.length === 0 && (!e || e.op === 'adopt') && s.level <= levels) st = 'adopted';
      /** @type {SectionView} */
      const sv = {
        key: s.key,
        title: s.title,
        level: s.level,
        owners: ownerIds,
        last: e ? { id: e.id, ts: e.ts, op: e.op, ...who(e.author, e) } : null,
        st,
      };
      if (stale) sv.stale = stale.reason;
      return sv;
    });

    const newest = [...own].reverse();
    const head = newest[0]?.after ?? null;
    const history = newest.slice(0, HISTORY_ROWS).map((e, i) => {
      /** @type {HistoryView} */
      const h = {
        id: e.id,
        ts: e.ts,
        op: e.op,
        ...who(e.author, e),
        sha: e.after === null ? null : e.after.slice(0, 8),
        head: i === 0,
        restorable: i > 0 && e.after !== null && e.after !== head && hasObject(root, e.after),
        diff: null,
      };
      if (e.violations?.length) h.violations = [...e.violations];
      if (i < DIFFED && e.before !== null && e.after !== null && e.before !== e.after) {
        const a = contentOf(root, e.before);
        const b = contentOf(root, e.after);
        if (a !== null && b !== null) {
          const d = diffLines(a, b);
          h.diff = d.lines;
          if (d.truncated) h.truncated = true;
        }
      }
      return h;
    });

    view.notes.push({
      rel,
      updated: newest[0]?.ts ?? null,
      stale: noteStale ? noteStale.reason : null,
      flags: {
        stale: Boolean(noteStale) || sections.some((s) => s.stale),
        external: sections.some((s) => s.st === 'external'),
        writing: writing.length > 0,
        denied: sections.some((s) => s.st === 'denied'),
      },
      sections,
      history,
      versions: own.length,
      writing,
      denials: noteDenials.slice(0, 5).map((d) => ({ ts: d.ts, session: d.session, sections: d.sections ?? [] })),
    });
  }
  if (view.state === 'data' && view.notes.length === 0) view.state = 'empty';

  view.notices = recent
    .slice(-50)
    .reverse()
    .map((e) => {
      const added = Object.entries(e.delta).filter(([, n]) => n > 0).map(([key]) => key);
      const removed = Object.entries(e.delta).filter(([, n]) => n < 0).map(([key]) => key);
      /** @type {NoticeView} */
      const n = { id: e.id, rel: e.rel, ts: e.ts, op: e.op, ...who(e.author, e), added, removed, changed: e.changed.filter((key) => !added.includes(key) && !removed.includes(key)) };
      if (e.violations?.length) n.violations = [...e.violations];
      return n;
    });

  const a = audit(root);
  view.audit = {
    entries: a.entries,
    losses: a.losses.length,
    lossDetails: a.losses.slice(0, 5).map((l) => l.detail),
    clashes: a.clashes.length,
    clashesOpen: a.clashes.filter((c) => c.state === 'open').length,
    authorized: a.authorized.length,
    denials: a.denials.length,
    unrecorded: a.unrecorded.length,
  };

  for (const query of queries) {
    try {
      const res = await search([root], query, { ...(k ? { k } : {}), ...(reader ? { reader } : {}), now });
      view.searches.push({
        query,
        hits: res.hits.map((h) => ({ rel: h.rel, key: h.section.key, path: [...h.section.path], score: h.score, text: clip(h.text, HIT_CHARS), ...(h.stale ? { stale: h.stale.reason } : {}) })),
        ...(res.warnings?.length ? { warnings: res.warnings } : {}),
        ...(res.degraded ? { degraded: res.degraded } : {}),
      });
    } catch (e) {
      view.searches.push({ query, hits: [], error: /** @type {Error} */ (e).message });
    }
  }

  const lastWritten = [...entries].reverse().find((e) => e.op !== 'adopt' && e.after !== null && view.notes.some((n) => n.rel === e.rel));
  view.initial = lastWritten?.rel ?? view.notes[0]?.rel ?? null;
  return view;
}

/**
 * The page's data for these roots.
 * @param {Root[]} roots
 * @param {{ now?: Date, queries?: string[], note?: string, k?: number, reader?: 'hybrid'|'lexical', watch?: boolean }} [options]
 * @returns {Promise<GuiData>}
 */
export async function collectGui(roots, options = {}) {
  const now = options.now ?? new Date();
  /** @type {RootView[]} */
  const views = [];
  for (const root of roots) {
    try {
      views.push(await collectRoot(root, { now, queries: options.queries ?? [], k: options.k, reader: options.reader }));
    } catch (e) {
      views.push({ dir: root.dir, label: path.basename(root.dir), state: 'error', error: { message: /** @type {Error} */ (e).message, command: `${NAME} doctor` }, sessions: [], notes: [], notices: [], audit: null, searches: [], initial: null });
    }
  }
  if (options.note !== undefined) {
    const want = options.note.replace(/\\/g, '/');
    const owner = views.find((v) => v.notes.some((n) => n.rel === want || path.posix.join(v.dir, n.rel) === want));
    if (!owner) throw new Error(`${options.note} is not a note in ${roots.map((r) => r.dir).join(', ')}`);
    owner.initial = owner.notes.find((n) => n.rel === want || path.posix.join(owner.dir, n.rel) === want)?.rel ?? owner.initial;
    views.splice(views.indexOf(owner), 1);
    views.unshift(owner);
  }
  return { v: 1, name: NAME, generatedAt: now.toISOString(), watch: Boolean(options.watch), roots: views };
}
