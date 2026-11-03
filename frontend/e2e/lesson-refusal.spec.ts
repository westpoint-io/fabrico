import { test, expect, type Page } from '@playwright/test';
import { YOUR_FIRST_LINE } from '../src/tutorial/lessons/yourFirstLine';
import { coachLine } from '../src/tutorial/note';
import { phrasePlain } from '../src/tutorial/phrase';
import type { Stage } from '../src/tutorial/types';
import { buildPacket, cameraOf, nubAnchor, screenCellCentre, screenPoint, type Harness, type InjectNode } from './support/wire';
import {
  CARD,
  armSourceForFloor,
  boot,
  cellOfRing,
  configuredHost,
  injectRefusal,
  placeBoth,
  readProbe,
  ringAt,
  sinkAt,
  sourceAt,
  startLesson,
  toBeltDraw,
} from './support/lessonMock';

// lesson-refusal.spec.ts - what the step card says when the app refuses a gesture during a lesson.
//
// The band at the top keeps its own sentence and rules. The card's note slot says what to do in this
// step: the lesson's coaching line if the stage has one for the tag, otherwise the band's own sentence.
// These cases read the card note against the band's text in the page, so no Playwright file imports
// `RefusalMessage.tsx` (its SVG asset breaks the Playwright loader).

const NOTE = `${CARD} [data-fab-step-note]`;
const BAND = '#fab-refusal';
/** `REFUSAL_HOLD_MS` in `RefusalMessage.tsx`, mirrored as a literal because this spec can't import that file. */
const REFUSAL_HOLD_MS = 4000;
/** Past the band's hold, so the band has cleared. */
const PAST_THE_HOLD_MS = REFUSAL_HOLD_MS + 500;

function stageOf(stepId: string, stageId: string): Stage {
  const stage = YOUR_FIRST_LINE.steps.find((s) => s.id === stepId)?.stages.find((s) => s.id === stageId);
  if (stage === undefined) throw new Error(`the lesson has no ${stepId}/${stageId} stage`);
  return stage;
}

const COACH_LINE = phrasePlain(coachLine(stageOf('place-sink', 'sink-floor'), 'FootprintCollision') ?? []);

/** A host the case can tell to refuse each Place as a collision; any other gesture gets no answer. */
function refusingHost(): { host: ReturnType<typeof configuredHost>; opts: Parameters<typeof boot>[1]; refuse(on: boolean): void } {
  const host = configuredHost();
  let refusing = false;
  return {
    host,
    opts: { ...host.opts, answerGesture: () => (refusing ? 'FootprintCollision' : undefined) },
    refuse: (on) => {
      refusing = on;
    },
  };
}

/** The card note's kind and words, read together. */
async function readNote(page: Page): Promise<{ kind: string | null; text: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { kind: el?.getAttribute('data-fab-step-note') ?? null, text: el?.textContent ?? '' };
  }, NOTE);
}

/** Steps 1 and 2 up to the Sink's floor ring, with the Source on the board and the Sink tool armed. */
async function toSinkFloor(page: Page, h: Harness): Promise<InjectNode> {
  const { cell } = await armSourceForFloor(page);
  const source = sourceAt(cell);
  h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [source] }));
  await ringAt(page, 'sink-tool');
  await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
  await ringAt(page, 'sink-floor');
  return source;
}

/** A Sink press on the Source's own cell, which the host refuses as a collision. */
async function pressOnSource(page: Page, source: InjectNode): Promise<void> {
  const at = await screenCellCentre(page, source.cell_x, source.cell_y);
  await page.mouse.click(at.x, at.y);
}

async function expectCoachLine(page: Page, what: string): Promise<void> {
  await expect.poll(() => readNote(page), { message: what }).toEqual({ kind: 'refusal', text: COACH_LINE });
}

