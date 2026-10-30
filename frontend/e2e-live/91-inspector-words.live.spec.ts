import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  armAndPlaceAt,
  clickAt,
  deselectViaEmptyCell,
  drawBeltThroughCells,
  drawOffloadBelt,
  ensurePlaying,
  expectRenderLoopAlive,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  screenCellCentre,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { PORT_STATUS } from '../src/chrome/configCopy';

// 91-inspector-words.live.spec.ts (phase 91, plan 91-07, CHROME-13, D-12, success criterion 4's
// inspector clause, UI-SPEC walk steps 14 to 16) - the inspector's words are plain and true on the
// REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero
// injected packets: the demo board is the shipped one, loaded through Examples.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (91-MEASURE.md `## CHROME-13`)
// ---------------------------------------------------------------------------
//
// A port row read `{n} moving`, the item count on its belt, so a belt jammed solid read `12
// moving` while nothing on it could move (todo 2026-10-20). D-12 replaces the count with one of
// four words (`PORT_STATUS`, `chrome/configCopy.ts`), read from the render packet's facts
// (`protocol/portFlow.ts`): a docked belt is `backed up` when its head slot holds an item and its
// head docks nowhere, into a BACKED_UP machine, or into a belt that is itself backed up.
//
// THE RULE THE UI-SPEC FIRST WROTE WOULD HAVE CALLED EVERY BELT BACKED UP (research Finding E): it
// read `ItemView.arrival_tick` as a tick ("an item whose arrival_tick is below the packet tick is
// overdue"), and on the wire it is the slot index. A jammed board reads backed up under either
// rule, so the jammed leg (`87-jammed-board-idle` leg 1) cannot tell them apart. This spec's
// flowing leg is the one that can: on the demo board, belts that flow must read `moving` and never
// `backed up`, and the leg was run red against the original rule as a mutation (91-EVIDENCE.md,
// `MUT port-words-demo`).
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   a flowing belt reads moving: the demo board, playing. The Tee is selected: its Out whose belt
//      reaches the Audit Sink reads `moving`, and every 200 ms for 3 s neither Tee Out reads
//      `backed up` and no row shows a count. Then the Router is selected and its three Outs (into
//      the Merge and the Balancer) are sampled the same way, and at least one of them must read
//      `moving` during the window (review WR-C04: without that floor an all-`idle` Router half
//      passed). The words seen are logged, so the walk can read whether a word flickers between
//      `moving` and `idle` (UI-SPEC 8.5 backstop).
//   notes only where they apply: on the demo board the Source, the Audit Sink, the Router and
//      belt 21 each show an Outputs group with no note after it and no `Only a Factory` sentence.
//      A Factory placed on clear demo floor shows no removal note; once a belt is drawn off its
//      Out, `Removing this output disconnects its belt.` is that row's note, described by that
//      row's Remove button, and on no other row.
//   Router outputs have names: on an empty board a palette Router whose Out 1 is belted to a
//      palette Sink names its outputs `Output 1 (Sink)`, `Output 2`, `Output 3` in the Default
//      group, its Outputs list reads `Output 1 - Item` onward, the fallthrough names `Output 1
//      (Sink)`, and no `(x,y)` cell label appears anywhere in the panel.
//   Handler, not wire: the demo Route's panel reads `POST a JSON body to call its Handler.` at
//      line height 1.4, and the Legend's Route row reads `POST here to call its Handler`.
//
// RED FIRST (D-17): run by `redfirst.sh` at PHASE91_START in the kept start worktree (that
// revision's host and frontend, this spec and `configCopy.ts` carried in), where every row read
// `{n} moving` (91-EVIDENCE.md, `D17 case=CHROME-13-ports-live`), and where the notes, the cell
// labels and the wire wording stood (`D17 case=CHROME-13-notes-live`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

