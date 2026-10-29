// build-mark-sheet.ts - the generator for the Phase 79 comparison sheet (MARK-01, plan 79-03).
//
// WHAT THIS EMITS. `frontend/mark-sheet.html`, the one page the reviewer opens in Chrome to name a
// route. Four candidates plus the shipped mark, at 16px, 32px and 96px, in colour and in
// monochrome, with the 16px colour row as the first render on the page and a repeat of that
// row as the last thing on it.
//
// THE PAGE IS GENERATED AND NEVER HAND-WRITTEN. Nothing on the sheet is transcribed. The
// candidate SVGs are read from disk and inlined verbatim, the `:root` token block is baked
// from `LOCKED_SKIN` through the shipped `skinToCssVars`, and every craft verdict comes from
// a live `measureAll()` call at build time. A hand-typed palette is a second source of truth
// that drifts the first time a token moves, and the sheet would then be putting a design vote
// on colours the product does not have.
//
// WHERE IT LIVES AND WHY. Root level in `frontend/`, beside the three standalone fixture pages
// that already live there (`art-board.html`, `chrome-dpr-spike.html`, `pixel-guard.html`).
// `art-board.html` is Phase 57's own candidate-judging sheet, so this is the established shape
// rather than a new one. Vite serves it in dev at `/mark-sheet.html`; it is STRUCTURALLY
// absent from `dist/` because `vite.config.ts` declares no extra rollup inputs; it is never
// imported by `App.tsx` or `main.tsx`; and it is outside `frontend/src/chrome/assets/`, so
// success criterion 4 is untouched.
//
// CANDIDATES ARE INLINED AS `<svg>` MARKUP, NEVER REFERENCED WITH AN IMAGE ELEMENT. Two
// independent reasons and either alone is sufficient. (1) `var(--fab-*)` cannot cross the
// image boundary, so every candidate would paint black and the monochrome cut, which is a
// token remap, would do nothing. (2) A referenced file that fails to load renders an EMPTY
// tile, which reads as "this candidate has no mark at this size", and the vote would then be
// taken against a rendering failure that looks like a design property. Inlining also means
// nothing is fetched, so the page has no loading state at all, by construction.
//
// NOTHING HERE IS SUBSTITUTED INTO A TEMPLATE. `vite.config.ts`'s `fab-page-background` plugin
// substitutes a value into `index.html` at a sentinel and THROWS when the sentinel is absent,
// because a plain string replace is a silent no-op. This generator has no sentinel to miss:
// the page is built from the data rather than patched into a shipped skeleton. The equivalent
// failure shape is kept where it can still happen - `literalise()` throws on an unbaked token
// rather than emitting a `var(...)` that would paint black inside a canvas source.
//
// NO PATH INPUT, EVER, following `mark-craft.ts` and `lint-svg.ts`. Every path is resolved
// from `import.meta.url`. This module reads no argv and no cwd, so `node
// frontend/scripts/build-mark-sheet.ts` works from the repository root and from `frontend/`
// alike.
//
// ERASURE-ONLY TYPESCRIPT. Node runs this file directly through native type stripping, which
// is erasure only: interfaces, type aliases, annotations and `import type` only, no enums, no
// namespaces, no parameter properties, an explicit `.ts` extension on every relative import.
// The contract is stated at `scripts/lint-svg.ts:29-34`.
//
// NO EM DASH (U+2014) ANYWHERE IN THIS FILE OR IN ANYTHING IT EMITS. Asserted by the plan's
// own verify block over the generated HTML.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCKED_SKIN } from '../src/render/synth/skins/locked.ts';
import { skinToCssVars } from '../src/render/synth/chrome/skinToCssVars.ts';
import {
  CANDIDATES_DIR,
  SHIPPED_MARK,
  diffAgainstExpectations,
  formatMismatch,
  measureAll,
} from './mark-craft.ts';
import type { CutMeasurement, Verdict } from './mark-craft.ts';

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/** The generated sheet. Committed, because it is the artefact the reviewer opens. Never edited. */
export const SHEET_PATH = fileURLToPath(new URL('../mark-sheet.html', import.meta.url));

/* ------------------------------------------------------------------ *
 * The baked token table
 * ------------------------------------------------------------------ */

/**
 * The shipped `:root` block, verbatim from the shipped generator. Parsed back into a map so
 * the sheet's own chrome can be painted from the same values rather than from a second list.
 */
const ROOT_BLOCK = skinToCssVars(LOCKED_SKIN);

function tokenTable(): Map<string, string> {
  const body = ROOT_BLOCK.replace(/^:root\{/, '').replace(/\}$/, '');
  const table = new Map<string, string>();
  for (const decl of body.split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const name = decl.slice(0, colon).trim();
    if (!name.startsWith('--')) continue;
    table.set(name, decl.slice(colon + 1).trim());
  }
  return table;
}

const TOKENS = tokenTable();

function baked(name: string): string {
  const value = TOKENS.get(name);
  if (value === undefined) {
    throw new Error(`build-mark-sheet: ${name} is not in the baked token block, refusing to guess it`);
  }
  return value;
}

const SUBSTRATE = baked('--fab-substrate');
const PANEL = baked('--fab-panel-fill');
const INK = baked('--fab-ink');
const DESTRUCTIVE = baked('--fab-destructive');

/**
 * `ramp[3]`, the neutral chip ground. `skinToCssVars` binds no custom property to this step,
 * so it is read off the locked palette rather than typed in. Same source, one hop earlier.
 */
const NEUTRAL = `#${(LOCKED_SKIN.palette.ramp[3] as number).toString(16).padStart(6, '0')}`;

/**
 * THE MONOCHROME CUT IS A TOKEN REMAP, never a second set of drawings, and that is what proves
 * the geometry is identical: the mono tile holds the SAME inlined node as its colour twin and
 * the spec asserts markup equality between them.
 *
 * Every paint token that carries ink collapses to one ink; the three that resolve to the
 * ground stay on the ground. `--fab-btn-primary` is in the ink list on purpose: it is the
 * shipped mark's blue accent, and a monochrome cut that spared it would be flattering exactly
 * the one drawing on this page that is not a candidate.
 */
const MONO_INK_TOKENS = [
  '--fab-ink',
  '--fab-edge-lit',
  '--fab-panel-fill',
  '--fab-accent-item',
  '--fab-btn-primary',
] as const;
const MONO_GROUND_TOKENS = ['--fab-substrate', '--fab-edge-shadow', '--fab-outline'] as const;

