import { describe, expect, it } from 'vitest';
import { machine_kind } from '../protocol/kinds';
import * as kindNames from './kindNames';
import { KIND_NAMES, KIND_LEGEND_ORDER } from './kindNames';

// kindNames.test.ts (READ-01, D-10) — the single-source guard for the machine-kind
// display names. Asserts KIND_NAMES covers every kind the app can NAME and matches
// the exact copy contract, so Palette / MachineLabels / Legend / ConfigPanel cannot
// drift and a future rename that breaks the copy contract fails here loudly.

// The exact copy contract: 33-UI-SPEC ("Copywriting Contract") for the original
// eight, as amended by 72-UI-SPEC section 2.2 for kinds 9 and 10. Duplicated here
// on purpose: this is the falsifiable reference the map is gated against (never
// imported from the map it validates).
//
// SINCE 72-13 IT IS ALSO THE BYTE LOCK OVER `shared/kindNames.ts`. The definition moved
// to the GATE-01 values directory so the ZERO-MOCK live suite can import it, and
// `shared/` may not import `src/protocol/kinds.ts` - so the keys over there are BYTE
// LITERALS. This table is keyed by the `machine_kind` CONSTANTS, and the two cases below
// (`names every displayable machine kind, and invents none` plus `matches the exact copy
// contract for every kind`) compare the two in the same run. A byte typed wrong in the
// shared file is therefore a RED TEST here, not a silently renamed machine. That lock is
// what makes the literals safe; do not remove it without moving the definition back.
const COPY_CONTRACT: Record<number, string> = {
  [machine_kind.SOURCE]: 'Source',
  [machine_kind.SINK]: 'Sink',
  [machine_kind.FACTORY]: 'Factory',
  [machine_kind.TEE]: 'Tee',
  [machine_kind.BALANCER]: 'Balancer',
  [machine_kind.ROUTER]: 'Router',
  [machine_kind.MERGE]: 'Merge',
  [machine_kind.BELT]: 'Belt',
  [machine_kind.ENDPOINT]: 'Route',
  [machine_kind.HANDLER]: 'HTTP Handler',
};

// WIRE is the one inert render-protocol seam left (kinds.ts caught up to the Rust
// machine_kind contract in 40-02): a wire is drawn by the dedicated wires.ts layer
// and is a transport seam rather than a node, so it carries no display name.
//
// ENDPOINT LEFT THIS LIST AT 72-10 and that is the whole point of D-10. It was a
// "seam" only because its name lived in a second table; folding the two tables into
// one makes it an ordinary named kind, and HANDLER joined it as another.
const SEAM_KINDS: number[] = [machine_kind.WIRE];
const DISPLAYABLE_KINDS = Object.values(machine_kind).filter((k) => !SEAM_KINDS.includes(k));

