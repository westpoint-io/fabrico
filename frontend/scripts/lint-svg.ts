// lint-svg.ts - the constrained-SVG authoring lint (VEC-02 / VEC-03, plan 56-04).
//
// One PURE walker, two callers: `npm run lint:svg` for the local authoring loop and
// src/render/assets/lintSvg.test.ts so `npm test` and the CI unit job enforce the same
// rules with no new CI job. The rules are the authoring contract Phase 57's board
// candidates and Phase 58's shipped assets are written against; they exist and bite
// BEFORE any art is authored so the locked direction needs no retrofit.
//
// HOUSE STYLE, AND THE ONE DELIBERATE DIVERGENCE. This follows synth/skin.ts's
// `validate()`: a const rule list in the TREAD_PATTERNS idiom, one cheap
// predicate per checkable property, the `<subject>: <what is required>` message grammar,
// no zod and no new dependency. It diverges on exactly ONE axis: `validate()` is
// first-fail and throws on the first bad axis, whereas this lint is REPORT-ALL and
// accumulates into a Violation[]. A first-fail lint makes an asset author iterate N
// times to discover N problems. The message grammar is inherited; the control flow is not.
//
// THE OUTPUT IS A UX SURFACE, not a log line. Its reader is whoever authors an
// asset next. `SVG validation failed` is a failure of this contract (56-UI-SPEC A.3): every
// violation is a greppable `path:line  what-was-found` locator plus one sentence saying
// why it fails AND what to do instead. No ANSI colour - this lands in CI logs and in
// saved plain-text logs.
//
// NO PATH INPUT, EVER (threat T-56-13). The asset directory is resolved from
// import.meta.url. The walker reads no argv and no cwd, so it cannot be pointed at an
// arbitrary directory - that would be both a path-traversal surface and a false-green
// source. Discovery is NON-RECURSIVE with an explicit `.svg` filter, which is also what
// keeps __fixtures__/ (deliberately non-conforming test inputs) and __digests__/ out of
// the production walk without a bespoke ignore list.
//
// Node 22.20 runs this file directly via native type stripping (the `node
// scripts/perf-capture.ts` precedent), so everything here is ERASURE-ONLY TypeScript:
// interfaces, type aliases, annotations and `import type` only - no enums, no
// namespaces, no parameter properties. Discovery uses node:fs; a Vite-only transform
// would work in the vitest caller and break under bare `node`.

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * The rule set
 * ------------------------------------------------------------------ */

/**
 * The thirteen rules in DECLARATION ORDER. This order is load-bearing twice: it is the
 * order rules are described in 56-UI-SPEC A.2, and it is the tie-break when two
 * violations land on the same source line, which is what makes the output byte-stable.
 *
 * ALL THIRTEEN ARE SEVERITY `fail`. `curve` was the sole `warn` until plan 58-02 and was
 * promoted deliberately - see `severityOf` for the decision and its two reasons.
 *
 * TWELVE OF THE THIRTEEN ARE SUBJECT-AGNOSTIC and run over every walked directory.
 * `chrome-ink` (plan 59-01) is the one exception and is opted into per walk, because the
 * two shipped directories carry genuinely different ink rules - see `LintOptions`.
 *
 * `even-coords` is NOT in this list, and that absence is a decision rather than an
 * omission. It is a SUBJECT-SCOPED rule (shipped machine art authored under
 * `58-UI-SPEC.md` sits on a 2u sub-module) and this walker is subject-agnostic by
 * design, exactly as `LEGAL_VIEWBOXES` records for the footprint check. Two committed
 * bodies of CORRECT SVG carry odd coordinates - `pilot.svg`, whose geometry is pinned by
 * a `maxDiffPixels: 0` baseline, and twelve of the thirty-two judged Phase 57 board
 * candidates, which are the artefact the maintainer actually judged - so the rule lives with the
 * subject table in `src/render/assets/shippedAssets.test.ts`, at fail severity, where it
 * can be true without thirteen exemptions.
 *
 * `comment-hyphen` (plan 80-05) is APPENDED, NEVER INSERTED. Declaration order is this
 * table's same-line tie-break, so a rule spliced into the middle would reorder the expected
 * violation list of every existing fixture that reports two findings on one line. Appending
 * is the one placement that adds a rule without moving a single pinned expectation.
 *
 * NOTHING BUT A QUOTED RULE ID BELONGS INSIDE THE ARRAY LITERAL, which is why this note
 * sits here rather than beside the id it is about. The acceptance gate for that plan reads
 * `RULE_IDS` by splitting the literal on commas, so a comma inside an inline comment there
 * makes a correct table parse as a wrong one.
 */
const RULE_IDS = [
  'malformed-xml',
  'viewbox',
  'transform',
  'banned-element',
  'path-only',
  'no-paths',
  'inline-style',
  'non-integer-coord',
  'data-part',
  'explicit-paint',
  // SCOPED TO `chrome/assets/` ONLY (plan 59-01). Every other rule in this table is
  // subject-agnostic and runs over both directories; this one runs only where the
  // caller asks for it, because the two directories have DIFFERENT ink rules and
  // pretending otherwise would make one of them wrong. See `LintOptions.chromeInk`.
  'chrome-ink',
  'one-element-per-line',
  'curve',
  'comment-hyphen',
] as const;

export type RuleId = (typeof RULE_IDS)[number];
export type Severity = 'fail' | 'warn';

export const RULES: readonly RuleId[] = RULE_IDS;

export interface Violation {
  /** Display path, always relative to frontend/src/ - never absolute (threat T-56-15). */
  path: string;
  /** 1-based source line. */
  line: number;
  rule: RuleId;
  severity: Severity;
  /** Terse what-was-found. Line 1 of the rendered violation. */
  message: string;
  /** One sentence: why it fails AND what to do instead. Line 2. */
  fix: string;
}

/**
 * EVERY RULE IS `fail`. `curve` was the one exception until plan 58-02 and is not any
 * more, and the promotion is recorded here rather than in a changelog because this is
 * the function it changes.
 *
 * THE DECISION. `57-ART-LOCK.md` section 5, ceiling 3, names raising `curve` from `warn`
 * to `fail` as a change to a shipped gate that **Phase 58 owns whether to make**. Phase
 * 58 makes it: RAISE. Two reasons, both measured rather than preferred:
 *
 *   1. THE POLICY THIS RULE WAS ABSTAINING FOR IS NOW LOCKED. The old severity existed
 *      because BOARD-02 had not yet committed to a corner-radius policy, so a curve might
 *      legitimately survive into the locked style. Axis 5 locks **radius 0, authored
 *      square, with zero curve commands**. Curve-freedom stopped being a preference the
 *      moment the art shipped, and a gate abstaining from a settled question is just a
 *      gate that does not fire.
 *   2. A CURVE IS A ZOOM DEFECT, NOT A STYLE CHOICE. Pixi's `buildAdaptiveBezier`
 *      tessellates at a hardcoded `const scale = 1` and the result is cached on the
 *      SHARED `GraphicsContext`. Scaling that context transforms the existing vertices
 *      rather than re-tessellating, so an authored arc serves stale, visibly faceted
 *      geometry at exactly the fractional zooms this milestone exists to fix. A warning
 *      about that is a warning nobody acts on until a user reports a bumpy circle.
 *
 * The `warn` half of `Severity` is KEPT rather than deleted. `formatViolation` still
 * renders the `warning: ` prefix, `report` still splits on severity, and a future
 * advisory rule needs a band to land in. `lintSvg.test.ts` asserts the band is currently
 * EMPTY, so "no rule is warn" is a checked fact rather than a stale comment.
 */
