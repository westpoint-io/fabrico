import { test, expect } from '@playwright/test';
import { LOCKED_SKIN } from '../src/render/synth/skins/locked.ts';
import { colorToCss } from '../shared/geometry.ts';
import { mockRenderSocket, waitForChrome } from './support/wire';

/**
 * THE ACCENT COLOURS, DERIVED FROM THE LOCKED SKIN rather than typed as `rgb(...)` literals.
 *
 * This is the same derivation `HeaderLockup.test.tsx` uses for `ACCENT_VALUES` (first written
 * in `LogoMark.test.tsx`, retired 2026-10-11 with its component), and for the same reason:
 * an assertion written against one name passes the day somebody paints a passive element
 * with a DIFFERENT accent, which is one step outside the rule it is guarding. The
 * browser resolves each of these to an `rgb(...)` string inside the page, so nothing here is
 * a remembered number.
 */
const ACCENT_CSS: readonly string[] = Object.values(LOCKED_SKIN.palette.accents).map((c) =>
  colorToCss(c),
);

// logo.spec.ts (SHELL-03, MARK-17, Phase 32-02; corrected in place by plans 59-04,
// 80-06 and 80.1-01) - the header lockup + hidden heading proof at the live UI edge.
//
// Plan 32-02 replaced the old 10x10 accent square + plain <span>Fabrico</span>
// (SHELL-05 accent reserve) with a programmatic mark and a proper heading. This
// spec drives the REAL app and asserts, in the mounted Toolbar <header>: (1) the
// document has exactly one level-1 heading, its accessible name is 'Fabrico', and
// it renders no glyph, and (2) the brand artefact's layers are the ones the record
// pins, painted with the one accent the accent reserve allows. We assert the DOM,
// never canvas pixels (the Pixi <canvas> stays out of scope).
//
// TWO SUPERSEDED MECHANISMS, QUOTED RATHER THAN DELETED.
//
//   1. This paragraph used to call the subject of (2) "the LogoMark bit-matrix
//      tile". Plan 59-04 retired the bit matrix: the mark became ONE inline <svg>
//      built from chrome/assets/logomark.svg, with one <path> per semantic layer.
//      Plan 80-05 then replaced the drawing itself with composition A on the
//      authority of the signed `80-MARK-LOCK-SUPERSESSION.md`: three layers named
//      `rail`, `cell` and `item`.
//
//   2. The header no longer wears that square at all, and this file's whole
//      subject moved with it. Its title used to read "the belt-flow LogoMark +
//      <h1> wordmark proof", and its clause (1) used to read "the wordmark is a
//      real <h1> whose accessible name is 'Fabrico' (the app heading)". Plan
//      80.1-01 swapped the 32u square plus a VISIBLE heading for the generated
//      header cut of the lockup chosen in Phase 79 (MARK-17). The product name
//      is now drawn once, as outlined geometry inside an aria-hidden artefact, and
//      the accessible name lives in a visually-hidden heading that paints nothing.
//      So both halves of clause (1) changed: the heading is still real and still
//      says 'Fabrico', and it is now asserted to render NO glyph rather than to
//      render the word.
//
// BOTH TESTS INSTALL THE MOCK RENDER SOCKET BEFORE NAVIGATING, and that is a fix
// rather than a formality. Until plan 80-06 neither did: both called
// `page.goto('/')` bare, so the page connected to the REAL dev host at
// ws://127.0.0.1:8787/render (`src/transport/devWebSocket.ts`,
// DEFAULT_DEV_WS_URL) and the results depended on whether a dev server happened
// to be running on this machine. That is H-1, the same hermeticity defect
// measured and fixed for `crisp-text.spec.ts` earlier (WINDOWS row
// 203); this file was one of the seven mock specs still carrying it. The whole
// value of the MOCK suite is that it does not depend on a live host.
test('the Toolbar shows the header lockup, and the accessible name survives in a hidden h1 [MARK-17 A-1/A-2]', async ({
  page,
}) => {
  await mockRenderSocket(page);
  await page.goto('/');
  // Chrome mounts only once the app is `ready`; the palette entry is the signal
  // (same ready gate as a11y.spec.ts / chrome-icons.spec.ts).
  await waitForChrome(page);

  // A-1 AND A-2 ARE THE REPLACEMENT FOR COVERAGE THIS PHASE DESTROYS, WHICH IS NOT
  // GUESSABLE FROM READING THEM, SO IT IS WRITTEN DOWN HERE.
  //
  // `a11y.spec.ts` is STRUCTURALLY BLIND to a DELETED heading, verified against the
  // installed axe-core 4.12.1. The rule that catches a missing level-1 heading is
  // `page-has-heading-one`, whose selector is `html:not(html *)` - the <html>
  // element itself - and that scan is scoped `.include('header').include('aside')`,
  // so <html> is never in its context and the rule matches no node at all. It CAN
  // fail on an EMPTIED heading, through `empty-heading`, and does. `heading-order`
  // does not cover the deletion either: with the h1 gone the first heading in scope
  // is an h2, and axe passes a first heading at any level.
  //
  // Read that against what plan 80.1-01 does to the other gates. `crisp-text.spec.ts`
  // pinned `header h1` twice and BOTH blocks are deleted by this same commit, because
  // they would otherwise measure the typography of an element that renders nothing.
  // The old assertion in this very case is the third, and it is the one being replaced
  // here. So after this phase, every gate in the tree that fails on a deleted document
  // heading is one this phase removes or rewrites. These two cases are not an optional
  // strengthening; they are the replacement, and they are mutation-proved:
  // deleting the visually-hidden <h1> from Toolbar.tsx reddens the count assertion.
  //
  // A DELIBERATE DECISION NOT TO ADD A SECOND AXE RUN. Phase research offered a
  // document-scope `AxeBuilder({ page }).withRules(['page-has-heading-one'])` with no
  // `.include()`, which would get the deleted-heading case from axe itself. This plan
  // DECLINES it. A-1 below already fails on deletion, on duplication AND on a changed
  // accessible name, which `page-has-heading-one` does not do, so the extra run would
  // be a strict subset of the coverage written here, bought with a second
  // full-document analyze call in a spec whose scope was deliberately narrowed away
  // from the Pixi canvas. `frontend/e2e/a11y.spec.ts` is therefore untouched by this
  // phase, and criterion 1's own stated mutation (empty the name, the axe case
  // reddens) holds unchanged through `empty-heading`.

  // A-1: exactly ONE level-1 heading in the document, accessible name 'Fabrico'.
  // By ROLE rather than by `header h1`, and by accessible NAME rather than by
  // `toHaveText`: `toHaveText` reads textContent and stays green on a
  // `display: none` heading, so it cannot tell hidden from removed-from-the-tree.
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveCount(1);
  await expect(heading).toHaveAccessibleName('Fabrico');

  // A-2: it renders no glyph. Asserting the role tree AND the visual absence is
  // what stops "hidden" and "deleted" looking identical to this suite: A-1 alone
  // would pass on a heading that draws the word a second time beside the cut.
  const headingBox = await heading.boundingBox();
  const headingClip = await heading.evaluate((el) => getComputedStyle(el).clipPath);
  const invisible =
    headingClip === 'inset(50%)' ||
    (headingBox !== null && headingBox.width <= 1 && headingBox.height <= 1);
  expect(
    invisible,
    `the h1 must render no glyph: its box is ${JSON.stringify(headingBox)} and its clip-path is ` +
      `"${headingClip}". The header lockup already draws the product name as outlined geometry, ` +
      'so a visible heading would draw it twice in two typefaces.',
  ).toBe(true);

  // (2) The header cut renders live with a real box (0x0 = failed mount).
  const mark = page.locator('header [data-testid="header-lockup"]');
  await expect(mark).toHaveCount(1);
  await expect(mark).toBeVisible();
  const box = await mark.boundingBox();
  expect(box, 'the header lockup has a layout box').not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
});

