// Acceptance, lote A (contracts §4.21, D-5): a superseded hit brings the current section with it,
// and the eval neither misses it nor counts a marker as the answer. Written by the main thread
// BEFORE the lote; the worker does not edit it (objections go in `objeciones_a_tests`).
//   node --test test/aceptacion/pending/a-follow.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeBareRoot } from '../helpers/fixture.mjs';
import { runEval } from '../../src/eval.js';
import { loadConfig } from '../../src/config.js';
import { openRoot } from '../../src/root.js';
import { formatFollow, formatHit, search } from '../../src/search.js';
import { STATE_DIR } from '../../src/name.js';

const NOW = new Date('2026-09-25T12:00:00Z');
const OLD = 'old plan migrate without rebuilding';

/** @param {string} dir @param {string} rel @param {string} text */
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

test('follow is the default: the superseded hit keeps its place and brings the current section', async () => {
  const root = openRoot(makeBareRoot());
  const { hits } = await search([root], OLD, { reader: 'lexical', now: NOW });
  const old = hits[0];
  assert.equal(old?.rel, 'notes/old-plan.md');
  assert.match(old.stale?.reason ?? '', /^superseded by /);
  assert.equal(old.follow?.rel, 'projects/alpha.md');
  assert.equal(old.follow?.section?.key, '## Plan');
  assert.deepEqual(old.follow?.section?.path, ['Alpha', 'Plan']);
  assert.match(old.follow?.text ?? '', /Rebuild the vector index/);
  assert.equal(old.follow?.stale, undefined, 'the current section is not stale');
});

test('follow does not take a place in k', async () => {
  const root = openRoot(makeBareRoot());
  const { hits } = await search([root], OLD, { reader: 'lexical', now: NOW, k: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].follow?.rel, 'projects/alpha.md');
});

test('"mark" gives exactly the old shape: no hit has a follow key', async () => {
  const root = openRoot(makeBareRoot({ version: 1, search: { stale: 'mark' } }));
  const { hits } = await search([root], OLD, { reader: 'lexical', now: NOW });
  assert.equal(hits[0]?.rel, 'notes/old-plan.md');
  assert.ok(hits[0].stale, 'still marked');
  for (const h of hits) assert.ok(!('follow' in h), `${h.rel} has a follow key under "mark"`);
  for (const h of hits) assert.deepEqual(Object.keys(h).sort(), ['rel', 'root', 'score', 'section', 'text', ...(h.stale ? ['stale'] : [])].sort());
});

// §4.3 (26/09, Artu: «que una invalidez use su valor por defecto»): the root opens on the default and
// names the problem; the strict reading, which validates a config before it is written, still refuses it.
test('an unknown value for search.stale goes back to "follow" and is named; the strict reading refuses it', () => {
  const dir = makeBareRoot({ version: 1, search: { stale: 'demote' } });
  const root = openRoot(dir);
  assert.equal(root.config.search.stale, 'follow');
  assert.equal(root.configProblems?.length, 1);
  assert.match(root.configProblems?.[0] ?? '', /search\.stale.*using the default \("follow"\)/);
  assert.throws(() => loadConfig(root.stateDir), (e) => /** @type {any} */ (e).code === 'CONFIG_INVALID' && /search\.stale/.test(/** @type {Error} */ (e).message));
});

test('a link that does not resolve leaves the mark and no follow; the search does not fail', async () => {
  const dir = makeBareRoot();
  put(dir, 'notes/orphan.md', '---\nsuperseded_by: "[[no-such-note#Plan]]"\n---\n# Orphan\n\nThe orphan quartz calibration notes moved somewhere else.\n');
  put(dir, 'notes/outside.md', '# Outside\n\n## Quartz schedule\n<!-- superseded-by: https://example.com/quartz -->\nThe quartz schedule now lives in another system.\n');
  const root = openRoot(dir);
  const a = await search([root], 'orphan quartz calibration', { reader: 'lexical', now: NOW });
  assert.equal(a.hits[0]?.rel, 'notes/orphan.md');
  assert.ok(a.hits[0].stale);
  assert.equal(a.hits[0].follow, undefined);
  const b = await search([root], 'quartz schedule another system', { reader: 'lexical', now: NOW });
  assert.equal(b.hits[0]?.rel, 'notes/outside.md');
  assert.ok(b.hits[0].stale);
  assert.equal(b.hits[0].follow, undefined);
});

test('a heading that is not there follows to the whole note, with section null', async () => {
  const dir = makeBareRoot();
  put(dir, 'notes/moved.md', '---\nsuperseded_by: "[[alpha#No such heading]]"\n---\n# Moved\n\nThe moved zeppelin checklist was folded into alpha.\n');
  const root = openRoot(dir);
  const { hits } = await search([root], 'moved zeppelin checklist', { reader: 'lexical', now: NOW });
  assert.equal(hits[0]?.rel, 'notes/moved.md');
  assert.equal(hits[0].follow?.rel, 'projects/alpha.md');
  assert.equal(hits[0].follow?.section, null);
  assert.match(hits[0].follow?.text ?? '', /Alpha is the internal search service/);
  assert.doesNotMatch(hits[0].follow?.text ?? '', /^---/, 'the text starts after the frontmatter');
});

