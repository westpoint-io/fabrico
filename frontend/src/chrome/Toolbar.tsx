// Toolbar.tsx — the transport toolbar (UI-SPEC "React Chrome Layout", top edge).
//
// A slim floating bar: left = the "Fabrico" wordmark (Sono title tier); center =
// transport Play/Pause + Step + Undo/Redo + a tick counter read from the
// echoed scene; right = Save / Load (Phase-6 capability surfaced as buttons) and
// the "Examples" button (EX-02: the disclosure trigger for the ExamplesPopover,
// the old "Load demo scene" CTA relocated into it verbatim; a plain labelled
// button since plan 91-10, no longer the build-blue primary CTA). This component owns the chrome only; App supplies the real
// handlers that route each control to a host command through the transport
// control seam (18-05).
//
// CHROME-01 / CHROME-02, CORRECTED IN PLACE BY PLAN 59-02. This paragraph used to say
// "every icon is a bit-matrix component from icons.tsx (no vector icon library, no inline
// vector markup)". The bit matrices are deleted; every icon here is now an inline `<svg>`
// built from an authored `chrome/assets/*.svg`. The prohibition that clause really served
// - NO VECTOR ICON LIBRARY - is permanent and untouched (ART-04 provenance); "no inline
// vector markup" was a proxy for it that inverted the day the canvas became vector art.
// The three FILE buttons carry no glyph at all; see the comment at the New button.
// Otherwise unchanged: every colour/spacing/font is a
// --fab-* token (no theme.ts, no hand-authored hex), running text is Martian
// Mono at the 12px base (the raised ink passes AA normal text at any size, so
// no large-text bracket applies), and states are bevel-driven
// (playing = pressed/inverted bevel; disabled Undo/Redo = flat/desaturated no-bevel
// from the .fab-tool-btn:disabled rule, never opacity).

import type { JSX, Ref } from 'react';
import type { SceneWireId } from '../transport/transport';
import type { StatusKind } from './controlHandlers';
import type { SceneDisplayName } from './sceneLoad';
import { ICON_MD_PX } from '../render/synth/chrome/iconSizes';
import { EXAMPLES_POPOVER_ID, ExamplesPopover } from './ExamplesPopover';
import { HeaderLockup } from './HeaderLockup';
// LoadIcon / NewIcon / SaveIcon are deliberately NOT imported: the three file buttons
// carry no glyph (plan 59-02, remedy step 3 - see the comment at the New button). The
// three components still exist, are still exported and are still gated; they simply
// have no call site in the header while the WINDOWS-id-4 width budget is this tight.
import { PauseIcon, PlayIcon, RedoIcon, StepIcon, UndoIcon } from './icons';
import { SIM_STOPPED_COPY } from './SimStoppedCard';
import { StatusReadout } from './StatusReadout';
import { SHORTCUTS } from '../input/shortcuts';

export interface ToolbarProps {
  /** The sim tick from the echoed scene (mono counter). */
  tick: number;
  /** Whether the sim is currently playing (toggles the Play/Pause glyph). */
  playing: boolean;
  onPlayPause: () => void;
  onStep: () => void;
  /** SAVE-04: start a truly empty board (host-swap New). */
  onNew: () => void;
  /**
   * SAVE-03 smart-Save. `saveAs=true` (Shift-click) forces the Save-As prompt;
   * a plain click re-saves to the known path with no dialog.
   */
  onSave: (saveAs?: boolean) => void;
  onLoad: () => void;
  /** EX-02: whether the Examples popover is open (drives aria-expanded + mount). */
  examplesOpen: boolean;
  /** Toggle the Examples popover open/closed (the CTA click). */
  onToggleExamples: () => void;
  /** Close the Examples popover (Escape inside it; App returns focus to the CTA). */
  onCloseExamples: () => void;
  /** Fire the guarded scene load for a selected popover entry (App closes first). */
  onLoadScene: (id: SceneWireId) => void;
  /** App's ref to the CTA so every popover close path can return focus to it. */
  examplesTriggerRef?: Ref<HTMLButtonElement>;
  /** Emit an Undo (gesture channel) — fired only while `canUndo` (App-gated). */
  onUndo: () => void;
  /** Emit a Redo (gesture channel) — fired only while `canRedo` (App-gated). */
  onRedo: () => void;
  /** Whether the live session has an undoable action — greys the Undo button. */
  canUndo: boolean;
  /** Whether the live session has a redoable action — greys the Redo button. */
  canRedo: boolean;
  /**
   * Plan 74.1-31 (PAUSE-TOOLBAR): edits made on a paused board have not landed yet, so
   * Undo and Redo are held (App's `doUndo` / `doRedo` send nothing). Both buttons render
   * disabled with a title naming why, whatever `canUndo` / `canRedo` say. Optional so a
   * caller with no paused queue is unchanged (absent = false).
   */
  undoHeld?: boolean;
  /**
   * Plan 74.1-31: where the status strip hangs, measured by App: `right` is the strip's
   * right edge in px from the header's right edge, `maxWidth` the band it may fill (right
   * of the Palette, left of a top-right panel). Absent = the header's right end, no bound.
   */
  statusStripPlacement?: { right: number; maxWidth: number } | null;
  /**
   * SHELL-07 honest Save/Load status display string (generic copy, never a file
   * path). Empty string = idle (the live region persists but renders nothing).
   */
  status: string;
  /**
   * SAFE-01: the current status KIND, forwarded to StatusReadout so the sticky
   * `disconnected` fault state renders the destructive tint + glyph + word while
   * every other kind stays the passive ink readout.
   */
  statusKind: StatusKind;
  /** READ-01: whether the collapsible Legend panel is open (drives aria-expanded). */
  legendOpen: boolean;
  /** Toggle the Legend panel open/closed. */
  onToggleLegend: () => void;
  /** READ-01: whether the persistent machine-name reveal is on (drives aria-pressed). */
  labelsToggled: boolean;
  /** Toggle the persistent machine-name reveal (Alt-hold is the momentary sibling). */
  onToggleLabels: () => void;
  /** READ-01: the stable DOM id of the Legend panel the Legend button controls. */
  legendPanelId: string;
  /**
   * ONB-01 generalized (EX-02): the loaded shipped-scene DISPLAY NAME, or null
   * when a user board (New / Load) is up (null renders no badge). Same passive
   * readout idiom. The union is IMPORTED from sceneLoad.ts (its single source of
   * truth, 1:1 over the closed `SceneWireId` set) rather than re-declared here,
   * so a third example is one edit in one file (WR-12).
   */
  loadedScene: SceneDisplayName | null;
  /**
   * SAVE-05: whether the board has unsaved edits, gates the passive "Unsaved"
   * badge (a role=status aria-live readout, --fab-ink, NEVER the build accent).
   */
  dirty: boolean;
  /** ONB-03: whether the collapsible Help panel is open (drives aria-expanded). */
  helpOpen: boolean;
  /** Toggle the Help panel open/closed. */
  onToggleHelp: () => void;
  /** ONB-03: the stable DOM id of the Help panel the "?" button controls. */
  helpPanelId: string;
  /**
   * FAIL-01 (phase 90, D-12, UI-SPEC 1.4): the host's sim loop has ended. Every control that
   * would send to it (Play, Step, Undo, Redo, New, Save, Load, Examples) renders disabled with
   * `SIM_STOPPED_COPY.disabledTitle`, accessible names unchanged, and Play shows the Play glyph
   * unpressed, because the sim is not running. Optional; absent is false.
   */
  simStopped?: boolean;
}

