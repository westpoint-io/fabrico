import { describe, expect, it, vi } from 'vitest';
import { Palette, PaletteToolList, type ArmedTool, type PaletteProps } from './Palette.tsx';
import { machine_kind } from '../protocol/kinds';
import { MEDIUM_ELECTRICAL, MEDIUM_MECHANICAL } from '../protocol/ports';
// WIRE-03 (66-04): the HTTP Endpoint row asserts its GLYPH component by identity
// (that it is the machine-asset icon and not the chrome-glyph one), and reads the
// Merge row's label out of the shared kind-name map rather than retyping it.
import { LabelIcon, MachineGlyphIcon } from './icons.tsx';
import { KIND_NAMES } from './kindNames.ts';
import { SIM_STOPPED_COPY } from './SimStoppedCard.tsx';
// ROUTE-04 (65-06): the behaviour half of the palette-copy lock reaches into the
// panel, because the copy is a promise about what the panel lets a user do.
import { ConfigPanelView, type ConfigPanelViewProps } from './ConfigPanel.tsx';
import {
  RouterConfigBody,
  RouterConfigSection,
  type RouterConfigBodyProps,
} from './RouterConfigBody.tsx';
import { ROLE_OUT } from './PortsSection.tsx';
import type { MachineConfig, PortView } from '../protocol/decode.ts';

// The vitest env is `node` (no DOM, no testing-library - the "zero new packages"
// discipline holds). A React function component is just a function returning a
// plain element tree, so we invoke Palette(props) directly and walk the returned
// tree to assert the ROUTE-06 preset wiring (36-05): the palette lists one Router
// preset row (CHROME-09: its label is the shared kind name), which arms
// machine_kind.ROUTER via onBeginRouterPreset with its medium, keeps the
// copy-stable "Place X" accessible name + a role tooltip, and lights exactly the
// armed preset.

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}

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
 * Every element in the tree in a SINGLE pre-order (document-order) walk. Order
 * assertions compare indices inside ONE such walk rather than doing two
 * independent lookups, so "A is above B" is a real statement about order and not
 * two unrelated existence checks.
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

/** Every button in the tree carrying an aria-label (the placeable-tool surface). */
function allLabelledButtons(node: unknown): string[] {
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isEl(n)) {
      return;
    }
    if (n.type === 'button' && typeof n.props['aria-label'] === 'string') {
      out.push(n.props['aria-label'] as string);
    }
    visit(n.props.children);
  };
  visit(node);
  return out;
}

const baseProps = (over: Partial<PaletteProps> = {}): PaletteProps => ({
  onBeginPlacement: () => {},
  onArmBeltDraw: () => {},
  onArmWireDraw: () => {},
  onBeginRouterPreset: () => {},
  armed: null,
  ...over,
});

