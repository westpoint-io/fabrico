// liveWaitCaps.source.test.ts - the gate on the live suite's wall-clock caps (plan 84-18).
//
// D-12 restates every wall-clock cap around a FRAME-BOUND wait from the frames the wait needs,
// never a picked number. Plan 84-13 restated them by hand and missed three caps around screen
// captures, each found by a red proxy pass (84-17). `liveWaitCaps.ts` lists every cap in the
// suite mechanically, with its value class and the region its wait reads; this gate holds the
// rules on fixtures and holds the real tree.
//
// Each fixture case scans a small in-memory map of sources keyed as `readLiveSources` keys them
// (paths from `frontend/`), so a support module is imported the way a spec imports it.

import { describe, expect, it } from 'vitest';
import { scanLiveWaitCaps, type CapRow, type ScanResult } from './liveWaitCaps';

/** A support module with the oracle's capture and travel helpers and a model read. */
const SUPPORT = `
import { expect, test, type Page } from '@playwright/test';
import { addFrameBudget } from '../../e2e/support/frameSampler';
export const CAPTURE_FRAMES = 28;
export async function captureClip(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  addFrameBudget(CAPTURE_FRAMES, 'one clip capture');
  return page.screenshot({ clip });
}
export async function pointerTravel(page: Page, x: number, y: number, steps = 1): Promise<void> {
  addFrameBudget(steps * 2, 'travel');
  await page.mouse.move(x, y, { steps });
}
export async function readScene(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __fabrico: { scene(): unknown } }).__fabrico.scene());
}
export async function grab(page: Page): Promise<Buffer> {
  return captureClip(page, { x: 0, y: 0, width: 10, height: 10 });
}
`;

/** The frame sampler's budget helpers, as the real module declares them. */
const SAMPLER = `
export function frameBudgetMs(frames: number, minMs = 0): number { return Math.ceil(Math.max(minMs, frames * 285) * 1.1 + 3143); }
export function tickBudgetMs(ticks: number): number { return Math.ceil(ticks * 39); }
export function addFrameBudget(frames: number, reason: string): number { return frameBudgetMs(frames); }
export function addWaitBudget(ms: number, reason: string): number { return ms; }
`;

const SPEC = 'e2e-live/99-fixture.live.spec.ts';

function scan(spec: string): ScanResult {
  return scanLiveWaitCaps({
    [SPEC]: spec,
    'e2e-live/support/oracle.ts': SUPPORT,
    'e2e/support/frameSampler.ts': SAMPLER,
  });
}

/** The 1-based line of the first line of `src` containing `needle`. */
function lineWith(src: string, needle: string): number {
  const i = src.split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`fixture has no line containing ${needle}`);
  return i + 1;
}

function rowAt(r: ScanResult, line: number): CapRow | undefined {
  return r.rows.find((x) => x.path === SPEC && x.line === line);
}

const HEAD = `import { test, expect } from '@playwright/test';
import { captureClip, grab, pointerTravel, readScene } from './support/oracle';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
`;

