// tauriBundle.test.ts - the first machine-readable gate this repository has ever had on
// `crates/fabrico-app/tauri.conf.json` (LIC-04, ICON-01, D-12, D-13, plan 81-03).
//
// WHAT THIS SPEC IS ACTUALLY FOR. `bundle.resources` is a configuration key that decides which
// bytes from this repository are copied into a shipped package. Nothing in `frontend/src` had
// ever read that file before this spec: `grep -rln "tauri.conf" frontend/src frontend/scripts`
// returned two hits and both were prose inside comments. So every claim the roadmap makes about
// the bundle was, until now, a claim no gate could contradict.
//
// WHAT WOULD MAKE THIS SPEC VACUOUS, named so the next reader can check it has not happened.
//
//   1. Keeping a COPY of the expected configuration here. A transcribed config is a second
//      declaration that agrees with itself; it would stay green after the real array changed.
//      Every expectation below is either derived from the parsed file, derived from the
//      generator's own declared inputs, or a threshold the requirement states in words.
//      `icons/128x128.png` appears nowhere in this file outside this comment, and a gate in
//      plan 81-03's task 2 asserts that over the comment-stripped source.
//   2. Asserting only what `lockup.test.ts:127` already asserts. That case covers LIC-06, the
//      OFL text sitting beside the font binary IN THE REPOSITORY, and it has been green since
//      phase 80. LIC-04's subject is the PACKAGE. Test 7 is the case that keeps the two apart:
//      it asserts the DESTINATION each attribution file takes inside the bundle, which is a
//      property of the bundle and of nothing else.
//   3. Reading a PNG's size off its FILENAME. A filename is a claim; the IHDR is the file.
//      `pngWidth` below parses the real header bytes. `capture-lockup-hero.ts` already exports
//      `identifyPng`, and it was read before this reader was written: it shells out to
//      `magick identify` via `execFileSync`, which no vitest spec in `frontend/src` does and
//      which the ubuntu `unit` CI job has no ImageMagick for. Same reasoning as plan 81-01's
//      rasteriser fork - the assertion belongs in the unit job, so it reads bytes itself.
//   4. Predicates inlined into the `it` bodies. `missingResourceSources` and `firstPngWidth`
//      are module-level functions precisely so the last two cases can run them against MUTANTS
//      and watch them reject. A predicate that only ever sees correct input is a predicate
//      nobody has proven can say no.
//
// THIS SPEC WRITES NOTHING, to the tree or to a temp dir. The mutations are made on in-memory
// copies of the parsed object. Other processes may share this working tree; a spec that
// rewrote `crates/fabrico-app/tauri.conf.json` on every `npx vitest run` would corrupt it the
// first time two runs overlapped, which is the retirement `lockup.test.ts` records twice.
//
// No `@vitest-environment` docblock. The project default is the node environment, which is what
// lets this spec touch disk and resolve paths from `import.meta.dirname` without the jsdom
// `URL` trap documented at `vertexBudget.test.ts:66-92`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_PATH, NOTICE_PATH } from '../../../scripts/build-lockup.ts';

/* ------------------------------------------------------------------ *
 * The subject, read from disk
 * ------------------------------------------------------------------ */

/**
 * `crates/fabrico-app/tauri.conf.json`. Four levels up from `render/assets/` is the repository
 * root: `assets` -> `render` -> `src` -> `frontend`.
 */
const CONFIG_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'crates',
  'fabrico-app',
  'tauri.conf.json',
);

/**
 * Every relative path in `bundle.icon` and `bundle.resources` is resolved by `tauri-build`
 * against the directory holding the config, never against the process CWD. Resolving them the
 * same way here is what makes "this source exists" mean the same thing to the spec and to the
 * bundler.
 */
const CONFIG_DIR = dirname(CONFIG_PATH);

interface BundleConfig {
  readonly active?: unknown;
  readonly targets?: unknown;
  readonly icon?: unknown;
  readonly resources?: unknown;
}

