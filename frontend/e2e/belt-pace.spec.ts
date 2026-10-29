import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type InjectBelt,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// belt-pace.spec.ts (BELT-01/BELT-02, plan 68-02) - the tracer's end-to-end check,
// driving ONE belt pace edit through the whole production path:
//
//   a belt TILE press -> `beltAtCell` -> `onSelectBelt` -> App `selectedBelt`
//     -> ConfigPanel `kind=BELT` -> `machine_config` reply -> the `Belt` arm
//     -> BeltConfigBody's five segments -> Apply -> `encodeBeltRunPace`
//     -> ONE `0xFE`-led frame on the gesture channel
//
// The frame is decoded here IN FULL - element count, belt handle, ticks_per_slot -
// and not merely sniffed at its lead byte. A lead-byte-only assertion stays green
// through a frame naming the wrong belt or carrying the wrong pace, which are the
// two things this route can most easily get wrong.
//
// ---------------------------------------------------------------------------
// WHAT THIS FIXTURE PROVES ON ITS OWN, AND WHAT IT DOES NOT (plan 68-06)
// ---------------------------------------------------------------------------
//
// Written in the register `router-panel.spec.ts:44-55` uses for its own
// self-criticism, because the same limitation applies here and an unqualified
// green would be read as covering more than it does.
//
// WHAT IT PROVES. That the FRONTEND, fed a hand-authored render packet and a
// hand-authored `machine_config` reply, walks the run correctly, renders the
// panel correctly, lays the pace group out without clipping worse than a shipped
// comparator, and emits the frame the wire grammar describes.
//
// WHAT IT CANNOT PROVE. Anything about the host. `BELT_CONFIG` below and every
// packet `buildPacket` writes are hand copies with NO link to the Rust producer,
// so a host DTO regression - `ConfigView::Belt` renaming its field, or
// `render_packet.rs` reordering `BeltView` - cannot reach this file, and the
// pressed-segment and run-count assertions below would stay fully green through
// one. Two things elsewhere close that gap and neither is in this file:
// `crates/fabrico-host` pins the host side of `machine_config(belt)` and of the
// run fan-out, and `frontend/e2e-live/23-belt-pace.spec.ts` drives the same panel
// against the real `dev_render_server` with zero mocks.

/**
 * THE CONFIG REPLY, in the `ConfigView::Belt` shape the host answers with.
 *
 * `crates/fabrico-host/src/config_view.rs` renders `MachineConfig::Belt` as
 * `{"kind":"Belt","ticks_per_slot":N}`, and plan 68-01's
 * `query_machine_config_belt_answers_the_default_pace` pins the host side of it.
 *
 * The VALUE is 4 rather than the crate default 2, deliberately: the spec presses a
 * DIFFERENT segment and asserts the emitted pace, so a reply that already sat on
 * the segment being pressed would leave "the panel emitted the pace it was asked
 * for" and "the panel emitted whatever it happened to be showing" indistinguishable.
 */
const BELT_CONFIG = { kind: 'Belt', ticks_per_slot: 4 };

/** The belt handle under test. Dense render-handle space, shared with nodes. */
const BELT_ID = 12;

/** A three-tile straight belt at row 5, undocked. Its `ticksPerSlot` matches
 *  {@link BELT_CONFIG} so the packet and the config read-back agree, which is the
 *  68-UI-SPEC 3.3 two-sources rule holding on a fixture board.
 *
 *  SEATED AT COLUMN 14+ DELIBERATELY. The Palette aside occupies the left band of
 *  the viewport, so a press at cell (5,5) lands on chrome and never reaches the
 *  canvas - a belt seated there produces a spec that fails for a reason that has
 *  nothing to do with the code under test. `router-panel.spec.ts` seats its Router
 *  at column 14 for the same measured reason. */
const BELT: InjectBelt = {
  id: BELT_ID,
  tiles: [
    [14, 5],
    [15, 5],
    [16, 5],
  ],
  ticksPerSlot: 4,
};

/** A tile of the belt - the click-to-select point. */
const BELT_TILE: [number, number] = [15, 5];

/** The pace the spec presses: `ticks_per_slot = 10`, labelled `50`. */
const PRESSED_LABEL = '50';
const PRESSED_TICKS = 10;

/** LEB128 reader, the inverse of `PostcardWriter.varintU`. Copied from
 *  `router-panel.spec.ts` for the same reason it lives there rather than in a
 *  shared module: `frontend/tsconfig.json`'s `include` omits `e2e/`, so a helper
 *  imported across specs is typechecked by nothing. */
class PostcardReader {
  private i = 0;
  constructor(private readonly buf: Buffer) {}
  varintU(): number {
    let out = 0;
    let shift = 1;
    for (;;) {
      const b = this.buf[this.i++];
      out += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return out;
      shift *= 128;
    }
  }
  get offset(): number {
    return this.i;
  }
}

