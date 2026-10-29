//! Phase 67-03 (CONNECT-03 / SEED-006) — undoing a severing `Rotate` RE-DOCKS what it
//! severed.
//!
//! `GridState::rotate_footprint` drops a dock the rotation spun away from and records it
//! as an `UnlinkedDock` on `core.last_tick.unlinked` (ephemeral telemetry, never
//! snapshotted). Before this phase the command layer ignored that telemetry, so undoing
//! the rotate put the machine back and left the belt stranded — `state.rs`'s Landmine 4,
//! and the fact `frontend/e2e-live/05-undo-strand-ring.spec.ts` asserted as finding #2
//! until 2026-08-30.
//!
//! Phase 63 measured the shape of the fix on the CORE side and froze it in
//! `crates/fabrico-core/tests/footprint_rotation.rs`
//! (`rotate_severed_docks_are_restored_by_folding_their_recorded_dock_records`): the
//! inverse of a severing `Rotate` is N ordinary `EditOp::Dock` records read off
//! `last_tick.unlinked`. No new op, no new serialized shape. This file is the
//! COMMAND-layer half of that claim: the capture-at-issue-time / compensate-on-undo
//! pattern `removed_ports` (PORT-07), `live_prior_configs` (CFG-02) and
//! `DeletedSubgraph` (12-05) already ship.
//!
//! # The assertion discipline, quoted from the frozen proof and copied on purpose
//! > "The severed set is READ, never hand-written. The restore loop iterates
//! > `core.last_tick.unlinked`. A test that hand-listed the dock it expected to be
//! > severed would still pass if the rotate had recorded nothing at all."
//! > — `crates/fabrico-core/tests/footprint_rotation.rs:367-372`
//!
//! Every leg below therefore READS the severed set off the live core and asserts the
//! `links` map is BYTE-IDENTICAL to a map captured in the same run — never a count, and
//! never a hand-written expectation. A count-based assertion passes against a build that
//! re-docked the wrong belt to the wrong port.

use fabrico_command::GridSession;
use fabrico_core::edit::{EditOp, EditRecord};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_protocol::{GridCommand, machine_kind};

const SEED: u64 = 0xFAB_C0DE;

/// The serialized `links` map — the oracle every behavioural leg here asserts on.
///
/// `GridState`-wide equality is unattainable across a rotate (the rotation itself is a
/// real difference), and a link COUNT is satisfiable by a build that re-docked the wrong
/// belt to the wrong port. The links map is the exact surface CONNECT-03 is a claim
/// about, serialized so the comparison is byte-level.
fn link_bytes(session: &GridSession) -> Vec<u8> {
    let links: Vec<((NodeId, PortId), (NodeId, PortId))> =
        session.core().state.links_iter().collect();
    postcard::to_allocvec(&links).expect("serialize the links map")
}

/// Resolve the most-recently-minted node's dense render handle from the view.
fn last_minted_handle(session: &GridSession) -> Option<u64> {
    let id = *session.core().last_tick.placed.last()?;
    session.view().handle_of(id)
}

/// Place a machine of `kind` at a cell and return its dense render handle.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> u64 {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    last_minted_handle(session).expect("the placed node got a handle")
}

/// Draw a belt along `cells` and return the minted belt's dense handle.
fn draw(session: &mut GridSession, cells: Vec<(i32, i32)>) -> u64 {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    last_minted_handle(session).expect("the belt got a handle")
}

/// The proven-valid OFFLOAD geometry: a 2×3 ROUTER anchored at `(0, y)` puts its catalog
/// port 2 (its SECOND Out, routing key 1) at world `(1, y+2)` facing E, and a belt drawn
/// tail-first at `(2, y+2) -> (3, y+2)` presents its tail one step E of that port, facing
/// W = `opposite(E)`. Docking the Tail to port 2 links exactly one directed edge.
///
/// RE-AUTHORED IN 74.1-14: until then this docked catalog port 1, the first Out, which sat
/// on row 2. Under the "Edits keep middle layout" rule (2026-10-04) the first Out
/// sits on the middle row, whose doorstep `(2, y+1)` lies inside the box a clockwise turn
/// sweeps (`x 0..2, y y..y+1`), so every severing Rotate below would be refused as a
/// footprint collision. The belt stays on the row-2 doorstep and docks the Out that now
/// sits there; the subject (a Rotate that severs a dock, and its undo) is unchanged.
/// The port-1 case itself is pinned in `router_rotate_refusal.rs` (plan 74.1-18, the
/// "Refuse, say why" decision): refused both ways as `RotateCoversBelt`.
///
/// Returns `(router_handle, belt_handle)`, docked.
fn docked_router(session: &mut GridSession, y: i32) -> (u64, u64) {
    let r = place(session, machine_kind::ROUTER, 0, y);
    let b = draw(session, vec![(2, y + 2), (3, y + 2)]);
    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: r,
            port: 2,
        })
        .expect("a valid offload dock is accepted");
    (r, b)
}

