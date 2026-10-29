import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  CMD,
  GESTURE_ACCEPTED,
  buildPacket,
  expectExactlyOneFrame,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type MockSocketOpts,
} from './support/wire';

// gesture-verdict.spec.ts (ERR-01, plan 64-09) - the ACCEPT half of the refusal path,
// plus the four properties of the refusal surface that only a real browser can see.
//
// WHY THIS IS A PLAYWRIGHT SPEC AND NOT A VITEST, recorded so the next reader does not
// re-litigate it. ROADMAP criterion 4 says an accepted gesture produces NO message. The
// obvious cheap proof is a unit test: hand `showRefusal` a recorder and assert it was
// never called on an accept. That proof is VACUOUSLY GREEN and was rejected on measured
// grounds, not taste. `vitest.config.ts` sets `environment: 'node'` - there is no DOM in
// the unit runner, there is no `App.test.tsx`, and there is no component test of the
// chrome at all. A recorder-based proof therefore asserts something about a function
// nobody rendered, and it passes IDENTICALLY against an implementation that writes text
// on every gesture. Criterion 4 was rewritten to name this file for that reason.
//
// WHAT MAKES THE PROOF BITE. The `answerGesture` seam (support/wire.ts) answers an accept
// with a `gestureAccepted` frame that carries no sentence, exactly as the host does on this
// wire since phase 88 (plan 88-03, D-06; until then an accept wrote no frame at all, D-30).
// So when the spec drives a real pointer Place and then asserts `#fab-refusal` is STILL
// empty after a settle window, an optimistic implementation - one that painted a message
// from the client prediction rather than from a host refusal - would have text on screen
// that no refusal ever named, and this spec would be red. That is the whole design of the
// check.
//
// The four other cases carry inherited verification rows V3, V4, V9 and V10 (plus V7's
// contrast audit), each of which needs a live DOM, a live accessibility tree or a live
// wall clock and none of which any other check in the tree can see.

/** The refusal live region's always-mounted wrapper (RefusalMessage.tsx). */
const REFUSAL = '#fab-refusal';
/** The inner box, which mounts ONLY while a sentence does. */
const REFUSAL_BOX = '#fab-refusal .fab-panel';

/**
 * `REFUSAL_HOLD_MS` from `src/chrome/RefusalMessage.tsx`, MIRRORED rather than imported.
 *
 * The V9 case has to straddle this boundary from the outside - hold a wall-clock window
 * open past it and assert the box survived - so it needs the number as a fixture, and a
 * mirrored fixture that goes stale reddens V9 loudly (the box would be gone) instead of
 * silently re-deriving whatever the app currently does.
 */
const REFUSAL_HOLD_MS = 4000;

/** The sentence `FootprintCollision` maps to, mirrored from `REFUSAL_COPY`. */
const FOOTPRINT_SENTENCE = 'That space is taken. Clear it or try elsewhere.';

