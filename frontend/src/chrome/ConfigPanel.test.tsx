import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPLY_CONFIRM_ATTEMPTS,
  APPLY_CONFIRM_INTERVAL_MS,
  beltPortRows,
  beltRunDispatchable,
  configApplied,
  ConfigPanelView,
  commitConfig,
  disconnectCommand,
  loadConfig,
  reasonOf,
  ROUTE_POST_NOTE,
  type ConfigPanelViewProps,
} from './ConfigPanel.tsx';
import { CAMERA_CLUSTER_CLEARANCE } from './CameraCluster.tsx';
import { SourceConfigBody } from './SourceConfigBody.tsx';
import { SinkConfigBody } from './SinkConfigBody.tsx';
import { FactoryConfigBody, FACTORY_EDITOR_LABELS } from './FactoryConfigBody.tsx';
import { RouteConfigBody, MAX_ENDPOINT_PATH_BYTES } from './RouteConfigBody.tsx';
import { LabelConfigBody, MAX_LABEL_BYTES } from './LabelConfigBody.tsx';
import { TrashIcon } from './icons.tsx';
import { WebhookUrlRow } from './WebhookUrlRow.tsx';
import {
  encodeGridCommand,
  MAX_RUN_PACE_BELTS,
  type BeltView,
  type MachineConfig,
  type NodeView,
  type PortView,
  type TileView,
} from '../protocol/decode.ts';
import { portRowLabel } from './portLabels.ts';
import {
  ADD_OUTPUT_LABEL,
  DISCONNECT_LABEL,
  EMPTY_GROUP_LABEL,
  PortsSection,
  type PortsSectionProps,
} from './PortsSection.tsx';
import { BeltConfigBody, RUN_SINGLE, runPlural } from './BeltConfigBody.tsx';
import {
  BELT_PORT_HEAD,
  BELT_PORT_TAIL,
  MEDIUM_MECHANICAL,
  PORT_ROLE,
} from '../protocol/ports.ts';
import type { BeltRunEntry } from '../render/beltRun.ts';
import type { PacketLookup } from '../protocol/portFlow.ts';
import { LOAD_FULL, machine_kind, state_tag } from '../protocol/kinds.ts';
import { CONFIG_NOT_APPLIED_MARKER, CONFIG_NOT_APPLIED_SUFFIX } from './configCopy.ts';

// The vitest env is `node` (no DOM, no testing-library — the repo's zero-new-
// packages discipline). ConfigPanelView is a PURE function (all state via props),
// so we invoke it directly and walk the returned element tree, exactly like
// DeleteControl.test.tsx. The stateful `ConfigPanel` hook wrapper is a thin shell
// over the pure `loadConfig` / `commitConfig` logic, which we exercise directly
// with injected invoke/sendInput spies (its React state transitions are covered
// live in 39-08 e2e, per the v5.0 live-oracle lesson).

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
function hasClass(el: El, cls: string): boolean {
  return typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls);
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

const FACTORY_CFG: MachineConfig = { kind: 'Factory', source: 'export default (x) => x;' };
const SOURCE_CFG: MachineConfig = { kind: 'Source', trigger: { kind: 'Webhook' } };
const SINK_CFG: MachineConfig = { kind: 'Sink', target: { kind: 'Debug' } };

const baseView = (over: Partial<ConfigPanelViewProps> = {}): ConfigPanelViewProps => ({
  kind: machine_kind.FACTORY,
  node: 1,
  loading: false,
  config: FACTORY_CFG,
  dirty: false,
  error: null,
  applied: false,
  // PANEL-02: the poll-derived packet ports. Default empty - the existing view
  // assertions are about the per-kind body, not the I/O list (which has its own
  // e2e coverage in e2e/panel-io.spec.ts).
  ports: [],
  // 74.1-19: REQUIRED; the default Factory's add is accepted.
  addBlockedByBelt: false,
  // BELT-01: the belts an Apply writes to. REQUIRED (never optional-defaulted) for
  // the reason its docblock gives - an absent run reads as a run of one, which is
  // the exact wrong answer this phase can produce. Empty here: none of these cases
  // is a Belt.
  run: [],
  otherRoutes: [],
  // PANEL-04 / WR-01: dock presence is REQUIRED, never optional - an absent map
  // must not be silently readable as "nothing is docked" by the remove gate. An
  // empty map alongside an empty port list is the honest fixture.
  flow: new Map(),
  // PANEL-03 (WR-07): the destructive path's intents. Supplied by default so the
  // fixture matches what App really mounts - a fixture that silently omits them
  // renders a read-only panel and can never notice the edit controls regressing.
  // The controls themselves are pinned in PortsSection.test.tsx.
  onAddOutput: () => {},
  onRemoveOutput: () => {},
  // CR-01: copy-only (which of the two pending strings the Outputs group shows).
  // Required rather than defaulted so a caller has to think about it; the sim
  // boots Playing, so `true` is the fixture that matches a live app.
  playing: true,
  // CR-01/WR-01: the App-owned latch mirror. All three are REQUIRED props
  // (WR-03) - `portEditPending` gates the destructive Outputs group and
  // `portEditStalled` decides whether the panel shows a promise or an escape, so
  // neither may be reachable by a caller simply forgetting it. Idle is the
  // fixture that matches a panel with no edit sent.
  portEditPending: false,
  portEditStalled: false,
  // 74.1-19: REQUIRED; the pending line is past its grace whenever a case sets pending.
  portEditPendingVisible: true,
  onPortEditReset: () => {},
  // BELT-04: REQUIRED, never optional-defaulted, for the same WR-03 reason the
  // props above are. `null` is "nothing typed, the field mirrors the buffer".
  beltTyped: null,
  onBeltPace: () => {},
  onBeltTyped: () => {},
  onFieldChange: () => {},
  onApply: () => {},
  onRevert: () => {},
  invoke: () => Promise.resolve(null),
  factoryEditorRef: { current: null },
  onFactoryDirty: () => {},
  ...over,
});

/** A packet lookup holding these belts and no machine: every neighbour here is a
 *  belt or absent (phase 91: `beltPortRows` reads the scene by handle). */
const beltsOnly = (belts: ReadonlyMap<number, BeltView>): PacketLookup => ({ nodes: new Map(), belts });

describe('ConfigPanelView — mount + heading (mounts_on_selection)', () => {
  it('renders a single docked .fab-panel aside with the machine-kind heading', () => {
    const tree = ConfigPanelView(baseView({ kind: machine_kind.FACTORY, loading: true }));
    const asides = findAll(tree, (el) => el.type === 'aside' && hasClass(el, 'fab-panel'));
    expect(asides).toHaveLength(1);
    const h2 = findAll(tree, (el) => el.type === 'h2');
    expect(h2).toHaveLength(1);
    expect(textOf(h2[0])).toContain('Factory');
    // zIndex 2, right-docked — the Toolbar/Help/Legend panel layer.
    const style = asides[0].props.style as Record<string, unknown>;
    expect(style.zIndex).toBe(2);
    expect(style.right).toBe('var(--fab-space-lg)');
    expect(style.pointerEvents).toBe('auto');
  });

  // Phase 91, plan 91-09 (CHROME-07, D-06, UI-SPEC 2.1): the panel docks BELOW the Toolbar at
  // the shared dock offset the Help panel uses, has no bottom (it is as tall as its content) and
  // caps its content height so its border box ends 24 px above the window's bottom edge.
  it('docks below the Toolbar at the shared offset, with no bottom and a max height (CHROME-07)', () => {
    const tree = ConfigPanelView(baseView({ kind: machine_kind.SOURCE, config: SOURCE_CFG }));
    const aside = findAll(tree, (el) => el.type === 'aside' && hasClass(el, 'fab-panel'))[0];
    const style = aside.props.style as Record<string, unknown>;
    expect(style.top).toBe('calc(var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl))');
    expect(style.bottom).toBeUndefined();
    expect(style.width).toBe('min(420px, 33vw)');
    // Review WR-B-06: the max ends 8 px above the camera cluster's top, not 24 px above the
    // window's bottom (the cluster's own bottom inset), so a tall panel no longer covers Fit.
    expect(style.maxHeight).toBe(
      `calc(100% - (var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl)) - ${CAMERA_CLUSTER_CLEARANCE} - 2 * (var(--fab-space-md) + var(--fab-bezel-ring)))`,
    );
    expect(CAMERA_CLUSTER_CLEARANCE).toBe(
      '(var(--fab-space-lg) + var(--fab-min-target) + 2 * (var(--fab-space-sm) + var(--fab-bezel-ring)) + var(--fab-space-sm))',
    );
    expect(style.display).toBe('flex');
    // The sticky Apply / Revert row pays back only its top strip: a negative bottom margin
    // would end the column's content 4 px above the row and every panel would scroll by 4 px.
    const row = findAll(tree, (el) => el.props?.['data-fab-action-row'] === '')[0];
    const rowStyle = row.props.style as Record<string, unknown>;
    expect(rowStyle.position).toBe('sticky');
    expect(rowStyle.margin).toBe('calc(-1 * var(--fab-space-xs)) calc(-1 * var(--fab-space-md)) 0');
  });

  it('heading resolves each configurable kind name via KIND_NAMES', () => {
    expect(textOf(findAll(ConfigPanelView(baseView({ kind: machine_kind.SOURCE, config: SOURCE_CFG })), (e) => e.type === 'h2')[0])).toContain('Source');
    expect(textOf(findAll(ConfigPanelView(baseView({ kind: machine_kind.SINK, config: SINK_CFG })), (e) => e.type === 'h2')[0])).toContain('Sink');
  });
});

// Phase 76 (UI-SPEC U-6, D-07): a label's panel carries its heading and NO Ports section.
// A note never connects, so "Inputs: None / Outputs: None" would suggest it could.
describe('ConfigPanelView - a Label (phase 76)', () => {
  it('heads the panel "Label" and renders no PortsSection', () => {
    const tree = ConfigPanelView(baseView({ kind: machine_kind.LABEL, config: null }));
    expect(textOf(findAll(tree, (el) => el.type === 'h2')[0])).toContain('Label');
    expect(findAll(tree, (el) => el.type === PortsSection)).toHaveLength(0);
  });

  it('a machine still renders its PortsSection (the gate names the label alone)', () => {
    const tree = ConfigPanelView(baseView({ kind: machine_kind.SOURCE, config: SOURCE_CFG }));
    expect(findAll(tree, (el) => el.type === PortsSection)).toHaveLength(1);
  });

  // Plan 76-02: a label answers `machine_config` with its words, colour and size, so the
  // seventh arm renders its Text field and Apply appears under the shipped guard.
  const LABEL_CFG: MachineConfig = { kind: 'Label', text: 'Order intake', colour: 0, w: 4, h: 1 };
  const labelView = (over: Partial<ConfigPanelViewProps> = {}): ConfigPanelViewProps =>
    baseView({ kind: machine_kind.LABEL, config: LABEL_CFG, ...over });
  const applyDisabled = (tree: unknown): unknown => {
    const buttons = findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Apply');
    expect(buttons, 'the label card offers exactly one Apply').toHaveLength(1);
    return buttons[0].props.disabled;
  };
  const alertText = (tree: unknown): string | null => {
    const rows = findAll(tree, (el) => el.props.role === 'alert');
    return rows.length === 0 ? null : textOf(rows[0]);
  };

  it('renders the Text field with the whole config and raises the whole config back (76-02)', () => {
    const seen: MachineConfig[] = [];
    const tree = ConfigPanelView(labelView({ onFieldChange: (c) => seen.push(c) }));
    const body = findAll(tree, (el) => el.type === LabelConfigBody);
    expect(body).toHaveLength(1);
    expect(body[0].props.config).toEqual(LABEL_CFG);
    (body[0].props.onChange as (c: MachineConfig) => void)({ ...LABEL_CFG, text: 'Dispatch' });
    expect(seen).toEqual([{ kind: 'Label', text: 'Dispatch', colour: 0, w: 4, h: 1 }]);
    expect(findAll(tree, (el) => el.type === PortsSection), 'still no Ports section').toHaveLength(0);
  });

  it('a dirty label within the bound enables Apply with no error row (76-02)', () => {
    const tree = ConfigPanelView(labelView({ dirty: true }));
    expect(applyDisabled(tree)).toBe(false);
    expect(alertText(tree)).toBeNull();
  });

  it('a text over the bound states the overage in the error row and disables Apply, Revert live (76-02)', () => {
    const config: MachineConfig = { ...LABEL_CFG, text: 'a'.repeat(MAX_LABEL_BYTES + 8) };
    const tree = ConfigPanelView(labelView({ dirty: true, config }));
    expect(applyDisabled(tree)).toBe(true);
    expect(alertText(tree)).toBe('That text is too long by 8 characters.');
    expect(alertText(tree)).not.toContain(String(MAX_LABEL_BYTES));
    const revert = findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Revert');
    expect(revert[0].props.disabled, 'Revert stays live').toBe(false);
  });
});