/// **SC4, the headline.** Undoing a `Rotate` that severed a dock restores that dock: the
/// `links` map after the undo is BYTE-IDENTICAL to the map captured before the rotate.
///
/// The severed set is READ from `core.last_tick.unlinked` and asserted non-empty FIRST,
/// so a build in which the rotate recorded nothing cannot pass this vacuously.
#[test]
fn undo_of_a_severing_rotate_restores_the_dock() {
    let mut session = GridSession::new(SEED);
    let (r, _b) = docked_router(&mut session, 0);

    let docked_links = link_bytes(&session);

    session.apply(GridCommand::Rotate { node: r, ccw: false }).expect("rotate the router");

    // READ the severed set — never hand-write it (the frozen proof's discipline).
    let severed = session.core().last_tick.unlinked.clone();
    assert!(
        !severed.is_empty(),
        "the rotate SEVERED at least one dock and recorded it on last_tick.unlinked — \
         without this the restore assertion below would be vacuous"
    );
    let severed_links = link_bytes(&session);
    assert_ne!(
        docked_links, severed_links,
        "the links map MOVED on the rotate, so the byte equality below is not trivially \
         satisfiable"
    );

    session.apply(GridCommand::Undo).expect("undo the severing rotate");

    assert_eq!(
        docked_links,
        link_bytes(&session),
        "undoing a severing Rotate restores the links map byte-for-byte: CONNECT-03's \
         inverse is N EditOp::Dock records read off last_tick.unlinked"
    );
}

/// A `Rotate` that severed NOTHING compensates with NOTHING. An empty capture is a legal
/// state, not a `Malformed`.
///
/// This is the leg that keeps the compensation from copying `RemovePort`'s
/// capture-miss-is-refusal clause: that refusal belongs to ops whose fold ALWAYS has
/// something to invert. Making an empty capture a refusal here would reject the undo of
/// every ordinary rotate on the board.
#[test]
fn a_rotate_that_severed_nothing_emits_zero_compensating_docks() {
    let mut session = GridSession::new(SEED);
    let r = place(&mut session, machine_kind::ROUTER, 0, 0);

    let bare_links = link_bytes(&session);

    session.apply(GridCommand::Rotate { node: r, ccw: false }).expect("rotate the router");
    assert!(
        session.core().last_tick.unlinked.is_empty(),
        "an undocked machine's rotate severs nothing — the premise of this leg"
    );

    let before_undo = session.edit_log().len();
    session.apply(GridCommand::Undo).expect("undoing a non-severing rotate is not refused");
    let appended: Vec<&EditOp> =
        session.edit_log()[before_undo..].iter().map(|r| &r.op).collect();

    let rotates = appended.iter().filter(|op| matches!(op, EditOp::Rotate { .. })).count();
    let docks = appended.iter().filter(|op| matches!(op, EditOp::Dock { .. })).count();
    assert_eq!(rotates, 1, "the undo group carries exactly one inverse Rotate");
    assert_eq!(docks, 0, "and ZERO compensating Docks — an empty capture emits nothing");
    assert_eq!(bare_links, link_bytes(&session), "the links map never moved at all");
}

