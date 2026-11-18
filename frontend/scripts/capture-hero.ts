// capture-hero.ts - the README's animated hero, taken from the demo board running in the real embed.
//
// The hero is the demo board (`examples/boards/demo_scene.board.ron`) as the built bundle draws
// it, so this script runs `dist-embed/fabrico-board.js` itself, on a capture page made the way
// `capture-posters.ts` makes its pages, in Playwright's Chromium with the same GL arguments. The
// page loads under reduced motion, so the board sits paused on its boot tick. The script presses
// the board's own Step button to tick FIRST_TICK, then for each frame presses Step TICK_STEP times
// (one press is one tick), waits until the stage has drawn SETTLE_FRAMES more frames, and takes a
// screenshot of the stage at 960 by 600 CSS px. It keeps a frame only when a second screenshot,
// SETTLE_FRAMES drawn frames later, is the same picture, so a dot still easing into place after a
// resize or a jump of several ticks never lands in the hero. That is 95 frames, ticks 79 to 267.
// It waits on ticks and drawn frames, never on wall time, so a slow machine takes the same frames.
// It adds no zoom, pan, fade or overlay: what the stage draws is what the hero shows.
//
// Tick 231 is the one tick the demo's Factory is red (it rejects an order), so that frame shows
// for 800 ms and is also saved as the still for readers who ask for reduced motion. The last frame
// shows for 1500 ms and every other frame for 40 ms, 6020 ms a loop, looping forever.
//
// It encodes the frames as a lossless animated WebP with libwebp's `img2webp` when that is on
// PATH (CI installs Ubuntu's `webp` package), and otherwise with ImageMagick's `magick`. The checks
// on the encoded file read its RIFF chunks in Node (`webp-info.ts`), so they are the same
// whichever tool encoded it.
//
// It writes, under `frontend/dist-hero/` (gitignored):
//   fabrico-hero.webp        the animation
//   fabrico-hero-still.png   the tick 231 frame
//   hero.json                the sidecar: the board's repo-relative path and sha256, the tick
//                            window, the frame count and durations, the still tick, the engine's
//                            tick hash at the last tick, the size, the bytes, the encoder, and one
//                            sha256 per frame over its decoded RGBA pixels
//   frames/f000.png ...      every frame, and capture.html, the capture page
// `scripts/build-site.sh` runs it after `scripts/build-embed.sh`, and `build-site-assets.ts`
// copies the first three files into `site/public/hero/`.
//
// Before it keeps the three files it checks the frames and the encoded file, and exits 1 after
// printing one line per failed check, in the form
//   capture-hero: {check} failed on {file}: {measured}, expected {rule}.
// The checks: every frame and the still are 960 by 600 (size); at least 4 percent of every frame
// differs from the substrate (blank); at least MIN_DISTINCT frames differ by pixel hash (moving);
// at least one frame has item-colour pixels (item); the tick 231 frame and the still have at least
// MIN_FAULT_PX fault-colour pixels (reject); no visible name chip or label words box covers another
// on the stage (overlap); the encoded file reads 960 by 600, loop 0, 95 frames, all lossless, with
// the durations above (encoded); and it is under BYTE_BUDGET bytes (budget). A capture step that
// fails (the board doesn't start, Step doesn't reach a tick, the page throws) also exits 1. It
// exits 2, writing nothing, when the bundle is missing (run scripts/build-embed.sh) or neither
// encoder is on PATH.
//
// OUTPUT on success, exactly one line on stdout:
//   HERO frames=95 distinct=<n> item=<n> fault=<n> fault_px=<n> bytes=<n> encoder=<img2webp|magick> still_tick=231
// item and fault count the frames with item-colour and fault-colour pixels, and fault_px is the
// fault-colour pixel count on the tick 231 frame.
//
// NO PATH INPUT. Every path comes from this file's own location, so it runs the same from the
// repo root and from `frontend/`. Erasure-only TypeScript, so Node runs it as it is.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { buildPage } from './build-offline.ts';
import {
  captureTemplate,
  evaluateWithin,
  GL_ARGS,
  MIN_DRAWN_PERCENT,
  POSTER_HEIGHT,
  POSTER_WIDTH,
  probe,
  stageBox,
  SUBSTRATE,
  waitFor,
} from './capture-posters.ts';
import { readWebpInfo } from './webp-info.ts';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(FRONTEND, '..');
const BUNDLE = path.join(FRONTEND, 'dist-embed', 'fabrico-board.js');
const OUT = path.join(FRONTEND, 'dist-hero');
const FRAMES = path.join(OUT, 'frames');
/** The three files are written here first and moved into OUT only when every check passes. */
const STAGING = path.join(OUT, 'staging');

