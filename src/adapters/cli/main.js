// The command line, for the person (docs/diseno/02-mapa.md §③). `main(argv)` returns the
// exit code: 0 ok, 1 something failed (the message says what and what to do), 2 the
// command was used wrong. `hook <Event>` is the exception: it always ends with 0.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adoptionFacts, adoptionSteps } from '../../adoption.js';
import { audit, parseSince } from '../../audit.js';
import { MnemeError } from '../../errors.js';
import { sid8 } from '../../guard.js';
import { grantLease } from '../../leases.js';
import { readLedger } from '../../ledger.js';
import { NAME, STATE_DIR } from '../../name.js';
import { hasObject } from '../../objects.js';
import { realPathLoose, resolveInRoot, toSlash } from '../../paths.js';
import { DEFAULT_BUDGET, bundle } from '../../readers/cag.js';
import { embedderFor, withTimeout } from '../../readers/embeddings.js';
import { updateIndex } from '../../readers/index.js';
import { homeDir, listRegisteredRoots, registerRoot, registeredRoots, rootsFile, samePath } from '../../registry.js';
import { findRoot, listNotes, onConfigProblems, openRoot } from '../../root.js';
import { runEval } from '../../eval.js';
import { sessionsWithReads } from '../../readers/session.js';
import { degradedLine, formatFollow, formatHit, search, sessionLine } from '../../search.js';
import { activeSessions, hhmm, knownSessions, readMessages, sendMessage, sessionAuthor } from '../../sessions.js';
import { asOf, history, initRoot, moveNote, restore, scanExternal, showVersion } from '../../store.js';
import { buildReport, recordSearch } from '../../usage.js';
import { collectGui } from '../../gui/data.js';
import { DEFAULT_PACK, listPacks, loadPack } from '../../gui/packs.js';
import { renderGui } from '../../gui/render.js';
import { handleHook, wakeUpBlock } from '../claude-code/hooks.js';
import { defaultSettingsPath, hooksStatus, installHooks, installedSettingsPaths, uninstallHooks } from '../claude-code/settings.js';

/** @typedef {import('../../types.js').Root} Root */
/** @typedef {import('../../types.js').LedgerEntry} LedgerEntry */

/** A wrong use of the command: exit 2 with the message and the usage line. */
class UsageError extends Error {}

const BIN = fileURLToPath(new URL(`../../../bin/${NAME}.js`, import.meta.url));

const USAGE = `usage: ${NAME} <command> [options]
Every command works on the root at or above the current directory, or on --root <dir>.

SET UP
  Start
    init [dir] [--adopt]                   govern a folder (--adopt: it already has notes; nothing is modified)
    doctor [--root <dir>]                  check the installation (ledger, objects, lock, index, embeddings, hooks) and say what is next
  Connect your agents
    hooks install|uninstall|status [--settings <settings.json>] [--command <cmd>]
                                           the Claude Code hooks; --command: what they run (default:
                                           node "<this checkout>/bin/${NAME}.js"), {event} marks where the event goes
    mcp [--root <dir>]... [--read-only] [--session <name>] [--print]
                                           the MCP server on stdio, for any agent (Claude, Qwen on Ollama,
                                           Odysseus, Codex...); --session keeps its identity across restarts,
                                           --print shows the settings to paste in the client

FIND
  Search
    search "<query>" [-k <n>] [--reader hybrid|lexical|session] [--scope <dir>]... [--root <dir>]... [--session <id>]
                                           --session: when nothing matches, what that session was working on
                                           (the full id, or its first characters if only one known session has them)
    index                                  bring the search index up to date
  Context for an agent
    bundle [--budget <bytes>]              the CAG bundle on stdout
    wake-up [--budget <bytes>] [--root <dir>]...   what a session starts with: pinned notes and an index
  Measure
    eval <cases.json> [--k <n>] [--reader lexical|hybrid] [--results <file.jsonl>]

NOTES AND THEIR HISTORY
  Look back
    history <note> [--limit <n>]           versions of a note
    show <note> --version <id>             one version's content
    as-of <note> <date>                    the note as it was at a date
  Change
    restore <note> <id> --reason <why>     write an earlier version back (a new write)
    move <from> <to> --reason <why>        move a note and rewrite the links to it

WORK TOGETHER
  See who is working
    status [--root <dir>]                  who is working now, last writes, external writes, leases
    gui [--out <file>] [--pack <name|dir>] [--query <q>]... [--note <rel>] [--root <dir>]... [--open] [--watch] [--allow-remote] [--packs]
                                           a read-only page: sessions, notes and owners, history, audit, search
    galaxia [--root <dir>] [--workspace <dir>] [--port <n>] [--no-open]
                                           the 3D view (preview): the notes as a galaxy, read them, packs to
                                           change its look; served on 127.0.0.1 until you close the window
  Talk between sessions
    message send <to> <body> [--reply-to <id>] [--correlation <id>]   to: a session id, "*" or "next"
    message list [--session <id>] [--limit <n>]
  Unblock
    allow <note> --session <id> --reason <why> [--minutes <n>]   let a blocked session through (a person, at a terminal)

CHECK AND REPORT
  What happened
    scan                                   record what changed outside the tools as external writes
    audit [--since <date>] [--json]        losses, clashes, lease removals and guard denials (exit 1 on a loss)
  Share how it is used
    report [--days <n>] [--root <dir>]...  usage counts as JSON, to copy and send: nothing private in it
                                           (default: the last 30 days, every registered root)`;

// ── output ──────────────────────────────────────────────────────────────────

/** @param {string} text */
const out = (text) => process.stdout.write(`${text}\n`);
/** @param {string} text */
const err = (text) => process.stderr.write(`${text}\n`);

/** @param {number} n */
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Local `yyyy-mm-dd hh:mm` of an ISO timestamp.
 * @param {string} iso
 */
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** @param {number} n @param {string} one */
const plural = (n, one) => `${n} ${n === 1 ? one : one.endsWith('y') ? `${one.slice(0, -1)}ies` : `${one}s`}`;

/** @param {LedgerEntry} e */
function entryLine(e) {
  const parts = [e.id, when(e.ts), e.op.padEnd(8), `session ${sid8(e.author.session)} (${e.author.agent})`, e.after ? e.after.slice(0, 8) : '(deleted)'];
  if (e.reason) parts.push(`"${e.reason}"`);
  if (e.from) parts.push(`from ${e.from}`);
  if (e.changed.length) parts.push(`changed: ${e.changed.map((k) => k || '(intro)').join(', ')}`);
  if (e.violations?.length) parts.push(`removed sections others wrote: ${e.violations.join(', ')}`);
  if (e.raced) parts.push('(raced)');
  if (e.late) parts.push('(confirmed late)');
  if (e.override) parts.push(`(lease ${e.override.lease})`);
  return parts.join('  ');
}

/**
 * True when a hook command runs this tool by its bare name (`mneme hook X`), so it depends
 * on the PATH rather than on a file.
 * @param {string} command
 */