describe('ConfigPanelView - the Route card (LEGIBLE-01, rebuilt by 72-10 / SERVE-05)', () => {
  // Phase 91 (D-12, CHROME-13): the Route calls its Handler, never "the wire".
  const ENDPOINT_HINT = 'POST a JSON body to call its Handler.';

  it('renders heading "Route" for kind ENDPOINT with null config', () => {
    // The heading resolves through the ONE folded name map (D-10), so the rename to
    // `Route` (D-09) lands here without this component carrying a literal of its own.
    const tree = ConfigPanelView(baseView({ kind: machine_kind.ENDPOINT, config: null }));
    expect(textOf(findAll(tree, (el) => el.type === 'h2')[0])).toContain('Route');
  });

  it('renders a WebhookUrlRow labelled "POST URL" plus the exact POST hint', () => {
    const tree = ConfigPanelView(baseView({ kind: machine_kind.ENDPOINT, node: 12, config: null }));
    const rows = findAll(tree, (el) => el.type === WebhookUrlRow);
    expect(rows).toHaveLength(1);
    expect(rows[0].props.label).toBe('POST URL');
    expect(rows[0].props.node).toBe(12);
    // The one-line hint renders as a React text child (no innerHTML).
    expect(textOf(tree)).toContain(ENDPOINT_HINT);
    expect(ROUTE_POST_NOTE).toBe(ENDPOINT_HINT);
  });

  it('sets the POST note at line height 1.4, so it reads as a sentence (phase 91, UI-SPEC 8.4)', () => {
    const tree = ConfigPanelView(baseView({ kind: machine_kind.ENDPOINT, node: 12, config: null }));
    const note = findAll(tree, (el) => el.type === 'p' && textOf(el) === ENDPOINT_HINT);
    expect(note).toHaveLength(1);
    expect((note[0].props.style as Record<string, unknown>).lineHeight).toBe(1.4);
  });

  it('shows NO Apply and NO Revert while the config round trip is still null', () => {
    // WAS "read-only info card", and the WORDS matter here rather than only the
    // number: a Route's `machine_config` was null FOREVER until 72-07 gave the path a
    // serialized field, so this used to assert a permanent property. It now asserts
    // the TRANSIENT one it always really tested - the `!loading && config` guard -
    // which is exactly the guard the Route card now passes through with no new gate.
    const tree = ConfigPanelView(baseView({ kind: machine_kind.ENDPOINT, config: null, dirty: false }));
    expect(findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Apply')).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Revert')).toHaveLength(0);
  });

  it('does not enroll ENDPOINT into another kind\'s body dispatch', () => {
    const tree = ConfigPanelView(baseView({ kind: machine_kind.ENDPOINT, config: null }));
    expect(findAll(tree, (el) => el.type === SourceConfigBody)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === SinkConfigBody)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === FactoryConfigBody)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === RouteConfigBody)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SERVE-05 (72-10 / D-12): the Route card with a REAL config, which is the state
// this phase makes reachable for the first time. Until 72-07 gave the path a
// serialized field, a Route answered `machine_config` with null and could never
// enter the `config &&` group at all.
// ---------------------------------------------------------------------------

describe('ConfigPanelView - the Route Path field (SERVE-05)', () => {
  // Phase 91 (D-12, CHROME-13): the Route calls its Handler, never "the wire".
  const ENDPOINT_HINT = 'POST a JSON body to call its Handler.';
  const ROUTE_CFG: MachineConfig = { kind: 'Endpoint', path: '/route-42' };
  const routeView = (over: Partial<ConfigPanelViewProps> = {}): ConfigPanelViewProps =>
    baseView({ kind: machine_kind.ENDPOINT, config: ROUTE_CFG, ...over });

  /** The one rendered `role="alert"` row's text, or null when there is none. */
  const alertText = (tree: unknown): string | null => {
    const rows = findAll(tree, (el) => el.props.role === 'alert');
    return rows.length === 0 ? null : textOf(rows[0]);
  };
  /** The Apply button's `disabled` prop. */
  const applyDisabled = (tree: unknown): unknown => {
    const buttons = findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Apply');
    expect(buttons, 'the Route card offers exactly one Apply').toHaveLength(1);
    return buttons[0].props.disabled;
  };

  it('renders the Path block FIRST after the heading, before the POST URL row', () => {
    // 72-UI-SPEC 3: the Path field is the card's focal point and takes the first
    // position. Position is asserted in ONE pre-order walk, because two independent
    // lookups would assert two unrelated existences and say nothing about order.
    const order: unknown[] = [];
    walk(ConfigPanelView(routeView()), (el) => order.push(el.type));
    const path = order.indexOf(RouteConfigBody);
    const url = order.indexOf(WebhookUrlRow);
    expect(path, 'the Path block is in the walk').toBeGreaterThanOrEqual(0);
    expect(url, 'the POST URL row is in the walk').toBeGreaterThanOrEqual(0);
    expect(path).toBeLessThan(url);
  });

  it('hands the field the COMMITTED-or-typed buffer path, and raises an Endpoint config', () => {
    const seen: MachineConfig[] = [];
    const tree = ConfigPanelView(routeView({ onFieldChange: (c) => seen.push(c) }));
    const body = findAll(tree, (el) => el.type === RouteConfigBody)[0];
    expect(body.props.path).toBe('/route-42');
    (body.props.onChange as (p: string) => void)('/orders');
    expect(seen).toEqual([{ kind: 'Endpoint', path: '/orders' }]);
  });

  it('offers Apply and Revert on a Route for the first time, under the EXISTING guard', () => {
    const tree = ConfigPanelView(routeView({ dirty: true }));
    expect(findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Apply')).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Revert')).toHaveLength(1);
  });

  it('keeps Apply disabled while the buffer is CLEAN, path or no path', () => {
    // `!dirty` is still the ordinary gate. The path rules are an ADDITIONAL term, not
    // a replacement, and a card that offered Apply on an untouched valid path would
    // be spending a gesture to write what is already there.
    expect(applyDisabled(ConfigPanelView(routeView({ dirty: false })))).toBe(true);
  });

  it('enables Apply for a dirty, legal, unclaimed path and shows NO error row', () => {
    // THE POSITIVE CASE, and it is what makes every refusal below discriminating: a
    // card that disabled Apply unconditionally would satisfy all four of them.
    const tree = ConfigPanelView(
      routeView({ dirty: true, config: { kind: 'Endpoint', path: '/orders' } }),
    );
    expect(applyDisabled(tree)).toBe(false);
    expect(alertText(tree)).toBeNull();
  });

  const REFUSALS: [string, string, string][] = [
    ['an EMPTY path', '', 'A path starts with a single / and cannot be empty.'],
    ['a path with NO leading slash', 'orders', 'A path starts with a single / and cannot be empty.'],
    ['a bare slash with nothing after it', '/', 'A path starts with a single / and cannot be empty.'],
    ['a path carrying a space', '/my orders', 'That path has a character a URL cannot carry.'],
    ['a percent sequence', '/%2e%2e', 'That path has a character a URL cannot carry.'],
  ];
  for (const [label, path, sentence] of REFUSALS) {
    it(`disables Apply and states the reason for ${label}`, () => {
      const tree = ConfigPanelView(routeView({ dirty: true, config: { kind: 'Endpoint', path } }));
      expect(applyDisabled(tree)).toBe(true);
      expect(alertText(tree)).toBe(sentence);
    });
  }

  it('states the OVERAGE for an over-long path, never the bound', () => {
    // The sentence counts what the user must DELETE. The bound itself is never typed
    // as a numeral in prose - a restated figure is a second source of truth, and
    // 68-UI-SPEC FINDING 1 is the worked example of what that costs.
    const over = 4;
    const path = `/${'a'.repeat(MAX_ENDPOINT_PATH_BYTES - 1 + over)}`;
    const tree = ConfigPanelView(routeView({ dirty: true, config: { kind: 'Endpoint', path } }));
    expect(applyDisabled(tree)).toBe(true);
    expect(alertText(tree)).toBe(`That path is too long by ${over} characters.`);
    // DISCRIMINATING: the figure in the sentence is the OVERAGE and not the BOUND.
    // Without this clause a message that printed the bound would pass the line above
    // for any overage that happened to equal it.
    expect(alertText(tree)).not.toContain(String(MAX_ENDPOINT_PATH_BYTES));
  });

  it('accepts a path of exactly the bound, so the rule is a bound and not an off-by-one', () => {
    const path = `/${'a'.repeat(MAX_ENDPOINT_PATH_BYTES - 1)}`;
    expect(path.length).toBe(MAX_ENDPOINT_PATH_BYTES);
    const tree = ConfigPanelView(routeView({ dirty: true, config: { kind: 'Endpoint', path } }));
    expect(applyDisabled(tree)).toBe(false);
    expect(alertText(tree)).toBeNull();
  });

  it('names the OWNING Route by cell for a duplicate path (D-13, the panel half)', () => {
    const tree = ConfigPanelView(
      routeView({
        dirty: true,
        config: { kind: 'Endpoint', path: '/orders' },
        otherRoutes: [{ node: 7, path: '/orders', cell_x: 14, cell_y: 6 }],
      }),
    );
    expect(applyDisabled(tree)).toBe(true);
    expect(alertText(tree)).toBe('That path is already used by the Route at (14,6).');
  });

  it('does NOT refuse a path merely because ANOTHER Route exists at a different one', () => {
    // The other half of the duplicate rule, and the one a naive implementation gets
    // wrong: a non-empty neighbour list must not be readable as "taken".
    const tree = ConfigPanelView(
      routeView({
        dirty: true,
        config: { kind: 'Endpoint', path: '/orders' },
        otherRoutes: [{ node: 7, path: '/invoices', cell_x: 14, cell_y: 6 }],
      }),
    );
    expect(applyDisabled(tree)).toBe(false);
    expect(alertText(tree)).toBeNull();
  });

  it('lets the HOST sentence win when a refusal has already happened', () => {
    // `error` is a refusal that HAPPENED; the client gate is a statement about a
    // buffer that has not been sent. Showing the gate over a live refusal would
    // replace what the host said with what the panel guessed, and the host is the
    // authority (D-13).
    const tree = ConfigPanelView(
      routeView({
        dirty: true,
        config: { kind: 'Endpoint', path: '' },
        error: 'That path is already used by another Route.',
      }),
    );
    expect(alertText(tree)).toBe('That path is already used by another Route.');
  });

  it('renders exactly ONE alert row, never the host row and the gate row together', () => {
    const tree = ConfigPanelView(
      routeView({ dirty: true, config: { kind: 'Endpoint', path: '' }, error: 'Host said no.' }),
    );
    expect(findAll(tree, (el) => el.props.role === 'alert')).toHaveLength(1);
  });

  it('still shows the POST URL row and its hint, unchanged', () => {
    const tree = ConfigPanelView(routeView({ node: 12 }));
    const rows = findAll(tree, (el) => el.type === WebhookUrlRow);
    expect(rows).toHaveLength(1);
    expect(rows[0].props.label).toBe('POST URL');
    expect(rows[0].props.node).toBe(12);
    expect(textOf(tree)).toContain(ENDPOINT_HINT);
  });

  it('shows the COMMITTED URL while dirty: the row is NEVER told the buffer', () => {
    // 72-UI-SPEC 3.1, asserted STRUCTURALLY rather than by reading a string. The row
    // carries a Copy button, and a previewed URL is a URL that 404s handed over with
    // an affordance saying it is ready. This clause is what stops a later edit from
    // "helpfully" threading the TYPED path in.
    //
    // RE-POINTED AT 72-13, and the reason the prop set grew is worth having here. This
    // read `toEqual(['invoke', 'label', 'node'])`: the row was told the NODE and
    // nothing else, and its fetch was keyed on the node alone. That is correct for a
    // Source, whose `/hook/src-<id>` URL nothing a user types can move. It is WRONG for
    // a Route from SERVE-05 onward: `Apply` folds a new path, the URL genuinely
    // changes, and a node-keyed fetch left the OLD string on screen with the Copy
    // button still beside it - measured on the real host by
    // `e2e-live/25-route-and-handler.spec.ts`, not reasoned about.
    //
    // So the row now takes a `refreshKey`, and THE GUARD'S INTENT IS UNCHANGED: what it
    // forbids is the BUFFER reaching this row. The key is the COMMITTED config, which
    // moves only after the host has folded, so nothing previewable can arrive here. The
    // exact-prop-set form is kept rather than loosened to a `not.toContain`, because
    // the whole point is that a fifth prop has to come past this assertion to exist.
    const tree = ConfigPanelView(
      routeView({
        dirty: true,
        config: { kind: 'Endpoint', path: '/typed-but-unsaved' },
        committed: { kind: 'Endpoint', path: '/committed' },
      }),
    );
    const row = findAll(tree, (el) => el.type === WebhookUrlRow)[0];
    expect(Object.keys(row.props).sort()).toEqual(['invoke', 'label', 'node', 'refreshKey']);
    expect(
      row.props.refreshKey,
      'the row is keyed on the COMMITTED path, so it can never preview the typed one',
    ).toBe('/committed');
    expect(textOf(tree)).not.toContain('/typed-but-unsaved');
  });

  it('re-keys the POST URL row when the COMMITTED path moves, so an applied path is not shown stale', () => {
    // The positive half of the guard above, and the assertion the live defect would
    // have failed: with the key absent (or constant) the row re-uses its mounted fetch
    // and keeps showing the pre-Apply URL. Two renders, two committed paths, two keys.
    const keyFor = (path: string): unknown => {
      const tree = ConfigPanelView(routeView({ committed: { kind: 'Endpoint', path } }));
      return findAll(tree, (el) => el.type === WebhookUrlRow)[0].props.refreshKey;
    };
    expect(keyFor('/route-1')).toBe('/route-1');
    expect(keyFor('/orders')).toBe('/orders');
    expect(keyFor('/route-1')).not.toBe(keyFor('/orders'));
  });

  it('leaves the key UNDEFINED on a kind that is not a Route, so no other call site changes', () => {
    // `SourceConfigBody`'s row is untouched by this: a Source URL is derived from the
    // node id and nothing a user types moves it, so re-keying it would be a re-query
    // for no reason. Asserted rather than left to the `committed?.kind` narrowing.
    const tree = ConfigPanelView(
      routeView({ committed: { kind: 'Factory', source: 'export default function () {}' } }),
    );
    expect(findAll(tree, (el) => el.type === WebhookUrlRow)[0].props.refreshKey).toBeUndefined();
  });

  it('carries the not-applied marker in the heading while dirty', () => {
    const heading = findAll(ConfigPanelView(routeView({ dirty: true })), (el) => el.type === 'h2')[0];
    expect(textOf(heading)).toContain(CONFIG_NOT_APPLIED_MARKER);
    expect(textOf(heading)).toContain('Route');
  });

  it('leaves every OTHER kind ungated by the path rules', () => {
    // `routePathDispatchable`'s shape is `beltRunDispatchable`'s: it answers `true`
    // for every kind it says nothing about, so a Factory with a dirty buffer is not
    // silently blocked by a rule about addresses it does not have.
    const tree = ConfigPanelView(baseView({ dirty: true, otherRoutes: [] }));
    expect(applyDisabled(tree)).toBe(false);
  });
});

