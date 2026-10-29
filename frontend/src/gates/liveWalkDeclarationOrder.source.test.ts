// THE DURABLE GUARD over `e2e-live/24-one-board-all-six.spec.ts`'s DECLARATION ORDER.
//
// ===========================================================================
// ITS ORIGINAL SUBJECT IS GONE, AND THIS IS WHAT IT ASSERTS NOW (plan 74-09).
// ===========================================================================
//
// SAID PLAINLY, BECAUSE A GATE THAT ASSERTS NOTHING READS AS PROTECTION WHILE
// PROVIDING NONE: **the milestone no longer has a deliberate red.** Until plan 74-09
// the walk spec's last declaration was an unconditional `throw` reporting done-test
// leg 3's unwalkable half - the failure ruled in at the 2026-08-31 plan gate,
// recorded as known-issues row 155 - and this guard's headline rule was
// "that throw is the last declaration and it still throws". Phase 74 retired all
// three of the blockers the throw named (a belt is a ported node and a belt-to-belt
// `Dock` is accepted; two shipped gestures link two runs; the machine inbox has been
// bounded since phase 71), so the throw was deleted and replaced by a WALKING leg in
// the same position. That deletion was approved as a recorded decision in plan
// 74-09 before it was taken.
//
// So the "it still throws" rule had no subject left. It was NOT weakened into a
// no-op and it was NOT deleted: it was INVERTED, because the honest successor rule is
// the opposite one. This guard now asserts FOUR things, and every one of them has a
// failing direction that a mutation case at the foot of this file exercises:
//
//   R1  `mode: 'serial'` is still declared. Every other rule here rests on it.
//   R2  No `skip` / `fixme` / `fail` / `only`, at TEST scope or GROUP scope. A skip is
//       a green suite over a missing proof; an `only` narrows the whole live suite to
//       one file. Unchanged from the original guard.
//   R3  The walk's SIX declarations appear in the EXACT expected order. This is the
//       generalisation of the old "nothing is declared after the red" rule and it is
//       strictly stronger: it reddens on an APPENDED declaration (the original
//       hazard), and also on a REORDER and on a DELETED leg, neither of which the old
//       form could see.
//   R4  NO test in the walk spec throws unconditionally. This is the inverted rule.
//       A deliberate red is a thing somebody RULES IN, not a thing somebody writes:
//       the last one cost a plan gate to introduce and a checkpoint to remove. A new
//       `throw new Error(` appearing in this file is therefore a red that arrived
//       without that ruling, and it must redden here so the ruling gets asked for.
//       **IF A FUTURE PHASE DOES RULE ONE IN, THIS IS WHERE THE RULE LIVES**: change
//       R4 to require it, put its title in `EXPECTED_ORDER` at the position it is
//       declared, and record the ruling in the known-issues ledger as row 155 was.
//
// ===========================================================================
// WHY R3 IS A REAL RULE AND NOT BOOKKEEPING.
// ===========================================================================
//
// Two independent reasons, either sufficient on its own.
//
// THE LEGS SHARE A BOARD. Legs 1 to 5 run under `mode: 'serial'` on ONE mutable host
// and each continues on what the previous one left standing: leg 3 paces belts leg 1
// drew, leg 4 disconnects a dock leg 1 made and reads a wire leg 2 drew, leg 5
// round-trips the whole composition. A reorder does not merely shuffle output, it
// changes what every leg after the moved one inherits.
//
// AND SERIAL MODE STILL SKIPS. A test declared after a FAILING one never runs, and
// `playwright.live.config.ts` locks `retries: 0` as policy. So a declaration appended
// below the last leg is silently un-run whenever anything above it goes red, while
// the suite reports the same failure count it would have reported anyway. That is the
// hazard this guard was built for and it did not go away with the deliberate red.
//
// ===========================================================================
// WHY THIS FILE, RATHER THAN A SHELL ASSERTION IN A PLAN.
// ===========================================================================
//
// The rule was originally written in `69-06-PLAN.md`'s verify block. That grep
// EXECUTED ONCE, during plan 69-06, and nothing ran it again. A check that ran once is
// a record of a past reading, not a gate. It was ruled on 2026-08-31 that it be made
// durable.
//
// It is a vitest spec, and it lives under `src/` for a stated mechanical reason rather
// than because it is app code: `vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}`
// and NOTHING ELSE, and the CI `unit` job runs a bare `npx vitest run`. Under `src/` this
// file needs no config entry to be executed, so there is no include line for a later
// edit to drop. The artBoardLanes source test in the spike directory is the same idiom: a source gate
// over a file it does not import.
//
// It is deliberately NOT a test inside the walk spec itself: it would only ever execute
// during a LIVE run, which needs a built `dev_render_server`, a Vite server and a
// browser, and it should redden in the ~1 minute unit job instead.
//
// ===========================================================================
// WHAT IT READS, AND THE TWO THINGS IT CANNOT SEE.
// ===========================================================================
//
// It reads the spec as TEXT. It does not import it, does not run Playwright and knows
// nothing about what the legs assert. Comments are stripped before scanning (line count
// preserved so a reported line number is the real one), because the spec discusses its
// own `test(` declarations in prose and a guard that counted prose would be permanently
// red and would get "fixed" by weakening it.
//
// NOT SEEN, said plainly so the green is not over-read:
//   - A test declared through an alias or a helper (`const t = test; t('...')`) or built
//     by a loop. Every declaration in the file is a literal `test(` at the head of a line
//     and this guard requires that house style to hold; a declaration form it cannot see
//     is a declaration it cannot order.
//   - A regex literal carrying an unbalanced quote or a comment opener would confuse the
//     stripper. The `strips to something still recognisable` case below is the tripwire
//     for that going wrong.
//   - A CONDITIONAL throw, or a throw reached through a helper. R4 matches the literal
//     `throw new Error(` the deleted red used, which is the shape a designed red takes
//     in this repository; it is not a general unreachability analysis.
//
// The mutation cases at the foot of this file are not decoration. They are what stops
// this becoming another check that cannot fail: each one feeds the guard a source it
// MUST reject, and the clean case feeds it the real file it must accept.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { declarations, stripComments } from './walkSpecSource';

