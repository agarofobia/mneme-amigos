// The store: the ONLY write path to a governed root (D-P9). The Claude Code hooks and the
// MCP tools both call these functions; every operation that touches a note runs under the
// root's lock and starts with the watcher, which records whatever changed on disk behind
// the store's back.
//
// TEST-ONLY switches (docs/arquitectura/03-contratos.md §4.8):
//   MNEME_TEST_RACE_DELAY_MS=<n>                 wait n ms between reading a note and writing it
//   MNEME_TEST_CRASH_AT=before-rename|before-ledger  process.exit(137) at that point of a write
//   MNEME_UNSAFE_NO_CAS=1                        skip the check before the rename (negative control of TE-2)
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { MnemeError } from './errors.js';
import { checkSections, guardMessage } from './guard.js';
import { activeLease, safeFileName } from './leases.js';
import { appendEntries, headIn, headsIn, lineage, newId, ownersIn, readLedger } from './ledger.js';
import { findLinks, relink, resolveTarget } from './links.js';
import { recordError, withLock } from './lock.js';
import { NAME, STATE_DIR } from './name.js';
import { findObjects, getObject, hasObject, putObject, sha256, writeFileAtomic } from './objects.js';
import { realPathLoose, resolveInRoot } from './paths.js';
import { listNotes, openRoot } from './root.js';
import { headingCounts, sectionTexts } from './sections.js';

/** @typedef {import('./types.js').Author} Author */
/** @typedef {import('./types.js').LedgerEntry} LedgerEntry */
/** @typedef {import('./types.js').Root} Root */
/** @typedef {import('./types.js').WriteResult} WriteResult */
/** @typedef {import('./ledger.js').NewEntry} NewEntry */
/** @typedef {{ key: string, owners: string[] }} Lost */
/**
 * A prepared two-phase write, waiting for its commit: `<stateDir>/run/pending/<id>.json`.
 * @typedef {Object} Pending
 * @property {1} v
 * @property {string} id
 * @property {string} rel
 * @property {Author} author
 * @property {string} tool
 * @property {string} [reason]
 * @property {string|null} before  sha of the note when the write was prepared
 * @property {string} after        sha the author predicted
 * @property {Record<string, number>} delta  what the author intended: counts(after) - counts(before)
 * @property {string} ts
 * @property {{ lease: string }} [override]
 */
/** @typedef {{ root: Root, entries: LedgerEntry[] }} Ctx */

/** @type {Author} */
const EXTERNAL = Object.freeze({ session: 'external', agent: 'external' });

// ── small helpers ───────────────────────────────────────────────────────────

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test-only: widens the read-to-write window (negative control of TE-2). */
async function testRaceDelay() {
  const ms = Number(process.env.MNEME_TEST_RACE_DELAY_MS ?? 0);
  if (ms > 0) await sleep(ms);
}

/**
 * Test-only: dies at a named point of a write (TE-3).
 * @param {'before-rename'|'before-ledger'} point
 */
function crashAt(point) {
  if (process.env.MNEME_TEST_CRASH_AT === point) process.exit(137);
}

/** @param {Author|undefined} author */
function requireAuthor(author) {
  if (!author || typeof author.session !== 'string' || author.session.trim() === '') {
    throw new MnemeError(
      'NO_SESSION',
      'Every write needs an author: pass { author: { session, agent } } with the id of the session that writes.',
    );
  }
}

/**
 * The note's text, or null when there is no file.
 * @param {string} abs
 * @param {string} rel
 * @returns {string|null}
 */
function readCurrent(abs, rel) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === 'ENOENT') return null;
    if (code === 'EISDIR') throw new MnemeError('NOTE_NOT_FOUND', `${rel} is a directory, not a note.`);
    throw e;
  }
}

/**
 * Change in copies of every heading key at level <= `levels`.
 * @param {string|null} before
 * @param {string|null} after
 * @param {number} levels
 * @returns {Record<string, number>}
 */
function countsDelta(before, after, levels) {
  const was = before === null ? new Map() : headingCounts(before, levels);
  const now = after === null ? new Map() : headingCounts(after, levels);
  /** @type {Record<string, number>} */
  const delta = {};
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const d = (now.get(key) ?? 0) - (was.get(key) ?? 0);
    if (d !== 0) delta[key] = d;
  }
  return delta;
}

