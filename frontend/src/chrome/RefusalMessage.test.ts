import { describe, it, expect } from 'vitest';
import {
  BAND_AVOID_GAP_PX,
  CLIENT_REFUSAL_COPY,
  bandTopAvoiding,
  type ClientRefusalTag,
  REFUSAL_COPY,
  REFUSAL_HOLD_MS,
} from './RefusalMessage';
import type { RefusalTag } from '../transport/transport';

// RefusalMessage.test.ts (ERR-01 / ERR-02) - the LOCK on the refusal copy table.
//
// This file is the reason a reword cannot silently change what a user is told. The
// table is the whole user-facing surface of phase 64: 38 sentences (17 at 64-09, 18 at
// plan 68-04's `PaceOutOfRange`, 19 at plan 72-07's `DuplicatePath`, 22 at plan 74.1-18's
// three belt refusals, 24 at plan 74.1-24's two belt-join causes, 25 at plan 74.1-32's
// `BeltEndTaken`, 26 at plan 76-02's `ResizeCovers`, 27 at plan 76-04's `LabelDoesNotConnect`, 28 at plan 86-06's `UndoSpaceTaken`, 38 at plan 88-02's split of `Malformed`, `OutOfBounds` and `FootprintCollision` plus `BoardChanged`), one per host refusal tag, and every property that makes them safe to render is asserted here
// rather than left to review.
//
// The em-dash lock follows the `PortsSection.test.ts` / `Legend.test.ts` /
// `kindNames.test.ts` idiom, widened: this file asserts the FULL ASCII range rather
// than the two dash characters alone, because the failure mode is any non-ASCII
// character reaching prose shipped under the developer's name, and a curly apostrophe
// gets in exactly the same way an em dash does.
//
// Every dash character below is written as an escape (`\u2014`, `\u2013`) so this SPEC
// is itself ASCII-clean. A test that contains the character it forbids is one careless
// copy-paste away from being the source of the defect.

/**
 * The EXPECTED key set, declared as `Record<RefusalTag, true>` so the compiler is the
 * first gate: a tag missing here is a compile error, and a tag that is not one of the
 * union is a compile error too. The runtime assertion below then proves `REFUSAL_COPY`
 * agrees with it, which is what catches a table that drifted from the union.
 */
const EXPECTED_TAGS: Record<RefusalTag, true> = {
  FootprintCollision: true,
  OutOfBounds: true,
  UnknownNode: true,
  IncompatiblePorts: true,
  PortOccupied: true,
  UnknownKind: true,
  BeltNotPlaceable: true,
  InvalidDock: true,
  Malformed: true,
  BeltTooLong: true,
  NothingToUndo: true,
  NothingToRedo: true,
  MediumMismatch: true,
  ZeroBeltInterval: true,
  PaceOutOfRange: true,
  RouteEmpty: true,
  RouteNonAdjacent: true,
  RouteSelfCrossing: true,
  DuplicatePath: true,
  RotateCoversBelt: true,
  GrowCoversBelt: true,
  InvalidBeltJoin: true,
  BeltJoinTurnsBack: true,
  BeltEndsApart: true,
  BeltEndTaken: true,
  ResizeCovers: true,
  LabelDoesNotConnect: true,
  UndoSpaceTaken: true,
  NoSuchPort: true,
  UnknownOption: true,
  OverLimit: true,
  InvalidPath: true,
  WrongKind: true,
  UndoDoesNotFit: true,
  MachineTooBig: true,
  RotateBlocked: true,
  GrowBlocked: true,
  BoardChanged: true,
};

