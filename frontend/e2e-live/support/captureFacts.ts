// captureFacts.ts - the facts a board capture is measured against, read from the page in one call.
//
// `collectCaptureFacts` is a self-contained in-page function (no imports, no outer variables), so
// the same read can go to the real app through an inspector socket. It only reads: the read-only
// `window.__fabrico` getters, the board canvas, the chrome panels' and label words' rectangles and
// the live WebGL context's attributes. It calls no hook that writes and dispatches no event.
//
// Besides where the machines are, it reads what can sit on top of a machine's outline, so the
// measurer can keep those pixels out of a width: cables (drawn above machines), item dots, label
// words (a DOM overlay) and the alert rings around faulted machines.
//
// For the glyph, port and belt properties it also reads where each machine's glyph is drawn and
// which art it is (`glyphSubjectOn`, `glyphBoxOn`, read off the live Pixi objects), each port's
// catalog index, and each belt's drawn tiles, docks and plotted junction collars.

export interface CaptureRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CapturePort {
  /** The port's catalog index (identity-stable across Rotate). */
  index: number;
  cell_x: number;
  cell_y: number;
  /** The cell edge the port faces: N=0, E=1, S=2, W=3. */
  side: number;
  /** In=0, Out=1, Fault=2. */
  role: number;
}

export interface CaptureNode {
  id: number;
  kind: number;
  state: number;
  /** Footprint cells in world cell coordinates. */
  cells: [number, number][];
  ports: CapturePort[];
  /** A label node: its words sit in a DOM overlay and it has no chassis outline. */
  isLabel: boolean;
  /**
   * The glyph as drawn, or null when the machine draws none here (below the detail cut, or a label):
   * `subject` is the art (`'factory'` for the Factory and every kind that draws its art), `box` the
   * glyph Graphics' position and drawn size and the footprint size, all in px in the body's
   * unrotated frame (`window.__fabrico.glyphBoxOn`).
   */
  glyph: { subject: string; box: { x: number; y: number; w: number; h: number; footW: number; footH: number } } | null;
}

/** One drawn belt tile: its cell and its straight (`axis` X=0, Y=1) or corner kind. */
export interface CaptureBeltTile {
  cell_x: number;
  cell_y: number;
  kind: { Straight: { axis: number } } | { Corner: { from: number; to: number } };
}

export interface CaptureBelt {
  id: number;
  /** The tiles as drawn, tail first (`scene().belts[i].tiles`). */
  tiles: CaptureBeltTile[];
  /** Per-end docks, Head before Tail: the docked node or belt handle and the port index. */
  docks: { end: 'Head' | 'Tail'; node: number; port: number }[];
  /** `window.__fabrico.beltCollarCentresOn(id)`: each stroked circle on the belt's end marks, in world px. */
  collars: { x: number; y: number }[];
}

export interface CaptureFacts {
  /** `window.devicePixelRatio`. */
  dpr: number;
  /** The board canvas's backing store, `canvas.width` by `canvas.height`. */
  backing: { width: number; height: number };
  /** The board canvas's CSS size, `clientWidth` by `clientHeight`. */
  client: { width: number; height: number };
  /** The board canvas's client rectangle in CSS px. */
  clientRect: CaptureRect;
  /** `window.__fabrico.camera()`: screen = world x scale + pan, in CSS px from the canvas origin. */
  camera: { x: number; y: number; scale: number };
  tick: number;
  nodes: CaptureNode[];
  /** Client rectangles of the `.fab-panel` chrome panels, in CSS px. */
  panels: CaptureRect[];
  /** The live context's `getContextAttributes().antialias` and `SAMPLES`; null with no context. */
  gl: { antialias: boolean | null; samples: number | null };
  /** `window.__fabrico.cablePolylines()`: each resting cable's plotted polyline, in world px. */
  cables: { x: number; y: number }[][];
  /** `window.__fabrico.itemDots()`: each item dot's centre as plotted, in world px. */
  itemDots: { x: number; y: number }[];
  /** Client rectangles of the label words overlay elements, in CSS px. */
  labelWords: CaptureRect[];
  /** `window.__fabrico.alertRingCentres()`: the alert rings around faulted machines, in world px. */
  alertRings: { x: number; y: number }[];
  /** Every belt in the scene, in id order. */
  belts: CaptureBelt[];
}

