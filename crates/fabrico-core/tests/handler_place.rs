//! SERVE-03/SERVE-04, core half: a HANDLER lands from ONE `Place` record with the ports
//! the palette row claims, and the machine that lands ANSWERS a request with its own
//! JavaScript.
//!
//! # The trap this file exists to close, both halves of it
//! Phase 65 shipped a palette row describing ports the machine did not have. Plan 72-05
//! closed that half by giving `port_catalog` a HANDLER arm. The SECOND half is subtler
//! and is what these tests measure: correct electrical ports plus the stock Factory
//! seed still answers NOTHING, because `DEFAULT_FACTORY_SOURCE` calls `ctx.emit` and
//! never `ctx.command`, so the caller's parked socket resolves only as a 504 on the
//! deadline sweep. A machine that is CALLED a Handler while it has no way to reply is
//! the overstating-label defect this phase is named for.
//!
//! # Everything is PLACED, nothing is hand-built
//! No test here calls `GridState::add_factory` with a source of its own choosing. The
//! Handler is placed through `fabrico_command::GridSession`, which resolves the catalog
//! into the record and folds it, so the source under test is the one `fold_place`
//! seeds. A test that authored the JS itself would be asserting its author's intent
//! instead of the fold's behaviour, and it could not fail for the reason this file
//! cares about.
//!
//! `fabrico-command` is a DEV-dependency of `fabrico-core` (the same dev-only cycle
//! `tests/regen.rs` already uses for the 0014 generator); it never enters the normal
//! build graph, so the headless fence is untouched.

use fabrico_command::{GridSession, port_catalog};
use fabrico_core::command::Effect;
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::state::{Medium, Node, Port, Role, Side};
use fabrico_core::tick::DEFAULT_HANDLER_SOURCE;
use fabrico_protocol::machine_kind;

/// The Handler's catalog port list, spelled out RATHER THAN read from `port_catalog`.
///
/// SERVE-03's acceptance is that the palette copy and the machine agree, so this file
/// asserts BOTH directions: the placed machine equals this literal (so a silent catalog
/// edit is visible right here, in the file a reader opens to learn what a Handler is),
/// AND the placed machine equals `port_catalog(HANDLER)` (so the machine and the row
/// the palette draws cannot drift apart whatever is later decided about the Fault nub).
/// Either assertion alone is weaker than the pair.
fn expected_handler_ports() -> Vec<Port> {
    vec![
        // Index 0, the electrical In. LOAD-BEARING: `step_factory` drains inbox port 0
        // only, and since plan 72-03 the DECLARED MEDIUM of that port is the whole
        // discriminator between a mechanical Factory and an electrical Handler (D-16).
        Port {
            local_offset: (0, 1),
            side: Side::W,
            role: Role::In,
            medium: Medium::Electrical,
        },
        // Index 1, the ONE electrical Out. The arity is load-bearing rather than merely
        // sufficient: with a single Out a second Route's return cable is refused
        // `PortOccupied` at the `DrawWire` from-port rule (D-02).
        Port {
            local_offset: (2, 1),
            side: Side::E,
            role: Role::Out,
            medium: Medium::Electrical,
        },
        // Index 2, the Fault nub. MECHANICAL: a fault drain carries items, not requests.
        Port {
            local_offset: (1, 2),
            side: Side::S,
            role: Role::Fault,
            medium: Medium::Mechanical,
        },
    ]
}

/// The caller's correlation. A distinct value so an observation names WHOSE reply it saw.
const CORRELATION: u64 = 0x5EED_0001;

/// The per-request hop budget. Well above the two hops this board takes, so nothing here
/// can pass or fail for a depth-bound reason.
const BUDGET: u64 = 8;

/// Place ONE Handler through the real command surface and return the session plus the
/// `NodeId` the fold minted.
///
/// One `GridCommand::Place`, one action id. `validate_normalize` resolves
/// `port_catalog(HANDLER)` into the record and `fold_place` applies it verbatim.
fn place_one_handler() -> (GridSession, NodeId) {
    let mut session = GridSession::new(7);
    session
        .apply(fabrico_protocol::GridCommand::Place {
            kind: machine_kind::HANDLER,
            cell_x: 4,
            cell_y: 4,
        })
        .expect("the command layer accepts a Place{HANDLER}: it has a catalog arm");
    let id = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("a Place{HANDLER} mints exactly one node");
    (session, id)
}