/** Arm the Source tool and click one empty cell: one Place gesture, driven by pointer. */
async function placeAt(page: Page, cx: number, cy: number): Promise<void> {
  const item = page.getByRole('button', { name: /Source/ });
  if ((await item.getAttribute('aria-pressed')) !== 'true') {
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true');
  }
  const drop = await screenCellCentre(page, cx, cy);
  await page.mouse.move(drop.x, drop.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** Boot the app against a harness whose gesture answer is `answer`. */
async function boot(
  page: Page,
  answerGesture: MockSocketOpts['answerGesture'],
): Promise<Harness> {
  const h = await mockRenderSocket(page, { answerGesture });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  return h;
}

test('V2 / criterion 4: an ACCEPTED gesture produces no message, and the region is empty at boot (V3)', async ({
  page,
}) => {
  // The harness accepts every gesture and therefore sends NOTHING, which is what the
  // real host does. Anything that appears below came from the client, not the host.
  const h = await boot(page, () => GESTURE_ACCEPTED);

  // V3, and it must be asserted HERE, before any gesture. The live region is present
  // with exactly ONE node and EMPTY text at boot. This is the only check in the tree
  // that can see the always-mounted rule: a region that mounted together with its
  // content would satisfy every other assertion in this file and still be unreliably
  // announced, because assistive tech has to observe the region before the mutation
  // lands inside it.
  //
  // Both reads are taken ONCE, with no retry. `toHaveText('')` and `toHaveCount(0)` retry for
  // the 5 s expect timeout, which outlasts the 4 s hold (`REFUSAL_HOLD_MS`): with a sentence on
  // screen they waited for it to go and passed (phase 88 security re-audit; red-first record in
  // the T-88-25 row of 88-SECURITY.md). A sentence showing at the moment of the read reds both.
  await expect(page.locator(REFUSAL), 'the live region is mounted at boot').toHaveCount(1);
  expect(await page.locator(REFUSAL).textContent(), 'and it is empty before any gesture').toBe('');
  expect(await page.locator(REFUSAL_BOX).count(), 'the bezel box is absent at rest').toBe(0);

  // A real pointer Place onto an empty cell, clear of the chrome.
  await placeAt(page, 12, 8);
  await expectExactlyOneFrame(page, h, CMD.Place);

  // Settle well past any plausible render/microtask boundary. A message written
  // optimistically from the client prediction would be on screen by now.
  await page.waitForTimeout(750);
  expect(
    await page.locator(REFUSAL).textContent(),
    'an accepted gesture shows NO sentence - the host answered with an accept that names none, so neither may the client',
  ).toBe('');
  expect(await page.locator(REFUSAL_BOX).count(), 'and the bezel box never mounted').toBe(0);
});

test('V4: a showing refusal adds +0 to the page-wide status role count and +0 to the alert count', async ({
  page,
}) => {
  const h = await boot(page, () => 'FootprintCollision');

  // Baseline at rest. The inner box is UNMOUNTED at rest, so a rest-only comparison
  // would be vacuous - it would compare the page against itself. The baseline is taken
  // here only so the comparison WHILE SHOWING has something to be measured against.
  const statusAtRest = await page.getByRole('status').count();
  const alertAtRest = await page.getByRole('alert').count();

  await placeAt(page, 12, 8);
  await expectExactlyOneFrame(page, h, CMD.Place);

  // Wait for the sentence to be on screen. Every assertion below runs INSIDE this
  // window, which is the point of the row: the element is at its most present here.
  await expect(page.locator(REFUSAL_BOX)).toBeVisible();
  await expect(page.locator(REFUSAL)).toHaveText(FOOTPRINT_SENTENCE);

  expect(
    await page.getByRole('status').count(),
    'the refusal element adds no status role while it is SHOWING (six page-wide bare ' +
      'status locators depend on this)',
  ).toBe(statusAtRest);
  expect(
    await page.getByRole('alert').count(),
    'and no alert role - a refused gesture destroyed nothing, so interrupting would be ' +
      'disproportionate (eight alert-count-zero assertions depend on this)',
  ).toBe(alertAtRest);

  // The causal half, stated directly rather than inferred from two page-wide totals:
  // the roles are absent from INSIDE the element, so a future page-wide change cannot
  // make this case pass for a reason that has nothing to do with the refusal surface.
  await expect(page.locator(REFUSAL).getByRole('status')).toHaveCount(0);
  await expect(page.locator(REFUSAL).getByRole('alert')).toHaveCount(0);
});

test('V9: answering the SAME tag twice re-arms the hold without re-announcing', async ({
  page,
}) => {
  const h = await boot(page, () => 'FootprintCollision');

  await placeAt(page, 12, 8);
  await expect(page.locator(REFUSAL)).toHaveText(FOOTPRINT_SENTENCE);
  const firstShownAt = Date.now();

  // Attach the observer to the region BEFORE the second answer, watching the subtree so
  // both a text rewrite (`characterData`) and a React remount of the text node
  // (`childList`) are recorded. The remount is the one that matters: re-setting the SAME
  // string would remount the node, a remount is an `additions` mutation, and a POLITE
  // live region announces it again - so a user hammering one wall would hear the same
  // sentence once per gesture instead of once.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} is not mounted`);
    const w = window as unknown as {
      __refusalMutations: { characterData: number; childList: number };
      __refusalObserver: MutationObserver;
    };
    w.__refusalMutations = { characterData: 0, childList: 0 };
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') w.__refusalMutations.characterData++;
        if (r.type === 'childList') w.__refusalMutations.childList++;
      }
    });
    obs.observe(el, { characterData: true, childList: true, subtree: true });
    w.__refusalObserver = obs;
  }, REFUSAL);

  // A DELIBERATE gap before the second answer, and the size of it is the whole reason
  // this case can tell "re-armed" from "left alone". The two hold windows must be
  // distinguishable in time: with the answers back to back they expire ~200ms apart and
  // no wall-clock assertion can separate them. At 1500ms the first window closes at
  // T0+4000 and the second at T0+5500, so the check below has over a second of margin on
  // both sides.
  await page.waitForTimeout(1500);

  // Second gesture, a different cell but the SAME tag - which is exactly the shape of a
  // user dragging along a wall of occupied cells.
  await placeAt(page, 14, 8);
  await expect.poll(() => h.sent.length).toBe(2);
  const secondAnsweredAt = Date.now();
  await page.waitForTimeout(300);

  const mutations = await page.evaluate(
    () =>
      (window as unknown as { __refusalMutations: { characterData: number; childList: number } })
        .__refusalMutations,
  );
  expect(mutations.characterData, 'a repeat of the same tag rewrites no text').toBe(0);
  expect(mutations.childList, 'and remounts no node, so the region never re-announces').toBe(0);

  // The hold was RE-ARMED, not merely left alone: hold the window open past the point
  // where the FIRST answer's 4000ms would have expired and assert the box survived. A
  // second answer that returned before touching the timer would let it dismiss here.
  const target = firstShownAt + REFUSAL_HOLD_MS + 400;
  await page.waitForTimeout(Math.max(0, target - Date.now()));
  const now = Date.now();
  // Both halves of the premise, asserted so a slow machine fails LOUDLY on the
  // arithmetic instead of quietly turning the real claim green or red for the wrong
  // reason. The check must sit strictly AFTER the first window and strictly BEFORE the
  // second, or it is measuring nothing.
  expect(now - firstShownAt, 'the check runs past the FIRST hold window').toBeGreaterThan(
    REFUSAL_HOLD_MS,
  );
  expect(now - secondAnsweredAt, 'and inside the SECOND one').toBeLessThan(REFUSAL_HOLD_MS);
  await expect(
    page.locator(REFUSAL_BOX),
    'the second answer re-armed the hold, so the box outlives the first window',
  ).toBeVisible();
  await expect(page.locator(REFUSAL)).toHaveText(FOOTPRINT_SENTENCE);
});