/** The decoded run-pace frame: everything after the `0xFE` sentinel. */
interface RunPaceFrame {
  belts: number[];
  ticksPerSlot: number;
  /** Bytes consumed, so a spec can assert the frame carries no trailing junk. */
  consumed: number;
}

/**
 * Decode the run-pace frame the panel actually emitted.
 *
 * Hand-rolled against the BYTE GRAMMAR rather than by calling the app's own
 * `encodeBeltRunPace`: an assertion built from the encoder under test would be
 * sampling that encoder against itself and would stay green through a wholesale
 * change of the wire format. This reader mirrors the RUST struct
 * `fabrico_host::sim_loop::BeltRunPace` instead.
 */
function decodeRunPace(frame: Buffer): RunPaceFrame {
  expect(frame[0], 'the run-pace frame leads with the 0xFE sentinel').toBe(0xfe);
  const r = new PostcardReader(frame.subarray(1));
  const n = r.varintU();
  const belts: number[] = [];
  for (let i = 0; i < n; i++) belts.push(r.varintU());
  const ticksPerSlot = r.varintU();
  return { belts, ticksPerSlot, consumed: r.offset + 1 };
}

/** One click on a grid cell centre. */
async function clickCell(page: Page, cell: [number, number]): Promise<void> {
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** Boot the mocked app, inject the belt, click a tile of it and wait for the panel. */
async function selectBelt(page: Page): Promise<Harness> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  // Mock BEFORE goto (routeWebSocket must register pre-navigation). Without a
  // machine_config reply the panel hangs on "Loading config...", and the Belt arm
  // is gated on `!loading && config` - so an unanswered query would mask the arm's
  // absence rather than prove its presence.
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? BELT_CONFIG : undefined),
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ belts: [BELT] }));
  await clickCell(page, BELT_TILE);
  await expect(page.locator('#fab-belt-config')).toBeVisible({ timeout: 10_000 });
  return h;
}