/**
 * Keys (every level) of the sections whose own text changed, added or removed; '' is the
 * text before the first heading.
 * @param {string|null} before
 * @param {string|null} after
 * @returns {string[]}
 */
function changedKeys(before, after) {
  const was = before === null ? new Map() : sectionTexts(before);
  const now = after === null ? new Map() : sectionTexts(after);
  /** @type {Set<string>} */
  const out = new Set();
  for (const occurrence of new Set([...now.keys(), ...was.keys()])) {
    // Trailing whitespace is not content: appending a section after another one moves the
    // blank line that separates them into the previous section's range, and comparing raw
    // text told its owner "changed ## X" when nobody touched it (M5 real door, 24/09).
    if ((was.get(occurrence) ?? '').trimEnd() === (now.get(occurrence) ?? '').trimEnd()) continue;
    out.add(occurrence.slice(0, occurrence.lastIndexOf('#')));
  }
  return [...out];
}

/**
 * What a raced write may be credited with: only what its author intended AND what
 * actually happened, key by key, in the same direction.
 * @param {Record<string, number>} intended
 * @param {Record<string, number>} actual
 */
function intersect(intended, actual) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [key, i] of Object.entries(intended)) {
    const a = actual[key] ?? 0;
    if (i > 0 && a > 0) out[key] = Math.min(i, a);
    else if (i < 0 && a < 0) out[key] = Math.max(i, a);
  }
  return out;
}

/**
 * Keys whose count went down and that some session passing `counts` owns.
 * @param {Record<string, number>} delta
 * @param {Map<string, Map<string, number>>} owners
 * @param {(session: string) => boolean} counts
 */
function removedOwned(delta, owners, counts) {
  return Object.entries(delta)
    .filter(([key, d]) => d < 0 && [...(owners.get(key) ?? new Map())].some(([s, n]) => n > 0 && counts(s)))
    .map(([key]) => key);
}

/**
 * @param {Omit<NewEntry, 'v'|'id'|'ts'>} fields
 * @returns {NewEntry}
 */
const makeEntry = (fields) => ({ v: 1, id: newId(), ts: new Date().toISOString(), ...fields });

/**
 * @param {Ctx} ctx
 * @param {NewEntry[]} list
 */
function append(ctx, list) {
  const written = appendEntries(ctx.root, list);
  ctx.entries.push(...written);
  return written;
}

/** @param {Root} root @returns {Ctx} */
const context = (root) => ({ root, entries: readLedger(root).entries });

/**
 * @template T
 * @param {Root} root
 * @param {() => Promise<T>|T} fn
 */
const locked = (root, fn) => withLock(root, fn, { timeoutMs: root.config.lockTimeoutMs });

/**
 * The content of a version the ledger points to. A missing object means the history of
 * the note is damaged: that is said, not papered over.
 * @param {Root} root
 * @param {string|null} sha
 * @param {string} rel
 */
function versionOf(root, sha, rel) {
  if (sha === null) return null;
  try {
    return getObject(root, sha);
  } catch (e) {
    if (e instanceof MnemeError && e.code === 'VERSION_NOT_FOUND') {
      throw new MnemeError(
        'VERSION_NOT_FOUND',
        `The ledger says ${rel} is at version ${sha}, but that version is missing from ${STATE_DIR}/objects: the history of this note is damaged. Run ${NAME} doctor.`,
      );
    }
    throw e;
  }
}

// ── pending two-phase writes ────────────────────────────────────────────────

/** @param {Root} root */
const pendingDir = (root) => path.join(root.stateDir, 'run', 'pending');

/** @param {Root} root @param {string} id */
const pendingFile = (root, id) => path.join(pendingDir(root), `${safeFileName(id)}.json`);

/**
 * The id of a prepared write when the caller gives no key: sha256(session + rel + after).
 * @param {string} session
 * @param {string} rel
 * @param {string} after
 */
export const pendingIdFor = (session, rel, after) => sha256(session + rel + after);

/** @param {unknown} x @returns {x is Pending} */
function isPending(x) {
  if (x === null || typeof x !== 'object') return false;
  const p = /** @type {Record<string, unknown>} */ (x);
  return typeof p.id === 'string' && typeof p.rel === 'string' && typeof p.after === 'string' && p.author !== null && typeof p.author === 'object';
}

/**
 * @param {Root} root
 * @param {string} file
 * @returns {Pending|null}
 */
