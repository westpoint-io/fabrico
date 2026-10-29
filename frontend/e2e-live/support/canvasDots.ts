// canvasDots.ts - the PURE reader of item dots and the junction collar off DECODED SCREEN PIXELS
// (the 77-02 refuter round, phase 77 D-04), since extended to the gauge, the label, and the cable
// with its prongs (the 77-05 refuter round, at the end of this file). Plain data in, plain data
// out. It imports NOTHING, so it carries no product source and no Playwright, and
// `src/gates/canvasDots.test.ts` grades every
// rule here on pixels a live run of the composed walk captured.
//
// WHY IT EXISTS. Plan 77-02's item read (`oracle.ts` `itemDotsPerCell`) counted the x and y that
// the item layer's `draw` stored on each Particle. That is renderer object state, not the canvas:
// an item layer set invisible, scaled to zero or drawn at alpha 0 still places every particle,
// and leg 2's `PACK DRAWN ON THE CANVAS` stayed green on all three (refuters 1 and 4). The junction
// collar was graded by its Graphics instruction count, so a collar drawn 9999 px away passed too
// (refuter 2). These readers take a SCREENSHOT the caller decoded and say what is visible.
//
// ===========================================================================
// WHAT A DOT IS, IN PIXELS
// ===========================================================================
//
// The item dot is the skin's item accent, `0xffb454` (`shared/geometry.ts` `colorOracles.itemHalo`):
// red minus blue is 171. The whole board ramp is cool grey with blue at or above red
// (`rampOracles.locked`), so a pixel whose red exceeds its blue by more than `DOT_INK_RB_MIN` is dot
// ink and nothing else on a belt cell (the 06 probe's "warm pixels are dot ink" rule, with a
// margin). At camera scale 1 and device pixel ratio 1 a whole dot is 16 such pixels (a 4.8 px
// disc), measured on the live run.
//
// A belt tile holds four item slots, and a slot's dot sits at `(m + 0.5) / 4` of the tile's flow
// (`frontend/src/render/interp.ts` `slotArcLength`; item interpolation is off by default), so a
// tile split into four equal WINDOWS along its flow holds at most one dot per window and no dot
// straddles two. A window is LIT when it holds at least `DOT_INK_MIN` ink pixels per device pixel
// squared. The count of lit windows is the number of dots VISIBLE on that tile. The minimum is a
// floor, not a fraction of a dot, because the first slot of a belt docked to a machine is partly
// covered by that machine's port nub: on the live run the Source's nub left 6 ink pixels of that
// dot visible. An empty window measured 0 ink pixels on every run tile.
//
// ===========================================================================
// WHAT A COLLAR IS, IN PIXELS
// ===========================================================================
//
// The collar is a ring stroked in `ramp[4]` (`0xb0bacb`) of radius 7 world px, width 2, centred on
// the seam between two belt tiles, over a `ramp[0]` disc (`belts.ts` `rebuildEnds`). The belt's
// own ink is the same `ramp[4]`: two rails 9.5 px either side of the flow line and the marching
// dash on it. So the collar is read on an ANNULUS around the seam (radius `COLLAR_INNER` to
// `COLLAR_OUTER`), with a band of half-width `COLLAR_FLOW_BAND` along the flow line taken out: the
// rails lie outside the outer radius and the dash inside the band, so on a seam with no collar the
// annulus holds no `ramp[4]` pixel, measured. The ring is graded per QUADRANT, so a collar drawn
// anywhere but on this seam leaves every quadrant empty, and half a collar leaves two.

/** A decoded RGBA image, as `PNG.sync.read` returns it: row-major, four bytes per pixel. */
export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A rectangle in IMAGE pixels, `[x0, x1)` by `[y0, y1)`. */
export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One belt tile to read: its key (`x,y`), its rectangle in image px, and the axis it flows on. */
export interface TileInImage {
  key: string;
  rect: PixelRect;
  axis: 'x' | 'y';
}

/** Red above blue by more than this is dot ink (the dot accent reads 171; the ramp reads 0 or less). */
export const DOT_INK_RB_MIN = 40;
/** A window is lit at this many ink pixels per device pixel squared (a whole dot is 16). */
export const DOT_INK_MIN = 3;
/** Four item slots per belt tile (`fabrico_core` `SLOTS_PER_TILE`). */
export const SLOTS_PER_TILE = 4;

/** True when the pixel at byte offset `i` is dot ink. */
export function isDotInk(data: Uint8Array, i: number): boolean {
  return data[i] - data[i + 2] > DOT_INK_RB_MIN;
}

/** The ink pixel count of each of a tile's four windows, in flow-axis order. */
export function windowInk(img: DecodedImage, tile: TileInImage): number[] {
  const { x0, y0, x1, y1 } = tile.rect;
  const out = new Array<number>(SLOTS_PER_TILE).fill(0);
  const span = tile.axis === 'x' ? x1 - x0 : y1 - y0;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      if (!isDotInk(img.data, (y * img.width + x) << 2)) continue;
      const along = tile.axis === 'x' ? x - x0 : y - y0;
      out[Math.min(SLOTS_PER_TILE - 1, Math.floor((along * SLOTS_PER_TILE) / span))]++;
    }
  }
  return out;
}

/** One tile's reading: its visible dots (lit windows) and the ink behind each window. */
export interface TileDots {
  dots: number;
  ink: number[];
}

