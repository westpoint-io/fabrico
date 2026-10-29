// perf-capture.ts - GATE-05 report-first performance measurement harness.
//
// This is a MEASUREMENT, not a gate. It deliberately lives under scripts/ (NOT
// under e2e/ or e2e-live/) so neither `test:e2e` nor `e2e:live` ever picks it up:
// slow-CI frame pacing must never redden a gate. Run it via `npm run perf:capture`.
//
// It re-runs the Phase 23 baseline.md method VERBATIM (headless Playwright
// chromium from frontend/node_modules, http://127.0.0.1:5173 via `npm run dev`,
// viewport 1600x1000, deviceScaleFactor 1, window.__fabrico.frameTime() read
// after a ~5s settle) for TWO scenes and captures three signals:
//
//   1. Empty-default frame-time  - the apples-to-apples heartbeat. Captured with
//      NO dev host on 8787, so the dev WebSocket fails quiet and the shipped
//      default scene stays empty (machineCount 0), EXACTLY as baseline.md
//      captured it. Averaged over two runs to damp frame-pacing variance.
//   2. Load-Demo frame-time      - the honest dense-draw signal. Captured WITH
//      the dev_render_server host running on 8787 so the demo scene streams; the
//      shipped Load-demo CTA is clicked and we poll the scene to 6 settled nodes.
//   3. Per-frame draw-calls + JS bundle raw bytes.
//
// Draw-calls are counted by wrapping the WebGL2 draw entrypoints via
// addInitScript (28-RESEARCH Pattern 5) - a HARNESS-TIER browser-context wrap,
// never an app-code change (threat T-28-06). It reads render output, the build
// output, and the existing frameTime hook; it never mutates sim state and never
// accepts external input (threat T-28-07: report-first, exits 0).
//
// The regression check is REPORTED, not enforced: empty-default frame-time is
// FLAGged if > 1.2x baseline (~22.3ms over 18.6ms) and JS raw is FLAGged if
// > 1.1x baseline (>812,684 B over 738,804 B). A FLAG is a human-reviewed signal;
// the harness exits 0 regardless. Atlas/culling (FUT-02) is a SEPARATE future
// decision and is never triggered here.