function readPending(root, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    recordError(root, 'store', `unreadable pending write ${file}, ignored: ${/** @type {Error} */ (e).message}`);
    return null;
  }
  if (!isPending(parsed)) {
    recordError(root, 'store', `malformed pending write ${file}, ignored`);
    return null;
  }
  return parsed;
}

/**
 * The oldest prepared write of `rel` whose predicted content has this sha.
 * @param {Root} root
 * @param {string} rel
 * @param {string} sha
 * @returns {{ pending: Pending, file: string }|null}
 */
function findPending(root, rel, sha) {
  let names;
  try {
    names = fs.readdirSync(pendingDir(root));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
  /** @type {Array<{ pending: Pending, file: string }>} */
  const found = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(pendingDir(root), name);
    const pending = readPending(root, file);
    if (pending && pending.rel === rel && pending.after === sha) found.push({ pending, file });
  }
  found.sort((a, b) => (a.pending.ts < b.pending.ts ? -1 : a.pending.ts > b.pending.ts ? 1 : 0));
  return found[0] ?? null;
}

/**
 * Records a prepared write whose tool already ran, as its author. `before` is what the
 * ledger had; the delta is what the author intended, limited to what happened.
 * @param {Ctx} ctx
 * @param {Pending} pending
 * @param {string} current
 * @param {{ late: boolean }} how
 * @returns {LedgerEntry}
 */
function confirm(ctx, pending, current, { late }) {
  const { root } = ctx;
  const levels = root.config.guardLevels;
  const head = headIn(ctx.entries, pending.rel);
  const headContent = versionOf(root, head, pending.rel);
  const sha = putObject(root, current);
  const actual = countsDelta(headContent, current, levels);
  const raced = sha !== pending.after || head !== pending.before;
  const violations = raced
    ? removedOwned(actual, ownersIn(ctx.entries, pending.rel), (s) => s !== pending.author.session && s !== EXTERNAL.session)
    : [];
  const [entry] = append(ctx, [
    makeEntry({
      rel: pending.rel,
      op: pending.tool === 'Write' ? 'write' : 'edit',
      author: pending.author,
      reason: pending.reason,
      before: head,
      after: sha,
      delta: intersect(pending.delta, actual),
      changed: changedKeys(headContent, current),
      override: pending.override,
      violations,
      raced: raced || undefined,
      late: late || undefined,
    }),
  ]);
  return entry;
}

// ── the watcher ─────────────────────────────────────────────────────────────

/**
 * Compares the note on disk with what the ledger says. If they differ: a prepared write
 * whose commit never ran is confirmed late as its author; anything else is recorded as
 * `external` (or `delete`), with the owned sections it removed in `violations`.
 * Call under the lock.
 * @param {Ctx} ctx
 * @param {string} rel
 * @param {string} abs
 * @returns {{ current: string|null, recorded: LedgerEntry[] }}
 */
function watch(ctx, rel, abs) {
  const { root } = ctx;
  const head = headIn(ctx.entries, rel);
  const current = readCurrent(abs, rel);
  const sha = current === null ? null : sha256(current);
  if (sha === head) return { current, recorded: [] };
  if (current !== null && sha !== null) {
    const found = findPending(root, rel, sha);
    if (found) {
      const entry = confirm(ctx, found.pending, current, { late: true });
      fs.rmSync(found.file, { force: true });
      return { current, recorded: [entry] };
    }
  }
  const levels = root.config.guardLevels;
  const headContent = versionOf(root, head, rel);
  if (current !== null) putObject(root, current);
  const delta = countsDelta(headContent, current, levels);
  const [entry] = append(ctx, [
    makeEntry({
      rel,
      op: current === null ? 'delete' : 'external',
      author: EXTERNAL,
      before: head,
      after: sha,
      delta,
      changed: changedKeys(headContent, current),
      violations: removedOwned(delta, ownersIn(ctx.entries, rel), (s) => s !== EXTERNAL.session),
    }),
  ]);
  return { current, recorded: [entry] };
}

// ── the guard, as the store applies it ──────────────────────────────────────

/**
 * @param {Ctx} ctx
 * @param {string} rel
 * @param {string|null} before
 * @param {string} after
 * @param {Author} author
 * @param {string} tool
 * @returns {{ ok: true, override?: { lease: string } } | { ok: false, lost: Lost[], message: string }}
 */
