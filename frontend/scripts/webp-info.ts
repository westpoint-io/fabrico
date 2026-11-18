// webp-info.ts - reads an animated WebP's RIFF chunks in Node, with no image tool.
//
// The hero is encoded by whichever system tool the machine has (libwebp's img2webp in CI,
// ImageMagick here), so the checks on the encoded file can't trust either tool's own report.
// This reader walks the container itself and returns what a viewer will see: the canvas size from
// the VP8X chunk, the loop count from the ANIM chunk, and for each ANMF frame its offset, size,
// duration and the id of the image chunk inside it (`VP8L` for a lossless frame, `VP8 ` for a
// lossy one, `ALPH` before a lossy frame with alpha). The layout is in Google's "WebP Container
// Specification". `capture-hero.ts` checks the hero with it, and the Pages smoke reads it too.
//
// It refuses a file that isn't RIFF WEBP, whose RIFF size disagrees with its length, or whose
// chunks run past the end. It doesn't decode pixels.
//
// Run directly, `node scripts/webp-info.ts <file.webp>` prints the reading as one JSON line,
// with the durations counted, and exits 1 on a file it refuses.
//
// Erasure-only TypeScript, so Node runs it as it is.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One ANMF chunk: where the frame sits on the canvas, how long it shows, and how it is coded. */
export interface WebpFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  /** How long the frame shows, in ms. */
  durationMs: number;
  /** The first chunk inside the frame: `VP8L` lossless, `VP8 ` lossy, `ALPH` lossy with alpha. */
  sub: string;
}

export interface WebpInfo {
  /** The VP8X canvas size, or 0 by 0 for a file without a VP8X chunk. */
  width: number;
  height: number;
  /** The ANIM loop count (0 loops forever), or null for a file without an ANIM chunk. */
  loop: number | null;
  frames: WebpFrame[];
  bytes: number;
}

/** Reads the chunks of a WebP file's bytes. Throws on a file that isn't a whole RIFF WEBP. */
export function readWebpInfo(bytes: Uint8Array): WebpInfo {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('not a WebP file: it doesn\'t start with "RIFF" and "WEBP"');
  }
  const riffSize = b.readUInt32LE(4);
  if (riffSize + 8 !== b.length) {
    throw new Error(`the RIFF header says ${riffSize + 8} bytes and the file has ${b.length}`);
  }
  let width = 0;
  let height = 0;
  let loop: number | null = null;
  const frames: WebpFrame[] = [];
  let at = 12;
  while (at < b.length) {
    if (at + 8 > b.length) throw new Error(`a chunk header at byte ${at} runs past the end of the file`);
    const id = b.toString('latin1', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const data = at + 8;
    if (data + size > b.length) throw new Error(`the ${id} chunk at byte ${at} says ${size} bytes and runs past the end of the file`);
    if (id === 'VP8X') {
      if (size < 10) throw new Error(`the VP8X chunk is ${size} bytes, not 10`);
      width = 1 + b.readUIntLE(data + 4, 3);
      height = 1 + b.readUIntLE(data + 7, 3);
    } else if (id === 'ANIM') {
      if (size < 6) throw new Error(`the ANIM chunk is ${size} bytes, not 6`);
      loop = b.readUInt16LE(data + 4);
    } else if (id === 'ANMF') {
      if (size < 24) throw new Error(`the ANMF chunk at byte ${at} is ${size} bytes, too short to hold a frame`);
      frames.push({
        x: 2 * b.readUIntLE(data, 3),
        y: 2 * b.readUIntLE(data + 3, 3),
        width: 1 + b.readUIntLE(data + 6, 3),
        height: 1 + b.readUIntLE(data + 9, 3),
        durationMs: b.readUIntLE(data + 12, 3),
        sub: b.toString('latin1', data + 16, data + 20),
      });
    }
    // Chunks are padded to an even length.
    at = data + size + (size & 1);
  }
  return { width, height, loop, frames, bytes: b.length };
}

/** How many frames show for each duration, keyed by ms. */
export function durationCounts(frames: readonly WebpFrame[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of frames) counts[String(f.durationMs)] = (counts[String(f.durationMs)] ?? 0) + 1;
  return counts;
}

/** Is this file the script Node was asked to run, rather than a module another script imported? */
function isMain(): boolean {
  const main = (import.meta as ImportMeta & { main?: boolean }).main;
  if (typeof main === 'boolean') return main;
  const script = process.argv[1];
  return script !== undefined && path.resolve(script) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error('webp-info: name a .webp file');
    process.exit(2);
  }
  try {
    const info = readWebpInfo(readFileSync(file));
    console.log(
      JSON.stringify({
        width: info.width,
        height: info.height,
        loop: info.loop,
        frames: info.frames.length,
        durations: durationCounts(info.frames),
        subchunks: [...new Set(info.frames.map((f) => f.sub))],
        bytes: info.bytes,
      }),
    );
  } catch (error) {
    console.error(`webp-info: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
