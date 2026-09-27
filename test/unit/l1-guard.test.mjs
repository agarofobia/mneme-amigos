import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSections, guardMessage, sid8 } from '../../src/guard.js';

/** @param {Record<string, Record<string, number>>} spec */
const owners = (spec) => new Map(Object.entries(spec).map(([k, v]) => [k, new Map(Object.entries(v))]));

const BASE = '# Note\n\n## Mine\n\nmine\n\n## Theirs\n\ntheirs\n';

test('a new note (no before) always passes', () => {
  assert.deepEqual(checkSections({ before: null, after: '# X\n', owners: new Map(), session: 's', levels: 2 }), { ok: true, lost: [] });
});

test('removing a section another session owns is denied, naming the owners', () => {
  const res = checkSections({
    before: BASE,
    after: '# Note\n\n## Mine\n\nmine\n',
    owners: owners({ '## Theirs': { other: 1 }, '## Mine': { me: 1 } }),
    session: 'me',
    levels: 2,
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.lost, [{ key: '## Theirs', owners: ['other'] }]);
});

test('removing or renaming your own section is free', () => {
  const o = owners({ '## Mine': { me: 1 }, '## Theirs': { other: 1 } });
  assert.equal(checkSections({ before: BASE, after: BASE.replace('## Mine\n\nmine\n\n', ''), owners: o, session: 'me', levels: 2 }).ok, true);
  assert.equal(checkSections({ before: BASE, after: BASE.replace('## Mine', '## Renamed'), owners: o, session: 'me', levels: 2 }).ok, true);
});

test('with repeated titles, dropping any copy is denied when another session owns one (R-1)', () => {
  const before = '# N\n\n## Config\n\nA\n\n## Config\n\nB\n';
  const after = '# N\n\n## Config\n\nA\n';
  const o = owners({ '## Config': { a: 1, b: 1 } });
  const res = checkSections({ before, after, owners: o, session: 'a', levels: 2 });
  assert.equal(res.ok, false);
  assert.deepEqual(res.lost[0].owners, ['b']);
});

test('headings nobody owns (adopted) and headings below the guarded level are free', () => {
  assert.equal(checkSections({ before: BASE, after: '# Note\n', owners: new Map(), session: 's', levels: 2 }).ok, true);
  const deep = '# N\n\n### Detail\n\nx\n';
  const res = checkSections({ before: deep, after: '# N\n', owners: owners({ '### Detail': { other: 1 } }), session: 's', levels: 2 });
  assert.equal(res.ok, true);
});

test('an owner with zero copies left does not protect the key', () => {
  const res = checkSections({ before: BASE, after: '# Note\n', owners: owners({ '## Theirs': { other: 0 } }), session: 's', levels: 2 });
  assert.equal(res.ok, true);
});

test('the denial text is the one of the design map, for Edit and for Write', () => {
  const entry = /** @type {import('../../src/types.js').LedgerEntry} */ ({
    v: 1, id: 'x', ts: '2026-01-02T03:04:00.000Z', rel: 'projects/alpha.md', op: 'write',
    author: { session: 'abcdef123456', agent: 'claude-code' }, before: null, after: 'f', delta: { '## Plan': 1 }, changed: [], prev: '',
  });
  const lost = [{ key: '## Plan', owners: ['abcdef123456'] }];
  const edit = guardMessage({
    rel: 'projects/alpha.md', lost, tool: 'Edit', entriesByKey: new Map([['## Plan', [entry]]]), session: '99887766aabb',
  }).split('\n');
  assert.equal(edit[0], '[mneme] Blocked: this write to "projects/alpha.md" removes sections written by another session:');
  assert.match(edit[1], /^ {2}- ## Plan {3}\(session abcdef12, claude-code, \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/);
  assert.equal(edit[2], "Edit only your own section; the other session's sections stay.");
  assert.equal(
    edit[3],
    'If a human confirms the removal, they run in a terminal: mneme allow "projects/alpha.md" --session 99887766 --reason "<why>" (10-minute lease, recorded).',
  );
  const write = guardMessage({ rel: 'projects/alpha.md', lost, tool: 'Write', session: 's', leaseMinutes: 5 }).split('\n');
  assert.equal(write[1], '  - ## Plan   (session abcdef12)', 'without the entry it still names the owner');
  assert.equal(write[2], 'A Write replaces the whole file: re-read it and use Edit on your own section.');
  assert.match(write[3], /\(5-minute lease, recorded\)\.$/);
  assert.equal(sid8('short'), 'short');
});
