// The MCP door, over real stdio with the official client. Written by the main thread BEFORE the batch.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BIN, HOME_VAR, adoptedRoot, isolateHome } from './l3-helpers.mjs';
import { writeNote } from '../../src/store.js';

const home = isolateHome();

// Every client opened here is closed at the end even if an assertion failed midway:
// otherwise the MCP child keeps the process alive and the file hangs instead of failing
// (the L3 worker saw it under mutation). Closing an already closed client is harmless.
/** @type {Client[]} */
const opened = [];
after(async () => {
  await Promise.allSettled(opened.map((c) => c.close()));
});

/** @param {string[]} args */
async function connect(args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp', ...args],
    env: { ...(/** @type {Record<string, string>} */ (process.env)), [HOME_VAR]: home, CLAUDE_CODE_SESSION_ID: '' },
  });
  const client = new Client({ name: 'acceptance-test', version: '0.0.0' });
  await client.connect(transport);
  opened.push(client);
  return client;
}

/** @param {any} result */
const textOf = (result) => result.content.map((/** @type {any} */ c) => c.text).join('\n');

test('the MCP server lists the tools of the map, and read-only drops the writing ones', async () => {
  const root = await adoptedRoot();
  const full = await connect(['--root', root.dir]);
  const names = (await full.listTools()).tools.map((t) => t.name);
  for (const t of ['read_note', 'write_note', 'edit_note', 'move_note', 'note_history', 'note_as_of', 'restore_note', 'search', 'changes', 'bundle', 'declare_intent', 'send_message', 'ack_message']) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
  await full.close();
  const ro = await connect(['--root', root.dir, '--read-only']);
  const roNames = (await ro.listTools()).tools.map((t) => t.name);
  for (const t of ['write_note', 'edit_note', 'move_note', 'restore_note', 'send_message', 'ack_message']) assert.ok(!roNames.includes(t), `read-only exposes ${t}`);
  assert.ok(roNames.includes('read_note') && roNames.includes('search'));
  await ro.close();
});

test('read_note returns the note as data with its version; search finds it', async () => {
  const root = await adoptedRoot();
  const client = await connect(['--root', root.dir]);
  const read = await client.callTool({ name: 'read_note', arguments: { path: 'manuals/deploy.md' } });
  assert.match(textOf(read), /^path: manuals\/deploy\.md · version: [0-9a-f]{8}/);
  assert.match(textOf(read), /rollback procedure/);
  const found = await client.callTool({ name: 'search', arguments: { query: 'snapshot schedule' } });
  assert.match(textOf(found), /manuals\/backups\.md/);
  await client.close();
});

test('the guard answers through MCP as an error result, and the server stays up', async () => {
  const root = await adoptedRoot();
  await writeNote(root, 'projects/gamma.md', "# Gamma\n\n## A's part\n\nby A\n", { author: { session: 'session-a', agent: 'claude-code' }, reason: 'create' });
  const client = await connect(['--root', root.dir]);
  const denied = await client.callTool({ name: 'write_note', arguments: { path: 'projects/gamma.md', content: '# Gamma\n', reason: 'rewrite' } });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /removes sections written by another session/);
  const escape = await client.callTool({ name: 'read_note', arguments: { path: '../outside.md' } });
  assert.equal(escape.isError, true);
  assert.match(textOf(escape), /escapes the root/);
  const alive = await client.callTool({ name: 'read_note', arguments: { path: 'inbox/idea.md' } });
  assert.notEqual(alive.isError, true, 'the server is still answering');
  await client.close();
});
