//! Phase 64 gap-closure - the REFUSAL COPY TRUTH lock.
//!
//! # What this file is for, and why the frontend's own test is not it
//! `frontend/src/chrome/RefusalMessage.test.ts` pins every one of the 17 sentences to a
//! literal transcribed from `64-UI-SPEC.md`. That catches a reword. It cannot catch the
//! defect this file exists for, because a literal pin only asks "is the string the
//! string we wrote down" - never "is the string TRUE of the engine that produces it".
//! Both defects fixed on 2026-08-22 were shipped with that test fully green:
//!
//! - `IncompatiblePorts` read "A wire cannot connect a machine to itself." The
//!   `validate_normalize` `DrawWire` arm returns it for FOUR situations and three of
//!   them are between DISTINCT machines. The sentence was picked off `error.rs`'s
//!   docblock, which still said "currently: a self-loop" long after Phase 63 widened
//!   the code.
//! - `Malformed` read "The host could not read that gesture." The host also returns it
//!   for gestures it read perfectly and cannot carry out - most reachably a plain
//!   Ctrl+Z after save-then-load, which is structurally present on every `.fab` load
//!   (`undo_on_demo_board.rs::post_load_undo_of_a_pre_save_remove_port`, WINDOWS row 1).
//!
//! So this file asserts the copy against the ENGINE. Each test drives the real
//! `GridSession` / the real `decode_gesture` to produce the refusal, then reads the
//! sentence the user would see out of `RefusalMessage.tsx` and asserts it does not
//! claim something the exercised arm proves false. It fails on the pre-fix strings.
//!
//! # Why it lives in fabrico-host
//! This is the only crate that can see all three halves at once: `fabrico-command` (the
//! arms), `transport_ws::decode_gesture` (the other producer of `Malformed`), and - via
//! `include_str!` - the frontend source. `command_error_view.rs` already carries the
//! sibling cross-language lock on the tag SET; this one locks the tag MEANINGS.
//!
//! Run target: `cargo test -p fabrico-host --test refusal_copy_truth`

use fabrico_command::{CommandError, GridSession};
use fabrico_core::ids::NodeId;
use fabrico_core::state::{Medium, Role};
use fabrico_host::sim_loop::GestureFrame;
use fabrico_host::transport_ws::{GESTURE_FRAME_VERSION, MAX_GESTURE_FRAME, decode_gesture, frame_gesture};
use fabrico_protocol::GridCommand;

/// Frame a gesture BODY as the client does since phase 88 (a two-varint header, generation 0
/// and gesture 1, then the body) and read it back through the real `decode_gesture`, the one
/// decoder both transports call. Every decode in this file goes through here, so each case
/// still reads the body it was written for.
fn decode_body(body: &[u8]) -> Result<GestureFrame, CommandError> {
    decode_gesture(&frame_gesture(0, 1, body))
        .map(|d| d.frame)
        .map_err(|e| e.error)
}

const SEED: u64 = 0x0064_0F00_C0FF_EE00;

/// Port indices an electrical `place_router_preset` seeds: index 0 is the `In`, indices
/// 1..=`fabrico_command::ROUTER_OUT_ARITY` are its `Out` ports, and since plan 85-05
/// (D-22) the last index is its Mechanical `Fault`. The three named here are unchanged
/// by plan 65-05's arity widening and by 85-05's Fault, because both APPEND.
/// (The `draw_wire.rs` module doc explains why a preset router is the only route the
/// command layer has to an `Electrical` port.)
const IN_PORT: u16 = 0;
const OUT_PORT: u16 = 1;
const SECOND_OUT_PORT: u16 = 2;

// ---------------------------------------------------------------------------
// The frontend copy table, parsed out of the shipped TSX.
// ---------------------------------------------------------------------------

/// `RefusalMessage.tsx` embedded at COMPILE time - a moved or renamed file is a compile
/// error in this crate, never a test that quietly stops finding anything to check. The
/// same `include_str!` discipline `command_error_view.rs` uses for `transport.ts`.
const REFUSAL_MESSAGE_TSX: &str = include_str!("../../../frontend/src/chrome/RefusalMessage.tsx");

/// The TypeScript declaration this file parses, named so a failure can quote the exact
/// anchor that went missing.
const COPY_ANCHOR: &str = "export const REFUSAL_COPY: Record<RefusalTag, string> = {";

/// The sentence `REFUSAL_COPY` maps `tag` to, as the user would read it.
///
/// PANICS on a missing anchor, a missing terminator, or a tag with no row. A lookup
/// that returned `None` and let the caller skip would make every assertion below pass
/// vacuously, which is the failure mode this whole file exists to end.
fn shipped_sentence(tag: &str) -> String {
    let start = REFUSAL_MESSAGE_TSX.find(COPY_ANCHOR).unwrap_or_else(|| {
        panic!(
            "frontend/src/chrome/RefusalMessage.tsx no longer declares {COPY_ANCHOR:?} - the \
             copy-truth lock cannot see the sentences and must not pass silently"
        )
    });
    let body = &REFUSAL_MESSAGE_TSX[start + COPY_ANCHOR.len()..];
    let end = body
        .find("\n};")
        .unwrap_or_else(|| panic!("the REFUSAL_COPY object in RefusalMessage.tsx is not terminated by a line `}};`"));
    // A row is single-quoted, or DOUBLE-quoted when its sentence carries an apostrophe
    // (`InvalidBeltJoin` since plan 74.1-24). Neither form escapes anything inside.
    for q in ['\'', '"'] {
        let prefix = format!("{tag}: {q}");
        let suffix = format!("{q},");
        for line in body[..end].lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix(&prefix)
                && let Some(sentence) = rest.strip_suffix(suffix.as_str())
            {
                assert!(
                    !sentence.contains('\\'),
                    "REFUSAL_COPY.{tag} carries a backslash escape this parser would read literally: {sentence:?}",
                );
                return sentence.to_string();
            }
        }
    }
    panic!("REFUSAL_COPY has no row for {tag:?} - the tag was renamed or the row deleted");
}

/// Assert `sentence` makes none of the claims in `forbidden` (matched case-insensitively
/// on whole substrings). `why` is quoted in the failure so a future reader gets the
/// engine reason, not just a red line.
fn assert_claims_none(tag: &str, sentence: &str, forbidden: &[&str], why: &str) {
    let lower = sentence.to_lowercase();
    for claim in forbidden {
        assert!(
            !lower.contains(&claim.to_lowercase()),
            "REFUSAL_COPY.{tag} is {sentence:?}, which claims {claim:?}. {why}",
        );
    }
}

// ---------------------------------------------------------------------------
// Engine helpers.
// ---------------------------------------------------------------------------

/// Place an electrical preset Router at `(x, y)` and return its minted `NodeId`.
fn router(session: &mut GridSession, x: i32, y: i32) -> NodeId {
    session
        .place_router_preset(Medium::Electrical, x, y)
        .expect("an electrical router preset places on a free cell");
    session
        .core()
        .state
        .occupied((x, y))
        .expect("the preset router occupies its anchor cell")
}

/// The dense render handle a `GridCommand` targets.
fn handle(session: &GridSession, id: NodeId) -> u64 {
    session.view().handle_of(id).expect("live node has a handle")
}

/// How many `Role::Out` ports `id` declares RIGHT NOW, counted off the live node.
///
/// PANICS on a node with no port list. A count that quietly answered `0` for a missing
/// node would make the caller's "one past the end" key `0`, which is the FIRST VALID key
/// on any router: the command layer would ACCEPT it and the test would prove nothing.
/// That is the vacuous-pass shape this whole file exists to end.
fn live_out_count(session: &GridSession, id: NodeId) -> u16 {
    let ports = session
        .core()
        .state
        .ports_of(id)
        .expect("the preset router declares a port list - a missing one makes this test vacuous");
    let outs = ports.iter().filter(|p| p.role == Role::Out).count();
    assert!(
        outs > 0,
        "the preset router declares at least one Role::Out port - with none, every key \
         is out of range and the test could not tell a bound from a blanket refusal"
    );
    u16::try_from(outs).expect("an Out count fits a PortId")
}

/// Apply `cmd` and return the refusal, failing loudly if the engine ACCEPTED it - an
/// accepted command proves nothing about a refusal sentence.
fn refusal(session: &mut GridSession, cmd: GridCommand) -> CommandError {
    match session.apply(cmd) {
        Err(e) => e,
        Ok(_) => panic!("the engine ACCEPTED a command this test needs it to refuse"),
    }
}

// ---------------------------------------------------------------------------
// IncompatiblePorts - the sentence must be true of all four arms, not just the loop.
// ---------------------------------------------------------------------------

/// The engine returns `IncompatiblePorts` for THREE situations between two DISTINCT
/// machines, so the sentence the user reads may not say the refusal is about connecting
/// a machine to itself.
///
/// MUTATION: restore `A wire cannot connect a machine to itself.` in
/// `RefusalMessage.tsx` and this reddens on "itself", quoting all three distinct-machine
/// refusals it just proved.
#[test]
fn the_incompatible_ports_sentence_is_not_scoped_to_a_self_loop() {
    let mut session = GridSession::new(SEED);
    let a = router(&mut session, 0, 0);
    let b = router(&mut session, 10, 10);
    let (ha, hb) = (handle(&session, a), handle(&session, b));

    // Arm: a source port that is not `Role::Out`. TWO machines.
    let wire = |from_port: u16, to_port: u16| GridCommand::DrawWire {
        from_node: ha,
        from_port,
        to_node: hb,
        to_port,
    };
    assert_eq!(
        refusal(&mut session, wire(IN_PORT, IN_PORT)),
        CommandError::IncompatiblePorts,
        "a non-Out source port between two DISTINCT machines is IncompatiblePorts",
    );
    // Arm: a target port that is not `Role::In`. TWO machines.
    assert_eq!(
        refusal(&mut session, wire(OUT_PORT, SECOND_OUT_PORT)),
        CommandError::IncompatiblePorts,
        "a non-In target port between two DISTINCT machines is IncompatiblePorts",
    );
    // Arm: a port index naming no declared port. TWO machines.
    assert_eq!(
        refusal(&mut session, wire(99, IN_PORT)),
        CommandError::IncompatiblePorts,
        "an out-of-range port index between two DISTINCT machines is IncompatiblePorts",
    );
    // Arm: the self-loop. ONE machine - the only arm the old sentence described.
    assert_eq!(
        refusal(
            &mut session,
            GridCommand::DrawWire {
                from_node: ha,
                from_port: OUT_PORT,
                to_node: ha,
                to_port: IN_PORT,
            }
        ),
        CommandError::IncompatiblePorts,
        "a self-loop is IncompatiblePorts too - it is ONE of four arms, not the variant",
    );

    let sentence = shipped_sentence("IncompatiblePorts");
    assert_claims_none(
        "IncompatiblePorts",
        &sentence,
        &["itself", "same machine", "one machine"],
        "Three of this variant's four arms were just refused BETWEEN TWO DISTINCT \
         MACHINES (non-Out source, non-In target, out-of-range port index), so a \
         sentence scoping the refusal to a self-loop is false for three quarters of \
         what it covers. State the whole endpoint rule instead, the way InvalidDock \
         does.",
    );
}

// ---------------------------------------------------------------------------
// Malformed (narrowed by plan 88-02, FAIL-09, D-11) - frames the host cannot read.
// ---------------------------------------------------------------------------

/// Since plan 88-02 `Malformed` is returned only for a frame the host could not READ: every
/// `decode_gesture` failure arm, and a run-pace list that carries no belt to apply (the
/// headless `set_belt_run_pace`, the host's `apply_run_pace` twin, same tag, same reason).
/// The read-but-cannot-do causes it used to share have tags of their own (the nine tests at
/// the end of this file), so the sentence may say what is true of every arm here: the host
/// could not read the gesture. It may claim nothing about the board, a port, a limit or a
/// path, none of which any arm here consults.
///
/// MUTATION: restore `The host could not carry out that gesture.` in `RefusalMessage.tsx`
/// and this reddens on "carry out" (a sentence that says the host understood the gesture and
/// failed at it, which no arm here did); write a board sentence and it reddens on "board".
#[test]
fn the_malformed_sentence_is_true_of_every_frame_the_host_cannot_read() {
    use fabrico_host::sim_loop::{BELT_RUN_PACE_LEAD, MAX_RUN_PACE_BELTS};

    // Arm 1: over `MAX_GESTURE_FRAME`.
    let oversized = vec![0u8; MAX_GESTURE_FRAME + 1];
    assert_eq!(decode_body(&oversized), Err(CommandError::Malformed), "an oversized frame");
    // Arm 2: an empty body, no byte 0 to read.
    assert_eq!(decode_body(&[]), Err(CommandError::Malformed), "an empty body");
    // Arm 3: bytes that are not a `GridCommand`.
    assert_eq!(decode_body(&[0xFFu8; 32]), Err(CommandError::Malformed), "an undecodable frame");
    // Arm 4: a run-pace frame whose leading varint is absent.
    assert_eq!(
        decode_body(&[BELT_RUN_PACE_LEAD]),
        Err(CommandError::Malformed),
        "a run-pace frame with no body"
    );
    // Arm 5: a run-pace frame declaring more belts than the cap, refused before allocating.
    let mut over = vec![BELT_RUN_PACE_LEAD];
    // LEB128 of MAX_RUN_PACE_BELTS + 1 (257): two bytes.
    let n = MAX_RUN_PACE_BELTS as u64 + 1;
    over.push(u8::try_from((n & 0x7F) | 0x80).expect("a 7-bit group"));
    over.push(u8::try_from(n >> 7).expect("the high group"));
    assert_eq!(decode_body(&over), Err(CommandError::Malformed), "a run-pace frame over the belt cap");
    // Arm 6: a run-pace frame whose body does not decode after a legal count.
    assert_eq!(
        decode_body(&[BELT_RUN_PACE_LEAD, 1]),
        Err(CommandError::Malformed),
        "a run-pace body cut short"
    );
    // Arm 6b (phase 88, D-06; version byte T-88-09): a frame whose HEADER cannot be read,
    // an empty frame, a frame without the version byte (a page on an older wire) or a
    // generation varint cut short. Refused with the same tag, and naming no gesture id.
    for (bytes, what) in [
        (&[][..], "an empty frame"),
        (&[3, 41, 5][..], "a frame without the version byte"),
        (&[GESTURE_FRAME_VERSION, 0x80][..], "a header cut short"),
    ] {
        assert_eq!(
            decode_gesture(bytes).map_err(|e| (e.gesture_id, e.error)),
            Err((None, CommandError::Malformed)),
            "{what}: unreadable, and no gesture id to name"
        );
    }
    // Arm 7: a run-pace list with no belt in it, on the real command layer.
    let mut session = GridSession::new(SEED);
    let before = postcard::to_allocvec(&session.core().state).expect("state serializes");
    assert_eq!(
        session.set_belt_run_pace(&[], 4),
        Err(CommandError::Malformed),
        "an empty run-pace list carries nothing to apply"
    );
    assert_eq!(
        postcard::to_allocvec(&session.core().state).expect("state serializes"),
        before,
        "and changes nothing"
    );

    let sentence = shipped_sentence("Malformed");
    assert_claims_none(
        "Malformed",
        &sentence,
        &["carry out", "board", "fit", "no longer", "port", "limit", "path", "machine", "\u{2014}"],
        "Every arm above refused a frame without consulting the board, a port, a limit or a \
         path, and without understanding a gesture it then failed to perform.",
    );
    assert!(
        sentence.to_lowercase().contains("could not read"),
        "REFUSAL_COPY.Malformed is {sentence:?}, which does not say the one thing true of every \
         arm above: the host could not read the gesture",
    );
}

