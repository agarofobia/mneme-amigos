// R6 (informe QoL 26/09, B1) y Artu 27/09: «es agnóstico a la AI que usen» (un amigo usa Qwen con Ollama
// dentro de Odysseus, que lanza servidores MCP por stdio). Un cliente que no es Claude Code no trae id de
// sesión: cada arranque era un «mcp-xxxx» nuevo y, después de reiniciarse, el agente no podía reescribir
// sus propias secciones. `mneme mcp --session <nombre>` le da una identidad que dura.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BIN, HOME_VAR, adoptedRoot, isolateHome, runCli } from './l3-helpers.mjs';
import { readLedger } from '../../src/ledger.js';

const home = isolateHome();
/** @type {Client[]} */
const opened = [];
after(async () => {
  await Promise.allSettled(opened.map((c) => c.close()));
});

/** Un arranque del servidor, como lo haría Odysseus: sin CLAUDE_CODE_SESSION_ID. @param {string[]} args */
async function arrancar(args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp', ...args],
    env: { ...(/** @type {Record<string, string>} */ (process.env)), [HOME_VAR]: home, CLAUDE_CODE_SESSION_ID: '' },
  });
  const client = new Client({ name: 'odysseus-like', version: '0.0.0' });
  await client.connect(transport);
  opened.push(client);
  return client;
}
/** @param {any} r */
const texto = (r) => r.content.map((/** @type {any} */ c) => c.text).join('\n');
const NOTA = 'agent/summary.md';

test('con --session, un agente reiniciado reescribe sus propias secciones; sin nombre, no', async () => {
  const root = await adoptedRoot();
  const primero = await arrancar(['--root', root.dir, '--session', 'qwen']);
  const creada = await primero.callTool({ name: 'write_note', arguments: { path: NOTA, content: '# Summary\n\n## Monday\n\nfirst run\n', reason: 'daily summary' } });
  assert.notEqual(creada.isError, true, texto(creada));
  await primero.close();

  // «reiniciado»: otro proceso, mismo nombre
  const despues = await arrancar(['--root', root.dir, '--session', 'qwen']);
  const reescrita = await despues.callTool({ name: 'write_note', arguments: { path: NOTA, content: '# Summary\n\n## Tuesday\n\nsecond run\n', reason: 'daily summary' } });
  assert.notEqual(reescrita.isError, true, `el mismo agente puede sacar su sección: ${texto(reescrita)}`);
  const autores = readLedger(root).entries.filter((e) => e.rel === NOTA).map((e) => e.author.session);
  assert.deepEqual(autores, ['qwen', 'qwen'], 'las dos escrituras llevan su nombre');

  // otro agente sin nombre (un id nuevo) no puede sacar lo que escribió qwen
  const otro = await arrancar(['--root', root.dir]);
  const negada = await otro.callTool({ name: 'write_note', arguments: { path: NOTA, content: '# Summary\n', reason: 'cleanup' } });
  assert.equal(negada.isError, true);
  assert.match(texto(negada), /removes sections written by another session/);
});

test('--print da la configuración para pegar en el cliente; un nombre inválido se rechaza con el porqué', async () => {
  const root = await adoptedRoot();
  const r = await runCli(['mcp', '--root', root.dir, '--session', 'qwen', '--print']);
  assert.equal(r.code, 0, r.stderr);
  const cfg = JSON.parse(r.stdout).mcpServers.mneme;
  assert.equal(cfg.command, process.execPath, 'la ruta absoluta de node: el cliente puede no tenerlo en su PATH');
  assert.ok(cfg.args[0].endsWith('mneme.js'));
  assert.deepEqual(cfg.args.slice(1), ['mcp', '--root', root.dir, '--session', 'qwen']);
  const sinNombre = await runCli(['mcp', '--root', root.dir, '--print']);
  assert.match(sinNombre.stderr, /--session <name>/, 'sin nombre, avisa por qué conviene');
  const mal = await runCli(['mcp', '--root', root.dir, '--session', 'dos palabras', '--print']);
  assert.equal(mal.code, 2);
  assert.match(mal.stderr, /--session is a name/);
});
