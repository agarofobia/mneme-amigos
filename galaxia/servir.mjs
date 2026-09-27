// La galaxia: exporta las notas de una raíz, las sirve sólo en 127.0.0.1 y abre el navegador.
// Uso: node galaxia/servir.mjs [--raiz <carpeta de notas>] [--espacio <AI-Workspace>] [--puerto 4748] [--abrir]
//      (lo corre `mneme galaxia`; el instalador deja «Abrir Mneme.cmd» en el espacio)
//
// - Los datos (data.json, textos.json) van a <home de Mneme>/galaxia/, no a la carpeta del programa.
// - El primer paso: la página lo pide acá. Se muestra mientras rules.md del espacio diga
//   «questionnaire: not offered»; los textos son los de scripts/workspace/first-run.json (su dueño).
// - Los packs se leen y se validan con src/gui/packs.js (packFormat 2), el mismo cargador de la app.
//   Los de la persona viven en <home>/packs/<nombre>/: la página los crea, les guarda el ajuste fino y
//   los manda a la papelera (<home>/packs/.papelera/, nunca se borran). Los de fábrica no se tocan.
// - Toda escritura pide: Host de 127.0.0.1/localhost, el mismo Origin, y el token de este arranque
//   (una página de otro sitio no puede leerlo). Por URL un pack se pide por NOMBRE, nunca por ruta.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listPacks, loadPack } from '../src/gui/packs.js';
import { homeDir } from '../src/registry.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { raiz: { type: 'string' }, espacio: { type: 'string' }, puerto: { type: 'string' }, abrir: { type: 'boolean' } },
});
const DATOS = path.join(homeDir(), 'galaxia');
const PACKS_PROPIOS = path.join(homeDir(), 'packs');
const PRIMER_PASO = path.join(AQUI, '..', 'scripts', 'workspace', 'first-run.json');
const TOKEN = crypto.randomBytes(18).toString('hex');
const NOMBRE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// 1. Las notas → data.json + textos.json (sólo lee la raíz)
fs.mkdirSync(DATOS, { recursive: true });
if (values.raiz) {
  const r = spawnSync(process.execPath, [path.join(AQUI, 'export.mjs'), path.resolve(values.raiz), path.join(DATOS, 'data.json')], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('No se pudieron leer las notas (arriba dice por qué).'); process.exit(1); }
} else if (!fs.existsSync(path.join(DATOS, 'data.json'))) {
  console.error('Falta la carpeta de notas: node galaxia/servir.mjs --raiz <carpeta>   (o: mneme galaxia)');
  process.exit(2);
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jsonl': 'application/json', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const archivo = (res, file) => {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('no está'); }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
};
const esPropio = (name) => fs.existsSync(path.join(PACKS_PROPIOS, name, 'pack.json'));

function primerPaso() {
  let textos = null;
  try { textos = JSON.parse(fs.readFileSync(PRIMER_PASO, 'utf8')); } catch { textos = null; }
  let mostrar = false, archivoMensaje = null;
  if (values.espacio) {
    try { mostrar = /questionnaire:\s*not offered/.test(fs.readFileSync(path.join(values.espacio, 'rules.md'), 'utf8')); } catch { mostrar = false; }
    for (const f of ['EMPEZAR.txt', 'START.txt']) if (fs.existsSync(path.join(values.espacio, f))) archivoMensaje = path.join(values.espacio, f);
  }
  return { mostrar, textos, archivo: archivoMensaje };
}

function listar() {
  return listPacks().filter((p) => p.format === 2 && !p.name.startsWith('.')).map(({ name, description, builtin }) => {
    let estado = 'ok';
    try { loadPack(name, { format: 2 }); } catch (e) { estado = e.message; }
    return { name, description, propio: !builtin && esPropio(name), estado };
  });
}