// ---------------------------------------------------------------------------
// PaceOutOfRange (68-04) - the 18th tag, driven by the engine that produces it.
// ---------------------------------------------------------------------------

/// The sentence a user reads when a pace is refused must be TRUE of the arm that
/// refused it, and the only way to know that is to make the arm refuse.
///
/// This leg exists for the reason stated at the top of this file: the frontend's
/// `RefusalMessage.test.ts` pins this string against a literal transcribed from
/// `68-UI-SPEC.md`, which asks only "is the string the string we wrote down". It cannot
/// ask whether the engine refuses what the sentence says it refuses. A copy row with no
/// engine driver is a sentence nobody can trigger, and that is exactly what the two
/// defects fixed on 2026-08-22 both were.
///
/// FOUR properties, each of which can fail:
///  1. the engine ACTUALLY returns `PaceOutOfRange` for a `Configure{Belt}` outside
///     `2..=20`, reached through the real `decode_gesture` (so the wire half is real too);
///  2. the sentence does not claim ZERO, because the engine refuses 21 and u32::MAX with
///     this tag and a zero with a DIFFERENT one;
///  3. the sentence does not claim the host could not READ the frame, because the same
///     decoder that fails an undecodable frame just read this one perfectly;
///  4. the sentence names `Belt pace`, the control on screen, verbatim - the one clause
///     that makes the refusal actionable rather than merely typed.
#[test]
fn the_pace_out_of_range_sentence_is_true_of_the_arm_that_produces_it() {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::DrawBelt {
            cells: vec![(1, 0), (2, 0)],
        })
        .expect("a clear drawn path is accepted");
    let belt = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("DrawBelt minted the belt this tick");
    let node = handle(&session, belt);

    // Both sides of the bound, so the sentence is checked against a refusal that is
    // TOO FAST and one that is TOO SLOW. A sentence true of only one of them would be
    // the `IncompatiblePorts` defect repeated.
    for pace in [1u32, 21, u32::MAX] {
        let cmd = GridCommand::Configure {
            node,
            config: fabrico_protocol::MachineConfig::Belt {
                ticks_per_slot: pace,
            },
        };
        let frame = postcard::to_allocvec(&cmd).expect("a GridCommand encodes");
        assert_eq!(
            decode_body(&frame),
            Ok(GestureFrame::Cmd(cmd.clone())),
            "the host reads this gesture back EXACTLY - nothing here is unreadable",
        );
        assert_eq!(
            refusal(&mut session, cmd),
            CommandError::PaceOutOfRange,
            "ticks_per_slot {pace} is outside the offered 2..=20 range and is refused \
             with its OWN tag",
        );
    }

    // And a zero is refused by a DIFFERENT arm with a DIFFERENT tag, which is what
    // entitles each sentence to name its own cause.
    assert_eq!(
        refusal(
            &mut session,
            GridCommand::Configure {
                node,
                config: fabrico_protocol::MachineConfig::Belt { ticks_per_slot: 0 },
            },
        ),
        CommandError::ZeroBeltInterval,
        "zero keeps ZeroBeltInterval, so 'above zero' stays true of that tag and only it",
    );

    let sentence = shipped_sentence("PaceOutOfRange");
    assert_claims_none(
        "PaceOutOfRange",
        &sentence,
        &["zero", "above zero", "at least"],
        "The engine just refused 21 and u32::MAX under this tag and refused 0 under a \
         DIFFERENT one. A sentence about zero would be false of every refusal this tag \
         actually carries, and would duplicate the one ZeroBeltInterval owns.",
    );
    assert_claims_none(
        "PaceOutOfRange",
        &sentence,
        &["read", "understand", "decode", "garbled", "malformed"],
        "The same decoder an undecodable frame fails just read this frame back EXACTLY \
         (asserted above). Telling the user the host could not read their gesture is \
         false of this cause - which is precisely why this tag exists rather than \
         joining a fifth cause to Malformed.",
    );
    assert!(
        sentence.contains("Belt pace"),
        "REFUSAL_COPY.PaceOutOfRange is {sentence:?}, which does not name `Belt pace`. \
         The refusal is only actionable because it points at the control on screen, \
         three lines above it, which is already printing its own bounds.",
    );
    assert!(
        !sentence.chars().any(|c| c.is_ascii_digit()),
        "REFUSAL_COPY.PaceOutOfRange is {sentence:?}, which states a NUMERAL. A figure \
         here is a SECOND source of truth for a bound the panel already displays, and \
         this phase's own FINDING 1 is the worked example of what a restated figure \
         costs.",
    );
}

// ---------------------------------------------------------------------------
// DuplicatePath (72-10, SERVE-05 / D-13) - the sentence must be true of the ONE arm
// that produces it, and it must not claim the thing the surface cannot deliver.
// ---------------------------------------------------------------------------

/// Place a Route (kind 9) at `(x, y)` and return its minted `NodeId`.
fn route(session: &mut GridSession, x: i32, y: i32) -> NodeId {
    session
        .apply(GridCommand::Place {
            kind: fabrico_protocol::machine_kind::ENDPOINT,
            cell_x: x,
            cell_y: y,
        })
        .expect("the command layer accepts a Place{ENDPOINT} on a free cell");
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("a Place{ENDPOINT} mints exactly one node")
}

/// The sentence a user reads when a second Route claims a live address must be TRUE of
/// the refusal the engine actually produced, and must promise nothing the surface that
/// renders it cannot deliver.
///
/// # Why this case is not optional, and what the frontend's own test cannot see
/// `RefusalMessage.test.ts` pins this string to a literal transcribed from the UI-SPEC.
/// That catches a reword. It cannot catch the defect this file exists for: a sentence
/// that is exactly what somebody wrote down and is FALSE of the engine that produces
/// it. Plan 72-07 landed the tag and the sentence three waves before anything drove the
/// refusal end to end, precisely so `command_error_view.rs`'s cross-language tag lock
/// would not go red - which means until this case existed, the sentence's TRUTH was the
/// one half of the contract nothing in the workspace was holding.
///
/// # What is asserted, and why each clause is here
/// 1. The engine really returns `DuplicatePath` for this gesture, through the LIVE
///    command layer with no frontend in the loop. Without this the assertions below
///    would be about a refusal nobody proved reachable.
/// 2. The sentence names NO PATH and NO CELL. `REFUSAL_COPY` is a `Record` over a
///    closed union with one authored string per key and no host string ever
///    interpolated, so a sentence promising either would be promising something this
///    surface structurally cannot deliver. Naming the owner is the PANEL's job, where
///    the board is in reach (D-13): the tag carries the AUTHORITY, the panel carries
///    the NAME.
/// 3. The sentence does not claim the path was MALFORMED. This is the discrimination
///    that matters: `/orders` is a perfectly legal address, refused only because
///    another Route already answers at it. A sentence about a bad path would be false
///    of the only cause this tag has, and would duplicate what `Malformed` says.
///
/// MUTATION: point `DuplicatePath` at `Malformed`'s sentence and clause 3 reddens.
#[test]
fn the_duplicate_path_sentence_is_true_of_the_arm_that_produces_it() {
    let mut session = GridSession::new(SEED);
    let a = route(&mut session, 2, 2);
    let b = route(&mut session, 6, 2);
    let (ha, hb) = (handle(&session, a), handle(&session, b));

    // A path that is legal by every one of R-47's other rules: it starts with `/`, it
    // is inside the bound, and every byte is unreserved. The ONLY thing wrong with it
    // is that it is already taken - which is what makes clause 3 below discriminating
    // rather than decorative.
    let taken = "/orders".to_owned();
    session
        .apply(GridCommand::Configure {
            node: ha,
            config: fabrico_protocol::MachineConfig::Endpoint { path: taken.clone() },
        })
        .expect("the FIRST Route may take a free address - otherwise this test is vacuous");

    assert_eq!(
        refusal(
            &mut session,
            GridCommand::Configure {
                node: hb,
                config: fabrico_protocol::MachineConfig::Endpoint { path: taken.clone() },
            },
        ),
        CommandError::DuplicatePath,
        "a second Route claiming a live address is refused under its OWN tag",
    );

    let sentence = shipped_sentence("DuplicatePath");

    // Clause 2. It names no path and no cell.
    assert_claims_none(
        "DuplicatePath",
        &sentence,
        &[&taken, "(", ")"],
        "The tag is payload-free by the taxonomy's `Copy` discipline, so neither the \
         offending path nor the owning Route's cell rides the wire. A sentence naming \
         either would promise what this surface cannot deliver. The PANEL names the \
         owner, from the board it already polls (D-13).",
    );

    // Clause 3. It does not call a legal address a bad one.
    assert_claims_none(
        "DuplicatePath",
        &sentence,
        &[
            "not a valid",
            "invalid",
            "malformed",
            "could not",
            "too long",
            "must start",
        ],
        "The engine just accepted this exact string on the FIRST Route, so it is a legal \
         address by every structural rule. A sentence calling it malformed would be \
         false of the only cause this tag has, and would say what Malformed already \
         says about the causes that ARE structural.",
    );

    // And it says the thing that IS true: the address belongs to some other Route.
    assert!(
        sentence.to_lowercase().contains("route"),
        "REFUSAL_COPY.DuplicatePath is {sentence:?}, which never says the address belongs \
         to another ROUTE. That is the whole content of the refusal, and it is what tells \
         the user the fix is a different path rather than a different spelling.",
    );

    // NON-VACUITY of the whole case: the refusal produced NOTHING. If a refused
    // Configure had written a record, the sentence would be describing a state the
    // board is no longer in.
    assert_eq!(
        refusal(
            &mut session,
            GridCommand::Configure {
                node: hb,
                config: fabrico_protocol::MachineConfig::Endpoint { path: taken },
            },
        ),
        CommandError::DuplicatePath,
        "the refusal is REPEATABLE, which it can only be if the first one wrote nothing",
    );
}

// ---------------------------------------------------------------------------
// InvalidDock (74.1-10, review WR-03) - the sentence must state the dock rule the
// NARROWED host enforces, and no clause the host no longer applies.
// ---------------------------------------------------------------------------

/// Place a FACTORY (3x3; catalog 0: In at (0,1) facing W, 1: Out at (2,1) facing E,
/// 2: Fault at (1,2) facing S) with its anchor at `(x, y)` and return its handle.
fn factory(session: &mut GridSession, x: i32, y: i32) -> u64 {
    session
        .apply(GridCommand::Place {
            kind: fabrico_protocol::machine_kind::FACTORY,
            cell_x: x,
            cell_y: y,
        })
        .expect("a FACTORY places on a free 3x3");
    let id = session
        .core()
        .state
        .occupied((x, y))
        .expect("the factory occupies its anchor cell");
    handle(session, id)
}

/// Draw a belt along `cells` and return its handle.
fn belt(session: &mut GridSession, cells: Vec<(i32, i32)>) -> u64 {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    let id = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("DrawBelt minted the belt this tick");
    handle(session, id)
}

/// The Dock command for `endpoint` of `carrier` onto catalog `port` of `node`.
fn dock(carrier: u64, endpoint: fabrico_protocol::BeltEnd, node: u64, port: u16) -> GridCommand {
    GridCommand::Dock {
        belt: carrier,
        endpoint,
        node,
        port,
    }
}

/// Since phase 74.1 (D-02, CORNER-06) the host accepts a belt that TURNS at a port's
/// doorstep, so "on facing sides" is no longer a requirement it applies. What it still
/// refuses as `InvalidDock` is the ROLE rule (output to input) and the doorstep
/// adjacency (the belt end on the tile right next to the port). The shipped sentence
/// must name those and claim nothing about facing.
///
/// MUTATION (watched): restore `A belt runs from an output to an input, on facing
/// sides.` in `RefusalMessage.tsx` and this reddens on "facing", after the engine has
/// just ACCEPTED two docks that do not face.
#[test]
fn invalid_dock_copy_states_the_rule_the_narrowed_host_enforces() {
    use fabrico_protocol::BeltEnd;

    // ACCEPTED 1: a Tail that turns at a machine Out's doorstep. The Out sits at (2,1)
    // facing E, so its doorstep is (3,1). The belt starts there and turns SOUTH at once,
    // so its Tail's outward side is N: perpendicular to the port, not facing it.
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 0, 0);
    let carrier = belt(&mut session, vec![(3, 1), (3, 2), (3, 3)]);
    session
        .apply(dock(carrier, BeltEnd::Tail, f, 1))
        .expect("a Tail that turns at an Out's doorstep docks: the host applies no facing rule");

    // ACCEPTED 2: the belt-seam shape `belt_seam_tail_turning_at_the_doorstep_is_accepted`
    // pins in fabrico-command. The target's Head ends at (11,10) running E, so its
    // doorstep is (12,10); the carrier starts there and runs NORTH.
    let mut session = GridSession::new(SEED);
    let target = belt(&mut session, vec![(10, 10), (11, 10)]);
    let carrier = belt(&mut session, vec![(12, 10), (12, 9)]);
    session
        .apply(dock(carrier, BeltEnd::Tail, target, 1))
        .expect("a Tail that turns at a belt Head's doorstep joins: no facing rule");

    // REFUSED 1, the role rule: a Head (the delivering end) dropped on an Out. The
    // Head's end tile IS the Out's doorstep, so only the role is wrong.
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 0, 0);
    let carrier = belt(&mut session, vec![(5, 1), (4, 1), (3, 1)]);
    assert_eq!(
        refusal(&mut session, dock(carrier, BeltEnd::Head, f, 1)),
        CommandError::InvalidDock,
        "a Head on an Out is refused on the role rule: a belt runs FROM an output",
    );

    // REFUSED 2, the adjacency rule: a Tail with the right role whose end is two cells
    // from the Out's doorstep (3,1).
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 0, 0);
    let carrier = belt(&mut session, vec![(5, 1), (6, 1)]);
    assert_eq!(
        refusal(&mut session, dock(carrier, BeltEnd::Tail, f, 1)),
        CommandError::InvalidDock,
        "a Tail two cells from the doorstep is refused on adjacency",
    );

    // Since plan 74.1-18 this tag answers a MACHINE target only: a refused belt-to-belt
    // join carries a belt-join tag (`InvalidBeltJoin`, `BeltEndsApart` or
    // `BeltJoinTurnsBack`, each with its own case below). Both refusals above named the Factory, and this proves it was a machine, so
    // the sentence's "output" and "input" are about real machine ports.
    assert!(
        !is_belt(&session, f),
        "the InvalidDock refusals above target a MACHINE; a belt target answers a belt-join tag",
    );

    let sentence = shipped_sentence("InvalidDock");
    assert_claims_none(
        "InvalidDock",
        &sentence,
        &["facing", "faces", "opposite"],
        "The engine just ACCEPTED two docks whose belt turns at the doorstep, so a facing \
         rule is false of the host. A user refused on the role or the distance would be \
         sent to fix a rule that does not exist.",
    );
    let lower = sentence.to_lowercase();
    for (word, why) in [
        ("output", "the role rule: a belt runs from an output"),
        ("input", "the role rule: a belt runs to an input"),
        ("next to", "the adjacency rule: the belt end sits on the tile right next to the port"),
    ] {
        assert!(
            lower.contains(word),
            "REFUSAL_COPY.InvalidDock is {sentence:?}, which does not say {word:?} ({why}). \
             The host refused a dock on that rule just above.",
        );
    }
}