/// Folding ONE `Place{HANDLER}` record yields a live `Node::Factory` on a 3x3 footprint
/// whose ports equal the catalog exactly, length included.
///
/// RED ON HEAD BECAUSE: `fold_place`'s match had no `machine_kind::HANDLER` arm, so byte
/// 10 fell through to `_ => return` and minted NOTHING. `last_tick.placed` was empty and
/// the `.expect` in `place_one_handler` panicked before any assertion below could run.
#[test]
fn place_handler_mints_a_factory_with_the_catalog_port_list() {
    let (session, id) = place_one_handler();
    let state = &session.core().state;

    // A Handler IS a `Node::Factory` (D-11 adds no `Node` variant). That is the fact
    // four of the five non-exhaustive `Node::Factory` sites in the workspace rest on.
    assert!(
        matches!(state.node(id), Some(Node::Factory(_))),
        "a placed HANDLER is a Node::Factory - D-11 adds no Node variant"
    );

    let fp = state
        .footprint_of(id)
        .expect("a 3x3 Place writes a footprint entry");
    assert_eq!(
        (fp.w, fp.h, fp.rot),
        (3, 3, 0),
        "a Handler stands on the Factory's already-measured 3x3 chassis"
    );

    let ports = state
        .ports_of(id)
        .expect("a Handler declares ports, so the fold wrote a ports entry")
        .to_vec();

    // EXACT, length included. Not "contains an electrical In": whatever is later decided
    // about the Fault nub, this list moves or this test reddens.
    assert_eq!(
        ports,
        expected_handler_ports(),
        "the placed Handler's port list must equal the catalog list EXACTLY, length \
         included (SERVE-03: the palette copy and the machine agree)"
    );

    // And the same list, read from the catalog the palette itself draws from. This is
    // the direction that catches a catalog edit nobody mirrored into this file.
    assert_eq!(
        ports,
        port_catalog(machine_kind::HANDLER).1,
        "the placed Handler's ports must equal port_catalog(HANDLER): the machine and \
         the row the palette draws are ONE contract"
    );

    // Non-vacuity for the medium clause, asserted rather than assumed. Strip the medium
    // out of the comparison above and a HANDLER port list is byte-identical to the
    // FACTORY's geometry, so the medium is the only field distinguishing the two.
    assert_eq!(
        ports[0].medium,
        Medium::Electrical,
        "port 0 is the port `step_factory` drains and `admit::inbox_class` reads; a \
         mechanical one strands every request on a board that looks correct (D-16)"
    );
}

