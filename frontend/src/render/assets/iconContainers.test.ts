// iconContainers.test.ts - the byte-level gates on the two installer containers, `icon.ico` and
// `icon.icns` (ICON-04, ICON-06, D-10b, plan 81-04).
//
// WHERE THIS RAN AND WHAT IT PROVES, stated first because the limit matters more than the
// assertion. Every case in this file ran on LINUX, in the ordinary `unit` job, reading bytes.
// What it proves is the FILE'S LAYER ORDER and the FILE'S STRUCTURE: which layer sits at index 0
// of the ICO's directory, that the ICNS declares its own true length, and that each declared
// chunk holds a PNG of the size its OSType names.
//
// WHAT IT DOES NOT PROVE. That Microsoft's desktop paints the `.ico`, or that Finder paints the
// `.icns`. Nothing in this repository observes either: there is no job here that opens an icon on
// those platforms, and this file does not claim one. The `.icns` in particular was written by
// hand on a machine where `magick` has no ICNS decode delegate, so a structural round trip plus
// `file(1)` is the strongest available evidence and it is offered as exactly that.
//
// WHY A BYTE READ IS ENOUGH TO ASSERT THE ICO AT ALL, which is the point the roadmap got wrong.
// `tauri-codegen-2.6.3/src/image.rs:54-58` is
//
//     let icon_dir = ico::IconDir::read(Cursor::new(&buf)).unwrap_or_else(...);
//     let entry = &icon_dir.entries()[0];
//
// an index, with NO SEARCH: whatever sits at index 0 becomes `default_window_icon`. That line is
// reached only when `target == Target::Windows` (`context.rs:211-218`), so the Linux build
// genuinely never reads the file - but reading an ICONDIR is a platform-independent read of the
// first 22 bytes, a 6-byte header then 16-byte records whose first two bytes are width and
// height. `Buffer.readUInt16LE` does that anywhere. So the assertion needs no other operating
// system, and D-10b supersedes the decision that said it did.
//
// WHAT WOULD MAKE THIS SPEC VACUOUS, named so the next reader can check it has not happened.
//
//   1. `existsSync(ICNS_PATH)`. That is passed by `touch icon.icns`. Every case below parses.
//   2. Asserting the ICO's layer COUNT without asserting WHICH layer is at index 0. A six-entry
//      file in any order would pass, and the wrong Windows icon would ship silently.
//   3. Asserting index 0 is 32x32 on a ONE-LAYER file. That is true for free. The count floor in
//      the first case is asserted before the index claim for exactly this reason.
//   4. Predicates that only ever see correct input. `icoLayerZeroFault` and `icnsLengthFault` are
//      module-level functions so the two mutation cases can hand them a BROKEN buffer and watch
//      them say no, and hand them the real file in the same case and watch them say nothing.
//   5. Reading a payload's size from the record that introduces it. The record's declared size
//      and the payload's own IHDR are two independent declarations here, and the cases compare
//      them rather than reporting one twice.
//
// THE MUTATIONS ARE MADE ON IN-MEMORY COPIES. `Buffer.from(committed)` and then a swap or a
// decrement. Nothing in this file writes to `crates/fabrico-app/icons/` or anywhere else: concurrent
// runs may share this working tree and a spec that rewrote a tracked binary on every
// `npx vitest run` would corrupt it the first time two runs overlapped.
//
// No `@vitest-environment` docblock. The project default is the node environment, which is what
// lets this spec read disk and resolve paths the way the generator does.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ICNS_CHUNKS,
  ICNS_PATH,
  ICO_LAYERS,
  ICO_PATH,
  RASTER_16_PATH,
  RASTER_24_PATH,
} from '../../../scripts/build-icons.ts';

/* ------------------------------------------------------------------ *
 * The subjects, read ONCE at module load
 * ------------------------------------------------------------------ */

/**
 * The committed containers, read at module load rather than inside a case.
 *
 * `iconCuts.test.ts`'s reason applies unchanged: a value read inside a case is read AFTER
 * whatever the case did, which is the shape that cannot notice a mutation.
 */