/** Read every fact a capture is measured against. Read-only; see the file header. */
export function collectCaptureFacts(): CaptureFacts {
  type Hook = {
    camera(): { x: number; y: number; scale: number };
    scene(): {
      tick: number;
      nodes: {
        id: number;
        kind: number;
        state: number;
        cells: [number, number][];
        ports: { index: number; cell_x: number; cell_y: number; side: number; role: number }[];
        label: unknown;
      }[];
      belts: {
        id: number;
        tiles: { cell_x: number; cell_y: number; kind: CaptureBeltTile['kind'] }[];
        docks: { end: 'Head' | 'Tail'; node: number; port: number }[];
      }[];
    };
    cablePolylines(): { x: number; y: number }[][];
    itemDots(): { x: number; y: number }[];
    alertRingCentres(): { x: number; y: number }[];
    glyphSubjectOn(id: number): string | null;
    glyphBoxOn(id: number): { x: number; y: number; w: number; h: number; footW: number; footH: number } | null;
    beltCollarCentresOn(id: number): { x: number; y: number }[];
  };
  const hook = (window as unknown as { __fabrico?: Hook }).__fabrico;
  if (hook === undefined) throw new Error('collectCaptureFacts: window.__fabrico is not installed');
  let canvas: HTMLCanvasElement | null = null;
  for (const c of Array.from(document.querySelectorAll('canvas'))) {
    if (canvas === null || c.clientWidth * c.clientHeight > canvas.clientWidth * canvas.clientHeight) canvas = c;
  }
  if (canvas === null) throw new Error('collectCaptureFacts: no canvas on the page');
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  // An existing context is returned as is; a request for the other WebGL version answers null.
  const ctx = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
  const scene = hook.scene();
  return {
    dpr: window.devicePixelRatio,
    backing: { width: canvas.width, height: canvas.height },
    client: { width: canvas.clientWidth, height: canvas.clientHeight },
    clientRect: rectOf(canvas),
    camera: hook.camera(),
    tick: scene.tick,
    nodes: scene.nodes.map((n) => {
      const subject = hook.glyphSubjectOn(n.id);
      const box = hook.glyphBoxOn(n.id);
      return {
        id: n.id,
        kind: n.kind,
        state: n.state,
        cells: n.cells.map(([x, y]) => [x, y] as [number, number]),
        ports: n.ports.map((p) => ({ index: p.index, cell_x: p.cell_x, cell_y: p.cell_y, side: p.side, role: p.role })),
        isLabel: n.label !== null,
        glyph: subject === null || box === null ? null : { subject, box: { x: box.x, y: box.y, w: box.w, h: box.h, footW: box.footW, footH: box.footH } },
      };
    }),
    panels: Array.from(document.querySelectorAll('.fab-panel')).map(rectOf),
    gl: {
      antialias: ctx === null ? null : (ctx.getContextAttributes()?.antialias ?? null),
      samples: ctx === null ? null : (ctx.getParameter(ctx.SAMPLES) as number),
    },
    cables: hook.cablePolylines().map((line) => line.map((p) => ({ x: p.x, y: p.y }))),
    itemDots: hook.itemDots().map((p) => ({ x: p.x, y: p.y })),
    labelWords: Array.from(document.querySelectorAll('[data-testid="label-words"]')).map(rectOf),
    alertRings: hook.alertRingCentres().map((p) => ({ x: p.x, y: p.y })),
    belts: scene.belts.map((b) => ({
      id: b.id,
      tiles: b.tiles.map((t) => ({
        cell_x: t.cell_x,
        cell_y: t.cell_y,
        kind: 'Straight' in t.kind ? { Straight: { axis: t.kind.Straight.axis } } : { Corner: { from: t.kind.Corner.from, to: t.kind.Corner.to } },
      })),
      docks: b.docks.map((d) => ({ end: d.end, node: d.node, port: d.port })),
      collars: hook.beltCollarCentresOn(b.id).map((p) => ({ x: p.x, y: p.y })),
    })),
  };
}
