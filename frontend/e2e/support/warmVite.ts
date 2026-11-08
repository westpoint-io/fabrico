import { chromium, type FullConfig } from '@playwright/test';

// warmVite.ts - the mock suite's globalSetup: load the app once before any test starts.
//
// The config's webServer probe waits only for index.html, which Vite serves before it has
// compiled a single module. Vite compiles the app on the first page load, so without this the
// first test on each worker pays for that compile inside its own 30 s budget, with no retry
// behind it. On CI each shard boots its own Vite, so every shard paid it, and the first test of
// one shard timed out.
//
// Playwright runs globalSetup after the webServer is up and before any worker starts, so this
// one load compiles the app for every test. It waits for the palette's Source button, the same
// element the specs' `waitForChrome` waits for. The render socket is answered by an empty mock,
// as the specs answer it, so nothing here reaches for a host. A page that never renders fails the
// run here, by name, instead of failing whichever test came first.

/** The longest the first load may take: Vite's whole compile on a cold, slow runner. */
const WARM_TIMEOUT_MS = 120_000;

export default async function warmVite(config: FullConfig): Promise<void> {
  const use = config.projects[0]?.use;
  const baseURL = use?.baseURL;
  if (!baseURL) throw new Error('warmVite: the Playwright config names no baseURL');
  const started = Date.now();
  const browser = await chromium.launch({ args: use?.launchOptions?.args ?? [] });
  try {
    const page = await browser.newPage();
    await page.routeWebSocket(/\/render$/, () => {});
    await page.goto(baseURL, { timeout: WARM_TIMEOUT_MS });
    await page.getByRole('button', { name: /Source/ }).waitFor({ timeout: WARM_TIMEOUT_MS });
  } finally {
    await browser.close();
  }
  const ms = Date.now() - started;
  console.log(`warmVite: the app rendered its palette ${ms} ms after the first request`);
}