function decide(ctx, rel, before, after, author, tool) {
  const { root } = ctx;
  const owners = ownersIn(ctx.entries, rel);
  const check = checkSections({ before, after, owners, session: author.session, levels: root.config.guardLevels });
  if (check.ok) return { ok: true };
  const lease = activeLease(root, author.session, rel);
  if (lease) return { ok: true, override: { lease: lease.id } };
  // D-P11: the person may let the guard record instead of deny; the removal is then
  // authorized by the config, and audit lists it with the lease removals.
  if (root.config.guard === 'record') return { ok: true, override: { lease: 'config:guard=record' } };
  const own = lineage(ctx.entries, rel);
  /** @type {Map<string, LedgerEntry[]>} */
  const entriesByKey = new Map();
  for (const { key, owners: sessions } of check.lost) {
    /** @type {LedgerEntry[]} */
    const list = [];
    for (const s of sessions) {
      const e = own.findLast((x) => x.author.session === s && (x.delta[key] ?? 0) > 0);
      if (e) list.push(e);
    }
    entriesByKey.set(key, list);
  }
  const message = guardMessage({
    rel,
    lost: check.lost,
    tool,
    entriesByKey,
    session: author.session,
    leaseMinutes: root.config.leaseMinutes,
  });
  return { ok: false, lost: check.lost, message };
}

/**
 * Guard, versions, atomic file write, ledger. Call under the lock, after the watcher.
 * @param {Ctx} ctx
 * @param {{ rel: string, abs: string }} note
 * @param {string|null} current
 * @param {string} next
 * @param {{ author: Author, reason?: string, tool: string, op: 'write'|'edit'|'restore', guard?: boolean }} how
 * @returns {WriteResult}
 */
function writeContent(ctx, { rel, abs }, current, next, { author, reason, tool, op, guard = true }) {
  const { root } = ctx;
  const decision = guard ? decide(ctx, rel, current, next, author, tool) : { ok: /** @type {const} */ (true) };
  if (!decision.ok) return { ok: false, lost: decision.lost, message: decision.message };
  // Compare-and-swap: under the lock nobody else should have written the note since the
  // watcher read it. If someone did (a second holder, 25/09; an editor), writing now would
  // drop their change without a trace: refuse, and the next access records theirs.
  if (next !== current && process.env.MNEME_UNSAFE_NO_CAS !== '1' && readCurrent(abs, rel) !== current) {
    throw new MnemeError(
      'NOTE_CHANGED',
      `${rel} changed while this write was being prepared: someone else wrote it. Nothing was written; read the note again and retry.`,
    );
  }
  const before = current === null ? null : putObject(root, current);
  const after = putObject(root, next);
  if (next !== current) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeFileAtomic(abs, next, { beforeRename: () => crashAt('before-rename') });
  }
  crashAt('before-ledger');
  const levels = root.config.guardLevels;
  const [entry] = append(ctx, [
    makeEntry({
      rel,
      op,
      author,
      reason,
      before,
      after,
      delta: countsDelta(current, next, levels),
      changed: changedKeys(current, next),
      override: 'override' in decision ? decision.override : undefined,
    }),
  ]);
  return { ok: true, entry };
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Makes `dir` a governed root. Without `adopt`, a folder that already has notes is
 * refused; with it, every note gets an `adopt` entry and its version stored, and nobody
 * owns its headings. Never modifies a note.
 * @param {string} dir
 * @param {{ adopt?: boolean, author?: Author, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<{ notes: number, bytes: number, ms: number }>}
 */
export async function initRoot(dir, { adopt = false, author, onProgress } = {}) {
  const started = performance.now();
  fs.mkdirSync(dir, { recursive: true });
  const real = realPathLoose(dir);
  const stateDir = `${real}/${STATE_DIR}`;
  if (fs.existsSync(stateDir)) {
    throw new MnemeError('ROOT_EXISTS', `${real} is already a governed root (it has ${STATE_DIR}/). Nothing to do.`);
  }
  const notes = listNotes({ dir: real, stateDir, config: loadConfig(stateDir) });
  if (notes.length > 0 && !adopt) {
    throw new MnemeError(
      'ROOT_HAS_NOTES',
      `${real} already has ${notes.length} notes. Run again with --adopt to govern them as they are (nothing will be modified).`,
    );
  }
  if (notes.length > 0) requireAuthor(author);
  try {
    fs.mkdirSync(stateDir);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'EEXIST') {
      throw new MnemeError('ROOT_EXISTS', `${real} is already a governed root (it has ${STATE_DIR}/). Nothing to do.`);
    }
    throw e;
  }
  try {
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{ "version": 1 }\n', 'utf8');
    fs.writeFileSync(path.join(stateDir, '.gitignore'), 'run/\nindex/\n', 'utf8');
    // Objects are addressed by the sha of their bytes: a line-ending conversion by git would break them.
    fs.writeFileSync(path.join(stateDir, '.gitattributes'), '* -text\n', 'utf8');
    fs.mkdirSync(path.join(stateDir, 'run'));
    fs.mkdirSync(path.join(stateDir, 'objects'));
    const root = openRoot(real);
    let bytes = 0;
    if (notes.length > 0) {
      const adopter = /** @type {Author} */ (author);
      await locked(root, () => {
        /** @type {NewEntry[]} */
        const batch = [];
        notes.forEach((rel, i) => {
          const raw = fs.readFileSync(`${real}/${rel}`);
          bytes += raw.length;
          const after = putObject(root, raw.toString('utf8'));
          batch.push(makeEntry({ rel, op: 'adopt', author: adopter, reason: 'adopt', before: null, after, delta: {}, changed: [] }));
          if ((i + 1) % 100 === 0) onProgress?.(i + 1, notes.length);
        });
        appendEntries(root, batch);
      });
    }
    return { notes: notes.length, bytes, ms: Math.round(performance.now() - started) };
  } catch (e) {
    // Undo only what this call created: a half-made state directory would read as a root.
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch (cleanup) {
      throw new Error(
        `init failed (${/** @type {Error} */ (e).message}) and ${stateDir} could not be removed (${/** @type {Error} */ (cleanup).message}): remove it by hand before retrying.`,
        { cause: e },
      );
    }
    throw e;
  }
}

