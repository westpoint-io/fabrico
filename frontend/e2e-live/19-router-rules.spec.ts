import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  appendRouterRule,
  applyConfig,
  armAndPlaceAt,
  deselectViaEmptyCell,
  drawBeltThroughCells,
  drawOffloadBelt,
  expectRenderLoopAlive,
  newBoard,
  pollScene,
  pressSegment,
  readRouterTable,
  readScene,
  resetToDemo,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 19-router-rules.spec.ts (ROUTE-01 / ROUTE-03, 65-UI-SPEC row V10) - the leg that
// samples the PRODUCT rather than a layer.
//
// Every other leg in phase 65 proves one stratum: the core fold, the command-layer
// refusal, the panel body's unit behaviour, the encoder round trip. This one starts
// from an EMPTY board and drives the whole path a user drives - place a Router
// from the palette, feed it, offload every output, type a two-rule table into the
// panel, Apply, then post real items at the Source's own loopback webhook - against a
// real Rust host over the development transport. Nothing here is mocked and nothing
// is injected: the only writes are pointer gestures and HTTP POSTs at the shipped
// front door.
//
// THE TWO ASSERTIONS AT THE END OF EVERY TEST ARE NOT DECORATION.
// The live oracle reads `window.__fabrico.scene()`, which is the MODEL. A board that
// routes perfectly behind a renderer that has stopped drawing satisfies every state
// assertion in this file. That exact failure is a recorded finding on this project, so
// `expectRenderLoopAlive` plus the page-error watcher close every test - the render
// HEALTH half of the proof, without which "the user can see one kind of item go one
// way" is a claim about a data structure and not about the application.
//
// SHARED-HOST NOTE. The live suite runs `workers: 1` against ONE mutable dev host, so
// this file is serial and every test resets that host to the demo baseline and THEN
// wipes it to empty. Inheriting whatever the previous file left behind would make
// "from an empty board" a description of the spec's intention rather than of its
// subject.

test.describe.configure({ mode: 'serial' });

const KIND = { SOURCE: 0, ROUTER: 5 } as const;
const ROLE = { IN: 0, OUT: 1, FAULT: 2 } as const;

/**
 * The settled palette-Router port profile as a ROLE MULTISET rather than a bare
 * count, so a failure names which role went missing. One In, the catalog's Out
 * arity - which plan 65-05 widened (ROUTE-02), a palette Router used to be seeded
 * with two outputs while the catalog declared three, so the only Router a user could
 * place had nowhere to send a second branch - and, since plan 71-04 (PILE-10)
 * appended a spatial Role::Fault nub to the ROUTER catalog entry, one Fault.
 *
 * This spec is written for the widened arity and would be meaningless at the old one:
 * it needs three offload belts. The Fault nub takes no part in it; it is here because
 * `gestures.ts`'s `seedRouterPreset` derives its AddPort legs from the WHOLE catalog
 * entry, so the browser seeds it and a spec that pinned four ports would read RED for
 * a port it never touches. Measured on the real host 2026-09-02; see
 * `16-router-presets.spec.ts` for the Rust/browser preset disagreement this exposed.
 */
const EXPECTED_ROLES = [ROLE.IN, ROLE.OUT, ROLE.OUT, ROLE.OUT, ROLE.FAULT] as const;

/** The Out arity inside {@link EXPECTED_ROLES}, DERIVED. It used to be spelled
 *  `EXPECTED_ROLES.length - 1`, which was the same number only while In was the sole
 *  non-Out role in the profile; appending the Fault broke that identity silently. */
const EXPECTED_OUTS = EXPECTED_ROLES.filter((r) => r === ROLE.OUT).length;

// The scene, on an empty board. A 2x3 Router at (8,4) puts its In nub on the W edge
// at (8,5) (facing cell (7,5)) and its three Out nubs down the E column at (9,5),
// (9,6), (9,4) by routing key (facing cells (10,5), (10,6), (10,4)): since plan 74.1-14
// (the maintainer's ruling 2026-10-04, "Edits keep middle layout") a Router seats its In and first
// Out on its middle row. The Source is 1x1 with a single Out at its own cell facing E,
// so (5,5) faces (6,5) and the feed run is two cells. (Until 74.1-14 the In sat at (8,4)
// and the Source at (5,4).)
const ROUTER_CELL = [8, 4] as const;
const SOURCE_CELL = [5, 5] as const;
const FEED_CELLS = [
  [6, 5],
  [7, 5],
] as const;
/** An empty cell INSIDE the built content, used to deselect.
 *
 *  Inside deliberately. The camera is fit-to-content and re-fits as the board grows -
 *  measured going from scale 1.11 on the empty board to 3.61 once this scene is
 *  built - so a far-away "obviously empty" cell drifts off the viewport by the time
 *  the panel is open, and the deselect click then lands on nothing. (5..7, 5..6) is
 *  the block between the Source and the Router, empty on this board and always in
 *  frame because the fit is computed to include both. */
