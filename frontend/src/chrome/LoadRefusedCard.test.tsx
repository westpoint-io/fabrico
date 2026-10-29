// @vitest-environment jsdom
//
// LoadRefusedCard.test.tsx (UNDO-09) - the four properties of the card that says why a
// `.fab` file will not open.
//
// WHY jsdom AND NOT the project default node environment. Three of the four rows below
// are DOM behaviour, not tree shape: focus moves on mount, Escape dismisses, a click
// outside does NOT. The repo's usual answer (a pure `*View` function invoked directly
// and tree-walked, as `ConfigPanel.test.tsx` does) cannot express the NEGATIVE row at
// all: "a click outside does not dismiss" is satisfied vacuously by any tree, because
// the absence of an outside-click handler is the absence of a node. Asserting it
// structurally would be a check that cannot fail, which is this project's signature
// defect. jsdom is already a devDependency and already carries three specs under
// `src/render/layers/`, so this adds no package.
//
// The card is deliberately NOT split into a pure view plus a hook wrapper. Its whole
// contract IS the hook behaviour - mount focus, Escape, and the absence of every other
// dismissal path - so a pure view would move the untested half out of reach rather than
// into it.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAD_REFUSED_COPY, LoadRefusedCard } from './LoadRefusedCard.tsx';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

function render(reason: string | null, onDismiss: () => void): void {
  act(() => {
    root.render(<LoadRefusedCard reason={reason} onDismiss={onDismiss} />);
  });
}

/**
 * The `UnknownVersion` refusal sentence, MEASURED at 242 characters on one line.
 *
 * 73-12: the line that stood here called this "the longest shipped `ProjectError`
 * sentence, at 674 characters and 13 lines". It is neither. 73-04's own summary conceded
 * the discrepancy and this comment did not, which is the shape that costs a later reader
 * an hour: a wrong number stated as a measurement reads as one. The 674/13 figures belong
 * to the UI-SPEC 5.1 worst case, which is a DIFFERENT string from the one this constant
 * holds. What this constant is for is unchanged - it is a real host sentence long enough
 * to exercise the card's wrap and dismiss behaviour - and that is now what it claims.
 */
const HOST_SENTENCE =
  'this factory (save format v9) predates a deliberate change to how belts carry their ' +
  'speed and cannot be opened by this build, which reads v10. Your file is NOT corrupt: ' +
  'Phase 62 (SLOT-03, SLOT-04) changed what a belt IS, not how fast it goes.';

describe('LoadRefusedCard', () => {
  it('the_card_renders_nothing_when_no_refusal_is_held', () => {
    render(null, vi.fn());
    // NOT merely "the card is absent": the page-wide alert count is what eight shipped
    // assertions read, and a conditional mount is the only shape that keeps it at zero
    // at rest. An always-mounted empty region would pass a "no text" check and fail
    // this one.
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.innerHTML).toBe('');
  });

  it('the_body_is_the_hosts_sentence_verbatim', () => {
    render(HOST_SENTENCE, vi.fn());
    const alert = document.querySelector('[role="alert"]');
    expect(alert, 'a held refusal mounts exactly one alert').not.toBeNull();
    // Character for character. No client re-authoring, no truncation, no ellipsis.
    expect(alert?.textContent ?? '').toContain(HOST_SENTENCE);
    // And the whole sentence is in ONE text node, so nothing split it to fit.
    const body = document.querySelector('[data-fab-load-refused-body]');
    expect(body?.textContent).toBe(HOST_SENTENCE);
  });

  it('the_copy_record_is_pinned_as_data', () => {
    // The GUARD_COPY idiom: exact-string equality on the client-authored copy, so a
    // reword is a visible one-line diff rather than a silent drift from the UI-SPEC.
    // The BODY is deliberately absent from this record - it is the host's sentence,
    // arriving at runtime, and authoring it here is what UNDO-09 forbids.
    expect(LOAD_REFUSED_COPY).toEqual({
      heading: 'Cannot open that file',
      reassurance: 'Your board has not changed.',
      dismiss: 'Close',
    });
  });

  it('escape_and_close_both_dismiss_and_nothing_else_does', () => {
    const onDismiss = vi.fn();
    render(HOST_SENTENCE, onDismiss);

    // Focus moved to the Close button on mount (the QuitGuardDialog pattern, without
    // its Tab trap: this is not a modal).
    const close = document.querySelector<HTMLButtonElement>('[data-fab-load-refused-close]');
    expect(close, 'the card carries a Close button').not.toBeNull();
    expect(document.activeElement).toBe(close);

    // THE NEGATIVE, ASSERTED EXPLICITLY AND FIRST. A card that vanishes because the
    // user moved the mouse is the failure the no-auto-clear rule exists to prevent,
    // and a build that added a scrim would pass every other row here.
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismiss, 'a click outside the card does NOT dismiss it').not.toHaveBeenCalled();

    // Escape dismisses.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // The Close button dismisses.
    act(() => {
      close?.click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('the_card_declares_no_timer_and_no_scrim', () => {
    // The two structural absences that carry the contract, asserted on the rendered
    // tree rather than on the source. A scrim would dim exactly the board the user is
    // being asked to confirm is intact (UI-SPEC 5.3).
    render(HOST_SENTENCE, vi.fn());
    expect(document.querySelectorAll('.fab-dialog-scrim')).toHaveLength(0);
    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.style.position).toBe('fixed');
    // Wrapping is required and truncation is forbidden: no ellipsis, no clip.
    const body = document.querySelector<HTMLElement>('[data-fab-load-refused-body]');
    expect(body?.style.textOverflow).toBe('');
    expect(body?.style.overflow).toBe('');
  });
});
