// LabelConfigBody.tsx - the label panel's Text field (phase 76, plan 76-02, SHAPE-10, D-06).
//
// The seventh per-kind body, split out of `ConfigPanel.tsx` like every other configurable
// kind (`RouteConfigBody` is the closest: one focal field, a hint under it, Apply below). It
// is a HOOK-FREE pure function, so its whole unit suite invokes it directly in the repo's
// `node` vitest env with no DOM.
//
// ONE CONFIG, FOUR FIELDS (D-04). A label's words, colour, width and depth travel in ONE
// `MachineConfig::Label`, so one Apply is one edit record and one undo step. This body edits
// the words; every change hands back the WHOLE config with the colour and the size passed
// through at the values it was given, so the Text field can never reset a colour or a size
// the user did not touch. Plan 76-03 adds the six colour swatches and the width and depth
// steppers below it (76-UI-SPEC 5.1 order: Text, Colour, Size); each hands back the whole
// config the same way, so a swatch can never reset words and a stepper never a colour.
//
// The board shows the COMMITTED words only (76-UI-SPEC U-7): nothing typed here reaches the
// board until Apply lands.
//
// Skin, not skeleton: the field is the shipped `.fab-field` inset well on the Martian Mono
// body tokens, every colour is a `--fab-*` token, and no new spacing value is minted.

import type { CSSProperties, JSX } from 'react';
import type { MachineConfig } from '../protocol/decode.ts';
import { LABEL_COLOURS } from '../render/synth/skin.ts';

/** The label config this body edits: the `Label` member of the wire union. */
export type LabelConfig = Extract<MachineConfig, { kind: 'Label' }>;

/**
 * The longest a label's words may be, in UTF-8 BYTES (SHAPE-13, D-06).
 *
 * # THE ONE TypeScript MIRROR, AND IT IS LOCKED
 * The authority is `fabrico_core::edit::MAX_LABEL_BYTES`, read by the `Configure` write
 * gate (which refuses one byte over and accepts exactly the bound) and, from plan 76-04, by
 * the decode, restore and load gates. This is the only copy of that number on this side of
 * the language boundary: `crates/fabrico-command/tests/ts_label_mirror.rs` `include_str!`s
 * THIS FILE, extracts the literal by the anchor below, asserts it equals the Rust constant,
 * asserts no other frontend file declares it, and PANICS if it cannot find the anchor, so a
 * rename here is a red rather than a green that measured nothing.
 *
 * # NEVER RESTATED AS A NUMERAL
 * The over-length sentence states the OVERAGE, computed from this value, and the bound
 * itself appears in no user-facing string (the lock checks every non-comment line). A
 * restated figure would be a second source of truth (`68-UI-SPEC` FINDING 1).
 *
 * # NO `maxLength` ON THE FIELD
 * `maxLength` counts UTF-16 code units, not bytes, and a label allows any Unicode, so it
 * would be wrong in both directions. Nothing is clamped or cut on the way in: a text the
 * engine would refuse is refused here with a sentence saying by how much, and Apply waits.
 */
export const MAX_LABEL_BYTES = 512;

/**
 * The widest and deepest a label may be made from its panel, in cells (SHAPE-12, D-04,
 * 76-UI-SPEC U-2: 16 by 8 holds the whole text at width 16).
 *
 * # THE ONE TypeScript MIRROR OF EACH, AND THEY ARE LOCKED
 * The authority is `fabrico_command::LABEL_MAX_W` / `LABEL_MAX_H`, the write-side policy
 * the `Configure` gate reads (a size outside it is `OverLimit`, `Malformed` until plan 88-02). These are the only copies
 * on this side of the language boundary: `crates/fabrico-command/tests/ts_label_mirror.rs`
 * `the_size_caps_are_mirrored_once` extracts each literal by its anchor, asserts it equals
 * the Rust constant and that no other frontend file declares it, and PANICS on a missing
 * anchor. The steppers' plus buttons disable at these values, so a drift would either
 * strand a user one press short of a size the engine accepts or offer one it refuses.
 *
 * # NEVER TYPED IN COPY
 * The size hint is BUILT from these ({@link LABEL_SIZE_HINT}); the lock fails on a code
 * line that types either figure next to its unit.
 */
export const LABEL_MAX_W = 16;
export const LABEL_MAX_H = 8;

/** The size hint (76-UI-SPEC Copywriting Contract), built from the two caps. */
export const LABEL_SIZE_HINT = `In cells. Up to ${LABEL_MAX_W} wide and ${LABEL_MAX_H} deep.`;

/** The smallest a label may be, in cells, on either axis (76-UI-SPEC U-2 floor). */
const LABEL_MIN_DIM = 1;

/** The six colour names as the user reads them, in byte order: `sand` -> `Sand`. */
export const LABEL_COLOUR_NAMES: readonly string[] = LABEL_COLOURS.map(
  (c) => c.charAt(0).toUpperCase() + c.slice(1),
);