/**
 * The dots VISIBLE on each tile: the lit windows, keyed by the tile's key. `dpr` is the image's
 * device pixels per CSS pixel (the decoded width over the clip width), so the floor scales with
 * the area a dot covers.
 */
export function visibleDotsPerTile(
  img: DecodedImage,
  tiles: readonly TileInImage[],
  dpr: number,
): Record<string, TileDots> {
  const min = DOT_INK_MIN * dpr * dpr;
  const out: Record<string, TileDots> = {};
  for (const t of tiles) {
    const ink = windowInk(img, t);
    out[t.key] = { dots: ink.filter((n) => n >= min).length, ink };
  }
  return out;
}

/** The verdict on a pack's growth, read off a series of canvas samples. */
export interface GrowthGrade {
  /** How many samples were read. */
  samples: number;
  /** The packed depth of each sample (full tiles counted from the head back, stopping at the first
   *  that is not), with consecutive repeats collapsed. */
  stages: number[];
  /** The first sample whose packed depth is below an earlier one. */
  shrank: { sample: number; from: number; to: number } | null;
}

/** How many of `headFirst` show all four dots, counted from the head and stopping at the first that does not. */
export function packedDepth(sample: Readonly<Record<string, number>>, headFirst: readonly string[]): number {
  let n = 0;
  while (n < headFirst.length && (sample[headFirst[n]] ?? 0) >= SLOTS_PER_TILE) n++;
  return n;
}

/**
 * Grade a pack's growth as the canvas showed it. Each sample is the visible dots per tile; its
 * PACKED DEPTH is the run of full tiles from the head back. Items in transit can bunch four to a
 * tile behind a gap (measured: the downstream belt held slots 4 to 7 with slot 3 empty), so a full
 * tile alone is not packed; a full tile with every tile ahead of it full is, because the head end is
 * free and an item that reaches it is held, and so is every item packed behind it. A pack that
 * grows tile by tile back from the head shows a depth that never falls and passes through every
 * value from 0 to the run's length. A pack drawn filling from the other end of a belt jumps (each
 * belt's head tile shows full only when the whole belt is), and a pack never drawn never leaves 0.
 */
export function gradeGrowth(
  samples: readonly Readonly<Record<string, number>>[],
  headFirst: readonly string[],
): GrowthGrade {
  const stages: number[] = [];
  let shrank: GrowthGrade['shrank'] = null;
  let most = 0;
  samples.forEach((s, i) => {
    const n = packedDepth(s, headFirst);
    if (shrank === null && n < most) shrank = { sample: i, from: most, to: n };
    most = Math.max(most, n);
    if (stages[stages.length - 1] !== n) stages.push(n);
  });
  return { samples: samples.length, stages, shrank };
}

/** One growth capture's place on the model clock: the tick read on the animation frame before its
 *  capture was requested, and the tick read on the first animation frame whose read was issued after
 *  the capture's reply had arrived (plan 84-15). */
export interface StageSample {
  requestTick: number;
  replyTick: number;
}

/**
 * THE SAMPLING'S OWN VERDICT (plans 84-11 and 84-15). The 2026-10-09 CI run failed leg 2's growth on a
 * two-CPU runner with the stages 0,2,3,5,6 over 9 screenshots: each sample took about 3 s there,
 * longer than a tile's stage lasts, so the series skipped stages the canvas did draw. `gradeGrowth`
 * alone cannot tell that from a pack drawn jumping. So each sample carries its place on the MODEL
 * clock, and `boundaries[k]` is the first model tick at which the packed depth reached `k + 1`
 * tiles (null when it never did), or since plan 84-17 the bracket that tick lies in
 * (`boundaryBrackets`). Stage `s` lasts on the model from boundary `s` (minus infinity for
 * stage 0) up to, NOT including, boundary `s + 1` (plus infinity for the last): the half-open window
 * `[boundary s, boundary s + 1)`.
 *
 * WHY A REQUEST ALONE IS NOT ENOUGH (plan 84-14's R4 proxy red). Plan 84-11 resolved a stage by a
 * capture REQUESTED inside it, on its measurement at a CPU throttle that a capture shows the model
 * at its request. At the GPU proxy (the GPU process stopped 150 of every 160 ms) a capture came back
 * 3.8 to 5.3 s after its request, and the frame it returned could be drawn after the stage it was
 * requested in had ended: at R4 stage 4 (model ticks 3361 to 3400) had captures requested
 * inside it, `unresolved=` read empty, none showed four tiles, and the leg went red on the drawing's
 * token though nothing was drawn wrong. So a stage now counts as seen only by a sample whose request
 * tick AND reply tick both lie in its window: the frame was drawn somewhere between the two, and
 * both inside the stage puts it inside the stage. The reply tick is read after the reply arrived,
 * so the pair can only be wider than the window the capture was taken in, never narrower; a reply
 * on the next boundary tick is outside (the window is half open).
 *
 * Returns the stages no sample resolved, in order; empty when every stage had a capture requested
 * and answered while the model was in it. A never-reached boundary empties every stage after it, so
 * those count as unresolved too (the model's own grade reddens first). A sample whose reply tick is
 * below its request tick is not a reading of the clock at all, and throws by name.
 */
export function unresolvedStages(
  samples: readonly StageSample[],
  boundaries: readonly (number | BoundaryBracket | null)[],
): number[] {
  return resolvingSamples(samples, boundaries).flatMap((by, s) => (by.length === 0 ? [s] : []));
}

