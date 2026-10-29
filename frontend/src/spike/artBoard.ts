// DEV-ONLY art board (BOARD-01, plan 57-01). The comparison instrument Phase 57
// exists to build: every machine subject, in every candidate direction, at every
// zoom that decides legibility - rendered through the REAL Pixi vector path so
// what is judged is what will actually ship.
//
// This module is NEVER imported by App.tsx / main.tsx; it is loaded only by the
// root-level art-board.html dev page, which is not a build input (vite.config.ts
// declares no extra rollup inputs, so only index.html is), so it stays out of
// `dist`. Nothing here is exported outside src/spike/.
//
// WHAT THIS BOARD IS NOT, named so a future contributor cannot infer permission from
// silence (57-UI-SPEC Part G). It is not a variant system: there is no direction
// registry under src/render/, no setDirection seam and no painter swap - that is
// the half-built skin picker SKIN-02 deleted one phase ago. It is not a live-canvas
// mode: no query flag on index.html, no mount from App.tsx, no global, no
// keybinding. It has ZERO interactive controls and ZERO persistence: no button, no
// input, no select, no click listener, no localStorage, no sessionStorage, no URL
// parameter. It ranks nothing and it does not carry a choice - the only record of a
// choice is 57-ART-LOCK.md, written by the maintainers.
//
// THE TRACER STATE (plan 57-01). Today this renders exactly ONE cell: SOURCE, at
// zoom one, in direction A. That is deliberate. Research measured two traps that
// produce a board which looks right and is arithmetically wrong (see extractCell
// below), and proving the extract contract on one cell costs one commit while
// discovering it after a hundred and thirty-five costs the phase. Plans 06-08 widen
// the slices in artBoardSlate.ts; they do not restructure this module.
//
// COLOUR SOURCE. Every colour the board's own chrome uses is read from LOCKED_SKIN
// through `hex()` below - there is no hand-authored hex in this module. The
// candidate SVGs themselves carry literal hex under the documented never-ships
// exemption (render/assets/candidates/a/source.svg's header states it).

import { Application, Rectangle, type Container } from 'pixi.js';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';
import { buildSlate } from './artBoardSlate.ts';
import { buildChannelPanel } from './artBoardPanel.ts';
import { buildLaneStrip } from './artBoardLanes.ts';

/* ------------------------------------------------------------------ *
 * The board's constants. ONE declaration each, consumed by every section.
 * ------------------------------------------------------------------ */

/**
 * The column order, and the ONLY place it is declared (57-UI-SPEC N1).
 *
 * Locked by 57-CONTEXT.md D-01/D-04: four candidate directions plus TODAY as a
 * pinned reference that is NOT a candidate. The order is the registry order -
 * baseline first, then alphabetical - and it CARRIES NO MEANING. The board says so
 * in its standing header line rather than leaving a reader to infer it, because
 * column order is the cheapest way for an instrument to advocate without a word.
 *
 * WHAT BREAKS IF THIS MOVES: every section derives its columns from this one const,
 * so re-ordering it re-orders the whole board consistently - which is the point. A
 * second copy of this list anywhere is the defect: two lists drift, and a board
 * whose sections disagree about column order is an instrument that lies.
 *
 * This const is board-local and is NEVER exported out of src/spike/. A direction
 * registry under src/render/ is the SKIN-02 machinery this milestone just deleted.
 */
export const DIRECTIONS = ['TODAY', 'A', 'B', 'C', 'D'] as const;

/** One candidate column identifier. */
export type Direction = (typeof DIRECTIONS)[number];

/**
 * The four CANDIDATE columns: `DIRECTIONS` with the pinned reference dropped.
 *
 * DERIVED HERE, ONCE, AND EXPORTED (review WR-04). Two sections needed this axis and
 * declared it two different ways: the cost table carried a hardcoded
 * `['A', 'B', 'C', 'D']` literal while the lane strip derived it with its own
 * `.filter()`. Both named the same axis, and `DIRECTIONS`'s docblock above calls that
 * out by name - "a second copy of this list anywhere is the defect: two lists drift, and
 * a board whose sections disagree about column order is an instrument that lies". If
 * `DIRECTIONS` ever gained a fifth candidate the lane strip would have rendered it and
 * the cost table would have silently omitted it, which is exactly that failure.
 *
 * A FUNCTION, not a const, for the same TDZ reason `slateDirections` is one: the board's
 * sections import this module and this module imports them back, so ESM hands them a
 * partially-initialised namespace and a top-level read of `DIRECTIONS` throws. Every
 * caller reads it inside a function body.
 *
 * TODAY is dropped rather than filtered out per-caller because it is a PINNED REFERENCE
 * and not a candidate (D-01/D-04): it has no authored `.svg`, no tessellation cost, and
 * the lane strip does not draw the shipped belt at all.
 */
