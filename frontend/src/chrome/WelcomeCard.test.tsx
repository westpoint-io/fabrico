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
  textOf(WelcomeCard({ onStartBuilding: () => {}, onShowGestures: () => {}, onStartLesson: () => {} }));

/** The sentence that replaced the false keypress claim (52-UI-SPEC Copywriting). */
const GESTURE_SENTENCE = 'The ? button in the toolbar opens the gesture reference and the lessons any time.';
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

  it('has all three buttons, in order', () => {
    const body = render();
    const labels = body.filter((s) => ['Show the gestures', 'Start a lesson', 'Start building'].includes(s));
    expect(labels).toEqual(['Show the gestures', 'Start a lesson', 'Start building']);
  });

  it('asserts the sentence as one line of text, the way a person reads it', () => {
    const body = render().join(' ').replace(/\s+/g, ' ');
    expect(body).toContain('The ? button in the toolbar opens the gesture reference and the lessons any time.');
  });

  it('wires each button to its own prop, and only Start building takes the accent', () => {
    const pressed: string[] = [];
    const card = WelcomeCard({
      onStartBuilding: () => pressed.push('building'),
      onShowGestures: () => pressed.push('gestures'),
      onStartLesson: () => pressed.push('lesson'),
    });
    const buttons: El[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (isEl(n)) {
        if (n.type === 'button') buttons.push(n);
        walk(n.props.children);
      }
    };
    walk(card);
    for (const b of buttons) (b.props.onClick as () => void)();
    expect(pressed).toEqual(['gestures', 'lesson', 'building']);
    expect(buttons.map((b) => b.props.className)).toEqual([
      'fab-tool-btn fab-tool-btn--labeled',
      'fab-tool-btn fab-tool-btn--labeled',
      'fab-cta',
    ]);
  });

  it('is wide enough for the three buttons', () => {
    const card = WelcomeCard({ onStartBuilding: () => {}, onShowGestures: () => {}, onStartLesson: () => {} }) as unknown as El;
    expect((card.props.style as Record<string, unknown>).maxWidth).toBe(528);
  });
});
