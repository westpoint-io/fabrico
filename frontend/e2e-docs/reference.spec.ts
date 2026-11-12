import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Reference coverage. Every machine kind the protocol defines has exactly one built reference page
// about it: the page holds a MachineFacts block marked data-machine-kind="<kind>", with a caption
// and row headers in its tables, and a running board named exactly docs-machines-<slug>. A kind
// added to the protocol with no page fails here, naming the kind.
//
// The kinds come from `pub mod machine_kind` in crates/fabrico-protocol/src/lib.rs, read from disk,
// never from a list kept under site/, so a site edit can't switch the check off. Kinds compare as
// numbers and slugs as exact lower-case ASCII, never as display names, so Route's page can't pass
// with Router's board. The machine states get the same count guard against `pub mod state_tag`,
// because the facts exporter lists them by hand and no match can catch a fifth.
//
// The enums the exporter turns into facts get a guard too. Its `match`es make a new variant a
// compile error, but the facts come from hand lists of samples beside them, which the compiler
// can't check. So each enum's variant names are parsed from its source file and compared with the
// facts under its prefix, and a variant missing from the facts fails here, naming it.
//
// facts.json and the built pages are read from disk at run time, never imported: a docs-only change
// doesn't run the frontend's type check, so the suite must not depend on site/ files at compile time.

const REPO = path.resolve(import.meta.dirname, '../..');
const PROTOCOL = path.join(REPO, 'crates/fabrico-protocol/src/lib.rs');
const FACTS = path.join(REPO, 'site/src/generated/facts.json');
const REFERENCE_DIST = path.join(REPO, 'site/dist/reference');

/** The fewest machine kinds the protocol may hold. A parse that finds fewer is broken. */
const MIN_KINDS = 12;

/**
 * Each kind's page slug: the board on its page is docs-machines-<slug>. A new kind needs a row here,
 * and the first test says so.
 */
const SLUGS: Record<number, string> = {
  0: 'source',
  1: 'belt',
  2: 'factory',
  3: 'tee',
  4: 'balancer',
  5: 'router',
  6: 'merge',
  7: 'sink',
  8: 'wire',
  9: 'route',
  10: 'http-handler',
  11: 'label',
};

interface Const {
  name: string;
  value: number;
}

/**
 * The `pub const NAME: u8 = N;` lines inside `pub mod <name> {`, up to the brace that closes it. The
 * doc comment above the module (which carries a table of the same names) is never read.
 */
function moduleConsts(name: string): Const[] {
  const text = fs.readFileSync(PROTOCOL, 'utf8');
  const opener = `pub mod ${name} {`;
  const start = text.indexOf(opener);
  if (start < 0) throw new Error(`${PROTOCOL} has no "${opener}"`);
  let depth = 0;
  let end = -1;
  for (let i = start + opener.length - 1; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`${PROTOCOL}: "${opener}" never closes`);
  const body = text.slice(start + opener.length, end);
  return [...body.matchAll(/pub const ([A-Z_]+): u8 = (\d+);/g)].map((m) => ({ name: m[1], value: Number(m[2]) }));
}

/** An enum the facts exporter writes one fact per variant for, and the prefix of those facts. */
interface ExportedEnum {
  file: string;
  name: string;
  prefix: string;
}

/**
 * The enums `crates/fabrico-host/examples/docs_facts.rs` exports, each from the file it imports it
 * from. A fact id is the prefix and the variant name, with no further dot.
 */
const EXPORTED_ENUMS: ExportedEnum[] = [
  { file: 'crates/fabrico-core/src/fault.rs', name: 'FaultReason', prefix: 'fault.' },
  { file: 'crates/fabrico-core/src/edit.rs', name: 'MachineConfig', prefix: 'config.' },
  { file: 'crates/fabrico-core/src/edit.rs', name: 'SourceTrigger', prefix: 'trigger.' },
  { file: 'crates/fabrico-protocol/src/lib.rs', name: 'GridCommand', prefix: 'command.' },
  { file: 'crates/fabrico-core/src/state.rs', name: 'Role', prefix: 'port.role.' },
  { file: 'crates/fabrico-core/src/state.rs', name: 'Medium', prefix: 'port.medium.' },
  { file: 'crates/fabrico-core/src/state.rs', name: 'Side', prefix: 'port.side.' },
  { file: 'crates/fabrico-core/src/state.rs', name: 'HttpMethod', prefix: 'http.method.' },
  { file: 'crates/fabrico-core/src/state.rs', name: 'SinkTemplate', prefix: 'sink.target.' },
];