/**
 * The 38 sentences, transcribed from the UI-SPEC Copywriting Contract rather than from
 * the implementation. A verbatim assertion against a value read out of the module under
 * test would agree with itself; this is the independent copy. Seventeen come from
 * `64-UI-SPEC.md`; `PaceOutOfRange` comes from `68-UI-SPEC.md` section 9's new refusal
 * row; `DuplicatePath` comes from `72-UI-SPEC.md` section 8.3's refusal row (SERVE-08,
 * D-13). All three transcribed from the SPEC and NOT from `RefusalMessage.tsx`.
 * `RotateCoversBelt`, `GrowCoversBelt` and `InvalidBeltJoin` are transcribed from plan
 * 74.1-18's must-have truths (the WR-03 ruling "Refuse, say why", and gap N4c), where
 * their 49, 49 and 70 characters were measured with `python3 len()`. `BeltJoinTurnsBack`,
 * `BeltEndsApart` and the reworded `InvalidBeltJoin` are transcribed from plan 74.1-24's
 * first must-have truth (gap J11), 40, 24 and 77 characters by `python3 len()`. `BeltEndTaken`
 * and the second reword of `InvalidBeltJoin` are transcribed from plan 74.1-32's first two
 * must-have truths (HEAD-WORDS and J11-THIRD), 48 and 47 characters by `python3 len()`.
 * `ResizeCovers` is transcribed from `76-UI-SPEC.md` section 6.2's grow-refusal row (phase
 * 76, plan 76-02), 44 characters by `python3 len()`. `LabelDoesNotConnect` is transcribed from
 * plan 76-04's second must-have truth (phase 76, D-07, 76-UI-SPEC 6.2), 38 characters by
 * `python3 len()`. `UndoSpaceTaken` is transcribed from plan 86-06's third must-have truth
 * (phase 86, D-04), 44 characters by `python3 len()`. The ten plan 88-02 rows, the narrowed
 * `Malformed` and the reworded `UnknownNode` are transcribed from plan 88-02's `## Assumptions`
 * table (phase 88, D-11, D-03), each measured with `python3 len()` there: 32, 38, 42, 41, 44,
 * 35, 44, 39, 39 and 48, and 37 and 31. The reworded `FootprintCollision` is transcribed
 * from `89-UI-SPEC.md` decision A5 (phase 89, plan 89-08), 47 characters by `python3 len()`.
 */
const COPY_CONTRACT: Record<RefusalTag, string> = {
  FootprintCollision: 'That space is taken. Clear it or try elsewhere.',
  OutOfBounds: 'That cell is past the edge of the grid.',
  BeltTooLong: 'That belt is too long. Draw it in shorter runs.',
  MediumMismatch: 'Belts and wires use different ports.',
  InvalidDock: 'A belt runs from an output to an input, right next to it.',
  PortOccupied: 'That output is already connected. Disconnect it first.',
  UnknownNode: 'That is no longer on the board.',
  BeltNotPlaceable: 'A belt is drawn, not placed. Use the Belt tool.',
  ZeroBeltInterval: 'A belt needs a speed above zero.',
  UnknownKind: 'That machine kind is not available.',
  Malformed: 'The host could not read that gesture.',
  IncompatiblePorts: 'A wire connects two machines, output to input.',
  NothingToUndo: 'Nothing left to undo.',
  NothingToRedo: 'Nothing left to redo.',
  PaceOutOfRange: 'That pace is outside the Belt pace scale.',
  RouteEmpty: 'That belt has no path.',
  RouteNonAdjacent: 'A belt path moves one cell at a time.',
  RouteSelfCrossing: 'A belt path cannot cross itself.',
  DuplicatePath: 'That path is already used by another Route.',
  RotateCoversBelt: 'Turning would cover a belt. Move that belt first.',
  GrowCoversBelt: 'Growing would cover a belt. Move that belt first.',
  InvalidBeltJoin: "Join a belt's end to the start of another belt.",
  BeltJoinTurnsBack: 'A join cannot turn back the way it came.',
  BeltEndsApart: 'These ends do not touch.',
  BeltEndTaken: 'That belt end is already joined. Use a free end.',
  ResizeCovers: 'That size would cover something. Go smaller.',
  LabelDoesNotConnect: 'Labels are notes. They do not connect.',
  UndoSpaceTaken: 'That space is taken now. Nothing was undone.',
  NoSuchPort: 'That port is not on the machine.',
  UnknownOption: 'That choice is not one the app offers.',
  OverLimit: 'That is outside the limits the app allows.',
  InvalidPath: 'That is not a web path the app can serve.',
  WrongKind: 'That edit does not apply to what you picked.',
  UndoDoesNotFit: 'That step no longer fits the board.',
  MachineTooBig: 'That machine would grow past the size limit.',
  RotateBlocked: 'No room to turn. Clear the space first.',
  GrowBlocked: 'No room to grow. Clear the space first.',
  BoardChanged: 'The board changed first. That edit was not made.',
};

/** The per-line character budget: 420px content, less the glyph and gap, at 8px/char. */
const WRAP_BUDGET_CHARS = 50;

