import fs from 'node:fs';
import path from 'node:path';
import { MnemeError } from './errors.js';
import { STATE_DIR } from './name.js';

/** @typedef {import('./types.js').Root} Root */

const CASELESS = process.platform === 'win32' || process.platform === 'darwin';

/** @param {string} p */
export const toSlash = (p) => String(p).replace(/\\/g, '/').normalize('NFC');

/** @param {string} p */
const comparable = (p) => (CASELESS ? toSlash(p).toLowerCase() : toSlash(p)).replace(/\/+$/, '');

/**
 * @param {string} child
 * @param {string} parent
 */
export function isUnder(child, parent) {
  const c = comparable(child);
  const p = comparable(parent);
  return c === p || c.startsWith(p + '/');
}

/**
 * Real path of `p`, even when `p` does not exist yet: the nearest existing ancestor is
 * resolved (so a junction or symlink lands on its target) and the rest is appended.
 * @param {string} p
 */
export function realPathLoose(p) {
  const abs = path.resolve(p);
  /** @type {string[]} */
  const rest = [];
  let current = abs;
  for (;;) {
    try {
      return toSlash(path.join(fs.realpathSync.native(current), ...rest));
    } catch {
      const up = path.dirname(current);
      if (up === current) return toSlash(abs);
      rest.unshift(path.basename(current));
      current = up;
    }
  }
}

/**
 * Resolves a path given by a caller (relative to the root, or absolute) and refuses
 * anything outside the root or inside its state directory.
 * @param {Root} root
 * @param {string} p
 * @returns {{ abs: string, rel: string }}
 */
export function resolveInRoot(root, p) {
  const candidate = path.isAbsolute(p) ? p : path.join(root.dir, p);
  const real = realPathLoose(candidate);
  if (!isUnder(real, root.dir) || comparable(real) === comparable(root.dir)) {
    throw new MnemeError('PATH_ESCAPES_ROOT', `Path escapes the root: ${p}`);
  }
  const rel = real.slice(toSlash(root.dir).replace(/\/+$/, '').length + 1);
  const parts = rel.split('/');
  const first = parts[0];
  if ((CASELESS ? first.toLowerCase() : first) === (CASELESS ? STATE_DIR.toLowerCase() : STATE_DIR)) {
    throw new MnemeError('PATH_IN_STATE_DIR', `Path is inside the state directory ${STATE_DIR}/: ${p}`);
  }
  // A subdirectory with its own state directory is another root: it governs its notes.
  for (let i = 1; i < parts.length; i++) {
    const dir = `${toSlash(root.dir).replace(/\/+$/, '')}/${parts.slice(0, i).join('/')}`;
    if (isStateHolder(dir)) {
      throw new MnemeError('PATH_IN_OTHER_ROOT', `Path belongs to the nested root ${dir}: ${p}`);
    }
  }
  return { abs: real, rel };
}

/**
 * True when `dir` contains the state directory, i.e. it is a root.
 * @param {string} dir
 */
export function isStateHolder(dir) {
  try {
    return fs.statSync(path.join(dir, STATE_DIR)).isDirectory();
  } catch {
    return false;
  }
}