export function candidateDirections(): readonly Direction[] {
  return DIRECTIONS.filter((d) => d !== 'TODAY');
}

/** A board subject: a machine kind (or the endpoint) at its true base footprint. */
export interface Subject {
  /** The subject id, used in the DOM contract and as the candidate file stem. */
  readonly id: string;
  /** Base footprint width, in grid cells. */
  readonly w: number;
  /** Base footprint height, in grid cells. */
  readonly h: number;
}

/**
 * The nine board subjects with their base footprints, as LITERALS.
 *
 * MIRRORED, NOT DERIVED, and that is the decision. These values mirror the frozen
 * `base_footprint` at crates/fabrico-core/src/state.rs:926 and its render-side twin
 * `KIND_SPECS` at render/synth/generators.ts:238. Neither is imported and neither is
 * computed from: an assertion (or an instrument) derived from the source it checks
 * cannot disagree with it, which is the EXPECTED_FIXTURE_COUNT principle 56-04
 * established. If a footprint here ever disagrees with the core, that disagreement
 * is the finding - a derived list would have silently agreed forever.
 *
 * WHAT BREAKS IF THIS MOVES: a wrong footprint renders a subject at the wrong pixel
 * size, and the whole board's premise is that a FACTORY is judged at the size it
 * ships at. Machines are NOT all one cell (57-UI-SPEC A.2) - judging a nine-cell
 * hero at one-ninth its area is judging something a user will never see.
 *
 * Footprints grow past the base with ports (grow_to_fit, PORT-07). The board renders
 * the BASE footprint only: that is the shipped default, and port-driven growth is
 * not a board axis.
 */
export const SUBJECTS: readonly Subject[] = [
  { id: 'SOURCE', w: 1, h: 1 },
  { id: 'BELT', w: 1, h: 1 },
  { id: 'FACTORY', w: 3, h: 3 },
  { id: 'TEE', w: 2, h: 2 },
  { id: 'BALANCER', w: 2, h: 2 },
  { id: 'ROUTER', w: 2, h: 3 },
  { id: 'MERGE', w: 2, h: 2 },
  { id: 'SINK', w: 1, h: 1 },
  { id: 'ENDPOINT', w: 1, h: 1 },
];

/**
 * The three zoom levels, ascending (57-CONTEXT.md D-07).
 *
 * 1.77 is not a decoration: it is the 177% case that prompted this milestone, the
 * fractional zoom at which today's pixel bake visibly degrades. Dropping it would
 * remove the single condition the whole overhaul was called for.
 *
 * WHAT BREAKS IF THIS MOVES: ascending order is stated on the board so the order is
 * not read as a ranking. Re-ordering it turns a scan into an implied preference.
 */
export const ZOOMS = [1, 1.77, 2] as const;

/**
 * Grid units per cell: the 32-unit module, on both axes.
 *
 * WHAT BREAKS IF THIS MOVES: it is the multiplier between a subject's footprint and
 * its pixel size, so it sets every extraction frame on the board. It is also the
 * authoring grid every candidate SVG's viewBox is written on
 * (render/assets/README.md), so a change here silently divorces the board's
 * arithmetic from the artwork's.
 */
export const CELL_U = 32;

/** An integer colour as a CSS hex string. The one bridge from LOCKED_SKIN to CSS. */
export const hex = (n: number): string => '#' + (n >>> 0).toString(16).padStart(6, '0');

/**
 * The board substrate, as an INTEGER: the darkest ramp step, the same void the real
 * canvas paints behind the floor (bootPixi background).
 *
 * ONE source, TWO consumers that must never disagree: the CSS cell background, and
 * the `clearColor` passed into every extraction. If those two diverge the artwork
 * sits on one colour and the surrounding box on another, and every cell acquires a
 * visible seam that reads as a property of the candidate rather than of the board.
 */