/**
 * The current text of a note (after the watcher). Does not record the read (sessions do, L3).
 * @param {Root} root
 * @param {string} rel
 * @returns {Promise<{ content: string, sha: string }>}
 */
export async function readNote(root, rel) {
  const note = resolveInRoot(root, rel);
  return locked(root, () => {
    const { current } = watch(context(root), note.rel, note.abs);
    if (current === null) throw new MnemeError('NOTE_NOT_FOUND', `No note at ${note.rel}.`);
    return { content: current, sha: sha256(current) };
  });
}

/**
 * Replaces the whole note (or creates it).
 * @param {Root} root
 * @param {string} rel
 * @param {string} content
 * @param {{ author: Author, reason?: string, tool?: string }} options  `tool` shapes the guard's message (default 'Write')
 * @returns {Promise<WriteResult>}
 */
export async function writeNote(root, rel, content, { author, reason, tool = 'Write' }) {
  requireAuthor(author);
  const note = resolveInRoot(root, rel);
  return locked(root, async () => {
    const ctx = context(root);
    const { current } = watch(ctx, note.rel, note.abs);
    await testRaceDelay();
    return writeContent(ctx, note, current, content, { author, reason, tool, op: 'write' });
  });
}

/**
 * Replaces `old` with `new` in the note's CURRENT content, read under the lock.
 * @param {Root} root
 * @param {string} rel
 * @param {{ old: string, new: string, replaceAll?: boolean }} change
 * @param {{ author: Author, reason?: string, tool?: string }} options
 * @returns {Promise<WriteResult>}
 */
export async function editNote(root, rel, { old, new: replacement, replaceAll = false }, { author, reason, tool = 'Edit' }) {
  requireAuthor(author);
  const note = resolveInRoot(root, rel);
  return locked(root, async () => {
    const ctx = context(root);
    const { current } = watch(ctx, note.rel, note.abs);
    await testRaceDelay();
    if (current === null) throw new MnemeError('NOTE_NOT_FOUND', `No note at ${note.rel}: create it with a write.`);
    if (old === '') throw new MnemeError('EDIT_NOT_FOUND', `The text to replace in ${note.rel} is empty: give the exact text to change.`);
    const count = current.split(old).length - 1;
    if (count === 0) {
      throw new MnemeError('EDIT_NOT_FOUND', `The text to replace was not found in ${note.rel}. Re-read the note: it may have changed.`);
    }
    if (count > 1 && !replaceAll) {
      throw new MnemeError(
        'EDIT_AMBIGUOUS',
        `The text to replace appears ${count} times in ${note.rel}. Include more of the surrounding text to make it unique, or pass replaceAll.`,
      );
    }
    const next = replaceAll ? current.split(old).join(replacement) : current.replace(old, () => replacement);
    return writeContent(ctx, note, current, next, { author, reason, tool, op: 'edit' });
  });
}

