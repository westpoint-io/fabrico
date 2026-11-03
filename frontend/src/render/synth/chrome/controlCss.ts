// controlCss.ts - the control rules the app's chrome and a read-only board on a page both
// read: the panel text, title tier, bezel ring and panel fill, the hint ring, the chunky
// button with all its states, the inset field, and the visually-hidden helper.
//
// The text is the app's own, moved here verbatim from `chrome/chromeCss.ts`, comments
// included. It lives outside `chrome/` because a page's board bundle may not carry chrome
// modules. `chromeCss.ts` interpolates each group where its text sat, so the app's composed
// stylesheet is byte-for-byte what it was; `controlCss.test.ts` pins its sha256 and checks
// that every group here appears in it exactly once.
//
// One constant per contiguous stretch of the old stylesheet, because the stretches are not
// adjacent there (palette and dialog rules sit between them) and the app's order must not
// change. A stretch carries a neighbouring rule when moving it alone would split the text:
// `TOOL_BTN_CSS` holds `.fab-cta` and `.fab-swatch`, which share its selector lists, and
// `FIELD_CSS` holds the Help list's focus rule, which sits between two field rules.
//
// Every colour is a `--fab-*` token from `skinToCssVars`, so a board on a page gets the
// house look by declaring the same tokens under `:host`.

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
 * The literal is INTERPOLATED into the bezel rule in `PANEL_CSS` below (and through it
 * into the app's `CHROME_CSS`) rather than duplicated beside it, so the list and the rule
 * it scopes cannot drift apart. `chromeCss.test.ts` asserts
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

export const PANEL_CSS = `/* Shared chrome text: Martian Mono body at the 12px base size, rendered SMOOTH
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
}`;

export const HINT_CSS = `/* The lesson ring's paint, on the element inside the one the frame loop moves. The dark
   keylines either side keep the blue readable on the floor, a panel, a machine outline or a
   blue button. It carries no bezel, so it stays out of BEZEL_CLASSES. */
.fab-hint {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: 2px solid var(--fab-focus);
  box-shadow: 0 0 0 2px var(--fab-substrate), inset 0 0 0 2px var(--fab-substrate);
}
.fab-hint--port { border-radius: 50%; }`;

export const TOOL_BTN_CSS = `/* Chunky bezel buttons - a raised ring with bevel-driven states.

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
}`;

export const FIELD_CSS = `/* .fab-field - the app's FIRST form control (39 UI-SPEC Field Styling). The
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
}`;

export const VISUALLY_HIDDEN_CSS = `/* SHELL-03 / D-11 (plan 80.1-01): the accessible name survives the visible word's
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
}`;