// SHELL-04 chrome icon size. CORRECTED IN PLACE BY PLAN 59-02 (CHROME-01); the rationale
// this replaces read:
//
//   "the transport / save / load glyphs are sized to the base LABEL cap-height, not the
//   em. At the de-inflated base font (16px CSS @ DPR 1) the cap-height is ~11px, so the
//   glyph should read at ~half the em ... The box-shadow sprite (icons.tsx) can only
//   paint at integer multiples of its 8px grid to stay pixel-crisp, so 8px is the crisp
//   step nearest the cap-height."
//
// BOTH of its premises stopped being true, and neither stopped quietly.
//
//   1. "the de-inflated base font (16px CSS @ DPR 1)" is STALE. Phase 47 moved
//      `--fab-font-size-base` to 12px, so the cap-height the 8px was derived from is not
//      the cap-height this app has had for eleven phases.
//   2. "the box-shadow sprite can only paint at integer multiples of its 8px grid" names
//      a RENDER PATH THIS PLAN DELETED. There is no sprite, no matrix and no 8px grid;
//      every chrome icon is now an inline `<svg>` over an authored 32u asset.
//
// THE REAL FLOOR, which is a measurement rather than a proportion. A chrome glyph's
// thinnest stroke is the 2u detail weight on a 32u grid, so at box size `px` it renders
// at `px / 32 * 2` CSS px. That reaches one whole CSS pixel at exactly px = 16, and below
// it the detail stroke is sub-pixel grey mush - which is the crispness defect this
// milestone exists to fix, not a size preference. `ICON_MD_PX` is that floor, declared
// once in `render/synth/chrome/iconSizes.ts` with the derivation beside it, and it is the
// same number `LOD_MIN_MACHINE_PX = 16` arrives at from the canvas side.
//
// EVERY icon-bearing button in this header grows by 8px, and the spec says otherwise.
// 59-UI-SPEC claims the ladder "does not widen the icon-only buttons (Play/Pause/Step/
// Undo/Redo/Fit all sit inside min-width: var(--fab-min-target) = 44px)". MEASURED, that
// is false: `.fab-tool-btn` spends the whole 44px touch-target floor on horizontal chrome
// BEFORE the glyph is placed, so every pixel of icon adds directly to the width. Four
// transport buttons at +8px plus three labeled file buttons at +8px is +56px on the
// header, against 2px of ledgered slack. The remedy reached is step 3 - see the comment
// at the New button and 59-02's SUMMARY.
//
// THE ARITHMETIC IS RESTATED AGAINST THE SHIPPED DECLARATION (phase 59 review WR-06).
// This paragraph read "`.fab-tool-btn`'s `padding: 0 var(--fab-space-md)` (32px) plus
// `border-width: var(--fab-bezel-width)` (12px at DPR 1) already totals 44px". NEITHER
// declaration exists any more: plan 59-03's padding migration made the rule
// `padding: var(--fab-bezel-ring) calc(var(--fab-space-md) + var(--fab-bezel-ring))` and
// `border: 0`, which is `6px 22px` with no border - 22 + 22 = the same 44px of horizontal
// chrome. The total is unchanged, which is exactly what made the stale text hard to
// notice, and `--fab-bezel-width` is a token `chromeCss.test.ts` GATE 1 now exists to
// forbid. The MEASUREMENT the paragraph reports is unaffected: it was taken on the live
// DOM (60px per transport button at 16px icons, 52px at 8px) and 59-03's migration is
// width-neutral by construction.
const TOOLBAR_ICON_PX = ICON_MD_PX;

