import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankBM25, sectionDocs } from '../../src/readers/lexical.js';
import { isPinned, markerScope, staleness, utcDay } from '../../src/readers/stale.js';
import { STOPWORDS, termFrequencies, tokenize } from '../../src/readers/tokenize.js';
import { parseNote } from '../../src/sections.js';

const NOW = new Date('2026-09-24T12:00:00Z');
/** @type {import('../../src/types.js').Config['metadataAliases']} */
const NO_ALIASES = { expires: [], superseded_by: [], pinned: [] };

test('tokenize: lower case, no accents, splits on non-letters, drops stopwords and 1-char tokens', () => {
  assert.deepEqual(tokenize('Decisión de BASE de datos: Ñandú, año 2026!'), ['decision', 'base', 'datos', 'nandu', 'ano', '2026']);
  assert.deepEqual(tokenize('The rollback-procedure of a release'), ['rollback', 'procedure', 'release']);
  assert.deepEqual(tokenize('x y z'), []);
  assert.deepEqual(tokenize(''), []);
  for (const word of STOPWORDS) assert.equal(word, word.normalize('NFD').replace(/\p{M}+/gu, ''), `stopword "${word}" has an accent`);
});

test('termFrequencies survives words that are Object.prototype members', () => {
  const tf = termFrequencies('constructor constructor toString hasOwnProperty __proto__');
  assert.equal(tf.get('constructor'), 2);
  assert.equal(tf.get('tostring'), 1);
  assert.equal(tf.get('proto'), 1);
});

test('sectionDocs: preamble is key "", duplicated headings count occurrences, fences and empty sections are not documents', () => {
  const text = [
    '---',
    'title: T',
    '---',
    'Intro words here.',
    '# Top',
    '## Same',
    'first copy',
    '## Same',
    'second copy',
    '## The',
    '```',
    '## Inside fence',
    '```',
  ].join('\n');
  const docs = sectionDocs(text);
  assert.deepEqual(
    docs.map((d) => [d.key, d.occ]),
    [['', 1], ['# Top', 1], ['## Same', 1], ['## Same', 2], ['## The', 1]],
  );
  assert.ok(!docs.some((d) => d.key === '## Inside fence'));
  const second = docs[3];
  assert.equal(text.slice(second.start, second.ownEnd).trim(), '## Same\nsecond copy');
  assert.deepEqual(second.path, ['Top', 'Same']);
  assert.notEqual(docs[2].vid, docs[3].vid, 'different text, different vector id');
  assert.ok(docs[0].tf.some(([t]) => t === 'intro'));
  assert.ok(!docs[0].tf.some(([t]) => t === 'title'), 'the frontmatter is not searchable text');
  // "## The" alone is only a stopword, but its fence body gives it tokens.
  assert.ok(docs[4].tf.some(([t]) => t === 'fence'));
});

test('sectionDocs: a section with no words of its own is not a document (it would echo its parent title)', () => {
  const docs = sectionDocs('# Real title\n\nbody\n\n## The\n\n## Next\n');
  assert.deepEqual(docs.map((d) => d.key), ['# Real title', '## Next']);
  assert.deepEqual(docs[1].tf, [['next', 1], ['real', 1], ['title', 1]], 'enclosing titles still add context');
});

/** @param {Record<string, number>} counts */
const doc = (counts) => {
  const tf = new Map(Object.entries(counts));
  let len = 0;
  for (const n of tf.values()) len += n;
  return { len, tf };
};

test('BM25: rare terms weigh more, long documents are normalized, repeated query terms count once', () => {
  const docs = [doc({ common: 1, rare: 1 }), doc({ common: 1 }), doc({ common: 1 }), doc({ common: 1, filler: 20 })];
  const byRare = rankBM25(docs, ['rare']);
  assert.deepEqual(byRare.map((h) => h.i), [0]);
  const byCommon = rankBM25(docs, ['common']);
  assert.equal(byCommon[byCommon.length - 1].i, 3, 'the long document ranks last for the same tf');
  assert.ok(byRare[0].score > rankBM25(docs, ['common'])[0].score, 'idf: a rare term scores higher');
  assert.deepEqual(rankBM25(docs, ['rare', 'rare']), byRare);
  assert.deepEqual(rankBM25(docs, ['absent']), []);
  assert.deepEqual(rankBM25([], ['rare']), []);
  assert.deepEqual(rankBM25(docs, []), []);
});

