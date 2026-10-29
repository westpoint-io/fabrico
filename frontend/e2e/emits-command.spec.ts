import { test, expect } from '@playwright/test';
import {
  CMD,
  GESTURE_ACCEPTED,
  buildPacket,
  expectExactlyOneFrame,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  waitForBoard,
} from './support/wire';

// emits-command.spec.ts (TEST-04, Phase 13-04; re-based on the CURRENT wire in
// 21-08) — the "one schema, two producers" proof at the UI edge.
//
// We drive the real gestures — Place (palette drag), Delete (select + Delete
// key), Rotate (select + r / Shift+R) and DrawBelt (Belt tool drag) — through
// the production UI and assert each emits EXACTLY ONE binary GridCommand frame
// of the right postcard discriminant. The 17-02 `Wire` removal renumbered the
// enum to Place=0, Delete=1, Rotate=2, DrawBelt=3, Dock=4, Undo=5, Redo=6 (see
// src/protocol/decode.ts encodeGridCommand); the former node→node Wire gesture
// is pinned here as emitting NOTHING. We assert the EMITTED bytes, never canvas
// pixels.
//
// Capture mechanism: the dev transport (src/transport/devWebSocket.ts) only
// flushes a frame once the WebSocket is OPEN, and select-target gestures need
// real nodes in the scene. With no axum host on :8787 in a headless harness the
// socket never opens and no nodes ever arrive, so we mock the render socket
// with Playwright's native `page.routeWebSocket` (support/wire.ts): the mock
// both (a) "opens" the socket so emitted frames actually send, and (b) lets us
// inject render-packets to populate nodes for the select affordances.

