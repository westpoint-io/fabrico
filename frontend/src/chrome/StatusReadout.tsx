// StatusReadout.tsx - the accessible honest Save/Load status readout (SHELL-07).
//
// A passive `role="status" aria-live="polite"` live region in the toolbar's status
// strip, under the toolbar's right end near the Save/Load actions it describes. It
// used to sit "in the toolbar right cluster"; plan 74.1-31 moved it out of the button
// row because its text moved every button under the pointer (PAUSE-TOOLBAR). It is
// modeled on the
// CameraCluster zoom readout (the already-correct accessible passive --fab-ink
// readout): base Martian Mono body text, --fab-ink
// (never the build accent - a passive readout is not an interactive/focus cue),
// tabular-nums, lineHeight 1 (1.4 and wrapping since plan 91-10). It adds `pointerEvents: 'none'` so it can NEVER
// block a canvas gesture, and renders nothing visible when idle (the live region
// persists so a later announcement is spoken).
//
// SAFE-01: the readout also learns the status KIND so the two fault states - the sticky
// `disconnected` stream drop and the stopped simulation (`simStopped`, phase 90 FAIL-01,
// UI-SPEC 1.5) - carry a destructive `WarningIcon` glyph beside the word. The words of
// every kind are `--fab-ink`: the destructive tint is 2.92 : 1 on the strip's panel fill
// and fails AA for text, so the tone is in the glyph and the words stay ink (the newer
// house rule, `LoadRefusedCard`). Phase 90's UI review (Color, finding 4) moved
// `Disconnected - live view frozen` onto that rule too; until then it alone kept the red
// word. Colour is never the only cue: the glyph and the word carry the fault.
//
// SECURITY (threat T-32-06-01): the `status` string is GENERIC copy authored by
// the status state machine (STATUS_COPY) - it NEVER carries the raw file path,
// so no filesystem structure leaks into the a11y tree.

import type { JSX } from 'react';
import type { StatusKind } from './controlHandlers';
import { WarningIcon } from './icons';

export interface StatusReadoutProps {
  /**
   * The generic display string (STATUS_COPY[kind]) - e.g. 'Save requested',
   * 'Loading…', 'Loaded', 'Save failed', 'Load failed',
   * 'Disconnected - live view frozen', or '' (idle). NEVER a file path.
   */
  status: string;
  /**
   * SAFE-01: the current status KIND, so the readout can carry the fault glyph. The
   * `disconnected` and `simStopped` kinds render the destructive glyph beside the ink
   * word; every other kind is the word alone. Optional (absent => no glyph).
   */
  kind?: StatusKind;
}

export function StatusReadout({ status, kind }: StatusReadoutProps): JSX.Element {
  // The two fault states carry the destructive glyph; every word is ink.
  const glyph = kind === 'disconnected' || kind === 'simStopped';
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        // inline-flex only so the fault glyph and word sit on one baseline; an
        // ink readout with no glyph collapses to the same single-run text.
        display: 'inline-flex',
        alignItems: 'center',
        gap: glyph ? 'var(--fab-space-xs)' : 0,
        fontFamily: 'var(--fab-font)',
        fontSize: 'var(--fab-font-size-base)',
        // Ink for every kind (AA on the panel fill); a fault's tone is its glyph.
        color: 'var(--fab-ink)',
        fontVariantNumeric: 'tabular-nums',
        // Phase 91, plan 91-10 (CHROME-15, UI-SPEC 5.x): the words WRAP between words, never
        // cut. With Help open at 1024 CSS px the strip's band is 254 px and the longest status
        // (`Paused - press Play before undo or redo`) is 312, so a `nowrap` line could run out
        // of the strip. It was `nowrap` and line height 1; a wrapping line takes 1.4, the house
        // pitch at which two 12 px lines never touch.
        whiteSpace: 'normal',
        lineHeight: 1.4,
        // Never block canvas gestures - the readout is purely informational.
        pointerEvents: 'none',
        // OUT OF THE FLOW WHILE EMPTY (phase 91 review IN-B-05). The live region stays mounted
        // so a later status is announced, but as an empty flex item it still took the strip's
        // 8 px column gap, so the scene badge sat 16 px in from the strip's left edge against
        // 8 px on its right. Absolutely placed, the empty span is a zero-size box the strip's
        // row does not count; it is still in the accessibility tree.
        ...(status === '' && !glyph ? { position: 'absolute' as const } : null),
      }}
    >
      {/* SAFE-01 redundant cue: the same destructive warning glyph the
          DeleteGuardDialog uses, so colour is never the only signal. */}
      {glyph && <WarningIcon />}
      {status}
    </span>
  );
}