describe('the live suite wall-clock cap scanner (plan 84-18, D-12)', () => {
  it('FLAGS a literal timeout on a poll whose callback takes a capture (the 84-17 rings shape)', () => {
    const src = `${HEAD}
test('rings', async ({ page }) => {
  await expect
    .poll(
      async () => {
        const png = await page.screenshot({ clip: { x: 0, y: 0, width: 32, height: 32 } });
        return png.length > 0;
      },
      { timeout: 10_000, intervals: [100, 250, 500], message: 'the armed rings reached the canvas' },
    )
    .toBe(true);
});
`;
    const r = scan(src);
    const row = rowAt(r, lineWith(src, 'timeout: 10_000'));
    expect(row, 'a row at the timeout').toBeDefined();
    expect(row).toMatchObject({ kind: 'poll', value: 'literal', ms: 10000, region: 'CAPTURE', frameBound: true, verdict: 'RED' });
  });

  it('FLAGS a literal bound to a const on a poll that reads a drawn hook', () => {
    const src = `${HEAD}
const DRAWN_CAP_MS = 8_000;
test('drawn', async ({ page }) => {
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __fabrico: { frame(): number } }).__fabrico.frame()), {
      timeout: DRAWN_CAP_MS,
      message: 'the frame advanced',
    })
    .toBeGreaterThan(3);
});
`;
    const row = rowAt(scan(src), lineWith(src, 'timeout: DRAWN_CAP_MS'));
    expect(row).toMatchObject({ kind: 'poll', value: 'literal', ms: 8000, region: 'DRAWN', frameBound: true, verdict: 'RED' });
  });

  it('FLAGS a literal on a poll whose capture is two helper calls deep', () => {
    const src = `${HEAD}
async function inkAt(page: import('@playwright/test').Page): Promise<number> {
  const png = await grab(page);
  return png.length;
}
test('deep', async ({ page }) => {
  await expect.poll(async () => inkAt(page), { timeout: 10_000, message: 'ink showed' }).toBeGreaterThan(0);
});
`;
    const row = rowAt(scan(src), lineWith(src, 'timeout: 10_000'));
    expect(row).toMatchObject({ kind: 'poll', value: 'literal', region: 'CAPTURE', frameBound: true, verdict: 'RED' });
  });

  it('PASSES a timeout derived through addWaitBudget from frameBudgetMs and tickBudgetMs', () => {
    const src = `${HEAD}
const TRIES = 2;
test('derived', async ({ page }) => {
  await expect
    .poll(async () => (await captureClip(page, { x: 0, y: 0, width: 4, height: 4 })).length, {
      timeout: addWaitBudget(frameBudgetMs(TRIES * CAPTURE_FRAMES + 2) + tickBudgetMs(4), 'two captures'),
      message: 'derived',
    })
    .toBeGreaterThan(0);
});
const CAPTURE_FRAMES = 28;
`;
    const r = scan(src);
    const row = rowAt(r, lineWith(src, 'timeout: addWaitBudget('));
    expect(row).toMatchObject({ kind: 'poll', value: 'derived', region: 'CAPTURE', frameBound: true, verdict: 'ok' });
    expect(r.rawCaptures, 'the capture is through captureClip').toEqual([]);
    expect(r.summary.red).toBe(0);
  });

  it('REFUSES a derived form that adds milliseconds', () => {
    const src = `${HEAD}
test('laundered', async ({ page }) => {
  await expect
    .poll(async () => (await grab(page)).length, {
      timeout: addWaitBudget(frameBudgetMs(4) + 5_000, 'four frames and five seconds'),
      message: 'laundered',
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await grab(page)).length, { timeout: frameBudgetMs(4, 9_000), message: 'a numeric floor' })
    .toBeGreaterThan(0);
});
`;
    const r = scan(src);
    expect(rowAt(r, lineWith(src, 'timeout: addWaitBudget('))).toMatchObject({ value: 'other', verdict: 'RED' });
    expect(rowAt(r, lineWith(src, 'timeout: frameBudgetMs(4, 9_000)'))).toMatchObject({ value: 'other', verdict: 'RED' });
  });

  it('LEAVES a literal on a model wait and names why', () => {
    const src = `${HEAD}
test('model', async ({ page }) => {
  await expect
    .poll(async () => ((await readScene(page)) as { belts: unknown[] }).belts.length, {
      timeout: 15_000,
      message: 'a belt was minted',
    })
    .toBe(1);
});
`;
    const row = rowAt(scan(src), lineWith(src, 'timeout: 15_000'));
    expect(row).toMatchObject({ kind: 'poll', value: 'literal', ms: 15000, region: 'MODEL', frameBound: false, verdict: 'ok' });
    expect(row!.why).toMatch(/MODEL wait: D-12 covers frame-bound waits only/);
  });

  it('FLAGS a capture outside captureClip and requestScreen', () => {
    const src = `${HEAD}
test('raw', async ({ page }) => {
  await page.screenshot({ path: 'x.png' });
});
`;
    const r = scan(src);
    expect(r.rawCaptures).toEqual([{ path: SPEC, line: lineWith(src, 'page.screenshot(') }]);
    expect(r.summary.red).toBe(1);
  });

  it('FLAGS a __fabrico hook the table does not class', () => {
    const src = `${HEAD}
test('hook', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __fabrico: { mysteryHook(): void } }).__fabrico.mysteryHook());
});
`;
    const r = scan(src);
    expect(r.unknownHooks.map((h) => h.name)).toContain('mysteryHook');
    expect(r.unknownHooks.every((h) => h.path === SPEC && h.line === lineWith(src, 'mysteryHook()'))).toBe(true);
  });

  it('FLAGS a test limit literal whose test moves the pointer outside a budgeting helper', () => {
    const src = `${HEAD}
test('raw travel', async ({ page }) => {
  test.setTimeout(120_000);
  await page.mouse.move(10, 10, { steps: 40 });
});
test('budgeted travel', async ({ page }) => {
  test.setTimeout(120_000);
  await pointerTravel(page, 10, 10, 40);
});
`;
    const r = scan(src);
    const lines = src.split('\n').map((l, i) => [l, i + 1] as const).filter(([l]) => l.includes('test.setTimeout'));
    expect(rowAt(r, lines[0][1])).toMatchObject({ kind: 'testLimit', value: 'literal', ms: 120000, frameBound: true, verdict: 'RED', test: `${SPEC}:${lineWith(src, "test('raw travel'")}` });
    expect(rowAt(r, lines[1][1])).toMatchObject({ kind: 'testLimit', frameBound: false, verdict: 'ok' });
  });

  it('FLAGS a deadline loop whose literal cap waits on captures', () => {
    const src = `${HEAD}
test('deadline', async ({ page }) => {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if ((await captureClip(page, { x: 0, y: 0, width: 4, height: 4 })).length > 0) break;
  }
});
`;
    const row = rowAt(scan(src), lineWith(src, 'while (Date.now() < until)'));
    expect(row).toMatchObject({ kind: 'deadline', value: 'literal', ms: 5000, region: 'CAPTURE', frameBound: true, verdict: 'RED' });
  });

  it('FLAGS a parameter default named as a timeout on a frame-bound helper', () => {
    const src = `${HEAD}
async function settle(page: import('@playwright/test').Page, timeoutMs = 6_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const f = await page.evaluate(() => (window as unknown as { __fabrico: { camera(): { scale: number } } }).__fabrico.camera().scale);
    if (f === 1) return;
    if (Date.now() - start >= timeoutMs) return;
  }
}
test('settle', async ({ page }) => {
  await settle(page);
});
`;
    const r = scan(src);
    expect(rowAt(r, lineWith(src, 'timeoutMs = 6_000'))).toMatchObject({ kind: 'paramDefault', value: 'literal', ms: 6000, region: 'DRAWN', frameBound: true, verdict: 'RED' });
    expect(rowAt(r, lineWith(src, 'Date.now() - start >= timeoutMs'))).toMatchObject({ kind: 'deadline', value: 'literal', verdict: 'RED' });
  });

  it('FLAGS a poll with no timeout whose callback takes a capture', () => {
    const src = `${HEAD}
test('no cap', async ({ page }) => {
  await expect.poll(async () => (await captureClip(page, { x: 0, y: 0, width: 4, height: 4 })).length).toBeGreaterThan(0);
});
`;
    const row = rowAt(scan(src), lineWith(src, 'expect.poll('));
    expect(row).toMatchObject({ kind: 'poll', value: 'default', region: 'CAPTURE', verdict: 'RED' });
  });

  it('FLAGS a literal cap passed to the frame sampler (its third argument, capMs)', () => {
    const src = `${HEAD}
import { waitForFrames } from '../e2e/support/frameSampler';
test('sampler', async ({ page }) => {
  await waitForFrames(page, '__window', 20_000);
});
`;
    const row = rowAt(scan(src), lineWith(src, "waitForFrames(page, '__window', 20_000)"));
    expect(row).toMatchObject({ kind: 'sampler', value: 'literal', ms: 20000, region: 'SAMPLER', frameBound: true, verdict: 'RED' });
  });

  it('FOLLOWS an in-page function passed to page.evaluate by reference (the growth sampler shape)', () => {
    const src = `${HEAD}
function readOnAFrame(): Promise<number> {
  return new Promise((done) => requestAnimationFrame(() => done(1)));
}
test('by reference', async ({ page }) => {
  const started = Date.now();
  for (;;) {
    const n = await page.evaluate(readOnAFrame);
    if (n > 0) break;
    if (Date.now() - started > 3_000) break;
  }
});
`;
    const row = rowAt(scan(src), lineWith(src, 'Date.now() - started > 3_000'));
    expect(row).toMatchObject({ kind: 'deadline', value: 'literal', ms: 3000, region: 'SAMPLER', frameBound: true, verdict: 'RED' });
  });
});

