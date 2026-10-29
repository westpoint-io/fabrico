// kindNames.ts - the ONE shared machine-kind -> display-name map (READ-01, D-10).
//
// A pure `machine_kind byte -> string` map. It is the SINGLE source the Palette
// entry labels, the Alt-hold canvas label chips (MachineLabels), the Legend
// panel rows and the ConfigPanel heading all read from, so the four surfaces can
// never drift apart. The strings are the exact copy contract from 33-UI-SPEC
// ("Copywriting Contract") as amended by 72-UI-SPEC section 2.2.
//
// Names are a pure frontend derivation over the trusted local `NodeView.kind`
// byte - NOT user input, NO render-packet field, NO GridCommand. They render as
// React text children everywhere (never innerHTML), so there is no injection
// surface (threat T-33-XSS).

import {
  KIND_NAMES as SHARED_KIND_NAMES,
  KIND_LEGEND_ORDER as SHARED_KIND_LEGEND_ORDER,
} from '../../shared/kindNames';

/**
 * The kind-name display strings, keyed by the `machine_kind` byte. TEN entries:
 * the eight the 33-UI-SPEC contract named, plus ROUTE (kind 9) and HTTP HANDLER
 * (kind 10), folded in here by plan 72-10 under D-10.
 *
 * # THERE IS NO SECOND NAME TABLE, AND THIS IS THE MAP THAT ABSORBED IT
 * Until 72-10 the endpoint's name lived in a second map beside this one and three
 * readers fell through to it. That map is DELETED, not emptied: a one-entry map
 * whose entry has moved is a third draft of the same trap, and its own docblock
 * had already recorded that its name was wider than its contents and that a stale
 * claim is the kind of sentence a later engineer builds on. Its old name is not
 * written down here even to disown it, for the reason 72-07 recorded on the same
 * discipline: a grep cannot tell a quotation from an assertion, and a grep of this
 * tree for the old symbol must now find nothing. The version history is where a
 * reader chasing the old wording lands.
 *
 * # THE REASON THE SPLIT EXISTED IS ANSWERED, RATHER THAN OVERRULED
 * The split's stated reason was that the Palette, MachineLabels and the Legend all
 * ITERATE this map, so a ninth key would mint an unreviewed Legend row and reopen
 * the Legend row-name equality assertion. That reason is answered by the Legend
 * iterating `KIND_LEGEND_ORDER`, an ORDERED VIEW, not the name table: this map can
 * carry every kind the app can name while the Legend's kind rows are exactly the ones
 * that view lists and a review chose. Since phase 92 (D-03) the view is palette order,
 * eleven kinds with Route, HTTP Handler and Label among them. The Palette does not
 * iterate this map either - `ENTRIES` is a hand-listed array that LOOKS UP names here.
 * MachineLabels reads one key per node. Growing the name table therefore adds no row to
 * any surface, and growing `KIND_LEGEND_ORDER` does.
 *
 * WIRE (kind 8) stays a pure nameless seam (no entry here): it is a transport
 * wire, not a node, and never reaches a name lookup. `MachineLabels` renders its
 * final 'Machine' arm if one ever does, rather than an empty bordered box.
 */
// # THE DEFINITION MOVED TO `shared/kindNames.ts` AT 72-13, AND IT IS STILL ONE TABLE
//
// This is a RE-EXPORT, not a second draft. `shared/` is the GATE-01 values directory:
// dependency-free, product-logic-free, outside `src/`, and therefore importable by the
// ZERO-MOCK live e2e suite, which may not import product source. Plan 72-13 needed the
// live legend spec (`e2e-live/11-machine-labels.spec.ts`) to DERIVE its expected kind
// names from the shipped map instead of walking a hard-coded list of eight that would
// have gone quiet the moment a ninth kind appeared - and a hard-coded list that stops
// covering what it was named for is the same defect class as one that cannot fail.
//
// The extraction follows `shared/geometry.ts` exactly, including its reason: both suites
// asserting against the SAME values strengthens the zero-mock audit rather than coupling
// the suite to product behaviour.
//
// The BYTES over there are literals, because `shared/` may not import
// `src/protocol/kinds.ts`. `kindNames.test.ts` locks those literals against
// `machine_kind` in the same run, so a byte typed wrong there is a red test and not a
// silently renamed machine.
//
// # THE STRINGS THEMSELVES, AND WHY THE TWO NEW ONES READ AS THEY DO
//
// ENDPOINT (kind 9) is the ROUTE: the front door a webhook arrives at (D-09). The name
// changed at 72-10 and the old word is not written here even to disown it. The
// `/endpoint/` segment inside the copyable POST URL is a HOST ROUTE PREFIX (D-12a) and
// is NOT this string, so a rename criterion claiming the word is gone from the app is
// FALSE on a correct build. 72-UI-SPEC 8.5 carries the bounded criterion that is true:
// no palette row, Legend row, config panel heading, Alt-hold chip or tooltip reads the
// old name.
//
// HANDLER (kind 10) is the HTTP Handler: the user's JavaScript a request reaches over a
// wire (D-11). The longer form IS the kind name, not a palette-only disambiguator,
// because 'Handler' alone would collide with the Factory editor's own `Handler (JS)`
// label - which is why 72-10 renamed that one to `Transform (JS)` in the same commit
// rather than closing the drift in one table while opening it in another.
export const KIND_NAMES: Record<number, string> = SHARED_KIND_NAMES;

/**
 * The kind order the Legend panel lists: PALETTE ORDER since phase 92 (D-03, UI-SPEC 1.2), every
 * palette entry that lands on the board, the Wire tool excepted (a link, named in the Legend's
 * Connections group). A shared ordered VIEW over KIND_NAMES so the Legend rows stay stable and
 * testable without re-listing the strings.
 *
 * # WHY IT IS AN ORDERED VIEW, AND WHY IT NOW LISTS ELEVEN
 * This is an ordered view, not a name table (72-UI-SPEC 2.2): growing it mints a Legend kind
 * row, and the Legend's row assertions read it. Until phase 92 it held the eight kinds 33-UI-SPEC
 * reviewed, with Route and HTTP Handler named as Connections rows and Label not named at all.
 * Walk-112 read that as the Legend leaving out things a user places, so phase 92 reviews all
 * eleven as kind rows in the order the Palette shows them; Label is one because a label lands on
 * the board like everything else the palette places.
 */
export const KIND_LEGEND_ORDER: number[] = SHARED_KIND_LEGEND_ORDER;
