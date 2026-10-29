// build-icons.ts - the generator for the Fabrico installer icon set (MARK-06, MARK-05, MARK-07,
// ICON-03, ICON-04, ICON-05, ICON-06, plans 81-01, 81-02 and 81-04).
//
// WHAT THIS EMITS. Thirteen artefacts, and nothing else, all of them declared in `ICON_OUTPUTS`:
// three SVG cuts under `docs/brand/`, and ten binaries under `crates/fabrico-app/icons/`.
//
//   1. `docs/brand/fabrico-icon-master.svg`, the LITERAL COLOUR master of the shipped mark: the
//      same three shapes as the token painted square in `frontend/src/chrome/assets/logomark.svg`
//      (no longer rendered in the app since 2026-10-11), painted in resolved hex instead of CSS
//      custom properties, on a full-bleed plate (D-08).
//   2. `docs/brand/fabrico-icon-16.svg`, the 16 unit OPTICAL CUT the operating system paints
//      below 24px. AUTHORED ON ITS OWN GRID, never resampled from the master (MARK-05, D-04).
//   3. `docs/brand/fabrico-icon-stencil.svg`, the monochrome stencil: one colour, no plate, and
//      a silhouette that carries a real hole (MARK-07, D-08).
//   4. The eight PNG rasters of the size ladder, `16x16.png` through `icon.png`, which is what
//      the Debian payload copies into the hicolor tree (ICON-05).
//   5. `crates/fabrico-app/icons/icon.ico`, the Windows container, 32x32 layer FIRST (ICON-06).
//   6. `crates/fabrico-app/icons/icon.icns`, the macOS container, which has never existed in
//      this repository before this plan (ICON-04).
//
// WHICH CUT FEEDS WHICH SIZE, AND IT IS A MEASUREMENT RATHER THAN A PREFERENCE. The 16 unit cut
// feeds 16 and 24; the master feeds 32 and everything above it. Counting pixels whose colour is
// not one of the drawing's own authored values, at plan 81-04's measurement: at 16px the master
// blends 8 of 256 and the small cut blends 0; at 24px the master blends 108 of 576 and the small
// cut blends 84; at 32 and 48 the master blends nothing at all, because every painted edge
// coordinate in it is even and even times 1.5 is a whole pixel at 48. The whole 24 pixel
// difference is the belt: the master's is a fill inside a stroke and carries an interior boundary
// that lands on quarter pixels, and the small cut's is a solid bar with no interior boundary at
// all. That is D-03's optical fix showing up as a number.
//
// `128x128@2x.png` AND `256x256.png` ARE BYTE-IDENTICAL ON PURPOSE. They are one 256 pixel render
// occupying two slots the bundler names differently, `256x256@2` and `256x256`. Do not "fix" one
// of them away.
//
// `icon.png` IS GENERATED AND IS DELIBERATELY NOT NAMED IN `bundle.icon`. It is `find_icon`'s
// hard-coded fallback path (`tauri-codegen-2.6.3/src/context.rs:233-241`), so deleting it would
// leave that fallback pointing at nothing; and listing it in the array would put a 512 pixel image
// in front of `.find()`, which on Linux is what picks the desktop window icon (D-13).
//
// THE TWO CONTAINERS ARE HAND-WRITTEN, IN NODE, WITH NO PACKAGE ADDED. Both are fixed-layout
// binary headers wrapping PNG payloads: an ICO is a 6-byte ICONDIR then one 16-byte ICONDIRENTRY
// per layer then the payloads; an ICNS is the magic `icns`, a big-endian total length, then
// `[OSType][length including the 8-byte header][payload]` chunks. `png2icns`, `libicns`,
// `icnsutil` and `icnsify` are none of them installed and none of them needed. A Rust-side crate
// would be worse: `Cargo.lock` is covered by the declared-moves gate and is explicitly
// NON-DECLARABLE, so a dependency added to build icons would trip the core-freeze gate for a job
// that has nothing to do with the core (D-14).
//
// WHAT THE ICNS DELIBERATELY OMITS, stated rather than implied. `tauri icon` additionally emits
// the legacy raw pairs `is32`+`s8mk` and `il32`+`l8mk`, which are RLE-encoded ARGB rather than
// PNG. They are not required by modern macOS and reproducing them means hand-rolling that
// encoder, so this generator emits PNG chunks only. NO macOS VALIDATED THIS FILE. None is
// reachable from the machine this was written on, and `magick` on that box has no ICNS decode
// delegate either, so the strongest available evidence is the structural round trip in
// `src/render/assets/iconContainers.test.ts` plus `file(1)`.
//
// ONE ENTRY POINT FOR ALL THIRTEEN, and that is a decision rather than a convenience. Plan 80.1
// recorded the trap this file must not repeat: two `import.meta.main` blocks in one module BOTH
// fire on the same bare `node` invocation (`build-header-cut.ts:8-14`, D-11). There is exactly one
// guard at the bottom of this file, `npm run build:icons` is its only key, and it produces the
// whole set or none of it.
//
// WHY THE 16 UNIT CUT IS A SEPARATE DRAWING AND NOT A RESAMPLE. What fails at 16px here is PAINT,
// not geometry. The master's belt is filled with the panel value and stroked with ink, so at 16px
// it renders as a 1px hollow outline with a dark interior and reads as a SECOND outlined rectangle
// competing with the cell frame. The optical fix is to fill the belt with ink and drop the stroke,
// which no downscale of the master can produce. That is MARK-05's whole text and the reason
// `tauri icon` cannot do this job. `src/render/assets/icon16Cut.test.ts` asserts the departure: the
// cell and the item ARE exact half scale and the belt provably is not, so a silent resample
// reddens rather than landing green.
//
// WHY A LITERAL COLOUR MASTER EXISTS AT ALL, measured rather than argued. usvg cannot parse
// `var(--fab-ink)`. It does not fail on it: it warns and falls back, to BLACK for a fill and
// to NO STROKE for a stroke. Rendering the token painted chrome square therefore produces a
// two colour image, transparent and opaque black, at 21.4844% ink coverage - a plausible
// number for a drawing that has silently lost both of its stroked layers. Feeding the chrome
// square to an icon pipeline writes a black square WITHOUT FAILING. That is the whole reason
// MARK-06 asks for a second cut, and it is why this generator paints in hex.
//
// THE FILE IS GENERATED AND NEVER HAND WRITTEN. A change to the artwork is a change to this
// script. Regenerate with `npm run build:icons`. `src/render/assets/iconCuts.test.ts` rebuilds
// the master in memory and compares byte for byte against the committed file, so a hand edit
// to the artefact and a drift in the generator both redden the unit suite rather than
// surviving to a release.
//
// THE PAINT VALUES ARE DERIVED, NEVER TRANSCRIBED. The four values this drawing uses are read
// out of `skinToCssVars(LOCKED_SKIN)` at generation time, by the tokens named fab-substrate,
// fab-panel-fill, fab-ink and fab-accent-item. TWO OF THE FOUR ARE NOT IN THE SKIN FILE AT
// ALL: they come through `bakeRamp`, so a constant table here would be a second declaration of
// the palette that drifts the first time a ramp step moves. No hex literal for any of the four
// appears anywhere in this file, comments included, and
// `src/render/assets/iconCuts.test.ts#transcribes no palette value` holds that by reading this
// file as TEXT and searching it for every hex the locked skin emits. That spec did not exist
// until 81-REVIEW.md WR-03: this sentence claimed a gate the tree did not carry, and a
// transcribed `--fab-ink` passed all 57 committed cases plus `npm run lint:svg`. The expected
// set is derived from the skin rather than listed there, so it follows the palette.
//
// THE GEOMETRY IS DECLARED HERE, AS THIS FILE'S OWN LITERALS, AND THAT IS THE POINT. The three
// `d` strings below are transcribed by hand from the shipped chrome square. This generator
// NEVER READS THAT FILE. If it did, the parity assertion in `iconCuts.test.ts` and
// `iconMasterParity.test.ts` would be comparing a file with its own source, which is the
// vacuous shape 81-VALIDATION.md names for criterion 1. Two independent declarations that an
// assertion can find in DISAGREEMENT is the only shape that proves anything; one declaration
// read twice proves nothing at all.
//
// THE RASTERISER IS PINNED AND MUST NOT BE MIXED. `@resvg/resvg-js` 2.6.2, the napi binding,
// wraps an older resvg core than the `/usr/bin/resvg` 0.48.1 CLI on a developer box, and the
// two produce DIFFERENT BYTES for the same source. Every PNG this script writes comes from the
// binding. Rendering one layer of the ladder with the CLI is a byte identity failure waiting
// for the next regeneration.
//
// NO PATH INPUT, EVER, following `build-lockup.ts`, `mark-craft.ts` and `lint-svg.ts`. Every
// path is resolved from `import.meta.url`. This module reads no argv and no cwd, so
// `node frontend/scripts/build-icons.ts` works from the repository root and from `frontend/`
// alike.
//
// THE BUILDER NEVER READS ITS OWN OUTPUT. `buildIconMaster()` does not reference
// `MASTER_PATH` at all; only `writeIcons()` and the gate do. A generator that read the
// committed file back and returned it would make the regenerate and compare gate pass on
// anything, which is this repository's signature defect class rather than a hypothetical.
//
// `ICON_OUTPUTS` IS A DECLARED ALLOWLIST, NOT DOCUMENTATION. It is the exact set of paths
// `writeIcons()` is permitted to write, and `iconCuts.test.ts` records every write through a
// mocked `node:fs` and asserts the recorded set equals it in BOTH directions. A generator that
// grew a fourth output would fail by name rather than quietly editing a tracked file.
//
// ERASURE-ONLY TYPESCRIPT. Node runs this file directly through native type stripping, which
// is erasure only: interfaces, type aliases, annotations and `import type` only, no enums, no
// namespaces, no parameter properties, an explicit `.ts` extension on every relative import.
// The contract is stated at `scripts/lint-svg.ts:29-34`.
//
// NO EM DASH (U+2014) ANYWHERE IN THIS FILE OR IN ANYTHING IT EMITS.

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

