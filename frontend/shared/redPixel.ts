// redPixel.ts (phase 92 review WR-B-06) - the one predicate that says whether a captured pixel reads
// as red, shared by every spec that grades "red on the board means a faulted machine" (CHROME-18,
// UI-SPEC "Red pixel") and pinned by `src/gates/redPixel.test.ts`.
//
// WHY BY HUE. The phase first graded red with `87-factory-two-emits`'s channel offsets,
// `r >= g + 25 && b >= g + 5 && r >= b`. Its `b >= g + 5` clause is tuned to the fault accent's
// blue-leaning red (240,80,110), so it rejected a brick red whose blue is at or below its green
// (the 25 % Source block, 188,78,78; pure red, 255,0,0) and accepted a magenta (the Merge block,
// 188,78,160). A whole-board count of 0 under it proved only that nothing near today's fault
// accent was drawn, while the user looks for anything red. This predicate reads the pixel's hue.
//
// THE RULE. A pixel is red when its largest channel is red, it is bright enough to read as a
// colour (largest channel at least `RED_MIN_VALUE`), it is saturated (the spread between its
// largest and smallest channels at least `RED_MIN_CHROMA` of the largest) and its hue lies in
// `(RED_HUE_MIN, RED_HUE_MAX)` degrees around 0. Measured in the unit test: the fault accent
// composited at every alpha of its blink cadence (0.25 to 0.8) over the floor and the minor grid
// line reads red; the magenta Merge tint, the cable teal, the item amber, every ramp step and every
// label colour but `clay` do not. `clay` (214,140,108, hue 18) does read red, so a count that must
// be 0 on an unfaulted board excludes Labels carrying it, the way it once excluded `rose`.

/** The largest channel's floor: below it a pixel is too dark to read as a colour. */
export const RED_MIN_VALUE = 72;
/** The chroma floor, as a share of the largest channel. */
export const RED_MIN_CHROMA = 0.3;
/** The hue band, degrees, exclusive at both ends: crimson (330) through red to red-orange (25). */
export const RED_HUE_MIN = -30;
export const RED_HUE_MAX = 25;

/** Whether the pixel (r, g, b), each 0 to 255, reads as red. */
export function isRedPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max !== r || max < RED_MIN_VALUE || max - min < RED_MIN_CHROMA * max) return false;
  const hue = (60 * (g - b)) / (max - min);
  return hue > RED_HUE_MIN && hue < RED_HUE_MAX;
}

/** The red pixels of an RGBA buffer, counted. */
export function redPixelCount(data: Uint8Array | Uint8ClampedArray | Buffer): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (isRedPixel(data[i], data[i + 1], data[i + 2])) n += 1;
  return n;
}
