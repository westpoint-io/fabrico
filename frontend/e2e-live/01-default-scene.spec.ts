import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  expectRenderLoopAlive,
  readScene,
  pollScene,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 01-default-scene.spec.ts (E2E-02) - THE cold-boot faithfulness gate, and the
// flagship anti-trap spec of Phase 22.
//
// The v2.0 trap: injected-packet tests (mocked WS, hand-built packets) were
// green while the SHIPPED live default scene was broken. This file can never
// be fooled that way, because its only input is what the REAL core produced:
// real dev_render_server boot -> real RenderProducer -> real postcard bytes ->
// the shipped decoder -> window.__fabrico.scene(). Nothing is injected.
//
// COLD BOOT contract: this spec performs NO gestures, NO scene reset, NO
// mutation of any kind. It must run FIRST in the live suite (workers: 1 +
// alphabetical filename ordering under one worker guarantee it), and its
// exact-handle assertions double as the ordering guard: any spec mutating the
// host before this one breaks the handle shape and fails loudly here.
//
// THE CENSUS IS READ FROM THE SCENE FILE (plan 85-08, D-06). Every node (kind, anchor,
// size), every belt (its exact cells, both docks) and both cables are compared with
// `examples/boards/demo_scene.board.ron`, parsed here, rather than with a
// retyped copy, so a layout edit cannot leave this file checking the old board. The
// machines' PORT GEOMETRY is still written out cell by cell below: that is the catalog
// as the user sees it on this board, and a catalog change must fail here by naming the
// cell it moved. Since plan 85-08 the demo is an order line where every machine does a
// job (D-14 to D-18): the Factory makes orders, the Router sorts them three ways into a
// Merge (Post) and a Balancer (two freight docks), the Tee copies every order to an
// Audit sink, rejects drop into a Rejects sink, seven Sand labels name the sections, and
// a Route and an HTTP Handler answer web requests. A mismatch here is a DEFECT FINDING
// (the demo regressed, or the host built another board) - never a number to tweak.

// Keyspaces (core wire values, mirrored from kinds.ts / the RESEARCH table).
const KIND = {
  SOURCE: 0,
  FACTORY: 2,
  TEE: 3,
  BALANCER: 4,
  ROUTER: 5,
  MERGE: 6,
  SINK: 7,
  /** The caller Route (`ENDPOINT` on the wire). */
  ENDPOINT: 9,
  /** The HTTP Handler. It FOLDS to a `Node::Factory` in the core; the render packet names it
   *  HANDLER from its port shape (`fabrico_command::is_handler_shape`). */
  HANDLER: 10,
  LABEL: 11,
} as const;
const SIDE = { N: 0, E: 1, S: 2, W: 3 } as const;
const ROLE = { In: 0, Out: 1, Fault: 2 } as const;
const MEDIUM = { Mechanical: 0, Electrical: 1 } as const;
/** The wire sentinel validate_normalize freezes onto a fault dock. */
const FAULT_PORT = 65535;
/** Catalog boxes (w, h) per placed kind; a label's comes from its Configure. */
const CATALOG_BOX: Record<number, [number, number]> = {
  [KIND.SOURCE]: [1, 1],
  [KIND.FACTORY]: [3, 3],
  [KIND.TEE]: [2, 2],
  [KIND.BALANCER]: [2, 2],
  [KIND.ROUTER]: [2, 3],
  [KIND.MERGE]: [2, 2],
  [KIND.SINK]: [1, 1],
  [KIND.ENDPOINT]: [1, 1],
  [KIND.HANDLER]: [3, 3],
};

type NodeFacts = SceneFacts['nodes'][number];
type BeltFacts = SceneFacts['belts'][number];

/** One placed node as `demo_scene.board.ron` authors it. */
interface RonPlace {
  handle: number;
  kind: number;
  anchor: [number, number];
  box: [number, number];
  label: { text: string; colour: number } | null;
}
/** One drawn belt as `demo_scene.board.ron` authors it, with its two catalog-port docks. */
interface RonBelt {
  handle: number;
  cells: [number, number][];
  tail: { node: number; port: number } | null;
  head: { node: number; port: number } | null;
}

