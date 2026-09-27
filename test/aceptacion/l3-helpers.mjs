// Helpers for the L3 acceptance tests. Owned by the main thread; workers do not edit them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFixture } from '../helpers/fixture.mjs';
import { NAME } from '../../src/name.js';
import { openRoot } from '../../src/root.js';
import { initRoot } from '../../src/store.js';

export const BIN = fileURLToPath(new URL(`../../bin/${NAME}.js`, import.meta.url));
export const HOME_VAR = `${NAME.toUpperCase()}_HOME`;

/** A private registry home for this test process, so no test touches the real one. */
export function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-'));
  process.env[HOME_VAR] = home;
  return home;
}

/** An adopted copy of the invented corpus. */
export async function adoptedRoot() {
  const dir = copyFixture();
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  return openRoot(dir);
}

/**
 * Runs the CLI as a real process. stdin is a pipe (never a TTY).
 * @param {string[]} args
 * @param {{ input?: string, env?: NodeJS.ProcessEnv, cwd?: string }} [opts]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
export function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}
