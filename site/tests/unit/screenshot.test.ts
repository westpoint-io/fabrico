// The checks a page's <Screenshot> goes through while the site builds.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLUMN_MAX_CSS,
  checkAltAndCaption,
  checkEvenSize,
  opensFullSize,
  resolveShot,
  tourNamesOf,
} from '../../src/lib/screenshot.ts';

const PAGE = 'site/src/content/docs/get-started/app-tour.mdx';
const KNOWN = ['camera-default', 'overview', 'palette'];

/** The message a call throws, or a failed assertion when it returns. */
function thrown(call: () => unknown): string {
  try {
    call();
  } catch (err) {
    assert.ok(err instanceof Error);
    return err.message;
  }
  assert.fail('the call returned instead of throwing');
}

test('tourNamesOf turns glob keys into sorted picture names and skips other files', () => {
  assert.deepEqual(tourNamesOf(['../assets/tour/palette.png', '../assets/tour/overview.png', '../assets/tour/notes.txt']), [
    'overview',
    'palette',
  ]);
});

test('a known name resolves to itself', () => {
  assert.equal(resolveShot('palette', PAGE, KNOWN), 'palette');
});

test('an unknown name fails with the page, the name, the known pictures and the command', () => {
  assert.equal(
    thrown(() => resolveShot('pallete', PAGE, KNOWN)),
    `[Screenshot] ${PAGE} names picture "pallete", and site/src/assets/tour/ has no pallete.png. ` +
      'Known pictures: camera-default, overview, palette. Run npm run capture:tour from frontend/ to take them again.',
  );
});

test('a missing name fails with the page', () => {
  assert.match(thrown(() => resolveShot(undefined, PAGE, KNOWN)), /^\[Screenshot\] .*app-tour\.mdx has a <Screenshot> with no name\./);
  assert.match(thrown(() => resolveShot('', PAGE, KNOWN)), /with no name/);
});

test('a missing or empty alt fails with the alt message', () => {
  const message =
    `[Screenshot] ${PAGE} has a <Screenshot name="palette"> with no alt. ` +
    'Give it one: alt says what the picture shows, caption says what to notice.';
  assert.equal(thrown(() => checkAltAndCaption(PAGE, 'palette', undefined, 'The palette.')), message);
  assert.equal(thrown(() => checkAltAndCaption(PAGE, 'palette', '  ', 'The palette.')), message);
});

test('a missing caption fails with the caption message', () => {
  assert.equal(
    thrown(() => checkAltAndCaption(PAGE, 'palette', 'A column of buttons.', undefined)),
    `[Screenshot] ${PAGE} has a <Screenshot name="palette"> with no caption. ` +
      'Give it one: alt says what the picture shows, caption says what to notice.',
  );
});

test('alt equal to caption fails, also when they differ only in surrounding spaces', () => {
  const message =
    `[Screenshot] ${PAGE} gives picture "palette" the same alt and caption. ` +
    'A screen reader reads both, so make alt describe the picture and caption say what to notice.';
  assert.equal(thrown(() => checkAltAndCaption(PAGE, 'palette', 'The palette.', 'The palette.')), message);
  assert.equal(thrown(() => checkAltAndCaption(PAGE, 'palette', ' The palette.', 'The palette. ')), message);
});

test('a distinct alt and caption pass', () => {
  assert.doesNotThrow(() => checkAltAndCaption(PAGE, 'palette', 'A column of buttons.', 'The palette.'));
});

test('an odd side fails with the file, its size and the command; even sides pass', () => {
  const message = (w: number, h: number): string =>
    `[Screenshot] site/src/assets/tour/palette.png is ${w} x ${h} pixels. ` +
    'Tour pictures are taken at twice the screen size, so both sides must be even. Take it again with npm run capture:tour.';
  assert.equal(thrown(() => checkEvenSize('palette', 349, 1304)), message(349, 1304));
  assert.equal(thrown(() => checkEvenSize('palette', 348, 1303)), message(348, 1303));
  assert.doesNotThrow(() => checkEvenSize('palette', 348, 1304));
});

test('Open full size shows only above the 768 px column', () => {
  assert.equal(COLUMN_MAX_CSS, 768);
  assert.equal(opensFullSize(1440), true);
  assert.equal(opensFullSize(769), true);
  assert.equal(opensFullSize(768), false);
  assert.equal(opensFullSize(464), false);
});
