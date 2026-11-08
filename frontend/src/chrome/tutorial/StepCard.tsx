// StepCard.tsx - the small card that says what the current lesson step asks for.
//
// Docked bottom centre, above the Legend strip when it's open, or moved left of an open inspector
// that meets that place. It takes no focus and passes the
// pointer through everywhere but its buttons, so the gesture a step asks for works under it. It owns
// no key listener, and its buttons call `preventDefault` on mouse down as the Palette rows do, so a
// press can't leave focus on a button and trap Space behind the focus guard. Escape with focus on one
// of its buttons goes through the board's whole Escape chain (`gestures.ts`, `escapeFromStepCard`),
// whose last row closes a finished or swapped card.
//
// Hook-free, so a node test can call it as a function. `TutorialLayer` holds the state.

import type { CSSProperties, JSX } from 'react';
import { phrase } from '../../tutorial/phrase';
import type { PhraseToken } from '../../tutorial/types';
import { SIM_STOPPED_COPY } from '../SimStoppedCard';

export type StepCardView =
  | { state: 'starting' }
  | { state: 'swapped' }
  | {
      state: 'running';
      stepNumber: number;
      stepCount: number;
      note: readonly PhraseToken[] | null;
      /** What the note is: `refusal`, a lesson note's kind, or empty with no note. The walk reads it. */
      noteKind: string;
      /**
       * Kept in layout with `opacity: 0`, so the card keeps its height: `noteFor` holds a lesson note
       * back this way while the off-screen row shows. Opacity hides it from sight only, so a screen
       * reader's tree keeps the note and the flag flipping is no live-region change (review WR-03).
       */
      noteHidden: boolean;
      text: readonly PhraseToken[];
      /** Is the stage's ring out of the free area? The off-screen row shows only then. */
      offScreen: boolean;
      /** Is a belt draw held? Show me waits for it to end, because a camera move under a draw would move its path. */
      drawing: boolean;
    }
  | { state: 'finished'; text: readonly PhraseToken[] };

export interface StepCardProps {
  view: StepCardView;
  onLeave: () => void;
  onBackToLessons: () => void;
  onKeepBuilding: () => void;
  /** Start the lesson again, behind the same unsaved-work question as New. */
  onRestart?: () => void;
  /** New can't reach a stopped host, so Restart says so. Leave sends nothing and still works. */
  simStopped?: boolean;
  /** Bring the out-of-view ring into view. It moves the camera only. */
  onShowMe?: () => void;
  /**
   * The card's left edge in px, set by TutorialLayer while the open inspector meets the card's centred
   * place. Without it the card is centred. Only x moves: the width and the bottom anchor stay.
   */
  left?: number;
}

/** Show me's title while a belt draw is held. */
export const SHOW_ME_DRAWING_TITLE = 'Finish or cancel the belt first.';

const textStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1.4,
};

/** A key or machine name. */
const strongStyle: CSSProperties = { fontWeight: 700 };
/** A code fragment: the same weight, and never broken at its inner spaces. The card is already monospace. */
const codeStyle: CSSProperties = { fontWeight: 700, whiteSpace: 'nowrap' };

