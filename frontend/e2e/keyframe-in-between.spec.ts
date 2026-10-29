import { test, expect, type ElementHandle, type Page } from '@playwright/test';
import {
  buildPacket,
  gestureSubject,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type InjectBelt,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// keyframe-in-between.spec.ts (plan 76-15, review CR-01): a control clicked on the frame
// a keyframe lands, BEFORE React commits the deselect that keyframe queues.
//
// WHAT IT PROVES. A full keyframe (after an Undo, a Redo, a Load or a New) restarts the
// host's render handles at 0, so the handle a selected machine had can name a different
// node on the very next frame. App's keyframe branch clears the selection, but that only
// QUEUES React state. Until React commits, the delete control rendered for the old
// selection is still mounted, and its click would ask the host to delete whatever node
// the keyframe put on that handle. This spec clicks inside that window and counts what
// the page sends.
//
// WHY THE MOCK SUITE. The click handlers and the keyframe branch are the real App's, in
// Chromium, with only the render socket routed (`mockRenderSocket`). jsdom cannot mount
// App (Pixi needs a GL context), and the live suite cannot put a click at a chosen point
// inside one socket dispatch.
//
// WHY A PAGE-SIDE LISTENER. It is the only way to act between App's packet handler and
// React's commit. An init script wraps `window.WebSocket` in a subclass that records each
// instance and changes nothing else. After boot, `armInBetween` adds a one-shot `message`
// listener to the render socket. Registered after the transport's `onmessage`, it runs
// after it in the same dispatch: App has already applied the packet, and React, which
// schedules the state that handler queued outside the dispatch, has not committed. The
// listener reads the scene and whether its target is still connected, clicks, and stores
// those facts; the test asserts them afterwards under messages starting `PRECONDITION`,
// so a run where the click missed the window cannot pass as a green.
//
// The defect test has a positive control that arms the same listener on a diff packet
// and must see exactly one Delete, so a listener that never clicks cannot pass either.
// Plan 76-16 adds the delete guard's two outcomes (Delete anyway, Drain first) through
// `armInBetween`; plan 76-17 adds the panel (a label's Apply, at the end of this file).

/** The board: a Source on handle 0 at (4,4) and a Source on handle 1 at (12,8). */
const BOARD: InjectNode[] = [
  { id: 0, kind: 0, cell_x: 4, cell_y: 4 },
  { id: 1, kind: 0, cell_x: 12, cell_y: 8 },
];

/** The keyframe that remints handle 1: it now names a Sink (kind 7) at (20,8). */
const REMINTED: InjectNode[] = [
  { id: 0, kind: 0, cell_x: 4, cell_y: 4 },
  { id: 1, kind: 7, cell_x: 20, cell_y: 8 },
];

/** What the in-between listener saw and did, stored on the page. */
interface InBetweenFacts {
  /** The kind and cells `scene()` held on handle 1 when the listener ran. */
  node1: { kind: number; cells: [number, number][] } | null;
  /** Whether the element about to be clicked was still in the document. */
  connected: boolean;
  /** Whether the listener reached its click. */
  clicked: boolean;
  /** Every belt `scene()` held when the listener ran, by id, with its tile cells. */
  belts: { id: number; tiles: [number, number][] }[];
}

/** The page global the init script records sockets on, and the listener's facts. */
interface InBetweenWindow {
  __fabSockets?: WebSocket[];
  __fabInBetween?: InBetweenFacts;
  __fabrico?: {
    scene(): {
      nodes: { id: number; kind: number; cells: [number, number][] }[];
      belts: { id: number; tiles: { cell_x: number; cell_y: number }[] }[];
    };
  };
}

/**
 * Record every WebSocket the page constructs, on `window.__fabSockets`. A subclass of
 * whatever `window.WebSocket` is when the script runs (the routed mock, since
 * `mockRenderSocket` installs before this), changing nothing else.
 */
async function recordSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as InBetweenWindow & { WebSocket: typeof WebSocket };
    const Base = w.WebSocket;
    w.__fabSockets = [];
    w.WebSocket = class RecordedWebSocket extends Base {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        w.__fabSockets!.push(this);
      }
    };
  });
}

/**
 * Arm the in-between window: a one-shot `message` listener on the render socket that,
 * on the next binary message, reads handle 1 off `scene()`, reads whether `target` is
 * still connected, clicks it, and stores those facts on `window.__fabInBetween`.
 */
async function armInBetween(page: Page, target: ElementHandle<Element>): Promise<void> {
  const found = await page.evaluate((el) => {
    const w = window as unknown as InBetweenWindow;
    w.__fabInBetween = undefined;
    const ws = (w.__fabSockets ?? []).find((s) => s.url.endsWith('/render'));
    if (!ws) return false;
    const onMessage = (ev: MessageEvent): void => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      ws.removeEventListener('message', onMessage);
      const scene = w.__fabrico?.scene();
      const n = scene?.nodes.find((x) => x.id === 1);
      const facts: InBetweenFacts = {
        node1: n ? { kind: n.kind, cells: n.cells } : null,
        connected: el.isConnected,
        clicked: false,
        belts: (scene?.belts ?? []).map((b) => ({
          id: b.id,
          tiles: b.tiles.map((t): [number, number] => [t.cell_x, t.cell_y]),
        })),
      };
      (el as HTMLElement).click();
      facts.clicked = true;
      w.__fabInBetween = facts;
    };
    ws.addEventListener('message', onMessage);
    return true;
  }, target);
  expect(found, 'PRECONDITION: the render socket was recorded, so the listener is armed').toBe(
    true,
  );
}

/** Poll until the armed listener has run, and return what it saw. */
async function inBetweenFacts(page: Page): Promise<InBetweenFacts> {
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as InBetweenWindow).__fabInBetween !== undefined),
    )
    .toBe(true);
  return page.evaluate(() => (window as unknown as InBetweenWindow).__fabInBetween!);
}

/** The live selection ref, read off the read-only hook. */
async function selectedNode(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { selectedNode?(): number | null } })
      .__fabrico;
    if (!hook?.selectedNode) throw new Error('window.__fabrico.selectedNode() not installed');
    return hook.selectedNode();
  });
}

/** The Delete frames among `h.sent` from index `from` on. */
function deletesSince(h: Harness, from: number): { cmd?: string; node?: number }[] {
  return h.sent
    .slice(from)
    .map((f) => gestureSubject(f))
    .filter((s) => s.cmd === 'Delete');
}

/**
 * Boot the real App on the routed socket, inject the two-Source board, select handle 1
 * with a click on its cell, and return the harness and the delete control's element.
 */
async function bootAndSelect(
  page: Page,
  errors: string[],
  opts: { holdReact?: boolean } = {},
): Promise<{ h: Harness; control: ElementHandle<Element> }> {
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  const h = await mockRenderSocket(page);
  await recordSockets(page);
  if (opts.holdReact) await holdReactWork(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ tick: 1, nodes: BOARD }));
  await waitForBoard(page, { machines: 2 });

  const at = await screenCellCentre(page, 12, 8);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => selectedNode(page)).toBe(1);
  expect(await selectedNode(page), 'PRECONDITION: handle 1 is the live selection').toBe(1);

  const button = page.getByRole('button', { name: 'Delete machine' });
  await expect(button).toBeVisible();
  const control = await button.elementHandle();
  if (!control) throw new Error('the delete control has no element');
  return { h, control };
}

