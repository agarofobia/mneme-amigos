// M4 · the "return nothing" floor (contract §4.12): what does not depend on the rule inside
// hitPasses (the defaults change nothing, the lexical floor cuts at its edge, the config
// refuses what the rule cannot read, including the dead key `minScore`). And the false
// "changed ## X" notice that the M5 real door found.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig } from '../../src/config.js';
import { STATE_DIR } from '../../src/name.js';
import { openRoot } from '../../src/root.js';
import { hitPasses, search } from '../../src/search.js';
import { editNote, writeNote } from '../../src/store.js';

const NOW = new Date('2026-09-24T12:00:00Z');

/**
 * @param {Record<string, string>} files
 * @param {object} [config]
 */
function tempRoot(files, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-m4-'));
  fs.mkdirSync(path.join(dir, STATE_DIR));
  if (config) fs.writeFileSync(path.join(dir, STATE_DIR, 'config.json'), JSON.stringify(config));
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
  return openRoot(dir);
}

const LONG = 60; // the ceiling of a long question: the cap never bites

test('with the default floors every hit passes: an uncalibrated root behaves as before', () => {
  const { minLexical, minLexicalRatio, minCosine } = DEFAULTS.search;
  for (const lexical of [0, 0.001, 3.2, 48]) {
    for (const cosine of [null, -1, -0.2, 0, 0.5, 0.99, 1]) {
      for (const ceiling of [0, 4, LONG]) {
        assert.equal(hitPasses({ lexical, cosine, ceiling }, { minLexical, minLexicalRatio, minCosine }), true, `lexical ${lexical}, cosine ${cosine}, ceiling ${ceiling}`);
      }
    }
  }
});

test('the lexical floor cuts at its edge, in the lexical reader (no cosine)', () => {
  const floors = { minLexical: 12.5, minLexicalRatio: 1, minCosine: 1 };
  assert.equal(hitPasses({ lexical: 12.5, cosine: null, ceiling: LONG }, floors), true);
  assert.equal(hitPasses({ lexical: 12.49, cosine: null, ceiling: LONG }, floors), false);
  assert.equal(hitPasses({ lexical: 0, cosine: null, ceiling: LONG }, floors), false);
});

test('either signal is enough: a hit only the semantic side found passes on its cosine alone', () => {
  const floors = { minLexical: 12.5, minLexicalRatio: 1, minCosine: 0.78 };
  assert.equal(hitPasses({ lexical: 0, cosine: 0.78, ceiling: LONG }, floors), true, 'semantic only, at the cosine floor');
  assert.equal(hitPasses({ lexical: 0, cosine: 0.779, ceiling: LONG }, floors), false, 'semantic only, just below');
  assert.equal(hitPasses({ lexical: 20, cosine: 0.1, ceiling: LONG }, floors), true, 'strong lexical, weak cosine');
  assert.equal(hitPasses({ lexical: 5, cosine: 0.5, ceiling: LONG }, floors), false, 'both weak');
  assert.equal(hitPasses({ lexical: 5, cosine: null, ceiling: LONG }, floors), false, 'no cosine: only the lexical floor counts');
});

test('a short question is judged on its own scale: the floor is capped at a share of its ceiling', () => {
  const floors = { minLexical: 12.5, minLexicalRatio: 0.4, minCosine: 0.78 };
  // "what is Mneme" could score at most 10.6: a fixed 12.5 would be unreachable. Floor: 0.4 × 10 = 4.
  assert.equal(hitPasses({ lexical: 5, cosine: null, ceiling: 10 }, floors), true);
  assert.equal(hitPasses({ lexical: 3.9, cosine: null, ceiling: 10 }, floors), false);
  // A long question keeps the whole floor: 0.4 × 60 = 24 > 12.5.
  assert.equal(hitPasses({ lexical: 12, cosine: null, ceiling: LONG }, floors), false);
  assert.equal(hitPasses({ lexical: 12.5, cosine: null, ceiling: LONG }, floors), true);
  // Only stopwords: ceiling 0 must not turn into a floor of 0 for semantic neighbours.
  assert.equal(hitPasses({ lexical: 0, cosine: 0.5, ceiling: 0 }, floors), false);
  assert.equal(hitPasses({ lexical: 0, cosine: 0.8, ceiling: 0 }, floors), true);
});