/// **Node-keyed attribution.** Two machines, each with its own docked belt, each rotated
/// under its OWN action. Undoing once re-docks ONLY the last-rotated machine's belt; the
/// first machine's belt stays severed. Undoing again re-docks that one too.
///
/// # Why this is the leg that catches a mis-attributed harvest, and the in-batch shape is not
/// Within ONE undo group, mis-attribution is INVISIBLE in the emitted set: the
/// compensating `EditOp::Dock` reads its four fields off the `UnlinkedDock` itself
/// (`u.belt`, `u.endpoint`, `u.node`, `u.port`), never off the `Rotate` record it was
/// filed under, so filing a dock against the wrong record of the SAME group emits the
/// identical record set and the identical `links` map. Attribution only becomes
/// observable ACROSS groups, where filing node A's severance under node B's
/// `(action, sequence)` makes undoing A emit nothing and undoing B over-restore. That is
/// exactly what this leg drives.
#[test]
fn severances_are_attributed_by_node_not_by_batch_position() {
    let mut session = GridSession::new(SEED);
    let (r_a, _b_a) = docked_router(&mut session, 0);
    let (r_b, _b_b) = docked_router(&mut session, 6);

    let both_docked = link_bytes(&session);

    session.apply(GridCommand::Rotate { node: r_a, ccw: false }).expect("rotate machine A");
    assert_eq!(
        session.core().last_tick.unlinked.len(),
        1,
        "machine A's rotate severed exactly its own dock"
    );
    let a_severed = link_bytes(&session);
    assert_ne!(both_docked, a_severed, "A's dock really is gone");

    session.apply(GridCommand::Rotate { node: r_b, ccw: false }).expect("rotate machine B");
    assert_eq!(
        session.core().last_tick.unlinked.len(),
        1,
        "machine B's rotate severed exactly its own dock"
    );
    let both_severed = link_bytes(&session);
    assert_ne!(a_severed, both_severed, "B's dock really is gone too");

    // Undo B's rotate. ONLY B's belt comes back — the links map returns to the state
    // where A alone is severed. A build that filed B's severance under A's key would
    // emit nothing here.
    session.apply(GridCommand::Undo).expect("undo machine B's rotate");
    assert_eq!(
        a_severed,
        link_bytes(&session),
        "undoing B's rotate re-docks B's belt and ONLY B's belt: the links map is \
         byte-identical to the state where A alone was severed"
    );

    // Undo A's rotate. Now both are back and the map equals the original.
    session.apply(GridCommand::Undo).expect("undo machine A's rotate");
    assert_eq!(
        both_docked,
        link_bytes(&session),
        "undoing A's rotate re-docks A's belt too: the links map is byte-identical to \
         the pre-rotate one"
    );
}

/// **The save/load leg — the ONE thing that can see the `reconstruct_projection` twin.**
///
/// A build carrying the LIVE severed-dock capture and NOT its reconstruct-time twin is
/// correct in every live session, correct in the live e2e oracle
/// (`frontend/e2e-live/05-undo-strand-ring.spec.ts`), and silently emits no compensation
/// after a save and a load — because a session rebuilt by
/// [`GridSession::replay`] never folds live, so its `live_severed_docks` map is empty by
/// construction and the canonical `severed_docks` map has nothing to be filled from
/// except the throwaway re-fold. That is the exact pre-Phase-67 behaviour, reachable
/// only in the hardest place to notice it. Research Finding 7; threat T-67-03-04.
///
/// The save/load path is the genuine one, copied from
/// `crates/fabrico-command/tests/undo_save_load.rs`: `session.edit_log()` postcard-encoded
/// (THE on-disk representation `ProjectFile` v5 persists), decoded back, and re-folded
/// through `GridSession::replay`. The undo happens on the REPLAYED session.
#[test]
fn the_compensation_survives_a_save_and_a_load() {
    let mut session = GridSession::new(SEED);
    let (r, _b) = docked_router(&mut session, 0);

    let docked_links = link_bytes(&session);

    session.apply(GridCommand::Rotate { node: r, ccw: false }).expect("rotate the router");
    assert!(
        !session.core().last_tick.unlinked.is_empty(),
        "the rotate SEVERED at least one dock — without this the leg is vacuous"
    );
    let severed_links = link_bytes(&session);
    assert_ne!(docked_links, severed_links, "the links map MOVED on the rotate");

    // SAVE: encode the edit-log exactly as it is persisted on disk.
    let bytes = postcard::to_allocvec(&session.edit_log().to_vec())
        .expect("the edit-log postcard-encodes (the on-disk format)");
    // LOAD: decode it back and re-fold from genesis.
    let records: Vec<EditRecord> =
        postcard::from_bytes(&bytes).expect("the persisted edit-log decodes");
    let mut loaded = GridSession::replay(SEED, &records);
    assert_eq!(
        severed_links,
        link_bytes(&loaded),
        "the load reproduces the severed board before anything is undone (the premise: \
         this leg is about the UNDO, not about the replay)"
    );

    loaded.apply(GridCommand::Undo).expect("undo the severing rotate on the LOADED session");

    assert_eq!(
        docked_links,
        link_bytes(&loaded),
        "undoing a severing Rotate on a session rebuilt from the persisted edit-log \
         restores the links map byte-for-byte: the compensation survives save/load"
    );
}

