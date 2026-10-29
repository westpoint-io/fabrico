// @vitest-environment jsdom
//
// THE MACHINE LAYER'S READ-BACKS ARE READ-ONLY AND NEVER REPORT ART THAT IS NOT ON SCREEN
// (plan 76-08, the plan check's two `glyphSubjectOn` findings). Real `createMachineLayer`,
// real Pixi, no mocks, the `machineVector.test.ts` environment for the same reason (a real
// `GraphicsContext` needs `DOMParser`).
//
// IN ITS OWN FILE ON PURPOSE. The first case counts the process-wide asset contexts, which
// every draw builds lazily and never evicts. vitest isolates module state per FILE, so this
// file starts with zero built and only what it draws is in the cache; inside
// `machineVector.test.ts` every subject is built long before any late case runs, and a
// "nothing new was built" assertion there could not fail.

import { describe, expect, it } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { createMachineLayer, readLoadGaugeForm, SUBJECT_OF } from './machines.ts';
import { peekAssetContext } from '../svgAssets.ts';
import {
  drawLoadGauge,
  GAUGE_GAP_U,
  GAUGE_OUTSET_U,
  GAUGE_RUN_U,
  GAUGE_SLOTS,
  GAUGE_THICK_U,
  GAUGE_TICK_U,
} from './machineState.ts';
import { uToPx } from './machineChassis.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import { createSceneState } from '../sceneState.ts';
import type { SceneState } from '../sceneState.ts';
import { machine_kind, state_tag } from '../../protocol/kinds.ts';
import { catalogEntry, type NodeView } from '../../protocol/decode.ts';
import type { SynthTexture } from '../synth/textureCache.ts';

/** A machine of `kind` at (cx, cy), built from its catalog row with its ports in world cells. */
function machineAt(id: number, kind: number, cx: number, cy: number): NodeView {
  const row = catalogEntry(kind);
  return {
    id,
    kind,
    cell_x: cx,
    cell_y: cy,
    state: state_tag.IDLE,
    w: row.w,
    h: row.h,
    rot: 0,
    load: 0,
    ports: row.ports.map((p) => ({
      index: p.index,
      cell_x: cx + p.local_x,
      cell_y: cy + p.local_y,
      side: p.side,
      role: p.role,
      medium: p.medium,
    })),
  };
}

function sceneOf(...nodes: NodeView[]): SceneState {
  const scene = createSceneState();
  for (const n of nodes) scene.nodes.set(n.id, n);
  return scene;
}

/** Every distinct art subject, and how many of them have a built shared context. */
const SUBJECTS = [...new Set(Object.values(SUBJECT_OF))];
const builtCount = (): number => SUBJECTS.filter((s) => peekAssetContext(s) !== undefined).length;

/** The glyph Graphics under the root of the only machine on `layer`. */
function glyphOf(layer: Container): Graphics {
  const root = layer.children.find((c) => c.label !== 'label-box') as Container;
  const body = root.children.find((c) => c.label === 'machine-body') as Container;
  return body.children.find((c) => c.label === 'machine-glyph') as Graphics;
}

