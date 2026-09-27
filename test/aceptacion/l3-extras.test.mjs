// I-10..I-13 (ideas taken from MemPalace, accepted 24/09): messages between sessions,
// wake-up, scope through the doors, eval from the CLI. Written by the main thread BEFORE L3.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BIN, HOME_VAR, adoptedRoot, isolateHome, runCli } from './l3-helpers.mjs';
import { STATE_DIR } from '../../src/name.js';
import { handleHook } from '../../src/adapters/claude-code/hooks.js';
import { registerRoot } from '../../src/registry.js';
import { ackMessage, messagesFor, sendMessage, touchSession } from '../../src/sessions.js';

const home = isolateHome();
/** @type {import('../../src/types.js').Author} */ const A = { session: 'aaaaaaaa-1', agent: 'claude-code' };
/** @type {import('../../src/types.js').Author} */ const B = { session: 'bbbbbbbb-2', agent: 'claude-code' };
/** @type {import('../../src/types.js').Author} */ const C = { session: 'cccccccc-3', agent: 'mcp' };

test('I-12: a message reaches its session once, and the reply keeps the correlation', async () => {
  const root = await adoptedRoot();
  const sent = await sendMessage(root, { from: A, to: B.session, body: 'I am rewriting ## Plan in alpha; hold off' });
  const got = messagesFor(root, B.session);
  assert.equal(got.length, 1);
  assert.equal(got[0].body, 'I am rewriting ## Plan in alpha; hold off');
  assert.equal(messagesFor(root, B.session).length, 0, 'delivered once');
  assert.equal(messagesFor(root, C.session).length, 0, 'not for C');
  await ackMessage(root, { from: B, id: sent.id, status: 'done', body: 'ok, waiting' });
  const reply = messagesFor(root, A.session);
  assert.equal(reply.length, 1);
  assert.equal(reply[0].replyTo, sent.id);
  assert.equal(reply[0].correlation, sent.correlation);
});

test('I-12: broadcast skips the sender; "next" goes to the first session that asks, once; bodies are capped', async () => {
  const root = await adoptedRoot();
  touchSession(root, A);
  touchSession(root, B);
  touchSession(root, C);
  await sendMessage(root, { from: A, to: '*', body: 'heads up: backups manual is being rewritten' });
  assert.equal(messagesFor(root, A.session).length, 0, 'the sender does not get its own broadcast');
  assert.equal(messagesFor(root, B.session).length, 1);
  assert.equal(messagesFor(root, C.session).length, 1);
  await sendMessage(root, { from: A, to: 'next', body: 'whoever comes next: finish the canary section' });
  assert.equal(messagesFor(root, B.session).length, 1);
  assert.equal(messagesFor(root, C.session).length, 0, '"next" is taken once');
  await assert.rejects(sendMessage(root, { from: A, to: B.session, body: 'x'.repeat(64 * 1024 + 1) }), RangeError);
});

test('I-12: UserPromptSubmit delivers messages next to the notices', async () => {
  const root = await adoptedRoot();
  registerRoot(root.dir);
  await sendMessage(root, { from: A, to: 'reader-7', body: 'check the deploy manual before shipping' });
  const out = await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'reader-7', prompt: 'hi', cwd: os.tmpdir() });
  const ctx = /** @type {any} */ (out)?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(ctx, /Messages for you:/);
  assert.match(ctx, /check the deploy manual before shipping/);
});

test('I-11: with a wake-up budget, SessionStart brings the CAG bundle', async () => {
  const root = await adoptedRoot();
  const cfgPath = path.join(root.stateDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, wakeUpBudget: 3000 }));
  registerRoot(root.dir);
  const out = await handleHook({ hook_event_name: 'SessionStart', session_id: 'waker-1', source: 'startup', cwd: os.tmpdir() });
  const ctx = /** @type {any} */ (out)?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(ctx, /# Glossary/, 'the pinned note comes in');
  const cli = await runCli(['wake-up', '--budget', '1500'], { env: { [HOME_VAR]: home }, cwd: root.dir });
  assert.equal(cli.code, 0, cli.stderr);
  assert.ok(Buffer.byteLength(cli.stdout, 'utf8') <= 1500 + 200, 'the CLI respects the budget (plus a header line)');
});

test('I-10: search through MCP honors scope', async () => {
  const root = await adoptedRoot();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp', '--root', root.dir],
    env: { ...(/** @type {Record<string, string>} */ (process.env)), [HOME_VAR]: home },
  });
  const client = new Client({ name: 'acceptance-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'search', arguments: { query: 'plan', scope: ['projects'], k: 10 } });
    const text = /** @type {any} */ (res).content.map((/** @type {any} */ c) => c.text).join('\n');
    assert.match(text, /projects\//);
    assert.doesNotMatch(text, /notes\/old-plan\.md/);
  } finally {
    // A failed assertion must fail the file, not hang it on the open MCP child.
    await client.close();
  }
});

test('I-13: eval from the CLI reports dev and holdout apart and writes one result per case', async () => {
  const root = await adoptedRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-eval-'));
  const casesFile = path.join(dir, 'cases.json');
  const resultsFile = path.join(dir, 'results.jsonl');
  fs.writeFileSync(casesFile, JSON.stringify([
    { query: 'rollback procedure', want: ['manuals/deploy'] },
    { query: 'snapshot schedule', want: ['manuals/backups'], split: 'holdout' },
  ]));
  const res = await runCli(['eval', casesFile, '--reader', 'lexical', '--results', resultsFile], { env: { [HOME_VAR]: home }, cwd: root.dir });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /holdout/);
  const lines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).split, 'holdout');
  assert.ok(fs.existsSync(path.join(root.dir, STATE_DIR, '.gitattributes')), 'init wrote the state .gitattributes');
});
