import { describe, expect, it } from 'vitest';
import { noteTokens } from '../../tutorial/machine.ts';
import { MAX_NOTE_CHARS } from '../../tutorial/phrase.ts';
import { SHOW_ME_DRAWING_TITLE, StepCard, type StepCardView } from './StepCard.tsx';

// The vitest env is `node`, with no DOM, so the component is called directly and its element tree is
// walked, as `WelcomeCard.test.tsx` does. `Words` is a component the tree holds unexpanded, so the walk
// calls it too.

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}

/** Every element in the tree, with function components expanded. */
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isEl(node)) return [];
  if (typeof node.type === 'function') {
    return elements((node.type as (props: unknown) => unknown)(node.props));
  }
  return [node, ...elements(node.props.children)];
}

/** Every string rendered as a text child. */
function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'string') return node;
  if (!isEl(node)) return '';
  if (typeof node.type === 'function') return textOf((node.type as (props: unknown) => unknown)(node.props));
  return textOf(node.props.children);
}

const RUNNING: StepCardView = {
  state: 'running',
  stepNumber: 1,
  stepCount: 6,
  note: null,
  noteKind: '',
  noteHidden: false,
  text: ['A ', { kind: 0 }, ' makes items.'],
  offScreen: false,
  drawing: false,
};

const NOOPS = { onLeave: () => {}, onBackToLessons: () => {}, onKeepBuilding: () => {} };

function render(view: StepCardView): El[] {
  return elements(StepCard({ view, ...NOOPS }));
}

const FINISHED: StepCardView = { state: 'finished', text: ['A ', { kind: 0 }, ' makes items.'] };

const styleOf = (el: El): Record<string, unknown> => (el.props.style ?? {}) as Record<string, unknown>;

