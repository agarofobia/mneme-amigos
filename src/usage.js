// Usage, recorded locally, and the report a person copies and sends back. Two parts:
//
//   <home>/usage/searches.jsonl   one line per search that came in through the CLI or the MCP
//                                 server (never the eval, never a search another module runs):
//                                 numbers and words from a closed set. Never the query (not even
//                                 a hash: a short query is recovered with a dictionary), a path,
//                                 a section, a session id, the user or the machine. Rotated at
//                                 1 MB to searches.1.jsonl (one older file is kept).
//                                 `<NAME>_USAGE_LOG=0` turns it off.
//   buildReport(roots, …)          a fixed-shape JSON of counts over a window of days: that log,
//                                 plus what each root already records (the ledger, denials,
//                                 reads, presence, messages, errors) and the size of its index.
//
// The report is built by code, not summarized by a model: a model could let a note's name slip
// through, this cannot, and a test plants names and looks for them. Every string in it is a
// date without a time, a fixed key, or a value checked against a closed set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFileName } from './leases.js';
import { readLedger } from './ledger.js';
import { NAME } from './name.js';
import { INDEX_VERSION, MAX_NOTE_BYTES } from './readers/index.js';
import { sectionDocs } from './readers/lexical.js';
import { homeDir, recordHomeError } from './registry.js';
import { listNotes } from './root.js';
import { defaultReader } from './search.js';
import { readDenials, readMessages } from './sessions.js';

/** @typedef {import('./types.js').Root} Root */
/** @typedef {import('./search.js').SearchOptions} SearchOptions */
/** @typedef {import('./search.js').SearchResult} SearchResult */

/** The variable that turns the search log off when it is 0: `<NAME>_USAGE_LOG`. */
export const USAGE_ENV = `${NAME.toUpperCase()}_USAGE_LOG`;
/** The search log is rotated when it reaches this size. */
export const MAX_LOG_BYTES = 1024 * 1024;
/** The window of `report` when none is given. */
export const DEFAULT_DAYS = 30;
/** Version of the report's shape: reports of the same version add up field by field. */
export const REPORT_VERSION = 1;

const DAY_MS = 86_400_000;

// The closed sets. A value outside them never reaches a report.
const VIAS = /** @type {const} */ (['cli', 'mcp']);
const READERS = /** @type {const} */ (['hybrid', 'lexical', 'session']);
const WRITE_AGENTS = /** @type {const} */ (['claude-code', 'mcp', 'cli', 'external']);
const WRITE_OPS = /** @type {const} */ (['write', 'edit', 'move', 'restore', 'external', 'delete']);
const PROVIDERS = /** @type {const} */ (['ollama', 'module', 'none']);
const HIT_BUCKETS = /** @type {const} */ (['0', '1-2', '3-5', '6+']);
/** The fields of a search line, in the order they are written. A line with any other set is skipped. */
const FIELDS = ['ts', 'via', 'reader', 'k', 'hits', 'session', 'degraded', 'ms', 'roots'];

/**
 * One line of searches.jsonl: exactly these fields.
 * @typedef {Object} SearchRecord
 * @property {string} ts           ISO
 * @property {'cli'|'mcp'} via     the door it came in through
 * @property {'hybrid'|'lexical'|'session'} reader  the reader asked for (or the default)
 * @property {number} k            hits asked for
 * @property {number} hits         hits returned
 * @property {boolean} session     the session reader answered (nothing matched, or it was asked for)
 * @property {boolean} degraded    the hybrid reader fell back to lexical
 * @property {number} ms           how long the search took, whole milliseconds
 * @property {number} roots        how many roots it searched
 */

/**
 * The report `report` prints: `UsageReportBody` plus `{ [NAME]: { version } }`. Only numbers,
 * dates without a time and values of a closed set.
 * @typedef {UsageReportBody & Record<typeof NAME, { version: string }>} UsageReport
 */