export const SUBSTRATE = LOCKED_SKIN.palette.ramp[0] as number;

/** The substrate as CSS. Same value, same source - see SUBSTRATE. */
export const substrate = hex(SUBSTRATE);

/** The board's ink: the highest ramp step, used for every label and every line of copy. */
export const ink = hex(LOCKED_SKIN.palette.ramp[4] as number);

/** The block separator rule colour. */
export const rule = hex(LOCKED_SKIN.palette.ramp[1] as number);

/**
 * The fixed cell box width, in CSS px (57-UI-SPEC B.1).
 *
 * 192 px is the widest content on the board (a 3x3 FACTORY at 2x) plus the 8 px
 * padding on each side. It is IDENTICAL in every column of every row, which is N2:
 * a direction that got a wider box would be advocated for by the layout.
 */
export const CELL_BOX_W = 208;

/**
 * The board's standing header line, verbatim from 57-UI-SPEC C.2.
 *
 * Pre-checked against D-14's banned-token list. It is rendered VERBATIM - a spec
 * asserts its exact text - because the neutrality claims it makes are the ones the
 * instrument is obliged to make out loud rather than leave a reader to infer.
 */
export const BOARD_HEADER: readonly string[] = [
  'Column order carries no meaning. TODAY is a pinned reference, not a candidate.',
  'Nothing on this board is a ranking, a score or an endorsement.',
  'The lock file, 57-ART-LOCK.md, lives in the internal design notes;',
  'nothing on this page records a choice.',
];

/* ------------------------------------------------------------------ *
 * Candidate discovery
 * ------------------------------------------------------------------ */

/**
 * Every candidate draft's raw SVG text, discovered at build time.
 *
 * `query: '?raw'` + `import: 'default'` is the current Vite 8 form; the older
 * `as: 'raw'` option was deprecated in Vite 5.1. `eager: true` because the board is
 * a single synchronous build pass and a lazy glob would add an async barrier per
 * cell for nothing.
 *
 * The drafts live in a SUBDIRECTORY of render/assets/ on purpose: Phase 56's
 * production walk (scripts/lint-svg.ts, and the vertex-budget test) globs
 * `render/assets/*.svg` NON-RECURSIVELY, so thirty-two discarded drafts are
 * invisible to the shipped asset gates - the established __fixtures__ mechanism,
 * reused rather than reinvented.
 *
 * They are NOT registered in svgAssets.ts's ASSET_SOURCES and their names are NOT in
 * its AssetName type. That registry is the SHIPPED asset set; drafts must never
 * enter its type.
 */
