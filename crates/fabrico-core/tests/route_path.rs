//! SERVE-08, core half: a Route carries its OWN address as a serialized field, that
//! address defaults to a readable `/route-N` (phase 91, D-13), and it is bounded at
//! BOTH the write gate and the restore gate.
//!
//! # Why the path is a FIELD and not a re-derivation from the edit log
//! D-12 rejects the edit-log re-derivation as WRONG rather than as one option of two.
//! This project's standing rule is that state is fully capturable at a tick boundary
//! with no hidden state living outside snapshots; board configuration re-derived by
//! walking the log is configuration a snapshot cannot see. `project_timers` re-deriving
//! from the log is recorded DEBT, not a pattern to copy. Every test here therefore
//! reads the path off `GridState`, and the round-trip test reads it back out of real
//! snapshot bytes rather than out of the live struct it just wrote.
//!
//! # Everything is minted through a real seam
//! The default path is asserted against a node `fold_place` minted, not one a test
//! constructed, because R-44's whole claim is that NO CALLER CAN MINT A PATHLESS ROUTE.
//! A test that built an `Endpoint` literal with a path of its own choosing would be
//! asserting its author's intent instead of the seam's behaviour.

use fabrico_core::core::Core;
use fabrico_core::edit::{
    EDIT_SCHEMA_VERSION, EditOp, EditRecord, MAX_ENDPOINT_PATH_BYTES, MachineConfig,
};
use fabrico_core::event::{
    DecodeError, Event, EventPayload, LogHeader, SCHEMA_VERSION, StateInvariant,
};
use fabrico_core::fault::{FAULT_PORT, Fault, FaultReason};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::Node;
use fabrico_protocol::machine_kind;
use slotmap::Key;

/// A fresh sim from genesis. The seed is arbitrary and load-bearing nowhere here: no
/// test in this file consumes the RNG stream except through `fold_place`'s Factory arm,
/// which no test in this file exercises.
fn fresh() -> Core {
    Core::genesis(LogHeader {
        schema_version: EDIT_SCHEMA_VERSION,
        seed: 0x0072_0007,
    })
}

/// One `Place{kind}` edit record at `(cell_x, cell_y)`, 1x1, no ports.
fn edit_place(kind: u8, cell_x: i32, cell_y: i32, seq: u64) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick: 0,
        action: seq,
        op: EditOp::Place {
            kind,
            cell_x,
            cell_y,
            w: 1,
            h: 1,
            ports: Vec::new(),
            rot: 0,
        },
    }
}

/// One `Configure{node, config}` edit record with a ZERO code hash (opaque to the fold).
fn edit_configure(node: NodeId, config: MachineConfig, seq: u64) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick: 0,
        action: seq,
        op: EditOp::Configure {
            node,
            config,
            code_hash: [0u8; 32],
        },
    }
}

/// Read a live Route's committed path off `GridState`.
fn path_of(core: &Core, id: NodeId) -> String {
    match core.state.node(id) {
        Some(Node::Endpoint(ep)) => ep.path.clone(),
        other => panic!("expected a live Node::Endpoint at {id:?}, found {other:?}"),
    }
}

/// Place one Route per record through the real fold and return each minted id in order.
///
/// Each record takes its own cell along row 3, so a batch of several is a legal set of
/// placements and the fold mints them in record order.
fn place_routes(core: &mut Core, cells: std::ops::Range<i32>, first_seq: u64) -> Vec<NodeId> {
    let records: Vec<EditRecord> = cells
        .clone()
        .zip(first_seq..)
        .map(|(x, seq)| edit_place(machine_kind::ENDPOINT, x * 2, 3, seq))
        .collect();
    core.advance_edits(&records, &[]);
    let placed = core.last_tick.placed.clone();
    assert_eq!(
        placed.len(),
        records.len(),
        "every Place{{ENDPOINT}} record mints exactly one node"
    );
    placed
}