/**
 * @typedef {Object} UsageReportBody
 * @property {1} report
 * @property {string} generated  YYYY-MM-DD, local
 * @property {{ days: number, from: string, to: string, activeDays: number }} window
 *   `activeDays`: local days with a search, a write, a read, a denial, a message or a session seen
 * @property {{ platform: string, node: string }} system
 * @property {{ roots: number, embeddings: 'ollama'|'module'|'none', hookInstalls: number }} setup
 * @property {{ notes: number, sections: number, bytes: number }} notes
 * @property {{ total: number, byAgent: Record<string, number>, byOp: Record<string, number> }} writes  adoptions are not writes
 * @property {{ total: number }} denials
 * @property {{ total: number, withReads: number, reads: number }} sessions
 * @property {{ sent: number }} messages
 * @property {{ total: number, empty: number, answeredBySession: number, byVia: Record<string, number>,
 *   byReader: Record<string, number>, hits: Record<string, number>, degraded: number,
 *   ms: { p50: number|null, p90: number|null } }} searches  every search this home recorded, whatever its roots
 * @property {number} errors  lines of errors.jsonl (the home's and each root's) in the window
 */

// ── the search log ──────────────────────────────────────────────────────────

/** `<home>/usage` */
export const usageDir = () => path.join(homeDir(), 'usage');
/** `<home>/usage/searches.jsonl`, the current search log. */
export const searchesFile = () => path.join(usageDir(), 'searches.jsonl');
/** `<home>/usage/searches.1.jsonl`, the one rotated out before it. */
export const olderSearchesFile = () => path.join(usageDir(), 'searches.1.jsonl');

/**
 * Whether searches are recorded: yes, unless `<NAME>_USAGE_LOG` is 0 (or false, off, no).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function usageLogOn(env = process.env) {
  const value = env[USAGE_ENV];
  return value === undefined || !/^\s*(?:0|false|off|no)\s*$/i.test(value);
}

/**
 * The line one search leaves. Nothing of the query, the roots or the hits goes in but counts.
 * @param {'cli'|'mcp'} via
 * @param {Root[]} roots        as given to search()
 * @param {SearchOptions} options  as given to search()
 * @param {SearchResult} result
 * @param {number} ms
 * @param {Date} [now]
 * @returns {SearchRecord}
 */
export function searchRecord(via, roots, options, result, ms, now = new Date()) {
  // search() drops a root given twice; so does the count.
  const unique = [...new Map(roots.map((r) => [r.dir, r])).values()];
  return {
    ts: now.toISOString(),
    via,
    reader: options.reader ?? defaultReader(unique, options.embedder),
    k: options.k ?? unique[0].config.search.k,
    hits: result.hits.length,
    session: result.hits.some((h) => h.via === 'session'),
    degraded: typeof result.degraded === 'string',
    ms: Math.max(0, Math.round(ms)),
    roots: unique.length,
  };
}

/**
 * Records one search that came in through a door. Never throws and never writes to stdout:
 * a failure goes to the home's errors.jsonl and the search answers exactly as it would have.
 * @param {'cli'|'mcp'} via
 * @param {Root[]} roots
 * @param {SearchOptions} options
 * @param {SearchResult} result
 * @param {number} ms  measured by the door, around search() only
 * @returns {boolean} whether a line was written
 */
export function recordSearch(via, roots, options, result, ms) {
  if (!usageLogOn()) return false;
  try {
    appendSearch(searchRecord(via, roots, options, result, ms));
    return true;
  } catch (e) {
    recordHomeError(`usage ${via}`, `a search was not recorded in the usage log: ${/** @type {Error} */ (e)?.message ?? String(e)}`);
    return false;
  }
}

/**
 * Appends a line to the search log, rotating it first when it reached MAX_LOG_BYTES.
 * @param {SearchRecord} record
 */
function appendSearch(record) {
  const file = searchesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = sizeOf(file);
  if (size >= MAX_LOG_BYTES) {
    try {
      fs.renameSync(file, olderSearchesFile()); // replaces the older one: one is kept
      size = 0;
    } catch (e) {
      // ENOENT: another process rotated it a moment ago. Anything else (a lock on Windows):
      // said, and this line still goes in; the log grows past the limit until the next try.
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') size = 0;
      else recordHomeError('usage rotate', `the usage log was not rotated: ${/** @type {Error} */ (e).message}`);
    }
  }
  // A line cut short by a crash is closed first, so it is not glued to this one.
  const prefix = size > 0 && !endsInNewline(file, size) ? '\n' : '';
  fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * @param {string} file
 * @returns {number} 0 when it does not exist
 */
function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return 0;
    throw e;
  }
}