const ENTRIES = Object.entries(REFUSAL_COPY) as [RefusalTag, string][];

/**
 * The client table (plan 75-07, D-12), transcribed from 75-UI-SPEC section 5.2 and the
 * plan's must-have truth, NOT read back out of `RefusalMessage.tsx`. 33 characters by
 * `python3 len()`, measured in the plan.
 */
const CLIENT_COPY_CONTRACT: Record<ClientRefusalTag, string> = {
  BeltOnlyPort: 'That port takes belts, not wires.',
  // Plan 89-09 (D-14), transcribed from 89-UI-SPEC's Copywriting Contract: 40 characters.
  DockNotSent: 'A belt you drew is missing a connection.',
};

const CLIENT_ENTRIES = Object.entries(CLIENT_REFUSAL_COPY) as [ClientRefusalTag, string][];

/**
 * Every sentence either table can put in the band. The house-voice checks below run over
 * this, so a client sentence is held to exactly the rules a host one is.
 */
const ALL_ENTRIES: [string, string][] = [...ENTRIES, ...CLIENT_ENTRIES];

describe('REFUSAL_COPY - the closed, exhaustive refusal copy table (ERR-02)', () => {
  it('has exactly one entry per host refusal tag, and no extras', () => {
    // MUTATION: delete any one row from REFUSAL_COPY -> this reddens on the key set
    // BEFORE the compiler is consulted, so the failure names the missing tag rather
    // than only failing the build.
    expect(Object.keys(REFUSAL_COPY).sort(), 'the copy table key set equals the tag union').toEqual(
      Object.keys(EXPECTED_TAGS).sort(),
    );
    expect(
      ENTRIES.length,
      'thirty-eight tags: 35 payload-free CommandError variants plus the three Route peers (28 until plan 88-02 added nine split tags and BoardChanged)',
    ).toBe(38);
  });

  it('every sentence is the exact string the UI-SPEC locks, one assertion per tag', () => {
    for (const [tag, expected] of Object.entries(COPY_CONTRACT) as [RefusalTag, string][]) {
      expect(REFUSAL_COPY[tag], `the ${tag} sentence`).toBe(expected);
    }
  });

  it('contains no em dash, no en dash, and no non-ASCII character at all', () => {
    // The project rule on everything shipped under the developer's name. Widened past
    // the two dashes to the whole ASCII range, so a curly quote or a Unicode ellipsis
    // cannot slip in through the same door. Both tables (plan 75-07).
    for (const [tag, value] of ALL_ENTRIES) {
      expect(value, `${tag} carries no em dash`).not.toContain('\u2014');
      expect(value, `${tag} carries no en dash`).not.toContain('\u2013');
      const offenders = [...value].filter((ch) => ch.charCodeAt(0) > 0x7f);
      expect(offenders, `${tag} is ASCII-only, found: ${offenders.join(' ')}`).toEqual([]);
    }
  });

  it('stays inside the 50-character wrap budget, with TWO counted exceptions and three rows at a one-character margin', () => {
    // TWO tags are skipped here (three from plan 74.1-18 to plan 74.1-32, when the
    // `InvalidBeltJoin` reword brought that row to 47 characters and one line), and each is asserted BY NAME at its own measured
    // length below. The skip list is the whole mechanism: an over-budget row is a
    // COUNTED exception, never a raised budget. Raising `WRAP_BUDGET_CHARS` would
    // unpin every other tag in one edit - including the three rows at 49 characters,
    // each with a ONE-character margin - which is why it is 50 here and 50 in
    // `67-BASELINE.md`'s standing prohibition.
    // The prohibition "the budget is never raised, an over-budget row is a COUNTED
    // exception" had NO enforcement until this line. Verified by mutation, phase 67
    // verification: `WRAP_BUDGET_CHARS` 50 -> 60 on its own, nothing else touched,
    // left this whole file green (7 passed) - every other assertion here is either an
    // absolute `toBe(n)` by name or, in the case of the exception COUNT below, a
    // tautology over a literal declared three lines above it. Pin the budget itself,
    // or the standing prohibition is prose with a passing test next to it.
    expect(WRAP_BUDGET_CHARS, 'the wrap budget is 50 and is never raised; over-budget rows are counted exceptions').toBe(50);
    const COUNTED_EXCEPTIONS: string[] = ['InvalidDock', 'PortOccupied'];
    // Both tables (plan 75-07): the client table has no counted exception.
    for (const [tag, value] of ALL_ENTRIES) {
      if (COUNTED_EXCEPTIONS.includes(tag)) continue;
      expect(
        value.length,
        `${tag} is ${value.length} chars; over ${WRAP_BUDGET_CHARS} it silently wraps to a second line`,
      ).toBeLessThanOrEqual(WRAP_BUDGET_CHARS);
    }
    expect(COUNTED_EXCEPTIONS.length, 'exactly two rows are deliberately over budget').toBe(2);
    // Exception 1: the deliberate two-line row, pinned so it cannot grow further
    // unnoticed. It wraps to exactly 2 lines inside the 420px clamp (measured in the
    // mock suite, `e2e/gesture-verdict.spec.ts`). The pin was 56, sourced from
    // `67-BASELINE.md`'s `## Measured copy` table. Since 74.1-10 (review WR-03) the
    // sentence drops its stale facing clause and is 57, sourced from the `len()`
    // measurement recorded in `74.1-10-SUMMARY.md`, NOT read back out of this file - a
    // pin that sources its number from the thing it guards cannot fail.
    expect(REFUSAL_COPY.InvalidDock.length, 'InvalidDock is a deliberate two-line row').toBe(57);
    // Exception 2 (Phase 67, plan 67-06): `PortOccupied` carries a RECOVERY CLAUSE
    // naming the Disconnect control that shipped in 67-02, and the clause is what
    // puts it over budget. There is no shorter wording that both fits 50 and keeps
    // the pre-written clause: the shortened variant
    // `That output is already connected. Disconnect first.` measures 51 - also
    // over - and drops the verbatim sentence `RefusalMessage.tsx` instructed this
    // phase to restore. So it is a second counted exception at its measured 54,
    // and NOT a budget change. Do not re-propose the 51-character shortening.
    expect(
      REFUSAL_COPY.PortOccupied.length,
      'PortOccupied is a deliberate two-line row: the recovery clause is worth the second line',
    ).toBe(54);
    // Plan 89-08 (89-UI-SPEC A5): reworded so a drawn belt is not told to "place", measured
    // 47 with `python3 len()` in the plan, a three-character margin against the budget.
    expect(
      REFUSAL_COPY.FootprintCollision.length,
      'FootprintCollision has a three-character margin against the 50-char budget',
    ).toBe(47);
    // Asserted BY NAME because they are the tightest single-line rows in the table. A
    // one-character reword pushes either over the budget and nothing else would notice.
    // Plan 74.1-18: measured 49 with `python3 len()` in the plan, not read back from the
    // module under test.
    expect(
      REFUSAL_COPY.RotateCoversBelt.length,
      'RotateCoversBelt has a ONE-character margin against the 50-char budget',
    ).toBe(49);
    expect(
      REFUSAL_COPY.GrowCoversBelt.length,
      'GrowCoversBelt has a ONE-character margin against the 50-char budget',
    ).toBe(49);
    // Formerly exception 3 (plan 74.1-18, gap N4c; reworded by plan 74.1-24 to 77 characters,
    // gap J11). Plan 74.1-32 (J11-THIRD) reworded it to say what to do: measured 47 with
    // `python3 len()` in the plan, now ONE line, inside the budget and checked by the loop
    // above as well. Its rendered single line is measured in `e2e/gesture-verdict.spec.ts`.
    expect(REFUSAL_COPY.InvalidBeltJoin.length, 'InvalidBeltJoin is one line since plan 74.1-32').toBe(47);
    // Plan 74.1-32 (HEAD-WORDS): a taken belt end, measured 48 with `python3 len()`.
    expect(REFUSAL_COPY.BeltEndTaken.length, 'BeltEndTaken is one line').toBe(48);
    // Plan 76-02 (76-UI-SPEC 6.2): a resize that would cover something, measured 44.
    expect(REFUSAL_COPY.ResizeCovers.length, 'ResizeCovers is one line').toBe(44);
    expect(REFUSAL_COPY.ResizeCovers, 'the grow refusal pinned by name').toBe(
      'That size would cover something. Go smaller.',
    );
    // Plan 76-04 (phase 76 D-07, 76-UI-SPEC 6.2): any attempt to connect a label, measured 38.
    expect(REFUSAL_COPY.LabelDoesNotConnect.length, 'LabelDoesNotConnect is one line').toBe(38);
    expect(REFUSAL_COPY.LabelDoesNotConnect, 'the connect refusal pinned by name').toBe(
      'Labels are notes. They do not connect.',
    );
    // Plan 86-06 (phase 86 D-04): an Undo whose restore would land on cells another node now
    // holds, measured 44. It never says "try elsewhere" or "clear it": an Undo offers
    // neither choice (`refusal_copy_truth.rs` drives the real arm and holds that).
    expect(REFUSAL_COPY.UndoSpaceTaken.length, 'UndoSpaceTaken is one line').toBe(44);
    expect(REFUSAL_COPY.UndoSpaceTaken, 'the Undo refusal pinned by name').toBe(
      'That space is taken now. Nothing was undone.',
    );
    expect(REFUSAL_COPY.UndoSpaceTaken.toLowerCase(), 'an Undo refusal offers no placement').not.toContain('elsewhere');
    // Plan 74.1-24 (gap J11): the two belt-join causes split out of it, each inside the
    // budget, measured with `python3 len()` in the plan.
    expect(REFUSAL_COPY.BeltJoinTurnsBack.length, 'BeltJoinTurnsBack is one line').toBe(40);
    expect(REFUSAL_COPY.BeltEndsApart.length, 'BeltEndsApart is one line').toBe(24);
    // Plan 88-02 (phase 88, D-11, D-03): the split rows, each one line, measured with
    // `python3 len()` in the plan, not read back from the module under test. None is a counted
    // exception: the list above stays at two.
    const PLAN_88_02_LENGTHS: [RefusalTag, number][] = [
      ['Malformed', 37],
      ['UnknownNode', 31],
      ['NoSuchPort', 32],
      ['UnknownOption', 38],
      ['OverLimit', 42],
      ['InvalidPath', 41],
      ['WrongKind', 44],
      ['UndoDoesNotFit', 35],
      ['MachineTooBig', 44],
      ['RotateBlocked', 39],
      ['GrowBlocked', 39],
      ['BoardChanged', 48],
    ];
    for (const [tag, n] of PLAN_88_02_LENGTHS) {
      expect(REFUSAL_COPY[tag].length, `${tag} is one line at ${n} characters`).toBe(n);
    }
    // A turn and an output add have no elsewhere (WINDOWS 84): neither row offers one.
    expect(REFUSAL_COPY.RotateBlocked.toLowerCase(), 'a blocked turn offers no placement').not.toContain('elsewhere');
    expect(REFUSAL_COPY.GrowBlocked.toLowerCase(), 'a blocked growth offers no placement').not.toContain('elsewhere');
    // A machine too big mid-grid is not past the edge (WINDOWS 83).
    expect(REFUSAL_COPY.MachineTooBig.toLowerCase(), 'the size limit is not the grid edge').not.toContain('edge');
  });

  it('never apologises, never blames and never contracts "cannot"', () => {
    // The house voice, and a real constraint rather than taste: a refusal that says
    // sorry attributes fault to a person who did nothing wrong, and the corpus scan
    // that authored this table found zero instances of any of these anywhere under
    // `frontend/src`.
    const FORBIDDEN = ['sorry', 'unfortunately', 'oops', 'apolog', 'please', "can't", 'can not'];
    for (const [tag, value] of ALL_ENTRIES) {
      const lower = value.toLowerCase();
      for (const word of FORBIDDEN) {
        expect(lower.includes(word), `${tag} must not contain "${word}": ${value}`).toBe(false);
      }
    }
  });

  it('is a sentence: initial capital, terminal period', () => {
    for (const [tag, value] of ALL_ENTRIES) {
      expect(value.length, `${tag} is non-empty`).toBeGreaterThan(0);
      expect(value[0], `${tag} opens with a capital`).toBe(value[0].toUpperCase());
      expect(value.endsWith('.'), `${tag} ends with a terminal period: ${value}`).toBe(true);
    }
  });
});

