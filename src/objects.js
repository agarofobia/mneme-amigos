// Content-addressed store of every version of every note: `<stateDir>/objects/<aa>/<sha>`.
// An object is written once and never changes: its name is the sha256 of its content.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MnemeError } from './errors.js';

/** @typedef {import('./types.js').Root} Root */

const SHA = /^[0-9a-f]{64}$/;
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6; // the first try plus five retries (Windows: antivirus, indexers)

/**
 * sha256 hex of a text encoded as UTF-8.
 * @param {string} text
 */
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `content` to `abs` atomically: a temporary file in the same directory, then a
 * rename over the target. The temporary name never ends in a note extension
 * (`.<name>.<random>.tmp`), so an orphan left by a crash is never read as a note.
 * On Windows a rename can fail for a moment while another process has the target open:
 * it is retried up to five times.
 * @param {string} abs
 * @param {string} content
 * @param {{ beforeRename?: () => void }} [hooks]  test-only crash point
 */
export function writeFileAtomic(abs, content, hooks = {}) {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
  hooks.beforeRename?.();
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, abs);
      return;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
      if (RETRYABLE.has(code) && attempt < RENAME_ATTEMPTS) {
        sleepSync(10 * 2 ** attempt);
        continue;
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch (cleanup) {
        throw new Error(
          `Could not replace ${abs} (${code}) and could not remove the temporary file ${tmp}: ${/** @type {Error} */ (cleanup).message}`,
          { cause: e },
        );
      }
      throw e;
    }
  }
}

/**
 * @param {Root} root
 * @param {string} sha
 */
const objectPath = (root, sha) => path.join(root.stateDir, 'objects', sha.slice(0, 2), sha);

/**
 * True when the object store has this version.
 * @param {Root} root
 * @param {string} sha
 */
export function hasObject(root, sha) {
  return SHA.test(sha) && fs.existsSync(objectPath(root, sha));
}

/**
 * Stores `content` (once) and returns its sha.
 * @param {Root} root
 * @param {string} content
 * @returns {string}
 */
export function putObject(root, content) {
  const sha = sha256(content);
  const file = objectPath(root, sha);
  if (fs.existsSync(file)) return sha;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileAtomic(file, content);
  } catch (e) {
    // Another process may have stored the same object at the same moment: same name, same bytes.
    if (fs.existsSync(file) && sha256(fs.readFileSync(file, 'utf8')) === sha) return sha;
    throw e;
  }
  return sha;
}

/**
 * The content of a stored version.
 * @param {Root} root
 * @param {string} sha
 * @returns {string}
 */
export function getObject(root, sha) {
  if (!SHA.test(sha)) {
    throw new MnemeError('VERSION_NOT_FOUND', `Not a version id: "${sha}". A version is a 64-character sha256 (see the history of the note).`);
  }
  try {
    return fs.readFileSync(objectPath(root, sha), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') {
      throw new MnemeError(
        'VERSION_NOT_FOUND',
        `Version ${sha} is not in the object store of ${root.dir}. List the versions of a note with its history.`,
      );
    }
    throw e;
  }
}

/**
 * Every stored sha that starts with `prefix` (lowercase hex, at least 4 characters).
 * @param {Root} root
 * @param {string} prefix
 * @returns {string[]}
 */
export function findObjects(root, prefix) {
  const p = prefix.toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(p)) return [];
  const dir = path.join(root.stateDir, 'objects', p.slice(0, 2));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  return names.filter((n) => SHA.test(n) && n.startsWith(p)).sort();
}
