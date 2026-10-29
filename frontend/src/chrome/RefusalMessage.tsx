// RefusalMessage.tsx - the one sentence that says WHY a gesture was refused (ERR-01).
//
// Phase 64 exists because a refused gesture was silent: the host answered with a typed
// `CommandError`, the answer died at the transport, and the user saw a board that simply
// did not change. This element is the far end of that path. It renders ONE authored
// sentence per host refusal tag, holds it on a wall clock, and takes itself away.
//
// THE WHERE / WHY SPLIT (64-UI-SPEC, LOCKED). Two channels, and neither ever does the
// other's job. The canvas reject flash (`overlay.ts`, 180ms) says WHERE, fires
// optimistically from the client prediction, and NEVER carries a reason. This message
// says WHY, is verdict-driven, waits for the host, and NEVER carries a location. The
// client does not invent causes.
//
// SECURITY (threat T-64-06-01, the `STATUS_COPY` / T-32-06-01 rule applied to a new
// surface): only the authored sentences below, one per tag, can reach the accessibility tree. The
// wire carries a FIELDLESS tag and an integer sequence number, and the lookup is a
// closed `Record` with no interpolation, so no filesystem path, node handle, internal
// index or host `Display` string has any way to ride along. `CommandError`'s own
// `Display` impl is developer-facing and is never rendered.

import { useLayoutEffect, useRef, type JSX } from 'react';
import type { RefusalTag } from '../transport/transport';
import { WarningIcon } from './icons';

/**
 * How long one refusal sentence holds before it takes itself away.
 *
 * DELIBERATELY NOT AN ALIAS of `App.tsx`'s `STATUS_AUTOCLEAR_MS`, which is also 4000
 * today (D-19). Both sit in the same house transient tier right now, and that is a
 * coincidence of tuning rather than a shared rule: the Save/Load readout describes an
 * operation the user started, and this describes a refusal the user may not have
 * expected. Aliasing them would make retuning one silently retune the other.
 */
export const REFUSAL_HOLD_MS = 4000;

/**
 * The user-facing sentence for every host refusal tag (ERR-02).
 *
 * The house copy-table idiom, same shape as `STATUS_COPY` in `controlHandlers.ts`: a
 * `Record` over a CLOSED union, one authored string per key, per-entry notes in place.
 * (The frontend dock-safety gate carried the third table of this shape until 73-08
 * deleted it; the idiom outlived it and this is now one of two.)
 *
 * THERE IS NO DEFAULT ARM AND NO FALLBACK SENTENCE, AND THAT IS THE POINT RATHER THAN
 * AN OVERSIGHT. A generic "something went wrong" line is the silence this phase exists
 * to end, wearing a different coat. Because the table is typed over the closed
 * `RefusalTag` union, a host tag with no entry is a COMPILE error here, not a blank
 * message at a user - which is why a lookup can never miss at runtime.
 *
 * HOUSE VOICE, verified against the corpus rather than asserted: sentence case with
 * terminal periods; "cannot" as ONE word; no apology, no blame, no "please"; a hyphen
 * where prose wants a dash, never the U+2014 em dash or the U+2013 en dash (a project
 * rule on everything shipped, enforced by `RefusalMessage.test.ts`).
 *
 * A RECOVERY CLAUSE THAT NAMES A CONTROL THE APP DOES NOT HAVE IS FORBIDDEN.
 * `PortsSection.tsx` records exactly that mistake having been reverted once already, so
 * state-then-recovery appears ONLY on the rows where a single recovery is true today.
 * `PortOccupied` became such a row in Phase 67 and not one wave earlier - see its entry.
 *
 * WIDTH BUDGET: 50 characters per line, derived from Martian Mono's measured 8px advance
 * at the 12px base size inside the 420px content clamp below. There are exactly TWO
 * deliberate two-line rows, each a COUNTED exception pinned by name at its measured
 * length in `RefusalMessage.test.ts`: `InvalidDock` at 57 (56 before 74.1-10) and, since
 * Phase 67, `PortOccupied` at 54. `InvalidBeltJoin` was the third from plan 74.1-18 to plan
 * 74.1-32, whose reword brought it to 47 and one line. `RotateCoversBelt` and
 * `GrowCoversBelt` at 49 each have a ONE-character margin and are the tightest single-line
 * rows in the table (`FootprintCollision` was the third until plan 89-08's reword brought
 * it to 47) - reword any of them and re-count, or it silently becomes two lines. THE BUDGET
 * IS NEVER RAISED to admit a longer row: 50 is what pins every other tag, and raising it
 * would unpin all of them in a single edit. An over-budget
 * row earns a third counted exception, measured with `python3 len()` and asserted by name.
 */
