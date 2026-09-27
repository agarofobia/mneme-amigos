// TE-1: guard + ledger p95 < 150 ms per write on a root of 400 notes.
// Written by the main thread BEFORE the batch; workers do not edit it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openRoot } from '../../src/root.js';
import { editNote, initRoot } from '../../src/store.js';

test('TE-1: p95 of 50 edits on a 400-note root is under 150 ms', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-perf-'));
  for (let i = 0; i < 400; i++) {
    const sub = path.join(dir, `area-${i % 20}`);
    fs.mkdirSync(sub, { recursive: true });
    const body = 'alpha beta gamma delta epsilon '.repeat(20);
    fs.writeFileSync(path.join(sub, `note-${i}.md`), `# Note ${i}\n\n## One\n\n${body}\n\n## Two\n\n${body}\n\n## Three\n\n${body}\n`);
  }
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  const root = openRoot(dir);
  /** @type {number[]} */
  const times = [];
  for (let k = 0; k < 50; k++) {
    const i = (k * 7) % 400;
    const rel = `area-${i % 20}/note-${i}.md`;
    const t0 = performance.now();
    const res = await editNote(root, rel, { old: '## Two', new: `## Two\n\nedit ${k}` }, { author: { session: 's', agent: 'cli' }, reason: 'perf' });
    times.push(performance.now() - t0);
    assert.equal(res.ok, true);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95) - 1];
  assert.ok(p95 < 150, `p95 was ${p95.toFixed(1)} ms`);
});
