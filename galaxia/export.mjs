// Boceto vivo de la GUI v2 (regla 14, ⑥ del mapa): exporta los datos REALES de una raíz a
// data.json para que el boceto se juzgue con la mente de verdad, no con una maqueta.
// Sólo lee: no toma el lock, no escanea, no indexa, no escribe nada en la raíz (para validar
// los usos con el loadConfig real escribe un config.json en una carpeta temporal y la borra).
// Uso: node export.mjs <raíz> [salida=data.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRoot, listNotes } from '../src/root.js';
import { findLinks, resolveTarget } from '../src/links.js';
import { readLedger } from '../src/ledger.js';
import { audit } from '../src/audit.js';
import { listRegisteredRoots } from '../src/registry.js';
import { DEFAULTS, loadConfig } from '../src/config.js';
import { parseNote } from '../src/sections.js';
import { frontmatterValue, isPinned, staleness } from '../src/readers/stale.js';
import { readDenials } from '../src/sessions.js';
import { USOS, aplicarUso, parecido, recomendar, validar } from './usos.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [rootDir, outArg] = process.argv.slice(2);
if (!rootDir) {
  console.error('usage: node export.mjs <root> [out]');
  process.exit(2);
}
const out = outArg ?? path.join(here, 'data.json');
const root = openRoot(rootDir);
const rels = listNotes(root);
const index = new Map(rels.map((r, i) => [r, i]));

