// Installs and removes this tool's hooks in a Claude Code settings.json (TE-5: install
// then uninstall leaves the file byte for byte as it was).
//
// Install keeps the original bytes in `<settings dir>/backups/<NAME>-settings-<ts>.json`
// and records the install in `<home>/install.json` (which command, which backup). Our
// entries are recognized by that command followed by ` hook <Event>`. Uninstall removes
// only ours; when what is left equals the backup, it writes the backup's bytes back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { NAME } from '../../name.js';
import { writeFileAtomic } from '../../objects.js';
import { realPathLoose, toSlash } from '../../paths.js';
import { homeDir, samePath } from '../../registry.js';

/**
 * One entry of `hooks.<Event>` in settings.json.
 * @typedef {{ matcher?: string, hooks: Array<{ type: string, command: string, [k: string]: unknown }>, [k: string]: unknown }} HookGroup
 */
/** @typedef {{ command: string, backupPath: string|null, created: boolean, ts: string }} InstallRecord */

/** The six entries: event, matcher (none for the session events). */
export const ENTRIES = /** @type {const} */ ([
  ['SessionStart', undefined],
  ['UserPromptSubmit', undefined],
  ['PreToolUse', 'Edit|Write|MultiEdit'],
  ['PostToolUse', 'Edit|Write|MultiEdit'],
  ['PostToolUse', 'Read'],
  ['SessionEnd', undefined],
]);

/** Where Claude Code keeps the user's settings: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function defaultSettingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return toSlash(path.join(dir && dir.trim() !== '' ? dir : path.join(os.homedir(), '.claude'), 'settings.json'));
}

/** @param {string} settingsPath */
const key = (settingsPath) => realPathLoose(settingsPath);

const installFile = () => path.join(homeDir(), 'install.json');

