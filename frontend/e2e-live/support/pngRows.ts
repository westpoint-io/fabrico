import { inflateSync } from 'node:zlib';
import { PNG } from 'playwright-core/lib/utilsBundle';
import type { DecodedImage } from './canvasDots';

// pngRows.ts (plan 84-11) - decode only the rows of a PNG a read needs.
//
// WHY IT EXISTS. Leg 2's growth sampler (`77-one-board-all-five.live.spec.ts`,
// `openGrowthSampler`) captures the whole viewport many times a second, because a clipped
// capture resizes the viewport when requests overlap. Decoding each 1280 by 800 capture with
// `PNG.sync.read` costs the test process about 110 ms at a 100% CPU quota
// (measured), on the cores the page and the host share, and the read only needs the 32 rows of
// the run's six tiles. The pixel data is inflated whole (native zlib, cheap) and the row filters
// are undone only from the nearest row at or above the first wanted row that does not depend on
// the row before it (filter None or Sub), down to the last wanted row. With no such row it starts
// at row 0, which is a full decode. The result is the same image, with every row outside the
// decoded range left zero.
//
// Only 8-bit RGB and RGBA without interlace are decoded here (what Chromium's capture writes);
// anything else falls back to `PNG.sync.read` for the whole image.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * The PNG in `buf` decoded to RGBA, with rows `y0` to `y1 - 1` exact and the others possibly zero.
 * The same width, height and layout `PNG.sync.read` returns.
 */
export function decodePngRows(buf: Buffer, y0: number, y1: number): DecodedImage {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error('decodePngRows: not a PNG');
  }
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  const bpp = colour === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const lo = Math.max(0, Math.min(height, y0));
  const hi = Math.max(lo, Math.min(height, y1));
  // The first row to undo: the nearest at or above `lo` whose filter does not read the row before.
  let start = lo;
  while (start > 0 && raw[start * (stride + 1)] >= 2) start--;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = start; y < hi; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let r: number;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4:
          r = v + paeth(a, b, c);
          break;
        default:
          throw new Error(`decodePngRows: row ${y} has unknown filter ${filter}`);
      }
      cur[x] = r & 0xff;
    }
    if (y >= lo) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        out[o] = cur[x * bpp];
        out[o + 1] = cur[x * bpp + 1];
        out[o + 2] = cur[x * bpp + 2];
        out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}
