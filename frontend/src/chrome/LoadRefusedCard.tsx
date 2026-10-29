// LoadRefusedCard.tsx (UNDO-09) - the surface that says why a `.fab` file will not open.
//
// # What this exists to end
// The host has always written a careful, four-fact sentence when it refuses a project
// file (`crates/fabrico-host/src/project.rs`, `impl Display for ProjectError`). Until
// this component, that sentence terminated at an `eprintln!` on the sim thread
// (`sim_loop.rs`, the `Err(e)` arm of `load_swap`): the user clicked Open, nothing
// whatsoever happened, and a generic "Load failed" eventually appeared on a timeout.
// Phase 73 bumps `EDIT_SCHEMA_VERSION` (73-03) and `PROJECT_FILE_VERSION` (73-07), so
// the number of files this build refuses grows sharply. The refusal is the honest
// outcome; the silence was not.
//
// # Why this is NOT the refusal banner, on three independent grounds
// Any one of them settles it (73-UI-SPEC 5.2).
//   1. TIME. `RefusalMessage`'s `REFUSAL_HOLD_MS` is 4000 ms. The longest of these
//      sentences is 674 characters, about 27 seconds of reading. Fitting it in the hold
//      would need roughly 1575 words per minute.
//   2. SECURITY CONTRACT. `RefusalMessage.tsx`'s wire carries a FIELDLESS tag and an
//      integer, and the lookup is a closed `Record` with no interpolation, precisely so
//      no filesystem path, node handle, internal index or host `Display` string can ride
//      along (T-64-06-01). This card carries exactly such a `Display` string, which is
//      why it needed a new frame, a new sink and a new component rather than a widening
//      of that one. The host-side copy gate
//      (`crates/fabrico-host/tests/project_error_copy.rs`) is what replaces the closed
//      `Record` as the guarantee that no path reaches this node.
//   3. TIER. The banner is `aria-live="polite"` and deliberately not `role="alert"`, on
//      the stated ground that a refused gesture destroyed nothing. A load that did not
//      happen is the opposite case: the user asked for a different board and did not get
//      one, so the alert tier is the correct one and `alert` is designed for insertion.
//
// # Not a modal, and the absence is the requirement
// No scrim, no focus trap, no auto-clear. UNDO-09's second half is that the current
// board is STILL THERE, and a scrim dims exactly the thing the user is being asked to
// confirm is intact. Dismissal is the `Close` button and `Escape`, and nothing else: a
// paragraph the user is still reading must not vanish because they moved the mouse.
//
// Styling reads `--fab-*` tokens only, and the bezel is the REGISTERED `.fab-panel`
// class rather than a hand-rolled inline ring: `chromeCss.test.ts` derives the
// ring-carrier set from the parsed stylesheet and asserts set equality, so an inline
// ring here would be an unregistered carrier the gate cannot see. Reusing the class adds
// no CSS rule, so the derived set does not move and that test needs no edit.

import { useEffect, useRef, type JSX } from 'react';
import { WarningIcon } from './icons';

/**
 * The CLIENT-AUTHORED copy, exported as a `Record` so the vitest suite pins it as data
 * (the `GUARD_COPY` idiom in `QuitGuardDialog.tsx`).
 *
 * The BODY is deliberately NOT in here. It is the host's own sentence, arriving at
 * runtime and rendered verbatim; re-authoring it client-side would put the app's copy
 * and the host's refusal out of sync at the first schema change, which is exactly what
 * UNDO-09 ("in the words the host already wrote") forbids.
 *
 * `Close` and not `OK` (nothing was agreed to), and not `Dismiss` (every other button in
 * this app is a verb the user performs).
 */
export const LOAD_REFUSED_COPY: Record<'heading' | 'reassurance' | 'dismiss', string> = {
  heading: 'Cannot open that file',
  reassurance: 'Your board has not changed.',
  dismiss: 'Close',
};

export interface LoadRefusedCardProps {
  /** The host's `ProjectError` `Display` sentence, or `null` when nothing is held. */
  reason: string | null;
  /** Called by the `Close` button and by `Escape`, and by nothing else. */
  onDismiss: () => void;
}

