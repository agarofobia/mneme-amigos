// Acceptance, lote R (contracts §4.30, the usage report). Written by the main thread BEFORE the lote; the
// worker does not edit it (objections go in `objeciones_a_tests`). Everything goes through the CLI as a
// real process, each test with its own registry home, so nothing depends on how the module is named.
//   node --test test/aceptacion/r-reporte.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HOME_VAR, adoptedRoot, isolateHome, runCli } from './l3-helpers.mjs';
import { STATE_DIR } from '../../src/name.js';
import { writeNote } from '../../src/store.js';

isolateHome();
const FIELDS = ['degraded', 'hits', 'k', 'ms', 'reader', 'roots', 'session', 'ts', 'via'];
const TOP = ['denials', 'errors', 'generated', 'messages', 'mneme', 'notes', 'report', 'searches', 'sessions', 'setup', 'system', 'window', 'writes'];
const OFF = `${HOME_VAR.replace(/_HOME$/, '')}_USAGE_LOG`;

/** A registry home of its own, so counts never leak between tests. */
const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-r-'));
/** @param {string} home */
const logFile = (home) => path.join(home, 'usage', 'searches.jsonl');
/** @param {string} home */
const lines = (home) => (fs.existsSync(logFile(home)) ? fs.readFileSync(logFile(home), 'utf8').trim().split('\n').filter(Boolean) : []);
/** @param {string} home @param {string[]} args */
const cli = (home, args) => runCli(args, { env: { [HOME_VAR]: home } });

/** Reads the Read hook would have recorded for `session`, minutes ago. @param {string} dir @param {string} session @param {string[]} rels */
function reads(dir, session, rels) {
  const d = path.join(dir, STATE_DIR, 'run', 'reads');
  fs.mkdirSync(d, { recursive: true });
  fs.appendFileSync(path.join(d, `${session}.jsonl`), rels.map((rel, i) => JSON.stringify({ rel, sha: 'x', ts: new Date(Date.now() - (i + 1) * 60e3).toISOString() })).join('\n') + '\n');
}

test('a CLI search leaves one line: numbers and words from a closed set, nothing of the query', async () => {
  const home = freshHome();
  const root = await adoptedRoot();
  const r = await cli(home, ['search', 'rollback', '--root', root.dir]);
  assert.equal(r.code, 0, r.stderr);
  const got = lines(home);
  assert.equal(got.length, 1);
  assert.ok(!got[0].includes('rollback'), 'the query text is never written');
  const x = JSON.parse(got[0]);
  assert.deepEqual(Object.keys(x).sort(), FIELDS);
  assert.equal(x.via, 'cli');
  assert.ok(['hybrid', 'lexical', 'session'].includes(x.reader));
  assert.ok(Number.isInteger(x.hits) && x.hits > 0);
  assert.equal(x.session, false);
  assert.equal(typeof x.degraded, 'boolean');
  assert.ok(typeof x.ms === 'number' && x.ms >= 0);
  assert.equal(x.roots, 1);
});

test('an empty search is 0 hits; one the session reader answered says so', async () => {
  const home = freshHome();
  const root = await adoptedRoot();
  await cli(home, ['search', 'zzqqxx wwvvyy', '--root', root.dir]);
  reads(root.dir, 'ses-r', ['manuals/backups.md', 'projects/beta.md']);
  const cont = await cli(home, ['search', 'sí, continúa', '--root', root.dir, '--session', 'ses-r']);
  assert.equal(cont.code, 0, cont.stderr);
  const [vacia, sesion] = lines(home).map((l) => JSON.parse(l));
  assert.equal(vacia.hits, 0);
  assert.equal(vacia.session, false);
  assert.ok(sesion.hits > 0);
  assert.equal(sesion.session, true);
});

