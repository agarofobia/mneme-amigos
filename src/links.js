// Links between notes: find them, resolve them the way Obsidian does, and rewrite the
// ones that point to a note that moved (I-3). Links inside code (fenced blocks and
// inline spans) are text, not links.
import path from 'node:path';
import { listNotes } from './root.js';

/** @typedef {import('./types.js').Root} Root */
/**
 * @typedef {Object} Link
 * @property {number} start   offset of the first character (the `!` of an embed)
 * @property {number} end     offset right after the last character
 * @property {string} target  wiki: the note name or path as written · md: the decoded relative path
 * @property {string} [heading]
 * @property {string} [alias] wiki alias, or the label of a markdown link
 * @property {boolean} embed
 * @property {'wiki'|'md'} kind
 */

const posix = path.posix;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MD = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\((<[^>\n]+>|[^)\s]+)((?:[ \t]+"[^"\n]*")?)\)/g;
const MD_ONE = new RegExp(`^${MD.source}$`);
const INLINE_CODE = /(`+)(?:[^`\n]|(?!\1)`+)*?\1/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const NOTE_EXT = /\.md$/i;

/**
 * The text with code (fences and inline spans) blanked out, same length, so offsets hold.
 * @param {string} text
 */
function maskCode(text) {
  const chars = text.split('');
  /** @param {number} from @param {number} to */
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  /** @type {{ char: string, len: number }|null} */
  let fence = null;
  let fenceStart = 0;
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end).replace(/\r$/, '');
    const f = line.match(FENCE);
    if (f) {
      if (!fence) {
        fence = { char: f[1][0], len: f[1].length };
        fenceStart = start;
      } else if (f[1][0] === fence.char && f[1].length >= fence.len && line.trim() === f[1]) {
        blank(fenceStart, end);
        fence = null;
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  if (fence) blank(fenceStart, text.length); // an unclosed fence runs to the end
  let masked = chars.join('');
  masked = masked.replace(INLINE_CODE, (m) => m.replace(/[^\n]/g, ' '));
  return masked;
}

/**
 * The pieces of a wiki link's inner text: `target#heading|alias` (a table cell escapes
 * the pipe as `\|`).
 * @param {string} inner
 */
function parseWiki(inner) {
  let targetPart = inner;
  /** @type {string|undefined} */
  let alias;
  let pipe = '|';
  const bar = inner.indexOf('|');
  if (bar !== -1) {
    targetPart = inner.slice(0, bar);
    alias = inner.slice(bar + 1);
    if (targetPart.endsWith('\\')) {
      targetPart = targetPart.slice(0, -1);
      pipe = '\\|';
    }
  }
  /** @type {string|undefined} */
  let heading;
  const hash = targetPart.indexOf('#');
  if (hash !== -1) {
    heading = targetPart.slice(hash + 1);
    targetPart = targetPart.slice(0, hash);
  }
  return { target: targetPart.trim(), heading, alias, pipe };
}

/** @param {string} s */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    // A stray `%` that is not an escape: the path is taken as written.
    return s;
  }
}

/**
 * The pieces of a markdown link's destination: `<path with spaces>` or `path`, then `#anchor`.
 * @param {string} dest
 */
function parseHref(dest) {
  const angled = dest.startsWith('<') && dest.endsWith('>');
  const raw = angled ? dest.slice(1, -1) : dest;
  const hash = raw.indexOf('#');
  const file = hash === -1 ? raw : raw.slice(0, hash);
  const anchor = hash === -1 ? undefined : raw.slice(hash + 1);
  return { angled, file, anchor, target: angled ? file : decode(file) };
}

/**
 * Every link to another note, outside code: `[[t]]`, `[[t#h]]`, `[[t|a]]`, `![[t]]` and
 * relative markdown links `[x](rel.md)`.
 * @param {string} text
 * @returns {Link[]} in document order
 */
