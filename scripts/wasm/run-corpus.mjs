// Replays the golden corpus and the scenario fixtures in the wasm build under Node, and compares
// each tick with a native report from this same revision. Run it from the repo root through
// scripts/check-wasm-corpus.sh, which writes that report.
//
//   node scripts/wasm/run-corpus.mjs --wasm <module> --native-report <file>
//
// WHAT IT COMPARES, as whole strings:
//   - Golden: each tick with the fixture's hashes.txt and with the native report.
//   - Scenario: each tick with the native report, and the last hash with line 1 of the body of the
//     fixture's .snap file. A scenario stores one hash, so the report carries the per-tick half and
//     the .snap ties the replay to the path the native tests use.
//   - Faults: each fixture's count with the native count, so no fixture faults on one target alone.
//   - Clocks: the whole walk runs twice, once with the clock import returning 0 and once with it
//     returning a new value on each call. Any line that differs between the two passes fails, and a
//     pass that never read the clock fails too, because it would prove nothing.
//
// The native counts don't come from this script's own walk, because a walk that missed fixtures
// would then agree with itself. Golden comes from the record lines in the desktop's corpus runner,
// and scenario from the .snap files.
//
// Each fixture gets a fresh wasm instance, so a trap on one can't change another and every failure
// gets named.
//
// OUTPUT on stdout:
//   IMPORTS env.__rquickjs_host_now_us
//   FIXTURES golden native=<n> wasm=<n>
//   FIXTURES scenario native=<n> wasm=<n>
//   TICKS golden=<n> scenario=<n>
//   CLOCK constant_calls=<n> random_calls=<n>
//
// OUTPUT files beside the module, one report-format line per tick and per fixture:
//   corpus-wasm-constant.txt and corpus-wasm-random.txt
//
// EXIT CODES
//   0  every fixture matched, the counts agree and both passes read the clock.
//   1  a difference, each one named on stderr.
//   2  no comparison: a bad argument, the module or the report is missing or empty, the module won't
//      compile, a walk found nothing, or a native count is zero.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GOLDEN_DIR = 'crates/fabrico-core/tests/golden';
const RECORD_FILE = 'crates/fabrico-core/tests/cert_cross_platform.rs';
const SCENARIO_DIR = 'crates/fabrico-scenario/fixtures';
const SNAPSHOT_DIR = 'crates/fabrico-scenario/snapshots';
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

function namesIn(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return refuse(`${dir} can't be read`);
  }
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

/** The scenario names the native tests pin, one .snap file each. */
function registeredScenarios() {
  const names = namesIn(SNAPSHOT_DIR)
    .filter((name) => name.endsWith('.snap'))
    .map((name) => name.slice(0, -'.snap'.length));
  if (names.length === 0) refuse(`${SNAPSHOT_DIR} has no .snap files, so the native count is zero`);
  return names;
}

/** A directory counts as a fixture only if it holds meta.toml, the registration guard's rule. */
function walkGolden() {
  const fixtures = namesIn(GOLDEN_DIR)
    .filter((name) => isFile(join(GOLDEN_DIR, name, 'meta.toml')))
    .sort(inByteOrder);
  if (fixtures.length === 0) refuse(`the walk of ${GOLDEN_DIR} found nothing`);
  return fixtures;
}