test.describe('a belt tile press opens the pace panel and Apply lands ONE run frame', () => {
  test('the panel opens on BELT with exactly one pace pressed, and its two port rows', async ({
    page,
  }) => {
    await selectBelt(page);

    await expect(page.getByRole('heading', { name: 'Belt' })).toBeVisible();

    const group = page.getByRole('group', { name: 'Belt pace' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('button')).toHaveCount(5);
    // EXACTLY ONE pressed, and it is the one the read-back named (ticks 4 -> 125).
    await expect(group.locator('button[aria-pressed="true"]')).toHaveCount(1);
    await expect(group.locator('button[aria-pressed="true"]')).toHaveText('125');

    // 74-UI-SPEC 4.1 (LINK-09), INVERTED IN PLACE from the assertion that stood
    // here: this case used to require NO ports section on a belt, on the 68-UI-SPEC
    // 3.4 reason that with no `Port` records the section would read
    // "Inputs / None / Outputs / None" - a false statement about a belt with ends
    // rather than ports. This phase made that reason false at both ends. A belt
    // declares two ports (74-02), the section states them, and the artefact that
    // recorded the old rule is the artefact that proves the new one (74-04's
    // precedent), on the same board and the same click.
    await expect(page.getByRole('heading', { name: 'Inputs' })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Outputs' })).toHaveCount(1);
    // Two rows, both read through the shipped `portRowLabel`, and NO `None` row -
    // D-06 gives every belt both records, so the empty-group path is unreachable
    // here by construction rather than by luck.
    const ports = page.getByRole('region', { name: 'Ports' });
    await expect(ports.getByRole('listitem', { name: /^Input - Item,/ })).toHaveCount(1);
    await expect(ports.getByRole('listitem', { name: /^Output - Item,/ })).toHaveCount(1);
    await expect(ports.getByRole('listitem', { name: 'None' })).toHaveCount(0);
    // This belt is docked at NEITHER end, so no Disconnect is offered - which is
    // also what stops this case passing merely because a section rendered.
    await expect(ports.getByRole('button', { name: /^Disconnect/ })).toHaveCount(0);
    // A belt cannot grow a third port through the panel: the core forbids one and
    // the trust gate rejects one on load.
    await expect(ports.getByRole('button', { name: '+ Add output' })).toHaveCount(0);
    await expect(ports.getByRole('button', { name: /^Remove output/ })).toHaveCount(0);
  });

  test('Apply emits exactly ONE 0xFE frame carrying the belt and the chosen pace', async ({
    page,
  }) => {
    const h = await selectBelt(page);

    const group = page.getByRole('group', { name: 'Belt pace' });
    // `exact` matters: `250 px per second` CONTAINS `50 px per second`, so a
    // substring match resolves two segments and Playwright's strict mode fails.
    await group
      .getByRole('button', { name: `${PRESSED_LABEL} px per second`, exact: true })
      .click();
    // The buffer is dirty, so Apply is live (its guard is `!loading && config`).
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect.poll(() => h.sent.length).toBe(1);
    // Settle: `expect.poll(...).toBe(1)` resolves the instant the count first
    // reaches 1 and would NOT catch a LATE duplicate - which is exactly the shape
    // an N-frames-per-run implementation produces.
    await page.waitForTimeout(200);
    expect(h.sent, 'ONE Apply must emit ONE frame, never one per belt').toHaveLength(1);

    const decoded = decodeRunPace(h.sent[0]);
    // ALL THREE PARTS, not just the lead byte. A lead-byte-only assertion is green
    // over a frame naming the wrong belt or the wrong pace.
    expect(decoded.belts, 'the frame names the clicked belt, and only it').toEqual([BELT_ID]);
    expect(decoded.ticksPerSlot, 'the frame carries the PRESSED pace').toBe(PRESSED_TICKS);
    expect(decoded.consumed, 'the frame carries no trailing bytes').toBe(h.sent[0].length);
  });
});

// ===========================================================================
// PLAN 68-06 - the readings only a browser can take
// ===========================================================================
//
// Four cases: the run COUNT, the pace group's WIDTH, the scale end-labels, and a
// narrow accessibility scan. Every one of them is here rather than in vitest for
// a reason that is structural and not a preference:
//
//  - the run count needs the REAL selection path (`beltAtCell` -> `onSelectBelt`
//    -> App -> `beltRun`), which a direct body invocation bypasses entirely;
//  - the width needs a laid-out box, a loaded font and a real flex wrap;
//  - `color-contrast` reports INCOMPLETE under jsdom (the `64-UI-SPEC.md`
//    finding), so an axe scan run there is a green that measured nothing.

/** The three belts of the run fixture, in FLOW order: A delivers into B, B into C. */
const RUN_A = 30;
const RUN_B = 31;
const RUN_C = 32;

/**
 * THE RUN LENGTH, STATED. The fixture below builds exactly three belts chained
 * end to end, so the panel must read `runPlural(3)` from ANY tile of it.
 *
 * The dock end names are counter-intuitive and getting them backwards silently
 * halves the run: `end: 'Head'` names the DOWNSTREAM neighbour (the node this
 * belt delivers into) and `end: 'Tail'` the UPSTREAM one. Read off the producer,
 * `crates/fabrico-host/src/render_packet.rs:339-357`, and restated at
 * `frontend/src/render/beltRun.ts`'s fact 1.
 */
const RUN_LENGTH = 3;

/** The exact plural run line for a three-belt run - `runPlural(3)` verbatim.
 *  Transcribed rather than imported for the reason every e2e string here is:
 *  `frontend/tsconfig.json`'s `include` omits `e2e/`, so an import across that
 *  boundary is typechecked by nothing. Exact equality, never a substring. */
const RUN_LINE_THREE = 'This run is 3 belts. Apply sets the pace on all of them.';

/** The singular line, quoted ONLY so the failure message can name the answer a
 *  broken traversal gives. It is never asserted as a pass. */
const RUN_LINE_ONE = 'This run is one belt.';

/** Belt tiles seated at column 14+ for `BELT`'s measured reason: the Palette
 *  aside owns the left band, so a press further left never reaches the canvas. */
function runBelts(ticks: readonly [number, number, number]): InjectBelt[] {
  return [
    {
      id: RUN_A,
      tiles: [
        [14, 7],
        [15, 7],
      ],
      ticksPerSlot: ticks[0],
      docks: [{ end: 'Head', node: RUN_B, port: 0 }],
    },
    {
      id: RUN_B,
      tiles: [
        [16, 7],
        [17, 7],
      ],
      ticksPerSlot: ticks[1],
      docks: [
        { end: 'Tail', node: RUN_A, port: 0 },
        { end: 'Head', node: RUN_C, port: 0 },
      ],
    },
    {
      id: RUN_C,
      tiles: [
        [18, 7],
        [19, 7],
      ],
      ticksPerSlot: ticks[2],
      docks: [{ end: 'Tail', node: RUN_B, port: 0 }],
    },
  ];
}

/** The FIRST tile of the run (belt A's first cell) and the LAST (belt C's last).
 *  The two ends, so the count is asserted from both directions of the walk. */
const RUN_FIRST_TILE: [number, number] = [14, 7];
const RUN_LAST_TILE: [number, number] = [19, 7];

/** An empty cell used to drop the selection between two panel opens. */
const EMPTY_CELL: [number, number] = [16, 11];

/** A Sink (kind 7, 1x1) seated clear of both the Palette band and the config
 *  panel's right-hand column at the 992px minimum. It exists for ONE reason: its
 *  HTTP `Method` group is the SHIPPED comparator the width guard measures
 *  against, and the guard is only honest if both figures come from one run. */
const SINK: InjectNode = {
  id: 40,
  kind: 7,
  cell_x: 14,
  cell_y: 9,
  ports: [{ index: 0, cell_x: 14, cell_y: 9, side: 3, role: 0, medium: 0 }],
};

/** The Sink's config reply: HTTP, which is what reveals the `Method` group. */
const SINK_CONFIG = { kind: 'Sink', target: { kind: 'Http', url: '', method: 1 } };

/** The ledgered minimum viewport width (`STATE.md` / `WINDOWS` id 4, and the
 *  `toolbar-stability.spec.ts:317` reading). Every width figure is taken here. */
const LEDGERED_MIN_WIDTH = 992;

/** The two scale end-labels, transcribed verbatim from `BeltConfigBody.tsx`. */
const SCALE_FASTEST = 'Fastest (250 px/sec)';
const SCALE_SLOWEST = 'Slowest (25 px/sec)';

/** The typed figure that drives the panel to the OFF-SCALE state: 167 px/sec
 *  resolves to `ticks_per_slot = 3`, which is in range and not one of the five,
 *  so the body adds a sixth segment reading `167` (68-UI-SPEC state 6). */
const OFF_SCALE_TYPED = '167';
const OFF_SCALE_LABEL = '167';

/** The sixth segment's word when the run's belts DISAGREE (state 5). */
const MIXED_SEGMENT = 'Mixed';

/**
 * Boot the mocked app with the three-belt run on the board.
 *
 * `answerQuery` answers `machine_config` from a MUTABLE holder so a single boot
 * can open the belt panel and the Sink panel in turn - which is what makes the
 * width guard's "measured in the same run" clause true rather than claimed.
 */
async function bootRun(
  page: Page,
  ticks: readonly [number, number, number],
  opts: { readonly sink?: boolean } = {},
): Promise<{ h: Harness; setBeltTicks: (t: number) => void }> {
  let beltTicks = ticks[0];
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb, args) => {
      if (verb !== 'machine_config') return undefined;
      // Keyed on the handle: a belt gets a Belt config, the Sink gets a Sink one.
      // A single canned reply would answer `Belt` for the Sink and the Method
      // group - this guard's whole comparator - would never render.
      return args.node === SINK.id ? SINK_CONFIG : { kind: 'Belt', ticks_per_slot: beltTicks };
    },
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ belts: runBelts(ticks), nodes: opts.sink ? [SINK] : [] }));
  return {
    h,
    setBeltTicks: (t: number) => {
      beltTicks = t;
    },
  };
}