const BUNDLE = (JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { bundle: BundleConfig }).bundle;

/* ------------------------------------------------------------------ *
 * The three attribution files, located rather than transcribed
 * ------------------------------------------------------------------ */

/**
 * The OFL text, derived from the binary it covers rather than from a second hard-coded path.
 * This is `lockup.test.ts:99`'s idiom verbatim, and for its reason: the licence obligation
 * attaches to exactly the font file whose outlines the brand artefacts are made of, so deriving
 * the licence path from `FONT_PATH` states the relationship instead of restating a path.
 */
const LICENCE_PATH = join(dirname(FONT_PATH), 'OFL-1.1-MartianMono.txt');

/**
 * The Sono OFL text (2026-10-11). Sono.woff2 sits beside Martian Mono and is embedded
 * in every binary too, so its licence is owed in the package on the same terms. Located beside
 * the same font directory rather than by a second hard-coded root.
 */
const SONO_LICENCE_PATH = join(dirname(FONT_PATH), 'OFL-1.1-Sono.txt');

/**
 * The complete set of genuinely third-party artefacts in this tree, as absolute paths. All three
 * derive from `build-lockup.ts`'s own exported inputs, so a move of any file breaks the import
 * or the derivation rather than leaving a stale literal here agreeing with nothing.
 *
 * Every SVG asset in this repository is authored from scratch under ART-04; the two embedded
 * fonts, Martian Mono and Sono, are the only things here somebody else wrote. NOTICE.md covers
 * both faces; each has its own OFL text.
 */
const ATTRIBUTION_FILES = [NOTICE_PATH, LICENCE_PATH, SONO_LICENCE_PATH].map((p) => resolve(p)).sort();

/** The directory the bundle icons live in, used only to build test 8's reorder mutant. */
const ICON_DIR = resolve(CONFIG_DIR, 'icons');

/**
 * D-13 / RESEARCH F-2. On Unix targets `default_window_icon` is
 * `find_icon(..., |i| i.ends_with(".png"), ...)` and `find_icon` is `.find()`, which takes the
 * FIRST match (`tauri-codegen-2.6.3/src/context.rs:233-241, 495-508`). So the first `.png` in
 * `bundle.icon` is the image the desktop window and `tauri dev` wear on Linux. The roadmap
 * implies the array order matters only on Windows. It is wrong, and this number is the
 * correction made checkable: 128 is the smallest layer the phase treats as a window icon, and
 * anything below it is a small cut upscaled.
 */
const MIN_WINDOW_ICON_WIDTH = 128;

/**
 * ICON-05's three sizes, as WIDTHS rather than as filenames.
 *
 * These are the layers the requirement calls hand-tuned: 16 and 24 are cut from the 16 unit
 * optical drawing rather than downscaled from the master, and 48 is the largest size a Linux
 * panel commonly asks for. Held as numbers because every check below reads a PNG's own IHDR, so
 * a file whose name promises 16 and whose header says 512 fails rather than passes.
 */
const SMALL_LAYER_WIDTHS = [16, 24, 48] as const;

/* ------------------------------------------------------------------ *
 * The predicates. Factored out so the mutation cases can run them.
 * ------------------------------------------------------------------ */

/** `bundle.resources` in its map form, or `null` when the key is absent or in the array form. */
function resourceMap(bundle: BundleConfig): Record<string, string> | null {
  const raw = bundle.resources;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, string>;
}

/** `bundle.icon` as a string array, or `null` when the key is absent or the wrong shape. */
function iconList(bundle: BundleConfig): string[] | null {
  const raw = bundle.icon;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) return null;
  return raw as string[];
}

/**
 * Every `bundle.resources` SOURCE that does not resolve to an existing file.
 *
 * This assertion is deliberately independent of how the bundler behaves. Plan 81-03 measured
 * RESEARCH assumption A3 and a missing source does fail the build, in the `tauri-build` build
 * script with `resource path ... doesn't exist` / `failed to build app` rather than in the
 * bundler with `failed to bundle project`. The gate still asserts existence itself, because a
 * config key naming a file nobody checked is exactly the vacuous shape this phase's validation
 * document refuses, and because the measurement was taken on one bundler version on one box.
 */
