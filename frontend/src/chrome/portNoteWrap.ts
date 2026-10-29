// portNoteWrap.ts - the fixed-outputs note slot's wrap model, and the MEASURED
// column count it runs at.
//
// WHY IT IS SHARED (52 WR-06). 52-UI-SPEC budgets this slot at two rendered
// lines. One of the two notes that occupy it is measured for real, in a browser,
// by `e2e/panel-add-remove.spec.ts`; the other cannot be, because `ConfigPanel`
// always hands `PortsSection` an add handler, so the state that renders it is
// unreachable from the running app. Its budget was therefore held by a greedy
// word wrap in `PortsSection.test.tsx` at a column count ESTIMATED as "211px of
// run ... ~7.2px advance" = 29, and calibrated against the browser-measured
// sibling.
//
// That calibration could not discriminate: the sibling wraps to 2 lines for every
// column count from 21 to ~40, so it passes identically whether the true width is
// 26 columns or 29 - while the string under test flips to 3 lines at 26.
//
// So the number is MEASURED now instead of estimated, and it lives here so the
// browser gate and the node test consume the SAME constant: the e2e probes the
// real advance in the real font at the real width and asserts it equals
// PORT_NOTE_NARROWEST_COLS, and the node test wraps against it. Neither can drift
// from the other without going red.
//
// The measurement (Chromium, 2026-07-29, at the shipped skin) says the estimate
// was wrong: `--fab-font` at `--fab-font-size-base` computes to
// `12px/15.6px "Martian Mono", monospace`, whose advance is 8.0px, not 7.2px.
//
//   viewport | note run | advance | columns | sibling lines (browser)
//   ---------|----------|---------|---------|------------------------
//   1024     | 337.91px | 8.0px   | 42      | 1
//    800     | 264.00px | 8.0px   | 33      | 2
//    640     | 211.19px | 8.0px   | 26      | 2
//
// 26 is the narrowest the committed browser gate actually measures.

/** The narrowest column count the fixed-outputs note slot is measured at, from
 *  the 640px viewport in the committed `panel-add-remove.spec.ts` budget loop.
 *  MEASURED, not estimated - see the table above. The e2e asserts the browser
 *  still agrees with this number, so it cannot silently drift. */
export const PORT_NOTE_NARROWEST_COLS = 26;

/** The slot renders at `--fab-font` (Martian Mono, MONOSPACED) so advance is
 *  uniform and a fixed-column greedy word wrap IS the browser's wrapping rule.
 *  Never break inside a word: the slot sets no `overflow-wrap`, so a word longer
 *  than the run overflows rather than splitting - the same thing the browser does. */
export function wrappedLines(text: string, cols: number): number {
  let lines = 1;
  let used = 0;
  for (const word of text.split(' ')) {
    if (used === 0) used = word.length;
    else if (used + 1 + word.length <= cols) used += 1 + word.length;
    else {
      lines += 1;
      used = word.length;
    }
  }
  return lines;
}