export function findLinks(text) {
  const masked = maskCode(text);
  /** @type {Link[]} */
  const out = [];
  for (const m of masked.matchAll(WIKI)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const inner = text.slice(start + m[1].length + 2, end - 2);
    const { target, heading, alias } = parseWiki(inner);
    if (target === '') continue; // [[#heading]]: a link inside the same note
    /** @type {Link} */
    const link = { start, end, target, embed: m[1] === '!', kind: 'wiki' };
    if (heading !== undefined) link.heading = heading;
    if (alias !== undefined) link.alias = alias;
    out.push(link);
  }
  for (const m of masked.matchAll(MD)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const original = text.slice(start, end);
    const labelStart = m[1].length + 1;
    const label = original.slice(labelStart, labelStart + m[2].length);
    const destStart = labelStart + m[2].length + 2;
    const dest = original.slice(destStart, destStart + m[3].length);
    const { file, anchor, target } = parseHref(dest);
    if (file === '' || SCHEME.test(file) || file.startsWith('/') || !NOTE_EXT.test(target)) continue;
    /** @type {Link} */
    const link = { start, end, target, alias: label, embed: m[1] === '!', kind: 'md' };
    if (anchor !== undefined) link.heading = anchor;
    out.push(link);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** @param {string} rel */
const stem = (rel) => posix.basename(rel).replace(/\.[^./]+$/, '');

/** @param {string} p */
const hasExt = (p) => /\.[A-Za-z0-9]+$/.test(posix.basename(p));

/** @param {string} target */
const isRelative = (target) => target.startsWith('./') || target.startsWith('../');

/**
 * Where a relative path lands, from the folder of `fromRel` (null: above the root).
 * @param {string} fromRel
 * @param {string} target
 */
function join(fromRel, target) {
  const p = posix.normalize(posix.join(posix.dirname(fromRel), target));
  return p.startsWith('../') || p === '..' ? null : p;
}

/** @param {string} p */
const depth = (p) => p.split('/').length;

/**
 * The tie-break when a name matches several notes: the shortest path, read as the fewest
 * folders (closest to the root), then the fewest characters, then alphabetical.
 * @param {string[]} list
 */
const shortest = (list) =>
  [...list].sort((a, b) => depth(a) - depth(b) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;

/**
 * The note a link target points to, the way Obsidian resolves it: a name without a
 * folder matches by file name (case-insensitive; several matches: the shortest path);
 * a path matches from the root, or relative with `./` `../`. Markdown links are relative
 * to the note that holds them.
 * @param {Root} root
 * @param {string} fromRel  the note that holds the link
 * @param {string} target
 * @param {{ kind?: 'wiki'|'md', notes?: string[] }} [options]  `notes`: a precomputed listNotes(root)
 * @returns {string|null}
 */
export function resolveTarget(root, fromRel, target, { kind = 'wiki', notes } = {}) {
  const all = notes ?? listNotes(root);
  const lower = new Map(all.map((n) => [n.toLowerCase(), n]));
  /** @param {string|null} p */
  const exact = (p) => (p === null ? null : (lower.get(p.toLowerCase()) ?? null));
  if (kind === 'md') return exact(join(fromRel, target));
  let t = target.trim().replace(/^\/+/, '');
  if (t === '') return null;
  const exts = root.config.extensions;
  /** @param {string} p */
  const variants = (p) => (exts.some((e) => p.toLowerCase().endsWith(e.toLowerCase())) ? [p] : exts.map((e) => p + e));
  if (isRelative(t)) {
    const p = join(fromRel, t);
    if (p === null) return null;
    t = p;
    for (const v of variants(t)) if (exact(v)) return exact(v);
    return null;
  }
  if (t.includes('/')) {
    for (const v of variants(t)) if (exact(v)) return exact(v);
    const suffixes = variants(t).map((v) => `/${v.toLowerCase()}`);
    return shortest(all.filter((n) => suffixes.some((s) => n.toLowerCase().endsWith(s))));
  }
  const names = new Set(variants(t).map((v) => v.toLowerCase()));
  return shortest(all.filter((n) => names.has(posix.basename(n).toLowerCase())));
}

/**
 * Textual resolution without a root: good when names are unique. The store passes a
 * resolver built on resolveTarget instead.
 * @param {Link} link
 * @param {string} fromRel
 * @param {string} oldRel
 * @returns {string|null}
 */
function resolveLoose(link, fromRel, oldRel) {
  const ext = posix.extname(oldRel);
  if (link.kind === 'md') return join(fromRel, link.target);
  if (isRelative(link.target)) {
    const p = join(fromRel, link.target);
    return p === null ? null : hasExt(p) ? p : `${p}${ext}`;
  }
  const t = link.target.replace(/^\/+/, '');
  const withExt = hasExt(t) ? t : `${t}${ext}`;
  if (t.includes('/')) return withExt.toLowerCase() === oldRel.toLowerCase() ? oldRel : withExt;
  return withExt.toLowerCase() === posix.basename(oldRel).toLowerCase() ? oldRel : null;
}

/**
 * @param {string} p
 */
const encodeHref = (p) => p.replace(/ /g, '%20');

/**
 * The text of `raw` (one link) pointing at `targetRel`, written from a note at `at`.
 * Keeps the embed mark, the heading, the alias/label and the link's own style.
 * @param {string} raw
 * @param {Link} link
 * @param {string} targetRel
 * @param {string} at
 * @param {(rel: string) => string} nameFor  the name a folderless wiki link uses for a note
 */
function render(raw, link, targetRel, at, nameFor) {
  const bang = link.embed ? '!' : '';
  if (link.kind === 'wiki') {
    const inner = raw.slice(bang.length + 2, -2);
    const { heading, alias, pipe } = parseWiki(inner);
    const written = link.target;
    const keepExt = hasExt(written);
    const noExt = (/** @type {string} */ p) => (keepExt ? p : p.replace(/\.[^./]+$/, ''));
    let next;
    if (isRelative(written)) {
      const r = posix.relative(posix.dirname(at), targetRel);
      next = noExt(r.startsWith('../') ? r : `./${r}`);
    } else if (written.includes('/')) {
      next = noExt(targetRel);
    } else {
      next = keepExt ? posix.basename(targetRel) : nameFor(targetRel);
    }
    return `${bang}[[${next}${heading !== undefined ? `#${heading}` : ''}${alias !== undefined ? `${pipe}${alias}` : ''}]]`;
  }
  const m = raw.match(MD_ONE);
  if (!m) return raw; // cannot happen: `raw` is what MD matched
  const [, , label, dest, title] = m;
  const { angled, anchor } = parseHref(dest);
  const r = posix.relative(posix.dirname(at), targetRel);
  const file = angled ? r : encodeHref(r);
  const href = `${file}${anchor !== undefined ? `#${anchor}` : ''}`;
  return `${bang}[${label}](${angled ? `<${href}>` : href}${title})`;
}

/**
 * Rewrites the links of `text` for which `map` returns a note, so they point to it from `at`.
 * @param {string} text
 * @param {string} at
 * @param {(link: Link) => string|null} map
 * @param {(rel: string) => string} nameFor
 * @returns {{ text: string, n: number }}
 */
export function relink(text, at, map, nameFor = stem) {
  const links = findLinks(text);
  let out = text;
  let n = 0;
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    const target = map(link);
    if (target === null) continue;
    const raw = text.slice(link.start, link.end);
    const next = render(raw, link, target, at, nameFor);
    if (next === raw) continue;
    out = out.slice(0, link.start) + next + out.slice(link.end);
    n++;
  }
  return { text: out, n };
}

/**
 * Rewrites the links in `text` (a note at `fromRel`) that point to `oldRel` so they point
 * to `newRel`, keeping `#heading`, `|alias` and `!`.
 * @param {string} text
 * @param {string} fromRel  where the note holding the links lives
 * @param {string} oldRel
 * @param {string} newRel
 * @param {{ resolve?: (link: Link) => string|null, newName?: string, at?: string }} [options]
 *   `resolve`: which note a link points to (default: by name and path, without a root) ·
 *   `newName`: what a folderless wiki link says (default: the new file name) ·
 *   `at`: where the holding note will live (default: fromRel)
 * @returns {{ text: string, n: number }}
 */
export function rewriteLinks(text, fromRel, oldRel, newRel, options = {}) {
  const resolve = options.resolve ?? ((/** @type {Link} */ link) => resolveLoose(link, fromRel, oldRel));
  const name = options.newName ?? stem(newRel);
  return relink(
    text,
    options.at ?? fromRel,
    (link) => (resolve(link) === oldRel ? newRel : null),
    (rel) => (rel === newRel ? name : stem(rel)),
  );
}
