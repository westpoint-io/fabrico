// LessonPanel.tsx - the list of lessons, in the top-right slot Help uses.
//
// Hook-free, so a node test can call it as a function, the same way as `HelpPanel`. It renders the
// output of `rowViews` and holds nothing, so what a row offers is decided in one pure place. All of
// its state lives in `TutorialLayer`.

import type { CSSProperties, JSX } from 'react';
import type { RowAction, RowStatus, RowView } from '../../tutorial/machine';
import type { LessonId } from '../../tutorial/types';
import { HELP_SCROLL_ATTR, TOP_RIGHT_PANEL_MAX_HEIGHT, observeScrollFocus } from '../HelpPanel';
import { SIM_STOPPED_COPY } from '../SimStoppedCard';

export const LESSONS_PANEL_ID = 'fab-lessons-panel';
const LESSONS_HEADING_ID = 'fab-lessons-heading';

const INTRO = 'Each lesson starts on a new board, and you do the work with your own mouse.';

const STATUS_WORD: Readonly<Record<RowStatus, string>> = {
  notStarted: 'Not started',
  inProgress: 'In progress',
  done: 'Done',
};

const ACTION_WORD: Readonly<Record<RowAction, string>> = {
  start: 'Start',
  resume: 'Resume',
  restart: 'Restart',
};

/**
 * Focus the first action that can take a press, or Close when none can, because focus can't land on
 * a disabled button and Escape would then have nothing to reach this panel through.
 *
 * It sits on the panel, once, and not on a button. A row's first action changes while the list is open
 * (a swap takes Resume away), and a ref moved onto a button that's already mounted runs at once, which
 * pulls focus there from wherever the user had put it. Module-level on purpose: the chrome re-renders
 * about 10 times a second, and an inline arrow would detach and re-attach on each one.
 */
function focusFirstAction(panel: HTMLElement | null): void {
  const action = panel?.querySelector<HTMLElement>('[data-fab-lesson-row] button:not(:disabled)');
  (action ?? panel?.querySelector<HTMLElement>('button'))?.focus();
}

/**
 * Focus Close, when the list is open. It's the head row's button, the first in the panel, and it's
 * always mounted and can't replace the board. A swap that takes away the focused Resume lands here,
 * because focus on the page can't reach this panel's Escape.
 */
export function focusListClose(): void {
  document.getElementById(LESSONS_PANEL_ID)?.querySelector<HTMLElement>('button')?.focus();
}

const headRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--fab-space-md)',
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  columnGap: 'var(--fab-space-md)',
  alignItems: 'center',
  minHeight: 'var(--fab-min-target)',
};

const textStyle: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1.4,
};

/** Where the Reset progress footer is: at rest, asking the question, or just after a reset. */
export type ResetFooter = 'rest' | 'confirming' | 'cleared';

/** The footer's one line of text. It sits in one live span in every state, so each change is read out. */
const FOOTER_TEXT: Readonly<Record<ResetFooter, string>> = {
  rest: '',
  confirming: 'Clear all lesson progress?',
  cleared: 'Progress cleared.',
};

const footerBaseStyle: CSSProperties = {
  flexShrink: 0,
  marginTop: 'var(--fab-space-sm)',
  display: 'grid',
  alignItems: 'center',
  minHeight: 'var(--fab-min-target)',
};

// The question and both buttons need 536 px on one line and the panel has 432, so while it asks, the
// footer goes to one column with the question above the buttons.
const footerRestStyle: CSSProperties = { ...footerBaseStyle, gridTemplateColumns: '1fr auto', columnGap: 'var(--fab-space-md)' };
const footerConfirmStyle: CSSProperties = { ...footerBaseStyle, gridTemplateColumns: '1fr', rowGap: 'var(--fab-space-sm)' };

/** Start and Restart send New, which a stopped host can't take. Resume only brings the card back. */
function isOff(row: RowView, action: RowAction): boolean {
  return row.disabled && action !== 'resume';
}

export interface LessonPanelProps {
  rows: readonly RowView[];
  onAction: (id: LessonId, action: RowAction) => void;
  onClose: () => void;
  footer: ResetFooter;
  /** Reset progress: ask first. */
  onReset: () => void;
  /** Keep progress, or Escape while the question is up. */
  onKeep: () => void;
  /** Clear progress. */
  onClear: () => void;
}

