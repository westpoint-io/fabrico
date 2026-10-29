import { describe, expect, it } from 'vitest';
import { GESTURE_ROWS, HELP_PANEL_ID, HelpPanel } from './HelpPanel.tsx';
import { ADD_OUTPUT_LABEL } from './PortsSection.tsx';
import { HELP_OMITS, SHORTCUTS, SHORTCUT_LIST, type ShortcutId } from '../input/shortcuts.ts';
import { CAMERA_CLUSTER_CLEARANCE } from './CameraCluster.tsx';

// The vitest env is `node` (no DOM, no testing-library - the phase's "zero new
// packages" discipline holds), so this file copies the Toolbar.test.tsx harness:
// a React function component is just a function returning a plain element tree,
// so we invoke HelpPanel() directly and walk the returned tree.
//
// WHAT THIS FILE NO LONGER DOES (phase 91, D-11, CHROME-11). Until phase 91 it pinned every row
// byte for byte against a copy of the old UI-SPEC table. That made the test agree with the copy,
// never with the app: the panel named a `Fit` button with no such word, called a belt a wire, and
// left out Undo, Save and Load, all with a green suite. Now each row names the shortcut table
// entries it documents (`cites`), the table is the one the keyboard handlers read
// (`input/shortcuts.ts`), and the cases below check the row against the table and against the
// facts a user would test, not against a second copy of the words.

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}

/** Every element in the tree in a single pre-order (document-order) walk. */
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

/** Every element whose only child is exactly `text` (gesture + binding cells). */
function elementsWithText(node: unknown, text: string): El[] {
  return walk(node).filter((n) => n.props.children === text);
}

/** The row for an action, by its gesture words (a lookup key, not a pinned copy). */
function row(gesture: string): { gesture: string; binding: string; cites: readonly ShortcutId[] } {
  const r = GESTURE_ROWS.find((x) => x.gesture === gesture);
  expect(r, `a Help row "${gesture}"`).toBeDefined();
  return r as { gesture: string; binding: string; cites: readonly ShortcutId[] };
}

describe('Help rows say what the app does (CHROME-11, D-11, UI-SPEC 8.3)', () => {
  it('has an Undo / redo row naming the table keys', () => {
    const r = row('Undo / redo');
    expect(r.binding).toContain(SHORTCUTS.undo.label);
    expect(r.binding).toContain(SHORTCUTS.redo.label);
  });

  it('has a Save / load / new row naming the table keys', () => {
    const r = row('Save / load / new');
    expect(r.binding).toContain(SHORTCUTS.save.label);
    expect(r.binding).toContain(SHORTCUTS.open.label);
    expect(r.binding).toContain(SHORTCUTS.newBoard.label);
  });

  it('calls a belt a belt: the port-to-port gesture is drawn with the Belt tool, never "wire"', () => {
    // `wire` names the cable tool and nothing else: the one row that may say it is the
    // Wire tool's own, and it wires a Route, not a belt.
    for (const r of GESTURE_ROWS) {
      if (/\bwire\b/i.test(r.gesture) || /\bwire\b/i.test(r.binding)) {
        expect(r.gesture, `only the Wire tool row says "wire" (found in "${r.gesture}")`).toBe('Wire a Route');
        expect(r.binding).not.toMatch(/\bbelt\b/i);
      }
    }
    const belt = row('Draw a belt');
    expect(belt.binding).toMatch(/\bBelt tool\b/);
    expect(row('Wire a Route').binding).toMatch(/\bWire tool\b/);
  });

  it('names the Fit button by what it shows, never by a word it does not carry', () => {
    const fit = row('Fit to factory');
    expect(fit.binding).toContain('corner-brackets button');
    expect(fit.binding).not.toMatch(/\bFit\b/);
    expect(fit.binding).toContain(SHORTCUTS.fit.label);
    // Home and the button are one action (both call doFit), so there is one row for it.
    expect(GESTURE_ROWS.filter((r) => r.cites.includes('fit'))).toHaveLength(1);
  });

  it('Pan includes dragging empty floor and Zoom includes the plain mouse wheel', () => {
    expect(row('Pan').binding).toMatch(/drag empty floor/i);
    expect(row('Zoom').binding).toMatch(/mouse wheel/i);
  });

  it('says the zoom control is a reset, not zoom controls', () => {
    expect(row('Reset zoom').binding).toMatch(/zoom %/);
    expect(row('Zoom').binding).not.toMatch(/zoom controls/i);
  });

  it('quotes the real Add-output control label so the reference cannot drift', () => {
    // THE COUPLING to the real control (PortsSection's constant): renaming the button's
    // label fails here rather than shipping a Help panel that points at a button no
    // longer on screen.
    expect(row('Add an output').binding).toContain(ADD_OUTPUT_LABEL);
  });
});