import { skinToCssVars } from '../src/render/synth/chrome/skinToCssVars.ts';
import { LOCKED_SKIN } from '../src/render/synth/skins/locked.ts';

/* ------------------------------------------------------------------ *
 * Paths. Resolved from import.meta.url, never from argv or cwd.
 * ------------------------------------------------------------------ */

/** The literal colour master. `buildIconMaster()` must never reference this. */
export const MASTER_PATH = fileURLToPath(
  new URL('../../docs/brand/fabrico-icon-master.svg', import.meta.url),
);

/** The 16 unit optical cut. `buildIcon16()` must never reference this. */
export const ICON_16_PATH = fileURLToPath(
  new URL('../../docs/brand/fabrico-icon-16.svg', import.meta.url),
);

/** The monochrome stencil. `buildIconStencil()` must never reference this. */
export const STENCIL_PATH = fileURLToPath(
  new URL('../../docs/brand/fabrico-icon-stencil.svg', import.meta.url),
);

/** One path under `crates/fabrico-app/icons/`, resolved the way every path here is. */
function iconPath(name: string): string {
  return fileURLToPath(new URL(`../../crates/fabrico-app/icons/${name}`, import.meta.url));
}

/** The 16 pixel layer, off the OPTICAL CUT. Nothing is blended in it (MARK-05, ICON-05). */
export const RASTER_16_PATH = iconPath('16x16.png');

/** The 24 pixel layer, off the OPTICAL CUT. See the header for the measurement that decided it. */
export const RASTER_24_PATH = iconPath('24x24.png');

/** The 32 pixel layer, off the master, which is exactly crisp at this size. */
export const RASTER_32_PATH = iconPath('32x32.png');

/** The 48 pixel layer, off the master, exactly crisp because 32 unit even edges land whole. */
export const RASTER_48_PATH = iconPath('48x48.png');

/** The 128 pixel layer. The first raster this generator ever wrote (plan 81-01). */
export const RASTER_128_PATH = iconPath('128x128.png');

/** The `256x256@2` slot. A 256 pixel render, byte-identical to `256x256.png` by design. */
export const RASTER_128_2X_PATH = iconPath('128x128@2x.png');