export function callsByName(command) {
  return new RegExp(`(?:^|[\\s;&|])${NAME}(?:\\s+hook\\b|$)`).test(command) || command.includes(`${NAME} hook {event}`);
}

/**
 * Whether a program is on the PATH (with PATHEXT on Windows).
 * @param {string} program
 */
export function onPath(program) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, program + ext)).isFile()) return true;
      } catch {
        // not in this directory
      }
    }
  }
  return false;
}

/**
 * A line diff (longest common subsequence), with two lines of context.
 * @param {string} before
 * @param {string} after
 */
export function lineDiff(before, after) {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  /** @type {Uint32Array[]} */
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  /** @type {Array<[' '|'-'|'+', string]>} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([' ', a[i++]]), j++;
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push(['+', b[j++]]);
    else ops.push(['-', a[i++]]);
  }
  const keep = ops.map((_, k) => ops.slice(Math.max(0, k - 2), k + 3).some(([op]) => op !== ' '));
  /** @type {string[]} */
  const lines = [];
  let skipped = false;
  ops.forEach(([op, text], k) => {
    if (keep[k]) {
      lines.push(`${op} ${text}`);
      skipped = false;
    } else if (!skipped) {
      lines.push('  …');
      skipped = true;
    }
  });
  return lines.join('\n');
}

// ── arguments and roots ─────────────────────────────────────────────────────

/**
 * @template {import('node:util').ParseArgsConfig['options']} O
 * @param {string[]} args
 * @param {O} options
 */
