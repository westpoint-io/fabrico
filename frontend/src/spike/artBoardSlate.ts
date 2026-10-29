// The art board's slate: the primary comparison surface (BOARD-01, plans 57-01/57-06).
//
// 27 rows x 5 columns = 135 cells. One block per subject, three rows per block (one
// per zoom), five cells per row (one per direction). Plan 57-01 shipped this loop with
// three one-element slices; plan 57-06 widened those slices to the full constants and
// added the TODAY path, the labelled states and the measured-cost table. The loop
// itself is unchanged.
//
// THE RENDER PATH IS THE REAL ONE (57-CONTEXT.md D-06), and it is the real one PER
// COLUMN, which is the one place this board is deliberately not uniform:
//   - A..D are real .svg files on disk, parsed by Pixi's own SVGParser through
//     `new GraphicsContext().svg(text)` and drawn by `new Graphics(ctx)` at the row's
//     real zoom. Inline DOM SVG is rejected outright: it would mean judging a renderer
//     the game does not use.
//   - TODAY is the shipped pixel bake - `makeGenerators(LOCKED_SKIN)` -> `PixelMatrix`
//     -> `matrixToTexture` (scaleMode 'nearest') -> a Pixi `Sprite` at the row's zoom.
//     NOT an `<img image-rendering: pixelated>`: the shipped app draws these as
//     nearest-sampled Sprites, so that is what degradation at 1.77x actually looks
//     like, and running TODAY through a different resampler would either flatter it or
//     slander it. The 1.77x delta is this milestone's central visual claim, so it has
//     to be produced by the shipped resampler or it is not evidence.
// Both paths end in the SAME `extractCell` contract (explicit frame, explicit
// clearColor, resolution 1), so all 135 cells are byte-comparable to each other.
//
// NEUTRALITY IS A RENDERING PROPERTY HERE, not a matter of wording (57-UI-SPEC Part C).
// Every cell box is the same size, on the same substrate, with the same padding, in
// the same ink, and the reserved note strip below the artwork exists in EVERY cell
// whether or not that cell has a note - because a cell that grew to fit its label
// would be a direction given more space, which is advocacy delivered by the layout.
//
// This module is never imported outside src/spike/ and exports nothing to the app.

import { Container, Graphics, GraphicsContext, Sprite, type Texture } from 'pixi.js';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';
import { makeGenerators, type GenKey, type GeneratorSet } from '../render/synth/generators.ts';
import { matrixToTexture } from '../render/synth/textureCache.ts';
import { inletGlyphRects } from '../render/layers/inletGlyph.ts';
import { PORT_ROLE } from '../protocol/ports.ts';
import { state_tag } from '../protocol/kinds.ts';
import { classifyVertexCount, measureContext } from '../render/svgAssets.ts';
import {
  CELL_U,
  CELL_BOX_W,
  DIRECTIONS,
  SUBJECTS,
  ZOOMS,
  candidateDirections,
  cellBox,
  hex,
  ink,
  rule,
  substrate,
  type Direction,
  type ExtractCellOptions,
  type Subject,
} from './artBoard.ts';

/** What the slate needs from the board shell. Nothing else crosses the seam. */
export interface SlateDeps {
  /** The one extraction contract (frame + clearColor + resolution), from artBoard.ts. */
  readonly extractCell: (options: ExtractCellOptions) => HTMLCanvasElement;
  /** Raw SVG text for one (direction, subject) draft, or undefined when unauthored. */
  readonly candidateSvg: (direction: Direction, subject: string) => string | undefined;
}

/* ------------------------------------------------------------------ *
 * The slices - the ONE thing plan 06 widened
 * ------------------------------------------------------------------ */

/**
 * The three slate slices, now the full constants.
 *
 * THEY ARE STILL FUNCTIONS, NOT MODULE-LEVEL CONSTS, and that is not style.
 * artBoard.ts and this module form a deliberate import cycle: the shell owns the
 * constants and calls buildSlate, the slate reads those constants back. ESM resolves
 * the cycle by handing this module a live-but-partially-initialised namespace, so a
 * TOP-LEVEL read of `SUBJECTS` here evaluates while artBoard.ts is still executing its
 * own body and throws `ReferenceError: Cannot access 'SUBJECTS' before initialization`
 * - observed in plan 57-01, not theorised. Evaluating inside buildSlate() defers every
 * read past the point where the shell has finished initialising, which it always has:
 * buildSlate is only ever called from inside the single async boot().
 *
 * They return the consts BY REFERENCE rather than through a copy or a filter, so there
 * is exactly one declaration of column order on the whole board (N1). A `.filter()` or
 * a `.sort()` here would be a second, drift-prone source of truth for the axis the
 * board is comparing along.
 */
const slateSubjects = (): readonly Subject[] => SUBJECTS;
const slateZooms = (): readonly number[] => ZOOMS;
const slateDirections = (): readonly Direction[] => DIRECTIONS;

/* ------------------------------------------------------------------ *
 * Layout constants (57-UI-SPEC B.1, Spacing Scale)
 * ------------------------------------------------------------------ */