import { chromium, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';

// --- Fixed capture parameters (baseline.md-identical) ----------------------
const VIEWPORT = { width: 1600, height: 1000 };
const DEVICE_SCALE_FACTOR = 1;
const SETTLE_MS = 5_000; // fill the frameProbe 120-frame ring (~2s) + margin
const EMPTY_RUNS = 2; // baseline.md averaged two runs

const FRONTEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(FRONTEND_DIR, '..');
const VITE_HOST = '127.0.0.1';
const VITE_PORT = 5173;
const VITE_URL = `http://${VITE_HOST}:${VITE_PORT}`;
const RENDER_HOST_PORT = 8787;
const HOST_BIN = join(REPO_ROOT, 'target', 'debug', 'examples', 'dev_render_server');

// --- Phase 23 baseline + regression thresholds -----------------------------
const BASELINE_FRAME_MS = 18.6; // two-run rolling average, empty default scene
const BASELINE_JS_BYTES = 738_804; // sum of dist/assets/*.js raw bytes
const FRAME_FLAG_MS = BASELINE_FRAME_MS * 1.2; // ~22.32ms
const JS_FLAG_BYTES = Math.round(BASELINE_JS_BYTES * 1.1); // 812,684 B
const DEMO_NODE_COUNT = 6; // the shipped demo topology (mirrors the live specs)

// The WebGL2 draw-call counter wrap, injected before app scripts load. Confined
// to the harness browser context; never shipped in app code (T-28-06).
const DRAW_WRAP = `
(() => {
  const w = window;
  w.__perfDrawCalls = 0;
  // Wrap-active flag: stays false on a non-WebGL2 backend (WebGPU / WebGL1) so the
  // report can distinguish "0 draws measured" from "counter never installed" (WR-03).
  w.__perfDrawWrapActive = false;
  const proto = typeof WebGL2RenderingContext !== 'undefined'
    ? WebGL2RenderingContext.prototype
    : null;
  if (!proto) return;
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    proto[name] = function (...args) {
      w.__perfDrawCalls++;
      return orig.apply(this, args);
    };
  }
  w.__perfDrawWrapActive = true;
})();
`;

// --- Small process/port helpers --------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve once a TCP connect to host:port succeeds, or reject after timeout. */
async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((res) => {
      const sock = net.connect({ host, port }, () => {
        sock.end();
        res(true);
      });
      sock.on('error', () => res(false));
      sock.setTimeout(1_000, () => {
        sock.destroy();
        res(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${host}:${port} after ${timeoutMs}ms`);
    }
    await sleep(300);
  }
}

async function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect({ host, port }, () => {
      sock.end();
      res(true);
    });
    sock.on('error', () => res(false));
    sock.setTimeout(500, () => {
      sock.destroy();
      res(false);
    });
  });
}

/** Kill a detached child and its process group so no listener orphans. */
function killGroup(child: ChildProcess | null): void {
  if (!child || child.pid == null || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

// --- Server lifecycle -------------------------------------------------------

/** Spawn the Vite dev server on 5173 (strictPort so an occupied port fails loudly). */
async function startVite(): Promise<ChildProcess> {
  if (await portInUse(VITE_HOST, VITE_PORT)) {
    throw new Error(
      `port ${VITE_PORT} is already in use - free it before running perf:capture (the harness owns the dev server lifecycle)`,
    );
  }
  const child = spawn(
    'npm',
    ['run', 'dev', '--', '--host', VITE_HOST, '--port', String(VITE_PORT), '--strictPort'],
    { cwd: FRONTEND_DIR, detached: true, stdio: 'ignore' },
  );
  await waitForPort(VITE_HOST, VITE_PORT, 120_000);
  return child;
}

/** Spawn the pre-built dev_render_server host on 8787 (Load-Demo dense-draw signal). */
async function startHost(): Promise<ChildProcess> {
  if (!existsSync(HOST_BIN)) {
    throw new Error(
      `dev_render_server binary missing at ${HOST_BIN} - build it first: cargo build -p fabrico-host --example dev_render_server`,
    );
  }
  if (await portInUse(VITE_HOST, RENDER_HOST_PORT)) {
    throw new Error(`port ${RENDER_HOST_PORT} is already in use - free it before running perf:capture`);
  }
  const child = spawn(HOST_BIN, [], { cwd: REPO_ROOT, detached: true, stdio: 'ignore' });
  await waitForPort(VITE_HOST, RENDER_HOST_PORT, 60_000);
  return child;
}

// --- Browser measurement ----------------------------------------------------

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  const page = await context.newPage();
  await page.addInitScript(DRAW_WRAP); // wrap GL draws BEFORE any app script runs
  return page;
}

/** Read the app's rolling frame-time average (never a hand-rolled timer). */
async function readFrameTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { frameTime(): number } }).__fabrico;
    if (!hook) throw new Error('window.__fabrico not installed');
    return hook.frameTime();
  });
}

/** Draw-calls issued across exactly one rendered frame (diff between two rAFs). */
async function drawCallsPerFrame(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((res) => {
        const w = window as unknown as { __perfDrawCalls: number };
        requestAnimationFrame(() => {
          const before = w.__perfDrawCalls;
          requestAnimationFrame(() => {
            res(w.__perfDrawCalls - before);
          });
        });
      }),
  );
}

/** Whether the WebGL2 draw-call wrap actually installed (false on WebGPU / WebGL1). */
async function readDrawWrapActive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as { __perfDrawWrapActive?: boolean };
    return w.__perfDrawWrapActive === true;
  });
}

/** Poll the scene oracle until a predicate holds (deterministic, no fixed sleeps). */
async function pollScene(
  page: Page,
  pred: (s: { tick: number; nodes: unknown[] }) => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page.evaluate((): { tick: number; count: number } | null => {
      const hook = (window as unknown as { __fabrico?: { scene(): { tick: number; nodes: unknown[] } } })
        .__fabrico;
      if (!hook) return null;
      const s = hook.scene();
      return { tick: s.tick, count: s.nodes.length };
    });
    if (ok && pred({ tick: ok.tick, nodes: new Array(ok.count) })) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await sleep(200);
  }
}

interface SceneMeasurement {
  frameTimeMs: number;
  drawCallsPerFrame: number;
  drawWrapActive: boolean;
}

/** Empty-default: NO host on 8787 => empty scene, exactly like baseline.md. */
async function measureEmptyDefault(browser: Browser): Promise<SceneMeasurement> {
  const page = await newPage(browser);
  try {
    await page.goto(VITE_URL, { waitUntil: 'load' });
    // Chrome rendered (palette drag source visible). The scene tick stays 0 with
    // no host, so we wait on chrome readiness only - the render loop still runs.
    await page
      .getByRole('button', { name: 'Place Factory' })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await sleep(SETTLE_MS); // fill the frameProbe ring
    const frameTimeMs = await readFrameTime(page);
    const dc = await drawCallsPerFrame(page);
    const drawWrapActive = await readDrawWrapActive(page);
    return { frameTimeMs, drawCallsPerFrame: dc, drawWrapActive };
  } finally {
    await page.context().close();
  }
}

/** Load-Demo: host running => click the shipped CTA, settle to the demo topology. */
async function measureLoadDemo(browser: Browser): Promise<SceneMeasurement> {
  const page = await newPage(browser);
  try {
    await page.goto(VITE_URL, { waitUntil: 'load' });
    await page
      .getByRole('button', { name: 'Place Factory' })
      .waitFor({ state: 'visible', timeout: 30_000 });
    // Real WS connected: the demo streams and the tick advances past 0.
    await pollScene(page, (s) => s.tick > 0, 30_000, 'real WS connected (scene tick advances past 0)');
    // Click the shipped Load-demo CTA (a genesis swap), then settle to 6 nodes.
    // 55-02 relocated the CTA behind the `Examples` disclosure: open it first, then
    // click the entry (the title moved onto it VERBATIM).
    await page.getByRole('button', { name: 'Examples' }).click();
    await page.getByTitle('Load the demo scene and watch the engine run').click();
    await pollScene(
      page,
      (s) => s.nodes.length === DEMO_NODE_COUNT,
      30_000,
      `the Load-demo scene settled to the ${DEMO_NODE_COUNT}-node demo topology`,
    );
    await sleep(SETTLE_MS);
    const frameTimeMs = await readFrameTime(page);
    const dc = await drawCallsPerFrame(page);
    const drawWrapActive = await readDrawWrapActive(page);
    return { frameTimeMs, drawCallsPerFrame: dc, drawWrapActive };
  } finally {
    await page.context().close();
  }
}

// --- Bundle size ------------------------------------------------------------

interface BundleMeasurement {
  jsRawBytes: number;
  jsFiles: { name: string; bytes: number }[];
}

/** `npm run build` then sum raw bytes of every dist/assets/*.js (baseline method). */
async function measureBundle(): Promise<BundleMeasurement> {
  const build = spawnSync('npm', ['run', 'build'], { cwd: FRONTEND_DIR, stdio: 'inherit' });
  if (build.status !== 0) throw new Error(`npm run build failed (exit ${build.status})`);
  const assetsDir = join(FRONTEND_DIR, 'dist', 'assets');
  const entries = await readdir(assetsDir);
  const jsFiles: { name: string; bytes: number }[] = [];
  let jsRawBytes = 0;
  for (const name of entries) {
    if (!name.endsWith('.js')) continue;
    const bytes = (await stat(join(assetsDir, name))).size;
    jsFiles.push({ name, bytes });
    jsRawBytes += bytes;
  }
  jsFiles.sort((a, b) => b.bytes - a.bytes);
  return { jsRawBytes, jsFiles };
}

// --- Report -----------------------------------------------------------------

function fmtMs(n: number): string {
  return `${n.toFixed(3)}ms`;
}

async function main(): Promise<void> {
  const buildInfo = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const commit = (buildInfo.stdout ?? '').trim() || 'unknown';

  const browser = await chromium.launch();
  let vite: ChildProcess | null = null;
  let host: ChildProcess | null = null;

  const emptyRuns: SceneMeasurement[] = [];
  let loadDemo: SceneMeasurement | null = null;
  let bundle: BundleMeasurement | null = null;

  try {
    // --- Empty-default (NO host): baseline apples-to-apples, averaged over 2 runs.
    vite = await startVite();
    for (let i = 0; i < EMPTY_RUNS; i++) {
      emptyRuns.push(await measureEmptyDefault(browser));
    }

    // --- Load-Demo (host up): populated dense-draw signal.
    host = await startHost();
    // Give the browser a fresh page against the now-connected host.
    loadDemo = await measureLoadDemo(browser);

    // --- Bundle size.
    bundle = await measureBundle();
  } finally {
    await browser.close();
    killGroup(host);
    killGroup(vite);
  }

  const emptyAvg = emptyRuns.reduce((s, r) => s + r.frameTimeMs, 0) / emptyRuns.length;
  const emptyDrawAvg = Math.round(
    emptyRuns.reduce((s, r) => s + r.drawCallsPerFrame, 0) / emptyRuns.length,
  );
  const frameFlag = emptyAvg > FRAME_FLAG_MS;
  const jsFlag = (bundle?.jsRawBytes ?? 0) > JS_FLAG_BYTES;
  // WR-03: a non-WebGL2 backend leaves the wrap uninstalled -> draws read 0 with no
  // real signal. Report that explicitly instead of a misleading bare 0.
  const emptyDrawWrapActive = emptyRuns.every((r) => r.drawWrapActive);
  const drawWrapNote = ' [draw-call wrap INACTIVE - non-WebGL2 backend?]';

  // Structured, reproducible report.
  const report = {
    commit,
    method: 'baseline.md-identical: headless chromium, http://127.0.0.1:5173 (npm run dev), viewport 1600x1000, DPR 1, frameTime() after ~5s',
    baseline: { frameMs: BASELINE_FRAME_MS, jsBytes: BASELINE_JS_BYTES },
    thresholds: { frameFlagMs: FRAME_FLAG_MS, jsFlagBytes: JS_FLAG_BYTES },
    emptyDefault: {
      runs: emptyRuns.map((r) => r.frameTimeMs),
      frameTimeMsAvg: emptyAvg,
      drawCallsPerFrame: emptyDrawAvg,
      drawWrapActive: emptyDrawWrapActive,
      flag: frameFlag,
    },
    loadDemo: {
      frameTimeMs: loadDemo?.frameTimeMs ?? null,
      drawCallsPerFrame: loadDemo?.drawCallsPerFrame ?? null,
      drawWrapActive: loadDemo?.drawWrapActive ?? null,
    },
    bundle: {
      jsRawBytes: bundle?.jsRawBytes ?? null,
      flag: jsFlag,
      jsFiles: bundle?.jsFiles ?? [],
    },
  };

  console.log('\n===== GATE-05 PERF CAPTURE =====');
  console.log(JSON.stringify(report, null, 2));
  console.log('\n----- human summary -----');
  console.log(`commit                : ${commit}`);
  console.log(
    `empty-default frame   : ${fmtMs(emptyAvg)} (runs ${emptyRuns
      .map((r) => fmtMs(r.frameTimeMs))
      .join(', ')}) vs baseline ${fmtMs(BASELINE_FRAME_MS)}  [${
      frameFlag ? 'FLAG > 1.2x' : 'PASS <= 1.2x'
    }]`,
  );
  console.log(
    `empty-default draws/f : ${emptyDrawAvg}${emptyDrawWrapActive ? '' : drawWrapNote} (report-only)`,
  );
  console.log(`load-demo frame       : ${fmtMs(loadDemo?.frameTimeMs ?? NaN)} (report-only, dense-draw baseline)`);
  console.log(
    `load-demo draws/f     : ${loadDemo?.drawCallsPerFrame ?? 'n/a'}${
      loadDemo && !loadDemo.drawWrapActive ? drawWrapNote : ''
    } (report-only)`,
  );
  console.log(
    `JS bundle raw bytes   : ${bundle?.jsRawBytes ?? 'n/a'} B vs baseline ${BASELINE_JS_BYTES} B  [${
      jsFlag ? 'FLAG > 1.1x' : 'PASS <= 1.1x'
    }]`,
  );
  console.log(
    `verdict               : ${
      frameFlag || jsFlag
        ? 'FLAG raised - surface to phase verification (FUT-02 atlas/culling remains a SEPARATE future decision)'
        : 'parity-or-improvement PASS - atlas/culling (FUT-02) NOT triggered'
    }`,
  );
  console.log('=================================\n');

  // Report-first: always exit 0. A FLAG is a human-reviewed signal, never an
  // auto-failing CI gate (T-28-07).
  process.exit(0);
}

main().catch((err) => {
  console.error('perf:capture failed:', err);
  process.exit(1);
});
