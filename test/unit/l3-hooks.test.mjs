// Hooks beyond the acceptance tests: ignored folders, a late confirmation, a write whose
// Pre could not predict it, the crowd warning, several roots, and broken payloads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture } from '../helpers/fixture.mjs';
import { handleHook } from '../../src/adapters/claude-code/hooks.js';
import { readLedger } from '../../src/ledger.js';
import { NAME } from '../../src/name.js';
import { homeDir, registerRoot } from '../../src/registry.js';
import { openRoot } from '../../src/root.js';
import { activeSessions, readDenials, touchSession } from '../../src/sessions.js';
import { initRoot, readNote, writeNote } from '../../src/store.js';

process.env[`${NAME.toUpperCase()}_HOME`] = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-'));

async function root() {
  const dir = copyFixture();
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  return openRoot(dir);
}

/** @param {import('../../src/types.js').Root} r */
const errorsOf = (r) => {
  try {
    return fs.readFileSync(path.join(r.stateDir, 'run', 'errors.jsonl'), 'utf8');
  } catch {
    return '';
  }
};

/** @param {string} event @param {string} session @param {object} [extra] */
const ev = (event, session, extra = {}) => ({ hook_event_name: event, session_id: session, cwd: os.tmpdir(), ...extra });

test('a note in an ignored folder of a root is not governed: silence', async () => {
  const r = await root();
  fs.mkdirSync(path.join(r.dir, '.obsidian'), { recursive: true });
  const out = await handleHook(ev('PreToolUse', 's1', { tool_name: 'Write', tool_input: { file_path: path.join(r.dir, '.obsidian', 'x.md'), content: 'x' } }));
  assert.equal(out, null);
  assert.equal(fs.existsSync(path.join(r.stateDir, 'run', 'pending')), false);
});

test('a PostToolUse after a late confirmation is success: nothing is recorded as an error', async () => {
  const r = await root();
  const file = path.join(r.dir, 'manuals/deploy.md');
  const input = { file_path: file, old_string: 'How to ship a release.', new_string: 'How to ship.' };
  assert.equal(await handleHook(ev('PreToolUse', 'late-1', { tool_name: 'Edit', tool_input: input, tool_use_id: 'tu-late' })), null);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(input.old_string, input.new_string));
  await readNote(r, 'manuals/deploy.md'); // another access runs the watcher first
  const late = readLedger(r).entries.at(-1);
  assert.equal(late?.late, true);
  assert.equal(late?.author.session, 'late-1');
  await handleHook(ev('PostToolUse', 'late-1', { tool_name: 'Edit', tool_input: input, tool_use_id: 'tu-late' }));
  assert.equal(errorsOf(r), '');
});

test('a write Pre could not predict is recorded as an error, and lands as external on the next access', async () => {
  const r = await root();
  const file = path.join(r.dir, 'manuals/deploy.md');
  const input = { file_path: file, old_string: 'text that is not there', new_string: 'x' };
  assert.equal(await handleHook(ev('PreToolUse', 'miss-1', { tool_name: 'Edit', tool_input: input, tool_use_id: 'tu-miss' })), null);
  fs.appendFileSync(file, '\nx\n');
  await handleHook(ev('PostToolUse', 'miss-1', { tool_name: 'Edit', tool_input: input, tool_use_id: 'tu-miss' }));
  assert.match(errorsOf(r), /had no prepared write/);
  await readNote(r, 'manuals/deploy.md');
  assert.equal(readLedger(r).entries.at(-1)?.op, 'external');
});

test('a MultiEdit that removes another session\'s section is denied', async () => {
  const r = await root();
  await writeNote(r, 'projects/gamma.md', '# Gamma\n\n## Theirs\n\nx\n', { author: { session: 'owner-1', agent: 'mcp' }, reason: 'c' });
  const out = await handleHook(
    ev('PreToolUse', 'other-2', {
      tool_name: 'MultiEdit',
      tool_input: { file_path: path.join(r.dir, 'projects/gamma.md'), edits: [{ old_string: '## Theirs\n\nx\n', new_string: '' }] },
      tool_use_id: 'tu-me',
    }),
  );
  const spec = /** @type {any} */ (out)?.hookSpecificOutput;
  assert.equal(spec?.permissionDecision, 'deny');
  assert.match(spec?.permissionDecisionReason, /Edit only your own section/);
  assert.match(spec?.permissionDecisionReason, /--session other-2/);
  // The denial keeps what the guard protected and whose: `audit` counts it (contract §4.15).
  const [denial] = readDenials(r);
  assert.deepEqual(denial.sections, [{ key: '## Theirs', owners: ['owner-1'] }]);
  assert.equal(denial.session, 'other-2');
});

test('SessionStart warns when many sessions are active, and SessionEnd takes this one out', async () => {
  const r = await root();
  registerRoot(r.dir);
  for (const s of ['crowd-1', 'crowd-2', 'crowd-3']) touchSession(r, { session: s, agent: 'claude-code' });
  const out = await handleHook(ev('SessionStart', 'crowd-4', { source: 'startup' }));
  const ctx = /** @type {any} */ (out)?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(ctx, /4 sessions are active on these notes\. The others: crowd-1 \(claude-code\), crowd-2/);
  assert.ok(activeSessions(r).some((s) => s.author.session === 'crowd-4'));
  await handleHook(ev('SessionEnd', 'crowd-4'));
  assert.ok(!activeSessions(r).some((s) => s.author.session === 'crowd-4'));
});

test('with several registered roots, each block says which root it is about', async () => {
  const r1 = await root();
  const r2 = await root();
  registerRoot(r1.dir);
  registerRoot(r2.dir);
  for (const r of [r1, r2]) {
    const file = path.join(r.dir, 'manuals/backups.md');
    await handleHook(ev('PostToolUse', 'multi-1', { tool_name: 'Read', tool_input: { file_path: file } }));
    await writeNote(r, 'manuals/backups.md', '# Backups\n\n## Schedule\n\nweekly\n\n## Restore\n\nSame.\n', { author: { session: 'writer-2', agent: 'mcp' }, reason: 'weekly' });
  }
  const out = await handleHook(ev('UserPromptSubmit', 'multi-1', { prompt: 'hi' }));
  const ctx = /** @type {any} */ (out)?.hookSpecificOutput?.additionalContext ?? '';
  assert.ok(ctx.includes(`[${NAME}] Root ${r1.dir}:`));
  assert.ok(ctx.includes(`[${NAME}] Root ${r2.dir}:`));
  assert.equal((ctx.match(/manuals\/backups\.md: edited by session writer-2/g) ?? []).length, 2);
});

test('a broken payload or an event without a session answers nothing and is recorded', async () => {
  assert.equal(await handleHook(null), null);
  assert.equal(await handleHook({ hook_event_name: 'UserPromptSubmit' }), null);
  assert.equal(await handleHook({ hook_event_name: 'Notification', session_id: 'x' }), null);
  const log = fs.readFileSync(path.join(homeDir(), 'errors.jsonl'), 'utf8');
  assert.match(log, /not a JSON object/);
  assert.match(log, /without session_id/);
});
