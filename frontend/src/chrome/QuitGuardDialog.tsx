// QuitGuardDialog.tsx - the ONE per-action confirm-before-discard guard (SAFE-03 /
// SAVE-05). Generalised IN PLACE from the shipped v5.0 quit guard: a single
// `action` prop drives Quit (destroy-the-window) AND the New/Open warn-before-swap
// dialogs off ONE alertdialog + ONE focus-trap implementation. It is NOT forked
// into a second DiscardGuardDialog: the whole point is one component, one focus
// machinery, per-action copy + button set.
//
// The sibling of DeleteGuardDialog: the SAME .fab-dialog alertdialog discipline,
// reused verbatim, for the honest confirm before unsaved edits are lost. It is
// PURE PRESENTATION: it owns no dirty tracking and no window lifecycle. App.tsx
// holds the `dirty` flag and the edits queued on a paused board (review WR-B-03),
// intercepts the OS close (Quit) or gates New/Open on that work, passes it in as
// `work` so the body says what would be lost, and resolves the outcome:
//   - action='quit'      → 2 choices (Cancel / "Quit anyway"). NO Save: destroying
//     the window immediately after a Save DISPATCH could race the process death
//     and lose the file (host write-confirm is out of scope). The CANNOT-STRAND
//     invariant (T-34-QUIT) is that onQuitAnyway ALWAYS proceeds, so the dirty
//     flag can never trap the user unable to quit.
//   - action='new'|'open'|'example' → 3 choices (Cancel / Discard / Save).
//     Save-then-proceed is safe here because the app keeps running (no destroy
//     race). 'example' (EX-02 / UI-SPEC A3) guards EVERY Examples-popover entry
//     (the demo, Order processing and Advanced)
//     — the demo load DELIBERATELY gains the guard it lacked (a closed
//     silent-discard hole, not an accident).
//
// Styling reads `--fab-*` tokens only (no theme.ts, no hand-authored hex) + the
// `.fab-dialog*` bezel classes injected in App.tsx's CHROME_CSS block: no new
// stylesheet, no component library. The only glyph is the icons.tsx pixel
// Warning. Copy is sourced verbatim from the UI-SPEC Copywriting Contract and
// rendered as literal React text children (no interpolation, no path echo, no em
// dash): threat T-34-XSS / T-49-03-01.

import { useEffect, useRef, type JSX } from 'react';
import { GUARD_QUEUED_BODY, GUARD_QUEUED_SAVE_NOTE, GUARD_QUEUED_TOO } from './configCopy';
import { WarningIcon } from './icons';

/** Which lifecycle action the guard is confirming (drives copy + button set). */
export type GuardAction = 'quit' | 'new' | 'open' | 'example';

/**
 * Per-action heading + body copy (verbatim from the UI-SPEC Copywriting
 * Contract). Exported for the node vitest copy lock (the vitest env cannot
 * render this hooked component, so the copy + branch selection are pinned as
 * data — the DOM behaviour is covered by the quit-guard Playwright spec).
 */
export const GUARD_COPY: Record<GuardAction, { heading: string; body: string }> = {
  quit: {
    heading: 'Quit with unsaved changes?',
    body: 'You have edits that have not been saved. If you quit now, they will be lost.',
  },
  new: {
    heading: 'Start a new board?',
    body: 'You have edits that have not been saved. If you start a new board now, they will be lost.',
  },
  open: {
    heading: 'Open another board?',
    body: 'You have edits that have not been saved. If you open another board now, they will be lost.',
  },
  example: {
    heading: 'Load an example?',
    body: 'You have edits that have not been saved. If you load an example now, they will be lost.',
  },
};

/**
 * Whether `action` renders the 3-choice discard branch (Cancel / Discard /
 * Save) rather than the 2-choice quit branch. Pure + exported so the node
 * vitest suite pins the branch selection ('example' MUST be 3-choice like
 * 'new'/'open'); the component derives its render branch from this.
 */
export function isThreeChoiceAction(action: GuardAction): boolean {
  return action !== 'quit';
}

/** The work the action would lose, as App reads it when the guard opens (review WR-B-03). */
export interface GuardWork {
  /** The board differs from its file (the `Unsaved` badge). */
  unsaved: boolean;
  /** Edits sent on the paused board that the host still holds until Play. */
  queued: boolean;
}

/**
 * The guard's body for `action` and the work it would lose (review WR-B-03). Unsaved edits only:
 * the shipped sentence. Queued edits only: the queued sentence. Both: the shipped sentence and
 * that the queued edits go too. Whenever edits are queued and the guard offers Save, it adds that
 * a Save now writes the board without them (the host saves the paused board as it stands).
 */
export function guardBody(action: GuardAction, work: GuardWork): string {
  if (!work.queued) return GUARD_COPY[action].body;
  const lead = work.unsaved ? `${GUARD_COPY[action].body} ${GUARD_QUEUED_TOO}` : GUARD_QUEUED_BODY[action];
  return isThreeChoiceAction(action) ? `${lead} ${GUARD_QUEUED_SAVE_NOTE}` : lead;
}