test.describe('a control clicked between a keyframe and React commit (CR-01)', () => {
  test('positive control: a delete clicked on a diff frame sends one Delete', async ({ page }) => {
    const errors: string[] = [];
    const { h, control } = await bootAndSelect(page, errors);

    await armInBetween(page, control);
    const sentAtArm = h.sent.length;
    h.inject(buildPacket({ tick: 2, full: false }));
    const facts = await inBetweenFacts(page);

    expect(facts.connected, 'PRECONDITION: the control was connected when clicked').toBe(true);
    expect(facts.clicked, 'PRECONDITION: the listener reached its click').toBe(true);
    await expect.poll(() => deletesSince(h, sentAtArm).length).toBe(1);
    await page.waitForTimeout(500);
    expect(
      deletesSince(h, sentAtArm),
      'POSITIVE CONTROL: a click on a diff frame sends exactly one Delete, naming handle 1',
    ).toEqual([{ cmd: 'Delete', node: 1 }]);
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('a delete clicked on the keyframe frame sends nothing', async ({ page }) => {
    const errors: string[] = [];
    const { h, control } = await bootAndSelect(page, errors);

    await armInBetween(page, control);
    const sentAtArm = h.sent.length;
    h.inject(buildPacket({ tick: 2, full: true, nodes: REMINTED }));
    const facts = await inBetweenFacts(page);

    expect(
      facts.node1,
      'PRECONDITION (keyframe applied): inside the listener the scene showed handle 1 as the reminted Sink at (20,8)',
    ).toEqual({ kind: 7, cells: [[20, 8]] });
    expect(
      facts.connected,
      'PRECONDITION (React not committed): the delete control was still connected when clicked',
    ).toBe(true);

    await expect(page.getByRole('button', { name: 'Delete machine' })).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(
      deletesSince(h, sentAtArm),
      'a delete clicked on the frame a keyframe reminted the selected handle sends no Delete',
    ).toEqual([]);
    expect(errors, 'no uncaught page error').toEqual([]);
  });
});

// ---- the delete control as PAINTED between a keyframe and React commit (76-15 refuter round)
//
// The click tests above act inside one socket dispatch, before any frame paints. The
// delete control's anchor is hidden by App's per-frame projection (`project()` in the
// anchor's layout effect, through `placeDeleteAnchor`), so grading what the user sees
// needs frames that PAINT while the old control is still mounted. In Chromium React's
// scheduler posts its work through a `MessageChannel`. `holdReactWork` wraps that
// constructor before the bundle loads, so the test can hold those posts: held, App's
// keyframe branch has run, React has not committed, and animation frames keep painting.
// Each test reads the anchor's computed visibility after four painted frames, then
// releases the held work and checks React committed the deselect.
//
// WHY BOTH KEYFRAMES. A keyframe either remints the selected handle onto another node
// (a Load, a New) or leaves nothing on it (an Undo of that machine's Place). The first
// grades the selection-ref read at App's call site: pass `true` there and the anchor is
// moved onto the reminted node and shown. The second grades the vanished node: the
// projection used to skip its whole write when the scene held no node on the handle,
// leaving the anchor visible at the vanished machine's old position.
//
// The positive control holds React the same way across a diff packet and must read the
// anchor visible at its unchanged position, so a reading that always says hidden fails.

/** The keyframe an Undo of handle 1's Place sends: handle 1 names nothing any more. */
const VANISHED: InjectNode[] = [{ id: 0, kind: 0, cell_x: 4, cell_y: 4 }];

/** The page globals `holdReactWork` installs. */
interface HoldWindow {
  __fabHold?: boolean;
  __fabHeldCount?: () => number;
  __fabRelease?: () => void;
}

/**
 * Wrap `window.MessageChannel` so posts on `port2` (how React's scheduler queues work in
 * a browser) can be held while `window.__fabHold` is true and replayed by
 * `window.__fabRelease()`. Changes nothing while not holding.
 */
async function holdReactWork(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as HoldWindow & { MessageChannel: typeof MessageChannel };
    const Real = w.MessageChannel;
    const held: (() => void)[] = [];
    w.__fabHold = false;
    w.__fabHeldCount = () => held.length;
    w.MessageChannel = class HeldMessageChannel extends Real {
      constructor() {
        super();
        const port = this.port2;
        const post = port.postMessage.bind(port) as (m: unknown) => void;
        (port as unknown as { postMessage(m: unknown): void }).postMessage = (m: unknown) => {
          if (w.__fabHold) held.push(() => post(m));
          else post(m);
        };
      }
    };
    w.__fabRelease = () => {
      w.__fabHold = false;
      for (const run of held.splice(0)) run();
    };
  });
}

/** What the delete anchor looked like on a painted frame while React work was held. */
interface PaintedAnchor {
  /** React scheduler posts held when the read was taken. */
  heldTasks: number;
  /** `window.__fabrico.selectedNode()` at the read. */
  ref: number | null;
  /** Whether the delete control was still in the document (React not committed). */
  connected: boolean;
  /** Animation frames that ran between the packet and the read. */
  frames: number;
  /** The anchor wrapper's computed visibility. */
  visibility: string;
  /** The anchor wrapper's inline transform (its screen position). */
  transform: string;
}

/** The delete anchor wrapper's inline transform now. */
async function anchorTransform(page: Page): Promise<string> {
  return page.evaluate(() => {
    const b = document.querySelector('button[aria-label="Delete machine"]');
    if (!b?.parentElement) throw new Error('the delete control has no anchor wrapper');
    return b.parentElement.style.transform;
  });
}

/**
 * Hold React's work, inject `packet`, wait until the scene holds `nodeCount` nodes (the
 * packet applied), let four more animation frames paint, and read the anchor.
 */
async function paintedAnchor(
  page: Page,
  h: Harness,
  packet: Buffer,
  nodeCount: number,
): Promise<PaintedAnchor> {
  await page.evaluate(() => {
    (window as unknown as HoldWindow).__fabHold = true;
  });
  h.inject(packet);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as InBetweenWindow).__fabrico!.scene().nodes.length,
      ),
    )
    .toBe(nodeCount);
  return page.evaluate(
    () =>
      new Promise<PaintedAnchor>((resolve) => {
        let frames = 0;
        const step = (): void => {
          frames += 1;
          if (frames < 4) {
            requestAnimationFrame(step);
            return;
          }
          const w = window as unknown as HoldWindow & {
            __fabrico: { selectedNode(): number | null };
          };
          const b = document.querySelector('button[aria-label="Delete machine"]');
          const wrap = b?.parentElement ?? null;
          resolve({
            heldTasks: w.__fabHeldCount!(),
            ref: w.__fabrico.selectedNode(),
            connected: !!b?.isConnected,
            frames,
            visibility: wrap ? getComputedStyle(wrap).visibility : '(no anchor)',
            transform: wrap?.style.transform ?? '(no anchor)',
          });
        };
        requestAnimationFrame(step);
      }),
  );
}

/** Release the held React work. */
async function releaseReactWork(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as HoldWindow).__fabRelease!());
}

/** The two in-window PRECONDITIONs every keyframe case asserts before its reading. */
function expectHeldInBetween(a: PaintedAnchor): void {
  expect(a.heldTasks, 'PRECONDITION (React not committed): React work was held').toBeGreaterThan(0);
  expect(
    a.connected,
    'PRECONDITION (React not committed): the delete control was still mounted',
  ).toBe(true);
  expect(a.ref, 'PRECONDITION (keyframe applied): the live selection ref was nulled').toBeNull();
  expect(a.frames, 'PRECONDITION: four animation frames painted in the window').toBe(4);
}

