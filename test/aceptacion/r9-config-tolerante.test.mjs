// §4.3, cambiado el 26/09 (Artu: «que una invalidez use su valor por defecto»; informe QoL, R9 + R1 + R2).
// Antes, un error de tipeo en config.json dejaba la raíz sin abrir: los hooks la salteaban y la guardia
// se apagaba en todas las sesiones sin una palabra (F1, medido con "serch": {}). Ahora la raíz abre con
// los defaults de lo que el archivo tiene mal, y eso se dice fuerte: en la sesión, en doctor, en la CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { adoptedRoot, isolateHome, runCli } from './l3-helpers.mjs';
import { handleHook } from '../../src/adapters/claude-code/hooks.js';
import { loadConfig, readConfig } from '../../src/config.js';
import { registerRoot } from '../../src/registry.js';
import { writeNote } from '../../src/store.js';

isolateHome();
const GAMMA = 'projects/gamma.md';
const WITH_A = "# Gamma\n\n## A's part\n\nby A\n";
/** @param {string} session @param {string} tool @param {object} input @param {string} [id] */
const pre = (session, tool, input, id) => ({ hook_event_name: 'PreToolUse', session_id: session, tool_name: tool, tool_input: input, tool_use_id: id, cwd: os.tmpdir() });
/** @param {unknown} out */
const contexto = (out) => String(/** @type {any} */ (out)?.hookSpecificOutput?.additionalContext ?? '');

test('F1: con un error de tipeo en config.json la guardia sigue negando, y la sesión se entera hasta que se arregla', async () => {
  const root = await adoptedRoot();
  await writeNote(root, GAMMA, WITH_A, { author: { session: 'session-a', agent: 'claude-code' }, reason: 'create' });
  const config = path.join(root.stateDir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, serch: {} }));

  const file = path.join(root.dir, GAMMA);
  const out = await handleHook(pre('session-b', 'Write', { file_path: file, content: '# Gamma\n' }, 'tu-1'));
  assert.equal(/** @type {any} */ (out)?.hookSpecificOutput?.permissionDecision, 'deny', 'la guardia no se apagó');
  assert.equal(fs.readFileSync(file, 'utf8'), WITH_A);

  registerRoot(root.dir);
  const inicio = contexto(await handleHook({ hook_event_name: 'SessionStart', session_id: 'session-c', cwd: os.tmpdir() }));
  assert.match(inicio, /config\.json has a problem: unknown key "serch" \(did you mean "search"\?\): ignored/);
  assert.match(inicio, /doctor --root/);
  const prompt = contexto(await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'session-c', prompt: 'hola', cwd: os.tmpdir() }));
  assert.match(prompt, /config\.json has a problem/, 'se repite en cada prompt mientras siga mal');

  fs.writeFileSync(config, JSON.stringify({ version: 1 }));
  const arreglado = contexto(await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'session-c', prompt: 'otra', cwd: os.tmpdir() }));
  assert.doesNotMatch(arreglado, /config\.json has/, 'arreglado, deja de decirlo');
});

test('lo que no se puede usar vuelve a su default, que es el lado seguro; la lectura estricta lo sigue rechazando', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-config-'));
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1, guard: 'off', guardLevels: 'two', wakeUpBudget: 50,
    embeddings: { provider: 'module' }, search: { k: '5', minCosine: 3 },
  }));
  const { config, problems } = readConfig(state);
  assert.equal(config.guard, 'deny', 'una guardia mal escrita niega, no deja pasar');
  assert.equal(config.guardLevels, 2);
  assert.equal(config.wakeUpBudget, 0);
  assert.equal(config.embeddings.provider, 'none', 'un proveedor sin su archivo cae a la búsqueda por palabras');
  assert.equal(config.search.k, 5);
  assert.equal(config.search.minCosine, 1);
  for (const k of ['guard', 'guardLevels', 'wakeUpBudget', 'embeddings.module', 'search.k', 'search.minCosine']) {
    assert.ok(problems.some((p) => p.includes(`"${k}"`)), `el problema nombra ${k}: ${problems.join(' | ')}`);
  }
  assert.ok(problems.every((p) => /: using the default|: ignored/.test(p)), 'cada problema dice qué se hizo');
  assert.throws(() => loadConfig(state), { code: 'CONFIG_INVALID' });
});

test('un BOM no es un error; un JSON roto usa todos los defaults y lo dice', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-config-'));
  fs.writeFileSync(path.join(state, 'config.json'), '﻿' + JSON.stringify({ version: 1, search: { k: 7 } }));
  assert.deepEqual(readConfig(state).problems, []);
  assert.equal(loadConfig(state).search.k, 7, 'tampoco para la lectura estricta');
  fs.writeFileSync(path.join(state, 'config.json'), '{ "version": 1, ');
  const roto = readConfig(state);
  assert.equal(roto.config.guard, 'deny');
  assert.match(roto.problems[0], /not valid JSON.*using all the defaults/);
});

test('doctor falla en config; los demás comandos lo avisan una sola vez por stderr', async () => {
  const root = await adoptedRoot();
  fs.writeFileSync(path.join(root.stateDir, 'config.json'), JSON.stringify({ version: 1, serch: {} }));
  const doctor = await runCli(['doctor', '--root', root.dir]);
  assert.match(doctor.stdout, /fail\s+config: .*unknown key "serch"/);
  assert.doesNotMatch(doctor.stderr, /config\.json/, 'doctor lo dice en su lista, no dos veces');
  const buscar = await runCli(['search', 'deploy', '--root', root.dir]);
  assert.equal(buscar.code, 0, buscar.stderr);
  assert.equal(buscar.stderr.match(/config\.json:/g)?.length, 1, buscar.stderr);
  assert.match(buscar.stderr, /did you mean "search"/);
});