function parse(args, options) {
  try {
    return parseArgs({ args, options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(/** @type {Error} */ (e).message);
  }
}

/**
 * @param {string|undefined} value
 * @param {string} flag
 * @returns {number|undefined}
 */
function positiveInt(value, flag) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive whole number (got "${value}")`);
  return n;
}

/**
 * @param {unknown} value
 * @param {string} flag
 * @returns {string}
 */
function required(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') throw new UsageError(`${flag} is required`);
  return value;
}

/** The session a CLI action is attributed to: the agent's when run from a session, else the person's. */
function cliSession() {
  const env = process.env.CLAUDE_CODE_SESSION_ID;
  if (env && env.trim() !== '') return env;
  let user = 'user';
  try {
    user = os.userInfo().username;
  } catch {
    // No passwd entry for this uid: the generic name is enough to group a person's writes.
    user = process.env.USER ?? process.env.USERNAME ?? 'user';
  }
  return `cli-${user.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

const cliAuthor = () => sessionAuthor({ session: cliSession(), agent: 'cli' });

/**
 * The root governing `dir`, or the "no governed root" error of the map (§④).
 * @param {string} dir
 * @returns {Root}
 */
function rootAt(dir) {
  const root = findRoot(dir);
  // openRoot on a directory that is not a root throws ROOT_NOT_FOUND with the map's text.
  return root ?? openRoot(dir);
}

/**
 * The root of `--root`, else of the current directory, else the only registered root: the
 * first run of the map (§⑤) runs doctor and search right after init, from anywhere, and a
 * clean-profile rehearsal of the README failed there (D-1, 24/09). With several registered
 * roots and none here, the command asks for --root instead of guessing.
 * @param {string|undefined} given
 * @returns {Root}
 */
function oneRoot(given) {
  if (given !== undefined) return rootAt(path.resolve(given));
  const here = findRoot(process.cwd());
  if (here) return here;
  const { roots } = registeredRoots();
  if (roots.length === 1) return roots[0];
  if (roots.length > 1) {
    throw new UsageError(`No governed root here, and ${roots.length} are registered: ${roots.map((r) => r.dir).join(', ')}. Pass --root <dir>.`);
  }
  return openRoot(process.cwd()); // throws ROOT_NOT_FOUND, which says how to create one
}

/**
 * Every `--root` given, else the current directory's root, else (when allowed) every
 * registered root.
 * @param {string[]|undefined} given
 * @param {{ registered?: boolean }} [options]
 * @returns {Root[]}
 */
function manyRoots(given, { registered = false } = {}) {
  if (given && given.length) return given.map((d) => rootAt(path.resolve(d)));
  const here = findRoot(process.cwd());
  if (here) return [here];
  if (registered) {
    const { roots } = registeredRoots();
    if (roots.length) return roots;
  }
  return [openRoot(process.cwd())];
}

/**
 * A note given on the command line: relative to --root when given, else to the cwd.
 * @param {string} p
 * @param {string|undefined} rootDir
 */
function noteArg(p, rootDir) {
  const base = rootDir ? path.resolve(rootDir) : process.cwd();
  const abs = path.resolve(base, p);
  const root = rootDir ? rootAt(base) : rootAt(abs);
  return { root, rel: resolveInRoot(root, abs).rel };
}

// ── commands ────────────────────────────────────────────────────────────────

/** @param {string[]} args */
async function cmdInit(args) {
  const { values, positionals } = parse(args, { adopt: { type: 'boolean' } });
  const dir = path.resolve(positionals[0] ?? process.cwd());
  let res;
  try {
    res = await initRoot(dir, {
      adopt: values.adopt === true,
      author: cliAuthor(),
      onProgress: (done, total) => err(`adopted ${done}/${total} notes…`),
    });
  } catch (e) {
    if (e instanceof MnemeError && e.code === 'ROOT_EXISTS') {
      const { added } = registerRoot(dir);
      err(e.message);
      if (added) err(`It was not registered for the hooks; now it is (${toSlash(rootsFile())}).`);
      return 1;
    }
    throw e;
  }
  const { dir: real } = registerRoot(dir);
  if (res.notes > 0) out(`Adopted ${res.notes} notes (${fmtBytes(res.bytes)}) in ${(res.ms / 1000).toFixed(1)} s. Nothing was modified.`);
  else out(`Created a governed root at ${real}. It has no notes yet.`);
  out(`Registered ${real} for the Claude Code hooks (${toSlash(rootsFile())}).`);
  out(`Next: ${NAME} hooks install, then ${NAME} doctor.`);
  return 0;
}

/**
 * @param {string} file
 * @returns {Array<Record<string, unknown>>}
 */
function jsonlLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  /** @type {Array<Record<string, unknown>>} */
  const lines = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      lines.push({ message: `(unreadable line) ${line.slice(0, 200)}` });
    }
  }
  return lines;
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * @param {import('../../types.js').EmbeddingsConfig} cfg
 * @param {Root} root
 * @returns {Promise<['ok'|'warn'|'fail', string]>}
 */
async function checkEmbeddings(cfg, root) {
  if (cfg.provider === 'none') return ['warn', 'off (provider "none"): search is lexical only. Set embeddings.provider to "ollama" (or "module", your own) in config.json to add the semantic reader.'];
  if (cfg.provider === 'module') {
    const embedder = /** @type {import('../../types.js').Embedder} */ (embedderFor(root));
    try {
      const vectors = await withTimeout(() => embedder.embed(['doctor'], 'query'), cfg.timeoutMs, `embedder "${embedder.name}"`);
      const dims = Array.isArray(vectors) && vectors[0] ? vectors[0].length : 0;
      return dims ? ['ok', `${embedder.name}: answered with ${dims} dimensions`] : ['warn', `${embedder.name} answered without a vector; search falls back to lexical.`];
    } catch (e) {
      return ['warn', `${/** @type {Error} */ (e).message}; search falls back to lexical.`];
    }
  }
  const base = cfg.url.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
    if (!res.ok) return ['warn', `Ollama at ${base} answered HTTP ${res.status}; search falls back to lexical.`];
    const body = /** @type {{ models?: Array<{ name?: string }> }} */ (await res.json());
    const names = (body.models ?? []).map((m) => String(m.name ?? ''));
    const has = names.some((n) => n === cfg.model || n === `${cfg.model}:latest` || n.split(':')[0] === cfg.model);
    return has
      ? ['ok', `Ollama at ${base} is up and has ${cfg.model}`]
      : ['warn', `Ollama at ${base} is up but has no model "${cfg.model}"; pull it yourself (ollama pull ${cfg.model}). Search falls back to lexical.`];
  } catch (e) {
    const why = controller.signal.aborted ? `no answer within ${cfg.timeoutMs} ms` : /** @type {Error} */ (e).message;
    return ['warn', `Ollama at ${base} is not reachable (${why}); search falls back to lexical.`];
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string[]} args */
async function cmdDoctor(args) {
  const { values } = parse(args, { root: { type: 'string' }, settings: { type: 'string' } });
  const root = oneRoot(values.root);
  /** @type {string[]} */
  const lines = [];
  /** @type {string|null} the first check that failed: the adoption's `next:` sends there first */
  let firstFail = null;
  /** @param {'ok'|'warn'|'fail'} level @param {string} check @param {string} detail */
  const add = (level, check, detail) => {
    if (level === 'fail') firstFail ??= check;
    lines.push(`${level.padEnd(4)}  ${check}: ${detail}`);
  };
  const now = Date.now();

  add('ok', 'root', root.dir);
  // §4.3: the root opens on the defaults of what config.json gets wrong; doctor is where it fails
  if (root.configProblems?.length) add('fail', 'config', `${STATE_DIR}/config.json: ${root.configProblems.join('; ')}. Fix the file (the only one in ${STATE_DIR}/ you may edit) and run doctor again; until then Mneme works on those defaults.`);
  else add('ok', 'config', `${STATE_DIR}/config.json (guard levels ${root.config.guardLevels}, lock timeout ${root.config.lockTimeoutMs} ms, wake-up ${root.config.wakeUpBudget} bytes)`);

  const { entries, corrupt, broken } = readLedger(root);
  if (broken > 0) {
    add('fail', 'ledger', `${plural(entries.length, 'entry')}; ${broken} break the chain (a line was edited or removed in the middle). Compare ${STATE_DIR}/ledger.jsonl with your backup or its git history.`);
  } else if (corrupt > 0) {
    add('warn', 'ledger', `${plural(entries.length, 'entry')}; ${corrupt} unreadable line(s) skipped (a write cut short by a crash). Nothing to do unless it grows.`);
  } else add('ok', 'ledger', `${plural(entries.length, 'entry')}, chain intact`);

  const shas = new Set(entries.slice(-50).flatMap((e) => [e.before, e.after]).filter((s) => typeof s === 'string'));
  const missing = [...shas].filter((s) => !hasObject(root, /** @type {string} */ (s)));
  if (missing.length) add('fail', 'objects', `${missing.length} version(s) of the last 50 entries are missing from ${STATE_DIR}/objects (e.g. ${String(missing[0]).slice(0, 12)}): restore that folder from a backup.`);
  else add('ok', 'objects', `every version of the last ${Math.min(50, entries.length)} entries is stored`);

  const lockFile = path.join(root.stateDir, 'run', 'lock');
  let lockStat = null;
  try {
    lockStat = fs.statSync(lockFile);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
  }
  if (!lockStat) add('ok', 'lock', 'free');
  else {
    /** @type {{ pid?: number, host?: string, ts?: string }} */
    let token = {};
    try {
      token = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    } catch {
      // A torn token: its age decides, as in the lock itself.
    }
    const orphan = now - lockStat.mtimeMs > 15000 || (token.host === os.hostname() && typeof token.pid === 'number' && !alive(token.pid));
    add('warn', 'lock', orphan ? `left by pid ${token.pid ?? '?'} (gone or too old): the next access takes it over` : `held now by pid ${token.pid ?? '?'} since ${token.ts ?? new Date(lockStat.mtimeMs).toISOString()}`);
  }

  const pendingDir = path.join(root.stateDir, 'run', 'pending');
  let oldPending = 0;
  try {
    for (const name of fs.readdirSync(pendingDir)) if (now - fs.statSync(path.join(pendingDir, name)).mtimeMs > 3_600_000) oldPending++;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
  }
  if (oldPending) add('warn', 'pending', `${plural(oldPending, 'prepared write')} older than 1 h never confirmed (the tool failed after its PreToolUse). Harmless; they are ignored.`);
  else add('ok', 'pending', 'no stale prepared writes');

  const recentErrors = [
    ...jsonlLines(path.join(root.stateDir, 'run', 'errors.jsonl')),
    ...jsonlLines(path.join(homeDir(), 'errors.jsonl')),
  ].filter((x) => typeof x.ts !== 'string' || now - Date.parse(x.ts) <= 86_400_000);
  if (recentErrors.length) {
    const last = recentErrors[recentErrors.length - 1];
    add('warn', 'errors', `${plural(recentErrors.length, 'error')} in the last 24 h (hooks let the agent through when they fail). Last: ${String(last.where ?? '')} ${String(last.message ?? '').slice(0, 300)}`);
  } else add('ok', 'errors', 'none in the last 24 h');

  const lexical = path.join(root.stateDir, 'index', 'lexical.json');
  let indexed = null;
  try {
    indexed = fs.statSync(lexical).mtimeMs;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
  }
  const notes = listNotes(root);
  if (indexed === null) add('warn', 'index', `not built yet (${plural(notes.length, 'note')}); ${NAME} index builds it, and so does the first search`);
  else {
    const since = /** @type {number} */ (indexed);
    const newer = notes.filter((rel) => fs.statSync(path.join(root.dir, rel)).mtimeMs > since).length;
    if (newer) add('warn', 'index', `${plural(newer, 'note')} changed since the last index; the next search catches up (or run ${NAME} index)`);
    else add('ok', 'index', `up to date (${plural(notes.length, 'note')})`);
  }

  const [level, detail] = await checkEmbeddings(root.config.embeddings, root);
  add(level, 'embeddings', detail);

  const settingsPaths = values.settings ? [values.settings] : installedSettingsPaths();
  if (settingsPaths.length === 0) add('warn', 'hooks', `not installed by this ${NAME} home; run: ${NAME} hooks install`);
  /** @type {string|null} a settings file whose hooks can run (for the adoption) */
  let hooksAt = null;
  for (const settingsPath of settingsPaths) {
    const status = hooksStatus({ settingsPath });
    const target = status.command?.match(/"([^"]+)"\s*$/)?.[1];
    if (target && !fs.existsSync(target)) add('fail', 'hooks', `${settingsPath} runs ${target}, which does not exist: run ${NAME} hooks install again from the current checkout`);
    else if (status.command && !target && callsByName(status.command) && !onPath(NAME)) add('warn', 'hooks', `${settingsPath} calls ${NAME} by name, and ${NAME} is not on the PATH: the hooks do nothing until it is (npm link, or npm install -g)`);
    else if (status.installed) {
      add('ok', 'hooks', `${settingsPath}: all ${status.present} entries`);
      hooksAt ??= settingsPath;
    } else add('warn', 'hooks', `${settingsPath}: missing ${status.missing.join(', ')}; run ${NAME} hooks install`);
  }

  const registered = listRegisteredRoots();
  const here = registered.some((r) => samePath(r, root.dir));
  const gone = registered.filter((r) => !fs.existsSync(path.join(r, STATE_DIR)));
  if (!here) add('warn', 'roots', `${root.dir} is not registered, so the hooks do not bring its notices; register it with: ${NAME} init "${root.dir}"`);
  else if (gone.length) add('warn', 'roots', `${plural(gone.length, 'registered root')} no longer exist(s) and are skipped: ${gone.join(', ')}`);
  else add('ok', 'roots', `${plural(registered.length, 'registered root')} (${toSlash(rootsFile())})`);

  add('ok', 'sessions', `${plural(activeSessions(root).length, 'active session')}`);
  lines.forEach((l) => out(l));

  // Adoption (§4.31): advice, never a check, so it does not change the exit code.
  // A workspace install (§4.29) keeps its hooks in <workspace>/.claude/settings.json.
  const inWorkspace = hooksAt !== null && !samePath(hooksAt, defaultSettingsPath()) && path.basename(path.dirname(hooksAt)) === '.claude';
  const openIn = inWorkspace ? path.dirname(path.dirname(/** @type {string} */ (hooksAt))) : root.dir;
  const { steps, next } = adoptionSteps(adoptionFacts(root, { hooksAt }), { notesDir: root.dir, openIn, firstFail });
  out('\nadoption:');
  for (const s of steps) out(`  ${s.status.padEnd(4)}  ${s.id}: ${s.detail}`);
  out(`next: ${next}`);
  return firstFail ? 1 : 0;
}