test('the off switch records nothing, and the search answers the same', async () => {
  const on = freshHome();
  const off = freshHome();
  const root = await adoptedRoot();
  const a = await cli(on, ['search', 'rollback', '--root', root.dir]);
  const b = await runCli(['search', 'rollback', '--root', root.dir], { env: { [HOME_VAR]: off, [OFF]: '0' } });
  assert.equal(b.code, 0, b.stderr);
  assert.equal(lines(off).length, 0);
  assert.equal(b.stdout, a.stdout);
});

test('report: only JSON, the fixed shape, and it counts what happened', async () => {
  const home = freshHome();
  const root = await adoptedRoot();
  await cli(home, ['search', 'rollback', '--root', root.dir]);
  await cli(home, ['search', 'zzqqxx wwvvyy', '--root', root.dir]);
  const alpha = fs.readFileSync(path.join(root.dir, 'projects/alpha.md'), 'utf8') + '\nOne more line.\n';
  assert.equal((await writeNote(root, 'projects/alpha.md', alpha, { author: { session: 'ses-w', agent: 'claude-code' }, reason: 'test' })).ok, true);
  const r = await cli(home, ['report', '--root', root.dir]);
  assert.equal(r.code, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(rep).sort(), TOP);
  assert.equal(rep.report, 1);
  assert.match(rep.generated, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(rep.window.days, 30);
  assert.equal(rep.system.platform, process.platform);
  assert.equal(rep.searches.total, 2);
  assert.equal(rep.searches.empty, 1);
  assert.equal(rep.searches.byVia.cli, 2);
  assert.equal(rep.writes.total, 1, 'the adoption is not a write');
  assert.equal(rep.writes.byAgent['claude-code'], 1);
  assert.ok(rep.notes.notes > 0 && rep.notes.sections >= rep.notes.notes);
  assert.ok(rep.sessions.total >= 1);
});

test('privacy: what was planted in names, text, the query, the session and the path appears nowhere', async () => {
  const home = freshHome();
  const root = await adoptedRoot();
  const author = { session: 'ses-QZXSES', agent: /** @type {'claude-code'} */ ('claude-code') };
  assert.equal((await writeNote(root, 'privado/QZXNOTA.md', '# QZXTITULO\n\nQZXCUERPO lives here.\n', { author, reason: 'test' })).ok, true);
  reads(root.dir, 'ses-QZXSES', ['privado/QZXNOTA.md']);
  await cli(home, ['search', 'QZXTITULO QZXCUERPO', '--root', root.dir]);
  await cli(home, ['search', 'sí, continúa', '--root', root.dir, '--session', 'ses-QZXSES']);
  const r = await cli(home, ['report', '--root', root.dir]);
  assert.equal(r.code, 0, r.stderr);
  const everything = r.stdout + fs.readFileSync(logFile(home), 'utf8');
  const planted = ['QZXNOTA', 'QZXTITULO', 'QZXCUERPO', 'QZXSES', 'privado', root.dir, root.dir.replace(/\\/g, '/'), path.basename(root.dir), os.hostname(), os.userInfo().username];
  for (const p of planted) assert.ok(!everything.includes(p), `leaked: ${p}`);
});

test('--days is the window: an older search is left out', async () => {
  const home = freshHome();
  const root = await adoptedRoot();
  fs.mkdirSync(path.dirname(logFile(home)), { recursive: true });
  const old = { ts: new Date(Date.now() - 40 * 86400e3).toISOString(), via: 'cli', reader: 'lexical', k: 5, hits: 3, session: false, degraded: false, ms: 12, roots: 1 };
  fs.writeFileSync(logFile(home), `${JSON.stringify(old)}\n`);
  await cli(home, ['search', 'rollback', '--root', root.dir]);
  const d30 = JSON.parse((await cli(home, ['report', '--root', root.dir])).stdout);
  const d60 = JSON.parse((await cli(home, ['report', '--root', root.dir, '--days', '60'])).stdout);
  assert.equal(d30.searches.total, 1);
  assert.equal(d60.searches.total, 2);
  assert.equal(d60.window.days, 60);
});