describe('CLIENT_REFUSAL_COPY - the closed client refusal table (plan 75-07, D-12)', () => {
  it('holds exactly the D-12 tag and the 89-09 D-14 tag, and none of its keys is a host tag', () => {
    expect(Object.keys(CLIENT_REFUSAL_COPY).sort(), 'the client table key set').toEqual(['BeltOnlyPort', 'DockNotSent']);
    // The two unions share no member: a client tag inside the host table would claim the
    // host can say something it cannot, and App's shown-tag bookkeeping relies on it.
    for (const tag of Object.keys(CLIENT_REFUSAL_COPY)) {
      expect(Object.keys(REFUSAL_COPY), `${tag} is not a host refusal tag`).not.toContain(tag);
    }
  });

  it('BeltOnlyPort is the exact UI-SPEC sentence, 33 characters, one line', () => {
    for (const [tag, expected] of Object.entries(CLIENT_COPY_CONTRACT) as [ClientRefusalTag, string][]) {
      expect(CLIENT_REFUSAL_COPY[tag], `the ${tag} sentence`).toBe(expected);
    }
    // 33 by `python3 len()` in plan 75-07, not read back from the module under test.
    expect(CLIENT_REFUSAL_COPY.BeltOnlyPort.length, 'BeltOnlyPort is 33 characters, 17 inside the budget').toBe(33);
  });

  it('DockNotSent is the exact 89-UI-SPEC sentence, 40 characters, inside the 50-character line', () => {
    expect(CLIENT_REFUSAL_COPY.DockNotSent, 'the DockNotSent sentence').toBe('A belt you drew is missing a connection.');
    // 40 by `python3 len()` in 89-UI-SPEC, not read back from the module under test.
    expect(CLIENT_REFUSAL_COPY.DockNotSent.length, 'DockNotSent is 40 characters').toBe(40);
    expect(CLIENT_REFUSAL_COPY.DockNotSent.length, 'inside the 50-character line budget').toBeLessThanOrEqual(WRAP_BUDGET_CHARS);
    // A6: no recovery clause, because connecting by hand is not always possible when the target is gone.
    expect(/connect it|try again|draw it again|reconnect/i.test(CLIENT_REFUSAL_COPY.DockNotSent), 'no recovery clause').toBe(false);
  });

  it('is in sentence case and carries no recovery clause', () => {
    for (const [tag, value] of CLIENT_ENTRIES) {
      // Sentence case, strictly: no capital after the first character (the host table
      // names tools such as "Belt tool", this one names none).
      expect(value.slice(1), `${tag} is in sentence case: ${value}`).toBe(value.slice(1).toLowerCase());
      // UI-SPEC 5.2: `Use the Belt tool.` is false when that port is already linked, and a
      // recovery that is not always true is forbidden. One sentence, no second clause.
      expect(value.split('.').filter((part) => part.trim() !== '').length, `${tag} is one sentence`).toBe(1);
      expect(value.toLowerCase().includes('use the'), `${tag} names no tool to use`).toBe(false);
    }
  });
});