test('an expired hit has nothing to follow', async () => {
  const root = openRoot(makeBareRoot());
  const { hits } = await search([root], 'temporary pricing offer', { reader: 'lexical', now: NOW });
  assert.equal(hits[0]?.rel, 'notes/expired.md');
  assert.match(hits[0].stale?.reason ?? '', /expired/);
  assert.equal(hits[0].follow, undefined);
});

test('one hop only: a current note that is itself superseded is said, not followed', async () => {
  const dir = makeBareRoot();
  put(dir, 'notes/v1.md', '---\nsuperseded_by: "[[v2]]"\n---\n# V1\n\nThe version one walrus protocol.\n');
  put(dir, 'notes/v2.md', '---\nsuperseded_by: "[[v3]]"\n---\n# V2\n\nThe version two protocol.\n');
  put(dir, 'notes/v3.md', '# V3\n\nThe version three protocol.\n');
  const root = openRoot(dir);
  const { hits } = await search([root], 'version one walrus protocol', { reader: 'lexical', now: NOW });
  const v1 = hits.find((h) => h.rel === 'notes/v1.md');
  assert.equal(v1?.follow?.rel, 'notes/v2.md');
  assert.match(v1?.follow?.stale?.reason ?? '', /superseded by/);
  assert.ok(!('follow' in (v1?.follow ?? {})), 'no second hop');
});

test('formatFollow: one line with the same location format as formatHit, or null', async () => {
  const root = openRoot(makeBareRoot());
  const { hits } = await search([root], OLD, { reader: 'lexical', now: NOW });
  assert.equal(formatFollow(hits[0]), '→ current: projects/alpha.md > Alpha > Plan');
  assert.match(formatHit(hits[0]), /^notes\/old-plan\.md.*\[STALE: superseded by/);
  const fresh = await search([root], 'lexical fallback embedding service down', { reader: 'lexical', now: NOW });
  assert.equal(formatFollow(fresh.hits[0]), null);
});

test('the eval counts the followed current section, for note and for section checks', async () => {
  const cases = [{ query: OLD, want: ['alpha'], wantText: 'Rebuild the vector index' }];
  const follow = await runEval([openRoot(makeBareRoot())], cases, { k: 1, reader: 'lexical', now: NOW });
  assert.deepEqual([follow.note.hit, follow.section.hit], [1, 1]);
  const mark = await runEval([openRoot(makeBareRoot({ version: 1, search: { stale: 'mark' } }))], cases, { k: 1, reader: 'lexical', now: NOW });
  assert.deepEqual([mark.note.hit, mark.section.hit], [0, 0], 'control: with "mark" the current section never reaches k=1');
});

test('D-5 ①: wantText inside a marker comment does not count; the same text in prose does', async () => {
  const dir = makeBareRoot();
  put(dir, 'notes/marker.md', '# Marker\n\n## Lighthouse lens schedule\n<!-- superseded-by: [[beacon#Lens rotation plan]] -->\nThe lighthouse lens schedule is kept elsewhere now.\n');
  put(dir, 'notes/prose.md', '# Prose\n\n## Beacon lens\nThe beacon lens rotation plan is written here in plain words.\n');
  const root = openRoot(dir);
  const inMarker = await runEval([root], [{ query: 'lighthouse lens schedule', want: ['marker'], wantText: 'Lens rotation plan' }], { reader: 'lexical', now: NOW });
  assert.equal(inMarker.section.hit, 0, 'the text only appears inside <!-- … -->');
  const inProse = await runEval([root], [{ query: 'beacon lens rotation plan', want: ['prose'], wantText: 'lens rotation plan' }], { reader: 'lexical', now: NOW });
  assert.equal(inProse.section.hit, 1, 'control: in prose it counts');
});

// The export tool is itself private: in the public tree (the friends' repo, 26/09) this test has nothing to
// check, and its CI would fail on the import. It runs wherever the tool is.
const EXPORTADOR = fileURLToPath(new URL('../../scripts/export-public.mjs', import.meta.url));
test('the public export leaves out docs/ and the export tool itself', { skip: !fs.existsSync(EXPORTADOR) && 'the export tool is not in the public tree' }, async () => {
  const { publicFiles, PRIVATE_PREFIXES } = await import('../../scripts/export-public.mjs');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  for (const p of ['docs/', 'scripts/export-public.mjs', 'test/unit/n25-export-public.test.mjs']) assert.ok(PRIVATE_PREFIXES.includes(p), `${p} is private`);
  const files = publicFiles(repo);
  assert.ok(files.includes('README.md') && files.includes('src/search.js'), 'the public tree still has the code and the README');
  assert.equal(files.filter((f) => f.startsWith('docs/')).length, 0);
  assert.ok(!files.includes('scripts/export-public.mjs'));
  assert.ok(!files.some((f) => f.startsWith(`${STATE_DIR}/`)));
});
