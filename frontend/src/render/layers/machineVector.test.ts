// @vitest-environment jsdom
//
// THE VECTOR MACHINE LAYER (ART-01). Plan 58-01 drove ONE kind - TEE - end to end
// through every layer Phase 58 touches; plan 58-03 task 1 widened that to all EIGHT
// subjects and gave the HTTP endpoint a body for the first time. Real machine layer,
// real Pixi, no renderer.
//
// TWO ENVIRONMENT DECISIONS, both settled deliberately rather than discovered:
//
// 1. `@vitest-environment jsdom`. This is the FIRST jsdom spec under `render/layers/`
//    - `vitest.config.ts` sets `environment: 'node'` globally and every jsdom spec in
//    the tree today lives under `render/assets/`. The reason is one call deep:
//    `createMachineLayer(...).draw()` reaches `getAssetContext('tee')` ->
//    `new GraphicsContext().svg(source)` -> Pixi's `SVGParser` -> `DOMParser`. No DOM,
//    no parse, no geometry.
//
// 2. IT DOES NOT MOCK PIXI, and that is the point of the file. `machines.test.ts:14`
//    does `vi.mock('pixi.js', ...)` with stub `Container`/`Graphics`/`Sprite` classes,
//    which is exactly right for its symbolic scope (a token map and a call-recording
//    silhouette) and fatal here: that stub exports no `GraphicsContext` at all, so a
//    mocked run would make "the glyph shares ONE tessellated context, by identity"
//    assert nothing whatsoever. This spec's entire claim is that a REAL
//    `GraphicsContext` is built, shared by identity, and drawn from. A mocked tracer
//    proves nothing.
//
// The texture bake is NOT the reason for either decision. `matrixToTexture` ->
// `BufferImageSource` runs GPU-free under jsdom (verified: a FACTORY node bakes a real
// `Texture` and lands on a real `Sprite` here). `createMachineLayer`'s defaulted
// `makeTexture` parameter is injected below purely to COUNT bakes, which is how the
// "a vector subject bakes nothing" claim is made checkable.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Container, Graphics, Point, Sprite } from 'pixi.js';
import { CELL } from '../../../shared/geometry';
import {
  ART_ALIAS_OF,
  createMachineLayer,
  GEN_KEY_OF,
  LOD_MIN_MACHINE_PX,
  SUBJECT_OF,
} from './machines.ts';
import {
  CHASSIS_INSET_U,
  U_PER_CELL,
  U_TO_PX,
  chassisInk,
  drawChassis,
  uToPx,
} from './machineChassis.ts';
import { alertRingAlpha, notchOffset, resolveNotch } from './machineState.ts';
import { LOD_KIND_CODES, LOD_TINTS, makeEndpointPresenceBlock, makeLodBlocks } from './lodTints.ts';
import { FRAMES } from '../faultBlink.ts';
import { createSceneState } from '../sceneState.ts';
import { getAssetBox, getAssetContext } from '../svgAssets.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import { machine_kind, state_tag } from '../../protocol/kinds.ts';
import { effectiveBox } from '../../protocol/footprint.ts';
import type { GenKey } from '../synth/generators.ts';
import type { PixelMatrix } from '../synth/types.ts';
import type { SynthTexture } from '../synth/textureCache.ts';
import { CATALOG_KINDS, catalogEntry } from '../../protocol/decode.ts';
import type { NodeView } from '../../protocol/decode.ts';
import type { SceneState } from '../sceneState.ts';

/* ------------------------------------------------------------------ *
 * Scene + layer construction
 * ------------------------------------------------------------------ */

/** One synthetic node. Defaults are a TEE at its 2x2 base footprint, IDLE, unrotated. */
function makeNode(over: Partial<NodeView> = {}): NodeView {
  return {
    id: 1,
    kind: machine_kind.TEE,
    cell_x: 0,
    cell_y: 0,
    state: state_tag.IDLE,
    w: 2,
    h: 2,
    rot: 0,
    ports: [],
    load: 0,
    ...over,
  };
}

function sceneOf(...nodes: NodeView[]): SceneState {
  const scene = createSceneState();
  for (const n of nodes) scene.nodes.set(n.id, n);
  return scene;
}

/**
 * A counting stand-in for the real Pixi bake. It returns a REAL-shaped
 * `SynthTexture` (the cache's own injectable contract), so nothing about the layer
 * changes except that bakes become countable.
 */
function countingBaker(): { make: () => SynthTexture; count: () => number } {
  let n = 0;
  return {
    make: () => {
      n++;
      return { destroy: () => {} };
    },
    count: () => n,
  };
}

/**
 * Draw `scene` on a real machine layer at a real zoom and hand back the pieces.
 * `zoom` is the camera world scale; `zoom * CELL` is the device px per cell the LOD
 * cut compares against.
 */
function drawScene(scene: SceneState, zoom = 1, frame = 0) {
  const baker = countingBaker();
  const layer = createMachineLayer(LOCKED_SKIN, () => zoom, baker.make);
  layer.draw(scene, frame);
  return { layer, bakes: baker.count };
}

/**
 * A baked block's bytes, as one comparable string. The blocks are integer-only and
 * byte-lossless by construction (`lodTints.ts`), so a plain join is a sound identity -
 * no tolerance, no hashing dependency, and a mismatch prints something a reader can
 * actually diff.
 */
function digestOf(m: PixelMatrix): string {
  return `${m.width}x${m.height}:${m.data.join(',')}`;
}

/** The root Container the layer built for the node at `index` (scene insertion order). */
function rootAt(layer: { layer: Container }, index = 0): Container {
  const root = layer.layer.children[index];
  expect(root, `no machine root at index ${index}`).toBeDefined();
  return root as Container;
}

function childNamed(parent: Container, label: string): Container | undefined {
  return parent.children.find((c) => c.label === label) as Container | undefined;
}

/** The vector body's named parts, or `undefined` where the body was never built. */
function vectorPartsOf(root: Container) {
  const body = childNamed(root, 'machine-body');
  const part = (label: string) =>
    body === undefined ? undefined : (childNamed(body, label) as Graphics);
  return {
    body,
    chassis: part('machine-chassis'),
    glyph: part('machine-glyph'),
    notch: part('machine-notch'),
    ring: part('machine-alert-ring'),
    sprite: root.children.find((c) => c instanceof Sprite) as Sprite,
  };
}

/**
 * Every stroke colour a Graphics' context carries, read off Pixi's OWN recorded
 * instructions rather than off the argument we passed in. That is the difference
 * between "the layer called stroke with X" and "the context is stroked X".
 */
function strokeColorsOf(g: Graphics): number[] {
  return g.context.instructions
    .filter((ins) => ins.action === 'stroke')
    .map((ins) => (ins.data as { style: { color: number } }).style.color);
}

function strokeWidthsOf(g: Graphics): number[] {
  return g.context.instructions
    .filter((ins) => ins.action === 'stroke')
    .map((ins) => (ins.data as { style: { width: number } }).style.width);
}

const RAMP4 = LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1];

/* ------------------------------------------------------------------ *
 * VEC-04: one shared tessellation for every TEE on the board
 * ------------------------------------------------------------------ */

