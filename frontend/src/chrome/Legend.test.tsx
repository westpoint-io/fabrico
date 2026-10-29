import { describe, expect, it } from 'vitest';
import { Legend, LEGEND_GLYPH_PX, LEGEND_HINT_MARK, LEGEND_HINT_OPACITY, ROUTE_LEGEND_HINT } from './Legend.tsx';
import { LOCKED_SKIN } from '../render/synth/skins/locked';
import { INLET_HALF, inletGlyphRects } from '../render/layers/inletGlyph';
import { MEDIUM_ELECTRICAL, NUB_FAULT_CORE_R, NUB_FAULT_RING_R, NUB_R, NUB_STEM, PORT_ROLE } from '../protocol/ports';
import { chassisInk } from '../render/layers/machineChassis';
import { nubColor } from '../render/layers/machines';
import { CABLE_WIDTH } from '../render/cableGeometry';
import { machine_kind, state_tag } from '../protocol/kinds';
import { colorToCss } from '../../shared/geometry';
import { KIND_NAMES } from './kindNames';
import { PortIndicator } from './PortIndicator';
import { LabelIcon, MachineGlyphIcon } from './icons';

// The vitest env is `node` (no DOM, no testing-library - the repo's "zero new
// packages" discipline holds; see DeleteControl.test.tsx). A React function
// component is just a function returning a plain element tree, so we invoke
// legendTree() directly and walk the returned tree.
//
// THE WALK EXPANDS FUNCTION COMPONENTS (phase 92, plan 92-05). Until phase 92 it stopped at a
// component element, so a swatch drawn by `PortIndicator` or an icon drawn by `LabelIcon` was a
// black box here: its circles, its box size and its `focusable` attribute could not be read. The
// three icon components the Legend uses are pure and hook-free, so the walk now calls them with
// their props and reads what they return, and the element itself stays in the walk too (so a case
// can still ask which component drew a swatch, and with what props).

/** Every call site renders the Legend at the MEASURED 1280x800 band (52-06): the
 *  Palette column ends at 198px and the bottom-right dock cluster reserves 240px.
 *  The two props are REQUIRED on the component, so a single helper keeps the
 *  numbers in one place and makes the seam impossible to drop by accident. */
const legendTree = (): unknown => Legend({ paletteRightPx: 198, cornerInsetPx: 240 });

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}

/** What an element renders: a host element's children, or a function component's output. */
function contentOf(n: El): unknown {
  if (typeof n.type === 'function') return (n.type as (p: unknown) => unknown)(n.props);
  return n.props.children;
}

/** Every element in the tree in one pre-order (document-order) walk, components expanded. */
function walk(node: unknown): El[] {
  const out: El[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isEl(n)) return;
    out.push(n);
    visit(contentOf(n));
  };
  visit(node);
  return out;
}

/** Concatenate every string leaf in the tree (the full rendered copy), skipping aria-hidden
 *  decoration the way a screen reader does (the name-to-hint mark). */
function collectText(node: unknown): string {
  const parts: string[] = [];
  const visit = (n: unknown): void => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string' || typeof n === 'number') {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (isEl(n) && n.props['aria-hidden'] === true) return;
    if (isEl(n)) visit(contentOf(n));
  };
  visit(node);
  return parts.join(' ');
}

const styleOf = (n: El): Record<string, unknown> => (n.props.style as Record<string, unknown> | undefined) ?? {};

/** Every `style.background` value present anywhere in the tree. */
function collectBackgrounds(node: unknown): string[] {
  return walk(node)
    .map((n) => styleOf(n).background)
    .filter((v): v is string => typeof v === 'string');
}

/** Every `fill` prop value present anywhere in the tree (SVG fills). */
function collectFills(node: unknown): string[] {
  return walk(node)
    .map((n) => n.props.fill)
    .filter((v): v is string => typeof v === 'string');
}

/** Every element of a given type (a host tag or a component function) in the tree. */
function findElements(node: unknown, type: unknown): El[] {
  return walk(node).filter((n) => n.type === type);
}