// WR-04 fixed tick-slot ceiling, MOVED IN PLACE BY PLAN 91-10 (CHROME-15, D-14, UI-SPEC 5.1).
// It read: "TICK_COMPACT_THRESHOLD switches to compact notation ("100M", "1.2B", ...) at/above
// 100,000,000 ... The slot min-width is sized to the widest grouped form BELOW the threshold
// ("tick 99,999,999" = 15 chars) ... so 16ch is a true ceiling". The rule is unchanged, the
// numbers are not: the wordmark needed 16 px of the row at 1024 CSS px wide, so compact notation
// now starts at 10,000,000 (about 46 hours of continuous running at 60 ticks per second) and the
// widest grouped form below it is "tick 9,999,999", 14 characters. Compact forms ("tick 10M",
// "tick 12.3M") are always shorter, so 14ch is a true ceiling the counter can never overflow.
const TICK_COMPACT_THRESHOLD = 10_000_000;
const TICK_SLOT_MIN_WIDTH = '14ch';

/**
 * Phase 91, plan 91-10 (CHROME-15, D-14, UI-SPEC 5.3): THE WORDMARK IS DRAWN WHOLE OR NOT AT ALL.
 * The left grid column is `minmax(0, 1fr)`, so below 1018 CSS px it is narrower than the lockup
 * (145.8 px), and a clipped lockup is a sliver of a word. This ref callback watches the column
 * with a ResizeObserver and hides the Toolbar-owned slot (`visibility: hidden`, so the lockup
 * keeps its box and nothing reflows) whenever the column is narrower than the slot. No container
 * query and no CSS rule (UI-SPEC permits one new rule this phase, and it is the Help focus ring);
 * `HeaderLockup` itself is not touched. A ref callback rather than a hook, so `Toolbar` stays a
 * hook-free function its unit tests can call directly; React 19 runs the returned cleanup when
 * the column unmounts. The visually hidden `<h1>` is outside the slot and always stays.
 */
