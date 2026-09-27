// Acceptance, lote C (contracts §4.25 write scope, §4.26 shell authorship; D2-6). Written by the
// main thread BEFORE the lote; the worker does not edit it (objections go in `objeciones_a_tests`).
//   node --test test/aceptacion/pending/c-agentes.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { adoptedRoot, isolateHome, runCli } from '../l3-helpers.mjs';
import { handleHook } from '../../../src/adapters/claude-code/hooks.js';
import { hooksStatus, installHooks, uninstallHooks } from '../../../src/adapters/claude-code/settings.js';
import { audit } from '../../../src/audit.js';
import { readLedger } from '../../../src/ledger.js';
import { STATE_DIR } from '../../../src/name.js';
import { registerRoot } from '../../../src/registry.js';
import { openRoot } from '../../../src/root.js';
import { scanExternal, writeNote } from '../../../src/store.js';

isolateHome();
const DEPLOY = 'manuals/deploy.md';
const OLD = 'How to ship a release.';

/** @param {string} session @param {string} tool @param {object} input @param {string} [id] @param {string} [cwd] */
const ev = (name, session, tool, input, id, cwd = os.tmpdir()) => ({ hook_event_name: name, session_id: session, tool_name: tool, tool_input: input, tool_use_id: id, cwd });
const lastFor = (root, rel) => readLedger(root).entries.filter((e) => e.rel === rel).at(-1);
/** A Claude Code Edit through both hooks, with the tool's own write in the middle. */
async function editThroughHooks(root, session, rel, oldText, newText, id) {
  const file = path.join(root.dir, rel);
  const input = { file_path: file, old_string: oldText, new_string: newText };
  const pre = await handleHook(ev('PreToolUse', session, 'Edit', input, id));
  if (/** @type {any} */ (pre)?.hookSpecificOutput?.permissionDecision === 'deny') return { pre, post: null };
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(oldText, newText));
  const post = await handleHook({ ...ev('PostToolUse', session, 'Edit', input, id), tool_response: {} });
  return { pre, post };
}
/** @param {Awaited<ReturnType<typeof adoptedRoot>>} root @param {object} config */
function withConfig(root, config) {
  fs.writeFileSync(path.join(root.dir, STATE_DIR, 'config.json'), JSON.stringify({ version: 1, ...config }));
  return openRoot(root.dir);
}

// ── §4.25 write scope ─────────────────────────────────────────────────────────

test('warn (default): a write outside the declared scope goes through, is marked, and the model is told after', async () => {
  const root = await adoptedRoot();
  const set = await runCli(['scope', 'set', 'projects', '--session', 'scoped-1', '--root', root.dir]);
  assert.equal(set.code, 0, set.stderr);
  const { pre, post } = await editThroughHooks(root, 'scoped-1', DEPLOY, OLD, 'How to ship it.', 'tu-s1');
  assert.equal(pre, null, 'nothing in PreToolUse: an "allow" there would skip the person\'s own permission prompt');
  const spec = /** @type {any} */ (post)?.hookSpecificOutput;
  assert.equal(spec?.hookEventName, 'PostToolUse');
  assert.match(spec?.additionalContext ?? '', /manuals\/deploy\.md is outside the write scope this session declared \(projects\)/);
  const last = lastFor(root, DEPLOY);
  assert.equal(last?.author.session, 'scoped-1');
  assert.equal(last?.outOfScope, true);
});

test('inside the scope nothing is said and nothing is marked', async () => {
  const root = await adoptedRoot();
  await runCli(['scope', 'set', 'manuals', '--session', 'scoped-2', '--root', root.dir]);
  const { pre, post } = await editThroughHooks(root, 'scoped-2', DEPLOY, OLD, 'How to ship it now.', 'tu-s2');
  assert.equal(pre, null);
  assert.equal(post, null);
  assert.ok(!('outOfScope' in (lastFor(root, DEPLOY) ?? {})));
});

test('without a declared scope nothing changes: no text, no mark', async () => {
  const root = await adoptedRoot();
  const { post } = await editThroughHooks(root, 'free-1', DEPLOY, OLD, 'Ship.', 'tu-f1');
  assert.equal(post, null);
  assert.ok(!('outOfScope' in (lastFor(root, DEPLOY) ?? {})));
});

