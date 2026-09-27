// Contracts §4.16: `hooks install --command` — a portable command template, recognized by
// status, uninstall and doctor, with or without this home's install record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ENTRIES, expandCommand, hooksStatus, installHooks, isOurs, uninstallHooks } from '../../src/adapters/claude-code/settings.js';
import { NAME } from '../../src/name.js';

process.env[`${NAME.toUpperCase()}_HOME`] = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-'));

const ORIGINAL = `{
    "model": "opus",
    "hooks": {
        "PreToolUse": [
            { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node user-guard.mjs" } ] }
        ]
    }
}
`;
const WRAPPER = `command -v ${NAME} >/dev/null 2>&1 || exit 0; ${NAME} hook {event}`;

function settingsFile(content = ORIGINAL) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-settings-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, content);
  return file;
}

/** @param {string} file */
const commandsOf = (file) =>
  Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).hooks)
    .flat()
    .flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => String(h.command)));

test('expandCommand: {event} is replaced; without it the event is appended as today', () => {
  assert.equal(expandCommand('node "/x/bin/mneme.js"', 'SessionStart'), 'node "/x/bin/mneme.js" hook SessionStart');
  assert.equal(expandCommand(WRAPPER, 'PreToolUse'), `command -v ${NAME} >/dev/null 2>&1 || exit 0; ${NAME} hook PreToolUse`);
});

test('a template install writes the expanded commands and uninstall restores the file byte for byte (TE-5)', () => {
  const file = settingsFile();
  installHooks({ settingsPath: file, command: WRAPPER });
  const ours = commandsOf(file).filter((c) => c.includes(' hook '));
  assert.equal(ours.length, ENTRIES.length);
  for (const c of ours) assert.match(c, /^command -v mneme >\/dev\/null 2>&1 \|\| exit 0; mneme hook [A-Za-z]+$/);
  const s = hooksStatus({ settingsPath: file });
  assert.equal(s.installed, true);
  assert.equal(s.command, WRAPPER);
  installHooks({ settingsPath: file, command: WRAPPER });
  assert.equal(commandsOf(file).filter((c) => c.includes(' hook ')).length, ENTRIES.length, 'idempotent');
  assert.equal(uninstallHooks({ settingsPath: file }).identical, true);
  assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL);
});

test('switching from the default command to a template replaces every entry and keeps the first backup', () => {
  const file = settingsFile();
  const first = installHooks({ settingsPath: file, command: 'node "/old/bin/mneme.js"' });
  const second = installHooks({ settingsPath: file, command: `${NAME}` });
  assert.equal(second.backupPath, first.backupPath);
  const cmds = commandsOf(file);
  assert.ok(!cmds.some((c) => c.includes('/old/')), 'the absolute path is gone');
  assert.equal(cmds.filter((c) => /^mneme hook [A-Za-z]+$/.test(c)).length, ENTRIES.length);
  assert.equal(uninstallHooks({ settingsPath: file }).identical, true);
  assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL);
});

test('without an install record (another machine), the portable forms are still recognized as ours', () => {
  assert.equal(isOurs('mneme hook PreToolUse', []), true);
  assert.equal(isOurs(`command -v mneme >/dev/null 2>&1 || exit 0; mneme hook SessionEnd`, []), true);
  assert.equal(isOurs('npx mneme hook Read', []), true);
  assert.equal(isOurs('node "F:/x/bin/mneme.js" hook PostToolUse', []), true);
  assert.equal(isOurs('node "/x/bin/mneme.js" hook PostToolUse', []), true);
  assert.equal(isOurs('notmneme hook PreToolUse', []), false, 'a different program that ends in the name');
  assert.equal(isOurs('node user-guard.mjs', []), false);
  assert.equal(isOurs('echo mneme hook X; do-something', []), false);

  // A settings file carried over from another machine: status sees all six, uninstall takes them out.
  const other = settingsFile();
  installHooks({ settingsPath: other, command: WRAPPER });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-'));
  const saved = process.env[`${NAME.toUpperCase()}_HOME`];
  process.env[`${NAME.toUpperCase()}_HOME`] = home; // a home that never installed here
  try {
    assert.equal(hooksStatus({ settingsPath: other }).installed, true);
    uninstallHooks({ settingsPath: other });
    assert.deepEqual(commandsOf(other), ['node user-guard.mjs']);
  } finally {
    process.env[`${NAME.toUpperCase()}_HOME`] = saved;
  }
});

test('an empty template is refused', () => {
  assert.throws(() => installHooks({ settingsPath: settingsFile(), command: '  ' }), TypeError);
});

test('the CLI: hooks install --command writes the template; status sees it; doctor warns when the name is not on the PATH', async () => {
  const { spawnSync } = await import('node:child_process');
  const bin = path.resolve('bin', `${NAME}.js`);
  const env = { ...process.env, [`${NAME.toUpperCase()}_HOME`]: fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-')), PATH: path.dirname(process.execPath) };
  const file = settingsFile();
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
  const inst = run('hooks', 'install', '--settings', file, '--command', WRAPPER);
  assert.equal(inst.status, 0, inst.stderr);
  assert.equal(commandsOf(file).filter((c) => c.endsWith(`${NAME} hook SessionStart`)).length, 1);
  const st = run('hooks', 'status', '--settings', file);
  assert.equal(st.status, 0, st.stdout);
  assert.match(st.stdout, /installed/);
  assert.equal(run('hooks', 'status', '--settings', file, '--command', 'x').status, 2, '--command outside install is a usage error');
  assert.equal(run('hooks', 'install', '--settings', file, '--command', '').status, 2);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-root-'));
  assert.equal(run('init', root).status, 0);
  const doc = run('doctor', '--root', root);
  assert.match(doc.stdout, /warn\s+hooks: .*calls mneme by name, and mneme is not on the PATH/);
  const un = run('hooks', 'uninstall', '--settings', file);
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL);
});

test('the default install still writes node "<absolute path>" hook <Event>', async () => {
  const { spawnSync } = await import('node:child_process');
  const bin = path.resolve('bin', `${NAME}.js`);
  const env = { ...process.env, [`${NAME.toUpperCase()}_HOME`]: fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-')) };
  const file = settingsFile();
  const res = spawnSync(process.execPath, [bin, 'hooks', 'install', '--settings', file], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const ours = commandsOf(file).filter((c) => c.includes(' hook '));
  assert.equal(ours.length, ENTRIES.length);
  for (const c of ours) assert.match(c, /^node "[^"]*bin\/mneme\.js" hook [A-Za-z]+$/);
});
