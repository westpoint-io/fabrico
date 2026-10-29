// THE COMMITTED BELT GEOMETRY DIGEST TABLE (VEC-05, BELT-06 - plan 61-04): one
// SHA-256 per belt cache slot, over that slot's TESSELLATED vertex and index buffers.
//
// WHY THIS FILE EXISTS, AND WHY IT IS THIS PHASE'S PRIMARY REGRESSION LOCK. The belt
// went vector across plans 61-02 and 61-03, which retired the thing the Playwright
// pixel baselines were actually watching: a raster bake with committed bytes. A vector
// tile has no bytes until a rasteriser touches it, and the rasteriser this project
// ships on (WebKitGTK) will not launch on the development machine at all. What CAN be
// read, deterministically, on the CPU, with no browser and no GL, is the tessellation -
// the float vertex buffer Pixi builds before anything is drawn. That is what this table
// pins, per march bucket, across every belt family.
//
// WHAT IT DOES NOT COVER, stated so nobody mistakes it for the pixel gate. It sees
// GEOMETRY only. A colour change, a stroke-width change that does not alter
// tessellation, a z-order change, a compositing change and every rasteriser difference
// are all invisible here and visible to a PNG baseline. The two gates are complements:
// the digest says WHICH slot moved, a baseline says what it looked like.
//
// IT RUNS IN THE PROJECT'S DEFAULT NODE ENVIRONMENT AND MUST KEEP DOING SO. There is
// deliberately NO jsdom environment pragma at the top of this file, and its absence is
// load-bearing rather than an oversight. `render/assets/geometryDigest.test.ts` needs
// jsdom because it measures AUTHORED SVG, and Pixi's `SVGParser` calls
// `document.createElement` and `querySelector`. Nothing here parses SVG: a procedurally
// built `GraphicsContext` never touches a DOM, which the H7 spike measured and
// `belts.test.ts` relies on too. Adding jsdom back would pull a 37-package DOM
// dependency into a suite that provably does not need one - if a future reader is
// tempted, this paragraph is why not. (The pragma token itself is deliberately not
// spelled out anywhere in this file: Vitest scans the leading comment block for it, so
// even a prose mention of it could switch the environment this paragraph exists to
// keep.)
//
// SHA-256 is used here as a CHANGE-DETECTION digest and it is not a security primitive.
// There is no key, no secret, no signature and no adversary in this model - the only
// thing being detected is an accidental change to a locally computed float buffer, over
// first-party geometry this repo authors. A future security audit should not misread
// the `node:crypto` import as a cryptographic control. That import is TEST-FILE-LOCAL
// and must stay so: `beltGeometry.ts` and `beltPainter.ts` are browser-bundle modules
// and a Node builtin in either one breaks the Tauri desktop build (T-61-06).
//
// THE DIGEST FUNCTION IS COPIED VERBATIM FROM `render/assets/geometryDigest.test.ts`,
// AND THE SECOND COPY IS DELIBERATE RATHER THAN A DUPLICATION DEFECT. Its quantisation
// to a 256th of a pixel, its little-endian uint32 length prefix and its
// vertices-then-indices order are RECORDED CONTRACTS, not implementation details - see
// the docblock on `digestOf`. Each committed table has to be self-contained and
// re-blessable on its own, which a shared helper in a third module would break the
// moment one table needed a format change and the other did not. `beltPainter.digest.test.ts`
// holds its own copy for the same reason, and a fourth copy would be correct for the
// same reason again.
//
// THE RE-BLESS RULE (Phase-54 discipline, unchanged). A red digest is INVESTIGATED,
// never absorbed. If the change is deliberate, then the implementation, any regenerated
// PNG baselines and this table land in ONE commit, with baselines regenerated under
// `CI=1`, and no gate is loosened to make it fit. Values are GENERATED from the
// implementation via a temporary dump, never hand-authored. **A digest edited on its
// own, in its own commit, is the exact anti-pattern this table exists to catch.**

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GraphicsContext } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  BELT_MARCH_BUCKETS,
  BELT_MARCH_BUCKET_COUNTS,
  ARC_SAMPLES,
  LOD_ARC_SAMPLES,
  cornerCommands,
  cornerRailCommands,
  cornerTickCommands,
  railCommands,
  straightCommands,
  straightTickCommands,
  type BeltPathCommand,
} from './beltGeometry.ts';
import { SHIPPED_PAINTER } from './beltPainter.ts';
import { LOCKED_SKIN } from './skins/locked.ts';
import { VERTEX_LIMIT, VERTEX_WARN, measureContext, type Measurement } from '../svgAssets.ts';
import { CELL } from '../../../shared/geometry.ts';

