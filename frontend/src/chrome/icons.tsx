// icons.tsx - the chrome icon set (CHROME-01/CHROME-02, plans 59-01 and 59-02).
//
// NOTE, CORRECTED IN PLACE BY PLAN 59-01 AND AGAIN BY PLAN 59-02 (CHROME-01). This header
// used to open:
//
//   "The clean break from vector icon libraries and inline vector markup: every chrome
//   icon is a bit matrix of 0/1 rows rendered to the DOM with NO vector element and NO
//   vector path, so the chrome reads as ONE pixel world with the canvas machines."
//
// The rule that claim served is still in force; the MECHANISM it named stopped being
// the way to serve it. "No vector icon LIBRARY" is permanent and unchanged - ART-04
// provenance binds chrome glyphs too, and no icon pack is consulted, copied, traced or
// redrawn. "No vector ELEMENT and no vector PATH" was written when the canvas itself was
// a pixel bake, so a bit matrix was literally the same artefact the board stamped. Plan
// 58-03 moved the canvas to authored VECTOR art (`render/assets/*.svg`) and the two
// halves diverged: the chrome kept re-rasterising 0/1 matrices while the board drew
// paths. Phase 59 closes that by pointing BOTH at the same file, which is only
// expressible as an inline `<svg>` - the one form in which `--fab-*` tokens still
// resolve and the one form that is crisp at a fractional DPR. The pixel world is now
// held by the AUTHORING GRID (integer even coordinates, M H V L Z, no curves, 3u/2u
// strokes), not by the render path.
//
// AND THE SECOND SUPERSEDED CLAIM, quoted so it is corrected rather than deleted. Plan
// 59-01's version of this header went on to say:
//
//   "There are exactly two render paths in this file today ... Transport / warning icons
//   (Play/Pause/Step/Undo/Redo/Save/Load/New/Fit/Warning/Trash) have no canvas
//   equivalent, so they are STILL authored here in the 0/1 number[][] idiom and rendered
//   as a crisp CSS `box-shadow` sprite. Plan 59-02 re-authors them into
//   `chrome/assets/*.svg` and deletes this path along with the gate that proves the idiom
//   is gone rather than dormant. Until then, this paragraph describes live code."
//
// Plan 59-02 is that plan and it has landed. The eleven matrices, the shadow-list helper
// and the `SpriteIcon` component are GONE from the tree rather than left dormant, and
// `chrome/bitMatrixIdiom.test.ts` reddens if any of the three shapes returns. The
// paragraph above now describes DELETED code and is kept only as the record of what was
// deleted and why.
//
// THERE IS ONE RENDER PATH IN THIS FILE. Every icon is an inline `<svg>` whose geometry
// comes from an AUTHORED FILE - `render/assets/*.svg` for the eight machine subjects,
// `chrome/assets/*.svg` for the twelve DOM-only glyphs. The parse is PURE and DOM-free
// (`chrome/svgToElements.ts`), and it rewrites EXACTLY THREE attributes - `fill`,
// `stroke` and `stroke-width` - while copying the path data CHARACTER FOR CHARACTER.
// That verbatim copy is the whole checkable content of "the icon and the canvas share one
// asset"; `chrome/icons.test.tsx` asserts it over the full export surface and
// `render/assets/geometryDigest.test.ts` proves it against the bytes on disk.
//
// NO RASTER, AND THEREFORE NO RENDERING HINT. Neither `imageRendering: 'pixelated'` nor a
// mask nor a data URL appears anywhere below. A nearest-neighbour hint on a surface with
// no raster is not harmless: it reads as intent, and plan 59-03's retirement gate fires
// on the hint in a module with no baked-matrix source.
//
// NO STATE IS DECLARED HERE. Hover, active and disabled are all INHERITED from the
// button, which is exactly why every ink is `currentColor` and never a baked value - a
// baked hex would not desaturate with `.fab-tool-btn:disabled` and would not lift with a
// hovered palette item.

import type { CSSProperties, JSX, ReactElement } from 'react';
import { machine_kind } from '../protocol/kinds';
import { LOCKED_SKIN } from '../render/synth/skins/locked';
import { ICON_MD_PX } from '../render/synth/chrome/iconSizes';
import { chassisPathD, chassisSpec, U_PER_CELL } from '../render/layers/machineChassis';
import { SUBJECT_OF } from '../render/layers/machines';
import { getAssetBox, getAssetSource, type AssetName } from '../render/svgAssets';
import { CHROME_ASSET_SOURCES, getChromeAssetSource, type ChromeAssetName } from './assets/registry';
import { iconElements, readAuthorBox } from './svgToElements';

