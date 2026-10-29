// The art board's colour-channel panel (BOARD-01, plan 57-07): 5 channel rows x 5
// direction columns, each cell holding ALL NINE SUBJECTS at 1.00x in one fixed
// miniature arrangement identical in every one of the 25 cells.
//
// WHY ALL NINE SUBJECTS SHARE A CELL (57-UI-SPEC D.1). The colour-vision question is
// not "is MERGE visible in deutan" - it is "can you still tell MERGE from BALANCER".
// A pair collapsing into each other is invisible if you look at each alone, which is
// exactly what a subject-per-cell layout would produce: 225 cells, every one showing a
// perfectly legible shape, hiding the single failure mode the panel exists to expose.
// Nine in one cell makes a collapse visible at a glance, and visible in the same glance
// as the colour row directly above it. It is also what keeps the panel at 25 cells and
// one screenful instead of 675 cells across three sections.
//
// FIVE IMAGES FROM ONE RENDER. Each column is composited ONCE, extracted ONCE through
// the board's one `extractCell` contract, and the four channel variants are computed in
// JS from those very bytes. That is what makes the transforms DERIVED DATA rather than
// four more renders, and it is what gives the completeness gate real pixels to measure.
//
// THE SUBSTRATE IS INSIDE THE TRANSFORM (D.2). The cell is extracted including its
// `ramp[0]` background and the transform is applied to the whole cell. A greyscale
// silhouette judged against an untransformed background would show a contrast that does
// not exist.
//
// THE BOARD'S OWN CHROME IS NEVER TRANSFORMED. Labels, separators and headings stay in
// `ramp[4]` / `ramp[3]` in every row. Transforming them would make the tritan row
// unreadable as a page.
//
// THE TRANSFORM IS APPLIED IN JS, NOT THROUGH A CSS COLOUR-MATRIX FILTER REFERENCING AN
// SVG FILTER ELEMENT. Not because that filter's linearRGB interpolation is the wrong
// space - it is the right one - but because the transform would then happen inside the
// browser's filter/compositing path, which is renderer-dependent and gives the gate no
// pixels to read. See `render/colourChannels.ts`'s header for the full argument; the
// transforms themselves are shipped-side because the ART-03 gate over the shipped
// palette runs the same ones, and this panel imports them like any other consumer.
//
// A FAILED TRANSFORM RENDERS AN ERROR CELL AND NEVER FALLS THROUGH TO THE UNTRANSFORMED
// IMAGE. Falling through is the dangerous silent failure: it shows separation a
// dichromat cannot see, and it passes a naive "the cell is non-empty" check.
//
// WHAT THIS PANEL DOES NOT DO (D.3). It presents; it does not assert. Nothing here
// states that a direction survives a channel. ART-03's CI colour-vision gate - the one
// that fails when a pair becomes indistinguishable - is Phase 58 work over the shipped
// machine set, because a distinguishability metric needs locked art to calibrate and
// asserting it here would mean asserting against artwork that is about to be discarded.
// There is no toggle, no filter control and no collapse: D-07 forbids the CVD toggle by
// name, because a toggle means it does not get looked at.
//
// THE IMPORT CYCLE, INHERITED FROM artBoardSlate.ts. artBoard.ts imports this module and
// this module imports artBoard.ts back, so ESM hands us a live-but-partially-initialised
// namespace. EVERY read of an artBoard.ts binding below happens INSIDE A FUNCTION BODY.
// A top-level read throws `ReferenceError: Cannot access 'X' before initialization` and
// the board never boots - observed twice already in this phase (57-01 on SUBJECTS, 57-06
// on hex), so it is a rule here rather than a discovery.
//
// This module is never imported outside src/spike/ and exports nothing to the app.

import { Container } from 'pixi.js';
import { CHANNELS, transformRgba, type ChannelKind } from '../render/colourChannels.ts';
import {
  CELL_U,
  DIRECTIONS,
  SUBJECTS,
  cellBox,
  ink,
  rule,
  substrate,
  type Direction,
  type Subject,
} from './artBoard.ts';
import { buildSubjectRender, inkMuted, textLine, type SlateDeps } from './artBoardSlate.ts';