test.describe('the step card says why a gesture was refused', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a refusal at a stage with no lesson line shows the band's own sentence on the card", async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    await placeBoth(page, h);
    await toBeltDraw(page, host);
    expect(coachLine(stageOf('draw-belt', 'belt-draw'), 'InvalidDock'), 'the stage has no lesson line for this tag').toBeNull();

    injectRefusal(h, 'InvalidDock');

    await expect(page.locator(BAND), 'the band shows its sentence').not.toHaveText('');
    const band = (await page.locator(BAND).textContent())?.trim() ?? '';
    expect(band.length, 'the band holds words').toBeGreaterThan(0);
    await expect.poll(() => readNote(page), { message: "the card shows the band's sentence" }).toEqual({ kind: 'refusal', text: band });
    const probe = await readProbe(page);
    expect(probe.stageId, 'the step stayed where it was').toBe('belt-draw');
    expect([probe.noteKind, probe.noteText], 'the probe reads the same note').toEqual(['refusal', band]);
  });

  test("a client refusal shows the band's own sentence on the card", async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    const { source } = await placeBoth(page, h);
    // The Wire tool armed keeps the card at the tool-down stage, so the press can't move the stage.
    await page.getByTitle(/^Draw wires/).click();
    await ringAt(page, 'tool-down');
    const sent = h.sent.length;

    // The Source's Out takes belts, not wires, so a Wire press on it forms no command and the client
    // refuses it as BeltOnlyPort (the press `e2e/belt-port-refusal.spec.ts` makes on a Router's Out).
    const out = await screenPoint(page, nubAnchor(source.cell_x, source.cell_y, 1));
    const start = { x: out.x + 3, y: out.y - 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y + 20, { steps: 6 });
    await page.mouse.move(start.x + 60, start.y + 20, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator(BAND), 'the client sentence reached the band').not.toHaveText('');
    const band = (await page.locator(BAND).textContent())?.trim() ?? '';
    await expect.poll(() => readNote(page), { message: "the card shows the client's sentence" }).toEqual({ kind: 'refusal', text: band });
    expect(h.sent.length, 'the press sent no gesture, so the sentence is the client\'s').toBe(sent);
    expect((await readProbe(page)).stageId, 'the step stayed where it was').toBe('tool-down');
  });

  test("at the Sink's floor stage a collision shows the lesson's coaching line", async ({ page }) => {
    const r = refusingHost();
    const h = await boot(page, r.opts);
    await startLesson(page, h);
    const source = await toSinkFloor(page, h);

    r.refuse(true);
    await pressOnSource(page, source);

    await expectCoachLine(page, 'the card shows the coaching line');
    await expect(page.locator(BAND), 'the band shows its own sentence').not.toHaveText('');
    const band = (await page.locator(BAND).textContent())?.trim() ?? '';
    expect(band, 'the band and the card say different things').not.toBe(COACH_LINE);
    expect((await readProbe(page)).stageId, 'the step stayed where it was').toBe('sink-floor');
  });

  test('a second collision in the same stage leaves the note text node as it was', async ({ page }) => {
    const r = refusingHost();
    const h = await boot(page, r.opts);
    await startLesson(page, h);
    const source = await toSinkFloor(page, h);
    r.refuse(true);
    await pressOnSource(page, source);
    await expectCoachLine(page, 'the first collision put the line on the card');

    // Hold the text node and count every change under the note from here on.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const p = el?.querySelector('p');
      if (!el || !p) throw new Error('no note to watch');
      const w = window as unknown as { __noteNode: Node | null; __noteChanges: number };
      w.__noteNode = p.firstChild;
      w.__noteChanges = 0;
      new MutationObserver((records) => {
        w.__noteChanges += records.length;
      }).observe(el, { characterData: true, childList: true, subtree: true, attributes: true });
    }, NOTE);
    const sent = h.sent.length;

    await pressOnSource(page, source);
    await expect.poll(() => h.sent.length, { message: 'the second press went to the host and was refused' }).toBeGreaterThan(sent);
    // Two frames, so a re-render from the second refusal would have landed.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

    const after = await page.evaluate((sel) => {
      const w = window as unknown as { __noteNode: Node | null; __noteChanges: number };
      const p = document.querySelector(sel)?.querySelector('p');
      return { same: p?.firstChild === w.__noteNode && w.__noteNode !== null, changes: w.__noteChanges };
    }, NOTE);
    expect(after, 'the same text node, with no change under the note').toEqual({ same: true, changes: 0 });
    expect((await readNote(page)).text).toBe(COACH_LINE);
  });

  test("the same tag after a stage change shows again while the band's same-tag hold still runs", async ({ page }) => {
    const r = refusingHost();
    const h = await boot(page, r.opts);
    await startLesson(page, h);
    const source = await toSinkFloor(page, h);
    r.refuse(true);
    await pressOnSource(page, source);
    await expectCoachLine(page, 'the first collision put the line on the card');
    const first = Date.now();
    const band = (await page.locator(BAND).textContent())?.trim() ?? '';

    await page.keyboard.press('Escape');
    await ringAt(page, 'sink-tool');
    await expect(page.locator(NOTE), 'the stage changed, so the note cleared').toHaveCount(0);
    await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
    await ringAt(page, 'sink-floor');
    await expect(page.locator(NOTE), 'a new stage starts with no note').toHaveCount(0);

    // The band still shows the first sentence, so its same-tag return will hold the second one back.
    await expect(page.locator(BAND)).toHaveText(band);
    await pressOnSource(page, source);
    await expectCoachLine(page, 'the card heard the repeat the band held back');
    expect(Date.now() - first, `the second collision came inside the band's ${REFUSAL_HOLD_MS} ms hold`).toBeLessThan(REFUSAL_HOLD_MS);
  });

  test('the note outlasts the band and goes when the step changes', async ({ page }) => {
    const r = refusingHost();
    const h = await boot(page, r.opts);
    await startLesson(page, h);
    const source = await toSinkFloor(page, h);
    r.refuse(true);
    await pressOnSource(page, source);
    await expectCoachLine(page, 'the collision put the line on the card');

    await page.waitForTimeout(PAST_THE_HOLD_MS);
    await expect(page.locator(BAND), 'the band cleared after its hold').toHaveText('');
    expect(await readNote(page), 'the card note has no timer').toEqual({ kind: 'refusal', text: COACH_LINE });

    // The Sink lands on a free cell: the host's answer puts it on the board and the step moves on.
    const sinkRing = await ringAt(page, 'sink-floor');
    const sink = sinkAt(cellOfRing(sinkRing, await cameraOf(page)));
    h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: [source, sink] }));
    await expect.poll(async () => (await readProbe(page)).stepId, { message: 'the step moved on' }).toBe('set-timer');
    await expect(page.locator(NOTE), 'the note went with the step').toHaveCount(0);
  });
});