const ICO_BYTES = readFileSync(ICO_PATH);
const ICNS_BYTES = readFileSync(ICNS_PATH);

/**
 * The hand-cut small rasters (MARK-05), read at module load like the containers.
 *
 * `icon16Cut.test.ts` proves these two files are renders of the hand-authored 16 unit cut, not
 * of the master. The case below chains to that proof: the `.ico`'s 16 and 24 payloads must be
 * these exact bytes, so a Windows small icon cannot quietly become a master downscale.
 */
const SMALL_RASTERS: readonly { size: number; path: string; bytes: Buffer }[] = [
  { size: 16, path: RASTER_16_PATH, bytes: readFileSync(RASTER_16_PATH) },
  { size: 24, path: RASTER_24_PATH, bytes: readFileSync(RASTER_24_PATH) },
];

/* ------------------------------------------------------------------ *
 * The expectations, DECLARED HERE as this spec's own literals
 * ------------------------------------------------------------------ */

/**
 * The ICO's declared sizes IN FILE ORDER, with 32 first.
 *
 * Typed out here rather than derived from `ICO_LAYERS`, and that is the whole method: deriving
 * the expectation from the generator would make this file compare the generator with itself, and
 * no reordering could ever be caught. The generator's own table is imported too, and one case
 * below holds the two declarations in agreement - so a reorder now has to happen in both places
 * or it reddens.
 */
const EXPECTED_ICO_SIZES = [32, 16, 24, 48, 64, 256] as const;

/** The size `tauri-codegen` reads at index 0, which is the Windows default window icon. */
const WINDOWS_LAYER_ZERO_SIZE = 32;

/**
 * The ICNS OSType to pixel-size map, MEASURED off `tauri icon`'s own output (81-RESEARCH.md S7)
 * rather than recalled, and declared here as this spec's own literal for the same reason the ICO
 * size list is.
 *
 * The legacy raw pairs `is32`+`s8mk` and `il32`+`l8mk` that Tauri also emits are absent, on
 * purpose: they are RLE-encoded ARGB rather than PNG, modern macOS does not require them, and
 * reproducing them means hand-rolling that encoder. That omission is the one known difference
 * between this file and Tauri's own output, and NO macOS VALIDATED EITHER of them from here.
 */
const EXPECTED_ICNS_SIZES: ReadonlyMap<string, number> = new Map([
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
]);

/* ------------------------------------------------------------------ *
 * PNG, the payload format both containers carry
 * ------------------------------------------------------------------ */

