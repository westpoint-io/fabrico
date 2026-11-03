import { describe, expect, it } from 'vitest';
import type { RowView } from '../../tutorial/machine.ts';
import type { LessonId } from '../../tutorial/types.ts';
import { TOP_RIGHT_PANEL_MAX_HEIGHT } from '../HelpPanel.tsx';
import { SIM_STOPPED_COPY } from '../SimStoppedCard.tsx';
import { LESSONS_PANEL_ID, LessonPanel, type LessonPanelProps } from './LessonPanel.tsx';

// The vitest env is `node`, with no DOM, so the component is called directly and its element tree is
// walked, as `StepCard.test.tsx` does.

interface El {
  type: unknown;
  key?: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}

function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isEl(node)) return [];
  if (typeof node.type === 'function') return elements((node.type as (props: unknown) => unknown)(node.props));
  return [node, ...elements(node.props.children)];
}

function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'string') return node;
  if (!isEl(node)) return '';
  if (typeof node.type === 'function') return textOf((node.type as (props: unknown) => unknown)(node.props));
  return textOf(node.props.children);
}

const ID = 'your-first-line' as LessonId;
const NOT_STARTED: RowView = { id: ID, title: 'Your first line', status: 'notStarted', actions: ['start'], accent: 'start', disabled: false };

const NOOPS = { onAction: () => {}, onClose: () => {}, onReset: () => {}, onKeep: () => {}, onClear: () => {} };

function render(rows: readonly RowView[], footer: LessonPanelProps['footer'] = 'rest'): El[] {
  return elements(LessonPanel({ rows, footer, ...NOOPS }));
}

const buttonsOf = (els: El[]): El[] => els.filter((el) => el.type === 'button');
const FOOTER_WORDS = ['Close', 'Reset progress', 'Keep progress', 'Clear progress'];
const rowButtons = (els: El[]): El[] => buttonsOf(els).filter((b) => !FOOTER_WORDS.includes(textOf(b)));
const styleOf = (el: El): Record<string, unknown> => (el.props.style ?? {}) as Record<string, unknown>;
const panelOf = (els: El[]): El => els[0] as El;

/** Five rows through every state the table has, with the longest title it allows for. */
const FIVE: readonly RowView[] = [
  { id: 'a' as LessonId, title: 'Your first line', status: 'done', actions: ['restart'], accent: null, disabled: false },
  { id: 'b' as LessonId, title: 'A Factory with two outputs', status: 'inProgress', actions: ['resume', 'restart'], accent: 'resume', disabled: false },
  { id: 'c' as LessonId, title: 'Three', status: 'inProgress', actions: ['restart'], accent: null, disabled: false },
  { id: 'd' as LessonId, title: 'Four', status: 'notStarted', actions: ['start'], accent: null, disabled: false },
  { id: 'e' as LessonId, title: 'Five', status: 'notStarted', actions: ['start'], accent: null, disabled: false },
];

