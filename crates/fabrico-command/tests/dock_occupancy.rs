//! LINK-06 (74-06): A REPEAT DROP IS REFUSED IN A SENTENCE, and the connection the user
//! already drew survives it.
//!
//! # What was measured on HEAD before this file existed
//! The `Dock` validate arm had NO occupancy guard of any kind. `fold_dock` writes its
//! link with `GridState::link`, a bare `BTreeMap::insert`, so a second `Dock` naming an
//! output that was already carrying one returned `Ok`, replaced the entry, and the first
//! connection was gone with nothing on screen saying so. WINDOWS row 128. That is silent
//! loss of topology the user drew, and it becomes a shipped pointer gesture the day belts
//! can dock to belts, which is this same phase.
//!
//! # The oracle is the SERIALIZED `GridState`, and only that
//! Every refusal row here compares `postcard::to_allocvec(&core.state)` taken before the
//! refused command against the same bytes taken after it.
//!
//! **Never the whole `Core` and never a `snapshot` blob.** `Core::tick` is a serialized
//! field and `GridSession::apply` advances it on every accepted record, so a `Core`-level
//! byte comparison taken across two applies is unsatisfiable BY CONSTRUCTION: it can only
//! ever be red, and whoever hit it next would rewrite it unsupervised. `GridState` is the
//! thing a refusal is claiming not to have touched, so `GridState` is what is compared.
//!
//! # Why a link-map check would not have been enough
//! A guard that refused AFTER a partial write passes "the link map still names the first
//! target" and fails the byte comparison. Both assertions are made, in that order, for
//! that reason.
//!
//! # Why the guard is ABOVE the fold and never inside it
//! [`the_guard_is_above_the_fold_so_a_certified_log_still_replays`] is the control for
//! that. `fold_dock` calls `GridState::link` on EVERY replay and the fold never
//! re-validates by design (decision Q2), so an occupancy guard placed in `link` would
//! make a legitimate certified log refuse itself the second time it was read. That is a
//! determinism break dressed up as a safety check.
//!
//! Run target: `cargo test -p fabrico-command --test dock_occupancy`.

use fabrico_command::{CommandError, GridLookup, GridSession};
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::NodeId;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0074_0006_D0C4_0000;

/// The serialized `GridState` - the oracle every refusal row asserts on. See the module
/// header for why this is `GridState` and never `Core` or `snapshot`.
fn state_bytes(session: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&session.core().state).expect("GridState serializes")
}

/// Draw a belt along `cells` and return `(node id, dense handle)`.
fn draw(session: &mut GridSession, cells: Vec<(i32, i32)>) -> (NodeId, u64) {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    let id = *session.core().last_tick.placed.last().expect("the belt was minted");
    let handle = session.view().handle_of(id).expect("the belt got a handle");
    (id, handle)
}

/// Place a machine of `kind` at a cell and return `(node id, dense handle)`.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> (NodeId, u64) {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    let id = *session.core().last_tick.placed.last().expect("the placed node was minted");
    let handle = session.view().handle_of(id).expect("the placed node got a handle");
    (id, handle)
}

/// THE BOARD THAT MAKES A REPEAT DROP REACHABLE, and the reason it is shaped this way.
///
/// A multi-tile belt end has an INHERENT outward side, and the facing-opposite rule then
/// pins its dock partner to exactly ONE cell - so a multi-tile carrier can never have two
/// geometrically valid targets and the second drop could only ever be onto the SAME
/// target, which is a much weaker claim.
///
/// A SINGLE-TILE belt has an end cell and no inherent direction (`outward == None`), and
/// the Dock arm says so in its own words: "adjacency+facing alone decides". So a one-tile
/// carrier at `(3,3)` has TWO genuinely different, genuinely valid Head targets, one on
/// either side, and the second drop names a target the first did not.
///
/// ```text
///        B                S              C
///   (1,3)--(2,3)        (3,3)       (4,3)--(5,3)
///   head    tail                     tail    head
///           outward E                outward W
/// ```
///
/// Returns `(session, carrier id, carrier handle, B id, B handle, C id, C handle)`.
fn two_valid_targets() -> (GridSession, NodeId, u64, NodeId, u64, NodeId, u64) {
    let mut session = GridSession::new(SEED);
    // B, drawn TAIL FIRST: `route` keeps the drawn order, so cells[0] is the Tail and
    // cells[last] is the Head. B's Tail sits at (2,3) with its inner neighbour at (1,3),
    // so its outward side is E and its outward step lands on (3,3).
    let (b_id, b_h) = draw(&mut session, vec![(2, 3), (1, 3)]);
    // C, the mirror: Tail at (4,3), inner neighbour (5,3), outward W, outward step (3,3).
    let (c_id, c_h) = draw(&mut session, vec![(4, 3), (5, 3)]);
    // The one-tile carrier, drawn last so it cannot collide with either target.
    let (s_id, s_h) = draw(&mut session, vec![(3, 3)]);
    (session, s_id, s_h, b_id, b_h, c_id, c_h)
}

