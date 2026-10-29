import { describe, expect, it } from 'vitest';
import {
  BeltConfigBody,
  FIELD_LABEL,
  MIXED_NOTE,
  MIXED_SEGMENT,
  PACE_LABEL,
  PACE_NOTE,
  PACE_PX_PER_SEC_AT_ONE_TICK,
  PACE_STEPS,
  RUN_SINGLE,
  SCALE_FASTEST,
  SCALE_SLOWEST,
  nearestNote,
  paceAccessibleName,
  paceToTicks,
  runPlural,
  type BeltConfigBodyProps,
} from './BeltConfigBody.tsx';
import { REFUSAL_COPY } from './RefusalMessage.tsx';
import {
  ConfigPanelView,
  configApplied,
  configAppliedToRun,
  type ConfigPanelViewProps,
} from './ConfigPanel.tsx';
import { machine_kind } from '../protocol/kinds.ts';
import type { MachineConfig } from '../protocol/decode.ts';
import type { BeltRunEntry } from '../render/beltRun.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node env, no DOM: BeltConfigBody is a HOOK-FREE pure function (props in,
// callbacks out) whose sub-parts are inlined as render helpers, so the returned
// tree carries the real <button> and <input> nodes we walk. Copied structurally
// from `SinkConfigBody.test.tsx` - the same walker, the same `group()` resolution
// by `aria-label`, the same `findAll(el.type === 'select')` refusal.
//
// WHAT THIS BOARD DOES NOT SHARE WITH THE SHIPPED APP: it invokes the body as a
// plain function and never mounts `ConfigPanel`, so it is structurally unable to
// see a missing `config.kind === 'Belt'` dispatch arm. That is what the
// panel-level reachability case at the bottom of this file exists for.

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
  walk(node, (el) => pred(el) && hits.push(el));
  return hits;
}
function textOf(node: unknown): string {
  let out = '';
  const rec = (n: unknown): void => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string' || typeof n === 'number') out += String(n);
    else if (Array.isArray(n)) n.forEach(rec);
    else if (isEl(n)) rec(n.props.children);
  };
  rec(node);
  return out;
}
function hasClass(el: El, cls: string): boolean {
  return typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls);
}
function group(tree: unknown, label: string): El {
  const g = findAll(tree, (el) => el.props.role === 'group' && el.props['aria-label'] === label);
  expect(g, `group "${label}"`).toHaveLength(1);
  return g[0];
}
function pressedSegments(scope: unknown): El[] {
  return findAll(scope, (el) => el.type === 'button' && hasClass(el, 'is-pressed'));
}
function segmentByLabel(scope: unknown, label: string): El {
  const b = findAll(scope, (el) => el.type === 'button' && textOf(el) === label);
  expect(b, `segment "${label}"`).toHaveLength(1);
  return b[0];
}
function fieldEl(tree: unknown): El {
  const f = findAll(tree, (el) => el.type === 'input');
  expect(f, 'the typed pace field').toHaveLength(1);
  return f[0];
}

const DEFAULT_TICKS = 2;

/** A run whose belts all hold `ticks`, of the given length. */
function agreeing(ticks: number, length = 1): BeltRunEntry[] {
  return Array.from({ length }, (_, i) => ({ id: 10 + i, ticksPerSlot: ticks }));
}

function body(over: Partial<BeltConfigBodyProps> = {}): ReturnType<typeof BeltConfigBody> {
  const ticksPerSlot = over.ticksPerSlot ?? DEFAULT_TICKS;
  return BeltConfigBody({
    ticksPerSlot,
    run: over.run ?? agreeing(ticksPerSlot),
    typed: over.typed ?? null,
    onChange: over.onChange ?? (() => {}),
    onTyped: over.onTyped ?? (() => {}),
  });
}

// ---------------------------------------------------------------------------
// The scale itself (68-02's cases, unchanged)
// ---------------------------------------------------------------------------

