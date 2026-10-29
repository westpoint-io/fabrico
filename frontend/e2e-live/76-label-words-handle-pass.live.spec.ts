import { test, expect, type Page } from '@playwright/test';
import {
  cameraOf,
  expectRenderLoopAlive,
  handPlaceAt,
  labelBoxOn,
  labelWordsOf,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 76-label-words-handle-pass.live.spec.ts (76-14 refuter round, CR-01 label to label) - no
// painted frame shows one label's words over another label while an Undo or Redo hands a
// label's handle to the other label, on the REAL host (dev_render_server, real Core ->
// RenderProducer -> postcard -> WS). Zero mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// THE DEFECT
// ---------------------------------------------------------------------------
//
// `RenderProducer::reset` (every Undo and Redo) starts a fresh handle table that mints
// 0, 1, 2 ... in NodeId order, so on a board with labels Alpha and Beta, deleting Alpha and
// then Undo and Redo moves a label handle from one label to the other (measured on the
// host: a=0 b=1 before, b=0 after). `LabelWords` keeps one element per handle and follows
// the element set on React's NEXT commit; its per-frame loop checked only that the handle
// still named a label, so on the frame before the commit it moved the old element, with
// the old words, onto the other label's cell and showed it.
//
// WHY A PER-FRAME RECORDER. The window is one frame wide, so a polled read cannot see it
// (76-08-SUMMARY.md, refuter finding 8). The spec installs a requestAnimationFrame loop in
// the page AFTER `LabelWords` is running, so every frame it runs after the overlay's own
// loop and reads what that frame paints: every words element with `visibility: visible`
// must carry the words the scene's label on its handle holds. Packets arrive as WS tasks,
// never inside a frame's callbacks, so both loops see the same scene within a frame.
//
// POSITIVE CONTROL. Before the gestures a planted visible element with wrong words is put
// in the overlay for two frames; the recorder must report it, else it reads nothing.
// PRECONDITION. Across the Undo or the Redo, one handle must name Alpha's label in one
// state and Beta's in the next; without it the leg proves nothing.
//
// RED BEFORE THE FIX (LabelWords without the label-to-label guard): see 76-14-SUMMARY.md,
// "Refuter round".

/** The label kind byte (protocol `machine_kind::LABEL`). */
const KIND_LABEL = 11;
/** One cell in world px (`shared/geometry.ts` CELL). */
const CELL_PX = 32;
/** The box's centreline inset from the cell edges, world px. */
const BOX_INSET = 4;

interface WrongFrame {
  frame: number;
  node: string;
  shows: string;
  says: string | null;
  transform: string;
}

interface Audit {
  frames: number;
  wrong: WrongFrame[];
}

/** An empty board at camera scale 1. */
async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
}

/** Words to handle, for every label in the scene. */
function handlesByWords(scene: SceneFacts): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of scene.nodes) {
    if (n.kind === KIND_LABEL) out.set(n.label?.text ?? '', n.id);
  }
  return out;
}

/** Click empty floor a few px off a cell centre (blurs the panel, clears the selection). */
async function clickFloor(page: Page): Promise<void> {
  const floor = await screenCellCentre(page, 4, 6);
  await page.mouse.click(floor.x + 3, floor.y - 2);
}

/** Place a label by hand at (cx, cy), type its words, Apply, and wait for the host. */
async function placeLabel(page: Page, cx: number, cy: number, words: string): Promise<void> {
  await handPlaceAt(page, 'Label', cx, cy);
  await pollScene(page, (s) => nodeAtAnchor(s, cx, cy)?.kind ?? null, {
    message: `PRECONDITION: the real host echoed a label anchored at (${cx},${cy})`,
  }).toBe(KIND_LABEL);
  await expect(page.locator('#fab-label-text'), 'PRECONDITION: the placed label focuses its Text field').toBeFocused();
  await page.keyboard.type(words);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await pollScene(page, (s) => nodeAtAnchor(s, cx, cy)?.label?.text ?? null, {
    message: `PRECONDITION: the host holds the words ${words}`,
  }).toBe(words);
  await clickFloor(page);
}

