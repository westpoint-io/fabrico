// @vitest-environment jsdom
//
// THE COMMITTED GEOMETRY DIGEST TABLE (VEC-05, plan 56-05): one SHA-256 per authored
// vector asset, over that asset's tessellated vertex and index buffers.
//
// WHY THIS FILE EXISTS. The repo's render-regression gate is a set of Playwright PNG
// baselines at `maxDiffPixels: 0`. Those are excellent at answering "did anything
// move?" and useless at answering "WHICH asset moved?" - a full-surface diff reddens
// on one pixel and points at a whole screenshot. This table localises a geometry
// change to a FILE, with no browser, no GL and no screenshot involved: the assets are
// tessellated on the CPU, so the fingerprint is available long before rasterisation.
//
// WHAT IT DOES NOT COVER, stated so nobody mistakes it for the pixel gate. It sees
// GEOMETRY only. A colour change, a stroke-width change that does not alter
// tessellation, a z-order change, a compositing or blend change and every rasteriser
// difference are all invisible here and all visible to the PNG baselines. The two
// gates are complements: the digest says WHICH file, the baselines say WHAT it looked
// like. Digests are ADDITIVE this phase; no existing pixel baseline is retired.
//
// SHA-256 is used here as a change-detection digest and it is not a security primitive.
// There is no key, no secret, no signature and no adversary in this model -
// the only thing being detected is an accidental change to a locally-computed float
// buffer, and the assets it covers are first-party and committed. A future security
// audit should not misread this `node:crypto` import as a cryptographic control.
// (`svgAssets.ts` deliberately does NOT hold this helper: that module is imported by
// `spike/pixelGuard.tsx` and therefore ships in the browser bundle, where a Node
// builtin cannot go. `synth/beltPainter.digest.test.ts` holds its own helper for the
// same reason and this file follows it.)
//
// THE RE-BLESS RULE (Phase-54 discipline, unchanged). A red digest is INVESTIGATED,
// never absorbed. If the change is deliberate - Phase 57/58 re-arting an asset - then
// the implementation, any regenerated PNG baselines and this table land in ONE commit,
// with the baselines regenerated under `CI=1`, and no gate is loosened to make it fit.
// A digest edited on its own, in its own commit, is the exact anti-pattern this table
// exists to catch. Values are GENERATED from the implementation, never hand-authored.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureSvg, type Measurement } from '../svgAssets.ts';
import { PILOT_SVG } from '../../spike/pilotFixture.ts';
import { iconElements, type IconRenderOpts } from '../../chrome/svgToElements.ts';

/**
 * `render/assets/` and its committed digest table.
 *
 * `import.meta.dirname` rather than `fileURLToPath(new URL('./', import.meta.url))`:
 * under jsdom the global `URL` resolves a relative base against the DOCUMENT base URI,
 * yielding an `http://localhost:3000/...` href that `fileURLToPath` rejects. Same trap,
 * same fix, as `vertexBudget.test.ts`.
 */
const ASSET_DIR = import.meta.dirname;
const DIGEST_PATH = join(ASSET_DIR, '__digests__', 'geometry.digest.json');

/**
 * THE COMMITTED TABLE'S OWN SIZE, as a stated literal - never `Object.keys(...).length`
 * and never `discoverAssets().length`.
 *
 * An assertion derived from the thing it checks cannot fail. A discovery that silently
 * returned nothing would produce an empty table, compare it against itself and report
 * a clean green for a gate covering zero assets. Adding an asset means editing this
 * number by hand, which is exactly the moment a human should be looking at the table.
 */
// 1 -> 2 in plan 58-01: `tee.svg`, the first SHIPPED machine asset, joins `pilot.svg`.
// 2 -> 9 in plan 58-02: the seven remaining shipped subjects (`balancer`, `endpoint`,
// `factory`, `merge`, `router`, `sink`, `source`) join them. Nine is the FINAL shipped
// figure for this milestone - eight machine subjects plus the permanent calibration
// fixture - not a running total, because the chassis is drawn in code and there is
// therefore no per-footprint or per-state asset variant to add later.
const EXPECTED_DIGEST_ENTRIES = 9;