/** The four groups, in document order. */
function groups(): El[] {
  return walk(legendTree()).filter((n) => typeof n.props['data-fab-legend-group'] === 'string');
}

function group(name: string): El | undefined {
  return groups().find((g) => g.props['data-fab-legend-group'] === name);
}

/** Every Legend ROW (`data-fab-legend-row`) under a node, in document order. */
function rowsOf(node: unknown): El[] {
  return walk(node).filter((n) => n.props['data-fab-legend-row'] !== undefined);
}

/** A row's NAME: its first span whose one child is a string (the swatch spans hold none). */
function rowName(row: El): string {
  const span = walk(row.props.children).find((n) => n.type === 'span' && typeof n.props.children === 'string');
  return span === undefined ? '' : (span.props.children as string);
}

/** The one row anywhere in the strip whose name is exactly `name` (equality, so `Route` is never `Router`). */
function rowNamed(name: string): El {
  const hits = rowsOf(legendTree()).filter((r) => rowName(r) === name);
  expect(hits.length, `exactly one Legend row named ${name}`).toBe(1);
  return hits[0]!;
}

/** The swatch of a row: its first child element (the glyph, well or svg before the name). */
function swatchOf(row: El): El {
  const kids = ([] as unknown[]).concat(row.props.children).filter(isEl);
  return kids[0]!;
}

const css = (n: number): string => colorToCss(n);
const EXPECTED_ELECTRIC = css(LOCKED_SKIN.palette.accents.electric);
const EXPECTED_ITEM = css(LOCKED_SKIN.palette.accents.item);
const FLOOR = css(LOCKED_SKIN.palette.ramp[0]);

/** UI-SPEC 1.2, written out from the kind bytes and the one name map, never from the product's own order. */
const PALETTE_ORDER_KINDS = [
  machine_kind.SOURCE,
  machine_kind.SINK,
  machine_kind.FACTORY,
  machine_kind.TEE,
  machine_kind.BALANCER,
  machine_kind.MERGE,
  machine_kind.ENDPOINT,
  machine_kind.HANDLER,
  machine_kind.ROUTER,
  machine_kind.BELT,
  machine_kind.LABEL,
];

