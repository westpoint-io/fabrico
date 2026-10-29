import { describe, expect, it } from 'vitest';
import { DeleteControl, type DeleteControlProps } from './DeleteControl.tsx';

// The vitest env is `node` (see vitest.config: no DOM, no testing-library — the
// repo's "zero new packages" discipline holds). A React function component is just
// a function returning a plain element tree, so we invoke DeleteControl(props)
// directly and walk the returned tree, exactly like Toolbar.test.tsx.
//
// Enter/Space activating a button is a NATIVE DOM guarantee (the WAI-ARIA button
// contract routes Enter/Space through the element's click/onClick), out of scope
// for a node unit. We therefore pin the STRUCTURAL guarantee that produces it:
// the control is a real `<button type="button">` whose single activation path is
// `onClick={onDelete}`. Click, Enter, and Space all fire that one path, so the
// three activations are covered by asserting the native button + its onClick.

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}

/** Collect every element in the tree whose tag + aria-label match. */
function findByAria(node: unknown, tag: string, label: string): El[] {
  const hits: El[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isEl(n)) {
      return;
    }
    if (n.type === tag && n.props['aria-label'] === label) {
      hits.push(n);
    }
    visit(n.props.children);
  };
  visit(node);
  return hits;
}

const baseProps = (over: Partial<DeleteControlProps> = {}): DeleteControlProps => ({
  left: 120,
  top: 48,
  onDelete: () => {},
  ...over,
});

describe('DeleteControl (IX-04 discoverable delete affordance)', () => {
  it('renders exactly one button with the accessible name "Delete machine"', () => {
    const tree = DeleteControl(baseProps());
    const buttons = findByAria(tree, 'button', 'Delete machine');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.title).toBe('Delete machine');
  });

  it('is a native <button type="button"> (so Enter/Space activate via onClick)', () => {
    const btn = findByAria(DeleteControl(baseProps()), 'button', 'Delete machine')[0];
    expect(btn.props.type).toBe('button');
  });

  it('positions the button absolutely at the given left/top', () => {
    const btn = findByAria(DeleteControl(baseProps({ left: 200, top: 90 })), 'button', 'Delete machine')[0];
    const style = btn.props.style as Record<string, unknown>;
    expect(style.position).toBe('absolute');
    expect(style.left).toBe(200);
    expect(style.top).toBe(90);
  });

  it('fires onDelete on click', () => {
    let calls = 0;
    const btn = findByAria(
      DeleteControl(baseProps({ onDelete: () => calls++ })),
      'button',
      'Delete machine',
    )[0];
    (btn.props.onClick as () => void)();
    expect(calls).toBe(1);
  });

  it('fires onDelete exactly once per Enter activation (native button click path)', () => {
    let calls = 0;
    const btn = findByAria(
      DeleteControl(baseProps({ onDelete: () => calls++ })),
      'button',
      'Delete machine',
    )[0];
    // Native <button> translates an Enter keypress into a click → onClick.
    (btn.props.onClick as () => void)();
    expect(calls).toBe(1);
  });

  it('fires onDelete exactly once per Space activation (native button click path)', () => {
    let calls = 0;
    const btn = findByAria(
      DeleteControl(baseProps({ onDelete: () => calls++ })),
      'button',
      'Delete machine',
    )[0];
    // Native <button> translates a Space keyup into a click → onClick.
    (btn.props.onClick as () => void)();
    expect(calls).toBe(1);
  });
});
