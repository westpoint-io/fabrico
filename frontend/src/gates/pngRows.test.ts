// pngRows.test.ts (plan 84-11) - `decodePngRows` returns, for the rows it was asked for, exactly
// what `PNG.sync.read` returns, on real captures from the live walk and on images written with
// every PNG row filter, so leg 2's growth sampler reads the same pixels a full decode would.

import { readFileSync } from 'node:fs';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { describe, expect, it } from 'vitest';
import { decodePngRows } from '../../e2e-live/support/pngRows';

const FIXTURES = [
  '77-run-strip-packed.png',
  '77-run-strip-one-full.png',
  '77-label-drawn.png',
  '77-cables-drawn.png',
  '77-gauge-jam-merged.png',
];

function rows(data: Uint8Array, width: number, y0: number, y1: number): number[] {
  return Array.from(data.subarray(y0 * width * 4, y1 * width * 4));
}

/** pngjs as bundled: its typings declare only `sync.read`, the encoder is there too. */
interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}
const Pngjs = PNG as unknown as {
  new (o: { width: number; height: number }): PngImage;
  sync: { write(png: PngImage, o: { filterType: number; colorType: number }): Buffer };
};

/** A deterministic RGBA test image with structure across rows and columns. */
function synthetic(width: number, height: number): PngImage {
  const png = new Pngjs({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      png.data[o] = (x * 7 + y * 3) & 0xff;
      png.data[o + 1] = (x * y) & 0xff;
      png.data[o + 2] = (255 - x * 5 + y) & 0xff;
      png.data[o + 3] = 255;
    }
  }
  return png;
}

describe('decodePngRows', () => {
  it('EQUALS the full decode on every row of real captures from the live walk', () => {
    for (const name of FIXTURES) {
      const buf = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
      const full = PNG.sync.read(buf);
      const part = decodePngRows(buf, 0, full.height);
      expect({ name, width: part.width, height: part.height }).toEqual({ name, width: full.width, height: full.height });
      expect(Array.from(part.data), name).toEqual(Array.from(full.data));
    }
  });

  it('EQUALS the full decode on the rows asked for, for every row filter and for RGB', () => {
    for (const filterType of [0, 1, 2, 3, 4, -1]) {
      for (const colorType of [6, 2]) {
        const buf = Pngjs.sync.write(synthetic(40, 30), { filterType, colorType });
        const full = PNG.sync.read(buf);
        const part = decodePngRows(buf, 11, 19);
        expect(rows(part.data, 40, 11, 19), `filter ${filterType} colour ${colorType}`).toEqual(
          rows(full.data, 40, 11, 19),
        );
      }
    }
  });

  it('REFUSES what is not a PNG', () => {
    expect(() => decodePngRows(Buffer.from('not a png at all'), 0, 1)).toThrow(/not a PNG/);
  });
});