test('WR-02: a refusal answered at once for an unreadable gesture never hides an earlier gesture\'s refusal', async ({
  page,
}) => {
  // Phase 88 review WR-02. A frame whose body the host cannot read is refused INLINE, at
  // receipt, under its own id; a readable gesture is answered when the sim drains it, which on
  // a paused board is at Play. So gesture 2's Malformed can reach the page before gesture 1's
  // own refusal. Gesture 1's sentence must still show: until the fix the Malformed raised the
  // stale-drop bar to 2 and gesture 1's FootprintCollision was dropped as stale, leaving the
  // red flash with no reason.
  const h = await boot(page, (_frame, seq) => (seq === 2 ? 'Malformed' : undefined));
  await placeAt(page, 12, 8);
  await placeAt(page, 14, 8);
  await expect.poll(() => h.sent.length, 'PRECONDITION: both Places were sent').toBe(2);
  expect(
    h.sentHeaders.map((x) => x?.gestureId),
    'PRECONDITION: as gestures 1 and 2',
  ).toEqual([1, 2]);
  await expect(page.locator(REFUSAL), 'the inline Malformed shows at once').toHaveText(
    'The host could not read that gesture.',
  );

  // The drain answers gesture 1 later, as Play would.
  h.injectText(JSON.stringify({ kind: 'gestureRefused', seq: 1, tag: 'FootprintCollision', cmd: 'Place' }));
  await expect(
    page.locator(REFUSAL),
    "gesture 1's own refusal shows its reason, though it names a lower id than the Malformed",
  ).toHaveText(FOOTPRINT_SENTENCE);
});

