// THE GUARD ON THE TEST LEDGER (phase 111, D-05).
//
// A browser spec leaves the tree only with a proof: a patch that re-creates the defect it was
// written for, the old spec's failing output on that patch, and the failing output of the test that
// guards the defect now. `frontend/TEST-LEDGER.md` lists each proof, and `scripts/rebreak.sh` makes
// it. Nothing stopped a later edit from dropping the patch or an output, or renaming the guarding
// test away, while CI stayed green. This gate holds every row to its three files and to a guarding
// test that exists.
//
// It reads committed files and never imports a spec or Playwright (the `glPinConfig.test.ts`
// reason: importing a Playwright file drags the runner into the unit suite). `testLedger.ts` does
// the work; the in-memory cases below feed it a small ledger and a file map, so each kind of broken
// row is seen red on every run, and the last case holds the real ledger.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLedger, LEDGER_HEADER, parseLedger, type LedgerFiles } from './testLedger';

const root = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

/** The real tree, relative to `frontend/`. */
const REAL_FILES: LedgerFiles = {
  exists: (rel) => existsSync(root(rel)),
  read: (rel) => readFileSync(root(rel), 'utf8'),
  list: (dir) => (existsSync(root(dir)) ? readdirSync(root(dir)) : []),
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A guarding spec with two describes, a nested serial describe and two template titles. */
const GUARD_SPEC = `
import { expect, test } from '@playwright/test';

test.describe('the welcome card opens the list', () => {
  test('the welcome card opens the list', async ({ page }) => {
    await expect(page.getByRole('heading')).toBeVisible();
  });
  test('a second test', async () => {});
});

test.describe('the lesson list', () => {
  test('each row state reads right', async () => {});
  test('the welcome card opens the list', async () => {});
  test.describe.serial('inner', () => {
    test('deep test', async () => {});
  });
});

test.describe('a dynamic block', () => {
  for (const n of [1, 2]) {
    test(\`row \${n} reads right\`, async () => {});
  }
  test(\`a plain template title\`, async () => {});
});
`;

const OLD_SPEC = "import { test } from '@playwright/test';\ntest('the old one', async () => {});\n";
const PATCH = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
const GUARD = 'mock: [chromium] › lessons.spec.ts › the welcome card opens the list › the welcome card opens the list';
const SPEC = 'e2e-live/12-welcome-card.spec.ts';

/** One output as `rebreak.sh` writes it: the run's report, the control line, the verdict line. */
function output(side: 'old' | 'new', suite: string, target: string, patch = PATCH): string {
  return [
    'Running 1 test using 1 worker',
    '  1 failed',
    'REBREAK control=passed tests=1',
    `REBREAK verdict=RED run=${side} suite=${suite} commit=${'0'.repeat(40)} patch_sha256=${sha(patch)} tests=1 failed=1 target=${target}`,
    '',
  ].join('\n');
}

interface RowCells {
  id: string;
  state: string;
  spec: string;
  defect: string;
  guard: string;
  patch: string;
  oldOut: string;
  newOut: string;
}

function row(over: Partial<RowCells> = {}): string {
  const id = over.id ?? 'demo';
  const c: RowCells = {
    id,
    state: 'kept',
    spec: SPEC,
    defect: 'A first-time user never sees the welcome card',
    guard: GUARD,
    patch: `rebreak/${id}.patch`,
    oldOut: `rebreak/${id}.old.txt`,
    newOut: `rebreak/${id}.new.txt`,
    ...over,
  };
  return `| ${[c.id, c.state, c.spec, c.defect, c.guard, c.patch, c.oldOut, c.newOut].join(' | ')} |`;
}

function ledger(...rows: string[]): string {
  return ['# Test ledger', '', 'Some prose.', '', LEDGER_HEADER, '|----|-------|------|--------|---------------|-------|------------|------------|', ...rows, ''].join('\n');
}

/** The three rebreak files of one row, consistent with `GUARD` and `SPEC`. */
function proofFiles(id: string, guard = GUARD, spec = SPEC, patch = PATCH): Record<string, string> {
  const oldSuite = spec.startsWith('e2e/') ? 'mock' : spec.endsWith('.walk.ts') ? 'walk' : 'live';
  return {
    [`rebreak/${id}.patch`]: patch,
    [`rebreak/${id}.old.txt`]: output('old', oldSuite, spec, patch),
    [`rebreak/${id}.new.txt`]: output('new', guard.slice(0, guard.indexOf(':')), guard, patch),
  };
}

function baseFiles(): Record<string, string> {
  return {
    'e2e/lessons.spec.ts': GUARD_SPEC,
    [SPEC]: OLD_SPEC,
    'e2e-live/90-fatal.terminal.spec.ts': "import { test } from '@playwright/test';\ntest.describe('fatal', () => { test('ends the host', async () => {}); });\n",
    'e2e-live/lesson.walk.ts': "import { test } from '@playwright/test';\ntest('the lesson walk', async () => {});\n",
    ...proofFiles('demo'),
  };
}

/** A file map over `map`, recording every path the gate touches. */
function memFiles(map: Record<string, string>): LedgerFiles & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    exists: (rel) => {
      touched.push(rel);
      return Object.prototype.hasOwnProperty.call(map, rel);
    },
    read: (rel) => {
      touched.push(rel);
      if (!Object.prototype.hasOwnProperty.call(map, rel)) throw new Error(`no file ${rel}`);
      return map[rel];
    },
    list: (dir) => {
      touched.push(dir);
      const prefix = `${dir}/`;
      return Object.keys(map)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
  };
}