describe('Help rows and the shortcut table cannot drift apart (D-11)', () => {
  it('every row lists the entries it documents, and its binding holds each one\'s label', () => {
    for (const r of GESTURE_ROWS) {
      expect(Array.isArray(r.cites), `row "${r.gesture}" lists its cited entries`).toBe(true);
      for (const id of r.cites) {
        expect(SHORTCUTS[id], `row "${r.gesture}" cites a real entry "${id}"`).toBeDefined();
        expect(r.binding, `row "${r.gesture}" names ${id} by its label`).toContain(SHORTCUTS[id].label);
      }
    }
  });

  it('every table entry is in some row, except the named omissions, each with a reason', () => {
    const cited = new Set(GESTURE_ROWS.flatMap((r) => [...r.cites]));
    const omitted = new Set(HELP_OMITS.map((o) => o.id));
    expect(HELP_OMITS.map((o) => o.id).sort()).toEqual(['redoY', 'saveAs']);
    for (const o of HELP_OMITS) {
      expect(o.reason.length, `${o.id} carries a reason`).toBeGreaterThan(20);
      expect(cited.has(o.id), `${o.id} is omitted, so no row cites it`).toBe(false);
    }
    for (const s of SHORTCUT_LIST) {
      expect(cited.has(s.id) || omitted.has(s.id), `entry ${s.id} (${s.label}) has a Help row`).toBe(true);
    }
  });

  it('a row that names a table key cites it, so no key text is typed beside the table', () => {
    // The Ctrl labels and the single-key labels a user reads. A row that spells one without
    // citing its entry would be hand-typed again, which is the drift this file exists to stop.
    for (const s of SHORTCUT_LIST) {
      if (s.label.length < 3) continue; // `.` and `R` are too short to search for in prose
      for (const r of GESTURE_ROWS) {
        if (r.binding.includes(s.label) && !r.cites.includes(s.id)) {
          // A longer label can contain a shorter one (Ctrl+Shift+Z holds no Ctrl+Z; Shift+R holds R).
          const coveredByCited = r.cites.some((id) => SHORTCUTS[id].label.includes(s.label));
          expect(coveredByCited, `row "${r.gesture}" spells ${s.label} without citing ${s.id}`).toBe(true);
        }
      }
    }
  });
});

