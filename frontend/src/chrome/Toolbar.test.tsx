import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { REDO_HELD_TITLE, Toolbar, UNDO_HELD_TITLE, type ToolbarProps } from './Toolbar.tsx';
import { StatusReadout } from './StatusReadout.tsx';
import { HeaderLockup } from './HeaderLockup.tsx';
import { CHROME_CSS } from './chromeCss.ts';
import { SIM_STOPPED_COPY } from './SimStoppedCard.tsx';
import { getChromeAssetSource } from './assets/registry.ts';
import { SHORTCUTS } from '../input/shortcuts.ts';
import { iconElements, parseIconParts } from './svgToElements.ts';

// The vitest env is `node` (no DOM, no testing-library — the phase's "zero new
// packages" discipline holds). A React function component is just a function
// returning a plain element tree, so we invoke Toolbar(props) directly and walk
// the returned tree to assert the Undo/Redo wiring: the buttons exist, carry the
// right disabled state (greyed when unavailable), and map onClick to onUndo/onRedo.
// The browser's "a disabled button swallows the click" is a DOM guarantee out of
// scope for a node unit — we pin the `disabled` prop that produces it instead.

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

/**
 * Every element in the tree in a SINGLE pre-order (document-order) walk. The R0
 * ordering assertion compares positions inside ONE such walk rather than doing
 * two independent lookups, so "the badge comes before the Help button" is a real
 * statement about reading order and not two unrelated existence checks.
 */
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

/** Every `<span>` whose only child is exactly `text`. */
function spansWithText(node: unknown, text: string): El[] {
  return walk(node).filter((n) => n.type === 'span' && n.props.children === text);
}

/** The `<button>` that owns `aria-controls={id}` (the Legend / Help toggles). */
function buttonControlling(node: unknown, id: string): El | undefined {
  return walk(node).find((n) => n.type === 'button' && n.props['aria-controls'] === id);
}

