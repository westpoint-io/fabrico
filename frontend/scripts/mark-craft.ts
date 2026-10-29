// mark-craft.ts - the 16px craft-rule measuring instrument (MARK-01, plan 79-01).
//
// D-04 says the four 16px craft rules are MEASURED by a checked-in script rather than
// judged by eye. D-05 said: "the same script runs on today's shipped
// `src/chrome/assets/logomark.svg` and must print FAIL ... the shipped mark is the one
// drawing already in the tree that genuinely fails three of the four rules."
//
// THAT SUBJECT IS GONE. THE DEVICE DID NOT GO WITH IT, IT MOVED (plan 80-05,
// 80-MARK-LOCK-SUPERSESSION.md). The shipped mark is composition A and it PASSES all four
// rules. The drawing D-05 was describing is committed as
// `src/render/assets/__fixtures__/craft/retired-logomark-59.svg` and is the NEGATIVE
// subject now; the shipped mark is the POSITIVE one. Read the superseded sentence above as
// history, not as an instruction: an executor who "repairs" the pin back to a shipped FAIL
// row is requiring the brand mark to be bad, and `markCraft.test.ts`'s "THE SHIPPED ROW
// CARRIES NO FAIL AND NO OVERLAP" reddens on exactly that edit.
//
// WHERE THE ANTI-VACUITY DEVICE LIVES NOW. A craft script that passes everything it is
// pointed at is this repository's signature defect class, fourteen instances found
// historically and eight in Phase 67 alone. Two things stop this one from becoming another.
// `markCraft.test.ts` MEASURES the retired fixture at FAIL 5 shapes / PASS 26u / FAIL 2u /
// FAIL 1u, a MIX that neither a script passing everything nor a script failing everything
// can produce, and it measures the shipped mark at PASS 3 shapes / PASS 2u / n/a / PASS 2u
// as the positive half of the pair. Neither half reads `mark-craft.expected.json`, so a pin
// edited to agree with a broken script stays red. The pin's own remaining non-PASS anchor
// is `b-the-turn-16.svg`'s R4 OVERLAP.
//
// TWO CALLERS, ONE WALKER, following `lint-svg.ts`: `npm run check:mark-craft` drives the
// authoring loop and `src/render/assets/markCraft.test.ts` makes `npm test` and the CI
// unit job enforce the same measurements. No new CI job, for the reason recorded at
// `.github/workflows/ci.yml:1016-1017`.
//
// NO PATH INPUT, EVER (threat T-79-01, inherited from T-56-13). Every directory is
// resolved from `import.meta.url`. This module reads no argv and no cwd, so it cannot be
// pointed at an arbitrary directory - that would be both a path-traversal surface and a
// false-green source - and it is also why `node frontend/scripts/mark-craft.ts` works
// from the repository root and from `frontend/` alike.
//
// ERASURE-ONLY TYPESCRIPT. Node runs this file directly through native type stripping,
// which is erasure only: interfaces, type aliases, annotations and `import type` only,
// no enums, no namespaces, no parameter properties, an explicit `.ts` extension on every
// relative import, and no Vite-only import form. The contract is stated at
// `scripts/lint-svg.ts:29-34` and that file is the working example.
//
// NO NEW DEPENDENCY. The path-data walker below is hand-rolled because there is nothing
// to reuse: `lint-svg.ts`'s `parseSvg` is an ELEMENT parser and its `numericTokens`
// returns bare numbers with no command structure, and both are private. The dialect it
// has to read is `M H V L Z` with integer coordinates and zero curves, which
// `lint-svg.ts` already guarantees, so the walker is small.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCKED_SKIN } from '../src/render/synth/skins/locked.ts';
import { skinToCssVars } from '../src/render/synth/chrome/skinToCssVars.ts';
import { hasIllegalComment, illegalCommentLine, lintDir, report } from './lint-svg.ts';

/**
 * THE XML COMMENT DETECTOR NOW LIVES IN `lint-svg.ts`, AND THIS IS A RE-EXPORT (plan 80-05).
 *
 * It was defined here in plan 79-01, when its only subject was the Phase 79 candidates
 * directory and success criterion 4 froze `chrome/assets/` against the fix. Phase 80
 * unfreezes that directory, so the defect became a walked lint rule (`comment-hyphen`) and
 * the detector moved to where the walker is.
 *
 * RE-EXPORTED RATHER THAN LEFT BEHIND AS A SECOND COPY, and the direction is forced: this
 * module already imports `lintDir` and `report` from `lint-svg.ts`, so `lint-svg.ts`
 * importing back would be circular. Two definitions of one detector is how the walker and
 * the CLI come to disagree about what is legal, which is the failure this seam removes.
 * `run()` below and `render/assets/markCraft.test.ts` both keep calling it through here.
 */
export { hasIllegalComment, illegalCommentLine };

/* ------------------------------------------------------------------ *
 * The exported contract (plan 79-01 <interfaces>, consumed by plan 79-03)
 * ------------------------------------------------------------------ */

export type VerdictKind = 'PASS' | 'FAIL' | 'INFO' | 'OVERLAP' | 'NA';

export interface Verdict {
  kind: VerdictKind;
  /** The measured number. null for NA. */
  value: number | null;
  /** 'u' for unit distances, 'shapes' for the R1 count, null for NA. */
  unit: 'u' | 'shapes' | null;
  /** The rendered cell, e.g. 'PASS 6u', 'FAIL 5 shapes', 'OVERLAP', 'n/a'. */
  text: string;
  /** One short clause naming what was measured, e.g. 'item overlaps band'. Empty for PASS. */
  why: string;
}

