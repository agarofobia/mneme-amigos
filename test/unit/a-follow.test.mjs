// A superseded hit brings the section that replaced it (`follow`): the link forms it reads,
// where it stops, what it costs, and how the CLI, the MCP tool and the eval show it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeBareRoot } from '../helpers/fixture.mjs';
import { HOME_VAR, isolateHome, runCli } from '../aceptacion/l3-helpers.mjs';
import { createServer } from '../../src/adapters/mcp/server.js';
import { loadConfig } from '../../src/config.js';
import { runEval } from '../../src/eval.js';
import { openRoot } from '../../src/root.js';
import { MAX_HIT_CHARS, formatFollow, search } from '../../src/search.js';

const HOME = isolateHome(); // no registry but a temporary one, here and in the CLI processes
delete process.env.CLAUDE_CODE_SESSION_ID;
const NOW = new Date('2026-09-25T12:00:00Z');
const OLD = 'old plan migrate without rebuilding';

/** @param {string} dir @param {string} rel @param {string} text */
const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

/**
 * The follow of a note superseded by `link` (a frontmatter value, written quoted).
 * @param {string} link
 * @param {Record<string, string>} [extra]  more notes for the root
 * @param {object} [config]
 */
async function followOf(link, extra = {}, config = undefined) {
  const dir = makeBareRoot(config);
  put(dir, 'notes/gone.md', `---\nsuperseded_by: ${JSON.stringify(link)}\n---\n# Gone\n\nThe gone narwhal inventory.\n`);
  for (const [rel, text] of Object.entries(extra)) put(dir, rel, text);
  const { hits } = await search([openRoot(dir)], 'gone narwhal inventory', { reader: 'lexical', now: NOW });
  assert.equal(hits[0]?.rel, 'notes/gone.md');
  assert.match(hits[0].stale?.reason ?? '', /^superseded by /);
  return hits[0].follow;
}

test('link forms: wiki with alias, bare, a path, a relative markdown link, an encoded anchor, a nested heading', async () => {
  assert.equal((await followOf('[[alpha#Plan|the plan]]'))?.section?.key, '## Plan');
  assert.equal((await followOf('alpha#plan'))?.section?.key, '## Plan', 'without brackets, and the heading case-insensitive');
  assert.equal((await followOf('projects/alpha.md#Risks'))?.section?.key, '## Risks');
  assert.equal((await followOf('[the plan](../projects/alpha.md#Plan)'))?.section?.key, '## Plan');
  const gamma = { 'projects/gamma.md': '# Gamma\n\n## Rollout plan\n\nShip it in three waves.\n' };
  const encoded = await followOf('[x](../projects/gamma.md#Rollout%20plan)', gamma);
  assert.deepEqual([encoded?.rel, encoded?.section?.key], ['projects/gamma.md', '## Rollout plan']);
  assert.equal((await followOf('[[alpha#Alpha#Decisions]]'))?.section?.key, '## Decisions', 'A#B: a B inside an A');
  assert.equal(await followOf('[[alpha#Beta#Decisions]]').then((f) => f?.section), null, 'no Decisions inside a Beta: the whole note');
});

test('what leads nowhere gives no follow: a web address, a markdown link to one, an empty target', async () => {
  assert.equal(await followOf('https://example.com/alpha'), undefined);
  assert.equal(await followOf('[alpha](https://example.com/alpha.md)'), undefined);
  assert.equal(await followOf('[[#Plan]]'), undefined, 'a link inside the same note names no other note');
});

test('a heading brings its whole section, subsections included; the text is clipped like a hit', async () => {
  const whole = await followOf('[[alpha#Alpha]]');
  assert.equal(whole?.section?.key, '# Alpha');
  assert.match(whole?.text ?? '', /Rebuild the vector index/, 'from the Plan subsection');
  assert.match(whole?.text ?? '', /lexical fallback/, 'from the Decisions subsection');
  const long = await followOf('[[long#Body]]', { 'notes/long.md': `# Long\n\n## Body\n\n${'walrus '.repeat(600)}\n` });
  assert.ok((long?.text.length ?? 0) <= MAX_HIT_CHARS, `clipped to ${MAX_HIT_CHARS}`);
  assert.ok(long?.text.endsWith('…'));
});

