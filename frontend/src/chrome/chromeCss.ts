// The ONE injected chrome style block (CHROME-01/02/04), plus the CLOSED list of
// selectors that carry the bezel.
//
// WHY THIS IS A MODULE AND NOT A PRIVATE LITERAL IN App.tsx (plan 59-03, RESEARCH
// Pattern 4). Three deliverables need to reach this text and could not while it was
// `const CHROME_CSS` inside a 2650-line component that nothing imports from:
//   1. the CSS walker gates in `chromeCss.test.ts` parse every selector in it;
//   2. `BEZEL_CLASSES` has to be ONE exported literal that both those walkers and the
//      rule declaring the bezel consume, which is impossible while that rule lives
//      inside a module-private template literal;
//   3. `spike/chromeDpr.tsx` must apply the REAL rules for the plan 59-06 baselines
//      rather than a hand-copied imitation that can drift from the shipped chrome.
//
// SUPERSEDED CLAIM, QUOTED RATHER THAN DELETED (the tree's correct-in-place doctrine).
// The header this text arrived under said: "every panel + chunky button is a 9-slice
// `border-image` bezel driven by `--fab-bezel-url`". IT STOPPED BEING TRUE IN PLAN
// 59-03's SECOND TASK, which replaced the rasterised nine-slice with a pure-CSS
// concentric inset ring (`--fab-bezel-ring-shadow`), exact at every fractional DPR
// because there is nothing left to rasterise. Plan 59-05 then deleted `bezelUrl.ts` and
// the three `--fab-bezel-url` / `-slice` / `-width` rows outright.
//
// THIS PARAGRAPH ITSELF WAS STALE and is corrected here (phase 59 review WR-06). It was
// written BEFORE 59-03's second task landed and read, in the present tense: "That is
// still true in THIS commit and stops being true in the NEXT one: plan 59-03's second
// task replaces the rasterised nine-slice..." Both halves survived the task that
// falsified them, so a reader of the current tree was told, in the header of the
// stylesheet module, that the `border-image` bezel is live. It is a past-tense record
// now. `chromeCss.test.ts` GATE 1 forbids every one of those tokens from this file, in
// both a carrier-scoped and a whole-stylesheet form, so the prose above is quotable
// precisely because the walker strips comments before scanning.
//
// A PREDICTION IN THAT SAME PARAGRAPH FAILED, and is corrected here rather than quietly
// edited (plan 59-05). It said the three bake primitives - the chrome bezel URL builder,
// the shared bezel painter and the bezel dimension helper - were all "deleted in plan
// 59-05". Only two of the three were: the two chrome builders went with
// `chrome/bezelUrl.ts`, while a consumer grep found the canvas machine-body generator
// still calling the shared painter, so that painter was RETAINED for one more milestone.
// Reading it as chrome-only is what put it on an earlier draft's deletion list.
//
// THAT PREDICTION IS NOW DISCHARGED (plan 61-07). The shared bezel painter, its options
// type and all three pixel-era holdover constants are DELETED, along with the four belt
// bakes; what little of the painter the art board's historical TODAY column still needs
// is inlined at its one call site in `render/synth/generators.ts` with no exported name.
// Nothing in the chrome, and nothing on the canvas, bakes a bezel any more.
//
// WHAT IS STILL TRUE. Every colour is a `--fab-*` token from `skinToCssVars` (no
// theme.ts, no hand-authored hex); interaction is bevel-driven (raised -> lit hover ->
// inverted-bevel pressed -> build-accent focus outline -> desaturated disabled), not
// opacity. Running text is the Phase 47 vector pair: Martian Mono body at the 12px
// base, Sono ALL-CAPS on the title tier (.fab-title).
//
// The only interpolations are the two imported font asset URLs (Vite-hashed) and
// `BEZEL_CLASSES`, NOT theme values; this module is otherwise theme-free.

import martianMonoUrl from '../assets/fonts/MartianMono.woff2';
import sonoUrl from '../assets/fonts/Sono.woff2';