describe('the glyph read-back (plan 76-08)', () => {
  it('glyphSubjectOn builds no asset context: the cache holds exactly what was drawn', () => {
    // A SINK, not a Source, and that is load-bearing. The reverse lookup walks the subjects
    // in SUBJECT_OF order (source, factory, tee, balancer, router, merge, sink, ...), so a
    // lookup that BUILT as it walked would match a Source on its first step and build
    // nothing; a Sink makes it walk past six unbuilt subjects first.
    const layer = createMachineLayer(
      LOCKED_SKIN,
      () => 1,
      () => ({ destroy: () => {} }) as SynthTexture,
    );
    layer.draw(sceneOf(machineAt(0, machine_kind.SINK, 6, 6)), 0);
    const before = builtCount();
    // PRECONDITION: the draw built the sink's context and left others unbuilt, so a
    // building lookup has something to build.
    expect(peekAssetContext('sink'), 'precondition: the draw built the sink context').toBeDefined();
    expect(before, 'precondition: subjects are left unbuilt').toBeLessThan(SUBJECTS.length);
    expect(peekAssetContext('source'), 'precondition: the source context is unbuilt').toBeUndefined();

    expect(layer.glyphSubjectOn(0)).toBe('sink');
    expect(layer.glyphSubjectOn(9), 'no root on handle 9').toBeNull();

    expect(builtCount(), 'the read-back built shared asset contexts').toBe(before);
    expect(peekAssetContext('source'), 'the read-back built the source context').toBeUndefined();
  });

  it('a root drawn at zoom 1 then redrawn at 0.25 reads null, and a remint while zoomed out is no ghost', () => {
    let zoom = 1;
    const layer = createMachineLayer(
      LOCKED_SKIN,
      () => zoom,
      () => ({ destroy: () => {} }) as SynthTexture,
    );
    layer.draw(sceneOf(machineAt(0, machine_kind.SOURCE, 6, 6)), 0);
    expect(layer.glyphSubjectOn(0), 'drawn above the cut, the Source art').toBe('source');

    // Below the LOD cut the glyph Graphics is KEPT but its body is hidden.
    zoom = 0.25;
    layer.draw(sceneOf(machineAt(0, machine_kind.SOURCE, 6, 6)), 1);
    expect(layer.glyphSubjectOn(0), 'a hidden body reports no drawn art').toBeNull();

    // The handle is reminted to a SINK while zoomed out. The glyph is re-pointed only on a
    // vector frame, so it still holds the SOURCE context (the precondition that makes the
    // null above and below mean something: there IS a stale glyph to misreport).
    layer.draw(sceneOf(machineAt(0, machine_kind.SINK, 6, 6)), 2);
    expect(glyphOf(layer.layer).context, 'precondition: the hidden glyph still holds the Source art').toBe(
      peekAssetContext('source'),
    );
    expect(layer.glyphSubjectOn(0), 'the hidden, stale Source glyph read as drawn art').toBeNull();

    // Back above the cut: the glyph is re-pointed and shown, and the read-back says so.
    zoom = 1;
    layer.draw(sceneOf(machineAt(0, machine_kind.SINK, 6, 6)), 3);
    expect(layer.glyphSubjectOn(0)).toBe('sink');
  });
});

// ---------------------------------------------------------------------------
// THE GAUGE'S DRAWN FORM (plan 77-07, phase 77 D-04, research Pitfall 2 and A2).
// ---------------------------------------------------------------------------
//
// `loadGaugePaintedOn` is true at levels 1, 2 and 3 as well as at the merged full bar, so it
// cannot see the backed-up mark CLEAR: it stays true for as long as any tick is plotted. And an
// instruction count alone cannot tell level 1 (one short tick) from level 4 (one merged bar), so
// the read-back carries the drawn WIDTH too, read off the Graphics, and `merged` is true only for
// ONE instruction spanning the full run. `drawnAtTick` is the tick of the scene the latest draw
// pass read, so a live spec can match a drawn form to the model tick it was drawn FROM.

/** A Tee at (11,12) carrying `load`, in a scene at `tick`. */
function teeScene(load: number, tick: number): SceneState {
  const scene = sceneOf({ ...machineAt(7, machine_kind.TEE, 11, 12), load });
  scene.tick = tick;
  return scene;
}

function gaugeLayer() {
  return createMachineLayer(
    LOCKED_SKIN,
    () => 1,
    () => ({ destroy: () => {} }) as SynthTexture,
  );
}