/** Kind bytes (protocol `machine_kind`), transcribed. */
const KIND_TEE = 3;
const KIND_ROUTER = 5;
const KIND_SINK = 7;
/** Port role byte for an output (oracle `PortFacts.role`). */
const ROLE_OUT = 1;

/** The demo board's anchors (`demo_scene.board.ron`): the Source (node 0), the Tee (2), the Audit
 *  Sink (4), the Router (7) and the caller Route (29); belt 21's middle tile (the Tee copy into
 *  the Audit Sink); a floor cell clear of everything to deselect on. */
const DEMO_SOURCE_AT: [number, number] = [1, 3];
const DEMO_TEE_AT: [number, number] = [9, 3];
const DEMO_AUDIT_SINK_AT: [number, number] = [14, 4];
const DEMO_ROUTER_AT: [number, number] = [14, 0];
const DEMO_ROUTE_AT: [number, number] = [13, 6];
const DEMO_BELT21_MIDDLE: [number, number] = [12, 4];
const DEMO_FLOOR: [number, number] = [11, 9];
/** The Factory leg's drop cell: the 3x3 box (6..8, 11..13) is clear demo floor, and so is the
 *  run east of its Out at (8,12) (the cells `89-turn-back-reconnects` draws through). */
const FACTORY_AT: [number, number] = [6, 11];
const FACTORY_OUT_RUN: [number, number][] = [
  [9, 12],
  [10, 12],
  [11, 12],
];
/** The Router leg, on an empty board (the `19-router-rules` seating): a 2x3 Router at (8,4)
 *  whose Out 1 (routing key 0) sits at (9,5) facing east, and a 1x1 Sink at (13,5) whose In
 *  faces west onto (12,5). */
const ROUTER_AT: [number, number] = [8, 4];
const SINK_AT: [number, number] = [13, 5];
const ROUTER_TO_SINK: [number, number][] = [
  [10, 5],
  [11, 5],
  [12, 5],
];
const EMPTY_FLOOR_CELL: [number, number] = [6, 7];
const KIND_FACTORY = 2;
const ROLE_IN = 0;
/** The docked-output note and the Route notes, as literals: this spec restates what the
 *  panel says (UI-SPEC 8.4). */
const DOCKED_OUTPUT_NOTE = 'Removing this output disconnects its belt.';
const ROUTE_POST_NOTE = 'POST a JSON body to call its Handler.';
const LEGEND_ROUTE_HINT = 'POST here to call its Handler';

/** The sample: every 200 ms for 3 s. */
const SAMPLE_EVERY_MS = 200;
const SAMPLE_FOR_MS = 3000;

/** The four words, as the panel renders them. */
const WORDS: readonly string[] = Object.values(PORT_STATUS);

/** The selected machine's Outputs rows, in the panel's order (packet order of its Outs). */
function outputRows(page: Page): Locator {
  return page.getByRole('region', { name: 'Ports' }).getByRole('list', { name: 'Outputs' }).getByRole('listitem');
}

/** Every `<p>` after the Outputs list in the Ports section: the group's notes. */
async function notesAfterOutputs(page: Page): Promise<string[]> {
  return page
    .getByRole('region', { name: 'Ports' })
    .getByRole('list', { name: 'Outputs' })
    .evaluate((list) => {
      const out: string[] = [];
      for (let el = list.nextElementSibling; el !== null; el = el.nextElementSibling) {
        if (el.tagName === 'P') out.push((el.textContent ?? '').trim());
      }
      return out;
    });
}

/** The status word at the end of a row's accessible name (`${label}, ${status}`). */
function statusOf(name: string): string {
  return name.slice(name.lastIndexOf(', ') + 2);
}

/** The node seated at an anchor, required. */
function nodeAt(scene: SceneFacts, at: [number, number], kind: number): SceneFacts['nodes'][number] {
  const node = nodeAtAnchor(scene, at[0], at[1]);
  expect(node?.kind, `the demo board holds kind ${kind} at (${at[0]},${at[1]})`).toBe(kind);
  return node!;
}

