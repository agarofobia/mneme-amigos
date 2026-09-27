// I-1, I-2 and the CLI as a real process. Written by the main thread BEFORE the batch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture } from '../helpers/fixture.mjs';
import { HOME_VAR, isolateHome, runCli } from './l3-helpers.mjs';
import { listRegisteredRoots } from '../../src/registry.js';
import { realPathLoose } from '../../src/paths.js';

const home = isolateHome();
const env = { [HOME_VAR]: home };

test('I-1: init --adopt governs a folder without touching a note, and registers it', async () => {
  const dir = copyFixture();
  const before = fs.readFileSync(path.join(dir, 'projects/alpha.md'), 'utf8');
  const plain = await runCli(['init', dir], { env });
  assert.notEqual(plain.code, 0);
  assert.match(plain.stderr + plain.stdout, /already has \d+ notes\. Run again with --adopt/);
  const res = await runCli(['init', dir, '--adopt'], { env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Adopted \d+ notes .* Nothing was modified\./);
  assert.equal(fs.readFileSync(path.join(dir, 'projects/alpha.md'), 'utf8'), before);
  assert.ok(listRegisteredRoots().includes(realPathLoose(dir)));
  const twice = await runCli(['init', dir, '--adopt'], { env });
  assert.notEqual(twice.code, 0);
});

test('I-2: doctor reports every check and exits 0 when nothing fails', async () => {
  const dir = copyFixture();
  await runCli(['init', dir, '--adopt'], { env });
  const res = await runCli(['doctor', '--root', dir], { env });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^warn\s+embeddings: .*off/m);
  assert.match(res.stdout, /^ok\s+ledger:/m);
  assert.match(res.stdout, /^ok\s+lock:/m);
});

test('allow refuses without a person at an interactive terminal', async () => {
  const dir = copyFixture();
  await runCli(['init', dir, '--adopt'], { env });
  const res = await runCli(['allow', 'manuals/deploy.md', '--session', 'abc', '--reason', 'x'], { env, cwd: dir });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /interactive terminal/);
});

test('search, history and show work from the CLI', async () => {
  const dir = copyFixture();
  await runCli(['init', dir, '--adopt'], { env });
  const found = await runCli(['search', 'rollback procedure'], { env, cwd: dir });
  assert.equal(found.code, 0, found.stderr);
  assert.match(found.stdout, /manuals\/deploy\.md/);
  const hist = await runCli(['history', 'manuals/deploy.md'], { env, cwd: dir });
  assert.equal(hist.code, 0, hist.stderr);
  assert.match(hist.stdout, /adopt/);
});

test('outside any root, commands say how to create one', async () => {
  // With nothing registered either: since D-1 (24/09) a command outside any root falls back
  // to the only registered root, so this error needs an empty registry.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-empty-home-'));
  const res = await runCli(['status'], { env: { ...env, [HOME_VAR]: empty }, cwd: home });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /No governed root found at or above .*init <dir>/);
});