/**
 * The reserved note strip below the artwork, in EVERY cell of EVERY row.
 *
 * WHAT BREAKS IF THIS MOVES: it is what makes a labelled cell exactly as tall as an
 * unlabelled one. Only three of the 135 cells (TODAY x ENDPOINT, at each zoom) and the
 * fifteen BELT cells carry a note today, so without a reserved strip those rows would
 * have one taller column and the cell-geometry assertion (N2/N7) would redden - or
 * worse, would not, and a direction would silently be given more space than its
 * neighbours. 96px holds the longest note in the Copywriting Contract (the endpoint
 * line, ~143 chars, which wraps to five lines at 11px in the 192px content width).
 */
const NOTE_H = 96;

/** The row-label gutter (57-UI-SPEC B.1: 120px, sticky horizontally). */
const GUTTER_W = 120;

/** The fixed column-header height. Identical in all five columns - see NOTE_H. */
const HEADER_H = 132;

/**
 * The muted ink (ramp[3]) for notes and units. There is no third ink (Typography).
 *
 * A FUNCTION, not a const, for the same import-cycle reason the slices are: `hex` is
 * declared in artBoard.ts, which is mid-body when this module first evaluates, so a
 * top-level call throws `ReferenceError: Cannot access 'hex' before initialization`
 * and the board never boots. Observed twice now (57-01 on SUBJECTS, 57-06 on hex) -
 * every read of an artBoard.ts binding from this module happens inside a function.
 */
export const inkMuted = (): string => hex(LOCKED_SKIN.palette.ramp[3] as number);

/* ------------------------------------------------------------------ *
 * Copy - every string pre-checked against D-14's five banned tokens
 * ------------------------------------------------------------------ */

/**
 * One sentence per column, and the LENGTH IS A CONTRACT: each of the four candidate
 * descriptions is 80-120 characters (N9), asserted by the board spec.
 *
 * Unequal description length is itself a form of advocacy - a column that got three
 * sentences of explanation while its neighbour got a clause has been argued for. The
 * TODAY line is exempt from the band because it is a reference rather than a
 * candidate, but it is still one sentence.
 *
 * These describe CONSTRUCTION, never quality. D-02's own prose calls A "the most
 * coherent" and B "typically strongest"; those are the planner's words to a reader of
 * the decision record, and repeating them on the instrument would be the board making
 * the argument it exists to let a human make.
 */
const DIRECTION_DESCRIPTIONS: Readonly<Record<Direction, string>> = {
  TODAY: 'What ships now: the baked pixel matrix, nearest-sampled, drawn at the row zoom.',
  A: 'Open chassis carried by a 3u outline with minimal fill, continuing the locked belt line.',
  B: 'Filled chassis plate under a 3u dark outline, with a 2u glyph knocked out of the body.',
  C: "The silhouette itself differs per kind, drawn on Direction B's paint system unchanged.",
  D: 'Line only, with no filled path anywhere: schematic traces and a terminal pin at each port.',
};

/**
 * The slate's own standing lines, rendered above the column headers.
 *
 * D-04 requires the board to SAY that column order carries no meaning rather than
 * leave a reader to infer it from position; the shell's BOARD_HEADER says it once for
 * the page and these say it where the columns actually are. The zoom line is the same
 * obligation for the vertical axis.
 */
const SLATE_NOTES: readonly string[] = [
  'Column order is the registry order - the reference column first, then alphabetical - and it carries no ranking meaning.',
  'TODAY is a reference column showing what ships now. It is not a candidate and it is not in the cost table below.',
  'Zoom rows run 1.00x, 1.77x, 2.00x, ascending. That order carries no ranking meaning either.',
];

/** 57-UI-SPEC Copywriting Contract - the BELT row label (A.4). */
const BELT_NOTE =
  'locked by 53-BELT-LOCK.md (Direction B) - identical in every column, not a candidate';

/** 57-UI-SPEC Copywriting Contract - the legitimately-absent TODAY x ENDPOINT cell (A.5). */
const ENDPOINT_NOTE =
  'no shipped chassis art exists for the endpoint; this is the wire-terminal inlet glyph (inletGlyph.ts), the only endpoint visual that ships';

/* ------------------------------------------------------------------ *
 * The TODAY column: the shipped pixel bake
 * ------------------------------------------------------------------ */

/**
 * Subject id -> generator key, as a LITERAL mirror of `layers/machines.ts` GEN_KEY_OF.
 *
 * Mirrored, never imported, for the `EXPECTED_FIXTURE_COUNT` reason: a table derived
 * from the source it checks cannot disagree with it. GEN_KEY_OF holds exactly EIGHT
 * entries - there is no `ENDPOINT` and no `WIRE` - and `machines.ts:204` skips any
 * kind absent from it rather than indexing the generator table with `undefined`
 * (which threw `generators[undefined] is not a function` every frame once a real
 * Endpoint node reached the packet). The board reproduces that fact rather than
 * papering over it: TODAY x ENDPOINT is a labelled-absent cell, not a blank one.
 */
