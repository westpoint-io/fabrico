import { Application, Container, ParticleContainer } from 'pixi.js';
import { createCamera, type Camera } from './camera';
import { createGridLayer } from './layers/grid';
import { createMachineLayer, type MachineLayer } from './layers/machines';
import { createBeltLayer, type BeltLayer } from './layers/belts';
import { SHIPPED_DOTS, createItemLayer, pixiDotPainter, type ItemLayer } from './layers/items';
import { createWireLayer, type WireLayer } from './layers/wires';
import { createOverlay, type OverlayApi } from './layers/overlay';
import { startRenderLoop } from './loop';
import { quantizedFrame } from './interp';
import { createSceneState, type SceneState } from './sceneState';
import { LOCKED_SKIN } from './synth/skins/locked';

/**
 * The per-layer Containers, bottom-to-top (Pattern 2). 07-09's gesture controller
 * and 07-08's loop attach to these via the scene handle.
 */
export interface SceneLayers {
  grid: Container;
  belts: Container;
  machines: Container;
  /** The item ParticleContainer (thousands-at-60fps batch path). */
  items: ParticleContainer;
  /**
   * The overhead electrical wire layer (WUI-01), SPLIT IN TWO since plan 66-05:
   * `cables` holds only the resting cable stroke, `terminals` holds the prong, the
   * nub, the endpoint inlet glyph and both comets. They are ADJACENT camera children
   * in that order, so the composite is byte-identical to the single Container they
   * replaced, and a future underlay is a one-line move of `cables` alone. See
   * `layers/wires.ts`'s `createWireLayer` docblock for the whole reason.
   */
  cables: Container;
  /** The wire terminals + comets (WUI-01, plan 66-05). Directly above `cables`. */
  terminals: Container;
  overlay: Container;
}

/**
 * The camera-composition view of {@link SceneLayers}: the same keys, each widened to
 * the base `Container`. DERIVED from `SceneLayers` by a mapped type rather than
 * restated as a second list of names, so the two can never drift apart. The widening
 * is deliberate: `ParticleContainer extends Container`, `composeCamera` uses nothing
 * but `addChild`, and that is what lets a GPU-free unit test pass seven tagged
 * stand-ins without faking a renderer capability.
 */
export type CameraLayers = { [K in keyof SceneLayers]: Container };

/**
 * THE camera z-order contract, as one callable statement.
 *
 * Bottom to top: grid < belts < items < machines < cables < terminals < overlay.
 * Items sit BELOW machines so dots slide under machine bodies at ingestion (D-16
 * locked contract); BOTH WIRE layers sit ABOVE machines so a cable reads as OVERHEAD
 * (crossing over a machine or a belt un-occluded) yet BELOW the board-drawn affordance
 * overlay so a selection or alert ring, a ghost or a DeleteControl always stays on top
 * (UI-SPEC z-order).
 *
 * SEVEN children since plan 66-05, not six. `cables` and `terminals` are the split
 * halves of the old single `wires` Container and they are ADJACENT, in that order, so
 * the composite is byte-identical to what shipped before the split (measured: the
 * `surface-wire-comet` pixel baseline did not move). Terminals above cables preserves
 * the shipped painter order exactly. The split exists so a future underlay is a
 * one-line move of `cables` below `machines` rather than a refactor that would bury
 * the 10px nub and the endpoint inlet glyph under the chassis stroke; the underlay is
 * NOT taken here (66-CONTEXT locked decision 1: wires stay overhead).
 *
 * This call IS the z-order contract. Nothing else in the renderer states the camera's
 * child order, and reordering the arguments below changes what occludes what on a real
 * board. It is lifted out of `bootPixi` for exactly one reason: so a test can drive it.
 * `bootPixi` cannot be called under vitest `environment: 'node'` (no window, no WebGL,
 * and `createItemLayer` throws without a renderer), so until this seam existed nothing
 * in the repo could redden on a reordered `addChild`, in either direction.
 * `pixiApp.test.ts` drives THIS function and reads the resulting children by identity.
 *
 * Keep it a pure extraction: ONE `addChild`, no second statement. `pixiApp.test.ts`
 * also asserts that `pixiApp.ts` contains exactly one `addChild` call in its source
 * text, which is what stops a later edit composing a seventh child onto
 * `cam.container` elsewhere in `bootPixi` and slipping past this seam.
 */
export function composeCamera(camera: Container, l: CameraLayers): void {
  camera.addChild(l.grid, l.belts, l.items, l.machines, l.cables, l.terminals, l.overlay);
}

/**
 * The stable handle a booted Fabrico scene exposes. 07-09 drives `cam`
 * (screen↔cell) + `overlay` (ghost/route/selection); 07-08 feeds `sceneState`
 * with decoded packets and the Ticker loop draws it. The canvas is owned by Pixi
 * and never re-rendered by React (07-09's chrome floats over it).
 */