/** Install the per-frame recorder. Must run after `LabelWords` has started its loop. */
async function installRecorder(page: Page): Promise<void> {
  await page.evaluate((kindLabel) => {
    const w = window as unknown as {
      __wordsAudit?: { frames: number; wrong: unknown[] };
      __fabrico?: { scene(): { nodes: Array<{ id: number; kind: number; label?: { text: string } | null }> } };
    };
    const audit = { frames: 0, wrong: [] as unknown[] };
    w.__wordsAudit = audit;
    const tick = (): void => {
      audit.frames += 1;
      const scene = w.__fabrico?.scene();
      if (scene) {
        const byId = new Map(scene.nodes.map((n) => [n.id, n]));
        for (const el of document.querySelectorAll<HTMLElement>('[data-testid="label-words"]')) {
          if (el.style.visibility !== 'visible') continue;
          const n = byId.get(Number(el.dataset.node));
          const says = n && n.kind === kindLabel ? (n.label?.text ?? '') : null;
          if (el.textContent !== says) {
            audit.wrong.push({
              frame: audit.frames,
              node: el.dataset.node ?? '',
              shows: el.textContent ?? '',
              says,
              transform: el.style.transform,
            });
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, KIND_LABEL);
}

async function readAudit(page: Page): Promise<Audit> {
  return page.evaluate(() => (window as unknown as { __wordsAudit: Audit }).__wordsAudit);
}

async function framesPass(page: Page, n: number): Promise<void> {
  const start = (await readAudit(page)).frames;
  await expect
    .poll(async () => (await readAudit(page)).frames - start, { message: `the recorder counted ${n} more frames` })
    .toBeGreaterThanOrEqual(n);
}

test.describe('CR-01 live: no frame shows one label words over another label across a keyframe', () => {
  test('leg 1: Alpha and Beta, delete Alpha, Ctrl+Z, Ctrl+Shift+Z, every frame recorded', async ({ page }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the labels are placed');

    await placeLabel(page, 10, 12, 'Alpha');
    await placeLabel(page, 18, 12, 'Beta');
    await expectRenderLoopAlive(page, 'after both labels are placed');
    const placed = handlesByWords(await readScene(page));
    await expect
      .poll(async () => (await labelWordsOf(page, placed.get('Alpha')!))?.visible ?? null, {
        message: 'PRECONDITION: the Alpha words are drawn',
      })
      .toBe(true);
    await expect
      .poll(async () => (await labelWordsOf(page, placed.get('Beta')!))?.visible ?? null, {
        message: 'PRECONDITION: the Beta words are drawn',
      })
      .toBe(true);

    await installRecorder(page);
    await framesPass(page, 5);
    expect((await readAudit(page)).wrong, 'the recorder sees nothing wrong on the settled board').toEqual([]);

    // POSITIVE CONTROL: a planted visible words element on no label's handle, two frames.
    await page.evaluate(() => {
      const overlay = document.querySelector('[data-testid="label-words"]')!.parentElement!;
      const fake = document.createElement('div');
      fake.dataset.testid = 'label-words';
      fake.dataset.node = '9999';
      fake.style.visibility = 'visible';
      fake.textContent = 'planted';
      fake.id = 'planted-words';
      overlay.appendChild(fake);
    });
    await framesPass(page, 2);
    await page.evaluate(() => document.getElementById('planted-words')!.remove());
    const control = await readAudit(page);
    expect(
      control.wrong.some((r) => r.node === '9999' && r.shows === 'planted' && r.says === null),
      'POSITIVE CONTROL: the recorder reports a visible words element on no label',
    ).toBe(true);
    await page.evaluate(() => {
      (window as unknown as { __wordsAudit: Audit }).__wordsAudit.wrong.length = 0;
    });

    // Select Alpha with a plain click off-centre on its box, then the Delete key (a diff).
    const onAlpha = await screenCellCentre(page, 12, 12);
    await page.mouse.click(onAlpha.x + 3, onAlpha.y - 2);
    await expect(page.locator('#fab-label-text'), 'PRECONDITION: the click selected Alpha').toHaveValue('Alpha');
    await page.keyboard.press('Delete');
    await pollScene(page, (s) => [...handlesByWords(s).keys()], {
      message: 'PRECONDITION: the Delete key removed Alpha',
    }).toEqual(['Beta']);
    const afterDelete = handlesByWords(await readScene(page));
    await framesPass(page, 3);

    // Ctrl+Z: a keyframe through RenderProducer::reset.
    await clickFloor(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => handlesByWords(s).size, { message: 'PRECONDITION: Ctrl+Z put Alpha back' }).toBe(2);
    await framesPass(page, 5);
    const afterUndo = handlesByWords(await readScene(page));
    await expectRenderLoopAlive(page, 'after the Ctrl+Z');

    // Ctrl+Shift+Z: another keyframe.
    await page.keyboard.press('Control+Shift+z');
    await pollScene(page, (s) => [...handlesByWords(s).keys()], {
      message: 'PRECONDITION: Ctrl+Shift+Z deleted Alpha again',
    }).toEqual(['Beta']);
    await framesPass(page, 5);
    const afterRedo = handlesByWords(await readScene(page));
    await expectRenderLoopAlive(page, 'after the Ctrl+Shift+Z');

    // PRECONDITION: across one of the two keyframes a handle passed from one label to the other.
    const passes: string[] = [];
    const stages: Array<[string, Map<string, number>]> = [
      ['delete', afterDelete],
      ['undo', afterUndo],
      ['redo', afterRedo],
    ];
    for (let i = 1; i < stages.length; i += 1) {
      const [, before] = stages[i - 1];
      const [name, after] = stages[i];
      for (const [wordsBefore, h] of before) {
        for (const [wordsAfter, h2] of after) {
          if (h === h2 && wordsBefore !== wordsAfter) passes.push(`${name}: handle ${h} ${wordsBefore} -> ${wordsAfter}`);
        }
      }
    }
    expect(
      passes.length,
      `PRECONDITION: a keyframe handed a label handle to the other label (stages ${JSON.stringify(
        stages.map(([n, m]) => [n, [...m]]),
      )})`,
    ).toBeGreaterThan(0);

    const audit = await readAudit(page);
    expect(audit.frames, 'the recorder ran through the gestures').toBeGreaterThan(20);
    expect(audit.wrong, `no frame showed one label words over another label (${passes.join('; ')})`).toEqual([]);

    // Settled: Beta's words on Beta's handle, over the box the canvas draws at (18,12).
    const beta = afterRedo.get('Beta')!;
    await expect
      .poll(async () => labelWordsOf(page, beta), { message: 'the Beta words element after the Redo' })
      .toMatchObject({ text: 'Beta', visible: true });
    await expect
      .poll(async () => (await labelBoxOn(page, beta))?.rect ?? null, {
        message: 'the canvas draws the Beta box at (18,12)',
      })
      .toEqual({
        x: 18 * CELL_PX + BOX_INSET,
        y: 12 * CELL_PX + BOX_INSET,
        w: 4 * CELL_PX - 2 * BOX_INSET,
        h: 1 * CELL_PX - 2 * BOX_INSET,
      });
    errs.assertNone('across place, delete, undo and redo');
  });
});