/**
 * WHERE A PACK BOUNDARY WAS REACHED, AS FAR AS THE READINGS CAN SAY (plan 84-17). The boundary was
 * first reached at some model tick in the half-open range `(lo, hi]`: `hi` is the first reading
 * at or above the boundary, `lo` the reading just before it (minus infinity when there is none).
 */
export interface BoundaryBracket {
  lo: number;
  hi: number;
}

/** One reading of the model's packed run: `packed` slots packed from the head, read at tick `t`. */
export interface RunReading {
  t: number;
  packed: number;
}

/**
 * THE STAGE BRACKETS (plan 84-17). Plans 84-15 and 84-16 placed each growth capture by the FIRST
 * RECORDED tick of each boundary, from the in-page tick recorder. At the GPU proxy the synchronous
 * canvas read starves that recorder (84-16's `STALL_FINDING`: about three ticks in four missed), so a
 * boundary's first recorded tick lands up to 37 ticks after the tick it was reached (84-16's
 * `boundaryGaps` of 23 to 37 at the proxy), and a capture taken between the two was credited to the
 * stage before: 84-16's series run 3 read `depthsSeen=0|1,2|2|3|4|5|6` and run 5
 * `depthsSeen=0|1|2|3,4|4|5|6`, a stage credited with a capture that showed the next stage's depth.
 *
 * So each boundary is BRACKETED: between the last reading below it and the first at or above it. A
 * tick strictly inside a bracket could be on either side of the boundary, so a capture stamped there
 * counts for no stage (`resolvingSamples`). Each capture brings its OWN reading: it reads the same
 * `window.__fabrico.scene()` in the animation-frame callback whose tick it is stamped with, so it is a
 * reading at exactly that tick, and merged into the readings it can never lie strictly inside the
 * bracket it helps form (it is either the bracket's `hi`, or at or below its `lo`).
 *
 * `readings` in any order (a sorted copy is used). Two readings of one tick that disagree throw by
 * name; for each boundary `k` the result is null when no reading reaches `k`.
 */
export function boundaryBrackets(
  readings: readonly RunReading[],
  boundaries: readonly number[],
): (BoundaryBracket | null)[] {
  const sorted = [...readings].sort((a, b) => a.t - b.t);
  const byTick: RunReading[] = [];
  for (const r of sorted) {
    const prev = byTick[byTick.length - 1];
    if (prev !== undefined && prev.t === r.t) {
      if (prev.packed !== r.packed) {
        throw new Error(
          `boundaryBrackets: two readings of tick ${r.t} disagree (${prev.packed} and ${r.packed} slots packed)`,
        );
      }
      continue;
    }
    byTick.push(r);
  }
  return boundaries.map((k) => {
    const j = byTick.findIndex((r) => r.packed >= k);
    if (j < 0) return null;
    return { lo: j > 0 ? byTick[j - 1].t : Number.NEGATIVE_INFINITY, hi: byTick[j].t };
  });
}

/**
 * The pack order graded from the boundary brackets (plan 84-18, push 6; decision D-12,
 * "Grade from brackets"). Each boundary was reached at a tick inside its bracket `(lo, hi]`
 * (`boundaryBrackets`). The pack is in order when each boundary can have been reached on a tick
 * LATER than the one before it: boundary `i` violates the order only when every tick its bracket
 * allows is at or before the earliest tick boundary `i - 1`'s allows, `hi_i <= lo_(i-1) + 1`, which
 * on readings one tick apart is two boundaries crossed in one tick. A run the recorder read only
 * every 63 ticks (run 5) is not out of order for that; a run that really packs out of order, read
 * tick by tick, still is. One sentence per violation; a boundary never reached is one too.
 */
export function packOrderViolations(readings: readonly RunReading[], boundaries: readonly number[]): string[] {
  const brackets = boundaryBrackets(readings, boundaries);
  const out: string[] = [];
  brackets.forEach((b, i) => {
    if (b === null) {
      out.push(`boundary ${boundaries[i]} never reached`);
      return;
    }
    const prev = i > 0 ? brackets[i - 1] : null;
    if (prev !== null && prev !== undefined && b.hi <= prev.lo + 1) {
      out.push(
        `boundary ${boundaries[i]} was reached in the same tick as boundary ${boundaries[i - 1]} or before it: its bracket (${prev.lo}, ${b.hi}] leaves no later tick (boundary ${boundaries[i - 1]}'s is (${prev.lo}, ${prev.hi}])`,
      );
    }
  });
  return out;
}

/**
 * For each stage, 0 to `boundaries.length`, the indices into `samples` of the samples that resolve
 * it: request tick and reply tick both in the stage's CERTAIN window (plan 84-17), on the null rule
 * `unresolvedStages` documents (it is this, reduced to the empty stages). Throws by name on a sample
 * whose reply tick is below its request tick.
 *
 * A boundary is a `BoundaryBracket` `(lo, hi]` or a plain tick `b`, which is the bracket
 * `{ lo: b - 1, hi: b }` (84-15's half-open window on integer ticks, unchanged). Stage `s`'s certain
 * window runs from boundary `s`'s `hi` (minus infinity for stage 0; empty after a null boundary) to
 * boundary `s + 1`'s `lo` (plus infinity for the last stage or a null boundary), both inclusive, so a
 * tick strictly inside a bracket lies in no stage's window.
 */