const EMPTY_CELL = [6, 6] as const;

/** The two rules this spec types in, and the body that matches each. The third body
 *  matches NEITHER, so it exercises the default. Offsets are 0: the pattern is a
 *  prefix match on the injected bytes, and the webhook door carries the request body
 *  verbatim as the item's bytes. */
const RULE_ONE = { expect: 'A', offset: 0, body: 'A-one' } as const;
const RULE_TWO = { expect: 'B', offset: 0, body: 'B-two' } as const;
const UNMATCHED_BODY = 'Z-none';

/** What the Router panel calls an output (phase 91, D-12, CHROME-13, UI-SPEC 8.6): `Output N`,
 *  N its routing key + 1 (its position among the Router's Outs in packet order, which is
 *  `outs`' order), plus ` (Target)` only when its belt reaches a machine. Every offload belt
 *  here ends on open floor, so no name carries a target. Until phase 91 the panel named each
 *  output by its nub's grid cell. */
function outputLabel(outs: readonly PortFacts[], port: PortFacts): string {
  const n = outs.indexOf(port) + 1;
  expect(n, 'the port is one of the Router Outs').toBeGreaterThan(0);
  return `Output ${n}`;
}

/** The belt whose TAIL is docked to `key` on `routerId`, read off board state.
 *
 *  `DockFacts.port` is the ROUTING KEY (the port's 0-based position among its role's
 *  ports), which is the same keyspace a rule's target uses - verified live: the three
 *  offload belts read back Tail docks 0, 1 and 2. Resolving the belt this way means
 *  nothing in the routing assertion below depends on the order the belts were drawn
 *  in or on the handles the host happened to mint. */
function offloadBeltFor(scene: SceneFacts, routerId: number, key: number) {
  return scene.belts.find((b) =>
    b.docks.some((d) => d.end === 'Tail' && d.node === routerId && d.port === key),
  );
}

/**
 * Ensure the shared host sim is PLAYING. A prior spec (15-disconnected) pauses it, and
 * pause is HOST-global - a page reload does not resume it. Two things in this file need
 * a running sim: a Place only folds inside `tick_once`, so on a paused host it is queued
 * forever and never echoes; and the webhook front door answers 503 while the sim is not
 * Playing (Gate A). Toggling is idempotent when the sim is already advancing.
 */
async function ensurePlaying(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: /^(Play|Pause)$/ });
  for (let i = 0; i < 3; i += 1) {
    const t0 = (await readScene(page)).tick;
    await page.waitForTimeout(400);
    if ((await readScene(page)).tick > t0) return;
    await btn.click();
  }
  throw new Error('could not resume the sim (tick never advanced)');
}

/** What `buildRouterScene` hands back: the identities every later step addresses. */
interface RouterScene {
  routerId: number;
  sourceId: number;
  /** The Router's Out ports in PACKET order. The array INDEX is the routing key. */
  outs: PortFacts[];
  /** The feed belt's handle (Source Out -> Router In). */
  feedBelt: number;
}

/**
 * Build the whole scene from an EMPTY board with real pointer gestures only.
 *
 * Nothing here is inherited: the caller has already wiped the board, so every machine,
 * every belt and every dock below is produced by this function's own clicks and drags.
 */