export interface CutMeasurement {
  /** Bare filename, e.g. 'd-the-board-pixel.svg'. */
  file: string;
  /** 16 when this cut serves the 16px row, null when it is a full cut only. */
  serves: 16 | null;
  r1: Verdict;
  r2: Verdict;
  r3: Verdict;
  r4: Verdict;
}

export interface ExpectationRow {
  r1: string;
  r2: string;
  r3: string;
  r4: string;
}

export interface Mismatch {
  input: string;
  rule: 'r1' | 'r2' | 'r3' | 'r4';
  measured: string;
  expected: string;
}

/* ------------------------------------------------------------------ *
 * Paths - resolved from the module URL, never from cwd and never from argv
 * ------------------------------------------------------------------ */

/**
 * The Phase 79 candidate directory. It sits under `frontend/scripts/mark-candidates/`,
 * NOT under `frontend/src/chrome/assets/`, and that placement is decision D-09 rather than a
 * preference: the discovery walk in `scripts/lint-svg.ts` and in
 * `render/assets/vertexBudget.test.ts` is flat and non-recursive, so a candidate dropped
 * into the shipped directory silently joins the shipped asset set and moves three
 * hand-edited count literals.
 */
export const CANDIDATES_DIR = fileURLToPath(
  new URL('./mark-candidates/', import.meta.url),
);

/**
 * The shipped mark. D-05 called it "the negative fixture, and the reason this check can
 * fail"; that was true of the Phase 59 tile and stopped being true in plan 80-05. The
 * shipped mark is the POSITIVE subject now and passes all four rules. The reason this check
 * can fail is `src/render/assets/__fixtures__/craft/retired-logomark-59.svg`, measured
 * directly by `markCraft.test.ts`.
 */
export const SHIPPED_MARK = fileURLToPath(new URL('../src/chrome/assets/logomark.svg', import.meta.url));

/** The anti-vacuity pin. One row per input, four verdict cells per row. */
const EXPECTATIONS_FILE = fileURLToPath(new URL('./mark-craft.expected.json', import.meta.url));

/* ------------------------------------------------------------------ *
 * The grid, the thresholds and the tokens
 * ------------------------------------------------------------------ */

/** The author box every candidate and the shipped mark share: `viewBox="0 0 32 32"`. */
export const GRID = 32;

/**
 * The live area, in units, as a half-open interval `[LIVE_MIN, LIVE_MAX)`.
 *
 * At a 16px render one device pixel is two units, so the 14 by 14 device-pixel live area
 * a 16px icon actually gets is units 2 to 30. Every rule below is read off the buffer
 * restricted to this window, because a craft rule about legibility at 16px cannot be
 * measured over pixels the icon grid does not give you.
 */
export const LIVE_MIN = 2;
export const LIVE_MAX = 30;

/** R1: at most three distinct shapes in the live area. */
const MAX_SHAPES = 3;
/** R2: no ink run thinner than two units on either axis. */
const MIN_AXIS_STROKE = 2;
/** R3: a diagonal needs twice the weight of an axis-aligned stroke to read the same. */
const MIN_DIAGONAL_STROKE = 4;
/** R4: two shapes need two clear units between them or they merge at 16px. */
const MIN_GAP = 2;

/**
 * `--fab-*` token name to resolved hex, baked from `LOCKED_SKIN` rather than transcribed.
 *
 * Transcribing the palette would make this file a second source of truth for it, and the
 * first time a token moved the instrument would be measuring colours the product does not
 * have. `skinToCssVars` emits one `--name:value;` declaration per line, which is the
 * whole parse.
 */
function tokenTable(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of skinToCssVars(LOCKED_SKIN).split('\n')) {
    const m = /^(--fab-[a-z0-9-]+):(#[0-9a-fA-F]{6});$/.exec(line.trim());
    if (m !== null) out.set(m[1] as string, (m[2] as string).toLowerCase());
  }
  return out;
}

const TOKENS = tokenTable();

/**
 * THE VOID COLOUR. `--fab-substrate` is `ramp[0]`, the ground every mark sits on, and a
 * unit whose FINAL colour resolves to it is void rather than ink.
 *
 * This is not a tidiness rule, it is what makes the RETIRED mark measure five shapes and
 * not seven: `--fab-outline` and `--fab-edge-shadow` both resolve to this same value
 * (`bakeRamp` returns `brShadow = ramp[0]` and `skinToCssVars` binds both tokens to it),
 * so two of its six declared layers paint the ground and are not shapes at all. An executor
 * counting layers gets six and concludes the measured FAIL 5 is wrong.
 *
 * This paragraph read "the shipped mark" and "`logomark.svg`'s six declared layers" until
 * plan 80-05 replaced the asset. The subject is
 * `src/render/assets/__fixtures__/craft/retired-logomark-59.svg`; the shipped mark is
 * composition A, three layers, none of them void.
 */
const VOID = TOKENS.get('--fab-substrate') ?? '#1b1f27';

/**
 * Resolve an authored paint value to a hex colour, or null when it paints nothing.
 *
 * `currentColor` resolves to `--fab-ink`: a chrome glyph inherits the colour of the
 * control it sits in, and ink is what that control is, so treating it as anything else
 * would make a `currentColor` asset measure as void.
 */
function resolvePaint(value: string | undefined): string | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (v === '' || v === 'none') return null;
  if (v === 'currentColor') return TOKENS.get('--fab-ink') ?? null;
  const m = /^var\((--fab-[a-z0-9-]+)\)$/.exec(v);
  if (m !== null) return TOKENS.get(m[1] as string) ?? null;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const [, r, g, b] = /^#(.)(.)(.)$/.exec(v) as RegExpExecArray;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The path-data walker
 * ------------------------------------------------------------------ */

interface PathCommand {
  cmd: string;
  args: number[];
}