describe('Palette Router presets (ROUTE-06, 36-05; pulled to ONE at 72-10 R-64)', () => {
  it('lists the Router as the ONE surviving Router entry', () => {
    // WAS: "lists HTTP Router and the Mechanical preset as the two Router entries". The
    // electrical preset row is PULLED, not renamed and not corrected: nothing ever
    // links a machine's output port into a wire (tick.rs:652-653 creates only the one
    // link), so a Router structurally cannot sit on a request path and there is no
    // true sentence available for it. See `ROUTER_PRESETS` in `Palette.tsx`.
    const tree = Palette(baseProps());
    expect(findByAria(tree, 'button', 'Place Router')).toHaveLength(1);
  });

  it('names the preset row with the shared kind name, as the tag, heading and Legend do (CHROME-09, phase 91 D-09)', () => {
    // The palette was the one surface that said a two-word name for kind 5; the board's
    // name tag, the inspector heading and the Legend row all read `KIND_NAMES[ROUTER]`.
    // The visible span and the accessible name are both pinned, so neither can drift
    // back to a hand-written label on its own.
    const row = findByAria(Palette(baseProps()), 'button', `Place ${KIND_NAMES[machine_kind.ROUTER]}`);
    expect(row, 'one row is named after the shared Router kind name').toHaveLength(1);
    expect(KIND_NAMES[machine_kind.ROUTER]).toBe('Router');
    const spans = walk(row[0]).filter((n) => n.type === 'span');
    const visible = spans.map((n) => n.props.children).filter((c) => typeof c === 'string');
    expect(visible, 'the row shows the shared kind name and nothing else').toEqual([
      KIND_NAMES[machine_kind.ROUTER],
    ]);
  });

  it('offers NO "HTTP Router" row anywhere in the column (the false claim is gone)', () => {
    // THE ASSERTION THAT THE PULL LANDED, and it is stated over the WHOLE rendered
    // column rather than over the presets array, because the row could come back as
    // a hand-written button without touching `ROUTER_PRESETS` at all.
    const labels = allLabelledButtons(Palette(baseProps()));
    expect(labels).not.toContain('Place HTTP Router');
    expect(spansWithText(Palette(baseProps()), 'HTTP Router')).toHaveLength(0);
  });

  it('has no bare generic Router entry: the one Router row is the preset (a router is placed AS a preset)', () => {
    // WAS: the preset row read a longer label, so "no `Place Router`" meant "no bare
    // generic entry". The preset now carries the kind name itself (CHROME-09), so the
    // same claim is stated by behaviour: exactly one row says `Place Router`, and it
    // arms through the preset path, never through plain placement.
    const placed: number[] = [];
    const presets: number[] = [];
    const tree = Palette(
      baseProps({ onBeginPlacement: (k) => placed.push(k), onBeginRouterPreset: (m) => presets.push(m) }),
    );
    const labels = allLabelledButtons(tree);
    expect(labels.filter((l) => l === 'Place Router')).toHaveLength(1);
    (findByAria(tree, 'button', 'Place Router')[0].props.onClick as () => void)();
    expect(presets, 'the Router row arms the preset').toEqual([MEDIUM_MECHANICAL]);
    expect(placed, 'and never the bare placement path').toEqual([]);
  });

  it('arms ROUTER at the preset medium on click (Mechanical)', () => {
    const seen: number[] = [];
    const tree = Palette(baseProps({ onBeginRouterPreset: (m) => seen.push(m) }));
    (findByAria(tree, 'button', 'Place Router')[0].props.onClick as () => void)();
    expect(seen).toEqual([MEDIUM_MECHANICAL]);
  });

  it('carries a role tooltip (not the thin "Place X") on the preset', () => {
    const item = findByAria(Palette(baseProps()), 'button', 'Place Router')[0];
    expect(typeof item.props.title).toBe('string');
    expect(item.props.title as string).not.toMatch(/^Place /);
  });

  it('lights the preset only at ITS medium (IX-03) - the presetMedium clause still discriminates', () => {
    // WAS a two-row test: arm ELECTRICAL, assert the HTTP row lights and the Item row
    // does not. With the HTTP row pulled the same PROPERTY is stated the only way one
    // row can state it - arming the medium this column no longer offers must light
    // NOTHING, and arming the surviving medium must light exactly it.
    //
    // Keeping the discrimination is the point. Dropping to a bare "the Item row
    // lights when a Router is armed" would pass against a Palette that ignored
    // `presetMedium` entirely, which is the clause the original test existed for.
    const armedAt = (presetMedium: number): ArmedTool => ({
      kind: 'machine',
      machineKind: machine_kind.ROUTER,
      presetMedium,
    });

    const lit = Palette(baseProps({ armed: armedAt(MEDIUM_MECHANICAL) }));
    const itemLit = findByAria(lit, 'button', 'Place Router')[0];
    expect(itemLit.props['aria-pressed']).toBe(true);
    expect(itemLit.props.className).toContain('is-armed');

    const dark = Palette(baseProps({ armed: armedAt(MEDIUM_ELECTRICAL) }));
    const itemDark = findByAria(dark, 'button', 'Place Router')[0];
    expect(itemDark.props['aria-pressed'], 'the electrical medium lights no row').toBe(false);
    expect(itemDark.props.className).not.toContain('is-armed');
    expect(
      walk(dark).filter(
        (n) => n.type === 'button' && String(n.props.className ?? '').includes('is-armed'),
      ),
      'nothing in the column lights for a medium the column no longer offers',
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ROUTE-04 (65-06): the anti-drift lock on the Router preset description.
// ---------------------------------------------------------------------------

/** Every element in ONE pre-order walk that carries a string `id` prop. */
function idsIn(node: unknown): string[] {
  return walk(node)
    .filter((n) => typeof n.props.id === 'string')
    .map((n) => n.props.id as string);
}

const OUT_PORT = (index: number, x: number, y: number): PortView => ({
  index,
  cell_x: x,
  cell_y: y,
  side: 1,
  role: ROLE_OUT,
  medium: MEDIUM_MECHANICAL,
});

/**
 * A Router's live packet ports in DEMO SEATING (packet order, which is not visual
 * order). Role byte 0 is In; only `ROLE_OUT` has a shared constant to import.
 */
const ROUTER_PORTS: PortView[] = [
  { index: 0, cell_x: 14, cell_y: 1, side: 3, role: 0, medium: MEDIUM_MECHANICAL },
  OUT_PORT(1, 15, 2),
  OUT_PORT(2, 15, 0),
  OUT_PORT(3, 15, 1),
];

/** The panel-view fixture. Every REQUIRED prop is supplied deliberately (WR-03). */
const basePanel = (over: Partial<ConfigPanelViewProps> = {}): ConfigPanelViewProps => ({
  kind: machine_kind.ROUTER,
  node: 1,
  loading: false,
  config: null,
  dirty: false,
  error: null,
  applied: false,
  ports: ROUTER_PORTS,
  // 74.1-19: REQUIRED; a Router edits no outputs.
  addBlockedByBelt: false,
  flow: new Map(),
  // BELT-01: REQUIRED. Empty - no case in this file is a Belt.
  run: [],
  otherRoutes: [],
  onAddOutput: () => {},
  onRemoveOutput: () => {},
  portEditPending: false,
  portEditStalled: false,
  portEditPendingVisible: false,
  onPortEditReset: () => {},
  playing: true,
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

/**
 * Invoke the panel view for a config, then RESOLVE the Router arm one level.
 *
 * `ConfigPanelView` is a pure function, so its returned tree carries
 * `<RouterConfigSection/>` as an OPAQUE element whose `type` is the function
 * itself - the rules editor's own markup is not in that tree, and a walk for
 * `#fab-router-config` over it would find nothing WHILE STAYING GREEN whatever
 * the panel did. So the arm is resolved deliberately: find the section element
 * the panel mounted and invoke the hook-free body with the props the panel
 * actually handed it.
 *
 * The BODY and not the SECTION, because the section holds the after-a-move focus
 * restore in `useRef`/`useLayoutEffect` and a hook outside a React render throws
 * (`RouterConfigBody.tsx` records that measurement); the section's only other job
 * is to delegate straight to the body.
 *
 * Returns `null` when the panel mounted no Router arm at all, which is exactly
 * what the non-Router negative case has to observe.
 */
function resolveRouterArm(config: MachineConfig | null): unknown {
  const panel = ConfigPanelView(basePanel({ config }));
  const arm = walk(panel).find((n) => n.type === RouterConfigSection);
  return arm === undefined
    ? null
    : RouterConfigBody(arm.props as unknown as RouterConfigBodyProps);
}

/**
 * WHY THE COPY PIN AND THE REACHABILITY ASSERTION LIVE IN ONE BLOCK.
 *
 * Both strings promise the user writes routing rules. That promise is only true
 * while there is somewhere to write them. A test that pinned the two strings and
 * nothing else would stay GREEN with the rules editor deleted from the panel, at
 * which point the copy is false again and no check in the tree reddens - the
 * vacuous-check shape this project has now hit repeatedly, where the guard cannot
 * see the thing it guards.
 *
 * So the reachability clause is not a bonus assertion filed next to the copy: it
 * is the half that samples the CLAIM. Remove the `config.kind === 'Router'` arm
 * from `ConfigPanel.tsx` and this block goes red (mutation-proved, 65-06).
 *
 * The negative case is not optional either. Without it, a panel that rendered the
 * Router arm unconditionally - for a Sink, for a Factory, for anything - would
 * satisfy the positive assertion just as well, and "the editor is reachable for
 * the Router kind" would be a sentence the test never actually tested.
 */
describe('Palette Router copy is tied to the editor that makes it true (ROUTE-04, 65-06)', () => {
  // The copy contract from 65-CONTEXT.md "Palette truth (ROUTE-04)", DUPLICATED
  // here on purpose and never imported from the table it validates - the
  // kindNames.test.ts discipline. An imported contract asserts a string equals
  // itself.
  // WAS a two-row table carrying `'Place HTTP Router': 'Splits requests by rules you
  // write'` alongside the Item row. That verbatim pin is ledger row FR-2's gate-3
  // half and it is retired HERE, in the same commit that pulls the row it pinned:
  // the sentence it protected is a false claim about a machine that cannot sit on a
  // request path (72-10 R-64), so there is nothing left for it to protect.
  const COPY_CONTRACT: Record<string, string> = {
    'Place Router': 'Splits items by rules you write',
  };
  /** U+2014 / U+2013 as escapes, so neither guard can be defeated by its own copy. */
  const EM_DASH_CHAR = '\u2014';
  const EN_DASH_CHAR = '\u2013';

  /** An EMPTY table with no default: exactly what a hand-placed Router starts as. */
  const FRESH_ROUTER: MachineConfig = { kind: 'Router', routes: [], default: null };
  const SINK: MachineConfig = { kind: 'Sink', target: { kind: 'Debug' } };

  it('describes the preset with its contract string, character for character', () => {
    const tree = Palette(baseProps());
    for (const [ariaLabel, description] of Object.entries(COPY_CONTRACT)) {
      const button = findByAria(tree, 'button', ariaLabel);
      expect(button, `preset "${ariaLabel}"`).toHaveLength(1);
      expect(button[0].props.title, `description of "${ariaLabel}"`).toBe(description);
    }
  });

  it('writes neither description with an em dash or an en dash (project copy rule)', () => {
    const tree = Palette(baseProps());
    for (const ariaLabel of Object.keys(COPY_CONTRACT)) {
      const text = findByAria(tree, 'button', ariaLabel)[0].props.title as string;
      expect(text.includes(EM_DASH_CHAR), `"${text}" has no em dash`).toBe(false);
      expect(text.includes(EN_DASH_CHAR), `"${text}" has no en dash`).toBe(false);
    }
  });

  it('reaches the rules editor from the panel for a Router config, so the copy is true', () => {
    // A FRESH Router - empty table, no default - because that is the machine the
    // palette copy is a promise about. If the editor were only reachable for an
    // already-configured Router, the copy would still be false where it is read.
    expect(idsIn(resolveRouterArm(FRESH_ROUTER))).toContain('fab-router-config');
  });

  it('does NOT reach it for a non-Router config, so the assertion above discriminates', () => {
    expect(idsIn(resolveRouterArm(SINK))).not.toContain('fab-router-config');
  });
});

// ---------------------------------------------------------------------------
// CHROME-02 (phase 91, D-03): the palette holds no gesture hint box.
//
// From phase 52 to phase 90 the palette carried a bordered, always-present span between its
// heading and its tool list that pointed at the toolbar Help button. The toolbar `?` button is
// the one way to the gesture list, so the box went (91-MEASURE.md `## CHROME-02`). This test
// states the old pointer's text once, as the value that must not appear, and asserts the column
// goes straight from the heading to the tool list. Seen red at PHASE91_START (91-EVIDENCE.md,
// `D17 case=CHROME-02-unit`).
// ---------------------------------------------------------------------------

/** The text the retired hint box read, stated once as the value that must not appear. */
const RETIRED_HINT_TEXT = 'Gestures: toolbar ? button';

describe('Palette gesture hint (CHROME-02, phase 91 D-03)', () => {
  it('the palette holds no gesture hint box', () => {
    const tree = Palette(baseProps());
    const all = walk(tree);
    expect(
      all.filter((n) => n.type === 'span' && n.props.children === RETIRED_HINT_TEXT),
      'no span reads the retired gesture pointer',
    ).toHaveLength(0);
    const bordered = all.filter(
      (n) =>
        n.type === 'span' &&
        typeof n.props.style === 'object' &&
        n.props.style !== null &&
        'border' in (n.props.style as Record<string, unknown>),
    );
    expect(bordered, 'no bordered span anywhere in the palette').toHaveLength(0);
    // The aside's own children, in order: the heading and then the tool list, nothing between.
    const asideKids = ([] as unknown[]).concat(tree.props.children as unknown).filter(isEl);
    const headingAt = asideKids.findIndex((n) => n.type === 'h2');
    expect(headingAt, 'the heading is a child of the aside').toBeGreaterThanOrEqual(0);
    const next = asideKids[headingAt + 1];
    expect(next, 'an element follows the heading').toBeDefined();
    expect(next.type, 'the element after the heading is not a span').not.toBe('span');
    expect(next.type, 'the element after the heading is the tool list').toBe(PaletteToolList);
    expect(asideKids, 'the aside holds the heading and the tool list only').toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// CHROME-16 (phase 91, D-15): the scroll cue lives in `PaletteToolList`, a component declared
// in Palette.tsx, so `Palette()` itself stays hook-free and callable as a plain function here.
// The rows reach the list as `children`, so the plain-function tree still holds every one.
// The cue's behaviour (the attribute, the fade, its box and pixels) is graded in a real
// browser: e2e/palette-grouping.spec.ts and e2e-live/91-palette.live.spec.ts.
// ---------------------------------------------------------------------------
describe('Palette tool list (CHROME-16, phase 91 D-15)', () => {
  it('stays a plain function whose tree holds every Place row inside PaletteToolList', () => {
    const tree = Palette(baseProps());
    const lists = walk(tree).filter((n) => n.type === PaletteToolList);
    expect(lists, 'one tool list').toHaveLength(1);
    const inList = allLabelledButtons(lists[0].props.children).filter((l) => l.startsWith('Place '));
    const inTree = allLabelledButtons(tree).filter((l) => l.startsWith('Place '));
    expect(inTree.length, 'the palette has Place rows').toBeGreaterThan(0);
    expect(inList, 'every Place row is a child of the tool list').toEqual(inTree);
    // The two drawn tools carry no aria-label (their visible text is the name); they ride in
    // the list too.
    const texts = walk(lists[0].props.children)
      .filter((n) => n.type === 'span')
      .map((n) => n.props.children);
    expect(texts, 'the Belt and Wire rows are in the list').toEqual(expect.arrayContaining(['Belt', 'Wire']));
  });
});

// ---------------------------------------------------------------------------
// WIRE-03 (66-04) / SERVE-03 + SERVE-05 (72-10) - the ROUTE and HTTP HANDLER rows.
//
// The Route (kind 9) has existed as a machine kind since Phase 38 and has been
// renderable, nameable and catalogued since 66-03, but it could only ever arrive
// PRE-PLACED from the demo scene until 66-04 gave it a row. The HTTP Handler
// (kind 10) is minted by 72-05 and gets its row here. This block is the behaviour
// contract for both.
//
// THEY ARE ORDINARY `ENTRIES` MEMBERS SINCE 72-10, AND THE REASON THEY WERE NOT IS
// GONE. The Route's row was hand-written on the stated grounds that every `ENTRIES`
// label reads `KIND_NAMES[...]` while kind 9 was deliberately outside that map.
// D-10 folds every kind into that one map, so the grounds no longer hold and the row
// comes home. A hand-written row kept beside a reason that stopped being true is the
// same defect D-10 closed one layer up, which is why this is not a "tidy".
//
// THE VISIBLE LABEL IS NOW THE KIND NAME, on both rows. 66-UI-SPEC allowed a longer
// disambiguating palette label than the kind name (the shipped `HTTP Router` row and
// the two-word Router preset label, over `KIND_NAMES[ROUTER]` = `Router`). 72-UI-SPEC
// 2.3 spent that allowance the other way for kind 9, and phase 91 (CHROME-09, D-09)
// spends it for the Router too: every row reads its kind name. `Place Route` is a
// prefix of `Place Router`, so a locator that means one of them matches by exact name
// (`findByAria` here compares whole strings). Kind 10's name IS the long form
// (`HTTP Handler`), for the separate reason that bare `Handler` would collide with the
// Factory editor's own label.
// ---------------------------------------------------------------------------

/** The locked copy contract (72-UI-SPEC section 2.3, superseding 66-UI-SPEC 3a). */
const ENDPOINT_ARIA = 'Place Route';
const ENDPOINT_LABEL = 'Route';
const ENDPOINT_ROLE = 'Receives HTTP requests at a path you choose';

/** The Handler row's half of the same contract (72-UI-SPEC 2.3, D-11). */
const HANDLER_ARIA = 'Place HTTP Handler';
const HANDLER_LABEL = 'HTTP Handler';
const HANDLER_ROLE = 'Runs your JavaScript on a request and returns the reply';

/**
 * U+2014 and U+2013 as ESCAPES, so neither guard can be defeated by its own copy.
 * Declared at module scope (the ROUTE-04 block's pair is local to that describe)
 * and suffixed with the plan number so the two cannot be confused for duplicates
 * of one another.
 */
const EM_DASH_CHAR_66_04 = '\u2014';
const EN_DASH_CHAR_66_04 = '\u2013';

/** Every element in ONE pre-order walk whose `type` is `component`. */
function elementsOfType(node: unknown, component: unknown): El[] {
  return walk(node).filter((n) => n.type === component);
}

describe('Palette Route row (WIRE-03 66-04, renamed by 72-10 D-09)', () => {
  it('exists exactly once, under the "Place ${label}" accessible name', () => {
    expect(findByAria(Palette(baseProps()), 'button', ENDPOINT_ARIA)).toHaveLength(1);
  });

  it('shows the SHARED kind name as its label, and no row reads "Endpoint"', () => {
    // WAS: "shows the disambiguating 'HTTP Endpoint' label, not the bare kind name",
    // which asserted the palette label DIFFERED from the kind name. D-10 collapses
    // the two, so the assertion is inverted and strengthened: the label is not merely
    // the right string, it is READ FROM the one map every other surface reads.
    const tree = Palette(baseProps());
    expect(spansWithText(tree, ENDPOINT_LABEL)).toHaveLength(1);
    expect(ENDPOINT_LABEL).toBe(KIND_NAMES[machine_kind.ENDPOINT]);
    // 72-UI-SPEC 8.5, at the surface this file owns: no palette row reads the old
    // word. NOT a claim about the whole app - the `/endpoint/` segment inside the
    // copyable POST URL is a host route prefix and stays (D-12a).
    expect(spansWithText(tree, 'Endpoint')).toHaveLength(0);
    expect(spansWithText(tree, 'HTTP Endpoint')).toHaveLength(0);
  });

  it('carries the locked role tooltip, character for character', () => {
    const row = findByAria(Palette(baseProps()), 'button', ENDPOINT_ARIA)[0];
    expect(row.props.title).toBe(ENDPOINT_ROLE);
  });

  it('describes its ROLE and never repeats the thin "Place X" (binds palette-grouping)', () => {
    // NOT a restatement of the test above. `e2e/palette-grouping.spec.ts` asserts
    // that EVERY `aside button[aria-label^="Place "]` carries a title that does
    // not begin with `Place `, so a row shipped without role copy reddens that
    // spec in the browser. This is the cheap unit-level twin of that binding, so
    // the failure is named here first instead of surfacing as a mystery e2e red.
    const row = findByAria(Palette(baseProps()), 'button', ENDPOINT_ARIA)[0];
    expect(typeof row.props.title).toBe('string');
    expect(row.props.title as string).not.toMatch(/^Place /);
  });

  it('writes the role copy with neither an em dash nor an en dash (project copy rule)', () => {
    const text = findByAria(Palette(baseProps()), 'button', ENDPOINT_ARIA)[0].props
      .title as string;
    expect(text.includes(EM_DASH_CHAR_66_04), `"${text}" has no em dash`).toBe(false);
    expect(text.includes(EN_DASH_CHAR_66_04), `"${text}" has no en dash`).toBe(false);
  });

  it('sits BELOW Merge, DIRECTLY above HTTP Handler, and above the Router', () => {
    // Position is the whole point of the row's placement, and 72-UI-SPEC 2.3 makes
    // it stricter than 66-04's did: the Handler must sit DIRECTLY under the Route, so
    // the two machines a request travels through read as one pair in the order the
    // request meets them. `toBe(route + 1)` is what states "directly"; a
    // `toBeGreaterThan` would pass with a row wedged between them.
    //
    // ONE pre-order walk, not four independent lookups: independent lookups assert
    // four unrelated existences and say nothing about document order.
    const order = walk(Palette(baseProps())).filter(
      (n) => n.type === 'button' && typeof n.props['aria-label'] === 'string',
    );
    const at = (label: string): number =>
      order.findIndex((n) => n.props['aria-label'] === label);
    const merge = at(`Place ${KIND_NAMES[machine_kind.MERGE]}`);
    const route = at(ENDPOINT_ARIA);
    const handler = at(HANDLER_ARIA);
    const itemRouter = at(`Place ${KIND_NAMES[machine_kind.ROUTER]}`);
    expect(merge, 'the Merge row is in the walk').toBeGreaterThanOrEqual(0);
    expect(route, 'the Route row is in the walk').toBeGreaterThanOrEqual(0);
    expect(handler, 'the HTTP Handler row is in the walk').toBeGreaterThanOrEqual(0);
    expect(route).toBeGreaterThan(merge);
    expect(handler, 'the Handler row sits DIRECTLY under the Route row').toBe(route + 1);
    expect(handler).toBeLessThan(itemRouter);
  });

  it('arms machine_kind.ENDPOINT through the PLAIN placement path, with no preset', () => {
    // The argument is the whole assertion. `beginPlacement(kind)` calls
    // `ghost.setPlacement(kind, 0)`, which reads `catalogEntry(kind)` - so kind 9
    // and nothing else is what makes the placement ghost preview the endpoint's
    // TWO port nubs, which is precisely what 66-03's MACHINE_CATALOG row bought
    // (the two-nub preview itself is asserted there, against the Rust catalog).
    // A wrong kind here would preview a different machine's nubs and stay green
    // on every other assertion in this block.
    const placed: number[] = [];
    const presets: number[] = [];
    const tree = Palette(
      baseProps({
        onBeginPlacement: (k) => placed.push(k),
        onBeginRouterPreset: (m) => presets.push(m),
      }),
    );
    (findByAria(tree, 'button', ENDPOINT_ARIA)[0].props.onClick as () => void)();
    expect(placed).toEqual([machine_kind.ENDPOINT]);
    // NO strip-and-reseed preset. The Router's preset machinery exists only
    // because two mediums share one `Node::Router` engine; the Endpoint has one.
    expect(presets).toEqual([]);
  });

  it('lights when ENDPOINT is armed, and lights NOTHING else with it (IX-03)', () => {
    const armed: ArmedTool = { kind: 'machine', machineKind: machine_kind.ENDPOINT };
    const tree = Palette(baseProps({ armed }));
    const row = findByAria(tree, 'button', ENDPOINT_ARIA)[0];
    expect(row.props['aria-pressed']).toBe(true);
    expect(row.props.className).toContain('is-armed');
    // Exactly one armed row across the WHOLE column, derived from the tree rather
    // than from a list of names this test would have to keep in step.
    const lit = walk(tree).filter(
      (n) => n.type === 'button' && String(n.props.className ?? '').includes('is-armed'),
    );
    expect(lit).toHaveLength(1);
  });

  it('stays dark when something else is armed', () => {
    for (const armed of [
      null,
      { kind: 'belt' } as ArmedTool,
      { kind: 'wire' } as ArmedTool,
      { kind: 'machine', machineKind: machine_kind.SOURCE } as ArmedTool,
      {
        kind: 'machine',
        machineKind: machine_kind.ROUTER,
        presetMedium: MEDIUM_ELECTRICAL,
      } as ArmedTool,
    ]) {
      const row = findByAria(Palette(baseProps({ armed })), 'button', ENDPOINT_ARIA)[0];
      expect(row.props['aria-pressed'], `armed=${JSON.stringify(armed)}`).toBe(false);
      expect(String(row.props.className)).not.toContain('is-armed');
    }
  });

  it('draws the AUTHORED Route asset through MachineGlyphIcon, at the palette step', () => {
    // No new artwork, and none may be added: `MachineGlyphIcon` resolves
    // `SUBJECT_OF[9]` to the already-shipped `render/assets/endpoint.svg`. The
    // Wire row's `ChromeGlyphIcon` route is the WRONG idiom here - that row takes
    // it because `SUBJECT_OF` has no key for kind 8, which is not true of kind 9.
    const tree = Palette(baseProps());
    const row = findByAria(tree, 'button', ENDPOINT_ARIA)[0];
    const glyphs = elementsOfType(row, MachineGlyphIcon);
    expect(glyphs, 'the row renders one MachineGlyphIcon').toHaveLength(1);
    expect(glyphs[0].props.kind).toBe(machine_kind.ENDPOINT);
    expect(glyphs[0].props.color).toBe('currentColor');
    // DERIVED, never restated: the size is read off a sibling machine row rather
    // than typed as a number here, so the two cannot drift apart.
    const merge = findByAria(tree, 'button', `Place ${KIND_NAMES[machine_kind.MERGE]}`)[0];
    expect(glyphs[0].props.px).toBe(elementsOfType(merge, MachineGlyphIcon)[0].props.px);
  });

  it('suppresses mouse focus on press, like every other row', () => {
    // A focused chrome button traps the canvas keyboard shortcuts (Esc-to-disarm,
    // r) behind the IX-09 focus guard, so every palette row preventDefaults its
    // mousedown. A row that forgets is a row that quietly breaks Escape.
    const row = findByAria(Palette(baseProps()), 'button', ENDPOINT_ARIA)[0];
    let prevented = false;
    (row.props.onMouseDown as (ev: { preventDefault: () => void }) => void)({
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SERVE-03 / D-11 (72-10) - the HTTP Handler row.
//
// The machine the request is actually answered BY. Its behaviour contract is the
// Route row's above, with two differences that are the whole reason it gets its
// own block rather than a parameterised loop over the pair:
//
//   1. Its glyph resolves `SUBJECT_OF[10]` to the FACTORY asset, not to one of its
//      own. That repetition is the honest outcome (an HTTP Handler IS a Factory
//      chassis running the user's code over electrical ports) and it is the thing a
//      loop would have quietly asserted was different.
//   2. It is the row a `beginPlacement(kind)` mistake is INVISIBLE on: kind 10 and
//      kind 2 draw the same glyph and the same 3x3 ghost box, so an arm that armed a
//      Factory instead would look correct on screen. The click assertion below is
//      the only thing in the tree that can tell them apart.
// ---------------------------------------------------------------------------

describe('Palette HTTP Handler row (SERVE-03, 72-10 / D-11)', () => {
  it('exists exactly once, under the "Place ${label}" accessible name', () => {
    // `armAndPlaceAt` in the live oracle resolves palette rows BY ACCESSIBLE NAME
    // (`e2e-live/support/oracle.ts`), so this string is an API, not decoration.
    expect(findByAria(Palette(baseProps()), 'button', HANDLER_ARIA)).toHaveLength(1);
  });

  it('shows the SHARED kind name as its label', () => {
    const tree = Palette(baseProps());
    expect(spansWithText(tree, HANDLER_LABEL)).toHaveLength(1);
    expect(HANDLER_LABEL).toBe(KIND_NAMES[machine_kind.HANDLER]);
  });

  it('carries the locked role tooltip, character for character', () => {
    const row = findByAria(Palette(baseProps()), 'button', HANDLER_ARIA)[0];
    expect(row.props.title).toBe(HANDLER_ROLE);
  });

  it('describes its ROLE and never repeats the thin "Place X" (binds palette-grouping)', () => {
    // `e2e/palette-grouping.spec.ts` asserts that EVERY `aside button[aria-label^=
    // "Place "]` carries a title that does not begin with `Place `, so a row shipped
    // without role copy reddens that spec in the browser. This is the cheap
    // unit-level twin of that binding, so the failure is named here first instead of
    // surfacing as a mystery e2e red.
    const row = findByAria(Palette(baseProps()), 'button', HANDLER_ARIA)[0];
    expect(typeof row.props.title).toBe('string');
    expect(row.props.title as string).not.toMatch(/^Place /);
  });

  it('writes the role copy with neither an em dash nor an en dash (project copy rule)', () => {
    const text = findByAria(Palette(baseProps()), 'button', HANDLER_ARIA)[0].props.title as string;
    expect(text.includes(EM_DASH_CHAR_66_04), `"${text}" has no em dash`).toBe(false);
    expect(text.includes(EN_DASH_CHAR_66_04), `"${text}" has no en dash`).toBe(false);
  });

  it('arms machine_kind.HANDLER through the PLAIN placement path, with no preset', () => {
    // THE ARGUMENT IS THE WHOLE ASSERTION, and this row is the one where getting it
    // wrong is invisible: kind 10 and kind 2 (FACTORY) share a glyph and a 3x3
    // footprint, so arming a Factory here would look right on screen and place the
    // wrong machine. `beginPlacement(kind)` calls `ghost.setPlacement(kind, 0)`,
    // which reads `catalogEntry(kind)` - and only kind 10 previews the ELECTRICAL
    // nubs a wire can dock to.
    //
    // NO strip-and-reseed preset. `ROUTER_PRESETS` exists only because two mediums
    // share one `Node::Router` engine; a Handler is ONE catalog kind landing from ONE
    // `Place` record (D-11), which is the whole reason this phase never calls
    // `RemovePort`.
    const placed: number[] = [];
    const presets: number[] = [];
    const tree = Palette(
      baseProps({
        onBeginPlacement: (k) => placed.push(k),
        onBeginRouterPreset: (m) => presets.push(m),
      }),
    );
    (findByAria(tree, 'button', HANDLER_ARIA)[0].props.onClick as () => void)();
    expect(placed).toEqual([machine_kind.HANDLER]);
    expect(presets).toEqual([]);
  });

  it('lights when HANDLER is armed, and lights NOTHING else with it (IX-03)', () => {
    const armed: ArmedTool = { kind: 'machine', machineKind: machine_kind.HANDLER };
    const tree = Palette(baseProps({ armed }));
    const row = findByAria(tree, 'button', HANDLER_ARIA)[0];
    expect(row.props['aria-pressed']).toBe(true);
    expect(row.props.className).toContain('is-armed');
    const lit = walk(tree).filter(
      (n) => n.type === 'button' && String(n.props.className ?? '').includes('is-armed'),
    );
    expect(lit).toHaveLength(1);
  });

  it('stays dark when the FACTORY is armed - the row it is easiest to confuse with', () => {
    const armed: ArmedTool = { kind: 'machine', machineKind: machine_kind.FACTORY };
    const row = findByAria(Palette(baseProps({ armed })), 'button', HANDLER_ARIA)[0];
    expect(row.props['aria-pressed']).toBe(false);
    expect(String(row.props.className)).not.toContain('is-armed');
  });

  it('draws the FACTORY asset through MachineGlyphIcon, and that repetition is correct', () => {
    // `SUBJECT_OF[10]` is `'factory'` by declaration (72-09), so this row and the
    // Factory row two above it render the SAME authored SVG. Asserted rather than
    // left implicit, because a reader meeting two identical glyphs in one column
    // will otherwise read it as a bug and "fix" it by minting artwork the canvas
    // does not draw.
    const tree = Palette(baseProps());
    const row = findByAria(tree, 'button', HANDLER_ARIA)[0];
    const glyphs = elementsOfType(row, MachineGlyphIcon);
    expect(glyphs, 'the row renders one MachineGlyphIcon').toHaveLength(1);
    expect(glyphs[0].props.kind).toBe(machine_kind.HANDLER);
    expect(glyphs[0].props.color).toBe('currentColor');
    // DERIVED, never restated: read the size off a sibling machine row.
    const merge = findByAria(tree, 'button', `Place ${KIND_NAMES[machine_kind.MERGE]}`)[0];
    expect(glyphs[0].props.px).toBe(elementsOfType(merge, MachineGlyphIcon)[0].props.px);
  });

  it('suppresses mouse focus on press, like every other row', () => {
    const row = findByAria(Palette(baseProps()), 'button', HANDLER_ARIA)[0];
    let prevented = false;
    (row.props.onMouseDown as (ev: { preventDefault: () => void }) => void)({
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE COLUMN AS A WHOLE (72-10). The two assertions above are per-row; these two
// are about the SET, and they are what a per-row suite structurally cannot say.
// ---------------------------------------------------------------------------

describe('the palette column after 72-10', () => {
  it('lists every placeable row in the contract order, as an EXACT array', () => {
    // 72-UI-SPEC 2.3's list, character for character, in ONE pre-order walk. An
    // exact array is what makes this a statement about the column rather than about
    // nine unrelated existences: a row added, dropped or reordered fails here.
    const names = allLabelledButtons(Palette(baseProps()));
    expect(names).toEqual([
      `Place ${KIND_NAMES[machine_kind.SOURCE]}`,
      `Place ${KIND_NAMES[machine_kind.SINK]}`,
      `Place ${KIND_NAMES[machine_kind.FACTORY]}`,
      `Place ${KIND_NAMES[machine_kind.TEE]}`,
      `Place ${KIND_NAMES[machine_kind.BALANCER]}`,
      `Place ${KIND_NAMES[machine_kind.MERGE]}`,
      'Place Route',
      'Place HTTP Handler',
      `Place ${KIND_NAMES[machine_kind.ROUTER]}`,
      // Phase 76 (SHAPE-10, UI-SPEC 1.1): the Label row, LAST, in its own group below the
      // Wire tool and a second separator. The Belt and Wire rows carry no aria-label, so
      // this walk of labelled buttons skips them.
      `Place ${KIND_NAMES[machine_kind.LABEL]}`,
    ]);
  });

  // CORRECTED 2026-09-04 (phase 72 vacuity sweep, V-5). This used to be
  // `gives every machine row a label read from the ONE name map`, and it could not
  // fail. It built its expected set FROM the same module the implementation reads
  // (`new Set(Object.values(KIND_NAMES).map((n) => `Place ${n}`))`) and then asked
  // whether each rendered label was in it. A row re-hand-written with a literal that
  // happens to equal the map's current value is in that set too, so the exact defect
  // the old comment claimed to catch was invisible to it. MEASURED: replacing
  // `KIND_NAMES[machine_kind.ENDPOINT]` at `Palette.tsx:223` with the literal
  // `'Route'` left it at `1 passed | 39 skipped`.
  //
  // "READS THE MAP" IS A STATEMENT ABOUT MOVEMENT, NOT ABOUT TODAY'S SPELLING, so
  // that is what is asserted now: the name table is re-mocked with a sentinel per
  // kind, `Palette` is re-imported against it, and every machine row's accessible
  // name must have MOVED to its sentinel. A literal cannot move, so a literal is a
  // red no matter what it currently spells.
  //
  // The Router row moves too since phase 91 (CHROME-09, D-09). It is still a PRESET
  // over `machine_kind.ROUTER`, but it used to carry 66-UI-SPEC's longer hand-written
  // label and was pinned here as the one row that did NOT move. It now reads
  // `KIND_NAMES[ROUTER]` like every other row, so it must move with the map.
  it('MOVES every machine row label when the ONE name map moves', async () => {
    const real = await import('./kindNames.ts');
    const sentinel = (kind: number): string => `KindSentinel${kind}`;
    const stubbed = Object.fromEntries(
      Object.keys(real.KIND_NAMES).map((k) => [k, sentinel(Number(k))]),
    );
    vi.resetModules();
    vi.doMock('./kindNames.ts', () => ({
      KIND_NAMES: stubbed,
      KIND_LEGEND_ORDER: real.KIND_LEGEND_ORDER,
    }));
    try {
      const { Palette: Restubbed } = await import('./Palette.tsx');
      expect(allLabelledButtons(Restubbed(baseProps()))).toEqual([
        `Place ${sentinel(machine_kind.SOURCE)}`,
        `Place ${sentinel(machine_kind.SINK)}`,
        `Place ${sentinel(machine_kind.FACTORY)}`,
        `Place ${sentinel(machine_kind.TEE)}`,
        `Place ${sentinel(machine_kind.BALANCER)}`,
        `Place ${sentinel(machine_kind.MERGE)}`,
        `Place ${sentinel(machine_kind.ENDPOINT)}`,
        `Place ${sentinel(machine_kind.HANDLER)}`,
        `Place ${sentinel(machine_kind.ROUTER)}`,
        `Place ${sentinel(machine_kind.LABEL)}`,
      ]);
    } finally {
      // Leave the module registry as it was found: every other case in this file
      // asserts against the statically imported, unmocked `Palette`.
      vi.doUnmock('./kindNames.ts');
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 76 (SHAPE-10, UI-SPEC 1.1/1.2): the Label row. Its own group below the Wire tool,
// arming kind 11 through the same `onBeginPlacement` every machine row uses, drawn with the
// chrome `LabelIcon` (never `MachineGlyphIcon`, which has no subject for kind 11).
// ---------------------------------------------------------------------------
describe('the Label row (phase 76)', () => {
  const LABEL_ARIA = `Place ${KIND_NAMES[machine_kind.LABEL]}`;

  it('arms kind 11, and ONLY kind 11, through onBeginPlacement', () => {
    const placed: number[] = [];
    const tree = Palette(baseProps({ onBeginPlacement: (k) => placed.push(k) }));
    const rows = findByAria(tree, 'button', LABEL_ARIA);
    expect(rows, 'exactly one Label row').toHaveLength(1);
    (rows[0].props.onClick as () => void)();
    expect(placed).toEqual([11]);
    expect(rows[0].props.title).toBe('A note on the board. It does not connect.');
  });

  it('lights when LABEL is armed and lights nothing else', () => {
    const armed: ArmedTool = { kind: 'machine', machineKind: machine_kind.LABEL };
    const tree = Palette(baseProps({ armed }));
    const row = findByAria(tree, 'button', LABEL_ARIA)[0];
    expect(row.props['aria-pressed']).toBe(true);
    const lit = walk(tree).filter(
      (n) => n.type === 'button' && String(n.props.className ?? '').includes('is-armed'),
    );
    expect(lit).toHaveLength(1);
  });

  it('sits below a SECOND separator, after the Wire tool, drawn with LabelIcon', () => {
    const tree = Palette(baseProps());
    const order = walk(tree)
      .filter((n) => n.props.role === 'separator' || n.type === 'button')
      .map((n) =>
        n.props.role === 'separator'
          ? 'separator'
          : String(n.props['aria-label'] ?? n.props.title ?? ''),
      );
    expect(order.filter((x) => x === 'separator'), 'two separators').toHaveLength(2);
    // The tail of the column: separator, Belt, Wire, separator, Label.
    expect(order.slice(-5).map((x) => x.split(' (')[0])).toEqual([
      'separator',
      'Draw belts to connect machines',
      'Draw wires to carry requests',
      'separator',
      LABEL_ARIA,
    ]);
    const row = findByAria(tree, 'button', LABEL_ARIA)[0];
    expect(elementsOfType(row, LabelIcon)).toHaveLength(1);
    expect(elementsOfType(row, MachineGlyphIcon)).toHaveLength(0);
  });
});

// Phase 90 (FAIL-01, D-12, UI-SPEC 1.4): on a stopped simulation nothing can be placed or drawn,
// so every item is disabled and says why, with the shipped flat look and its name unchanged.
describe('Palette on a stopped simulation', () => {
  const buttons = (tree: unknown): El[] => walk(tree).filter((n) => n.type === 'button');

  it('disables every item with the reason in its title and the flat look', () => {
    const tree = Palette(baseProps({ disabled: true }));
    const all = buttons(tree);
    expect(all.length, 'the palette still lists its items').toBeGreaterThanOrEqual(5);
    for (const b of all) {
      const name = String(b.props['aria-label'] ?? b.props.title);
      expect(b.props.disabled, `${name}: disabled`).toBe(true);
      expect(b.props.title, `${name}: titled with the reason`).toBe(SIM_STOPPED_COPY.disabledTitle);
      expect(b.props.style, `${name}: the flat look`).toEqual({ filter: 'saturate(0) brightness(0.8)', cursor: 'not-allowed' });
    }
    // The accessible names are the running palette's, unchanged.
    expect(allLabelledButtons(tree)).toEqual(allLabelledButtons(Palette(baseProps())));
  });

  it('a running simulation keeps every item enabled with its own title and no inline look', () => {
    for (const disabled of [false, undefined]) {
      for (const b of buttons(Palette(baseProps({ disabled })))) {
        expect(b.props.disabled).toBe(false);
        expect(b.props.title).not.toBe(SIM_STOPPED_COPY.disabledTitle);
        expect(b.props.style).toBeUndefined();
      }
    }
  });
});