// ---------------------------------------------------------------------------
// RotateCoversBelt (plan 74.1-18, review WR-03) - the "Refuse, say why" rule.
// ---------------------------------------------------------------------------

/// The catalog Router of review WR-03's board: a ROUTER placed at (10,10), a feeder whose
/// Head docks the In (catalog 0, doorstep (9,11)), and a belt (12,11)->(13,11) whose Tail
/// docks catalog port 1, the first Out on the middle row (doorstep (12,11)). Returns
/// `(session, router handle, out-belt handle)`.
fn wr03_router_board() -> (GridSession, u64, u64) {
    use fabrico_protocol::BeltEnd;
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place {
            kind: fabrico_protocol::machine_kind::ROUTER,
            cell_x: 10,
            cell_y: 10,
        })
        .expect("a catalog ROUTER places on a free 2x3");
    let router_id = session.core().state.occupied((10, 10)).expect("the router owns its anchor");
    let r = handle(&session, router_id);
    let feeder = belt(&mut session, vec![(7, 11), (8, 11), (9, 11)]);
    session
        .apply(dock(feeder, BeltEnd::Head, r, 0))
        .expect("the feeder's Head docks the Router's In");
    let out = belt(&mut session, vec![(12, 11), (13, 11)]);
    session
        .apply(dock(out, BeltEnd::Tail, r, 1))
        .expect("the out belt's Tail docks catalog port 1, the first Out");
    (session, r, out)
}

/// The host refuses a Rotate whose turned box would cover a belt as `RotateCoversBelt`,
/// and the sentence must say what the arm proves: a TURN was refused, because a BELT is in
/// the way, and MOVING that belt is the fix. Three clauses, each against the engine:
///
/// 1. Driven both ways on the WR-03 board, the arm returns this tag and changes nothing.
/// 2. The fix the sentence names is TRUE: with the belt deleted (the plainest way to move
///    it), the very same Rotate is accepted. A sentence naming a fix the host would still
///    refuse would send the user round in a circle.
/// 3. It claims no PORT, no SPACE and no PLACEMENT: the arm judges the turned box against
///    a belt tile, never a port rule, and the user placed nothing. The arm returns
///    `FootprintCollision` (whose sentence is about a taken space) when a MACHINE is met
///    first, so this tag is never the answer for a machine in the way.
///
/// MUTATION: point `RotateCoversBelt` at `FootprintCollision`'s sentence and clause 3
/// reddens on "space"; drop "belt" from it and the positive clause reddens.
#[test]
fn the_rotate_covers_belt_sentence_is_true_of_the_arm_that_produces_it() {
    // Clause 1.
    for ccw in [false, true] {
        let (mut session, r, _) = wr03_router_board();
        let before = postcard::to_allocvec(&session.core().state).expect("state serializes");
        assert_eq!(
            refusal(&mut session, GridCommand::Rotate { node: r, ccw }),
            CommandError::RotateCoversBelt,
            "ccw={ccw}: the turned box covers the first Out's belt tile, refused under its own tag",
        );
        assert_eq!(
            postcard::to_allocvec(&session.core().state).expect("state serializes"),
            before,
            "ccw={ccw}: nothing turned and nothing was deleted",
        );
    }

    // Clause 2: the fix the sentence names works.
    let (mut session, r, out) = wr03_router_board();
    session
        .apply(GridCommand::Delete { node: out })
        .expect("deleting the belt in the way is accepted");
    session
        .apply(GridCommand::Rotate { node: r, ccw: false })
        .expect("with that belt moved out of the way the same Rotate is accepted");

    // Clause 3, and the machine discrimination behind it.
    let (mut session, r, _) = wr03_router_board();
    session
        .apply(GridCommand::Place {
            kind: fabrico_protocol::machine_kind::SOURCE,
            cell_x: 12,
            cell_y: 10,
        })
        .expect("a Source places on (12,10), met before the belt in the walk");
    assert_eq!(
        refusal(&mut session, GridCommand::Rotate { node: r, ccw: false }),
        CommandError::RotateBlocked,
        "a MACHINE met first is RotateBlocked (FootprintCollision until plan 88-02), so this \
         sentence never answers for one",
    );

    let sentence = shipped_sentence("RotateCoversBelt");
    assert_claims_none(
        "RotateCoversBelt",
        &sentence,
        &["port", "output", "input", "space", "taken", "place", "machine", "\u{2014}"],
        "The Rotate arm refused because the turned box meets a BELT TILE. No port rule was \
         judged, no placement was made, and a machine in the way gets RotateBlocked.",
    );
    let lower = sentence.to_lowercase();
    for (word, why) in [
        ("turn", "the refused command is a turn"),
        ("belt", "what is in the way is a belt"),
        ("move", "the fix, proved above: with the belt gone the same turn is accepted"),
    ] {
        assert!(
            lower.contains(word),
            "REFUSAL_COPY.RotateCoversBelt is {sentence:?}, which does not say {word:?} ({why}).",
        );
    }
}

/// True when `h` names a live BELT node.
fn is_belt(session: &GridSession, h: u64) -> bool {
    use fabrico_command::GridLookup;
    let id = session
        .view()
        .lookup(session.core())
        .resolve(h)
        .expect("the handle names a live node");
    matches!(session.core().state.node(id), Some(fabrico_core::state::Node::Belt(_)))
}

// ---------------------------------------------------------------------------
// GrowCoversBelt (plan 74.1-18) - an output add whose grown box would cover a belt.
// ---------------------------------------------------------------------------

/// A FACTORY at (20,20) turned `rot` times, grown to three outputs (they fit its 3x3 box),
/// with a belt docked on its Fault: the board of `port_edits_keep_place.rs`'s growth pin.
/// Returns `(session, factory handle, fault-belt handle)`.
fn factory_with_a_fault_belt(rot: u8) -> (GridSession, u64, u64) {
    use fabrico_core::state::{Footprint, port_world, unit_delta};
    use fabrico_protocol::BeltEnd;
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 20, 20);
    for _ in 0..rot {
        session
            .apply(GridCommand::Rotate { node: f, ccw: false })
            .expect("an undocked Factory turns on clear floor");
    }
    for _ in 0..2 {
        session.apply(add_output(f)).expect("the second and third outputs fit the 3x3 box");
    }
    let id = session.core().state.occupied((20, 20)).expect("the Factory owns (20,20)");
    let ports = session.core().state.ports_of(id).expect("the Factory declares ports").to_vec();
    assert_eq!(ports.iter().filter(|p| p.role == Role::Out).count(), 3, "MEASURED: three outputs");
    let fault = ports.iter().position(|p| p.role == Role::Fault).expect("a Factory has a Fault");
    let anchor = session.core().state.cell_of(id).expect("placed");
    let fp = session.core().state.footprint_of(id).unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
    assert_eq!((fp.w, fp.h, fp.rot), (3, 3, rot), "MEASURED: still the 3x3 box, turned {rot}");
    let (cell, side) = port_world(anchor, fp.w, fp.h, fp.rot, &ports[fault]);
    let (dx, dy) = unit_delta(side);
    let door = (cell.0 + dx, cell.1 + dy);
    let fault_belt = belt(&mut session, vec![door, (door.0 + dx, door.1 + dy)]);
    session
        .apply(dock(fault_belt, BeltEnd::Tail, f, u16::try_from(fault).expect("small index")))
        .expect("a Tail on the Fault's doorstep docks");
    (session, f, fault_belt)
}

/// The `+ Add output` gesture's command.
fn add_output(node: u64) -> GridCommand {
    GridCommand::AddPort {
        node,
        role: fabrico_protocol::port_role::OUT,
        side: fabrico_core::state::Side::E as u8,
        medium: fabrico_protocol::port_medium::MECHANICAL,
    }
}

/// `add_output.expected.json`, the frozen `AddPort` verdict table (`fabrico-command`'s
/// `add_output_golden.rs`), embedded at compile time.
const ADD_OUTPUT_TABLE: &str =
    include_str!("../../fabrico-command/tests/fixtures/add_output.expected.json");

/// The table's `belt-then-machine` rows whose frozen verdict is `GrowCoversBelt`.
fn belt_then_machine_refusal_rows() -> Vec<serde_json::Value> {
    let rows: Vec<serde_json::Value> = serde_json::from_str(ADD_OUTPUT_TABLE).expect("the add_output table parses");
    rows.into_iter()
        .filter(|r| r["setup"] == "belt-then-machine" && r["verdict"]["tag"] == "GrowCoversBelt")
        .collect()
}

/// Rebuild one frozen `add_output` row's board through commands, the way its freezer did:
/// a Factory placed at (20,20), turned `rot` times, grown to the board's output count, the
/// row's two belt cells drawn as one stray belt and its machine cell given a Source. The
/// rebuilt Factory's anchor, port count and every listed occupied cell are checked against
/// the row before it is used. Returns `(session, factory handle, belt handle)`.
fn rebuild_belt_then_machine(row: &serde_json::Value) -> (GridSession, u64, u64) {
    let name = row["name"].as_str().expect("a row has a name");
    let rot = row["rot"].as_u64().expect("a row has a rot");
    let outs: usize = row["board"]
        .as_str()
        .and_then(|b| b.strip_prefix("outs"))
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("{name}: an outsN board"));
    let cell = |v: &serde_json::Value| -> (i32, i32) {
        let a = v.as_array().expect("a cell is a pair");
        let n = |i: usize| i32::try_from(a[i].as_i64().expect("an integer")).expect("fits");
        (n(0), n(1))
    };
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 20, 20);
    for _ in 0..rot {
        session.apply(GridCommand::Rotate { node: f, ccw: false }).expect("an undocked Factory turns");
    }
    for _ in 1..outs {
        session.apply(add_output(f)).expect("the board's outputs fit");
    }
    let id = session.core().state.occupied((20, 20)).expect("the Factory owns (20,20)");
    assert_eq!(session.core().state.cell_of(id), Some(cell(&row["anchor"])), "{name}: the anchor matches the row");
    assert_eq!(
        session.core().state.ports_of(id).expect("the Factory declares ports").len(),
        row["ports"].as_array().expect("ports").len(),
        "{name}: the port count matches the row",
    );
    let occupied = row["occupied"].as_array().expect("occupied");
    let belt_cells: Vec<(i32, i32)> =
        occupied.iter().filter(|o| o["owner"] == "belt").map(|o| cell(&o["cell"])).collect();
    let machine_cells: Vec<(i32, i32)> =
        occupied.iter().filter(|o| o["owner"] == "machine").map(|o| cell(&o["cell"])).collect();
    assert_eq!((belt_cells.len(), machine_cells.len()), (2, 1), "{name}: one two-tile belt and one Source");
    let belt_h = belt(&mut session, belt_cells.clone());
    session
        .apply(GridCommand::Place {
            kind: fabrico_protocol::machine_kind::SOURCE,
            cell_x: machine_cells[0].0,
            cell_y: machine_cells[0].1,
        })
        .expect("the strip cell is clear for a Source");
    for c in belt_cells.iter().chain(&machine_cells) {
        let owner = session.core().state.occupied(*c).unwrap_or_else(|| panic!("{name}: {c:?} is occupied"));
        assert_ne!(owner, id, "{name}: {c:?} is not the Factory's own cell");
    }
    (session, f, belt_h)
}

/// The host refuses an output add whose grown box would cover a belt as `GrowCoversBelt`,
/// and the sentence must say what the arm proves: the machine would GROW, a BELT is in the
/// way, and MOVING it is the fix. Driven at rot 0 (the box grows south) and rot 1 (the
/// turn puts that edge at world W, so the box grows west), the two shapes the J10 note's
/// case takes on a Factory turned or not.
///
/// MUTATION: point `GrowCoversBelt` at `RotateCoversBelt`'s sentence and the positive
/// clause reddens on "grow"; at `FootprintCollision`'s and clause 3 reddens on "space".
#[test]
fn the_grow_covers_belt_sentence_is_true_at_rot_0_and_rot_1() {
    for rot in [0u8, 1] {
        // Clause 1: the arm returns the tag and changes nothing.
        let (mut session, f, _) = factory_with_a_fault_belt(rot);
        let before = postcard::to_allocvec(&session.core().state).expect("state serializes");
        assert_eq!(
            refusal(&mut session, add_output(f)),
            CommandError::GrowCoversBelt,
            "rot {rot}: the fourth output's grown box covers the fault belt's first tile",
        );
        assert_eq!(
            postcard::to_allocvec(&session.core().state).expect("state serializes"),
            before,
            "rot {rot}: nothing grew, nothing was released",
        );

        // Clause 2: the fix the sentence names works. With the fault belt deleted, the same
        // add is accepted and the box grows.
        let (mut session, f, fault_belt) = factory_with_a_fault_belt(rot);
        session
            .apply(GridCommand::Delete { node: fault_belt })
            .expect("deleting the belt in the way is accepted");
        session
            .apply(add_output(f))
            .expect("with that belt moved out of the way the same add is accepted");
    }

    // Clause 2, extended to the BELT-THEN-MACHINE rows of `add_output.expected.json` (plan
    // 74.1-24, review round 3): a belt AND a machine on the growth strip, the belt met first
    // in the host's walk. There the fix the sentence names removes THAT refusal and no more:
    // with the belt moved, the next press is refused by the machine as `GrowBlocked`
    // (`FootprintCollision` until plan 88-02).
    // Asserted per row rather than glossed, so "Move that belt first." is checked against
    // the one case where moving it is not the whole fix.
    let rows = belt_then_machine_refusal_rows();
    assert_eq!(rows.len(), 8, "the frozen table carries 8 refused belt-then-machine rows (outs3, outs4 at rot 0..3)");
    for row in &rows {
        let name = row["name"].as_str().expect("a row has a name");
        let (mut session, f, belt_h) = rebuild_belt_then_machine(row);
        assert_eq!(
            refusal(&mut session, add_output(f)),
            CommandError::GrowCoversBelt,
            "{name}: the rebuilt board refuses the add as the frozen row says",
        );
        session.apply(GridCommand::Delete { node: belt_h }).expect("deleting the belt in the way is accepted");
        assert_eq!(
            refusal(&mut session, add_output(f)),
            CommandError::GrowBlocked,
            "{name}: with the belt moved the belt refusal is gone and the MACHINE now refuses the same add",
        );
    }

    // Clause 3, with the machine discrimination behind it: a MACHINE where the box grows is
    // `GrowBlocked` (the space-taken tag until plan 88-02), so this sentence never answers
    // for one.
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 20, 20);
    for _ in 0..2 {
        session.apply(add_output(f)).expect("outputs two and three fit");
    }
    session
        .apply(GridCommand::Place { kind: fabrico_protocol::machine_kind::SOURCE, cell_x: 20, cell_y: 23 })
        .expect("a Source places on (20,23), the first cell of the row the box would grow into");
    assert_eq!(
        refusal(&mut session, add_output(f)),
        CommandError::GrowBlocked,
        "a MACHINE first in the growth is GrowBlocked",
    );

    let sentence = shipped_sentence("GrowCoversBelt");
    assert_claims_none(
        "GrowCoversBelt",
        &sentence,
        &["port", "input", "space", "taken", "place", "turn", "machine", "\u{2014}"],
        "The AddPort arm refused because the grown box meets a BELT TILE. No port rule was \
         judged, nothing turned, and a machine in the way gets GrowBlocked.",
    );
    let lower = sentence.to_lowercase();
    for (word, why) in [
        ("grow", "the add grows the machine's box"),
        ("belt", "what is in the way is a belt"),
        ("move", "the fix, proved above: with the belt gone the same add is accepted"),
    ] {
        assert!(
            lower.contains(word),
            "REFUSAL_COPY.GrowCoversBelt is {sentence:?}, which does not say {word:?} ({why}).",
        );
    }
}

