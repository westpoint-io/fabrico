import { expect, test, type Page } from '@playwright/test';
import { docsUrl } from './support/site.ts';

// The OS tabs on the Install page (Starlight's Tabs, restyled in site/src/styles/theme.css). At
// 1280 px the page shows three tabs, Linux, macOS and Windows. Each is a standalone control, so at
// least 44 px tall. The selected tab is marked by a 2 px accent line along its top edge, drawn as an
// inset box-shadow in the colour of --fab-focus. The keyboard reaches the selected tab with Tab, the
// tab shows the site's 2 px accent outline, and ArrowRight selects the next tab, Starlight's own
// keyboard model. At 360 px the three labels fit the column, so the tab list doesn't scroll.

const URL_PATH = 'get-started/install/';
/** Tab presses allowed before the selected tab counts as unreachable by keyboard. */
const MAX_TABS = 80;

/** The colour of a --fab-* token as the browser computes it (`rgb(r, g, b)`). */
async function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

interface TabState {
  label: string;
  selected: boolean;
  height: number;
  boxShadow: string;
}

function tabStates(page: Page): Promise<TabState[]> {
  return page.locator('starlight-tabs [role="tab"]').evaluateAll((tabs) =>
    tabs.map((tab) => ({
      label: (tab.textContent ?? '').trim(),
      selected: tab.getAttribute('aria-selected') === 'true',
      height: tab.getBoundingClientRect().height,
      boxShadow: getComputedStyle(tab).boxShadow,
    })),
  );
}

test('Install Fabrico: the OS tabs are 44 px tall, mark the selected tab in accent along the top, and follow the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(docsUrl(URL_PATH));
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const accent = await tokenColour(page, '--fab-focus');

  const tabs = await tabStates(page);
  expect(
    tabs.map((t) => t.label),
    'the tab labels, in order',
  ).toEqual(['Linux', 'macOS', 'Windows']);
  for (const tab of tabs) {
    expect(tab.height, `the ${tab.label} tab is at least 44 px tall (it is ${tab.height})`).toBeGreaterThanOrEqual(44);
  }
  const selected = tabs.filter((t) => t.selected);
  expect(
    selected.map((t) => t.label),
    'the selected tab when the page opens',
  ).toEqual(['Linux']);
  expect(selected[0].boxShadow, `the selected tab's box-shadow holds the accent ${accent}`).toContain(accent);
  expect(selected[0].boxShadow, "the selected tab's box-shadow is a 2 px line").toContain('2px');
  for (const tab of tabs.filter((t) => !t.selected)) {
    expect(tab.boxShadow, `the unselected ${tab.label} tab has no accent mark`).not.toContain(accent);
  }

  // Tab from the top of the page until the keyboard is on the selected tab.
  const seen: string[] = [];
  let reached = false;
  for (let i = 0; i < MAX_TABS && !reached; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        label: `${el?.tagName.toLowerCase() ?? 'none'} "${(el?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`,
        selectedTab: el?.matches('starlight-tabs [role="tab"][aria-selected="true"]') ?? false,
      };
    });
    seen.push(stop.label);
    reached = stop.selectedTab;
  }
  expect(reached, `the selected tab within ${MAX_TABS} Tab presses; stops seen:\n${seen.join('\n')}`).toBe(true);
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { visible: el.matches(':focus-visible'), style: s.outlineStyle, width: s.outlineWidth, colour: s.outlineColor };
  });
  expect(focus.visible, 'the focused tab matches :focus-visible').toBe(true);
  expect(focus, 'the focused tab outline').toEqual({ visible: true, style: 'solid', width: '2px', colour: accent });

  await page.keyboard.press('ArrowRight');
  const after = await tabStates(page);
  expect(
    after.filter((t) => t.selected).map((t) => t.label),
    'the selected tab after ArrowRight',
  ).toEqual(['macOS']);
  expect(
    await page.evaluate(() => (document.activeElement?.textContent ?? '').trim()),
    'the tab holding focus after ArrowRight',
  ).toBe('macOS');

  // At 360 px the three labels fit the column, so the tab list doesn't scroll inside its wrapper.
  await page.setViewportSize({ width: 360, height: 800 });
  const wrapper = await page
    .locator('starlight-tabs .tablist-wrapper')
    .evaluate((w) => ({ scroll: w.scrollWidth, client: w.clientWidth }));
  expect(wrapper.scroll, `at 360 px the tab list is ${wrapper.scroll} px wide in a ${wrapper.client} px wrapper`).toBeLessThanOrEqual(
    wrapper.client,
  );
});
