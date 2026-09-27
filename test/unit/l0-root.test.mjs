import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture, makeBareRoot } from '../helpers/fixture.mjs';
import { DEFAULTS, loadConfig } from '../../src/config.js';
import { STATE_DIR } from '../../src/name.js';
import { isUnder, resolveInRoot, toSlash } from '../../src/paths.js';
import { findRoot, listNotes, openRoot } from '../../src/root.js';

test('openRoot refuses a folder without the state directory, with the fix in the message', () => {
  const dir = copyFixture();
  assert.throws(() => openRoot(dir), { code: 'ROOT_NOT_FOUND', message: /init <dir>/ });
});

test('findRoot walks up to the nearest root, and returns null outside any root', () => {
  const dir = makeBareRoot();
  const root = findRoot(path.join(dir, 'projects', 'alpha.md'));
  assert.equal(root?.dir, openRoot(dir).dir);
  assert.equal(findRoot(path.join(dir, 'projects', 'does-not-exist.md'))?.dir, root?.dir);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-none-'));
  assert.equal(findRoot(outside), null);
});

test('listNotes honors extensions, ignoreDirs and ignorePaths', () => {
  const root = openRoot(makeBareRoot());
  const notes = listNotes(root);
  assert.ok(notes.includes('projects/alpha.md'));
  assert.ok(notes.includes('inbox/idea.md'));
  assert.ok(!notes.some((n) => n.startsWith('.trash/') || n.startsWith('.obsidian/')));
  assert.deepEqual(notes, [...notes].sort());
  const narrowed = openRoot(makeBareRoot({ ignorePaths: ['notes'] }));
  assert.ok(!listNotes(narrowed).some((n) => n.startsWith('notes/')));
});

test('resolveInRoot accepts relative and absolute paths inside, refuses escapes and the state dir', () => {
  const root = openRoot(makeBareRoot());
  assert.equal(resolveInRoot(root, 'projects/alpha.md').rel, 'projects/alpha.md');
  assert.equal(resolveInRoot(root, path.join(root.dir, 'projects', 'new.md')).rel, 'projects/new.md');
  assert.throws(() => resolveInRoot(root, '../outside.md'), { code: 'PATH_ESCAPES_ROOT' });
  assert.throws(() => resolveInRoot(root, path.join(os.tmpdir(), 'x.md')), { code: 'PATH_ESCAPES_ROOT' });
  assert.throws(() => resolveInRoot(root, `${STATE_DIR}/ledger.jsonl`), { code: 'PATH_IN_STATE_DIR' });
  assert.throws(() => resolveInRoot(root, '.'), { code: 'PATH_ESCAPES_ROOT' });
});

test('a nested root is a boundary: the outer root neither lists nor resolves its notes', () => {
  const dir = makeBareRoot();
  fs.mkdirSync(path.join(dir, 'projects', STATE_DIR));
  const outer = openRoot(dir);
  assert.ok(!listNotes(outer).some((n) => n.startsWith('projects/')));
  assert.throws(() => resolveInRoot(outer, 'projects/alpha.md'), { code: 'PATH_IN_OTHER_ROOT' });
  const inner = findRoot(path.join(dir, 'projects', 'alpha.md'));
  assert.equal(inner?.dir, openRoot(path.join(dir, 'projects')).dir);
  assert.equal(resolveInRoot(/** @type {import('../../src/types.js').Root} */ (inner), 'alpha.md').rel, 'alpha.md');
});

test('isUnder and toSlash', () => {
  assert.equal(toSlash('a\\b\\c'), 'a/b/c');
  assert.equal(isUnder('/x/y/z', '/x/y'), true);
  assert.equal(isUnder('/x/yz', '/x/y'), false);
});

test('config: defaults, partial merge, and invalid values named by key', () => {
  const dir = makeBareRoot();
  const state = path.join(dir, STATE_DIR);
  assert.deepEqual(loadConfig(state), DEFAULTS);
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ embeddings: { provider: 'ollama' } }));
  const merged = loadConfig(state);
  assert.equal(merged.embeddings.provider, 'ollama');
  assert.equal(merged.embeddings.timeoutMs, DEFAULTS.embeddings.timeoutMs);
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ guardLevels: 'two' }));
  assert.throws(() => loadConfig(state), { code: 'CONFIG_INVALID', message: /guardLevels/ });
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ typo: 1 }));
  assert.throws(() => loadConfig(state), { code: 'CONFIG_INVALID', message: /typo/ });
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ wakeUpBudget: 50 }));
  assert.throws(() => loadConfig(state), { code: 'CONFIG_INVALID', message: /wakeUpBudget/ });
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ wakeUpBudget: 4000 }));
  assert.equal(loadConfig(state).wakeUpBudget, 4000);
  fs.writeFileSync(path.join(state, 'config.json'), '{ nope');
  assert.throws(() => loadConfig(state), { code: 'CONFIG_INVALID' });
});