// PHASE 92 (CHROME-12, D-02, D-03, UI-SPEC 1.1 and 1.2). The strip used to be one wrapping row of
// loose children: kind rows, a separator, state rows, a second separator, a bare `Connections`
// span and the connection rows. Where the row wrapped decided whether a separator or that heading
// was left alone at a line end, and at every measured width one was. Now each section is its own
// labelled group, and a heading travels with its first row in one `nowrap` head pair.
describe('Legend groups (CHROME-12, D-02, D-03, UI-SPEC 1.1)', () => {
  it('the Legend renders four labelled groups in palette order', () => {
    const gs = groups();
    expect(
      gs.map((g) => g.props['data-fab-legend-group']),
      'RED-FIRST CHROME-12-unit: the strip holds four groups, kinds, states, ports and connections, in that order',
    ).toEqual(['kinds', 'states', 'ports', 'connections']);
    const headings = ['fab-legend-heading', 'fab-legend-states', 'fab-legend-ports', 'fab-legend-connections'];
    gs.forEach((g, i) => {
      expect(g.props.role, `group ${i + 1} is a role="group"`).toBe('group');
      // The kinds group's heading is the panel's own `Legend` h2, so the group is named `Machines`
      // (review IN-B-03); groups 2 to 4 are labelled by their own heading.
      if (i === 0) {
        expect(g.props['aria-label'], 'the kinds group is named Machines, not Legend').toBe('Machines');
        expect(g.props['aria-labelledby'], 'and is not labelled by the panel heading').toBeUndefined();
      } else expect(g.props['aria-labelledby'], `group ${i + 1} is labelled by its heading`).toBe(headings[i]);
      // The head pair is the group's FIRST child and holds the heading and the group's first row.
      const first = ([] as unknown[]).concat(g.props.children).filter(isEl)[0]!;
      expect(first.props['data-fab-legend-head'], `group ${i + 1} opens with its head pair`).toBeDefined();
      expect(first.type, 'the head pair is a div: it holds an h2 and a row div (review IN-B-02)').toBe('div');
      expect(styleOf(first).whiteSpace, 'a head pair never wraps').toBe('nowrap');
      const inPair = walk(first.props.children);
      expect(inPair.filter((n) => n.props.id === headings[i]), `group ${i + 1}'s heading is in its head pair`).toHaveLength(1);
      expect(rowsOf(first.props.children), `group ${i + 1}'s first row is in its head pair`).toHaveLength(1);
      expect(rowsOf(first.props.children)[0], 'and it is the group\'s first row').toBe(rowsOf(g)[0]);
    });
    expect(
      rowsOf(group('kinds')).map(rowName),
      'RED-FIRST CHROME-12-unit: the kinds group lists every palette entry, in palette order, Label last',
    ).toEqual(PALETTE_ORDER_KINDS.map((k) => KIND_NAMES[k]));
    expect(rowsOf(group('kinds')).map(rowName)).toEqual([
      'Source', 'Sink', 'Factory', 'Tee', 'Balancer', 'Merge', 'Route', 'HTTP Handler', 'Router', 'Belt', 'Label',
    ]);
    expect(rowsOf(group('states')).map(rowName)).toEqual(['Idle', 'Working', 'Faulted', 'Backed up']);
    expect(rowsOf(group('ports')).map(rowName)).toEqual(['In', 'Out', 'Fault exit', 'Wire port']);
    expect(rowsOf(group('connections')).map(rowName)).toEqual(['Wire', 'Request', 'Reply']);
    // The groups carry the boundary now: no loose separator element is left.
    expect(walk(legendTree()).filter((n) => n.props.role === 'separator'), 'no role="separator" remains').toHaveLength(0);
    // Every row is in exactly one group.
    expect(rowsOf(legendTree())).toHaveLength(11 + 4 + 4 + 3);
  });

  it('heads groups 2 to 4 with a 12 px bold word, and the kinds group with the LEGEND h2', () => {
    const h2 = findElements(legendTree(), 'h2');
    expect(h2).toHaveLength(1);
    expect(h2[0]!.props.id).toBe('fab-legend-heading');
    expect(h2[0]!.props.children).toBe('Legend');
    for (const [id, text] of [
      ['fab-legend-states', 'States'],
      ['fab-legend-ports', 'Ports'],
      ['fab-legend-connections', 'Connections'],
    ] as const) {
      const h = walk(legendTree()).filter((n) => n.props.id === id);
      expect(h, `one ${text} heading`).toHaveLength(1);
      expect(h[0]!.props.children).toBe(text);
      expect(styleOf(h[0]!).fontWeight, `${text} is weight 700`).toBe(700);
      expect(styleOf(h[0]!).fontSize).toBe('var(--fab-font-size-base)');
    }
  });

  it('draws each group boundary as a left hairline, led by -17 px in a clipping box (UI-SPEC 1.1, A3)', () => {
    const clip = walk(legendTree()).filter((n) => n.props['data-fab-legend-groups'] !== undefined);
    expect(clip, 'one clip box').toHaveLength(1);
    expect(styleOf(clip[0]!).overflow).toBe('hidden');
    const row = ([] as unknown[]).concat(clip[0]!.props.children).filter(isEl)[0]!;
    expect(styleOf(row).marginLeft).toBe('calc(-1 * (var(--fab-space-md) + 1px))');
    expect(styleOf(row).flexWrap).toBe('wrap');
    for (const g of groups()) {
      expect(styleOf(g).borderLeft).toBe('1px solid var(--fab-outline)');
      expect(styleOf(g).paddingLeft).toBe('var(--fab-space-md)');
      expect(styleOf(g).flexWrap).toBe('wrap');
    }
  });

  it('draws the Route row with the shipped inlet swatch and the HTTP Handler row with the Factory glyph', () => {
    expect(collectText(rowNamed('Route'))).toBe('Route POST here to call its Handler');
    expect(collectText(rowNamed('HTTP Handler'))).toBe('HTTP Handler your JavaScript answers it');
    const handler = findElements(rowNamed('HTTP Handler'), MachineGlyphIcon);
    expect(handler).toHaveLength(1);
    expect(handler[0]!.props.kind).toBe(machine_kind.HANDLER);
  });

  it('draws the Label row with LabelIcon at the Legend glyph size', () => {
    const label = rowNamed('Label');
    const icons = findElements(label, LabelIcon);
    expect(icons, 'the Label row swatch is the palette Label glyph').toHaveLength(1);
    expect(icons[0]!.props.px).toBe(LEGEND_GLYPH_PX);
    expect(findElements(label, MachineGlyphIcon), 'never a bare machine chassis').toHaveLength(0);
    expect(collectText(label)).toBe('Label');
  });

  it('marks every inline svg in the strip aria-hidden and focusable="false"', () => {
    const svgs = findElements(legendTree(), 'svg');
    // Kinds 11 (10 glyphs and the Route inlet), Ports 4, Request and Reply 2.
    expect(svgs.length, 'NON-VACUITY: the walk reaches the component svgs').toBeGreaterThanOrEqual(17);
    for (const s of svgs) {
      expect(s.props.focusable, 'focusable="false"').toBe('false');
      expect(s.props['aria-hidden'], 'aria-hidden').toBeTruthy();
    }
  });
});

