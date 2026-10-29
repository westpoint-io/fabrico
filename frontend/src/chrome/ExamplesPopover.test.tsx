import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_ENTRIES,
  EXAMPLES_POPOVER_ID,
  ExamplesPopover,
} from './ExamplesPopover.tsx';
import { Toolbar, type ToolbarProps } from './Toolbar.tsx';

// The vitest env is `node` (no DOM). ExamplesPopover is HOOK-FREE by design
// (the 53-07 lesson), so it is invoked directly and its tree walked, exactly
// like Toolbar.test.tsx. The DOM-only halves (outside-click document listener,
// focus-return on close — both owned by App) are covered by the CI=1 Playwright
// quit-guard popover cases on the real click path.

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}
function walk(node: unknown): El[] {
  const out: El[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isEl(n)) {
      return;
    }
    out.push(n);
    visit(n.props.children);
  };
  visit(node);
  return out;
}

const popoverProps = (over: Partial<Parameters<typeof ExamplesPopover>[0]> = {}) => ({
  onSelect: () => {},
  onEscape: () => {},
  ...over,
});

const baseToolbarProps = (over: Partial<ToolbarProps> = {}): ToolbarProps => ({
  tick: 0,
  playing: false,
  onPlayPause: () => {},
  onStep: () => {},
  onNew: () => {},
  onSave: () => {},
  onLoad: () => {},
  examplesOpen: false,
  onToggleExamples: () => {},
  onCloseExamples: () => {},
  onLoadScene: () => {},
  onUndo: () => {},
  onRedo: () => {},
  canUndo: false,
  canRedo: false,
  status: '',
  statusKind: 'idle',
  legendOpen: false,
  onToggleLegend: () => {},
  labelsToggled: false,
  onToggleLabels: () => {},
  legendPanelId: 'fab-legend-panel',
  loadedScene: 'Demo scene',
  dirty: false,
  helpOpen: false,
  onToggleHelp: () => {},
  helpPanelId: 'fab-help-panel',
  ...over,
});

describe('ExamplesPopover — one entry per scene, verbatim copy (UI-SPEC)', () => {
  it('renders one button per shipped scene (three): no heading, no separator', () => {
    const tree = ExamplesPopover(popoverProps());
    const all = walk(tree);
    const buttons = all.filter((n) => n.type === 'button');
    // A literal 3, not EXAMPLE_ENTRIES.length: comparing the component's .map output
    // with its own input could never fail (quick 260929-p7p, review IN-03).
    expect(buttons).toHaveLength(3);
    // No heading of any tier, no hr separator, anywhere in the panel.
    expect(all.filter((n) => /^h[1-6]$/.test(String(n.type)))).toHaveLength(0);
    expect(all.filter((n) => n.type === 'hr')).toHaveLength(0);
  });

  it('entry 1 relocates the shipped CTA strings VERBATIM (selector continuity)', () => {
    const tree = ExamplesPopover(popoverProps());
    const [entry1] = walk(tree).filter((n) => n.type === 'button');
    expect(entry1.props.title).toBe('Load the demo scene and watch the engine run');
    const label = walk(entry1.props.children).find((n) => n.type === 'span')!;
    expect(label.props.children).toBe('Load demo scene');
  });

  it('entry 2 carries the new order-processing pair verbatim', () => {
    const tree = ExamplesPopover(popoverProps());
    const [, entry2] = walk(tree).filter((n) => n.type === 'button');
    expect(entry2.props.title).toBe(
      'Load the order-processing example (webhook in, HTTP out)',
    );
    const label = walk(entry2.props.children).find((n) => n.type === 'span')!;
    expect(label.props.children).toBe('Load order processing');
  });

  it('both entries are full-width .fab-tool-btn--labeled buttons in DOM order', () => {
    const tree = ExamplesPopover(popoverProps());
    const buttons = walk(tree).filter((n) => n.type === 'button');
    for (const b of buttons) {
      expect(String(b.props.className)).toContain('fab-tool-btn--labeled');
      expect((b.props.style as Record<string, unknown>).width).toBe('100%');
    }
    // A disclosure, not an ARIA menu (UI-SPEC A2): no role=menu machinery.
    expect(walk(tree).filter((n) => n.props.role === 'menu')).toHaveLength(0);
  });

  it('entry 3 carries the advanced-pipeline pair verbatim', () => {
    const tree = ExamplesPopover(popoverProps());
    const [, , entry3] = walk(tree).filter((n) => n.type === 'button');
    expect(entry3.props.title).toBe(
      'Load the advanced order-fulfilment example (parallel workers, dead-letter queue)',
    );
    const label = walk(entry3.props.children).find((n) => n.type === 'span')!;
    expect(label.props.children).toBe('Load advanced pipeline');
  });

  it('the entries map 1:1 onto the typed SceneWireIds (data contract)', () => {
    expect(EXAMPLE_ENTRIES.map((e) => e.id)).toEqual([
      'demo_scene',
      'order_processing',
      'advanced',
    ]);
  });
});

