// TE-5: installing and uninstalling the hooks leaves settings.json byte-identical.
// Written by the main thread BEFORE the batch; workers do not edit it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isolateHome } from './l3-helpers.mjs';
import { hooksStatus, installHooks, uninstallHooks } from '../../src/adapters/claude-code/settings.js';

isolateHome();

// A settings file with the user's own hooks and an unusual indentation, on purpose.
const ORIGINAL = `{
    "model": "opus",
    "hooks": {
        "PreToolUse": [
            { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node user-guard.mjs" } ] }
        ]
    }
}
`;

function tempSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-settings-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, ORIGINAL);
  return file;
}

test('install adds the six entries, keeps the user\'s hooks, backs up the original bytes, and is idempotent', () => {
  const settingsPath = tempSettings();
  const { backupPath } = installHooks({ settingsPath, command: 'node "/opt/tool/bin/cli.js"' });
  assert.ok(backupPath, 'an existing settings file is backed up');
  assert.equal(fs.readFileSync(backupPath, 'utf8'), ORIGINAL);
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const commands = Object.values(s.hooks).flat().flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command));
  assert.ok(commands.includes('node user-guard.mjs'), "the user's hook stays");
  assert.equal(commands.filter((c) => c.includes(' hook ')).length, 6);
  installHooks({ settingsPath, command: 'node "/opt/tool/bin/cli.js"' });
  const again = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const twice = Object.values(again.hooks).flat().flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command));
  assert.equal(twice.filter((c) => c.includes(' hook ')).length, 6, 'installing twice does not duplicate');
  assert.equal(hooksStatus({ settingsPath }).installed, true);
});

test('TE-5: uninstall restores the original file byte for byte', () => {
  const settingsPath = tempSettings();
  installHooks({ settingsPath, command: 'node "/opt/tool/bin/cli.js"' });
  const { identical } = uninstallHooks({ settingsPath });
  assert.equal(identical, true);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), ORIGINAL);
  assert.equal(hooksStatus({ settingsPath }).installed, false);
});

test('if the user changed settings after installing, uninstall removes only our entries and says so', () => {
  const settingsPath = tempSettings();
  installHooks({ settingsPath, command: 'node "/opt/tool/bin/cli.js"' });
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  s.model = 'sonnet';
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  const { identical } = uninstallHooks({ settingsPath });
  assert.equal(identical, false);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(after.model, 'sonnet');
  const commands = Object.values(after.hooks).flat().flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command));
  assert.deepEqual(commands, ['node user-guard.mjs']);
});
