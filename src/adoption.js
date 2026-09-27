// What is done and what comes next for a person who just installed (docs/arquitectura/03-contratos.md
// §4.31): the steps of adoption, measured with what Mneme already records, and one `next:` line.
// Read-only. `doctor` prints it; in a workspace, Claude explains it in the person's words.
//
// Facts and the decision are apart on purpose: adoptionFacts() reads the disk, adoptionSteps()
// only decides, so the product decision (which steps, in what order) is tested without a disk.
import { safeFileName } from './leases.js';
import { readLedger } from './ledger.js';
import { NAME } from './name.js';
import { sessionsWithReads } from './readers/session.js';
import { listNotes } from './root.js';
import { sessionsSeen } from './sessions.js';
import { USAGE_ENV, readSearches, usageLogOn } from './usage.js';

/** @typedef {import('./types.js').Root} Root */

/** The note the installer puts at the top of a new root (scripts/workspace/Welcome.md): not the person's own. */
export const WELCOME_NOTE = 'Welcome.md';

/** Agents that are an AI session (the CLI is the person; 'external' and 'adopt' are nobody's session). */
const AI_AGENTS = new Set(['claude-code', 'mcp']);
/** Ledger operations that are a write made through the guard. */
const AI_WRITE_OPS = new Set(['write', 'edit', 'move', 'restore']);

/**
 * @typedef {Object} AdoptionFacts
 * @property {string|null} hooksAt   a settings file that has every hook entry; null: none
 * @property {number} ownNotes       notes other than the installer's welcome note
 * @property {number} aiSessions     distinct AI sessions opened here (present, ended, told about changes, read or wrote)
 * @property {number} aiWriters      distinct AI sessions that wrote here through the guard
 * @property {number} aiWrites       writes by AI sessions through the guard
 * @property {number|null} searchesWithHits  CLI/MCP searches that found something; null: the log is off
 */

/**
 * @typedef {'hooks'|'notes'|'session'|'search'|'write'|'together'} StepId
 * @typedef {Object} AdoptionStep
 * @property {StepId} id
 * @property {'done'|'todo'|'n/a'} status
 * @property {string} detail  one line for a person
 */

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * What Mneme already records about this root, counted for adoption. Records nothing.
 * @param {Root} root
 * @param {{ hooksAt: string|null, env?: NodeJS.ProcessEnv }} options  `hooksAt` comes from the
 *   caller: the settings files belong to the Claude Code adapter, not to the core.
 * @returns {AdoptionFacts}
 */
export function adoptionFacts(root, { hooksAt, env = process.env }) {
  const ownNotes = listNotes(root).filter((rel) => rel !== WELCOME_NOTE).length;
  // Opened here at all (present, ended, told about changes) or read a note; the ledger adds writers.
  const sessions = new Set([...sessionsWithReads(root), ...sessionsSeen(root)]);
  /** @type {Set<string>} */
  const writers = new Set();
  let aiWrites = 0;
  for (const e of readLedger(root).entries) {
    if (!AI_AGENTS.has(e.author.agent)) continue;
    const id = safeFileName(e.author.session);
    sessions.add(id);
    if (AI_WRITE_OPS.has(e.op)) {
      aiWrites++;
      writers.add(id);
    }
  }
  const searchesWithHits = usageLogOn(env) ? readSearches().searches.filter((s) => s.hits > 0).length : null;
  return { hooksAt, ownNotes, aiSessions: sessions.size, aiWriters: writers.size, aiWrites, searchesWithHits };
}

/**
 * The steps of adoption and the one thing to do next. Pure: no disk, no clock.
 * @param {AdoptionFacts} facts
 * @param {{ notesDir: string, openIn: string, firstFail?: string|null }} where
 *   `notesDir`: the root; `openIn`: the folder to open Claude Code in (the workspace when there
 *   is one); `firstFail`: the first health check of `doctor` that failed, which comes first.
 * @returns {{ steps: AdoptionStep[], next: string }}
 */
export function adoptionSteps(facts, { notesDir, openIn, firstFail = null }) {
  // [id, done (null: cannot be measured), line when done, line when not, what to do]
  /** @type {Array<[StepId, boolean|null, string, string, string]>} */
  const table = [
    ['hooks', facts.hooksAt !== null, `installed in ${facts.hooksAt}`, `not installed for this ${NAME} home`, `install the hooks: ${NAME} hooks install (or run the installer again)`],
    ['notes', facts.ownNotes > 0, `${count(facts.ownNotes, 'note', 'notes')} of your own`, 'no note of your own yet', `add a note of your own to ${notesDir}: a Markdown file split into sections with ## headings (or ask Claude to write one there)`],
    ['session', facts.aiSessions > 0, `${count(facts.aiSessions, 'AI session has', 'AI sessions have')} been opened here`, 'no AI session has been opened here yet', `open Claude Code in ${openIn} and ask it about something in your notes`],
    [
      'search',
      facts.searchesWithHits === null ? null : facts.searchesWithHits > 0,
      `${count(facts.searchesWithHits ?? 0, 'search', 'searches')} found something`,
      facts.searchesWithHits === null ? `not measured: the search log is off (${USAGE_ENV}=0)` : 'no search has found anything yet',
      `ask Claude about something that is in your notes (it searches with ${NAME} first), or try: ${NAME} search "<words from one of your notes>"`,
    ],
    ['write', facts.aiWrites > 0, `${count(facts.aiWrites, 'write', 'writes')} by AI sessions, each with its author`, 'no AI session has written a note yet', `ask Claude to add something to one of your notes; then ${NAME} history "<that note>" shows who wrote each version`],
    ['together', facts.aiWriters > 1, `${facts.aiWriters} AI sessions wrote here`, facts.aiWriters === 1 ? 'one AI session has written here so far' : 'no AI session has written here yet', `open a second Claude Code window in ${openIn} and work on the same notes: each one is told what the other changed`],
  ];
  /** @type {AdoptionStep[]} */
  const steps = table.map(([id, done, yes, no]) => ({ id, status: done === null ? 'n/a' : done ? 'done' : 'todo', detail: done ? yes : no }));
  const firstTodo = table.find(([, done]) => done === false);
  const next = firstFail
    ? `fix "${firstFail}" first (its line is above)`
    : firstTodo
      ? firstTodo[4]
      : `nothing missing. After a week of use, ${NAME} report prints your usage numbers (no note names, no text), if you want to share them.`;
  return { steps, next };
}