interface IconProps {
  /** Target icon size in px. Defaults to the size ladder's `ICON_MD_PX`. */
  px?: number;
  /** Icon colour - a --fab-* token only (defaults per icon family). */
  color?: string;
  /** Optional style passthrough (layout only; colour must stay a --fab-* token). */
  style?: CSSProperties;
}

/**
 * The icon's own coordinate box, in `u`. It is the 1x1 machine box and nothing else.
 *
 * THE ICON DRAWS EVERY SUBJECT AT (1, 1), NEVER AT ITS OWN FOOTPRINT. Measured, the
 * faithful alternative is worse: letterboxing a FACTORY at its true `0 0 96 96` author
 * box into a 24px square puts its 3u chassis stroke at `24 * 3/96 = 0.69` CSS px and its
 * 2u glyph stroke at 0.46 px, so the hero machine's icon is a grey smudge beside a crisp
 * 1x1 SOURCE. Footprint is not what a palette icon communicates - the label and the
 * placement ghost carry it. Drawing every subject at (1, 1) also makes px-per-u UNIFORM
 * across the whole set (0.75 px/u at 24px), which is what lets one stroke arithmetic
 * describe the entire palette.
 */
const ICON_BOX_U = U_PER_CELL;

/**
 * The chassis `d` for the icon, serialised ONCE at module load from the shared
 * description.
 *
 * `chassisSpec(1, 1, LOCKED_SKIN)` is the same function `drawChassis` consumes, so the
 * icon's rectangle and the board's rectangle are one declaration rather than two that
 * agree. Hoisted to module scope because it is a constant: it depends on nothing a
 * render can change, and computing it per icon would invite someone to "simplify" it into
 * a literal.
 */
const CHASSIS_D = chassisPathD(chassisSpec(1, 1, LOCKED_SKIN));

/**
 * EVERY committed chrome asset's parts as React elements, built ONCE at module load.
 *
 * TWO PROPERTIES, AND BOTH ARE THE REASON IT IS EAGER RATHER THAN LAZY.
 *
 *   1. IT IS THE CHROME HALF OF THE MEMO. N Play buttons and a 10Hz chrome poll share
 *      ONE parse of `play.svg`, not one per render. React elements are immutable, so
 *      handing the same array to N renders is safe and the `key` on each part comes from
 *      its own `data-part`.
 *
 *      CORRECTED IN PLACE BY PLAN 59-08. This sentence used to read "IT IS THE MEMO, AND
 *      SINCE THE PHASE-59 REVIEW IT IS THE ONLY ONE", and being the only one is exactly
 *      what was wrong with it. The property the sentence claims - one parse per asset,
 *      however many icons are on screen - was true of the twelve chrome glyphs it names
 *      and FALSE of the eight machine subjects this file also renders, which are the
 *      LARGER half. It was measured false rather than argued so: 59-VERIFICATION.md's
 *      probe spied on `iconElements` and counted five renders of `PlayIcon` at ZERO
 *      parses against five renders of `TeeIcon` at FIVE, inside a Palette and a Legend
 *      that re-render on the ~10Hz chrome poll. `placedGlyph` called `getAssetSource` +
 *      `iconElements` inline in the component body, so there was no machine memo at all.
 *      Phase 59's code review said so before the phase closed (IN-01) and offered two
 *      fixes: build the memo, or write down that the machine path is exempt. The
 *      exemption is REFUSED - it would leave this docblock honestly saying the memo
 *      covers the smaller half - so 59-08 built `PLACED_GLYPHS` instead.
 *
 *      THE TWO HALVES ARE MEMOISED DIFFERENTLY AND THE SPLIT IS DELIBERATE. This table is
 *      EAGER because it walks its OWN closed registry (`CHROME_ASSET_SOURCES`) and
 *      carries the 32u author-box refusal below, which is worth paying at import.
 *      `PLACED_GLYPHS` is LAZY because the machine subjects resolve through `SUBJECT_OF`
 *      over an OPEN keyspace - a wire byte this build has never seen - so the reachable
 *      subject set is data rather than a literal and the first render is the honest place
 *      to pay. Both halves now satisfy the one-parse-per-asset property, and it is held
 *      by a GATE rather than by this paragraph: `icons.test.tsx` counts every
 *      `iconElements` call across import plus five renders of every export and every
 *      `SUBJECT_OF` kind, and asserts no asset source is parsed twice.
 *
 *      The superseded second half of this claim, quoted rather than deleted: "There is no
 *      second cache anywhere in this file; `chrome/assets/registry.ts` holds the
 *      parsed-part memo for callers that want parts, and this holds the built-elements
 *      memo for the only caller that wants elements." There were never two caches with
 *      two clienteles - the registry's `getChromeAssetParts` and its `PARTS` map had no
 *      caller anywhere in the tree, so the map was allocated and never written. WR-04
 *      deleted them; the registry is a `?raw` source table now.
 *   2. IT IS THE AUTHOR-BOX REFUSAL, AT IMPORT RATHER THAN INSIDE A RENDER. A chrome
 *      glyph is authored IN the icon box, so its placement is the identity and
 *      `strokeWidthScale` is exactly 1. That is only true at 32u. `lint-svg.ts` admits
 *      four legal viewBoxes, three of which are NOT 32u, so "every chrome asset is 32u"
 *      is a real claim rather than a tautology - a 64u chrome glyph would render at half
 *      the intended stroke weight and at twice the intended size, silently. Checking it
 *      at module load makes a mis-authored asset a loud, deterministic import failure
 *      instead of a throw inside a render.
 *
 * The walk is over `CHROME_ASSET_SOURCES` itself, so a thirteenth-plus asset is covered
 * the moment it is registered rather than when someone remembers to add it here.
 */