export function resolvingSamples(
  samples: readonly StageSample[],
  boundaries: readonly (number | BoundaryBracket | null)[],
): number[][] {
  for (const { requestTick, replyTick } of samples) {
    if (replyTick < requestTick) {
      throw new Error(
        `unresolvedStages: a capture answered at tick ${replyTick}, before it was requested at tick ${requestTick}`,
      );
    }
  }
  const brackets = boundaries.map((b) => (typeof b === 'number' ? { lo: b - 1, hi: b } : b));
  const out: number[][] = [];
  for (let s = 0; s <= brackets.length; s++) {
    const start = s === 0 ? null : brackets[s - 1];
    const end = s < brackets.length ? brackets[s] : null;
    const from = s === 0 ? Number.NEGATIVE_INFINITY : start === null ? Number.POSITIVE_INFINITY : start.hi;
    const to = end === null ? Number.POSITIVE_INFINITY : end.lo;
    const inside = (t: number): boolean => t >= from && t <= to;
    const by: number[] = [];
    samples.forEach((x, i) => {
      if (inside(x.requestTick) && inside(x.replyTick)) by.push(i);
    });
    out.push(by);
  }
  return out;
}

/** The `ramp[4]` ink the collar ring and the belt rails are stroked in (`rampOracles.locked[4]`). */
export const COLLAR_RING_RGB = { r: 0xb0, g: 0xba, b: 0xcb } as const;
/** A ring pixel is within this many levels of `COLLAR_RING_RGB` on every channel (74.1's ring-ink tolerance). */
export const COLLAR_INK_TOLERANCE = 48;
/** The annulus the ring is read on, in CSS px from the seam: the ring's radius 7, stroke 2, a pixel of slack. */
export const COLLAR_INNER = 4.5;
export const COLLAR_OUTER = 8.5;
/** The band along the flow line left out of the annulus, half-width in CSS px: the marching dash lives in it. */
export const COLLAR_FLOW_BAND = 2.5;

/** The collar ink per quadrant of the annulus: top-left, top-right, bottom-left, bottom-right. */
export interface CollarInk {
  total: number;
  quads: [number, number, number, number];
}

/**
 * The `ramp[4]` pixels on the collar annulus around the seam at (`cx`, `cy`), image px, per
 * quadrant. `axis` is the flow axis of the two tiles the seam joins, `dpr` the image's device
 * pixels per CSS pixel. Distances are measured from each pixel's centre.
 */
export function collarInk(
  img: DecodedImage,
  cx: number,
  cy: number,
  axis: 'x' | 'y',
  dpr: number,
): CollarInk {
  const quads: [number, number, number, number] = [0, 0, 0, 0];
  const inner = COLLAR_INNER * dpr;
  const outer = COLLAR_OUTER * dpr;
  const band = COLLAR_FLOW_BAND * dpr;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d < inner || d > outer) continue;
      if (Math.abs(axis === 'x' ? dy : dx) < band) continue;
      const i = (y * img.width + x) << 2;
      if (
        Math.abs(img.data[i] - COLLAR_RING_RGB.r) > COLLAR_INK_TOLERANCE ||
        Math.abs(img.data[i + 1] - COLLAR_RING_RGB.g) > COLLAR_INK_TOLERANCE ||
        Math.abs(img.data[i + 2] - COLLAR_RING_RGB.b) > COLLAR_INK_TOLERANCE
      ) {
        continue;
      }
      quads[(dy < 0 ? 0 : 2) + (dx < 0 ? 0 : 1)]++;
    }
  }
  return { total: quads[0] + quads[1] + quads[2] + quads[3], quads };
}

// ===========================================================================
// WHAT A LOAD GAUGE IS, IN PIXELS (the 77-03 refuter round, refuter 1)
// ===========================================================================
//
// Leg 3 graded the Tee's backed-up mark off the gauge Graphics: its instruction count and drawn
// width (`loadGaugeFormOn`). A gauge set invisible still holds both, and leg 3 stayed green with
// no gauge on screen (refuter 1). So the gauge is also read here, off a screenshot.
//
// `drawLoadGauge` (`frontend/src/render/layers/machineState.ts`) plots, in `ramp[4]` on the board,
// a band `GAUGE_THICK_U` thick whose near side is `GAUGE_OUTSET_U` above the machine box's top
// edge, centred on the box: at levels 1 to 3 that many `GAUGE_TICK_U` ticks `GAUGE_GAP_U` apart,
// at level 4 ONE `GAUGE_RUN_U` bar (the merged bar, the backed-up mark). At camera scale 1 a `u`
// is a CSS px (`U_TO_PX` is 1 at the shipped cell). The constants are copied here as data, never
// imported, and `src/gates/canvasDots.test.ts` pins them against the product's.
//
// A COLUMN of the band is inked when it holds at least `GAUGE_INK_MIN` `ramp[4]` pixels per device
// pixel; the gauge's visible FORM is its runs of inked columns. MEASURED on the live run that
// captured `src/gates/fixtures/77-gauge-jam-merged.png` (the Tee at (11,12), camera scale 1, device
// pixel ratio 1): the merged bar is one run of 25 px over 3 rows, with no other `ramp[4]` pixel in
// the clip; after the release the band is empty. A tick is 4 px. A run of 20 to 25 px is the
// merged bar, so a bar missing a few edge columns to blending still reads merged.