export function LoadRefusedCard({ reason, onDismiss }: LoadRefusedCardProps): JSX.Element | null {
  const open = reason !== null;
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Focus on mount, return on dismiss (the `QuitGuardDialog` pattern). Focus lands on
  // `Close` rather than on the panel: there is exactly one control and it is
  // non-destructive, so pre-selecting it costs nothing and saves a Tab. The opener is
  // remembered and refocused on close so keyboard context is never lost (guarded against
  // a removed node via `isConnected`).
  useEffect(() => {
    if (!open) {
      return;
    }
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function' && prev.isConnected) {
        prev.focus();
      }
    };
  }, [open]);

  // Escape dismisses. This is the Escape HALF of `QuitGuardDialog`'s handler with the
  // `Tab` trap branch below it deliberately dropped: this is not a modal, so keyboard
  // focus must be free to leave for the board behind.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onDismiss]);

  if (reason === null) {
    // CONDITIONAL MOUNT, not a hidden node. At rest this component contributes +0 to
    // every page-wide role locator, which is what protects the eight shipped
    // alert-count-zero assertions.
    return null;
  }

  return (
    <div
      // The alert tier, on the mounted node. `alert` is designed for insertion, so the
      // always-mounted-region rule that governs `#fab-refusal` does not apply here.
      role="alert"
      // The REGISTERED bezel class, never a hand-rolled inline ring (see the header).
      className="fab-panel"
      style={{
        position: 'fixed',
        // The VIEWPORT CENTRE, deliberately not the `#fab-refusal` anchor: sharing that
        // anchor would overlap the two surfaces the moment a gesture refusal and a load
        // refusal coincide.
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        // A bare integer with its tally in place, the house style `RefusalMessage.tsx`
        // sets. The inline tally under `src/chrome/*.tsx`: 0 x1, 1 x3, 2 x8, 3 x3, 4 x0,
        // the refusal band at 5, THIS CARD at 6, and the dialog scrim at 1000. One rung
        // above the refusal band (a load refusal outranks a gesture refusal: it is the
        // one the user must acknowledge) and far below the scrim, because a modal always
        // wins.
        zIndex: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--fab-space-md)',
        // The ring-inclusive padding expression every other inline panel carries: the
        // bezel reserves no space of its own, so the ring band is paid for here.
        padding: 'calc(var(--fab-space-md) + var(--fab-bezel-ring))',
        // A CONTENT width (no box-sizing reset in this tree). 420 is the `ConfigPanel`
        // content width and the `RefusalMessage` cap, so this box is never wider than
        // the widest panel in the app.
        maxWidth: '420px',
        // `auto`, unlike the refusal banner: this card owns a button. It does NOT cover
        // the viewport, so it can never eat a canvas gesture outside its own box.
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--fab-space-sm)' }}>
        {/* BARE, with no size prop in literal or named form. Both ways of passing one
            redden the icon ladder gate. The glyph is DECORATIVE and REDUNDANT
            (`aria-hidden` at source) and the sentences beside it carry the whole
            information content, which is what makes its 2.92:1 destructive-on-panel-fill
            contrast legal: it is a tone cue, never the only signal. The tone lives here
            and NOWHERE ELSE on this card. */}
        <WarningIcon />
        <h2
          className="fab-title"
          style={{
            margin: 0,
            fontSize: 'var(--fab-font-size-hero)',
            lineHeight: 1.2,
            color: 'var(--fab-ink)',
          }}
        >
          {LOAD_REFUSED_COPY.heading}
        </h2>
      </div>

      <p
        // The host's sentence, VERBATIM, in one text node. No interpolation, no
        // re-authoring, no truncation.
        data-fab-load-refused-body=""
        style={{
          margin: 0,
          fontFamily: 'var(--fab-font)',
          fontSize: 'var(--fab-font-size-base)',
          // `.fab-panel` sets `line-height: 1`, right for a single-run label and wrong
          // for a paragraph that wraps to thirteen lines at worst.
          lineHeight: 1.4,
          // The INK token, NEVER `--fab-destructive`. Measured on the panel fill:
          // destructive is 2.92:1 and fails AA for text; ink is 5.157:1 and passes.
          color: 'var(--fab-ink)',
          // Wrapping is REQUIRED and truncation is FORBIDDEN. `whiteSpace`,
          // `textOverflow` and `overflow` are all left at their defaults so the text
          // wraps freely; an ellipsised refusal reason is the failure this whole lineage
          // exists to end, in a quieter form. No scroll container is declared, which the
          // stylesheet gate forbids on a ring carrier in any case.
        }}
      >
        {reason}
      </p>

      <p
        // The client-known fact, not a host verdict, so it belongs on the client side.
        // It is the second half of UNDO-09's acceptance criterion made visible.
        style={{
          margin: 0,
          fontFamily: 'var(--fab-font)',
          fontSize: 'var(--fab-font-size-base)',
          lineHeight: 1.4,
          color: 'var(--fab-ink)',
        }}
      >
        {LOAD_REFUSED_COPY.reassurance}
      </p>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          ref={closeRef}
          type="button"
          // The registered dialog-button class. It already carries the ring, so this adds
          // no CSS rule and the stylesheet gate's derived carrier set does not move.
          className="fab-dialog-btn"
          data-fab-load-refused-close=""
          onClick={onDismiss}
        >
          {LOAD_REFUSED_COPY.dismiss}
        </button>
      </div>
    </div>
  );
}
