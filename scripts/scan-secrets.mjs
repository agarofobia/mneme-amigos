/**
 * Secret scanner: nothing that looks like a credential leaves this machine.
 *
 *   node scripts/scan-secrets.mjs --staged       pre-commit: only what goes into the commit
 *   node scripts/scan-secrets.mjs --tree         CI: every tracked file
 *   node scripts/scan-secrets.mjs --path <dir>   a loose directory, no git needed
 *
 * One owner for the patterns: the pre-commit hook and CI both call THIS file, so a new
 * pattern added here applies on both sides.
 *
 * Explicit escape: a line containing `allow-secret` is not reported. It is a marker on
 * purpose, visible in the diff.
 *
 * Test fixtures for this scanner must not live in the repo: a committed fake key would
 * fail everyone's pre-commit. Tests build them in a temporary directory.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @type {Array<[RegExp, string]>} */
export const PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, 'API key (sk-…)'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, 'GitHub token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/AIza[A-Za-z0-9_-]{30,}/, 'Google API key'],
  [/eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
  [/postgres(?:ql)?:\/\/[^:\s"']+:[^@\s"']{8,}@/, 'Postgres URL with password'],
  [/mongodb(?:\+srv)?:\/\/[^:\s"']+:[^@\s"']{8,}@/, 'Mongo URL with password'],
  [/sk_(?:live|test)_[A-Za-z0-9]{20,}/, 'secret key (sk_live_/sk_test_)'],
  [/sb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}|sbp_[A-Za-z0-9]{20,}/, 'Supabase key'],
  [/(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+]{24,}["']/i, 'secret assigned in clear'],
];

// Files that must never be committed, whatever they contain.
const FORBIDDEN_PATH = /(^|\/)\.env(\.|$)(?!example)/;
// Where a pattern is a legitimate mention: this scanner and lockfiles.
const EXEMPT_PATH = /scan-secrets\.mjs$|package-lock\.json$/;
// With --path there is no .gitignore to honor: skip third-party folders.
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

/** @param {string} dir */
function listDirectory(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (SKIPPED_DIRS.has(name)) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out;
}

/**
 * Scans a list of files. `read(f)` returns the content or throws (binary, deleted).
 * @param {string[]} files
 * @param {(f: string) => string} read
 * @returns {string[]} one line per finding
 */
export function scan(files, read) {
  /** @type {string[]} */
  const findings = [];
  for (const f of files) {
    if (FORBIDDEN_PATH.test(f)) {
      findings.push(`${f}: a .env file is never committed (missing from .gitignore?)`);
      continue;
    }
    if (EXEMPT_PATH.test(f)) continue;
    let content;
    try {
      content = read(f);
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('allow-secret')) continue;
      const hit = PATTERNS.find(([re]) => re.test(line));
      if (hit) findings.push(`${f}:${i + 1}: ${hit[1]}`);
    }
  }
  return findings;
}

/** @param {string[]} argv */
function main(argv) {
  const iPath = argv.indexOf('--path');
  /** @type {string} */ let mode;
  /** @type {string[]} */ let files;
  /** @type {(f: string) => string} */ let read;
  if (iPath !== -1) {
    const dir = argv[iPath + 1];
    if (!dir) {
      console.error('--path needs a directory');
      return 2;
    }
    mode = `path ${dir}`;
    files = listDirectory(dir);
    read = (f) => readFileSync(join(dir, f), 'utf8');
  } else if (argv.includes('--staged')) {
    mode = 'staged';
    files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
    // Arguments, not a shell string: a file name with quotes cannot inject anything.
    read = (f) => execFileSync('git', ['show', `:${f}`], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } else {
    mode = 'tree';
    files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    read = (f) => readFileSync(f, 'utf8');
  }

  const findings = scan(files, read);
  if (findings.length) {
    for (const h of findings) console.error(`x ${h}`);
    console.error(`\n${findings.length} possible secret(s) in ${mode}. Blocked.`);
    console.error('If it is a REAL false positive, mark the line with: allow-secret');
    return 1;
  }
  console.log(`ok: no secrets in ${mode} (${files.length} files)`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
