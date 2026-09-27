// The counter of D-7 (docs/arquitectura/03-contratos.md §4.15): over a period, what was
// lost, what clashed but can be restored, what a person allowed, what the guard blocked,
// and what changed on disk without being recorded yet. Read-only: no lock, no writes.
//
// A loss is content of a session that disappeared because of a write by another one,
// external or not, AND that cannot be restored or went without being recorded.
import fs from 'node:fs';
import { MnemeError } from './errors.js';
import { headIn, headsIn, ownersIn, readLedger } from './ledger.js';
import { getObject, hasObject, sha256 } from './objects.js';
import { resolveInRoot } from './paths.js';
import { listNotes } from './root.js';
import { headingCounts } from './sections.js';
import { readDenials } from './sessions.js';

/** @typedef {import('./types.js').LedgerEntry} LedgerEntry */
/** @typedef {import('./types.js').Root} Root */
/** @typedef {import('./sessions.js').Denial} Denial */

/**
 * @typedef {Object} Loss
 * @property {'unrestorable'|'missing-version'|'ledger'} kind
 * @property {string} detail  one line for a person
 * @property {string} [rel]
 * @property {string} [sha]   the version that is missing
 * @property {string[]} [keys] for 'unrestorable': the sections removed
 * @property {LedgerEntry} [entry]
 */

/**
 * @typedef {Object} Clash  a write removed sections another session wrote
 * @property {LedgerEntry} entry
 * @property {string} rel      the note's name now (following moves)
 * @property {string[]} keys   the sections removed (the entry's `violations`; for a fork, the
 *   sections of the overwritten version the write does not have — empty when the change was
 *   inside sections)
 * @property {boolean} restorable  the version before the write is kept
 * @property {'open'|'repaired'} state  whether some of those sections are still missing now
 * @property {true} [fork]     the write started from a version that was no longer current
 * @property {string|null} [overwritten]  for a fork: the current version it was written over
 */

/**
 * @typedef {Object} AuditResult
 * @property {string|null} since  ISO, or null for the whole ledger
 * @property {number} entries     ledger entries read
 * @property {{ corrupt: number, broken: number }} ledger
 * @property {Loss[]} losses
 * @property {Clash[]} clashes
 * @property {Array<{ entry: LedgerEntry, keys: string[] }>} authorized  removals of others' sections under a lease
 * @property {Array<Denial & { resumed: boolean }>} denials
 * @property {string[]} unrecorded  notes whose content on disk is not the ledger's head
 */

/**
 * The start of the period, in ms (null: no start). A date without a time is local midnight,
 * like the times a person reads in the output.
 * @param {Date|string|number|null|undefined} since
 * @returns {number|null}
 */