/**
 * Phase one of a write made by a tool the store does not run (a Claude Code Edit/Write):
 * watcher + guard, the "before" version stored, and a pending record the commit will find.
 * @param {Root} root
 * @param {string} rel
 * @param {string} after  the content the tool will leave
 * @param {{ author: Author, tool: string, key?: string, reason?: string }} options  `key`: the tool_use_id, when known
 * @returns {Promise<{ ok: true, pendingId: string } | { ok: false, lost: Lost[], message: string }>}
 */
export async function prepareWrite(root, rel, after, { author, tool, key, reason }) {
  requireAuthor(author);
  const note = resolveInRoot(root, rel);
  return locked(root, () => {
    const ctx = context(root);
    const { current } = watch(ctx, note.rel, note.abs);
    const decision = decide(ctx, note.rel, current, after, author, tool);
    if (!decision.ok) return { ok: /** @type {const} */ (false), lost: decision.lost, message: decision.message };
    const before = current === null ? null : putObject(root, current);
    const pendingId = key ?? pendingIdFor(author.session, note.rel, after);
    /** @type {Pending} */
    const pending = {
      v: 1,
      id: pendingId,
      rel: note.rel,
      author,
      tool,
      before,
      after: sha256(after),
      delta: countsDelta(current, after, root.config.guardLevels),
      ts: new Date().toISOString(),
    };
    if (reason !== undefined) pending.reason = reason;
    if ('override' in decision && decision.override) pending.override = decision.override;
    fs.mkdirSync(pendingDir(root), { recursive: true });
    writeFileAtomic(pendingFile(root, pendingId), `${JSON.stringify(pending)}\n`);
    return { ok: /** @type {const} */ (true), pendingId };
  });
}

/**
 * Phase two: records the prepared write, reading the file as the tool left it. The
 * watcher does not run on the note (the change is the tool's, not an external one). If
 * the file is not what the author predicted, the entry is `raced` and credits the author
 * only with what it intended.
 * @param {Root} root
 * @param {string} pendingId
 * @returns {Promise<{ ok: true, entry: LedgerEntry }>}
 */
export async function commitWrite(root, pendingId) {
  return locked(root, () => {
    const file = pendingFile(root, pendingId);
    const pending = readPending(root, file);
    if (!pending) {
      throw new MnemeError(
        'PENDING_NOT_FOUND',
        `No prepared write "${pendingId}". It was never prepared, or it was already confirmed (late) by an earlier access. Any change nobody claimed is recorded as external on the next access.`,
      );
    }
    const note = resolveInRoot(root, pending.rel);
    const current = readCurrent(note.abs, note.rel);
    if (current === null) {
      fs.rmSync(file, { force: true });
      throw new MnemeError('NOTE_NOT_FOUND', `The tool left no file at ${note.rel}: there is no write to confirm.`);
    }
    const entry = confirm(context(root), pending, current, { late: false });
    fs.rmSync(file, { force: true });
    return { ok: /** @type {const} */ (true), entry };
  });
}

/**
 * Moves or renames a note, keeping its history, and rewrites every link that pointed to
 * it (I-3). Relative links inside the moved note are re-based on its new folder.
 * @param {Root} root
 * @param {string} from
 * @param {string} to
 * @param {{ author: Author, reason?: string }} options
 * @returns {Promise<{ entries: LedgerEntry[], linksRewritten: number }>}
 */
