import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BELT_GEOM, CELL, INSET, NUB_PUSH, nubAnchor } from '../../shared/geometry';
import { CHASSIS_INSET_U, U_TO_PX } from '../../src/render/layers/machineChassis';
import {
  NUB_ELECTRICAL_HALF,
  NUB_FAULT_CORE_R,
  NUB_FAULT_RING_R,
  NUB_R,
  NUB_RING_R,
  NUB_RING_STROKE,
  NUB_STROKE,
  PORT_ROLE,
  beltEndCell,
  beltSeamPoint,
  dockPort,
} from '../../src/protocol/ports';
import type { BeltView, NodeView } from '../../src/protocol/decode';
import { CABLE_WIDTH } from '../../src/render/cableGeometry';
import { DOT_SIZE, itemDotGrow, snapToDevicePixel } from '../../src/render/layers/items';
import { railBandAt, straightTickCommands } from '../../src/render/synth/beltGeometry';
import { LOCKED_SKIN } from '../../src/render/synth/skins/locked';
import type { DecodedImage } from './canvasDots';
import type { CaptureBelt, CaptureFacts, CaptureNode, CapturePort, CaptureRect } from './captureFacts';
import { isBootZoom, machinesDrawnAsVectors, shippedConst, treadDrawnAsDash, zoomId, type CaptureCell, type PropertyId } from './captureMatrix';

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

/** One straight stroke to read across, in device px: an outline side or a glyph leg. */
export interface StrokeBand {
  /** The axis a sample line runs along: `x` for a vertical stroke, `y` for a horizontal one. */
  across: 'x' | 'y';
  /** The band's outer and inner edges on the `across` axis, in device px. */
  outer: number;
  inner: number;
  /** Device pixel rows (vertical stroke) or columns (horizontal stroke) a sample line may take, in order. */
  lines: number[];
  /** Why the stroke has no line, when `lines` is empty. */
  noLines?: string;
}