describe('the TEE glyph shares ONE tessellated GraphicsContext, by identity', () => {
  it("the drawn glyph's context IS getAssetContext('tee') - the same object, not an equal one", () => {
    const { layer } = drawScene(sceneOf(makeNode()));
    const { glyph } = vectorPartsOf(rootAt(layer));
    expect(glyph).toBeDefined();
    // `toBe`, never `toEqual`. Pixi v8 caches tessellated geometry ON the context and
    // decides batchability from it, so "one context, many Graphics" is what keeps N
    // TEEs at ONE tessellation. Deep equality would pass for N separate contexts
    // holding identical geometry - which is the exact defect this asserts against.
    expect(glyph!.context).toBe(getAssetContext('tee'));
  });

  it('THREE TEEs on the board share ONE context between them', () => {
    const { layer } = drawScene(
      sceneOf(
        makeNode({ id: 1, cell_x: 0 }),
        makeNode({ id: 2, cell_x: 4 }),
        makeNode({ id: 3, cell_x: 8 }),
      ),
    );
    const contexts = [0, 1, 2].map((i) => vectorPartsOf(rootAt(layer, i)).glyph!.context);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[1]).toBe(contexts[2]);
    expect(contexts[0]).toBe(getAssetContext('tee'));
  });

  it('the shared context carries real geometry - a tracer that drew nothing is not a pass', () => {
    const { layer } = drawScene(sceneOf(makeNode()));
    const { glyph } = vectorPartsOf(rootAt(layer));
    // Three authored glyph strokes: spine, fork-up, fork-down.
    expect(strokeColorsOf(glyph!)).toHaveLength(3);
    expect(glyph!.context.instructions.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * The state channel: outline carries state, glyph never does
 * ------------------------------------------------------------------ */

describe('the CHASSIS carries state ink; the GLYPH is ramp[4] in every state', () => {
  const cases: Array<[string, number, number]> = [
    ['IDLE', state_tag.IDLE, RAMP4],
    ['WORKING', state_tag.WORKING, LOCKED_SKIN.palette.accents.working],
    ['FAULTED', state_tag.FAULTED, LOCKED_SKIN.palette.accents.fault],
  ];

  for (const [name, state, expected] of cases) {
    it(`a ${name} TEE strokes its chassis ${expected.toString(16)}`, () => {
      const { layer } = drawScene(sceneOf(makeNode({ state })));
      const { chassis } = vectorPartsOf(rootAt(layer));
      expect(strokeColorsOf(chassis!)).toEqual([expected]);
      // ...and the module-level ink function agrees with what actually got drawn, so
      // a future caller reading `chassisInk` reads the shipped behaviour.
      expect(chassisInk(state, LOCKED_SKIN)).toBe(expected);
    });
  }

  it('EVERY subject keeps its glyph on ramp[4] in all three states - kind and state never contend', () => {
    // The TEE case below is the tracer's; this is the same claim over the whole
    // shipped set, which is what lock axis 9 actually says.
    for (const [name, kind, , w, h] of SUBJECTS) {
      for (const [, state] of cases) {
        const { layer } = drawScene(sceneOf(makeNode({ kind, w, h, state })));
        const inks = new Set(strokeColorsOf(vectorPartsOf(rootAt(layer)).glyph!));
        expect(inks, `${name} at state ${state}`).toEqual(new Set([RAMP4]));
      }
    }
  });

  it('the glyph ink does NOT move with state - lock axis 9, one ink for every kind', () => {
    const inks = cases.map(([, state]) => {
      const { layer } = drawScene(sceneOf(makeNode({ state })));
      return strokeColorsOf(vectorPartsOf(rootAt(layer)).glyph!);
    });
    for (const set of inks) {
      expect(new Set(set)).toEqual(new Set([RAMP4]));
    }
    expect(inks[0]).toEqual(inks[1]);
    expect(inks[1]).toEqual(inks[2]);
  });

  it("the authored hex IS LOCKED_SKIN.palette.ramp[4], not a hex that merely looks like it", () => {
    // The asset carries a literal (`#b0bacb`) because an SVG file must. This is the
    // assertion that ties that literal to the skin for THIS subject; plan 58-02
    // generalises it into a fail-severity gate over every shipped asset.
    const { layer } = drawScene(sceneOf(makeNode()));
    expect(new Set(strokeColorsOf(vectorPartsOf(rootAt(layer)).glyph!))).toEqual(
      new Set([LOCKED_SKIN.palette.ramp[4]]),
    );
  });

  it('the chassis stroke width comes from the SKIN axis, not a second literal', () => {
    const { layer } = drawScene(sceneOf(makeNode()));
    const { chassis } = vectorPartsOf(rootAt(layer));
    expect(strokeWidthsOf(chassis!)).toEqual([LOCKED_SKIN.strokeStructural * U_TO_PX]);
    // Stated in u, so the assertion reddens if the schema axis moves and the drawing
    // does not - which is the whole reason the axis exists rather than a constant.
    expect(LOCKED_SKIN.strokeStructural).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * The reason the chassis left the asset: GROWN footprints
 * ------------------------------------------------------------------ */

describe('the chassis is a function of (w, h) only, so a GROWN footprint just works', () => {
  // WR-04: THE LOCK'S AXIS-4 VALUE, STATED, NOT DERIVED.
  //
  // `expectedOuterBox` below computes its expectation FROM `CHASSIS_INSET_U`, so it
  // agrees with itself for any value - mutation-proven, `4 -> 6` passed all 1422 vitest
  // cases and all 87 spec files. The only thing that caught it was the Playwright
  // `operator-footprint.png` baseline, which does not run in the `frontend unit
  // (vitest + tsc)` CI job and which `pixel-guard.spec.ts:168` notes `tsc` does not
  // even typecheck. For a value `57-ART-LOCK.md` names as axis 4 that was thinner
  // coverage than `machineChassis.ts`'s own docblock implies.
  //
  // The pixel baseline remains the right gate for the RENDERED result and it works.
  // This is the independent statement of the LITERAL, in the same style
  // `machineState.test.ts` already pins `strokeStructural === 3` and `NOTCH_LEN_U === 6`
  // - so the value cannot move in a vitest-only run.
  it('CHASSIS_INSET_U is the lock\'s axis-4 value, pinned independently of any derivation', () => {
    expect(CHASSIS_INSET_U, '57-ART-LOCK.md axis 4 is a 4u inset').toBe(4);
    // Stated in px too, because the derivation below reads it through U_TO_PX and a
    // unit change there would otherwise move the real inset with nothing to say so.
    expect(uToPx(CHASSIS_INSET_U)).toBeCloseTo(4, 6);
  });

  /** The 4u-centreline / 3u-stroke outer extent of a `w x h` box, in px. */
  function expectedOuterBox(w: number, h: number) {
    const outer = CHASSIS_INSET_U * U_TO_PX - (LOCKED_SKIN.strokeStructural * U_TO_PX) / 2;
    return {
      x: outer,
      y: outer,
      right: w * CELL - outer,
      bottom: h * CELL - outer,
    };
  }

  const footprints: Array<[string, number, number]> = [
    ['2x2 (the TEE base footprint)', 2, 2],
    ['2x4 (GROWN - no legal viewBox exists for this)', 2, 4],
    ['3x4 (GROWN on both axes)', 3, 4],
  ];

  for (const [name, w, h] of footprints) {
    it(`draws a correct chassis at ${name}`, () => {
      const { layer } = drawScene(sceneOf(makeNode({ w, h })));
      const { chassis } = vectorPartsOf(rootAt(layer));
      const b = chassis!.getLocalBounds();
      const want = expectedOuterBox(w, h);
      expect(b.x).toBeCloseTo(want.x, 6);
      expect(b.y).toBeCloseTo(want.y, 6);
      expect(b.x + b.width).toBeCloseTo(want.right, 6);
      expect(b.y + b.height).toBeCloseTo(want.bottom, 6);
    });

    it(`keeps the glyph CENTRED at ${name}`, () => {
      const { layer } = drawScene(sceneOf(makeNode({ w, h })));
      const { glyph } = vectorPartsOf(rootAt(layer));
      const box = getAssetBox('tee');
      // The AUTHOR box is centred, not the ink: the TEE glyph is deliberately
      // east-heavy (that asymmetry is the gated discriminator against MERGE and
      // BALANCER), so centring its tessellated bounds would slide it off the
      // composition it was authored with.
      //
      // WR-08: this used to assert the position with the BYTE-IDENTICAL expression the
      // layer computes, so it could not distinguish a unit error from correct code -
      // and the layer was mixing `u` and `px` (subtracting a `u` box from `node.w *
      // CELL`) at the time. The expectation is now written in px from the start, with
      // the conversion named, so a `u`/px mix-up in the layer reddens here.
      expect(U_TO_PX, 'the px-per-u conversion this expectation is written against').toBe(1);
      const boxPx = { w: uToPx(box.w), h: uToPx(box.h) };
      expect(glyph!.position.x).toBeCloseTo((w * CELL - boxPx.w) / 2, 6);
      expect(glyph!.position.y).toBeCloseTo((h * CELL - boxPx.h) / 2, 6);
      // The other half of the same conversion: the glyph's own geometry is authored in
      // `u`, so it must be SCALED into px rather than left to coincide with them.
      expect(glyph!.scale.x).toBeCloseTo(U_TO_PX, 6);
      expect(glyph!.scale.y).toBeCloseTo(U_TO_PX, 6);
    });
  }

  it('the 2x4 chassis is genuinely TALLER than the 2x2 one - not the same box drawn twice', () => {
    // Without this, every bounds case above could pass on a chassis that ignored
    // (w, h) entirely and happened to match at the base footprint.
    const base = new Graphics();
    const grown = new Graphics();
    drawChassis(base, 2, 2, LOCKED_SKIN, state_tag.IDLE);
    drawChassis(grown, 2, 4, LOCKED_SKIN, state_tag.IDLE);
    expect(grown.getLocalBounds().height).toBeCloseTo(base.getLocalBounds().height + 2 * CELL, 6);
    expect(grown.getLocalBounds().width).toBeCloseTo(base.getLocalBounds().width, 6);
  });

  it('there is no per-kind or per-footprint table in the chassis module', () => {
    // The property stated as a property: drawing a footprint no machine kind has,
    // with no kind argument available at all, produces a correct chassis. If a lookup
    // table were ever reintroduced this is what could not be written.
    const g = new Graphics();
    drawChassis(g, 5, 7, LOCKED_SKIN, state_tag.IDLE);
    const b = g.getLocalBounds();
    const outer = CHASSIS_INSET_U * U_TO_PX - (LOCKED_SKIN.strokeStructural * U_TO_PX) / 2;
    expect(b.x + b.width).toBeCloseTo(5 * CELL - outer, 6);
    expect(b.y + b.height).toBeCloseTo(7 * CELL - outer, 6);
  });
});

/* ------------------------------------------------------------------ *
 * The transform: the vector body lands where the sprite did
 * ------------------------------------------------------------------ */

describe('a rotated TEE lands on the SAME device pixels the sprite path did', () => {
  /**
   * Where the pixel-sprite path puts author-box point `(u, v)`.
   *
   * The shipped sprite contract, written out: a texture baked at native
   * `(w*CELL, h*CELL)`, `anchor 0.5`, positioned at the effective-box centre inside a
   * root at `cell * CELL`, rotated `rot` quarter-turns. Anchor 0.5 on a native-size
   * texture is exactly a pivot at `(w*CELL/2, h*CELL/2)`, which is what makes the two
   * paths comparable at all.
   */
  function spritePathGlobal(n: NodeView, u: number, v: number): { x: number; y: number } {
    const { ew, eh } = effectiveBox(n.w, n.h, n.rot);
    const cx = n.cell_x * CELL + (ew * CELL) / 2;
    const cy = n.cell_y * CELL + (eh * CELL) / 2;
    const a = n.rot * (Math.PI / 2);
    const dx = u - (n.w * CELL) / 2;
    const dy = v - (n.h * CELL) / 2;
    return {
      x: cx + dx * Math.cos(a) - dy * Math.sin(a),
      y: cy + dx * Math.sin(a) + dy * Math.cos(a),
    };
  }

  for (const rot of [0, 1, 2, 3]) {
    it(`rot ${rot}: every author-box corner maps to the sprite path's global point`, () => {
      // 2x3 on purpose: an asymmetric footprint is the only one where the effective-box
      // dim swap at odd `rot` can actually be got wrong.
      const n = makeNode({ w: 2, h: 3, rot, cell_x: 3, cell_y: 5 });
      const { layer } = drawScene(sceneOf(n));
      const { body } = vectorPartsOf(rootAt(layer));
      expect(body).toBeDefined();

      const corners: Array<[number, number]> = [
        [0, 0],
        [n.w * CELL, 0],
        [0, n.h * CELL],
        [n.w * CELL, n.h * CELL],
        [(n.w * CELL) / 2, (n.h * CELL) / 2],
      ];
      for (const [u, v] of corners) {
        // Pixi's OWN transform math on one side, the sprite contract on the other.
        const got = body!.toGlobal(new Point(u, v));
        const want = spritePathGlobal(n, u, v);
        expect(got.x, `rot ${rot} corner (${u},${v}).x`).toBeCloseTo(want.x, 6);
        expect(got.y, `rot ${rot} corner (${u},${v}).y`).toBeCloseTo(want.y, 6);
      }
    });
  }

  it('the odd-rot cases genuinely differ from rot 0 - the loop is not comparing a no-op', () => {
    const a = spritePathGlobal(makeNode({ w: 2, h: 3, rot: 0, cell_x: 3, cell_y: 5 }), 0, 0);
    const b = spritePathGlobal(makeNode({ w: 2, h: 3, rot: 1, cell_x: 3, cell_y: 5 }), 0, 0);
    expect(a).not.toEqual(b);
  });
});

/* ------------------------------------------------------------------ *
 * All EIGHT subjects on the vector path (plan 58-03 task 1)
 * ------------------------------------------------------------------ */

/**
 * Every shipped subject at its BASE footprint, with the glyph asset it must draw.
 * The asset names are stated by hand rather than read back out of `SUBJECT_OF`,
 * because a spec that derives its expectation from the table under test agrees with
 * that table however wrong it is - a swapped SOURCE/SINK row would pass.
 */
/* ------------------------------------------------------------------ *
 * THE DECLARED ART ALIASES, and the non-vacuity check every alias
 * clause below runs FIRST (plan 72-09, R-58)
 * ------------------------------------------------------------------ */

/**
 * The kinds that deliberately draw and bake as ANOTHER kind, read from the SHIPPED
 * `ART_ALIAS_OF` and never mirrored. HANDLER -> FACTORY is the only row today.
 *
 * Every bijection in this file is now a bijection UP TO A DECLARED ALIAS, in two
 * clauses: (a) the CANONICAL kinds - those absent from this table - keep every property
 * the plain bijection asserted, unweakened, so an ACCIDENTAL collision still reddens
 * exactly as it did before; and (b) each ALIASED kind's key / digest / context EQUALS
 * its alias's, which is a POSITIVE assertion nothing here made before and which reddens
 * on a drift the old collision test could not express.
 *
 * The only way to weaken any of the four is to append a row to `ART_ALIAS_OF`, which is
 * a source edit visible in a diff.
 */
const ALIASED_KINDS: readonly number[] = Object.keys(ART_ALIAS_OF).map(Number);
/** Is this kind CANONICAL - i.e. NOT a declared alias of some other kind's art? */
const isCanonical = (kind: number): boolean => !Object.hasOwn(ART_ALIAS_OF, kind);

/**
 * THE VACUITY REFUSAL FOR THE ALIAS CLAUSES, run first in every block that has one.
 *
 * An EMPTY `ART_ALIAS_OF` makes every clause (b) below a loop over nothing: they would
 * all pass while measuring zero aliases, and clause (a) alone is just the old
 * assertion. So the table is asserted non-empty, and every key and value in it is
 * asserted to be a real row of the table the clause qualifies - an alias pointing at a
 * kind with no art is an alias clause comparing two undefineds and finding them equal.
 *
 * MUTATION PROOF (c), run 2026-09-03 and reverted. `ART_ALIAS_OF` emptied to `{}`:
 *
 *     × the subjects draw DISTINCT glyph contexts, up to a DECLARED alias ...
 *     × no two kinds share a GenKey, up to a DECLARED alias ...
 *     × ...and the blocks are pairwise DISTINCT up to a DECLARED alias ...
 *       AssertionError: ART_ALIAS_OF is EMPTY, so every alias clause in this file is a
 *       loop over nothing and passes while measuring no alias at all: expected 0 to be
 *       greater than 0
 *
 * All THREE blocks in this file that carry an alias clause reddened on this arm, with
 * that message, and NOT ONE of them passed silently over an empty set - which is what
 * would have happened without it. The fourth rewritten assertion,
 * `icons.test.tsx > parses each asset once ...`, reddened on the same mutation through
 * its own derived count (23 seen, 24 declared). Reverted; `ART_ALIAS_OF` carries one row.
 */
const expectAliasTableIsReal = (table: Readonly<Record<number, unknown>>, name: string): void => {
  expect(
    ALIASED_KINDS.length,
    'ART_ALIAS_OF is EMPTY, so every alias clause in this file is a loop over nothing ' +
      'and passes while measuring no alias at all',
  ).toBeGreaterThan(0);
  for (const kind of ALIASED_KINDS) {
    expect(Object.hasOwn(table, kind), `aliased kind ${kind} has no ${name} row`).toBe(true);
    expect(
      Object.hasOwn(table, ART_ALIAS_OF[kind]),
      `kind ${kind} is aliased to ${ART_ALIAS_OF[kind]}, which has no ${name} row of its own`,
    ).toBe(true);
  }
};

const SUBJECTS: ReadonlyArray<readonly [name: string, kind: number, asset: string, w: number, h: number]> = [
  ['SOURCE', machine_kind.SOURCE, 'source', 1, 1],
  ['FACTORY', machine_kind.FACTORY, 'factory', 3, 3],
  ['TEE', machine_kind.TEE, 'tee', 2, 2],
  ['BALANCER', machine_kind.BALANCER, 'balancer', 2, 2],
  ['ROUTER', machine_kind.ROUTER, 'router', 2, 3],
  ['MERGE', machine_kind.MERGE, 'merge', 2, 2],
  ['SINK', machine_kind.SINK, 'sink', 1, 1],
  ['ENDPOINT', machine_kind.ENDPOINT, 'endpoint', 1, 1],
  // HANDLER draws the FACTORY's art by declaration (ART_ALIAS_OF), at the Factory's 3x3.
  ['HANDLER', machine_kind.HANDLER, 'factory', 3, 3],
];

describe('every one of the NINE subjects draws as vector above the cut', () => {
  for (const [name, kind, asset, w, h] of SUBJECTS) {
    it(`a ${name} draws a chassis plus the '${asset}' glyph, and bakes nothing`, () => {
      const { layer, bakes } = drawScene(sceneOf(makeNode({ kind, w, h })));
      const { body, chassis, glyph, sprite } = vectorPartsOf(rootAt(layer));
      expect(body, `${name} has no vector body`).toBeDefined();
      expect(body!.visible).toBe(true);
      expect(sprite.visible).toBe(false);
      // The chassis is stroked...
      expect(strokeColorsOf(chassis!)).toEqual([RAMP4]);
      // ...and the glyph IS the one shared tessellation for that asset, by identity.
      expect(glyph!.context).toBe(getAssetContext(asset as Parameters<typeof getAssetContext>[0]));
      expect(glyph!.context.instructions.length).toBeGreaterThan(0);
      // The point of the whole move: no matrix, no texture, no cache entry.
      expect(bakes(), `${name} baked something above the cut`).toBe(0);
    });
  }

  it('no PixelMatrix machine bake survives on a full nine-subject board', () => {
    // The claim stated over the whole set at once rather than nine times singly: a
    // board carrying every kind at once still bakes ZERO textures above the cut.
    const { bakes } = drawScene(
      sceneOf(
        ...SUBJECTS.map(([, kind, , w, h], i) =>
          makeNode({ id: 100 + i, kind, w, h, cell_x: i * 4 }),
        ),
      ),
    );
    expect(bakes()).toBe(0);
  });

  it('the subjects draw DISTINCT glyph contexts, up to a DECLARED alias - no two kinds share art by accident', () => {
    // Without this, `SUBJECT_OF` could map every kind to the same asset and every
    // per-subject case above would still pass.
    //
    // REWRITTEN, NOT BUMPED (plan 72-09, R-58). HANDLER deliberately draws the FACTORY's
    // glyph, so `new Set(contexts).size === SUBJECTS.length` is now FALSE - and the
    // repair is emphatically NOT to relax the number. That would leave a green
    // assertion that no longer asserts "no two kinds share art", which is the only
    // thing it was ever for. Two clauses instead:
    //   (a) the CANONICAL subjects draw pairwise-distinct contexts, at full strength;
    //   (b) each ALIASED subject's context is IDENTICAL to its alias's, by object
    //       identity on the shared tessellation - a positive claim nothing made before.
    expectAliasTableIsReal(SUBJECT_OF, 'SUBJECT_OF');

    const { layer } = drawScene(
      sceneOf(
        ...SUBJECTS.map(([, kind, , w, h], i) =>
          makeNode({ id: 200 + i, kind, w, h, cell_x: i * 4 }),
        ),
      ),
    );
    const contextOf = new Map(
      SUBJECTS.map(([, kind], i) => [kind, vectorPartsOf(rootAt(layer, i)).glyph!.context]),
    );

    // (a) unchanged strength over the canonical set.
    const canonical = SUBJECTS.map(([, kind]) => kind).filter(isCanonical);
    const canonicalContexts = canonical.map((kind) => contextOf.get(kind)!);
    expect(
      new Set(canonicalContexts).size,
      'two CANONICAL kinds share one glyph context, which is an accidental collision ' +
        'and not a declared alias',
    ).toBe(canonical.length);

    // (b) each declared alias actually IS its target's art. This reddens on a DRIFT
    //     (an alias quietly re-pointed at different art) that the old set-size check
    //     could not express at all.
    for (const kind of ALIASED_KINDS) {
      expect(
        contextOf.get(kind),
        `kind ${kind} is declared an art alias of ${ART_ALIAS_OF[kind]} but draws a ` +
          'DIFFERENT glyph context',
      ).toBe(contextOf.get(ART_ALIAS_OF[kind]));
    }
  });
});

/* ------------------------------------------------------------------ *
 * The state cues, as the LAYER wires them (plan 58-03 task 2)
 * ------------------------------------------------------------------ */

describe('every non-idle state carries a NON-COLOUR cue on the board', () => {
  const at = (state: number, frame = 0) => {
    const { layer } = drawScene(sceneOf(makeNode({ state })), 1, frame);
    return vectorPartsOf(rootAt(layer));
  };
  /** How many drawing instructions a Graphics is actually carrying. */
  const plotted = (g: Graphics) => g.context.instructions.length;

  it('IDLE draws NEITHER cue - no notch, no ring', () => {
    const { notch, ring } = at(state_tag.IDLE);
    expect(notch!.visible).toBe(false);
    expect(plotted(ring!)).toBe(0);
  });

  it('WORKING shows the travelling notch and NO ring', () => {
    const { notch, ring } = at(state_tag.WORKING);
    expect(notch!.visible).toBe(true);
    expect(plotted(notch!)).toBeGreaterThan(0);
    expect(plotted(ring!)).toBe(0);
  });

  it('FAULTED plots the alert ring and hides the notch', () => {
    const { notch, ring } = at(state_tag.FAULTED);
    expect(notch!.visible).toBe(false);
    expect(plotted(ring!)).toBeGreaterThan(0);
  });

  it('the ring is UNPLOTTED again when the fault clears - not merely hidden', () => {
    // One layer, one node, a state transition on it: the geometry has to go away, or
    // "a ring exists when and only when a node is FAULTED" is a claim about a flag.
    const { layer } = drawScene(sceneOf(makeNode({ state: state_tag.FAULTED })));
    expect(plotted(vectorPartsOf(rootAt(layer)).ring!)).toBeGreaterThan(0);
    // Same node id -> the SAME entry, so this is a state transition on one machine
    // rather than a fresh layer that never had a ring to lose.
    const scene = sceneOf(makeNode({ state: state_tag.IDLE }));
    layer.draw(scene, 1);
    expect(plotted(vectorPartsOf(rootAt(layer)).ring!)).toBe(0);
  });

  it("the notch sits ABOVE the chassis in z, or it does not CUT the outline it is cutting", () => {
    const { body, chassis, notch } = at(state_tag.WORKING);
    expect(body!.children.indexOf(notch!)).toBeGreaterThan(body!.children.indexOf(chassis!));
  });

  it('the ring alpha IS the shipped cadence at the node cell, frame by frame', () => {
    const node = makeNode({ state: state_tag.FAULTED, cell_x: 6, cell_y: 9 });
    const scene = sceneOf(node);
    const { layer } = drawScene(scene, 1, 0);
    for (let f = 0; f < FRAMES; f++) {
      layer.draw(scene, f);
      expect(vectorPartsOf(rootAt(layer)).ring!.alpha).toBe(
        alertRingAlpha(f, node.cell_x, node.cell_y),
      );
    }
  });

  it('the notch MOVES with the frame, and lands exactly where the resolver says', () => {
    const node = makeNode({ state: state_tag.WORKING });
    const scene = sceneOf(node);
    const { layer } = drawScene(scene, 1, 0);
    const seen = new Set<string>();
    for (let f = 0; f < FRAMES; f++) {
      layer.draw(scene, f);
      const { notch } = vectorPartsOf(rootAt(layer));
      const want = resolveNotch(notchOffset(f, node.w, node.h), node.w, node.h);
      expect(notch!.position.x).toBeCloseTo(want.x, 6);
      expect(notch!.position.y).toBeCloseTo(want.y, 6);
      expect(notch!.rotation).toBe(want.rotation);
      seen.add(`${notch!.position.x},${notch!.position.y}`);
    }
    // ...and it genuinely travelled rather than being re-asserted in one spot.
    expect(seen.size).toBeGreaterThan(FRAMES / 2);
  });

  it('MOTION-05: a whole animation loop re-plots NOTHING and swaps no context', () => {
    // The claim the whole cue design rests on, made as a MEASUREMENT rather than as a
    // snapshot comparison, and the difference is the point. A first draft of this case
    // compared instruction counts and context uids across the loop - and a mutation
    // that called `drawNotch()` on every single frame passed it, because a
    // clear-and-replot of identical geometry leaves both numbers exactly where they
    // were. Pixi's own `GraphicsContext` emits `update` from every mutating call
    // (`rect`, `fill`, `stroke`, `clear`), so counting those emissions detects the
    // re-plot that counting their RESULT cannot.
    const scene = sceneOf(
      makeNode({ id: 1, state: state_tag.WORKING }),
      makeNode({ id: 2, state: state_tag.FAULTED, cell_x: 4 }),
    );
    const { layer, bakes } = drawScene(scene, 1, 0);
    const parts = [0, 1].flatMap((i) => {
      const p = vectorPartsOf(rootAt(layer, i));
      return [p.chassis!, p.notch!, p.glyph!, p.ring!];
    });
    const edits = new Map<string, number>();
    for (const g of parts) {
      const key = `node${parts.indexOf(g) < 4 ? 1 : 2}:${g.label}`;
      edits.set(key, 0);
      g.context.on('update', () => edits.set(key, edits.get(key)! + 1));
    }
    const before = parts.map((g) => `${g.label}:${g.context.uid}:${g.context.instructions.length}`);

    for (let f = 0; f < FRAMES; f++) layer.draw(scene, f);

    for (const [key, n] of edits) {
      expect(n, `${key} was re-plotted ${n} times during a 24-frame loop`).toBe(0);
    }
    // Belt and braces: no context was swapped out from under a Graphics either.
    expect(parts.map((g) => `${g.label}:${g.context.uid}:${g.context.instructions.length}`)).toEqual(
      before,
    );
    expect(bakes(), 'an animating vector machine baked a texture').toBe(0);
  });

  it('...and that counter is not asleep: a state CHANGE does re-plot, exactly once', () => {
    // The discriminator for the case above. If the `update` listener could never fire,
    // "zero re-plots per frame" would be a fact about the listener and not about the
    // layer. A genuine signature change must move it off zero.
    const scene = sceneOf(makeNode({ id: 1, state: state_tag.IDLE }));
    const { layer } = drawScene(scene, 1, 0);
    const { chassis } = vectorPartsOf(rootAt(layer));
    let edits = 0;
    chassis!.context.on('update', () => edits++);
    layer.draw(scene, 1);
    expect(edits, 'an unchanged node re-plotted its chassis').toBe(0);
    scene.nodes.set(1, makeNode({ id: 1, state: state_tag.WORKING }));
    layer.draw(scene, 2);
    expect(edits, 'a state change did NOT re-plot the chassis').toBeGreaterThan(0);
  });

  it('below the LOD cut neither cue is drawn - the block pip carries state down there', () => {
    const belowCut = (LOD_MIN_MACHINE_PX - 1) / CELL;
    for (const state of [state_tag.WORKING, state_tag.FAULTED]) {
      const { layer } = drawScene(sceneOf(makeNode({ state })), belowCut);
      const { body, notch } = vectorPartsOf(rootAt(layer));
      // The body is never even constructed below the cut, so both cues are absent by
      // construction rather than by a flag someone has to remember to clear.
      expect(body).toBeUndefined();
      expect(notch).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ *
 * The two keyspaces (plan 58-03 task 1)
 * ------------------------------------------------------------------ */

/**
 * Every kind that bakes an LOD block, with the `GenKey` it must map to.
 *
 * HAND-STATED, exactly as `SUBJECTS` above is and for exactly the same reason: a spec
 * that derives its expectation from the table under test agrees with that table however
 * wrong it is. Read this list out of `GEN_KEY_OF` and a re-pointed MERGE row would pass.
 *
 * WHY THIS TABLE NEEDED ITS OWN GATE (Phase 58 verification, Gap 2). Re-pointing
 * `machine_kind.MERGE` to `'tee'` inside `GEN_KEY_OF` passed the ENTIRE vitest suite -
 * 1443 tests, zero failures - while the same edit inside the sibling `SUBJECT_OF` reddens
 * four cases. Only the table's SIZE and its set-relationship to `SUBJECT_OF` were pinned;
 * the per-kind mapping was not, so the two tables were covered very differently.
 *
 * AND WHY THAT IS NOT COSMETIC. `GEN_KEY_OF` is the selector for BOTH low-zoom channels:
 * `LOD_TINTS[genKey]` is the block's hue and `LOD_KIND_CODES[genKey]` is its three-bit
 * corner code. The codes exist BECAUSE plan 58-04 measured that the eight hues cannot
 * carry kind under colour-vision simulation - so a mis-mapped kind does not merely wear
 * the wrong colour, it wears the wrong CODE as well, and the remedy that shipped for
 * exactly this failure points at the wrong kind. A MERGE would read as a TEE in every
 * channel available below the cut, silently.
 *
 * BELT is in this table and is not a subject: `belts.ts` draws it under `53-BELT-LOCK.md`,
 * but it is mapped here for totality and has always been.
 */
const GEN_KEYS: ReadonlyArray<readonly [name: string, kind: number, genKey: GenKey]> = [
  ['SOURCE', machine_kind.SOURCE, 'source'],
  ['BELT', machine_kind.BELT, 'belt'],
  ['FACTORY', machine_kind.FACTORY, 'factory'],
  ['TEE', machine_kind.TEE, 'tee'],
  ['BALANCER', machine_kind.BALANCER, 'balancer'],
  ['ROUTER', machine_kind.ROUTER, 'router'],
  ['MERGE', machine_kind.MERGE, 'merge'],
  ['SINK', machine_kind.SINK, 'sink'],
  // HANDLER bakes the FACTORY's block by declaration (ART_ALIAS_OF). It is NOT a ninth
  // GenKey: `LOD_TINTS` and `LOD_KIND_CODES` are untouched and still hold eight.
  ['HANDLER', machine_kind.HANDLER, 'factory'],
];

describe('GEN_KEY_OF maps every kind to ITS OWN generator key, per kind and not merely in bulk', () => {
  for (const [name, kind, genKey] of GEN_KEYS) {
    it(`a ${name} selects the '${genKey}' block`, () => {
      expect(GEN_KEY_OF[kind]).toBe(genKey);
    });
  }

  it('the table holds EXACTLY these nine kinds - a deleted row is a failure, not a smaller pass', () => {
    // Both directions, the way the shipped-asset gates state their key-set checks. A
    // subset check would let a kind lose its block entirely (it would simply stop being
    // measured); a superset check would let a stated row outlive the kind it describes.
    expect(Object.keys(GEN_KEY_OF).map(Number).sort((a, b) => a - b)).toEqual(
      GEN_KEYS.map(([, kind]) => kind).sort((a, b) => a - b),
    );
    expect(GEN_KEYS).toHaveLength(9);
  });

  it('no two kinds share a GenKey, up to a DECLARED alias - a bijection onto the eight keys', () => {
    // The claim the per-kind cases cannot make one at a time. Without it, `GEN_KEY_OF`
    // could point every kind at `'source'` and each case above would have to be wrong
    // individually for anything to redden.
    //
    // REWRITTEN, NOT BUMPED (plan 72-09, R-58). HANDLER deliberately shares the
    // FACTORY's key, so `new Set(keys).size === keys.length` is now FALSE. Deleting that
    // line, or replacing it with `.toBeLessThanOrEqual`, would leave a green test that
    // no longer says anything: nine kinds all mapped to 'source' would pass it.
    //
    // MUTATION PROOF (b), run 2026-09-03 and reverted. A tenth kind was added to
    // `GEN_KEY_OF` sharing `'factory'` with NO `ART_ALIAS_OF` row:
    //
    //     × no two kinds share a GenKey, up to a DECLARED alias - a bijection onto the eight keys
    //       AssertionError: two CANONICAL kinds share a GenKey. That is an ACCIDENTAL
    //       collision, not a declared alias: add the kind to ART_ALIAS_OF if the sharing
    //       is deliberate: expected 8 to be 9
    //
    // Clause (a) reddened by name, which is the property the rewrite had to keep: an
    // accidental collision is still caught at exactly the strength it always was.
    expectAliasTableIsReal(GEN_KEY_OF, 'GEN_KEY_OF');

    // (a) unchanged strength over the canonical set, in BOTH directions: pairwise
    //     distinct, and the set of keys they use is exactly the LOD tint keyspace.
    const canonicalKinds = Object.keys(GEN_KEY_OF).map(Number).filter(isCanonical);
    const canonicalKeys = canonicalKinds.map((kind) => GEN_KEY_OF[kind]);
    expect(
      new Set(canonicalKeys).size,
      'two CANONICAL kinds share a GenKey. That is an ACCIDENTAL collision, not a ' +
        'declared alias: add the kind to ART_ALIAS_OF if the sharing is deliberate',
    ).toBe(canonicalKeys.length);
    expect(new Set(canonicalKeys)).toEqual(new Set(Object.keys(LOD_TINTS)));

    // (b) each declared alias resolves to EXACTLY its target's key.
    //
    // MUTATION PROOF (a), run 2026-09-03 and reverted. `GEN_KEY_OF[HANDLER]` pointed at
    // `'sink'` instead of `'factory'`:
    //
    //     × no two kinds share a GenKey, up to a DECLARED alias - a bijection onto the eight keys
    //       AssertionError: kind 10 is declared an art alias of 2, so it must select the
    //       SAME GenKey, and it does not: expected 'sink' to be 'factory'
    //
    // Clause (b) reddened by name on a drift the old collision check was blind to: nine
    // kinds over eight distinct keys would have satisfied it either way.
    for (const kind of ALIASED_KINDS) {
      expect(
        GEN_KEY_OF[kind],
        `kind ${kind} is declared an art alias of ${ART_ALIAS_OF[kind]}, so it must ` +
          'select the SAME GenKey, and it does not',
      ).toBe(GEN_KEY_OF[ART_ALIAS_OF[kind]]);
    }
  });

  it('the mapping decides the BLOCK: the tint and the kind code a kind actually gets', () => {
    // The consequence, stated in pixels rather than in table lookups, because the reason
    // this table is load-bearing is what it does below the cut. The block is baked through
    // the LAYER'S OWN selector (`GEN_KEY_OF[kind]`) and compared against the block for the
    // HAND-STATED key. The hue and code LITERALS stay owned by `lodTints.test.ts` - this
    // asserts the routing, not the palette, so a legitimate re-hue does not redden here.
    const blocks = makeLodBlocks(LOCKED_SKIN);
    for (const [name, kind, genKey] of GEN_KEYS) {
      const selected = blocks[GEN_KEY_OF[kind] as GenKey](state_tag.IDLE, 1, 1);
      const stated = blocks[genKey](state_tag.IDLE, 1, 1);
      expect(digestOf(selected), `${name} bakes a block that is not its own`).toBe(
        digestOf(stated),
      );
    }
  });

  it('...and the blocks are pairwise DISTINCT up to a DECLARED alias, so a mis-mapping cannot hide', () => {
    // The discriminator for the case above, and the fact that makes a wrong row visible:
    // at one common footprint every kind's block differs from every other's, in hue AND in
    // corner code. Without this, "the selected block equals the stated block" would be
    // satisfied by eight identical blocks.
    //
    // REWRITTEN, NOT BUMPED (plan 72-09, R-58). A HANDLER bakes the FACTORY's block by
    // declaration, so the digests are no longer all-distinct. Bumping the count, or
    // dropping to a set-size inequality, would restore green while destroying the whole
    // discriminator - which is the substitution this rewrite exists to refuse.
    expectAliasTableIsReal(GEN_KEY_OF, 'GEN_KEY_OF');
    const blocks = makeLodBlocks(LOCKED_SKIN);
    const digestFor = (kind: number): string =>
      digestOf(blocks[GEN_KEY_OF[kind] as GenKey](state_tag.IDLE, 1, 1));

    // (a) unchanged strength over the canonical set.
    const canonical = GEN_KEYS.map(([, kind]) => kind).filter(isCanonical);
    expect(
      new Set(canonical.map(digestFor)).size,
      'two CANONICAL kinds bake byte-identical LOD blocks, so a mis-mapping between ' +
        'them would be invisible',
    ).toBe(canonical.length);

    // (b) each declared alias bakes EXACTLY its target's block, byte for byte. This is
    //     the pixel-level statement of the alias: a Handler is a Factory below the cut
    //     too, in hue and in corner code, and it says so rather than merely not clashing.
    for (const kind of ALIASED_KINDS) {
      expect(
        digestFor(kind),
        `kind ${kind} is declared an art alias of ${ART_ALIAS_OF[kind]} but bakes a ` +
          'DIFFERENT LOD block',
      ).toBe(digestFor(ART_ALIAS_OF[kind]));
    }
  });
});

describe('SUBJECT_OF and GEN_KEY_OF are two keyspaces of the same SIZE and not the same SET', () => {
  const subjectKinds = new Set(Object.keys(SUBJECT_OF).map(Number));
  const genKinds = new Set(Object.keys(GEN_KEY_OF).map(Number));

  it('each holds exactly nine kinds - and the two LOD TABLES are still eight', () => {
    expect(subjectKinds.size).toBe(9);
    expect(genKinds.size).toBe(9);
    // THE PAIR THAT MATTERS, asserted right beside the counts that moved so a reader
    // cannot mistake one for the other (plan 72-09). The KEYSPACES grew by one kind;
    // the two LOD tables did NOT, because HANDLER entered as a declared alias of the
    // FACTORY and took an existing hue and an existing corner code. That is the whole
    // "mints no hue, takes no corner code" claim of this phase.
    expect(Object.keys(LOD_TINTS)).toHaveLength(8);
    expect(Object.keys(LOD_KIND_CODES)).toHaveLength(8);
  });

  it('the ENDPOINT is a SUBJECT with no GenKey - it draws a body and bakes no block', () => {
    expect(subjectKinds.has(machine_kind.ENDPOINT)).toBe(true);
    expect(genKinds.has(machine_kind.ENDPOINT)).toBe(false);
  });

  it('the BELT has a GenKey and is NOT a subject - belts.ts draws it, under 53-BELT-LOCK', () => {
    expect(genKinds.has(machine_kind.BELT)).toBe(true);
    expect(subjectKinds.has(machine_kind.BELT)).toBe(false);
  });

  it('the overlap is exactly EIGHT kinds - the machines that are both vector and tinted', () => {
    const overlap = [...subjectKinds].filter((k) => genKinds.has(k));
    expect(overlap).toHaveLength(8);
    // Named, so a swap (drop the endpoint, add the belt) cannot keep the count.
    expect(new Set(overlap)).toEqual(
      new Set([
        machine_kind.SOURCE,
        machine_kind.FACTORY,
        machine_kind.TEE,
        machine_kind.BALANCER,
        machine_kind.ROUTER,
        machine_kind.MERGE,
        machine_kind.SINK,
        // HANDLER joined BOTH tables at plan 72-09, which is why the overlap moved from
        // seven to eight without either table gaining a hue.
        machine_kind.HANDLER,
      ]),
    );
  });

  it('a WIRE is in NEITHER table and draws no machine root at all', () => {
    expect(subjectKinds.has(machine_kind.WIRE)).toBe(false);
    expect(genKinds.has(machine_kind.WIRE)).toBe(false);
    const { layer } = drawScene(sceneOf(makeNode({ id: 8, kind: machine_kind.WIRE, w: 1, h: 1 })));
    expect(layer.layer.children).toHaveLength(0);
  });

  it('a BELT draws no machine root either - the subject guard skips it before any lookup', () => {
    const { layer, bakes } = drawScene(
      sceneOf(makeNode({ id: 5, kind: machine_kind.BELT, w: 1, h: 1 })),
    );
    expect(layer.layer.children).toHaveLength(0);
    expect(bakes()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The silent-nothing trap: a PLACEABLE kind with no art
 * (plan 72-02 task 1, SERVE-03, UI-SPEC 1.4)
 * ------------------------------------------------------------------ */

/**
 * Kinds that HAVE a `MACHINE_CATALOG` row and are still, deliberately, not drawn by this
 * layer - each carrying the reason it is an exception rather than an oversight.
 *
 * BELT is the entry, and it is here because it is the one kind whose absence from
 * `SUBJECT_OF` is a design decision with a written lock behind it: `belts.ts` owns belt
 * art under `53-BELT-LOCK.md`, and `GEN_KEY_OF` maps BELT only for totality below the
 * cut. If a later phase ever gives BELT a catalog row, this guard must skip it for that
 * stated reason rather than redden for a reason nobody chose.
 *
 * MEASURED AT HEAD, THIS MAP IS DORMANT, and that is asserted below rather than assumed:
 * `MACHINE_CATALOG` has NO BELT row today (its docblock: "BELT is intentionally absent,
 * it is not a placeable machine (17-02 rejects `Place{BELT}`)"), so the loop never
 * reaches the exception. An exception nobody can see fire is the shape of a check that
 * cannot fail, so the dormancy is a test of its own.
 */
const LOD_TOTALITY_EXCEPTIONS: ReadonlyMap<number, string> = new Map([
  [
    machine_kind.BELT,
    'belts.ts draws the belt under 53-BELT-LOCK.md, so it is a subject of that layer and not of this one',
  ],
  [
    machine_kind.LABEL,
    'a label is a note, drawn by the machines layer\'s own label branch at every zoom (UI-SPEC 3.4), never as a machine body or an LOD block',
  ],
]);

describe('every PLACEABLE kind draws at both zooms - the silent-nothing guard (SERVE-03)', () => {
  // WHY THIS GUARD EXISTS, in one sentence: `machines.ts` gates BOTH the LOD texture bake
  // and `entry.sprite.visible` on `genKey !== undefined || isEndpoint`, so a kind byte in
  // NEITHER `SUBJECT_OF` nor `GEN_KEY_OF` produces no vector body above the cut and an
  // invisible sprite below it. Nothing throws, nothing logs, and until this block existed
  // nothing in the suite reddened. The machine simply is not there.
  //
  // WHY THE SUBJECT LIST COMES FROM `MACHINE_CATALOG` and not from `machine_kind`'s
  // constants or the Palette's rows (ruling R-21 of 72-02-PLAN.md): `machine_kind`
  // includes WIRE 8, a transport seam with no body at all, and the Palette's hand-written
  // rows would miss a kind placeable by any other route. The catalog is the frontend's own
  // statement of what can LAND on a board, and it is the hand-maintained mirror of Rust's
  // `kind_has_catalog_arm`. A kind that can be placed must draw.
  //
  // MUTATION PROOF (run 2026-09-02, reverted immediately after). Argument is not evidence,
  // so the guard was made to fail on purpose once. The mutation added a throwaway
  // `MACHINE_CATALOG` row for kind byte 200, present in neither LOD table:
  //
  //     [200]: { kind: 200, w: 1, h: 1, rot: 0, ports: [cp(0, 0, 0, CAT_W, CAT_IN)] },
  //
  // and `npx vitest run src/render/layers/machineVector.test.ts` reported, verbatim:
  //
  //      ❯ src/render/layers/machineVector.test.ts (102 tests | 1 failed) 43ms
  //          × kind byte 200 is placeable, so it must be in SUBJECT_OF or GEN_KEY_OF or both 3ms
  //
  //     FAIL  src/render/layers/machineVector.test.ts > every PLACEABLE kind draws at both
  //     zooms - the silent-nothing guard (SERVE-03) > kind byte 200 is placeable, so it
  //     must be in SUBJECT_OF or GEN_KEY_OF or both
  //     AssertionError: kind byte 200 has a MACHINE_CATALOG row, so it can be PLACED, but
  //     it is in NEITHER SUBJECT_OF NOR GEN_KEY_OF. It will draw NOTHING at any zoom: no
  //     vector body above the LOD cut, and an invisible sprite below it (machines.ts gates
  //     both the bake and sprite.visible on `genKey !== undefined || isEndpoint`). No error
  //     is thrown and no other test fails. Add it to SUBJECT_OF, or to GEN_KEY_OF, or name
  //     it in LOD_TOTALITY_EXCEPTIONS with its reason.: expected false to be true
  //
  //     Test Files  1 failed (1)
  //          Tests  1 failed | 101 passed (102)
  //
  // Exactly ONE case reddened, it is this block's case, and its message names the byte and
  // says what it costs. With the throwaway row reverted the file is green again at 101
  // passed. Quoted in full in 72-02-SUMMARY.md.

  it('the catalog names a non-empty set of placeable kinds, and every one is a real row', () => {
    // The vacuity refusal, in `icons.test.tsx`'s idiom and first in the block on purpose.
    // A `CATALOG_KINDS` that failed to import, or a table that lost its rows, would make
    // every loop below iterate zero kinds and PASS while measuring nothing.
    expect(
      CATALOG_KINDS.length,
      'CATALOG_KINDS is empty, so the totality loop below measured NOTHING and its green says nothing',
    ).toBeGreaterThan(0);
    // A concrete anchor, so a list of the right length but the wrong contents cannot pass.
    expect(CATALOG_KINDS).toContain(machine_kind.FACTORY);
    for (const kind of CATALOG_KINDS) {
      // A kind falling through `catalogEntry`'s 1x1 PORTLESS fallback is not a catalog row
      // at all. This is what proves the list names real entries rather than stray bytes.
      //
      // NARROWED IN PHASE 76, NOT WEAKENED. The LABEL is the first real catalog row with
      // NO ports (a note does not connect, D-07), so "ports.length > 0" stopped being the
      // definition of a real row. A port-less row now passes ONLY when it is a listed
      // LOD_TOTALITY_EXCEPTIONS kind AND its box is not the 1x1 fallback box; any other
      // port-less row still reddens here exactly as before. MEASURED 2026-10-07 (throwaway
      // worktree, reverted): a row `[201]: { w: 2, h: 1, ports: [] }` in MACHINE_CATALOG
      // reddened this case ("kind byte 201 ... resolves to a portless entry and is not a
      // listed exception") and the per-kind totality case below.
      const entry = catalogEntry(kind);
      if (entry.ports.length > 0) continue;
      expect(
        LOD_TOTALITY_EXCEPTIONS.has(kind),
        `kind byte ${kind} is listed in CATALOG_KINDS but resolves to a portless entry and is not a listed exception, so it is not a real catalog row`,
      ).toBe(true);
      expect(
        entry.w !== 1 || entry.h !== 1,
        `kind byte ${kind} is port-less AND 1x1, which is the fallback shape, not a real catalog row`,
      ).toBe(true);
    }
    // The one port-less row today, by literal: a label is placed 4 by 1 (UI-SPEC U-2).
    const label = catalogEntry(machine_kind.LABEL);
    expect([label.w, label.h, label.rot, label.ports.length]).toEqual([4, 1, 0, 0]);
  });

  for (const kind of CATALOG_KINDS) {
    const excused = LOD_TOTALITY_EXCEPTIONS.get(kind);
    const title = excused
      ? `kind byte ${kind} is an excused exception: ${excused}`
      : `kind byte ${kind} is placeable, so it must be in SUBJECT_OF or GEN_KEY_OF or both`;
    it(title, () => {
      if (excused !== undefined) {
        // Excused kinds are asserted ABSENT from SUBJECT_OF, so the exception stays an
        // exception: the day one is quietly given a body, this case says so.
        expect(
          Object.hasOwn(SUBJECT_OF, kind),
          `kind byte ${kind} is listed in LOD_TOTALITY_EXCEPTIONS (${excused}) but it now HAS a SUBJECT_OF row, so the exception is stale and should be deleted`,
        ).toBe(false);
        return;
      }
      const drawn = Object.hasOwn(SUBJECT_OF, kind) || Object.hasOwn(GEN_KEY_OF, kind);
      expect(
        drawn,
        `kind byte ${kind} has a MACHINE_CATALOG row, so it can be PLACED, but it is in ` +
          'NEITHER SUBJECT_OF NOR GEN_KEY_OF. It will draw NOTHING at any zoom: no vector ' +
          'body above the LOD cut, and an invisible sprite below it (machines.ts gates both ' +
          'the bake and sprite.visible on `genKey !== undefined || isEndpoint`). No error is ' +
          'thrown and no other test fails. Add it to SUBJECT_OF, or to GEN_KEY_OF, or name ' +
          'it in LOD_TOTALITY_EXCEPTIONS with its reason.',
      ).toBe(true);
    });
  }

  it('the BELT exception is DORMANT today, because BELT has no catalog row at all', () => {
    // The exception set's own honesty check. BELT is not placeable (17-02 rejects
    // `Place{BELT}`; the palette arms DrawBelt-only draw mode instead), so it never
    // reaches the loop above and the excused branch is unexercised. Asserting that here
    // is what stops the exception reading as a live, load-bearing skip that it is not.
    expect(CATALOG_KINDS).not.toContain(machine_kind.BELT);
    expect(LOD_TOTALITY_EXCEPTIONS.has(machine_kind.BELT)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * READ-05: below the cut, every kind is still an LOD block
 * ------------------------------------------------------------------ */

describe('below the LOD cut the TEE swaps to the kind-tinted block, like every other kind', () => {
  /** A zoom that puts device px per cell strictly BELOW the cut. */
  const belowCut = (LOD_MIN_MACHINE_PX - 1) / CELL;
  /** ...and one exactly AT it, since the cut is a single INCLUSIVE threshold. */
  const atCut = LOD_MIN_MACHINE_PX / CELL;

  it('below the cut it is the Sprite that is visible, and a block is baked', () => {
    const { layer, bakes } = drawScene(sceneOf(makeNode()), belowCut);
    const { body, sprite } = vectorPartsOf(rootAt(layer));
    expect(body).toBeUndefined(); // never even constructed down here
    expect(sprite.visible).toBe(true);
    expect(bakes()).toBe(1);
  });

  it('AT the cut it is vector again - the threshold is inclusive, not exclusive', () => {
    const { layer, bakes } = drawScene(sceneOf(makeNode()), atCut);
    const { body, sprite } = vectorPartsOf(rootAt(layer));
    expect(body!.visible).toBe(true);
    expect(sprite.visible).toBe(false);
    expect(bakes()).toBe(0);
  });

  it('the two zoom cases are on opposite sides of the same shipped constant', () => {
    expect(belowCut * CELL).toBeLessThan(LOD_MIN_MACHINE_PX);
    expect(atCut * CELL).toBe(LOD_MIN_MACHINE_PX);
  });
});

describe('the LOD cut is where a detail stroke reaches ONE device pixel', () => {
  /**
   * The detail-stroke width in DEVICE PIXELS at `p` device px per cell.
   *
   * `u` is `1/U_PER_CELL` of a cell, so a stroke of `strokeDetail` u measures
   * `strokeDetail * p / U_PER_CELL` device px. Nothing here is a literal: the stroke
   * comes from the skin, the grid from the chassis module, the cut from the layer.
   */
  const detailPxAt = (p: number): number => (LOCKED_SKIN.strokeDetail * p) / U_PER_CELL;

  it('AT the cut a 2u detail stroke is at least 1.0 device px', () => {
    // THE POINT OF DERIVING IT: the cut and the stroke weight can never drift apart
    // again. Move `LOD_MIN_MACHINE_PX` down, or `strokeDetail` down, and this reddens
    // - because the combination would put a vector stroke under a pixel centre, where
    // `antialias: false` renders it as a dotted line or not at all. A literal `16`
    // asserted against a literal `16` would have agreed with itself forever.
    expect(detailPxAt(LOD_MIN_MACHINE_PX)).toBeGreaterThanOrEqual(1.0);
  });

  it('the OLD cut of 12 would have failed this, which is why it moved', () => {
    // The case that makes the assertion above non-vacuous: at 12 px per cell the same
    // arithmetic yields 0.75 device px. If this ever starts passing, the arithmetic
    // has changed and the docblock on LOD_MIN_MACHINE_PX is now wrong.
    expect(detailPxAt(12)).toBeCloseTo(0.75, 6);
    expect(detailPxAt(12)).toBeLessThan(1.0);
  });

  it('the cut is the SMALLEST integer px-per-cell at which the stroke clears 1.0', () => {
    // Not merely "16 is big enough" - 16 is the tightest value that works, so the cut
    // is not quietly costing detail it did not need to.
    expect(detailPxAt(LOD_MIN_MACHINE_PX - 1)).toBeLessThan(1.0);
  });
});

describe('ENDPOINT draws a body ABOVE the cut and a PRESENCE BLOCK below it (66-03)', () => {
  const endpoint = () => makeNode({ id: 9, kind: machine_kind.ENDPOINT, w: 1, h: 1 });

  for (const zoom of [2, 1, LOD_MIN_MACHINE_PX / CELL]) {
    it(`at zoom ${zoom} (at or above the cut) it has a chassis and a glyph`, () => {
      const { layer, bakes } = drawScene(sceneOf(endpoint()), zoom);
      const { body, chassis, glyph } = vectorPartsOf(rootAt(layer));
      expect(body!.visible).toBe(true);
      expect(strokeColorsOf(chassis!)).toEqual([RAMP4]);
      expect(glyph!.context).toBe(getAssetContext('endpoint'));
      expect(bakes()).toBe(0);
    });
  }

  for (const zoom of [(LOD_MIN_MACHINE_PX - 1) / CELL, 0.1]) {
    it(`at zoom ${zoom} (below the cut) it draws a PRESENCE BLOCK, and it bakes one`, () => {
      // THIS ASSERTION USED TO SAY THE OPPOSITE, AND IT WAS RIGHT AT THE TIME. From
      // 58-03 until 66-03 an endpoint below the cut drew NOTHING: kind 9 is absent from
      // GEN_KEY_OF and from LOD_TINTS, so the draw loop had no block to bake, and that
      // was a stated decision rather than an omission - the alternative was minting a
      // ninth hue into a colour set the maintainer had gated, and taking a ninth code point out of
      // a three-bit space that has none left.
      //
      // WIRE-03 made endpoints placeable by hand, and an absence that was defensible for
      // a machine only the demo scene carried is not defensible for one the user just
      // placed and then zoomed away from. The route around it costs neither a hue nor a
      // code: the block is `ramp[4]`, the structural ink the endpoint's own outline
      // already draws in above the cut, with NO corner code at all. See
      // `makeEndpointPresenceBlock`; the tint/absence/distance properties are gated in
      // `lodTints.test.ts`, and what is asserted HERE is that the layer draws it.
      const { layer, bakes } = drawScene(sceneOf(endpoint()), zoom);
      const { body, sprite } = vectorPartsOf(rootAt(layer));
      expect(sprite.visible, 'the endpoint presence block must be on screen').toBe(true);
      expect(sprite.texture, 'a visible Sprite with no texture paints a white square').toBeDefined();
      expect(body === undefined || body.visible === false).toBe(true);
      expect(bakes()).toBe(1);
    });
  }

  it('the presence block is the STRUCTURAL ink, not a ninth LOD kind tint', () => {
    // The discriminator that keeps this from quietly becoming the ninth hue it was
    // routed around. Read from the SHIPPED baker and the SHIPPED skin, and compared
    // against the tint set ITSELF rather than against a copy of its eight numbers.
    const block = makeEndpointPresenceBlock(LOCKED_SKIN, CELL)(state_tag.IDLE, 1, 1);
    const rgb = (block.data[0] << 16) | (block.data[1] << 8) | block.data[2];
    expect(rgb).toBe(LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1]);
    expect(Object.values(LOD_TINTS)).not.toContain(rgb);
  });

  it('does NOT grow either LOD TABLE: LOD_TINTS and LOD_KIND_CODES stay at eight', () => {
    // RENAMED at plan 72-09, and the rename is the point. This used to be named for
    // neither LOD KEYSPACE growing, and half of that stopped being true the moment
    // HANDLER entered `GEN_KEY_OF` as a declared FACTORY alias: `GEN_KEY_OF` DID grow,
    // to nine, while the two LOD TABLES did not. A name asserting a number it no longer
    // holds is exactly the stale-but-green defect this repository renames rather than
    // tolerates. The two lines that matter are unchanged and must stay unchanged: eight
    // authored hues and eight corner codes in a saturated three-bit space.
    expect(Object.keys(LOD_TINTS)).toHaveLength(8);
    expect(Object.keys(LOD_KIND_CODES)).toHaveLength(8);
    expect(Object.keys(GEN_KEY_OF)).toHaveLength(9);
    expect(GEN_KEY_OF[machine_kind.ENDPOINT]).toBeUndefined();
  });

  it('a SINK at the SAME 1x1 footprint DOES bake a block below the cut', () => {
    // The discriminator: "nothing below the cut" is a property of the ENDPOINT, not of
    // the below-the-cut branch having quietly stopped working for everyone.
    const { layer, bakes } = drawScene(
      sceneOf(makeNode({ id: 7, kind: machine_kind.SINK, w: 1, h: 1 })),
      (LOD_MIN_MACHINE_PX - 1) / CELL,
    );
    expect(vectorPartsOf(rootAt(layer)).sprite.visible).toBe(true);
    expect(bakes()).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * WR-01: deleting a machine must not leak onto the SHARED asset context
 * ------------------------------------------------------------------ */

describe('a deleted machine unsubscribes from the shared GraphicsContext', () => {
  // THE LEAK THIS CATCHES, measured before it was fixed: 100 create/destroy cycles on
  // one TEE handle took `getAssetContext('tee')` from 0 to 100 'update' listeners and
  // 1 to 101 'unload' listeners, permanently. Pixi's `Graphics.destroy()` only detaches
  // from a context the Graphics OWNS; the glyph BORROWS a process-wide, never-evicted
  // one, so nothing ever called `.off()`. See `detachSharedContext` in machines.ts.
  //
  // This is asserted as GROWTH ACROSS CYCLES rather than as an absolute count, because
  // the shared context is module-global and other specs in this file have already
  // borrowed it - an absolute number would be an ordering-dependent assertion.
  const listeners = (subject: 'tee') => {
    const ctx = getAssetContext(subject) as unknown as {
      listenerCount: (e: string) => number;
    };
    return { update: ctx.listenerCount('update'), unload: ctx.listenerCount('unload') };
  };

  it('100 create + destroy cycles leave the listener counts exactly where they started', () => {
    const before = listeners('tee');
    const layer = createMachineLayer(
      LOCKED_SKIN,
      () => 1,
      () => ({ destroy: () => {} }) as SynthTexture,
    );
    const node = makeNode({ id: 1, kind: machine_kind.TEE });

    for (let i = 0; i < 100; i++) {
      layer.draw(sceneOf(node), 0);
      layer.draw(createSceneState(), 0); // the handle is gone -> the removal loop runs
    }

    const after = listeners('tee');
    expect(after.update, 'dead Graphics left subscribed to the shared context').toBe(before.update);
    expect(after.unload, 'dead Graphics left subscribed to the shared context').toBe(before.unload);
  });

  it('and the discriminator: a LIVE machine IS subscribed, so the check is not vacuous', () => {
    // Without this, the case above would pass on a glyph that never subscribed at all -
    // including on a layer that had stopped drawing glyphs entirely.
    const before = listeners('tee');
    const layer = createMachineLayer(
      LOCKED_SKIN,
      () => 1,
      () => ({ destroy: () => {} }) as SynthTexture,
    );
    layer.draw(sceneOf(makeNode({ id: 2, kind: machine_kind.TEE })), 0);
    expect(listeners('tee').update).toBe(before.update + 1);

    layer.draw(createSceneState(), 0);
    expect(listeners('tee').update).toBe(before.update);
  });
});

/* ------------------------------------------------------------------ *
 * WR-07: the glyph follows a KIND change, because `sig` says it does
 * ------------------------------------------------------------------ */

describe('a handle that changes kind gets the new kind\'s glyph', () => {
  it('drawing handle 1 as a TEE then as a MERGE re-points the shared context', () => {
    // `sig` is `${node.kind}|...` and everything else keyed on kind is rebuilt when it
    // changes - except the glyph, which used to be created once at construction from
    // `getAssetContext(subject)` and never re-pointed, so the TEE artwork stayed.
    //
    // Reachable in production: `RenderProducer::reset` (crates/fabrico-host/src/
    // render_packet.rs) restarts handles at 0 on every Load, New, LoadDemo and every tick
    // that folds an Undo or Redo, so after a keyframe one handle can name another machine
    // kind. A change across the machine and label boundary is the removal loops' job (the
    // CR-01 describe below); a change between two machine kinds is this re-point's, which
    // live leg 4 of 76-label-handle-reuse.live.spec.ts grades on the real host (a Source's
    // handle handed to a Sink by a Redo).
    const layer = createMachineLayer(
      LOCKED_SKIN,
      () => 1,
      () => ({ destroy: () => {} }) as SynthTexture,
    );

    layer.draw(sceneOf(makeNode({ id: 1, kind: machine_kind.TEE })), 0);
    const glyph = vectorPartsOf(rootAt(layer, 0)).glyph!;
    expect(glyph.context).toBe(getAssetContext('tee'));

    layer.draw(sceneOf(makeNode({ id: 1, kind: machine_kind.MERGE })), 0);
    // The SAME Graphics object, re-pointed - not a rebuilt body that happens to be right.
    expect(vectorPartsOf(rootAt(layer, 0)).glyph!).toBe(glyph);
    expect(glyph.context, "the glyph kept the old kind's artwork").toBe(getAssetContext('merge'));
  });

  it('and re-pointing does NOT leak the old context - the setter detaches it', () => {
    // The composition claim with WR-01: `Graphics.context`'s setter is the one Pixi
    // path that `off()`s the previous context, so a kind change must not add a listener
    // to the context it left behind.
    const teeCtx = getAssetContext('tee') as unknown as { listenerCount: (e: string) => number };
    const before = teeCtx.listenerCount('update');
    const layer = createMachineLayer(
      LOCKED_SKIN,
      () => 1,
      () => ({ destroy: () => {} }) as SynthTexture,
    );
    layer.draw(sceneOf(makeNode({ id: 1, kind: machine_kind.TEE })), 0);
    expect(teeCtx.listenerCount('update')).toBe(before + 1);
    layer.draw(sceneOf(makeNode({ id: 1, kind: machine_kind.MERGE })), 0);
    expect(teeCtx.listenerCount('update'), 'the vacated TEE context kept a listener').toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The live suite's mirrored copy of LOD_MIN_MACHINE_PX (found 2026-08-16)
// ---------------------------------------------------------------------------
//
// WHY THIS GATE EXISTS. `LOD_MIN_MACHINE_PX`'s own docblock says it is exported "so a
// spec reads the SHIPPED constant rather than a copy of it. A mirrored literal in a test
// agrees with itself forever." `e2e-live/10-machine-lod.spec.ts` is that mirrored
// literal. It declared 12 against a shipped 16 from plan 58-01 (2026-08-02)
// until this gate landed, and its own comment claimed it was "kept in sync with the
// render constant by this spec's own crossing assertion" - which it was not, because a
// literal compared against itself cannot detect its own drift. Mutation-tested during
// the v7.0 FEEL walk: setting the shipped constant to 0 or to 40 left that spec green.
//
// WHY IT IS A SOURCE SCAN AND NOT AN IMPORT. The live suite is structurally auditable as
// zero-mock: GATE-01 (`e2e-live/support/oracle.ts:6-14`) allows it exactly ONE product
// import, `frontend/shared/geometry.ts`, and nothing else. Importing this constant into
// the spec would buy sync at the cost of that audit. Scanning the spec's source from
// here keeps both properties, and matches the idiom `vectorOnly.test.ts` already uses to
// hold a greppable claim in another file.
//
// WHAT THIS DOES NOT FIX. The spec is also blind in a second, separate way: it asserts
// only that the wheel-out CROSSED the cut, never that the flat LOD block actually
// renders below it, so it would stay green if the block never drew at all. That is real
// and it is not this gate's job. It belongs with the scoped LOD work the maintainer routed out of
// v7.0 on 2026-08-16 (FEEL row 62-c).
describe('the live machine-LOD spec does not carry a stale copy of the cut', () => {
  const LIVE_SPEC = join(import.meta.dirname, '../../../e2e-live/10-machine-lod.spec.ts');

  it('the mirrored literal equals the shipped constant', () => {
    const source = readFileSync(LIVE_SPEC, 'utf8');
    const match = /^const LOD_MIN_MACHINE_PX = (\d+);$/m.exec(source);

    // Watch the scanner fail before trusting it: if the declaration is renamed, reshaped
    // or deleted, this gate must go RED rather than silently matching nothing and passing.
    expect(match, `no 'const LOD_MIN_MACHINE_PX = <n>;' declaration found in ${LIVE_SPEC}`).not.toBe(
      null,
    );

    expect(
      Number(match?.[1]),
      "the live spec's copy of LOD_MIN_MACHINE_PX has drifted from the shipped constant in " +
        'machines.ts - update the spec, or if the shipped cut moved deliberately, move both',
    ).toBe(LOD_MIN_MACHINE_PX);
  });
});

/* ------------------------------------------------------------------ *
 * THE LOAD GAUGE AT THE LAYER (71-06): parenting, the sig guard, and the
 * painted-cue hook that reads the PLOT rather than the model.
 * ------------------------------------------------------------------ */

describe('the load gauge is a root child, plotted only on a signature change', () => {
  /** The gauge Graphics for the node at `index`, addressed by LABEL not by index. */
  function gaugeOf(layer: { layer: Container }, index = 0): Graphics {
    const g = childNamed(rootAt(layer, index), 'machine-load-gauge');
    expect(g, 'the layer built no machine-load-gauge').toBeDefined();
    return g as Graphics;
  }

  it('lives on ROOT, not on BODY, so a rotated machine keeps its gauge horizontal', () => {
    // The rotation-invariance answer, asserted structurally rather than argued. A `body`
    // child would inherit `body.rotation` and a cue keyed to the top edge would then
    // read as a different state at rot 1.
    const { layer } = drawScene(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 4, rot: 1 })));
    const root = rootAt(layer);
    expect(childNamed(root, 'machine-load-gauge'), 'gauge is a ROOT child').toBeDefined();
    const body = childNamed(root, 'machine-body');
    expect(body, 'the body exists at this zoom').toBeDefined();
    expect(childNamed(body!, 'machine-load-gauge'), 'gauge is NOT a body child').toBeUndefined();
    // The body really is rotated, so the assertion above is about something.
    expect(body!.rotation).toBeCloseTo(Math.PI / 2, 6);
    // ...and the gauge is not.
    expect(gaugeOf(layer).rotation).toBe(0);
    expect(gaugeOf(layer).context.instructions.length).toBeGreaterThan(0);
  });

  it('a LOAD-ONLY change re-plots: node.load is genuinely in the signature', () => {
    // The failure this pins is silent. With `load` missing from `sig` the guard would not
    // fire on a machine filling from 2 to 3, so the gauge would freeze at whatever it
    // first drew - the cue dead while every other assertion in this file still passed.
    const baker = countingBaker();
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, baker.make);
    layer.draw(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 2 })), 0);
    const gauge = gaugeOf(layer);
    const atTwo = gauge.context.instructions.length;
    layer.draw(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 3 })), 0);
    const atThree = gauge.context.instructions.length;
    expect(atThree).toBeGreaterThan(atTwo);
    // And the SAME scene twice does NOT re-plot: the guard still holds, so the gauge
    // costs zero per-frame work (MOTION-05).
    layer.draw(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 3 })), 1);
    expect(gauge.context.instructions.length).toBe(atThree);
  });

  it('below the LOD cut the gauge is gated off with the other vector cues', () => {
    // Down there the block's own two-pip stack carries the state; a 3u-thick mark would
    // be sub-pixel speckle, which is the same reasoning that gates the nubs off.
    const zoom = (LOD_MIN_MACHINE_PX - 1) / CELL;
    const { layer } = drawScene(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 4 })), zoom);
    expect(gaugeOf(layer).context.instructions.length).toBe(0);
  });
});

/** The gauge Graphics for the node at `index`, addressed by LABEL not by child index. */
function gaugeOfLayer(layer: { layer: Container }, index = 0): Graphics {
  const g = childNamed(rootAt(layer, index), 'machine-load-gauge');
  expect(g, 'the layer built no machine-load-gauge').toBeDefined();
  return g as Graphics;
}

describe('loadGaugesPainted() reads the PLOT, which is the only thing that makes it worth having', () => {
  it('goes 1 then 0 across a load-4 node and then a load-0 node', () => {
    // BOTH directions. An addition-only Set would report a stale mark forever, which is
    // the same untruth as reporting one that was never drawn.
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    expect(layer.loadGaugesPainted()).toBe(0);
    layer.draw(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 4 })), 0);
    expect(layer.loadGaugesPainted()).toBe(1);
    layer.draw(sceneOf(makeNode({ state: state_tag.IDLE, load: 0 })), 0);
    expect(layer.loadGaugesPainted()).toBe(0);
  });

  it('counts machines, not marks: three filling machines read 3', () => {
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(
      sceneOf(
        makeNode({ id: 1, state: state_tag.BACKED_UP, load: 4 }),
        makeNode({ id: 2, cell_x: 4, state: state_tag.WORKING, load: 1 }),
        makeNode({ id: 3, cell_x: 8, state: state_tag.WORKING, load: 3 }),
        makeNode({ id: 4, cell_x: 12, state: state_tag.IDLE, load: 0 }),
      ),
      0,
    );
    // The gauge is a function of LOAD, not of the state byte: a machine filling toward
    // the cap carries a partial run before it starts refusing.
    expect(layer.loadGaugesPainted()).toBe(3);
  });

  it('a load the DRAWING function refuses to plot is NOT counted, at full zoom', () => {
    // THE DIRECT DISCRIMINATOR between this hook and the vacuous one, and it needs no
    // zoom change and no mutation to make its point. `drawLoadGauge` floors its byte, so
    // a load of 0.5 is a value where the MODEL says "above zero" and the PLOT says
    // "nothing drawn". A hook deciding membership on `node.load > 0` reports 1 here; one
    // reading the Graphics back reports 0.
    //
    // Measured, not assumed: with membership rewritten to `node.load > 0` this case goes
    // red on its own, while "goes 1 then 0", "three read 3" and the destruction sweep all
    // stay GREEN even with the paint deleted entirely. Those three cannot tell the two
    // hooks apart; this one can.
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 0.5 })), 0);
    expect(gaugeOfLayer(layer).context.instructions.length, 'nothing was plotted').toBe(0);
    expect(layer.loadGaugesPainted(), 'and nothing is reported').toBe(0);
  });

  it('a machine that LEAVES the scene leaves the count, via the destruction sweep', () => {
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 4 })), 0);
    expect(layer.loadGaugesPainted()).toBe(1);
    layer.draw(createSceneState(), 0); // the handle is gone -> the removal loop runs
    expect(layer.loadGaugesPainted()).toBe(0);
  });

  it('and it drops to 0 below the LOD cut, where nothing is painted to report', () => {
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 4 })), 0);
    expect(layer.loadGaugesPainted()).toBe(1);
    // Same node, same load byte, zoomed out. The MODEL is identical; the PAINT is gone.
    // A hook reading the model would still say 1 here, and that is the entire distinction.
    const zoomed = createMachineLayer(
      LOCKED_SKIN,
      () => (LOD_MIN_MACHINE_PX - 1) / CELL,
      countingBaker().make,
    );
    zoomed.draw(sceneOf(makeNode({ state: state_tag.BACKED_UP, load: 4 })), 0);
    expect(zoomed.loadGaugesPainted()).toBe(0);
  });

  it('loadGaugePaintedOn(id) separates ONE machine from the board, which the count cannot', () => {
    // 71-review WR-05. The board-wide count is what a live spec had been using to make
    // a claim about a NAMED machine, and it cannot: `gaugesPainted` gains a member for
    // ANY node whose gauge plotted geometry, and `drawLoadGauge` plots at 1, 2 and 3 as
    // well as at the merged full bar. So a board where the named machine draws NOTHING
    // and a neighbour draws a partial run reads a happy non-zero count.
    //
    // This board IS that board: node 1 is the machine a spec would name and it plots
    // nothing (load 0), node 2 is the neighbour and it plots a partial run.
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(
      sceneOf(
        makeNode({ id: 1, state: state_tag.IDLE, load: 0 }),
        makeNode({ id: 2, cell_x: 4, state: state_tag.WORKING, load: 2 }),
      ),
      0,
    );
    expect(
      layer.loadGaugesPainted() > 0,
      'the board-wide probe is satisfied by the NEIGHBOUR alone - this is exactly the ' +
        'reading that let a per-machine message pass',
    ).toBe(true);
    expect(layer.loadGaugePaintedOn(1), 'but node 1 painted nothing').toBe(false);
    expect(layer.loadGaugePaintedOn(2), 'and node 2 is the one that did').toBe(true);
  });

  it('loadGaugePaintedOn reads the same PLOT-derived set, including the destruction sweep', () => {
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(sceneOf(makeNode({ id: 7, state: state_tag.BACKED_UP, load: 4 })), 0);
    expect(layer.loadGaugePaintedOn(7)).toBe(true);
    // A load the drawing function refuses to plot: model says "above zero", plot says
    // nothing. The scoped probe must agree with the Graphics, not with the byte.
    layer.draw(sceneOf(makeNode({ id: 7, state: state_tag.BACKED_UP, load: 0.5 })), 0);
    expect(layer.loadGaugePaintedOn(7)).toBe(false);
    layer.draw(sceneOf(makeNode({ id: 7, state: state_tag.BACKED_UP, load: 4 })), 0);
    expect(layer.loadGaugePaintedOn(7)).toBe(true);
    layer.draw(createSceneState(), 0); // the handle is gone -> the removal loop runs
    expect(layer.loadGaugePaintedOn(7), 'the destruction sweep clears it too').toBe(false);
    expect(layer.loadGaugePaintedOn(999), 'and an unknown id is simply false').toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * THE PORT NUBS AT THE LAYER (73-10). The port-list twin of the load-gauge
 * signature test above, and it exists because the gauge got that treatment in
 * 71-06 and the ports never did.
 *
 * WHAT WAS BROKEN. `sig` carried kind|state|load|w|h|rot|lod and NO port token.
 * A `+ Add output` on a Factory moves none of those seven: `grow_to_fit` on
 * 1 In / 2 Out / 1 Fault gives min 2x2, floored up by the Factory's 3x3 base, so
 * `w` and `h` do not move. The signature came out byte-identical, `rebuildNubs`
 * never ran, and the overlay kept the geometry it was plotted with when the node
 * first appeared.
 *
 * AND THE SURVIVORS WERE STALE TOO, which was the worse half until plan 74.1-14.
 * `reseat_ports` then seated a port purely by its index AMONG ITS ROLE, so the add
 * moved EVERY port: the Factory's catalog seats In (0,1) / Out (2,1) / Fault (1,2)
 * became In (0,0) / Out_0 (2,0) / Out_1 (2,1) / Fault (0,2), the corners. Since
 * the maintainer's ruling of 2026-10-04 ("Edits keep middle layout") the re-seat is
 * centre-out from the catalog box, so an add keeps every existing nub and the new
 * Out takes (2,2). A `RemovePort` still moves every later Out into the previous
 * slot, so survivors CAN move, and the key below still has to see a cell move.
 *
 * WHY IT HID: on the demo board a Factory churns `state` and `load` every few
 * ticks, which re-fires the signature and repairs the plot within a tick or two.
 * A freshly placed, idle Factory - the phase-73 walk board at (6,11) - is what
 * held it still long enough to be seen.
 * ------------------------------------------------------------------ */

/** The port-nub Graphics for the node at `index`, addressed by LABEL not by child index. */
function nubsOf(layer: { layer: Container }, index = 0): Graphics {
  const g = childNamed(rootAt(layer, index), 'machine-port-nubs');
  expect(g, 'the layer built no machine-port-nubs').toBeDefined();
  return g as Graphics;
}

/**
 * The PLOTTED nub geometry, read back off Pixi's own recorded path instructions as
 * `action(x,y,...)` tokens.
 *
 * An instruction COUNT alone cannot see this defect. A re-seat moves every nub
 * without changing how many there are, so the count is byte-identical across the
 * exact edit that leaves the overlay pointing at cells the model has vacated. The
 * coordinates are the only thing that moves, so the coordinates are what is asserted.
 */
function nubPlotOf(g: Graphics): string {
  return g.context.instructions
    .map((ins) => {
      const path = (ins.data as { path?: { instructions: { action: string; data: unknown[] }[] } })
        .path;
      return (path?.instructions ?? [])
        .map((s) => `${s.action}(${s.data.filter((d) => typeof d === 'number').join(',')})`)
        .join(' ');
    })
    .join(' | ');
}

/** A 3x3 Factory at the origin carrying `ports`, IDLE and unrotated. */
function factoryNode(ports: NodeView['ports'], over: Partial<NodeView> = {}): NodeView {
  return makeNode({ id: 1, kind: machine_kind.FACTORY, w: 3, h: 3, ports, ...over });
}

/** The Factory's CATALOG seats (command.rs:163-171): In (0,1) W, Out (2,1) E, Fault (1,2) S. */
const CATALOG_SEATS: NodeView['ports'] = [
  { index: 0, cell_x: 0, cell_y: 1, side: 3, role: 0, medium: 0 },
  { index: 1, cell_x: 2, cell_y: 1, side: 1, role: 1, medium: 0 },
  { index: 2, cell_x: 1, cell_y: 2, side: 2, role: 2, medium: 0 },
];

/** The same Factory AFTER one `+ Add output`, as the fold produces it since 74.1-14
 *  (state.rs `reseat_ports`, centre-out from the catalog box): the list is
 *  `[In, Out, Fault, Out]` (the add appends), every catalog seat is kept, and the new
 *  Out takes the slot below the first, (2,2). Until 74.1-14 this fixture read the
 *  corner seats In (0,0) / Out (2,0) / Out (2,1) / Fault (0,2). */
const AFTER_ADD_SEATS: NodeView['ports'] = [
  { index: 0, cell_x: 0, cell_y: 1, side: 3, role: 0, medium: 0 },
  { index: 1, cell_x: 2, cell_y: 1, side: 1, role: 1, medium: 0 },
  { index: 2, cell_x: 1, cell_y: 2, side: 2, role: 2, medium: 0 },
  { index: 3, cell_x: 2, cell_y: 2, side: 1, role: 1, medium: 0 },
];

describe('the port nubs re-plot when the PORT LIST moves, not only when kind/state/box do', () => {
  it('a PORT ADD on an already-drawn node re-plots: the fourth nub reaches the board', () => {
    // The node is drawn FIRST at its catalog seats - it is on screen, with an entry and
    // a signature - and only then gains a port. Drawing the 4-port node from scratch
    // would pass on the broken build, because a first draw always plots.
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(sceneOf(factoryNode(CATALOG_SEATS)), 0);
    const nubs = nubsOf(layer);
    const atThree = nubPlotOf(nubs);
    expect(atThree, 'the three catalog nubs are on the board to begin with').not.toBe('');

    layer.draw(sceneOf(factoryNode(AFTER_ADD_SEATS)), 0);
    const atFour = nubPlotOf(nubs);
    expect(atFour, 'the port list moved, so the nub overlay moved with it').not.toBe(atThree);
    // An Out is a disc plus a stem: two instructions. Four ports (In, Out, Out, Fault)
    // therefore plot MORE than three did, and the extra output really did reach the plot.
    expect(nubs.context.instructions.length).toBeGreaterThan(3);
  });

  it('a SAME-COUNT RE-SEAT re-plots: a count-only key would miss this one', () => {
    // Three ports before, three after, and every one of them in a different cell. This
    // is the case a `node.ports.length` token cannot see. Since 74.1-14 no single port
    // edit produces exactly this list (an add keeps every catalog seat), but a removal
    // still moves surviving Outs without the overlay's count being the thing that
    // changed, and the key must not rest on which re-seat rule the core runs: it has to
    // see ANY cell move. The cells below are the pre-74.1-14 corner seats.
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(sceneOf(factoryNode(CATALOG_SEATS)), 0);
    const nubs = nubsOf(layer);
    const centred = nubPlotOf(nubs);
    const centredCount = nubs.context.instructions.length;

    const reseated: NodeView['ports'] = [
      { index: 0, cell_x: 0, cell_y: 0, side: 3, role: 0, medium: 0 },
      { index: 1, cell_x: 2, cell_y: 0, side: 1, role: 1, medium: 0 },
      { index: 2, cell_x: 0, cell_y: 2, side: 2, role: 2, medium: 0 },
    ];
    layer.draw(sceneOf(factoryNode(reseated)), 0);
    expect(
      nubs.context.instructions.length,
      'the instruction count has NOT moved - that is exactly why a count key is not enough',
    ).toBe(centredCount);
    expect(nubPlotOf(nubs), 'but every nub is in a new cell').not.toBe(centred);
  });

  it('a MEDIUM change re-plots: the silhouette is a disc or a square, and it must follow', () => {
    // Same roles, same cells, same sides, same count. Only `medium` moves, and
    // `drawRoleNub` switches the role-0/1 body between a circle and a rect on it.
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(sceneOf(factoryNode(CATALOG_SEATS)), 0);
    const nubs = nubsOf(layer);
    const mechanical = nubPlotOf(nubs);
    expect(mechanical, 'the mechanical In is a disc').toContain('circle(');

    const electrical = CATALOG_SEATS.map((p) => ({ ...p, medium: 1 }));
    layer.draw(sceneOf(factoryNode(electrical)), 0);
    const plotted = nubPlotOf(nubs);
    expect(plotted).not.toBe(mechanical);
    expect(plotted, 'and the electrical In is a square').toContain('rect(');
  });

  it('the SAME ports twice do NOT re-plot: the guard still holds (MOTION-05)', () => {
    // The other direction, or the fix would be "re-plot every frame" wearing a
    // signature. Identical ports on a later frame must leave the overlay UNTOUCHED.
    //
    // COUNTED, never compared to itself. `rebuildNubs` opens with `g.clear()`, so a
    // rebuild on every frame reproduces byte-identical instructions - which means
    // `expect(nubPlotOf(nubs)).toBe(first)` holds whether the guard ran or not. This
    // case did exactly that until 2026-09-06, and an adversarial review measured what
    // it cost: hoisting ONLY the nub branch out of the memo, so the overlay re-plots
    // every frame while everything else stays guarded, left all 108 cases in this file
    // and all 2245 in the suite green. The `update` emission is the one signal that
    // separates "not re-plotted" from "re-plotted to the same bytes", and the counter
    // idiom is the file's own (see the 24-frame re-plot guard above), which watches
    // `chassis`/`notch`/`glyph`/`ring` and has never watched the nubs.
    const layer = createMachineLayer(LOCKED_SKIN, () => 1, countingBaker().make);
    layer.draw(sceneOf(factoryNode(CATALOG_SEATS)), 0);
    const nubs = nubsOf(layer);
    const first = nubPlotOf(nubs);

    let replots = 0;
    nubs.context.on('update', () => {
      replots += 1;
    });

    layer.draw(sceneOf(factoryNode(CATALOG_SEATS)), 1);
    layer.draw(sceneOf(factoryNode(CATALOG_SEATS)), 2);

    expect(replots, 'an unchanged port list re-plotted the nub overlay').toBe(0);
    // Belt and braces only. A re-plot to identical bytes satisfies this too, which is
    // precisely why the counter above is the real assertion and this is not.
    expect(nubPlotOf(nubs)).toBe(first);

    // ...and the counter is not asleep. If the `update` listener could never fire,
    // "zero re-plots" would be a fact about the listener and not about the layer, so a
    // genuine port move must push it off zero in the same test that trusts it.
    layer.draw(sceneOf(factoryNode(AFTER_ADD_SEATS)), 3);
    expect(replots, 'a real port move failed to re-plot, so the counter proves nothing').toBeGreaterThan(0);
    expect(nubPlotOf(nubs)).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Phase 76 (SHAPE-10, UI-SPEC 3.4): a Label draws its own box at EVERY zoom, read back off
// the `label-box` Graphics' plotted instructions through the same probe the live suite
// uses. A label is in neither LOD table, so without its own branch it would draw nothing.
// ---------------------------------------------------------------------------
describe('the label box (phase 76)', () => {
  const label = (): NodeView =>
    makeNode({ id: 7, kind: machine_kind.LABEL, cell_x: 10, cell_y: 12, w: 4, h: 1 });
  const sceneWith = (n: NodeView): SceneState => {
    const scene = createSceneState();
    scene.nodes.set(n.id, n);
    return scene;
  };
  const SAND = 0xe0d388;
  // The 4 by 1 cell rect at (10,12), inset 4 world px on every side.
  const RECT = { x: 10 * 32 + 4, y: 12 * 32 + 4, w: 4 * 32 - 8, h: 32 - 8 };

  it('at zoom 1: a Sand box, filled at alpha 0.16, outlined 2 world px', () => {
    const layer = createMachineLayer(LOCKED_SKIN, () => 1);
    layer.draw(sceneWith(label()), 0);
    expect(layer.labelBoxOn(7)).toEqual({
      instructions: 2,
      fill: { color: SAND, alpha: 0.16 },
      stroke: { color: SAND, alpha: 1, width: 2 },
      rect: RECT,
    });
  });

  it('at zoom 0.25 (below the LOD cut): the SAME box, outline widened to stay one screen px', () => {
    const layer = createMachineLayer(LOCKED_SKIN, () => 0.25);
    layer.draw(sceneWith(label()), 0);
    expect(layer.labelBoxOn(7)).toEqual({
      instructions: 2,
      fill: { color: SAND, alpha: 0.16 },
      stroke: { color: SAND, alpha: 1, width: 4 },
      rect: RECT,
    });
  });

  it('draws no machine body, nubs or LOD sprite for a label, and drops the box when the label goes', () => {
    const layer = createMachineLayer(LOCKED_SKIN, () => 1);
    layer.draw(sceneWith(label()), 0);
    const names = layer.layer.children.map((c) => c.label);
    expect(names, 'the only child is the label box').toEqual(['label-box']);
    expect(layer.portNubInstructionsOn(7), 'no nubs for a label').toBe(0);
    layer.draw(createSceneState(), 0);
    expect(layer.labelBoxOn(7), 'the box is gone with the label').toBeNull();
    expect(layer.layer.children.length).toBe(0);
  });

  // Plan 76-03 (SHAPE-12, D-05, memory fabrico-model-oracle-blindspot). The box draws the
  // colour the HOST holds, and a colour change ALONE re-plots it: the same node, same
  // cells, same size, same zoom, only `label.colour` moved from 0 (Sand) to 3 (Lilac). A
  // layer that keyed its re-plot on the box and the stroke but not the colour would keep
  // plotting Sand here while the model said Lilac, and only this read-back could tell.
  //
  // RED AT THE START REVISION: the layer drew Sand for every colour, so the
  // probe read `0xe0d388` where `0xbea2ea` was expected.
  it('a_colour_change_alone_replots_the_label_box', () => {
    const LILAC = 0xbea2ea;
    const layer = createMachineLayer(LOCKED_SKIN, () => 1);
    const node = label();
    node.label = { text: '', colour: 0 };
    layer.draw(sceneWith(node), 0);
    expect(layer.labelBoxOn(7)?.fill).toEqual({ color: SAND, alpha: 0.16 });
    const lilac: NodeView = { ...node, label: { text: '', colour: 3 } };
    layer.draw(sceneWith(lilac), 1);
    expect(layer.labelBoxOn(7)).toEqual({
      instructions: 2,
      fill: { color: LILAC, alpha: 0.16 },
      stroke: { color: LILAC, alpha: 1, width: 2 },
      rect: RECT,
    });
  });

  it('an absent or out-of-range colour byte draws Sand, the default the host mints', () => {
    const layer = createMachineLayer(LOCKED_SKIN, () => 1);
    const node = label();
    node.label = null;
    layer.draw(sceneWith(node), 0);
    expect(layer.labelBoxOn(7)?.fill?.color).toBe(SAND);
    layer.draw(sceneWith({ ...node, label: { text: '', colour: 9 } }), 1);
    expect(layer.labelBoxOn(7)?.fill?.color).toBe(SAND);
  });

});

// ---------------------------------------------------------------------------
// Plan 76-08 (review CR-01, verification truth 7): A HANDLE REMINTED WITH A NEW KIND.
// `RenderProducer::reset` restarts render handles at 0 on every keyframe (Undo, Redo,
// Load, New, LoadDemo), and after one the handles are the nodes' rank in NodeId order. So
// the handle a label held can be a machine's after the next keyframe: place a Label, place
// a Source, delete the label, Ctrl+Z, Ctrl+Shift+Z, and the Source alone is handle 0, the
// handle the label held after the Undo. The scene model is right; these cases read the
// LAYER, through the same `labelBoxOn` and `drawnNodes` read-backs the live suite uses.
// The positive control runs first, so a layer that never drew the box cannot pass.
//
// RED AT THE INSTRUMENT COMMIT (before `labelBoxStays`): both zoom cases failed
// "the deleted label's box is still drawn on handle 0: expected { instructions: 2, ...(3) }
// to be null", the received box the Sand 120 by 24 rect at x 324, y 388.
// ---------------------------------------------------------------------------
describe('a handle reminted with a new kind (CR-01)', () => {
  const SAND = 0xe0d388;
  // The 4 by 1 cell rect at (10,12), inset 4 world px on every side.
  const RECT = { x: 10 * 32 + 4, y: 12 * 32 + 4, w: 4 * 32 - 8, h: 32 - 8 };
  const labelAt = (id: number): NodeView =>
    makeNode({ id, kind: machine_kind.LABEL, cell_x: 10, cell_y: 12, w: 4, h: 1 });
  /** A Source at (cx, cy) built from its catalog row, its one east Out port in world cells. */
  const sourceAt = (id: number, cx: number, cy: number): NodeView => {
    const row = catalogEntry(machine_kind.SOURCE);
    return makeNode({
      id,
      kind: machine_kind.SOURCE,
      cell_x: cx,
      cell_y: cy,
      w: row.w,
      h: row.h,
      rot: 0,
      ports: row.ports.map((p) => ({
        index: p.index,
        cell_x: cx + p.local_x,
        cell_y: cy + p.local_y,
        side: p.side,
        role: p.role,
        medium: p.medium,
      })),
    });
  };

  for (const zoom of [1, 0.25]) {
    it(`a_label_handle_reused_by_a_machine_drops_the_label_box (zoom ${zoom})`, () => {
      const layer = createMachineLayer(
        LOCKED_SKIN,
        () => zoom,
        () => ({ destroy: () => {} }) as SynthTexture,
      );
      // After the Undo keyframe: the label is handle 0, the Source handle 1.
      layer.draw(sceneOf(labelAt(0), sourceAt(1, 20, 12)), 0);
      // POSITIVE CONTROL: the box is drawn, and the census sees both.
      expect(layer.labelBoxOn(0), 'precondition: the label box is drawn before the remint').toEqual({
        instructions: 2,
        fill: { color: SAND, alpha: 0.16 },
        stroke: { color: SAND, alpha: 1, width: zoom === 1 ? 2 : 4 },
        rect: RECT,
      });
      expect(layer.drawnNodes()).toEqual({ machines: [1], labels: [0], strays: 0 });
      expect(layer.portNubInstructionsOn(1), 'precondition: the Source plotted its nub').toBe(
        zoom === 1 ? 2 : 0,
      );

      // After the Redo keyframe: the Source alone, on the handle the label held.
      layer.draw(sceneOf(sourceAt(0, 20, 12)), 1);
      expect(layer.labelBoxOn(0), 'the deleted label\'s box is still drawn on handle 0').toBeNull();
      expect(layer.layer.children.length, 'one child: the Source root').toBe(1);
      expect(layer.drawnNodes()).toEqual({ machines: [0], labels: [], strays: 0 });
      // The root on handle 0 draws the Source's art above the cut and no glyph below it.
      expect(layer.glyphSubjectOn(0)).toBe(zoom === 1 ? 'source' : null);
    });
  }

  // THE REVERSE REMINT (the machine half, plan 76-13's cases, landed in the 76-08 refuter
  // round). Place a Source, place a Label, delete the Source, Ctrl+Z, Ctrl+Shift+Z: after
  // the Undo the Source is handle 0 and the label handle 1, after the Redo the label alone
  // is handle 0. The machine-entry loop used to drop a root only when its handle
  // disappeared, and the label branch `continue`s before the machine code, so the deleted
  // Source's root (chassis, glyph, nubs) stayed drawn beside the label's box.
  //
  // RED AT THE INSTRUMENT COMMIT (before `machineEntryStays`): both zoom cases
  // failed "one child: the label box: expected 2 to be 1", and both swap cases below
  // failed "two children: one root, one box: expected 3 to be 2".
  for (const zoom of [1, 0.25]) {
    it(`a_machine_handle_reused_by_a_label_drops_the_machine_root (zoom ${zoom})`, () => {
      const layer = createMachineLayer(
        LOCKED_SKIN,
        () => zoom,
        () => ({ destroy: () => {} }) as SynthTexture,
      );
      // After the Undo keyframe: the Source is handle 0, the label handle 1.
      layer.draw(sceneOf(sourceAt(0, 20, 12), labelAt(1)), 0);
      // POSITIVE CONTROL: the root and its nub are drawn, and the census sees both.
      expect(layer.drawnNodes()).toEqual({ machines: [0], labels: [1], strays: 0 });
      expect(layer.portNubInstructionsOn(0), 'precondition: the Source plotted its nub').toBe(
        zoom === 1 ? 2 : 0,
      );
      expect(layer.glyphSubjectOn(0)).toBe(zoom === 1 ? 'source' : null);

      // After the Redo keyframe: the label alone, on the handle the Source held.
      layer.draw(sceneOf(labelAt(0)), 1);
      expect(layer.layer.children.length, 'one child: the label box').toBe(1);
      expect(layer.portNubInstructionsOn(0), 'the deleted Source\'s nubs are still drawn on handle 0').toBe(0);
      expect(layer.drawnNodes()).toEqual({ machines: [], labels: [0], strays: 0 });
      expect(layer.glyphSubjectOn(0), 'the deleted Source\'s glyph is still drawn on handle 0').toBeNull();
      expect(layer.labelBoxOn(0)?.rect).toEqual(RECT);
    });
  }

  // THE SWAP IN PLACE: a label and a machine trade handles in one keyframe (the refuters'
  // second shape). Each handle changes kind in the same frame, in both directions at once.
  for (const zoom of [1, 0.25]) {
    it(`a_label_and_a_machine_trading_handles_leave_one_of_each (zoom ${zoom})`, () => {
      const layer = createMachineLayer(
        LOCKED_SKIN,
        () => zoom,
        () => ({ destroy: () => {} }) as SynthTexture,
      );
      layer.draw(sceneOf(labelAt(0), sourceAt(1, 20, 12)), 0);
      expect(layer.drawnNodes(), 'precondition').toEqual({ machines: [1], labels: [0], strays: 0 });

      layer.draw(sceneOf(sourceAt(0, 20, 12), labelAt(1)), 1);
      expect(layer.layer.children.length, 'two children: one root, one box').toBe(2);
      expect(layer.drawnNodes()).toEqual({ machines: [0], labels: [1], strays: 0 });
      expect(layer.labelBoxOn(0), 'no box on the machine handle').toBeNull();
      expect(layer.labelBoxOn(1)?.rect).toEqual(RECT);
      expect(layer.portNubInstructionsOn(1), 'no nubs on the label handle').toBe(0);
      expect(layer.glyphSubjectOn(1), 'no glyph on the label handle').toBeNull();
      expect(layer.glyphSubjectOn(0)).toBe(zoom === 1 ? 'source' : null);
    });
  }
});
