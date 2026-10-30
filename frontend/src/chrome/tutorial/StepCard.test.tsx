import { describe, expect, it } from 'vitest';
import { StepCard, type StepCardView } from './StepCard.tsx';

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
  text: ['A ', { kind: 0 }, ' makes items.'],
};

function render(view: StepCardView): El[] {
  return elements(StepCard({ view, onLeave: () => {} }));
}

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

  it('announces its text politely, with no role', () => {
    const live = render(RUNNING).filter((el) => el.props['aria-live'] !== undefined);
    expect(live, 'one live region').toHaveLength(1);
    expect(live[0]?.props['aria-live']).toBe('polite');
    expect(live[0]?.props['aria-atomic']).toBe('true');
    expect(live[0]?.props.role).toBeUndefined();
    expect(render(RUNNING).filter((el) => el.props.role !== undefined), 'no role anywhere on the card').toEqual([]);
  });

  it('passes the pointer through everywhere but the button box', () => {
    const tree = render(RUNNING);
    expect(styleOf(tree[0]!).pointerEvents).toBe('none');
    const auto = tree.filter((el) => styleOf(el).pointerEvents === 'auto');
    expect(auto, 'one element takes the pointer').toHaveLength(1);
    expect(elements(auto[0]!.props.children).map((el) => el.type)).toEqual(['button']);
  });

  it('keeps focus off a pressed button, the way the Palette rows do', () => {
    const [button] = render(RUNNING).filter((el) => el.type === 'button');
    let prevented = 0;
    (button!.props.onMouseDown as (ev: { preventDefault(): void }) => void)({
      preventDefault: () => {
        prevented += 1;
      },
    });
    expect(prevented).toBe(1);
  });

  it('reads the step counter and the instruction while running, with Leave', () => {
    const text = textOf(StepCard({ view: RUNNING, onLeave: () => {} }));
    expect(text).toContain('Step 1 of 6');
    expect(text).toContain('A Source makes items.');
    expect(text).toContain('Leave');
  });

  it('sets the step counter and a machine name at weight 700, and the rest at the body weight', () => {
    const bold = render(RUNNING).filter((el) => styleOf(el).fontWeight === 700);
    expect(bold.map((el) => textOf(el))).toEqual(['Step 1 of 6', 'Source']);
  });

  it('shows a note above the step counter when there is one', () => {
    const text = textOf(StepCard({ view: { ...RUNNING, note: ['Step 1 was already done.'] }, onLeave: () => {} }));
    expect(text.indexOf('Step 1 was already done.')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Step 1 was already done.')).toBeLessThan(text.indexOf('Step 1 of 6'));
  });

  it('reads Clearing the board with no step counter while a new board is on its way', () => {
    const text = textOf(StepCard({ view: { state: 'starting' }, onLeave: () => {} }));
    expect(text).toContain('Clearing the board.');
    expect(text).not.toMatch(/Step \d/);
    expect(text).toContain('Leave');
  });

  it('calls onLeave when Leave is pressed', () => {
    let left = 0;
    const tree = elements(StepCard({ view: { state: 'starting' }, onLeave: () => (left += 1) }));
    (tree.find((el) => el.type === 'button')!.props.onClick as () => void)();
    expect(left).toBe(1);
  });
});