/**
 * Rust source with its comments and attributes turned to spaces and its string literals emptied, so
 * a brace or a comma inside any of them can't be read as code. Byte offsets stay the same.
 */
function codeOnly(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (/^r#*"/.test(text.slice(i, i + 12)) && !/[\w]/.test(text[i - 1] ?? ' ')) {
      // A raw string, r"..." or r#"..."#, which may hold quotes and needs no escapes.
      const hashes = /^r(#*)"/.exec(text.slice(i, i + 12))?.[1] ?? '';
      const open = i + 2 + hashes.length;
      const end = text.indexOf(`"${hashes}`, open);
      const stop = end < 0 ? text.length : end;
      blank(open, stop);
      i = stop + 1 + hashes.length;
    } else if (/^'(?:\\.|[^\\'\n])'/.test(text.slice(i, i + 4))) {
      // A char literal such as '"' or '{'.
      const len = /^'(?:\\.|[^\\'\n])'/.exec(text.slice(i, i + 4))?.[0].length ?? 1;
      blank(i + 1, i + len - 1);
      i += len;
    } else if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  // Attributes, such as #[default] or #[ts(type = "number")], after strings are emptied.
  const code = out.join('');
  return code.replace(/#!?\[[^\]]*\]/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** The variant names of `pub enum <name> {` in a Rust file, in declaration order. */
function enumVariants(file: string, name: string): string[] {
  const abs = path.join(REPO, file);
  const code = codeOnly(fs.readFileSync(abs, 'utf8'));
  const opener = new RegExp(`\\bpub enum ${name}\\s*\\{`).exec(code);
  if (opener === null) throw new Error(`${file} has no "pub enum ${name} {"`);
  const start = opener.index + opener[0].length;
  // Keep only what sits at the enum's own depth: a variant's fields in { } or ( ) are dropped.
  let depth = 0;
  let top = '';
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === '{' || c === '(') {
      depth += 1;
    } else if (c === '}' || c === ')') {
      if (depth === 0) return parseVariants(top, file, name);
      depth -= 1;
    } else if (depth === 0) {
      top += c;
    }
  }
  throw new Error(`${file}: "pub enum ${name} {" never closes`);
}

function parseVariants(top: string, file: string, name: string): string[] {
  const variants: string[] = [];
  for (const part of top.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    // A unit variant may carry a discriminant: `N = 0`.
    const m = /^([A-Z][A-Za-z0-9_]*)(?:\s*=\s*[-\w]+)?$/.exec(trimmed);
    if (m === null) throw new Error(`${file}: can't read "${trimmed}" in pub enum ${name} as a variant`);
    variants.push(m[1]);
  }
  return variants;
}

/**
 * The whole element whose opening tag holds the character at `at`: from its `<` to its matching
 * close tag, counting nested tags of the same name.
 */
function elementAt(html: string, at: number): string {
  const open = html.lastIndexOf('<', at);
  const tag = /^<([a-z][a-z0-9-]*)/i.exec(html.slice(open))?.[1];
  if (tag === undefined) return '';
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = open;
  let depth = 0;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return html.slice(open);
}

interface FactsFile {
  facts: Record<string, unknown>;
  machines: { kind: number; name: string }[];
}

function readFacts(): FactsFile {
  return JSON.parse(fs.readFileSync(FACTS, 'utf8')) as FactsFile;
}

/** Every index.html under a folder, as absolute paths, sorted. */
function htmlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name === 'index.html') out.push(full);
  }
  return out.sort();
}

test('the machine kinds parsed from fabrico-protocol match the machines in facts.json', () => {
  const kinds = moduleConsts('machine_kind');
  const { machines } = readFacts();
  expect(kinds.length, `machine kinds parsed from pub mod machine_kind in ${PROTOCOL}`).toBeGreaterThanOrEqual(MIN_KINDS);
  expect(kinds.length, 'the parsed kinds against machines[] in site/src/generated/facts.json').toBe(machines.length);
  expect(
    kinds.map((k) => k.value).sort((a, b) => a - b),
    'the parsed kind numbers against the kinds in machines[]',
  ).toEqual(machines.map((m) => m.kind).sort((a, b) => a - b));
  const noSlug = kinds.filter((k) => !(k.value in SLUGS));
  expect(
    noSlug.map((k) => `${k.name} (${k.value})`),
    'kinds with no slug: add each one to SLUGS in frontend/e2e-docs/reference.spec.ts, the slug its page board takes after docs-machines-',
  ).toEqual([]);
});