const BOARD_ID = 'demo_scene';
/** The board file, repo-relative, as the sidecar names it. */
const BOARD_FILE = 'examples/boards/demo_scene.board.ron';

/** The first frame's tick: 9 ticks before the first caption, with the Source's first item on its belt. */
const FIRST_TICK = 79;
/** The last frame's tick: 14 ticks after the rejected order reaches the Rejects sink (tick 253). */
const LAST_TICK = 267;
/** An item moves one belt slot every 2 ticks, so one frame every 2 ticks skips no slot. */
const TICK_STEP = 2;
const FRAME_COUNT = (LAST_TICK - FIRST_TICK) / TICK_STEP + 1;
/** The only tick the demo's Factory is red. Its frame is held and saved as the still. */
const STILL_TICK = 231;
const STILL_INDEX = (STILL_TICK - FIRST_TICK) / TICK_STEP;
const FRAME_MS = 40;
const STILL_HOLD_MS = 800;
const LAST_FRAME_MS = 1500;
/** Drawn frames to wait for after a Step before the screenshot, so the stage shows that tick. */
const SETTLE_FRAMES = 4;
/**
 * Screenshots to try for a picture equal to the one before it. On this machine the second
 * screenshot matched the first on every frame but one: under the load of a full site build, the
 * first frame (after the stage resize and an 11-tick Step) drew the Source belt's item dot with
 * different edge pixels four frames in.
 */
const STABLE_TRIES = 10;

/** The item colour (`#ffb454`) and the fault colour (`#f0506e`), each matched within 8 per channel. */
const ITEM_COLOUR = [0xff, 0xb4, 0x54] as const;
const FAULT_COLOUR = [0xf0, 0x50, 0x6e] as const;
const COLOUR_TOLERANCE = 8;
/** Fault-colour pixels the tick 231 frame and the still need, so a stray edge pixel can't pass. */
const MIN_FAULT_PX = 200;
/** Distinct frames by pixel hash. The prototype measured 95 of 95; this is that minus 10. */
const MIN_DISTINCT = 85;
/**
 * The encoded file's ceiling in bytes: the first measured size times 1.5, rounded up to the next
 * 10,000, under the 3,000,000 cap. Measured 2026-11-18: 170,274 bytes, encoded by ImageMagick
 * 7.1.2 with libwebp 1.6.0 on this machine. CI encodes with img2webp from Ubuntu 24.04's webp
 * package (libwebp 1.3.2); read the HERO line of its first docs run against this number.
 */
const BYTE_BUDGET = 260_000;

const STILL_FILE = 'fabrico-hero-still.png';
const WEBP_FILE = 'fabrico-hero.webp';
const SIDECAR_FILE = 'hero.json';

/** The duration each frame shows for, in ms, in frame order. */
function frameDurations(): number[] {
  return Array.from({ length: FRAME_COUNT }, (_, i) => (i === FRAME_COUNT - 1 ? LAST_FRAME_MS : i === STILL_INDEX ? STILL_HOLD_MS : FRAME_MS));
}

const frameName = (i: number): string => `f${String(i).padStart(3, '0')}.png`;

/** Is `name` an executable file in a PATH folder? */
function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not in this folder
    }
  }
  return false;
}

type Encoder = 'img2webp' | 'magick';

