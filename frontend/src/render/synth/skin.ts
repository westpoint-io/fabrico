// The Skin schema (SYNTH-04): the ONLY styling input the renderer consumes. A
// skin is pure data - a palette ramp, role accents, and a set of NUMERIC vector
// axes measured in `u` on the 32u authoring grid. `validate` is a hand-rolled
// guard (no zod, no new dep): one cheap integer/range/ordering/length check per
// axis, each throwing a named Error before a single machine is drawn. This
// supersedes theme.ts (deleted in Phase 25); theme.ts is read-only reference
// here, never imported or extended.
//
// VECTOR-NATIVE SINCE PLAN 58-05 (SKIN-01). The schema used to carry four
// DISCRETE PIXEL-ERA STYLE AXES - a raised-ring depth in px, two enum style names
// for the bezel corner and the inner definition outline, and a glyph-font enum -
// because every machine was a baked PixelMatrix box. Machines are vector now
// (`render/layers/machineChassis.ts` draws a parametric 4u-inset rectangle and the
// `.svg` carries the glyph), so those four axes described a body that no longer
// exists. They were DELETED rather than retained as dead enum values: an axis with
// one legal value that nothing on the shipped path reads is the trap SKIN-01
// forbids. A styling knob lives here only if a skin could meaningfully vary it.
//
// CORRECTED 2026-08-11 (v7.0 milestone audit, W-2). This paragraph used to end by
// sending the reader to "the surviving legacy PIXEL bakes - the chrome bezel and
// the belt tread, both owned by later phases", which "carry their own named
// constants in `generators.ts`". PLAN 61-07 DELETED BOTH, so that sentence sent a
// reader looking for two shipped pixel bakes that no longer exist. What actually
// survives in `generators.ts` is the HISTORICAL ART-BOARD PAINTER: `makeGenerators`
// has exactly one non-test consumer left, the art board's slate module in `src/spike/`,
// which renders the Phase 57 art board's pinned TODAY pixel column through the
// resampler that originally produced it. `spike/` is developer tooling, not the canvas
// render path, so VEC-01 does not reach it. Nothing in that module draws to the board any
// more, and the band thicknesses the deleted constants held are now inline literals
// at that one call site.

/** Accent roles - one semantic job each (mirrors the theme.ts accent motif). */
export type AccentRole = 'working' | 'fault' | 'item' | 'build' | 'electric';

// Grown by exactly ONE value in Phase 54 per the 53-BELT-LOCK.md obligation:
// 'centre-dash' is the locked belt tread (10/6 centreline dash). 'chevron' stays a
// LEGAL enum value that the ONE shipped skin does not use. SKIN-01 (plan 58-05)
// deliberately left this axis ALONE while it deleted the other four: belt art is
// out of Phase 58's scope by the maintainers' call (53-BELT-LOCK.md governs belts and the art
// lock names no BELT axis), and PHASE 61 owns its fate. treadPattern is
// declarative/validation-only: no paint dispatch reads it, and it must stay that way.
const TREAD_PATTERNS = ['chevron', 'centre-dash'] as const;
const ACCENT_ROLES: readonly AccentRole[] = ['working', 'fault', 'item', 'build', 'electric'];

export type TreadPattern = (typeof TREAD_PATTERNS)[number];

/**
 * The label palette's colour names, in BYTE ORDER (phase 76, D-05, UI-SPEC 3.1). Index `b`
 * is the colour a label carrying colour byte `b` is drawn in; byte 0, Sand, is the default.
 * This order is the Rust `LabelColour` variant order, locked by
 * `crates/fabrico-command/tests/ts_label_mirror.rs` (which parses this declaration, so it
 * stays a single-quoted literal array on one line). The set is CLOSED: none of these is a
 * state colour, because a label has no state.
 */
export const LABEL_COLOURS = ['sand', 'stone', 'moss', 'lilac', 'rose', 'clay'] as const;