interface SubPath {
  /** Vertices in order. Integer coordinates, guaranteed by the dialect. */
  points: [number, number][];
  /** True when the subpath carried a `Z`, which adds the closing segment to the stroke. */
  closed: boolean;
}

/**
 * Tokenise path data into commands. Throws a NAMED error on anything outside the dialect,
 * which the CLI turns into a violation row rather than a stack trace (threat T-79-02): a
 * file silently skipped and then reported clean is the exact false green this instrument
 * exists to make impossible.
 */
function parseCommands(d: string, where: string): PathCommand[] {
  const out: PathCommand[] = [];
  let cur: PathCommand | null = null;
  for (const m of d.matchAll(/([A-Za-z])|(-?\d+(?:\.\d+)?)/g)) {
    if (m[1] !== undefined) {
      const c = m[1];
      if (!'MmHhVvLlZz'.includes(c)) {
        throw new Error(`${where}: command '${c}' is outside the M H V L Z dialect`);
      }
      cur = { cmd: c, args: [] };
      out.push(cur);
    } else {
      if (cur === null) throw new Error(`${where}: path data starts with a number, not a command`);
      cur.args.push(Number(m[2]));
    }
  }
  if (out.length === 0) throw new Error(`${where}: path data is empty`);
  return out;
}

/** Walk commands into subpaths. Supports the relative forms, which the dialect permits. */
function toSubPaths(commands: readonly PathCommand[], where: string): SubPath[] {
  const subs: SubPath[] = [];
  let cur: SubPath | null = null;
  let x = 0;
  let y = 0;
  const push = (): SubPath => {
    if (cur === null) throw new Error(`${where}: a drawing command appears before any M`);
    return cur;
  };
  for (const c of commands) {
    const rel = c.cmd === c.cmd.toLowerCase();
    switch (c.cmd.toUpperCase()) {
      case 'M': {
        if (c.args.length < 2 || c.args.length % 2 !== 0) {
          throw new Error(`${where}: M takes coordinate pairs, got ${c.args.length} numbers`);
        }
        x = rel ? x + (c.args[0] as number) : (c.args[0] as number);
        y = rel ? y + (c.args[1] as number) : (c.args[1] as number);
        cur = { points: [[x, y]], closed: false };
        subs.push(cur);
        // Coordinate pairs after the first are implicit linetos, per the SVG grammar.
        for (let i = 2; i < c.args.length; i += 2) {
          x = rel ? x + (c.args[i] as number) : (c.args[i] as number);
          y = rel ? y + (c.args[i + 1] as number) : (c.args[i + 1] as number);
          push().points.push([x, y]);
        }
        break;
      }
      case 'H': {
        if (c.args.length === 0) throw new Error(`${where}: H takes at least one number`);
        for (const a of c.args) {
          x = rel ? x + a : a;
          push().points.push([x, y]);
        }
        break;
      }
      case 'V': {
        if (c.args.length === 0) throw new Error(`${where}: V takes at least one number`);
        for (const a of c.args) {
          y = rel ? y + a : a;
          push().points.push([x, y]);
        }
        break;
      }
      case 'L': {
        if (c.args.length < 2 || c.args.length % 2 !== 0) {
          throw new Error(`${where}: L takes coordinate pairs, got ${c.args.length} numbers`);
        }
        for (let i = 0; i < c.args.length; i += 2) {
          x = rel ? x + (c.args[i] as number) : (c.args[i] as number);
          y = rel ? y + (c.args[i + 1] as number) : (c.args[i + 1] as number);
          push().points.push([x, y]);
        }
        break;
      }
      case 'Z': {
        const sub = push();
        sub.closed = true;
        const start = sub.points[0] as [number, number];
        x = start[0];
        y = start[1];
        break;
      }
      default:
        throw new Error(`${where}: unreachable command '${c.cmd}'`);
    }
  }
  return subs;
}

/* ------------------------------------------------------------------ *
 * The element scan
 * ------------------------------------------------------------------ */

interface DrawnPath {
  dataPart: string;
  d: string;
  fill: string | undefined;
  stroke: string | undefined;
  strokeWidth: number;
}

/**
 * Pull the `<path>` elements out in DOM order, which is paint order.
 *
 * Deliberately a narrow scan rather than a second XML parser: the dialect is enforced
 * BEFORE this runs by `lintDir`, which rejects non-self-closing paths, nested paths, any
 * non-path element and any malformed markup. Matching `<path ... />` here is the same
 * dialect `chrome/svgToElements.ts:parseIconParts` accepts, which is the narrower of the
 * two the tree has, so anything this scan drops has already failed the dialect gate.
 */
function drawnPaths(svgText: string, where: string): DrawnPath[] {
  const out: DrawnPath[] = [];
  for (const tag of svgText.matchAll(/<path\b[^>]*\/>/g)) {
    const text = tag[0];
    const attr = (name: string): string | undefined => {
      const m = new RegExp(`\\s${name}="([^"]*)"`).exec(text);
      return m === null ? undefined : (m[1] as string);
    };
    const d = attr('d');
    if (d === undefined) throw new Error(`${where}: a <path> has no d attribute`);
    const sw = attr('stroke-width');
    out.push({
      dataPart: attr('data-part') ?? '(unnamed)',
      d,
      fill: attr('fill'),
      stroke: attr('stroke'),
      strokeWidth: sw === undefined ? 1 : Number(sw),
    });
  }
  if (out.length === 0) throw new Error(`${where}: no <path> elements, this drawing paints nothing`);
  return out;
}

/* ------------------------------------------------------------------ *
 * The buffer
 * ------------------------------------------------------------------ */