/** @param {string[]} args */
function cmdStatus(args) {
  const { values } = parse(args, { root: { type: 'string' } });
  const root = oneRoot(values.root);
  const now = Date.now();
  out(`root ${root.dir}`);
  const active = activeSessions(root);
  out(`\nactive sessions (${active.length}, seen in the last ${root.config.activeWindowMinutes} min):`);
  if (!active.length) out('  none');
  for (const s of active) {
    out(`  ${sid8(s.author.session)}  ${s.author.agent}${s.author.client ? `/${s.author.client}` : ''}  since ${when(s.started)}, seen ${hhmm(s.lastSeen)}${s.intent ? `  "${s.intent}"` : ''}${s.paths?.length ? `  ${s.paths.join(', ')}` : ''}`);
  }
  const { entries } = readLedger(root);
  const writes = entries.filter((e) => e.op !== 'adopt').slice(-10).reverse();
  out(`\nlast writes:`);
  if (!writes.length) out('  none since adoption');
  for (const e of writes) out(`  ${when(e.ts)}  ${e.op.padEnd(8)} ${e.rel}  session ${sid8(e.author.session)} (${e.author.agent})${e.reason ? `  "${e.reason}"` : ''}`);
  const external = entries.filter((e) => (e.op === 'external' || e.op === 'delete') && now - Date.parse(e.ts) <= 86_400_000);
  out(`\nexternal writes in the last 24 h (${external.length}):`);
  if (!external.length) out('  none');
  for (const e of external) out(`  ${when(e.ts)}  ${e.op.padEnd(8)} ${e.rel}${e.violations?.length ? `  removed sections others wrote: ${e.violations.join(', ')}` : ''}`);
  const leaseDir = path.join(root.stateDir, 'run', 'leases');
  /** @type {string[]} */
  const leases = [];
  try {
    for (const name of fs.readdirSync(leaseDir)) {
      try {
        const l = JSON.parse(fs.readFileSync(path.join(leaseDir, name), 'utf8'));
        if (Date.parse(l.expires) > now) leases.push(`  ${l.rel}  session ${sid8(String(l.session))} until ${hhmm(l.expires)}  "${l.reason}"`);
      } catch (e) {
        leases.push(`  (unreadable lease ${name}: ${/** @type {Error} */ (e).message})`);
      }
    }
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
  }
  out(`\nleases in force (${leases.length}):`);
  out(leases.length ? leases.join('\n') : '  none');
  return 0;
}

/** @param {string[]} args */
function cmdHistory(args) {
  const { values, positionals } = parse(args, { root: { type: 'string' }, limit: { type: 'string' } });
  const { root, rel } = noteArg(required(positionals[0], '<note>'), values.root);
  const entries = history(root, rel, { limit: positiveInt(values.limit, '--limit') });
  if (!entries.length) {
    err(`${rel} has no history in ${root.dir}.`);
    return 1;
  }
  entries.forEach((e) => out(entryLine(e)));
  return 0;
}

/** @param {string[]} args */
function cmdShow(args) {
  const { values, positionals } = parse(args, { root: { type: 'string' }, version: { type: 'string' } });
  const { root, rel } = noteArg(required(positionals[0], '<note>'), values.root);
  const v = required(values.version, '--version');
  const byId = history(root, rel).find((e) => e.id === v);
  if (byId && byId.after === null) {
    err(`Entry ${v} deleted ${rel}: it has no content.`);
    return 1;
  }
  process.stdout.write(showVersion(root, byId ? /** @type {string} */ (byId.after) : v));
  return 0;
}

/** @param {string[]} args */
function cmdAsOf(args) {
  const { values, positionals } = parse(args, { root: { type: 'string' } });
  const { root, rel } = noteArg(required(positionals[0], '<note>'), values.root);
  const date = required(positionals[1], '<date>');
  const found = asOf(root, rel, date);
  if (!found) {
    err(`${rel} did not exist at ${date}.`);
    return 1;
  }
  process.stdout.write(found.content);
  return 0;
}

/** @param {string[]} args */
async function cmdRestore(args) {
  const { values, positionals } = parse(args, { root: { type: 'string' }, reason: { type: 'string' } });
  const { root, rel } = noteArg(required(positionals[0], '<note>'), values.root);
  const id = required(positionals[1], '<id>');
  const res = await restore(root, rel, id, { author: cliAuthor(), reason: required(values.reason, '--reason') });
  if (!res.ok) {
    err(res.message);
    return 1;
  }
  out(`Restored ${rel} to version ${String(res.entry.after).slice(0, 8)} (ledger entry ${res.entry.id}).`);
  return 0;
}

