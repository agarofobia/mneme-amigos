// Packs (contracts §4.18): the GUI's skin as data. A pack is a folder with `pack.json`,
// CSS and assets — never a script — that styles the stable parts (`data-part`) and sets
// the `--mn-*` tokens. Third parties write them, so every pack is checked as untrusted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MnemeError } from '../errors.js';
import { homeDir } from '../registry.js';
import { toSlash } from '../paths.js';

/** The packs that ship with this tool. */
export const BUILTIN_DIR = fileURLToPath(new URL('../../packs/', import.meta.url));
export const DEFAULT_PACK = 'astrolabe';
/** The format the v1 GUI reads; loadPack asks for it unless told otherwise. */
export const PACK_FORMAT = 1;
/**
 * Format 2 is the 3D GUI (docs/diseno/gui-mapa.md ⑦: «los packs se redefinen para 3D»): the same
 * folder of data, with tokens for its own vocabulary (any `--name`, not only `--mn-*`) and an
 * `escena` object for what the space draws (colors and numbers only). Each GUI asks for its format,
 * so neither loads the other's pack by mistake.
 */
export const PACK_FORMATS = /** @type {const} */ ([1, 2]);
/** The devices the renderer knows how to draw (a pack picks one; §4.18). */
export const DEVICES = /** @type {const} */ (['armillary', 'none']);

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 4;
const SCRIPT_FILES = /\.(m?js|cjs|html?|xhtml|php|sh|ps1|bat|cmd|exe)$/i;
const ASSET_TYPES = /** @type {Record<string, string>} */ ({
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
});
/** What CSS in a pack may not contain: ways out of the style sheet, or into script. */
const CSS_FORBIDDEN = [
  [/<\s*script/i, '<script'],
  [/<\s*\/\s*style/i, '</style'],
  [/<!--/, '<!--'],
  [/javascript\s*:/i, 'javascript:'],
  [/expression\s*\(/i, 'expression('],
  [/-moz-binding/i, '-moz-binding'],
  [/behavior\s*:/i, 'behavior:'],
  [/@import/i, '@import'],
];

/**
 * @typedef {Object} Pack
 * @property {string} name
 * @property {string} version
 * @property {string} [description]
 * @property {1|2} format
 * @property {string[]} chain   names from the root ancestor down to this pack
 * @property {'armillary'|'none'} device
 * @property {Record<string, string>} tokens
 * @property {Escena} escena    format 2: what the space draws (empty in format 1)
 * @property {string} css       every style sheet in order, assets inlined as data: URLs
 * @property {string} dir
 */

/** @typedef {string|number|boolean|Array<string|number>|{ [k: string]: EscenaValue }} EscenaValue */
/** @typedef {{ [k: string]: EscenaValue }} Escena */

/**
 * @param {string} message
 * @param {string} [file]
 */
function invalid(message, file) {
  return new MnemeError('PACK_INVALID', `Pack refused${file ? ` (${toSlash(file)})` : ''}: ${message}`);
}

/**
 * A file inside the pack, never outside it.
 * @param {string} dir
 * @param {string} rel
 */
function inside(dir, rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel)) throw invalid(`"${rel}" must be a relative path inside the pack`, dir);
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) throw invalid(`"${rel}" is outside the pack`, dir);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw invalid(`"${rel}" does not exist`, dir);
  if (stat.size > MAX_BYTES) throw invalid(`"${rel}" is over 2 MB`, dir);
  return abs;
}

/**
 * Where a pack named by the user lives: a path, then `<home>/packs/<name>`, then the
 * built-in ones.
 * @param {string} nameOrDir
 * @param {string} [from]  the directory a relative `extends` is read from
 */
export function resolvePack(nameOrDir, from) {
  const looksLikePath = /[\\/]/.test(nameOrDir) || nameOrDir.startsWith('.');
  if (looksLikePath) {
    const dir = path.resolve(from ?? process.cwd(), nameOrDir);
    if (fs.existsSync(path.join(dir, 'pack.json'))) return dir;
    throw new MnemeError('PACK_NOT_FOUND', `No pack at ${toSlash(dir)} (it needs a pack.json).`);
  }
  for (const base of [path.join(homeDir(), 'packs'), BUILTIN_DIR]) {
    const dir = path.join(base, nameOrDir);
    if (fs.existsSync(path.join(dir, 'pack.json'))) return dir;
  }
  throw new MnemeError('PACK_NOT_FOUND', `No pack named "${nameOrDir}" (looked in ${toSlash(path.join(homeDir(), 'packs'))} and the built-in packs). List them with: mneme gui --packs`);
}

/**
 * The names of the packs available without a path, with the format each one declares (null when its
 * pack.json does not parse: loading it says why).
 * @returns {Array<{ name: string, dir: string, builtin: boolean, format: number|null, description?: string }>}
 */