test.describe('the run count, read from BOTH ends of a three-belt run (V4)', () => {
  test('clicking the FIRST tile and the LAST tile each name THREE belts', async ({ page }) => {
    await bootRun(page, [4, 4, 4]);

    // THE COUNT IS THE ASSERTION, AND THE AGREEMENT IS A BONUS. A spec that only
    // checked the two readings MATCH cannot fail: a traversal broken to return a
    // run of one answers `This run is one belt.` on both clicks and passes green.
    // So both legs assert the EXACT plural string carrying the number three.
    for (const [where, tile] of [
      ['first', RUN_FIRST_TILE],
      ['last', RUN_LAST_TILE],
    ] as const) {
      await clickCell(page, tile);
      await expect(page.locator('#fab-belt-config')).toBeVisible({ timeout: 10_000 });
      await expect(
        page.locator('#fab-belt-run'),
        `the ${where} tile of a ${RUN_LENGTH}-belt run names the COUNT ` +
          `(a walk broken to one answers ${JSON.stringify(RUN_LINE_ONE)} on BOTH clicks)`,
      ).toHaveText(RUN_LINE_THREE);
      // Drop the selection so the next click is a genuinely fresh panel open
      // rather than a no-op on an already-selected run.
      await clickCell(page, EMPTY_CELL);
      await expect(page.locator('#fab-belt-config')).toHaveCount(0);
    }
  });
});

// ---------------------------------------------------------------------------
// APPLY ON THE THREE-BELT BOARD (68-REVIEW CR-01)
// ---------------------------------------------------------------------------
//
// The three-belt fixture already existed and was already used three times - for
// the run LINE, the group WIDTH and an axe scan - and none of those three ever
// pressed Apply. Every Apply-path assertion in the tree ran on a run of ONE, so
// narrowing `commitConfig`'s Belt branch from `deps.run.map(b => b.id)` to
// `[node]` left this file, vitest, tsc, the host suite and the live suite green.
// That narrowing is the shape a "simplify this" edit produces, and it turns
// BELT-02 (N belts, ONE frame, ONE undo) back into a per-belt edit.
//
// This is the board that can tell the two shapes apart, so this is where Apply
// is pressed. The MIDDLE belt is clicked deliberately: a narrowing to the
// clicked belt, to the first belt or to the last belt each produce a different
// wrong answer here, and the assertion names all three of them.

/** The middle belt's first tile - the click point for the Apply case below. */
const RUN_MIDDLE_TILE: [number, number] = [16, 7];

/** The three run handles in FLOW order (Tail-most first), which is the order
 *  `beltRun.ts` contracts to return and therefore the order the frame carries. */
const RUN_HANDLES = [RUN_A, RUN_B, RUN_C];