test("T-88-25 re-audit: a turn the client sends after a later keyframe goes to the accept's own handle, and its refusal shows no sentence", async ({
  page,
}) => {
  // A turned Source is dropped and accepted as (generation 0, handle 42). An Undo then a Redo
  // re-mint it before any packet shows 42: the first frame the page sees is the Redo's
  // keyframe, generation 2, with the Source on the same cell as 17. The client cannot tell
  // that Source from another one dropped there after the Undo, so the queued Rotate goes to
  // (0, 42), which only the host can resolve, sent QUIET. The host refuses it (42 in table 0
  // names the node the Undo removed) and the band stays empty: the user never sent that turn.
  // Until the re-audit the Rotate went to 17 in table 2, which after an Undo can be a
  // different machine, and a refusal of it showed "That is no longer on the board."
  const h = await boot(page, (frame, seq) => (seq === 1 && frame[0] === CMD.Place ? { accept: [42] } : undefined));
  const item = page.getByRole('button', { name: /Source/ });
  await item.click();
  const drop = await screenCellCentre(page, 12, 8);
  await page.mouse.move(drop.x, drop.y);
  await page.keyboard.press('r');
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => h.sent.length, 'PRECONDITION: the Place was sent').toBe(1);
  await page.waitForTimeout(300);
  expect(h.sent, 'PRECONDITION: nothing more while no packet shows 42').toHaveLength(1);

  h.inject(buildPacket({ tick: 3, full: true, generation: 2, nodes: [{ id: 17, kind: 0, cell_x: 12, cell_y: 8 }] }));
  await expect.poll(() => h.sent.length, 'the queued Rotate went out').toBe(2);
  expect([...h.sent[1]], "Rotate{node: 42, ccw: false}, the accept's own handle").toEqual([CMD.Rotate, 42, 0]);
  expect(h.sentHeaders[1], "in the accept's table, as gesture 2").toEqual({ generation: 0, gestureId: 2 });

  h.injectText(JSON.stringify({ kind: 'gestureRefused', seq: 2, tag: 'UnknownNode', cmd: 'Rotate', node: 42 }));
  await page.waitForTimeout(500);
  // Read as text and the bezel box, as V2 does: `toHaveText('')` was seen to pass with the
  // sentence on screen (the mutation run of this case), so it is not used here.
  expect(await page.locator(REFUSAL).textContent(), 'the quiet refusal shows no sentence').toBe('');
  expect(await page.locator(REFUSAL_BOX).count(), 'and the bezel box never mounted').toBe(0);

  // The control: a refusal of a gesture the user did send still shows its sentence.
  h.injectText(JSON.stringify({ kind: 'gestureRefused', seq: 1, tag: 'FootprintCollision', cmd: 'Place' }));
  await expect(page.locator(REFUSAL), 'a refusal of a sent gesture still reads').toHaveText(FOOTPRINT_SENTENCE);
});

test('V7: axe finds no contrast violation on the rendered refusal element', async ({ page }) => {
  const h = await boot(page, () => 'FootprintCollision');

  await placeAt(page, 12, 8);
  await expectExactlyOneFrame(page, h, CMD.Place);
  // The audit runs WHILE a refusal is showing. `color-contrast` needs rendered pixels:
  // scoped to an unmounted box it has nothing to measure and reports nothing, which is
  // the shape of an audit that cannot see the thing it guards.
  await expect(page.locator(REFUSAL_BOX)).toBeVisible();
  await expect(page.locator(REFUSAL)).toHaveText(FOOTPRINT_SENTENCE);

  // CHROMIUM, not jsdom, and that is the whole reason this row lives in a Playwright
  // spec: under jsdom `color-contrast` returns `incomplete` rather than pass or fail,
  // so the narrow include would audit nothing at all.
  const results = await new AxeBuilder({ page }).include(REFUSAL).analyze();
  expect(results.violations, 'the refusal element passes axe, contrast included').toEqual([]);
  // ANTI-VACUITY: prove the contrast rule actually RAN over this element rather than
  // being skipped for want of a subject. A pass count of zero here would mean the
  // `toEqual([])` above was satisfied by an audit of nothing.
  const contrastChecked = results.passes.filter((p) => p.id === 'color-contrast');
  expect(
    contrastChecked.length,
    'the color-contrast rule ran over the refusal element (not skipped as incomplete)',
  ).toBeGreaterThan(0);
});