const CHROME_GLYPHS: Readonly<Record<ChromeAssetName, readonly ReactElement[]>> = (() => {
  const out = {} as Record<ChromeAssetName, readonly ReactElement[]>;
  for (const name of Object.keys(CHROME_ASSET_SOURCES) as ChromeAssetName[]) {
    const source = getChromeAssetSource(name);
    const box = readAuthorBox(source);
    if (box.w !== ICON_BOX_U || box.h !== ICON_BOX_U) {
      throw new Error(
        `icons: chrome asset '${name}' declares a ${box.w}x${box.h} author box, not ` +
          `${ICON_BOX_U}x${ICON_BOX_U}. A chrome glyph is authored IN the icon box so its ` +
          'placement is the identity; at any other box it would render at the wrong size ' +
          'and the wrong stroke weight, silently. Re-author it at 32u.',
      );
    }
    // strokeWidthScale 1: the author box IS the icon box, so there is no placement scale
    // to invert. The machine subjects below are the case where that is not true.
    out[name] = iconElements(source, { strokeWidthScale: 1 });
  }
  return out;
})();

/** The root `<svg>` style every chrome icon shares. Copied from `PortIndicator.tsx:77-83`. */
function iconRootStyle(px: number, color: string, style?: CSSProperties): CSSProperties {
  return {
    color,
    // Phase 91, plan 91-10 (CHROME-20, D-16, UI-SPEC 7.1, WINDOWS 233): ANTI-ALIASED, the hint the
    // header lockup already takes (plan 80.1-04). CORRECTED IN PLACE. This line read "The skin
    // is a hard-edged skin: soften nothing." over `shapeRendering: 'crispEdges'`. Snapping every
    // edge to a whole device pixel is exact only at an integer device scale. At a fractional
    // desktop scale such as GDK_DPI_SCALE 1.1818, a 16 px glyph is 18.9 device px and two
    // buttons sit at different sub-pixel phases, so the same edge snapped one way on Undo and the other way on
    // Redo: the mirrored pair stopped reading as mirrors, the Step diagonal stair-stepped and
    // the Pause bars grew ragged tails. `geometricPrecision` draws the true geometry at any
    // phase. The Legend's inline swatches keep `crispEdges` (UI-SPEC A19): they are 1:1 rects.
    shapeRendering: 'geometricPrecision',
    display: 'block',
    // A flex row with hidden overflow (the toolbar's `data-fab-brand-column`, any button row)
    // will SQUEEZE an unpinned child. `PortIndicator` pins for the same reason.
    flexShrink: 0,
    verticalAlign: 'middle',
    width: px,
    height: px,
    // NOT `imageRendering: 'pixelated'`. This comment used to add "PortIndicator
    // carries it because it draws circles that want hard edges under a pixel skin";
    // plan 59-03 deleted it there too, having MEASURED that it was inert - the hint
    // acts on raster content and PortIndicator is an inline <svg>, where
    // `shapeRendering` is the hint that decides the edges (since plan 91-10
    // `geometricPrecision` there too, not the `crispEdges` this line once named). Nothing
    // under frontend/src/chrome/ carries the pixelated hint any more, and
    // pixelatedRetirement.test.ts reddens if it returns.
    ...style,
  };
}