test.describe('the delete control as painted between a keyframe and React commit (CR-01, D3)', () => {
  test('positive control: on painted frames after a diff the control is shown where it stood', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h } = await bootAndSelect(page, errors, { holdReact: true });
    const before = await anchorTransform(page);

    const a = await paintedAnchor(page, h, buildPacket({ tick: 2, full: false }), BOARD.length);
    await releaseReactWork(page);

    expect(a.connected, 'PRECONDITION: the delete control was mounted').toBe(true);
    expect(a.ref, 'PRECONDITION: handle 1 is still the live selection').toBe(1);
    expect(a.frames, 'PRECONDITION: four animation frames painted in the window').toBe(4);
    expect(a.visibility, 'POSITIVE CONTROL: the control is shown on a diff frame').toBe('visible');
    expect(a.transform, 'POSITIVE CONTROL: the control stays at handle 1').toBe(before);
    await expectRenderAlive(page, h, 2, 'after the held diff');
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('on painted frames after a keyframe reminted its handle the control is hidden and not moved', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h } = await bootAndSelect(page, errors, { holdReact: true });
    const before = await anchorTransform(page);

    const a = await paintedAnchor(
      page,
      h,
      buildPacket({ tick: 2, full: true, nodes: REMINTED }),
      REMINTED.length,
    );
    await releaseReactWork(page);

    expectHeldInBetween(a);
    expect(
      a.visibility,
      'the delete control is hidden on the frames after a keyframe reminted the selected handle',
    ).toBe('hidden');
    expect(
      a.transform,
      'the hidden control is not moved onto the Sink the keyframe put on handle 1',
    ).toBe(before);
    await expect(page.getByRole('button', { name: 'Delete machine' })).toHaveCount(0);
    await expectRenderAlive(page, h, 2, 'after the held keyframe');
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('on painted frames after a keyframe left nothing on its handle the control is hidden', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h } = await bootAndSelect(page, errors, { holdReact: true });

    const a = await paintedAnchor(
      page,
      h,
      buildPacket({ tick: 2, full: true, nodes: VANISHED }),
      VANISHED.length,
    );
    await releaseReactWork(page);

    expectHeldInBetween(a);
    expect(
      a.visibility,
      'the delete control is hidden on the frames after a keyframe removed the selected machine',
    ).toBe('hidden');
    await expect(page.getByRole('button', { name: 'Delete machine' })).toHaveCount(0);
    await expectRenderAlive(page, h, 2, 'after the held keyframe');
    expect(errors, 'no uncaught page error').toEqual([]);
  });
});

// ---- the delete guard's outcomes (plan 76-16, CR-01, WR-06) ----------------------------
//
// The guard (`useDeleteGuard` in App.tsx) holds one machine handle and the docked belt
// ids its drain polls. A full keyframe cancels it (WR-06), but through React state, so
// until React commits, the dialog rendered for the old handle is still mounted with
// Delete anyway and Drain first live. Clicked in that window, either would send a Delete
// for whatever node the keyframe put on the handle. The fixture is `delete-guard.spec.ts`'s:
// a Source on handle 1 at (12,8) with belt 3 Tail-docked to its Out port carrying items.

/** A Source on handle 1 at (12,8) with its catalog Out port (own cell, faces E). */
const GUARD_MACHINE: InjectNode = {
  id: 1,
  kind: 0,
  cell_x: 12,
  cell_y: 8,
  ports: [{ index: 0, cell_x: 12, cell_y: 8, side: 1, role: 1 }],
};

/** Belt 3, Tail-docked to the machine's Out port, carrying 2 items. */
const GUARD_BELT: InjectBelt = {
  id: 3,
  tiles: [
    [13, 8],
    [14, 8],
    [15, 8],
    [16, 8],
  ],
  itemCount: 2,
  docks: [{ end: 'Tail', node: 1, port: 0 }],
};

/** The keyframe that remints handle 1 to a Sink (kind 7) at (20,8), with no belts. */
const GUARD_REMINTED: InjectNode[] = [{ id: 1, kind: 7, cell_x: 20, cell_y: 8 }];

/**
 * Boot the real App on the routed socket, inject the guard fixture, select handle 1 and
 * press Delete, so the guard opens with no command sent. Returns the harness and the
 * element of the guard button named `name` (found by role and exact name).
 */
async function bootAndOpenGuard(
  page: Page,
  errors: string[],
  name: 'Delete anyway' | 'Drain first',
): Promise<{ h: Harness; button: ElementHandle<Element> }> {
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  const h = await mockRenderSocket(page);
  await recordSockets(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ tick: 1, nodes: [GUARD_MACHINE], belts: [GUARD_BELT] }));
  await waitForBoard(page, { machines: 1 });

  const at = await screenCellCentre(page, 12, 8);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => selectedNode(page)).toBe(1);
  await page.keyboard.press('Delete');

  await expect(page.locator('.fab-dialog-panel')).toContainText(
    'Delete with items still moving?',
  );
  await page.waitForTimeout(150);
  expect(
    deletesSince(h, 0),
    'PRECONDITION: the guard opened and no Delete was sent before a choice',
  ).toEqual([]);

  const locator = page.getByRole('button', { name, exact: true });
  await expect(locator).toBeVisible();
  const button = await locator.elementHandle();
  if (!button) throw new Error(`the guard's ${name} button has no element`);
  return { h, button };
}

/** Inject the keyframe that remints handle 1 and check the listener ran inside its window. */
async function keyframeAndCheckWindow(page: Page, h: Harness): Promise<void> {
  h.inject(buildPacket({ tick: 2, full: true, nodes: GUARD_REMINTED }));
  const facts = await inBetweenFacts(page);
  expect(
    facts.node1,
    'PRECONDITION (keyframe applied): inside the listener the scene showed handle 1 as the reminted Sink at (20,8)',
  ).toEqual({ kind: 7, cells: [[20, 8]] });
  expect(
    facts.connected,
    'PRECONDITION (React not committed): the guard button was still connected when clicked',
  ).toBe(true);
}

test.describe('a delete-guard outcome clicked between a keyframe and React commit (CR-01)', () => {
  test('positive control: Delete anyway clicked on a diff frame sends one Delete', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h, button } = await bootAndOpenGuard(page, errors, 'Delete anyway');

    await armInBetween(page, button);
    const sentAtArm = h.sent.length;
    h.inject(buildPacket({ tick: 2, full: false }));
    const facts = await inBetweenFacts(page);

    expect(facts.connected, 'PRECONDITION: the button was connected when clicked').toBe(true);
    expect(facts.clicked, 'PRECONDITION: the listener reached its click').toBe(true);
    await expect.poll(() => deletesSince(h, sentAtArm).length).toBe(1);
    await page.waitForTimeout(500);
    expect(
      deletesSince(h, sentAtArm),
      'POSITIVE CONTROL: Delete anyway on a diff frame sends exactly one Delete, naming handle 1',
    ).toEqual([{ cmd: 'Delete', node: 1 }]);
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('Delete anyway clicked on the keyframe frame sends nothing', async ({ page }) => {
    const errors: string[] = [];
    const { h, button } = await bootAndOpenGuard(page, errors, 'Delete anyway');

    await armInBetween(page, button);
    const sentAtArm = h.sent.length;
    await keyframeAndCheckWindow(page, h);

    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    await page.waitForTimeout(500);
    expect(
      deletesSince(h, sentAtArm),
      'Delete anyway clicked on the frame a keyframe reminted the guard handle sends no Delete',
    ).toEqual([]);
    await expect(
      page.locator('.fab-dialog-panel'),
      'the guard is closed and stays closed after a 500 ms settle',
    ).toBeHidden();
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('positive control: Drain first clicked on a diff frame starts the drain', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h, button } = await bootAndOpenGuard(page, errors, 'Drain first');

    await armInBetween(page, button);
    const sentAtArm = h.sent.length;
    h.inject(buildPacket({ tick: 2, full: false }));
    const facts = await inBetweenFacts(page);

    expect(facts.connected, 'PRECONDITION: the button was connected when clicked').toBe(true);
    expect(facts.clicked, 'PRECONDITION: the listener reached its click').toBe(true);
    await expect(
      page.locator('.fab-dialog-panel'),
      'POSITIVE CONTROL: Drain first on a diff frame shows the draining readout for belt 3',
    ).toContainText('2 left');
    await page.waitForTimeout(500);
    expect(
      deletesSince(h, sentAtArm),
      'POSITIVE CONTROL: no Delete while the docked belt still carries 2 items',
    ).toEqual([]);
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('Drain first clicked on the keyframe frame sends nothing and the guard stays closed', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h, button } = await bootAndOpenGuard(page, errors, 'Drain first');

    await armInBetween(page, button);
    const sentAtArm = h.sent.length;
    await keyframeAndCheckWindow(page, h);

    await page.waitForTimeout(500);
    expect(
      deletesSince(h, sentAtArm),
      'Drain first clicked on the frame a keyframe reminted the guard handle: no drain loop sends a Delete',
    ).toEqual([]);
    await expect(
      page.locator('.fab-dialog-panel'),
      'the guard is closed and stays closed after a 500 ms settle',
    ).toBeHidden();
    expect(errors, 'no uncaught page error').toEqual([]);
  });
});