test('BM25: ties keep collection order (deterministic)', () => {
  const docs = [doc({ a: 1 }), doc({ a: 1 }), doc({ a: 1 })];
  assert.deepEqual(rankBM25(docs, ['a']).map((h) => h.i), [0, 1, 2]);
});

/** @param {string} text */
const noteStale = (text, now = NOW, aliases = NO_ALIASES) => staleness(parseNote(text), null, now, aliases);

test('staleness of a note: expires is inclusive of its day; superseded wins; bad dates are ignored', () => {
  assert.equal(noteStale('---\nexpires: 2026-09-24\n---\n# A\n'), null, 'expires today: still valid today');
  assert.deepEqual(noteStale('---\nexpires: 2026-09-23\n---\n# A\n'), { reason: 'expired 2026-09-23' });
  assert.deepEqual(noteStale('---\nexpires: 2026-09-23T10:00:00Z\n---\n# A\n'), { reason: 'expired 2026-09-23' });
  assert.equal(noteStale('---\nexpires: 2026-02-31\n---\n# A\n'), null, 'an impossible date is not a date');
  assert.equal(noteStale('---\nexpires: someday\n---\n# A\n'), null);
  assert.deepEqual(noteStale('---\nexpires: 2020-01-01\nsuperseded_by: "[[b]]"\n---\n'), { reason: 'superseded by [[b]]' });
  assert.equal(noteStale('# No frontmatter\n'), null);
});

test('staleness depends only on the UTC day of now', () => {
  const text = '---\nexpires: 2026-09-24\n---\n# A\n';
  assert.equal(noteStale(text, new Date('2026-09-24T23:59:59Z')), null);
  assert.deepEqual(noteStale(text, new Date('2026-09-25T00:00:00Z')), { reason: 'expired 2026-09-24' });
  assert.equal(utcDay(new Date('2026-09-24T23:30:00-03:00')), '2026-09-25');
  assert.throws(() => utcDay(new Date('nope')), TypeError);
});

test('staleness honors metadataAliases in the frontmatter and in section markers', () => {
  const aliases = { expires: ['valid_until'], superseded_by: ['replaced-by'], pinned: ['keep'] };
  assert.deepEqual(noteStale('---\nvalid_until: 2021-01-01\n---\n', NOW, aliases), { reason: 'expired 2021-01-01' });
  assert.deepEqual(noteStale('---\nreplaced_by: "[[x]]"\n---\n', NOW, aliases), { reason: 'superseded by [[x]]' });
  const parsed = parseNote('# A\n<!-- valid-until: 2021-01-01 -->\n');
  assert.deepEqual(staleness(parsed, { text: '<!-- valid-until: 2021-01-01 -->' }, NOW, aliases), { reason: 'expired 2021-01-01' });
  assert.ok(isPinned(parseNote('---\nkeep: true\n---\n'), aliases));
  assert.ok(!isPinned(parseNote('---\nkeep: true\n---\n')));
  assert.ok(isPinned(parseNote('---\npinned: TRUE\n---\n')));
  assert.ok(!isPinned(parseNote('---\npinned: false\n---\n')));
});

test('section markers: the marked section and its subsections are stale, its siblings are not', () => {
  const text = [
    '# Top',
    '## Old way',
    '<!-- superseded-by: [[new-way]] -->',
    'old text',
    '### Detail of old way',
    'detail',
    '## Current way',
    'current text',
    '<!-- expires: 2099-01-01 -->',
  ].join('\n');
  const parsed = parseNote(text);
  const verdict = (/** @type {number} */ i) => staleness(parsed, markerScope(text, parsed, i), NOW, NO_ALIASES);
  const index = (/** @type {string} */ key) => parsed.sections.findIndex((s) => s.key === key);
  assert.equal(verdict(index('# Top')), null);
  assert.deepEqual(verdict(index('## Old way')), { reason: 'superseded by [[new-way]]' });
  assert.deepEqual(verdict(index('### Detail of old way')), { reason: 'superseded by [[new-way]]' });
  assert.equal(verdict(index('## Current way')), null, 'expires in the future');
  assert.equal(verdict(-1), null, 'the preamble');
});