// ── Las líneas: wikilinks y links markdown resueltos como los resuelve Mneme ──
// Se cuentan con dirección y con repeticiones, para poder decir cuál es «principal».
const directed = new Map(); // "i>j" → cuántas veces i menciona a j
const outDeg = new Array(rels.length).fill(0);
/** @type {string[]} */
const tipo = new Array(rels.length).fill('');
// Las notas que escribe un script (Artu, 26/09): su escritura «sin autor» no es algo mal, es su ciclo. Se le
// pregunta a la propia nota, no a una lista: `generado:` en el frontmatter, la carpeta `_generado/`, o su
// primera línea diciendo «generad(o|a) por `x.mjs`» (medido 26/09: así se declaran las 4 que había).
/** @type {(string|null)[]} */
const generadaPor = new Array(rels.length).fill(null);
let unresolved = 0;
// El texto de cada nota, para leerla y editarla en su ventana (Artu, 26/09 22:15). Va aparte de data.json
// (6 MB en el vault de Artu, medido 26/09) para que el espacio no espere: la página lo pide recién al abrir
// la primera nota. Es contenido: queda ignorado por git, como data.json, y el servidor sólo escucha en 127.0.0.1.
/** @type {Record<string, string>} */
const textosOut = {};
rels.forEach((rel, i) => {
  const text = fs.readFileSync(`${root.dir}/${rel}`, 'utf8');
  textosOut[rel] = text;
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const t = fm?.[1].match(/^tipo:\s*(.+)$/m);
  if (t) tipo[i] = t[1].trim().replace(/^["']|["']$/g, '');
  const g = fm?.[1].match(/^generado:\s*(.+)$/m);
  // «generado por `x.mjs`», o «Regenerar: `node …/x.mjs`» (así se declara Proyectos Activos, que tiene
  // una parte escrita a mano y la tabla generada: la escritura sin autor de esa nota es la del script).
  const cabeza = text.slice(0, 1200);
  const dicho = cabeza.match(/generad[oa]\**\s+(?:por|con)\s+\**`([\w./-]+\.m?js)`/i) ?? cabeza.match(/Regenerar:\s*`node\s+[^`]*?([\w.-]+\.m?js)/i);
  if (g) generadaPor[i] = g[1].trim().replace(/^["']|["']$/g, '');
  else if (dicho) generadaPor[i] = dicho[1];
  else if (rel.startsWith('_generado/')) generadaPor[i] = 'un generador';
  const seen = new Set();
  for (const link of findLinks(text)) {
    const target = resolveTarget(root, rel, link.target, { kind: link.kind, notes: rels });
    const j = target === null ? undefined : index.get(target);
    if (j === undefined) { unresolved++; continue; }
    if (j === i) continue;
    directed.set(`${i}>${j}`, (directed.get(`${i}>${j}`) ?? 0) + 1);
    if (!seen.has(j)) { seen.add(j); outDeg[i]++; }
  }
});
const und = new Map();
for (const [k, c] of directed) {
  const [a, b] = k.split('>').map(Number);
  const key = a < b ? `${a},${b}` : `${b},${a}`;
  const e = und.get(key) ?? { ab: 0, ba: 0 };
  if (a < b) e.ab += c; else e.ba += c;
  und.set(key, e);
}
// [a, b, flags]: bit 1 = mutua (se enlazan las dos), bit 2 = repetida (2+ menciones en total)
const edges = [...und].map(([k, e]) => {
  const [a, b] = k.split(',').map(Number);
  return [a, b, (e.ab > 0 && e.ba > 0 ? 1 : 0) | (e.ab + e.ba >= 2 ? 2 : 0)];
});
const deg = new Array(rels.length).fill(0);
for (const [a, b] of edges) { deg[a]++; deg[b]++; }

// ── La actividad: escrituras del libro y lecturas registradas por los hooks ──
const { entries } = readLedger(root);
const lastWrite = new Map();
/** @type {{t:string, rel:number, kind:string, s:string|null, what?:string}[]} */
const events = [];
for (const e of entries) {
  const i = index.get(e.rel);
  if (i === undefined || e.op === 'adopt') continue;
  lastWrite.set(e.rel, e.ts);
  const what = Array.isArray(e.changed) && e.changed.length ? String(e.changed[0]).slice(0, 90) : undefined;
  // Una escritura externa no tiene sesión: el libro la firma como «external», y eso no es una luz.
  // Si la nota se declara generada, esa escritura es de su script («script»): no pinta rojo.
  if (e.op === 'external' && generadaPor[i]) { events.push({ t: e.ts, rel: i, kind: 'script', s: null, what: generadaPor[i] }); continue; }
  events.push({ t: e.ts, rel: i, kind: e.op, s: e.op === 'external' ? null : (e.author?.session ?? null), what });
}
const readsDir = `${root.stateDir}/run/reads`;
for (const f of fs.existsSync(readsDir) ? fs.readdirSync(readsDir) : []) {
  const session = f.replace(/\.jsonl$/, '');
  for (const line of fs.readFileSync(`${readsDir}/${f}`, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const i = index.get(r.rel);
    if (i !== undefined) events.push({ t: r.ts, rel: i, kind: 'read', s: session });
  }
}
// Las escrituras que la guardia frenó (una sesión iba a sacar secciones de otra): «algo mal» en esa
// nota hasta que alguien la escriba bien (el material «estado» de las líneas, mapa ⑥.9).
for (const d of readDenials(root)) {
  const i = index.get(d.rel);
  if (i !== undefined) events.push({ t: d.ts, rel: i, kind: 'denied', s: d.session });
}
events.sort((a, b) => a.t.localeCompare(b.t));
// Vencida o reemplazada ENTERA (frontmatter), para la ficha de la nota (STALE). NO pinta las líneas de
// rojo: es el ciclo normal de una nota, no algo mal (mapa ⑥.9). Una sección vieja adentro de una nota
// vigente tampoco cuenta aquí: es historia bien marcada.
const hoy = new Date();
const vencida = rels.map((rel) => {
  try { return staleness(parseNote(fs.readFileSync(`${root.dir}/${rel}`, 'utf8')), null, hoy, root.config.metadataAliases)?.reason ?? null; } catch { return null; }
});
const sessions = [...new Set(events.map((e) => e.s).filter(Boolean))].map((id) => {
  const file = `${root.stateDir}/run/sessions/${id}.json`;
  let agent = 'unknown';
  try { agent = JSON.parse(fs.readFileSync(file, 'utf8')).author?.agent ?? agent; } catch { /* sesión sin archivo: ya terminó */ }
  return { id, agent };
});

// ── Tres maneras de agrupar: el «orden visual» sigue al orden de quien lo usa ──
// auto: la carpeta, bajando un nivel en toda carpeta que tenga más del 25 % de las notas
// (en este vault reproduce «un grupo por proyecto» sin saber qué es «10 - Proyectos»).
function groupAuto() {
  const depth = rels.map(() => 1);
  const key = (i) => {
    const p = rels[i].split('/');
    return p.length <= depth[i] ? (p.length === 1 ? '(raíz)' : p.slice(0, -1).join('/')) : p.slice(0, depth[i]).join('/');
  };
  for (let pass = 0; pass < 4; pass++) {
    const count = new Map();
    rels.forEach((_, i) => count.set(key(i), (count.get(key(i)) ?? 0) + 1));
    let changed = false;
    rels.forEach((r, i) => {
      if (count.get(key(i)) > 0.25 * rels.length && r.split('/').length > depth[i] + 1) { depth[i]++; changed = true; }
    });
    if (!changed) break;
  }
  return rels.map((_, i) => key(i));
}
const groupings = {
  auto: groupAuto(),
  top: rels.map((r) => (r.includes('/') ? r.split('/')[0] : '(raíz)')),
  tipo: tipo.map((t) => t || '(sin tipo)'),
};
// Los índices por nombre, genéricos: una portada «_Algo», «index», «inicio», «home», un MOC, o «… - índice».
// (El boceto de Artu nombraba los índices de su vault; esta entrega no trae nombres de nadie.)
const hubName = (rel) => /^(_|index$|indice$|índice$|inicio$|home$|moc\b)|.* - (índice|indice|index)$/i.test(path.posix.basename(rel, '.md'));
// El centro automático, genérico: las que enlazan a muchas (30+ salientes y 4× la mediana).
const medianOut = [...outDeg].sort((a, b) => a - b)[Math.floor(outDeg.length / 2)];
const hubAuto = (i) => outDeg[i] >= 30 && outDeg[i] >= 4 * Math.max(1, medianOut);

// ── Tres layouts, uno por respuesta a «¿qué es la profundidad?» ──
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Fuerza dirigida simple: repulsión entre todos, resortes en las líneas, gravedad al centro. */
function simulate(ids, links, { dims = 3, iters = 380, seed = 7, radius = 120 } = {}) {
  const n = ids.length;
  const rnd = mulberry32(seed);
  const P = new Float64Array(n * 3);
  const V = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) P[i] = i % 3 < dims ? (rnd() - 0.5) * 200 : 0;
  const d = new Array(n).fill(1);
  for (const [a, b] of links) { d[a]++; d[b]++; }
  for (let it = 0; it < iters; it++) {
    const alpha = 1 - it / iters;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = P[i * 3] - P[j * 3], dy = P[i * 3 + 1] - P[j * 3 + 1], dz = P[i * 3 + 2] - P[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz + 0.5;
        const f = Math.min(900 / d2, 40);
        V[i * 3] += dx * f / 10; V[i * 3 + 1] += dy * f / 10; V[i * 3 + 2] += dz * f / 10;
        V[j * 3] -= dx * f / 10; V[j * 3 + 1] -= dy * f / 10; V[j * 3 + 2] -= dz * f / 10;
      }
    }
    for (const [a, b] of links) {
      const dx = P[b * 3] - P[a * 3], dy = P[b * 3 + 1] - P[a * 3 + 1], dz = P[b * 3 + 2] - P[a * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
      const k = (0.05 / Math.sqrt(Math.min(d[a], d[b]))) * (dist - 16) / dist;
      V[a * 3] += dx * k; V[a * 3 + 1] += dy * k; V[a * 3 + 2] += dz * k;
      V[b * 3] -= dx * k; V[b * 3 + 1] -= dy * k; V[b * 3 + 2] -= dz * k;
    }
    for (let i = 0; i < n * 3; i++) {
      V[i] -= P[i] * 0.004;
      V[i] *= 0.55;
      if (i % 3 < dims) P[i] += V[i] * (0.2 + alpha);
    }
  }
  // normaliza al percentil 95 del radio
  const r = [];
  for (let i = 0; i < n; i++) r.push(Math.hypot(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
  const r95 = r.sort((a, b) => a - b)[Math.floor(n * 0.95)] || 1;
  return ids.map((_, i) => [0, 1, 2].map((k) => +(P[i * 3 + k] * radius / r95).toFixed(2)));
}

const all = rels.map((_, i) => i);
const t0 = Date.now();
const base3d = simulate(all, edges, { dims: 3 });
const flat2d = simulate(all, edges, { dims: 2, seed: 11, radius: 150 });

// tiempo: lo último tocado adelante, lo viejo se hunde (por rango, para que no se amontone)
const touched = rels.map((rel) => {
  const m = fs.statSync(`${root.dir}/${rel}`).mtime.toISOString();
  const w = lastWrite.get(rel);
  return w && w > m ? w : m;
});
const order = all.slice().sort((a, b) => touched[b].localeCompare(touched[a]));
const rank = new Array(rels.length);
order.forEach((i, r) => { rank[i] = r / (rels.length - 1); });
const time = all.map((i) => [flat2d[i][0] * (0.6 + rank[i] * 1.2), flat2d[i][1] * (0.6 + rank[i] * 1.2), +(40 - rank[i] * 520).toFixed(2)]);

// peso: lo más conectado al centro, en la dirección que le dio el layout base
const maxDeg = Math.max(...deg);
const weight = all.map((i) => {
  const [x, y, z] = base3d[i];
  const len = Math.hypot(x, y, z) || 1;
  const r = 12 + 150 * (1 - Math.log1p(deg[i]) / Math.log1p(maxDeg));
  return [x, y, z].map((v) => +(v / len * r).toFixed(2));
});

// ── Orden: tres formas por cada manera de agrupar ──
const fib = (k, n) => {
  const phi = Math.acos(1 - 2 * (k + 0.5) / n), theta = Math.PI * (1 + Math.sqrt(5)) * k;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
};
const round = (v) => v.map((x) => +x.toFixed(2));
/** @param {string[]} groupOf */
function orderLayouts(groupOf) {
  const names = [...new Set(groupOf)];
  const bySize = names.map((g) => ({ g, ids: all.filter((i) => groupOf[i] === g).sort((a, b) => deg[b] - deg[a]) }))
    .sort((a, b) => b.ids.length - a.ids.length);
  const regions = new Array(rels.length), sphere = new Array(rels.length), galaxies = new Array(rels.length);
  // regiones: cada grupo, una nube sobre una esfera; adentro, su propio layout de fuerzas
  bySize.forEach(({ ids }, k) => {
    const c = fib(k, bySize.length).map((v, a) => v * 150 * (a === 1 ? 0.7 : 1));
    const local = new Map(ids.map((id, j) => [id, j]));
    const inner = edges.filter(([a, b]) => local.has(a) && local.has(b)).map(([a, b]) => [local.get(a), local.get(b)]);
    const pos = ids.length > 1 ? simulate(ids, inner, { iters: 200, seed: 3 + k, radius: 7 * Math.cbrt(ids.length) + 4 }) : [[0, 0, 0]];
    ids.forEach((id, j) => { regions[id] = round(pos[j].map((v, a) => v + c[a])); });
  });
  // esfera: todas las notas sobre una sola esfera; cada grupo, un territorio contiguo
  // (asignación greedy con capacidad: cada punto al centro de grupo libre más cercano)
  const R = 175, pts = all.map((k) => fib(k, rels.length));
  const centers = bySize.map((_, k) => fib(k, bySize.length));
  const pairs = [];
  pts.forEach((p, pi) => centers.forEach((c, gi) => pairs.push([1 - (p[0] * c[0] + p[1] * c[1] + p[2] * c[2]), pi, gi])));
  pairs.sort((a, b) => a[0] - b[0]);
  const taken = new Set(), slots = bySize.map(() => []);
  for (const [, pi, gi] of pairs) if (!taken.has(pi) && slots[gi].length < bySize[gi].ids.length) { taken.add(pi); slots[gi].push(pi); }
  bySize.forEach(({ ids }, gi) => ids.forEach((id, j) => { sphere[id] = round(pts[slots[gi][j]].map((v) => v * R)); }));
  // galaxias: cada grupo, un disco espiral de dos brazos, inclinado a su manera; lo más
  // conectado en el núcleo
  const rnd = mulberry32(42);
  const galaxyMeta = new Array(names.length);
  bySize.forEach(({ g, ids }, k) => {
    // 260 y 0,7 (antes 210 y 0,6): la lente de efectos vio dos galaxias grandes pisándose.
    const c = fib(k, bySize.length).map((v, a) => v * 260 * (a === 1 ? 0.7 : 1));
    const nrm = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const nl = Math.hypot(...nrm) || 1; nrm.forEach((_, a) => { nrm[a] /= nl; });
    const ref = Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = [nrm[1] * ref[2] - nrm[2] * ref[1], nrm[2] * ref[0] - nrm[0] * ref[2], nrm[0] * ref[1] - nrm[1] * ref[0]];
    const ul = Math.hypot(...u); u.forEach((_, a) => { u[a] /= ul; });
    const v = [nrm[1] * u[2] - nrm[2] * u[1], nrm[2] * u[0] - nrm[0] * u[2], nrm[0] * u[1] - nrm[1] * u[0]];
    const galR = 9 + 7.5 * Math.sqrt(ids.length);
    // el boceto dibuja el polvo de estrellas de cada galaxia sobre este mismo disco
    galaxyMeta[names.indexOf(g)] = { c: round(c), u: round(u), v: round(v), n: round(nrm), r: +galR.toFixed(2), size: ids.length };
    ids.forEach((id, j) => {
      const r = j === 0 ? 0 : galR * Math.sqrt(j / ids.length);
      const th = (j % 2) * Math.PI + r * 0.075 + (rnd() - 0.5) * 0.5;
      const h = (rnd() - 0.5) * 5 * (1 - r / galR);
      galaxies[id] = round([0, 1, 2].map((a) => c[a] + (u[a] * Math.cos(th) + v[a] * Math.sin(th)) * r + nrm[a] * h));
    });
  });
  return { names, index: groupOf.map((g) => names.indexOf(g)), regions, sphere, galaxies, galaxyMeta };
}
const byGrouping = Object.fromEntries(Object.entries(groupings).map(([k, g]) => [k, orderLayouts(g)]));

// ── Lo que la raíz tiene (mapa ①.d): las señales de las que sale el uso recomendado ──
// Palabras vacías frecuentes de cada idioma: alcanzan para decir en qué está escrito el corpus.
const VACIAS = {
  es: new Set(['que', 'los', 'las', 'del', 'para', 'una', 'por', 'con', 'como', 'pero', 'más', 'está', 'esto', 'también', 'cuando', 'donde']),
  en: new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'but', 'have', 'when', 'where', 'also', 'which']),
};
function senales() {
  const aliases = root.config.metadataAliases;
  const hace14 = Date.now() - 14 * 864e5, hace7 = new Date(Date.now() - 7 * 864e5).toISOString();
  let bytes = 0, codigo = 0, frontmatter = 0, fijas = 0, vencen = 0, recientes = 0, es = 0, en = 0;
  for (const rel of rels) {
    const file = `${root.dir}/${rel}`, text = fs.readFileSync(file, 'utf8');
    bytes += Buffer.byteLength(text);
    if (/^\s*(```|~~~)/m.test(text)) codigo++;
    const parsed = parseNote(text);
    if (Object.keys(parsed.frontmatter.data).length) frontmatter++;
    if (isPinned(parsed, aliases)) fijas++;
    if (frontmatterValue(parsed, 'expires', aliases) || frontmatterValue(parsed, 'superseded_by', aliases)) vencen++;
    if (fs.statSync(file).mtimeMs >= hace14) recientes++;
    for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) { if (VACIAS.es.has(w)) es++; else if (VACIAS.en.has(w)) en++; }
  }
  const escritores = new Set(entries.filter((e) => e.ts >= hace7 && e.op !== 'adopt' && e.op !== 'external').map((e) => e.author?.session).filter(Boolean));
  const n = rels.length || 1;
  return {
    notas: rels.length, bytes, tokens: Math.round(bytes / 4),
    idioma: { es: es / ((es + en) || 1), en: en / ((es + en) || 1) },
    codigo: codigo / n, cambio14: recientes / n, frontmatter, fijas, vencen,
    escritores7: escritores.size, enlacesPorNota: (2 * edges.length) / n,
  };
}

// La config sin lo que no debe viajar: embeddings.options puede llevar credenciales de otro
// proveedor, y la URL del embedder puede traer usuario y clave.
function sinSecretos(c) {
  const x = structuredClone(c);
  delete x.embeddings.options;
  try { const u = new URL(x.embeddings.url); u.username = ''; u.password = ''; x.embeddings.url = u.toString().replace(/\/$/, ''); } catch { /* no es una URL: queda como está */ }
  return x;
}

// Cada uso, validado con el loadConfig REAL (una clave que no existe tira la raíz y los hooks de
// todas las sesiones), y comparado contra la copia de sus reglas en usos.mjs para cazar la divergencia.
function validarUsos(vigente, defaults, s) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-usos-'));
  try {
    return USOS.map((u) => {
      const cfg = aplicarUso(vigente, u, s, defaults);
      fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
      let motivo = null;
      try { loadConfig(tmp); } catch (e) { motivo = String(e.message).replace(/^config\.json:\s*/, ''); }
      const copia = validar(cfg, defaults).map(([, m]) => m);
      if ((motivo === null) !== (copia.length === 0) || (motivo && !copia.includes(motivo))) {
        console.warn(`⚠️ usos.mjs validar() diverge de loadConfig en «${u.id}»: real=${motivo ?? 'ok'} · copia=${copia.join(' | ') || 'ok'}`);
      }
      return { id: u.id, valido: motivo === null, motivo };
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Los modelos que tiene el Ollama de la config: dicen qué uso se prueba sin bajar nada. Una
// consulta local de sólo lectura; si no responde, no se sabe (null), que no es «ninguno».
async function modelosOllama(c) {
  try {
    const r = await fetch(new URL('/api/tags', c.embeddings.url), { signal: AbortSignal.timeout(1500) });
    return ((await r.json()).models ?? []).map((m) => String(m.name).replace(/:latest$/, ''));
  } catch { return null; }
}
const modelos = await modelosOllama(root.config);

// ── Lo del menú (mapa ①.c): El orden, Análisis, Salud, Perfil. Todo de sólo lectura. ──
function sistema() {
  const config = sinSecretos(root.config);
  const defaults = sinSecretos(DEFAULTS);
  const s = senales();
  const usos = { senales: s, recomendado: recomendar(s), parecido: parecido(config, s), validez: validarUsos(config, defaults, s), modelos };
  const idx = `${root.stateDir}/index`;
  let vectores = null;
  try {
    const v = JSON.parse(fs.readFileSync(`${idx}/vectors.json`, 'utf8'));
    vectores = { modelo: v.model, dims: v.dims, secciones: Object.keys(v.vectors ?? {}).length, actualizado: fs.statSync(`${idx}/vectors.json`).mtime.toISOString() };
  } catch { /* sin índice de vectores: la búsqueda es léxica */ }
  const casosDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'eval', 'mneme');
  const juegos = fs.existsSync(casosDir)
    ? fs.readdirSync(casosDir).filter((f) => f.endsWith('.json')).map((f) => ({ juego: f.replace(/\.json$/, ''), casos: JSON.parse(fs.readFileSync(path.join(casosDir, f), 'utf8')).length }))
    : [];
  const regFile = path.join(here, 'analisis.jsonl');
  const registro = fs.existsSync(regFile) ? fs.readFileSync(regFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const a = audit(root);
  const salud = {
    perdidas: a.losses.map((l) => ({ kind: l.kind, detail: l.detail })),
    choques: a.clashes.length, bifurcaciones: a.clashes.filter((x) => x.fork).length, abiertos: a.clashes.filter((x) => x.state === 'open').length,
    autorizadas: a.authorized.length, frenadas: a.denials.length, sinAsentar: a.unrecorded.length, libro: a.ledger, asientos: a.entries,
  };
  const autores = new Map();
  for (const e of entries) {
    const gen = e.op === 'external' && index.has(e.rel) ? generadaPor[index.get(e.rel)] : null;
    const quien = gen ? `script (${gen})` : e.op === 'external' ? 'externa (sin autor)' : `${e.author?.user ?? '?'}@${e.author?.host ?? '?'}`;
    const k = `${quien}|${e.author?.agent ?? '?'}`;
    const x = autores.get(k) ?? { quien, agente: e.author?.agent ?? '?', escrituras: 0, adopciones: 0, primero: e.ts, ultimo: e.ts };
    if (e.op === 'adopt') x.adopciones++; else x.escrituras++;
    x.ultimo = e.ts;
    autores.set(k, x);
  }
  let raices = [];
  try { raices = listRegisteredRoots().map((r) => (typeof r === 'string' ? r : r.dir)); } catch { /* sin registro */ }
  const perfil = { tu: `${os.userInfo().username}@${os.hostname()}`, autores: [...autores.values()].sort((x, y) => y.escrituras - x.escrituras), raices };
  return { config, defaults, usos, analisis: { vectores, juegos, registro }, salud, perfil };
}

const data = {
  generated: new Date().toISOString(),
  sistema: sistema(),
  root: path.basename(root.dir),
  groupings: Object.fromEntries(Object.entries(byGrouping).map(([k, v]) => [k, v.names])),
  galaxies: Object.fromEntries(Object.entries(byGrouping).map(([k, v]) => [k, v.galaxyMeta])),
  nodes: rels.map((rel, i) => ({
    rel,
    name: path.posix.basename(rel, '.md'),
    group: Object.fromEntries(Object.entries(byGrouping).map(([k, v]) => [k, v.index[i]])),
    deg: deg[i],
    out: outDeg[i],
    touched: touched[i],
    ...(vencida[i] ? { stale: vencida[i] } : {}),
    hub: { name: hubName(rel), auto: hubAuto(i) },
    layout: {
      time: time[i],
      weight: weight[i],
      ...Object.fromEntries(Object.entries(byGrouping).flatMap(([k, v]) => [[`${k}.regions`, v.regions[i]], [`${k}.sphere`, v.sphere[i]], [`${k}.galaxies`, v.galaxies[i]]])),
    },
  })),
  edges,
  events,
  sessions,
  stats: { notes: rels.length, edges: edges.length, unresolved, isolated: deg.filter((x) => x === 0).length, events: events.length, layoutMs: Date.now() - t0 },
};
fs.writeFileSync(out, JSON.stringify(data));
console.log(JSON.stringify(data.stats), '→', out, `${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
const outTextos = path.join(path.dirname(out), 'textos.json');
fs.writeFileSync(outTextos, JSON.stringify(textosOut));
console.log(`${rels.length} textos →`, outTextos, `${(fs.statSync(outTextos).size / 1024).toFixed(0)} KB`);
