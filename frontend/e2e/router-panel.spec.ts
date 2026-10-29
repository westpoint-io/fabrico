import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { CONFIG_NOT_APPLIED_MARKER } from '../src/chrome/configCopy';
import {
  buildPacket,
  CMD,
  GESTURE_ACCEPTED,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type InjectNode,
  type MockSocketOpts,
  waitForBoard,
} from './support/wire';

// router-panel.spec.ts (ROUTE-01/ROUTE-03, Phase 65-02) - the tracer's end-to-end
// check, driving ONE routing rule through the whole production path:
//
//   `machine_config` reply (the REAL ConfigView::Router JSON shape)
//     -> ConfigPanel.loadConfig -> the `config.kind === 'Router'` arm
//     -> RouterConfigBody, whose output identity comes from the injected packet's
//        LIVE ports rather than from anything in the reply
//
// It is the leg that can see UI-SPEC FINDING 1: the host DTO used to serialize a
// FLAT `{offset, expect, port}` array while the TS type and the shipped postcard
// encoder both use PAIRS, so a Router read-back fed `undefined` into `varintU`.

/**
 * THE CONFIG REPLY, COPIED FROM THE RUST TEST LITERAL.
 *
 * `crates/fabrico-host/src/config_view.rs`, in
 * `config_view_renders_belt_and_router_configs`, pins exactly this shape:
 *
 *   {"kind":"Router",
 *    "routes":[[{"offset":0,"expect":[97,98]},1],
 *              [{"offset":2,"expect":[99,100]},2]],
 *    "default":7}
 *
 * The shape is copied rather than hand-typed from the TypeScript type, and that
 * is load-bearing rather than tidy: `answerQuery` accepts ANY value, so a reply
 * written from the TS type would sample the TS type against itself and be green
 * against the very shape defect this plan exists to fix.
 *
 * WHAT THIS FIXTURE PROVES ON ITS OWN, exactly: that the FRONTEND, fed the pair
 * shape, renders it correctly. It cannot prove anything about the host, because
 * it is a hand-copied literal with no link to Rust - so a host DTO regression
 * cannot reach it, and the pressed-segment assertion below would stay green
 * through one. An earlier revision of this docblock claimed the opposite, which
 * is the promise-a-guarantee-the-code-does-not-provide mistake this codebase has
 * been bitten by repeatedly. The link is now REAL, and it is the last test in
 * this file: `routesShape` reads the Rust literal out of `config_view.rs` and
 * compares its structure to this fixture's, so a regression that re-blessed the
 * Rust assertion to the flat shape reddens here rather than shipping.
 *
 * Two VALUES differ from the Rust literal, and only values, which is why the
 * weld compares STRUCTURE and not bytes:
 *  - one rule, targeting routing key 0, so the assertion below can tell a
 *    packet-order editor from one that numbers outputs top to bottom;
 *  - `default: null`, because port 7 does not exist on a 3-Out node and
 *    the missing-target state belongs to plan 65-03, not to this leg.
 */
const ROUTER_CONFIG = {
  kind: 'Router',
  routes: [[{ offset: 0, expect: [97, 98] }, 0]],
  default: null,
};

/**
 * A REALISTIC Router (kind 5), 2x3 at (14,0), in DEMO SEATING: one In, then the
 * three Outs in `port_catalog(ROUTER)` packet order, which seats the exemplar
 * Out at local row 2 FIRST and then fills rows 0 and 1.
 *
 * So the FIRST Out in packet order - routing key 0 - is the BOTTOM nub at
 * (15,2), and the TOPMOST nub (15,0) is routing key 1. A fixture whose ports
 * were listed in visual order would be green under a correct editor AND under
 * one that numbers outputs top to bottom, and would prove nothing.
 *
 * This is deliberately NOT `panel-io.spec.ts`'s 40-port overflow stress node:
 * that fixture exists to force the panel to scroll, and its ports carry no
 * meaningful seating at all.
 *
 * THE FIFTH PORT IS PHASE 71's, AND IT IS NOT COSMETIC. PILE-10 appends a real
 * spatial `Role::Fault` nub at `S@(0,2)` (world (14,2)) after the E-column Outs.
 * Without it this fixture is a Router no user can place, and worse, the
 * fallthrough case below asserts copy that tells the reader to "draw a belt from
 * the fault port" against a fixture that has no such port. That is the same
 * names-a-control-we-do-not-have mistake `RouterConfigBody` records having been
 * reverted once, reproduced on the test side where nothing would flag it. The
 * Fault sorts LAST and takes the LAST index, so every routing key above is
 * byte-unchanged, which is why adding it moves no other assertion here.
 */
const ROUTER: InjectNode = {
  id: 21,
  kind: 5,
  cell_x: 14,
  cell_y: 0,
  w: 2,
  h: 3,
  ports: [
    { index: 0, cell_x: 14, cell_y: 1, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 15, cell_y: 2, side: 1, role: 1, medium: 0 },
    { index: 2, cell_x: 15, cell_y: 0, side: 1, role: 1, medium: 0 },
    { index: 3, cell_x: 15, cell_y: 1, side: 1, role: 1, medium: 0 },
    { index: 4, cell_x: 14, cell_y: 2, side: 2, role: 2, medium: 0 },
  ],
};