const CANDIDATE_RAW = import.meta.glob('../render/assets/candidates/**/*.svg', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * `${direction}/${subject}` (both lower-case) -> raw SVG text.
 *
 * Built by PARSING each glob key rather than by reconstructing it. Vite normalises
 * glob keys, and a hand-built key that stops matching produces `undefined` -> an
 * empty GraphicsContext -> a blank cell with no error anywhere, which is exactly the
 * silent-failure class the completeness gate exists to catch. Parsing what the
 * bundler actually produced cannot drift from it.
 */
const CANDIDATES = new Map<string, string>();
for (const [key, text] of Object.entries(CANDIDATE_RAW)) {
  const m = /candidates\/([^/]+)\/([^/]+)\.svg$/.exec(key);
  if (m === null) continue;
  CANDIDATES.set(`${m[1] as string}/${m[2] as string}`, text);
}

/**
 * The raw SVG text for one (direction, subject) draft, or `undefined` when no draft
 * has been authored yet.
 *
 * `undefined` is a legitimate answer during the phase - thirty-two drafts land
 * across several plans - and the caller's job is to render a LABELLED absent cell
 * rather than a blank one. A blank cell and a "there is nothing here" cell look
 * identical and mean opposite things (57-UI-SPEC A.5).
 */
export function candidateSvg(direction: Direction, subject: string): string | undefined {
  return CANDIDATES.get(`${direction.toLowerCase()}/${subject.toLowerCase()}`);
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

/**
 * One labelled cell box, in pixelGuard.tsx's `surface()` shape.
 *
 * Every geometric property here is IDENTICAL in every column of every row (N2/N7/N8)
 * and a spec measures it with getBoundingClientRect rather than trusting this
 * function. `line-height: 0` is load-bearing rather than cosmetic: without it the
 * inline canvas acquires a descender gap, which is exactly the sub-pixel layout
 * drift the cell-geometry assertion would otherwise report as a mystery.
 */
export function cellBox(attrs: Record<string, string>): HTMLDivElement {
  const box = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) box.setAttribute(k, v);
  box.style.display = 'inline-block';
  box.style.boxSizing = 'border-box';
  box.style.width = `${CELL_BOX_W}px`;
  box.style.padding = '8px';
  box.style.background = substrate;
  box.style.lineHeight = '0';
  box.style.textAlign = 'center';
  box.style.verticalAlign = 'top';
  return box;
}

/* ------------------------------------------------------------------ *
 * The extraction contract - the single call site every section reuses
 * ------------------------------------------------------------------ */

/** Everything one cell's extraction needs. Nothing else is a lever. */
export interface ExtractCellOptions {
  /** The container holding this cell's geometry. DESTROYED by this call. */
  readonly target: Container;
  /** The subject's base footprint width, in grid cells. */
  readonly footprintW: number;
  /** The subject's base footprint height, in grid cells. */
  readonly footprintH: number;
  /** The row's zoom. */
  readonly zoom: number;
}

/**
 * The ONE Pixi `Application` the whole board renders through.
 *
 * Module-scoped rather than threaded through every call because there is exactly one
 * for the lifetime of the page and `extractCell` must be impossible to call against
 * a second. Chromium hard-caps LIVE WebGL contexts at sixteen and evicts the OLDEST
 * (measured: the seventeenth context blanks the first, which then reads [0,0,0,0]).
 * One Application per cell would therefore blank most of the board with no exception,
 * no rejected promise and no console error from Pixi - the exact silent failure the
 * completeness gate exists to catch, and far better designed out than caught.
 *
 * Null outside boot(): calling extractCell before or after the board is built is a
 * named throw, never a silent no-op.
 */
let boardApp: Application | null = null;

/**
 * True once boot() has begun tearing the Application down.
 *
 * MEASURED, not defensive. `app.destroy()` calls the GL driver's own
 * `WEBGL_lose_context.loseContext()`, which fires a real `webglcontextlost` event on
 * the board's canvas - so a bare listener reports "1" on EVERY healthy run and the
 * tripwire below is a permanently-red light that a reader learns to ignore. The flag
 * is what makes the attribute mean "the context died while the board was building",
 * which is the only reading that carries information. It is never reset: the board
 * builds exactly once, so any loss after teardown starts is our own doing.
 */
let boardTeardown = false;

/**
 * Render one cell's geometry offscreen and return the canvas holding its pixels.
 *
 * The target is rendered by `extract` itself through `textureGenerator`, which
 * allocates its own RenderTexture from the frame. So the cell is NEVER added to
 * `app.stage` and `app.render()` is NEVER called: the stage is empty for the whole
 * life of the board, and a reader who adds cells to it has introduced a
 * stage-cleanup bug for no benefit (57-RESEARCH CORRECTION 3).
 *
 * ALL THREE OPTIONS BELOW ARE LOAD-BEARING. Each closes a trap that produces a board
 * which looks right and is arithmetically wrong, and each was measured rather than
 * reasoned about (57-RESEARCH F3.2).
 */
export function extractCell(options: ExtractCellOptions): HTMLCanvasElement {
  const app = boardApp;
  if (app === null) {
    throw new Error('artBoard: extractCell called with no live Application (boot() owns its lifetime)');
  }
  const { target, footprintW, footprintH, zoom } = options;
  const canvas = app.renderer.extract.canvas({
    target,
    // TRAP C - without an explicit frame, the cell size comes from the artwork's own
    // LOCAL BOUNDS, which INCLUDE stroke extents: `region = frame || getLocalBounds()`,
    // then `region.width = Math.max(w, 1/res) | 0`. Measured: a 3u-stroked draft and a
    // 2u-stroked draft of the same subject extract at DIFFERENT pixel sizes. That is a
    // cell-geometry violation (N2) and an equal-space violation (N7) delivered by the
    // renderer, underneath the CSS the neutrality spec measures. The frame is in the
    // target's LOCAL space and the system applies translate(-region.x, -region.y), so
    // (0,0) is the SVG's own origin and a stroke centred on x=2 lands fully inside.
    frame: new Rectangle(
      0,
      0,
      Math.ceil(footprintW * CELL_U * zoom),
      Math.ceil(footprintH * CELL_U * zoom),
    ),
    // TRAPS A and B - clearColor defaults to TRANSPARENT, not to the Application
    // background. The background is a property of the VIEW and extraction never
    // touches the view, so omitting this yields a transparent buffer whose bytes are
    // PREMULTIPLIED (getPixels' unpremultiply branch is dead-code-eliminated in the
    // installed build, and generateCanvas putImageData's them into a 2D canvas that
    // expects un-premultiplied). Three things break at once: the substrate is no
    // longer inside the extraction, the "pixels differing from the substrate"
    // non-emptiness gate returns ~100% for EVERY cell including a genuinely blank one,
    // and the CVD transform is handed dark, wrong colour. With alpha 255 everywhere,
    // premultiplied and un-premultiplied are identical and the quirk cannot bite.
    clearColor: SUBSTRATE,
    // The backing store must be the frame size in DEVICE pixels regardless of the
    // host display density, so the board is byte-comparable across machines and a
    // spec can assert an exact canvas.width. The spec pins deviceScaleFactor too.
    resolution: 1,
  }) as HTMLCanvasElement;
  // The RenderTexture generateTexture allocated is destroyed by Pixi itself
  // (ExtractSystem.canvas does texture.destroy(true)); the holder is ours.
  target.destroy({ children: true });
  // Every image on this page is presented 1:1, so this changes nothing today. It
  // guarantees no browser resampling if the page is ever viewed at another DPR.
  canvas.style.imageRendering = 'pixelated';
  return canvas;
}

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

const readout = document.createElement('div');
readout.id = 'art-board-readout';
readout.style.display = 'none';

/**
 * The board's ONLY readiness signal. Set exactly once, from the single boot(), after
 * the last cell has extracted.
 *
 * A second top-level async booter would race this marker and let a spec read - or a
 * reader judge - a half-built board. pixelGuard.tsx's docblock records that as an
 * already-made mistake; this module inherits the rule rather than rediscovering it.
 */
const markReady = (): void => {
  readout.setAttribute('data-board-ready', '1');
};

/**
 * Read the LIVE antialias state off the board's own WebGL context attributes.
 *
 * Re-requesting the same context type returns the ALREADY-CREATED context, so
 * getContextAttributes() reports what the GL driver actually built - strictly
 * stronger than reading back the `antialias: false` option Pixi was handed, which
 * would still read "off" on a driver that ignored it.
 *
 * Returns FALSE ("not proven off") when no context or no attributes can be read, so
 * a missing context REDDENS the gate instead of passing over nothing.
 */
export function antialiasOff(canvas: HTMLCanvasElement): boolean {
  const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as
    | WebGLRenderingContext
    | null;
  if (gl === null) return false;
  const attrs = gl.getContextAttributes();
  if (attrs === null) return false;
  return attrs.antialias === false;
}

/* ------------------------------------------------------------------ *
 * Boot - ONE entry point, ONE markReady()
 * ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  const root = document.getElementById('art-board-root') as HTMLElement;
  root.style.background = substrate;
  root.style.color = ink;
  root.style.font = '12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  root.style.padding = '48px 24px';
  root.appendChild(readout);

  const header = document.createElement('div');
  header.id = 'art-board-header';
  header.style.marginBottom = '32px';
  header.style.borderBottom = `1px solid ${rule}`;
  header.style.paddingBottom = '16px';
  for (const line of BOARD_HEADER) {
    const p = document.createElement('div');
    p.textContent = line;
    header.appendChild(p);
  }
  root.appendChild(header);

  // EXACTLY ONE Application, for the whole board. See boardApp above for why the cap
  // makes this a hard constraint rather than an optimisation.
  const app = new Application();
  await app.init({
    // Sixteen by sixteen, never resized and never attached to the DOM: the
    // Application's canvas size is IRRELEVANT to extraction, because generateTexture
    // allocates a RenderTexture from the frame on every call. Measured: the whole
    // hundred-and-sixty-cell board ran through a 16x16 app.
    width: 16,
    height: 16,
    // The same darkest-ramp substrate the real canvas uses. Note this does NOT reach
    // the extracted pixels - that is what clearColor is for (see extractCell).
    background: SUBSTRATE,
    // AA off (matches bootPixi / SKIN-05) and ASSERTED below from the live context,
    // never assumed. With AA off the rasteriser snaps each edge to a whole device
    // pixel, which is what "crisp at a fractional zoom" means in this milestone.
    antialias: false,
    autoDensity: false,
    resolution: 1,
    // No ticker: the board draws nothing on a clock. It builds once and stops.
    autoStart: false,
    preference: 'webgl',
  });
  boardApp = app;

  // The one failure mode that would blank the whole board is context loss, and Pixi
  // reports it nowhere. Chromium DOES fire this event (it also logs a warning), so
  // naming it costs one listener and converts a silent blank board into a readable
  // attribute a spec can assert on. The teardown guard is what keeps the signal
  // honest - see boardTeardown above.
  app.canvas.addEventListener('webglcontextlost', () => {
    if (boardTeardown) return;
    readout.setAttribute('data-context-lost', '1');
  });

  buildSlate(root, { extractCell, candidateSvg });

  // The colour-channel panel (plan 57-07), built INSIDE this same single entry point
  // and against the SAME live Application. A second top-level async booter would race
  // the readiness marker and let a spec - or a reader - judge a half-built board.
  buildChannelPanel(root, { extractCell, candidateSvg });

  // The lane-width strip (plan 57-08), built INSIDE this same single entry point and
  // against the SAME live Application - the third and last section to mount, and the
  // last thing to run before the readiness marker. Its corner is drawn from the board's
  // own corrected geometry, never from the shipped belt bake.
  buildLaneStrip(root, { extractCell, candidateSvg });

  // Zero webfonts are loaded (the design system is the system monospace stack), so
  // this always resolves immediately. Kept for the markReady discipline: it removes
  // a class of flake at no cost and it never hangs.
  if (document.fonts && typeof document.fonts.ready?.then === 'function') {
    await document.fonts.ready;
  }

  // Written BEFORE the app is destroyed (the context must still be live to be read)
  // and before markReady(), so a spec can never observe the ready marker without the
  // attribute beside it.
  readout.setAttribute('data-antialias', antialiasOff(app.canvas as HTMLCanvasElement) ? '0' : '1');

  boardTeardown = true;
  app.destroy(true, { children: true });
  boardApp = null;

  markReady();
}

/**
 * THE TERMINAL HANDLER (review WR-07). `void boot()` carried no `.catch`.
 *
 * WHAT THAT COST, precisely. If anything threw before `markReady()`, the readiness
 * marker was never set and `readout` - created at module scope but appended INSIDE
 * `boot` - might not even be in the DOM. Every Playwright reader in the suite then
 * blocked on `page.locator('#art-board-readout[data-board-ready="1"]').waitFor(...)`
 * until the default timeout, and the failure reported as "locator timed out" rather
 * than as the underlying throw. A human opening the page saw a blank one.
 *
 * The board's own doctrine is "never a blank page, always a labelled reason" - stated in
 * `renderLaneErrorCell` and now in `renderSlateErrorCell`. This applies it at the top
 * level: the failure is RENDERED, the readout is guaranteed to be in the DOM, and
 * readiness is marked anyway so a reader (human or spec) gets the real error instead of
 * a timeout.
 *
 * `markReady()` IS STILL CALLED ON FAILURE, deliberately. The marker means "the board
 * has finished trying", not "the board is correct" - the board never publishes an
 * attribute describing its own correctness. `data-boot-error` is what a spec reads to
 * tell the two apart, and no assertion in the suite treats readiness as a pass.
 */
void boot().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  const root = document.getElementById('art-board-root');
  if (root !== null) {
    // The readout is appended inside boot(), so a throw before that line leaves it
    // detached and every spec waiting on a marker that can never appear.
    if (!root.contains(readout)) root.appendChild(readout);
    const strip = document.createElement('pre');
    strip.setAttribute('data-error', 'boot-failure');
    strip.style.whiteSpace = 'pre-wrap';
    strip.textContent = `the art board failed to build: ${message}`;
    root.appendChild(strip);
  }
  readout.setAttribute('data-boot-error', '1');
  markReady();
});