export function LessonPanel({ rows, onAction, onClose, footer, onReset, onKeep, onClear }: LessonPanelProps): JSX.Element {
  return (
    <aside
      ref={focusFirstAction}
      id={LESSONS_PANEL_ID}
      className="fab-panel"
      aria-labelledby={LESSONS_HEADING_ID}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Escape closes this panel only. It must not also disarm a tool or clear a selection
          // behind it. With the reset question up it cancels the question first and the panel stays.
          e.preventDefault();
          e.stopPropagation();
          if (footer === 'confirming') onKeep();
          else onClose();
        }
      }}
      style={{
        position: 'absolute',
        // Help's dock: the two share one slot, so they sit in one place.
        top: 'calc(var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl))',
        right: 'var(--fab-space-lg)',
        zIndex: 2,
        width: 432,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--fab-space-sm)',
        padding: 'calc(var(--fab-space-sm) + var(--fab-bezel-ring))',
        maxHeight: TOP_RIGHT_PANEL_MAX_HEIGHT,
      }}
    >
      <div style={{ ...headRowStyle, flexShrink: 0 }}>
        <h2
          id={LESSONS_HEADING_ID}
          className="fab-title"
          style={{ margin: 0, fontSize: 'var(--fab-font-size-hero)', color: 'var(--fab-ink)', lineHeight: 1.2 }}
        >
          Lessons
        </h2>
        <button type="button" className="fab-tool-btn fab-tool-btn--labeled" onClick={onClose}>
          Close
        </button>
      </div>
      {/* Everything under the head row scrolls, so a short window keeps the heading and Close. It takes
          Help's scroll attribute, so Space and Home scroll it while it has focus, and its focus ring. */}
      <div
        {...{ [HELP_SCROLL_ATTR]: '' }}
        ref={observeScrollFocus}
        style={{ overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}
      >
        <p style={{ ...textStyle, margin: 0 }}>{INTRO}</p>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', rowGap: 'var(--fab-space-sm)' }}>
          {rows.map((row) => (
            <li key={row.id} data-fab-lesson-row={row.id} style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ ...textStyle, fontWeight: 700 }}>{row.title}</div>
                {/* The word carries the state, so Done takes no colour of its own. */}
                <div style={{ ...textStyle, marginTop: 'var(--fab-space-xs)' }}>{STATUS_WORD[row.status]}</div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--fab-space-sm)' }}>
                {row.actions.map((action) => {
                  const off = isOff(row, action);
                  return (
                    <button
                      key={action}
                      type="button"
                      className={action === row.accent ? 'fab-cta' : 'fab-tool-btn fab-tool-btn--labeled'}
                      aria-label={`${ACTION_WORD[action]} ${row.title}`}
                      disabled={off}
                      {...(off ? { title: SIM_STOPPED_COPY.disabledTitle } : {})}
                      onClick={() => onAction(row.id, action)}
                    >
                      {ACTION_WORD[action]}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
        {/* Last in the scroll box, under the rows. Outside it, with the head row, it left the rows no
            height at all on a 340 px window, so Start could not be reached. Where the list fits it reads
            the same either way. The buttons carry data attributes so TutorialLayer can move focus to them. */}
        <div data-fab-lessons-footer={footer} style={footer === 'confirming' ? footerConfirmStyle : footerRestStyle}>
          <span aria-live="polite" style={textStyle}>
            {FOOTER_TEXT[footer]}
          </span>
          {footer === 'confirming' ? (
            // The guard dialogs' order and classes: the safe choice first.
            <div style={{ justifySelf: 'end', display: 'flex', gap: 'var(--fab-space-sm)' }}>
              <button type="button" className="fab-dialog-btn fab-dialog-btn--cancel" data-fab-reset-keep="" onClick={onKeep}>
                Keep progress
              </button>
              <button type="button" className="fab-dialog-btn fab-dialog-btn--danger" data-fab-reset-clear="" onClick={onClear}>
                Clear progress
              </button>
            </div>
          ) : (
            <button type="button" className="fab-tool-btn fab-tool-btn--labeled" data-fab-reset="" onClick={onReset}>
              Reset progress
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