export async function moveNote(root, from, to, { author, reason }) {
  requireAuthor(author);
  const a = resolveInRoot(root, from);
  const b = resolveInRoot(root, to);
  return locked(root, () => {
    const ctx = context(root);
    const { current } = watch(ctx, a.rel, a.abs);
    if (current === null) throw new MnemeError('NOTE_NOT_FOUND', `No note at ${a.rel} to move.`);
    if (a.rel === b.rel || fs.existsSync(b.abs)) {
      throw new MnemeError(
        'NOTE_EXISTS',
        `Cannot move ${a.rel} to ${b.rel}: something already exists there. Pick a free name, or move that one first.`,
      );
    }
    const notesBefore = listNotes(root);
    const posix = path.posix;
    const stemOf = (/** @type {string} */ rel) => posix.basename(rel).replace(/\.[^./]+$/, '');
    const notesAfter = [...notesBefore.filter((n) => n !== a.rel), b.rel];
    const clash = notesAfter.filter((n) => stemOf(n).toLowerCase() === stemOf(b.rel).toLowerCase()).length > 1;
    const newName = clash ? b.rel.replace(/\.[^./]+$/, '') : stemOf(b.rel);
    const nameFor = (/** @type {string} */ rel) => (rel === b.rel ? newName : stemOf(rel));
    /** @param {string} holder @param {import('./links.js').Link} link */
    const pointsTo = (holder, link) => resolveTarget(root, holder, link.target, { kind: link.kind, notes: notesBefore });

    // Who links to the note, decided on the tree as it was before the move.
    const needle = stemOf(a.rel).toLowerCase();
    /** @type {string[]} */
    const holders = [];
    for (const n of notesBefore) {
      if (n === a.rel) continue;
      const text = readCurrent(`${root.dir}/${n}`, n);
      if (text === null || !text.toLowerCase().includes(needle)) continue;
      if (findLinks(text).some((link) => pointsTo(n, link) === a.rel)) holders.push(n);
    }

    fs.mkdirSync(path.dirname(b.abs), { recursive: true });
    renameWithRetry(a.abs, b.abs);
    const sha = putObject(root, current);
    const moved = append(ctx, [
      makeEntry({ rel: b.rel, op: 'move', author, reason, before: sha, after: sha, from: a.rel, delta: {}, changed: [] }),
    ]);
    /** @type {LedgerEntry[]} */
    const entries = [...moved];
    const why = `link rewrite: move ${a.rel} -> ${b.rel}`;
    let linksRewritten = 0;

    // The moved note: links to itself, and relative links re-based on the new folder.
    const self = relink(
      current,
      b.rel,
      (link) => {
        const relative = link.kind === 'md' || link.target.startsWith('./') || link.target.startsWith('../');
        const p = relative ? relativeTarget(a.rel, link) : pointsTo(a.rel, link);
        if (p === a.rel) return b.rel;
        return relative ? p : null;
      },
      nameFor,
    );
    if (self.n > 0) {
      const res = writeContent(ctx, b, current, self.text, { author, reason: why, tool: 'Edit', op: 'edit', guard: false });
      if (res.ok) entries.push(res.entry);
      linksRewritten += self.n;
    }

    for (const n of holders) {
      const note = resolveInRoot(root, n);
      const { current: text } = watch(ctx, note.rel, note.abs);
      if (text === null) continue;
      const out = relink(text, n, (link) => (pointsTo(n, link) === a.rel ? b.rel : null), nameFor);
      if (out.n === 0) continue;
      // A mechanical rewrite on behalf of the move: it changes link text, never whose section is whose.
      const res = writeContent(ctx, note, text, out.text, { author, reason: why, tool: 'Edit', op: 'edit', guard: false });
      if (res.ok) entries.push(res.entry);
      linksRewritten += out.n;
    }
    return { entries, linksRewritten };
  });
}

/**
 * Where a relative link of the note at `holder` lands (a relative wiki link without an
 * extension gets the holder's), whether or not a note is there.
 * @param {string} holder
 * @param {import('./links.js').Link} link
 */
function relativeTarget(holder, link) {
  const posix = path.posix;
  const p = posix.normalize(posix.join(posix.dirname(holder), link.target));
  if (p === '..' || p.startsWith('../')) return null;
  if (link.kind === 'wiki' && !/\.[A-Za-z0-9]+$/.test(posix.basename(p))) return `${p}${posix.extname(holder)}`;
  return p;
}

/**
 * @param {string} from
 * @param {string} to
 */
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt >= 6) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
    }
  }
}

/**
 * Entries of the note now at `rel`, newest first, following moves.
 * @param {Root} root
 * @param {string} rel
 * @param {{ limit?: number }} [options]
 * @returns {LedgerEntry[]}
 */
export function history(root, rel, { limit } = {}) {
  const own = lineage(readLedger(root).entries, resolveInRoot(root, rel).rel).reverse();
  return limit === undefined ? own : own.slice(0, Math.max(0, limit));
}

/**
 * The content of a version: a full sha, or a unique prefix of at least 6 characters.
 * @param {Root} root
 * @param {string} sha
 * @returns {string}
 */