/// The refusal's variant NAME, read through `Debug` (`"Some(BeltEndTaken)"`). Plan 74.1-32
/// asserts the belt-end tag by name so these rows compiled, and ran red, on the revision
/// before `CommandError::BeltEndTaken` existed.
fn tag_name<T>(verdict: Result<T, CommandError>) -> String {
    format!("{:?}", verdict.err())
}

/// **THE HEADLINE.** A belt end that is already connected refuses the second drop with
/// `BeltEndTaken` (plan 74.1-32, the re-walk's HEAD-WORDS: until then it was `PortOccupied`,
/// whose sentence calls the dragged belt end an output), keeps the FIRST connection, and
/// mutates zero bytes doing it. This is the HEAD arm: the carrier is a drawn belt whose own
/// Head already feeds something.
///
/// RED ON HEAD BECAUSE (74-06): with no occupancy guard in the Dock arm the second command
/// returns `Ok(())`, `link_target((S,0))` reads `Some((C,0))` - the target the user did
/// NOT already have - and the state bytes differ. All three assertions below fail.
#[test]
fn a_second_head_dock_is_refused_and_the_first_join_survives_byte_for_byte() {
    let (mut session, s_id, s_h, b_id, b_h, _c_id, c_h) = two_valid_targets();

    // The FIRST drop, through the certified path. Port 0 is the target's Tail: a belt
    // declares `Role::In` first (74-02), so index 0 is the admit end a Head dock names.
    session
        .apply(GridCommand::Dock { belt: s_h, endpoint: BeltEnd::Head, node: b_h, port: 0 })
        .expect("the first join is a valid Head dock onto B's Tail");
    assert_eq!(
        session.core().state.link_target((s_id, 0)),
        Some((b_id, 0)),
        "the accepted first join links the carrier's port 0 to B's port 0",
    );

    // The oracle, captured on the live board the refusal is about to be asked of.
    let before = state_bytes(&session);

    // THE REPEAT DROP. C is a DIFFERENT target and its geometry is just as valid as B's,
    // so this command clears adjacency, facing and role and dies on occupancy alone.
    let verdict =
        session.apply(GridCommand::Dock { belt: s_h, endpoint: BeltEnd::Head, node: c_h, port: 0 });
    assert_eq!(
        tag_name(verdict),
        "Some(BeltEndTaken)",
        "a second dock of an already-joined belt end is refused BeltEndTaken, a belt-end tag",
    );

    // HALF ONE: the connection the user drew is still the one they drew. Named, never
    // counted: a count is satisfied by a build that replaced B with C.
    assert_eq!(
        session.core().state.link_target((s_id, 0)),
        Some((b_id, 0)),
        "the refused drop left the FIRST join intact and pointing at B",
    );
    // HALF TWO, strictly stronger: the refusal moved NOTHING. A guard that refused after
    // a partial write would pass half one and fail here.
    assert_eq!(
        state_bytes(&session),
        before,
        "a refused Dock mutates zero bytes of GridState",
    );
}