/** `demo_scene.board.ron`, parsed into its census: places, belts and the one paired DrawWire. */
function demoCensus(): { places: RonPlace[]; belts: RonBelt[]; wire: { from: number; to: number } } {
  const src = readFileSync(
    fileURLToPath(new URL('../../examples/boards/demo_scene.board.ron', import.meta.url)),
    'utf8',
  )
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  const places: RonPlace[] = [];
  const belts: RonBelt[] = [];
  let wire: { from: number; to: number } | null = null;
  let handle = 0;
  const re =
    /Place\(kind: (\d+), cell_x: (\d+), cell_y: (\d+)\)|DrawBelt\(cells: \[([^\]]*)\]\)|Configure\(node: (\d+), config: Label\(text: "([^"]*)", colour: (\d+), w: (\d+), h: (\d+)\)\)|Dock\(belt: (\d+), endpoint: (Tail|Head), node: (\d+), port: (\d+)\)|DrawWire\(from_node: (\d+), from_port: \d+, to_node: (\d+), to_port: \d+\)/g;
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) {
      const kind = Number(m[1]);
      places.push({ handle, kind, anchor: [Number(m[2]), Number(m[3])], box: CATALOG_BOX[kind] ?? [4, 1], label: null });
      handle += 1;
    } else if (m[4] !== undefined) {
      const cells = [...m[4].matchAll(/\((\d+), (\d+)\)/g)].map((c) => [Number(c[1]), Number(c[2])] as [number, number]);
      belts.push({ handle, cells, tail: null, head: null });
      handle += 1;
    } else if (m[5] !== undefined) {
      const p = places.find((x) => x.handle === Number(m[5]));
      if (p === undefined) throw new Error(`demoCensus: a Label Configure names handle ${m[5]}, which no Place minted`);
      p.box = [Number(m[8]), Number(m[9])];
      p.label = { text: m[6], colour: Number(m[7]) };
    } else if (m[10] !== undefined) {
      const b = belts.find((x) => x.handle === Number(m[10]));
      if (b === undefined) throw new Error(`demoCensus: a Dock names belt ${m[10]}, which no DrawBelt minted`);
      b[m[11] === 'Tail' ? 'tail' : 'head'] = { node: Number(m[12]), port: Number(m[13]) };
    } else if (m[14] !== undefined) {
      // A Route-to-Handler DrawWire mints the request AND its reply leg (phase 72, D-04).
      wire = { from: Number(m[14]), to: Number(m[15]) };
      handle += 2;
    }
  }
  if (places.length === 0 || belts.length === 0 || wire === null) {
    throw new Error('demoCensus: demo_scene.board.ron parsed to an empty census');
  }
  return { places, belts, wire };
}

function mustNode(s: SceneFacts, id: number): NodeFacts {
  const n = s.nodes.find((x) => x.id === id);
  expect(n, `node handle ${id} present (cold boot mints exactly the scene's handles)`).toBeDefined();
  return n as NodeFacts;
}

function mustBelt(s: SceneFacts, id: number): BeltFacts {
  const b = s.belts.find((x) => x.id === id);
  expect(b, `belt handle ${id} present (cold boot mints exactly the scene's belt handles)`).toBeDefined();
  return b as BeltFacts;
}

function mustDock(b: BeltFacts, end: 'Head' | 'Tail'): { node: number; port: number } {
  const d = b.docks.find((x) => x.end === end);
  expect(d, `belt ${b.id} has a ${end} dock`).toBeDefined();
  return { node: (d as { node: number }).node, port: (d as { port: number }).port };
}

/** A node's anchor (min x, min y) and box (w, h), read off its cells. */
function boxOf(n: NodeFacts): { anchor: [number, number]; w: number; h: number } {
  const xs = n.cells.map((c) => c[0]);
  const ys = n.cells.map((c) => c[1]);
  return {
    anchor: [Math.min(...xs), Math.min(...ys)],
    w: Math.max(...xs) - Math.min(...xs) + 1,
    h: Math.max(...ys) - Math.min(...ys) + 1,
  };
}