test('MNEME_SCOPE from the environment counts when there is no scope file; the file wins over it', async () => {
  const root = await adoptedRoot();
  process.env.MNEME_SCOPE = 'projects;notes';
  try {
    const a = await editThroughHooks(root, 'env-1', DEPLOY, OLD, 'Ship A.', 'tu-e1');
    assert.match(/** @type {any} */ (a.post)?.hookSpecificOutput?.additionalContext ?? '', /outside the write scope this session declared \(projects, notes\)/);
    await runCli(['scope', 'set', 'manuals', '--session', 'env-2', '--root', root.dir]);
    const b = await editThroughHooks(root, 'env-2', DEPLOY, 'Ship A.', 'Ship B.', 'tu-e2');
    assert.equal(b.post, null, 'the declared file (manuals) wins over the environment (projects;notes)');
  } finally {
    delete process.env.MNEME_SCOPE;
  }
});

test('deny: PreToolUse stops the write with the way out in the reason; the file is untouched', async () => {
  const root = withConfig(await adoptedRoot(), { scope: { outside: 'deny' } });
  await runCli(['scope', 'set', 'projects', '--session', 'strict-1', '--root', root.dir]);
  const before = fs.readFileSync(path.join(root.dir, DEPLOY), 'utf8');
  const { pre } = await editThroughHooks(root, 'strict-1', DEPLOY, OLD, 'Nope.', 'tu-d1');
  const spec = /** @type {any} */ (pre)?.hookSpecificOutput;
  assert.equal(spec?.permissionDecision, 'deny');
  assert.match(spec?.permissionDecisionReason ?? '', /outside the write scope this session declared \(projects\)/);
  assert.match(spec?.permissionDecisionReason ?? '', /mneme scope clear --session strict-1/);
  assert.equal(fs.readFileSync(path.join(root.dir, DEPLOY), 'utf8'), before);
});

test('the store applies the scope for every door, not only the hooks', async () => {
  const root = await adoptedRoot();
  await runCli(['scope', 'set', 'projects', '--session', 'mcp-1', '--root', root.dir]);
  const res = await writeNote(root, 'notes/new-one.md', '# New\n\nfrom another door\n', { author: { session: 'mcp-1', agent: 'mcp' }, reason: 'test' });
  assert.equal(res.ok, true);
  assert.equal(/** @type {any} */ (res).entry.outOfScope, true);
  const strict = withConfig(root, { scope: { outside: 'deny' } });
  const denied = await writeNote(strict, 'notes/new-two.md', '# Two\n', { author: { session: 'mcp-1', agent: 'mcp' }, reason: 'test' });
  assert.equal(denied.ok, false);
  assert.equal(/** @type {any} */ (denied).outOfScope, true);
  assert.deepEqual(/** @type {any} */ (denied).lost, []);
  assert.equal(fs.existsSync(path.join(root.dir, 'notes/new-two.md')), false);
});

test('scope show and clear; an invalid path is refused and nothing is written', async () => {
  const root = await adoptedRoot();
  await runCli(['scope', 'set', 'projects', 'notes/ideas.md', '--session', 'show-1', '--root', root.dir]);
  const show = await runCli(['scope', 'show', '--session', 'show-1', '--root', root.dir]);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /projects/);
  assert.match(show.stdout, /notes\/ideas\.md/);
  const bad = await runCli(['scope', 'set', '../outside', '--session', 'show-2', '--root', root.dir]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /relative/i);
  const none = await runCli(['scope', 'show', '--session', 'show-2', '--root', root.dir]);
  assert.doesNotMatch(none.stdout, /outside/);
  const clear = await runCli(['scope', 'clear', '--session', 'show-1', '--root', root.dir]);
  assert.equal(clear.code, 0, clear.stderr);
  const after = await runCli(['scope', 'show', '--session', 'show-1', '--root', root.dir]);
  assert.doesNotMatch(after.stdout, /projects/);
});