// ---------------------------------------------------------------------------
// InvalidBeltJoin (plan 74.1-18, gap N4c; reworded by plan 74.1-24, gap J11) - a refused
// belt-to-belt join with no cause of its own states the belt rule, never the machine rule.
// ---------------------------------------------------------------------------

/// True when `word` appears in `lower` as a WHOLE word: bounded on both sides by a
/// non-alphanumeric character or the string's edge. Review round 4 IN-04: a bare substring
/// check for "end" is satisfied by "ends", "extend" and "friend".
fn has_word(lower: &str, word: &str) -> bool {
    lower.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == word)
}

/// Three refusals the `Dock` arm makes for a belt-to-belt join return `InvalidBeltJoin`. NOT
/// every belt-to-belt refusal: since plan 74.1-24 ends that do not touch return
/// `BeltEndsApart` and the U-turn `BeltJoinTurnsBack`, and since plan 74.1-32 a belt end that
/// is already joined returns `BeltEndTaken` (their own cases). Each arm on its own fresh
/// board (the boards of `belt_join_both_ways.rs`):
///
/// - ROLE: a Head onto another belt's Head, and a Tail onto another belt's Tail, on boards
///   where the ends are MEASURED one step apart and the facing term passes, so only the role
///   is wrong. GRADED PER ARM: the sentence must name a belt's `end` (a whole word) and the
///   `start` it joins, which is what to do instead; and it may not give adjacency or turning
///   as the reason, because the ends ARE next to each other and the join does NOT turn back
///   (the re-walk's J11-THIRD: the 74.1-24 sentence explained a Head-onto-Head refusal only
///   through the word "starting").
/// - INNER TILE: a belt onto its own other end.
/// - SINGLE TILE: a one-tile target has no direction to start in.
///
/// THE INNER AND SINGLE-TILE ARMS ARE GRADED ON THEIR TAG ONLY (review round 4 IN-04),
/// because no hand reaches them: the client offers no end to drag on a one-tile belt
/// (`beltEndPort` answers null for it), and a drag excludes the dragged belt's own ends as
/// targets. If either becomes reachable, it needs its own clause here or its own tag.
///
/// The control: the accepted join (an end one step from a start, turning) proves the
/// sentence describes a rule the host really accepts something under.
///
/// The sentence may not say output, input, port or machine (a belt end has none of them,
/// the defect found in manual testing), nor "side by side" (the walk read it as approving
/// the U-turn, gap J11).
#[test]
fn the_invalid_belt_join_sentence_is_true_of_every_arm_that_returns_it() {
    use fabrico_core::edit::BeltEnd as CoreEnd;
    use fabrico_protocol::BeltEnd;
    const TAIL: u16 = 0;
    const HEAD: u16 = 1;

    // CONTROL: the N4 board's join, last tile (4,5) to first tile (4,6), accepted.
    let mut session = GridSession::new(SEED);
    let main = belt(&mut session, (4..=7).map(|x| (x, 6)).collect());
    let side = belt(&mut session, (3..=5).map(|y| (4, y)).collect());
    session
        .apply(dock(side, BeltEnd::Head, main, TAIL))
        .expect("a last tile one step from a first tile joins");

    // ROLE, both mismatched pairings, graded per arm below.
    let mut role_arms: Vec<(&str, CommandError)> = Vec::new();
    let mut session = GridSession::new(SEED);
    let a = belt(&mut session, vec![(10, 30), (11, 30), (12, 30)]);
    let b = belt(&mut session, vec![(14, 30), (13, 30)]);
    assert_eq!(
        (belt_end_of(&session, a, CoreEnd::Head).0, belt_end_of(&session, b, CoreEnd::Head).0),
        ((12, 30), (13, 30)),
        "MEASURED: the two Heads are one step apart",
    );
    role_arms.push(("last tile onto a last tile", refusal(&mut session, dock(a, BeltEnd::Head, b, HEAD))));
    let mut session = GridSession::new(SEED);
    let a = belt(&mut session, vec![(12, 30), (11, 30), (10, 30)]);
    let b = belt(&mut session, vec![(13, 30), (14, 30)]);
    assert_eq!(
        (belt_end_of(&session, a, CoreEnd::Tail).0, belt_end_of(&session, b, CoreEnd::Tail).0),
        ((12, 30), (13, 30)),
        "MEASURED: the two Tails are one step apart",
    );
    role_arms.push(("first tile onto a first tile", refusal(&mut session, dock(a, BeltEnd::Tail, b, TAIL))));

    // INNER TILE and SINGLE TILE, graded on their tag only (docblock).
    let mut tag_only_arms: Vec<(&str, CommandError)> = Vec::new();
    let mut session = GridSession::new(SEED);
    let own = belt(&mut session, vec![(20, 5), (21, 5)]);
    tag_only_arms.push(("onto its own other end", refusal(&mut session, dock(own, BeltEnd::Tail, own, HEAD))));
    let mut session = GridSession::new(SEED);
    let main = belt(&mut session, (4..=7).map(|x| (x, 6)).collect());
    let one = belt(&mut session, vec![(4, 5)]);
    tag_only_arms.push(("onto a one-tile belt", refusal(&mut session, dock(main, BeltEnd::Tail, one, HEAD))));

    for (arm, err) in role_arms.iter().chain(&tag_only_arms) {
        assert_eq!(*err, CommandError::InvalidBeltJoin, "the {arm} join refusal reads the belt rule");
    }
    assert_eq!(role_arms.len() + tag_only_arms.len(), 4, "every arm that returns this tag was driven (role twice)");

    let sentence = shipped_sentence("InvalidBeltJoin");
    assert_claims_none(
        "InvalidBeltJoin",
        &sentence,
        &["output", "input", "port", "machine", "facing", "side by side", "\u{2014}"],
        "Every refusal above joined a BELT to a BELT. A belt end has no output, input or port \
         to name, and the walk read \"side by side\" as approving the U-turn (gap J11).",
    );
    // THE ROLE ARM, graded: the ends were MEASURED one step apart and the facing term passed,
    // so neither distance nor turning is why it was refused; only the role is.
    assert_claims_none(
        "InvalidBeltJoin",
        &sentence,
        &["next to", "turn", "back"],
        "The role arm's ends are MEASURED one step apart and the join does not turn back, so a \
         sentence giving adjacency or turning as the rule describes what the user just did \
         (the re-walk's J11-THIRD).",
    );
    let lower = sentence.to_lowercase();
    assert!(
        has_word(&lower, "end"),
        "REFUSAL_COPY.InvalidBeltJoin is {sentence:?}, which does not name a belt's end as a whole word \
         (the role arm: the dragged end)",
    );
    assert!(
        lower.contains("start"),
        "REFUSAL_COPY.InvalidBeltJoin is {sentence:?}, which does not say an end joins the START of a belt \
         (the role arm: never last onto last or first onto first)",
    );
}

// ---------------------------------------------------------------------------
// BeltEndTaken (plan 74.1-32, the re-walk's HEAD-WORDS) - a joined belt end says so.
// ---------------------------------------------------------------------------

/// The `Dock` arm returns `BeltEndTaken` where the occupied source is a drawn belt's end,
/// on BOTH of its arms, and `PortOccupied` where it is a machine output:
///
/// - HEAD ARM: belt A's last tile joins B's first tile, then the same end is dropped on C's
///   first tile, one step away and turning across (every geometric clause passes).
/// - TAIL ARM: belt D's first tile is dropped on A's last tile, which already feeds B.
/// - MACHINE OUT: a belt docked on a Factory's output, dropped there again, keeps
///   `PortOccupied`, whose sentence names the output the user did drop on.
///
/// The sentence must name a belt end and say it is joined, and may not say output, input,
/// port or machine: the walk read "That output is already connected." for a belt end the
/// user dragged (HEAD-WORDS). Nothing changes on any arm.
#[test]
fn the_belt_end_taken_sentence_is_true_of_both_arms_that_return_it() {
    use fabrico_protocol::BeltEnd;
    const TAIL: u16 = 0;
    const HEAD: u16 = 1;
    let name = |e: CommandError| format!("{e:?}");

    // HEAD ARM.
    let mut session = GridSession::new(SEED);
    let a = belt(&mut session, (4..=7).map(|x| (x, 6)).collect());
    let b = belt(&mut session, (8..=10).map(|x| (x, 6)).collect());
    let c = belt(&mut session, vec![(7, 5), (7, 4), (7, 3)]);
    session.apply(dock(a, BeltEnd::Head, b, TAIL)).expect("A's last tile joins B's first tile straight");
    let before = postcard::to_allocvec(&session.core().state).expect("state serializes");
    let log_len = session.edit_log().len();
    assert_eq!(
        name(refusal(&mut session, dock(a, BeltEnd::Head, c, TAIL))),
        "BeltEndTaken",
        "HEAD ARM: a dragged belt end that already feeds a belt is refused as a taken belt end",
    );
    assert_eq!(postcard::to_allocvec(&session.core().state).expect("state serializes"), before, "HEAD ARM: nothing joined");
    assert_eq!(session.edit_log().len(), log_len, "HEAD ARM: no record produced");

    // TAIL ARM.
    let mut session = GridSession::new(SEED);
    let a = belt(&mut session, (4..=7).map(|x| (x, 6)).collect());
    let b = belt(&mut session, (8..=10).map(|x| (x, 6)).collect());
    let d = belt(&mut session, vec![(7, 7), (7, 8)]);
    session.apply(dock(a, BeltEnd::Head, b, TAIL)).expect("A's last tile joins B's first tile straight");
    let before = postcard::to_allocvec(&session.core().state).expect("state serializes");
    let log_len = session.edit_log().len();
    assert_eq!(
        name(refusal(&mut session, dock(d, BeltEnd::Tail, a, HEAD))),
        "BeltEndTaken",
        "TAIL ARM: a belt's first tile dropped on a belt end that already feeds a belt is refused as a taken belt end",
    );
    assert_eq!(postcard::to_allocvec(&session.core().state).expect("state serializes"), before, "TAIL ARM: nothing joined");
    assert_eq!(session.edit_log().len(), log_len, "TAIL ARM: no record produced");

    // MACHINE OUT keeps `PortOccupied`. A FACTORY at (10,14): its Out (2,1) faces E from
    // (12,15), so its doorstep is (13,15).
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 10, 14);
    let out_belt = belt(&mut session, vec![(13, 15), (14, 15)]);
    session.apply(dock(out_belt, BeltEnd::Tail, f, 1)).expect("the belt's first tile docks on the Factory's output");
    assert_eq!(
        refusal(&mut session, dock(out_belt, BeltEnd::Tail, f, 1)),
        CommandError::PortOccupied,
        "MACHINE OUT: an output that already feeds a belt keeps the output sentence's tag",
    );

    let sentence = shipped_sentence("BeltEndTaken");
    assert_claims_none(
        "BeltEndTaken",
        &sentence,
        &["output", "input", "port", "machine", "\u{2014}"],
        "Both arms refused a BELT END the user handled; a belt end has no output, input or port \
         (HEAD-WORDS).",
    );
    let lower = sentence.to_lowercase();
    for (words, why) in [
        ("belt end", "what the user handled is a belt end"),
        ("joined", "the end already joins another belt, on both arms"),
    ] {
        assert!(
            lower.contains(words),
            "REFUSAL_COPY.BeltEndTaken is {sentence:?}, which does not say {words:?} ({why}).",
        );
    }
    let machine = shipped_sentence("PortOccupied").to_lowercase();
    assert!(
        machine.contains("output") && machine.contains("disconnect"),
        "REFUSAL_COPY.PortOccupied still names the output and the Disconnect control: {machine:?}",
    );
}

// ---------------------------------------------------------------------------
// BeltEndsApart (plan 74.1-24, gap J11) - ends that do not touch say so.
// ---------------------------------------------------------------------------

