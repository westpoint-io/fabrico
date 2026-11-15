import { expect, test } from '@playwright/test';
import { docsUrl } from './support/site.ts';

// Your first factory lays out each tutorial step the same way: an h2 starting `Step `, the actions
// in the app, then exactly one running board showing what the reader's board should look like. This
// check reads the built page in document order and fails when a Step section holds no board or more
// than one, or when the step boards are out of order.

/** The step boards, in the order the page has to show them. */
const STEP_BOARDS = ['docs-start-first-factory-1', 'docs-start-first-factory-2', 'docs-start-first-factory-3'];

/** One h2 section of the page: its heading and the board names inside it, in order. */
interface Section {
  heading: string;
  boards: string[];
}

test('Your first factory: each Step h2 holds exactly one board, steps 1 to 3 in order', async ({ page }) => {
  await page.goto(docsUrl('get-started/first-factory/'));
  const sections: Section[] = await page.evaluate(() => {
    const out: { heading: string; boards: string[] }[] = [];
    for (const el of document.querySelectorAll('main h2, main .fab-board-slot')) {
      if (el.tagName === 'H2') {
        out.push({ heading: (el.textContent ?? '').trim(), boards: [] });
      } else if (out.length > 0) {
        out[out.length - 1].boards.push(el.querySelector('fabrico-board')?.getAttribute('name') ?? '(a slot with no board)');
      }
    }
    return out;
  });
  const steps = sections.filter((s) => s.heading.startsWith('Step '));
  expect(steps.length, `the page has at least ${STEP_BOARDS.length} Step sections; it has ${JSON.stringify(sections.map((s) => s.heading))}`).toBeGreaterThanOrEqual(
    STEP_BOARDS.length,
  );
  for (const s of steps) {
    expect(s.boards, `"${s.heading}" holds exactly one board`).toHaveLength(1);
  }
  expect(
    steps.map((s) => s.boards[0]),
    'the Step boards, in page order',
  ).toEqual(STEP_BOARDS);
});
