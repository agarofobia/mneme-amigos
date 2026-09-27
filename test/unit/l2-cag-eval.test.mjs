import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runEval } from '../../src/eval.js';
import { STATE_DIR } from '../../src/name.js';
import { bundle } from '../../src/readers/cag.js';
import { MAX_NOTE_BYTES } from '../../src/readers/index.js';
import { openRoot } from '../../src/root.js';
import { snapshot } from '../helpers/fixture.mjs';

/** @typedef {import('../../src/types.js').Embedder} Embedder */

const NOW = new Date('2026-09-24T12:00:00Z');

/**
 * A governed root in a temporary directory, with invented notes.
 * @param {Record<string, string>} files
 * @param {object} [config]
 */
function tempRoot(files, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-l2-'));
  fs.mkdirSync(path.join(dir, STATE_DIR));
  if (config) fs.writeFileSync(path.join(dir, STATE_DIR, 'config.json'), JSON.stringify(config));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return openRoot(dir);
}

/** @param {string} text */
const bytes = (text) => Buffer.byteLength(text, 'utf8');

const NOTES = {
  'a/café.md': '---\npinned: true\n---\n# Café ☕\n\nOrígenes y tostado: ñandú, 東京, 🚲.\n',
  'a/expires-today.md': '---\nexpires: 2026-09-24\n---\n# Today only\n\nValid through today.\n',
  'b/intro-only.md': '\n\n  A note without headings, about the backlog.  \n\nSecond line.\n',
  'b/long-title.md': `# ${'Very long heading '.repeat(10)}\n\ntext\n`,
  'c/mixed.md': '# Mixed\n\n## Keep\n\nstill true\n\n## Drop\n<!-- superseded-by: [[c/new]] -->\n\nold\n',
  'c/new.md': '# New\n\nthe replacement\n',
};

test('CAG: exact layout when everything fits', () => {
  const root = tempRoot(NOTES);
  const text = bundle(root, { budget: 100000, now: NOW });
  const lines = text.split('\n');
  assert.equal(lines[0], '==> a/café.md <==');
  assert.ok(text.includes('# Café ☕\n\nOrígenes y tostado'), 'pinned notes go in full');
  assert.ok(text.includes('\n- a/café.md — Café ☕\n'));
  assert.ok(text.includes('\n- a/expires-today.md — Today only\n'), 'expires today: not stale yet');
  assert.ok(text.includes('\n- b/intro-only.md — A note without headings, about the backlog.\n'), 'first line when there is no heading');
  const longLine = lines.find((l) => l.startsWith('- b/long-title.md — '));
  assert.ok(longLine);
  const description = longLine.slice('- b/long-title.md — '.length);
  assert.equal(description.length, 100);
  assert.ok(description.endsWith('…'));
  assert.ok(text.includes('\n- c/mixed.md — Mixed [STALE section "Drop": superseded by [[c/new]]]\n'));
  assert.ok(!text.includes('notes omitted'));
  assert.ok(text.indexOf('==> a/café.md <==') < text.indexOf('\n- a/'), 'pinned first');
  const order = lines.filter((l) => l.startsWith('- ')).map((l) => l.split(' ')[1]);
  assert.deepEqual(order, [...order].sort(), 'the index is in path order');
});

test('CAG: the day after, what expired today is marked; the time of day never matters', () => {
  const root = tempRoot(NOTES);
  const today = bundle(root, { budget: 100000, now: NOW });
  assert.equal(bundle(root, { budget: 100000, now: new Date('2026-09-24T00:00:00Z') }), today);
  const tomorrow = bundle(root, { budget: 100000, now: new Date('2026-09-25T00:00:01Z') });
  assert.ok(tomorrow.includes('- a/expires-today.md — Today only [STALE: expired 2026-09-24]\n'));
});

test('CAG: never over budget, for every budget from the minimum to the full size (UTF-8 bytes)', () => {
  const root = tempRoot(NOTES);
  const full = bundle(root, { budget: 100000, now: NOW });
  const size = bytes(full);
  assert.equal(bundle(root, { budget: size, now: NOW }), full, 'an exact budget changes nothing');
  let smallest = 0;
  for (let budget = size - 1; budget > 0; budget--) {
    let out;
    try {
      out = bundle(root, { budget, now: NOW });
    } catch (e) {
      assert.ok(e instanceof RangeError);
      assert.match(/** @type {Error} */ (e).message, /too small/);
      smallest = budget + 1;
      break;
    }
    assert.ok(bytes(out) <= budget, `budget ${budget}: ${bytes(out)} bytes`);
    assert.ok(/(notes omitted \(budget \d+ bytes\)\n|\[pinned: full text over budget\]\n)$/.test(out) || out.includes('[pinned: full text over budget]'), `budget ${budget} says what it cut`);
  }
  assert.ok(smallest > 0 && smallest < 60, `the smallest budget is only the footer (${smallest})`);
});