/** The `256x256` slot. The same 256 pixel render. See the header. */
export const RASTER_256_PATH = iconPath('256x256.png');

/** `find_icon`'s hard-coded fallback path. Generated, and NOT named in `bundle.icon` (D-13). */
export const RASTER_ICON_PATH = iconPath('icon.png');

/** The Windows container. Its layer at index 0 is the Windows default window icon (ICON-06). */
export const ICO_PATH = iconPath('icon.ico');

/** The macOS container. It has never existed in this repository before plan 81-04 (ICON-04). */
export const ICNS_PATH = iconPath('icon.icns');

/**
 * THE DECLARED WRITE SET. Every path `writeIcons()` is permitted to touch, and nothing else.
 *
 * Frozen so a later edit has to change this line rather than push onto it, and asserted from
 * the outside: `iconCuts.test.ts` intercepts `writeFileSync`, collects what `writeIcons()`
 * actually wrote, and compares the two sets in both directions. A path written but not
 * declared fails; a path declared but not written fails.
 */
export const ICON_OUTPUTS: readonly string[] = Object.freeze([
  MASTER_PATH,
  ICON_16_PATH,
  STENCIL_PATH,
  RASTER_16_PATH,
  RASTER_24_PATH,
  RASTER_32_PATH,
  RASTER_48_PATH,
  RASTER_128_PATH,
  RASTER_128_2X_PATH,
  RASTER_256_PATH,
  RASTER_ICON_PATH,
  ICO_PATH,
  ICNS_PATH,
]);

/* ------------------------------------------------------------------ *
 * The paint, derived from the locked skin at generation time.
 * ------------------------------------------------------------------ */

/**
 * `--fab-*` token name to resolved hex, baked from `LOCKED_SKIN` rather than transcribed.
 *
 * `skinToCssVars` emits one `--name:value;` declaration per line, which is the whole parse.
 * This is the same reader `mark-craft.ts:178-185` uses, deliberately: one idiom, one dialect.
 */
function tokenTable(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of skinToCssVars(LOCKED_SKIN).split('\n')) {
    const m = /^(--fab-[a-z0-9-]+):(#[0-9a-fA-F]{6});$/.exec(line.trim());
    if (m !== null) out.set(m[1] as string, (m[2] as string).toLowerCase());
  }
  return out;
}

/**
 * One token's resolved value, or a throw that names it.
 *
 * A missing token must be loud. Defaulting to a literal here would reintroduce exactly the
 * transcription this file refuses, and it would do it on the one code path nobody exercises.
 */