// ---- a label's Apply (plan 76-17, CR-01, T-76-44) --------------------------------------
//
// The ConfigPanel is mounted `key={selectedNode}` and unmounts only when React commits the
// keyframe's deselect. Until then its Apply still names the old handle, and the host's
// kind pairing refuses a Label config only onto a MACHINE, so a label handle reminted
// onto another label would have that label's words, colour and size silently
// overwritten. App hands the panel its `sendInput` through `sendWhileSelected` over the
// live selection ref; this is the real-App half of the jsdom panel cases in
// `src/chrome/keyframeSenders.test.tsx`, and the only check that sees App wire the gate.

/** The label kind byte (`machine_kind.LABEL`). */
const LABEL_KIND = 11;

/** A Source on handle 0 at (4,4) and a 3x1 label on handle 1 at (12,8) reading `Before`. */
const LABEL_BOARD: InjectNode[] = [
  { id: 0, kind: 0, cell_x: 4, cell_y: 4 },
  {
    id: 1,
    kind: LABEL_KIND,
    cell_x: 12,
    cell_y: 8,
    w: 3,
    h: 1,
    label: { text: 'Before', colour: 0 },
  },
];

/** The keyframe that remints handle 1 onto ANOTHER label, at (4,14), reading `Other`. */
const LABEL_REMINTED: InjectNode[] = [
  { id: 0, kind: 0, cell_x: 4, cell_y: 4 },
  {
    id: 1,
    kind: LABEL_KIND,
    cell_x: 4,
    cell_y: 14,
    w: 3,
    h: 1,
    label: { text: 'Other', colour: 0 },
  },
];

/** What `machine_config` answers for the selected label. */
const LABEL_CONFIG = { kind: 'Label', text: 'Before', colour: 0, w: 3, h: 1 };

/** The Configure frames among `h.sent` from index `from` on. */
function configuresSince(h: Harness, from: number): { cmd?: string; node?: number }[] {
  return h.sent
    .slice(from)
    .map((f) => gestureSubject(f))
    .filter((s) => s.cmd === 'Configure');
}

/**
 * Boot the real App on the routed socket with `machine_config` answered, inject the label
 * board, select the label on handle 1 with a click on its cell, change its Text so Apply
 * is enabled, and return the harness and Apply's element (found by role and exact name).
 */
async function bootAndEditLabel(
  page: Page,
  errors: string[],
): Promise<{ h: Harness; apply: ElementHandle<Element> }> {
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? LABEL_CONFIG : undefined),
  });
  await recordSockets(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ tick: 1, nodes: LABEL_BOARD }));
  // The model counts the Source and not the label (plan 77-04), at this packet's tick 1, which
  // carries both nodes; the toolbar's tick says the chrome drew it (plan 91-02).
  await waitForBoard(page, { machines: 1, tick: 1 });

  const at = await screenCellCentre(page, 12, 8);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => selectedNode(page)).toBe(1);

  const text = page.locator('#fab-label-text');
  await expect(text, 'PRECONDITION: the label panel loaded its words').toHaveValue('Before');
  await text.fill('After');

  const locator = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(locator, 'PRECONDITION: the edited Text enables Apply').toBeEnabled();
  expect(configuresSince(h, 0), 'PRECONDITION: no Configure was sent before Apply').toEqual([]);
  const apply = await locator.elementHandle();
  if (!apply) throw new Error('Apply has no element');
  return { h, apply };
}

test.describe('a panel Apply clicked between a keyframe and React commit (CR-01, T-76-44)', () => {
  test('positive control: a label Apply clicked on a diff frame sends one Configure', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h, apply } = await bootAndEditLabel(page, errors);

    await armInBetween(page, apply);
    const sentAtArm = h.sent.length;
    h.inject(buildPacket({ tick: 2, full: false }));
    const facts = await inBetweenFacts(page);

    expect(facts.connected, 'PRECONDITION: Apply was connected when clicked').toBe(true);
    expect(facts.clicked, 'PRECONDITION: the listener reached its click').toBe(true);
    await expect.poll(() => configuresSince(h, sentAtArm).length).toBe(1);
    await page.waitForTimeout(500);
    expect(
      configuresSince(h, sentAtArm),
      'POSITIVE CONTROL: a label Apply on a diff frame sends exactly one Configure, naming node 1',
    ).toEqual([{ cmd: 'Configure', node: 1 }]);
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('a label Apply clicked on the keyframe frame sends nothing', async ({ page }) => {
    const errors: string[] = [];
    const { h, apply } = await bootAndEditLabel(page, errors);

    await armInBetween(page, apply);
    const sentAtArm = h.sent.length;
    h.inject(buildPacket({ tick: 2, full: true, nodes: LABEL_REMINTED }));
    const facts = await inBetweenFacts(page);

    expect(
      facts.node1,
      'PRECONDITION (keyframe applied): inside the listener the scene showed handle 1 as the other label at (4,14)',
    ).toEqual({
      kind: LABEL_KIND,
      cells: [
        [4, 14],
        [5, 14],
        [6, 14],
      ],
    });
    expect(
      facts.connected,
      'PRECONDITION (React not committed): Apply was still connected when clicked',
    ).toBe(true);

    await expect(page.locator('#fab-label-text')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(
      configuresSince(h, sentAtArm),
      'a label Apply clicked on the frame a keyframe reminted the selected handle sends no Configure',
    ).toEqual([]);
    expect(errors, 'no uncaught page error').toEqual([]);
  });
});

// ---- a label's pending-size outline (plan 76-19, CR-01) --------------------------------
//
// The label panel reports its pending size to App, which paints the outline the label
// would have at the node the reported handle names NOW (`paintLabelResize`). On the frame
// a keyframe lands the panel is still mounted for the old handle, which here names ANOTHER
// label, so a report from that panel would draw its outline over the other label.
//
// MEASURED, NOT REACHED (plan 76-19 audit, `labelResizeRef` row). The report is a passive
// effect of the panel (ConfigPanel's pending-size `useEffect`), never a click handler, so
// it runs only after a commit. React 19 renders SyncLane, InputContinuousLane and
// DefaultLane together (`getHighestPriorityLanes` returns `lanes & 42` in react-dom
// 19.2.7), so the step's render already carries the keyframe's queued deselect and the
// panel unmounts before its effect can report. This leg is the guard on that: it steps the
// width INSIDE the keyframe's socket dispatch and reads the outline the overlay PLOTTED
// (`labelResizePreview()`, the Graphics' own instructions) at once and on the next two
// animation frames. A change that makes the report reach App on that frame (moving it into
// the click, or keeping the panel mounted) draws the outline over the other label, and
// this leg reddens. Proved by mutation: the keyframe branch's `clearSelection()` removed.

/** What the overlay's label-resize Graphics plotted, as `labelResizePreview()` reads it. */
interface OutlineFacts {
  rect: { x: number; y: number; w: number; h: number } | null;
}

/** What the outline listener saw and did. */
interface OutlineWindowFacts {
  node1: { kind: number; cells: [number, number][] } | null;
  connected: boolean;
  clicked: boolean;
  /** The plotted outline right after the step (inside the dispatch). */
  atOnce: OutlineFacts | null;
  /** The plotted outline on each of the next two animation frames. */
  frames: (OutlineFacts | null)[];
}

/**
 * Arm a one-shot listener on the render socket that, on the next binary message, clicks
 * `target` (a size stepper) and records the plotted outline at once and on the next two
 * animation frames, on `window.__fabOutline`.
 */
async function armOutlineWindow(page: Page, target: ElementHandle<Element>): Promise<void> {
  const found = await page.evaluate((el) => {
    type W = InBetweenWindow & { __fabOutline?: OutlineWindowFacts };
    const w = window as unknown as W;
    w.__fabOutline = undefined;
    const ws = (w.__fabSockets ?? []).find((s) => s.url.endsWith('/render'));
    if (!ws) return false;
    const read = (): OutlineFacts | null => {
      const hook = w.__fabrico as { labelResizePreview?(): OutlineFacts | null } | undefined;
      if (!hook?.labelResizePreview) throw new Error('window.__fabrico.labelResizePreview() not installed');
      const p = hook.labelResizePreview();
      return p ? { rect: p.rect } : null;
    };
    const onMessage = (ev: MessageEvent): void => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      ws.removeEventListener('message', onMessage);
      const n = w.__fabrico?.scene().nodes.find((x) => x.id === 1);
      const facts: OutlineWindowFacts = {
        node1: n ? { kind: n.kind, cells: n.cells } : null,
        connected: el.isConnected,
        clicked: false,
        atOnce: null,
        frames: [],
      };
      (el as HTMLElement).click();
      facts.clicked = true;
      facts.atOnce = read();
      requestAnimationFrame(() => {
        facts.frames.push(read());
        requestAnimationFrame(() => {
          facts.frames.push(read());
          w.__fabOutline = facts;
        });
      });
    };
    ws.addEventListener('message', onMessage);
    return true;
  }, target);
  expect(found, 'PRECONDITION: the render socket was recorded, so the listener is armed').toBe(
    true,
  );
}