// ---------------------------------------------------------------------------
// The DOM-only chrome glyphs (transport, file, warning, delete). One authored
// `chrome/assets/*.svg` each; no chassis, because none of them depicts a machine.
// ---------------------------------------------------------------------------

/**
 * One chrome-only glyph, inline.
 *
 * It carries no chassis and needs no placement transform: the asset is authored in the
 * icon's own 32u box, so its `d` strings land in the root `<svg>`'s coordinate system
 * unmodified. That is the reason there is no `<g>` wrapper here and one in the machine
 * path - the machine subjects are authored at 32u, 64u, 64x96u and 96u and have to be
 * placed; these do not.
 */
function ChromeGlyphIcon({
  name,
  px = ICON_MD_PX,
  color = 'var(--fab-ink)',
  style,
}: IconProps & { name: ChromeAssetName }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${ICON_BOX_U} ${ICON_BOX_U}`}
      style={iconRootStyle(px, color, style)}
    >
      {CHROME_GLYPHS[name]}
    </svg>
  );
}

export function PlayIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="play" {...p} />;
}
export function PauseIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="pause" {...p} />;
}
export function StepIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="step" {...p} />;
}
export function UndoIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="undo" {...p} />;
}
export function RedoIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="redo" {...p} />;
}
export function SaveIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="save" {...p} />;
}
export function LoadIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="load" {...p} />;
}
/** The blank-page "New board" glyph (SAVE-04). Inherits the --fab-ink default. */
export function NewIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="new" {...p} />;
}
/** The "fit factory to view" glyph (NAV-01). Inherits the --fab-ink default. */
export function FitIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="fit" {...p} />;
}
/**
 * The dialog warning glyph - the ONE icon whose default ink is not `--fab-ink`.
 *
 * A caller that passes its own colour (the guard dialogs, which inherit the panel ink)
 * still wins. The fault hue is a default, not a bake.
 *
 * THE DEFAULT IS A DESTRUCTURED PARAMETER, NOT A PROP SPREAD OVER, and it is the one
 * wrapper in this file that cannot use the sibling shape. The superseded claim, quoted
 * rather than deleted (phase 59 review WR-09): "`color` is spread from `p` AFTER the
 * default, so a caller that passes its own colour ... still wins." That is right for a
 * DEFINED colour and wrong for an explicit `undefined`. `{...p}` spreads `color:
 * undefined` as a PRESENT KEY, so `<WarningIcon color={cond ? tint : undefined} />` -
 * which reads as "no override" at the call site - overwrote the destructive default, and
 * `ChromeGlyphIcon`'s own default parameter then resolved it to `var(--fab-ink)`. The
 * warning glyph silently lost its fault hue on the exact code shape that means "leave it
 * alone". A default PARAMETER treats a missing key and an explicit `undefined` the same
 * way, which is the behaviour the docblock always described.
 *
 * No shipped call site hits it today - all five pass no colour, or a literal - so this
 * was latent rather than live, and `icons.test.tsx` pins both halves now.
 */
export function WarningIcon({ color = 'var(--fab-destructive)', ...rest }: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="warning" color={color} {...rest} />;
}
/**
 * The delete-control trash glyph (IX-04). Inherits the --fab-ink default at idle; the
 * `DeleteControl` wrapper tints its BUTTON --fab-destructive on hover (the delete-danger
 * telegraph) and this glyph follows through `currentColor`, so the fault hue is NOT baked
 * into the icon.
 */
export function TrashIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="trash" {...p} />;
}
/**
 * The Palette Wire tool glyph (plan 66-01): a solid terminal, a thin cable, a solid
 * terminal.
 *
 * A CHROME GLYPH AND NOT A MACHINE ONE, which is the whole reason this wrapper exists.
 * The Belt tool's row renders `MachineGlyphIcon kind={machine_kind.BELT}` and gets away
 * with it only because `MachineGlyphIcon` carries an explicit `isBelt` special case that
 * suppresses the chassis and substitutes `CHROME_GLYPHS.belt`. `SUBJECT_OF` has no key
 * for kind 8, so `MachineGlyphIcon kind={8}` would draw a BARE CHASSIS with nothing
 * inside it, which reads as "a machine whose kind this build does not know". Routing the
 * Wire tool through `ChromeGlyphIcon` avoids adding a second special case to
 * `MachineGlyphIcon`, and matches what a wire is: a link, not a machine box.
 */
export function WireIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="wire" {...p} />;
}

/**
 * The Palette Label row glyph (phase 76, UI-SPEC 1.2): a sheet with two lines of writing.
 * A CHROME glyph for the reason `WireIcon` gives: `SUBJECT_OF` has no key for kind 11, so
 * `MachineGlyphIcon kind={11}` would draw a bare chassis, which reads as an unknown
 * machine. A label is a note, not a machine box.
 */
export function LabelIcon(p: IconProps): JSX.Element {
  return <ChromeGlyphIcon name="label" {...p} />;
}

// ---------------------------------------------------------------------------
// Machine-glyph path - an inline <svg> over TWO shared declarations: the chassis
// from machineChassis.ts and the glyph from the same authored .svg the canvas
// tessellates. No raster, no mask, no data URL.
// ---------------------------------------------------------------------------

interface MachineIconProps extends IconProps {
  /** The machine_kind whose authored subject to render (never a magic number). */
  kind: number;
}

/**
 * A machine icon: the parametric chassis plus the kind's authored glyph, inline.
 *
 * KIND RESOLUTION SPANS TWO REGISTRIES AND THEY STAY SEPARATE. The eight machine
 * subjects resolve through `SUBJECT_OF` into `render/assets/`; `machine_kind.BELT`
 * resolves into `chrome/assets/`. Neither keyspace is widened to cover the other -
 * `machines.ts`'s header warns at length that the matching count of 8 between
 * `SUBJECT_OF` and `GEN_KEY_OF` is a trap, and a chrome glyph is not an art-lock subject.
 *
 * BELT DRAWS NO CHASSIS, because a belt has no chassis on canvas. It is a lane.
 *
 * THE GLYPH IS PLACED, THE PATH DATA IS NOT REWRITTEN. The author box is scaled by
 * `32 / max(W, H)` and centred, and the transform lives on a `<g>` wrapper - never on the
 * paths - so every `d` string in the emitted markup is byte-identical to the one in the
 * committed file. The one numeric rewrite is `stroke-width`, multiplied by the inverse of
 * that placement scale so a 2u stroke authored at 64u still renders at 2u.
 */
export function MachineGlyphIcon({
  kind,
  px = ICON_MD_PX,
  color = 'var(--fab-ink)',
  style,
}: MachineIconProps): JSX.Element {
  const isBelt = kind === machine_kind.BELT;
  // Widened to `| undefined` on purpose. `SUBJECT_OF` is typed `Record<number, AssetName>`
  // over an OPEN keyspace - the wire can carry a kind byte this build has never seen - so
  // the index signature's non-nullable type is a claim the DATA cannot make. TOTAL over
  // the byte, the treatment `chassisInk` already gives an unknown state and `nubColor` an
  // unknown port role: an unresolved kind draws the bare chassis with no glyph, which
  // reads honestly as "a machine whose kind this build does not know" and is visibly
  // distinct from every kind that does resolve. It never throws inside a render.
  const subject: AssetName | undefined = isBelt ? undefined : SUBJECT_OF[kind];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${ICON_BOX_U} ${ICON_BOX_U}`}
      style={iconRootStyle(px, color, style)}
    >
      {!isBelt && (
        <path
          data-part="chassis"
          d={CHASSIS_D}
          fill="none"
          stroke="currentColor"
          strokeWidth={LOCKED_SKIN.strokeStructural}
        />
      )}
      {/* BELT reads its glyph out of the SAME module-load table every transport icon
          uses. Plan 59-01 routed it through `placedGlyph` instead, which wrapped it in a
          `translate(0 0) scale(1)` no-op `<g>` - a second code path, and a transform
          element in the live DOM, for an asset that is already in the icon's coordinate
          system. Plan 59-02 collapses the two. */}
      {isBelt ? CHROME_GLYPHS.belt : placedGlyph(subject)}
    </svg>
  );
}