describe('LessonPanel', () => {
  it('names the button with the lesson and shows the plain word', () => {
    const [start] = rowButtons(render([NOT_STARTED]));
    expect(start?.props['aria-label']).toBe('Start Your first line');
    expect(textOf(start)).toBe('Start');
  });

  it('docks where Help docks, at one width, under the one height expression', () => {
    const panel = panelOf(render([NOT_STARTED]));
    expect(panel.props.id).toBe(LESSONS_PANEL_ID);
    expect(panel.props.className).toBe('fab-panel');
    expect(panel.props['aria-labelledby']).toBe('fab-lessons-heading');
    const style = styleOf(panel);
    expect(style.width).toBe(432);
    expect(style.zIndex).toBe(2);
    expect(style.top).toBe('calc(var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl))');
    expect(style.right).toBe('var(--fab-space-lg)');
    expect(style.padding).toBe('calc(var(--fab-space-sm) + var(--fab-bezel-ring))');
    expect(style.maxHeight).toBe(TOP_RIGHT_PANEL_MAX_HEIGHT);
  });

  it('has the heading, the intro and Close', () => {
    const els = render([NOT_STARTED]);
    const heading = els.find((el) => el.type === 'h2');
    expect(textOf(heading)).toBe('Lessons');
    expect(heading?.props.id).toBe('fab-lessons-heading');
    expect(textOf(panelOf(els))).toContain('Each lesson starts on a new board, and you do the work with your own mouse.');
    const close = buttonsOf(els).find((b) => textOf(b) === 'Close');
    expect(String(close?.props.className)).toContain('fab-tool-btn--labeled');
  });

  it('reads each status as its word', () => {
    const text = textOf(panelOf(render(FIVE)));
    expect(text).toContain('Done');
    expect(text).toContain('In progress');
    expect(text).toContain('Not started');
  });

  it('keeps the rows in the order it was given', () => {
    const rows = render(FIVE).filter((el) => el.props['data-fab-lesson-row'] !== undefined);
    expect(rows.map((el) => el.props['data-fab-lesson-row'])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('gives a row its grid and its minimum height', () => {
    const row = render([NOT_STARTED]).find((el) => el.props['data-fab-lesson-row'] !== undefined) as El;
    const style = styleOf(row);
    expect(style.gridTemplateColumns).toBe('1fr auto');
    expect(style.minHeight).toBe('var(--fab-min-target)');
    expect(style.columnGap).toBe('var(--fab-space-md)');
  });

  it('the row buttons name every action', () => {
    const names = rowButtons(render(FIVE)).map((b) => b.props['aria-label']);
    expect(names).toEqual([
      'Restart Your first line',
      'Resume A Factory with two outputs',
      'Restart A Factory with two outputs',
      'Restart Three',
      'Start Four',
      'Start Five',
    ]);
  });

  it('with five rows, the accent class sits on the accent action alone', () => {
    const accented = rowButtons(render(FIVE)).filter((b) => b.props.className === 'fab-cta');
    expect(accented.map((b) => b.props['aria-label'])).toEqual(['Resume A Factory with two outputs']);
    for (const b of rowButtons(render(FIVE))) {
      if (b.props.className !== 'fab-cta') expect(String(b.props.className)).toContain('fab-tool-btn--labeled');
    }
  });

  it("lets a row's left column shrink, so a longer title wraps rather than pushing the buttons out", () => {
    // Whether five rows fit takes a real layout, so the mock spec `lessons.spec.ts` reads that.
    const left = render(FIVE).find((el) => el.props['data-fab-lesson-row'] === 'b')?.props.children as unknown[];
    expect(styleOf(left[0] as El).minWidth).toBe(0);
  });

  it('holds its scroll box under the head row, with the shared scroll attribute', () => {
    const els = render(FIVE);
    const box = els.find((el) => el.props['data-fab-help-scroll'] !== undefined);
    expect(styleOf(box as El).overflowY).toBe('auto');
    expect(styleOf(box as El).minHeight).toBe(0);
    const inside = elements(box);
    expect(inside.some((el) => el.type === 'ul')).toBe(true);
    expect(inside.some((el) => el.type === 'h2'), 'the heading stays outside it').toBe(false);
  });

  it('a press names the lesson and the action', () => {
    const seen: string[] = [];
    const els = elements(LessonPanel({ ...NOOPS, rows: FIVE, footer: 'rest', onAction: (id, action) => seen.push(`${id}:${action}`) }));
    for (const b of rowButtons(els)) (b.props.onClick as () => void)();
    expect(seen).toEqual(['a:restart', 'b:resume', 'b:restart', 'c:restart', 'd:start', 'e:start']);
  });

  it('Escape closes the panel and stops there', () => {
    let closed = 0;
    let stopped = 0;
    let prevented = 0;
    const [panel] = elements(LessonPanel({ ...NOOPS, rows: [NOT_STARTED], footer: 'rest', onClose: () => (closed += 1) }));
    const onKeyDown = panel?.props.onKeyDown as (e: unknown) => void;
    onKeyDown({ key: 'Tab', preventDefault: () => (prevented += 1), stopPropagation: () => (stopped += 1) });
    expect([closed, stopped, prevented], 'another key does nothing').toEqual([0, 0, 0]);
    onKeyDown({ key: 'Escape', preventDefault: () => (prevented += 1), stopPropagation: () => (stopped += 1) });
    expect([closed, stopped, prevented]).toEqual([1, 1, 1]);
  });

  describe('the Reset progress footer', () => {
    const footerOf = (els: El[]): El => els.find((el) => el.props['data-fab-lessons-footer'] !== undefined) as El;
    const liveOf = (els: El[]): El => elements(footerOf(els)).find((el) => el.props['aria-live'] !== undefined) as El;
    const footerButtons = (els: El[]): El[] => buttonsOf(elements(footerOf(els)));

    it('sits under the scroll box and keeps its height', () => {
      const els = render(FIVE);
      const footer = footerOf(els);
      expect(footer, 'the footer is there').toBeDefined();
      const box = els.find((el) => el.props['data-fab-help-scroll'] !== undefined) as El;
      expect(elements(box).includes(footer), 'it is outside the scroll box').toBe(false);
      const panelChildren = (panelOf(els).props.children as unknown[]).filter(isEl);
      expect(panelChildren.at(-1), 'it is the last thing in the panel').toBe(footer);
      const style = styleOf(footer);
      expect(style.flexShrink).toBe(0);
      expect(style.marginTop).toBe('var(--fab-space-sm)');
      expect(style.display).toBe('grid');
      expect(style.minHeight).toBe('var(--fab-min-target)');
      expect(style.alignItems).toBe('center');
    });

    it('at rest, offers Reset progress with an empty line, on the two columns the rows use', () => {
      const els = render([NOT_STARTED]);
      expect(styleOf(footerOf(els)).gridTemplateColumns).toBe('1fr auto');
      expect(styleOf(footerOf(els)).columnGap).toBe('var(--fab-space-md)');
      expect(textOf(liveOf(els))).toBe('');
      const buttons = footerButtons(els);
      expect(buttons.map(textOf)).toEqual(['Reset progress']);
      expect(buttons[0]?.props.className).toBe('fab-tool-btn fab-tool-btn--labeled');
      expect(buttons[0]?.props['data-fab-reset']).toBe('');
      expect(buttons[0]?.props.disabled, 'enabled whether or not anything is stored').toBeFalsy();
    });

    it('while confirming, asks the question above Keep progress then Clear progress, in the guard dialog classes', () => {
      const els = render([NOT_STARTED], 'confirming');
      const style = styleOf(footerOf(els));
      expect(style.gridTemplateColumns).toBe('1fr');
      expect(style.rowGap).toBe('var(--fab-space-sm)');
      expect(textOf(liveOf(els))).toBe('Clear all lesson progress?');
      const buttons = footerButtons(els);
      expect(buttons.map(textOf)).toEqual(['Keep progress', 'Clear progress']);
      expect(buttons.map((b) => b.props.className)).toEqual(['fab-dialog-btn fab-dialog-btn--cancel', 'fab-dialog-btn fab-dialog-btn--danger']);
      expect(buttons[0]?.props['data-fab-reset-keep']).toBe('');
      expect(buttons[1]?.props['data-fab-reset-clear']).toBe('');
      const line = elements(footerOf(els)).find((el) => el.type === 'div' && elements(el).includes(buttons[0] as El) && el !== footerOf(els)) as El;
      expect(styleOf(line).justifySelf).toBe('end');
      expect(styleOf(line).gap).toBe('var(--fab-space-sm)');
    });

    it('after a reset, says so beside Reset progress', () => {
      const els = render([NOT_STARTED], 'cleared');
      expect(styleOf(footerOf(els)).gridTemplateColumns).toBe('1fr auto');
      expect(textOf(liveOf(els))).toBe('Progress cleared.');
      expect(footerButtons(els).map(textOf)).toEqual(['Reset progress']);
    });

    it('keeps one polite live span, first in the footer, in every state', () => {
      for (const footer of ['rest', 'confirming', 'cleared'] as const) {
        const first = (footerOf(render([NOT_STARTED], footer)).props.children as unknown[])[0] as El;
        expect(first.type, footer).toBe('span');
        expect(first.props['aria-live'], footer).toBe('polite');
        expect(first.props.role, footer).toBeUndefined();
      }
    });

    it('each button calls its own prop', () => {
      const seen: string[] = [];
      const props = { ...NOOPS, rows: [NOT_STARTED], onReset: () => seen.push('reset'), onKeep: () => seen.push('keep'), onClear: () => seen.push('clear') };
      for (const footer of ['rest', 'confirming'] as const) {
        for (const b of footerButtons(elements(LessonPanel({ ...props, footer })))) (b.props.onClick as () => void)();
      }
      expect(seen).toEqual(['reset', 'keep', 'clear']);
    });

    it('Escape cancels the question first and closes the panel otherwise, stopping there both times', () => {
      for (const [footer, want] of [
        ['rest', 'close'],
        ['confirming', 'keep'],
        ['cleared', 'close'],
      ] as const) {
        const seen: string[] = [];
        let stopped = 0;
        const panel = panelOf(
          elements(LessonPanel({ ...NOOPS, rows: [NOT_STARTED], footer, onClose: () => seen.push('close'), onKeep: () => seen.push('keep') })),
        );
        (panel.props.onKeyDown as (e: unknown) => void)({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => (stopped += 1) });
        expect([seen, stopped], footer).toEqual([[want], 1]);
      }
    });
  });

  describe('with the simulation stopped', () => {
    const stoppedStart: RowView = { ...NOT_STARTED, disabled: true };
    const stoppedLeft: RowView = { ...NOT_STARTED, status: 'inProgress', actions: ['resume', 'restart'], accent: 'resume', disabled: true };

    it('disables Start with the stopped title', () => {
      const [start] = rowButtons(render([stoppedStart]));
      expect(start?.props.disabled).toBe(true);
      expect(start?.props.title).toBe(SIM_STOPPED_COPY.disabledTitle);
    });

    it('disables Restart and leaves Resume, which sends nothing', () => {
      const [resume, restart] = rowButtons(render([stoppedLeft]));
      expect(resume?.props.disabled).toBe(false);
      expect(resume?.props.title).toBeUndefined();
      expect(restart?.props.disabled).toBe(true);
      expect(restart?.props.title).toBe(SIM_STOPPED_COPY.disabledTitle);
    });

    it('a live row has no title on its buttons', () => {
      const [start] = rowButtons(render([NOT_STARTED]));
      expect(start?.props.disabled).toBe(false);
      expect(start?.props.title).toBeUndefined();
    });
  });

  describe('focus', () => {
    const refOf = (el: El | undefined): unknown => (el as unknown as { props: { ref?: unknown } }).props.ref;

    /** A panel whose query answers for the two things the ref looks for. */
    function fakePanel(enabledRowButton: boolean): { panel: unknown; focused: () => string | null } {
      let focused: string | null = null;
      const button = (name: string) => ({
        focus: () => {
          focused = name;
        },
      });
      return {
        panel: {
          querySelector: (selector: string) => {
            if (selector.includes('data-fab-lesson-row')) return enabledRowButton ? button('first action') : null;
            return button('Close');
          },
        },
        focused: () => focused,
      };
    }

    it('sits on the panel and on no button, so a change in the rows can move no focus', () => {
      const els = render(FIVE);
      expect(buttonsOf(els).every((b) => refOf(b) === undefined)).toBe(true);
      expect(typeof refOf(panelOf(els))).toBe('function');
    });

    it('uses one function across renders and across different rows, so a re-render never pulls focus back', () => {
      expect(refOf(panelOf(render(FIVE)))).toBe(refOf(panelOf(render([NOT_STARTED]))));
    });

    it('goes to the first action that can take a press', () => {
      const { panel, focused } = fakePanel(true);
      (refOf(panelOf(render(FIVE))) as (el: unknown) => void)(panel);
      expect(focused()).toBe('first action');
    });

    it('goes to Close when no row can take a press', () => {
      const { panel, focused } = fakePanel(false);
      (refOf(panelOf(render([{ ...NOT_STARTED, disabled: true }]))) as (el: unknown) => void)(panel);
      expect(focused()).toBe('Close');
    });

    it('does nothing as the panel unmounts', () => {
      expect(() => (refOf(panelOf(render(FIVE))) as (el: unknown) => void)(null)).not.toThrow();
    });
  });
});