/**
 * THE CLOSED SET of bezel-carrying selectors. Six since plan 76-03 added the label swatch, and the set is closed.
 *
 * NOT READ OFF THE CSS BY EYE. An earlier reading of this stylesheet produced FOUR and
 * missed `.fab-dialog-btn`, which would have scoped the border clear, the padding
 * migration and both walker gates one selector short - the guard-dialog buttons would
 * have lost their frame with every gate green. So the list is grepped, not read, and
 * re-grepped in this session (plan 59-03, 2026-08-09) over `*.ts`, `*.tsx`, `*.css` and
 * `*.html` for the whole `border-image-*` family and for every `--fab-bezel-*` use:
 * shipped chrome CSS declares `border-image-*` in exactly FOUR rules covering FIVE
 * classes - the panel pair, the chunky-button pair, `.fab-dialog-btn`, and
 * `.fab-dialog-btn--cancel` as a NEGATIVE override.
 *
 * The literal is INTERPOLATED into `CHROME_CSS` below rather than duplicated beside it,
 * so the list and the rule it scopes cannot drift apart. `chromeCss.test.ts` asserts
 * this set EQUALS the ring-carrying selector set derived from the CSS at test time - set
 * equality, not membership, so a sixth bezel class cannot be added unnoticed in either
 * direction.
 */
export const BEZEL_CLASSES = [
  '.fab-panel',
  '.fab-dialog-panel',
  '.fab-tool-btn',
  '.fab-cta',
  '.fab-dialog-btn',
  // Phase 76 (plan 76-03, 76-UI-SPEC 5.2): the label colour swatch, the SIXTH carrier. It
  // wears the chunky button's ring and states, registered here so every walker gate in
  // `chromeCss.test.ts` covers it rather than seeing an unregistered ring.
  '.fab-swatch',
] as const;

/**
 * The ONE selector that legitimately opts OUT of the bezel: the flat low-emphasis
 * dismiss ghost on the guard dialogs.
 *
 * Length-pinned at 1 by `chromeCss.test.ts`, so widening this allowlist to hide a second
 * regression is a visible one-line diff rather than a silent pass.
 */
export const BEZEL_RING_EXEMPT = ['.fab-dialog-btn--cancel'] as const;