describe('HelpPanel GESTURE_ROWS shape (UI-SPEC 8.3 counts)', () => {
  it('holds 20 rows (16 until phase 91)', () => {
    // 2026-10-24, plan 91-06: 16 to 20 (Undo / redo, Save / load / new, Wire a Route, Reset zoom
    // and Show names added; Home and Fit merged into one row).
    expect(GESTURE_ROWS).toHaveLength(20);
    expect(new Set(GESTURE_ROWS.map((r) => r.gesture)).size).toBe(20);
  });

  it('keeps the build cluster contiguous: the chains follow Draw a belt and lead to Delete', () => {
    const at = (g: string): number => GESTURE_ROWS.findIndex((r) => r.gesture === g);
    // The anchor moved from the old wire row to `Draw a belt` (plan 91-06, UI-SPEC 11.2).
    expect(at('Draw a belt')).toBeGreaterThanOrEqual(0);
    expect(at('Extend the flow')).toBe(at('Draw a belt') + 1);
    expect(at('Join two belts')).toBe(at('Extend the flow') + 1);
    expect(at('Connect to a belt')).toBe(at('Join two belts') + 1);
    expect(at('Wire a Route')).toBe(at('Connect to a belt') + 1);
    expect(at('Add an output')).toBe(at('Wire a Route') + 1);
    expect(at('Delete')).toBe(at('Add an output') + 1);
  });

  it('the widest cells are 17 (gesture) and 70 (binding), counted', () => {
    // 2026-10-24, plan 91-06: binding 63 to 70 (the Pan row, which now names dragging empty
    // floor); gesture 17 unchanged (`Connect to a belt`, `Save / load / new`). The 44ch binding
    // column wraps the 70 onto two lines; the layout spec grades that the lines never touch.
    expect(Math.max(...GESTURE_ROWS.map((r) => r.binding.length))).toBe(70);
    expect(Math.max(...GESTURE_ROWS.map((r) => r.gesture.length))).toBe(17);
  });

  it('names a belt end by plain words: no Head and no Tail in any row', () => {
    // 74-UI-SPEC 6.3: those two words appear in zero authored chrome strings.
    for (const r of GESTURE_ROWS) {
      expect(r.gesture).not.toMatch(/\b(Head|Tail)\b/);
      expect(r.binding).not.toMatch(/\b(Head|Tail)\b/);
    }
  });

  it('contains no em dash in any gesture or binding (project copy rule)', () => {
    // Asserted on the ESCAPE, never a raw glyph, so this file itself cannot be
    // the thing that introduces the character it forbids.
    const EM_DASH = '\u2014';
    for (const r of GESTURE_ROWS) {
      expect(r.gesture).not.toContain(EM_DASH);
      expect(r.binding).not.toContain(EM_DASH);
    }
  });
});

describe('HelpPanel render', () => {
  it('renders the Gestures heading on the stable panel id', () => {
    const tree = HelpPanel();
    expect(HELP_PANEL_ID).toBe('fab-help-panel');
    expect(walk(tree).some((n) => n.type === 'h2' && n.props.children === 'Gestures')).toBe(true);
    expect(walk(tree).filter((n) => n.props.id === HELP_PANEL_ID)).toHaveLength(1);
  });

  it('renders every row through the one two-column grid', () => {
    const tree = HelpPanel();
    for (const r of GESTURE_ROWS) {
      expect(elementsWithText(tree, r.gesture), `gesture cell: ${r.gesture}`).toHaveLength(1);
      expect(elementsWithText(tree, r.binding), `binding cell: ${r.gesture}`).toHaveLength(1);
    }
    const wrappers = walk(tree).filter(
      (n) => (n.props.style as { display?: string } | undefined)?.display === 'contents',
    );
    expect(wrappers).toHaveLength(GESTURE_ROWS.length);
  });

  it('lays both cells out at line height 1.4, so wrapped lines never touch (UI-SPEC 8.3)', () => {
    const tree = HelpPanel();
    for (const r of GESTURE_ROWS) {
      for (const text of [r.gesture, r.binding]) {
        const cell = elementsWithText(tree, text)[0]!;
        expect((cell.props.style as { lineHeight?: unknown }).lineHeight, `"${text}" line height`).toBe(1.4);
      }
    }
  });

  it('puts the rows in a scroll box below the heading that is a tab stop only while it scrolls (UI-SPEC 7.3, review WR-B-05)', () => {
    const tree = HelpPanel();
    const boxes = walk(tree).filter((n) => n.props['data-fab-help-scroll'] !== undefined);
    expect(boxes).toHaveLength(1);
    // No fixed tab stop: the ref callback sets one while the list scrolls (the mock spec
    // `help-panel-layout.spec.ts` grades both sides in a browser).
    expect(boxes[0]!.props.tabIndex).toBeUndefined();
    expect((boxes[0]!.props.style as { overflowY?: string }).overflowY).toBe('auto');
    const ref = boxes[0]!.props.ref as (el: unknown) => unknown;
    const box = (scrollHeight: number) => {
      const attrs = new Map<string, string>();
      const el = {
        scrollHeight,
        clientHeight: 100,
        firstElementChild: null,
        set tabIndex(v: number) {
          attrs.set('tabindex', String(v));
        },
        removeAttribute: (n: string) => attrs.delete(n),
      };
      return { el, attrs };
    };
    const tall = box(300);
    ref(tall.el);
    expect(tall.attrs.get('tabindex'), 'a list that scrolls is a tab stop').toBe('0');
    const short = box(100);
    short.attrs.set('tabindex', '0');
    ref(short.el);
    expect(short.attrs.has('tabindex'), 'a list that fits is not').toBe(false);
  });
});

