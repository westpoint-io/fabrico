// DeleteGuardDialog.tsx - the delete-with-in-flight-items guard (REND-03).
//
// The ONE modal in the app. It intercepts a delete of an element that still
// carries in-flight items and offers three choices - Cancel / Drain first /
// Delete anyway - BEFORE any `Delete` command is issued. It is PURE PRESENTATION:
// it owns no command logic and no drain poll. App.tsx holds the dialog state,
// runs the passive drain poll (reading window.__fabrico.scene()), and resolves
// every outcome into exactly one `gestures.commitDelete` (or nothing on Cancel),
// so "exactly one logged Delete" holds for every path (SC5).
//
// Styling reads `--fab-*` tokens only (no theme.ts, no hand-authored hex) + the
// `.fab-dialog*` bezel classes injected in App.tsx's CHROME_CSS block - no new
// stylesheet, no component library. The only glyph is the icons.tsx pixel
// Warning (tinted var(--fab-destructive)); the last vector icon is gone.

import { useEffect, useRef, type JSX } from 'react';
import { WarningIcon } from './icons';

export interface DeleteGuardDialogProps {
  /** Whether the guard is shown. When false the component renders nothing. */
  open: boolean;
  /** The live in-flight item count (read from the introspection model by App). */
  itemCount: number;
  /** Belt vs machine target - selects the body copy (UI-SPEC Copywriting Contract). */
  kind: 'belt' | 'machine';
  // No `id` prop: phase 89 (UI-SPEC A4) took the render handle out of the belt copy, where it
  // showed an internal number no other surface shows, and the review (IN-B-07) took the dead prop.
  /** True while App is passively draining the element to zero (Cancel-only state). */
  draining: boolean;
  /** Cancel (default / Escape / scrim-click) - issues NOTHING. */
  onCancel: () => void;
  /** Drain first - App stops at zero, then issues exactly one Delete. */
  onDrainFirst: () => void;
  /** Delete anyway - App issues one Delete immediately (BELT-08 discards the items). */
  onDeleteAnyway: () => void;
}

/** Mono, tabular-figure number span - the `{N}` placeholder (UI-SPEC). */
function Mono({ children }: { children: number }): JSX.Element {
  return (
    <span style={{ fontFamily: 'var(--fab-font)', fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </span>
  );
}

/** "item" for one, "items" for any other `n`. */
function items(n: number): string {
  return n === 1 ? 'item' : 'items';
}

export function DeleteGuardDialog({
  open,
  itemCount,
  kind,
  draining,
  onCancel,
  onDrainFirst,
  onDeleteAnyway,
}: DeleteGuardDialogProps): JSX.Element | null {
  // WR-05 focus management. The panel is programmatically focusable (tabIndex=-1)
  // so opening the alertdialog moves focus INTO it (announcing the labelled +
  // described dialog to AT - an AT user can no longer reach "Delete anyway"
  // without perceiving the data-loss warning). The opener is remembered and
  // refocused on close so keyboard context is never lost.
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus the panel itself (not a button) so no destructive action is
    // pre-selected; the alertdialog role + aria-labelledby/-describedby make the
    // heading and body the announced accessible name/description.
    panelRef.current?.focus();
    return () => {
      // Restore focus to whatever opened the dialog (guard against a removed node).
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function' && prev.isConnected) {
        prev.focus();
      }
    };
  }, [open]);

  // Escape cancels (non-destructive default), matching the scrim-click behaviour;
  // Tab / Shift+Tab are trapped so keyboard focus cycles within the dialog's
  // controls while it is open (WR-05 focus trap) - it can never escape to the
  // chrome behind the modal.
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

  // Body copy: the live count in mono figures, with correct singular/plural and
  // the belt-vs-machine wording from the UI-SPEC Copywriting Contract. While
  // draining, the body collapses to a "Draining… N left" indicator.
  const body = draining ? (
    <>
      Draining… <Mono>{itemCount}</Mono> left.
    </>
  ) : kind === 'belt' ? (
    // Phase 89 (UI-SPEC A4): reachable for a belt for the first time, so made true. No internal
    // handle number, and no claim that new items stop: there is no stop-feed command.
    <>
      This belt still carries <Mono>{itemCount}</Mono> {items(itemCount)}. Deleting now discards them.
      Drain first waits until the belt is empty, then deletes.
    </>
  ) : (
    <>
      This machine still has <Mono>{itemCount}</Mono> {items(itemCount)} in flight.
      Deleting now discards them. Drain first lets them exit first, then deletes.
    </>
  );

  return (
    <div
      className="fab-dialog-scrim"
      // Click on the scrim (never the panel) = Cancel.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        ref={panelRef}
        // tabIndex=-1: programmatically focusable (focus-on-open) but NOT a Tab
        // stop of its own once inside (WR-05).
        tabIndex={-1}
        className="fab-dialog-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fab-delete-guard-heading"
        aria-describedby="fab-delete-guard-desc"
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
          {/* SHELL-04: sized to the hero h2 cap-height, not the em. 32-02 halved the
              hero ladder (48 -> 32px CSS @ DPR 1), so the old bare 24px glyph (picked
              against the former 48px hero) now over-weights the smaller heading. 16px
              restores the original ~half-em icon-to-hero proportion (was 24-on-48) and
              snaps to the sprite's crisp 8px grid. */}
          <WarningIcon />
          <h2
            id="fab-delete-guard-heading"
            className="fab-title"
            style={{
              margin: 0,
              fontSize: 'var(--fab-font-size-hero)',
              lineHeight: 1.2,
              color: 'var(--fab-ink)',
            }}
          >
            Delete with items still moving?
          </h2>
        </div>

        <p
          id="fab-delete-guard-desc"
          style={{
            margin: 0,
            fontFamily: 'var(--fab-font)',
            fontSize: 'var(--fab-font-size-base)',
            lineHeight: 1.4,
            color: 'var(--fab-ink)',
          }}
        >
          {body}
        </p>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--fab-space-sm)',
            marginTop: 'var(--fab-space-md)',
          }}
        >
          {/* Cancel is always present; Drain/Delete hide once draining (Cancel-only). */}
          <button
            type="button"
            className="fab-dialog-btn fab-dialog-btn--cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          {!draining && (
            <>
              <button
                type="button"
                className="fab-dialog-btn fab-dialog-btn--drain"
                onClick={onDrainFirst}
              >
                Drain first
              </button>
              <button
                type="button"
                className="fab-dialog-btn fab-dialog-btn--danger"
                onClick={onDeleteAnyway}
              >
                Delete anyway
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
