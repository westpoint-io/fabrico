import { CELL, nubAnchor } from '../../shared/geometry';
import { CHASSIS_INSET_U, U_TO_PX } from '../../src/render/layers/machineChassis';
import { NUB_ELECTRICAL_HALF, NUB_FAULT_RING_R, NUB_R, NUB_STROKE } from '../../src/protocol/ports';
import { CABLE_WIDTH } from '../../src/render/cableGeometry';
import { DOT_SIZE } from '../../src/render/layers/items';
import { LOCKED_SKIN } from '../../src/render/synth/skins/locked';
import type { DecodedImage } from './canvasDots';
import type { CaptureFacts, CaptureNode, CaptureRect } from './captureFacts';
import { isBootZoom, zoomId, type CaptureCell } from './captureMatrix';

// boardMeasure.ts - pure measuring and grading over a decoded board capture.
//
// WHAT IT MEASURES. The width of each side of each machine's outline, in device pixels, the way
// the eye reads it. Every number comes from the capture's pixels; the model and the renderer's
// constants only say WHERE to look (which footprint, where the chassis band sits inside it,
// where the port nubs are), never what width to expect. The graded property is that the four
// sides of one machine read the same, which no constant can make true by agreeing with itself.
//
// ONE METRIC WITH ANTIALIASING ON AND OFF: COVERAGE. Each sample line crosses one side of the
// chassis band. On it the floor is the colour at each end of the line, and the ink is the pixel
// farthest from the floor. A pixel's coverage is how far it sits from the floor towards the ink,
// `clamp(dot(p - floor, ink - floor) / |ink - floor|^2, 0, 1)`. A side reports its CORE (pixels
// with coverage of at least `CORE_MIN`), its FRINGE (at least `FRINGE_MIN` and below `CORE_MIN`)
// and its EFFECTIVE width (the sum of coverage). With antialiasing off a pixel is floor or ink,
// so the core is the plain pixel count and the fringe is 0; with it on, the fringe is the grey
// row a crisp outline must not have. Reading the ink per line copes with every chassis colour
// (idle, working, faulted, backed up) without a palette table.
//
// WHAT IT REFUSES TO GUESS. A line is skipped, and counted, when anything other than one stroke on
// one floor is on it: the line runs off the capture or crosses a mask, the floor differs at its two
// ends, no stroke stands out from the floor, the line's ends are lighter than its stroke (every
// chassis ink is lighter than the board floor, so ink at both ends would otherwise read the dark
// gap between them as the stroke), a pixel of another colour touches the stroke, or other ink sits
// on the line beside it. A shape that touches the stroke and reaches past the end of the line
// shows up as ink at that end, so the floor check refuses it. A side left with no line
// reports `measured: false` with the reasons, and the grade counts that side as an offender. It
// never reads as a width, so a missing outline can't compare equal to anything.

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Coverage at or above this is core: the pixel reads as the stroke itself. */
export const CORE_MIN = 0.75;
/** Coverage at or above this (and below `CORE_MIN`) is fringe: a grey edge pixel. */
export const FRINGE_MIN = 0.1;
/** With antialiasing on, a machine's four effective widths may differ by at most this, in device px. */
export const AA_ON_TOLERANCE = 0.25;
/** The ink must stand this far from the floor (RGB distance) for the line to hold a stroke. */
export const MIN_CONTRAST = 48;
/**
 * The floor at the two ends of a line may differ by at most this (RGB distance). The board's grid
 * lines can sit at a line's end: the major line (0x3b4250) is 63 from the floor (0x1b1f27) and the
 * minor line (0x2a2f3a) 29, while every ink colour is more than 150 away.
 */
export const FLOOR_AGREE = 80;
/** A stroke pixel may sit at most this far off the floor-to-ink blend (RGB distance). */
export const OFF_BLEND_MAX = 36;
/** Sample lines taken per side, at most. A short side takes the lines it has room for. */
export const LINES_PER_SIDE = 9;

// ---------------------------------------------------------------------------
// Colour and coverage
// ---------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

function sub(a: Rgb, b: Rgb): Rgb {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Rgb, b: Rgb): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Rec. 601 luma, enough to say which of two colours is lighter. */
function lightness(c: Rgb): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

function dist(a: Rgb, b: Rgb): number {
  return Math.sqrt(dot(sub(a, b), sub(a, b)));
}