/// The empty-capture guard ON THE LOAD PATH (the twin of
/// `a_rotate_that_severed_nothing_emits_zero_compensating_docks`).
///
/// The reconstruct-time harvest writes into the same map `compute_inverse` reads with
/// `.get()`, so an ABSENT key must stay "emit nothing" there exactly as it does live. A
/// twin that turned an empty severed set into a `Malformed` would refuse the undo of
/// every ordinary rotate on every loaded board — a strictly worse defect than the one
/// this phase closes.
#[test]
fn a_replayed_rotate_that_severed_nothing_still_undoes_with_no_compensation() {
    let mut session = GridSession::new(SEED);
    let r = place(&mut session, machine_kind::ROUTER, 0, 0);
    session.apply(GridCommand::Rotate { node: r, ccw: false }).expect("rotate the router");
    assert!(
        session.core().last_tick.unlinked.is_empty(),
        "an undocked machine's rotate severs nothing — the premise of this leg"
    );

    let bytes = postcard::to_allocvec(&session.edit_log().to_vec()).expect("encode");
    let records: Vec<EditRecord> = postcard::from_bytes(&bytes).expect("decode");
    let mut loaded = GridSession::replay(SEED, &records);

    let bare_links = link_bytes(&loaded);
    let before_undo = loaded.edit_log().len();
    loaded
        .apply(GridCommand::Undo)
        .expect("undoing a non-severing rotate on a LOADED session is not refused");
    let appended: Vec<&EditOp> =
        loaded.edit_log()[before_undo..].iter().map(|r| &r.op).collect();

    let rotates = appended.iter().filter(|op| matches!(op, EditOp::Rotate { .. })).count();
    let docks = appended.iter().filter(|op| matches!(op, EditOp::Dock { .. })).count();
    assert_eq!(rotates, 1, "the undo group carries exactly one inverse Rotate");
    assert_eq!(docks, 0, "and ZERO compensating Docks on the load path too");
    assert_eq!(bare_links, link_bytes(&loaded), "the links map never moved at all");
}

/// **Redo symmetry.** The undo/redo pair is symmetric: after the undo restores the dock,
/// redoing the `Rotate` severs it again and the `links` map returns to the post-rotate
/// state.
///
/// Both expected maps are CAPTURED IN THE SAME RUN off the live core, never hand-written
/// — the same discipline the SC4 leg reads its severed set with, and for the same reason:
/// a hand-written expectation passes against a build that recorded nothing. This is also
/// what makes the leg an oracle for the redo direction specifically. The redo `Rotate`
/// arm emits no compensating records of its own by design; the re-severance is the FOLD's
/// own deterministic consequence, exactly as it was on the forward rotate.
#[test]
fn redoing_the_rotate_re_severs_the_dock() {
    let mut session = GridSession::new(SEED);
    let (r, _b) = docked_router(&mut session, 0);

    let docked_links = link_bytes(&session);

    session.apply(GridCommand::Rotate { node: r, ccw: false }).expect("rotate the router");
    assert!(
        !session.core().last_tick.unlinked.is_empty(),
        "the rotate SEVERED at least one dock — without this the whole leg is vacuous"
    );
    // Captured in THIS run off the live core, never hand-written.
    let severed_links = link_bytes(&session);
    assert_ne!(docked_links, severed_links, "the links map MOVED on the rotate");

    session.apply(GridCommand::Undo).expect("undo the severing rotate");
    assert_eq!(
        docked_links,
        link_bytes(&session),
        "the undo re-docked (the precondition of the redo claim below)"
    );

    session.apply(GridCommand::Redo).expect("redo the severing rotate");
    assert_eq!(
        severed_links,
        link_bytes(&session),
        "redoing the Rotate re-severs the dock: the links map is byte-identical to the \
         post-rotate map captured in this same run, so the undo/redo pair is symmetric"
    );

    // And the oscillation closes: a second undo re-docks again.
    session.apply(GridCommand::Undo).expect("undo the re-applied rotate");
    assert_eq!(
        docked_links,
        link_bytes(&session),
        "the second undo re-docks again — the compensation is not one-shot"
    );
}

