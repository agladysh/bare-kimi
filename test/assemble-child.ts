// Runs assembleHome(SRC, DST) once, in its own process, and prints the
// outcome as one JSON line: {"ok":true} or {"ok":false,"error":"..."}.
// Tests run it under a deadline (see runWithDeadline in helpers.ts), so a
// parser that never returns is killed instead of hanging the test runner.
//
//   bun test/assemble-child.ts SRC DST

import { assembleHome } from '../src/home.ts';

const [src, dst] = process.argv.slice(2);
if (src === undefined || dst === undefined) {
  console.error('usage: assemble-child.ts SRC DST');
  process.exit(2);
}
try {
  assembleHome(src, dst);
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
