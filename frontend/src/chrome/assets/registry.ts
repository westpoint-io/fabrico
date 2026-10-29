// The CHROME asset registry (CHROME-01, plan 59-01): authored `.svg` files in, raw
// authored TEXT out, with a named throw on an unknown name.
//
// It mirrors `render/svgAssets.ts` deliberately and closely - same literal `?raw` table,
// same `keyof typeof` name type, same accessor with a named unknown-name throw - so a
// reader who knows one knows the other. Two differences, both of them decisions:
//
//   1. THERE IS NO MEMO HERE, AND THE MEMO THIS MODULE ONCE CARRIED WAS DEAD OUTPUT.
//      The superseded claim, quoted rather than deleted: "THE MEMO CACHES A PARSED PART
//      LIST, NOT A `GraphicsContext` ... what the memo buys is that N icons of the same
//      asset on one screen pay ONE text parse at module scope rather than one per
//      render." The mechanism was real and the beneficiary never existed: grepped over
//      `frontend/src`, the only occurrence of `getChromeAssetParts` was its own
//      declaration, so the `PARTS` map was allocated and never written. `icons.tsx`
//      reads `getChromeAssetSource` and builds its own EAGER `CHROME_GLYPHS` table of
//      built ELEMENTS - a strictly stronger memo than a parts list, since it also
//      carries the 32u author-box refusal - and `LogoMark.tsx` read the source
//      directly (that component was retired on 2026-10-11; see the `logomark` row note
//      below). Deleted in the phase-59 review rather than left dormant, which is this
//      phase's own stated standard (59-02 deleted the eleven bit matrices and
//      `SpriteIcon` on it). What survives is what the module actually is: a `?raw`
//      source table.
//
//      The Pixi half of that paragraph is still true and is why no memo was
//      REINSTATED with a caller: nothing in this directory ever reaches Pixi, and it
//      CANNOT - `currentColor` is not a value Pixi's `Color` can convert
//      (`new GraphicsContext().svg()` throws "Unable to convert color currentColor" on
//      every file here). There is no tessellation to share and no 400-vertex batching
//      cliff to stay under. No `pixi.js` import appears in this file and none should.
//   2. `ChromeAssetName` IS A SEPARATE KEYSPACE FROM `AssetName`, and the two are never
//      unified. `machines.ts`'s header warns at length that the matching count of 8
//      between `SUBJECT_OF` and `GEN_KEY_OF` is a TRAP; `SUBJECT_OF` indexes
//      `AssetName`, so folding a chrome name into it would put a non-subject into the
//      keyspace every machine-only art gate walks (`colourVision.test.ts`,
//      `shapeDistinctness.test.ts`, `shippedAssets.test.ts`) and force each of them to
//      special-case. Chrome glyphs are not art-lock subjects.
//
// The table is a LITERAL, never `import.meta.glob`: globs resolve only under Vite, and
// this module is also loaded by vitest under bare node. A new asset means a new row here
// AND a hand edit to the two stated count pins in `lintSvg.test.ts` and
// `vertexBudget.test.ts` - which is exactly the moment a human should be looking.

import BELT_SVG_RAW from './belt.svg?raw';
import FIT_SVG_RAW from './fit.svg?raw';
import LABEL_SVG_RAW from './label.svg?raw';
import LOAD_SVG_RAW from './load.svg?raw';
import LOGOMARK_SVG_RAW from './logomark.svg?raw';
import NEW_SVG_RAW from './new.svg?raw';
import PAUSE_SVG_RAW from './pause.svg?raw';
import PLAY_SVG_RAW from './play.svg?raw';
import REDO_SVG_RAW from './redo.svg?raw';
import SAVE_SVG_RAW from './save.svg?raw';
import STEP_SVG_RAW from './step.svg?raw';
import TRASH_SVG_RAW from './trash.svg?raw';
import UNDO_SVG_RAW from './undo.svg?raw';
import WARNING_SVG_RAW from './warning.svg?raw';
import WIRE_SVG_RAW from './wire.svg?raw';

