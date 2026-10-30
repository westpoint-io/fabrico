// LessonPanel.tsx - the list of lessons, in the top-right slot Help uses.
//
// Hook-free, so a node test can call it as a function, the same way as `HelpPanel`. All of its
// state lives in `TutorialLayer`.

import type { CSSProperties, JSX } from 'react';
import type { Lesson, LessonId } from '../../tutorial/types';

export const LESSONS_PANEL_ID = 'fab-lessons-panel';
const LESSONS_HEADING_ID = 'fab-lessons-heading';

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

export interface LessonPanelProps {
  lessons: readonly Lesson[];
  onStart: (id: LessonId) => void;
  onClose: () => void;
}

export function LessonPanel({ lessons, onStart, onClose }: LessonPanelProps): JSX.Element {
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
      }}
    >
      <div style={headRowStyle}>
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
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', rowGap: 'var(--fab-space-sm)' }}>
        {lessons.map((lesson, i) => (
          <li key={lesson.id} style={rowStyle}>
            <span
              style={{
                fontFamily: 'var(--fab-font)',
                fontSize: 'var(--fab-font-size-base)',
                fontWeight: 700,
                color: 'var(--fab-ink)',
                lineHeight: 1.4,
              }}
            >
              {lesson.title}
            </span>
            <button
              type="button"
              className="fab-cta"
              aria-label={`Start ${lesson.title}`}
              ref={i === 0 ? focusOnMount : undefined}
              onClick={() => onStart(lesson.id)}
            >
              Start
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
