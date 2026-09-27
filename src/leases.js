// Leases: a human lets one session through the guard on one note for a few minutes.
// The live lease is `<stateDir>/run/leases/<session>.json` (one per session); every
// grant is also appended to `<stateDir>/leases.jsonl`, the durable audit.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MnemeError } from './errors.js';
import { recordError } from './lock.js';
import { newId } from './ledger.js';
import { writeFileAtomic } from './objects.js';
import { resolveInRoot } from './paths.js';

/** @typedef {import('./types.js').Root} Root */
/**
 * @typedef {Object} Lease
 * @property {string} id
 * @property {string} session  the session allowed through the guard
 * @property {string} rel      the only note it covers
 * @property {string} reason
 * @property {string} granted  ISO timestamp
 * @property {string} expires  ISO timestamp
 */

/**
 * A file name that cannot leave its directory, whatever the session id holds.
 * @param {string} id
 */
export function safeFileName(id) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : createHash('sha256').update(id, 'utf8').digest('hex');
}

/**
 * @param {Root} root
 * @param {string} session
 */
const leaseFile = (root, session) => path.join(root.stateDir, 'run', 'leases', `${safeFileName(session)}.json`);

/**
 * Grants `session` a lease on `rel` for `minutes` (default: the root's `leaseMinutes`).
 * A new lease of the same session replaces its previous one.
 * @param {Root} root
 * @param {{ session: string, rel: string, minutes?: number, reason: string }} request
 * @returns {Lease}
 */
export function grantLease(root, { session, rel, minutes = root.config.leaseMinutes, reason }) {
  if (typeof session !== 'string' || session.trim() === '') {
    throw new MnemeError('NO_SESSION', 'A lease needs the session it lets through: pass --session <id>.');
  }
  if (!(minutes > 0)) {
    throw new MnemeError('CONFIG_INVALID', `A lease lasts a positive number of minutes (got ${minutes}).`);
  }
  const note = resolveInRoot(root, rel).rel;
  const now = Date.now();
  /** @type {Lease} */
  const lease = {
    id: newId(),
    session,
    rel: note,
    reason: String(reason ?? ''),
    granted: new Date(now).toISOString(),
    expires: new Date(now + minutes * 60_000).toISOString(),
  };
  const file = leaseFile(root, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(lease)}\n`);
  fs.appendFileSync(path.join(root.stateDir, 'leases.jsonl'), `${JSON.stringify(lease)}\n`, 'utf8');
  return lease;
}

/**
 * The lease `session` holds on `rel` right now, or null.
 * @param {Root} root
 * @param {string} session
 * @param {string} rel
 * @returns {Lease|null}
 */
export function activeLease(root, session, rel) {
  const file = leaseFile(root, session);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
  let lease;
  try {
    lease = /** @type {Lease} */ (JSON.parse(text));
  } catch (e) {
    recordError(root, 'lease', `unreadable lease file ${file}, ignored: ${/** @type {Error} */ (e).message}`);
    return null;
  }
  const note = resolveInRoot(root, rel).rel;
  if (lease.session !== session || lease.rel !== note) return null;
  return Date.parse(lease.expires) > Date.now() ? lease : null;
}