/// A Route placed on a fresh board reads a readable default path, `/route-1`.
///
/// Phase 91 (CHROME-13, D-13) replaced the id-derived default `/ep-<as_ffi>`, which put
/// a ten-digit slot packing in the Path field and the POST URL of every Route a user
/// placed. The default is minted in the core, inside `add_endpoint`, so every placement
/// path gets it and the host key (the node's path through `endpoint_route_key`) follows
/// with no host change; the host half of this claim is asserted in `fabrico-host`'s
/// `sim_loop` tests, the crate that can see `endpoint_route_key`.
///
/// RED ON HEAD BECAUSE: the old default is id-derived, so the first Route reads
/// `/ep-4294967297` (or whatever its slot packs to), never `/route-1`.
#[test]
fn a_placed_route_answers_at_a_readable_url() {
    let mut core = fresh();
    core.advance_edits(&[edit_place(machine_kind::ENDPOINT, 3, 3, 1)], &[]);

    let id = *core
        .last_tick
        .placed
        .last()
        .expect("a Place{ENDPOINT} mints exactly one node");

    assert_eq!(
        path_of(&core, id),
        "/route-1",
        "a freshly placed Route must default to a readable path, the first unused \
         /route-N, never a number derived from its node id (D-13)"
    );

    // Non-vacuity: the default is not derived from the id. A minter that spelled the id
    // into the path would put the slot packing somewhere in the string.
    assert!(
        !path_of(&core, id).contains(&id.data().as_ffi().to_string()),
        "the default path must not carry the node id's packing"
    );
}

/// The first Route on a fresh board reads `/route-1`.
///
/// RED ON HEAD BECAUSE: the old default is id-derived (`/ep-<as_ffi>`).
#[test]
fn the_first_route_reads_route_1() {
    let mut core = fresh();
    let ids = place_routes(&mut core, 0..1, 1);
    assert_eq!(path_of(&core, ids[0]), "/route-1", "the first Route on a fresh board");
}

/// Two Routes placed in one edit batch fold in order and read `/route-1` and `/route-2`;
/// a third placed in a later tick reads `/route-3`.
///
/// RED ON HEAD BECAUSE: the old default is id-derived (`/ep-<as_ffi>`).
#[test]
fn a_second_route_reads_route_2() {
    let mut core = fresh();
    let batch = place_routes(&mut core, 0..2, 1);
    let later = place_routes(&mut core, 2..3, 3);
    assert_eq!(
        [path_of(&core, batch[0]), path_of(&core, batch[1]), path_of(&core, later[0])],
        ["/route-1".to_owned(), "/route-2".to_owned(), "/route-3".to_owned()],
        "two Routes in one batch take 1 and 2 in record order, and a later one takes 3"
    );
}

/// A Route renamed away from `/route-1` frees that number: the next Route placed reads
/// `/route-1`, not `/route-2`.
///
/// The mint reads the set of paths the board's Endpoints hold right now, so a number is
/// held only while some Route actually answers at it.
///
/// RED ON HEAD BECAUSE: the old default is id-derived (`/ep-<as_ffi>`).
#[test]
fn a_renamed_route_frees_its_number() {
    let mut core = fresh();
    let first = place_routes(&mut core, 0..1, 1)[0];
    assert_eq!(path_of(&core, first), "/route-1", "precondition: the first Route");
    core.advance_edits(
        &[edit_configure(
            first,
            MachineConfig::Endpoint {
                path: "/orders".to_owned(),
            },
            2,
        )],
        &[],
    );
    assert_eq!(path_of(&core, first), "/orders", "precondition: the rename landed");

    let second = place_routes(&mut core, 1..2, 3)[0];
    assert_eq!(
        path_of(&core, second),
        "/route-1",
        "no Route answers at /route-1 any more, so the next one takes it"
    );
}

/// A Route configured to `/route-01` does not hold `/route-1`: the mint compares whole
/// path strings, never the number parsed out of one.
///
/// RED ON HEAD BECAUSE: the old default is id-derived (`/ep-<as_ffi>`).
#[test]
fn a_padded_number_does_not_hold_its_plain_twin() {
    let mut core = fresh();
    let padded = place_routes(&mut core, 0..1, 1)[0];
    core.advance_edits(
        &[edit_configure(
            padded,
            MachineConfig::Endpoint {
                path: "/route-01".to_owned(),
            },
            2,
        )],
        &[],
    );
    assert_eq!(path_of(&core, padded), "/route-01", "precondition: the padded path landed");

    let plain = place_routes(&mut core, 1..2, 3)[0];
    assert_eq!(
        path_of(&core, plain),
        "/route-1",
        "/route-01 is a different path from /route-1, so it holds nothing the mint needs"
    );
}

