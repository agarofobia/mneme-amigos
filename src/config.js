import fs from 'node:fs';
import path from 'node:path';
import { MnemeError } from './errors.js';
import { STATE_DIR } from './name.js';

/** @typedef {import('./types.js').Config} Config */

/** @type {Config} */
export const DEFAULTS = Object.freeze(/** @type {Config} */ ({
  version: 1,
  guardLevels: 2,
  // 'deny' (the guard stops a write that removes another session's section) or 'record' (it
  // goes through, recorded as authorized by the config). D-P11: the person decides.
  guard: 'deny',
  extensions: ['.md'],
  ignoreDirs: ['.git', STATE_DIR, 'node_modules', '.obsidian', '.trash'],
  ignorePaths: [],
  activeWindowMinutes: 30,
  activeWarnAt: 4,
  lockTimeoutMs: 5000,
  leaseMinutes: 10,
  wakeUpBudget: 0,
  embeddings: {
    provider: 'none',
    url: 'http://127.0.0.1:11434',
    model: 'bge-m3',
    timeoutMs: 3000,
    queryPrefix: '',
    documentPrefix: '',
    // provider "module": a file exporting createEmbedder(options, { root, config }) (§4.19)
    module: '',
    options: {},
  },
  // Off by default: the floor belongs to the corpus (BM25's scale depends on the vault), so each
  // root calibrates its own with its eval. See hitPasses in search.js.
  // `stale`: "follow" brings the current section with every superseded hit; "mark" only marks it.
  search: { k: 5, minLexical: 0, minLexicalRatio: 1, minCosine: 1, stale: 'follow' },
  // BM25's k1 and b, and the RRF constant of the hybrid reader (§4.19): the textbook values.
  ranking: { k1: 1.2, b: 0.75, rrfK: 60 },
  metadataAliases: { expires: [], superseded_by: [], pinned: [] },
}));

/** Keys whose content belongs to someone else (a plug-in's own options): passed through as given. */
const FREE_FORM = new Set(['embeddings.options']);

/**
 * Two readings of the same file (§4.3, changed 26/09 by Artu: «que una invalidez use su valor por
 * defecto»). `loadConfig` is STRICT: it throws CONFIG_INVALID naming the key, and is what validates a
 * config before it is written. `readConfig` is TOLERANT: a key it does not know is ignored and a value it
 * cannot use goes back to its default (always the safe side: the guard denies, search is lexical), and
 * each one comes back as a problem. Roots open with the tolerant one, so a typo no longer switches the
 * guard off in every session; the problems are loud instead (doctor fails, the CLI says it on stderr,
 * the hooks say it in every prompt until it is fixed). Silently ignoring was rejected: a typo would
 * stop applying and nobody would know.
 */

/**
 * The closest known key (edit distance at most a third of its length, and at least 1), for «did you mean».
 * @param {string} key
 * @param {string[]} known
 */
function closest(key, known) {
  /** @param {string} a @param {string} b */
  const distance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  let best = null, bestD = Math.max(1, Math.floor(key.length / 3)) + 1;
  for (const k of known) {
    const dk = distance(key.toLowerCase(), k.toLowerCase());
    if (dk < bestD) { best = k; bestD = dk; }
  }
  return best;
}

/**
 * @param {unknown} value
 * @param {unknown} model
 * @param {string} where
 * @param {string[]|null} problems  null: strict (throw); a list: tolerant (record and use the default)
 * @returns {unknown}
 */
function merge(value, model, where, problems) {
  /** @param {string} what */
  const bad = (what) => {
    if (!problems) throw new MnemeError('CONFIG_INVALID', `config.json: ${what}`);
    problems.push(`${what}: using the default (${JSON.stringify(model)})`);
    return structuredClone(model);
  };
  if (value === undefined) return structuredClone(model);
  if (FREE_FORM.has(where)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad(`"${where}" must be an object`);
    return structuredClone(value);
  }
  if (Array.isArray(model)) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return bad(`"${where}" must be a list of strings`);
    return [...value];
  }
  if (model !== null && typeof model === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad(`"${where}" must be an object`);
    /** @type {Record<string, unknown>} */
    const out = {};
    const given = /** @type {Record<string, unknown>} */ (value);
    const known = Object.keys(/** @type {object} */ (model));
    for (const key of Object.keys(given)) {
      if (known.includes(key)) continue;
      const near = closest(key, known);
      const what = `unknown key "${where ? `${where}.` : ''}${key}"${near ? ` (did you mean "${where ? `${where}.` : ''}${near}"?)` : ''}`;
      if (!problems) throw new MnemeError('CONFIG_INVALID', `config.json: ${what}`);
      problems.push(`${what}: ignored`);
    }
    for (const [key, sub] of Object.entries(/** @type {object} */ (model))) {
      out[key] = merge(given[key], sub, where ? `${where}.${key}` : key, problems);
    }
    return out;
  }
  if (typeof value !== typeof model) return bad(`"${where}" must be a ${typeof model}`);
  return value;
}