/**
 * Every chrome-only vector asset, by name. FIFTEEN ROWS as of plan 91-03 (the Graphics
 * trigger's fader glyph deleted with the Graphics panel, CHROME-03, both count pins moved
 * 16 -> 15 BY HAND in the same commit). SIXTEEN ROWS as of phase 76 (plan 76-01 adds
 * `label`, the Palette Label row's glyph, and moves both count pins 15 -> 16 BY HAND in the
 * same commit). FIFTEEN ROWS as of plan 66-01.
 *
 * Plan 59-01 seeded this with the single `belt` row (the tracer). Plan 59-02 authored the
 * other twelve and added them here in the same commit that raises the two stated count
 * pins in `lintSvg.test.ts` and `vertexBudget.test.ts` from 1 to 13. Plan 61-06 added the
 * Graphics settings trigger glyph, the first new chrome asset in two milestones, and moved
 * both pins 13 -> 14 BY HAND in the same commit, which is the discipline the header
 * paragraph above describes (plan 91-03 removed it again, the same way). Plan 66-01 adds `wire` - the glyph
 * for the Palette's Wire tool, which is that tool's only consumer - and moves both pins
 * 14 -> 15 BY HAND in the same commit, on the same discipline. Note that
 * `vertexBudget.test.ts` reads its copy of the pin at TWO assertion sites, so one
 * constant edit there clears two gates.
 *
 * `logomark` is the one row NOT RENDERED IN THE APP, and the row stays for its geometry.
 * The square is the reference the installer icons are held to: `scripts/build-icons.ts`
 * carries a hand transcription of its three layers (and `iconCuts.test.ts` proves the
 * generator never reads this file, which is what keeps the next check independent), and
 * `chrome/iconMasterParity.test.ts` pins the icon master to this file d string for d string.
 * `scripts/mark-craft.ts` (`SHIPPED_MARK`) measures it for the icon raster and erasure pins
 * and the mark sheet. Through THIS accessor its only reader is `Toolbar.test.tsx`, which uses
 * the square's d strings to prove the header never draws it. The component that drew it,
 * `chrome/LogoMark.tsx`, was retired on 2026-10-11: since MARK-17 (phase 80.1) the header
 * renders `HeaderLockup` instead. Registration is what keeps the file under both shared
 * walkers and `lint:svg`'s rules (zero hex, viewBox, dialect). `lint:svg` has no accent rule;
 * the square's one-accent rule (MARK-02) lives in `chrome/iconMasterParity.test.ts`.
 *
 * SUPERSEDED, QUOTED RATHER THAN DELETED. This note used to read: "`logomark` is the one row
 * with no consumer yet: the artwork is authored in 59-02 and `chrome/LogoMark.tsx` starts
 * reading it in 59-04. It is registered HERE rather than in 59-04 because registration is
 * what puts it under both shared walkers, and an asset committed a plan before its gate is
 * an asset that ships unmeasured for a plan."
 */
export const CHROME_ASSET_SOURCES = {
  belt: BELT_SVG_RAW,
  fit: FIT_SVG_RAW,
  label: LABEL_SVG_RAW,
  load: LOAD_SVG_RAW,
  logomark: LOGOMARK_SVG_RAW,
  new: NEW_SVG_RAW,
  pause: PAUSE_SVG_RAW,
  play: PLAY_SVG_RAW,
  redo: REDO_SVG_RAW,
  save: SAVE_SVG_RAW,
  step: STEP_SVG_RAW,
  trash: TRASH_SVG_RAW,
  undo: UNDO_SVG_RAW,
  warning: WARNING_SVG_RAW,
  wire: WIRE_SVG_RAW,
} as const;

/** The name of an authored chrome-only vector asset. */
export type ChromeAssetName = keyof typeof CHROME_ASSET_SOURCES;

/**
 * The raw authored TEXT of one chrome asset.
 *
 * TWO NETS FOR AN UNKNOWN NAME, the `svgAssets.ts:85-105` pattern. Net 1 is the
 * SIGNATURE: `ChromeAssetName` is `keyof typeof CHROME_ASSET_SOURCES`, so from a
 * type-checked call site a typo is a compile error. Net 2 is the throw below, kept for
 * the callers a signature cannot reach - a name arriving through a cast or a widened
 * `Record` lookup. Without it the lookup is `undefined`, the parse throws something
 * anonymous or (worse) some future caller renders an EMPTY `<svg>`, and the symptom is a
 * blank icon with no error anywhere.
 */
export function getChromeAssetSource(name: ChromeAssetName): string {
  const source = CHROME_ASSET_SOURCES[name];
  if (source === undefined) {
    throw new Error(
      `chrome/assets/registry: unknown chrome asset '${name}' ` +
        `(known: ${Object.keys(CHROME_ASSET_SOURCES).join('|')})`,
    );
  }
  return source;
}
