import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ADD_OUTPUT_LABEL,
  ADD_BLOCKED_BY_BELT_NOTE,
  EMPTY_GROUP_LABEL,
  PORT_EDIT_PENDING,
  PORT_EDIT_PENDING_PAUSED,
  PORT_EDIT_RETRY_LABEL,
  PORT_EDIT_STALLED,
  DISCONNECT_LABEL,
  PortsSection,
  REMOVE_DOCKED_OUTPUT_NOTE,
  ROLE_OUT,
  OUTPUT_EDIT_UNAVAILABLE_NOTE,
  portFlowVisual,
  type PortsSectionProps,
} from './PortsSection.tsx';
import { PORT_NOTE_NARROWEST_COLS, wrappedLines } from './portNoteWrap';
import {
  IDLE_PORT_EDIT,
  PORT_EDIT_STALL_TICKS,
  beginPortEdit,
  isPortEditPending,
  isPortEditStale,
  observePorts,
  portsKeyOf,
} from './portEditLatch.ts';
import { PortIndicator, PORT_INDICATOR_PX } from './PortIndicator.tsx';
import { createPortEditGrace } from './portEditGrace.ts';
import { LABEL_SEPARATOR, MEDIUM_FALLBACK, ROLE_FALLBACK, portRowLabel } from './portLabels.ts';
import type { NodeView, PortView, WireView } from '../protocol/decode.ts';
import type { BeltDockView, BeltView } from '../protocol/decode.ts';
import type { PacketLookup, PortFlow } from '../protocol/portFlow.ts';
import { selectedNodePortFlow } from '../protocol/portFlow.ts';
import { machine_kind, state_tag } from '../protocol/kinds.ts';
import { PORT_STATUS } from './configCopy.ts';