/**
 * One painted unit cell: the colour that survives on it, and the index of the `<path>` that
 * painted it last.
 *
 * The path index is what R1 counts identity by (D-09). It is recorded at write time rather
 * than recovered later because `paint()` is the buffer's only writer and its outer loop is
 * already `for (const p of paths)` in DOM order, so the index is free where the colour is
 * decided and would cost a second full pass anywhere else.
 */
export interface Cell {
  colour: string;
  /** DOM order index of the painting path, 0-based. */
  path: number;
}

/**
 * A 32 by 32 unit buffer, one sample per unit cell taken at the cell CENTRE.
 * `null` means unpainted. Paint order is DOM order: later paths paint over earlier ones.
 */
type Buffer = (Cell | null)[];

const at = (buf: Buffer, x: number, y: number): Cell | null => buf[y * GRID + x] as Cell | null;

/** The resolved colour on a cell, or null where nothing is painted. */
const colourAt = (buf: Buffer, x: number, y: number): string | null => at(buf, x, y)?.colour ?? null;

/** Nonzero winding number of the subpath set at a point. Every subpath fills as closed. */
function windingAt(subs: readonly SubPath[], px: number, py: number): number {
  let w = 0;
  for (const sub of subs) {
    const pts = sub.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i] as [number, number];
      const b = pts[(i + 1) % pts.length] as [number, number];
      if (a[1] <= py) {
        if (b[1] > py && cross(a, b, px, py) > 0) w++;
      } else if (b[1] <= py && cross(a, b, px, py) < 0) w--;
    }
  }
  return w;
}

/** > 0 when (px,py) is left of the directed edge a->b. */
function cross(a: readonly [number, number], b: readonly [number, number], px: number, py: number): number {
  return (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]);
}

/** Squared distance from a point to a segment. */
function distToSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/**
 * Paint one drawing into a fresh buffer.
 *
 * STROKE RASTERISATION IS LOAD BEARING, not an optimisation. A `stroke-width="2"` path
 * lays a two-unit band of ink centred on its own path data, so a centreline at x=3 paints
 * units 2 and 3. Without it `logomark.svg` has almost no fill to measure, its R2 and R4
 * verdicts cannot be produced at all, and a candidate drawn with a stroked frame measures
 * as empty.
 *
 * THE BAND IS A CAPSULE: round caps and round joins, i.e. every unit whose centre lies
 * within half a stroke-width of the segment. That is one distance test with no join or
 * cap special-casing, and it is also the model that measures what a real renderer draws at
 * a corner. Butt caps leave a one-unit UNPAINTED speck where two strokes meet end to end,
 * which is exactly the RETIRED mark's two bevel strokes at (3,29) and (29,3), and R1 would
 * then count each speck as an extra shape. That would be a rasterisation artefact reported
 * as a craft defect, which is worse than useless.
 *
 * That example read "the shipped mark's" until plan 80-05 replaced the asset; it is now
 * `src/render/assets/__fixtures__/craft/retired-logomark-59.svg`, which is still measured
 * by `markCraft.test.ts` and so still exercises the capsule model. The shipped square's own
 * stake in this paragraph is its `cell` layer: `fill="none"` with a 2u stroke, which
 * measures as empty without stroke rasterisation.
 */
function paint(paths: readonly DrawnPath[], where: string): Buffer {
  const buf: Buffer = new Array<Cell | null>(GRID * GRID).fill(null);
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const p = paths[pathIndex] as DrawnPath;
    const subs = toSubPaths(parseCommands(p.d, `${where} data-part="${p.dataPart}"`), `${where} data-part="${p.dataPart}"`);
    const fill = resolvePaint(p.fill);
    const stroke = resolvePaint(p.stroke);
    // A path declaring NEITHER fill nor stroke renders as a solid black fill in Pixi and
    // as a solid black fill in every browser. The dialect's `explicit-paint` rule already
    // refuses it; if one ever reaches here it is painted, not skipped, because a silently
    // invisible layer is a false green.
    const implicitFill = p.fill === undefined && p.stroke === undefined ? (TOKENS.get('--fab-ink') ?? '#000000') : null;
    const fillColour = fill ?? implicitFill;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let colour: string | null = null;
        if (fillColour !== null && windingAt(subs, px, py) !== 0) colour = fillColour;
        if (stroke !== null && strokeCovers(subs, p.strokeWidth / 2, px, py)) colour = stroke;
        if (colour !== null) buf[y * GRID + x] = { colour, path: pathIndex };
      }
    }
  }
  return buf;
}