function observeLockupFit(column: HTMLDivElement | null): (() => void) | undefined {
  if (column === null || typeof ResizeObserver === 'undefined') return undefined;
  const slot = column.querySelector<HTMLElement>('[data-fab-lockup-slot]');
  if (slot === null) return undefined;
  const fit = (): void => {
    const room = column.getBoundingClientRect().width;
    const need = slot.getBoundingClientRect().width;
    slot.style.visibility = room + 0.01 < need ? 'hidden' : '';
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(column);
  return () => observer.disconnect();
}

/**
 * Phase 91, plan 91-10 (CHROME-15, UI-SPEC 5.4, research A3, T-91-32): THE SCENE BADGE TAKES A
 * CLICK ONLY WHILE IT IS CUT. The status strip lies over the fitted board and is `pointer-events:
 * none` so it can never take a click meant for a machine; the badge inherits that. Only when its
 * line is narrower than its name (ellipsized) does it need pointer events, so its `title` (the
 * full name) can show on hover. This ref callback measures `scrollWidth > clientWidth` on mount
 * and whenever the badge's box changes, and sets `pointer-events: auto` only then. The badge is
 * keyed on the scene name, so a new name remounts it and is measured again. No shipped name is
 * cut at any checked width, so on screen it normally passes every click through.
 */
function observeBadgeTruncation(badge: HTMLSpanElement | null): (() => void) | undefined {
  if (badge === null || typeof ResizeObserver === 'undefined') return undefined;
  const check = (): void => {
    badge.style.pointerEvents = badge.scrollWidth > badge.clientWidth ? 'auto' : '';
  };
  check();
  const observer = new ResizeObserver(check);
  observer.observe(badge);
  return () => observer.disconnect();
}

/** Plan 74.1-31: the Undo / Redo titles while paused edits are queued. Plain text, no
 *  em dash, no path or handle (T-32-06-01). */
export const UNDO_HELD_TITLE = 'Undo waits: press Play first, edits made while paused have not landed';
export const REDO_HELD_TITLE = 'Redo waits: press Play first, edits made while paused have not landed';

function formatTick(tick: number): string {
  return tick >= TICK_COMPACT_THRESHOLD
    ? tick.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })
    : tick.toLocaleString('en-US');
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const { tick } = props;
  const stopped = props.simStopped === true;
  // A stopped sim is not running, whatever the last playing state was.
  const playing = props.playing && !stopped;
  const stoppedTitle = stopped ? SIM_STOPPED_COPY.disabledTitle : undefined;
  // The status strip paints its surface only while it holds something (plan 91-10 adds the badge).
  const stripHolds = props.status !== '' || props.dirty || props.loadedScene !== null;
  return (
    <header
      className="fab-panel"
      style={{
        position: 'absolute',
        top: 'var(--fab-space-lg)',
        left: 'var(--fab-space-lg)',
        right: 'var(--fab-space-lg)',
        // The chrome layer's 2, and 3 while the Examples popover is open (phase 91, plan 91-09,
        // CHROME-07). The popover is this header's child, so its own zIndex counts only inside
        // the header's stacking context; the inspector and Help both dock at 116 px, in the band
        // the popover drops into, and mount after the header at the same 2, so they painted over
        // the open popover. Docked below the toolbar the inspector no longer covers Examples, so
        // the popover now opens with a machine selected, and it must open on top.
        zIndex: props.examplesOpen ? 3 : 2,
        // Phase 91, plan 91-10 (CHROME-15, D-14, UI-SPEC 5.1 and 5.2): A THREE-COLUMN GRID, so
        // the transport never moves. This was one flex row with the transport centred by an
        // auto margin, so anything that changed the brand cluster's width (the scene badge's
        // text) moved Play, by up to 59 px between a user board and `Advanced pipeline`. Now the
        // left column (the lockup alone) is `minmax(0, 1fr)`, the centre column (the transport)
        // is `auto`, and the right column (the right cluster) is `minmax(max-content, 1fr)`:
        // nothing in the row depends on the scene, the dirty state or the tick, so Play's x is
        // a function of the window width only (window - 872 + 46 until the two 1fr shares
        // exceed the right cluster, then the transport centres on the header). The visually
        // hidden heading and the status strip are absolutely positioned, so they take no cell.
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto minmax(max-content, 1fr)',
        alignItems: 'center',
        // SHELL-02: sm (not md) between the three columns, unchanged.
        columnGap: 'var(--fab-space-sm)',
        // Ring padding (plan 59-03): the bezel is PAINT now, so the 6px it used to reserve as
        // border-width moves into padding on BOTH axes. Plan 91-10 takes the horizontal side
        // from md + ring (22) to sm + ring (14), one of the four reclaims that put the whole
        // lockup inside a 1024 CSS px window (UI-SPEC 5.1).
        padding: 'calc(var(--fab-space-sm) + var(--fab-bezel-ring))',
      }}
    >
      {/* Left — title. The brand mark (SHELL-03) replaces the old 10x10 accent
          square (SHELL-05 accent reserve: a passive brand square is not an
          interactive/focus cue, so it must not carry the build accent — the mark's
          single item layer is the only sanctioned accent here, and as of plan 80-05
          it paints --fab-accent-item, the token for the thing it depicts, rather than
          the build accent it used to inherit by default). This comment described "the
          belt-flow mark ... the mark's single item dot" until that plan: the mark is
          now composition A, a framed cell holding the item above a belt band, per the
          signed 80-MARK-LOCK-SUPERSESSION.md.

          CORRECTED IN PLACE (plan 80.1-01, MARK-17), not deleted, per this file's own
          doctrine. Two claims above expired together. The first is that the host
          element below is unchanged: it is not, the 32u square is gone and the cluster
          now holds the generated HEADER CUT of the lockup chosen in Phase 79 (the
          word standing on a belt, on its own dark plate, tagline dropped). The second
          is this sentence, quoted rather than removed:

            "The wordmark is a proper h1 (the app heading) on the Phase 47 title
            tier: .fab-title supplies Sono ALL-CAPS bold; --fab-font-size-hero,
            --fab-ink, lineHeight 1 stay inline."

          The heading KEEPS ITS LEVEL and LOSES ITS TYPE. It is still the app's one
          level-1 heading and still reads Fabrico, but it renders no glyph at all: the
          cut draws the product name as outlined geometry, so a visible heading would
          draw the name twice in two typefaces. Nothing on the title tier applies to an
          element that paints nothing, which is why it carries .fab-visually-hidden NOT
          .fab-title, and why its whole inline style object is gone. It has also moved
          OUT of the brand cluster to be a direct child of <header> (D-11): the cluster
          clips, and the accessible name must not be able to interact with that clip.
          Being absolutely positioned it is not a flex item, so it consumes no width
          and no gap wherever it sits. */}
      <h1 className="fab-visually-hidden">Fabrico</h1>
      {/* SHELL-02 graceful yield: when the toolbar is width-starved (e.g. 1024px @
          DPR 2, the tightest common laptop case), this brand cluster is the
          sanctioned victim - it clips rather than letting the transport cluster or
          the right-hand CTA get pushed off-screen. overflow:hidden keeps the clip
          INSIDE this box so the brand can never overlap the transport buttons (the
          pre-fix defect).

          CORRECTED IN PLACE (plan 80.1-01). This clause used to end: "the [32u square mark] is
          min-content sized so it stays fully visible and the word clips from its
          trailing edge." It describes nothing now. There is no separate word to clip:
          the cluster holds ONE artefact that carries its own word, and THE CUT is the
          thing that clips, from its trailing edge, out of the plate's right end. It is
          flexShrink: 0 for the same reason the square was, so it clips rather than
          being squeezed into a distorted drawing, and this box's overflow:hidden does
          the clipping. The accessible name is no longer in here at all; it is the
          visually-hidden heading above. */}
      {/* Phase 91, plan 91-10 (CHROME-15, UI-SPEC 5.3): the brand cluster is the grid's left
          column. It still clips (overflow hidden, minWidth 0), but the lockup now sits in its
          own slot that `observeLockupFit` hides whole whenever the column is narrower than it,
          so the clip never shows a sliver of the word. */}
      <div
        ref={observeLockupFit}
        data-fab-brand-column=""
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--fab-space-sm)', minWidth: 0, overflow: 'hidden' }}
      >
        <span data-fab-lockup-slot="" style={{ display: 'flex', flexShrink: 0 }}>
          <HeaderLockup />
        </span>
        {/* The scene badge lived here, after the lockup, until plan 91-10 (CHROME-15, UI-SPEC
            5.4): this column is the row's clip victim, so the badge was cut mid-word, and its
            width moved the transport. It is in the status strip now, beside `Unsaved`. */}
      </div>

      {/* Center - transport + tick, the grid's `auto` column (plan 91-10: no auto margin, and a
          4 px gap between its controls, UI-SPEC 5.1). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--fab-space-xs)',
        }}
      >
        {/* Playing is shown by the pressed/inverted bevel (is-pressed), NEVER the
            working accent (CONTEXT Area 4 / UI-SPEC Color). */}
        <button
          type="button"
          className={playing ? 'fab-tool-btn is-pressed' : 'fab-tool-btn'}
          onClick={props.onPlayPause}
          disabled={stopped}
          title={stoppedTitle ?? (playing ? `Pause (${SHORTCUTS.playPause.label})` : `Play (${SHORTCUTS.playPause.label})`)}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <PauseIcon px={TOOLBAR_ICON_PX} /> : <PlayIcon px={TOOLBAR_ICON_PX} />}
        </button>
        <button
          type="button"
          className="fab-tool-btn"
          onClick={props.onStep}
          disabled={stopped}
          title={stoppedTitle ?? `Step one tick (${SHORTCUTS.step.label})`}
          aria-label="Step"
        >
          <StepIcon px={TOOLBAR_ICON_PX} />
        </button>
        {/* Undo/Redo ride the gesture channel; the empty-stack disabled state is
            bevel-driven (flat/desaturated no-bevel via .fab-tool-btn:disabled),
            not opacity — no dead affordances (Area 4 Q3). */}
        {/* Plan 74.1-31: while edits made on a paused board are queued, both are held
            (disabled, the title says why), so neither can be stacked behind the edit
            and fold on Play out of the user's sight. The accessible names never change
            (Phase 32 getByRole readiness contract); only `disabled` and `title` do. */}
        <button
          type="button"
          className="fab-tool-btn"
          onClick={props.onUndo}
          disabled={stopped || !props.canUndo || props.undoHeld === true}
          title={stoppedTitle ?? (props.undoHeld === true ? UNDO_HELD_TITLE : `Undo (${SHORTCUTS.undo.label})`)}
          aria-label="Undo"
        >
          <UndoIcon px={TOOLBAR_ICON_PX} />
        </button>
        <button
          type="button"
          className="fab-tool-btn"
          onClick={props.onRedo}
          disabled={stopped || !props.canRedo || props.undoHeld === true}
          title={stoppedTitle ?? (props.undoHeld === true ? REDO_HELD_TITLE : `Redo (${SHORTCUTS.redo.label})`)}
          aria-label="Redo"
        >
          <RedoIcon px={TOOLBAR_ICON_PX} />
        </button>
        {/* The live tick readout: its FINAL treatment (32-01 SHELL-05). A passive ink
            readout that matches CameraCluster's zoom readout: --fab-ink (never the
            build accent), base size, tabular-nums so the growing counter never shifts
            the transport cluster. The accent is reserved for interactive/focus cues
            only; a passive counter is not one. With the raised locked ink (#b0bacb,
            5.16:1 on the panel fill) this passes axe AA normal at the base 16px size,
            so no a11y exclusion is needed (a11y.spec.ts). */}
        <span
          style={{
            fontFamily: 'var(--fab-font)',
            fontSize: 'var(--fab-font-size-base)',
            color: 'var(--fab-ink)',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
            textAlign: 'right',
            whiteSpace: 'nowrap',
            // SHELL-02 fixed-width tick slot: reserve a min-width sized to the widest
            // RENDERED readout ("tick 9,999,999" = 14 chars since plan 91-10, past which
            // formatTick switches to compact notation that is always shorter) so the
            // growing `tick N` counter can never widen the transport column (WR-04).
            // tabular-nums keeps every digit the same advance; textAlign right pins the
            // number to the slot's trailing edge as it grows.
            display: 'inline-block',
            minWidth: TICK_SLOT_MIN_WIDTH,
          }}
          title="Current sim tick"
        >
          tick {formatTick(tick)}
        </span>
      </div>

      {/* THE STATUS STRIP (plan 74.1-31, PAUSE-TOOLBAR). The SHELL-07 status readout and
          the SAVE-05 Unsaved badge, OUT of the button row. On the third re-walk an edit
          made while paused put "Paused - edits queued until Play" into the row; the row
          is one flex line with the transport cluster centred by margin:0 auto, so the
          sentence slid the centre buttons 130 to 180 px for as long as it showed, a click
          where Play had been landed on Undo, and on Play the queued Undo deleted the belt
          just drawn. A reserved slot inside the row was measured out: the longest
          sentence plus the badge would push the row past the 1024 px CTA bound.

          So the strip is absolutely positioned under the toolbar (out of the row's flex
          flow, zero width in it), still a child of <header> so every `header
          [role="status"]` locator keeps working, the readout FIRST in DOM order so
          `.first()` still finds it ahead of the badge.

          ANCHOR, A DEFAULT THE MAINTAINER CAN OVERTURN, AND MEASURED: right-
          aligned under the toolbar's right end, near Save and Load, which most statuses
          describe, BUT inside the band App measures (`statusStripPlacement`): right of
          the Palette and left of whatever right-docked panel hangs from the top (the
          ConfigPanel while a machine is selected, the Help panel while open). The plain
          right end was measured HIDDEN with a machine selected: the ConfigPanel was then
          `top: lg`, so it covered the toolbar's right end and painted over anything under
          it (1280x720: strip 846..1256, panel from 793). Since plan 91-09 (CHROME-07) it
          docks below the toolbar at the Help panel's offset, and the strip still stops left
          of it, because the panel's top edge sits in the strip's own band. The plan's stated fallback,
          centred under the toolbar, was measured hidden the same way (1280: 435..845;
          1024: 307..717 against a panel from 626). Absent a placement (unit tests, the
          first frame) it is the plain right end.

          IT COMES BEFORE THE RIGHT CLUSTER IN DOM ORDER so the Examples popover, which
          hangs from that cluster into the same space, paints OVER it rather than under
          a passive readout. pointer-events:none: it can never take a click meant for
          the board. It paints the panel surface only while it holds text; empty, it is
          a transparent zero-padding box, and the live region inside stays mounted so the
          next status is still announced. A band too narrow for the sentence and the
          badge on one line wraps the badge under the sentence (flex-wrap). */}
      <div
        data-fab-status-strip=""
        style={{
          position: 'absolute',
          top: 'calc(100% + var(--fab-space-xs))',
          right: props.statusStripPlacement?.right ?? 0,
          maxWidth: props.statusStripPlacement?.maxWidth,
          // The measured band is the strip's OUTER width, padding included.
          boxSizing: 'border-box',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 'var(--fab-space-xs) var(--fab-space-sm)',
          pointerEvents: 'none',
          // Plan 91-10 (UI-SPEC 5.x): `normal`, so a status too long for a narrowed band (Help
          // open at 1024) wraps between words instead of running out of the strip; the two
          // badges keep `nowrap` on their own spans.
          whiteSpace: 'normal',
          color: 'var(--fab-ink)',
          // Painted while it holds a status, the scene badge (plan 91-10) or `Unsaved`.
          backgroundColor: stripHolds ? 'var(--fab-panel-fill)' : 'transparent',
          padding: stripHolds ? 'var(--fab-space-xs) var(--fab-space-sm)' : 0,
        }}
      >
        <StatusReadout status={props.status} kind={props.statusKind} />
        {/* Phase 91, plan 91-10 (CHROME-15, D-14, UI-SPEC 5.4): THE SCENE BADGE, moved here from
            the brand cluster. ONB-01 generalized (EX-02): a PASSIVE readout naming the loaded
            shipped scene (`Demo scene`, `Order processing`, `Advanced pipeline`), absent on a user
            board. Between the status and `Unsaved` in DOM order, so `header [role="status"]`
            `.first()` still finds the status. The `Unsaved` badge's look; no role, no tab stop;
            `--fab-ink`, never the build accent (SHELL-05). Its name is capped at 20ch of text and
            ellipsizes only when its own line is narrower than it, with the full name as its
            `title`; `observeBadgeTruncation` gives it pointer events only then. The strip wraps,
            so on a narrow band `Unsaved` and then the badge drop to a second line whole. */}
        {props.loadedScene !== null && (
          <span
            key={props.loadedScene}
            ref={observeBadgeTruncation}
            data-fab-scene-badge=""
            title={props.loadedScene}
            style={{
              fontFamily: 'var(--fab-font)',
              fontSize: 'var(--fab-font-size-base)',
              color: 'var(--fab-ink)',
              lineHeight: 1,
              whiteSpace: 'nowrap',
              // 2 px above and below the line (phase 91 UI review item 4): the badge clips its
              // text at its padding box for the ellipsis, and at line height 1 the line box is the
              // font size, so the descenders of `processing` fell past it and were cut by the
              // bottom border (1 px still cut 6 ink pixels at 1024, measured by glyph ink in
              // `e2e/toolbar-stability.spec.ts`). `Unsaved` takes the same padding so the two
              // badges keep one height.
              padding: '2px var(--fab-space-sm)',
              border: '1px solid var(--fab-outline)',
              boxSizing: 'border-box',
              flex: '0 1 auto',
              minWidth: 66,
              maxWidth: 'calc(20ch + 2 * var(--fab-space-sm) + 2px)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {props.loadedScene}
          </span>
        )}
        {/* SAVE-05: the PASSIVE "Unsaved" badge, a verbatim clone of the "Demo
            scene" badge (bordered 1px --fab-outline, --fab-ink text, base Martian
            Mono, pointer-events:none), visible only while the board is dirty. It is
            a READOUT, not an affordance, so it reads --fab-ink, NEVER the build
            accent (SHELL-05 accent reserve). Wrapped as role=status aria-live=polite
            so AT announces the clean<->dirty transition without stealing focus. Copy
            is a literal, no file path is ever echoed (T-49-03-04). */}
        {props.dirty && (
          <span
            role="status"
            aria-live="polite"
            style={{
              fontFamily: 'var(--fab-font)',
              fontSize: 'var(--fab-font-size-base)',
              color: 'var(--fab-ink)',
              lineHeight: 1,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              // The scene badge's padding, so the two keep one height (UI review item 4).
              padding: '2px var(--fab-space-sm)',
              border: '1px solid var(--fab-outline)',
            }}
          >
            Unsaved
          </span>
        )}
      </div>

      {/* Right - READ-01 legibility toggles + save/load + primary CTA.
          CORRECTED IN PLACE BY PLAN 74.1-31. This comment used to read "READ-01
          legibility toggles + honest Save/Load status + save/load + primary CTA. The
          status readout sits BEFORE the actions it describes (SHELL-07)". The readout
          and the Unsaved badge no longer sit in this row: they render in the status
          strip under the toolbar (see the strip just above this cluster), because a
          sentence in the row moved every button under the pointer (PAUSE-TOOLBAR).
          position:relative is the Examples popover's anchor (EX-02): the CTA is
          this cluster's LAST item, so a right:0 absolute popover is right-aligned
          to the CTA exactly. A per-CTA wrapper div was measured and REJECTED - a
          flex-item wrapper (any min-width) stops the cluster's buttons from
          compressing under width squeeze and WORSENS the WINDOWS-id-4 minimum
          non-clipping width by ~24px; the out-of-flow popover on the cluster
          itself costs the row zero width, open or closed. */}
      {/* Plan 91-10 (UI-SPEC 5.1): the grid's right column, the cluster pinned to its right
          edge (`justifySelf: end`) for a window wide enough that the column is wider than the
          cluster, with a 4 px gap between its buttons. */}
      <div
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 'var(--fab-space-xs)', justifySelf: 'end' }}
      >
        {/* READ-01 Legend toggle: opens the collapsible legend panel. STABLE
            accessible name "Legend" (the visible text) — do NOT change existing
            control names (Phase 32 getByRole readiness contract). The open state
            is the pressed bevel + aria-expanded; aria-controls names the panel. */}
        <button
          type="button"
          className={props.legendOpen ? 'fab-tool-btn fab-tool-btn--labeled is-pressed' : 'fab-tool-btn fab-tool-btn--labeled'}
          onClick={props.onToggleLegend}
          title="Show machine legend (kinds, states, connections)"
          aria-expanded={props.legendOpen}
          aria-controls={props.legendPanelId}
        >
          <span>Legend</span>
        </button>
        {/* READ-01 Names toggle: persistent reveal of every machine's kind name
            (Alt-hold is the momentary sibling). The on state is the pressed bevel +
            aria-pressed. STABLE accessible name "Names": it read "Labels" until phase
            76 (plan 76-03, D-09), which renamed it once labels became notes with words
            of their own, so "Labels" would have named the wrong thing. The title is
            unchanged, and the three live pins moved by hand in the same commit. */}
        <button
          type="button"
          className={props.labelsToggled ? 'fab-tool-btn fab-tool-btn--labeled is-pressed' : 'fab-tool-btn fab-tool-btn--labeled'}
          onClick={props.onToggleLabels}
          title={`Reveal machine names (hold ${SHORTCUTS.names.label})`}
          aria-pressed={props.labelsToggled}
        >
          <span>Names</span>
        </button>
        {/* QA-02 / 52-UI-SPEC R0: the always-present gesture-reference badge does
            NOT live here. It was built in this cluster first and MEASURED out
            again: at 114px + one 8px gap it pushed the primary CTA off a 1024px
            viewport in EVERY board state (minimum non-clipping width went 992 ->
            1106 clean, 1106 -> 1220 dirty), breaking the SHELL-02 CTA bound this
            row already carries. A checkpoint decision (2026-07-25) moved it
            to the Palette, where a vertical panel has the room this row does not.
            See Palette.tsx for the badge, and 52-UI-SPEC.md R0 for the record.
            Do not re-add it here without re-running e2e/toolbar-stability.spec.ts.
            This paragraph used to end "(The row STILL overflows 1024px whenever
            "Unsaved" shows - a separate, pre-existing defect, WINDOWS.md id
            4.)". Plan 74.1-31 moved the badge and the status readout out of this row
            into the status strip, so neither widens it any more; the re-measured
            numbers are in WINDOWS.md rows 4 and 112.

            AND IT HAPPENED AGAIN IN PLAN 61-06, WHICH IS WHY THIS PARAGRAPH NOW CARRIES
            A MEASUREMENT RATHER THAN ONLY A WARNING. `61-UI-SPEC` B1 homed the Graphics
            settings trigger in this cluster and costed it at "+52px: an icon-only 44px
            button plus one 8px gap". It was built here and MEASURED at 1054 clean /
            1136 dirty against a ledgered 990 / 1072 - i.e. +64px at the minimum, not
            +52. 1136 passes the 1220px bound B1 set, but 1054 clean EXCEEDS 1024, so
            the three SHELL-02 assertions in this file that probe 1024 went red and the maintainer
            took B1's pre-named fallback on 2026-08-11: the trigger lives in
            CameraCluster.tsx now. (B1's own prediction, 1044, already exceeded 1024 -
            the collision was in the spec before it reached the code.)

            THE COSTING ERROR IS THE SAME ONE TOOLBAR_ICON_PX ABOVE ALREADY RECORDS, and
            this is its SECOND occurrence: `.fab-tool-btn` spends its whole 44px
            touch-target floor on horizontal chrome BEFORE the glyph is placed
            (`padding: 6px 22px`, `border: 0`), so every pixel of icon adds directly to
            this row's width and an icon-only button at ICON_MD_PX measures 60px. A
            control costed at "the min-target plus a gap" is being costed wrong by 16px.
            MEASURE THE BUTTON. */}
        {/* ONB-03 Help toggle: opens the collapsible gesture-reference panel. The
            visible glyph is "?", but the STABLE accessible name is "Help"
            (aria-label) — do NOT name it after the "?" character (Phase 32
            getByRole readiness contract). Mirrors the Legend toggle EXACTLY: the
            open state is the pressed bevel + aria-expanded; aria-controls names
            the panel. The `title` names what is BEHIND the button rather than
            repeating the button (QA-02 R2); the accessible name is untouched. */}
        <button
          type="button"
          className={props.helpOpen ? 'fab-tool-btn is-pressed' : 'fab-tool-btn'}
          onClick={props.onToggleHelp}
          title="Show gesture reference (how to place, connect and extend)"
          aria-label="Help"
          aria-expanded={props.helpOpen}
          aria-controls={props.helpPanelId}
        >
          <span aria-hidden>?</span>
        </button>
        {/* THE THREE FILE BUTTONS CARRY NO GLYPH. Plan 59-02, remedy step 3 of
            59-UI-SPEC's decided ordering ("drop the glyph from those three buttons
            entirely - New, Save and Load carry their meaning in text"), reached because
            steps 1 and 2 were MEASURED insufficient:

              - step 1, measure: the WINDOWS-id-4 minimum non-clipping header width went
                990px -> 1046px on the 8px -> 16px icon ladder, against a ledgered ceiling
                of 992px. It clips at 1024px.
              - step 2, tighten the labeled buttons' horizontal padding sm -> xs: 998px.
                Measured in its BROADEST form (all six header labeled controls AND the
                CTA, 48px reclaimed); the three-file-button form the spec describes
                reclaims only 24px and lands at 1022px. Both still exceed 992px, so step 2
                was measured and REVERTED rather than kept - its stated rationale is
                "reclaiming exactly the 24px the icons added", and step 3 removes those
                icons, so keeping a 4px padding here would cramp these three buttons
                against Legend/Labels for a reclaim that no longer has a subject.
              - step 3, this: 986px, inside the ledgered 992px.

            THE SPEC'S PREMISE WAS WRONG BY 32px AND THE CORRECTION IS RECORDED HERE
            BECAUSE THIS IS THE CODE IT CHANGED. 59-UI-SPEC says the ladder "does not
            widen the icon-only buttons (Play/Pause/Step/Undo/Redo/Fit all sit inside
            min-width: var(--fab-min-target) = 44px)". Measured, they widen by 8px each:
            `.fab-tool-btn` spends the whole 44px floor on horizontal chrome before the
            glyph is placed, so every pixel of the icon adds to the width. Four transport
            buttons x 8px = 32px of the 56px, and the three labeled file buttons account
            for the other 24px.

            RESTATED AGAINST THE SHIPPED DECLARATION (phase 59 review WR-06), like its
            twin at TOOLBAR_ICON_PX. This read "`padding: 0 var(--fab-space-md)` (32px)
            plus `border-width: var(--fab-bezel-width)` (12px at DPR 1) already totals
            44px". Since 59-03's padding migration the rule is `padding:
            var(--fab-bezel-ring) calc(var(--fab-space-md) + var(--fab-bezel-ring))` and
            `border: 0` - `6px 22px`, so 22 + 22 = the same 44px by different arithmetic.
            The figure did not move, which is why the stale wording survived a doc sweep.

            `NewIcon`, `SaveIcon` and `LoadIcon` remain EXPORTED, registered and gated -
            the artwork is committed and under both walkers - so restoring them is a
            one-line change per button if the header ever regains 60px. */}
        <button
          type="button"
          className="fab-tool-btn fab-tool-btn--labeled"
          onClick={props.onNew}
          disabled={stopped}
          title={stoppedTitle ?? `New board (${SHORTCUTS.newBoard.label})`}
          aria-label="New"
        >
          <span>New</span>
        </button>
        {/* SAVE-03: a plain click re-saves to the known path (no dialog); a
            Shift-click forces Save-As (always prompts). The tooltip discloses the
            modifier. The file path is NEVER put into the label/title
            (T-32-06-01) - the copy stays generic. */}
        <button
          type="button"
          className="fab-tool-btn fab-tool-btn--labeled"
          onClick={(e) => props.onSave(e.shiftKey)}
          disabled={stopped}
          title={stoppedTitle ?? `Save (${SHORTCUTS.save.label}) - Shift for Save As`}
        >
          <span>Save</span>
        </button>
        <button
          type="button"
          className="fab-tool-btn fab-tool-btn--labeled"
          onClick={props.onLoad}
          disabled={stopped}
          title={stoppedTitle ?? `Load a saved factory (${SHORTCUTS.open.label})`}
        >
          <span>Load</span>
        </button>
        {/* EX-02: the Examples disclosure trigger. It clones the Legend button's exact
            disclosure shape: aria-expanded + aria-controls naming the popover, is-pressed
            while open, NO aria-haspopup=menu (an honest disclosure, UI-SPEC A2). The popover
            anchors under it, right-aligned, off the CLUSTER's relative box (see the cluster
            comment): an overlay contributing ZERO width to the row, open or closed.

            CORRECTED IN PLACE BY PLAN 91-10 (CHROME-15, D-14, UI-SPEC 5.5 and Color). This
            comment opened: "the single .fab-cta keeps the build-accent primary slot the old
            "Load demo scene" CTA held". It no longer does. A button that wears the build accent
            forever reads as the one thing to press, on every board, long after the user has
            met the examples; SHELL-05 keeps the accent for focus and for the one primary action
            of a surface. Examples is a plain labelled button like Legend and the file buttons,
            `data-fab-examples-trigger` its stable locator, and the header holds no `.fab-cta`. */}
        <button
          type="button"
          ref={props.examplesTriggerRef}
          data-fab-examples-trigger=""
          className={props.examplesOpen ? 'fab-tool-btn fab-tool-btn--labeled is-pressed' : 'fab-tool-btn fab-tool-btn--labeled'}
          onClick={props.onToggleExamples}
          disabled={stopped}
          title={stoppedTitle ?? 'Load a shipped example factory'}
          aria-expanded={props.examplesOpen}
          aria-controls={EXAMPLES_POPOVER_ID}
        >
          <span>Examples</span>
        </button>
        {props.examplesOpen && !stopped && (
          <ExamplesPopover onSelect={props.onLoadScene} onEscape={props.onCloseExamples} />
        )}
      </div>

    </header>
  );
}