/** How far `pixel` sits from `floor` towards `ink`, clamped to [0, 1]. 0 when the two are the same colour. */
export function coverageOf(pixel: Rgb, floor: Rgb, ink: Rgb): number {
  const d = sub(ink, floor);
  const len2 = dot(d, d);
  if (len2 === 0) return 0;
  return Math.min(1, Math.max(0, dot(sub(pixel, floor), d) / len2));
}

/** The RGB colour of image pixel (x, y). The caller keeps (x, y) inside the image. */
export function pixelAt(image: DecodedImage, x: number, y: number): Rgb {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

// ---------------------------------------------------------------------------
// One sample line
// ---------------------------------------------------------------------------

export type LineReading =
  | { ok: true; core: number; fringe: number; effective: number }
  | { ok: false; reason: string };

/**
 * Read one stroke off one sample line. `pixels` run across the stroke from outside the machine to
 * inside it, with floor at both ends. See the file header for what makes a line unreadable.
 */
export function readSampleLine(pixels: readonly Rgb[]): LineReading {
  const n = pixels.length;
  if (n < 3) return { ok: false, reason: 'the line is shorter than 3 px' };
  const floorOut = pixels[0];
  const floorIn = pixels[n - 1];
  if (dist(floorOut, floorIn) > FLOOR_AGREE) return { ok: false, reason: 'the floor differs at the two ends of the line' };
  let peak = 1;
  for (let k = 2; k < n - 1; k++) if (dist(pixels[k], floorOut) > dist(pixels[peak], floorOut)) peak = k;
  const ink = pixels[peak];
  if (dist(ink, floorOut) < MIN_CONTRAST) return { ok: false, reason: 'no stroke stands out from the floor' };
  if (lightness(ink) <= lightness(floorOut)) return { ok: false, reason: "the line's ends are lighter than its stroke" };
  const floorFor = (k: number): Rgb => (k <= peak ? floorOut : floorIn);
  const cov = pixels.map((p, k) => coverageOf(p, floorFor(k), ink));
  let start = peak;
  while (start - 1 >= 0 && cov[start - 1] >= FRINGE_MIN) start--;
  let end = peak;
  while (end + 1 <= n - 1 && cov[end + 1] >= FRINGE_MIN) end++;
  for (let k = start; k <= end; k++) {
    const f = floorFor(k);
    const blend: Rgb = [
      f[0] + (ink[0] - f[0]) * cov[k],
      f[1] + (ink[1] - f[1]) * cov[k],
      f[2] + (ink[2] - f[2]) * cov[k],
    ];
    if (dist(pixels[k], blend) > OFF_BLEND_MAX) return { ok: false, reason: 'a pixel of another colour touches the stroke' };
  }
  for (let k = 0; k < n; k++) {
    if ((k < start || k > end) && cov[k] >= FRINGE_MIN) return { ok: false, reason: 'other ink sits on the line beside the stroke' };
  }
  let core = 0;
  let fringe = 0;
  let effective = 0;
  for (let k = start; k <= end; k++) {
    if (cov[k] >= CORE_MIN) core++;
    else fringe++;
    effective += cov[k];
  }
  return { ok: true, core, fringe, effective };
}

// ---------------------------------------------------------------------------
// Where the outline sits, in device pixels
// ---------------------------------------------------------------------------

/** World px to device px: `(world x scale + pan + canvas client origin) x dpr`, per axis. */
export function worldToDevice(facts: CaptureFacts, wx: number, wy: number): { x: number; y: number } {
  return {
    x: (wx * facts.camera.scale + facts.camera.x + facts.clientRect.left) * facts.dpr,
    y: (wy * facts.camera.scale + facts.camera.y + facts.clientRect.top) * facts.dpr,
  };
}

export type SideName = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: readonly SideName[] = ['top', 'right', 'bottom', 'left'];

/** One side of a chassis band, in device px. */
export interface SideBand {
  side: SideName;
  /** The axis a sample line runs along: `x` for the left and right sides, `y` for the top and bottom. */
  across: 'x' | 'y';
  /** The band's outer and inner edges on the `across` axis, in device px. */
  outer: number;
  inner: number;
  /** Device pixel rows (left, right) or columns (top, bottom) a sample line may take, in order. */
  lines: number[];
  /** Why the side has no line, when `lines` is empty. */
  noLines?: string;
}

export interface OutlineBand {
  nodeId: number;
  kind: number;
  sides: SideBand[];
}

/** The chassis band's outer and inner edges, in world px inside each footprint edge (2.5 and 5.5 at the shipped skin). */
export function chassisBandInsetsPx(): { outer: number; inner: number } {
  const half = LOCKED_SKIN.strokeStructural / 2;
  return { outer: (CHASSIS_INSET_U - half) * U_TO_PX, inner: (CHASSIS_INSET_U + half) * U_TO_PX };
}

/**
 * How far a port nub reaches ALONG the side it sits on, either way from its anchor, in world px:
 * the widest of the plain disc, the fault ring with its stroke, and the electrical terminal.
 */
export const NUB_ALONG_REACH_PX = Math.max(NUB_R, NUB_FAULT_RING_R + NUB_STROKE / 2, NUB_ELECTRICAL_HALF);

/** The side index the scene's ports use: N=0, E=1, S=2, W=3. */
const SIDE_INDEX: Record<SideName, number> = { top: 0, right: 1, bottom: 2, left: 3 };

/**
 * The outline band of one machine, from its footprint cells and the chassis inset. Sample lines
 * stay one device pixel clear of the two perpendicular sides' strokes (the corners) and of each
 * port nub's reach along that side.
 */
export function outlineBandFor(facts: CaptureFacts, node: CaptureNode): OutlineBand {
  const xs = node.cells.map(([x]) => x);
  const ys = node.cells.map(([, y]) => y);
  const minX = Math.min(...xs) * CELL;
  const maxX = (Math.max(...xs) + 1) * CELL;
  const minY = Math.min(...ys) * CELL;
  const maxY = (Math.max(...ys) + 1) * CELL;
  const inset = chassisBandInsetsPx();
  const dev = (wx: number, wy: number) => worldToDevice(facts, wx, wy);
  const sides: SideBand[] = [];
  for (const side of SIDES) {
    const across: 'x' | 'y' = side === 'left' || side === 'right' ? 'x' : 'y';
    // The edge's world coordinate on the across axis, and which way is inward.
    const edge = side === 'left' ? minX : side === 'right' ? maxX : side === 'top' ? minY : maxY;
    const inward = side === 'left' || side === 'top' ? 1 : -1;
    const pick = (p: { x: number; y: number }) => (across === 'x' ? p.x : p.y);
    const at = (w: number) => (across === 'x' ? dev(w, 0) : dev(0, w));
    const outer = pick(at(edge + inward * inset.outer));
    const inner = pick(at(edge + inward * inset.inner));
    // The along axis: from one perpendicular stroke's inner edge to the other's.
    const lo = across === 'x' ? minY : minX;
    const hi = across === 'x' ? maxY : maxX;
    const alongDev = (w: number) => (across === 'x' ? dev(0, w).y : dev(w, 0).x);
    const firstPx = Math.ceil(alongDev(lo + inset.inner)) + 1;
    const lastPx = Math.floor(alongDev(hi - inset.inner)) - 2;
    // Port nubs on this side: keep each pixel row or column one device px clear of their reach.
    const blocked = node.ports
      .filter((p) => p.side === SIDE_INDEX[side])
      .map((p) => {
        const a = nubAnchor(p.cell_x, p.cell_y, p.side);
        const centre = across === 'x' ? a.y : a.x;
        return [alongDev(centre - NUB_ALONG_REACH_PX) - 1, alongDev(centre + NUB_ALONG_REACH_PX) + 1] as const;
      });
    const candidates: number[] = [];
    for (let px = firstPx; px <= lastPx; px++) {
      if (!blocked.some(([b0, b1]) => px + 1 > b0 && px < b1)) candidates.push(px);
    }
    const lines = spread(candidates, LINES_PER_SIDE);
    sides.push({
      side,
      across,
      outer,
      inner,
      lines,
      ...(lines.length === 0 ? { noLines: 'the side has no room for a sample line clear of its corners and port nubs' } : {}),
    });
  }
  return { nodeId: node.id, kind: node.kind, sides };
}

/** Up to `count` entries of `xs`, evenly spread and including both ends. */
function spread(xs: readonly number[], count: number): number[] {
  if (xs.length <= count) return [...xs];
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (count - 1))]);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