/**
 * subject -> its ONE placed glyph group. Populated lazily, never evicted - the same shape
 * `svgAssets.ts` gives `CONTEXTS` and `BOXES`, which is the memo 59-01's must_have named
 * by hand as the one to mirror.
 *
 * MEMOISING BY `AssetName` ALONE IS SOUND, and this is where a future reader will look
 * for the reason. The placed group depends on NOTHING a render can vary: the transform
 * comes from `getAssetBox(subject)` and the `strokeWidthScale` from the same box, while
 * `px`, `color` and `style` all live on the root `<svg>` and reach the group through
 * `currentColor` and inheritance. Handing the same immutable element object to N renders
 * is already the shipped `CHROME_GLYPHS` contract for twelve glyphs, so this is the
 * established idiom in this file rather than a new risk.
 */
const PLACED_GLYPHS = new Map<AssetName, JSX.Element>();

/**
 * The placed glyph group for one machine subject, or `null` when there is no artwork to
 * place.
 *
 * The transform lives on this `<g>` and NEVER on a `<path>`, so every `d` string in the
 * emitted markup stays byte-identical to the one in the committed file. That verbatim
 * copy is the whole checkable content of "the icon and the canvas share one asset".
 *
 * IT IS THE MACHINE HALF OF THE MEMO (plan 59-08). Built on the first render of a subject
 * and returned by IDENTITY thereafter, so the nine Palette tiles and the Legend's kind
 * rows share one parse of each `.svg` across the whole session instead of re-parsing it
 * on every ~10Hz chrome poll. See `CHROME_GLYPHS`'s property 1 for why this half is lazy
 * and that one is eager. The `undefined` early return stays AHEAD of the lookup: an
 * unresolved kind byte must still yield `null` and must never enter the map.
 */
