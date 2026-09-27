// Written by the main thread after wave 1: scope in search (P1) and the eval split (P4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBareRoot } from '../helpers/fixture.mjs';
import { runEval } from '../../src/eval.js';
import { openRoot } from '../../src/root.js';
import { search } from '../../src/search.js';

test('scope keeps the search inside the given folders or notes', async () => {
  const root = openRoot(makeBareRoot());
  const all = await search([root], 'plan', { reader: 'lexical', k: 10 });
  assert.ok(all.hits.some((h) => h.rel.startsWith('projects/')) && all.hits.some((h) => h.rel.startsWith('notes/')));
  const scoped = await search([root], 'plan', { reader: 'lexical', k: 10, scope: ['projects'] });
  assert.ok(scoped.hits.length > 0);
  assert.ok(scoped.hits.every((h) => h.rel.startsWith('projects/')));
  const one = await search([root], 'plan', { reader: 'lexical', k: 10, scope: ['./notes/old-plan.md'] });
  assert.deepEqual([...new Set(one.hits.map((h) => h.rel))], ['notes/old-plan.md']);
});

test('scope refuses paths that leave the root', async () => {
  const root = openRoot(makeBareRoot());
  await assert.rejects(search([root], 'plan', { scope: ['../elsewhere'] }), RangeError);
  await assert.rejects(search([root], 'plan', { scope: ['/abs'] }), RangeError);
});

test('eval counts dev and holdout apart and returns one result per case', async () => {
  const root = openRoot(makeBareRoot());
  const report = await runEval(
    [root],
    [
      { query: 'rollback procedure', want: ['manuals/deploy'] },
      { query: 'snapshot schedule', want: ['manuals/backups'], split: 'holdout' },
      { query: 'zyxwv qwertyuiop', none: true, split: 'holdout' },
    ],
    { k: 3, reader: 'lexical' },
  );
  assert.deepEqual(report.bySplit.dev.note, { hit: 1, total: 1 });
  assert.deepEqual(report.bySplit.holdout.note, { hit: 1, total: 1 });
  assert.deepEqual(report.bySplit.holdout.none, { hit: 1, total: 1 });
  assert.equal(report.results.length, 3);
  assert.deepEqual(report.results.map((r) => [r.split, r.pass]), [['dev', true], ['holdout', true], ['holdout', true]]);
  await assert.rejects(runEval([root], [{ query: 'x', none: true, split: 'test' }]), TypeError);
});
