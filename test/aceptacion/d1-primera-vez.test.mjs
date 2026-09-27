// D-1 · the first run of the README, in order, from outside the notes folder (map §⑤: init →
// hooks install → doctor → search, with no `cd`). The M5 rehearsal on a clean profile found
// that doctor and search looked only at the current directory and failed right after init.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HOME_VAR, runCli } from './l3-helpers.mjs';

test('D-1: right after init, doctor, status and search work from any directory, on the registered root', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-d1-home-'));
  const notes = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-d1-notes-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-d1-cwd-'));
  fs.writeFileSync(path.join(notes, 'rollback.md'), '# Rollback procedure\n\nRedeploy the previous build tag and clear the cache.\n');
  const env = { [HOME_VAR]: home };

  const init = await runCli(['init', notes, '--adopt'], { env, cwd: elsewhere });
  assert.equal(init.code, 0, init.stderr);

  const doctor = await runCli(['doctor'], { env, cwd: elsewhere });
  assert.match(doctor.stdout, /^ok\s+root:/m, `${doctor.stdout}\n${doctor.stderr}`);
  assert.doesNotMatch(doctor.stderr, /No governed root/);

  const status = await runCli(['status'], { env, cwd: elsewhere });
  assert.equal(status.code, 0, status.stderr);

  const search = await runCli(['search', 'rollback procedure', '--reader', 'lexical'], { env, cwd: elsewhere });
  assert.equal(search.code, 0, search.stderr);
  assert.match(search.stdout, /rollback\.md/);

  // Outside any root and with nothing registered, the error still says what to do.
  const bare = await runCli(['search', 'rollback'], { env: { [HOME_VAR]: fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-d1-empty-')) }, cwd: elsewhere });
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /mneme init/);
});