export const REFUSAL_COPY: Record<RefusalTag, string> = {
  FootprintCollision: 'That space is taken. Clear it or try elsewhere.',
  OutOfBounds: 'That cell is past the edge of the grid.',
  BeltTooLong: 'That belt is too long. Draw it in shorter runs.',
  // True in BOTH directions, which matters: this tag is returned by the Dock path AND
  // the DrawWire path. "Belt" is the Palette tool label and "Wire" is a Legend row, so
  // both words are shipped vocabulary rather than invented for this table.
  MediumMismatch: 'Belts and wires use different ports.',
  // Names the exact rule the tag guards rather than restating the refusal: the roles run
  // Out -> In, AND the belt end sits on the tile right next to the port (its doorstep).
  // Whichever half failed, the sentence names the thing that was not met.
  //
  // 74.1 gap closure (review WR-03): this ended in a clause requiring the belt and port to
  // face each other. Since 74.1 (D-02) the host accepts a belt that TURNS at the doorstep,
  // so a facing clause is a rule the host no longer applies and would send the user to fix
  // the wrong thing. 57 characters, still the deliberate two-line row.
  //
  // SINCE PLAN 74.1-18 THIS ROW ANSWERS A MACHINE TARGET ONLY. A refused BELT-TO-BELT join
  // returns one of the belt-join tags below (`InvalidBeltJoin`, since plan 74.1-24
  // `BeltJoinTurnsBack` and `BeltEndsApart`, since plan 74.1-32 `BeltEndTaken` for an end
  // that is already joined) and reads a belt sentence (gap N4c:
  // this sentence, shown for a join, was called an error that explains nothing, because a
  // belt end has no output or input to be next to). This sentence is unchanged and still true of every
  // machine-target refusal. `refusal_copy_truth.rs` drives the real host
  // through an accepted turning dock and both refusals and fails if this sentence ever
  // claims facing again or stops naming output, input and next-to.
  InvalidDock: 'A belt runs from an output to an input, right next to it.',
  // THE RECOVERY CLAUSE IS RESTORED (Phase 67, plan 67-06), verbatim as this comment
  // pre-wrote it, because the control it names now exists: plan 67-02 shipped the
  // per-row `Disconnect` button on every docked port (`PortsSection.tsx`
  // DISCONNECT_LABEL). Before that it would have named a control the panel did not
  // have, which the table docblock above forbids outright.
  //
  // DELIBERATELY OVER THE 50-CHARACTER BUDGET, at a MEASURED 54, and pinned by name as
  // the SECOND counted exception in `RefusalMessage.test.ts` beside `InvalidDock`'s 57.
  // Do not "fix" it by shortening: `That output is already connected. Disconnect first.`
  // measures 51, so it is over the budget too AND drops the pre-written clause. There is
  // no wording that both fits 50 and keeps the clause. Do not raise the budget either -
  // that would unpin the other fifteen tags in one edit (67-BASELINE.md `## Measured
  // copy`, where all three numbers were taken with `python3 len()`).
  //
  // SINCE PLAN 74.1-32 THIS ROW ANSWERS A MACHINE OUTPUT, A WIRE, `DrawWire` AND
  // `RemovePort`. A dock whose taken source is a drawn belt's END returns `BeltEndTaken` and
  // reads its own sentence (the last row), because the walk read this one for a belt end
  // the user dragged (the third re-walk's HEAD-WORDS).
  PortOccupied: 'That output is already connected. Disconnect it first.',
  // REWORDED BY PLAN 88-02 (phase 88, D-03). "That machine is no longer there." shipped here
  // until then and is false of a gone LABEL or BELT, both of which a handle can name: a
  // Configure on a deleted label, a Disconnect on a belt the board no longer holds, and from
  // plan 88-04 any edit whose node the board-generation resolver finds gone. "That" points at
  // what the user picked without naming its kind. 31 characters (`python3 len()`), one line.
  UnknownNode: 'That is no longer on the board.',
  BeltNotPlaceable: 'A belt is drawn, not placed. Use the Belt tool.',
  // REACHABLE SINCE PLAN 68-02, AND THE RE-VERIFY INSTRUCTION THAT STOOD HERE IS
  // DISCHARGED - the sentence below did not have to move, and did not. The instruction
  // asked, on the day a per-belt speed control shipped, whether the word "speed" still
  // read correctly against THAT CONTROL'S OWN LABEL AND DIRECTION, because the refused
  // wire field is an INTERVAL (`ticks_per_slot`; higher is SLOWER) and a control in the
  // interval's own direction would make a zero the FASTEST setting and this sentence
  // backwards.
  //
  // THE READING THAT ANSWERS IT: the control phase 68 ships is labelled `Pace (px/sec)`
  // and valued in px/sec - a SPEED, in which higher is FASTER (`BeltConfigBody.tsx`,
  // `PACE_PX_PER_SEC_AT_ONE_TICK`). So a typed zero is a STOPPED belt and `A belt needs
  // a speed above zero.` reads correctly. The interval the instruction warned about
  // never reaches the user in any form: it is a wire field the px/sec -> ticks
  // conversion owns, and `68-UI-SPEC.md` 5.2 is where the totality of that conversion
  // is stated. A typed 0, a negative, an empty field or a non-numeric one all resolve
  // to `ticks_per_slot: 0` and land HERE; a pace outside the offered scale lands on
  // `PaceOutOfRange` instead, whose sentence is true of ITS cause and false of this one.
  ZeroBeltInterval: 'A belt needs a speed above zero.',
  UnknownKind: 'That machine kind is not available.',
  // NARROWED BY PLAN 88-02 (phase 88, FAIL-09, WINDOWS 81, D-11) to the one cause its words
  // name: a frame the host could not READ. The arms, each driven by
  // `refusal_copy_truth.rs::the_malformed_sentence_is_true_of_every_frame_the_host_cannot_read`:
  // `transport_ws.rs` `decode_gesture` (a frame over `MAX_GESTURE_FRAME`, an empty frame, a
  // run-pace frame over `MAX_RUN_PACE_BELTS` or cut short, bytes that are not a `GridCommand`),
  // and a run-pace list with no belt in it (`input_apply.rs` `apply_run_pace`, the headless
  // `set_belt_run_pace`), a frame that carries nothing to apply.
  //
  // FROM 2026-08-22 TO PLAN 88-02 THIS ROW READ "The host could not carry out that gesture.",
  // which names no cause, because this one tag was returned both for a frame the host could
  // not read and for frames it read perfectly and could not carry out (a port index past the
  // list, an option byte naming nothing, a routing table or label past a bound, a path that
  // is not an address, an edit on the wrong kind, an inverse that no longer fits the board).
  // A weaker true sentence was the trade until the tag was split; it is split now, every one
  // of those causes has its own row below with a sentence naming it, and this row says the
  // one thing true of what is left. 37 characters (`python3 len()`), one line.
  Malformed: 'The host could not read that gesture.',
  // States the WHOLE endpoint rule the variant guards, the `InvalidDock` treatment
  // applied to its sibling: whichever half failed, the sentence names the thing that
  // was not met. The variant has FOUR arms (`command.rs` DrawWire, steps 2-4) and only
  // one of them is the self-loop - the other three fire between DISTINCT machines:
  // a source port that is not `Role::Out`, a target port that is not `Role::In`, and a
  // port index naming no declared port. `draw_wire.rs` pins all four.
  // "A wire cannot connect a machine to itself." shipped here until 2026-08-22 and is
  // false for three of the four. It was chosen off `error.rs`'s docblock, which still
  // said "currently: a self-loop" long after Phase 63 widened the code; that docblock
  // is corrected now, so the next reader is not misled the same way.
  IncompatiblePorts: 'A wire connects two machines, output to input.',
  // Making the two history rows SILENT was considered and rejected. This phase exists
  // because refusals were silent, and a one-entry exception is how that comes back. A
  // held Ctrl+Z is already handled by the same-tag no-re-announce rule in `App.tsx`.
  NothingToUndo: 'Nothing left to undo.',
  NothingToRedo: 'Nothing left to redo.',
  // The 18th tag, and the widening `error.rs` names as the mechanism for exactly this
  // case (`68-UI-SPEC.md` 5.4). It names `Belt pace` VERBATIM - the control on screen,
  // three lines above the refusal, printing its own bounds - which is the "point the
  // reader at a control this panel actually has" discipline, and the reason neither
  // `ZeroBeltInterval` (says "above zero", false for someone who typed 500) nor
  // `Malformed` (names no cause by design) could carry it.
  //
  // IT STATES NO NUMERAL, deliberately. A figure here would be a SECOND source of truth
  // for a bound the panel already displays, and the phase's own FINDING 1 is a worked
  // example of what a restated figure costs: the px/sec narration was carried from an
  // assumed 60 t/s and was wrong by 4.17% until it was derived from the one place the
  // cadence lives.
  //
  // 41 characters (`python3 len()`), INSIDE the 50-character budget, so it earns NO
  // counted exception: the exception list stays at exactly two (`InvalidDock` 57,
  // `PortOccupied` 54) and the budget is not raised.
  //
  // DRIVEN BY THE REAL ENGINE, not asserted against itself:
  // `crates/fabrico-host/tests/refusal_copy_truth.rs` produces this refusal through the
  // live command layer and checks the sentence against what came back.
  PaceOutOfRange: 'That pace is outside the Belt pace scale.',
  RouteEmpty: 'That belt has no path.',
  RouteNonAdjacent: 'A belt path moves one cell at a time.',
  RouteSelfCrossing: 'A belt path cannot cross itself.',
  // The 19th tag (plan 72-07, SERVE-08). It exists rather than joining `Malformed`
  // because it is the ONE path rule that can name a specific other object, and "another
  // Route already answers there" is not a statement about malformed input at all.
  //
  // IT NAMES `Route` VERBATIM - the machine on the board, whose config card is open in
  // front of the reader - which is the same "point the reader at something this panel
  // actually has" discipline `PaceOutOfRange` follows by naming `Belt pace`.
  //
  // IT NAMES NO PATH AND NO OWNER, deliberately. The tag is payload-free by the
  // taxonomy's `Copy` discipline, so neither the offending path nor the owning Route's
  // position rides the wire; a sentence that promised either would be promising
  // something this surface cannot deliver. Naming the owner is the CONFIG PANEL's job
  // (D-13), where the board is in reach.
  //
  // 42 characters, INSIDE the 50-character budget, so it earns NO counted exception:
  // the exception list stays at exactly two (`InvalidDock` 57, `PortOccupied` 54).
  //
  // WORDING CORRECTED AT 72-10 to `72-UI-SPEC.md` 8.1's row, which is the approved
  // contract and which plan 72-07 (landing the tag three waves early to keep the
  // cross-language lock green) did not match. Same meaning, same length class, and
  // it buys a real property: the panel's own duplicate row reads `That path is
  // already used by the Route at (14,6).`, so the tag and the panel row are now ONE
  // sentence with and without the name. The user who bypasses the panel gate and
  // the user who meets it read the same words about the same thing, which is what
  // makes the tag-carries-authority / panel-carries-name split (D-13) legible
  // rather than merely correct.
  DuplicatePath: 'That path is already used by another Route.',
  // The 20th tag (plan 74.1-18, review WR-03). The ruling of 2026-10-04 on a Router
  // with a belt on its first output, verbatim: "Refuse, say why". The host's Rotate arm
  // returns it when the FIRST cell of the turned box that another node owns is a belt
  // tile; a machine there keeps `FootprintCollision`. So the sentence says what is in the
  // way (a belt, not "that space") and the one fix that is true today.
  //
  // IT NAMES NO CONTROL BEYOND "MOVE THAT BELT", deliberately. Moving a belt is a thing
  // the user can do with what the app has (select it, delete it, draw it again elsewhere,
  // or drag its end), and the sentence does not name a button, a menu or a cell it cannot
  // promise. The canvas flash says WHICH belt (the WHERE/WHY split above); "that belt"
  // points at it rather than at a location this payload-free tag cannot carry.
  //
  // 49 characters (`python3 len()`), INSIDE the 50-character budget with a one-character
  // margin, so it earns NO counted exception. `refusal_copy_truth.rs` drives the real
  // Rotate arm on catalog port 1 and fails if this sentence stops naming the turn, the
  // belt and the move, or starts claiming a port or a space.
  RotateCoversBelt: 'Turning would cover a belt. Move that belt first.',
  // The 21st tag (plan 74.1-18). The host's AddPort arm returns it when the FIRST cell of
  // the box the add would grow into (the fold's own geometry, plan 74.1-16) belongs to a
  // belt; a machine there keeps `FootprintCollision`. The reachable case is the demo
  // Factory's fourth output, whose taller box would cover its fault belt's first tile, the
  // case the J10 note under `+ Add output` describes. The `RotateCoversBelt` shape with the
  // verb that is true here: the user pressed `+ Add output`, and what moves is the box.
  //
  // "Move that belt first" names no control beyond moving the belt, for the reason the
  // row above gives. 49 characters (`python3 len()`), inside the budget at a
  // one-character margin, so no counted exception. `refusal_copy_truth.rs` drives the real
  // arm on a Factory with a fault belt at rot 0 and rot 1.
  GrowCoversBelt: 'Growing would cover a belt. Move that belt first.',
  // The 22nd tag (plan 74.1-18, gap N4c), REWORDED by plan 74.1-24 (gap J11) and again by
  // plan 74.1-32 (the third re-walk's J11-THIRD). The refusals of a belt-to-belt join that
  // carry no cause of their own: the role rule (a belt's last tile feeds another belt's
  // first tile, never last to last or first to first), a one-tile target with no direction,
  // and a belt's end onto its own inner tile. It names the belt's own words (end, start) and
  // never output or input, which a belt end does not have.
  //
  // WHY IT SAYS WHAT TO DO. The role arm is the only arm a hand reaches (a one-tile belt
  // offers no end to drag, and a drag excludes the dragged belt's own ends), and there the
  // ends DO touch and nothing turns back. The 74.1-24 sentence ("A belt's end joins only a
  // belt starting right next to it, never turning back.") explained that refusal through
  // the one word "starting"; this one names the fix. A default the maintainer can
  // overturn: a reword of this tag rather than a new one, for the reason just given.
  //
  // DOUBLE-QUOTED because the sentence carries an apostrophe; `refusal_copy_truth.rs`'s row
  // parser accepts either quote, and grades the role arm (whole-word `end`, `start`, no
  // adjacency or turning claim) and the other two arms on their tag alone.
  //
  // 47 characters (`python3 len()`), INSIDE the 50-character budget, so it is no longer a
  // counted exception (it was the third, at 77). One line, measured in the shipped face by
  // `e2e/gesture-verdict.spec.ts`.
  InvalidBeltJoin: "Join a belt's end to the start of another belt.",
  // The 23rd tag (plan 74.1-24, gap J11). The U-turn: the host's Dock arm returns it from
  // the narrowed facing term when both ends are belts, two side-by-side belts running
  // opposite ways with one's end beside the other's start, in either drag direction. The
  // walk read the one rule sentence as APPROVING this join ("side by side" is what the user
  // just did), so the cause the host already knows is carried to the user. It names the
  // join and turning back, never output, input, port or machine. 40 characters
  // (`python3 len()`), inside the 50-character budget. `refusal_copy_truth.rs` drives the
  // real arm both ways.
  BeltJoinTurnsBack: 'A join cannot turn back the way it came.',
  // The 24th tag (plan 74.1-24, gap J11). Belt ends that do not touch: the host's Dock arm
  // returns it when the dragged end is not one orthogonal step from the other belt's end
  // (two or more cells away, or a diagonal neighbour). The re-walk's N4E board. The fix is
  // plain from the words: bring the ends together. 24 characters (`python3 len()`).
  // `refusal_copy_truth.rs` drives two apart and the diagonal, both directions.
  BeltEndsApart: 'These ends do not touch.',
  // The 25th tag (plan 74.1-32, the third re-walk's FINDING HEAD-WORDS). The host's Dock arm
  // returns it where the taken source is a drawn belt's END: a dragged belt end that already
  // feeds something (its Head dock), and a belt's first tile dropped on a belt end that
  // already feeds something (its Tail dock). The walk read "That output is already
  // connected." for a belt end the user dragged; the user handled a belt, not an output.
  // `PortOccupied` keeps machine outputs and wires.
  //
  // A default the maintainer can overturn: ONE sentence for both arms, because
  // either way the user is told the end is taken and what to do instead. "Use a free end."
  // names no control the app lacks: drawing a belt or dragging another end is all it asks.
  // 48 characters (`python3 len()`), inside the 50-character budget, so no counted
  // exception. `refusal_copy_truth.rs` drives both arms on the real host and fails if this
  // sentence stops naming a belt end that is joined or ever says output, input or port.
  BeltEndTaken: 'That belt end is already joined. Use a free end.',
  // The 26th tag (plan 76-02, phase 76 D-04, 76-UI-SPEC 6.2). A size change whose new box
  // would cover a cell another node holds: first produced by a label grown over a machine,
  // a belt or another label. "something" is exact, because the covered thing may be any of
  // the three and this table cannot interpolate; "Go smaller." is always true, because the
  // committed size fits by definition, and stays true when the machine resize in
  // SEED-261004-vfw reuses the tag. 44 characters (`python3 len()`), one line.
  ResizeCovers: 'That size would cover something. Go smaller.',
  // The 27th tag (plan 76-04, phase 76 D-07, 76-UI-SPEC 6.2). A Dock, DrawWire or AddPort
  // naming a label, refused by the host before any port or geometry check. A NEW tag
  // because every existing sentence is false of a label: the dock and wire sentences
  // describe ports it does not have, and "could not carry out" says the host failed at a
  // refusal it makes by design. No gesture reaches it (a label has no nub), so the user
  // meets it only through forged input; "notes" is what a label is, and "do not connect"
  // is true of all five shapes `refusal_copy_truth.rs` drives. 38 characters
  // (`python3 len()`), one line.
  LabelDoesNotConnect: 'Labels are notes. They do not connect.',
  // The 28th tag (plan 86-06, phase 86 D-04, WORK-02). An Undo whose restore would land on
  // cells another node now holds: the host's Delete-undo arm checks the box and every
  // re-drawn belt tile on the board the undo group leaves, and refuses before anything is
  // placed. A NEW tag because `FootprintCollision`'s "Clear it or try elsewhere." is false
  // of an Undo: the user placed nothing and does not choose where a restore lands. "now"
  // says the cell was free when the step was taken; "Nothing was undone." is what the user
  // needs to know, and true, because the refusal enqueues nothing and the step stays on top
  // of the stack. Staying on top does not make it undoable later (phase 86 review, WR-01):
  // clearing the space is itself a step above it, which the next Ctrl+Z takes back, so the
  // refused step and every step before it stay out of reach and nothing on the board changes.
  // No ordinary gesture reaches it (linear undo takes back anything placed after a Delete
  // first), so the user meets it only through a forged or hand-edited file.
  // True of the machine leg and the belt leg alike. 44 characters (`python3 len()`), one
  // line. `refusal_copy_truth.rs` drives the real arm.
  UndoSpaceTaken: 'That space is taken now. Nothing was undone.',
  // The 29th tag (plan 88-02, phase 88, FAIL-09, WINDOWS 81, D-11), split out of `Malformed`.
  // A frame that names a port the machine does not have: a `RemovePort` index past the port
  // list (`command.rs` RemovePort arm) and a Router rule or default naming an output past the
  // live Out ports (`command.rs` Configure arm). Both frames are read perfectly. "That port"
  // points at the one the gesture named; "not on the machine" is true of both arms.
  // 32 characters (`python3 len()`). `refusal_copy_truth.rs` drives both arms
  // (`the_no_such_port_sentence_is_true_of_every_arm_that_produces_it`).
  NoSuchPort: 'That port is not on the machine.',
  // The 30th tag (plan 88-02, WINDOWS 81), split out of `Malformed`. An option byte that names
  // no option the app has: an `AddPort` role or medium byte (`command.rs` AddPort arm) and a
  // label colour byte (`command.rs` `wire_config_to_core`). No shipped control sends one, so
  // the user meets it only through forged input. It names neither a port nor a colour because
  // either word is false of one of the arms. 38 characters (`python3 len()`).
  // `the_unknown_option_sentence_is_true_of_every_arm_that_produces_it` drives all three.
  UnknownOption: 'That choice is not one the app offers.',
  // The 31st tag (plan 88-02, WINDOWS 81), split out of `Malformed`. A setting past a bound
  // the app sets: a Router table over `MAX_ROUTES` rules or a pattern over
  // `MAX_ROUTE_EXPECT_BYTES`, label text over `MAX_LABEL_BYTES`, a label size outside its
  // range (`command.rs` Configure arm). It states no number: each bound has its one home and
  // the panel that edits it already shows it. 42 characters (`python3 len()`).
  // `the_over_limit_sentence_is_true_of_every_arm_that_produces_it` drives five arms.
  OverLimit: 'That is outside the limits the app allows.',
  // The 32nd tag (plan 88-02, WINDOWS 81), split out of `Malformed`. A Route path that is not
  // a legal address: R-47's rules 1 to 3 (`command.rs` Configure arm,
  // `edit::endpoint_path_is_valid`). Rule 4, a path another Route owns, keeps `DuplicatePath`.
  // It names the path, the one thing every arm judged. 41 characters
  // (`python3 len()`). `the_invalid_path_sentence_is_true_of_every_arm_that_produces_it`.
  InvalidPath: 'That is not a web path the app can serve.',
  // The 33rd tag (plan 88-02, WINDOWS 81), split out of `Malformed`. An edit aimed at a node of
  // the wrong kind for it: a Rotate on a label and a label setting on a machine (`command.rs`
  // Rotate and Configure arms). No shipped control sends either. 44 characters
  // (`python3 len()`). `the_wrong_kind_sentence_is_true_of_every_arm_that_produces_it`.
  WrongKind: 'That edit does not apply to what you picked.',
  // The 34th tag (plan 88-02, WINDOWS 81), split out of `Malformed`. A Ctrl+Z or Ctrl+Y whose
  // recorded inverse no longer fits the board: every structural refusal of `compute_inverse`
  // (`command.rs`), reached through a forged, damaged or older history. "That step" is the
  // undo step the user asked for; it says nothing of a taken cell, which keeps
  // `UndoSpaceTaken`. 35 characters (`python3 len()`).
  // `the_undo_does_not_fit_sentence_is_true_of_every_arm_that_produces_it` drives three arms,
  // and `frontend/e2e-live/88-refusal-sentences.live.spec.ts` leg 4 reads it on a forged `.fab`.
  UndoDoesNotFit: 'That step no longer fits the board.',
  // The 35th tag (plan 88-02, WINDOWS 83), split out of `OutOfBounds`. An output add whose box
  // would pass the 64-cell size limit (`command.rs` AddPort arm, the dimension cap). Until plan
  // 88-02 a machine in the middle of the grid read "That cell is past the edge of the grid."
  // here, false of every one of its cells. 44 characters (`python3 len()`).
  // `the_machine_too_big_sentence_is_true_of_every_arm_that_produces_it`, and live leg 1.
  MachineTooBig: 'That machine would grow past the size limit.',
  // The 36th tag (plan 88-02, WINDOWS 84), split out of `FootprintCollision`. A turn whose box
  // would cover another machine or a label (`command.rs` Rotate arm; a belt keeps
  // `RotateCoversBelt`). `FootprintCollision`'s "try elsewhere" is false of a turn, which
  // keeps its anchor; "Clear the space first." is the fix true of a machine and a label alike.
  // 39 characters (`python3 len()`). `the_rotate_blocked_sentence_is_true_of_every_arm_that_produces_it`.
  RotateBlocked: 'No room to turn. Clear the space first.',
  // The 37th tag (plan 88-02, WINDOWS 84), split out of `FootprintCollision`. An output add
  // whose grown box would cover another machine or a label (`command.rs` AddPort arm; a belt
  // keeps `GrowCoversBelt`). The `RotateBlocked` shape with the verb true here. 39 characters
  // (`python3 len()`). `the_grow_blocked_sentence_is_true_of_every_arm_that_produces_it`.
  GrowBlocked: 'No room to grow. Clear the space first.',
  // The 38th tag (plan 88-02 adds it, D-03; plan 88-04's board-generation resolver produces
  // it). An edit made against a board that changed before it landed (an Undo, Redo or load
  // re-minted the handles): the host refuses it rather than apply it to a different node.
  // "That edit was not made." is what the user needs to know. 48 characters (`python3 len()`).
  // Its truth test drives the real resolver in plan 88-04.
  BoardChanged: 'The board changed first. That edit was not made.',
};