/**
 * The SAME non-recursive, sorted `.svg` discovery `scripts/lint-svg.ts` and
 * `vertexBudget.test.ts` use, so all three agree on which files count. Non-recursive
 * keeps `__fixtures__/` (deliberately over-budget, deliberately non-conforming files)
 * out of the table, which is what lets the key-set assertion below be an EQUALITY
 * rather than a subset check.
 */
function discoverAssets(): string[] {
  return readdirSync(ASSET_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.svg'))
    .map((e) => e.name)
    .sort();
}

/**
 * The geometry digest of one measured asset.
 *
 * `geometryData.vertices` and `geometryData.indices` are PLAIN JS number arrays, not
 * typed arrays, so the typed views are constructed here rather than borrowed.
 *
 * QUANTISATION: `Math.round(v * 256) / 256`, a 1/256 unit quantum. One unit is one
 * pixel at CELL 32 / scale 1, so the quantum is far below a device pixel: it kills
 * float noise from the tessellator without being able to hide a real geometry change,
 * which would have to move a vertex by less than 1/256 px to slip through. `Math.round`
 * is HALF-UP on ties (`Math.round(-0.5)` is `-0`, `Math.round(0.5)` is `1`) - that
 * asymmetry is the recorded rounding contract, not an accident.
 *
 * LENGTH PREFIX: `uint32(vertexByteLength)` is hashed first so the vertex/index split
 * is unambiguous. Without it, an asset whose vertex buffer shrank by exactly as much as
 * its index buffer grew could collide on the concatenation alone.
 *
 * ENDIANNESS is recorded rather than discovered: the prefix is written little-endian to
 * match the native byte order of the typed arrays on every platform this ships to
 * (x86-64 and aarch64 are both little-endian). A big-endian host would compute
 * different digests for identical geometry, and would need a re-bless plus this note
 * updated - it is a portability property of the table, not a defect in it.
 */
function digestOf(m: Measurement): string {
  const vertices = Float32Array.from(m.vertices, (v) => Math.round(v * 256) / 256);
  const indices = Uint32Array.from(m.indices);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(vertices.byteLength, 0);
  return createHash('sha256')
    .update(prefix)
    .update(Buffer.from(vertices.buffer, vertices.byteOffset, vertices.byteLength))
    .update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength))
    .digest('hex');
}

/** Short form for MESSAGES only. The full 64 hex characters live in the file. */
const short = (d: string): string => d.slice(0, 8);

/**
 * Every discovered asset's digest, in a FIXED enumeration order.
 *
 * Sorted path order, produced by an explicit loop over a sorted array - NEVER object-key
 * iteration. The table's order is then a property of this function and not of a JS
 * engine's insertion-order rules or of a filesystem's readdir order, which is what makes
 * the committed JSON byte-deterministic and its diff the signal.
 */
function computeDigestTable(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of discoverAssets()) {
    out[name] = digestOf(measureSvg(readFileSync(join(ASSET_DIR, name), 'utf8')));
  }
  return out;
}

/** The committed table, read off disk (raw text kept for the format assertions). */
const COMMITTED_RAW = readFileSync(DIGEST_PATH, 'utf8');
const COMMITTED: Record<string, string> = JSON.parse(COMMITTED_RAW);

/**
 * Key-set comparison in BOTH directions. A subset check would let an asset be added
 * with no digest (silent zero coverage on the newest file); a superset check would let
 * a deleted asset keep a stale entry that nothing ever recomputes (dead coverage that
 * still reads as a passing row).
 */
function keySetDiff(
  committed: string[],
  discovered: string[],
): { missing: string[]; extra: string[] } {
  const c = new Set(committed);
  const d = new Set(discovered);
  return {
    missing: discovered.filter((k) => !c.has(k)).sort(),
    extra: committed.filter((k) => !d.has(k)).sort(),
  };
}