function severityOf(_rule: RuleId): Severity {
  return 'fail';
}

/** Elements Pixi 8.19's SVGParser mishandles, plus the ones the flat format forbids. */
const BANNED_ELEMENTS: readonly string[] = [
  'use',
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'filter',
  'image',
  'text',
  'style',
  'script',
  'foreignObject',
];

/** Attributes whose values are numeric geometry and must therefore be whole units. */
const GEOMETRIC_ATTRS: readonly string[] = [
  'd',
  'x',
  'y',
  'width',
  'height',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'stroke-width',
  'stroke-dasharray',
  'stroke-dashoffset',
];

/**
 * THE FOUR LEGAL viewBox VALUES, as literals. These are the distinct `(32w, 32h)` pairs
 * over the nine board subjects' BASE footprints, read from the exhaustive `base_footprint`
 * match at `crates/fabrico-core/src/state.rs:926` and mirrored at `synth/generators.ts:238`:
 * 1x1 -> `0 0 32 32`, 2x2 -> `0 0 64 64`, 2x3 (`Router`) -> `0 0 64 96`, 3x3 (`Factory`) ->
 * `0 0 96 96`. There is no 2x1, no 3x1 and no 3x2.
 *
 * DELIBERATELY NOT COMPUTED from `KIND_SPECS`, from the Rust source or from the fixture
 * directory. An assertion derived from the source it checks cannot fail - the same reason
 * `lintSvg.test.ts:33-38` states `EXPECTED_FIXTURE_COUNT` as a literal rather than reading
 * `RULES.length`. A generated whitelist would agree with a wrong footprint table.
 *
 * MEMBERSHIP IS EXACT STRING EQUALITY AGAINST THIS ARRAY AND MUST NEVER BECOME A REGEX.
 * The tempting "helpful generalisation" is `/^0 0 (\d+) (\d+)$/` with both capture groups
 * `% 32 === 0`. It passes every fixture, passes `pilot.svg` and passes every candidate -
 * and it silently legalises `0 0 96 64`, a TRANSPOSED `Router`: a multiple of 32 on both
 * axes and a footprint no machine has. `__fixtures__/lint/bad-viewbox-96x64.svg` exists
 * for exactly that mutation and is the only fixture in the set a regex would survive.
 *
 * CLOSED FOR PHASE 57 ART ONLY. `grow_to_fit` (PORT-07) can push a footprint past its base
 * when ports are added, up to `MAX_FOOTPRINT_DIM`, and the art board renders the BASE
 * footprint only. So this list is closed for the art authored in this phase and is NOT
 * "every footprint that can exist" - a later phase authoring art against a grown footprint
 * must reopen this list rather than read four literals as a complete inventory.
 */
const LEGAL_VIEWBOXES: readonly string[] = ['0 0 32 32', '0 0 64 64', '0 0 64 96', '0 0 96 96'];

/** The whitelist rendered for a human, joined once so both emit branches read identically. */
const LEGAL_VIEWBOX_LIST = LEGAL_VIEWBOXES.join(' / ');

const DATA_PART_PATTERN = /^[a-z][a-z0-9-]*$/;

/* ------------------------------------------------------------------ *
 * Paths - resolved from the module URL, never from cwd and never from argv
 * ------------------------------------------------------------------ */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** The MACHINE-ART directory. Non-recursive by contract. */
export const ASSET_DIR = fileURLToPath(new URL('../src/render/assets/', import.meta.url));

/**
 * The CHROME-GLYPH directory (plan 59-01, CHROME-01). Non-recursive by the same contract.
 *
 * A SECOND SHIPPED ASSET DIRECTORY THAT NO GATE MEASURES IS EXACTLY THE HOLE THE FLAT
 * PLACEMENT CONTRACT WAS WRITTEN TO PREVENT, so this walk is added in the same commit
 * the directory first has a file in it rather than "when there is enough to be worth
 * linting". The `new URL` idiom is correct HERE and only here: this file is node-only.
 * A jsdom spec reaching for the same directory must use `join(import.meta.dirname, ...)`
 * instead - see the trap documented at `render/assets/vertexBudget.test.ts:66-78`.
 *
 * The two directories share one lint implementation and one authoring dialect, and
 * differ in exactly one rule (`chrome-ink`). They deliberately do NOT share the
 * machine-only ART-LOCK axis gates (`colourVision.test.ts`, `shapeDistinctness.test.ts`,
 * `shippedAssets.test.ts`): a chrome glyph is not an art-lock subject, and forcing it
 * through axes that do not apply to it is how a gate becomes decorative.
 */
export const CHROME_ASSET_DIR = fileURLToPath(new URL('../src/chrome/assets/', import.meta.url));

/**
 * The BRAND-SOURCE directory (plan 80-04, decision D-06). Non-recursive, like the other
 * two, and resolved from `import.meta.url` rather than argv or cwd for the same reason
 * they are: this walker reads no input path at all (threat T-80-14).
 *
 * It is OUTSIDE `frontend/`, which is deliberate and is what `docs/brand/` means: the
 * lockup is a brand source, not a shipped asset. Nothing in the app imports it, no Vite
 * input reaches it and no bundle contains it. `displayPath` renders paths outside
 * `frontend/src/` as the bare filename, so this walk reports `fabrico-lockup.svg` and
 * `displayDir` renders the directory itself as `brand/`.
 *
 * AN UNWALKED DIRECTORY IS A DIRECTORY WITH NO RULES, which is the whole reason this
 * walk exists rather than waiting until `docs/brand/` has "enough files to be worth
 * linting" - the same argument `CHROME_ASSET_DIR` above records.
 */
export const BRAND_DIR = fileURLToPath(new URL('../../docs/brand/', import.meta.url));

/**
 * The SHIPPED-BRAND directory (plan 80.1-02, MARK-17). Non-recursive, like the other three,
 * and resolved from `import.meta.url` rather than argv or cwd for the same reason they are.
 *
 * WHAT LIVES HERE. `fabrico-header.svg`, the header cut of the Fabrico lockup: a token-painted
 * crop of the same geometry as `docs/brand/fabrico-lockup.svg`, emitted by
 * `scripts/build-lockup.ts` and imported `?raw` by `src/chrome/HeaderLockup.tsx`. It IS a
 * shipped asset - the app imports it and the bundle contains it - which is why it cannot live
 * in `docs/brand/`, whose own provenance header states that nothing in the app reaches it.
 *
 * WHY IT CANNOT LIVE IN `src/chrome/assets/` EITHER, which is the question a reader will ask
 * first. Three rules of the chrome dialect refuse it, so this is settled by the gates rather
 * than by preference:
 *
 *   1. `LEGAL_VIEWBOXES` admits four literals by EXACT STRING EQUALITY and the cut's crop
 *      window is `28 24.158 824 180.842`, which is not one of them. That list must not gain a
 *      fifth entry and must not become a regex; the constant says so and this plan does not.
 *   2. `non-integer-coord` refuses the outlined glyph contours and the measured crop top,
 *      both of which are fractional by construction (the top edge is derived from the amber
 *      item's centre, measured off the emitted tittle contour at build time).
 *   3. `curve` refuses the belt's stadium arcs, the two drum circles and the glyph contours.
 *
 * MEASURED, NOT ASSUMED: linted under the FULL rule set this one file reports 628 violations
 * across exactly those three rules. Under the subset the fourth walk uses it reports none.
 *
 * THEREFORE `EXPECTED_CHROME_ASSET_COUNT` STAYS 15 in both
 * `render/assets/vertexBudget.test.ts` and `render/assets/lintSvg.test.ts`, and that is a
 * decision rather than an oversight. Every walker over `chrome/assets/` is non-recursive and
 * `chrome/brand/` is its SIBLING, not its child, so no count literal moves.
 *
 * AN UNWALKED DIRECTORY IS A DIRECTORY WITH NO RULES, which is why this walk lands in the
 * phase that first puts a file here rather than when there is "enough to be worth linting" -
 * the same argument `CHROME_ASSET_DIR` and `BRAND_DIR` above both record.
 */
