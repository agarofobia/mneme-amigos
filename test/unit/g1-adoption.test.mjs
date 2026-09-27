// What is done and what comes next (§4.31): the pure decision over every state, the facts over a
// real root in a temporary folder, and `doctor` as a real process on a workspace install.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOME_VAR, adoptedRoot, isolateHome, runCli } from '../aceptacion/l3-helpers.mjs';
import { copyFixture } from '../helpers/fixture.mjs';
import { WELCOME_NOTE, adoptionFacts, adoptionSteps } from '../../src/adoption.js';
import { NAME } from '../../src/name.js';
import { endSession, noticesFor, recordRead, touchSession } from '../../src/sessions.js';
import { writeNote } from '../../src/store.js';
import { USAGE_ENV, searchesFile } from '../../src/usage.js';

isolateHome();
delete process.env[USAGE_ENV];

/** @typedef {import('../../src/adoption.js').AdoptionFacts} AdoptionFacts */

/** Nothing done yet. @type {AdoptionFacts} */
const NOTHING = { hooksAt: null, ownNotes: 0, aiSessions: 0, aiWriters: 0, aiWrites: 0, searchesWithHits: 0 };
/** Everything done. @type {AdoptionFacts} */
const ALL = { hooksAt: 'C:/ws/.claude/settings.json', ownNotes: 3, aiSessions: 2, aiWriters: 2, aiWrites: 5, searchesWithHits: 4 };
const WHERE = { notesDir: 'C:/ws/notas', openIn: 'C:/ws' };

/** @param {ReturnType<typeof adoptionSteps>} r */
const statuses = (r) => Object.fromEntries(r.steps.map((s) => [s.id, s.status]));

test('the steps go in order and next is the first one not done', () => {
  // Each row adds one fact; next moves to the step after it.
  /** @type {Array<[Partial<AdoptionFacts>, RegExp]>} */
  const rows = [
    [{}, /hooks install/],
    [{ hooksAt: ALL.hooksAt }, /add a note of your own to C:\/ws\/notas/],
    [{ ownNotes: 1 }, /open Claude Code in C:\/ws and ask it/],
    [{ aiSessions: 1 }, /search "<words from one of your notes>"/],
    [{ searchesWithHits: 1 }, /history "<that note>"/],
    [{ aiWrites: 1, aiWriters: 1 }, /second Claude Code window in C:\/ws/],
    [{ aiWriters: 2 }, new RegExp(`^nothing missing\\. .*${NAME} report`)],
  ];
  /** @type {AdoptionFacts} */
  let facts = { ...NOTHING };
  for (const [add, next] of rows) {
    facts = { ...facts, ...add };
    const r = adoptionSteps(facts, WHERE);
    assert.match(r.next, next, JSON.stringify(facts));
  }
});