/** @param {string[]} args */
function cmdAllow(args) {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    err(`allow needs a person at an interactive terminal: a lease lets a session remove sections another session wrote, so a human runs it, not an agent.`);
    return 2;
  }
  const { values, positionals } = parse(args, { root: { type: 'string' }, session: { type: 'string' }, reason: { type: 'string' }, minutes: { type: 'string' } });
  const { root, rel } = noteArg(required(positionals[0], '<note>'), values.root);
  const given = required(values.session, '--session');
  const reason = required(values.reason, '--reason');
  const known = knownSessions(root, { rel });
  let session = known.find((s) => s === given);
  if (!session) {
    const candidates = known.filter((s) => s.startsWith(given));
    if (candidates.length > 1) throw new UsageError(`${candidates.length} sessions start with "${given}": ${candidates.join(', ')}. Give more characters.`);
    if (candidates.length === 1) session = candidates[0];
    else if (given.length >= 16) session = given;
    else throw new UsageError(`No session starting with "${given}" was blocked on, or seen in, ${root.dir}. Pass the full session id.`);
  }
  const lease = grantLease(root, { session, rel, minutes: positiveInt(values.minutes, '--minutes'), reason });
  out(`Lease ${lease.id}: session ${session} may write "${rel}" past the guard until ${when(lease.expires)} (recorded in ${STATE_DIR}/leases.jsonl).`);
  return 0;
}

/** @param {string[]} args */
async function cmdMove(args) {
  const { values, positionals } = parse(args, { root: { type: 'string' }, reason: { type: 'string' } });
  const a = noteArg(required(positionals[0], '<from>'), values.root);
  const b = noteArg(required(positionals[1], '<to>'), values.root ?? a.root.dir);
  if (a.root.dir !== b.root.dir) throw new UsageError(`a note moves inside its root: ${positionals[1]} is not in ${a.root.dir}`);
  const res = await moveNote(a.root, a.rel, b.rel, { author: cliAuthor(), reason: required(values.reason, '--reason') });
  const touched = new Set(res.entries.filter((e) => e.op === 'edit').map((e) => e.rel)).size;
  out(`Moved ${a.rel} to ${b.rel}: ${plural(res.linksRewritten, 'link')} rewritten in ${plural(touched, 'note')}.`);
  return 0;
}

/**
 * @param {string|undefined} value
 * @returns {'hybrid'|'lexical'|undefined}
 */
function readerArg(value) {
  if (value === undefined || value === 'hybrid' || value === 'lexical') return value;
  throw new UsageError(`--reader must be hybrid or lexical (got "${value}")`);
}

/** @param {string[]} args */
async function cmdSearch(args) {
  const { values, positionals } = parse(args, {
    root: { type: 'string', multiple: true },
    k: { type: 'string', short: 'k' },
    reader: { type: 'string' },
    scope: { type: 'string', multiple: true },
    session: { type: 'string' },
  });
  const query = required(positionals.join(' '), '"<query>"');
  const roots = manyRoots(values.root, { registered: true });
  if (values.reader !== undefined && !['hybrid', 'lexical', 'session'].includes(values.reader)) {
    throw new UsageError(`--reader must be hybrid, lexical or session (got "${values.reader}")`);
  }
  const reader = values.reader === 'session' ? 'session' : readerArg(values.reader);
  /**
   * The session `--session` names: an id a root knows (it wrote, read, was blocked or is
   * present), or the only known one that starts with what was given. One nobody knows is
   * used as given, and said: it has touched nothing here, so only a match can answer.
   * @param {string} given
   * @returns {string}
   */
  const sessionNamed = (given) => {
    const known = new Set(roots.flatMap((r) => [...knownSessions(r), ...sessionsWithReads(r)]));
    if (known.has(given)) return given;
    const candidates = [...known].filter((s) => s.startsWith(given));
    if (candidates.length > 1) throw new UsageError(`${candidates.length} sessions start with "${given}": ${candidates.join(', ')}. Give more characters.`);
    if (candidates.length === 1) return candidates[0];
    err(`warning: no session "${given}" read or wrote notes in ${roots.map((r) => r.dir).join(', ')}; only a match for the query can answer.`);
    return given;
  };
  const session = values.session === undefined ? undefined : sessionNamed(required(values.session, '--session'));
  if (reader === 'session' && session === undefined) throw new UsageError('--reader session needs --session <id>');
  /** @type {import('../../search.js').SearchOptions} */
  const options = {
    k: positiveInt(values.k, '-k'),
    reader,
    scope: values.scope,
    ...(session !== undefined ? { session } : {}),
  };
  const started = performance.now();
  const res = await search(roots, query, options);
  const ms = performance.now() - started;
  // First, so the hits below are not read as matches for the query.
  const from = sessionLine(res);
  if (from) out(from);
  const degraded = degradedLine(res);
  if (degraded) out(degraded);
  if (!res.hits.length) out('No results.');
  for (const hit of res.hits) {
    out(`${roots.length > 1 ? `${hit.root} :: ` : ''}${formatHit(hit)}  (score ${hit.score.toFixed(4)})`);
    const text = hit.text.split('\n').filter((l) => l.trim() !== '');
    text.slice(0, 4).forEach((l) => out(`    ${l}`));
    if (text.length > 4) out('    …');
    // After the hit's own text, so that text is not read as the current one's.
    const follow = formatFollow(hit);
    if (follow) out(`  ${follow}`);
  }
  for (const w of res.warnings ?? []) err(`warning: ${w}`);
  // Last, once the answer is out: it never throws, and a failure only reaches errors.jsonl.
  recordSearch('cli', roots, options, res, ms);
  return 0;
}

/** @param {string[]} args */
function cmdReport(args) {
  const { values } = parse(args, { root: { type: 'string', multiple: true }, days: { type: 'string' } });
  const days = positiveInt(values.days, '--days');
  /** @type {Root[]} */
  let roots;
  if (values.root?.length) roots = values.root.map((d) => rootAt(path.resolve(d)));
  else {
    const registered = registeredRoots();
    for (const m of registered.missing) err(`warning: left out ${m.dir}, registered but not a root now: ${m.reason}`);
    if (!registered.roots.length) {
      err(
        `No roots to report on: ${registered.missing.length ? 'none of the registered ones exists now' : 'none is registered'} (${toSlash(rootsFile())}). ` +
          `Pass --root <dir>, or govern your notes first: ${NAME} init <dir> --adopt`,
      );
      return 1;
    }
    roots = registered.roots;
  }
  out(JSON.stringify(buildReport(roots, { days, hookInstalls: installedSettingsPaths().length }), null, 2));
  return 0;
}

/** @param {string[]} args */
function cmdBundle(args) {
  const { values } = parse(args, { root: { type: 'string' }, budget: { type: 'string' } });
  const root = oneRoot(values.root);
  process.stdout.write(bundle(root, { budget: positiveInt(values.budget, '--budget') ?? DEFAULT_BUDGET }));
  return 0;
}

