// El registro del análisis (mapa ①.c, Análisis): corre `runEval` de Mneme sobre cada juego de
// casos y AGREGA una línea por juego a analisis.jsonl. Hoy no hay registro: `mneme eval --results`
// escribe los casos de una corrida y sobrescribe el archivo (propuesta de producto: .mneme/run/evals.jsonl);
// esto es el boceto de ese registro.
// Con `--uso <id>` (mapa ①.d, Probar) mide un uso de usos.mjs: le cambia la config EN MEMORIA y
// corre los mismos juegos. Se niega si el uso cambia el embedder o el corpus: medirlo reescribiría
// el índice de la raíz, y eso se hace en una copia.
// `--set clave=valor` (repetible) prueba un valor suelto encima, también en memoria (p. ej. el piso
// de coseno de otro modelo); `--registro <archivo>` escribe en otro lado (un barrido de calibración
// no ensucia el registro). Cada línea dice en qué raíz se midió: una copia se nota.
// No toca notas ni el libro; buscar sí pone al día el caché del índice de la raíz, como
// cualquier búsqueda de una sesión.
// Uso: node medir-analisis.mjs <raíz> [carpeta-de-casos=~/.claude/eval/mneme] [--uso <id>] [--set clave=valor]… [--registro <archivo>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRoot, listNotes } from '../src/root.js';
import { runEval } from '../src/eval.js';
import { DEFAULTS } from '../src/config.js';
import { USOS, aplicarUso, cambiaEmbedder, fusionar, parcheDe, validar } from './usos.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
/** Saca `--flag valor` de args (todas las veces que aparezca). */
const sacar = (flag) => { const out = []; for (let i; (i = args.indexOf(flag)) >= 0;) out.push(args.splice(i, 2)[1]); return out; };
const usoId = sacar('--uso').at(-1) ?? null;
const sets = sacar('--set');
const registroArg = sacar('--registro').at(-1);
const [rootDir, casosArg] = args;
if (!rootDir || sets.some((s) => !/^[\w.]+=/.test(s ?? ''))) { console.error('usage: node medir-analisis.mjs <root> [cases-dir] [--uso <id>] [--set key=value]… [--registro <file>]'); process.exit(2); }
const casosDir = casosArg ?? path.join(os.homedir(), '.claude', 'eval', 'mneme');
let root = openRoot(rootDir);
const salida = registroArg ? path.resolve(registroArg) : path.join(here, 'analisis.jsonl');
const ratio = (c) => ({ hit: c.hit, total: c.total });
// valor de --set: número si parece número, si no texto (validar lo marca si el tipo no va)
const leerValor = (t) => (t !== '' && Number.isFinite(Number(t)) ? Number(t) : t);
const parcheSets = parcheDe(sets.map((s) => { const [k, ...v] = s.split('='); return [k, undefined, leerValor(v.join('='))]; }));

if (usoId) {
  const uso = USOS.find((u) => u.id === usoId);
  if (!uso) { console.error(`no existe el uso «${usoId}»: ${USOS.map((u) => u.id).join(', ')}`); process.exit(2); }
  const notas = listNotes(root);
  const s = { bytes: notas.reduce((a, rel) => a + fs.statSync(path.join(root.dir, rel)).size, 0) };
  const config = aplicarUso(root.config, uso, s, DEFAULTS);
  const mal = validar(config, DEFAULTS);
  if (mal.length) { console.error(`«${uso.nombre}» deja la config inválida: ${mal.map(([, m]) => m).join('; ')}`); process.exit(2); }
  if (cambiaEmbedder(root.config, config)) {
    const e = config.embeddings;
    console.error([
      `«${uso.nombre}» cambia el embedder (${e.provider} · ${e.model}): medirlo aquí reescribiría los vectores de la raíz,`,
      'y las sesiones abiertas volverían a embeber todo con el suyo. Se mide en una copia:',
      `  1. copia la raíz a una carpeta temporal (notas y .mneme/)`,
      e.provider === 'ollama' ? `  2. ollama pull ${e.model}` : '  2. deja listo el módulo del embedder',
      `  3. pon la config del uso en <copia>/.mneme/config.json y ejecuta: mneme index --root <copia>`,
      `  4. node medir-analisis.mjs <copia> --uso ${uso.id}`,
    ].join('\n'));
    process.exit(3);
  }
  const probada = { ...root, config };
  if (listNotes(probada).join('\n') !== notas.join('\n')) {
    console.error(`«${uso.nombre}» cambia qué notas entran al corpus: medirlo aquí reescribiría el índice léxico de la raíz. Se mide en una copia.`);
    process.exit(3);
  }
  root = probada;
}
if (sets.length) {
  const config = fusionar(root.config, parcheSets);
  const mal = validar(config, DEFAULTS);
  if (mal.length) { console.error(`--set deja la config inválida: ${mal.map(([, m]) => m).join('; ')}`); process.exit(2); }
  if (cambiaEmbedder(root.config, config)) { console.error('--set cambia el embedder: medirlo reescribiría los vectores de la raíz. Se mide en una copia.'); process.exit(3); }
  if (listNotes({ ...root, config }).join('\n') !== listNotes(root).join('\n')) { console.error('--set cambia qué notas entran al corpus: medirlo reescribiría el índice léxico de la raíz. Se mide en una copia.'); process.exit(3); }
  root = { ...root, config };
}

for (const f of fs.readdirSync(casosDir).filter((x) => x.endsWith('.json')).sort()) {
  const casos = JSON.parse(fs.readFileSync(path.join(casosDir, f), 'utf8'));
  const t0 = Date.now();
  const r = await runEval([root], casos);
  const linea = {
    fecha: new Date().toISOString(),
    juego: f.replace(/\.json$/, ''),
    uso: usoId ?? 'vigente',
    ...(sets.length ? { set: parcheSets } : {}),
    raiz: path.basename(root.dir),
    casos: casos.length,
    lector: r.reader,
    degradado: r.degraded || null,
    nota: ratio(r.note), seccion: ratio(r.section), ajenos: ratio(r.none),
    dev: { nota: ratio(r.bySplit.dev.note), seccion: ratio(r.bySplit.dev.section), ajenos: ratio(r.bySplit.dev.none) },
    holdout: { nota: ratio(r.bySplit.holdout.note), seccion: ratio(r.bySplit.holdout.section), ajenos: ratio(r.bySplit.holdout.none) },
    fallas: r.failures.length,
    ms: Date.now() - t0,
  };
  fs.appendFileSync(salida, JSON.stringify(linea) + '\n');
  const x = (c) => `${c.hit}/${c.total}`;
  console.log(`${linea.juego.padEnd(24)} ${linea.uso.padEnd(9)} ${linea.lector}${linea.degradado ? ` (${linea.degradado})` : ''} · nota ${x(linea.nota)} · sección ${x(linea.seccion)} · ajenos ${x(linea.ajenos)} · ${linea.ms} ms`);
}