const DIGEST_PATH = join(import.meta.dirname, '__digests__', 'belt.geometry.json');

/**
 * THE COMMITTED TABLE'S OWN SIZE, AS A STATED LITERAL - never a length taken off the
 * discovered table, and never derived from `BELT_MARCH_BUCKETS`.
 *
 * **39 = `3K + 3` at the default K of 12**: 12 straight buckets + 24 corner buckets (two
 * chiralities) + 1 phase-independent straight LOD tick + 2 phase-independent corner LOD
 * bend cues. The derivation is the comment that explains the literal; it is emphatically
 * NOT the expression the assertion evaluates. An assertion derived from the knob it
 * checks agrees with itself at ANY value of that knob - which is the
 * `machineChassis.ts:44-57` counter-rule this repo already applies to the straight
 * suite, and the same self-agreeing vacuity class `beltPainter.digest.test.ts` records
 * about its own count. A discovery that silently produced nothing would otherwise
 * compare an empty table against itself and report the cleanest green in the suite.
 *
 * **THE TIGHTENING, so it is readable in the diff rather than reconstructed.** The
 * ROADMAP attached a "re-derive, never loosen" clause to this invariant. `61-UI-SPEC`
 * A8 provisionally keyed a `zoomBucket` cache term (|Z| <= 4) in against Pixi's
 * `buildAdaptiveBezier` stale-tessellation hazard and set the ceiling at
 * `4 * (3K + 3)` = **156**. Plan 61-03 retired that hazard BY CONSTRUCTION - the corner
 * emitters hand out self-sampled point lists and never reach a Pixi curve command - so
 * ONE fixed tessellation serves the entire zoom range, there is no zoom-bucket term at
 * all, and the ceiling is the slot count itself. **39, not 156.**
 *
 * Moving K means editing this number by hand, which is exactly the moment a human
 * should be looking at the table.
 */
const EXPECTED_ENTRIES = 39;

/** The ceiling this figure replaces, named so the tightening is legible here too. */
const SUPERSEDED_CEILING_WITH_ZOOM_BUCKETS = 156;

/**
 * THE ENUMERATED DEVICE QUANTA THE RAIL FAMILY IS PINNED AT (plan 61-09).
 *
 * The rails left the four tread emitters and became their own family, whose geometry is
 * a function of the live device quantum `q = DPR * zoom` (`beltGeometry.ts railBandAt`).
 * A quantum is CONTINUOUS, so there is no finite slot enumeration to walk - the table
 * pins a NAMED SET instead, and the set is chosen rather than sampled:
 *
 *   - 0.75 .. 0.95 are the five fractional camera scales the 2026-08-10 rail-continuity
 *     measurement recorded a failure at, and 0.75 is additionally the LOD cut (the
 *     lowest zoom at which the full-detail tread is selected at all).
 *   - 1 and 2 are INTEGER quanta, where the rule takes its identity values and the
 *     emitted geometry is the PRE-FIX geometry exactly. They are in the table so that
 *     identity is pinned as bytes rather than only as an inequality.
 *   - 1.25, 1.5 and 1.77 are the fractional quanta ABOVE 1 - the DPR-1 zoom-in band and
 *     VEC-01's named 177% case, where the rail is thicker than one device pixel and the
 *     `max(1, ...)` floor is NOT what is doing the work.
 *
 * THE QUANTUM IS A TABLE LABEL HERE AND A CACHE LIFETIME TERM IN THE LAYER. It is not
 * a cache KEY term anywhere, which is why these keys are written `q0.75` rather than
 * squeezed into `beltContextKey`'s bucket segment: a reader must not be able to mistake
 * this enumeration for a key space.
 */
