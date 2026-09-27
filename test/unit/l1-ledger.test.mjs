import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeBareRoot, sha256 } from '../helpers/fixture.mjs';
import { appendEntries, appendEntry, headIn, headOf, headsIn, ledgerPath, lineage, newId, owners, ownersIn, readLedger } from '../../src/ledger.js';
import { openRoot } from '../../src/root.js';

/** @typedef {import('../../src/ledger.js').NewEntry} NewEntry */

/**
 * @param {Partial<NewEntry> & { rel: string }} fields
 * @returns {NewEntry}
 */
const entry = (fields) => ({
  v: 1, id: newId(), ts: new Date().toISOString(), op: 'write', author: { session: 'a', agent: 'cli' },
  before: null, after: sha256(fields.rel), delta: {}, changed: [], ...fields,
});

const root = () => openRoot(makeBareRoot());

test('ids are time-ordered with a random tail', () => {
  const a = newId();
  assert.match(a, /^[0-9a-z]+-[0-9a-z]{6}$/);
  assert.notEqual(a, newId());
});

test('appended entries chain their prev and read back deep-equal', () => {
  const r = root();
  const first = appendEntry(r, entry({ rel: 'a.md', reason: 'one' }));
  assert.equal(first.prev, '');
  const [second, third] = appendEntries(r, [entry({ rel: 'b.md' }), entry({ rel: 'c.md' })]);
  const lines = fs.readFileSync(ledgerPath(r), 'utf8').split('\n');
  assert.equal(second.prev, sha256(lines[0]));
  assert.equal(third.prev, sha256(lines[1]));
  const { entries, corrupt, broken } = readLedger(r);
  assert.deepEqual(entries, [first, second, third]);
  assert.equal(corrupt + broken, 0);
  assert.ok(!('violations' in first) && !('raced' in first), 'empty optional fields are not written');
});

test('a torn line is counted, skipped, and closed by the next append without breaking the chain', () => {
  const r = root();
  appendEntry(r, entry({ rel: 'a.md' }));
  fs.appendFileSync(ledgerPath(r), '{"v":1,"id":"torn');
  assert.deepEqual([readLedger(r).entries.length, readLedger(r).corrupt], [1, 1]);
  appendEntry(r, entry({ rel: 'b.md' }));
  const after = readLedger(r);
  assert.equal(after.entries.length, 2);
  assert.equal(after.corrupt, 1);
  assert.equal(after.broken, 0, 'the next line chains to the torn line as stored');
});

test('a checkout that turns LF into CRLF does not break the chain', () => {
  const r = root();
  appendEntries(r, [entry({ rel: 'a.md' }), entry({ rel: 'b.md' })]);
  const file = ledgerPath(r);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  appendEntry(r, entry({ rel: 'c.md' }));
  const { entries, corrupt, broken } = readLedger(r);
  assert.deepEqual([entries.length, corrupt, broken], [3, 0, 0]);
});

test('a deleted line in the middle shows as broken', () => {
  const r = root();
  appendEntries(r, [entry({ rel: 'a.md' }), entry({ rel: 'b.md' }), entry({ rel: 'c.md' })]);
  const file = ledgerPath(r);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.splice(1, 1);
  fs.writeFileSync(file, lines.join('\n'));
  assert.equal(readLedger(r).broken, 1);
});

test('an empty or missing ledger reads as empty', () => {
  const r = root();
  assert.deepEqual(readLedger(r), { entries: [], corrupt: 0, broken: 0 });
  assert.equal(headOf(r, 'x.md'), null);
  assert.equal(owners(r, 'x.md').size, 0);
});

test('lineage follows moves, and a name moved away starts empty', () => {
  const e = [
    entry({ rel: 'a.md', after: 'v1', delta: { '## A': 1 } }),
    entry({ rel: 'b.md', op: 'move', from: 'a.md', before: 'v1', after: 'v1' }),
    entry({ rel: 'c.md', op: 'move', from: 'b.md', before: 'v1', after: 'v1' }),
    entry({ rel: 'a.md', after: 'new', author: { session: 'z', agent: 'cli' }, delta: { '## Z': 1 } }),
  ].map((x) => ({ ...x, prev: '' }));
  assert.deepEqual(lineage(e, 'c.md').map((x) => x.rel), ['a.md', 'b.md', 'c.md']);
  assert.equal(headIn(e, 'c.md'), 'v1');
  assert.equal(headIn(e, 'b.md'), null, 'b.md was vacated');
  assert.equal(headIn(e, 'a.md'), 'new', 'the new a.md is another note');
  assert.deepEqual([...ownersIn(e, 'c.md').keys()], ['## A']);
  assert.deepEqual([...ownersIn(e, 'a.md').keys()], ['## Z']);
  assert.deepEqual([...headsIn(e)], [['c.md', 'v1'], ['a.md', 'new']]);
});

test('owners sum deltas per session and never go below zero', () => {
  const e = [
    entry({ rel: 'n.md', delta: { '## X': 1 } }),
    entry({ rel: 'n.md', delta: { '## X': -1 }, author: { session: 'b', agent: 'cli' } }),
    entry({ rel: 'n.md', delta: { '## X': -1 } }),
    entry({ rel: 'n.md', delta: { '## X': 2 }, author: { session: 'b', agent: 'cli' } }),
  ].map((x) => ({ ...x, prev: '' }));
  const o = ownersIn(e, 'n.md').get('## X');
  assert.equal(o?.get('a'), undefined, 'a went 1 -> 0 and is dropped');
  assert.equal(o?.get('b'), 2, 'b was clamped at 0, then +2');
});

test('readLedger counts a valid JSON line that is not an entry as corrupt', () => {
  const r = root();
  fs.mkdirSync(path.dirname(ledgerPath(r)), { recursive: true });
  fs.writeFileSync(ledgerPath(r), '{"hello":"world"}\n');
  assert.equal(readLedger(r).corrupt, 1);
});