/* ------------------------------------------------------------------ *
 * The fixed arrangement - ONE constant, identical in all 25 cells
 * ------------------------------------------------------------------ */

/** One subject's slot inside the miniature arrangement, in content-box pixels. */
interface PanelSlot {
  /** The subject id, matched against `SUBJECTS`. */
  readonly id: string;
  /** Left offset inside the content box. */
  readonly x: number;
  /** Top offset inside the content box. */
  readonly y: number;
}

/**
 * The miniature arrangement, verbatim from 57-UI-SPEC D.1, as ONE constant.
 *
 * Row 1 `SOURCE` `BELT` `SINK` `ENDPOINT` at 32 px; row 2 `TEE` `BALANCER` `MERGE` at
 * 64 px; row 3 `ROUTER` at 64x96 and `FACTORY` at 96x96. 4 px gaps throughout.
 *
 * WHAT BREAKS IF THIS MOVES: it is the SAME arrangement in every one of the 25 cells,
 * which is the only thing that makes a silhouette collapse readable across a row - two
 * cells whose subjects sat in different places would have to be compared shape by shape
 * instead of at a glance, and the collapse would be exactly as invisible as it is in
 * the 225-cell layout this design exists to avoid.
 *
 * The 4 px gaps are load-bearing rather than decorative: at zero gap `TEE`, `BALANCER`
 * and `MERGE` touch, and two adjacent silhouettes that touch read as one shape - which
 * would manufacture the very collapse the panel is trying to detect.
 */
export const PANEL_SUBJECT_LAYOUT: readonly PanelSlot[] = [
  { id: 'SOURCE', x: 0, y: 0 },
  { id: 'BELT', x: 36, y: 0 },
  { id: 'SINK', x: 72, y: 0 },
  { id: 'ENDPOINT', x: 108, y: 0 },
  { id: 'TEE', x: 0, y: 36 },
  { id: 'BALANCER', x: 68, y: 36 },
  { id: 'MERGE', x: 136, y: 36 },
  { id: 'ROUTER', x: 0, y: 104 },
  { id: 'FACTORY', x: 68, y: 104 },
];

/**
 * The content box, in px: exactly the arrangement's own extent on both axes.
 *
 * Width is row 2: 136 + 64 = 200. Height is row 3's top plus its height: 104 + 96 = 200.
 * DERIVED BY HAND from the layout above and stated here so the two cannot silently
 * disagree; a spec asserts the extracted backing store is exactly this on all 25 cells.
 */
const PANEL_CONTENT_PX = 200;

/** The 8 px padding, the same value the slate's `cellBox` uses (Spacing Scale). */
const PANEL_PAD = 8;

/**
 * The fixed panel cell box, in px. IDENTICAL in every cell of every row (N2).
 *
 * 216, NOT the 208 that 57-UI-SPEC D.1 and this plan's action both print. Those three
 * figures - box 208, padding 8, content 200 - cannot all hold: 208 - 2 x 8 is 192.
 * The content figure is the load-bearing one, because it is the arrangement drawn at
 * the subjects' TRUE 1.00x sizes (32 / 64 / 96 px on the 32-unit module) and shrinking
 * it would mean judging silhouettes at a size the game never draws them at. The 8 px
 * padding is the shared Spacing Scale value. So the box absorbs the slip: 200 + 8 + 8.
 * Recorded here rather than silently rounded, because 208 appears in the spec.
 */
export const PANEL_CELL_PX = PANEL_CONTENT_PX + 2 * PANEL_PAD;

/**
 * The panel's zoom: 1.00x, and only 1.00x.
 *
 * The channel panel answers a COLOUR question. Zoom is the slate's axis, and crossing
 * the two would take the panel to 75 cells and several screenfuls, which is the scan
 * cost D.1 chose this layout to avoid.
 */
