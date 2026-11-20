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

export interface CaptureRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CapturePort {
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
        ports: { cell_x: number; cell_y: number; side: number; role: number }[];
        label: unknown;
      }[];
    };
    cablePolylines(): { x: number; y: number }[][];
    itemDots(): { x: number; y: number }[];
    alertRingCentres(): { x: number; y: number }[];
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
    nodes: scene.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      state: n.state,
      cells: n.cells.map(([x, y]) => [x, y] as [number, number]),
      ports: n.ports.map((p) => ({ cell_x: p.cell_x, cell_y: p.cell_y, side: p.side, role: p.role })),
      isLabel: n.label !== null,
    })),
    panels: Array.from(document.querySelectorAll('.fab-panel')).map(rectOf),
    gl: {
      antialias: ctx === null ? null : (ctx.getContextAttributes()?.antialias ?? null),
      samples: ctx === null ? null : (ctx.getParameter(ctx.SAMPLES) as number),
    },
    cables: hook.cablePolylines().map((line) => line.map((p) => ({ x: p.x, y: p.y }))),
    itemDots: hook.itemDots().map((p) => ({ x: p.x, y: p.y })),
    labelWords: Array.from(document.querySelectorAll('[data-testid="label-words"]')).map(rectOf),
    alertRings: hook.alertRingCentres().map((p) => ({ x: p.x, y: p.y })),
  };
}