/** `machineState.ts` `GAUGE_OUTSET_U`, `GAUGE_THICK_U`, `GAUGE_TICK_U`, `GAUGE_GAP_U`, `GAUGE_RUN_U`. */
export const GAUGE_OUTSET_PX = 9;
export const GAUGE_THICK_PX = 3;
export const GAUGE_TICK_PX = 4;
export const GAUGE_GAP_PX = 3;
export const GAUGE_RUN_PX = 25;
/** The gauge's ink, `ramp[4]`, the same as the collar's. */
export const GAUGE_INK_RGB = COLLAR_RING_RGB;
export const GAUGE_INK_TOLERANCE = COLLAR_INK_TOLERANCE;
/** A column is inked at this many ink pixels per device pixel (the band is 3 px thick). */
export const GAUGE_INK_MIN = 2;
/** A run at least this wide, in CSS px, is the merged bar; a tick reads at most `GAUGE_TICK_PX`. */
export const GAUGE_MERGED_MIN_PX = 20;

/** The gauge's visible form. `level` is the tick count at 1 to 3, 4 for the merged bar, 0 for none,
 *  and null for a form `drawLoadGauge` never draws (a run of the wrong width, more than 3 ticks). */
export interface GaugeOnCanvas {
  /** Each run of inked columns, its width in CSS px, left to right. */
  runs: number[];
  /** The ink pixels counted in the band. */
  ink: number;
  merged: boolean;
  level: number | null;
}

/** True when the pixel at byte offset `i` is gauge ink. */
function isGaugeInk(data: Uint8Array, i: number): boolean {
  return (
    Math.abs(data[i] - GAUGE_INK_RGB.r) <= GAUGE_INK_TOLERANCE &&
    Math.abs(data[i + 1] - GAUGE_INK_RGB.g) <= GAUGE_INK_TOLERANCE &&
    Math.abs(data[i + 2] - GAUGE_INK_RGB.b) <= GAUGE_INK_TOLERANCE
  );
}

/**
 * The gauge read in `band` (image px: every column of the clip, the rows the band can occupy),
 * `dpr` the image's device pixels per CSS pixel.
 */
export function gaugeOnCanvas(img: DecodedImage, band: PixelRect, dpr: number): GaugeOnCanvas {
  const min = GAUGE_INK_MIN * dpr;
  const inked: boolean[] = [];
  let ink = 0;
  for (let x = Math.max(0, band.x0); x < Math.min(img.width, band.x1); x++) {
    let n = 0;
    for (let y = Math.max(0, band.y0); y < Math.min(img.height, band.y1); y++) {
      if (isGaugeInk(img.data, (y * img.width + x) << 2)) n++;
    }
    ink += n;
    inked.push(n >= min);
  }
  const runs: number[] = [];
  let width = 0;
  for (const on of [...inked, false]) {
    if (on) {
      width++;
    } else if (width > 0) {
      runs.push(width / dpr);
      width = 0;
    }
  }
  const merged = runs.length === 1 && runs[0] >= GAUGE_MERGED_MIN_PX && runs[0] <= GAUGE_RUN_PX;
  const ticks = runs.length >= 1 && runs.length <= 3 && runs.every((w) => w >= 2 && w <= GAUGE_TICK_PX);
  return { runs, ink, merged, level: runs.length === 0 ? 0 : merged ? 4 : ticks ? runs.length : null };
}

// ===========================================================================
// WHAT A LABEL IS, IN PIXELS (the 77-04 refuter round, refuters 2 and 3)
// ===========================================================================
//
// Leg 4 graded the label's box off the `label-box` Graphics' instructions (`labelBoxOn`) and its
// words off the DOM (`labelWordsOf`: `textContent` and Playwright's `isVisible`). A box Graphics set
// invisible still holds its instructions, and a words overlay at opacity 0 still has its text and
// counts as visible, so `LABEL DRAWN` and `LABEL BACK EXACTLY` stayed green with no box on screen
// (refuter 2) and with no words on screen (refuter 3). So the label is also read here, off a
// screenshot of exactly its cells, with the words overlay composited over the canvas as the user
// sees it.
//
// `drawLabelBox` (`frontend/src/render/layers/machines.ts`) fills the cell rect inset by
// `CHASSIS_INSET_U` (4 px at scale 1) with the label colour at `LABEL_FILL_ALPHA` (0.16) and strokes
// it in that colour at alpha 1, 2 px wide at scale 1. `LabelWords.tsx` sets the words inside that
// box in `--fab-ink` (`ramp[4]`, `0xb0bacb`). MEASURED on the live run that captured
// `src/gates/fixtures/77-label-drawn.png` (the Lilac 6 by 2 label at (5,13) reading `Order intake`,
// camera scale 1, device pixel ratio 1, a 192 by 64 px clip): the stroke is exact Lilac, 2 px on
// each side, 352 pixels in the top and bottom bands and 96 in the left and right; the fill reads
// `53,52,70` over the board's `27,31,39`, which is alpha 0.159 of Lilac; the words are 178 pixels
// within `LABEL_WORDS_TOLERANCE` of `ramp[4]`. The box hidden leaves no Lilac pixel and an untinted
// interior; the words at opacity 0 leave 0 word pixels.
//
// The clip is split into a BAND of `LABEL_BAND_PX` along each edge, where the stroke lies, and the
// INTERIOR inside the bands, where the fill and the words lie. A side is drawn when its band holds
// at least half the stroke pixels a whole 2 px stroke along its length inks. The fill is read as an
// alpha: the interior's commonest colour against each of the `LABEL_BOARD_CANDIDATES` commonest
// colours of the clip's outer `LABEL_MARGIN_PX` ring (the board under the label, outside its inset
// box; a grid line, and on a selected label the selection ring, share that ring with the ground),
// projected on the line from that colour to the label colour, the one kept whose projection leaves
// the smallest residual.

