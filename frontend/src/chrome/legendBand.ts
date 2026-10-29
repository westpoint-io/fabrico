// legendBand.ts - the horizontal band the bottom Legend strip may occupy,
// as a PURE function of measurements taken from the live DOM.
//
// WHY THIS IS A MODULE AND NOT A CLOSURE IN App.tsx. 52-06 shipped this logic
// inline, where its degradation paths were untestable, and every one of them
// failed OPEN: a missing `[data-fab-left-dock]` left the band at `{0, 0}`, which
// renders `left: calc(0px + var(--fab-space-lg))` - the EXACT bottom-left dock
// whose measured occlusion (6 of 9 palette tools at 1280x800, Belt among them)
// this strip exists to remove. The defect restored itself with no throw, no log
// and no failing assertion. Split out here, each refusal is a named `reason`
// that `legendBand.test.ts` drives directly, so "fails closed" is a gate rather
// than a claim.
//
// THE CONTRACT the DOM must satisfy, all of it measured, none of it literal:
//   - EXACTLY ONE `[data-fab-left-dock]` (the Palette column). One is a contract;
//     zero is the failure above; two or more means `querySelector` would have
//     silently picked whichever came first in document order.
//   - AT LEAST ONE `[data-fab-corner-dock]` surface that reports a box. The
//     attribute marks every RIGHT-DOCKED surface the strip must not run under,
//     not merely the bottom-right cluster: the CameraCluster is always mounted
//     (the one permanent corner dock since plan 91-03 removed the bottom-right
//     readout, CHROME-01), and the ConfigPanel joins it whenever a machine is
//     selected (52 CR-01: it was `top:lg / right:lg / bottom:lg` then; since plan
//     91-09 it docks below the toolbar and is as tall as its content; since review
//     IN-B-04 it counts only while its bottom reaches the strip's top, see
//     `cornerLeftsReachingStrip`). `Math.min` over their left edges is what makes the reserve
//     mean "the leftmost right-docked surface the strip would run under".
//   - A gutter that actually resolved (`--fab-space-lg`).
//   - Enough room left over for a strip (see LEGEND_MIN_STRIP_PX).
//
// Everything is in the shared positioning container's coordinate space: the
// docks are absolutely positioned against it, so `offsetLeft`/`offsetWidth` are
// already in the units the Legend's absolute `left`/`right` pair use.

/** The measured band, in the shared positioning container's coordinate space. */
export interface LegendBand {
  /** The right edge of the left dock column. The strip starts one gutter past it. */
  paletteRightPx: number;
  /** Container width minus the LEFTMOST right-docked surface's left edge. The
   *  strip stops one gutter short of it. */
  cornerInsetPx: number;
}

/**
 * The narrowest strip worth painting. Below it the band is refused outright
 * rather than clamped, because a clamped-to-zero strip is the WR-02 defect: an
 * `left`+`right` pair whose used width floors at 0 while every row inside carries
 * `whiteSpace: 'nowrap'`, so the content cannot shrink and instead overflows to
 * the right, over the corner docks and the canvas.
 *
 * The number is a floor on INVERSION, not a wrapping policy. Measured 2026-07-29
 * in Chromium at the shipped skin: the widest single nowrap row ("Working / tint
 * + motion (handling a request)") is 357px, and the TIGHTEST supported band once
 * the ConfigPanel is reserved is 372px (1024x768, machine selected). So no
 * supported window comes near this floor - it exists so that a window narrow
 * enough to invert the strip (a `resizable: true` Tauri window with no
 * `minWidth`, or a dock that stops reporting a box) refuses to paint instead.
 */
export const LEGEND_MIN_STRIP_PX = 240;

/** The CameraCluster is the one permanently mounted right-docked surface, so no
 *  corner dock at all means its layout-contract attribute was dropped (or it
 *  reports no box) and the strip would run to the container's right edge, under
 *  the Fit and zoom controls. Plan 91-03 (CHROME-01, D-02) moved this from 2 to 1
 *  when the bottom-right readout, the other permanent dock, was deleted: at 2 the
 *  Legend refused to open whenever nothing was selected. */
export const LEGEND_MIN_CORNER_DOCKS = 1;

/** One right-docked surface's left edge and bottom edge, in the container's coordinate space. */
export interface CornerDockBox {
  left: number;
  bottom: number;
}