/** A Router body cell that is not a nub cell - the safe click-to-select point. */
const ROUTER_BODY: [number, number] = [14, 0];

/** Phase 91 (D-12, CHROME-13, UI-SPEC 8.6): each Out is named by NUMBER, `Output N`, N its
 *  routing key + 1, never by its nub's cell. No belt is docked on this fixture, so no name
 *  carries a target. Routing key 0, `Output 1`, is the BOTTOM nub. */
const FIRST_OUT_LABEL = 'Output 1';
/** Routing key 1, the TOPMOST nub. */
const TOP_OUT_LABEL = 'Output 2';
/** Routing key 2, the MIDDLE nub. */
const MIDDLE_OUT_LABEL = 'Output 3';

/**
 * A THREE-rule table in the read-back shape, values extended from the Rust
 * literal. Three rather than two on purpose: with only two rules every move
 * lands a rule at an end of the list, where its arrival control is disabled, so
 * a two-rule fixture could only ever exercise the fallback and never the
 * ordinary interior case.
 */
const THREE_RULE_CONFIG = {
  kind: 'Router',
  routes: [
    [{ offset: 0, expect: [97, 98] }, 0],
    [{ offset: 2, expect: [99, 100] }, 1],
    [{ offset: 4, expect: [101, 102] }, 2],
  ],
  default: null,
};

/**
 * Boot the mocked app, inject `node`, click-select it and wait for the panel.
 * Copied verbatim from `panel-io.spec.ts` - the same boot-inject-select-wait
 * sequence, including the pre-navigation mock registration.
 */
async function selectMachine(
  page: Page,
  node: InjectNode,
  body: [number, number],
  config: unknown | (() => unknown),
  answerGesture?: MockSocketOpts['answerGesture'],
): Promise<Harness> {
  // Suppress the first-run WelcomeCard (itself an aside.fab-panel): the reuse
  // config lacks the main config's storageState onboarding seed.
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));

  // Mock BEFORE goto (routeWebSocket must register pre-navigation). Without a
  // machine_config reply the panel hangs in "Loading config...", and the Router
  // arm is gated on `!loading && config` - so an unanswered query would mask the
  // arm's absence rather than prove its presence.
  // A THUNK is accepted as well as a value, so a spec can change what the host
  // answers with between two opens of the same panel. That is what makes a round
  // trip a round trip rather than a repeat of one canned reply.
  const reply = (): unknown => (typeof config === 'function' ? (config as () => unknown)() : config);
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? reply() : undefined),
    // Optional, and the ONE seam that lets a spec model a host VERDICT: a
    // returned tag refuses the gesture exactly as `service_gesture` does, and
    // GESTURE_ACCEPTED sends nothing at all, which is what an accept looks like
    // on the wire. Without it every gesture is silently accepted, which is the
    // right default for the read-back legs above and useless for the two Apply
    // legs below.
    answerGesture,
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ nodes: [node] }));
  await waitForBoard(page, { machines: 1 });

  await clickCell(page, body);
  return h;
}

/** One click on a grid cell centre. */
async function clickCell(page: Page, cell: [number, number]): Promise<void> {
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
}

/**
 * Close the panel and open it again, which is a genuinely fresh `ConfigPanel`
 * instance re-pulling `machine_config` (App mounts it as
 * `<ConfigPanel key={selectedNode} .../>`).
 *
 * Blur first: the app-wide accelerator guard stands Escape down while a BUTTON
 * holds focus, so this models the ordinary "click elsewhere, then press Escape"
 * flow rather than a synthetic key event. Copied from `panel-add-remove.spec.ts`.
 */
async function reopenPanel(page: Page, body: [number, number]): Promise<void> {
  await page.getByRole('heading', { name: 'Rules' }).click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('heading', { name: 'Router' }),
    'the panel really did unmount (this test is worthless if it did not)',
  ).toBeHidden({ timeout: 10_000 });

  await clickCell(page, body);
  await expect(page.getByRole('heading', { name: 'Router' })).toBeVisible({ timeout: 10_000 });
}

/** LEB128 reader, the inverse of `PostcardWriter.varintU`. */
class PostcardReader {
  private i = 0;
  constructor(private readonly buf: Buffer) {}
  varintU(): number {
    let out = 0;
    let shift = 1;
    for (;;) {
      const b = this.buf[this.i++];
      out += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return out;
      shift *= 128;
    }
  }
  raw(n: number): number[] {
    const start = this.i;
    this.i += n;
    return Array.from(this.buf.subarray(start, this.i));
  }
}

/** The `ConfigView::Router` JSON shape, which is also `MachineConfig::Router`'s
 *  own shape: routes are PAIRS of a key and its target routing key. */
interface RouterConfigJson {
  kind: 'Router';
  routes: [{ offset: number; expect: number[] }, number][];
  default: number | null;
}

