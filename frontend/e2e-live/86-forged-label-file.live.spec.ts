import { test, expect, type Page } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensurePlaying,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  resetToDemo,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 86-forged-label-file.live.spec.ts (plan 86-07, D-08, WORK-09, phase 86 success criterion 4).
//
// A HAND-EDITED FILE THAT GIVES A LABEL A PORT IS REFUSED ON OPEN, IN WORDS, AND THE RUNNING
// BOARD IS LEFT ALONE. A label is a note on the board: it never takes a port, a belt or a
// cable. The app refuses every such gesture (`LabelDoesNotConnect`), so only a file edited by
// hand can carry one, and until plan 86-07 such a file opened with the label holding the port.
//
// THE FILE IS GENERATED, NOT HAND-WRITTEN. `crates/fabrico-host/tests/fixtures/
// 86-label-given-a-port.fab` is a real host board (a Source, a Sink and a label placed from the
// palette, saved by the shipped `save_project`) with ONE forged `AddPort` record appended that
// gives the label an output. `crates/fabrico-host/tests/forged_files.rs` builds it and its
// currency test requires the committed bytes equal a fresh build.
//
// WHAT IS GRADED IS WHAT THE USER SEES: the refusal card's sentence, the board's node, belt and
// cable sets before and after the Open, byte for byte, and the board still ticking with the
// card up. Red on the unchanged host (`label-file-red.*`): no card, the forged board opened.
//
// Render health in the test (fabrico-model-oracle-blindspot): `watchPageErrors` before
// `page.goto`, then `expectRenderLoopAlive` and the watcher's `assertNone` once the card is up.
//
// Drive rules: the real Open button and the browser prompt dialog, never an injected packet;
// every wait polls a specific change, never a fixed sleep.

/** The committed forged board. */
const FIXTURE = fileURLToPath(
  new URL('../../crates/fabrico-host/tests/fixtures/86-label-given-a-port.fab', import.meta.url),
);

/** The host's `ProjectError::LabelConnected` sentence, transcribed rather than imported: the
 *  live suite imports no product source. */
const SENTENCE =
  'This file gives a label a port or joins it to a belt or cable. Labels do not connect, so the file was not opened.';

/** `STATUS_LOAD_TIMEOUT_MS` in `frontend/src/chrome/App.tsx`: the card must beat it. */
const STATUS_LOAD_TIMEOUT_MS = 10_000;

/** The topology a user sees, without anything that moves on its own (items, pulses, machine
 *  state): node ids, kinds, cells, ports and labels; belt ids, tiles and docks; cable ends and
 *  routes. */
function topologyOf(scene: SceneFacts): string {
  const nodes = scene.nodes
    .map((n) => ({ id: n.id, kind: n.kind, cells: n.cells, ports: n.ports, label: n.label }))
    .sort((a, b) => a.id - b.id);
  const belts = scene.belts
    .map((b) => ({ id: b.id, tiles: b.tiles, docks: b.docks }))
    .sort((a, b) => a.id - b.id);
  const wires = scene.wires
    .map((w) => ({ id: w.id, from: w.from, to: w.to, path: w.path }))
    .sort((a, b) => a.id - b.id);
  return JSON.stringify({ nodes, belts, wires });
}

/** The mounted load-refusal card, or an empty locator when none is held. */
function refusalCard(page: Page) {
  return page.getByRole('alert');
}

test.describe('D-08 live: a file that gives a label a port is refused on open, the running board untouched', () => {
  test('opening the forged label file shows the sentence naming the problem, and the playing board keeps its topology and keeps ticking', async ({
    page,
  }) => {
    // Installed BEFORE `goto` so a boot-time throw is caught too.
    const pageErrors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await ensurePlaying(page);
    await expect(refusalCard(page)).toHaveCount(0);
    await expectRenderLoopAlive(page, 'on the demo board before the Open');

    const before = await readScene(page);
    expect(before.nodes.length, 'the demo board is on screen with its machines').toBeGreaterThan(0);
    const topologyBefore = topologyOf(before);

    // A private copy, so the host opens a file nothing else is writing.
    const path = join(tmpdir(), `fabrico-e2e-86-label-port-${Date.now()}.fab`);
    copyFileSync(FIXTURE, path);
    page.once('dialog', (d) => void d.accept(path));
    await page.getByTitle('Load a saved factory').click();

    // (1) THE CARD SAYS WHY, in the host's own sentence.
    await expect(refusalCard(page), 'the refusal card is on screen').toHaveCount(1, {
      timeout: STATUS_LOAD_TIMEOUT_MS - 1_000,
    });
    const said = ((await refusalCard(page).textContent()) ?? '').trim();
    expect(said, 'the card carries the label sentence word for word').toContain(SENTENCE);

    // (2) THE RUNNING BOARD IS UNCHANGED BEHIND THE CARD, node, belt and cable for cable.
    const atCard = await readScene(page);
    expect(topologyOf(atCard), 'the refused open left the board exactly as it was').toBe(
      topologyBefore,
    );

    // (3) THE BOARD KEEPS TICKING after the refusal.
    await pollScene(page, (s) => s.tick, {
      message: `the board keeps ticking after the refusal (tick was ${atCard.tick} when the card showed)`,
    }).toBeGreaterThan(atCard.tick);
    expect(
      topologyOf(await readScene(page)),
      'the board is still the same board once it has ticked on',
    ).toBe(topologyBefore);

    // RENDER HEALTH, with the card still up: the oracle above reads only the model.
    await expectRenderLoopAlive(page, 'with the label refusal card on screen');
    pageErrors.assertNone('during the refused open of the forged label file');

    // The card is the user's to dismiss.
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(refusalCard(page)).toHaveCount(0);
  });
});