/**
 * The left edges of the right-docked surfaces the strip would run under: those whose bottom edge
 * reaches the strip's top (phase 91 review IN-B-04). The inspector is as tall as its content and
 * ends above the camera cluster, so a short panel (a Source is about 385 px) ends far above the
 * strip, and reserving its whole width took about 400 px from the strip at 1280 wide for no
 * overlap. With no strip on screen (`stripTopPx` null) every dock counts, which is the safe
 * reading. The camera cluster always counts: its bottom is the strip's bottom.
 *
 * Stable both ways, so the strip cannot flip between two widths: a narrower strip wraps onto more
 * rows and its top rises, which keeps a dock it already counts counted, and a wider strip's top
 * falls, which keeps a dock it already leaves out left out.
 */
export function cornerLeftsReachingStrip(docks: readonly CornerDockBox[], stripTopPx: number | null): number[] {
  if (stripTopPx === null || !Number.isFinite(stripTopPx)) return docks.map((d) => d.left);
  return docks.filter((d) => d.bottom > stripTopPx).map((d) => d.left);
}

/** Why a band could not be measured. Each maps to one refusal branch below and
 *  each is driven directly by `legendBand.test.ts`. */
export type LegendBandRefusal =
  | 'no-left-dock'
  | 'ambiguous-left-dock'
  | 'too-few-corner-docks'
  | 'bad-gutter'
  | 'bad-container'
  | 'no-room';

export type LegendBandResult =
  | { readonly ok: true; readonly band: LegendBand }
  | { readonly ok: false; readonly reason: LegendBandRefusal };

/** The raw DOM readings the band is computed from. */
export interface LegendBandInput {
  /** `clientWidth` of the shared positioning container. */
  containerWidth: number;
  /** How many `[data-fab-left-dock]` elements the document holds. */
  leftDockCount: number;
  /** `offsetLeft + offsetWidth` of the left dock, or null when there is none. */
  leftDockRightPx: number | null;
  /** `offsetLeft` of every `[data-fab-corner-dock]` that REPORTS A BOX
   *  (`offsetWidth > 0`). A `display:none` dock reports `offsetLeft === 0`, which
   *  would make the reserve the whole container width and invert the strip, so
   *  invisible docks are dropped by the caller before they get here. */
  visibleCornerLeftsPx: readonly number[];
  /** The resolved `--fab-space-lg` gutter, in px. NaN when it did not parse. */
  spaceLgPx: number;
}

/**
 * Compute the band, or refuse with a reason. NEVER returns a partial or
 * zero-filled band: every caller must treat `ok: false` as "do not paint the
 * Legend at all". A Legend that fails to open is a visible, reportable bug; a
 * Legend that opens over the Belt tool is not.
 */
export function computeLegendBand(input: LegendBandInput): LegendBandResult {
  const { containerWidth, leftDockCount, leftDockRightPx, visibleCornerLeftsPx, spaceLgPx } = input;

  if (!Number.isFinite(spaceLgPx) || spaceLgPx < 0) {
    return { ok: false, reason: 'bad-gutter' };
  }
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return { ok: false, reason: 'bad-container' };
  }
  if (leftDockCount === 0 || leftDockRightPx === null || !Number.isFinite(leftDockRightPx)) {
    return { ok: false, reason: 'no-left-dock' };
  }
  if (leftDockCount > 1) {
    return { ok: false, reason: 'ambiguous-left-dock' };
  }
  if (visibleCornerLeftsPx.length < LEGEND_MIN_CORNER_DOCKS) {
    return { ok: false, reason: 'too-few-corner-docks' };
  }
  if (!visibleCornerLeftsPx.every((n) => Number.isFinite(n))) {
    return { ok: false, reason: 'too-few-corner-docks' };
  }

  const paletteRightPx = Math.max(0, leftDockRightPx);
  const cornerInsetPx = Math.min(
    containerWidth,
    Math.max(0, containerWidth - Math.min(...visibleCornerLeftsPx)),
  );
  // The width the strip would actually get. Refusing on this ONE quantity is
  // what makes inversion unreachable: there is no clamp that can quietly hand
  // back a zero- or negative-width box.
  const stripWidthPx = containerWidth - paletteRightPx - cornerInsetPx - 2 * spaceLgPx;
  if (stripWidthPx < LEGEND_MIN_STRIP_PX) {
    return { ok: false, reason: 'no-room' };
  }

  return { ok: true, band: { paletteRightPx, cornerInsetPx } };
}