/** Key and machine names and code fragments at weight 700. The words are React text children, never markup. */
function Words({ tokens, mark }: { tokens: readonly PhraseToken[]; mark?: string }): JSX.Element {
  return (
    <p style={textStyle} {...(mark === undefined ? {} : { [mark]: '' })}>
      {phrase(tokens).map((segment, i) =>
        segment.strong ? (
          <span key={i} style={segment.code === true ? codeStyle : strongStyle} {...(segment.code === true ? { 'data-fab-code': '' } : {})}>
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

function Buttons({ view, onLeave, onBackToLessons, onKeepBuilding, onRestart, simStopped }: StepCardProps): JSX.Element {
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
  if (view.state === 'swapped') {
    const stopped = simStopped === true;
    return (
      <div style={{ alignSelf: 'end', display: 'flex', gap: 'var(--fab-space-sm)', pointerEvents: 'auto' }}>
        <button
          type="button"
          className="fab-cta"
          disabled={stopped}
          {...(stopped ? { title: SIM_STOPPED_COPY.disabledTitle } : {})}
          onMouseDown={keepFocusOff}
          onClick={onRestart}
        >
          Restart
        </button>
        <button type="button" className="fab-tool-btn fab-tool-btn--labeled" onMouseDown={keepFocusOff} onClick={onLeave}>
          Leave
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

/**
 * The off-screen row, on every running card. It keeps its height with `visibility: hidden` while the
 * ring is in view, so panning across the edge never moves the card, and the hidden button drops out of
 * the tab order and the accessibility tree. It sits outside the live region, so the flag flipping
 * doesn't read the whole step out again.
 */
function OffScreenRow({ offScreen, drawing, onShowMe }: { offScreen: boolean; drawing: boolean; onShowMe?: () => void }): JSX.Element {
  return (
    <div
      data-fab-offscreen-row=""
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--fab-space-md)',
        minHeight: 'var(--fab-min-target)',
        ...(offScreen ? {} : { visibility: 'hidden' }),
      }}
    >
      <p id="fab-offscreen-line" style={textStyle}>
        The ring is out of view.
      </p>
      <button
        type="button"
        className="fab-tool-btn fab-tool-btn--labeled"
        style={{ pointerEvents: 'auto' }}
        aria-describedby="fab-offscreen-line"
        disabled={drawing}
        {...(drawing ? { title: SHOW_ME_DRAWING_TITLE } : {})}
        onMouseDown={keepFocusOff}
        onClick={onShowMe}
      >
        Show me
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
      {...(view.state === 'running' ? { 'data-fab-offscreen': view.offScreen ? 'true' : 'false' } : {})}
      className="fab-panel"
      aria-label="Lesson step"
      style={{
        position: 'absolute',
        left: props.left ?? '50%',
        // 24 px above the window's bottom, or 8 px above the open Legend, whichever is higher.
        top: 'min(calc(100% - var(--fab-space-lg)), calc(var(--fab-legend-top, 100000px) - var(--fab-space-sm)))',
        transform: props.left === undefined ? 'translate(-50%, -100%)' : 'translate(0, -100%)',
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
      {/* The left column: the live region, then the off-screen row on a running card. */}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
        {/* Polite, with no role, so the page-wide status and alert locators don't change. */}
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}
        >
          {view.state === 'starting' && <p style={textStyle}>Clearing the board.</p>}
          {view.state === 'swapped' && (
            <>
              {/* A heading, as Lesson done is, so a screen reader can jump to it. */}
              <h2 className="fab-title" style={{ margin: 0 }}>
                Lesson paused
              </h2>
              <p style={textStyle}>The board changed, so this lesson stopped. Restart it, or leave it.</p>
            </>
          )}
          {view.state === 'running' && (
            <>
              {/* No wrapper without a note, so the column's gap doesn't grow the card. */}
              {view.note !== null && (
                // Hidden from sight with opacity, never `visibility: hidden`: inside this atomic region a
                // node coming back into the accessibility tree reads the whole step out again, on every
                // pan across the free area's edge (review WR-03). The note's words don't change, so the
                // reader has nothing new to say.
                <div data-fab-step-note={view.noteKind} {...(view.noteHidden ? { style: { opacity: 0 } } : {})}>
                  <Words tokens={view.note} />
                </div>
              )}
              <p style={{ ...textStyle, fontWeight: 700 }}>{`Step ${view.stepNumber} of ${view.stepCount}`}</p>
              <Words tokens={view.text} mark="data-fab-step-text" />
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
        {view.state === 'running' && (
          <OffScreenRow offScreen={view.offScreen} drawing={view.drawing} {...(props.onShowMe === undefined ? {} : { onShowMe: props.onShowMe })} />
        )}
      </div>
      <Buttons {...props} />
    </aside>
  );
}