const RAIL_QUANTA: readonly number[] = Object.freeze([
  0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.25, 1.5, 1.77, 2,
]);

/**
 * The RAIL rows' own stated size: one straight rail per pinned quantum. **10.**
 *
 * A stated literal for the same reason {@link EXPECTED_ENTRIES} is one - a length taken
 * off `RAIL_QUANTA` would agree with itself if a quantum were silently dropped.
 */
const EXPECTED_RAIL_ENTRIES = 50;

/**
 * The whole committed table: the 39 scale-free tread slots plus the 50 rail probes.
 *
 * The 50 is 5 rail FAMILIES x 10 pinned quanta - 1 straight, 2 corner chiralities at the
 * full sample count and the same 2 at the low-zoom count. **The 5 is the rail cache
 * ceiling; the 50 is only how densely this table probes it**, and the two must not be
 * confused: the layer holds at most 5 rail contexts at once, at ONE quantum, because the
 * quantum is a lifetime term. `beltPainter.metrics.test.ts` owns the ceiling.
 */
const EXPECTED_TABLE_ENTRIES = 89;

/** The rail FAMILY count - the cache ceiling the 50 probes above, stated as a literal. */
const EXPECTED_RAIL_FAMILIES = 5;

/**
 * The geometry digest of one measured context.
 *
 * COPIED VERBATIM from `render/assets/geometryDigest.test.ts`; every contract below is
 * transcribed with it, because a contract that travels without its reasons stops being
 * a contract.
 *
 * QUANTISATION: `Math.round(v * 256) / 256`, a 1/256 unit quantum. One unit is one pixel
 * at CELL 32 / scale 1, so the quantum is far below a device pixel: it kills float noise
 * from the tessellator without being able to hide a real geometry change, which would
 * have to move a vertex by less than 1/256 px to slip through. `Math.round` is HALF-UP
 * on ties (`Math.round(-0.5)` is `-0`, `Math.round(0.5)` is `1`) - that asymmetry is the
 * recorded rounding contract, not an accident.
 *
 * LENGTH PREFIX: `uint32(vertexByteLength)` is hashed first so the vertex/index split is
 * unambiguous. Without it, a slot whose vertex buffer shrank by exactly as much as its
 * index buffer grew could collide on the concatenation alone.
 *
 * ENDIANNESS is recorded rather than discovered: the prefix is written little-endian to
 * match the native byte order of the typed arrays on every platform this ships to
 * (x86-64 and aarch64 are both little-endian). A big-endian host would compute different
 * digests for identical geometry and would need a re-bless plus this note updated - a
 * portability property of the table, not a defect in it.
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

/**
 * Turn path commands into a tessellated context, with ONE fixed ink.
 *
 * COLOUR IS DELIBERATELY CONSTANT AND DELIBERATELY ARBITRARY. A digest over
 * `geometryData` sees vertices and indices and nothing else, so the skin is invisible to
 * every value in the committed table - which is precisely the division of labour this
 * gate wants: geometry regressions land here, ink regressions land in the pixel and
 * metrics suites. Fixing the colour here rather than resolving a ramp keeps this builder
 * usable at bucket counts `SHIPPED_PAINTER` does not ship at.
 *
 * The stroke/fill branch mirrors `beltPainter.ts buildBeltContext` exactly, and the
 * `agrees with SHIPPED_PAINTER` case below proves the two have not drifted - so the
 * K-sweep, which cannot go through the painter, is measuring the same geometry the
 * shipped belt draws.
 */