export const CHROME_CSS = `
/* Phase 47 (FEEL-05): both faces are single VARIABLE woff2 files, so the
   font-weight declares the RANGE the variable axis actually carries: a
   single-value declaration would make the browser synthesize missing weights by
   smearing (synthetic bold). Blocking display keeps the no-system-font-flash
   contract; the token-level monospace fallback covers a failed load. */
@font-face {
  font-family: 'Martian Mono';
  src: url(${martianMonoUrl}) format('woff2');
  font-weight: 100 800;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Sono';
  src: url(${sonoUrl}) format('woff2');
  font-weight: 200 800;
  font-style: normal;
  font-display: block;
}

/* Shared chrome text: Martian Mono body at the 12px base size, rendered SMOOTH
   (Phase 47 vector contract; the pixel-era smoothing-off pins are retired). */
.fab-panel,
.fab-dialog-panel {
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1;
  color: var(--fab-ink);
}

/* The shared title tier (Phase 47 D-02/D-06/D-08): Sono, ALL-CAPS, bold, with a
   touch of tracking. Every h1/h2 heading in the chrome takes this class; body
   labels stay on var(--fab-font). */
.fab-title {
  font-family: var(--fab-font-title);
  text-transform: uppercase;
  font-weight: 700;
  letter-spacing: 0.5px;
}

/* THE BEZEL, declared ONCE over the interpolated BEZEL_CLASSES literal.

   SUPERSEDED (plan 59-03): "9-slice contract (RESEARCH Pattern 1 / Pitfall 4):
   border-image paints NOTHING without border-style:solid + a border-width. The
   slice carries NO fill keyword, so the centre stays hollow and background-color
   fills the interior." There is no image any more. The bezel is a composed
   three-band concentric INSET RING (--fab-bezel-ring-shadow), device-snapped per
   band, with the element's own background showing through the unpainted 4px body.

   THE RING RESERVES NO SPACE. border-image reserved its ring in the BORDER area
   and its width VARIED with DPR (6 / 9.6 / 8 / 6 CSS px at DPR 1 / 1.25 / 1.5 / 2),
   so every panel and chunky button was physically a different size on a 125%
   display. "border: 0" plus 6px moved into "padding" keeps the DPR-1 border-box
   size and content-box origin to the pixel, and makes both IDENTICAL at every DPR.
   MEASURED before and after on the real app at all four DPRs: the header was
   1232x72 / 1232x78 / 1232x76 / 1232x72 and is now 1232x72 at every one; a transport
   button was 60x44 / 66x44 / 64x44 / 60x44 and is now 60x44 at every one; the Palette
   was 174 / 180 / 178 / 174 wide and is now 174 at every one.

   ONE CORRECTION TO THE CONTRACT THIS IMPLEMENTS, because a future reader will
   otherwise "fix" a number that is right. 59-UI-SPEC states there is no box-sizing
   reset in this tree so "a chunky button's outer size stays 44 + 12 = 56px" and
   warns that adding a reset "would shrink every chunky button by 12px on both axes".
   Measured: no reset exists ANYWHERE (correct), but a <button> is border-box by UA
   DEFAULT, so the chunky buttons were already border-box and are 60x44, not 56. The
   migration is exactly neutral for them BECAUSE of that: 6px moved from border to
   padding stays inside the same border box. Panels are content-box (plain
   div/header/aside) and are neutral for the other reason: padding 8 + 6 replaces
   border 6 + padding 8. Still do NOT add a sizing reset - it would be a no-op for the
   buttons and would silently reinterpret every panel's explicit width. */
${BEZEL_CLASSES.join(',\n')} {
  border: 0;
  box-shadow: var(--fab-bezel-ring-shadow);
}

.fab-panel,
.fab-dialog-panel {
  background-color: var(--fab-panel-fill);
}

.fab-palette-item {
  display: flex;
  align-items: center;
  gap: var(--fab-space-sm);
  min-height: var(--fab-min-target);
  padding: var(--fab-space-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--fab-ink);
  /* Buttons do NOT inherit font from the panel (UA form-control reset), so the
     Martian Mono base is set explicitly here (the raised ink #b0bacb passes AA
     normal text at any size, so no large-text bracket applies). */
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1;
  cursor: grab;
  text-align: left;
  transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
}
/* HOVER raises the item ink + glyph to the LIT EDGE (a bevel lit-edge brighten),
   never the build/working accent - build is reserved for CTA/focus/selection. The
   glyph is a currentColor-tinted mask, so lifting the item colour lifts it too. */
.fab-palette-item:hover {
  background: var(--fab-btn-neutral);
  border-color: var(--fab-edge-lit);
  color: var(--fab-edge-lit);
}
.fab-palette-item:active { cursor: grabbing; transform: translateY(1px); }
.fab-palette-item:focus-visible { outline: 2px solid var(--fab-focus); outline-offset: 2px; }
.fab-glyph { display: inline-flex; transition: color 120ms ease; }
/* ARMED (IX-03) - the "tool in hand" state, driven by React from gestures
   onArmedChange (NOT :hover). Build accent (SHELL-05: armed is a selection
   state): a 2px build-accent border + a persistent 3px inset left rail marker,
   with the label + currentColor glyph lifted to the build primary. Placed AFTER
   :hover so it wins at equal specificity and persists regardless of pointer. */
.fab-palette-item.is-armed {
  background: var(--fab-btn-neutral);
  border: 2px solid var(--fab-focus);
  color: var(--fab-btn-primary);
  box-shadow: inset 3px 0 0 0 var(--fab-btn-primary);
}

/* Chunky bezel buttons - a raised ring with bevel-driven states.

   THE STATE COMPOSITION RULE, and it is geometric rather than stylistic. Every
   shadow list on a ring carrier or a selector derived from one BEGINS with
   var(--fab-bezel-ring-shadow) and never replaces it. MEASURED in Chromium at
   DPR 1 (throwaway probe, plan 59-03 task 2), reading the first device pixels down
   the top edge of a 3-band ring plus a 3px lit highlight:

     ring alone                     -> lit, outline, fill      (1 + 1 + 4)
     highlight FIRST, ring last     -> lit lit lit             (the ring is ERASED)
     ring FIRST, highlight last     -> lit, outline, highlight (inside the ring)

   The first-listed shadow paints ON TOP, so a state highlight listed before the
   ring overpaints the frame it is meant to sit inside. 59-UI-SPEC asks for both
   "the highlight lands INSIDE the ring" and "the list ends with the ring token";
   those two are physically incompatible for inset shadows, which always paint from
   the padding-box edge inward. The first requirement is the real one, so the ring
   leads and the highlights follow, offset inward by two bands so their visible
   part begins exactly where the ring's outline ends.

   THE LIST LENGTH IS CONSTANT AT FIVE ENTRIES ACROSS EVERY STATE, all of them
   inset. These selectors declare "transition: box-shadow", and lists of unequal
   length with mismatched inset-ness do not interpolate: without the two
   zero-offset transparent placeholders at rest, the app's most-hovered surface
   would hard-jump its ENTIRE frame on every hover enter and leave. */
.fab-tool-btn,
.fab-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--fab-space-xs);
  min-width: var(--fab-min-target);
  min-height: var(--fab-min-target);
  padding: var(--fab-bezel-ring) calc(var(--fab-space-md) + var(--fab-bezel-ring));
  box-shadow: var(--fab-bezel-ring-shadow),
              inset 0 0 0 0 transparent,
              inset 0 0 0 0 transparent;
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1;
  cursor: pointer;
  transition: filter 120ms ease, box-shadow 120ms ease, transform 80ms ease;
}
.fab-tool-btn { background-color: var(--fab-btn-neutral); color: var(--fab-ink); }
/* THE LABEL COLOUR SWATCH (phase 76, plan 76-03, 76-UI-SPEC 5.2): exactly 44 by 44,
   padding 0, the chunky button's ring and every one of its states (the selector lists
   below name it beside .fab-tool-btn). A new class because .fab-tool-btn spends its
   horizontal padding before any content (Toolbar.tsx "MEASURE THE BUTTON"): six
   icon-only .fab-tool-btns measure 424 px and overflow the 338 px panel at a 1024 px
   window; six swatches at the 8 px gap measure 304 px and fit. */
.fab-swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--fab-min-target);
  height: var(--fab-min-target);
  padding: 0;
  box-shadow: var(--fab-bezel-ring-shadow),
              inset 0 0 0 0 transparent,
              inset 0 0 0 0 transparent;
  background-color: var(--fab-btn-neutral);
  cursor: pointer;
  transition: filter 120ms ease, box-shadow 120ms ease, transform 80ms ease;
}
.fab-cta { background-color: var(--fab-btn-primary); color: var(--fab-substrate); }
/* Redundant with the rule above TODAY, and it is not deletable noise: it is a
   LATER rule at equal specificity, so leaving it at "0 ...md" would re-zero the
   vertical ring padding on every labeled button. */
.fab-tool-btn--labeled { padding: var(--fab-bezel-ring) calc(var(--fab-space-md) + var(--fab-bezel-ring)); }
/* SHELL-02 CTA-clip reclaim (Phase 34): the Toolbar accumulates the most labeled
   controls (Legend, Labels, Save, Load) and, after the "?" Help button landed,
   overran 1024px at DPR 2 (the then-active DPR font-snap widened text) and clipped the primary
   CTA. Tighten ONLY the toolbar's labeled buttons to the sm inter-token so the
   right cluster (Save/Load/CTA) reclaims ~16px each without hiding a label or
   shrinking the CTA - dialogs/palette labeled buttons keep the roomier md padding.
   8px still reads uncramped around the 12px labels. Scoped to the header so
   it can never relayout another surface.
   Phase 55 extends the SAME reclaim to the header CTA: the "Examples" label is
   a single unwrappable word, so (unlike the old three-word CTA) the right
   cluster's min-content cannot compress through it under width squeeze - the
   sm padding is what keeps the WINDOWS-id-4 minimum non-clipping width inside
   the ledgered 992/1106 bounds. Dialog/palette CTAs keep the md padding.
   Plan 59-03 adds the ring to BOTH axes here; the horizontal base stays at the
   RECLAIMED sm token and never silently widens back to md.
   Plan 91-10 (CHROME-15, D-14, UI-SPEC 5.1) WIDENS the labelled half of this list
   from .fab-tool-btn--labeled to every header .fab-tool-btn, so the icon
   buttons (transport, Undo, Redo, Help) take the same sm + ring side padding and
   measure exactly 44 x 44 instead of 60 x 44: one of the four reclaims that put
   the whole wordmark inside a 1024 CSS px window. Still one declaration, so the
   DPR-invariance census in e2e/dpr-crispness.spec.ts counts the same sites.
   The same plan made Examples a plain labelled button, so the header holds no
   .fab-cta any more and the CTA half of this list is gone with it. */
header.fab-panel .fab-tool-btn { padding: var(--fab-bezel-ring) calc(var(--fab-space-sm) + var(--fab-bezel-ring)); }

/* HOVER = brighter lit edge (a lit inset highlight), never opacity. The highlight
   is offset inward by two bands so it lands in the ring's body, just inside the
   hairline outline, exactly where it landed when the bezel occupied the border
   area and the inset shadow was clipped to the padding box. */
.fab-tool-btn:hover,
.fab-cta:hover,
.fab-swatch:hover {
  filter: brightness(1.12);
  box-shadow: var(--fab-bezel-ring-shadow),
              inset calc(2 * var(--fab-bezel-band) + 1px) calc(2 * var(--fab-bezel-band) + 1px) 0 0 var(--fab-edge-lit),
              inset 0 0 0 0 transparent;
}
/* PRESSED = INVERTED bevel: the lit/shadow edges swap (shadow top-left, lit
   bottom-right) so the button reads pushed-in, plus a 1px sink. The identical
   reading is exposed as an .is-pressed modifier for stateful toggle buttons. */
.fab-tool-btn:active,
.fab-cta:active,
.fab-swatch:active,
.fab-tool-btn.is-pressed,
.fab-cta.is-pressed,
.fab-swatch.is-pressed {
  transform: translateY(1px);
  filter: brightness(0.92);
  box-shadow: var(--fab-bezel-ring-shadow),
              inset calc(2 * var(--fab-bezel-band) + 2px) calc(2 * var(--fab-bezel-band) + 2px) 0 0 var(--fab-edge-shadow),
              inset calc(-2 * var(--fab-bezel-band) - 2px) calc(-2 * var(--fab-bezel-band) - 2px) 0 0 var(--fab-edge-lit);
}
/* FOCUS = build-accent outline, offset so it never shifts layout. */
.fab-tool-btn:focus-visible,
.fab-cta:focus-visible,
.fab-swatch:focus-visible {
  outline: 2px solid var(--fab-focus);
  outline-offset: 2px;
}
/* DISABLED = CONSTANT bezel geometry (SHELL-02), and THE SINGLE MOST DANGEROUS
   LINE IN THIS PHASE, so it is spelled out rather than left to a reader.

   This rule used to declare "box-shadow: none". Under the retired border-image
   bezel that cancelled only the hover/pressed HIGHLIGHT, because the frame lived
   in the border area. Under the ring the frame IS the box-shadow, so the same
   line would erase the entire bezel of every disabled button - and no baseline
   covers a disabled toolbar button, so it would have shipped with a fully green
   board. It carries the composed ring like every other state, and
   chromeCss.test.ts reddens if the cancellation ever returns.

   The dead "border-color: var(--fab-outline)" is gone with it: there is no border.
   filter/background/transform/cursor stay - "filter" applies to the element's whole
   rendered output including its shadows, so the ring desaturates with the button,
   which is the correct reading.

   SHELL-02 GETS STRONGER, not merely preserved. The earlier defect was this rule
   swapping border-image-source:none + border-width:1px (a ~5px/side bevel
   collapse), which re-inflated Undo/Redo on enable and shifted the centered
   transport cluster. The ring is now PAINT ONLY, so no RING mutation can move a
   disabled button's footprint.

   OVERSTATED BY ONE STEP, CORRECTED IN PLACE AFTER MEASUREMENT (plan 59-05). This
   paragraph went on to say "a disabled button physically cannot change footprint:
   the reflow is structurally impossible rather than avoided by discipline. The
   cost, stated honestly, is that e2e/toolbar-stability.spec.ts's
   equal-bounding-box case becomes a TAUTOLOGY". 59-05 ran both halves as real
   mutations against the running app. Ring stripped alone: that spec stayed GREEN
   (the ring half IS a tautology) while the two walker gates here went RED three
   ways. Ring stripped PLUS "border: 1px solid var(--fab-outline)" re-added: that
   spec went RED on the equal-bounding-box assertion, because these buttons are
   auto-width, so a border still grows the outer box by 2px. The reflow is
   therefore NOT structurally impossible - the 32-04 defect verbatim still
   reproduces, and the spec still catches it. What became unfalsifiable is
   narrower: a disabled button LOSING its ring. Its replacement guards are the two
   walker gates here and plan 59-06's disabled-button baseline; the full
   measurement is in that spec's own comment. */
.fab-tool-btn:disabled,
.fab-cta:disabled,
.fab-swatch:disabled {
  background-color: var(--fab-panel-fill);
  color: var(--fab-ink);
  filter: saturate(0) brightness(0.8);
  box-shadow: var(--fab-bezel-ring-shadow),
              inset 0 0 0 0 transparent,
              inset 0 0 0 0 transparent;
  transform: none;
  cursor: not-allowed;
}

/* .fab-field - the app's FIRST form control (39 UI-SPEC Field Styling). The
   bevel language of .fab-tool-btn but reading as an INSET well (fields recede,
   buttons raise): the substrate fill is darker than the panel body, a neutral
   1px lit edge, the build-accent focus outline (offset), a desaturated disabled
   reading, and the destructive border for aria-invalid. Tokens only, no hex. */
.fab-field {
  min-height: var(--fab-min-target);
  padding: 0 var(--fab-space-sm);
  background-color: var(--fab-substrate);
  color: var(--fab-ink);
  border: 1px solid var(--fab-edge-lit);
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1;
}
.fab-field:focus-visible {
  outline: 2px solid var(--fab-focus);
  outline-offset: 2px;
}
/* The Help list's scroll box (phase 91, UI-SPEC 7.3, the one rule the phase adds). It scrolls only
   on a short window and takes tabIndex 0 so a keyboard can scroll it, so it shows the house focus
   ring. The offset is inward (-2px), as UI-SPEC 7.3 states, so the ring is drawn inside the box
   and never over the heading above it or the panel's bezel. No colour or token is added. */
[data-fab-help-scroll]:focus-visible {
  outline: 2px solid var(--fab-focus);
  outline-offset: -2px;
}
.fab-field:disabled {
  filter: saturate(0) brightness(0.8);
  cursor: not-allowed;
}
.fab-field[aria-invalid="true"] {
  border-color: var(--fab-destructive);
}

/* Delete guard dialog (REND-03) - the one modal. Centered scrim + bezel panel;
   three buttons at >=44px. Danger = destructive fault hue; Drain = a neutral
   secondary bezel MIGRATED off the canvas-reserved working accent (the working
   emerald is canvas-only, never chrome); Cancel = a flat low-emphasis ghost. */
.fab-dialog-scrim {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--fab-space-lg);
  background: color-mix(in srgb, var(--fab-substrate) 65%, transparent);
}
/* Padding rule C1. BOTH guard dialogs get their padding HERE - neither
   DeleteGuardDialog nor QuitGuardDialog declares any inline padding. */
.fab-dialog-panel {
  width: calc(100% - (var(--fab-space-xl) * 2));
  max-width: 420px;
  padding: calc(var(--fab-space-lg) + var(--fab-bezel-ring));
}
/* The guard-dialog button is a FIRST-CLASS ring carrier, not a variant of
   .fab-tool-btn - and an earlier reading of this stylesheet missed exactly that,
   which would have left these three buttons frameless with every gate green. It is
   in BEZEL_CLASSES, in both walkers, in the exhaustiveness gate and in padding
   rule C5. "min-height" stays on the CONTENT box and it carries no min-width, so
   its width stays content-driven, exactly as today. No :disabled rule is added:
   none exists, and the disabled hazard is a chunky-button problem. */
.fab-dialog-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--fab-min-target);
  padding: var(--fab-bezel-ring) calc(var(--fab-space-md) + var(--fab-bezel-ring));
  box-shadow: var(--fab-bezel-ring-shadow),
              inset 0 0 0 0 transparent,
              inset 0 0 0 0 transparent;
  background-color: var(--fab-btn-neutral);
  color: var(--fab-ink);
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1;
  cursor: pointer;
  transition: filter 120ms ease, box-shadow 120ms ease, transform 80ms ease;
}
/* Both state rules CLOBBERED the frame before plan 59-03 (each declared a bare
   box-shadow that, under the ring, would replace it). Brought under the same
   ring-leads composition rule as the chunky buttons. */
.fab-dialog-btn:hover {
  filter: brightness(1.12);
  box-shadow: var(--fab-bezel-ring-shadow),
              inset calc(2 * var(--fab-bezel-band) + 1px) calc(2 * var(--fab-bezel-band) + 1px) 0 0 var(--fab-edge-lit),
              inset 0 0 0 0 transparent;
}
.fab-dialog-btn:active,
.fab-dialog-btn.is-pressed {
  transform: translateY(1px);
  filter: brightness(0.92);
  box-shadow: var(--fab-bezel-ring-shadow),
              inset calc(2 * var(--fab-bezel-band) + 2px) calc(2 * var(--fab-bezel-band) + 2px) 0 0 var(--fab-edge-shadow),
              inset calc(-2 * var(--fab-bezel-band) - 2px) calc(-2 * var(--fab-bezel-band) - 2px) 0 0 var(--fab-edge-lit);
}
.fab-dialog-btn:focus-visible { outline: 2px solid var(--fab-focus); outline-offset: 2px; }
/* Cancel = flat ghost, the low-emphasis dismiss, restated WITHOUT an image.
   "border-image-source: none" is meaningless once no image exists and
   "border-width: 1px" against "border: 0" was a re-assertion, not an override.
   This is the ONE sanctioned ring cancellation in the chrome and the single member
   of BEZEL_RING_EXEMPT, whose length is pinned at 1. */
.fab-dialog-btn--cancel {
  box-shadow: none;
  border: 1px solid var(--fab-outline);
  background-color: transparent;
  color: var(--fab-ink);
}
/* THE GHOST HAS TO CANCEL ITS STATE RINGS TOO, and this was found by MEASURING the
   open dialog rather than by reading the cascade. ".fab-dialog-btn:hover" is
   specificity (0,2,0) and ".fab-dialog-btn--cancel" is (0,1,0), so the state rules
   WIN over the ghost. Under the retired mechanism that was harmless - hover added a
   1px lit highlight inside the flat border, which reads as a lift. Under the ring the
   same cascade grows the low-emphasis dismiss a FULL chunky bezel the instant the
   pointer touches it, destroying the emphasis hierarchy of the guard dialog at
   exactly the moment the user is reading it. These rules are (0,2,0) and come later,
   so they win; filter and translate are inherited from the base state rules, so the
   ghost keeps its feedback and never grows a frame. Every selector here normalises
   to .fab-dialog-btn--cancel, so the exempt allowlist stays length 1. */
.fab-dialog-btn--cancel:hover,
.fab-dialog-btn--cancel:active,
.fab-dialog-btn--cancel.is-pressed {
  box-shadow: none;
}
/* Drain = the neutral secondary bezel (safe path read via the label, not a hue). */
.fab-dialog-btn--drain { background-color: var(--fab-btn-neutral); color: var(--fab-ink); }
/* Danger = destructive fault hue, dark substrate ink. */
.fab-dialog-btn--danger {
  background-color: var(--fab-destructive);
  color: var(--fab-substrate);
}

/* SHELL-03 / D-11 (plan 80.1-01): the accessible name survives the visible word's
   removal. The header lockup draws the product name as outlined geometry and is
   aria-hidden, so the document's one level-1 heading lives here, out of layout but in
   the accessibility tree. clip-path: inset(50%) rather than the deprecated
   clip: rect(...); white-space: nowrap so the name is not reflowed into a tall sliver
   that would reintroduce a scroll box. */
.fab-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* D-09 IS SUPERSEDED AND THE RULE THAT LIVED HERE IS GONE (plan 80.1-04, 2026-09-08).
   It read:

     .fab-header-lockup [data-part="plate"] { shape-rendering: geometricPrecision; }

   and it scoped the hint to the plate ALONE, on the argument that the plate is the only
   path in the cut carrying a curve so the root's crispEdges should still govern the other
   eleven. The maintainer overturned that on the real WebKitGTK binary, at 8x, in the same breath as
   approving the lockup: "I'd enable anti aliasing for the logo and future animations of
   it". The hint therefore belongs to the WHOLE cut, and it now lives on the component root
   as an inline shapeRendering that all twelve paths inherit, which is one source of truth
   instead of an inline attribute and a stylesheet rule disagreeing. See HeaderLockup.tsx.
   The reason the widening is right and not merely instructed: crispEdges snaps edges to
   whole device pixels, which suits a glyph whose every stroke edge sits on an even unit
   (the retired 32u square, removed 2026-10-11, was the case in point) and is wrong here, because the cut's belt structure stroke is 0.531 CSS px and its cell
   outline 0.354 CSS px, and a sub-pixel stroke snapped to whole pixels becomes a hard
   on/off dotted rule rather than a line.

   AND THE CLASS ITSELF IS GONE TOO (code review 80.1 WR-06). Deleting the rule left
   fab-header-lockup on the component root with nothing selecting it anywhere: not this
   stylesheet, not Toolbar.tsx, and not logo.spec.ts, chrome-icons.spec.ts or
   dpr-crispness.spec.ts, all of which select on the data-testid attribute instead. A unit
   case was still pinning the class, with a stated reason that was untrue of both consumers
   it named. If a rule ever needs a hook here again, the class comes back in the commit that
   adds the rule. */
`;