/** The encoder's argument list for the frames in order, with each frame's duration before it. */
function encoderArgs(encoder: Encoder, frames: readonly string[], durations: readonly number[], out: string): string[] {
  if (encoder === 'img2webp') {
    const args = ['-loop', '0', '-lossless'];
    frames.forEach((f, i) => args.push('-d', String(durations[i]), f));
    args.push('-o', out);
    return args;
  }
  // ImageMagick's -delay counts hundredths of a second.
  const args: string[] = [];
  frames.forEach((f, i) => args.push('-delay', String((durations[i] ?? FRAME_MS) / 10), f));
  args.push('-loop', '0', '-define', 'webp:lossless=true', out);
  return args;
}

interface FrameFacts {
  file: string;
  tick: number;
  width: number;
  height: number;
  drawnPercent: number;
  itemPx: number;
  faultPx: number;
  sha256: string;
}

const near = (d: Buffer, i: number, c: readonly number[]): boolean =>
  Math.abs(d[i] - c[0]) <= COLOUR_TOLERANCE && Math.abs(d[i + 1] - c[1]) <= COLOUR_TOLERANCE && Math.abs(d[i + 2] - c[2]) <= COLOUR_TOLERANCE;

/** Size, drawn share, item and fault pixel counts and the pixel hash of one PNG. */
function measure(file: string, tick: number, png: Buffer): FrameFacts {
  const img = PNG.sync.read(png);
  const d = img.data;
  let drawn = 0;
  let itemPx = 0;
  let faultPx = 0;
  for (let i = 0; i < d.length; i += 4) {
    const off = Math.abs(d[i] - SUBSTRATE[0]) + Math.abs(d[i + 1] - SUBSTRATE[1]) + Math.abs(d[i + 2] - SUBSTRATE[2]);
    if (off > 24) drawn += 1;
    if (near(d, i, ITEM_COLOUR)) itemPx += 1;
    if (near(d, i, FAULT_COLOUR)) faultPx += 1;
  }
  return {
    file,
    tick,
    width: img.width,
    height: img.height,
    drawnPercent: (drawn / Math.max(1, img.width * img.height)) * 100,
    itemPx,
    faultPx,
    sha256: createHash('sha256').update(d).digest('hex'),
  };
}

/** Press the board's Step button `presses` times and return the tick it shows after. */
const pressStep = (page: Page, presses: number): Promise<number> =>
  evaluateWithin(
    page,
    `press Step ${presses} times`,
    (n: number) => {
      const el = document.querySelector('fabrico-board') as unknown as HTMLElement & { fabricoProbe(): { tick: number } };
      const button = (el.shadowRoot as ShadowRoot).querySelector('button[data-control="step"]') as HTMLButtonElement;
      for (let i = 0; i < n; i++) button.click();
      return el.fabricoProbe().tick;
    },
    presses,
  );

/** Wait until the stage has drawn SETTLE_FRAMES more frames than it had when called. */
async function settle(page: Page, tick: number): Promise<void> {
  const start = (await probe(page)).frames;
  await waitFor(`tick ${tick}: the stage draws ${SETTLE_FRAMES} more frames`, () => probe(page), (p) => p.frames >= start + SETTLE_FRAMES, 30_000);
}

/**
 * The stage's picture at `tick`, once it has stopped changing: after each SETTLE_FRAMES drawn
 * frames take a screenshot, and return it when it equals the one before.
 */
async function settledShot(page: Page, tick: number): Promise<Buffer> {
  await settle(page, tick);
  let last = await page.screenshot({ clip: await stageBox(page), animations: 'allow' });
  for (let n = 0; n < STABLE_TRIES; n++) {
    await settle(page, tick);
    const next = await page.screenshot({ clip: await stageBox(page), animations: 'allow' });
    if (next.equals(last)) return next;
    last = next;
  }
  throw new Error(`tick ${tick}: the stage still changed after ${STABLE_TRIES + 1} screenshots, ${SETTLE_FRAMES} drawn frames apart`);
}

interface OverlapRead {
  chips: number;
  words: number;
  pairs: string[];
}

/**
 * Every visible `div.chip` and `div.words` box with positive area in the board's shadow root,
 * compared pairwise. The rule is the one `e2e-embed/overlap.spec.ts` holds the demo to.
 */