const GEN_KEY_OF_SUBJECT: Readonly<Record<string, GenKey>> = {
  SOURCE: 'source',
  BELT: 'belt',
  FACTORY: 'factory',
  TEE: 'tee',
  BALANCER: 'balancer',
  ROUTER: 'router',
  MERGE: 'merge',
  SINK: 'sink',
};

/**
 * The shipped generator set, built once. `nativeCell` is CELL_U (32) because the board
 * renders every subject at its true base footprint on the 32-unit module.
 *
 * Lazy for the same import-cycle reason the slices are (CELL_U is read from the shell).
 */
let generators: GeneratorSet | null = null;
const genSet = (): GeneratorSet => {
  generators ??= makeGenerators(LOCKED_SKIN, CELL_U);
  return generators;
};

/**
 * subject id -> the ONE baked texture for that subject's TODAY sprite.
 *
 * One bake per subject, shared across all three zoom rows: the shipped renderer bakes
 * once and blits many (SYNTH-02), and re-baking per zoom would be a different pipeline
 * from the one being judged. `extractCell` destroys the holder Container and its
 * children; a Pixi v8 `Sprite.destroy({children: true})` does NOT destroy its texture
 * (options.texture is undefined), so these survive every cell.
 */
const TODAY_TEXTURES = new Map<string, Texture>();

function todayTexture(subject: Subject, key: GenKey): Texture {
  const cached = TODAY_TEXTURES.get(subject.id);
  if (cached !== undefined) return cached;
  // IDLE / frame 0: the resting state, the same one the pixel baselines hold. A
  // WORKING or FAULTED bake would put an accent colour in the TODAY column only.
  const matrix = genSet()[key](state_tag.IDLE, 0, subject.w, subject.h);
  const texture = matrixToTexture(matrix);
  TODAY_TEXTURES.set(subject.id, texture);
  return texture;
}

/* ------------------------------------------------------------------ *
 * The candidate columns: one shared GraphicsContext per (subject, direction)
 * ------------------------------------------------------------------ */

/** A parsed candidate: its shared context plus the measurement the cost table prints. */
interface Candidate {
  readonly ctx: GraphicsContext;
  readonly vertexCount: number;
  readonly pointCount: number;
}

/**
 * (subject, direction) -> the ONE shared GraphicsContext for that draft, plus its
 * measurement. 45 contexts, never 135 tessellations.
 *
 * Pixi v8 caches TESSELLATED GEOMETRY on the GraphicsContext, and `new Graphics(ctx)`
 * SHARES that context rather than re-parsing. So one context drawn at three zooms is
 * ONE tessellation at three transforms, which is precisely the property (VEC-04) that
 * keeps a zoomed asset crisp instead of re-tessellated - and it is also what keeps
 * every draft inside Pixi's 400-vertex batching cliff, since `isBatchable` is a
 * property of the CONTEXT, not of each Graphics.
 *
 * Never evicted and never destroyed while the board lives.
 */
const CONTEXTS = new Map<string, Candidate>();

/** A parse or tessellation failure, carried as a value - never thrown. */
interface CandidateFailure {
  readonly reason: string;
}

const candidateKey = (subjectId: string, direction: Direction): string =>
  `${subjectId}/${direction}`;

/**
 * Parse and measure one candidate, memoised.
 *
 * NOTHING HERE THROWS. A throw on the board blanks the whole page, and a blank page is
 * the worst possible outcome for an instrument whose job is to show what is missing: a
 * single malformed draft would take all 135 cells with it and the failure would read as
 * "the board is broken" rather than "this file did not parse".
 */