// V10 needs a FIRST-RUN user, and both mock Playwright configs pre-seed
// `fab.onboarding.seen.v1` so the WelcomeCard never double-matches `aside.fab-panel` in
// unrelated chrome specs. Cleared for this case alone (empty storage state), scoped to
// its own describe so nothing else in the file inherits it.
test.describe('V10: the WelcomeCard and the refusal never co-occupy the anchor', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a refused Place dismisses the welcome card and leaves ONE panel at the shared anchor', async ({
    page,
  }) => {
    const h = await boot(page, () => 'FootprintCollision');

    // The premise, asserted rather than assumed: the card really is up. Without this the
    // whole case passes on a returning-user boot where there was never a card to dismiss.
    await expect(
      page.locator('#fab-welcome-heading'),
      'the first-run welcome card is showing before the gesture',
    ).toHaveCount(1);

    await placeAt(page, 12, 8);
    await expectExactlyOneFrame(page, h, CMD.Place);
    await expect(page.locator(REFUSAL)).toHaveText(FOOTPRINT_SENTENCE);

    // D-27, and the user-visible cost is locked here deliberately: a first-run user whose
    // opening gesture is refused LOSES the rest of the welcome copy. The card is
    // dismissed rather than the refusal suppressed, because suppressing it is the silence
    // this phase exists to end.
    await expect(
      page.locator('#fab-welcome-heading'),
      'the refusal dismissed the welcome card',
    ).toHaveCount(0);

    // EXACTLY ONE `.fab-panel` sits at the shared top anchor. The two surfaces resolve
    // the IDENTICAL `top` expression, so if the card had survived, two ring-bearing
    // panels would overlap for four seconds with the card's two buttons underneath.
    const atAnchor = await page.evaluate(() => {
      const box = document.querySelector('#fab-refusal .fab-panel');
      if (!box) throw new Error('the refusal box is not mounted');
      const anchorTop = box.getBoundingClientRect().top;
      return [...document.querySelectorAll('.fab-panel')]
        .filter((el) => Math.abs(el.getBoundingClientRect().top - anchorTop) < 1)
        .map((el) =>
          el.closest('#fab-refusal') !== null
            ? 'refusal'
            : (el.getAttribute('aria-labelledby') ?? el.tagName.toLowerCase()),
        );
    });
    expect(
      atAnchor,
      'exactly one panel sits at the shared top anchor, and it is the refusal box',
    ).toEqual(['refusal']);
  });
});

// ---------------------------------------------------------------------------
// THE RENDERED WRAP, MEASURED (plan 64-11)
// ---------------------------------------------------------------------------
//
// The 64-UI-SPEC wrap budget is arithmetic: 420px of content, less a 16px glyph and a
// 4px gap, at Martian Mono's 8px advance = 50 characters per line, so `InvalidDock` at
// 57 characters (56 before plan 74.1-10 dropped its stale facing clause) is a deliberate
// two-line row. Every part of that is a prediction
// until something renders it.
//
// `RefusalMessage.test.ts` already holds the CHARACTER half machine-checked: every row but
// two is asserted at or under 50 characters, and the two counted exceptions are pinned by
// name (`InvalidDock` 57, the LONGEST row, and `PortOccupied` 54; `InvalidBeltJoin` was a
// third, at 77, from plan 74.1-18 until plan 74.1-32's reword brought it to 47), so a future
// row that overtook them reddens
// THERE. What no unit
// test in this tree can see is the PIXEL half - whether 57 characters actually lands on
// two lines, whether the box clips them, and where the glyph sits against them. That
// needs a real layout engine, a real font and a real viewport.
//
// THE FONT PRELOAD IS NOT CEREMONY. `toolbar-stability.spec.ts` records the measurement
// that made it mandatory: the bundled Martian Mono woff2 is `font-display: block`, and a
// width taken during the block period reads FALLBACK advances - 72px per 10 characters
// against the real 80px. A wrap measurement without the preload measures a font the user
// never sees, and would happily report one line where the shipped face gives two.

/** The sentence `InvalidDock` maps to, mirrored from `REFUSAL_COPY` (57 characters). */
const INVALID_DOCK_SENTENCE = 'A belt runs from an output to an input, right next to it.';

/** Everything one measurement of the rendered refusal box yields. */
interface RefusalMetrics {
  /** The bezel box's border-box rect, viewport-relative. */
  box: { left: number; right: number; top: number; bottom: number; width: number; height: number };
  /** Truncation probes on the box itself. */
  boxScrollWidth: number;
  boxClientWidth: number;
  boxScrollHeight: number;
  boxClientHeight: number;
  /** The text run: its rect, its resolved line height, and the face actually in use. */
  spanTop: number;
  spanHeight: number;
  spanScrollWidth: number;
  spanClientWidth: number;
  lineHeightPx: number;
  fontSizePx: number;
  fontFamily: string;
  /** The decorative warning glyph's rect. */
  glyphTop: number;
  glyphBottom: number;
  /** `--fab-space-lg`, the gutter the viewport clamp reserves at each edge. */
  gutterPx: number;
  viewportWidth: number;
}

/**
 * Load the bundled face, then read every number this file asserts on in ONE evaluate.
 *
 * One round trip rather than a dozen `boundingBox()` calls, because the box is on a live
 * 4000ms hold: a measurement spread across a dozen awaits can straddle the dismissal and
 * start reading a box that has unmounted underneath it.
 */