/** One side of a chassis band, in device px. */
export interface SideBand extends StrokeBand {
  side: SideName;
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
  // Below zoom 1 the item layer grows each dot in world px so it keeps its on-screen size.
  const dot = (DOT_SIZE * itemDotGrow(facts.camera.scale)) / 2;
  for (const d of facts.itemDots) {
    out.push(worldBoxMask(facts, d.x - dot, d.y - dot, d.x + dot, d.y + dot, 'an item dot', MASK_CLEARANCE_PX));
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
  for (const sb of band.sides) out[sb.side] = measureBand(image, sb, masks, margin);
  return out;
}

/**
 * Read one straight stroke: each sample line runs across the band from its outer edge to its inner
 * edge, `margin` device px past each, and the stroke reports the median core, fringe and effective
 * width of the lines that read. A stroke with no readable line is `measured: false` with the reasons.
 */
export function measureBand(image: DecodedImage, sb: StrokeBand, masks: readonly MaskRect[], margin = 2): SideResult {
  if (sb.lines.length === 0) return { measured: false, reason: sb.noLines ?? 'no sample line' };
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
    const hit = maskHit(masks, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
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
  if (readings.length === 0) return { measured: false, reason: `all ${sb.lines.length} sample lines skipped: ${skipText(skips)}` };
  return {
    measured: true,
    core: median(readings.map((r) => r.core)),
    fringe: median(readings.map((r) => r.fringe)),
    effective: median(readings.map((r) => r.effective)),
    lines: readings.length,
    skipped,
  };
}

/** The first mask that the pixel box `[x0, x1] x [y0, y1]` (inclusive pixel indices) touches. */
function maskHit(masks: readonly MaskRect[], x0: number, y0: number, x1: number, y1: number): MaskRect | undefined {
  return masks.find((m) => x1 + 1 > m.x0 && x0 < m.x1 && y1 + 1 > m.y0 && y0 < m.y1);
}

/** `3 x reason; 1 x other reason`, for a skip count map. */
function skipText(skips: ReadonlyMap<string, number>): string {
  return [...skips].map(([w, c]) => `${c} x ${w}`).join('; ');
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

// ===========================================================================
// Glyph legs, fault rings, belt dash, rail against outline, cap against cell (plan 107-07)
// ===========================================================================

/** One H or V segment of a glyph path, in the art's author units. `leg` counts every segment in file order. */
export interface GlyphSegment {
  leg: number;
  part: string;
  orient: 'H' | 'V';
  /** The fixed coordinate: y for an H segment, x for a V segment. */
  at: number;
  /** The segment's ends on the other axis, in drawing order. */
  from: number;
  to: number;
  strokeWidth: number;
}

export interface GlyphArt {
  viewBox: { x: number; y: number; w: number; h: number };
  segments: GlyphSegment[];
}

/** One leg of one Factory glyph as measured: which leg, where in the art, and its width. */
export interface GlyphLegRow {
  nodeId: number;
  leg: string;
  segment: string;
  width: SideResult;
}

export type RingResult =
  | { measured: true; rays: number; skipped: number; gaps: number; holeClosed: number; minCore: number; minEffective: number }
  | { measured: false; reason: string };

/** One bare fault port ring as measured, keyed by its machine and port index. */
export interface FaultRingRow {
  nodeId: number;
  port: number;
  ring: RingResult;
}

export type DashResult =
  | { measured: true; gaps: number; longestGapPx: number; readPx: number; core: number; effective: number }
  | { measured: false; reason: string };

/** One straight belt tile's dash (or low-zoom tick) as measured. */
export interface BeltDashRow {
  beltId: number;
  tile: number;
  cell: string;
  mode: 'dash' | 'tick';
  stroke: DashResult;
}

export type OutlineWidth = { measured: true; core: number; effective: number; sides: number } | { measured: false; reason: string };

/** One belt's rail width beside the median machine outline width in the same capture. */
export interface RailRow {
  beltId: number;
  rail: SideResult;
  outline: OutlineWidth;
  ratio: string;
}

export type CapResult = { measured: true; widthPx: number; offsetPx: number } | { measured: false; reason: string };

/** One belt end mark (a plug cap on a machine port, or a junction collar) against one cell. */
export interface CapRow {
  beltId: number;
  n: number;
  end: 'Head' | 'Tail';
  mark: 'cap' | 'collar';
  cellPx: number;
  cap: CapResult;
}

/** Every property's rows for one tile. */
export interface TileMeasurements {
  'outline-sides': MachineOutline[];
  'glyph-strokes': GlyphLegRow[];
  'fault-ring': FaultRingRow[];
  'belt-dash': BeltDashRow[];
  'rail-vs-outline': RailRow[];
  'cap-in-cell': CapRow[];
}

/** One tile as the grade reads it: its scene, each property's subjects, and what it measured. */
export interface TileRecord {
  scene: SceneMachine[];
  subjects: Record<PropertyId, string[]>;
  measurements: TileMeasurements;
}


// ---------------------------------------------------------------------------
// Shared helpers for the five properties below
// ---------------------------------------------------------------------------

/** Device px per world px: the camera scale times the pixel ratio. */
function deviceScale(facts: CaptureFacts): number {
  return facts.camera.scale * facts.dpr;
}

/** An offender list with one entry per key (texts merged), in the order keys were first added. */
function offenderList(): { add: (key: string, unmeasured: boolean, text: string) => void; list: () => Offender[] } {
  const byKey = new Map<string, Offender>();
  return {
    add: (key, unmeasured, text) => {
      const had = byKey.get(key);
      byKey.set(key, had === undefined ? { key, unmeasured, text } : { key, unmeasured: had.unmeasured || unmeasured, text: `${had.text}; ${text}` });
    },
    list: () => [...byKey.values()],
  };
}

function gradeOf(head: string, offenders: Offender[], notes: readonly string[] = []): Grade {
  const lines = [...offenders.map((o) => o.text), ...notes];
  return { offenders, explain: lines.length === 0 ? head : `${head}\n  ${lines.join('\n  ')}` };
}

function cellLabel(cell: CaptureCell): string {
  return `dpr=${cell.dpr} aa=${cell.aa} zoom=${zoomId(cell.zoom)}`;
}

/**
 * The values that differ from the rest: the most common value is the reference (on a tie, the
 * larger one), and every value that reads otherwise is odd.
 */
function oddOnes<T extends { v: number }>(values: readonly T[]): { odd: T[]; ref: number } {
  const counts = new Map<number, number>();
  for (const { v } of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [ref] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  return { odd: values.filter(({ v }) => v !== ref), ref };
}

/** A device-px box, `[x0, x1)` by `[y0, y1)`. */
interface DeviceBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** True when the device-px box lies on the canvas, inside the image and off every chrome panel. */
export function deviceBoxClear(facts: CaptureFacts, imageSize: { width: number; height: number }, box: DeviceBox): boolean {
  const canvas = cssRectMask(facts, facts.clientRect, 'the canvas');
  if (box.x0 < Math.max(0, canvas.x0) || box.y0 < Math.max(0, canvas.y0)) return false;
  if (box.x1 > Math.min(imageSize.width, canvas.x1) || box.y1 > Math.min(imageSize.height, canvas.y1)) return false;
  return facts.panels.every((p) => {
    const m = cssRectMask(facts, p, 'a chrome panel');
    return box.x1 <= m.x0 || box.x0 >= m.x1 || box.y1 <= m.y0 || box.y0 >= m.y1;
  });
}

/** The world-px box of one grid cell, in device px. */
function cellBox(facts: CaptureFacts, cx: number, cy: number): DeviceBox {
  const a = worldToDevice(facts, cx * CELL, cy * CELL);
  const b = worldToDevice(facts, (cx + 1) * CELL, (cy + 1) * CELL);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

// ---------------------------------------------------------------------------
// The Factory glyph's legs (glyph-strokes, STRK-01)
// ---------------------------------------------------------------------------
//
// The legs are the H and V segments of `src/render/assets/factory.svg`, read from the file when a
// capture is measured, so a change to the art moves the sample lines with it. Each segment maps
// through the glyph box the machine layer reports (`glyphBoxOn`: the glyph Graphics' position and
// drawn size in the body's unrotated frame) to world px, then through the camera to device px,
// and is read across with the same coverage reader as an outline side. The body frame equals the
// footprint's own frame only when the body is unrotated; a glyph whose drawn footprint isn't the
// scene's footprint is refused as not measured rather than mapped through a guess.

/** Sample lines taken per glyph leg, at most. */
export const LINES_PER_LEG = 5;

const FACTORY_SVG = new URL('../../src/render/assets/factory.svg', import.meta.url);
let factoryArt: GlyphArt | undefined;

/** The Factory glyph's art, parsed from the shipped asset file on first use. */
export function factoryGlyph(): GlyphArt {
  factoryArt ??= parseGlyphArt(readFileSync(fileURLToPath(FACTORY_SVG), 'utf8'));
  return factoryArt;
}

/**
 * The viewBox and the H and V segments of every `<path>` in an SVG whose paths use only absolute
 * M, H, V, axis-aligned L and Z commands (the shipped assets' authoring contract). Anything else
 * throws by name, so a glyph drawn with a curve can't be measured as if it were straight.
 */
export function parseGlyphArt(svg: string): GlyphArt {
  const body = svg.replace(/<!--[\s\S]*?-->/g, '');
  const vb = /viewBox="([^"]+)"/.exec(body);
  if (vb === null) throw new Error('parseGlyphArt: no viewBox');
  const [x, y, w, h] = vb[1].trim().split(/[\s,]+/).map(Number);
  const segments: GlyphSegment[] = [];
  let pathNo = 0;
  for (const m of body.matchAll(/<path\b([^>]*?)\/?>/g)) {
    const attrs = m[1];
    const attr = (name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
    const d = attr('d');
    if (d === undefined) throw new Error('parseGlyphArt: a <path> has no d');
    const part = attr('data-part') ?? `path-${pathNo}`;
    pathNo++;
    const strokeWidth = Number(attr('stroke-width') ?? '1');
    const tokens = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
    const isCmd = (t: string | undefined) => t !== undefined && /^[A-Za-z]$/.test(t);
    let i = 0;
    const num = (): number => {
      const t = tokens[i++];
      if (t === undefined || isCmd(t)) throw new Error(`parseGlyphArt: ${part}: a command is missing a number`);
      return Number(t);
    };
    const push = (orient: 'H' | 'V', at: number, from: number, to: number) => {
      if (from !== to) segments.push({ leg: segments.length, part, orient, at, from, to, strokeWidth });
    };
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    let cmd = '';
    while (i < tokens.length) {
      if (isCmd(tokens[i])) cmd = tokens[i++];
      else if (cmd === '' || cmd === 'Z') throw new Error(`parseGlyphArt: ${part}: a number with no command`);
      if (cmd === 'M') {
        cx = num();
        cy = num();
        sx = cx;
        sy = cy;
        cmd = 'L';
      } else if (cmd === 'H') {
        const nx = num();
        push('H', cy, cx, nx);
        cx = nx;
      } else if (cmd === 'V') {
        const ny = num();
        push('V', cx, cy, ny);
        cy = ny;
      } else if (cmd === 'L') {
        const nx = num();
        const ny = num();
        if (ny === cy) push('H', cy, cx, nx);
        else if (nx === cx) push('V', cx, cy, ny);
        else throw new Error(`parseGlyphArt: ${part}: a diagonal segment can't be read across as one width`);
        cx = nx;
        cy = ny;
      } else if (cmd === 'Z') {
        if (sy === cy) push('H', cy, cx, sx);
        else if (sx === cx) push('V', cx, cy, sy);
        else throw new Error(`parseGlyphArt: ${part}: a diagonal close`);
        cx = sx;
        cy = sy;
      } else {
        throw new Error(`parseGlyphArt: ${part}: command ${cmd} isn't an absolute M, H, V, L or Z`);
      }
    }
  }
  return { viewBox: { x, y, w, h }, segments };
}

/**
 * Measure each leg of one machine's Factory glyph: one row per segment, in file order. A machine
 * whose glyph isn't the Factory art has no rows.
 */
export function measureGlyphStrokes(
  image: DecodedImage,
  facts: CaptureFacts,
  node: CaptureNode,
  masks: readonly MaskRect[] = captureMasks(facts),
  art: GlyphArt = factoryGlyph(),
): GlyphLegRow[] {
  const g = node.glyph;
  if (g === null || g.subject !== 'factory' || node.cells.length === 0) return [];
  const xs = node.cells.map(([x]) => x);
  const ys = node.cells.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const footW = (Math.max(...xs) - minX + 1) * CELL;
  const footH = (Math.max(...ys) - minY + 1) * CELL;
  const mismatch = Math.abs(g.box.footW - footW) > 1e-6 || Math.abs(g.box.footH - footH) > 1e-6;
  const ux = g.box.w / art.viewBox.w;
  const uy = g.box.h / art.viewBox.h;
  const wx = (sx: number) => minX * CELL + g.box.x + (sx - art.viewBox.x) * ux;
  const wy = (sy: number) => minY * CELL + g.box.y + (sy - art.viewBox.y) * uy;
  const margin = sampleMargin(facts);
  return art.segments.map((seg) => {
    const base = { nodeId: node.id, leg: `leg-${seg.leg}`, segment: `${seg.part} ${seg.orient} ${seg.orient === 'V' ? 'x' : 'y'}=${seg.at} ${seg.from}-${seg.to}` };
    if (mismatch) {
      return {
        ...base,
        width: { measured: false as const, reason: `the glyph's drawn footprint ${g.box.footW}x${g.box.footH} px isn't the scene footprint ${footW}x${footH} px, so its frame can't be mapped (a rotated body?)` },
      };
    }
    const across: 'x' | 'y' = seg.orient === 'V' ? 'x' : 'y';
    const halfAcross = (seg.strokeWidth / 2) * (across === 'x' ? ux : uy);
    const halfAlong = (seg.strokeWidth / 2) * (across === 'x' ? uy : ux);
    const at = across === 'x' ? wx(seg.at) : wy(seg.at);
    const toAlongWorld = (v: number) => (across === 'x' ? wy(v) : wx(v));
    const alongDev = (w: number) => (across === 'x' ? worldToDevice(facts, 0, w).y : worldToDevice(facts, w, 0).x);
    const acrossDev = (w: number) => (across === 'x' ? worldToDevice(facts, w, 0).x : worldToDevice(facts, 0, w).y);
    const lo = toAlongWorld(Math.min(seg.from, seg.to));
    const hi = toAlongWorld(Math.max(seg.from, seg.to));
    // Keep each line one device px clear of the strokes that join this leg at its two ends.
    const firstPx = Math.ceil(alongDev(lo + halfAlong)) + 1;
    const lastPx = Math.floor(alongDev(hi - halfAlong)) - 2;
    const candidates: number[] = [];
    for (let px = firstPx; px <= lastPx; px++) candidates.push(px);
    const lines = spread(candidates, LINES_PER_LEG);
    const band: StrokeBand = {
      across,
      outer: acrossDev(at - halfAcross),
      inner: acrossDev(at + halfAcross),
      lines,
      ...(lines.length === 0 ? { noLines: 'the leg has no room for a sample line clear of the strokes joining it' } : {}),
    };
    return { ...base, width: measureBand(image, band, masks, margin) };
  });
}

/**
 * Grade the glyph-strokes property: the outline rule applied to each Factory glyph's legs. With
 * antialiasing as shipped every leg's median core must be equal (a leg that differs from the most
 * common width is an offender); with it on, effective widths sit within `AA_ON_TOLERANCE` and, at
 * zoom 1 and the two boot zooms, no leg carries a fringe. A leg that wasn't measured is an offender.
 */
export function gradeGlyphStrokes(rows: readonly GlyphLegRow[], cell: CaptureCell): Grade {
  const off = offenderList();
  const nodes = [...new Set(rows.map((r) => r.nodeId))];
  for (const id of nodes) {
    const legs = rows.filter((r) => r.nodeId === id);
    const who = `machine ${id} glyph`;
    const measured: { leg: string; core: number; fringe: number; effective: number }[] = [];
    for (const r of legs) {
      if (!r.width.measured) off.add(`${id}:${r.leg}`, true, `${who} ${r.leg} (${r.segment}): not measured (${r.width.reason})`);
      else measured.push({ leg: r.leg, core: r.width.core, fringe: r.width.fringe, effective: r.width.effective });
    }
    if (measured.length < legs.length || measured.length === 0) continue;
    const list = (f: (s: (typeof measured)[number]) => number) => measured.map((s) => `${s.leg} ${round3(f(s))}`).join(', ');
    if (cell.aa === 'shipped') {
      const { odd, ref } = oddOnes(measured.map((s) => ({ leg: s.leg, v: s.core })));
      for (const { leg, v } of odd) off.add(`${id}:${leg}`, false, `${who} ${leg}: core ${v} against ${ref} on the other legs (${list((s) => s.core)})`);
    } else {
      const eff = measured.map((s) => s.effective);
      const spreadPx = Math.max(...eff) - Math.min(...eff);
      if (spreadPx > AA_ON_TOLERANCE + 1e-9) {
        const mid = median(eff);
        for (const s of measured) {
          if (Math.abs(s.effective - mid) > AA_ON_TOLERANCE / 2) off.add(`${id}:${s.leg}`, false, `${who} ${s.leg}: effective widths spread ${round3(spreadPx)} px, over ${AA_ON_TOLERANCE} (${list((x) => x.effective)})`);
        }
      }
      if (cell.zoom === 1 || isBootZoom(cell.zoom)) {
        for (const s of measured) if (s.fringe !== 0) off.add(`${id}:${s.leg}`, false, `${who} ${s.leg}: grey fringe ${s.fringe} at zoom ${zoomId(cell.zoom)} (core ${s.core})`);
      }
    }
  }
  const offenders = off.list();
  return gradeOf(`glyph strokes at ${cellLabel(cell)}: ${nodes.length} Factory glyphs, ${offenders.length} offenders`, offenders);
}

// ---------------------------------------------------------------------------
// Fault port rings (fault-ring, STRK-02)
// ---------------------------------------------------------------------------
//
// A bare fault port draws a core disc inside a ring (`machines.ts`, `NUB_FAULT_CORE_R` and
// `NUB_FAULT_RING_R` stroked `NUB_STROKE` wide), centred on the port's nub anchor. The measurer
// casts `RING_RAYS` rays from that centre. The rays pointing back into the machine are left out,
// because the ring overlaps the outline there. On each ray: the floor is the colour at the ray's
// far end and the ink the pixel farthest from it; the ring window is the pixels whose centres sit
// between the ring's inner and outer edges, widened by 0.75 px; the hole is the pixels strictly
// between the core's edge and the ring's inner edge. A ray with no ring-window pixel at coverage
// FRINGE_MIN or more is a gap. A ray whose hole holds no pixel nearer the floor than the ink
// (coverage below HOLE_FLOOR_MAX) has its hole closed. The ray's core counts the ring-window
// pixels at CORE_MIN or more; its effective width integrates the coverage along the ray. That threshold, not FRINGE_MIN, is used for
// the hole because the board's grid line runs through the nub's centre, and a grid pixel reads at
// a coverage of about 0.25.

/** Rays cast from a fault ring's centre, evenly spaced. */
export const RING_RAYS = 32;
/** A pixel below this coverage reads as floor for the ring's hole and for what lies beyond the ring. */
export const HOLE_FLOOR_MAX = 0.5;

/** Outward normals by side index, N=0, E=1, S=2, W=3. */
const SIDE_NORMALS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Where a fault ring sits in device px and how far its rays reach. */
function ringGeometry(facts: CaptureFacts, port: CapturePort) {
  const k = deviceScale(facts);
  const a = nubAnchor(port.cell_x, port.cell_y, port.side);
  const centre = worldToDevice(facts, a.x, a.y);
  const coreR = NUB_FAULT_CORE_R * k;
  const ringIn = (NUB_FAULT_RING_R - NUB_STROKE / 2) * k;
  const ringOut = (NUB_FAULT_RING_R + NUB_STROKE / 2) * k;
  const reach = ringOut + Math.max(2, Math.round(k));
  return { k, centre, coreR, ringIn, ringOut, reach };
}

/** Measure one fault port's ring. */
export function measureFaultRing(
  image: DecodedImage,
  facts: CaptureFacts,
  node: CaptureNode,
  port: CapturePort,
  masks: readonly MaskRect[] = captureMasks(facts),
): FaultRingRow {
  const base = { nodeId: node.id, port: port.index };
  const { k, centre: c, coreR, ringIn, ringOut, reach } = ringGeometry(facts, port);
  // The outline's band starts this far inside the anchor along the inward normal; a ray stays one
  // device px clear of it.
  const bandClear = (NUB_PUSH - INSET + chassisBandInsetsPx().outer) * k - 1;
  const [nx, ny] = SIDE_NORMALS[port.side & 3];
  const skips = new Map<string, number>();
  const skip = (why: string) => skips.set(why, (skips.get(why) ?? 0) + 1);
  const rays: { gap: boolean; holeOpen: boolean; core: number; effective: number }[] = [];
  for (let i = 0; i < RING_RAYS; i++) {
    const th = (i * 2 * Math.PI) / RING_RAYS;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    if (reach * cos < -bandClear) {
      skip('the ray runs into the machine outline');
      continue;
    }
    const dx = nx * cos - ny * sin;
    const dy = nx * sin + ny * cos;
    const pix: { x: number; y: number; r: number }[] = [];
    const seen = new Set<number>();
    let offImage = false;
    for (let t = 0; t <= reach + 1e-9; t += 0.25) {
      const px = Math.floor(c.x + dx * t);
      const py = Math.floor(c.y + dy * t);
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
        offImage = true;
        break;
      }
      const key = py * image.width + px;
      if (seen.has(key)) continue;
      seen.add(key);
      pix.push({ x: px, y: py, r: Math.hypot(px + 0.5 - c.x, py + 0.5 - c.y) });
    }
    if (offImage) {
      skip('the ray runs off the capture');
      continue;
    }
    const hit = masks.find((m) => pix.some((p) => p.x + 1 > m.x0 && p.x < m.x1 && p.y + 1 > m.y0 && p.y < m.y1));
    if (hit !== undefined) {
      skip(`the ray crosses ${hit.what}`);
      continue;
    }
    const colours = pix.map((p) => pixelAt(image, p.x, p.y));
    const floor = colours[colours.length - 1];
    let peak = 0;
    for (let j = 1; j < colours.length; j++) if (dist(colours[j], floor) > dist(colours[peak], floor)) peak = j;
    const ink = colours[peak];
    if (dist(ink, floor) < MIN_CONTRAST) {
      rays.push({ gap: true, holeOpen: true, core: 0, effective: 0 });
      continue;
    }
    if (lightness(ink) <= lightness(floor)) {
      skip("the ray's far end is lighter than the ring");
      continue;
    }
    const cov = colours.map((p) => coverageOf(p, floor, ink));
    if (pix.some((p, j) => p.r > ringOut + 0.75 && cov[j] >= HOLE_FLOOR_MAX)) {
      skip('other ink sits on the ray beyond the ring');
      continue;
    }
    let core = 0;
    let inked = false;
    let holeOpen = false;
    pix.forEach((p, j) => {
      if (p.r >= ringIn - 0.75 && p.r <= ringOut + 0.75) {
        if (cov[j] >= FRINGE_MIN) inked = true;
        if (cov[j] >= CORE_MIN) core++;
      }
      if (p.r > coreR && p.r < ringIn && cov[j] < HOLE_FLOOR_MAX) holeOpen = true;
    });
    // The effective width is the line integral of the coverage, interpolated bilinearly between
    // pixel centres, across the ring window. Summing whole pixels instead under-counts a thin grey
    // stroke on a diagonal ray, which visits fewer of its pixels than an axis-aligned one.
    const covAt = (x: number, y: number) => {
      const px = Math.min(image.width - 1, Math.max(0, x));
      const py = Math.min(image.height - 1, Math.max(0, y));
      return coverageOf(pixelAt(image, px, py), floor, ink);
    };
    let effective = 0;
    const step = 0.1;
    for (let t = Math.max(0, ringIn - 0.75); t <= ringOut + 0.75 + 1e-9; t += step) {
      const u = c.x + dx * t - 0.5;
      const v = c.y + dy * t - 0.5;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const top = covAt(x0, y0) * (1 - fx) + covAt(x0 + 1, y0) * fx;
      const bottom = covAt(x0, y0 + 1) * (1 - fx) + covAt(x0 + 1, y0 + 1) * fx;
      effective += (top * (1 - fy) + bottom * fy) * step;
    }
    rays.push({ gap: !inked, holeOpen, core, effective });
  }
  if (rays.length === 0) return { ...base, ring: { measured: false, reason: `no ray could be read: ${skipText(skips)}` } };
  return {
    ...base,
    ring: {
      measured: true,
      rays: rays.length,
      skipped: RING_RAYS - rays.length,
      gaps: rays.filter((r) => r.gap).length,
      holeClosed: rays.filter((r) => !r.holeOpen).length,
      minCore: Math.min(...rays.map((r) => r.core)),
      minEffective: round3(Math.min(...rays.map((r) => r.effective))),
    },
  };
}

/**
 * Grade the fault-ring property: a ring fails on any gap, on a closed hole, and on a stroke under
 * one device px (antialiasing as shipped: a radial core of 0 on some ray; on: an effective width
 * below 1). A ring that wasn't measured is an offender.
 */
export function gradeFaultRing(rows: readonly FaultRingRow[], cell: CaptureCell): Grade {
  const off = offenderList();
  for (const row of rows) {
    const key = `${row.nodeId}:fault-${row.port}`;
    const who = `machine ${row.nodeId} fault port ${row.port}`;
    const r = row.ring;
    if (!r.measured) {
      off.add(key, true, `${who}: not measured (${r.reason})`);
      continue;
    }
    if (r.gaps > 0) off.add(key, false, `${who}: a gap in the ring on ${r.gaps} of ${r.rays} rays`);
    if (r.holeClosed > 0) off.add(key, false, `${who}: the hole is filled on ${r.holeClosed} of ${r.rays} rays`);
    if (cell.aa === 'shipped' && r.minCore < 1) off.add(key, false, `${who}: radial core ${r.minCore} device px on some ray, under 1`);
    if (cell.aa === 'on' && r.minEffective < 1) off.add(key, false, `${who}: effective width ${r.minEffective} device px on some ray, under 1`);
  }
  const offenders = off.list();
  return gradeOf(`fault rings at ${cellLabel(cell)}: ${rows.length} rings, ${offenders.length} offenders`, offenders);
}

// ---------------------------------------------------------------------------
// Belt end marks: plug caps and junction collars, and the masks they make
// ---------------------------------------------------------------------------

/** The belt layer's plug cap radius at zoom 1 and its minimum zoom (`belts.ts`). */
const CAP_R = shippedConst('layers/belts.ts', 'CAP_R');
const CAP_MIN_SCALE = shippedConst('layers/belts.ts', 'MIN_SCALE');

/**
 * The plug stem's stroke width in world px, read off its one draw call in `belts.ts` (the stem is a
 * round-capped line in the `stem` ink; the width has no name of its own there).
 */
const STEM_WIDTH: number = (() => {
  const src = readFileSync(fileURLToPath(new URL('../../src/render/layers/belts.ts', import.meta.url)), 'utf8');
  const m = /\.stroke\(\{ width: (\d+(?:\.\d+)?), color: stem, alpha: 1, cap: 'round' \}\)/.exec(src);
  if (m === null) throw new Error("boardMeasure: no `.stroke({ width: <n>, color: stem, alpha: 1, cap: 'round' })` plug stem in src/render/layers/belts.ts");
  return Number(m[1]);
})();

/** The plug cap's radius in world px at a camera scale, on the belt layer's own floor formula. */
function capRadius(scale: number): number {
  return Math.min(CAP_R / Math.min(1, Math.max(scale, CAP_MIN_SCALE)), CAP_R / CAP_MIN_SCALE);
}

/** The junction collar's outer radius in world px (ring radius plus half its stroke), on the same formula. */
function collarRadius(scale: number): number {
  return Math.min(NUB_RING_R / Math.min(1, Math.max(scale, CAP_MIN_SCALE)), NUB_RING_R / CAP_MIN_SCALE) + NUB_RING_STROKE / 2;
}

/** One mark a belt draws at an end: a plug cap on a machine port, or a junction collar on a seam. */
export interface BeltEndMark {
  n: number;
  end: 'Head' | 'Tail';
  mark: 'cap' | 'collar';
  /** Where the mark is centred, in world px, snapped as the belt layer snaps it. */
  centre: { x: number; y: number };
  /** The port's anchor before snapping (a cap only): where its plug stem ends. */
  anchor?: { x: number; y: number };
  /** The port's side and role (a cap only). */
  side?: number;
  role?: number;
}

/**
 * Every mark one belt draws at its ends, in a fixed order that numbers them: 0 the Head, 1 the
 * Tail, 2 and up each further Tail plug of a fan-in. Mirrors `belts.ts` (`resolveEndAnchor`,
 * `resolveExtraTailAnchors` and the collar ownership rule): a seam is drawn by the Head that
 * ends there, as a collar, and a Tail seam draws nothing; a port end draws a cap at the port's
 * nub anchor.
 */
export function beltEndMarks(facts: CaptureFacts, belt: CaptureBelt): BeltEndMark[] {
  const q = deviceScale(facts);
  const nodes = new Map(facts.nodes.map((n) => [n.id, n]));
  const belts = new Map(facts.belts.map((b) => [b.id, b as unknown as BeltView]));
  const view = belt as unknown as BeltView;
  const portOf = (dock: CaptureBelt['docks'][number]) => {
    const node = nodes.get(dock.node);
    return node === undefined ? null : dockPort({ ports: node.ports } as unknown as NodeView, dock);
  };
  const capAt = (n: number, end: 'Head' | 'Tail', dock: CaptureBelt['docks'][number]): BeltEndMark | null => {
    const port = portOf(dock);
    if (port === null) return null;
    const anchor = nubAnchor(port.cell_x, port.cell_y, port.side);
    return { n, end, mark: 'cap', centre: { x: snapToDevicePixel(anchor.x, q), y: snapToDevicePixel(anchor.y, q) }, anchor, side: port.side, role: port.role };
  };
  const out: BeltEndMark[] = [];
  const head = belt.docks.find((d) => d.end === 'Head');
  if (head !== undefined) {
    const seam = beltSeamPoint(belts, view, 'Head');
    if (seam !== null) {
      const plotted = belt.collars[0];
      out.push({ n: 0, end: 'Head', mark: 'collar', centre: plotted ?? { x: snapToDevicePixel(seam.x, q), y: snapToDevicePixel(seam.y, q) } });
    } else {
      const cap = capAt(0, 'Head', head);
      if (cap !== null) out.push(cap);
    }
  }
  const tails = belt.docks.filter((d) => d.end === 'Tail');
  if (tails.length > 0 && beltSeamPoint(belts, view, 'Tail') === null) {
    const cap = capAt(1, 'Tail', tails[0]);
    if (cap !== null) out.push(cap);
  }
  tails.slice(1).forEach((dock, i) => {
    const cap = capAt(2 + i, 'Tail', dock);
    if (cap !== null) out.push(cap);
  });
  return out;
}

/**
 * The belt end plugs as masks: each cap's disc, each collar and, with `stems`, each plug stem (a
 * round-capped line `STEM_WIDTH` wide from the end tile's centre to the port anchor, drawn only on
 * a belt of more than one tile), in device px. The tread under a plug is hidden by design, so the
 * dash measurer doesn't read there; the stem runs between the rails, so the rail measurer leaves
 * stems out. `beltId` keeps one belt's plugs only.
 */
export function plugMasks(facts: CaptureFacts, beltId?: number, stems = true): MaskRect[] {
  const out: MaskRect[] = [];
  const capR = capRadius(facts.camera.scale);
  const collarR = collarRadius(facts.camera.scale);
  for (const belt of facts.belts) {
    if (beltId !== undefined && belt.id !== beltId) continue;
    for (const m of beltEndMarks(facts, belt)) {
      if (m.mark === 'collar') {
        out.push(worldBoxMask(facts, m.centre.x - collarR, m.centre.y - collarR, m.centre.x + collarR, m.centre.y + collarR, 'a belt end plug', MASK_CLEARANCE_PX));
        continue;
      }
      out.push(worldBoxMask(facts, m.centre.x - capR, m.centre.y - capR, m.centre.x + capR, m.centre.y + capR, 'a belt end plug', MASK_CLEARANCE_PX));
      if (stems && belt.tiles.length > 1 && m.anchor !== undefined) {
        const [ex, ey] = beltEndCell(belt.tiles, m.end);
        const sx = ex * CELL + CELL / 2;
        const sy = ey * CELL + CELL / 2;
        const h = STEM_WIDTH / 2;
        out.push(worldBoxMask(facts, Math.min(sx, m.anchor.x) - h, Math.min(sy, m.anchor.y) - h, Math.max(sx, m.anchor.x) + h, Math.max(sy, m.anchor.y) + h, 'a belt end plug', MASK_CLEARANCE_PX));
      }
    }
  }
  return out;
}

/** Every mask the belt measurers respect: `captureMasks` plus every belt's end plugs. */
export function beltMasks(facts: CaptureFacts): MaskRect[] {
  return [...captureMasks(facts), ...plugMasks(facts)];
}

// ---------------------------------------------------------------------------
// The belt dash and its low-zoom tick (belt-dash, STRK-02)
// ---------------------------------------------------------------------------
//
// A straight tile draws a 2 px centreline tread (`BELT_GEOM.band`): at `treadDrawnAsDash` zooms a
// marching dash, 10 on and 6 off, and below that one static tick on the tile centre
// (`straightTickCommands`). The measurer walks the tile's centreline one device pixel at a time.
// At each step it reads the pixels across the tread band against the floor halfway out to the
// rail, and the step is ink when any of them reaches coverage FRINGE_MIN. Corners are out of scope.
//
// The march phase isn't needed. A tile is two whole dash periods long, so in the dash pattern every
// unclipped dark run between two inked runs is one gap long (`BELT_GEOM.gap`). A shorter one is a
// hole inside a dash; a longer one, or a dark run at a tile end longer than one gap, is a dash that
// is missing. Below the switch, any dark run within the tick's extent is a gap. A device px at each
// tile end is left unread because the grid line crosses the tread there. Steps the belt's own end
// plug covers are skipped by design; a tile whose whole tread lies under its own plug isn't a subject.

/** How far a dark run may be off one dash gap before it counts as a hole or a missing dash, in device px. */
export const DASH_GAP_TOLERANCE_PX = 2;

interface DashColumn {
  /** The step's pixel index on the along axis. */
  along: number;
  state: 'read' | 'plug' | 'masked' | 'off';
  why?: string;
}

/** Where one straight tile's tread is read, in device px, and which steps can be read. */
function dashColumns(
  facts: CaptureFacts,
  imageSize: { width: number; height: number } | null,
  belt: CaptureBelt,
  n: number,
  masks: readonly MaskRect[],
  ownPlug: readonly MaskRect[],
) {
  const tile = belt.tiles[n];
  if (!('Straight' in tile.kind)) throw new Error(`dashColumns: belt ${belt.id} tile ${n} is a corner`);
  const q = deviceScale(facts);
  const c = worldToDevice(facts, snapToDevicePixel(tile.cell_x * CELL + CELL / 2, q), snapToDevicePixel(tile.cell_y * CELL + CELL / 2, q));
  const horizontal = tile.kind.Straight.axis === 0;
  const cAlong = horizontal ? c.x : c.y;
  const cAcross = horizontal ? c.y : c.x;
  const mode: 'dash' | 'tick' = treadDrawnAsDash(facts.camera.scale) ? 'dash' : 'tick';
  let lo: number;
  let hi: number;
  if (mode === 'dash') {
    const trim = Math.ceil(facts.dpr) + 1;
    lo = cAlong - (CELL / 2) * q + trim;
    hi = cAlong + (CELL / 2) * q - trim;
  } else {
    const tickXs = straightTickCommands()[0].points.filter((_, i) => i % 2 === 0);
    lo = cAlong + Math.min(...tickXs) * q + 1;
    hi = cAlong + Math.max(...tickXs) * q - 1;
  }
  const bh = (BELT_GEOM.band / 2) * q;
  const rb = railBandAt(q);
  const window: number[] = [];
  for (let p = Math.floor(cAcross - bh - 1); p <= Math.ceil(cAcross + bh + 1); p++) {
    if (p + 0.5 >= cAcross - bh - 0.5 && p + 0.5 <= cAcross + bh + 0.5) window.push(p);
  }
  if (window.length === 0) window.push(Math.floor(cAcross));
  const f = (bh + (rb.d - rb.t)) / 2;
  const floorHi = Math.max(Math.floor(cAcross + f), Math.max(...window) + 1);
  const floorLo = Math.min(Math.floor(cAcross - f), Math.min(...window) - 1);
  const cols: DashColumn[] = [];
  for (let a = Math.ceil(lo); a + 1 <= hi; a++) {
    const box = horizontal ? { x0: a, y0: floorLo, x1: a, y1: floorHi } : { x0: floorLo, y0: a, x1: floorHi, y1: a };
    if (imageSize !== null && (box.x0 < 0 || box.y0 < 0 || box.x1 >= imageSize.width || box.y1 >= imageSize.height)) {
      cols.push({ along: a, state: 'off', why: 'the tread runs off the capture' });
      continue;
    }
    if (maskHit(ownPlug, box.x0, box.y0, box.x1, box.y1) !== undefined) {
      cols.push({ along: a, state: 'plug' });
      continue;
    }
    const hit = maskHit(masks, box.x0, box.y0, box.x1, box.y1);
    cols.push(hit === undefined ? { along: a, state: 'read' } : { along: a, state: 'masked', why: `the tread is under ${hit.what}` });
  }
  return { mode, horizontal, window, floorLo, floorHi, cols };
}

/** True when the tile's whole tread lies under its own belt's end plug: drawn hidden, so not a subject. */
export function dashHiddenByOwnPlug(facts: CaptureFacts, belt: CaptureBelt, n: number): boolean {
  const { cols } = dashColumns(facts, null, belt, n, [], plugMasks(facts, belt.id));
  return cols.length > 0 && cols.every((c) => c.state === 'plug');
}

/** Measure the tread of each straight tile of one belt (`keep` picks which), one row per tile. */
export function measureBeltDash(
  image: DecodedImage,
  facts: CaptureFacts,
  belt: CaptureBelt,
  masks: readonly MaskRect[] = beltMasks(facts),
  keep: (n: number) => boolean = () => true,
): BeltDashRow[] {
  const q = deviceScale(facts);
  const ownPlug = plugMasks(facts, belt.id);
  const rows: BeltDashRow[] = [];
  belt.tiles.forEach((tile, n) => {
    if (!('Straight' in tile.kind) || !keep(n)) return;
    const geo = dashColumns(facts, image, belt, n, masks, ownPlug);
    const base = { beltId: belt.id, tile: n, cell: `${tile.cell_x},${tile.cell_y}`, mode: geo.mode };
    const px = (along: number, across: number) => (geo.horizontal ? pixelAt(image, along, across) : pixelAt(image, across, along));
    // A step whose two floor pixels disagree can't be read either.
    for (const col of geo.cols) {
      if (col.state !== 'read') continue;
      if (dist(px(col.along, geo.floorLo), px(col.along, geo.floorHi)) > FLOOR_AGREE) {
        col.state = 'masked';
        col.why = 'the floor differs on the two sides of the tread';
      }
    }
    const read = geo.cols.filter((col) => col.state === 'read');
    if (read.length === 0) {
      const counts = new Map<string, number>();
      for (const col of geo.cols) {
        const why = col.state === 'plug' ? "the belt's own end plug" : (col.why ?? col.state);
        counts.set(why, (counts.get(why) ?? 0) + 1);
      }
      rows.push({ ...base, stroke: { measured: false, reason: geo.cols.length === 0 ? 'the tread has no device pixel to read' : `no step could be read: ${skipText(counts)}` } });
      return;
    }
    let ink: Rgb | null = null;
    let inkDist = 0;
    for (const col of read) {
      const floor = px(col.along, geo.floorLo);
      for (const p of geo.window) {
        const d = dist(px(col.along, p), floor);
        if (d > inkDist) {
          inkDist = d;
          ink = px(col.along, p);
        }
      }
    }
    const stepInk = new Map<number, { inked: boolean; core: number; effective: number }>();
    for (const col of read) {
      const floor = px(col.along, geo.floorLo);
      const covs = ink === null || inkDist < MIN_CONTRAST ? geo.window.map(() => 0) : geo.window.map((p) => coverageOf(px(col.along, p), floor, ink as Rgb));
      stepInk.set(col.along, { inked: covs.some((v) => v >= FRINGE_MIN), core: covs.filter((v) => v >= CORE_MIN).length, effective: covs.reduce((s, v) => s + v, 0) });
    }
    // Dark runs: a run touching a tile end or a step that couldn't be read is clipped.
    const runs: { len: number; clipped: boolean }[] = [];
    let len = 0;
    let clippedStart = true;
    geo.cols.forEach((col, i) => {
      const s = col.state === 'read' ? (stepInk.get(col.along)?.inked ? 'ink' : 'dark') : 'blocked';
      if (s === 'dark') {
        len++;
        if (i === geo.cols.length - 1) runs.push({ len, clipped: true });
        return;
      }
      if (len > 0) runs.push({ len, clipped: clippedStart || s === 'blocked' });
      len = 0;
      clippedStart = s === 'blocked';
    });
    const expGap = BELT_GEOM.gap * q;
    const gapRuns =
      geo.mode === 'dash'
        ? runs.filter((r) => (r.clipped ? r.len > expGap + DASH_GAP_TOLERANCE_PX : Math.abs(r.len - expGap) > DASH_GAP_TOLERANCE_PX))
        : runs;
    const inked = read.map((col) => stepInk.get(col.along)).filter((v) => v !== undefined && v.inked) as { core: number; effective: number }[];
    rows.push({
      ...base,
      stroke: {
        measured: true,
        gaps: gapRuns.length,
        longestGapPx: gapRuns.length === 0 ? 0 : Math.max(...gapRuns.map((r) => r.len)),
        readPx: read.length,
        core: inked.length === 0 ? 0 : median(inked.map((v) => v.core)),
        effective: inked.length === 0 ? 0 : round3(median(inked.map((v) => v.effective))),
      },
    });
  });
  return rows;
}

/**
 * Grade the belt-dash property: a tile fails on any gap; below the switch zoom a tick also fails
 * when it is thinner than one device px (antialiasing as shipped: core 0; on: effective under 1).
 * A tile that wasn't measured is an offender.
 */
export function gradeBeltDash(rows: readonly BeltDashRow[], cell: CaptureCell): Grade {
  const off = offenderList();
  for (const row of rows) {
    const key = `${row.beltId}:tile-${row.tile}`;
    const who = `belt ${row.beltId} tile ${row.tile} (cell ${row.cell}, ${row.mode})`;
    const s = row.stroke;
    if (!s.measured) {
      off.add(key, true, `${who}: not measured (${s.reason})`);
      continue;
    }
    if (s.gaps > 0) off.add(key, false, `${who}: ${s.gaps} gap${s.gaps === 1 ? '' : 's'} in the ${row.mode}, the longest ${s.longestGapPx} device px (${s.readPx} px read)`);
    else if (row.mode === 'tick' && cell.aa === 'shipped' && s.core < 1) off.add(key, false, `${who}: the tick's core is ${s.core} device px, under 1`);
    else if (row.mode === 'tick' && cell.aa === 'on' && s.effective < 1) off.add(key, false, `${who}: the tick's effective width is ${s.effective} device px, under 1`);
  }
  const offenders = off.list();
  return gradeOf(`belt dash at ${cellLabel(cell)}: ${rows.length} straight tiles, ${offenders.length} offenders`, offenders);
}

// ---------------------------------------------------------------------------
// Rail width against outline width (rail-vs-outline, STRK-03)
// ---------------------------------------------------------------------------

/** The median core and effective width of every measured outline side in one capture. */
export function outlineWidthOf(outlines: readonly MachineOutline[]): OutlineWidth {
  const sides = outlines.flatMap((m) => SIDES.map((s) => m.sides[s])).filter((s): s is Extract<SideResult, { measured: true }> => s.measured);
  if (sides.length === 0) return { measured: false, reason: 'no machine outline side was measured in this capture' };
  return { measured: true, core: median(sides.map((s) => s.core)), effective: round3(median(sides.map((s) => s.effective))), sides: sides.length };
}

/**
 * Measure one belt's rails across its straight tiles (`keep` picks which): three sample lines per
 * rail per tile, each reading from the lane's floor out across the rail to the board beyond it.
 * `outline` is the median outline width of the same capture, carried on the row for the page.
 */
export function measureRailWidth(
  image: DecodedImage,
  facts: CaptureFacts,
  belt: CaptureBelt,
  outline: OutlineWidth,
  masks: readonly MaskRect[] = [...captureMasks(facts), ...plugMasks(facts, undefined, false)],
  keep: (n: number) => boolean = () => true,
): RailRow {
  const q = deviceScale(facts);
  const rb = railBandAt(q);
  const bh = (BELT_GEOM.band / 2) * q;
  // Start two device px past the plug stem's edge (and past the tread band), so a rail wider than it
  // should be still lies on the line, but at least one device px inside the rail's inner edge, so
  // the line holds lane floor at its inner end at low zoom too.
  const inner = Math.min(Math.max(bh + 1, (STEM_WIDTH / 2) * q + 2), rb.d - rb.t - 1);
  const beyond = Math.max(1, Math.round(((CELL / 2 - BELT_GEOM.laneHalf) / 2) * q));
  const trim = Math.ceil(facts.dpr) + 1;
  const readings: { core: number; fringe: number; effective: number }[] = [];
  const skips = new Map<string, number>();
  const skip = (why: string) => skips.set(why, (skips.get(why) ?? 0) + 1);
  let attempts = 0;
  belt.tiles.forEach((tile, n) => {
    if (!('Straight' in tile.kind) || !keep(n)) return;
    const c = worldToDevice(facts, snapToDevicePixel(tile.cell_x * CELL + CELL / 2, q), snapToDevicePixel(tile.cell_y * CELL + CELL / 2, q));
    const horizontal = tile.kind.Straight.axis === 0;
    const cAlong = horizontal ? c.x : c.y;
    const cAcross = horizontal ? c.y : c.x;
    const lo = cAlong - (CELL / 2) * q + trim;
    const hi = cAlong + (CELL / 2) * q - trim;
    for (const frac of [0.25, 0.5, 0.75]) {
      const a = Math.floor(lo + frac * (hi - lo));
      for (const s of [-1, 1]) {
        attempts++;
        const from = Math.floor(cAcross + s * inner);
        const to = Math.floor(cAcross + s * (rb.d + beyond));
        const idx: number[] = [];
        for (let p = from; s > 0 ? p <= to : p >= to; p += s) idx.push(p);
        const [p0, p1] = [Math.min(from, to), Math.max(from, to)];
        const box = horizontal ? { x0: a, y0: p0, x1: a, y1: p1 } : { x0: p0, y0: a, x1: p1, y1: a };
        if (box.x0 < 0 || box.y0 < 0 || box.x1 >= image.width || box.y1 >= image.height) {
          skip('the line runs off the capture');
          continue;
        }
        const hit = maskHit(masks, box.x0, box.y0, box.x1, box.y1);
        if (hit !== undefined) {
          skip(`the line crosses ${hit.what}`);
          continue;
        }
        const r = readSampleLine(idx.map((p) => (horizontal ? pixelAt(image, a, p) : pixelAt(image, p, a))));
        if (r.ok) readings.push(r);
        else skip(r.reason);
      }
    }
  });
  const rail: SideResult =
    readings.length === 0
      ? { measured: false, reason: attempts === 0 ? 'the belt has no straight tile here' : `all ${attempts} sample lines skipped: ${skipText(skips)}` }
      : {
          measured: true,
          core: median(readings.map((r) => r.core)),
          fringe: median(readings.map((r) => r.fringe)),
          effective: round3(median(readings.map((r) => r.effective))),
          lines: readings.length,
          skipped: attempts - readings.length,
        };
  const ratio = rail.measured && outline.measured ? `${rail.core}:${outline.core}` : '';
  return { beltId: belt.id, rail, outline, ratio };
}

/**
 * Grade the rail-vs-outline property: a belt fails when its rails' median core is wider than the
 * median outline core of the same capture. Every belt's ratio is in the explanation either way. A
 * rail or an outline that wasn't measured is an offender.
 */
export function gradeRailVsOutline(rows: readonly RailRow[], cell: CaptureCell): Grade {
  const off = offenderList();
  const notes: string[] = [];
  for (const row of rows) {
    const key = `${row.beltId}:rail`;
    const who = `belt ${row.beltId} rail`;
    if (!row.rail.measured) off.add(key, true, `${who}: not measured (${row.rail.reason})`);
    if (!row.outline.measured) off.add(key, true, `${who}: no outline to compare with (${row.outline.reason})`);
    if (!row.rail.measured || !row.outline.measured) continue;
    if (row.rail.core > row.outline.core) off.add(key, false, `${who}: core ${row.rail.core} device px, wider than the outline's ${row.outline.core} (rail : outline ${row.ratio})`);
    else notes.push(`${who} : outline ${row.ratio}`);
  }
  const offenders = off.list();
  return gradeOf(`rail against outline at ${cellLabel(cell)}: ${rows.length} belts, ${offenders.length} offenders`, offenders, notes);
}

// ---------------------------------------------------------------------------
// Cap size against a cell (cap-in-cell, STRK-03)
// ---------------------------------------------------------------------------
//
// One scan line through each mark. For a plug cap it runs along the machine side the port sits on,
// moved `ceil(dpr)` device px outward (a fault-exit cap's scan stays on its centre, on the core): through the centre it would run along the grid line at the
// cell edge, and the plug stem and the machine lie along the other axis. A collar is scanned
// horizontally through its centre, as far each way as `capReach` says. The ink is the colour at the
// centre and the floor the darkest pixel near the mark; the mark's edge is where coverage drops below HOLE_FLOOR_MAX (half way to the ink, so
// a grid line or a stem doesn't extend it). A fault-exit cap and a collar are rings with something
// darker inside, so one dark run that ink follows within 1.5 times the ink run before it is crossed.

/** Measure each end mark of one belt (`keep` picks which by its number), one row per mark. */
export function measureCapWidth(
  image: DecodedImage,
  facts: CaptureFacts,
  belt: CaptureBelt,
  masks: readonly MaskRect[] = captureMasks(facts),
  keep: (n: number) => boolean = () => true,
): CapRow[] {
  const q = deviceScale(facts);
  const cellPx = CELL * q;
  const reach = capReach(facts);
  const rows: CapRow[] = [];
  for (const m of beltEndMarks(facts, belt)) {
    if (!keep(m.n)) continue;
    const base = { beltId: belt.id, n: m.n, end: m.end, mark: m.mark, cellPx: round3(cellPx) };
    const scan = capScan(facts, m);
    const coords: { x: number; y: number }[] = [];
    for (let j = -reach; j <= reach; j++) coords.push(scan.alongX ? { x: scan.centre + j, y: scan.line } : { x: scan.line, y: scan.centre + j });
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first.x < 0 || first.y < 0 || last.x >= image.width || last.y >= image.height) {
      rows.push({ ...base, cap: { measured: false, reason: 'the scan runs off the capture' } });
      continue;
    }
    const hit = maskHit(masks, first.x, first.y, last.x, last.y);
    if (hit !== undefined) {
      rows.push({ ...base, cap: { measured: false, reason: `the scan crosses ${hit.what}` } });
      continue;
    }
    const colours = coords.map((p) => pixelAt(image, p.x, p.y));
    const ink = colours[reach];
    // The board floor is the darkest step of the ramp. The scan's own ends can land on a
    // neighbouring rail or on caps merged into one blob, so the floor is the darkest pixel in a box
    // a cell wider than the scan around the mark.
    const floor = darkestAround(image, coords[reach], reach + Math.ceil(cellPx / 2));
    if (dist(ink, floor) < MIN_CONTRAST) {
      rows.push({ ...base, cap: { measured: false, reason: 'no mark stands out from the floor at its centre' } });
      continue;
    }
    const cov = (j: number) => coverageOf(colours[reach + j], floor, ink);
    const ringed = m.mark === 'collar' || m.role === PORT_ROLE.FAULT;
    const walk = (dir: 1 | -1): number => {
      let extent = 0;
      let holeLeft = ringed;
      let j = 1;
      while (j <= reach) {
        if (cov(dir * j) >= HOLE_FLOOR_MAX) {
          extent = j;
          j++;
          continue;
        }
        if (holeLeft) {
          const holeMax = Math.ceil(1.5 * (extent + 1)) + 1;
          let k = j;
          while (k <= reach && k - j < holeMax && cov(dir * k) < HOLE_FLOOR_MAX) k++;
          if (k <= reach && k - j < holeMax) {
            holeLeft = false;
            j = k;
            continue;
          }
        }
        break;
      }
      return extent;
    };
    rows.push({ ...base, cap: { measured: true, widthPx: walk(-1) + walk(1) + 1, offsetPx: scan.offset } });
  }
  return rows;
}

/**
 * How far a cap scan reads each way from the mark's centre, in device px: half a cell or the cap's
 * own radius, whichever is larger, plus two. A mark wider than its cell always reads wider than the
 * cell, a lone cap reads its whole width, and at zoom 1 and above the scan stays short enough to fit
 * a tile beside the board's edge. Caps merged into one blob read as wide as the scan.
 */
function capReach(facts: CaptureFacts): number {
  const k = deviceScale(facts);
  return Math.ceil(Math.max((CELL * k) / 2, capRadius(facts.camera.scale) * k)) + 2;
}

/** The darkest pixel within `r` device px of `at` (clipped to the image). */
function darkestAround(image: DecodedImage, at: { x: number; y: number }, r: number): Rgb {
  let best = pixelAt(image, at.x, at.y);
  for (let y = Math.max(0, at.y - r); y <= Math.min(image.height - 1, at.y + r); y++) {
    for (let x = Math.max(0, at.x - r); x <= Math.min(image.width - 1, at.x + r); x++) {
      const p = pixelAt(image, x, y);
      if (lightness(p) < lightness(best)) best = p;
    }
  }
  return best;
}

/** The scan line through one end mark: which axis it runs along, its fixed pixel line, its centre pixel, its outward offset. */
function capScan(facts: CaptureFacts, m: BeltEndMark): { alongX: boolean; line: number; centre: number; offset: number } {
  const d = worldToDevice(facts, m.centre.x, m.centre.y);
  if (m.mark === 'collar' || m.side === undefined) return { alongX: true, line: Math.floor(d.y), centre: Math.floor(d.x), offset: 0 };
  // A fault-exit cap is a ring around a small core: moved off its centre the scan would start in
  // the ring's hole, so it runs through the centre.
  const offset = m.role === PORT_ROLE.FAULT ? 0 : Math.ceil(facts.dpr);
  const [nx, ny] = SIDE_NORMALS[m.side & 3];
  // A port on the north or south side: the scan runs along x, moved along y.
  if (nx === 0) return { alongX: true, line: Math.floor(d.y + ny * offset), centre: Math.floor(d.x), offset };
  return { alongX: false, line: Math.floor(d.x + nx * offset), centre: Math.floor(d.y), offset };
}

/** The device-px box one end mark's scan reads. */
function capScanBox(facts: CaptureFacts, m: BeltEndMark): DeviceBox {
  const reach = capReach(facts);
  const s = capScan(facts, m);
  return s.alongX ? { x0: s.centre - reach, y0: s.line, x1: s.centre + reach + 1, y1: s.line + 1 } : { x0: s.line, y0: s.centre - reach, x1: s.line + 1, y1: s.centre + reach + 1 };
}

/** Grade the cap-in-cell property: a mark fails when it is wider than one cell. A mark that wasn't measured is an offender. */
export function gradeCapInCell(rows: readonly CapRow[], cell: CaptureCell): Grade {
  const off = offenderList();
  for (const row of rows) {
    const key = `${row.beltId}:collar-${row.n}`;
    const who = `belt ${row.beltId} ${row.end} ${row.mark}`;
    if (!row.cap.measured) off.add(key, true, `${who}: not measured (${row.cap.reason})`);
    else if (row.cap.widthPx > row.cellPx) off.add(key, false, `${who}: ${row.cap.widthPx} device px wide in a cell of ${row.cellPx} px`);
  }
  const offenders = off.list();
  return gradeOf(`caps against cells at ${cellLabel(cell)}: ${rows.length} marks, ${offenders.length} offenders`, offenders);
}

// ---------------------------------------------------------------------------
// One tile, every property; one cell, any property
// ---------------------------------------------------------------------------

/** Each bare fault port in the scene: a port a belt plugs into is covered by its cap, which `cap-in-cell` grades. */
function bareFaultPorts(facts: CaptureFacts): { node: CaptureNode; port: CapturePort }[] {
  const plugged = new Set<string>();
  for (const belt of facts.belts) {
    for (const m of beltEndMarks(facts, belt)) {
      if (m.mark !== 'cap' || m.role !== PORT_ROLE.FAULT || m.anchor === undefined) continue;
      plugged.add(`${m.anchor.x},${m.anchor.y}`);
    }
  }
  const out: { node: CaptureNode; port: CapturePort }[] = [];
  for (const node of [...facts.nodes].sort((a, b) => a.id - b.id)) {
    if (node.isLabel || node.cells.length === 0) continue;
    for (const port of node.ports) {
      if (port.role !== PORT_ROLE.FAULT) continue;
      const a = nubAnchor(port.cell_x, port.cell_y, port.side);
      if (!plugged.has(`${a.x},${a.y}`)) out.push({ node, port });
    }
  }
  return out;
}

/** Fault rings are drawn by the machine layer, so only where machines draw as vectors. */
function ringsDrawn(facts: CaptureFacts): boolean {
  return machinesDrawnAsVectors(facts.camera.scale);
}

/** Every subject the scene holds for each property, whether or not this capture can read it. */
export function subjectsOf(facts: CaptureFacts): Record<PropertyId, string[]> {
  const nodes = [...facts.nodes].sort((a, b) => a.id - b.id);
  const belts = [...facts.belts].sort((a, b) => a.id - b.id);
  const straightTiles = (b: CaptureBelt) => b.tiles.map((t, n) => ('Straight' in t.kind ? n : -1)).filter((n) => n >= 0);
  return {
    'outline-sides': sceneMachines(facts).map((m) => String(m.nodeId)),
    'glyph-strokes': nodes.filter((n) => !n.isLabel && n.glyph?.subject === 'factory').map((n) => String(n.id)),
    'fault-ring': ringsDrawn(facts) ? bareFaultPorts(facts).map(({ node, port }) => `${node.id}:fault-${port.index}`) : [],
    'belt-dash': belts.flatMap((b) => straightTiles(b).filter((n) => !dashHiddenByOwnPlug(facts, b, n)).map((n) => `${b.id}:tile-${n}`)),
    'rail-vs-outline': belts.filter((b) => straightTiles(b).length > 0).map((b) => `${b.id}:rail`),
    'cap-in-cell': belts.flatMap((b) => beltEndMarks(facts, b).map((m) => `${b.id}:collar-${m.n}`)),
  };
}

/**
 * Measure every property in one capture. Each subject is measured only when its whole sampling
 * area lies on the canvas and off every chrome panel; one that isn't is left for another tile, and
 * the grade counts a subject no tile measured as an offender.
 */
export function measureTileProperties(image: DecodedImage, facts: CaptureFacts): TileRecord {
  const masks = captureMasks(facts);
  const withPlugs = [...masks, ...plugMasks(facts)];
  const withCaps = [...masks, ...plugMasks(facts, undefined, false)];
  const subjects = subjectsOf(facts);
  const outlines = measureTile(image, facts);
  const clear = (box: DeviceBox) => deviceBoxClear(facts, image, box);
  const want = (property: PropertyId) => new Set(subjects[property]);

  const glyphSubjects = want('glyph-strokes');
  const glyphs = facts.nodes
    .filter((n) => glyphSubjects.has(String(n.id)) && outlineClearOfChrome(facts, n, image))
    .sort((a, b) => a.id - b.id)
    .flatMap((n) => measureGlyphStrokes(image, facts, n, masks));

  const ringSubjects = want('fault-ring');
  const rings = ringsDrawn(facts)
    ? bareFaultPorts(facts)
        .filter(({ node, port }) => {
          if (!ringSubjects.has(`${node.id}:fault-${port.index}`)) return false;
          const g = ringGeometry(facts, port);
          const r = g.reach + 1;
          return clear({ x0: g.centre.x - r, y0: g.centre.y - r, x1: g.centre.x + r, y1: g.centre.y + r });
        })
        .map(({ node, port }) => measureFaultRing(image, facts, node, port, masks))
    : [];

  const dashSubjects = want('belt-dash');
  const belts = [...facts.belts].sort((a, b) => a.id - b.id);
  const tileClear = (b: CaptureBelt, n: number) => clear(cellBox(facts, b.tiles[n].cell_x, b.tiles[n].cell_y));
  const dashes = belts.flatMap((b) => measureBeltDash(image, facts, b, withPlugs, (n) => dashSubjects.has(`${b.id}:tile-${n}`) && tileClear(b, n)));

  const outlineWidth = outlineWidthOf(outlines);
  const rails = belts
    .filter((b) => b.tiles.some((t, n) => 'Straight' in t.kind && tileClear(b, n)))
    .map((b) => measureRailWidth(image, facts, b, outlineWidth, withCaps, (n) => tileClear(b, n)));

  const caps = belts.flatMap((b) => {
    const marks = new Map(beltEndMarks(facts, b).map((m) => [m.n, m]));
    return measureCapWidth(image, facts, b, masks, (n) => {
      const m = marks.get(n);
      return m !== undefined && clear(capScanBox(facts, m));
    });
  });

  return {
    scene: sceneMachines(facts),
    subjects,
    measurements: { 'outline-sides': outlines, 'glyph-strokes': glyphs, 'fault-ring': rings, 'belt-dash': dashes, 'rail-vs-outline': rails, 'cap-in-cell': caps },
  };
}

/** What a cell with no subject for the property is missing, for the `no-subjects` offender. */
const NO_SUBJECT: Record<PropertyId, string> = {
  'outline-sides': 'no machine with an outline',
  'glyph-strokes': 'no Factory glyph',
  'fault-ring': 'no bare fault port',
  'belt-dash': 'no straight belt tile',
  'rail-vs-outline': 'no belt rail',
  'cap-in-cell': 'no belt end cap or collar',
};

/** The subject a measured row belongs to. */
function rowSubject(property: Exclude<PropertyId, 'outline-sides'>, row: GlyphLegRow | FaultRingRow | BeltDashRow | RailRow | CapRow): string {
  switch (property) {
    case 'glyph-strokes':
      return String((row as GlyphLegRow).nodeId);
    case 'fault-ring':
      return `${(row as FaultRingRow).nodeId}:fault-${(row as FaultRingRow).port}`;
    case 'belt-dash':
      return `${(row as BeltDashRow).beltId}:tile-${(row as BeltDashRow).tile}`;
    case 'rail-vs-outline':
      return `${(row as RailRow).beltId}:rail`;
    case 'cap-in-cell':
      return `${(row as CapRow).beltId}:collar-${(row as CapRow).n}`;
  }
}

/**
 * Grade one property over one cell's tiles: the dispatch every grading test hands to
 * `runGradeCell`. It first counts the cell's subjects for the property over all its tiles (for
 * `rail-vs-outline`, rails together with at least one machine outline). With none it returns one
 * unmeasured `no-subjects` offender before any rule runs, so a cell can't pass by finding nothing
 * to grade. Otherwise each subject is graded from the first tile that measured it, and a subject
 * no tile measured is an unmeasured `<subject>:never-clear` offender.
 */
export function gradeCell(property: PropertyId, cell: CaptureCell, tiles: readonly TileRecord[]): Grade {
  const union = (p: PropertyId) => {
    const seen = new Set<string>();
    for (const t of tiles) for (const s of t.subjects?.[p] ?? []) seen.add(s);
    return [...seen];
  };
  const subjects = union(property);
  const missing = subjects.length === 0 ? NO_SUBJECT[property] : property === 'rail-vs-outline' && union('outline-sides').length === 0 ? 'no machine outline to compare a rail with' : null;
  if (missing !== null) {
    const text = `${property} at ${cellLabel(cell)}: ${missing} in any of its ${tiles.length} tiles, so this cell has nothing to grade`;
    return { offenders: [{ key: 'no-subjects', unmeasured: true, text }], explain: text };
  }
  if (property === 'outline-sides') {
    const { outlines, neverClear } = outlinesForCell(tiles.map((t) => ({ scene: t.scene, outlines: t.measurements['outline-sides'] })));
    return gradeOutlineSides(outlines, cell, neverClear);
  }
  const picked: (GlyphLegRow | FaultRingRow | BeltDashRow | RailRow | CapRow)[] = [];
  const neverClear: Offender[] = [];
  for (const subject of subjects) {
    let rows: (GlyphLegRow | FaultRingRow | BeltDashRow | RailRow | CapRow)[] = [];
    for (const t of tiles) {
      const here = (t.measurements[property] as (GlyphLegRow | FaultRingRow | BeltDashRow | RailRow | CapRow)[]).filter((r) => rowSubject(property, r) === subject);
      if (here.length === 0) continue;
      // A rail is compared with the outline of its own capture: prefer a tile that measured both.
      if (property === 'rail-vs-outline' && rows.length === 0) rows = here;
      if (property !== 'rail-vs-outline' || here.every((r) => (r as RailRow).rail.measured && (r as RailRow).outline.measured)) {
        rows = here;
        break;
      }
    }
    if (rows.length === 0) neverClear.push({ key: `${subject}:never-clear`, unmeasured: true, text: `${subject}: never clear of chrome (no tile held its whole sampling area on the canvas)` });
    else picked.push(...rows);
  }
  const graded =
    property === 'glyph-strokes'
      ? gradeGlyphStrokes(picked as GlyphLegRow[], cell)
      : property === 'fault-ring'
        ? gradeFaultRing(picked as FaultRingRow[], cell)
        : property === 'belt-dash'
          ? gradeBeltDash(picked as BeltDashRow[], cell)
          : property === 'rail-vs-outline'
            ? gradeRailVsOutline(picked as RailRow[], cell)
            : gradeCapInCell(picked as CapRow[], cell);
  if (neverClear.length === 0) return graded;
  return { offenders: [...graded.offenders, ...neverClear], explain: `${graded.explain}\n  ${neverClear.map((o) => o.text).join('\n  ')}` };
}