// PHASE 92 UI REVIEW FIX 4: a row's hint is set apart from its name
// by a dimmer ink that still clears 4.5 : 1 on the panel. The name keeps `--fab-ink` at full
// opacity; the hint composites `--fab-ink` at LEGEND_HINT_OPACITY over `--fab-panel-fill`.
describe('Legend hints read a step dimmer than their names (UI review fix 4)', () => {
  const lin = (c: number): number => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const lum = (r: number, g: number, b: number): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const rgb = (c: number): [number, number, number] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
  const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const ink = rgb(LOCKED_SKIN.palette.ramp[4]);
  const panel = rgb(LOCKED_SKIN.palette.ramp[2]);
  it('every hint is dimmed and every name is not', () => {
    const rows = rowsOf(legendTree());
    const hinted = rows.filter((r) => walk(r.props.children).some((n) => n.props['data-fab-legend-hint'] !== undefined));
    expect(hinted.length, 'NON-VACUITY: rows with a hint exist (states, ports, Route, Handler, connections)').toBeGreaterThanOrEqual(13);
    for (const r of hinted) {
      const spans = ([] as unknown[]).concat(r.props.children).filter(isEl).filter((n) => n.type === 'span');
      const hint = spans.find((n) => n.props['data-fab-legend-hint'] !== undefined)!;
      const name = spans.find((n) => n.props['data-fab-legend-hint'] === undefined && typeof n.props.children === 'string')!;
      expect(styleOf(hint).opacity, `${rowName(r)}: the hint is dimmed`).toBe(LEGEND_HINT_OPACITY);
      expect(styleOf(name).opacity, `${rowName(r)}: the name is not`).toBeUndefined();
    }
  });
  it('a hidden mark sits between every name and its hint', () => {
    const hinted = rowsOf(legendTree()).filter((r) =>
      walk(r.props.children).some((n) => n.props['data-fab-legend-hint'] !== undefined),
    );
    for (const r of hinted) {
      const spans = ([] as unknown[]).concat(r.props.children).filter(isEl).filter((n) => n.type === 'span');
      const at = spans.findIndex((n) => n.props['data-fab-legend-hint'] !== undefined);
      const mark = spans[at - 1];
      expect(mark?.props['data-fab-legend-hint-mark'], `${rowName(r)}: the mark comes just before the hint`).toBeDefined();
      expect(mark?.props.children, `${rowName(r)}: the mark is the middle dot`).toBe(LEGEND_HINT_MARK);
      expect(mark?.props['aria-hidden'], `${rowName(r)}: a screen reader skips it`).toBe(true);
    }
  });
  it('the dimmed hint still clears 4.5 : 1 on the panel, and is dimmer than the name', () => {
    const hint = ink.map((c, i) => c * LEGEND_HINT_OPACITY + panel[i]! * (1 - LEGEND_HINT_OPACITY)) as [number, number, number];
    const hintRatio = ratio(lum(...hint), lum(...panel));
    const nameRatio = ratio(lum(...ink), lum(...panel));
    expect(hintRatio, `the hint reads ${hintRatio.toFixed(2)} : 1 on the panel`).toBeGreaterThanOrEqual(4.5);
    expect(hintRatio, `and less than the name's ${nameRatio.toFixed(2)} : 1`).toBeLessThan(nameRatio);
    expect(LEGEND_HINT_OPACITY).toBeLessThan(1);
  });
});