describe('the geometry digest table pins every authored asset', () => {
  it('recomputes to the committed table EXACTLY, reporting every mismatch at once', () => {
    // ONE whole-object comparison, deliberately: a per-asset loop would fail on the
    // first mismatching file and force a run per offender. This names them all.
    expect(
      computeDigestTable(),
      'an asset\'s tessellated geometry changed. INVESTIGATE before re-blessing: if this ' +
        'is deliberate re-arting, the implementation, any regenerated PNG baselines and ' +
        'this table land in ONE commit (regenerated with CI=1, no gate loosened). A ' +
        'digest edited on its own is the anti-pattern this table exists to catch.',
    ).toEqual(COMMITTED);
  });

  it('holds the committed number of entries, as a stated literal', () => {
    expect(Object.keys(COMMITTED)).toHaveLength(EXPECTED_DIGEST_ENTRIES);
    expect(discoverAssets()).toHaveLength(EXPECTED_DIGEST_ENTRIES);
  });

  it('refuses a vacuous pass: neither side may be empty', () => {
    // A zero-entry table would compare equal to a zero-asset walk and report the
    // cleanest green in the suite while covering nothing at all.
    expect(Object.keys(COMMITTED).length).toBeGreaterThanOrEqual(1);
    expect(discoverAssets().length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(computeDigestTable()).length).toBeGreaterThanOrEqual(1);
  });

  it('every value is a full 64-character lowercase hex SHA-256', () => {
    for (const [name, value] of Object.entries(COMMITTED)) {
      expect(value, `${name} digest is not a full sha256 hex string`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('the table key set EQUALS the discovered asset set, in both directions', () => {
  it('has no missing and no extra keys today', () => {
    const diff = keySetDiff(Object.keys(COMMITTED), discoverAssets());
    expect(
      diff,
      `digest table drift. Missing (asset added with no digest): ${diff.missing.join(', ') || 'none'}. ` +
        `Extra (stale entry for a deleted asset): ${diff.extra.join(', ') || 'none'}.`,
    ).toEqual({ missing: [], extra: [] });
    expect(Object.keys(COMMITTED).sort()).toEqual(discoverAssets());
  });

  it('reddens for a SUBSET - an asset added with no digest entry', () => {
    // The comparison itself is exercised, so the assertion above cannot be passing
    // because `keySetDiff` is broken and returns empty arrays for everything.
    const diff = keySetDiff([], discoverAssets());
    expect(diff.missing).toEqual(discoverAssets());
    expect(diff.extra).toEqual([]);
    expect(diff).not.toEqual({ missing: [], extra: [] });
  });

  it('reddens for a SUPERSET - a stale entry for an asset that no longer exists', () => {
    const diff = keySetDiff([...Object.keys(COMMITTED), 'deleted-machine.svg'], discoverAssets());
    expect(diff.extra).toEqual(['deleted-machine.svg']);
    expect(diff.missing).toEqual([]);
    expect(diff).not.toEqual({ missing: [], extra: [] });
  });
});

describe('a deliberate geometry change reddens the digest', () => {
  it('one mutated coordinate in the pilot produces a different digest', () => {
    // THE IN-MEMORY DEMONSTRATION, AS A PERMANENT TEST rather than a
    // commit-and-revert. A gate whose sensitivity was checked once, by hand, and
    // then thrown away is a gate nobody can re-verify. This mutates the pilot's raw
    // text IN MEMORY - the file on disk and the shared `getPilotContext()`
    // context are untouched.
    //
    // WHAT IT PROVES, AND WHAT IT DOES NOT (plan 58-04). It proves the digest is
    // SENSITIVE: a one-unit coordinate move changes it. It does NOT prove the ART-05
    // property, which is that THE FILE IS THE SOURCE OF TRUTH - this case never
    // touches a file. The ON-DISK case in the next describe proves that one, and
    // neither replaces the other.
    //
    // The mutation is the frame's horizontal extent: `H29` becomes `H28`, a single
    // one-unit move of one coordinate, which is the smallest edit the authored format
    // permits (coordinates are integers).
    const mutated = PILOT_SVG.replace('H29', 'H28');
    expect(mutated, 'the pilot no longer contains the mutated coordinate').not.toBe(PILOT_SVG);
    expect(PILOT_SVG.split('H29')).toHaveLength(2); // exactly one occurrence, so exactly one edit

    const original = digestOf(measureSvg(PILOT_SVG));
    const changed = digestOf(measureSvg(mutated));

    expect(original).toBe(COMMITTED['pilot.svg']);
    expect(
      changed,
      `a one-unit coordinate change did NOT move the digest (${short(original)}). The gate ` +
        'is insensitive and would not catch a real art regression.',
    ).not.toBe(original);
    // Both are still well-formed digests - the difference is the geometry, not a throw.
    expect(changed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a change too small to matter is still caught, but sub-quantum noise is not', () => {
    // The quantum's two halves, asserted together so the trade-off is visible.
    // Above the quantum: a real move changes the digest (covered by the case above).
    // Below it: values within 1/256 of each other collapse to the same quantised
    // float, which is the float-noise immunity the quantisation is FOR.
    //
    // MEASURED ON A SYNTHETIC BUFFER, NOT ON THE LIVE PILOT (phase 56 review IN-04).
    // Adding 1/4096 shifts `v * 256` by 0.0625, which rounds back only while every
    // input sits AWAY from a `.5` tie. The pilot's vertices are all integers today, so
    // deriving this case from `measureSvg(PILOT_SVG)` was correct - by luck of the
    // subject, not by construction. The first asset with a stroke join or a curve puts
    // tessellator output near ties, and this assertion would then fail intermittently
    // with a message about digests that says nothing about rounding. The buffer below
    // states its own inputs, so the property under test is the QUANTUM and nothing else.
    //
    // Every value here multiplies by 256 to an exact integer (0, 256, 512, 896, 1856,
    // -1024, -3264), i.e. maximum distance from a tie in both directions, and the set
    // spans positive, negative and zero so the half-up asymmetry cannot hide.
    const base = measureSvg(PILOT_SVG);
    const synthetic: Measurement = {
      ...base,
      vertices: [0, 1, 2, 3.5, 7.25, -4, -12.75],
      indices: [0, 1, 2, 2, 1, 0],
    };
    const noisy: Measurement = {
      ...synthetic,
      vertices: synthetic.vertices.map((v) => v + 1 / 4096),
    };
    expect(digestOf(noisy)).toBe(digestOf(synthetic));

    // ... and the OTHER side of the same line, which pins the quantum's VALUE rather
    // than merely its existence. 1/64 is four quanta: above the noise floor, and still
    // 64x smaller than the smallest edit the authored format permits (coordinates are
    // integers, so a real authored change is at least 1 unit). Widen the quantum to
    // whole units and this collapses onto `synthetic` - the gate would then be blind to
    // every sub-unit geometry change a tessellator can produce, which is precisely
    // what a stroke join or a future curve WILL produce.
    const subUnit: Measurement = {
      ...synthetic,
      vertices: synthetic.vertices.map((v) => v + 1 / 64),
    };
    expect(digestOf(subUnit)).not.toBe(digestOf(synthetic));

    // The live pilot still gets the noise-immunity assertion, because the gate that
    // ships is the one over real geometry - it is simply no longer the ONLY subject.
    expect(digestOf({ ...base, vertices: base.vertices.map((v) => v + 1 / 4096) })).toBe(
      digestOf(base),
    );

    // ... and Math.round's half-up tie behaviour, pinned as the recorded contract.
    expect(Math.round(0.5)).toBe(1);
    expect(Math.round(-0.5)).toBe(-0);
  });

  it('is reproducible: two computations in one run yield identical digests', () => {
    expect(computeDigestTable()).toEqual(computeDigestTable());
    expect(digestOf(measureSvg(PILOT_SVG))).toBe(digestOf(measureSvg(PILOT_SVG)));
  });
});

/* ------------------------------------------------------------------ *
 * ART-05, PROVEN ON DISK (plan 58-04)
 * ------------------------------------------------------------------ */

/**
 * The subject the on-disk proof mutates, and the single coordinate it moves.
 *
 * `sink.svg`'s `ring` is `M 10 10 H 22 V 22 H 10 Z`; `V 22` occurs exactly ONCE in
 * the markup body and the case asserts that before writing anything, so the edit is
 * provably one coordinate and not a sweep. One unit is the smallest change the
 * authored format permits - every coordinate is an integer.
 */
const ART05_SUBJECT = 'sink.svg';
const ART05_FROM = 'V 22';
const ART05_TO = 'V 20';

/**
 * The placement options the DOM half is fed.
 *
 * `sink` is a 1x1 subject authored at 32u, which is the icon's own box, so the placement
 * scale is the identity and `stroke-width` is multiplied by 1. Stated rather than derived
 * because the DOM half must be a function of the FILE BYTES and nothing else: a scale
 * computed from the same text being mutated could absorb the mutation.
 */
const ICON_OPTS: IconRenderOpts = { strokeWidthScale: 1 };

/**
 * A STABLE serialisation of the emitted icon markup.
 *
 * Only the four things `svgToElements` can emit, in document order. Deliberately NOT
 * `JSON.stringify` of the React elements: those carry `$$typeof` symbols, a `key`, a
 * `ref` and internal fields, and comparing them would make this assertion sensitive to a
 * React version bump - which is the kind of noise that gets a gate loosened.
 */
function markupOf(svgText: string): string {
  return iconElements(svgText, ICON_OPTS)
    .map((el) => {
      const p = el.props as Record<string, unknown>;
      return [p['data-part'], p.d, p.fill ?? '', p.stroke ?? '', p.strokeWidth ?? ''].join('|');
    })
    .join('\n');
}

describe('ART-05: the SVG FILE is the source of truth, proven on disk', () => {
  /**
   * WHAT THIS ADDS OVER THE IN-MEMORY DEMONSTRATION ABOVE. That one proves the
   * digest is SENSITIVE to a geometry change. This one proves the ART-05 PROPERTY:
   * a contributor changes a machine's glyph by EDITING ONE SVG PATH FILE, with no code
   * change and no rebake step. Nothing above ever touches a file, so nothing above
   * can prove it. This is a small extension of proven code rather than new
   * machinery - `computeDigestTable` already reads every asset from disk through
   * `readFileSync` before measuring it.
   *
   * THE SCOPE, verbatim in intent from `58-CONTEXT.md`, because this is the one
   * place the requirement can be misread as failing: ART-05 IS VERIFIED AGAINST THE
   * GLYPH. The CHASSIS is a deliberately shared parametric primitive drawn in code
   * (`layers/machineChassis.ts`) at whatever `w x h` a grown footprint actually is,
   * and that consequence was accepted KNOWINGLY on 2026-08-02: the same option was
   * offered WITH a restatement of ART-05 attached and the version without it was
   * chosen. So ART-05's requirement text stays exactly as written and is not edited
   * here, and the narrowed scope is recorded here instead. The chassis is an
   * ACCEPTED DESIGN CONSEQUENCE, NOT AN ART-05 GAP, and must not be reported as one.
   *
   * THE BUILD-TIME-INLINING READING, stated so a later auditor finds a recorded
   * interpretation rather than an unstated hole. Assets reach the running app
   * through Vite's `?raw` transform (`render/svgAssets.ts`), which inlines the text
   * at BUILD time - so inside an already-built Tauri binary an SVG edit does nothing
   * until the frontend is rebuilt. ART-05 asks for no code change and no rebake
   * step; a rebuild is NEITHER, and `svgAssets.ts`'s own header frames build-time
   * inlining as the feature that REMOVES the rebake (there is no asset directory to
   * ship and no runtime fetch). The on-disk digest proves the property at the SOURCE
   * level, which is the strongest available reading and the one the requirement is
   * about: the artwork lives in the file, not in code.
   *
   * THERE IS NO MUTATION WINDOW ON THE TRACKED ASSET, because the tracked asset is
   * never written. This case used to write mutated bytes over the committed
   * `sink.svg` and restore them in a `finally`, which had two problems and only one
   * of them was recorded. The recorded one (WINDOWS ledger id 22) was the parallel-read
   * race: vitest runs spec FILES in separate worker processes and five other specs read
   * `render/assets/*.svg` from disk. The UNRECORDED and worse one was interruption - a
   * `finally` covers a thrown assertion, but NOT SIGINT, SIGTERM, an OOM kill or a
   * worker timeout, so a Ctrl-C in that window left committed artwork silently wrong in
   * the working tree and three specs reporting it as a tessellation failure.
   *
   * Both are now structurally impossible rather than accepted-and-measured: the
   * mutation is applied to a COPY in `mkdtempSync`, and the tracked file is only ever
   * `readFileSync`-ed. `measureSvg` takes file CONTENTS and cannot tell which path they
   * came from, so the "the artwork lives in the file" property is proven identically.
   * The temp directory is removed in a `finally`; if that ever leaks it costs a stale
   * directory under the OS temp root and nothing else.
   *
   * THE PARALLELISM PREMISE IS CONFIRMED, NOT ASSUMED (plan 59-02 re-checked it before
   * extending this case). `frontend/vitest.config.ts` declares only `environment` and
   * `include`; it sets no `pool`, no `isolate`, no `fileParallelism` and no
   * `maxWorkers`. Under vitest 4.1.9 that means the defaults apply - `pool: 'forks'`,
   * `isolate: true`, `fileParallelism: true` - so spec FILES genuinely do run
   * concurrently in separate worker processes, and at least six specs read
   * `render/assets/*.svg` from disk. If this case wrote the tracked file, the race would
   * be live rather than theoretical. The scratch copy is the ENTIRE safety story here,
   * and it has to be: a `finally` is not a defence against a concurrent READER, and it
   * is not a defence against SIGINT either. Do not "simplify" this back to a
   * write-and-restore.
   */
  it("writing ONE coordinate into the file on disk moves that file's digest AND its DOM markup", () => {
    const path = join(ASSET_DIR, ART05_SUBJECT);
    const original = readFileSync(path, 'utf8');
    const head = original.slice(0, original.indexOf('<svg'));
    const body = original.slice(original.indexOf('<svg'));

    // Exactly one occurrence IN THE MARKUP, asserted before anything is written.
    // The header docblock quotes `d` strings, so a whole-text replace would edit
    // prose as well as geometry - the "strip the header before scanning markup"
    // rule `shippedAssets.test.ts` established.
    expect(body.split(ART05_FROM), `${ART05_SUBJECT} body must contain exactly one '${ART05_FROM}'`).toHaveLength(2);
    const mutated = head + body.replace(ART05_FROM, ART05_TO);
    expect(mutated).not.toBe(original);
    expect(mutated).toHaveLength(original.length); // one digit for one digit

    // THE MUTATION HAPPENS ON A SCRATCH COPY, NEVER ON THE TRACKED ASSET (WR-10).
    //
    // This used to write `mutated` over the committed `sink.svg` and restore it in a
    // `finally`. A `finally` covers a thrown assertion; it does NOT cover SIGINT,
    // SIGTERM, an OOM kill or a vitest worker timeout. A Ctrl-C inside that window left
    // a piece of SHIPPED ARTWORK silently wrong in the developer's working tree, at
    // which point three specs go red with messages about tessellation rather than about
    // a half-finished test. It also raced five other specs that read the same file from
    // parallel workers (WINDOWS ledger id 22).
    //
    // Neither hazard is necessary. The property under test is "the pipeline reads the
    // artwork FROM A FILE, and editing that file moves the digest" - a copy in a temp
    // directory proves that exactly as well, because `measureSvg` is given a path's
    // contents and has no idea which path they came from. The committed asset is still
    // READ (below, for the `before` digest), so the ART-05 claim is unweakened; it is
    // simply never WRITTEN.
    const scratchDir = mkdtempSync(join(tmpdir(), 'fabrico-art05-'));
    const scratch = join(scratchDir, ART05_SUBJECT);
    let readBack = '';
    try {
      // The unmutated copy first, so the scratch file is proven to be a faithful
      // stand-in for the tracked one before it is edited.
      writeFileSync(scratch, original, 'utf8');
      expect(
        digestOf(measureSvg(readFileSync(scratch, 'utf8'))),
        'the scratch copy is not byte-equivalent to the tracked asset',
      ).toBe(COMMITTED[ART05_SUBJECT]);

      writeFileSync(scratch, mutated, 'utf8');
      readBack = readFileSync(scratch, 'utf8');
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }

    // The disk really held the edit - not a claim about what we wrote, a read of
    // what was there.
    expect(readBack, 'the file on disk did not carry the edit').toBe(mutated);
    expect(readBack).toContain(ART05_TO);

    // ... and the geometry the pipeline measures FROM THAT FILE moved. `before` is read
    // from the TRACKED asset (untouched throughout); `after` from the scratch edit.
    const before = digestOf(measureSvg(original));
    const after = digestOf(measureSvg(readBack));
    expect(before, `${ART05_SUBJECT} on disk no longer matches its committed digest`).toBe(
      COMMITTED[ART05_SUBJECT],
    );
    expect(
      after,
      `editing ${ART05_SUBJECT} ON DISK did not move its digest (${short(before)}). The ` +
        'artwork would then not live in the file, which is exactly what ART-05 asks for.',
    ).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{64}$/);

    // NO REBUILD AND NO REBAKE HAPPENED. Nothing in this case invoked Vite, a
    // bundler, a bake step or a cache invalidation: `readFileSync` then
    // `measureSvg`. That absence is the claim, so it is stated where it is true
    // rather than only in the docblock.

    // ------------------------------------------------------------------
    // THE DOM HALF, FROM THE SAME BYTES (CHROME-01, plan 59-02)
    // ------------------------------------------------------------------
    //
    // THE CLAIM IS A SHARED SHAPE, NOT A SHARED IMPORT, and the phrasing is the whole
    // point. Asserting that `icons.tsx` and the Pixi registry import the same module
    // would prove an IMPORT: it would stay green if the DOM half quietly stopped copying
    // the path data, or started normalising it, or reached for a second `?raw` table
    // naming the same files. What is asserted instead is that ONE edit to ONE file's
    // BYTES moves BOTH surfaces - the tessellated geometry digest Pixi would draw, and
    // the `<path>` markup React would mount - with neither surface told the other exists.
    //
    // `iconElements` is a pure `string -> ReactElement[]` seam for exactly this reason
    // (`chrome/svgToElements.ts:14-18`): it imports no `?raw` asset and no registry, so it
    // can be handed bytes that exist only in a scratch directory. A module that read its
    // own import could not be handed a mutated file at all.
    const domBefore = markupOf(original);
    const domAfter = markupOf(readBack);
    expect(domBefore.length, 'the DOM half emitted no markup at all').toBeGreaterThan(0);
    expect(
      domAfter,
      `editing ${ART05_SUBJECT} ON DISK moved its geometry digest but NOT the markup the ` +
        'DOM would mount. The two surfaces are then reading different shapes, whatever ' +
        'they import.',
    ).not.toBe(domBefore);
    // ... and specifically the coordinate, character for character. `d` is the one
    // attribute `svgToElements` never rewrites, so the edited byte must appear verbatim.
    expect(domBefore).toContain(ART05_FROM);
    expect(domAfter).toContain(ART05_TO);
    expect(domAfter).not.toContain(ART05_FROM);
  });

  it('leaves the tracked asset byte-identical - the no-write claim is CHECKED, not assumed', () => {
    // Runs AFTER the mutation case (vitest executes `it`s in a file sequentially), so
    // it is a genuine post-condition. Since WR-10 moved the mutation onto a scratch
    // copy this should be true by construction - which is exactly why it is still
    // asserted: "by construction" is the claim, and an unchecked claim about a file on
    // disk is how the previous version of this case justified itself too. If someone
    // re-points the mutation at ASSET_DIR, this reddens.
    const path = join(ASSET_DIR, ART05_SUBJECT);
    expect(digestOf(measureSvg(readFileSync(path, 'utf8')))).toBe(COMMITTED[ART05_SUBJECT]);
    expect(readFileSync(path, 'utf8')).toContain(ART05_FROM);
    expect(readFileSync(path, 'utf8')).not.toContain(ART05_TO);
    // The whole table too, so a restore that corrupted a DIFFERENT file would show.
    expect(computeDigestTable()).toEqual(COMMITTED);
  });

  it('the mutation is one coordinate, not a re-author: a NO-OP edit moves NEITHER half', () => {
    // The discriminator. Without it the case above would pass on a `digestOf` that
    // returned a fresh random value every call - which would "prove" sensitivity to
    // anything at all, including doing nothing.
    //
    // EXTENDED TO BOTH HALVES (plan 59-02) for the identical reason: without it, the DOM
    // assertion above would pass on a `markupOf` that emitted a timestamp. A gate that
    // fires on everything is not measuring the thing it names.
    const original = readFileSync(join(ASSET_DIR, ART05_SUBJECT), 'utf8');
    const cosmetic = original.replace('<svg ', '<svg  '); // whitespace only
    expect(cosmetic).not.toBe(original);
    expect(digestOf(measureSvg(cosmetic))).toBe(digestOf(measureSvg(original)));
    expect(markupOf(cosmetic)).toBe(markupOf(original));
    // Determinism of the DOM half on its own, too: the same bytes twice.
    expect(markupOf(original)).toBe(markupOf(original));
  });
});

describe('the committed JSON file is byte-deterministic', () => {
  it('has sorted keys, 2-space indent and exactly one trailing newline', () => {
    // The file's determinism is what makes its DIFF the signal. An unsorted or
    // differently-indented rewrite would show every asset as changed and bury the one
    // that actually did.
    expect(Object.keys(COMMITTED)).toEqual([...Object.keys(COMMITTED)].sort());
    expect(COMMITTED_RAW.endsWith('\n')).toBe(true);
    expect(COMMITTED_RAW.endsWith('\n\n')).toBe(false);
    // Re-serialising the parsed object with the recorded formatting reproduces the file
    // byte for byte - which also pins the 2-space indent without a regex.
    //
    // SORT THE OBJECT, DO NOT OVERLOAD `replacer` (phase 56 review IN-05). This used to
    // pass `Object.keys(COMMITTED).sort()` as `JSON.stringify`'s second argument, i.e.
    // the ARRAY form of `replacer` - a property ALLOWLIST that also happens to fix
    // emission order. Correct per spec and correct here, but it silently DROPS any key
    // not in the list, so the comparison would keep passing if the list ever stopped
    // covering the object - a byte-determinism assertion that can be satisfied by
    // omitting the very entry that changed. Sorting the entries first says the intent
    // outright and cannot drop anything.
    const sorted = Object.fromEntries(
      Object.entries(COMMITTED).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(Object.keys(sorted)).toHaveLength(Object.keys(COMMITTED).length);
    expect(COMMITTED_RAW).toBe(`${JSON.stringify(sorted, null, 2)}\n`);
  });

  it('is keyed by the asset file name relative to render/assets/', () => {
    for (const key of Object.keys(COMMITTED)) {
      expect(key).toMatch(/^[a-z][a-z0-9-]*\.svg$/);
      expect(key).not.toContain('/');
    }
  });
});