const PANEL_ZOOM = 1;

/** The row-label gutter. Identical to the slate's, so the two grids line up. */
const PANEL_GUTTER_W = 120;

/* ------------------------------------------------------------------ *
 * Copy - every string pre-checked against D-14's five banned tokens
 * ------------------------------------------------------------------ */

/** The panel's standing lines, above the grid. */
const PANEL_NOTES: readonly string[] = [
  'Channel row order is fixed - colour, greyscale, deutan, protan, tritan - and it carries no ranking meaning. Deutan leads the three simulations because deuteranomaly is the most common deficiency.',
  'Every cell holds all nine subjects at 1.00x in one arrangement, identical in all 25 cells, so two kinds whose silhouettes collapse into each other are visible in a single glance rather than across 225 separately-legible cells.',
  'Each column is composited and extracted ONCE, in colour, including its own background; the four channel images are computed from those pixels. The board labels, separators and headings are never transformed.',
  'Zoom is 1.00x only. This panel answers a colour question, and zoom is the slate axis above.',
];

/** The panel's caption, below the grid: what it does NOT do. */
const PANEL_CAPTION: readonly string[] = [
  'This panel presents. It does not assert, and nothing on it states that a direction survives a channel - that reading is yours, and the only place it is recorded is',
  '57-ART-LOCK.md, in the internal design notes.',
  '',
  'The CI colour-vision gate - the one that fails when two kinds become indistinguishable - is Phase 58 work over the shipped machine set (ART-03). A distinguishability metric needs locked art to calibrate,',
  'and building it here would mean asserting against artwork that is about to be discarded.',
];

/** The one-word channel row labels (long-text: transform labels are single words). */
const CHANNEL_LABEL: Readonly<Record<string, string>> = {
  colour: 'colour',
  greyscale: 'greyscale',
  deutan: 'deutan',
  protan: 'protan',
  tritan: 'tritan',
};

/* ------------------------------------------------------------------ *
 * Per-direction rendering: one composite, one extract, four transforms
 * ------------------------------------------------------------------ */

/** Everything one direction column resolved to. */
interface DirectionImages {
  /** channel name -> the canvas holding that channel's pixels. */
  readonly images: ReadonlyMap<string, HTMLCanvasElement>;
  /** channel name -> why that channel has no image. Never falls through to colour. */
  readonly failures: ReadonlyMap<string, string>;
  /**
   * Subjects that could not be drawn at all, each carrying WHICH KIND of not-drawn it
   * was (review WR-08).
   *
   * IT IS NOT A FLAT STRING LIST ANY MORE, and the distinction is the point. The three
   * causes the slate already separates - `no-candidate`, `parse-failure` and
   * `zero-geometry` - were collapsed here into one `missing` array and one
   * `data-absent="no-candidate"` attribute, so a draft that EXISTED but failed to parse
   * rendered as "no candidate authored" and printed the self-contradicting sentence
   * `subjects with no candidate authored: MERGE (parse-failure)`.
   *
   * The slate's own docblocks state why that matters: "a blank cell and an absent cell
   * look identical and mean opposite things". A cell that failed is a third thing again,
   * and the panel was the one section that could not say so.
   */
  readonly missing: readonly MissingSubject[];
}

/** One subject the panel could not draw, and why. */
interface MissingSubject {
  /** The subject id, e.g. `MERGE`. */
  readonly id: string;
  /** The absence reason when the draft is genuinely unauthored, else null. */
  readonly absent: string | null;
  /** The failure reason when a draft EXISTS but did not draw, else null. */
  readonly error: string | null;
}

/** `MERGE (parse-failure)` - the id with whichever reason it carries. */
const missingLabel = (m: MissingSubject): string =>
  `${m.id} (${m.absent ?? m.error ?? 'unknown'})`;

/** The four DERIVED channels, read from the one `CHANNELS` constant. */
const transformedChannels = (): readonly ChannelKind[] =>
  CHANNELS.filter((c): c is ChannelKind => c !== 'colour');

