import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADD_RULE_LABEL,
  decodeExpect,
  DEFAULT_HEADER,
  deleteRuleLabel,
  EXPECT_LABEL,
  FALLTHROUGH_FAULT,
  fallthroughTo,
  encodeExpect,
  outputName,
  targetName,
  MAX_ROUTE_EXPECT_BYTES,
  MISSING_SEGMENT,
  moveDownLabel,
  moveUpLabel,
  NO_DEFAULT_SEGMENT,
  NO_OUTPUTS,
  NO_RULES,
  NOT_TEXT,
  OFFSET_LABEL,
  ROUTE_ADD_ID,
  ROUTE_ADD_REASON_ID,
  ROUTE_DEFAULT_NONE_ID,
  RouterConfigBody,
  RULES_HEADER,
  RULES_NOTE,
  sanitizeRouteOffset,
  TARGET_GONE,
  TARGET_LABEL,
  type Route,
} from './RouterConfigBody.tsx';
import type { BeltDockView, BeltView, NodeView, PortView } from '../protocol/decode.ts';
import { selectedNodePortFlow, type PortFlow } from '../protocol/portFlow.ts';
import { machine_kind } from '../protocol/kinds.ts';

// Node env, no DOM: RouterConfigBody is a pure function (props in, callbacks
// out), invoked directly with its sub-parts inlined as render helpers, so the
// returned tree carries the real <button>/<input> nodes we walk (the
// DeleteControl direct-invocation discipline). A `<Segment/>` ELEMENT would
// appear in the tree as an opaque function type and every walk for a real
// button would return nothing WHILE STAYING GREEN.

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
/** THE LOAD-BEARING ONE: resolves a group by `aria-label` ONLY. A group named by
 *  reference (`aria-labelledby`) is INVISIBLE to this helper, and to the live
 *  Playwright resolver, which is why the component may never use one. */
function group(tree: unknown, label: string): El {
  const g = findAll(tree, (el) => el.props.role === 'group' && el.props['aria-label'] === label);
  expect(g, `group "${label}"`).toHaveLength(1);
  return g[0];
}
function buttons(scope: unknown): El[] {
  return findAll(scope, (el) => el.type === 'button');
}
function pressedSegments(scope: unknown): El[] {
  return findAll(scope, (el) => el.type === 'button' && hasClass(el, 'is-pressed'));
}
function segmentByLabel(scope: unknown, label: string): El {
  const b = findAll(scope, (el) => el.type === 'button' && textOf(el) === label);
  expect(b, `segment "${label}"`).toHaveLength(1);
  return b[0];
}

/** Resolve exactly one <button> by its ACCESSIBLE NAME. The per-rule controls
 *  carry a glyph as their visible text, so `aria-label` is the only handle a
 *  reader (or this walk) has on which rule they belong to. */
function controlByLabel(scope: unknown, label: string): El {
  const b = findAll(scope, (el) => el.type === 'button' && el.props['aria-label'] === label);
  expect(b, `control "${label}"`).toHaveLength(1);
  return b[0];
}

/** The append control, by its stable id. */
function addControl(tree: unknown): El {
  const b = findAll(tree, (el) => el.props.id === 'fab-route-add');
  expect(b, 'the append control').toHaveLength(1);
  return b[0];
}

function press(el: El): void {
  (el.props.onClick as () => void)();
}

const out = (index: number, x: number, y: number): PortView => ({
  index,
  cell_x: x,
  cell_y: y,
  side: 1,
  role: 1,
  medium: 0,
});
const inPort = (index: number, x: number, y: number): PortView => ({
  index,
  cell_x: x,
  cell_y: y,
  side: 3,
  role: 0,
  medium: 0,
});

/**
 * THE LOAD-BEARING FIXTURE: three Outs in PACKET order, which is NOT visual
 * order.
 *
 * The seating is the demo Router's as it shipped until plan 74.1-14: routing key 0
 * the BOTTOM nub, key 1 the TOP and key 2 the MIDDLE. It is FROZEN here on purpose.
 * Since 74.1-14 (the ruling of 2026-10-04, "Edits keep middle layout") every Router
 * seats key 0 on the MIDDLE row, key 1 below and key 2 above, which is just as far
 * from visual order; what this fixture must be is non-visual, and it is. A fixture
 * whose ports were listed in VISUAL order would be green under a correct editor AND
 * under one that numbers outputs top to bottom: it proves nothing. This one reddens
 * under the wrong editor, which is the entire reason it is seated this way. Since
 * phase 91 the editor numbers each output by its routing key (`Output N`), so the
 * number a segment shows is the key it raises, whatever row its nub sits on.
 */
const DEMO_PORTS: PortView[] = [
  inPort(0, 14, 1),
  out(1, 15, 2), // routing key 0 - the BOTTOM nub
  out(2, 15, 0), // routing key 1 - the TOP nub
  out(3, 15, 1), // routing key 2 - the MIDDLE nub
];
/** Phase 91 (D-12, UI-SPEC 8.6): each Out is named `Output N`, N its routing key + 1,
 *  never by its nub's cell. On this fixture Output 1 is the BOTTOM nub, Output 2 the
 *  TOP and Output 3 the MIDDLE, so a name derived from screen position reads wrong. */
const OUT1 = 'Output 1';
const OUT2 = 'Output 2';
const OUT3 = 'Output 3';

/** Two Outs, the shape a palette-placed Router had before the arity widening. */
const TWO_OUT_PORTS: PortView[] = [inPort(0, 14, 1), out(1, 15, 0), out(2, 15, 1)];

const rule = (port: number, expect_: number[] = [97], offset = 0): Route => [
  { offset, expect: expect_ },
  port,
];

const noop = (): void => {};