export const CHROME_BRAND_DIR = fileURLToPath(new URL('../src/chrome/brand/', import.meta.url));

/**
 * The SUBJECT-AGNOSTIC SUBSET the brand directory is linted by (D-06).
 *
 * WHAT IS OUT, AND WHY IT IS A DECISION RATHER THAN AN OMISSION. `viewbox`,
 * `non-integer-coord`, `curve` and `chrome-ink` are all SUBJECT-SCOPED to the 32-unit
 * chrome/machine grid: they encode what a Pixi-consumed glyph on that module must look
 * like. The lockup is a wide horizontal drawing with a `0 0 880 260` box, sub-unit glyph
 * outlines carrying real curves, and authored hex (a brand source cannot resolve a CSS
 * custom property). Running those four here would fail a correct file thousands of times
 * over and the only available repair would be an exemption list, which is how a rule
 * stops being a rule.
 *
 * WHAT IS IN is every rule that is true of ANY SVG regardless of what it depicts: the
 * document parses, it carries no banned element, it is flat self-closing `<path>`
 * children of the root, it draws SOMETHING, every path declares its own paint, and one
 * element sits per line.
 *
 * `no-paths` WAS MISSING AND WAS THE ONE OMISSION THAT PRODUCED A VACUOUS GREEN (WR-04).
 * Its own message states the test this list is written against - "an asset that draws
 * nothing is not a passing asset" - so a zero-path SVG dropped into `docs/brand/` linted
 * clean under the subset while failing under the full rule set. The directory's only other
 * anti-vacuity guard is `report()`'s per-DIRECTORY refusal plus the named floor file in
 * `lintSvg.test.ts`, and neither of those notices a SECOND file that is empty. This directory
 * grows (Phase 81 added the icon cuts), so the first added file that failed to generate would
 * have landed green.
 *
 * `transform`, `inline-style` and `data-part` STAY OUT, and that is a decision on the same
 * test rather than the same omission. None of the three is true of any SVG regardless of
 * what it depicts: a `transform` is legal authoring in a general drawing and is banned in
 * the chrome dialect only because Pixi consumes those glyphs by their path data; an inline
 * `style` attribute is likewise ordinary SVG that this repo refuses for a subject-scoped
 * reason; and `data-part` names a chrome LAYER, which a brand lockup does not have. Neither
 * of the three can produce a vacuous green the way `no-paths` did: each fires on the
 * presence of something, so its absence from the subset costs coverage of a defect, never
 * the ability to notice a file that draws nothing.
 *
 * THIS LIST MUST NEVER BE NARROWED TO NOTHING. An empty subset walks every directory
 * green, and a length assertion would not notice `['viewbox']` either, so
 * `lintSvg.test.ts` asserts membership BY RULE NAME (`path-only`, `banned-element`) and
 * proves the subset filters in both directions on two existing fixtures.
 *
 * Plan 80-05 appended the comment rule (`comment-hyphen`), in the commit that added it to
 * `RULE_IDS`. It belongs here on the same test every other member passes: an XML comment
 * carrying a doubled hyphen makes the document unopenable whatever the document depicts,
 * so the rule is subject-agnostic and D-06 names it explicitly.
 */
export const BRAND_RULES: readonly RuleId[] = [
  'malformed-xml',
  'banned-element',
  'path-only',
  'no-paths',
  'explicit-paint',
  'one-element-per-line',
  'comment-hyphen',
];

/**
 * The display path: relative to frontend/src/, which is the exact form 56-UI-SPEC's
 * copywriting contract prints (`render/assets/pilot.svg:12  ...`). A path outside src/
 * (a spec's temp directory) degrades to the bare filename rather than leaking an
 * absolute path into a CI log.
 */
function displayPath(absPath: string): string {
  const rel = relative(SRC_DIR, absPath);
  if (rel === '' || rel.startsWith('..')) return basename(absPath);
  return rel.split(sep).join('/');
}

/**
 * The display form of a DIRECTORY, with a trailing slash so it cannot be misread as a
 * file. Carried on every result so the vacuity refusal can name the directory that
 * walked to nothing INSTEAD OF a hardcoded string - see `report`.
 */
function displayDir(absDir: string): string {
  return `${displayPath(absDir).replace(/\/+$/, '')}/`;
}

/* ------------------------------------------------------------------ *
 * A minimal, dependency-free SVG structure parser
 * ------------------------------------------------------------------ */

interface ParsedAttr {
  name: string;
  value: string;
  line: number;
}

interface ParsedElement {
  name: string;
  attrs: ParsedAttr[];
  /** 1-based line the start tag opens on. */
  startLine: number;
  /** 1-based line the element's markup ends on (`/>` or `</name>`). */
  endLine: number;
  parent: string | null;
  depth: number;
  hasChildren: boolean;
  /**
   * `true` for `<path ... />`, `false` for `<path ...></path>`.
   *
   * Already computed by `parseSvg` to decide whether to push onto the open-element
   * stack; it is carried onto the element because `chrome/svgToElements.ts` matches
   * `<path\b[^>]*\/>` - self-closing ONLY - so the two forms are not interchangeable
   * downstream even though this parser and Pixi both accept either. See the
   * `path-only` rule below.
   */
  selfClosing: boolean;
}

type ParseResult =
  | { ok: true; elements: ParsedElement[] }
  | { ok: false; line: number };

function attrOf(el: ParsedElement, name: string): ParsedAttr | undefined {
  for (const a of el.attrs) if (a.name === name) return a;
  return undefined;
}

/**
 * Structure-parse an SVG document. Deliberately hand-rolled: no XML dependency is added
 * for a first-party, committed, eleven-line file format, and no external entity is ever
 * resolved (threat T-56-16, accepted). All local state lives inside this call - the
 * sticky regexes are constructed per invocation so the walker genuinely holds no shared
 * mutable state and two callers cannot interleave through it.
 */
