import { test, expect } from '@playwright/test';
import { mockRenderSocket, screenCellCentre, waitForChrome } from './support/wire';

// chrome-icons.spec.ts (CHROME-01 / CHROME-02) - the chrome icon proof at the UI edge.
//
// NOTE, REWRITTEN IN PLACE BY PLAN 59-01 (CHROME-01). This file used to assert the exact
// INVERSE of what it asserts now. Its thesis read:
//
//   "Plan 27-05 swaps the last vector icons (lucide-react in the Toolbar, inline-SVG
//    glyphs in the Palette) for the icons.tsx bit-matrix components. This spec drives the
//    REAL app and asserts the Toolbar <header> and Palette <aside> contain ZERO <svg>
//    elements - the vector icons are gone and the chrome is one pixel world with the
//    canvas."
//
// WHY IT STOPPED BEING TRUE. The rule that assertion served was never "no `<svg>`
// element"; it was "no icon LIBRARY, and one visual world with the canvas". In 2027-05
// the canvas was a pixel bake, so a zero-`<svg>` chrome was literally the same artefact
// the board stamped and the element count was a fair proxy for it. Plan 58-03 moved the
// canvas to authored VECTOR art, and the proxy inverted: a bit-matrix chrome beside a
// vector canvas is now TWO worlds, and the only form in which the DOM can draw the SAME
// authored file - with `--fab-*` tokens still resolving and no raster to soften at a
// fractional DPR - is an inline `<svg>`. So CHROME-01 makes `aside svg > 0` the correct
// assertion and this file is inverted rather than deleted or weakened. The prohibition
// on an icon LIBRARY is untouched and permanent (ART-04 provenance).
//
// THE HEADER HALF IS COMPLETE AS OF PLAN 59-02. It was deferred by 59-01, which
// vectorised the machine-glyph family only and left the eleven transport/warning icons as
// bit matrices - so the Toolbar `<header>` genuinely contained zero `<svg>` and the
// accessibility clause below was written over both mount points to be vacuously satisfied
// for the header until 59-02 landed. 59-02 deleted the sprite path, so the header now
// carries one inline `<svg>` per icon-bearing control and BOTH the presence case and the
// accessibility case bite there. The remaining bit-matrix consumer in the header is
// `LogoMark`, which is a `<span>` stack until plan 59-04 re-points it at
// `chrome/assets/logomark.svg`. (History: the header stopped rendering `LogoMark` at MARK-17,
// and the component itself was retired on 2026-10-11.)
//
// THAT PARAGRAPH ENDED WITH A PREDICTION AND THE PREDICTION WAS WRONG. It read:
//
//   "the count below is DERIVED, so 59-04 needs no edit here."
//
// 59-04 DID need an edit here, and being derived is what hid the reason. The derivation
// was `button:has(svg)` - a count of icon-bearing CONTROLS - compared against a count of
// every `<svg>` in the header. A derived number is only as safe as the population it is
// compared against, and the brand mark joined the second population without joining the
// first, so the two sides stopped counting the same thing. The header case now asserts
// the per-control property and the outside-a-control population separately; see the
// corrected block there. Recorded rather than quietly fixed, because "derived, therefore
// future-proof" is the reasoning that produced the red.
//
// We assert the DOM, never canvas pixels (the Pixi <canvas> is out of scope and rightly
// still a single WebGL surface).

test('the Palette renders real inline <svg> icons, one per tool', async ({ page }) => {
  await page.goto('/');
  // Chrome mounts only once the app is `ready`; the palette entry is the signal
  // (same ready gate as a11y.spec.ts).
  await page.getByRole('button', { name: /Source/ }).waitFor();

  const palette = page.locator('aside[aria-labelledby="fab-palette-heading"]');
  // DERIVED AT TEST TIME from the palette's own tool list, never typed as a number. A
  // literal would have to be re-blessed whenever the tool set changes and would then be
  // re-blessed to whatever the app happened to render, which is how a count assertion
  // stops measuring anything. The property is one icon PER TOOL.
  const toolCount = await palette.locator('button').count();
  expect(toolCount, 'the palette mounted its tools').toBeGreaterThan(0);
  await expect(palette.locator('svg')).toHaveCount(toolCount);

  // ANTI-VACUITY: the icons have a real rendered box. A mounted-but-collapsed <svg>
  // would satisfy the count and draw nothing.
  const firstBox = await palette.locator('svg').first().boundingBox();
  expect(firstBox, 'the first palette icon has a layout box').not.toBeNull();
  expect(firstBox!.width).toBeGreaterThan(0);
  expect(firstBox!.height).toBeGreaterThan(0);

  // The icon is composed of REAL PATHS, not an <image> or a masked box: the chassis part
  // plus at least one glyph part, both named by their stable data-part handles.
  await expect(palette.locator('svg [data-part="chassis"]').first()).toHaveCount(1);
  expect(await palette.locator('svg path').count()).toBeGreaterThan(toolCount);
});