test.describe('Apply on a THREE-belt run lands ONE frame naming all three (CR-01)', () => {
  test('one Apply emits one 0xFE frame carrying every belt of the run, in flow order', async ({
    page,
  }) => {
    const { h } = await bootRun(page, [4, 4, 4]);

    await clickCell(page, RUN_MIDDLE_TILE);
    await expect(page.locator('#fab-belt-config')).toBeVisible({ timeout: 10_000 });
    // The board really is the three-belt one: a fixture that silently degraded to
    // a run of one would make every assertion below pass for the wrong reason.
    await expect(page.locator('#fab-belt-run')).toHaveText(RUN_LINE_THREE);

    const group = page.getByRole('group', { name: 'Belt pace' });
    await group
      .getByRole('button', { name: `${PRESSED_LABEL} px per second`, exact: true })
      .click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect.poll(() => h.sent.length).toBe(1);
    // Settle, for `selectBelt`'s reason: the poll resolves the instant the count
    // first reaches 1 and cannot see a LATE duplicate, which is exactly what an
    // N-frames-per-run implementation produces on a board of three.
    await page.waitForTimeout(200);
    expect(
      h.sent,
      `ONE Apply on a ${RUN_LENGTH}-belt run must emit ONE frame. ` +
        `N frames are N action ids on the host, so N Ctrl+Z steps for one Apply`,
    ).toHaveLength(1);

    const decoded = decodeRunPace(h.sent[0]);
    expect(
      decoded.belts,
      `the frame names EVERY belt of the run in flow order. ` +
        `[${RUN_B}] is a narrowing to the CLICKED belt, [${RUN_A}] to the first, ` +
        `[${RUN_C}] to the last - all three are green on a one-belt board`,
    ).toEqual(RUN_HANDLES);
    expect(decoded.ticksPerSlot, 'the frame carries the PRESSED pace').toBe(PRESSED_TICKS);
    expect(decoded.consumed, 'the frame carries no trailing bytes').toBe(h.sent[0].length);
  });
});

// ---------------------------------------------------------------------------
// THE WIDTH (V6), THE END-LABELS (V7) AND THE SCAN (V19)
// ---------------------------------------------------------------------------

/** One segmented group's layout, measured four ways. */
interface GroupLayout {
  /** The children's own widths plus the gaps: what ONE line would need. */
  demand: number;
  /** The group's own content box - the width every row is judged against. */
  box: number;
  /** How many segments the group rendered. */
  children: number;
  /** How many LINES those segments actually occupy. */
  lines: number;
  /** How far past the content box any child extends. Wrapping is not clipping. */
  clip: number;
}

/**
 * Measure a `role=group` segmented control.
 *
 * `scrollWidth` IS NOT THE DEMAND AND MUST NOT BE USED AS ONE. Both this group
 * and the Sink Method group set `flexWrap: 'wrap'`, so a line that cannot fit
 * WRAPS and its `scrollWidth` stays pinned to the box - a scroll-width overflow
 * comparison would then be measuring the box against itself and could not fail.
 * That is the first of the two traps `67-02-SUMMARY.md`'s recorded deviation 3
 * names, and it is avoided here by construction rather than by care.
 *
 * The second trap is the LINE COUNT. Neither element height nor a child count
 * survives centre alignment: a 44px button and a shorter sibling on the SAME line
 * have different tops. Lines are therefore derived from the number of DISTINCT
 * vertical CENTRES among the children's client rects, which is the only reading
 * that survives both wrapping and alignment.
 */
function layoutOf(page: Page, groupLabel: string): Promise<GroupLayout> {
  return page
    .locator(`[role="group"][aria-label="${groupLabel}"]`)
    .evaluate((el): GroupLayout => {
      const kids = Array.from(el.children) as HTMLElement[];
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const demand =
        kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) +
        gap * Math.max(0, kids.length - 1);
      // Lines, CLUSTERED rather than counted by equality. Measured in this very
      // run: two `.fab-tool-btn`s on the SAME line report tops of 266 and 267 -
      // sub-pixel layout - so `new Set(Math.round(centre))` reports three lines
      // for a two-line row and the guard becomes a measurement of rounding.
      // Clustering with a tolerance of half the shortest child separates the
      // ~1px within-line jitter from the ~48px row pitch by a factor of 20.
      const centres = kids
        .map((k) => {
          const r = k.getBoundingClientRect();
          return r.top + r.height / 2;
        })
        .sort((a, b) => a - b);
      const tolerance = Math.max(
        1,
        Math.min(...kids.map((k) => k.getBoundingClientRect().height)) / 2,
      );
      let lines = centres.length === 0 ? 0 : 1;
      for (let i = 1; i < centres.length; i++) {
        if (centres[i] - centres[i - 1] > tolerance) lines++;
      }
      const boxRight = el.getBoundingClientRect().left + el.clientWidth;
      const clip = kids.reduce(
        (worst, k) => Math.max(worst, k.getBoundingClientRect().right - boxRight),
        0,
      );
      return {
        demand: Math.round(demand),
        box: el.clientWidth,
        children: kids.length,
        lines,
        clip: Math.round(Math.max(0, clip)),
      };
    });
}