const readOverlap = (page: Page): Promise<OverlapRead> =>
  evaluateWithin(
    page,
    'read the chip and label boxes',
    () => {
      const root = (document.querySelector('fabrico-board') as HTMLElement).shadowRoot as ShadowRoot;
      const boxes: { kind: string; text: string; l: number; t: number; r: number; b: number }[] = [];
      for (const el of root.querySelectorAll('div.chip, div.words')) {
        if (getComputedStyle(el).visibility !== 'visible') continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        boxes.push({ kind: el.classList.contains('chip') ? 'chip' : 'words', text: el.textContent ?? '', l: r.left, t: r.top, r: r.right, b: r.bottom });
      }
      const pairs: string[] = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
          const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
          if (w > 0 && h > 0) pairs.push(`${a.kind} "${a.text}" covers ${b.kind} "${b.text}" by ${w.toFixed(1)} x ${h.toFixed(1)} px`);
        }
      }
      return { chips: boxes.filter((b) => b.kind === 'chip').length, words: boxes.filter((b) => b.kind === 'words').length, pairs };
    },
    undefined,
  );

interface Capture {
  frames: FrameFacts[];
  overlap: OverlapRead;
  lastTickHash: string | null;
}

async function capture(page: Page, url: string): Promise<Capture> {
  await page.goto(url);
  await waitFor('the board starts', () => probe(page), (p) => p.state === 'running' && p.mounted, 30_000);

  // The frame's padding sits around the stage; widen the wrapper so the stage itself is 960 wide.
  const first = await stageBox(page);
  await evaluateWithin(
    page,
    'widen the wrapper',
    (w: number) => {
      (document.getElementById('wrap') as HTMLElement).style.width = `${w}px`;
    },
    POSTER_WIDTH + (POSTER_WIDTH - first.width),
  );
  await waitFor('the stage is 960 wide', () => stageBox(page), (b) => Math.abs(b.width - POSTER_WIDTH) <= 0.5, 10_000);
  // Let the renderer take the new size (camera fit, dot texture) before the board moves.
  await settle(page, (await probe(page)).tick);

  const boot = await probe(page);
  if (boot.tick > FIRST_TICK) throw new Error(`the board sits on tick ${boot.tick}, past the first frame's tick ${FIRST_TICK}`);
  let tick = await pressStep(page, FIRST_TICK - boot.tick);
  if (tick !== FIRST_TICK) throw new Error(`Step reached tick ${tick}, not ${FIRST_TICK}`);

  const frames: FrameFacts[] = [];
  let overlap: OverlapRead = { chips: 0, words: 0, pairs: [] };
  for (let i = 0; i < FRAME_COUNT; i++) {
    const want = FIRST_TICK + i * TICK_STEP;
    if (i > 0) {
      tick = await pressStep(page, TICK_STEP);
      if (tick !== want) throw new Error(`Step reached tick ${tick}, not ${want}`);
    }
    const png = await settledShot(page, tick);
    if (i === 0) overlap = await readOverlap(page);
    const name = frameName(i);
    writeFileSync(path.join(FRAMES, name), png);
    frames.push(measure(`frames/${name}`, tick, png));
  }
  const hashes = await evaluateWithin(
    page,
    'read the tick hashes',
    () => (document.querySelector('fabrico-board') as unknown as { fabricoTickHashes(): [number, string][] }).fabricoTickHashes(),
    undefined,
  );
  const last = hashes.find(([t]) => t === LAST_TICK);
  return { frames, overlap, lastTickHash: last === undefined ? null : last[1] };
}

const fail = (check: string, file: string, measured: string, rule: string): string =>
  `capture-hero: ${check} failed on ${file}: ${measured}, expected ${rule}.`;

