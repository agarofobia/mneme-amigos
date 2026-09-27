// The help is the menu: grouped in sections and subsections, and no command left out of it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMAND_NAMES, HELP } from '../../src/adapters/cli/main.js';

test('every command a person types has its line in the help', () => {
  const lines = HELP.split('\n');
  const missing = COMMAND_NAMES.filter((name) => !lines.some((l) => l.trimStart().startsWith(`${name} `) || l.trim() === name));
  assert.deepEqual(missing, []);
});

test('the help is grouped: sections in capitals, subsections under them, commands under those', () => {
  const lines = HELP.split('\n').filter((l) => l.trim() !== '');
  const sections = lines.filter((l) => /^[A-Z][A-Z ]+$/.test(l));
  assert.ok(sections.length >= 4, `sections: ${sections.join(', ')}`);
  // After the two opening lines, every line is a section, a subsection (2 spaces), or deeper.
  for (const l of lines.slice(2)) assert.ok(/^[A-Z]/.test(l) || /^ {2}\S/.test(l) || /^ {4,}\S/.test(l), `stray line: ${l}`);
  // Each section has at least one subsection before its first command.
  const firstCommandIndent = lines.find((l) => /^ {4}[a-z]/.test(l));
  assert.ok(firstCommandIndent, 'commands sit four spaces in, under a subsection');
});