async function buildRouterScene(page: Page): Promise<RouterScene> {
  await armAndPlaceAt(page, 'Router', ROUTER_CELL[0], ROUTER_CELL[1]);
  // Poll the WHOLE settle predicate rather than reading a length and then reading
  // again: the preset seeding is a fold sequence (Place echoes, then the RemovePort
  // and AddPort legs land over ticks), so a two-step read can catch a transient
  // intermediate port list and assert against it.
  await pollScene(
    page,
    (s) => {
      const r = s.nodes.find((n) => n.kind === KIND.ROUTER);
      if (!r || r.ports.length !== EXPECTED_ROLES.length) return false;
      const roles = r.ports.map((p) => p.role).sort();
      return roles.every((role, i) => role === EXPECTED_ROLES[i]);
    },
    {
      message: `the placed Router settles into the ${EXPECTED_ROLES.length}-port preset profile (1 In, ${EXPECTED_OUTS} Out, 1 Fault)`,
    },
  ).toBe(true);
  await waitForCameraSettle(page);

  await armAndPlaceAt(page, 'Source', SOURCE_CELL[0], SOURCE_CELL[1]);
  await pollScene(page, (s) => s.nodes.some((n) => n.kind === KIND.SOURCE), {
    message: 'the Source echoed onto the board',
  }).toBe(true);
  await waitForCameraSettle(page);

  const built = await readScene(page);
  const router = built.nodes.find((n) => n.kind === KIND.ROUTER) as SceneFacts['nodes'][number];
  const source = built.nodes.find((n) => n.kind === KIND.SOURCE) as SceneFacts['nodes'][number];
  expect(built.nodes, 'the board holds exactly the two machines this spec placed').toHaveLength(2);

  // THE NUBS ARE READ OFF THE SETTLED NODE, NEVER ASSUMED BY ORDINAL. A Router seats
  // its routing keys centre-out (since 74.1-14: key 0 on the middle row, then below,
  // then above), so no screen ordinal matches a key. Everything below (the
  // belt geometry, the panel segment labels, the routing keys) is derived from these
  // port records.
  const outs = router.ports.filter((p) => p.role === ROLE.OUT);
  expect(outs, 'the settled Router exposes the catalog Out arity').toHaveLength(EXPECTED_OUTS);
  const inPort = router.ports.find((p) => p.role === ROLE.IN) as PortFacts;

  await drawBeltThroughCells(page, source.ports[0], FEED_CELLS, inPort);
  await pollScene(page, (s) => s.belts.length, {
    message: 'the feed belt committed (Source Out to Router In)',
  }).toBe(1);

  // One offload belt per output, each running E from that nub's own facing cell along
  // that nub's own row. The row comes from the port record, so this loop follows the
  // seating rather than a transcription of it.
  for (let i = 0; i < outs.length; i += 1) {
    const y = outs[i].cell_y;
    await drawOffloadBelt(page, outs[i], [
      [10, y],
      [11, y],
      [12, y],
    ]);
    await pollScene(page, (s) => s.belts.length, {
      message: `offload belt ${i} committed off ${outputLabel(outs, outs[i])}`,
    }).toBe(2 + i);
  }

  // THE TAIL DOCKS ARE WAITED FOR, NOT READ ONCE (plan 84-10, the 2026-10-09 CI run). The
  // poll above waits for each offload belt's DrawBelt echo, but its Tail Dock is a
  // follow-up the gesture layer sends only once that echo has landed (`watchBeltFollowUp`
  // in `gestures.ts`), and it folds a tick or more later. Reading the scene once, straight
  // after the last belt's echo, could see the last belt with no dock yet: CI's red, and
  // plan 84-02's local run-2 red in ROUTE-03 through this same builder. So the clause
  // waits for the event it is about, every Out key's Tail dock, under its own message.
  await pollScene(page, (s) => outs.every((_, key) => offloadBeltFor(s, router.id, key) !== undefined), {
    message: 'no output was left without a belt',
  }).toBe(true);

  const scene = await readScene(page);
  const feedBelt = scene.belts.find((b) =>
    b.docks.some((d) => d.end === 'Head' && d.node === router.id),
  );
  expect(feedBelt, 'a belt delivers into the Router In port').toBeDefined();
  // Every output has its own offload belt, and they are DISTINCT belts. Asserted here
  // rather than at the routing assertion so a drawing mistake fails where it was made.
  const offloads = outs.map((_, key) => offloadBeltFor(scene, router.id, key));
  expect(
    offloads.map((b) => b?.id),
    'every Out routing key has its own offload belt, all distinct',
  ).toEqual([...new Set(offloads.map((b) => b?.id))]);
  expect(offloads.every((b) => b !== undefined), 'no output was left without a belt').toBe(true);

  return {
    routerId: router.id,
    sourceId: source.id,
    outs,
    feedBelt: (feedBelt as SceneFacts['belts'][number]).id,
  };
}