describe('the load gauge form read-back (plan 77-07)', () => {
  it('loadGaugeFormOn at load 0 reads no instruction and no merged bar', () => {
    const layer = gaugeLayer();
    layer.draw(teeScene(0, 10), 0);
    expect(layer.loadGaugeFormOn(7)).toEqual({ instructions: 0, width: 0, merged: false, drawnAtTick: 10 });
  });

  it('loadGaugeFormOn at load 1 reads ONE instruction that is NOT the merged bar (the count-alone trap)', () => {
    const layer = gaugeLayer();
    layer.draw(teeScene(1, 11), 0);
    const form = layer.loadGaugeFormOn(7);
    expect(form?.instructions, 'level 1 plots one tick').toBe(1);
    expect(form?.width, 'one tick is GAUGE_TICK_U long').toBeCloseTo(uToPx(GAUGE_TICK_U), 3);
    expect(form?.merged, 'one short tick read as the merged bar').toBe(false);
  });

  it('loadGaugeFormOn at load 3 reads three instructions, not merged', () => {
    const layer = gaugeLayer();
    layer.draw(teeScene(3, 12), 0);
    const form = layer.loadGaugeFormOn(7);
    expect(form?.instructions).toBe(3);
    expect(form?.width, 'three ticks and two gaps fall short of the run').toBeLessThan(uToPx(GAUGE_RUN_U) - 0.5);
    expect(form?.merged).toBe(false);
  });

  it('loadGaugeFormOn at load 4 reads ONE instruction spanning the run, merged', () => {
    const layer = gaugeLayer();
    layer.draw(teeScene(4, 13), 0);
    const form = layer.loadGaugeFormOn(7);
    expect(form?.instructions, 'the full bar is one rect').toBe(1);
    expect(form?.width, 'the full bar spans GAUGE_RUN_U').toBeCloseTo(uToPx(GAUGE_RUN_U), 3);
    expect(form?.merged, 'the full bar read as not merged').toBe(true);
  });

  it('loadGaugeFormOn answers null for an id the layer has never drawn', () => {
    const layer = gaugeLayer();
    expect(layer.loadGaugeFormOn(7), 'before any draw').toBeNull();
    layer.draw(teeScene(4, 14), 0);
    expect(layer.loadGaugeFormOn(99), 'an id never in a scene').toBeNull();
  });

  it('loadGaugeFormOn carries the tick of the scene the latest draw pass read, even on an unchanged node', () => {
    const layer = gaugeLayer();
    layer.draw(teeScene(4, 100), 0);
    expect(layer.loadGaugeFormOn(7)?.drawnAtTick).toBe(100);
    // Same load, so the node's signature does not change and the gauge is NOT re-plotted;
    // the form on screen is still the one this pass drew FROM tick 101.
    layer.draw(teeScene(4, 101), 1);
    expect(layer.loadGaugeFormOn(7)).toMatchObject({ merged: true, drawnAtTick: 101 });
    layer.draw(teeScene(3, 102), 2);
    expect(layer.loadGaugeFormOn(7)).toMatchObject({ instructions: 3, merged: false, drawnAtTick: 102 });
  });
});

// ---------------------------------------------------------------------------
// MERGED MEANS THE BAR AS DRAWN (the 77-07 refuter round, refuters 2, 5 and 6).
// ---------------------------------------------------------------------------
//
// The first `merged` was "one instruction AND a drawn width within half a pixel of the run". Pixi
// counts one instruction per FILL CALL, not per shape, so four ticks with their gaps still open,
// plotted as one path under one fill, read one instruction spanning 25 px: merged. A bar filled
// transparent, in another ink, or on a Graphics nobody can see read merged too. `merged` now
// reads the geometry and the paint: exactly one rectangle primitive, filled (never only
// stroked), in the gauge ink at an alpha above 0, the run's length and the band's thickness at
// the band's height, on a Graphics that is visible, renderable and above alpha 0 up its whole
// parent chain. WHERE on the screen the bar sits along the head is graded live by the screen
// read (`MARK SEEN ON SCREEN`, `support/canvasDots.ts` `gaugeOnCanvas`), not here.

const INK = LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1];
const RUN_PX = uToPx(GAUGE_RUN_U);
const THICK_PX = uToPx(GAUGE_THICK_U);
const BAND_Y = -uToPx(GAUGE_OUTSET_U + GAUGE_THICK_U);

/** The Graphics `drawLoadGauge` plots for `load` on a 1x1 machine, parented under two containers. */
function plottedGauge(load: number): { g: Graphics; root: Container; layer: Container } {
  const g = new Graphics();
  drawLoadGauge(g, load, 1, 1, LOCKED_SKIN);
  const root = new Container();
  const layer = new Container();
  root.addChild(g);
  layer.addChild(root);
  return { g, root, layer };
}

/** A Graphics holding whatever `plot` puts in it, under one parent. */
function handPlotted(plot: (g: Graphics) => void): Graphics {
  const g = new Graphics();
  plot(g);
  new Container().addChild(g);
  return g;
}

/** Every Graphics labelled `machine-load-gauge` under `c`. */
function gaugesUnder(c: Container): Graphics[] {
  const out: Graphics[] = [];
  for (const child of c.children) {
    if (child.label === 'machine-load-gauge') out.push(child as Graphics);
    out.push(...gaugesUnder(child as Container));
  }
  return out;
}