test('the machine states in facts.json match the state_tag module', () => {
  const states = moduleConsts('state_tag');
  const ids = Object.keys(readFacts().facts).filter((id) => id.startsWith('state.'));
  expect(states.length, `consts parsed from pub mod state_tag in ${PROTOCOL}`).toBeGreaterThanOrEqual(1);
  expect(
    ids.map((id) => id.slice('state.'.length)).sort(),
    'the state.* facts against the consts in pub mod state_tag (a new const needs a fact in crates/fabrico-host/examples/docs_facts.rs)',
  ).toEqual(states.map((s) => s.name).sort());
});

test('every variant of each exported enum has its fact in facts.json', () => {
  const ids = Object.keys(readFacts().facts);
  const problems: string[] = [];
  for (const { file, name, prefix } of EXPORTED_ENUMS) {
    const variants = enumVariants(file, name);
    if (variants.length === 0) {
      problems.push(`${name}: no variants parsed from ${file}`);
      continue;
    }
    const facts = ids.filter((id) => id.startsWith(prefix) && !id.slice(prefix.length).includes('.')).map((id) => id.slice(prefix.length));
    for (const v of variants) {
      if (!facts.includes(v)) problems.push(`${name}::${v} (${file}) has no ${prefix}${v} fact`);
    }
    for (const f of facts) {
      if (!variants.includes(f)) problems.push(`the fact ${prefix}${f} names no variant of ${name} in ${file}`);
    }
  }
  expect(
    problems,
    'enum variants against facts.json: add a missing variant to its samples list in crates/fabrico-host/examples/docs_facts.rs and run npm run facts in site/',
  ).toEqual([]);
});

test('every machine kind has one reference page whose board is about that machine', () => {
  const kinds = moduleConsts('machine_kind');
  expect(kinds.length, 'machine kinds parsed').toBeGreaterThanOrEqual(MIN_KINDS);
  const pages = htmlFiles(REFERENCE_DIST).map((file) => ({ file, html: fs.readFileSync(file, 'utf8') }));
  const rel = (file: string): string => path.relative(REPO, file);
  const problems: string[] = [];
  let found = 0;
  for (const { name, value } of kinds) {
    const slug = SLUGS[value];
    const label = `kind ${value} (${name}, slug ${slug ?? 'none'})`;
    if (slug === undefined) {
      problems.push(`${label}: no slug in SLUGS`);
      continue;
    }
    const marker = `data-machine-kind="${value}"`;
    const holders = pages.filter((p) => p.html.includes(marker));
    if (holders.length === 0) {
      problems.push(`${label}: no page under site/dist/reference/ holds ${marker}`);
      continue;
    }
    if (holders.length > 1) {
      problems.push(`${label}: ${holders.length} pages hold ${marker}: ${holders.map((p) => rel(p.file)).join(', ')}`);
      continue;
    }
    const { file, html } = holders[0];
    const boards = [...html.matchAll(/<fabrico-board\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
    const board = `docs-machines-${slug}`;
    if (!boards.includes(board)) {
      problems.push(`${label}: ${rel(file)} has no <fabrico-board name="${board}"> (boards: ${boards.join(', ') || 'none'})`);
      continue;
    }
    const factsBlock = elementAt(html, html.indexOf(marker));
    if (!/\bfab-machine-facts\b/.test(factsBlock.slice(0, factsBlock.indexOf('>') + 1))) {
      problems.push(`${label}: the element holding ${marker} in ${rel(file)} isn't the .fab-machine-facts block`);
      continue;
    }
    if (!factsBlock.includes('<caption') || !/<th[^>]*\bscope="row"/.test(factsBlock)) {
      problems.push(`${label}: the .fab-machine-facts block in ${rel(file)} needs a <caption> and a th scope="row"`);
      continue;
    }
    found += 1;
  }
  console.log(`REFERENCE kinds=${kinds.length} pages=${found} missing=${kinds.length - found}`);
  expect(problems, `machine kinds without a reference page about them (${problems.length} of ${kinds.length})`).toEqual([]);
});