function parseSvg(text: string): ParseResult {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineAt = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const failAt = (index: number): ParseResult => ({
    ok: false,
    line: lineAt(Math.max(0, Math.min(index, text.length - 1))),
  });
  /**
   * Report a parse failure at an ALREADY-KNOWN line rather than at the cursor.
   *
   * Needed because the cursor and the defect are not the same place inside a start
   * tag (phase 56 review WR-05). An unterminated start tag - by a wide margin the
   * most common markup error in this format - is not detected where it occurs: the
   * attribute loop simply runs off the end of the line, swallows the NEXT line's
   * markup as an attribute name, and only then hits something it cannot accept. So
   * `failAt(cursor)` names the line the parser gave up on, which is a line whose
   * markup is usually perfectly fine.
   *
   * The locator this module emits is "a UX surface, not a log line": sending a
   * reader to the wrong line for the commonest defect is the failure mode that
   * costs the most. Every in-tag failure is therefore attributed to the tag's own
   * `startLine` - the tag that cannot be parsed is the finding, wherever inside it
   * the parser happened to stop.
   */
  const failAtLine = (line: number): ParseResult => ({ ok: false, line });

  const nameRe = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
  const attrNameRe = /[^\s=/>]+/y;
  const wsRe = /\s/;

  const elements: ParsedElement[] = [];
  const stack: ParsedElement[] = [];
  let rootSeen = false;
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const trailing = lt === -1 ? text.slice(i) : text.slice(i, lt);
    // Character data outside the root element is not part of this format.
    if (stack.length === 0 && trailing.trim() !== '') return failAt(i);
    if (lt === -1) break;
    i = lt;

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) return failAt(i);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) return failAt(i);
      i = end + 2;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      // A CDATA SECTION IS REJECTED, not skipped (phase 56 review IN-03). Skipping it
      // wholesale meant `<![CDATA[ <script>alert(1)</script> ]]>` produced ZERO
      // violations: the `banned-element` rule cannot see markup the walker never turns
      // into an element. The real-world risk is low (Pixi parses through the DOM, where
      // CDATA is inert text) but this linter is the format's ONLY structural gate, and a
      // gate with a region it deliberately does not look at is the shape of every
      // finding in this file's own docblock.
      //
      // Rejection rather than recursion is the right call for an eleven-line, first-
      // party format: no committed asset has ever needed a CDATA section, and "this
      // format does not have CDATA" is a rule a reader can hold, whereas "CDATA is
      // linted too, sometimes" is not.
      return failAt(i);
    }
    if (text.startsWith('<!', i)) {
      const end = text.indexOf('>', i + 2);
      if (end === -1) return failAt(i);
      i = end + 1;
      continue;
    }
    if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i + 2);
      if (end === -1) return failAt(i);
      const closing = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== closing) return failAt(i);
      open.endLine = lineAt(i);
      i = end + 1;
      continue;
    }

    // A start tag.
    const startLine = lineAt(i);
    nameRe.lastIndex = i + 1;
    const nameMatch = nameRe.exec(text);
    if (nameMatch === null) return failAt(i);
    const name = nameMatch[0];
    if (stack.length === 0) {
      if (rootSeen) return failAt(i);
      rootSeen = true;
    }

    let j = i + 1 + name.length;
    const attrs: ParsedAttr[] = [];
    let selfClosing = false;
    // EVERY failure below reports `startLine`, never `j`. See `failAtLine`: inside a
    // start tag the cursor is not the defect, and for an unterminated tag it has
    // already walked into a different line's markup by the time anything is rejected.
    for (;;) {
      while (j < text.length && wsRe.test(text[j] as string)) j++;
      if (j >= text.length) return failAtLine(startLine);
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text[j] === '/') {
        if (text[j + 1] !== '>') return failAtLine(startLine);
        selfClosing = true;
        j += 2;
        break;
      }
      const attrLine = lineAt(j);
      attrNameRe.lastIndex = j;
      const attrMatch = attrNameRe.exec(text);
      if (attrMatch === null) return failAtLine(startLine);
      const attrName = attrMatch[0];
      j += attrName.length;
      while (j < text.length && wsRe.test(text[j] as string)) j++;
      if (text[j] !== '=') return failAtLine(startLine);
      j++;
      while (j < text.length && wsRe.test(text[j] as string)) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") return failAtLine(startLine);
      const close = text.indexOf(quote, j + 1);
      if (close === -1) return failAtLine(startLine);
      // A DUPLICATE ATTRIBUTE NAME IS MALFORMED XML (phase 56 review IN-03). `attrOf`
      // returns the FIRST match, so `<svg viewBox="0 0 32 32" viewBox="bogus">` used to
      // satisfy the `viewbox` rule on the first occurrence while a strict XML parser
      // would reject the whole document - the lint passing a file the DOM would not
      // accept is the wrong direction for a gate to be lenient in.
      if (attrs.some((a) => a.name === attrName)) return failAtLine(startLine);
      attrs.push({ name: attrName, value: text.slice(j + 1, close), line: attrLine });
      j = close + 1;
    }

    const parent = stack.length > 0 ? (stack[stack.length - 1] as ParsedElement) : null;
    if (parent !== null) parent.hasChildren = true;
    const el: ParsedElement = {
      name,
      attrs,
      startLine,
      endLine: lineAt(j - 1),
      parent: parent === null ? null : parent.name,
      depth: stack.length,
      hasChildren: false,
      selfClosing,
    };
    elements.push(el);
    if (!selfClosing) stack.push(el);
    i = j;
  }

  // Same reasoning as `failAtLine` one level up: an element that is never closed is a
  // defect AT THE ELEMENT, not at EOF. The outermost unclosed element is named, because
  // closing it is what closes every one nested inside it.
  if (stack.length > 0) return failAtLine((stack[0] as ParsedElement).startLine);
  if (!rootSeen) return failAt(0);
  return { ok: true, elements };
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

function bannedFix(name: string): string {
  if (name === 'use') {
    return "Pixi's SVG parser warns and draws nothing. Inline the geometry as a <path>.";
  }
  if (name === 'defs' || name === 'symbol' || name === 'clipPath' || name === 'mask' || name === 'filter') {
    return 'Pixi parses <defs> only for gradients and substitutes a wrong linear fallback for radialGradient. Inline the geometry as a flat-filled <path>.';
  }
  return 'The asset format carries flat <path> geometry only. Express the shape as a <path>, or drop the element.';
}

/** Every numeric token in a value, including implicit-separator forms like `M3-4`. */
function numericTokens(value: string): string[] {
  const re = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  const out: string[] = [];
  for (const m of value.matchAll(re)) out.push(m[0]);
  return out;
}

function isWholeUnit(token: string): boolean {
  return /^-?\d+$/.test(token);
}

/**
 * Which of the two shipped asset directories is being walked.
 *
 * Only ONE rule is scoped, and the option is named for that rule rather than for the
 * directory, so a reader of a call site sees WHAT is being switched on rather than
 * having to look up what "chrome mode" implies.
 */
export interface LintOptions {
  /**
   * Enforce the chrome ink rule: every `fill` and `stroke` is literally `currentColor`,
   * a `var(--fab-*)` reference, or `none`.
   *
   * OFF for `render/assets/`, and that is a decision rather than an omission. Machine
   * art carries ONE authored literal (`#b0bacb` = `LOCKED_SKIN.palette.ramp[4]`) because
   * Pixi's parser needs a real colour - it cannot resolve `currentColor` and throws
   * "Unable to convert color currentColor" on the attempt. The DOM icon rewrites that
   * literal to `currentColor` at parse time, and the literal itself is held to the ramp
   * VALUE SET by `shippedAssets.test.ts`. Chrome glyphs have no Pixi consumer at all, so
   * they are authored as `currentColor` from the start and carry zero hex.
   */
  chromeInk?: boolean;

