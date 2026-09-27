// Test helpers owned by the main thread (L0). Workers read them; they never edit them.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../../src/name.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/notes/', import.meta.url));

/** A fresh temporary copy of the invented corpus. Never a real folder. */
export function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-test-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * A root created WITHOUT the core (L1): copy of the corpus + an empty state directory,
 * optionally with a config.json. Lets the readers (L2) be tested in parallel with L1.
 * @param {object} [config]
 */
export function makeBareRoot(config) {
  const dir = copyFixture();
  fs.mkdirSync(path.join(dir, STATE_DIR));
  if (config) fs.writeFileSync(path.join(dir, STATE_DIR, 'config.json'), JSON.stringify(config));
  return dir;
}

/** @param {string} text */
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * sha256 of every file under `dir`, outside the state directory.
 * @param {string} dir
 * @returns {Map<string, string>}
 */
export function snapshot(dir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @param {string} rel */
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== STATE_DIR) walk(r);
      } else out.set(r, sha256(fs.readFileSync(path.join(dir, r), 'utf8')));
    }
  };
  walk('');
  return out;
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
