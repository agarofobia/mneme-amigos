// The registry of roots and the settings edge cases TE-5 does not reach.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hooksStatus, installHooks, uninstallHooks } from '../../src/adapters/claude-code/settings.js';
import { lineDiff } from '../../src/adapters/cli/main.js';
import { NAME, STATE_DIR } from '../../src/name.js';
import { listRegisteredRoots, registerRoot, registeredRoots, rootsFile, unregisterRoot } from '../../src/registry.js';

process.env[`${NAME.toUpperCase()}_HOME`] = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-'));

/** A directory that looks like a root (the registry only needs the state directory). */
function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-reg-'));
  fs.mkdirSync(path.join(dir, STATE_DIR));
  return dir;
}

test('register is idempotent, unregister takes it out, a vanished root is reported as missing', () => {
  const a = fakeRoot();
  const b = fakeRoot();
  assert.equal(registerRoot(a).added, true);
  assert.equal(registerRoot(a).added, false);
  registerRoot(b);
  assert.equal(listRegisteredRoots().length, 2);
  fs.rmSync(b, { recursive: true, force: true });
  const { roots, missing } = registeredRoots();
  assert.equal(roots.length, 1);
  assert.equal(missing.length, 1);
  assert.equal(unregisterRoot(b), true);
  assert.equal(unregisterRoot(b), false);
  assert.equal(listRegisteredRoots().length, 1);
});

test('a broken registry file is an error that says which file and what to do', () => {
  const saved = fs.readFileSync(rootsFile(), 'utf8');
  fs.writeFileSync(rootsFile(), '{ nope');
  assert.throws(() => listRegisteredRoots(), /roots\.json is not valid JSON .*Fix it, or delete it/);
  fs.writeFileSync(rootsFile(), saved);
});

/** @param {string} [content] */
function settingsFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-settings-'));
  const file = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

test('a settings file the install created is removed by the uninstall', () => {
  const file = settingsFile();
  const res = installHooks({ settingsPath: file, command: 'node "/x/bin/tool.js"' });
  assert.equal(res.backupPath, null);
  assert.equal(hooksStatus({ settingsPath: file }).installed, true);
  assert.equal(uninstallHooks({ settingsPath: file }).identical, true);
  assert.equal(fs.existsSync(file), false);
});

test('reinstalling from a moved checkout replaces our commands and keeps the first backup', () => {
  const original = '{ "model": "opus" }\n';
  const file = settingsFile(original);
  const first = installHooks({ settingsPath: file, command: 'node "/old/bin/tool.js"' });
  const second = installHooks({ settingsPath: file, command: 'node "/new/bin/tool.js"' });
  assert.equal(second.backupPath, first.backupPath);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('/old/'), 'the old command is gone');
  assert.equal((text.match(/\/new\/bin\/tool\.js\\" hook /g) ?? []).length, 6);
  assert.equal(uninstallHooks({ settingsPath: file }).identical, true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('empty hook containers in the original come back byte for byte (found by the Windows installer run)', () => {
  // `"hooks": {}` and `"PreToolUse": []` mean "no hooks"; the uninstall used to prune them
  // away, miss the backup, and report the file as changed by the user when nobody touched it.
  for (const original of ['{\n  "model": "x",\n  "hooks": {}\n}\n', '{\n  "hooks": {\n    "PreToolUse": []\n  }\n}\n']) {
    const file = settingsFile(original);
    installHooks({ settingsPath: file, command: 'node "/x/bin/tool.js"' });
    assert.equal(uninstallHooks({ settingsPath: file }).identical, true, original);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('a real change after the install is kept, and not reported as identical', () => {
  const file = settingsFile('{\n  "model": "x",\n  "hooks": {}\n}\n');
  installHooks({ settingsPath: file, command: 'node "/x/bin/tool.js"' });
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...now, model: 'y' }, null, 2));
  assert.equal(uninstallHooks({ settingsPath: file }).identical, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'y');
});

test('a settings file that is not JSON is refused and left alone', () => {
  const file = settingsFile('{ "model": ');
  assert.throws(() => installHooks({ settingsPath: file, command: 'node "/x/bin/tool.js"' }), /not valid JSON.*nothing was changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "model": ');
});

test('lineDiff marks added and removed lines with context', () => {
  const diff = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual(diff.split('\n'), ['  a', '+ B', '- b', '  c', '+ d']);
});
