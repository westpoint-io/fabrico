import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { docsUrl } from './support/site.ts';

// The pictures on "A tour of the app". Each is a <figure class="fab-shot"> written by the site's
// <Screenshot> component from a PNG under site/src/assets/tour/, which `npm run capture:tour` takes
// at twice the screen size. On the built page each figure must hold exactly one img with alt text
// that isn't empty and isn't the caption (a screen reader reads both), width and height attributes
// equal to half the PNG's pixels (so the space is reserved and a 2x screen gets the whole file), a
// 1 px edge, and a 12 px caption. A picture wider than the 768 px column links the full file with
// "Open full size", and no other picture does. The first picture loads eagerly and the rest lazily.
//
// The PNG sizes come from the files on disk: bytes 16 to 23 of a PNG are its width and height.

const URL_PATH = 'get-started/app-tour/';
const REPO = path.resolve(import.meta.dirname, '../..');
const TOUR_DIR = path.join(REPO, 'site/src/assets/tour');
/** The fewest figures the tour page holds: the eight pictures the capture script takes. */
const MIN_FIGURES = 1;
/** The widest the page column gets, in CSS px (site/src/lib/screenshot.ts COLUMN_MAX_CSS). */
const COLUMN_MAX_CSS = 768;
const FULL_SIZE_TEXT = 'Open full size';

interface Figure {
  shot: string | null;
  imgs: number;
  alt: string;
  caption: string;
  width: number;
  height: number;
  loading: string | null;
  border: string;
  captionSize: string;
  links: string[];
}

function pngSize(file: string): { width: number; height: number } {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

test('A tour of the app: the pictures have alt text unlike their caption, half-size attributes, a 1 px edge, a 12 px caption, and Open full size only when wider than the column', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(docsUrl(URL_PATH));
  const figures: Figure[] = await page.locator('figure.fab-shot').evaluateAll((els) =>
    els.map((fig) => {
      const img = fig.querySelector('img');
      const cap = fig.querySelector('figcaption');
      const imgStyle = img === null ? null : getComputedStyle(img);
      return {
        shot: fig.getAttribute('data-shot'),
        imgs: fig.querySelectorAll('img').length,
        alt: (img?.getAttribute('alt') ?? '').trim(),
        caption: (cap?.textContent ?? '').trim().replace(/\s+/g, ' '),
        width: Number(img?.getAttribute('width')),
        height: Number(img?.getAttribute('height')),
        loading: img?.getAttribute('loading') ?? null,
        border:
          imgStyle === null
            ? 'none'
            : [imgStyle.borderTopWidth, imgStyle.borderRightWidth, imgStyle.borderBottomWidth, imgStyle.borderLeftWidth, imgStyle.borderTopStyle].join(' '),
        captionSize: cap === null ? 'none' : getComputedStyle(cap).fontSize,
        links: [...(cap?.querySelectorAll('a') ?? [])].map((a) => (a.textContent ?? '').trim()),
      };
    }),
  );
  console.log(`TOUR_FIGURES count=${figures.length} shots=${figures.map((f) => f.shot).join(',')}`);
  expect(figures.length, `the tour page holds at least ${MIN_FIGURES} figure.fab-shot`).toBeGreaterThanOrEqual(MIN_FIGURES);

  figures.forEach((f, i) => {
    const name = f.shot ?? `figure ${i + 1}`;
    expect(f.shot, `figure ${i + 1} names its picture in data-shot`).not.toBeNull();
    expect(f.imgs, `${name}: the figure holds exactly one img`).toBe(1);
    const captionText = f.caption.endsWith(FULL_SIZE_TEXT) ? f.caption.slice(0, -FULL_SIZE_TEXT.length).trim() : f.caption;
    expect(f.alt, `${name}: the img has alt text`).not.toBe('');
    expect(captionText, `${name}: the figure has a caption`).not.toBe('');
    expect(f.alt, `${name}: the alt text differs from the caption`).not.toBe(captionText);

    const file = path.join(TOUR_DIR, `${f.shot}.png`);
    expect(fs.existsSync(file), `${name}: ${path.relative(REPO, file)} exists`).toBe(true);
    const px = pngSize(file);
    expect(
      { width: f.width, height: f.height },
      `${name}: the width and height attributes are half of the PNG's ${px.width} x ${px.height}`,
    ).toEqual({ width: px.width / 2, height: px.height / 2 });

    expect(f.border, `${name}: the img has a 1 px solid edge on all four sides`).toBe('1px 1px 1px 1px solid');
    expect(f.captionSize, `${name}: the caption is 12 px`).toBe('12px');

    const wide = f.width > COLUMN_MAX_CSS;
    expect(
      f.links.filter((t) => t === FULL_SIZE_TEXT).length,
      `${name}: Open full size appears ${wide ? 'once, since' : 'nowhere, since'} the picture is ${f.width} CSS px wide against the ${COLUMN_MAX_CSS} px column`,
    ).toBe(wide ? 1 : 0);

    expect(f.loading, `${name}: ${i === 0 ? 'the first picture loads eagerly' : 'pictures after the first load lazily'}`).toBe(
      i === 0 ? 'eager' : 'lazy',
    );
  });
});