/** @param {string[]} args */
async function cmdIndex(args) {
  const { values } = parse(args, { root: { type: 'string' } });
  const root = oneRoot(values.root);
  const res = await updateIndex(root, { onProgress: (done, total) => err(`indexed ${done}/${total} notes…`) });
  out(`Indexed ${res.reindexed} of ${plural(res.total, 'note')}${res.removed ? ` (${res.removed} removed)` : ''}.`);
  for (const s of res.skipped) err(`skipped ${s.rel}: ${s.reason}`);
  if (res.embeddings) {
    const e = res.embeddings;
    out(`embeddings (${e.model}): ${e.embedded} new, ${e.total - e.missing}/${e.total} sections embedded${e.error ? `; ${e.error}` : ''}`);
  }
  for (const w of res.warnings) err(`warning: ${w}`);
  return 0;
}

/** @param {string[]} args */
async function cmdScan(args) {
  const { values } = parse(args, { root: { type: 'string' } });
  const root = oneRoot(values.root);
  const recorded = await scanExternal(root);
  if (!recorded.length) {
    out('No external writes: every note matches the ledger.');
    return 0;
  }
  for (const e of recorded) out(`${e.op.padEnd(8)} ${e.rel}${e.violations?.length ? `  (removed sections others wrote: ${e.violations.join(', ')})` : ''}`);
  out(`Recorded ${plural(recorded.length, 'external write')} (author: external).`);
  return 0;
}

/** @param {string[]} args */
function cmdAudit(args) {
  const { values } = parse(args, { root: { type: 'string' }, since: { type: 'string' }, json: { type: 'boolean' } });
  let since;
  try {
    since = parseSince(values.since);
  } catch (e) {
    throw new UsageError(/** @type {Error} */ (e).message);
  }
  const root = oneRoot(values.root);
  const res = audit(root, { since });
  const code = res.losses.length ? 1 : 0;
  if (values.json) {
    out(JSON.stringify(res, null, 2));
    return code;
  }
  out(`audit of ${root.dir} ${res.since ? `since ${when(res.since)}` : 'over the whole ledger'} (${plural(res.entries, 'ledger entry')})`);

  out(`\nlosses: ${res.losses.length}`);
  for (const l of res.losses) out(`  - ${l.kind}: ${l.detail}`);

  const open = res.clashes.filter((c) => c.state === 'open').length;
  out(`\nclashes (a write removed sections another session wrote): ${res.clashes.length}${res.clashes.length ? ` (${open} open)` : ''}`);
  for (const c of res.clashes) {
    const e = c.entry;
    // a fork dropped the version it was written over, not its own `before`
    const was = c.fork ? c.overwritten : e.before;
    const see = c.restorable && c.state === 'open' && was ? `  what was there: ${NAME} show "${c.rel}" --version ${was.slice(0, 12)}` : '';
    const what = c.keys.length ? c.keys.join(', ') : 'changes inside sections';
    const fork = c.fork ? '  fork: written over a version it never read' : '';
    out(`  ${when(e.ts)}  ${e.op.padEnd(8)} ${c.rel}  ${what}  session ${sid8(e.author.session)} (${e.author.agent})  ${c.state}${fork}${see}`);
  }

  out(`\nremoved under a lease (a person allowed it): ${res.authorized.length}`);
  for (const a of res.authorized) {
    out(`  ${when(a.entry.ts)}  ${a.entry.rel}  ${a.keys.join(', ')}  session ${sid8(a.entry.author.session)}  lease ${a.entry.override?.lease}`);
  }

  const resumed = res.denials.filter((d) => d.resumed).length;
  out(`\nblocked by the guard: ${res.denials.length}${res.denials.length ? ` (${resumed} wrote the note afterwards)` : ''}`);
  for (const d of res.denials) {
    const what = d.sections.length ? `  ${d.sections.map((s) => `${s.key} (${s.owners.map(sid8).join(', ')})`).join(', ')}` : '';
    out(`  ${when(d.ts)}  session ${sid8(d.session)}  ${d.rel}${what}  ${d.resumed ? 'wrote it afterwards' : 'did not write it afterwards'}`);
  }

  out(`\nnot recorded yet (changed on disk; the next access or ${NAME} scan records them): ${res.unrecorded.length}`);
  res.unrecorded.slice(0, 10).forEach((rel) => out(`  ${rel}`));
  if (res.unrecorded.length > 10) out(`  … and ${res.unrecorded.length - 10} more`);
  return code;
}

/**
 * @param {{ hit: number, total: number }} c
 */
const ratio = (c) => (c.total ? `${c.hit}/${c.total}` : '-');

/** @param {string[]} args */
async function cmdEval(args) {
  const { values, positionals } = parse(args, {
    root: { type: 'string', multiple: true },
    k: { type: 'string' },
    reader: { type: 'string' },
    results: { type: 'string' },
  });
  const file = path.resolve(required(positionals[0], '<cases.json>'));
  let cases;
  try {
    cases = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`cannot read the cases in ${file}: ${/** @type {Error} */ (e).message}`);
  }
  const roots = manyRoots(values.root);
  const report = await runEval(roots, cases, { k: positiveInt(values.k, '--k'), reader: readerArg(values.reader) });
  out(`reader: ${report.reader}${report.degraded ? `  (${report.degraded})` : ''}`);
  out(`${'split'.padEnd(9)}${'note'.padEnd(10)}${'section'.padEnd(10)}none`);
  for (const [name, c] of [['dev', report.bySplit.dev], ['holdout', report.bySplit.holdout], ['all', report]]) {
    const counts = /** @type {import('../../eval.js').EvalCounts} */ (c);
    out(`${String(name).padEnd(9)}${ratio(counts.note).padEnd(10)}${ratio(counts.section).padEnd(10)}${ratio(counts.none)}`);
  }
  out('The holdout row is the honest one: its cases were never used to tune anything.');
  for (const f of report.failures) out(`fail #${f.index + 1} [${f.kind}] "${f.query}": expected ${f.expected}; got ${f.got.map((g) => g.rel).join(', ') || 'nothing'}`);
  if (values.results) {
    const target = path.resolve(values.results);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, report.results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    out(`Wrote ${plural(report.results.length, 'result')} to ${toSlash(target)}.`);
  }
  return 0;
}

