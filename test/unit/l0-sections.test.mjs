import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headingCounts, parseFrontmatter, parseNote, sectionTexts } from '../../src/sections.js';

const NOTE = `---
title: "Alpha"
tags: [one, two]
aliases:
  - first
  - second
---
Intro line.

# Alpha

Top text.

## Plan

Plan text.

\`\`\`markdown
## Not a heading
\`\`\`

### Detail

Detail text.

## Risks ##

Risk text.
`;

test('frontmatter: scalars, inline lists and block lists', () => {
  const fm = parseFrontmatter(NOTE);
  assert.equal(fm.data.title, 'Alpha');
  assert.deepEqual(fm.data.tags, ['one', 'two']);
  assert.deepEqual(fm.data.aliases, ['first', 'second']);
  assert.equal(NOTE.slice(fm.end).startsWith('Intro line.'), true);
});

test('no frontmatter, or an unclosed one, yields empty data', () => {
  assert.deepEqual(parseFrontmatter('# Title\n'), { data: {}, end: 0 });
  assert.deepEqual(parseFrontmatter('---\ntitle: x\n# never closed\n'), { data: {}, end: 0 });
});

test('sections: keys, paths, ownEnd and end; fenced headings ignored; closing hashes stripped', () => {
  const { sections, preamble } = parseNote(NOTE);
  assert.deepEqual(sections.map((s) => s.key), ['# Alpha', '## Plan', '### Detail', '## Risks']);
  assert.deepEqual(sections[2].path, ['Alpha', 'Plan', 'Detail']);
  const plan = sections[1];
  assert.equal(NOTE.slice(plan.start, plan.ownEnd).includes('## Not a heading'), true, 'fenced text belongs to Plan');
  assert.equal(plan.end, sections[3].start, 'Plan ends where the next level-2 heading starts');
  assert.equal(plan.ownEnd, sections[2].start, 'Plan own text ends at its child');
  assert.equal(sections[0].end, NOTE.length, 'the level-1 section runs to the end');
  assert.equal(NOTE.slice(preamble.start, preamble.ownEnd).trim(), 'Intro line.');
});

test('headingCounts counts copies up to a level', () => {
  const text = '# A\n## B\n## B\n### C\n';
  assert.deepEqual([...headingCounts(text, 2)], [['# A', 1], ['## B', 2]]);
  assert.deepEqual([...headingCounts(text, 3)].length, 3);
});

test('sectionTexts keys repeated headings by occurrence and includes the preamble', () => {
  const texts = sectionTexts('pre\n## B\none\n## B\ntwo\n');
  assert.equal(texts.get('#0'), 'pre\n');
  assert.equal(texts.get('## B#1'), '## B\none\n');
  assert.equal(texts.get('## B#2'), '## B\ntwo\n');
});

test('CRLF line endings keep offsets right', () => {
  const text = '# A\r\ntext\r\n## B\r\nmore\r\n';
  const { sections } = parseNote(text);
  assert.equal(text.slice(sections[1].start, sections[1].start + 4), '## B');
});
