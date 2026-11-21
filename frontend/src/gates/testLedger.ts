// testLedger.ts - parses `frontend/TEST-LEDGER.md` and checks every row against the files it names.
//
// User: `testLedger.source.test.ts` (the gate, on every `npm test`). The module is pure: it reads
// files only through the `LedgerFiles` it is handed, with paths relative to `frontend/`, and it
// reads guarding specs as source with the TypeScript compiler API. It never imports a spec or
// Playwright.
//
// A ROW is `id | state | spec | defect | guarding test | patch | old output | new output`, the
// format `scripts/rebreak.sh` reads (backticks in a cell are dropped, cells are trimmed). A row holds
// when:
//   - its id matches ID_RE and no other row has it; a bad id is refused before any path is built
//     from it, so a cell like `../x` never reaches the file system;
//   - its state is `kept` (the spec is still in the tree) or `deleted` (it is gone);
//   - its spec matches SPEC_RE;
//   - its patch and outputs are exactly `rebreak/<id>.patch`, `.old.txt` and `.new.txt`, exist and
//     are not empty;
//   - each output has a line starting `REBREAK verdict=RED` with `run=old` (old output) or
//     `run=new` (new output), the suite the side ran in, the sha256 of the committed patch, and the
//     row's spec (old) or guarding line (new) as its target, so an output from another row or from
//     an earlier patch is red;
//   - its guarding test resolves to exactly one test (see `checkGuard`);
//   - and every file under `rebreak/` belongs to a row.
// A ledger with no rows is red: a gate with nothing to check proves nothing.
//
// THE GUARDING TEST is `<suite>: [<project>] › <file> › <describe> ... › <test>`, Playwright's
// `--test-list` form with a suite prefix. The project must belong to the suite (mock: chromium;
// live: live, or live-terminal for a `*.terminal.spec.ts`; walk: walk). The file is relative to the
// suite's folder (`e2e/` for mock, `e2e-live/` for live and walk), has no part starting with a dot,
// and ends in `.spec.ts` (mock, live) or `.walk.ts` (walk). The titles must equal, in order, one
// chain of `test.describe` titles ending in a `test` title in that file, read from calls to `test`,
// `test.describe`, `test.describe.serial` and `test.describe.parallel`. A title written with a
// substitution can't be compared as text, so a guard that could match one is refused, and so is a
// title part holding `›` or `>`, which the proof script reads as a separator.
//
// Written for Node's type stripping as well as Vite: no enums, namespaces or parameter
// properties.

import ts from 'typescript';
import { createHash } from 'node:crypto';

export interface LedgerRow {
  /** 1-based line of the row in the ledger. */
  line: number;
  id: string;
  state: string;
  spec: string;
  defect: string;
  guard: string;
  patch: string;
  oldOut: string;
  newOut: string;
}

export interface ParsedLedger {
  rows: LedgerRow[];
  problems: string[];
}

/** File access relative to `frontend/`. */
export interface LedgerFiles {
  exists(rel: string): boolean;
  read(rel: string): string;
  /** The entry names in a folder, or none when it is absent. */
  list(dir: string): string[];
}

export const LEDGER_HEADER = '| id | state | spec | defect | guarding test | patch | old output | new output |';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SPEC_RE = /^(e2e|e2e-live)\/[A-Za-z0-9._-]+\.(spec|walk)\.ts$/;
/** The guarding file, as `rebreak.sh` accepts it: no part starting with a dot. */
const GUARD_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.ts$/;
const VERDICT = 'REBREAK verdict=RED';
const REBREAK_DIR = 'rebreak';

type Suite = 'mock' | 'live' | 'walk';

const SUITE_DIR: Readonly<Record<Suite, string>> = { mock: 'e2e', live: 'e2e-live', walk: 'e2e-live' };
const SUITE_PROJECTS: Readonly<Record<Suite, readonly string[]>> = {
  mock: ['chromium'],
  live: ['live', 'live-terminal'],
  walk: ['walk'],
};