/** Every frame check, as failure lines. */
function frameChecks(frames: readonly FrameFacts[], still: FrameFacts): string[] {
  const out: string[] = [];
  for (const f of [...frames, still]) {
    if (f.width !== POSTER_WIDTH || f.height !== POSTER_HEIGHT) {
      out.push(fail('size', f.file, `${f.width} by ${f.height} px`, `${POSTER_WIDTH} by ${POSTER_HEIGHT}`));
    }
  }
  for (const f of frames) {
    if (f.drawnPercent < MIN_DRAWN_PERCENT) {
      out.push(fail('blank', f.file, `${f.drawnPercent.toFixed(1)} percent differs from the substrate #1b1f27`, `at least ${MIN_DRAWN_PERCENT} percent`));
    }
  }
  const distinct = new Set(frames.map((f) => f.sha256)).size;
  if (distinct < MIN_DISTINCT) out.push(fail('moving', 'frames/', `${distinct} distinct frames of ${frames.length}`, `at least ${MIN_DISTINCT}`));
  const itemFrames = frames.filter((f) => f.itemPx > 0).length;
  if (itemFrames === 0) out.push(fail('item', 'frames/', '0 frames with #ffb454 pixels', 'at least 1'));
  const stillFrame = frames[STILL_INDEX];
  for (const f of [stillFrame, still]) {
    if (f === undefined) continue;
    if (f.faultPx < MIN_FAULT_PX) out.push(fail('reject', f.file, `${f.faultPx} pixels of #f0506e at tick ${STILL_TICK}`, `at least ${MIN_FAULT_PX}`));
  }
  return out;
}

/** The checks on the encoded file, read from its RIFF chunks. */
function encodedChecks(webp: Buffer): string[] {
  const out: string[] = [];
  let info;
  try {
    info = readWebpInfo(webp);
  } catch (error) {
    return [fail('encoded', WEBP_FILE, error instanceof Error ? error.message : String(error), 'a whole RIFF WEBP file')];
  }
  if (info.width !== POSTER_WIDTH || info.height !== POSTER_HEIGHT) {
    out.push(fail('encoded', WEBP_FILE, `a ${info.width} by ${info.height} canvas`, `${POSTER_WIDTH} by ${POSTER_HEIGHT}`));
  }
  if (info.loop !== 0) out.push(fail('encoded', WEBP_FILE, `loop count ${info.loop ?? 'missing'}`, '0 (forever)'));
  if (info.frames.length !== FRAME_COUNT) out.push(fail('encoded', WEBP_FILE, `${info.frames.length} animation frames`, String(FRAME_COUNT)));
  const lossy = info.frames.filter((f) => f.sub !== 'VP8L').length;
  if (lossy > 0) out.push(fail('encoded', WEBP_FILE, `${lossy} frames not lossless (VP8L)`, '0'));
  const got = info.frames.map((f) => f.durationMs).join(',');
  const want = frameDurations().join(',');
  if (got !== want) {
    const count = (list: number[]): string => {
      const c = new Map<number, number>();
      for (const ms of list) c.set(ms, (c.get(ms) ?? 0) + 1);
      return [...c].map(([ms, n]) => `${n} x ${ms} ms`).join(', ');
    };
    out.push(fail('encoded', WEBP_FILE, `durations ${count(info.frames.map((f) => f.durationMs))}`, `${count(frameDurations())}, the ${STILL_HOLD_MS} ms frame at index ${STILL_INDEX}`));
  }
  if (webp.length >= BYTE_BUDGET) out.push(fail('budget', WEBP_FILE, `${webp.length} bytes`, `under ${BYTE_BUDGET}`));
  return out;
}