/// A forged slashless `route-1` holds the number 1 (phase 91 review WR-A-04).
///
/// The host keys a Route by its path through one leading slash (`endpoint_route_key`), and
/// a hand-edited `.fab` can carry a slashless path because `fold_configure` applies records
/// as written, so `route-1` keys as `/route-1`. A mint that compared raw strings would hand
/// the next Route `/route-1` too, and the host's route map would keep one of the two.
///
/// RED BEFORE THE FIX: the mint compared raw path strings, so the second Route read
/// `/route-1`.
#[test]
fn a_forged_slashless_path_holds_its_number() {
    let mut core = fresh();
    let forged = place_routes(&mut core, 0..1, 1)[0];
    core.advance_edits(
        &[edit_configure(
            forged,
            MachineConfig::Endpoint {
                path: "route-1".to_owned(),
            },
            2,
        )],
        &[],
    );
    assert_eq!(path_of(&core, forged), "route-1", "precondition: the forged path landed as written");

    let next = place_routes(&mut core, 1..2, 3)[0];
    assert_eq!(
        path_of(&core, next),
        "/route-2",
        "route-1 keys as /route-1, so the mint skips the number it holds"
    );
}

/// Twenty Routes placed one per tick read `/route-1` to `/route-20` in order, and every
/// minted path passes the core's own write gate and carries exactly one leading slash.
///
/// The slash is what keeps a Route key disjoint from a Source's `src-` key on the host
/// (`endpoint_route_key`), and `endpoint_path_is_valid` is the gate a typed path must
/// pass, so a minted default must pass it too.
///
/// RED ON HEAD BECAUSE: the old default is id-derived (`/ep-<as_ffi>`), so the first path
/// already fails the `/route-` prefix.
#[test]
fn every_minted_path_is_a_valid_route_path() {
    use fabrico_core::edit::endpoint_path_is_valid;

    let mut core = fresh();
    for n in 1..=20_i32 {
        let id = place_routes(&mut core, (n - 1)..n, u64::try_from(n).expect("positive"))[0];
        let path = path_of(&core, id);
        assert_eq!(path, format!("/route-{n}"), "Route {n} placed one per tick");
        assert!(endpoint_path_is_valid(&path), "{path:?} must pass the write gate");
        assert!(
            path.starts_with('/') && !path.starts_with("//"),
            "{path:?} must carry exactly one leading slash"
        );
    }
}

/// A `Configure` carrying a path lands on the node and SURVIVES A SNAPSHOT ROUND TRIP.
///
/// The round trip is the point. Reading the live struct back would pass equally against
/// a design that kept the path host-side, which is exactly the design D-12 rejects.
///
/// RED ON HEAD BECAUSE: `MachineConfig::Endpoint` does not exist.
#[test]
fn a_configure_writes_the_path_onto_the_node() {
    let mut core = fresh();
    core.advance_edits(&[edit_place(machine_kind::ENDPOINT, 3, 3, 1)], &[]);
    let id = *core.last_tick.placed.last().expect("one node minted");

    core.advance_edits(
        &[edit_configure(
            id,
            MachineConfig::Endpoint {
                path: "/orders".to_owned(),
            },
            2,
        )],
        &[],
    );

    assert_eq!(
        path_of(&core, id),
        "/orders",
        "fold_configure's Endpoint arm writes the path onto the live node"
    );

    let bytes = snapshot(&core);
    let restored = restore(&bytes).expect("a live board round-trips through its own snapshot");
    assert_eq!(
        path_of(&restored, id),
        "/orders",
        "the path must come back out of the SNAPSHOT BYTES, which is what makes it \
         board state rather than host state (D-12)"
    );
}