describe('ConfigPanelView — loading then prefill (loading_then_prefill)', () => {
  it('loading renders a disabled field with the "Loading config…" placeholder and NO body', () => {
    const tree = ConfigPanelView(baseView({ loading: true }));
    const loadingFields = findAll(
      tree,
      (el) => hasClass(el, 'fab-field') && el.props.disabled === true,
    );
    expect(loadingFields.length).toBeGreaterThanOrEqual(1);
    expect(loadingFields[0].props.placeholder).toBe('Loading config…');
    // No Apply/Revert while loading.
    expect(findAll(tree, (el) => textOf(el) === 'Apply' && el.type === 'button')).toHaveLength(0);
  });

  it('a resolved Factory config seeds the CodeMirror editor with the current source verbatim', () => {
    const tree = ConfigPanelView(baseView({ config: FACTORY_CFG }));
    // 39-08: the Factory body is now the uncontrolled CodeMirror widget (a real
    // EditorView needs a DOM, so the node env asserts the element + its seed prop;
    // the live mount/edit/Apply is proven in the 12-config-apply e2e:live gate).
    const editors = findAll(tree, (el) => el.type === FactoryConfigBody);
    expect(editors).toHaveLength(1);
    expect(editors[0].props.initialSource).toBe(FACTORY_CFG.source);
    // No raw <textarea> Factory body remains (the meta-package/textarea fallback is gone).
    const textareas = findAll(tree, (el) => el.type === 'textarea' && hasClass(el, 'fab-field'));
    expect(textareas).toHaveLength(0);
  });

  it('hands the Source body the COMMITTED trigger kind, never the typed buffer (DEMO-08)', () => {
    // The URL row inside SourceConfigBody renders only for a committed Webhook. The
    // panel must feed it what the host folded: a buffer typed to Timer over a committed
    // Webhook still names Webhook, and a buffer typed to Webhook over a committed Timer
    // still names Timer, so the row never previews a door the host has not opened.
    const bodyFor = (config: MachineConfig, committed: MachineConfig | null): unknown =>
      findAll(
        ConfigPanelView(baseView({ kind: machine_kind.SOURCE, config, committed, dirty: true })),
        (el) => el.type === SourceConfigBody,
      )[0].props.committedTrigger;
    const timer: MachineConfig = { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: 8 } };
    expect(bodyFor(timer, SOURCE_CFG)).toBe('Webhook');
    expect(bodyFor(SOURCE_CFG, timer)).toBe('Timer');
    expect(bodyFor(SOURCE_CFG, null), 'unknown until the host answers').toBeUndefined();
  });

  it('dispatches to the per-kind body by resolved config kind', () => {
    const src = ConfigPanelView(baseView({ kind: machine_kind.SOURCE, config: SOURCE_CFG }));
    expect(findAll(src, (el) => el.type === SourceConfigBody)).toHaveLength(1);
    const sink = ConfigPanelView(baseView({ kind: machine_kind.SINK, config: SINK_CFG }));
    expect(findAll(sink, (el) => el.type === SinkConfigBody)).toHaveLength(1);
  });

  it('loadConfig queries machine_config for the node and returns the resolved config', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const invoke = (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      return Promise.resolve(SOURCE_CFG);
    };
    const cfg = await loadConfig(42, invoke);
    expect(calls).toEqual([['machine_config', { node: 42 }]]);
    expect(cfg).toEqual(SOURCE_CFG);
  });
});

describe('ConfigPanelView — dirty / Apply / Revert (dirty_apply_revert)', () => {
  it('dirty shows the not-applied marker and enables Apply + Revert', () => {
    const tree = ConfigPanelView(baseView({ dirty: true }));
    expect(textOf(findAll(tree, (el) => el.type === 'h2')[0])).toContain(CONFIG_NOT_APPLIED_MARKER);
    const apply = findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Apply')[0];
    const revert = findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Revert')[0];
    expect(apply.props.disabled).toBe(false);
    expect(revert.props.disabled).toBe(false);
  });

  it('clean (not dirty) disables Apply + Revert and hides the marker', () => {
    const tree = ConfigPanelView(baseView({ dirty: false }));
    expect(textOf(findAll(tree, (el) => el.type === 'h2')[0])).not.toContain(CONFIG_NOT_APPLIED_MARKER);
    const apply = findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Apply')[0];
    expect(apply.props.disabled).toBe(true);
  });

  // Phase 90 red-first probes (plan 90-01, D-14): written at PHASE90_START and seen red there behind
  // the red-first gate; plan 90-05 turned them on (the gate and the title suffix went, the bodies did
  // not). Neither writes the old panel marker or the old error suffix as a literal.

  it('the_heading_marks_typed_config_not_applied', () => {
    const heading = textOf(findAll(ConfigPanelView(baseView({ dirty: true })), (el) => el.type === 'h2')[0]);
    console.log(`P90-CHROME-17-marker heading=${JSON.stringify(heading)}`);
    expect(heading, 'typed but not applied config is marked "not applied"').toContain('• not applied');
    expect(heading, 'the board word "unsaved" is not the panel word').not.toMatch(/unsaved/);
  });

  it('the_factory_error_says_not_applied', () => {
    // The Factory code error is built inside the stateful panel's Apply handler, which this node
    // environment cannot mount; read the template it renders, resolving a suffix constant from
    // the pure copy module plan 90-05 adds (`configCopy.ts`) when the template names one.
    const panel = readFileSync(fileURLToPath(new URL('./ConfigPanel.tsx', import.meta.url)), 'utf8');
    const template = panel.match(/`Handler error - \$\{res\.error\}\. ([^`]*)`/);
    expect(template, 'ConfigPanel.tsx builds the Factory code error from one template').not.toBeNull();
    let suffix = template![1];
    const named = suffix.match(/^\$\{(\w+)\}$/);
    if (named) {
      const copyPath = fileURLToPath(new URL('./configCopy.ts', import.meta.url));
      const copy = existsSync(copyPath) ? readFileSync(copyPath, 'utf8') : '';
      const def = copy.match(new RegExp(`export const ${named[1]}\\s*=\\s*'([^']*)'`));
      expect(def, `the suffix constant ${named[1]} is defined in configCopy.ts`).not.toBeNull();
      suffix = def![1];
    }
    const row = `Handler error - Unexpected token. ${suffix}`;
    console.log(`P90-CHROME-17-suffix row=${JSON.stringify(row)}`);
    expect(row).toBe('Handler error - Unexpected token. Not applied.');
  });

  it('Apply / Revert buttons route to their callbacks', () => {
    let applied = 0;
    let reverted = 0;
    const tree = ConfigPanelView(
      baseView({ dirty: true, onApply: () => applied++, onRevert: () => reverted++ }),
    );
    (findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Apply')[0].props.onClick as () => void)();
    (findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Revert')[0].props.onClick as () => void)();
    expect(applied).toBe(1);
    expect(reverted).toBe(1);
  });

  it('commitConfig of a non-Factory config sends the encoded Configure (no validate)', async () => {
    const sent: Uint8Array[] = [];
    const invoked: string[] = [];
    const res = await commitConfig(7, SINK_CFG, {
      invoke: (cmd) => {
        invoked.push(cmd);
        return Promise.resolve(null);
      },
      sendInput: (b) => sent.push(b),
      // BELT-01: REQUIRED, and irrelevant to a Sink - the run-pace branch is
      // reachable only for a Belt config.
      run: [],
    });
    // `dispatched`, never `sent`: the bytes reached the send seam and that is
    // the whole of what this function can report. `ITransport.sendInput` returns
    // `void` on both wires, so there is no verdict to hand back here.
    expect(res).toEqual({ dispatched: true, error: null });
    // No validate_factory_js for a Sink.
    expect(invoked).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(Array.from(sent[0])).toEqual(
      Array.from(encodeGridCommand({ kind: 'Configure', node: 7, config: SINK_CFG })),
    );
  });
});