test('the Toolbar header renders real inline <svg> icons, one per icon-bearing control', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Source/ }).waitFor();

  const header = page.locator('header.fab-panel');

  // DERIVED AT TEST TIME, never typed, for the reason the Palette case above already
  // gives: a literal would be re-blessed to whatever the app happened to render. The
  // property here is ONE inline `<svg>` PER ICON-BEARING CONTROL - so a control that
  // silently rendered two glyphs, or a glyph that mounted OUTSIDE any control, both
  // redden even though the raw total would look plausible.
  //
  // CORRECTED IN PLACE BY PLAN 59-04, AND THE PROPERTY IS UNCHANGED. This block used to
  // read, in one line:
  //
  //   await expect(header.locator('svg')).toHaveCount(iconButtons);
  //
  // which folded "one glyph per control" and "no glyph outside a control" into a single
  // total. That was exact while every header `<svg>` lived inside a button. Plan 59-04
  // vectorised the brand mark, so the header now legitimately carries a FIFTH `<svg>`
  // outside any control, and the folded form went red on a correct implementation
  // (`Expected: 4  Received: 5`). Splitting it keeps BOTH halves of the stated property
  // rather than loosening either: the per-control count is asserted over glyphs that are
  // actually inside a control, and the outside-a-control population is pinned at exactly
  // one and NAMED, so a stray glyph mounting loose in the header still reddens.
  const iconButtons = await header.locator('button:has(svg)').count();
  expect(iconButtons, 'the header mounted its icon-bearing controls').toBeGreaterThan(0);
  await expect(header.locator('button svg')).toHaveCount(iconButtons);

  // THE POPULATION AND THE EXPECTATION ABOVE ARE THE SAME DOM, so the pair is blind in
  // one direction and the missing direction is the likely one (phase 59 review WR-07).
  // A control rendering TWO glyphs reddens (1 button, 2 svgs); a glyph mounting outside
  // a control reddens (the clause below). A control that LOSES its glyph moves BOTH
  // counts and stays green - and that is not theoretical: plan 59-02 removed the glyphs
  // from New / Save / Load and this assertion did not move a character. Nothing else in
  // the suite pinned WHICH header controls carry a glyph, and `chrome-icons-dpr-*.png`
  // screenshots the fixture strip rather than the header, so an accidental drop on any
  // transport button was invisible to every gate in the repo.
  //
  // So the icon-bearing set is PINNED BY NAME, in both directions: the named controls
  // must each carry exactly one glyph, and the set of controls that carry one must be
  // exactly the named set. The three deliberate omissions become a recorded decision
  // that reads as a one-line diff if anyone restores a glyph there.
  //
  // Play and Pause are ONE button in two states, so the pair is asserted as a pair
  // rather than each half being allowed to be absent - `if (await btn.count())` on each
  // name would let the whole block pass over nothing.
  const playPause = header.getByRole('button', { name: /^(Play|Pause)$/ });
  await expect(playPause, 'the transport play/pause control is mounted').toHaveCount(1);
  await expect(playPause.locator('svg'), 'play/pause carries exactly one glyph').toHaveCount(1);
  for (const name of ['Step', 'Undo', 'Redo']) {
    const btn = header.getByRole('button', { name: new RegExp(`^${name}$`) });
    await expect(btn, `${name} is a header control`).toHaveCount(1);
    await expect(btn.locator('svg'), `${name} carries exactly one glyph`).toHaveCount(1);
  }

  // The three that deliberately carry NO glyph. Plan 59-02's remedy step 3, measured:
  // restoring one costs 8px of header width against 2px of ledgered slack
  // (`WINDOWS.md` row 30, FEEL row 59-g). `NewIcon` / `SaveIcon` / `LoadIcon` remain
  // exported, registered and gated, so this is the assertion that makes putting one
  // back a visible decision rather than a quiet regression in the other direction.
  for (const name of ['New', 'Save', 'Load']) {
    const btn = header.getByRole('button', { name: new RegExp(`^${name}$`) });
    await expect(btn, `${name} is a header control`).toHaveCount(1);
    await expect(btn.locator('svg'), `${name} deliberately carries no glyph`).toHaveCount(0);
  }

  // AND THE NAMED SET IS THE WHOLE SET. Without this, a fifth icon-bearing control
  // could be added and never named here, which is how a by-name gate decays into a
  // sample. Derived from the live DOM and compared against the literal both ways.
  const glyphControlNames = (
    await header.locator('button:has(svg)').evaluateAll((els) =>
      els.map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
    )
  )
    // ONE control, two labels: the transport button reports Play or Pause depending on
    // run state. Normalised to a single token so the expectation below is a flat literal
    // rather than a branch - a branch here would be indistinguishable from slack.
    .map((n) => (n === 'Play' || n === 'Pause' ? 'Play|Pause' : n))
    .sort();
  expect(
    glyphControlNames,
    'the header controls that carry a glyph, by accessible name. If this list grew, NAME ' +
      'the new control in the loops above rather than widening this expectation.',
  ).toEqual(['Play|Pause', 'Redo', 'Step', 'Undo']);

  // The ONE sanctioned header glyph outside a control: the brand artefact (SHELL-03),
  // an inline <svg> since plan 59-04. Pinned by test id and by count, so this is an
  // exemption for a named element rather than slack in the total.
  //
  // CORRECTED IN PLACE (plan 80.1-01, MARK-17). This block used to name "the brand
  // mark" and pin the square's own test id, the retired 32u mark. The header now wears
  // the generated header CUT of the lockup, so all four assertions repoint. The count
  // stays 1 and that is the load-bearing half: the cut is still ONE inline <svg>
  // outside a control, not a second loose element beside the square and not a stack.
  expect(
    (await header.locator('svg').count()) - (await header.locator('button svg').count()),
    'exactly one header <svg> lives outside a control, and it is the brand lockup',
  ).toBe(1);
  await expect(header.locator('[data-testid="header-lockup"]')).toHaveCount(1);
  expect(
    await header.locator('[data-testid="header-lockup"]').evaluate((el) => el.tagName.toLowerCase()),
    'the brand lockup is the loose <svg> - inline vector, not a span stack',
  ).toBe('svg');
  expect(
    await header
      .locator('[data-testid="header-lockup"]')
      .evaluate((el) => el.closest('button') === null),
    'the brand lockup is not inside a control',
  ).toBe(true);

  // ANTI-VACUITY plus the ANTI-<image> check, both carried from the Palette case: the
  // glyphs have a real rendered box, and they are composed of REAL PATHS rather than an
  // <image>, a mask or a box-shadow sprite. `> iconButtons` is the load-bearing form -
  // every one of these glyphs is multi-part, so one path per button would mean the
  // parse emitted a single part and the rest were dropped.
  const firstBox = await header.locator('svg').first().boundingBox();
  expect(firstBox, 'the first header icon has a layout box').not.toBeNull();
  expect(firstBox!.width).toBeGreaterThan(0);
  expect(firstBox!.height).toBeGreaterThan(0);
  expect(await header.locator('svg path').count()).toBeGreaterThan(iconButtons);

  // The transport control is named, so this case cannot be satisfied by the file cluster
  // alone if the centre cluster failed to mount (the IN-02 concern, applied to the count).
  const transport = header.locator('button[aria-label="Play"], button[aria-label="Pause"]');
  await expect(transport.locator('svg')).toHaveCount(1);
  await expect(transport.locator('svg path').first()).toHaveAttribute('data-part', /.+/);

  // NO CHASSIS ANYWHERE IN THE HEADER. The chassis part is the machine-icon composition;
  // a transport glyph that grew one would mean the two families had been merged, which
  // is the arrangement `machines.ts` warns at length against.
  await expect(header.locator('svg [data-part="chassis"]')).toHaveCount(0);
});

