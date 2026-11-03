// The fence report: where a Factory first runs out of gas, memory or stack, on the desktop build and
// in the wasm build, and the rules CI holds those numbers to. Run it through
// scripts/check-fence-report.sh.
//
//   node scripts/wasm/fence-report.mjs measure --wasm <module> --native <file> --pins <path> --out <file>
//   node scripts/wasm/fence-report.mjs check --report <file> --pins <path>
//
// `measure` copies the native lines from `--native` (the output of `corpus_native --fence`), makes
// the same measurements in the wasm harness under Node, and writes both to `--out`. Each probe gets
// a fresh instance with the clock returning 0, and a call that throws counts as a trap. The pins
// file's counts are only where each search starts, so the report always holds the measured count.
//
// THE REPORT, one fact per line, with <target> one of native and wasm32:
//   FENCE gas <target> <count>
//   FENCE memory <target> <shape> <count>        shape is arrays, strings, objects or cyclic
//   FENCE stack native first_fault=<n> map_first_fault=<n> limit=<bytes>
//   FENCE stack wasm32 first_fault=<n> kind=<fault|trap> runaway=<fault|trap> map_first_fault=<n>
//     map_kind=<fault|trap> map_runaway=<fault|trap> limit=<bytes> shadow_stack=<bytes>
//   FENCE limits <target> mem=<bytes> gas=<budget>
//   FENCE alloc wasm32 ok                        or `failed <reason>`
//   FENCE trap memory wasm32 <shape> <size>      only when the memory search trapped, see below
//
// THE RULES `check` applies:
//   - Gas: the two gas counts must be equal.
//   - Memory: each memory count must equal its target's line in the pins file. The wasm search
//     counts a size as faulting only when the engine stopped the call cleanly. A call that traps
//     the whole instance is no fault: the report gets a `FENCE trap memory` line for the first
//     size that trapped, and any such line fails the check.
//   - Limits: mem and gas must be equal on both targets.
//   - Stack: the wasm line must read kind=fault, runaway=fault, map_kind=fault and map_runaway=fault,
//     and shadow_stack must be larger than limit. The depths have no pin on either target, because
//     they change with the compiler and the profile, so they are only printed.
//   - Allocator: the wasm self-check line must read ok.
//
// EXIT CODES
//   0  every rule held.
//   1  a rule failed, each failure named on stderr.
//   2  no check: a bad argument, a missing or empty file, a module that won't compile, or a line
//      the report needs is missing.

import { readFileSync, statSync, writeFileSync } from 'node:fs';

const MEMORY_SHAPES = [
  ['arrays', 0, 20_000],
  ['strings', 1, 50_000],
  ['objects', 2, 2_000_000],
  ['cyclic', 3, 2_000_000],
];
const RECURSION = 4;
const GAS_LOOP = 5;
const MAP_RECURSION = 6;
const GAS_CEILING = 100_000_000;
const RECURSION_CEILING = 100_000;
const TARGETS = ['native', 'wasm32'];

function refuse(message) {
  console.error(`fence-report: ${message}. No check was made.`);
  process.exit(2);
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'measure' && mode !== 'check') refuse('the first argument has to be measure or check');
  const args = { mode };
  const names = { '--wasm': 'wasm', '--native': 'native', '--pins': 'pins', '--out': 'out', '--report': 'report' };
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]];
    if (key === undefined) refuse(`unknown argument ${rest[i]}`);
    if (rest[i + 1] === undefined) refuse(`${rest[i]} has no value`);
    args[key] = rest[i + 1];
  }
  const needed = mode === 'measure' ? ['wasm', 'native', 'pins', 'out'] : ['report', 'pins'];
  for (const key of needed) if (!args[key]) refuse(`${mode} needs --${key}`);
  return args;
}

function readNonEmpty(path, what) {
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) refuse(`${what} ${path} is missing`);
  const bytes = readFileSync(path);
  if (bytes.length === 0) refuse(`${what} ${path} is empty`);
  return bytes;
}