// ---- The real tree, and four plants on in-memory copies of real files (plan 84-18 Task 3) ----
// Appended below the fixture cases (none of their lines is edited); imports hoist.
import { readLiveSources } from './liveWaitCaps';
import { fileURLToPath } from 'node:url';

/** `frontend/`, the directory `readLiveSources` keys its paths from. */
const FRONTEND = fileURLToPath(new URL('../..', import.meta.url));

/** Every RED, RAW_CAPTURE and UNKNOWN_HOOK finding of a scan, as one `path:line what` string each. */
function findings(r: ScanResult): string[] {
  return [
    ...r.rows.filter((x) => x.verdict === 'RED').map((x) => `${x.path}:${x.line} RED ${x.kind} ${x.region} ${x.why}`),
    ...r.rawCaptures.map((x) => `${x.path}:${x.line} RAW_CAPTURE`),
    ...r.unknownHooks.map((x) => `${x.path}:${x.line} UNKNOWN_HOOK ${x.name}`),
  ];
}

/**
 * A copy of the real sources with `path` edited: `anchor` must be present exactly once (a missing
 * or doubled anchor fails by name), and `edit` returns the new text. Returns the sources and the
 * 1-based line of the first line of `marker` in the edited file.
 */
function plant(path: string, anchor: string, edit: (text: string) => string, marker: string): { sources: Record<string, string>; line: number } {
  const sources = { ...readLiveSources(FRONTEND) };
  const text = sources[path];
  expect(text, `the plant's file ${path} is in the live sources`).toBeDefined();
  expect(text.split(anchor).length - 1, `the plant's anchor is in ${path} exactly once: ${anchor}`).toBe(1);
  const edited = edit(text);
  sources[path] = edited;
  const i = edited.split('\n').findIndex((l) => l.includes(marker));
  expect(i, `the planted line is in ${path}`).toBeGreaterThanOrEqual(0);
  return { sources, line: i + 1 };
}