describe('KIND_NAMES — the single source of machine-kind display names (READ-01, D-10)', () => {
  // WAS: "covers all 8 machine kinds", with `Object.keys(KIND_NAMES).length` pinned
  // to 8 and an explicit NOT_YET_DISPLAYABLE_KINDS carve-out for HANDLER. The INTENT
  // is unchanged and is the reason the number moved: the map must name EVERY kind a
  // surface can meet, with no kind quietly left out and no extra key invented. That
  // set is now ten, because 72-10 folded the endpoint's separate name table in here
  // (D-10) and named the HTTP Handler (D-11). The count is still derived from
  // `machine_kind` minus the seams rather than typed as a literal, so the next kind
  // byte cannot be added without this failing.
  // Phase 76 (SHAPE-10) moved both pins 10 to 11: LABEL is kind 11 and is named
  // 'Label', exactly as that sentence promised the next byte would have to be.
  it('names every displayable machine kind, and invents none', () => {
    expect(DISPLAYABLE_KINDS.length, 'machine_kind defines exactly 11 displayable kinds').toBe(11);
    for (const kind of DISPLAYABLE_KINDS) {
      expect(KIND_NAMES[kind], `KIND_NAMES has an entry for kind ${kind}`).toBeTypeOf('string');
      expect(KIND_NAMES[kind].length, `KIND_NAMES[${kind}] is non-empty`).toBeGreaterThan(0);
    }
    expect(Object.keys(KIND_NAMES).length, 'KIND_NAMES has no extra entries (11 with Label)').toBe(11);
  });

  // WAS: "the HANDLER exception is DORMANT: kind 10 has no display name yet (closes at
  // 72-10)", armed by plan 72-05 to redden the moment a name arrived. It has now
  // FIRED, in the plan named as its closer, so it is retired rather than deleted: the
  // exception list it guarded is gone from the top of this file, and this case is the
  // record that it was retired by the closer rather than by someone who found it in
  // the way. The assertion is inverted, not dropped, so the retirement itself is
  // checkable: HANDLER is named, and it is named in the ONE map.
  it('the HANDLER exception is RETIRED: kind 10 is named here, from the one map (72-10)', () => {
    expect(
      KIND_NAMES[machine_kind.HANDLER],
      'HANDLER is a placeable machine with a palette row, so it carries a display name',
    ).toBe('HTTP Handler');
    // Since phase 92 (D-03) the Legend's ordered VIEW lists it as a kind row too, in palette
    // order. See the KIND_LEGEND_ORDER block below.
    expect(KIND_LEGEND_ORDER).toContain(machine_kind.HANDLER);
  });

  // WAS: the LEGIBLE-01 "named-but-not-placeable seam" block, which asserted that a
  // SECOND map resolved the endpoint's old name and that ENDPOINT was kept OUT of
  // KIND_NAMES with the map pinned at exactly 8. The INTENT was that ONE
  // string serves the Legend row, the panel heading and the Alt-hold chip. D-10
  // keeps that intent and answers it the other way round: there is now ONE map, so
  // the single-source property holds by construction instead of by a fall-through.
  //
  // THIS IS THE ASSERTION THAT THE FOLD ACTUALLY LANDED. A module-namespace import
  // is used deliberately: a named import of a deleted symbol is a TypeScript error
  // that never reaches vitest, so it could not state this as a runtime fact.
  it('there is exactly ONE name map: no second table survives this module', () => {
    const exported = Object.keys(kindNames).sort();
    expect(
      exported,
      'kindNames.ts exports the name map and its ordered legend view, and nothing else. ' +
        'A second exported Record<number, string> is the two-table drift D-10 closed',
    ).toEqual(['KIND_LEGEND_ORDER', 'KIND_NAMES']);
  });

  it('resolves the ROUTE name for kind 9 from that one map (D-09, D-10)', () => {
    expect(KIND_NAMES[machine_kind.ENDPOINT]).toBe('Route');
  });

  it('has NO entry for machine_kind.WIRE (a wire stays a pure nameless seam)', () => {
    expect(KIND_NAMES[machine_kind.WIRE]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(KIND_NAMES, machine_kind.WIRE)).toBe(false);
  });

  it('matches the exact copy contract for every kind', () => {
    for (const [kind, name] of Object.entries(COPY_CONTRACT)) {
      expect(KIND_NAMES[Number(kind)], `kind ${kind} display name`).toBe(name);
    }
  });

  it('no name reads "Endpoint" any more (72-UI-SPEC 8.5, scoped to authored names)', () => {
    // The bounded rename criterion, at the one surface this file owns. It is NOT a
    // claim that the word is gone from the app: the `/endpoint/` segment inside the
    // copyable POST URL is a HOST ROUTE PREFIX and stays (D-12a). A global claim is
    // the shape that cannot go red - a reviewer meets it, sees the URL, and reads
    // past the whole criterion.
    for (const name of Object.values(KIND_NAMES)) {
      expect(name.includes('Endpoint'), `"${name}" does not read Endpoint`).toBe(false);
    }
  });

  it('contains no em dash in any name (project copy rule)', () => {
    for (const name of Object.values(KIND_NAMES)) {
      expect(name.includes('—'), `"${name}" has no em dash`).toBe(false);
    }
  });
});

// KIND_LEGEND_ORDER is an ordered VIEW, not a name table (72-UI-SPEC 2.2): the Legend iterates
// THIS, so the name map can carry a name the Legend does not list. Until phase 92 the view was the
// eight kinds 33-UI-SPEC reviewed, and Route and HTTP Handler were Connections rows; walk-112 read
// that as the Legend leaving them out, and Label (kind 11) had no row at all. Phase 92 (D-03, UI-SPEC
// 1.2) makes the view PALETTE ORDER: every palette entry that lands on the board, Wire excepted (it
// is a Connections row, a link rather than a node).
describe('KIND_LEGEND_ORDER: the Legend kind rows, in palette order (phase 92, D-03)', () => {
  it('lists every palette entry that lands on the board, in palette order, each named', () => {
    expect(KIND_LEGEND_ORDER, 'the Legend kind rows read in palette order (UI-SPEC 1.2)').toEqual([
      machine_kind.SOURCE,
      machine_kind.SINK,
      machine_kind.FACTORY,
      machine_kind.TEE,
      machine_kind.BALANCER,
      machine_kind.MERGE,
      machine_kind.ENDPOINT,
      machine_kind.HANDLER,
      machine_kind.ROUTER,
      machine_kind.BELT,
      machine_kind.LABEL,
    ]);
    expect(KIND_LEGEND_ORDER.length).toBe(11);
    for (const kind of KIND_LEGEND_ORDER) {
      expect(KIND_NAMES[kind], `legend kind ${kind} resolves a name`).toBeTypeOf('string');
    }
  });

  it('lists each of its kinds exactly once', () => {
    expect(new Set(KIND_LEGEND_ORDER).size).toBe(KIND_LEGEND_ORDER.length);
  });

  it('names exactly the kinds KIND_NAMES names: the view may not name a kind the map does not', () => {
    // A legend row for a kind with no name would render an empty row. Since phase 92 the two sets
    // are equal: every named kind is a palette entry with a Legend row.
    const named = new Set(Object.keys(KIND_NAMES).map(Number));
    for (const kind of KIND_LEGEND_ORDER) expect(named.has(kind), `kind ${kind}`).toBe(true);
    expect(new Set(KIND_LEGEND_ORDER)).toEqual(named);
  });

  it('lists ROUTE, HTTP HANDLER and LABEL as kind rows, and never the nameless WIRE', () => {
    expect(KIND_LEGEND_ORDER).toContain(machine_kind.ENDPOINT);
    expect(KIND_LEGEND_ORDER).toContain(machine_kind.HANDLER);
    expect(KIND_LEGEND_ORDER).toContain(machine_kind.LABEL);
    expect(KIND_LEGEND_ORDER).not.toContain(machine_kind.WIRE);
  });
});