/// The host refuses a belt-to-belt join whose ends are not one orthogonal step apart as
/// `BeltEndsApart`, and `These ends do not touch.` must be true of every arm returning it.
/// The arm is the Dock arm's one-step check on a belt target, reached by an end two cells
/// away (the re-walk's N4E board) and by a diagonal neighbour.
///
/// 1. Each board, in BOTH drag directions, returns this tag and changes nothing.
/// 2. What the arm proves, measured: the two end cells are NOT one orthogonal step apart
///    (manhattan distance two, either straight or diagonal), so "do not touch" is true.
/// 3. The control: the same main belt with the other end ONE step away joins, so touching
///    is what the host draws its line at.
///
/// The sentence may not say output, input, port or machine (a belt end has none), nor turn
/// or back (the facing term was never reached).
///
/// MUTATION: point `BeltEndsApart` at `BeltJoinTurnsBack`'s sentence and the claims check
/// reddens on "turn"; drop "touch" from it and the positive clause reddens.
#[test]
fn the_belt_ends_apart_sentence_is_true_of_the_arm_that_produces_it() {
    use fabrico_core::edit::BeltEnd as CoreEnd;
    use fabrico_protocol::BeltEnd;
    const TAIL: u16 = 0;
    const HEAD: u16 = 1;

    // The main belt (4,6)->(7,6) east; the side belt runs south and its Head is two cells
    // straight above the main belt's Tail (N4E), or one across and one up (a diagonal).
    let boards: [(&str, Vec<(i32, i32)>); 2] = [
        ("two cells away", (2..=4).map(|y| (4, y)).collect()),
        ("a diagonal neighbour", (3..=5).map(|y| (5, y)).collect()),
    ];
    for (shape, side_cells) in boards {
        for drag_side in [true, false] {
            let mut session = GridSession::new(SEED);
            let main = belt(&mut session, (4..=7).map(|x| (x, 6)).collect());
            let side = belt(&mut session, side_cells.clone());
            let (cmd, way) = if drag_side {
                (dock(side, BeltEnd::Head, main, TAIL), "the side belt's last tile dragged")
            } else {
                (dock(main, BeltEnd::Tail, side, HEAD), "the main belt's first tile dragged")
            };
            let before = postcard::to_allocvec(&session.core().state).expect("state serializes");
            let log_len = session.edit_log().len();
            assert_eq!(
                refusal(&mut session, cmd),
                CommandError::BeltEndsApart,
                "{shape}, {way}: refused because the ends do not touch",
            );
            assert_eq!(
                postcard::to_allocvec(&session.core().state).expect("state serializes"),
                before,
                "{shape}, {way}: nothing joined",
            );
            assert_eq!(session.edit_log().len(), log_len, "{shape}, {way}: no record produced");

            // Clause 2, measured.
            let (s_end, _) = belt_end_of(&session, side, CoreEnd::Head);
            let (m_end, _) = belt_end_of(&session, main, CoreEnd::Tail);
            assert_eq!(
                s_end.0.abs_diff(m_end.0) + s_end.1.abs_diff(m_end.1),
                2,
                "{shape}, {way}: the end cells {s_end:?} and {m_end:?} are not one orthogonal step apart",
            );
        }
    }

    // Clause 3: one step apart, the same join is accepted.
    let mut session = GridSession::new(SEED);
    let main = belt(&mut session, (4..=7).map(|x| (x, 6)).collect());
    let side = belt(&mut session, (3..=5).map(|y| (4, y)).collect());
    session
        .apply(dock(side, BeltEnd::Head, main, TAIL))
        .expect("with the ends touching, the same join is accepted");

    let sentence = shipped_sentence("BeltEndsApart");
    assert_claims_none(
        "BeltEndsApart",
        &sentence,
        &["output", "input", "port", "machine", "turn", "back", "\u{2014}"],
        "Every refusal above joined a BELT to a BELT whose ends are apart; the facing term was \
         never reached, and a belt end has no output, input or port to name.",
    );
    assert!(
        sentence.to_lowercase().contains("touch"),
        "REFUSAL_COPY.BeltEndsApart is {sentence:?}, which does not say the ends do not touch (clause 2)",
    );
}

// ---------------------------------------------------------------------------
// BeltJoinTurnsBack (plan 74.1-24, gap J11) - the U-turn says that it turns back.
// ---------------------------------------------------------------------------

/// The cell and outward side of `end` of the live belt `h`, measured from the folded state.
fn belt_end_of(
    session: &GridSession,
    h: u64,
    end: fabrico_core::edit::BeltEnd,
) -> ((i32, i32), Option<fabrico_core::state::Side>) {
    use fabrico_command::GridLookup;
    let id = session
        .view()
        .lookup(session.core())
        .resolve(h)
        .expect("the handle names a live node");
    let Some(fabrico_core::state::Node::Belt(b)) = session.core().state.node(id) else {
        panic!("handle {h} names a belt");
    };
    fabrico_core::state::belt_end_world(&b.geometry, end).expect("a drawn belt has a spatial end")
}

/// The host refuses a belt-to-belt join that turns back the way it came as
/// `BeltJoinTurnsBack`, and the sentence must say what the arm proves and nothing it
/// proves false. The arm is the Dock arm's narrowed facing term on a BELT target; on a
/// command-built board it is reached by exactly one shape, the U-turn: two side-by-side
/// belts running opposite ways, one's end beside the other's start (the re-walk's N4D board).
///
/// 1. Driven in BOTH drag directions, the arm returns this tag and changes nothing.
/// 2. What the arm proves, measured: the two ends ARE one orthogonal step apart (so a
///    sentence saying they do not touch would be false here) and the carrier's outward
///    side EQUALS the target end's side (the facing term, which is what "turn back" names).
/// 3. The control: the same two end cells with the carrier turning across instead of back
///    (the N4 board) join, so the sentence names a rule the host really draws a line at.
///
/// The sentence may not say output, input, port or machine (a belt end has none), nor
/// "side by side" (the walk read that as APPROVING this join), nor "touch" (they touch).
///
/// MUTATION: point `BeltJoinTurnsBack` at `InvalidBeltJoin`'s sentence and the claims
/// check reddens on "side by side"; drop "back" from it and the positive clause reddens.
#[test]
fn the_belt_join_turns_back_sentence_is_true_of_the_arm_that_produces_it() {
    use fabrico_core::edit::BeltEnd as CoreEnd;
    use fabrico_protocol::BeltEnd;
    const TAIL: u16 = 0;
    const HEAD: u16 = 1;

    // The N4D board: A east (10,20)->(12,20), B west (12,21)->(10,21). A's last tile (12,20)
    // sits right above B's first tile (12,21).
    let n4d = || {
        let mut session = GridSession::new(SEED);
        let a = belt(&mut session, vec![(10, 20), (11, 20), (12, 20)]);
        let b = belt(&mut session, vec![(12, 21), (11, 21), (10, 21)]);
        (session, a, b)
    };

    // Clause 1, both drag directions.
    let (mut session, a, b) = n4d();
    let directions = [
        ("A's last tile onto B's first tile", dock(a, BeltEnd::Head, b, TAIL), (a, CoreEnd::Head), (b, CoreEnd::Tail)),
        ("B's first tile onto A's last tile", dock(b, BeltEnd::Tail, a, HEAD), (b, CoreEnd::Tail), (a, CoreEnd::Head)),
    ];
    for (way, cmd, (ch, cend), (th, tend)) in directions {
        let before = postcard::to_allocvec(&session.core().state).expect("state serializes");
        let log_len = session.edit_log().len();
        assert_eq!(
            refusal(&mut session, cmd),
            CommandError::BeltJoinTurnsBack,
            "{way}: the U-turn is refused under its own tag",
        );
        assert_eq!(
            postcard::to_allocvec(&session.core().state).expect("state serializes"),
            before,
            "{way}: nothing joined",
        );
        assert_eq!(session.edit_log().len(), log_len, "{way}: no record produced");

        // Clause 2, measured.
        let (ccell, cside) = belt_end_of(&session, ch, cend);
        let (tcell, tside) = belt_end_of(&session, th, tend);
        assert_eq!(
            (ccell.0.abs_diff(tcell.0) + ccell.1.abs_diff(tcell.1)),
            1,
            "{way}: the two ends are one orthogonal step apart, so they DO touch",
        );
        assert!(cside.is_some() && cside == tside, "{way}: the carrier's outward side equals the target end's (the facing term)");
    }

    // Clause 3: the N4 board's join, a last tile one step from a first tile, turning.
    let mut session = GridSession::new(SEED);
    let main = belt(&mut session, (4..=7).map(|x| (x, 6)).collect());
    let side = belt(&mut session, (3..=5).map(|y| (4, y)).collect());
    session
        .apply(dock(side, BeltEnd::Head, main, TAIL))
        .expect("a last tile one step from a first tile, turning across, joins");

    let sentence = shipped_sentence("BeltJoinTurnsBack");
    assert_claims_none(
        "BeltJoinTurnsBack",
        &sentence,
        &["output", "input", "port", "machine", "side by side", "touch", "\u{2014}"],
        "Both drag directions joined a BELT to a BELT whose ends touch and lie side by side; \
         only the direction is wrong. A belt end has no output, input or port to name.",
    );
    let lower = sentence.to_lowercase();
    for (word, why) in [
        ("join", "the refused gesture is a belt-to-belt join"),
        ("back", "the facing term refuses a join that runs back the way it came (clause 2)"),
    ] {
        assert!(
            lower.contains(word),
            "REFUSAL_COPY.BeltJoinTurnsBack is {sentence:?}, which does not say {word:?} ({why}).",
        );
    }
}

// ---------------------------------------------------------------------------
// ResizeCovers (phase 76, plan 76-03, D-01, D-04) - the grow refusal must be true of
// every neighbour the arm can meet: a machine, a belt tile, another label.
// ---------------------------------------------------------------------------

/// A board with a 4 by 1 label anchored at (10,12), placed through the real
/// `GridSession`, and its render handle.
fn board_with_a_label() -> (GridSession, u64) {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place {
            kind: fabrico_protocol::machine_kind::LABEL,
            cell_x: 10,
            cell_y: 12,
        })
        .expect("a label places on a free 4 by 1");
    let id = session
        .core()
        .state
        .occupied((10, 12))
        .expect("the label occupies its anchor cell");
    let h = handle(&session, id);
    (session, h)
}

/// The label Configure that sets `label` to `w` by `h` with fixed words and colour.
fn resize(label: u64, w: u16, h: u16) -> GridCommand {
    GridCommand::Configure {
        node: label,
        config: fabrico_protocol::MachineConfig::Label {
            text: "Order intake".to_owned(),
            colour: 3,
            w,
            h,
        },
    }
}

/// The grow refusal the user reads after pressing Apply on a size that would cover
/// something. The `Configure{Label}` arm returns `ResizeCovers` for a cell held by ANY
/// other node or belt tile, so the sentence may not name one kind of neighbour, may not
/// tell the user to clear the neighbour or to try elsewhere (the label is not being
/// placed), and may not mention turning (a label never turns). It must name the one
/// thing that is always true: a smaller size fits, because the committed size does.
///
/// The three arms, each proved on the real `GridSession`:
/// 1. growth right into a MACHINE (a Source at (14,12), one column past the 4 by 1 box);
/// 2. growth down into a BELT TILE (a belt drawn through (11,14) and (12,14));
/// 3. growth down into ANOTHER LABEL (a label anchored at (10,13)).
///
/// MUTATION (2026-10-07, throwaway worktree, reverted): `ResizeCovers` given the shipped
/// FootprintCollision sentence (its wording before plan 89-08) reddens this on its first
/// forbidden claim, "clear"; the wording since plan 89-08,
/// "That space is taken. Clear it or try elsewhere.", says it too.
#[test]
fn the_resize_covers_sentence_is_true_of_every_arm_that_produces_it() {
    // Arm 1: a machine.
    let (mut session, label) = board_with_a_label();
    session
        .apply(GridCommand::Place {
            kind: fabrico_protocol::machine_kind::SOURCE,
            cell_x: 14,
            cell_y: 12,
        })
        .expect("a Source places one column past the label");
    let before = postcard::to_allocvec(&session.core().state).expect("state serializes");
    assert_eq!(
        refusal(&mut session, resize(label, 5, 1)),
        CommandError::ResizeCovers,
        "growing right over a machine is ResizeCovers",
    );
    assert_eq!(
        postcard::to_allocvec(&session.core().state).expect("state serializes"),
        before,
        "a refused resize changes nothing",
    );
    session
        .apply(resize(label, 4, 1))
        .expect("the fix the sentence names: a smaller size, the committed one, is accepted");

    // Arm 2: a belt tile.
    let (mut session, label) = board_with_a_label();
    belt(&mut session, vec![(11, 14), (12, 14)]);
    assert_eq!(
        refusal(&mut session, resize(label, 4, 3)),
        CommandError::ResizeCovers,
        "growing down over a belt tile is ResizeCovers",
    );
    session
        .apply(resize(label, 4, 2))
        .expect("one row smaller stops short of the belt and is accepted");

    // Arm 3: another label.
    let (mut session, label) = board_with_a_label();
    session
        .apply(GridCommand::Place {
            kind: fabrico_protocol::machine_kind::LABEL,
            cell_x: 10,
            cell_y: 13,
        })
        .expect("a second label places on the row below");
    assert_eq!(
        refusal(&mut session, resize(label, 4, 2)),
        CommandError::ResizeCovers,
        "growing down over another label is ResizeCovers",
    );
    session
        .apply(resize(label, 3, 1))
        .expect("a smaller label is accepted beside its neighbour");

    let sentence = shipped_sentence("ResizeCovers");
    assert_claims_none(
        "ResizeCovers",
        &sentence,
        &["clear", "elsewhere", "rotate", "turn", "belt", "machine", "\u{2014}"],
        "The Configure{Label} arm refused a GROWTH because a new cell holds a machine, a \
         belt tile or another label. Nothing is placed, nothing turns, and the covered thing \
         may be any of the three, so the sentence names none of them and gives no instruction \
         about the neighbour.",
    );
    assert!(
        sentence.to_lowercase().contains("smaller"),
        "REFUSAL_COPY.ResizeCovers is {sentence:?}, which does not say \"smaller\": the fix \
         proved on all three arms above is a smaller size",
    );
}

// ---------------------------------------------------------------------------
// LabelDoesNotConnect (phase 76, plan 76-04, SHAPE-14, D-07) - the connect refusal must
// be true of every arm that produces it: two Dock shapes, both ends of a DrawWire, AddPort.
// ---------------------------------------------------------------------------

