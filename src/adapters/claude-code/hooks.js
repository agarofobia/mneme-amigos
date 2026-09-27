// The Claude Code hooks: how a session that edits with Claude Code's own Edit/Write
// goes through the store (D-P9), gets the notices and messages, and shows up in the
// presence. `handleHook(event)` returns what the hook prints on stdout, or null.
//
// A hook never blocks because of its own error: every failure is recorded (in the root's
// run/errors.jsonl, or <home>/errors.jsonl when there is no root) and the hook lets the
// agent through. The price is known: a broken hook skips the guard. `doctor` shows it.
import fs from 'node:fs';
import path from 'node:path';
import { MnemeError } from '../../errors.js';
import { readLedger } from '../../ledger.js';
import { recordError } from '../../lock.js';
import { NAME, STATE_DIR } from '../../name.js';
import { sha256 } from '../../objects.js';
import { resolveInRoot } from '../../paths.js';
import { bundle } from '../../readers/cag.js';
import { recordHomeError, registeredRoots } from '../../registry.js';
import { findRoot } from '../../root.js';
import {
  activeSessions,
  endSession,
  formatMessages,
  formatNotices,
  messagesFor,
  noticesFor,
  recordDenial,
  recordRead,
  sessionAuthor,
  touchSession,
} from '../../sessions.js';
import { commitWrite, prepareWrite, readNote } from '../../store.js';
import { sid8 } from '../../guard.js';
import { predictAfter } from './edits.js';

/** @typedef {import('../../types.js').Author} Author */
/** @typedef {import('../../types.js').Root} Root */

/**
 * The fields of a Claude Code hook event this adapter reads.
 * @typedef {Object} HookEvent
 * @property {string} [hook_event_name]
 * @property {string} [session_id]
 * @property {string} [cwd]
 * @property {string} [tool_name]
 * @property {unknown} [tool_input]
 * @property {string} [tool_use_id]
 * @property {unknown} [tool_response]
 * @property {string} [source]
 */

/** The events `hooks install` registers, and the only ones this handler answers. */
export const EVENTS = /** @type {const} */ (['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd']);
/** The file tools the guard watches. */
export const FILE_TOOLS = /** @type {const} */ (['Edit', 'Write', 'MultiEdit']);
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {unknown} err */
function describe(err) {
  if (err instanceof MnemeError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return (err.stack ?? `${err.name}: ${err.message}`).split('\n').slice(0, 4).join(' | ');
  return String(err);
}

/**
 * Runs `fn` for one root; an error is recorded in that root and becomes null.
 * @template T
 * @param {Root} root
 * @param {string} where
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T|null>}
 */
async function guarded(root, where, fn) {
  try {
    return await fn();
  } catch (err) {
    recordError(root, where, describe(err));
    return null;
  }
}

/**
 * @param {string} abs
 * @returns {string|null}
 */
function readOrNull(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * True when the note is outside what the root governs (an ignored folder or path).
 * @param {Root} root
 * @param {string} rel
 */
function ignored(root, rel) {
  const dirs = rel.split('/').slice(0, -1);
  if (dirs.some((d) => root.config.ignoreDirs.includes(d))) return true;
  return root.config.ignorePaths
    .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .some((p) => p !== '' && (rel === p || rel.startsWith(`${p}/`)));
}

/**
 * The governed note a tool event is about, or null (silence: not our business).
 * @param {HookEvent} e
 * @returns {{ root: Root, rel: string, abs: string }|null}
 */
function target(e) {
  const input = /** @type {Record<string, unknown>|null|undefined} */ (e.tool_input);
  const file = input && typeof input === 'object' ? input.file_path : undefined;
  if (typeof file !== 'string' || file === '') return null;
  const abs = path.resolve(typeof e.cwd === 'string' && e.cwd !== '' ? e.cwd : process.cwd(), file);
  const root = findRoot(abs);
  if (!root) return null;
  const extensions = root.config.extensions.map((x) => x.toLowerCase());
  if (!extensions.includes(path.extname(abs).toLowerCase())) return null;
  let note;
  try {
    note = resolveInRoot(root, abs);
  } catch (err) {
    // Inside the state directory or a nested root: not a note this root governs.
    if (err instanceof MnemeError) return null;
    throw err;
  }
  if (ignored(root, note.rel)) return null;
  return { root, rel: note.rel, abs: note.abs };
}

/**
 * The id of a two-phase write: the tool_use_id when Claude Code sends it, else a hash
 * both phases can compute from the same event (A-1).
 * @param {HookEvent} e
 * @param {string} session
 * @param {string} rel
 */
export function pendingKey(e, session, rel) {
  if (typeof e.tool_use_id === 'string' && e.tool_use_id !== '') return e.tool_use_id;
  return sha256(session + rel + JSON.stringify(e.tool_input ?? null));
}

/**
 * @param {'SessionStart'|'UserPromptSubmit'} hookEventName
 * @param {string[]} blocks
 */
function context(hookEventName, blocks) {
  const text = blocks.filter((b) => b !== '').join('\n\n');
  return text === '' ? null : { hookSpecificOutput: { hookEventName, additionalContext: text } };
}

/**
 * A config.json with problems says so in every SessionStart and UserPromptSubmit until it is fixed
 * (§4.3, tolerant reading): the root still works on the defaults, and the person has to know.
 * Informe QoL 26/09 (F1): a typo used to switch the guard off in every session without a word.
 * @param {Root} root
 */
function configLine(root) {
  const p = root.configProblems ?? [];
  if (p.length === 0) return '';
  return `[${NAME}] ${root.dir}/${STATE_DIR}/config.json has ${p.length === 1 ? 'a problem' : `${p.length} problems`}: ${p.join('; ')}. Mneme keeps working on the defaults for ${p.length === 1 ? 'it' : 'them'}. Tell the person in one line, and fix it with their OK (run: ${NAME} doctor --root "${root.dir}").`;
}

/**
 * Labels each root's block when there are several roots, so a note path is never ambiguous.
 * @param {Root[]} roots
 * @param {Root} root
 * @param {string[]} parts
 */
function rootBlock(roots, root, parts) {
  parts = [configLine(root), ...parts];
  const body = parts.filter((p) => p !== '');
  if (body.length === 0) return '';
  return roots.length > 1 ? [`[${NAME}] Root ${root.dir}:`, ...body].join('\n') : body.join('\n\n');
}

// ── the events ──────────────────────────────────────────────────────────────

/**
 * @param {HookEvent} e
 * @param {Author} author
 */
async function preToolUse(e, author) {
  const tool = e.tool_name ?? '';
  if (!(/** @type {readonly string[]} */ (FILE_TOOLS).includes(tool))) return null;
  const t = target(e);
  if (!t) return null;
  return guarded(t.root, 'hook PreToolUse', async () => {
    const after = predictAfter(tool, e.tool_input, readOrNull(t.abs));
    if (after === null) return null; // the tool will fail on its own, or it is not a write
    const res = await prepareWrite(t.root, t.rel, after, { author, tool, key: pendingKey(e, author.session, t.rel) });
    if (res.ok) return null;
    recordDenial(t.root, author.session, t.rel, res.lost);
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: res.message },
    };
  });
}