describe('the gauge form reads the bar as drawn (the 77-07 refuter round)', () => {
  it('ACCEPTS the merged bar drawLoadGauge plots at load 4, and refuses load 3', () => {
    expect(readLoadGaugeForm(plottedGauge(4).g, 1, INK).merged).toBe(true);
    expect(readLoadGaugeForm(plottedGauge(3).g, 1, INK).merged).toBe(false);
  });

  it('REFUSES four ticks with their gaps open plotted as one path under ONE fill (refuter 6)', () => {
    const pitch = uToPx(GAUGE_TICK_U + GAUGE_GAP_U);
    const g = handPlotted((h) => {
      for (let i = 0; i < GAUGE_SLOTS; i += 1) h.rect(i * pitch, BAND_Y, uToPx(GAUGE_TICK_U), THICK_PX);
      h.fill({ color: INK });
    });
    const form = readLoadGaugeForm(g, 1, INK);
    expect(form.instructions, 'precondition: Pixi counts the one fill call as one instruction').toBe(1);
    expect(form.width, 'precondition: the four ticks span the full run').toBeCloseTo(RUN_PX, 3);
    expect(form.merged, 'four ticks under one fill read as the merged bar').toBe(false);
  });

  it('REFUSES two abutting halves under one fill: the merged bar is ONE rectangle', () => {
    const g = handPlotted((h) => {
      h.rect(0, BAND_Y, RUN_PX / 2, THICK_PX);
      h.rect(RUN_PX / 2, BAND_Y, RUN_PX / 2, THICK_PX);
      h.fill({ color: INK });
    });
    expect(readLoadGaugeForm(g, 1, INK).merged).toBe(false);
  });

  it('REFUSES the full bar filled transparent, in another ink, or only stroked (refuter 5)', () => {
    const clear = handPlotted((h) => h.rect(0, BAND_Y, RUN_PX, THICK_PX).fill({ color: INK, alpha: 0 }));
    expect(readLoadGaugeForm(clear, 1, INK).merged, 'alpha 0').toBe(false);
    const other = handPlotted((h) => h.rect(0, BAND_Y, RUN_PX, THICK_PX).fill({ color: INK ^ 0xffffff }));
    expect(readLoadGaugeForm(other, 1, INK).merged, 'another ink').toBe(false);
    const stroked = handPlotted((h) => h.rect(0, BAND_Y, RUN_PX, THICK_PX).stroke({ color: INK, width: 1 }));
    expect(readLoadGaugeForm(stroked, 1, INK).merged, 'stroked, not filled').toBe(false);
  });

  it('REFUSES a full-length rect of the wrong thickness or off the band', () => {
    const thin = handPlotted((h) => h.rect(0, BAND_Y, RUN_PX, THICK_PX / 3).fill({ color: INK }));
    expect(readLoadGaugeForm(thin, 1, INK).merged, 'a third of the band thick').toBe(false);
    const low = handPlotted((h) => h.rect(0, BAND_Y + 40, RUN_PX, THICK_PX).fill({ color: INK }));
    expect(readLoadGaugeForm(low, 1, INK).merged, 'below the band').toBe(false);
  });

  it('REFUSES the merged bar on a Graphics the screen does not show: hidden, unrenderable, or under a hidden or transparent parent (refuters 2 and 5)', () => {
    const hidden = plottedGauge(4);
    hidden.g.visible = false;
    expect(readLoadGaugeForm(hidden.g, 1, INK).merged, 'gauge.visible = false').toBe(false);
    const unrenderable = plottedGauge(4);
    unrenderable.g.renderable = false;
    expect(readLoadGaugeForm(unrenderable.g, 1, INK).merged, 'gauge.renderable = false').toBe(false);
    const faded = plottedGauge(4);
    faded.g.alpha = 0;
    expect(readLoadGaugeForm(faded.g, 1, INK).merged, 'gauge.alpha = 0').toBe(false);
    const rootHidden = plottedGauge(4);
    rootHidden.root.visible = false;
    expect(readLoadGaugeForm(rootHidden.g, 1, INK).merged, 'the machine root hidden').toBe(false);
    const layerFaded = plottedGauge(4);
    layerFaded.layer.alpha = 0;
    expect(readLoadGaugeForm(layerFaded.g, 1, INK).merged, 'the layer at alpha 0').toBe(false);
  });

  it('loadGaugeFormOn on the layer refuses its own merged bar once the gauge Graphics is hidden (refuter 2)', () => {
    const layer = gaugeLayer();
    layer.draw(teeScene(4, 20), 0);
    expect(layer.loadGaugeFormOn(7)?.merged, 'precondition: the drawn full bar reads merged').toBe(true);
    const gauges = gaugesUnder(layer.layer);
    expect(gauges.length, 'precondition: one gauge Graphics under the layer').toBe(1);
    gauges[0].visible = false;
    expect(layer.loadGaugeFormOn(7)?.merged, 'a hidden gauge read as the merged bar').toBe(false);
  });
});