/** The pins file's `<target> <shape> <count>` lines and its `gas <count>` hint. */
function readPins(path) {
  const pins = new Map();
  let gas = null;
  for (const raw of readNonEmpty(path, 'the pins file').toString('utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields.length === 2 && fields[0] === 'gas' && /^\d+$/.test(fields[1])) gas = Number(fields[1]);
    else if (fields.length === 3 && TARGETS.includes(fields[0]) && /^\d+$/.test(fields[2])) {
      pins.set(`${fields[0]} ${fields[1]}`, Number(fields[2]));
    } else refuse(`the pins file has a line this script can't read: ${line}`);
  }
  return { pins, gas };
}

function measure(args) {
  const native = readNonEmpty(args.native, 'the native report')
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '');
  for (const line of native) {
    if (!line.startsWith('FENCE ') || line.split(' ')[2] !== 'native') {
      refuse(`the native report has a line that isn't a native FENCE line: ${line}`);
    }
  }
  const { pins, gas: gasHint } = readPins(args.pins);

  let module;
  try {
    module = new WebAssembly.Module(readNonEmpty(args.wasm, 'the wasm module'));
  } catch (error) {
    refuse(`the wasm module ${args.wasm} won't compile: ${error.message}`);
  }
  const fresh = () => new WebAssembly.Instance(module, { env: { __rquickjs_host_now_us: () => 0 } }).exports;
  const outText = (x) => Buffer.from(x.memory.buffer, x.fc_out_ptr(), x.fc_out_len()).toString('utf8');

  /** 'ran', 'fault' or 'trap' for one call on a fresh instance. */
  const once = (shape, n, gas, stack) => {
    const x = fresh();
    try {
      return x.fc_fence(shape, n, gas, 0, stack) === 0 ? 'ran' : 'fault';
    } catch {
      return 'trap';
    }
  };
  /** The first count that doesn't run, from the hint when it holds, else by search. */
  const firstFault = (hint, ceiling, faults) => {
    if (hint !== null && hint !== undefined && hint > 1 && !faults(hint - 1) && faults(hint)) return hint;
    if (!faults(ceiling)) return ceiling + 1;
    let low = 1;
    let high = ceiling;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (faults(middle)) high = middle;
      else low = middle + 1;
    }
    return low;
  };

  const first = fresh();
  const mem = first.fc_default_mem();
  const gasBudget = first.fc_default_gas();
  const stackLimit = first.fc_default_stack();
  const shadowStack = Number(first.__stack_high.value) - Number(first.__stack_low.value);

  const lines = [...native];
  // A gas run that stops is always the engine's own clean fault, so this predicate stays as it was.
  const gas = firstFault(gasHint, GAS_CEILING, (n) => once(GAS_LOOP, n, gasBudget, 0) !== 'ran');
  lines.push(`FENCE gas wasm32 ${gas}`);
  const traps = [];
  for (const [name, shape, ceiling] of MEMORY_SHAPES) {
    let trappedAt = null;
    const faults = (n) => {
      const result = once(shape, n, 0, 0);
      if (result === 'trap' && trappedAt === null) trappedAt = n;
      return result === 'fault';
    };
    const count = firstFault(pins.get(`wasm32 ${name}`), ceiling, faults);
    lines.push(`FENCE memory wasm32 ${name} ${count}`);
    if (trappedAt !== null) traps.push(`FENCE trap memory wasm32 ${name} ${trappedAt}`);
  }
  const stack = (shape) => {
    const at = firstFault(null, RECURSION_CEILING, (n) => once(shape, n, 0, 0) !== 'ran');
    return { at, kind: once(shape, at, 0, 0), runaway: once(shape, RECURSION_CEILING, 0, 0) };
  };
  const plain = stack(RECURSION);
  const map = stack(MAP_RECURSION);
  lines.push(
    `FENCE stack wasm32 first_fault=${plain.at} kind=${plain.kind} runaway=${plain.runaway} ` +
      `map_first_fault=${map.at} map_kind=${map.kind} map_runaway=${map.runaway} ` +
      `limit=${stackLimit} shadow_stack=${shadowStack}`,
  );
  lines.push(`FENCE limits wasm32 mem=${mem} gas=${gasBudget}`);

  const checker = fresh();
  let alloc;
  try {
    alloc = checker.fc_alloc_self_check() === 0 ? 'ok' : `failed ${outText(checker)}`;
  } catch (error) {
    alloc = `failed it trapped: ${error.message}`;
  }
  lines.push(`FENCE alloc wasm32 ${alloc}`);
  lines.push(...traps);

  writeFileSync(args.out, `${lines.join('\n')}\n`);
}