async function measureRefusal(page: Page): Promise<RefusalMetrics> {
  await page.evaluate(async () => {
    await document.fonts.load('12px "Martian Mono"');
    await document.fonts.ready;
  });
  return page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (!box) throw new Error(`${sel} is not mounted - the refusal box must be SHOWING`);
    const span = box.querySelector('span');
    const glyph = box.querySelector('svg');
    if (!span || !glyph) throw new Error('the refusal box is missing its text run or its glyph');
    const br = box.getBoundingClientRect();
    const sr = span.getBoundingClientRect();
    const gr = glyph.getBoundingClientRect();
    const cs = getComputedStyle(span);
    const gutter = getComputedStyle(document.documentElement).getPropertyValue('--fab-space-lg');
    return {
      box: {
        left: br.left,
        right: br.right,
        top: br.top,
        bottom: br.bottom,
        width: br.width,
        height: br.height,
      },
      boxScrollWidth: box.scrollWidth,
      boxClientWidth: box.clientWidth,
      boxScrollHeight: box.scrollHeight,
      boxClientHeight: box.clientHeight,
      spanTop: sr.top,
      spanHeight: sr.height,
      spanScrollWidth: span.scrollWidth,
      spanClientWidth: span.clientWidth,
      lineHeightPx: parseFloat(cs.lineHeight),
      fontSizePx: parseFloat(cs.fontSize),
      fontFamily: cs.fontFamily,
      glyphTop: gr.top,
      glyphBottom: gr.bottom,
      gutterPx: parseFloat(gutter),
      viewportWidth: window.innerWidth,
    };
  }, REFUSAL_BOX);
}

/**
 * The sentence `InvalidBeltJoin` maps to, mirrored from `REFUSAL_COPY` (47 characters since
 * plan 74.1-32's reword, J11-THIRD; it was the 77-character longest row from plan 74.1-24).
 */
const INVALID_BELT_JOIN_SENTENCE = "Join a belt's end to the start of another belt.";

/** Drive one `InvalidDock` refusal and wait for its sentence to be on screen. */
async function showInvalidDock(page: Page, h: Harness, cx: number, cy: number): Promise<void> {
  await placeAt(page, cx, cy);
  await expect.poll(() => h.sent.length).toBeGreaterThan(0);
  await expect(page.locator(REFUSAL_BOX)).toBeVisible();
  await expect(page.locator(REFUSAL)).toHaveText(INVALID_DOCK_SENTENCE);
}

/** The line count the box actually rendered, derived from geometry not from text. */
function renderedLines(m: RefusalMetrics): number {
  return Math.round(m.spanHeight / m.lineHeightPx);
}

test('the InvalidDock sentence wraps to exactly two lines, untruncated, with the glyph on line one', async ({
  page,
}) => {
  const h = await boot(page, () => 'InvalidDock');
  await showInvalidDock(page, h, 12, 8);
  const m = await measureRefusal(page);

  // The PREMISE of every number below: the shipped face is the one that measured them.
  // Without this the whole test still passes - on fallback advances - and reports a
  // wrap that no user will ever see.
  expect(
    m.fontFamily,
    'the measurement ran against the BUNDLED face, not the fallback (font-display: block)',
  ).toContain('Martian Mono');
  // 1.4 on a 12px base. `.fab-panel` sets `line-height: 1`, which is right for a
  // single-run label and collides ascenders into descenders on a wrapped sentence, so
  // the span overrides it. If that override were lost this reads 12 and the line count
  // below would still say 2 for the wrong reason - hence pinning it here.
  expect(m.lineHeightPx / m.fontSizePx, 'the text run resolves line-height 1.4').toBeCloseTo(1.4, 2);

  // EXACTLY TWO LINES, computed from rendered geometry rather than by reading the text
  // back. Reading the string back and counting characters would re-derive the UI-SPEC's
  // own arithmetic and prove only that the arithmetic is self-consistent.
  expect(
    renderedLines(m),
    `the 57-character sentence wraps to exactly 2 lines (span is ${m.spanHeight}px at ` +
      `${m.lineHeightPx}px per line)`,
  ).toBe(2);

  // NEVER TRUNCATED, NEVER ELLIPSISED. An ellipsised refusal reason is the silence this
  // phase exists to end in a quieter form, so it is asserted rather than trusted to the
  // absence of an `overflow` declaration - a stylesheet change three files away could
  // introduce one and nothing else in the tree would notice.
  expect(m.boxScrollWidth, 'the box has no hidden horizontal overflow').toBe(m.boxClientWidth);
  expect(m.boxScrollHeight, 'and none vertically - it GREW to fit the second line').toBe(
    m.boxClientHeight,
  );
  expect(m.spanScrollWidth, 'and the text run inside it is not clipped either').toBe(
    m.spanClientWidth,
  );

  // THE GLYPH SITS ON THE FIRST LINE, which is what `alignItems: 'flex-start'` buys and
  // what a `center` would lose. Asserted as containment inside the first line band
  // rather than as equality with the span top, because that is the property that
  // actually matters and it bites on the exact regression: centring a 16px glyph
  // against a 33.6px two-line block drops its top by 8.8px and its BOTTOM past the
  // first line's boundary, so the glyph would float between the two lines.
  expect(
    m.glyphTop,
    'the glyph does not start above the text it prefixes',
  ).toBeGreaterThanOrEqual(m.spanTop - 0.5);
  expect(
    m.glyphBottom,
    `the glyph ends inside the FIRST line band (top ${m.spanTop} + ${m.lineHeightPx}px); a ` +
      'centred alignment would push it past this and float it between the two lines',
  ).toBeLessThanOrEqual(m.spanTop + m.lineHeightPx + 0.5);
});