// PHASE 92 (CHROME-18's "the Legend explains", D-04, D-08, UI-SPEC 1.3, RESEARCH Finding K). The
// board draws three nub shapes and the Legend named none of them. The Ports rows draw each through
// `PortIndicator`, the chrome copy of `drawRoleNub` that reads the same `ports.ts` constants, and
// colour it with `nubColor`, the function the canvas strokes the nub with, so the Legend equals the
// canvas by construction, the way the state swatches call `chassisInk`.
describe('Legend Ports group (CHROME-18, D-04, UI-SPEC 1.3)', () => {
  it('the Ports swatches equal the canvas nubs', () => {
    const ports = group('ports');
    expect(ports, 'RED-FIRST CHROME-18-legend-ports-unit: the Legend has a Ports group').toBeDefined();
    const rows = rowsOf(ports);
    const roles = [PORT_ROLE.IN, PORT_ROLE.OUT, PORT_ROLE.FAULT, PORT_ROLE.IN];
    const media = [undefined, undefined, undefined, MEDIUM_ELECTRICAL];
    expect(rows.map((r) => collectText(r))).toEqual([
      'In items enter here',
      'Out items leave here',
      'Fault exit items that fail leave here',
      'Wire port a wire docks here',
    ]);
    rows.forEach((r, i) => {
      const well = swatchOf(r);
      expect(
        styleOf(well).color,
        `RED-FIRST CHROME-18-legend-ports-unit: the ${rowName(r)} swatch is the canvas nub colour`,
      ).toBe(css(nubColor(roles[i]!, state_tag.IDLE, LOCKED_SKIN)));
      expect(styleOf(well).background, `the ${rowName(r)} swatch sits on the board floor`).toBe(FLOOR);
      expect(styleOf(well).width).toBe(LEGEND_GLYPH_PX);
      expect(styleOf(well).height).toBe(LEGEND_GLYPH_PX);
      const pis = findElements(r, PortIndicator);
      expect(pis, `the ${rowName(r)} swatch is drawn by PortIndicator`).toHaveLength(1);
      expect(pis[0]!.props.role).toBe(roles[i]);
      expect(pis[0]!.props.medium, `the ${rowName(r)} swatch is the ${media[i] === undefined ? 'mechanical' : 'electrical'} nub`).toBe(media[i]);
      // 13 px: PortIndicator's 13-unit viewBox at one pixel per unit, so the nub radii are 1:1.
      expect(pis[0]!.props.px).toBe(13);
      const svg = findElements(r, 'svg')[0]!;
      expect(svg.props.width).toBe(13);
      expect(svg.props.viewBox).toBe('0 0 13 13');
    });
    const radii = (r: El): number[] => findElements(r, 'circle').map((c) => c.props.r as number).sort((a, b) => a - b);
    expect(radii(rows[0]!), 'In is one disc of NUB_R').toEqual([NUB_R]);
    expect(radii(rows[1]!), 'Out is one disc of NUB_R').toEqual([NUB_R]);
    const stem = findElements(rows[1]!, 'line');
    expect(stem, 'and a stem').toHaveLength(1);
    expect((stem[0]!.props.x2 as number) - (stem[0]!.props.x1 as number)).toBeCloseTo(NUB_STEM - NUB_R, 9);
    expect(radii(rows[2]!), 'the fault exit is a core and a ring').toEqual([NUB_FAULT_CORE_R, NUB_FAULT_RING_R]);
    // The Wire port (review IN-B-04): the electrical square the board draws on a Route's or an
    // HTTP Handler's unconnected port, no disc.
    expect(radii(rows[3]!), 'the Wire port draws no disc').toEqual([]);
    expect(findElements(rows[3]!, 'rect').length, 'the Wire port is a square').toBeGreaterThanOrEqual(1);
    // The canvas colours, read independently: In and the fault exit the dim step, Out the highlight.
    expect(css(nubColor(PORT_ROLE.IN, state_tag.IDLE, LOCKED_SKIN))).toBe(css(LOCKED_SKIN.palette.ramp[3]));
    expect(css(nubColor(PORT_ROLE.OUT, state_tag.IDLE, LOCKED_SKIN))).toBe(css(LOCKED_SKIN.palette.ramp[4]));
    expect(css(nubColor(PORT_ROLE.FAULT, state_tag.IDLE, LOCKED_SKIN))).toBe(css(LOCKED_SKIN.palette.ramp[3]));
  });

  it('names no colour for a port role (UI-SPEC copy contract)', () => {
    const text = collectText(group('ports')).toLowerCase();
    for (const word of ['red', 'grey', 'gray', 'white', 'green']) {
      expect(text.split(/\s+/), `no "${word}"`).not.toContain(word);
    }
  });
});