/// THE TAIL ARM of `BeltEndTaken` (plan 74.1-32, HEAD-WORDS): a Tail dock whose TARGET is
/// a drawn belt whose Head already feeds something. The source of that dock is the target
/// belt's end, so the user is told the belt end is taken, not that an output is.
///
/// ```text
///                Z (3,3)
///                  (3,4) tail, outward S
///   A (1,5)-(2,5)-(3,5) head, outward E  ->  X (4,5)-(5,5)
/// ```
///
/// A's Head joins X's Tail first. Z's Tail is one orthogonal step from A's Head, not on A's
/// inner tile, and turning across (outward S against A's E), so every geometric clause
/// passes and only occupancy refuses.
///
/// RED AT THE START REVISION OF PLAN 74.1-32 BECAUSE: the arm returned `PortOccupied`.
#[test]
fn a_tail_dock_onto_a_belt_whose_head_is_already_joined_is_refused_belt_end_taken() {
    let mut session = GridSession::new(SEED);
    let (a_id, a_h) = draw(&mut session, vec![(1, 5), (2, 5), (3, 5)]);
    let (x_id, x_h) = draw(&mut session, vec![(4, 5), (5, 5)]);
    let (_z_id, z_h) = draw(&mut session, vec![(3, 4), (3, 3)]);
    session
        .apply(GridCommand::Dock { belt: a_h, endpoint: BeltEnd::Head, node: x_h, port: 0 })
        .expect("A's Head joins X's Tail");
    assert_eq!(
        session.core().state.link_target((a_id, 0)),
        Some((x_id, 0)),
        "A's Head feeds X",
    );

    let before = state_bytes(&session);
    let log_len = session.edit_log().len();
    // Port 1 is A's Head: a belt declares `Role::In` first and `Role::Out` second.
    let verdict =
        session.apply(GridCommand::Dock { belt: z_h, endpoint: BeltEnd::Tail, node: a_h, port: 1 });
    assert_eq!(
        tag_name(verdict),
        "Some(BeltEndTaken)",
        "a Tail dock onto a belt end that already feeds something is refused BeltEndTaken",
    );
    assert_eq!(
        session.core().state.link_target((a_id, 0)),
        Some((x_id, 0)),
        "the refused drop left A feeding X",
    );
    assert_eq!(state_bytes(&session), before, "the refusal mutates zero bytes of GridState");
    assert_eq!(session.edit_log().len(), log_len, "the refusal logs nothing");
}

/// The MACHINE half keeps `PortOccupied` (plan 74.1-32): a Tail dock onto a machine Out
/// that already feeds a belt names an output the user really dropped on, and its sentence
/// ("That output is already connected. Disconnect it first.") is true of it. The doorstep
/// rule pins one cell per machine port, so the repeat drop is the same belt dropped again.
#[test]
fn a_tail_dock_onto_a_machine_out_already_linked_keeps_port_occupied() {
    let mut session = GridSession::new(SEED);
    // A ROUTER at (0,0): catalog index 1 is its first Out, at world (1,1) facing E.
    let (router_id, router_h) = place(&mut session, machine_kind::ROUTER, 0, 0);
    let (belt_id, belt_h) = draw(&mut session, vec![(2, 1), (3, 1)]);
    session
        .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Tail, node: router_h, port: 1 })
        .expect("the belt's Tail docks on the Router's first Out");
    assert_eq!(
        session.core().state.link_target((router_id, 0)),
        Some((belt_id, 0)),
        "the Router's first Out feeds the belt",
    );
    let before = state_bytes(&session);
    let verdict = session.apply(GridCommand::Dock {
        belt: belt_h,
        endpoint: BeltEnd::Tail,
        node: router_h,
        port: 1,
    });
    assert_eq!(
        verdict.err(),
        Some(CommandError::PortOccupied),
        "an already-linked machine Out keeps the output sentence's tag",
    );
    assert_eq!(state_bytes(&session), before, "the refusal mutates zero bytes of GridState");
}

/// The SAME rule on the non-spatial `FAULT_PORT` sentinel, which reaches the accept
/// through a branch that checks no geometry at all.
///
/// A `SOURCE` declares one `Role::Out` and no `Role::Fault` port, so `FAULT_PORT` does
/// not resolve to a spatial nub and the Tail dock skips adjacency, facing and the belt's
/// geometry entirely. That branch had no guard either, and it is the EASIEST one to
/// overwrite: any belt anywhere on the board can name it.
///
/// RED ON HEAD BECAUSE: the second command returns `Ok(())` and
/// `link_target((source, FAULT_PORT))` reads the SECOND belt.
#[test]
fn a_second_tail_dock_onto_the_non_spatial_fault_sentinel_is_refused_the_same_way() {
    let mut session = GridSession::new(SEED);
    let (src_id, src_h) = place(&mut session, machine_kind::SOURCE, 10, 10);
    let (first_id, first_h) = draw(&mut session, vec![(20, 20), (21, 20)]);
    let (_second_id, second_h) = draw(&mut session, vec![(20, 22), (21, 22)]);

    session
        .apply(GridCommand::Dock {
            belt: first_h,
            endpoint: BeltEnd::Tail,
            node: src_h,
            port: FAULT_PORT,
        })
        .expect("a Tail dock onto the non-spatial fault sentinel is valid");
    assert_eq!(
        session.core().state.link_target((src_id, FAULT_PORT)),
        Some((first_id, 0)),
        "the fault sentinel now feeds the first belt",
    );

    let before = state_bytes(&session);
    let verdict = session.apply(GridCommand::Dock {
        belt: second_h,
        endpoint: BeltEnd::Tail,
        node: src_h,
        port: FAULT_PORT,
    });
    assert_eq!(
        verdict.err(),
        Some(CommandError::PortOccupied),
        "the fault sentinel refuses a second belt on the same terms as a spatial port",
    );
    assert_eq!(
        session.core().state.link_target((src_id, FAULT_PORT)),
        Some((first_id, 0)),
        "the refused drop left the first fault belt attached",
    );
    assert_eq!(
        state_bytes(&session),
        before,
        "a refused fault-sentinel Dock mutates zero bytes of GridState",
    );
}