// SHELL-05's accent reserve: "coloured blue = you can interact with it" must hold,
// so the header carries no passive accent square. Plan 32-02 removed the literal
// one - a 10x10 --fab-btn-primary block - and this test is what guards the rule at
// the live UI edge. The rule did not change; what it is measured by did, twice.
//
// THE RETIRED MECHANISM, QUOTED. This comment used to end:
//
//   "the single sanctioned accent on the mark is its item dot, which is a
//   box-shadow layer inside the LogoMark tile, not a standalone sized element."
//
// Plan 59-04 deleted that mechanism. There is no box-shadow layer and no tile span.
//
// THE TAUTOLOGY THIS TEST USED TO BE, QUOTED SO THE LESSON SURVIVES ITS FIX. From
// plan 59-04 until plan 80-06 the body below iterated the header's empty-text
// <span>s and asserted none was 10x10. MEASURED on the real app, before and after
// plan 59-04 (throwaway probe, run and deleted):
//
//   before: 15 header <span>s, SEVEN in the iteration set - the 32x32 LogoMark root
//           span, its five 2x2 sprite layers, and one 0x0 live region
//   after:   9 header <span>s, ONE in the iteration set - only the 0x0 role="status"
//           aria-live region, which has no box at all
//
// The assertion's subject had left the iteration set entirely and the one element
// left could not be 10x10 in any state, so no change to the mark could redden it.
// Its mutation value was zero. That is `WINDOWS.md` row 33, and it is this
// repository's signature defect class: a check that cannot fail, reading green in
// every summary that counts it.
//
// WHAT REPLACED IT, AND WHY THESE TWO ASSERTIONS. Both need a live DOM, so neither
// can be satisfied on this test's behalf by a unit gate:
//
//   - The `data-part` list in DOCUMENT ORDER. Paint order is document order, and
//     the pinned order comes from `80-MARK-LOCK-SUPERSESSION.md` section 3, the
//     same source `LogoMark.test.tsx`'s PINNED_PART_ORDER was transcribed from (that
//     test was retired with its component on 2026-10-11). It
//     is deliberately not alphabetical (sorted would be cell, item, rail), so this
//     assertion distinguishes an order from a set.
//   - The item layer's COMPUTED fill. `getComputedStyle` here resolves
//     `var(--fab-accent-item)` through the `:root` block the shipped skin emitter
//     actually wrote into this document. A unit test resolves it through a
//     fixture; only the browser resolves it through the product. This is the
//     accent reserve itself, measured: the mark carries the one accent, and it is
//     the item riding the belt rather than a passive square.
//
// PROVED ABLE TO FAIL, once, for real, with two mutations applied to the
// committed tree and the spec run red against each. A repair asserted to
// work is a claim; a repair observed to fail on a mutation is evidence.
//
// THE THIRD ASSERTION IS THE COVERAGE THE REPAIR DID NOT CARRY FORWARD (WR-06 in
// `80-REVIEW.md`). Killing the tautology was right; what went with it was any
// assertion about ANY OTHER element in the header. The two assertions above
// describe the mark and nothing else, so adding
// `<span style={{width:10,height:10,background:'var(--fab-btn-primary)'}} />`
// beside the `<h1>` left this test green - and that is the literal edit the
// retired assertion existed to catch, and the SHELL-05 rule the title names. No
// other spec guards it: `toolbar-stability.spec.ts:109` only MENTIONS the
// tautology in a comment.
//
// THE RULE, AS MEASURED. SHELL-05 is "coloured blue = you can interact with it",
// so an accent-valued paint in the header is legal on an INTERACTIVE control and
// on the brand mark's one accent layer, and nowhere else. Measured on the live
// app: exactly two elements in the header carried an accent, the mark's `item`
// path and a `button.fab-cta`. A passive accent element is neither, so it lands
// in `passive` below and reddens.
//
// MOVED BY PLAN 91-10 (CHROME-15, D-14, UI-SPEC Color). The census is now ONE element:
// Examples, the header's one `.fab-cta`, became a plain labelled button, so with no
// control focused the mark's `item` path is the only accent paint left in the header.
// A fourth assertion pins that, so a header control that wears the build accent at
// rest again (Examples back on `.fab-cta`, or any other) reddens here.
//
// PHRASED ON `data-part="item"`, NOT ON THE SQUARE. The maintainer ruled after this review
// that the header should carry the LOCKUP rather than the square, and plan 80.1-01
// is the phase that did it. The prediction held exactly: the accent-reserve
// assertion below is unchanged in shape and stayed green across the swap, because
// the cut carries a `data-part="item"` layer too and it is the same one accent. The
// only edit the swap forced on it is the test id it reaches through, which moved
// from the square's to the cut's.
test('the accent reserve holds at the live edge: the only passive accent in the header is the mark item layer', async ({
  page,
}) => {
  await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);

  const layers = page.locator('header [data-testid="header-lockup"] path');

  // EXACT COUNT, NEVER A FLOOR, and the difference is C-5's whole point. Eleven of
  // these twelve paths still draws a plausible lockup - drop the item, or the
  // cleats, or the plate, and the header renders something mark-shaped that is not
  // the drawing that was judged - so a `toBeGreaterThanOrEqual` would pass on every
  // one of those. It is also the non-vacuity floor: `toHaveCount` on an empty
  // locator set would otherwise let an artefact that failed to mount satisfy an
  // "every layer" assertion over nothing, which is exactly the shape of defect this
  // test was rewritten to stop being.
  await expect(layers).toHaveCount(12);

  const parts = await layers.evaluateAll((els) => els.map((el) => el.getAttribute('data-part')));
  expect(
    parts,
    'the cut paints the plate, then the belt body, cleats and cell, then the outlines, drums and hubs, then the word, then the item on top',
  ).toEqual([
    'plate',
    'belt-body',
    'cleats',
    'cell-fill',
    'cell-outline',
    'belt-outline',
    'drum-left',
    'drum-left-hub',
    'drum-right',
    'drum-right-hub',
    'wordmark',
    'item',
  ]);
  // SVG paint order IS document order, so this assertion distinguishes an ORDER
  // from a SET, and this line is what proves it does: the pinned list is not its
  // own sorted copy, so a parser that routed the parts through a Map or a sort
  // would produce the right twelve names and the wrong picture, and redden here.
  expect(
    [...parts].sort(),
    'the pinned part list must not be alphabetical, or asserting it would not be asserting paint order',
  ).not.toEqual(parts);

  const item = page.locator('header [data-testid="header-lockup"] [data-part="item"]');
  await expect(item).toHaveCount(1);
  const fill = await item.evaluate((el) => getComputedStyle(el).fill);
  expect(fill, 'the item layer carries the item accent, resolved by the browser').toBe(
    'rgb(255, 180, 84)',
  );

  // THE ACCENT RESERVE ITSELF, over the whole header rather than over the mark.
  const scan = await page.evaluate((accents: readonly string[]) => {
    const header = document.querySelector('header');
    if (header === null) throw new Error('no <header> in the mounted app');

    // The authored values are hex; the browser reports `rgb(...)`. Resolve each through a
    // real element so the comparison happens in the browser's own notation rather than in a
    // conversion this spec would have to be trusted to get right.
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const rgb: string[] = [];
    for (const value of accents) {
      probe.style.color = '';
      probe.style.color = value;
      const resolved = getComputedStyle(probe).color;
      if (resolved !== '' && !rgb.includes(resolved)) rgb.push(resolved);
    }
    probe.remove();

    // Interactive by the accessibility contract, not by class name: SHELL-05's promise is
    // about what a reader can CLICK. A descendant of a control is part of that control.
    const INTERACTIVE =
      'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"]';

    const all = [...header.querySelectorAll('*')];
    const accented: { desc: string; interactive: boolean; markItem: boolean }[] = [];
    for (const el of all) {
      const s = getComputedStyle(el);
      const paints = [
        s.backgroundColor,
        s.fill,
        s.stroke,
        s.color,
        s.borderTopColor,
        s.borderLeftColor,
        s.outlineColor,
        s.boxShadow,
      ];
      if (!paints.some((paint) => rgb.some((value) => paint.includes(value)))) continue;
      const part = el.getAttribute('data-part');
      accented.push({
        desc: `${el.tagName.toLowerCase()}[data-part=${String(part)}][class=${el.getAttribute('class') ?? ''}]`,
        interactive: el.closest(INTERACTIVE) !== null,
        markItem: el.closest('[data-testid="header-lockup"]') !== null && part === 'item',
      });
    }
    return { scanned: all.length, accentValues: rgb, accented };
  }, ACCENT_CSS);

  // NON-VACUITY, three ways, and every one of them is load-bearing. `passive` being empty is
  // the pass condition, so an empty scan, an unresolved accent set, or a header that never
  // mounted would each satisfy the assertion below while measuring nothing at all.
  expect(scan.scanned, 'the header scan found no elements').toBeGreaterThan(10);
  expect(
    scan.accentValues.length,
    'no accent colour resolved in the page, so nothing could ever match',
  ).toBe(new Set(ACCENT_CSS).size);
  expect(
    scan.accented.filter((el) => el.markItem).map((el) => el.desc),
    'the scan did not even find the mark item, so it cannot see accents',
  ).toHaveLength(1);

  const passive = scan.accented.filter((el) => !el.interactive && !el.markItem).map((el) => el.desc);
  expect(
    passive,
    'a header element carries an accent while being neither interactive nor the mark item: ' +
      'SHELL-05 reserves accent colour for things a reader can act on',
  ).toEqual([]);

  // Plan 91-10: at rest (no control focused) no header control wears an accent either.
  expect(
    await page.evaluate(() => document.activeElement === document.body || document.activeElement === null),
    'PRECONDITION: no control is focused, so no focus ring is in the census',
  ).toBe(true);
  expect(
    scan.accented.filter((el) => el.interactive).map((el) => el.desc),
    'a header control wears the accent at rest: the accent is for focus and for the one primary ' +
      'action of a surface, and the header has none since Examples became a plain button (UI-SPEC Color)',
  ).toEqual([]);
});