describe('the pace scale, and why it is these five steps', () => {
  it('offers exactly the ruled set {2,4,5,10,20}', () => {
    expect(PACE_STEPS.map((s) => s.ticks)).toEqual([2, 4, 5, 10, 20]);
  });

  it('divides 500 EXACTLY at every step, so no shipped label is a rounded figure', () => {
    // MUTATION-PROVED: putting `3` back into the step set reddens this case,
    // naming 3 (500/3 = 166.666..., which would ship as `166.66666666666666`).
    // The whole reason the offered set moved off {2,3,4,8,16} is that the
    // corrected 500 px/sec cadence does not divide it (68-UI-SPEC FINDING 1).
    for (const step of PACE_STEPS) {
      expect(
        PACE_PX_PER_SEC_AT_ONE_TICK % step.ticks,
        `500 must divide ticks_per_slot ${step.ticks} exactly`,
      ).toBe(0);
    }
  });

  it('labels every step with a WHOLE number, computed rather than transcribed', () => {
    for (const step of PACE_STEPS) {
      expect(Number.isInteger(Number(step.label)), `label "${step.label}"`).toBe(true);
      expect(step.label).toBe(String(PACE_PX_PER_SEC_AT_ONE_TICK / step.ticks));
    }
    expect(PACE_STEPS.map((s) => s.label)).toEqual(['250', '125', '100', '50', '25']);
  });

  it('is a module constant, so the group can never render zero segments (E1/empty)', () => {
    expect(PACE_STEPS.length).toBe(5);
  });

  it('states 500 and not the superseded 480', () => {
    expect(PACE_PX_PER_SEC_AT_ONE_TICK).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// The five-step group (68-02's cases, unchanged except for the new props)
// ---------------------------------------------------------------------------

describe('BeltConfigBody - the Belt pace segmented control', () => {
  it('renders the five paces as .fab-tool-btn segments, never a native <select>', () => {
    const tree = body();
    expect(findAll(tree, (el) => el.type === 'select')).toHaveLength(0);
    const g = group(tree, PACE_LABEL);
    for (const step of PACE_STEPS) {
      expect(hasClass(segmentByLabel(g, step.label), 'fab-tool-btn')).toBe(true);
    }
  });

  it('inlines the real <button> and <input> nodes - the helpers are INVOKED, never <Segment/>', () => {
    // The direct-invocation discipline stated at `SinkConfigBody.tsx:41-56`. A
    // `<Segment/>` element appears in the tree as an opaque FUNCTION type, so
    // every `el.type === 'button'` walk returns nothing and stays green over a
    // body that renders no buttons at all.
    const tree = body();
    expect(findAll(tree, (el) => el.type === 'button')).toHaveLength(PACE_STEPS.length);
    expect(findAll(tree, (el) => el.type === 'input')).toHaveLength(1);
    expect(findAll(tree, (el) => typeof el.type === 'function')).toHaveLength(0);
  });

  it('raises the chosen interval, not the label', () => {
    const raised: number[] = [];
    const g = group(body({ onChange: (t) => raised.push(t) }), PACE_LABEL);
    (segmentByLabel(g, '50').props.onClick as () => void)();
    expect(raised).toEqual([10]);
  });

  it('carries the unit on the accessible name and the two scale end-labels, never on the segment', () => {
    const tree = body();
    const g = group(tree, PACE_LABEL);
    for (const step of PACE_STEPS) {
      const seg = segmentByLabel(g, step.label);
      expect(textOf(seg)).toBe(step.label);
      expect(seg.props['aria-label']).toBe(paceAccessibleName(step.label));
      expect(String(seg.props['aria-label'])).toContain(step.label);
    }
    expect(textOf(tree)).toContain(SCALE_FASTEST);
    expect(textOf(tree)).toContain(SCALE_SLOWEST);
  });

  it('labels the group with aria-label, NEVER aria-labelledby', () => {
    const g = group(body(), PACE_LABEL);
    expect(g.props['aria-labelledby']).toBeUndefined();
  });

  it('roots at #fab-belt-config, the single Playwright and axe handle', () => {
    expect(findAll(body(), (el) => el.props.id === 'fab-belt-config')).toHaveLength(1);
  });

  it('wraps both rows, so no segment is clipped at the panel content box', () => {
    const wrapping = findAll(
      body(),
      (el) => (el.props.style as { flexWrap?: string } | undefined)?.flexWrap === 'wrap',
    );
    expect(wrapping.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// The eleven behaviour cases this plan owns
// ---------------------------------------------------------------------------

describe('BeltConfigBody - the full state matrix (68-UI-SPEC section 8)', () => {
  it('test 1 (state 2): a run agreeing on an offered step presses exactly that step', () => {
    for (const step of PACE_STEPS) {
      const tree = body({ ticksPerSlot: step.ticks, run: agreeing(step.ticks, 3) });
      const g = group(tree, PACE_LABEL);
      expect(pressedSegments(g)).toHaveLength(1);
      expect(textOf(pressedSegments(g)[0])).toBe(step.label);
      expect(fieldEl(tree).props.value).toBe(step.label);
      expect(textOf(tree)).not.toContain(MIXED_NOTE);
      expect(textOf(tree)).not.toContain('The nearest pace');
    }
  });

  it('test 2 (state 5, Mixed): a SIXTH segment pressed, no scale segment, an EMPTY field', () => {
    const run: BeltRunEntry[] = [
      { id: 10, ticksPerSlot: 2 },
      { id: 11, ticksPerSlot: 10 },
      { id: 12, ticksPerSlot: 2 },
    ];
    const tree = body({ ticksPerSlot: 2, run });
    const g = group(tree, PACE_LABEL);
    const pressed = pressedSegments(g);
    expect(pressed, 'exactly one pressed segment, and it is Mixed').toHaveLength(1);
    expect(textOf(pressed[0])).toBe(MIXED_SEGMENT);
    // Not merely "one is pressed": NO SCALE segment is pressed. Showing the head
    // belt's step here would state a pace the run does not have.
    for (const step of PACE_STEPS) {
      expect(hasClass(segmentByLabel(g, step.label), 'is-pressed'), step.label).toBe(false);
    }
    expect(fieldEl(tree).props.value, 'the field is EMPTY in Mixed').toBe('');
    expect(textOf(tree)).toContain(MIXED_NOTE);
  });

  it('test 3 (state 6, off-scale): a SIXTH segment carries the ACTUAL figure and is pressed', () => {
    // `ticks_per_slot = 3` is in range (D-68-02 accepts every integer in 2..=20)
    // and is not one of the five offered steps. It is reachable from a save and
    // from the typed field.
    const tree = body({ ticksPerSlot: 3, run: agreeing(3, 2) });
    const g = group(tree, PACE_LABEL);
    const pressed = pressedSegments(g);
    expect(pressed).toHaveLength(1);
    expect(textOf(pressed[0])).toBe('167');
    for (const step of PACE_STEPS) {
      expect(hasClass(segmentByLabel(g, step.label), 'is-pressed'), step.label).toBe(false);
    }
    expect(fieldEl(tree).props.value, 'the figure appears on the segment AND the field').toBe('167');
    expect(textOf(tree)).not.toContain(MIXED_NOTE);
  });

  it('test 4 (state 7): a typed figure that resolves elsewhere is DISCLOSED, not blocked', () => {
    // 300 px/sec resolves to ticks_per_slot 2, which is 250 px/sec.
    const tree = body({ ticksPerSlot: paceToTicks('300'), typed: '300', run: agreeing(2, 3) });
    expect(fieldEl(tree).props.value, 'the field shows what was TYPED').toBe('300');
    expect(textOf(tree)).toContain(nearestNote('250'));
    // Nothing is blocked and nothing paints an error: no disabled control in the
    // body, no role="alert", no aria-invalid.
    expect(findAll(tree, (el) => el.props.disabled === true)).toHaveLength(0);
    expect(findAll(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
  });

  it('test 5 (state 11): a run of one drops the Apply clause; two or more names the COUNT', () => {
    expect(textOf(body({ run: agreeing(2, 1) }))).toContain(RUN_SINGLE);
    expect(textOf(body({ run: agreeing(2, 1) }))).not.toContain('Apply sets the pace');
    // The COUNT is the assertion. A traversal broken to return a run of one
    // answers RUN_SINGLE on every click and would pass an agreement-only check.
    expect(textOf(body({ run: agreeing(2, 3) }))).toContain(runPlural(3));
    expect(textOf(body({ run: agreeing(2, 7) }))).toContain(runPlural(7));
  });

  it('test 6 (V15): paceToTicks is TOTAL, and every output lands on a TRUE sentence', () => {
    // 68-UI-SPEC 5.2's table, transcribed. `reaches` is the assertion that
    // matters: a totality check that only asserts the output is a u32 is
    // satisfied by a mapping that sends a large typed figure to the ZERO
    // sentence, whose wording would be false for whoever typed it.
    const ACCEPTED = 'accepted';
    const ZERO = REFUSAL_COPY.ZeroBeltInterval;
    const RANGE = REFUSAL_COPY.PaceOutOfRange;
    const bigPaste = '9'.repeat(500);

    const table: { typed: string; ticks: number; reaches: string; why: string }[] = [
      { typed: '250', ticks: 2, reaches: ACCEPTED, why: 'a figure ON the scale' },
      { typed: '167', ticks: 3, reaches: ACCEPTED, why: 'in range, off the scale' },
      { typed: '500', ticks: 1, reaches: RANGE, why: 'the WALL figure - the SC4 demo path' },
      { typed: '1e30', ticks: 1, reaches: RANGE, why: 'so large the interval rounds to 0' },
      { typed: bigPaste, ticks: 1, reaches: RANGE, why: 'a 500-digit paste is a BIG number' },
      { typed: '1.9', ticks: 263, reaches: RANGE, why: 'below the slow end' },
      { typed: '1e-30', ticks: 0xffffffff, reaches: RANGE, why: 'clamped at the u32 ceiling' },
      // 68-REVIEW IN-05: the two halves of "absurdly small", which the docblock
      // table used to state as ONE row reaching PaceOutOfRange. The double is
      // what splits them, and `Number()` decides it before this function runs.
      {
        typed: '5e-324',
        ticks: 0xffffffff,
        reaches: RANGE,
        why: 'the SMALLEST positive double: still a positive figure, still the ceiling',
      },
      {
        typed: '1e-400',
        ticks: 0,
        reaches: ZERO,
        why: "UNDERFLOWS: Number('1e-400') IS exactly 0, so it is a stopped belt",
      },
      { typed: '', ticks: 0, reaches: ZERO, why: 'empty' },
      { typed: 'abc', ticks: 0, reaches: ZERO, why: 'non-numeric' },
      { typed: '0', ticks: 0, reaches: ZERO, why: 'a typed zero' },
      { typed: '-5', ticks: 0, reaches: ZERO, why: 'a negative' },
    ];

    for (const row of table) {
      const got = paceToTicks(row.typed);
      expect(got, `${row.why}: "${row.typed.slice(0, 12)}"`).toBe(row.ticks);
      // Every output is a u32 the wire can carry.
      expect(Number.isInteger(got) && got >= 0 && got <= 0xffffffff, `u32: ${got}`).toBe(true);
      expect(sentenceFor(got), `${row.why} must reach a TRUE sentence`).toBe(row.reaches);
    }

    // The bound the host enforces on WRITE (68-04: BELT_PACE_RANGE = 2..=20).
    // Restated here as the TEST's own model of the arbiter, so a change to the
    // bound reddens this table rather than silently re-labelling a sentence.
    function sentenceFor(ticks: number): string {
      if (ticks === 0) return ZERO;
      if (ticks < 2 || ticks > 20) return RANGE;
      return ACCEPTED;
    }
  });

  it('test 7 (V5): no native select element anywhere in the rendered body', () => {
    for (const props of [
      {},
      { ticksPerSlot: 3, run: agreeing(3, 2) },
      { run: [{ id: 1, ticksPerSlot: 2 }, { id: 2, ticksPerSlot: 4 }] },
    ]) {
      expect(findAll(body(props), (el) => el.type === 'select')).toHaveLength(0);
    }
  });

  it('test 8 (V16): all ten copy constants are pinned VERBATIM and carry no dash', () => {
    // EXACT string equality, never `toContain`: a Phase 67 mutation dropped a
    // trailing word from a sentence and stayed green under a keyword pin.
    expect(PACE_LABEL).toBe('Belt pace');
    expect(FIELD_LABEL).toBe('Pace (px/sec)');
    expect(SCALE_FASTEST).toBe('Fastest (250 px/sec)');
    expect(SCALE_SLOWEST).toBe('Slowest (25 px/sec)');
    expect(MIXED_SEGMENT).toBe('Mixed');
    expect(RUN_SINGLE).toBe('This run is one belt.');
    expect(runPlural(3)).toBe('This run is 3 belts. Apply sets the pace on all of them.');
    expect(MIXED_NOTE).toBe(
      'The belts in this run hold different paces. Choose one to set them all.',
    );
    expect(nearestNote('250')).toBe('The nearest pace a belt can run is 250 px/sec.');
    expect(PACE_NOTE).toBe(
      '250 px/sec is the fastest: any faster and you cannot tell which way a belt is running.',
    );

    // The dash lock. Both codepoints are written as escapes, never as raw
    // characters, so this file cannot itself become the thing it forbids.
    const EM = '\u2014';
    const EN = '\u2013';
    const every = [
      PACE_LABEL,
      FIELD_LABEL,
      SCALE_FASTEST,
      SCALE_SLOWEST,
      MIXED_SEGMENT,
      RUN_SINGLE,
      runPlural(3),
      MIXED_NOTE,
      nearestNote('250'),
      PACE_NOTE,
    ];
    expect(every, 'ten constants, all pinned above').toHaveLength(10);
    for (const value of every) {
      expect(value, `em dash in "${value}"`).not.toContain(EM);
      expect(value, `en dash in "${value}"`).not.toContain(EN);
    }
  });

  it('test 9: the typed field is text + decimal, with no range and no invalid state', () => {
    const f = fieldEl(body());
    expect(f.props.type).toBe('text');
    expect(f.props.inputMode).toBe('decimal');
    // The host is the arbiter and answers in words. `min`/`max` are advisory
    // only, so they enforce nothing - but they DO paint a state that reads as
    // the app refusing, which competes with the host's own refusal.
    expect('min' in f.props, 'min').toBe(false);
    expect('max' in f.props, 'max').toBe(false);
    expect('aria-invalid' in f.props, 'aria-invalid').toBe(false);
    expect(findAll(body(), (el) => 'aria-invalid' in el.props)).toHaveLength(0);
  });

  it('test 10: EXACTLY ONE segment is pressed at every state in the matrix', () => {
    // Table-driven, and this is the case that catches a Mixed state which
    // presses the head belt's step instead of the sixth segment: the
    // Mixed-specific assertions above would still be satisfied by a body that
    // pressed BOTH.
    const states: { name: string; props: Partial<BeltConfigBodyProps> }[] = [
      { name: 'state 2, agreed on the scale', props: { ticksPerSlot: 10, run: agreeing(10, 3) } },
      {
        name: 'state 5, Mixed',
        props: {
          ticksPerSlot: 2,
          run: [
            { id: 1, ticksPerSlot: 2 },
            { id: 2, ticksPerSlot: 20 },
          ],
        },
      },
      { name: 'state 6, agreed off the scale', props: { ticksPerSlot: 3, run: agreeing(3, 2) } },
      {
        name: 'state 7, typed resolves elsewhere',
        props: { ticksPerSlot: paceToTicks('300'), typed: '300', run: agreeing(2, 3) },
      },
    ];
    for (const state of states) {
      const g = group(body(state.props), PACE_LABEL);
      expect(pressedSegments(g), state.name).toHaveLength(1);
    }
  });

  it('test 11: no role="alert" and no new live region anywhere in the arm', () => {
    // A refused pace interrupts nothing, destroys nothing and diverges no state.
    // It reaches the user on the SHARED refusal surface.
    for (const props of [
      {},
      { ticksPerSlot: 3, run: agreeing(3, 2) },
      { ticksPerSlot: 1, typed: '500', run: agreeing(2, 3) },
      {
        run: [
          { id: 1, ticksPerSlot: 2 },
          { id: 2, ticksPerSlot: 4 },
        ],
      },
    ]) {
      const tree = body(props);
      expect(findAll(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
      expect(findAll(tree, (el) => 'aria-live' in el.props)).toHaveLength(0);
    }
  });

  it('raises the RAW typed text, never a resolved figure', () => {
    const raised: string[] = [];
    const tree = body({ onTyped: (t) => raised.push(t) });
    const onChange = fieldEl(tree).props.onChange as (e: {
      currentTarget: { value: string };
    }) => void;
    onChange({ currentTarget: { value: '3xx' } });
    expect(raised, 'the field does not clamp and does not sanitize').toEqual(['3xx']);
  });

  it('the standing note is SC4 reason said to the user, and names no anatomy word', () => {
    expect(textOf(body())).toContain(PACE_NOTE);
    // `tread` ships in comments and tests and in ZERO user-facing strings.
    expect(PACE_NOTE.toLowerCase()).not.toContain('tread');
    expect(PACE_NOTE.toLowerCase()).not.toContain('tick');
    expect(PACE_NOTE.toLowerCase()).not.toContain('slot');
    // It is DERIVED from the scale's fast end, not transcribed beside it.
    expect(PACE_NOTE.startsWith(`${PACE_STEPS[0].label} px/sec`)).toBe(true);
  });

  it('says nothing at all about a run it cannot see (the removed-belt transient)', () => {
    // An empty run is the transient between a belt leaving the scene and the
    // selection clearing. `This run is 0 belts.` would be worse than silence.
    const text = textOf(body({ run: [] }));
    expect(text).not.toContain(RUN_SINGLE);
    expect(text).not.toContain('This run is');
  });
});

// ---------------------------------------------------------------------------
// The panel shell: reachability, the whole-run applied observation, and the two
// surfaces this arm deliberately does NOT touch (68-UI-SPEC 8.1, states 4 and 8).
// ---------------------------------------------------------------------------

describe('the Belt arm inside ConfigPanel (68-UI-SPEC 8.1)', () => {
  const BELT_CFG: MachineConfig = { kind: 'Belt', ticks_per_slot: 2 };

  const panel = (over: Partial<ConfigPanelViewProps> = {}): ConfigPanelViewProps => ({
    kind: machine_kind.BELT,
    node: 7,
    loading: false,
    config: BELT_CFG,
    dirty: false,
    error: null,
    applied: false,
    ports: [],
    // 74.1-19: REQUIRED; a belt grows no outputs.
    addBlockedByBelt: false,
    flow: new Map(),
    otherRoutes: [],
    run: agreeing(2, 3),
    beltTyped: null,
    onBeltPace: () => {},
    onBeltTyped: () => {},
    onAddOutput: () => {},
    onRemoveOutput: () => {},
    playing: true,
    portEditPending: false,
    portEditStalled: false,
    portEditPendingVisible: false,
    onPortEditReset: () => {},
    onFieldChange: () => {},
    onApply: () => {},
    onRevert: () => {},
    invoke: () => Promise.resolve(null),
    factoryEditorRef: { current: null },
    onFactoryDirty: () => {},
    ...over,
  });

  /** Resolve the panel ONE level: find the Belt arm's element and invoke the
   *  hook-free body with the props the panel actually handed it.
   *
   *  NOT a deep render, and the reason is the Router palette-copy lock's: a walk
   *  over an unresolved panel tree finds no editor markup at all while staying
   *  green, because a component element carries an opaque FUNCTION type. One
   *  level is what proves the dispatch arm exists AND that its props are real. */
  function resolveBeltArm(props: ConfigPanelViewProps): unknown {
    const tree = ConfigPanelView(props);
    const arms = findAll(tree, (el) => el.type === BeltConfigBody);
    expect(arms, 'the config.kind === Belt dispatch arm').toHaveLength(1);
    return BeltConfigBody(arms[0].props as unknown as BeltConfigBodyProps);
  }

  it('test 1 (V2): ConfigPanel resolves to the Belt arm and renders the pace group', () => {
    // THE BODY'S OWN SUITE CANNOT COVER THIS. Every case above invokes
    // `BeltConfigBody(props)` as a plain function, so it is structurally unable
    // to see a missing `config.kind === 'Belt'` arm in the panel's dispatch: it
    // would stay fully green over a panel that renders nothing at all for a belt.
    const arm = resolveBeltArm(panel());
    const g = group(arm, PACE_LABEL);
    expect(findAll(g, (el) => el.type === 'button').length).toBeGreaterThanOrEqual(
      PACE_STEPS.length,
    );
    expect(textOf(arm)).toContain(runPlural(3));
  });

  it('test 1b: the panel renders NO PortsSection for a belt', () => {
    // With no ports the section renders `Inputs / None / Outputs / None`, which
    // is a FALSE statement about a belt docked at both ends.
    const tree = ConfigPanelView(panel());
    expect(textOf(tree)).not.toContain('Inputs');
    expect(textOf(tree)).not.toContain('Outputs');
  });

  it('test 2: Applied is WITHHELD when one non-clicked belt still holds the old pace', () => {
    // The read-back for the CLICKED belt says yes. One other belt in the run has
    // not moved. This is the fan-out-dropped-the-rest shape, and it is the only
    // case that can see the difference between the two observations.
    const partial: BeltRunEntry[] = [
      { id: 7, ticksPerSlot: 10 },
      { id: 8, ticksPerSlot: 2 },
      { id: 9, ticksPerSlot: 10 },
    ];
    const sent: MachineConfig = { kind: 'Belt', ticks_per_slot: 10 };
    // MUTATION-PROVED: reverting the observation to `configApplied` alone makes
    // this case, and only this case, go green on a half-written run.
    expect(configApplied(7, sent, sent), 'the clicked belt DID move').toBe(true);
    expect(configAppliedToRun(7, sent, sent, partial)).toBe(false);
  });

  it('test 3: Applied IS shown when every belt in the run reads the committed pace', () => {
    const sent: MachineConfig = { kind: 'Belt', ticks_per_slot: 10 };
    expect(configAppliedToRun(7, sent, sent, agreeing(10, 3))).toBe(true);
    // Anti-vacuity: the observation is not simply always true.
    expect(configAppliedToRun(7, sent, null, agreeing(10, 3)), 'no read-back').toBe(false);
    expect(configAppliedToRun(7, sent, sent, []), 'an empty run claims NOTHING').toBe(false);
    // Every other kind keeps the one-node observation unchanged.
    const sink: MachineConfig = { kind: 'Sink', target: { kind: 'Debug' } };
    expect(configAppliedToRun(7, sink, sink, [])).toBe(true);
  });

  it('test 4: the shared error row keeps exactly its TWO existing causes', () => {
    // That row is `role="alert"` and is reserved for errors that INTERRUPT. A
    // refused pace interrupts nothing, destroys nothing and diverges no state -
    // it reaches the user on the shared refusal surface instead.
    //
    // The CAUSE COUNT is the assertion, not the row's absence: asserting only
    // that no Belt branch renders would stay green if a Belt cause were added
    // beside the two, and asserting the row is absent would stop covering the
    // two that must remain.
    const src = readFileSync(
      fileURLToPath(new URL('./ConfigPanel.tsx', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const causes = src.match(/setError\((?!null\))/g) ?? [];
    expect(causes, 'the query-failure backstop and the Factory JS pre-check').toHaveLength(2);
    expect(src).not.toMatch(/setError\(\s*`?[^)]*[Pp]ace/);
    expect(src).not.toMatch(/setError\(\s*`?[^)]*Belt/);
    // And no second live region or alert is minted anywhere in the arm.
    // Comments stripped for the same reason `ConfigPanel.test.tsx`'s discipline
    // checks strip them: a doc comment legitimately NAMES the anti-pattern it is
    // explaining, and a scan that counts prose measures the explanation.
    const armSrc = readFileSync(
      fileURLToPath(new URL('./BeltConfigBody.tsx', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(armSrc).not.toContain('role="alert"');
    expect(armSrc).not.toContain('aria-live');
  });

  it('test 5 (E4/partial): a run that changes mid-panel updates IN PLACE, no remount', () => {
    // The run line and the Mixed state re-derive from the poll for the SAME
    // node; the panel key is the belt id and the belt id did not change.
    const before = resolveBeltArm(panel({ run: agreeing(2, 3) }));
    expect(textOf(before)).toContain(runPlural(3));
    const after = resolveBeltArm(
      panel({
        run: [
          { id: 7, ticksPerSlot: 2 },
          { id: 8, ticksPerSlot: 2 },
          { id: 9, ticksPerSlot: 20 },
          { id: 10, ticksPerSlot: 2 },
        ],
      }),
    );
    expect(textOf(after), 'the COUNT followed the run').toContain(runPlural(4));
    expect(textOf(after), 'and the run now disagrees').toContain(MIXED_NOTE);

    // The key is what makes "in place" true, so it is asserted at the mount site
    // rather than inferred. Since the 76-17 refuter round App keys the belt panel on the
    // selection epoch (`selectionEpoch.ts`), which only the two selection announcements
    // move in React state; the ~10Hz run poll never touches it.
    const appSrc = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');
    expect(appSrc).toContain('key={selectionEpoch}\n              node={selectedBelt}');
    expect(appSrc, 'the key must not depend on the run').not.toContain('key={selectedBeltRun');
    expect(
      appSrc.match(/setSelectionEpoch\(/g)?.length,
      'only onSelect and onSelectBelt move the epoch React renders, never the run poll',
    ).toBe(2);
  });
});