describe('StepCard', () => {
  it('places itself with the one position expression', () => {
    const [panel] = render(RUNNING);
    expect(panel?.props['data-fab-step-card']).toBe('');
    expect(panel?.props.className).toBe('fab-panel');
    expect(panel?.props['aria-label']).toBe('Lesson step');
    expect(styleOf(panel!).left).toBe('50%');
    expect(styleOf(panel!).top).toBe(
      'min(calc(100% - var(--fab-space-lg)), calc(var(--fab-legend-top, 100000px) - var(--fab-space-sm)))',
    );
    expect(styleOf(panel!).transform).toBe('translate(-50%, -100%)');
    expect(styleOf(panel!).zIndex).toBe(3);
  });

  it('stays centred when the layer passes no left', () => {
    const [panel] = elements(StepCard({ view: RUNNING, ...NOOPS }));
    expect(styleOf(panel!).left).toBe('50%');
    expect(styleOf(panel!).transform).toBe('translate(-50%, -100%)');
  });

  it('takes a left in px from the layer, keeping its width, its top and its bottom anchor', () => {
    const [centred] = render(RUNNING);
    const [shifted] = elements(StepCard({ view: RUNNING, ...NOOPS, left: 86.5 }));
    expect(styleOf(shifted!).left).toBe(86.5);
    // Only x moves: the bottom-anchored translate keeps its -100%, and nothing else in the style changes.
    expect(styleOf(shifted!).transform).toBe('translate(0, -100%)');
    expect(styleOf(shifted!).width).toBe(styleOf(centred!).width);
    expect(styleOf(shifted!).top).toBe(styleOf(centred!).top);
    expect(styleOf(shifted!).padding).toBe(styleOf(centred!).padding);
  });

  it('takes the same left on a finished and a swapped card', () => {
    for (const view of [FINISHED, { state: 'swapped' } as const]) {
      const [panel] = elements(StepCard({ view, ...NOOPS, left: 260 }));
      expect(styleOf(panel!).left, view.state).toBe(260);
      expect(styleOf(panel!).transform, view.state).toBe('translate(0, -100%)');
    }
  });

  it('announces its text politely, with no role', () => {
    const live = render(RUNNING).filter((el) => el.props['aria-live'] !== undefined);
    expect(live, 'one live region').toHaveLength(1);
    expect(live[0]?.props['aria-live']).toBe('polite');
    expect(live[0]?.props['aria-atomic']).toBe('true');
    expect(live[0]?.props.role).toBeUndefined();
    expect(render(RUNNING).filter((el) => el.props.role !== undefined), 'no role anywhere on the card').toEqual([]);
  });

  it('passes the pointer through everywhere but Show me and the Leave box', () => {
    const tree = render(RUNNING);
    expect(styleOf(tree[0]!).pointerEvents).toBe('none');
    const auto = tree.filter((el) => styleOf(el).pointerEvents === 'auto');
    expect(auto, 'two elements take the pointer').toHaveLength(2);
    expect(auto[0]?.type, 'Show me itself').toBe('button');
    expect(textOf(auto[0])).toBe('Show me');
    expect(elements(auto[1]!.props.children).map((el) => el.type), 'the Leave box').toEqual(['button']);
  });

  it('keeps focus off a pressed button, the way the Palette rows do', () => {
    const buttons = render(RUNNING).filter((el) => el.type === 'button');
    expect(buttons.map((b) => textOf(b))).toEqual(['Show me', 'Leave']);
    for (const button of buttons) {
      let prevented = 0;
      (button.props.onMouseDown as (ev: { preventDefault(): void }) => void)({
        preventDefault: () => {
          prevented += 1;
        },
      });
      expect(prevented, textOf(button)).toBe(1);
    }
  });

  describe('the off-screen row', () => {
    const rowOf = (view: StepCardView): El[] => render(view).filter((el) => el.props['data-fab-offscreen-row'] !== undefined);
    const showMeOf = (els: El[]): El | undefined => els.find((el) => el.type === 'button' && textOf(el) === 'Show me');

    it('is on every running card, hidden in place while the ring is in view', () => {
      const [row] = rowOf(RUNNING);
      expect(row, 'the row is reserved').toBeDefined();
      expect(styleOf(row!).visibility).toBe('hidden');
      expect(styleOf(row!).display).toBe('flex');
      expect(styleOf(row!).alignItems).toBe('center');
      expect(styleOf(row!).gap).toBe('var(--fab-space-md)');
      expect(styleOf(row!).minHeight).toBe('var(--fab-min-target)');
      expect(render(RUNNING)[0]?.props['data-fab-offscreen']).toBe('false');
    });

    it('shows its line and Show me with the ring out of view', () => {
      const view: StepCardView = { ...RUNNING, offScreen: true };
      const [row] = rowOf(view);
      expect(styleOf(row!).visibility).toBeUndefined();
      expect(render(view)[0]?.props['data-fab-offscreen']).toBe('true');
      const line = elements(row!.props.children).find((el) => el.type === 'p');
      expect(line?.props.id).toBe('fab-offscreen-line');
      expect(textOf(line)).toBe('The ring is out of view.');
      const button = showMeOf(elements(row!.props.children));
      expect(button?.props.className).toBe('fab-tool-btn fab-tool-btn--labeled');
      expect(button?.props['aria-describedby']).toBe('fab-offscreen-line');
      expect(button?.props.disabled).toBe(false);
      expect(button?.props.title).toBeUndefined();
    });

    it('sits outside the live region, under the instruction', () => {
      const live = render({ ...RUNNING, offScreen: true }).find((el) => el.props['aria-live'] !== undefined);
      expect(elements(live!.props.children).filter((el) => el.props['data-fab-offscreen-row'] !== undefined)).toEqual([]);
      const text = textOf(StepCard({ view: { ...RUNNING, offScreen: true }, ...NOOPS }));
      expect(text.indexOf('A Source makes items.')).toBeLessThan(text.indexOf('The ring is out of view.'));
    });

    it('disables Show me with its title while a belt draw is held', () => {
      const button = showMeOf(render({ ...RUNNING, offScreen: true, drawing: true }));
      expect(button?.props.disabled).toBe(true);
      expect(button?.props.title).toBe(SHOW_ME_DRAWING_TITLE);
      expect(SHOW_ME_DRAWING_TITLE).toBe('Finish or cancel the belt first.');
    });

    it('calls onShowMe when Show me is pressed', () => {
      let shown = 0;
      const els = elements(StepCard({ view: { ...RUNNING, offScreen: true }, ...NOOPS, onShowMe: () => (shown += 1) }));
      (showMeOf(els)!.props.onClick as () => void)();
      expect(shown).toBe(1);
    });

    it('is not on a starting, swapped or finished card', () => {
      for (const view of [{ state: 'starting' }, { state: 'swapped' }, FINISHED] as StepCardView[]) {
        expect(rowOf(view), view.state).toEqual([]);
        expect(render(view)[0]?.props['data-fab-offscreen'], view.state).toBeUndefined();
        expect(showMeOf(render(view)), view.state).toBeUndefined();
      }
    });

    it('marks the instruction, so a test finds it without counting children', () => {
      const marked = render(RUNNING).filter((el) => el.props['data-fab-step-text'] !== undefined);
      expect(marked).toHaveLength(1);
      expect(textOf(marked[0])).toBe('A Source makes items.');
    });
  });

  it('reads the step counter and the instruction while running, with Leave', () => {
    const text = textOf(StepCard({ view: RUNNING, ...NOOPS }));
    expect(text).toContain('Step 1 of 6');
    expect(text).toContain('A Source makes items.');
    expect(text).toContain('Leave');
  });

  it('sets the step counter and a machine name at weight 700, and the rest at the body weight', () => {
    const bold = render(RUNNING).filter((el) => styleOf(el).fontWeight === 700);
    expect(bold.map((el) => textOf(el))).toEqual(['Step 1 of 6', 'Source']);
  });

  it('shows a note above the step counter when there is one', () => {
    const text = textOf(StepCard({ view: { ...RUNNING, note: ['Step 1 was already done.'] }, ...NOOPS }));
    expect(text.indexOf('Step 1 was already done.')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Step 1 was already done.')).toBeLessThan(text.indexOf('Step 1 of 6'));
  });

  it('marks a refusal note with its kind, around the note words', () => {
    const note = ['That cell is taken, so the ', { kind: 7 }, " wasn't placed. Click a free cell, like the one in the ring."];
    const view: StepCardView = { ...RUNNING, note, noteKind: 'refusal' };
    const marked = render(view).filter((el) => el.props['data-fab-step-note'] !== undefined);
    expect(marked, 'one note wrapper').toHaveLength(1);
    expect(marked[0]?.props['data-fab-step-note']).toBe('refusal');
    expect(textOf(marked[0])).toBe("That cell is taken, so the Sink wasn't placed. Click a free cell, like the one in the ring.");
    expect(textOf(StepCard({ view, ...NOOPS })).indexOf('That cell is taken')).toBeLessThan(
      textOf(StepCard({ view, ...NOOPS })).indexOf('Step 1 of 6'),
    );
  });

  // Review WR-03: the note sits inside the atomic live region, where `visibility: hidden` takes it out of the
  // accessibility tree, and its coming back reads the whole step out again on every pan across the edge.
  // Opacity hides it from sight and leaves the reader's tree as it was.
  it('keeps a hidden note in layout and in the accessibility tree, out of sight with opacity 0', () => {
    const view: StepCardView = { ...RUNNING, note: ['Step 1 was already done.'], noteKind: 'skippedOne', noteHidden: true };
    const marked = render(view).filter((el) => el.props['data-fab-step-note'] !== undefined);
    expect(marked, 'the wrapper stays, so the card keeps its height').toHaveLength(1);
    expect(marked[0]?.props['data-fab-step-note']).toBe('skippedOne');
    expect(styleOf(marked[0]!).opacity).toBe(0);
    expect(textOf(marked[0])).toBe('Step 1 was already done.');
    for (const el of [marked[0]!, ...elements(marked[0]!.props.children)]) {
      expect(styleOf(el).visibility, 'nothing in the note leaves the tree by visibility').toBeUndefined();
      expect(styleOf(el).display, 'or by display').toBeUndefined();
      expect(el.props['aria-hidden'], 'or by aria-hidden').toBeUndefined();
    }
  });

  it('gives the live region the same tree with the note hidden or shown, apart from that one opacity', () => {
    const note = { ...RUNNING, note: ['Step 1 was already done.'], noteKind: 'skippedOne' } as const;
    const live = (view: StepCardView): El => render(view).find((el) => el.props['aria-live'] === 'polite')!;
    const shown = live({ ...note, noteHidden: false });
    const hidden = live({ ...note, noteHidden: true });
    expect(textOf(hidden)).toBe(textOf(shown));
    const strip = (el: El): unknown[] => [el.type, Object.keys(el.props).filter((k) => k !== 'children' && k !== 'style')];
    expect(elements(hidden.props.children).map(strip)).toEqual(elements(shown.props.children).map(strip));
  });

  it('sets no style on a note that shows', () => {
    const view: StepCardView = { ...RUNNING, note: ['Step 1 was already done.'], noteKind: 'skippedOne' };
    const marked = render(view).filter((el) => el.props['data-fab-step-note'] !== undefined);
    expect(marked[0]!.props.style).toBeUndefined();
  });

  it('renders no note wrapper when there is no note', () => {
    expect(render(RUNNING).filter((el) => el.props['data-fab-step-note'] !== undefined)).toEqual([]);
  });

  it('reads Clearing the board with no step counter while a new board is on its way', () => {
    const text = textOf(StepCard({ view: { state: 'starting' }, ...NOOPS }));
    expect(text).toContain('Clearing the board.');
    expect(text).not.toMatch(/Step \d/);
    expect(text).toContain('Leave');
  });

  it('calls onLeave when Leave is pressed', () => {
    let left = 0;
    const tree = elements(StepCard({ view: { state: 'starting' }, ...NOOPS, onLeave: () => (left += 1) }));
    (tree.find((el) => el.type === 'button')!.props.onClick as () => void)();
    expect(left).toBe(1);
  });

  it('reads a note that uses the whole of its budget', () => {
    const note = 'x'.repeat(MAX_NOTE_CHARS);
    const text = textOf(StepCard({ view: { ...RUNNING, note: [note] }, ...NOOPS }));
    expect(text).toContain(note);
  });

  it('reads the real note above the step counter', () => {
    const note = noteTokens({ kind: 'alreadyRunning', a: 5, b: 5 });
    const text = textOf(StepCard({ view: { ...RUNNING, note }, ...NOOPS }));
    expect(text).toContain('The board was already running, so step 5 is done. Space pauses it.');
    expect(text.indexOf('already running')).toBeLessThan(text.indexOf('Step 1 of 6'));
  });

  describe('when the lesson is finished', () => {
    it('reads Lesson done as a heading, with the closing sentence and no step counter', () => {
      const [heading] = render(FINISHED).filter((el) => el.type === 'h2');
      expect(heading?.props.className).toBe('fab-title');
      expect(textOf(heading)).toBe('Lesson done');
      const text = textOf(StepCard({ view: FINISHED, ...NOOPS }));
      expect(text).toContain('A Source makes items.');
      expect(text).not.toMatch(/Step \d/);
    });

    it('offers Back to lessons, neutral, and Keep building with the accent, and no Leave', () => {
      const buttons = render(FINISHED).filter((el) => el.type === 'button');
      expect(buttons.map((b) => textOf(b))).toEqual(['Back to lessons', 'Keep building']);
      expect(buttons[0]?.props.className).toBe('fab-tool-btn fab-tool-btn--labeled');
      expect(buttons[1]?.props.className).toBe('fab-cta');
    });

    it('calls the prop each button names', () => {
      const calls: string[] = [];
      const buttons = elements(
        StepCard({
          view: FINISHED,
          onLeave: () => calls.push('leave'),
          onBackToLessons: () => calls.push('back'),
          onKeepBuilding: () => calls.push('keep'),
        }),
      ).filter((el) => el.type === 'button');
      (buttons[0]!.props.onClick as () => void)();
      (buttons[1]!.props.onClick as () => void)();
      expect(calls).toEqual(['back', 'keep']);
    });

    it('still takes the pointer only on the button box, and keeps focus off a pressed button', () => {
      const tree = render(FINISHED);
      const auto = tree.filter((el) => styleOf(el).pointerEvents === 'auto');
      expect(auto, 'one element takes the pointer').toHaveLength(1);
      expect(elements(auto[0]!.props.children).map((el) => el.type)).toEqual(['button', 'button']);
      for (const button of tree.filter((el) => el.type === 'button')) {
        let prevented = 0;
        (button.props.onMouseDown as (ev: { preventDefault(): void }) => void)({
          preventDefault: () => {
            prevented += 1;
          },
        });
        expect(prevented).toBe(1);
      }
    });
  });

  describe('the swapped card', () => {
    const SWAPPED: StepCardView = { state: 'swapped' };
    const buttonsOf = (els: El[]): El[] => els.filter((el) => el.type === 'button');

    it('says the lesson paused and why', () => {
      const text = textOf(StepCard({ view: SWAPPED, ...NOOPS }));
      expect(text).toContain('Lesson paused');
      expect(text).toContain('The board changed, so this lesson stopped. Restart it, or leave it.');
      expect(text).not.toMatch(/Step \d/);
    });

    it('reads Lesson paused as a heading, the same as Lesson done', () => {
      const headings = render(SWAPPED).filter((el) => el.type === 'h2');
      expect(headings, 'one heading').toHaveLength(1);
      expect(headings[0]?.props.className).toBe('fab-title');
      expect(textOf(headings[0])).toBe('Lesson paused');
    });

    it('offers Restart in the accent and Leave beside it', () => {
      const buttons = buttonsOf(render(SWAPPED));
      expect(buttons.map((b) => textOf(b))).toEqual(['Restart', 'Leave']);
      expect(buttons[0]?.props.className).toBe('fab-cta');
      expect(String(buttons[1]?.props.className)).toContain('fab-tool-btn--labeled');
    });

    it('passes the two presses to the two props', () => {
      const pressed: string[] = [];
      const els = elements(
        StepCard({ view: SWAPPED, ...NOOPS, onLeave: () => pressed.push('leave'), onRestart: () => pressed.push('restart') }),
      );
      for (const b of buttonsOf(els)) (b.props.onClick as () => void)();
      expect(pressed).toEqual(['restart', 'leave']);
    });

    it('disables Restart with the stopped title while the simulation is stopped, and leaves Leave alone', () => {
      const buttons = buttonsOf(elements(StepCard({ view: SWAPPED, ...NOOPS, simStopped: true })));
      expect(buttons[0]?.props.disabled).toBe(true);
      expect(buttons[0]?.props.title).toBe('Unavailable: the simulation stopped');
      expect(buttons[1]?.props.disabled).toBeFalsy();
    });

    it('takes the pointer only on its buttons', () => {
      expect(styleOf(render(SWAPPED)[0]!).pointerEvents).toBe('none');
      const box = render(SWAPPED).find((el) => styleOf(el).pointerEvents === 'auto');
      expect(buttonsOf(elements(box)).length).toBe(2);
    });
  });

  // Review WR-02: Tab reaches the card's buttons, and the board's Escape stops at a focused button, so the
  // card's own Escape is the only way a keyboard user there can close a finished or swapped card.
  describe('Escape with focus inside the card', () => {
    function press(view: StepCardView, key = 'Escape'): { calls: string[]; prevented: number; stopped: number } {
      const calls: string[] = [];
      let prevented = 0;
      let stopped = 0;
      const aside = StepCard({
        view,
        onLeave: () => calls.push('leave'),
        onBackToLessons: () => calls.push('back'),
        onKeepBuilding: () => calls.push('keep'),
      }) as unknown as El;
      expect(aside.type).toBe('aside');
      (aside.props.onKeyDown as (e: unknown) => void)({
        key,
        preventDefault: () => (prevented += 1),
        stopPropagation: () => (stopped += 1),
      });
      return { calls, prevented, stopped };
    }

    it('closes a finished card as Keep building, and stops the press there', () => {
      expect(press(FINISHED)).toEqual({ calls: ['keep'], prevented: 1, stopped: 1 });
    });

    it('closes a swapped card as Leave, and stops the press there', () => {
      expect(press({ state: 'swapped' })).toEqual({ calls: ['leave'], prevented: 1, stopped: 1 });
    });

    it('leaves a running or starting card alone, so the board still gets the key', () => {
      expect(press(RUNNING)).toEqual({ calls: [], prevented: 0, stopped: 0 });
      expect(press({ state: 'starting' })).toEqual({ calls: [], prevented: 0, stopped: 0 });
    });

    it('does nothing for another key', () => {
      expect(press(FINISHED, 'Enter')).toEqual({ calls: [], prevented: 0, stopped: 0 });
      expect(press({ state: 'swapped' }, ' ')).toEqual({ calls: [], prevented: 0, stopped: 0 });
    });
  });

  it('shows the going-back note above the step', () => {
    const text = textOf(StepCard({ view: { ...RUNNING, note: noteTokens({ kind: 'wentBack', a: 2, b: 2 }) } as StepCardView, ...NOOPS }));
    expect(text).toContain('Step 2 needs doing again, so the lesson went back.');
    expect(text.indexOf('needs doing again')).toBeLessThan(text.indexOf('Step 1 of 6'));
  });
});