/** The subject record for one layout slot. Reads `SUBJECTS` inside a function (TDZ). */
function slotSubject(slot: PanelSlot): Subject {
  const found = SUBJECTS.find((s) => s.id === slot.id);
  if (found === undefined) {
    throw new Error(`artBoardPanel: layout slot ${slot.id} is not a board subject`);
  }
  return found;
}

/**
 * Composite one direction's nine subjects, extract once, then derive the four channels.
 *
 * The nine display objects come from `buildSubjectRender`, the SAME per-column branch
 * the slate uses - TODAY through the nearest-sampled Sprite, A-D through the shared
 * candidate GraphicsContext, BELT through the locked tile in every column. There is no
 * second rendering path here that could diverge from the slate's.
 */
function buildDirectionImages(direction: Direction, deps: SlateDeps): DirectionImages {
  const composite = new Container();
  const missing: MissingSubject[] = [];

  for (const slot of PANEL_SUBJECT_LAYOUT) {
    const render = buildSubjectRender(slotSubject(slot), direction, PANEL_ZOOM, deps);
    if (render.node === null) {
      // The REASON is carried through, not flattened into a display string (WR-08):
      // the cell renderer has to tell an unauthored draft from one that failed to draw,
      // and it cannot do that from `"MERGE (parse-failure)"`.
      missing.push({ id: slot.id, absent: render.absent, error: render.error });
      continue;
    }
    render.node.x = slot.x;
    render.node.y = slot.y;
    composite.addChild(render.node);
  }

  // ONE extract, through the board's one contract: explicit frame (so the cell size is
  // the arrangement's box and never the artwork's stroke extents), explicit clearColor
  // (so every alpha byte is 255, where premultiplied and un-premultiplied are identical
  // and the transform cannot be handed dark, wrong colour), resolution 1.
  const colour = deps.extractCell({
    target: composite,
    footprintW: PANEL_CONTENT_PX / CELL_U,
    footprintH: PANEL_CONTENT_PX / CELL_U,
    zoom: PANEL_ZOOM,
  });

  const images = new Map<string, HTMLCanvasElement>([['colour', colour]]);
  const failures = new Map<string, string>();

  // `willReadFrequently` is not a micro-optimisation here: without the hint each
  // getImageData forces a GPU-to-CPU readback stall, and the panel performs one per
  // direction on top of the slate's 135.
  const source = colour.getContext('2d', { willReadFrequently: true });
  if (source === null) {
    for (const kind of transformedChannels()) {
      failures.set(kind, 'the colour cell canvas has no 2d context to read back');
    }
    return { images, failures, missing };
  }
  const src = source.getImageData(0, 0, colour.width, colour.height);

  for (const kind of transformedChannels()) {
    try {
      const out = transformRgba(src.data, kind);
      if (out.length !== src.data.length) {
        throw new Error(`transform returned ${out.length} bytes, expected ${src.data.length}`);
      }
      const canvas = document.createElement('canvas');
      canvas.width = colour.width;
      canvas.height = colour.height;
      canvas.style.imageRendering = 'pixelated';
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (g === null) throw new Error('the channel canvas has no 2d context');
      // `createImageData` + `set` rather than `new ImageData(out, w, h)`: the DOM lib's
      // ImageData constructor requires a `Uint8ClampedArray<ArrayBuffer>` and
      // `transformRgba` returns the unparameterised form. Copying into a buffer the
      // context itself allocated is also the only form that cannot smuggle a
      // SharedArrayBuffer into the canvas.
      const dst = g.createImageData(canvas.width, canvas.height);
      dst.data.set(out);
      g.putImageData(dst, 0, 0);
      images.set(kind, canvas);
    } catch (err) {
      // NEVER fall through to `colour` here. See the module header: an untransformed
      // cell presented as a simulation shows separation a dichromat cannot see, and it
      // passes every non-emptiness check the board has.
      failures.set(kind, err instanceof Error ? err.message : String(err));
    }
  }

  return { images, failures, missing };
}