/** One label colour name. */
export type LabelColourName = (typeof LABEL_COLOURS)[number];

/**
 * A complete, self-contained styling definition. `ramp` is an ordered array of
 * 0xRRGGBB steps from darkest (index 0) to lightest (last), length >= 3; the
 * vector chassis reads its ink from that array by FIXED index (SYNTH-05), never by
 * brightness multiply, and the historical art-board painter in `generators.ts`
 * resolves its light/shadow the same way. (Also corrected 2026-08-11, W-2: this
 * sentence named "the surviving legacy bezel bake" as the fixed-index reader, and
 * plan 61-07 deleted it. The DISCIPLINE is unchanged and is the point of the
 * sentence - a fixed index, never a multiply - only its subject moved.)
 */
export interface Skin {
  id: string;
  palette: {
    ramp: number[];
    accents: Record<AccentRole, number>;
    /**
     * The label palette (phase 76, D-05): the six box tints a user picks from, keyed by
     * {@link LABEL_COLOURS}. ADDITIVE: no ramp or accent value moved to make room, and
     * none of these equals an accent (`skin.test.ts` asserts it), so a label never reads
     * as a machine state. Used by the label box on the board and the panel swatches,
     * nothing else.
     */
    labels: Record<LabelColourName, number>;
    /**
     * The resting cable's stroke (phase 92, D-10, UI-SPEC 4.2): a muted electric teal the
     * wire layer strokes at alpha 1 at every zoom. ADDITIVE, like {@link labels}: no ramp or
     * accent value moved to make room. It is not `accents.electric` (the terminals and the
     * request spark) nor `accents.build` (the re-route mark), so the cable reads apart from
     * both, and it reads apart from the grid lines by contrast (`wires.test.ts` grades it
     * from the skin). Canvas only: no CSS custom property carries it.
     */
    cable: number;
  };
  /**
   * The chassis outline weight, and nothing else. INTEGER IN `u` ON THE 32u GRID,
   * converted at render (`u * CELL / 32`) - never px on the interface, because `u`
   * is the unit `57-ART-LOCK.md` is written in and re-expressing it in px would make
   * the schema and the lock disagree about what a number means.
   * Transcribes lock AXIS 2 (stroke weights: only 2u and 3u appear; a third weight
   * is not legal art, which is why nothing here invents a third axis for one).
   */
  strokeStructural: number;
  /**
   * Every glyph stroke - the detail floor. INTEGER IN `u` ON THE 32u GRID, converted
   * at render. Strictly lighter than {@link Skin.strokeStructural}: the two-weight
   * hierarchy is the whole readability system, so `validate` refuses an inversion.
   * Transcribes lock AXIS 2 and AXIS 8 (the detail floor below which a form is
   * substituted rather than drawn thinner).
   */
  strokeDetail: number;
  /**
   * Corner rounding on the chassis. INTEGER IN `u` ON THE 32u GRID, converted at
   * render. Transcribes lock AXIS 5, which locks a RADIUS ("radius 0, square, 0 curve
   * commands") rather than a style name - so the schema carries the number the lock
   * actually locked.
   */
  cornerRadius: number;
  /**
   * Drop-shadow displacement on any part. INTEGER IN `u` ON THE 32u GRID, converted
   * at render. Transcribes lock AXIS 7 (no shadow authored on any part).
   */
  shadowOffset: number;
  /**
   * The MAXIMUM number of filled parts a single machine asset may carry - a CEILING,
   * not a target, and the docblock says so because "1" read as a target would push
   * every subject toward exactly one fill. INTEGER IN `u`-grid terms only in the
   * sense that it is a whole count; it is a part budget, not a length.
   * Transcribes lock AXIS 6.
   */
  fillCeiling: number;
  treadPattern: TreadPattern;
}

function isColorInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff;
}