function walkScenarios() {
  const fixtures = namesIn(SCENARIO_DIR)
    .filter((name) => name.endsWith('.postcard'))
    .map((name) => name.slice(0, -'.postcard'.length))
    .sort(inByteOrder);
  if (fixtures.length === 0) refuse(`the walk of ${SCENARIO_DIR} found nothing`);
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

/** The first line after the second `---` of a .snap file, or null. */
function snapHash(stem) {
  const lines = readFileSync(join(SNAPSHOT_DIR, `${stem}.snap`), 'utf8').split('\n');
  const first = lines.indexOf('---');
  const second = lines.indexOf('---', first + 1);
  if (first < 0 || second < 0) return null;
  return (lines[second + 1] ?? '').trim() || null;
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
const registered = { golden: registeredGolden(), scenario: registeredScenarios() };
const walked = { golden: walkGolden(), scenario: walkScenarios() };
const outDir = dirname(args.wasm);

const failures = [];

let module;
try {
  module = await WebAssembly.compile(wasmBytes);
} catch (error) {
  refuse(`the wasm module ${args.wasm} won't compile: ${error.message}`);
}
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
for (const name of imports) {
  if (name !== CLOCK_NAME) failures.push(`the harness imports ${name}, and only ${CLOCK_NAME} is allowed`);
}
if (!imports.includes(CLOCK_NAME)) failures.push(`the harness doesn't import ${CLOCK_NAME}`);
console.log(`IMPORTS ${imports.join(' ')}`);

// What each fixture needs read once, so both passes replay the same bytes.
const jobs = [];
for (const fixture of walked.golden) {
  const dir = join(GOLDEN_DIR, fixture);
  const ticks = hashLines(readFileSync(join(dir, 'meta.toml'), 'utf8'));
  if (ticks === null) {
    failures.push(`golden ${fixture} has no hash_lines value in its meta.toml`);
    continue;
  }
  const genesis = readFileSync(join(dir, 'genesis.snapshot'));
  const log = readFileSync(join(dir, 'log.postcard'));
  const editLog = readFileSync(join(dir, 'edit-log.postcard'));
  jobs.push({
    family: 'golden',
    fixture,
    call: (x, copyIn) => x.fc_replay_golden(...copyIn(genesis), ...copyIn(log), ...copyIn(editLog), ticks),
  });
}
for (const fixture of walked.scenario) {
  const bytes = readFileSync(join(SCENARIO_DIR, `${fixture}.postcard`));
  jobs.push({
    family: 'scenario',
    fixture,
    call: (x, copyIn) => x.fc_replay_scenario(...copyIn(bytes)),
  });
}

/** One pass over every fixture. Writes its lines to a file and returns the results in job order. */
function runPass(clock, fileName) {
  const results = jobs.map((job) => replayOnFreshInstance(module, clock, job.call));
  const lines = [];
  results.forEach((result, index) => {
    const { family, fixture } = jobs[index];
    if (result.error) {
      lines.push(`E ${family} ${fixture} ${result.error}`);
      return;
    }
    result.hashes.forEach((hash, tick) => lines.push(`T ${family} ${fixture} ${tick} ${hash}`));
    lines.push(`F ${family} ${fixture} ${result.faults}`);
  });
  writeFileSync(join(outDir, fileName), `${lines.join('\n')}\n`);
  return results;
}

let constantCalls = 0;
const constantClock = () => {
  constantCalls += 1;
  return 0;
};
const constantResults = runPass(constantClock, 'corpus-wasm-constant.txt');

let randomCalls = 0;
let randomNow = 1.7e15;
const randomClock = () => {
  randomCalls += 1;
  randomNow += 1 + Math.random() * 1e7;
  return randomNow;
};
const randomResults = runPass(randomClock, 'corpus-wasm-random.txt');

function compareHashes(family, fixture, hashes, expected, source) {
  const difference = firstDifference(hashes, expected);
  if (difference) {
    failures.push(
      `${family} ${fixture} tick ${difference.tick} wasm=${difference.actual} expected=${difference.expected} (from ${source})`,
    );
  }
}

const tickTotals = { golden: 0, scenario: 0 };
jobs.forEach(({ family, fixture }, index) => {
  const result = constantResults[index];
  const other = randomResults[index];

  if (other.error && !result.error) failures.push(`clock ${family} ${fixture} tick 0: ${other.error}`);
  if (result.error) {
    failures.push(`${family} ${fixture} ${result.error}`);
    return;
  }
  tickTotals[family] += result.hashes.length;

  if (family === 'golden') {
    const committed = readFileSync(join(GOLDEN_DIR, fixture, 'hashes.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    compareHashes(family, fixture, result.hashes, committed, 'hashes.txt');
  } else if (registered.scenario.includes(fixture)) {
    const committed = snapHash(fixture);
    const last = result.hashes.length - 1;
    if (committed === null) {
      failures.push(`scenario ${fixture} has no hash line in its .snap file`);
    } else if (result.hashes[last] !== committed) {
      failures.push(
        `scenario ${fixture} tick ${last} wasm=${result.hashes[last]} expected=${committed} (from its .snap file)`,
      );
    }
  }

  const native = report.get(`${family} ${fixture}`);
  if (!native) {
    failures.push(`${family} ${fixture} is in the walk and not in the native report`);
  } else {
    compareHashes(family, fixture, result.hashes, native.hashes, 'the native report');
    if (result.faults !== native.faults) {
      failures.push(`${family} ${fixture} faults wasm=${result.faults} native=${native.faults ?? NO_VALUE}`);
    }
  }

  if (!other.error) {
    const difference = firstDifference(other.hashes, result.hashes);
    if (difference) failures.push(`clock ${family} ${fixture} tick ${difference.tick}`);
    if (other.faults !== result.faults) failures.push(`clock ${family} ${fixture} faults`);
  }
});

for (const key of report.keys()) {
  const [family, fixture] = key.split(' ');
  if (!walked[family]?.includes(fixture)) {
    failures.push(`${family} ${fixture} is in the native report and not in the walk`);
  }
}

for (const family of ['golden', 'scenario']) {
  console.log(`FIXTURES ${family} native=${registered[family].length} wasm=${walked[family].length}`);
  for (const name of registered[family]) {
    if (!walked[family].includes(name)) failures.push(`${family} ${name} is missing: the native side has it and the walk doesn't`);
  }
  for (const name of walked[family]) {
    if (!registered[family].includes(name)) failures.push(`${family} ${name} is extra: the walk has it and the native side doesn't`);
  }
}

console.log(`TICKS golden=${tickTotals.golden} scenario=${tickTotals.scenario}`);
console.log(`CLOCK constant_calls=${constantCalls} random_calls=${randomCalls}`);
if (constantCalls === 0) failures.push('clock: the constant pass never read the clock, so it proves nothing');
if (randomCalls === 0) failures.push('clock: the random pass never read the clock, so it proves nothing');

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(`run-corpus: ${failures.length} difference(s).`);
  process.exit(1);
}