/**
 * Decode the `GridCommand::Configure` frame the panel actually emitted, back
 * into the read-back JSON the host would answer with.
 *
 * This is what closes the round trip HONESTLY. Re-serving a reply the spec typed
 * out would sample the spec against itself; decoding the bytes the app sent means
 * the second open is fed the panel's own output, and the layout is the one
 * `decode.ts` documents against `configure-gridcommand.bin`:
 *
 *   varintU(9) node | varintU(4) | varintU(len)
 *     | per route: varintU(offset), varintU(elen), elen raw bytes, varintU(port)
 *     | Option: varintU(0) | varintU(1) varintU(default)
 */
function decodeRouterConfigure(frame: Buffer): { node: number; config: RouterConfigJson } {
  const r = new PostcardReader(frame);
  expect(r.varintU(), 'GridCommand::Configure').toBe(CMD.Configure);
  const node = r.varintU();
  expect(r.varintU(), 'MachineConfig::Router is nested discriminant 4').toBe(4);
  const count = r.varintU();
  const routes: RouterConfigJson['routes'] = [];
  for (let k = 0; k < count; k++) {
    const offset = r.varintU();
    const len = r.varintU();
    const bytes = r.raw(len);
    routes.push([{ offset, expect: bytes }, r.varintU()]);
  }
  const some = r.varintU();
  return { node, config: { kind: 'Router', routes, default: some === 0 ? null : r.varintU() } };
}

/** The one Configure frame the page emitted. */
function soleConfigure(h: Harness): { node: number; config: RouterConfigJson } {
  const frames = h.sent.filter((f) => f[0] === CMD.Configure);
  expect(frames, 'exactly one Configure frame').toHaveLength(1);
  return decodeRouterConfigure(frames[0]);
}

/** The rules editor's single Playwright handle. */
function arm(page: Page) {
  return page.locator('#fab-router-config');
}

test.describe('Router rules editor (ROUTE-01/ROUTE-03)', () => {
  test('a selected Router opens a config arm carrying the read-back table', async ({ page }) => {
    await selectMachine(page, ROUTER, ROUTER_BODY, ROUTER_CONFIG);

    // Heading first: a failure here points at the selection/query bridge, not at
    // the rules editor (the factory-editor-height.spec.ts diagnosis discipline).
    await expect(page.getByRole('heading', { name: 'Router' })).toBeVisible({ timeout: 10_000 });
    await expect(arm(page)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Rules' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Default' })).toBeVisible();

    // The rule read back off the host reply, in the pair shape. `expect` is
    // [97,98] = "ab", and the offset is 0.
    await expect(arm(page).locator('#fab-route-expect-0')).toHaveValue('ab');
    await expect(arm(page).locator('#fab-route-offset-0')).toHaveValue('0');
  });

  test('the rule targets the FIRST Out in PACKET order, Output 1, whatever row its nub sits on', async ({ page }) => {
    await selectMachine(page, ROUTER, ROUTER_BODY, ROUTER_CONFIG);
    await expect(arm(page)).toBeVisible();

    const target = page.getByRole('group', { name: 'Send to, rule 1' });
    await expect(target).toBeVisible();

    // Three live Outs, so three segments - derived from the node's ports, never
    // from a restated arity.
    await expect(target.getByRole('button')).toHaveCount(3);

    // Since phase 91 the segments are numbered and ordered by routing key (UI-SPEC
    // 8.6), the order and the numbers the Outputs list shows.
    await expect(target.getByRole('button')).toHaveText([FIRST_OUT_LABEL, TOP_OUT_LABEL, MIDDLE_OUT_LABEL]);

    // The rule's port is 0, which is the BOTTOM nub in this seating and is named
    // Output 1. An editor that numbered outputs top to bottom would press the
    // second segment here, and this assertion is what catches it.
    const pressed = target.locator('button[aria-pressed="true"]');
    await expect(pressed).toHaveCount(1);
    await expect(pressed).toHaveText(FIRST_OUT_LABEL);
    // No grid-cell label anywhere in the Router panel.
    expect(await arm(page).innerText()).not.toMatch(/\(\d+,\d+\)/);
  });

  test('the Default group leads with None (fault) and states the fallthrough', async ({ page }) => {
    await selectMachine(page, ROUTER, ROUTER_BODY, ROUTER_CONFIG);
    await expect(arm(page)).toBeVisible();

    const def = page.getByRole('group', { name: 'Default' });
    // `None (fault)` plus one segment per live Out.
    await expect(def.getByRole('button')).toHaveCount(4);
    await expect(def.getByRole('button').first()).toHaveText('None (fault)');

    const pressed = def.locator('button[aria-pressed="true"]');
    await expect(pressed).toHaveCount(1);
    await expect(pressed).toHaveText('None (fault)');

    // REWRITTEN IN PHASE 71, NOT RELAXED. It pinned 'Items matching no rule are
    // faulted and go no further.', which was true while `port_catalog(ROUTER)`
    // declared no `Role::Fault` port: there was no nub, so the copy deliberately
    // refused to name an exit the user could not find. PILE-10 gives the Router a
    // real Fault nub at `S@(0,2)`, so "go no further" is now FALSE - the items leave
    // on a port a belt can dock to. The assertion states the new truth.
    //
    // Still a LITERAL, deliberately, and not an import of `FALLTHROUGH_FAULT`: this
    // spec's whole job is to be an independent restatement of what the panel says.
    // Importing the constant the DOM was rendered FROM would make the case pass under
    // any future rewording, which is a check that cannot fail on the axis it names.
    await expect(page.locator('#fab-route-fallthrough')).toHaveText(
      'Items matching no rule leave on the fault port. Draw a belt from it to catch them.',
    );
  });

  test('appending a rule and choosing a target makes the panel dirty and Apply live', async ({
    page,
  }) => {
    // An EMPTY table: the state a hand-placed Router actually starts in.
    await selectMachine(page, ROUTER, ROUTER_BODY, {
      kind: 'Router',
      routes: [],
      default: null,
    });
    await expect(arm(page)).toBeVisible();

    await expect(arm(page).getByText('No rules yet.')).toBeVisible();
    const apply = page.getByRole('button', { name: 'Apply' });
    await expect(apply).toBeDisabled();

    await page.locator('#fab-route-add').click();

    // One rule block appears, targeting the first segment shown, Output 1 (phase 91).
    const target = page.getByRole('group', { name: 'Send to, rule 1' });
    await expect(target).toBeVisible();
    await expect(target.locator('button[aria-pressed="true"]')).toHaveText(FIRST_OUT_LABEL);

    // Re-target it at Output 2, then type a pattern.
    await target.getByRole('button', { name: TOP_OUT_LABEL, exact: true }).click();
    await expect(target.locator('button[aria-pressed="true"]')).toHaveText(TOP_OUT_LABEL);

    await arm(page).locator('#fab-route-expect-0').fill('ab');
    await expect(arm(page).locator('#fab-route-expect-0')).toHaveValue('ab');

    // The buffer is dirty, so the panel's own Apply / Revert are live. Their
    // guard was never changed: a Router now answers machine_config with a
    // config, which is all it took.
    await expect(page.getByText(CONFIG_NOT_APPLIED_MARKER)).toBeVisible();
    await expect(apply).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Revert' })).toBeEnabled();
  });

  test('choosing a default rewrites the fallthrough line to name that output', async ({ page }) => {
    await selectMachine(page, ROUTER, ROUTER_BODY, ROUTER_CONFIG);
    await expect(arm(page)).toBeVisible();

    const def = page.getByRole('group', { name: 'Default' });
    await def.getByRole('button', { name: TOP_OUT_LABEL, exact: true }).click();

    // A literal on purpose (this spec restates what the panel says): no target, so
    // the output is named by its number alone (UI-SPEC 8.6).
    await expect(page.locator('#fab-route-fallthrough')).toHaveText('Items matching no rule go to Output 2.');
  });
});