async function main(): Promise<void> {
  if (!existsSync(BUNDLE)) {
    console.error(`capture-hero: no bundle at ${path.relative(REPO, BUNDLE)}. Run scripts/build-embed.sh first.`);
    process.exit(2);
  }
  const encoder: Encoder | null = onPath('img2webp') ? 'img2webp' : onPath('magick') ? 'magick' : null;
  if (encoder === null) {
    console.error('capture-hero: neither img2webp (Debian and Ubuntu package webp) nor magick (ImageMagick 7) is on PATH.');
    process.exit(2);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  mkdirSync(STAGING, { recursive: true });
  const page = path.join(OUT, 'capture.html');
  writeFileSync(page, buildPage(captureTemplate(BOARD_ID), readFileSync(BUNDLE, 'utf8'), 'capture.html'));

  const failures: string[] = [];
  let shot: Capture | null = null;
  const browser = await chromium.launch({ args: GL_ARGS });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    // The clock records each tick's hash, so the sidecar can name the engine's hash at the last tick.
    await context.addInitScript(() => {
      (globalThis as { __FABRICO_EMBED_TRACE__?: boolean }).__FABRICO_EMBED_TRACE__ = true;
    });
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    try {
      shot = await capture(tab, pathToFileURL(page).href);
      if (errors.length > 0) failures.push(`capture-hero: capture failed: the page threw: ${errors.join('; ')}`);
    } catch (error) {
      failures.push(`capture-hero: capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await browser.close();
  }
  if (shot === null) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }

  const { frames, overlap, lastTickHash } = shot;
  const stillSource = frames[STILL_INDEX];
  const stillPath = path.join(STAGING, STILL_FILE);
  if (stillSource !== undefined) copyFileSync(path.join(OUT, stillSource.file), stillPath);
  const still = existsSync(stillPath)
    ? measure(STILL_FILE, STILL_TICK, readFileSync(stillPath))
    : { file: STILL_FILE, tick: STILL_TICK, width: 0, height: 0, drawnPercent: 0, itemPx: 0, faultPx: 0, sha256: '' };
  failures.push(...frameChecks(frames, still));

  if (overlap.chips === 0 || overlap.words === 0) {
    failures.push(fail('overlap', `stage at tick ${FIRST_TICK}`, `${overlap.chips} visible name chips and ${overlap.words} label words boxes`, 'at least 1 of each, so the read has boxes to compare'));
  }
  for (const pair of overlap.pairs) failures.push(fail('overlap', `stage at tick ${FIRST_TICK}`, pair, 'no chip or label words box covering another'));
  if (lastTickHash === null) failures.push(`capture-hero: capture failed: the trace holds no hash for tick ${LAST_TICK}`);

  const webpPath = path.join(STAGING, WEBP_FILE);
  const durations = frameDurations();
  const frameFiles = frames.map((f) => path.join(OUT, f.file));
  let webp: Buffer | null = null;
  try {
    execFileSync(encoder, encoderArgs(encoder, frameFiles, durations, webpPath), { stdio: ['ignore', 'ignore', 'pipe'] });
    webp = readFileSync(webpPath);
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    failures.push(fail('encoded', WEBP_FILE, `${encoder} failed: ${stderr || (error instanceof Error ? error.message : String(error))}`, 'an encoded file'));
  }
  if (webp !== null) failures.push(...encodedChecks(webp));

  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }

  const bytes = statSync(webpPath).size;
  const sidecar = {
    board: BOARD_FILE,
    board_sha256: createHash('sha256').update(readFileSync(path.join(REPO, BOARD_FILE))).digest('hex'),
    first_tick: FIRST_TICK,
    last_tick: LAST_TICK,
    tick_step: TICK_STEP,
    frames: FRAME_COUNT,
    frame_ms: durations,
    still_tick: STILL_TICK,
    last_tick_hash: lastTickHash,
    width: POSTER_WIDTH,
    height: POSTER_HEIGHT,
    bytes,
    encoder,
    frame_sha256_of: 'each frame as decoded RGBA pixels',
    frame_sha256: frames.map((f) => f.sha256),
  };
  writeFileSync(path.join(STAGING, SIDECAR_FILE), `${JSON.stringify(sidecar, null, 2)}\n`);
  for (const name of [WEBP_FILE, STILL_FILE, SIDECAR_FILE]) copyFileSync(path.join(STAGING, name), path.join(OUT, name));
  rmSync(STAGING, { recursive: true, force: true });

  const distinct = new Set(frames.map((f) => f.sha256)).size;
  const itemFrames = frames.filter((f) => f.itemPx > 0).length;
  const faultFrames = frames.filter((f) => f.faultPx > 0).length;
  console.log(
    `HERO frames=${frames.length} distinct=${distinct} item=${itemFrames} fault=${faultFrames} fault_px=${stillSource?.faultPx ?? 0} ` +
      `bytes=${bytes} encoder=${encoder} still_tick=${STILL_TICK}`,
  );
}

await main();
