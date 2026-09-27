#!/usr/bin/env node
// Small helpers for the Windows installer (scripts/install-windows.ps1): the parts that are fragile in
// Windows PowerShell 5.1 (editing JSON, reading frontmatter) live here, in Node, which the installer
// already requires.
//   node scripts/install-helpers.mjs embeddings <notes>   turn on the hybrid reader with nomic-embed-text
//   node scripts/install-helpers.mjs first-title <notes>  a heading from one of the notes, for the first search
//   node scripts/install-helpers.mjs kit-skills <kit>     the skills a recommended kit offers, as JSON lines
//   node scripts/install-helpers.mjs mcp <workspace> <bin> <notes>   the workspace's .mcp.json runs this Mneme, read-only
//   node scripts/install-helpers.mjs mcp-remove <workspace> <bin>    takes our server out of it, if it is still ours
import fs from 'node:fs';
import path from 'node:path';
import { NAME } from '../src/name.js';

const [cmd, dir, ...rest] = process.argv.slice(2);
if (!cmd || !dir) {
  console.error('usage: install-helpers.mjs embeddings|first-title|kit-skills <folder> | mcp <workspace> <bin> <notes> | mcp-remove <workspace> <bin>');
  process.exit(2);
}

/** The server entry this Mneme puts in a workspace's .mcp.json. @param {string} bin @param {string} notes */
const serverEntry = (bin, notes) => ({ command: 'node', args: [bin, 'mcp', '--root', notes, '--read-only'] });
/** @param {string} file @returns {{ mcpServers?: Record<string, unknown> } & Record<string, unknown>} */
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

if (cmd === 'embeddings') {
  // The "technical docs" use: nomic-embed-text with its query and document prefixes. Only the embeddings
  // block changes; everything else in the config stays as it is, and `mneme doctor` validates the result.
  const file = path.join(dir, '.mneme', 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1 };
  config.embeddings = {
    ...(config.embeddings ?? {}),
    provider: 'ollama',
    url: 'http://127.0.0.1:11434',
    model: 'nomic-embed-text',
    queryPrefix: 'search_query: ',
    documentPrefix: 'search_document: ',
  };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(file);
} else if (cmd === 'first-title') {
  // A heading from the largest note (the one most likely to have real content), skipping hidden folders.
  /** @type {Array<{ file: string, size: number }>} */
  const notes = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.md')) notes.push({ file: p, size: fs.statSync(p).size });
    }
  };
  walk(dir);
  notes.sort((a, b) => b.size - a.size);
  for (const n of notes) {
    const heading = fs.readFileSync(n.file, 'utf8').split(/\r?\n/).find((l) => /^#{1,3}\s+\S/.test(l));
    if (heading) {
      console.log(heading.replace(/^#+\s+/, '').trim());
      process.exit(0);
    }
  }
  process.exit(1);
} else if (cmd === 'kit-skills') {
  // A kit is the folder an exporter produced: <kit>/claude/skills/<name>/SKILL.md, each with its description.
  const skills = path.join(dir, 'claude', 'skills');
  if (!fs.existsSync(skills)) process.exit(0);
  for (const name of fs.readdirSync(skills).sort()) {
    const file = path.join(skills, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const description = (text.match(/^description:\s*(.+)$/m)?.[1] ?? '').replace(/^["']|["']$/g, '').slice(0, 160);
    console.log(JSON.stringify({ name, description, path: path.join(skills, name) }));
  }
} else if (cmd === 'mcp') {
  // Only our entry changes: other servers the person added stay as they are, and a second run
  // writes today's paths (a moved checkout gets the new ones).
  const [bin, notes] = rest;
  if (!bin || !notes) { console.error('usage: install-helpers.mjs mcp <workspace> <bin> <notes>'); process.exit(2); }
  const file = path.join(dir, '.mcp.json');
  const config = readJson(file);
  config.mcpServers = { ...(config.mcpServers ?? {}), [NAME]: serverEntry(bin, notes) };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(file);
} else if (cmd === 'mcp-remove') {
  // Ours is the entry that runs this bin; one the person changed to run something else is theirs now.
  const [bin] = rest;
  const file = path.join(dir, '.mcp.json');
  const config = readJson(file);
  const entry = /** @type {{ args?: unknown[] } | undefined} */ (config.mcpServers?.[NAME]);
  if (!entry || !Array.isArray(entry.args) || entry.args[0] !== bin) { console.log('not ours: left as it is'); process.exit(0); }
  delete config.mcpServers?.[NAME];
  if (Object.keys(config.mcpServers ?? {}).length === 0) delete config.mcpServers;
  if (Object.keys(config).length === 0) fs.rmSync(file);
  else fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log('removed');
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
