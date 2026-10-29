// BeltConfigBody.tsx - the Belt pace authoring body (BELT-01 / BELT-02 / BELT-04).
//
// A five-step `Belt pace` segmented control over `ticks_per_slot` {2,4,5,10,20},
// labelled with the px/sec figure each interval produces, plus a sixth segment
// for the two states the five cannot express (a run whose belts DISAGREE, and a
// run agreeing on a value that is not one of the five), the two scale end-labels
// that carry the unit, a deliberately UNCLAMPED typed entry, and four notes.
// `SinkConfigBody.tsx` copied structurally: the same `.fab-tool-btn is-pressed`
// segments (NOT a native <select>), the same `.fab-field` text input, the same
// named-constants-with-a-reason idiom, the same locally-declared render helpers
// INVOKED DIRECTLY rather than as <Segment/> / <Field/> elements.
//
// HOOK-FREE ON PURPOSE, and there is deliberately no `BeltConfigSection` wrapper
// for symmetry with `RouterConfigSection`: nothing in this arm needs a hook (there
// is no after-a-move focus restore to do), and staying hook-free is what lets the
// whole unit suite invoke the body directly in the node env.
//
// Purely presentational: told the current interval, the run and the typed text via
// props, raising the new interval and the raw keystrokes via callbacks. It never
// writes scene state and never decides legality - the host is the arbiter and
// answers in words on `#fab-refusal`, which is why this file declares no
// invalid-state ARIA attribute anywhere and no client-side error paint of any
// kind. That attribute and the numeric input type are spelled out ONLY in
// `BeltConfigBody.test.tsx`, which is where their absence is asserted.
//
// Skin, not skeleton: every gap is a `--fab-*` token, all text rides the Martian
// Mono body tokens, no hand-authored hex, no minted token, no new CSS selector,
// no padding declaration, no bare pixel literal and no icon.
//
// MOTION: none. A pressed segment repaints instantly and there is deliberately no
// animated preview of the new pace - the belts do not change speed until the host
// folds the command, and a panel-side preview would be the client claiming a
// verdict it does not have (the Phase 64 WHERE/WHY split).

import type { CSSProperties, JSX } from 'react';
import type { BeltRunEntry } from '../render/beltRun.ts';

/**
 * ONE product: the belt slot pitch in world px x the sim's ticks per second.
 *
 *   (CELL 32 / SLOTS_PER_TILE 4) * (1000ms / TICK_PAUSE 16ms) = 8 * 62.5 = 500
 *
 * The three cited constants: `CELL` 32 and `SLOTS_PER_TILE` 4
 * (`frontend/shared/geometry.ts`, `crates/fabrico-core/src/belt_slots.rs`), and
 * `TICK_PAUSE = Duration::from_millis(16)`
 * (`crates/fabrico-host/src/sim_loop.rs`, whose own docblock states "~62.5 t/s,
 * the exact cadence both live loops use today [...] MUST stay 16ms").
 *
 * **THIS IS THE WHOLE TICKS-PER-SECOND SURFACE OF THE FRONTEND, AND IT LIVES IN
 * `chrome/`, NEVER UNDER `render/`.** It is a LABEL unit, not a render input.
 * `beltGeometry.ts:329-340` DELETED a sim tick rate, a px-per-second march speed
 * and their product from the render path on the record, because `marchPxPerTick`
 * derives and clamps entirely in px per TICK and needs none of them.
 * Reintroducing a rate constant anywhere under `render/` would undo that deletion
 * (68-UI-SPEC section 2's binding rule).
 *
 * It was `480` in the seed, computed at an ASSUMED 60 t/s, and every label it
 * produced was 4.17% low. 68-UI-SPEC FINDING 1 is the measurement that corrected
 * it. A figure that needs a ticks-per-second term is a figure that can be wrong by
 * a term nobody re-checks, so the term is named once, here, with its derivation.
 */
export const PACE_PX_PER_SEC_AT_ONE_TICK = 500;

/** One offered pace step: its `ticks_per_slot` and the bare figure it renders. */
export interface PaceStep {
  /** The belt's advance interval in sim ticks per slot. Larger means slower. */
  ticks: number;
  /** The visible segment label: the bare px/sec figure, no unit, no rounding. */
  label: string;
}

