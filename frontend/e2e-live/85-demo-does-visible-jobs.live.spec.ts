import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { addWaitBudget, tickBudgetMs } from '../e2e/support/frameSampler';
import {
  anchorOf,
  deselectViaEmptyCell,
  expectRenderLoopAlive,
  labelWordsOf,
  readBeltFlowWatch,
  readFactorySource,
  readScene,
  resetToDemo,
  selectMachineAt,
  startBeltFlowWatch,
  stopBeltFlowWatch,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 85-demo-does-visible-jobs.live.spec.ts (plan 85-08, DEMO-06, SC4, D-14 to D-18).
//
// Every machine on the shipped demo does a job a viewer can see, on the REAL dev host:
//   - the order Factory runs the D-14 code from `demo_scene.board.ron` (it numbers each order, sizes
//     it small, medium or large with `ctx.randomInt`, and throws about one in twenty down its
//     fault belt into the Rejects sink);
//   - the Router docks all three of its outputs and sorts by size (D-15), so items ride all
//     three lane belts;
//   - a Merge joins two lanes, a Balancer takes ONE lane on its first input and alternates
//     between two dock sinks, and no belt runs from a Balancer Out into a Merge In (D-16);
//   - the Tee still copies every order to the Audit sink, and every sink drains (D-16);
//   - every section label reads on screen in at most three words (D-17).
//
// The flow is graded by the in-page belt-flow watch: a belt CARRIED an item, and its HEAD slot
// held an item and later did not, so the machine at its head took one, because a refused
// delivery backs up at the head and never clears. Each sink's feed belt must do that, so each
// sink drained. (A whole-belt "went empty" read cannot grade this board: the Audit and Post
// feeds carry an order every few ticks and are never empty while the line runs.)
//
// THE WINDOW is derived from the timer, never guessed: the Source injects one order every
// `INJECT_EVERY_TICKS` ticks, a reject is about one order in `REJECT_ONE_IN`, so
// `ORDERS_IN_WINDOW` orders miss every reject with odds under one in ten thousand; the longest
// belt path adds `TRAVERSE_TICKS`. `tickBudgetMs` turns those ticks into wall time at the floor
// tick rate, and the poll returns the moment every belt has done its job.
//
// RENDER HEALTH by name: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after the
// flow watch, `assertNone` at the end (fabrico-model-oracle-blindspot).

const KIND_FACTORY = 2;
const KIND_TEE = 3;
const KIND_BALANCER = 4;
const KIND_ROUTER = 5;
const KIND_MERGE = 6;
const KIND_SINK = 7;
const KIND_LABEL = 11;
/** The demo Source's timer interval (`Timer(interval_ticks: 8)` in demo_scene.board.ron). */
const INJECT_EVERY_TICKS = 8;
/** The demo Factory rejects when `ctx.randomInt(0, REJECT_ONE_IN) === 0`. */
const REJECT_ONE_IN = 20;
/** Ten times the reject odds: (1 - 1/20)^200 is under 1e-4, so the window sees a reject
 *  unless the board is broken. */
const ORDERS_IN_WINDOW = REJECT_ONE_IN * 10;
/** The longest belt path, Source to a dock sink, at 4 slots a tile and 2 ticks a slot. */
const TRAVERSE_TICKS = 240;
/** An empty cell clicked to close the Factory's panel: FREE on a fresh demo (85-EVIDENCE.md). */
const EMPTY_CELL: readonly [number, number] = [1, 12];
/** At most three plain words a label (D-17). */
const PLAIN_WORDS = /^[A-Za-z]+( [A-Za-z]+){0,2}$/;

/** The order Factory's code as `demo_scene.board.ron` authors it: the Factory Configure that emits. */
function demoFactorySource(): string {
  const ron = readFileSync(
    fileURLToPath(new URL('../../examples/boards/demo_scene.board.ron', import.meta.url)),
    'utf8',
  );
  const sources = [...ron.matchAll(/Factory\(source: r#"([\s\S]*?)"#\)/g)].map((m) => m[1]);
  const maker = sources.find((src) => src.includes('ctx.emit('));
  if (maker === undefined) {
    throw new Error('demoFactorySource: demo_scene.board.ron configures no Factory that emits orders');
  }
  return maker;
}

type Node = SceneFacts['nodes'][number];
type Belt = SceneFacts['belts'][number];

const headOf = (b: Belt): number | undefined => b.docks.find((d) => d.end === 'Head')?.node;
const tailOf = (b: Belt): number | undefined => b.docks.find((d) => d.end === 'Tail')?.node;

test.describe('DEMO-06 live: every machine on the demo does a job a viewer can see', () => {
  test('orders are made, sorted three ways, merged, balanced, audited and rejected, every sink drains, every section is labelled', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await waitForCameraSettle(page);
    await expectRenderLoopAlive(page, 'on the fresh demo');

    // ── The order Factory runs the D-14 code (read back through its own panel).
    const expected = demoFactorySource();
    expect(expected, 'the D-14 code draws its randomness from ctx.randomInt').toContain('ctx.randomInt(');
    const scene0 = await readScene(page);
    const factories = scene0.nodes.filter((n) => n.kind === KIND_FACTORY);
    expect(factories.length, 'the demo has ONE order Factory (the HTTP Handler is kind 10)').toBe(1);
    const [fx, fy] = anchorOf(factories[0]);
    await selectMachineAt(page, fx, fy);
    expect(await readFactorySource(page), "the order Factory's panel shows the D-14 code verbatim").toBe(expected);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // ── The topology the jobs need, read off the model by docks and kinds.
    const scene = await readScene(page);
    const node = (id: number | undefined): Node | undefined => scene.nodes.find((n) => n.id === id);
    const kindOf = (id: number | undefined): number | undefined => node(id)?.kind;
    const router = scene.nodes.filter((n) => n.kind === KIND_ROUTER);
    expect(router.length, 'the demo has one Router').toBe(1);
    const lanes = scene.belts.filter((b) => tailOf(b) === router[0].id);
    expect(lanes.length, 'the Router docks all three of its outputs: no output stub is left (D-15)').toBe(3);
    const sinks = scene.nodes.filter((n) => n.kind === KIND_SINK);
    expect(sinks.length, 'Post, Audit, Rejects and two dock sinks').toBe(5);
    const feeds = sinks.map((s) => {
      const into = scene.belts.filter((b) => headOf(b) === s.id);
      expect(into.length, `sink ${s.id} is fed by exactly one belt`).toBe(1);
      return into[0];
    });
    const balancers = scene.nodes.filter((n) => n.kind === KIND_BALANCER);
    expect(balancers.length, 'one Balancer').toBe(1);
    const balancerIn = scene.belts.filter((b) => headOf(b) === balancers[0].id);
    expect(
      balancerIn.map((b) => b.docks.find((d) => d.end === 'Head')?.port),
      'the Balancer takes ONE lane, on its first input only (D-16; SWEEP row 175)',
    ).toEqual([0]);
    expect(
      scene.belts.filter((b) => kindOf(tailOf(b)) === KIND_BALANCER).map((b) => kindOf(headOf(b))),
      'the Balancer alternates between two dock sinks',
    ).toEqual([KIND_SINK, KIND_SINK]);
    expect(
      scene.belts.filter((b) => kindOf(tailOf(b)) === KIND_BALANCER && kindOf(headOf(b)) === KIND_MERGE).length,
      'no belt runs from a Balancer Out into a Merge In (D-16)',
    ).toBe(0);
    const merges = scene.nodes.filter((n) => n.kind === KIND_MERGE);
    expect(merges.length, 'one Merge').toBe(1);
    expect(
      scene.belts.filter((b) => headOf(b) === merges[0].id).map((b) => tailOf(b)),
      'the Merge joins two Router lanes',
    ).toEqual([router[0].id, router[0].id]);
    expect(
      scene.belts.filter((b) => kindOf(tailOf(b)) === KIND_TEE).length,
      'the Tee copies down both its outputs (the Router and the Audit sink)',
    ).toBe(2);

    // ── The jobs, as the belts show them: every lane carries, every sink's feed carries and drains.
    await startBeltFlowWatch(page);
    const laneIds = lanes.map((b) => b.id).sort((a, b) => a - b);
    const feedIds = feeds.map((b) => b.id).sort((a, b) => a - b);
    const windowTicks = ORDERS_IN_WINDOW * INJECT_EVERY_TICKS + TRAVERSE_TICKS;
    await expect
      .poll(
        async () => {
          const w = await readBeltFlowWatch(page);
          return {
            lanesCarried: laneIds.filter((id) => w.carried.includes(id)),
            feedsDrained: feedIds.filter((id) => w.carried.includes(id) && w.headCleared.includes(id)),
          };
        },
        {
          message: `within ${windowTicks} ticks every Router lane carried an order and every sink's feed belt delivered one into its sink`,
          timeout: addWaitBudget(tickBudgetMs(windowTicks), 'every Router lane and every sink feed'),
        },
      )
      .toEqual({ lanesCarried: laneIds, feedsDrained: feedIds });
    await stopBeltFlowWatch(page);
    await expectRenderLoopAlive(page, 'after the flow watch');

    // ── Every section is named in plain words on screen (D-17).
    const labels = (await readScene(page)).nodes.filter((n) => n.kind === KIND_LABEL);
    expect(labels.length, 'about seven section labels (D-17), at least five').toBeGreaterThanOrEqual(5);
    for (const l of labels) {
      const words = await labelWordsOf(page, l.id);
      expect(words, `label ${l.id} draws its words`).not.toBeNull();
      expect(words!.visible, `label ${l.id}'s words are visible`).toBe(true);
      expect(words!.text, `label ${l.id} shows the words the host holds`).toBe(l.label?.text);
      expect(words!.text, `label ${l.id} is at most three plain words: "${words!.text}"`).toMatch(PLAIN_WORDS);
      expect(l.label?.colour, `label ${l.id} is Sand (colour 0)`).toBe(0);
    }

    await expectRenderLoopAlive(page, 'at the end');
    errs.assertNone('the demo does visible jobs');
  });
});
