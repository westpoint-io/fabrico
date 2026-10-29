// The ONE runtime chrome-token source (CHROME-03, CONTEXT Area 3). This module
// stringifies the active skin into a `:root{ --fab-* }` block so the React chrome
// and the Pixi canvas read from ONE world: every colour here is a bakeRamp
// FIXED-INDEX selection (the SAME bake the canvas sprites use), never new chrome
// colour math. The strict sync-guard (skinToCssVars.test.ts) pins the emitted set
// to docs/style-bible.md section 6, so any drift between schema, tokens, and bible
// fails CI.
//
// PURE, and STRUCTURALLY so as of plan 59-05. The superseded claim, quoted rather
// than deleted: "PURE by construction: `skinToCssVars(skin, dpr, bezelDataUrl)`
// touches no DOM and no canvas - the caller bakes the bezel PNG (via bezelUrl) and
// passes it in, which keeps this function node-testable." That purity was a
// CONVENTION the caller had to honour: a third parameter existed precisely because a
// DOM canvas bake sat one frame outside this module. Plan 59-05 deleted
// `chrome/bezelUrl.ts` outright, so there is no bake to keep out - the signature is
// `(skin, dpr)` and there is no argument through which a DOM value could arrive.
// It is EXPORTABLE for the parked docs explainer (CONTEXT deferred idea): the same
// source can later document itself.

import type { Skin } from '../skin.ts';
import { bakeRamp } from '../palette.ts';