test('InvalidBeltJoin at 47 characters renders on exactly one line, untruncated', async ({
  page,
}) => {
  // NAMED CHANGE (plan 74.1-32, J11-THIRD). From plan 74.1-18 to 74.1-32 this row was the
  // longest in the table and the third counted exception; this case measured its 77
  // characters on exactly two lines. The reword that says what to do is 47 characters, so
  // it must now sit on ONE line in the shipped face, which this measures the way the
  // InvalidDock case above measures two.
  const h = await boot(page, () => 'InvalidBeltJoin');
  await placeAt(page, 12, 8);
  await expect.poll(() => h.sent.length).toBeGreaterThan(0);
  await expect(page.locator(REFUSAL_BOX)).toBeVisible();
  await expect(page.locator(REFUSAL)).toHaveText(INVALID_BELT_JOIN_SENTENCE);
  const m = await measureRefusal(page);

  expect(m.fontFamily, 'measured against the BUNDLED face').toContain('Martian Mono');
  expect(
    renderedLines(m),
    `the 47-character sentence renders on exactly 1 line (span is ${m.spanHeight}px at ` +
      `${m.lineHeightPx}px per line)`,
  ).toBe(1);
  expect(m.boxScrollWidth, 'the box has no hidden horizontal overflow').toBe(m.boxClientWidth);
  expect(m.boxScrollHeight, 'and none vertically').toBe(m.boxClientHeight);
  expect(m.spanScrollWidth, 'and the text run is not clipped').toBe(m.spanClientWidth);
  expect(
    m.glyphBottom,
    'the glyph ends inside the FIRST line band',
  ).toBeLessThanOrEqual(m.spanTop + m.lineHeightPx + 0.5);
});

/**
 * `--fab-space-md` (16) + `--fab-bezel-ring` (6), doubled: the box's horizontal padding.
 *
 * Mirrored as arithmetic rather than read back, so a token change moves the measured
 * border box and this file says WHICH number moved instead of re-deriving the answer
 * from the thing it is checking.
 */
const BOX_PADDING_X = 2 * (16 + 6);
/** The UI-SPEC content cap: the same 420 the ConfigPanel uses, so this box is never wider. */
const CONTENT_CAP_PX = 420;
/** 16px glyph + `--fab-space-xs` (4) gap, subtracted from the cap to give the text budget. */
const GLYPH_AND_GAP_PX = 16 + 4;

