import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.js';
import { MnemeError } from './errors.js';
import { NAME, STATE_DIR } from './name.js';
import { isStateHolder, realPathLoose, toSlash } from './paths.js';

/** @typedef {import('./types.js').Root} Root */

/** @param {string} dir */
const hasState = (dir) => {
  try {
    return fs.statSync(path.join(dir, STATE_DIR)).isDirectory();
  } catch {
    return false;
  }
};

/** @param {string} where */
const notFound = (where) =>
  new MnemeError(
    'ROOT_NOT_FOUND',
    `No governed root found at or above ${where}. Create one with: ${NAME} init <dir> (add --adopt if it already has notes).`,
  );

/** @type {Array<(root: Root) => void>} who hears about a root whose config has problems (the CLI: stderr) */
const listeners = [];
/** the state dirs already reported in this process, so a command that opens a root twice says it once */
const reported = new Set();

/**
 * Calls `fn` once per root, in this process, when it opens with config problems (§4.3: tolerant).
 * @param {(root: Root) => void} fn
 */
export function onConfigProblems(fn) {
  listeners.push(fn);
}

/**
 * Opens the root whose directory is exactly `dir`. Its config is read TOLERANTLY (§4.3): what the
 * file gets wrong goes back to its default and is listed in `configProblems`, so a typo in
 * config.json never leaves the notes ungoverned.
 * @param {string} dir
 * @returns {Root}
 */
export function openRoot(dir) {
  const real = realPathLoose(dir);
  if (!hasState(real)) throw notFound(toSlash(dir));
  const stateDir = `${real}/${STATE_DIR}`;
  const { config, problems } = readConfig(stateDir);
  /** @type {Root} */
  const root = { dir: real, stateDir, config, ...(problems.length ? { configProblems: problems } : {}) };
  if (problems.length && !reported.has(stateDir)) {
    reported.add(stateDir);
    for (const fn of listeners) fn(root);
  }
  return root;
}

/**
 * The root that governs `anyPath`: the nearest ancestor (or itself) that contains the
 * state directory, like git with `.git`.
 * @param {string} anyPath
 * @returns {Root|null}
 */
export function findRoot(anyPath) {
  let current = realPathLoose(anyPath);
  try {
    if (!fs.statSync(current).isDirectory()) current = toSlash(path.dirname(current));
  } catch {
    current = toSlash(path.dirname(current));
  }
  for (;;) {
    if (hasState(current)) return openRoot(current);
    const up = toSlash(path.dirname(current));
    if (up === current) return null;
    current = up;
  }
}

/**
 * Every note under the root, as sorted relative paths, honoring `extensions`,
 * `ignoreDirs` (by name, anywhere) and `ignorePaths` (relative prefixes).
 * @param {Root} root
 * @returns {string[]}
 */
export function listNotes(root) {
  const { extensions, ignoreDirs, ignorePaths } = root.config;
  const exts = extensions.map((e) => e.toLowerCase());
  const skipDir = new Set(ignoreDirs);
  const prefixes = ignorePaths.map((p) => toSlash(p).replace(/^\.\//, '').replace(/\/+$/, ''));
  /** @type {string[]} */
  const out = [];
  /** @param {string} relDir */
  const walk = (relDir) => {
    const abs = relDir ? `${root.dir}/${relDir}` : root.dir;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (prefixes.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
      if (entry.isDirectory()) {
        // A nested root is a boundary: its notes are governed by it, not by this root.
        if (!skipDir.has(entry.name) && !isStateHolder(`${abs}/${entry.name}`)) walk(rel);
      } else if (entry.isFile() && exts.includes(path.extname(entry.name).toLowerCase())) {
        out.push(toSlash(rel));
      }
    }
  };
  walk('');
  return out.sort();
}