/** Poll until the outline listener has finished, and return what it saw. */
async function outlineFacts(page: Page): Promise<OutlineWindowFacts> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __fabOutline?: OutlineWindowFacts }).__fabOutline !== undefined,
      ),
    )
    .toBe(true);
  return page.evaluate(
    () => (window as unknown as { __fabOutline?: OutlineWindowFacts }).__fabOutline!,
  );
}

/** The anchor cell and the size in cells of a plotted outline rectangle (world px, CELL 32). */
const outlineCells = (
  f: OutlineFacts | null,
): { cx: number; cy: number; w: number; h: number } | null =>
  f?.rect
    ? {
        cx: Math.floor(f.rect.x / 32),
        cy: Math.floor(f.rect.y / 32),
        w: Math.round(f.rect.w / 32),
        h: Math.round(f.rect.h / 32),
      }
    : null;

/**
 * RENDER HEALTH on the mock socket: the Pixi ticker is still running. `frame()` is the
 * render clock quantized, and the clock only moves inside the ticker toward the latest sim
 * tick, so each poll injects one more idle diff tick and the frame index must take three
 * distinct values. A dead ticker holds one value whatever is injected.
 */
async function expectRenderAlive(page: Page, h: Harness, fromTick: number, context: string): Promise<void> {
  const seen = new Set<number>();
  let tick = fromTick;
  await expect
    .poll(
      async () => {
        tick += 1;
        h.inject(buildPacket({ tick, full: false }));
        seen.add(
          await page.evaluate(
            () => (window as unknown as { __fabrico: { frame(): number } }).__fabrico.frame(),
          ),
        );
        return seen.size;
      },
      { message: `the Pixi render loop is still advancing ${context}`, timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

/**
 * Boot the real App with `machine_config` answered, inject the label board, select the
 * label on handle 1, and return the harness and its Increase width stepper.
 */
async function bootAndHoldWidthStep(
  page: Page,
  errors: string[],
): Promise<{ h: Harness; wider: ElementHandle<Element> }> {
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? LABEL_CONFIG : undefined),
  });
  await recordSockets(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ tick: 1, nodes: LABEL_BOARD }));
  // The model counts the Source and not the label (plan 77-04), at this packet's tick 1, which
  // carries both nodes; the toolbar's tick says the chrome drew it (plan 91-02).
  await waitForBoard(page, { machines: 1, tick: 1 });

  const at = await screenCellCentre(page, 12, 8);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => selectedNode(page)).toBe(1);
  await expect(page.locator('#fab-label-text'), 'PRECONDITION: the label panel loaded').toHaveValue(
    'Before',
  );
  expect(
    await page.evaluate(() =>
      (window as unknown as { __fabrico: { labelResizePreview(): unknown } }).__fabrico.labelResizePreview(),
    ),
    'PRECONDITION: no outline is plotted before the step',
  ).toBeNull();

  const locator = page.getByRole('button', { name: 'Increase width' });
  await expect(locator, 'PRECONDITION: the width stepper is enabled').toBeEnabled();
  const wider = await locator.elementHandle();
  if (!wider) throw new Error('Increase width has no element');
  return { h, wider };
}

test.describe('a label size step between a keyframe and React commit (CR-01, plan 76-19)', () => {
  test('positive control: a width step on a diff frame plots the 4 by 1 outline at the selected label', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h, wider } = await bootAndHoldWidthStep(page, errors);

    await armOutlineWindow(page, wider);
    h.inject(buildPacket({ tick: 2, full: false }));
    const facts = await outlineFacts(page);

    expect(facts.connected, 'PRECONDITION: the stepper was connected when clicked').toBe(true);
    expect(facts.clicked, 'PRECONDITION: the listener reached its click').toBe(true);
    expect(
      facts.frames.map(outlineCells),
      'POSITIVE CONTROL: the step plots the 4 by 1 outline at the label on (12,8) on the next two frames',
    ).toEqual([
      { cx: 12, cy: 8, w: 4, h: 1 },
      { cx: 12, cy: 8, w: 4, h: 1 },
    ]);
    await expectRenderAlive(page, h, 2, 'after the step on a diff frame');
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('a width step on the keyframe frame plots no outline on the label the keyframe put on the handle', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h, wider } = await bootAndHoldWidthStep(page, errors);

    await armOutlineWindow(page, wider);
    h.inject(buildPacket({ tick: 2, full: true, nodes: LABEL_REMINTED }));
    const facts = await outlineFacts(page);

    expect(
      facts.node1,
      'PRECONDITION (keyframe applied): inside the listener the scene showed handle 1 as the other label at (4,14)',
    ).toEqual({
      kind: LABEL_KIND,
      cells: [
        [4, 14],
        [5, 14],
        [6, 14],
      ],
    });
    expect(
      facts.connected,
      'PRECONDITION (React not committed): the width stepper was still connected when clicked',
    ).toBe(true);
    expect(facts.clicked, 'PRECONDITION: the listener reached its click').toBe(true);
    expect(
      [facts.atOnce, ...facts.frames].map(outlineCells),
      'OUTLINE: a width step on the frame a keyframe reminted the selected label handle plots no outline, at once or on the next two frames',
    ).toEqual([null, null, null]);

    await expect(page.locator('#fab-label-text')).toHaveCount(0);
    await expectRenderAlive(page, h, 2, 'after the step on the keyframe frame');
    expect(errors, 'no uncaught page error').toEqual([]);
  });
});

// ---- a belt panel's pace Apply (76-15 refuter round, CR-01) ----------------------------
//
// The belt panel is mounted `key={selectedBelt}` and sends through `beltPanelSendInput`,
// which App builds with `sendWhileSelected(selectedBeltRef, selectedBelt, ...)`. That gate
// refuses on the keyframe frame only because the keyframe branch nulls
// `selectedBeltRef` synchronously; without that line the ref still names the old handle
// until React commits, and a pace Apply clicked in the window sends a run-pace frame for
// whatever belt the keyframe put on that handle. The fixture is `belt-pace.spec.ts`'s:
// belt 12, three tiles on row 5 from column 14, read back at ticks_per_slot 4.

/** The belt under test, on handle 12, three tiles on row 5 (column 14+, clear of the palette). */
const PACE_BELT: InjectBelt = {
  id: 12,
  tiles: [
    [14, 5],
    [15, 5],
    [16, 5],
  ],
  ticksPerSlot: 4,
};

/** The keyframe that remints handle 12 onto another belt, three tiles on row 10. */
const PACE_BELT_REMINTED: InjectBelt = {
  id: 12,
  tiles: [
    [14, 10],
    [15, 10],
    [16, 10],
  ],
  ticksPerSlot: 4,
};

/** What `machine_config` answers for the selected belt (the host's `ConfigView::Belt`). */
const PACE_BELT_CONFIG = { kind: 'Belt', ticks_per_slot: 4 };