/** Load the panel font BEFORE any measurement.
 *
 *  NOT OPTIONAL AND NOT BELT-AND-BRACES. The bundled Martian Mono woff2 is
 *  `font-display: block`, so a reading taken during the block period measures the
 *  FALLBACK's advance (72px per 10 chars against the real 80px) and every figure
 *  below would be a green for the wrong reason. `toolbar-stability.spec.ts:307-310`
 *  is the shipped precedent and this is the same call. */
async function loadPanelFont(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.load('12px "Martian Mono"');
    await document.fonts.ready;
  });
}

test.describe('the pace group is MEASURED at the 992px minimum (V6/V7/V19)', () => {
  test('all three pace states render no more lines and no more clipping than the shipped Method group', async ({
    page,
  }) => {
    // The ledgered minimum, set BEFORE boot so the camera settles against it.
    await page.setViewportSize({ width: LEDGERED_MIN_WIDTH, height: 720 });
    const { h } = await bootRun(page, [4, 4, 4], { sink: true });
    await waitForBoard(page, { machines: 1 }, { timeout: 10_000 });
    await loadPanelFont(page);

    // ---- The COMPARATOR, measured first and in the SAME run ----------------
    // The shipped `SinkConfigBody` Method row: five segments, `flexWrap: wrap`,
    // the identical `.fab-tool-btn` class. It is the only right-hand side this
    // guard is allowed, because a literal pixel constant would be an assertion
    // about a font rendering rather than about this arm's layout.
    await clickCell(page, [SINK.cell_x, SINK.cell_y]);
    await expect(page.getByRole('group', { name: 'Method' })).toBeVisible({ timeout: 10_000 });
    const method = await layoutOf(page, 'Method');

    // Drop the selection, then open the belt panel. Both clicks happen with no
    // panel mounted, so neither is aimed at a cell the panel is covering.
    // Escape rather than an empty-cell press: a canvas press clears a BELT
    // selection but leaves a MACHINE panel mounted, so the belt panel would open
    // on top of a still-mounted Sink panel and `Belt pace` would resolve twice.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: 'Method' })).toHaveCount(0);

    // ---- State 2/3: the ordinary five-segment pace group -------------------
    await clickCell(page, RUN_FIRST_TILE);
    await expect(page.locator('#fab-belt-config')).toBeVisible({ timeout: 10_000 });
    const group = page.getByRole('group', { name: 'Belt pace' });
    await expect(group.getByRole('button')).toHaveCount(5);
    const ordinary = await layoutOf(page, 'Belt pace');

    // ---- The scale END-LABELS (V7), measured in the same run ---------------
    // RECORDED, NOT GATED. Either reading is acceptable: the derived slack is
    // 7px, `flexWrap: 'wrap'` makes a wrap the accepted degradation rather than
    // an overflow, and the figure is written into the summary because a later
    // copy change to either label crosses that margin immediately. The only
    // ASSERTION is that neither label CLIPS.
    const endLabels = await page
      .locator('#fab-belt-config span', { hasText: SCALE_FASTEST })
      .first()
      .evaluate((el) => {
        const row = el.parentElement as HTMLElement;
        const kids = Array.from(row.children) as HTMLElement[];
        // The same sub-pixel clustering the segment groups use, and for the same
        // measured reason - see `layoutOf`.
        const centres = kids
          .map((k) => {
            const r = k.getBoundingClientRect();
            return r.top + r.height / 2;
          })
          .sort((a, b) => a - b);
        const tolerance = Math.max(
          1,
          Math.min(...kids.map((k) => k.getBoundingClientRect().height)) / 2,
        );
        let lines = centres.length === 0 ? 0 : 1;
        for (let i = 1; i < centres.length; i++) {
          if (centres[i] - centres[i - 1] > tolerance) lines++;
        }
        const boxRight = row.getBoundingClientRect().left + row.clientWidth;
        return {
          lines,
          box: row.clientWidth,
          demand: Math.round(kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0)),
          clip: Math.round(
            Math.max(
              0,
              kids.reduce((w, k) => Math.max(w, k.getBoundingClientRect().right - boxRight), 0),
            ),
          ),
          texts: kids.map((k) => (k.textContent ?? '').trim()),
        };
      });
    expect(endLabels.texts, 'the row really holds the two scale end-labels').toEqual([
      SCALE_FASTEST,
      SCALE_SLOWEST,
    ]);
    expect(
      endLabels.clip,
      `the scale end-labels clip ${endLabels.clip}px past their ${endLabels.box}px box`,
    ).toBe(0);

    // ---- State 6: an off-scale figure adds a SIXTH segment -----------------
    await page.locator('#fab-belt-pace').fill(OFF_SCALE_TYPED);
    await expect(
      group.getByRole('button', { name: `${OFF_SCALE_LABEL} px per second`, exact: true }),
    ).toBeVisible();
    await expect(group.getByRole('button')).toHaveCount(6);
    const offScale = await layoutOf(page, 'Belt pace');

    // ---- State 5: a run whose belts DISAGREE adds the `Mixed` segment ------
    // Driven by a real packet, not by a prop: the Mixed detection reads the
    // RUN's paces off `BeltRunEntry`, which App re-derives on its ~10Hz poll.
    // A DIFF packet (`full: false`), and that is load-bearing rather than tidy: a
    // FULL keyframe clears the selection UNCONDITIONALLY (`App.tsx:1895-1896`,
    // WR-01 - a keyframe remints handles, so a stale selection could silently
    // retarget a later Delete at the wrong node). Re-injecting a keyframe here
    // would unmount the panel mid-measurement and the Mixed reading could never
    // be taken. Only belt B is re-emitted: the upsert replaces that one
    // `BeltView`, and the gesture layer REFRESHES rather than drops the
    // selection on a diff carrying it.
    h.inject(buildPacket({ tick: 2, full: false, belts: [runBelts([4, 10, 4])[1]] }));
    await expect(
      group.getByRole('button', { name: MIXED_SEGMENT, exact: true }),
      'the run went Mixed once one belt reported a different pace',
    ).toBeVisible({ timeout: 10_000 });
    await expect(group.getByRole('button')).toHaveCount(6);
    const mixed = await layoutOf(page, 'Belt pace');

    // ---- VACUITY REFUSAL --------------------------------------------------
    // Four measurements are worthless if they are secretly the same measurement.
    expect(method.children, 'the Method comparator carries its five verbs').toBe(5);
    expect(ordinary.children, 'the ordinary pace group carries five segments').toBe(5);
    expect(offScale.children, 'the off-scale state carries six').toBe(6);
    expect(mixed.children, 'the Mixed state carries six').toBe(6);
    for (const [name, m] of [
      ['ordinary', ordinary],
      ['off-scale', offScale],
      ['Mixed', mixed],
    ] as const) {
      expect(m.box, `${name} must be measured in the same box as the comparator`).toBe(method.box);
      expect(m.demand, `${name} must have a real intrinsic demand`).toBeGreaterThan(0);
    }

    // ---- THE GUARD --------------------------------------------------------
    // RELATIVE, and there is no literal pixel constant on either right-hand
    // side: both figures come from the shipped Method group measured in THIS
    // run. Proved to redden by temporarily widening a pace segment's label until
    // the pace group takes a line the Method group does not - see the plan
    // 68-06 summary's mutation-proof section for the verbatim red.
    for (const [name, m] of [
      ['ordinary', ordinary],
      ['off-scale', offScale],
      ['Mixed', mixed],
    ] as const) {
      expect(
        m.lines,
        `the ${name} pace group takes ${m.lines} lines against the shipped Method group's ` +
          `${method.lines} (demand ${m.demand}px vs ${method.demand}px, box ${m.box}px)`,
      ).toBeLessThanOrEqual(method.lines);
      expect(
        m.clip,
        `the ${name} pace group clips ${m.clip}px past its box against the Method group's ` +
          `${method.clip}px`,
      ).toBeLessThanOrEqual(method.clip);
    }

    // The readings, surfaced so the summary records MEASUREMENTS rather than an
    // assertion of fit. Every figure in 68-UI-SPEC 4.4 is derived arithmetic
    // until this line prints.
    console.log(
      `[68-06 width @${LEDGERED_MIN_WIDTH}px] box=${method.box}px | ` +
        `method demand=${method.demand}px lines=${method.lines} clip=${method.clip}px | ` +
        `ordinary demand=${ordinary.demand}px lines=${ordinary.lines} clip=${ordinary.clip}px | ` +
        `offScale demand=${offScale.demand}px lines=${offScale.lines} clip=${offScale.clip}px | ` +
        `mixed demand=${mixed.demand}px lines=${mixed.lines} clip=${mixed.clip}px | ` +
        `endLabels demand=${endLabels.demand}px lines=${endLabels.lines} ` +
        `clip=${endLabels.clip}px box=${endLabels.box}px`,
    );
  });
});