/** `0xRRGGBB` -> `#rrggbb` (6-digit, zero-padded). */
function hex(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * The Phase 47 vector-font contract (FEEL-05, forks D-01/D-03/D-06): chrome text
 * renders in smooth VECTOR fonts - Martian Mono for all body/HUD text, Sono
 * ALL-CAPS for the wordmark + panel-title tier. Vector outlines are crisp at any
 * size on any display, so there is NO device grid: the retired x16 device-snap
 * machinery (pixel-font era) is gone and these sizes are plain,
 * DPR-independent CSS px. Base 12px body, 18px title/hero tier, HUD collapses to
 * the 12px base. Weights: body 400, title tier 700 (App.tsx .fab-title).
 */
const FONT_BASE_CSS = 12;
const FONT_TITLE_CSS = 18;
const FONT_HUD_CSS = 12;

/**
 * The minimum interactive target EDGE in CSS px: 44 (style bible 6d, WCAG 2.2 AAA
 * 2.5.5). Emitted as `--fab-min-target`, which every `.fab-*` control honours as a
 * `min-height` / `min-width` floor.
 *
 * EXPORTED, and that is the point of it (plan 66-06, UI-SPEC 6.1). Until this plan the
 * 44 existed ONLY as a literal inside the template string below, so the canvas had no
 * way to read the chrome rule and did not honour it: `nubHitRadiusWorld` shipped a 12
 * world px radius, a 24px diameter target, exactly the WCAG 2.2 AA floor and 20px short
 * of this project's own chrome rule. `WINDOWS.md` row 113 is a user who could not hit it.
 *
 * This is the `ICON_MD_PX` / `ICON_LG_PX` refactor in `iconSizes.ts` applied
 * one more time: ONE declaration, two consumers that cannot drift. The consumers are
 * (1) the `--fab-min-target` row below and (2) `ports.ts`'s `wireNubHitRadiusWorld`,
 * which halves it into a world-px RADIUS. `skinToCssVars.test.ts` asserts the emitted
 * token against this same constant, so changing either reddens.
 *
 * NO TOKEN VALUE MOVES by exporting it: only the sourcing changes, so the bidirectional
 * emitted-set gate against style-bible section 6 stays green.
 */
export const MIN_TARGET_PX = 44;

/**
 * The bezel ring thickness in CSS px, CONSTANT at every DPR (CHROME-02, plan 59-03).
 *
 * Carried verbatim from the retired raster path's `BASE_RING = 6`, which plan 59-05
 * deleted along with `chrome/bezelUrl.ts`. THIS constant is now the only declaration of
 * the 6, so the value did not move house twice: it moved once, in 59-03, and its former
 * home is gone.
 *
 * THE PER-SIDE COMPOSITION, stated correctly and read off the bake rather than off a
 * docblock. It is 1 band lit-or-shadow + 1 band hairline outline + 4 px of body. Two
 * earlier statements of it were both wrong and are quoted here so neither gets restored:
 * the retired `bezelUrl.ts` said "1 lit + 1 shadow + 1 hairline inner outline + 3 body"
 * (three body, measured wrong), and this docblock itself said "1 lit + 1 shadow + 4 body"
 * (right on the body count, but it drops the outline and implies lit and shadow stack
 * inward on the SAME side). The retired bezel bake painted lit on top+left and shadow on
 * bottom+right, shadow AFTER lit, so a given side carried exactly ONE of them at depth 0;
 * the inner outline landed at depth `bandDepth` = 1; and the hollow clear started at
 * `bandDepth + outlineThickness` = 2 of a 6px slice, so four rows showed the element
 * background. The CSS ring reproduces that: shadow band, lit band, then a uniform
 * two-band outline whose outer band is covered, leaving one visible hairline at depth 1.
 *
 * PAST TENSE SINCE PLAN 61-07, WHICH DELETED THE BAKE. The composition above is no longer
 * READ OFF anything - the bake it was measured from is gone - so it is now a recorded
 * measurement rather than a live derivation, and the CSS ring below is its only surviving
 * expression. That is a weakening and it is stated as one: `chrome-bezel.spec.ts` is what
 * still gates the ring's rendered geometry, and there is nothing left for it to disagree
 * with.
 *
 * It is NOT re-decidable here. Changing it moves every panel's and every chunky button's
 * border-box size, which the ring's hard invariant forbids: the ring is PAINT, and layout
 * must not move. Rounding the 6 up to 8 to land the interior offsets back on the
 * four-grid is a change to the shipped bezel thickness, with a re-bless bill.
 */
const BEZEL_RING_CSS = 6;

/**
 * The hairline band width: `round(dpr) / dpr` CSS px, so every band is a WHOLE number of
 * device pixels at every DPR bucket.
 *
 *   | DPR  | band      | device px | apparent |
 *   | 1    | 1px       | 1         | 1.00 CSS |
 *   | 1.25 | 0.8px     | 1         | 0.80 CSS |
 *   | 1.5  | 1.3333px  | 2         | 1.33 CSS |
 *   | 2    | 1px       | 2         | 1.00 CSS |
 *
 * THIS IS A HAIRLINE SNAP, NOT AN OVER-SAMPLE BUCKET. Nothing is baked and nothing is
 * stretched; the ring has no raster to over-sample. A flat `1px` band would be one token
 * simpler and would be a real crispness REGRESSION at 1.25 and 1.5 (1.25 device px
 * antialiases into one solid row plus a 25% blend row), on the phase whose headline is
 * crispness.
 *
 * A CSS `round()` was deliberately NOT used: its support in this Tauri build is
 * unverified, and it would put the phase's headline claim on an unproven feature while
 * making the value invisible to this emitter's own node-testable spec.
 *
 * Four decimal places, where the other numeric rows use three: four holds the DPR-1.5
 * value (1.3333) to within a thousandth of a device pixel.
 *
 * THE NUMERATOR IS CLAMPED AT ONE DEVICE PIXEL, and the clamp is load-bearing rather
 * than defensive. `Math.round(dpr)` is 0 for every `dpr < 0.5`, so the superseded
 * unclamped form emitted `0.0000px` at DPR 0.25 and 0.33 - reachable at 25% and 33%
 * browser zoom in a Chromium / WebKitGTK webview on a 1x display, which is what
 * `App.tsx` reads `window.devicePixelRatio` from. At a 0px band every entry of
 * `--fab-bezel-ring-shadow` degenerates at once: both bands get a zero offset and the
 * outline gets `calc(2 * 0px)` of spread, so NOTHING paints and every `.fab-panel`,
 * `.fab-dialog-panel`, `.fab-tool-btn`, `.fab-cta` and `.fab-dialog-btn` in the app
 * loses its frame outright, with the same 0 propagating into every state highlight.
 * A band is at MINIMUM one device pixel, which is `1 / dpr` CSS px.
 *
 * The divisor is defended for the same reason and not for a different one: `dpr` of 0
 * (or NaN, or Infinity) made the unclamped form emit `NaNpx`, which the CSS parser drops
 * - leaving the band token unresolved and the whole shadow list invalid, a louder version
 * of the same erasure. A non-finite or non-positive DPR falls back to 1.
 *
 * The four shipped buckets (1 / 1.25 / 1.5 / 2) are all >= 1, which is why this survived:
 * `skinToCssVars.test.ts` and `dpr-crispness.spec.ts` both exercise exactly those four
 * and nothing below 1 was measured anywhere. The spec now pins the sub-0.5 boundary.
 */
function bezelBandPx(dpr: number): string {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return `${(Math.max(1, Math.round(safeDpr)) / safeDpr).toFixed(4)}px`;
}

/**
 * Emit the `:root{ --fab-* }` token block for a skin at a given DPR. TWO PARAMETERS, and
 * nothing is threaded in: the emitter is a pure `(Skin, number) -> string`.
 *
 * SUPERSEDED CLAUSE, QUOTED RATHER THAN DELETED (removed by plan 59-05, corrected here by
 * plan 59-08). This sentence used to end "... at a given DPR, WITH A PRE-BAKED BEZEL DATA
 * URL THREADED IN." It stopped being true when 59-05 deleted the raster bezel: the
 * `bezelDataUrl` parameter, the `bezelDims(dpr)` call and `chrome/bezelUrl.ts` itself all
 * went with it, which the paragraph twenty lines below has recorded correctly since that
 * plan landed. The head is what was missed - 59-VERIFICATION.md gap 2 found it as the
 * ONE survivor of the WR-06 corrected-in-place sweep, a docblock contradicting its own
 * body sixteen lines down. The correction makes the two agree; the body's account of the
 * removal is left where it is rather than repeated here.
 *
 * Colours come ONLY from bakeRamp fixed
 * indices (panel/button = ramp.fill, lit = ramp.tlLight, shadow/outline =
 * ramp.brShadow, ink = ramp.ink) and the reserved accents (build = primary/focus,
 * fault = destructive, working = syntax string accent, item = syntax number/constant
 * accent - the last two feed Phase 39's CodeMirror theme); the substrate is ramp[0].
 * Font sizes are plain DPR-independent px (Phase 47 vector
 * contract - no device snap). The 8-point spacing scale + 44px min-target migrate
 * here from the retired theme.ts shim.
 *
 * THE BEZEL ROWS ARE NOW THREE, not six (CHROME-02, plans 59-03 and 59-05).
 * `--fab-bezel-ring`, `--fab-bezel-band` and `--fab-bezel-ring-shadow` are the whole
 * bezel: a pure-CSS concentric inset ring, exact at every fractional DPR because there
 * is nothing to rasterise. The three RASTER rows that used to sit above them -
 * `--fab-bezel-url`, `--fab-bezel-slice`, `--fab-bezel-width` - went dead in 59-03 (no
 * chrome rule read them) and were kept for exactly one plan so their removal would be a
 * provably zero-delta diff. Plan 59-05 removed them, together with the `bezelDims(dpr)`
 * call, the `bezelDataUrl` parameter and `chrome/bezelUrl.ts` itself. `chromeCss.test.ts`
 * still asserts that no chrome rule names any of the three, which now reddens on a
 * reintroduction from either side.
 *
 * `--fab-icon-md` / `--fab-icon-lg` WERE EMITTED HERE AND ARE NOT ANY MORE, and the
 * superseded claim is quoted rather than deleted because it is the shape of claim this
 * module has now made twice: "`--fab-icon-md` / `--fab-icon-lg` are emitted from
 * `iconSizes.ts`, the ONE declaration of the size ladder, so the CSS custom property and
 * the React `px` prop cannot drift." They could not drift because one of the two did not
 * exist: `grep -rn "var(--fab-icon-" frontend/` returned NOTHING - no CSS rule, no inline
 * style and no component read either token. That is the same defect this file's own spec
 * still guards against BY NAME for `--fab-bevel-depth` ("it was dead output that invited
 * drift. Assert it stays removed so it is not reintroduced without a consumer"), and two
 * new tokens were added here that fail that stated rule.
 *
 * Deleted rather than given a consumer, and the choice is not a coin flip. Sizing the
 * icons from CSS would need `.fab-glyph svg { width: var(--fab-icon-md) }` - which an
 * inline `width` from the `px` prop beats in the cascade anyway, so the token would still
 * be dead - and the `px` prop is a real per-call-site value (16 for the transport family
 * and the Legend key, 24 for the Palette), not a constant a stylesheet could carry.
 * `iconSizes.ts` remains the ONE declaration of the ladder; it is read by the `px` prop
 * default and by nothing else, which is now what the tree says as well as what it does.
 * Bible section 6c went in the SAME commit, as the bidirectional set gate requires.
 *
 * @param skin  A validated Skin (in production always LOCKED_SKIN).
 * @param dpr   devicePixelRatio (1 when omitted). Its ONE remaining consumer is the ring
 *              band snap: the ring THICKNESS is constant at every DPR by design.
 */
export function skinToCssVars(skin: Skin, dpr = 1): string {
  const ramp = bakeRamp(skin);
  return `:root{
--fab-substrate:${hex(skin.palette.ramp[0])};
--fab-panel-fill:${hex(ramp.fill)};
--fab-edge-lit:${hex(ramp.tlLight)};
--fab-edge-shadow:${hex(ramp.brShadow)};
--fab-outline:${hex(ramp.brShadow)};
--fab-ink:${hex(ramp.ink)};
--fab-btn-neutral:${hex(ramp.fill)};
--fab-btn-primary:${hex(skin.palette.accents.build)};
--fab-focus:${hex(skin.palette.accents.build)};
--fab-destructive:${hex(skin.palette.accents.fault)};
--fab-accent-working:${hex(skin.palette.accents.working)};
--fab-accent-item:${hex(skin.palette.accents.item)};
--fab-label-sand:${hex(skin.palette.labels.sand)};
--fab-label-stone:${hex(skin.palette.labels.stone)};
--fab-label-moss:${hex(skin.palette.labels.moss)};
--fab-label-lilac:${hex(skin.palette.labels.lilac)};
--fab-label-rose:${hex(skin.palette.labels.rose)};
--fab-label-clay:${hex(skin.palette.labels.clay)};
--fab-bezel-ring:${BEZEL_RING_CSS}px;
--fab-bezel-band:${bezelBandPx(dpr)};
--fab-bezel-ring-shadow:inset calc(-1 * var(--fab-bezel-band)) calc(-1 * var(--fab-bezel-band)) 0 0 var(--fab-edge-shadow),inset var(--fab-bezel-band) var(--fab-bezel-band) 0 0 var(--fab-edge-lit),inset 0 0 0 calc(2 * var(--fab-bezel-band)) var(--fab-outline);
--fab-font:"Martian Mono",monospace;
--fab-font-title:"Sono",monospace;
--fab-font-size-base:${FONT_BASE_CSS}px;
--fab-font-size-hero:${FONT_TITLE_CSS}px;
--fab-font-size-hud:${FONT_HUD_CSS}px;
--fab-space-xs:4px;
--fab-space-sm:8px;
--fab-space-md:16px;
--fab-space-lg:24px;
--fab-space-xl:32px;
--fab-space-2xl:48px;
--fab-space-3xl:64px;
--fab-min-target:${MIN_TARGET_PX}px;
}`;
}