/**
 * The five offered steps, chosen BECAUSE 500 divides by each of them EXACTLY, so
 * every label below is a whole number and none is a rounded approximation.
 *
 *   2 -> 250   4 -> 125   5 -> 100   10 -> 50   20 -> 25
 *
 * `ticks_per_slot = 2` is the FASTEST offered and it is not a taste call: the belt
 * tread's dash period is locked at 16 world px, so a dash pattern cannot convey
 * motion faster than half its period per drawn step without becoming
 * direction-ambiguous (`MARCH_NYQUIST_CEILING_PX_PER_TICK`, 8 px per tick). Half
 * that wall is 4 px per tick, which is `ticks_per_slot = 2`, which is
 * `DEFAULT_TICKS_PER_SLOT` - so the control is SLOWER-ONLY and the shipped default
 * already is the maximum. The slow end (20) carries no measurement at all: slower
 * is always safe from aliasing, so it is a CHOSEN floor (D-68-01 as amended).
 *
 * The previous set `{2,3,4,8,16}` was picked against the wrong 480 and would have
 * shipped `166.67`, `62.5` and `31.25` at the true cadence. There is a vitest case
 * asserting `500 % ticks === 0` for every entry precisely so a step that reddens
 * the whole-number property cannot be added silently.
 *
 * A MODULE CONSTANT, never derived per render: the group can therefore never
 * render zero segments (UI Consideration E1/empty).
 */
export const PACE_STEPS: readonly PaceStep[] = [2, 4, 5, 10, 20].map((ticks) => ({
  ticks,
  // No `Math.round`: every one of these five divides 500 exactly, and the whole
  // reason the set is these five is that the labels come out whole.
  label: String(PACE_PX_PER_SEC_AT_ONE_TICK / ticks),
}));

// ---------------------------------------------------------------------------
// The copy table (68-UI-SPEC section 9). Ten constants, every one NAMED rather
// than inlined for the `HTTP_METHOD_DEFAULT` reason: a string a test pins by
// exact equality must have exactly one home, or the pin drifts from the render.
// Every one is pinned VERBATIM in `BeltConfigBody.test.tsx`, never by keyword -
// a Phase 67 mutation dropped a trailing word and stayed green under a
// `toContain` pin. No value carries U+2014 or U+2013.
// ---------------------------------------------------------------------------

/** The segmented group's label, and its accessible name (D-68-03 as amended). */
export const PACE_LABEL = 'Belt pace';
/** The fast end of the scale - the exact string D-68-03 locks. */
export const SCALE_FASTEST = 'Fastest (250 px/sec)';
/** The slow end of the scale - the exact string D-68-03 locks. */
export const SCALE_SLOWEST = 'Slowest (25 px/sec)';

/** The typed field's label. It states the UNIT, because the field's value is a
 *  SPEED in px/sec (higher is faster) and never the wire's interval. That
 *  direction is what discharges `ZeroBeltInterval`'s standing re-verify
 *  instruction: a typed zero is a stopped belt, so `A belt needs a speed above
 *  zero.` reads correctly against this control's own label. */
export const FIELD_LABEL = 'Pace (px/sec)';

/** The sixth segment's word when the run's belts DISAGREE. Locked by D-68-08.
 *  It needs no composed accessible name: the visible word is already a complete
 *  answer to the question the panel exists to answer. */
export const MIXED_SEGMENT = 'Mixed';

/** The run line for a run of one.
 *
 *  IT DELIBERATELY DOES NOT CARRY THE APPLY CLAUSE `runPlural` does. On a
 *  one-belt run "Apply sets the pace on all of them" is a sentence about a set of
 *  one, which reads as a mistake. The scope statement exists to stop a user
 *  believing they edited a single tile; on a run of one that belief is correct,
 *  so the clause has no job. Both strings are pinned so the split is visible
 *  rather than accidental. */
export const RUN_SINGLE = 'This run is one belt.';

/** The run line for every run of two or more. It names the COUNT, because that
 *  is the only thing a reader can check against the board in front of them, and
 *  it names what Apply will do where the user is about to press it. */
export function runPlural(count: number): string {
  return `This run is ${count} belts. Apply sets the pace on all of them.`;
}

/** State 5. States the FACT and what Apply will do about it, which D-68-08
 *  requires. Mixed is a legal representable state carrying no error and no
 *  block, so this is a disclosure and never an alert. */
export const MIXED_NOTE =
  'The belts in this run hold different paces. Choose one to set them all.';

