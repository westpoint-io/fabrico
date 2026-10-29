// THE DURABLE GUARD over `e2e-live/77-one-board-all-five.live.spec.ts`, the v9.0 composed walk
// (COMP-01, phase 77 D-05).
//
// WHAT IT GUARDS. The composed walk is ONE spec that walks the milestone done-test's five legs
// in order, on ONE board booted empty, in ONE page that never reloads. Every property that makes
// it a composition rather than five specs in one file is a property of its TEXT: the order of
// its declarations, serial mode, where a fresh board may be made, where the page may navigate,
// how a later leg takes over the board, and which assertions each leg keeps. This gate reads the
// spec as text on every `npm test` and reddens when any of them goes.
//
// WHY EACH RULE EXISTS, from the v8.0 records (phase 69):
//   - A SILENTLY NARROWED LEG. v8.0's leg 2 was walked as something smaller than its sentence and
//     the green said nothing about it (69-VERIFICATION.md). R8 holds each leg's sentence word for
//     word in the header, and R10 holds each leg's defining assertions in its body, so a leg
//     cannot keep its title while losing what it proves. R10 also refuses a defining assertion
//     whose matcher asks only that a value exists (`.toBeTruthy()` and its kin), is negated, is
//     missing, or expects `expect.anything()` (the 77-02 refuter round). What it still cannot see
//     is a strong matcher given a different expected value; the live bites see that.
//   - A GUARD THAT COULD NOT FAIL. v8.0's walk guard first ran once inside a plan's verify block
//     and never again, and several of its checks were green on any input (69-REVIEW.md WR-01).
//     Every rule here has a REFUSES case below that mutates the REAL file text, and plan 77-01
//     disabled each rule in a throwaway worktree and saw its case go red (77-MUTATION-PROOF.md).
//   - FIVE SPECS IN ONE FILE. A leg that boots its own board, or navigates, turns the walk back
//     into the shape audit blocker B1 named. R5, R6 and R7 hold the composition: only leg 1 boots
//     (and only its boot resets the host), only the boot and the closing restore navigate, every
//     later leg reads its handoff with `required(` and attaches without a rescue.
//   - A COUNT OVER A STAND-IN. The rules count calls by name, so R11 holds every name they count
//     (and `test` and `expect`) to its one binding, an import or a top-level function, and refuses
//     any other use than a direct call: a leg that declared its own `expectRenderLoopAlive` kept
//     every count with no render-health check left (the 77-09 refuter round).
//   - A READ SWAPPED FOR ANOTHER, AND A GESTURE DOUBLED (the 77-05 refuter round). The plot read
//     `drawnCableSet` rewritten to build its polylines from the model passed this gate and the live
//     walk, and so did leg 5 pressing Ctrl+Z twice, or grading NOTHING ON TOP on a copy of the strip
//     instead of its recording. R12 holds each named read helper to the calls it reads through, and
//     R13 pins the wiring a leg's claim rests on: leg 5's one Ctrl+Z, the recording NOTHING ON TOP
//     grades, and the head-on loop over every restored leg.
//
// HOW A LEG IS ADDED. Extend `EXPECTED_ORDER` and `LEG_TOKENS` deliberately, at the position the
// leg is declared (plans 77-02 to 77-05 did this, and 77-07 extends `LEG_TOKENS`). Widening a rule
// to let a leg through is the wrong move. A leg or clause that cannot be walked honestly is CUT:
// declared last, titled `CUT - leg <n> ...`, and its body throws its reason (77 D-15, D-20).
//
// HOW A CUT IS HELD. A cut is a recorded decision, so it is listed in `CUTS` with the header
// entry and the measured lines it carries. R3 refuses a listed cut that is not declared (a cut
// deleted is a clause dropped silently), R4 refuses one that is not ONE unconditional throw or no
// longer quotes its measured lines, and R8 refuses its header entry changed by a word, the measured
// lines included (the 77-09 refuter round: a return, a skip or a try ahead of the throw kept the
// throw's text, and a header cut down to its label kept the label). A standing cut fails the live
// suite on every run BY DESIGN, so while one stands the live gate's exit code cannot tell a healthy
// run from a broken one, and its record must name the failing title. A cut clause is asserted
// nowhere: R10 refuses any text a cut lists under `gone` (the clause's assertion token and its
// grader) anywhere in the spec's code while the cut stands.
//
// ONE CUT STANDS: leg 3's "clears from the front". Plan 77-09 cut it on a grader fault, the 77-03
// refuter round fixed the grader and asserted the clause as `FRONT FIRST` under the header's NAMED
// DEVIATION A1, and the maintainers overturned A1 on 2026-10-08 ("cut it and carry on"): the line visibly thins
// from the Source end, and the front-first order is about 50 ms on the sim clock, which nobody can
// see. Its quoted lines are rebuilt from committed release trace 1
// (`fixtures/77-release-trace-1.json`): the `RELEASE_ORDER` line the trace logged, and the
// `RELEASE_THINNING` line leg 3 logs, computed from the trace's records by the grader's
// `thinningTicks`, so the reason the spec throws cannot drift from the data. The cut rules are also
// graded on a synthetic cut (`SYNTH_CUTS`).
//
// It lives under `src/` for the same mechanical reason as the v8 gate beside it: `vitest.config.ts`
// includes `src/**/*.{test,spec}.{ts,tsx}` and nothing else, so it needs no config entry that a
// later edit could drop. The parser is shared with that gate (`walkSpecSource.ts`).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { thinningTicks, type JamIds, type JamRecord } from '../../e2e-live/support/jamGrading';
import {
  assertionArguments,
  assertionMatcher,
  assertionsCarrying,
  blankStrings,
  declarationBodies,
  declarations,
  functionBody,
  matchingParen,
  stripComments,
  type DeclarationBody,
  type SourceSpan,
} from './walkSpecSource';

const SPEC_PATH = new URL('../../e2e-live/77-one-board-all-five.live.spec.ts', import.meta.url);
const SPEC_NAME = 'e2e-live/77-one-board-all-five.live.spec.ts';
// The done-test this spec audits is v9.0's, so it reads a verbatim copy of v9.0's done-test
// section kept beside the other gate fixtures; a later milestone's done-test would carry
// different legs.
const REQUIREMENTS_PATH = new URL(
  './fixtures/v9-done-test.md',
  import.meta.url,
);

/**
 * The walking legs, as title PREFIXES, in the order they must be declared. Plans 77-02 to 77-05
 * extend it, one leg each.
 */
export const EXPECTED_ORDER = ['leg 1 - ', 'leg 2 - ', 'leg 3 - ', 'leg 4 - ', 'leg 5 - '] as const;

/**
 * Each walking leg's DEFINING assertions, by the upper-case token its assertion message carries,
 * and HOW MANY assertion calls in that leg's body carry it (R10). Keyed by walking prefix. Plans
 * 77-02 to 77-05 add their legs, and 77-07 extends it.
 *
 * WHY A COUNT (the 77-01 refuter round). Several assertions share one token (leg 1's `ONE DRAG
 * TWO WIRES` sits in the endpoint poll, the ports-declared check and two head-on labels), and the
 * rule first asked only that the token sit inside SOME assertion, so the endpoint poll could be
 * deleted with the gate green. The count pins every assertion that carries a token: deleting any
 * one of them, or adding one, changes it, and the change has to be made here deliberately.
 */
export const LEG_TOKENS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'leg 1 - ': {
    'BOOTED EMPTY': 1,
    'TWO NODES PLACED': 1,
    'DRAWN ON THE CANVAS': 1,
    'URL ON THE PANEL': 2,
    'ONE DRAG TWO WIRES': 4,
    'TWO CABLES DRAWN': 1,
    'TWO CABLES SEEN ON SCREEN': 1,
    'ANSWERS THE PRESET': 2,
    'REPLY ON THE RETURN LEG': 1,
    'BODY FROM THE PANEL': 3,
  },
  'leg 2 - ': {
    'leg 2 opens on the composed board': 1,
    'SOURCE PLACED': 2,
    'FIRST BELT DOCKED': 1,
    'COLLAR BASELINE': 1,
    'JOINED BY THE END': 3,
    'ONE RUN OF 2 BELTS': 2,
    'BOTH BELTS AT THE SLOWEST PACE': 2,
    'JUNCTION COLLAR PLOTTED': 2,
    'COLLAR ON THE CANVAS': 2,
    'PACKED SOLID': 1,
    'PACK ORDER STRICT': 6,
    'TILES LIST TAIL FIRST': 1,
    'PACK GROWS ON THE CANVAS': 1,
    'PACK DRAWN ON THE CANVAS': 1,
  },
  'leg 3 - ': {
    'leg 3 opens on the composed board': 1,
    'FLOWING BASELINE': 3,
    'THE JAM FORMS': 2,
    'JAM HOLDS BACKED_UP': 1,
    'FRONT TILE HELD': 1,
    'MARK PAINTED': 1,
    'PACKS BACKWARDS': 1,
    'JAM DRAWN ON THE CANVAS': 1,
    'RELEASE SUSTAINED': 2,
    'ENDS FLOWING': 2,
    'MERGED BAR ON THE CANVAS': 1,
    'BAR BROKEN ON THE CANVAS': 1,
    'MARK SEEN ON SCREEN': 1,
    'BAR SEEN BROKEN ON SCREEN': 2,
    'RUN DRAWN AFTER THE RELEASE': 1,
    'RUN DRAWN AT THE CLOSE': 1,
    'RUN VISIBLE AT THE CLOSE': 1,
    'STAYS RELEASED': 1,
  },
  'leg 4 - ': {
    'leg 4 opens on the composed board': 1,
    'LABEL PLACED AS APPLIED': 1,
    'LABEL DRAWN': 2,
    'LABEL SEEN ON SCREEN': 1,
    'SAVE DIALOG FIRED': 2,
    'ONLY THE LOAD REBUILDS': 2,
    'after the Load': 2,
    'LABEL BACK EXACTLY': 4,
    'LABEL BACK ON SCREEN': 1,
    'SAVED AGAIN': 1,
    // Phase 90 review WR-C-06: the sustained run past the re-save, and no stall dim over it.
    'RUNS ON AFTER THE SAVE': 2,
    'RELOADED AFTER THE SAVE': 3,
    'ITEMS RUN PAST': 3,
    'ITEMS DRAWN RUNNING PAST': 1,
    'ITEMS VISIBLE ON THE CANVAS': 1,
    // 'MACHINES NOT LABELS' left with its two reads (phase 91 review WR-C02): they could not fail
    // on what they named; `ONLY THE LOAD REBUILDS` grades the board's nodes by kind and anchor.
    'STILL ANSWERS AFTER THE RELOAD': 3,
  },
  'leg 5 - ': {
    'leg 5 opens on the composed, reloaded board': 1,
    'ONE DISCONNECT TAKES BOTH': 1,
    'BOTH LEGS BACK': 2,
    'SAME CELLS HEAD-ON': 2,
    'NOTHING ON TOP': 1,
    'CABLE PLOTTED': 3,
    'CABLE SEEN ON SCREEN': 3,
  },
};

/**
 * The same count over the spec's own helpers (the 77-01 refuter round): the boot's inherited-use
 * check, the host-pause clear, the unaided-run check, the no-panel camera read and the same-page
 * mark. Each runs inside a leg, so a leg that kept every token of its own could still lose one of
 * these with the gate green.
 */
export const FUNCTION_TOKENS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  bootOnEmptyBoard: { 'USE OPTIONS INHERITED': 1 },
  clearHostPause: { 'HOST PAUSE CLEARED': 3 },
  expectRunningUnaided: { 'RUNS UNAIDED': 2 },
  recordCamera: { 'NO PANEL OVER THE BOARD': 1 },
  expectSamePage: { 'SAME PAGE': 1 },
};

/** The window property the boot marks the shared page with, and the constant holding the mark
 *  (R6: only the boot and `expectSamePage` may touch either). */
const PAGE_MARK_PROPERTY = '__fabCompWalkPage';

/** A cut table: by title PREFIX, the header entry that explains each cut, WHOLE, and the measured
 *  lines its body must quote word for word (R3, R4, R8). `header` is the entry's full text, held
 *  word for word like a leg's sentence, and must itself carry every quote (the 77-09 refuter
 *  round: holding only its 10-character label let the reason under it go with the gate green).
 *  `gone` is the text that may not appear in the spec's code while the cut stands (R10): the cut
 *  clause's assertion token and the grader that graded it. */
export type CutTable = Readonly<
  Record<string, { header: string; quotes: readonly string[]; gone?: readonly string[] }>
>;

/** A committed release trace (`fixtures/77-release-trace-<n>.json`, plan 77-09). */
interface RecordedRelease {
  ids: JamIds;
  R: number;
  expected: string;
  records: JamRecord[];
}

function recordedRelease(name: string): RecordedRelease {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as RecordedRelease;
}

/** The spec's `RUN_CELLS`, tail (the Source end) to head (the tile touching the Tee). */
const RUN_CELLS_TAIL_TO_HEAD: readonly (readonly [number, number])[] = [
  [5, 12],
  [6, 12],
  [7, 12],
  [8, 12],
  [9, 12],
  [10, 12],
];

/** The `RELEASE_THINNING` line leg 3 logs, rebuilt from a committed release trace: the grader's
 *  `thinningTicks` over its records, written in the spec's own format. */
export function recordedThinningLine(name: string): string {
  const rec = recordedRelease(name);
  const thin = thinningTicks(rec.records, rec.ids);
  const words = RUN_CELLS_TAIL_TO_HEAD.map(([x, y], i) => {
    const t = thin[i];
    if (t === null) throw new Error(`${name}: tile ${x},${y} never thinned in the recording`);
    return `${x},${y}=${t}(R+${t - rec.R})`;
  });
  return `RELEASE_THINNING ${words.join(' ')}`;
}

/** The two measured lines leg 3's cut quotes, both from committed release trace 1. */
const LEG3_CUT_ORDER = recordedRelease('77-release-trace-1.json').expected;
const LEG3_CUT_THINNING = recordedThinningLine('77-release-trace-1.json');

/**
 * The CUT declarations the walk must carry. Leg 3's "clears from the front", cut by the ruling of
 * 2026-10-08, which overturned NAMED DEVIATION A1 (the assertion of the front-first order on the sim
 * clock, made by the 77-03 refuter round on its D-15 re-measurement). `header` is the spec header's
 * whole CUT entry; both quotes are rebuilt from committed release trace 1.
 */