/**
 * True when the last entry of `rel` by `session` is a late confirmation: the watcher
 * already recorded this write, so a missing pending is success (contracts §4.14).
 * @param {Root} root
 * @param {string} rel
 * @param {string} session
 */
function confirmedLate(root, rel, session) {
  const own = readLedger(root).entries.findLast((x) => x.rel === rel && x.author.session === session);
  return own?.late === true;
}

/**
 * @param {HookEvent} e
 * @param {Author} author
 */
async function postToolUse(e, author) {
  const tool = e.tool_name ?? '';
  if (tool === 'Read') {
    const t = target(e);
    if (!t) return null;
    return guarded(t.root, 'hook PostToolUse(Read)', async () => {
      try {
        const { sha } = await readNote(t.root, t.rel);
        recordRead(t.root, author.session, t.rel, sha);
      } catch (err) {
        // Claude Code's Read already failed for a missing file; nothing was read.
        if (!(err instanceof MnemeError && err.code === 'NOTE_NOT_FOUND')) throw err;
      }
      return null;
    });
  }
  if (!(/** @type {readonly string[]} */ (FILE_TOOLS).includes(tool))) return null;
  const t = target(e);
  if (!t) return null;
  return guarded(t.root, 'hook PostToolUse', async () => {
    try {
      await commitWrite(t.root, pendingKey(e, author.session, t.rel));
    } catch (err) {
      if (!(err instanceof MnemeError && err.code === 'PENDING_NOT_FOUND')) throw err;
      if (!confirmedLate(t.root, t.rel, author.session)) {
        recordError(
          t.root,
          'hook PostToolUse',
          `${tool} on ${t.rel} by session ${sid8(author.session)} had no prepared write (its PreToolUse did not run or could not predict the result); the change will be recorded as external on the next access.`,
        );
      }
    }
    return null;
  });
}

/**
 * @param {Root} root
 * @param {number} now
 */
function recentExternal(root, now) {
  return readLedger(root).entries.filter((x) => (x.op === 'external' || x.op === 'delete') && now - Date.parse(x.ts) <= DAY_MS).length;
}