export function parseSince(since) {
  if (since === undefined || since === null) return null;
  const value = typeof since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00` : since;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`--since is not a date: "${String(since)}" (use 2026-09-24 or 2026-09-24T21:54)`);
  return ms;
}

/**
 * The name the note written at entries[i] has now, following later moves.
 * @param {LedgerEntry[]} entries
 * @param {number} i
 */
function nameNow(entries, i) {
  let name = entries[i].rel;
  for (let j = i + 1; j < entries.length; j++) {
    const e = entries[j];
    if (e.op === 'move' && e.from === name) name = e.rel;
  }
  return name;
}

/**
 * @param {Root} root
 * @param {string|null} sha
 * @returns {string|null}  null when there is no such version (deleted, or missing)
 */
const contentOf = (root, sha) => (sha !== null && hasObject(root, sha) ? getObject(root, sha) : null);

/**
 * Notes whose content on disk differs from the ledger's head: what the next access or
 * `scan` will record. The same set of notes `scan` walks.
 * @param {Root} root
 * @param {LedgerEntry[]} entries
 * @returns {string[]}
 */
function unrecordedNotes(root, entries) {
  const heads = headsIn(entries);
  const known = [...heads].filter(([, sha]) => sha !== null).map(([rel]) => rel);
  /** @type {string[]} */
  const out = [];
  for (const rel of [...new Set([...listNotes(root), ...known])].sort()) {
    let note;
    try {
      note = resolveInRoot(root, rel);
    } catch (e) {
      if (e instanceof MnemeError) continue; // under a nested root, or leaves the root: scan skips it too
      throw e;
    }
    let content = null;
    try {
      content = fs.readFileSync(note.abs, 'utf8');
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === 'EISDIR') continue;
      if (code !== 'ENOENT') throw e;
    }
    const sha = content === null ? null : sha256(content);
    if (sha !== (heads.get(note.rel) ?? null)) out.push(note.rel);
  }
  return out;
}

/**
 * The balance of a period. Read-only.
 * @param {Root} root
 * @param {{ since?: Date|string|number|null }} [options]
 * @returns {AuditResult}
 */
export function audit(root, { since } = {}) {
  const from = parseSince(since);
  const inPeriod = (/** @type {string} */ ts) => from === null || Date.parse(ts) >= from;
  const { entries, corrupt, broken } = readLedger(root);
  const levels = root.config.guardLevels;

  /** @type {Loss[]} */
  const losses = [];
  /** @type {Set<string>} */
  const counted = new Set(); // missing shas already reported, so one missing version is one loss
  if (broken > 0 || corrupt > 0) {
    losses.push({
      kind: 'ledger',
      detail: `the ledger has ${broken} line(s) edited or removed in the middle and ${corrupt} unreadable: something changed without being recorded`,
    });
  }

  /** @type {Clash[]} */
  const clashes = [];
  /** @type {AuditResult['authorized']} */
  const authorized = [];
  entries.forEach((e, i) => {
    if (!inPeriod(e.ts)) return;
    if (e.violations?.length) {
      const rel = nameNow(entries, i);
      const restorable = e.before !== null && hasObject(root, e.before);
      const was = restorable ? headingCounts(/** @type {string} */ (contentOf(root, e.before)), levels) : null;
      const current = contentOf(root, headIn(entries, rel));
      const now = current === null ? new Map() : headingCounts(current, levels);
      const open = e.violations.some((k) => (now.get(k) ?? 0) < (was?.get(k) ?? 1));
      clashes.push({ entry: e, rel, keys: [...e.violations], restorable, state: open ? 'open' : 'repaired' });
      if (!restorable) {
        if (e.before !== null) counted.add(e.before);
        losses.push({
          kind: 'unrestorable',
          rel,
          sha: e.before ?? undefined,
          keys: [...e.violations],
          entry: e,
          detail: `${e.op} ${e.id} removed ${e.violations.join(', ')} and the version before it is not in objects/`,
        });
      }
    }
    if (e.override) {
      const owners = ownersIn(entries.slice(0, i), e.rel);
      const keys = Object.entries(e.delta)
        .filter(([key, d]) => d < 0 && [...(owners.get(key) ?? new Map())].some(([s, n]) => s !== e.author.session && n > 0))
        .map(([key]) => key);
      if (keys.length) authorized.push({ entry: e, keys });
    }
  });

  // Forks: a write whose `before` is not the version the note had at that point of the
  // ledger. Two holders of the lock at once (25/09) leave exactly this, and nothing else
  // shows it: measured against its own `before` the second write removed nothing, so it has
  // no `violations`, and every version is in objects/. Same notion of "current" as headsIn.
  /** @type {Map<string, string|null>} */
  const heads = new Map();
  entries.forEach((e, i) => {
    if (e.op === 'move' && e.from !== undefined) {
      heads.delete(e.from);
      heads.set(e.rel, e.after);
      return;
    }
    const current = heads.get(e.rel);
    heads.set(e.rel, e.after);
    if (e.op === 'adopt' || current === undefined || e.before === current || !inPeriod(e.ts)) return;
    const rel = nameNow(entries, i);
    const restorable = current === null || hasObject(root, current);
    const was = current === null ? new Map() : restorable ? headingCounts(/** @type {string} */ (contentOf(root, current)), levels) : null;
    const wrote = contentOf(root, e.after);
    const got = wrote === null ? new Map() : headingCounts(wrote, levels);
    const keys = was ? [...was].filter(([k, n]) => (got.get(k) ?? 0) < n).map(([k]) => k) : [];
    const nowContent = contentOf(root, headIn(entries, rel));
    const now = nowContent === null ? new Map() : headingCounts(nowContent, levels);
    const open = keys.length === 0 || keys.some((k) => (now.get(k) ?? 0) < (was?.get(k) ?? 1));
    clashes.push({ entry: e, rel, keys, restorable, state: open ? 'open' : 'repaired', fork: true, overwritten: current });
    if (!restorable && current !== null) {
      counted.add(current);
      losses.push({
        kind: 'unrestorable',
        rel,
        sha: current,
        keys,
        entry: e,
        detail: `${e.op} ${e.id} was written over version ${current.slice(0, 12)}, which it never read, and that version is not in objects/`,
      });
    }
  });

  for (const e of entries) {
    if (!inPeriod(e.ts)) continue;
    for (const sha of [e.before, e.after]) {
      if (sha === null || counted.has(sha) || hasObject(root, sha)) continue;
      counted.add(sha);
      losses.push({ kind: 'missing-version', rel: e.rel, sha, entry: e, detail: `version ${sha.slice(0, 12)} of ${e.rel} (entry ${e.id}) is not in objects/` });
    }
  }

  const denials = readDenials(root)
    .filter((d) => inPeriod(d.ts))
    .map((d) => ({
      ...d,
      resumed: entries.some((e) => e.author.session === d.session && e.rel === d.rel && e.op !== 'adopt' && Date.parse(e.ts) >= Date.parse(d.ts)),
    }));

  return {
    since: from === null ? null : new Date(from).toISOString(),
    entries: entries.length,
    ledger: { corrupt, broken },
    losses,
    clashes,
    authorized,
    denials,
    unrecorded: unrecordedNotes(root, entries),
  };
}