/** The pace pressed: ticks_per_slot 10, labelled 50 px per second. */
const PACE_PRESSED_TICKS = 10;

/** LEB128 varint at `buf[at]`, with the offset after it. */
function readVarint(buf: Buffer, at: number): [number, number] {
  let out = 0;
  let shift = 1;
  let i = at;
  for (;;) {
    const b = buf[i++];
    out += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) return [out, i];
    shift *= 128;
  }
}

/**
 * The run-pace frames (`0xFE`-led) among `h.sent` from index `from` on, decoded against
 * the byte grammar `fabrico_host::sim_loop::BeltRunPace` (count, belt handles, pace), not
 * through the app's own encoder.
 */
function runPacesSince(h: Harness, from: number): { belts: number[]; ticksPerSlot: number }[] {
  return h.sent
    .slice(from)
    .filter((f) => f[0] === 0xfe)
    .map((f) => {
      let [n, at] = readVarint(f, 1);
      const belts: number[] = [];
      for (; n > 0; n--) {
        let id: number;
        [id, at] = readVarint(f, at);
        belts.push(id);
      }
      const [ticksPerSlot] = readVarint(f, at);
      return { belts, ticksPerSlot };
    });
}

/**
 * Boot the real App with `machine_config` answered, inject belt 12, select it with a
 * click on a tile, press the 50 px per second segment so Apply is live, and return the
 * harness and Apply's element.
 */
async function bootAndPressPace(
  page: Page,
  errors: string[],
): Promise<{ h: Harness; apply: ElementHandle<Element> }> {
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? PACE_BELT_CONFIG : undefined),
  });
  await recordSockets(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ tick: 1, belts: [PACE_BELT] }));
  const at = await screenCellCentre(page, 15, 5);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('#fab-belt-config'), 'PRECONDITION: the belt panel opened').toBeVisible(
    { timeout: 10_000 },
  );

  await page
    .getByRole('group', { name: 'Belt pace' })
    .getByRole('button', { name: '50 px per second', exact: true })
    .click();
  const locator = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(locator, 'PRECONDITION: the pressed pace enables Apply').toBeEnabled();
  expect(runPacesSince(h, 0), 'PRECONDITION: no run-pace frame was sent before Apply').toEqual([]);
  const apply = await locator.elementHandle();
  if (!apply) throw new Error('Apply has no element');
  return { h, apply };
}

test.describe('a belt pace Apply clicked between a keyframe and React commit (CR-01)', () => {
  test('positive control: a pace Apply clicked on a diff frame sends one run-pace frame for belt 12', async ({
    page,
  }) => {
    const errors: string[] = [];
    const { h, apply } = await bootAndPressPace(page, errors);

    await armInBetween(page, apply);
    const sentAtArm = h.sent.length;
    h.inject(buildPacket({ tick: 2, full: false }));
    const facts = await inBetweenFacts(page);

    expect(facts.connected, 'PRECONDITION: Apply was connected when clicked').toBe(true);
    expect(facts.clicked, 'PRECONDITION: the listener reached its click').toBe(true);
    await expect.poll(() => runPacesSince(h, sentAtArm).length).toBe(1);
    await page.waitForTimeout(500);
    expect(
      runPacesSince(h, sentAtArm),
      'POSITIVE CONTROL: a pace Apply on a diff frame sends exactly one run-pace frame, belt 12 at the pressed pace',
    ).toEqual([{ belts: [12], ticksPerSlot: PACE_PRESSED_TICKS }]);
    await expectRenderAlive(page, h, 2, 'after the Apply on a diff frame');
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('a pace Apply clicked on the keyframe frame sends nothing', async ({ page }) => {
    const errors: string[] = [];
    const { h, apply } = await bootAndPressPace(page, errors);

    await armInBetween(page, apply);
    const sentAtArm = h.sent.length;
    h.inject(buildPacket({ tick: 2, full: true, belts: [PACE_BELT_REMINTED] }));
    const facts = await inBetweenFacts(page);

    expect(
      facts.belts,
      'PRECONDITION (keyframe applied): inside the listener the scene showed handle 12 as the belt on row 10',
    ).toEqual([
      {
        id: 12,
        tiles: [
          [14, 10],
          [15, 10],
          [16, 10],
        ],
      },
    ]);
    expect(
      facts.connected,
      'PRECONDITION (React not committed): Apply was still connected when clicked',
    ).toBe(true);
    expect(facts.clicked, 'PRECONDITION: the listener reached its click').toBe(true);

    await expect(page.locator('#fab-belt-config')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(
      runPacesSince(h, sentAtArm),
      'a pace Apply clicked on the frame a keyframe reminted the selected belt handle sends no run-pace frame',
    ).toEqual([]);
    await expectRenderAlive(page, h, 2, 'after the Apply on the keyframe frame');
    expect(errors, 'no uncaught page error').toEqual([]);
  });
});

// ---- a reselect of the reminted handle (76-17 refuter round, CR-01, T-76-44) -----------
//
// The panel gates of plan 76-17 compared HANDLE NUMBERS, and a handle number cannot tell
// the old node from the node a keyframe reminted onto it. Two shapes go through that hole,
// and both end with the old panel's buffer sent as a command naming the new node:
//
//  - THE KEYFRAME-FRAME RESELECT. A canvas click inside the keyframe's socket dispatch
//    selects the node the keyframe put on the selected handle. React then commits the
//    selection 1 -> 1, a panel keyed on the handle never remounts, and its stale buffer
//    (with Apply live) is the panel for the other node. Covered for a label (the node
//    panel) and a belt (the belt panel).
//  - THE VALIDATE IN FLIGHT. A Factory Apply awaits `validate_factory_js` before it
//    sends. A keyframe remints handle 1 onto Factory B, the user selects B, and only then
//    does validate answer: the old panel's continuation sends Factory A's source as a
//    Configure naming handle 1, which is B now.
//
// App now keys both panels on a SELECTION EPOCH (`selectionEpoch.ts`) and gates their
// sends on it. Each test has a positive control that makes the same moves where the
// defect cannot happen, so a broken harness cannot pass as a green.

/** The read-only belt selection hook, next to `selectedNode()`. */
async function selectedBelt(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { selectedBelt?(): number | null } })
      .__fabrico;
    if (!hook?.selectedBelt) throw new Error('window.__fabrico.selectedBelt() not installed');
    return hook.selectedBelt();
  });
}

/** What the canvas-click listener saw and did. */
interface ReselectFacts {
  /** The live node selection when the listener ran (null once the keyframe branch ran). */
  nodeAtClick: number | null;
  /** The live belt selection when the listener ran. */
  beltAtClick: number | null;
  /** Whether the panel's root element was still in the document when it clicked. */
  panelConnected: boolean;
  /** Whether the listener reached its click. */
  clicked: boolean;
}

/** Press and release the canvas at page point (`x`, `y`), the way the gesture layer reads it. */
async function canvasClickNow(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('no canvas');
    const init = {
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
      bubbles: true,
      cancelable: true,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  }, at);
}

/**
 * Arm a one-shot listener on the render socket that, on the next binary message, presses
 * and releases the canvas at page point `at` (the same events `canvasClickNow` sends) and
 * stores what it saw on `window.__fabReselect`. `panel` is the panel root it reports on.
 */
async function armCanvasClickInBetween(
  page: Page,
  at: { x: number; y: number },
  panel: string,
): Promise<void> {
  const found = await page.evaluate(
    ({ x, y, panel }) => {
      const w = window as unknown as InBetweenWindow & {
        __fabReselect?: ReselectFacts;
        __fabrico?: { selectedNode?(): number | null; selectedBelt?(): number | null };
      };
      w.__fabReselect = undefined;
      const ws = (w.__fabSockets ?? []).find((s) => s.url.endsWith('/render'));
      const canvas = document.querySelector('canvas');
      if (!ws || !canvas) return false;
      const onMessage = (ev: MessageEvent): void => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        ws.removeEventListener('message', onMessage);
        const facts: ReselectFacts = {
          nodeAtClick: w.__fabrico?.selectedNode?.() ?? null,
          beltAtClick: w.__fabrico?.selectedBelt?.() ?? null,
          panelConnected: document.querySelector(panel)?.isConnected ?? false,
          clicked: false,
        };
        const init = {
          clientX: x,
          clientY: y,
          button: 0,
          buttons: 1,
          pointerId: 1,
          isPrimary: true,
          pointerType: 'mouse',
          bubbles: true,
          cancelable: true,
        };
        canvas.dispatchEvent(new PointerEvent('pointerdown', init));
        window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
        facts.clicked = true;
        w.__fabReselect = facts;
      };
      ws.addEventListener('message', onMessage);
      return true;
    },
    { ...at, panel },
  );
  expect(found, 'PRECONDITION: the render socket and the canvas were found, so the listener is armed').toBe(
    true,
  );
}