describe('ExamplesPopover — select and Escape wiring', () => {
  it('selecting an entry fires onSelect with ITS typed SceneWireId', () => {
    const selected: string[] = [];
    const tree = ExamplesPopover(popoverProps({ onSelect: (id) => selected.push(id) }));
    const buttons = walk(tree).filter((n) => n.type === 'button');
    (buttons[0].props.onClick as () => void)();
    (buttons[1].props.onClick as () => void)();
    (buttons[2].props.onClick as () => void)();
    expect(selected).toEqual(['demo_scene', 'order_processing', 'advanced']);
  });

  it('Escape inside the panel fires onEscape (and stops the gesture stack)', () => {
    let escaped = 0;
    let prevented = 0;
    let stopped = 0;
    const tree = ExamplesPopover(popoverProps({ onEscape: () => escaped++ }));
    const panel = walk(tree).find((n) => n.props.id === EXAMPLES_POPOVER_ID)!;
    const onKeyDown = panel.props.onKeyDown as (e: unknown) => void;
    onKeyDown({
      key: 'Escape',
      preventDefault: () => prevented++,
      stopPropagation: () => stopped++,
    });
    expect(escaped).toBe(1);
    expect(prevented).toBe(1);
    expect(stopped).toBe(1);
    // Any other key is NOT a close (natural Tab rides the browser).
    onKeyDown({ key: 'Tab', preventDefault: () => prevented++, stopPropagation: () => stopped++ });
    expect(escaped).toBe(1);
  });
});

describe('Toolbar Examples trigger, the Legend disclosure idiom on a plain labelled button (plan 91-10)', () => {
  it('closed: the CTA reads Examples, popover UNMOUNTED, aria-expanded false', () => {
    const tree = Toolbar(baseToolbarProps({ examplesOpen: false }));
    const cta = walk(tree).find((n) => n.type === 'button' && n.props['data-fab-examples-trigger'] === '')!;
    expect(cta.props['aria-expanded']).toBe(false);
    expect(cta.props['aria-controls']).toBe(EXAMPLES_POPOVER_ID);
    expect(cta.props.title).toBe('Load a shipped example factory');
    const label = walk(cta.props.children).find((n) => n.type === 'span')!;
    expect(label.props.children).toBe('Examples');
    // Mount-only-while-open: the popover element is absent from the closed tree.
    expect(walk(tree).filter((n) => n.type === ExamplesPopover)).toHaveLength(0);
    expect(String(cta.props.className)).not.toContain('is-pressed');
  });

  it('open: the CTA is pressed (is-pressed) and the popover element mounts', () => {
    const tree = Toolbar(baseToolbarProps({ examplesOpen: true }));
    const cta = walk(tree).find((n) => n.type === 'button' && n.props['data-fab-examples-trigger'] === '')!;
    expect(cta.props['aria-expanded']).toBe(true);
    expect(String(cta.props.className)).toContain('is-pressed');
    const popovers = walk(tree).filter((n) => n.type === ExamplesPopover);
    expect(popovers).toHaveLength(1);
  });

  it('the CTA click toggles; the popover wires onSelect/onEscape to the App seams', () => {
    let toggled = 0;
    let closed = 0;
    const loads: string[] = [];
    const tree = Toolbar(
      baseToolbarProps({
        examplesOpen: true,
        onToggleExamples: () => toggled++,
        onCloseExamples: () => closed++,
        onLoadScene: (id) => loads.push(id),
      }),
    );
    const cta = walk(tree).find((n) => n.type === 'button' && n.props['data-fab-examples-trigger'] === '')!;
    (cta.props.onClick as () => void)();
    expect(toggled).toBe(1);
    const popover = walk(tree).find((n) => n.type === ExamplesPopover)!;
    const pProps = popover.props as { onSelect: (id: string) => void; onEscape: () => void };
    pProps.onSelect('order_processing');
    expect(loads).toEqual(['order_processing']);
    pProps.onEscape();
    expect(closed).toBe(1);
  });

  // MOVED BY PLAN 91-10 (CHROME-15, D-14, UI-SPEC 5.5 and Color): this read "keeps exactly ONE
  // .fab-cta (the accent slot)" and counted 1. Examples is a plain labelled button now, so the
  // header holds no `.fab-cta` at all (COUNT header-fab-cta from=1 to=0) and the trigger is the
  // same `fab-tool-btn fab-tool-btn--labeled` as Legend, with `is-pressed` while open.
  it('holds NO .fab-cta in the header; Examples is a plain labelled button with no aria-haspopup menu lie', () => {
    for (const examplesOpen of [false, true]) {
      const tree = Toolbar(baseToolbarProps({ examplesOpen }));
      const ctas = walk(tree).filter(
        (n) => n.type === 'button' && String(n.props.className).split(/\s+/).includes('fab-cta'),
      );
      expect(ctas).toHaveLength(0);
      const trigger = walk(tree).filter((n) => n.type === 'button' && n.props['data-fab-examples-trigger'] === '');
      expect(trigger).toHaveLength(1);
      expect(String(trigger[0].props.className)).toBe(
        examplesOpen ? 'fab-tool-btn fab-tool-btn--labeled is-pressed' : 'fab-tool-btn fab-tool-btn--labeled',
      );
      expect(trigger[0].props['aria-haspopup']).toBeUndefined();
    }
  });
});
