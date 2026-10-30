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
 * Module-level on purpose: the chrome re-renders about 10 times a second, and an inline arrow would
 * detach and re-attach on each one and pull focus back from wherever Tab had taken it.
 */
function focusOnMount(el: HTMLButtonElement | null): void {
  el?.focus();
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

/** Start and Restart send New, which a stopped host can't take. Resume only brings the card back. */
function isOff(row: RowView, action: RowAction): boolean {
  return row.disabled && action !== 'resume';
}

export interface LessonPanelProps {
  rows: readonly RowView[];
  onAction: (id: LessonId, action: RowAction) => void;
  onClose: () => void;
}

export function LessonPanel({ rows, onAction, onClose }: LessonPanelProps): JSX.Element {
  // The first action that can take a press, or Close when none can, because focus can't land on a
  // disabled button and Escape would then have nothing to reach this panel through.
  const firstRow = rows.find((row) => row.actions.some((action) => !isOff(row, action)));
  const firstAction = firstRow?.actions.find((action) => !isOff(firstRow, action));
  return (
    <aside
      id={LESSONS_PANEL_ID}
      className="fab-panel"
      aria-labelledby={LESSONS_HEADING_ID}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Escape closes this panel only. It must not also disarm a tool or clear a selection
          // behind it.
          e.preventDefault();
          e.stopPropagation();
          onClose();
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
        <button type="button" className="fab-tool-btn fab-tool-btn--labeled" ref={firstAction === undefined ? focusOnMount : undefined} onClick={onClose}>
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
                      ref={row === firstRow && action === firstAction ? focusOnMount : undefined}
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
      </div>
    </aside>
  );
}