/** Poll until the armed canvas-click listener has run, and return what it saw. */
async function reselectFacts(page: Page): Promise<ReselectFacts> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __fabReselect?: ReselectFacts }).__fabReselect !== undefined,
      ),
    )
    .toBe(true);
  return page.evaluate(
    () => (window as unknown as { __fabReselect?: ReselectFacts }).__fabReselect!,
  );
}

/** The label the keyframe put on handle 1, as `machine_config` answers it. */
const LABEL_OTHER_CONFIG = { kind: 'Label', text: 'Other', colour: 0, w: 3, h: 1 };

test.describe('a reselect of the reminted handle gets the new node its own panel (CR-01, T-76-44)', () => {
  for (const onKeyframeFrame of [false, true]) {
    const title = onKeyframeFrame
      ? 'a label selected on the keyframe frame, on the handle the edited label had, shows its own words and sends nothing'
      : 'positive control: the same label selected after React committed shows its own words and sends nothing';
    test(title, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
      let afterKeyframe = false;
      const h = await mockRenderSocket(page, {
        answerQuery: (verb) =>
          verb === 'machine_config' ? (afterKeyframe ? LABEL_OTHER_CONFIG : LABEL_CONFIG) : undefined,
      });
      await recordSockets(page);
      await page.goto('/');
      await waitForChrome(page);
      await h.connected;
      h.inject(buildPacket({ tick: 1, nodes: LABEL_BOARD }));
      // The model counts the Source and not the label (plan 77-04), at this packet's tick 1, which
      // carries both nodes; the toolbar's tick says the chrome drew it (plan 91-02).
      await waitForBoard(page, { machines: 1, tick: 1 });

      const at = await screenCellCentre(page, 12, 8);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.up();
      await expect.poll(() => selectedNode(page)).toBe(1);
      const text = page.locator('#fab-label-text');
      await expect(text, 'PRECONDITION: the label panel loaded its words').toHaveValue('Before');
      await text.fill('After');
      await expect(
        page.getByRole('button', { name: 'Apply', exact: true }),
        'PRECONDITION: the edited Text enables Apply',
      ).toBeEnabled();

      // The other label, which the keyframe puts on handle 1 at (4,14).
      const other = await screenCellCentre(page, 5, 14);
      if (onKeyframeFrame) await armCanvasClickInBetween(page, other, '#fab-label-text');
      afterKeyframe = true;
      h.inject(buildPacket({ tick: 2, full: true, nodes: LABEL_REMINTED }));
      if (onKeyframeFrame) {
        const facts = await reselectFacts(page);
        expect(
          { node: facts.nodeAtClick, panel: facts.panelConnected, clicked: facts.clicked },
          'PRECONDITION (keyframe applied, React not committed): the selection was cleared and the old panel still mounted when the click ran',
        ).toEqual({ node: null, panel: true, clicked: true });
      } else {
        await expect(text, 'PRECONDITION: React committed the deselect first').toHaveCount(0);
        await canvasClickNow(page, other);
      }
      await expect
        .poll(() => selectedNode(page), { message: 'the click selected the label now on handle 1' })
        .toBe(1);

      // Soft, so a stale panel is graded on all three facts: what it shows, whether its
      // Apply is live, and what that Apply sends when clicked.
      const sentAt = h.sent.length;
      await expect
        .soft(
          text,
          'the panel for the label now on handle 1 shows that label\'s own words, not the edited buffer',
        )
        .toHaveValue('Other');
      const apply = page.getByRole('button', { name: 'Apply', exact: true });
      await expect.soft(apply, 'a freshly loaded label panel has nothing to Apply').toBeDisabled();
      // A stale panel's Apply is live: click it, so the send it makes is graded too.
      if (await apply.isEnabled()) await apply.click();
      await page.waitForTimeout(500);
      expect(
        configuresSince(h, sentAt),
        'no Configure carrying the old label\'s buffer is sent to handle 1',
      ).toEqual([]);
      await expectRenderAlive(page, h, 2, 'after the reselect');
      expect(errors, 'no uncaught page error').toEqual([]);
    });
  }

  for (const onKeyframeFrame of [false, true]) {
    const title = onKeyframeFrame
      ? 'a belt selected on the keyframe frame, on the handle the edited belt had, shows its own pace and sends nothing'
      : 'positive control: the same belt selected after React committed shows its own pace and sends nothing';
    test(title, async ({ page }) => {
      const errors: string[] = [];
      const { h } = await bootAndPressPace(page, errors);
      const pressed = page
        .getByRole('group', { name: 'Belt pace' })
        .getByRole('button', { name: '50 px per second', exact: true });
      await expect(pressed, 'PRECONDITION: the edited pace is pressed').toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // The other belt, which the keyframe puts on handle 12 on row 10.
      const other = await screenCellCentre(page, 15, 10);
      if (onKeyframeFrame) await armCanvasClickInBetween(page, other, '#fab-belt-config');
      h.inject(buildPacket({ tick: 2, full: true, belts: [PACE_BELT_REMINTED] }));
      if (onKeyframeFrame) {
        const facts = await reselectFacts(page);
        expect(
          { belt: facts.beltAtClick, panel: facts.panelConnected, clicked: facts.clicked },
          'PRECONDITION (keyframe applied, React not committed): the belt selection was cleared and the old panel still mounted when the click ran',
        ).toEqual({ belt: null, panel: true, clicked: true });
      } else {
        await expect(
          page.locator('#fab-belt-config'),
          'PRECONDITION: React committed the deselect first',
        ).toHaveCount(0);
        await canvasClickNow(page, other);
      }
      await expect
        .poll(() => selectedBelt(page), { message: 'the click selected the belt now on handle 12' })
        .toBe(12);
      await expect(page.locator('#fab-belt-config')).toBeVisible();

      // Soft, for the reason the label leg above gives.
      const sentAt = h.sent.length;
      await expect
        .soft(
          pressed,
          'the panel for the belt now on handle 12 shows that belt\'s own pace, not the pressed one',
        )
        .toHaveAttribute('aria-pressed', 'false');
      const apply = page.getByRole('button', { name: 'Apply', exact: true });
      await expect.soft(apply, 'a freshly loaded belt panel has nothing to Apply').toBeDisabled();
      if (await apply.isEnabled()) await apply.click();
      await page.waitForTimeout(500);
      expect(
        runPacesSince(h, sentAt),
        'no run-pace frame carrying the old belt\'s pressed pace is sent',
      ).toEqual([]);
      await expectRenderAlive(page, h, 2, 'after the belt reselect');
      expect(errors, 'no uncaught page error').toEqual([]);
    });
  }
});

// ---- a Factory Apply whose validate is in flight across a keyframe ---------------------

/** A 3x3 Factory on handle `id` with its top-left cell at (`x`, 8). */
const factoryAt = (id: number, x: number): InjectNode => ({
  id,
  kind: 2,
  cell_x: x,
  cell_y: 8,
  w: 3,
  h: 3,
  ports: [
    { index: 0, cell_x: x, cell_y: 9, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: x + 2, cell_y: 9, side: 1, role: 1, medium: 0 },
    { index: 2, cell_x: x + 1, cell_y: 10, side: 2, role: 2, medium: 0 },
  ],
});