const baseProps = (over: Partial<ToolbarProps> = {}): ToolbarProps => ({
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

describe('Toolbar Undo/Redo buttons (UNDO-04 UX)', () => {
  it('renders exactly one Undo and one Redo button', () => {
    const tree = Toolbar(baseProps());
    expect(findByAria(tree, 'button', 'Undo')).toHaveLength(1);
    expect(findByAria(tree, 'button', 'Redo')).toHaveLength(1);
  });

  it('disables Undo when canUndo is false and enables it when true', () => {
    const off = findByAria(Toolbar(baseProps({ canUndo: false })), 'button', 'Undo')[0];
    expect(off.props.disabled).toBe(true);
    const on = findByAria(Toolbar(baseProps({ canUndo: true })), 'button', 'Undo')[0];
    expect(on.props.disabled).toBe(false);
  });

  it('disables Redo when canRedo is false and enables it when true', () => {
    const off = findByAria(Toolbar(baseProps({ canRedo: false })), 'button', 'Redo')[0];
    expect(off.props.disabled).toBe(true);
    const on = findByAria(Toolbar(baseProps({ canRedo: true })), 'button', 'Redo')[0];
    expect(on.props.disabled).toBe(false);
  });

  it('wires the Undo/Redo button onClick to onUndo/onRedo', () => {
    let undo = 0;
    let redo = 0;
    const tree = Toolbar(
      baseProps({ canUndo: true, canRedo: true, onUndo: () => undo++, onRedo: () => redo++ }),
    );
    (findByAria(tree, 'button', 'Undo')[0].props.onClick as () => void)();
    (findByAria(tree, 'button', 'Redo')[0].props.onClick as () => void)();
    expect(undo).toBe(1);
    expect(redo).toBe(1);
  });

  it('gives the buttons discoverable keybinding titles', () => {
    const tree = Toolbar(baseProps());
    expect(findByAria(tree, 'button', 'Undo')[0].props.title).toBe('Undo (Ctrl+Z)');
    expect(findByAria(tree, 'button', 'Redo')[0].props.title).toBe('Redo (Ctrl+Shift+Z)');
  });
});

describe('Toolbar holds Undo and Redo behind paused edits (plan 74.1-31, PAUSE-TOOLBAR)', () => {
  it('undoHeld disables BOTH buttons even with both stacks non-empty, and the titles say why', () => {
    const tree = Toolbar(baseProps({ canUndo: true, canRedo: true, undoHeld: true }));
    const undo = findByAria(tree, 'button', 'Undo')[0];
    const redo = findByAria(tree, 'button', 'Redo')[0];
    expect(undo.props.disabled).toBe(true);
    expect(redo.props.disabled).toBe(true);
    expect(undo.props.title).toBe(UNDO_HELD_TITLE);
    expect(redo.props.title).toBe(REDO_HELD_TITLE);
    expect(UNDO_HELD_TITLE).toMatch(/press Play/);
    expect(REDO_HELD_TITLE).toMatch(/press Play/);
    expect(UNDO_HELD_TITLE + REDO_HELD_TITLE).not.toContain('\u2014');
  });

  it('undoHeld false (or absent) leaves both buttons on their stacks and their keybinding titles', () => {
    for (const undoHeld of [false, undefined]) {
      const tree = Toolbar(baseProps({ canUndo: true, canRedo: true, undoHeld }));
      expect(findByAria(tree, 'button', 'Undo')[0].props.disabled).toBe(false);
      expect(findByAria(tree, 'button', 'Redo')[0].props.disabled).toBe(false);
      expect(findByAria(tree, 'button', 'Undo')[0].props.title).toBe('Undo (Ctrl+Z)');
    }
  });

  it('the accessible names never change while held', () => {
    const tree = Toolbar(baseProps({ undoHeld: true }));
    expect(findByAria(tree, 'button', 'Undo')).toHaveLength(1);
    expect(findByAria(tree, 'button', 'Redo')).toHaveLength(1);
  });
});

describe('Toolbar status strip (plan 74.1-31, PAUSE-TOOLBAR)', () => {
  const stripOf = (tree: unknown): El => {
    const strips = walk(tree).filter((n) => n.props['data-fab-status-strip'] !== undefined);
    expect(strips).toHaveLength(1);
    return strips[0];
  };

  it('holds the status readout FIRST and the Unsaved badge second, outside every button cluster', () => {
    const tree = Toolbar(baseProps({ status: 'Paused - edits queued until Play', dirty: true }));
    const strip = stripOf(tree);
    // The readout (a component, its role=status rendered inside it) comes first in
    // document order, the Unsaved badge (a role=status span) after it.
    const order = walk(strip);
    const readoutAt = order.findIndex((n) => n.type === StatusReadout);
    const badgeAt = order.findIndex((n) => n.type === 'span' && n.props.children === 'Unsaved');
    expect(readoutAt).toBeGreaterThanOrEqual(0);
    expect(badgeAt).toBeGreaterThan(readoutAt);
    expect(order[badgeAt].props.role).toBe('status');
    // And the readout appears nowhere else in the header.
    expect(walk(tree).filter((n) => n.type === StatusReadout)).toHaveLength(1);
    expect(spansWithText(tree, 'Unsaved')).toHaveLength(1);
    expect(walk(strip).some((n) => n.type === 'button')).toBe(false);
    // Out of the row's flex flow, passive.
    const style = strip.props.style as Record<string, unknown>;
    expect(style.position).toBe('absolute');
    expect(style.pointerEvents).toBe('none');
  });

  it('paints no surface while it holds nothing, and the panel surface while it holds text', () => {
    // A user board (no scene badge, plan 91-10), no status, clean: nothing to paint.
    const empty = stripOf(Toolbar(baseProps({ status: '', dirty: false, loadedScene: null }))).props.style as Record<string, unknown>;
    expect(empty.backgroundColor).toBe('transparent');
    expect(empty.padding).toBe(0);
    const full = stripOf(Toolbar(baseProps({ status: 'Loaded', loadedScene: null }))).props.style as Record<string, unknown>;
    expect(full.backgroundColor).toBe('var(--fab-panel-fill)');
    // Plan 91-10 (UI-SPEC 5.4): the scene badge alone also paints the strip.
    const badgeOnly = stripOf(Toolbar(baseProps({ status: '', dirty: false, loadedScene: 'Demo scene' }))).props
      .style as Record<string, unknown>;
    expect(badgeOnly.backgroundColor).toBe('var(--fab-panel-fill)');
    expect(badgeOnly.padding).toBe('var(--fab-space-xs) var(--fab-space-sm)');
  });

  it('holds the scene badge between the status and Unsaved, and lets the status wrap (plan 91-10)', () => {
    const tree = Toolbar(baseProps({ status: 'Loaded', dirty: true, loadedScene: 'Advanced pipeline' }));
    const strip = stripOf(tree);
    const order = walk(strip);
    const readoutAt = order.findIndex((n) => n.type === StatusReadout);
    const sceneAt = order.findIndex((n) => n.props['data-fab-scene-badge'] === '');
    const unsavedAt = order.findIndex((n) => n.type === 'span' && n.props.children === 'Unsaved');
    expect(readoutAt).toBeGreaterThanOrEqual(0);
    expect(sceneAt).toBeGreaterThan(readoutAt);
    expect(unsavedAt).toBeGreaterThan(sceneAt);
    expect((strip.props.style as Record<string, unknown>).whiteSpace).toBe('normal');
    const html = renderToStaticMarkup(createElement(StatusReadout, { status: 'Paused - press Play before undo or redo' }));
    expect(html).toContain('white-space:normal');
    expect(html).toContain('line-height:1.4');
  });

  it('takes the measured placement, and the header right end without one', () => {
    const placed = stripOf(Toolbar(baseProps({ statusStripPlacement: { right: 430, maxWidth: 404 } }))).props
      .style as Record<string, unknown>;
    expect(placed.right).toBe(430);
    expect(placed.maxWidth).toBe(404);
    const plain = stripOf(Toolbar(baseProps())).props.style as Record<string, unknown>;
    expect(plain.right).toBe(0);
    expect(plain.maxWidth).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// QA-02 wall 2 / 52-UI-SPEC R0 - where the gesture-reference badge is NOT.
//
// R0 was built in this Toolbar first, beside the "?" button it names, and it was
// MEASURED back out again: at 114px plus one 8px gap it pushed the primary CTA
// off a 1024px viewport in every board state, taking the minimum non-clipping
// width from 992 -> 1106 (clean) and 1106 -> 1220 (dirty) and breaking the
// SHELL-02 CTA bound this row already owns. The checkpoint decision
// (2026-07-25) re-homed it to the Palette, a vertical panel with the room this
// row does not have; Palette.test.tsx now owns every property assertion.
//
// The guard below is the durable half of that decision: it fails if anyone puts
// a gesture badge back into this row, which is the exact edit that re-breaks the
// 1024px CTA bound.
// ---------------------------------------------------------------------------

const HELP_TITLE = 'Show gesture reference (how to place, connect and extend)';
const LEGEND_TITLE = 'Show machine legend (kinds, states, connections)';
/** U+2014, written as an escape so this guard cannot be defeated by its own copy. */
const EM_DASH = '\u2014';

describe('Toolbar does NOT carry the R0 gesture badge (52-UI-SPEC R0, 2026-07-25)', () => {
  it('adds no gesture-reference readout to the right cluster, in any board state', () => {
    // Any text child mentioning "Gestures" in this row is the regression: the
    // cluster has no width budget for one (see the e2e CTA-clipping sweep).
    for (const loadedScene of ['Demo scene', null] as const) {
      for (const dirty of [true, false]) {
        const texts = walk(Toolbar(baseProps({ loadedScene, dirty })))
          .map((n) => n.props.children)
          .filter((c): c is string => typeof c === 'string');
        expect(
          texts.filter((t) => /gestur/i.test(t)),
          `no gesture badge with loadedScene=${String(loadedScene)} dirty=${dirty}`,
        ).toEqual([]);
      }
    }
  });
});

describe('Toolbar panel-button titles name what is behind them (QA-02 R2)', () => {
  it('gives the Help and Legend buttons their contents-naming titles', () => {
    const tree = Toolbar(baseProps());
    expect(findByAria(tree, 'button', 'Help')[0].props.title).toBe(HELP_TITLE);
    expect(buttonControlling(tree, 'fab-legend-panel')!.props.title).toBe(LEGEND_TITLE);
  });

  it('carries no em dash in either new title (house rule)', () => {
    for (const s of [HELP_TITLE, LEGEND_TITLE]) {
      expect(s).not.toContain(EM_DASH);
    }
  });

  it('does NOT rename either control: the accessible names are frozen', () => {
    // Phase-32 getByRole readiness contract + the live e2e suite pin these. Only
    // the `title` hover layer moved; touching either name is out of contract.
    const tree = Toolbar(baseProps());
    expect(findByAria(tree, 'button', 'Help')).toHaveLength(1);
    const legend = buttonControlling(tree, 'fab-legend-panel')!;
    expect(legend.props['aria-label'], 'the Legend button has no aria-label to override its text')
      .toBeUndefined();
    expect(spansWithText(legend.props.children, 'Legend')).toHaveLength(1);
  });
});

// Phase 76 (plan 76-03, D-09, 76-UI-SPEC 7): the machine-name toggle reads "Names". Labels
// are now notes with words of their own, so "Labels" would name the wrong thing.
describe('Toolbar names toggle (76-03, D-09)', () => {
  const namesToggle = (labelsToggled = false): El => {
    const hits = walk(Toolbar(baseProps({ labelsToggled }))).filter(
      (n) => n.type === 'button' && n.props.title === 'Reveal machine names (hold Alt)',
    );
    expect(hits, 'exactly one machine-name toggle').toHaveLength(1);
    return hits[0];
  };

  it('is named Names by its visible text, with no aria-label to override it, and the title unchanged', () => {
    const btn = namesToggle();
    expect(btn.props['aria-label']).toBeUndefined();
    expect(spansWithText(btn.props.children, 'Names')).toHaveLength(1);
    expect(spansWithText(btn.props.children, 'Labels')).toHaveLength(0);
  });

  it('keeps its pressed state on aria-pressed and the pressed bevel', () => {
    expect(namesToggle(true).props['aria-pressed']).toBe(true);
    expect(String(namesToggle(true).props.className)).toContain('is-pressed');
    expect(namesToggle(false).props['aria-pressed']).toBe(false);
  });

  it('no toolbar control is named Labels any more', () => {
    expect(spansWithText(Toolbar(baseProps()), 'Labels')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EX-02: the generalized scene badge (ONB-01 idiom, nullable display name).
// ---------------------------------------------------------------------------

describe('Toolbar scene badge (EX-02 generalized ONB-01 readout)', () => {
  it('renders the byte-identical "Demo scene" string when the demo is loaded', () => {
    const tree = Toolbar(baseProps({ loadedScene: 'Demo scene' }));
    expect(spansWithText(tree, 'Demo scene')).toHaveLength(1);
    expect(spansWithText(tree, 'Order processing')).toHaveLength(0);
  });

  it('renders "Order processing" when the example is loaded', () => {
    const tree = Toolbar(baseProps({ loadedScene: 'Order processing' }));
    expect(spansWithText(tree, 'Order processing')).toHaveLength(1);
    expect(spansWithText(tree, 'Demo scene')).toHaveLength(0);
  });

  it('renders NO badge on a user board (loadedScene null)', () => {
    const tree = Toolbar(baseProps({ loadedScene: null }));
    expect(spansWithText(tree, 'Demo scene')).toHaveLength(0);
    expect(spansWithText(tree, 'Order processing')).toHaveLength(0);
  });

  // MOVED BY PLAN 91-10 (CHROME-15, UI-SPEC 5.4, research A3). This read "keeps the badge a passive
  // readout (pointerEvents none, no role)" and pinned an inline `pointerEvents: 'none'`. The badge
  // now sits in the status strip, inherits the strip's `none` and declares none of its own:
  // `observeBadgeTruncation` gives it `auto` only while its name is cut, so its title can show.
  it('keeps the badge a passive readout in the strip (no inline pointer events, no role, no tab stop)', () => {
    const tree = Toolbar(baseProps({ loadedScene: 'Order processing' }));
    const badge = walk(tree).find(
      (n) => n.type === 'span' && n.props.children === 'Order processing',
    )!;
    expect((badge.props.style as Record<string, unknown>).pointerEvents).toBeUndefined();
    expect(badge.props.role, 'the badge carries no role').toBeUndefined();
    expect(badge.props.tabIndex, 'the badge takes no tab stop').toBeUndefined();
    const strip = walk(tree).find((n) => n.props['data-fab-status-strip'] !== undefined)!;
    expect(walk(strip).includes(badge), 'the badge is inside the status strip').toBe(true);
    expect((strip.props.style as Record<string, unknown>).pointerEvents).toBe('none');
  });

  it('carries its locator, the full name as its title, the 20ch cap and the ellipsis rule (plan 91-10)', () => {
    const tree = Toolbar(baseProps({ loadedScene: 'Advanced pipeline' }));
    const badge = walk(tree).find((n) => n.props['data-fab-scene-badge'] === '')!;
    expect(badge, 'the badge has its stable locator').toBeDefined();
    expect(badge.props.title).toBe('Advanced pipeline');
    expect(badge.props.children).toBe('Advanced pipeline');
    expect(typeof badge.props.ref, 'the truncation observer is attached').toBe('function');
    const st = badge.props.style as Record<string, unknown>;
    expect(st.maxWidth).toBe('calc(20ch + 2 * var(--fab-space-sm) + 2px)');
    expect(st.minWidth).toBe(66);
    expect(st.flex).toBe('0 1 auto');
    expect(st.overflow).toBe('hidden');
    expect(st.textOverflow).toBe('ellipsis');
    expect(st.whiteSpace).toBe('nowrap');
    // It left the brand column (the row's clip victim).
    const column = walk(tree).find((n) => n.props['data-fab-brand-column'] === '')!;
    expect(walk(column).some((n) => n.props.children === 'Advanced pipeline')).toBe(false);
  });
});

describe('Toolbar heading and logo (MARK-17, phase 80.1)', () => {
  // Until 2026-10-11 only the Playwright `logo.spec.ts` guarded these. The re-verification
  // (`reverify-2026-10-11/phase-80.1.md`, M1-M5) added a second h1, emptied it, deleted it,
  // made it visible and put the square back in the header: all 1314 unit tests stayed green.
  //
  // The markup comes from `renderToStaticMarkup`, which EXPANDS child components, so an h1
  // smuggled in through a child (the lockup, the popover) is counted too. A direct
  // `Toolbar(props)` call would stop at the child component boundary.
  const markup = (over: Partial<ToolbarProps> = {}): string =>
    renderToStaticMarkup(createElement(Toolbar, baseProps(over)));

  /** Every `<h1 ...>` opening tag in the markup. `<h1` cannot collide with `<h10`; there is none. */
  const h1Tags = (html: string): string[] => [...html.matchAll(/<h1[\s>][^>]*>?/g)].map((m) => m[0]);

  it('renders exactly one h1, in every board state', () => {
    for (const over of [{}, { dirty: true, loadedScene: null }, { playing: true, helpOpen: true }]) {
      expect(h1Tags(markup(over)), `h1 tags for ${JSON.stringify(over)}`).toHaveLength(1);
    }
  });

  it('the h1 reads exactly "Fabrico" and carries the visually hidden class', () => {
    const found = [...markup().matchAll(/<h1( class="([^"]*)")?>([^<]*)<\/h1>/g)];
    expect(found, 'no h1 with plain text content was rendered').toHaveLength(1);
    const [, , className, text] = found[0]!;
    expect(text, 'the heading text').toBe('Fabrico');
    expect((className ?? '').split(/\s+/), 'the heading is not visually hidden').toContain(
      'fab-visually-hidden',
    );
  });

  it('the visually hidden class really hides: its CHROME_CSS rule clips to nothing', () => {
    // The class name alone is a label. This pins the rule behind it, so emptying or weakening
    // the rule reddens here instead of putting a second visible "Fabrico" beside the lockup.
    const rule = /\.fab-visually-hidden\s*\{([^}]*)\}/.exec(CHROME_CSS);
    expect(rule, 'CHROME_CSS has no .fab-visually-hidden rule').not.toBeNull();
    const decls = new Map(
      rule![1]!
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const at = d.indexOf(':');
          return [d.slice(0, at).trim(), d.slice(at + 1).trim()] as const;
        }),
    );
    expect(decls.get('position')).toBe('absolute');
    expect(decls.get('width')).toBe('1px');
    expect(decls.get('height')).toBe('1px');
    expect(decls.get('overflow')).toBe('hidden');
    expect(decls.get('clip-path')).toBe('inset(50%)');
  });

  it('draws the header lockup once and never the square', () => {
    // FOUR INDEPENDENT READS, and the first one changed shape on 2026-10-11. This case used to
    // import the square's component and assert `tree.filter((n) => n.type === LogoMark)` was
    // empty. That component (LogoMark.tsx) was retired on 2026-10-11 because nothing in the app
    // rendered it, so an identity check against it would import a deleted module. The four reads
    // below cover the same property without it, and two of them are stronger than identity was:
    //   1. no element in the toolbar's tree is a component NAMED LogoMark (memo unwrapped), so a
    //      resurrected square component reddens here whatever file it comes back in;
    //   2. no rendered element carries the square's old test id;
    //   3. none of the square's three paths reaches the rendered markup, compared as GEOMETRY
    //      (commands and numbers, whitespace dropped) rather than as exact text, so a hand-written
    //      inline copy with compacted `d` strings reddens as well as a render through
    //      `iconElements` or the registry;
    //   4. the header markup carries no `<img>` and no `data:` URI at all, so the asset cannot
    //      come back percent-encoded inside an image, where read 3 cannot see its paths.
    // WHAT THIS DOES NOT COVER, said plainly: a square redrawn with DIFFERENT coordinates (a
    // scaled or translated copy), or reached through a CSS background. Those are a new drawing,
    // and `e2e/logo.spec.ts`'s passive-accent scan (an accent-painted element in the header that
    // is neither interactive nor the lockup item reddens it) is the layer meant to catch those.
    const tree = walk(Toolbar(baseProps()));
    expect(tree.filter((n) => n.type === HeaderLockup), 'HeaderLockup elements').toHaveLength(1);

    const nameOf = (type: unknown): string => {
      if (typeof type === 'function') return type.name;
      if (typeof type === 'object' && type !== null) {
        const t = type as { displayName?: string; type?: unknown };
        if (typeof t.displayName === 'string') return t.displayName;
        return nameOf(t.type);
      }
      return '';
    };
    const names = tree.map((n) => nameOf(n.type));
    // Vacuity refusal: the reader must see through React.memo, or read 1 could pass on a tree
    // where every component name comes back empty. HeaderLockup is memo-wrapped too.
    expect(names, 'component names read through memo').toContain('HeaderLockup');
    expect(names.filter((n) => /logo\s*mark/i.test(n)), 'LogoMark components in the header').toEqual([]);

    const html = markup();
    expect(html.match(/data-testid="header-lockup"/g) ?? [], 'rendered header lockups').toHaveLength(1);
    expect(html.match(/data-testid="logo-mark"/g) ?? [], 'rendered logo marks').toHaveLength(0);

    const square = getChromeAssetSource('logomark');
    const squareDs = parseIconParts(square).map((p) => p.d);
    expect(squareDs, 'the square asset still declares its three layers').toHaveLength(3);
    // Positive control: the needle is in the form the renderer emits, so its absence below is
    // evidence and not a spelling mismatch.
    const drawn = renderToStaticMarkup(createElement('svg', null, iconElements(square, { strokeWidthScale: 1 })));
    for (const d of squareDs) expect(drawn, `the square drawn alone carries d="${d}"`).toContain(`d="${d}"`);
    // Geometry, not spelling: `M 3 23 H 29` and `M3 23H29` are the same path.
    const geom = (d: string): string => (d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? []).join(',');
    const headerGeoms = [...html.matchAll(/\sd="([^"]*)"/g)].map((m) => geom(m[1]!));
    // Vacuity refusal: the lockup itself draws paths, so the reader must find some.
    expect(headerGeoms.length, 'd attributes read out of the header markup').toBeGreaterThan(0);
    for (const d of squareDs) {
      expect(headerGeoms.includes(geom(d)), `the header carries the square's path ${d}`).toBe(false);
    }
    expect(html.match(/<img[\s>]/g) ?? [], 'img elements in the header').toEqual([]);
    expect(html.match(/data:/g) ?? [], 'data: URIs in the header').toEqual([]);
  });
});

// Phase 90 (FAIL-01, UI-SPEC 1.5): the stopped simulation's readout is the warning glyph and the
// word in ink; the shipped `disconnected` readout keeps its destructive word tint.
describe('StatusReadout - the stopped simulation', () => {
  const markup = (status: string, kind: Parameters<typeof StatusReadout>[0]['kind']): string =>
    renderToStaticMarkup(createElement(StatusReadout, { status, kind }));

  /** The readout span's own opening tag: the word's colour lives there, the glyph's on the svg. */
  const spanTag = (html: string): string => /^<span[^>]*>/.exec(html)?.[0] ?? '';

  it('simStopped shows the warning glyph and the word in --fab-ink, not the destructive tint', () => {
    const html = markup('Simulation stopped', 'simStopped');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(spanTag(html)).toContain('color:var(--fab-ink)');
    expect(spanTag(html)).not.toContain('--fab-destructive');
    expect(spanTag(html)).toContain('gap:var(--fab-space-xs)');
    expect(html.endsWith('Simulation stopped</span>')).toBe(true);
  });

  // Phase 90 UI review (Color, finding 4): the destructive word read 2.92:1 on the panel fill, so
  // `Disconnected` follows the `Simulation stopped` rule: the glyph carries the tone, the word is ink.
  it('disconnected carries the glyph beside an ink word, and an idle readout shows no glyph', () => {
    const down = markup('Disconnected - live view frozen', 'disconnected');
    expect(down).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(spanTag(down)).toContain('color:var(--fab-ink)');
    expect(spanTag(down)).not.toContain('--fab-destructive');
    const idle = markup('Loaded', 'loaded');
    expect(idle).not.toContain('<svg');
    expect(spanTag(idle)).toContain('color:var(--fab-ink)');
  });
});

// Phase 90 (FAIL-01, D-12, UI-SPEC 1.4): on a stopped simulation every control that would send to
// the host is disabled and says why; the accessible names do not change.
describe('Toolbar on a stopped simulation', () => {
  /** A button by its accessible name: its aria-label, else the text of its one span child. */
  const named = (tree: unknown, name: string): El[] =>
    walk(tree).filter((n) => {
      if (n.type !== 'button') return false;
      if (n.props['aria-label'] !== undefined) return n.props['aria-label'] === name;
      const kids = Array.isArray(n.props.children) ? n.props.children : [n.props.children];
      return kids.some((k) => isEl(k) && k.type === 'span' && k.props.children === name);
    });
  const SENDERS = ['Play', 'Step', 'Undo', 'Redo', 'New', 'Save', 'Load', 'Examples'] as const;

  it('disables every control that would reach the host, each titled with the reason', () => {
    const tree = Toolbar(baseProps({ simStopped: true, playing: true, canUndo: true, canRedo: true, examplesOpen: true }));
    for (const name of SENDERS) {
      const hits = named(tree, name);
      expect(hits, `${name}: one button by its unchanged name`).toHaveLength(1);
      expect(hits[0]!.props.disabled, `${name}: disabled while stopped`).toBe(true);
      expect(hits[0]!.props.title, `${name}: titled with the reason`).toBe(SIM_STOPPED_COPY.disabledTitle);
    }
    // Play shows the Play glyph, unpressed, named Play, though the page last thought it played.
    const play = named(tree, 'Play')[0]!;
    expect(play.props.className).toBe('fab-tool-btn');
    expect(named(tree, 'Pause')).toHaveLength(0);
    // An open Examples popover is not drawn on a stopped board.
    expect(walk(tree).some((n) => n.props.onSelect !== undefined && n.props.onEscape !== undefined)).toBe(false);
  });

  it('leaves the client-only controls working', () => {
    const tree = Toolbar(baseProps({ simStopped: true }));
    expect(buttonControlling(tree, 'fab-help-panel')?.props.disabled).toBeUndefined();
    expect(buttonControlling(tree, 'fab-legend-panel')?.props.disabled).toBeUndefined();
  });

  it('a running simulation keeps every shipped title and enabled state', () => {
    for (const simStopped of [false, undefined]) {
      const tree = Toolbar(baseProps({ simStopped, playing: true, canUndo: true, canRedo: true }));
      expect(named(tree, 'Pause')[0]!.props.disabled).toBe(false);
      expect(named(tree, 'Pause')[0]!.props.title).toBe('Pause (Space)');
      expect(named(tree, 'Step')[0]!.props.title).toBe('Step one tick (.)');
      expect(named(tree, 'New')[0]!.props.title).toBe('New board (Ctrl+N)');
      expect(named(tree, 'Save')[0]!.props.title).toBe('Save (Ctrl+S) - Shift for Save As');
      // Phase 91 (UI-SPEC A20): Load states its shortcut like New and Save do.
      expect(named(tree, 'Load')[0]!.props.title).toBe('Load a saved factory (Ctrl+O)');
      expect(named(tree, 'Save')[0]!.props.disabled).toBe(false);
      expect(named(tree, 'Load')[0]!.props.disabled).toBe(false);
      expect(named(tree, 'Examples')[0]!.props.disabled).toBe(false);
    }
  });
});

// Phase 91 (D-11, CHROME-11): every toolbar title that names a key reads that key's label from
// the one shortcut table the keyboard handler reads, so a title cannot name a key the board
// does not bind. The words above are the rendered text; this case ties each to its entry.
describe('Toolbar key titles read the shortcut table (CHROME-11)', () => {
  /** A button by its accessible name (the stopped-simulation describe's helper). */
  const named = (tree: unknown, name: string): El[] =>
    walk(tree).filter((n) => {
      if (n.type !== 'button') return false;
      if (n.props['aria-label'] !== undefined) return n.props['aria-label'] === name;
      const kids = Array.isArray(n.props.children) ? n.props.children : [n.props.children];
      return kids.some((k) => isEl(k) && k.type === 'span' && k.props.children === name);
    });
  it('names each key by its table label', () => {
    const tree = Toolbar(baseProps({ playing: false, canUndo: true, canRedo: true }));
    const title = (n: string): string => String(named(tree, n)[0]!.props.title);
    expect(title('Play')).toContain(`(${SHORTCUTS.playPause.label})`);
    expect(title('Step')).toContain(`(${SHORTCUTS.step.label})`);
    expect(title('New')).toContain(`(${SHORTCUTS.newBoard.label})`);
    expect(title('Save')).toContain(`(${SHORTCUTS.save.label})`);
    expect(title('Load')).toContain(`(${SHORTCUTS.open.label})`);
    expect(findByAria(tree, 'button', 'Undo')[0]!.props.title).toBe(`Undo (${SHORTCUTS.undo.label})`);
    expect(findByAria(tree, 'button', 'Redo')[0]!.props.title).toBe(`Redo (${SHORTCUTS.redo.label})`);
    expect(title('Names')).toContain(`hold ${SHORTCUTS.names.label}`);
  });
});

// Phase 91, plan 91-09 (CHROME-07): the Examples popover is the header's child, so its own
// zIndex counts only inside the header's stacking context. The inspector and Help dock in the
// band the popover drops into, at the same 2 and mounted after the header, so the header takes 3
// while the popover is open and paints it over both.
describe('Toolbar header stacking while the Examples popover is open (CHROME-07)', () => {
  it('is the chrome layer 2 at rest and 3 while Examples is open', () => {
    const shut = Toolbar(baseProps({ examplesOpen: false })) as unknown as El;
    const open = Toolbar(baseProps({ examplesOpen: true })) as unknown as El;
    expect(shut.type).toBe('header');
    expect((shut.props.style as Record<string, unknown>).zIndex).toBe(2);
    expect((open.props.style as Record<string, unknown>).zIndex).toBe(3);
  });
});

// Phase 91, plan 91-10 (CHROME-15, D-14, UI-SPEC 5.1 to 5.3): the header is a three-column grid so
// the transport never moves, the tick goes compact from 10,000,000 in a 14ch slot, and the lockup
// sits alone in a slot its column can hide whole. The boxes are graded in
// `e2e/toolbar-stability.spec.ts`; these pin the declarations that produce them.
describe('Toolbar holds the transport in a fixed column (plan 91-10, CHROME-15)', () => {
  const header = (over: Partial<ToolbarProps> = {}): El => {
    const tree = Toolbar(baseProps(over)) as unknown as El;
    expect(tree.type).toBe('header');
    return tree;
  };
  const tickSpan = (tick: number): El =>
    walk(Toolbar(baseProps({ tick }))).find((n) => n.type === 'span' && n.props.title === 'Current sim tick')!;
  const tickText = (tick: number): string => {
    const c = tickSpan(tick).props.children;
    return (Array.isArray(c) ? c : [c]).join('');
  };

  it('lays the header out as the UI-SPEC 5.1 grid, with 14 px padding on every side', () => {
    const s = header().props.style as Record<string, unknown>;
    expect(s.display).toBe('grid');
    expect(s.gridTemplateColumns).toBe('minmax(0, 1fr) auto minmax(max-content, 1fr)');
    expect(s.columnGap).toBe('var(--fab-space-sm)');
    expect(s.padding).toBe('calc(var(--fab-space-sm) + var(--fab-bezel-ring))');
  });

  it('gives no grid item an auto margin, and the transport and right clusters a 4 px gap', () => {
    const items = walk(header()).filter((n) => n.type === 'div');
    for (const n of items) expect((n.props.style as Record<string, unknown> | undefined)?.margin).toBeUndefined();
    const transport = items.find((n) => findByAria(n, 'button', 'Play').length === 1 && n.props['data-fab-brand-column'] === undefined)!;
    expect((transport.props.style as Record<string, unknown>).gap).toBe('var(--fab-space-xs)');
    const right = items.find((n) => findByAria(n, 'button', 'Help').length === 1 && findByAria(n, 'button', 'Play').length === 0)!;
    expect((right.props.style as Record<string, unknown>).gap).toBe('var(--fab-space-xs)');
    expect((right.props.style as Record<string, unknown>).justifySelf).toBe('end');
  });

  it('reads grouped up to 9,999,999 and compact from 10,000,000, in a 14ch slot', () => {
    expect(tickText(0)).toBe('tick 0');
    expect(tickText(9_999_999)).toBe('tick 9,999,999');
    expect(tickText(10_000_000)).toBe('tick 10M');
    expect(tickText(12_345_678)).toBe('tick 12.3M');
    expect((tickSpan(0).props.style as Record<string, unknown>).minWidth).toBe('14ch');
    expect('tick 9,999,999'.length).toBeLessThanOrEqual(14);
  });

  it('holds the lockup alone in a slot inside the observed left column', () => {
    const column = walk(header()).find((n) => n.props['data-fab-brand-column'] === '')!;
    expect(column, 'the left column is marked').toBeDefined();
    expect(typeof column.props.ref, 'the column carries the lockup-fit observer').toBe('function');
    const slot = walk(column).find((n) => n.props['data-fab-lockup-slot'] === '')!;
    expect(slot, 'the lockup has its own slot').toBeDefined();
    const kids = (Array.isArray(slot.props.children) ? slot.props.children : [slot.props.children]).filter(isEl);
    expect(kids.map((k) => k.type)).toEqual([HeaderLockup]);
    expect((slot.props.style as Record<string, unknown>).flexShrink).toBe(0);
  });
});