export function showVersion(root, sha) {
  const s = String(sha).toLowerCase();
  if (/^[0-9a-f]{6,63}$/.test(s)) {
    const found = findObjects(root, s);
    if (found.length === 1) return getObject(root, found[0]);
    throw new MnemeError(
      'VERSION_NOT_FOUND',
      found.length === 0 ? `No version starts with ${s}.` : `${found.length} versions start with ${s}: give more characters.`,
    );
  }
  return getObject(root, s);
}

/**
 * The note as it was at `date`: the last entry with ts <= date (null if it did not exist).
 * @param {Root} root
 * @param {string} rel
 * @param {Date|string|number} date
 * @returns {{ content: string, entry: LedgerEntry }|null}
 */
export function asOf(root, rel, date) {
  const when = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (Number.isNaN(when)) {
    throw new MnemeError('VERSION_NOT_FOUND', `Not a date: "${String(date)}". Use an ISO date such as 2026-01-31 or 2026-01-31T18:00:00Z.`);
  }
  const note = resolveInRoot(root, rel).rel;
  const entry = lineage(readLedger(root).entries, note).findLast((e) => Date.parse(e.ts) <= when);
  if (!entry || entry.after === null) return null;
  return { content: getObject(root, entry.after), entry };
}

/**
 * Picks a version of the note: an entry id, a full sha, or a unique sha prefix.
 * @param {Root} root
 * @param {string} rel
 * @param {LedgerEntry[]} own
 * @param {string} v
 */
function pickVersion(root, rel, own, v) {
  const byId = own.find((e) => e.id === v);
  if (byId) {
    if (byId.after === null) {
      throw new MnemeError('VERSION_NOT_FOUND', `Entry ${v} deleted ${rel}: it has no content to restore. Pick an earlier version.`);
    }
    return byId.after;
  }
  const s = v.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(s) && hasObject(root, s)) return s;
  if (/^[0-9a-f]{6,63}$/.test(s)) {
    const shas = [...new Set(own.map((e) => e.after).filter((x) => x !== null && x.startsWith(s)))];
    if (shas.length === 1) return /** @type {string} */ (shas[0]);
    if (shas.length > 1) throw new MnemeError('VERSION_NOT_FOUND', `${shas.length} versions of ${rel} start with ${s}: give more characters.`);
  }
  throw new MnemeError('VERSION_NOT_FOUND', `No version "${v}" in the history of ${rel}. List them with: ${NAME} history "${rel}".`);
}

/**
 * Writes an earlier version back, as a new entry (`op: 'restore'`). It goes through the
 * guard like any write.
 * @param {Root} root
 * @param {string} rel
 * @param {string} versionIdOrSha  an entry id, a sha, or a unique sha prefix
 * @param {{ author: Author, reason?: string }} options
 * @returns {Promise<WriteResult>}
 */
export async function restore(root, rel, versionIdOrSha, { author, reason }) {
  requireAuthor(author);
  const note = resolveInRoot(root, rel);
  return locked(root, () => {
    const ctx = context(root);
    const { current } = watch(ctx, note.rel, note.abs);
    const sha = pickVersion(root, note.rel, lineage(ctx.entries, note.rel), String(versionIdOrSha));
    return writeContent(ctx, note, current, getObject(root, sha), { author, reason, tool: 'Edit', op: 'restore' });
  });
}

/**
 * Runs the watcher over every note (and every note the ledger knows): records what was
 * written or deleted behind the store's back.
 * @param {Root} root
 * @returns {Promise<LedgerEntry[]>}  the external and delete entries it recorded
 */
export async function scanExternal(root) {
  return locked(root, () => {
    const ctx = context(root);
    const known = [...headsIn(ctx.entries)].filter(([, sha]) => sha !== null).map(([rel]) => rel);
    /** @type {LedgerEntry[]} */
    const recorded = [];
    for (const rel of [...new Set([...listNotes(root), ...known])].sort()) {
      let note;
      try {
        note = resolveInRoot(root, rel);
      } catch (e) {
        // A known note now under a nested root (or a junction that leaves): not ours to watch.
        if (e instanceof MnemeError) {
          recordError(root, 'scan', `${rel} skipped: ${e.message}`);
          continue;
        }
        throw e;
      }
      recorded.push(...watch(ctx, note.rel, note.abs).recorded);
    }
    return recorded.filter((e) => e.op === 'external' || e.op === 'delete');
  });
}
