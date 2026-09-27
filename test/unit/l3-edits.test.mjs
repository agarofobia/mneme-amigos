// predictAfter: what a Claude Code file tool will leave, before it runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { predictAfter } from '../../src/adapters/claude-code/edits.js';

test('Write predicts its content; a non-string content predicts nothing', () => {
  assert.equal(predictAfter('Write', { file_path: 'x.md', content: '# A\n' }, null), '# A\n');
  assert.equal(predictAfter('Write', { file_path: 'x.md' }, 'old'), null);
});

test('Edit replaces exactly one occurrence, or all with replace_all', () => {
  assert.equal(predictAfter('Edit', { old_string: 'b', new_string: 'B' }, 'abc'), 'aBc');
  assert.equal(predictAfter('Edit', { old_string: 'a', new_string: 'A' }, 'a-a'), null, 'ambiguous: Edit refuses');
  assert.equal(predictAfter('Edit', { old_string: 'a', new_string: 'A', replace_all: true }, 'a-a'), 'A-A');
  assert.equal(predictAfter('Edit', { old_string: 'zz', new_string: 'Z' }, 'abc'), null, 'not found: Edit refuses');
  assert.equal(predictAfter('Edit', { old_string: 'b', new_string: 'b' }, 'abc'), null, 'no change: Edit refuses');
  assert.equal(predictAfter('Edit', { old_string: '$&', new_string: '$1' }, 'x$&y'), 'x$1y', 'replacement patterns are literal');
});

test('Edit on a missing file only creates it with an empty old_string', () => {
  assert.equal(predictAfter('Edit', { old_string: '', new_string: '# New\n' }, null), '# New\n');
  assert.equal(predictAfter('Edit', { old_string: 'x', new_string: 'y' }, null), null);
});

test('Edit matches LF text in a CRLF file and keeps CRLF', () => {
  const before = '# A\r\n\r\n## B\r\ntext\r\n';
  assert.equal(predictAfter('Edit', { old_string: '## B\ntext', new_string: '## B\nnew\n## C' }, before), '# A\r\n\r\n## B\r\nnew\r\n## C\r\n');
});

test('Edit matches straight quotes against typographic ones', () => {
  assert.equal(predictAfter('Edit', { old_string: "it's", new_string: 'it is' }, 'so it’s done'), 'so it is done');
});

test('MultiEdit applies the edits in order and fails as a whole', () => {
  const input = { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c', replace_all: true }] };
  assert.equal(predictAfter('MultiEdit', input, 'a b'), 'c c');
  assert.equal(predictAfter('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'q', new_string: 'r' }] }, 'a'), null);
  assert.equal(predictAfter('MultiEdit', { edits: [] }, 'a'), null);
});

test('other tools and malformed input predict nothing', () => {
  assert.equal(predictAfter('Bash', { command: 'rm x' }, 'x'), null);
  assert.equal(predictAfter('Edit', null, 'x'), null);
});
