// CA-2 through the Claude Code hooks: the API and the real CLI process (door ③).
// Written by the main thread BEFORE the batch; workers do not edit it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HOME_VAR, adoptedRoot, isolateHome, runCli } from './l3-helpers.mjs';
import { handleHook } from '../../src/adapters/claude-code/hooks.js';
import { readLedger } from '../../src/ledger.js';
import { registerRoot } from '../../src/registry.js';
import { writeNote } from '../../src/store.js';

const home = isolateHome();
const GAMMA = 'projects/gamma.md';
const WITH_A = "# Gamma\n\n## A's part\n\nby A\n";

/** @param {string} session @param {string} tool @param {object} input @param {string} [id] */
const pre = (session, tool, input, id) => ({ hook_event_name: 'PreToolUse', session_id: session, tool_name: tool, tool_input: input, tool_use_id: id, cwd: os.tmpdir() });

test('PreToolUse denies a Write that removes another session\'s section, with the fix in the reason', async () => {
  const root = await adoptedRoot();
  await writeNote(root, GAMMA, WITH_A, { author: { session: 'session-a', agent: 'claude-code' }, reason: 'create' });
  const file = path.join(root.dir, GAMMA);
  const out = await handleHook(pre('session-b', 'Write', { file_path: file, content: '# Gamma\n' }, 'tu-1'));
  const spec = /** @type {any} */ (out)?.hookSpecificOutput;
  assert.equal(spec?.permissionDecision, 'deny');
  assert.match(spec?.permissionDecisionReason, /removes sections written by another session/);
  assert.match(spec?.permissionDecisionReason, /A Write replaces the whole file/);
  assert.match(spec?.permissionDecisionReason, /allow ".*gamma\.md" --session/);
  assert.equal(fs.readFileSync(file, 'utf8'), WITH_A);
});

test('an allowed Edit goes through Pre, the tool, and Post, and lands in the ledger as that session', async () => {
  const root = await adoptedRoot();
  const file = path.join(root.dir, 'manuals/deploy.md');
  const input = { file_path: file, old_string: 'How to ship a release.', new_string: 'How to ship a release safely.' };
  assert.equal(await handleHook(pre('session-c', 'Edit', input, 'tu-2')), null);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(input.old_string, input.new_string)); // the tool
  await handleHook({ ...pre('session-c', 'Edit', input, 'tu-2'), hook_event_name: 'PostToolUse', tool_response: {} });
  const last = readLedger(root).entries.filter((e) => e.rel === 'manuals/deploy.md').at(-1);
  assert.equal(last?.op, 'edit');
  assert.equal(last?.author.session, 'session-c');
  assert.equal(last?.author.agent, 'claude-code');
});

test('without tool_use_id, Pre and Post agree on the pending key', async () => {
  const root = await adoptedRoot();
  const file = path.join(root.dir, 'manuals/deploy.md');
  const input = { file_path: file, old_string: 'How to ship a release.', new_string: 'How to ship.' };
  assert.equal(await handleHook(pre('session-d', 'Edit', input)), null);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(input.old_string, input.new_string));
  await handleHook({ ...pre('session-d', 'Edit', input), hook_event_name: 'PostToolUse', tool_response: {} });
  const last = readLedger(root).entries.filter((e) => e.rel === 'manuals/deploy.md').at(-1);
  assert.equal(last?.author.session, 'session-d');
  assert.notEqual(last?.late, true);
});

test('a file outside any root is none of our business: no output', async () => {
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-free-')), 'free.md');
  assert.equal(await handleHook(pre('s', 'Write', { file_path: outside, content: 'x' })), null);
});

test('UserPromptSubmit delivers the notices of every registered root', async () => {
  const root = await adoptedRoot();
  registerRoot(root.dir);
  const file = path.join(root.dir, 'manuals/backups.md');
  await handleHook({ hook_event_name: 'PostToolUse', session_id: 'reader-1', tool_name: 'Read', tool_input: { file_path: file }, cwd: os.tmpdir() });
  await writeNote(root, 'manuals/backups.md', '# Backups\n\n## Schedule\n\nChanged by someone else.\n\n## Restore\n\nSame.\n', { author: { session: 'writer-9', agent: 'mcp' }, reason: 'rewrite' });
  const out = await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'reader-1', prompt: 'hi', cwd: os.tmpdir() });
  assert.match(/** @type {any} */ (out)?.hookSpecificOutput?.additionalContext ?? '', /manuals\/backups\.md: edited by session writer-9/);
});

test('door ③: the real CLI hook process denies with JSON on stdout and always exits 0', async () => {
  const root = await adoptedRoot();
  await writeNote(root, GAMMA, WITH_A, { author: { session: 'session-a', agent: 'claude-code' }, reason: 'create' });
  const event = pre('session-b', 'Write', { file_path: path.join(root.dir, GAMMA), content: '# Gamma\n' }, 'tu-9');
  const res = await runCli(['hook', 'PreToolUse'], { input: JSON.stringify(event), env: { [HOME_VAR]: home } });
  assert.equal(res.code, 0);
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const broken = await runCli(['hook', 'PreToolUse'], { input: '{ not json', env: { [HOME_VAR]: home } });
  assert.equal(broken.code, 0, 'a broken payload never blocks the agent');
  assert.equal(broken.stdout.trim(), '');
});
