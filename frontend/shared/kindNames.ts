// shared/kindNames.ts (72-13, GATE-01) - the ONE definition of the machine-kind
// display names and of the Legend's ordered kind view, extracted here so the ZERO-MOCK
// live suite can read them without importing product source.
//
// WHY IT LIVES OUTSIDE `src/`, WHICH IS THE WHOLE POINT. `e2e-live/support/oracle.ts`
// states the rule: the live project must be structurally auditable as zero-mock, and it
// imports `@playwright/test` plus exactly one pure values module - `shared/geometry.ts`.
// That module is the precedent this file follows verbatim: a dependency-free VALUES
// source, no Pixi, no React, no product LOGIC, living outside `src/` on purpose, so both
// suites assert against the SAME values and the audit is STRENGTHENED rather than
// weakened. `shared/geometry.ts`'s own header calls that a values-preserving extraction,
// and this is the second one.
//
// THERE IS STILL EXACTLY ONE NAME TABLE. `src/chrome/kindNames.ts` RE-EXPORTS what is
// defined here; it does not restate it. Plan 72-10 deleted a second name table and
// recorded why ("a one-entry map whose entry has moved is a third draft of the same
// trap"), and nothing about that is undone: there is one definition, in one file, read
// by the Palette, the canvas Alt-hold chips, the Legend, the ConfigPanel heading and now
// the live legend spec.
//
// WHY THE KEYS ARE BYTE LITERALS HERE. `machine_kind` lives in `src/protocol/kinds.ts`,
// and `shared/` may not import `src/` - that is the layering that makes this module
// importable by the zero-mock suite at all. So the bytes are written out, and
// `src/chrome/kindNames.test.ts` LOCKS them against the `machine_kind` constants in the
// same run: a byte typed wrong here reddens that test rather than silently renaming a
// machine. The lock is what makes the literals safe; do not remove one without the other.

/**
 * The kind-name display strings, keyed by the `machine_kind` byte. ELEVEN entries: the
 * eight the 33-UI-SPEC contract named, plus ROUTE (kind 9) and HTTP HANDLER (kind 10),
 * folded in by plan 72-10 under D-10, plus LABEL (kind 11, phase 76). Since phase 92 the
 * Legend's ordered view below lists all eleven, in palette order.
 *
 * WIRE (kind 8) stays a pure nameless seam and has NO entry: it is a transport wire, not
 * a node, and never reaches a name lookup.
 *
 * See `src/chrome/kindNames.ts` for the full rationale on the fold, on why the Legend reads
 * an ordered view rather than this map, and on why `HTTP Handler` carries the longer form.
 */
export const KIND_NAMES: Record<number, string> = {
  0: 'Source',
  7: 'Sink',
  2: 'Factory',
  3: 'Tee',
  4: 'Balancer',
  5: 'Router',
  6: 'Merge',
  1: 'Belt',
  9: 'Route',
  10: 'HTTP Handler',
  // Phase 76 (SHAPE-10, D-09): the palette row and the panel heading read 'Label'.
  11: 'Label',
};

/**
 * The kind order the Legend panel lists: PALETTE ORDER (phase 92, D-03, UI-SPEC 1.2). Source,
 * Sink, Factory, Tee, Balancer, Merge, Route, HTTP Handler (the Palette's `ENTRIES`), then the
 * Router preset row, then the Belt tool, then Label. The Wire tool is the one palette entry left
 * out: it is a link rather than a node, and the Legend's Connections group names it. A shared
 * ordered VIEW over {@link KIND_NAMES}.
 *
 * IT USED TO STAY AT EIGHT, the kinds 33-UI-SPEC reviewed, with Route and HTTP Handler named in
 * the Connections group and Label not named at all (76-UI-SPEC: "no Legend row for labels in
 * this phase"). Walk-112 read that as the Legend leaving out things a user can place, so phase 92
 * reviews all eleven as kind rows. LABEL IS A ROW BECAUSE IT LANDS ON THE BOARD: a user who places
 * one sees it there and should find it named here like everything else the palette places.
 */
export const KIND_LEGEND_ORDER: number[] = [0, 7, 2, 3, 4, 6, 9, 10, 5, 1, 11];
