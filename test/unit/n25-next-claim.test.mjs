// Contracts §4.20: a message to "next" taken by a session that left without answering is
// released, and the next session that asks takes it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { adoptedRoot, isolateHome } from '../aceptacion/l3-helpers.mjs';
import { ackMessage, endSession, messagesFor, sendMessage, touchSession } from '../../src/sessions.js';

isolateHome();

/** @typedef {import('../../src/types.js').Author} Author */
/** @type {Author} */ const X = { session: 'sender-x', agent: 'claude-code' };
/** @type {Author} */ const A = { session: 'taker-a', agent: 'claude-code' };
/** @type {Author} */ const B = { session: 'next-b', agent: 'claude-code' };
/** @type {Author} */ const C = { session: 'third-c', agent: 'claude-code' };

async function taken() {
  const root = await adoptedRoot();
  for (const s of [X, A, B, C]) touchSession(root, s);
  const m = await sendMessage(root, { from: X, to: 'next', body: 'take the migration' });
  assert.equal(messagesFor(root, A.session)[0]?.id, m.id, 'A asks first and takes it');
  return { root, m };
}

test('while the taker is active, the message stays with it even unanswered', async () => {
  const { root } = await taken();
  assert.deepEqual(messagesFor(root, B.session), []);
});

test('the taker left without answering: the next session that asks takes it, once', async () => {
  const { root, m } = await taken();
  endSession(root, A.session);
  assert.equal(messagesFor(root, B.session)[0]?.id, m.id);
  assert.deepEqual(messagesFor(root, C.session), [], 'B has it now, and B is active');
  assert.deepEqual(messagesFor(root, B.session), [], 'delivered once');
  const log = fs.readFileSync(path.join(root.stateDir, 'run', 'messages', 'releases.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.deepEqual({ id: log[0].id, from: log[0].from, to: log[0].to }, { id: m.id, from: A.session, to: B.session });
});

test('an answer with done or rejected keeps it with the taker; seen does not', async () => {
  for (const [status, released] of /** @type {const} */ ([['done', false], ['rejected', false], ['seen', true]])) {
    const { root, m } = await taken();
    await ackMessage(root, { from: A, id: m.id, status });
    endSession(root, A.session);
    assert.equal(messagesFor(root, B.session).some((x) => x.id === m.id), released, status);
  }
});

test('a taker not seen within the activity window counts as gone', async () => {
  const { root, m } = await taken();
  const file = path.join(root.stateDir, 'run', 'sessions', `${A.session}.json`);
  const presence = JSON.parse(fs.readFileSync(file, 'utf8'));
  presence.lastSeen = new Date(Date.now() - (root.config.activeWindowMinutes + 1) * 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(presence));
  assert.equal(messagesFor(root, B.session)[0]?.id, m.id);
});

test('the sender never takes its own message back, even released', async () => {
  const { root } = await taken();
  endSession(root, A.session);
  assert.deepEqual(messagesFor(root, X.session), []);
});

test('four processes race for a released message: exactly one takes it', async () => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const sessionsUrl = pathToFileURL(path.resolve('src/sessions.js')).href;
  const rootUrl = pathToFileURL(path.resolve('src/root.js')).href;
  // Kept small on purpose: node --test runs files in parallel, and a burst of node
  // processes on a small CI runner pushed an older wall-clock test past its limit.
  for (let round = 0; round < 2; round++) {
    const { root, m } = await taken();
    const racers = Array.from({ length: 4 }, (_, i) => ({ session: `racer-${round}-${i}`, agent: /** @type {const} */ ('mcp') }));
    for (const r of racers) touchSession(root, r);
    endSession(root, A.session);
    const code = `const { messagesFor } = await import(${JSON.stringify(sessionsUrl)}); const { openRoot } = await import(${JSON.stringify(rootUrl)});
      const root = openRoot(process.argv[1]); process.stdout.write(String(messagesFor(root, process.argv[2]).filter((x) => x.id === ${JSON.stringify(m.id)}).length));`;
    const got = await Promise.all(
      racers.map(
        (r) =>
          new Promise((resolve) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', code, root.dir, r.session], { stdio: ['ignore', 'pipe', 'inherit'] });
            let out = '';
            child.stdout.on('data', (d) => (out += d));
            child.on('exit', () => resolve(Number(out)));
          }),
      ),
    );
    assert.equal(got.reduce((a, b) => a + /** @type {number} */ (b), 0), 1, `round ${round}: ${got.join(',')}`);
    const log = fs.readFileSync(path.join(root.stateDir, 'run', 'messages', 'releases.jsonl'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1, 'one release recorded');
  }
});