/* ------------------------------------------------------------------ *
 * The cell renderers
 * ------------------------------------------------------------------ */

/** One channel cell that has pixels. */
export function renderChannelCell(box: HTMLDivElement, canvas: HTMLCanvasElement): void {
  box.appendChild(canvas);
}

/**
 * Why one channel cell has no pixels.
 *
 * `transform-failure` - the extract succeeded and the CVD transform for this one
 * channel did not, so this cell is blank while its siblings in the same column are not.
 *
 * `cell-failure` - the cell body itself threw: the column never composited, the extract
 * failed, or the append did. It is the panel's equivalent of the slate's `cell-failure`
 * and the lane strip's `geometry-failure`, and it is a DIFFERENT fact from a transform
 * that ran and produced nothing. Collapsing the two would tell a reader the CVD
 * simulation is broken when what actually broke was the drawing underneath it.
 */
export type ChannelFailureCause = 'transform-failure' | 'cell-failure';

/**
 * One channel cell that has no pixels. Names the direction, names the channel, names
 * the cause, and says in visible text why the cell is blank.
 *
 * THE CAUSE IS AN ARGUMENT, NOT AN ASSUMPTION (review WR-03). This renderer used to
 * hardcode `transform-failure`, which was true of its one caller and became false the
 * moment the per-cell containment below started routing render failures through it. A
 * cell that is blank because the column never built is not a cell whose transform
 * failed, and the whole reason this board writes `data-error` rather than leaving the
 * cell empty is that a blank cell and a failed cell mean opposite things.
 */