export const CUTS: CutTable = {
  'CUT - leg 3 clause "clears from the front": ': {
    header:
      'CUT (D-15, ruling of 2026-10-08). Leg 3\'s last clause, "then release and watch the jam ' +
      'clear from the front", is CUT and asserted nowhere. The maintainers overturned named deviation A1 on ' +
      '2026-10-08 with the ruling "cut it and carry on". Reason: on release the packed line visibly ' +
      'thins from the Source end, and the front-first order is a sim-clock fact of about 50 ms that ' +
      'nobody can see, so a "watch" clause cannot be graded on it. Measured on the committed release ' +
      'trace 1 (`src/gates/fixtures/77-release-trace-1.json`), the order runs 3 ticks from the front ' +
      `freeing to the belt behind moving: ${LEG3_CUT_ORDER} and the line the eye watches thins one ` +
      `tile at a time from the Source end, 137 to 173 ticks after the release: ${LEG3_CUT_THINNING} ` +
      'This engine releases a packed belt rigidly (`belt_slots.rs` `advance_slots`), so it cannot ' +
      'clear back from the front. The clause is declared LAST, titled `CUT - leg 3 clause "clears ' +
      'from the front": ...`, and its body throws this reason with both measured lines; ' +
      '`src/gates/jamGrading.test.ts` `CUT REASON (maintainer ruling) ...` reproduces both from the ' +
      'committed traces. What the eye sees on release is still asserted: the Tee\'s mark breaks (`BAR ' +
      'BROKEN ON THE CANVAS`, `BAR SEEN BROKEN ON SCREEN`), the Tee stays released (`STAYS ' +
      'RELEASED`), the line thins and stays clear (`RELEASE SUSTAINED`), the released run is drawn as ' +
      'the model holds it (`RUN DRAWN AFTER THE RELEASE`) and the board closes flowing into the Sink ' +
      '(`ENDS FLOWING`). Leg 3\'s title names what it still proves, "clears when released".',
    quotes: [LEG3_CUT_ORDER, LEG3_CUT_THINNING],
    gone: ['FRONT FIRST', 'frontFirstViolations'],
  },
};

/** The calls that count as a leg's first GESTURE (R6, R7). */
const GESTURES = [
  'armAndPlaceAt(',
  'handPlaceAt(',
  'drawOffloadBelt(',
  'drawWireBetweenPorts(',
  'selectMachineAt(',
  'pressSegment(',
  'page.mouse.',
  'page.keyboard.',
] as const;

const CUT_TITLE = /^CUT - leg \d/;

/** Every occurrence of a literal needle, as offsets. */
function occurrences(text: string, needle: string, offset = 0): number[] {
  const out: number[] = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(offset + i);
    i = text.indexOf(needle, i + 1);
  }
  return out;
}

const within = (at: number, span: { start: number; end: number } | null): boolean =>
  span !== null && at >= span.start && at < span.end;

const lineOf = (stripped: string, at: number): number => stripped.slice(0, at).split('\n').length;