/// A placed Handler ANSWERS a wire request with the body its seeded JS returns.
///
/// RED ON HEAD TWICE OVER: no HANDLER arm existed, so nothing was minted to drive; and a
/// `Node::Factory` reached by any other route carries `DEFAULT_FACTORY_SOURCE`, which
/// calls `ctx.emit` and never `ctx.command`, so it emits no `Effect::Reply` at all and
/// the caller's request resolves only as a 504 on the deadline sweep.
#[test]
fn a_placed_handler_answers_a_request_with_the_preset_body() {
    let (mut session, handler) = place_one_handler();

    // The caller and the two cables are seeded through the core `add_wire` seam the
    // golden corpus itself uses. Only the HANDLER is under test here; the caller is
    // scenery, and building it by gesture would add a second subject to this test.
    let (caller, _forward, return_wire) = {
        let core = session.core_mut();
        let caller = core.state.add_endpoint();
        core.state.set_ports(
            caller,
            vec![Port {
                local_offset: (0, 0),
                side: Side::E,
                role: Role::Out,
                medium: Medium::Electrical,
            }],
        );
        // Forward: caller -> handler inbox port 0 (the electrical In).
        let forward = core.state.add_wire((caller, 0), (handler, 0));
        core.state.link((forward, 0), (handler, 0));
        // Return: out of the handler's ONE electrical Out (port index 1) back to the
        // caller. `route_replies` selects it by the address the reply carries.
        let return_wire = core.state.add_wire((handler, 1), (caller, 0));
        core.state.link((return_wire, 0), (caller, 0));
        (caller, forward, return_wire)
    };

    // NON-VACUITY, pinned rather than assumed: the seed really is the reply-shaped one.
    // Without this the test could pass on a board whose handler was seeded by some other
    // path, and it would then be measuring the wire transport rather than the seed.
    let seeded = match session.core().state.node(handler) {
        Some(Node::Factory(f)) => f.source.clone(),
        _ => panic!("the placed Handler is a Node::Factory"),
    };
    assert_eq!(
        seeded, DEFAULT_HANDLER_SOURCE,
        "fold_place seeds a HANDLER with DEFAULT_HANDLER_SOURCE, not \
         DEFAULT_FACTORY_SOURCE (which emits and never replies)"
    );

    // Admit ONE request and run the board out. `advance` returns the tick's command
    // intent, which is where the reply seam puts `Effect::Reply`.
    let request = Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 1,
        tick: session.core().tick,
        payload: EventPayload::WireRequest {
            correlation: CORRELATION,
            deadline_tick: 500,
            budget: BUDGET,
            return_addr: (caller, 0),
            // Valid JSON: the sandbox parses the request body before the handler runs.
            payload: Item(b"{\"n\":1}".to_vec()),
        },
    };
    let mut replies: Vec<Vec<u8>> = Vec::new();
    let mut commands = session.core_mut().advance(&[request]);
    for _ in 0..12 {
        for cmd in &commands {
            if let Effect::Reply {
                correlation,
                payload,
                ..
            } = &cmd.effect
            {
                assert_eq!(
                    *correlation, CORRELATION,
                    "the reply resolves the request that was admitted"
                );
                replies.push(payload.0.clone());
            }
        }
        commands = session.core_mut().advance(&[]);
    }

    assert_eq!(
        replies.len(),
        1,
        "exactly ONE Effect::Reply was emitted for one request (saw {})",
        replies.len()
    );
    let body = String::from_utf8_lossy(&replies[0]).into_owned();
    assert!(
        body.contains("hello from fabrico"),
        "the reply carries the body the SEEDED source returns. Got: {body}"
    );
    assert!(
        body.contains("200"),
        "the reply carries the status the seeded source returns. Got: {body}"
    );

    // And it goes home: the reply was admitted to the cable that points at the caller.
    assert!(
        matches!(
            session.core().state.node(return_wire),
            Some(Node::Wire(link)) if link.to.0 == caller
        ),
        "the return cable points at the caller the reply is owed to"
    );
}

/// The seeded source is MULTI-LINE and carries a findable `body:` line.
///
/// RED ON HEAD BECAUSE: `DEFAULT_HANDLER_SOURCE` did not exist. This is a walk
/// requirement rather than decoration: `72-UI-SPEC.md` section 4.1 records that the walk
/// step which judges this phase is "change the returned body", and the `body:` line has
/// to be findable in the config card's editor in under a second. A one-line handler
/// source fails this walk, so no one-liner is used as the seed.
#[test]
fn the_seeded_source_is_multi_line_with_a_findable_body_line() {
    let lines: Vec<&str> = DEFAULT_HANDLER_SOURCE.lines().collect();
    assert!(
        lines.len() > 1,
        "the seeded source spans more than one line (got {} line(s)): a one-liner puts \
         the body inside a horizontally-scrolled row",
        lines.len()
    );
    let body_lines: Vec<&&str> = lines.iter().filter(|l| l.contains("body:")).collect();
    assert_eq!(
        body_lines.len(),
        1,
        "exactly ONE line carries a `body:` assignment, so the walk step lands on it \
         without a choice to make (got {body_lines:?})"
    );
    assert!(
        body_lines[0].contains("hello from fabrico"),
        "the `body:` line carries the preset body, so changing it changes what the \
         webhook caller reads back. Got: {}",
        body_lines[0]
    );
    // The reply call itself, so a future edit cannot leave a multi-line source that has
    // a `body:` key and still never replies.
    assert!(
        DEFAULT_HANDLER_SOURCE.contains("ctx.command("),
        "the seeded source CALLS ctx.command. This is the whole difference from \
         DEFAULT_FACTORY_SOURCE, which emits and never answers"
    );
}
