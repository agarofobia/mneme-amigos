// The Node helpers of the Windows installer: they run as a child process, the way the .ps1 calls them.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HELPERS = fileURLToPath(new URL('../../scripts/install-helpers.mjs', import.meta.url));
/** @param {string[]} args */
const run = (...args) => spawnSync(process.execPath, [HELPERS, ...args], { encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-inst-'));

test('embeddings turns on the hybrid reader and keeps the rest of the config', () => {
  const notes = tmp();
  fs.mkdirSync(path.join(notes, '.mneme'));
  const file = path.join(notes, '.mneme', 'config.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, search: { stale: 'mark' } }));
  execFileSync(process.execPath, [HELPERS, 'embeddings', notes]);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.search, { stale: 'mark' });
  assert.equal(config.embeddings.model, 'nomic-embed-text');
  assert.equal(config.embeddings.queryPrefix, 'search_query: ');
});

test('first-title takes a heading from the largest note and skips hidden folders', () => {
  const notes = tmp();
  fs.mkdirSync(path.join(notes, '.mneme'));
  fs.writeFileSync(path.join(notes, '.mneme', 'huge.md'), `# Hidden\n${'x'.repeat(5000)}`);
  fs.writeFileSync(path.join(notes, 'small.md'), '# Small\nshort');
  fs.writeFileSync(path.join(notes, 'big.md'), `intro line\n## Rollback procedure\n${'y'.repeat(800)}`);
  const res = run('first-title', notes);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), 'Rollback procedure');
  assert.equal(run('first-title', tmp()).status, 1, 'no note with a heading: exit 1, and the installer skips the search');
});

test('mcp writes our server and keeps the others; mcp-remove takes out only ours, and only while it is ours', () => {
  const ws = tmp();
  const file = path.join(ws, '.mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  assert.equal(run('mcp', ws, 'C:/old/bin/mneme.js', 'C:/notes').status, 0);
  assert.equal(run('mcp', ws, 'C:/new/bin/mneme.js', 'C:/notes').status, 0); // a second run: today's paths
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.mcpServers.other, { command: 'x' });
  assert.deepEqual(config.mcpServers.mneme, { command: 'node', args: ['C:/new/bin/mneme.js', 'mcp', '--root', 'C:/notes', '--read-only'] });
  assert.match(run('mcp-remove', ws, 'C:/elsewhere/bin/mneme.js').stdout, /not ours/);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.mneme, 'an entry running another bin is left alone');
  run('mcp-remove', ws, 'C:/new/bin/mneme.js');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: { other: { command: 'x' } } });
  const alone = tmp();
  run('mcp', alone, 'C:/b/mneme.js', 'C:/n');
  run('mcp-remove', alone, 'C:/b/mneme.js');
  assert.equal(fs.existsSync(path.join(alone, '.mcp.json')), false, 'a file that only had ours is gone');
});

test('kit-skills lists each skill with its description, and an empty kit lists nothing', () => {
  const kit = tmp();
  const skill = path.join(kit, 'claude', 'skills', 'review');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: review\ndescription: "Reviews a diff before commit"\n---\nbody');
  fs.mkdirSync(path.join(kit, 'claude', 'skills', 'no-skill-file'));
  const lines = run('kit-skills', kit).stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.name, l.description]), [['review', 'Reviews a diff before commit']]);
  assert.equal(run('kit-skills', tmp()).stdout, '');
});