/** The band along each edge of the clip that holds the stroke, CSS px (the inset 4 px, the stroke 2, slack). */
export const LABEL_BAND_PX = 8;
/** The outer ring of the clip read as the board under the label, CSS px (outside the inset box). */
export const LABEL_MARGIN_PX = 2;
/** How many of the margin ring's commonest colours are tried as the board under the fill. */
export const LABEL_BOARD_CANDIDATES = 4;
/** A stroke pixel is within this many levels of the label colour on every channel. */
export const LABEL_STROKE_TOLERANCE = 24;
/** A word pixel is within this many levels of `ramp[4]` on every channel. Tighter than the collar's
 *  48, because the Lilac stroke itself lies within 48 of `ramp[4]` on every channel. */
export const LABEL_WORDS_TOLERANCE = 24;
/** `machines.ts` `LABEL_FILL_ALPHA`, copied as data and pinned by the unit test. */
export const LABEL_FILL_ALPHA_EXPECTED = 0.16;
/** How far the measured fill alpha may sit from `LABEL_FILL_ALPHA_EXPECTED`. */
export const LABEL_FILL_ALPHA_SLACK = 0.05;
/** The largest residual, in levels, of the interior colour off the board-to-label line. */
export const LABEL_FILL_RESIDUAL_MAX = 6;
/** The words are drawn when the interior holds at least this many word pixels per device pixel
 *  squared (178 measured for `Order intake`). */
export const LABEL_WORDS_MIN = 60;

/** The label as the screen shows it. */
export interface LabelOnCanvas {
  /** Stroke pixels in each edge band: top, right, bottom, left. */
  sides: [number, number, number, number];
  /** Each side's floor, in device pixels: half of what a whole 2 px stroke along the band inks. */
  sideMin: [number, number, number, number];
  /** The fill as an alpha of the label colour over the board, and the residual off that line. */
  fillAlpha: number;
  fillResidual: number;
  /** Interior pixels within `LABEL_WORDS_TOLERANCE` of `ramp[4]`. */
  words: number;
  /** Every side at its floor, the fill at its alpha, the words at their floor. */
  boxDrawn: boolean;
  wordsDrawn: boolean;
}

type Rgb = { r: number; g: number; b: number };

function isNear(data: Uint8Array, i: number, c: Rgb, tol: number): boolean {
  return (
    Math.abs(data[i] - c.r) <= tol && Math.abs(data[i + 1] - c.g) <= tol && Math.abs(data[i + 2] - c.b) <= tol
  );
}

/** The commonest colours of a counted set, most common first. */
function commonest(counts: Map<number, number>, n: number): Rgb[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, n)
    .map(([k]) => ({ r: (k >> 16) & 0xff, g: (k >> 8) & 0xff, b: k & 0xff }));
}

/** `px` as an alpha of `fg` over `bg`, and the residual off the line from `bg` to `fg`, in levels. */
export function alphaOver(px: Rgb, bg: Rgb, fg: Rgb): { alpha: number; residual: number } {
  const d = [fg.r - bg.r, fg.g - bg.g, fg.b - bg.b];
  const v = [px.r - bg.r, px.g - bg.g, px.b - bg.b];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const alpha = dd === 0 ? 0 : (v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / dd;
  const residual = Math.hypot(v[0] - alpha * d[0], v[1] - alpha * d[1], v[2] - alpha * d[2]);
  return { alpha, residual };
}

/**
 * The label read off a screenshot of EXACTLY its cells (the clip's edges on the cells' edges),
 * `colour` the label colour (`0xRRGGBB`), `dpr` the image's device pixels per CSS pixel.
 */
export function labelOnCanvas(img: DecodedImage, colour: number, dpr: number): LabelOnCanvas {
  const fg: Rgb = { r: (colour >> 16) & 0xff, g: (colour >> 8) & 0xff, b: colour & 0xff };
  const band = Math.round(LABEL_BAND_PX * dpr);
  const margin = Math.round(LABEL_MARGIN_PX * dpr);
  const { width: w, height: h, data } = img;
  const sides: [number, number, number, number] = [0, 0, 0, 0];
  const inner = new Map<number, number>();
  const outer = new Map<number, number>();
  let words = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;
      const midX = x >= band && x < w - band;
      const midY = y >= band && y < h - band;
      if (isNear(data, i, fg, LABEL_STROKE_TOLERANCE)) {
        if (y < band && midX) sides[0]++;
        else if (x >= w - band && midY) sides[1]++;
        else if (y >= h - band && midX) sides[2]++;
        else if (x < band && midY) sides[3]++;
      }
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      if (midX && midY) {
        inner.set(key, (inner.get(key) ?? 0) + 1);
        if (isNear(data, i, COLLAR_RING_RGB, LABEL_WORDS_TOLERANCE)) words++;
      } else if (x < margin || y < margin || x >= w - margin || y >= h - margin) {
        if (!isNear(data, i, fg, LABEL_STROKE_TOLERANCE)) outer.set(key, (outer.get(key) ?? 0) + 1);
      }
    }
  }
  const lenX = Math.max(0, w - 2 * band);
  const lenY = Math.max(0, h - 2 * band);
  // Half of what a whole 2 px stroke inks along the band's length: one CSS px of stroke width.
  const sideMin: [number, number, number, number] = [lenX * dpr, lenY * dpr, lenX * dpr, lenY * dpr];
  const fill = commonest(inner, 1)[0];
  let best = { alpha: 0, residual: Number.POSITIVE_INFINITY };
  if (fill !== undefined) {
    for (const bg of commonest(outer, LABEL_BOARD_CANDIDATES)) {
      const r = alphaOver(fill, bg, fg);
      if (r.residual < best.residual) best = r;
    }
  }
  const fillAlpha = Number.isFinite(best.residual) ? best.alpha : 0;
  const fillResidual = Number.isFinite(best.residual) ? best.residual : 0;
  const boxDrawn =
    sides.every((n, k) => n >= sideMin[k]) &&
    Math.abs(fillAlpha - LABEL_FILL_ALPHA_EXPECTED) <= LABEL_FILL_ALPHA_SLACK &&
    fillResidual <= LABEL_FILL_RESIDUAL_MAX;
  return {
    sides,
    sideMin,
    fillAlpha,
    fillResidual,
    words,
    boxDrawn,
    wordsDrawn: words >= LABEL_WORDS_MIN * dpr * dpr,
  };
}