/** The eight-byte PNG signature, `\x89PNG\r\n\x1a\n`. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether a payload opens with the PNG signature. */
function isPng(payload: Buffer): boolean {
  return payload.length >= PNG_SIGNATURE.length && payload.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * A PNG payload's own dimensions, read from its IHDR: bytes 16 to 24, big-endian, after the
 * signature, the chunk length and the chunk type. Throws rather than returning a number when the
 * bytes are not a PNG, so a container carrying something else reddens loudly.
 */
function pngSize(payload: Buffer, label: string): { width: number; height: number } {
  if (!isPng(payload)) throw new Error(`${label} does not open with the PNG signature`);
  if (payload.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error(`${label} does not carry IHDR as its first chunk`);
  }
  return { width: payload.readUInt32BE(16), height: payload.readUInt32BE(20) };
}

/* ------------------------------------------------------------------ *
 * The ICO reader. Little-endian throughout.
 * ------------------------------------------------------------------ */

/** One `ICONDIRENTRY`, with the stored 0 already resolved to 256. */
interface IcoEntry {
  /** Position in the directory. Index 0 is the one `tauri-codegen` reads. */
  index: number;
  /** Declared width in pixels. A stored byte of 0 means 256. */
  width: number;
  /** Declared height in pixels. A stored byte of 0 means 256. */
  height: number;
  /** Declared payload byte length. */
  length: number;
  /** Declared payload offset from the start of the file. */
  offset: number;
}

/** A parsed `ICONDIR` and its entries. */
interface IconDir {
  reserved: number;
  type: number;
  count: number;
  entries: IcoEntry[];
}

/**
 * Parse an ICONDIR: `reserved` (always 0), `type` (1 for ICO), `count`, then 16-byte records.
 *
 * The record layout is 81-RESEARCH.md S7's twelve-row table, walked in the reading direction:
 * width, height, colour count and reserved are one byte each; planes and bits per pixel are two;
 * the payload length and offset are four each, little-endian. A stored width or height byte of 0
 * MEANS 256, which is why an ICO cannot declare a layer larger than that.
 */
function readIconDir(bytes: Buffer): IconDir {
  if (bytes.length < 6) throw new Error('the file is too short to hold an ICONDIR at all');
  const count = bytes.readUInt16LE(4);
  if (bytes.length < 6 + 16 * count) {
    throw new Error(`the file declares ${String(count)} entries but is too short to hold them`);
  }
  const entries: IcoEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + 16 * index;
    const storedWidth = bytes.readUInt8(at);
    const storedHeight = bytes.readUInt8(at + 1);
    entries.push({
      index,
      width: storedWidth === 0 ? 256 : storedWidth,
      height: storedHeight === 0 ? 256 : storedHeight,
      length: bytes.readUInt32LE(at + 8),
      offset: bytes.readUInt32LE(at + 12),
    });
  }
  return { reserved: bytes.readUInt16LE(0), type: bytes.readUInt16LE(2), count, entries };
}

/**
 * THE ICON-06 PREDICATE. `null` when the layer at index 0 is the expected square, otherwise a
 * message NAMING the size it found there.
 *
 * Factored out, and it names what it found rather than merely refusing, because the mutation case
 * below is what turns this from a claim into a gate: a predicate nobody has watched say no is a
 * predicate nobody has proven can.
 */