test.describe('the belt arm passes a scoped axe scan, with contrast really measured (V19)', () => {
  test('a narrow scan over the belt arm reports zero violations and abstains explicitly', async ({
    page,
  }) => {
    await bootRun(page, [4, 4, 4]);
    await clickCell(page, RUN_FIRST_TILE);
    await expect(page.locator('#fab-belt-config')).toBeVisible({ timeout: 10_000 });

    const results = await new AxeBuilder({ page }).include('#fab-belt-config').analyze();
    expect(results.violations).toEqual([]);

    // THE ANTI-VACUITY HALF, and it is the whole reason this leg runs in Chromium
    // rather than in the node-env unit suite: `color-contrast` reports INCOMPLETE
    // in a simulated DOM (the `64-UI-SPEC.md` finding), and a rule that reports
    // incomplete is a green that measured nothing.
    const contrast = results.passes.find((r) => r.id === 'color-contrast');
    expect(contrast, 'color-contrast produced real verdicts over the belt arm').toBeDefined();
    const measured = new Map(
      (contrast?.nodes ?? []).map((n) => [
        String(n.target[0]),
        (n.any[0]?.data ?? {}) as { contrastRatio?: number },
      ]),
    );
    expect(measured.size, 'the scan judged real nodes, not none').toBeGreaterThan(0);

    // The two figures 68-UI-SPEC section 10 states, now BROWSER READINGS rather
    // than a design claim: every string in the arm on the panel fill, and the
    // typed field on the deeper field fill.
    expect(
      measured.get('#fab-belt-note')?.contrastRatio,
      'the standing note is measured on the panel fill (68-UI-SPEC section 10: 5.157:1)',
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      measured.get('#fab-belt-pace')?.contrastRatio,
      'the typed field is measured on the field fill (68-UI-SPEC section 10: 8.438:1)',
    ).toBeGreaterThanOrEqual(4.5);

    // ABSTENTIONS ARE PINNED, NEVER BLANKET-ALLOWED. A blanket allowance
    // (`expect(incomplete).toEqual(anything)` or simply not looking) is an
    // assertion that measures nothing and would silently absorb a future element
    // that goes unjudged for a completely different cause. The phase-65
    // discipline (`router-panel.spec.ts:695-728`) is to pin the node set AND
    // axe's own reason for each, so a new abstention has to come back here.
    //
    // THE ONE ABSTENTION, AND WHY IT IS SAFE TO ABSTAIN ON IT. axe declines to
    // judge `#fab-belt-run` with `messageKey: 'elmPartiallyObscuring'` - it could
    // not resolve a background because the paragraph's box partially overlaps a
    // sibling's. Nothing actually covers it (measured in this session:
    // `document.elementsFromPoint` at its top-left, centre and bottom-right all
    // return the `<p>` itself as the topmost element), and it rides the IDENTICAL
    // `NOTE_STYLE` ink-on-fill pair as `#fab-belt-note`, which the pass list
    // directly above DID measure at 5.15:1. So the colour pair is measured; only
    // this one node's background resolution is declined.
    expect(
      results.incomplete.map((r) => ({
        id: r.id,
        targets: r.nodes.map((n) => String(n.target[0])),
        reasons: r.nodes.map((n) => (n.any[0]?.data as { messageKey?: string })?.messageKey),
      })),
      'the belt arm has no abstention left (phase 91, plan 91-09)',
    ).toEqual([]);
    // PHASE 91, PLAN 91-09 (CHROME-07): THE ONE ABSTENTION ABOVE IS GONE, and the node it
    // covered is now measured. The inspector docks below the toolbar and is as tall as its
    // content, so the scroll column no longer stretches to the window's height, and axe now
    // resolves `#fab-belt-run`'s background (it read `elmPartiallyObscuring` while the column
    // was stretched). The pin moves from one named abstention to none, and the run line's own
    // contrast reading is asserted so the move cannot hide an unjudged node.
    expect(
      measured.get('#fab-belt-run')?.contrastRatio,
      'the run line is measured on the panel fill now, as the note is',
    ).toBeGreaterThanOrEqual(4.5);
  });
});

