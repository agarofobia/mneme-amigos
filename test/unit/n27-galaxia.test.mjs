// La galaxia (galaxia/, la vista 3D que se lleva la entrega a los amigos, 26/09): la guía de packs no
// envejece contra la página, el pack de ejemplo no usa claves que el dibujo no conoce, y el servidor
// cuida sus escrituras (token, Host y Origin; valida antes de escribir; los de fábrica no se tocan).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adoptedRoot, isolateHome } from '../aceptacion/l3-helpers.mjs';
import { loadPack } from '../../src/gui/packs.js';

const home = isolateHome();
const pagina = fs.readFileSync(fileURLToPath(new URL('../../galaxia/index.html', import.meta.url)), 'utf8');
const guia = fs.readFileSync(fileURLToPath(new URL('../../packs/COMO-HACER-UN-PACK.md', import.meta.url)), 'utf8');

/** Los tokens que declara el :root de la página. */
function tokensDeLaPagina() {
  const ini = pagina.indexOf(':root {');
  return [...pagina.slice(ini, pagina.indexOf('}', ini)).matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
}
/** Las claves de ESCENA_BASE, con las de sus grupos como «grupo.clave». */
function clavesDeLaEscena() {
  const ini = pagina.indexOf('const ESCENA_BASE = {');
  const cuerpo = pagina.slice(ini, pagina.indexOf('\n};', ini)).replace(/\/\/[^\n]*/g, '');
  /** @type {string[]} */
  const out = [];
  for (const m of cuerpo.matchAll(/^\s{2}(\w+):\s*(\{[^}]*\})?/gm)) {
    out.push(m[1]);
    if (m[2]) for (const s of m[2].matchAll(/(\w+):/g)) out.push(`${m[1]}.${s[1]}`);
  }
  return out;
}

test('la guía de packs nombra cada token de la página y cada clave de la escena', () => {
  const tokens = tokensDeLaPagina();
  assert.ok(tokens.length >= 39, `se leyeron ${tokens.length} tokens`);
  for (const t of tokens) assert.ok(guia.includes('`' + t + '`'), `la guía no explica ${t}`);
  const claves = clavesDeLaEscena();
  assert.ok(claves.includes('cielo.intensidad') && claves.includes('tintes'), claves.join(', '));
  for (const k of claves) {
    if (claves.some((c) => c.startsWith(`${k}.`))) continue; // un grupo se explica por sus claves
    const [grupo, sub] = k.split('.');
    // «`cielo.bajo`, `cielo.alto`» o «`estrellas.color`, `estrellas.opacidad`»: cada clave con su grupo
    assert.ok(guia.includes('`' + k + '`') || (sub && guia.includes(`\`${grupo}.${sub}\``)), `la guía no explica escena.${k}`);
  }
});

test('el pack de ejemplo sólo usa claves que el dibujo conoce', () => {
  const claves = new Set(clavesDeLaEscena());
  const pack = loadPack('cianotipo', { format: 2 });
  for (const [k, v] of Object.entries(pack.escena)) {
    assert.ok(claves.has(k), `escena.${k}`);
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const s of Object.keys(v)) assert.ok(claves.has(`${k}.${s}`), `escena.${k}.${s}`);
  }
  const tokens = new Set(tokensDeLaPagina());
  for (const t of Object.keys(pack.tokens)) assert.ok(tokens.has(t), `token ${t}`);
});

/**
 * @param {number} port
 * @param {string} method
 * @param {string} ruta
 * @param {{ body?: unknown, headers?: Record<string, string> }} [opts]
 * @returns {Promise<{ status: number, json: any }>}
 */