/// The new config variant is appended STRICTLY LAST, so no already-encoded byte moves.
///
/// `Router` was the last variant before this commit, at discriminant 4. Its encoding is
/// pinned against a literal measured on HEAD, which is what makes `EDIT_SCHEMA_VERSION`
/// staying 7 (D-21) CHECKABLE rather than trusted: postcard encodes an enum by
/// declaration index, so an insertion anywhere before `Router` moves this byte.
#[test]
fn the_config_variant_appends_strictly_last() {
    let router = MachineConfig::Router {
        routes: Vec::new(),
        default: Some(3),
    };
    let bytes = postcard::to_allocvec(&router).expect("a config encodes");

    // Measured on HEAD before the append: discriminant 4, an empty route table (len 0),
    // `Some` (1) and the port index 3.
    assert_eq!(
        bytes,
        vec![0x04u8, 0x00, 0x01, 0x03],
        "MachineConfig::Router's bytes must be UNCHANGED by the Endpoint append; a \
         difference here means the new variant was inserted rather than appended and \
         EDIT_SCHEMA_VERSION would have to bump (edit.rs:709-712, D-21)"
    );

    // And the new variant sits directly after it. Asserted on the discriminant byte
    // itself rather than on a `matches!`, because the byte is the contract.
    let endpoint = MachineConfig::Endpoint {
        path: "/a".to_owned(),
    };
    let endpoint_bytes = postcard::to_allocvec(&endpoint).expect("a config encodes");
    assert_eq!(
        endpoint_bytes[0], 0x05,
        "MachineConfig::Endpoint must sit at discriminant 5, strictly after Router (4)"
    );
}

/// Phase 76 (plan 76-02): `MachineConfig::Label` is appended STRICTLY LAST, after this
/// file's own `Endpoint`, so no already-encoded byte moves and `EDIT_SCHEMA_VERSION` stayed
/// 11 (the Endpoint append precedent, pinned above for `Router`); plan 85-05 later moved it
/// to 12 for the Email removal.
///
/// `Endpoint`'s encoding is pinned against a literal measured before the append
/// (discriminant 5, a length-2 string, `/`, `a`), and the new variant's leading byte is 6.
/// Asserted on the bytes rather than on a `matches!`, because the byte is the contract.
///
/// RED AT THE START REVISION: `MachineConfig::Label` does not exist.
#[test]
fn the_label_config_appends_after_endpoint() {
    let endpoint = MachineConfig::Endpoint {
        path: "/a".to_owned(),
    };
    assert_eq!(
        postcard::to_allocvec(&endpoint).expect("a config encodes"),
        vec![0x05u8, 0x02, b'/', b'a'],
        "MachineConfig::Endpoint's bytes must be UNCHANGED by the Label append; a difference \
         here means Label was inserted rather than appended and EDIT_SCHEMA_VERSION would \
         have to bump"
    );
    let label = MachineConfig::Label {
        text: String::new(),
        colour: fabrico_core::state::LabelColour::Sand,
        w: 4,
        h: 1,
    };
    let label_bytes = postcard::to_allocvec(&label).expect("a config encodes");
    assert_eq!(
        label_bytes,
        vec![0x06u8, 0x00, 0x00, 0x04, 0x01],
        "MachineConfig::Label must sit at discriminant 6, strictly after Endpoint (5), \
         carrying text (length 0), colour (Sand, 0), w 4 and h 1 in that order"
    );
    // The Label append moved no edit schema version: it stayed 11. Plan 85-05 then took it
    // to 12 for a different, byte-forced reason (the Email sink target's deletion shifts
    // `SinkTemplate::Http`), and plan 86-02 to 13 (the rotation a Delete undo re-places
    // at), so the literal is re-pinned to the current value and still fails on any silent
    // change.
    assert_eq!(
        EDIT_SCHEMA_VERSION, 13,
        "the edit schema version is 13: unmoved by the Label append, moved by 85-05 and 86-02"
    );
}