// Phase 89 UI review UI-06 (walk capture 131-small-belt-selected.png): in a short window the
// panel column scrolls, and the Apply / Revert row was cut mid-button at the fold, which read as
// a rendering fault. The row is sticky at the column's bottom now. Graded on geometry: both
// buttons sit whole inside the column's visible box, at a height where the column scrolls.
test.describe('the Apply row stays whole when the panel scrolls (89 review UI-06)', () => {
  for (const height of [640, 560]) {
    test(`at 1024 x ${height} the Apply and Revert buttons sit whole inside the panel's visible column`, async ({ page }) => {
      await page.setViewportSize({ width: 1024, height });
      await selectBelt(page);
      const col = page.locator('#fab-belt-config').locator('xpath=ancestor::*[@data-fab-panel-scroll]');
      const fit = await col.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const box = (name: string) => {
          const b = [...el.querySelectorAll('button')].find((x) => x.textContent?.trim() === name);
          if (!b) return null;
          const q = b.getBoundingClientRect();
          return { top: q.top, bottom: q.bottom };
        };
        return { scrolls: el.scrollHeight > el.clientHeight + 1, top: r.top, bottom: r.bottom, apply: box('Apply'), revert: box('Revert') };
      });
      const line = JSON.stringify(fit);
      expect(fit.apply, `the Apply button is in the panel (${line})`).not.toBeNull();
      expect(fit.revert, `the Revert button is in the panel (${line})`).not.toBeNull();
      if (height === 560) expect(fit.scrolls, `NON-VACUITY: the column scrolls at 1024 x ${height} (${line})`).toBe(true);
      for (const b of [fit.apply!, fit.revert!]) {
        expect(b.top, `the button's top is inside the column (${line})`).toBeGreaterThanOrEqual(fit.top - 0.5);
        expect(b.bottom, `the button's bottom is inside the column, not cut at the fold (${line})`).toBeLessThanOrEqual(fit.bottom + 0.5);
      }
    });
  }
});
