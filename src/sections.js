/** @typedef {import('./types.js').ParsedNote} ParsedNote */
/** @typedef {import('./types.js').Section} Section */
/** @typedef {import('./types.js').Frontmatter} Frontmatter */

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*(?:[ \t]#+[ \t]*)?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Splits text into lines keeping each line's start offset. Line terminators are not
 * part of `text` but are counted in the offsets.
 * @param {string} text
 * @returns {Array<{ text: string, start: number }>}
 */
function lines(text) {
  /** @type {Array<{ text: string, start: number }>} */
  const out = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      out.push({ text: text.slice(start), start });
      return out;
    }
    const raw = text.slice(start, nl);
    out.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, start });
    start = nl + 1;
  }
}

/** @param {string} value */
function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Minimal YAML frontmatter: `key: value`, `key: [a, b]` and block lists (`- item`).
 * Anything else is kept as a raw string. Never throws.
 * @param {string} text
 * @returns {Frontmatter}
 */
export function parseFrontmatter(text) {
  /** @type {Frontmatter} */
  const empty = { data: {}, end: 0 };
  const all = lines(text);
  if (all.length === 0 || all[0].text.trim() !== '---') return empty;
  const close = all.findIndex((l, i) => i > 0 && (l.text.trim() === '---' || l.text.trim() === '...'));
  if (close === -1) return empty;
  /** @type {Record<string, string|string[]>} */
  const data = {};
  /** @type {string|null} */
  let listKey = null;
  for (const { text: line } of all.slice(1, close)) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      const current = data[listKey];
      data[listKey] = [...(Array.isArray(current) ? current : []), unquote(item[1])];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-][^:]*?):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2];
    if (value.trim() === '') {
      data[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(value.trim())) {
      const inner = value.trim().slice(1, -1).trim();
      data[key] = inner === '' ? [] : inner.split(',').map(unquote);
      listKey = null;
    } else {
      data[key] = unquote(value);
      listKey = null;
    }
  }
  const after = all[close + 1];
  return { data, end: after ? after.start : text.length };
}

/**
 * Parses a markdown note into its frontmatter, preamble and sections.
 * ATX headings (`#`..`######`) only; headings inside ``` or ~~~ fences are ignored.
 * @param {string} text
 * @returns {ParsedNote}
 */
export function parseNote(text) {
  const frontmatter = parseFrontmatter(text);
  /** @type {Array<{ level: number, title: string, start: number }>} */
  const found = [];
  /** @type {{ char: string, len: number }|null} */
  let fence = null;
  for (const line of lines(text)) {
    if (line.start < frontmatter.end) continue;
    const f = line.text.match(FENCE);
    if (f) {
      const char = f[1][0];
      if (!fence) fence = { char, len: f[1].length };
      else if (char === fence.char && f[1].length >= fence.len && line.text.trim() === f[1]) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.text.match(HEADING);
    if (h && h[2].trim() !== '') found.push({ level: h[1].length, title: h[2].trim(), start: line.start });
  }

  /** @type {Section[]} */
  const sections = [];
  /** @type {Array<{ level: number, title: string }>} */
  const stack = [];
  for (let i = 0; i < found.length; i++) {
    const { level, title, start } = found[i];
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
    const next = found[i + 1];
    const closer = found.slice(i + 1).find((x) => x.level <= level);
    sections.push({
      level,
      title,
      key: `${'#'.repeat(level)} ${title}`,
      path: stack.map((s) => s.title),
      start,
      ownEnd: next ? next.start : text.length,
      end: closer ? closer.start : text.length,
    });
  }
  return {
    frontmatter,
    preamble: { start: frontmatter.end, ownEnd: found.length ? found[0].start : text.length },
    sections,
  };
}

/**
 * Multiset of heading keys at `maxLevel` or above (the guard's unit).
 * @param {string} text
 * @param {number} maxLevel
 * @returns {Map<string, number>}
 */
export function headingCounts(text, maxLevel) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const s of parseNote(text).sections) {
    if (s.level > maxLevel) continue;
    counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The own text of every section, keyed `key#occurrence` (occurrence starts at 1), plus
 * the preamble under `#0`. Used to tell which sections changed between two versions.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function sectionTexts(text) {
  const parsed = parseNote(text);
  /** @type {Map<string, string>} */
  const out = new Map([['#0', text.slice(parsed.preamble.start, parsed.preamble.ownEnd)]]);
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const s of parsed.sections) {
    const n = (seen.get(s.key) ?? 0) + 1;
    seen.set(s.key, n);
    out.set(`${s.key}#${n}`, text.slice(s.start, s.ownEnd));
  }
  return out;
}