// ===========================================================================
// THE CABLE AND ITS PRONGS, IN PIXELS (the 77-05 refuter round, phase 77 D-04)
// ===========================================================================
//
// WHY IT EXISTS. Plan 77-05's cable read (`WireLayer.cablePolylines`, through `drawnCableSet` and
// `drawnCableGrade`) lists the stroke instructions the cables Graphics holds. That is renderer
// object state, not the canvas: a resting cable stroked at alpha 0 (refuter 1) or a cables
// Container set invisible (refuter 5) still lists both polylines, and the whole composed walk
// stayed green with no cable on screen. It never read the terminals at all, so a renderer that
// dropped every prong and nub after the Load passed too (refuter 7). These readers take a
// SCREENSHOT the caller decoded and say what a user sees on the cable's own cells and at its two
// nubs.
//
// WHAT A RESTING CABLE IS, IN PIXELS. `wires.ts` strokes it 2 world px wide in
// `LOCKED_SKIN.palette.cable` (`0x2e8f99`, the muted electric teal of phase 92 D-10) at
// `CABLE_ALPHA_IDLE` 1 over the board's `ramp[0]` (`0x1b1f27`), with antialias off, so at camera
// scale 1 and device pixel ratio 1 every covered pixel reads ONE colour, the token itself
// (46,143,153): an opaque stroke composites to its own colour over anything, a grid line it
// crosses included. A pixel within `CABLE_INK_TOLERANCE` of it is cable ink. Nothing else on the
// board is that colour: the minor grid line reads (42,47,58), the major one (59,66,80), a machine
// nub `ramp[3]` (86,95,112) and the electric terminals (78,224,255). Until plan 92-04 the cable was
// `ramp[3]` at alpha 0.35, the composite (48,53,64), and a cell lost the two pixels of each grid
// crossing. A cable stroked at any other alpha or colour reads none of these pixels.
//
// WHICH CELLS. The first and last cells of a wire's path are the port cells of the two machines it
// docks to: the cable there is a few pixels long and drawn over the machine. They are left out
// and every cell between them is read. Each must hold at least `CABLE_CELL_MIN` ink pixels (half
// of a whole cell's 2 px by 32 px stroke) for the cable to be SEEN, and at most
// `CABLE_CELL_EMPTY_MAX` for it to be GONE (the delete chip over a cell measured 1).
//
// WHAT A PRONG IS, IN PIXELS. Each wire end stamps its terminal in `accents.electric`
// (`0x4ee0ff`) at alpha 1 on the terminals Graphics, centred on the docked port's nub anchor
// (`shared/geometry.ts` `nubAnchor`): a 10 px square with its prong stem on a Handler port, the
// 14 px inlet glyph on a Route port. The machine under it draws its own nub in a ramp step or
// the working accent, never in `electric`, so a box of half-side `TERMINAL_HALF_PX` around the
// anchor holds electric pixels only when the WIRE's terminal is drawn there: measured 120 and 124
// on the Route's two glyphs, 102 and 100 on the Handler's two squares, 0 when the terminals are
// not drawn. A forward comet is electric too, so a read is taken with no pulse in flight.

/** The resting cable's colour (`wires.ts`, `LOCKED_SKIN.palette.cable`), copied as data and
 *  pinned to the skin by `src/gates/canvasDots.test.ts`. */
export const CABLE_RGB = 0x2e8f99;
/** `wires.ts` `CABLE_ALPHA_IDLE`, copied as data and pinned by the unit test. */
export const CABLE_ALPHA = 1;
/** `ramp[0]`, the board's ground under the cable. */
export const BOARD_RGB = 0x1b1f27;
/** A cable pixel is within this many levels of the composite on every channel (rounding only). */
export const CABLE_INK_TOLERANCE = 3;
/** A run cell shows the cable at this many ink pixels per device pixel squared (half a cell's
 *  2 by 32 stroke; 52 to 69 measured with the opaque cable). */
export const CABLE_CELL_MIN = 32;
/** A run cell shows no cable at this many ink pixels or fewer per device pixel squared. */
export const CABLE_CELL_EMPTY_MAX = 4;
/** `accents.electric`, the terminals' colour (`LOCKED_SKIN.palette.accents.electric`). */
export const TERMINAL_RGB = 0x4ee0ff;
/** An electric pixel is within this many levels of `TERMINAL_RGB` on every channel. The build
 *  accent of a selection (`0x4fa8ff`) is 56 off on green. */
