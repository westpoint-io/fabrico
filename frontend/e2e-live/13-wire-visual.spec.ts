import { test, expect } from '@playwright/test';
import {
  ENDPOINT_URL_SHAPE,
  demoCallerAndHandler,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  resetToDemo,
  waitForAppReady,
  watchPageErrors,
  webhookUrl,
} from './support/oracle';

// 13-wire-visual.spec.ts (WUI-01) — the LIVE wire-visual gate (the v5.0/Phase-10
// live-oracle lesson, MANDATORY): drive the REAL app + real Core over the dev WS and
// prove the request/response WIRE reads distinct from the belts, INCLUDING the reply
// travelling home, on the live canvas.
//
// ────────────────────────────────────────────────────────────────────────────
// The demo ships a FUNCTIONAL request/response pair:
//   Route(caller) --forward wire--> HTTP Handler --return wire--> Route(caller)
// DORMANT on load (no timer drives it). The pair is found by WHAT IT IS
// (`demoCallerAndHandler`, plan 85-07), never by a cell or a path, and a REAL loopback
// POST to the caller's own URL mints
// a WireRequest: the request hops the forward wire (the cyan spark), the handler replies,
// and the reply reverse-transports on the return wire (the AMBER reply-home comet — the
// explicit WUI-01 "reply travelling home" distinct read). This gate drives that REAL
// hop (not an injected packet) and observes the reply-home pulse on the live wire.
//
// # Why the latch, not a pixel scrape
// A wire hop is >= 1 tick (WIRE_HOP_TICKS), so the on-cable pulse lives for a ~1-tick
// window — far too transient to scrape a single amber pixel deterministically (which
// would violate the live suite's deterministic-polling discipline). Instead the app
// exposes a READ-ONLY reply-home LATCH (`replyPulsesObserved`): every per-tick diff is
// applied, and a wire re-emits every tick it carries a pulse, so the latch reliably
// catches the reply-home hop that the wires.ts layer draws as the amber comet (the
// layer's amber-comet-vs-cyan-spark render is proven GPU-free in wires.test.ts). The
// live gate here proves the REAL hop feeds that render path end-to-end. Chromium only
// (WebKit/tauri-driver unavailable on some Linux hosts); PNG regen needs CI=1.
// ────────────────────────────────────────────────────────────────────────────

const KIND_ENDPOINT = 9;
const KIND_HANDLER = 10;

test.describe('WUI-01 live: the request/response wire reads distinct, and the reply travels home', () => {
  // RENDER HEALTH (plan 85-07, the model-oracle blind spot). Every assertion below reads
  // `window.__fabrico.scene()`, which is fed by the packet path and keeps answering over a
  // dead Pixi ticker, so the renderer is asserted alive after EVERY test. The watcher is
  // installed BEFORE `page.goto` so an error raised during load is caught too.
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    // Shared-host isolation: a prior spec may have left the sim Frozen or mutated,
    // which would hang this spec's real endpoint POST. A genesis swap (LoadDemo, which
    // now resumes - CR-01) restores a fresh, FLOWING core with the demo's dormant
    // request/response cables and a live endpoint route.
    await resetToDemo(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the wire-visual test');
    errs.assertNone('the wire-visual test');
  });

  test('the demo ships a DORMANT electrical wire (the belt-vs-wire "wires rest" contrast)', async ({
    page,
  }) => {
    const s = await readScene(page);
    // The belts are alive (the demo source pumps items) — but the wires REST: two
    // cables (forward + return) present, both with an EMPTY pulse set, and no reply
    // has travelled home. This is THE primary belt-vs-wire read, live.
    expect(s.wires.length, 'the demo ships the forward + return request/response wires').toBe(2);
    expect(
      s.wires.every((w) => w.pulses.length === 0),
      'the wires are dormant on load (0 fps, active-set only — belts march, wires rest)',
    ).toBe(true);
    expect(s.replyPulsesObserved, 'no reply has travelled home on an idle load').toBe(0);
    // Each wire has a real routed cable path (geometry present, so the layer draws a
    // visible dormant cable — not a zero-length degenerate).
    expect(s.wires.every((w) => w.tiles >= 2), 'each cable has a routed multi-tile path').toBe(
      true,
    );
  });

  test('a REAL POST energizes the wire and the AMBER reply-home comet travels home', async ({
    page,
  }) => {
    // (1) Dormant baseline: capture the reply-home latch BEFORE driving anything.
    const before = await readScene(page);
    expect(before.replyPulsesObserved, 'reply-home latch starts at 0 (dormant)').toBe(0);

    // (2) Find the demo pair BY KIND (the caller is the board's Route, the handler is where
    // its cable delivers) and resolve the caller's REAL loopback POST URL via the
    // read-only webhook_url bridge — the SAME host-formatted URL the shipped app uses,
    // whatever path the demo configures.
    const { caller, handler, callerUrl } = await demoCallerAndHandler(page);
    await expectRenderLoopAlive(page, 'right after finding the demo pair by kind');
    expect(caller.kind, 'the demo ships a caller Route node (kind 9)').toBe(KIND_ENDPOINT);
    expect(handler.kind, 'whose cable delivers into an HTTP Handler (kind 10)').toBe(KIND_HANDLER);
    const url = await webhookUrl(page, caller.id);
    expect(url, 'the caller resolves to a loopback /endpoint/<path> POST URL').toMatch(ENDPOINT_URL_SHAPE);
    expect(url, "and it is the caller's own URL, the one the pair was found with").toBe(callerUrl);

    // (3) Drive a REAL loopback POST (not an injected packet) — the request enters the
    // real Core, hops the forward wire, the handler replies, and the reply reverse-
    // transports on the return wire toward the caller (the amber reply-home comet).
    const resp = await page.request.post(url!, {
      data: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(resp.status(), 'the endpoint accepts the real loopback POST').toBeLessThan(500);

    // (4) The reply-home distinct read, LIVE: the reply-home latch flips past its
    // dormant baseline — a REPLY-direction pulse (direction 1) rode the return wire, so
    // the amber reply-home comet rendered on the real canvas (the wires.ts layer draws a
    // REPLY pulse as the amber comet + trailing glow — proven in wires.test.ts).
    await pollScene(page, (sc) => sc.replyPulsesObserved, {
      timeout: 20_000,
      message:
        'a REAL POST drives a reply that travels HOME on the return wire (the amber reply-home comet renders live)',
    }).toBeGreaterThan(before.replyPulsesObserved);
  });
});
