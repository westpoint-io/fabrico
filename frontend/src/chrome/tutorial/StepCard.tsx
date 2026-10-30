// StepCard.tsx - the small card that says what the current lesson step asks for.
//
// Docked bottom centre, above the Legend strip when it's open. It takes no focus and passes the
// pointer through everywhere but its buttons, so the gesture a step asks for works under it. It owns
// no key listener, and its buttons call `preventDefault` on mouse down as the Palette rows do, so a
// press can't leave focus on a button and trap Space behind the focus guard.
//
// Hook-free, so a node test can call it as a function. `TutorialLayer` holds the state.

import type { CSSProperties, JSX } from 'react';
import { phrase } from '../../tutorial/phrase';
import type { PhraseToken } from '../../tutorial/types';

export type StepCardView =
  | { state: 'starting' }
  | { state: 'running'; stepNumber: number; stepCount: number; note: readonly PhraseToken[] | null; text: readonly PhraseToken[] }
  | { state: 'finished'; text: readonly PhraseToken[] };

export interface StepCardProps {
  view: StepCardView;
  onLeave: () => void;
  onBackToLessons: () => void;
  onKeepBuilding: () => void;
}

const textStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1.4,
};

/** Key and machine names at weight 700. The words are React text children, never markup. */
function Words({ tokens }: { tokens: readonly PhraseToken[] }): JSX.Element {
  return (
    <p style={textStyle}>
      {phrase(tokens).map((segment, i) =>
        segment.strong ? (
          <span key={i} style={{ fontWeight: 700 }}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </p>
  );
}

/** A press on a card button must not leave focus on it, or Space would stop reaching the board. */
const keepFocusOff = (ev: { preventDefault(): void }): void => ev.preventDefault();

function Buttons({ view, onLeave, onBackToLessons, onKeepBuilding }: StepCardProps): JSX.Element {
  if (view.state === 'finished') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--fab-space-sm)', pointerEvents: 'auto' }}>
        <button type="button" className="fab-tool-btn fab-tool-btn--labeled" onMouseDown={keepFocusOff} onClick={onBackToLessons}>
          Back to lessons
        </button>
        <button type="button" className="fab-cta" onMouseDown={keepFocusOff} onClick={onKeepBuilding}>
          Keep building
        </button>
      </div>
    );
  }
  return (
    <div style={{ alignSelf: 'end', pointerEvents: 'auto' }}>
      <button type="button" className="fab-tool-btn fab-tool-btn--labeled" onMouseDown={keepFocusOff} onClick={onLeave}>
        Leave
      </button>
    </div>
  );
}

export function StepCard(props: StepCardProps): JSX.Element {
  const { view } = props;
  // Two buttons don't fit beside the closing sentence, so a finished card sets them under it.
  const stacked = view.state === 'finished';
  return (
    <aside
      data-fab-step-card=""
      className="fab-panel"
      aria-label="Lesson step"
      style={{
        position: 'absolute',
        left: '50%',
        // 24 px above the window's bottom, or 8 px above the open Legend, whichever is higher.
        top: 'min(calc(100% - var(--fab-space-lg)), calc(var(--fab-legend-top, 100000px) - var(--fab-space-sm)))',
        transform: 'translate(-50%, -100%)',
        zIndex: 3,
        width: 480,
        padding: 'calc(var(--fab-space-md) + var(--fab-bezel-ring))',
        display: 'grid',
        gridTemplateColumns: stacked ? '1fr' : '1fr auto',
        columnGap: 'var(--fab-space-md)',
        rowGap: 'var(--fab-space-md)',
        pointerEvents: 'none',
      }}
    >
      {/* Polite, with no role, so the page-wide status and alert locators don't change. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}
      >
        {view.state === 'starting' && <p style={textStyle}>Clearing the board.</p>}
        {view.state === 'running' && (
          <>
            {view.note !== null && <Words tokens={view.note} />}
            <p style={{ ...textStyle, fontWeight: 700 }}>{`Step ${view.stepNumber} of ${view.stepCount}`}</p>
            <Words tokens={view.text} />
          </>
        )}
        {view.state === 'finished' && (
          <>
            <h2 className="fab-title" style={{ margin: 0 }}>
              Lesson done
            </h2>
            <Words tokens={view.text} />
          </>
        )}
      </div>
      <Buttons {...props} />
    </aside>
  );
}