/** The `key=value` fields of a stack or limits line. */
function fields(line) {
  const map = new Map();
  for (const part of line.split(' ').slice(3)) {
    const [key, value] = part.split('=');
    if (value !== undefined) map.set(key, value);
  }
  return map;
}

function check(args) {
  const text = readNonEmpty(args.report, 'the report').toString('utf8');
  const { pins } = readPins(args.pins);
  console.log(text.trimEnd());

  const lines = text.split('\n').filter((line) => line !== '');
  const missing = [];
  const failures = [];
  const find = (prefix) => {
    const found = lines.filter((line) => line === prefix || line.startsWith(`${prefix} `));
    if (found.length === 0) missing.push(prefix);
    if (found.length > 1) failures.push(`the report has ${found.length} lines starting "${prefix}", expected 1`);
    return found[0];
  };

  const gas = {};
  const limits = {};
  for (const target of TARGETS) {
    const gasLine = find(`FENCE gas ${target}`);
    if (gasLine !== undefined) gas[target] = gasLine.split(' ')[3];
    for (const [name] of MEMORY_SHAPES) {
      const line = find(`FENCE memory ${target} ${name}`);
      const pin = pins.get(`${target} ${name}`);
      if (pin === undefined) missing.push(`the pin for ${target} ${name}`);
      if (line === undefined || pin === undefined) continue;
      const count = line.split(' ')[4];
      if (count !== String(pin)) {
        failures.push(`memory ${target} ${name}: the pin is ${pin} and this build measured ${count}`);
      }
    }
    const limitsLine = find(`FENCE limits ${target}`);
    if (limitsLine !== undefined) limits[target] = fields(limitsLine);
  }
  if (gas.native !== undefined && gas.wasm32 !== undefined && gas.native !== gas.wasm32) {
    failures.push(`gas: native trips the fuse at ${gas.native} and wasm32 at ${gas.wasm32}, and they have to be equal`);
  }
  if (limits.native && limits.wasm32) {
    for (const key of ['mem', 'gas']) {
      const [a, b] = [limits.native.get(key), limits.wasm32.get(key)];
      if (a === undefined || b === undefined) missing.push(`limits ${key}`);
      else if (a !== b) failures.push(`limits ${key}: native is ${a} and wasm32 is ${b}, and they have to be equal`);
    }
  }

  find('FENCE stack native');
  const stackLine = find('FENCE stack wasm32');
  if (stackLine !== undefined) {
    const stack = fields(stackLine);
    for (const key of ['kind', 'runaway', 'map_kind', 'map_runaway']) {
      const value = stack.get(key);
      if (value === undefined) missing.push(`stack wasm32 ${key}`);
      else if (value !== 'fault') failures.push(`stack wasm32 ${key}=${value}, and it has to be fault`);
    }
    const [limit, shadow] = [stack.get('limit'), stack.get('shadow_stack')];
    if (limit === undefined || shadow === undefined) missing.push('stack wasm32 limit and shadow_stack');
    else if (!(Number(shadow) > Number(limit))) {
      failures.push(`stack wasm32 shadow_stack=${shadow} isn't larger than limit=${limit}`);
    }
  }

  for (const line of lines.filter((l) => l.startsWith('FENCE trap '))) {
    const [, , kind, target, shape, size] = line.split(' ');
    failures.push(`FAIL ${kind} ${target} ${shape} trapped at ${size}`);
  }

  const alloc = find('FENCE alloc wasm32');
  if (alloc !== undefined && alloc !== 'FENCE alloc wasm32 ok') {
    failures.push(`the allocator self-check in wasm32 says: ${alloc.slice('FENCE alloc wasm32 '.length)}`);
  }

  for (const failure of failures) console.error(`fence-report: ${failure}`);
  if (missing.length > 0) {
    console.error(`fence-report: the report or the pins file has no line for: ${missing.join(', ')}`);
    process.exit(2);
  }
  if (failures.length > 0) {
    console.error(`fence-report: ${failures.length} rule(s) failed.`);
    process.exit(1);
  }
  console.log('fence-report: gas equal, memory at its pins, limits equal, stack faults cleanly.');
}

const args = parseArgs(process.argv.slice(2));
if (args.mode === 'measure') measure(args);
else check(args);
