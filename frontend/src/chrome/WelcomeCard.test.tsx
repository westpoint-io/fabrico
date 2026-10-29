import { describe, expect, it } from 'vitest';
import { WelcomeCard } from './WelcomeCard.tsx';

// The vitest env is `node` (no DOM, no testing-library - the phase's "zero new
// packages" discipline holds), so the component is invoked directly and its
// returned element tree walked, exactly as Toolbar.test.tsx does.
//
// QA-02: this file exists because the card SHIPPED a false claim. Its body read
// "Press ? any time for the gesture reference" while the app binds no `?` key at
// all (App.tsx binds Alt and Home; input/gestures.ts binds
// s/n/o/z/y/Escape/space/./r/Delete/Backspace; setHelpOpen has exactly two call
// sites and both are clicks). A newcomer following that sentence pressed a key
// that did nothing. The copy is pinned here so the claim cannot come back.

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}

/** Every string rendered as a text child anywhere in the tree. */
function textOf(node: unknown): string[] {
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (!isEl(n)) {
      return;
    }
    visit(n.props.children);
  };
  visit(node);
  return out;
}

const render = (): string[] =>
  textOf(WelcomeCard({ onStartBuilding: () => {}, onShowGestures: () => {} }));

/** The sentence that replaced the false keypress claim (52-UI-SPEC Copywriting). */
const GESTURE_SENTENCE = 'The ? button in the toolbar opens the gesture reference any time.';
/** U+2014, written as an escape so this guard cannot be defeated by its own copy. */
const EM_DASH = '\u2014';

describe('WelcomeCard gesture-reference copy (QA-02)', () => {
  it('points at the "?" BUTTON, the control that actually exists', () => {
    expect(render().join(' ')).toContain(GESTURE_SENTENCE);
  });

  it('never tells the user to press a key the app does not listen for', () => {
    // Deliberately a shape, not the old literal: `Press ?`, `press  ?`, `Press
    // the ?` are all the same lie and all fail here.
    const body = render().join(' ');
    expect(body).not.toMatch(/press\b[^.]{0,12}\?/i);
  });

  it('carries no em dash in any rendered string (house rule)', () => {
    for (const s of render()) {
      expect(s).not.toContain(EM_DASH);
    }
  });

  it('leaves both button labels frozen', () => {
    const body = render();
    expect(body).toContain('Show the gestures');
    expect(body).toContain('Start building');
  });
});