/** The name of colour byte `b`, or Sand (the default the host mints) for an unknown byte. */
export function labelColourName(b: number): string {
  return LABEL_COLOUR_NAMES[b] ?? LABEL_COLOUR_NAMES[0];
}

const UTF8 = new TextEncoder();

/** The UTF-8 byte length of `s`. */
function utf8Bytes(s: string): number {
  return UTF8.encode(s).length;
}

/**
 * How many characters (Unicode code points) must be removed FROM THE END of `text` for
 * its UTF-8 length to fit {@link MAX_LABEL_BYTES}; 0 when it already fits.
 *
 * Exact by construction (76-UI-SPEC 5.5): it removes code points one at a time from the
 * end until the bytes fit, so the number the user reads is the number of characters they
 * must delete, whatever the characters are. For ASCII it equals the byte overage; for a
 * three-byte character one past the bound it is 1, not 3.
 */
export function labelTextOverage(text: string): number {
  let bytes = utf8Bytes(text);
  if (bytes <= MAX_LABEL_BYTES) return 0;
  const points = Array.from(text);
  let removed = 0;
  while (bytes > MAX_LABEL_BYTES && points.length > 0) {
    bytes -= utf8Bytes(points.pop() as string);
    removed += 1;
  }
  return removed;
}

/** The over-length sentence (76-UI-SPEC Copywriting Contract), singular at 1. */
export function labelTextMessage(over: number): string {
  return `That text is too long by ${over} character${over === 1 ? '' : 's'}.`;
}

/**
 * Can a `Configure` for this config be dispatched? `true` for every non-Label config (the
 * `routePathDispatchable` shape), so the panel's Apply gate stays one conjunction over the
 * same argument. A courtesy: the core refuses an over-long text independently.
 */
export function labelTextDispatchable(config: MachineConfig | null): boolean {
  if (config === null || config.kind !== 'Label') return true;
  return labelTextOverage(config.text) === 0;
}

/** The over-length sentence for a config, or `null`. `null` for every non-Label kind. */
export function labelTextError(config: MachineConfig | null): string | null {
  if (config === null || config.kind !== 'Label') return null;
  const over = labelTextOverage(config.text);
  return over === 0 ? null : labelTextMessage(over);
}

const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** The Text field's DOM id, exported so the panel can focus it on placement and the tests
 *  can bind to it. */
export const LABEL_TEXT_FIELD_ID = 'fab-label-text';
const LABEL_TEXT_HINT_ID = 'fab-label-text-hint';
const LABEL_COLOUR_LABEL_ID = 'fab-label-colour-label';
/** The chosen colour's name beside `Colour`; the live spec reads it by this id. */
const LABEL_COLOUR_NAME_ID = 'fab-label-colour-name';
const LABEL_SIZE_LABEL_ID = 'fab-label-size-label';
const LABEL_SIZE_HINT_ID = 'fab-label-size-hint';

/** The Text hint (76-UI-SPEC Copywriting Contract), bound to the field by
 *  `aria-describedby` so the constraint is announced before a mistake. */
export const LABEL_TEXT_HINT = 'Shown on the board. Lines wrap to fit the label.';

export interface LabelConfigBodyProps {
  /** The in-progress label config buffer: words, colour byte, width and depth. */
  config: LabelConfig;
  /** Hands back the WHOLE config: the new words, the rest passed through unchanged. */
  onChange: (config: LabelConfig) => void;
}

/** A group: a label above its content, sm apart (76-UI-SPEC spacing). */
const GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--fab-space-sm)',
};

/** The 24 by 24 colour chip inside a swatch. */
function chipStyle(name: string): CSSProperties {
  return {
    display: 'block',
    width: 24,
    height: 24,
    boxSizing: 'border-box',
    background: `var(--fab-label-${name})`,
    border: '1px solid var(--fab-outline)',
  };
}

/** The readout between a stepper's buttons: 48 by 44, centred, tabular figures. */
const READOUT_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 48,
  height: 'var(--fab-min-target)',
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fab-ink)',
};

interface StepperProps {
  /** `Width` or `Depth`: the visible label, and the noun in the buttons' names. */
  label: string;
  /** The `<output>` id the buttons are described by. */
  id: string;
  value: number;
  max: number;
  onStep: (next: number) => void;
}

/**
 * One stepper (76-UI-SPEC 5.3): `[ - ] [ n ] [ + ]`, sm gaps. The minus is U+2212 MINUS
 * SIGN, whose advance matches `+` in Martian Mono so the two buttons are one width. Minus
 * disables at 1, plus at the cap. Each press changes the panel's buffer by one cell;
 * nothing is sent until Apply. A plain function CALLED by the body rather than mounted as a
 * component, so the body's descriptor tree holds its buttons and the node-env unit suite
 * can walk them without a DOM.
 */