/**
 * The CAG bundle of every root with a wake-up budget, the budget split evenly (I-11).
 * Each block starts with a header line; the header counts against the budget.
 * @param {Root[]} roots
 * @returns {Promise<string[]>}
 */
async function wakeUp(roots) {
  const on = roots.filter((r) => r.config.wakeUpBudget > 0);
  /** @type {string[]} */
  const out = [];
  for (const root of on) {
    const block = await guarded(root, 'hook SessionStart (wake-up)', () => wakeUpBlock(root, Math.floor(root.config.wakeUpBudget / on.length)));
    if (block) out.push(block);
  }
  return out;
}

/**
 * One root's wake-up text in at most `budget` bytes: a header line, then the bundle.
 * @param {Root} root
 * @param {number} budget
 */
export function wakeUpBlock(root, budget) {
  const header = `[${NAME}] Wake-up bundle of ${root.dir} (pinned notes in full, then one line per note):\n`;
  const room = budget - Buffer.byteLength(header, 'utf8');
  if (room < 1) throw new RangeError(`a wake-up budget of ${budget} bytes does not even fit the header line`);
  return header + bundle(root, { budget: room });
}

/**
 * @param {Author} author
 */
async function sessionStart(author) {
  const { roots } = registeredRoots();
  const now = Date.now();
  /** @type {string[]} */
  const blocks = [];
  for (const root of roots) {
    const parts = await guarded(root, 'hook SessionStart', () => {
      touchSession(root, author);
      /** @type {string[]} */
      const lines = [];
      const active = activeSessions(root);
      if (active.length >= root.config.activeWarnAt) {
        const others = active
          .filter((p) => p.author.session !== author.session)
          .map((p) => `${sid8(p.author.session)} (${p.author.agent}${p.intent ? `: "${p.intent}"` : ''})`);
        lines.push(
          `[${NAME}] ${active.length} sessions are active on these notes. The others: ${others.join(', ')}. Coordinate before editing the same note.`,
        );
      }
      const external = recentExternal(root, now);
      if (external > 0) {
        lines.push(
          `[${NAME}] ${external} external write${external === 1 ? '' : 's'} (no author) in the last 24 h. See them with: ${NAME} status --root "${root.dir}"`,
        );
      }
      lines.push(formatMessages(messagesFor(root, author.session)));
      return lines;
    });
    if (parts) blocks.push(rootBlock(roots, root, parts));
  }
  blocks.push(...(await wakeUp(roots)));
  return context('SessionStart', blocks);
}

/**
 * @param {Author} author
 */
async function userPromptSubmit(author) {
  const { roots } = registeredRoots();
  /** @type {string[]} */
  const blocks = [];
  for (const root of roots) {
    const parts = await guarded(root, 'hook UserPromptSubmit', () => {
      touchSession(root, author);
      return [formatNotices(noticesFor(root, author.session)), formatMessages(messagesFor(root, author.session))];
    });
    if (parts) blocks.push(rootBlock(roots, root, parts));
  }
  return context('UserPromptSubmit', blocks);
}

/**
 * @param {Author} author
 */
async function sessionEnd(author) {
  const { roots } = registeredRoots();
  for (const root of roots) await guarded(root, 'hook SessionEnd', () => endSession(root, author.session));
  return null;
}

/**
 * Answers one Claude Code hook event. Never throws: an error is recorded and the answer
 * is null (let the agent through, say nothing).
 * @param {unknown} event  the JSON Claude Code writes on the hook's stdin
 * @returns {Promise<object|null>}  what the hook prints on stdout (null: nothing)
 */
export async function handleHook(event) {
  try {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('the hook payload is not a JSON object');
    }
    const e = /** @type {HookEvent} */ (event);
    const name = e.hook_event_name;
    if (!(/** @type {readonly (string|undefined)[]} */ (EVENTS).includes(name))) return null;
    if (typeof e.session_id !== 'string' || e.session_id.trim() === '') {
      recordHomeError(`hook ${name}`, 'event without session_id: nothing can be attributed, ignored');
      return null;
    }
    const author = sessionAuthor({ session: e.session_id, agent: 'claude-code' });
    switch (name) {
      case 'PreToolUse':
        return await preToolUse(e, author);
      case 'PostToolUse':
        return await postToolUse(e, author);
      case 'SessionStart':
        return await sessionStart(author);
      case 'UserPromptSubmit':
        return await userPromptSubmit(author);
      case 'SessionEnd':
        return await sessionEnd(author);
      default:
        return null;
    }
  } catch (err) {
    recordHomeError('hook', describe(err));
    return null;
  }
}