/** Type the two-rule table plus the default into the mounted panel and Apply. */
async function configureRouter(page: Page, scene: RouterScene): Promise<void> {
  await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
  await appendRouterRule(page, {
    expect: RULE_ONE.expect,
    offset: RULE_ONE.offset,
    target: outputLabel(scene.outs, scene.outs[1]),
  });
  await appendRouterRule(page, {
    expect: RULE_TWO.expect,
    offset: RULE_TWO.offset,
    target: outputLabel(scene.outs, scene.outs[2]),
  });
  await pressSegment(page, 'Default', outputLabel(scene.outs, scene.outs[0]));
  await applyConfig(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
}

/** The mandatory preamble: watcher installed BEFORE goto, host reset, board emptied. */
async function bootOnEmptyBoard(page: Page): Promise<ReturnType<typeof watchPageErrors>> {
  const errs = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await ensurePlaying(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await waitForCameraSettle(page);
  return errs;
}

test.describe('ROUTE-03 live: a table typed into the panel survives Apply', () => {
  test('two rules typed into a palette-placed Router read back in entry order with the right target each', async ({
    page,
  }) => {
    const errs = await bootOnEmptyBoard(page);
    const scene = await buildRouterScene(page);

    // The table a fresh palette Router arrives with: no rules, and the default the
    // `add_router` fold mints (the first output). Recorded so the read-back below is a
    // measurement of what this test typed and not of what was already there.
    await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
    expect(
      await readRouterTable(page),
      'a freshly placed Router arrives with an EMPTY table and its minted default',
    ).toEqual({ rules: [], fallback: outputLabel(scene.outs, scene.outs[0]) });
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    await configureRouter(page, scene);

    // Re-OPEN the panel. The panel pre-fills from `machine_config`, so a table read
    // from a panel that never unmounted could be the local buffer rather than the
    // host's committed config; unmounting and re-selecting forces the round trip.
    await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
    expect(
      await readRouterTable(page),
      'both rules survived Apply in ENTRY order, each with the target it was given, and the default is the first output',
    ).toEqual({
      rules: [
        { target: outputLabel(scene.outs, scene.outs[1]), expect: RULE_ONE.expect, offset: String(RULE_ONE.offset) },
        { target: outputLabel(scene.outs, scene.outs[2]), expect: RULE_TWO.expect, offset: String(RULE_TWO.offset) },
      ],
      fallback: outputLabel(scene.outs, scene.outs[0]),
    });

    await expectRenderLoopAlive(page, 'after the Router table round trip');
    errs.assertNone('the Router table round trip');
  });
});

test.describe('ROUTE-01 live: items split across the outputs the table names', () => {
  test('from an empty board, a palette-placed Router sends one kind of item one way and everything else another', async ({
    page,
  }) => {
    const errs = await bootOnEmptyBoard(page);
    const scene = await buildRouterScene(page);
    await configureRouter(page, scene);

    const url = await webhookUrl(page, scene.sourceId);
    expect(url, 'the placed Source resolves to its own loopback /hook/src-<id> POST URL').toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/hook\/src-\d+$/,
    );

    /**
     * POST one body at the Source's front door and settle on the EXACT occupancy of
     * all three offload belts.
     *
     * The whole vector is asserted per item, not just the belt the item was expected
     * on. Asserting only the expected belt would pass against a Router that copied the
     * item to every output, which is a different machine from the one this test is
     * about. And attributing item by item - rather than posting all three and counting
     * at the end - is what makes each rule's destination provable: a Router that sent
     * everything to the default would end a three-post run with 3/0/0 and could not be
     * mistaken for a correct one, but a Router that had rules one and two swapped would
     * end it 1/1/1 exactly like a correct one.
     */
    const postAndExpect = async (body: string, expected: [number, number, number]) => {
      const resp = await page.request.post(url as string, { data: body });
      expect(resp.status(), `the webhook front door accepted the ${body} POST`).toBe(200);
      await pollScene(
        page,
        (s) =>
          scene.outs
            .map((_, key) => offloadBeltFor(s, scene.routerId, key)?.items ?? -1)
            .join(','),
        {
          message:
            `after posting ${body}, the offload belts for routing keys 0/1/2 hold ` +
            `${expected.join('/')} items at rest`,
        },
      ).toBe(expected.join(','));
    };

    // Rule ONE's body. It lands on rule one's output and NOWHERE else - not on the
    // default's, which is the assertion that makes "one kind of item goes one way"
    // mean what it says.
    await postAndExpect(RULE_ONE.body, [0, 1, 0]);
    // A body matching NO rule. It lands on the DEFAULT's output, and rule one's item
    // is still sitting where it came to rest.
    await postAndExpect(UNMATCHED_BODY, [1, 1, 0]);
    // Rule TWO's body, which proves the second rule is live rather than merely stored.
    await postAndExpect(RULE_TWO.body, [1, 1, 1]);

    const settled = await readScene(page);
    const restingBelts = scene.outs.map(
      (_, key) => offloadBeltFor(settled, scene.routerId, key) as SceneFacts['belts'][number],
    );
    // THE THREE BELTS ARE DIFFERENT BELTS. Stated explicitly rather than left implied
    // by the per-key lookup: if two routing keys ever resolved to the SAME belt handle,
    // every occupancy vector above would still read 1/1/1 while the items had in fact
    // all gone to one place.
    expect(
      new Set(restingBelts.map((b) => b.id)).size,
      'the three resting items are on three DIFFERENT belts',
    ).toBe(3);
    expect(
      restingBelts.find((b) => b.id === restingBelts[1].id)?.id === restingBelts[0].id,
      'rule one and the default do not share an offload belt',
    ).toBe(false);
    // The feed belt drained: the board is SETTLED and nothing is caught mid-transport,
    // so the occupancy read above is a resting state and not a snapshot of traffic.
    expect(
      settled.belts.find((b) => b.id === scene.feedBelt)?.items,
      'the feed belt is empty at the settle (every item reached the Router)',
    ).toBe(0);

    await expectRenderLoopAlive(page, 'after the three routed items came to rest');
    errs.assertNone('the empty-board Router routing run');
  });
});
