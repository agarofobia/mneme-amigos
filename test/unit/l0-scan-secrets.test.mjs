// The secret scanner, both directions: a planted secret is caught, clean text passes.
// Fixtures are built here, in memory: a committed fake key would fail everyone's pre-commit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scan } from '../../scripts/scan-secrets.mjs';

/** @param {string} prefix @param {number} n */
const fake = (prefix, n) => prefix + 'A1b2C3d4'.repeat(n);

test('a planted key is caught with file and line', () => {
  const files = { 'src/a.js': `const x = 1;\nconst k = "${fake('ghp_', 4)}";\n` };
  const found = scan(Object.keys(files), (f) => files[/** @type {'src/a.js'} */ (f)]);
  assert.equal(found.length, 1);
  assert.match(found[0], /src\/a\.js:2: GitHub token/);
});

test('clean text passes, and allow-secret is an explicit escape', () => {
  const files = { 'src/b.js': `const ok = "hello";\nconst doc = "${fake('ghp_', 4)}"; // allow-secret\n` };
  assert.deepEqual(scan(Object.keys(files), (f) => files[/** @type {'src/b.js'} */ (f)]), []);
});

test('a .env file is refused whatever it contains', () => {
  assert.equal(scan(['.env.local'], () => '').length, 1);
  assert.equal(scan(['.env.example'], () => 'KEY=').length, 0);
});
