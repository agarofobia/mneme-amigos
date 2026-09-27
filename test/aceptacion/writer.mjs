// Child process for the concurrency (TE-2) and crash (TE-3) acceptance tests.
// Waits until `goFile` exists, so every writer is released at the same moment, then runs
// one store operation. Owned by the main thread (L0); workers never edit it.
//
//   node writer.mjs <rootDir> <rel> <index> <goFile> <mode>
//   mode = append : replaces "<!-- end -->" with "## Writer <index>" + a line + "<!-- end -->"
//   mode = rewrite: writes the whole note (used with MNEME_TEST_CRASH_AT)
import fs from 'node:fs';
import { openRoot } from '../../src/root.js';
import { editNote, writeNote } from '../../src/store.js';

const [dir, rel, index, goFile, mode] = process.argv.slice(2);
while (!fs.existsSync(goFile)) await new Promise((resolve) => setTimeout(resolve, 5));

const root = openRoot(dir);
/** @type {import('../../src/types.js').Author} */
const author = { session: `writer-${index}`, agent: 'cli' };

const result =
  mode === 'rewrite'
    ? await writeNote(root, rel, `# Rewritten\n\nby writer ${index}\n`, { author, reason: 'crash test' })
    : await editNote(
        root,
        rel,
        { old: '<!-- end -->', new: `## Writer ${index}\n\nline ${index}\n\n<!-- end -->` },
        { author, reason: 'concurrency test' },
      );
if (!result.ok) {
  console.error(result.message);
  process.exit(3);
}