/** State 7. The DISCLOSURE that replaces a clamp: whenever the typed figure
 *  resolves to a different figure, the panel says so BEFORE Apply, so displayed
 *  still equals committed and the display simply got one line longer. Not an
 *  error: no `role="alert"`, no destructive colour, nothing blocked. */
export function nearestNote(pxPerSec: string): string {
  return `The nearest pace a belt can run is ${pxPerSec} px/sec.`;
}

/**
 * The one standing note. **This is SC4's reason, said to the user in the user's
 * own words**, which is the half of BELT-04 the command-layer bound cannot ship.
 *
 * DERIVED from the scale's fast end rather than transcribed beside it: a figure
 * restated from an assumption instead of from the one place it lives is exactly
 * what FINDING 1 caught, and this arm does not repeat it.
 *
 * It says "which way a belt is running" and NOT "the tread's direction". `tread`
 * is shipped vocabulary in comments and tests and appears in zero user-facing
 * strings, so putting it in a note would be a new anatomy word reaching a label
 * (66-UI-SPEC section 1's rule). "Which way a belt is running" is what the
 * aliasing actually costs the player and needs no vocabulary at all.
 */
export const PACE_NOTE = `${PACE_STEPS[0].label} px/sec is the fastest: any faster and you cannot tell which way a belt is running.`;

// ---------------------------------------------------------------------------
// The conversion
// ---------------------------------------------------------------------------

/** The u32 ceiling the wire can carry. A value past it is not a bigger number to
 *  the host, it is a DECODE FAILURE - which lands on `Malformed`, whose sentence
 *  names no cause and tells the user nothing. */
const U32_MAX = 0xffffffff;

/**
 * px/sec (as typed) -> `ticks_per_slot` (as the wire carries it).
 *
 * **TOTAL BY CONSTRUCTION, and totality is the design rather than a side effect:
 * every input produces a `u32` the wire can carry, AND every output lands on a
 * refusal sentence that is TRUE for that input.** The second half is the one that
 * needs guarding, and it is what the two floors below exist for. The
 * `RefusalMessage.tsx` `Malformed` docblock states the rule this discharges: a
 * sentence must be true of every cause under its tag.
 *
 * The mapping, which is 68-UI-SPEC 5.2's table:
 *
 * | typed                          | resolves to  | reaches            |
 * |--------------------------------|--------------|--------------------|
 * | a figure on the scale          | that step    | accepted           |
 * | in range, off the scale (167)  | 2..=20       | accepted           |
 * | the wall figure (500)          | 1            | `PaceOutOfRange`   |
 * | so large the interval rounds 0 | floored to 1 | `PaceOutOfRange`   |
 * | below the slow end             | > 20         | `PaceOutOfRange`   |
 * | absurdly small, still non-zero | u32 ceiling  | `PaceOutOfRange`   |
 * | so small it UNDERFLOWS to zero | 0            | `ZeroBeltInterval` |
 * | 0, negative, empty, non-numeric| 0            | `ZeroBeltInterval` |
 *
 * THE ORDER OF THE FIRST TWO GUARDS IS LOAD-BEARING. A NaN (empty field, letters,
 * a stray unit) and a non-positive figure are a stopped belt and reach the zero
 * sentence. A POSITIVE INFINITY is not: it is what a pasted 500-digit figure
 * becomes, and `A belt needs a speed above zero.` would be flatly false for
 * someone who just typed the largest number they could. It is floored to the wall
 * value instead, so it reaches the out-of-range sentence, which is true of it.
 * That is the same floor the "rounds to zero" row applies, extended to the input
 * that overflows the double rather than the division.
 *
 * THE TWO "ABSURDLY SMALL" ROWS ARE ONE INPUT CLASS SPLIT BY THE DOUBLE, and the
 * split is where it is because `Number()` is what decides it, not this function.
 * `1e-300` survives as a positive double, so `Math.round(500 / 1e-300)` overflows
 * the u32 ceiling and reaches the out-of-range sentence. `1e-400` does not
 * survive: `Number('1e-400')` IS exactly `0`, so it takes the `pxPerSec <= 0`
 * guard on the first line and reaches the zero sentence instead. That is the
 * right answer rather than a leak - a figure that is zero as a double IS a
 * stopped belt, and "A belt needs a speed above zero." is true of it - but the
 * table is written to be checkable row by row, and the single row this replaces
 * was not checkable as stated. `5e-324` (the smallest positive double) is the
 * boundary: it is still the FIRST row.
 */