test('a section marker is followed as a frontmatter one is; so is a metadata alias', async () => {
  const dir = makeBareRoot({ version: 1, metadataAliases: { superseded_by: ['replaced_by'] } });
  put(dir, 'notes/steps.md', '# Steps\n\n## Old step\n<!-- superseded-by: [[alpha#Risks]] -->\nThe old step doubled the quokka storage.\n\n## Other\n\nUnrelated.\n');
  put(dir, 'notes/aliased.md', '---\nreplaced_by: "[[alpha#Decisions]]"\n---\n# Aliased\n\nThe aliased pangolin rule.\n');
  const root = openRoot(dir);
  const marker = (await search([root], 'old step quokka storage', { reader: 'lexical', now: NOW })).hits[0];
  assert.deepEqual([marker?.section.key, marker?.follow?.rel, marker?.follow?.section?.key], ['## Old step', 'projects/alpha.md', '## Risks']);
  const aliased = (await search([root], 'aliased pangolin rule', { reader: 'lexical', now: NOW })).hits[0];
  assert.equal(aliased?.follow?.section?.key, '## Decisions');
});

test('a current section marked expired by its own marker is said, not followed', async () => {
  const follow = await followOf('[[later#Step]]', { 'notes/later.md': '# Later\n\n## Step\n<!-- expires: 2020-01-01 -->\nDone by then.\n' });
  assert.equal(follow?.section?.key, '## Step');
  assert.equal(follow?.stale?.reason, 'expired 2020-01-01');
  assert.ok(!('follow' in (follow ?? {})));
  assert.equal(formatFollow(/** @type {any} */ ({ follow })), '→ current: notes/later.md > Later > Step [STALE: expired 2020-01-01]');
});

test('the current section is looked for in the hit\'s own root only, and outside the search scope too', async () => {
  const a = makeBareRoot();
  const b = makeBareRoot();
  put(a, 'notes/gone.md', '---\nsuperseded_by: "[[zeta]]"\n---\n# Gone\n\nThe gone narwhal inventory.\n');
  put(b, 'notes/zeta.md', '# Zeta\n\nThe zeta inventory.\n');
  const both = await search([openRoot(a), openRoot(b)], 'gone narwhal inventory', { reader: 'lexical', now: NOW });
  const gone = both.hits.find((h) => h.rel === 'notes/gone.md');
  assert.ok(gone?.stale);
  assert.equal(gone?.follow, undefined, 'zeta lives in the other root');
  const scoped = await search([openRoot(makeBareRoot())], OLD, { reader: 'lexical', now: NOW, scope: ['notes'] });
  assert.ok(scoped.hits.every((h) => h.rel.startsWith('notes/')));
  assert.equal(scoped.hits[0]?.follow?.rel, 'projects/alpha.md', 'scope limits the hits, not where their link leads');
});

test('following reads nothing more: five superseded hits cost the same directory walks and file reads as marking them', async () => {
  /** @param {'follow'|'mark'} stale */
  const make = (stale) => {
    const dir = makeBareRoot({ version: 1, search: { stale } });
    for (let n = 1; n <= 5; n++) put(dir, `notes/s${n}.md`, `---\nsuperseded_by: "[[alpha#Plan]]"\n---\n# S${n}\n\nThe pelican ledger number ${n}.\n`);
    return openRoot(dir);
  };
  const follow = make('follow');
  const mark = make('mark');
  const query = 'pelican ledger';
  await search([follow], query, { reader: 'lexical', now: NOW, k: 10 }); // both indexes built before measuring
  await search([mark], query, { reader: 'lexical', now: NOW, k: 10 });
  /** @param {import('../../src/types.js').Root} root */
  const measure = async (root) => {
    const dirs = mock.method(fs, 'readdirSync');
    const files = mock.method(fs, 'readFileSync');
    try {
      const { hits } = await search([root], query, { reader: 'lexical', now: NOW, k: 10 });
      return { calls: { dirs: dirs.mock.callCount(), files: files.mock.callCount() }, followed: hits.filter((h) => h.follow).length };
    } finally {
      dirs.mock.restore();
      files.mock.restore();
    }
  };
  const withFollow = await measure(follow);
  const withMark = await measure(mark);
  assert.equal(withFollow.followed, 5);
  assert.equal(withMark.followed, 0);
  assert.ok(withMark.calls.dirs > 0 && withMark.calls.files > 0, 'control: the counters see the index refresh');
  assert.deepEqual(withFollow.calls, withMark.calls);
});