export function listPacks() {
  /** @type {Array<{ name: string, dir: string, builtin: boolean, format: number|null, description?: string }>} */
  const out = [];
  for (const [base, builtin] of /** @type {Array<[string, boolean]>} */ ([[path.join(homeDir(), 'packs'), false], [BUILTIN_DIR, true]])) {
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const file = path.join(base, name, 'pack.json');
      if (!fs.existsSync(file) || out.some((p) => p.name === name)) continue;
      /** @type {any} */
      let m = null;
      try {
        m = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        m = null;
      }
      out.push({
        name,
        dir: toSlash(path.join(base, name)),
        builtin,
        format: typeof m?.packFormat === 'number' ? m.packFormat : null,
        ...(typeof m?.description === 'string' ? { description: m.description } : {}),
      });
    }
  }
  return out;
}

/**
 * Checks every file in the folder: a pack carries no script.
 * @param {string} dir
 */
function checkFiles(dir) {
  /** @param {string} d */
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (SCRIPT_FILES.test(e.name)) throw invalid(`a pack is data: ${path.relative(dir, abs)} looks like a script or a page`, dir);
    }
  };
  walk(dir);
}

/**
 * @param {string} css
 * @param {string} file
 * @param {boolean} allowRemote
 */
function checkCss(css, file, allowRemote) {
  for (const [re, what] of CSS_FORBIDDEN) if (/** @type {RegExp} */ (re).test(css)) throw invalid(`the style sheet contains ${what}`, file);
  if (!allowRemote && /url\(\s*["']?\s*(?:https?:|\/\/)/i.test(css)) throw invalid('the style sheet loads a remote url(); packs travel with their assets (or pass --allow-remote)', file);
}

/**
 * @param {unknown} tokens
 * @param {string} file
 * @param {number} format
 * @returns {Record<string, string>}
 */
function checkTokens(tokens, file, format) {
  if (tokens === undefined) return {};
  const shape = format === 1 ? /^--mn-[a-z0-9-]+$/ : /^--[a-z][a-z0-9-]*$/;
  const what = format === 1 ? 'must start with --mn- (lowercase, digits, dashes)' : 'must be a CSS variable: --, then lowercase, digits and dashes';
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw invalid(`"tokens" must be an object of ${format === 1 ? '--mn-*' : '--*'} variables`, file);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (!shape.test(k)) throw invalid(`token "${k}" ${what}`, file);
    if (typeof v !== 'string' || /[<>;{}]/.test(v) || /javascript\s*:|expression\s*\(|url\(/i.test(v)) throw invalid(`token ${k} has a value that is not a plain CSS value`, file);
    out[k] = v;
  }
  return out;
}

/**
 * What the space draws (format 2): only data a shader or a color can take — #rrggbb colors, numbers,
 * booleans, short lists of those, and objects of them. Which keys exist is the GUI's business (it
 * says which ones it does not know); here the shape is checked, so nothing else rides along.
 * @param {unknown} v
 * @param {string} file
 * @param {string} at
 * @param {number} [depth]
 * @returns {EscenaValue}
 */
function checkEscena(v, file, at, depth = 0) {
  const color = (/** @type {unknown} */ x) => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x);
  const numero = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 100000;
  if (color(v) || numero(v) || typeof v === 'boolean') return /** @type {string|number|boolean} */ (v);
  if (Array.isArray(v)) {
    if (v.length === 0 || v.length > 64) throw invalid(`escena.${at} must list between 1 and 64 values`, file);
    if (!v.every(color) && !v.every(numero)) throw invalid(`escena.${at} must list only #rrggbb colors or only numbers`, file);
    return /** @type {Array<string|number>} */ (v);
  }
  if (v && typeof v === 'object' && depth < 3) {
    /** @type {Escena} */
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(k)) throw invalid(`escena key "${at ? `${at}.` : ''}${k}" must be letters and digits`, file);
      out[k] = checkEscena(x, file, at ? `${at}.${k}` : k, depth + 1);
    }
    return out;
  }
  throw invalid(`escena.${at} must be a #rrggbb color, a number, true/false, a list or a group of them`, file);
}

/**
 * The child's scene over the parent's, group by group.
 * @param {Escena} base
 * @param {Escena} over
 * @returns {Escena}
 */
function mergeEscena(base, over) {
  /** @type {Escena} */
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = b && v && typeof b === 'object' && typeof v === 'object' && !Array.isArray(b) && !Array.isArray(v) ? mergeEscena(/** @type {Escena} */ (b), /** @type {Escena} */ (v)) : v;
  }
  return out;
}

/**
 * Reads, checks and flattens a pack (its `extends` chain included).
 * @param {string} nameOrDir
 * @param {{ allowRemote?: boolean, format?: 1|2 }} [options]  format: the one the calling GUI reads (1 by default)
 * @returns {Pack}
 */