describe('commitConfig - a label grow claims its new cells (plan 88-07, BELT-06, D-09)', () => {
  const LABEL_CFG = { kind: 'Label', text: 'Hi', colour: 0, w: 6, h: 1 } as const;
  const BOX = { id: 9, cx: 10, cy: 12, w: 4, h: 1 };

  it('sends the Configure with a resize claim of the new box minus the label\'s own cells', async () => {
    const sent: Array<{ bytes: number[]; claim: unknown }> = [];
    const res = await commitConfig(9, LABEL_CFG, {
      invoke: () => Promise.resolve(null),
      sendInput: (b, o) => sent.push({ bytes: Array.from(b), claim: o?.claim }),
      run: [],
      labelBox: BOX,
    });
    expect(res).toEqual({ dispatched: true, error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].bytes, 'the same Configure bytes as ever').toEqual(
      Array.from(encodeGridCommand({ kind: 'Configure', node: 9, config: LABEL_CFG })),
    );
    const claim = sent[0].claim as { kind: string; node: number; cells: ReadonlySet<string> };
    expect(claim.kind).toBe('resize');
    expect(claim.node, 'the claim names its own label, so its own outline excludes it').toBe(9);
    expect([...claim.cells].sort(), 'the two cells a 4 by 1 label grows into at 6 by 1').toEqual(['14,12', '15,12']);
  });

  it('sends no claim without the label\'s box, or for a box of another node', async () => {
    for (const labelBox of [undefined, null, { ...BOX, id: 8 }]) {
      const opts: unknown[] = [];
      await commitConfig(9, LABEL_CFG, {
        invoke: () => Promise.resolve(null),
        sendInput: (_b, o) => opts.push(o),
        run: [],
        labelBox,
      });
      expect(opts, `labelBox ${JSON.stringify(labelBox)}`).toEqual([undefined]);
    }
  });
});