function strokeCovers(subs: readonly SubPath[], halfWidth: number, px: number, py: number): boolean {
  for (const sub of subs) {
    const pts = sub.points;
    const last = sub.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i] as [number, number];
      const b = pts[(i + 1) % pts.length] as [number, number];
      if (distToSegment(a[0], a[1], b[0], b[1], px, py) <= halfWidth) return true;
    }
    if (pts.length === 1) {
      const a = pts[0] as [number, number];
      if (Math.hypot(px - a[0], py - a[1]) <= halfWidth) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

interface Component {
  colour: string;
  /** Cell keys `y * GRID + x`, restricted to the live area. */
  cells: Set<number>;
}

const isInk = (c: string | null): boolean => c !== null && c !== VOID;

/**
 * Four-connected components of the painted buffer, counted PER PAINTING `<path>` and
 * restricted to the live area.
 *
 * SUPERSEDED ARGUMENT, KEPT SO THE REASON SURVIVES THE NEXT READER. Plan 79-01 wrote this
 * docblock as: components are "counted PER DISTINCT NON-VOID COLOUR ... Per-colour is
 * stated by the rule and it is load-bearing on the shipped mark: `--fab-edge-lit` and
 * `--fab-ink` both resolve to `#b0bacb`, so the bevel L and the two chevron marks are the
 * same ink, but they are separate connected components and R1 counts components. Delete the
 * per-colour split and the full-bleed tile swallows the count." The fear in that last
 * sentence is real and it is still answered; what was wrong was the identity it chose.
 * ("the shipped mark" in that quotation is the Phase 59 tile, retired by plan 80-05 and now
 * committed at `src/render/assets/__fixtures__/craft/retired-logomark-59.svg`. The shipped
 * mark carries no bevel and no chevron.)
 *
 * D-09 REPLACED COLOUR WITH THE PAINTING PATH. Per-path is the rule R1 always meant: a
 * shape is a thing an author drew, and an author draws with a `<path>`. Measured against
 * D-01's composition A, per-colour reported `FAIL 4 shapes` against a ceiling of three,
 * because the belt band, one `<path>` carrying a `--fab-panel-fill` interior and a
 * `--fab-ink` outline, counted as two. The maintainer was shown that filled band beside a hollow band
 * that passed as drawn, at 96, 32 and 16px, and chose the filled band: the artwork does not
 * bend to fit an instrument that is measuring the wrong thing. D-01's sentence "Fill and
 * stroke are one connected component" is true here rather than aspirational.
 *
 * THE COUNT MOVES ON TWO AXES, NOT ONE, WHICH IS WHY IT TAKES TWO FIXTURES.
 *   - Where a SINGLE path carries two colours, per-path is COARSER: a filled and stroked
 *     band was two components and is now one. That is D-09.
 *   - Where a colour is SHARED across paths, per-path is FINER: two touching same-colour
 *     paths were one component and are now two. That is what answers the superseded
 *     docblock's fear, and it is strictly stronger than the per-colour split was, because a
 *     full-bleed tile can no longer swallow a differently-drawn shape that happens to share
 *     its ink. On the RETIRED mark (this read "the shipped mark" until plan 80-05; the
 *     shipped square has neither a bevel nor a chevron) the bevel L and the two chevrons
 *     stay separate for the same reason they always did, now by their paths rather than by
 *     their colours.
 * Both directions are pinned in `render/assets/markCraft.test.ts`; either fixture alone
 * would let a wrong rule through, one that merged everything and one that split everything.
 *
 * `isInk` is unchanged and still tests the resolved COLOUR against VOID. Whether a cell is
 * ground is a question about its colour, not about which path painted it.
 */
function components(buf: Buffer): Component[] {
  const out: Component[] = [];
  const seen = new Set<number>();
  for (let y = LIVE_MIN; y < LIVE_MAX; y++) {
    for (let x = LIVE_MIN; x < LIVE_MAX; x++) {
      const key = y * GRID + x;
      const cell = at(buf, x, y);
      if (cell === null || !isInk(cell.colour) || seen.has(key)) continue;
      const path = cell.path;
      const cells = new Set<number>();
      const stack = [[x, y] as [number, number]];
      seen.add(key);
      cells.add(key);
      while (stack.length > 0) {
        const [cx, cy] = stack.pop() as [number, number];
        for (const [nx, ny] of [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ] as [number, number][]) {
          if (nx < LIVE_MIN || nx >= LIVE_MAX || ny < LIVE_MIN || ny >= LIVE_MAX) continue;
          const nkey = ny * GRID + nx;
          if (seen.has(nkey)) continue;
          const n = at(buf, nx, ny);
          // The identity test, and the only line D-09 moved. A neighbour joins this
          // component when the SAME path painted it, whatever colour it carries. A VOID
          // neighbour is ground and joins nothing, whichever path painted it.
          if (n === null || n.path !== path || !isInk(n.colour)) continue;
          seen.add(nkey);
          cells.add(nkey);
          stack.push([nx, ny]);
        }
      }
      out.push({ colour: cell.colour, cells });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The four rules
 * ------------------------------------------------------------------ */

function verdict(kind: VerdictKind, value: number | null, unit: 'u' | 'shapes' | null, why: string): Verdict {
  const text =
    kind === 'NA'
      ? 'n/a'
      : kind === 'OVERLAP'
        ? 'OVERLAP'
        : unit === 'shapes'
          ? `${kind} ${value} shapes`
          : `${kind} ${value}u`;
  return { kind, value, unit, text, why };
}

/** R1 shapes, at most 3. A 16px rule, so a full cut reports INFO rather than a verdict. */
function ruleR1(comps: readonly Component[], serves: 16 | null): Verdict {
  const n = comps.length;
  if (serves === null) return verdict('INFO', n, 'shapes', 'full cut, the shape ceiling is a 16px rule');
  if (n <= MAX_SHAPES) return verdict('PASS', n, 'shapes', '');
  return verdict('FAIL', n, 'shapes', `${n} shapes in the live area, ceiling ${MAX_SHAPES}`);
}

/**
 * R2 axis stroke, at least 2u: the minimum length of any maximal INK run along any row or
 * column, where ink is every non-void unit taken together.
 *
 * MERGED, NOT PER COLOUR, AND THIS IS THE ONE PLACE THE MEASUREMENT DISAGREES WITH THE
 * PINNED NUMBER IN `79-UI-SPEC.md`. The rule's own text says "any maximal ink run", and
 * the buffer rule directly above it defines ink as every unit that is not the ground.
 * R1's text says "per distinct non-void colour" where it means per colour; R2's does not.
 * Merged is therefore the faithful reading, and it is also the only one that survives the
 * other pinned rows: on `b-the-turn-16.svg` the amber item sits ON the band, so a
 * per-colour reading would cut the band into a 2u stub and read FAIL 2u where the contract
 * pins PASS 8u. The band is 8u thick; an item painted on top of it does not make it thin.
 * What R2 measures is the SILHOUETTE's minimum feature width, which is what a reader
 * actually sees at 16px.
 *
 * On the RETIRED mark that gives PASS 26u where `79-UI-SPEC.md:427` pins PASS 2u, and the
 * spec's number is the side that is wrong: it was computed from the bevel band in
 * isolation, which is not what a silhouette rule measures. The retired mark's silhouette
 * IS a solid square (its alpha extract is white everywhere, measured in `79-RESEARCH.md`
 * section 6), so it genuinely passes an axis-stroke rule while failing three others.
 *
 * This paragraph read "the shipped mark" until plan 80-05 replaced the asset. The 26u
 * belongs to `src/render/assets/__fixtures__/craft/retired-logomark-59.svg`, which is where
 * `markCraft.test.ts` measures it. The SHIPPED mark measures PASS 2u on this rule. The
 * retired row's mix of pass and fail is the anti-vacuity device and it is untouched, but it
 * is now held by a MEASUREMENT over that fixture rather than by a pinned shipped row.
 * Recorded in `79-01-SUMMARY.md` and re-anchored in `80-05-SUMMARY.md`.
 */
function ruleR2(buf: Buffer): Verdict {
  let min = Number.POSITIVE_INFINITY;
  const scan = (get: (i: number) => string | null): void => {
    let run = 0;
    for (let i = LIVE_MIN; i <= LIVE_MAX; i++) {
      const ink = i < LIVE_MAX && isInk(get(i));
      if (ink) {
        run++;
      } else {
        if (run > 0 && run < min) min = run;
        run = 0;
      }
    }
  };
  for (let y = LIVE_MIN; y < LIVE_MAX; y++) scan((x) => colourAt(buf, x, y));
  for (let x = LIVE_MIN; x < LIVE_MAX; x++) scan((y) => colourAt(buf, x, y));
  if (!Number.isFinite(min)) {
    // No ink anywhere in the live area. Never a pass: a drawing with nothing inside the
    // 16px window has failed the rule as hard as it is possible to fail it.
    return verdict('FAIL', 0, 'u', 'no ink in the live area, units 2 to 30');
  }
  if (min >= MIN_AXIS_STROKE) return verdict('PASS', min, 'u', '');
  return verdict('FAIL', min, 'u', `thinnest axis run ${min}u, minimum ${MIN_AXIS_STROKE}u`);
}

/**
 * R3 diagonal stroke, at least 4u: the stroke-width of any path holding an `L` segment
 * where BOTH coordinates change.
 *
 * A diagonal drawn at the same weight as an axis-aligned stroke reads thinner, because it
 * covers fewer whole device pixels per unit of length. The RETIRED mark's chevron arms are
 * true 45-degree diagonals at `stroke-width="2"`, which is the FAIL 2u this rule reports on
 * `src/render/assets/__fixtures__/craft/retired-logomark-59.svg`. This sentence read "the
 * shipped mark's" until plan 80-05: composition A carries no diagonal at all and every cut
 * in the pin, shipped included, now reports `n/a` on R3. That is IN-07 in `80-REVIEW.md` and
 * it is why `npm run check:mark-craft` alone can no longer discriminate this rule; the
 * three-point fixture at `markCraft.test.ts` (0u / 2u / 4u) is what does.
 *
 * A path carrying a diagonal that is FILLED and not stroked reports FAIL 0u rather than
 * n/a. It has no stroke-width to measure, and reporting n/a would be the permissive
 * choice: it would let a drawing carry an unmeasurable diagonal and still print a clean
 * row. No candidate in this phase has one; the case is written down rather than left to be
 * invented at the keyboard.
 */
function ruleR3(paths: readonly DrawnPath[], where: string): Verdict {
  let min: number | null = null;
  for (const p of paths) {
    const subs = toSubPaths(parseCommands(p.d, where), where);
    let diagonal = false;
    for (const sub of subs) {
      const pts = sub.points;
      const last = sub.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < last; i++) {
        const a = pts[i] as [number, number];
        const b = pts[(i + 1) % pts.length] as [number, number];
        if (a[0] !== b[0] && a[1] !== b[1]) diagonal = true;
      }
    }
    if (!diagonal) continue;
    const w = resolvePaint(p.stroke) === null ? 0 : p.strokeWidth;
    if (min === null || w < min) min = w;
  }
  if (min === null) return verdict('NA', null, null, 'no diagonal segment in this cut');
  if (min >= MIN_DIAGONAL_STROKE) return verdict('PASS', min, 'u', '');
  return verdict('FAIL', min, 'u', `diagonal weight ${min}u, minimum ${MIN_DIAGONAL_STROKE}u`);
}

/** The gap between two components along one scanline, or null when they share no scanline. */
function pairGap(a: Component, b: Component): number | null {
  let min: number | null = null;
  const scan = (key: (i: number) => number): void => {
    const marks: ('a' | 'b')[] = [];
    const idx: number[] = [];
    for (let i = LIVE_MIN; i < LIVE_MAX; i++) {
      const k = key(i);
      if (a.cells.has(k)) {
        marks.push('a');
        idx.push(i);
      } else if (b.cells.has(k)) {
        marks.push('b');
        idx.push(i);
      }
    }
    for (let i = 1; i < marks.length; i++) {
      if (marks[i] === marks[i - 1]) continue;
      const gap = (idx[i] as number) - (idx[i - 1] as number) - 1;
      if (min === null || gap < min) min = gap;
    }
  };
  for (let y = LIVE_MIN; y < LIVE_MAX; y++) scan((x) => y * GRID + x);
  for (let x = LIVE_MIN; x < LIVE_MAX; x++) scan((y) => y * GRID + x);
  return min;
}

/**
 * R4 gap, at least 2u: for every pair of distinct components, the minimum count of units
 * belonging to NEITHER, along any row or column.
 *
 * THE CASE THAT DECIDES WHETHER THIS RULE IS REAL. A pair sharing no row and no column
 * (Candidate C's first cell against its sink, which are diagonal neighbours) has no
 * measurable gap along a scanline. It is `n/a` and it is SKIPPED, never counted as a pass.
 * Inventing PASS here would turn R4 into a rule that quietly passes any sufficiently
 * scattered mark, which is the single most likely way this instrument becomes permissive.
 * A cut where EVERY pair is n/a therefore reports n/a and never PASS.
 *
 * `OVERLAP` is its own verdict and is never rendered as a pass. It is how the sheet says
 * that two shapes are one shape once the accent is gone. A gap of zero along a scanline is
 * the same fact as two components touching, so the two are one measurement here rather
 * than two. When a cut has BOTH touching pairs and separated pairs, the cell carries the
 * numeric verdict and the overlap is reported in the `why` clause, because
 * `ExpectationRow` is four verdict strings and an annotation does not belong in one.
 */
function ruleR4(comps: readonly Component[]): Verdict {
  let min: number | null = null;
  let overlaps = 0;
  let measurable = 0;
  let na = 0;
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const gap = pairGap(comps[i] as Component, comps[j] as Component);
      if (gap === null) {
        na++;
        continue;
      }
      if (gap === 0) {
        overlaps++;
        continue;
      }
      measurable++;
      if (min === null || gap < min) min = gap;
    }
  }
  const note = overlaps > 0 ? `${overlaps} pair(s) touch` : '';
  if (measurable === 0) {
    if (overlaps > 0) return verdict('OVERLAP', null, null, note);
    return verdict('NA', null, null, na > 0 ? 'no pair shares a row or a column' : 'fewer than two shapes');
  }
  const value = min as number;
  if (value >= MIN_GAP) {
    return verdict('PASS', value, 'u', note);
  }
  return verdict(
    'FAIL',
    value,
    'u',
    `closest gap ${value}u, minimum ${MIN_GAP}u${note === '' ? '' : `, ${note}`}`,
  );
}

/* ------------------------------------------------------------------ *
 * Measuring
 * ------------------------------------------------------------------ */

/**
 * The RAW PAINTED BUFFER for one drawing: one entry per unit cell of the 32 by 32 author
 * box in row-major order (`y * GRID + x`), `null` where no path painted that cell.
 *
 * WHAT THIS IS FOR, AND WHY IT IS NOT `isInk`. MARK-11 asks a question about OPACITY: does
 * the mark have a real hole a background shows through, and does its silhouette survive a
 * circular crop. That is answered by whether a cell was PAINTED AT ALL, never by which
 * colour landed on it. `isInk` deliberately answers the other question - it treats a cell
 * resolving to the substrate colour as void, which is what makes the retired mark measure
 * five shapes rather than seven - and reusing it here would report holes where the rendered
 * file has none: `rsvg-convert` writes alpha 255 over a substrate-coloured cell and a
 * circular crop keeps it. The two questions must not be confused, so this accessor returns
 * the buffer and the arithmetic stays with the caller that knows which question it is
 * asking. Its reader is `render/assets/markErasure.test.ts`.
 *
 * NO `serves` ARGUMENT. The size row a cut serves changes the R1 verdict TEXT and nothing
 * whatever about the buffer, so accepting one would be a parameter that cannot affect the
 * return value. `measureAll()` likewise still takes NO argument (T-79-01): reaching a
 * fixture through the walker is the shape that would let a renamed directory agree with
 * itself, and this accessor takes an absolute path precisely so it never needs to.
 */
export function paintedCells(absPath: string): readonly (Cell | null)[] {
  const file = basename(absPath);
  return paint(drawnPaths(readFileSync(absPath, 'utf8'), file), file);
}

export function measureCut(absPath: string, serves: 16 | null): CutMeasurement {
  const file = basename(absPath);
  const text = readFileSync(absPath, 'utf8');
  const paths = drawnPaths(text, file);
  const buf = paint(paths, file);
  const comps = components(buf);
  return {
    file,
    serves,
    r1: ruleR1(comps, serves),
    r2: ruleR2(buf),
    r3: ruleR3(paths, file),
    r4: ruleR4(comps),
  };
}

/**
 * Which size row a cut serves, from its filename.
 *
 * A file named `*-full.svg` is the full cut that serves 32px and 96px, and its shape count
 * is reported INFO because the three-shape ceiling is a 16px rule. Everything else serves
 * the 16px row, including Candidate D, which serves all three sizes from one drawing.
 */
export function servesOf(fileName: string): 16 | null {
  return /-full\.svg$/.test(fileName) ? null : 16;
}

/** Every `.svg` in the candidates directory, sorted. Flat and non-recursive, as the lint is. */
export function candidateFiles(): string[] {
  return readdirSync(CANDIDATES_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.svg'))
    .map((e) => e.name)
    .sort();
}

/** The shipped mark plus every `.svg` discovered in CANDIDATES_DIR, sorted by filename. */
export function measureAll(): CutMeasurement[] {
  const cuts: CutMeasurement[] = [measureCut(SHIPPED_MARK, 16)];
  for (const name of candidateFiles()) {
    cuts.push(measureCut(join(CANDIDATES_DIR, name), servesOf(name)));
  }
  return cuts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/* ------------------------------------------------------------------ *
 * The anti-vacuity pin
 * ------------------------------------------------------------------ */

export function loadExpectations(): Record<string, ExpectationRow> {
  return JSON.parse(readFileSync(EXPECTATIONS_FILE, 'utf8')) as Record<string, ExpectationRow>;
}

const RULE_KEYS: readonly ('r1' | 'r2' | 'r3' | 'r4')[] = ['r1', 'r2', 'r3', 'r4'];

/**
 * Compare every measurement against the pin, in BOTH directions.
 *
 * A discovered input with no pinned row and a pinned row with no discovered input are both
 * mismatches, not silences. A script pointed at a renamed directory that agrees with
 * itself is the failure this whole device exists to prevent (threat T-79-04).
 */
export function diffAgainstExpectations(measured: readonly CutMeasurement[]): Mismatch[] {
  const expected = loadExpectations();
  const out: Mismatch[] = [];
  const seen = new Set<string>();
  for (const cut of measured) {
    seen.add(cut.file);
    const row = expected[cut.file];
    for (const rule of RULE_KEYS) {
      const got = cut[rule].text;
      if (row === undefined) {
        out.push({ input: cut.file, rule, measured: got, expected: '(no row in mark-craft.expected.json)' });
      } else if (row[rule] !== got) {
        out.push({ input: cut.file, rule, measured: got, expected: String(row[rule]) });
      }
    }
  }
  for (const key of Object.keys(expected).sort()) {
    if (seen.has(key)) continue;
    for (const rule of RULE_KEYS) {
      out.push({
        input: key,
        rule,
        measured: '(input not discovered)',
        expected: String((expected[key] as ExpectationRow)[rule]),
      });
    }
  }
  return out;
}

export function formatMismatch(m: Mismatch): string {
  return `${m.input} rule ${m.rule.toUpperCase()} measured ${m.measured}, expected ${m.expected}`;
}

/* ------------------------------------------------------------------ *
 * Rendering the table
 * ------------------------------------------------------------------ */

const HEADERS = ['file', 'R1 shapes', 'R2 axis', 'R3 diagonal', 'R4 gap'] as const;

/**
 * One row per input, sorted by filename, the BARE filename first and then the four verdict
 * cells in R1 R2 R3 R4 order. Nothing here prints an absolute path: `displayPath` in
 * `lint-svg.ts` already degrades to the bare filename outside `src/`, and this table names
 * cuts the same way, which keeps an absolute path out of a CI log (threat T-79-03).
 *
 * The `why` clauses print on their own indented lines beneath the table, following the
 * two-line violation grammar `formatViolation` already uses, so the verdict columns stay a
 * clean greppable block.
 */
export function formatTable(cuts: readonly CutMeasurement[]): string {
  const rows = cuts.map((c) => [c.file, c.r1.text, c.r2.text, c.r3.text, c.r4.text]);
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ').trimEnd();
  const out: string[] = [line(HEADERS), ...rows.map(line)];
  for (const c of cuts) {
    for (const rule of RULE_KEYS) {
      const v = c[rule];
      if (v.why !== '') out.push(`  ${c.file}  ${rule.toUpperCase()}: ${v.why}`);
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * The CLI caller
 * ------------------------------------------------------------------ */

/**
 * Run every gate and every measurement, and return the exact bytes the CLI prints so the
 * vitest caller can assert them.
 *
 * The gates run BEFORE the measurements and in this order: the chrome-asset dialect over
 * the candidates directory, then XML comment legality over the same files. Both are held
 * to `report()`'s zero-asset vacuity refusal, which names the directory that walked to
 * nothing and refuses to print a vacuous pass. That refusal is inherited rather than
 * reimplemented, which is the whole reason this module imports `report` at all.
 */
export function run(): { text: string; failed: boolean } {
  const lines: string[] = [];
  let failed = false;

  const dialect = report(lintDir(CANDIDATES_DIR, { chromeInk: true }));
  lines.push(dialect.text.split('\n').map((l) => l.replace(/^lint:svg/, 'mark-craft')).join('\n'));
  if (dialect.failed) failed = true;

  for (const name of candidateFiles()) {
    const line = illegalCommentLine(readFileSync(join(CANDIDATES_DIR, name), 'utf8'));
    if (line === null) continue;
    failed = true;
    lines.push(
      `${name}:${line}  an XML comment carries a double hyphen or is unterminated\n` +
        '  A double hyphen is illegal inside an XML comment and every strict parser refuses the whole ' +
        'document. Name paint tokens without their leading dashes, as fab-accent-item.',
    );
  }

  let cuts: CutMeasurement[];
  try {
    cuts = measureAll();
  } catch (err) {
    // A PARSE FAILURE IS A NAMED ROW, NEVER A STACK TRACE (threat T-79-02). A file that
    // silently fails to measure and is then reported clean is the false green this
    // instrument exists to make impossible.
    lines.push(`mark-craft  a drawing could not be measured: ${(err as Error).message}`);
    return { text: lines.join('\n'), failed: true };
  }

  lines.push('', formatTable(cuts), '');

  const expected = loadExpectations();
  if (Object.keys(expected).length === 0) {
    lines.push('mark-craft  mark-craft.expected.json is empty, refusing to report a vacuous pass');
    failed = true;
  }
  const mismatches = diffAgainstExpectations(cuts);
  for (const m of mismatches) lines.push(formatMismatch(m));
  if (mismatches.length > 0) failed = true;

  lines.push(
    mismatches.length === 0
      ? `mark-craft  ${cuts.length} cuts measured, ${Object.keys(expected).length} pinned, 0 mismatches`
      : `mark-craft  ${cuts.length} cuts measured, ${mismatches.length} mismatches against mark-craft.expected.json`,
  );
  return { text: lines.join('\n'), failed };
}

// `import.meta.main` is true only under bare `node scripts/mark-craft.ts`; under Vite and
// vitest it is undefined, so importing this module never runs the CLI or exits the
// process. Deliberately NOT an argv comparison: this walker reads no argv at all.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  const { text, failed } = run();
  process.stdout.write(`${text}\n`);
  if (failed) process.exitCode = 1;
}