export function loadPack(nameOrDir, options = {}) {
  return load(resolvePack(nameOrDir), Boolean(options.allowRemote), [], options.format ?? PACK_FORMAT);
}

/**
 * @param {string} dir
 * @param {boolean} allowRemote
 * @param {string[]} seen  real paths of the packs below this one
 * @param {1|2} format
 * @returns {Pack}
 */
function load(dir, allowRemote, seen, format) {
  const real = fs.realpathSync(dir);
  if (seen.includes(real)) throw invalid('extends makes a cycle', dir);
  if (seen.length >= MAX_DEPTH) throw invalid(`extends goes deeper than ${MAX_DEPTH} packs`, dir);
  const file = path.join(dir, 'pack.json');
  /** @type {Record<string, unknown>} */
  let m;
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw invalid(`pack.json is not valid JSON (${/** @type {Error} */ (e).message})`, file);
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw invalid('pack.json must be an object', file);
  if (m.packFormat !== format) {
    const other = PACK_FORMATS.includes(/** @type {any} */ (m.packFormat)) ? ` — it is a pack for the ${m.packFormat === 2 ? '3D GUI (v2)' : 'v1 GUI'}` : '';
    throw invalid(`packFormat must be ${format} (got ${JSON.stringify(m.packFormat)})${other}`, file);
  }
  if (format === 1 && m.escena !== undefined) throw invalid('"escena" is for packFormat 2 (the 3D GUI)', file);
  if (typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(m.name)) throw invalid('"name" must be lowercase letters, digits and dashes', file);
  if (typeof m.version !== 'string' || m.version === '') throw invalid('"version" is required', file);
  if (m.device !== undefined && !DEVICES.includes(/** @type {any} */ (m.device))) throw invalid(`"device" must be one of ${DEVICES.join(', ')}`, file);
  checkFiles(dir);

  /** @type {Pack|null} */
  const parent = m.extends === undefined ? null : load(resolvePack(String(m.extends), dir), allowRemote, [...seen, real], format);
  const escena = m.escena === undefined ? {} : checkEscena(m.escena, file, '');
  if (!escena || typeof escena !== 'object' || Array.isArray(escena)) throw invalid('"escena" must be an object', file);

  /** @type {Record<string, { mime: string, abs: string }>} */
  const assets = {};
  if (m.assets !== undefined) {
    if (!m.assets || typeof m.assets !== 'object' || Array.isArray(m.assets)) throw invalid('"assets" must be an object of name → file', file);
    for (const [name, rel] of Object.entries(m.assets)) {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw invalid(`asset name "${name}" must be letters, digits and dashes`, file);
      const abs = inside(dir, String(rel));
      const mime = ASSET_TYPES[path.extname(abs).toLowerCase()];
      if (!mime) throw invalid(`asset ${rel} is not a font or an image`, file);
      if (mime === 'image/svg+xml') {
        const svg = fs.readFileSync(abs, 'utf8');
        if (/<\s*script|\son[a-z]+\s*=|javascript\s*:|<\s*foreignObject/i.test(svg)) throw invalid(`${rel} carries script`, abs);
      }
      assets[name] = { mime, abs };
    }
  }

  const styles = m.styles === undefined ? (fs.existsSync(path.join(dir, 'pack.css')) ? ['pack.css'] : []) : m.styles;
  if (!Array.isArray(styles)) throw invalid('"styles" must be a list of .css files', file);
  let css = '';
  for (const rel of styles) {
    const abs = inside(dir, String(rel));
    if (path.extname(abs).toLowerCase() !== '.css') throw invalid(`${rel} is not a .css file`, file);
    const text = fs.readFileSync(abs, 'utf8');
    checkCss(text, abs, allowRemote);
    css += `\n/* ${String(m.name)}/${toSlash(String(rel))} */\n${text.replace(/url\(\s*(["']?)asset:([a-z0-9-]+)\1\s*\)/gi, (_, _q, name) => {
      const a = assets[name];
      if (!a) throw invalid(`asset:${name} is not declared in "assets"`, abs);
      return `url("data:${a.mime};base64,${fs.readFileSync(a.abs).toString('base64')}")`;
    })}`;
  }
  const tokens = { ...(parent?.tokens ?? {}), ...checkTokens(m.tokens, file, format) };
  return {
    name: m.name,
    version: m.version,
    ...(typeof m.description === 'string' ? { description: m.description } : {}),
    format,
    chain: [...(parent?.chain ?? []), m.name],
    device: /** @type {'armillary'|'none'} */ (m.device ?? parent?.device ?? (format === 1 ? 'armillary' : 'none')),
    tokens,
    escena: mergeEscena(parent?.escena ?? {}, /** @type {Escena} */ (escena)),
    css: (parent?.css ?? '') + (styles.length || !parent ? css : ''),
    dir: toSlash(dir),
  };
}
