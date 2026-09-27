#!/usr/bin/env node
// The command line entry. Always runs `main`: there is no "am I the main module?" check,
// because comparing this file's path with argv[1] fails silently when one of them goes
// through a junction or symlink (the hooks would then do nothing and still exit 0).
import { main } from '../src/adapters/cli/main.js';
import { recordHomeError } from '../src/registry.js';

const args = process.argv.slice(2);
if (args[0] === 'hook') {
  // A hook never blocks the agent because of its own failure: whatever escapes is
  // recorded (doctor shows it) and the process still ends with 0.
  const bail = (/** @type {unknown} */ e) => {
    recordHomeError(`hook ${args[1] ?? '?'}`, e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(0);
  };
  process.on('uncaughtException', bail);
  process.on('unhandledRejection', bail);
  await main(args);
  process.exitCode = 0;
} else {
  process.exitCode = await main(args);
}