/**
 * The closed set of refusals the CLIENT words itself (plan 75-07, D-12; plan 89-09, D-14). Two
 * tags: `BeltOnlyPort` (a Wire-tool press on a belt-only port forms no command) and `DockNotSent`
 * (a follow-up Dock a drawn belt was owed was never sent, so no command exists to refuse).
 *
 * Deliberately NOT a member of the host `RefusalTag` union. That union is the host's: every
 * member is a `CommandError` variant a verdict can carry, and `RefusalMessage.test.ts` pins
 * one table entry per host tag. A client tag in it would claim the host can say something it
 * cannot.
 */
export type ClientRefusalTag = 'BeltOnlyPort' | 'DockNotSent';

/**
 * The sentences the client authors, for the one place plan 66-09's rule allows it: "emit
 * wherever a command can be formed; the client authors a message only where no command
 * exists to refuse." D-12 (2026-10-06) decided that a Wire-tool press on a port that
 * only takes belts forms no command, so the press itself is answered here.
 *
 * Same shape and same rules as `REFUSAL_COPY`: a `Record` over a closed union, no default arm,
 * no interpolation, the house voice and the 50-character budget, all enforced over this table
 * too by `RefusalMessage.test.ts`. It reaches the band through the same single slot, hold and
 * live region (`App.tsx` `showClientRefusal`), and a host verdict arriving after it replaces it.
 *
 * `BeltOnlyPort` is 33 characters by `python3 len()`, one line. NO RECOVERY CLAUSE: `Use the
 * Belt tool.` is false when that port is already linked (the Belt tool then gets
 * `PortOccupied`), and the table forbids a recovery that is not always true. The sentence is
 * locked to the host verdict: the client fires it only where `mediumsCompatible(port.medium,
 * MEDIUM_ELECTRICAL)` is false, and `fabrico-command/tests/draw_wire.rs` proves the host
 * refuses a `DrawWire` on every such catalog port, as source and as target.
 */