function cells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((c) => c.replace(/`/g, '').trim());
}

export function parseLedger(text: string): ParsedLedger {
  const lines = text.split(/\r?\n/);
  const problems: string[] = [];
  const rows: LedgerRow[] = [];
  const headers = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => l === LEDGER_HEADER);
  if (headers.length !== 1) {
    problems.push(
      headers.length === 0
        ? `the ledger has no table header; it must be exactly "${LEDGER_HEADER}"`
        : `the ledger has ${headers.length} table headers; it must have one`,
    );
    return { rows, problems };
  }
  const at = headers[0][1];
  const sep = (lines[at + 1] ?? '').trim();
  if (!/^\|(\s*:?-+:?\s*\|)+$/.test(sep) || cells(sep).length !== 8) {
    problems.push(`line ${at + 2}: the table header must be followed by a separator row with 8 cells`);
    return { rows, problems };
  }
  for (let i = at + 2; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) break;
    const c = cells(t);
    if (c.length !== 8) {
      problems.push(`row ${c[0] || `at line ${i + 1}`}: the row has ${c.length} cells; it needs 8`);
      continue;
    }
    rows.push({ line: i + 1, id: c[0], state: c[1], spec: c[2], defect: c[3], guard: c[4], patch: c[5], oldOut: c[6], newOut: c[7] });
  }
  return { rows, problems };
}

/**
 * One title on a describe-and-test path: its text, or why it can't be read as text with the
 * texts it could still take (a template's literal parts with anything between them; any text for
 * a title that isn't a literal at all).
 */
type Title = { text: string } | { dynamic: string; could: RegExp };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every test in `source` as its chain of describe titles ending in the test title. */
export function titleChains(source: string, fileName: string): Title[][] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const chains: Title[][] = [];

  const calleeName = (e: ts.Expression): string | null => {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) {
      const left = calleeName(e.expression);
      return left === null ? null : `${left}.${e.name.text}`;
    }
    return null;
  };

  const titleOf = (arg: ts.Expression): Title => {
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return { text: arg.text };
    const where = `the title ${arg.getText(sf)} at line ${sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1}`;
    if (ts.isTemplateExpression(arg)) {
      const literal = [arg.head.text, ...arg.templateSpans.map((s) => s.literal.text)];
      return { dynamic: `${where} is a template literal with a substitution`, could: new RegExp(`^${literal.map(escapeRe).join('.*')}$`, 's') };
    }
    return { dynamic: `${where} is not a string literal`, could: /^/ };
  };

  const visit = (node: ts.Node, path: Title[]): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const first = node.arguments[0];
      if (name === 'test' && first !== undefined) {
        chains.push([...path, titleOf(first)]);
        return;
      }
      if (name === 'test.describe' || name === 'test.describe.serial' || name === 'test.describe.parallel') {
        const body = [...node.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (body !== undefined) {
          // A describe with only a callback adds no title (Playwright's anonymous group).
          const inner = first === body ? path : [...path, titleOf(first)];
          visit(body, inner);
          return;
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, path));
  };
  visit(sf, []);
  return chains;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function suiteOfSpec(spec: string): Suite {
  if (spec.startsWith('e2e/')) return 'mock';
  return spec.endsWith('.walk.ts') ? 'walk' : 'live';
}

/** The problems with one row's guarding test; `rel` reads are only of validated paths. */
function checkGuard(r: LedgerRow, files: LedgerFiles): string[] {
  const p = (msg: string): string => `row ${r.id}: ${msg}`;
  const m = /^(mock|live|walk): (.+)$/.exec(r.guard);
  if (m === null) return [p(`the guarding test "${r.guard}" must start with mock:, live: or walk: and a space`)];
  const suite = m[1] as Suite;
  const line = m[2];
  const delim = line.includes('›') ? '›' : '>';
  const parts = line.split(` ${delim} `).map((s) => s.trim());
  if (parts.length < 3) return [p(`the guarding test "${r.guard}" needs [project], a file and at least one title, split by " › " or " > "`)];
  const problems: string[] = [];
  for (const part of parts) {
    if (part.includes('›') || part.includes('>')) {
      problems.push(p(`refused: the guarding test's part "${part}" holds › or >, which the proof script reads as a separator`));
    } else if (part === '') {
      problems.push(p('the guarding test has an empty part'));
    }
  }
  if (problems.length > 0) return problems;

  const proj = /^\[([A-Za-z0-9._-]+)\]$/.exec(parts[0]);
  const file = parts[1];
  const titles = parts.slice(2);
  if (proj === null) return [p(`the guarding test must start with [<project>], not "${parts[0]}"`)];
  const project = proj[1];
  if (!SUITE_PROJECTS[suite].includes(project)) {
    problems.push(p(`the project [${project}] is not a project of the ${suite} suite (${SUITE_PROJECTS[suite].join(', ')})`));
  }
  if (!GUARD_FILE_RE.test(file)) {
    return [...problems, p(`the guarding test's file "${file}" must be a .ts path under the ${suite} suite's folder ${SUITE_DIR[suite]}/ with no part starting with a dot`)];
  }
  const want = suite === 'walk' ? '.walk.ts' : '.spec.ts';
  if (!file.endsWith(want)) problems.push(p(`the guarding test's file "${file}" must end in ${want} for the ${suite} suite`));
  if (suite === 'live') {
    const terminal = file.endsWith('.terminal.spec.ts');
    if (terminal && project !== 'live-terminal') problems.push(p(`"${file}" is a terminal spec, which runs only in the live-terminal project`));
    if (!terminal && project === 'live-terminal') problems.push(p(`the live-terminal project runs only *.terminal.spec.ts files, not "${file}"`));
  }
  if (problems.length > 0) return problems;

  const rel = `${SUITE_DIR[suite]}/${file}`;
  if (!files.exists(rel)) return [p(`the guarding test's file ${rel} doesn't exist`)];
  const chains = titleChains(files.read(rel), rel);
  const candidates = chains.filter((c) => c.length === titles.length && c.every((t, i) => ('dynamic' in t ? t.could.test(titles[i]) : t.text === titles[i])));
  const shown = titles.join(' › ');
  const dynamic = candidates.flatMap((c) => c.filter((t): t is { dynamic: string; could: RegExp } => 'dynamic' in t).map((t) => t.dynamic));
  if (dynamic.length > 0) return [p(`refused: the title path "${shown}" in ${rel} could match a title it can't read as text: ${dynamic[0]}`)];
  if (candidates.length === 0) return [p(`no test in ${rel} has the title path "${shown}" (describe titles in order, ending in a test title)`)];
  if (candidates.length > 1) return [p(`${candidates.length} tests in ${rel} have the title path "${shown}"; it must name exactly one`)];
  return [];
}

