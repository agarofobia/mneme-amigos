// Contracts §4.18: a pack is data (manifest + CSS + assets, no scripts), validated as
// untrusted input. The two packs that ship: astrolabe and a color-only child of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isolateHome } from '../aceptacion/l3-helpers.mjs';
import { DEFAULT_PACK, listPacks, loadPack } from '../../src/gui/packs.js';

const home = isolateHome();

/**
 * A pack folder in a temporary directory.
 * @param {Record<string, unknown>} manifest
 * @param {Record<string, string|Buffer>} [files]
 */
function makePack(manifest, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-pack-'));
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ packFormat: 1, name: 'test-pack', version: '0.1.0', ...manifest }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('the default pack loads, defines every contract token, and inlines its fonts', () => {
  assert.equal(DEFAULT_PACK, 'astrolabe');
  const pack = loadPack(DEFAULT_PACK);
  assert.equal(pack.name, 'astrolabe');
  assert.equal(pack.device, 'armillary');
  for (const t of ['--mn-bg', '--mn-accent', '--mn-denied', '--mn-stale', '--mn-external', '--mn-writing', '--mn-ok', '--mn-focus', '--mn-line-strong', '--mn-ease-live']) {
    assert.ok(pack.tokens[t], `${t} is defined`);
  }
  assert.ok(pack.css.includes('data:font/woff2;base64,'), 'fonts travel inside the page');
  assert.ok(!/url\(\s*["']?asset:/.test(pack.css), 'every asset reference was resolved');
  assert.ok(!/https?:\/\//.test(pack.css), 'nothing is loaded from the network');
});

test('the color-only pack changes tokens and nothing else', () => {
  const parent = loadPack('astrolabe');
  const child = loadPack('astrolabe-verdigris');
  assert.deepEqual(child.chain, ['astrolabe', 'astrolabe-verdigris']);
  assert.equal(child.css, parent.css, 'same styles, byte for byte');
  assert.equal(child.device, parent.device);
  const changed = Object.keys(child.tokens).filter((k) => child.tokens[k] !== parent.tokens[k]);
  assert.ok(changed.length > 0);
  for (const k of changed) assert.match(k, /^--mn-/);
  assert.deepEqual(Object.keys(child.tokens).sort(), Object.keys(parent.tokens).sort(), 'no token added or lost');
});

test('a pack is found by path, then in <home>/packs, then among the built-in ones', () => {
  const dir = makePack({ name: 'mine', tokens: { '--mn-accent': '#ff0000' } });
  assert.equal(loadPack(dir).name, 'mine');
  fs.mkdirSync(path.join(home, 'packs'), { recursive: true });
  fs.cpSync(dir, path.join(home, 'packs', 'mine'), { recursive: true });
  assert.equal(loadPack('mine').tokens['--mn-accent'], '#ff0000');
  assert.throws(() => loadPack('does-not-exist'), /No pack named "does-not-exist"/);
});

test('a pack with a script anywhere is refused, with the reason and the file', () => {
  assert.throws(() => loadPack(makePack({}, { 'pack.css': 'a{}', 'x.js': 'alert(1)' })), /PACK_INVALID|a pack is data: x\.js/);
  assert.throws(() => loadPack(makePack({}, { 'pack.css': 'a{} </style><script>alert(1)</script>' })), /pack\.css.*<\/style|pack\.css.*<script/);
  assert.throws(() => loadPack(makePack({}, { 'pack.css': 'a{background:url(javascript:alert(1))}' })), /javascript:/);
  assert.throws(() => loadPack(makePack({}, { 'pack.css': '@import "other.css";' })), /@import/);
  assert.throws(() => loadPack(makePack({}, { 'pack.css': 'a{width:expression(alert(1))}' })), /expression\(/);
  assert.throws(() => loadPack(makePack({ assets: { logo: 'logo.svg' } }, { 'pack.css': 'a{}', 'logo.svg': '<svg onload="alert(1)"></svg>' })), /logo\.svg/);
  assert.throws(() => loadPack(makePack({}, { 'page.html': '<p>hi</p>' })), /page\.html/);
});

test('remote URLs are refused unless allowed; tokens, names and paths are checked', () => {
  const remote = makePack({}, { 'pack.css': 'a{background:url(https://example.com/x.png)}' });
  assert.throws(() => loadPack(remote), /remote/);
  assert.ok(loadPack(remote, { allowRemote: true }).css.includes('https://example.com/x.png'), 'D-P11: allowed on request');
  assert.throws(() => loadPack(makePack({ tokens: { color: 'red' } })), /--mn-/);
  assert.throws(() => loadPack(makePack({ tokens: { '--mn-bg': 'red;} body{display:none' } })), /--mn-bg/);
  assert.throws(() => loadPack(makePack({ name: 'Bad Name!' })), /name/);
  assert.throws(() => loadPack(makePack({ styles: ['../outside.css'] })), /outside the pack/);
  assert.throws(() => loadPack(makePack({ packFormat: 2 })), /packFormat/);
  assert.throws(() => loadPack(makePack({ device: 'wheel-of-fortune' })), /device/);
});

test('extends: the child wins, cycles and deep chains are refused', () => {
  const a = makePack({ name: 'a', tokens: { '--mn-bg': '#000000', '--mn-ink': '#ffffff' } }, { 'pack.css': '[data-part=window]{color:var(--mn-ink)}' });
  const b = makePack({ name: 'b', extends: a, tokens: { '--mn-bg': '#111111' } }, { 'pack.css': '[data-part=list]{margin:0}' });
  const pack = loadPack(b);
  assert.deepEqual(pack.tokens, { '--mn-bg': '#111111', '--mn-ink': '#ffffff' });
  assert.ok(pack.css.indexOf('[data-part=window]') < pack.css.indexOf('[data-part=list]'), "the parent's styles come first");
  const c1 = makePack({ name: 'c1' });
  const c2 = makePack({ name: 'c2', extends: c1 });
  const m = JSON.parse(fs.readFileSync(path.join(c1, 'pack.json'), 'utf8'));
  fs.writeFileSync(path.join(c1, 'pack.json'), JSON.stringify({ ...m, extends: c2 }));
  assert.throws(() => loadPack(c2), /cycle/);
});

// Format 2: the 3D GUI (spec «Packs de la GUI v2», 26/09). Same folder of data, its own vocabulary of
// tokens and an `escena` of colors and numbers; each GUI asks for its format.
test('format 2: tokens of any --name and an escena of colors and numbers, merged over the parent', () => {
  const base = makePack({ packFormat: 2, name: 'base', tokens: { '--fondo': '#101010', '--tinta': '#eeeeee' }, escena: { fondo: '#000000', cielo: { intensidad: 1, calida: '#221100' }, tintes: ['#112233', '#445566'] } });
  const hija = makePack({ packFormat: 2, name: 'hija', extends: base, tokens: { '--fondo': '#ffffff' }, escena: { cielo: { intensidad: 0 }, voces: ['#aa0000'] } });
  const pack = loadPack(hija, { format: 2 });
  assert.equal(pack.format, 2);
  assert.equal(pack.device, 'none');
  assert.deepEqual(pack.tokens, { '--fondo': '#ffffff', '--tinta': '#eeeeee' });
  assert.deepEqual(pack.escena, { fondo: '#000000', cielo: { intensidad: 0, calida: '#221100' }, tintes: ['#112233', '#445566'], voces: ['#aa0000'] }, 'the child wins key by key, groups are merged');
  assert.deepEqual(loadPack(DEFAULT_PACK).escena, {}, 'a v1 pack has no scene');
});

test('format 2: the escena carries only data, and bad tokens are refused with the reason', () => {
  const f2 = (/** @type {Record<string, unknown>} */ m) => () => loadPack(makePack({ packFormat: 2, ...m }), { format: 2 });
  assert.throws(f2({ escena: { fondo: 'url(https://x.test/a.png)' } }), /escena\.fondo/);
  assert.throws(f2({ escena: { fondo: 'red' } }), /escena\.fondo/, 'colors are #rrggbb, nothing a CSS parser or a shader would read differently');
  assert.throws(f2({ escena: { tintes: [] } }), /escena\.tintes/);
  assert.throws(f2({ escena: { tintes: ['#112233', 3] } }), /escena\.tintes/);
  assert.throws(f2({ escena: { 'bad-key': 1 } }), /bad-key/);
  assert.throws(f2({ escena: { a: { b: { c: { d: 1 } } } } }), /escena\.a\.b\.c/, 'three levels at most');
  assert.throws(f2({ escena: { cielo: { intensidad: Infinity } } }), /escena/);
  assert.throws(f2({ tokens: { color: 'red' } }), /CSS variable/);
  assert.throws(f2({ tokens: { '--fondo': 'red;} body{display:none' } }), /--fondo/);
  assert.throws(f2({ tokens: { '--fondo': 'url(https://x.test/pixel.png)' } }), /--fondo/);
  assert.throws(() => loadPack(makePack({ packFormat: 2 }, { 'pack.css': '@import "x.css";' }), { format: 2 }), /@import/);
  assert.throws(() => loadPack(makePack({ packFormat: 2 }, { 'x.mjs': 'export {}' }), { format: 2 }), /x\.mjs/);
});

test('each GUI loads only its own format, and says which GUI a pack is for', () => {
  const v2 = makePack({ packFormat: 2, name: 'para-3d' });
  assert.throws(() => loadPack(v2), /packFormat must be 1 .*3D GUI/);
  assert.throws(() => loadPack(DEFAULT_PACK, { format: 2 }), /packFormat must be 2 .*v1 GUI/);
  assert.throws(() => loadPack(makePack({ escena: { fondo: '#000000' } })), /escena.*packFormat 2/);
  const hija = makePack({ packFormat: 2, name: 'mezcla', extends: DEFAULT_PACK });
  assert.throws(() => loadPack(hija, { format: 2 }), /packFormat must be 2/, 'extends stays within one format');
});

test('listPacks says each pack\'s format', () => {
  const listed = listPacks();
  assert.equal(listed.find((p) => p.name === 'astrolabe')?.format, 1);
  for (const p of listed) assert.ok(p.format === 1 || p.format === 2 || p.format === null, `${p.name}: ${p.format}`);
});