export const CLIENT_REFUSAL_COPY: Record<ClientRefusalTag, string> = {
  BeltOnlyPort: 'That port takes belts, not wires.',
  // Phase 89, plan 89-09 (D-14, WINDOWS 254, UI-SPEC 6.4, A6, A7): a belt the user drew landed,
  // but a Dock it was owed was never sent (its target could not be named again after the board
  // changed, its DrawBelt's verdict was lost, or the accept named no belt). No command exists for
  // the host to refuse, so the client says it, from each `gestures.ts` drop site that still owed a
  // Dock and from no other. 40 characters by `python3 len()`. NO RECOVERY CLAUSE: connecting by
  // hand is not always possible when the target is gone. No flash: it arrives ticks after the
  // release and has no reliable cell.
  DockNotSent: 'A belt you drew is missing a connection.',
};

/** A screen rectangle in CSS px (client coordinates). */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RefusalMessageProps {
  /**
   * The sentence currently held, or `null` when nothing is showing. Always a value
   * looked up from `REFUSAL_COPY` or `CLIENT_REFUSAL_COPY` - never a host string, never
   * free client prose.
   */
  message: string | null;
  /**
   * The screen box of the cell the reject flash named for this sentence, or null (phase 89
   * UI review UI-02). When the band would sit over it, the band moves down to just below it,
   * so the WHERE (the flash) is never hidden by the WHY (this sentence).
   */
  avoid?: ScreenRect | null;
  /**
   * Any value that changes when a top-right panel (the inspector, Help) shows, hides or is
   * replaced (phase 91 UI review item 7). The band is laid out again on a change, so a sentence
   * already showing moves out from under a panel that opens while it holds.
   */
  dodgeKey?: string;
}