function paint(token: string): string {
  const table = tokenTable();
  const value = table.get(token);
  if (value === undefined) {
    throw new Error(
      `build-icons: skinToCssVars(LOCKED_SKIN) emitted no ${token}. The four paints of the ` +
        'icon master are DERIVED from the locked skin, never transcribed, so a renamed or ' +
        'removed token is a build failure rather than a stale colour. Emitted tokens: ' +
        `${[...table.keys()].join(' ')}`,
    );
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * The geometry. THIS FILE'S OWN LITERALS. See the header.
 * ------------------------------------------------------------------ */

/** The author box of the master, the same 32 unit box the shipped square is drawn on. */
const BOX = 32;

/**
 * The full bleed plate (D-08). An installer icon dropped into a light theme dock with a
 * transparent ground would show pale ink strokes on white and disappear; the plate is what
 * prevents that, and it is why the master is NOT bound by the no full bleed ground rule that
 * binds the in app symbol.
 */
const PLATE_D = `M 0 0 H ${BOX} V ${BOX} H 0 Z`;

/** The belt the mark stands on. Transcribed by hand; this file never reads the chrome square. */
const RAIL_D = 'M 3 23 H 29 V 29 H 3 Z';

/** The empty cell. Transcribed by hand. */
const CELL_D = 'M 9 3 H 23 V 17 H 9 Z';

/** The item inside the cell. Transcribed by hand. */
const ITEM_D = 'M 12 6 H 20 V 14 H 12 Z';

/** The stroke width the shipped square draws its two outlined layers at. */
const STROKE_W = '2';

/* ------------------------------------------------------------------ *
 * The 16 unit optical cut. A SECOND SET OF LITERALS, authored on its
 * own grid (MARK-05, D-03 option A, D-04).
 * ------------------------------------------------------------------ */

/** The author box of the optical cut. Sixteen units, one unit to one device pixel at 16px. */
const BOX_16 = 16;

/** The full bleed plate (D-08), the same ground the master carries. */
const PLATE_16_D = `M 0 0 H ${BOX_16} V ${BOX_16} H 0 Z`;

/**
 * The belt, and it is THE ONE DELIBERATE DEPARTURE FROM HALF SCALE.
 *
 * A SOLID INK BAR, filled and unstroked, three units tall. Half of the master's painted belt box
 * would be four units tall and would be a panel filled band inside an ink stroke; at 16px that
 * renders as a 1px hollow outline with a dark interior and reads as a second outlined rectangle
 * competing with the cell frame. Filling it with ink is the optical fix and it is the reason this
 * cut is authored rather than resampled. Do not restore a stroke here, and do not "correct" the
 * height to four: `src/render/assets/icon16Cut.test.ts` asserts the box is NOT half the master's.
 */
const RAIL_16_D = 'M 1 11 H 15 V 14 H 1 Z';

/**
 * The framed cell, drawn as a FILLED RING rather than as a stroked rectangle.
 *
 * Two subpaths: the outer contour, then the inner one WOUND IN REVERSE so the hole falls out of
 * the default nonzero fill rule. No `fill-rule` attribute anywhere in this file, on purpose:
 * `parseIconParts` throws on that attribute by name, and the winding buys the same picture for
 * nothing. Rendered both ways at 16px and at 256px the output is byte identical.
 *
 * Both boxes are EXACT half scale of the master's painted cell, which is what makes the belt's
 * departure legible as a decision rather than as drift.
 */
const CELL_16_D = 'M 4 1 H 12 V 9 H 4 Z M 5 2 V 8 H 11 V 2 Z';

/** The item inside the cell. Exact half scale of the master's item. */
const ITEM_16_D = 'M 6 3 H 10 V 7 H 6 Z';

/* ------------------------------------------------------------------ *
 * The document.
 * ------------------------------------------------------------------ */

/**
 * The provenance header, following `docs/brand/fabrico-lockup.svg`'s.
 *
 * NO DOUBLE HYPHEN AND NO TRAILING HYPHEN ANYWHERE IN IT. `comment-hyphen` in
 * `scripts/lint-svg.ts` refuses the WHOLE DOCUMENT on either, so a stray `--` here does not
 * produce a warning, it produces a red `npm run lint:svg`. That rule is also why the four
 * paint tokens are named below without their leading dashes.
 */
function provenanceHeader(): string[] {
  return [
    '<!--',
    '  docs/brand/fabrico-icon-master.svg - the LITERAL COLOUR master of the Fabrico mark',
    '  (MARK-06). The three shapes of the token painted square in',
    '  frontend/src/chrome/assets/logomark.svg (no longer rendered in the app since',
    '  2026-10-11), painted in resolved hex instead of CSS custom properties, on a full',
    '  bleed plate. This is the drawing every installer icon in the phase is cut from.',
    '',
    '  NOTHING IN THE APP IMPORTS IT: no component, no Vite input and no bundle reaches',
    '  docs/, so this drawing is a brand source rather than a shipped asset. It serves the',
    '  operating system only.',
    '',
    '  GENERATED FILE. Written by frontend/scripts/build-icons.ts and regenerated rather than',
    '  edited: run npm run build:icons. frontend/src/render/assets/iconCuts.test.ts rebuilds',
    '  it in memory and compares byte for byte, so a hand edit reddens the unit suite.',
    '',
    '  WHY IT IS A SEPARATE FILE FROM THE CHROME SQUARE, measured. usvg cannot parse a CSS',
    '  custom property. It does not fail on one: it warns and falls back, to black for a fill',
    '  and to NO STROKE for a stroke. So rasterising the token painted square yields two',
    '  colours, transparent and opaque black, and an ink coverage figure plausible enough to',
    '  read as a pass. An icon pipeline fed the token painted file writes a black square',
    '  without failing. This file exists so that cannot happen.',
    '',
    '  THE GEOMETRY IS PROVEN EQUAL, NOT ASSERTED. The rail, cell and item d strings here are',
    '  declared independently in the generator, and compared against the token painted square',
    '  in frontend/src/chrome/assets/logomark.svg, read from disk, by',
    '  frontend/src/chrome/iconMasterParity.test.ts. The generator never reads that file, so',
    '  the comparison is between two declarations rather than one read twice.',
    '',
    '  THE PAINT IS DERIVED, NOT TRANSCRIBED. The four values below are read out of',
    '  skinToCssVars(LOCKED_SKIN) at generation time, by the tokens fab-substrate,',
    '  fab-panel-fill, fab-ink and fab-accent-item. Two of the four are baked through bakeRamp',
    '  and are not in the skin file at all.',
    '',
    '  ART-04 PROVENANCE: authored from scratch, from the chosen Fabrico mark. No icon pack',
    '  was consulted, copied, traced or redrawn. Nothing here derives from game-icons.net',
    '  (CC-BY-3.0, which redrawing does not clear) or from Remix Icon, whose licence forbids',
    '  logo and trademark use by name.',
    '-->',
  ];
}

/** One flat self closing `<path>` line, in the dialect `parseIconParts` accepts. */
function pathLine(part: string, d: string, paintAttrs: string): string {
  return `  <path data-part="${part}" d="${d}" ${paintAttrs} />`;
}

/**
 * The master's SVG text.
 *
 * FOUR PATHS, in paint order plate, rail, cell, item. The chrome square has three; the plate
 * is the fourth and it is why the parity spec matches parts BY NAME rather than by index.
 *
 * No `fill-rule` anywhere: `parseIconParts` throws on it by name, and the master must be
 * readable by that parser because the parity gate reads it through it.
 *
 * Reads NOTHING. In particular it never reads `MASTER_PATH`, and never reads the chrome
 * square: a builder that read either would make a regenerate and compare gate pass on any file
 * at all.
 */
export function buildIconMaster(): string {
  const substrate = paint('--fab-substrate');
  const panelFill = paint('--fab-panel-fill');
  const ink = paint('--fab-ink');
  const item = paint('--fab-accent-item');

  const body = [
    pathLine('plate', PLATE_D, `fill="${substrate}"`),
    pathLine('rail', RAIL_D, `fill="${panelFill}" stroke="${ink}" stroke-width="${STROKE_W}"`),
    pathLine('cell', CELL_D, `fill="none" stroke="${ink}" stroke-width="${STROKE_W}"`),
    pathLine('item', ITEM_D, `fill="${item}"`),
  ];

  const lines = [
    ...provenanceHeader(),
    `<svg viewBox="0 0 ${BOX} ${BOX}" xmlns="http://www.w3.org/2000/svg">`,
    ...body,
    '</svg>',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * How many `<path>` elements ONE emitted document carries. D-02's anti vacuity observable.
 *
 * Takes the text rather than rebuilding a fixed document, so the entry point below and
 * `src/render/assets/iconCuts.test.ts` measure THE SAME PREDICATE over every cut rather than two
 * similar ones over one. A cut that emitted an empty body returns 0 here, the guard at the bottom
 * of this file sets a non zero exit code, and `no-paths` in `BRAND_RULES` reddens the lint walk.
 * Two independent guards, because `docs/brand/` is a directory that grows (Phase 81 added three
 * cuts to it) and the first file that failed to generate would otherwise have landed green (WR-04).
 */
export function emittedPathCount(svg: string): number {
  // COMMENTS STRIPPED FIRST (81-REVIEW.md IN-03). Every cut this generator emits opens with a
  // provenance header, and a header that happened to write `<path` - naming the element it is
  // describing, which is a normal thing for a header to do - would report a non-zero count for
  // a document with an empty body and walk straight past the D-02 guard. `no-paths` in
  // BRAND_RULES is a real XML parse and would still have caught it, so this weakened one of
  // the guards rather than both, but a predicate that counts its own documentation is not a
  // predicate.
  return (svg.replace(/<!--[\s\S]*?-->/g, '').match(/<path\b/g) ?? []).length;
}

/* ------------------------------------------------------------------ *
 * The 16 unit optical cut (MARK-05).
 * ------------------------------------------------------------------ */

/** The optical cut's provenance header. Same shape as the master's (ART-04, MARK-12). */
function provenanceHeader16(): string[] {
  return [
    '<!--',
    '  docs/brand/fabrico-icon-16.svg - the 16 UNIT OPTICAL CUT of the Fabrico mark (MARK-05).',
    '  The drawing a SIZE AWARE consumer paints below 24 pixels: a compositor window icon, a',
    '  proper freedesktop icon theme lookup, and the Windows and macOS containers. One author',
    '  unit is one device pixel at 16px, so every edge lands whole and nothing is blended.',
    '',
    '  WHAT DOES NOT PAINT IT, measured 2026-09-09. This file used to say the drawing was for',
    '  "taskbar, tray, window decoration and Dock", and two measurements contradict it. A',
    '  desktop shell\'s bar can render the active window as text only, with no taskbar or dock',
    '  widget that paints a window icon at all. And some Linux launchers index icons by bare',
    '  basename with the size directory discarded and no size ordering, so they paint',
    '  whichever layer the filesystem returned first: a RESAMPLED larger layer rather than',
    '  this cut, measured at 50 distinct colours in a 24 pixel box against the hand-cut',
    '  layer 8.',
    '',
    '  INSTALLING THIS CUT DOES NOT MEAN A GIVEN PANEL SHOWS IT. Measure the surface, do not',
    '  infer it from the file having been installed. Any later work has to read this before it',
    '  claims anything about the favicon and the web surfaces.',
    '',
    '  AUTHORED ON THIS GRID. NEVER RESAMPLED FROM THE MASTER (D-04). MARK-05 exists precisely',
    '  because a downscale cannot produce this drawing, which is also why tauri icon cannot do',
    '  this job: a shape correct at 48 pixels is wrong at 16, and what is wrong here is PAINT',
    '  rather than geometry.',
    '',
    '  THE ONE PLACE IT DEPARTS FROM HALF SCALE, stated so the next reader does not "fix" it',
    '  back. The cell and the item are exact half scale of the master. THE BELT IS NOT: it is a',
    '  SOLID INK BAR, three units tall and unstroked, where half of the painted belt box on the',
    '  master would be four units tall and would be a panel filled band inside an ink stroke. At',
    '  16px that band renders as a 1px hollow outline with a dark interior and reads as a second',
    '  outlined rectangle competing with the cell frame. Filling it with ink is the optical fix',
    '  and it is the whole reason this file exists. frontend/src/render/assets/icon16Cut.test.ts',
    '  asserts the departure, so restoring half scale reddens the unit suite.',
    '',
    '  THE CELL IS A FILLED RING, not a stroked rectangle: an outer contour and an inner contour',
    '  wound in reverse, so the hole falls out of the default nonzero rule. There is no fill rule',
    '  attribute in this file. frontend/src/chrome/svgToElements.ts throws on that attribute by',
    '  name, and the reversed winding renders byte identically without it.',
    '',
    '  NOTHING IN THE APP IMPORTS IT: no component, no Vite input and no bundle reaches docs/, so',
    '  this drawing is a brand source rather than a shipped asset. It serves the operating system',
    '  only (D-05).',
    '',
    '  GENERATED FILE. Written by frontend/scripts/build-icons.ts and regenerated rather than',
    '  edited: run npm run build:icons. frontend/src/render/assets/iconCuts.test.ts rebuilds it in',
    '  memory and compares byte for byte, so a hand edit reddens the unit suite.',
    '',
    '  THE PAINT IS DERIVED, NOT TRANSCRIBED. The three values below are read out of',
    '  skinToCssVars(LOCKED_SKIN) at generation time, by the tokens fab-substrate, fab-ink and',
    '  fab-accent-item. No hex literal for any of them appears in the generator.',
    '',
    '  ART-04 PROVENANCE: authored from scratch, from the chosen and approved Fabrico mark. No',
    '  icon pack was consulted, copied, traced or redrawn. Nothing here derives from',
    '  game-icons.net (CC-BY-3.0, which redrawing does not clear) or from Remix Icon, whose',
    '  licence forbids logo and trademark use by name.',
    '-->',
  ];
}

/**
 * The optical cut's SVG text.
 *
 * FOUR PATHS, in paint order plate, rail, cell, item. Reads NOTHING: not `ICON_16_PATH`, not the
 * master, not the chrome square. A builder that read its own committed output would make a
 * regenerate and compare gate pass on any file at all.
 */
export function buildIcon16(): string {
  const substrate = paint('--fab-substrate');
  const ink = paint('--fab-ink');
  const item = paint('--fab-accent-item');

  const body = [
    pathLine('plate', PLATE_16_D, `fill="${substrate}"`),
    pathLine('rail', RAIL_16_D, `fill="${ink}"`),
    pathLine('cell', CELL_16_D, `fill="${ink}"`),
    pathLine('item', ITEM_16_D, `fill="${item}"`),
  ];

  const lines = [
    ...provenanceHeader16(),
    `<svg viewBox="0 0 ${BOX_16} ${BOX_16}" xmlns="http://www.w3.org/2000/svg">`,
    ...body,
    '</svg>',
  ];
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * The monochrome stencil (MARK-07).
 * ------------------------------------------------------------------ */

/** The stencil's provenance header. Same shape as the master's (ART-04, MARK-12). */
function provenanceHeaderStencil(): string[] {
  return [
    '<!--',
    '  docs/brand/fabrico-icon-stencil.svg - the MONOCHROME STENCIL of the Fabrico mark',
    '  (MARK-07). One colour, and a silhouette that carries a real hole. This is the cut for a',
    '  surface that paints the mark itself: a template tray icon, a menu bar glyph, a single',
    '  colour print.',
    '',
    '  IT CARRIES NO PLATE, AND THAT IS ITS ENTIRE POINT (D-08). The master and the 16 unit cut',
    '  both sit on a full bleed ground so an installer icon does not vanish in a light theme',
    '  Dock. This one must not: a tray that fills a template glyph would collapse a plated',
    '  drawing into a solid square, and a solid square is not a mark. The ring between the inner',
    '  wall of the cell and the amber item is the hole that survives that fill, and',
    '  frontend/src/render/assets/iconRaster.test.ts measures it against the plated master in the',
    '  same run rather than against a remembered percentage.',
    '',
    '  ONE COLOUR, AND IT IS THE INK OF THE MARK ITSELF RATHER THAN BLACK. Every paint below is',
    '  the ink value, so this file spends nothing from the brand colour register and adds no row',
    '  to the table in docs/brand/README.md.',
    '',
    '  SAME GEOMETRY AS THE MASTER, on the same 32 unit box: the rail, cell and item d strings',
    '  are the ones the master declares, minus the plate. The stencil is a repaint of the mark,',
    '  not a redraw of it.',
    '',
    '  NOTHING IN THE APP IMPORTS IT: no component, no Vite input and no bundle reaches docs/, so',
    '  this drawing is a brand source rather than a shipped asset. It serves the operating system',
    '  only (D-05).',
    '',
    '  GENERATED FILE. Written by frontend/scripts/build-icons.ts and regenerated rather than',
    '  edited: run npm run build:icons. frontend/src/render/assets/iconCuts.test.ts rebuilds it in',
    '  memory and compares byte for byte, so a hand edit reddens the unit suite.',
    '',
    '  THE PAINT IS DERIVED, NOT TRANSCRIBED. The one value below is read out of',
    '  skinToCssVars(LOCKED_SKIN) at generation time, by the token fab-ink. No hex literal for it',
    '  appears in the generator.',
    '',
    '  ART-04 PROVENANCE: authored from scratch, from the chosen and approved Fabrico mark. No',
    '  icon pack was consulted, copied, traced or redrawn. Nothing here derives from',
    '  game-icons.net (CC-BY-3.0, which redrawing does not clear) or from Remix Icon, whose',
    '  licence forbids logo and trademark use by name.',
    '-->',
  ];
}

/**
 * The stencil's SVG text.
 *
 * THREE PATHS, in paint order rail, cell, item, and NO PLATE. Every paint is the ink value: one
 * colour on a transparent ground, which is what makes the silhouette measurable at all.
 *
 * The rail keeps its stroke here, unlike the 16 unit cut. At 32 units and a template fill there is
 * no hollow band problem to solve: fill and stroke are the same ink, so the layer paints solid and
 * the stroke only widens it to the same painted box the master's belt occupies.
 */
export function buildIconStencil(): string {
  const ink = paint('--fab-ink');

  const body = [
    pathLine('rail', RAIL_D, `fill="${ink}" stroke="${ink}" stroke-width="${STROKE_W}"`),
    pathLine('cell', CELL_D, `fill="none" stroke="${ink}" stroke-width="${STROKE_W}"`),
    pathLine('item', ITEM_D, `fill="${ink}"`),
  ];

  const lines = [
    ...provenanceHeaderStencil(),
    `<svg viewBox="0 0 ${BOX} ${BOX}" xmlns="http://www.w3.org/2000/svg">`,
    ...body,
    '</svg>',
  ];
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * The raster.
 * ------------------------------------------------------------------ */

/**
 * Rasterise an SVG string at a pixel width through the PINNED binding.
 *
 * `fitTo: { mode: 'width', value }` rather than a width and height pair: the master is square
 * by its viewBox, and asking for one dimension keeps the aspect the drawing declares rather
 * than a second number this file would have to keep in step with the first.
 */
export function rasterise(svg: string, width: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}

/* ------------------------------------------------------------------ *
 * The ladder and the two containers, DECLARED AS DATA.
 * ------------------------------------------------------------------ */

/**
 * Which of the two drawings a raster is cut from.
 *
 * The stencil is never rasterised into the installer set: it is the template glyph, and a
 * template glyph on a plate is a solid square (D-08).
 */
export type CutName = 'master' | 'small';

/** One PNG on the standalone size ladder: where it lands, what it is cut from, how wide. */
export interface LadderEntry {
  /** The absolute output path. */
  path: string;
  /** Which drawing it is rendered from. See the header for the measurement behind the split. */
  cut: CutName;
  /** The render width in pixels. The drawings are square, so this is also the height. */
  width: number;
}

/**
 * THE SIZE LADDER, in write order.
 *
 * 16 and 24 come off the OPTICAL CUT and everything from 32 up comes off the MASTER. That split
 * is measured, not preferred, and the numbers are in this file's header.
 *
 * `128x128@2x.png` and `256x256.png` are the same 256 pixel render in two slots the bundler names
 * differently. They are byte-identical on purpose.
 */
export const LADDER: readonly LadderEntry[] = Object.freeze([
  { path: RASTER_16_PATH, cut: 'small', width: 16 },
  { path: RASTER_24_PATH, cut: 'small', width: 24 },
  { path: RASTER_32_PATH, cut: 'master', width: 32 },
  { path: RASTER_48_PATH, cut: 'master', width: 48 },
  { path: RASTER_128_PATH, cut: 'master', width: 128 },
  { path: RASTER_128_2X_PATH, cut: 'master', width: 256 },
  { path: RASTER_256_PATH, cut: 'master', width: 256 },
  { path: RASTER_ICON_PATH, cut: 'master', width: 512 },
] as LadderEntry[]);

/** One layer of the Windows container. */
export interface IcoLayer {
  /** The square edge in pixels. 256 is the largest an ICONDIRENTRY can declare. */
  size: number;
  /** Which drawing it is rendered from. */
  cut: CutName;
}

/**
 * THE ICO'S LAYERS, IN FILE ORDER, AND THE ORDER IS THE REQUIREMENT (ICON-06).
 *
 * 32 FIRST. `tauri-codegen` reads `let entry = &icon_dir.entries()[0]` with no search at all
 * (`tauri-codegen-2.6.3/src/image.rs:54-58`), so index 0 IS the Windows default window icon. A
 * reordered file ships the wrong one silently, which is why
 * `src/render/assets/iconContainers.test.ts` proves its index-0 assertion reddens on a reordered
 * copy rather than merely passing on this one.
 *
 * This is the same six-size set the file committed before plan 81-04 already carried, so ICON-06
 * is a continuity claim rather than a new one.
 */
export const ICO_LAYERS: readonly IcoLayer[] = Object.freeze([
  { size: 32, cut: 'master' },
  { size: 16, cut: 'small' },
  { size: 24, cut: 'small' },
  { size: 48, cut: 'master' },
  { size: 64, cut: 'master' },
  { size: 256, cut: 'master' },
] as IcoLayer[]);

/** One chunk of the macOS container. */
export interface IcnsChunk {
  /** The four character OSType that names the slot. */
  ostype: string;
  /** The square edge in pixels the OSType declares. */
  size: number;
}

/**
 * THE ICNS CHUNKS. The OSType to size map was MEASURED off `tauri icon`'s own output rather than
 * recalled (81-RESEARCH.md S7), and every one of them is rendered from the master.
 *
 * The legacy raw pairs `is32`+`s8mk` and `il32`+`l8mk` that Tauri also emits are deliberately
 * absent: they are RLE-encoded ARGB rather than PNG, modern macOS does not require them, and
 * reproducing them means hand-rolling that encoder. See the file header, which also records that
 * no macOS validated this file.
 */
export const ICNS_CHUNKS: readonly IcnsChunk[] = Object.freeze([
  { ostype: 'ic11', size: 32 },
  { ostype: 'ic12', size: 64 },
  { ostype: 'ic07', size: 128 },
  { ostype: 'ic13', size: 256 },
  { ostype: 'ic08', size: 256 },
  { ostype: 'ic14', size: 512 },
  { ostype: 'ic09', size: 512 },
  { ostype: 'ic10', size: 1024 },
] as IcnsChunk[]);

/* ------------------------------------------------------------------ *
 * The two container writers. Pure: bytes in, bytes out, no path read.
 * ------------------------------------------------------------------ */

/**
 * The Windows ICO container: a 6-byte `ICONDIR`, then one 16-byte `ICONDIRENTRY` per layer, then
 * the PNG payloads in the same order.
 *
 * The record layout, which the reader in `iconContainers.test.ts` walks in the other direction:
 * width and height are ONE BYTE EACH and a stored 0 MEANS 256, which is why the largest layer an
 * ICO can declare is 256. Colour count is 0 for truecolour, planes 1, bits per pixel 32, then the
 * payload's byte length and its offset from the start of the file, both little-endian.
 *
 * Everything about this file is fixed by the layer list handed in, so it is byte-deterministic:
 * the same layers produce the same bytes on every run, which is what
 * `iconCuts.test.ts`'s regenerate-and-compare case rests on.
 */
export function buildIco(layers: readonly { size: number; png: Buffer }[]): Buffer {
  if (layers.length === 0) {
    throw new Error('build-icons: refusing to write an ICO with no layers at all');
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved, always 0
  header.writeUInt16LE(1, 2); // type, 1 for ICO
  header.writeUInt16LE(layers.length, 4);

  const directory = Buffer.alloc(16 * layers.length);
  let offset = header.length + directory.length;

  layers.forEach((layer, index) => {
    if (layer.size < 1 || layer.size > 256 || !Number.isInteger(layer.size)) {
      throw new Error(
        `build-icons: ${String(layer.size)} cannot be declared in an ICONDIRENTRY. The width and ` +
          'height fields are one byte each, so the range is 1 to 256 with 0 standing for 256.',
      );
    }
    const stored = layer.size === 256 ? 0 : layer.size;
    const at = 16 * index;
    directory.writeUInt8(stored, at); // width, 0 means 256
    directory.writeUInt8(stored, at + 1); // height, 0 means 256
    directory.writeUInt8(0, at + 2); // colour count, 0 for truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(layer.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += layer.png.length;
  });

  return Buffer.concat([header, directory, ...layers.map((layer) => layer.png)]);
}

/**
 * The macOS ICNS container: the magic `icns`, a big-endian total length INCLUDING those eight
 * bytes, then chunks of `[4-byte OSType][big-endian length including the 8-byte chunk header]
 * [payload]`.
 *
 * The declared total length equalling the file's actual length is the cheapest structural
 * assertion a zero-byte or truncated file cannot satisfy, which is exactly what ICON-04 needs:
 * `existsSync('icon.icns')` is passed by `touch icon.icns`, and this is not.
 */
export function buildIcns(chunks: readonly { ostype: string; png: Buffer }[]): Buffer {
  if (chunks.length === 0) {
    throw new Error('build-icons: refusing to write an ICNS with no chunks at all');
  }

  const bodies = chunks.map((chunk) => {
    if (chunk.ostype.length !== 4) {
      throw new Error(
        `build-icons: "${chunk.ostype}" is not a four character OSType, and the ICNS chunk header ` +
          'has exactly four bytes for it',
      );
    }
    const head = Buffer.alloc(8);
    head.write(chunk.ostype, 0, 4, 'ascii');
    head.writeUInt32BE(head.length + chunk.png.length, 4);
    return Buffer.concat([head, chunk.png]);
  });

  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(
    header.length + bodies.reduce((total, body) => total + body.length, 0),
    4,
  );

  return Buffer.concat([header, ...bodies]);
}

/* ------------------------------------------------------------------ *
 * Building the whole set, in memory.
 * ------------------------------------------------------------------ */

/** One emitted SVG cut, named, so the entry point can report and refuse it by name. */
export interface IconCut {
  /** The file this text was written to. */
  path: string;
  /** The SVG text. */
  svg: string;
  /** How many `<path>` elements it carries. Zero is a failure, per D-02. */
  paths: number;
}

/** One emitted file, before anything touches a path. */
export interface IconArtifact {
  /** The absolute output path. Every one of these is in `ICON_OUTPUTS`. */
  path: string;
  /** UTF-8 text for an SVG cut, raw bytes for a raster or a container. */
  bytes: string | Buffer;
}

/** What one `writeIcons()` run produced, for the entry point's summary. */
export interface IconBuild {
  /** Every SVG cut this run wrote, in write order. */
  cuts: IconCut[];
  /** Every artefact this run wrote, in write order, cuts included. */
  artifacts: IconArtifact[];
}

/** An artefact's byte length, whichever of the two forms it carries. */
export function artifactLength(artifact: IconArtifact): number {
  return typeof artifact.bytes === 'string'
    ? Buffer.byteLength(artifact.bytes, 'utf8')
    : artifact.bytes.length;
}

/** The three SVG cuts, with their path counts measured by the predicate D-02 names. */
export function buildIconCuts(): IconCut[] {
  return [
    { path: MASTER_PATH, svg: buildIconMaster(), paths: 0 },
    { path: ICON_16_PATH, svg: buildIcon16(), paths: 0 },
    { path: STENCIL_PATH, svg: buildIconStencil(), paths: 0 },
  ].map((cut) => ({ ...cut, paths: emittedPathCount(cut.svg) }));
}

/**
 * EVERY ARTEFACT THIS GENERATOR EMITS, IN MEMORY, IN WRITE ORDER. Reads nothing and writes
 * nothing.
 *
 * Separated from `writeIcons()` so `iconCuts.test.ts` can rebuild the whole set and compare it
 * byte for byte against the committed files WITHOUT putting a single byte on a shared checkout.
 *
 * Renders are memoised by cut and width, so the ladder, the ICO and the ICNS asking for the same
 * 256 pixel image get one render rather than three. That is a speed decision with a correctness
 * consequence worth stating: it also guarantees the two 256 pixel ladder slots are literally the
 * same bytes rather than two renders trusted to agree.
 */
export function buildIconArtifacts(): IconArtifact[] {
  const cuts = buildIconCuts();
  const source: Record<CutName, string> = {
    master: buildIconMaster(),
    small: buildIcon16(),
  };

  const memo = new Map<string, Buffer>();
  const render = (cut: CutName, width: number): Buffer => {
    const key = `${cut}@${String(width)}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const png = rasterise(source[cut], width);
    memo.set(key, png);
    return png;
  };

  const ico = buildIco(
    ICO_LAYERS.map((layer) => ({ size: layer.size, png: render(layer.cut, layer.size) })),
  );
  const icns = buildIcns(
    ICNS_CHUNKS.map((chunk) => ({ ostype: chunk.ostype, png: render('master', chunk.size) })),
  );

  return [
    ...cuts.map((cut) => ({ path: cut.path, bytes: cut.svg })),
    ...LADDER.map((entry) => ({ path: entry.path, bytes: render(entry.cut, entry.width) })),
    { path: ICO_PATH, bytes: ico },
    { path: ICNS_PATH, bytes: icns },
  ];
}

/* ------------------------------------------------------------------ *
 * Writing. The only function that touches an output path.
 * ------------------------------------------------------------------ */

/**
 * D-02, ASSERTED BEFORE ANY WRITE. Throws naming every cut that emitted no `<path>` at all.
 *
 * The entry point used to run this check AFTER `writeIcons()` returned, so a cut with an empty
 * body was written to `docs/brand/` first and complained about second. Plan 81-02's own
 * transcript records it happening: the build printed `fabrico-icon-stencil.svg  0 paths, 2369
 * bytes` as a WRITE line and the tracked file had to be restored with `git checkout --`. Both
 * summaries described the entry point as one that "refuses any cut with an empty body"; it did
 * not refuse, it wrote and then complained (81-REVIEW.md WR-07).
 *
 * The exit code and `no-paths` in `BRAND_RULES` stay as the second and third guards. What this
 * one adds is that `npm run build:icons` can no longer leave a corrupted tracked file behind on
 * a checkout that concurrent runs share.
 */
export function refuseEmptyCuts(cuts: readonly IconCut[]): void {
  const empty = cuts.filter((cut) => cut.paths === 0);
  if (empty.length === 0) return;
  throw new Error(
    `build-icons: refusing to write ${empty.map((cut) => basename(cut.path)).join(', ')}: ` +
      'the cut emitted no <path> at all (D-02). Nothing has been written.',
  );
}

/**
 * Write every artefact. The ONLY function that touches an output path, and it writes exactly the
 * paths `ICON_OUTPUTS` declares.
 *
 * The D-02 refusal is the FIRST thing it does, before `buildIconArtifacts()` and before any
 * write, so a build that would emit an empty cut leaves the tree exactly as it found it.
 */
export async function writeIcons(): Promise<IconBuild> {
  const cuts = buildIconCuts();
  refuseEmptyCuts(cuts);
  const artifacts = buildIconArtifacts();

  for (const artifact of artifacts) {
    mkdirSync(dirname(artifact.path), { recursive: true });
    if (typeof artifact.bytes === 'string') {
      writeFileSync(artifact.path, artifact.bytes, 'utf8');
    } else {
      writeFileSync(artifact.path, artifact.bytes);
    }
  }

  return { cuts, artifacts };
}

// `import.meta.main` is true only under bare `node scripts/build-icons.ts`; under Vite and
// vitest it is undefined, so importing this module never writes a file. Deliberately NOT an
// argv comparison: this generator reads no argv at all.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  const built = await writeIcons();
  for (const cut of built.cuts) {
    process.stdout.write(
      `build-icons  ${basename(cut.path)}  ${cut.paths} paths, ${cut.svg.length} bytes\n`,
    );
  }
  for (const artifact of built.artifacts) {
    if (typeof artifact.bytes === 'string') continue;
    process.stdout.write(
      `build-icons  ${basename(artifact.path)}  ${artifactLength(artifact)} bytes\n`,
    );
  }

  // D-02, THE SECOND GUARD. `writeIcons()` already threw before writing anything if a cut
  // emitted an empty body, so reaching this loop with a zero means `refuseEmptyCuts` and
  // `emittedPathCount` have drifted apart - which is worth an exit code of its own. `no-paths`
  // in `BRAND_RULES` is the third guard, on the committed file rather than on the build.
  for (const cut of built.cuts) {
    if (emittedPathCount(cut.svg) === 0) {
      process.stderr.write(`build-icons  ${basename(cut.path)} emitted no <path> at all\n`);
      process.exitCode = 1;
    }
  }
}