/** @param {string[]} args */
function cmdHooks(args) {
  const { values, positionals } = parse(args, { settings: { type: 'string' }, command: { type: 'string' } });
  const sub = positionals[0];
  const settingsPath = toSlash(path.resolve(values.settings ?? defaultSettingsPath()));
  if (values.command !== undefined && sub !== 'install') throw new UsageError('--command only goes with hooks install');
  if (sub === 'install') {
    if (values.command !== undefined && values.command.trim() === '') throw new UsageError('--command needs the command that runs this tool');
    const command = values.command ?? `node "${realPathLoose(BIN)}"`;
    const res = installHooks({ settingsPath, command });
    const diff = lineDiff(res.before, res.after);
    out(`${settingsPath}:`);
    out(diff);
    out(res.backupPath ? `Backup of the original: ${res.backupPath}` : `${settingsPath} did not exist; uninstall removes it again.`);
    out(res.added ? `Installed ${res.added} hook entries. Sessions started from now on use them.` : 'The hooks were already installed; their command is up to date.');
    return 0;
  }
  if (sub === 'uninstall') {
    const res = uninstallHooks({ settingsPath });
    if (res.after !== null) out(lineDiff(res.before, res.after));
    if (res.identical) out(`Removed ${res.removed} hook entries. ${settingsPath} is back, byte for byte, to what it was before the install${res.backupPath ? ` (${res.backupPath})` : ''}.`);
    else out(`Removed ${res.removed} hook entries. ${settingsPath} changed after the install, so it was rewritten with 2-space indentation; everything else in it stays.`);
    return 0;
  }
  if (sub === 'status') {
    const s = hooksStatus({ settingsPath });
    out(`${settingsPath}: ${s.installed ? 'installed' : s.present ? `partly installed (missing ${s.missing.join(', ')})` : 'not installed'}`);
    if (s.command) out(`command: ${s.command}`);
    if (s.backupPath) out(`backup: ${s.backupPath}`);
    return s.installed ? 0 : 1;
  }
  throw new UsageError('hooks needs install, uninstall or status');
}

/**
 * The roots the GUI shows: --root, the one here, or every registered one; none is not an
 * error (the page then says how to start).
 * @param {string[]|undefined} given
 * @returns {Root[]}
 */
function guiRoots(given) {
  if (given && given.length) return given.map((d) => rootAt(path.resolve(d)));
  const here = findRoot(process.cwd());
  if (here) return [here];
  return registeredRoots().roots;
}

/** @param {string} file */
function openInBrowser(file) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => err(`Could not open a browser; open ${toSlash(file)} yourself.`));
    child.unref();
  } catch {
    err(`Could not open a browser; open ${toSlash(file)} yourself.`);
  }
}

/**
 * The 3D view (galaxia/, a preview of the v2 GUI): exports one root, serves it on 127.0.0.1 and
 * opens the browser; it runs until the window is closed. The workspace (where rules.md lives)
 * tells it whether to show the first step: --workspace, or the current folder when it has rules.md.
 * @param {string[]} args
 */