describe('the live suite itself, and the gate seen red on planted literals (plan 84-18 Task 3)', () => {
  it('THE LIVE SUITE HAS NO UN-DERIVED LITERAL AROUND A FRAME-BOUND WAIT', () => {
    const r = scanLiveWaitCaps(readLiveSources(FRONTEND));
    expect(r.unparsed, 'every live source parses').toEqual([]);
    expect(r.summary.sites, 'the scan reached the suite (a vacuous scan finds nothing)').toBeGreaterThanOrEqual(100);
    expect(findings(r), 'every wall-clock cap around a frame-bound wait is derived from its frames (D-12); run `node scripts/list-live-wait-caps.ts` from frontend/ for the rows').toEqual([]);
  });

  it('PLANT 1 GOES RED: the armed-rings poll given a millisecond cap again', () => {
    const path = 'e2e-live/74.1-corner-connects.live.spec.ts';
    const anchor = [
      '          timeout: addWaitBudget(',
      '            frameBudgetMs(CAPTURE_POLL_TRIES * 2 * CAPTURE_FRAMES + DRAWN_STATE_FRAMES),',
      '            `armed rings poll: ${CAPTURE_POLL_TRIES} tries of two clip captures`,',
      '          ),',
    ].join('\n');
    const { sources, line } = plant(path, anchor, (t) => t.replace(anchor, '          timeout: 10_000, // PLANT 1'), 'PLANT 1');
    expect(findings(scanLiveWaitCaps(sources))).toEqual([
      expect.stringMatching(new RegExp(`^${path.replace(/\./g, '\\.')}:${line} RED poll CAPTURE `)),
    ]);
  });

  it('PLANT 2 GOES RED: a drawn-state poll capped by a millisecond constant', () => {
    const path = 'e2e-live/74-belt-run-joins.spec.ts';
    const anchor = "    await expectRenderLoopAlive(page, 'with two abutting belts drawn, before the join');\n";
    const planted =
      '    const PLANT_TWO_CAP_MS = 8_000;\n' +
      "    await expect.poll(async () => beltEndInstructionsOn(page, up), { timeout: PLANT_TWO_CAP_MS, message: 'PLANT 2' }).toBe(0);\n";
    const { sources, line } = plant(path, anchor, (t) => t.replace(anchor, anchor + planted), 'PLANT 2');
    expect(findings(scanLiveWaitCaps(sources))).toEqual([
      expect.stringMatching(new RegExp(`^${path.replace(/\./g, '\\.')}:${line} RED poll DRAWN `)),
    ]);
  });

  it('PLANT 3 GOES RED: a capture taken outside captureClip', () => {
    const path = 'e2e-live/74-belt-run-joins.spec.ts';
    const anchor = "    await expectRenderLoopAlive(page, 'with two abutting belts drawn, before the join');\n";
    const planted = "    await page.screenshot({ path: test.info().outputPath('plant-3.png') }); // PLANT 3\n";
    const { sources, line } = plant(path, anchor, (t) => t.replace(anchor, anchor + planted), 'PLANT 3');
    expect(findings(scanLiveWaitCaps(sources))).toEqual([`${path}:${line} RAW_CAPTURE`]);
  });

  it('PLANT 4 GOES RED: a hook the table does not class', () => {
    const path = 'e2e-live/74-belt-run-joins.spec.ts';
    const anchor = "    await expectRenderLoopAlive(page, 'with two abutting belts drawn, before the join');\n";
    const planted =
      '    await page.evaluate(() => (window as unknown as { __fabrico: { plantFourHook(): number } }).__fabrico.plantFourHook()); // PLANT 4\n';
    const { sources, line } = plant(path, anchor, (t) => t.replace(anchor, anchor + planted), 'PLANT 4');
    const found = findings(scanLiveWaitCaps(sources));
    expect(found.length, 'the plant names the unclassed hook').toBeGreaterThan(0);
    expect(found.every((f) => f === `${path}:${line} UNKNOWN_HOOK plantFourHook`), found.join('\n')).toBe(true);
  });
});