/// THE WIRE HALF, which `link_exists` structurally cannot see.
///
/// A drawn wire's ONE `links` entry is keyed on the WIRE's own port 0, never on the
/// source port it leaves, so `links` records NOTHING at that port and `link_exists` is
/// blind to it. `validate_draw_wire` step 6 says exactly that in its own docblock and
/// asks BOTH predicates; this is the Dock arm being held to the same rule.
///
/// # Why this board is built at the core seam, and why that is honest here
/// `GridState::add_wire` is called directly because no `GridCommand` can produce this
/// state today: `DrawWire` refuses a `Mechanical` source port with `MediumMismatch`
/// before it ever reaches its own occupancy step, so a wire out of a Router's Mechanical
/// `Out` is unreachable through the command layer. `belt_backpressure_meet.rs`'s
/// `drive_meet` builds its junction the same way and for the same reason.
///
/// The check is still load-bearing rather than decorative, on two counts. It is the half
/// of a two-half rule whose other half is unreachable in the OTHER direction, so a rule
/// that asked only one would be silently partial. And this plan's own task 2 makes it
/// reachable through the certified path: a `Dock` naming a WIRE carrier runs the medium
/// gate on `Electrical`, so the electrical `Out` a real wire leaves becomes a port a
/// `Dock` can name. `wire_unlink_redock.rs` asserts that half end to end.
///
/// RED ON HEAD BECAUSE: there is no guard at all. It is ALSO red on a build whose guard
/// asks `link_exists` alone, which is what makes it the discriminating row: `links` holds
/// no entry at the Router's Out, so only `wire_from_port_exists` can answer.
#[test]
fn a_dock_onto_a_port_a_wire_already_leaves_is_refused_by_the_wire_half() {
    let mut session = GridSession::new(SEED);
    // A ROUTER anchored at (0,0): catalog index 1 is its FIRST `Role::Out`, Mechanical,
    // at world (1,1) facing E (the middle row since plan 74.1-14; it was (1,2)). The proven-valid offload geometry lifted verbatim from
    // `remove_port_redock.rs`'s `docked_router`.
    let (router_id, router_h) = place(&mut session, machine_kind::ROUTER, 0, 0);
    let (sink_id, _sink_h) = place(&mut session, machine_kind::SINK, 10, 10);
    let (belt_id, belt_h) = draw(&mut session, vec![(2, 1), (3, 1)]);

    // The wire, minted at the core seam. Its `WireLink.from` is the RAW catalog index the
    // client named, which is the keyspace `wire_from_port` reads.
    let wire = session.core_mut().state.add_wire((router_id, 1), (sink_id, 0));
    assert!(
        session.core().state.node(wire).is_some(),
        "the wire was minted and is live",
    );
    // The load-bearing measurement: `links` holds NOTHING at the Router's Out, so a guard
    // that asked `link_exists` alone would see a free port and accept.
    assert_eq!(
        session.core().state.link_target((router_id, 0)),
        None,
        "the wire wrote no `links` entry at the source port - this is why link_exists is blind",
    );

    let before = state_bytes(&session);
    let verdict = session.apply(GridCommand::Dock {
        belt: belt_h,
        endpoint: BeltEnd::Tail,
        node: router_h,
        port: 1,
    });
    assert_eq!(
        verdict.err(),
        Some(CommandError::PortOccupied),
        "an output a wire already leaves refuses a belt dock, through the wire half",
    );
    assert_eq!(
        session.core().state.link_target((router_id, 0)),
        None,
        "the refused dock wrote no link",
    );
    assert_eq!(
        state_bytes(&session),
        before,
        "a refused wire-half Dock mutates zero bytes of GridState",
    );
    // The belt is untouched and still dockable elsewhere - the refusal is about the port,
    // not about the carrier.
    assert!(
        session.core().state.node(belt_id).is_some(),
        "the carrier belt survived the refusal",
    );
}