export interface SceneHandle {
  app: Application;
  /** Root camera Container (pan = position, zoom = scale). */
  camera: Container;
  /** Camera controller — screen↔world↔cell helpers for the overlay + 07-09. */
  cam: Camera;
  /** Per-layer Containers (bottom→top). */
  layers: SceneLayers;
  /** Overlay affordance draws (showGhost/showRoute/showSelection) for 07-09. */
  overlay: OverlayApi;
  /**
   * The machine layer itself, exposed for the SAME reason `overlay` is: it owns a
   * read-only paint probe (`loadGaugesPainted`) that only the layer can answer, and
   * `window.__fabrico.backedUpMarksPainted` delegates to it rather than duplicating the
   * bookkeeping in the App (71-06). Handing the layer over does not hand a Pixi object
   * to the page: the App reads a NUMBER off it and exposes a boolean.
   */
  machines: MachineLayer;
  /**
   * The belt layer itself, exposed for the SAME reason `machines` is: it owns a
   * read-only paint probe (`endInstructionsOn`) that only the layer can answer, and
   * `window.__fabrico.beltEndInstructionsOn` delegates to it rather than duplicating
   * the bookkeeping in the App (74-09). Handing the layer over does not hand a Pixi
   * object to the page: the App reads a NUMBER off it.
   */
  belts: BeltLayer;
  /**
   * The wire layer itself, exposed for the SAME reason `belts` is: it owns a read-only
   * plot probe (`rerouteMarkStrokes`, plan 75-06) that only the layer can answer, and
   * `window.__fabrico.rerouteMarkStrokes` delegates to it. The App reads a NUMBER off it.
   */
  wires: WireLayer;
  /**
   * The item layer itself, exposed for the SAME reason `belts` and `wires` are: it owns a
   * read-only plot probe (`plottedDots`, plan 77-02) that only the layer can answer, and
   * `window.__fabrico.itemDots` delegates to it. The App reads plain NUMBERS off it; no
   * Pixi object reaches the page.
   */
  items: ItemLayer;
  /** The mutable scene buffer 07-08 applies decoded packets into. */
  sceneState: SceneState;
  /** Force a one-shot redraw of the given (or internal) scene. */
  drawScene(scene?: SceneState): void;
  /**
   * MOTION-04 deterministic frame readout — the quantized MOTION-01 frame index of
   * the loop's effective render clock. Pass-through of `RenderLoop.frame()`; the
   * `window.__fabrico` probe surface reads it.
   */
  frame(): number;
  /**
   * MOTION-04 render-clock pin (production-inert) — pass-through of
   * `RenderLoop.pinClock`. Controls ONLY the render frame (a display concern);
   * never writes scene.tick / a command / the log (threat T-26-01).
   */
  pinClock(n: number | null): void;
  /**
   * SAFE-02 second reduced-motion gate — pass-through of `RenderLoop.pinOverlay`.
   * `pinOverlay(true)` quiets the overlay's wall-clock PULSES (the seam `pinClock`
   * deliberately does NOT cover); `pinOverlay(false)` restores them. Since Phase 64
   * it is a flag handed to `overlay.tick`, not a frozen timestamp fed in place of
   * the clock, so the reject flash and the alert TTL still expire under reduced
   * motion (D-25). It writes ONLY the overlay's motion flag — never scene.tick / a
   * command / the log (threat T-34-DET). The App matchMedia effect pins this
   * together with pinClock.
   */
  pinOverlay(frozen: boolean): void;
  /**
   * SLOT-04 trailing item-interpolation toggle (production-inert, D-10) - pass-through
   * of `RenderLoop.setItemInterpolation`, which is where the full argument lives. It
   * writes ONLY a render-side boolean the item layer reads when placing dots; never
   * scene.tick, a GridCommand or the log (threat T-62-15). Default OFF, so the shipped
   * draw is byte-identical to the pre-Phase-62 one.
   */
  setItemInterpolation(on: boolean): void;
  /**
   * SLOT-03 pre-Phase-62 tread-appearance override (production-inert, D-18) -
   * pass-through of `RenderLoop.setTreadAppearanceOverride`, which is where the full
   * argument lives. It writes ONLY a render-side number the belt layer reads when
   * deriving a march advance; never scene.tick, a GridCommand or the log (threat
   * T-62-15). NULL by default, so the shipped tread is the wire-derived one, and it
   * carries no figure of its own at any layer of this pass-through.
   */
  setTreadAppearanceOverride(pxPerTick: number | null): void;
  /** Stop the render loop + detach camera listeners. */
  stop(): void;
}