// Escribe un pack.json en una carpeta aparte, lo valida con el cargador de la app y recién ahí lo pone
// en su lugar: un pack roto nunca reemplaza a uno que andaba.
function escribirPack(name, manifiesto) {
  const tmp = path.join(PACKS_PROPIOS, `.nuevo-${crypto.randomBytes(4).toString('hex')}`);
  const destino = path.join(PACKS_PROPIOS, name);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (fs.existsSync(destino)) for (const f of fs.readdirSync(destino)) if (f !== 'pack.json') fs.cpSync(path.join(destino, f), path.join(tmp, f), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pack.json'), JSON.stringify(manifiesto, null, 2) + '\n');
    loadPack(tmp, { format: 2 });
    if (fs.existsSync(destino)) fs.renameSync(destino, path.join(PACKS_PROPIOS, `.viejo-${name}-${Date.now()}`));
    fs.renameSync(tmp, destino);
    for (const f of fs.readdirSync(PACKS_PROPIOS)) if (f.startsWith(`.viejo-${name}-`)) fs.rmSync(path.join(PACKS_PROPIOS, f), { recursive: true, force: true });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

const ACCIONES = {
  // un pack nuevo con lo que se ve: los tokens y la escena que manda la página
  crear({ nombre, descripcion, tokens, escena }) {
    if (!NOMBRE.test(nombre ?? '')) throw new Error('El nombre va en minúsculas, dígitos y guiones (por ejemplo: mi-pack).');
    if (listPacks().some((p) => p.name === nombre)) throw new Error(`Ya hay un pack «${nombre}». Elegí otro nombre.`);
    escribirPack(nombre, { packFormat: 2, name: nombre, version: '0.1.0', description: String(descripcion ?? '').slice(0, 300) || 'Mi pack.', tokens: tokens ?? {}, escena: escena ?? {} });
    return { name: nombre };
  },
  // el ajuste fino de Opciones, sobre un pack propio: se suman los tokens cambiados
  guardar({ nombre, tokens }) {
    if (!NOMBRE.test(nombre ?? '') || !esPropio(nombre)) throw new Error('Sólo se guarda en un pack tuyo: los de fábrica no se tocan (creá uno con lo que ves).');
    const m = JSON.parse(fs.readFileSync(path.join(PACKS_PROPIOS, nombre, 'pack.json'), 'utf8'));
    escribirPack(nombre, { ...m, tokens: { ...(m.tokens ?? {}), ...(tokens ?? {}) } });
    return { name: nombre };
  },
  // a la papelera, no al vacío
  borrar({ nombre }) {
    if (!NOMBRE.test(nombre ?? '') || !esPropio(nombre)) throw new Error('Sólo se borra un pack tuyo.');
    const papelera = path.join(PACKS_PROPIOS, '.papelera');
    fs.mkdirSync(papelera, { recursive: true });
    const a = path.join(papelera, `${nombre}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.renameSync(path.join(PACKS_PROPIOS, nombre), a);
    return { papelera: a };
  },
};

let puerto = Number(values.puerto ?? positionals[0] ?? 4748);
const servidor = http.createServer((req, res) => {
  const pedido = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${puerto}` && host !== `localhost:${puerto}`) { res.writeHead(421); return res.end('host equivocado'); }

  if (req.method === 'POST') {
    const origen = req.headers.origin;
    if ((origen && origen !== `http://127.0.0.1:${puerto}` && origen !== `http://localhost:${puerto}`) || req.headers['x-mneme-token'] !== TOKEN) return json(res, 403, { error: 'Esta escritura no viene de la galaxia.' });
    const m = pedido.match(/^\/packs\/(crear|guardar|borrar)$/);
    if (!m) return json(res, 404, { error: 'no existe' });
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; if (cuerpo.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { json(res, 200, ACCIONES[m[1]](JSON.parse(cuerpo || '{}'))); } catch (e) { json(res, 422, { error: e.message }); }
    });
    return;
  }
  if (pedido === '/sesion.json') return json(res, 200, { token: TOKEN });
  if (pedido === '/primer-paso.json') return json(res, 200, primerPaso());
  if (pedido === '/packs.json') return json(res, 200, { carpeta: PACKS_PROPIOS, packs: listar() });
  if (pedido === '/guia-packs.md') return archivo(res, path.join(AQUI, '..', 'packs', 'COMO-HACER-UN-PACK.md'));
  const p = pedido.match(/^\/pack\/([a-z0-9][a-z0-9-]{0,63})\.json$/);
  if (p) {
    try {
      const { name, version, description, chain, tokens, escena, css } = loadPack(p[1], { format: 2 });
      return json(res, 200, { name, version, description, chain, tokens, escena, css, propio: esPropio(name) });
    } catch (e) { return json(res, 422, { error: e.message }); }
  }
  if (pedido.startsWith('/pack/')) return json(res, 400, { error: 'un pack se pide por su nombre: minúsculas, dígitos y guiones' });
  if (pedido === '/data.json' || pedido === '/textos.json') return archivo(res, path.join(DATOS, pedido.slice(1)));
  const f = path.resolve(AQUI, '.' + (pedido === '/' ? '/index.html' : pedido));
  if (!f.startsWith(AQUI + path.sep)) { res.writeHead(404); return res.end('no está'); }
  return archivo(res, f);
});

// si el puerto está ocupado (otra galaxia abierta), el siguiente
let intentos = 0;
servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && intentos++ < 10) { puerto++; servidor.listen(puerto, '127.0.0.1'); return; }
  console.error(`No se pudo abrir la galaxia: ${e.message}`); process.exit(1);
});
servidor.on('listening', () => {
  const url = `http://127.0.0.1:${puerto}/`;
  console.log(`\nMneme está abierto en ${url}\nDejá esta ventana abierta mientras lo uses; cerrala (o Ctrl+C) para apagarlo.`);
  if (values.abrir) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => console.log(`Abrilo vos: ${url}`)).unref(); } catch { console.log(`Abrilo vos: ${url}`); }
  }
});
servidor.listen(puerto, '127.0.0.1');