export const TERMINAL_INK_TOLERANCE = 24;
/** The half-side of the box read around a nub anchor, CSS px (the inlet glyph's 7, and slack for
 *  the device-pixel snap). */
export const TERMINAL_HALF_PX = 9;
/** A terminal is drawn at this many electric pixels per device pixel squared (half the 10 px
 *  square; 100 to 124 measured). */
export const TERMINAL_INK_MIN = 50;
/** A terminal is gone at this many electric pixels or fewer per device pixel squared. */
export const TERMINAL_EMPTY_MAX = 4;

/** One cable to read: its key, its routed cells and its two nub anchors, all in WORLD units. */
export interface CableToRead {
  key: string;
  cells: readonly (readonly [number, number])[];
  ends: readonly [{ x: number; y: number }, { x: number; y: number }];
}

/** How world units land in the image: image px = (world * scale + origin) * dpr, `cell` the
 *  world size of one cell. */
export interface ImageFrame {
  originX: number;
  originY: number;
  scale: number;
  dpr: number;
  cell: number;
}

/** One cable as the screen shows it. */
export interface CableOnCanvas {
  key: string;
  /** Cable ink on each run cell (the path without its two port cells), in path order. */
  cellInk: number[];
  /** Electric pixels around the from-end and the to-end nub anchors. */
  endInk: [number, number];
}

/** Every cable read, and the two verdicts. */
export interface CablesOnCanvas {
  cables: CableOnCanvas[];
  /** Every run cell at `CABLE_CELL_MIN` and every end at `TERMINAL_INK_MIN` (scaled by dpr squared). */
  seen: boolean;
  /** Every run cell at `CABLE_CELL_EMPTY_MAX` or fewer and every end at `TERMINAL_EMPTY_MAX` or fewer. */
  gone: boolean;
}

function rgbOf(c: number): Rgb {
  return { r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff };
}

/** The resting cable's one on-screen colour: `CABLE_RGB` at `CABLE_ALPHA` over `BOARD_RGB`. */
export function cableInkRgb(): Rgb {
  const fg = rgbOf(CABLE_RGB);
  const bg = rgbOf(BOARD_RGB);
  const mix = (f: number, b: number): number => Math.round(b + CABLE_ALPHA * (f - b));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
}

/** Pixels of colour `c` (within `tol`) inside `rect`, clipped to the image. */
function inkIn(img: DecodedImage, rect: PixelRect, c: Rgb, tol: number): number {
  let n = 0;
  for (let y = Math.max(0, rect.y0); y < Math.min(img.height, rect.y1); y++) {
    for (let x = Math.max(0, rect.x0); x < Math.min(img.width, rect.x1); x++) {
      if (isNear(img.data, (y * img.width + x) << 2, c, tol)) n++;
    }
  }
  return n;
}

/** The image rectangle of world cell (cx, cy). */
export function cellRectInImage(cx: number, cy: number, f: ImageFrame): PixelRect {
  const px = (w: number, o: number): number => Math.round((w * f.scale + o) * f.dpr);
  return {
    x0: px(cx * f.cell, f.originX),
    y0: px(cy * f.cell, f.originY),
    x1: px((cx + 1) * f.cell, f.originX),
    y1: px((cy + 1) * f.cell, f.originY),
  };
}

/** The image box of half-side `TERMINAL_HALF_PX` around world point `p`. */
export function terminalBoxInImage(p: { x: number; y: number }, f: ImageFrame): PixelRect {
  const cx = (p.x * f.scale + f.originX) * f.dpr;
  const cy = (p.y * f.scale + f.originY) * f.dpr;
  const h = TERMINAL_HALF_PX * f.dpr;
  return { x0: Math.floor(cx - h), y0: Math.floor(cy - h), x1: Math.ceil(cx + h), y1: Math.ceil(cy + h) };
}

/** The cables and their prongs read off a screenshot whose world-to-image mapping is `f`. */
export function cablesOnCanvas(img: DecodedImage, cables: readonly CableToRead[], f: ImageFrame): CablesOnCanvas {
  const ink = cableInkRgb();
  const term = rgbOf(TERMINAL_RGB);
  const d2 = f.dpr * f.dpr;
  const out: CableOnCanvas[] = cables.map((c) => ({
    key: c.key,
    cellInk: c.cells.slice(1, -1).map(([cx, cy]) => inkIn(img, cellRectInImage(cx, cy, f), ink, CABLE_INK_TOLERANCE)),
    endInk: [
      inkIn(img, terminalBoxInImage(c.ends[0], f), term, TERMINAL_INK_TOLERANCE),
      inkIn(img, terminalBoxInImage(c.ends[1], f), term, TERMINAL_INK_TOLERANCE),
    ],
  }));
  const seen =
    out.length > 0 &&
    out.every((c) => c.cellInk.every((n) => n >= CABLE_CELL_MIN * d2) && c.endInk.every((n) => n >= TERMINAL_INK_MIN * d2));
  const gone =
    out.length > 0 &&
    out.every((c) => c.cellInk.every((n) => n <= CABLE_CELL_EMPTY_MAX * d2) && c.endInk.every((n) => n <= TERMINAL_EMPTY_MAX * d2));
  return { cables: out, seen, gone };
}