/** A rectangle in device px, `[x0, x1)` by `[y0, y1)`: no sample line may cross it. */
export interface MaskRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** What the mask covers, for the skip reason. */
  what: string;
}

/** A CSS-px client rectangle as a device-px mask. */
export function cssRectMask(facts: CaptureFacts, r: CaptureRect, what: string): MaskRect {
  return { x0: r.left * facts.dpr, y0: r.top * facts.dpr, x1: (r.left + r.width) * facts.dpr, y1: (r.top + r.height) * facts.dpr, what };
}

/** How far past a drawn shape a mask reaches, in device px, so its edge pixels are covered too. */
export const MASK_CLEARANCE_PX = 1;

/**
 * The radius an alert ring is masked to, in world px. The overlay draws the ring at radius 8 with
 * a 2 px stroke and doesn't export either number, so the mask takes half a cell, which holds the
 * ring with room to spare.
 */
export const ALERT_RING_MASK_R = CELL / 2;

/** A world-px box as a device-px mask, `clearance` device px wider on every side. */
function worldBoxMask(facts: CaptureFacts, x0: number, y0: number, x1: number, y1: number, what: string, clearance: number): MaskRect {
  const a = worldToDevice(facts, x0, y0);
  const b = worldToDevice(facts, x1, y1);
  return { x0: Math.min(a.x, b.x) - clearance, y0: Math.min(a.y, b.y) - clearance, x1: Math.max(a.x, b.x) + clearance, y1: Math.max(a.y, b.y) + clearance, what };
}