function pedir(port, method, ruta, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({ host: '127.0.0.1', port, method, path: ruta, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...(opts.headers ?? {}) } }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { json = t; } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('el servidor: exporta, dice el primer paso, y cuida las escrituras de packs', { timeout: 120000 }, async (t) => {
  const root = await adoptedRoot();
  const espacio = fs.mkdtempSync(path.join(home, 'espacio-'));
  fs.writeFileSync(path.join(espacio, 'rules.md'), '# Rules\n\nquestionnaire: not offered\n');
  fs.writeFileSync(path.join(espacio, 'EMPEZAR.txt'), 'hola\n');
  const port = 4800 + Math.floor(Math.random() * 800);
  const srv = spawn(process.execPath, [fileURLToPath(new URL('../../galaxia/servir.mjs', import.meta.url)), '--raiz', root.dir, '--espacio', espacio, '--puerto', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  let salida = '';
  await new Promise((resolve, reject) => {
    const listo = (/** @type {Buffer} */ c) => { salida += c; if (/está abierto en http:\/\/127\.0\.0\.1:(\d+)/.test(salida)) resolve(undefined); };
    srv.stdout.on('data', listo); srv.stderr.on('data', (c) => { salida += c; });
    srv.on('exit', (code) => reject(new Error(`el servidor salió (${code}): ${salida}`)));
  });
  const p = Number(/127\.0\.0\.1:(\d+)/.exec(salida)?.[1]);

  const primer = await pedir(p, 'GET', '/primer-paso.json');
  assert.equal(primer.json.mostrar, true, 'rules.md dice not offered');
  assert.match(primer.json.textos.es.prompt, /cuestionario/);
  assert.equal(primer.json.archivo, path.join(espacio, 'EMPEZAR.txt'));
  assert.equal((await pedir(p, 'GET', '/data.json')).status, 200, 'el export corrió');
  assert.equal((await pedir(p, 'GET', '/textos.json')).status, 200);
  assert.ok(fs.existsSync(path.join(home, 'galaxia', 'data.json')), 'los datos van al home de Mneme, no a la carpeta del programa');

  // quién puede escribir
  assert.equal((await pedir(p, 'GET', '/packs.json', { headers: { host: `evil.test:${p}` } })).status, 421, 'otro Host (DNS rebinding) no entra');
  const nuevo = { nombre: 'prueba', descripcion: 'de un test', tokens: { '--acento': '#ff0000' }, escena: { fondo: '#101010' } };
  assert.equal((await pedir(p, 'POST', '/packs/crear', { body: nuevo })).status, 403, 'sin token no escribe');
  const { token } = (await pedir(p, 'GET', '/sesion.json')).json;
  assert.equal((await pedir(p, 'POST', '/packs/crear', { body: nuevo, headers: { 'x-mneme-token': token, origin: 'https://evil.test' } })).status, 403, 'otro Origin no escribe');
  const con = { 'x-mneme-token': token, origin: `http://127.0.0.1:${p}` };

  // crear, leer, guardar el ajuste fino, borrar
  assert.equal((await pedir(p, 'POST', '/packs/crear', { body: nuevo, headers: con })).status, 200);
  const leido = (await pedir(p, 'GET', '/pack/prueba.json')).json;
  assert.equal(leido.tokens['--acento'], '#ff0000');
  assert.equal(leido.escena.fondo, '#101010');
  assert.equal(leido.propio, true);
  assert.equal((await pedir(p, 'POST', '/packs/crear', { body: nuevo, headers: con })).status, 422, 'no pisa uno que existe');
  const roto = await pedir(p, 'POST', '/packs/crear', { body: { ...nuevo, nombre: 'roto', tokens: { '--acento': 'red;} body{display:none' } }, headers: con });
  assert.equal(roto.status, 422);
  assert.match(roto.json.error, /--acento/);
  assert.equal(fs.existsSync(path.join(home, 'packs', 'roto')), false, 'un pack que no valida no queda escrito');
  assert.equal((await pedir(p, 'POST', '/packs/guardar', { body: { nombre: 'prueba', tokens: { '--texto': '15px' } }, headers: con })).status, 200);
  assert.equal(loadPack('prueba', { format: 2 }).tokens['--texto'], '15px');
  assert.equal(loadPack('prueba', { format: 2 }).tokens['--acento'], '#ff0000', 'guardar suma, no reemplaza');
  assert.equal((await pedir(p, 'POST', '/packs/guardar', { body: { nombre: 'cianotipo', tokens: { '--texto': '15px' } }, headers: con })).status, 422, 'los de fábrica no se tocan');
  assert.equal((await pedir(p, 'POST', '/packs/borrar', { body: { nombre: 'cianotipo' }, headers: con })).status, 422);
  const borrado = await pedir(p, 'POST', '/packs/borrar', { body: { nombre: 'prueba' }, headers: con });
  assert.equal(borrado.status, 200);
  assert.equal(fs.existsSync(path.join(home, 'packs', 'prueba')), false);
  assert.ok(fs.existsSync(path.join(borrado.json.papelera, 'pack.json')), 'queda en la papelera, se puede recuperar');
  const lista = (await pedir(p, 'GET', '/packs.json')).json;
  assert.ok(lista.packs.some((/** @type {any} */ x) => x.name === 'cianotipo' && x.estado === 'ok' && !x.propio));
  assert.ok(!lista.packs.some((/** @type {any} */ x) => x.name.startsWith('.')), 'la papelera no aparece como pack');
});