/// The sentence a forged client's user would read when any command tries to join a label
/// to the flow. The engine returns `LabelDoesNotConnect` from FIVE shapes, each proved on
/// the real `GridSession` and the fault-port one a second time through the host's real
/// `decode_gesture`:
/// 1. a spatial `Dock` of a belt end right beside the label;
/// 2. a `Dock` naming the label's `FAULT_PORT`, the non-spatial branch that checks no
///    geometry (accepted before D-07, linking a belt to a note);
/// 3. a `DrawWire` FROM the label to a real electrical In;
/// 4. a `DrawWire` TO the label from a real electrical Out;
/// 5. an `AddPort` on the label (accepted before D-07, growing the label a port).
///
/// The refusal holds whatever port the gesture named, whether the board had room, and
/// whatever edge or turn the belt took, so the sentence may claim none of those; it must
/// say the one thing all five share: a label does not connect.
///
/// MUTATION (2026-10-07, throwaway worktree, reverted): `LabelDoesNotConnect` given
/// `InvalidDock`'s sentence, "A belt runs from an output to an input, right next to it.",
/// first reddened only on the positive "connect" check, because the forbidden list then
/// held `port` and not `output` or `input`. Both were added (a label has neither), and the
/// same mutation now reddens on the claim itself: `REFUSAL_COPY.LabelDoesNotConnect is "A
/// belt runs from an output to an input, right next to it.", which claims "output".`
#[test]
fn the_label_does_not_connect_sentence_is_true_of_every_arm_that_produces_it() {
    use fabrico_core::fault::FAULT_PORT;
    use fabrico_protocol::BeltEnd;

    let state_bytes =
        |s: &GridSession| postcard::to_allocvec(&s.core().state).expect("state serializes");

    // Shape 1: a spatial Dock, the belt's Head on the tile right beside the label.
    let (mut session, label) = board_with_a_label();
    let carrier = belt(&mut session, vec![(6, 12), (7, 12), (8, 12), (9, 12)]);
    let before = state_bytes(&session);
    assert_eq!(
        refusal(&mut session, dock(carrier, BeltEnd::Head, label, 0)),
        CommandError::LabelDoesNotConnect,
        "a spatial Dock onto a label is LabelDoesNotConnect",
    );
    assert_eq!(state_bytes(&session), before, "a refused Dock changes nothing");

    // Shape 2: the FAULT_PORT Dock, a belt far from the label, on the real session ...
    let (mut session, label) = board_with_a_label();
    let carrier = belt(&mut session, vec![(20, 20), (21, 20), (22, 20)]);
    let before = state_bytes(&session);
    let forged = dock(carrier, BeltEnd::Tail, label, FAULT_PORT);
    assert_eq!(
        refusal(&mut session, forged.clone()),
        CommandError::LabelDoesNotConnect,
        "a FAULT_PORT Dock naming a label is LabelDoesNotConnect",
    );
    // ... and again as the host receives it: a gesture frame, through the real decoder,
    // read back exactly, then applied.
    let frame = postcard::to_allocvec(&forged).expect("a GridCommand encodes");
    let decoded = match decode_body(&frame) {
        Ok(GestureFrame::Cmd(cmd)) => cmd,
        other => panic!("the host must read the forged Dock frame back as a command, got {other:?}"),
    };
    assert_eq!(decoded, forged, "the host reads the forged Dock EXACTLY");
    assert_eq!(
        refusal(&mut session, decoded),
        CommandError::LabelDoesNotConnect,
        "the decoded fault-port Dock is LabelDoesNotConnect",
    );
    assert_eq!(state_bytes(&session), before, "a refused fault-port Dock changes nothing");

    // Shapes 3 and 4: a wire from, then to, the label.
    let (mut session, label) = board_with_a_label();
    let r = router(&mut session, 30, 30);
    let r = handle(&session, r);
    let before = state_bytes(&session);
    assert_eq!(
        refusal(
            &mut session,
            GridCommand::DrawWire { from_node: label, from_port: 0, to_node: r, to_port: IN_PORT }
        ),
        CommandError::LabelDoesNotConnect,
        "a wire from a label is LabelDoesNotConnect",
    );
    assert_eq!(
        refusal(
            &mut session,
            GridCommand::DrawWire { from_node: r, from_port: OUT_PORT, to_node: label, to_port: 0 }
        ),
        CommandError::LabelDoesNotConnect,
        "a wire to a label is LabelDoesNotConnect",
    );
    assert_eq!(state_bytes(&session), before, "a refused DrawWire changes nothing");

    // Shape 5: an output added to the label.
    let (mut session, label) = board_with_a_label();
    let before = state_bytes(&session);
    assert_eq!(
        refusal(&mut session, add_output(label)),
        CommandError::LabelDoesNotConnect,
        "an AddPort on a label is LabelDoesNotConnect",
    );
    assert_eq!(state_bytes(&session), before, "a refused AddPort changes nothing");

    let sentence = shipped_sentence("LabelDoesNotConnect");
    assert_claims_none(
        "LabelDoesNotConnect",
        &sentence,
        &["port", "output", "input", "full", "taken", "edge", "turn", "\u{2014}"],
        "The five shapes above were refused whatever port they named (index 0, index 1, the \
         fault sentinel, a new one), on a board with room, on a belt that did not turn, \
         before any edge or occupancy check ran. A sentence naming a port, an output or an \
         input, a full or taken one, an edge or a turn is false of at least one of them, and \
         a label has no port, output or input to name at all.",
    );
    assert!(
        sentence.to_lowercase().contains("connect"),
        "REFUSAL_COPY.LabelDoesNotConnect is {sentence:?}, which does not say \"connect\": \
         every one of the five shapes above is an attempt to connect a label",
    );
}

// ---------------------------------------------------------------------------
// UndoSpaceTaken (phase 86, plan 86-06, WORK-02, D-04) - the Undo refusal must be true of
// both arms that produce it: the re-Placed box and a re-drawn belt.
// ---------------------------------------------------------------------------

/// A real board whose last record is a Delete, folded again from genesis with that Delete's
/// op changed by `forge`: the forged history a damaged `.fab` would carry. With linear undo
/// no ordinary gesture reaches `UndoSpaceTaken` (anything placed after a Delete is undone
/// first), so a forged history is its only reach.
fn with_last_delete_forged(
    session: &GridSession,
    forge: impl FnOnce(&mut fabrico_core::edit::EditOp),
) -> GridSession {
    let mut records = session.edit_log().to_vec();
    let last = records.last_mut().expect("the board has an edit log");
    assert!(
        matches!(last.op, fabrico_core::edit::EditOp::Delete { .. }),
        "measured: the last record is the Delete, found {:?}",
        last.op
    );
    forge(&mut last.op);
    GridSession::replay(SEED, &records)
}

/// The sentence a user reads when Ctrl+Z would put something back on cells another node
/// now holds. The engine returns `UndoSpaceTaken` from TWO arms of the Delete undo, each
/// driven here on the real `GridSession` over a forged history:
/// 1. the re-Placed box: a Factory's Delete capture widened by one column onto a Source;
/// 2. a re-drawn belt: a Sink's cascade belt with one tile moved onto a Source, the Sink's
///    own cell free.
///
/// In both the user placed nothing and chose no cell: the restore's cells come from the
/// history, so "try elsewhere" or "clear it" names a choice an Undo does not offer, and
/// clearing the cell and pressing Ctrl+Z again undoes the clearing gesture first. What is
/// true of both: the space is taken, and nothing was undone (no record, the board
/// unchanged, the step still on top of the stack, all asserted here).
#[test]
fn the_undo_space_taken_sentence_is_true_of_both_arms_that_produce_it() {
    use fabrico_core::edit::EditOp;
    use fabrico_protocol::{BeltEnd, machine_kind};

    let state_bytes =
        |s: &GridSession| postcard::to_allocvec(&s.core().state).expect("state serializes");
    let place = |s: &mut GridSession, kind: u8, at: (i32, i32)| -> NodeId {
        s.apply(GridCommand::Place { kind, cell_x: at.0, cell_y: at.1 })
            .unwrap_or_else(|e| panic!("measured: a Place at {at:?} on free floor, got {e:?}"));
        *s.core().last_tick.placed.last().expect("the Place minted")
    };
    let refused_whole = |mut s: GridSession, why: &str| {
        let (edits, before) = (s.edit_log().len(), state_bytes(&s));
        assert!(s.can_undo(), "{why}: the forged board offers Undo");
        assert_eq!(refusal(&mut s, GridCommand::Undo), CommandError::UndoSpaceTaken, "{why}");
        assert_eq!(s.edit_log().len(), edits, "{why}: nothing was logged");
        assert_eq!(state_bytes(&s), before, "{why}: nothing was undone");
        assert!(s.can_undo(), "{why}: the step stays on top of the undo stack");
    };

    // Arm 1: the re-Placed box.
    let mut session = GridSession::new(SEED);
    let factory = place(&mut session, machine_kind::FACTORY, (20, 20));
    place(&mut session, machine_kind::SOURCE, (23, 20));
    let h = handle(&session, factory);
    session.apply(GridCommand::Delete { node: h }).expect("measured: the Delete is accepted");
    let forged = with_last_delete_forged(&session, |op| {
        if let EditOp::Delete { captured, .. } = op {
            assert_eq!(captured.w, 3, "measured: the real capture is 3 columns");
            captured.w = 4;
        }
    });
    refused_whole(forged, "a restore box over a Source is UndoSpaceTaken");

    // Arm 2: a re-drawn cascade belt.
    let mut session = GridSession::new(SEED);
    let sink = place(&mut session, machine_kind::SINK, (11, 0));
    let carrier = belt(&mut session, vec![(9, 0), (10, 0)]);
    let sink_h = handle(&session, sink);
    session
        .apply(dock(carrier, BeltEnd::Head, sink_h, 0))
        .expect("measured: the belt's Head docks into the Sink's In");
    place(&mut session, machine_kind::SOURCE, (9, 1));
    session.apply(GridCommand::Delete { node: sink_h }).expect("measured: the Delete is accepted");
    let forged = with_last_delete_forged(&session, |op| {
        if let EditOp::Delete { captured, .. } = op {
            assert_eq!(captured.belts.len(), 1, "measured: one cascade belt captured");
            captured.belts[0].geometry[0].cell = (9, 1);
        }
    });
    refused_whole(forged, "a re-drawn belt over a Source is UndoSpaceTaken");

    let sentence = shipped_sentence("UndoSpaceTaken");
    assert_claims_none(
        "UndoSpaceTaken",
        &sentence,
        &["elsewhere", "place", "clear", "try again", "move", "\u{2014}"],
        "Both arms above were an Undo: the user placed nothing and chose no cell, and the \
         cells the restore would claim come from the history. Telling them to place \
         elsewhere, to clear the space, to move something or to try again names a choice an \
         Undo does not offer (with linear undo, clearing the cell is itself the newer step \
         Ctrl+Z takes back first).",
    );
    let lower = sentence.to_lowercase();
    assert!(
        lower.contains("taken") && lower.contains("nothing was undone"),
        "REFUSAL_COPY.UndoSpaceTaken is {sentence:?}, which does not say both true things: \
         the space is taken, and nothing was undone (no record, the board unchanged, the step \
         still on top)",
    );
}

// ---------------------------------------------------------------------------
// Phase 88 red-first probes (FAIL-09, WINDOWS 81, 83 and 84, D-11).
//
// Each drives one arm whose refusal tag carried a second cause until plan 88-02, and asserts
// the wire tag the split gives that arm. Each was `#[ignore]`d until plan 88-02 (which split
// the tags on both sides of the language boundary in one commit, and turned them on) and was
// seen FAILED at `PHASE88_START` in a throwaway worktree (88-EVIDENCE.md `## Red-first
// record`). Each prints the tag it read before it asserts.
// ---------------------------------------------------------------------------

/// The wire tag the user's refusal carries for `err`, printed in the `P88-` form.
fn wire_tag_read(probe: &str, err: CommandError) -> &'static str {
    let debug = format!("{err:?}");
    let tag = fabrico_host::command_error_view::CommandErrorView::from(err).wire_tag();
    eprintln!("P88-{probe} err={debug} wire_tag={tag}");
    tag
}

/// The cells `id` owns inside a window around `(20,20)`, for a box that may have grown.
fn owned_cells(session: &GridSession, id: NodeId) -> Vec<(i32, i32)> {
    let mut cells = Vec::new();
    for y in 10..100 {
        for x in 10..40 {
            if session.core().state.occupied((x, y)) == Some(id) {
                cells.push((x, y));
            }
        }
    }
    cells
}

/// WINDOWS 83: a Factory in the middle of the grid, grown by `+ Add output` until the box
/// passes the dimension cap, is refused because it is too big, not because a cell is past
/// the edge of the grid. Every cell of the last accepted box is far inside the grid, so no
/// edge is anywhere near it.
#[test]
fn a_machine_too_big_mid_grid_is_named_machine_too_big() {
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 20, 20);
    let id = session.core().state.occupied((20, 20)).expect("the Factory owns (20,20)");
    let mut accepted = 0u32;
    let err = loop {
        match session.apply(add_output(f)) {
            Ok(_) => accepted += 1,
            Err(e) => break e,
        }
        assert!(accepted < 200, "measured: some add passes the cap well before 200 outputs");
    };
    let fp = session.core().state.footprint_of(id).expect("placed");
    let far = owned_cells(&session, id)
        .iter()
        .all(|&(x, y)| (x - fabrico_core::state::GRID_MIN).min(fabrico_core::state::GRID_MAX - x) > 100
            && (y - fabrico_core::state::GRID_MIN).min(fabrico_core::state::GRID_MAX - y) > 100);
    eprintln!(
        "P88-F9-83 accepted_adds={accepted} last_box={}x{} cap={} far_from_every_edge={far}",
        fp.w,
        fp.h,
        fabrico_core::state::MAX_FOOTPRINT_DIM
    );
    assert!(far, "PRECONDITION: the box is far from every grid edge, so the edge is not the cause");
    assert_eq!(
        fp.w.max(fp.h),
        fabrico_core::state::MAX_FOOTPRINT_DIM,
        "PRECONDITION: the last accepted box is at the size cap, so the next add passes it"
    );
    assert_eq!(wire_tag_read("F9-83", err), "MachineTooBig", "a box past the size cap is named as too big");
}

/// WINDOWS 84, the turn: a Router (2 by 3 at (10,10)) whose turned box (3 by 2) covers a
/// Source on (12,10) is refused with a tag of its own, so its sentence can tell the user to
/// clear the space rather than to try elsewhere (a Rotate has no "elsewhere").
#[test]
fn a_blocked_turn_is_named_rotate_blocked() {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place { kind: fabrico_protocol::machine_kind::ROUTER, cell_x: 10, cell_y: 10 })
        .expect("a Router places on a free 2x3");
    let router = session.core().state.occupied((10, 10)).expect("the Router owns its anchor");
    session
        .apply(GridCommand::Place { kind: fabrico_protocol::machine_kind::SOURCE, cell_x: 12, cell_y: 10 })
        .expect("a Source places on (12,10)");
    assert_eq!(
        owned_cells(&session, router).len(),
        6,
        "PRECONDITION: the Router owns its 2 by 3 box, and (12,10) is outside it"
    );
    let router_h = handle(&session, router);
    let err = refusal(&mut session, GridCommand::Rotate { node: router_h, ccw: false });
    assert_eq!(wire_tag_read("F9-84-rotate", err), "RotateBlocked", "a turn into a machine is named as a blocked turn");
}

/// WINDOWS 84, the growth: a Factory whose next `+ Add output` grows the box onto a Source
/// is refused with a tag of its own, for the same reason as the turn. The cell the growth
/// claims is measured on a copy of the board first, then the Source is placed there.
#[test]
fn a_blocked_add_port_is_named_grow_blocked() {
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 20, 20);
    let id = session.core().state.occupied((20, 20)).expect("the Factory owns (20,20)");
    // Add outputs until one grows the box. The growing add is undone at once, so the board
    // is back to the box before it, and the cell the growth claimed is known.
    let grown = loop {
        let before = owned_cells(&session, id);
        session.apply(add_output(f)).expect("measured: the add fits on free floor");
        let new: Vec<(i32, i32)> = owned_cells(&session, id).into_iter().filter(|c| !before.contains(c)).collect();
        if let Some(&cell) = new.first() {
            session.apply(GridCommand::Undo).expect("measured: the growing add undoes");
            assert_eq!(owned_cells(&session, id), before, "PRECONDITION: the Undo put the box back");
            break cell;
        }
        assert!(session.edit_log().len() < 40, "measured: the box grows within a few adds");
    };
    session
        .apply(GridCommand::Place { kind: fabrico_protocol::machine_kind::SOURCE, cell_x: grown.0, cell_y: grown.1 })
        .expect("a Source places on the cell the growth would claim");
    eprintln!("P88-F9-84-grow blocker_at={grown:?}");
    let err = refusal(&mut session, add_output(f));
    assert_eq!(wire_tag_read("F9-84-grow", err), "GrowBlocked", "a growth into a machine is named as a blocked growth");
}