/** A port as `[cell_x, cell_y, side]`. */
const at = (p: { cell_x: number; cell_y: number; side: number } | undefined) => [p?.cell_x, p?.cell_y, p?.side];

test.describe('E2E-02 cold boot: the SHIPPED default scene is faithful on the real host', () => {
  // RENDER HEALTH, ON A SPEC THAT IS ENTIRELY MODEL-ONLY (71-review IN-04).
  //
  // Every assertion in this file reads `window.__fabrico.scene()`, which is fed by the
  // packet path and is completely independent of the Pixi ticker. A build whose
  // renderer is dead - a throwing ticker callback, a stage nobody adds to - leaves all
  // of it passing over a blank canvas. That is this repository's recorded blind spot,
  // and it has fired repeatedly, so the guard is not optional here.
  //
  // The watcher is installed BEFORE `page.goto` (its own docblock requires it -
  // installing it afterwards loses every error raised during load), and both guards run
  // after EVERY test in the describe rather than being written out four times.
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the cold-boot assertion');
    errs.assertNone('the cold-boot walk');
  });

  test('every demo node from the scene file, with exact kinds, cells, sizes and ports', async ({ page }) => {
    const s = await readScene(page);
    const census = demoCensus();

    // Exact-handle shape: this is also the suite-ordering guard - a prior mutating
    // spec would have minted extra handles or moved these. Handles mint in command
    // order: machines 0..10, the labels 11..17, the belts (BeltViews) 18..28, then the
    // Route and the HTTP Handler, the LAST two Place commands, placed after everything
    // else precisely so the demo handles are UNSHIFTED.
    const ids = s.nodes.map((n) => n.id).sort((a, b) => a - b);
    expect(ids, 'the cold boot holds exactly the nodes the scene file places, at their mint-order handles').toEqual(
      census.places.map((p) => p.handle),
    );
    expect(s.nodes.length, 'exactly DEMO_NODE_COUNT nodes, the scene file\'s Place count').toBe(DEMO_NODE_COUNT);
    expect(census.places.length, 'the census and the oracle count the same Place commands').toBe(DEMO_NODE_COUNT);

    // EVERY node against the scene file: kind, anchor and box. A label's box is its
    // Configure's w x h; every machine's is the catalog's.
    for (const p of census.places) {
      const n = mustNode(s, p.handle);
      expect(n.kind, `node ${p.handle} kind is ${p.kind}, as demo_scene.board.ron places it`).toBe(p.kind);
      const b = boxOf(n);
      expect(b.anchor, `node ${p.handle} is anchored at (${p.anchor})`).toEqual(p.anchor);
      expect([b.w, b.h], `node ${p.handle} is ${p.box[0]}x${p.box[1]}`).toEqual(p.box);
      expect(n.cells.length, `node ${p.handle} claims every cell of its box`).toBe(p.box[0] * p.box[1]);
      expect(n.label, `node ${p.handle} carries the label words and colour the scene file gives it`).toEqual(p.label);
    }
    const labels = s.nodes.filter((n) => n.kind === KIND.LABEL);
    expect(labels.length, 'seven Sand section labels (D-17)').toBe(7);
    expect(
      labels.every((l) => l.label !== null && l.label.colour === 0 && l.label.text.split(' ').length <= 3),
      'each label is Sand and at most three words',
    ).toBe(true);

    // Node 0: SOURCE at (1,3), 1x1, one Out port on its own cell facing E.
    const source = mustNode(s, 0);
    expect(source.kind, 'node 0 kind is SOURCE (0)').toBe(KIND.SOURCE);
    expect(source.cells, 'node 0 occupies exactly its own cell (1,3)').toEqual([[1, 3]]);
    expect(source.ports.length, 'node 0 exposes exactly one port').toBe(1);
    const srcOut = source.ports[0];
    expect(srcOut.role, 'source port role is Out (1)').toBe(ROLE.Out);
    expect([srcOut.cell_x, srcOut.cell_y], 'source Out port sits on its own cell').toEqual([1, 3]);
    expect(srcOut.side, 'source Out port faces E (side 1)').toBe(SIDE.E);

    // Node 1: the order FACTORY at (4,2), 3x3, ports In/Out/Fault at exact cells+sides.
    const factory = mustNode(s, 1);
    expect(factory.kind, 'node 1 kind is FACTORY (2)').toBe(KIND.FACTORY);
    expect(factory.cells.length, 'factory footprint is 9 cells (3x3)').toBe(9);
    expect(factory.cells, 'factory anchor cell (4,2) is in its footprint').toContainEqual([4, 2]);
    expect(factory.ports.length, 'factory exposes exactly 3 ports (In/Out/Fault)').toBe(3);
    const fIn = factory.ports.find((p) => p.role === ROLE.In);
    expect(fIn, 'factory has an In port (role 0)').toBeDefined();
    expect(at(fIn), 'factory In port at cell (4,3) facing W').toEqual([4, 3, SIDE.W]);
    const fOut = factory.ports.find((p) => p.role === ROLE.Out);
    expect(fOut, 'factory has an Out port (role 1)').toBeDefined();
    expect(at(fOut), 'factory Out port at cell (6,3) facing E').toEqual([6, 3, SIDE.E]);
    const fFault = factory.ports.find((p) => p.role === ROLE.Fault);
    expect(fFault, 'factory has a Fault port (role 2)').toBeDefined();
    expect(at(fFault), 'factory Fault port at cell (5,4) facing S').toEqual([5, 4, SIDE.S]);

    // Node 2: TEE at (9,3), 2x2, In W + two Out E at exact cells.
    const tee = mustNode(s, 2);
    expect(tee.kind, 'node 2 kind is TEE (3)').toBe(KIND.TEE);
    expect(tee.cells.length, 'tee footprint is 4 cells (2x2)').toBe(4);
    expect(tee.cells, 'tee anchor cell (9,3) is in its footprint').toContainEqual([9, 3]);
    expect(tee.ports.length, 'tee exposes exactly 3 ports (In + 2 Out)').toBe(3);
    const teeIn = tee.ports.find((p) => p.role === ROLE.In);
    expect(teeIn, 'tee has an In port').toBeDefined();
    expect(at(teeIn), 'tee In port at (9,3) facing W').toEqual([9, 3, SIDE.W]);
    const teeOuts = tee.ports
      .filter((p) => p.role === ROLE.Out)
      .map((p) => [p.cell_x, p.cell_y, p.side])
      .sort((a, b) => a[1] - b[1]);
    expect(teeOuts, 'tee Out ports at (10,3) E and (10,4) E').toEqual([
      [10, 3, SIDE.E],
      [10, 4, SIDE.E],
    ]);

    // The four unturned SINKs: Post (25,0), Audit (14,4), dock A (25,3), dock B (25,6). Each
    // 1x1, its In on its own cell facing W PLUS the Fault nub on the same cell facing S
    // (plan 71-04, PILE-10: the footprint did not grow, both nubs sit on the one cell).
    for (const [id, cx, cy] of [
      [3, 25, 0],
      [4, 14, 4],
      [9, 25, 3],
      [10, 25, 6],
    ] as const) {
      const sink = mustNode(s, id);
      expect(sink.kind, `node ${id} kind is SINK (7)`).toBe(KIND.SINK);
      expect(sink.cells, `node ${id} occupies exactly its own cell (${cx},${cy})`).toEqual([[cx, cy]]);
      expect(sink.ports.length, `node ${id} exposes exactly two ports (In + Fault)`).toBe(2);
      expect(sink.ports[0].role, `node ${id} port 0 role is In (0)`).toBe(ROLE.In);
      expect([sink.ports[0].cell_x, sink.ports[0].cell_y], `node ${id} In port sits on its own cell`).toEqual([cx, cy]);
      expect(sink.ports[0].side, `node ${id} In port faces W (side 3)`).toBe(SIDE.W);
      expect(sink.ports[1].role, `node ${id} port 1 role is Fault (2)`).toBe(ROLE.Fault);
      expect(
        [sink.ports[1].cell_x, sink.ports[1].cell_y],
        `node ${id} Fault port sits on the SAME cell (the footprint did not grow)`,
      ).toEqual([cx, cy]);
      expect(
        sink.ports[1].side,
        `node ${id} Fault port faces S (side 2), off the E side every other kind puts its Out on`,
      ).toBe(SIDE.S);
    }

    // Node 5: the REJECTS sink at (5,8), rotated CW once, so its In faces N and its own
    // Fault nub faces W. Both are the world-resolved `(side + rot) & 3` read, so this node
    // is also the demo's only proof that a nub ROTATES with the machine.
    const rejects = mustNode(s, 5);
    expect(rejects.kind, 'node 5 kind is SINK (7)').toBe(KIND.SINK);
    expect(rejects.cells, 'node 5 occupies exactly its own cell (5,8)').toEqual([[5, 8]]);
    expect(rejects.ports.length, 'node 5 exposes exactly two ports (In + Fault)').toBe(2);
    expect(rejects.ports[0].role, 'node 5 port 0 role is In (0)').toBe(ROLE.In);
    expect(
      rejects.ports[0].side,
      'node 5 is ROTATED CW once: its In port faces N (side 0), the world-resolved REND-04 read',
    ).toBe(SIDE.N);
    expect(rejects.ports[1].role, 'node 5 port 1 role is Fault (2)').toBe(ROLE.Fault);
    expect(rejects.ports[1].side, 'and the SAME quarter-turn carries its Fault nub from S to W (side 3)').toBe(
      SIDE.W,
    );

    // Node 6: BALANCER at (20,3), 2x2, two In (W) + two Out (E). Only its first In is fed.
    const balancer = mustNode(s, 6);
    expect(balancer.kind, 'node 6 kind is BALANCER (4)').toBe(KIND.BALANCER);
    expect(balancer.cells.length, 'balancer footprint is 4 cells (2x2)').toBe(4);
    expect(balancer.cells, 'balancer anchor cell (20,3) is in its footprint').toContainEqual([20, 3]);
    expect(balancer.ports.length, 'balancer exposes exactly 4 ports (2 In + 2 Out)').toBe(4);
    const balIns = balancer.ports
      .filter((p) => p.role === ROLE.In)
      .map((p) => [p.cell_x, p.cell_y, p.side])
      .sort((a, b) => a[1] - b[1]);
    expect(balIns, 'balancer In ports at (20,3) W and (20,4) W').toEqual([
      [20, 3, SIDE.W],
      [20, 4, SIDE.W],
    ]);
    const balOuts = balancer.ports
      .filter((p) => p.role === ROLE.Out)
      .map((p) => [p.cell_x, p.cell_y, p.side])
      .sort((a, b) => a[1] - b[1]);
    expect(balOuts, 'balancer Out ports at (21,3) E and (21,4) E').toEqual([
      [21, 3, SIDE.E],
      [21, 4, SIDE.E],
    ]);

    // Node 7: ROUTER at (14,0), 2x3, one In (W) + three Out (E) + one Fault (S). All three
    // Outs carry a lane since plan 85-08 (D-15); the Fault stays undocked (D-18).
    const router = mustNode(s, 7);
    expect(router.kind, 'node 7 kind is ROUTER (5)').toBe(KIND.ROUTER);
    expect(router.cells.length, 'router footprint is 6 cells (2x3)').toBe(6);
    expect(router.cells, 'router anchor cell (14,0) is in its footprint').toContainEqual([14, 0]);
    expect(router.ports.length, 'router exposes exactly 5 ports (1 In + 3 Out + 1 Fault)').toBe(5);
    // The Fault nub is APPENDED LAST and sits S of the BOTTOM-LEFT cell (14,2), off the E
    // output column entirely: locked by CELL and SIDE rather than by count.
    const rFault = router.ports.find((p) => p.role === ROLE.Fault);
    expect(at(rFault), 'router Fault port at (14,2) facing S, clear of the E output column').toEqual([
      14,
      2,
      SIDE.S,
    ]);
    expect(
      router.ports[router.ports.length - 1].role,
      'and it sorts LAST in catalog order, so appending it shifted no existing dock keyspace',
    ).toBe(ROLE.Fault);
    const rOutCells = router.ports
      .filter((p) => p.role === ROLE.Out)
      .map((p) => [p.cell_x, p.cell_y])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(rOutCells, 'router Out ports occupy the E column (15,0) (15,1) (15,2)').toEqual([
      [15, 0],
      [15, 1],
      [15, 2],
    ]);
    // 74.1-14 (the maintainer's ruling 2026-10-04, "Edits keep middle layout"): the In and the first
    // Out sit on the middle row.
    const rIn = router.ports.find((p) => p.role === ROLE.In);
    expect(at(rIn), 'router In port at (14,1) facing W').toEqual([14, 1, SIDE.W]);
    const rOut = router.ports.find((p) => p.role === ROLE.Out);
    expect(at(rOut), 'router first Out port at (15,1) facing E').toEqual([15, 1, SIDE.E]);

    // Node 8: MERGE at (18,0), 2x2, two In (W) + one Out (E): the small and medium lanes in.
    const merge = mustNode(s, 8);
    expect(merge.kind, 'node 8 kind is MERGE (6)').toBe(KIND.MERGE);
    expect(merge.cells.length, 'merge footprint is 4 cells (2x2)').toBe(4);
    expect(merge.cells, 'merge anchor cell (18,0) is in its footprint').toContainEqual([18, 0]);
    expect(merge.ports.length, 'merge exposes exactly 3 ports (2 In + 1 Out)').toBe(3);
    const mergeIns = merge.ports
      .filter((p) => p.role === ROLE.In)
      .map((p) => [p.cell_x, p.cell_y, p.side])
      .sort((a, b) => a[1] - b[1]);
    expect(mergeIns, 'merge In ports at (18,0) W and (18,1) W').toEqual([
      [18, 0, SIDE.W],
      [18, 1, SIDE.W],
    ]);
    const mergeOut = merge.ports.find((p) => p.role === ROLE.Out);
    expect(at(mergeOut), 'merge Out port at (19,0) facing E').toEqual([19, 0, SIDE.E]);

    // The web request (D-01, D-03): the caller Route and the HTTP Handler, the scene file's
    // last two Places, are the catalog machines a user places from the palette.
    const route = mustNode(s, census.wire.from);
    expect(route.kind, 'the caller is a Route (kind 9)').toBe(KIND.ENDPOINT);
    expect(route.cells, 'the caller Route sits at (13,6)').toEqual([[13, 6]]);
    expect(
      route.ports.map((p) => [p.index, p.role, p.medium, p.side]),
      'the Route carries an electrical In (0) facing W and an electrical Out (1) facing E on its one cell',
    ).toEqual([
      [0, ROLE.In, MEDIUM.Electrical, SIDE.W],
      [1, ROLE.Out, MEDIUM.Electrical, SIDE.E],
    ]);
    const handler = mustNode(s, census.wire.to);
    expect(handler.kind, 'the handler is an HTTP Handler (kind 10)').toBe(KIND.HANDLER);
    expect(boxOf(handler), 'the HTTP Handler is the catalog 3x3 at (16,5)').toEqual({ anchor: [16, 5], w: 3, h: 3 });
    expect(
      handler.ports.map((p) => ({ role: p.role, medium: p.medium })),
      'the handler carries an ELECTRICAL In at index 0 and an ELECTRICAL Out (what is_handler_shape reads) and the catalog MECHANICAL Fault',
    ).toEqual([
      { role: ROLE.In, medium: MEDIUM.Electrical },
      { role: ROLE.Out, medium: MEDIUM.Electrical },
      { role: ROLE.Fault, medium: MEDIUM.Mechanical },
    ]);
    expect(
      handler.ports.map((p) => [p.cell_x, p.cell_y, p.side]),
      'its In at (16,6) facing W, its Out at (18,6) facing E, its Fault at (17,7) facing S',
    ).toEqual([
      [16, 6, SIDE.W],
      [18, 6, SIDE.E],
      [17, 7, SIDE.S],
    ]);

    // The two electrical cables, dormant on cold boot (no pulse until a real POST energizes
    // them), on SEPARATE nubs: request Route Out (1) -> Handler In (0), reply Handler Out (1)
    // -> Route In (0) (DEMO-02).
    expect(s.wires.length, 'the request and reply cables are present').toBe(2);
    expect(
      s.wires.map((w) => [w.from, w.to]),
      'request first, then the reply leg ONE DrawWire mints with it, each on its own nub',
    ).toEqual([
      [
        { node: route.id, port: 1 },
        { node: handler.id, port: 0 },
      ],
      [
        { node: handler.id, port: 1 },
        { node: route.id, port: 0 },
      ],
    ]);
    expect(
      s.wires.every((w) => w.pulses.length === 0),
      'both wires are DORMANT on cold boot (no in-flight pulse)',
    ).toBe(true);
    expect(s.replyPulsesObserved, 'no reply has travelled home on an idle cold boot').toBe(0);
  });

  test('every demo belt from the scene file, with exact cells and WIRE-keyspace docks', async ({ page }) => {
    const s = await readScene(page);
    const census = demoCensus();

    expect(
      s.belts.map((b) => b.id).sort((a, b) => a - b),
      'cold boot exposes exactly the belts the scene file draws, at their mint-order handles',
    ).toEqual(census.belts.map((b) => b.handle));
    expect(census.belts.length, 'eleven drawn belts').toBe(11);

    // Docks: verbatim WIRE keyspace (Pitfall 9). Out docks are frozen in the EMIT keyspace
    // by validate_normalize (0-based position among the node's Out ports) and a fault dock is
    // the FAULT_PORT sentinel - the scene file's CATALOG index is converted through the
    // docked node's own ports here. In docks keep their catalog index (In ports come first
    // in every catalog entry).
    const wirePort = (end: 'Tail' | 'Head', d: { node: number; port: number }): { node: number; port: number } => {
      if (end === 'Head') return d;
      const ports = mustNode(s, d.node).ports;
      const p = ports.find((q) => q.index === d.port);
      expect(p, `node ${d.node} has the catalog port ${d.port} the scene file docks`).toBeDefined();
      if (p!.role === ROLE.Fault) return { node: d.node, port: FAULT_PORT };
      return { node: d.node, port: ports.filter((q) => q.role === ROLE.Out && q.index < d.port).length };
    };
    for (const rb of census.belts) {
      const b = mustBelt(s, rb.handle);
      // Every tile, exact (never a loose "some tiles" count): the drawn path is the authored path.
      expect(
        b.tiles.map((t) => [t.cell_x, t.cell_y]),
        `belt ${rb.handle} runs exactly the cells demo_scene.board.ron draws`,
      ).toEqual(rb.cells);
      expect(rb.tail, `belt ${rb.handle} is Tail-docked in the scene file`).not.toBeNull();
      expect(rb.head, `belt ${rb.handle} is Head-docked in the scene file`).not.toBeNull();
      expect(
        mustDock(b, 'Tail'),
        `belt ${rb.handle} Tail dock carries the exact wire values of catalog {node:${rb.tail!.node}, port:${rb.tail!.port}}`,
      ).toEqual(wirePort('Tail', rb.tail!));
      expect(
        mustDock(b, 'Head'),
        `belt ${rb.handle} Head dock carries the exact wire values {node:${rb.head!.node}, port:${rb.head!.port}}`,
      ).toEqual(wirePort('Head', rb.head!));
    }

    // The three Router lanes, literally, so the keyspace conversion above cannot agree with
    // itself into a pass: emit 2 (top, small), emit 0 (middle, medium), emit 1 (bottom, large).
    const lanes = s.belts
      .filter((b) => mustDock(b, 'Tail').node === 7)
      .map((b) => [b.tiles[0].cell_x, b.tiles[0].cell_y, mustDock(b, 'Tail').port])
      .sort((a, b) => a[1] - b[1]);
    expect(lanes, 'the Router docks all three outputs: (16,0) emit 2, (16,1) emit 0, (16,2) emit 1').toEqual([
      [16, 0, 2],
      [16, 1, 0],
      [16, 2, 1],
    ]);
  });

  test('named anti-trap guards: each v2.0 trap class fails loudly on regression', async ({ page }) => {
    const s = await readScene(page);

    // Guard 1: the v2.0 1x1-factory trap. The mock era rendered factories as
    // single cells while claiming multi-cell coverage; the REAL factory must
    // report its full 3x3 footprint or this gate is red. Since plan 85-08 the demo's
    // HTTP Handler is held to the same: it was the 1x1 the old demo minted.
    expect(
      mustNode(s, 1).cells.length,
      'ANTI-TRAP (the v2.0 1x1-factory trap): the real FACTORY reports 9 footprint cells, not a 1x1 stub',
    ).toBe(9);
    const handler = s.nodes.find((n) => n.kind === KIND.HANDLER);
    expect(
      handler?.cells.length,
      'ANTI-TRAP (the 1x1 demo handler, walk-112): the demo HTTP Handler reports 9 footprint cells',
    ).toBe(9);

    // Guard 2: the v2.0 tile-less-belt trap. Legacy Wire belts shipped with
    // empty tiles[] and rendered as degenerate stubs; every shipped belt must
    // carry a drawn path.
    for (const b of s.belts) {
      expect(
        b.tiles.length,
        `ANTI-TRAP (the v2.0 tile-less-belt trap): belt ${b.id} must carry at least one drawn tile, never an empty-tiles stub`,
      ).toBeGreaterThanOrEqual(1);
    }

    // Guard 3: the v2.0 node-to-node-wire trap. Legacy Wire connected nodes
    // directly with no docks; every shipped belt must be docked at BOTH ends.
    for (const b of s.belts) {
      expect(
        b.docks.length,
        `ANTI-TRAP (the v2.0 node-to-node-wire trap): belt ${b.id} must be docked at both ends (Head + Tail), never a dock-less wire`,
      ).toBe(2);
    }

    // Guard 4 (flagship, REND-04 as a hard gate): the fault belt plugs the factory's
    // FAULT_PORT sentinel and lands on the ROTATED Rejects sink whose world-resolved In
    // port faces North. Found by its Head dock on the Rejects sink (node 5).
    const faultBelt = s.belts.find((b) => b.docks.some((d) => d.end === 'Head' && d.node === 5));
    expect(faultBelt, 'a belt delivers into the Rejects sink (node 5)').toBeDefined();
    expect(
      mustDock(faultBelt!, 'Tail'),
      'ANTI-TRAP (flagship REND-04): the fault belt plugs the factory FAULT_PORT (wire sentinel 65535), not a catalog index',
    ).toEqual({ node: 1, port: FAULT_PORT });
    const rotatedSink = mustNode(s, 5);
    const rotatedIn = rotatedSink.ports.find((p) => p.role === ROLE.In);
    expect(
      rotatedIn?.side,
      'ANTI-TRAP (flagship REND-04): the fault belt lands on the ROTATED sink whose In port world-resolves to side N',
    ).toBe(SIDE.N);
  });

  test('items flow on the cold-booted default scene within a deterministic poll window', async ({ page }) => {
    // The demo injects every 8 ticks (~133ms at 60Hz), so the default 15s
    // pollScene timeout is enormous headroom. No fixed sleeps: expect.poll.
    await pollScene(page, (s) => s.belts.reduce((n, b) => n + b.items, 0), {
      message:
        'items flow on the shipped default scene: a frozen, never-flowing grid is the LIVE-05 regression (the injected-packet era never proved live flow)',
    }).toBeGreaterThan(0);
  });
});