// ─────────────────────────── The browser-only legs ───────────────────────────
// Everything below asserts something the node-env unit suite is STRUCTURALLY
// unable to see, rather than a weaker restatement of it.

test.describe('Router rules editor in a real browser (65-03)', () => {
  test('a two-rule table survives Apply and reads back in the order it was entered', async ({
    page,
  }) => {
    // The read-back reply is a MUTABLE thunk: the first open serves the empty
    // table a hand-placed Router really starts with, and the second open serves
    // whatever the panel itself emitted on Apply, decoded out of the wire bytes.
    let served: unknown = { kind: 'Router', routes: [], default: null };
    const h = await selectMachine(page, ROUTER, ROUTER_BODY, () => served);
    await expect(arm(page)).toBeVisible();
    await expect(arm(page).getByText('No rules yet.')).toBeVisible();

    await page.locator('#fab-route-add').click();
    await page.locator('#fab-route-add').click();
    await expect(page.getByRole('group', { name: 'Send to, rule 2' })).toBeVisible();

    // Rule 1 matches "ab" at byte 0 and goes to the BOTTOM nub (routing key 0).
    await arm(page).locator('#fab-route-expect-0').fill('ab');
    await arm(page).locator('#fab-route-offset-0').fill('0');
    await page
      .getByRole('group', { name: 'Send to, rule 1' })
      .getByRole('button', { name: FIRST_OUT_LABEL, exact: true })
      .click();

    // Rule 2 matches "cd" at byte 2 and goes to the MIDDLE nub (routing key 2).
    await arm(page).locator('#fab-route-expect-1').fill('cd');
    await arm(page).locator('#fab-route-offset-1').fill('2');
    await page
      .getByRole('group', { name: 'Send to, rule 2' })
      .getByRole('button', { name: MIDDLE_OUT_LABEL, exact: true })
      .click();

    const apply = page.getByRole('button', { name: 'Apply' });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect.poll(() => h.sent.filter((f) => f[0] === CMD.Configure).length).toBe(1);

    const sent = soleConfigure(h);
    expect(sent.node).toBe(ROUTER.id);
    // Order is the behaviour, so entry order IS what must survive the wire.
    expect(sent.config).toEqual({
      kind: 'Router',
      routes: [
        [{ offset: 0, expect: [97, 98] }, 0],
        [{ offset: 2, expect: [99, 100] }, 2],
      ],
      default: null,
    });

    // Serve the panel its OWN output back, then open a genuinely fresh panel.
    served = sent.config;
    await reopenPanel(page, ROUTER_BODY);

    await expect(arm(page).locator('#fab-route-expect-0')).toHaveValue('ab');
    await expect(arm(page).locator('#fab-route-offset-0')).toHaveValue('0');
    await expect(arm(page).locator('#fab-route-expect-1')).toHaveValue('cd');
    await expect(arm(page).locator('#fab-route-offset-1')).toHaveValue('2');
    await expect(arm(page).locator('#fab-route-expect-2')).toHaveCount(0);

    const one = page.getByRole('group', { name: 'Send to, rule 1' });
    await expect(one.locator('button[aria-pressed="true"]')).toHaveText(FIRST_OUT_LABEL);
    const two = page.getByRole('group', { name: 'Send to, rule 2' });
    await expect(two.locator('button[aria-pressed="true"]')).toHaveText(MIDDLE_OUT_LABEL);
  });

  test('focus follows a moved rule to its new position, and never falls out of the panel', async ({
    page,
  }) => {
    // A VITEST CANNOT MAKE THIS ASSERTION AT ALL. `vitest.config.ts` runs
    // `environment: 'node'`: there is no DOM, therefore no `document`, therefore
    // no `activeElement`. A unit test written for this would be vacuously green
    // rather than merely weak, which is worse than no test. The unit suite goes
    // exactly as far as it can - it asserts WHICH control should take focus, via
    // the `onMoved` seam - and this is the half that asserts focus lands there.
    await selectMachine(page, ROUTER, ROUTER_BODY, THREE_RULE_CONFIG);
    await expect(arm(page)).toBeVisible();
    await expect(page.getByRole('group', { name: 'Send to, rule 3' })).toBeVisible();

    const activeId = (): Promise<string> =>
      page.evaluate(() => document.activeElement?.id ?? '');

    // Rule 3 up: it arrives at position 2, where its up control is still live.
    //
    // MUTATION-PROVED. Dropping the `el.focus()` call from the layout effect,
    // and nothing else, reddens this line with the observed message
    // `Expected: "fab-route-move-up-1" / Received: "fab-route-move-up-2"` - the
    // press left focus on the button it landed on, which after the swap belongs
    // to a different rule.
    await page.locator('#fab-route-move-up-2').click();
    expect(await activeId()).toBe('fab-route-move-up-1');
    // The rule really did move: its pattern travelled with it.
    await expect(arm(page).locator('#fab-route-expect-1')).toHaveValue('ef');

    // Press again WITHOUT re-aiming, which is what holding the key does. Without
    // the focus restore the button under the finger now belongs to a different
    // rule and this second press would shuffle the pair back.
    await page.keyboard.press('Enter');
    await expect(arm(page).locator('#fab-route-expect-0')).toHaveValue('ef');

    // At the top the up control is DISABLED and cannot hold focus, so the
    // restore falls through to the same rule's other move control. Focus stays
    // on the rule that moved instead of dropping to the document body.
    //
    // MUTATION-PROVED. Dropping the `!el.disabled` test, so the restore focuses
    // the disabled arrival control anyway, reddens this with the observed
    // message `Expected: "fab-route-move-down-0" / Received:
    // "fab-route-move-up-1"`. That received value is the whole point: focusing a
    // disabled button is a silent no-op, so the user is left holding a control
    // that belongs to a rule they did not move.
    expect(await activeId()).toBe('fab-route-move-down-0');
  });

  test('a REFUSED Configure leaves the buffer dirty and uncommitted, and the panel claims NOTHING (65-REVIEW CR-02)', async ({
    page,
  }) => {
    // THE DEFECT THIS LEG EXISTS FOR. The panel used to read a true `sent` flag
    // as success, so a refused Configure produced `Applied`, a cleared not-applied
    // marker, and a `committed` table the engine had thrown away - all of it on
    // screen at the same moment as the refusal sentence saying the opposite.
    //
    // The refusal is modelled the way the host really behaves, which is what
    // makes it a proof rather than a restatement: `answerGesture` returns a
    // typed tag, and `machine_config` keeps answering with the ORIGINAL table
    // because a refused Configure writes no record and leaves the core
    // byte-identical (`command.rs`).
    let reads = 0;
    const h = await selectMachine(
      page,
      ROUTER,
      ROUTER_BODY,
      () => {
        reads += 1;
        return ROUTER_CONFIG;
      },
      (frame) => (frame[0] === CMD.Configure ? 'Malformed' : GESTURE_ACCEPTED),
    );
    await expect(arm(page)).toBeVisible();
    await expect(arm(page).locator('#fab-route-expect-0')).toHaveValue('ab');

    await arm(page).locator('#fab-route-expect-0').fill('zz');
    await expect(page.getByText(CONFIG_NOT_APPLIED_MARKER)).toBeVisible();
    const apply = page.getByRole('button', { name: 'Apply' });
    await apply.click();

    // The gesture really was dispatched.
    await expect.poll(() => h.sent.filter((f) => f[0] === CMD.Configure).length).toBe(1);

    // ASSERTED HERE, FIRST, AND BOTH THE POSITION AND THE FORM ARE LOAD-BEARING.
    //
    // POSITION: the optimistic readout was transient - it cleared itself after
    // 1500ms - so a check made after the settle window below would find it gone
    // and pass over the very bug it exists to catch. This lands a few hundred
    // milliseconds after the click, deep inside the window the old code would
    // have been showing it in.
    //
    // FORM: a ONE-SHOT `.count()`, never `await expect(locator).toHaveCount(0)`.
    // The web-first assertion RETRIES until it passes, so it would sit and wait
    // out the 1500ms and then report the readout absent - green, against a panel
    // that had just told the user their refused edit was live. Measured: written
    // that way it passed under the mutation below, which is exactly the
    // structurally-blind check this project keeps finding.
    //
    // MUTATION-PROVED. Restoring the shipped optimistic body of `onApply`
    // (`setCommitted(toCommit); setBuffer(toCommit); setDirty(false);
    // setApplied(true)` on a true dispatch flag) reddens this line with the
    // observed message:
    //
    //   Error: the panel never claims an Apply it has not observed
    //   expect(received).toBe(expected) // Object.is equality
    //   Expected: 0
    //   Received: 1
    //
    // which is the readout telling the user their routing is live, at the same
    // moment as the sentence below telling them the host refused it.
    expect(
      await page.getByText('Applied', { exact: true }).count(),
      'the panel never claims an Apply it has not observed',
    ).toBe(0);

    // The host really did refuse it. The shared surface says WHY, and it is the
    // only place that does: this panel grows no second error surface
    // (65-UI-SPEC state 6).
    await expect(page.locator('#fab-refusal .fab-panel')).toBeVisible();
    expect(await page.locator('#fab-refusal').textContent()).not.toBe('');

    // Wait for the panel to STOP asking the host, rather than for a wall-clock
    // window mirrored off a constant that could drift. When two consecutive
    // samples agree the confirmation walk has run out of attempts.
    await expect
      .poll(
        async () => {
          const before = reads;
          await page.waitForTimeout(600);
          return reads === before;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // It ASKED, more than the once it asks on mount. A panel that assumed the
    // answer would have queried exactly once in this whole test.
    expect(reads, 'the panel re-read the host before claiming anything').toBeGreaterThan(1);

    // Still nothing claimed once the walk has given up, and the marker that is
    // the user's last warning is still on screen.
    //
    // MUTATION-PROVED by the SAME mutation, and this is the assertion that
    // reddens on it FIRST in file order once the transient readout has expired:
    //
    //   Error: the buffer is STILL dirty
    //   expect(locator).toBeVisible() failed
    //   Locator: getByText('• not applied')  (CONFIG_NOT_APPLIED_MARKER)
    //   Expected: visible
    //   Error: element(s) not found
    await expect(page.getByText('Applied', { exact: true })).toHaveCount(0);
    await expect(page.getByText(CONFIG_NOT_APPLIED_MARKER), 'the buffer is STILL dirty').toBeVisible();
    await expect(apply, 'Apply is still live').toBeEnabled();

    // AND THE COMMITTED TABLE WAS NEVER ADVANCED. Revert restores the table the
    // host actually holds, not the one it threw away. Under the shipped bug this
    // reverted TO the refused edit, which is the quietest half of the defect: no
    // readout, no message, just the wrong table presented as the saved one.
    await page.getByRole('button', { name: 'Revert' }).click();
    await expect(arm(page).locator('#fab-route-expect-0')).toHaveValue('ab');
  });

  test('an ACCEPTED Configure is confirmed against the host BEFORE the panel says Applied', async ({
    page,
  }) => {
    // The other half, and the reason the fix is a confirmation rather than the
    // removal of the readout: an Apply the host really took still reports as
    // taken, and the not-applied marker still clears.
    //
    // The mock host FOLDS here, which is the honest way to serve this: the
    // gesture answer decodes the panel's OWN emitted bytes and makes them the
    // new read-back, so nothing in this test types out the table it then checks
    // for. An accept sends no frame at all, exactly like the real host.
    let served: unknown = ROUTER_CONFIG;
    await selectMachine(
      page,
      ROUTER,
      ROUTER_BODY,
      () => served,
      (frame) => {
        if (frame[0] === CMD.Configure) served = decodeRouterConfigure(frame).config;
        return GESTURE_ACCEPTED;
      },
    );
    await expect(arm(page)).toBeVisible();
    await arm(page).locator('#fab-route-expect-0').fill('zz');
    // The marker is seen BEFORE the Apply, so its absence after it is a reading that can
    // fail (phase 90, research Finding J: an absence check on words that never render passes).
    const marker = page.getByText(CONFIG_NOT_APPLIED_MARKER);
    await expect(marker, 'the typed edit shows the not-applied marker').toBeVisible();

    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page.getByText('Applied', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(marker, 'the confirmed Apply clears the not-applied marker').toBeHidden();
    // And the host is holding the edit, which is the thing that was observed.
    await expect(arm(page).locator('#fab-route-expect-0')).toHaveValue('zz');
  });

  test('focus stays inside the panel after a rule is DELETED, at every list length', async ({
    page,
  }) => {
    // The DOM half of the delete focus restore. A vitest cannot make this
    // assertion at all: `vitest.config.ts` runs `environment: 'node'`, so there
    // is no `document` and no `activeElement`. The unit suite goes as far as it
    // can - it asserts WHICH controls are named, through the `onDeleted` seam -
    // and this asserts focus actually lands on one of them.
    //
    // A delete is HARDER than a move, which is why it needs its own leg: a move
    // leaves the pressed button mounted and merely disabled, while a delete
    // UNMOUNTS it. Focus then falls to `document.body` and the next Tab restarts
    // at the top of the document, throwing the user out of the panel mid-edit.
    await selectMachine(page, ROUTER, ROUTER_BODY, THREE_RULE_CONFIG);
    await expect(arm(page)).toBeVisible();
    await expect(page.getByRole('group', { name: 'Send to, rule 3' })).toBeVisible();

    const activeId = (): Promise<string> =>
      page.evaluate(() => document.activeElement?.id ?? '');

    // Focus + Enter, not a mouse click: this is the reported flow ("Tab to
    // Delete rule 3, press Enter"), and a click would set focus itself and so
    // could pass with no restore at all.
    //
    // MUTATION-PROVED. Dropping the `onDeleted` wiring from
    // `RouterConfigSection`, so nothing is named after a delete, reddens this
    // line with the observed message
    // `Expected: "fab-route-delete-1" / Received: ""` - and that empty string is
    // the whole defect: `document.body` has no id because focus is on the
    // document, outside the panel entirely.
    await page.locator('#fab-route-delete-2').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: 'Send to, rule 3' })).toHaveCount(0);
    expect(await activeId()).toBe('fab-route-delete-1');

    // The rule really went: the survivors are rules 1 and 2's patterns.
    await expect(arm(page).locator('#fab-route-expect-0')).toHaveValue('ab');
    await expect(arm(page).locator('#fab-route-expect-1')).toHaveValue('cd');

    // Press again WITHOUT re-aiming, which is what a second Enter does. Rule 2
    // was the last, so nothing slides into its slot and focus moves up.
    await page.keyboard.press('Enter');
    await expect(arm(page).locator('#fab-route-expect-1')).toHaveCount(0);
    expect(await activeId()).toBe('fab-route-delete-0');

    // The LAST rule: the list empties, no delete control survives, and the chain
    // falls through to the append control. Still inside the panel.
    await page.keyboard.press('Enter');
    await expect(arm(page).getByText('No rules yet.')).toBeVisible();
    expect(await activeId()).toBe('fab-route-add');
  });

  test('the rendered arm passes a scoped axe scan, with contrast really measured', async ({
    page,
  }) => {
    await selectMachine(page, ROUTER, ROUTER_BODY, THREE_RULE_CONFIG);
    await expect(arm(page)).toBeVisible();

    const results = await new AxeBuilder({ page }).include('#fab-router-config').analyze();
    expect(results.violations).toEqual([]);

    // THE ANTI-VACUITY HALF, and it is the reason this leg is in a browser at
    // all: `color-contrast` reports INCOMPLETE in a simulated DOM, and a rule
    // that reports incomplete is a green that measured nothing.
    const contrast = results.passes.find((r) => r.id === 'color-contrast');
    expect(contrast, 'color-contrast produced real verdicts over the arm').toBeDefined();
    expect(contrast?.nodes.length ?? 0).toBeGreaterThan(0);

    // MEASURED, not assumed: axe still returns SOME incomplete contrast nodes
    // here, and blanket-allowing them would put the vacuous green back. Every
    // one of them is a move control, and every one carries the SAME abstention
    // reason - axe declines to judge an element whose whole content is a symbol
    // glyph, which is what `↑` and `↓` are. Those buttons ride the identical
    // `.fab-tool-btn` ink and fill as the segments beside them, which the pass
    // list above did measure. Pinning both the node set and the reason means a
    // future element that goes unmeasured for a DIFFERENT cause fails here.
    //
    // ONE OTHER ABSTENTION IS ALLOWED, AND ONLY WHERE IT IS MEASURED TRUE: the arm is taller than
    // the panel (it scrolls at every size), and a node that reaches the sticky Apply row's top
    // edge, under the row or scrolled out below it, reads `elmPartiallyObscured`: a scroll
    // position, not a contrast verdict. Since phase 91 review WR-B-06 the panel ends above the
    // camera cluster, which moved where that edge falls. Such a node is accepted only if its box
    // is measured reaching past the row's top.
    const unmeasured = results.incomplete.find((r) => r.id === 'color-contrast');
    const rowTop = await page.evaluate(
      () => document.querySelector('aside[aria-labelledby="fab-config-heading"] [data-fab-action-row]')?.getBoundingClientRect().top ?? null,
    );
    for (const node of unmeasured?.nodes ?? []) {
      const keys = node.any.map((c) => (c.data as { messageKey?: string } | undefined)?.messageKey);
      const target = String(node.target[0]);
      if (keys.every((k) => k === 'elmPartiallyObscured')) {
        const box = await page.locator(target).boundingBox();
        expect(rowTop, 'the action row is on screen').not.toBeNull();
        expect(box, `${target} is on screen`).not.toBeNull();
        expect(
          box!.y + box!.height > rowTop!,
          `${target} reads partly obscured only because it reaches under the sticky Apply row or below it (row top ${rowTop}, box ${JSON.stringify(box)})`,
        ).toBe(true);
        continue;
      }
      expect(node.any.map((c) => c.data as { messageKey?: string } | undefined)).toEqual(
        node.any.map(() => ({ messageKey: 'nonBmp' })),
      );
      expect(target).toMatch(/^#fab-route-move-(up|down)-\d+$/);
    }
  });
});

// ───────────────── The weld between this fixture and the host DTO ────────────
// The one leg in this file that opens no browser. It exists because the fixture
// above is a hand copy, and a hand copy is a claim about Rust that nothing
// checks. This is the check, built the way the codebase already welds its two
// languages together: `command_error_view.rs` `include_str!`s `transport.ts` and
// parses the tag table out of it, so a rename on one side fails on the other.
// This is that link pointed the other way.

/** The Rust file whose test literal pins the `ConfigView::Router` JSON shape. */
const CONFIG_VIEW_RS = fileURLToPath(
  new URL('../../crates/fabrico-host/src/config_view.rs', import.meta.url),
);

/**
 * Read the `serde_json::json!({...})` literal that
 * `config_view_renders_belt_and_router_configs` asserts the Router ConfigView
 * against, straight out of the Rust source, and parse it as JSON.
 *
 * The parser is deliberately BRITTLE and THROWS on anything it does not
 * recognise (the `command_error_view.rs` strict-line-parser discipline): a
 * silent return would turn this weld into a green that measured nothing, which
 * is the failure mode the whole leg exists to remove. Rust's `json!` body is
 * literal JSON here, so brace matching plus `JSON.parse` is the entire job.
 */
function rustRouterConfigView(): unknown {
  const src = readFileSync(CONFIG_VIEW_RS, 'utf-8');
  const marker = '"kind": "Router",';
  const at = src.indexOf(marker);
  if (at === -1) {
    throw new Error(
      `the Router ConfigView literal is gone from ${CONFIG_VIEW_RS}: this weld cannot be silently skipped`,
    );
  }
  const open = src.lastIndexOf('{', at);
  if (open === -1) throw new Error('no opening brace before the Router literal');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return JSON.parse(src.slice(open, i + 1));
    }
  }
  throw new Error('the Router literal never closed');
}