/** The `test.afterAll(` call, from its name to its closing parenthesis. */
function afterAllSpan(stripped: string): SourceSpan | null {
  const m = /^[ \t]*test\.afterAll[ \t]*\(/m.exec(stripped);
  if (m === null) return null;
  const open = m.index + m[0].length - 1;
  const close = matchingParen(stripped, open);
  const end = close === -1 ? stripped.length : close + 1;
  return { start: m.index, end, text: stripped.slice(m.index, end) };
}

/** The first gesture's offset inside a body, or Infinity. */
function firstGesture(body: DeclarationBody): number {
  let first = Number.POSITIVE_INFINITY;
  for (const g of GESTURES) {
    const at = body.text.indexOf(g);
    if (at !== -1) first = Math.min(first, at);
  }
  return first;
}

/** The last gesture's offset inside a body (any GESTURE, or a `.click(`), or -1. */
function lastGesture(body: DeclarationBody): number {
  let last = -1;
  for (const g of [...GESTURES, '.click(']) last = Math.max(last, body.text.lastIndexOf(g));
  return last;
}

/** Every import statement, as spans, so a reference rule does not read the import list. */
function importSpans(stripped: string): SourceSpan[] {
  return [...stripped.matchAll(/^import\b[\s\S]*?\bfrom\s*(['"])[^'"]*\1\s*;/gm)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    text: m[0],
  }));
}

/**
 * Every REFERENCE to the identifier `name` in code (string contents blanked, imports skipped),
 * excluding its own `function name` declaration. A reference, not only a call: `const wipe =
 * newBoard; await wipe(page);` calls nothing named `newBoard` and still makes a fresh board
 * (the 77-01 refuter round). A property access `x.newBoard` counts too.
 */
function references(stripped: string, name: string): number[] {
  const code = blankStrings(stripped);
  const imports = importSpans(stripped);
  const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g');
  const out: number[] = [];
  for (const m of code.matchAll(re)) {
    if (imports.some((sp) => within(m.index, sp))) continue;
    if (/function[ \t]+$/.test(code.slice(Math.max(0, m.index - 16), m.index))) continue;
    out.push(m.index);
  }
  return out;
}

/** The callee names in a stretch of code (string contents blanked): `x(` and `a.b.x(` give `x`. */
function calleesIn(code: string): string[] {
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await']);
  return [...blankStrings(code).matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((m) => m[1])
    .filter((n) => !keywords.has(n));
}

/** A top-level function's body, from just after its opening brace. */
function bodyAfterSignature(fn: SourceSpan): string {
  const open = fn.text.indexOf('(');
  const close = matchingParen(fn.text, open);
  const brace = fn.text.indexOf('{', close === -1 ? open : close);
  return brace === -1 ? '' : fn.text.slice(brace + 1);
}

/** A test declaration's body, from just after the `=> {` that opens its callback. */
function legCallback(body: DeclarationBody): string {
  const at = body.text.indexOf('=> {');
  return at === -1 ? body.text : body.text.slice(at + 4);
}

/** Collapse whitespace and drop markdown bold markers. */
const normalise = (s: string): string => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

/**
 * The five leg sentences of REQUIREMENTS.md's "The milestone done-test", leg 4 from its AMENDED
 * line. A leg that cannot be read is reported, so the rule never passes on an empty list.
 */
export function doneTestSentences(requirements: string): { legs: Map<number, string>; missing: number[] } {
  const start = requirements.indexOf('### The milestone done-test');
  const legs = new Map<number, string>();
  if (start !== -1) {
    const tail = requirements.slice(start);
    const stop = tail.search(/\n(?:---|## )/);
    const section = (stop === -1 ? tail : tail.slice(0, stop)).replace(/\s+/g, ' ');
    for (const m of section.matchAll(/(?:^|\s)([1-5])\. \*\*(.+?)\*\*/g)) {
      const n = Number(m[1]);
      if (!legs.has(n)) legs.set(n, normalise(m[2]));
    }
    const amended = /leg 4 now reads: \*\*(.+?)\*\*/.exec(section);
    if (amended !== null) legs.set(4, normalise(amended[1]));
    else legs.delete(4);
  }
  const missing = [1, 2, 3, 4, 5].filter((n) => !legs.has(n));
  return { legs, missing };
}

/** The spec's header comment: every `//` line above `test.describe.configure(`, markers removed. */
function headerText(raw: string): string {
  const cut = raw.indexOf('test.describe.configure(');
  const head = cut === -1 ? raw : raw.slice(0, cut);
  return normalise(
    head
      .split('\n')
      .filter((l) => /^\s*\/\//.test(l))
      .map((l) => l.replace(/^\s*\/\/\s?/, ''))
      .join(' '),
  );
}

// ---------------------------------------------------------------------------
// The eleven rules. Each returns its findings, each finding prefixed with its rule.
// ---------------------------------------------------------------------------

function ruleR1(stripped: string): string[] {
  if (/^[ \t]*test\.describe\.configure\(\s*\{\s*mode:\s*(['"])serial\1\s*\}\s*\)/m.test(stripped)) {
    return [];
  }
  return [
    'R1: serial mode is no longer declared. The legs run in order on ONE board and a test after a ' +
      'failing one must not run, and both are properties of `mode: serial`',
  ];
}

/**
 * The modifier names R2 refuses, reached through ANY object (the 77-09 refuter round):
 * `test.info().skip()`, `testInfo.skip()` and `testInfo.fail()` skip a leg, or turn its failure
 * green, as surely as `test.skip(` does, and the first pattern needed `test.` right before the name.
 * `expectedStatus` is the property those calls set.
 */
const SKIP_NAMES = 'skip|fixme|fail|only|expectedStatus';

function ruleR2(stripped: string): string[] {
  const out: string[] = [];
  const code = blankStrings(stripped);
  const member = new RegExp(`\\.\\s*(?:${SKIP_NAMES})(?![\\w$])`, 'g');
  const bracket = new RegExp(`\\[\\s*(['"\`])(?:${SKIP_NAMES})\\1\\s*\\]`, 'g');
  for (const m of [...code.matchAll(member), ...stripped.matchAll(bracket)]) {
    out.push(
      `R2: line ${lineOf(stripped, m.index)}: forbidden modifier \`${m[0].replace(/\s+/g, '')}\`. A skip, ` +
        'fixme or fail is a green suite over a missing proof, and an `only` narrows the live suite to ' +
        'this file, whatever object it is reached through',
    );
  }
  return out;
}

function ruleR3(stripped: string, cuts: CutTable): string[] {
  const titles = declarations(stripped).map((d) => d.title);
  const firstCut = titles.findIndex((t) => CUT_TITLE.test(t));
  const walking = firstCut === -1 ? titles : titles.slice(0, firstCut);
  const out: string[] = [];
  const inOrder =
    walking.length === EXPECTED_ORDER.length &&
    EXPECTED_ORDER.every((prefix, i) => walking[i].startsWith(prefix));
  if (!inOrder) {
    out.push(
      `R3: the walking legs are not the expected ones in the expected order.\n  expected: ` +
        `${EXPECTED_ORDER.join(' | ')}\n  found: ${walking.join(' | ')}\n  A declaration appended ` +
        'below the last leg never runs once anything above it goes red, and a reorder changes what ' +
        'every later leg inherits. Extend EXPECTED_ORDER deliberately to add a leg',
    );
  }
  if (firstCut !== -1) {
    for (const t of titles.slice(firstCut)) {
      if (!CUT_TITLE.test(t)) {
        out.push(
          `R3: \`${t}\` is declared after a CUT declaration. A cut leg is declared LAST, after every ` +
            'walking leg, so it can never stop a walking leg from running',
        );
      }
    }
  }
  const cutBlock = firstCut === -1 ? [] : titles.slice(firstCut);
  for (const prefix of Object.keys(cuts)) {
    if (!cutBlock.some((t) => t.startsWith(prefix))) {
      out.push(
        `R3: the CUT \`${prefix}...\` is not declared after the walking legs. A cut is a recorded ` +
          'decision (77 D-15): deleting its declaration drops the clause silently',
      );
    }
  }
  return out;
}

/**
 * Why a CUT declaration is not ONE unconditional throw, or `null` when it is (the 77-09 refuter
 * round). Counting `throw new Error(` text let an early `return;`, an `if (...)` over the throw, a
 * `try`/`catch` around it, or a closure never called keep the text and pass the cut. The only
 * form accepted is `test('CUT - ...', async () => { throw new Error(<reason>); });`: no parameter,
 * nothing before the throw, nothing after it, and a reason built from string literals alone
 * (joined with `+` or an array's `.join(`), so no code runs inside it either.
 */
function cutNotLoud(body: DeclarationBody): string | null {
  const code = blankStrings(body.text);
  const head = /^[ \t]*test[ \t]*\(\s*(['"`])[^'"`]*\1\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*throw\s+new\s+Error\s*\(/.exec(code);
  if (head === null) {
    return 'its callback does not open with the throw: it takes a parameter, or a statement runs before the throw';
  }
  const open = head[0].length - 1;
  const close = matchingParen(code, open);
  if (close === -1) return 'its `new Error(` is never closed';
  const reasonCode = code.slice(open + 1, close).replace(/\.\s*join\s*\(/g, '(');
  const idents = [...reasonCode.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
  if (idents.length > 0) {
    return `its reason runs code (\`${idents.join('`, `')}\`); a reason is string literals only`;
  }
  if (!/^\s*;?\s*\}\s*\)\s*;?\s*$/.test(code.slice(close + 1))) {
    return 'something follows the throw inside or after its callback';
  }
  return null;
}

function ruleR4(stripped: string, cuts: CutTable): string[] {
  const out: string[] = [];
  for (const body of declarationBodies(stripped)) {
    const throws = body.text.match(/\bthrow\s+new\s+Error\s*\(/g)?.length ?? 0;
    const isCut = CUT_TITLE.test(body.declaration.title);
    if (!isCut && throws > 0) {
      out.push(
        `R4: line ${body.declaration.line}: \`${body.declaration.title}\` throws. An unconditional ` +
          'throw belongs only inside a CUT declaration, declared last, naming its reason',
      );
    }
    if (isCut && throws === 0) {
      out.push(
        `R4: line ${body.declaration.line}: the CUT declaration \`${body.declaration.title}\` does ` +
          'not throw. A cut fails loudly with its reason, it never passes (77 D-15, D-20)',
      );
    }
    const quiet = isCut && throws > 0 ? cutNotLoud(body) : null;
    if (quiet !== null) {
      out.push(
        `R4: line ${body.declaration.line}: the CUT declaration \`${body.declaration.title}\` is not ` +
          `ONE unconditional throw: ${quiet}. A cut that can return, skip or catch before its throw ` +
          'passes silently (77 D-15, D-20)',
      );
    }
    for (const [prefix, cut] of Object.entries(cuts)) {
      if (!body.declaration.title.startsWith(prefix)) continue;
      for (const line of cut.quotes) {
        if (!body.text.includes(line)) {
          out.push(
            `R4: line ${body.declaration.line}: the CUT declaration \`${body.declaration.title}\` ` +
              `does not quote its measured line \`${line}\`. A cut's reason is the measurement, word ` +
              'for word (77 D-15)',
          );
        }
      }
    }
  }
  return out;
}

function ruleR5(stripped: string): string[] {
  const out: string[] = [];
  const bodies = declarationBodies(stripped);
  const leg1 = bodies.find((b) => b.declaration.title.startsWith('leg 1 - ')) ?? null;
  const leg4 = bodies.find((b) => b.declaration.title.startsWith('leg 4 - ')) ?? null;
  const boot = functionBody(stripped, 'bootOnEmptyBoard');
  const afterAll = afterAllSpan(stripped);
  // A REFERENCE outside its allowed place, not only a call (the 77-01 refuter round).
  for (const at of references(stripped, 'bootOnEmptyBoard')) {
    if (!within(at, leg1)) {
      out.push(
        `R5: line ${lineOf(stripped, at)}: \`bootOnEmptyBoard\` is referenced outside leg 1. Only leg 1 ` +
          'boots; a later leg that boots its own board is the five-specs-in-one-file shape',
      );
    }
  }
  for (const at of references(stripped, 'resetToDemo')) {
    if (!within(at, boot)) {
      out.push(
        `R5: line ${lineOf(stripped, at)}: \`resetToDemo\` is referenced outside \`bootOnEmptyBoard\`. ` +
          'The host is reset once, by the boot',
      );
    }
  }
  for (const at of references(stripped, 'newBoard')) {
    if (!within(at, boot) && !within(at, leg4)) {
      out.push(
        `R5: line ${lineOf(stripped, at)}: \`newBoard\` is referenced outside the boot and leg 4. A ` +
          'fresh board anywhere else gives a leg its own board, through an alias as much as a call',
      );
    }
  }
  for (const at of references(stripped, 'loadDemoViaExamples')) {
    if (!within(at, afterAll)) {
      out.push(
        `R5: line ${lineOf(stripped, at)}: \`loadDemoViaExamples\` is referenced outside ` +
          '`test.afterAll`. The demo comes back only once the walk is over',
      );
    }
  }
  // The shipped controls those helpers press, pressed directly (the 77-01 refuter round): the
  // New button or its shortcut, and the Examples popover. Nowhere in the spec; `newBoard` and
  // `loadDemoViaExamples` in `support/oracle.ts` own them.
  // The 77-03 refuter round: the button's ACCESSIBLE NAME is `New` (`Toolbar.tsx`, `aria-label`
  // and its text), so a string or regex literal naming exactly `New` (`getByRole('button', { name:
  // 'New' })`, `getByText('New')`, `name: /^New$/`) presses it as surely as its title does.
  for (const m of stripped.matchAll(
    /New board|\b(?:Control|Meta|ControlOrMeta)\+[nN]\b|\bExamples\b|(['"`])New\1|\/\^?New\$?\/[a-z]*/g,
  )) {
    out.push(
      `R5: line ${lineOf(stripped, m.index)}: \`${m[0]}\` presses the New or Examples control directly. ` +
        'A fresh board is made only through `newBoard`, in the boot and leg 4',
    );
  }
  return out;
}

function ruleR6(stripped: string): string[] {
  const out: string[] = [];
  const boot = functionBody(stripped, 'bootOnEmptyBoard');
  const attach = functionBody(stripped, 'attachToRunningBoard');
  const afterAll = afterAllSpan(stripped);
  if (boot === null) {
    out.push('R6: `bootOnEmptyBoard` is not declared as a top-level function');
  } else {
    const watch = boot.text.indexOf('watchPageErrors(');
    const goto = boot.text.indexOf('.goto(');
    if (watch === -1 || goto === -1 || watch > goto) {
      out.push(
        'R6: `bootOnEmptyBoard` must install `watchPageErrors(` BEFORE its `page.goto(`: a listener ' +
          'registered after a boot-time throw records nothing',
      );
    }
  }
  if (attach === null) {
    out.push('R6: `attachToRunningBoard` is not declared as a top-level function');
  } else {
    if (!attach.text.includes('watchPageErrors(')) {
      out.push('R6: `attachToRunningBoard` does not install `watchPageErrors(` for its leg');
    }
    if (attach.text.includes('.goto(') || attach.text.includes('.reload(')) {
      out.push(
        'R6: `attachToRunningBoard` navigates or reloads. A later leg attaches to the page as the ' +
          'previous leg left it, in the same page session',
      );
    }
    const unaided = attach.text.indexOf('expectRunningUnaided(');
    const playing = attach.text.indexOf('ensurePlaying(');
    if (unaided === -1 || playing === -1 || unaided > playing) {
      out.push(
        'R6: `attachToRunningBoard` must call `expectRunningUnaided(` BEFORE `ensurePlaying(`: an ' +
          'attach asserts the board runs unaided, it does not rescue a stopped one',
      );
    }
    // NOTHING BUT THE WATCHER before the unaided check (the 77-01 refuter round): a Play press,
    // a transport click or any other call ahead of it is a rescue the order rule above cannot see.
    if (unaided !== -1) {
      const inner = bodyAfterSignature(attach);
      const head = inner.slice(0, inner.indexOf('expectRunningUnaided('));
      const before = calleesIn(head).filter((c) => c !== 'watchPageErrors');
      if (before.length > 0) {
        out.push(
          `R6: \`attachToRunningBoard\` calls ${before.map((c) => `\`${c}(\``).join(', ')} before ` +
            '`expectRunningUnaided(`. Only the page-error watcher may come first: anything else can ' +
            'press Play on a board the previous leg left stopped, and the attach would rescue it',
        );
      }
    }
    if (!attach.text.includes('expectSamePage(')) {
      out.push(
        'R6: `attachToRunningBoard` does not call `expectSamePage(`: the one page is measured at ' +
          'every attach, so a leg that reloaded it is red at the next one',
      );
    }
    if (!attach.text.includes('recordCamera(')) {
      out.push('R6: `attachToRunningBoard` does not call `recordCamera(` (NO PANEL OVER THE BOARD)');
    }
  }
  if (boot !== null) {
    const clear = boot.text.indexOf('clearHostPause(');
    const reset = boot.text.indexOf('resetToDemo(');
    if (clear === -1 || reset === -1 || clear > reset) {
      out.push(
        'R6: `bootOnEmptyBoard` must call `clearHostPause(` before `resetToDemo(`: after a user ' +
          'Pause, LoadDemo and New stay Frozen and a fresh page cannot see it (77-01 review blocker)',
      );
    }
    if (!boot.text.includes('recordCamera(')) {
      out.push('R6: `bootOnEmptyBoard` does not call `recordCamera(` (NO PANEL OVER THE BOARD)');
    }
    if (!boot.text.includes(PAGE_MARK_PROPERTY)) {
      out.push(
        `R6: \`bootOnEmptyBoard\` does not leave the \`${PAGE_MARK_PROPERTY}\` mark on the page, so ` +
          'no later read can tell the one page from a reloaded one',
      );
    }
  }
  // The mark is written by the boot and read by `expectSamePage`, nowhere else: a leg that
  // re-planted it after a reload would pass every read.
  const samePage = functionBody(stripped, 'expectSamePage');
  for (const needle of [PAGE_MARK_PROPERTY, 'PAGE_MARK']) {
    const re = new RegExp(`(?<![\\w$])${needle}(?![\\w$])`, 'g');
    for (const m of stripped.matchAll(re)) {
      const declared = /const[ \t]+$/.test(stripped.slice(Math.max(0, m.index - 8), m.index));
      if (declared || within(m.index, boot) || within(m.index, samePage)) continue;
      out.push(
        `R6: line ${lineOf(stripped, m.index)}: \`${needle}\` is touched outside the boot and ` +
          '`expectSamePage`. Only the boot marks the page; a leg that wrote the mark could hide a reload',
      );
    }
  }
  // Navigation by any other name (the 77-01 refuter round): R6's `.goto(` and `.reload(` reads
  // could not see `location.href = '/'` inside a `page.evaluate`.
  for (const m of stripped.matchAll(
    /\blocation\s*(?:\.\s*(?:href|assign|replace|reload)\b|=[^=])|\bhistory\s*\.\s*(?:back|forward|go|pushState|replaceState)\b|\.(?:goBack|goForward|setContent)\s*\(|\bwindow\s*\.\s*open\s*\(/g,
  )) {
    out.push(
      `R6: line ${lineOf(stripped, m.index)}: \`${m[0].trim()}\` navigates the page. The legs share ` +
        'one page that never navigates after the boot',
    );
  }
  const walking = declarationBodies(stripped).filter((b) => !CUT_TITLE.test(b.declaration.title));
  const lastLeg = walking[walking.length - 1];
  if (lastLeg !== undefined) {
    const check = lastLeg.text.lastIndexOf('expectSamePage(');
    if (check === -1 || check < lastGesture(lastLeg)) {
      out.push(
        `R6: \`${lastLeg.declaration.title}\`, the last walking leg, must call \`expectSamePage(\` ` +
          'after its last gesture: no attach follows it, so a reload inside it is seen only there',
      );
    }
  }
  for (const at of occurrences(stripped, '.goto(')) {
    if (!within(at, boot) && !within(at, afterAll)) {
      out.push(
        `R6: line ${lineOf(stripped, at)}: a \`.goto(\` outside the boot and \`test.afterAll\`. The ` +
          'legs share one page that never navigates after the boot',
      );
    }
  }
  for (const at of occurrences(stripped, '.reload(')) {
    out.push(`R6: line ${lineOf(stripped, at)}: a \`.reload(\`. The shared page never reloads`);
  }
  for (const body of declarationBodies(stripped)) {
    if (CUT_TITLE.test(body.declaration.title)) continue;
    const title = body.declaration.title;
    const isLeg1 = title.startsWith('leg 1 - ');
    const entry = body.text.indexOf(isLeg1 ? 'bootOnEmptyBoard(' : 'attachToRunningBoard(');
    if (entry === -1 || entry > firstGesture(body)) {
      out.push(
        `R6: \`${title}\` must call \`${isLeg1 ? 'bootOnEmptyBoard(' : 'attachToRunningBoard('}\` ` +
          'before its first gesture',
      );
    }
    const alive = (body.text.match(/\bexpectRenderLoopAlive\s*\(/g) ?? []).length;
    if (alive < 3) {
      out.push(
        `R6: \`${title}\` calls \`expectRenderLoopAlive(\` ${alive} time(s), at least 3 are required: ` +
          'the live oracle reads only the model, so render health is checked through the leg',
      );
    }
    if (!body.text.includes('assertNone(')) {
      out.push(`R6: \`${title}\` never calls \`assertNone(\` on its page-error watcher`);
    }
  }
  return out;
}

function ruleR7(stripped: string): string[] {
  const out: string[] = [];
  for (const body of declarationBodies(stripped)) {
    const title = body.declaration.title;
    if (CUT_TITLE.test(title) || title.startsWith('leg 1 - ')) continue;
    const req = body.text.indexOf('required(');
    const attach = body.text.indexOf('attachToRunningBoard(');
    const gesture = firstGesture(body);
    if (req === -1 || (attach !== -1 && req > attach) || req > gesture) {
      out.push(
        `R7: \`${title}\` must call \`required(\` before \`attachToRunningBoard(\` and before its ` +
          'first gesture, so a leg run without its predecessor fails naming that predecessor',
      );
    }
    // Only the handoff reads before the attach (the 77-01 refuter round): a Play press in the leg
    // ahead of its attach would rescue the board as surely as one inside the attach.
    const callback = legCallback(body);
    const at = callback.indexOf('attachToRunningBoard(');
    if (at !== -1) {
      const before = calleesIn(callback.slice(0, at)).filter((c) => c !== 'sharedPage' && c !== 'required');
      if (before.length > 0) {
        out.push(
          `R7: \`${title}\` calls ${before.map((c) => `\`${c}(\``).join(', ')} before ` +
            '`attachToRunningBoard(`. Only `sharedPage(` and `required(` may come first, so nothing ' +
            'touches the board before the attach asserts what the previous leg left',
        );
      }
    }
  }
  return out;
}

function ruleR8(raw: string, requirements: string, cuts: CutTable): string[] {
  const out: string[] = [];
  const { legs, missing } = doneTestSentences(requirements);
  for (const n of missing) {
    out.push(`R8: leg ${n} of the done-test could not be read from REQUIREMENTS.md`);
  }
  const header = headerText(raw);
  for (const [n, sentence] of legs) {
    if (!header.includes(sentence)) {
      out.push(
        `R8: the spec header does not carry done-test leg ${n} word for word (77 D-08): "${sentence}"`,
      );
    }
  }
  for (const [prefix, cut] of Object.entries(cuts)) {
    const entry = normalise(cut.header);
    const opens = entry.split(' ').slice(0, 2).join(' ');
    for (const line of cut.quotes) {
      if (!entry.includes(normalise(line))) {
        out.push(
          `R8: the cut table's header entry for \`${prefix}...\` (\`${opens} ...\`) does not carry its ` +
            `measured line \`${line}\`: the header explains a cut by its measurement (77 D-08, D-15)`,
        );
      }
    }
    if (!header.includes(entry)) {
      out.push(
        `R8: the spec header does not carry the \`${opens} ...\` entry that explains the CUT ` +
          `\`${prefix}...\` word for word (77 D-08: nothing departs from the done-test silently)`,
      );
    }
  }
  return out;
}

function ruleR9(stripped: string): string[] {
  // `setTimeout` and `setInterval` too (the 77-01 refuter round): `await new Promise((r) =>
  // setTimeout(r, 2000))` is the same fixed sleep under another name.
  return [...stripped.matchAll(/\.waitForTimeout\s*\(|\bset(?:Timeout|Interval)\b|\bsleep\s*\(/g)].map(
    (m) =>
      `R9: line ${lineOf(stripped, m.index)}: a fixed-time sleep. Every wait in the walk is a ` +
      'poll on the change it awaits',
  );
}

/**
 * Matchers that ask only that a value EXISTS, never what it is (the 77-02 refuter round, refuter
 * 3): `.toEqual({ drawn: FULL, model: FULL })` weakened to `.toBeTruthy()` kept every pinned count
 * and the gate green. A pinned assertion may not end in one of these, in a negated matcher, in no
 * matcher at all, or in a matcher whose expected value is `expect.anything()` or `expect.any(`.
 */
export const WEAK_MATCHERS = ['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeUndefined', 'toBeNull', 'toBeNaN'] as const;

/** The text of an argument list's FIRST argument (strings blanked, so a comma inside a message
 *  does not end it), trimmed. */
function firstArgument(args: string): string {
  const code = blankStrings(args);
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) return code.slice(0, i).trim();
  }
  return code.trim();
}

/** Words that name a constant, not a value the walk read. */
const CONSTANT_WORDS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'void', 'async']);

/** The pinned assertions in `text` whose matcher could not fail on a wrong value (R10). */
function weakPinnedAssertions(text: string, tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of assertionArguments(text)) {
    const token = tokens.find((t) => a.text.includes(t));
    if (token === undefined) continue;
    // The two helpers assert inside and return nothing to match.
    if (/(?:expectRunningUnaided|expectRefusalStayedSilent|expectHeadOn)\s*\($/.test(text.slice(Math.max(0, a.start - 40), a.start))) continue;
    // A TAUTOLOGY (the 77-09 refuter round): `expect(true, 'RELEASE SUSTAINED').toBe(true)` kept the
    // token, the count and a strong matcher. A subject that names nothing the walk read (only
    // literals and constant words, an arrow returning one included) cannot fail on a wrong board.
    const subject = firstArgument(a.text);
    const named = [...subject.matchAll(/[A-Za-z_$][\w$]*/g)].filter((w) => !CONSTANT_WORDS.has(w[0]));
    if (subject !== '' && named.length === 0) {
      out.push(`\`${token}\` asserts the constant \`${subject.replace(/\s+/g, ' ')}\`, which no board can make wrong`);
      continue;
    }
    const m = assertionMatcher(text, a);
    if (m !== null && m.argument.replace(/\s+/g, '') !== '' && blankStrings(m.argument).replace(/\s+/g, '') === subject.replace(/\s+/g, '')) {
      out.push(`\`${token}\` compares its subject with itself, which no board can make wrong`);
      continue;
    }
    if (m === null) out.push(`\`${token}\` ends in no matcher, so it asserts nothing`);
    else if ((WEAK_MATCHERS as readonly string[]).includes(m.name)) out.push(`\`${token}\` ends in \`.${m.name}(\`, which asks only that a value exists`);
    else if (m.negated) out.push(`\`${token}\` ends in a negated \`.not.${m.name}(\`, which any other value passes`);
    else if (/\bexpect\s*\.\s*(?:anything|any)\s*\(/.test(m.argument)) out.push(`\`${token}\` expects \`expect.anything\` or \`expect.any\`, which any value of the type passes`);
  }
  return out;
}

function ruleR10(stripped: string): string[] {
  const out: string[] = [];
  const check = (where: string, text: string, pinned: Readonly<Record<string, number>>): void => {
    for (const weak of weakPinnedAssertions(text, Object.keys(pinned))) {
      out.push(`R10: \`${where}\`: the assertion carrying ${weak}. A defining assertion grades the value`);
    }
    const counts = assertionsCarrying(text, Object.keys(pinned));
    for (const [t, want] of Object.entries(pinned)) {
      if (counts[t] === want) continue;
      out.push(
        counts[t] === 0
          ? `R10: \`${where}\` lost its defining assertion \`${t}\`: the token is not inside any ` +
              'assertion call. A leg keeps its title only while it keeps what it proves'
          : `R10: \`${where}\` carries \`${t}\` in ${counts[t]} assertion call(s), ${want} pinned. ` +
              'Every assertion that carries a defining token is pinned, so deleting one is red; a ' +
              'deliberate change updates LEG_TOKENS or FUNCTION_TOKENS',
      );
    }
  };
  for (const body of declarationBodies(stripped)) {
    const title = body.declaration.title;
    for (const [prefix, pinned] of Object.entries(LEG_TOKENS)) {
      if (title.startsWith(prefix)) check(title, body.text, pinned);
    }
  }
  for (const [name, pinned] of Object.entries(FUNCTION_TOKENS)) {
    const fn = functionBody(stripped, name);
    if (fn === null) out.push(`R10: \`${name}\` is not declared as a top-level function`);
    else check(name, fn.text, pinned);
  }
  return out;
}

/**
 * R10, the cut half: a cut clause is asserted nowhere. While a cut stands, the spec's code (comments
 * stripped, strings kept) may not carry anything the cut lists under `gone`: the cut clause's
 * assertion token, in any message, and the grader that graded it, by any use. Leg 3's cut lists
 * `FRONT FIRST` and `frontFirstViolations` (the ruling of 2026-10-08: the front-first order is a
 * sim-clock fact nobody can see, so it is not graded under any name this rule knows).
 */
function ruleR10Cut(stripped: string, cuts: CutTable): string[] {
  const out: string[] = [];
  for (const [prefix, cut] of Object.entries(cuts)) {
    for (const needle of cut.gone ?? []) {
      for (const at of occurrences(stripped, needle)) {
        out.push(
          `R10: line ${lineOf(stripped, at)}: \`${needle}\` appears in the spec's code while the CUT ` +
            `\`${prefix}...\` stands. A cut clause is asserted nowhere and its grader is not called ` +
            '(77 D-15, D-20); lifting a cut is a deliberate change to CUTS and the header',
        );
      }
    }
  }
  return out;
}

/**
 * The names the rules count or the legs assert through, and where each must be bound (R11): an
 * import from its module under its own name, or the spec's one top-level function.
 */
const GUARDED_IMPORTS: Readonly<Record<string, string>> = {
  test: '@playwright/test',
  expect: '@playwright/test',
  expectRenderLoopAlive: './support/oracle',
  watchPageErrors: './support/oracle',
  ensurePlaying: './support/oracle',
  pollScene: './support/oracle',
  expectRefusalStayedSilent: './support/oracle',
  newBoard: './support/oracle',
  resetToDemo: './support/oracle',
  loadDemoViaExamples: './support/oracle',
  // The 77-05 refuter round: the cable reads and the leg 5 wiring R12 and R13 hold.
  cablePolylines: './support/oracle',
  expectHeadOn: './support/oracle',
  recordStatusStripDuring: './support/oracle',
  cameraOf: './support/oracle',
  screenPoint: './support/oracle',
  cablesOnCanvas: './support/canvasDots',
};
const GUARDED_LOCALS = [
  'required',
  'sharedPage',
  'expectRunningUnaided',
  'clearHostPause',
  'recordCamera',
  'expectSamePage',
  'bootOnEmptyBoard',
  'attachToRunningBoard',
  'drawnCableSet',
  'drawnCableGrade',
  'cablesToRead',
  'cablesOnScreen',
] as const;
/** The two whose members are used directly (`test.info(`, `expect.poll(`). */
const MEMBER_USE = new Set(['test', 'expect']);

/**
 * R11 (the 77-09 refuter round): every guarded name is CALLED, never rebound. R6 counted
 * `expectRenderLoopAlive(` text, so `const expectRenderLoopAlive = async () => {};` inside leg 3
 * replaced every render-health check in that leg with one that does nothing and kept the count.
 * Each guarded name is bound once, where `GUARDED_IMPORTS` or `GUARDED_LOCALS` says, and every
 * other occurrence is a direct call (`name(`, `name<T>(`), a member use for `test` and `expect`, or
 * a `typeof` in a type: a declaration, a parameter, a destructured key, an assignment, a value
 * passed along or a property of another object (`x.name(`) is refused.
 */
function ruleR11(stripped: string): string[] {
  const out: string[] = [];
  const code = blankStrings(stripped);
  const imports = importSpans(stripped);
  for (const [name, from] of Object.entries(GUARDED_IMPORTS)) {
    const own = imports.find((sp) => sp.text.includes(`'${from}'`) || sp.text.includes(`"${from}"`));
    const bound = new RegExp(`(?<!\\bas\\s{1,40})(?<![\\w$.])${name}(?![\\w$])(?!\\s+as\\b)`);
    const named = own === undefined ? null : /\{([^}]*)\}/.exec(own.text);
    if (named === null || !bound.test(named[1])) {
      out.push(`R11: \`${name}\` is not imported under its own name from '${from}'`);
    }
  }
  for (const sp of imports) {
    for (const name of [...Object.keys(GUARDED_IMPORTS), ...GUARDED_LOCALS]) {
      if (new RegExp(`\\bas\\s+${name}(?![\\w$])|^import\\s+(?:type\\s+)?${name}\\b`).test(sp.text)) {
        out.push(`R11: an import binds another value to \`${name}\``);
      }
    }
  }
  for (const name of [...Object.keys(GUARDED_IMPORTS), ...GUARDED_LOCALS]) {
    const isLocal = (GUARDED_LOCALS as readonly string[]).includes(name);
    const topLevel = new RegExp(`^(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]+${name}(?![\\w$])`, 'gm');
    const decls = [...code.matchAll(topLevel)].map((m) => m.index + m[0].length - name.length);
    if (isLocal && decls.length !== 1) {
      out.push(`R11: \`${name}\` is declared ${decls.length} time(s) as a top-level function, once is required`);
    }
    if (!isLocal && decls.length > 0) {
      out.push(`R11: \`${name}\` is imported, and a top-level function declares it again`);
    }
    const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g');
    for (const m of code.matchAll(re)) {
      if (imports.some((sp) => within(m.index, sp))) continue;
      if (decls.includes(m.index)) continue;
      const before = code.slice(Math.max(0, m.index - 12), m.index);
      const after = code.slice(m.index + name.length);
      if (/typeof\s+$/.test(before)) continue;
      // A property of another object, or a function of the same name declared inside a leg.
      const member = /[.]\s*$/.test(before) || /\bfunction\s*\*?\s*$/.test(before);
      const called = /^\s*[(<]/.test(after) || (MEMBER_USE.has(name) && /^\s*\./.test(after));
      if (called && !member) continue;
      out.push(
        `R11: line ${lineOf(stripped, m.index)}: \`${name}\` is used other than by a direct call. A ` +
          'guarded name is called, never rebound, shadowed or reached through another object, so the ' +
          'rules that count its calls count the real thing',
      );
    }
  }
  return out;
}

/**
 * R12 (the 77-05 refuter round, refuter 2): what each named READ helper reads through. Every
 * check the legs make on a cable's plot or its pixels goes through one of these, so a body
 * rewritten to read something else keeps every token, every count and every call site, and both
 * tiers stayed green with `drawnCableSet` building its polylines from `scene().wires[].path`.
 * `must` are the calls the body makes; `only`, when given, is every call it may make; `never` are
 * calls it may not make; `neverNames` are identifiers it may not name at all (a read of model data
 * needs no call).
 */
export const READ_SOURCES: Readonly<
  Record<string, { must: readonly string[]; only?: readonly string[]; never?: readonly string[]; neverNames?: readonly string[] }>
> = {
  drawnCableSet: {
    must: ['cablePolylines'],
    only: ['cablePolylines', 'map', 'join', 'sort', 'localeCompare', 'round', 'half'],
    neverNames: ['scene', 'wires', 'path', 'board', 'readScene', 'evaluate'],
  },
  drawnCableGrade: { must: ['cablePolylines', 'readScene', 'gradeDrawnCables'], never: ['evaluate', 'drawnCableSet'] },
  cablesOnScreen: {
    // Its capture goes through `captureClip` (the oracle's budgeted clip capture, plan 84-18).
    must: ['cameraOf', 'screenPoint', 'evaluate', 'captureClip', 'cablesOnCanvas'],
    never: ['cablePolylines', 'readScene', 'drawnCableSet', 'drawnCableGrade', 'pollScene'],
  },
};

function ruleR12(stripped: string): string[] {
  const out: string[] = [];
  for (const [name, src] of Object.entries(READ_SOURCES)) {
    const fn = functionBody(stripped, name);
    if (fn === null) {
      out.push(`R12: \`${name}\` is not declared as a top-level function`);
      continue;
    }
    const body = bodyAfterSignature(fn);
    const callees = calleesIn(body);
    for (const c of src.must) {
      if (!callees.includes(c)) out.push(`R12: \`${name}\` does not call \`${c}(\`: it must read through it`);
    }
    for (const c of new Set(callees)) {
      if (src.only !== undefined && !src.only.includes(c)) {
        out.push(`R12: \`${name}\` calls \`${c}(\`, which is not one of the calls it reads through (${src.only.join(', ')})`);
      }
      if (src.never?.includes(c)) out.push(`R12: \`${name}\` calls \`${c}(\`, which it may not read through`);
    }
    const code = blankStrings(body);
    for (const w of src.neverNames ?? []) {
      if (new RegExp(`(?<![\\w$])${w}(?![\\w$])`).test(code)) {
        out.push(`R12: \`${name}\` names \`${w}\`: it reads the plot alone, never the model or a record`);
      }
    }
  }
  return out;
}

/**
 * R13 (the 77-05 refuter round, refuter 3): the wiring a leg's claim rests on, as code fragments
 * with every space removed, and how many times each occurs in the leg's body (strings kept,
 * comments stripped). Leg 5 pressed Ctrl+Z twice, and graded `NOTHING ON TOP` on a one-element
 * copy of the strip with the recording gone, and the gate stayed green on both. `KEYBOARD_CALLS`
 * pins how many `keyboard.` calls the leg makes at all, so an undo through another key cannot be
 * added beside the one pinned.
 */
export const LEG_WIRING: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  // Leg 4's re-POST after the last reload (quick 261009-rhl, v9.0 audit Part 1 gap 1). R10 counts
  // its `STILL ANSWERS AFTER THE RELOAD` assertions but cannot see WHAT they expect or WHERE the
  // POST went: the body swapped for the preset, or the POST sent to leg 1's pre-reload URL, kept
  // every count. So the URL read off the reloaded Route's panel, the POST to that URL, and the
  // `{ status: 200, body: PANEL_BODY }` expectation are pinned as written.
  'leg 4 - ': {
    'awaitselectMachineAt(page,ROUTE_CELL[0],ROUTE_CELL[1]);constreloadedUrl=awaitreadPanelUrl(page);': 1,
    'awaitwebhookUrl(page,idsAgain.route!),': 1,
    '.toBe(reloadedUrl);': 1,
    'constafterReload=awaitpost(page,': 1,
    'reloadedUrl,\'{"probe":"comp-leg4-reloaded"}\');': 1,
    '{status:afterReload.status,body:afterReload.body},': 1,
    '.toEqual({status:200,body:PANEL_BODY});': 1,
  },
  'leg 5 - ': {
    "awaitpage.keyboard.press('Control+z');": 1,
    'constseen=awaitrecordStatusStripDuring(page,()=>expectRefusalStayedSilent(page,': 1,
    "expect(seen,'NOTHINGONTOP:": 1,
    '.toEqual([stripBefore]);': 1,
    'for(constwofafter.wires){expectHeadOn(after,w,': 1,
  },
};
/** How many `keyboard.` calls each pinned leg makes in all. */
export const KEYBOARD_CALLS: Readonly<Record<string, number>> = { 'leg 5 - ': 1 };

function ruleR13(stripped: string): string[] {
  const out: string[] = [];
  for (const body of declarationBodies(stripped)) {
    const title = body.declaration.title;
    const squashed = body.text.replace(/\s+/g, '');
    for (const [prefix, pinned] of Object.entries(LEG_WIRING)) {
      if (!title.startsWith(prefix)) continue;
      for (const [frag, want] of Object.entries(pinned)) {
        const got = squashed.split(frag).length - 1;
        if (got !== want) out.push(`R13: \`${title}\` holds \`${frag}\` ${got} time(s), ${want} pinned`);
      }
    }
    for (const [prefix, want] of Object.entries(KEYBOARD_CALLS)) {
      if (!title.startsWith(prefix)) continue;
      const got = (blankStrings(body.text).match(/\.\s*keyboard\s*\./g) ?? []).length;
      if (got !== want) out.push(`R13: \`${title}\` makes ${got} keyboard call(s), ${want} pinned`);
    }
  }
  return out;
}

/**
 * Audit the composed walk's source. Returns one message per violation, each prefixed with its
 * rule; EMPTY means clean. `cuts` is the cut table the rules hold the file to (`CUTS`; the cases
 * below pass a synthetic one).
 */
export function auditOneBoardSpec(raw: string, requirements: string, cuts: CutTable = CUTS): string[] {
  const stripped = stripComments(raw);
  return [
    ...ruleR1(stripped),
    ...ruleR2(stripped),
    ...ruleR3(stripped, cuts),
    ...ruleR4(stripped, cuts),
    ...ruleR5(stripped),
    ...ruleR6(stripped),
    ...ruleR7(stripped),
    ...ruleR8(raw, requirements, cuts),
    ...ruleR9(stripped),
    ...ruleR10(stripped),
    ...ruleR10Cut(stripped, cuts),
    ...ruleR11(stripped),
    ...ruleR12(stripped),
    ...ruleR13(stripped),
  ];
}

const RAW = readFileSync(SPEC_PATH, 'utf8');
const REQUIREMENTS = readFileSync(REQUIREMENTS_PATH, 'utf8');
const audit = (raw: string): string => auditOneBoardSpec(raw, REQUIREMENTS).join('\n');
/**
 * The R10 half of `audit`: every line `auditOneBoardSpec` makes from R10 and its cut rule, and
 * nothing else. For the two cases that mutate the real text once per pinned token or per pinned
 * assertion (about 180 mutations): they grade R10 alone, and the full audit runs fourteen rules a
 * call (about 30 ms here, of which R10 is about 2.4 ms). On CI's two-core runner the full audits
 * took 6.4 s against vitest's 5 s budget (the early 2026-10-13 CI run); the budget is kept and the work cut.
 * Each of those cases still grades its first mutation through `audit` as well, so the wiring of
 * R10 into `auditOneBoardSpec` stays checked where the mutations are.
 */
const auditR10 = (raw: string): string => {
  const stripped = stripComments(raw);
  return [...ruleR10(stripped), ...ruleR10Cut(stripped, CUTS)].join('\n');
};

/** Append text to the real source, at the end of the file. */
const appended = (text: string): string => `${RAW}\n${text}\n`;

/** A synthetic cut for the cut rules' cases: no cut stands at HEAD (`CUTS` is empty). */
const SYNTH_LINE = 'MEASURED x=1 on a synthetic clause';
const SYNTH_ENTRY = `CUT (SYNTH). A synthetic cut for the gate's cases: ${SYNTH_LINE}, so the clause is cut.`;
const SYNTH_CUTS: CutTable = { 'CUT - leg 1 clause "x": ': { header: SYNTH_ENTRY, quotes: [SYNTH_LINE] } };
const SYNTH_DECL =
  "test('CUT - leg 1 clause \"x\": a reason', async () => {\n  throw new Error(\n    'CUT (SYNTH): " +
  SYNTH_LINE +
  "',\n  );\n});";
/** The real source with the synthetic cut's header entry and declaration added. */
const withSynthCut = (): string => {
  const at = RAW.indexOf('// D-08 (naming note, leg 4).');
  expect(at, 'the header entry anchor is found').toBeGreaterThan(0);
  return `${RAW.slice(0, at)}// ${SYNTH_ENTRY}\n//\n${RAW.slice(at)}\n${SYNTH_DECL}\n`;
};
const auditSynth = (raw: string): string => auditOneBoardSpec(raw, REQUIREMENTS, SYNTH_CUTS).join('\n');

/** Replace exactly one occurrence, and prove it landed. */
function replaceOnce(src: string, from: string | RegExp, to: string): string {
  const out = src.replace(from, to);
  expect(out, `the mutation ${String(from)} landed`).not.toBe(src);
  return out;
}

/** A well-formed attach leg titled `leg 2 - x`, with `inner` placed where the caller says. */
function legTwo(parts: { beforeRequired?: string; afterAttach?: string; alive?: number }): string {
  const alive = Array.from(
    { length: parts.alive ?? 3 },
    (_, i) => `  await expectRenderLoopAlive(page, 'leg 2 step ${i}');`,
  ).join('\n');
  return [
    "test('leg 2 - x', async () => {",
    '  const page = sharedPage();',
    parts.beforeRequired ?? '',
    "  required('routeId', 'leg 1');",
    "  const errs = await attachToRunningBoard(page, 'leg 2');",
    parts.afterAttach ?? '',
    alive,
    "  errs.assertNone('during leg 2');",
    '});',
  ].join('\n');
}

describe(`the composed walk ${SPEC_NAME}`, () => {
  it('strips to something still recognisable, so a green below is a real reading', () => {
    const stripped = stripComments(RAW);
    expect(stripped.split('\n').length, 'line count is preserved by stripping').toBe(
      RAW.split('\n').length,
    );
    expect(declarations(stripped).length, 'the walk declares at least leg 1').toBeGreaterThanOrEqual(1);
    expect(
      declarations(stripped).length,
      'stripping did not invent declarations the raw line-leading scan cannot see',
    ).toBe((RAW.match(/^[ \t]*test(?:\.(?:only|skip|fixme|fail))?[ \t]*\(/gm) ?? []).length);
    expect(functionBody(stripped, 'bootOnEmptyBoard'), 'the boot is found').not.toBeNull();
    expect(functionBody(stripped, 'attachToRunningBoard'), 'the attach is found').not.toBeNull();
    expect(doneTestSentences(REQUIREMENTS).missing, 'all five done-test legs are read').toEqual([]);
  });

  it('is clean AT HEAD', () => {
    expect(auditOneBoardSpec(RAW, REQUIREMENTS)).toEqual([]);
  });

  // R1 -----------------------------------------------------------------------
  it('R1 REFUSES the file with serial mode removed', () => {
    expect(audit(replaceOnce(RAW, /test\.describe\.configure\([^)]*\);/, ''))).toMatch(/^R1:/m);
  });

  // R2 -----------------------------------------------------------------------
  it('R2 REFUSES each of the four modifiers on leg 1', () => {
    for (const mod of ['only', 'skip', 'fixme', 'fail']) {
      expect(audit(replaceOnce(RAW, "test('leg 1 - ", `test.${mod}('leg 1 - `)), mod).toMatch(
        /^R2:/m,
      );
    }
  });

  it('R2 REFUSES a group-scoped skip', () => {
    expect(audit(appended("test.describe.skip('a group', () => {});"))).toMatch(/^R2:/m);
  });

  // R3 -----------------------------------------------------------------------
  it('R3 REFUSES a bare declaration appended after leg 1', () => {
    expect(audit(appended("test('appended', async () => {});"))).toMatch(/^R3:/m);
  });

  it('R3 REFUSES a declaration titled leg 3 appended after leg 1', () => {
    expect(audit(appended("test('leg 3 - x', async () => {});"))).toMatch(/^R3:/m);
  });

  it('R3 REFUSES a CUT declaration placed BEFORE leg 1', () => {
    const before = replaceOnce(
      RAW,
      "test('leg 1 - ",
      "test('CUT - leg 9 clause \"x\": a reason', async () => {\n  throw new Error('CUT: a reason');\n});\n\ntest('leg 1 - ",
    );
    expect(audit(before)).toMatch(/^R3:/m);
  });

  it('R3 REFUSES legs 1 and 2 swapped', () => {
    const bodies = declarationBodies(stripComments(RAW));
    const leg1 = bodies.find((b) => b.declaration.title.startsWith('leg 1 - '));
    const leg2 = bodies.find((b) => b.declaration.title.startsWith('leg 2 - '));
    expect(leg1 && leg2, 'both legs are found in the real text').toBeTruthy();
    const one = RAW.slice(leg1!.start, leg1!.end);
    const two = RAW.slice(leg2!.start, leg2!.end);
    expect(leg1!.end <= leg2!.start, 'leg 1 is declared before leg 2 at HEAD').toBe(true);
    const swapped =
      RAW.slice(0, leg1!.start) + two + RAW.slice(leg1!.end, leg2!.start) + one + RAW.slice(leg2!.end);
    expect(swapped).not.toBe(RAW);
    expect(audit(swapped)).toMatch(/^R3:/m);
  });

  it('R3 REFUSES legs 2 and 3 swapped', () => {
    const bodies = declarationBodies(stripComments(RAW));
    const leg2 = bodies.find((b) => b.declaration.title.startsWith('leg 2 - '));
    const leg3 = bodies.find((b) => b.declaration.title.startsWith('leg 3 - '));
    expect(leg2 && leg3, 'both legs are found in the real text').toBeTruthy();
    const two = RAW.slice(leg2!.start, leg2!.end);
    const three = RAW.slice(leg3!.start, leg3!.end);
    expect(leg2!.end <= leg3!.start, 'leg 2 is declared before leg 3 at HEAD').toBe(true);
    const swapped =
      RAW.slice(0, leg2!.start) + three + RAW.slice(leg2!.end, leg3!.start) + two + RAW.slice(leg3!.end);
    expect(swapped).not.toBe(RAW);
    expect(audit(swapped)).toMatch(/^R3:/m);
  });

  it('R3 REFUSES legs 3 and 4 swapped', () => {
    const bodies = declarationBodies(stripComments(RAW));
    const leg3 = bodies.find((b) => b.declaration.title.startsWith('leg 3 - '));
    const leg4 = bodies.find((b) => b.declaration.title.startsWith('leg 4 - '));
    expect(leg3 && leg4, 'both legs are found in the real text').toBeTruthy();
    const three = RAW.slice(leg3!.start, leg3!.end);
    const four = RAW.slice(leg4!.start, leg4!.end);
    expect(leg3!.end <= leg4!.start, 'leg 3 is declared before leg 4 at HEAD').toBe(true);
    const swapped =
      RAW.slice(0, leg3!.start) + four + RAW.slice(leg3!.end, leg4!.start) + three + RAW.slice(leg4!.end);
    expect(swapped).not.toBe(RAW);
    expect(audit(swapped)).toMatch(/^R3:/m);
  });

  it('R3 REFUSES legs 4 and 5 swapped', () => {
    const bodies = declarationBodies(stripComments(RAW));
    const leg4 = bodies.find((b) => b.declaration.title.startsWith('leg 4 - '));
    const leg5 = bodies.find((b) => b.declaration.title.startsWith('leg 5 - '));
    expect(leg4 && leg5, 'both legs are found in the real text').toBeTruthy();
    const four = RAW.slice(leg4!.start, leg4!.end);
    const five = RAW.slice(leg5!.start, leg5!.end);
    expect(leg4!.end <= leg5!.start, 'leg 4 is declared before leg 5 at HEAD').toBe(true);
    const swapped =
      RAW.slice(0, leg4!.start) + five + RAW.slice(leg4!.end, leg5!.start) + four + RAW.slice(leg5!.end);
    expect(swapped).not.toBe(RAW);
    expect(audit(swapped)).toMatch(/^R3:/m);
  });

  it('R3 REFUSES leg 2 deleted', () => {
    const leg2 = declarationBodies(stripComments(RAW)).find((b) =>
      b.declaration.title.startsWith('leg 2 - '),
    );
    expect(leg2, 'leg 2 is found in the real text').toBeTruthy();
    const deleted = RAW.slice(0, leg2!.start) + RAW.slice(leg2!.end);
    expect(deleted.length).toBeLessThan(RAW.length);
    expect(audit(deleted)).toMatch(/^R3:/m);
  });

  // R4 -----------------------------------------------------------------------
  it('R4 REFUSES an unconditional throw inside leg 1', () => {
    const thrown = replaceOnce(
      RAW,
      /(test\('leg 1 - [^\n]*\n\s*const page = sharedPage\(\);)/,
      "$1\n  throw new Error('not walkable');",
    );
    expect(audit(thrown)).toMatch(/^R4:/m);
  });

  it('R4 REFUSES a CUT declaration that does not throw', () => {
    expect(audit(appended("test('CUT - leg 3 clause \"x\": a reason', async () => {});"))).toMatch(
      /^R4:/m,
    );
  });

  // The leg 3 cut (the ruling of 2026-10-08) -----------------------------------------------------
  const LEG3_CUT = 'CUT - leg 3 clause "clears from the front": ';
  /** The leg 3 cut's declaration in the real text. */
  const leg3Cut = (): DeclarationBody => {
    const cut = declarationBodies(stripComments(RAW)).find((b) => b.declaration.title.startsWith(LEG3_CUT));
    expect(cut, 'the leg 3 cut is declared in the real text').toBeDefined();
    return cut as DeclarationBody;
  };
  /** The real text with one replacement made inside the leg 3 cut's declaration only. */
  const inLeg3Cut = (from: string, to: string): string => {
    const cut = leg3Cut();
    return RAW.slice(0, cut.start) + replaceOnce(RAW.slice(cut.start, cut.end), from, to) + RAW.slice(cut.end);
  };

  it("R3, R4, R8 and R10 hold AT HEAD with leg 3's clause cut: listed, declared once and last, quoting the trace's lines", () => {
    expect(Object.keys(CUTS)).toEqual([LEG3_CUT]);
    const titles = declarations(stripComments(RAW)).map((d) => d.title);
    expect(titles.filter((t) => /^CUT - /.test(t)).length, 'one CUT is declared').toBe(1);
    expect(titles[titles.length - 1].startsWith(LEG3_CUT), 'the leg 3 cut is the last declaration').toBe(true);
    const [order, thinning] = CUTS[LEG3_CUT].quotes;
    expect(order, 'the order line is the trace\'s own, front first in 3 ticks').toBe(
      'RELEASE_ORDER R=2290 teeOff=2290 frontFree=2291 junction=2294 missed=2 witness=3 wrongway=0',
    );
    expect(thinning, 'the thinning line is rebuilt from the trace, Source end first').toBe(
      'RELEASE_THINNING 5,12=2427(R+137) 6,12=2435(R+145) 7,12=2442(R+152) 8,12=2449(R+159) 9,12=2459(R+169) 10,12=2463(R+173)',
    );
    expect(leg3Cut().text).toContain(order);
    expect(leg3Cut().text).toContain(thinning);
    expect(auditOneBoardSpec(RAW, REQUIREMENTS).filter((f) => /^R(?:3|4|8|10):/.test(f))).toEqual([]);
  });

  it('R3 REFUSES the leg 3 cut deleted (the clause dropped silently)', () => {
    const cut = leg3Cut();
    const deleted = RAW.slice(0, cut.start) + RAW.slice(cut.end);
    expect(deleted.length).toBeLessThan(RAW.length);
    expect(audit(deleted)).toMatch(/^R3: the CUT `CUT - leg 3 clause "clears from the front": \.\.\.` is not declared/m);
  });

  it('R3 REFUSES the leg 3 cut moved above leg 5', () => {
    const cut = leg3Cut();
    const body = RAW.slice(cut.start, cut.end);
    const without = RAW.slice(0, cut.start) + RAW.slice(cut.end);
    const at = without.indexOf("test('leg 5 - ");
    expect(at).toBeGreaterThan(0);
    expect(audit(without.slice(0, at) + body + '\n\n' + without.slice(at))).toMatch(
      /^R3: `leg 5 - [^`]*` is declared after a CUT declaration/m,
    );
  });

  it('R4 REFUSES the leg 3 cut made passable by an early return, or quiet', () => {
    expect(audit(inLeg3Cut('async () => {\n', 'async () => {\n  return;\n'))).toMatch(
      /^R4: .*the CUT declaration `CUT - leg 3 clause .* is not ONE unconditional throw/m,
    );
    expect(audit(inLeg3Cut('throw new Error(', 'console.log('))).toMatch(
      /^R4: .*the CUT declaration `CUT - leg 3 clause .* does not throw/m,
    );
  });

  it('R4 REFUSES the leg 3 cut no longer quoting either measured line word for word', () => {
    expect(audit(inLeg3Cut('10,12=2463(R+173)', '10,12=2463(R+170)'))).toMatch(
      /^R4: .*does not quote its measured line `RELEASE_THINNING /m,
    );
    expect(audit(inLeg3Cut('junction=2294', 'junction=2291'))).toMatch(/^R4: .*does not quote its measured line `RELEASE_ORDER /m);
  });

  it("R8 REFUSES the leg 3 cut's header entry changed by a word or losing a measured line", () => {
    const header = RAW.slice(0, RAW.indexOf('test.describe.configure('));
    const ruling = replaceOnce(header, 'the ruling "cut it and carry on"', 'the ruling "keep it"') + RAW.slice(header.length);
    expect(audit(ruling)).toMatch(/^R8: the spec header does not carry the `CUT \(D-15, \.\.\.` entry/m);
    const line = replaceOnce(header, '//    RELEASE_ORDER R=2290', '//    RELEASE_ORDER R=2291') + RAW.slice(header.length);
    expect(audit(line)).toMatch(/^R8: the spec header does not carry the `CUT \(D-15, \.\.\.` entry/m);
  });

  it('R10 REFUSES the cut clause asserted again while the cut stands, by its token or its grader', () => {
    const at = "  const relForms = gaugeFormsByDrawnTick(rel, tee.id);";
    const token = replaceOnce(RAW, at, `  expect(grade.witness, 'FRONT FIRST: the order').toBeGreaterThan(0);\n${at}`);
    expect(audit(token)).toMatch(/^R10: line \d+: `FRONT FIRST` appears in the spec's code while the CUT `CUT - leg 3 clause/m);
    const grader = replaceOnce(
      replaceOnce(RAW, '  flowingBaseline,\n', '  flowingBaseline,\n  frontFirstViolations,\n'),
      at,
      `  expect(frontFirstViolations(grade), 'the order').toEqual([]);\n${at}`,
    );
    const found = audit(grader);
    expect(found.match(/^R10: line \d+: `frontFirstViolations` appears/gm)?.length, 'the import and the call').toBe(2);
  });

  it('R10 ACCEPTS the token in a comment: only code is read', () => {
    const at = "  const relForms = gaugeFormsByDrawnTick(rel, tee.id);";
    expect(audit(replaceOnce(RAW, at, `  // FRONT FIRST is cut (header).\n${at}`))).toBe('');
  });

  it('R3 REFUSES a listed cut that is not declared (a clause dropped silently)', () => {
    expect(auditSynth(RAW)).toMatch(/^R3: the CUT `CUT - leg 1 clause "x": \.\.\.` is not declared/m);
  });

  it('R3 REFUSES a leg declared below a CUT declaration', () => {
    expect(auditSynth(withSynthCut() + legTwo({}).replace("'leg 2 - x'", "'leg 4 - x'") + '\n')).toMatch(
      /^R3: `leg 4 - x` is declared after a CUT declaration/m,
    );
  });

  it('R4 REFUSES a listed CUT with its throw removed', () => {
    const quiet = withSynthCut().replace(SYNTH_DECL, SYNTH_DECL.replace('throw new Error(', 'console.log('));
    expect(auditSynth(quiet)).toMatch(/^R4: .*the CUT declaration `CUT - leg 1 clause .* does not throw/m);
  });

  it('R4 REFUSES a listed CUT no longer quoting its measured line', () => {
    const reworded = withSynthCut().replace(SYNTH_DECL, SYNTH_DECL.replace('x=1', 'x=0'));
    expect(auditSynth(reworded)).toMatch(/^R4: .*does not quote its measured line/m);
  });

  it('R8 REFUSES a listed CUT whose header entry is missing', () => {
    const noHeader = `${RAW}\n${SYNTH_DECL}\n`;
    expect(auditSynth(noHeader)).toMatch(/^R8: the spec header does not carry the `CUT \(SYNTH\)\. \.\.\.` entry/m);
  });

  it('ACCEPTS a listed CUT declared last, throwing its measured line, with its header entry', () => {
    expect(auditOneBoardSpec(withSynthCut(), REQUIREMENTS, SYNTH_CUTS)).toEqual([]);
  });

  // The 77-09 refuter round: a cut that keeps its throw TEXT and still passes. -----------------
  const synthWith = (before: string, open = '', close = ''): string =>
    withSynthCut().replace(
      SYNTH_DECL,
      SYNTH_DECL.replace('async () => {\n', `async () => {\n${before}${open}`).replace("',\n  );", `',\n  );${close}`),
    );

  it('R4 REFUSES a listed CUT whose throw an early return, a skip, a condition or a try/catch makes passable (77-09 refuters 1, 6, 8)', () => {
    const shapes: Record<string, string> = {
      'if (Date.now() > 0) return;': synthWith('  if (Date.now() > 0) return;\n'),
      'return;': synthWith('  return;\n'),
      'test.info().skip();': synthWith('  test.info().skip();\n'),
      "if (process.env.FABRICO_CUT_LOUD === '1')": synthWith("  if (process.env.FABRICO_CUT_LOUD === '1')\n"),
      'try { throw } catch {}': synthWith('', '  try {\n', '\n  } catch {\n    // swallowed\n  }'),
      'a closure never called': synthWith('  const loud = () => {\n', '', '\n  };'),
    };
    for (const [shape, src] of Object.entries(shapes)) {
      expect(src, `the ${shape} mutation landed`).not.toBe(withSynthCut());
      expect(auditSynth(src), shape).toMatch(/^R4: .*the CUT declaration `CUT - leg 1 clause .* is not ONE unconditional throw/m);
    }
  });

  it('R4 REFUSES a listed CUT taking a parameter, or whose reason runs code', () => {
    const param = withSynthCut().replace(SYNTH_DECL, SYNTH_DECL.replace('async () => {', 'async ({}, testInfo) => {'));
    expect(auditSynth(param)).toMatch(/^R4: .*is not ONE unconditional throw: its callback does not open with the throw/m);
    const code = withSynthCut().replace(SYNTH_DECL, SYNTH_DECL.replace("'CUT (SYNTH): ", "String(process.exit(0)) + 'CUT (SYNTH): "));
    expect(auditSynth(code)).toMatch(/^R4: .*its reason runs code \(`String`, `process`, `exit`\)/m);
    // `throw new Error(reason), 'ok'` throws `'ok'`: the cut still fails, with its reason gone.
    const comma = withSynthCut().replace(SYNTH_DECL, SYNTH_DECL.replace("',\n  );", "',\n  ), 'ok';"));
    expect(comma).not.toBe(withSynthCut());
    expect(auditSynth(comma)).toMatch(/^R4: .*is not ONE unconditional throw: something follows the throw/m);
  });

  it("R4 ACCEPTS a cut in plan 77-09's own form: a reason joined from an array of string literals", () => {
    const joined =
      "test('CUT - leg 1 clause \"x\": a reason', async () => {\n  throw new Error(\n    [\n      'CUT (SYNTH): " +
      SYNTH_LINE +
      "',\n      'a second line',\n    ].join('\\n'),\n  );\n});";
    expect(auditOneBoardSpec(withSynthCut().replace(SYNTH_DECL, joined), REQUIREMENTS, SYNTH_CUTS)).toEqual([]);
  });

  it('R2 REFUSES a walking leg skipped or failed through test.info() or testInfo (77-09 refuter 1)', () => {
    const at = "const errs = await attachToRunningBoard(page, 'leg 3');";
    for (const line of [
      'test.info().skip();',
      'test.info().fixme();',
      'test.info().fail();',
      'const testInfo = test.info();\n  testInfo.skip();',
      "test.info().expectedStatus = 'failed';",
      "test.info()['skip']();",
    ]) {
      expect(audit(replaceOnce(RAW, at, `${at}\n  ${line}`)), line).toMatch(/^R2: line \d+: forbidden modifier/m);
    }
  });

  it('R8 REFUSES a listed CUT whose header entry is cut down to its label, or loses its measured line (77-09 refuters 4, 9)', () => {
    const bare = withSynthCut().replace(`// ${SYNTH_ENTRY}`, '// CUT (SYNTH).');
    expect(auditSynth(bare)).toMatch(/^R8: the spec header does not carry the `CUT \(SYNTH\)\. \.\.\.` entry/m);
    const vague = withSynthCut().replace(`// ${SYNTH_ENTRY}`, `// ${SYNTH_ENTRY.replace(SYNTH_LINE, 'a measurement')}`);
    expect(auditSynth(vague)).toMatch(/^R8: the spec header does not carry/m);
    const table: CutTable = { 'CUT - leg 1 clause "x": ': { header: 'CUT (SYNTH). Cut.', quotes: [SYNTH_LINE] } };
    expect(auditOneBoardSpec(withSynthCut(), REQUIREMENTS, table).join('\n')).toMatch(
      /^R8: the cut table's header entry for .* does not carry its measured line/m,
    );
  });

  it('R10 REFUSES a defining assertion replaced by a tautology (77-09 refuter 3, J)', () => {
    const sustained = /expect\(\n    \{ teeOff: win\.teeOff[\s\S]*?\)\.toEqual\(\{ teeOff: true, headEmpty: true, records: SUSTAIN_WINDOW_RECORDS \}\);/;
    for (const to of [
      "expect(true, 'RELEASE SUSTAINED').toBe(true);",
      "expect(1 === 1, 'RELEASE SUSTAINED').toBe(true);",
      "expect(win.count, 'RELEASE SUSTAINED').toBe(win.count);",
    ]) {
      expect(audit(replaceOnce(RAW, sustained, to)), to).toMatch(/^R10: `leg 3 - [^`]*`: the assertion carrying `RELEASE SUSTAINED` (?:asserts the constant|compares its subject with itself)/m);
    }
  });

  it('R11 REFUSES a guarded helper shadowed, rebound, passed along or reached through another object (77-09 refuter 3, I)', () => {
    const at = "const errs = await attachToRunningBoard(page, 'leg 3');";
    for (const line of [
      'const expectRenderLoopAlive = async (..._a: unknown[]): Promise<void> => {};',
      'let expectSamePage = (..._a: unknown[]) => undefined;',
      'function expectRenderLoopAlive(..._a: unknown[]): void {}',
      'const { expectRenderLoopAlive } = { expectRenderLoopAlive: async () => {} };',
      'const fake = { expectRenderLoopAlive: async () => {} };\n  await fake.expectRenderLoopAlive(page);',
      'const exp = expect;',
      '[page].forEach(expectSamePage);',
    ]) {
      expect(audit(replaceOnce(RAW, at, `${at}\n  ${line}`)), line).toMatch(/^R11: /m);
    }
    const param = replaceOnce(RAW, /(test\('leg 3 - [^']*', async \()\) => \{/, '$1{}, expectRenderLoopAlive: unknown) => {');
    expect(audit(param)).toMatch(/^R11: line \d+: `expectRenderLoopAlive` is used other than by a direct call/m);
  });

  it('R11 REFUSES a guarded import renamed, re-sourced, or declared again at the top level', () => {
    const renamed = replaceOnce(RAW, '  expectRenderLoopAlive,\n', '  expectHeadOn as expectRenderLoopAlive,\n');
    expect(audit(renamed)).toMatch(/^R11: an import binds another value to `expectRenderLoopAlive`/m);
    const dropped = replaceOnce(RAW, '  expectRenderLoopAlive,\n', '');
    const stub = `${dropped}\nasync function expectRenderLoopAlive(..._a: unknown[]): Promise<void> {}\n`;
    const found = audit(stub);
    expect(found).toMatch(/^R11: `expectRenderLoopAlive` is not imported under its own name from '\.\/support\/oracle'/m);
    expect(found).toMatch(/^R11: `expectRenderLoopAlive` is imported, and a top-level function declares it again/m);
    const twice = `${RAW}\nfunction expectSamePage(): void {}\n`;
    expect(audit(twice)).toMatch(/^R11: `expectSamePage` is declared 2 time\(s\) as a top-level function/m);
  });

  it('R11 holds AT HEAD: every guarded name is bound once and only called', () => {
    expect(auditOneBoardSpec(RAW, REQUIREMENTS).filter((f) => f.startsWith('R11:'))).toEqual([]);
  });

  // R5 -----------------------------------------------------------------------
  it('R5 REFUSES bootOnEmptyBoard called inside a later attach leg', () => {
    expect(audit(appended(legTwo({ afterAttach: '  await bootOnEmptyBoard(page);' })))).toMatch(
      /^R5: .*bootOnEmptyBoard/m,
    );
  });

  it('R5 REFUSES newBoard called inside a later attach leg', () => {
    expect(audit(appended(legTwo({ afterAttach: '  await newBoard(page);' })))).toMatch(
      /^R5: .*newBoard/m,
    );
  });

  // The D1 edit of the v8.0 composition proof (69-MUTATION-PROOF.md D1), on leg 5's real text:
  // leg 5 given its own fresh board instead of the one leg 4 reloaded.
  it('R5 REFUSES leg 5 on a fresh board (D1)', () => {
    const leg5 = declarationBodies(stripComments(RAW)).find((b) =>
      b.declaration.title.startsWith('leg 5 - '),
    );
    expect(leg5, 'leg 5 is found in the real text').toBeTruthy();
    const body = RAW.slice(leg5!.start, leg5!.end);
    const attach = "await attachToRunningBoard(page, 'leg 5');";
    expect(body, 'leg 5 attaches to the running board at HEAD').toContain(attach);
    const fresh = RAW.slice(0, leg5!.start) + body.replace(attach, 'await bootOnEmptyBoard(page);') + RAW.slice(leg5!.end);
    expect(fresh).not.toBe(RAW);
    expect(audit(fresh)).toMatch(/^R5: .*`bootOnEmptyBoard` is referenced outside leg 1/m);
  });

  it('R5 REFUSES loadDemoViaExamples called inside leg 1', () => {
    const inLeg1 = replaceOnce(
      RAW,
      /(test\('leg 1 - [^\n]*\n\s*const page = sharedPage\(\);)/,
      '$1\n  await loadDemoViaExamples(page);',
    );
    expect(audit(inLeg1)).toMatch(/^R5: .*loadDemoViaExamples/m);
  });

  // R6 -----------------------------------------------------------------------
  it("R6 REFUSES the boot's watcher moved below its goto", () => {
    const moved = replaceOnce(
      RAW,
      "  const errs = watchPageErrors(page);\n  await page.goto('/');",
      "  await page.goto('/');\n  const errs = watchPageErrors(page);",
    );
    expect(audit(moved)).toMatch(/^R6: `bootOnEmptyBoard` must install/m);
  });

  it('R6 REFUSES a goto inserted into attachToRunningBoard', () => {
    const navigating = replaceOnce(
      RAW,
      "  const errs = watchPageErrors(page);\n  await expectRunningUnaided(",
      "  const errs = watchPageErrors(page);\n  await page.goto('/');\n  await expectRunningUnaided(",
    );
    expect(audit(navigating)).toMatch(/^R6: `attachToRunningBoard` navigates/m);
  });

  it('R6 REFUSES ensurePlaying moved above expectRunningUnaided inside the attach', () => {
    const rescuing = replaceOnce(
      RAW,
      "  await expectRunningUnaided(page, 'the board the previous leg left');\n  await expectSamePage(page, `at the start of ${leg}`);\n  await ensurePlaying(page);",
      "  await ensurePlaying(page);\n  await expectRunningUnaided(page, 'the board the previous leg left');\n  await expectSamePage(page, `at the start of ${leg}`);",
    );
    expect(audit(rescuing)).toMatch(/^R6: `attachToRunningBoard` must call `expectRunningUnaided/m);
  });

  it('R6 REFUSES a later leg with only two render-health checks', () => {
    expect(audit(appended(legTwo({ alive: 2 })))).toMatch(/^R6: `leg 2 - x` calls `expectRenderLoopAlive/m);
  });

  // R7 -----------------------------------------------------------------------
  it('R7 REFUSES a later leg that gestures before required', () => {
    expect(
      audit(appended(legTwo({ beforeRequired: "  await armAndPlaceAt(page, 'Source', 4, 12);" }))),
    ).toMatch(/^R7:/m);
  });

  it('R7 REFUSES a later leg that attaches before required', () => {
    const early = legTwo({}).replace(
      "  required('routeId', 'leg 1');\n  const errs = await attachToRunningBoard(page, 'leg 2');",
      "  const errs = await attachToRunningBoard(page, 'leg 2');\n  required('routeId', 'leg 1');",
    );
    expect(early).not.toBe(legTwo({}));
    expect(audit(appended(early))).toMatch(/^R7:/m);
  });

  // R8 -----------------------------------------------------------------------
  it('R8 REFUSES one word of leg 1 changed in the header', () => {
    const reworded = replaceOnce(RAW, '// 1. Place an HTTP Endpoint', '// 1. Place a HTTP Endpoint');
    expect(audit(reworded)).toMatch(/^R8: .*leg 1/m);
  });

  // R9 -----------------------------------------------------------------------
  it('R9 REFUSES a fixed-time sleep inside leg 1', () => {
    const sleeping = replaceOnce(
      RAW,
      /(test\('leg 1 - [^\n]*\n\s*const page = sharedPage\(\);)/,
      '$1\n  await page.waitForTimeout(500);',
    );
    expect(audit(sleeping)).toMatch(/^R9:/m);
  });

  // R10 ----------------------------------------------------------------------
  it('R10 REFUSES each listed token deleted', () => {
    let wired = false;
    for (const pinned of [...Object.values(LEG_TOKENS), ...Object.values(FUNCTION_TOKENS)]) {
      for (const token of Object.keys(pinned)) {
        const neutral = RAW.split(token).join('a neutral word');
        expect(neutral, `the token ${token} occurs in the spec`).not.toBe(RAW);
        const refusal = new RegExp(`^R10: .*\`${token}\``, 'm');
        if (!wired) {
          expect(audit(neutral), `${token}, through the full audit`).toMatch(refusal);
          wired = true;
        }
        expect(auditR10(neutral), token).toMatch(refusal);
      }
    }
    expect(wired, 'at least one token was deleted').toBe(true);
  });

  // The 77-01 refuter round: the case above rewrites EVERY occurrence of a token, which a rule
  // that asked only for one surviving copy also passed. This one takes out ONE assertion's claim
  // at a time, every assertion that carries a defining token, each on its own.
  it('R10 REFUSES any ONE assertion carrying a defining token, neutralised alone', () => {
    const stripped = stripComments(RAW);
    const spans: { where: string; token: string; start: number; end: number; text: string }[] = [];
    const collect = (where: string, start: number, text: string, pinned: Readonly<Record<string, number>>) => {
      for (const a of assertionArguments(text)) {
        for (const token of Object.keys(pinned)) {
          if (a.text.includes(token)) spans.push({ where, token, start: start + a.start, end: start + a.end, text: a.text });
        }
      }
    };
    for (const body of declarationBodies(stripped)) {
      for (const [prefix, pinned] of Object.entries(LEG_TOKENS)) {
        if (body.declaration.title.startsWith(prefix)) collect(body.declaration.title, body.start, body.text, pinned);
      }
    }
    for (const [name, pinned] of Object.entries(FUNCTION_TOKENS)) {
      const fn = functionBody(stripped, name);
      expect(fn, `${name} is declared`).not.toBeNull();
      collect(name, fn!.start, fn!.text, pinned);
    }
    const expected = [...Object.values(LEG_TOKENS), ...Object.values(FUNCTION_TOKENS)]
      .flatMap((p) => Object.values(p))
      .reduce((a, b) => a + b, 0);
    expect(spans.length, 'one mutation per pinned assertion').toBe(expected);
    spans.forEach((sp, i) => {
      const one = RAW.slice(0, sp.start) + sp.text.split(sp.token).join('a neutral word') + RAW.slice(sp.end);
      expect(one).not.toBe(RAW);
      const refusal = new RegExp(`^R10: .*\`${sp.token}\``, 'm');
      if (i === 0) expect(audit(one), `${sp.where}: one assertion carrying ${sp.token}, through the full audit`).toMatch(refusal);
      expect(auditR10(one), `${sp.where}: one assertion carrying ${sp.token}`).toMatch(refusal);
    });
  });

  // THE 77-01 REFUTER ROUND, each refuter's own edit on the real text ------------------------
  it('R6 REFUSES leg 5 reloading the shared page through location.href (refuter 2)', () => {
    const reloads = replaceOnce(
      RAW,
      "  const errs = await attachToRunningBoard(page, 'leg 5');",
      "  await page.evaluate(() => { (window as any).__refuteMarker = 1; });\n" +
        "  const loaded = page.waitForEvent('load');\n" +
        "  await page.evaluate(() => { setTimeout(() => { location.href = '/'; }, 0); });\n" +
        '  await loaded;\n' +
        '  await waitForAppReady(page);\n' +
        "  const errs = await attachToRunningBoard(page, 'leg 5');",
    );
    expect(audit(reloads)).toMatch(/^R6: line \d+: `location\.href` navigates the page/m);
  });

  it('R6 REFUSES the page navigated through history or page.goBack', () => {
    for (const nav of ['  await page.evaluate(() => history.back());', '  await page.goBack();']) {
      expect(audit(appended(legTwo({ afterAttach: nav }))), nav).toMatch(/^R6: line \d+: .* navigates the page/m);
    }
  });

  it('R6 REFUSES a Play press ahead of the unaided check inside the attach (refuter 3)', () => {
    const rescues = replaceOnce(
      RAW,
      '  const errs = watchPageErrors(page);\n  await expectRunningUnaided(',
      "  if ((await transportOf(page).getAttribute('aria-label')) === 'Play') await transportOf(page).click();\n" +
        '  const errs = watchPageErrors(page);\n  await expectRunningUnaided(',
    );
    expect(audit(rescues)).toMatch(/^R6: `attachToRunningBoard` calls `transportOf\(`.* before `expectRunningUnaided\(`/m);
  });

  it('R7 REFUSES a Play press in a later leg ahead of its attach', () => {
    expect(
      audit(appended(legTwo({ beforeRequired: '  await transportOf(page).click();' }))),
    ).toMatch(/^R7: `leg 2 - x` calls `transportOf\(`, `click\(` before `attachToRunningBoard\(`/m);
  });

  it('R5 REFUSES a fresh board through an alias of newBoard in leg 2 (refuter 5)', () => {
    const wipes = replaceOnce(
      RAW,
      "  await expectRenderLoopAlive(page, 'leg 2 on the board leg 1 left');\n",
      "  await expectRenderLoopAlive(page, 'leg 2 on the board leg 1 left');\n  const wipe = newBoard;\n  await wipe(page);\n",
    );
    expect(audit(wipes)).toMatch(/^R5: line \d+: `newBoard` is referenced outside the boot and leg 4/m);
  });

  it('R6 REFUSES the boot without clearHostPause (refuter 5, the 77-01 review blocker)', () => {
    const paused = replaceOnce(RAW, '  await clearHostPause(page);\n  await resetToDemo', '  await resetToDemo');
    expect(audit(paused)).toMatch(/^R6: `bootOnEmptyBoard` must call `clearHostPause\(` before `resetToDemo\(`/m);
  });

  it('R10 REFUSES the REPLY ON THE RETURN LEG poll deleted (refuter 7)', () => {
    const stripped = stripComments(RAW);
    const leg1 = declarationBodies(stripped).find((b) => b.declaration.title.startsWith('leg 1 - '))!;
    const reply = assertionArguments(leg1.text).find((a) => a.text.includes('REPLY ON THE RETURN LEG'));
    expect(reply, 'the reply assertion is found in leg 1').toBeTruthy();
    const open = leg1.start + reply!.start;
    const call = RAW.lastIndexOf('await pollScene(', open);
    const stmtEnd = RAW.indexOf(';', leg1.start + reply!.end) + 1;
    const deleted = RAW.slice(0, call) + RAW.slice(stmtEnd);
    expect(deleted.length).toBeLessThan(RAW.length);
    expect(stripComments(deleted), 'no code line still names the token').not.toContain('REPLY ON THE RETURN LEG');
    expect(audit(deleted)).toMatch(/^R10: `leg 1 - .*` lost its defining assertion `REPLY ON THE RETURN LEG`/m);
  });

  it("R10 REFUSES the boot's USE OPTIONS INHERITED and the HOST PAUSE CLEARED checks deleted (refuter 7)", () => {
    const noUse = replaceOnce(RAW, /  expect\(\n    clipboard,[\s\S]*?\.toBe\('granted'\);\n/, '');
    expect(audit(noUse)).toMatch(/^R10: `bootOnEmptyBoard` lost its defining assertion `USE OPTIONS INHERITED`/m);
    const noResume = replaceOnce(
      RAW,
      /  await expect\(\n    btn,\n    'HOST PAUSE CLEARED: the second press[\s\S]*?\);\n/,
      '',
    );
    expect(audit(noResume)).toMatch(/^R10: `clearHostPause` carries `HOST PAUSE CLEARED` in 2 assertion call\(s\), 3 pinned/m);
  });

  it('R10 REFUSES the three leg 1 assertions refuter 8 deleted, each a token another assertion still carries', () => {
    let s = RAW;
    s = replaceOnce(s, /  await pollScene\(page, \(s\) => s\.wires\.map\(wireKey\)\.sort\(\), \{[\s\S]*?\}\)\.toEqual\(\[forwardKey, returnKey\]\.sort\(\)\);\n/, '');
    s = replaceOnce(s, "  expect(first.body, 'ANSWERS THE PRESET: with the Handler preset body').toBe(HANDLER_PRESET_BODY);\n", '');
    s = replaceOnce(s, /  expect\(\n    \{ body: edited\.body, differsFromPreset[\s\S]*?\.toEqual\(\{ body: PANEL_BODY, differsFromPreset: true \}\);\n/, '');
    for (const t of ['ONE DRAG TWO WIRES', 'ANSWERS THE PRESET', 'BODY FROM THE PANEL']) {
      expect(s, `${t} still sits in another assertion`).toContain(t);
    }
    const found = audit(s);
    expect(found).toMatch(/^R10: .*carries `ONE DRAG TWO WIRES` in 3 assertion call\(s\), 4 pinned/m);
    expect(found).toMatch(/^R10: .*carries `ANSWERS THE PRESET` in 1 assertion call\(s\), 2 pinned/m);
    expect(found).toMatch(/^R10: .*carries `BODY FROM THE PANEL` in 2 assertion call\(s\), 3 pinned/m);
  });

  // THE 77-02 REFUTER ROUND, refuter 3's second edit and its neighbours ------------------------
  it("R10 REFUSES leg 2's PACK DRAWN ON THE CANVAS weakened to .toBeTruthy() (refuter 3)", () => {
    const weak = replaceOnce(RAW, '.toEqual({ drawn: FULL, model: FULL });', '.toBeTruthy();');
    expect(audit(weak)).toMatch(/^R10: `leg 2 - .*`PACK DRAWN ON THE CANVAS` ends in `\.toBeTruthy\(`/m);
  });

  it('R10 REFUSES a pinned assertion negated, left with no matcher, or expecting expect.anything()', () => {
    const negated = replaceOnce(RAW, '.toEqual({ drawn: FULL, model: FULL });', '.not.toEqual({});');
    expect(audit(negated)).toMatch(/^R10: `leg 2 - .*`PACK DRAWN ON THE CANVAS` ends in a negated/m);
    const bare = replaceOnce(
      RAW,
      "'PACK ORDER STRICT: the junction read 1/1 on every recorded packet').toBe(true);",
      "'PACK ORDER STRICT: the junction read 1/1 on every recorded packet');",
    );
    expect(audit(bare)).toMatch(/^R10: `leg 2 - .*`PACK ORDER STRICT` ends in no matcher/m);
    const anything = replaceOnce(RAW, '.toEqual({ drawn: FULL, model: FULL });', '.toEqual(expect.anything());');
    expect(audit(anything)).toMatch(/^R10: `leg 2 - .*`PACK DRAWN ON THE CANVAS` expects `expect\.anything`/m);
  });

  it('R10 ACCEPTS every pinned assertion as it stands: none ends in a weak matcher', () => {
    expect(audit(RAW)).not.toMatch(/^R10: .*(?:asks only that a value exists|negated|no matcher|expect\.anything)/m);
  });

  // THE 77-03 REFUTER ROUND, refuters 1 and 3: leg 3's screen and drawn-frame reads ------------
  it("R10 REFUSES each of leg 3's screen and drawn-frame reads deleted (77-03 refuters 1 and 3)", () => {
    const stripped = stripComments(RAW);
    const leg3 = declarationBodies(stripped).find((b) => b.declaration.title.startsWith('leg 3 - '))!;
    for (const token of [
      'MARK SEEN ON SCREEN',
      'RUN DRAWN AFTER THE RELEASE',
      'RUN DRAWN AT THE CLOSE',
      'RUN VISIBLE AT THE CLOSE',
    ]) {
      const a = assertionArguments(leg3.text).find((x) => x.text.includes(token));
      expect(a, `${token} sits in an assertion in leg 3`).toBeTruthy();
      const open = leg3.start + a!.start;
      const at = RAW.lastIndexOf('await expect', open) > RAW.lastIndexOf('  expect(', open)
        ? RAW.lastIndexOf('await expect', open)
        : RAW.lastIndexOf('  expect(', open);
      const stmtEnd = RAW.indexOf(';', leg3.start + a!.end) + 1;
      const deleted = RAW.slice(0, at) + RAW.slice(stmtEnd);
      expect(audit(deleted), token).toMatch(new RegExp(`^R10: \`leg 3 - .*\` lost its defining assertion \`${token}\``, 'm'));
    }
  });

  // THE 77-03 REFUTER ROUND, refuter 2: three more ways to a fresh board in leg 3 ---------------
  it('R5 REFUSES a fresh board in leg 3 through an alias, a parenthesised call, or the New button by its name (77-03 refuter 2)', () => {
    const at = "  await expectRenderLoopAlive(page, 'leg 3 on the board leg 2 left');\n";
    const forms: [string, RegExp][] = [
      ['  const fresh = newBoard;\n  await fresh(page);\n', /^R5: line \d+: `newBoard` is referenced outside the boot and leg 4/m],
      ['  await (newBoard)(page);\n', /^R5: line \d+: `newBoard` is referenced outside the boot and leg 4/m],
      ["  await page.getByRole('button', { name: 'New' }).click();\n", /^R5: line \d+: `'New'` presses the New or Examples control directly/m],
      ['  await page.getByRole("button", { name: "New", exact: true }).click();\n', /^R5: line \d+: `"New"` presses the New or Examples control directly/m],
      ['  await page.getByText(`New`).click();\n', /^R5: line \d+: `\`New\`` presses the New or Examples control directly/m],
      ["  await page.getByRole('button', { name: /^New$/ }).click();\n", /^R5: line \d+: `\/\^New\$\/` presses the New or Examples control directly/m],
    ];
    for (const [form, refusal] of forms) {
      expect(audit(replaceOnce(RAW, at, at + form)), form).toMatch(refusal);
    }
  });

  it("R5 ACCEPTS a string that only contains New inside a longer word or phrase (no 'New' press)", () => {
    const at = "  await expectRenderLoopAlive(page, 'leg 3 on the board leg 2 left');\n";
    const benign = replaceOnce(RAW, at, at + "  console.log('Newer items', 'News');\n");
    expect(audit(benign)).not.toMatch(/^R5: /m);
  });

  it('R5 and R9 REFUSE a direct New board click and a setTimeout sleep in leg 2 (refuter 10)', () => {
    const both = replaceOnce(
      RAW,
      "  const errs = await attachToRunningBoard(page, 'leg 2');\n",
      "  const errs = await attachToRunningBoard(page, 'leg 2');\n" +
        "  await page.getByTitle('New board (Ctrl+N)').click();\n" +
        '  await new Promise((r) => setTimeout(r, 2000));\n',
    );
    const found = audit(both);
    expect(found).toMatch(/^R5: line \d+: `New board` presses the New or Examples control directly/m);
    expect(found).toMatch(/^R9: line \d+: a fixed-time sleep/m);
  });

  it('R6 REFUSES the same-page read taken out of the attach, or out of the last walking leg', () => {
    const noAttach = replaceOnce(RAW, '  await expectSamePage(page, `at the start of ${leg}`);\n', '');
    expect(audit(noAttach)).toMatch(/^R6: `attachToRunningBoard` does not call `expectSamePage\(`/m);
    const noEnd = replaceOnce(RAW, "  await expectSamePage(page, 'at the end of leg 5, the last walking leg');\n", '');
    expect(audit(noEnd)).toMatch(/^R6: `leg 5 - .*`, the last walking leg, must call `expectSamePage\(`/m);
  });

  it('R6 REFUSES the page mark written by a leg, which could hide a reload', () => {
    const replant =
      '  await page.evaluate((m) => { (window as unknown as { __fabCompWalkPage?: string }).__fabCompWalkPage = m; }, PAGE_MARK);';
    const found = audit(appended(legTwo({ afterAttach: replant })));
    expect(found).toMatch(/^R6: line \d+: `__fabCompWalkPage` is touched outside the boot/m);
    expect(found).toMatch(/^R6: line \d+: `PAGE_MARK` is touched outside the boot/m);
  });

  // THE 77-05 REFUTER ROUND: leg 5's cable reads and wiring, each refuter's own edit ------------
  const leg5Only = (src: string, from: string, to: string): string => {
    const start = src.indexOf("test('leg 5 - ");
    expect(start, 'leg 5 is found').toBeGreaterThan(0);
    const at = src.indexOf(from, start);
    expect(at, `${from.slice(0, 40)} sits in leg 5`).toBeGreaterThan(start);
    return src.slice(0, at) + to + src.slice(at + from.length);
  };

  it('R12 REFUSES drawnCableSet built from the model instead of the plot (77-05 refuter 2)', () => {
    const fromModel = replaceOnce(
      RAW,
      '  return (await cablePolylines(page))\n    .map((pl) => pl.map',
      '  const sc = await readScene(page);\n  return sc.wires.map((w) => w.path.map((c) => ({ x: (c.cell_x + 0.5) * CELL, y: (c.cell_y + 0.5) * CELL })))\n    .map((pl) => pl.map',
    );
    const found = audit(fromModel);
    expect(found).toMatch(/^R12: `drawnCableSet` does not call `cablePolylines\(`/m);
    expect(found).toMatch(/^R12: `drawnCableSet` calls `readScene\(`/m);
    expect(found).toMatch(/^R12: `drawnCableSet` names `wires`/m);
  });

  it('R12 REFUSES drawnCableSet calling the plot and returning the model, or a record', () => {
    const both = replaceOnce(
      RAW,
      '  return (await cablePolylines(page))\n    .map((pl) => pl.map',
      '  void (await cablePolylines(page));\n  return Object.values(board.leg1CableCells ?? {})\n    .map((pl) => pl.map',
    );
    expect(audit(both)).toMatch(/^R12: `drawnCableSet` names `board`/m);
  });

  it('R12 REFUSES the screen read taking the plot, or dropping its screenshot', () => {
    const plot = replaceOnce(
      RAW,
      '  const cam = await cameraOf(page);\n  if (cam.scale !== 1) {\n    throw new Error(`cablesOnScreen:',
      '  await cablePolylines(page);\n  const cam = await cameraOf(page);\n  if (cam.scale !== 1) {\n    throw new Error(`cablesOnScreen:',
    );
    expect(audit(plot)).toMatch(/^R12: `cablesOnScreen` calls `cablePolylines\(`, which it may not read through/m);
    const noShot = replaceOnce(
      RAW,
      '  const png = PNG.sync.read(await captureClip(page, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));',
      '  const png = PNG.sync.read(readFileSync(STILL));',
    );
    expect(audit(noShot)).toMatch(/^R12: `cablesOnScreen` does not call `captureClip\(`/m);
  });

  it("R10 and R13 REFUSE leg 5's head-on loop deleted, or narrowed to one leg (77-05 refuter 3 c)", () => {
    const loop = '  for (const w of after.wires) {\n    expectHeadOn(after, w, `SAME CELLS HEAD-ON the restored leg ${anchorKey(after, w)}`);\n  }\n';
    const gone = audit(leg5Only(RAW, loop, ''));
    expect(gone).toMatch(/^R10: `leg 5 - .*` carries `SAME CELLS HEAD-ON` in 1 assertion call\(s\), 2 pinned/m);
    expect(gone).toMatch(/^R13: `leg 5 - .*` holds `for\(constwofafter\.wires\)/m);
    const one = audit(leg5Only(RAW, '  for (const w of after.wires) {\n', '  for (const w of after.wires.slice(0, 1)) {\n'));
    expect(one).toMatch(/^R13: `leg 5 - .*` holds `for\(constwofafter\.wires\)\{expectHeadOn\(after,w,` 0 time\(s\), 1 pinned/m);
  });

  it('R13 REFUSES NOTHING ON TOP graded on a copy of the strip with its recording gone (77-05 refuter 3 d)', () => {
    const copy = leg5Only(RAW, '  const seen = await recordStatusStripDuring(page, () =>\n', '  const seen = [stripBefore]; await (() =>\n');
    expect(audit(copy)).toMatch(/^R13: `leg 5 - .*` holds `constseen=awaitrecordStatusStripDuring\(page,\(\)=>expectRefusalStayedSilent\(page,` 0 time\(s\), 1 pinned/m);
  });

  it('R13 REFUSES a second Ctrl+Z, or an undo through another key (77-05 refuter 3 e)', () => {
    const press = "      await page.keyboard.press('Control+z');\n";
    const twice = audit(leg5Only(RAW, press, press + press));
    expect(twice).toMatch(/^R13: `leg 5 - .*` holds `awaitpage\.keyboard\.press\('Control\+z'\);` 2 time\(s\), 1 pinned/m);
    expect(twice).toMatch(/^R13: `leg 5 - .*` makes 2 keyboard call\(s\), 1 pinned/m);
    const meta = audit(leg5Only(RAW, press, press + "      await page.keyboard.press('Meta+z');\n"));
    expect(meta).toMatch(/^R13: `leg 5 - .*` makes 2 keyboard call\(s\), 1 pinned/m);
  });

  it("R10 REFUSES leg 5's NOTHING ON TOP left with no matcher, and its two later plot reads deleted (77-05 refuter 3 a, b)", () => {
    expect(audit(leg5Only(RAW, '  ).toEqual([stripBefore]);\n', '  );\n'))).toMatch(
      /^R10: `leg 5 - .*`NOTHING ON TOP` ends in no matcher/m,
    );
    let s = RAW;
    for (const msg of ["message: 'CABLE PLOTTED: after the Disconnect", "message: 'CABLE PLOTTED: after one Ctrl+Z"]) {
      const i = s.indexOf(msg);
      const j = s.lastIndexOf('  await expect\n', i);
      const k = s.indexOf(';\n', i) + 2;
      s = s.slice(0, j) + s.slice(k);
    }
    expect(audit(s)).toMatch(/^R10: `leg 5 - .*` carries `CABLE PLOTTED` in 1 assertion call\(s\), 3 pinned/m);
  });

  it('R11 REFUSES a guarded cable read rebound inside leg 5', () => {
    const rebound = leg5Only(RAW, '  const opened = await readScene(page);\n', '  const opened = await readScene(page);\n  const cablesOnScreen = async () => ({ seen: true, gone: false, covered: [] });\n');
    expect(audit(rebound)).toMatch(/^R11: line \d+: `cablesOnScreen` is used other than by a direct call/m);
  });

  it('R12 and R13 hold AT HEAD', () => {
    expect(audit(RAW)).not.toMatch(/^R1[23]: /m);
  });

  // Quick 261009-rhl (v9.0 audit Part 1 gap 1): leg 4's re-POST to leg 1's Route after the reload.
  it("R10 REFUSES leg 4's re-POST after the reload deleted, whole or by its body assertion alone", () => {
    const start = RAW.indexOf("  await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);\n  const reloadedUrl");
    const end = RAW.indexOf("  await expectRenderLoopAlive(page, 'leg 4 after the reloaded Route answered');\n");
    expect(start > 0 && end > start, 'the re-POST step is found in leg 4 at HEAD').toBe(true);
    const whole = audit(RAW.slice(0, start) + RAW.slice(end));
    expect(whole).toMatch(/^R10: `leg 4 - .*` lost its defining assertion `STILL ANSWERS AFTER THE RELOAD`/m);
    const bodyOnly = audit(
      replaceOnce(
        RAW,
        /  expect\(\n    \{ status: afterReload\.status, body: afterReload\.body \},\n[^\n]*\n  \)\.toEqual\(\{ status: 200, body: PANEL_BODY \}\);\n/,
        '',
      ),
    );
    expect(bodyOnly).toMatch(/^R10: `leg 4 - .*` carries `STILL ANSWERS AFTER THE RELOAD` in 2 assertion call\(s\), 3 pinned/m);
    expect(bodyOnly).toMatch(/^R13: `leg 4 - .*` holds `\.toEqual\(\{status:200,body:PANEL_BODY\}\);` 0 time\(s\), 1 pinned/m);
  });

  it("R13 REFUSES leg 4's re-POST expecting the preset body, or sent to leg 1's pre-reload URL", () => {
    const preset = audit(
      replaceOnce(RAW, '  ).toEqual({ status: 200, body: PANEL_BODY });', '  ).toEqual({ status: 200, body: HANDLER_PRESET_BODY });'),
    );
    expect(preset).toMatch(/^R13: `leg 4 - .*` holds `\.toEqual\(\{status:200,body:PANEL_BODY\}\);` 0 time\(s\), 1 pinned/m);
    const stale = audit(
      replaceOnce(
        RAW,
        `reloadedUrl, '{"probe":"comp-leg4-reloaded"}');`,
        `required('endpointUrl', 'leg 1'), '{"probe":"comp-leg4-reloaded"}');`,
      ),
    );
    expect(stale).toMatch(/^R13: `leg 4 - .*` holds `reloadedUrl,'\{"probe":"comp-leg4-reloaded"\}'\);` 0 time\(s\), 1 pinned/m);
    const notResolved = audit(
      replaceOnce(RAW, '  const reloadedUrl = await readPanelUrl(page);', "  const reloadedUrl = required('endpointUrl', 'leg 1');"),
    );
    expect(notResolved).toMatch(/^R13: `leg 4 - .*` holds `awaitselectMachineAt\(page,ROUTE_CELL\[0\],ROUTE_CELL\[1\]\);constreloadedUrl=awaitreadPanelUrl\(page\);` 0 time\(s\), 1 pinned/m);
  });

  // ACCEPTS ------------------------------------------------------------------
  it('ACCEPTS a comment mentioning a declaration after leg 1', () => {
    expect(auditOneBoardSpec(appended("// a later note: test('leg 2 - x', ...) in prose"), REQUIREMENTS)).toEqual([]);
  });

  it('ACCEPTS a comment discussing a throw', () => {
    expect(
      auditOneBoardSpec(appended('// a cut leg runs `throw new Error(...)` on purpose'), REQUIREMENTS),
    ).toEqual([]);
  });

  it('ACCEPTS a message string that names newBoard: a word in a string is not a reference', () => {
    // Placed above `test.afterAll`, not appended: text after the last declaration belongs to it, and
    // the last declaration is leg 3's cut, which must be ONE throw with nothing after it (R4).
    const note = `// a note\nconst NOTE = 'the empty board newBoard measured, and resetToDemo before it';\n\n`;
    expect(auditOneBoardSpec(replaceOnce(RAW, 'test.afterAll(', `${note}test.afterAll(`), REQUIREMENTS)).toEqual([]);
  });

  it('ACCEPTS a well-formed CUT declared last whose body throws', () => {
    const cut = appended(
      "test('CUT - leg 1 clause \"x\": a reason', async () => {\n  throw new Error('CUT: a reason');\n});",
    );
    expect(auditOneBoardSpec(cut, REQUIREMENTS)).toEqual([]);
  });
});