function missingResourceSources(map: Record<string, string>, configDir: string): string[] {
  return Object.keys(map).filter((source) => !existsSync(resolve(configDir, source)));
}

/** The eight-byte PNG signature, `\x89PNG\r\n\x1a\n`. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG's pixel width, read from its own IHDR: bytes 16 to 20, big-endian, immediately after
 * the eight-byte signature, the four-byte chunk length and the four-byte chunk type. Throws
 * rather than returning a number when the file is not a PNG or does not open with IHDR, so a
 * renamed `.jpg` reddens loudly instead of yielding a plausible integer.
 */
function pngWidth(path: string): number {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${path} does not open with the PNG signature`);
  }
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error(`${path} does not carry IHDR as its first chunk`);
  }
  return bytes.readUInt32BE(16);
}

/**
 * The width of the first `bundle.icon` entry ending `.png`, which is the entry `find_icon`
 * picks. `null` when the array names no PNG at all.
 *
 * An absolute entry is used as-is, matching Rust's `Path::join`, which discards the base when
 * the joined path is absolute. `resolve` has the same rule.
 */
function firstPngWidth(icons: readonly string[], configDir: string): number | null {
  const first = icons.find((entry) => entry.endsWith('.png'));
  if (first === undefined) return null;
  return pngWidth(resolve(configDir, first));
}

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

describe('the bundle configuration is machine-readable and asserted', () => {
  it('has bundling switched on, as a boolean rather than a truthy string', () => {
    // ICON-01's precondition. `toBe(true)` and not `toBeTruthy()`: the string "false" is
    // truthy, and a config that carried it would ship no installer while passing a looser
    // assertion. Mutation: flip the key to `false` and this is the case that fires.
    expect(BUNDLE.active).toBe(true);
  });

  it('pins the bundle target to deb rather than leaving it at the all default', () => {
    // RESEARCH S5's unmeasured risk, closed by pinning. With `"all"` a bare `tauri build` on
    // Linux attempts deb + rpm + appimage; `rpmbuild` and `appimagetool` are absent on the
    // development box and AppImage downloads its tooling over the network. Leaving `"all"` and
    // relying on a `--bundles deb` flag makes the correct command undiscoverable, so the
    // config carries the decision. The shape is asserted as well as the contents, because
    // `targets` accepts the bare string `"all"` and `["all"].includes` would not catch it.
    expect(Array.isArray(BUNDLE.targets)).toBe(true);
    expect(BUNDLE.targets).toEqual(['deb']);
  });

  it('names exactly the three third-party attribution files in bundle.resources (LIC-04)', () => {
    // THE MAP FORM IS LOAD-BEARING, not a style preference: the array form cannot rename or
    // nest, and LIC-04's destination is a subdirectory. `resourceMap` returns null on the array
    // form, so the first expectation is what catches a well-meaning simplification to
    // `["../../frontend/src/assets/fonts/NOTICE.md"]`.
    //
    // The expected set is DERIVED, from `build-lockup.ts`'s own exported `FONT_PATH` and
    // `NOTICE_PATH`. Transcribing the source strings here would make this case agree with a
    // copy of the config; deriving them makes it agree with the files the licence is actually
    // owed on. A FOURTH entry reddens this too, which is the guard against a glob or a
    // directory sweep quietly putting the 23KB woff2 binary in a licence folder.
    const map = resourceMap(BUNDLE);
    expect(map, 'bundle.resources is absent or in the array form, which cannot nest').not.toBeNull();
    const sources = Object.keys(map!)
      .map((source) => resolve(CONFIG_DIR, source))
      .sort();
    expect(sources).toEqual(ATTRIBUTION_FILES);
  });

  it('names no bundle.resources source that is missing from disk', () => {
    // See `missingResourceSources` on why this is asserted here rather than delegated to the
    // bundler. The empty-array form is used rather than a length check so a failure message
    // NAMES the missing path.
    const map = resourceMap(BUNDLE);
    expect(map).not.toBeNull();
    expect(missingResourceSources(map!, CONFIG_DIR)).toEqual([]);
  });

  it('names no bundle.icon entry that is missing from disk (D-12)', () => {
    // D-12 / RESEARCH F-3, measured: a file named in `bundle.icon` that does not exist is a
    // HARD bundle failure - `failed to bundle project: ... resource path ... doesn't exist` -
    // not a warning. So a plan that extends this array in one commit and writes the files in
    // the next leaves a red build in between. This case is what makes that mistake visible in
    // the unit suite instead of at the next release.
    const icons = iconList(BUNDLE);
    expect(icons, 'bundle.icon is absent or is not an array of strings').not.toBeNull();
    expect(icons!.filter((entry) => !existsSync(resolve(CONFIG_DIR, entry)))).toEqual([]);
  });

  it('lists a window-sized PNG first, proven from that file IHDR and not from its name (D-13)', () => {
    // The assertion nobody would think to write, and the one that is load-bearing on Linux.
    // See `MIN_WINDOW_ICON_WIDTH` for the two lines of `tauri-codegen` that make array order
    // decide the desktop window icon on this platform.
    const icons = iconList(BUNDLE);
    expect(icons).not.toBeNull();
    const width = firstPngWidth(icons!, CONFIG_DIR);
    // The message names no path: `find_icon`'s fallback is a tauri default, and a literal here
    // would survive this file's own comment-strip gate as a transcribed icon path.
    expect(width, 'bundle.icon names no .png at all, so Linux falls back to the tauri default').not.toBeNull();
    expect(width!).toBeGreaterThanOrEqual(MIN_WINDOW_ICON_WIDTH);
  });

  it('names exactly one Windows container and exactly one macOS container (ICON-04, ICON-06)', () => {
    // EXACTLY ONE OF EACH, not at least one. `find_icon` is `.find()` and takes the first match
    // (`tauri-codegen-2.6.3/src/context.rs:495-508`), so a second `.ico` in the array is a file
    // the bundler copies and nothing ever reads: a silent second source of truth for the Windows
    // window icon, which is the shape ICON-06 exists to prevent. The same reasoning applies to
    // the `.icns` on macOS.
    //
    // Counted by suffix rather than by naming a path, so this stays true when a container is
    // renamed and reddens when one is duplicated.
    const icons = iconList(BUNDLE);
    expect(icons).not.toBeNull();
    expect(icons!.filter((entry) => entry.endsWith('.ico'))).toHaveLength(1);
    expect(icons!.filter((entry) => entry.endsWith('.icns'))).toHaveLength(1);
  });

  it('transcribes no icon path of its own, which is the property its header claims', () => {
    // The module header says `icons/128x128.png` appears nowhere in this file outside that
    // comment. Until now the only thing holding it was a shell `grep` inside plan 81-03's
    // task 2, which ran once during execution and does not run again - the same shape as
    // 81-REVIEW.md WR-03, where a header claimed a spec the tree did not carry. The claim is
    // cheap to make true, so it is made true here.
    //
    // THE BANNED SET IS DERIVED FROM THE PARSED CONFIG, not listed. A list here would be the
    // transcription the property forbids, one level out, and it would stop following the array.
    const declared = iconList(BUNDLE);
    expect(declared, 'bundle.icon did not parse, so this case is vacuous').not.toBeNull();
    expect(declared, 'bundle.icon is empty, so this case is vacuous').not.toEqual([]);

    const own = readFileSync(resolve(import.meta.dirname, 'tauriBundle.test.ts'), 'utf8');
    const code = own
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code, 'the comment stripper removed the code as well as the comments').toContain(
      'iconList(BUNDLE)',
    );

    for (const entry of declared!) {
      expect(
        code,
        `${entry} is transcribed into this spec, so the assertions agree with a copy of the config rather than with the config`,
      ).not.toContain(entry);
    }
  });

  it('names PNGs at the three small sizes, proven from their IHDRs and not their names (ICON-05)', () => {
    // WHAT THIS CASE DOES NOT PROVE, stated because its old title said it did (81-REVIEW.md
    // IN-06). It asserts that `bundle.icon` names PNGs whose IHDRs report 16, 24 and 48 pixels
    // wide. A master downscaled to 16 pixels satisfies that identically. The HAND-TUNING claim
    // is carried elsewhere and the chain is closed, just not here: `iconCuts.test.ts`'s byte
    // identity case over `ICON_OUTPUTS` combined with `LADDER`'s `cut: 'small'` entries, and
    // `icon16Cut.test.ts`'s departure assertion, are what prove the small layers are drawn on
    // their own grid rather than resampled.
    //
    // ICON-05's subject is the SMALL END of the ladder: the 16, 24 and 48 pixel layers, which
    // are the ones a bare `tauri icon` call would flatten out of a single input, and the ones
    // the hicolor tree in the `.deb` carries into a panel and a window decoration.
    //
    // EVERY WIDTH IS READ FROM THE FILE, never from the entry string. A filename is a claim;
    // the IHDR is the file. An entry called `icons/16x16.png` carrying a 512 pixel render would
    // satisfy a filename match and would ship an image the panel downsamples badly.
    const icons = iconList(BUNDLE);
    expect(icons).not.toBeNull();

    const widths = icons!
      .filter((entry) => entry.endsWith('.png'))
      .map((entry) => pngWidth(resolve(CONFIG_DIR, entry)));

    for (const required of SMALL_LAYER_WIDTHS) {
      expect(
        widths,
        `bundle.icon names no PNG whose IHDR reports ${String(required)} pixels wide`,
      ).toContain(required);
    }
  });

  it('still lists a window-sized PNG first now that the array names several (D-13)', () => {
    // The predicate two cases above is the same one, and this case is what stops it going
    // vacuous as the array grows. When `bundle.icon` held a single entry, `.find()` had no
    // choice to get wrong; with several PNGs in it there is a real ordering and a real way to
    // ship a 16 pixel image as the Linux window icon.
    //
    // The floor is asserted FIRST, in terms of the file rather than a transcribed count: more
    // than one PNG must be present, or the ordering claim below proves nothing.
    const icons = iconList(BUNDLE);
    expect(icons).not.toBeNull();

    const pngs = icons!.filter((entry) => entry.endsWith('.png'));
    expect(
      pngs.length,
      'bundle.icon names at most one PNG, so there is no ordering for this case to be about',
    ).toBeGreaterThan(1);

    // And at least one of them is below the window-icon floor, so the array genuinely contains
    // something that would be wrong in first place. Without this, an array of nothing but large
    // layers would pass while demonstrating nothing.
    const widths = pngs.map((entry) => pngWidth(resolve(CONFIG_DIR, entry)));
    expect(
      Math.min(...widths),
      'every PNG in bundle.icon is already window-sized, so the ordering carries no risk here',
    ).toBeLessThan(MIN_WINDOW_ICON_WIDTH);

    expect(firstPngWidth(icons!, CONFIG_DIR)!).toBeGreaterThanOrEqual(MIN_WINDOW_ICON_WIDTH);
  });

  it('maps each attribution file to a nested destination inside the package, which LIC-06 cannot cover', () => {
    // THIS IS THE CASE THAT STOPS LIC-04 COLLAPSING INTO LIC-06. `lockup.test.ts:127` already
    // asserts the OFL text sits beside the font binary in the repository, and it is already
    // green, so asserting the same property again would be a requirement satisfied by work
    // finished a phase ago. What this case asserts instead exists only in the shipped package:
    // the path each file takes INSIDE it.
    //
    // Three properties, none of them a transcription. Every destination is relative, so it
    // nests under the resource directory rather than escaping to an absolute install path (that
    // is what `bundle.linux.deb.files` is for, and it is not portable). Every destination sits
    // under `attribution/`, so a reader of the installed tree finds the licences in one place.
    // And every destination keeps its source's own filename, so `OFL-1.1-MartianMono.txt` is
    // still recognisable as the Martian Mono licence after the copy rather than becoming an
    // anonymous `LICENSE`.
    //
    // The measured install root for these is `/usr/lib/Fabrico/attribution/` - `productName`,
    // capital F, NOT the binary name `fabrico-app` - and `tauri-utils-2.9.3/src/platform.rs:306-312`
    // resolves it as `exe_dir/../lib/Fabrico`, so a `~/.local/bin` install reaches
    // `~/.local/lib/Fabrico/attribution/` and the obligation is paid there too.
    const map = resourceMap(BUNDLE);
    expect(map).not.toBeNull();
    const entries = Object.entries(map!);
    expect(entries.length).toBe(ATTRIBUTION_FILES.length);
    for (const [source, destination] of entries) {
      expect(isAbsolute(destination), `${destination} is absolute and would escape the resource dir`).toBe(false);
      expect(destination.startsWith('attribution/'), `${destination} is not under attribution/`).toBe(true);
      expect(basename(destination)).toBe(basename(source));
    }
    expect(new Set(entries.map(([, destination]) => destination)).size).toBe(entries.length);
  });

  it('THE GATE CAN FAIL: reordering bundle.icon so a small cut comes first is rejected', () => {
    // The mutant is an in-memory copy. Nothing is written to `crates/fabrico-app/`.
    //
    // The small PNG is FOUND rather than named: the narrowest committed icon is located by
    // reading every IHDR in the directory. Naming one would be a transcription with the same
    // decay as any other, and the set of committed cuts changes in plan 81-04.
    const committed = readdirSync(ICON_DIR)
      .filter((file) => file.endsWith('.png'))
      .map((file) => ({ file, width: pngWidth(join(ICON_DIR, file)) }))
      .sort((a, b) => a.width - b.width);
    const narrowest = committed[0];
    expect(narrowest, 'crates/fabrico-app/icons/ holds no PNG at all').toBeDefined();

    // The mutation's own non-vacuity floor. If every committed cut were already at least
    // 128 wide there would be nothing to reorder INTO first place, and the case below would
    // pass while demonstrating nothing.
    expect(
      narrowest!.width,
      `the narrowest committed icon is ${String(narrowest!.width)}px, so this mutation has no small cut to promote`,
    ).toBeLessThan(MIN_WINDOW_ICON_WIDTH);

    const icons = iconList(BUNDLE)!;
    const mutant = [join('icons', narrowest!.file), ...icons];
    expect(firstPngWidth(mutant, CONFIG_DIR)).toBeLessThan(MIN_WINDOW_ICON_WIDTH);

    // And the same predicate, in the same run, accepting the real array. Both directions, so
    // the case cannot be read as a predicate that merely refuses everything.
    expect(firstPngWidth(icons, CONFIG_DIR)!).toBeGreaterThanOrEqual(MIN_WINDOW_ICON_WIDTH);
  });

  it('THE GATE CAN FAIL: a bundle.resources source that does not exist is named back', () => {
    // Second mutant, same discipline: an in-memory copy, and the absent path is DERIVED from a
    // real one by suffixing it, so nothing here is a path literal that could rot.
    const map = resourceMap(BUNDLE)!;
    const absent = `${Object.keys(map)[0]!}.THIS-FILE-DOES-NOT-EXIST`;
    const mutant = { ...map, [absent]: 'attribution/THIS-FILE-DOES-NOT-EXIST' };

    expect(missingResourceSources(mutant, CONFIG_DIR)).toEqual([absent]);
    // Both directions again: the real map, run through the same predicate in the same case.
    expect(missingResourceSources(map, CONFIG_DIR)).toEqual([]);
  });
});