/** @returns {Record<string, InstallRecord>} */
function readInstalls() {
  let text;
  try {
    text = fs.readFileSync(installFile(), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return {};
    throw e;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && parsed.installs && typeof parsed.installs === 'object' ? parsed.installs : {};
  } catch (e) {
    throw new Error(`${toSlash(installFile())} is not valid JSON (${/** @type {Error} */ (e).message}). Fix it or delete it.`);
  }
}

/** @param {Record<string, InstallRecord>} installs */
function writeInstalls(installs) {
  fs.mkdirSync(homeDir(), { recursive: true });
  writeFileAtomic(installFile(), `${JSON.stringify({ version: 1, installs }, null, 2)}\n`);
}

/**
 * @param {string} settingsPath
 * @returns {InstallRecord|null}
 */
function recordOf(settingsPath) {
  const installs = readInstalls();
  const k = key(settingsPath);
  const found = Object.entries(installs).find(([p]) => samePath(p, k));
  return found ? found[1] : null;
}

/**
 * The file's bytes, or null when it does not exist.
 * @param {string} file
 */
function readBytes(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * @param {string} text
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function parseSettings(text, file) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${toSlash(file)} is not valid JSON (${/** @type {Error} */ (e).message}); nothing was changed.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${toSlash(file)} is not a JSON object; nothing was changed.`);
  }
  return parsed;
}

/**
 * The indentation the file uses (so an install does not restyle it) and its final newline.
 * @param {string} text
 */
function styleOf(text) {
  const m = text.match(/\n([ \t]+)\S/);
  return { indent: m ? m[1] : '  ', newline: text.endsWith('\n') ? '\n' : '' };
}

/**
 * The command written for one event: `{event}` in the template is replaced by the event's
 * name; a template without it gets ` hook <Event>` appended (the default form).
 * @param {string} template
 * @param {string} event
 */
export function expandCommand(template, event) {
  return template.includes('{event}') ? template.split('{event}').join(event) : `${template} hook ${event}`;
}

/** @param {string} text */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True for a hook command this tool installed: a known template expanded to any event, or
 * (no install record, e.g. a settings file carried from another machine) a command that
 * ends in `<NAME> hook <Event>` or `…bin/<NAME>.js" hook <Event>`.
 * @param {unknown} command
 * @param {string[]} known the templates this home installed
 */
export function isOurs(command, known) {
  if (typeof command !== 'string') return false;
  for (const template of known) {
    const pattern = template.includes('{event}')
      ? template.split('{event}').map(escapeRe).join('[A-Za-z]+')
      : `${escapeRe(template)} hook [A-Za-z]+`;
    if (new RegExp(`^${pattern}$`).test(command)) return true;
  }
  return new RegExp(`(?:^|[\\s/\\\\"])(?:${NAME}|bin[\\\\/]${NAME}\\.js"?) hook [A-Za-z]+$`).test(command);
}

/**
 * The settings without our entries. `prune` also drops the containers that end up empty.
 * @param {Record<string, unknown>} settings
 * @param {string[]} known
 * @param {boolean} prune
 */
function withoutOurs(settings, known, prune) {
  const copy = structuredClone(settings);
  const hooks = /** @type {Record<string, unknown>|undefined} */ (copy.hooks);
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return copy;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    /** @type {unknown[]} */
    const kept = [];
    for (const g of groups) {
      const group = /** @type {HookGroup} */ (g);
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        kept.push(g);
        continue;
      }
      const hadOurs = group.hooks.some((h) => isOurs(h?.command, known));
      const rest = group.hooks.filter((h) => !isOurs(h?.command, known));
      if (hadOurs && rest.length === 0) continue;
      kept.push(hadOurs ? { ...group, hooks: rest } : group);
    }
    if (prune && kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (prune && Object.keys(hooks).length === 0) delete copy.hooks;
  return copy;
}

/**
 * How many of the six entries are present, and which are missing.
 * @param {Record<string, unknown>} settings
 * @param {string[]} known
 */
function presence(settings, known) {
  const hooks = /** @type {Record<string, unknown>} */ (settings.hooks ?? {});
  /** @type {string[]} */
  const missing = [];
  let present = 0;
  for (const [event, matcher] of ENTRIES) {
    const groups = Array.isArray(hooks[event]) ? /** @type {HookGroup[]} */ (hooks[event]) : [];
    const found = groups.some(
      (g) =>
        g &&
        (g.matcher ?? undefined) === matcher &&
        Array.isArray(g.hooks) &&
        g.hooks.some((h) => isOurs(h?.command, known) && eventOf(h.command, known) === event),
    );
    if (found) present++;
    else missing.push(matcher ? `${event}(${matcher})` : event);
  }
  return { present, missing };
}

/**
 * Which event an entry of ours runs: the one its known template expands to, else the word
 * after the last ` hook `.
 * @param {unknown} command
 * @param {string[]} known
 */
function eventOf(command, known) {
  const text = String(command);
  for (const [event] of ENTRIES) if (known.some((t) => expandCommand(t, event) === text)) return event;
  return text.match(/ hook ([A-Za-z]+)$/)?.[1] ?? null;
}

/**
 * A timestamp usable in a file name on every platform.
 */
const stamp = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

/**
 * Adds the six hook entries to `settingsPath`, keeping everything else. Idempotent: a
 * second install replaces our entries (a moved checkout gets the new command) and keeps
 * the first backup, the one taken before any of ours existed.
 * @param {{ settingsPath: string, command: string }} options
 * @returns {{ backupPath: string|null, added: number, before: string, after: string }}
 *   `before`/`after`: the file's text, for showing a diff (`before` is '' when it did not exist)
 */
export function installHooks({ settingsPath, command }) {
  if (typeof command !== 'string' || command.trim() === '') throw new TypeError('installHooks needs the command that runs this tool');
  const original = readBytes(settingsPath);
  const settings = original === null ? {} : parseSettings(original, settingsPath);
  const previous = recordOf(settingsPath);
  const known = [command, ...(previous ? [previous.command] : [])];
  const already = presence(settings, known).present > 0;

  /** @type {string|null} */
  let backupPath = previous && already ? previous.backupPath : null;
  const created = previous && already ? previous.created : original === null;
  if (!(previous && already) && original !== null) {
    const dir = path.join(path.dirname(settingsPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    backupPath = toSlash(path.join(dir, `${NAME}-settings-${stamp()}.json`));
    fs.writeFileSync(backupPath, original, { encoding: 'utf8', flag: 'wx' });
  }

  const next = withoutOurs(settings, known, false);
  const hooks = /** @type {Record<string, HookGroup[]>} */ (next.hooks && typeof next.hooks === 'object' ? next.hooks : (next.hooks = {}));
  for (const [event, matcher] of ENTRIES) {
    /** @type {HookGroup} */
    const group = matcher ? { matcher, hooks: [] } : { hooks: [] };
    group.hooks.push({ type: 'command', command: expandCommand(command, event) });
    (hooks[event] ??= []).push(group);
  }
  const { indent, newline } = styleOf(original ?? '');
  const after = `${JSON.stringify(next, null, indent)}${original === null ? '\n' : newline}`;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileAtomic(settingsPath, after);

  const installs = readInstalls();
  for (const p of Object.keys(installs)) if (samePath(p, key(settingsPath))) delete installs[p];
  installs[key(settingsPath)] = { command, backupPath, created: Boolean(created), ts: new Date().toISOString() };
  writeInstalls(installs);
  return { backupPath, added: already ? 0 : ENTRIES.length, before: original ?? '', after };
}

/**
 * Removes our entries from `settingsPath`. When the rest equals the backup taken at
 * install, the backup's bytes are written back (identical byte for byte); otherwise the
 * user changed the file since, and it is rewritten with 2-space indentation.
 * @param {{ settingsPath: string }} options
 * @returns {{ identical: boolean, removed: number, backupPath: string|null, before: string, after: string|null }}
 *   `after` null: the file was deleted (the install had created it)
 */
export function uninstallHooks({ settingsPath }) {
  const current = readBytes(settingsPath);
  const record = recordOf(settingsPath);
  const known = record ? [record.command] : [];
  if (current === null) {
    forget(settingsPath);
    return { identical: false, removed: 0, backupPath: record?.backupPath ?? null, before: '', after: null };
  }
  const settings = parseSettings(current, settingsPath);
  const removed = presence(settings, known).present;
  const pruned = withoutOurs(settings, known, true);
  const kept = withoutOurs(settings, known, false);

  /** @type {string|null} */
  let after;
  let identical = false;
  const backup = record?.backupPath ? readBytes(record.backupPath) : null;
  if (backup !== null) {
    const original = parseSettings(backup, record?.backupPath ?? '');
    // Pruning the original too: an empty `"hooks": {}` or `"PreToolUse": []` in it means the same
    // as their absence, and `pruned` has already dropped them.
    if (isDeepStrictEqual(pruned, original) || isDeepStrictEqual(kept, original) || isDeepStrictEqual(pruned, withoutOurs(original, known, true))) {
      after = backup;
      identical = true;
    } else after = `${JSON.stringify(pruned, null, 2)}\n`;
  } else if (record?.created && isDeepStrictEqual(pruned, {})) {
    after = null; // the install created the file and nothing else is in it
    identical = true;
  } else after = `${JSON.stringify(pruned, null, 2)}\n`;

  if (after === null) fs.rmSync(settingsPath, { force: true });
  else writeFileAtomic(settingsPath, after);
  forget(settingsPath);
  return { identical, removed, backupPath: record?.backupPath ?? null, before: current, after };
}

/** @param {string} settingsPath */
function forget(settingsPath) {
  const installs = readInstalls();
  let changed = false;
  for (const p of Object.keys(installs)) {
    if (samePath(p, key(settingsPath))) {
      delete installs[p];
      changed = true;
    }
  }
  if (changed) writeInstalls(installs);
}

/**
 * Whether the six entries are in `settingsPath`.
 * @param {{ settingsPath: string }} options
 * @returns {{ installed: boolean, present: number, missing: string[], command: string|null, backupPath: string|null, exists: boolean }}
 */
export function hooksStatus({ settingsPath }) {
  const record = recordOf(settingsPath);
  const text = readBytes(settingsPath);
  if (text === null) {
    return { installed: false, present: 0, missing: ENTRIES.map(([e, m]) => (m ? `${e}(${m})` : e)), command: record?.command ?? null, backupPath: record?.backupPath ?? null, exists: false };
  }
  const { present, missing } = presence(parseSettings(text, settingsPath), record ? [record.command] : []);
  return { installed: present === ENTRIES.length, present, missing, command: record?.command ?? null, backupPath: record?.backupPath ?? null, exists: true };
}

/**
 * The settings files this home installed into (for `doctor`, which must not guess).
 * @returns {string[]}
 */
export function installedSettingsPaths() {
  return Object.keys(readInstalls());
}