  /**
   * Report only these rules. Absent means report every rule, which is what both shipped
   * asset directories want and is why this is opt-in rather than a required argument.
   *
   * IT FILTERS THE VIOLATIONS, NOT THE CHECKS, and that distinction is load-bearing.
   * `malformed-xml` short-circuits every other rule because structure is unknown until
   * the parse succeeds; if the CHECKS were filtered, a subset that excluded it would run
   * the structural rules over a document that never parsed and report nonsense. Filtering
   * the accumulated violations keeps every check running - one behaviour, one code path -
   * and keeps report-all (never first-fail) intact.
   *
   * IT IS HONOURED BY BOTH ENTRY POINTS, which it was not until WR-07. `lintFile` accepted
   * this option, type-checked against it and never read it, because the filter lived only in
   * `lintDir`. A caller doing `lintFile(brandFile, rel, { only: BRAND_RULES })` therefore got
   * the FULL list back with no error and no warning. It is applied at the end of `lintFile`
   * now and `lintDir` passes `opts` straight through, so there is exactly one filter.
   *
   * Used by the `docs/brand/` walk with `BRAND_RULES`. See that constant for why a subset
   * exists at all and why it must never be narrowed to nothing.
   */
  only?: readonly RuleId[];
}

/**
 * Is this authored paint value legal in a CHROME asset?
 *
 * `none` is admitted alongside the two token forms because it is not a colour: it is the
 * ABSENCE of paint, and the authoring contract requires `fill="none"` on every stroked
 * path. Rejecting it would fail every conforming file in the directory, which is the
 * shape of rule that gets an exemption list bolted on and then means nothing.
 *
 * IT CHECKS THE FORM OF THE REFERENCE AND NOT THAT THE TOKEN EXISTS, and that limit is
 * stated rather than left to be assumed (code review 80.1 WR-02). `var(--fab-inkk)` is a
 * well-formed reference to a custom property nothing declares: at runtime it is invalid at
 * computed-value time and the path silently inherits its parent's colour. Existence is
 * gated where the emitted set is already in scope, in `src/render/assets/headerCut.test.ts`
 * (over the committed bytes) and `src/chrome/HeaderLockup.test.tsx` (over what reaches the
 * DOM), both derived from `skinToCssVars(LOCKED_SKIN)` rather than transcribed.
 *
 * IT COULD BE DONE HERE AND DELIBERATELY IS NOT. `scripts/mark-craft.ts` imports that same
 * emitter, so there is no obstacle beyond scope: this rule runs over all fifteen chrome
 * glyphs, not only over the one file the 80.1 review was about, so turning it into an
 * existence check is a change to that directory's contract and belongs in a phase that
 * measures those fifteen files rather than in a fix to this one.
 */
function isChromeInk(value: string): boolean {
  const v = value.trim();
  return v === 'currentColor' || v === 'none' || /^var\(--fab-[a-z0-9-]+\)$/.test(v);
}

/* ------------------------------------------------------------------ *
 * XML comment legality - raw text, before the parse
 * ------------------------------------------------------------------ */

/**
 * True when an XML comment body carries a doubled hyphen, ends in a single hyphen, or is
 * never terminated.
 *
 * MOVED HERE FROM `scripts/mark-craft.ts` IN PLAN 80-05, and the direction is forced rather
 * than chosen: `mark-craft.ts` already imports `lintDir` and `report` from this module, so
 * the reverse import would be circular. `mark-craft.ts` re-exports both functions, which
 * keeps its own CLI and `render/assets/markCraft.test.ts` working unchanged.
 *
 * WHY THIS IS A LINT RULE NOW. The defect was found in Phase 79 on the shipped
 * `logomark.svg`, whose provenance header listed paint tokens in their `var(--fab-*)` form.
 * A doubled hyphen is illegal inside an XML comment by the XML 1.0 specification, so every
 * strict parser refuses the WHOLE document: measured 2026-09-05, Python's XML parser
 * refused it at line 25 column 34, `resvg` reported a comment containing a doubled hyphen,
 * and ImageMagick returned `unable to read image data`. Phase 79 could only record it,
 * because its success criterion 4 froze `chrome/assets/`. Recording found one file. Gating
 * found FOUR: `save.svg`, `trash.svg` and `warning.svg` carried the same defect and nobody
 * had looked. That gap between what a note catches and what a walk catches is the whole
 * argument for promoting a recorded defect to a rule.
 *
 * THE TRAILING-HYPHEN CASE IS NOT PEDANTRY. `<!-- x --->` has a body ending in `-`, which
 * collides with the `-->` close delimiter, and the XML grammar refuses it for the same
 * reason it refuses the doubled hyphen. The detector this replaced tested only for `--`
 * inside the body, so that form would have shipped.
 *
 * PURE, AND BY REQUIREMENT RATHER THAN TASTE. Both callers run in CI, where no rasteriser
 * binary is guaranteed to exist, so the detector cannot shell out to confirm itself. It was
 * cross-checked against three real parsers once, at authoring time in plan 79-01.
 */
export function hasIllegalComment(svgText: string): boolean {
  return illegalCommentLine(svgText) !== null;
}

/** The 1-based line of the first illegal comment, or null when every comment is legal. */
export function illegalCommentLine(svgText: string): number | null {
  const lineAt = (index: number): number => {
    let line = 1;
    for (let i = 0; i < index && i < svgText.length; i++) {
      if (svgText.charCodeAt(i) === 10) line++;
    }
    return line;
  };
  let i = 0;
  for (;;) {
    const open = svgText.indexOf('<!--', i);
    if (open === -1) return null;
    const close = svgText.indexOf('-->', open + 4);
    if (close === -1) return lineAt(open);
    const body = svgText.slice(open + 4, close);
    const bad = body.indexOf('--');
    if (bad !== -1) return lineAt(open + 4 + bad);
    // A body ending in a single hyphen collides with the close delimiter. Reported at the
    // hyphen itself, which is the character a reader has to delete.
    if (body.endsWith('-')) return lineAt(close - 1);
    i = close + 3;
  }
}

/** Line 1 of the `comment-hyphen` violation. */
const COMMENT_HYPHEN_MESSAGE = 'an XML comment carries a double hyphen or is unterminated';

/** Line 2 of the `comment-hyphen` violation. */
const COMMENT_HYPHEN_FIX =
  'A double hyphen is illegal inside an XML comment and every strict parser refuses the whole ' +
  'document, so the file cannot be opened by a rasteriser at all. A comment body may not end in a ' +
  'hyphen either. Name paint tokens without their leading dashes, as fab-accent-item.';

/**
 * Lint one file. PURE apart from the single `readFileSync`: same bytes in, same
 * Violation[] out, in a deterministic order. Never throws - an unreadable file becomes a
 * NAMED violation, because a file silently skipped and then reported clean is a false
 * green, which is the exact failure this lint exists to make impossible.
 */