function stepper({ label, id, value, max, onStep }: StepperProps): JSX.Element {
  const noun = label.toLowerCase();
  const labelId = `${id}-label`;
  return (
    <div role="group" aria-labelledby={labelId} style={GROUP_STYLE}>
      <span id={labelId} style={LABEL_STYLE}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--fab-space-sm)' }}>
        <button
          type="button"
          className="fab-tool-btn"
          aria-label={`Decrease ${noun}`}
          aria-describedby={id}
          disabled={value <= LABEL_MIN_DIM}
          onClick={() => onStep(value - 1)}
        >
          −
        </button>
        <output id={id} style={READOUT_STYLE}>
          {value}
        </output>
        <button
          type="button"
          className="fab-tool-btn"
          aria-label={`Increase ${noun}`}
          aria-describedby={id}
          disabled={value >= max}
          onClick={() => onStep(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * The label card's body: Text, Colour, Size, in that order (76-UI-SPEC 5.1).
 *
 * TEXT, the focal point, full content width, first after the heading. A `textarea`,
 * because a note can run to several lines and the user's line breaks are kept on the
 * board (`white-space: pre-wrap`). Three rows and `min-height: 88px` (two touch targets),
 * resizable vertically only, so the panel's width never moves. No `maxLength`: see
 * {@link MAX_LABEL_BYTES}. An over-long text is reported by the panel's shipped error row
 * ({@link labelTextError}) and holds Apply back ({@link labelTextDispatchable}).
 *
 * COLOUR (76-UI-SPEC 5.2): the label `Colour`, an xs gap, the chosen colour's name (so
 * colour is never the only cue for which one is chosen), then six `.fab-swatch` buttons in
 * byte order, each named and titled by its colour, the chosen one `aria-pressed` with the
 * pressed bevel. The chip reads its `--fab-label-*` token; no hex is written here.
 *
 * SIZE (76-UI-SPEC 5.3): `Width` and `Depth` steppers side by side, md apart, wrapping
 * below 338 px, and the hint built from the caps.
 */
export function LabelConfigBody({ config, onChange }: LabelConfigBodyProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-md)' }}>
      <div style={GROUP_STYLE}>
        <label htmlFor={LABEL_TEXT_FIELD_ID} style={LABEL_STYLE}>
          Text
        </label>
        <textarea
          id={LABEL_TEXT_FIELD_ID}
          className="fab-field"
          rows={3}
          value={config.text}
          onChange={(e) => onChange({ ...config, text: e.currentTarget.value })}
          aria-describedby={LABEL_TEXT_HINT_ID}
          style={{
            width: '100%',
            minHeight: 88,
            resize: 'vertical',
            boxSizing: 'border-box',
            padding: 'var(--fab-space-sm)',
            fontFamily: 'var(--fab-font)',
            fontSize: 'var(--fab-font-size-base)',
            lineHeight: 1.4,
          }}
        />
        <p id={LABEL_TEXT_HINT_ID} style={{ margin: 0, ...LABEL_STYLE, lineHeight: 1.3 }}>
          {LABEL_TEXT_HINT}
        </p>
      </div>
      <div style={GROUP_STYLE}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--fab-space-xs)' }}>
          <span id={LABEL_COLOUR_LABEL_ID} style={LABEL_STYLE}>
            Colour
          </span>
          <span id={LABEL_COLOUR_NAME_ID} style={LABEL_STYLE}>
            {labelColourName(config.colour)}
          </span>
        </div>
        <div
          role="group"
          aria-labelledby={LABEL_COLOUR_LABEL_ID}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--fab-space-sm)' }}
        >
          {LABEL_COLOURS.map((name, b) => {
            const chosen = b === config.colour;
            const shown = LABEL_COLOUR_NAMES[b];
            return (
              <button
                key={name}
                type="button"
                className={chosen ? 'fab-swatch is-pressed' : 'fab-swatch'}
                aria-label={shown}
                title={shown}
                aria-pressed={chosen}
                onClick={() => onChange({ ...config, colour: b })}
              >
                <span aria-hidden="true" style={chipStyle(name)} />
              </button>
            );
          })}
        </div>
      </div>
      <div role="group" aria-labelledby={LABEL_SIZE_LABEL_ID} style={GROUP_STYLE}>
        <span id={LABEL_SIZE_LABEL_ID} style={LABEL_STYLE}>
          Size
        </span>
        <div
          aria-describedby={LABEL_SIZE_HINT_ID}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--fab-space-md)' }}
        >
          {stepper({
            label: 'Width',
            id: 'fab-label-width',
            value: config.w,
            max: LABEL_MAX_W,
            onStep: (w) => onChange({ ...config, w }),
          })}
          {stepper({
            label: 'Depth',
            id: 'fab-label-depth',
            value: config.h,
            max: LABEL_MAX_H,
            onStep: (h) => onChange({ ...config, h }),
          })}
        </div>
        <p id={LABEL_SIZE_HINT_ID} style={{ margin: 0, ...LABEL_STYLE, lineHeight: 1.3 }}>
          {LABEL_SIZE_HINT}
        </p>
      </div>
    </div>
  );
}