test('at the ledgered 992px minimum the 420px cap binds, the box clears its gutter, and nothing is cut', async ({
  page,
}) => {
  // 992 is the ledgered minimum non-clipping toolbar width (`toolbar-stability.spec.ts`,
  // WINDOWS id 4) - the narrowest width this app claims to support.
  await page.setViewportSize({ width: 992, height: 800 });
  const h = await boot(page, () => 'InvalidDock');
  await showInvalidDock(page, h, 12, 8);
  const wide = await measureRefusal(page);

  expect(wide.viewportWidth, 'measured at the ledgered minimum width').toBe(992);
  expect(renderedLines(wide), 'the sentence still wraps to exactly two lines at 992px').toBe(2);

  // THE CAP IS LOAD-BEARING, AND THIS IS THE ASSERTION THAT SHOWS IT. Measured with the
  // `maxWidth` declaration deleted, the same sentence renders a 496px border box at this
  // viewport; with it, 464. So the cap is removing 32px of width and forcing the wrap,
  // rather than describing a width the content would have taken anyway.
  expect(
    wide.boxClientWidth,
    `the 420px content cap binds: a ${CONTENT_CAP_PX}px content width in a content-box ` +
      `panel is a ${CONTENT_CAP_PX + BOX_PADDING_X}px border box (measured 496px with the ` +
      'cap removed)',
  ).toBe(CONTENT_CAP_PX + BOX_PADDING_X);
  // The UI-SPEC's 50-character-per-line budget, measured instead of computed: 420 content
  // less the glyph and its gap is 400px of text, and 400px at Martian Mono's 8px advance
  // is exactly the 50 characters `RefusalMessage.test.ts` holds every other row under.
  expect(
    wide.spanClientWidth,
    'the text run gets exactly the budgeted 400px, which is the 50-character line the ' +
      'copy table is written against',
  ).toBe(CONTENT_CAP_PX - GLYPH_AND_GAP_PX);

  expect(
    wide.box.left,
    'the box clears the left edge by at least the gutter',
  ).toBeGreaterThanOrEqual(wide.gutterPx);
  expect(wide.box.right, 'and the right edge by the same gutter').toBeLessThanOrEqual(
    wide.viewportWidth - wide.gutterPx,
  );
  expect(wide.boxScrollWidth, 'and nothing is cut off at this width').toBe(wide.boxClientWidth);
  expect(wide.boxScrollHeight, 'in either direction').toBe(wide.boxClientHeight);

  // WHAT HAPPENS BELOW THE LEDGERED MINIMUM, AND WHY THE SHIPPED DECLARATION IS A BARE
  // `420px` RATHER THAN A `min()`. Below 928px the 420px cap stops being the constraint
  // and the CONTAINING BLOCK takes over:
  //   - The wrapper is `position: fixed; left: 50%`, so its containing block runs from
  //     the viewport midpoint to the right edge. The box can therefore never exceed HALF
  //     the viewport width, whatever `maxWidth` says. Measured across the handover: the
  //     box is 464px at viewports 1000, 940, 930 and 928, then tracks half the viewport
  //     at 926 (463px) and 900 (450px).
  //   - This file's earlier run measured that the same box shipped a
  //     `min(420px, calc(100vw - 2 * --fab-space-lg))` whose VIEWPORT half could never
  //     bind, because half the viewport is tighter than `100vw - 48px` at every width
  //     above 96px. Deleting the term changed the render by nothing at either viewport
  //     asserted here: 464px at 992 and 200px at 400, identical to the pixel. It was
  //     dropped at the 64-11 checkpoint on 2026-08-22 and 64-UI-SPEC carries the
  //     amendment with that reason.
  // So the assertion below is not a check on a `maxWidth` value at all. It pins the
  // containing block, which is the thing that actually keeps a narrow window from
  // pushing the centred box off the right edge.
  await page.setViewportSize({ width: 400, height: 800 });
  // Re-arm the hold: the measurements above burned part of the 4000ms window, and a
  // resize does not restart it.
  await showInvalidDock(page, h, 14, 8);
  const narrow = await measureRefusal(page);

  expect(narrow.viewportWidth, 'measured well below the ledgered minimum').toBe(400);
  expect(
    narrow.box.width,
    'the fixed + left:50% containing block caps the box at half the viewport, which is ' +
      'what actually keeps a narrow window from pushing it off the right edge',
  ).toBeLessThanOrEqual(narrow.viewportWidth / 2);
  // The point of carrying this width at all: the sentence goes on wrapping DOWNWARD
  // rather than being cut off. Four lines here, and every one of them readable.
  expect(renderedLines(narrow), 'the sentence wraps further rather than truncating').toBe(4);
  expect(narrow.boxScrollWidth, 'a squeezed box is still never truncated').toBe(
    narrow.boxClientWidth,
  );
  expect(narrow.boxScrollHeight, 'it grows downward instead').toBe(narrow.boxClientHeight);
  expect(
    narrow.box.right,
    'and it still clears the right edge by the gutter',
  ).toBeLessThanOrEqual(narrow.viewportWidth - narrow.gutterPx + 0.5);

  // DELIBERATELY NOT ASSERTED: the ConfigPanel overlap at 992px. It is ACCEPTED with its
  // arithmetic stated in 64-UI-SPEC (131px, for at most 4 seconds, at z5 over z2, over a
  // `pointerEvents: 'none'` element so every control underneath stays clickable), and it
  // is one of the two backstop items waiting on the criterion-3c WebKitGTK photograph.
  // Pinning a number here would close by machine a judgement a human still owes.
});
