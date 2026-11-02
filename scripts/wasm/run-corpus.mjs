// Replays the golden corpus in the wasm build under Node and compares each tick with the committed
// hashes and with a native report from this same revision. Run it from the repo root through
// scripts/check-wasm-corpus.sh, which writes that report.
//
//   node scripts/wasm/run-corpus.mjs --wasm <module> --native-report <file>
//
// The native count doesn't come from this script's own walk, because a walk that missed fixtures
// would then agree with itself. It comes from the record lines in the desktop's corpus runner.
//
// Each fixture gets a fresh wasm instance, so a trap on one can't change another and every failure
// gets named.
//
// OUTPUT on stdout:
//   IMPORTS env.__rquickjs_host_now_us
//   FIXTURES golden native=<n> wasm=<n>
//   TICKS golden=<n>
//
// EXIT CODES
//   0  every fixture matched and the counts agree.
//   1  a difference, each one named on stderr.
//   2  no comparison: a bad argument, the module or the report is missing or empty, a walk found
//      nothing, or the native count is zero.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const GOLDEN_DIR = 'crates/fabrico-core/tests/golden';
const RECORD_FILE = 'crates/fabrico-core/tests/cert_cross_platform.rs';
const CLOCK_IMPORT = '__rquickjs_host_now_us';
const CLOCK_NAME = `env.${CLOCK_IMPORT}`;
const NO_VALUE = 'none';

function refuse(message) {
  console.error(`run-corpus: ${message}. No comparison was made.`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) refuse(`${argv[i]} has no value`);
    if (argv[i] === '--wasm') args.wasm = value;
    else if (argv[i] === '--native-report') args.report = value;
    else refuse(`unknown argument ${argv[i]}`);
  }
  if (!args.wasm || !args.report) refuse('--wasm and --native-report are both required');
  return args;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readNonEmpty(path, what) {
  if (!isFile(path)) refuse(`${what} ${path} is missing`);
  const bytes = readFileSync(path);
  if (bytes.length === 0) refuse(`${what} ${path} is empty`);
  return bytes;
}

const inByteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The fixture names the desktop's runner registers, from the lines that trim to `Fixture {`. */
function registeredGolden() {
  const lines = readNonEmpty(RECORD_FILE, 'the record file').toString('utf8').split('\n');
  const names = [];
  lines.forEach((line, index) => {
    if (line.trim() !== 'Fixture {') return;
    const match = /^name: "([^"]+)",$/.exec((lines[index + 1] ?? '').trim());
    if (!match) refuse(`the record at line ${index + 1} of ${RECORD_FILE} has no name line after it`);
    names.push(match[1]);
  });
  if (names.length === 0) refuse(`${RECORD_FILE} has no record lines, so the native count is zero`);
  return names;
}

/** A directory counts as a fixture only if it holds meta.toml, the registration guard's rule. */
function walkGolden() {
  let names;
  try {
    names = readdirSync(GOLDEN_DIR);
  } catch {
    refuse(`${GOLDEN_DIR} can't be read`);
  }
  const fixtures = names.filter((name) => isFile(join(GOLDEN_DIR, name, 'meta.toml'))).sort(inByteOrder);
  if (fixtures.length === 0) refuse(`the walk of ${GOLDEN_DIR} found nothing`);
  return fixtures;
}

function hashLines(meta) {
  for (const line of meta.split('\n')) {
    const at = line.indexOf('=');
    if (at >= 0 && line.slice(0, at).trim() === 'hash_lines') {
      const value = line.slice(at + 1).trim();
      if (/^[0-9]+$/.test(value)) return Number(value);
    }
  }
  return null;
}

/** The native report, as one record per fixture: `<family> <fixture>` to its hashes and faults. */
function readReport(path) {
  const report = new Map();
  const entry = (key) => {
    if (!report.has(key)) report.set(key, { hashes: [], faults: null });
    return report.get(key);
  };
  for (const line of readNonEmpty(path, 'the native report').toString('utf8').split('\n')) {
    if (line === '') continue;
    const parts = line.split(' ');
    if (parts[0] === 'T' && parts.length === 5) entry(`${parts[1]} ${parts[2]}`).hashes.push(parts[4]);
    else if (parts[0] === 'F' && parts.length === 4) entry(`${parts[1]} ${parts[2]}`).faults = parts[3];
    else refuse(`the native report has a line this script can't read: ${line}`);
  }
  return report;
}