/** The problems with one output file, which must exist (checked by the caller). */
function checkOutput(r: LedgerRow, rel: string, text: string, side: 'old' | 'new', suite: Suite | null, target: string, patchSha: string | null): string[] {
  const p = (msg: string): string => `row ${r.id}: ${rel} ${msg}`;
  const verdicts = text.split(/\r?\n/).filter((l) => l === VERDICT || l.startsWith(`${VERDICT} `));
  if (verdicts.length === 0) return [p(`has no line starting ${VERDICT}, so it doesn't show the ${side} side failing`)];
  const line = verdicts.find((l) => l.split(' ').includes(`run=${side}`));
  if (line === undefined) return [p(`has no ${VERDICT} line with run=${side}; it is not the ${side} side's output`)];
  const problems: string[] = [];
  const tokens = line.split(' ');
  if (suite !== null && !tokens.includes(`suite=${suite}`)) problems.push(p(`says it ran in another suite; its ${VERDICT} line needs suite=${suite}`));
  if (patchSha !== null) {
    const got = tokens.find((t) => t.startsWith('patch_sha256='))?.slice('patch_sha256='.length) ?? 'none';
    if (got !== patchSha) problems.push(p(`was made with another patch: patch_sha256=${got}, but rebreak/${r.id}.patch hashes to ${patchSha}`));
  }
  if (!line.endsWith(` target=${target}`)) problems.push(p(`proves another target; its ${VERDICT} line must end with target=${target}`));
  return problems;
}