test('CAG: a pinned note larger than the budget goes in the index, marked', () => {
  const root = tempRoot({ ...NOTES, 'z/big-pinned.md': `---\npinned: true\n---\n# Big\n\n${'word '.repeat(400)}\n` });
  const text = bundle(root, { budget: 1500, now: NOW });
  assert.ok(bytes(text) <= 1500);
  assert.ok(!text.includes('==> z/big-pinned.md <=='));
  assert.ok(text.includes('- z/big-pinned.md — Big [pinned: full text over budget]\n'));
  assert.ok(text.includes('==> a/café.md <=='), 'a smaller pinned note still fits');
});

test('CAG: aliases, huge notes, bad budgets, and no writes', () => {
  const root = tempRoot(
    { ...NOTES, 'd/kept.md': '---\nkeep: yes\n---\n# Kept\n\nalias-pinned body\n' },
    { metadataAliases: { pinned: ['keep'] } },
  );
  fs.writeFileSync(path.join(root.dir, 'd/huge.md'), `# Huge\n${'x'.repeat(MAX_NOTE_BYTES)}`);
  const before = snapshot(root.dir);
  const text = bundle(root, { budget: 100000, now: NOW });
  assert.ok(text.includes('==> d/kept.md <==\n'), 'pinned through an alias');
  assert.ok(text.includes('- d/huge.md [skipped: larger than 2 MB]\n'));
  for (const budget of [0, -5, 1.5, Number.NaN]) assert.throws(() => bundle(root, { budget, now: NOW }), RangeError);
  assert.deepEqual(snapshot(root.dir), before, 'the bundle writes nothing');
  assert.ok(!fs.existsSync(path.join(root.stateDir, 'index')), 'nor an index');
});

const EVAL_NOTES = {
  'manuals/deploy.md': '# Deploy\n\n## Rollback\n\nThe rollback procedure promotes the previous release.\n',
  'manuals/backups.md': '# Backups\n\n## Schedule\n\nThe snapshot schedule keeps thirty daily snapshots.\n',
};

test('eval: counts per kind and explains each failure', async () => {
  const root = tempRoot(EVAL_NOTES);
  const report = await runEval(
    [root],
    [
      { query: 'rollback procedure', want: ['backups'] },
      { query: 'snapshot schedule', want: ['deploy'], wantText: 'thirty daily snapshots' },
      { query: 'snapshot schedule', wantText: 'THIRTY   daily\nsnapshots' },
      { query: 'rollback', none: true },
    ],
    { k: 2, now: NOW },
  );
  assert.deepEqual(report.note, { hit: 0, total: 2 });
  assert.deepEqual(report.section, { hit: 1, total: 2 }, 'wantText must be in a wanted note; case and spacing do not matter');
  assert.deepEqual(report.none, { hit: 0, total: 1 });
  assert.equal(report.reader, 'lexical');
  assert.equal(report.degraded, undefined);
  assert.deepEqual(
    report.failures.map((f) => [f.index, f.kind]),
    [[0, 'note'], [1, 'note'], [1, 'section'], [3, 'none']],
  );
  assert.equal(report.failures[0].got[0].rel, 'manuals/deploy.md');
  assert.match(report.failures[0].expected, /"backups"/);
});

test('eval: bad cases are rejected with their position; a degraded reader is reported', async () => {
  const root = tempRoot(EVAL_NOTES);
  const bad = [
    [{ want: ['x'] }, /#1 needs a non-empty "query"/],
    [{ query: 'q' }, /says nothing to check/],
    [{ query: 'q', none: true, want: ['x'] }, /cannot be combined/],
    [{ query: 'q', want: [] }, /non-empty list/],
    [{ query: 'q', wantText: ' ' }, /non-empty string/],
  ];
  for (const [c, message] of bad) await assert.rejects(runEval([root], [c]), message);
  await assert.rejects(runEval([], [{ query: 'q', none: true }]), /at least one root/);
  await assert.rejects(runEval([root], /** @type {any} */ ('cases')), /must be a list/);
  /** @type {Embedder} */
  const down = {
    name: 'down',
    embed: async () => {
      throw new Error('service down');
    },
  };
  const report = await runEval([root], [{ query: 'rollback', want: ['deploy'] }], { reader: 'hybrid', embedder: down, now: NOW });
  assert.equal(report.reader, 'hybrid');
  assert.equal(report.degraded, '1 of 1 searches were lexical only: embeddings unavailable: service down');
  assert.deepEqual(report.note, { hit: 1, total: 1 });
});