/**
 * The rules beyond the type: each names the key that goes back to its default when it fails (tolerant).
 * @type {Array<{ key: string, ok: (c: Config) => boolean, what: string }>}
 */
const RULES = [
  { key: 'version', ok: (c) => c.version === 1, what: '"version" must be 1' },
  // A wake-up budget smaller than its own header produced nothing and only a log line: the
  // session started without the bundle and nobody saw why. Refuse it where the mistake is made.
  { key: 'wakeUpBudget', ok: (c) => c.wakeUpBudget === 0 || (Number.isInteger(c.wakeUpBudget) && c.wakeUpBudget >= 1024), what: '"wakeUpBudget" must be 0 (off) or a whole number of at least 1024 bytes' },
  { key: 'search.minLexical', ok: (c) => Number.isFinite(c.search.minLexical) && c.search.minLexical >= 0, what: '"search.minLexical" must be a number of at least 0 (0 = off)' },
  { key: 'search.minLexicalRatio', ok: (c) => Number.isFinite(c.search.minLexicalRatio) && c.search.minLexicalRatio > 0 && c.search.minLexicalRatio <= 1, what: '"search.minLexicalRatio" must be more than 0 and at most 1' },
  { key: 'search.minCosine', ok: (c) => Number.isFinite(c.search.minCosine) && c.search.minCosine >= -1 && c.search.minCosine <= 1, what: '"search.minCosine" must be a number between -1 and 1' },
  { key: 'search.stale', ok: (c) => c.search.stale === 'follow' || c.search.stale === 'mark', what: '"search.stale" must be "follow" or "mark"' },
  { key: 'embeddings.provider', ok: (c) => ['none', 'ollama', 'module'].includes(c.embeddings.provider), what: '"embeddings.provider" must be "none", "ollama" or "module"' },
  // tolerant: without the file, the provider goes back to "none" (lexical search), not to a module that is not there
  { key: 'embeddings.provider', ok: (c) => c.embeddings.provider !== 'module' || (c.embeddings.module ?? '').trim() !== '', what: '"embeddings.module" must name the file that exports createEmbedder when the provider is "module"' },
  { key: 'guard', ok: (c) => c.guard === 'deny' || c.guard === 'record', what: '"guard" must be "deny" or "record"' },
  { key: 'ranking.k1', ok: (c) => Number.isFinite(c.ranking.k1) && c.ranking.k1 >= 0, what: '"ranking.k1" must be a number of at least 0' },
  { key: 'ranking.b', ok: (c) => Number.isFinite(c.ranking.b) && c.ranking.b >= 0 && c.ranking.b <= 1, what: '"ranking.b" must be a number between 0 and 1' },
  { key: 'ranking.rrfK', ok: (c) => Number.isFinite(c.ranking.rrfK) && c.ranking.rrfK > 0, what: '"ranking.rrfK" must be a number above 0' },
];

/**
 * @param {string} stateDir
 * @param {string[]|null} problems
 * @returns {Config}
 */
function read(stateDir, problems) {
  const file = path.join(stateDir, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return /** @type {Config} */ (merge(undefined, DEFAULTS, '', null));
    throw e;
  }
  let parsed;
  try {
    // a BOM (what PowerShell's Set-Content -Encoding utf8 writes) is not a mistake worth a broken root
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    const what = `config.json is not valid JSON: ${/** @type {Error} */ (e).message}`;
    if (!problems) throw new MnemeError('CONFIG_INVALID', what);
    problems.push(`${what}: using all the defaults`);
    return /** @type {Config} */ (merge(undefined, DEFAULTS, '', null));
  }
  const config = /** @type {Config} */ (merge(parsed, DEFAULTS, '', problems));
  for (const rule of RULES) {
    if (rule.ok(config)) continue;
    if (!problems) throw new MnemeError('CONFIG_INVALID', `config.json: ${rule.what}`);
    const parts = rule.key.split('.');
    const fallback = parts.reduce((/** @type {any} */ o, k) => o[k], DEFAULTS);
    /** @type {any} */ (parts.slice(0, -1).reduce((/** @type {any} */ o, k) => o[k], config))[parts.at(-1) ?? ''] = structuredClone(fallback);
    problems.push(`${rule.what}: using the default (${JSON.stringify(fallback)})`);
  }
  return config;
}

/**
 * STRICT: reads `<stateDir>/config.json` over the defaults and throws CONFIG_INVALID naming the key.
 * A missing file means all defaults. Validates a config before it is written.
 * @param {string} stateDir
 * @returns {Config}
 */
export function loadConfig(stateDir) {
  return read(stateDir, null);
}

/**
 * TOLERANT: the same reading, but what it cannot use goes back to its default and comes back as a
 * problem (one line each, without the «config.json:» prefix). Roots open with this.
 * @param {string} stateDir
 * @returns {{ config: Config, problems: string[] }}
 */
export function readConfig(stateDir) {
  /** @type {string[]} */
  const problems = [];
  return { config: read(stateDir, problems), problems };
}