export function lintFile(
  absPath: string,
  repoRelPath: string,
  opts: LintOptions = {},
): Violation[] {
  const out: Violation[] = [];
  const add = (line: number, rule: RuleId, message: string, fix: string): void => {
    out.push({ path: repoRelPath, line, rule, severity: severityOf(rule), message, fix });
  };

  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (err) {
    // AN I/O FAILURE IS NOT BAD MARKUP (phase 56 review IN-02). This catch used to emit
    // the byte-identical message the PARSE failure emits, so `ENOENT`, `EACCES` and
    // `EISDIR` all reported "file could not be parsed as XML" - and an author told that
    // about a permissions error goes and edits markup that is perfectly fine.
    //
    // The rule id and severity deliberately do NOT change: the report format, the
    // `RULES` table and every downstream consumer stay exactly as they were, and the
    // load-bearing property is unchanged - an unreadable file is a NAMED violation, never
    // a silent skip that lets a walk print "0 violations". Only the human-readable half
    // is corrected, plus the errno, which is the single most useful thing to print here.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    add(
      1,
      'malformed-xml',
      `file could not be read${code === undefined ? '' : ` (${code})`}`,
      'Check the path exists and is readable; a skipped file is not a passing file.',
    );
    return out;
  }

  // --- comment-hyphen: RUN OVER THE RAW TEXT, BEFORE THE PARSE, and that ordering is the
  // rule rather than an implementation detail. `parseSvg` skips a comment wholesale by
  // seeking its `-->` and never inspects the body (see the comment branch there), which is
  // exactly why this defect survived a milestone under a walker that ran over these files
  // every commit. It also means a document a strict parser refuses FOR THIS REASON is a
  // document our own parser reads happily, so a rule that ran after the parse would report
  // clean on the one input it exists for. Reporting before the parse also means a genuinely
  // malformed document gets BOTH findings: the comment is named as well as the structure,
  // and the comment is usually the cause.
  const commentLine = illegalCommentLine(text);
  if (commentLine !== null) {
    add(commentLine, 'comment-hyphen', COMMENT_HYPHEN_MESSAGE, COMMENT_HYPHEN_FIX);
  }

  const parsed = parseSvg(text);
  if (!parsed.ok) {
    // Structure is unknown, so every other rule would be guessing. One named error.
    add(
      parsed.line,
      'malformed-xml',
      'file could not be parsed as XML',
      'Fix the markup or remove the file; a skipped file is not a passing file.',
    );
    return out;
  }

  const { elements } = parsed;
  const root = elements[0] as ParsedElement;
  const paths = elements.filter((e) => e.name === 'path');

  // --- viewbox: Pixi's SVGParser never reads viewBox, so this lint is the ONLY thing
  // holding the module. The module is 32 units PER CELL, across a whitelisted set of
  // footprints rather than a single box (`LEGAL_VIEWBOXES`), because a 2x3 `Router` and a
  // 3x3 `Factory` cannot be authored at 32x32 at all. Membership is exact string equality:
  // `0 0 32.0 32.0` is numerically equal and textually wrong, and textually wrong is what
  // breaks integer authoring.
  const viewBox = attrOf(root, 'viewBox');
  if (viewBox === undefined) {
    add(
      root.startLine,
      'viewbox',
      `<${root.name}> has no viewBox attribute`,
      `Pixi's SVG parser never reads viewBox, so this lint is the only thing holding the module. Declare viewBox on the root <svg> as one of the four legal footprint boxes: ${LEGAL_VIEWBOX_LIST}.`,
    );
  } else if (!LEGAL_VIEWBOXES.includes(viewBox.value)) {
    add(
      viewBox.line,
      'viewbox',
      `viewBox is "${viewBox.value}", not one of the four legal footprint boxes: ${LEGAL_VIEWBOX_LIST}`,
      `Coordinates pass straight through as user units, so the 32-unit module holds only if the viewBox says so exactly. A multi-cell kind is authored at 32*w by 32*h and never at 32x32 scaled up. The legal boxes are ${LEGAL_VIEWBOX_LIST}.`,
    );
  }

  for (const el of elements) {
    // --- transform: the worst failure mode in the set. Verified: SVGParser never reads
    // it, so geometry lands untransformed with NO warning - a silent misrender.
    const transform = attrOf(el, 'transform');
    if (transform !== undefined) {
      add(
        transform.line,
        'transform',
        `transform attribute on <${el.name}>`,
        "Pixi's SVG parser never reads transform, so the geometry lands untransformed with no warning. Bake the offset into the path coordinates.",
      );
    }

    // --- banned-element / path-only
    if (el.depth === 0) {
      if (el.name !== 'svg') {
        add(
          el.startLine,
          'path-only',
          `root element is <${el.name}>, not <svg>`,
          'The asset format is a single <svg> root holding flat <path> children. Make the root element an <svg>.',
        );
      }
    } else if (BANNED_ELEMENTS.includes(el.name)) {
      add(el.startLine, 'banned-element', `banned <${el.name}> element`, bannedFix(el.name));
    } else if (el.name !== 'path') {
      add(
        el.startLine,
        'path-only',
        `<${el.name}> element - the format allows only <path>`,
        'One primitive family keeps the vertex count and the geometry digest predictable. Express the shape as a <path>.',
      );
    } else if (el.depth > 1) {
      add(
        el.startLine,
        'path-only',
        `<path> is nested inside <${el.parent}>, not a direct child of the root`,
        "A flat child list keeps each part's effective style local. Move the <path> up to the root and delete the wrapper.",
      );
    }

    // --- inline-style: Pixi DOES parse inline style (parseSVGStyle merges it over the
    // presentation attributes), so this is a single-channel diff-hygiene rule, not a
    // parse guard. Two channels for one property is what makes an SVG diff unreadable.
    const style = attrOf(el, 'style');
    if (style !== undefined) {
      add(
        style.line,
        'inline-style',
        `style attribute on <${el.name}>`,
        'Two channels for one property makes an SVG diff unreadable. Move the declarations to presentation attributes.',
      );
    }

    // --- non-integer-coord
    for (const attr of el.attrs) {
      if (!GEOMETRIC_ATTRS.includes(attr.name)) continue;
      for (const token of numericTokens(attr.value)) {
        if (isWholeUnit(token)) continue;
        add(
          attr.line,
          'non-integer-coord',
          `non-integer coordinate '${token}' in ${attr.name}`,
          'Fractional author coordinates defeat the hard-edge promise at scale 1 and make the geometry digest float-sensitive. Round to a whole unit on the 32-unit grid.',
        );
      }
    }
  }

  // --- path-only, second half: THE TWO PARSERS MUST ACCEPT THE SAME DIALECT.
  //
  // This walker accepts `<path ...></path>` (the start-tag scan above handles the `>`
  // branch and the matching close tag), `one-element-per-line` is satisfied when both
  // tags sit on one line, and Pixi draws it. `chrome/svgToElements.ts:parseIconParts`
  // does NOT: its tag scan is `/<path\b[^>]*\/>/g`, self-closing only, and its
  // zero-path refusal fires only when EVERY path is dropped. So a mixed file used to
  // produce a silently INCOMPLETE icon - the canvas drawing the full glyph, the DOM
  // drawing part of it, and nothing reddening, since `icons.test.tsx`'s verbatim gate
  // only compares the paths that were emitted.
  //
  // The narrower dialect is made a LINT RULE rather than widened in the parser because
  // the format is first-party and one accepted dialect is the whole point of a format
  // gate: `svgToElements` now throws by name on the long form (a loud refusal rather
  // than a silent skip) and this rule stops the file reaching it. Filed under
  // `path-only` rather than as a fourteenth rule id: it is the same property that rule
  // already states, which is what the format allows a `<path>` to look like.
  for (const el of paths) {
    if (el.selfClosing) continue;
    const dp = attrOf(el, 'data-part');
    add(
      el.startLine,
      'path-only',
      `<path data-part="${dp?.value ?? '?'}"> is not self-closing`,
      'chrome/svgToElements.ts matches self-closing <path .../> only, so a <path></path> form is dropped from the DOM icon while Pixi still draws it - two surfaces disagreeing, silently. Close the tag with "/>".',
    );
  }

  // --- data-part (D-06): the stable per-part handle Phase 58 tints against without
  // re-authoring geometry. Uniqueness is checked within the file, in document order.
  const seenParts = new Set<string>();
  for (const el of paths) {
    const dataPart = attrOf(el, 'data-part');
    if (dataPart === undefined) {
      add(
        el.startLine,
        'data-part',
        '<path> has no data-part attribute',
        'data-part is the stable per-part handle later phases tint and diff against. Give every <path> a unique lower-kebab-case data-part.',
      );
      continue;
    }
    if (!DATA_PART_PATTERN.test(dataPart.value)) {
      add(
        dataPart.line,
        'data-part',
        `data-part "${dataPart.value}" does not match ^[a-z][a-z0-9-]*$`,
        'A part handle must be stable and machine-readable. Rename it to lower-kebab-case starting with a letter.',
      );
      continue;
    }
    if (seenParts.has(dataPart.value)) {
      add(
        dataPart.line,
        'data-part',
        `duplicate data-part "${dataPart.value}"`,
        'Two parts sharing a handle makes per-part tinting ambiguous. Give each <path> its own data-part.',
      );
      continue;
    }
    seenParts.add(dataPart.value);
  }

  // --- explicit-paint: renderChildren sets `noStyle -> fillStyle = { color: 0 }`, so a
  // path with neither attribute silently renders as BLACK FILL. A named error beats a
  // black blob nobody can explain.
  for (const el of paths) {
    if (attrOf(el, 'fill') !== undefined || attrOf(el, 'stroke') !== undefined) continue;
    add(
      el.startLine,
      'explicit-paint',
      '<path> declares neither fill nor stroke',
      "Pixi falls back to a solid black fill when no style is set, which renders a silent black blob. Declare fill (fill=\"none\" counts) or stroke.",
    );
  }

  // --- chrome-ink (plan 59-01): CHROME DIRECTORY ONLY. A chrome glyph inherits the
  // colour of the control it sits in, which is what makes it lift on a hovered palette
  // item and desaturate with a disabled button. A baked hex does neither, and it does
  // neither SILENTLY - the icon simply stops responding to a state it should follow.
  // Reported per ATTRIBUTE and at the attribute's own line, so a file with two offending
  // paints names both.
  if (opts.chromeInk === true) {
    for (const el of paths) {
      for (const name of ['fill', 'stroke'] as const) {
        const attr = attrOf(el, name);
        if (attr === undefined || isChromeInk(attr.value)) continue;
        add(
          attr.line,
          'chrome-ink',
          `${name}="${attr.value}" is not a chrome ink`,
          'A chrome glyph takes its colour from the control it sits in, so it lifts on hover and desaturates with a disabled button; a baked value does neither, silently. Use currentColor, a var(--fab-*) reference, or none.',
        );
      }
    }
  }

  // --- one-element-per-line (D-05): reported ONCE PER ELEMENT, so two elements sharing
  // a line yield TWO violations, not one. Elements are named by their data-part where
  // they have one: two violations on the same line that render as byte-identical text
  // tell the reader nothing about WHICH element to move, which is the same class of
  // unhelpfulness as `SVG validation failed`.
  //
  // Exempt from the span check: the root element, which must span lines to wrap the
  // parts at all, and any element with children, which is a container rather than
  // geometry. Only leaf elements are required to open and close on one line.
  const startsPerLine = new Map<number, number>();
  for (const el of elements) {
    startsPerLine.set(el.startLine, (startsPerLine.get(el.startLine) ?? 0) + 1);
  }
  for (const el of elements) {
    const dataPart = attrOf(el, 'data-part');
    const named =
      dataPart === undefined ? `<${el.name}>` : `<${el.name} data-part="${dataPart.value}">`;
    if ((startsPerLine.get(el.startLine) ?? 0) > 1) {
      add(
        el.startLine,
        'one-element-per-line',
        `${named} shares a source line with another element`,
        'Diffs stay line-scoped only when each element owns its own line. Put this element on a line of its own.',
      );
    } else if (el.depth > 0 && !el.hasChildren && el.startLine !== el.endLine) {
      add(
        el.startLine,
        'one-element-per-line',
        `${named} opens and closes on different source lines`,
        'Diffs stay line-scoped only when each element opens and closes on one line. Collapse this element onto a single line.',
      );
    }
  }

  // --- curve (D-11, VEC-03's mechanically-checkable half). FAIL since plan 58-02; see
  // `severityOf` for the decision and its two reasons. Both cases of all five commands
  // are matched: a lowercase `c` is what a path serialiser emits and what an eye skips.
  for (const el of paths) {
    const d = attrOf(el, 'd');
    if (d === undefined) continue;
    for (const m of d.value.matchAll(/[CSQTAcsqta]/g)) {
      add(
        d.line,
        'curve',
        `curve command '${m[0]}'`,
        'buildAdaptiveBezier tessellates at scale 1 only; this serves faceted geometry when zoomed. ' +
          'Lock axis 5 is radius 0, authored square with zero curve commands - re-plot the shape in M H V L Z.',
      );
    }
  }

  // --- no-paths: a file with zero <path> elements draws nothing. A named failure, never
  // a silent pass - a silently empty asset reporting clean is a false green.
  if (paths.length === 0) {
    add(
      root.startLine,
      'no-paths',
      'no <path> elements in this asset',
      'An asset that draws nothing is not a passing asset. Add the part geometry as <path> elements, or delete the file.',
    );
  }

  // THE SUBSET IS APPLIED HERE, after every check has run and before the sort (WR-07).
  //
  // It used to live in `lintDir` alone, which meant `lintFile` accepted `only`, type-checked
  // against it and then ignored it: a caller doing `lintFile(brandFile, rel, { only:
  // BRAND_RULES })` got the FULL violation list back with no error and no warning, which for
  // the lockup is thousands of `non-integer-coord` and `curve` findings on a correct file.
  // `lintSvg.test.ts:134` calls `lintFile` directly, so that shape is in live use.
  //
  // Filtering the FINDINGS rather than the CHECKS is what keeps `malformed-xml`'s
  // short-circuit true for a caller who did not ask to hear about it. See `LintOptions.only`.
  const only = opts.only;
  return sortViolations(only === undefined ? out : out.filter((v) => only.includes(v.rule)));
}

