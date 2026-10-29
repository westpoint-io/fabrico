// list-live-wait-caps.ts - one row per wall-clock cap in the live suite (plan 84-18, D-12).
//
// Run from `frontend/`: `node scripts/list-live-wait-caps.ts`. It reads the tree it sits in
// (`e2e-live/**/*.ts` and `e2e/support/frameSampler.ts`) through `src/gates/liveWaitCaps.ts`,
// the module `liveWaitCaps.source.test.ts` gates on every `npm test`, and prints:
//   CAP <path>:<line> kind=<k> value=<literal|derived|default|other> ms=<n|-> region=<r>
//       frameBound=<0|1> verdict=<ok|RED> why=<reason>[ test=<path>:<line>]
//   RAW_CAPTURE <path>:<line>
//   UNKNOWN_HOOK <name> <path>:<line>
//   LIVE_WAIT_CAPS files= sites= literal= derived= default= other= frameBound= red=
// It exits 0 when `red` is 0, 1 when it is above 0, and 2 on a file it cannot parse.
//
// Written for Node's type stripping (see `scripts/mark-craft.ts`): no enums, namespaces or
// parameter properties, and an explicit `.ts` extension on the relative import.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatRow, formatSummary, readLiveSources, scanLiveWaitCaps } from '../src/gates/liveWaitCaps.ts';

const frontend = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = scanLiveWaitCaps(readLiveSources(frontend));
for (const row of result.rows) console.log(formatRow(row));
for (const raw of result.rawCaptures) console.log(`RAW_CAPTURE ${raw.path}:${raw.line}`);
for (const hook of result.unknownHooks) console.log(`UNKNOWN_HOOK ${hook.name} ${hook.path}:${hook.line}`);
for (const path of result.unparsed) console.log(`UNPARSED ${path}`);
console.log(formatSummary(result.summary));
process.exitCode = result.unparsed.length > 0 ? 2 : result.summary.red > 0 ? 1 : 0;