function contextOf(commands: readonly BeltPathCommand[]): GraphicsContext {
  const ctx = new GraphicsContext();
  for (const cmd of commands) {
    ctx.poly(cmd.points as number[], cmd.close);
    if (cmd.style.mode === 'fill') {
      ctx.fill({ color: 0xffffff });
    } else {
      ctx.stroke({ width: cmd.style.width, color: 0xffffff, alignment: cmd.style.alignment });
    }
  }
  return ctx;
}

/**
 * EVERY belt cache slot at bucket count `buckets`, in a FIXED ENUMERATION ORDER -
 * an explicit ordered loop over kind, then chirality, then bucket. **Never object-key
 * iteration**, so the committed table's order is a property of THIS function rather than
 * of a JS engine's insertion rules, and the JSON diff is therefore the signal.
 *
 * The order and the families mirror the belt layer's four cache families exactly, which
 * is the same arithmetic `beltPainter.metrics.test.ts` bounds at `3K + 3`: if a family
 * is added and only one of them is updated, the two disagree loudly.
 */
function enumerateBeltGeometry(buckets: number): Array<[string, GraphicsContext]> {
  const out: Array<[string, GraphicsContext]> = [];
  for (let k = 0; k < buckets; k++) {
    out.push([`straight|none|${k}`, contextOf(straightCommands(k, buckets))]);
  }
  for (const chirality of ['cw', 'ccw'] as const) {
    for (let k = 0; k < buckets; k++) {
      out.push([`corner|${chirality}|${k}`, contextOf(cornerCommands(k, buckets, chirality))]);
    }
  }
  out.push(['straight-tick|none|0', contextOf(straightTickCommands())]);
  for (const chirality of ['cw', 'ccw'] as const) {
    out.push([`corner-tick|${chirality}|0`, contextOf(cornerTickCommands(chirality))]);
  }
  return out;
}

/**
 * The RAIL family at each pinned quantum, in a FIXED enumeration order (plan 61-09).
 *
 * Kept as its OWN walk rather than folded into {@link enumerateBeltGeometry}, because
 * the two enumerate different things: that one walks the scale-free cache SLOTS whose
 * count the `3K + 3` invariant bounds, this one walks a chosen set of device quanta of
 * a family whose cache holds exactly ONE entry at a time. Merging them would put a
 * quantum inside the enumeration the slot-count assertions read, and the slot count is
 * precisely what must not acquire a quantum dimension.
 */
function enumerateBeltRailGeometry(): Array<[string, GraphicsContext]> {
  const out: Array<[string, GraphicsContext]> = [];
  for (const q of RAIL_QUANTA) out.push([`rail|none|q${q}`, contextOf(railCommands(q))]);
  for (const chirality of ['cw', 'ccw'] as const) {
    for (const q of RAIL_QUANTA) {
      out.push([
        `corner-rail|${chirality}|q${q}`,
        contextOf(cornerRailCommands(ARC_SAMPLES, q, chirality)),
      ]);
    }
  }
  for (const chirality of ['cw', 'ccw'] as const) {
    for (const q of RAIL_QUANTA) {
      out.push([
        `corner-rail-tick|${chirality}|q${q}`,
        contextOf(cornerRailCommands(LOD_ARC_SAMPLES, q, chirality)),
      ]);
    }
  }
  return out;
}

/** The digest table at `buckets`, in the same fixed enumeration order. */
function digestTable(buckets: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, ctx] of [...enumerateBeltGeometry(buckets), ...enumerateBeltRailGeometry()]) {
    out[key] = digestOf(measureContext(ctx));
  }
  return out;
}

/** The committed table, read off disk. */
const COMMITTED: Record<string, string> = JSON.parse(readFileSync(DIGEST_PATH, 'utf8'));