function icoLayerZeroFault(bytes: Buffer): string | null {
  let dir: IconDir;
  try {
    dir = readIconDir(bytes);
  } catch (error) {
    return `the ICONDIR could not be parsed: ${String(error)}`;
  }
  const first = dir.entries[0];
  if (first === undefined) return 'the ICO declares no layers at all';
  if (first.width !== WINDOWS_LAYER_ZERO_SIZE || first.height !== WINDOWS_LAYER_ZERO_SIZE) {
    return `index 0 declares ${String(first.width)}x${String(first.height)}, not ${String(
      WINDOWS_LAYER_ZERO_SIZE,
    )}x${String(WINDOWS_LAYER_ZERO_SIZE)}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The ICNS reader. Big-endian throughout, which is the other half of
 * why the two writers could not share code.
 * ------------------------------------------------------------------ */

/** One parsed ICNS chunk. */
interface IcnsChunkRead {
  /** The four character OSType naming the slot. */
  ostype: string;
  /** The declared chunk length, INCLUDING the eight-byte chunk header. */
  length: number;
  /** The payload after that header. */
  payload: Buffer;
}

/** The eight-byte file header: the magic `icns`, then the total length including itself. */
function readIcnsHeader(bytes: Buffer): { magic: string; declaredLength: number } {
  if (bytes.length < 8) throw new Error('the file is too short to hold an ICNS header at all');
  return { magic: bytes.subarray(0, 4).toString('ascii'), declaredLength: bytes.readUInt32BE(4) };
}

/** Every chunk, walked by its own declared length. Throws on a length that leaves the file. */
function readIcnsChunks(bytes: Buffer): IcnsChunkRead[] {
  const chunks: IcnsChunkRead[] = [];
  let at = 8;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw new Error(`a chunk header at ${String(at)} runs off the end`);
    const ostype = bytes.subarray(at, at + 4).toString('ascii');
    const length = bytes.readUInt32BE(at + 4);
    if (length < 8 || at + length > bytes.length) {
      throw new Error(`chunk ${ostype} declares ${String(length)} bytes, which leaves the file`);
    }
    chunks.push({ ostype, length, payload: bytes.subarray(at + 8, at + length) });
    at += length;
  }
  return chunks;
}

/**
 * THE ICON-04 PREDICATE. `null` when the file carries the ICNS magic AND declares its own true
 * byte length, otherwise a message naming the disagreement.
 *
 * This is the cheapest assertion a zero-byte or truncated file cannot satisfy, which is the whole
 * answer to "`existsSync` is passed by `touch icon.icns`". It handles a short buffer by returning
 * a message rather than throwing, because one of its mutants is the empty file.
 */
function icnsLengthFault(bytes: Buffer): string | null {
  if (bytes.length < 8) {
    return `the file is ${String(bytes.length)} bytes, too short to hold an ICNS header at all`;
  }
  const { magic, declaredLength } = readIcnsHeader(bytes);
  if (magic !== 'icns') return `the file opens with "${magic}" rather than the ICNS magic`;
  if (declaredLength !== bytes.length) {
    return `the header declares ${String(declaredLength)} bytes and the file is ${String(
      bytes.length,
    )}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

describe('icon.ico is a real ICONDIR whose index 0 is the Windows default window icon', () => {
  it('parses as an ICONDIR carrying more than one layer', () => {
    // THE ANTI-VACUITY FLOOR, and it is asserted BEFORE the index-0 claim on purpose. A
    // one-layer file satisfies "index 0 is 32x32" for free, so without this floor the next case
    // would be a sentence about a file rather than a property of it.
    const dir = readIconDir(ICO_BYTES);
    expect(dir.reserved, 'the ICONDIR reserved field is not 0').toBe(0);
    expect(dir.type, 'the ICONDIR type field is not 1, so this is not an ICO').toBe(1);
    expect(
      dir.count,
      'the ICO declares one layer or none, which would make the index-0 assertion vacuous',
    ).toBeGreaterThan(1);
  });

  it('declares 32x32 at index 0, which is the entry tauri-codegen reads with no search (ICON-06)', () => {
    // The one line that decides which image a Windows desktop wears:
    // `let entry = &icon_dir.entries()[0]` (`tauri-codegen-2.6.3/src/image.rs:54-58`).
    expect(icoLayerZeroFault(ICO_BYTES)).toBeNull();
  });

  it('declares the full size ladder in file order, with the stored 0 read as 256', () => {
    // Read from the FILE, compared against this spec's own literal. And the generator's table is
    // held in agreement with that literal in the same case, so a reorder has to be made in both
    // places or one of the two expectations fails.
    const sizes = readIconDir(ICO_BYTES).entries.map((entry) => entry.width);
    expect(sizes, 'the committed ICO declares a different size ladder').toEqual([
      ...EXPECTED_ICO_SIZES,
    ]);
    expect(
      ICO_LAYERS.map((layer) => layer.size),
      'the generator and this spec disagree about the ICO layer order',
    ).toEqual([...EXPECTED_ICO_SIZES]);

    // Square, every one of them. A record declaring 32 wide and 16 high would pass the width
    // comparison above and still be a broken layer.
    for (const entry of readIconDir(ICO_BYTES).entries) {
      expect(entry.height, `layer ${String(entry.index)} is not square`).toBe(entry.width);
    }
  });

  it('points every entry at a PNG payload that lies inside the file and matches its declared size', () => {
    // Three independent things, and the third is the one that is easy to leave out: the record's
    // DECLARED size and the payload's OWN IHDR are two declarations, and a container can hold a
    // 16 pixel image in a record that says 48. Comparing them is what catches that.
    const dir = readIconDir(ICO_BYTES);
    expect(dir.entries.length).toBe(dir.count);

    for (const entry of dir.entries) {
      const label = `ICO layer ${String(entry.index)} (${String(entry.width)}px)`;
      expect(entry.length, `${label} declares an empty payload`).toBeGreaterThan(0);
      expect(entry.offset, `${label} starts before the directory ends`).toBeGreaterThanOrEqual(
        6 + 16 * dir.count,
      );
      expect(entry.offset + entry.length, `${label} runs off the end of the file`).toBeLessThanOrEqual(
        ICO_BYTES.length,
      );

      const payload = ICO_BYTES.subarray(entry.offset, entry.offset + entry.length);
      expect(isPng(payload), `${label} is not a PNG payload`).toBe(true);
      const size = pngSize(payload, label);
      expect(size.width, `${label} holds a ${String(size.width)}px image`).toBe(entry.width);
      expect(size.height, `${label} holds a ${String(size.height)}px image`).toBe(entry.height);
    }
  });

  it('carries the hand cut at 16 and 24, byte for byte the committed 16x16.png and 24x24.png (MARK-05)', () => {
    // The 81-VERIFICATION advisory, unacted for a month and re-proved on 2026-10-11 (M7): with
    // `ICO_LAYERS` 16 and 24 switched from the small cut to the master and the icons regenerated,
    // every icon test stayed green. Every case above reads structure and size; none reads WHICH
    // drawing a layer holds. This one does, by comparing payload bytes to the hand-cut rasters.
    const dir = readIconDir(ICO_BYTES);
    for (const raster of SMALL_RASTERS) {
      const label = `ICO ${String(raster.size)}px layer`;
      const matches = dir.entries.filter((e) => e.width === raster.size && e.height === raster.size);
      // NON-VACUITY: exactly one layer of this size, so the comparison below runs once and on
      // the right layer.
      expect(matches.length, `${label}: the ICO declares ${String(matches.length)} layers of this size`).toBe(1);
      expect(raster.bytes.length, `${basename(raster.path)} is empty`).toBeGreaterThan(0);
      const entry = matches[0]!;
      const payload = ICO_BYTES.subarray(entry.offset, entry.offset + entry.length);
      expect(
        payload.equals(raster.bytes),
        `${label} is not byte-identical to ${basename(raster.path)} (${String(payload.length)} vs ${String(raster.bytes.length)} bytes), so the Windows small icon is no longer the hand cut`,
      ).toBe(true);
    }
  });

  it('THE GATE CAN FAIL: an ICO with its first two layers swapped is rejected by name', () => {
    // ICON-06'S NAMED MUTATION. A real swap of two 16-byte ICONDIRENTRY records in a copy of the
    // real bytes, not an edited literal and not a fabricated buffer. Index 0 and index 1 trade
    // places, which is exactly what a careless regeneration would do, and the predicate must
    // notice and SAY WHAT IT FOUND.
    //
    // Nothing is written. `Buffer.from` copies.
    const mutant = Buffer.from(ICO_BYTES);
    const first = Buffer.from(mutant.subarray(6, 22));
    const second = Buffer.from(mutant.subarray(22, 38));
    second.copy(mutant, 6);
    first.copy(mutant, 22);

    // The mutation must have changed something, or the assertion below proves nothing.
    expect(mutant.equals(ICO_BYTES), 'the swap produced an identical buffer').toBe(false);

    const fault = icoLayerZeroFault(mutant);
    expect(fault, 'the reordered ICO passed the index-0 predicate').not.toBeNull();
    // It names the size it found rather than only refusing, so a failure diagnoses itself.
    expect(fault).toContain(String(readIconDir(ICO_BYTES).entries[1]!.width));

    // Both directions, in the same case: the same predicate accepts the real file.
    expect(icoLayerZeroFault(ICO_BYTES)).toBeNull();

    // And the committed file is untouched by this case.
    expect(readFileSync(ICO_PATH).equals(ICO_BYTES), 'this spec modified the committed ICO').toBe(
      true,
    );
  });
});

describe('icon.icns is a real ICNS, parsed rather than merely present (ICON-04)', () => {
  it('carries the icns magic and declares its own true byte length', () => {
    // ICON-04's floor. `existsSync` is passed by `touch icon.icns`; this is not, and neither is
    // a file truncated by a bad copy.
    expect(icnsLengthFault(ICNS_BYTES)).toBeNull();
    expect(readIcnsHeader(ICNS_BYTES).declaredLength).toBe(ICNS_BYTES.length);
  });

  it('carries the expected OSTypes, each holding a PNG of the size that OSType declares', () => {
    // The chunk set is compared as a SET against this spec's own measured map, and the
    // generator's table is held in agreement with the same map, so neither side can drift alone.
    //
    // The load-bearing half is the second loop: `ic11` NAMING 32 pixels and the payload's IHDR
    // REPORTING 32 pixels are two independent declarations. A container that put the 1024 pixel
    // render in every slot would satisfy the OSType set and fail here.
    //
    // The legacy `is32`+`s8mk` and `il32`+`l8mk` pairs that `tauri icon` also writes are
    // deliberately absent from this file (see the header), so the set comparison is exact rather
    // than a containment check.
    const chunks = readIcnsChunks(ICNS_BYTES);
    expect(chunks.length, 'the ICNS carries no chunks at all').toBeGreaterThan(0);

    expect(
      chunks.map((chunk) => chunk.ostype).sort(),
      'the committed ICNS carries a different chunk set',
    ).toEqual([...EXPECTED_ICNS_SIZES.keys()].sort());
    expect(
      ICNS_CHUNKS.map((chunk) => chunk.ostype).sort(),
      'the generator and this spec disagree about the ICNS chunk set',
    ).toEqual([...EXPECTED_ICNS_SIZES.keys()].sort());

    for (const chunk of chunks) {
      const declared = EXPECTED_ICNS_SIZES.get(chunk.ostype);
      expect(declared, `${chunk.ostype} is not a slot this spec knows`).toBeDefined();
      expect(chunk.length, `${chunk.ostype} declares a header with no payload`).toBeGreaterThan(8);
      expect(chunk.length - 8, `${chunk.ostype}'s declared length disagrees with its payload`).toBe(
        chunk.payload.length,
      );

      const size = pngSize(chunk.payload, `ICNS chunk ${chunk.ostype}`);
      expect(size.width, `${chunk.ostype} names ${String(declared)} and holds ${String(size.width)}`).toBe(
        declared,
      );
      expect(size.height, `${chunk.ostype} holds a payload that is not square`).toBe(size.width);
    }
  });

  it('THE GATE CAN FAIL: a truncated ICNS and an empty one are both rejected by name', () => {
    // ICON-04'S NAMED MUTATION, and the answer to the vacuous shape this requirement invites.
    // The first mutant decrements the DECLARED length by one on a copy of the real bytes, which
    // is what a partially written or clipped file looks like from the outside. The second is the
    // zero-byte file `touch icon.icns` produces.
    const truncated = Buffer.from(ICNS_BYTES);
    truncated.writeUInt32BE(readIcnsHeader(ICNS_BYTES).declaredLength - 1, 4);
    expect(truncated.equals(ICNS_BYTES), 'the decrement produced an identical buffer').toBe(false);

    const truncatedFault = icnsLengthFault(truncated);
    expect(truncatedFault, 'the truncated ICNS passed the length predicate').not.toBeNull();
    expect(truncatedFault).toContain(String(ICNS_BYTES.length));

    const touched = Buffer.alloc(0);
    const touchedFault = icnsLengthFault(touched);
    expect(touchedFault, 'a zero-byte file passed the length predicate').not.toBeNull();

    // Both directions: the same predicate accepts the real file, in the same run.
    expect(icnsLengthFault(ICNS_BYTES)).toBeNull();

    // And the committed file is untouched by this case.
    expect(
      readFileSync(ICNS_PATH).equals(ICNS_BYTES),
      `this spec modified ${basename(ICNS_PATH)}`,
    ).toBe(true);
  });
});
