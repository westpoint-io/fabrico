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
// The only interpolations are the two imported font asset URLs (Vite-hashed) and the
// shared control groups from `controlCss.ts` (which carry `BEZEL_CLASSES`), NOT theme
// values; this module is otherwise theme-free.

import martianMonoUrl from '../assets/fonts/MartianMono.woff2';
import sonoUrl from '../assets/fonts/Sono.woff2';
import {
  FIELD_CSS,
  HINT_CSS,
  PANEL_CSS,
  TOOL_BTN_CSS,
  VISUALLY_HIDDEN_CSS,
} from '../render/synth/chrome/controlCss';

// The bezel set and the control rules a read-only board shares with the app live in
// `render/synth/chrome/controlCss.ts`, outside `chrome/`, so a page's board can read them
// without carrying the React chrome. `CHROME_CSS` interpolates each group exactly where its
// text sat, so the composed string is unchanged (`controlCss.test.ts` pins its sha256).
export { BEZEL_CLASSES } from '../render/synth/chrome/controlCss';

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

${PANEL_CSS}

${HINT_CSS}

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

${TOOL_BTN_CSS}

${FIELD_CSS}

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

${VISUALLY_HIDDEN_CSS}

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