// PHASE 92 (CHROME-12, D-05, UI-SPEC 2.1, RESEARCH Finding L): with the Legend open, Help stops
// 8 px above the strip. App writes the strip's top (container px) as `--fab-legend-top` on the
// positioning container in its band measurement, and Help's max height is the smaller of the shipped
// cluster bound and that top less 152 px: 116 (Help's top) + 28 (its ring padding, top and bottom;
// panels are content-box) + 8 (the gap). Written from the tokens, never as 152.
describe('Help stops above the open Legend (CHROME-12, D-05)', () => {
  const tokens: Record<string, number> = {
    '--fab-space-sm': 8,
    '--fab-space-lg': 24,
    '--fab-space-2xl': 48,
    '--fab-min-target': 44,
    '--fab-bezel-ring': 6,
    '--fab-font-size-hero': 18,
  };
  /** Evaluate a CSS length expression of px tokens to a number (no percentages, no var fallbacks). */
  const px = (expr: string): number => {
    const js = expr
      .replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => {
        expect(tokens[name], `a known token ${name}`).toBeDefined();
        return String(tokens[name]);
      })
      .replace(/calc\(/g, '(')
      .replace(/(\d+(?:\.\d+)?)px/g, '$1');
    expect(js, `only arithmetic is left in ${js}`).toMatch(/^[\d\s.+\-*/()]+$/);
    return Function(`return (${js});`)() as number;
  };

  it('Help is bounded by the open Legend', () => {
    const aside = walk(HelpPanel()).find((n) => n.props.id === HELP_PANEL_ID)!;
    const maxHeight = String((aside.props.style as { maxHeight?: unknown }).maxHeight);
    const cluster =
      `calc(100% - (var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl)) - ${CAMERA_CLUSTER_CLEARANCE} - ` +
      '2 * (var(--fab-space-sm) + var(--fab-bezel-ring)))';
    expect(
      maxHeight.startsWith('min('),
      `RED-FIRST CHROME-12-help-unit: Help's max height is the smaller of the cluster bound and the open Legend's bound, read ${maxHeight}`,
    ).toBe(true);
    expect(maxHeight, 'the shipped cluster bound is kept, verbatim').toContain(cluster);
    const legend = /max\((.+), calc\(var\(--fab-legend-top, (\d+)px\) - \((.+)\)\)\)\)$/.exec(maxHeight);
    expect(legend, `the Legend bound reads var(--fab-legend-top) less a token sum, in ${maxHeight}`).not.toBeNull();
    const [, floor, fallback, offset] = legend!;
    expect(px(offset!), 'Help top 116 + ring padding 28 + gap 8').toBe(152);
    // The floor is the heading line AND the 8 px gap under it (review IN-B-05): the content column is
    // heading, gap, list, so a floor of the heading alone overflowed the bezel by the gap.
    expect(px(floor!), "the content floor is Help's heading line, 18 px at line height 1.2, plus the 8 px gap").toBeCloseTo(29.6, 9);
    // With no Legend open the property is absent and the fallback must never bind.
    expect(Number(fallback), 'the fallback is far below any window').toBeGreaterThanOrEqual(100000);
  });

  it('is still not a corner dock: the Legend never reserves Help (D-05)', () => {
    const aside = walk(HelpPanel()).find((n) => n.props.id === HELP_PANEL_ID)!;
    expect(aside.props['data-fab-corner-dock']).toBeUndefined();
  });
});