test('config: "follow" is the default, "mark" is accepted, anything else names search.stale', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mneme-a-config-'));
  /** @param {object} search */
  const load = (search) => {
    fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ search }));
    return loadConfig(state);
  };
  assert.deepEqual(load({ minLexical: 12.5, minCosine: 0.78 }).search, { k: 5, minLexical: 12.5, minLexicalRatio: 1, minCosine: 0.78, stale: 'follow' });
  assert.equal(load({ stale: 'mark' }).search.stale, 'mark');
  assert.throws(() => load({ stale: 42 }), { code: 'CONFIG_INVALID', message: /search\.stale/ });
  assert.throws(() => load({ stale: 'Follow' }), { code: 'CONFIG_INVALID', message: /search\.stale/ });
});

test('eval: a comment the clip cut open still does not count', async () => {
  const dir = makeBareRoot();
  const filler = 'pelican filler words '.repeat(50);
  put(dir, 'notes/cut.md', `# Cut\n\n## Pelican filler\n\n${filler}\n<!-- hidden target words ${'x '.repeat(200)}-->\n`);
  const root = openRoot(dir);
  const { hits } = await search([root], 'pelican filler', { reader: 'lexical', now: NOW });
  assert.match(hits[0]?.text ?? '', /<!-- hidden target words/, 'the clipped text ends inside the comment');
  assert.doesNotMatch(hits[0]?.text ?? '', /-->/);
  const report = await runEval([root], [{ query: 'pelican filler', want: ['cut'], wantText: 'hidden target words' }], { reader: 'lexical', now: NOW });
  assert.equal(report.section.hit, 0);
});

test('CLI: the current line comes after the hit\'s own text; without it, the output is the same as "mark"', async () => {
  const env = { [HOME_VAR]: HOME };
  const follow = makeBareRoot();
  const mark = makeBareRoot({ version: 1, search: { stale: 'mark' } });
  /** @param {string} dir @param {string} q */
  const run = async (dir, q) => {
    const r = await runCli(['search', q, '--reader', 'lexical', '--root', dir], { env });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout;
  };
  const followed = (await run(follow, OLD)).split('\n');
  const marked = (await run(mark, OLD)).split('\n');
  const at = followed.indexOf('  → current: projects/alpha.md > Alpha > Plan');
  assert.ok(at > 0, followed.join('\n'));
  assert.match(followed[0], /^notes\/old-plan\.md > Old plan \[STALE: superseded by \[\[alpha#Plan\]\]\]/);
  assert.ok(followed.slice(1, at).every((l) => l.startsWith('    ')), 'between the hit and the current line: only the hit\'s own text');
  assert.deepEqual(followed.filter((l) => !l.startsWith('  → current: ')), marked, 'the rest is byte for byte what "mark" prints');
  const plain = 'lexical fallback embedding service down';
  assert.equal(await run(follow, plain), await run(mark, plain), 'a search without superseded hits prints the same');
});

test('MCP: the search tool puts the current line and its text under the superseded hit', async () => {
  const root = openRoot(makeBareRoot());
  const { server } = createServer({ roots: [root], readOnly: true });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'a-follow', version: '0.0.0' });
  await client.connect(clientSide);
  try {
    const res = /** @type {any} */ (await client.callTool({ name: 'search', arguments: { query: OLD, reader: 'lexical', k: 1 } }));
    const text = res.content.map((/** @type {any} */ c) => c.text).join('\n');
    const lines = text.split('\n');
    const at = lines.indexOf('  → current: projects/alpha.md > Alpha > Plan');
    assert.ok(at > 0, text);
    assert.match(lines.slice(at + 1).join('\n'), /^ {4}## Plan\n[\s\S]*Rebuild the vector index/);
    assert.match(lines[0], /^notes\/old-plan\.md > Old plan \[STALE: /);
  } finally {
    await client.close();
  }
});
