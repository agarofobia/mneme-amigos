// Contracts §4.17: the rendered page is one self-contained file, locked down by its own
// CSP, and a note cannot break out of the data it is carried in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { adoptedRoot, isolateHome, runCli } from '../aceptacion/l3-helpers.mjs';
import { collectGui } from '../../src/gui/data.js';
import { loadPack } from '../../src/gui/packs.js';
import { renderGui } from '../../src/gui/render.js';
import { writeNote } from '../../src/store.js';

const home = isolateHome();
const EVIL = '</script><script>alert(1)</script>';

async function page(options = {}) {
  const root = await adoptedRoot();
  const rel = 'projects/alpha.md';
  const text = fs.readFileSync(path.join(root.dir, rel), 'utf8');
  await writeNote(root, rel, `${text}\n## ${EVIL}\n\n${EVIL} <!-- x -->\n`, { author: { session: 'evil-session', agent: 'mcp' } });
  const data = await collectGui([root]);
  return { root, html: renderGui(data, loadPack('astrolabe', options), options) };
}

test('the CSP allows exactly the inline script by its hash, and nothing remote', async () => {
  const { html } = await page();
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  assert.ok(csp, 'the page carries a CSP');
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /https:|unsafe-eval/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'one executable script: the renderer');
  const hash = createHash('sha256').update(scripts[0], 'utf8').digest('base64');
  assert.ok(csp.includes(`'sha256-${hash}'`), 'the script is allowed by its hash');
  assert.doesNotMatch(html, /(src|href)=["']https?:/, 'no remote resource');
});

test('a note that contains </script> stays data', async () => {
  const { html } = await page();
  assert.equal(html.split(EVIL).length, 1, 'the literal never appears in the page');
  const json = html.match(/<script type="application\/json" id="mneme-data">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(json);
  const data = JSON.parse(json);
  const titles = data.roots[0].notes.flatMap((/** @type {any} */ n) => n.sections.map((/** @type {any} */ s) => s.title));
  assert.ok(titles.includes(EVIL), 'the title survives, as data');
});

test('allowRemote opens the CSP to https (D-P11), off by default', async () => {
  const { html } = await page({ allowRemote: true });
  assert.match(html, /style-src 'unsafe-inline' https:/);
});

test('the page starts in the loading state and names every zone of the map', async () => {
  const { html } = await page();
  assert.match(html, /<body data-part="window" data-state="loading"/);
  for (const zone of ['A', 'N', 'B', 'C', 'D', 'F']) assert.ok(html.includes(`data-zone="${zone}"`), `zone ${zone}`);
});

test('mneme gui writes the page, says where, and refuses an unknown pack', async () => {
  const root = await adoptedRoot();
  const out = path.join(home, 'out', 'gui.html');
  const res = await runCli(['gui', '--root', root.dir, '--out', out, '--query', 'vector index']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Wrote .*gui\.html/);
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes('"query":"vector index"'));
  const bad = await runCli(['gui', '--root', root.dir, '--out', out, '--pack', 'nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /No pack named "nope"/);
});