/// WINDOWS 81, the port index: a `RemovePort` naming an index past the port list, a frame
/// the host read perfectly, is named for the missing port, not as an unreadable gesture.
#[test]
fn a_port_index_past_the_list_is_named_no_such_port() {
    let mut session = GridSession::new(SEED);
    let node = router(&mut session, 0, 0);
    let count = session.core().state.ports_of(node).expect("the preset router declares ports").len();
    let index = u16::try_from(count).expect("a port count fits u16");
    eprintln!("P88-F9-81-port ports={count} index={index}");
    let node_h = handle(&session, node);
    let err = refusal(&mut session, GridCommand::RemovePort { node: node_h, index });
    assert_eq!(wire_tag_read("F9-81-port", err), "NoSuchPort", "an index past the port list is named as a missing port");
}

/// WINDOWS 81, the option byte: an `AddPort` whose role byte names no role, a frame the
/// host read perfectly, is named for the unknown option.
#[test]
fn an_unknown_role_byte_is_named_unknown_option() {
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 20, 20);
    let cmd = GridCommand::AddPort {
        node: f,
        role: 200,
        side: fabrico_core::state::Side::E as u8,
        medium: fabrico_protocol::port_medium::MECHANICAL,
    };
    let frame = postcard::to_allocvec(&cmd).expect("a GridCommand encodes");
    assert_eq!(
        decode_body(&frame),
        Ok(GestureFrame::Cmd(cmd.clone())),
        "PRECONDITION: the host reads this gesture back exactly"
    );
    let err = refusal(&mut session, cmd);
    assert_eq!(wire_tag_read("F9-81-role", err), "UnknownOption", "a role byte naming no role is named as an unknown option");
}

/// WINDOWS 81, the undo: a Delete whose capture names a belt by links that name no belt (a
/// damaged history, loaded through `GridSession::replay`) cannot be undone on the board as
/// it is, and is named for that, not as an unreadable gesture.
#[test]
fn an_undo_that_no_longer_fits_is_named_undo_does_not_fit() {
    use fabrico_core::edit::EditOp;
    use fabrico_protocol::{BeltEnd, machine_kind};

    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place { kind: machine_kind::SINK, cell_x: 11, cell_y: 0 })
        .expect("measured: a Sink places on free floor");
    let sink = session.core().state.occupied((11, 0)).expect("the Sink owns its cell");
    let carrier = belt(&mut session, vec![(9, 0), (10, 0)]);
    let sink_h = handle(&session, sink);
    session
        .apply(dock(carrier, BeltEnd::Head, sink_h, 0))
        .expect("measured: the belt's Head docks into the Sink's In");
    session.apply(GridCommand::Delete { node: sink_h }).expect("measured: the Delete is accepted");
    let mut forged = with_last_delete_forged(&session, |op| {
        if let EditOp::Delete { captured, .. } = op {
            assert_eq!(captured.belts.len(), 1, "measured: one cascade belt captured");
            captured.belts[0].links.clear();
        }
    });
    assert!(forged.can_undo(), "PRECONDITION: the forged board offers Undo");
    let err = refusal(&mut forged, GridCommand::Undo);
    assert_eq!(wire_tag_read("F9-81-undo", err), "UndoDoesNotFit", "an inverse the board cannot take is named as an undo that does not fit");
}

// ---------------------------------------------------------------------------
// Plan 88-02 (FAIL-09, D-11): one truth test per tag the split gives the command layer.
//
// Each drives EVERY arm its tag covers through the real `GridSession`, asserts the tag and
// that nothing changed, then reads the shipped sentence and asserts it claims nothing an arm
// proves false, and says the one thing true of all of them.
// ---------------------------------------------------------------------------

/// The live state's bytes, the "nothing changed" witness every test below compares.
fn state_bytes(session: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&session.core().state).expect("state serializes")
}

/// Refuse `cmd` with `want`, and assert the refusal changed nothing.
fn refused_unchanged(session: &mut GridSession, cmd: GridCommand, want: CommandError, why: &str) {
    let before = state_bytes(session);
    assert_eq!(refusal(session, cmd), want, "{why}");
    assert_eq!(state_bytes(session), before, "{why}: nothing changed");
}

/// Assert the sentence names `must` (case-insensitively).
fn assert_says(tag: &str, sentence: &str, must: &str, why: &str) {
    assert!(
        sentence.to_lowercase().contains(must),
        "REFUSAL_COPY.{tag} is {sentence:?}, which does not say {must:?}: {why}",
    );
}

/// A Router Configure with `routes` and `default`.
fn router_table(node: u64, routes: Vec<(fabrico_protocol::RouteKey, u16)>, default: Option<u16>) -> GridCommand {
    GridCommand::Configure { node, config: fabrico_protocol::MachineConfig::Router { routes, default } }
}

/// A rule matching `expect` at offset 0.
fn rule(expect: &[u8]) -> fabrico_protocol::RouteKey {
    fabrico_protocol::RouteKey { offset: 0, expect: expect.to_vec() }
}

/// A label Configure with `text`, `colour` and the size `w` by `h`.
fn label_config(label: u64, text: &str, colour: u8, w: u16, h: u16) -> GridCommand {
    GridCommand::Configure {
        node: label,
        config: fabrico_protocol::MachineConfig::Label { text: text.to_owned(), colour, w, h },
    }
}

/// NoSuchPort (WINDOWS 81): a gesture naming a port the machine does not have. Two arms:
/// 1. `RemovePort` with an index one past the port list;
/// 2. a Router table whose rule, or whose default, names the first output key past the live
///    `Role::Out` ports (derived off the node, so it stays past the end if the arity widens).
///
/// Both frames are read perfectly (round-tripped through `decode_gesture`), so the sentence may
/// not say the host could not read them; it must name the port.
///
/// MUTATION: point `NoSuchPort` at the old `Malformed` sentence ("The host could not carry out
/// that gesture.") and the positive clause reddens on "port".
#[test]
fn the_no_such_port_sentence_is_true_of_every_arm_that_produces_it() {
    let mut session = GridSession::new(SEED);
    let node = router(&mut session, 0, 0);
    let h = handle(&session, node);
    let count = session.core().state.ports_of(node).expect("the preset router declares ports").len();
    let past = u16::try_from(count).expect("a port count fits u16");
    let remove = GridCommand::RemovePort { node: h, index: past };
    let frame = postcard::to_allocvec(&remove).expect("a GridCommand encodes");
    assert_eq!(decode_body(&frame), Ok(GestureFrame::Cmd(remove.clone())), "the host reads it exactly");
    refused_unchanged(&mut session, remove, CommandError::NoSuchPort, "a RemovePort index past the port list");

    let out_past = live_out_count(&session, node);
    refused_unchanged(
        &mut session,
        router_table(h, vec![(rule(b"A"), out_past)], None),
        CommandError::NoSuchPort,
        "a routing rule naming an output past the live Out ports",
    );
    refused_unchanged(
        &mut session,
        router_table(h, Vec::new(), Some(out_past)),
        CommandError::NoSuchPort,
        "a routing default naming an output past the live Out ports",
    );

    let sentence = shipped_sentence("NoSuchPort");
    assert_claims_none(
        "NoSuchPort",
        &sentence,
        &["read", "decode", "limit", "edge", "taken", "carry out", "\u{2014}"],
        "Every arm above decoded perfectly and named a port index the machine does not have.",
    );
    assert_says("NoSuchPort", &sentence, "port", "each arm named a port that is not there");
}

/// UnknownOption (WINDOWS 81): an option byte naming no option the app has. Three arms:
/// an `AddPort` role byte, an `AddPort` medium byte, and a label colour byte.
///
/// MUTATION: point it at the `NoSuchPort` sentence and it reddens on "port" (a label colour
/// names no port).
#[test]
fn the_unknown_option_sentence_is_true_of_every_arm_that_produces_it() {
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 20, 20);
    for (role, medium, what) in [
        (200u8, fabrico_protocol::port_medium::MECHANICAL, "an AddPort role byte naming no role"),
        (fabrico_protocol::port_role::OUT, 200u8, "an AddPort medium byte naming no medium"),
    ] {
        let cmd = GridCommand::AddPort { node: f, role, side: fabrico_core::state::Side::E as u8, medium };
        let frame = postcard::to_allocvec(&cmd).expect("a GridCommand encodes");
        assert_eq!(decode_body(&frame), Ok(GestureFrame::Cmd(cmd.clone())), "{what}: read exactly");
        refused_unchanged(&mut session, cmd, CommandError::UnknownOption, what);
    }
    let (mut session, label) = board_with_a_label();
    refused_unchanged(
        &mut session,
        label_config(label, "Order intake", 200, 4, 1),
        CommandError::UnknownOption,
        "a label colour byte naming no colour",
    );

    let sentence = shipped_sentence("UnknownOption");
    assert_claims_none(
        "UnknownOption",
        &sentence,
        &["read", "decode", "port", "limit", "board", "colour", "role", "carry out", "\u{2014}"],
        "The three arms are a role, a medium and a colour; the frame was read each time and no \
         sentence naming one of the three is true of the other two.",
    );
    assert_says("UnknownOption", &sentence, "not one the app offers", "each byte named no option");
}

/// OverLimit (WINDOWS 81): a setting past a bound the app sets. Five arms: a Router table over
/// `MAX_ROUTES` rules, a rule whose pattern is over `MAX_ROUTE_EXPECT_BYTES`, label text over
/// `MAX_LABEL_BYTES`, a label width of 0, and a label width grown past `LABEL_MAX_W`.
///
/// MUTATION: point it at the `ResizeCovers` sentence and it reddens on the positive clause.
#[test]
fn the_over_limit_sentence_is_true_of_every_arm_that_produces_it() {
    let mut session = GridSession::new(SEED);
    let node = router(&mut session, 0, 0);
    let h = handle(&session, node);
    let too_many: Vec<_> = (0..=fabrico_core::edit::MAX_ROUTES).map(|_| (rule(b"A"), 0u16)).collect();
    refused_unchanged(&mut session, router_table(h, too_many, None), CommandError::OverLimit, "a table over MAX_ROUTES");
    let long = vec![b'A'; fabrico_core::edit::MAX_ROUTE_EXPECT_BYTES + 1];
    refused_unchanged(
        &mut session,
        router_table(h, vec![(rule(&long), 0)], None),
        CommandError::OverLimit,
        "a pattern over MAX_ROUTE_EXPECT_BYTES",
    );

    let (mut session, label) = board_with_a_label();
    let words = "w".repeat(fabrico_core::edit::MAX_LABEL_BYTES + 1);
    refused_unchanged(&mut session, label_config(label, &words, 3, 4, 1), CommandError::OverLimit, "label text over MAX_LABEL_BYTES");
    refused_unchanged(&mut session, label_config(label, "Order intake", 3, 0, 1), CommandError::OverLimit, "a label width of 0");
    refused_unchanged(
        &mut session,
        label_config(label, "Order intake", 3, fabrico_command::LABEL_MAX_W + 1, 1),
        CommandError::OverLimit,
        "a label width grown past LABEL_MAX_W",
    );

    let sentence = shipped_sentence("OverLimit");
    assert_claims_none(
        "OverLimit",
        &sentence,
        &["read", "decode", "port", "path", "edge", "taken", "cover", "carry out", "\u{2014}"],
        "Every arm above read its frame and refused a value past a bound the app sets; none is a \
         port, a path, the grid edge or a collision.",
    );
    assert_says("OverLimit", &sentence, "limit", "each arm is a value past a limit");
}

/// InvalidPath (WINDOWS 81): a Route path that is not a legal address, R-47's rules 1 to 3.
/// Four arms: no leading slash, nothing after the slash, over `MAX_ENDPOINT_PATH_BYTES`, and a
/// byte outside the unreserved URL-path set. A path another Route owns keeps `DuplicatePath`.
///
/// MUTATION: point it at the `DuplicatePath` sentence and it reddens on "another".
#[test]
fn the_invalid_path_sentence_is_true_of_every_arm_that_produces_it() {
    let mut session = GridSession::new(SEED);
    let r = route(&mut session, 4, 4);
    let h = handle(&session, r);
    let set = |path: String| GridCommand::Configure {
        node: h,
        config: fabrico_protocol::MachineConfig::Endpoint { path },
    };
    let over = format!("/{}", "a".repeat(fabrico_core::edit::MAX_ENDPOINT_PATH_BYTES));
    for (path, what) in [
        ("orders".to_owned(), "no leading slash"),
        ("/".to_owned(), "nothing after the slash"),
        (over, "over MAX_ENDPOINT_PATH_BYTES"),
        ("/or ders".to_owned(), "a byte outside the unreserved set"),
    ] {
        refused_unchanged(&mut session, set(path), CommandError::InvalidPath, what);
    }
    session.apply(set("/orders".to_owned())).expect("a legal path is accepted, so the arms above are the rule and not a blanket refusal");

    let sentence = shipped_sentence("InvalidPath");
    assert_claims_none(
        "InvalidPath",
        &sentence,
        &["read", "decode", "another", "used by", "port", "carry out", "\u{2014}"],
        "Every arm above read its frame and refused the address itself; no other Route owns it.",
    );
    assert_says("InvalidPath", &sentence, "path", "each arm is a path the app cannot serve");
}

/// WrongKind (WINDOWS 81): an edit aimed at a node of the wrong kind for it. Two arms: a
/// Rotate naming a label, and a label Configure naming a Source.
///
/// MUTATION: point it at the old `Malformed` sentence and the positive clause reddens.
#[test]
fn the_wrong_kind_sentence_is_true_of_every_arm_that_produces_it() {
    let (mut session, label) = board_with_a_label();
    refused_unchanged(&mut session, GridCommand::Rotate { node: label, ccw: false }, CommandError::WrongKind, "a Rotate naming a label");
    session
        .apply(GridCommand::Place { kind: fabrico_protocol::machine_kind::SOURCE, cell_x: 2, cell_y: 2 })
        .expect("a Source places on free floor");
    let source = session.core().state.occupied((2, 2)).expect("the Source holds its cell");
    let source_h = handle(&session, source);
    refused_unchanged(
        &mut session,
        label_config(source_h, "Order intake", 3, 1, 1),
        CommandError::WrongKind,
        "a label Configure naming a Source",
    );

    let sentence = shipped_sentence("WrongKind");
    assert_claims_none(
        "WrongKind",
        &sentence,
        &["read", "decode", "turn", "label", "port", "limit", "carry out", "\u{2014}"],
        "One arm is a turn of a label and the other a label setting on a machine, so a sentence \
         naming a turn or a label is false of one of them.",
    );
    assert_says("WrongKind", &sentence, "does not apply", "each edit does not apply to what it names");
}