test('with nothing done every step is todo; with everything done every step is done', () => {
  assert.deepEqual(Object.values(statuses(adoptionSteps(NOTHING, WHERE))), ['todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
  const all = adoptionSteps(ALL, WHERE);
  assert.deepEqual(Object.values(statuses(all)), ['done', 'done', 'done', 'done', 'done', 'done']);
  assert.match(all.steps[1].detail, /^3 notes of your own$/);
  assert.match(all.steps[2].detail, /^2 AI sessions have been opened here$/);
});

test('a search log that is off is n/a, never missing, and does not hold the next step', () => {
  const facts = { ...NOTHING, hooksAt: ALL.hooksAt, ownNotes: 1, aiSessions: 1, searchesWithHits: null };
  const r = adoptionSteps(facts, WHERE);
  assert.equal(statuses(r).search, 'n/a');
  assert.match(r.steps[3].detail, new RegExp(`${USAGE_ENV}=0`));
  assert.match(r.next, /add something to one of your notes/);
});

test('a failed health check comes before any step', () => {
  const r = adoptionSteps(NOTHING, { ...WHERE, firstFail: 'ledger' });
  assert.equal(r.next, 'fix "ledger" first (its line is above)');
  assert.equal(adoptionSteps(ALL, { ...WHERE, firstFail: 'objects' }).next, 'fix "objects" first (its line is above)');
});

test('one writer is not "together", whatever the number of sessions', () => {
  const r = adoptionSteps({ ...ALL, aiSessions: 2, aiWriters: 1 }, WHERE);
  assert.equal(statuses(r).together, 'todo');
  assert.equal(r.steps[5].detail, 'one AI session has written here so far');
});

test('facts: an adopted root has its own notes and no AI session yet', async () => {
  const root = await adoptedRoot();
  const facts = adoptionFacts(root, { hooksAt: null });
  assert.ok(facts.ownNotes > 0);
  assert.deepEqual({ ...facts, ownNotes: 0 }, { hooksAt: null, ownNotes: 0, aiSessions: 0, aiWriters: 0, aiWrites: 0, searchesWithHits: 0 });
});

test('facts: the welcome note at the top of the root is not the person\'s own', async () => {
  const root = await adoptedRoot();
  const before = adoptionFacts(root, { hooksAt: null }).ownNotes;
  fs.writeFileSync(path.join(root.dir, WELCOME_NOTE), '# Welcome\n\n## How to start\n\nText.\n');
  assert.equal(adoptionFacts(root, { hooksAt: null }).ownNotes, before);
  fs.mkdirSync(path.join(root.dir, 'mine'), { recursive: true });
  fs.writeFileSync(path.join(root.dir, 'mine', WELCOME_NOTE), '# Mine\n\n## A section\n\nText.\n');
  assert.equal(adoptionFacts(root, { hooksAt: null }).ownNotes, before + 1);
});

test('facts: one Claude Code window and its MCP server are two sessions but not two writers', async () => {
  const root = await adoptedRoot();
  // The window reads through its hooks; its read-only MCP server has another id.
  recordRead(root, '11111111-2222-3333-4444-555555555555', 'projects/alpha.md', 'a'.repeat(64));
  touchSession(root, { session: 'mcp-0a1b2c3d', agent: 'mcp' });
  let facts = adoptionFacts(root, { hooksAt: null });
  assert.equal(facts.aiSessions, 2);
  assert.equal(facts.aiWriters, 0);
  // The window writes: one writer.
  await writeNote(root, 'projects/new.md', '# New\n\n## A\n\nText.\n', { author: { session: '11111111-2222-3333-4444-555555555555', agent: 'claude-code' } });
  facts = adoptionFacts(root, { hooksAt: null });
  assert.equal(facts.aiWrites, 1);
  assert.equal(facts.aiWriters, 1);
  assert.equal(facts.aiSessions, 2);
  // A second window writes: together.
  await writeNote(root, 'projects/other.md', '# Other\n\n## B\n\nText.\n', { author: { session: '66666666-7777-8888-9999-000000000000', agent: 'claude-code' } });
  facts = adoptionFacts(root, { hooksAt: null });
  assert.equal(facts.aiWriters, 2);
  assert.equal(facts.aiSessions, 3);
});

test('facts: a session that only talked (told about changes, then ended) was opened here', async () => {
  // Measured 25/09: three real Claude Code sessions ran doctor and read no note; the step said
  // "no AI session yet". What they leave is the notice cursor and the ended mark.
  const root = await adoptedRoot();
  noticesFor(root, 'aaaaaaaa-0000-0000-0000-000000000001');
  endSession(root, 'aaaaaaaa-0000-0000-0000-000000000001');
  endSession(root, 'aaaaaaaa-0000-0000-0000-000000000002');
  const facts = adoptionFacts(root, { hooksAt: null });
  assert.deepEqual([facts.aiSessions, facts.aiWriters, facts.aiWrites], [2, 0, 0]);
});

test('facts: the person at the CLI is not an AI session', async () => {
  const root = await adoptedRoot();
  await writeNote(root, 'projects/cli.md', '# Cli\n\n## A\n\nText.\n', { author: { session: 'cli-person', agent: 'cli' } });
  const facts = adoptionFacts(root, { hooksAt: null });
  assert.deepEqual([facts.aiSessions, facts.aiWrites, facts.aiWriters], [0, 0, 0]);
});

test('facts: searches that found something are counted, and the off switch makes it null', async () => {
  const root = await adoptedRoot();
  fs.mkdirSync(path.dirname(searchesFile()), { recursive: true });
  /** @param {number} hits */
  const line = (hits) => JSON.stringify({ ts: new Date().toISOString(), via: 'mcp', reader: 'lexical', k: 5, hits, session: false, degraded: false, ms: 3, roots: 1 });
  fs.writeFileSync(searchesFile(), `${line(0)}\n${line(2)}\n${line(1)}\n`);
  assert.equal(adoptionFacts(root, { hooksAt: null }).searchesWithHits, 2);
  assert.equal(adoptionFacts(root, { hooksAt: null, env: { [USAGE_ENV]: '0' } }).searchesWithHits, null);
  fs.rmSync(searchesFile());
});

test('bin/mneme, the twin of mneme.cmd for Git Bash, has no CR and runs from sh', (t) => {
  const shim = fileURLToPath(new URL(`../../bin/${NAME}`, import.meta.url));
  const text = fs.readFileSync(shim, 'utf8');
  assert.ok(text.startsWith('#!/bin/sh\n'), 'a shebang line');
  assert.ok(!text.includes('\r'), 'a CR after #!/bin/sh makes "bad interpreter"');
  const sh = spawnSync('sh', [shim, '--help'], { encoding: 'utf8' });
  if (sh.error) return t.skip(`no sh here (${sh.error.message})`);
  assert.equal(sh.status, 0, sh.stderr);
  assert.match(sh.stdout, new RegExp(`usage: ${NAME} `));
});

test('doctor on a workspace install says what is next, in the workspace, without changing its exit code', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-g1-'));
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-claude-g1-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-ws-g1-'));
  const env = { [HOME_VAR]: home, CLAUDE_CONFIG_DIR: claudeDir };
  const dir = copyFixture();
  assert.equal((await runCli(['init', dir, '--adopt'], { env })).code, 0);

  // Before the hooks: the first step.
  const bare = await runCli(['doctor', '--root', dir], { env });
  assert.equal(bare.code, 0, bare.stdout + bare.stderr);
  assert.match(bare.stdout, /^adoption:$/m);
  assert.match(bare.stdout, /^ {2}todo\s+hooks: /m);
  assert.match(bare.stdout, new RegExp(`^next: install the hooks: ${NAME} hooks install`, 'm'));

  // Hooks in the workspace: the next step names the workspace, not the notes folder.
  const settings = path.join(ws, '.claude', 'settings.json');
  const inst = await runCli(['hooks', 'install', '--settings', settings], { env });
  assert.equal(inst.code, 0, inst.stdout + inst.stderr);
  const after = await runCli(['doctor', '--root', dir], { env });
  assert.equal(after.code, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /^ {2}done\s+hooks: installed in /m);
  assert.match(after.stdout, /^ {2}done\s+notes: \d+ notes of your own$/m);
  const next = after.stdout.split('\n').find((l) => l.startsWith('next: '));
  assert.ok(next?.startsWith('next: open Claude Code in '), next);
  assert.ok(next?.includes(path.basename(ws)), `${next} should name the workspace ${ws}`);
  assert.ok(!next?.includes(path.basename(dir)), `${next} should not name the notes folder`);
  // The global settings file of this test was never written.
  assert.equal(fs.existsSync(path.join(claudeDir, 'settings.json')), false);
});