/** Which of `node`'s Outs (by routing key, the panel's Outputs order) carries a belt whose Head
 *  docks a machine of `kind`. */
function outKeyInto(scene: SceneFacts, node: SceneFacts['nodes'][number], kind: number): number {
  const outs = node.ports.filter((p) => p.role === ROLE_OUT).length;
  for (let key = 0; key < outs; key += 1) {
    const belt = scene.belts.find((b) => b.docks.some((d) => d.end === 'Tail' && d.node === node.id && d.port === key));
    const head = belt?.docks.find((d) => d.end === 'Head');
    if (head !== undefined && scene.nodes.find((n) => n.id === head.node)?.kind === kind) return key;
  }
  return -1;
}

/** Sample the Out rows every SAMPLE_EVERY_MS for SAMPLE_FOR_MS; returns each row's words in order. */
async function sampleOutRows(page: Page, rowCount: number): Promise<string[][]> {
  const seen: string[][] = Array.from({ length: rowCount }, () => []);
  const until = Date.now() + SAMPLE_FOR_MS;
  while (Date.now() < until) {
    const names = await outputRows(page).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
    for (let i = 0; i < rowCount; i += 1) seen[i].push(names[i] ?? '(missing)');
    await page.waitForTimeout(SAMPLE_EVERY_MS);
  }
  return seen;
}

