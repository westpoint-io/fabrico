import { test, expect, type Page } from '@playwright/test';
import { buildPacket, mockRenderSocket, waitForBoard, waitForChrome, type InjectNode } from './support/wire';

// chrome-removals.spec.ts (phase 91, plan 91-03): the leftovers the user could see are gone.
//
// CHROME-01 (D-02): the bottom-right readout (`tick N . F fps . M machines`) sat under the camera
// cluster at the same corner anchor, so it was covered and unreadable, and the tick it showed is
// already in the toolbar. It is deleted with no replacement. Its one product dependency, the
// Legend's rule that two corner docks must report a box, moves to one dock (the camera cluster),
// so the Legend still opens with nothing selected.
//
// CHROME-03 (D-04): the Graphics panel in the camera cluster held one control with no visible
// effect at the shipped belt rate. It is deleted, with its trigger, so the cluster holds Fit and
// the zoom readout only.
//
// Success criterion 1 of phase 91: these are gone from the app. Graded by the DOM and bounding
// boxes at 1280x800 and 1024x768, not by a pixel strip (a strip left of the cluster reads the
// canvas colour at the start revision too, because the cluster covers the readout).

/** One Source (kind 0) away from the corners. */
const SOURCE: InjectNode = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const;

/** The `--fab-space-lg` gutter the Legend stops short of the cluster by. */
const GUTTER_PX = 24;

async function boardWithOneSource(page: Page): Promise<void> {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 3, nodes: [SOURCE] }));
  await waitForBoard(page, { machines: 1, tick: 3 });
}

test.describe('the bottom-right readout is gone (CHROME-01, D-02)', () => {
  for (const { width, height } of SIZES) {
    test(`the readout is gone and the Legend still opens at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boardWithOneSource(page);

      // No element anywhere reads an fps figure: the readout was the only surface that drew one.
      await expect(page.getByText(/fps/), 'no element on the page reads an fps figure').toHaveCount(0);

      // With nothing selected the corner holds exactly one right-docked surface, the camera
      // cluster. Exactly one, never at least one, so a stray dock still fails here.
      const docks = page.locator('[data-fab-corner-dock]');
      await expect(docks, 'one corner dock with nothing selected (the camera cluster)').toHaveCount(1);
      await expect(
        docks.first().getByRole('button', { name: 'Fit factory to view' }),
        'the one corner dock is the camera cluster',
      ).toBeVisible();

      // The Legend still opens: with one dock the band model must not refuse.
      await page.getByRole('button', { name: 'Legend' }).click();
      const legend = page.locator('#fab-legend-panel');
      await expect(legend, 'the Legend opens with one corner dock').toBeVisible();

      const legendBox = await legend.boundingBox();
      const clusterBox = await docks.first().boundingBox();
      expect(legendBox && clusterBox, 'the Legend and the cluster both have layout boxes').toBeTruthy();
      expect(
        legendBox!.x + legendBox!.width,
        `the Legend stops one gutter short of the camera cluster at ${width}x${height}`,
      ).toBeLessThanOrEqual(clusterBox!.x - GUTTER_PX + 0.5);
    });
  }
});

test.describe('the Graphics panel is gone (CHROME-03, D-04)', () => {
  for (const { width, height } of SIZES) {
    test(`the camera cluster holds Fit and the zoom only at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await boardWithOneSource(page);

      const cluster = page.locator('[data-fab-corner-dock]').filter({
        has: page.getByRole('button', { name: 'Fit factory to view' }),
      });
      await expect(cluster, 'the camera cluster is on the page').toHaveCount(1);
      const buttons = cluster.getByRole('button');
      await expect(buttons, 'the camera cluster holds exactly two buttons').toHaveCount(2);
      await expect(buttons.nth(0), 'the first is Fit').toHaveAccessibleName('Fit factory to view');
      // The zoom readout's name is its text, the live zoom percentage.
      await expect(buttons.nth(1), 'the second is the zoom readout').toHaveAccessibleName(/^\d+%$/);
      await expect(buttons.nth(1)).toHaveAttribute('title', 'Reset zoom to 100%');

      // No element anywhere carries the Graphics name, in the cluster or out of it.
      await expect(page.getByRole('button', { name: 'Graphics' }), 'no Graphics button').toHaveCount(0);
      await expect(page.getByLabel('Graphics', { exact: true }), 'no element labelled Graphics').toHaveCount(0);
    });
  }
});