function problemsOf(text: string, map: Record<string, string>): string[] {
  const parsed = parseLedger(text);
  return [...parsed.problems, ...checkLedger(parsed.rows, memFiles(map))];
}

/** Asserts one problem holds every needle; the message names the row and lists what was found. */
function expectProblem(problems: string[], needles: string[], what: string): void {
  expect(
    problems.some((p) => needles.every((n) => p.includes(n))),
    `${what}: expected a problem naming ${JSON.stringify(needles)}, got ${JSON.stringify(problems)}`,
  ).toBe(true);
}

describe('the test ledger gate on in-memory ledgers', () => {
  it('PASSES the baseline row, with its patch, both outputs and a guarding test that exists', () => {
    const parsed = parseLedger(ledger(row()));
    expect(parsed.rows.length, 'row demo: the baseline ledger parses to one row').toBe(1);
    expect(problemsOf(ledger(row()), baseFiles()), 'row demo: the baseline row has no problem').toEqual([]);
  });

  it('PASSES two rows in either order', () => {
    const guard2 = 'mock: [chromium] › lessons.spec.ts › the lesson list › inner › deep test';
    const files = { ...baseFiles(), ...proofFiles('second', guard2) };
    const second = row({ id: 'second', guard: guard2 });
    expect(problemsOf(ledger(row(), second), files), 'rows demo and second, in that order').toEqual([]);
    expect(problemsOf(ledger(second, row()), files), 'rows second and demo, in that order').toEqual([]);
  });

  it('PASSES a guarding line written with > separators, a plain template title and a live-terminal guard', () => {
    const gt = 'mock: [chromium] > lessons.spec.ts > the welcome card opens the list > the welcome card opens the list';
    const tmpl = 'mock: [chromium] › lessons.spec.ts › a dynamic block › a plain template title';
    const term = 'live: [live-terminal] › 90-fatal.terminal.spec.ts › fatal › ends the host';
    const walk = 'walk: [walk] › lesson.walk.ts › the lesson walk';
    for (const [id, guard] of [['gt', gt], ['tmpl', tmpl], ['term', term], ['walk', walk]] as const) {
      const files = { ...baseFiles(), ...proofFiles(id, guard) };
      expect(problemsOf(ledger(row(), row({ id, guard })), files), `row ${id}: ${guard}`).toEqual([]);
    }
  });

  it('FLAGS a header-only ledger (a gate with nothing to check proves nothing)', () => {
    const files = baseFiles();
    for (const k of Object.keys(files)) if (k.startsWith('rebreak/')) delete files[k];
    expectProblem(problemsOf(ledger(), files), ['no rows'], 'the header-only ledger');
  });

  it('FLAGS a ledger without the exact header, and a row with the wrong number of cells', () => {
    const noHeader = ledger(row()).replace(LEDGER_HEADER, '| id | state | spec | defect | guard | patch | old output | new output |');
    expectProblem(problemsOf(noHeader, baseFiles()), ['header'], 'the ledger with a renamed column');
    const short = ledger(row().replace(/ \| rebreak\/demo\.new\.txt \|$/, ' |'));
    expectProblem(problemsOf(short, baseFiles()), ['demo', '7 cells'], 'row demo with seven cells');
  });

  it('FLAGS a row whose new output is missing, naming the row and the file', () => {
    const files = baseFiles();
    delete files['rebreak/demo.new.txt'];
    expectProblem(problemsOf(ledger(row()), files), ['demo', 'rebreak/demo.new.txt', 'missing'], 'row demo without its new output');
  });

  it('FLAGS a row whose old output is missing, naming the row and the file', () => {
    const files = baseFiles();
    delete files['rebreak/demo.old.txt'];
    expectProblem(problemsOf(ledger(row()), files), ['demo', 'rebreak/demo.old.txt', 'missing'], 'row demo without its old output');
  });

  it('FLAGS a row whose patch is missing, naming the row and the file', () => {
    const files = baseFiles();
    delete files['rebreak/demo.patch'];
    expectProblem(problemsOf(ledger(row()), files), ['demo', 'rebreak/demo.patch', 'missing'], 'row demo without its patch');
  });

  it('FLAGS an empty output and an empty patch', () => {
    const files = { ...baseFiles(), 'rebreak/demo.old.txt': '' };
    expectProblem(problemsOf(ledger(row()), files), ['demo', 'rebreak/demo.old.txt', 'empty'], 'row demo with an empty old output');
    const noPatch = { ...baseFiles(), 'rebreak/demo.patch': '' };
    expectProblem(problemsOf(ledger(row()), noPatch), ['demo', 'rebreak/demo.patch', 'empty'], 'row demo with an empty patch');
  });

  it('FLAGS an output without a line starting REBREAK verdict=RED', () => {
    const green = baseFiles()['rebreak/demo.new.txt'].replace('REBREAK verdict=RED', 'REBREAK verdict=GREEN');
    const files = { ...baseFiles(), 'rebreak/demo.new.txt': green };
    expectProblem(problemsOf(ledger(row()), files), ['demo', 'rebreak/demo.new.txt', 'REBREAK verdict=RED'], 'row demo with a green new output');
    const indented = baseFiles()['rebreak/demo.new.txt'].replace('REBREAK verdict=RED', '  REBREAK verdict=RED');
    expectProblem(
      problemsOf(ledger(row()), { ...baseFiles(), 'rebreak/demo.new.txt': indented }),
      ['demo', 'rebreak/demo.new.txt', 'REBREAK verdict=RED'],
      'row demo whose verdict line does not start the line',
    );
  });

  it('FLAGS swapped outputs (run=new in the old output), another suite, and an output made with another patch', () => {
    const f = baseFiles();
    const swapped = { ...f, 'rebreak/demo.old.txt': f['rebreak/demo.new.txt'], 'rebreak/demo.new.txt': f['rebreak/demo.old.txt'] };
    expectProblem(problemsOf(ledger(row()), swapped), ['demo', 'rebreak/demo.old.txt', 'run=old'], 'row demo with its outputs swapped');
    const suite = { ...f, 'rebreak/demo.old.txt': f['rebreak/demo.old.txt'].replace('suite=live', 'suite=mock') };
    expectProblem(problemsOf(ledger(row()), suite), ['demo', 'rebreak/demo.old.txt', 'suite=live'], 'row demo whose old output names the mock suite');
    const repatched = { ...f, 'rebreak/demo.patch': `${PATCH}+c\n` };
    expectProblem(problemsOf(ledger(row()), repatched), ['demo', 'patch_sha256'], 'row demo whose patch changed after the proof');
  });

  it('FLAGS an output whose target is not the row it sits in', () => {
    const f = baseFiles();
    const other = { ...f, 'rebreak/demo.new.txt': output('new', 'mock', 'mock: [chromium] › lessons.spec.ts › the lesson list › each row state reads right') };
    expectProblem(problemsOf(ledger(row()), other), ['demo', 'rebreak/demo.new.txt', 'target'], 'row demo whose new output proves another test');
  });

  it('FLAGS a guarding title that is not in the file', () => {
    const guard = 'mock: [chromium] › lessons.spec.ts › the welcome card opens the list › no such test';
    const files = { ...baseFiles(), ...proofFiles('demo', guard) };
    expectProblem(problemsOf(ledger(row({ guard })), files), ['demo', 'no such test'], 'row demo naming a missing test');
  });

  it('FLAGS a title taken from a neighbouring describe, and a chain that skips a describe', () => {
    const neighbour = 'mock: [chromium] › lessons.spec.ts › the welcome card opens the list › each row state reads right';
    const f1 = { ...baseFiles(), ...proofFiles('demo', neighbour) };
    expectProblem(problemsOf(ledger(row({ guard: neighbour })), f1), ['demo', 'each row state reads right'], 'row demo naming a test from the next describe');
    const skipped = 'mock: [chromium] › lessons.spec.ts › the lesson list › deep test';
    const f2 = { ...baseFiles(), ...proofFiles('demo', skipped) };
    expectProblem(problemsOf(ledger(row({ guard: skipped })), f2), ['demo', 'deep test'], 'row demo skipping the inner describe');
    const bare = 'mock: [chromium] › lessons.spec.ts › the welcome card opens the list';
    const f3 = { ...baseFiles(), ...proofFiles('demo', bare) };
    expectProblem(problemsOf(ledger(row({ guard: bare })), f3), ['demo', 'no test'], 'row demo naming a describe, not a test');
    const longer = `${GUARD} › one more`;
    const f4 = { ...baseFiles(), ...proofFiles('demo', longer) };
    expectProblem(problemsOf(ledger(row({ guard: longer })), f4), ['demo', 'no test', 'one more'], 'row demo with a title past the real test');
  });

  it('FLAGS a project from another suite', () => {
    const guard = 'mock: [live] › lessons.spec.ts › the welcome card opens the list › the welcome card opens the list';
    const files = { ...baseFiles(), ...proofFiles('demo', guard) };
    expectProblem(problemsOf(ledger(row({ guard })), files), ['demo', '[live]'], 'row demo with a live project on a mock guard');
    const term = 'live: [live] › 90-fatal.terminal.spec.ts › fatal › ends the host';
    const f2 = { ...baseFiles(), ...proofFiles('demo', term) };
    expectProblem(problemsOf(ledger(row({ guard: term })), f2), ['demo', 'live-terminal'], 'row demo running a terminal spec in the live project');
  });

  it("FLAGS a file outside the suite's folder, and a file of the wrong kind for its suite", () => {
    const outside = 'mock: [chromium] › ../e2e-live/12-welcome-card.spec.ts › the old one';
    const f1 = { ...baseFiles(), ...proofFiles('demo', outside) };
    expectProblem(problemsOf(ledger(row({ guard: outside })), f1), ['demo', '../e2e-live/12-welcome-card.spec.ts'], 'row demo reaching out of e2e/');
    const seen = memFiles(f1);
    const parsed = parseLedger(ledger(row({ guard: outside })));
    checkLedger(parsed.rows, seen);
    expect(seen.touched.filter((p) => p.includes('..')), 'row demo: the gate read no path with ..').toEqual([]);
    const walkSpec = 'walk: [walk] › 12-welcome-card.spec.ts › the old one';
    const f2 = { ...baseFiles(), ...proofFiles('demo', walkSpec) };
    expectProblem(problemsOf(ledger(row({ guard: walkSpec })), f2), ['demo', '.walk.ts'], 'row demo naming a spec file in the walk suite');
  });

  it('FLAGS a duplicate id', () => {
    expectProblem(problemsOf(ledger(row(), row()), baseFiles()), ['demo', 'unique'], 'two rows with the id demo');
  });

  it('FLAGS a patch or output path that does not follow the id', () => {
    const files = { ...baseFiles(), 'rebreak/other.patch': PATCH };
    expectProblem(problemsOf(ledger(row({ patch: 'rebreak/other.patch' })), files), ['demo', 'rebreak/demo.patch'], 'row demo naming another patch');
    expectProblem(problemsOf(ledger(row({ oldOut: 'rebreak/demo.txt' })), baseFiles()), ['demo', 'rebreak/demo.old.txt'], 'row demo naming a wrong old output');
    expectProblem(problemsOf(ledger(row({ newOut: 'rebreak/demo.old.txt' })), baseFiles()), ['demo', 'rebreak/demo.new.txt'], 'row demo naming a wrong new output');
  });

  it('FLAGS a kept row whose spec is missing, a deleted row whose spec still exists, and a bad state', () => {
    const files = baseFiles();
    delete files[SPEC];
    expectProblem(problemsOf(ledger(row()), files), ['demo', SPEC, 'kept'], 'kept row demo with its spec gone');
    expectProblem(problemsOf(ledger(row({ state: 'deleted' })), baseFiles()), ['demo', SPEC, 'deleted'], 'deleted row demo with its spec still there');
    expectProblem(problemsOf(ledger(row({ state: 'gone' })), baseFiles()), ['demo', 'state'], 'row demo with state gone');
    expectProblem(problemsOf(ledger(row({ spec: 'e2e-live/sub/x.spec.ts' })), baseFiles()), ['demo', 'e2e-live/sub/x.spec.ts'], 'row demo with a spec in a subfolder');
  });

  it('FLAGS a file under rebreak/ that no row names', () => {
    const files = { ...baseFiles(), 'rebreak/stray.old.txt': 'left behind' };
    expectProblem(problemsOf(ledger(row()), files), ['rebreak/stray.old.txt'], 'the stray output beside row demo');
  });

  it('REFUSES a title written as a template literal with a substitution', () => {
    const guard = 'mock: [chromium] › lessons.spec.ts › a dynamic block › row 1 reads right';
    const files = { ...baseFiles(), ...proofFiles('demo', guard) };
    expectProblem(problemsOf(ledger(row({ guard })), files), ['demo', 'refused', 'substitution'], 'row demo naming a template title');
  });

  it('REFUSES a title containing › or >', () => {
    const arrow = 'mock: [chromium] › lessons.spec.ts › the lesson list › a > b';
    const f1 = { ...baseFiles(), ...proofFiles('demo', arrow) };
    expectProblem(problemsOf(ledger(row({ guard: arrow })), f1), ['demo', 'refused', 'a > b'], 'row demo with > inside a title');
    const chevron = 'mock: [chromium] › lessons.spec.ts › the lesson list›each row state reads right';
    const f2 = { ...baseFiles(), ...proofFiles('demo', chevron) };
    expectProblem(problemsOf(ledger(row({ guard: chevron })), f2), ['demo', 'refused', '›'], 'row demo with › inside a title');
  });

  it('REFUSES an id containing ../ before reading any path built from it', () => {
    const files = memFiles(baseFiles());
    const parsed = parseLedger(ledger(row({ id: '../x' })));
    const problems = [...parsed.problems, ...checkLedger(parsed.rows, files)];
    expectProblem(problems, ['../x', 'refused'], 'row ../x');
    expect(files.touched.filter((p) => p.includes('..')), 'row ../x: no path with .. was touched').toEqual([]);
  });
});

describe('the real test ledger', () => {
  it('PASSES frontend/TEST-LEDGER.md: at least one row, and every row has its files and a guarding test', () => {
    const parsed = parseLedger(readFileSync(root('TEST-LEDGER.md'), 'utf8'));
    expect(parsed.rows.length, 'TEST-LEDGER.md: the ledger has at least one row').toBeGreaterThan(0);
    expect(parsed.problems, 'TEST-LEDGER.md: the table parses').toEqual([]);
    expect(checkLedger(parsed.rows, REAL_FILES), `TEST-LEDGER.md rows ${parsed.rows.map((r) => r.id).join(', ')}`).toEqual([]);
  });
});
