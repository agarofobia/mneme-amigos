// The guard: a session may not remove a section another session wrote.
// Pure functions: the store gives them the texts and the owners from the ledger.
import { NAME } from './name.js';
import { headingCounts } from './sections.js';

/** @typedef {import('./types.js').LedgerEntry} LedgerEntry */
/** @typedef {{ key: string, owners: string[] }} Lost */

/**
 * Checks whether going from `before` to `after` removes a protected section owned by
 * another session.
 *
 * Rule: for every heading key at level <= `levels` whose count goes DOWN, if any other
 * session owns any copy of that key, the write is denied. With repeated titles there is
 * no telling which copy went, so the ambiguity is denied too. A key nobody else owns can
 * go freely (renaming or removing your own section); headings with no owner at all
 * (adopted, older than the root) are free.
 *
 * @param {{ before: string|null, after: string, owners: Map<string, Map<string, number>>, session: string, levels: number }} input
 * @returns {{ ok: boolean, lost: Lost[] }}
 */
export function checkSections({ before, after, owners, session, levels }) {
  if (before === null) return { ok: true, lost: [] };
  const was = headingCounts(before, levels);
  const now = headingCounts(after, levels);
  /** @type {Lost[]} */
  const lost = [];
  for (const [key, n] of was) {
    if ((now.get(key) ?? 0) >= n) continue;
    const others = [...(owners.get(key) ?? new Map())]
      .filter(([s, copies]) => s !== session && copies > 0)
      .map(([s]) => s)
      .sort();
    if (others.length > 0) lost.push({ key, owners: others });
  }
  return { ok: lost.length === 0, lost };
}

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');

/**
 * Local `yyyy-mm-dd hh:mm` of an ISO timestamp (the reader is a person at this machine).
 * @param {string} iso
 */
function stamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** @param {string} session */
export const sid8 = (session) => session.slice(0, 8);

/**
 * The denial text of docs/diseno/02-mapa.md §④, exact.
 * `entriesByKey` gives, for each lost key, the ledger entries where its owners added it
 * (one line per owner). `session` is the session that was blocked: the lease is for it.
 * `leaseMinutes` is the root's config value (default 10), so the text never drifts from it.
 * @param {{ rel: string, lost: Lost[], tool?: string, entriesByKey?: Map<string, LedgerEntry[]>, session?: string, leaseMinutes?: number }} input
 * @returns {string}
 */
export function guardMessage({ rel, lost, tool, entriesByKey, session, leaseMinutes = 10 }) {
  const lines = [`[${NAME}] Blocked: this write to "${rel}" removes sections written by another session:`];
  for (const { key, owners } of lost) {
    const entries = entriesByKey?.get(key) ?? [];
    for (const owner of owners) {
      const entry = entries.find((e) => e.author.session === owner);
      const who = entry
        ? `session ${sid8(owner)}, ${entry.author.agent}, ${stamp(entry.ts)}`
        : `session ${sid8(owner)}`;
      lines.push(`  - ${key}   (${who})`);
    }
  }
  lines.push(
    tool === 'Write'
      ? 'A Write replaces the whole file: re-read it and use Edit on your own section.'
      : "Edit only your own section; the other session's sections stay.",
  );
  lines.push(
    `If a human confirms the removal, they run in a terminal: ${NAME} allow "${rel}" --session ${session ? sid8(session) : '<session>'} --reason "<why>" (${leaseMinutes}-minute lease, recorded).`,
  );
  return lines.join('\n');
}