// PortsSection.test.tsx (WR-07) - node-env coverage for the two components the
// phase shipped with none.
//
// Why this file has to exist: `portFlowVisual` encodes the ENTIRE three-state
// flow contract - including the RENDER-04 invariant that a Fault port must never
// read destructive - and until now it was exercised only through Playwright
// colour assertions, which cannot distinguish "the rule holds" from "the pixel
// happened to match". The remove/add controls likewise had zero node coverage:
// `ConfigPanel.test.tsx` renders with an EMPTY port list, so the destructive path
// was never entered outside a browser.
//
// The vitest env is `node` (no DOM, no testing-library - the repo's zero-new-
// packages discipline). `PortsSection` is a PURE told-state function, so it is
// invoked directly and the returned element tree is walked, exactly like
// `ConfigPanel.test.tsx` / `DeleteControl.test.tsx`.

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}
function walk(node: unknown, visit: (el: El) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  if (!isEl(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
function findAll(node: unknown, pred: (el: El) => boolean): El[] {
  const hits: El[] = [];
  walk(node, (el) => {
    if (pred(el)) hits.push(el);
  });
  return hits;
}
/** Flatten all string/number text under a node into one string. */
function textOf(node: unknown): string {
  let out = '';
  const rec = (n: unknown): void => {
    if (n == null || n === false || n === true) return;
    if (typeof n === 'string' || typeof n === 'number') {
      out += String(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(rec);
      return;
    }
    if (isEl(n)) rec(n.props.children);
  };
  rec(node);
  return out;
}

const rows = (tree: unknown): El[] => findAll(tree, (el) => el.props.role === 'listitem');
const buttons = (tree: unknown): El[] => findAll(tree, (el) => el.type === 'button');
const removeButtons = (tree: unknown): El[] =>
  buttons(tree).filter((b) => String(b.props['aria-label'] ?? '').startsWith('Remove output'));
const addButton = (tree: unknown): El | undefined =>
  buttons(tree).find((b) => textOf(b) === ADD_OUTPUT_LABEL);
/** The element a control points at with aria-describedby, if any. */
function describedText(tree: unknown, control: El): string | null {
  const id = control.props['aria-describedby'];
  if (typeof id !== 'string') return null;
  const target = findAll(tree, (el) => el.props.id === id);
  expect(target, `aria-describedby="${id}" must resolve to exactly one element`).toHaveLength(1);
  return textOf(target[0]);
}

const port = (index: number, role: number, medium = 0): PortView => ({
  index,
  cell_x: 0,
  cell_y: 0,
  side: role === ROLE_OUT ? 1 : 3,
  role,
  medium,
});

/** The REAL post-AddPort Factory shape: the hand-added Out lands after Fault. */
const POST_ADD: PortView[] = [port(0, 0), port(1, 1), port(2, 2), port(3, 1)];

/** 74.1-14: the catalog Factory, one Out. */
const ONE_OUT: PortView[] = [port(0, 0), port(1, 1), port(2, 2)];
/** A full Factory, `[In, Out, Fault, Out, Out]`: three outputs on a 3x3 box. */
const THREE_OUT: PortView[] = [port(0, 0), port(1, 1), port(2, 2), port(3, 1), port(4, 1)];

/** A complete flow map (every port present) with the named indices docked, each
 *  carrying that many items (0 = idle). Never backed up: the backed-up cases build
 *  their flow through the real fold from belts at real slot indices. */
const flowWith = (ports: PortView[], docked: Record<number, number> = {}): Map<number, PortFlow> => {
  const map = new Map<number, PortFlow>();
  for (const p of ports) {
    const items = docked[p.index];
    map.set(p.index, { docked: items !== undefined, carrying: (items ?? 0) > 0, backedUp: false });
  }
  return map;
};

/** The packet lookup a hand-built node passes the real fold: no other machine. */
const NO_SCENE: PacketLookup = { nodes: new Map(), belts: new Map() };

/** CONNECT-01: `flowWith` plus a resolved BELT link on every docked entry.
 *  `flowWith` alone produces docked entries with NO `link`, and those render no
 *  Disconnect at all (the fail-closed rule in `PortFlow.link`), so any case ABOUT
 *  the control has to say which link is there. */
const flowWithLinks = (
  ports: PortView[],
  docked: Record<number, number> = {},
  end: 'Head' | 'Tail' = 'Tail',
): Map<number, PortFlow> => {
  const map = flowWith(ports, docked);
  for (const index of Object.keys(docked).map(Number)) {
    const entry = map.get(index);
    if (entry) entry.link = { kind: 'belt', belt: 1, end };
  }
  return map;
};

/** Every Disconnect control in a tree, found by its COMPOSED accessible name. */
const disconnectButtons = (tree: unknown): El[] =>
  buttons(tree).filter((b) =>
    String(b.props['aria-label'] ?? '').startsWith(`${DISCONNECT_LABEL} `),
  );

const render = (over: Partial<PortsSectionProps> = {}) =>
  PortsSection({
    ports: POST_ADD,
    kind: machine_kind.FACTORY,
    flow: flowWith(POST_ADD),
    onAddOutput: () => {},
    onRemoveOutput: () => {},
    // CR-01/WR-01: the latch mirror App threads in. Idle by default; the cases
    // that care override it. Both are REQUIRED on the interface (WR-03), so this
    // fixture has to state them - which is the point: neither "the destructive
    // group is live" nor "this change is still coming" should ever be reachable
    // by forgetting a prop.
    portEditPending: false,
    portEditStalled: false,
    // 74.1-19: REQUIRED; a pending case below describes the line PAST its grace unless
    // it says otherwise (the grace cases set it false).
    portEditPendingVisible: true,
    onPortEditReset: () => {},
    // 74.1-19: REQUIRED; the host would accept one more output here.
    addBlockedByBelt: false,
    ...over,
  });

// ---------------------------------------------------------------------------
// portFlowVisual - the four-state contract, in one place (phase 91, CHROME-13).
// ---------------------------------------------------------------------------
describe('portFlowVisual', () => {
  const NONE = { docked: false, carrying: false, backedUp: false };
  const IDLE = { docked: true, carrying: false, backedUp: false };
  const MOVING = { docked: true, carrying: true, backedUp: false };
  const BACKED = { docked: true, carrying: true, backedUp: true };

  it('reads an UNDOCKED port as "not connected": the dim cue is the glyph, the word is ink', () => {
    const v = portFlowVisual(NONE);
    expect(v.status).toBe(PORT_STATUS.notConnected);
    expect(v.tint).toBe('var(--fab-outline)');
    expect(v.statusColor).toBe('var(--fab-ink)');
  });

  it('reads a MISSING entry exactly like an undocked one (the poll-lag degrade)', () => {
    // The flow map is poll-derived, so a row can paint one frame ahead of its
    // snapshot. "Not connected" is the honest read - never a blank, never a throw
    // (T-51-03).
    expect(portFlowVisual(undefined)).toEqual(portFlowVisual(NONE));
  });

  it('reads a docked-but-empty port as "idle" at full ink (a different WORD, not a shade)', () => {
    const v = portFlowVisual(IDLE);
    expect(v.status).toBe(PORT_STATUS.idle);
    expect(v.status).not.toBe(PORT_STATUS.notConnected);
    expect(v.tint).toBe('var(--fab-ink)');
  });

  it('reads a carrying port as "moving" with the item accent on the glyph only, and no count', () => {
    const v = portFlowVisual(MOVING);
    expect(v.status).toBe(PORT_STATUS.moving);
    expect(v.tint).toBe('var(--fab-accent-item)');
    expect(v.statusColor).toBe('var(--fab-ink)');
  });

  it('reads a backed-up port as "backed up", which wins over carrying', () => {
    const v = portFlowVisual(BACKED);
    expect(v.status).toBe(PORT_STATUS.backedUp);
    expect(v.tint).toBe('var(--fab-accent-item)');
    expect(v.statusColor).toBe('var(--fab-ink)');
  });

  it('never returns the destructive token for ANY state (RENDER-04, incl. a Fault port)', () => {
    // Role plays no part in this function BY DESIGN, which is exactly what keeps
    // an idle fault exit from reading as a live alarm. A backed-up exit is a
    // jam, which the board's own mark carries; it is not a fault either.
    for (const entry of [undefined, NONE, IDLE, MOVING, BACKED]) {
      const v = portFlowVisual(entry);
      expect(JSON.stringify(v)).not.toContain('destructive');
    }
  });

  it('emits only --fab-* token references, never a hand-authored colour', () => {
    for (const entry of [undefined, IDLE, MOVING, BACKED]) {
      const v = portFlowVisual(entry);
      expect(v.tint).toMatch(/^var\(--fab-[a-z-]+\)$/);
      expect(v.statusColor).toMatch(/^var\(--fab-[a-z-]+\)$/);
    }
  });
});

// ---------------------------------------------------------------------------
// PORT ROWS READ AS STATE WORDS (phase 91, D-12, CHROME-13, UI-SPEC 8.5 as amended in
// plan 91-07). The flow is built by the REAL fold from belts whose items sit at real
// slot indices (slot 0 the head), so the rule and the words are graded together: a
// belt jammed solid against open floor, a belt flowing into a machine that is taking
// items, an empty belt and an undocked port.
// ---------------------------------------------------------------------------
describe('PortsSection - port rows say what the belt is doing, never a count (CHROME-13)', () => {
  const FACTORY_NODE: NodeView = {
    id: 7,
    kind: machine_kind.FACTORY,
    cell_x: 0,
    cell_y: 0,
    state: state_tag.WORKING,
    w: 3,
    h: 3,
    rot: 0,
    ports: POST_ADD,
    load: 0,
  };
  const SINK: NodeView = { ...FACTORY_NODE, id: 20, kind: machine_kind.SINK, w: 1, h: 1, ports: [port(0, 0)] };
  const beltOn = (id: number, slots: number[], docks: BeltDockView[]): BeltView => ({
    id,
    latency: 12,
    fill: slots.length,
    items: slots.map((slot) => ({ arrival_tick: slot, tag: 0 })),
    tiles: [],
    docks,
    ticks_per_slot: 2,
  });
  /** Out key 0 (catalog 1): packed from the head, the head on open floor. */
  const JAMMED = beltOn(30, [0, 1, 2, 3, 4, 5], [{ end: 'Tail', node: 7, port: 0 }]);
  /** Out key 1 (catalog 3): two items behind an empty head, into a Sink taking items. */
  const FLOWING = beltOn(31, [3, 7], [
    { end: 'Head', node: 20, port: 0 },
    { end: 'Tail', node: 7, port: 1 },
  ]);
  /** The fault port (catalog 2): docked, empty. */
  const EMPTY = beltOn(32, [], [{ end: 'Tail', node: 7, port: 65535 }]);
  const belts = [JAMMED, FLOWING, EMPTY];
  const scene: PacketLookup = {
    nodes: new Map([
      [7, FACTORY_NODE],
      [20, SINK],
    ]),
    belts: new Map(belts.map((b) => [b.id, b])),
  };
  const tree = () => render({ flow: selectedNodePortFlow(FACTORY_NODE, belts, [], scene) });
  const WORDS: readonly string[] = Object.values(PORT_STATUS);

  it('each row reads one of the four PORT_STATUS words, and the jammed belt reads backed up', () => {
    const labels = rows(tree()).map((r) => String(r.props['aria-label']));
    expect(labels).toEqual([
      `Input${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
      `Output${LABEL_SEPARATOR}Item, ${PORT_STATUS.backedUp}`,
      `Output${LABEL_SEPARATOR}Item, ${PORT_STATUS.moving}`,
      `Fault${LABEL_SEPARATOR}Item, ${PORT_STATUS.idle}`,
    ]);
  });

  it('no row text shows a count: nothing matches a digit followed by the moving word', () => {
    for (const row of rows(tree())) {
      expect(/\d\s*moving/.test(textOf(row)), textOf(row)).toBe(false);
      expect(/\d\s*moving/.test(String(row.props['aria-label'])), String(row.props['aria-label'])).toBe(false);
    }
  });

  it('every status word renders in --fab-ink', () => {
    const t = tree();
    const words = findAll(t, (el) => el.type === 'span' && WORDS.includes(textOf(el)));
    expect(words.map(textOf)).toEqual([
      PORT_STATUS.notConnected,
      PORT_STATUS.backedUp,
      PORT_STATUS.moving,
      PORT_STATUS.idle,
    ]);
    for (const w of words) {
      expect((w.props.style as { color?: string }).color, textOf(w)).toBe('var(--fab-ink)');
    }
  });

  it('the control line sets the label and the word apart by --fab-space-sm, and the name is "label, status"', () => {
    for (const row of rows(tree())) {
      const line = findAll(row, (el) => el.type === 'div' && el !== row)[0];
      expect((line.props.style as { gap?: string }).gap).toBe('var(--fab-space-sm)');
      const label = String(row.props['aria-label']);
      const status = label.slice(label.lastIndexOf(', ') + 2);
      expect(WORDS).toContain(status);
      expect(textOf(line)).toContain(status);
    }
  });

  it('the None row of an empty group reads in --fab-ink', () => {
    const ports = [port(0, 1)];
    const none = rows(render({ ports, flow: flowWith(ports) })).find((r) => r.props['aria-label'] === EMPTY_GROUP_LABEL);
    expect((none?.props.style as { color?: string }).color).toBe('var(--fab-ink)');
  });
});

// ---------------------------------------------------------------------------
// Grouping: Fault nests under Outputs, and the groups are partitioned by ROLE.
// ---------------------------------------------------------------------------
describe('PortsSection - grouping', () => {
  it('nests a Fault port under Outputs with no Fault header of its own (A6)', () => {
    const tree = render();
    const headers = findAll(tree, (el) => el.type === 'h3').map(textOf);
    expect(headers).toEqual(['Inputs', 'Outputs']);
  });

  it('separates a group header from its rows with the hairline the UI-SPEC promised', () => {
    // 51-UI-REVIEW. The headers were character-for-character identical to the
    // rows beneath them - same family, size, weight AND colour - so the section
    // read as one uniform column of 12px grey text. The UI-SPEC colour table
    // already promised `--fab-outline` "Hairline separators"; there was not one
    // border in the file. Pinning the rule (and its absence on rows) is what
    // stops the header collapsing back into a row.
    const tree = render();
    const headers = findAll(tree, (el) => el.type === 'h3');
    expect(headers).toHaveLength(2);
    for (const h of headers) {
      const style = h.props.style as Record<string, unknown>;
      expect(style.borderBottom, 'the header carries the hairline').toBe(
        '1px solid var(--fab-outline)',
      );
      // Token only - the rule must survive a skin swap like everything else here.
      expect(String(style.borderBottom)).toMatch(/var\(--fab-[a-z-]+\)/);
      expect(style.paddingBottom, 'the rule is not jammed against the word').toBe(
        'var(--fab-space-xs)',
      );
    }
    for (const r of rows(tree)) {
      expect(
        (r.props.style as Record<string, unknown>).borderBottom,
        'a row is NOT ruled - the rule is what says "header"',
      ).toBeUndefined();
    }
  });

  it('groups by ROLE, not position, on the real post-AddPort list [In, Out, Fault, Out]', () => {
    // WR-05: a hand-added Out lands AFTER the Fault port in the PACKET. The panel
    // still reads Out, Out, Fault - it partitions by role, so the interleaved
    // Fault does not split the Out group (positional logic would put the second
    // Out in the wrong group, or lose it).
    const tree = render();
    const labels = rows(tree).map((r) => String(r.props['aria-label']));
    expect(labels).toEqual([
      `Input${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
      `Output${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
      `Output${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
      `Fault${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
    ]);
  });

  it('shows a dim None row for an empty group rather than hiding the header', () => {
    const ports = [port(0, 1)];
    const tree = render({ ports, flow: flowWith(ports) });
    const none = rows(tree).filter((r) => r.props['aria-label'] === EMPTY_GROUP_LABEL);
    expect(none, 'a machine with no Inputs still says so').toHaveLength(1);
  });

  it('names each row by its COMPOSITE label + status (a listitem has no name from contents)', () => {
    const ports = [port(0, 0), port(1, 1)];
    const tree = render({ ports, flow: flowWith(ports, { 1: 3 }) });
    const out = rows(tree).find((r) => String(r.props['aria-label']).startsWith('Output'));
    expect(out?.props['aria-label']).toBe(`Output${LABEL_SEPARATOR}Item, ${PORT_STATUS.moving}`);
  });

  it('still LISTS a port whose role byte this build predates, under Outputs', () => {
    // The role/medium keyspaces are open on the wire (T-51-01) and `portLabels`
    // falls an unknown role back to "Output". A two-way In/Out+Fault partition
    // used to drop such a port from the panel altogether - a machine listing NONE
    // of its ports. It is listed, and it gets no remove control.
    const ports = [port(0, 99, 99)];
    const tree = render({ ports, flow: flowWith(ports) });
    const named = rows(tree).filter((r) => r.props['aria-label'] !== EMPTY_GROUP_LABEL);
    expect(named).toHaveLength(1);
    expect(named[0].props['aria-label']).toBe(
      `${ROLE_FALLBACK}${LABEL_SEPARATOR}${MEDIUM_FALLBACK}, ${PORT_STATUS.notConnected}`,
    );
    expect(removeButtons(tree), 'an unknown role never reaches a destructive control').toHaveLength(
      0,
    );
  });

  it('gives every row a role silhouette glyph at the fixed panel size', () => {
    const glyphs = findAll(render(), (el) => el.type === PortIndicator);
    expect(glyphs).toHaveLength(POST_ADD.length);
    expect(glyphs.map((g) => g.props.role)).toEqual([0, 1, 1, 2]);
    // The glyph is decorative - the row text already names role + flow.
    const svg = findAll(PortIndicator({ role: 2 }), (el) => el.type === 'svg')[0];
    expect(svg.props['aria-hidden']).toBe('true');
    expect(svg.props.width).toBe(PORT_INDICATOR_PX);
  });
});

// ---------------------------------------------------------------------------
// The edit controls: Factory-only, gated, and honest about WHY they are gated.
// ---------------------------------------------------------------------------
describe('PortsSection - the Factory-only edit controls', () => {
  it('renders NO controls at all on a non-Factory kind (absent, not disabled)', () => {
    const tree = render({ kind: machine_kind.ROUTER });
    expect(removeButtons(tree)).toHaveLength(0);
    expect(addButton(tree)).toBeUndefined();
  });

  it('offers one remove per OUT port and none for the Fault port', () => {
    const tree = render();
    expect(removeButtons(tree).map((b) => b.props['aria-label'])).toEqual([
      'Remove output 1',
      'Remove output 2',
    ]);
  });

  it('sends the PACKET port index, not the Out ordinal', () => {
    const sent: number[] = [];
    const tree = render({ onRemoveOutput: (i) => sent.push(i) });
    for (const b of removeButtons(tree)) (b.props.onClick as () => void)();
    // Out ordinals 0 and 1 live at packet indices 1 and 3 on this shape.
    expect(sent).toEqual([1, 3]);
  });

  it('an offered control on a multi-Out Factory is enabled and points at NO reason element', () => {
    // POST_ADD has TWO undocked Outs, so there is nothing to report: no block cause,
    // and no docked-output consequence either.
    const btn = removeButtons(render())[0];
    expect(btn.props.disabled).toBe(false);
    expect(btn.props['aria-describedby']).toBeUndefined();
  });

  it('OFFERS the lone undocked Out of a fresh Factory with no note at all (phase 91, UI-SPEC 8.4)', () => {
    // Until phase 91 this row carried a standing sentence about the Factory having
    // nowhere to send its results. Removing an undocked Out costs nothing `+ Add
    // output` cannot put back, so the row says nothing; the note is for a removal
    // that drops a belt.
    const ports = [port(0, 0), port(1, 1), port(2, 2)];
    const tree = render({ ports, flow: flowWith(ports) });
    const btn = removeButtons(tree)[0];
    expect(btn.props.disabled, 'it is offered').toBe(false);
    expect(btn.props['aria-describedby']).toBeUndefined();
    expect(textOf(tree)).not.toContain(REMOVE_DOCKED_OUTPUT_NOTE);
  });

  it('says nothing on any undocked Out of a multi-Out Factory', () => {
    const tree = render();
    for (const btn of removeButtons(tree)) {
      expect(btn.props['aria-describedby']).toBeUndefined();
    }
    expect(textOf(tree)).not.toContain(REMOVE_DOCKED_OUTPUT_NOTE);
  });

  it('OFFERS the removal on a docked lone Out, and the note is the docked-output consequence (73-08, 91)', () => {
    // This case used to assert the opposite: the button dead under "Disconnect it
    // first", with the block cause beating the last-output note because a blocked
    // control had to say why it was dead first. There is no block cause any more.
    // Plan 73-06 made `fold_remove_port` re-point every route and dock keyed to the
    // removed port and release exactly the belt that was on it, so the removal the
    // panel used to withhold is one the core survives, and 73-08 deleted the gate.
    //
    // What is left on this row is the DOCKED-OUTPUT note (phase 91), a consequence
    // rather than a block: it never disabled anything and it still does not.
    const ports = [port(0, 0), port(1, 1), port(2, 2)];
    const tree = render({ ports, flow: flowWithLinks(ports, { 1: 2 }), onDisconnect: () => {} });
    const btn = removeButtons(tree)[0];
    expect(btn.props.disabled, 'the docked lone Out is now removable').toBe(false);
    expect(describedText(tree, btn)).toBe(REMOVE_DOCKED_OUTPUT_NOTE);
  });

  it('OFFERS an Out that owns the dock; its note states the consequence, never a block (73-08, 91)', () => {
    // The `own-dock` block, the one the walk board measured on the shipped demo
    // Factory, is gone. Since phase 91 the row says what the press costs: the belt
    // goes with the output (one Ctrl+Z puts both back).
    const tree = render({ flow: flowWithLinks(POST_ADD, { 3: 2 }), onDisconnect: () => {} });
    const btn = removeButtons(tree)[1];
    expect(btn.props.disabled, 'the docked Out is removable').toBe(false);
    expect(describedText(tree, btn)).toBe(REMOVE_DOCKED_OUTPUT_NOTE);
  });

  it('a docked Out row carries a LIVE Remove beside a LIVE Disconnect (73-08)', () => {
    // The 67-06 shape, inverted by 73-08 and asserted on a RENDERED ROW rather than
    // on a lookup table. This row used to be Remove-dead-under-"Disconnect it
    // first" next to Disconnect-alive, and that was the honest arrangement while
    // the core could not survive removing a docked Out: the copy named the control
    // that unblocked it, sitting right there.
    //
    // Since 73-06 the core survives it, so BOTH controls are live and Disconnect is
    // a CHOICE rather than a prerequisite. Remove releases exactly this belt and
    // one Ctrl+Z puts the output and the belt back.
    //
    // `flowWithLinks` (not `flowWith`) because a docked entry with no resolved
    // `link` renders NO Disconnect at all - the fail-closed rule - and the
    // beside-each-other half would then pass vacuously.
    const tree = render({ flow: flowWithLinks(POST_ADD, { 3: 2 }), onDisconnect: () => {} });

    // Scope to the ONE row rather than to the tree, or "on the same row" is not
    // what is being proved. The two Out rows share a label, so the row is found
    // by its own STATUS word - which is the thing the control is gated on.
    const matches = rows(tree).filter((r) =>
      String(r.props['aria-label'] ?? '').endsWith(`, ${PORT_STATUS.moving}`),
    );
    expect(matches, 'exactly one row is the docked Out').toHaveLength(1);
    const row = matches[0];

    const remove = removeButtons(row)[0];
    const disconnect = disconnectButtons(row)[0];
    expect(remove, 'the docked, editable Out row still carries its Remove').toBeDefined();
    expect(disconnect, 'and, since 67-02, a Disconnect').toBeDefined();

    expect(remove.props.disabled, 'Remove is LIVE on its own dock (73-08)').toBe(false);
    expect(disconnect.props.disabled, 'Disconnect is LIVE beside it').toBe(false);
    expect(
      describedText(tree, remove),
      'and the row carries no block reason, only the docked-output consequence (phase 91)',
    ).toBe(REMOVE_DOCKED_OUTPUT_NOTE);
    // The Disconnect label itself is untouched by this phase - it is a different
    // string on a different control, and it is still the word on the button.
    expect(disconnect.props['aria-label']).toContain(DISCONNECT_LABEL);
  });

  it('OFFERS an EARLIER Out whose LATER sibling is docked, silently (73-08)', () => {
    // The `later-dock` cause. It blocked because removing an earlier Out shifted
    // every later Out's routing key down one, so a belt on Out 2 silently started
    // draining what used to be Out 3. That is the exact silent renumber UNDO-04
    // closed: `fold_remove_port` now re-keys every surviving dock and re-points
    // `routes` and `default`, so the later belt stays on its OWN output.
    //
    // The row still reads "not connected", which was WR-02's load-bearing point and
    // is now simply true with no sentence needed beside it.
    const tree = render({ flow: flowWith(POST_ADD, { 3: 2 }) });
    const btn = removeButtons(tree)[0];
    expect(btn.props.disabled, 'the earlier Out is removable').toBe(false);
    expect(btn.props['aria-describedby'], 'and says nothing about the later dock').toBeUndefined();
    const outRow = rows(tree)[1];
    expect(String(outRow.props['aria-label'])).toContain(PORT_STATUS.notConnected);
  });

  it('a docked FAULT port blocks nothing (NEGATIVE CONTROL after 73-08)', () => {
    // DECLARED AS A NEGATIVE CONTROL rather than left reading as coverage. It was
    // green before this phase (a fault dock is sentinel-addressed, so it never
    // renumbered anything and the gate carved it out) and it is green after, now
    // for the wider reason that nothing blocks a Remove at all. It can no longer
    // fail for its original cause, and saying so is the point: its siblings above
    // are the rows that moved.
    const tree = render({ flow: flowWith(POST_ADD, { 2: 1 }) });
    expect(removeButtons(tree).map((b) => b.props.disabled)).toEqual([false, false]);
  });

  it('an EMPTY flow map no longer fails closed: there is nothing left to prove (73-08)', () => {
    // WR-01 and WR-02 both lived here. An empty map is "we know nothing, not
    // nothing is docked", and the gate refused a destructive action it could not
    // PROVE safe, reporting `unknown` rather than impersonating a dock.
    //
    // The proof obligation is what went away. The core survives any in-range
    // removal now, so there is no safety question for the panel to be uncertain
    // about, and a control disabled for want of an answer nobody needs is a dead
    // button with an invented cause. The ROW readout is untouched and still
    // degrades soft to "not connected".
    const tree = render({ flow: new Map() });
    expect(removeButtons(tree).map((b) => b.props.disabled)).toEqual([false, false]);
    for (const btn of removeButtons(tree)) {
      expect(btn.props['aria-describedby'], 'and invents no cause').toBeUndefined();
    }
    expect(String(rows(tree)[1].props['aria-label'])).toContain(PORT_STATUS.notConnected);
  });

  it('a PARTIAL flow map disables nothing either, per port or wholesale (73-08)', () => {
    // Everything is known EXCEPT the appended Out at packet index 3. Under the gate
    // the earlier Out degraded to `unknown` because its safety DEPENDED on that
    // missing answer (removing it would renumber index 3), and the port whose own
    // entry was missing degraded for its own reason. Neither dependency exists now:
    // the fold re-keys the survivors itself.
    const partial = new Map<number, PortFlow>([
      [0, { docked: false, carrying: false, backedUp: false }],
      [1, { docked: false, carrying: false, backedUp: false }],
      [2, { docked: false, carrying: false, backedUp: false }],
    ]);
    const tree = render({ flow: partial });
    expect(removeButtons(tree).map((b) => b.props.disabled)).toEqual([false, false]);
    expect(removeButtons(tree)[0].props['aria-describedby']).toBeUndefined();
    expect(removeButtons(tree)[1].props['aria-describedby']).toBeUndefined();
  });

  it('a DEFINITE later dock is now an ordinary row, cause and all (73-08)', () => {
    // Three Outs. Ordinal 0 is clean, ordinal 1 is unknown to the flow map, ordinal
    // 2 carries a belt. This used to be the case that proved the ACTIONABLE cause
    // beat the uncertain one, because removing ordinal 0 renumbered both. It now
    // proves the other thing: no ordinal on this machine is blocked, and none of
    // the three carries a reason element, because the renumber the causes described
    // is performed correctly by the core rather than refused by the panel.
    const ports = [port(0, 0), port(1, 1), port(2, 1), port(3, 1)];
    const partial = new Map<number, PortFlow>([
      [0, { docked: false, carrying: false, backedUp: false }],
      [1, { docked: false, carrying: false, backedUp: false }],
      [3, { docked: true, carrying: true, backedUp: false }],
    ]);
    const tree = render({ ports, flow: partial });
    expect(removeButtons(tree).map((b) => b.props.disabled)).toEqual([false, false, false]);
    // No block reason on any of them. The docked ordinal 2 carries the docked-output
    // consequence (phase 91), which is not a block.
    expect(removeButtons(tree).map((b) => b.props['aria-describedby'])).toEqual([
      undefined,
      undefined,
      'fab-port-remove-reason-3',
    ]);
  });

  it('latches the WHOLE edit group while an edit is in flight (CR-01)', () => {
    const tree = render({ portEditPending: true });
    expect(removeButtons(tree).map((b) => b.props.disabled)).toEqual([true, true]);
    expect(addButton(tree)?.props.disabled).toBe(true);
    // ...and a latched-but-otherwise-offered control carries NO reason element:
    // "the index is momentarily stale" is not a fact about this port.
    expect(removeButtons(tree)[0].props['aria-describedby']).toBeUndefined();
  });

  it('says it is WAITING while an edit is in flight - a status, never an alert (CR-01)', () => {
    // The latch is durable: it releases on an observed fold and on nothing else,
    // so a control that reads busy needs to say why or it reads as broken. What
    // it must NOT do is claim a verdict. Since Phase 64 a refusal IS answered -
    // on the reply seam, shown in `#fab-refusal` - but not FROM HERE: this status
    // is driven by the latch, the latch watches the echo, and a refused edit and
    // a merely un-ticked one look identical to an echo watcher. So "the host
    // rejected it" is still unknowable at this surface. `role="status"` (polite)
    // rather than `role="alert"` is that distinction made in the accessibility
    // tree.
    const idle = render();
    expect(findAll(idle, (el) => el.props.role === 'status')).toHaveLength(0);

    const tree = render({ portEditPending: true });
    const status = findAll(tree, (el) => el.props.role === 'status');
    expect(status).toHaveLength(1);
    expect(textOf(status[0])).toBe(PORT_EDIT_PENDING);
    expect(findAll(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
  });

  // 74.1-19 (re-walk J10): the status LINE waits out App's grace. A manual walk saw it paint
  // for 59 to 173 ms on every add and read it as a flash; inside the grace the panel
  // paints no status text at all, while the controls stay latched from the press.
  it('paints NO status text inside the grace, and still latches every control', () => {
    for (const simPaused of [false, true]) {
      const tree = render({ portEditPending: true, portEditPendingVisible: false, simPaused });
      expect(findAll(tree, (el) => el.props.role === 'status'), `paused=${simPaused}`).toHaveLength(0);
      expect(textOf(tree)).not.toContain(PORT_EDIT_PENDING);
      expect(textOf(tree)).not.toContain(PORT_EDIT_PENDING_PAUSED);
      expect(addButton(tree)?.props.disabled, 'the latch holds from the press').toBe(true);
      expect(removeButtons(tree).map((b) => b.props.disabled)).toEqual([true, true]);
    }
  });

  // Plan 74.1-28 (round-3 review WR-05): a paused add, then Resume, then the fold inside
  // the grace. App's mirror is reproduced: the grace controller decides `visible`, the
  // run state decides the wording, and every state the panel passes through is rendered.
  it('a paused add resumed and folded inside the grace never renders the waiting sentence', () => {
    vi.useFakeTimers();
    try {
      const statuses: string[] = [];
      const g = createPortEditGrace(
        { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
        () => {},
      );
      const paint = (pending: boolean, simPaused: boolean): void => {
        const tree = render({ portEditPending: pending, portEditPendingVisible: g.visible(), simPaused });
        statuses.push(findAll(tree, (el) => el.props.role === 'status').map(textOf).join('|'));
      };
      g.arm(true);
      paint(true, true);
      g.setPaused(false);
      paint(true, false);
      vi.advanceTimersByTime(100);
      paint(true, false);
      g.release();
      paint(false, false);
      expect(statuses[0], 'the paused wording shows at once').toBe(PORT_EDIT_PENDING_PAUSED);
      expect(statuses.slice(1), 'after Resume, no status at all until the fold').toEqual(['', '', '']);
      expect(statuses).not.toContain(PORT_EDIT_PENDING);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the stalled readout and its [Try again] do not wait on the grace', () => {
    const tree = render({ portEditPending: true, portEditStalled: true, portEditPendingVisible: false });
    const status = findAll(tree, (el) => el.props.role === 'status');
    expect(status).toHaveLength(1);
    expect(textOf(status[0])).toBe(PORT_EDIT_STALLED);
    expect(buttons(tree).some((b) => textOf(b) === PORT_EDIT_RETRY_LABEL)).toBe(true);
  });

  it('gives the in-flight status FULL ink, and since phase 91 the standing advisory too (UI-SPEC A13)', () => {
    // 51-UI-REVIEW. `--fab-outline` was carrying four unrelated meanings, and one
    // of them - through the shared advisory style - was "every control in this
    // section just went dead and this sentence is why". That is the most urgent
    // message the section can emit, and it was the dimmest thing in it, beside a
    // full-contrast [Try again]. When an edit goes unfolded, this sentence is the
    // only feedback THIS SECTION gives - Phase 64's `#fab-refusal` surface answers
    // refusals, and an edit that stalls without being refused reaches it never.
    //
    // Emphasis is the whole fix: no new tier, no new size, no new token. Phase 91
    // (UI-SPEC Color, A13) then moved the standing advisory to ink as well:
    // `--fab-outline` is 1.64 : 1 on the panel and fails AA, so no word wears it.
    // The status still reads as the live one by its `role="status"`, not by being
    // the only legible sentence.
    const colourOf = (el: El): unknown => (el.props.style as Record<string, unknown>).color;

    // 74.1-19: the machine is the one the add note shows on (the host would refuse
    // one more output for a belt), so the ranking is still measured.
    for (const over of [{ portEditPending: true }, { portEditPending: true, portEditStalled: true }]) {
      const tree = render({ ...over, ports: THREE_OUT, addBlockedByBelt: true, flow: flowWith(THREE_OUT, { 2: 0 }) });
      const status = findAll(tree, (el) => el.props.role === 'status');
      expect(status).toHaveLength(1);
      expect(colourOf(status[0]), 'the status that explains the dead controls is at ink').toBe(
        'var(--fab-ink)',
      );

      // The standing Add caveat, on the same machine at the same moment, is ink too.
      const advisory = findAll(tree, (el) => el.props.id === 'fab-port-add-advisory');
      expect(advisory).toHaveLength(1);
      expect(colourOf(advisory[0]), 'the caveat is legible: full ink, never --fab-outline').toBe(
        'var(--fab-ink)',
      );
      expect(advisory[0].props.role, 'and it is not a status').toBeUndefined();
    }
  });

  it('names the PAUSE when the sim is holding the edit, not the host (CR-01)', () => {
    // A paused/draining sim skips `acquire_input()` entirely, so the gesture sits
    // in the channel until Resume. "Waiting for the host" would be true but
    // useless; naming the pause makes the control actionable.
    const tree = render({ portEditPending: true, simPaused: true });
    const status = findAll(tree, (el) => el.props.role === 'status');
    expect(textOf(status[0])).toBe(PORT_EDIT_PENDING_PAUSED);
    expect(PORT_EDIT_PENDING_PAUSED).not.toBe(PORT_EDIT_PENDING);
  });

  it('shows no pending status on a non-Factory kind (there is no edit to be pending)', () => {
    const tree = render({ kind: machine_kind.ROUTER, portEditPending: true });
    expect(findAll(tree, (el) => el.props.role === 'status')).toHaveLength(0);
  });

  it('offers a WAY OUT once the edit has gone unfolded past the tick threshold (WR-01)', () => {
    // The recovery WR-01 filed, and the one CR-01's hoist made mandatory: with the
    // latch surviving a remount there is no deselect/reselect escape left, so an
    // edit the host never folds (a typed `AddPort` reject on a packed board, an
    // `UnknownNode` arm) would dead-end the Outputs group permanently - under copy
    // asserting the change is still on its way.
    const pending = render({ portEditPending: true });
    expect(
      buttons(pending).map((b) => b.props['aria-label'] ?? textOf(b)),
      'no escape is offered while the wait is still ordinary',
    ).not.toContain(PORT_EDIT_RETRY_LABEL);

    const tree = render({ portEditPending: true, portEditStalled: true });
    const status = findAll(tree, (el) => el.props.role === 'status');
    expect(status, 'still exactly ONE status, re-worded').toHaveLength(1);
    expect(textOf(status[0])).toBe(PORT_EDIT_STALLED);
    // Still not an alert and still not a verdict: it says the sim moved on, which
    // the panel can observe, and NOT that anything was rejected, which it cannot.
    expect(findAll(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
    expect(PORT_EDIT_STALLED.toLowerCase()).not.toContain('reject');
    expect(PORT_EDIT_STALLED.toLowerCase()).not.toContain('no room');
    expect(PORT_EDIT_STALLED.toLowerCase()).not.toContain('fail');
  });

  it('keeps the edit controls DISABLED while stalled - the escape is the only way out', () => {
    // The whole distinction from iteration 1's timer. Elapsed simulated time does
    // not release the latch and must not re-arm the destructive controls behind
    // the user's back; only their explicit press does.
    const tree = render({ portEditPending: true, portEditStalled: true });
    expect(removeButtons(tree).map((b) => b.props.disabled)).toEqual([true, true]);
    expect(addButton(tree)?.props.disabled).toBe(true);
  });

  it('wires [Try again] to its reason and calls the reset exactly once when pressed', () => {
    let resets = 0;
    const tree = render({
      portEditPending: true,
      portEditStalled: true,
      onPortEditReset: () => {
        resets += 1;
      },
    });
    const retry = buttons(tree).find((b) => textOf(b) === PORT_EDIT_RETRY_LABEL);
    expect(retry, 'the escape is a real button, not a hint').toBeDefined();
    // A screen reader hears WHY the button is there, the same discipline the
    // blocked remove controls follow.
    expect(describedText(tree, retry as El)).toBe(PORT_EDIT_STALLED);
    (retry?.props.onClick as () => void)();
    expect(resets).toBe(1);
  });

  it('keys the docked-output note to its OWN port index (73-08, 91)', () => {
    // REWRITTEN BECAUSE THE OLD ROW COULD NO LONGER FAIL. It rendered an empty flow
    // map, collected the `aria-describedby` of every blocked control, and asserted
    // the ids were distinct - a real guard while THREE block causes could put a
    // sentence on every Out row at once. After 73-08 the only note left is the
    // last-output consequence, and a machine has at most one last Out, so a
    // collision is unreachable and a distinctness assertion over one id is a check
    // that cannot fail.
    //
    // What IS still worth pinning is that the id is derived from the port's OWN
    // packet index rather than from its row position, because an `aria-describedby`
    // pointing at another row's span is silent to a sighted reader and wrong to a
    // screen reader. The lone Out below sits at packet index 1, docked.
    const ports = [port(0, 0), port(1, 1), port(2, 2)];
    const lone = render({ ports, flow: flowWithLinks(ports, { 1: 1 }), onDisconnect: () => {} });
    const loneIds = removeButtons(lone).map((b) => b.props['aria-describedby']);
    expect(loneIds).toEqual(['fab-port-remove-reason-1']);
    expect(describedText(lone, removeButtons(lone)[0])).toBe(REMOVE_DOCKED_OUTPUT_NOTE);

    // ...and on a two-Out machine with only its LATER Out docked the id is that
    // port's own (packet index 3), never its row position, and the earlier Out
    // renders no reason element at all.
    const two = render({ flow: flowWithLinks(POST_ADD, { 3: 1 }), onDisconnect: () => {} });
    expect(removeButtons(two).map((b) => b.props['aria-describedby'])).toEqual([
      undefined,
      'fab-port-remove-reason-3',
    ]);
  });

  // 74.1-19: THE ADD NOTE FOLLOWS THE HOST'S VERDICT. Whether one more output would
  // be refused because a belt is in the way is decided by `addOutputVerdict`, held to
  // the engine's own AddPort answers in `addOutput.test.ts`; App passes the answer in
  // as `addBlockedByBelt`. This file pins what the panel does with it: the note with
  // its literal words, wired to the button, when true; nothing when false; and the
  // button LIVE in both (D-07: the host is the judge). The words are pinned once, as a
  // literal, here.

  it('shows the note, wired to the button, when the host would refuse the add for a belt', () => {
    const tree = render({ ports: THREE_OUT, addBlockedByBelt: true, flow: flowWith(THREE_OUT, { 2: 0 }) });
    const btn = addButton(tree);
    expect(btn, 'the Add control is there').toBeDefined();
    expect(btn?.props['aria-describedby']).toBe('fab-port-add-advisory');
    expect(describedText(tree, btn!)).toBe(
      'One more output needs another row, and a belt is in the way. Move it first.',
    );
    expect(ADD_BLOCKED_BY_BELT_NOTE).toBe(
      'One more output needs another row, and a belt is in the way. Move it first.',
    );
    expect(btn?.props.disabled, 'the note never gates the add').toBe(false);
  });

  it('says nothing when the host would accept the add, whatever is docked', () => {
    for (const ports of [ONE_OUT, THREE_OUT]) {
      const wired = render({ ports, addBlockedByBelt: false, flow: flowWith(ports, { 0: 0, 1: 0, 2: 0 }) });
      expect(addButton(wired)?.props['aria-describedby']).toBeUndefined();
      expect(textOf(wired)).not.toContain(ADD_BLOCKED_BY_BELT_NOTE);
      expect(addButton(wired)?.props.disabled).toBe(false);
    }
  });

  it('never shows the note on a kind that cannot add outputs', () => {
    const tree = render({ kind: machine_kind.ROUTER, addBlockedByBelt: true });
    expect(addButton(tree)).toBeUndefined();
    expect(textOf(tree)).not.toContain(ADD_BLOCKED_BY_BELT_NOTE);
  });

  it('raises the add intent with no arguments (the shell locks role/medium, not this)', () => {
    let calls = 0;
    const tree = render({ onAddOutput: () => (calls += 1) });
    (addButton(tree)?.props.onClick as () => void)();
    expect(calls).toBe(1);
  });

  it('omits a control the caller did not supply, rather than rendering a dead one', () => {
    const noRemove = render({ onRemoveOutput: undefined });
    expect(removeButtons(noRemove)).toHaveLength(0);
    const noAdd = render({ onAddOutput: undefined });
    expect(addButton(noAdd)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INSPECTOR NOTES APPEAR ONLY WHEN THEY APPLY (phase 91, D-12, CHROME-13, UI-SPEC 8.4).
//
// QA-02 wall 3 gave every non-Factory Outputs group a standing sentence saying only a
// Factory can add or remove outputs. It stood under every machine but one, explaining
// the absence of a control nothing on those machines suggests exists, so it is
// deleted: a non-Factory group ends at its last row. The one case where the missing
// control IS the surprise, a FACTORY rendered without an add handler (WR-08), keeps
// `Outputs cannot be added or removed here.`
// ---------------------------------------------------------------------------
describe('PortsSection - the Outputs group notes only when a note applies (CHROME-13)', () => {
  /** The `<section>`'s DIRECT children, in source order. */
  const sectionChildren = (tree: unknown): unknown[] => {
    const children = (tree as El).props.children;
    return Array.isArray(children) ? children : [children];
  };
  const outputsList = (tree: unknown): El => {
    const lists = findAll(tree, (el) => el.props.role === 'list');
    expect(lists, 'Inputs and Outputs are the two lists').toHaveLength(2);
    return lists[1];
  };
  /** Every `<p>` after the Outputs list: the group's notes. */
  const notesAfterOutputs = (tree: unknown): string[] => {
    const seq: El[] = [];
    walk(tree, (el) => seq.push(el));
    const at = seq.indexOf(outputsList(tree));
    return seq.slice(at + 1).filter((el) => el.type === 'p').map(textOf);
  };
  /** WR-08: the note a Factory with no add handler shows. */
  const unavailableNoteOf = (tree: unknown): El | undefined =>
    findAll(tree, (el) => textOf(el) === OUTPUT_EDIT_UNAVAILABLE_NOTE && el.type === 'p')[0];

  /** Every kind but Factory the inspector shows a Ports section for. */
  const NON_FACTORY_KINDS = [
    machine_kind.SOURCE,
    machine_kind.SINK,
    machine_kind.ROUTER,
    machine_kind.TEE,
    machine_kind.MERGE,
    machine_kind.BALANCER,
    machine_kind.ENDPOINT,
    machine_kind.BELT,
  ];

  it('a Source, Sink, Router, Tee, Merge, Balancer, Route and Belt panel holds no Outputs note', () => {
    for (const kind of NON_FACTORY_KINDS) {
      const tree = render({ kind });
      expect(notesAfterOutputs(tree), `no note after the Outputs group on kind ${kind}`).toEqual([]);
      expect(outputsList(tree).props['aria-describedby'], `the group describes nothing on kind ${kind}`).toBeUndefined();
      expect(addButton(tree), `and no add control on kind ${kind}`).toBeUndefined();
      expect(textOf(tree), `kind ${kind}`).not.toContain('Only a Factory');
    }
  });

  it('holds no Outputs note on a non-Factory with docked belts, a pending edit or no ports either', () => {
    const variants: Partial<PortsSectionProps>[] = [
      { flow: flowWith(POST_ADD, { 0: 2, 1: 3 }) },
      { portEditPending: true },
      { ports: [] },
      { onAddOutput: undefined, onRemoveOutput: undefined },
    ];
    for (const over of variants) {
      expect(notesAfterOutputs(render({ kind: machine_kind.TEE, ...over })), JSON.stringify(Object.keys(over))).toEqual([]);
    }
  });

  it('EXPLAINS ITSELF on a Factory the caller handed no add handler, rather than going silent (WR-08)', () => {
    const tree = render({ onAddOutput: undefined });
    expect(addButton(tree), 'no control').toBeUndefined();
    const note = unavailableNoteOf(tree);
    expect(note, 'and therefore a reason, never bare absence').toBeDefined();
    expect(describedText(tree, outputsList(tree))).toBe(OUTPUT_EDIT_UNAVAILABLE_NOTE);
    expect(OUTPUT_EDIT_UNAVAILABLE_NOTE).toBe('Outputs cannot be added or removed here.');
    expect(OUTPUT_EDIT_UNAVAILABLE_NOTE).not.toContain('\u2014');
  });

  it('a Factory with its add handler carries no fixed-outputs note and no group description', () => {
    const tree = render();
    expect(unavailableNoteOf(tree)).toBeUndefined();
    expect(addButton(tree), 'the control is there instead').toBeDefined();
    expect(outputsList(tree).props['aria-describedby']).toBeUndefined();
  });

  it('the WR-08 note stands in the slot the Add control has, after the Outputs list', () => {
    const rendered = (tree: unknown): El[] => sectionChildren(tree).filter(isEl);
    const noteSlot = rendered(render({ onAddOutput: undefined })).findIndex((c) => textOf(c) === OUTPUT_EDIT_UNAVAILABLE_NOTE);
    const addSlot = rendered(render()).findIndex((c) => textOf(c).includes(ADD_OUTPUT_LABEL));
    expect(noteSlot).toBeGreaterThan(-1);
    expect(noteSlot, 'same slot: the explanation stands where the control would').toBe(addSlot);
  });

  it('the WR-08 note reads at full ink, wraps at the note line height, and is a sentence, never a control', () => {
    const note = unavailableNoteOf(render({ onAddOutput: undefined })) as El;
    const style = note.props.style as Record<string, unknown>;
    expect(style.color).toBe('var(--fab-ink)');
    expect(style.lineHeight).toBe(1.3);
    expect(note.props.role).toBeUndefined();
    expect(note.props.tabIndex).toBeUndefined();
    expect(note.props.onClick).toBeUndefined();
  });

  // 52-07 / WINDOWS id 3: the two-line budget for the WR-08 note. The state that renders
  // it is unreachable from the app (`ConfigPanel` always passes an add handler), so the
  // budget is a greedy word wrap at the narrowest column count the e2e gate measures in
  // the real font at the real width (`PORT_NOTE_NARROWEST_COLS`, `portNoteWrap.ts`; since
  // phase 91 `panel-add-remove.spec.ts` measures it on the Ports column itself, the note
  // it used to measure being deleted).
  it('the WR-08 note holds its two-line budget at the measured narrowest column count', () => {
    expect(wrappedLines(OUTPUT_EDIT_UNAVAILABLE_NOTE, PORT_NOTE_NARROWEST_COLS)).toBe(2);
    expect(
      wrappedLines(OUTPUT_EDIT_UNAVAILABLE_NOTE, 22),
      'it still holds four columns narrower than the panel is ever measured at',
    ).toBe(2);
    // The model can return 3, so "<= 2" is not unfalsifiable here.
    expect(wrappedLines('x'.repeat(20) + ' ' + 'y'.repeat(20) + ' ' + 'z'.repeat(20), PORT_NOTE_NARROWEST_COLS)).toBe(3);
    // WR-06's hole, kept: the wording this slot carried until WR-06 was over budget at
    // the measured width.
    expect(wrappedLines('Adding and removing outputs is unavailable here.', PORT_NOTE_NARROWEST_COLS)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// THE REMOVAL NOTE, ON THE ROW IT APPLIES TO (phase 91, D-12, CHROME-13, UI-SPEC 8.4).
// A Factory Out row whose port has a docked belt says that removing it disconnects the
// belt; no other row says anything. The old standing sentence under a Factory's ONLY
// Out, docked or not, is deleted.
// ---------------------------------------------------------------------------
describe('PortsSection - the docked-output note (CHROME-13)', () => {
  const noteSpans = (tree: unknown): El[] =>
    findAll(tree, (el) => el.type === 'span' && textOf(el) === REMOVE_DOCKED_OUTPUT_NOTE);

  it('is the UI-SPEC sentence, 42 characters, no em dash', () => {
    expect(REMOVE_DOCKED_OUTPUT_NOTE).toBe('Removing this output disconnects its belt.');
    expect(REMOVE_DOCKED_OUTPUT_NOTE.length).toBe(42);
    expect(REMOVE_DOCKED_OUTPUT_NOTE).not.toContain('\u2014');
  });

  it('a fresh Factory with one undocked Out shows no removal note', () => {
    const ports = [port(0, 0), port(1, 1), port(2, 2)];
    const tree = render({ ports, flow: flowWith(ports) });
    expect(noteSpans(tree)).toHaveLength(0);
    expect(removeButtons(tree)[0].props['aria-describedby']).toBeUndefined();
    expect(textOf(tree)).not.toContain('nowhere to send its results');
  });

  it("a Factory Out with a docked belt shows the note on that row only, described by that row's Remove", () => {
    const tree = render({ flow: flowWithLinks(POST_ADD, { 3: 2 }), onDisconnect: () => {} });
    expect(noteSpans(tree), 'exactly one note on the panel').toHaveLength(1);
    const [clean, docked] = removeButtons(tree);
    expect(clean.props['aria-describedby'], 'the undocked Out says nothing').toBeUndefined();
    expect(describedText(tree, docked)).toBe(REMOVE_DOCKED_OUTPUT_NOTE);
    // On THAT row: the note's own listitem is the docked Out's.
    const row = rows(tree).find((r) => findAll(r, (el) => el === noteSpans(tree)[0]).length === 1);
    expect(removeButtons(row as El).map((b) => b.props['aria-label'])).toEqual(['Remove output 2']);
    expect(((noteSpans(tree)[0].props.style as Record<string, unknown>).color)).toBe('var(--fab-ink)');
  });

  it('no In row, Fault row or non-Factory row carries it, docked or not', () => {
    const everyDocked = flowWithLinks(POST_ADD, { 0: 1, 1: 1, 2: 1, 3: 1 });
    const factory = render({ flow: everyDocked, onDisconnect: () => {} });
    expect(noteSpans(factory), 'one per docked Factory Out, and only those').toHaveLength(2);
    for (const kind of [machine_kind.TEE, machine_kind.ROUTER, machine_kind.SOURCE]) {
      expect(noteSpans(render({ kind, flow: everyDocked, onDisconnect: () => {} })), `kind ${kind}`).toHaveLength(0);
    }
  });

  it('every inspector note and advisory reads in --fab-ink', () => {
    const tree = render({ addBlockedByBelt: true, flow: flowWithLinks(POST_ADD, { 1: 1 }), onDisconnect: () => {} });
    const ps = findAll(tree, (el) => el.type === 'p');
    expect(ps.length, 'the add advisory is shown').toBeGreaterThan(0);
    for (const p of [...ps, ...noteSpans(tree)]) {
      expect((p.props.style as Record<string, unknown>).color, textOf(p)).toBe('var(--fab-ink)');
    }
  });
});

// ---------------------------------------------------------------------------
// ROUTER OUTPUTS HAVE NAMES (phase 91, D-12, CHROME-13, UI-SPEC 8.6): a Router's Out rows
// are numbered, `Output N - Item`, N its routing key + 1, the number its rules editor
// names the output by. Every other kind keeps `Output - Item`.
// ---------------------------------------------------------------------------
describe('PortsSection - a Router numbers its Out rows (CHROME-13)', () => {
  const ROUTER_PORTS: PortView[] = [port(0, 0), port(1, 1), port(2, 1), port(3, 1), port(4, 2)];

  it('reads Output 1 - Item, Output 2 - Item, Output 3 - Item in routing-key order, the Fault row unnumbered', () => {
    const labels = rows(render({ kind: machine_kind.ROUTER, ports: ROUTER_PORTS, flow: flowWith(ROUTER_PORTS) })).map((r) =>
      String(r.props['aria-label']),
    );
    expect(labels).toEqual([
      `Input${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
      `Output 1${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
      `Output 2${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
      `Output 3${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
      `Fault${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
    ]);
  });

  it("a docked Router Out's Disconnect names the numbered row", () => {
    const tree = render({ kind: machine_kind.ROUTER, ports: ROUTER_PORTS, flow: flowWithLinks(ROUTER_PORTS, { 2: 1 }), onDisconnect: () => {} });
    expect(disconnectButtons(tree).map((b) => b.props['aria-label'])).toEqual([`${DISCONNECT_LABEL} Output 2${LABEL_SEPARATOR}Item`]);
  });

  it('a Factory and a Tee keep the unnumbered label', () => {
    for (const kind of [machine_kind.FACTORY, machine_kind.TEE]) {
      const labels = rows(render({ kind })).map((r) => String(r.props['aria-label']));
      expect(labels.filter((l) => l.startsWith('Output ')), `kind ${kind}`).toEqual([
        `Output${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
        `Output${LABEL_SEPARATOR}Item, ${PORT_STATUS.notConnected}`,
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// WIRE-05: the READOUT line, driven end to end from `selectedNodePortFlow`.
//
// This is the half of the mitigation a user can see. `WINDOWS` row 113 is about
// a config panel that would not tell the user what was attached; the demo handler of
// that time (a 1x1 Factory) carried BOTH cables on its electrical In and the row read
// `Input - Wire, not connected` while they were live on the board.
//
// The flow map here is built by the REAL fold rather than by `flowWith`, so
// these cases fail the moment the wire loop stops crediting presence - which is
// the point: a hand-written map would agree with itself forever.
// ---------------------------------------------------------------------------
describe('a wired electrical port reads IDLE, not "not connected" (WIRE-05)', () => {
  const electrical = (index: number, role: number, side: number): PortView => ({
    index,
    cell_x: 0,
    cell_y: 0,
    side,
    role,
    medium: 1,
  });

  const wire = (from: WireView['from'], to: WireView['to'], pulses = 0): WireView => ({
    id: 1,
    from,
    to,
    path: [],
    pulses: Array.from({ length: pulses }, () => ({
      entry_tick: 0,
      hop_ticks: 4,
      direction: 0,
    })),
  });

  const nodeWith = (ports: PortView[], kind: number): NodeView => ({
    id: 7,
    kind,
    cell_x: 0,
    cell_y: 0,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports,
    load: 0,
  });

  /** The row's own accessible line: `{Role} - {Medium}, {status}`. */
  const rowLabels = (tree: unknown): string[] =>
    rows(tree).map((r) => String(r.props['aria-label'] ?? ''));

  it('an ENDPOINT Out carrying a wire reads "Output - Wire, idle"', () => {
    const ports = [electrical(0, 0, 3), electrical(1, 1, 1)];
    const node = nodeWith(ports, machine_kind.ENDPOINT);
    const flow = selectedNodePortFlow(node, [], [wire({ node: 7, port: 1 }, { node: 9, port: 0 })], NO_SCENE);
    const labels = rowLabels(render({ ports, kind: machine_kind.ENDPOINT, flow }));

    expect(labels).toContain(`Output${LABEL_SEPARATOR}Wire, ${PORT_STATUS.idle}`);
    expect(labels).not.toContain(`Output${LABEL_SEPARATOR}Wire, ${PORT_STATUS.notConnected}`);
    // The unwired In beside it must still read the honest "not connected".
    expect(labels).toContain(`Input${LABEL_SEPARATOR}Wire, ${PORT_STATUS.notConnected}`);
  });

  it('the demo HTTP Handler reads its In and its Out as wired: each cable docks its own nub', () => {
    // demo_scene.board.ron (plan 85-08): the handler is a palette HTTP Handler, 3x3, with an
    // electrical In at index 0 (W), an electrical Out at index 1 (E) and a mechanical
    // Fault at index 2 (S). The request cable enters its In and the reply leaves its Out,
    // so EACH row carries one cable and reads idle; the Fault carries none. Until plan
    // 85-08 the demo handler was a 1x1 Factory with both cables on ONE In, which read
    // "not connected" on the shipped board (WINDOWS row 113).
    const fault: PortView = { index: 2, cell_x: 0, cell_y: 0, side: 2, role: 2, medium: 0 };
    const ports = [electrical(0, 0, 3), electrical(1, 1, 1), fault];
    const node = nodeWith(ports, machine_kind.HANDLER);
    const flow = selectedNodePortFlow(node, [], [
      wire({ node: 9, port: 1 }, { node: 7, port: 0 }),
      { ...wire({ node: 7, port: 1 }, { node: 9, port: 0 }), id: 2 },
    ], NO_SCENE);
    const labels = rowLabels(render({ ports, kind: machine_kind.HANDLER, flow }));

    expect(labels).toContain(`Input${LABEL_SEPARATOR}Wire, ${PORT_STATUS.idle}`);
    expect(labels).toContain(`Output${LABEL_SEPARATOR}Wire, ${PORT_STATUS.idle}`);
    expect(labels).not.toContain(`Input${LABEL_SEPARATOR}Wire, ${PORT_STATUS.notConnected}`);
    expect(labels).not.toContain(`Output${LABEL_SEPARATOR}Wire, ${PORT_STATUS.notConnected}`);
  });

  it('two wires on one port still read IDLE, never "moving" (carrying is belt items)', () => {
    // Presence is an OR and `carrying` stays false, so the readout cannot flicker off a
    // pulse that lives ~2 ticks (UI-SPEC 9).
    const ports = [electrical(0, 0, 3)];
    const node = nodeWith(ports, machine_kind.FACTORY);
    const flow = selectedNodePortFlow(node, [], [
      wire({ node: 9, port: 0 }, { node: 7, port: 0 }, 2),
      { ...wire({ node: 7, port: 0 }, { node: 9, port: 0 }, 1), id: 2 },
    ], NO_SCENE);
    expect(flow.get(0)!.carrying).toBe(false);
    expect(rowLabels(render({ ports, kind: machine_kind.FACTORY, flow }))).toContain(
      `Input${LABEL_SEPARATOR}Wire, ${PORT_STATUS.idle}`,
    );
    expect(rowLabels(render({ ports, kind: machine_kind.FACTORY, flow }))).not.toContain(
      `Input${LABEL_SEPARATOR}Wire, ${PORT_STATUS.moving}`,
    );
  });
});

// ---------------------------------------------------------------------------
// CONNECT-01 / CR-01: the Disconnect control READS the port-edit latch and never
// ARMS it.
//
// The two halves are separate claims and only one of them is about this file.
//
// READ side (this component): while an `AddPort`/`RemovePort` is unfolded, every
// packet port index on screen is known-stale, and a `Disconnect` sends a command
// keyed on one - so the control goes `disabled`, in `removeControl`'s exact busy
// shape, carrying NO reason element.
//
// WRITE side (declined): `observePorts` returns the latch untouched on its FIRST
// line whenever `latch.sentPortsKey === portsKey`, and `portsKeyOf` is built from
// index and role pairs only. An `Unlink` removes a LINK and never a port, so the
// key is byte-identical across the fold. A latch-arming Disconnect would stay
// pending until `isPortEditStale` crossed `PORT_EDIT_STALL_TICKS`, and the panel
// would then offer [Try again] for a command that had already succeeded.
//
// 67-VALIDATION.md's Non-Vacuity Requirement for this is stated as: ARM the latch
// and assert the panel does not hang, because a passing test that never armed it
// proves nothing. Case 3 arms it, through the same seam the panel uses.
// ---------------------------------------------------------------------------

/** The shipped `onDisconnect` handler's BODY, read off `ConfigPanel.tsx` with its
 *  comments stripped.
 *
 *  Read off disk rather than imported because the handler is an inline
 *  `useCallback` inside the container, and there is no seam to import. Comments
 *  are stripped because the docblock beside it discusses `sendPortEdit` at
 *  length: a substring match has to judge the CODE, not the prose about it. The
 *  same derivation-gate shape 67-03 used for the Landmine 4 parity check. */
function disconnectHandlerSource(): string {
  const src = readFileSync(fileURLToPath(new URL('./ConfigPanel.tsx', import.meta.url)), 'utf8');
  const start = src.indexOf('const onDisconnect = useCallback(');
  expect(start, 'ConfigPanel.tsx must still define onDisconnect as a useCallback').toBeGreaterThan(
    -1,
  );
  const end = src.indexOf('\n  const ', start + 1);
  expect(end, 'the handler must be followed by another top-level const').toBeGreaterThan(start);
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('Disconnect and the port-edit latch (CONNECT-01 read side, CR-01)', () => {
  it('goes DISABLED while a port edit is in flight, carrying NO reason element', () => {
    const tree = render({
      portEditPending: true,
      flow: flowWithLinks(POST_ADD, { 0: 0 }),
      onDisconnect: () => {},
    });
    const disconnect = disconnectButtons(tree);
    expect(disconnect).toHaveLength(1);
    expect(disconnect[0].props.disabled).toBe(true);
    expect(disconnect[0].props['aria-describedby']).toBeUndefined();
    // Asserted SIDE BY SIDE with the shipped Remove control so the two busy
    // shapes cannot drift apart. `removeControl`'s docblock already argues the
    // reason: "the index is momentarily unknown" is a transient mechanical state,
    // not a fact about this port a reader should be told, and a reason element
    // that flickers for the length of one fold is screen-reader noise.
    expect(removeButtons(tree)[0].props.disabled).toBe(true);
    expect(removeButtons(tree)[0].props['aria-describedby']).toBeUndefined();
  });

  it('renders ENABLED when no port edit is in flight', () => {
    const tree = render({
      portEditPending: false,
      flow: flowWithLinks(POST_ADD, { 0: 0 }),
      onDisconnect: () => {},
    });
    const disconnect = disconnectButtons(tree);
    expect(disconnect).toHaveLength(1);
    expect(disconnect[0].props.disabled).toBe(false);
  });

  it('with the latch ARMED by a real AddPort, Disconnect does not extend the pending window', () => {
    // ARM IT FOR REAL, through the seam the panel uses: `ConfigPanel`'s
    // `sendPortEdit` calls `beginPortEdit(latch, kind, portsKeyOf(ports), tick)`
    // and sends only when that returns a closed latch. Nothing below is a stand-in
    // for the latch, and a version of this case that skipped this step could not
    // tell a hanging panel from a healthy one.
    const armed = beginPortEdit(IDLE_PORT_EDIT, 'add', portsKeyOf(POST_ADD), 100);
    expect(armed, 'beginPortEdit closed the latch, so the panel really is pending').not.toBeNull();
    expect(isPortEditPending(armed as NonNullable<typeof armed>)).toBe(true);
    const latch = armed as NonNullable<typeof armed>;

    // READ side: the control is disabled, so the click cannot even be delivered
    // while the index it would carry is stale.
    const tree = render({
      portEditPending: isPortEditPending(latch),
      flow: flowWithLinks(POST_ADD, { 0: 0 }),
      onDisconnect: () => {},
    });
    expect(disconnectButtons(tree)).toHaveLength(1);
    expect(disconnectButtons(tree)[0].props.disabled).toBe(true);

    // A packet arrives whose ports key is UNCHANGED. The AddPort stays pending,
    // which is the correct answer (it has not folded yet), and it is the SAME
    // answer with or without the Disconnect above.
    expect(isPortEditPending(observePorts(latch, portsKeyOf(POST_ADD)))).toBe(true);
    expect(isPortEditStale(latch, 100 + PORT_EDIT_STALL_TICKS - 1)).toBe(false);

    // ...and when the AddPort's OWN fold lands, the latch releases normally. The
    // panel resolves; nothing has been left waiting.
    const afterAdd = [...POST_ADD, port(4, ROLE_OUT)];
    expect(isPortEditPending(observePorts(latch, portsKeyOf(afterAdd)))).toBe(false);

    // WHY THIS CASE ALSO READS SOURCE, said plainly rather than left to look odd.
    // Everything above is behavioural, and behaviour ALONE cannot see a
    // latch-arming build: `PortsSection` has no latch to arm. It receives
    // `portEditPending` as a boolean and `onDisconnect` as an opaque callback, so
    // no edit to THIS component could arm anything. The arming site is
    // `ConfigPanel`'s `onDisconnect`, and unless a mutation there is visible from
    // somewhere, this case is a check that cannot fail - the shape this project
    // has now caught six times. So the case reads that handler off disk.
    const handler = disconnectHandlerSource();
    expect(handler, 'the handler sends its command directly').toContain('sendInput(');
    expect(handler, 'Disconnect must NOT arm the port-edit latch').not.toContain('sendPortEdit');
    expect(handler, 'nor arm it directly').not.toContain('beginPortEdit');
  });

  it('leaves an IDLE latch idle: clicking Disconnect sends a command and arms nothing', () => {
    const idle = IDLE_PORT_EDIT;
    expect(isPortEditPending(idle)).toBe(false);

    const sent: string[] = [];
    const tree = render({
      portEditPending: isPortEditPending(idle),
      flow: flowWithLinks(POST_ADD, { 0: 0 }),
      onDisconnect: (p, link) => {
        sent.push(`${p.index}:${link.kind}`);
      },
    });
    const disconnect = disconnectButtons(tree);
    expect(disconnect[0].props.disabled).toBe(false);
    (disconnect[0].props.onClick as () => void)();
    expect(sent, 'exactly one command, naming the row and its resolved link').toEqual(['0:belt']);

    // The latch the panel holds is untouched by the click - same object, same
    // value - so `portEditPending` is false on the next render and the section
    // shows no waiting status at all.
    expect(idle).toBe(IDLE_PORT_EDIT);
    const next = render({
      portEditPending: isPortEditPending(idle),
      flow: flowWithLinks(POST_ADD, { 0: 0 }),
      onDisconnect: () => {},
    });
    expect(findAll(next, (el) => el.props.role === 'status')).toHaveLength(0);
    expect(disconnectButtons(next)[0].props.disabled).toBe(false);

    // THE HAZARD, MEASURED rather than asserted. Had the click armed the latch,
    // it would have armed against the ports key an `Unlink` leaves BYTE-IDENTICAL,
    // so `observePorts` would never release it and `isPortEditStale` would fire at
    // PORT_EDIT_STALL_TICKS - [Try again], on every click, for a command the host
    // had already applied. This is the defect the write side was declined to avoid.
    const hadItArmed = beginPortEdit(IDLE_PORT_EDIT, 'remove', portsKeyOf(POST_ADD), 100);
    const hypothetical = hadItArmed as NonNullable<typeof hadItArmed>;
    expect(isPortEditPending(observePorts(hypothetical, portsKeyOf(POST_ADD)))).toBe(true);
    expect(isPortEditStale(hypothetical, 100 + PORT_EDIT_STALL_TICKS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CONNECT-01: the Disconnect control's PRESENCE rules and its accessible name.
//
// Three of these assert on ABSENCE, and that is the point rather than a
// shortcut. `removeControl` is the counter-example the section is designed
// against: Remove is visible-but-disabled precisely because it carries a BLOCK
// REASON a reader must be told. Disconnect carries none, so when there is
// nothing to disconnect the control is ABSENT (67-UI-SPEC 2.1) - never a
// permanently dead button restating the row's own status word. An assertion on a
// DISABLED button would pass against a build that shipped exactly the dead button
// the spec forbids, so these query for null.
// ---------------------------------------------------------------------------
describe('Disconnect presence, absence and accessible name (CONNECT-01)', () => {
  it('7. a docked row names its Disconnect by COMPOSITION, never by the bare word', () => {
    // The In at catalog 0 and the hand-added Out at catalog 3, both docked.
    const tree = render({
      flow: flowWithLinks(POST_ADD, { 0: 2, 3: 0 }),
      onDisconnect: () => {},
    });
    const names = disconnectButtons(tree).map((b) => String(b.props['aria-label']));
    expect(names).toHaveLength(2);

    // The EXACT composed strings, written out rather than derived, so this case
    // cannot agree with a broken composition by computing the same wrong answer.
    expect(names).toEqual(['Disconnect Input - Item', 'Disconnect Output - Item']);

    // ...and the same strings stated as the RULE, so the two cannot drift: the
    // name is `Disconnect ` joined to the row's own `portRowLabel`. A bare
    // `Disconnect` would be one string repeated down the whole list, which a
    // by-name query and a screen reader walking the group could not tell apart.
    expect(names).toEqual([
      `${DISCONNECT_LABEL} ${portRowLabel(POST_ADD[0])}`,
      `${DISCONNECT_LABEL} ${portRowLabel(POST_ADD[3])}`,
    ]);
    for (const name of names) {
      expect(name).not.toBe(DISCONNECT_LABEL);
      expect(name.startsWith(`${DISCONNECT_LABEL} `)).toBe(true);
    }
  });

  it('8. an UNDOCKED row renders NO Disconnect at all, and says "not connected" in words', () => {
    // FAIL-CLOSED case three's sibling: nothing is attached, so there is nothing
    // to name and no verb to offer. The row states the fact once, as prose.
    const tree = render({ flow: flowWith(POST_ADD), onDisconnect: () => {} });
    expect(disconnectButtons(tree)).toHaveLength(0);
    const labels = rows(tree).map((r) => String(r.props['aria-label'] ?? ''));
    // Every port has its row (review IN-C07: `every` over an empty list is true, so a section
    // that rendered no rows passed the line below).
    expect(labels).toHaveLength(POST_ADD.length);
    expect(labels.every((l) => l.endsWith(`, ${PORT_STATUS.notConnected}`))).toBe(true);
    // The Out rows still carry their shipped Remove control - the absence above is
    // about Disconnect alone and must not read as "the row lost its controls".
    expect(removeButtons(tree).length).toBeGreaterThan(0);
  });

  it('9. a DOCKED row whose link did not resolve renders NO Disconnect either', () => {
    // The fail-closed half of the `PortFlow.link` widening, at the control. The
    // entry is docked - the row reads `idle`, the remove gate still treats it as
    // occupied - but the join could not say WHAT is attached, so the control is
    // absent rather than a button that would have to guess which link it
    // addresses. An absent control cannot send a wrong command.
    const partial = flowWith(POST_ADD, { 0: 0, 3: 5 });
    expect(partial.get(0)?.docked, 'the entry really is docked').toBe(true);
    expect(partial.get(0)?.link, 'and its link really is unresolved').toBeUndefined();

    const tree = render({ flow: partial, onDisconnect: () => {} });
    expect(disconnectButtons(tree)).toHaveLength(0);
    // Docked-ness is unaffected: the rows still read idle / moving, not
    // "not connected", so this is an absent VERB and never a lost fact.
    const labels = rows(tree).map((r) => String(r.props['aria-label'] ?? ''));
    expect(labels).toContain(`Input${LABEL_SEPARATOR}Item, ${PORT_STATUS.idle}`);
    expect(labels).toContain(`Output${LABEL_SEPARATOR}Item, ${PORT_STATUS.moving}`);

    // ...AND THE ROW NAMES NO MISSING BUTTON, which 73-08 settles by subtraction
    // rather than by wording. 67-REVIEW WR-06 was about a row whose Disconnect was
    // correctly ABSENT while "Disconnect it first" was still rendered beside it,
    // telling the builder to press something that is not there - the exact thing
    // `RefusalMessage.tsx`'s copy contract forbids. The downgrade that fixed it
    // went with the gate, and it can no longer regress: there is no block sentence
    // on this row to name anything, and the Remove is simply live.
    // Port 3 is the DOCKED Out (ordinal 1), the row whose Disconnect is missing. Its
    // only sentence (phase 91) is the docked-output consequence, which names no button.
    const ownDockRow = removeButtons(tree)[1];
    expect(ownDockRow.props.disabled, 'the remove is offered').toBe(false);
    expect(
      describedText(tree, ownDockRow),
      'and its only sentence is the consequence, naming no missing button',
    ).toBe(REMOVE_DOCKED_OUTPUT_NOTE);
    expect(REMOVE_DOCKED_OUTPUT_NOTE).not.toContain(DISCONNECT_LABEL);
  });
});