export interface QuitGuardDialogProps {
  /** Whether the guard is shown. When false the component renders nothing. */
  open: boolean;
  /**
   * Which action to confirm. Defaults to 'quit' so the shipped render site is
   * unchanged. 'quit' renders the 2-choice destroy guard (Cancel / Quit anyway);
   * 'new'/'open'/'example' render the 3-choice discard guard (Cancel / Discard /
   * Save).
   */
  action?: GuardAction;
  /**
   * The work the action would lose (review WR-B-03), read when the guard opened. Defaults to
   * unsaved edits only, the shipped sentence.
   */
  work?: GuardWork;
  /** Cancel (default / Escape / scrim-click): keeps the board/window, issues NOTHING. */
  onCancel: () => void;
  /**
   * Quit anyway (danger, placed LAST): ALWAYS destroys the window (no strand).
   * REQUIRED on the 'quit' branch; ignored for 'new'/'open'.
   */
  onQuitAnyway?: () => void;
  /**
   * Discard (danger, middle): proceed losing the unsaved edits. REQUIRED on the
   * 'new'/'open' branch; ignored for 'quit'.
   */
  onDiscard?: () => void;
  /**
   * Save (primary, placed LAST): save then proceed. REQUIRED on the 'new'/'open'
   * branch; ignored for 'quit' (a Save option is deliberately absent there).
   */
  onSave?: () => void;
}

export function QuitGuardDialog({
  open,
  action = 'quit',
  work = { unsaved: true, queued: false },
  onCancel,
  onQuitAnyway,
  onDiscard,
  onSave,
}: QuitGuardDialogProps): JSX.Element | null {
  // Focus management (DeleteGuardDialog discipline verbatim). The panel is
  // programmatically focusable (tabIndex=-1) so opening the alertdialog moves
  // focus INTO it (announcing the labelled + described dialog to AT: an AT user
  // can no longer reach "Quit anyway" without perceiving the data-loss warning).
  // The opener is remembered and refocused on close so keyboard context is never
  // lost (guard against a removed node via isConnected).
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus the panel itself (not a button) so the destructive action is never
    // pre-selected; the alertdialog role + aria-labelledby/-describedby make the
    // heading and body the announced accessible name/description.
    panelRef.current?.focus();
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function' && prev.isConnected) {
        prev.focus();
      }
    };
  }, [open]);

  // Escape cancels (non-destructive default), matching the scrim-click behaviour;
  // Tab / Shift+Tab are trapped so keyboard focus cycles within the dialog's
  // controls while it is open (focus trap): it can never escape to the chrome
  // behind the modal.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) {
          return;
        }
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>('button:not([disabled])'),
        );
        if (focusables.length === 0) {
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          // Backward from the first control (or the panel) wraps to the last.
          if (active === first || active === panel) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last) {
          // Forward from the last control wraps to the first.
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  const copy = GUARD_COPY[action];
  const isQuit = !isThreeChoiceAction(action);
  // LW-01: derive the heading/description ids from `action` so two guard instances
  // that ever co-render (e.g. an OS window-close opening the quit guard while a
  // New/Open discard guard is already up) never emit DUPLICATE DOM ids or an
  // ambiguous aria-labelledby/-describedby reference. The guards are designed to be
  // mutually exclusive, but scoping the ids makes correctness structural rather than
  // relying on that assumption. Ids stay literal per-action strings (no path echo).
  const headingId = `fab-guard-${action}-heading`;
  const descId = `fab-guard-${action}-desc`;

  return (
    <div
      className="fab-dialog-scrim"
      // Click on the scrim (never the panel) = Cancel (the safe default).
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        ref={panelRef}
        // tabIndex=-1: programmatically focusable (focus-on-open) but NOT a Tab
        // stop of its own once inside.
        tabIndex={-1}
        className="fab-dialog-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descId}
        style={{ outline: 'none' }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--fab-space-sm)',
            marginBottom: 'var(--fab-space-md)',
          }}
        >
          {/* Sized on the crisp 8px sprite grid, matching DeleteGuardDialog
              (SHELL-04): the 16px glyph pairs with the 18px hero heading. */}
          <WarningIcon />
          <h2
            id={headingId}
            className="fab-title"
            style={{
              margin: 0,
              fontSize: 'var(--fab-font-size-hero)',
              lineHeight: 1.2,
              color: 'var(--fab-ink)',
            }}
          >
            {copy.heading}
          </h2>
        </div>

        <p
          id={descId}
          style={{
            margin: 0,
            fontFamily: 'var(--fab-font)',
            fontSize: 'var(--fab-font-size-base)',
            lineHeight: 1.4,
            color: 'var(--fab-ink)',
          }}
        >
          {guardBody(action, work)}
        </p>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--fab-space-sm)',
            marginTop: 'var(--fab-space-md)',
          }}
        >
          {/* Cancel is the safe default, ALWAYS first (Escape / scrim map to it). */}
          <button
            type="button"
            className="fab-dialog-btn fab-dialog-btn--cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          {isQuit ? (
            /* Quit: 2-choice. "Quit anyway" is the danger button, placed LAST
               (DeleteGuardDialog danger-last discipline). NO Save option here:
               a save-then-destroy race could lose the file (T-49-03-02). */
            <button
              type="button"
              className="fab-dialog-btn fab-dialog-btn--danger"
              onClick={onQuitAnyway}
            >
              Quit anyway
            </button>
          ) : (
            /* New/Open: 3-choice. Discard (danger, middle) proceeds losing edits;
               Save (primary, LAST) saves then proceeds, safe because the app keeps
               running (no destroy race). Neither is pre-selected; the panel holds
               focus on open so the destructive action is never the default. */
            <>
              <button
                type="button"
                className="fab-dialog-btn fab-dialog-btn--danger"
                onClick={onDiscard}
              >
                Discard
              </button>
              <button type="button" className="fab-dialog-btn" onClick={onSave}>
                Save
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