test.describe('91 live: the inspector words are plain and true (CHROME-13)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('a flowing belt reads moving: on the demo board the Tee belt into a Sink and the Router belts never read backed up', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await ensurePlaying(page);

    const scene = await readScene(page);
    const tee = nodeAt(scene, DEMO_TEE_AT, KIND_TEE);
    const router = nodeAt(scene, DEMO_ROUTER_AT, KIND_ROUTER);
    const sinkKey = outKeyInto(scene, tee, KIND_SINK);
    expect(sinkKey, "NON-VACUITY: one of the demo Tee's Outs belts into a Sink (the Audit copy)").toBeGreaterThanOrEqual(0);

    // The Tee: the row into the Sink reads `moving` once items flow, then 3 s of samples.
    await selectMachineAt(page, DEMO_TEE_AT[0], DEMO_TEE_AT[1]);
    const teeOuts = tee.ports.filter((p) => p.role === ROLE_OUT).length;
    await expect(outputRows(page), 'the Tee panel lists its two Outs').toHaveCount(teeOuts);
    await expect
      .poll(async () => statusOf((await outputRows(page).nth(sinkKey).getAttribute('aria-label')) ?? ''), {
        message: `the Tee's Out ${sinkKey + 1}, the belt into the Audit Sink, reads ${PORT_STATUS.moving}`,
        timeout: 15_000,
      })
      .toBe(PORT_STATUS.moving);
    const teeSeen = await sampleOutRows(page, teeOuts);
    console.log(`P91-CHROME-13 demo tee_sink_key=${sinkKey} tee=${JSON.stringify(teeSeen.map((r) => r.map(statusOf)))}`);
    await expectRenderLoopAlive(page, 'with the Tee selected on the flowing demo board');

    // The Router: its three Outs belt into the Merge and the Balancer, which take items.
    await selectMachineAt(page, DEMO_ROUTER_AT[0], DEMO_ROUTER_AT[1]);
    const routerOuts = router.ports.filter((p) => p.role === ROLE_OUT).length;
    await expect(outputRows(page).filter({ hasNotText: 'Fault' }), 'the Router panel lists its Outs').toHaveCount(routerOuts);
    const routerSeen = await sampleOutRows(page, routerOuts);
    console.log(`P91-CHROME-13 demo router=${JSON.stringify(routerSeen.map((r) => r.map(statusOf)))}`);

    const all = [...teeSeen, ...routerSeen].flat();
    expect(all.length, 'NON-VACUITY: the rows were sampled').toBeGreaterThan(2 * (SAMPLE_FOR_MS / SAMPLE_EVERY_MS));
    expect(
      all.filter((name) => !WORDS.includes(statusOf(name))),
      'every sampled row ends in one of the four PORT_STATUS words, never a count',
    ).toEqual([]);
    expect(
      teeSeen[sinkKey].filter((name) => statusOf(name) === PORT_STATUS.moving).length,
      `the Tee belt into the Sink reads ${PORT_STATUS.moving} on most samples`,
    ).toBeGreaterThan(teeSeen[sinkKey].length / 2);
    expect(
      all.filter((name) => statusOf(name) === PORT_STATUS.backedUp),
      `no flowing belt on the demo board ever reads ${PORT_STATUS.backedUp}`,
    ).toEqual([]);
    // NON-VACUITY FOR THE ROUTER HALF (phase 91 review WR-C04). The two checks above pass with no
    // flow at all (an Out that read `idle` on every sample is one of the four words and never
    // `backed up`), so the Router half graded nothing unless one of its rows carried items. The
    // demo's orders go to its Outs in turn, so a row reads `moving` and `idle` by turns (the 91-11
    // walk counted 13 of 20 on the Balancer's input); over the window some Router row must read
    // `moving`, which is the case this half is for: a belt into a machine that is taking items
    // reads `moving`, not `backed up`.
    const routerMoving = routerSeen.map((r) => r.filter((name) => statusOf(name) === PORT_STATUS.moving).length);
    expect(
      routerMoving.some((c) => c > 0),
      `NON-VACUITY: a Router Out read ${PORT_STATUS.moving} during the sample (per Out: ${JSON.stringify(routerMoving)})`,
    ).toBe(true);

    await expectRenderLoopAlive(page, 'after the flowing samples');
    errs.assertNone('while the demo board flowed under the inspector');
  });

  test('notes only where they apply: no Outputs note on the demo Source, Sink, Router or a belt, and the removal note only on a docked Factory Out', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await ensurePlaying(page);
    const ports = page.getByRole('region', { name: 'Ports' });

    for (const [what, at] of [
      ['the Source', DEMO_SOURCE_AT],
      ['the Audit Sink', DEMO_AUDIT_SINK_AT],
      ['the Router', DEMO_ROUTER_AT],
    ] as const) {
      await selectMachineAt(page, at[0], at[1]);
      await expect(ports, `${what}'s panel carries the Ports region`).toBeVisible();
      expect(await notesAfterOutputs(page), `${what}: no note follows its Outputs group`).toEqual([]);
      await expect(ports.getByText(/Only a Factory/), `${what}: no Factory-only sentence`).toHaveCount(0);
      await deselectViaEmptyCell(page, DEMO_FLOOR[0], DEMO_FLOOR[1]);
    }

    // Belt 21, by a real click on its middle tile.
    const mid = await screenCellCentre(page, DEMO_BELT21_MIDDLE[0], DEMO_BELT21_MIDDLE[1]);
    await expect
      .poll(() => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [mid.x, mid.y] as const), {
        message: "belt 21's middle tile is on the open board before it is clicked",
      })
      .toBe('CANVAS');
    await clickAt(page, mid.x, mid.y);
    await expect(page.locator('#fab-belt-config'), "clicking belt 21's middle tile selected the belt").toBeVisible();
    expect(await notesAfterOutputs(page), 'the belt panel: no note follows its Outputs group').toEqual([]);
    await expect(ports.getByText(/Only a Factory/)).toHaveCount(0);
    await deselectViaEmptyCell(page, DEMO_FLOOR[0], DEMO_FLOOR[1]);
    await expectRenderLoopAlive(page, 'after the four non-Factory panels');

    // A fresh Factory: one undocked Out, no removal note anywhere.
    await armAndPlaceAt(page, 'Factory', FACTORY_AT[0], FACTORY_AT[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, FACTORY_AT[0], FACTORY_AT[1])?.kind ?? -1, {
      message: `the palette Factory was placed at (${FACTORY_AT[0]},${FACTORY_AT[1]})`,
    }).toBe(KIND_FACTORY);
    await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
    await expect(ports.getByText(DOCKED_OUTPUT_NOTE), 'a fresh Factory shows no removal note').toHaveCount(0);
    expect(
      await ports.getByRole('button', { name: 'Remove output 1' }).getAttribute('aria-describedby'),
      "the fresh Factory's Remove is described by nothing",
    ).toBeNull();
    await deselectViaEmptyCell(page, DEMO_FLOOR[0], DEMO_FLOOR[1]);

    // A belt off its Out: the note appears on that row, described by that row's Remove.
    const factory = nodeAtAnchor(await readScene(page), FACTORY_AT[0], FACTORY_AT[1])!;
    const out = factory.ports.find((p) => p.role === ROLE_OUT)!;
    await drawOffloadBelt(page, out, FACTORY_OUT_RUN);
    await pollScene(
      page,
      (s) => s.belts.some((b) => b.docks.some((d) => d.end === 'Tail' && d.node === factory.id)),
      { message: "the belt drawn off the Factory's Out docked its Tail there" },
    ).toBe(true);
    await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
    await expect(ports.getByText(DOCKED_OUTPUT_NOTE, { exact: true }), 'the removal note appears once').toHaveCount(1);
    const describedBy = await ports.getByRole('button', { name: 'Remove output 1' }).getAttribute('aria-describedby');
    expect(describedBy, "the docked Out's Remove names its note").toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toHaveText(DOCKED_OUTPUT_NOTE);
    expect(
      await page.locator(`#${describedBy}`).evaluate((el) => el.closest('[role="listitem"]')?.getAttribute('aria-label') ?? ''),
      "the note sits on the docked Out's own row",
    ).toMatch(/^Output - Item, /);
    await expect(
      ports.getByRole('list', { name: 'Inputs' }).getByText(DOCKED_OUTPUT_NOTE),
      'no In row carries it',
    ).toHaveCount(0);

    await expectRenderLoopAlive(page, 'after the docked-output note');
    errs.assertNone('while the inspector notes were read');
  });

  test('Router outputs are named by number and target: Output 1 (Sink), Output 2, Output 3, and no cell label', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensurePlaying(page);
    await resetToDemo(page);
    await newBoard(page);
    await waitForCameraSettle(page);

    // The palette row's own name, read rather than typed: it is `Router` since plan 91-05
    // (CHROME-09) and was `Item Router` at PHASE91_START, where this leg's red-first run
    // must reach the Router panel to read its cell labels.
    const routerRow = await page.getByRole('button', { name: /^Place (Item )?Router$/ }).getAttribute('aria-label');
    await armAndPlaceAt(page, (routerRow ?? 'Place Router').replace(/^Place /, ''), ROUTER_AT[0], ROUTER_AT[1]);
    await pollScene(
      page,
      (s) => (nodeAtAnchor(s, ROUTER_AT[0], ROUTER_AT[1])?.ports ?? []).filter((p) => p.role === ROLE_OUT).length,
      { message: 'the palette Router settles with its three Outs' },
    ).toBe(3);
    await waitForCameraSettle(page);
    await armAndPlaceAt(page, 'Sink', SINK_AT[0], SINK_AT[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, SINK_AT[0], SINK_AT[1])?.kind ?? -1, {
      message: 'the palette Sink was placed',
    }).toBe(KIND_SINK);
    await waitForCameraSettle(page);

    const scene = await readScene(page);
    const router = nodeAtAnchor(scene, ROUTER_AT[0], ROUTER_AT[1])!;
    const sink = nodeAtAnchor(scene, SINK_AT[0], SINK_AT[1])!;
    const outs = router.ports.filter((p) => p.role === ROLE_OUT);
    const sinkIn = sink.ports.find((p) => p.role === ROLE_IN)!;
    expect([outs[0].cell_x, outs[0].cell_y], 'NON-VACUITY: Output 1 (routing key 0) sits on the middle row').toEqual([
      ROUTER_AT[0] + 1,
      ROUTER_AT[1] + 1,
    ]);
    await drawBeltThroughCells(page, outs[0], ROUTER_TO_SINK, sinkIn);
    await pollScene(
      page,
      (s) =>
        s.belts.some(
          (b) =>
            b.docks.some((d) => d.end === 'Tail' && d.node === router.id && d.port === 0) &&
            b.docks.some((d) => d.end === 'Head' && d.node === sink.id),
        ),
      { message: "the belt runs from the Router's Output 1 into the Sink's In" },
    ).toBe(true);

    await selectMachineAt(page, ROUTER_AT[0], ROUTER_AT[1]);
    const def = page.getByRole('group', { name: 'Default' });
    await expect(def.getByRole('button'), 'the Default group names each output by number, Output 1 with its target').toHaveText([
      'None (fault)',
      'Output 1 (Sink)',
      'Output 2',
      'Output 3',
    ]);
    await expect(outputRows(page).filter({ hasNotText: 'Fault' }), 'the Outputs list numbers its rows').toHaveCount(3);
    const outNames = (await outputRows(page).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''))).slice(0, 3);
    expect(outNames.map((n) => n.slice(0, n.lastIndexOf(', ')))).toEqual(['Output 1 - Item', 'Output 2 - Item', 'Output 3 - Item']);
    await expect(page.locator('#fab-route-fallthrough'), 'the fallthrough names the default output and its target').toHaveText(
      'Items matching no rule go to Output 1 (Sink).',
    );
    await expect(page.locator('#fab-route-note')).toHaveText(
      'The first rule that matches wins. Output numbers match the Outputs list below.',
    );
    // A rule appended in the buffer shows the same segments under Send to.
    await page.locator('#fab-route-add').click();
    await expect(page.getByRole('group', { name: 'Send to, rule 1' }).getByRole('button')).toHaveText([
      'Output 1 (Sink)',
      'Output 2',
      'Output 3',
    ]);
    const panelText = await page.locator('aside.fab-panel[aria-labelledby="fab-config-heading"]').innerText();
    expect(panelText, 'no (x,y) cell label anywhere in the Router panel').not.toMatch(/\(\d+,\d+\)/);
    await page.getByRole('button', { name: 'Revert' }).click();
    await deselectViaEmptyCell(page, EMPTY_FLOOR_CELL[0], EMPTY_FLOOR_CELL[1]);

    await expectRenderLoopAlive(page, 'after the Router names');
    errs.assertNone('while the Router outputs were named');
  });

  test('Handler, not wire: the demo Route panel and the Legend say call its Handler', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    await selectMachineAt(page, DEMO_ROUTE_AT[0], DEMO_ROUTE_AT[1]);
    const note = page.getByText(ROUTE_POST_NOTE, { exact: true });
    await expect(note, 'the Route panel says the POST calls its Handler').toBeVisible();
    const lh = await note.evaluate((el) => {
      const cs = getComputedStyle(el);
      return Number.parseFloat(cs.lineHeight) / Number.parseFloat(cs.fontSize);
    });
    expect(lh, 'the Route note sits at line height 1.4').toBeCloseTo(1.4, 2);
    await deselectViaEmptyCell(page, DEMO_FLOOR[0], DEMO_FLOOR[1]);

    await page.getByRole('button', { name: 'Legend' }).click();
    await expect(page.getByText(LEGEND_ROUTE_HINT, { exact: true }), "the Legend's Route row says call its Handler").toBeVisible();
    await page.getByRole('button', { name: 'Legend' }).click();

    await expectRenderLoopAlive(page, 'after the Route and Legend reads');
    errs.assertNone('while the Handler wording was read');
  });
});