describe('REFUSAL_HOLD_MS', () => {
  it('is 4000 and is its own constant, free to diverge from the status auto-clear', () => {
    // D-19. The value matching `STATUS_AUTOCLEAR_MS` today is a coincidence of tuning,
    // not a shared rule; `App.tsx` must not alias or re-declare this one.
    expect(REFUSAL_HOLD_MS).toBe(4000);
  });
});

// Phase 89 UI review UI-02: the band never hides the flashed cell it answers.
describe('bandTopAvoiding - the band steps below a flashed cell it would cover (UI-02)', () => {
  const BAND = { left: 568, top: 142, right: 1032, bottom: 202 };

  it('a flashed cell under the band moves the band to just below the cell', () => {
    const cell = { left: 600, top: 160, right: 632, bottom: 192 };
    expect(bandTopAvoiding(BAND, cell)).toBe(192 + BAND_AVOID_GAP_PX);
  });

  it('a flashed cell clear of the band, or no flash, leaves the band where it is', () => {
    expect(bandTopAvoiding(BAND, { left: 600, top: 300, right: 632, bottom: 332 })).toBeNull();
    expect(bandTopAvoiding(BAND, { left: 100, top: 160, right: 132, bottom: 192 })).toBeNull();
    expect(bandTopAvoiding(BAND, null)).toBeNull();
    expect(bandTopAvoiding(BAND, undefined)).toBeNull();
  });

  it('touching edges is not an overlap', () => {
    expect(bandTopAvoiding(BAND, { left: 600, top: 202, right: 632, bottom: 234 })).toBeNull();
  });
});
