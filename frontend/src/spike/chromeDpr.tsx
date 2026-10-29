// DEV-ONLY DPR spike (CHROME-04, Plan 27-02; text stripped Plan 47-03; migrated off
// the raster bezel by Plan 59-03). Renders the SHIPPED chrome bezel at the live device
// pixel ratio so the crispness contract can be judged live and pixel-gated by
// dpr-crispness.spec.ts.
//
// SUPERSEDED RECIPE, QUOTED RATHER THAN DELETED. This fixture used to say it rendered
// "ONE hollow bezel panel via the EXACT Plan 01 recipe" naming four helpers - the shared
// bezel painter, the PixelMatrix-to-PNG data-URL adapter, and the two chrome bezel
// dimension/URL builders - ALL FOUR of which are now deleted symbols (the two chrome
// builders in plan 59-05, the painter and the data-URL adapter in plan 61-07). Their
// names are deliberately not re-typed: a mutation-history comment spelling a symbol
// nothing can resolve is what sends the next reader looking for it. The recipe used
// "the RESEARCH Pattern 1 device-exact
// border-image contract: border-style solid + border-width var(--fab-bezel-width),
// border-image-source var(--fab-bezel-url), border-image-slice var(--fab-bezel-slice)
// (NO fill keyword -> hollow center), border-image-repeat stretch", with corners mapping
// baked image px 1:1 onto device px. There is no baked image any more. Plan 59-03
// replaced the nine-slice with a pure-CSS concentric inset ring
// (--fab-bezel-ring-shadow): three bands of --fab-bezel-band each, device-snapped, with
// the element's own background showing through the unpainted body. Nothing is
// rasterised, so nothing can be resampled.
//
// IT APPLIES THE REAL RULES, NOT AN IMITATION. The fixture imports the shipped
// CHROME_CSS and the shipped skinToCssVars token block, so what it screenshots is the
// chrome the app ships. A hand-copied bezel here could drift from the chrome it exists
// to demonstrate, and the drift would be invisible: the baselines would keep passing
// against the copy.
//
// THE ZERO-BLEND-PIXEL EXACTNESS IS A PROPERTY OF THIS FIXTURE, NOT OF THE SHIPPED
// CHROME - say so here or a future reader files a real-app blend pixel as a regression.
// Every band is a whole number of device pixels only where the element's BORDER-BOX
// ORIGIN is itself at an integral device position. The crisp target below is pinned at
// viewport (0,0) by construction, which is what makes the tightened metric measurable at
// all. A real panel's origin lands wherever layout puts it: Palette.tsx is
// `position: absolute` with content-driven extent, so at DPR 1.25 its box can start on a
// fractional device pixel and produce a legitimate blend row.
//
// This module is NEVER imported by App.tsx / main.tsx; it is loaded only by the
// root-level chrome-dpr-spike.html dev fixture, which is not a build input (so it stays
// out of `dist`).
//
// WHY THE ELEVEN PLAN-59-06 BASELINES ARE TAKEN HERE AND NOT ON THE REAL APP ROUTE.
// Two reasons, and the first is the one that decides it. (1) The crisp target below is
// pinned at device pixel (0, 0) BY CONSTRUCTION, which is the only reason the tightened
// zero-blend metric is measurable at all; a real-app panel's origin lands wherever
// layout puts it and can legitimately start on a fractional device pixel. (2) The app
// route drags in the canvas, the graphics context, the app's ready gate and a role-based
// wait, for what is meant to be a text-free crispness strip. The honesty cost is paid by
// rendering the REAL components and the REAL classes below - never an imitation - so a
// drift between fixture and app is a drift in one shared declaration rather than in a
// copy. Recorded in 59-06-SUMMARY so the real-binary judgement rows say which surface
// was captured.
//
// ELEVEN IS NOW SEVEN (2026-10-11). The four brand-mark baselines (`logomark-dpr-*`) were
// retired with the square's component, LogoMark.tsx, because no production surface renders
// the square any more: since MARK-17 (phase 80.1) the header draws HeaderLockup, whose own
// four baselines are taken on the real app route in dpr-crispness.spec.ts. The square's
// geometry stays guarded where it is still used, as the icon source, by
// `chrome/iconMasterParity.test.ts` and `markSheet.test.ts`'s byte comparison (the icon
// raster pins guard the master, not the square). The heading above is kept
// as written because it records why the plan-59-06 set was taken here.