/**
 * The ordering contract: repo-relative path, then ascending source line, then position
 * in RULES. Array.prototype.sort is stable, so two violations of the SAME rule on the
 * SAME line keep document order. Output is byte-stable across runs, and that stability
 * is asserted by running the walker twice and comparing.
 */
function sortViolations(violations: Violation[]): Violation[] {
  return violations.slice().sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return RULES.indexOf(a.rule) - RULES.indexOf(b.rule);
  });
}

/**
 * Walk one directory NON-RECURSIVELY and lint every `.svg` in it. Non-recursive is the
 * whole mechanism keeping __fixtures__/ and __digests__/ out of the production walk
 * without a bespoke ignore list, and it is also why the walker cannot descend out of the
 * tree (threat T-56-13). Returns the discovered assets so a caller can refuse a
 * zero-asset run rather than print a vacuous green.
 */
export function lintDir(dir: string, opts: LintOptions = {}): LintResult {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.svg'))
    .map((e) => e.name)
    .sort();

  const assets: string[] = [];
  const violations: Violation[] = [];
  for (const name of files) {
    const abs = join(dir, name);
    const rel = displayPath(abs);
    assets.push(rel);
    violations.push(...lintFile(abs, rel, opts));
  }
  // NO SECOND FILTER HERE. `lintFile` applies `opts.only` itself now (WR-07), so this
  // function passes `opts` straight through and filtering happens in exactly one place. The
  // sort is still needed: it orders the CONCATENATION across files, which no per-file sort
  // can do.
  return { dir: displayDir(dir), assets, violations: sortViolations(violations) };
}