/** What `machine_config` answers for either Factory. */
const FACTORY_CONFIG = { kind: 'Factory', source: 'export default (payload) => payload;' };

/** The words typed into Factory A's source, found again in any Configure that carries them. */
const FACTORY_A_EDIT = '// EDITED_IN_FACTORY_A';

/**
 * Record the reqId of every `validate_factory_js` query the page sends, on
 * `window.__fabValidates`. Installed after `recordSockets`, it wraps the recorded class's
 * `send` and changes nothing it forwards.
 */
async function recordValidates(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { WebSocket: typeof WebSocket; __fabValidates?: number[] };
    w.__fabValidates = [];
    const proto = w.WebSocket.prototype;
    const send = proto.send;
    proto.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
      if (typeof data === 'string' && data.startsWith('query\n')) {
        const req = JSON.parse(data.slice('query\n'.length)) as { reqId: number; verb: string };
        if (req.verb === 'validate_factory_js') w.__fabValidates!.push(req.reqId);
      }
      return send.call(this, data);
    };
  });
}

/** Answer every held `validate_factory_js` query Ok, as the dev socket's reply would. */
async function answerValidates(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as InBetweenWindow & { __fabValidates?: number[] };
    const ws = (w.__fabSockets ?? []).find((s) => s.url.endsWith('/render'));
    if (!ws) throw new Error('the render socket was not recorded');
    const ids = w.__fabValidates ?? [];
    for (const reqId of ids) {
      ws.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify({ reqId, ok: true, value: null }) }),
      );
    }
    w.__fabValidates = [];
    return ids.length;
  });
}

/** The Configure frames among `h.sent` from `from` on, with whether each carries the edit. */
function factoryConfiguresSince(h: Harness, from: number): { node?: number; carriesEdit: boolean }[] {
  return h.sent
    .slice(from)
    .filter((f) => gestureSubject(f).cmd === 'Configure')
    .map((f) => ({ node: gestureSubject(f).node, carriesEdit: f.includes(Buffer.from(FACTORY_A_EDIT)) }));
}

/**
 * Boot the real App with `machine_config` answered and `validate_factory_js` HELD, inject
 * Factory A on handle 1 at (10,8) and Factory B on handle 2 at (20,8), select A, append
 * `FACTORY_A_EDIT` to its source and click Apply, so the Apply waits on validate.
 */
async function bootAndApplyFactoryA(page: Page, errors: string[]): Promise<Harness> {
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  const h = await mockRenderSocket(page, {
    // validate_factory_js is not answered here: the test answers it when it chooses.
    answerQuery: (verb) => (verb === 'machine_config' ? FACTORY_CONFIG : undefined),
  });
  await recordSockets(page);
  await recordValidates(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 1, nodes: [factoryAt(1, 10), factoryAt(2, 20)] }));
  await waitForBoard(page, { machines: 2 });

  const at = await screenCellCentre(page, 11, 9);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => selectedNode(page)).toBe(1);
  const editor = page.locator('.cm-content');
  await expect(editor, 'PRECONDITION: Factory A\'s source editor mounted').toBeVisible({
    timeout: 10_000,
  });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(` ${FACTORY_A_EDIT}`);
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply, 'PRECONDITION: the edit enables Apply').toBeEnabled();
  await apply.click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __fabValidates?: number[] }).__fabValidates?.length ?? 0,
        ),
      { message: 'PRECONDITION: the Apply is waiting on validate_factory_js' },
    )
    .toBe(1);
  expect(
    factoryConfiguresSince(h, 0),
    'PRECONDITION: nothing was sent before validate answered',
  ).toEqual([]);
  return h;
}

test.describe('a Factory Apply whose validate is in flight across a keyframe (CR-01, T-76-44)', () => {
  test('positive control: validate answers with Factory A still selected, one Configure for handle 1 carrying the edit', async ({
    page,
  }) => {
    const errors: string[] = [];
    const h = await bootAndApplyFactoryA(page, errors);
    expect(await answerValidates(page), 'PRECONDITION: one validate was answered').toBe(1);
    await expect.poll(() => factoryConfiguresSince(h, 0).length).toBe(1);
    await page.waitForTimeout(500);
    expect(
      factoryConfiguresSince(h, 0),
      'POSITIVE CONTROL: the Apply sends exactly one Configure, naming handle 1, carrying the edit',
    ).toEqual([{ node: 1, carriesEdit: true }]);
    await expectRenderAlive(page, h, 1, 'after the Apply');
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('a keyframe remints handle 1 onto Factory B and the user selects B before validate answers: nothing is sent', async ({
    page,
  }) => {
    const errors: string[] = [];
    const h = await bootAndApplyFactoryA(page, errors);
    // Undo-shaped: handle 1 now names Factory B at (20,8), and A moved to handle 2.
    h.inject(buildPacket({ tick: 2, full: true, nodes: [factoryAt(1, 20), factoryAt(2, 10)] }));
    await expect.poll(() => selectedNode(page)).toBeNull();
    await expect(page.locator('.cm-content'), 'PRECONDITION: Factory A\'s panel unmounted').toHaveCount(0);

    // The user selects Factory B, which now sits on handle 1.
    const b = await screenCellCentre(page, 21, 9);
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => selectedNode(page), { message: 'PRECONDITION: B is selected on handle 1' }).toBe(1);
    await expect(page.locator('.cm-content'), 'PRECONDITION: B\'s panel mounted').toBeVisible();

    expect(await answerValidates(page), 'PRECONDITION: the held validate was answered').toBe(1);
    await page.waitForTimeout(500);
    expect(
      factoryConfiguresSince(h, 0),
      'Factory A\'s Apply, validating when the keyframe landed, sends no Configure onto Factory B on handle 1',
    ).toEqual([]);
    await expectRenderAlive(page, h, 2, 'after validate answered');
    expect(errors, 'no uncaught page error').toEqual([]);
  });
});

// ---- a selection change replaces the panel, on the real App (76-17 refuter round) ------
//
// App's `onSelect` must move the selection epoch on a change of node, or the panel keyed
// on it is kept across machines. Graded by the panel's own element identity rather than
// by what it shows: the panel reloads its config on a node change even when it is not
// remounted, so its words alone cannot tell the two apart.
//
// The opposite direction (clicking the selected machine again keeps the epoch, so the
// panel and its uncommitted buffer stay) is graded in `selectionEpoch.test.ts` only. A
// second press-release on the selected label in this harness does not reach `onSelect`
// at all (measured with a logging build: one `onSelect(1)` for both clicks), so a leg
// here could not see that property and is not claimed.

/** The ConfigPanel's root, found by the heading it is labelled by. */
const PANEL_ROOT = 'aside[aria-labelledby="fab-config-heading"]';

test('selecting another machine replaces the label panel', async ({ page }) => {
  const errors: string[] = [];
  const { h } = await bootAndEditLabel(page, errors);
  const panel = await page.locator(PANEL_ROOT).elementHandle();
  if (!panel) throw new Error('PRECONDITION: the label panel has a root element');

  // The label sat under the inspector's column, so selecting it slid the board left (phase 91,
  // plan 91-09, CHROME-07) and the Source went under the palette. Fit frames the board again
  // without touching the selection; the Source's point is read after it.
  await page.getByRole('button', { name: 'Fit factory to view' }).click();
  const source = await screenCellCentre(page, 4, 4);
  expect(
    await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [source.x, source.y] as const),
    'PRECONDITION: the Source is on the open board',
  ).toBe('CANVAS');
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => selectedNode(page), { message: 'PRECONDITION: the Source is selected' }).toBe(0);
  await expect(page.locator(PANEL_ROOT), 'PRECONDITION: a panel is shown for the Source').toBeVisible();
  await expect
    .poll(() => panel.evaluate((el) => el.isConnected), {
      message: 'selecting another machine replaces the panel, so the label panel element is gone',
    })
    .toBe(false);
  expect(configuresSince(h, 0), 'nothing was applied').toEqual([]);
  await expectRenderAlive(page, h, 1, 'after the selection change');
  expect(errors, 'no uncaught page error').toEqual([]);
});