/// **The Landmine 4 grep-parity derivation gate (decision D2).**
///
/// ROADMAP SC4 asked for `state.rs`'s Landmine 4 comment to be "updated to match" the new
/// behaviour, and v8.0's SC5 asked the core freeze gate to exit 0. Under the BYTE-FREEZE
/// those could not both hold: `crates/fabrico-core` was `FROZEN_PATHS[0]` and
/// the core-freeze gate diffed the WORKING TREE, so a comment-only edit there
/// reddened CHECK 2 exactly like a code edit. Decision D2 therefore routed the resolution
/// into `fabrico-command`, at the compensation site, quoting Landmine 4 verbatim so ONE
/// grep finds BOTH sites.
///
/// **That constraint is gone.** Milestone v9.0 phase 70 replaced the byte-freeze with the
/// declared-moves gate, which permits a core edit that
/// is declared in the declared-moves list and refuses one that is not. Plan 70-04 spent
/// that permission: it wrote the resolution sentence into `state.rs` itself and declared
/// the move. Neither file this gate reads is frozen now.
///
/// # Why this is still a test and not a promise in a comment
/// "A grep finds both sites" is a claim about two files that drift independently. Written
/// as prose it would be true on the day it was written and unfalsifiable afterwards, the
/// shape this project has caught repeatedly. So this case READS BOTH FILES OFF DISK AT
/// TEST TIME and asserts each fragment appears exactly once in each. What changed in v9.0
/// is only WHY the two can drift: not "one is frozen and one is not", but that they are
/// two files edited by different plans, and nothing but this gate ties them together.
///
/// # Why fragments and not the whole sentence
/// The Landmine 4 sentence spans several lines of `crates/fabrico-core/src/state.rs` and
/// carries an em dash on the middle one, so no single-line verbatim grep can match the
/// whole of it. The THREE fragments below are its dash-free lines plus the one-line
/// resolution sentence 70-04 added, each unique across `crates/`.
///
/// # The direction of the assertion is deliberate
/// The fragments are asserted against `state.rs`'s text as much as against `command.rs`'s.
/// If a future phase re-words the sentence in either file, this gate goes RED and NAMES
/// the drift, instead of silently passing because the copy in `command.rs` still matches
/// itself. Correct the prose at both sites; never re-point the test at one of them.
#[test]
fn the_landmine_4_resolution_is_greppable_from_both_sites() {
    /// The three dash-free, single-line fragments the two Landmine 4 notes share. Each is
    /// quoted VERBATIM in both files this gate reads.
    ///
    /// The first two are the dash-free lines of `rotate_footprint`'s original Landmine 4
    /// sentence. The third is the one-line resolution sentence Phase 70 plan 70-04 added to
    /// BOTH sites once milestone v9.0's declared-moves gate made the `state.rs` half of it
    /// writable; before that the core was byte-frozen and only `command.rs` could carry it.
    const FRAGMENTS: [&str; 3] = [
        "machine's 4-turn is NOT identity",
        "restored on turn 4; Landmine 4.",
        "undo re-docks what turn 1 severed",
    ];

    // Paths are relative to the crate root (`CARGO_MANIFEST_DIR`), so the gate does not
    // depend on the working directory the test runner was launched from.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let sites = [
        ("crates/fabrico-core/src/state.rs", root.join("../fabrico-core/src/state.rs")),
        ("crates/fabrico-command/src/command.rs", root.join("src/command.rs")),
    ];

    for (label, path) in &sites {
        // A source-text grep-parity gate reading two tracked files under `CARGO_MANIFEST_DIR`,
        // not sim-core I/O: refusing the read would delete the gate. Same narrowly-scoped
        // exemption, and the same reason, as the capability-JSON gate in
        // `fabrico-app/src/lib.rs`. The ban stays deny-level where it means something
        // (`fabrico-core/src/lib.rs` `#![deny(clippy::disallowed_methods)]`); allowing it
        // HERE does not weaken it there.
        #[allow(clippy::disallowed_methods)]
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("the grep-parity gate must be able to READ {label}: {e}"));
        for fragment in FRAGMENTS {
            let hits = text.matches(fragment).count();
            assert_eq!(
                hits, 1,
                "{label} must quote the Landmine 4 fragment {fragment:?} EXACTLY ONCE \
                 (found {hits}). One grep pattern has to find the frozen original in \
                 state.rs and the 67-03 resolution at the fabrico-command compensation \
                 site, and nothing else. If this reddened because the FROZEN sentence was \
                 re-worded, that is the drift this gate exists to name: update the \
                 command-side quotation and this fragment list together."
            );
        }
    }
}

// THE 67-REVIEW CR-01 LEG IS DELETED (plan 85-09, D-02), not rewritten. It minted one node
// straight onto the core, outside the edit log, to put the throwaway re-fold one allocator
// slot behind the live core, which is the only configuration in which the re-fold can invent
// a severance the live fold never had; the shipped demo of the time had that shape. Every
// shipped scene is minted by logged commands since plan 85-08, and placed through a logged
// `Place` the node would leave the two allocators aligned, so the leg could no longer invent
// anything and would prove only what `a_rotate_that_severed_nothing_emits_zero_compensating_docks`
// and `a_replayed_rotate_that_severed_nothing_still_undoes_with_no_compensation` already
// prove. The per-action live-wins merge it pinned stays in `reconstruct_projection` as the
// backstop for a core built by hand.