/**
 * Every mask a capture carries, in device px: the chrome panels and the label words over the
 * board; each label node's footprint (a label has a box, not a chassis); each cable segment, as
 * wide as its stroke; each item dot's box; and each alert ring. A sample line that crosses any of
 * them is skipped.
 */
export function captureMasks(facts: CaptureFacts): MaskRect[] {
  const out: MaskRect[] = [];
  for (const p of facts.panels) out.push(cssRectMask(facts, p, 'a chrome panel'));
  for (const w of facts.labelWords) out.push(cssRectMask(facts, w, 'label words'));
  for (const n of facts.nodes) {
    if (!n.isLabel || n.cells.length === 0) continue;
    const xs = n.cells.map(([x]) => x);
    const ys = n.cells.map(([, y]) => y);
    out.push(worldBoxMask(facts, Math.min(...xs) * CELL, Math.min(...ys) * CELL, (Math.max(...xs) + 1) * CELL, (Math.max(...ys) + 1) * CELL, 'a label', 0));
  }
  // A cable is drawn `CABLE_WIDTH` world px wide, and never thinner than one screen px.
  const halfCable = Math.max(CABLE_WIDTH / 2, 0.5 / facts.camera.scale);
  for (const line of facts.cables) {
    for (let i = 0; i + 1 < line.length; i++) {
      const p = line[i];
      const q = line[i + 1];
      out.push(
        worldBoxMask(facts, Math.min(p.x, q.x) - halfCable, Math.min(p.y, q.y) - halfCable, Math.max(p.x, q.x) + halfCable, Math.max(p.y, q.y) + halfCable, 'a cable', MASK_CLEARANCE_PX),
      );
    }
  }
  for (const d of facts.itemDots) {
    out.push(worldBoxMask(facts, d.x - DOT_SIZE / 2, d.y - DOT_SIZE / 2, d.x + DOT_SIZE / 2, d.y + DOT_SIZE / 2, 'an item dot', MASK_CLEARANCE_PX));
  }
  for (const r of facts.alertRings) {
    out.push(worldBoxMask(facts, r.x - ALERT_RING_MASK_R, r.y - ALERT_RING_MASK_R, r.x + ALERT_RING_MASK_R, r.y + ALERT_RING_MASK_R, 'an alert ring', MASK_CLEARANCE_PX));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Measuring a machine's outline
// ---------------------------------------------------------------------------

export type SideResult =
  | { measured: true; core: number; fringe: number; effective: number; lines: number; skipped: number }
  | { measured: false; reason: string };

export interface MachineOutline {
  nodeId: number;
  kind: number;
  sides: Record<SideName, SideResult>;
}

/** The margin past each band edge a sample line reads, in device px: room for a fringe pixel and the floor beyond it. */
export function sampleMargin(facts: CaptureFacts): number {
  return Math.max(2, Math.round(2 * facts.camera.scale * facts.dpr));
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Measure every side of one outline band: read each sample line across the band (outside to
 * inside, `margin` device px past each edge) and take the median core, fringe and effective
 * width of the lines that read.
 */
export function measureOutlineSides(
  image: DecodedImage,
  band: OutlineBand,
  masks: readonly MaskRect[],
  margin = 2,
): Record<SideName, SideResult> {
  const out = {} as Record<SideName, SideResult>;
  for (const sb of band.sides) {
    if (sb.lines.length === 0) {
      out[sb.side] = { measured: false, reason: sb.noLines ?? 'no sample line' };
      continue;
    }
    // Pixels whose centres lie inside the band, then `margin` more on each side.
    const lo = Math.min(sb.outer, sb.inner);
    const hi = Math.max(sb.outer, sb.inner);
    const first = Math.ceil(lo - 0.5) - margin;
    const last = Math.floor(hi - 0.5) + margin;
    const outsideFirst = sb.outer < sb.inner;
    const readings: { core: number; fringe: number; effective: number }[] = [];
    const skips = new Map<string, number>();
    const skip = (why: string) => skips.set(why, (skips.get(why) ?? 0) + 1);
    for (const line of sb.lines) {
      const xy = (k: number) => (sb.across === 'x' ? { x: k, y: line } : { x: line, y: k });
      const a = xy(first);
      const b = xy(last);
      if (Math.min(a.x, a.y) < 0 || b.x >= image.width || b.y >= image.height) {
        skip('the line runs off the capture');
        continue;
      }
      const hit = masks.find((m) => Math.max(a.x, b.x) + 1 > m.x0 && Math.min(a.x, b.x) < m.x1 && Math.max(a.y, b.y) + 1 > m.y0 && Math.min(a.y, b.y) < m.y1);
      if (hit !== undefined) {
        skip(`the line crosses ${hit.what}`);
        continue;
      }
      const pixels: Rgb[] = [];
      for (let k = first; k <= last; k++) {
        const p = xy(k);
        pixels.push(pixelAt(image, p.x, p.y));
      }
      if (!outsideFirst) pixels.reverse();
      const r = readSampleLine(pixels);
      if (r.ok) readings.push(r);
      else skip(r.reason);
    }
    const skipped = sb.lines.length - readings.length;
    if (readings.length === 0) {
      const why = [...skips].map(([w, c]) => `${c} x ${w}`).join('; ');
      out[sb.side] = { measured: false, reason: `all ${sb.lines.length} sample lines skipped: ${why}` };
      continue;
    }
    out[sb.side] = {
      measured: true,
      core: median(readings.map((r) => r.core)),
      fringe: median(readings.map((r) => r.fringe)),
      effective: median(readings.map((r) => r.effective)),
      lines: readings.length,
      skipped,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tiles: where each machine is graded
// ---------------------------------------------------------------------------

/** A machine in the scene, as a tile's manifest entry lists it. */
export interface SceneMachine {
  nodeId: number;
  kind: number;
}

/** Every machine in the scene in node-id order. Label nodes have no chassis and are left out. */
export function sceneMachines(facts: CaptureFacts): SceneMachine[] {
  return facts.nodes
    .filter((n) => !n.isLabel && n.cells.length > 0)
    .sort((a, b) => a.id - b.id)
    .map((n) => ({ nodeId: n.id, kind: n.kind }));
}

/**
 * True when the whole outline of `node` can be read in this capture: its chassis band, widened by
 * the sample margin every line reads past it, lies on the canvas, inside the image, and outside
 * every chrome panel. A machine half off the canvas or partly under the toolbar is graded in a
 * later tile where it is whole, or not at all.
 */
export function outlineClearOfChrome(facts: CaptureFacts, node: CaptureNode, imageSize: { width: number; height: number }): boolean {
  const band = outlineBandFor(facts, node);
  const margin = sampleMargin(facts);
  const bound = (side: SideName) => band.sides.find((s) => s.side === side)?.outer ?? Number.NaN;
  const box = { x0: bound('left') - margin, y0: bound('top') - margin, x1: bound('right') + margin, y1: bound('bottom') + margin };
  if (![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) return false;
  const canvas = cssRectMask(facts, facts.clientRect, 'the canvas');
  const x0 = Math.max(0, canvas.x0);
  const y0 = Math.max(0, canvas.y0);
  const x1 = Math.min(imageSize.width, canvas.x1);
  const y1 = Math.min(imageSize.height, canvas.y1);
  if (box.x0 < x0 || box.y0 < y0 || box.x1 > x1 || box.y1 > y1) return false;
  return facts.panels.every((p) => {
    const m = cssRectMask(facts, p, 'a chrome panel');
    return box.x1 <= m.x0 || box.x0 >= m.x1 || box.y1 <= m.y0 || box.y0 >= m.y1;
  });
}

/** One tile as the grade reads it: the scene it saw and the outlines it measured. */
export interface TileOutlines {
  scene: readonly SceneMachine[];
  outlines: readonly MachineOutline[];
}

/**
 * Pick, for each machine in the scene, the outline from the FIRST tile that measured it (a tile
 * measures only the machines whose whole outline was clear there). A scene machine no tile
 * measured is returned in `neverClear`. Both lists are in node-id order. The scene is the union of
 * every tile's, so a machine one tile left out of its scene list still has to be graded.
 */
export function outlinesForCell(tiles: readonly TileOutlines[]): { outlines: MachineOutline[]; neverClear: SceneMachine[] } {
  const scene = new Map<number, SceneMachine>();
  for (const t of tiles) for (const m of t.scene) if (!scene.has(m.nodeId)) scene.set(m.nodeId, m);
  const outlines: MachineOutline[] = [];
  const neverClear: SceneMachine[] = [];
  for (const id of [...scene.keys()].sort((a, b) => a - b)) {
    let found: MachineOutline | undefined;
    for (const t of tiles) {
      found = t.outlines.find((o) => o.nodeId === id);
      if (found !== undefined) break;
    }
    if (found !== undefined) outlines.push(found);
    else neverClear.push(scene.get(id) as SceneMachine);
  }
  return { outlines, neverClear };
}

/**
 * The outlines of the machines whose whole outline is clear in this capture, in node-id order.
 * Machines that aren't clear are left out here and graded in another tile (`outlinesForCell`).
 */
export function measureTile(image: DecodedImage, facts: CaptureFacts): MachineOutline[] {
  const clear = new Set(
    facts.nodes.filter((n) => !n.isLabel && n.cells.length > 0 && outlineClearOfChrome(facts, n, image)).map((n) => n.id),
  );
  return measureCapture(image, facts).filter((m) => clear.has(m.nodeId));
}

/** Every machine's outline in one capture, in node-id order. Label nodes have no chassis and are left out. */
export function measureCapture(image: DecodedImage, facts: CaptureFacts): MachineOutline[] {
  const masks = captureMasks(facts);
  const margin = sampleMargin(facts);
  return facts.nodes
    .filter((n) => !n.isLabel && n.cells.length > 0)
    .sort((a, b) => a.id - b.id)
    .map((n) => {
      const band = outlineBandFor(facts, n);
      return { nodeId: n.id, kind: n.kind, sides: measureOutlineSides(image, band, masks, margin) };
    });
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * One thing that broke the rule in a cell. `key` is stable across runs at one revision, so a
 * declared row can list exactly the offenders it explains: `<node id>:<side>` for a side,
 * `<node id>:never-clear` for a machine no tile held whole, `capture:no-machine` for a capture with
 * no machine in it. `unmeasured` is true when nothing was read (a side not measured, a machine never
 * clear of chrome, no machine at all) and false for a measured side that broke the rule.
 */
export interface Offender {
  key: string;
  unmeasured: boolean;
  text: string;
}

export interface Grade {
  offenders: Offender[];
  explain: string;
}

/**
 * The sides of one machine whose value differs from the rest: the most common value is the
 * reference (on a two-two split, the larger one), and every side that reads otherwise differs.
 */
function oddSides(values: readonly { side: SideName; v: number }[]): { side: SideName; v: number }[] {
  const counts = new Map<number, number>();
  for (const { v } of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [ref] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  return values.filter(({ v }) => v !== ref);
}

/**
 * Grade the outline-sides property for one cell. With antialiasing as shipped, the four median
 * cores of each machine must be equal; a side whose core differs from the others' is an offender.
 * With it on, the four effective widths must sit within `AA_ON_TOLERANCE` of each other (a side
 * more than half the tolerance from the median of the four is an offender), and at zoom 1 and at
 * the two boot zooms (the 1600x1000 fit and the full-screen fit) the fringe must also be 0 (STRK-01:
 * a crisp outline at the zooms people work at; each side with a fringe is an offender). A side that
 * wasn't measured is an offender, so is a scene machine no tile held whole (`neverClear`), and so
 * is a capture with no machine in it. Offenders come in node-id order, sides top, right, bottom,
 * left, one per key.
 */
export function gradeOutlineSides(results: readonly MachineOutline[], cell: CaptureCell, neverClear: readonly SceneMachine[] = []): Grade {
  const byKey = new Map<string, Offender>();
  const add = (key: string, unmeasured: boolean, text: string) => {
    const had = byKey.get(key);
    if (had === undefined) byKey.set(key, { key, unmeasured, text });
    else byKey.set(key, { key, unmeasured: had.unmeasured || unmeasured, text: `${had.text}; ${text}` });
  };
  if (results.length === 0 && neverClear.length === 0) add('capture:no-machine', true, 'no machine was measured in this capture');
  const machines = [
    ...neverClear.map((m) => ({ nodeId: m.nodeId, never: m, outline: undefined as MachineOutline | undefined })),
    ...results.map((m) => ({ nodeId: m.nodeId, never: undefined as SceneMachine | undefined, outline: m })),
  ].sort((a, b) => a.nodeId - b.nodeId);
  for (const entry of machines) {
    if (entry.never !== undefined) {
      const m = entry.never;
      add(`${m.nodeId}:never-clear`, true, `machine ${m.nodeId} (kind ${m.kind}): never clear of chrome (no tile held its whole outline on the canvas)`);
      continue;
    }
    const m = entry.outline as MachineOutline;
    const who = `machine ${m.nodeId} (kind ${m.kind})`;
    const measured: { side: SideName; core: number; fringe: number; effective: number }[] = [];
    for (const side of SIDES) {
      const s = m.sides[side];
      if (!s.measured) add(`${m.nodeId}:${side}`, true, `${who} ${side}: not measured (${s.reason})`);
      else measured.push({ side, core: s.core, fringe: s.fringe, effective: s.effective });
    }
    if (measured.length < SIDES.length) continue;
    const list = (f: (s: (typeof measured)[number]) => number) => measured.map((s) => `${s.side} ${round3(f(s))}`).join(', ');
    if (cell.aa === 'shipped') {
      for (const { side, v } of oddSides(measured.map((s) => ({ side: s.side, v: s.core })))) {
        add(`${m.nodeId}:${side}`, false, `${who} ${side}: core ${v} against the other sides (${list((s) => s.core)})`);
      }
    } else {
      const eff = measured.map((s) => s.effective);
      const spread = Math.max(...eff) - Math.min(...eff);
      if (spread > AA_ON_TOLERANCE + 1e-9) {
        const mid = median(eff);
        for (const s of measured) {
          if (Math.abs(s.effective - mid) > AA_ON_TOLERANCE / 2) {
            add(`${m.nodeId}:${s.side}`, false, `${who} ${s.side}: effective widths spread ${round3(spread)} px, over ${AA_ON_TOLERANCE} (${list((x) => x.effective)})`);
          }
        }
      }
      if (cell.zoom === 1 || isBootZoom(cell.zoom)) {
        for (const s of measured) {
          if (s.fringe !== 0) add(`${m.nodeId}:${s.side}`, false, `${who} ${s.side}: grey fringe at zoom ${zoomId(cell.zoom)} (fringe ${list((x) => x.fringe)}; core ${list((x) => x.core)})`);
        }
      }
    }
  }
  // Insertion order is node-id order already; within a machine put the sides back in SIDES order.
  const rank = (o: Offender) => {
    const [id, part] = o.key.split(':');
    return [id === 'capture' ? -1 : Number(id), (SIDES as readonly string[]).indexOf(part)];
  };
  const offenders = [...byKey.values()].sort((a, b) => {
    const [ia, sa] = rank(a);
    const [ib, sb] = rank(b);
    return ia - ib || sa - sb;
  });
  const head = `outline sides at dpr=${cell.dpr} aa=${cell.aa} zoom=${zoomId(cell.zoom)}: ${results.length + neverClear.length} machines, ${offenders.length} offenders`;
  return { offenders, explain: offenders.length === 0 ? head : `${head}\n  ${offenders.map((o) => o.text).join('\n  ')}` };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