test('audit lists writes outside the scope, and they are not losses', async () => {
  const root = await adoptedRoot();
  await runCli(['scope', 'set', 'projects', '--session', 'aud-1', '--root', root.dir]);
  await editThroughHooks(root, 'aud-1', DEPLOY, OLD, 'Audited.', 'tu-a1');
  const r = audit(root);
  assert.equal(r.outOfScope.length, 1);
  assert.equal(r.outOfScope[0].rel, DEPLOY);
  assert.equal(r.losses.length, 0);
});

test('an unknown value for scope.outside is rejected with the reason', async () => {
  const root = await adoptedRoot();
  fs.writeFileSync(path.join(root.dir, STATE_DIR, 'config.json'), JSON.stringify({ version: 1, scope: { outside: 'block' } }));
  assert.throws(() => openRoot(root.dir), (e) => /** @type {any} */ (e).code === 'CONFIG_INVALID' && /scope\.outside/.test(/** @type {Error} */ (e).message));
});

// ── §4.26 shell authorship ────────────────────────────────────────────────────

test('a note changed while a Bash command ran is recorded as that session\'s, via shell; one changed before stays external', async () => {
  const root = await adoptedRoot();
  registerRoot(root.dir);
  const before = path.join(root.dir, 'inbox/idea.md');
  fs.appendFileSync(before, '\nchanged before the command\n');
  const oneHourAgo = new Date(Date.now() - 3600e3);
  fs.utimesSync(before, oneHourAgo, oneHourAgo);

  const input = { command: 'cat >> manuals/deploy.md' };
  assert.equal(await handleHook(ev('PreToolUse', 'shell-1', 'Bash', input, 'tu-b1', root.dir)), null);
  fs.appendFileSync(path.join(root.dir, DEPLOY), '\n## Shell part\n\nadded by a shell command\n');
  assert.equal(await handleHook({ ...ev('PostToolUse', 'shell-1', 'Bash', input, 'tu-b1', root.dir), tool_response: {} }), null);

  const last = lastFor(root, DEPLOY);
  assert.equal(last?.author.session, 'shell-1');
  assert.equal(last?.via, 'shell');
  assert.equal(last?.op, 'write');
  assert.ok(last?.changed.includes('## Shell part') || Object.keys(last?.delta ?? {}).includes('## Shell part'));
  assert.ok(!readLedger(root).entries.some((e) => e.rel === 'inbox/idea.md' && e.author.session === 'shell-1'), 'outside the window: not attributed');
  const ext = await scanExternal(root);
  assert.ok(ext.some((e) => e.rel === 'inbox/idea.md' && e.op === 'external'), 'the watcher still records it, without an author');
  assert.equal(audit(root).shell.length, 1);
});

test('without the start mark (PreToolUse did not run) nothing is attributed', async () => {
  const root = await adoptedRoot();
  registerRoot(root.dir);
  fs.appendFileSync(path.join(root.dir, DEPLOY), '\n## Orphan shell part\n\nno start mark\n');
  await handleHook({ ...ev('PostToolUse', 'shell-2', 'Bash', { command: 'x' }, 'tu-b2', root.dir), tool_response: {} });
  assert.ok(!readLedger(root).entries.some((e) => e.author.session === 'shell-2'));
});

test('hooks install --bash adds the two Bash entries; a plain install removes them; uninstall leaves the file byte for byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-settings-'));
  const settingsPath = path.join(dir, 'settings.json');
  const ORIGINAL = '{\n  "model": "x"\n}\n';
  fs.writeFileSync(settingsPath, ORIGINAL);
  const command = 'node "/opt/tool/bin/cli.js"';
  installHooks({ settingsPath, command, shell: true });
  const on = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const bashGroups = (event) => (on.hooks[event] ?? []).filter((g) => g.matcher === 'Bash');
  assert.equal(bashGroups('PreToolUse').length, 1);
  assert.equal(bashGroups('PostToolUse').length, 1);
  assert.equal(hooksStatus({ settingsPath }).shell, true);
  assert.equal(hooksStatus({ settingsPath }).installed, true);
  installHooks({ settingsPath, command });
  const off = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.ok(!Object.values(off.hooks).flat().some((g) => g.matcher === 'Bash'));
  assert.equal(hooksStatus({ settingsPath }).shell, false);
  installHooks({ settingsPath, command, shell: true });
  uninstallHooks({ settingsPath });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), ORIGINAL);
});