export function checkLedger(rows: readonly LedgerRow[], files: LedgerFiles): string[] {
  const problems: string[] = [];
  if (rows.length === 0) problems.push('the ledger has no rows; a ledger with no rows proves nothing');

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  const owned = new Set<string>();

  for (const r of rows) {
    if (!ID_RE.test(r.id)) {
      problems.push(`row "${r.id}" at line ${r.line}: refused: the id must match ${ID_RE.source}, so no path is built from it`);
      continue;
    }
    const p = (msg: string): string => `row ${r.id}: ${msg}`;
    const n = counts.get(r.id) ?? 0;
    if (n > 1) problems.push(p(`the id appears in ${n} rows; ids must be unique`));
    const patch = `${REBREAK_DIR}/${r.id}.patch`;
    const oldOut = `${REBREAK_DIR}/${r.id}.old.txt`;
    const newOut = `${REBREAK_DIR}/${r.id}.new.txt`;
    for (const f of [patch, oldOut, newOut]) owned.add(f.slice(REBREAK_DIR.length + 1));

    if (r.state !== 'kept' && r.state !== 'deleted') problems.push(p(`the state is "${r.state}"; it must be kept or deleted`));
    if (r.defect === '') problems.push(p('the defect cell is empty'));

    const specOk = SPEC_RE.test(r.spec);
    if (!specOk) {
      problems.push(p(`the spec "${r.spec}" must be e2e/<file>.spec.ts, e2e-live/<file>.spec.ts or e2e-live/<file>.walk.ts`));
    } else if (r.state === 'kept' && !files.exists(r.spec)) {
      problems.push(p(`the state is kept, but its spec ${r.spec} is missing`));
    } else if (r.state === 'deleted' && files.exists(r.spec)) {
      problems.push(p(`the state is deleted, but its spec ${r.spec} still exists`));
    }

    for (const [cell, want, name] of [[r.patch, patch, 'patch'], [r.oldOut, oldOut, 'old output'], [r.newOut, newOut, 'new output']] as const) {
      if (cell !== want) problems.push(p(`the ${name} cell is "${cell}"; it must be ${want}`));
    }

    const contents = new Map<string, string>();
    for (const f of [patch, oldOut, newOut]) {
      if (!files.exists(f)) {
        problems.push(p(`${f} is missing`));
        continue;
      }
      const text = files.read(f);
      if (text.trim() === '') problems.push(p(`${f} is empty`));
      else contents.set(f, text);
    }
    const patchText = contents.get(patch);
    const patchSha = patchText === undefined ? null : sha256(patchText);
    const guardSuite = /^(mock|live|walk):/.exec(r.guard)?.[1] as Suite | undefined;
    const oldText = contents.get(oldOut);
    if (oldText !== undefined) problems.push(...checkOutput(r, oldOut, oldText, 'old', specOk ? suiteOfSpec(r.spec) : null, r.spec, patchSha));
    const newText = contents.get(newOut);
    if (newText !== undefined) problems.push(...checkOutput(r, newOut, newText, 'new', guardSuite ?? null, r.guard, patchSha));

    problems.push(...checkGuard(r, files));
  }

  for (const name of files.list(REBREAK_DIR)) {
    if (!owned.has(name)) problems.push(`${REBREAK_DIR}/${name} belongs to no row; every file under ${REBREAK_DIR}/ is a row's patch or output`);
  }
  return problems;
}