test.describe('UI emits exactly one GridCommand per gesture', () => {
  test('Place: arm-then-click emits one frame, discriminant 0', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Arm-then-click (30-05 IX-01): CLICK the Source palette item to ARM (emits
    // NOTHING — arming is not a command), then CLICK one empty canvas cell clear
    // of the chrome to PLACE = exactly one Place frame (discriminant 0).
    const item = page.getByRole('button', { name: /Source/ });
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true');
    expect(h.sent.length, 'arming the palette emits no command').toBe(0);

    const drop = await screenCellCentre(page, 12, 8); // (600, 408) at identity — clear of chrome
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.down();
    await page.mouse.up(); // a single click on the floor commits one Place

    await expectExactlyOneFrame(page, h, CMD.Place);
  });

  test('Place: keyboard arm (Enter) then click emits one frame, discriminant 0 (IX-10)', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // IX-10 keyboard operability: focus the Source item and press Enter to ARM
    // (native <button> semantics; emits nothing), assert aria-pressed, then click
    // one empty canvas cell to PLACE = exactly one Place frame.
    const item = page.getByRole('button', { name: /Source/ });
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('aria-pressed', 'true');
    expect(h.sent.length, 'a keyboard arm emits no command').toBe(0);

    const drop = await screenCellCentre(page, 12, 8);
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.down();
    await page.mouse.up();

    await expectExactlyOneFrame(page, h, CMD.Place);
  });

  test('node→node drag emits NO frame (the Wire gesture was removed in 17-02)', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Inject two real nodes; belts come ONLY from DrawBelt + Dock now, so a
    // drag from one node to another must emit NOTHING (it resolves to a select).
    const a = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };
    const b = { id: 2, kind: 7, cell_x: 16, cell_y: 8 };
    h.inject(buildPacket({ nodes: [a, b] }));
    await waitForBoard(page, { machines: 2 });

    const from = await screenCellCentre(page, a.cell_x, a.cell_y);
    const to = await screenCellCentre(page, b.cell_x, b.cell_y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();

    await page.waitForTimeout(200);
    expect(h.sent.length, 'a node→node drag wires nothing post-17-02').toBe(0);
  });

  test('Delete: select + Delete key emits one frame, discriminant 1', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Inject one node, select it (click with no drag), then press Delete.
    const a = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };
    h.inject(buildPacket({ nodes: [a] }));
    await waitForBoard(page, { machines: 1 });

    const at = await screenCellCentre(page, a.cell_x, a.cell_y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up(); // no drag → selects the node
    await page.keyboard.press('Delete');

    await expectExactlyOneFrame(page, h, CMD.Delete);
  });

  test('Rotate: select + R emits one frame, discriminant 2 (CW, ccw=0)', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Inject one node, select it (click, no drag), press 'r' → one Rotate (CW).
    const a = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };
    h.inject(buildPacket({ nodes: [a] }));
    await waitForBoard(page, { machines: 1 });

    const at = await screenCellCentre(page, a.cell_x, a.cell_y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up(); // selects the node
    await page.keyboard.press('r');

    await expectExactlyOneFrame(page, h, CMD.Rotate);
    // Rotate wire = [disc=2, node varintU, ccw u8]; CW => trailing ccw byte 0.
    expect(h.sent[0][h.sent[0].length - 1], 'CW rotate carries ccw=0').toBe(0);
  });

  test('Rotate: select + Shift+R emits one frame, discriminant 2 (CCW, ccw=1)', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    const a = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };
    h.inject(buildPacket({ nodes: [a] }));
    await waitForBoard(page, { machines: 1 });

    const at = await screenCellCentre(page, a.cell_x, a.cell_y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up(); // selects the node
    await page.keyboard.press('Shift+R');

    await expectExactlyOneFrame(page, h, CMD.Rotate);
    // CCW => trailing ccw byte 1.
    expect(h.sent[0][h.sent[0].length - 1], 'CCW rotate carries ccw=1').toBe(1);
  });

  test('DrawBelt: Belt-tool drag emits one frame, discriminant 3', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Arm the manual draw-belt tool from the palette (its press calls
    // armBeltDraw() → draw mode; pan is suspended for the gesture).
    // Prefix-matched, not exact: this Belt tool title is user-facing COPY that
    // doubles as a SELECTOR, so an exact match makes every copy edit a
    // five-spec breakage (52-05). `Draw belts` stays unique in the palette.
    await page.getByTitle(/^Draw belts/).click();

    // Click-drag a short legal orthogonal path across EMPTY cells, advancing one
    // cell at a time so each cell is accumulated as orthogonally adjacent.
    const path = [
      await screenCellCentre(page, 11, 10),
      await screenCellCentre(page, 12, 10),
      await screenCellCentre(page, 13, 10),
      await screenCellCentre(page, 14, 10),
    ];
    await page.mouse.move(path[0].x, path[0].y);
    await page.mouse.down();
    for (let i = 1; i < path.length; i++) {
      await page.mouse.move(path[i].x, path[i].y);
    }
    await page.mouse.up();

    await expectExactlyOneFrame(page, h, CMD.DrawBelt);
  });

  // Phase 88 (plan 88-05, D-06, research Pitfall 3): a turned Place's one Rotate goes out only
  // once the host has accepted THAT Place and a packet shows the handle its accept names,
  // whichever of the two arrives first. Neither transport orders a verdict against a render
  // packet, so both orders are driven, through the real App send seam and the dev transport.
  // Until plan 88-05 the Rotate went out on the packet alone, matched by the cell, so these two
  // read the same at plan 88-05's start; they pin the wiring in both orders, and their vitest
  // twins are the ones a mutation reddens.
  for (const order of ['accept before packet', 'packet before accept'] as const) {
    test(`Place, r: the Rotate waits for its accept and its packet (${order})`, async ({ page }) => {
      const minted = { id: 7, kind: 0, cell_x: 12, cell_y: 8 };
      let placeId = 0;
      // `h` is read inside the callback only once the page sends, by which time it is set.
      const h: Harness = await mockRenderSocket(page, {
        answerGesture: (frame, seq) => {
          if (frame[0] !== CMD.Place) return GESTURE_ACCEPTED;
          placeId = seq;
          // The host's packet first, then its accept, on the one socket.
          if (order === 'packet before accept') h.inject(buildPacket({ tick: 2, full: false, nodes: [minted] }));
          return { accept: [minted.id] };
        },
      });
      await page.goto('/');
      await waitForChrome(page);
      await h.connected;

      const item = page.getByRole('button', { name: /Source/ });
      await item.click();
      const drop = await screenCellCentre(page, minted.cell_x, minted.cell_y);
      await page.mouse.move(drop.x, drop.y);
      await page.keyboard.press('r');
      await page.mouse.down();
      await page.mouse.up();
      await expect.poll(() => placeId, { message: 'the Place was sent and answered' }).toBeGreaterThan(0);

      const rotates = (): Buffer[] => h.sent.filter((f) => f[0] === CMD.Rotate);
      if (order === 'accept before packet') {
        // The accept is in and no packet holds handle 7: nothing may go out yet.
        await page.waitForTimeout(300);
        expect(rotates(), 'no Rotate before a packet shows the minted handle').toHaveLength(0);
        h.inject(buildPacket({ tick: 2, full: false, nodes: [minted] }));
      }
      await expect.poll(() => rotates().length, { message: 'the one Rotate went out' }).toBe(1);
      expect([...rotates()[0]], 'Rotate{node: 7, ccw: false}, the handle the accept named').toEqual([CMD.Rotate, 7, 0]);
      const at = h.sent.findIndex((f) => f[0] === CMD.Rotate);
      expect(h.sentHeaders[at]?.generation, "addressed with the accept's generation").toBe(0);
      await page.waitForTimeout(300);
      expect(rotates(), 'and only once').toHaveLength(1);
    });
  }

  // WORK-04 through the App seam (plan 88-05, D-06): the Delete of a Source X is queued, a
  // Source is dropped on X's cell, the tool is put down and armed again, the ghost turned, a
  // second Source dropped on the cell. The host deletes X, mints the FIRST Place as handle 9
  // (its accept arrives before any packet shows 9) and refuses the second; the packet comes
  // after both drops, as a paused board's would. No Rotate may go out: the turned Place was
  // refused. Until plan 88-05 the second Place took the first one's Source by its cell and
  // turned it.
  test('WORK-04: a Delete queued, two drops on its cell, the second refused: no Rotate', async ({ page }) => {
    const x = { id: 4, kind: 0, cell_x: 12, cell_y: 8 };
    const minted = { id: 9, kind: 0, cell_x: 12, cell_y: 8 };
    let places = 0;
    // `h` is read inside the callback only once the page sends, by which time it is set.
    const h: Harness = await mockRenderSocket(page, {
      answerGesture: (frame) => {
        if (frame[0] !== CMD.Place) return GESTURE_ACCEPTED;
        places++;
        if (places === 1) return { accept: [minted.id] };
        // The tick's diff, as the host sends it: X removed, the first Place's Source added.
        h.inject(buildPacket({ tick: 3, full: false, nodes: [minted], removed: [x.id] }));
        return 'FootprintCollision';
      },
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 2, nodes: [x] }));
    await waitForBoard(page, { machines: 1 });

    const cell = await screenCellCentre(page, x.cell_x, x.cell_y);
    await page.mouse.move(cell.x, cell.y);
    await page.mouse.down();
    await page.mouse.up(); // selects X
    await page.keyboard.press('Delete');
    await expect.poll(() => h.sent.filter((f) => f[0] === CMD.Delete).length, { message: 'the Delete of X' }).toBe(1);

    const item = page.getByRole('button', { name: /Source/ });
    await item.click();
    await page.mouse.move(cell.x, cell.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await item.click();
    await page.mouse.move(cell.x, cell.y);
    await page.keyboard.press('r');
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => places, { message: 'both Places were sent and answered' }).toBe(2);
    await expect(page.locator('#fab-refusal')).toHaveText('That space is taken. Clear it or try elsewhere.');
    await page.waitForTimeout(500);
    expect(
      h.sent.filter((f) => f[0] === CMD.Rotate).map((f) => [...f]),
      'no Rotate: the turned Place was refused',
    ).toEqual([]);
  });

  test('a malformed frame is dropped silently at the edge; later packets still apply (WR-07)', async ({
    page,
  }) => {
    // WR-07 narrowed the packet handler's catch to DecodeError only: a bad
    // frame is still dropped with NO error logged (defense in depth), while
    // any post-decode handler failure would now surface loudly. This pins the
    // silent-drop half plus handler survival.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // An unterminated varint (all continuation bits set) underruns the
    // bounds-checked decoder → DecodeError, dropped at the edge.
    h.inject(Buffer.from([0xff, 0xff, 0xff]));
    // The handler survived and keeps applying well-formed packets.
    h.inject(buildPacket({ nodes: [{ id: 1, kind: 0, cell_x: 12, cell_y: 8 }] }));
    await waitForBoard(page, { machines: 1 });

    expect(
      errors.filter((e) => e.includes('packet handler failed')),
      'a DecodeError is dropped silently, never logged as a handler failure',
    ).toHaveLength(0);
  });
});
