import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeBareRoot } from '../helpers/fixture.mjs';
import { findObjects, getObject, hasObject, putObject, sha256, writeFileAtomic } from '../../src/objects.js';
import { openRoot } from '../../src/root.js';

test('an object is stored once under its sha and read back', () => {
  const root = openRoot(makeBareRoot());
  const sha = putObject(root, 'café naïve\n');
  assert.equal(sha, sha256('café naïve\n'));
  assert.ok(fs.existsSync(path.join(root.stateDir, 'objects', sha.slice(0, 2), sha)));
  assert.equal(putObject(root, 'café naïve\n'), sha, 'idempotent');
  assert.equal(getObject(root, sha), 'café naïve\n');
  assert.equal(hasObject(root, sha), true);
  assert.deepEqual(findObjects(root, sha.slice(0, 8)), [sha]);
});

test('a missing or malformed version is VERSION_NOT_FOUND with what to do', () => {
  const root = openRoot(makeBareRoot());
  assert.throws(() => getObject(root, 'a'.repeat(64)), { code: 'VERSION_NOT_FOUND', message: /history/ });
  assert.throws(() => getObject(root, '../../etc'), { code: 'VERSION_NOT_FOUND' });
  assert.equal(hasObject(root, 'nope'), false);
  assert.deepEqual(findObjects(root, 'zz'), []);
});

test('an atomic write leaves no temporary file, and a crash point leaves the target intact', () => {
  const root = openRoot(makeBareRoot());
  const file = path.join(root.dir, 'notes', 'atomic.md');
  writeFileAtomic(file, 'one\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), []);
  assert.throws(() => writeFileAtomic(file, 'two\n', { beforeRename: () => { throw new Error('boom'); } }), /boom/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\n');
  const orphans = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'));
  assert.equal(orphans.length, 1, 'a crash leaves the temp file behind');
  assert.match(orphans[0], /^\.atomic\.md\.[0-9a-f]+\.tmp$/, 'and it never ends in a note extension');
});
