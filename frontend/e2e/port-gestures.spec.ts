import { test, expect, type Page } from '@playwright/test';
import {
  CMD,
  buildPacket,
  mockRenderSocket,
  nubAnchor,
  rotateHandle,
  screenCellCentre,
  screenPoint,
  waitForChrome,
  type Harness,
  type InjectBelt,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// port-gestures.spec.ts (21-08) — browser-level proof of the Phase-21 per-port
// control gestures: REAL pointer events through the production UI, asserted on
// the EMITTED binary GridCommand frames (never canvas pixels) over the
// routeWebSocket mock (support/wire.ts).
//
//   Spec 1 (CTRL-01): select a belt, drag its Tail endpoint handle onto a
//     factory Out nub → exactly ONE Dock frame (disc 4) with the fixture's
//     belt/end/node/port varint fields.
//   Spec 2 (CTRL-02): Belt tool, press ON an Out nub, draw to a second node's
//     In nub → one DrawBelt frame (disc 3), then — after the echoed belt is
//     injected — the two follow-up Dock frames in Tail-then-Head order.
//   Spec 3 (CTRL-03): select a node, click the overlay rotate handle → one
//     Rotate frame (disc 2, ccw=0); Shift+click → ccw=1.
//   Spec 4 (oracle): window.__fabrico.scene() reports the injected node's port
//     roles and the belt's dock ends (the 21-05 oracle extension) — the exact
//     read Phase 22's E2E-03 makes against the real host.
//
// This file is ALSO the Phase-22 driving pattern: every gesture goes through
// the frontend encoder + gesture path (encodeGridCommand), NOT the Rust Scene
// harness — the exact masking P22 exists to close (P17 review WR-02).

// ---------------------------------------------------------------------------
// Fixture geometry - all anchors come from the shared geometry helpers
// (frontend/shared/geometry.ts, GATE-01); no arithmetic is spelled out here.
// Identity camera: screen px == world px.
// ---------------------------------------------------------------------------

/**
 * A FACTORY-shaped node (kind 2, 3x3) at (10,8) with its catalog ports resolved
 * to world cells: In (10,9) W, Out (12,9) E, Fault (11,10) S.
 */
const FACTORY: InjectNode = {
  id: 7,
  kind: 2,
  cell_x: 10,
  cell_y: 8,
  w: 3,
  h: 3,
  ports: [
    { index: 0, cell_x: 10, cell_y: 9, side: 3, role: 0 },
    { index: 1, cell_x: 12, cell_y: 9, side: 1, role: 1 },
    { index: 2, cell_x: 11, cell_y: 10, side: 2, role: 2 },
  ],
};

/** A SINK (kind 7, 1x1) at (17,9): In on its own cell, faces W → cell (16,9). */
const SINK: InjectNode = {
  id: 8,
  kind: 7,
  cell_x: 17,
  cell_y: 9,
  ports: [{ index: 0, cell_x: 17, cell_y: 9, side: 3, role: 0 }],
};

/**
 * A 4-tile belt (13,9)→(16,9). Its Tail end (13,9) sits on the cell the
 * factory Out port faces, travelling away — the exact acceptsDock geometry —
 * so a Tail dock onto the Out nub arms.
 */
const BELT_TILES: [number, number][] = [
  [13, 9],
  [14, 9],
  [15, 9],
  [16, 9],
];
const UNDOCKED_BELT: InjectBelt = { id: 3, tiles: BELT_TILES };

/** The factory Out nub's world/screen anchor: the E-side nub of its cell (12,9). */
const OUT_NUB = nubAnchor(12, 9, 1); // side E=1
/** The sink In nub's world/screen anchor: the W-side nub of its cell (17,9). */
const IN_NUB = nubAnchor(17, 9, 3); // side W=3

/** Click (press+release, no drag) at a screen point. */
async function clickAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

test.describe('Phase 21 port gestures emit correct wire bytes (CTRL-01/02/03)', () => {
  test('CTRL-01: dragging a belt Tail handle onto an Out nub emits one Dock frame', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ nodes: [FACTORY], belts: [UNDOCKED_BELT] }));
    await waitForBoard(page, { machines: 1 });

    // Select the belt: click one of its tiles (press+release, no drag). Belt
    // selection shows the endpoint grab handles; it emits nothing.
    const tile = await screenCellCentre(page, 15, 9);
    await clickAt(page, tile.x, tile.y);

    // Grab the (undocked) Tail handle at the end-tile centre and drag it onto
    // the Out nub. The armed ring / drop candidate latch during MOVE; release
    // emits exactly one Dock (release never re-evaluates — 21-04).
    const tail = await screenCellCentre(page, 13, 9);
    const outNub = await screenPoint(page, OUT_NUB);
    await page.mouse.move(tail.x, tail.y);
    await page.mouse.down();
    await page.mouse.move(outNub.x, outNub.y, { steps: 4 });
    await page.mouse.up();

    await expect.poll(() => h.sent.length).toBe(1);
    // Dock wire = [disc=4, belt varintU, end varintU (Tail=1), node varintU,
    // port varintU] — the SPATIAL catalog index verbatim (host owns keyspaces).
    expect(Array.from(h.sent[0]), 'Dock{belt:3, end:Tail, node:7, port:1}').toEqual([
      CMD.Dock,
      3,
      1,
      7,
      1,
    ]);
    await page.waitForTimeout(150);
    expect(h.sent.length, 'no late duplicate frame').toBe(1);
  });

  // Phase 89 (plan 89-06, BELT-04, D-05, WINDOWS 113): with NO tool armed and NOTHING selected, a
  // press on the factory's Out dot (2 world px inside its E edge), dragged in sub-cell steps away
  // and then onto the loose belt's first tile, emits exactly ONE Dock frame naming the belt, its
  // Tail, the factory and the Out: the bytes CTRL-01's selected-belt Tail handle drag sends above.
  // At the plan's start revision the same hand selected the factory and sent nothing.
  test('BELT-04: a drag from an Out dot onto a loose belt start emits one Dock frame, with no tool and no selection', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ nodes: [FACTORY], belts: [UNDOCKED_BELT] }));
    await waitForBoard(page, { machines: 1 });

    const dot = await screenPoint(page, { x: OUT_NUB.x - 2, y: OUT_NUB.y + 1 });
    const away = await screenCellCentre(page, 14, 11);
    const start = await screenPoint(page, { x: 13 * 32 + 24, y: 9 * 32 + 14 });
    await page.mouse.move(dot.x, dot.y);
    await page.mouse.down();
    await page.mouse.move(away.x, away.y, { steps: 20 });
    await page.mouse.move(start.x, start.y, { steps: 20 });
    await page.mouse.up();

    await expect.poll(() => h.sent.length).toBe(1);
    expect(Array.from(h.sent[0]), 'Dock{belt:3, end:Tail, node:7, port:1}').toEqual([CMD.Dock, 3, 1, 7, 1]);
    const selected = await page.evaluate(() => {
      const hook = (window as { __fabrico?: { selectedNode(): number | null; selectedBelt(): number | null } }).__fabrico;
      return { node: hook?.selectedNode() ?? null, belt: hook?.selectedBelt() ?? null };
    });
    expect(selected, 'the selection never changed: nothing is selected').toEqual({ node: null, belt: null });
    await page.waitForTimeout(150);
    expect(h.sent.length, 'no late duplicate frame').toBe(1);
  });

  // Plan 88-06 (D-06): the Docks wait for BOTH the DrawBelt's accept, which names the minted
  // belt, and a packet that holds it. Neither transport orders a verdict against a render
  // packet, so both orders are driven through the real App send seam. Until plan 88-06 the
  // Docks went out on the packet alone, matched by the belt's exact cells.
  for (const order of ['accept before packet', 'packet before accept'] as const) {
  test(`CTRL-02: port-to-port draw emits DrawBelt, then Tail+Head Docks after its accept and its packet (${order})`, async ({
    page,
  }) => {
    // The host's diff for the tick that folded the DrawBelt (a full keyframe would be a
    // remint, a different case): belt 9 with the routed tiles.
    const echo = () => buildPacket({ full: false, tick: 2, belts: [{ id: 9, tiles: BELT_TILES }] });
    // `h` is read inside the callback only once the page sends, by which time it is set.
    const h: Harness = await mockRenderSocket(page, {
      answerGesture: (frame) => {
        if (frame[0] !== CMD.DrawBelt) return undefined;
        if (order === 'packet before accept') h.inject(echo());
        return { accept: [9] };
      },
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ nodes: [FACTORY, SINK] }));
    await waitForBoard(page, { machines: 2 });

    // Arm the Belt tool, press WITHIN the Out nub's hit radius (records the
    // source dock, seeds the draw at the port's facing cell (13,9)), drag a
    // straight path east, release on the sink's In nub (records the Head dock;
    // the facing cell (16,9) is already the last drawn cell).
    // Prefix-matched, not exact: this Belt tool title is user-facing COPY that
    // doubles as a SELECTOR, so an exact match makes every copy edit a
    // five-spec breakage (52-05). `Draw belts` stays unique in the palette.
    await page.getByTitle(/^Draw belts/).click();
    const outNub = await screenPoint(page, OUT_NUB);
    const inNub = await screenPoint(page, IN_NUB);
    await page.mouse.move(outNub.x, outNub.y);
    await page.mouse.down();
    for (const cx of [14, 15, 16]) {
      const p = await screenCellCentre(page, cx, 9);
      await page.mouse.move(p.x, p.y);
    }
    await page.mouse.move(inNub.x, inNub.y);
    await page.mouse.up();

    // Exactly ONE DrawBelt lands first — the follow-up Docks must NOT ride the
    // same handler (a same-batch Dock would reference an unminted belt handle).
    await expect.poll(() => h.sent.length).toBeGreaterThanOrEqual(1);
    expect(
      Array.from(h.sent[0]),
      'DrawBelt{cells: (13,9)..(16,9)} — zigzag varintI cell pairs',
    ).toEqual([CMD.DrawBelt, 4, 26, 18, 28, 18, 30, 18, 32, 18]);
    if (order === 'accept before packet') {
      // The accept is in and no packet holds belt 9: nothing more may go out yet.
      await page.waitForTimeout(300);
      expect(h.sent.length, 'no Dock before a packet holds the minted belt').toBe(1);
      h.inject(echo());
    }

    // The echo watcher emits BOTH Docks in recorded order: Tail (source) first,
    // then Head (destination).
    await expect.poll(() => h.sent.length).toBe(3);
    expect(Array.from(h.sent[1]), 'Dock{belt:9, end:Tail, node:7, port:1} first').toEqual([
      CMD.Dock,
      9,
      1,
      7,
      1,
    ]);
    expect(Array.from(h.sent[2]), 'Dock{belt:9, end:Head, node:8, port:0} second').toEqual([
      CMD.Dock,
      9,
      0,
      8,
      0,
    ]);
    expect(h.sentHeaders[1]?.generation, "the Docks carry the accept's generation").toBe(0);
    expect(h.sentHeaders[2]?.generation).toBe(0);
    await page.waitForTimeout(150);
    expect(h.sent.length, 'no late duplicate frames').toBe(3);
  });
  }

  // Phase 89 (plan 89-05, BELT-03, D-03): a release on the INNER half of the Sink's In dot, 4
  // world px inside its W edge and so inside the Sink's own cell (17,9). The hand walks there in
  // sub-cell steps (`page.mouse.move` with steps), so the walk pushes (17,9); the one committed-path
  // function trims it back to the doorstep, and the release sends the DrawBelt WITHOUT the machine
  // cell, then the Tail and the Head Docks. At the plan's start revision nothing was sent.
  test('BELT-03: a release inside the In dot over the machine edge emits one DrawBelt without the machine cell, then both Docks', async ({
    page,
  }) => {
    const echo = () => buildPacket({ full: false, tick: 2, belts: [{ id: 9, tiles: BELT_TILES }] });
    const h: Harness = await mockRenderSocket(page, {
      answerGesture: (frame) => (frame[0] === CMD.DrawBelt ? { accept: [9] } : undefined),
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ nodes: [FACTORY, SINK] }));
    await waitForBoard(page, { machines: 2 });

    await page.getByTitle(/^Draw belts/).click();
    const door = await screenCellCentre(page, 13, 9);
    const inside = await screenPoint(page, { x: 17 * 32 + 4, y: IN_NUB.y + 2 });
    await page.mouse.move(door.x - 5, door.y + 3);
    await page.mouse.down();
    // About 4 screen px a sample across four cells: never one clean cell per event.
    await page.mouse.move(inside.x, inside.y, { steps: 34 });
    await page.mouse.up();

    await expect.poll(() => h.sent.length).toBeGreaterThanOrEqual(1);
    expect(
      Array.from(h.sent[0]),
      "DrawBelt{cells: (13,9)..(16,9)}: the Sink's own cell (17,9) is not sent",
    ).toEqual([CMD.DrawBelt, 4, 26, 18, 28, 18, 30, 18, 32, 18]);
    h.inject(echo());
    await expect.poll(() => h.sent.length).toBe(3);
    expect(Array.from(h.sent[1]), 'Dock{belt:9, end:Tail, node:7, port:1}').toEqual([CMD.Dock, 9, 1, 7, 1]);
    expect(Array.from(h.sent[2]), 'Dock{belt:9, end:Head, node:8, port:0}: the dot docks').toEqual([
      CMD.Dock,
      9,
      0,
      8,
      0,
    ]);
    await page.waitForTimeout(150);
    expect(h.sent.length, 'no late duplicate frames').toBe(3);
  });

  // Phase 88 security (T-88-11, T-88-17): App's one call into the gesture controller's
  // `onSwap` (the swap-keyframe arm of the packet handler in `App.tsx`) ends every held belt
  // when the page's own New lands. The swap keyframe here holds the packet's swap floor at 0,
  // so the floor cannot end the belt and that App line is the only thing that can: removed, the
  // IN-01 branch names the belt and both machines again on the new board and sends two Docks
  // onto it. (The floor on its own is `gestures.test.ts`'s "a Load this page did not ask for"
  // case.) The control leg sends the same keyframe with no swap asked for, as an Undo's would,
  // and the Docks go out: the fixture can produce them, so the silence in the first leg is the
  // App call's doing.
  for (const leg of ['after New', 'control: no swap asked'] as const) {
  test(`T-88-11: a belt held on its Docks ends with nothing sent when this page's New lands (${leg})`, async ({
    page,
  }) => {
    const h: Harness = await mockRenderSocket(page, {
      // Accepted as belt 9 in table 1: an Undo queued ahead of the draw on a paused board
      // folded first, as in `gestures.test.ts`'s IN-01 case.
      answerGesture: (frame) => (frame[0] === CMD.DrawBelt ? { accept: [9], generation: 1 } : undefined),
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ nodes: [FACTORY, SINK] }));
    await waitForBoard(page, { machines: 2 });

    // The CTRL-02 draw: press on the Out nub, drag east, release on the sink's In nub.
    await page.getByTitle(/^Draw belts/).click();
    const outNub = await screenPoint(page, OUT_NUB);
    const inNub = await screenPoint(page, IN_NUB);
    await page.mouse.move(outNub.x, outNub.y);
    await page.mouse.down();
    for (const cx of [14, 15, 16]) {
      const p = await screenCellCentre(page, cx, 9);
      await page.mouse.move(p.x, p.y);
    }
    await page.mouse.move(inNub.x, inNub.y);
    await page.mouse.up();
    await expect.poll(() => h.sent.length).toBe(1);
    expect(h.sent[0][0], 'the DrawBelt').toBe(CMD.DrawBelt);
    // No packet of table 1 has come: the belt is held on its Docks.
    await page.waitForTimeout(300);
    expect(h.sent.length, 'PRECONDITION: the Docks are owed, none sent yet').toBe(1);

    if (leg === 'after New') {
      await page.getByRole('button', { name: 'New' }).click();
      const guard = page.locator('.fab-dialog-panel');
      if (await guard.isVisible().catch(() => false)) {
        await guard.getByRole('button', { name: 'Discard' }).click();
      }
      await expect.poll(() => h.controls.includes('new'), { message: 'New went on the wire' }).toBe(true);
    }

    // A keyframe of generation 2 holding the same machines and a belt on exactly the drawn
    // cells, every handle new, so table 1's packet never comes. Its swap floor is held at 0
    // (see above).
    h.inject(
      buildPacket({
        full: true,
        tick: 0,
        generation: 2,
        swapFloor: 0,
        nodes: [
          { ...FACTORY, id: 17 },
          { ...SINK, id: 18 },
        ],
        belts: [{ id: 19, tiles: BELT_TILES }],
      }),
    );

    if (leg === 'after New') {
      await page.waitForTimeout(500);
      expect(
        h.sent.map((f) => f[0]),
        "nothing past the DrawBelt: this page's New ended the held belt, so no Dock lands on the new board",
      ).toEqual([CMD.DrawBelt]);
    } else {
      await expect.poll(() => h.sent.length, 'the Docks go out on the same keyframe with no swap asked').toBe(3);
      expect(Array.from(h.sent[1]), 'Dock{belt:19, end:Tail, node:17, port:1}').toEqual([CMD.Dock, 19, 1, 17, 1]);
      expect(Array.from(h.sent[2]), 'Dock{belt:19, end:Head, node:18, port:0}').toEqual([CMD.Dock, 19, 0, 18, 0]);
      expect(h.sentHeaders[1]?.generation, 'addressed in the newest table').toBe(2);
    }
  });
  }

  test('CTRL-03: clicking the rotate handle emits Rotate CW; Shift+click emits CCW', async ({
    page,
  }) => {
    // Widen the viewport (44-01): selecting a machine now opens the Phase-39
    // ConfigPanel aside (right side, min(420px, 33vw)), which swallows pointer
    // events. Under the default 1280px viewport the fit-to-factory boot camera
    // (4x on this lone 3x3) puts the rotate handle's screen point UNDER that
    // panel, so the handle click could never reach the canvas. At 1920px the
    // panel starts ~x1500 while the handle lands ~x1236 - clear of it. The
    // camera-aware screenPoint keeps the shared anchor math as the oracle.
    await page.setViewportSize({ width: 1920, height: 720 });
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ nodes: [FACTORY] }));
    await waitForBoard(page, { machines: 1 });

    // Select the factory (click a body cell). The overlay pins the rotate
    // handle diagonally outside the selection outline's top-right corner tick;
    // the shared rotateHandle helper owns that anchor math (min cell 10,8; the
    // 3-wide factory) at the identity camera (UI-SPEC section 5).
    const body = await screenCellCentre(page, 11, 9);
    await clickAt(page, body.x, body.y);
    const handle = rotateHandle(10, 8, 3);
    const handlePt = await screenPoint(page, handle);

    // Plain click → exactly one Rotate, CW (ccw byte 0).
    await clickAt(page, handlePt.x, handlePt.y);
    await expect.poll(() => h.sent.length).toBe(1);
    expect(Array.from(h.sent[0]), 'Rotate{node:7, ccw:false}').toEqual([CMD.Rotate, 7, 0]);

    // Shift+click → exactly one more Rotate, CCW (ccw byte 1) — mirrors Shift+R.
    await page.keyboard.down('Shift');
    await clickAt(page, handlePt.x, handlePt.y);
    await page.keyboard.up('Shift');
    await expect.poll(() => h.sent.length).toBe(2);
    expect(Array.from(h.sent[1]), 'Rotate{node:7, ccw:true}').toEqual([CMD.Rotate, 7, 1]);

    await page.waitForTimeout(150);
    expect(h.sent.length, 'no late duplicate frames').toBe(2);
  });

  test('oracle: scene() reports port roles and dock ends (the P22 E2E-03 read)', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // The factory plus the belt Tail-docked to its Out port (wire keyspace:
    // Tail carries the Out ROUTING key — nth role===Out port — here 0, which
    // the oracle reports VERBATIM as the wire value).
    h.inject(
      buildPacket({
        nodes: [FACTORY],
        belts: [{ id: 3, tiles: BELT_TILES, docks: [{ end: 'Tail', node: 7, port: 0 }] }],
      }),
    );
    await waitForBoard(page, { machines: 1 });

    const scene = await page.evaluate(() => {
      const hook = window.__fabrico;
      if (!hook) {
        throw new Error('window.__fabrico not installed');
      }
      return hook.scene() as {
        nodes: Array<{
          id: number;
          ports: Array<{ index: number; cell_x: number; cell_y: number; side: number; role: number }>;
        }>;
        belts: Array<{ id: number; docks: Array<{ end: string; node: number; port: number }> }>;
      };
    });

    // The node reports its host-resolved port roles + world cells verbatim.
    // `medium: 0` (Mechanical) rides every decoded port since the 35-03 wire
    // growth (PortView.medium appended LAST) - the oracle echoes it verbatim.
    const node = scene.nodes.find((n) => n.id === 7);
    expect(node, 'factory present in snapshot').toBeDefined();
    expect(node?.ports, 'In/Out/Fault port roles + world cells + sides').toEqual([
      { index: 0, cell_x: 10, cell_y: 9, side: 3, role: 0, medium: 0 },
      { index: 1, cell_x: 12, cell_y: 9, side: 1, role: 1, medium: 0 },
      { index: 2, cell_x: 11, cell_y: 10, side: 2, role: 2, medium: 0 },
    ]);

    // The belt reports its per-end docks (end/node/wire-port) verbatim.
    const belt = scene.belts.find((b) => b.id === 3);
    expect(belt, 'belt present in snapshot').toBeDefined();
    expect(belt?.docks, 'the Tail dock end rides the snapshot').toEqual([
      { end: 'Tail', node: 7, port: 0 },
    ]);
  });
});
