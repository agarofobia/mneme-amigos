// CA-3 and the owner notices (rebote R-3). Written by the main thread BEFORE the batch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { adoptedRoot, isolateHome } from './l3-helpers.mjs';
import { NAME } from '../../src/name.js';
import { activeSessions, formatNotices, noticesFor, recordRead, touchSession } from '../../src/sessions.js';
import { editNote, readNote, scanExternal, writeNote } from '../../src/store.js';

isolateHome();
/** @type {import('../../src/types.js').Author} */ const A = { session: 'aaaaaaaa-1111', agent: 'claude-code' };
/** @type {import('../../src/types.js').Author} */ const B = { session: 'bbbbbbbb-2222', agent: 'claude-code' };

test('CA-3: a session that read a note is told once when another session changes it', async () => {
  const root = await adoptedRoot();
  const rel = 'manuals/deploy.md';
  const { sha } = await readNote(root, rel);
  recordRead(root, A.session, rel, sha);
  assert.equal(noticesFor(root, A.session).length, 0, 'nothing changed yet');

  await editNote(root, rel, { old: '## Rollback', new: '## Rollback\n\nNew step by B.\n\n## Canary' }, { author: B, reason: 'add canary' });
  const notices = noticesFor(root, A.session);
  assert.equal(notices.length, 1);
  const text = formatNotices(notices);
  assert.ok(text.startsWith(`[${NAME}] Notes you read have changed since you read them:`));
  assert.match(text, /manuals\/deploy\.md: edited by session bbbbbbbb \(claude-code\)/);
  assert.match(text, /Reason: "add canary"/);
  assert.match(text, /Re-read them before relying on them\.$/m);
  assert.equal(noticesFor(root, A.session).length, 0, 'each change is told once');
});

test('a session is not told about its own writes', async () => {
  const root = await adoptedRoot();
  const rel = 'manuals/deploy.md';
  const { sha } = await readNote(root, rel);
  recordRead(root, A.session, rel, sha);
  await editNote(root, rel, { old: 'How to ship a release.', new: 'How to ship a release, by A.' }, { author: A, reason: 'mine' });
  assert.equal(noticesFor(root, A.session).length, 0);
});

test('R-3: the owner of a section is told when it is removed by an external write, even without reading the note', async () => {
  const root = await adoptedRoot();
  const rel = 'projects/gamma.md';
  await writeNote(root, rel, "# Gamma\n\n## A's part\n\nby A\n", { author: A, reason: 'create' });
  fs.writeFileSync(path.join(root.dir, rel), '# Gamma\n');
  await scanExternal(root);
  const text = formatNotices(noticesFor(root, A.session));
  assert.match(text, /projects\/gamma\.md: external write \(no author\)/);
  assert.match(text, /removed ## A's part/);
});

test('presence: active sessions are the ones seen within the window', async () => {
  const root = await adoptedRoot();
  touchSession(root, A, { intent: 'deploy docs' });
  touchSession(root, B);
  const now = new Date();
  assert.deepEqual(activeSessions(root, { now }).map((s) => s.author.session).sort(), [A.session, B.session]);
  const later = new Date(now.getTime() + (root.config.activeWindowMinutes + 1) * 60_000);
  assert.equal(activeSessions(root, { now: later }).length, 0);
});
