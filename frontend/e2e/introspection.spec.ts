import { test, expect, type Page } from '@playwright/test';
import { buildPacket, mockRenderSocket, waitForChrome, waitForBoard } from './support/wire';

// introspection.spec.ts (REND-02, Phase 14-08; re-based on the CURRENT wire in
// 21-08) — the "testable UI at the model layer" proof.
//
// emits-command.spec.ts asserts the EMITTED GridCommand bytes at the UI edge.
// This spec asserts the resulting SCENE STATE via the read-only
// `window.__fabrico.scene()` introspection hook — DOM-free, never reading canvas
// pixels. We inject a `full` render-packet carrying (a) a faulted multi-cell node
// and (b) a belt carrying items, then read the snapshot and assert scene facts:
// the node's faulted state + its footprint cells, and the belt's item COUNT (the
// WebGL item layer is exposed as a count only — the build/item-layer split).
// Port-role and dock-end oracle reads (the 21-05 extension) live in
// port-gestures.spec.ts.
//
// Capture mechanism mirrors emits-command.spec.ts: with no axum host on :8787 in
// a headless harness the dev render socket never opens, so we mock it with
// Playwright's native `page.routeWebSocket` (support/wire.ts) and inject
// server→page packets.

/** The plain-data scene shape the read-only hook returns (mirrors FabricoScene). */
interface SceneFacts {
  tick: number;
  nodes: { id: number; kind: number; state: number; cells: [number, number][] }[];
  belts: { id: number; tiles: unknown[]; items: number }[];
}

/** Read `window.__fabrico.scene()` from the page — DOM-free, no canvas reads. */
async function readScene(page: Page): Promise<SceneFacts> {
  return page.evaluate(() => {
    const hook = window.__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    return hook.scene() as SceneFacts;
  });
}

test.describe('REND-02: window.__fabrico.scene() exposes scene facts DOM-free', () => {
  test('a faulted multi-cell node reports its state + footprint cells', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // A 2x3 ROUTER (kind 5) at (4,5), faulted (state 2). Footprint = 6 cells.
    h.inject(
      buildPacket({
        tick: 7,
        nodes: [{ id: 7, kind: 5, cell_x: 4, cell_y: 5, state: 2, w: 2, h: 3, rot: 0 }],
      }),
    );
    // Proof the packet landed: the model's machine count and the toolbar tick reflect the echo.
    await waitForBoard(page, { machines: 1 });

    const scene = await readScene(page);
    expect(scene.tick).toBe(7);

    const n = scene.nodes.find((x) => x.id === 7);
    expect(n, 'faulted node present in snapshot').toBeDefined();
    expect(n?.state, 'node 7 is faulted (state 2)').toBe(2);
    expect(n?.cells, 'node 7 occupies its 6 footprint cells').toEqual([
      [4, 5],
      [4, 6],
      [4, 7],
      [5, 5],
      [5, 6],
      [5, 7],
    ]);
  });

  test('a belt reports its item COUNT (not individual items)', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // A belt id 3 running (10,12)→(13,12) carrying 2 items.
    h.inject(
      buildPacket({
        tick: 7,
        belts: [
          {
            id: 3,
            tiles: [
              [10, 12],
              [11, 12],
              [12, 12],
              [13, 12],
            ],
            itemCount: 2,
          },
        ],
      }),
    );

    await expect.poll(async () => (await readScene(page)).belts.length).toBe(1);

    const scene = await readScene(page);
    const b = scene.belts.find((x) => x.id === 3);
    expect(b, 'belt present in snapshot').toBeDefined();
    expect(b?.items, 'belt 3 carries 2 items (count)').toBe(2);
    expect(typeof b?.items, 'items is a count, not an array').toBe('number');
    expect(Array.isArray(b?.tiles), 'tiles is the build-layer geometry array').toBe(true);
    expect(b?.tiles.length, 'the drawn 4-tile path rides the snapshot').toBe(4);
  });

  test('the hook is read-only: mutating the snapshot never changes the live scene', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(
      buildPacket({
        tick: 7,
        nodes: [{ id: 7, kind: 5, cell_x: 4, cell_y: 5, state: 2, w: 2, h: 3, rot: 0 }],
      }),
    );
    await waitForBoard(page, { machines: 1 });

    // Tamper aggressively with one snapshot, then take a fresh one and prove the
    // mutation never leaked into the live scene (threat T-14-FABRICO-RO).
    const stillFaulted = await page.evaluate(() => {
      const first = window.__fabrico!.scene();
      first.tick = 9999;
      first.nodes[0].state = 0;
      first.nodes[0].cells.push([99, 99]);
      const second = window.__fabrico!.scene();
      return second.tick === 7 && second.nodes[0].state === 2 && second.nodes[0].cells.length === 6;
    });
    expect(stillFaulted, 'a fresh snapshot is unaffected by tampering the prior one').toBe(true);
  });
});