export function paceToTicks(typed: string): number {
  const pxPerSec = Number(typed);
  // Empty, non-numeric, zero or negative: a stopped belt. -> ZeroBeltInterval.
  if (Number.isNaN(pxPerSec) || pxPerSec <= 0) return 0;
  // A positive infinity (the 500-digit paste). -> the wall, not the zero
  // sentence. See the docblock: the zero sentence would be false for it.
  if (!Number.isFinite(pxPerSec)) return 1;
  const ticks = Math.round(PACE_PX_PER_SEC_AT_ONE_TICK / pxPerSec);
  // The interval rounded to zero, so the figure is faster than the wall. Floor
  // it AT the wall rather than letting it fall through to the zero sentence.
  if (ticks < 1) return 1;
  return Math.min(ticks, U32_MAX);
}

/**
 * `ticks_per_slot` -> the bare px/sec figure a segment or the field displays.
 *
 * `Math.round` is right here and appears in exactly two places in this arm,
 * neither of them a scale label: the five offered steps divide 500 exactly, so
 * the rounding is a no-op for them and matters only for an off-scale value (worst
 * case `t = 3` at `167`). **The rounding is NOT disclosed as arithmetic, and that
 * is deliberate** - a sentence about rounding in front of a user who asked for a
 * slower belt is noise. What IS disclosed is the difference between what a user
 * TYPED and what the belt will run, which is a different fact and is
 * {@link nearestNote}.
 *
 * Returns the empty string for a non-positive interval, which the core never
 * holds and only a typed zero can produce in the buffer. There is no honest
 * figure for it and inventing one would be worse than saying nothing.
 */
export function paceLabelOf(ticksPerSlot: number): string {
  if (!Number.isFinite(ticksPerSlot) || ticksPerSlot <= 0) return '';
  return String(Math.round(PACE_PX_PER_SEC_AT_ONE_TICK / ticksPerSlot));
}

/** Do the belts in this run hold DIFFERENT paces (68-UI-SPEC state 5)?
 *
 *  Reads `BeltRunEntry.ticksPerSlot`, which arrived in the render packet for
 *  every belt, so this costs no query. A run of zero or one cannot disagree. */
export function isMixedRun(run: readonly BeltRunEntry[]): boolean {
  return run.length > 1 && run.some((belt) => belt.ticksPerSlot !== run[0].ticksPerSlot);
}

// ---------------------------------------------------------------------------
// Styles + render helpers
// ---------------------------------------------------------------------------

const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** The scale end-labels and the four notes. `--fab-ink` like every other
 *  body-tier string in the chrome: this arm MINTS NO TOKEN, and the old dim
 *  advisory tier (`--fab-outline`, 1.636:1, not a near miss) is not reached for;
 *  since phase 91 (UI-SPEC A13) no inspector word wears it. This is the ports section's `EDIT_STATUS_STYLE` reading (advisory
 *  GEOMETRY at full ink), declared locally rather than imported for the same
 *  reason `SinkConfigBody`'s helpers are duplicated rather than extracted.
 *
 *  `lineHeight: 1.3` on the multi-line notes so they wrap legibly inside the
 *  panel's existing vertical scroll wrapper; nothing here is truncated or
 *  clamped. */
const NOTE_STYLE: CSSProperties = {
  ...LABEL_STYLE,
  margin: 0,
  lineHeight: 1.3,
};

/** One `.fab-tool-btn is-pressed` segment. A render HELPER invoked directly (not
 *  `<Segment/>`) so the <button> inlines into the body tree for node-env test
 *  walking (the DeleteControl direct-invocation discipline; no hooks here).
 *
 *  `accessibleName` rather than the bare figure: WCAG 2.5.3 label-in-name is
 *  satisfied because it CONTAINS the visible label, and `250 px per second` reads
 *  correctly aloud where `px/sec` would be spelled out character by character. */
