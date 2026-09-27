// The MCP server over two roots (I-5), in memory: routing by absolute path and by `root`,
// a root it does not serve, notices through `changes`, and a message round trip.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { copyFixture } from '../helpers/fixture.mjs';
import { createServer } from '../../src/adapters/mcp/server.js';
import { NAME } from '../../src/name.js';
import { openRoot } from '../../src/root.js';
import { initRoot, writeNote } from '../../src/store.js';

process.env[`${NAME.toUpperCase()}_HOME`] = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-home-'));
delete process.env.CLAUDE_CODE_SESSION_ID;

async function root() {
  const dir = copyFixture();
  await initRoot(dir, { adopt: true, author: { session: 'adopter', agent: 'adopt' } });
  return openRoot(dir);
}

/**
 * @param {import('../../src/types.js').Root[]} roots
 * @param {{ readOnly?: boolean, sessionId?: string }} [options]
 */
async function connect(roots, options = {}) {
  const { server, session } = createServer({ roots, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'unit-client', version: '0.0.0' });
  await client.connect(clientSide);
  return { client, session, close: () => client.close() };
}

/** @param {any} r */
const textOf = (r) => r.content.map((/** @type {any} */ c) => c.text).join('\n');

test('I-5: one server, two roots: search spans both; paths route by absolute path or by root', async () => {
  const r1 = await root();
  const r2 = await root();
  await writeNote(r2, 'projects/zeta.md', '# Zeta\n\n## Harbor\n\nThe lighthouse keeper logs every harbor arrival.\n', { author: { session: 's2', agent: 'cli' }, reason: 'c' });
  const { client, session, close } = await connect([r1, r2]);
  try {
    assert.match(session, /^mcp-[0-9a-f]{8}$/);
    const found = textOf(await client.callTool({ name: 'search', arguments: { query: 'lighthouse harbor arrival', reader: 'lexical' } }));
    assert.ok(found.includes(`${r2.dir} :: projects/zeta.md`), found);
    const byAbs = await client.callTool({ name: 'read_note', arguments: { path: path.join(r2.dir, 'projects/zeta.md') } });
    assert.match(textOf(byAbs), new RegExp(`^path: projects/zeta\\.md · version: [0-9a-f]{8} · root: `));
    const byRoot = await client.callTool({ name: 'read_note', arguments: { path: 'projects/zeta.md', root: r2.dir } });
    assert.notEqual(byRoot.isError, true);
    const firstRoot = await client.callTool({ name: 'read_note', arguments: { path: 'projects/zeta.md' } });
    assert.equal(firstRoot.isError, true, 'relative paths go to the first root, which has no zeta');
    const other = await root();
    const unserved = await client.callTool({ name: 'read_note', arguments: { path: path.join(other.dir, 'projects/alpha.md') } });
    assert.equal(unserved.isError, true);
    assert.match(textOf(unserved), /escapes the roots this server serves/);
    const badRoot = await client.callTool({ name: 'bundle', arguments: { root: other.dir } });
    assert.match(textOf(badRoot), /is not one of the roots this server serves/);
  } finally {
    await close();
  }
});

test('changes tells what another session changed after a read_note, once; messages go both ways', async () => {
  const r = await root();
  const a = await connect([r], { sessionId: 'aaaaaaaa-mcp' });
  const b = await connect([r], { sessionId: 'bbbbbbbb-mcp' });
  try {
    await a.client.callTool({ name: 'read_note', arguments: { path: 'manuals/deploy.md' } });
    const edit = await b.client.callTool({ name: 'edit_note', arguments: { path: 'manuals/deploy.md', old: 'How to ship a release.', new: 'How to ship.', reason: 'shorter' } });
    assert.match(textOf(edit), /^Edited manuals\/deploy\.md \(version [0-9a-f]{8}, ledger entry /);
    const changes = textOf(await a.client.callTool({ name: 'changes', arguments: {} }));
    assert.match(changes, /manuals\/deploy\.md: edited by session bbbbbbbb \(mcp\).*Reason: "shorter"/);
    assert.match(textOf(await a.client.callTool({ name: 'changes', arguments: {} })), /^Nothing changed/);

    const sent = textOf(await a.client.callTool({ name: 'send_message', arguments: { to: 'bbbbbbbb-mcp', body: 'thanks, rebasing on yours' } }));
    const id = /** @type {string} */ (sent.match(/Sent message ([0-9a-f]{16})/)?.[1]);
    assert.match(textOf(await b.client.callTool({ name: 'changes', arguments: {} })), /"thanks, rebasing on yours"/);
    assert.match(textOf(await b.client.callTool({ name: 'ack_message', arguments: { id, status: 'seen' } })), /Answered [0-9a-f]{8} with "seen"/);
    assert.match(textOf(await a.client.callTool({ name: 'changes', arguments: {} })), /reply to [0-9a-f]{8}: seen/);

    const history = textOf(await a.client.callTool({ name: 'note_history', arguments: { path: 'manuals/deploy.md', limit: 1 } }));
    assert.match(history, /edit\s+session bbbbbbbb \(mcp\).*"shorter"/);
    const past = textOf(await a.client.callTool({ name: 'note_as_of', arguments: { path: 'manuals/deploy.md', date: '2000-01-01' } }));
    assert.match(past, /did not exist at 2000-01-01/);
    const declared = textOf(await b.client.callTool({ name: 'declare_intent', arguments: { intent: 'split the manual', paths: ['manuals/deploy.md'] } }));
    assert.match(declared, /active: aaaaaaaa \(mcp\)/);
  } finally {
    await a.close();
    await b.close();
  }
});

test('a failing tool is an error result and the next call still works', async () => {
  const r = await root();
  const { client, close } = await connect([r]);
  try {
    const missing = await client.callTool({ name: 'edit_note', arguments: { path: 'manuals/deploy.md', old: 'not there', new: 'x', reason: 'r' } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /was not found in manuals\/deploy\.md/);
    const state = await client.callTool({ name: 'write_note', arguments: { path: '.mneme/ledger.jsonl', content: '{}', reason: 'forge' } });
    assert.equal(state.isError, true);
    assert.match(textOf(state), /inside the state directory/);
    assert.notEqual((await client.callTool({ name: 'bundle', arguments: { budget: 2000 } })).isError, true);
  } finally {
    await close();
  }
});