/**
 * THE SILHOUETTE CUT is the squint test: everything that paints anything at all becomes one
 * ink, INCLUDING the outline and the shadow edge, and only the ground is left behind. A
 * candidate whose identity is a full-bleed square becomes a solid square here, and that is the
 * honest result rather than a rendering fault.
 */
const SILHOUETTE_INK_TOKENS = [...MONO_INK_TOKENS, '--fab-edge-shadow', '--fab-outline'] as const;

function remap(inkTokens: readonly string[], groundTokens: readonly string[]): Map<string, string> {
  const map = new Map<string, string>(TOKENS);
  for (const name of inkTokens) map.set(name, INK);
  for (const name of groundTokens) map.set(name, SUBSTRATE);
  return map;
}

const MONO_MAP = remap(MONO_INK_TOKENS, MONO_GROUND_TOKENS);
const SILHOUETTE_MAP = remap(SILHOUETTE_INK_TOKENS, ['--fab-substrate']);

function cssRemap(inkTokens: readonly string[], groundTokens: readonly string[]): string {
  const lines = [
    ...inkTokens.map((name) => `  ${name}: ${INK};`),
    ...groundTokens.map((name) => `  ${name}: ${SUBSTRATE};`),
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * The columns
 * ------------------------------------------------------------------ */

type ColumnId = 'a' | 'b' | 'c' | 'd' | 'shipped';

interface Column {
  id: ColumnId;
  /** The header name. C and D are named symmetrically: naming the shared route is honest. */
  name: string;
  /** The hand-authored 16px cut. Feeds the 1:1 tile and the magnified tile. */
  file16: string;
  /** The full cut. Feeds every 32px and 96px tile, and the 16px control tile. */
  fileFull: string;
  /** The caption under the third tile of the 16px cell. */
  controlCaption: string;
  /** One line of 12px bold copy under the monochrome tile, stating what was lost. */
  monoLoss: string;
  /**
   * What waves 1 and 2 measured about this candidate, stated beside its 16px tiles.
   *
   * A FUNCTION HERE IS RESOLVED AT RENDER TIME, AND THAT IS THE POINT (WR-02). A hardcoded
   * finding is a hand-typed transcription of a measurement, and plan 80-05 proved what that
   * costs: the shipped column's caption kept asserting "FAIL on three of the four rules"
   * about a mark that had been replaced by one passing all four, three times over in a
   * committed artefact whose whole purpose is to be read by a human making a judgement. The
   * four candidate captions below are hand-authored because they describe DRAWINGS, which do
   * not move; the shipped column's is a function because it describes a MEASUREMENT, which
   * does.
   */
  finding: string | (() => string);
}

const CONTROL_CAPTION = 'scaled from 96px - control, not a candidate';
const ONE_DRAWING_CAPTION = 'one drawing - this IS the 96px cut';

/**
 * CANDIDATE D IS A PEER, ENFORCED BY CONSTRUCTION rather than by intention (D-02). Same column
 * width, same tile size, same header weight and size, same vertical position as A, B and C,
 * and named symmetrically with C. If the reviewer names D, that one answer settles both the route and
 * the drawing style, and Phase 80 authors the mark in the pixel-grid look. There is no style
 * variants sub-section, no nested tile inside C's column, no indent, no smaller tile and no
 * appendix anywhere in this file.
 *
 * The fifth column is the shipped mark, labelled as a reference rather than a candidate.
 *
 * WHERE THE ALWAYS-FAILING COLUMN IS, CORRECTED IN PLACE (WR-02). This paragraph read: "It
 * fails three of the four rules, so there is ALWAYS at least one visibly failing column on
 * the sheet: a failure treatment that silently rendered nothing could not go unnoticed."
 * That was true of the Phase 59 tile and stopped being true the moment plan 80-05 shipped
 * composition A, which passes all four rules and contributes no failing chip at all.
 *
 * The device did not depend on that column and is intact: Candidate B's `b-the-turn-16.svg`
 * measures R4 OVERLAP, which is a non-PASS verdict, and it carries the destructive left rule
 * in all eight render sections. `e2e/mark-sheet.spec.ts`'s `failing` case derives the failing
 * set FROM THE PAGE and asserts it non-empty first, so it measures this rather than trusting
 * it. What this comment used to do instead was NAME a guarantee, which is how it came to name
 * one it no longer provided; the guarantee is now ASSERTED at build time by the throw beneath
 * `VERDICTS`, so a sheet on which everything passes cannot be written at all.
 */
const COLUMNS: readonly Column[] = [
  {
    id: 'a',
    name: 'A - The Port Square',
    file16: 'a-port-square-16.svg',
    fileFull: 'a-port-square-full.svg',
    controlCaption: CONTROL_CAPTION,
    monoLoss: 'item survives, 1px from the ring',
    finding:
      'Measured at 16px: the item is a 6u square that hangs 2u off the left edge of the box, ' +
      'which is the half in, half out read this route is built on, and it is why the axis run ' +
      'inside the live area measures 4u rather than 6u. With the accent gone the item and the ' +
      'ring are the same ink separated by one device pixel, the tightest adjacency on this sheet.',
  },
  {
    id: 'b',
    name: 'B - The Turn',
    file16: 'b-the-turn-16.svg',
    fileFull: 'b-the-turn-full.svg',
    controlCaption: CONTROL_CAPTION,
    monoLoss: 'item gone - the band is the whole mark',
    finding:
      'Measured at 16px: the gap rule reports OVERLAP. Once the hollow is gone at this size ' +
      'there is nowhere for the item to sit except on the band, so it rides inside the ink ' +
      'instead of clearing it. In monochrome at 16px this candidate is a bare L with nothing ' +
      'inside it. Both are properties of Route 2 at this size and neither was repaired.',
  },
  {
    id: 'c',
    name: 'C - The Board (clean vector)',
    file16: 'c-the-board-16.svg',
    fileFull: 'c-the-board-full.svg',
    controlCaption: CONTROL_CAPTION,
    monoLoss: 'sink no longer distinguished - three equal blocks',
    finding:
      'Measured at 16px: dropping the outlined source is what buys three legible shapes, so ' +
      'this cut can no longer say which cell is a machine and which is a belt. At 96px the ' +
      'source is a stroked frame and the belt cells are solid, so the two differ by stroke ' +
      'against fill and never by hue.',
  },
  {
    id: 'd',
    name: 'D - The Board (pixel-grid look)',
    file16: 'd-the-board-pixel.svg',
    fileFull: 'd-the-board-pixel.svg',
    controlCaption: ONE_DRAWING_CAPTION,
    monoLoss: 'sink no longer distinguished',
    finding:
      'Measured at 16px: the belt run reads about as much like the digit 1 as like a belt. The ' +
      'top arm is 6u, the vertical run is 4u, and the bottom foot extends only 2u past the run, ' +
      'which is the shape of a serif. One drawing serves 16px, 32px and 96px here, where A, B ' +
      'and C each need two. That is the shape budget the pixel idiom forces, recorded as a ' +
      'finding rather than redrawn to taste.',
  },
  {
    id: 'shipped',
    name: 'SHIPPED (today) - not a candidate',
    file16: 'logomark.svg',
    fileFull: 'logomark.svg',
    controlCaption: ONE_DRAWING_CAPTION,
    monoLoss: 'a light square with dark lines',
    finding: shippedFinding,
  },
];

/* ------------------------------------------------------------------ *
 * Reading a drawing off disk
 * ------------------------------------------------------------------ */

interface Drawing {
  /** The bare filename, written into `data-candidate`. */
  file: string;
  /** The inlined `<svg>` element, provenance comment stripped. */
  svg: string;
  /** SHA-256 of the file as read at build time, written into `data-sha256`. */
  sha256: string;
}

function sourcePath(file: string): string {
  return file === 'logomark.svg' ? SHIPPED_MARK : join(CANDIDATES_DIR, file);
}

/**
 * Read one drawing, or `null` when the file is absent.
 *
 * A MISSING DRAWING IS NOT A DROPPED COLUMN. A silently dropped column reads as a
 * three-candidate sheet, which is a lie the reader has no way to detect. The caller renders
 * the named missing-drawing copy on a failure ground instead.
 */
function readDrawing(file: string): Drawing | null {
  const path = sourcePath(file);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const open = text.indexOf('<svg');
  if (open === -1) {
    throw new Error(`build-mark-sheet: ${file} carries no <svg> element`);
  }
  return {
    file,
    // The provenance comment is stripped rather than carried: it is authoring documentation,
    // it is long, and the shipped logomark.svg's header carries a doubled hyphen that is
    // illegal inside an XML comment.
    svg: text.slice(open).trim(),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

const DRAWINGS = new Map<string, Drawing | null>();
for (const column of COLUMNS) {
  for (const file of [column.file16, column.fileFull]) {
    if (!DRAWINGS.has(file)) DRAWINGS.set(file, readDrawing(file));
  }
}

/* ------------------------------------------------------------------ *
 * The literal-colour copy that feeds the magnified tile's canvas
 * ------------------------------------------------------------------ */

/**
 * A canvas image source is loaded through the SAME boundary an image element uses, so a
 * token-painted SVG handed to `drawImage` resolves no custom properties and paints black.
 * The fix is here in the generator, which already holds the baked token table: emit a second,
 * LITERAL-COLOUR copy of the same markup as the canvas source, with the tokens resolved for
 * whichever cut the tile belongs to. The on-page 1:1 tile stays token-painted, so the remap
 * keeps working; only the canvas source is literal.
 */
function literalise(svg: string, map: Map<string, string>): string {
  const sized = svg.replace(/^<svg\s/, '<svg width="16" height="16" ');
  return sized.replace(/var\((--fab-[a-z0-9-]+)\)/g, (_whole: string, name: string): string => {
    const value = map.get(name);
    if (value === undefined) {
      throw new Error(
        `build-mark-sheet: ${name} has no baked value, so the magnified canvas source would ` +
          'paint black rather than the candidate',
      );
    }
    return value;
  });
}

function magnifySource(svg: string, map: Map<string, string>): string {
  const literal = literalise(svg, map);
  return `data:image/svg+xml;base64,${Buffer.from(literal, 'utf8').toString('base64')}`;
}

/* ------------------------------------------------------------------ *
 * Verdicts
 * ------------------------------------------------------------------ */

type VerdictState = 'pass' | 'overlap' | 'fail';

const RULE_KEYS = ['r1', 'r2', 'r3', 'r4'] as const;
type RuleKey = (typeof RULE_KEYS)[number];

const RULE_LABEL: Record<RuleKey, string> = {
  r1: 'R1 shapes',
  r2: 'R2 axis',
  r3: 'R3 diagonal',
  r4: 'R4 gap',
};

interface ColumnVerdict {
  state: VerdictState;
  /** The chip lines. One line for a pass or an overlap, one per failing rule for a failure. */
  chipLines: string[];
  /** The plain-text measurement lines printed beneath the 1:1 tile. */
  tileLines: string[];
}

const MEASUREMENTS = measureAll();

function measurementFor(file: string): CutMeasurement {
  const found = MEASUREMENTS.find((cut) => cut.file === file);
  if (found === undefined) {
    throw new Error(`build-mark-sheet: mark-craft measured no cut named ${file}`);
  }
  return found;
}

/**
 * One chip or tile line, e.g. `FAIL R4 gap 1u`, `FAIL R1 shapes 5`, `OVERLAP R4 gap`.
 *
 * The rule is named in FULL rather than abbreviated to a letter, and never rendered as a bare
 * icon or a bare colour: read in greyscale the words still separate the three states.
 */
function ruleCell(rule: RuleKey, v: Verdict): string {
  const kind = v.kind === 'NA' ? 'n/a' : v.kind;
  if (v.value === null) return `${kind} ${RULE_LABEL[rule]}`;
  return `${kind} ${RULE_LABEL[rule]} ${v.unit === 'u' ? `${v.value}u` : `${v.value}`}`;
}

/**
 * The column's verdict, derived from the measured 16px cut.
 *
 * `INFO` and `n/a` are not failures and print nothing: `INFO` is what the shape rule reports
 * on a full cut because the three-shape ceiling is a 16px rule, and `n/a` is what the diagonal
 * rule reports on a cut with no diagonal. `OVERLAP` is its own state and is NEVER rendered as
 * a pass.
 */
function columnVerdict(file: string): ColumnVerdict {
  const cut = measurementFor(file);
  const failing: RuleKey[] = [];
  const overlapping: RuleKey[] = [];
  for (const rule of RULE_KEYS) {
    const kind = cut[rule].kind;
    if (kind === 'FAIL') failing.push(rule);
    else if (kind === 'OVERLAP') overlapping.push(rule);
  }
  const named = [...failing, ...overlapping];
  const tileLines = named.map((rule) => {
    const v = cut[rule];
    const why = v.why === '' ? '' : ` - ${v.why}`;
    return `${ruleCell(rule, v)}${why}`;
  });
  if (failing.length > 0) {
    return { state: 'fail', chipLines: named.map((rule) => ruleCell(rule, cut[rule])), tileLines };
  }
  if (overlapping.length > 0) {
    return { state: 'overlap', chipLines: named.map((rule) => ruleCell(rule, cut[rule])), tileLines };
  }
  return { state: 'pass', chipLines: ['PASS 4/4'], tileLines: [] };
}

const VERDICTS = new Map<ColumnId, ColumnVerdict>();
for (const column of COLUMNS) VERDICTS.set(column.id, columnVerdict(column.file16));

function verdictOf(id: ColumnId): ColumnVerdict {
  const v = VERDICTS.get(id);
  if (v === undefined) throw new Error(`build-mark-sheet: no verdict for column ${id}`);
  return v;
}

/**
 * THE SHEET'S ANTI-VACUITY DEVICE, ASSERTED RATHER THAN CLAIMED (WR-02).
 *
 * The `COLUMNS` docblock used to state, in prose, that at least one column is always visibly
 * failing, and that this is what stops a failure treatment which renders nothing from going
 * unnoticed. A stated guarantee is not a guarantee: the sentence outlived the mark it was
 * true of by an entire plan, in a committed artefact, and the only reason the property itself
 * survived is that Candidate B happens to measure OVERLAP.
 *
 * So the generator now REFUSES to write a sheet on which every column passes. Every failure
 * treatment on this page - the chip, its wording, and the destructive left rule the cell
 * carries in all eight render sections - is exercised by whichever columns land here, and a
 * page that exercised none of them would be grading four drawings with an untested renderer.
 *
 * WHY THIS THROWS RATHER THAN WARNS. `npm run build:mark-sheet` has a byte-identity gate over
 * the committed HTML, so a warning printed to stderr is a warning nobody reads. A throw leaves
 * the committed sheet untouched and exits non-zero.
 */
const NON_PASS_COLUMNS: readonly Column[] = COLUMNS.filter(
  (column) => verdictOf(column.id).state !== 'pass',
);
if (NON_PASS_COLUMNS.length === 0) {
  throw new Error(
    'build-mark-sheet: every column on the sheet measured PASS, so no failure chip and no ' +
      'failure rule is rendered anywhere on the page. A failure treatment that rendered ' +
      'nothing would go unnoticed, which is the one thing this sheet cannot afford. Put a ' +
      'genuinely failing drawing back on the sheet, or delete this device and say so.',
  );
}

/**
 * The shipped column's finding, DERIVED from the live measurement instead of typed (WR-02).
 *
 * Every number in the returned sentence comes from `measureAll()` at build time, and the
 * closing sentence names the failing column by reading `NON_PASS_COLUMNS` rather than by
 * asserting which one it is. A future mark that fails a rule flips this caption on its own.
 *
 * The superseded claim is QUOTED, not deleted, per the doctrine every other correction in
 * this phase followed: a reader who finds the old numbers elsewhere needs to be told they
 * moved rather than left to wonder which record is current.
 */
function shippedFinding(): string {
  const cut = measurementFor('logomark.svg');
  const measured = RULE_KEYS.map((rule) => ruleCell(rule, cut[rule])).join(', ');
  const others = NON_PASS_COLUMNS.filter((column) => column.id !== 'shipped').map((c) => c.name);
  const device =
    verdictOf('shipped').state === 'pass'
      ? 'It contributes no failing chip to this page. The visibly failing column is ' +
        `${others.join(', ')}, and the generator throws rather than write a sheet on which ` +
        'every column passes, which is what stops a failure treatment that renders nothing ' +
        'from going unnoticed.'
      : 'It is one of the visibly failing columns on this page, which is what stops a failure ' +
        'treatment that renders nothing from going unnoticed.';
  return (
    'On this sheet as a reference and not as a candidate. Measured live at build time: ' +
    `${measured}. This caption read "It measures FAIL on three of the four rules: 5 shapes ` +
    'against a ceiling of 3, a 2u diagonal against a 4u minimum, and a 1u gap against a 2u ' +
    'minimum" until plan 80-05 replaced the drawing. Those numbers belong to the Phase 59 ' +
    'tile, retired by 80-MARK-LOCK-SUPERSESSION.md and kept as a measured fixture at ' +
    'src/render/assets/__fixtures__/craft/retired-logomark-59.svg. ' +
    device
  );
}

/* ------------------------------------------------------------------ *
 * The sections
 * ------------------------------------------------------------------ */

type Cut = 'colour' | 'mono' | 'silhouette';

interface SectionSpec {
  /** The `data-section` value. The DOM order of these IS the reading order. */
  id: string;
  heading: string;
  size: 16 | 32 | 96;
  cut: Cut;
  /** The tile-id suffix, so a repeated row does not collide with the row it repeats. */
  suffix: string;
  /** Whether the 16px three-tile cell is rendered (1:1, magnified, control). */
  triple: boolean;
  /** One descriptive line under the section heading, or the empty string. */
  note: string;
}

const RENDER_SECTIONS: readonly SectionSpec[] = [
  {
    id: '16-colour',
    heading: '16PX - COLOUR',
    size: 16,
    cut: 'colour',
    suffix: 'colour',
    triple: true,
    note: 'The first render on this page. Nothing precedes it but the masthead.',
  },
  {
    id: '16-mono',
    heading: '16PX - MONOCHROME',
    size: 16,
    cut: 'mono',
    suffix: 'mono',
    triple: true,
    note: 'The same drawings with one ink. A mark that needs its accent to be legible has failed.',
  },
  { id: '32-colour', heading: '32PX - COLOUR', size: 32, cut: 'colour', suffix: 'colour', triple: false, note: '' },
  { id: '32-mono', heading: '32PX - MONOCHROME', size: 32, cut: 'mono', suffix: 'mono', triple: false, note: '' },
  {
    id: '32-silhouette',
    heading: '32PX - SILHOUETTE',
    size: 32,
    cut: 'silhouette',
    suffix: 'silhouette',
    triple: false,
    note: 'Every paint collapses to one ink, outline and shadow edge included. Two candidates sharing a silhouette here means one of them is redundant.',
  },
  { id: '96-colour', heading: '96PX - COLOUR', size: 96, cut: 'colour', suffix: 'colour', triple: false, note: '' },
  { id: '96-mono', heading: '96PX - MONOCHROME', size: 96, cut: 'mono', suffix: 'mono', triple: false, note: '' },
];

/**
 * LAST ON THE PAGE, and a deliberate departure from `79-UI-SPEC.md`'s ordering list, which
 * ends at the verdict. `79-VALIDATION.md` requires the sheet to end with a repeat of the 16px
 * row so that success criterion 3's "the 16px cut of the chosen route is what they looked at
 * last" is a property of the page rather than a hope about a human's attention.
 */
const REPEAT_SECTION: SectionSpec = {
  id: '16-colour-repeat',
  heading: '16PX - COLOUR, AGAIN',
  size: 16,
  cut: 'colour',
  suffix: 'repeat',
  triple: true,
  note: 'The last thing on this page is the first thing that mattered.',
};

/* ------------------------------------------------------------------ *
 * HTML helpers
 * ------------------------------------------------------------------ */

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tileId(column: ColumnId, size: number, kind: string, suffix: string): string {
  // The 1:1 tile is `{column}-{size}-{suffix}`; the two inspection tiles carry their own kind
  // and, on a repeated or remapped row, the suffix as well, so ids stay unique across sections.
  if (kind === '') return `${column}-${size}-${suffix}`;
  return suffix === 'colour' ? `${column}-${size}-${kind}` : `${column}-${size}-${kind}-${suffix}`;
}

function svgWrapper(drawing: Drawing): string {
  return (
    `<span class="tile-svg" data-candidate="${esc(drawing.file)}" data-sha256="${drawing.sha256}">` +
    `${drawing.svg}</span>`
  );
}

function missingCopy(column: Column, file: string): string {
  const letter = column.id === 'shipped' ? 'SHIPPED' : column.id.toUpperCase();
  return (
    `<p class="missing">Candidate ${esc(letter)}: drawing not found at candidates/${esc(file)}. ` +
    'The sheet is incomplete and the vote does not proceed. Author the file, re-run node ' +
    'frontend/scripts/mark-craft.ts, reload.</p>'
  );
}

function plainTile(column: Column, spec: SectionSpec, file: string, kind: string, caption: string): string {
  const drawing = DRAWINGS.get(file) ?? null;
  const id = tileId(column.id, spec.size, kind, spec.suffix);
  if (drawing === null) return missingCopy(column, file);
  return (
    `<div class="tile tile-${spec.size}" data-tile="${id}">${svgWrapper(drawing)}</div>` +
    `<p class="cap">${esc(caption)}</p>`
  );
}

function magnifiedTile(column: Column, spec: SectionSpec): string {
  const drawing = DRAWINGS.get(column.file16) ?? null;
  const id = tileId(column.id, spec.size, 'magnified', spec.suffix);
  if (drawing === null) return '';
  const map = spec.cut === 'mono' ? MONO_MAP : spec.cut === 'silhouette' ? SILHOUETTE_MAP : TOKENS;
  const source = magnifySource(drawing.svg, map);
  return (
    `<div class="tile tile-mag" data-tile="${id}">${svgWrapper(drawing)}` +
    `<canvas class="mag" width="64" height="64" data-magnify="${source}"></canvas></div>` +
    `<p class="cap" data-magnify-caption="${esc(id)}">the 16px render, 4x nearest-neighbour</p>`
  );
}

function tileLinesBlock(column: Column): string {
  const verdict = verdictOf(column.id);
  if (verdict.tileLines.length === 0) return '';
  return (
    '<div class="measured">' +
    verdict.tileLines.map((line) => `<p class="measured-line">${esc(line)}</p>`).join('') +
    '</div>'
  );
}

function cellBody(column: Column, spec: SectionSpec): string {
  if (!spec.triple) {
    const file = spec.size === 16 ? column.file16 : column.fileFull;
    const caption = `${spec.size}px, 1:1`;
    const parts = [plainTile(column, spec, file, '', caption)];
    if (spec.cut === 'mono') parts.push(`<p class="loss">${esc(column.monoLoss)}</p>`);
    return parts.join('');
  }
  const parts = [
    plainTile(column, spec, column.file16, '', '16px, 1:1 - this is what you get'),
    tileLinesBlock(column),
    magnifiedTile(column, spec),
    plainTile(column, spec, column.fileFull, 'control', column.controlCaption),
  ];
  if (spec.cut === 'mono') parts.push(`<p class="loss">${esc(column.monoLoss)}</p>`);
  const finding = typeof column.finding === 'function' ? column.finding() : column.finding;
  parts.push(`<p class="finding">${esc(finding)}</p>`);
  return parts.join('');
}

function chip(column: Column): string {
  const verdict = verdictOf(column.id);
  const lines = verdict.chipLines.map((line) => `<span class="chip-line">${esc(line)}</span>`).join('');
  return `<div class="chip chip-${verdict.state}" data-verdict="${verdict.state}">${lines}</div>`;
}

function columnBlock(column: Column, spec: SectionSpec): string {
  const verdict = verdictOf(column.id);
  // THE 4px FAILURE RULE IS PAINTED ON THE COLUMN CELL WRAPPER, NEVER ON THE TILE. A
  // Playwright element screenshot captures the border box, so a 4px rule on a `data-tile`
  // element would make a 16px tile measure 20 by 16 and redden plan 79-04's honesty probe for
  // exactly the two columns this sheet is built around. The cheap repair when that happens is
  // to weaken the probe, and the probe is this phase's central honesty claim. Wrapper carries
  // the rule; tile carries nothing but the mark.
  const failing = verdict.state === 'pass' ? '' : ' data-failure-rule="1"';
  return (
    `<div class="col" data-column="${column.id}">` +
    `<div class="col-head"><p class="col-name">${esc(column.name)}</p>${chip(column)}</div>` +
    `<div class="cell"${failing}>${cellBody(column, spec)}</div>` +
    '</div>'
  );
}

function sectionBlock(spec: SectionSpec): string {
  const cutClass = spec.cut === 'colour' ? '' : ` ${spec.cut}`;
  const columns: string[] = [];
  for (const column of COLUMNS) {
    if (column.id === 'shipped') columns.push('<div class="sep"></div>');
    columns.push(columnBlock(column, spec));
  }
  const note = spec.note === '' ? '' : `<p class="section-note">${esc(spec.note)}</p>`;
  return (
    `<section class="section${cutClass}" data-section="${spec.id}">` +
    `<h2>${esc(spec.heading)}</h2>${note}` +
    `<div class="row">${columns.join('')}</div>` +
    '</section>'
  );
}

/* ------------------------------------------------------------------ *
 * The craft table and the two closing sections
 * ------------------------------------------------------------------ */

const CRAFT_HEADERS = ['input', 'R1 shapes', 'R2 axis', 'R3 diagonal', 'R4 gap'] as const;

function craftSection(): string {
  const head = CRAFT_HEADERS.map((h) => `<th>${esc(h)}</th>`).join('');
  const rows = MEASUREMENTS.map((cut) => {
    const cells = RULE_KEYS.map((rule) => {
      const v = cut[rule];
      const kind = v.kind === 'NA' ? 'na' : v.kind.toLowerCase();
      return `<td class="v-${kind}">${esc(v.text)}</td>`;
    }).join('');
    return `<tr><td class="craft-file">${esc(cut.file)}</td>${cells}</tr>`;
  }).join('');
  const why: string[] = [];
  for (const cut of MEASUREMENTS) {
    for (const rule of RULE_KEYS) {
      const v = cut[rule];
      if (v.why !== '') why.push(`<li>${esc(`${cut.file}  ${RULE_LABEL[rule]}: ${v.why}`)}</li>`);
    }
  }
  return (
    '<section class="section" data-section="craft">' +
    '<h2>CRAFT RULES, MEASURED</h2>' +
    '<p class="section-note">Generated by a live mark-craft run at build time. This note read ' +
    '"the shipped row fails three of the four rules, and it stays: it is the evidence this ' +
    'check can fail at all" until plan 80-05 replaced the mark. The shipped row passes all ' +
    'four rules now, and the evidence this check can fail is the retired Phase 59 geometry, ' +
    'measured at FAIL 5 shapes / PASS 26u / FAIL 2u / FAIL 1u by ' +
    'src/render/assets/markCraft.test.ts. It is not pinned here on purpose: a pin is a number ' +
    'an executor can edit, and a measurement is not.</p>' +
    `<table class="craft"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` +
    `<ul class="why">${why.join('')}</ul>` +
    '</section>'
  );
}

const MISMATCHES = diffAgainstExpectations(MEASUREMENTS);

const STALE_HEADLINE = 'mark-craft expectations mismatch - this sheet is not fit to vote on';

function verdictSection(): string {
  if (MISMATCHES.length > 0) {
    const list = MISMATCHES.map((m) => `<li>${esc(formatMismatch(m))}</li>`).join('');
    return (
      '<section class="section" data-section="verdict">' +
      '<h2>THE VERDICT</h2>' +
      `<p class="stale-body">${esc(STALE_HEADLINE)}</p><ul class="why">${list}</ul>` +
      '<p class="stale-body">Fix the drawing, or change the expectation deliberately and say why ' +
      'in the commit.</p>' +
      '</section>'
    );
  }
  return (
    '<section class="section" data-section="verdict">' +
    '<h2>THE VERDICT</h2>' +
    '<h3 class="empty-heading">Verdict: not yet recorded</h3>' +
    '<p class="empty-body">The reviewer names one route. Their reason, and the reason each of the other ' +
    'three lost, are written to 79-VERDICT.md. Nothing downstream reads this sheet; Phase 80 ' +
    'reads the verdict.</p>' +
    '</section>'
  );
}

/**
 * The banner's own style rules, emitted ONLY when the banner is emitted.
 *
 * A dormant `#stale-banner` rule sitting in the stylesheet of a healthy sheet would make the
 * string present in the file at all times, and the cheapest check for "this sheet is fit to
 * vote on" is a grep for that id. Keeping the rules with the element means the id appears in
 * the artefact if and only if the sheet is refusing to be voted on.
 */
function staleStyles(): string {
  if (MISMATCHES.length === 0) return '';
  return `#stale-banner {
  background: ${DESTRUCTIVE};
  color: ${SUBSTRATE};
  font-weight: 700;
  padding: 16px 24px;
  margin: 0 0 32px 0;
}
#stale-banner ul { margin-top: 8px; font-weight: 400; }
`;
}

function staleBanner(): string {
  if (MISMATCHES.length === 0) return '';
  const list = MISMATCHES.map((m) => `<li>${esc(formatMismatch(m))}</li>`).join('');
  return `<div id="stale-banner"><p>${esc(STALE_HEADLINE)}</p><ul>${list}</ul></div>`;
}

/* ------------------------------------------------------------------ *
 * The masthead
 * ------------------------------------------------------------------ */

const CRAFT_RULES = [
  'R1 shapes: at most 3 distinct shapes inside the live area',
  'R2 axis: every axis-aligned ink run is at least 2u wide',
  'R3 diagonal: every diagonal stroke is at least 4u wide',
  'R4 gap: any two shapes clear each other by at least 2u',
] as const;

/**
 * WHAT THE MASTHEAD STAMPS, AND WHY IT IS NOT A DATE (plan 80-05).
 *
 * It used to read `Built ${now.toISOString().slice(0, 10)}`, taken from wall clock. That
 * made this generator NON-DETERMINISTIC in exactly one line, and the cost landed on the
 * gate rather than on the page: `npm run build:mark-sheet` followed by
 * `test -z "$(git status --porcelain -- frontend/mark-sheet.html)"` failed on every day
 * after the sheet was last committed, whatever the drawings said. Plan 80-03 measured it
 * precisely - ONE line differed, line 252, `Built 2026-09-05` against `Built 2026-09-06`;
 * line counts equal, all 70 content digests identical, every verdict chip identical - and
 * handed the repair to this plan, which owns the artefact.
 *
 * A GATE THAT ASSERTS THE CALENDAR CANNOT ALSO ASSERT THE ARTWORK. The choice was to
 * weaken the gate or to fix the generator, and weakening a byte-identity gate on a
 * generated file leaves it unable to tell a changed mark from a changed day - which is the
 * one distinction it exists to make. So the stamp is derived from the INPUTS instead: a
 * digest over every inlined drawing's own content hash, in a fixed order. It is
 * deterministic, so the gate now measures the drawing; and it is strictly more useful than
 * a date, because it names WHICH drawings the page was built from rather than when the
 * process happened to run. A drawing edited after the sheet was generated moves this stamp,
 * and `mark-sheet.spec.ts`'s per-tile digest walk names the file that moved.
 */
function inputStamp(): string {
  const hash = createHash('sha256');
  for (const file of [...DRAWINGS.keys()].sort()) {
    const drawing = DRAWINGS.get(file) ?? null;
    hash.update(`${file}:${drawing === null ? 'absent' : drawing.sha256}\n`);
  }
  const present = [...DRAWINGS.values()].filter((d) => d !== null).length;
  return `Built from ${present} drawings, input digest ${hash.digest('hex').slice(0, 12)}`;
}

function masthead(buildDate: string): string {
  const rules = CRAFT_RULES.map((r) => `<li>${esc(r)}</li>`).join('');
  const pinned = MISMATCHES.length === 0
    ? `mark-craft: ${MEASUREMENTS.length} cuts measured, 0 mismatches against the pin`
    : `mark-craft: ${MISMATCHES.length} mismatches against the pin`;
  return (
    '<header id="masthead">' +
    '<h1>PHASE 79 - THE ROUTE IS CHOSEN</h1>' +
    '<p class="instruct">Look at the 16px row first. Then look at it in monochrome. Then name one.</p>' +
    `<ul class="rules">${rules}</ul>` +
    '<div class="readouts">' +
    // `data-dpr` carries NOTHING at build time. The page's own script writes the live value
    // into it, and mirrors it onto `document.documentElement`. The id is what the spec and the
    // evidence capture select on: once the mirror lands, a bare `[data-dpr]` selector matches
    // `<html>` first, because `<html>` is an ancestor of this element.
    '<p class="readout" id="dpr-readout" data-dpr>devicePixelRatio has not been read yet</p>' +
    `<p class="readout ${MISMATCHES.length === 0 ? 'readout-ok' : 'readout-bad'}">${esc(pinned)}</p>` +
    `<p class="readout">${esc(buildDate)}</p>` +
    '</div>' +
    '</header>'
  );
}

/* ------------------------------------------------------------------ *
 * Style
 * ------------------------------------------------------------------ */

/**
 * Column width, and the one number on this page that was chosen rather than inherited.
 *
 * Five columns at the spacing scale's 24px candidate gap and 32px shipped gap, plus the 1px
 * separator rule and 24px of page padding each side, come to 1265px at 216px per column, which
 * fits inside a 1280px viewport without horizontal scrolling. Raising it far enough to hold the
 * longest specified caption on ONE line would need roughly 330px per column, which puts the row
 * past 1900px and forces horizontal scrolling at 1280 - breaking the other half of the same
 * backstop. Captions therefore wrap at word boundaries. Nothing wraps mid-word and nothing is
 * ever truncated with an ellipsis: a truncated failure string is forbidden outright.
 */
const COL_W = 216;

function styleBlock(): string {
  return `${ROOT_BLOCK}

.mono {
${cssRemap(MONO_INK_TOKENS, MONO_GROUND_TOKENS)}
}

.silhouette {
${cssRemap(SILHOUETTE_INK_TOKENS, ['--fab-substrate'])}
}

@font-face {
  font-family: 'Martian Mono';
  src: url('./src/assets/fonts/MartianMono.woff2') format('woff2');
  font-weight: 100 800;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Sono';
  src: url('./src/assets/fonts/Sono.woff2') format('woff2');
  font-weight: 200 800;
  font-style: normal;
  font-display: block;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: ${SUBSTRATE};
  color: ${INK};
}

body {
  font-family: 'Martian Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  padding: 64px 24px;
}

h1, h2, h3 {
  font-family: 'Sono', ui-monospace, SFMono-Regular, monospace;
  font-weight: 700;
  text-transform: uppercase;
  margin: 0;
}
/* EVERY LINE BOX ON THIS PAGE IS A WHOLE NUMBER OF PIXELS, AND THAT IS A CORRECTNESS
   RULE RATHER THAN A STYLE CHOICE. A ratio line-height of 1.2 gives 21.6px on an 18px
   heading and 33.6px on a 28px one. Those fractions accumulate down the document, so
   every section after the first starts at a fractional y and every tile inside it
   rasterises across a device-pixel boundary. Measured before this rule existed: the
   96px colour tiles sat at y=3571.15625 and the 16px tiles at y=533.1875, so a tile
   captioned "16px, 1:1" was smeared over 17 device rows and carried blended ink levels
   that its own geometry, whose every coordinate is even, cannot produce. A sheet whose
   16px row is vertically antialiased is showing the reader something other than what it
   claims, which is the one thing this page exists not to do. Keep these integral. */
h1 { font-size: 28px; line-height: 34px; }
h2 { font-size: 18px; line-height: 22px; }
h3 { font-size: 18px; line-height: 22px; }

p, ul { margin: 0; }
ul { list-style: none; padding: 0; }

${staleStyles()}
#masthead { margin: 0 0 48px 0; }
#masthead .instruct { margin-top: 16px; }
#masthead .rules { margin-top: 16px; }
#masthead .readouts { margin-top: 16px; }
.readout { font-weight: 700; }
.readout-ok { color: ${INK}; }
.readout-bad { color: ${DESTRUCTIVE}; }

.section { margin: 0 0 48px 0; }
.section-note { margin-top: 4px; max-width: 900px; }
.row {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  margin-top: 16px;
}
.sep {
  width: 1px;
  align-self: stretch;
  background: ${NEUTRAL};
  margin: 0 8px;
  flex: none;
}

.col {
  width: ${COL_W}px;
  flex: none;
}
.col-head {
  height: 120px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-wrap: normal;
  word-break: normal;
  hyphens: none;
}
.col-name { font-weight: 700; }

.chip {
  display: inline-flex;
  flex-direction: column;
  align-self: flex-start;
  font-weight: 700;
  padding: 2px 6px;
}
.chip-line { display: block; white-space: nowrap; }
.chip-pass { background: ${PANEL}; color: ${INK}; }
.chip-overlap { background: ${NEUTRAL}; color: ${INK}; }
.chip-fail { background: ${DESTRUCTIVE}; color: ${SUBSTRATE}; }

.cell {
  background: ${PANEL};
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.cell[data-failure-rule="1"] {
  border-left: 4px solid ${DESTRUCTIVE};
  padding-left: 12px;
}

.tile {
  position: relative;
  background: ${SUBSTRATE};
  border: 0;
  margin: 0;
  padding: 0;
  flex: none;
}
.tile-16 { width: 16px; height: 16px; }
.tile-32 { width: 32px; height: 32px; }
.tile-96 { width: 96px; height: 96px; }
.tile-mag { width: 64px; height: 64px; }

.tile-svg { display: block; width: 100%; height: 100%; }
.tile-svg > svg { display: block; width: 100%; height: 100%; }
.tile-mag > .tile-svg { position: absolute; left: 0; top: 0; visibility: hidden; }
.tile-mag > canvas.mag {
  position: absolute;
  left: 0;
  top: 0;
  width: 64px;
  height: 64px;
  display: block;
}

.cap { margin-top: 4px; overflow-wrap: normal; word-break: normal; hyphens: none; }
.loss { font-weight: 700; }
.finding { margin-top: 8px; }
.measured { color: ${DESTRUCTIVE}; }
.measured-line { font-weight: 700; }
.missing {
  background: ${DESTRUCTIVE};
  color: ${SUBSTRATE};
  font-weight: 700;
  padding: 8px;
}

.craft { border-collapse: collapse; margin-top: 16px; font-variant-numeric: tabular-nums; }
.craft th, .craft td { text-align: left; padding: 4px 16px 4px 0; }
.craft th { font-weight: 700; }
.craft tbody tr:nth-child(odd) { background: ${PANEL}; }
.craft-file { font-weight: 700; }
.v-fail, .v-overlap { font-weight: 700; }
.v-fail { color: ${DESTRUCTIVE}; }
.why { margin-top: 16px; }
.stale-body { color: ${DESTRUCTIVE}; font-weight: 700; }
.empty-heading { margin-top: 16px; }
.empty-body { margin-top: 8px; max-width: 900px; }
`;
}

/* ------------------------------------------------------------------ *
 * The page script
 * ------------------------------------------------------------------ */

/**
 * Two jobs, and the first is the vacuity closest to the heart of this phase.
 *
 * THE LIVE DEVICE PIXEL RATIO. The whole sheet exists to show 16px honestly, and
 * `devicePixelRatio` is a property of the reader's browser and desktop scaling rather than of
 * the page. Without this readout the caption "16px, 1:1 - this is what you get" is an
 * assertion the page cannot back up.
 *
 * THE MAGNIFIED TILE. The actual 16px rasterisation enlarged, never the vector re-drawn at
 * 64px: draw the literal-colour source into a 16 by 16 canvas, then draw that canvas into a 64
 * by 64 canvas with smoothing off. If that path fails the tile falls back to the vector at
 * 64px AND the caption is rewritten to the weaker wording, because the stronger caption over
 * the weaker rendering is the lie this device exists to avoid.
 */
function pageScript(): string {
  return `
(function () {
  var readout = document.getElementById('dpr-readout');
  var dpr = window.devicePixelRatio;
  document.documentElement.setAttribute('data-dpr', String(dpr));
  if (readout !== null) {
    readout.setAttribute('data-dpr', String(dpr));
    if (dpr === 1) {
      readout.textContent = 'devicePixelRatio is 1 - every 16px tile is 16 device pixels';
      readout.className = 'readout readout-ok';
    } else {
      readout.textContent =
        'devicePixelRatio is ' + dpr +
        ', not 1 - the 16px row is being scaled and is not what you get';
      readout.className = 'readout readout-bad';
    }
  }

  function fallback(canvas) {
    canvas.setAttribute('data-magnified', 'vector');
    canvas.style.display = 'none';
    var tile = canvas.parentNode;
    var vector = tile.querySelector('.tile-svg');
    if (vector !== null) vector.style.visibility = 'visible';
    var id = tile.getAttribute('data-tile');
    var caption = document.querySelector('[data-magnify-caption="' + id + '"]');
    if (caption !== null) caption.textContent = 'geometry at 4x - NOT what 16px looks like';
  }

  function magnify(canvas) {
    var small = document.createElement('canvas');
    small.width = 16;
    small.height = 16;
    var source = small.getContext('2d');
    var target = canvas.getContext('2d');
    if (source === null || target === null) {
      fallback(canvas);
      return;
    }
    var image = new Image();
    image.onload = function () {
      try {
        source.clearRect(0, 0, 16, 16);
        source.drawImage(image, 0, 0, 16, 16);
        target.imageSmoothingEnabled = false;
        target.clearRect(0, 0, 64, 64);
        target.drawImage(small, 0, 0, 16, 16, 0, 0, 64, 64);
        canvas.setAttribute('data-magnified', 'raster');
      } catch (err) {
        fallback(canvas);
      }
    };
    image.onerror = function () {
      fallback(canvas);
    };
    image.src = canvas.getAttribute('data-magnify');
  }

  var canvases = document.querySelectorAll('canvas[data-magnify]');
  for (var i = 0; i < canvases.length; i++) magnify(canvases[i]);
})();
`;
}

/* ------------------------------------------------------------------ *
 * The build
 * ------------------------------------------------------------------ */

/** Returns the generated HTML. Pure: the caller decides whether to write it. */
export function buildSheet(): string {
  const buildDate = inputStamp();
  const sections = [
    ...RENDER_SECTIONS.map(sectionBlock),
    craftSection(),
    verdictSection(),
    sectionBlock(REPEAT_SECTION),
  ].join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fabrico - Phase 79, the route is chosen</title>
    <!--
      GENERATED FILE. Written by frontend/scripts/build-mark-sheet.ts and regenerated rather
      than edited: run npm run build:mark-sheet. Every candidate is inlined from its file on
      disk, every token is baked from LOCKED_SKIN, and every craft verdict comes from a live
      mark-craft run, so nothing on this page is transcribed and nothing can drift from the
      files it describes. DELIBERATELY NO NUMBERS IN THIS COMMENT: the generator is the
      authoritative source for the column set, the sizes and the thresholds, and a comment that
      restates a constant is a second source of truth that nothing keeps honest.

        - Root level, so Vite serves it in dev at /mark-sheet.html.
        - NEVER a build input. vite.config.ts declares no extra rollup inputs, so index.html is
          the only one and this page is STRUCTURALLY absent from dist.
        - NEVER imported by App.tsx or main.tsx. No query flag, no mount, no global, no
          keybinding.
        - A COMPARISON INSTRUMENT. It measures and it describes. It ranks nothing and it
          records nothing; the only record of a choice is the verdict the reviewer writes.
    -->
    <style>
${styleBlock()}
    </style>
  </head>
  <body>
${staleBanner()}
${masthead(buildDate)}
${sections}
    <script>${pageScript()}</script>
  </body>
</html>
`;
}

export function writeSheet(): string {
  const html = buildSheet();
  writeFileSync(SHEET_PATH, html, 'utf8');
  return html;
}

// `import.meta.main` is true only under bare `node scripts/build-mark-sheet.ts`; under Vite and
// vitest it is undefined, so importing this module never writes a file. Deliberately NOT an
// argv comparison: this generator reads no argv at all.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  const html = writeSheet();
  const tiles = (html.match(/data-tile="/g) ?? []).length;
  process.stdout.write(
    `build-mark-sheet  ${COLUMNS.length} columns, ${RENDER_SECTIONS.length + 3} sections, ` +
      `${tiles} tiles, ${MISMATCHES.length} pin mismatches\n`,
  );
  if (MISMATCHES.length > 0) process.exitCode = 1;
}
