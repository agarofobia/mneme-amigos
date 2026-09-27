// Sessions beyond the acceptance tests: notices across moves and both sources at once,
// messages by id prefix, "next" and the sender, session lookup for `allow`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture } from '../helpers/fixture.mjs';
import { NAME } from '../../src/name.js';
import { openRoot } from '../../src/root.js';
import {
  ackMessage,
  activeSessions,
  endSession,
  formatMessages,
  formatNotices,
  knownSessions,
  messagesFor,
  noticesFor,
  recordDenial,
  recordRead,
  sendMessage,
  sessionAuthor,
  touchSession,
} from '../../src/sessions.js';
import { editNote, initRoot, moveNote, readNote, writeNote } from '../../src/store.js';

process.env[`${NAME.toUpperCase()}_HOME`] = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-'));

/** @type {import('../../src/types.js').Author} */ const A = { session: 'aaaaaaaa-unit', agent: 'claude-code' };
/** @type {import('../../src/types.js').Author} */ const B = { session: 'bbbbbbbb-unit', agent: 'mcp' };

async function root() {
  const dir = copyFixture();
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  return openRoot(dir);
}

test('sessionAuthor carries the host (and the OS user when the system has one)', () => {
  const a = sessionAuthor({ session: 's', agent: 'cli', client: 'x' });
  assert.equal(a.session, 's');
  assert.equal(a.client, 'x');
  assert.equal(a.host, os.hostname());
});

test('a note read before a move is followed to its new name', async () => {
  const r = await root();
  const { sha } = await readNote(r, 'projects/beta.md');
  recordRead(r, A.session, 'projects/beta.md', sha);
  await moveNote(r, 'projects/beta.md', 'projects/beta-panel.md', { author: B, reason: 'rename' });
  await editNote(r, 'projects/beta-panel.md', { old: '## Plan', new: '## Plan\n\nNew.\n\n## Later' }, { author: B, reason: 'plan more' });
  const notices = noticesFor(r, A.session);
  assert.deepEqual(notices.map((n) => n.op), ['move', 'edit']);
  const text = formatNotices(notices);
  assert.match(text, /projects\/beta\.md: moved to projects\/beta-panel\.md by session bbbbbbbb \(mcp\)/);
  assert.match(text, /projects\/beta-panel\.md: edited by session bbbbbbbb \(mcp\) at \d\d:\d\d: changed ## Plan, added ## Later\. Reason: "plan more"/);
});

test('a change the session both read and owns is told once, saying it touched its section', async () => {
  const r = await root();
  await writeNote(r, 'projects/gamma.md', '# Gamma\n\n## Mine\n\nby A\n', { author: A, reason: 'create' });
  const { sha } = await readNote(r, 'projects/gamma.md');
  recordRead(r, A.session, 'projects/gamma.md', sha);
  assert.equal(noticesFor(r, A.session).length, 0);
  await editNote(r, 'projects/gamma.md', { old: 'by A', new: 'by A, fixed by B' }, { author: B, reason: 'typo' });
  const notices = noticesFor(r, A.session);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].yours, ['## Mine']);
  assert.equal(noticesFor(r, A.session).length, 0, 'told once');
});

test('the owner is told about a change to its section in a note it never read, once', async () => {
  const r = await root();
  await writeNote(r, 'projects/delta.md', '# Delta\n\n## Mine\n\nby A\n', { author: A, reason: 'create' });
  await editNote(r, 'projects/delta.md', { old: 'by A', new: 'rewritten by B' }, { author: B, reason: 'rewrite' });
  const text = formatNotices(noticesFor(r, A.session));
  assert.match(text, /projects\/delta\.md: edited by session bbbbbbbb \(mcp\).*changed ## Mine.*\(it touched a section you wrote: ## Mine\)/);
  assert.equal(noticesFor(r, A.session).length, 0);
  assert.equal(formatNotices([]), '');
});

test('messages: an ack by id prefix goes back to the sender; unknown ids say so', async () => {
  const r = await root();
  const sent = await sendMessage(r, { from: A, to: B.session, body: 'take ## Plan' });
  assert.equal(sent.correlation, sent.id);
  assert.match(sent.id, /^[0-9a-f]{16}$/);
  const [got] = messagesFor(r, B.session);
  assert.match(formatMessages([got]), new RegExp(`^\\[${NAME}\\] Messages for you:\\n  - from session aaaaaaaa \\(claude-code\\) at \\d\\d:\\d\\d: "take ## Plan" \\(id ${sent.id.slice(0, 8)}\\)$`));
  await ackMessage(r, { from: B, id: sent.id.slice(0, 8), status: 'rejected', body: 'busy' });
  const [reply] = messagesFor(r, A.session);
  assert.equal(reply.status, 'rejected');
  assert.equal(reply.replyTo, sent.id);
  assert.match(formatMessages([reply]), /reply to [0-9a-f]{8}: rejected/);
  await assert.rejects(ackMessage(r, { from: B, id: 'ffffffffff', status: 'done' }), /No message "ffffffffff"/);
  await assert.rejects(sendMessage(r, { from: A, to: '', body: 'x' }), TypeError);
  await assert.rejects(sendMessage(r, { from: A, to: B.session, body: 'x', replyTo: 'nope-nope' }), /No message/);
});

test('messages: the sender never takes its own "next"; a broadcast with nobody active reaches nobody', async () => {
  const r = await root();
  const next = await sendMessage(r, { from: A, to: 'next', body: 'handoff' });
  assert.equal(messagesFor(r, A.session).length, 0);
  assert.equal(messagesFor(r, B.session)[0]?.id, next.id);
  assert.equal(messagesFor(r, 'cccccccc-late').length, 0);
  const lonely = await sendMessage(r, { from: A, to: '*', body: 'anyone?' });
  assert.deepEqual(lonely.recipients, []);
  assert.equal(messagesFor(r, B.session).length, 0);
  const exactly = 'é'.repeat(32 * 1024); // 64 KiB in UTF-8: at the limit, accepted
  assert.equal((await sendMessage(r, { from: A, to: B.session, body: exactly })).body.length, 32 * 1024);
});

test('presence: intent is kept across touches; endSession removes it', async () => {
  const r = await root();
  touchSession(r, A, { intent: 'rewrite the manual', paths: ['manuals/deploy.md'] });
  const again = touchSession(r, A);
  assert.equal(again.intent, 'rewrite the manual');
  assert.deepEqual(again.paths, ['manuals/deploy.md']);
  assert.equal(activeSessions(r).length, 1);
  endSession(r, A.session);
  assert.equal(activeSessions(r).length, 0);
});

test('knownSessions puts the session blocked on the note first (so allow can expand 8 characters)', async () => {
  const r = await root();
  await writeNote(r, 'inbox/x.md', '# X\n', { author: A, reason: 'x' });
  recordDenial(r, 'bbbbbbbb-zzzz-full-id', 'manuals/deploy.md');
  recordDenial(r, 'bbbbbbbb-other-note', 'projects/alpha.md');
  const known = knownSessions(r, { rel: 'manuals/deploy.md' });
  assert.equal(known[0], 'bbbbbbbb-zzzz-full-id');
  assert.ok(known.includes(A.session));
  assert.ok(!known.includes('external'));
});