const SPEC_PATH = new URL('../../e2e-live/24-one-board-all-six.spec.ts', import.meta.url);
const SPEC_NAME = 'e2e-live/24-one-board-all-six.spec.ts';

/**
 * THE WALK'S DECLARATION ORDER, as title PREFIXES, in the order they must appear.
 *
 * Prefixes rather than whole titles so an ordinary copy edit to the descriptive tail of
 * a title does not redden a gate about ORDER - but the leg's IDENTITY is pinned, which
 * is the part the rule is actually about. The last entry is the leg that replaced the
 * deleted deliberate red in plan 74-09; its `completed last` marker is what makes "the
 * end of the file" a name rather than a position.
 */
const EXPECTED_ORDER = [
  'leg 1 -',
  'leg 2 -',
  'leg 3 -',
  'leg 4 -',
  'leg 5 -',
  'leg 3 completed last:',
] as const;

/**
 * Audit a walk-spec source. Returns one string per violation; EMPTY means clean.
 *
 * Findings rather than a boolean so a failure names what broke and where, and so the
 * mutation cases below can assert on the specific rule each one breaks.
 */
export function auditWalkSpec(stripped: string): string[] {
  const findings: string[] = [];

  // R1 - serial mode.
  if (!/^[ \t]*test\.describe\.configure\(\s*\{\s*mode:\s*(['"])serial\1\s*\}\s*\)/m.test(stripped)) {
    findings.push(
      "serial mode is no longer declared: this guard's whole premise is that the legs run in " +
        'order on ONE shared board and that a test after a failing one does not run, and both ' +
        'are properties of `mode: serial`',
    );
  }

  // R2 - no silencing modifier, at either scope.
  for (const m of stripped.matchAll(/\btest(?:\.describe)?\.(?:skip|fixme|fail|only)\b/g)) {
    const line = stripped.slice(0, m.index).split('\n').length;
    findings.push(
      `line ${line}: forbidden modifier \`${m[0]}\`. A skip, fixme or fail is a green suite over ` +
        'a missing proof, and an `only` narrows the live suite to this one file. Both scopes are ' +
        'banned',
    );
  }

  // R4 - no unconditional throw. Checked before the order rule so a reintroduced red is
  // reported as itself rather than as a stray extra declaration.
  for (const m of stripped.matchAll(/\bthrow\s+new\s+Error\s*\(/g)) {
    const line = stripped.slice(0, m.index).split('\n').length;
    findings.push(
      `line ${line}: an unconditional throw reappeared in ${SPEC_NAME}. The milestone's one ` +
        'deliberate red was DELETED in plan 74-09, after a recorded decision, because the ' +
        'capability it recorded as absent is now walked. A designed red is something that gets ' +
        'RULED IN, not something that gets written: if this one is intended, get the ruling, ' +
        'record it in the known-issues ledger, and change rule R4 in this guard to require it',
    );
  }

  // R3 - the declarations, in the expected order.
  const decls = declarations(stripped);
  const titles = decls.map((d) => d.title);
  const matchesExpected =
    titles.length === EXPECTED_ORDER.length &&
    EXPECTED_ORDER.every((prefix, i) => titles[i].startsWith(prefix));
  if (!matchesExpected) {
    findings.push(
      `the walk's declaration order is not the expected one.\n  expected (${EXPECTED_ORDER.length}, ` +
        `by title prefix): ${EXPECTED_ORDER.join(' | ')}\n  found (${titles.length}): ` +
        `${titles.map((t, i) => `${i + 1}. ${t}`).join(' | ')}\n` +
        '  A declaration APPENDED below the last leg never runs once anything above it goes red ' +
        '(`mode: serial`, `retries: 0`), and a REORDER changes what every later leg inherits ' +
        'from the shared board. If a leg genuinely belongs here, add it to EXPECTED_ORDER in ' +
        'this guard at the position it is declared, deliberately, rather than widening the rule.',
    );
  }

  return findings;
}

const RAW = readFileSync(SPEC_PATH, 'utf8');

/**
 * The audit as it is actually reached in anger: raw source in, findings out.
 *
 * Every case below goes through this, mutants included, so the stripper is exercised by
 * the mutations rather than bypassed by them.
 */
const audit = (raw: string): string[] => auditWalkSpec(stripComments(raw));

/** Append a line to the real source BELOW the last leg. The catch case. */
const appendAfterLastLeg = (line: string): string => `${RAW}\n${line}\n`;

describe(`the declaration order of ${SPEC_NAME}`, () => {
  it('strips to something still recognisable, so a green below is a real reading', () => {
    // The tripwire for the stripper itself. If a future edit confuses it the scan goes
    // quiet rather than red, and every assertion after this one becomes worthless.
    const stripped = stripComments(RAW);
    expect(stripped.split('\n').length, 'line count is preserved by stripping').toBe(
      RAW.split('\n').length,
    );
    expect(
      declarations(stripped).length,
      'the walk declares its six legs',
    ).toBeGreaterThanOrEqual(2);
    expect(
      declarations(stripped).length,
      'stripping did not invent declarations the raw line-leading scan cannot see',
    ).toBe((RAW.match(/^[ \t]*test(?:\.(?:only|skip|fixme|fail))?[ \t]*\(/gm) ?? []).length);
  });

  it('is clean AT HEAD: six legs, in order, none silenced, and nothing throwing', () => {
    expect(audit(RAW)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // R3: appended, reordered, deleted.
  // -------------------------------------------------------------------------

  it('REFUSES a bare test appended after the last leg', () => {
    expect(audit(appendAfterLastLeg("test('appended', async () => {});")).join('\n')).toMatch(
      /declaration order is not the expected one/,
    );
  });

  it('REFUSES an INDENTED test appended after the last leg', () => {
    expect(audit(appendAfterLastLeg("    test('appended', async () => {});")).join('\n')).toMatch(
      /declaration order is not the expected one/,
    );
  });

  it('REFUSES all four modifier forms appended after the last leg', () => {
    // WR-07's finding, kept executable: the original grep saw the bare form only, so it
    // caught 1 of these 5 shapes.
    for (const mod of ['only', 'skip', 'fixme', 'fail']) {
      expect(
        audit(appendAfterLastLeg(`test.${mod}('appended', async () => {});`)).join('\n'),
        `test.${mod} after the last leg`,
      ).toMatch(/declaration order is not the expected one|forbidden modifier/);
    }
  });

  it('REFUSES a REORDERED file: two legs swapped', () => {
    // The rule the old guard could not express at all. Legs 1 to 5 share a board, so
    // swapping two of them changes what every leg after the swap inherits - and every
    // one of them would still be present, still unmodified and still declared above the
    // end of the file.
    const swapped = RAW.replace("test('leg 4 -", "test('leg 5 -").replace(
      /test\('leg 5 - saving/,
      "test('leg 4 - saving",
    );
    expect(swapped, 'the substitution landed').not.toBe(RAW);
    expect(audit(swapped).join('\n')).toMatch(/declaration order is not the expected one/);
  });

  it('REFUSES a DELETED leg', () => {
    // The other direction of the same rule: a leg quietly removed leaves five green
    // declarations and a suite that reports nothing wrong.
    const start = RAW.indexOf("  test('leg 4 -");
    const end = RAW.indexOf("  test('leg 5 -");
    expect(start, 'leg 4 was found in the source').toBeGreaterThan(-1);
    expect(end, 'leg 5 was found in the source').toBeGreaterThan(start);
    const withoutLegFour = RAW.slice(0, start) + RAW.slice(end);
    expect(audit(withoutLegFour).join('\n')).toMatch(/declaration order is not the expected one/);
  });

  // -------------------------------------------------------------------------
  // R2: silencing modifiers.
  // -------------------------------------------------------------------------

  it('REFUSES a modifier applied to a leg', () => {
    const skipped = RAW.replace(/^([ \t]*)test\(/m, '$1test.skip(');
    expect(skipped, 'the substitution landed').not.toBe(RAW);
    expect(audit(skipped).join('\n')).toMatch(/forbidden modifier/);
  });

  it('REFUSES a group-scoped skip', () => {
    const grouped = RAW.replace('test.describe(', 'test.describe.skip(');
    expect(grouped, 'the substitution landed').not.toBe(RAW);
    expect(audit(grouped).join('\n')).toMatch(/forbidden modifier/);
  });

  // -------------------------------------------------------------------------
  // R1: serial mode.
  // -------------------------------------------------------------------------

  it('REFUSES the file with serial mode removed', () => {
    const parallel = RAW.replace(/test\.describe\.configure\([^)]*\);/, '');
    expect(parallel, 'the substitution landed').not.toBe(RAW);
    expect(audit(parallel).join('\n')).toMatch(/serial mode is no longer declared/);
  });

  // -------------------------------------------------------------------------
  // R4: the INVERTED rule. This case is the successor to the old guard's
  // `REFUSES a neutered deliberate red`, which rewrote the throw to a void
  // expression and required the audit to report `no longer throws`. That case died
  // with its subject in plan 74-09; this is the same rule pointing the other way.
  // -------------------------------------------------------------------------

  it('REFUSES a deliberate red REINTRODUCED without a ruling', () => {
    const reintroduced = RAW.replace(
      /^([ \t]*)test\('leg 3 completed last:/m,
      "$1test('a new deliberate red', async () => { throw new Error('not walkable'); });\n$1test('leg 3 completed last:",
    );
    expect(reintroduced, 'the substitution landed').not.toBe(RAW);
    expect(audit(reintroduced).join('\n')).toMatch(/an unconditional throw reappeared/);
  });

  it('ACCEPTS a comment mentioning test( written after the last leg', () => {
    // An unanchored pattern also matched the spec's own prose reference, so the guard
    // would have started reporting on a comment. A guard that reddens on documentation
    // gets weakened, not obeyed.
    expect(audit(appendAfterLastLeg('// a later note about test( written in prose'))).toEqual([]);
  });

  it('ACCEPTS a block comment containing a column-0 test( after the last leg', () => {
    expect(audit(`${RAW}\n/*\ntest('only ever discussed', () => {});\n*/\n`)).toEqual([]);
  });

  it('ACCEPTS a comment discussing a throw, so prose about the deleted red stays writable', () => {
    // R4's own version of the same defence. The walk spec's header explains at length
    // what the deleted throw was and why it went; a guard that reddened on that prose
    // would force the explanation out of the file it explains.
    expect(
      audit(appendAfterLastLeg('// the old declaration ran `throw new Error(...)` on purpose')),
    ).toEqual([]);
  });
});