describe('ConfigPanelView — Factory invalid JS inline (factory_invalid_js_inline)', () => {
  it('a rejected validate_factory_js returns the reason and sends NOTHING', async () => {
    const sent: Uint8Array[] = [];
    const res = await commitConfig(3, FACTORY_CFG, {
      invoke: (cmd) => {
        expect(cmd).toBe('validate_factory_js');
        return Promise.reject('Unexpected token');
      },
      sendInput: (b) => sent.push(b),
      run: [],
    });
    expect(res).toEqual({ dispatched: false, error: 'Unexpected token' });
    expect(sent).toHaveLength(0);
  });

  it('a valid Factory validate gates THROUGH to sendInput', async () => {
    const sent: Uint8Array[] = [];
    const res = await commitConfig(3, FACTORY_CFG, {
      invoke: () => Promise.resolve(null),
      sendInput: (b) => sent.push(b),
      run: [],
    });
    expect(res.dispatched).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('renders the inline destructive error row (WarningIcon + word) — colour is never the only cue', () => {
    const msg = `Handler error - Unexpected token. ${CONFIG_NOT_APPLIED_SUFFIX}`;
    const tree = ConfigPanelView(baseView({ error: msg }));
    const alerts = findAll(tree, (el) => el.props.role === 'alert');
    expect(alerts).toHaveLength(1);
    expect(textOf(alerts[0])).toContain(msg);
    const alertStyle = alerts[0].props.style as Record<string, unknown>;
    expect(alertStyle.color).toBe('var(--fab-destructive)');
    // The glyph is present (word + icon, not colour alone).
    expect(findAll(alerts[0], (el) => typeof el.type === 'function')).not.toHaveLength(0);
  });
});

describe('ConfigPanelView — query-failure backstop (query_failure_backstop)', () => {
  it('a machine_config rejection propagates from loadConfig (drives the same error row)', async () => {
    await expect(loadConfig(9, () => Promise.reject('host down'))).rejects.toBe('host down');
  });

  it('renders the same destructive error row for a load failure message', () => {
    const tree = ConfigPanelView(baseView({ loading: false, error: 'Could not load config - host down.' }));
    const alerts = findAll(tree, (el) => el.props.role === 'alert');
    expect(alerts).toHaveLength(1);
    expect(textOf(alerts[0])).toContain('Could not load config');
  });
});

describe('configApplied - the panel may only claim what it has OBSERVED (65-REVIEW CR-02)', () => {
  const ROUTER = (port: number): MachineConfig => ({
    kind: 'Router',
    routes: [[{ offset: 0, expect: [97] }, port]],
    default: null,
  });

  it('is FALSE while the host still answers with the table it had before', () => {
    // THE REFUSAL, modelled exactly as a refusal really behaves: `command.rs`
    // returns the typed error BEFORE any record is written, so the core is
    // byte-identical and `machine_config` keeps answering with the old table.
    //
    // THIS IS THE LOAD-BEARING MUTATION FOR CR-02. Restoring the shipped
    // behaviour - claiming success from the dispatch alone, which in this
    // function is the one-line body `return true;` - reddens this case with the
    // observed message:
    //
    //   AssertionError: a refused Configure is never observed applied:
    //   expected true to be false // Object.is equality
    //
    // and true is precisely what the panel used to act on: it lit `Applied`,
    // cleared the not-applied marker, and recorded a table the engine had thrown
    // away as the committed truth for the next Revert.
    expect(
      configApplied(7, ROUTER(2), ROUTER(0)),
      'a refused Configure is never observed applied',
    ).toBe(false);
  });

  it('is FALSE when the host has no answer yet', () => {
    // A null read-back (no config, or a query that fell over) is not evidence.
    expect(configApplied(7, ROUTER(2), null)).toBe(false);
  });

  it('is TRUE only once the host answers with the very table that was sent', () => {
    expect(configApplied(7, ROUTER(2), ROUTER(2))).toBe(true);
  });

  it('compares the WIRE BYTES, so key order cannot make an identical config differ', () => {
    // The two sides come from different places: the sent config was built in
    // this panel's buffer, the read-back was deserialised out of the host's
    // ConfigView JSON, and nothing makes their key order agree. A
    // JSON.stringify comparison goes false here; the byte comparison does not.
    const sentOrder = { kind: 'Sink', target: { kind: 'Http', url: 'http://x', method: 3 } };
    const hostOrder = { target: { method: 3, url: 'http://x', kind: 'Http' }, kind: 'Sink' };
    expect(JSON.stringify(sentOrder)).not.toBe(JSON.stringify(hostOrder));
    expect(
      configApplied(4, sentOrder as MachineConfig, hostOrder as MachineConfig),
      'key order is not a difference in the config',
    ).toBe(true);
  });

  it('tells a Factory source apart down to the byte', () => {
    expect(configApplied(3, FACTORY_CFG, FACTORY_CFG)).toBe(true);
    expect(
      configApplied(3, FACTORY_CFG, { kind: 'Factory', source: 'export default (x) => x; ' }),
    ).toBe(false);
  });

  it('asks the host more than once, over a window a folded tick fits inside', () => {
    // The budget is a COURTESY and not a verdict, so what matters is only that
    // it asks more than once (a single ask would race the fold and report a
    // successful Apply as unconfirmed) and that the window is far longer than
    // the ~17ms a tick takes at 60 ticks per second.
    expect(APPLY_CONFIRM_ATTEMPTS).toBeGreaterThan(1);
    expect(APPLY_CONFIRM_ATTEMPTS * APPLY_CONFIRM_INTERVAL_MS).toBeGreaterThan(500);
  });
});

describe('commitConfig — dirty selection-change backstop (dirty_selection_change_backstop)', () => {
  it('serialises EXACTLY the config it is given, so a discarded buffer cannot reach the log', async () => {
    // The committed config and a dirty (uncommitted) edit encode to DIFFERENT bytes.
    const committed: MachineConfig = { kind: 'Sink', target: { kind: 'Debug' } };
    const dirtyEdit: MachineConfig = { kind: 'Sink', target: { kind: 'Http', url: 'http://x', method: 3 } };
    const committedBytes = Array.from(encodeGridCommand({ kind: 'Configure', node: 5, config: committed }));
    const dirtyBytes = Array.from(encodeGridCommand({ kind: 'Configure', node: 5, config: dirtyEdit }));
    expect(committedBytes).not.toEqual(dirtyBytes);

    // Applying the COMMITTED config sends exactly its bytes — the discarded dirty
    // edit (never passed to commitConfig) can never contaminate the edit-log.
    const sent: Uint8Array[] = [];
    await commitConfig(5, committed, {
      invoke: () => Promise.resolve(null),
      sendInput: (b) => sent.push(b),
      run: [],
    });
    expect(Array.from(sent[0])).toEqual(committedBytes);
  });
});

describe('commitConfig - the Belt branch names EVERY belt in the run (68-REVIEW CR-01)', () => {
  // THE SEAM THIS FILE HAD NO CASE FOR. `commitConfig`'s Belt branch is the one
  // line in the tree that turns a belt run into a multi-belt frame, and until
  // this block existed every `commitConfig` case above passed `run: []` with a
  // Sink or a Factory config, so the branch had ZERO unit coverage. Narrowing
  // `deps.run.map((belt) => belt.id)` to `[node]` - the shape a "simplify this"
  // edit produces - left tsc, vitest, both browser suites and all of cargo
  // green, because every other Apply-path assertion in the tree runs on a run
  // of ONE and a one-belt board cannot tell the two shapes apart.
  //
  // The expectation is the BYTE GRAMMAR, spelled out, not `encodeBeltRunPace(...)`
  // on both sides: an assertion built from the encoder under test samples that
  // encoder against itself and stays green through a wholesale change of the
  // wire format. The grammar is `0xFE`, varintU(3), the three handles in flow
  // order, then the pace - `decode.ts`'s `encodeBeltRunPace` docblock.
  const RUN: BeltRunEntry[] = [
    { id: 11, ticksPerSlot: 4 },
    { id: 12, ticksPerSlot: 4 },
    { id: 13, ticksPerSlot: 4 },
  ];
  /** The clicked belt is the MIDDLE of the run, so a narrowing to the clicked
   *  belt alone is distinguishable from a narrowing to the first or the last. */
  const CLICKED = 12;
  const BELT_CFG: MachineConfig = { kind: 'Belt', ticks_per_slot: 10 };

  it('commitConfig of a Belt config names EVERY belt in the run, in flow order', async () => {
    const sent: Uint8Array[] = [];
    const invoked: string[] = [];
    const res = await commitConfig(CLICKED, BELT_CFG, {
      invoke: (cmd) => {
        invoked.push(cmd);
        return Promise.resolve(null);
      },
      sendInput: (b) => sent.push(b),
      run: RUN,
    });
    expect(res).toEqual({ dispatched: true, error: null });
    // No validate_factory_js for a Belt, and no `machine_config` read either:
    // the branch is pure encode-and-send.
    expect(invoked).toHaveLength(0);
    // ONE frame for the whole run. N frames would be N action ids on the host,
    // so N Ctrl+Z steps for one Apply (68-UI-SPEC FINDING 2).
    expect(sent, 'ONE Apply on a run of three emits ONE frame, never one per belt').toHaveLength(1);
    expect(Array.from(sent[0])).toEqual([0xfe, 3, 11, 12, 13, 10]);
  });

  it('a run of one is a run of ONE - the frame carries that belt and no other', async () => {
    // The contrast case, and the reason the three-belt case above is the one
    // that can fail: THIS shape is what every other Apply assertion in the tree
    // exercises, and it is green under the narrowing.
    const sent: Uint8Array[] = [];
    await commitConfig(CLICKED, BELT_CFG, {
      invoke: () => Promise.resolve(null),
      sendInput: (b) => sent.push(b),
      run: [{ id: CLICKED, ticksPerSlot: 4 }],
    });
    expect(Array.from(sent[0])).toEqual([0xfe, 1, 12, 10]);
  });

  it('the frame carries the run handles, NOT the clicked node handle', async () => {
    // The clicked handle is absent from the run entirely - a shape the real app
    // does not produce, asserted here because it is the only arrangement in
    // which "it sent the run" and "it sent the clicked belt" cannot both be
    // true of the same bytes.
    const sent: Uint8Array[] = [];
    await commitConfig(99, BELT_CFG, {
      invoke: () => Promise.resolve(null),
      sendInput: (b) => sent.push(b),
      run: RUN,
    });
    expect(Array.from(sent[0])).toEqual([0xfe, 3, 11, 12, 13, 10]);
  });
});

describe('the Belt branch declines the two frames the host must refuse (68-REVIEW WR-03)', () => {
  const BELT_CFG: MachineConfig = { kind: 'Belt', ticks_per_slot: 10 };
  const entry = (id: number): BeltRunEntry => ({ id, ticksPerSlot: 4 });
  const runOf = (n: number): BeltRunEntry[] =>
    Array.from({ length: n }, (_, i) => entry(100 + i));

  it('beltRunDispatchable says nothing about a non-Belt config', () => {
    // The predicate is only about the run-pace frame. A Sink with an empty run
    // is the ORDINARY case (App passes NO_RUN for every non-belt selection), and
    // reading it as undispatchable would disable Apply on every panel in the app.
    expect(beltRunDispatchable(SINK_CFG, [])).toBe(true);
    expect(beltRunDispatchable(FACTORY_CFG, [])).toBe(true);
    expect(beltRunDispatchable(null, [])).toBe(true);
  });

  it('an EMPTY run is not dispatchable, and an over-cap one is not either', () => {
    expect(beltRunDispatchable(BELT_CFG, [])).toBe(false);
    expect(beltRunDispatchable(BELT_CFG, [entry(11)])).toBe(true);
    // The boundary, both sides of it. The cap is the wire's, not this file's:
    // `MAX_RUN_PACE_BELTS` is parsed out of decode.ts and pinned to the Rust
    // constant by `crates/fabrico-host/tests/pace_scale_pin.rs`.
    expect(beltRunDispatchable(BELT_CFG, runOf(MAX_RUN_PACE_BELTS))).toBe(true);
    expect(beltRunDispatchable(BELT_CFG, runOf(MAX_RUN_PACE_BELTS + 1))).toBe(false);
  });

  it('commitConfig on an EMPTY run sends NOTHING and reports no reason', async () => {
    // `beltRun` answers `[]` while the clicked belt is out of the scene. Without
    // this guard the branch emits a zero-belt frame, which `apply_run_pace`
    // refuses as Malformed - and the user reads "The host could not read that
    // gesture." (since plan 88-02) for a press on a panel that is still showing a config.
    const sent: Uint8Array[] = [];
    const res = await commitConfig(12, BELT_CFG, {
      invoke: () => Promise.resolve(null),
      sendInput: (b) => sent.push(b),
      run: [],
    });
    expect(res).toEqual({ dispatched: false, error: null });
    expect(sent).toHaveLength(0);
  });

  it('commitConfig on an OVER-CAP run sends NOTHING and reports no reason', async () => {
    const sent: Uint8Array[] = [];
    const res = await commitConfig(12, BELT_CFG, {
      invoke: () => Promise.resolve(null),
      sendInput: (b) => sent.push(b),
      run: runOf(MAX_RUN_PACE_BELTS + 1),
    });
    expect(res).toEqual({ dispatched: false, error: null });
    expect(sent).toHaveLength(0);
  });

  it('commitConfig AT the cap still dispatches - the guard is a ceiling, not a fence', async () => {
    // The anti-overreach case. A guard written `>=` instead of `>` would refuse
    // the largest run the host actually accepts, and nothing else in the tree
    // would notice.
    const sent: Uint8Array[] = [];
    const res = await commitConfig(100, BELT_CFG, {
      invoke: () => Promise.resolve(null),
      sendInput: (b) => sent.push(b),
      run: runOf(MAX_RUN_PACE_BELTS),
    });
    expect(res).toEqual({ dispatched: true, error: null });
    expect(sent).toHaveLength(1);
  });

  it('Apply is DISABLED on a dirty Belt panel whose run is empty or over-cap', () => {
    const applyOf = (props: Partial<ConfigPanelViewProps>): El =>
      findAll(
        ConfigPanelView(baseView({ kind: machine_kind.BELT, config: BELT_CFG, dirty: true, ...props })),
        (el) => el.type === 'button' && textOf(el) === 'Apply',
      )[0];
    // The control states the constraint, rather than the host's causeless
    // refusal stating it after the press.
    expect(applyOf({ run: [] }).props.disabled).toBe(true);
    expect(applyOf({ run: runOf(MAX_RUN_PACE_BELTS + 1) }).props.disabled).toBe(true);
    // ...and stays live on an ordinary run, which is the half that stops this
    // guard from quietly disabling Apply on every belt in the app.
    expect(applyOf({ run: [entry(11)] }).props.disabled).toBe(false);
    expect(applyOf({ run: runOf(3) }).props.disabled).toBe(false);
    expect(applyOf({ run: runOf(MAX_RUN_PACE_BELTS) }).props.disabled).toBe(false);
  });

  it('Revert stays live on an undispatchable run - discarding a buffer needs no host', () => {
    const tree = ConfigPanelView(
      baseView({ kind: machine_kind.BELT, config: BELT_CFG, dirty: true, run: [] }),
    );
    const revert = findAll(tree, (el) => el.type === 'button' && textOf(el) === 'Revert')[0];
    expect(revert.props.disabled).toBe(false);
  });
});

describe('reasonOf — invoke rejection normalisation', () => {
  it('handles string, Error, and object shapes', () => {
    expect(reasonOf('boom')).toBe('boom');
    expect(reasonOf(new Error('nope'))).toBe('nope');
    expect(reasonOf({ message: 'obj' })).toBe('obj');
  });
});

describe('ConfigPanel — skin-not-skeleton source discipline', () => {
  // Strip // line + /* */ block comments so the discipline checks measure real
  // CODE, not the prose in a doc comment (which legitimately names the anti-patterns).
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const files = [
    'ConfigPanel.tsx',
    'SourceConfigBody.tsx',
    'SinkConfigBody.tsx',
    'WebhookUrlRow.tsx',
    'FactoryConfigBody.tsx',
  ].map((f) => stripComments(readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')));

  it('contains NO hand-authored hex colour (every colour is a --fab-* token)', () => {
    for (const src of files) {
      const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g);
      expect(hex, `unexpected hex literal(s): ${hex?.join(', ')}`).toBeNull();
    }
  });

  it('is purely presentational — no window.__fabrico introspection, no gesture controller', () => {
    for (const src of files) {
      expect(src).not.toContain('window.__fabrico');
      expect(src).not.toContain('gesturesRef');
    }
  });
});

// ---------------------------------------------------------------------------
// SERVE-03 / R-69 (72-10): the HTTP Handler card, and the editor label that had to
// move to make room for its name.
// ---------------------------------------------------------------------------

describe('ConfigPanelView - the HTTP Handler card (SERVE-03)', () => {
  // A HANDLER folds to `Node::Factory`, so it answers `machine_config` with the
  // FACTORY variant. That is exactly why the label below cannot be chosen from the
  // config: the variant is identical for both machines and only `kind` can tell them
  // apart.
  const HANDLER_SRC: MachineConfig = {
    kind: 'Factory',
    source: 'export default function (input, ctx) {}',
  };

  it('heads the card "HTTP Handler", from the ONE folded name map', () => {
    const tree = ConfigPanelView(baseView({ kind: machine_kind.HANDLER, config: HANDLER_SRC }));
    expect(textOf(findAll(tree, (el) => el.type === 'h2')[0])).toContain('HTTP Handler');
  });

  it('labels the editor "Handler (JS)" on a HANDLER - the established word, unchanged', () => {
    const tree = ConfigPanelView(baseView({ kind: machine_kind.HANDLER, config: HANDLER_SRC }));
    const body = findAll(tree, (el) => el.type === FactoryConfigBody);
    expect(body).toHaveLength(1);
    expect(body[0].props.label).toBe(FACTORY_EDITOR_LABELS.handler);
    expect(body[0].props.label).toBe('Handler (JS)');
  });

  it('labels the editor "Transform (JS)" on a plain FACTORY (R-69)', () => {
    // THE DEFECT THIS CLOSES, stated as the assertion: with `Handler` now the name of
    // a MACHINE in the palette, one word named two things. The noun comes from the
    // Palette's own shipped Factory line, `Transforms items (runs your code)`, rather
    // than from a word invented for the label.
    const tree = ConfigPanelView(baseView({ kind: machine_kind.FACTORY, config: FACTORY_CFG }));
    const body = findAll(tree, (el) => el.type === FactoryConfigBody);
    expect(body).toHaveLength(1);
    expect(body[0].props.label).toBe(FACTORY_EDITOR_LABELS.factory);
    expect(body[0].props.label).toBe('Transform (JS)');
  });

  it('gives the two machines DIFFERENT labels, which is the whole point of the prop', () => {
    // Not a restatement of the two above. They each pin one string; this one pins the
    // relation, so a future edit that made both labels the same again fails here even
    // if it moved both pins together.
    expect(FACTORY_EDITOR_LABELS.factory).not.toBe(FACTORY_EDITOR_LABELS.handler);
  });
});

// ---------------------------------------------------------------------------
// 72-UI-SPEC 8.4: port row labels are VERIFIED, NEVER AUTHORED.
//
// `portLabels.ts` already maps medium 1 to `Wire`, and `PortsSection` already nests
// a role-2 port under the `Outputs` header. These cases assert what the SHIPPED
// pipeline renders for the two new machines' port lists. They deliberately do NOT
// write the strings into the panel: a string authored here and asserted here would
// be a check that cannot fail.
// ---------------------------------------------------------------------------

describe('ConfigPanelView - the Route and Handler port rows (verified, not authored)', () => {
  const port = (index: number, role: number, medium: number): PortView => ({
    index,
    cell_x: 10 + index,
    cell_y: 6,
    side: role === 0 ? 3 : 1,
    role,
    medium,
  });
  /** The Route's shipped catalog shape: In/Electrical at 0, Out/Electrical at 1. */
  const ROUTE_PORTS: PortView[] = [port(0, 0, 1), port(1, 1, 1)];
  /** The Handler's, per D-03: the same two plus a MECHANICAL Fault at 2. */
  const HANDLER_PORTS: PortView[] = [...ROUTE_PORTS, port(2, 2, 0)];

  /**
   * The text `PortsSection` really renders when the panel mounts it with these props.
   *
   * TWO STEPS ON PURPOSE. `ConfigPanelView` returns element DESCRIPTORS, so a child
   * component's body is not executed by walking the panel's tree - `textOf` over the
   * panel would report an empty port list for ANY props and every assertion below
   * would pass against a panel that rendered nothing at all. So step one reads the
   * props the panel actually hands the section, and step two INVOKES the shipped
   * section with exactly those props (it is hook-free, the same direct-invocation
   * discipline `PortsSection.test.tsx` uses).
   */
  const portRowText = (over: Partial<ConfigPanelViewProps>): string => {
    const sections = findAll(ConfigPanelView(baseView(over)), (el) => el.type === PortsSection);
    expect(sections, 'the panel mounts exactly one PortsSection').toHaveLength(1);
    return textOf(PortsSection(sections[0].props as unknown as PortsSectionProps));
  };

  it('reads Input - Wire and Output - Wire on a Route, from the shipped portRowLabel', () => {
    const text = portRowText({
      kind: machine_kind.ENDPOINT,
      config: { kind: 'Endpoint', path: '/route-42' },
      ports: ROUTE_PORTS,
    });
    // DERIVED from the shipped label function, never transcribed: this asserts the
    // panel and `portLabels.ts` agree, which a hand-typed literal could not.
    expect(text).toContain(portRowLabel(ROUTE_PORTS[0]));
    expect(text).toContain(portRowLabel(ROUTE_PORTS[1]));
    // AND the values those calls produce, pinned once so a silent change to the label
    // function is visible here rather than absorbed by the derivation above.
    expect(portRowLabel(ROUTE_PORTS[0])).toBe('Input - Wire');
    expect(portRowLabel(ROUTE_PORTS[1])).toBe('Output - Wire');
  });

  it('adds Fault - Item on a Handler, nested under Outputs by the shipped section', () => {
    const text = portRowText({
      kind: machine_kind.HANDLER,
      config: { kind: 'Factory', source: '' },
      ports: HANDLER_PORTS,
    });
    for (const p of HANDLER_PORTS) expect(text).toContain(portRowLabel(p));
    expect(portRowLabel(HANDLER_PORTS[2])).toBe('Fault - Item');
    // The Fault row is under Outputs, which `PortsSection` already decides. Asserted
    // as ORDER in the flattened text rather than restated as structure the section
    // owns: `Outputs` must appear before the fault row's label.
    expect(text.indexOf('Outputs')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Outputs')).toBeLessThan(text.indexOf(portRowLabel(HANDLER_PORTS[2])));
  });

  it('ANTI-VACUITY: the two-step helper really renders rows, so an empty list fails', () => {
    // Without this, every assertion above would pass against a section that rendered
    // nothing - which is exactly what walking the panel's own tree does, and is why
    // the helper invokes the section instead.
    const text = portRowText({
      kind: machine_kind.ENDPOINT,
      config: { kind: 'Endpoint', path: '/route-42' },
      ports: [],
    });
    expect(text).not.toContain('Input - Wire');
    expect(text).toContain('Inputs');
  });
});

// ---------------------------------------------------------------------------
// LINK-09 - the belt panel's ports section, its two rows, and the Disconnect
// encode that names the LINK'S TARGET SIDE rather than the panel's own subject.
//
// 74-UI-SPEC 4.1-4.4. Until this phase `ConfigPanel.tsx` gated `PortsSection`
// off for a BELT entirely, so LINK-06's shipped refusal sentence
// (`That output is already connected. Disconnect it first.`) named a control
// that did not exist on a belt panel and the locator resolved to nothing.
// ---------------------------------------------------------------------------

describe('ConfigPanelView - the belt panel has two port rows (LINK-09, UI-SPEC 4.1)', () => {
  const BELT_CFG: MachineConfig = { kind: 'Belt', ticks_per_slot: 10 };

  /** Straight-X tiles from (x0,y) to (x1,y) inclusive - the minimum geometry
   *  `beltEndPort` needs to resolve an outward side. */
  const tilesX = (x0: number, x1: number, y: number): TileView[] => {
    const out: TileView[] = [];
    for (let x = x0; x <= x1; x += 1) out.push({ cell_x: x, cell_y: y, kind: { Straight: { axis: 0 } } });
    return out;
  };

  const beltView = (over: Partial<BeltView> & { id: number }): BeltView => ({
    latency: 0,
    fill: 0,
    items: [],
    tiles: tilesX(0, 2, 0),
    docks: [],
    ticks_per_slot: 10,
    ...over,
  });

  /** The joined pair the manual walk builds: belt A (upstream) delivers into belt B
   *  (downstream). ONE link, `(A,0) -> (B,0)`, seen from both sides:
   *  A carries a Head dock naming B, B carries a Tail dock naming A. */
  const A = beltView({ id: 60, tiles: tilesX(0, 2, 0), docks: [{ end: 'Head', node: 61, port: 0 }], items: [{ arrival_tick: 1, tag: 0 }] });
  const B = beltView({ id: 61, tiles: tilesX(3, 5, 0), docks: [{ end: 'Tail', node: 60, port: 0 }], items: [{ arrival_tick: 1, tag: 0 }, { arrival_tick: 2, tag: 0 }] });
  const JOINED = new Map<number, BeltView>([[60, A], [61, B]]);

  /** The panel's belt props for a selected belt, built the way App builds them. */
  const beltProps = (belt: BeltView, belts: ReadonlyMap<number, BeltView>, over: Partial<ConfigPanelViewProps> = {}): Partial<ConfigPanelViewProps> => {
    const rows = beltPortRows(belt, beltsOnly(belts));
    return {
      kind: machine_kind.BELT,
      node: belt.id,
      config: BELT_CFG,
      ports: rows.ports,
      flow: rows.flow,
      run: [{ id: belt.id, ticksPerSlot: belt.ticks_per_slot }],
      // `baseView` deliberately omits `onDisconnect` (the pre-CONNECT-01 default).
      // App always supplies it, and without it `PortsSection` renders no control on
      // ANY kind - so a belt fixture that forgot it would assert the absence of a
      // button for the wrong reason entirely.
      onDisconnect: () => {},
      ...over,
    };
  };

  /** The two-step reader from the Route/Handler block above: the panel returns
   *  element DESCRIPTORS, so the shipped section must be INVOKED with the props
   *  the panel really hands it or every assertion here passes against nothing. */
  const sectionOf = (over: Partial<ConfigPanelViewProps>): PortsSectionProps | null => {
    const sections = findAll(ConfigPanelView(baseView(over)), (el) => el.type === PortsSection);
    if (sections.length === 0) return null;
    expect(sections, 'the panel mounts at most one PortsSection').toHaveLength(1);
    return sections[0].props as unknown as PortsSectionProps;
  };
  const sectionText = (over: Partial<ConfigPanelViewProps>): string => {
    const props = sectionOf(over);
    expect(props, 'the belt panel mounts a PortsSection').not.toBeNull();
    return textOf(PortsSection(props as PortsSectionProps));
  };

  it('synthesises exactly TWO rows: Tail In at index 0, Head Out at index 1', () => {
    const { ports } = beltPortRows(A, beltsOnly(JOINED));
    expect(ports).toHaveLength(2);
    // The order is a CONTRACT, not a convenience: `command.rs` warns that an Out
    // declared before an In mis-keys every Head dock into the wrong inbox, and a
    // panel listing them the other way teaches a false model of the same order.
    expect(ports[0].index).toBe(BELT_PORT_TAIL);
    expect(ports[0].role).toBe(PORT_ROLE.IN);
    expect(ports[0].medium).toBe(MEDIUM_MECHANICAL);
    expect(ports[1].index).toBe(BELT_PORT_HEAD);
    expect(ports[1].role).toBe(PORT_ROLE.OUT);
    expect(ports[1].medium).toBe(MEDIUM_MECHANICAL);
  });

  it('the rows read Input - Item and Output - Item, from the shipped portRowLabel', () => {
    const { ports } = beltPortRows(A, beltsOnly(JOINED));
    // DERIVED from the shipped label function, then the values it produces pinned
    // once - so a silent change to either is visible here.
    expect(portRowLabel(ports[0])).toBe('Input - Item');
    expect(portRowLabel(ports[1])).toBe('Output - Item');
    const text = sectionText(beltProps(A, JOINED));
    expect(text).toContain('Input - Item');
    expect(text).toContain('Output - Item');
    // Under the right headers, asserted as ORDER in the flattened text.
    expect(text.indexOf('Inputs')).toBeLessThan(text.indexOf('Input - Item'));
    expect(text.indexOf('Outputs')).toBeLessThan(text.indexOf('Output - Item'));
    expect(text.indexOf('Input - Item')).toBeLessThan(text.indexOf('Outputs'));
  });

  it('never renders the shipped None row on a belt, not even on a wholly undocked one', () => {
    // D-06 gives every belt BOTH port records, geometry-empty ones included, so
    // the empty-group path is unreachable on a belt by construction.
    const lonely = beltView({ id: 70, docks: [] });
    const belts = new Map<number, BeltView>([[70, lonely]]);
    expect(sectionText(beltProps(lonely, belts))).not.toContain(EMPTY_GROUP_LABEL);
    expect(sectionText(beltProps(A, JOINED))).not.toContain(EMPTY_GROUP_LABEL);
    // A geometry-empty (Wire-minted) belt still gets both rows.
    const bare = beltView({ id: 71, tiles: [], docks: [] });
    expect(beltPortRows(bare, beltsOnly(new Map([[71, bare]]))).ports).toHaveLength(2);
    expect(sectionText(beltProps(bare, new Map([[71, bare]])))).not.toContain(EMPTY_GROUP_LABEL);
  });

  it('grows no + Add output and no per-row Remove on a belt', () => {
    const text = sectionText(beltProps(A, JOINED));
    expect(text).not.toContain(ADD_OUTPUT_LABEL);
    expect(text).not.toContain('Remove output');
  });

  it('renders NO Disconnect control while the machine_config round trip is loading', () => {
    // T-74-35: no control exists to click against a stale port index.
    expect(sectionOf(beltProps(A, JOINED, { loading: true, config: null }))).toBeNull();
    // ANTI-VACUITY: the identical props with `loading: false` DO render one.
    expect(sectionText(beltProps(A, JOINED))).toContain(DISCONNECT_LABEL);
  });

  it('a row whose role byte this build predates renders the fallback and does not throw', () => {
    // T-74-34: the row renderer is shared with machine rows that CAN carry an
    // unknown byte, and a throw inside a React render takes the panel out.
    const odd: PortView = { index: 0, cell_x: 0, cell_y: 0, side: 0, role: 99, medium: 99 };
    expect(portRowLabel(odd)).toBe('Output - Item');
    const props = sectionOf({ kind: machine_kind.BELT, node: 60, config: BELT_CFG, ports: [odd], flow: new Map(), run: [] });
    expect(props).not.toBeNull();
    expect(() => PortsSection(props as PortsSectionProps)).not.toThrow();
    expect(textOf(PortsSection(props as PortsSectionProps))).toContain('Output - Item');
  });

  it('the belt panel is heading, BeltConfigBody, PortsSection, error row, Apply/Revert', () => {
    const tree = ConfigPanelView(baseView(beltProps(A, JOINED, { error: 'boom' })));
    const flat = textOf(tree);
    expect(flat.indexOf('Belt')).toBeGreaterThanOrEqual(0);
    const bodies = findAll(tree, (el) => el.type === BeltConfigBody);
    const sections = findAll(tree, (el) => el.type === PortsSection);
    expect(bodies).toHaveLength(1);
    expect(sections).toHaveLength(1);
    expect(flat.indexOf('boom')).toBeLessThan(flat.indexOf('Apply'));
  });

  it('ANTI-VACUITY: the two-step reader really renders rows', () => {
    const empty = sectionOf({ kind: machine_kind.BELT, node: 60, config: BELT_CFG, ports: [], flow: new Map(), run: [] });
    expect(empty).not.toBeNull();
    const text = textOf(PortsSection(empty as PortsSectionProps));
    expect(text).not.toContain('Input - Item');
    expect(text).toContain(EMPTY_GROUP_LABEL);
  });

  // Phase 89 red-first probe (plan 89-01, D-01): written at PHASE89_START and seen red there behind
  // the red-first gate; plan 89-06 turned it on (the gate and the title suffix went, the body did not
  // change), so it now runs in every `npm test`.

  it(
    'a_belt_panel_offers_delete_belt',
    () => {
      // BELT-02 (D-07): a belt's panel offers a `Delete belt` control (id `fab-belt-delete`) wired to
      // the `onDeleteBelt` intent App passes; one click calls it once. Written at PHASE89_START with
      // the prop passed through a cast; plan 89-06 made it a typed prop, and the review pass took the
      // cast out. Function components in the returned tree are rendered (the panel returns
      // descriptors), so the control is found wherever in the panel it is placed.
      let calls = 0;
      const over: Partial<ConfigPanelViewProps> = { ...beltProps(A, JOINED), onDeleteBelt: () => { calls += 1; } };
      const found: El[] = [];
      let rows = 0;
      const deep = (n: unknown): void => {
        walk(n, (el) => {
          if (el.props.id === 'fab-belt-delete') {
            found.push(el);
          }
          if (el.props.role === 'listitem') {
            rows += 1;
          }
          if (typeof el.type === 'function') {
            try {
              deep((el.type as (p: unknown) => unknown)(el.props));
            } catch {
              // A component that needs React's hooks is not rendered here; none in the belt panel does.
            }
          }
        });
      };
      deep(ConfigPanelView(baseView(over)));
      console.log(`P89-BELT-02-panel rows=${rows} found=${found.length} names=${JSON.stringify(found.map((el) => [el.type, textOf(el), el.props['aria-label']]))}`);
      expect(rows, 'NON-VACUITY: the deep render reaches the port rows (role listitem) PortsSection draws').toBeGreaterThan(0);
      expect(found, 'ONE control with id fab-belt-delete').toHaveLength(1);
      expect(found[0].type, 'a button').toBe('button');
      expect(`${textOf(found[0])} ${String(found[0].props['aria-label'] ?? '')}`, 'named Delete belt').toContain('Delete belt');
      (found[0].props.onClick as () => void)();
      expect(calls, 'one click calls onDeleteBelt once').toBe(1);
    },
  );

  it('the Delete belt button is the last child of the scroll column, only for a belt, and not gated on loading or dirty (UI-SPEC 2.1)', () => {
    // A1: the LAST child of `data-fab-panel-scroll`, after the Apply / Revert row and the Applied
    // status, its own width (`alignSelf: flex-start`) and 16px of margin above it; a
    // `.fab-tool-btn`, neutral, with the trash glyph and the words. Rendered while loading (no
    // config yet) and while dirty, because deleting needs no config. A machine panel, handed the
    // same intent by a careless caller, still has no such button.
    const onDeleteBelt = (): void => {};
    const scrollOf = (view: unknown): El => {
      const cols = findAll(view, (el) => el.props['data-fab-panel-scroll'] === '');
      expect(cols, 'one scroll column').toHaveLength(1);
      return cols[0];
    };
    const lastChild = (col: El): unknown => {
      const kids = (Array.isArray(col.props.children) ? col.props.children : [col.props.children]).flat(Infinity);
      return kids.filter((k: unknown) => k !== null && k !== undefined && k !== false && k !== true).at(-1);
    };
    for (const over of [{}, { loading: true, config: null }, { dirty: true, applied: true }] as Array<Partial<ConfigPanelViewProps>>) {
      const view = ConfigPanelView(baseView(beltProps(A, JOINED, { onDeleteBelt, ...over })));
      const last = lastChild(scrollOf(view)) as El;
      expect(isEl(last) && last.props.id, `${JSON.stringify(over)}: the last child is the Delete belt button`).toBe('fab-belt-delete');
      expect(last.type).toBe('button');
      expect(last.props.type).toBe('button');
      expect(hasClass(last, 'fab-tool-btn'), 'the shipped neutral button class').toBe(true);
      expect(last.props.title, 'title equals the visible label').toBe('Delete belt');
      expect(textOf(last)).toBe('Delete belt');
      expect(findAll(last, (el) => el.type === TrashIcon), 'the trash glyph').toHaveLength(1);
      expect(last.props.style).toEqual({ alignSelf: 'flex-start', marginTop: 'var(--fab-space-md)' });
      expect(last.props.disabled, 'never disabled').toBeUndefined();
      expect(last.props.onClick).toBe(onDeleteBelt);
    }
    const machine = ConfigPanelView(baseView({ onDeleteBelt }));
    expect(findAll(machine, (el) => el.props.id === 'fab-belt-delete'), 'a machine panel has no Delete belt button').toHaveLength(0);
  });
});

describe('disconnectCommand - the encode names the LINK\'S TARGET SIDE (LINK-09, UI-SPEC 4.3)', () => {
  const tilesX = (x0: number, x1: number, y: number): TileView[] => {
    const out: TileView[] = [];
    for (let x = x0; x <= x1; x += 1) out.push({ cell_x: x, cell_y: y, kind: { Straight: { axis: 0 } } });
    return out;
  };
  const beltView = (over: Partial<BeltView> & { id: number }): BeltView => ({
    latency: 0, fill: 0, items: [], tiles: tilesX(0, 2, 0), docks: [], ticks_per_slot: 10, ...over,
  });
  const A = beltView({ id: 60, tiles: tilesX(0, 2, 0), docks: [{ end: 'Head', node: 61, port: 0 }] });
  const B = beltView({ id: 61, tiles: tilesX(3, 5, 0), docks: [{ end: 'Tail', node: 60, port: 0 }] });
  const JOINED = new Map<number, BeltView>([[60, A], [61, B]]);

  /** The encode a press on `belt`'s row at `index` produces, or null when the
   *  row carries no link (no control renders at all in that case). */
  const encodeFor = (belt: BeltView, index: number) => {
    const { ports, flow } = beltPortRows(belt, beltsOnly(JOINED));
    const port = ports.find((p) => p.index === index);
    expect(port, 'the row exists').toBeDefined();
    const link = flow.get(index)?.link;
    if (link === undefined) return null;
    return disconnectCommand(belt.id, port as PortView, link);
  };

  it('the Outputs row on the UPSTREAM belt names the OTHER belt, not the panel subject', () => {
    const cmd = encodeFor(A, BELT_PORT_HEAD);
    expect(cmd).toEqual({ kind: 'Unlink', belt: 60, end: 'Head', node: 61, port: 0 });
  });

  it('the Inputs row on the DOWNSTREAM belt names the panel\'s own subject', () => {
    const cmd = encodeFor(B, BELT_PORT_TAIL);
    expect(cmd).toEqual({ kind: 'Unlink', belt: 60, end: 'Head', node: 61, port: 0 });
  });

  it('one link has ONE identity: the two presses are field-for-field identical', () => {
    const fromUpstream = encodeFor(A, BELT_PORT_HEAD);
    const fromDownstream = encodeFor(B, BELT_PORT_TAIL);
    expect(fromUpstream).not.toBeNull();
    expect(fromDownstream).not.toBeNull();
    expect(fromUpstream).toEqual(fromDownstream);
    // And on the WIRE, which is what the host actually reads.
    expect(Array.from(encodeGridCommand(fromUpstream as never))).toEqual(
      Array.from(encodeGridCommand(fromDownstream as never)),
    );
  });

  it('a MACHINE port row still names the panel\'s selected machine handle', () => {
    // The half that was already right. A fix that made BOTH halves name the
    // target side would break every machine Disconnect, and only this case
    // catches it: a machine row's link carries no target.
    const port: PortView = { index: 3, cell_x: 4, cell_y: 4, side: 1, role: 0, medium: 0 };
    expect(disconnectCommand(42, port, { kind: 'belt', belt: 7, end: 'Head' })).toEqual({
      kind: 'Unlink', belt: 7, end: 'Head', node: 42, port: 3,
    });
  });

  it('a WIRE link is still a Delete naming the wire node (D1, unchanged)', () => {
    const port: PortView = { index: 1, cell_x: 4, cell_y: 4, side: 1, role: 1, medium: 1 };
    expect(disconnectCommand(42, port, { kind: 'wire', wire: 9 })).toEqual({ kind: 'Delete', node: 9 });
  });

  it('a one-belt RING resolves through the ordinary path and is still symmetric', () => {
    // A ring is representable in a save (`beltRun.ts` fact 3), so the belt whose
    // Head docks into its own Tail is a real board and not a forged one. Both rows
    // name the same single link, which is what says no self-dock special case is
    // owed here.
    const ring = { id: 64, latency: 0, fill: 0, items: [], tiles: tilesX(9, 11, 0), ticks_per_slot: 10,
      docks: [{ end: 'Head' as const, node: 64, port: 0 }, { end: 'Tail' as const, node: 64, port: 0 }] };
    const { ports, flow } = beltPortRows(ring, beltsOnly(new Map([[64, ring]])));
    const expected = { kind: 'Unlink', belt: 64, end: 'Head', node: 64, port: 0 };
    const at = (index: number) =>
      disconnectCommand(64, ports.find((p) => p.index === index) as PortView, flow.get(index)?.link as never);
    expect(at(BELT_PORT_HEAD)).toEqual(expected);
    expect(at(BELT_PORT_TAIL)).toEqual(expected);
  });

  it('a MACHINE upstream offers no Disconnect on the Inputs row, and that is not a gap', () => {
    // The target side would be that machine's `Out`, and a Tail dock records an Out
    // ROUTING key, not the spatial catalog index `Unlink` carries. Deriving one from
    // the other needs a reverse map - the Pitfall-6 keyspace bug that TYPECHECKS -
    // so the row fails closed instead. Nothing is unreachable: that link's
    // Disconnect is on the machine's own port row, where it has always been.
    const fed = { id: 63, latency: 0, fill: 0, items: [], tiles: tilesX(6, 8, 0), ticks_per_slot: 10,
      docks: [{ end: 'Tail' as const, node: 900, port: 0 }] };
    const { flow } = beltPortRows(fed, beltsOnly(new Map([[63, fed]])));
    expect(flow.get(BELT_PORT_TAIL)?.docked, 'the end still READS as docked').toBe(true);
    expect(flow.get(BELT_PORT_TAIL)?.link).toBeUndefined();
    // CONTRAST, so this is not green merely because nothing ever resolves a link:
    // the identical shape with a BELT upstream DOES carry one.
    expect(beltPortRows(B, beltsOnly(JOINED)).flow.get(BELT_PORT_TAIL)?.link).toEqual({
      kind: 'belt', belt: 60, end: 'Head',
    });
  });

  it('a FAN-IN Tail offers no Disconnect rather than guessing which upstream', () => {
    // 74-04's handover landing here. `belt_docks` reports EVERY upstream, so a
    // downstream belt fed by two carries two Tail docks and there is no honest
    // single link for one row to name. A find-first would destroy a link the
    // user did not point at (T-74-33). Fail closed, exactly as `beltSeamPoint`
    // does at the same ambiguity. The upstream Heads stay unambiguous.
    const j = { id: 62, latency: 0, fill: 0, items: [], tiles: tilesX(6, 8, 0), ticks_per_slot: 10,
      docks: [{ end: 'Tail' as const, node: 60, port: 0 }, { end: 'Tail' as const, node: 61, port: 0 }] };
    // BOTH upstreams are IN the scene map, so the AMBIGUITY is the only rule that
    // can refuse here. The first version of this case passed with the ambiguity
    // rule DELETED, because the fixture's map held only the junction belt and the
    // belt-neighbour guard refused it instead - a check that could not fail, found
    // by mutation and rewritten rather than kept.
    const fanIn = new Map<number, BeltView>([[60, A], [61, B], [62, j]]);
    const { flow } = beltPortRows(j, beltsOnly(fanIn));
    expect(flow.get(BELT_PORT_TAIL)?.docked).toBe(true);
    expect(flow.get(BELT_PORT_TAIL)?.link).toBeUndefined();
    // CONTRAST on the SAME map: drop to ONE upstream and the link resolves, so
    // this is not green merely because nothing on this board ever resolves one.
    const one = { ...j, docks: [{ end: 'Tail' as const, node: 60, port: 0 }] };
    expect(beltPortRows(one, beltsOnly(fanIn)).flow.get(BELT_PORT_TAIL)?.link).toEqual({
      kind: 'belt', belt: 60, end: 'Head',
    });
  });
});

describe('ConfigPanelView - what the belt panel reads after a Disconnect (UI-SPEC 4.4)', () => {
  const BELT_CFG: MachineConfig = { kind: 'Belt', ticks_per_slot: 10 };
  const tilesX = (x0: number, x1: number, y: number): TileView[] => {
    const out: TileView[] = [];
    for (let x = x0; x <= x1; x += 1) out.push({ cell_x: x, cell_y: y, kind: { Straight: { axis: 0 } } });
    return out;
  };
  const beltView = (over: Partial<BeltView> & { id: number }): BeltView => ({
    latency: 0, fill: 0, items: [], tiles: tilesX(0, 2, 0), docks: [], ticks_per_slot: 10, ...over,
  });

  const JOINED_A = beltView({ id: 60, docks: [{ end: 'Head', node: 61, port: 0 }] });
  const LONE_A = beltView({ id: 60, docks: [] });
  const belts = new Map<number, BeltView>([[60, JOINED_A], [61, beltView({ id: 61, tiles: tilesX(3, 5, 0), docks: [{ end: 'Tail', node: 60, port: 0 }] })]]);

  const view = (belt: BeltView, run: BeltRunEntry[]) => {
    const rows = beltPortRows(belt, beltsOnly(belts));
    return baseView({
      kind: machine_kind.BELT,
      node: belt.id,
      config: BELT_CFG,
      ports: rows.ports,
      flow: rows.flow,
      run,
      onDisconnect: () => {},
    });
  };

  /** The run sentence lives inside `BeltConfigBody`, a CHILD component, and
   *  `ConfigPanelView` returns element DESCRIPTORS - so the body must be INVOKED
   *  with the props the panel really hands it. Walking the panel's own tree would
   *  report an empty string for ANY props, and every assertion below would pass
   *  against a panel that rendered no run line at all. It is hook-free, the same
   *  direct-invocation discipline `BeltConfigBody.test.tsx` uses. */
  const bodyOf = (tree: unknown): unknown => {
    const bodies = findAll(tree, (el) => el.type === BeltConfigBody);
    expect(bodies, 'the belt panel mounts exactly one BeltConfigBody').toHaveLength(1);
    return BeltConfigBody(bodies[0].props as never);
  };

  it('the run sentence returns to the shipped one-belt string after the Disconnect', () => {
    // Exact string EQUALITY, not a substring match, so a build that reworded it
    // fails here rather than passing on a partial match.
    const body = bodyOf(ConfigPanelView(view(LONE_A, [{ id: 60, ticksPerSlot: 10 }])));
    const hits = findAll(body, (el) => textOf(el) === RUN_SINGLE);
    expect(hits.length, `the panel says exactly "${RUN_SINGLE}"`).toBeGreaterThan(0);
    expect(textOf(body)).not.toContain(runPlural(2));
  });

  it('one undo puts the junction back and the sentence returns to the two-belt string', () => {
    expect(runPlural(2)).toBe('This run is 2 belts. Apply sets the pace on all of them.');
    const body = bodyOf(
      ConfigPanelView(view(JOINED_A, [{ id: 60, ticksPerSlot: 10 }, { id: 61, ticksPerSlot: 10 }])),
    );
    const hits = findAll(body, (el) => textOf(el) === runPlural(2));
    expect(hits.length, 'the panel says exactly the plural run sentence').toBeGreaterThan(0);
    expect(textOf(body)).not.toContain(RUN_SINGLE);
  });

  it('the Outputs row still renders and reads Output - Item, and simply loses its button', () => {
    const before = ConfigPanelView(view(JOINED_A, [{ id: 60, ticksPerSlot: 10 }]));
    const after = ConfigPanelView(view(LONE_A, [{ id: 60, ticksPerSlot: 10 }]));
    const sectionText = (tree: unknown): string => {
      const s = findAll(tree, (el) => el.type === PortsSection);
      expect(s).toHaveLength(1);
      return textOf(PortsSection(s[0].props as unknown as PortsSectionProps));
    };
    expect(sectionText(before)).toContain(DISCONNECT_LABEL);
    const post = sectionText(after);
    expect(post).toContain('Output - Item');
    expect(post).not.toContain(DISCONNECT_LABEL);
    // No empty-state copy is authored for the disconnected end.
    expect(post).not.toContain(EMPTY_GROUP_LABEL);
  });
});

// Phase 91 review WR-B-07 (with WR-A-01 and WR-A-02): every seam is described by the belt whose
// items cross it, the same belt a machine's port row reads. The selected belt's Outputs row is
// the selected belt's own state; its Inputs row is the upstream belt's state, or the selected
// belt's own when a machine feeds it (that machine's Out row reads this belt too). Seen on the
// 91-11 walk (91-EVIDENCE.md `### Item 2`): a belt packed against a jammed machine read `idle`
// on both rows while the machine said `backed up`, because a machine neighbour gave presence
// only.
describe("beltPortRows - each row reads the seam's own belt, as a machine's port row does (review WR-B-07)", () => {
  const tilesX = (x0: number, x1: number, y: number): TileView[] => {
    const out: TileView[] = [];
    for (let x = x0; x <= x1; x += 1) out.push({ cell_x: x, cell_y: y, kind: { Straight: { axis: 0 } } });
    return out;
  };
  /** A three-tile belt: twelve slots, so `latency` (the slot count on the wire) is 12. */
  const SLOTS = 12;
  const beltOn = (id: number, slots: number[], docks: BeltView['docks']): BeltView => ({
    id,
    latency: SLOTS,
    fill: slots.length,
    items: slots.map((slot) => ({ arrival_tick: slot, tag: 0 })),
    tiles: tilesX(0, 2, 0),
    docks,
    ticks_per_slot: 10,
  });
  const packed = Array.from({ length: SLOTS }, (_, i) => i);
  const machine = (id: number, state: number, load: number): NodeView => ({
    id,
    kind: machine_kind.TEE,
    cell_x: 10,
    cell_y: 0,
    state,
    w: 2,
    h: 2,
    rot: 0,
    ports: [{ index: 0, cell_x: 10, cell_y: 0, side: 3, role: PORT_ROLE.IN, medium: MEDIUM_MECHANICAL }],
    load,
  });
  const source: NodeView = {
    id: 5,
    kind: machine_kind.SOURCE,
    cell_x: -2,
    cell_y: 0,
    state: state_tag.IDLE,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: -2, cell_y: 0, side: 1, role: PORT_ROLE.OUT, medium: MEDIUM_MECHANICAL }],
    load: 0,
  };
  const lookup = (nodes: NodeView[], belts: BeltView[]): PacketLookup => ({
    nodes: new Map(nodes.map((n) => [n.id, n])),
    belts: new Map(belts.map((b) => [b.id, b])),
  });
  const state = (rows: ReturnType<typeof beltPortRows>, index: number) => {
    const f = rows.flow.get(index);
    return { docked: f?.docked, carrying: f?.carrying, backedUp: f?.backedUp };
  };

  it('a belt packed against a full machine, fed by a Source, reads backed up on both rows (the walk item 2 board)', () => {
    const tee = machine(20, state_tag.BACKED_UP, LOAD_FULL);
    const inlet = beltOn(30, packed, [
      { end: 'Head', node: 20, port: 0 },
      { end: 'Tail', node: 5, port: 0 },
    ]);
    const rows = beltPortRows(inlet, lookup([source, tee], [inlet]));
    expect({ in: state(rows, BELT_PORT_TAIL), out: state(rows, BELT_PORT_HEAD) }).toEqual({
      in: { docked: true, carrying: true, backedUp: true },
      out: { docked: true, carrying: true, backedUp: true },
    });
  });

  it('a branch packed from a machine to open floor reads backed up on its Inputs row', () => {
    const tee = machine(20, state_tag.BACKED_UP, 2);
    const branch = beltOn(31, packed, [{ end: 'Tail', node: 20, port: 0 }]);
    const rows = beltPortRows(branch, lookup([tee], [branch]));
    expect({ in: state(rows, BELT_PORT_TAIL), out: state(rows, BELT_PORT_HEAD) }).toEqual({
      in: { docked: true, carrying: true, backedUp: true },
      out: { docked: false, carrying: false, backedUp: false },
    });
  });

  it('a belt carrying items into a machine that takes them reads moving on both rows', () => {
    const sink = machine(21, state_tag.WORKING, 1);
    const flowing = beltOn(32, [2, 5, 9], [
      { end: 'Head', node: 21, port: 0 },
      { end: 'Tail', node: 5, port: 0 },
    ]);
    const rows = beltPortRows(flowing, lookup([source, sink], [flowing]));
    expect({ in: state(rows, BELT_PORT_TAIL), out: state(rows, BELT_PORT_HEAD) }).toEqual({
      in: { docked: true, carrying: true, backedUp: false },
      out: { docked: true, carrying: true, backedUp: false },
    });
  });

  it("two joined belts agree on their one seam: the upstream belt's Outputs row and the downstream belt's Inputs row", () => {
    const sink = machine(21, state_tag.WORKING, 0);
    const up = beltOn(40, [0, 3, 7], [{ end: 'Head', node: 41, port: 0 }]);
    const down = beltOn(41, [], [
      { end: 'Tail', node: 40, port: 0 },
      { end: 'Head', node: 21, port: 0 },
    ]);
    const scene = lookup([sink], [up, down]);
    const upOut = state(beltPortRows(up, scene), BELT_PORT_HEAD);
    const downIn = state(beltPortRows(down, scene), BELT_PORT_TAIL);
    expect({ upOut, downIn }).toEqual({
      upOut: { docked: true, carrying: true, backedUp: false },
      downIn: { docked: true, carrying: true, backedUp: false },
    });
  });
});