/** The narrowest room left of a top-right panel the band moves into. Below it the band keeps its
 *  centred place: a box this narrow would wrap a sentence onto more lines than it reads well in. */
export const BAND_DODGE_MIN_PX = 200;

/** The top-right panels the band keeps clear of: the inspector and Help (UI review item 7). */
const TOP_RIGHT_PANELS = 'aside[aria-labelledby="fab-config-heading"], #fab-help-panel';

/** The band's shipped top (see the wrapper's `top` below for why it is this expression). */
const BAND_TOP =
  'calc(var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl) + var(--fab-font-size-base) + 3 * var(--fab-space-xs) + 2px)';

/** The gap the band keeps below a flashed cell it steps off, in CSS px (`--fab-space-sm`). */
export const BAND_AVOID_GAP_PX = 8;

/**
 * Where the band's top goes so it does not cover `avoid` (UI-02): null when the band, as laid
 * out at its shipped top, does not overlap the box, else the y just below the box plus the gap.
 * Pure, so the rule is unit-tested apart from layout.
 */
export function bandTopAvoiding(band: ScreenRect, avoid: ScreenRect | null | undefined, gap = BAND_AVOID_GAP_PX): number | null {
  if (!avoid) return null;
  const overlaps = band.left < avoid.right && avoid.left < band.right && band.top < avoid.bottom && avoid.top < band.bottom;
  return overlaps ? avoid.bottom + gap : null;
}