export function renderChannelErrorCell(
  box: HTMLDivElement,
  direction: Direction,
  channel: string,
  reason: string,
  cause: ChannelFailureCause,
): void {
  box.setAttribute('data-error', cause);
  const strip = document.createElement('div');
  strip.style.textAlign = 'left';
  strip.style.lineHeight = '1.5';
  const headline =
    cause === 'transform-failure'
      ? `${channel} transform failed for ${direction}`
      : `${direction} x ${channel} failed to render`;
  const tail =
    cause === 'transform-failure'
      ? `${reason} - the cell is blank because the transform failed, not because the artwork is empty; the untransformed image is deliberately NOT shown here`
      : `${reason} - the cell is blank because the cell failed to render, not because this direction has nothing to show`;
  for (const line of [headline, tail]) {
    strip.appendChild(textLine(line, 11, 400, inkMuted()));
  }
  box.appendChild(strip);
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

/** The panel's own cell box: the slate's geometry helper at the panel's fixed size. */
function panelCellBox(attrs: Record<string, string>): HTMLDivElement {
  const box = cellBox(attrs);
  // `cellBox` sizes for the SLATE's widest content. The panel's arrangement is 200 px
  // square, so both dimensions are overridden here - to the SAME value in every one of
  // the 25 cells, which is what N2 actually requires.
  box.style.width = `${PANEL_CELL_PX}px`;
  box.style.height = `${PANEL_CELL_PX}px`;
  return box;
}

/**
 * Render the channel panel into `host`.
 *
 * Emits the DOM contract plan 57-07's spec depends on:
 *   [data-channel-row="colour"]                       one row per channel, in CHANNELS order
 *   [data-channel-cell][data-channel][data-direction] 25 cells
 *   [data-channel-label="colour"]                     the row label, never transformed
 *   [data-error="transform-failure"]                  a channel whose transform failed
 *   [data-error="cell-failure"]                       a cell whose body threw (WR-03)
 *   [data-error="subject-failure"]                    a subject that exists and did not draw
 *   [data-absent="no-candidate"]                      a cell missing one or more subjects
 *
 * Those attributes are LOCATORS, not reports: the board never publishes an attribute
 * describing its own correctness, and every assertion in the spec measures the DOM or
 * the pixels for itself.
 *
 * NOTHING IN THE CELL LOOP THROWS PAST THIS FUNCTION (review WR-03). This was the one
 * section of four without per-cell containment, while `renderSlateErrorCell`'s own
 * docblock stated the rule as universal - "NEVER A BLANK CELL, and never a blank BOARD".
 * It is not a theoretical gap: `slotSubject` throws by name, `deps.extractCell` throws
 * when the Application is gone, and `buildDirectionImages` ran OUTSIDE any guard, so a
 * single unresolvable subject took all 25 cells - and, because the panel mounts before
 * the lane strip, the 24-cell lane strip with them. The containment is in two layers
 * because the failure can happen at two scopes:
 *
 *   per DIRECTION - `buildDirectionImages` is one composite + one extract + four
 *     transforms for a whole column, and it cannot be re-run per cell. A throw is caught
 *     once and remembered, then re-raised inside each of that column's five cells so it
 *     reaches the SAME per-cell renderer rather than a second error path.
 *   per CELL - the body that reads the image, writes the attributes and appends the
 *     strip, matching the shape `buildLaneStrip` applies to all 24 of its cells and
 *     `buildSlate` to all 135 of its own.
 *
 * A failed column therefore degrades to five labelled cells that name the direction, the
 * channel and the real reason, and every other column, the caption and everything the
 * caller mounts afterwards still render.
 */
export function buildChannelPanel(host: HTMLElement, deps: SlateDeps): void {
  const panel = document.createElement('div');
  panel.id = 'art-board-panel';
  panel.style.marginTop = '32px';
  panel.style.paddingTop = '16px';
  panel.style.borderTop = `1px solid ${rule}`;

  const heading = textLine('Colour channels', 13, 600, ink);
  heading.style.marginBottom = '8px';
  panel.appendChild(heading);

  const notes = document.createElement('div');
  notes.style.marginBottom = '16px';
  for (const line of PANEL_NOTES) notes.appendChild(textLine(line, 13, 400, ink));
  panel.appendChild(notes);

  // The column headers. Column order comes from the SAME `DIRECTIONS` constant the
  // slate reads - not a copy - so the two grids can never disagree about the axis.
  const headerRow = document.createElement('div');
  headerRow.style.whiteSpace = 'nowrap';
  headerRow.style.marginBottom = '8px';
  const spacer = document.createElement('div');
  spacer.style.display = 'inline-block';
  spacer.style.width = `${PANEL_GUTTER_W}px`;
  spacer.style.verticalAlign = 'top';
  headerRow.appendChild(spacer);
  for (const direction of DIRECTIONS) {
    const head = textLine(direction, 11, 600, ink);
    head.setAttribute('data-channel-header', direction);
    head.style.display = 'inline-block';
    head.style.boxSizing = 'border-box';
    head.style.width = `${PANEL_CELL_PX}px`;
    head.style.padding = `0 ${PANEL_PAD}px`;
    head.style.verticalAlign = 'top';
    head.style.textAlign = 'left';
    headerRow.appendChild(head);
  }
  panel.appendChild(headerRow);

  // FIVE composites, twenty transforms: every direction is rendered exactly once and
  // its four channel images are derived from those bytes.
  //
  // LAYER 1 OF THE CONTAINMENT (WR-03): a column that does not build is REMEMBERED, not
  // thrown. `buildDirectionImages` is the composite + extract + four transforms for one
  // whole column; it cannot be retried per cell, so the reason is stored and re-raised
  // inside each of that column's cells below.
  const perDirection = new Map<Direction, DirectionImages>();
  const directionFailures = new Map<Direction, string>();
  for (const direction of DIRECTIONS) {
    try {
      perDirection.set(direction, buildDirectionImages(direction, deps));
    } catch (err) {
      directionFailures.set(direction, err instanceof Error ? err.message : String(err));
    }
  }

  const grid = document.createElement('div');
  for (const channel of CHANNELS) {
    const row = document.createElement('div');
    row.setAttribute('data-channel-row', channel);
    row.style.whiteSpace = 'nowrap';
    row.style.marginBottom = '8px';

    const label = textLine(CHANNEL_LABEL[channel] as string, 11, 600, ink);
    label.setAttribute('data-channel-label', channel);
    label.style.display = 'inline-block';
    label.style.width = `${PANEL_GUTTER_W}px`;
    label.style.verticalAlign = 'top';
    label.style.paddingTop = `${PANEL_PAD}px`;
    row.appendChild(label);

    for (const direction of DIRECTIONS) {
      const box = panelCellBox({
        'data-channel-cell': '',
        'data-channel': channel,
        'data-direction': direction,
      });
      // LAYER 2 OF THE CONTAINMENT (WR-03). NOTHING BELOW THROWS PAST THIS POINT. One
      // cell that cannot render is one labelled cell; it does not take the other 24, the
      // caption, or the lane strip that mounts after this panel.
      try {
        const columnFailure = directionFailures.get(direction);
        if (columnFailure !== undefined) {
          // Re-raised rather than branched, so a failed COLUMN and a failed CELL reach
          // the one renderer by the one route. A second error path here is how the two
          // would drift apart in wording and in attribute.
          throw new Error(`the ${direction} column did not build - ${columnFailure}`);
        }
        const resolved = perDirection.get(direction) as DirectionImages;
        // THE ATTRIBUTE NAMES THE CAUSE (review WR-08). A subject that exists but did not
        // draw is a FAILURE, not an absence, and marking it `data-absent="no-candidate"`
        // told a reader the opposite of what happened. When both kinds are present the
        // failure wins: an unauthored draft is an expected state of this board, and a
        // draft that broke is not.
        const anyFailed = resolved.missing.some((m) => m.error !== null);
        if (resolved.missing.length > 0) {
          if (anyFailed) box.setAttribute('data-error', 'subject-failure');
          else box.setAttribute('data-absent', 'no-candidate');
        }
        const canvas = resolved.images.get(channel);
        if (canvas === undefined) {
          renderChannelErrorCell(
            box,
            direction,
            channel,
            resolved.failures.get(channel) ?? 'no image was produced for this channel',
            'transform-failure',
          );
        } else {
          // The colour cell's canvas is the ONE extracted element and can only be placed
          // in the DOM once; every other row gets its own derived canvas, so only the
          // colour row is a move rather than an append.
          renderChannelCell(box, canvas);
        }
        if (resolved.missing.length > 0) {
          const strip = document.createElement('div');
          strip.style.textAlign = 'left';
          strip.style.lineHeight = '1.5';
          // WORDED FROM THE SAME DATA THE ATTRIBUTE IS (WR-08). The old line always read
          // "subjects with no candidate authored", which printed the self-contradiction
          // `subjects with no candidate authored: MERGE (parse-failure)` the moment a
          // draft existed and failed.
          strip.appendChild(
            textLine(
              `${anyFailed ? 'subjects that did not draw' : 'subjects with no candidate authored'}: ` +
                resolved.missing.map(missingLabel).join(', '),
              11,
              400,
              inkMuted(),
            ),
          );
          box.appendChild(strip);
        }
      } catch (err) {
        // The box is emptied first: a cell that threw HALFWAY has half its content in
        // the DOM, and a labelled failure sitting under a partial render is the blank-vs-
        // failed ambiguity this board exists to refuse, one level down.
        box.replaceChildren();
        box.removeAttribute('data-absent');
        renderChannelErrorCell(
          box,
          direction,
          channel,
          err instanceof Error ? err.message : String(err),
          'cell-failure',
        );
      }
      row.appendChild(box);
    }

    grid.appendChild(row);
  }
  panel.appendChild(grid);

  const caption = document.createElement('div');
  caption.style.marginTop = '16px';
  caption.style.background = substrate;
  for (const line of PANEL_CAPTION) caption.appendChild(textLine(line, 13, 400, inkMuted()));
  panel.appendChild(caption);

  host.appendChild(panel);
}
