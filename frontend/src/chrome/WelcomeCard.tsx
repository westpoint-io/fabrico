// WelcomeCard.tsx — the first-run onboarding welcome card (ONB-01).
//
// A NON-MODAL `.fab-panel` overlay shown ONCE on first run (App gates it on a
// `localStorage` flag, NOT on `machineCount`, so it appears over the non-empty
// demo boot). It names the current scene as a demo and points at the "?" help
// for the gesture reference, then gets out of the way. Unlike the
// DeleteGuardDialog alertdialog it does NOT trap focus and does NOT hard-scrim
// the canvas; the interactive tutorial/coachmark tour was deferred, so this is
// one dismissible card, nothing more.
//
// It reuses the Legend panel shell (`.fab-panel`, `<h2>` under the Toolbar `<h1>`,
// `--fab-*` tokens, React text children only — no innerHTML) and the
// DeleteGuardDialog button-row discipline for its two real buttons. The heading
// rides the shared Sono title tier (`.fab-title`, Phase 47); body and buttons
// stay on the Martian Mono tokens.
//
// Escape dismissal (IX-07): the card owns NO keyboard listener. Escape is the
// Phase-30 "escapable stack": it FIRST disarms an armed tool, THEN clears an
// active selection, and dismisses this card ONLY as the lowest-priority fallback
// (gestures.ts `onEscapeFallback`, wired in App). A capture-phase Escape handler
// here would swallow Escape before the gesture layer could clear a selection,
// breaking IX-07; the two real buttons are the card's only self-owned dismiss.
//
// Colour discipline (UI-SPEC): heading + body are `--fab-ink`; the build accent
// appears only on the primary CTA fill (`.fab-cta`) and the focus outline. No
// canvas state accent is borrowed as decoration. No em dash in any string.

import { type JSX } from 'react';

/** The welcome card's heading id — the `<aside>` aria-labelledby points at it. */
const WELCOME_HEADING_ID = 'fab-welcome-heading';

export interface WelcomeCardProps {
  /** Primary "Start building" — dismisses the card and sets the first-run flag. */
  onStartBuilding: () => void;
  /** Secondary "Show the gestures" — opens the "?" help panel and dismisses. */
  onShowGestures: () => void;
}

export function WelcomeCard({ onStartBuilding, onShowGestures }: WelcomeCardProps): JSX.Element {
  // No keyboard listener here (IX-07): Escape is owned by the Phase-30 gesture
  // stack, which dismisses this card only as its lowest-priority fallback (after
  // disarm + clear-selection). The two buttons below are the card's only dismiss.
  return (
    <aside
      className="fab-panel"
      aria-labelledby={WELCOME_HEADING_ID}
      style={{
        position: 'absolute',
        // Docked top-center, clear of the Toolbar (top edge) and the vertically
        // centred Palette (left edge) — a soft first-run overlay, above the chrome.
        top: 'calc(var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl))',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 3,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--fab-space-md)',
        // Ring padding (plan 59-03): the 6px the retired border reserved.
        padding: 'calc(var(--fab-space-md) + var(--fab-bezel-ring))',
        maxWidth: 480,
        // Non-blocking (UI-SPEC): the card is a SOFT first-run overlay, not the
        // alertdialog — it must never scrim-block or intercept canvas gestures
        // underneath (the EmptyState precedent). The panel itself lets pointer
        // events pass through; only the button row below re-enables them so the
        // two dismiss actions stay clickable.
        pointerEvents: 'none',
      }}
    >
      <h2
        id={WELCOME_HEADING_ID}
        className="fab-title"
        style={{
          margin: 0,
          fontSize: 'var(--fab-font-size-hero)',
          color: 'var(--fab-ink)',
          lineHeight: 1.2,
        }}
      >
        Welcome to Fabrico
      </h2>

      {/* QA-02 copy correction (52-UI-SPEC "Copywriting Contract", recorded there
        * by 52-02). The final sentence used to instruct a "?" KEYPRESS, which the
        * app does not listen for: there is no `?` binding anywhere (App binds Alt
        * and Home, gestures.ts binds s/n/o/z/y/Escape/space/./r/Delete/Backspace,
        * and setHelpOpen has exactly two call sites, both clicks). It now names
        * the real control instead - the toolbar "?" button, which is the one way
        * to the gesture list (phase 91 D-03 removed the palette's old pointer to
        * it, so nothing else on screen names that panel).
        * The fix is the COPY, not a new key binding: an app-wide accelerator is a
        * wider input decision (a shifted, keyboard-layout-dependent glyph, owned
        * by gestures.ts) and is already a deferred FEEL item (51-d). Naming a
        * control that exists is the smaller, truer change.
        */}
      <p
        style={{
          margin: 0,
          fontFamily: 'var(--fab-font)',
          fontSize: 'var(--fab-font-size-base)',
          color: 'var(--fab-ink)',
          lineHeight: 1.4,
        }}
      >
        You are looking at a demo factory - a live automation running on the
        deterministic engine. Watch items flow along the belts, or place your own
        machines from the palette. The ? button in the toolbar opens the gesture
        reference any time.
      </p>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 'var(--fab-space-sm)',
          // Re-enable pointer events for the two real dismiss buttons (the panel
          // above is pointer-events:none so the canvas stays operable).
          pointerEvents: 'auto',
        }}
      >
        {/* Secondary action: opens the help panel and dismisses in one step. A
            neutral tool button — the build accent is reserved for the primary CTA. */}
        <button
          type="button"
          className="fab-tool-btn fab-tool-btn--labeled"
          onClick={onShowGestures}
        >
          <span>Show the gestures</span>
        </button>
        {/* Primary CTA: the one sanctioned build-accent fill on this surface. */}
        <button type="button" className="fab-cta" onClick={onStartBuilding}>
          <span>Start building</span>
        </button>
      </div>
    </aside>
  );
}