describe('Legend Connections group (QA-02 wall 1, phase 92 D-10)', () => {
  it('renders three Connections rows in the order Wire, Request, Reply', () => {
    expect(rowsOf(group('connections')).map(rowName)).toEqual(['Wire', 'Request', 'Reply']);
  });

  it('shortens the Wire hint so the Connections head pair fits the 344 px strip (UI-SPEC A6)', () => {
    expect(collectText(rowNamed('Wire'))).toBe('Wire request and reply');
  });

  it('shows the resting cable in its own colour, as a CABLE_WIDTH bar on the board floor', () => {
    const cable = LOCKED_SKIN.palette.cable;
    expect(cable, 'the skin carries the cable token').toBeTypeOf('number');
    const well = swatchOf(rowNamed('Wire'));
    expect(styleOf(well).background, 'the Wire swatch sits on the board floor').toBe(FLOOR);
    const bar = ([] as unknown[]).concat(well.props.children).filter(isEl)[0]!;
    expect(styleOf(bar).background, 'the Wire swatch is the cable colour').toBe(css(cable));
    expect(styleOf(bar).height).toBe(CABLE_WIDTH);
    expect(styleOf(bar).width).toBe(LEGEND_GLYPH_PX);
    expect(collectBackgrounds(rowNamed('Wire')), 'and not the electric accent the terminals use').not.toContain(EXPECTED_ELECTRIC);
  });

  it('names the forward pulse with the exact Request row copy', () => {
    expect(collectText(rowNamed('Request'))).toBe('Request cyan spark on the way out');
  });

  it('names the return pulse with the exact Reply row copy', () => {
    expect(collectText(rowNamed('Reply'))).toBe('Reply amber comet on the way back');
  });

  it('fills the Request swatch with accents.electric read from the LOCKED skin', () => {
    const fills = collectFills(rowNamed('Request'));
    expect(fills.length).toBeGreaterThan(0);
    expect(new Set(fills)).toEqual(new Set([EXPECTED_ELECTRIC]));
  });

  it('fills the Reply swatch with accents.item - the SAME accent wires.ts gives DIR_REPLY', () => {
    const fills = collectFills(rowNamed('Reply'));
    expect(fills.length).toBeGreaterThan(0);
    expect(new Set(fills)).toEqual(new Set([EXPECTED_ITEM]));
  });

  it('gives the Reply swatch strictly more rects than the Request swatch', () => {
    // The non-colour cue: REPLY_GLOW is 1.5 * CELL against a 0.3 * CELL FORWARD_TAIL, so the
    // reply carries a long stepped fading tail and the request a short one (VIS-03).
    const requestRects = findElements(rowNamed('Request'), 'rect');
    const replyRects = findElements(rowNamed('Reply'), 'rect');
    expect(requestRects.length).toBeGreaterThan(0);
    expect(replyRects.length).toBeGreaterThan(requestRects.length);
  });

  it('steps the Reply tail down in opacity behind an opaque head', () => {
    const opacities = findElements(rowNamed('Reply'), 'rect').map((r) => r.props.fillOpacity as number | undefined);
    const faded = opacities.filter((o): o is number => typeof o === 'number');
    expect(faded.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < faded.length; i += 1) expect(faded[i]).toBeLessThan(faded[i - 1]!);
    expect(opacities.filter((o) => o === undefined).length).toBeGreaterThanOrEqual(1);
  });

  it('renders both pulse swatches in the LEGEND_GLYPH_PX box so the column stays aligned', () => {
    for (const name of ['Request', 'Reply']) {
      const svg = findElements(rowNamed(name), 'svg');
      expect(svg, `${name} swatch is one svg`).toHaveLength(1);
      expect(svg[0]!.props.width).toBe(LEGEND_GLYPH_PX);
      expect(svg[0]!.props.height).toBe(LEGEND_GLYPH_PX);
    }
  });
});