function sharedCandidate(
  subjectId: string,
  direction: Direction,
  svgText: string,
): Candidate | CandidateFailure {
  const key = candidateKey(subjectId, direction);
  const cached = CONTEXTS.get(key);
  if (cached !== undefined) return cached;
  let ctx: GraphicsContext;
  try {
    ctx = new GraphicsContext().svg(svgText);
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
  const measured = measureContext(ctx);
  const candidate: Candidate = {
    ctx,
    vertexCount: measured.vertexCount,
    pointCount: measured.pointCount,
  };
  CONTEXTS.set(key, candidate);
  return candidate;
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

/** The zoom label and the `data-zoom` value - one formatter, so they cannot drift. */
const zoomLabel = (zoom: number): string => zoom.toFixed(2);

/** The subject's pixel size at a zoom - the SAME arithmetic extractCell's frame uses. */
const pxAt = (units: number, zoom: number): number => Math.ceil(units * CELL_U * zoom);

/**
 * One line of text in the board's ink.
 *
 * Typography contract: label 11px/600, body 13px/400, one family, two inks. There is
 * no emphasis tier, because emphasis on a comparison board is advocacy (N6).
 *
 * EXPORTED for artBoardPanel.ts (plan 57-07) rather than copied into it. A second
 * typography helper is a second Typography contract, and two of them drift - the same
 * one-declaration rule that keeps `DIRECTIONS` in exactly one place.
 */
export function textLine(text: string, size: 11 | 13, weight: 400 | 600, colour: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.color = colour;
  el.style.font = `${weight} ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  el.style.lineHeight = '1.5';
  return el;
}

/**
 * The note strip that exists in EVERY cell, carrying zero or more lines.
 *
 * Fixed height in every cell of every row - see NOTE_H. `text-align: left` because a
 * centred five-line paragraph is harder to read than a ragged-right one, and the
 * alignment is identical in all five columns so it cannot favour a column.
 *
 * `white-space: normal` IS LOAD-BEARING AND MUST NOT BE DROPPED. The slate row is
 * `nowrap` (see buildSlate) so that its five inline-block cells stay on one line, and
 * that declaration INHERITS all the way down into this strip. Unset, the notes render
 * as one unbroken line 554-911px wide inside a 192px `overflow: visible` box and paint
 * straight across the following columns' text - measured, 18 of these strips did
 * exactly that. It also contradicted NOTE_H's own docblock, which reserves 96px on the
 * stated basis that the longest note "wraps to five lines". Re-declaring it here (as
 * `renderSlateErrorCell` and the lane strip already do) confines `nowrap` to the row
 * that needs it. Gated by the text-extent assertion in `e2e/art-board.spec.ts`.
 */
function noteStrip(lines: readonly string[]): HTMLDivElement {
  const strip = document.createElement('div');
  strip.style.height = `${NOTE_H}px`;
  strip.style.marginTop = '8px';
  strip.style.textAlign = 'left';
  strip.style.lineHeight = '1.5';
  strip.style.whiteSpace = 'normal';
  for (const line of lines) strip.appendChild(textLine(line, 11, 400, inkMuted()));
  return strip;
}

/* ------------------------------------------------------------------ *
 * The ONE per-subject render path, shared by the slate and the channel panel
 * ------------------------------------------------------------------ */

/**
 * What one (subject, direction, zoom) resolves to: a display object ready to extract,
 * or a LABELLED reason why there is nothing to draw.
 *
 * A VALUE, never a throw and never a direct DOM write, because plan 57-07's channel
 * panel composites NINE of these into a single cell and cannot have each of them
 * reaching into a box element on its own. The slate writes the attributes; the panel
 * aggregates the failures across its nine slots and writes one label. Both read the
 * same resolution, so there is exactly one place that decides what a column renders.
 */
export interface SubjectRender {
  /** The scaled display object, ready for `extractCell`, or null when nothing drew. */
  readonly node: Container | null;
  /** The `data-absent` value this cell must carry, or null. */
  readonly absent: string | null;
  /** The `data-error` value this cell must carry, or null. */
  readonly error: string | null;
  /** Visible note lines. Never empty when `absent` or `error` is set. */
  readonly notes: readonly string[];
}

/** TODAY: the shipped pixel bake, nearest-sampled, at the row's zoom. */
function todayRender(subject: Subject, zoom: number): SubjectRender {
  const key = GEN_KEY_OF_SUBJECT[subject.id];
  if (key === undefined) return endpointReferenceRender(subject, zoom);
  const holder = new Container();
  const sprite = new Sprite(todayTexture(subject, key));
  sprite.scale.set(zoom);
  holder.addChild(sprite);
  return { node: holder, absent: null, error: null, notes: [] };
}

/**
 * TODAY x ENDPOINT: legitimately absent, and LABELLED absent (A.5).
 *
 * The ENDPOINT has no machine body and no synth generator. Its only shipped visual is
 * the asymmetric wire-terminal inlet glyph, which the wires layer stamps at a port
 * rather than drawing as a chassis - so this cell draws that glyph at true size, in
 * the electric accent the shipped wires layer fills it with (read from LOCKED_SKIN,
 * never a literal), and says in words what it is.
 *
 * A blank cell and an absent cell look identical and mean opposite things. One is a
 * board defect; the other is the most important single fact on the ENDPOINT row,
 * because it means the endpoint's four candidates have no baseline to be compared
 * against at all.
 */
function endpointReferenceRender(subject: Subject, zoom: number): SubjectRender {
  const holder = new Container();
  const g = new Graphics();
  // Centred in the subject's own 32x32 footprint, at true size, then scaled with the
  // row like every other cell.
  const cx = (subject.w * CELL_U) / 2;
  const cy = (subject.h * CELL_U) / 2;
  // The canonical EAST-facing orientation - the same one the Legend row mirrors.
  // PORT_ROLE.IN explicitly (72-09 R-60): the request-in chevron, the same one the
  // Legend row mirrors. The Out variant is a wires.ts runtime case, not a reference cell.
  for (const r of inletGlyphRects(1, 0, PORT_ROLE.IN)) g.rect(cx + r.x, cy + r.y, r.w, r.h);
  g.fill({ color: LOCKED_SKIN.palette.accents.electric, alpha: 1 });
  g.scale.set(zoom);
  holder.addChild(g);
  return { node: holder, absent: 'no-shipped-art', error: null, notes: [ENDPOINT_NOTE] };
}

/** A..D: the real candidate .svg through the real Pixi SVG path. */
function candidateRender(
  subject: Subject,
  direction: Direction,
  zoom: number,
  deps: SlateDeps,
): SubjectRender {
  const svgText = deps.candidateSvg(direction, subject.id);
  const path = `render/assets/candidates/${direction.toLowerCase()}/${subject.id.toLowerCase()}.svg`;
  // A draft that has not been authored. Visible text, never a blank box.
  if (svgText === undefined) {
    return {
      node: null,
      absent: 'no-candidate',
      error: null,
      notes: ['no candidate authored', `expected ${path}`],
    };
  }
  const result = sharedCandidate(subject.id, direction, svgText);
  // A draft that did not parse. Says so, and says it is not a verdict on the drawing.
  if (!('ctx' in result)) {
    return {
      node: null,
      absent: null,
      error: 'parse-failure',
      notes: [
        'candidate failed to render',
        `${path}: ${result.reason} - the cell is blank because the asset did not parse, not because the artwork is empty`,
      ],
    };
  }
  // A draft that parsed but tessellated to nothing (mirrors assertVertexBudget's copy).
  if (result.vertexCount === 0) {
    return {
      node: null,
      absent: null,
      error: 'zero-geometry',
      notes: [
        'candidate tessellated to zero geometry',
        `${path} - check the paths parse and declare fill or stroke`,
      ],
    };
  }
  const holder = new Container();
  const g = new Graphics(result.ctx);
  g.scale.set(zoom);
  holder.addChild(g);
  return { node: holder, absent: null, error: null, notes: [] };
}

/**
 * Resolve ONE (subject, direction, zoom) to its display object and cell state.
 *
 * THE SINGLE BRANCH POINT for what a column renders, and the reason it is exported:
 * plan 57-07's channel panel draws the same nine subjects in the same five columns,
 * and a second copy of this branch would be a second rendering path that could
 * diverge - which would make the two sections of the board disagree about what
 * Direction C looks like, silently.
 *
 * BELT is drawn from the shipped generator set in ALL FIVE columns, carrying the note
 * that names its lock. That satisfies BOARD-01's literal "every machine kind across
 * every candidate direction", satisfies the completeness gate with no special case,
 * and puts the decided belt language physically inside the grid - which is the honest
 * framing, because machine candidates are judged against a belt language that is
 * already settled.
 */
export function buildSubjectRender(
  subject: Subject,
  direction: Direction,
  zoom: number,
  deps: SlateDeps,
): SubjectRender {
  if (subject.id === 'BELT') return { ...todayRender(subject, zoom), notes: [BELT_NOTE] };
  if (direction === 'TODAY') return todayRender(subject, zoom);
  return candidateRender(subject, direction, zoom, deps);
}

/**
 * A slate cell whose render threw. Names the subject, the direction and the reason in
 * visible text (review WR-07).
 *
 * NEVER A BLANK CELL, and never a blank BOARD. `buildLaneStrip` already contains every
 * one of its 24 cells this way, on the stated ground that "a throw would blank the whole
 * board, and a blank page is the worst outcome for an instrument whose job is to show
 * what is missing". The slate did not: `fillCell` reaches `deps.extractCell` (which
 * throws by name when the Application is gone) and the shipped generator set with no
 * guard, so any single one of the 135 cells could take the other 134, the 25-cell
 * channel panel and the 24-cell lane strip with it.
 *
 * A FAILED CELL IS NOT AN ABSENT CELL, which is why this sets `data-error` and not
 * `data-absent`: "a blank cell and an absent cell look identical and mean opposite
 * things" is this module's own rule, and a cell that failed to draw is a third state
 * again.
 */
function renderSlateErrorCell(
  box: HTMLDivElement,
  subject: Subject,
  direction: Direction,
  zoom: number,
  reason: string,
): void {
  box.setAttribute('data-error', 'cell-failure');
  const strip = document.createElement('div');
  strip.style.textAlign = 'left';
  strip.style.whiteSpace = 'normal';
  for (const line of [
    `${direction} x ${subject.id} at ${zoom}x failed to render`,
    `${reason} - the cell is blank because the render failed, not because this direction has nothing to show`,
  ]) {
    strip.appendChild(textLine(line, 11, 400, inkMuted()));
  }
  box.appendChild(strip);
}

/** Build one slate cell's content and append it to its box. */
function fillCell(
  box: HTMLDivElement,
  subject: Subject,
  direction: Direction,
  zoom: number,
  deps: SlateDeps,
): void {
  const render = buildSubjectRender(subject, direction, zoom, deps);
  if (render.absent !== null) box.setAttribute('data-absent', render.absent);
  if (render.error !== null) box.setAttribute('data-error', render.error);
  if (render.node !== null) {
    box.appendChild(
      deps.extractCell({
        target: render.node,
        footprintW: subject.w,
        footprintH: subject.h,
        zoom,
      }),
    );
  }
  box.appendChild(noteStrip(render.notes));
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

/**
 * The sticky column-header row: direction id + its one-sentence description.
 *
 * The row is `nowrap` so the five inline-block heads stay on one line; each HEAD then
 * re-declares `normal`, because that inherits and the description is an 80-120
 * character sentence in a 192px content box that is `overflow: visible`. Unset, the
 * five descriptions painted 616-702px wide, straight over the neighbouring columns'
 * descriptions. Same rule, and same reason, as `noteStrip`.
 */
function headerRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.style.whiteSpace = 'nowrap';
  row.style.position = 'sticky';
  row.style.top = '0';
  row.style.zIndex = '2';
  row.style.background = substrate;
  row.style.borderBottom = `1px solid ${rule}`;
  row.style.marginBottom = '16px';

  const spacer = document.createElement('div');
  spacer.style.display = 'inline-block';
  spacer.style.width = `${GUTTER_W}px`;
  spacer.style.verticalAlign = 'top';
  row.appendChild(spacer);

  for (const direction of slateDirections()) {
    const head = document.createElement('div');
    head.setAttribute('data-direction-header', direction);
    head.style.display = 'inline-block';
    head.style.boxSizing = 'border-box';
    head.style.width = `${CELL_BOX_W}px`;
    head.style.height = `${HEADER_H}px`;
    head.style.padding = '8px';
    head.style.verticalAlign = 'top';
    head.style.textAlign = 'left';
    head.style.whiteSpace = 'normal';
    head.appendChild(textLine(direction, 11, 600, ink));
    const description = textLine(DIRECTION_DESCRIPTIONS[direction], 13, 400, inkMuted());
    description.setAttribute('data-description', direction);
    description.style.marginTop = '8px';
    head.appendChild(description);
    row.appendChild(head);
  }
  return row;
}

/* ------------------------------------------------------------------ *
 * The measured-cost table (57-UI-SPEC B.4)
 * ------------------------------------------------------------------ */

/**
 * The eight candidate subjects: every subject except BELT, which has no candidate
 * `.svg` under any direction because its art is already locked (A.4).
 *
 * This is the module's ONLY `.filter()`. It filters SUBJECTS, never DIRECTIONS, and it
 * removes a row rather than reordering anything - column order still comes from the one
 * `DIRECTIONS` const, untouched.
 */
const candidateSubjects = (): readonly Subject[] => SUBJECTS.filter((s) => s.id !== 'BELT');

/**
 * The four candidate directions, in DIRECTIONS order with the reference column dropped.
 *
 * READ from `artBoard.ts`'s one derivation, never re-listed here (review WR-04). This
 * was a hardcoded `['A', 'B', 'C', 'D']` literal while the lane strip derived the same
 * axis with its own filter - two mechanisms for one list, against the rule
 * `DIRECTIONS`'s own docblock states.
 */
const CANDIDATE_DIRECTIONS = (): readonly Direction[] => candidateDirections();

/**
 * The measured-cost table: 8 candidate subjects x 4 directions, BELOW the slate.
 *
 * NOT a per-cell badge, and that is the whole design of this section. A number under a
 * cell invites comparison at the moment of looking at the art, and comparison-at-a-
 * glance on a cost metric is ranking. Moving all 32 numbers into one place keeps the
 * cost visible and keeps it out of the aesthetic judgement.
 *
 * TODAY has NO COLUMN here: it has no tessellation, and printing it as `0` would read
 * as the cheapest thing on the board.
 *
 * The board DISPLAYS; `candidateBudget.test.ts` GATES. This function never throws on an
 * over-budget candidate - a throw here blanks the whole page, and N12 requires an
 * over-budget candidate to be a recorded finding rather than a quiet simplification.
 */
export function buildCostTable(): HTMLDivElement {
  const section = document.createElement('div');
  section.id = 'art-board-cost-table';
  section.style.marginTop = '32px';
  section.style.paddingTop = '16px';
  section.style.borderTop = `1px solid ${rule}`;

  const heading = textLine('Measured tessellation cost', 13, 600, ink);
  heading.style.marginBottom = '8px';
  section.appendChild(heading);

  const grid = document.createElement('div');

  const head = document.createElement('div');
  head.style.whiteSpace = 'nowrap';
  head.appendChild(costLabelCell('subject', 600));
  for (const direction of CANDIDATE_DIRECTIONS()) {
    const headCell = costHeaderCell(direction);
    headCell.setAttribute('data-cost-header', direction);
    head.appendChild(headCell);
  }
  grid.appendChild(head);

  const totals = new Map<Direction, { v: number; p: number }>();
  for (const direction of CANDIDATE_DIRECTIONS()) totals.set(direction, { v: 0, p: 0 });

  for (const subject of candidateSubjects()) {
    const row = document.createElement('div');
    row.style.whiteSpace = 'nowrap';
    row.appendChild(costLabelCell(subject.id, 400));
    for (const direction of CANDIDATE_DIRECTIONS()) {
      const cell = costValueCell();
      cell.setAttribute('data-cost-cell', '');
      cell.setAttribute('data-subject', subject.id);
      cell.setAttribute('data-direction', direction);
      const measured = CONTEXTS.get(candidateKey(subject.id, direction));
      if (measured === undefined) {
        cell.appendChild(textLine('not measured', 11, 400, inkMuted()));
        cell.appendChild(textLine('no parsed candidate', 11, 400, inkMuted()));
      } else {
        const total = totals.get(direction) as { v: number; p: number };
        total.v += measured.vertexCount;
        total.p += measured.pointCount;
        // BOTH UNITS, every time: Phase 56's rule is that half of all readers get the
        // unit backwards, and a vertex count read as a point count is off by two.
        cell.appendChild(
          textLine(`${measured.vertexCount} vertices / ${measured.pointCount} points`, 11, 400, ink),
        );
        // The band as a WORD, in the SAME ink, at the SAME weight, with NO colour (N6).
        // Colour-grading a measurement is how a table votes.
        cell.appendChild(
          textLine(`band ${classifyVertexCount(measured.vertexCount)}`, 11, 400, inkMuted()),
        );
      }
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }

  const totalRow = document.createElement('div');
  totalRow.style.whiteSpace = 'nowrap';
  totalRow.appendChild(costLabelCell('all eight', 600));
  for (const direction of CANDIDATE_DIRECTIONS()) {
    const cell = costValueCell();
    cell.setAttribute('data-cost-total', direction);
    const total = totals.get(direction) as { v: number; p: number };
    cell.appendChild(textLine(`${total.v} vertices / ${total.p} points`, 11, 400, ink));
    totalRow.appendChild(cell);
  }
  grid.appendChild(totalRow);
  section.appendChild(grid);

  const caption = document.createElement('div');
  caption.style.marginTop = '16px';
  for (const line of COST_CAPTION) caption.appendChild(textLine(line, 13, 400, inkMuted()));
  section.appendChild(caption);

  return section;
}

/**
 * One direction header of the cost table.
 *
 * It shares `costValueCell`'s box arithmetic EXACTLY - same `CELL_BOX_W`, same padding,
 * same border-box - so a header and the column beneath it share one left edge and a
 * reader scanning down from a direction label reads that direction's own numbers. That
 * is the ONE property this helper exists for, and the art-board e2e assertion
 * "every cost-table header sits over its own column" is what holds it: it names the
 * offending header with both x values, and has been observed red both against the
 * original defect and against a reverted width.
 *
 * It sets no `background`: the header row has never carried the substrate fill that a
 * value cell does, and this helper changes only where the four labels SIT.
 */
function costHeaderCell(text: string): HTMLDivElement {
  const cell = document.createElement('div');
  cell.style.display = 'inline-block';
  cell.style.boxSizing = 'border-box';
  cell.style.width = `${CELL_BOX_W}px`;
  cell.style.padding = '8px';
  cell.style.verticalAlign = 'top';
  cell.style.textAlign = 'left';
  cell.appendChild(textLine(text, 11, 600, ink));
  return cell;
}

/**
 * One gutter cell of the cost table, at the row-label width `GUTTER_W + 32`.
 *
 * NARROWER than a value cell, deliberately, and used ONLY in the first column of every
 * row including the header row. It does NOT share a value cell's box arithmetic - an
 * earlier version of this docstring claimed it did, which is plausibly what let the
 * header row be built from it at label width while its four columns were built at
 * `CELL_BOX_W`, misattributing three of the table's four columns.
 */
function costLabelCell(text: string, weight: 400 | 600): HTMLDivElement {
  const cell = document.createElement('div');
  cell.style.display = 'inline-block';
  cell.style.boxSizing = 'border-box';
  cell.style.width = `${GUTTER_W + 32}px`;
  cell.style.padding = '8px';
  cell.style.verticalAlign = 'top';
  cell.style.textAlign = 'left';
  cell.appendChild(textLine(text, 11, weight, ink));
  return cell;
}

/** One value cell of the cost table. Identical geometry in all four columns (N2). */
function costValueCell(): HTMLDivElement {
  const cell = document.createElement('div');
  cell.style.display = 'inline-block';
  cell.style.boxSizing = 'border-box';
  cell.style.width = `${CELL_BOX_W}px`;
  cell.style.padding = '8px';
  cell.style.verticalAlign = 'top';
  cell.style.textAlign = 'left';
  cell.style.background = substrate;
  return cell;
}

/**
 * The caption. Every sentence is a MEASURED fact from 57-04/57-05, and the two facts
 * that most invite a wrong inference are stated first.
 */
const COST_CAPTION: readonly string[] = [
  'The 400-vertex ceiling is a property of the GraphicsContext, so it is footprint-independent: identical',
  'geometry at 0 0 32 32 and at 0 0 96 96 tessellates to byte-identical counts. A 96x96 FACTORY therefore',
  'has no less room than a 32x32 SOURCE, and no candidate anywhere was simplified on the opposite belief.',
  '',
  'Measured across all 32 candidates the set spans 60 to 166 vertices against a ceiling of 400, and the',
  'dearest single cell uses 41% of it. No direction is near the batching cliff, so the vertex budget',
  'cannot decide this lock.',
  '',
  'Direction D totals the most vertices of the four while drawing the fewest marks. A stroke costs 4',
  'vertices per point and a fill costs 2, and Direction D contains not one filled path. This is recorded',
  'as measured; 57-CONTEXT.md D-02 describes D as cheapest in vertices, and the measurement disagrees.',
];

/* ------------------------------------------------------------------ *
 * The slate
 * ------------------------------------------------------------------ */

/**
 * Render the slate into `host`, followed by the measured-cost table.
 *
 * Emits the DOM contract every later plan and every spec depends on:
 *   [data-slate-block="SOURCE"]                              one block per subject
 *   [data-slate-row="SOURCE@1.00"]                           one row per (subject, zoom)
 *   [data-cell][data-direction][data-subject][data-kind][data-zoom]  one per direction
 *   [data-absent="no-shipped-art" | "no-candidate"]          labelled-absent cells
 *   [data-error="parse-failure" | "zero-geometry"]           labelled-error cells
 *   [data-direction-header][data-description]                the sticky column headers
 *   [data-cost-cell][data-cost-total]                        the measured-cost table
 *   [data-cost-header]                                       its four column headers
 *
 * `data-kind` carries the subject id so that two subjects whose silhouettes collapse
 * in some direction (MERGE and BALANCER are the likely pair) stay separately
 * identifiable in the DOM. That collapse is then a finding about the ART, and can
 * never be an ambiguity in the instrument reporting it.
 *
 * Those attributes are LOCATORS, not reports. The board never publishes a data-
 * attribute describing its own correctness - a spec that read one would be asking the
 * board whether the board is right. Every assertion measures the DOM or the pixels.
 */
export function buildSlate(host: HTMLElement, deps: SlateDeps): void {
  const slate = document.createElement('div');
  slate.id = 'art-board-slate';

  const notes = document.createElement('div');
  notes.style.marginBottom = '16px';
  for (const line of SLATE_NOTES) notes.appendChild(textLine(line, 13, 400, ink));
  slate.appendChild(notes);

  slate.appendChild(headerRow());

  for (const subject of slateSubjects()) {
    const block = document.createElement('div');
    block.setAttribute('data-slate-block', subject.id);
    block.style.marginBottom = '24px';
    block.style.paddingBottom = '24px';
    // A 1px rule that groups ROWS and never columns (N8): it spans the block, so it
    // can never read as separating one direction from another.
    block.style.borderBottom = `1px solid ${rule}`;

    const heading = textLine(
      `${subject.id} (${subject.w}x${subject.h} - ${subject.w * CELL_U}x${subject.h * CELL_U} px at 1.00x)`,
      13,
      600,
      ink,
    );
    heading.style.marginBottom = '16px';
    block.appendChild(heading);

    for (const zoom of slateZooms()) {
      const row = document.createElement('div');
      row.setAttribute('data-slate-row', `${subject.id}@${zoomLabel(zoom)}`);
      row.style.marginBottom = '16px';
      row.style.whiteSpace = 'nowrap';

      const gutter = textLine(`${zoomLabel(zoom)}x`, 11, 600, ink);
      gutter.style.display = 'inline-block';
      gutter.style.width = `${GUTTER_W}px`;
      gutter.style.verticalAlign = 'top';
      gutter.style.position = 'sticky';
      gutter.style.left = '0';
      gutter.style.background = substrate;
      gutter.style.paddingTop = '8px';
      row.appendChild(gutter);

      // The cell box height is fixed for the whole row and IDENTICAL in all five
      // columns: the artwork's own pixel height, plus the 8px padding top and bottom,
      // plus the reserved note strip and its 8px gap. See NOTE_H.
      const boxH = pxAt(subject.h, zoom) + 16 + NOTE_H + 8;

      for (const direction of slateDirections()) {
        const box = cellBox({
          'data-cell': '',
          'data-direction': direction,
          'data-subject': subject.id,
          'data-kind': subject.id,
          'data-zoom': zoomLabel(zoom),
        });
        box.style.height = `${boxH}px`;
        // NOTHING HERE THROWS PAST THIS POINT (review WR-07), the same containment
        // `buildLaneStrip` already applies to every one of its 24 cells. One failed
        // cell would otherwise take all 135 slate cells, the channel panel and the lane
        // strip with it, and a blank page is the worst outcome for an instrument whose
        // job is to show what is missing.
        try {
          fillCell(box, subject, direction, zoom, deps);
        } catch (err) {
          renderSlateErrorCell(
            box,
            subject,
            direction,
            zoom,
            err instanceof Error ? err.message : String(err),
          );
        }
        row.appendChild(box);
      }

      block.appendChild(row);
    }

    slate.appendChild(block);
  }

  host.appendChild(slate);
  host.appendChild(buildCostTable());
}