/// A forged snapshot carrying an over-long path is refused at `restore` with the typed
/// invariant, and the decoded bytes are never mutated.
///
/// A `String` on a serialized node is a NEW attacker-controlled LENGTH on the rebuild
/// path (threat T-72-07-01). Without this bound a forged `.fab` allocates without limit
/// on load.
///
/// RED ON HEAD BECAUSE: there is no field to forge and no bound to trip.
#[test]
fn an_over_long_path_is_refused_at_restore() {
    let mut core = fresh();
    core.advance_edits(&[edit_place(machine_kind::ENDPOINT, 3, 3, 1)], &[]);
    let id = *core.last_tick.placed.last().expect("one node minted");

    // ONE byte past the bound. A wildly oversized forgery would pass a bound that was
    // off by any amount; one byte past is the only length that measures the bound.
    let forged = format!("/{}", "a".repeat(MAX_ENDPOINT_PATH_BYTES));
    assert_eq!(forged.len(), MAX_ENDPOINT_PATH_BYTES + 1);
    match core.state.node_mut(id) {
        Some(Node::Endpoint(ep)) => ep.path = forged,
        other => panic!("expected a live Node::Endpoint, found {other:?}"),
    }

    let bytes = snapshot(&core);
    // `Core` carries no `Debug`, so the refusal is matched rather than `assert_eq!`d.
    // The variant is named exactly, so a DIFFERENT typed refusal (a generic `Malformed`,
    // say) fails here rather than passing as "it refused something".
    let verdict = restore(&bytes);
    assert!(
        matches!(
            verdict,
            Err(DecodeError::InvalidState(
                StateInvariant::EndpointPathTooLong
            ))
        ),
        "an over-long path must be a TYPED refusal at the trust gate, never an \
         unbounded allocation and never a panic; got {:?}",
        verdict.err()
    );
}

/// The boundary case: a path of exactly `MAX_ENDPOINT_PATH_BYTES` restores fine.
///
/// Phase 71's ruling, cited rather than re-taken (`snapshot.rs:443-453`): the restore
/// bound must ACCEPT WHAT THE LIVE PATH CAN PRODUCE. The Configure gate and the restore
/// gate read the SAME constant, so a board the command layer accepts must reload. A
/// bound one byte tighter than the writer is a save the user cannot open.
#[test]
fn a_path_at_the_bound_restores_fine() {
    let mut core = fresh();
    core.advance_edits(&[edit_place(machine_kind::ENDPOINT, 3, 3, 1)], &[]);
    let id = *core.last_tick.placed.last().expect("one node minted");

    let at_bound = format!("/{}", "a".repeat(MAX_ENDPOINT_PATH_BYTES - 1));
    assert_eq!(at_bound.len(), MAX_ENDPOINT_PATH_BYTES);
    match core.state.node_mut(id) {
        Some(Node::Endpoint(ep)) => ep.path = at_bound.clone(),
        other => panic!("expected a live Node::Endpoint, found {other:?}"),
    }

    let bytes = snapshot(&core);
    let restored = restore(&bytes)
        .expect("a path at exactly the bound is what the live path can produce, so it must load");
    assert_eq!(
        path_of(&restored, id),
        at_bound,
        "the accepted boundary path must come back byte-identical (reject-only gate)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// SERVE-08, the no-cable fault. A POST into a Route with no wire leaving it used to
// be discarded INSIDE THE FOLD: no fault emitted, no node woken, the state byte IDLE
// forever, and the caller's only signal a host-side 504 five seconds later. That is
// the worst shape this codebase has, a request that looks accepted and never happens.
// ─────────────────────────────────────────────────────────────────────────────────

/// One `WireRequest` event addressed to `entry`.
fn wire_request(entry: NodeId, seq: u64, tick: u64) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::WireRequest {
            correlation: 0xC0FF_EE00 + seq,
            deadline_tick: tick + 300,
            budget: 8,
            return_addr: (entry, 0),
            payload: Item(b"ping".to_vec()),
        },
    }
}

/// The `Fault`s resting on `node`'s reserved fault port, decoded.
fn resting_faults(core: &Core, node: NodeId) -> Vec<Fault> {
    core.state
        .inbox_of(node)
        .into_iter()
        .flat_map(|inbox| inbox.items_on(FAULT_PORT))
        .map(|item| Fault::decode(item).expect("a fault this fold pushed decodes"))
        .collect()
}

