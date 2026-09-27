// The first-time questionnaire and the person's own rules file (Artu, 2026-09-26): the workspace assets
// agree with each other, and a rules file with a line that has no origin mark is caught.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** @param {string} f */
const ws = (f) => fs.readFileSync(fileURLToPath(new URL(`../../scripts/workspace/${f}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const installer = fs.readFileSync(fileURLToPath(new URL('../../scripts/install-windows.ps1', import.meta.url)), 'utf8');

/** The rule lines of a rules.md (a bullet before `## Retired`, or after it), with whether their mark is valid. */
const MARK = /\s—\s(?:declared \(questionnaire, \d{4}-\d{2}-\d{2}(?:; against \d{4}-\d{2}-\d{2})?\)|confirmed \(\d{4}-\d{2}-\d{2}(?:; declared \d{4}-\d{2}-\d{2})?\)|retired \(\d{4}-\d{2}-\d{2}: [^)]+\))$/;
/** @param {string} text @returns {string[]} */
export function rulesWithoutOrigin(text) {
  return text.split('\n').filter((l) => /^- \S/.test(l) && !MARK.test(l.trimEnd()));
}

test('the questionnaire has 8 to 12 questions, each with why, rule, examples and when no rule comes out', () => {
  const q = ws('questionnaire.md');
  const questions = q.split(/\n(?=\*\*\d{1,2}\. )/).slice(1);
  assert.ok(questions.length >= 8 && questions.length <= 12, `${questions.length} questions`);
  for (const block of questions) {
    const title = block.split('\n')[0];
    assert.match(block, /- Why: .+ Rule: /, `${title}: why + rule type`);
    assert.match(block, /- E\.g\. `/, `${title}: examples`);
    assert.match(block, /- No rule: /, `${title}: when no rule comes out`);
  }
});

test('the questionnaire declares every state of a rule line, and its example lines pass the check', () => {
  const q = ws('questionnaire.md');
  for (const state of ['declared (questionnaire', 'confirmed (YYYY-MM-DD; declared', 'retired (YYYY-MM-DD', '; against YYYY-MM-DD']) assert.ok(q.includes(state), state);
  const samples = [
    '- No emojis. — declared (questionnaire, 2026-09-26)',
    '- No emojis. — confirmed (2026-10-02; declared 2026-09-26)',
    '- Ask before deleting files. — confirmed (2026-10-02)',
    '- No emojis. — declared (questionnaire, 2026-09-26; against 2026-10-01)',
    '- No emojis. — retired (2026-10-05: they wanted them after all)',
  ];
  assert.deepEqual(rulesWithoutOrigin(samples.join('\n')), []);
});

test('a rule without its origin mark is caught', () => {
  const bad = ['- Answer in Spanish.', '- No emojis — declared', '- Short answers. — declared (questionnaire, 26/09/2026)'];
  assert.deepEqual(rulesWithoutOrigin(bad.join('\n')), bad);
});

test('the rules template starts empty, not offered, and with no rule lines', () => {
  const r = ws('rules.md');
  assert.match(r, /^questionnaire: not offered$/m);
  assert.match(r, /\(no rules yet\)/);
  assert.deepEqual(rulesWithoutOrigin(r), []);
});

test('the workspace rules import rules.md, point to the questionnaire and name the three states of the offer', () => {
  const c = ws('CLAUDE.md');
  assert.match(c, /^@rules\.md$/m);
  assert.ok(c.includes('questionnaire.md'));
  for (const s of ['questionnaire: not offered', 'questionnaire: done', 'questionnaire: declined']) assert.ok(c.includes(s), s);
});

test('the first-run window has its texts in both languages, and the message asks for the questionnaire', () => {
  const j = JSON.parse(ws('first-run.json'));
  for (const lang of ['es', 'en']) {
    for (const k of ['title', 'explain', 'prompt', 'copy', 'copied', 'close', 'file', 'fileNote']) assert.ok(j[lang]?.[k], `${lang}.${k}`);
  }
  assert.match(j.es.prompt, /cuestionario/);
  assert.match(j.en.prompt, /questionnaire/);
});

// Artu (26/09 22:15): «que la ventana aparezca dentro de mneme». The first-step window lives in the galaxy
// (galaxia/), which reads the same first-run.json; the installer writes the message and opens Mneme.
test('the installer writes the first step while the questionnaire was not offered, and opens Mneme unless -Yes', () => {
  assert.match(installer, /questionnaire: not offered[\s\S]{0,200}first-step\.ps1/);
  assert.match(installer, /if \(-not \$Yes\) \{\s*Start-Process -FilePath \$Launcher/);
  assert.match(installer, /'Abrir Mneme\.cmd'[\s\S]{0,400}galaxia --root/);
  const step = fs.readFileSync(fileURLToPath(new URL('../../scripts/first-step.ps1', import.meta.url)), 'utf8');
  assert.equal(/[^\x00-\x7F]/.test(step), false, 'the script stays ASCII: its texts live in first-run.json');
  assert.match(step, /first-run\.json/);
  assert.doesNotMatch(step, /Windows\.Forms/, 'the window is the galaxy\'s, not a second one');
  const galaxia = fs.readFileSync(fileURLToPath(new URL('../../galaxia/servir.mjs', import.meta.url)), 'utf8');
  assert.match(galaxia, /scripts', 'workspace', 'first-run\.json'/, 'the galaxy reads the same texts: one owner');
  assert.match(galaxia, /questionnaire:\\s\*not offered/);
});

test('the installer refreshes the questionnaire and never overwrites the person\'s rules', () => {
  assert.match(installer, /Copy-Item[^\n]*'questionnaire\.md'[^\n]*-Force/);
  assert.match(installer, /if \(Test-Path -LiteralPath \$OwnRules\)[\s\S]{0,200}else[\s\S]{0,120}Copy-Item[^\n]*'rules\.md'/);
  assert.equal(/[^\x00-\x7F]/.test(installer), false, 'the .ps1 stays ASCII (PowerShell 5.1 reads a BOM-less file as ANSI)');
});