describe('RouterConfigBody - structure', () => {
  it('renders the segments as .fab-tool-btn buttons, never a native select', () => {
    const tree = RouterConfigBody({
      routes: [rule(0)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    // The non-zero found-count guard FIRST: a walker that found nothing would
    // otherwise report a clean "no select elements" pass over an empty tree,
    // which is the vacuous-absence shape this project has now hit repeatedly.
    expect(buttons(tree).length).toBeGreaterThan(0);
    expect(findAll(tree, (el) => el.type === 'input').length).toBeGreaterThan(0);
    expect(findAll(tree, (el) => el.type === 'select')).toHaveLength(0);

    const g = group(tree, `${TARGET_LABEL}, rule 1`);
    for (const label of [OUT1, OUT2, OUT3]) {
      expect(hasClass(segmentByLabel(g, label), 'fab-tool-btn')).toBe(true);
    }
  });
});

describe('RouterConfigBody - the routing-key contract', () => {
  it('presses Output 1 for a rule whose port is 0, whatever row its nub sits on', () => {
    const tree = RouterConfigBody({
      routes: [rule(0)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const g = group(tree, `${TARGET_LABEL}, rule 1`);
    const pressed = pressedSegments(g);
    expect(pressed.length).toBeGreaterThan(0);
    expect(pressed).toHaveLength(1);
    // MUTATION-PROVED, and the FIRST mutation tried was the wrong one, which is
    // recorded here because it is the failure shape this project keeps meeting.
    //
    //  - Replacing the display-order SORT with the packet-order list leaves this
    //    assertion GREEN: the pressed segment is still the one whose key is 0.
    //    That mutation reddens the display-order case below, not this one.
    //  - The mutation this case actually guards against is an editor that VALUES
    //    outputs by where they sit on screen: `keyOf = displayOrder.indexOf(p)`
    //    instead of `outs.indexOf(p)`. Under it this assertion failed with
    //    `expected '(15,0)' to be '(15,2)'` while segments were named by cell.
    expect(textOf(pressed[0])).toBe(OUT1);
  });

  it('renders the target segments by NUMBER, Output 1 first, never in screen order (phase 91, UI-SPEC 8.6)', () => {
    const tree = RouterConfigBody({
      routes: [rule(0)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const g = group(tree, `${TARGET_LABEL}, rule 1`);
    const segs = buttons(g);
    expect(segs.length).toBeGreaterThan(0);
    // Until phase 91 the segments ran top to bottom by nub cell; they are ordered by
    // routing key now, the order and the numbers the Outputs list shows.
    expect(segs.map(textOf)).toEqual([OUT1, OUT2, OUT3]);
    // The first segment is Output 1, the rule's target (routing key 0).
    expect(hasClass(segs[0], 'is-pressed')).toBe(true);
  });

  it('raises the segment PACKET-ORDER position as the rule port, never its display position', () => {
    for (const [label, expectedKey] of [
      [OUT1, 0],
      [OUT2, 1],
      [OUT3, 2],
    ] as const) {
      let got: Route[] | null = null;
      const tree = RouterConfigBody({
        routes: [rule(0)],
        fallback: null,
        ports: DEMO_PORTS,
        onChange: (routes) => {
          got = routes;
        },
      });
      const g = group(tree, `${TARGET_LABEL}, rule 1`);
      (segmentByLabel(g, label).props.onClick as () => void)();
      expect(got, `pressing "${label}" raised a table`).not.toBeNull();
      const raised = got as unknown as Route[];
      expect(raised).toHaveLength(1);
      expect(raised[0][1], `"${label}" is routing key ${expectedKey}`).toBe(expectedKey);
    }
  });
});

describe('RouterConfigBody - the single-select invariant', () => {
  it('keeps exactly one segment pressed in the Default group on an empty table', () => {
    const tree = RouterConfigBody({
      routes: [],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const g = group(tree, 'Default');
    const pressed = pressedSegments(g);
    expect(pressed.length).toBeGreaterThan(0);
    expect(pressed).toHaveLength(1);
    // `None (fault)` leads and is the pressed one on an unconfigured Router, so
    // "no default" is always expressible.
    expect(textOf(buttons(g)[0])).toBe(NO_DEFAULT_SEGMENT);
    expect(textOf(pressed[0])).toBe(NO_DEFAULT_SEGMENT);
  });

  it('keeps exactly one pressed in each rule group and in the Default group on a populated table', () => {
    const tree = RouterConfigBody({
      routes: [rule(0), rule(2, [98])],
      fallback: 1,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    for (const [n, label] of [
      [1, OUT1],
      [2, OUT3],
    ] as const) {
      const g = group(tree, `${TARGET_LABEL}, rule ${n}`);
      const pressed = pressedSegments(g);
      expect(pressed.length).toBeGreaterThan(0);
      expect(pressed).toHaveLength(1);
      expect(textOf(pressed[0])).toBe(label);
    }
    const def = group(tree, 'Default');
    const defPressed = pressedSegments(def);
    expect(defPressed.length).toBeGreaterThan(0);
    expect(defPressed).toHaveLength(1);
    expect(textOf(defPressed[0])).toBe(OUT2);
  });

  it('renders the rules in BUFFER order, which is the evaluation order', () => {
    const tree = RouterConfigBody({
      routes: [rule(0, [97]), rule(1, [98])],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const markers = findAll(tree, (el) => typeof el.props.id === 'string' &&
      (el.props.id as string).startsWith('fab-route-rule-label-'));
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.map(textOf)).toEqual(['Rule 1', 'Rule 2']);
  });
});

describe('RouterConfigBody - the arity is DERIVED from the node, not restated', () => {
  it('renders one segment per live Out: two on a two-Out node, three on a three-Out node', () => {
    const two = RouterConfigBody({
      routes: [rule(0)],
      fallback: null,
      ports: TWO_OUT_PORTS,
      onChange: noop,
    });
    const twoSegs = buttons(group(two, `${TARGET_LABEL}, rule 1`));
    expect(twoSegs.length).toBeGreaterThan(0);
    expect(twoSegs).toHaveLength(2);

    // The SAME unmodified component, three Outs. A body that hard-coded a count
    // fails the two-Out case above, and this is the pair that says so.
    const three = RouterConfigBody({
      routes: [rule(0)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const threeSegs = buttons(group(three, `${TARGET_LABEL}, rule 1`));
    expect(threeSegs).toHaveLength(3);
  });

  // The two grep halves of the no-restated-number lock. They see what the
  // behavioural case above cannot: a constant that happens to agree with the
  // fixture today and drifts tomorrow.
  const SRC_DIR = join(__dirname, '..');
  /** A DECLARATION of the arity, not a mention of it. Scoped this way on
   *  purpose: a prose comment elsewhere in the tree that discusses the Rust
   *  constant must not make this check permanently red. */
  const ARITY_DECLARATION = /(?:const|let|var|enum|function|interface|type)\s+ROUTER_OUT_ARITY\b/;

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) found.push(...sourceFiles(full));
      else if (/\.(ts|tsx)$/.test(e.name)) found.push(full);
    }
    return found;
  }

  it('names no arity constant in the component file itself', () => {
    const src = readFileSync(join(__dirname, 'RouterConfigBody.tsx'), 'utf8');
    expect(src.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/ROUTER_OUT_ARITY/);
  });

  it('finds no module under frontend/src DECLARING a router out-arity constant', () => {
    const files = sourceFiles(SRC_DIR);
    // The walk must have reached something, or this proves an absence by
    // looking at nothing.
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => ARITY_DECLARATION.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('RouterConfigBody - the pattern buffer holds WIRE BYTES, never a string', () => {
  /** `0xff` is not valid UTF-8. Decoding it yields U+FFFD, and re-encoding
   *  U+FFFD yields the THREE bytes `ef bf bd` - so a body that held the pattern
   *  as a string would rewrite a rule the user never typed in, through a
   *  certified, replayable Configure. */
  const RAW: number[] = [0xff];

  it('leaves an untouched non-text pattern byte-identical when another control changes', () => {
    // MUTATION-PROVED. Substituting a STRING buffer - re-encoding each rule's
    // key from its decoded display text before raising it - reddens this case
    // with the observed value `[239, 191, 189]` (`ef bf bd`) where `[255]` was
    // expected. Without that record this test is indistinguishable from one that
    // never exercised the decode at all.
    let got: Route[] | null = null;
    const tree = RouterConfigBody({
      routes: [rule(0, RAW), rule(1, [98])],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: (routes) => {
        got = routes;
      },
    });

    // Touch a DIFFERENT control entirely: the Default group.
    (segmentByLabel(group(tree, 'Default'), OUT2).props.onClick as () => void)();
    expect(got, 'the Default press raised a table').not.toBeNull();
    let raised = got as unknown as Route[];
    expect(raised).toHaveLength(2);
    expect(raised[0][0].expect).toEqual(RAW);
    expect(raised[0][0].expect).toHaveLength(1);

    // And touch this rule's OWN other field, the offset.
    got = null;
    const offset = findAll(tree, (el) => el.props.id === 'fab-route-offset-0');
    expect(offset).toHaveLength(1);
    (offset[0].props.onChange as (e: unknown) => void)({ currentTarget: { value: '4' } });
    raised = got as unknown as Route[];
    expect(raised[0][0].offset).toBe(4);
    expect(raised[0][0].expect).toEqual(RAW);
  });

  it('still displays a non-text pattern rather than throwing, and marks that rule not-text', () => {
    const tree = RouterConfigBody({
      routes: [rule(0, RAW), rule(1, [98])],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const shown = findAll(tree, (el) => el.props.id === 'fab-route-expect-0');
    expect(shown).toHaveLength(1);
    expect(typeof shown[0].props.value).toBe('string');
    // The lossy MARK, which plan 65-03 hangs the visible disclosure note off.
    const marked = findAll(tree, (el) => el.props['data-fab-route-lossy'] === 'true');
    expect(marked.length).toBeGreaterThan(0);
    expect(marked).toHaveLength(1);
    // A rule whose pattern IS text carries no mark.
    const all = findAll(tree, (el) => 'data-fab-route-lossy' in el.props);
    expect(all.length).toBeGreaterThan(1);
    expect(all.filter((el) => el.props['data-fab-route-lossy'] === 'true')).toHaveLength(1);
  });

  it('replaces only the typed rule bytes and leaves every other rule untouched', () => {
    let got: Route[] | null = null;
    const tree = RouterConfigBody({
      routes: [rule(0, RAW), rule(1, [98])],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: (routes) => {
        got = routes;
      },
    });
    const typed = findAll(tree, (el) => el.props.id === 'fab-route-expect-1');
    expect(typed).toHaveLength(1);
    (typed[0].props.onChange as (e: unknown) => void)({ currentTarget: { value: 'hi' } });
    const raised = got as unknown as Route[];
    // UTF-8 of "hi".
    expect(raised[1][0].expect).toEqual([104, 105]);
    // The untouched sibling still carries its raw byte.
    expect(raised[0][0].expect).toEqual(RAW);
  });

  it('accepts an EMPTY pattern as a legal catch-all rather than blocking it', () => {
    let got: Route[] | null = null;
    const tree = RouterConfigBody({
      routes: [rule(0, [97])],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: (routes) => {
        got = routes;
      },
    });
    const typed = findAll(tree, (el) => el.props.id === 'fab-route-expect-0');
    expect(typed).toHaveLength(1);
    (typed[0].props.onChange as (e: unknown) => void)({ currentTarget: { value: '' } });
    const raised = got as unknown as Route[];
    expect(raised).toHaveLength(1);
    // An empty `expect` matches everything at any offset. It is a rule a user
    // may genuinely want, so it raises an empty array and carries no note.
    expect(raised[0][0].expect).toEqual([]);
  });
});

describe('sanitizeRouteOffset - the u16 clamp at the keystroke', () => {
  it('maps every failure shape the varint walk mangles onto an integer in the u16 range', () => {
    // The BOUNDARY, not a happy path: a single well-formed case is blind to
    // every one of these. The native min/max attributes are advisory only.
    const CASES: ReadonlyArray<readonly [string, number]> = [
      ['', 0],
      ['abc', 0],
      ['-5', 0],
      ['1.9', 1],
      ['70000', 65535],
      ['65535', 65535],
    ];
    expect(CASES.length).toBe(6);
    for (const [raw, expected] of CASES) {
      const got = sanitizeRouteOffset(raw);
      expect(got, `sanitizeRouteOffset(${JSON.stringify(raw)})`).toBe(expected);
      expect(Number.isInteger(got)).toBe(true);
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThanOrEqual(65535);
    }
    // The ceiling is PRESERVED exactly, not clamped down to 65534.
    expect(sanitizeRouteOffset('65535')).toBe(65535);
  });
});

describe('the At byte field is text with a numeric keyboard (CHROME-14, D-08, A14)', () => {
  const offsetOf = (onChange: (routes: Route[]) => void = () => {}) =>
    findAll(
      RouterConfigBody({ routes: [rule(0)], fallback: null, ports: DEMO_PORTS, onChange }),
      (el) => el.props.id === 'fab-route-offset-0',
    );

  it('is type text, inputMode numeric, with no min or max, so no native spinner draws', () => {
    const offset = offsetOf();
    expect(offset).toHaveLength(1);
    expect(offset[0].type).toBe('input');
    expect(offset[0].props.type).toBe('text');
    expect(offset[0].props.inputMode).toBe('numeric');
    expect(offset[0].props.min).toBeUndefined();
    expect(offset[0].props.max).toBeUndefined();
    expect(offset[0].props.className).toBe('fab-field');
  });

  it('commits what sanitizeRouteOffset gives for typed text: 12.7 and abc', () => {
    for (const [raw, want] of [
      ['12.7', 12],
      ['abc', 0],
    ] as const) {
      let got: Route[] | null = null;
      const offset = offsetOf((routes) => {
        got = routes;
      });
      (offset[0].props.onChange as (e: unknown) => void)({ currentTarget: { value: raw } });
      const raised = got as unknown as Route[];
      expect(raised[0][0].offset, `typing ${JSON.stringify(raw)}`).toBe(want);
      expect(raised[0][0].offset).toBe(sanitizeRouteOffset(raw));
    }
  });
});

describe('encodeExpect - the pattern cap at the keystroke', () => {
  /** The one place this file names the number. Everything below derives from
   *  the exported constant, so a cap change cannot leave a stale literal here
   *  asserting the old ceiling. */
  const CAP = MAX_ROUTE_EXPECT_BYTES;

  it('passes an at-cap ASCII pattern through byte-identically', () => {
    const at = 'a'.repeat(CAP);
    expect(encodeExpect(at)).toHaveLength(CAP);
    // The ceiling is PRESERVED exactly, not clamped down to CAP - 1 (the
    // `sanitizeRouteOffset('65535')` boundary discipline). `command.rs` proves
    // the same value legal on the Rust side: "a pattern of exactly
    // MAX_ROUTE_EXPECT_BYTES is legal".
    expect(encodeExpect(at)[CAP - 1]).toBe(97);
  });

  it('clamps an over-cap ASCII pattern to exactly the cap', () => {
    // MUTATION-PROVED. Restoring the unclamped body
    // (`return Array.from(new TextEncoder().encode(text))`) reddens this case
    // with the observed message:
    //
    //   AssertionError: expected 5000 to be less than or equal to 1024
    //
    // which is the byte count that would have ridden into a certified
    // `Configure` and been refused wholesale at the command layer.
    const over = encodeExpect('a'.repeat(5000));
    expect(over.length).toBeLessThanOrEqual(CAP);
    expect(over).toHaveLength(CAP);
  });

  it('cuts multi-byte text on a codepoint boundary, never mid-sequence', () => {
    // THE CASE `maxLength` ALONE CANNOT REACH, and the reason the byte clamp is
    // the real fence: every one of these characters is THREE UTF-8 bytes, so a
    // string well inside a 1024-CODE-UNIT `maxLength` is far past a 1024-BYTE
    // cap. CAP is not divisible by 3, so the naive cut lands INSIDE a sequence.
    //
    // MUTATION-PROVED. Dropping the continuation-byte walk
    // (`while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;`) reddens the
    // lossy assertion below with the observed message:
    //
    //   AssertionError: the clamped bytes are still valid text:
    //   expected true to be false // Object.is equality
    //
    // read as: `lossy` came back true. A split sequence makes `decodeExpect`
    // mark the whole pattern not-text and paint U+FFFD into a field the user
    // typed real characters into.
    const clamped = encodeExpect('中'.repeat(1000));
    expect(clamped.length).toBeLessThanOrEqual(CAP);
    // The round trip FIRST, because it is the consequence a user would meet.
    const back = decodeExpect(clamped);
    expect(back.lossy, 'the clamped bytes are still valid text').toBe(false);
    expect(back.text).toBe('中'.repeat(341));
    // 1024 / 3 = 341 whole characters, so the cut sits one byte short of CAP.
    expect(clamped).toHaveLength(341 * 3);
  });

  it('bounds the Match field at the keyboard, from the constant and not a literal', () => {
    const tree = RouterConfigBody({
      routes: [rule(0)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const pattern = findAll(tree, (el) => el.props.id === 'fab-route-expect-0');
    expect(pattern, 'the Match text input').toHaveLength(1);
    // MUTATION-PROVED. Removing `maxLength={opts?.maxLength}` from the field
    // helper reddens this with the observed message:
    //
    //   AssertionError: the Match field is bounded at the keyboard:
    //   expected undefined to be 1024 // Object.is equality
    //
    // The user is then stopped at Apply by the command layer instead of at the
    // keystroke, which is the worse of the two places to be told.
    expect(pattern[0].props.maxLength, 'the Match field is bounded at the keyboard').toBe(CAP);

    // The offset field is a SEPARATE bound (its own u16 sanitizer) and must not
    // inherit a byte cap that means nothing for a numeric field.
    const offset = findAll(tree, (el) => el.props.id === 'fab-route-offset-0');
    expect(offset).toHaveLength(1);
    expect(offset[0].props.maxLength).toBeUndefined();
  });
});

describe('RouterConfigBody - order is editable, because order IS the behaviour', () => {
  it('appends a rule targeting Output 1, the first segment shown, empty pattern, zero offset', () => {
    let got: Route[] | null = null;
    const tree = RouterConfigBody({
      routes: [rule(0)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: (routes) => {
        got = routes;
      },
    });
    press(addControl(tree));
    expect(got, 'the append raised a table').not.toBeNull();
    const raised = got as unknown as Route[];
    expect(raised).toHaveLength(2);
    expect(raised[0]).toEqual([{ offset: 0, expect: [97] }, 0]);
    expect(raised[1][0]).toEqual({ offset: 0, expect: [] });
    // Phase 91: the new rule targets the FIRST segment shown, which is Output 1,
    // routing key 0 (until then the first segment was the topmost nub, key 1 here).
    expect(raised[1][1]).toBe(0);
  });

  it('deletes rule two and leaves rules one and three in that order', () => {
    let got: Route[] | null = null;
    const tree = RouterConfigBody({
      routes: [rule(0, [97]), rule(1, [98]), rule(2, [99])],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: (routes) => {
        got = routes;
      },
    });
    press(controlByLabel(tree, 'Delete rule 2'));
    const raised = got as unknown as Route[];
    expect(raised).toHaveLength(2);
    expect(raised.map((r) => r[0].expect)).toEqual([[97], [99]]);
    expect(raised.map((r) => r[1])).toEqual([0, 2]);
  });

  it('gives every delete control a POSITIONAL id, which is what focus can address', () => {
    const tree = RouterConfigBody({
      routes: [rule(0), rule(1), rule(2)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    // Without these ids there is nothing for the layout effect to focus, so the
    // whole restore below would be unimplementable rather than merely wrong.
    expect(controlByLabel(tree, 'Delete rule 1').props.id).toBe('fab-route-delete-0');
    expect(controlByLabel(tree, 'Delete rule 2').props.id).toBe('fab-route-delete-1');
    expect(controlByLabel(tree, 'Delete rule 3').props.id).toBe('fab-route-delete-2');
    // The two anchors the chain falls through to, both addressable.
    expect(addControl(tree).props.id).toBe(ROUTE_ADD_ID);
    expect(segmentByLabel(group(tree, DEFAULT_HEADER), NO_DEFAULT_SEGMENT).props.id).toBe(
      ROUTE_DEFAULT_NONE_ID,
    );
  });

  it('names where focus goes after a delete, and never leaves the panel', () => {
    // The onDeleted seam, invoked directly. This is as far as the node env can
    // go: no DOM means no `document.activeElement`, so it can see WHICH control
    // should take focus but not whether focus lands there. That half is
    // `e2e/router-panel.spec.ts`.
    //
    // MUTATION-PROVED. Dropping the `onDeleted?.(candidates)` call from
    // `deleteRule`, which is the shipped pre-fix behaviour, reddens the first
    // case with the observed message:
    //
    //   AssertionError: a delete names its focus candidates:
    //   expected [] to deeply equal [ [ 'fab-route-delete-1', …(2) ] ]
    //
    // An empty candidate list is exactly what "focus fell to document.body"
    // looks like from here: nothing was named, so nothing can be focused, and
    // the next Tab restarts at the top of the document instead of continuing
    // inside the panel.
    const run = (routes: Route[], label: string, ports = DEMO_PORTS): string[][] => {
      const seen: string[][] = [];
      const tree = RouterConfigBody({
        routes,
        fallback: null,
        ports,
        onChange: noop,
        onDeleted: (ids) => seen.push([...ids]),
      });
      press(controlByLabel(tree, label));
      return seen;
    };

    // INTERIOR: rule 3 of 3 slides nothing into slot 2, so focus goes to the
    // rule ABOVE. Deleting the LAST rule is the exact case the review reported:
    // "Tab to Delete rule 3, press Enter".
    expect(
      run([rule(0), rule(1), rule(2)], 'Delete rule 3'),
      'a delete names its focus candidates',
    ).toEqual([['fab-route-delete-1', ROUTE_ADD_ID, ROUTE_DEFAULT_NONE_ID]]);

    // FIRST OF THREE: rule 2 slides up into slot 0, so the control under the
    // finger stays put and a second press deletes the next rule down.
    expect(run([rule(0), rule(1), rule(2)], 'Delete rule 1')).toEqual([
      ['fab-route-delete-0', ROUTE_ADD_ID, ROUTE_DEFAULT_NONE_ID],
    ]);

    // THE ONLY RULE: the list empties, so no delete control survives at all and
    // the chain falls through to the append control.
    expect(run([rule(0)], 'Delete rule 1')).toEqual([
      [ROUTE_ADD_ID, ROUTE_DEFAULT_NONE_ID],
    ]);

    // STATE 8: a zero-Out Router still carrying a saved table. `+ Add rule` is
    // `disabled` there and a disabled button cannot hold focus, which is why
    // the chain does not end at it. `None (fault)` is never disabled.
    const NO_OUT_PORTS: PortView[] = [inPort(0, 14, 1)];
    expect(run([rule(0)], 'Delete rule 1', NO_OUT_PORTS)).toEqual([
      [ROUTE_ADD_ID, ROUTE_DEFAULT_NONE_ID],
    ]);
  });

  it('moves rule two up, carrying every field value with the rule', () => {
    let got: Route[] | null = null;
    const tree = RouterConfigBody({
      routes: [rule(0, [97], 1), rule(2, [98], 5)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: (routes) => {
        got = routes;
      },
    });
    press(controlByLabel(tree, 'Move rule 2 up'));
    const raised = got as unknown as Route[];
    expect(raised).toHaveLength(2);
    // The whole rule travels: pattern bytes, offset and target all move together,
    // because the rule IS its array entry. A body that moved only the pattern
    // would leave the table meaning something the user never wrote.
    expect(raised[0]).toEqual([{ offset: 5, expect: [98] }, 2]);
    expect(raised[1]).toEqual([{ offset: 1, expect: [97] }, 0]);
  });

  it('moves rule one down, which is the same swap addressed from the other side', () => {
    let got: Route[] | null = null;
    const tree = RouterConfigBody({
      routes: [rule(0, [97], 1), rule(2, [98], 5)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: (routes) => {
        got = routes;
      },
    });
    press(controlByLabel(tree, 'Move rule 1 down'));
    const raised = got as unknown as Route[];
    expect(raised[0]).toEqual([{ offset: 5, expect: [98] }, 2]);
    expect(raised[1]).toEqual([{ offset: 1, expect: [97] }, 0]);
  });

  it('disables BOTH move controls when there is exactly one rule', () => {
    const tree = RouterConfigBody({
      routes: [rule(0)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    expect(controlByLabel(tree, 'Move rule 1 up').props.disabled).toBe(true);
    expect(controlByLabel(tree, 'Move rule 1 down').props.disabled).toBe(true);
    // Deleting the only rule is legal: an empty table is a legal state.
    expect(controlByLabel(tree, 'Delete rule 1').props.disabled).toBe(false);
  });

  it('disables only the first up and the last down when there are three rules', () => {
    const tree = RouterConfigBody({
      routes: [rule(0), rule(1), rule(2)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const state = (label: string): unknown => controlByLabel(tree, label).props.disabled;
    expect(state('Move rule 1 up')).toBe(true);
    expect(state('Move rule 3 down')).toBe(true);
    for (const label of [
      'Move rule 1 down',
      'Move rule 2 up',
      'Move rule 2 down',
      'Move rule 3 up',
    ]) {
      expect(state(label), label).toBe(false);
    }
  });

  it('gives the two move controls ids that encode the rule POSITION, not the press', () => {
    const tree = RouterConfigBody({
      routes: [rule(0), rule(1)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    // The focus restore addresses the button at the moved rule's NEW index, so
    // it needs a handle that is positional. Without these ids there is nothing
    // for the layout effect to focus.
    expect(controlByLabel(tree, 'Move rule 1 up').props.id).toBe('fab-route-move-up-0');
    expect(controlByLabel(tree, 'Move rule 2 up').props.id).toBe('fab-route-move-up-1');
    expect(controlByLabel(tree, 'Move rule 1 down').props.id).toBe('fab-route-move-down-0');
    expect(controlByLabel(tree, 'Move rule 2 down').props.id).toBe('fab-route-move-down-1');
  });

  it('names the control the moved rule ARRIVES at, which is what focus must follow', () => {
    // The onMoved seam, invoked directly. This is as far as the node env can
    // go: it has no DOM, so it can see WHICH control should take focus but not
    // whether focus actually lands there. That half is `e2e/router-panel.spec.ts`.
    //
    // MUTATION-PROVED. Naming the PRESSED index instead of the arrival index
    // (`moveUpId(i)` for `moveUpId(j)`) reddens this case with the observed
    // message:
    //
    //   expected [ 'fab-route-move-up-1', ...(1) ] to deeply equal
    //            [ 'fab-route-move-up-0', ...(1) ]
    //
    // which is precisely the shuffle a keyboard user gets: press up on rule 2,
    // and the focused button is the one that now belongs to rule 1's old
    // contents, so the next press moves a DIFFERENT rule back down.
    const moved: string[][] = [];
    const tree = RouterConfigBody({
      routes: [rule(0), rule(1), rule(2)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
      onMoved: (id, fallback) => moved.push([id, fallback]),
    });
    press(controlByLabel(tree, 'Move rule 2 up'));
    press(controlByLabel(tree, 'Move rule 2 down'));
    // The arrival control first, then the moved rule's OTHER control. The
    // fallback is not defensive padding: at index 0 the up control is disabled
    // and at the last index the down control is, and a disabled button cannot
    // hold focus. Walking a rule to the top and losing focus to the document
    // body on the last press is the defect this pair exists to prevent.
    expect(moved).toEqual([
      ['fab-route-move-up-0', 'fab-route-move-down-0'],
      ['fab-route-move-down-2', 'fab-route-move-up-2'],
    ]);
  });

  it('renders three controls per rule block and adds no destructive affordance', () => {
    const tree = RouterConfigBody({
      routes: [rule(0), rule(1)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    for (const n of [1, 2]) {
      for (const label of [`Move rule ${n} up`, `Move rule ${n} down`, `Delete rule ${n}`]) {
        const btn = controlByLabel(tree, label);
        expect(hasClass(btn, 'fab-tool-btn'), label).toBe(true);
        // The shipped REMOVE_BTN_STYLE zeroing: keeps the class 44px minimums
        // without adding a padding declaration that reaches the bezel ring.
        expect((btn.props.style as Record<string, unknown>).padding, label).toBe(0);
      }
    }
    // The glyphs are the font-subset-probed ones: arrows, never triangles.
    expect(textOf(controlByLabel(tree, 'Move rule 1 up'))).toBe('↑');
    expect(textOf(controlByLabel(tree, 'Move rule 1 down'))).toBe('↓');
    expect(textOf(controlByLabel(tree, 'Delete rule 1'))).toBe('×');
  });
});

describe('RouterConfigBody - the states a SAVED board can reach', () => {
  /** `0xff` is not valid UTF-8, so the strict decode throws and the rule is
   *  marked not-text. */
  const RAW: number[] = [0xff];

  it('discloses a not-text pattern by DESCRIPTION, and marks nothing invalid', () => {
    const tree = RouterConfigBody({
      routes: [rule(0, RAW), rule(1, [98])],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const shown = findAll(tree, (el) => el.props.id === 'fab-route-expect-0');
    expect(shown).toHaveLength(1);
    const noteId = shown[0].props['aria-describedby'];
    // MUTATION-PROVED, and this is the assertion that matters rather than the
    // note's mere presence: dropping the field's description link while STILL
    // rendering the note reddens this with the observed message
    // `expected 'undefined' to be 'string'`. A note that is on screen but not
    // linked is invisible to the reader who most needs it.
    expect(typeof noteId, 'the lossy field points at its note').toBe('string');

    const note = findAll(tree, (el) => el.props.id === noteId);
    expect(note).toHaveLength(1);
    expect(textOf(note[0])).toBe(NOT_TEXT);

    // The stored value is VALID, it is simply not text. `aria-invalid` would
    // tell a screen reader the user made a mistake they did not make, and a
    // destructive border would say the same thing in colour.
    expect(findAll(tree, (el) => 'aria-invalid' in el.props)).toHaveLength(0);
    expect(findAll(tree, (el) => el.props.role === 'alert')).toHaveLength(0);

    // The rule whose pattern IS text carries no note and no link.
    const plain = findAll(tree, (el) => el.props.id === 'fab-route-expect-1');
    expect(plain).toHaveLength(1);
    expect(plain[0].props['aria-describedby']).toBeUndefined();
    expect(findAll(tree, (el) => textOf(el) === NOT_TEXT && el.type === 'span')).toHaveLength(1);
  });

  it('renders ONE extra trailing pressed segment for a rule naming a dead output', () => {
    // Routing key 3 is past a 3-Out list. This is a table a saved board can
    // carry: grow a Router, configure it, shrink it, reopen.
    const tree = RouterConfigBody({
      routes: [rule(3)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const g = group(tree, `${TARGET_LABEL}, rule 1`);
    const segs = buttons(g);
    expect(segs.length).toBeGreaterThan(0);
    // Three live Outs plus the one extra, and the extra is LAST.
    //
    // MUTATION-PROVED. Deleting the extra segment reddens this case AND the
    // zero-Out-with-rules case below, with the observed messages:
    //
    //   expected [ '(15,0)', '(15,1)', '(15,2)' ] to deeply equal (cell names, before phase 91)
    //            [ '(15,0)', '(15,1)', '(15,2)', ...(1) ]
    //   expected [] to deeply equal [ 'Missing output' ]
    //
    // Under that mutation the group renders with NOTHING pressed, which reads
    // as "no target chosen" while a target is in fact stored.
    expect(segs.map(textOf)).toEqual([OUT1, OUT2, OUT3, MISSING_SEGMENT]);

    // The single-select invariant is PRESERVED by that segment, not broken by
    // it: without it the group would render with nothing pressed at all.
    const pressed = pressedSegments(g);
    expect(pressed.length).toBeGreaterThan(0);
    expect(pressed).toHaveLength(1);
    expect(textOf(pressed[0])).toBe(MISSING_SEGMENT);

    const gone = findAll(tree, (el) => textOf(el) === TARGET_GONE && el.type === 'span');
    expect(gone).toHaveLength(1);
  });

  it('drops the extra segment as soon as a real one is pressed', () => {
    let got: Route[] | null = null;
    const tree = RouterConfigBody({
      routes: [rule(3)],
      fallback: null,
      ports: DEMO_PORTS,
      onChange: (routes) => {
        got = routes;
      },
    });
    press(segmentByLabel(group(tree, `${TARGET_LABEL}, rule 1`), OUT3));
    const raised = got as unknown as Route[];
    expect(raised).toHaveLength(1);
    expect(raised[0][1]).toBe(2);

    // Re-invoke with the raised table, which is what the parent buffer does.
    const after = RouterConfigBody({
      routes: raised,
      fallback: null,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const g = group(after, `${TARGET_LABEL}, rule 1`);
    expect(buttons(g).map(textOf)).toEqual([OUT1, OUT2, OUT3]);
    expect(pressedSegments(g)).toHaveLength(1);
    expect(textOf(pressedSegments(g)[0])).toBe(OUT3);
    expect(findAll(after, (el) => textOf(el) === TARGET_GONE && el.type === 'span')).toHaveLength(0);
  });

  it('treats a DEFAULT naming a dead output identically, and says so on the fallthrough line', () => {
    const tree = RouterConfigBody({
      routes: [],
      fallback: 7,
      ports: DEMO_PORTS,
      onChange: noop,
    });
    const def = group(tree, DEFAULT_HEADER);
    expect(buttons(def).map(textOf)).toEqual([
      NO_DEFAULT_SEGMENT,
      OUT1,
      OUT2,
      OUT3,
      MISSING_SEGMENT,
    ]);
    const pressed = pressedSegments(def);
    expect(pressed.length).toBeGreaterThan(0);
    expect(pressed).toHaveLength(1);
    expect(textOf(pressed[0])).toBe(MISSING_SEGMENT);

    // The fallthrough line is ALWAYS present and its text changes with the
    // default. Here neither the fault sentence nor the names-an-output sentence is
    // true, so it carries the disclosure the group already points at.
    //
    // MUTATION-PROVED. Collapsing the three-way choice back to the shipped
    // two-way ternary reddens this with the observed message:
    //
    //   expected 'Items matching no rule are faulted an...' to be
    //            'That output is gone. Choose another.'
    //
    // That sentence is the one 65-02 recorded as the state it left behind.
    const line = findAll(tree, (el) => el.props.id === 'fab-route-fallthrough');
    expect(line).toHaveLength(1);
    expect(textOf(line[0])).toBe(TARGET_GONE);
    expect(def.props['aria-describedby']).toBe('fab-route-fallthrough');
  });

  it('takes a Router with NO Out ports without throwing, and says why it cannot append', () => {
    const NO_OUT_PORTS: PortView[] = [inPort(0, 14, 1)];
    const tree = RouterConfigBody({
      routes: [],
      fallback: null,
      ports: NO_OUT_PORTS,
      onChange: noop,
    });

    const add = addControl(tree);
    expect(add.props.disabled).toBe(true);
    expect(add.props['aria-describedby']).toBe(ROUTE_ADD_REASON_ID);
    const reason = findAll(tree, (el) => el.props.id === ROUTE_ADD_REASON_ID);
    expect(reason).toHaveLength(1);
    expect(textOf(reason[0])).toBe(NO_OUTPUTS);

    // The Default group is its no-default segment ALONE, which is correct
    // rather than degenerate, and it is still the pressed one.
    const def = group(tree, DEFAULT_HEADER);
    expect(buttons(def).map(textOf)).toEqual([NO_DEFAULT_SEGMENT]);
    expect(pressedSegments(def)).toHaveLength(1);
    expect(textOf(def)).toContain(NO_DEFAULT_SEGMENT);

    // And the empty-table row is still the legal state it always was.
    expect(textOf(tree)).toContain(NO_RULES);
  });

  it('renders a zero-Out Router that already carries rules, still without throwing', () => {
    const NO_OUT_PORTS: PortView[] = [inPort(0, 14, 1)];
    const tree = RouterConfigBody({
      routes: [rule(0), rule(1)],
      fallback: 0,
      ports: NO_OUT_PORTS,
      onChange: noop,
    });
    for (const n of [1, 2]) {
      const g = group(tree, `${TARGET_LABEL}, rule ${n}`);
      expect(buttons(g).map(textOf)).toEqual([MISSING_SEGMENT]);
      expect(pressedSegments(g)).toHaveLength(1);
    }
  });
});

// The copy contract, DUPLICATED here on purpose and never imported from the map
// it validates (the `kindNames.test.ts` idiom). A test that read the strings out
// of the module would agree with any string the module happened to hold.
describe('RouterConfigBody - the copy contract, pinned verbatim', () => {
  const COPY_CONTRACT: Record<string, string> = {
    RULES_HEADER: 'Rules',
    DEFAULT_HEADER: 'Default',
    RULES_NOTE: 'The first rule that matches wins. Output numbers match the Outputs list below.',
    NO_RULES: 'No rules yet.',
    ADD_RULE_LABEL: '+ Add rule',
    EXPECT_LABEL: 'Match text',
    OFFSET_LABEL: 'At byte',
    TARGET_LABEL: 'Send to',
    NO_DEFAULT_SEGMENT: 'None (fault)',
    MISSING_SEGMENT: 'Missing output',
    NOT_TEXT: 'These bytes are not text. Editing this field replaces them.',
    TARGET_GONE: 'That output is gone. Choose another.',
    NO_OUTPUTS: 'This machine has no outputs to send to.',
    // MOVED in phase 71 (PILE-10). The old line, 'Items matching no rule are faulted
    // and go no further.', was true when a Router had no `Role::Fault` nub for a belt
    // to reach. It now has one, so the copy names the exit and tells the user the one
    // gesture that catches the fallthrough.
    FALLTHROUGH_FAULT:
      'Items matching no rule leave on the fault port. Draw a belt from it to catch them.',
    "fallthroughTo('Output 3 (Sink)')": 'Items matching no rule go to Output 3 (Sink).',
    "fallthroughTo('Output 2')": 'Items matching no rule go to Output 2.',
    "outputName(2, 'Merge input 2')": 'Output 2 (Merge input 2)',
    'outputName(3, null)': 'Output 3',
    'moveUpLabel(1)': 'Move rule 1 up',
    'moveDownLabel(1)': 'Move rule 1 down',
    'deleteRuleLabel(1)': 'Delete rule 1',
  };

  // Built per test, never at collection: a function missing from the module (the red-first
  // run at PHASE91_START, which has no `outputName`) then fails its own cases instead of
  // the whole file.
  const shipped = (): Record<string, string> => ({
    RULES_HEADER,
    DEFAULT_HEADER,
    RULES_NOTE,
    NO_RULES,
    ADD_RULE_LABEL,
    EXPECT_LABEL,
    OFFSET_LABEL,
    TARGET_LABEL,
    NO_DEFAULT_SEGMENT,
    MISSING_SEGMENT,
    NOT_TEXT,
    TARGET_GONE,
    NO_OUTPUTS,
    FALLTHROUGH_FAULT,
    "fallthroughTo('Output 3 (Sink)')": fallthroughTo('Output 3 (Sink)'),
    "fallthroughTo('Output 2')": fallthroughTo('Output 2'),
    "outputName(2, 'Merge input 2')": outputName(2, 'Merge input 2'),
    'outputName(3, null)': outputName(3, null),
    'moveUpLabel(1)': moveUpLabel(1),
    'moveDownLabel(1)': moveDownLabel(1),
    'deleteRuleLabel(1)': deleteRuleLabel(1),
  });

  it('matches the 65-UI-SPEC Copywriting Contract for every string', () => {
    expect(Object.keys(COPY_CONTRACT).length).toBe(21);
    const SHIPPED = shipped();
    expect(Object.keys(SHIPPED).sort()).toEqual(Object.keys(COPY_CONTRACT).sort());
    for (const [name, copy] of Object.entries(COPY_CONTRACT)) {
      expect(SHIPPED[name], name).toBe(copy);
    }
  });

  it('contains no em dash in any string', () => {
    // Spelled as an escape rather than the raw character, so this file is
    // itself clean under the project-wide grep the ban is enforced with.
    for (const [name, copy] of Object.entries(shipped())) {
      expect(copy.includes('\u2014'), `${name} has no em dash`).toBe(false);
    }
  });

  it('contains no en dash in any string', () => {
    for (const [name, copy] of Object.entries(shipped())) {
      expect(copy.includes('\u2013'), `${name} has no en dash`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ROUTER OUTPUTS HAVE NAMES (phase 91, D-12, CHROME-13, UI-SPEC 8.6). Each Out is
// `Output N`, N its routing key + 1, plus ` (Target)` when its belt reaches a machine:
// that machine's KIND_NAMES name, plus ` input K` when it has two or more Ins, followed
// through joined belts. The flow is built by the REAL fold (`selectedNodePortFlow`)
// from belts and docks, so the walk and the names are graded together.
// ---------------------------------------------------------------------------
describe('RouterConfigBody - outputs are named by number and target, never by cell (CHROME-13)', () => {
  const ROUTER: NodeView = {
    id: 7,
    kind: machine_kind.ROUTER,
    cell_x: 14,
    cell_y: 0,
    state: 1,
    w: 2,
    h: 3,
    rot: 0,
    ports: DEMO_PORTS,
    load: 0,
  };
  const node = (id: number, kind: number, ports: PortView[]): NodeView => ({ ...ROUTER, id, kind, w: 1, h: 1, ports });
  const SINK = node(20, machine_kind.SINK, [inPort(0, 20, 2)]);
  const MERGE = node(22, machine_kind.MERGE, [inPort(0, 20, 0), inPort(1, 20, 1), out(2, 21, 0)]);
  const belt = (id: number, docks: BeltDockView[]): BeltView => ({
    id,
    latency: 8,
    fill: 0,
    items: [],
    tiles: [],
    docks,
    ticks_per_slot: 2,
  });
  /** Out 1 (key 0) belts straight into the Sink; Out 2 (key 1) into a belt that joins the
   *  Merge's second In; Out 3 (key 2) ends on open floor. */
  const B1 = belt(30, [{ end: 'Tail', node: 7, port: 0 }, { end: 'Head', node: 20, port: 0 }]);
  const B2 = belt(31, [{ end: 'Tail', node: 7, port: 1 }, { end: 'Head', node: 32, port: 0 }]);
  const B2B = belt(32, [{ end: 'Tail', node: 31, port: 0 }, { end: 'Head', node: 22, port: 1 }]);
  const B3 = belt(33, [{ end: 'Tail', node: 7, port: 2 }]);
  const flow = (): Map<number, PortFlow> =>
    selectedNodePortFlow(ROUTER, [B1, B2, B3], [], {
      nodes: new Map([
        [7, ROUTER],
        [20, SINK],
        [22, MERGE],
      ]),
      belts: new Map([B1, B2, B2B, B3].map((b) => [b.id, b])),
    });
  const body = (over: { routes?: Route[]; fallback?: number | null } = {}) =>
    RouterConfigBody({ routes: over.routes ?? [rule(0)], fallback: over.fallback ?? null, ports: DEMO_PORTS, flow: flow(), onChange: noop });

  it("names Output 1 (Sink), Output 2 (Merge input 2) through a joined belt, and Output 3 on open floor, ordered by number", () => {
    const g = group(body(), `${TARGET_LABEL}, rule 1`);
    expect(buttons(g).map(textOf)).toEqual(['Output 1 (Sink)', 'Output 2 (Merge input 2)', 'Output 3']);
    const def = group(body(), DEFAULT_HEADER);
    expect(buttons(def).map(textOf)).toEqual([NO_DEFAULT_SEGMENT, 'Output 1 (Sink)', 'Output 2 (Merge input 2)', 'Output 3']);
  });

  it('the fallthrough names the default output and its target, or the number alone', () => {
    const line = (fallback: number) => findAll(body({ fallback }), (el) => el.props.id === 'fab-route-fallthrough').map(textOf);
    expect(line(0)).toEqual(['Items matching no rule go to Output 1 (Sink).']);
    expect(line(2)).toEqual(['Items matching no rule go to Output 3.']);
  });

  it('the rules note says the numbers match the Outputs list', () => {
    expect(RULES_NOTE).toBe('The first rule that matches wins. Output numbers match the Outputs list below.');
    expect(findAll(body(), (el) => el.props.id === 'fab-route-note').map(textOf)).toEqual([RULES_NOTE]);
  });

  it('no grid-cell label appears anywhere in the Router panel', () => {
    for (const tree of [body(), body({ fallback: 1 }), RouterConfigBody({ routes: [rule(0), rule(1)], fallback: 2, ports: DEMO_PORTS, onChange: noop })]) {
      expect(textOf(tree)).not.toMatch(/\(\d+,\d+\)/);
      expect(textOf(tree)).not.toContain('output at');
    }
  });

  it('without a flow every output is named by its number alone', () => {
    const g = group(RouterConfigBody({ routes: [rule(1)], fallback: null, ports: DEMO_PORTS, onChange: noop }), `${TARGET_LABEL}, rule 1`);
    expect(buttons(g).map(textOf)).toEqual([OUT1, OUT2, OUT3]);
  });

  // Phase 91 review WR-B-04: a segment's React key is its routing key, never its words. Its words
  // now carry the machine its belt reaches, which changes while the panel is open (a belt docked,
  // undocked or moved), and a new key remounts the button, so a keyboard user focused on it lost
  // focus to the page.
  it('a segment keeps its React key when the machine its belt reaches changes (WR-B-04)', () => {
    const keysOf = (tree: unknown, label: string): unknown[] => buttons(group(tree, label)).map((b) => (b as unknown as { key: unknown }).key);
    const withFlow = body({ fallback: 0 });
    const noFlow = RouterConfigBody({ routes: [rule(0)], fallback: 0, ports: DEMO_PORTS, onChange: noop });
    expect(buttons(group(withFlow, `${TARGET_LABEL}, rule 1`)).map(textOf), 'PRECONDITION: the words differ').not.toEqual(
      buttons(group(noFlow, `${TARGET_LABEL}, rule 1`)).map(textOf),
    );
    for (const label of [`${TARGET_LABEL}, rule 1`, DEFAULT_HEADER]) {
      const a = keysOf(withFlow, label);
      expect(new Set(a).size, `${label}: every key is distinct`).toBe(a.length);
      expect(a, `${label}: the keys do not follow the words`).toEqual(keysOf(noFlow, label));
    }
  });

  it('targetName: the KIND_NAMES name, plus input K at two or more Ins only', () => {
    expect(targetName(undefined)).toBeNull();
    expect(targetName({ node: 1, kind: machine_kind.SINK, input: 1, inputs: 1 })).toBe('Sink');
    expect(targetName({ node: 1, kind: machine_kind.MERGE, input: 2, inputs: 2 })).toBe('Merge input 2');
    expect(targetName({ node: 1, kind: machine_kind.FACTORY, input: 1, inputs: 1 })).toBe('Factory');
  });
});

// Phase 91 review WR-B-01: THE At byte FIELD HOLDS WHAT THE USER TYPES, as the timer field does
// (`SourceConfigBody.test.tsx`). The typed text is kept per rule, keyed by the rule's index, in
// the parent (`ConfigPanel`); the rig plays the parent, one key at a time.
describe('RouterConfigBody: the At byte field holds the typed text, one keystroke at a time (WR-B-01)', () => {
  function rig(routes0: Route[]) {
    let routes = routes0;
    let typed: ReadonlyMap<number, string> = new Map();
    let selected = false;
    const render = () =>
      RouterConfigBody({
        routes,
        fallback: null,
        ports: DEMO_PORTS,
        onChange: (next) => {
          routes = next;
        },
        offsetTyped: typed,
        onOffsetTyped: (next: ReadonlyMap<number, string>) => {
          typed = next;
        },
      });
    const field = (i: number): El => findAll(render(), (el) => el.props.id === `fab-route-offset-${i}`)[0];
    return {
      press(i: number, keys: readonly string[]) {
        for (const k of keys) {
          if (k === 'SelectAll') {
            selected = true;
            continue;
          }
          const shown = selected ? '' : String(field(i).props.value);
          selected = false;
          const next = k === 'Backspace' ? shown.slice(0, -1) : shown + k;
          (field(i).props.onChange as (e: unknown) => void)({ currentTarget: { value: next } });
        }
      },
      blur(i: number) {
        (field(i).props.onBlur as (() => void) | undefined)?.();
      },
      shown: (i: number) => String(field(i).props.value),
      offset: (i: number) => routes[i][0].offset,
      tree: render,
    };
  }

  it('12.7 shows 12.7 (never 127), commits 12, and shows 12 once the field is left', () => {
    const r = rig([rule(0)]);
    r.press(0, ['SelectAll', ...'12.7']);
    expect(r.shown(0)).toBe('12.7');
    expect(r.offset(0)).toBe(12);
    r.blur(0);
    expect(r.shown(0)).toBe('12');
  });

  it('clearing then typing 30 gives 30, and a stray letter stays until Backspace', () => {
    const r = rig([rule(0, [97], 4)]);
    r.press(0, ['Backspace']);
    expect(r.shown(0), 'a cleared field stays empty').toBe('');
    r.press(0, [...'30']);
    expect(r.shown(0)).toBe('30');
    expect(r.offset(0)).toBe(30);
    r.press(0, ['x']);
    expect(r.shown(0)).toBe('30x');
    r.press(0, ['Backspace']);
    expect(r.offset(0)).toBe(30);
  });

  it('the typed text belongs to its rule, and a move or a delete drops it, since the indices move', () => {
    const r = rig([rule(0, [97], 1), rule(1, [98], 2)]);
    r.press(1, [...'.']);
    expect(r.shown(1), 'rule 2 holds its own text').toBe('2.');
    expect(r.shown(0), 'rule 1 is untouched').toBe('1');
    press(controlByLabel(r.tree(), moveUpLabel(2)));
    expect(r.shown(0), 'after the move rule 1 shows its buffer').toBe('2');
    expect(r.shown(1)).toBe('1');
    r.press(0, [...'.']);
    press(controlByLabel(r.tree(), deleteRuleLabel(2)));
    expect(r.shown(0), 'after a delete the field shows the buffer').toBe('2');
  });
});
