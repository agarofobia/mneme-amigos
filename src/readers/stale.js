// Staleness: what a reader marks as no longer current (CA-5).
//
// A whole note is stale when its frontmatter says `expires: YYYY-MM-DD` (and that day is
// before today) or `superseded_by: <link>`. A section is stale when its own text holds a
// line `<!-- expires: YYYY-MM-DD -->` or `<!-- superseded-by: <link> -->`; a subsection
// inherits the marker of the section that contains it. `metadataAliases` names other keys
// that count the same. Only the UTC day of `now` matters, never the time of day.

/** @typedef {import('../types.js').ParsedNote} ParsedNote */
/** @typedef {import('../types.js').Config} Config */
/** @typedef {Config['metadataAliases']} MetadataAliases */

/** @type {MetadataAliases} */
const NO_ALIASES = { expires: [], superseded_by: [], pinned: [] };

/** @param {string} key */
const canonical = (key) => key.trim().toLowerCase().replace(/-/g, '_');

/**
 * @param {'expires'|'superseded_by'|'pinned'} field
 * @param {MetadataAliases} aliases
 * @returns {Set<string>}
 */
function keysFor(field, aliases) {
  return new Set([field, ...(aliases[field] ?? [])].map(canonical));
}

/**
 * The first value of a frontmatter field or any of its aliases.
 * @param {ParsedNote} parsed
 * @param {'expires'|'superseded_by'|'pinned'} field
 * @param {MetadataAliases} aliases
 * @returns {string|null}
 */
export function frontmatterValue(parsed, field, aliases = NO_ALIASES) {
  const wanted = keysFor(field, aliases);
  for (const [key, value] of Object.entries(parsed.frontmatter.data)) {
    if (!wanted.has(canonical(key))) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.trim() !== '') return first.trim();
  }
  return null;
}

/**
 * `YYYY-MM-DD` of a value that starts with a date, or null.
 * @param {string} value
 */
function dateOf(value) {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  // Reject impossible dates such as 2026-02-31 instead of reading them as another day.
  const probe = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === day ? day : null;
}

/**
 * The UTC day of `now`, `YYYY-MM-DD`.
 * @param {Date} now
 */
export function utcDay(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  return now.toISOString().slice(0, 10);
}

/** How a superseded verdict starts; `supersededLink` reads the link back from here. */
const SUPERSEDED = 'superseded by ';

/**
 * @param {string|null} expires
 * @param {string|null} superseded
 * @param {string} today
 * @returns {{ reason: string } | null}
 */
function verdict(expires, superseded, today) {
  if (superseded) return { reason: `${SUPERSEDED}${superseded}` };
  const day = expires ? dateOf(expires) : null;
  if (day && day < today) return { reason: `expired ${day}` };
  return null;
}

const MARKER = /<!--\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*-->/g;

/**
 * Markers written as HTML comments inside a section's own text.
 * @param {string} text
 * @param {MetadataAliases} aliases
 * @returns {{ expires: string|null, superseded: string|null }}
 */
function markersIn(text, aliases) {
  const expiresKeys = keysFor('expires', aliases);
  const supersededKeys = keysFor('superseded_by', aliases);
  /** @type {string|null} */
  let expires = null;
  /** @type {string|null} */
  let superseded = null;
  for (const m of text.matchAll(MARKER)) {
    const key = canonical(m[1]);
    const value = m[2].trim();
    if (value === '') continue;
    if (expiresKeys.has(key) && expires === null) expires = value;
    else if (supersededKeys.has(key) && superseded === null) superseded = value;
  }
  return { expires, superseded };
}

/**
 * Whether a note, or one of its sections, is no longer current.
 * @param {ParsedNote} parsed  the parsed note
 * @param {{ text: string } | null} section  the text that can hold section markers (the
 *   section's own text, plus that of the sections containing it: see `markerScope`), or
 *   null to judge the note alone
 * @param {Date} now  only its UTC day is used
 * @param {MetadataAliases} [aliases]
 * @returns {{ reason: string } | null}  reason: `expired <yyyy-mm-dd>` or `superseded by <link>`
 */
export function staleness(parsed, section, now, aliases = NO_ALIASES) {
  const today = utcDay(now);
  const note = verdict(
    frontmatterValue(parsed, 'expires', aliases),
    frontmatterValue(parsed, 'superseded_by', aliases),
    today,
  );
  if (note || !section) return note;
  const { expires, superseded } = markersIn(section.text, aliases);
  return verdict(expires, superseded, today);
}

/**
 * The link a stale verdict points to, as written, when the note or section was superseded.
 * An expired one points nowhere: null.
 * @param {{ reason: string } | null | undefined} stale  what `staleness` returned
 * @returns {string|null}
 */
export function supersededLink(stale) {
  if (!stale || !stale.reason.startsWith(SUPERSEDED)) return null;
  const link = stale.reason.slice(SUPERSEDED.length).trim();
  return link === '' ? null : link;
}

/**
 * The text that can carry the markers of section `index` (-1 = the preamble): its own text
 * and the own text of every section that contains it.
 * @param {string} text  the whole note
 * @param {ParsedNote} parsed
 * @param {number} index
 * @returns {{ text: string }}
 */
export function markerScope(text, parsed, index) {
  if (index < 0) return { text: text.slice(parsed.preamble.start, parsed.preamble.ownEnd) };
  const target = parsed.sections[index];
  const parts = [];
  for (let i = 0; i <= index; i++) {
    const s = parsed.sections[i];
    const contains = i === index || (s.level < target.level && s.start < target.start && target.start < s.end);
    if (contains) parts.push(text.slice(s.start, s.ownEnd));
  }
  return { text: parts.join('\n') };
}

/**
 * Whether the note is pinned (`pinned: true` or an alias) for the CAG bundle.
 * @param {ParsedNote} parsed
 * @param {MetadataAliases} [aliases]
 */
export function isPinned(parsed, aliases = NO_ALIASES) {
  const value = frontmatterValue(parsed, 'pinned', aliases);
  return value !== null && /^(true|yes)$/i.test(value);
}