/**
 * @param {string} file
 * @param {number} size
 */
function endsInNewline(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {unknown} v
 * @param {number} min
 */
const isCount = (v, min) => typeof v === 'number' && Number.isInteger(v) && v >= min;

/**
 * Whether `x` is exactly a search line: the nine fields, no other, each of its type and set.
 * @param {unknown} x
 * @returns {x is SearchRecord}
 */
export function isSearchRecord(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const r = /** @type {Record<string, unknown>} */ (x);
  const keys = Object.keys(r);
  if (keys.length !== FIELDS.length || !FIELDS.every((f) => keys.includes(f))) return false;
  return (
    typeof r.ts === 'string' &&
    !Number.isNaN(Date.parse(r.ts)) &&
    typeof r.via === 'string' &&
    /** @type {readonly string[]} */ (VIAS).includes(r.via) &&
    typeof r.reader === 'string' &&
    /** @type {readonly string[]} */ (READERS).includes(r.reader) &&
    isCount(r.k, 1) &&
    isCount(r.hits, 0) &&
    typeof r.session === 'boolean' &&
    typeof r.degraded === 'boolean' &&
    typeof r.ms === 'number' &&
    Number.isFinite(r.ms) &&
    r.ms >= 0 &&
    isCount(r.roots, 1)
  );
}

/**
 * The parsed lines of a JSONL file, [] when it does not exist (or a file stands where one of
 * its folders should be: then it cannot exist either). A line that is not JSON is counted in
 * `torn` and skipped: these files are appended by parallel processes, and a crash can leave
 * half a line.
 * @param {string} file
 * @returns {{ values: unknown[], torn: number }}
 */
function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { values: [], torn: 0 };
    throw e;
  }
  /** @type {unknown[]} */
  const values = [];
  let torn = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      torn++; // see the doc comment: counted by the caller that cares, never fatal
    }
  }
  return { values, torn };
}

/**
 * The recorded searches from `since` to `until` (epoch ms, both included), oldest first: the
 * rotated file, then the current one. A line that is not exactly a search record (cut short,
 * a field more or less, a value outside its set) is skipped and counted in `skipped`.
 * @param {{ since?: number, until?: number }} [window]
 * @returns {{ searches: SearchRecord[], skipped: number }}
 */
export function readSearches({ since = -Infinity, until = Infinity } = {}) {
  /** @type {SearchRecord[]} */
  const searches = [];
  let skipped = 0;
  for (const file of [olderSearchesFile(), searchesFile()]) {
    const { values, torn } = readJsonl(file);
    skipped += torn;
    for (const x of values) {
      if (!isSearchRecord(x)) {
        skipped++;
        continue;
      }
      const t = Date.parse(x.ts);
      if (t >= since && t <= until) searches.push(x);
    }
  }
  return { searches, skipped };
}

// ── the report ──────────────────────────────────────────────────────────────

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The local calendar day of a time, YYYY-MM-DD: the person's days, not UTC's (a session at
 * 22:00 in UTC-3 belongs to that day, not the next).
 * @param {number} t epoch ms
 */
function localDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * `keys` with 0 each: every key of a closed set is always in the report, so reports add up.
 * @param {readonly string[]} keys
 * @returns {Record<string, number>}
 */
const zeros = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

/**
 * Nearest-rank percentile of sorted numbers; null when there are none.
 * @param {number[]} sorted
 * @param {number} q  0..1
 */
function percentile(sorted, q) {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]);
}

/** @param {number} hits */
const hitBucket = (hits) => (hits === 0 ? '0' : hits <= 2 ? '1-2' : hits <= 5 ? '3-5' : '6+');

/**
 * The version in the package.json of this checkout, when it looks like a version.
 * @returns {string}
 */
function ownVersion() {
  const file = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = /** @type {unknown} */ (JSON.parse(fs.readFileSync(file, 'utf8')));
  const version = pkg && typeof pkg === 'object' ? /** @type {{ version?: unknown }} */ (pkg).version : undefined;
  // Checked, since the report carries it as is: anything that is not a version is not said.
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$/.test(version) ? version : 'unknown';
}