/// A POST to a Route with NO wire leaving it faults that Route in the same tick.
///
/// RED ON HEAD BECAUSE: `manual_inject.rs`'s `WireRequest` admit arm is an
/// `if let Some(entry_wire) = state.wire_from_node(entry_node)` with NO `else`. When the
/// lookup returns `None` the request is dropped inside the fold: nothing is pushed, the
/// node is never woken, and an Endpoint never steps on its own, so its state byte stays
/// IDLE forever. The only `else` in that arm is the WIRE_INFLIGHT_CAP overflow branch,
/// which is a different accounting entirely.
#[test]
fn a_post_to_a_route_with_no_wire_faults_it_in_the_same_tick() {
    let mut core = fresh();
    core.advance_edits(&[edit_place(machine_kind::ENDPOINT, 3, 3, 1)], &[]);
    let ep = *core.last_tick.placed.last().expect("one node minted");

    // NON-VACUITY, asserted rather than assumed: this board really has no wire out of
    // the Route. Without it the test could pass on a board where the request was
    // admitted and simply never answered.
    assert!(
        core.state.wire_from_node(ep).is_none(),
        "the board under test has NO cable leaving the Route, which is the whole subject"
    );

    core.advance(&[wire_request(ep, 1, core.tick)]);

    let faults = resting_faults(&core, ep);
    assert_eq!(
        faults.len(),
        1,
        "the admit arm must EMIT a fault, not discard the request inside the fold"
    );
    assert_eq!(
        faults[0].reason,
        FaultReason::NoEntryWire,
        "the fault names the cause a user can act on: there is no cable"
    );
    assert_eq!(
        faults[0].source, ep,
        "the fault is attributed to the Route the caller addressed"
    );
    assert!(
        faults[0].payload.is_empty(),
        "the payload is EMPTY by design: there is no dead letter here, so clearing this \
         fault later destroys no evidence (fault.rs:129-131)"
    );
}

/// The node is WOKEN, not merely written to.
///
/// Separate from the fault assertion above on purpose. A fault pushed into an inbox
/// with no wake is a fault nothing will ever look at again: an Endpoint never steps on
/// its own, so the scheduler entry is what turns a written byte into a visible one.
/// This mirrors exactly what the `WireOverflow` branch already does two lines away.
#[test]
fn the_faulted_route_is_woken_so_the_mark_can_be_seen() {
    let mut core = fresh();
    core.advance_edits(&[edit_place(machine_kind::ENDPOINT, 3, 3, 1)], &[]);
    let ep = *core.last_tick.placed.last().expect("one node minted");

    core.advance(&[wire_request(ep, 1, core.tick)]);
    assert!(
        core.last_tick.stepped.contains(&ep),
        "the faulted Route must be in the active set for the tick that faulted it; a \
         write with no wake is the discard this fix replaces, one indirection along"
    );
}

/// `NoEntryWire` is appended at discriminant SEVEN, so no already-encoded fault moves.
///
/// There are SEVEN reasons today (NoMatch 0 through OutputRefused 6). REQUIREMENTS:402
/// says six with a seventh at 6; that is STALE, and inheriting it would REORDER A FROZEN
/// ENUM, silently re-typing every fault in the golden corpus.
#[test]
fn the_new_variant_appends_at_discriminant_seven() {
    // The byte OutputRefused carried before the append, measured on HEAD.
    assert_eq!(
        postcard::to_allocvec(&FaultReason::OutputRefused).expect("a reason encodes"),
        vec![0x06u8],
        "OutputRefused's byte must be UNCHANGED by the append; a difference means \
         NoEntryWire was INSERTED and every fixture carrying a later discriminant now \
         decodes to the wrong reason"
    );
    assert_eq!(
        postcard::to_allocvec(&FaultReason::NoEntryWire).expect("a reason encodes"),
        vec![0x07u8],
        "NoEntryWire sits at 7, strictly after OutputRefused (6)"
    );
    // And every earlier reason still sits where it did. Spelled out rather than implied
    // by the two assertions above, because the append argument is about ALL of them.
    for (n, reason) in [
        FaultReason::NoMatch,
        FaultReason::FactoryError,
        FaultReason::FactoryTimeout,
        FaultReason::CommandTimeout,
        FaultReason::CommandFailure,
        FaultReason::WireOverflow,
        FaultReason::OutputRefused,
        FaultReason::NoEntryWire,
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            postcard::to_allocvec(&reason).expect("a reason encodes"),
            vec![u8::try_from(n).expect("eight variants fit a byte")],
            "{reason:?} must sit at discriminant {n}"
        );
    }
}