async function cmdGalaxia(args) {
  const { values } = parse(args, { root: { type: 'string' }, workspace: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' } });
  const roots = guiRoots(values.root ? [values.root] : undefined);
  if (roots.length !== 1) {
    err(roots.length ? `Which notes? Pass one with --root:\n${roots.map((r) => `  ${toSlash(r.dir)}`).join('\n')}` : `No notes governed by ${NAME} yet. Run: ${NAME} init <folder> --adopt`);
    return 2;
  }
  const workspace = values.workspace ? path.resolve(values.workspace) : fs.existsSync(path.join(process.cwd(), 'rules.md')) ? process.cwd() : undefined;
  const script = fileURLToPath(new URL('../../../galaxia/servir.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--raiz', roots[0].dir, ...(workspace ? ['--espacio', workspace] : []), ...(values.port ? ['--puerto', values.port] : []), ...(values['no-open'] ? [] : ['--abrir'])], { stdio: 'inherit' });
  return await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

/** @param {string[]} args */
async function cmdGui(args) {
  const { values } = parse(args, {
    root: { type: 'string', multiple: true },
    out: { type: 'string' },
    pack: { type: 'string' },
    query: { type: 'string', multiple: true },
    note: { type: 'string' },
    k: { type: 'string', short: 'k' },
    reader: { type: 'string' },
    open: { type: 'boolean' },
    watch: { type: 'boolean' },
    'allow-remote': { type: 'boolean' },
    packs: { type: 'boolean' },
  });
  if (values.packs) {
    // the 3D GUI's packs (format 2) are listed too, marked: `mneme gui` does not load them
    for (const p of listPacks()) out(`${p.name}${p.name === DEFAULT_PACK ? ' (default)' : ''}${p.format === 2 ? ' (3D GUI)' : ''}  ${p.builtin ? 'built-in' : p.dir}`);
    return 0;
  }
  const allowRemote = Boolean(values['allow-remote']);
  const pack = loadPack(values.pack ?? DEFAULT_PACK, { allowRemote });
  const target = path.resolve(values.out ?? path.join(homeDir(), 'gui', 'index.html'));
  const k = positiveInt(values.k, '-k');
  const reader = readerArg(values.reader);
  const write = async () => {
    const roots = guiRoots(values.root);
    const data = await collectGui(roots, { queries: values.query ?? [], note: values.note, k, reader, watch: Boolean(values.watch) });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderGui(data, pack, { allowRemote }), 'utf8');
    return data;
  };
  const data = await write();
  const notes = data.roots.reduce((n, r) => n + r.notes.length, 0);
  out(`Wrote ${toSlash(target)} (${plural(data.roots.length, 'root')}, ${plural(notes, 'note')}, pack ${pack.chain.join(' → ')}).`);
  for (const r of data.roots) if (r.error) err(`${r.dir}: ${r.error.message} Run: ${r.error.command}`);
  out(values.watch ? 'Watching the ledgers; the page reloads itself every 5 s. Stop with Ctrl+C.' : `Open it in a browser; run ${NAME} gui again to refresh it (or --watch).`);
  if (values.open) openInBrowser(target);
  if (!values.watch) return 0;
  /** @param {Root} r */
  const stamp = (r) =>
    ['ledger.jsonl', 'run/denials.jsonl', 'run/sessions', 'run/pending']
      .map((f) => {
        try {
          const st = fs.statSync(path.join(r.stateDir, f));
          return `${st.mtimeMs}:${st.size}`;
        } catch {
          return '-';
        }
      })
      .join('|');
  let last = guiRoots(values.root).map(stamp).join('#');
  await new Promise(() => {
    setInterval(async () => {
      const now = guiRoots(values.root).map(stamp).join('#');
      if (now === last) return;
      last = now;
      try {
        await write();
        err(`${new Date().toLocaleTimeString()} rewrote ${toSlash(target)}`);
      } catch (e) {
        err(`could not rewrite the page: ${/** @type {Error} */ (e).message}`);
      }
    }, 2000);
  });
  return 0;
}

/** @param {string[]} args */
async function cmdMcp(args) {
  const { values } = parse(args, { root: { type: 'string', multiple: true }, 'read-only': { type: 'boolean' }, session: { type: 'string' }, print: { type: 'boolean' } });
  // Any AI that speaks MCP uses mneme through this (informe QoL 26/09, R6; Artu 27/09: «es agnóstico a la
  // AI que usen», e.g. Qwen on Ollama inside Odysseus). A client that is not Claude Code has no session
  // id to hand over, so each start was a new «mcp-xxxx» and, after a restart, the agent could not rewrite
  // its own sections: --session gives it a name that lasts.
  if (values.session !== undefined && !/^[\w.-]{1,64}$/.test(values.session)) {
    throw new UsageError('--session is a name of up to 64 letters, digits, dots, dashes or underscores (e.g. qwen or research-agent)');
  }
  const roots = manyRoots(values.root, { registered: true });
  if (values.print) {
    // what to paste in the client's MCP settings: absolute paths, so it works whatever its PATH is
    const bin = fileURLToPath(new URL('../../../bin/mneme.js', import.meta.url));
    const serverArgs = [bin, 'mcp', ...roots.flatMap((r) => ['--root', r.dir]), ...(values.session ? ['--session', values.session] : []), ...(values['read-only'] ? ['--read-only'] : [])];
    out(JSON.stringify({ mcpServers: { [NAME]: { command: process.execPath, args: serverArgs } } }, null, 2));
    if (!values.session) err(`Tip: add --session <name> so this AI keeps its identity across restarts (without it, it cannot rewrite its own sections after one).`);
    return 0;
  }
  const { startServer } = await import('../mcp/server.js');
  await startServer({ roots, readOnly: values['read-only'] === true, ...(values.session ? { sessionId: values.session } : {}) });
  return 0;
}

/** @param {string[]} args */
function cmdWakeUp(args) {
  const { values } = parse(args, { root: { type: 'string', multiple: true }, budget: { type: 'string' } });
  const roots = manyRoots(values.root, { registered: true });
  const configured = Math.max(0, ...roots.map((r) => r.config.wakeUpBudget));
  const total = positiveInt(values.budget, '--budget') ?? (configured > 0 ? configured : DEFAULT_BUDGET);
  const each = Math.floor(total / roots.length);
  process.stdout.write(roots.map((r) => wakeUpBlock(r, each)).join(''));
  return 0;
}

/** @param {string[]} args */
async function cmdMessage(args) {
  const [sub, ...rest] = args;
  if (sub === 'send') {
    const { values, positionals } = parse(rest, { root: { type: 'string' }, 'reply-to': { type: 'string' }, correlation: { type: 'string' } });
    const to = required(positionals[0], '<to>');
    const body = required(positionals.slice(1).join(' '), '<body>');
    const root = oneRoot(values.root);
    const m = await sendMessage(root, { from: cliAuthor(), to, body, replyTo: values['reply-to'], correlation: values.correlation });
    const reach = m.to === '*' ? (m.recipients?.length ? ` to ${plural(m.recipients.length, 'active session')}` : ': no other session is active now, nobody will get it') : '';
    out(`Sent message ${m.id}${reach} (conversation ${m.correlation.slice(0, 8)}).`);
    return 0;
  }
  if (sub === 'list') {
    const { values } = parse(rest, { root: { type: 'string' }, session: { type: 'string' }, limit: { type: 'string' } });
    const root = oneRoot(values.root);
    const limit = positiveInt(values.limit, '--limit') ?? 20;
    const s = values.session;
    const all = readMessages(root).filter((m) => !s || m.to === s || m.from.session === s || (m.to === '*' && m.recipients?.includes(s)) || m.to === 'next');
    if (!all.length) out('No messages.');
    for (const m of all.slice(-limit)) {
      out(`${m.id.slice(0, 8)}  ${when(m.ts)}  from ${sid8(m.from.session)} (${m.from.agent}) to ${m.to === '*' || m.to === 'next' ? m.to : sid8(m.to)}${m.replyTo ? `  reply to ${m.replyTo.slice(0, 8)}${m.status ? ` (${m.status})` : ''}` : ''}: "${m.body}"`);
    }
    return 0;
  }
  throw new UsageError('message needs send or list');
}

/**
 * The hook entry point: reads the event from stdin, answers on stdout, always exit 0.
 * @param {string[]} args
 */
async function cmdHook(args) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let event;
    try {
      event = JSON.parse(raw);
    } catch (e) {
      const { recordHomeError } = await import('../../registry.js');
      recordHomeError(`hook ${args[0] ?? '?'}`, `payload is not JSON (${/** @type {Error} */ (e).message}): ${raw.slice(0, 200)}`);
      return 0;
    }
    if (event && typeof event === 'object' && !Array.isArray(event) && !event.hook_event_name && args[0]) event.hook_event_name = args[0];
    const answer = await handleHook(event);
    if (answer) process.stdout.write(JSON.stringify(answer));
  } catch (e) {
    const { recordHomeError } = await import('../../registry.js');
    recordHomeError(`hook ${args[0] ?? '?'}`, /** @type {Error} */ (e)?.stack ?? String(e));
  }
  return 0;
}

/** @type {Record<string, (args: string[]) => Promise<number>|number>} */
const COMMANDS = {
  init: cmdInit,
  doctor: cmdDoctor,
  gui: cmdGui,
  galaxia: cmdGalaxia,
  status: cmdStatus,
  history: cmdHistory,
  show: cmdShow,
  'as-of': cmdAsOf,
  restore: cmdRestore,
  allow: cmdAllow,
  move: cmdMove,
  search: cmdSearch,
  bundle: cmdBundle,
  index: cmdIndex,
  scan: cmdScan,
  audit: cmdAudit,
  eval: cmdEval,
  hooks: cmdHooks,
  mcp: cmdMcp,
  'wake-up': cmdWakeUp,
  message: cmdMessage,
  report: cmdReport,
  hook: cmdHook,
};

/** The commands a person types, in the table's order: every one of them has a line in the help. */
export const COMMAND_NAMES = Object.keys(COMMANDS).filter((name) => name !== 'hook'); // `hook` is what the hooks call

/** The help text, as `--help` prints it. */
export const HELP = USAGE;

/**
 * Runs one command line.
 * @param {string[]} argv  the arguments after the program name
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  const [name, ...args] = argv;
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    out(USAGE);
    return name === undefined ? 2 : 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    err(`unknown command "${name}"\n\n${USAGE}`);
    return 2;
  }
  if (name !== 'hook' && (args.includes('--help') || args.includes('-h'))) {
    out(USAGE);
    return 0;
  }
  // §4.3: a root whose config.json has problems opens on the defaults; the terminal hears it once
  // (doctor prints it itself as a failed check; a hook says it in the session, not on stderr)
  if (name !== 'hook' && name !== 'doctor') {
    onConfigProblems((r) => err(`${NAME}: ${toSlash(r.stateDir)}/config.json: ${(r.configProblems ?? []).join('; ')}. Working on the defaults for that; see: ${NAME} doctor --root "${r.dir}"`));
  }
  try {
    return await command(args);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${NAME} ${name}: ${e.message}\n(${NAME} --help lists every command)`);
      return 2;
    }
    if (e instanceof MnemeError || e instanceof TypeError || e instanceof RangeError) {
      err(e.message);
      return 1;
    }
    err(`${NAME} ${name} failed: ${/** @type {Error} */ (e)?.stack ?? String(e)}`);
    return 1;
  }
}