describe('the belt geometry digest table pins every cache slot at the shipped K', () => {
  it('recomputes to the committed table EXACTLY, reporting every mismatch at once', () => {
    // ONE whole-object comparison, deliberately: a per-slot loop would fail on the first
    // mismatching key and force a run per offender. This names them all.
    expect(
      digestTable(BELT_MARCH_BUCKETS),
      "a belt slot's tessellated geometry changed. INVESTIGATE before re-blessing: if " +
        'this is deliberate re-arting, the implementation, any regenerated PNG baselines ' +
        'and this table land in ONE commit (baselines regenerated with CI=1, no gate ' +
        'loosened, no entry deleted), and the values are regenerated from the ' +
        'implementation via a temporary dump - NEVER hand-authored. A digest edited on ' +
        'its own, in its own commit, is the anti-pattern this table exists to catch.',
    ).toEqual(COMMITTED);
  });

  it('holds 39 entries - the STATED LITERAL, with the superseded 156 named beside it', () => {
    // Both sides against the literal, so neither can pass by agreeing with the other or
    // with the bucket-count knob.
    // The table is read by VALUE throughout, never by object-key iteration: the DIGESTS
    // carry the evidence, and the key set is already compared in BOTH directions by the
    // whole-object `toEqual` above (a table key with no producer and a producer with no
    // table key both fail there). Object-key ITERATION never produces the belt key set
    // in this file - `enumerateBeltGeometry` is an explicit ordered loop, which is what
    // makes the committed JSON's order a property of this module rather than of a JS
    // engine, and therefore makes its diff the signal.
    expect(Object.values(COMMITTED), 'the committed table lost or gained an entry').toHaveLength(
      EXPECTED_TABLE_ENTRIES,
    );
    expect(
      enumerateBeltGeometry(BELT_MARCH_BUCKETS),
      'the enumeration no longer covers every committed slot (did K move?)',
    ).toHaveLength(EXPECTED_ENTRIES);
    expect(EXPECTED_ENTRIES).toBe(39);
    // PLAN 61-09: the rail probes are counted SEPARATELY and the 39 is untouched by
    // them. The rails are not cache slots - the layer holds exactly ONE straight rail
    // context at a time and replaces it on a quantum change - so folding them into the
    // slot count would misreport the thing the `3K + 3` invariant is about.
    expect(enumerateBeltRailGeometry()).toHaveLength(EXPECTED_RAIL_ENTRIES);
    expect(EXPECTED_RAIL_ENTRIES).toBe(50);
    expect(RAIL_QUANTA).toHaveLength(10);
    expect(EXPECTED_RAIL_FAMILIES).toBe(5);
    expect(EXPECTED_RAIL_FAMILIES * RAIL_QUANTA.length).toBe(EXPECTED_RAIL_ENTRIES);
    expect(EXPECTED_ENTRIES + EXPECTED_RAIL_ENTRIES).toBe(EXPECTED_TABLE_ENTRIES);
    expect(EXPECTED_TABLE_ENTRIES).toBe(89);
    // THE TIGHTENING, as arithmetic rather than as prose: the retired zoom-bucket term
    // would have multiplied every slot by up to four.
    expect(EXPECTED_ENTRIES * 4).toBe(SUPERSEDED_CEILING_WITH_ZOOM_BUCKETS);
    expect(EXPECTED_ENTRIES).toBeLessThan(SUPERSEDED_CEILING_WITH_ZOOM_BUCKETS);
    // Corroboration only, and deliberately LAST: the family arithmetic still agrees with
    // the committed size. This is a second-order cross-check on a fixed number, never
    // the gate itself.
    expect(
      3 * BELT_MARCH_BUCKETS + 3,
      'the cache-bound arithmetic (3K + 3) no longer equals the committed table size',
    ).toBe(EXPECTED_ENTRIES);
  });

  it('refuses a vacuous pass: neither side may be empty', () => {
    // A zero-entry table compares equal to a zero-slot walk and reports the cleanest
    // green in the suite while covering nothing at all.
    expect(Object.values(COMMITTED).length).toBeGreaterThanOrEqual(1);
    expect(Object.values(digestTable(BELT_MARCH_BUCKETS)).length).toBeGreaterThanOrEqual(1);
  });

  it('every value is a full 64-character lowercase hex SHA-256', () => {
    for (const [key, value] of Object.entries(COMMITTED)) {
      expect(value, `${key} digest is not a full sha256 hex string`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is reproducible: a second enumeration yields identical digests', () => {
    expect(digestTable(BELT_MARCH_BUCKETS)).toEqual(digestTable(BELT_MARCH_BUCKETS));
  });

  it('measures the SAME geometry the shipped painter draws, key for key', () => {
    // THE DRIFT CLOSER. `contextOf` mirrors `beltPainter.ts buildBeltContext`, which is
    // what lets the K-sweep below reach bucket counts `SHIPPED_PAINTER` does not ship
    // at. Two builders that are supposed to agree and are never compared WILL drift, so
    // they are compared - at every slot, through the painter's own methods.
    const skin = LOCKED_SKIN;
    const K = BELT_MARCH_BUCKETS;
    const viaPainter: Record<string, string> = {};
    for (let k = 0; k < K; k++) {
      viaPainter[`straight|none|${k}`] = digestOf(
        measureContext(SHIPPED_PAINTER.straight(skin, k, CELL)),
      );
    }
    for (const chirality of ['cw', 'ccw'] as const) {
      for (let k = 0; k < K; k++) {
        viaPainter[`corner|${chirality}|${k}`] = digestOf(
          measureContext(SHIPPED_PAINTER.corner(skin, k, chirality, CELL)),
        );
      }
    }
    viaPainter['straight-tick|none|0'] = digestOf(
      measureContext(SHIPPED_PAINTER.straightTick(skin, CELL)),
    );
    for (const chirality of ['cw', 'ccw'] as const) {
      viaPainter[`corner-tick|${chirality}|0`] = digestOf(
        measureContext(SHIPPED_PAINTER.cornerTick(skin, chirality, CELL)),
      );
    }
    // The rail family joins the drift closer on the same terms (plan 61-09). It matters
    // MORE here than on the tread families, not less: the layer is forbidden from
    // importing rail geometry directly, so the painter seam is the only path the
    // shipped belt has to these bytes, and an untested seam is where two builders drift.
    for (const q of RAIL_QUANTA) {
      viaPainter[`rail|none|q${q}`] = digestOf(measureContext(SHIPPED_PAINTER.rails(skin, q)));
    }
    for (const chirality of ['cw', 'ccw'] as const) {
      for (const q of RAIL_QUANTA) {
        viaPainter[`corner-rail|${chirality}|q${q}`] = digestOf(
          measureContext(SHIPPED_PAINTER.cornerRails(skin, q, chirality)),
        );
      }
    }
    for (const chirality of ['cw', 'ccw'] as const) {
      for (const q of RAIL_QUANTA) {
        viaPainter[`corner-rail-tick|${chirality}|q${q}`] = digestOf(
          measureContext(SHIPPED_PAINTER.cornerRailTick(skin, q, chirality)),
        );
      }
    }
    expect(viaPainter).toEqual(COMMITTED);
  });
});

describe('every belt cache slot is byte-DISTINCT (BELT-06)', () => {
  /** Just the scale-free TREAD slots' digests, in enumeration order. */
  const treadDigests = (buckets: number): string[] =>
    enumerateBeltGeometry(buckets).map(([, ctx]) => digestOf(measureContext(ctx)));

  it('produces 39 distinct digests across 39 slots at the shipped K - an EQUALITY', () => {
    // **AN EQUALITY OVER A SET OF PRODUCED BYTES, NEVER AN "AT MOST", AND NEVER DERIVED
    // FROM THE KNOB.** A `<=` would pass on a cache half of whose slots had silently
    // collapsed to the same geometry, which is exactly the defect BELT-06 names: the
    // shipped K = 4 march over a 32px pitch collapsed to TWO distinct straights, because
    // the 16px dash repeat divided the 8px step twice. Under the split model the K
    // buckets partition ONE dash period exactly, so no two can coincide.
    // SCOPED TO THE TREAD SLOTS (plan 61-09), and the scoping is a statement rather
    // than a convenience. BELT-06 is about the MARCH: every bucket must draw different
    // bytes, or the cache is paying for slots that look identical. The rail probes are
    // not buckets and are deliberately NOT all distinct - see the integer-quantum case
    // below - so including them here would either weaken this equality to a `<=` or
    // report a false duplicate.
    const digests = treadDigests(BELT_MARCH_BUCKETS);
    expect(digests).toHaveLength(EXPECTED_ENTRIES);
    expect(new Set(digests).size).toBe(EXPECTED_ENTRIES);
    // And the committed table's own tread rows, so a re-bless that introduced a
    // duplicate is caught at the table rather than only at the recomputation.
    const committedTread = Object.entries(COMMITTED)
      .filter(([k]) => !/^(rail|corner-rail|corner-rail-tick)\|/.test(k))
      .map(([, v]) => v);
    expect(committedTread).toHaveLength(EXPECTED_ENTRIES);
    expect(new Set(committedTread).size).toBe(EXPECTED_ENTRIES);
  });

  it('holds that equality at EVERY legal bucket count, not only the default', () => {
    // The general form, which is what keeps pinning the default as a literal free of
    // cost: distinctness is a property of the model at every K the settings panel can
    // reach, and it is asserted as an equality at each of them.
    for (const k of BELT_MARCH_BUCKET_COUNTS) {
      const digests = treadDigests(k);
      expect(digests, `slot count at K = ${k}`).toHaveLength(3 * k + 3);
      expect(new Set(digests).size, `DISTINCT slot count at K = ${k}`).toBe(3 * k + 3);
    }
  });

  it('COLLIDES the rail probes at the integer quanta, and that collision is the fix working', () => {
    // **THE BASELINE-STABILITY CLAIM, STATED AS BYTES.** The device rule takes its
    // identity values at every whole quantum (`d = laneHalf * q`, `t = rail * q`,
    // `over = 0`), so q = 1 and q = 2 emit the PRE-FIX geometry and therefore emit each
    // other's bytes. Every committed PNG baseline in this repo is captured at DPR 1 and
    // zoom 1, so this equality is the reason none of them moved when the rails became
    // quantum-aware. A future edit that made the rule quantum-dependent at integer
    // quanta would break a pixel baseline; it breaks HERE first, with a name.
    const railRows = Object.fromEntries(
      Object.entries(COMMITTED).filter(([k]) =>
        /^(rail|corner-rail|corner-rail-tick)\|/.test(k),
      ),
    );
    expect(Object.keys(railRows)).toHaveLength(EXPECTED_RAIL_ENTRIES);
    for (const family of ['rail|none', 'corner-rail|cw', 'corner-rail|ccw', 'corner-rail-tick|cw', 'corner-rail-tick|ccw']) {
      expect(railRows[`${family}|q1`], `${family} integer-quantum identity`).toBe(
        railRows[`${family}|q2`],
      );
    }
    // NON-VACUITY: the FRACTIONAL quanta are all distinct from the integer one and from
    // each other, so the collision above is a property of whole quanta and not of a
    // rail emitter that ignores its argument - which is precisely the failure mode a
    // quantum-shaped fix is most likely to ship with.
    for (const family of ['rail|none', 'corner-rail|cw', 'corner-rail|ccw', 'corner-rail-tick|cw', 'corner-rail-tick|ccw']) {
      const fractional = RAIL_QUANTA.filter((q) => !Number.isInteger(q)).map(
        (q) => railRows[`${family}|q${q}`],
      );
      expect(new Set(fractional).size, `${family}: every fractional quantum draws its own bytes`).toBe(
        fractional.length,
      );
      expect(fractional).not.toContain(railRows[`${family}|q1`]);
    }
  });

  it('would have caught the shipped collapse: K = 4 over the OLD 32px pitch is NOT distinct', () => {
    // THE DISCRIMINATOR. Without this the equality above could be a tautology about an
    // enumeration that can never repeat itself. The shipped welded lattice is
    // reconstructed by driving the emitter at 4 buckets over TWICE the dash period -
    // which is what `pitch = 32, K = 4` was - and it duplicates, exactly as the raster
    // inventory case in `beltPainter.metrics.test.ts` still records for the dying bakes.
    const straights = [0, 1, 2, 3].map((k) => digestOf(measureContext(contextOf(straightCommands(k, 2)))));
    expect(new Set(straights).size).toBeLessThan(straights.length);
    expect(straights[0]).toBe(straights[2]); // the even-phase pairing, byte-exact
  });
});

describe('no belt slot tessellates to nothing (T-61-15, the silent-empty backstop)', () => {
  it('gives every slot a vertex count STRICTLY above zero and under the batching cliff', () => {
    // **A PROCEDURAL BUILDER FAILS SILENTLY BY PRODUCING NOTHING.** A context with zero
    // geometry draws nothing, throws nothing, prints nothing, and sails under every
    // budget threshold by being under all of them - it is the cleanest green in the
    // suite and the belt is invisible. That failure mode is why the FLOOR is asserted
    // per key here rather than left to the ceiling, and why a try/catch would not see
    // it: nothing is thrown.
    //
    // The ceiling is asserted beside it (VEC-04): above `VERTEX_LIMIT` Pixi's
    // `batchMode: 'auto'` stops batching and every `Graphics` drawn from the context
    // becomes its own draw call - a frame-rate regression with no error message.
    for (const [key, ctx] of [
      ...enumerateBeltGeometry(BELT_MARCH_BUCKETS),
      // The rail family is swept too (plan 61-09), and it is the family MOST exposed to
      // the silent-empty mode: its geometry is computed by dividing device integers by
      // a live quantum, so a degenerate quantum reaching it would emit non-finite
      // coordinates and tessellate to nothing at all.
      ...enumerateBeltRailGeometry(),
    ]) {
      const m = measureContext(ctx);
      expect(m.vertexCount, `${key} tessellated to ZERO geometry`).toBeGreaterThan(0);
      expect(m.vertexCount, `${key} measured ${m.vertexCount} vertices`).toBeLessThan(VERTEX_LIMIT);
      // Pixi's OWN batchability answer, read back rather than recomputed from the count
      // (the `svgAssets.ts:290-302` discipline: never mirror the branch).
      expect(m.isBatchable, `${key} is not batchable`).toBe(true);
    }
  });

  it('keeps the corner - the only sample-sensitive family - inside the warn band', () => {
    // The corner is the only sample-sensitive belt family. RE-MEASURED BY PLAN 61-09
    // after the rail split: the corner TREAD is 64-84 vertices and the corner RAIL
    // family 200, against the same 300 warn / 400 fail band (the tread was 264-284 while
    // it still carried the rail arcs). The gate is KEPT at the warn threshold rather
    // than relaxed to the new headroom - the sample count is what it bounds, and that
    // has not moved. Swept over EVERY bucket and both chiralities, because the tread's
    // vertex count moves with how many dash sectors the phase puts on the arc.
    for (const [key, ctx] of [
      ...enumerateBeltGeometry(BELT_MARCH_BUCKETS),
      ...enumerateBeltRailGeometry(),
    ]) {
      if (!key.startsWith('corner')) continue;
      const m = measureContext(ctx);
      expect(m.vertexCount, `${key} measured ${m.vertexCount} vertices`).toBeLessThan(VERTEX_WARN);
    }
  });
});