/**
 * Narrow an untrusted skin-shaped value to `Skin`, throwing a named Error on the
 * first malformed axis. Pure and total: no Math.random, no Date.now, no
 * object-key iteration order dependence (accent roles are checked in a fixed list).
 */
export function validate(s: Skin): asserts s is Skin {
  if (typeof s.id !== 'string' || s.id.length === 0) {
    throw new Error('skin.id: required (non-empty string)');
  }

  const ramp = s.palette?.ramp;
  if (!Array.isArray(ramp) || ramp.length < 3) {
    throw new Error('skin.palette.ramp: needs >=3 steps (darkest..lightest)');
  }
  for (let i = 0; i < ramp.length; i++) {
    if (!isColorInt(ramp[i])) {
      throw new Error(`skin.palette.ramp: step ${i} must be an integer 0x000000..0xffffff`);
    }
  }

  const accents = s.palette?.accents;
  if (accents == null || typeof accents !== 'object') {
    throw new Error('skin.palette.accents: required object of role->color');
  }
  for (const role of ACCENT_ROLES) {
    if (!isColorInt(accents[role])) {
      throw new Error(`skin.palette.accents: role '${role}' must be an integer color`);
    }
  }

  // The label palette (phase 76), checked exactly like the accents: one named Error per
  // missing or non-integer entry, in the fixed LABEL_COLOURS order.
  const labels = s.palette?.labels;
  if (labels == null || typeof labels !== 'object') {
    throw new Error('skin.palette.labels: required object of label colour->color');
  }
  for (const name of LABEL_COLOURS) {
    if (!isColorInt(labels[name])) {
      throw new Error(`skin.palette.labels: colour '${name}' must be an integer color`);
    }
  }

  // The resting cable's colour (phase 92, D-10), one named Error like the entries above.
  if (!isColorInt(s.palette?.cable)) {
    throw new Error('skin.palette.cable: required colour int');
  }

  // The five vector axes (SKIN-01), each transcribing a numbered cell of
  // 57-ART-LOCK.md. One cheap check per axis, in the hand-rolled style above: a bad
  // edit throws a named Error at the first import rather than painting a malformed
  // machine. Every message keeps the `skin.<field>: ` prefix so the regex style
  // `skin.test.ts` uses still applies.
  if (!Number.isInteger(s.strokeStructural) || s.strokeStructural < 1) {
    throw new Error('skin.strokeStructural: must be a positive integer (u on the 32u grid)');
  }
  if (!Number.isInteger(s.strokeDetail) || s.strokeDetail < 1) {
    throw new Error('skin.strokeDetail: must be a positive integer (u on the 32u grid)');
  }
  // The ORDERING, not just the two magnitudes. A detail stroke at or above the
  // structural weight collapses the two-weight hierarchy that carries the whole
  // chassis-vs-glyph reading (lock axis 2), and it does so while both numbers are
  // individually legal - which is exactly the edit a per-field range check misses.
  if (s.strokeDetail >= s.strokeStructural) {
    throw new Error(
      `skin.strokeDetail: must be lighter than strokeStructural ` +
        `(got detail ${s.strokeDetail} >= structural ${s.strokeStructural})`,
    );
  }
  if (!Number.isInteger(s.cornerRadius) || s.cornerRadius < 0) {
    throw new Error('skin.cornerRadius: must be an integer >= 0 (u on the 32u grid)');
  }
  if (!Number.isInteger(s.shadowOffset) || s.shadowOffset < 0) {
    throw new Error('skin.shadowOffset: must be an integer >= 0 (u on the 32u grid)');
  }
  if (!Number.isInteger(s.fillCeiling) || s.fillCeiling < 0) {
    throw new Error('skin.fillCeiling: must be an integer >= 0 (a MAXIMUM part count)');
  }

  if (!(TREAD_PATTERNS as readonly string[]).includes(s.treadPattern)) {
    throw new Error(`skin.treadPattern: must be one of ${TREAD_PATTERNS.join('|')}`);
  }
}
