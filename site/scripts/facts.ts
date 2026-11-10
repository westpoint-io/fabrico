// facts.ts - writes site/src/generated/facts.json, the numbers and names pages quote from the code.
//
// Run it with `npm run facts` from site/. It runs the two halves from the repo root:
//   - the Rust half, `cargo run -q --locked -p fabrico-host --example docs_facts`, which reads
//     limits, fault reasons, config fields, machine kinds and ports from the real constants,
//     enums and tables;
//   - the TypeScript half, `node frontend/scripts/export-docs-facts.ts`, which reads refusal
//     messages, keyboard shortcuts and the docs board's play rate from the frontend's modules.
// It merges the two, sorts every object's keys, and writes the file with two-space indent and a
// trailing newline, so running it twice at one revision writes the same bytes.
//
// The file is committed. Pages show its values only through <Fact id="..." />, and CI runs this
// script and fails when `git diff --exit-code -- site/src/generated/facts.json` shows a change.
// Don't edit the file by hand.
//
// OUTPUT, one line on stdout:
//   FACTS facts=<n> machines=<n> file=site/src/generated/facts.json
//
// EXIT CODES
//   0  the file was written.
//   1  a half failed (its stderr is printed), printed something that isn't the expected JSON, or
//      both halves define the same fact id.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(SITE, '..');
const OUT = path.join(SITE, 'src/generated/facts.json');
const OUT_REL = 'site/src/generated/facts.json';

/** The schema of facts.json. Bump it when the shape of a fact or a machine entry changes. */
const SCHEMA = 1;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Half = { facts: Record<string, Json>; machines: Json[] };

function fail(message: string): never {
  console.error(`facts: ${message}`);
  process.exit(1);
}

/** Run one half from the repo root and parse its stdout. */
function runHalf(name: string, command: string, args: string[]): Half {
  const result = spawnSync(command, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) fail(`${name} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    fail(`${name} exited ${result.status ?? `on signal ${result.signal}`}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    fail(`${name} printed something that isn't JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(`${name} printed JSON that isn't an object`);
  const { facts, machines } = parsed as { facts?: unknown; machines?: unknown };
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) fail(`${name} printed no "facts" object`);
  if (machines !== undefined && !Array.isArray(machines)) fail(`${name} printed a "machines" value that isn't an array`);
  return { facts: facts as Record<string, Json>, machines: (machines ?? []) as Json[] };
}

/** The same value with every object's keys in sorted order. Arrays keep their order. */
function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort(compare)) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const rust = runHalf('the Rust half (docs_facts)', 'cargo', ['run', '-q', '--locked', '-p', 'fabrico-host', '--example', 'docs_facts']);
const ts = runHalf('the TypeScript half (export-docs-facts.ts)', process.execPath, ['frontend/scripts/export-docs-facts.ts']);

if (ts.machines.length > 0) fail('the TypeScript half printed machines; only the Rust half writes them');
const facts: Record<string, Json> = { ...rust.facts };
for (const [id, fact] of Object.entries(ts.facts)) {
  if (id in facts) fail(`both halves define the fact "${id}"; give one of them a different id`);
  facts[id] = fact;
}

const merged = sortKeys({ schema: SCHEMA, facts, machines: rust.machines });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`FACTS facts=${Object.keys(facts).length} machines=${rust.machines.length} file=${OUT_REL}`);