/**
 * The refusal surface: an always-mounted polite live region wrapping a box that exists
 * only while a sentence does.
 *
 * WHY THE OUTER NODE IS ALWAYS MOUNTED. It is the `StatusReadout.tsx` rule verbatim: a
 * live region that mounts TOGETHER WITH its content is unreliably announced, because
 * assistive tech has to observe the region before the mutation lands inside it. So the
 * region is present from the moment the app is ready and renders nothing when idle - a
 * zero-size positioned box that paints not one pixel.
 *
 * WHY THE RING IS ON THE INNER NODE. If the `.fab-panel` fill and bezel sat on the
 * always-mounted node, an empty bezel box would hang permanently at the top of the
 * screen. The treatment belongs to the node that exists only while a message does.
 */
export function RefusalMessage({ message, avoid = null, dodgeKey = '' }: RefusalMessageProps): JSX.Element {
  const regionRef = useRef<HTMLDivElement | null>(null);
  // UI-02: lay the band out at its shipped top, measure it, and if it covers the flashed cell,
  // move it to just below that cell. Written on the node before paint, so it never flickers;
  // reset on every sentence and every new flash box, so a band moved once does not stay moved.
  //
  // THE BAND KEEPS CLEAR OF A SHOWING TOP-RIGHT PANEL (phase 91 UI review item 7). The inspector
  // and Help dock at 116 on the right, under the band's centred place, so a refusal with a machine
  // selected covered the inspector's heading for the 4 s it held. When the centred box meets one,
  // it is centred instead in the room between the palette and the leftmost showing panel, one
  // `--fab-space-sm` gutter each side, as the status strip is, and its width is capped to that
  // room (the sentence wraps, never truncates). Then the flash rule above applies to where it is.
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (region === null) return;
    region.style.top = BAND_TOP;
    region.style.left = '50%';
    const box = region.firstElementChild as HTMLElement | null;
    if (message === null || box === null) return;
    box.style.maxWidth = '420px';
    let r = box.getBoundingClientRect();
    const panels = [...document.querySelectorAll<HTMLElement>(TOP_RIGHT_PANELS)]
      .filter((el) => el.offsetWidth > 0)
      .map((el) => el.getBoundingClientRect());
    const meets = (p: DOMRect): boolean => r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom;
    if (panels.some(meets)) {
      const cs = getComputedStyle(box);
      const gutter = Number.parseFloat(cs.getPropertyValue('--fab-space-sm')) || 0;
      const palette = document.querySelector<HTMLElement>('[data-fab-left-dock]');
      const freeLeft = (palette !== null && palette.offsetWidth > 0 ? palette.getBoundingClientRect().right : 0) + gutter;
      const freeRight = Math.min(...panels.map((p) => p.left)) - gutter;
      const room = freeRight - freeLeft;
      if (room >= BAND_DODGE_MIN_PX) {
        const chrome = Number.parseFloat(cs.paddingLeft) + Number.parseFloat(cs.paddingRight);
        box.style.maxWidth = `${Math.min(420, Math.floor(room - chrome))}px`;
        region.style.left = `${(freeLeft + freeRight) / 2}px`;
        r = box.getBoundingClientRect();
      }
    }
    const top = bandTopAvoiding({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, avoid);
    if (top !== null) region.style.top = `${top}px`;
  }, [message, avoid, dodgeKey]);
  return (
    <div
      ref={regionRef}
      id="fab-refusal"
      // POLITE, never `role="alert"`. The repo's own written rule reserves the alert
      // tier for errors that INTERRUPT. A refused gesture destroyed nothing, lost no
      // data and diverged no state, so interrupting would be disproportionate.
      //
      // NO `role` AT ALL, and that is measured rather than assumed: a div with
      // `aria-live` and no role adds +0 to `getByRole('status')` and +0 to
      // `getByRole('alert')`, which is what protects the six page-wide bare status
      // locators and the eight alert-count-zero assertions already shipped.
      //
      // NO `aria-relevant`: the default is `additions text`, and adding `removals`
      // would make a screen reader announce the auto-dismiss, which is pure noise.
      //
      // NO `tabIndex`: this surface adds zero tabstops and never moves focus.
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: 'fixed',
        // CORRECTED IN PLACE BY PLAN 74.1-31. This read "The WelcomeCard anchor
        // expression VERBATIM, as a token expression rather than a resolved pixel value,
        // so a spacing-scale change moves both surfaces together." It is that expression
        // PLUS ONE STATUS-STRIP LINE: the toolbar's status readout and Unsaved badge
        // moved out of the button row into a strip hanging under the toolbar (from
        // `100% + --fab-space-xs`, one line of the base size with an xs padding above and
        // below and the badge's 1px border twice), which this band sat on top of. Still
        // tokens, so a spacing-scale change moves the surfaces together.
        top: BAND_TOP,
        left: '50%',
        transform: 'translateX(-50%)',
        // A bare integer with its tally in place - there is no z token in the system and
        // the stylesheet carries exactly one z-index. The inline tally under
        // `src/chrome/*.tsx`, RE-MEASURED at plan 68-07: 0 x1, 1 x3, 2 x8, 3 x3, 4 x0,
        // plus this site at 5, the load-refusal card at 6 (plan 73-04's
        // `LoadRefusedCard.tsx`, one rung above this band because a load refusal
        // outranks a gesture refusal: it is the one the user must acknowledge) and the
        // dialog scrim at 1000. TWO corrections against what
        // this comment said before: rung 3 was written as x4 and has always measured x3,
        // and rung 4 is now EMPTY because plan 68-07 deleted the development pace panel
        // that was its only occupant (BELT-05 / D-68-12).
        //
        // THE VALUE IS DELIBERATELY NOT MOVED DOWN TO 4. Nothing reads it relatively -
        // the only constraint that ever mattered is "above every panel rung and below
        // the scrim, because a modal always wins" - and 5 satisfies that whether or not
        // 4 is occupied. Sliding it down would be churn with no user-visible effect and
        // would require rewriting this comment again to say so.
        zIndex: 5,
        // Never eat a canvas gesture. Set on BOTH nodes.
        pointerEvents: 'none',
      }}
    >
      {/* This node is where the transform for a future re-anchor lands: `translateX`
          above is already a transform on the wrapper, so re-homing the message to the
          gesture later is a change to ONE style object plus a projection feeding it a
          second translate term. Nothing else in this contract depends on the anchor
          staying fixed. */}
      {message !== null && (
        <div
          // The REGISTERED bezel class, never a hand-rolled inline ring. The stylesheet
          // walker in `chromeCss.test.ts` derives the set of ring carriers from the
          // parsed CSS and asserts set equality, so an inline ring here would be an
          // unregistered carrier the gate cannot see. Reusing the class keeps that set
          // at 5 and keeps the gate meaningful.
          className="fab-panel"
          // A `div`, NEVER an `aside`, for two independent reasons and both must hold.
          // FIRST: every existing `aside` in this tree is a labelled landmark, and a
          // second `complementary` appearing for four seconds at a time would trip the
          // landmark-uniqueness rule. SECOND: the boot-fit camera reads
          // `document.querySelector('aside.fab-panel')` to measure its left inset, and
          // that selector is TYPE-qualified - a div matches neither it nor the
          // `header.fab-panel` sibling, so this element cannot silently mis-frame the
          // boot camera.
          style={{
            display: 'flex',
            // NOT `center`. The worst-case sentence wraps to two lines, and centring
            // would float the glyph against the block's midpoint instead of sitting it
            // on the first line where it reads as a prefix.
            alignItems: 'flex-start',
            gap: 'var(--fab-space-xs)',
            // The ring-inclusive padding expression the other inline panels carry: the
            // bezel reserves no space of its own, so the ring band is paid for here.
            padding: 'calc(var(--fab-space-md) + var(--fab-bezel-ring))',
            // A CONTENT width (there is no box-sizing reset in this tree, so panels are
            // content-box). 420 is the same content width the ConfigPanel uses, so this
            // box is never wider than the widest panel in the app.
            //
            // WHAT ACTUALLY CONSTRAINS THIS BOX, measured in `e2e/gesture-verdict.spec.ts`
            // rather than reasoned about. There are TWO constraints and only one of them
            // is written here:
            //   - This 420px cap is the one that binds on a normal desktop window. Delete
            //     the declaration and the same sentence renders a 496px border box at a
            //     992px viewport instead of 464 - the cap is removing 32px and forcing the
            //     two-line wrap.
            //   - Below roughly a 928px viewport the CONTAINING BLOCK is tighter and takes
            //     over. The wrapper above is `position: fixed; left: 50%`, so its
            //     containing block runs from the viewport midpoint to the right edge: the
            //     border box can never exceed HALF the viewport width. That crosses under
            //     464px (this box's border width) at 928px, and it is what keeps a narrow
            //     window from pushing the centred box off either edge. Measured at a 400px
            //     viewport the box is 200px, which is half of 400 and nothing to do with
            //     any `maxWidth` value.
            // THIS USED TO READ `min(420px, calc(100vw - 2 * var(--fab-space-lg)))`. The
            // viewport half was unreachable - half the viewport is tighter than
            // `100vw - 48px` at every width above 96px - so it was dead at every width the
            // app supports. Measured both ways at 992px and at 400px, the rendered box was
            // identical to the pixel. It was dropped at the 64-11 checkpoint on
            // 2026-08-22; 64-UI-SPEC carries the amended locked value and the same reason.
            // Whatever replaces this cap must keep the 420.
            //
            // Wrapping is REQUIRED and truncation is FORBIDDEN. `whiteSpace` stays at
            // its default so the text wraps freely; an ellipsised refusal reason is the
            // failure this phase exists to end, in a quieter form. No scrolling property
            // is declared here at all - this element has nothing to scroll, and the
            // stylesheet gate forbids a scroll container on any ring carrier.
            // (Since phase 91 UI review item 7 the layout effect above may lower this cap to the
            // room left of a showing top-right panel, and puts it back to 420 on every layout.)
            maxWidth: '420px',
            pointerEvents: 'none',
          }}
        >
          {/* BARE, with no size prop in literal or named form. The default is already
              the 16px chrome rung and the destructive tone, and both ways of passing it
              redden the icon ladder gate: a literal trips the no-numeric-literal rule,
              and naming the ladder constant trips the who-binds-it-by-name control.

              The glyph is DECORATIVE and REDUNDANT - `aria-hidden` at source, and the
              sentence beside it carries the whole information content. That is what
              makes its 2.92:1 destructive-on-panel-fill contrast legal: it is a tone
              cue, never the only signal. */}
          <WarningIcon />
          <span
            style={{
              // `.fab-panel` sets `line-height: 1`, which is right for a single-run
              // label and wrong for a sentence that may wrap. 1.4 gives the second line
              // room without changing the single-line box height beyond the ascent.
              lineHeight: 1.4,
              // The INK token unconditionally, NOT the conditional destructive treatment
              // the ConfigPanel error row uses. Measured on the panel fill: destructive
              // is 2.92:1 and fails AA for text, ink is 5.157:1 and passes. The tone
              // lives entirely in the glyph.
              color: 'var(--fab-ink)',
            }}
          >
            {message}
          </span>
        </div>
      )}
    </div>
  );
}