/** Runs one export on a fresh instance. Returns the hashes and faults, or `error` when it refused or trapped. */
function replayOnFreshInstance(module, clock, call) {
  try {
    const instance = new WebAssembly.Instance(module, { env: { [CLOCK_IMPORT]: clock } });
    const x = instance.exports;
    const copyIn = (bytes) => {
      const ptr = x.fc_alloc(bytes.length);
      if (ptr === 0 && bytes.length > 0) throw new Error('fc_alloc returned null');
      new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
      return [ptr, bytes.length];
    };
    const status = call(x, copyIn);
    const text = Buffer.from(x.memory.buffer, x.fc_out_ptr(), x.fc_out_len()).toString('utf8');
    if (status !== 0) return { error: `refused: ${text}` };
    const hashes = [];
    let faults = null;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const [first, second] = line.split(' ');
      if (first === 'faults') faults = second;
      else hashes.push(second);
    }
    return { hashes, faults };
  } catch (error) {
    return { error: `trapped: ${error.message}` };
  }
}

/** The first tick where two hash lists differ, a different length included, or null. */
function firstDifference(actual, expected) {
  const length = Math.max(actual.length, expected.length);
  for (let tick = 0; tick < length; tick += 1) {
    if (actual[tick] !== expected[tick]) {
      return { tick, actual: actual[tick] ?? NO_VALUE, expected: expected[tick] ?? NO_VALUE };
    }
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const wasmBytes = readNonEmpty(args.wasm, 'the wasm module');
const report = readReport(args.report);
const registered = registeredGolden();
const walked = walkGolden();

const failures = [];

const module = await WebAssembly.compile(wasmBytes);
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
for (const name of imports) {
  if (name !== CLOCK_NAME) failures.push(`the harness imports ${name}, and only ${CLOCK_NAME} is allowed`);
}
if (!imports.includes(CLOCK_NAME)) failures.push(`the harness doesn't import ${CLOCK_NAME}`);
console.log(`IMPORTS ${imports.join(' ')}`);

const constantClock = () => 0;

function compareWithExpected(family, fixture, hashes, expected, source) {
  const difference = firstDifference(hashes, expected);
  if (difference) {
    failures.push(
      `${family} ${fixture} tick ${difference.tick} wasm=${difference.actual} expected=${difference.expected} (from ${source})`,
    );
  }
}

let goldenTicks = 0;
for (const fixture of walked) {
  const dir = join(GOLDEN_DIR, fixture);
  const ticks = hashLines(readFileSync(join(dir, 'meta.toml'), 'utf8'));
  if (ticks === null) {
    failures.push(`golden ${fixture} has no hash_lines value in its meta.toml`);
    continue;
  }
  const genesis = readFileSync(join(dir, 'genesis.snapshot'));
  const log = readFileSync(join(dir, 'log.postcard'));
  const editLog = readFileSync(join(dir, 'edit-log.postcard'));
  const result = replayOnFreshInstance(module, constantClock, (x, copyIn) =>
    x.fc_replay_golden(...copyIn(genesis), ...copyIn(log), ...copyIn(editLog), ticks),
  );
  if (result.error) {
    failures.push(`golden ${fixture} ${result.error}`);
    continue;
  }
  goldenTicks += result.hashes.length;

  const committed = readFileSync(join(dir, 'hashes.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  compareWithExpected('golden', fixture, result.hashes, committed, 'hashes.txt');

  const native = report.get(`golden ${fixture}`);
  if (!native) {
    failures.push(`golden ${fixture} is in the walk and not in the native report`);
    continue;
  }
  compareWithExpected('golden', fixture, result.hashes, native.hashes, 'the native report');
}

for (const key of report.keys()) {
  const [family, fixture] = key.split(' ');
  if (family === 'golden' && !walked.includes(fixture)) {
    failures.push(`golden ${fixture} is in the native report and not in the walk`);
  }
}

console.log(`FIXTURES golden native=${registered.length} wasm=${walked.length}`);
for (const name of registered) {
  if (!walked.includes(name)) failures.push(`golden ${name} is missing: it's registered and isn't on disk`);
}
for (const name of walked) {
  if (!registered.includes(name)) failures.push(`golden ${name} is extra: it's on disk and isn't registered`);
}
console.log(`TICKS golden=${goldenTicks}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(`run-corpus: ${failures.length} difference(s).`);
  process.exit(1);
}