function segment(
  label: string,
  accessibleName: string,
  pressed: boolean,
  onClick: () => void,
): JSX.Element {
  return (
    <button
      key={label}
      type="button"
      className={pressed ? 'fab-tool-btn is-pressed' : 'fab-tool-btn'}
      aria-pressed={pressed}
      aria-label={accessibleName}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** A stacked labelled `.fab-field` text row (render helper, invoked directly -
 *  the same reason `segment` is). Copied from `SinkConfigBody.tsx`'s `field`,
 *  with `inputMode="decimal"` added so a touch keyboard offers digits.
 *
 *  THREE INDEPENDENT MEASURED REASONS FOR `type="text"` WITH NO RANGE ATTRIBUTES
 *  AND NO INVALID-STATE ATTRIBUTE, all of which have to hold at once:
 *
 *  1. `min` and `max` are ADVISORY ONLY (65-UI-SPEC's `sanitizeTimerInterval`
 *     finding). They would enforce nothing at all, so they buy no safety.
 *  2. They DO paint a `:invalid` state that reads as the app refusing. That
 *     competes with the host's own refusal sentence and breaks the Phase 64 split
 *     between WHERE a verdict is delivered and WHY. The invalid-state ARIA
 *     attribute is worse still: it tells a screen reader the user made a mistake
 *     the client has no standing to declare.
 *  3. THE NUMERIC INPUT TYPE BLANKS `.value` on some intermediate input in both
 *     Chromium and WebKit, which would silently drop what the user typed in the
 *     one field whose entire purpose is to send it. That is why this input stays
 *     `type="text"` with `inputMode="decimal"`.
 *
 *  AND IT DELIBERATELY DOES NOT CLAMP. This is a narrow, intentional departure
 *  from the sanitize-on-commit discipline the router offset follows
 *  (`sanitizeRouteOffset`, 65-UI-SPEC's "committed equals displayed"). That rule
 *  exists because a silently clamped value makes the LOGGED command diverge from
 *  what the panel shows; this field does not clamp at all, so it cannot diverge -
 *  what the user typed is what is sent. THE RULE THAT REPLACES THE CLAMP IS
 *  DISCLOSURE: whenever the typed figure resolves to a different figure the panel
 *  says so before Apply ({@link nearestNote}). Displayed still equals committed;
 *  the display just got one line longer.
 *
 *  D-68-04 is why the unclamped path exists at all: it keeps ONE out-of-range
 *  path reachable from the shipped UI, so Phase 64's refusal is exercised by a
 *  live e2e on the real app. A bounded-only control would make that refusal
 *  unreachable while its tests stayed green - the checks-that-cannot-fail shape
 *  Phase 67 surfaced eight times. */
function field(
  id: string,
  label: string,
  value: string,
  onChange: (value: string) => void,
): JSX.Element {
  return (
    <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
      <label htmlFor={id} style={LABEL_STYLE}>
        {label}
      </label>
      <input
        id={id}
        className="fab-field"
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      />
    </div>
  );
}

/** The accessible name for a pace segment: the visible figure plus the spoken
 *  unit. Exported so the specs assert against the derivation, not a re-typed
 *  string. */
export function paceAccessibleName(label: string): string {
  return `${label} px per second`;
}

export interface BeltConfigBodyProps {
  /** The BUFFER's advance interval in sim ticks per slot - what Apply will
   *  commit. It comes from `machine_config` for the CLICKED belt and from
   *  nowhere else, then follows the user's edits (68-UI-SPEC 3.3's two-sources
   *  rule). The RUN's other paces come from `run` and are used for exactly two
   *  things: detecting Mixed, and counting the run. */
  ticksPerSlot: number;
  /** The whole run this Apply writes to, in flow order, each entry carrying its
   *  OWN live pace off the render packet. */
  run: readonly BeltRunEntry[];
  /** The typed field's RAW text, or null when the field mirrors the buffer.
   *  Null rather than a derived string because the two are genuinely different
   *  states: `null` means "nothing typed, show what the run holds" (which is the
   *  EMPTY string in Mixed), while `''` means "the user cleared the field", which
   *  resolves to zero and reaches `ZeroBeltInterval` if applied. */
  typed: string | null;
  /** Raise the newly-chosen interval. The panel's Apply is what commits it. */
  onChange: (ticksPerSlot: number) => void;
  /** Raise the RAW keystrokes, unsanitized and unclamped. See `field`. */
  onTyped: (text: string) => void;
}

export function BeltConfigBody({
  ticksPerSlot,
  run,
  typed,
  onChange,
  onTyped,
}: BeltConfigBodyProps): JSX.Element {
  const mixed = isMixedRun(run);
  // The buffer's figure, as the field and the sixth segment display it.
  const bufferLabel = paceLabelOf(ticksPerSlot);
  // The five offered steps cannot express two states: a run that DISAGREES, and
  // an agreed value that is not one of them. Both add ONE TRAILING SEGMENT
  // rather than pressing nothing, and that is what PRESERVES the single-select
  // invariant instead of breaking it - the shape 65-UI-SPEC used for its
  // `Missing output` row. In state 6 the figure appears on both the segment and
  // the field; that redundancy is the price of the invariant and the router's
  // missing-output segment paid the identical price.
  const onScale = !mixed && PACE_STEPS.some((step) => step.ticks === ticksPerSlot);
  const offScale = !mixed && !onScale && bufferLabel !== '' ? bufferLabel : null;

  // The field mirrors the buffer until the user types. In Mixed it is EMPTY,
  // because there is no single pace to show and the head belt's would be a
  // statement the run does not support. Apply is disabled there anyway: the
  // buffer is not dirty, which falls out of the panel's EXISTING `!dirty` guard
  // and needs no new gate. DO NOT ADD ONE.
  const fieldValue = typed ?? (mixed ? '' : bufferLabel);

  // State 7. The typed figure resolved somewhere else, so say so BEFORE Apply.
  // Compared NUMERICALLY so `250.0` and `250` are not reported as a difference.
  const resolvedElsewhere =
    typed !== null && bufferLabel !== '' && Number(typed) !== Number(bufferLabel);

  return (
    <div
      id="fab-belt-config"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-md)' }}
    >
      {/* The scope of Apply, said out loud. Rendered only for a run this panel
          can actually see: an empty run is the transient between a belt leaving
          the scene and the selection clearing, and `This run is 0 belts.` would
          be worse than silence. */}
      {run.length > 0 && (
        <p id="fab-belt-run" style={NOTE_STYLE}>
          {run.length === 1 ? RUN_SINGLE : runPlural(run.length)}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
        <label style={LABEL_STYLE}>{PACE_LABEL}</label>
        {/* `aria-label`, NEVER `aria-labelledby`: the shipped node-env helper
            resolves a group by `el.props['aria-label'] === label`, so an
            `aria-labelledby` group is invisible to every unit assertion.
            `flexWrap: 'wrap'` for the reason `SinkConfigBody.tsx`'s Method row
            sets it - the row's intrinsic demand exceeds the panel content box. */}
        <div
          role="group"
          aria-label={PACE_LABEL}
          style={{ display: 'flex', gap: 'var(--fab-space-xs)', flexWrap: 'wrap' }}
        >
          {PACE_STEPS.map((step) =>
            segment(
              step.label,
              paceAccessibleName(step.label),
              onScale && ticksPerSlot === step.ticks,
              () => onChange(step.ticks),
            ),
          )}
          {/* The sixth segment. Both variants are PRESSED and both are inert:
              they report the state the run is in, and the way out of either is
              to press one of the five or to type a figure. `Mixed` needs no
              composed accessible name - the visible word is the whole answer. */}
          {mixed && segment(MIXED_SEGMENT, MIXED_SEGMENT, true, () => {})}
          {offScale !== null &&
            segment(offScale, paceAccessibleName(offScale), true, () => {})}
        </div>
        {/* The unit rides the group label, these two end-labels and the segments'
            accessible names - never the visible segment text, which is the bare
            figure (68-UI-SPEC 4.3's width derivation). `flexWrap: 'wrap'` here
            for the same measured reason as the segment row above. */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 'var(--fab-space-sm)',
          }}
        >
          <span style={NOTE_STYLE}>{SCALE_FASTEST}</span>
          <span style={NOTE_STYLE}>{SCALE_SLOWEST}</span>
        </div>
      </div>

      {mixed && (
        <p id="fab-belt-mixed" style={NOTE_STYLE}>
          {MIXED_NOTE}
        </p>
      )}

      {field('fab-belt-pace', FIELD_LABEL, fieldValue, onTyped)}

      {resolvedElsewhere && (
        <span id="fab-belt-nearest" style={NOTE_STYLE}>
          {nearestNote(bufferLabel)}
        </span>
      )}

      <p id="fab-belt-note" style={NOTE_STYLE}>
        {PACE_NOTE}
      </p>
    </div>
  );
}