function placedGlyph(subject: AssetName | undefined): JSX.Element | null {
  if (subject === undefined) return null;
  const cached = PLACED_GLYPHS.get(subject);
  if (cached !== undefined) return cached;
  const source = getAssetSource(subject);
  const box = getAssetBox(subject);
  const span = Math.max(box.w, box.h);
  const scale = ICON_BOX_U / span;
  // Centre the AUTHOR box, not the ink: several subjects are deliberately asymmetric
  // (TEE is east-heavy, ENDPOINT opens east), and centring their tessellated bounds
  // would slide them off the composition they were authored with. Same rule
  // `machines.ts` applies on the board, at a different scale.
  const tx = (ICON_BOX_U - box.w * scale) / 2;
  const ty = (ICON_BOX_U - box.h * scale) / 2;
  const group = (
    <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
      {iconElements(source, { strokeWidthScale: span / ICON_BOX_U })}
    </g>
  );
  PLACED_GLYPHS.set(subject, group);
  return group;
}

// Convenience machine-glyph exports (kind-keyed off machine_kind, never numbers).
export function SourceIcon(p: IconProps): JSX.Element {
  return <MachineGlyphIcon kind={machine_kind.SOURCE} {...p} />;
}
export function SinkIcon(p: IconProps): JSX.Element {
  return <MachineGlyphIcon kind={machine_kind.SINK} {...p} />;
}
export function FactoryIcon(p: IconProps): JSX.Element {
  return <MachineGlyphIcon kind={machine_kind.FACTORY} {...p} />;
}
export function TeeIcon(p: IconProps): JSX.Element {
  return <MachineGlyphIcon kind={machine_kind.TEE} {...p} />;
}
export function BalancerIcon(p: IconProps): JSX.Element {
  return <MachineGlyphIcon kind={machine_kind.BALANCER} {...p} />;
}
export function RouterIcon(p: IconProps): JSX.Element {
  return <MachineGlyphIcon kind={machine_kind.ROUTER} {...p} />;
}
export function MergeIcon(p: IconProps): JSX.Element {
  return <MachineGlyphIcon kind={machine_kind.MERGE} {...p} />;
}
export function BeltIcon(p: IconProps): JSX.Element {
  return <MachineGlyphIcon kind={machine_kind.BELT} {...p} />;
}