/** One directory's walk. `dir` is carried so a report can NAME the directory it describes. */
export interface LintResult {
  /** The walked directory, relative to `frontend/src/`, with a trailing slash. */
  dir: string;
  /** Every `.svg` discovered, as display paths, sorted. */
  assets: string[];
  /** Every violation across those files, sorted. */
  violations: Violation[];
}

/**
 * The exact two-line format (56-UI-SPEC A.3). Line 1 is a greppable
 * `path:line` + TWO spaces + the terse finding; line 2 is a two-space indent and one
 * sentence saying why it fails and what to do instead. Warnings carry a `warning: `
 * prefix on line 1's message. No ANSI colour, ever.
 */
export function formatViolation(v: Violation): string {
  const prefix = v.severity === 'warn' ? 'warning: ' : '';
  return `${v.path}:${v.line}  ${prefix}${v.message}\n  ${v.fix}`;
}

/* ------------------------------------------------------------------ *
 * The CLI caller
 * ------------------------------------------------------------------ */

/**
 * Render the whole report. Pure string-building so the vitest caller can assert the
 * exact bytes the CLI prints. No output cap: ALL violations are reported with no
 * truncation (planner assumption, 56-UI-SPEC S1 overflow - a cap-plus-tail is
 * deliberately not implemented and would be revisited only if a real file produced
 * unreadable output).
 */
export function report(input: LintResult | readonly LintResult[]): {
  text: string;
  failed: boolean;
} {
  const results = Array.isArray(input) ? ([...input] as LintResult[]) : [input as LintResult];

  // THE VACUITY REFUSAL IS PER-DIRECTORY (plan 59-01), and it has to be. It used to be
  // one global message naming a hardcoded `render/assets/`, which was true while there
  // was one directory and became a false green the moment there were two: a chrome
  // directory that walked to NOTHING would be masked by the nine machine assets and the
  // run would print a clean pass over a gate measuring half of what it claims. Every
  // empty directory is named, and one empty directory fails the whole run.
  const empty = results.filter((r) => r.assets.length === 0);
  if (empty.length > 0) {
    return {
      text: empty
        .map((r) => `lint:svg  no assets found under ${r.dir} - refusing to report a vacuous pass`)
        .join('\n'),
      failed: true,
    };
  }

  // Violations from every directory in ONE sorted list, so the output stays a single
  // greppable stream in path order rather than two blocks a reader has to merge.
  const lines = sortViolations(results.flatMap((r) => r.violations)).map(formatViolation);
  // One summary PER DIRECTORY, each naming its own. With two directories an unnamed
  // total cannot be attributed, and the count pin a human maintains by hand is
  // per-directory too.
  for (const r of results) {
    const fileCount = new Set(r.violations.map((v) => v.path)).size;
    lines.push(
      r.violations.length === 0
        ? `lint:svg  ${r.dir}  ${r.assets.length} assets, 0 violations`
        : `lint:svg  ${r.dir}  ${r.assets.length} assets, ${r.violations.length} violations in ${fileCount} files`,
    );
  }
  return {
    text: lines.join('\n'),
    failed: results.some((r) => r.violations.some((v) => v.severity === 'fail')),
  };
}

// `import.meta.main` is true only under bare `node scripts/lint-svg.ts`; under Vite and
// vitest it is undefined, so importing this module never runs the CLI or exits the
// process. Deliberately NOT an argv comparison: this walker reads no argv at all.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  const results = [
    lintDir(ASSET_DIR),
    lintDir(CHROME_ASSET_DIR, { chromeInk: true }),
    // The THIRD walk (plan 80-04, D-06). `report()`'s per-directory vacuity refusal
    // already names any directory that walked to nothing, so an empty or mislocated
    // `docs/brand/` fails the run here with no new code.
    lintDir(BRAND_DIR, { only: BRAND_RULES }),
    // The FOURTH walk (plan 80.1-02, MARK-17), over the shipped header cut. The same
    // per-directory vacuity refusal applies here too: an empty or mislocated
    // `src/chrome/brand/` fails the run with no new code.
    //
    // IT PASSES `chrome-ink` ALONGSIDE `BRAND_RULES`, AND THAT IS THE DECISION IN THIS WALK.
    // The obvious call is `{ only: BRAND_RULES }`, matching the third walk exactly - and it
    // would be weaker than it looks, because `chrome-ink` is NOT a member of `BRAND_RULES`.
    // A hex literal authored into the cut would then lint GREEN here, and the only thing
    // standing between it and a shipped one-colour mark would be a unit spec.
    //
    // The failure that matters is invisible without this rule. `chrome/svgToElements.ts`'s
    // `paintOf` rewrites any authored paint that is a member of the LOCKED_SKIN ramp VALUE
    // SET to `currentColor`, and the cut's plate, lane and ink ARE ramp steps by design. So
    // authoring them as the brand file does would collapse three distinct layers onto ONE
    // inherited colour, silently, with the structural rules all still green.
    //
    // It costs nothing on a correct file: `isChromeInk` admits `currentColor`,
    // `var(--fab-*)` and `none` and refuses everything else including `rgb(...)`, which is
    // exactly the cut's paint vocabulary. Both halves of the opt-in are required and neither
    // works alone - `only` filters the VIOLATIONS and `chromeInk` runs the CHECK, so naming
    // the rule without enabling it filters findings from a check that never ran.
    //
    // No new rule id, no fifth `LEGAL_VIEWBOXES` literal, no widened chrome dialect.
    lintDir(CHROME_BRAND_DIR, { only: [...BRAND_RULES, 'chrome-ink'], chromeInk: true }),
  ];
  const { text, failed } = report(results);
  process.stdout.write(`${text}\n`);
  if (failed) process.exitCode = 1;
}