/// THE CONTROL FOR WHERE THE GUARD LIVES. A certified log carrying a LEGITIMATE `Dock`
/// still folds on replay, and the guard is still armed on the board the replay rebuilt.
///
/// # What this case DOES catch, measured rather than asserted
/// A fold that refuses, drops or re-derives the Dock's link on replay; a `from_ports`
/// projection that is not rebuilt by `GridView::apply_tick`, which would leave a LOADED
/// board's Dock arm blind to every link it had already made and silently overwritable
/// again; and any divergence between the live and replayed `GridState` bytes.
///
/// # What it does NOT catch, and where that mutation IS caught
/// It does NOT catch the specific mutation of moving the occupancy rule INTO
/// `GridState::link`, and that was measured rather than reasoned: with
/// `if self.links.contains_key(&from) { return; }` inserted at the top of `link`, all
/// four cases in this file stay green. The reason is structural. With the guard in the
/// validate arm no accepted log can contain two `link` calls on one key without an
/// intervening `unlink`, so on a replay of a Dock log the key is always free at fold
/// time and a fold-side guard never fires.
///
/// The mutation IS caught, in another crate: `cargo test -p fabrico-core --test
/// remove_port_repoint` goes red on two cases, `removing_an_in_re_keys_a_docked_belt_on_a
/// _later_in` and `a_wire_target_endpoint_above_the_removed_port_is_re_pointed_on_the_nod
/// e_and_the_link`. `RemovePort` RE-KEYS an existing link, which is a legitimate second
/// `link` call on an occupied key, and that is the reachable shape of "a valid certified
/// log refusing itself". The binding check on placement in this plan is therefore the
/// hunk scan over `state.rs`, and this case is its behavioural complement, not its
/// substitute. Recorded here so the next reader does not over-read what it proves.
#[test]
fn the_guard_is_above_the_fold_so_a_certified_log_still_replays() {
    let (mut session, s_id, s_h, b_id, b_h, _c_id, c_h) = two_valid_targets();
    session
        .apply(GridCommand::Dock { belt: s_h, endpoint: BeltEnd::Head, node: b_h, port: 0 })
        .expect("the first join is accepted");
    // A REFUSED command appends nothing, so the log below carries the accepted Dock and
    // nothing else. Asked anyway, because a log that had recorded the refusal would make
    // the replay assertion mean something different.
    let refused =
        session.apply(GridCommand::Dock { belt: s_h, endpoint: BeltEnd::Head, node: c_h, port: 0 });
    assert!(refused.is_err(), "the repeat drop is refused");

    let log = session.edit_log().to_vec();
    // `replay_two_logs` and NOT `replay`: it is the constructor `Host::recover` uses, so
    // this is the board a user gets back after a SAVE and a LOAD, and it is the one that
    // rebuilds the full handle/link projection the guard reads. `GridSession::replay`
    // projects one tick only, so its handle table holds nothing for a node minted
    // earlier - measured here, and the reason this line names the other constructor.
    let replayed = GridSession::replay_two_logs(SEED, &log, &[]);

    assert_eq!(
        replayed.core().state.link_target((s_id, 0)),
        Some((b_id, 0)),
        "replaying the certified log folds the legitimate Dock and writes its link",
    );
    assert_eq!(
        state_bytes(&replayed),
        state_bytes(&session),
        "the replayed GridState is byte-identical to the live one",
    );

    // AND THE GUARD IS STILL ARMED ON THE REBUILT BOARD. `link_exists` reads the view's
    // `from_ports` projection, which `GridView::apply_tick` rebuilds from the folded
    // links. A projection that came back empty after a load would leave every connection
    // on a SAVED board silently overwritable while the same board was protected before
    // the save, which is the worst version of this defect rather than a smaller one.
    // AND THE GUARD IS STILL ARMED ON THE REBUILT BOARD. `link_exists` does NOT read
    // `links`; it reads the view's `from_ports` PROJECTION, which is rebuilt from the
    // fold. A projection that came back empty after a load would leave every connection
    // on a SAVED board silently overwritable while the same board was protected before
    // the save, which is the worse version of this defect rather than a smaller one. The
    // predicate is asked straight off the reloaded lookup, which is the exact object the
    // Dock arm's guard is handed.
    //
    // Asserted through the lookup rather than by re-issuing the command, and the reason
    // is a MEASUREMENT: neither `replay` nor `replay_two_logs` rebuilds a dense HANDLE
    // for a node minted on an earlier tick, so a re-issued `Dock` is refused
    // `UnknownNode` before it ever reaches the guard. That is a pre-existing property of
    // the reconstructed projection (the host re-mints handles through the render packet
    // builder, not through `GridView`), it is not this plan's to change, and a case that
    // asserted `is_err()` here would have passed on it while proving nothing.
    let lookup = replayed.view().lookup(replayed.core());
    assert!(
        lookup.link_exists((s_id, 0)),
        "the reloaded board's from_ports projection still knows the carrier end is taken",
    );
}