/** Backward-compatible alias (App.tsx imports `PixiScene`). */
export type PixiScene = SceneHandle;

/**
 * Boot ONE Pixi v8 Application and build the layered camera scene + Ticker loop.
 *
 * v8 init is async (`await app.init`). The caller (App.tsx) mounts `app.canvas`
 * OUTSIDE React's reconciler and guards StrictMode double-invoke with a
 * `disposed` flag (Pattern 1 / Pitfall 5).
 */
export async function bootPixi(): Promise<SceneHandle> {
  const app = new Application();
  await app.init({
    resizeTo: window,
    // The canvas background reads the darkest ramp step (index 0) of the ONE locked
    // skin, so the void behind the floor belongs to the same data-driven world.
    background: LOCKED_SKIN.palette.ramp[0],
    // antialias OFF (SKIN-05, final step). Safe only now that plans 25-02..25-05
    // deleted every vector Graphics plot (machine/belt/item/overlay bodies are all
    // synth sprites baked at native CELL with nearest-neighbor sampling): with no
    // vector edges left to smooth, AA would only blur the pixel-exact sprites. The
    // whole scene renders crisp at CELL=32 integer scale. (roundPixels stays
    // project-default unset/false: MOTION-07 (Phase 26) RESOLVED the snapping
    // trilemma by quantizing ONLY item-dot positions to device pixels in the item
    // layer - a global roundPixels flip would coarsely snap the whole scene and kill
    // the smooth analytic item glide, so it is deliberately NOT enabled.)
    antialias: false,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  const sceneState = createSceneState();
  const getScene = (): SceneState => sceneState;

  // Grid re-tiles on every camera change; create it after the camera via a
  // hoisted closure so the camera's onChange can call it.
  let redrawGrid = (): void => {};
  // NAV-06: camera onChange fires many times per drag frame; route it through an
  // rAF dirty-flag coalescer (defined below, after `grid` exists) so the grid
  // re-tiles at most once per animation frame. Hoisted like `redrawGrid` for late
  // binding, since the camera is created before the grid.
  let scheduleGridRedraw = (): void => {};
  const cam = createCamera(app, () => scheduleGridRedraw());

  const grid = createGridLayer();
  // FLOW-03/06/07: thread the LIVE camera zoom into the belt layer twice - `scale`
  // (zoom alone, for LOD selection + the cap floor) and `quantum` (DPR * zoom, for
  // the device-pixel tread snap). `undefined` selects the default GPU cache. Both
  // read fresh each draw via the closures; renderer-only, no schema change. Both are
  // consumed each draw: scale -> LOD selection + dock cap floor, quantum -> device-pixel
  // tread snap.
  const belts = createBeltLayer(
    LOCKED_SKIN,
    undefined,
    () => cam.worldScale(),
    () => app.renderer.resolution * cam.worldScale(),
  );
  // READ-05: thread the LIVE camera zoom into the machine layer (the last render
  // layer not yet zoom-threaded - belts and items already are). Below the LOD cut
  // each machine sprite swaps to a solid kind-tinted, state-pipped block. Read fresh
  // each draw via the closure; renderer-only, one-way display-only, never assigned
  // back into the camera/scene/command/tick (T-33-DET), mirroring the belt wiring.
  const machines = createMachineLayer(LOCKED_SKIN, () => cam.worldScale());
  // MOTION-07: thread the LIVE device-pixel quantum (DPR * continuous zoom) into the
  // item layer so its per-dot snap tracks both display density and zoom. Read fresh
  // each draw via the closure; renderer-only, no schema change. FLOW-03: also thread
  // the camera zoom ALONE (`scale`) for the 31-07 item dot zoom-floor, kept separate
  // from the DPR*zoom quantum.
  // VEC-01 (plan 61-05): the dot is VECTOR now, so the layer needs a rasteriser to
  // turn its geometry into the Texture a Particle binds - `pixiDotPainter` wraps the ONE
  // renderer capability it uses (render a container into a render target) and nothing
  // else. There is no working default: an unwired layer throws at construction rather
  // than silently falling back to the retired pixel bake. It PAINTS INTO the layer's one
  // long-lived RenderTexture rather than minting one per zoom bucket - see the painter's
  // docblock for why freeing the outgoing texture killed the renderer.
  const items = createItemLayer(
    LOCKED_SKIN,
    () => app.renderer.resolution * cam.worldScale(),
    () => cam.worldScale(),
    SHIPPED_DOTS,
    pixiDotPainter(app.renderer),
  );
  // WUI-01 overhead wire layer: thread the SAME live camera zoom (LOD cut + low-zoom
  // dot floor) and DPR*zoom quantum (device-pixel snap) as the belt/item layers.
  // Renderer-only closures, read fresh each draw, never written back (T-31-DET).
  const wires = createWireLayer(
    LOCKED_SKIN,
    () => cam.worldScale(),
    () => app.renderer.resolution * cam.worldScale(),
  );
  const overlay = createOverlay(getScene, () => cam.worldScale());

  const layers: SceneLayers = {
    grid: grid.layer,
    belts: belts.layer,
    machines: machines.layer,
    items: items.layer,
    cables: wires.cables,
    terminals: wires.terminals,
    overlay: overlay.layer,
  };

  // Compose bottom to top into the camera per the UI-SPEC layer contract. The whole
  // z-order rationale now lives on `composeCamera` above, which is the ONE statement
  // that states the order and the one thing `pixiApp.test.ts` can drive. The `layers`
  // handle is built HERE, a few lines earlier than it used to be, purely so this call
  // can pass it; nothing between here and its old position reads it.
  composeCamera(cam.container, layers);

  redrawGrid = (): void => grid.redraw(cam, app.screen.width, app.screen.height);

  // rAF dirty-flag coalescer (NAV-06): a burst of camera/resize changes within one
  // frame collapses into a single grid re-tile. It rebuilds the Graphics geometry
  // ONLY — the grid Container is isRenderGroup:true and Pixi's ticker (startRenderLoop
  // below) presents the dirtied render group, so we must NOT call app.render() here
  // (that would double-drive the ticker and regress the perf baseline).
  let gridDirty = false;
  let gridRaf = 0;
  scheduleGridRedraw = (): void => {
    gridDirty = true;
    if (gridRaf) return; // already scheduled this frame
    gridRaf = requestAnimationFrame(() => {
      gridRaf = 0;
      if (!gridDirty) return;
      gridDirty = false;
      grid.redraw(cam, app.screen.width, app.screen.height);
    });
  };

  // Frame-0 synchronous tile so the floor exists before any fit runs.
  redrawGrid();
  app.renderer.on('resize', scheduleGridRedraw);

  // One-shot redraw of a static/replayed scene (07-08 uses this for a frozen
  // scene); the live Ticker loop below drives the continuous animation.
  const drawScene = (scene: SceneState = sceneState): void => {
    // A frozen/replayed one-shot still gets a sensible resting frame derived from
    // the scene tick (MOTION-01/02), not a wall clock. The belt tread reads the
    // SAME frame index as the machines so a one-shot draw shows a consistent phase.
    const frame = quantizedFrame(scene.tick);
    machines.draw(scene, frame);
    belts.draw(scene, frame);
    items.draw(scene, scene.tick);
    // WUI-01: a one-shot/replayed frame draws the overhead wire cable + any pulse at
    // the scene tick (the same clock the belt tread reads), consistent phase. The
    // re-route mark (plan 75-06) reads the same tick: a one-shot frame has no other clock.
    wires.draw(scene, scene.tick, scene.tick);
  };
  drawScene();

  const loop = startRenderLoop(app, getScene, machines, belts, items, wires, overlay);

  return {
    app,
    camera: cam.container,
    cam,
    layers,
    overlay,
    machines,
    belts,
    wires,
    items,
    sceneState,
    drawScene,
    // MOTION-04: surface the loop's pinned-clock hook end to end (the local `loop`
    // already holds them) so window.__fabrico can read/control the render clock.
    frame: (): number => loop.frame(),
    pinClock: (n: number | null): void => loop.pinClock(n),
    // SAFE-02: surface the second reduced-motion gate end to end so the App
    // matchMedia effect can freeze the overlay pulse alongside the render clock.
    pinOverlay: (frozen: boolean): void => loop.pinOverlay(frozen),
    // SLOT-04 (D-10): surface the trailing-interpolation toggle end to end so the pace
    // sitting can compare smoothed and raw motion back to back on IDENTICAL geometry,
    // in the real binary, without a rebuild. Whether it ships is decided there.
    setItemInterpolation: (on: boolean): void => loop.setItemInterpolation(on),
    // SLOT-03 (D-18): surface the pre-Phase-62 tread-appearance override end to end so
    // FEEL row 60-a can be asked at the sitting on a board that still LOOKS like today's.
    // Null-defaulted at every layer; the only value ever passed comes from the
    // define-gated sitting panel.
    setTreadAppearanceOverride: (pxPerTick: number | null): void =>
      loop.setTreadAppearanceOverride(pxPerTick),
    stop: (): void => {
      loop.stop();
      // Cancel any pending grid re-tile so it never fires on a renderer torn down by
      // the StrictMode double-boot (mirror the pollRaf cleanup discipline in App.tsx).
      if (gridRaf) {
        cancelAnimationFrame(gridRaf);
        gridRaf = 0;
      }
      app.renderer.off('resize', scheduleGridRedraw);
      cam.destroy();
    },
  };
}