/// `BranchBusy` is appended at discriminant EIGHT (phase 87, plan 87-05, JAM-02, D-03), so
/// no already-encoded fault moves.
///
/// NINE reasons exist after it: `NoMatch` 0 through `NoEntryWire` 7, then `BranchBusy`. It
/// carries the branch's port, which postcard writes AFTER the discriminant byte, so the
/// variant's data cannot shift any earlier reason either.
#[test]
fn the_branch_busy_variant_appends_at_discriminant_eight() {
    assert_eq!(
        postcard::to_allocvec(&FaultReason::BranchBusy { branch: 3 }).expect("a reason encodes"),
        vec![0x08u8, 0x03],
        "BranchBusy sits at 8, strictly after NoEntryWire (7), with its branch after it"
    );
    for (n, reason) in [
        FaultReason::NoMatch,
        FaultReason::FactoryError,
        FaultReason::FactoryTimeout,
        FaultReason::CommandTimeout,
        FaultReason::CommandFailure,
        FaultReason::WireOverflow,
        FaultReason::OutputRefused,
        FaultReason::NoEntryWire,
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            postcard::to_allocvec(&reason).expect("a reason encodes"),
            vec![u8::try_from(n).expect("eight variants fit a byte")],
            "{reason:?} must still sit at discriminant {n} after the append"
        );
    }
}

/// CR-01, the core half: the ONE leading slash is part of rule 1, so no two paths this
/// gate accepts can be normalized onto one route key.
///
/// # The defect this pins, stated as the user met it
/// `is_unreserved_path_byte` admits `/`, so `//orders` used to satisfy every rule:
/// length >= 2, byte 0 is `/`, every byte unreserved. Rule 4 (uniqueness) compares RAW
/// strings, so `//orders` and `/orders` were two distinct addresses and neither refused
/// the other. But the host publishes each Route's key through
/// `fabrico_host::sim_loop::endpoint_route_key`, which is
/// `format!("/{}", path.trim_start_matches('/'))` - and `trim_start_matches` strips ALL
/// leading slashes, not one. Both paths keyed as `/orders`, `project_routes` collected
/// them into one `BTreeMap`, and the higher `NodeId` silently won. The shadowed Route's
/// own config card then showed a POST URL that ran the OTHER Route's Handler, with no
/// 404, no fault and no refusal.
///
/// # Why the fix is HERE and not at the key
/// Refusing the leading double slash makes `endpoint_route_key` the IDENTITY on every
/// path this gate admits, so the write gate and the router agree BY CONSTRUCTION rather
/// than by luck, and the trim becomes defensive-only. The host half of that agreement is
/// asserted in `fabrico-host`'s `sim_loop` tests, which is the crate that can see both
/// functions at once.
///
/// # INTERIOR slashes stay legal, and that is a ruling, not an oversight
/// Walk item J-5 ruled that paths allow multiple slashes, meaning MULTI-SEGMENT paths
/// like `/orders/new/id`. Only LEADING slashes are stripped by `trim_start_matches`, so
/// leading is the WHOLE collision surface: `/a//b` keys as `/a//b` and collides with
/// nothing. A rule spelled `!path.contains("//")` would have closed the collision AND
/// refused a path the ruling requires, so the rule is spelled on byte 1 alone.
#[test]
fn a_leading_double_slash_is_refused_and_interior_slashes_are_not() {
    use fabrico_core::edit::endpoint_path_is_valid;

    // REFUSED: every one of these normalizes onto `/orders` under the host's key
    // function while comparing unequal to it as a raw string. That gap IS the defect.
    for path in ["//orders", "///orders", "//", "///", "//a"] {
        assert!(
            !endpoint_path_is_valid(path),
            "{path:?} must be refused: it carries more than one leading slash, so the \
             host would key it as a DIFFERENT accepted path's address and one of the \
             two Routes would silently stop existing (CR-01)"
        );
    }

    // ACCEPTED, and this half is the one the ruling protects. A fix that closed the
    // collision by refusing every repeated slash would refuse these too.
    for path in [
        "/orders",
        "/orders/new",
        "/orders/new/id",
        "/a//b",
        "/a//",
        "/src-1",
        "/ep-1",
    ] {
        assert!(
            endpoint_path_is_valid(path),
            "{path:?} must stay legal: only the LEADING slashes are normalized away by \
             the host key, so an interior empty segment collides with nothing and J-5 \
             requires multi-segment paths to work"
        );
    }
}