describe('Legend copy (LEGIBLE-02, reworded Working hint)', () => {
  it('names no Legend row "Endpoint" any more (72-UI-SPEC 8.5, authored chrome only)', () => {
    // The `/endpoint/` segment inside the copyable POST URL is a host route prefix and stays
    // (D-12a). That URL is not rendered here.
    expect(collectText(legendTree())).not.toContain('Endpoint');
  });

  // 43-02's contract is the MEANING: the Working cue must say what working IS (the machine is on
  // a request), not just how it looks. The mechanism half moved in plan 58-03 (`tint` ->
  // `outline`); the `(on a request)` half stays verbatim.
  it('keeps the Working state hint naming the request, not just the visual cue', () => {
    const text = collectText(legendTree());
    expect(text).toContain('Working');
    expect(text).toContain('a request');
    expect(text).toContain('outline + motion');
    expect(text).not.toContain('tint + motion');
  });

  it('names the mechanisms the FAULTED and IDLE machines actually ship', () => {
    const text = collectText(legendTree());
    expect(text).toContain('at rest');
    expect(text).toContain('ring + blink');
    expect(text).not.toContain('marker + blink');
  });

  it('puts no em dash in any user-visible Legend string', () => {
    // Asserted on the ESCAPE, never a raw glyph.
    expect(collectText(legendTree())).not.toContain('\u2014');
  });
});

// SKIN-03 (plan 58-05): the state swatches are the CANVAS FUNCTION's output, not colours that
// happen to match it. (a) the wiring: each swatch equals `chassisInk(state, LOCKED_SKIN)`;
// (b) the value, derived independently, so (a) cannot pass by both sides moving together.
describe('Legend state swatches (SKIN-03)', () => {
  it('paints the Idle swatch the SAME ink the idle chassis outline is drawn in', () => {
    const idleInk = css(LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1]);
    expect(collectBackgrounds(group('states'))).toContain(idleInk);
  });

  it('sources the state swatches from chassisInk, at unchanged values', () => {
    const backgrounds = collectBackgrounds(group('states'));
    const independent = {
      idle: css(LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1]),
      working: css(LOCKED_SKIN.palette.accents.working),
      faulted: css(LOCKED_SKIN.palette.accents.fault),
    };
    expect(css(chassisInk(state_tag.IDLE, LOCKED_SKIN))).toBe(independent.idle);
    expect(css(chassisInk(state_tag.WORKING, LOCKED_SKIN))).toBe(independent.working);
    expect(css(chassisInk(state_tag.FAULTED, LOCKED_SKIN))).toBe(independent.faulted);
    for (const fill of Object.values(independent)) expect(backgrounds).toContain(fill);
    expect(new Set(Object.values(independent)).size).toBe(3);
    expect(backgrounds).toContain(css(chassisInk(state_tag.BACKED_UP, LOCKED_SKIN)));
  });
});