test('every chrome <svg> is decorative in the live DOM: aria-hidden, focusable=false, no title, no role=img', async ({
  page,
}) => {
  // The socket is mocked HERE and in no other case in this file, because this is the one
  // case that has to DRIVE a refusal (see the fourth mount point below). The harness
  // refuses every gesture, which is all this audit needs from it.
  const h = await mockRenderSocket(page, { answerGesture: () => 'FootprintCollision' });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  // FOUR MOUNT POINTS, and it was TWO until the plan 59-07 exit block counted the live
  // population instead of trusting the selector.
  //
  // CORRECTED IN PLACE. This block used to read `header svg, aside svg` and its comment
  // said "BOTH MOUNT POINTS. Written this way by 59-01 while the header was still
  // vacuously clean, precisely so 59-02's transport icons would INHERIT the contract
  // rather than have to remember it." The inheritance argument holds and is why the
  // header clause is here. What was wrong is the word BOTH: the Legend renders inside
  // `#fab-legend-panel`, which is neither a `header` nor an `aside`, so eleven inline
  // `<svg>`s - a third of the live population with the Legend open - were outside a test
  // whose own NAME says "every chrome <svg>". Measured at the exit block: 15 roots with
  // the Legend closed and 26 with it open, and THREE of the eleven it was missing
  // carried no `focusable="false"` (the Endpoint inlet swatch from phase 46, and the
  // Request and Reply pulse swatches from 52-03). Pre-existing elements, but the
  // contract that binds them is THIS phase's, so both the attribute and the selector
  // were fixed at 59-07 rather than filed.
  //
  // THE FOURTH MOUNT POINT is the refusal surface (`RefusalMessage.tsx`, ERR-01), and
  // the `WarningIcon` inside it is exactly the kind of glyph this audit exists for: it
  // is decorative and REDUNDANT - the sentence beside it carries the whole information
  // content - which is what makes its 2.92:1 destructive-on-panel-fill legal at all. A
  // <title> or a role="img" there would give it an accessible name and a screen reader
  // would announce the tone cue on top of the sentence.
  //
  // WHY THIS CLAUSE LANDED ONE WAVE AFTER THE GLYPH, recorded as a decision rather than
  // left to read as drift. The house rule is that a gate literal moves in the same
  // commit as the thing that moves it, and this very spec records having shipped a
  // scope that could not see its subject once already. It could not be honoured here
  // for an ORDERING reason: the inner box is unmounted at rest, so the audit only sees
  // this svg if the spec drives a refusal first, and driving one needs the
  // `answerGesture` seam that arrived with this plan. Adding the selector in 64-06
  // beside the glyph would have enrolled a node that is never mounted during this spec
  // - green, and auditing nothing, which is the worse of the two failures. The residual
  // one-wave window is closed by the per-mount-point floor below, which is what makes a
  // matching-nothing selector fail instead of pass.
  //
  // The Legend is opened first because its panel does not exist in the DOM until then -
  // a closed Legend makes that clause vacuous, which is what the per-mount-point
  // floors below refuse.
  await page.getByRole('button', { name: 'Legend' }).click();
  await page.locator('#fab-legend-panel').waitFor();

  // Drive a real pointer Place onto an empty cell; the harness refuses it, so the box
  // mounts and the glyph exists WHILE the audit runs. The sentence is asserted before
  // the evaluate for two reasons: it proves the click reached the canvas rather than
  // the open Legend panel, and the refusal holds for only 4000ms, so the audit must be
  // inside that window rather than hoping it is.
  const item = page.getByRole('button', { name: /Source/ });
  await item.click();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  const drop = await screenCellCentre(page, 12, 8);
  await page.mouse.move(drop.x, drop.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(
    page.locator('#fab-refusal'),
    'the refusal is on screen, so the audit below has the new glyph to look at',
  ).toHaveText('That space is taken. Clear it or try elsewhere.');

  const audit = await page.evaluate(() => {
    const SCOPE = 'header svg, aside svg, #fab-legend-panel svg, #fab-refusal svg';
    const roots = [...document.querySelectorAll(SCOPE)];
    return {
      total: roots.length,
      header: document.querySelectorAll('header svg').length,
      aside: document.querySelectorAll('aside svg').length,
      legend: document.querySelectorAll('#fab-legend-panel svg').length,
      // DERIVED FROM `roots`, not from a second `querySelectorAll`, and deliberately so:
      // this floor exists to catch a SCOPE CLAUSE that matches nothing, and a floor
      // computed from its own independent query could be non-zero while the clause in
      // SCOPE was misspelled. Counting out of the audited population is the only form
      // that binds the floor to the thing it is guarding.
      refusal: roots.filter((s) => s.closest('#fab-refusal') !== null).length,
      notHidden: roots.filter((s) => s.getAttribute('aria-hidden') !== 'true').length,
      focusable: roots.filter((s) => s.getAttribute('focusable') !== 'false').length,
      titled: roots.filter((s) => s.querySelector('title') !== null).length,
      roleImg: roots.filter((s) => s.getAttribute('role') === 'img').length,
    };
  });

  // ANTI-VACUITY: an audit over zero nodes passes every clause below by measuring
  // nothing. This is the clause that makes the four after it mean something.
  expect(audit.total, 'there are inline <svg> icons in the chrome to audit').toBeGreaterThan(0);
  // PER MOUNT POINT, not just in total (plan 59-02). A total over both would stay green
  // on a header that had lost every icon, which is the exact state 59-01 shipped and
  // deliberately left recorded rather than asserted.
  expect(audit.header, 'the header mounts inline <svg> icons').toBeGreaterThan(0);
  expect(audit.aside, 'the palette mounts inline <svg> icons').toBeGreaterThan(0);
  expect(audit.legend, 'the open Legend mounts inline <svg> swatches').toBeGreaterThan(0);
  expect(
    audit.refusal,
    'the showing refusal mounts its inline <svg> warning glyph - if this is 0 the new ' +
      'SCOPE clause matched nothing and the four clauses below audited it not at all',
  ).toBeGreaterThan(0);

  // `aria-hidden="true"`: every icon in this app is decorative in the strict sense - it
  // never carries information its container does not already carry in text (the
  // per-site audit is in 59-UI-SPEC.md's accessibility contract).
  expect(audit.notHidden, 'every chrome <svg> is aria-hidden="true"').toBe(0);
  // `focusable="false"`: an inline <svg> is focusable in some engines' tab order even
  // when aria-hidden, which is a real keyboard-trap class (IX-09).
  expect(audit.focusable, 'every chrome <svg> carries focusable="false"').toBe(0);
  // A <title> or role="img" would give a decorative glyph an accessible name and make a
  // screen reader announce it twice beside the label it duplicates.
  expect(audit.titled, 'no chrome icon renders a <title>').toBe(0);
  expect(audit.roleImg, 'no chrome icon carries role="img"').toBe(0);
});

// IN-02: the count check above passes even if the header failed to mount its buttons.
// Prove the icon system renders LIVE, not just that the Palette has SVGs: the transport
// Play/Pause control exists, and the Palette's machine glyphs (`.fab-glyph` wrappers) are
// present with a non-zero rendered box.
//
// UNCHANGED BY PLAN 59-01 and deliberately so. It is the PRESENCE discriminator and it
// still bites - which is also why the `.fab-glyph` wrapper class must survive on all four
// of its sites (`Palette.tsx` x3, `Legend.tsx` x1) or this locator loses its subject.
test('the chrome icons actually render (presence, not just a count)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Source/ }).waitFor();

  // The transport control is a Play OR Pause button (the glyph toggles with sim
  // state); assert exactly one such control is present and visible.
  const transport = page.locator('header button[aria-label="Play"], header button[aria-label="Pause"]');
  await expect(transport).toHaveCount(1);
  await expect(transport.first()).toBeVisible();

  // The Palette renders one `.fab-glyph` wrapper per machine entry; require at least one
  // and prove it has a real rendered box (a failed icon mount is 0x0).
  const glyphs = page.locator('aside .fab-glyph');
  const glyphCount = await glyphs.count();
  expect(glyphCount).toBeGreaterThan(0);
  const firstBox = await glyphs.first().boundingBox();
  expect(firstBox, 'the first palette glyph has a layout box').not.toBeNull();
  expect(firstBox!.width).toBeGreaterThan(0);
  expect(firstBox!.height).toBeGreaterThan(0);
});
