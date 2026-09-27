import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBareRoot } from '../helpers/fixture.mjs';
import { findLinks, relink, resolveTarget, rewriteLinks } from '../../src/links.js';
import { openRoot } from '../../src/root.js';

test('findLinks: wiki, heading, alias, embed and relative markdown links', () => {
  const text = 'See [[alpha]], [[alpha#Plan|the plan]], ![[beta]] and [the panel](../projects/beta.md#Plan "t").';
  const links = findLinks(text);
  assert.deepEqual(
    links.map((l) => [l.kind, l.target, l.heading, l.alias, l.embed]),
    [
      ['wiki', 'alpha', undefined, undefined, false],
      ['wiki', 'alpha', 'Plan', 'the plan', false],
      ['wiki', 'beta', undefined, undefined, true],
      ['md', '../projects/beta.md', 'Plan', 'the panel', false],
    ],
  );
  assert.equal(text.slice(links[2].start, links[2].end), '![[beta]]');
});

test('findLinks ignores code, external URLs, absolute paths and links to the same note', () => {
  const text = [
    '```',
    '[[inside-fence]]',
    '```',
    'Inline `[[inside-code]]` and ``a ` [[also-code]]``.',
    '[site](https://example.com/x.md) [abs](/root.md) [img](pic.png) [[#Local heading]]',
    '~~~',
    '[x](fenced.md)',
    '~~~',
    '[[real]]',
  ].join('\n');
  assert.deepEqual(findLinks(text).map((l) => l.target), ['real']);
});

test('resolveTarget: by name (shortest path wins), by path, relative, and markdown', () => {
  const root = openRoot(makeBareRoot());
  const notes = ['a/deep/alpha.md', 'projects/alpha.md', 'projects/beta.md', 'notes/links.md'];
  assert.equal(resolveTarget(root, 'notes/links.md', 'alpha', { notes }), 'projects/alpha.md');
  assert.equal(resolveTarget(root, 'notes/links.md', 'ALPHA', { notes }), 'projects/alpha.md', 'case-insensitive');
  assert.equal(resolveTarget(root, 'notes/links.md', 'deep/alpha', { notes }), 'a/deep/alpha.md', 'partial path');
  assert.equal(resolveTarget(root, 'notes/links.md', 'projects/beta', { notes }), 'projects/beta.md');
  assert.equal(resolveTarget(root, 'notes/links.md', '../projects/beta', { notes }), 'projects/beta.md');
  assert.equal(resolveTarget(root, 'notes/links.md', '../projects/beta.md', { kind: 'md', notes }), 'projects/beta.md');
  assert.equal(resolveTarget(root, 'notes/links.md', 'missing', { notes }), null);
  assert.equal(resolveTarget(root, 'notes/links.md', '../../out.md', { kind: 'md', notes }), null);
  assert.equal(resolveTarget(root, 'notes/links.md', 'beta'), 'projects/beta.md', 'lists the notes itself');
});

test('rewriteLinks keeps heading, alias, embed and the link style', () => {
  const text = [
    'See [[alpha]], [[alpha#Plan|the plan]], ![[alpha]], [[projects/alpha]] and [[alpha.md]].',
    'Table | [[alpha\\|escaped alias]] |',
    'The [doc](../projects/alpha.md#Risks "Risks") and [[beta]] stay as they are.',
  ].join('\n');
  const { text: out, n } = rewriteLinks(text, 'notes/links.md', 'projects/alpha.md', 'archive/alpha 2025.md');
  assert.equal(n, 7);
  assert.equal(
    out,
    [
      'See [[alpha 2025]], [[alpha 2025#Plan|the plan]], ![[alpha 2025]], [[archive/alpha 2025]] and [[alpha 2025.md]].',
      'Table | [[alpha 2025\\|escaped alias]] |',
      'The [doc](../archive/alpha%202025.md#Risks "Risks") and [[beta]] stay as they are.',
    ].join('\n'),
  );
});

test('rewriteLinks uses the given name when the new file name is ambiguous, and a resolver when names repeat', () => {
  const text = '[[alpha]] and [[alpha]]';
  const out = rewriteLinks(text, 'notes/n.md', 'projects/alpha.md', 'archive/alpha.md', {
    newName: 'archive/alpha',
    resolve: () => 'projects/alpha.md',
  });
  assert.equal(out.text, '[[archive/alpha]] and [[archive/alpha]]');
  const other = rewriteLinks(text, 'notes/n.md', 'projects/alpha.md', 'archive/x.md', { resolve: () => 'elsewhere/alpha.md' });
  assert.equal(other.n, 0, 'a link that resolves to another alpha is left alone');
});

test('relink re-bases relative links of a note that changes folder', () => {
  const text = 'Up [p](../projects/beta.md) and [[./sibling]] and [[beta]].';
  const { text: out, n } = relink(
    text,
    'archive/2025/n.md',
    (link) => (link.kind === 'md' ? 'projects/beta.md' : link.target.startsWith('./') ? 'notes/sibling.md' : null),
  );
  assert.equal(n, 2);
  assert.equal(out, 'Up [p](../../projects/beta.md) and [[../../notes/sibling]] and [[beta]].');
});