// FEEL-04 / D-02: the Route swatch is an inline SVG built from the SAME inletGlyphRects(1, 0,
// PORT_ROLE.IN) geometry the wire layer stamps on canvas, so legend == canvas by construction.
// It moved into the kinds group in phase 92 (D-03) and kept its swatch (UI-SPEC A4).
describe('Legend Route swatch (FEEL-04, D-02 shared inlet glyph geometry)', () => {
  it('renders the Route row swatch as an svg with exactly 6 rect children', () => {
    const svgs = findElements(rowNamed('Route'), 'svg');
    expect(svgs.length).toBe(1);
    expect(svgs[0]!.props.viewBox).toBe(`${-INLET_HALF} ${-INLET_HALF} ${INLET_HALF * 2} ${INLET_HALF * 2}`);
    expect(findElements(svgs[0], 'rect').length).toBe(6);
  });

  it('renders the swatch at its NATIVE size (INLET_HALF * 2) so crispEdges is exact 1:1', () => {
    const svg = findElements(rowNamed('Route'), 'svg')[0]!;
    expect(svg.props.width).toBe(INLET_HALF * 2);
    expect(svg.props.height).toBe(INLET_HALF * 2);
  });

  it('fills every rect with the electric accent the wire layer stamps the inlet in, and no other value', () => {
    const fills = collectFills(rowNamed('Route'));
    expect(fills.length).toBe(6);
    expect(new Set(fills)).toEqual(new Set([EXPECTED_ELECTRIC]));
  });

  it('maps the rect geometry one-to-one from inletGlyphRects(1, 0, PORT_ROLE.IN)', () => {
    const actual = findElements(rowNamed('Route'), 'rect').map((r) => ({
      x: r.props.x,
      y: r.props.y,
      w: r.props.width,
      h: r.props.height,
    }));
    expect(actual).toEqual(inletGlyphRects(1, 0, PORT_ROLE.IN).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })));
  });

  it('keeps the Route hint a text child of the row (72-UI-SPEC 8.4, reworded in phase 91)', () => {
    expect(collectText(rowNamed('Route'))).toContain(ROUTE_LEGEND_HINT);
    expect(ROUTE_LEGEND_HINT).toBe('POST here to call its Handler');
  });
});

// 52-06 gap closure (WINDOWS id 2): the Legend is a bottom STRIP whose left edge starts one
// --fab-space-lg right of the MEASURED Palette column and whose right edge stops one
// --fab-space-lg short of the MEASURED leftmost corner dock. This pins the SEAM: the component
// consumes the band App measures for it, so it cannot be dropped back to a literal inset.
describe('Legend bottom-strip dock (52-06, WINDOWS id 2)', () => {
  it('derives both horizontal bounds from the measured band and lays out as a wrapping row', () => {
    const aside = findElements(legendTree(), 'aside')[0];
    expect(aside, 'the Legend root is an <aside>').toBeTruthy();
    const style = styleOf(aside!);
    expect(style.left).toBe('calc(198px + var(--fab-space-lg))');
    expect(style.right).toBe('calc(240px + var(--fab-space-lg))');
    expect(style.flexDirection).toBe('row');
    expect(style.flexWrap).toBe('wrap');
    // T-52-17: `pointerEvents: 'none'` is REFUSED: it would let a click on the Legend fall
    // through to the canvas and PLACE A MACHINE under an opaque panel.
    expect(style.pointerEvents).toBeUndefined();
  });
});