/**
 * What the lexical index of `root` knows of each note: size, mtime and how many sections it
 * indexed. The file and its format belong to src/readers/index.js (`refreshIndex`); this only
 * reads it, so a report never re-reads every note. Missing, unreadable or of another version:
 * empty, and every note is then read below, as search would rebuild it.
 * @param {Root} root
 * @returns {Map<string, { size: number, mtimeMs: number, sections: number }>}
 */
function indexedNotes(root) {
  /** @type {Map<string, { size: number, mtimeMs: number, sections: number }>} */
  const out = new Map();
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(fs.readFileSync(path.join(root.stateDir, 'index', 'lexical.json'), 'utf8'));
  } catch {
    return out; // a cache, never a source: without it the notes themselves are read
  }
  const index = /** @type {{ v?: unknown, notes?: unknown } | null} */ (json && typeof json === 'object' ? json : null);
  const notes = index && index.v === INDEX_VERSION ? index.notes : null;
  if (!notes || typeof notes !== 'object') return out;
  for (const [rel, e] of Object.entries(/** @type {Record<string, unknown>} */ (notes))) {
    const entry = /** @type {{ size?: unknown, mtimeMs?: unknown, sections?: unknown } | null} */ (e);
    if (entry && typeof entry.size === 'number' && typeof entry.mtimeMs === 'number' && Array.isArray(entry.sections)) {
      out.set(rel, { size: entry.size, mtimeMs: entry.mtimeMs, sections: entry.sections.length });
    }
  }
  return out;
}

/**
 * Notes, searchable sections and bytes of a root. A note the index already has at the same
 * size and mtime is not read; only the new or changed ones are.
 * @param {Root} root
 */
function noteCounts(root) {
  const index = indexedNotes(root);
  let notes = 0;
  let sections = 0;
  let bytes = 0;
  for (const rel of listNotes(root)) {
    const abs = path.join(root.dir, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // deleted since the listing, or not readable: search leaves it out too
    }
    notes++;
    bytes += stat.size;
    const known = index.get(rel);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) sections += known.sections;
    else if (stat.size <= MAX_NOTE_BYTES) {
      try {
        sections += sectionDocs(fs.readFileSync(abs, 'utf8')).length;
      } catch {
        // unreadable now: it counts as a note with no searchable section, as the index would
      }
    }
  }
  return { notes, sections, bytes };
}

/**
 * The files of a directory with an extension, [] when it does not exist.
 * @param {string} dir
 * @param {string} ext
 */
function filesIn(dir, ext) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(ext));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * The usage report over `roots` for the last `days` days (default 30). Reads the ledger, the
 * run state and the index of each root, and the search log of this home; writes nothing.
 * @param {Root[]} roots
 * @param {{ days?: number, now?: Date, hookInstalls?: number }} [options]
 *   `hookInstalls`: settings files this home installed the hooks into (the caller knows them)
 * @returns {UsageReport}
 */