import { createElement, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { bakeRamp } from '../render/synth/palette.ts';
import { skinToCssVars } from '../render/synth/chrome/skinToCssVars.ts';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';
import { CHROME_CSS } from '../chrome/chromeCss.ts';
import { ICON_MD_PX, ICON_LG_PX } from '../render/synth/chrome/iconSizes.ts';
import { ART_ALIAS_OF, SUBJECT_OF } from '../render/layers/machines.ts';
import {
  PlayIcon,
  PauseIcon,
  StepIcon,
  UndoIcon,
  RedoIcon,
  SaveIcon,
  LoadIcon,
  NewIcon,
  FitIcon,
  WarningIcon,
  TrashIcon,
  BeltIcon,
  MachineGlyphIcon,
} from '../chrome/icons.tsx';

const hex = (n: number): string => '#' + (n >>> 0).toString(16).padStart(6, '0');

// The live device pixel ratio. It feeds the ring's hairline band snap
// (round(dpr)/dpr), which is the whole subject of this fixture.
const dpr = window.devicePixelRatio || 1;
const ramp = bakeRamp(LOCKED_SKIN);

const fillHex = hex(ramp.fill); // panel interior (#3b4250 for LOCKED_SKIN)
const litHex = hex(ramp.tlLight); // top/left lit band (#b0bacb, raised 32-01 SHELL-01)
const shadowHex = hex(ramp.brShadow); // bottom/right shadow band + hairline outline (#1b1f27)
const inkHex = hex(ramp.ink); // chrome ink (#b0bacb), self-reported for devtools

// --- THE PINNED ICON STRIP ---------------------------------------------------
//
// "The full icon export set" is NOT a specification. A baseline whose membership is
// described in prose can silently lose a subject and still regenerate green, so the
// strip's contents and its LEFT-TO-RIGHT order are an exported literal with a length
// pinned at 29 by dpr-crispness.spec.ts. A dropped cell reddens on the COUNT before
// anyone looks at a pixel.
//
// FOUR ROWS, each in a declaration order that ALREADY EXISTS IN SOURCE rather than an
// editorial one:
//   row 1, at the medium size - the eleven transport / file / warning glyphs in
//     `icons.tsx` declaration order;
//   row 2, at the medium size - the eight CANONICAL machine subjects in subject-registry
//     order, DERIVED from `SUBJECT_OF` at runtime (minus the declared `ART_ALIAS_OF`
//     rows, which draw byte-identical art and would mint duplicate cell ids) and never
//     typed out;
//   row 3, at the LARGE size  - the same eight, same order, same derivation;
//   row 4 - the belt glyph at the medium size, then at the large size.
// 11 + 8 + 8 + 2 = 29.
//
// ROW 2 IS NOT REDUNDANT WITH ROW 3. 16px is the TIGHTEST crispness case in the whole
// phase: it is where the 2u detail stroke lands on exactly 1.00 CSS px, the arithmetic
// the entire size ladder rests on, and it is the Legend's real shipped size.
//
// THE ENDPOINT SUBJECT HAS NO NAMED CONVENIENCE EXPORT. `icons.tsx` exports seven
// machine conveniences plus `BeltIcon`, while `SUBJECT_OF` carries eight CANONICAL
// subjects; the eighth, `endpoint`, is reachable only through `MachineGlyphIcon`. Rows 2
// and 3 are keyed off the REGISTRY precisely so the strip covers it and cannot lose it,
// and NO `EndpointIcon` export is added to tidy the asymmetry - inventing an export to
// make a table symmetrical is scope this phase does not have.

/** One cell of the pinned strip. `id` is what the spec names when a cell goes missing. */
export interface IconStripCell {
  /** Stable cell id, `<subject>@<size>`. Unique across the strip. */
  readonly id: string;
  /** The rendered size in CSS px: `ICON_MD_PX` (16) or `ICON_LG_PX` (24). */
  readonly px: number;
  /** The element this cell renders. Lazy so the literal itself is inert. */
  readonly render: () => JSX.Element;
}

/**
 * Row 1, a LITERAL in `icons.tsx` declaration order. These eleven have no canvas
 * equivalent and no registry to derive from, so the order is the source file's own.
 */
const TRANSPORT_GLYPHS = [
  ['play', PlayIcon],
  ['pause', PauseIcon],
  ['step', StepIcon],
  ['undo', UndoIcon],
  ['redo', RedoIcon],
  ['save', SaveIcon],
  ['load', LoadIcon],
  ['new', NewIcon],
  ['fit', FitIcon],
  ['warning', WarningIcon],
  ['trash', TrashIcon],
] as const;

/**
 * Rows 2 and 3, DERIVED. `SUBJECT_OF` is keyed by `machine_kind`, whose values are
 * small integers, so `Object.keys` yields them in ascending NUMERIC order - which for
 * this table (0, 2, 3, 4, 5, 6, 7, 9) is also its declaration order. A new subject
 * added to the registry lands here automatically and trips the length pin, which is the
 * whole point of deriving rather than transcribing: the strip grows with the registry
 * instead of drifting behind it.
 *
 * DECLARED ART ALIASES ARE SUBTRACTED (plan 72-09), and the reason is what this strip
 * measures. An alias resolves to the SAME `.svg` as its target, so its cell would be a
 * BYTE-IDENTICAL duplicate: it adds no raster evidence at any size, while moving all
 * four `chrome-icons-dpr-*.png` baselines to record the duplicate. Worse, the cell id is
 * `${SUBJECT_OF[kind]}@<size>`, so an alias would mint a SECOND `factory@md` and break
 * the "unique across the strip" contract this file's header states - leaving the spec
 * two cells it cannot tell apart.
 *
 * IT IS THE SAME SUBTRACTION `icons.test.tsx` MAKES, for the same reason, against the
 * same shipped table. The drift protection is unchanged for every CANONICAL subject,
 * and adding an alias is a source edit in `ART_ALIAS_OF` that a reviewer sees in a diff.
 */
const MACHINE_KINDS: readonly number[] = Object.keys(SUBJECT_OF)
  .map(Number)
  .filter((kind) => !Object.hasOwn(ART_ALIAS_OF, kind));

export const ICON_STRIP_ORDER: readonly IconStripCell[] = [
  ...TRANSPORT_GLYPHS.map(([name, Glyph]) => ({
    id: `${name}@md`,
    px: ICON_MD_PX,
    render: (): JSX.Element => createElement(Glyph, { px: ICON_MD_PX }),
  })),
  ...MACHINE_KINDS.map((kind) => ({
    id: `${SUBJECT_OF[kind]}@md`,
    px: ICON_MD_PX,
    render: (): JSX.Element => createElement(MachineGlyphIcon, { kind, px: ICON_MD_PX }),
  })),
  ...MACHINE_KINDS.map((kind) => ({
    id: `${SUBJECT_OF[kind]}@lg`,
    px: ICON_LG_PX,
    render: (): JSX.Element => createElement(MachineGlyphIcon, { kind, px: ICON_LG_PX }),
  })),
  {
    id: 'belt@md',
    px: ICON_MD_PX,
    render: (): JSX.Element => createElement(BeltIcon, { px: ICON_MD_PX }),
  },
  {
    id: 'belt@lg',
    px: ICON_LG_PX,
    render: (): JSX.Element => createElement(BeltIcon, { px: ICON_LG_PX }),
  },
];

/** The four row boundaries, as [start, end) indices into `ICON_STRIP_ORDER`. */
const STRIP_ROWS: readonly (readonly [number, number])[] = [
  [0, TRANSPORT_GLYPHS.length],
  [TRANSPORT_GLYPHS.length, TRANSPORT_GLYPHS.length + MACHINE_KINDS.length],
  [TRANSPORT_GLYPHS.length + MACHINE_KINDS.length, TRANSPORT_GLYPHS.length + MACHINE_KINDS.length * 2],
  [TRANSPORT_GLYPHS.length + MACHINE_KINDS.length * 2, ICON_STRIP_ORDER.length],
];

// --- Apply the SHIPPED tokens and the SHIPPED chrome rules ------------------
// The `bezelDataUrl` argument went dead in plan 59-03 (no rule reads --fab-bezel-url any
// more) and this fixture passed `''` to say so out loud. Plan 59-05 deleted the parameter
// as it said it would, so the call is two arguments and the fixture's independence from a
// baked image is now structural rather than declared.
const tokens = document.createElement('style');
tokens.id = 'fab-tokens';
tokens.textContent = skinToCssVars(LOCKED_SKIN, dpr);
document.head.appendChild(tokens);

const chrome = document.createElement('style');
chrome.textContent = CHROME_CSS;
document.head.appendChild(chrome);

// --- Build the DOM ---------------------------------------------------------
const root = document.getElementById('spike-root') as HTMLElement;

root.innerHTML = `
  <!-- Deterministic crispness target: fixed at the viewport top-left so its
       border-box origin is device pixel (0,0) at EVERY DPR. The automated
       dpr-crispness.spec.ts scans a 1px column down from y=0 through this ring,
       where band-to-band transitions cannot be smeared by a fractional box
       origin. The big panel below is for human eyeballing.

       box-sizing:border-box is a FIXTURE-only affordance (the shipped tree has no
       global sizing reset, and adding one would shrink every chunky button by
       12px); it is what keeps this probe exactly 48x48 device-aligned. -->
  <div class="fab-spike-crisp-target"
       style="
         position:fixed; top:0; left:0; z-index:9999;
         width:48px; height:48px; box-sizing:border-box;
         border:0;
         padding:var(--fab-bezel-ring);
         box-shadow:var(--fab-bezel-ring-shadow);
         background-color:var(--fab-panel-fill);
       "></div>

  <div style="padding:72px 24px 24px;display:flex;flex-direction:column;gap:24px;">
    <!-- Attribute-only DPR self-documentation (NO text nodes: the fixture is
         text-free by contract; read the data-* attributes in devtools or via
         the spec). -->
    <div id="dpr-readout"
         data-dpr="${dpr}"
         data-bezel-ring="${getComputedStyle(document.documentElement).getPropertyValue('--fab-bezel-ring').trim()}"
         data-bezel-band="${getComputedStyle(document.documentElement).getPropertyValue('--fab-bezel-band').trim()}"
         data-lit="${litHex}"
         data-fill="${fillHex}"
         data-shadow="${shadowHex}"
         data-ink="${inkHex}"></div>

    <!-- The human-facing bezel panel (part-a screenshot subject): the composed
         ring + fill, no children. -->
    <div class="fab-spike-panel"
         style="
           width:280px; height:160px; box-sizing:border-box;
           border:0;
           padding:var(--fab-bezel-ring);
           box-shadow:var(--fab-bezel-ring-shadow);
           background-color:var(--fab-panel-fill);
         "></div>
  </div>
`;

// --- THE FIVE PLAN-59-06 SUBJECTS, APPENDED ---------------------------------
//
// APPENDED, NEVER INTERLEAVED. The four re-blessed bezel baselines are an
// element-scoped screenshot of `.fab-spike-panel` and a fixed clip at the viewport's
// top-left corner. Everything below is added AFTER both, inside a NEW container, so
// neither the panel's box nor the crisp target's origin can move.
// dpr-crispness.spec.ts asserts that they did not, and `git status --porcelain` over
// the snapshot directory is the check.
//
// THE BRAND MARK SUBJECT IS GONE (2026-10-11). It sat between the strip and the disabled
// button and rendered the retired LogoMark component; its host div and render call were
// removed with that component. Removing it moves every later subject up by its 32 CSS px
// box plus the 24px gap, 56 CSS px, which is a whole number of device pixels at all four
// ratios (56 / 70 / 84 / 112), so no later subject changes its sub-pixel phase.
//
// EVERY SUBJECT IS A REAL COMPONENT OR A REAL CLASS. The strip renders the shipped
// icon components, the buttons carry the shipped
// `.fab-tool-btn` / `.fab-dialog-btn` classes and the panel carries the shipped
// `.fab-panel` with the shipped `[data-fab-panel-scroll]` wrapper. A hand-built
// imitation would produce baselines for something the app does not do, and the drift
// would be invisible because the baselines would keep passing against the copy.
//
// STILL TEXT-FREE. The buttons carry no labels: a label would put a webfont on the
// critical path of five zero-tolerance baselines to communicate nothing the ring,
// the fill and the ghost's flat border do not already show.

const extras = document.createElement('div');
extras.id = 'spike-extras';
// THE 72px LEFT INSET IS LOAD-BEARING, not styling. The crisp target is
// `position: fixed` at viewport (0, 0) with z-index 9999 and a 48x48 box, and an
// element-scoped screenshot scrolls its subject towards the top of the viewport - so any
// subject sitting at x < 48 gets the crisp target composited over its top-left corner.
// Observed on the first draft of the icon strip. Insetting every new subject past 48px
// makes the overlap impossible at any scroll position and any DPR.
extras.style.cssText =
  'padding:0 24px 24px 72px;display:flex;flex-direction:column;gap:24px;align-items:flex-start;';
extras.innerHTML = `
  <!-- The icon strip host. React renders the 29 pinned cells into it below. -->
  <div id="icon-strip" data-spike="icon-strip"
       style="
         background-color:var(--fab-substrate);
         padding:8px; width:max-content;
         display:flex; flex-direction:column; gap:8px;
       "></div>

  <!-- A DISABLED chunky button. THE SURFACE WITH NO COVERAGE BEFORE THIS PLAN:
       ".fab-tool-btn:disabled" used to declare "box-shadow: none", which under the
       paint-only ring erases the entire frame, and toolbar-stability.spec.ts is
       blind to it (measured in 59-05: stripping the ring leaves that spec GREEN).
       This baseline is the only pixel that can see a disabled button go ringless. -->
  <button class="fab-tool-btn" data-spike="toolbtn-disabled" type="button" disabled></button>

  <!-- The guard-dialog button row: the fifth ring-carrying class, which had NO pixel
       evidence at all, plus the one selector the ring walker deliberately cannot
       check. End-justified with the same gap the shipped dialog uses. -->
  <div data-spike="dialog-buttons"
       style="
         display:flex; justify-content:flex-end; gap:var(--fab-space-sm);
         width:360px; padding:var(--fab-space-sm);
         background-color:var(--fab-panel-fill);
       ">
    <button class="fab-dialog-btn" type="button"></button>
    <button class="fab-dialog-btn fab-dialog-btn--drain" type="button"></button>
    <button class="fab-dialog-btn fab-dialog-btn--danger" type="button"></button>
    <button class="fab-dialog-btn fab-dialog-btn--cancel" type="button"></button>
  </div>

  <!-- A content-driven .fab-panel for the DPR-stable rect proof. Its width is
       max-content over a fixed 120px child, so the outer box is
       120 + 2 * padding: if any token in that padding expression varied with the
       device pixel ratio, this rect would differ between the buckets. It DID, before
       this phase - the retired border was 6 / 9.6 / 8 / 6 CSS px - so the assertion
       is a real proof of the fix and not a tautology. A fixed-width panel would have
       been one. -->
  <div class="fab-panel" data-spike="rect-panel"
       style="width:max-content;padding:calc(var(--fab-space-md) + var(--fab-bezel-ring));">
    <div style="width:120px;height:40px;background-color:var(--fab-btn-neutral);"></div>
  </div>

  <!-- A SCROLLED config panel. The defect this exists for: an inset shadow is clipped
       to the PADDING box and paints above the background but BELOW the content, so if
       the ring carrier is also the scroll container its own scrolled content passes
       through the padding region and overpaints the top ring band - with a fully green
       board, because the rect gate reads geometry, the CSS walkers read declarations,
       and no baseline before this one captures a SCROLLED panel. The arrangement here
       is ConfigPanel.tsx's: the panel is the ring carrier, the inner
       [data-fab-panel-scroll] wrapper is the scroll container.

       ONE DELIBERATE DIFFERENCE FROM ConfigPanel.tsx SINCE THE PHASE-59 REVIEW (WR-08),
       stated so a reader does not take this markup for a copy. There, the wrapper
       carries a HORIZONTAL BLEED - margin 0 -16px with a matching 16px padding -
       because overflow-y:auto makes overflow-x compute to auto, so a scroll box with
       no horizontal padding clips the focus-visible outline off its full-width
       children (measured: 4px on the flush edge). The bleed widens only the CLIP box;
       panel geometry and child x positions are byte-identical either way, which is
       exactly why it is absent here and its absence changes nothing this baseline
       measures. This subject's property is the VERTICAL one - whether scrolled
       content reaches the top ring band - and the vertical arrangement is identical
       in both. Mirroring the bleed would move configpanel-scrolled-dpr-1.png for a
       change that cannot affect what it measures, and re-blessing a baseline to track
       a cosmetic mirror is how baselines stop being evidence. The focus-clip property
       is gated where it lives, on the real panel, by e2e/panel-io.spec.ts. -->
  <div class="fab-panel" data-spike="configpanel-scrolled"
       style="
         width:280px; height:200px; box-sizing:border-box;
         display:flex; flex-direction:column;
         padding:calc(var(--fab-space-md) + var(--fab-bezel-ring));
       ">
    <div data-fab-panel-scroll=""
         style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:var(--fab-space-sm);">
      <!-- The rows are --fab-edge-lit and NOT --fab-btn-neutral, deliberately.
           MEASURED: --fab-btn-neutral and --fab-panel-fill are the SAME value in the
           locked skin (#3b4250), so rows painted with it are invisible against the
           panel and the baseline could not show whether scrolled content had reached
           the ring. The lit edge is the brightest step in the ramp, so content
           arriving in the padding region would be unmistakable at a glance and in a
           diff. -->
      ${Array.from(
        { length: 12 },
        () =>
          '<div style="flex:0 0 auto;height:40px;background-color:var(--fab-edge-lit);"></div>',
      ).join('')}
    </div>
  </div>
`;
root.appendChild(extras);

// The 29 pinned cells, in four rows, rendered SYNCHRONOUSLY. `flushSync` is what makes
// the ready marker below an honest signal: a concurrent render could still be pending
// when `document.fonts.ready` resolves, and the spec would screenshot an empty strip.
flushSync(() => {
  createRoot(document.getElementById('icon-strip') as HTMLElement).render(
    STRIP_ROWS.map(([from, to], row) =>
      createElement(
        'div',
        {
          key: `row-${row}`,
          'data-strip-row': String(row + 1),
          style: { display: 'flex', gap: 8, alignItems: 'center' },
        },
        ICON_STRIP_ORDER.slice(from, to).map((cell) =>
          createElement(
            'span',
            { key: cell.id, 'data-strip-cell': cell.id, style: { display: 'flex' } },
            cell.render(),
          ),
        ),
      ),
    ),
  );
});

// Extend the attribute-only readout (still NO text nodes). `data-strip-len` is the
// literal's own length and `data-strip-rendered` is how many cells actually reached the
// DOM: the spec asserts both are 29 AND that they agree, so a literal that grows while
// the render silently drops a cell cannot pass.
const readoutNode = document.getElementById('dpr-readout');
if (readoutNode) {
  readoutNode.setAttribute('data-strip-len', String(ICON_STRIP_ORDER.length));
  readoutNode.setAttribute(
    'data-strip-rendered',
    String(document.querySelectorAll('[data-strip-cell]').length),
  );
}

// Scroll the config panel PAST ITS TOP before anything screenshots it. An unscrolled
// panel proves nothing here: the defect only appears once content has travelled under
// the padding region.
const panelScroll = document.querySelector<HTMLElement>(
  '[data-spike="configpanel-scrolled"] [data-fab-panel-scroll]',
);
// 100 and not a multiple of the 48px row pitch (40px row + 8px gap), deliberately: at a
// multiple the scroll box happens to open on a clean row boundary and the panel reads as
// if it were never scrolled. At 100 a row is CLIPPED flush against the scroll box's top
// edge, which puts content immediately adjacent to the padding region where the ring is
// painted - the exact adjacency the defect needs to be visible.
if (panelScroll) panelScroll.scrollTop = 100;

// Flag the fixture READY once fonts settle. The fixture renders no text, so this
// is a formality that keeps the spec's ready-signal contract stable across any
// future fixture change. document.fonts.ready always resolves, so this never
// hangs.
const markReady = (): void => {
  const readout = document.getElementById('dpr-readout');
  if (readout) readout.setAttribute('data-fixture-ready', '1');
};
if (document.fonts && typeof document.fonts.ready?.then === 'function') {
  document.fonts.ready.then(markReady);
} else {
  markReady();
}

// THE RAW PLAN-01 BAKE PRIMITIVES BLOCK WAS HERE AND IS DELETED (plan 59-03). It
// imported four symbols that no longer exist anywhere in the tree - the shared bezel
// painter, the PNG data-URL helper, the shipped corner-style constant and the painter's
// options type, all deleted by plan 61-07 - and baked a throwaway matrix purely so the
// fixture "demonstrably exercises the SAME painter the real chrome uses". The real chrome
// has no painter now: it has three CSS custom properties, and this fixture reads them off
// the shipped emitter and the shipped stylesheet, which is a stronger honesty guarantee
// than the reference it replaces. The four names are deliberately NOT re-typed above:
// naming a deleted symbol in a mutation-history comment is what sends the next reader
// looking for it.
