// The registry of a user's governed roots: `<home>/roots.json`.
//
// The Claude Code hooks get no path on SessionStart or UserPromptSubmit (the cwd of a
// session is not its root), so `init` registers every root it creates and the hooks walk
// the registry. `<home>` is `$<NAME>_HOME` when set, else `~/.config/<NAME>`. Tests always
// point `<NAME>_HOME` at a temporary directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MnemeError } from './errors.js';
import { NAME } from './name.js';
import { writeFileAtomic } from './objects.js';
import { isUnder, realPathLoose, toSlash } from './paths.js';
import { openRoot } from './root.js';

/** @typedef {import('./types.js').Root} Root */

/** Environment variable that moves the registry home (tests, several profiles). */
export const HOME_ENV = `${NAME.toUpperCase()}_HOME`;

/** The registry home, forward slashes. */
export function homeDir() {
  const env = process.env[HOME_ENV];
  return realPathLoose(env && env.trim() !== '' ? env : path.join(os.homedir(), '.config', NAME));
}

/** `<home>/roots.json` */
export const rootsFile = () => path.join(homeDir(), 'roots.json');

/**
 * @param {string} a
 * @param {string} b
 */
export const samePath = (a, b) => isUnder(a, b) && isUnder(b, a);

/**
 * Every registered root dir, as written (real paths, forward slashes), including the ones
 * that no longer exist.
 * @returns {string[]}
 */
export function listRegisteredRoots() {
  const file = rootsFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new MnemeError(
      'CONFIG_INVALID',
      `${toSlash(file)} is not valid JSON (${/** @type {Error} */ (e).message}). Fix it, or delete it and run ${NAME} init <dir> --adopt again for each root.`,
    );
  }
  const roots = parsed && typeof parsed === 'object' ? /** @type {{ roots?: unknown }} */ (parsed).roots : undefined;
  if (!Array.isArray(roots) || roots.some((r) => typeof r !== 'string')) {
    throw new MnemeError('CONFIG_INVALID', `${toSlash(file)}: "roots" must be a list of directories.`);
  }
  return /** @type {string[]} */ (roots);
}

/** @param {string[]} roots */
function saveRoots(roots) {
  const file = rootsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify({ version: 1, roots }, null, 2)}\n`);
}

/**
 * Read-modify-write of the registry, re-checked after writing: two processes registering
 * at the same moment could otherwise lose one of the two.
 * @param {(roots: string[]) => string[]} change
 * @param {(roots: string[]) => boolean} done
 */
function update(change, done) {
  for (let attempt = 1; ; attempt++) {
    const next = change(listRegisteredRoots());
    saveRoots(next);
    const now = listRegisteredRoots();
    if (done(now)) return;
    if (attempt >= 5) {
      throw new Error(`${toSlash(rootsFile())} kept changing under this process; retry the command.`);
    }
  }
}

/**
 * Registers a root (idempotent).
 * @param {string} dir
 * @returns {{ dir: string, added: boolean }}
 */
export function registerRoot(dir) {
  const real = realPathLoose(dir);
  const added = !listRegisteredRoots().some((r) => samePath(r, real));
  if (!added) return { dir: real, added };
  update(
    (roots) => (roots.some((r) => samePath(r, real)) ? roots : [...roots, real]),
    (roots) => roots.some((r) => samePath(r, real)),
  );
  return { dir: real, added };
}

/**
 * Takes a root out of the registry. Its `.mneme/` stays: this only stops the hooks from
 * visiting it.
 * @param {string} dir
 * @returns {boolean} true when it was registered
 */
export function unregisterRoot(dir) {
  const real = realPathLoose(dir);
  if (!listRegisteredRoots().some((r) => samePath(r, real))) return false;
  update(
    (roots) => roots.filter((r) => !samePath(r, real)),
    (roots) => !roots.some((r) => samePath(r, real)),
  );
  return true;
}

/**
 * The registered roots that can be opened now; the others are listed with why not.
 * @returns {{ roots: Root[], missing: Array<{ dir: string, reason: string }> }}
 */
export function registeredRoots() {
  /** @type {Root[]} */
  const roots = [];
  /** @type {Array<{ dir: string, reason: string }>} */
  const missing = [];
  for (const dir of listRegisteredRoots()) {
    try {
      const root = openRoot(dir);
      if (!roots.some((r) => samePath(r.dir, root.dir))) roots.push(root);
    } catch (e) {
      missing.push({ dir, reason: /** @type {Error} */ (e).message });
    }
  }
  return { roots, missing };
}

/**
 * Records an error that has no root to go to (a hook with a broken payload, a broken
 * registry) in `<home>/errors.jsonl`, where `doctor` shows it. If even that fails, stderr.
 * @param {string} where
 * @param {string} message
 */
export function recordHomeError(where, message) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), where, pid: process.pid, message })}\n`;
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.appendFileSync(path.join(homeDir(), 'errors.jsonl'), line, 'utf8');
  } catch (e) {
    process.stderr.write(`[${NAME}] ${where}: ${message} (and could not record it: ${/** @type {Error} */ (e).message})\n`);
  }
}