export function buildReport(roots, { days = DEFAULT_DAYS, now = new Date(), hookInstalls = 0 } = {}) {
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('a report needs at least one root');
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`days must be a positive whole number (got ${days})`);
  const list = [...new Map(roots.map((r) => [r.dir, r])).values()];
  const until = now.getTime();
  const since = until - days * DAY_MS;
  /** @type {Set<string>} */
  const active = new Set();
  /**
   * Whether an ISO time is inside the window; when it is, its day is an active one.
   * @param {unknown} ts
   */
  const counts = (ts) => {
    const t = timeIn(ts, since, until);
    if (t === null) return false;
    active.add(localDay(t));
    return true;
  };

  const notes = { notes: 0, sections: 0, bytes: 0 };
  const writes = { total: 0, byAgent: zeros([...WRITE_AGENTS, 'other']), byOp: zeros(WRITE_OPS) };
  let denials = 0;
  let reads = 0;
  let sent = 0;
  let errors = 0;
  // Sessions by the name their files have (safeFileName), so the same session is one in every source.
  /** @type {Set<string>} */
  const sessions = new Set();
  /** @type {Set<string>} */
  const withReads = new Set();

  for (const root of list) {
    const n = noteCounts(root);
    notes.notes += n.notes;
    notes.sections += n.sections;
    notes.bytes += n.bytes;

    for (const e of readLedger(root).entries) {
      if (e.op === 'adopt' || !counts(e.ts)) continue; // an adoption is not a write
      writes.total++;
      writes.byOp[e.op]++; // readLedger keeps only entries whose op is one of the ledger's
      const agent = /** @type {readonly string[]} */ (WRITE_AGENTS).includes(e.author.agent) ? e.author.agent : 'other';
      writes.byAgent[agent]++;
      if (e.author.agent !== 'external' && e.author.session !== 'external') sessions.add(safeFileName(e.author.session));
    }

    for (const d of readDenials(root)) {
      if (!counts(d.ts)) continue;
      denials++;
      sessions.add(safeFileName(d.session));
    }

    const readsDir = path.join(root.stateDir, 'run', 'reads');
    for (const name of filesIn(readsDir, '.jsonl')) {
      const id = name.slice(0, -'.jsonl'.length);
      for (const x of readJsonl(path.join(readsDir, name)).values) {
        if (!counts(tsOf(x))) continue;
        reads++;
        withReads.add(id);
        sessions.add(id);
      }
    }

    const presenceDir = path.join(root.stateDir, 'run', 'sessions');
    for (const name of filesIn(presenceDir, '.json')) {
      /** @type {unknown} */
      let presence;
      try {
        presence = JSON.parse(fs.readFileSync(path.join(presenceDir, name), 'utf8'));
      } catch {
        continue; // torn by a crash or gone since the listing: ephemeral, and the session shows elsewhere if it did anything
      }
      if (counts(tsOf(presence, 'lastSeen'))) sessions.add(name.slice(0, -'.json'.length));
    }

    for (const m of readMessages(root)) {
      if (!counts(m.ts)) continue;
      sent++;
      sessions.add(safeFileName(m.from.session));
    }

    // Errors do not make a day active: a day of failed hooks is not a day of use.
    for (const x of readJsonl(path.join(root.stateDir, 'run', 'errors.jsonl')).values) if (timeIn(tsOf(x), since, until) !== null) errors++;
  }
  for (const x of readJsonl(path.join(homeDir(), 'errors.jsonl')).values) if (timeIn(tsOf(x), since, until) !== null) errors++;

  const { searches } = readSearches({ since, until });
  const searchCounts = {
    total: searches.length,
    empty: 0,
    answeredBySession: 0,
    byVia: zeros(VIAS),
    byReader: zeros(READERS),
    hits: zeros(HIT_BUCKETS),
    degraded: 0,
    ms: { p50: /** @type {number|null} */ (null), p90: /** @type {number|null} */ (null) },
  };
  for (const s of searches) {
    active.add(localDay(Date.parse(s.ts)));
    if (s.hits === 0) searchCounts.empty++;
    if (s.session) searchCounts.answeredBySession++;
    if (s.degraded) searchCounts.degraded++;
    searchCounts.byVia[s.via]++;
    searchCounts.byReader[s.reader]++;
    searchCounts.hits[hitBucket(s.hits)]++;
  }
  const ms = searches.map((s) => s.ms).sort((a, b) => a - b);
  searchCounts.ms = { p50: percentile(ms, 0.5), p90: percentile(ms, 0.9) };

  // One value for every root: the most capable provider any of them uses.
  const provider = PROVIDERS.find((p) => list.some((r) => r.config.embeddings.provider === p)) ?? 'none';

  return {
    report: REPORT_VERSION,
    generated: localDay(until),
    window: { days, from: localDay(since), to: localDay(until), activeDays: active.size },
    [NAME]: { version: ownVersion() },
    system: { platform: process.platform, node: process.versions.node },
    setup: { roots: list.length, embeddings: provider, hookInstalls },
    notes,
    writes,
    denials: { total: denials },
    sessions: { total: sessions.size, withReads: withReads.size, reads },
    messages: { sent },
    searches: searchCounts,
    errors,
  };
}

/**
 * The epoch ms of an ISO time inside [since, until], else null (outside, or not a time).
 * @param {unknown} ts
 * @param {number} since
 * @param {number} until
 * @returns {number|null}
 */
function timeIn(ts, since, until) {
  const t = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
  return t >= since && t <= until ? t : null;
}

/**
 * A time field of a parsed JSON line (`ts` unless said), or undefined when it has none.
 * @param {unknown} x
 * @param {string} [field]
 */
function tsOf(x, field = 'ts') {
  return x !== null && typeof x === 'object' ? /** @type {Record<string, unknown>} */ (x)[field] : undefined;
}