test('a lexical search with a floor above every score comes back empty; without one it does not', async () => {
  const notes = { 'tea.md': '# Tea\n\nGreen tea steeps for two minutes.\n', 'bike.md': '# Bike\n\nThe chain needs oil.\n' };
  assert.deepEqual((await search([tempRoot(notes, { search: { minLexical: 1000 } })], 'tea', { reader: 'lexical', now: NOW })).hits, []);
  assert.equal((await search([tempRoot(notes)], 'tea', { reader: 'lexical', now: NOW })).hits.length, 1);
  // The same unreachable floor, capped to the question's scale, lets the exact match through.
  const capped = await search([tempRoot(notes, { search: { minLexical: 1000, minLexicalRatio: 0.3 } })], 'tea', { reader: 'lexical', now: NOW });
  assert.deepEqual(capped.hits.map((h) => h.rel), ['tea.md']);
});

test('appending a section after another one does not report the other one as changed', async () => {
  const root = tempRoot({ 'shared.md': '# Shared\n\nA note.\n' });
  /** @type {import('../../src/types.js').Author} */ const A = { session: 'session-a', agent: 'cli' };
  /** @type {import('../../src/types.js').Author} */ const B = { session: 'session-b', agent: 'cli' };
  const a = await writeNote(root, 'shared.md', '# Shared\n\nA note.\n\n## Section A\n\nWritten by A.\n', { author: A });
  assert.ok(a.ok);
  // The real door (24/09): B appended with Edit, and A was told "changed ## Section A".
  const b = await editNote(root, 'shared.md', { old: 'Written by A.\n', new: 'Written by A.\n\n## Section B\n\nWritten by B.\n' }, { author: B });
  assert.ok(b.ok);
  assert.deepEqual(b.entry.changed, ['## Section B']);
  // Control: a real change to A's text still counts.
  const c = await editNote(root, 'shared.md', { old: 'Written by A.', new: 'Rewritten by B.' }, { author: B });
  assert.ok(c.ok);
  assert.deepEqual(c.entry.changed, ['## Section A']);
});

test('the config refuses floors the rule cannot read, and the dead key minScore', () => {
  const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-m4-cfg-')), STATE_DIR);
  fs.mkdirSync(state);
  /** @param {object} search */
  const load = (search) => {
    fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ search }));
    return loadConfig(state);
  };
  assert.throws(() => load({ minLexical: -1 }), { code: 'CONFIG_INVALID', message: /minLexical/ });
  assert.throws(() => load({ minLexical: 'high' }), { code: 'CONFIG_INVALID', message: /minLexical/ });
  assert.throws(() => load({ minCosine: 1.5 }), { code: 'CONFIG_INVALID', message: /minCosine/ });
  assert.throws(() => load({ minCosine: -2 }), { code: 'CONFIG_INVALID', message: /minCosine/ });
  // An old config must fail loudly, not keep running with the floor silently off.
  assert.throws(() => load({ minScore: 5 }), { code: 'CONFIG_INVALID', message: /minScore/ });
  assert.throws(() => load({ minLexicalRatio: 0 }), { code: 'CONFIG_INVALID', message: /minLexicalRatio/ });
  assert.throws(() => load({ minLexicalRatio: 1.5 }), { code: 'CONFIG_INVALID', message: /minLexicalRatio/ });
  assert.deepEqual(load({ minLexical: 12.5, minCosine: 0.78 }).search, { k: 5, minLexical: 12.5, minLexicalRatio: 1, minCosine: 0.78, stale: 'follow' });
});
