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

// 85-v11-file-refused.live.spec.ts (DEMO-03, D-07, phase 85 success criterion 2).
//
// A BOARD SAVED BY THE EARLIER BUILD IS REFUSED ON SCREEN, NAMING ITS VERSION AND THIS
// BUILD'S, AND THE RUNNING BOARD IS LEFT ALONE. The project file moved from version 11 to 12
// in one commit (plan 85-09): the field that recorded nodes placed outside the edit log is
// gone, and the snapshot and edit shapes the file embeds moved with the Email removal. A v11
// file is refused whole at its envelope, before any decode, as the host's existing "too old"
// refusal, whose sentence names both numbers.
//
// PLAN 87-03 MOVED THIS BUILD'S NUMBER TO 13. The project file went from 12 to 13 in lockstep
// with the snapshot's 13 to 14 (phase 87's four appended core fields), so the card now names
// v13 as the version this build reads. The file under test is still the real v11 save, and
// it is still refused whole at its envelope for the same reason.
//
// THE FILE IS REAL. `crates/fabrico-host/tests/fixtures/v11-demo-board.fab` was saved by the
// build at the phase's start revision through that build's own `save_project` (its sha256 is
// in `85-EVIDENCE.md`); the Rust witness in `project.rs` reads the same bytes. A hand-forged
// envelope would only prove the version peek, not that a user's real save is refused.
//
// WHAT IS GRADED IS WHAT THE USER SEES: the refusal card's words (the file's version 11 and
// this build's v13, at the envelope and not as a snapshot complaint), the board's node, belt
// and cable sets before and after, byte for byte, and the board still ticking after the card
// is up. Red before the bump: the envelope admitted the file and the card blamed the
// embedded snapshot's format, naming neither the file's version nor the reason.
//
// Render health in the test (fabrico-model-oracle-blindspot): `watchPageErrors` before
// `page.goto`, then `expectRenderLoopAlive` and the watcher's `assertNone` once the card is
// up, so a refusal that killed the renderer goes red here.
//
// Drive rules: the real Open button and the browser prompt dialog, never an injected packet;
// every wait polls a specific change, never a fixed sleep.

/** The committed v11 file saved by the earlier build. */
const V11_FIXTURE = fileURLToPath(
  new URL('../../crates/fabrico-host/tests/fixtures/v11-demo-board.fab', import.meta.url),
);

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

test.describe('DEMO-03: a file saved by the v11 build is refused on screen, the running board untouched', () => {
  test('opening the real v11 demo save shows a card naming 11 and v13, and the playing board keeps its topology and keeps ticking', async ({
    page,
  }) => {
    // Installed BEFORE `goto` so a boot-time throw is caught too.
    const pageErrors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await ensurePlaying(page);
    await expect(refusalCard(page)).toHaveCount(0);

    const before = await readScene(page);
    expect(before.nodes.length, 'the demo board is on screen with its machines').toBeGreaterThan(0);
    const topologyBefore = topologyOf(before);

    // A private copy, so the host opens a file nothing else is writing.
    const path = join(tmpdir(), `fabrico-e2e-v11-${Date.now()}.fab`);
    copyFileSync(V11_FIXTURE, path);
    page.once('dialog', (d) => void d.accept(path));
    await page.getByTitle('Load a saved factory').click();

    // (1) THE CARD NAMES BOTH VERSIONS, as the envelope refusal and not a snapshot complaint.
    await expect(refusalCard(page), 'the refusal card is on screen').toHaveCount(1, {
      timeout: STATUS_LOAD_TIMEOUT_MS - 1_000,
    });
    const said = ((await refusalCard(page).textContent()) ?? '').trim();
    expect(said, 'the card names the file\'s version, 11').toContain('version 11');
    expect(said, 'the card names the version this build reads, v13').toContain('v13');
    expect(said, 'the card says the file is too old').toContain('too old');
    expect(said, 'the refusal is the envelope\'s, not the embedded snapshot\'s').not.toContain(
      'snapshot',
    );

    // (2) THE RUNNING BOARD IS UNCHANGED BEHIND THE CARD, node, belt and cable for cable.
    const atCard = await readScene(page);
    expect(topologyOf(atCard), 'the refused open left the board exactly as it was').toBe(
      topologyBefore,
    );

    // (3) THE BOARD KEEPS TICKING after the refusal: the host kept the current scene running.
    await pollScene(page, (s) => s.tick, {
      message: `the board keeps ticking after the refusal (tick was ${atCard.tick} when the card showed)`,
    }).toBeGreaterThan(atCard.tick);
    expect(
      topologyOf(await readScene(page)),
      'the board is still the same board once it has ticked on',
    ).toBe(topologyBefore);

    // RENDER HEALTH, with the card still up: the oracle above reads only the model.
    await expectRenderLoopAlive(page, 'with the v11 refusal card on screen');
    pageErrors.assertNone('during the v11 refused open');

    // The card is the user's to dismiss.
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(refusalCard(page)).toHaveCount(0);
  });
});