/// UndoDoesNotFit (WINDOWS 81): an Undo whose recorded inverse no longer fits the board. Three
/// `compute_inverse` arms, each reached through a history changed by one field and loaded with
/// `GridSession::replay` (the fold a saved file goes through):
/// 1. a Sink's Delete whose captured cascade belt has lost its links (`identify_belt` finds no
///    belt);
/// 2. a bare belt's Delete whose own captured record has lost its tiles (a restore that would
///    hand back a different board);
/// 3. a Place whose kind byte names no machine, so the action minted nothing and its inverse
///    has no node to take away (the minting-parity check).
///
/// In each the user pressed Ctrl+Z on a board the history no longer describes. The sentence
/// may not offer a placement or a clearing (an Undo chooses no cell), and may not say the host
/// could not read the gesture.
///
/// MUTATION: point it at `UndoSpaceTaken`'s sentence and it reddens on "taken".
#[test]
fn the_undo_does_not_fit_sentence_is_true_of_every_arm_that_produces_it() {
    use fabrico_core::edit::EditOp;
    use fabrico_protocol::{BeltEnd, machine_kind};

    let refused_undo = |mut forged: GridSession, why: &str| {
        let (edits, before) = (forged.edit_log().len(), state_bytes(&forged));
        assert!(forged.can_undo(), "{why}: the forged board offers Undo");
        assert_eq!(refusal(&mut forged, GridCommand::Undo), CommandError::UndoDoesNotFit, "{why}");
        assert_eq!(forged.edit_log().len(), edits, "{why}: nothing was logged");
        assert_eq!(state_bytes(&forged), before, "{why}: nothing was undone");
    };

    // Arm 1: the cascade belt's links stripped.
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place { kind: machine_kind::SINK, cell_x: 11, cell_y: 0 })
        .expect("measured: a Sink places on free floor");
    let sink = session.core().state.occupied((11, 0)).expect("the Sink owns its cell");
    let carrier = belt(&mut session, vec![(9, 0), (10, 0)]);
    let sink_h = handle(&session, sink);
    session.apply(dock(carrier, BeltEnd::Head, sink_h, 0)).expect("measured: the Head docks");
    session.apply(GridCommand::Delete { node: sink_h }).expect("measured: the Delete is accepted");
    refused_undo(
        with_last_delete_forged(&session, |op| {
            if let EditOp::Delete { captured, .. } = op {
                captured.belts[0].links.clear();
            }
        }),
        "a cascade belt whose links name no belt",
    );

    // Arm 2: a bare belt's own record stripped of its tiles.
    let mut session = GridSession::new(SEED);
    let bare = belt(&mut session, vec![(3, 3), (4, 3), (5, 3)]);
    session.apply(GridCommand::Delete { node: bare }).expect("measured: a bare belt's Delete is accepted");
    refused_undo(
        with_last_delete_forged(&session, |op| {
            if let EditOp::Delete { captured, .. } = op {
                match captured.self_record.as_mut() {
                    Some(fabrico_core::edit::DeletedSelf::Belt(own)) => own.geometry.clear(),
                    other => panic!("measured: a bare belt's Delete captures its own belt record, found {other:?}"),
                }
            }
        }),
        "a bare belt's own record with no tiles",
    );

    // Arm 3: a Place whose kind names no machine.
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 6, cell_y: 6 })
        .expect("measured: a Source places on free floor");
    let mut records = session.edit_log().to_vec();
    match &mut records.last_mut().expect("the board has an edit log").op {
        EditOp::Place { kind, .. } => *kind = 250,
        other => panic!("measured: the last record is the Place, found {other:?}"),
    }
    refused_undo(GridSession::replay(SEED, &records), "a Place whose kind minted nothing");

    let sentence = shipped_sentence("UndoDoesNotFit");
    assert_claims_none(
        "UndoDoesNotFit",
        &sentence,
        &["read", "decode", "taken", "elsewhere", "place", "clear", "edge", "carry out", "\u{2014}"],
        "Every arm above was a Ctrl+Z on a board its history no longer describes: the frame was \
         read, no cell is taken, and an Undo chooses no cell to clear or place on.",
    );
    assert_says("UndoDoesNotFit", &sentence, "no longer fits the board", "each inverse no longer fits");
}

/// MachineTooBig (WINDOWS 83): a Factory in the middle of the grid grown by `+ Add output`
/// until the box would pass `MAX_FOOTPRINT_DIM`. Every cell of the last box is far from every
/// grid edge, so a sentence about the edge is false here; the probe above holds the tag.
///
/// MUTATION: point it at the `OutOfBounds` sentence and it reddens on "edge".
#[test]
fn the_machine_too_big_sentence_is_true_of_every_arm_that_produces_it() {
    let mut session = GridSession::new(SEED);
    let f = factory(&mut session, 20, 20);
    let mut adds = 0u32;
    loop {
        let before = state_bytes(&session);
        match session.apply(add_output(f)) {
            Ok(_) => adds += 1,
            Err(e) => {
                assert_eq!(e, CommandError::MachineTooBig, "the add past the size limit, after {adds} adds");
                assert_eq!(state_bytes(&session), before, "nothing grew");
                break;
            }
        }
        assert!(adds < 200, "measured: the size limit is reached well before 200 adds");
    }
    let id = session.core().state.occupied((20, 20)).expect("the Factory owns (20,20)");
    let fp = session.core().state.footprint_of(id).expect("placed");
    assert_eq!(fp.w.max(fp.h), fabrico_core::state::MAX_FOOTPRINT_DIM, "the last box is at the size limit");

    let sentence = shipped_sentence("MachineTooBig");
    assert_claims_none(
        "MachineTooBig",
        &sentence,
        &["edge", "grid", "taken", "elsewhere", "cover", "read", "\u{2014}"],
        "The box was refused because it would pass the size limit, with every cell far from any \
         grid edge and nothing in its way.",
    );
    assert_says("MachineTooBig", &sentence, "size limit", "the cause is the size limit");
}

/// RotateBlocked (WINDOWS 84): a Rotate whose turned box would cover another node that is not a
/// belt. Two arms of the one walk: a MACHINE first in the turned box (a Source), and a LABEL
/// first in it. A belt first keeps `RotateCoversBelt`.
///
/// MUTATION: point it at the `FootprintCollision` sentence and it reddens on "elsewhere".
#[test]
fn the_rotate_blocked_sentence_is_true_of_every_arm_that_produces_it() {
    for (kind, what) in [
        (fabrico_protocol::machine_kind::SOURCE, "a Source in the turned box"),
        (fabrico_protocol::machine_kind::LABEL, "a label in the turned box"),
    ] {
        let mut session = GridSession::new(SEED);
        session
            .apply(GridCommand::Place { kind: fabrico_protocol::machine_kind::ROUTER, cell_x: 10, cell_y: 10 })
            .expect("a Router places on a free 2x3");
        let r = session.core().state.occupied((10, 10)).expect("the Router owns its anchor");
        session
            .apply(GridCommand::Place { kind, cell_x: 12, cell_y: 10 })
            .unwrap_or_else(|e| panic!("{what}: places on (12,10), got {e:?}"));
        let rh = handle(&session, r);
        refused_unchanged(&mut session, GridCommand::Rotate { node: rh, ccw: false }, CommandError::RotateBlocked, what);
    }

    let sentence = shipped_sentence("RotateBlocked");
    assert_claims_none(
        "RotateBlocked",
        &sentence,
        &["elsewhere", "place", "belt", "edge", "machine", "label", "read", "\u{2014}"],
        "A turn keeps its anchor and has no elsewhere; what is in the way is a machine or a \
         label, so a sentence naming one kind is false of the other.",
    );
    assert_says("RotateBlocked", &sentence, "turn", "the refused gesture is a turn");
    assert_says("RotateBlocked", &sentence, "clear", "the one fix true of both arms");
}

/// GrowBlocked (WINDOWS 84): an `AddPort` whose grown box would cover another node that is not
/// a belt. Two arms of the one walk: a MACHINE first in the grown box (a Source on the row the
/// third add grows into), and a LABEL there. A belt first keeps `GrowCoversBelt`.
///
/// MUTATION: point it at the `FootprintCollision` sentence and it reddens on "elsewhere".
#[test]
fn the_grow_blocked_sentence_is_true_of_every_arm_that_produces_it() {
    for (kind, what) in [
        (fabrico_protocol::machine_kind::SOURCE, "a Source where the box grows"),
        (fabrico_protocol::machine_kind::LABEL, "a label where the box grows"),
    ] {
        let mut session = GridSession::new(SEED);
        let f = factory(&mut session, 20, 20);
        for _ in 0..2 {
            session.apply(add_output(f)).expect("outputs two and three fit the 3x3 box");
        }
        session
            .apply(GridCommand::Place { kind, cell_x: 20, cell_y: 23 })
            .unwrap_or_else(|e| panic!("{what}: places on (20,23), got {e:?}"));
        refused_unchanged(&mut session, add_output(f), CommandError::GrowBlocked, what);
    }

    let sentence = shipped_sentence("GrowBlocked");
    assert_claims_none(
        "GrowBlocked",
        &sentence,
        &["elsewhere", "place", "belt", "edge", "turn", "machine", "label", "read", "\u{2014}"],
        "An output add grows the box where it is and has no elsewhere; what is in the way is a \
         machine or a label.",
    );
    assert_says("GrowBlocked", &sentence, "grow", "the refused gesture grows the box");
    assert_says("GrowBlocked", &sentence, "clear", "the one fix true of both arms");
}

// ---------------------------------------------------------------------------
// BoardChanged (phase 88, plan 88-04, WORK-03, D-03): an edit whose board generation is past
// the host's kept handle tables. The host cannot say which node the user picked, so it applies
// nothing; the sentence must not name a node or a place it cannot know.
// ---------------------------------------------------------------------------

/// The sentence a user reads when an edit arrives after more board resets than the host keeps
/// tables for (more than `KEPT_GENERATIONS` Undo or Redo steps since the user read the board).
/// Driven on a real `SimLoop` with the real `RenderProducer`: a Source placed, its handle read,
/// nine Undo/Redo resets folded, then a Delete of that handle stamped with the generation the
/// handle was read under. The refusal is read off the verdict sink as a transport would.
///
/// What is true of the arm: the host resolved no node, so it cannot know whether the edit was
/// aimed at a machine, a label or a belt, nor where; and nothing was changed (the board is
/// asserted equal). So the sentence names no kind (`machine`, `label`, `belt`) and no place
/// (`cell`, `edge`, `space`), and does say the edit was not made.
#[test]
fn the_board_changed_sentence_is_true_of_the_arm_that_produces_it() {
    use std::time::Duration;

    use fabrico_core::core::Core;
    use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
    use fabrico_core::persist::RedbStore;
    use fabrico_host::command_error_view::CommandErrorView;
    use fabrico_host::config::HostConfig;
    use fabrico_host::driver::Host;
    use fabrico_host::gesture_verdict::verdict_channel;
    use fabrico_host::ledger::DispatchLedger;
    use fabrico_host::render_packet::{KEPT_GENERATIONS, RenderProducer};
    use fabrico_host::sim_loop::{GestureSink, SimLoop, gesture_channel};
    use fabrico_host::transport_ws::wire_envelope;
    use fabrico_protocol::{RenderPacket, machine_kind};

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("runtime");
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: SEED });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("store");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("ledger");
    let host = Host::new(core, store, ledger, None).expect("host");
    let (gtx, grx) = gesture_channel();
    let cfg = HostConfig { webhook_addr: "127.0.0.1:0".parse().expect("addr") };
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, grx);
    let (_kf, mut diff) = sim.subscribe();
    // The board as a client holds it, read off every frame the producer broadcasts: the nodes
    // by handle and the generation of the last packet.
    let mut nodes = std::collections::BTreeMap::<u64, fabrico_protocol::NodeView>::new();
    let mut seen = 0u64;
    let mut keep_up = |nodes: &mut std::collections::BTreeMap<u64, fabrico_protocol::NodeView>, seen: &mut u64| {
        while let Ok(frame) = diff.try_recv() {
            let p: RenderPacket = postcard::from_bytes(&frame.bytes).expect("decode a render packet");
            if p.full {
                nodes.clear();
            }
            for h in &p.removed {
                nodes.remove(h);
            }
            for n in p.placed {
                nodes.insert(n.id, n);
            }
            *seen = p.generation;
        }
    };

    gtx.send_gesture(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 4, cell_y: 4 }).expect("send");
    gtx.send_gesture(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 8, cell_y: 4 }).expect("send");
    sim.run(Some(4), Duration::ZERO).expect("fold");
    keep_up(&mut nodes, &mut seen);
    let handle = nodes
        .values()
        .find(|n| (n.cell_x, n.cell_y) == (4, 4))
        .expect("measured: a Source is drawn at (4,4)")
        .id;
    let generation = seen;
    for k in 0..=KEPT_GENERATIONS {
        gtx.send_gesture(if k % 2 == 0 { GridCommand::Undo } else { GridCommand::Redo }).expect("send");
        sim.run(Some(4), Duration::ZERO).expect("fold");
    }
    keep_up(&mut nodes, &mut seen);
    assert_eq!(
        seen,
        generation + KEPT_GENERATIONS as u64 + 1,
        "measured: one reset per Undo or Redo, more than the host keeps"
    );
    let before = postcard::to_allocvec(&sim.host().core().state).expect("state serializes");

    let (verdict_tx, mut verdict_rx) = verdict_channel();
    let body = postcard::to_allocvec(&GridCommand::Delete { node: handle }).expect("encode");
    let decoded = decode_gesture(&frame_gesture(generation, 5, &body)).expect("decodes");
    gtx.send_envelope(wire_envelope(decoded, &verdict_tx)).expect("send");
    sim.run(Some(4), Duration::ZERO).expect("drain");
    let verdict = verdict_rx.try_recv().expect("measured: the Delete is answered");
    assert_eq!(verdict.tag(), Some(CommandErrorView::BoardChanged), "measured: the arm refuses BoardChanged");
    assert_eq!(verdict.seq(), Some(5));
    assert!(verdict_rx.try_recv().is_err(), "measured: exactly one answer");
    assert_eq!(
        postcard::to_allocvec(&sim.host().core().state).expect("state serializes"),
        before,
        "measured: nothing was changed"
    );

    let tag = CommandErrorView::BoardChanged.wire_tag();
    let sentence = shipped_sentence(tag);
    assert_claims_none(
        tag,
        &sentence,
        &["machine", "label", "belt", "cell", "edge", "space", "\u{2014}"],
        "The host resolved no node for this edit: it kept no handle table old enough to say \
         whether the user aimed at a machine, a label or a belt, or where it stood. A sentence \
         that names a kind or a place claims what the host cannot know.",
    );
    assert!(
        sentence.to_lowercase().contains("not made"),
        "REFUSAL_COPY.BoardChanged is {sentence:?}, which does not say the edit was not made: \
         the board is unchanged, asserted above",
    );
}