/**
 * The structural fingerprint of a Router config's `routes` value, reduced to one
 * word: the exact thing that regressed in UI-SPEC FINDING 1.
 *
 * `pairs` is `[[{offset, expect}, port], ...]`, which the TS type and the
 * shipped postcard encoder both destructure as `const [key, port]`. The flat
 * `[{offset, expect, port}, ...]` shape fed `undefined` into `varintU` and wrote
 * garbage bytes into a certified `Configure`.
 */
function routesShape(config: unknown): string {
  const routes = (config as { routes?: unknown }).routes;
  if (!Array.isArray(routes)) return 'absent';
  if (routes.length === 0) return 'empty';
  const isPair = (r: unknown): boolean =>
    Array.isArray(r) &&
    r.length === 2 &&
    typeof r[1] === 'number' &&
    typeof r[0] === 'object' &&
    r[0] !== null &&
    'offset' in (r[0] as object) &&
    'expect' in (r[0] as object);
  return routes.every(isPair) ? 'pairs' : 'flat-or-other';
}

test('the fixtures in this file are WELDED to the host DTO, not merely copied from it', () => {
  const rust = rustRouterConfigView();

  // ANTI-VACUITY FIRST. A parser that found nothing would report every shape
  // check below as trivially satisfied, so pin what was actually read.
  expect(rust, 'the Rust literal really was read').toMatchObject({ kind: 'Router' });
  expect((rust as { routes: unknown[] }).routes.length, 'and it carries rules').toBe(2);

  // THE WELD. A host DTO regression to the flat objects has to change this Rust
  // literal with it - the Rust test asserts the serialization against it - so a
  // re-blessed literal is caught HERE, which is the hole the old docblock
  // claimed was covered and was not.
  //
  // MUTATION-PROVED. Flattening the Rust literal to
  // `[{"offset": 0, "expect": [97, 98], "port": 1}, ...]`, which is exactly the
  // shipped defect, reddens this line with the observed message:
  //
  //   Error: the Rust literal still pins the PAIR shape
  //   expect(received).toBe(expected) // Object.is equality
  //   Expected: "pairs"
  //   Received: "flat-or-other"
  expect(routesShape(rust), 'the Rust literal still pins the PAIR shape').toBe('pairs');

  // And every fixture this file serves the panel is that same shape, so the
  // browser legs above are exercising the host's real reply shape rather than
  // one this spec invented.
  expect(routesShape(ROUTER_CONFIG), 'ROUTER_CONFIG matches it').toBe('pairs');
  expect(routesShape(THREE_RULE_CONFIG), 'THREE_RULE_CONFIG matches it').toBe('pairs');
});
