//! Phase 89 (BELT-07, D-08, SEED-006's reconnect half): turning a machine BACK toward a
//! belt end it let go of docks that end again.
//!
//! `rotate_undo_redock.rs` proves the UNDO half (phase 67-03, CONNECT-03): undoing a
//! severing `Rotate` restores the dock. This file is the FORWARD half: a second turn that
//! brings a port back onto the free belt end it left, or a turn that puts any port with a
//! matching role onto a loose belt end, docks it (In takes a Head, Out or Fault takes a
//! Tail), in the same command group as the turn, so one Undo reverts the turn and its
//! docks together. Measured at a pre-release revision in `89-MEASURE.md` (BELT-07/rotate-back): until
//! plan 89-02 the Rotate validate arm emitted a bare `EditOp::Rotate` and the core fold only
//! ever cut, so a turn away and back left the belt facing the port with no link. Since plan
//! 89-02 (D-08) the arm adds a `Dock` per free end a turned port now faces, in the turn's group.
//!
//! RED FIRST (D-01, D-16). Every test here is a probe written at `PHASE89_START` and seen
//! FAILED there behind an `#[ignore]`; plan 89-02 (the D-08 Rotate group) removed the
//! `#[ignore]` attribute and changed nothing else in the body, so the test that is green is
//! the test that was seen red.
//!
//! # The assertion discipline, copied from `rotate_undo_redock.rs` on purpose
//! The severed set is READ off `last_tick.unlinked` and asserted non-empty FIRST, so a
//! build in which the turn recorded nothing cannot pass vacuously, and the `links` map is
//! compared BYTE FOR BYTE against a map captured in the same run, never a count and never
//! a hand-written expectation. A count passes against a build that docked the wrong belt
//! to the wrong port. Each probe prints its measured facts (`P89-` lines) before it
//! asserts, so the red-first record carries the numbers.

use fabrico_command::GridSession;
use fabrico_core::edit::{EditOp, EditRecord};
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::Footprint;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0xFAB_8907;

/// The serialized `links` map, the oracle every leg asserts on (see the module docblock).
fn link_bytes(session: &GridSession) -> Vec<u8> {
    let links: Vec<((NodeId, PortId), (NodeId, PortId))> =
        session.core().state.links_iter().collect();
    postcard::to_allocvec(&links).expect("serialize the links map")
}

/// The links map itself, for the printed facts.
fn links(session: &GridSession) -> Vec<((NodeId, PortId), (NodeId, PortId))> {
    session.core().state.links_iter().collect()
}

/// Resolve the most-recently-minted node's dense render handle from the view.
fn last_minted_handle(session: &GridSession) -> Option<u64> {
    let id = *session.core().last_tick.placed.last()?;
    session.view().handle_of(id)
}

/// The most-recently-minted node's core id.
fn last_minted_id(session: &GridSession) -> NodeId {
    *session.core().last_tick.placed.last().expect("a node was minted")
}

/// Place a machine of `kind` at a cell and return `(handle, id)`.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> (u64, NodeId) {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    let h = last_minted_handle(session).expect("the placed node got a handle");
    (h, last_minted_id(session))
}

/// Draw a belt along `cells` (Tail first) and return `(handle, id)`.
fn draw(session: &mut GridSession, cells: Vec<(i32, i32)>) -> (u64, NodeId) {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    let h = last_minted_handle(session).expect("the belt got a handle");
    (h, last_minted_id(session))
}

/// A node's live footprint rotation (absent is the `1x1 rot0` convention).
fn rot_of(session: &GridSession, id: NodeId) -> u8 {
    session.core().state.footprint_of(id).unwrap_or(Footprint { w: 1, h: 1, rot: 0 }).rot
}

/// The `rotate_undo_redock.rs` OFFLOAD geometry, copied: a 2x3 ROUTER anchored at `(0, y)`
/// and a belt over `(2, y+2) -> (3, y+2)` whose Tail is docked to the Router's catalog
/// port 2 (its second Out, on row 2, facing E). A clockwise turn severs that dock; a
/// counter-clockwise turn puts the port back where it was. Returns `(router, belt)`
/// handles, docked.
fn docked_router(session: &mut GridSession, y: i32) -> (u64, u64) {
    let (r, _) = place(session, machine_kind::ROUTER, 0, y);
    let (b, _) = draw(session, vec![(2, y + 2), (3, y + 2)]);
    session
        .apply(GridCommand::Dock { belt: b, endpoint: BeltEnd::Tail, node: r, port: 2 })
        .expect("a valid offload dock is accepted");
    (r, b)
}

/// A 1x1 SINK at `(5, y)` (In on its W edge, Fault on its S edge) fed Head-first by a belt
/// over `(2, y) -> (4, y)`, whose Head sits on the In's doorstep `(4, y)`. Of its four
/// rotations only rot 0 puts a port with a Head-taking role on that cell (rot 1 turns the
/// Fault onto it, and a Fault takes a Tail), so no intermediate turn can re-aim the belt.
/// Returns `(sink handle, sink id, belt handle)`, docked.
fn docked_sink(session: &mut GridSession, y: i32) -> (u64, NodeId, u64) {
    let (s, sid) = place(session, machine_kind::SINK, 5, y);
    let (b, _) = draw(session, vec![(2, y), (3, y), (4, y)]);
    session
        .apply(GridCommand::Dock { belt: b, endpoint: BeltEnd::Head, node: s, port: 0 })
        .expect("the belt's Head docks the sink's In");
    (s, sid, b)
}

/// The edit records one `apply` appended.
fn appended_since(session: &GridSession, before: usize) -> Vec<EditRecord> {
    session.edit_log()[before..].to_vec()
}

/// A board folded ONE RECORD AT A TIME, with the view re-projected after each, so every node
/// the records mint has its handle (plan 89-02). `GridSession::replay` folds a whole log at
/// once and projects handles from the LAST tick's mints only, so a replayed session cannot
/// name an earlier node by handle and every `GridCommand` addressed to one is skipped; the
/// dock-arm probe below read `tried=[]` that way when it was first turned on. `apply` runs
/// the same `validate_normalize` both producers run and folds its group as one tick.
struct Stepped {
    core: fabrico_core::core::Core,
    view: fabrico_command::GridView,
}

impl Stepped {
    fn replay(records: &[EditRecord]) -> Self {
        let mut core = fabrico_core::core::Core::genesis(fabrico_core::event::LogHeader {
            schema_version: fabrico_core::event::SCHEMA_VERSION,
            seed: SEED,
        });
        let mut view = fabrico_command::GridView::new();
        for r in records {
            let _discarded = core.advance_edits(std::slice::from_ref(r), &[]);
            view.apply_tick(&core);
        }
        Self { core, view }
    }

    fn view(&self) -> &fabrico_command::GridView {
        &self.view
    }

    fn core(&self) -> &fabrico_core::core::Core {
        &self.core
    }

    /// Validate `cmd` and fold its whole group as one tick; the group's ops are returned.
    fn apply(&mut self, cmd: GridCommand) -> Result<Vec<EditOp>, fabrico_command::CommandError> {
        let mut group = fabrico_command::validate_normalize(&self.view.lookup(&self.core), cmd)?;
        for rec in &mut group {
            rec.tick = self.core.tick;
        }
        let _discarded = self.core.advance_edits(&group, &[]);
        self.view.apply_tick(&self.core);
        Ok(group.into_iter().map(|rec| rec.op).collect())
    }
}

/// **The headline.** A turn away severs the dock; the turn back puts the port on the free
/// end again and docks it: the links map after the second turn is BYTE-IDENTICAL to the
/// map before the first.
#[test]
fn a_turn_back_toward_a_cut_belt_end_docks_it() {
    let mut session = GridSession::new(SEED);
    let (r, _b) = docked_router(&mut session, 0);
    let docked = link_bytes(&session);

    session.apply(GridCommand::Rotate { node: r, ccw: false }).expect("turn the router away");
    let severed = session.core().last_tick.unlinked.clone();
    eprintln!("P89-BELT-07-back away unlinked={severed:?} links={:?}", links(&session));
    assert!(
        !severed.is_empty(),
        "the turn away SEVERED a dock and recorded it on last_tick.unlinked; without this \
         the restore assertion below is vacuous"
    );
    assert_ne!(docked, link_bytes(&session), "the links map moved on the turn away");

    session.apply(GridCommand::Rotate { node: r, ccw: true }).expect("turn the router back");
    eprintln!("P89-BELT-07-back back links={:?}", links(&session));
    assert_eq!(
        docked,
        link_bytes(&session),
        "turning the machine back toward the belt end it let go of docks it again: the links \
         map equals the one captured before the first turn, byte for byte"
    );
}

/// Four quarter turns of a docked 1x1 Sink bring its In back onto the belt's Head; the
/// fourth turn docks it, so the links map ends byte-equal to the docked one.
#[test]
fn four_turns_of_a_docked_machine_end_docked() {
    let mut session = GridSession::new(SEED);
    let (s, sid, _b) = docked_sink(&mut session, 0);
    let docked = link_bytes(&session);

    session.apply(GridCommand::Rotate { node: s, ccw: false }).expect("turn 1");
    let severed = session.core().last_tick.unlinked.clone();
    assert!(!severed.is_empty(), "turn 1 SEVERED the Head dock (non-vacuity)");
    for k in 2..=4 {
        session.apply(GridCommand::Rotate { node: s, ccw: false }).unwrap_or_else(|e| {
            panic!("turn {k} of a 1x1 sink is accepted: {e:?}");
        });
    }
    eprintln!(
        "P89-BELT-07-back four-turns rot={} links={:?} turn1_unlinked={severed:?}",
        rot_of(&session, sid),
        links(&session)
    );
    assert_eq!(rot_of(&session, sid), 0, "four quarter turns are a full turn (premise)");
    assert_eq!(
        docked,
        link_bytes(&session),
        "after four quarter turns the sink's In faces the belt's Head again and is docked: \
         the links map equals the docked one, byte for byte"
    );
}

/// A 3x3 Factory turned so its Fault lands on the nub its Out just left: the turn cuts
/// the Out's dock and the same turn re-aims the belt's free Tail to the Fault. One link
/// before and one after, and the one after names the Fault.
///
/// Geometry, measured through the catalog (`port_edits_keep_place.rs` `MEASURED`): a
/// Factory anchored at (20,20) and turned three quarter turns clockwise has its Out at
/// (21,20) facing N (doorstep (21,19)); one counter-clockwise turn from there (rot 2) puts
/// its Fault at (21,20) facing N, on the same doorstep.
#[test]
fn a_turn_that_cuts_one_port_and_faces_another_re_aims_the_end() {
    let mut session = GridSession::new(SEED);
    let (f, fid) = place(&mut session, machine_kind::FACTORY, 20, 20);
    session.apply(GridCommand::Rotate { node: f, ccw: true }).expect("turn the bare factory to rot 3");
    assert_eq!(rot_of(&session, fid), 3, "premise: the factory sits at rot 3, Out facing N");
    let (b, bid) = draw(&mut session, vec![(21, 19), (21, 18)]);
    session
        .apply(GridCommand::Dock { belt: b, endpoint: BeltEnd::Tail, node: f, port: 1 })
        .expect("the belt's Tail docks the factory's Out (catalog port 1)");
    let before = links(&session);
    assert_eq!(before.len(), 1, "premise: exactly one link, Out to the belt's Tail");

    session.apply(GridCommand::Rotate { node: f, ccw: true }).expect("turn the factory to rot 2");
    let severed = session.core().last_tick.unlinked.clone();
    let after = links(&session);
    eprintln!(
        "P89-BELT-07-back re-aim rot={} before={before:?} unlinked={severed:?} after={after:?}",
        rot_of(&session, fid)
    );
    assert!(!severed.is_empty(), "the turn SEVERED the Out's dock (non-vacuity)");
    // The expected link is the one captured before the turn with the factory's side moved
    // from its Out to its Fault: same direction, same belt slot, read in this run.
    let to_fault = |end: (NodeId, PortId)| if end.0 == fid { (fid, FAULT_PORT) } else { end };
    let expected: Vec<_> = before.iter().map(|&(from, to)| (to_fault(from), to_fault(to))).collect();
    assert!(
        before.iter().all(|&(from, to)| (from.0 == fid && to.0 == bid) || (to.0 == fid && from.0 == bid)),
        "premise: the one link joins the factory and the belt"
    );
    assert_eq!(
        after,
        expected,
        "the same turn re-aims the belt's free Tail to the Fault that now faces it: one link \
         before, one link after, from the factory's Fault into the belt's Tail"
    );
}

/// One Undo after the turn back reverts that turn AND the docks it made: the rotation is
/// the one the first turn left, and the belt is free again. The precondition (the turn back
/// docked) is asserted first, so this cannot pass on a build whose turn back docks nothing.
#[test]
fn one_undo_reverts_a_turn_and_the_docks_it_made() {
    let mut session = GridSession::new(SEED);
    let (s, sid, _b) = docked_sink(&mut session, 0);
    let docked = link_bytes(&session);

    session.apply(GridCommand::Rotate { node: s, ccw: false }).expect("turn the sink away");
    assert!(!session.core().last_tick.unlinked.is_empty(), "the turn away SEVERED the dock");
    let away = link_bytes(&session);
    let away_rot = rot_of(&session, sid);

    session.apply(GridCommand::Rotate { node: s, ccw: true }).expect("turn the sink back");
    let back = links(&session);
    eprintln!("P89-BELT-07-back undo-premise rot={} links={back:?}", rot_of(&session, sid));
    assert_eq!(docked, link_bytes(&session), "PRECONDITION: the turn back docked the belt");

    session.apply(GridCommand::Undo).expect("undo the turn back");
    eprintln!(
        "P89-BELT-07-back undo rot={} links={:?}",
        rot_of(&session, sid),
        links(&session)
    );
    assert_eq!(rot_of(&session, sid), away_rot, "one Undo restores the rotation the first turn left");
    assert_eq!(
        away,
        link_bytes(&session),
        "and the dock the turn back made goes with it: the links map equals the one after the \
         first turn, byte for byte"
    );
}

/// Every Dock a turn makes is one the Dock arm itself accepts. The turn back must emit at
/// least one `EditOp::Dock`; each is then sent as a `GridCommand::Dock` to a session that
/// folded the turn's Rotate record alone, and must be accepted there with the same link.
/// One accept envelope, proved rather than asserted.
#[test]
fn every_dock_a_turn_makes_is_one_the_dock_arm_accepts() {
    let mut session = GridSession::new(SEED);
    let (r, _b) = docked_router(&mut session, 0);
    session.apply(GridCommand::Rotate { node: r, ccw: false }).expect("turn the router away");
    assert!(!session.core().last_tick.unlinked.is_empty(), "the turn away SEVERED the dock");

    let before = session.edit_log().len();
    session.apply(GridCommand::Rotate { node: r, ccw: true }).expect("turn the router back");
    let group = appended_since(&session, before);
    let ops: Vec<&EditOp> = group.iter().map(|rec| &rec.op).collect();
    eprintln!("P89-BELT-07-back group ops={ops:?}");
    let rotate_at = group
        .iter()
        .position(|rec| matches!(rec.op, EditOp::Rotate { .. }))
        .expect("the turn back appended its Rotate record");
    let docks: Vec<&EditRecord> =
        group.iter().filter(|rec| matches!(rec.op, EditOp::Dock { .. })).collect();
    assert!(!docks.is_empty(), "the turn back emits at least one Dock in its own group");

    // A session that folded everything up to and including the Rotate, and none of its
    // Docks: the board the Dock arm would judge a Dock against.
    let upto: Vec<EditRecord> = session.edit_log()[..before + rotate_at + 1].to_vec();
    for rec in docks {
        let EditOp::Dock { belt, endpoint, node, port } = rec.op.clone() else { unreachable!() };
        let mut accepted = false;
        let mut tried = Vec::new();
        let n_ports = session.core().state.ports_of(node).map_or(0, <[_]>::len);
        for index in 0..n_ports {
            let mut probe = Stepped::replay(&upto);
            let (Some(bh), Some(nh)) = (probe.view().handle_of(belt), probe.view().handle_of(node)) else {
                continue;
            };
            let end = match endpoint {
                fabrico_core::edit::BeltEnd::Head => BeltEnd::Head,
                fabrico_core::edit::BeltEnd::Tail => BeltEnd::Tail,
            };
            #[allow(clippy::cast_possible_truncation)]
            let verdict =
                probe.apply(GridCommand::Dock { belt: bh, endpoint: end, node: nh, port: index as u16 }).map(|_| ());
            let linked = probe.core().state.links_iter().any(|(from, to)| {
                (from == (node, port) && to.0 == belt) || (to == (node, port) && from.0 == belt)
            });
            tried.push((index, format!("{verdict:?}"), linked));
            if verdict.is_ok() && linked {
                accepted = true;
                break;
            }
        }
        eprintln!("P89-BELT-07-back dock-arm belt={belt:?} node={node:?} port={port} tried={tried:?}");
        assert!(accepted, "the Dock arm accepts the Dock the turn made, with the same link");
    }
}

// ---------------------------------------------------------------------------
// THE GUARDS (plan 89-02): what a turn must NOT dock. Each was read FAILED under the mutation
// that removes the clause it pins (89-EVIDENCE.md, `## Plan 89-02`), so none can pass on a
// build without its rule.
// ---------------------------------------------------------------------------

/// A Source whose Out sits on `(x, y)` facing East, so its doorstep is `(x + 1, y)`.
fn place_source(session: &mut GridSession, x: i32, y: i32) -> (u64, NodeId) {
    place(session, machine_kind::SOURCE, x, y)
}

/// **A turn never joins a fan-in (D-08, threat T-89-05).** A belt's Tail is docked to
/// Source A; Source B, standing below that Tail, is turned so its Out faces it. The Tail
/// already holds A's dock, so B's turn emits NO Dock (its group is the bare Rotate) and A's
/// link is byte-identical afterwards. Mutation: drop the end-holds-a-dock skip in
/// `turn_docks`, and B's turn joins the Tail as a second feeder.
#[test]
fn a_turn_never_joins_a_belt_end_that_already_holds_a_dock() {
    let mut session = GridSession::new(SEED);
    let (a, _) = place_source(&mut session, 0, 0);
    let (b, _) = draw(&mut session, vec![(1, 0), (2, 0), (3, 0)]);
    session
        .apply(GridCommand::Dock { belt: b, endpoint: BeltEnd::Tail, node: a, port: 0 })
        .expect("the belt's Tail docks Source A's Out");
    let (src_b, _) = place_source(&mut session, 1, 1);
    let docked = link_bytes(&session);
    assert_eq!(links(&session).len(), 1, "premise: one link, A's Out into the belt's Tail");

    // B at rot 0 faces East onto (2,1); one counter-clockwise turn faces it North onto (1,0),
    // the belt's Tail cell, which leaves westward, so the facing term alone would accept.
    let before = session.edit_log().len();
    session.apply(GridCommand::Rotate { node: src_b, ccw: true }).expect("turn Source B to face the Tail");
    let ops: Vec<EditOp> = appended_since(&session, before).into_iter().map(|r| r.op).collect();
    eprintln!("P89-GUARD fan-in ops={ops:?} links={:?}", links(&session));
    assert_eq!(
        (ops.len(), matches!(ops[0], EditOp::Rotate { .. })),
        (1, true),
        "a turn facing a belt end that already holds a dock emits the bare Rotate and no Dock: {ops:?}"
    );
    assert_eq!(docked, link_bytes(&session), "Source A's link is untouched, byte for byte");
}

/// **A port that keeps its dock is left alone (D-08, research Pitfall 2, threat T-89-04).**
/// `fold_dock` links with a bare insert, so a Dock on a port that still holds one REPLACES the
/// link the user made. On a command-built board a kept dock owns the port's doorstep, so no
/// second end can be there; the two reach each other only on a board whose occupancy and
/// geometry disagree, which a hand-edited or forged log can build (the threat model every
/// fold guard here is written against). This board is that one, built from a log:
///
/// - a 1x3 machine at (0,0) with one Out at local (0,1) facing East: a quarter turn
///   clockwise moves the Out to (1,0) facing South, ONTO THE SAME doorstep (1,1) (the
///   `w x (2w + 1)` shape `dock_still_reaches` keeps a dock through, phase 74.1 CORNER-06);
/// - belt X over (1,1) to (3,1), its Tail docked to that Out through the real Dock arm;
/// - belt Y, a forged draw whose Tail tile is ALSO (1,1), running South. The fold claims the
///   cell for Y, so the doorstep reads Y while the Out's kept dock is X.
///
/// The turn keeps X's dock (the fold's own rule), so the port is not free and the turn must
/// emit no Dock to Y. Mutation: drop the port-keeps-its-dock skip, and the turn docks Y,
/// whose bare insert drops X's link.
#[test]
fn a_turn_leaves_a_port_that_keeps_its_dock_alone() {
    let record = |op: EditOp| EditRecord {
        schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op,
    };
    let out_port = fabrico_core::state::Port {
        local_offset: (0, 1),
        side: fabrico_core::state::Side::E,
        role: fabrico_core::state::Role::Out,
        medium: fabrico_core::state::Medium::Mechanical,
    };
    let x_tiles = fabrico_command::route(&[(1, 1), (2, 1), (3, 1)]).expect("X routes");
    let mut board = Stepped::replay(&[
        record(EditOp::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0, w: 1, h: 3, ports: vec![out_port], rot: 0 }),
        record(EditOp::DrawBelt { tiles: x_tiles }),
    ]);
    let st = &board.core().state;
    let (m, x) = (st.occupied((0, 0)).expect("the 1x3 machine"), st.occupied((2, 1)).expect("belt X"));
    let (mh, xh) = (board.view().handle_of(m).expect("machine handle"), board.view().handle_of(x).expect("X handle"));
    board
        .apply(GridCommand::Dock { belt: xh, endpoint: BeltEnd::Tail, node: mh, port: 0 })
        .expect("X's Tail docks the machine's Out through the real Dock arm");
    // Belt Y, forged over X's Tail tile: the fold claims (1,1) for Y.
    let y_tiles = fabrico_command::route(&[(1, 1), (1, 2), (1, 3)]).expect("Y routes");
    let _discarded = board.core.advance_edits(&[record(EditOp::DrawBelt { tiles: y_tiles })], &[]);
    board.view.apply_tick(&board.core);
    let st = &board.core().state;
    let y = st.occupied((1, 2)).expect("belt Y");
    assert_eq!(st.occupied((1, 1)), Some(y), "premise: the doorstep (1,1) reads belt Y");
    let kept: Vec<_> = st.links_iter().collect();
    assert_eq!(kept.len(), 1, "premise: one link, the Out into X's Tail");

    let ops = board.apply(GridCommand::Rotate { node: mh, ccw: false }).expect("turn the machine a quarter clockwise");
    let after: Vec<_> = board.core().state.links_iter().collect();
    eprintln!(
        "P89-GUARD kept-port ops={ops:?} unlinked={:?} links={after:?}",
        board.core().last_tick.unlinked
    );
    assert!(board.core().last_tick.unlinked.is_empty(), "premise: the turn KEPT X's dock (it severed nothing)");
    assert_eq!(
        (ops.len(), ops.iter().any(|op| matches!(op, EditOp::Dock { .. }))),
        (1, false),
        "a port that keeps its dock gets no second Dock from the turn: {ops:?}"
    );
    assert_eq!(kept, after, "X's link survives the turn untouched");
}

/// **A turn that faces no free end is the one bare Rotate it always was (research Pitfall 4,
/// threat T-89-06).** `validate_normalize` is asked directly, so the group is read before any
/// fold: a docked Sink turned clockwise cuts its Head dock and faces no loose end (its Fault
/// lands on the Head's cell, and a Fault takes a Tail), and its group is exactly one `Rotate`
/// record; so is a bare Router's turn on a board with no belt. Golden 0015 and the exit-gate
/// scenario rest on this. (The Router offload geometry is NOT such a turn under D-08: its
/// clockwise turn puts its third Out on the cut Tail's cell, and the turn re-aims the belt.)
/// Mutation: push a no-op extra record on every turn.
#[test]
fn a_turn_with_no_free_facing_end_returns_one_record() {
    let mut session = GridSession::new(SEED);
    let (s, sid, _b) = docked_sink(&mut session, 0);
    let group = fabrico_command::validate_normalize(
        &session.view().lookup(session.core()),
        GridCommand::Rotate { node: s, ccw: false },
    )
    .expect("the turn is accepted");
    let ops: Vec<&EditOp> = group.iter().map(|rec| &rec.op).collect();
    eprintln!("P89-GUARD one-record ops={ops:?}");
    assert_eq!(
        ops,
        vec![&EditOp::Rotate { node: sid, new_rot: 1, old_rot: 0 }],
        "a turn that cuts the Head dock and faces no loose end returns exactly one record, the Rotate"
    );
    // And a bare Router with no belt anywhere: the 0015 shape.
    let mut bare = GridSession::new(SEED);
    let (h, id) = place(&mut bare, machine_kind::ROUTER, 0, 0);
    let group = fabrico_command::validate_normalize(&bare.view().lookup(bare.core()), GridCommand::Rotate { node: h, ccw: false })
        .expect("the bare turn is accepted");
    assert_eq!(
        group.iter().map(|rec| rec.op.clone()).collect::<Vec<_>>(),
        vec![EditOp::Rotate { node: id, new_rot: 1, old_rot: 0 }],
        "a turn on a board with no belt at all is one Rotate record"
    );
}

/// **The turn and its docks survive a save and a load (the reconstruct twin).** After a turn
/// away and back, the board is saved and loaded (`GridSession::replay` of the edit log, the
/// load path): the links equal the live ones byte for byte, and one Undo on the LOADED
/// session still reverts the turn back and the dock it made together.
#[test]
fn the_turn_and_its_docks_survive_a_save_and_a_load() {
    let mut session = GridSession::new(SEED);
    let (s, sid, _b) = docked_sink(&mut session, 0);
    let docked = link_bytes(&session);
    session.apply(GridCommand::Rotate { node: s, ccw: false }).expect("turn the sink away");
    assert!(!session.core().last_tick.unlinked.is_empty(), "the turn away SEVERED the dock");
    let away = link_bytes(&session);
    let away_rot = rot_of(&session, sid);
    session.apply(GridCommand::Rotate { node: s, ccw: true }).expect("turn the sink back");
    assert_eq!(docked, link_bytes(&session), "PRECONDITION: the turn back docked the belt live");

    let mut loaded = GridSession::replay(SEED, session.edit_log());
    eprintln!("P89-GUARD save-load links={:?}", links(&loaded));
    assert_eq!(link_bytes(&session), link_bytes(&loaded), "the loaded board holds the same links, byte for byte");
    loaded.apply(GridCommand::Undo).expect("undo the turn back on the loaded board");
    eprintln!("P89-GUARD save-load undo rot={} links={:?}", rot_of(&loaded, sid), links(&loaded));
    assert_eq!(
        (rot_of(&loaded, sid), link_bytes(&loaded)),
        (away_rot, away),
        "one Undo after a load reverts the turn back and its dock together"
    );
}

/// Review WR-A-02 (2026-10-23): a turn never logs two Docks on the one `FAULT_PORT` key.
///
/// `dock_link_key` maps every Fault port to `FAULT_PORT`, and `GridState::link` is a bare
/// insert keyed by the source, so a second Dock on that key in one group replaces the first:
/// the log claims a join it does not hold. `FAULT_PORT` names the FIRST Fault
/// (`link_key_port`, `resolve_link_port`), so only that port may dock through it.
///
/// The board: a Factory given a second Fault with `AddPort`, and a loose belt Tail on the
/// doorstep each Fault faces after ONE turn (the geometry is read off the live ports, never
/// hand-written). The turn group may carry at most one `FAULT_PORT` Dock, it must name the
/// belt on the first Fault's doorstep, and the links after the fold must be exactly the
/// group's Docks.
#[test]
fn a_turn_never_logs_two_docks_on_the_fault_key() {
    use fabrico_core::state::{Role, port_world, unit_delta};
    let mut s = GridSession::new(SEED);
    let (f, fid) = place(&mut s, machine_kind::FACTORY, 6, 6);
    s.apply(GridCommand::AddPort { node: f, role: 2, side: 2, medium: 0 }).expect("a second Fault is added");
    let ports = s.core().state.ports_of(fid).expect("the Factory has ports").to_vec();
    let faults: Vec<usize> = ports.iter().enumerate().filter(|(_, p)| p.role == Role::Fault).map(|(i, _)| i).collect();
    assert_eq!(faults.len(), 2, "NON-VACUITY: the Factory holds two Fault ports");
    let fp = s.core().state.footprint_of(fid).expect("a footprint");
    let anchor = s.core().state.cell_of(fid).expect("an anchor");

    // One turn, clockwise or counter-clockwise, whichever puts both Fault doorsteps on free
    // cells with a free cell beyond each.
    let pick = [(false, (fp.rot + 1) & 3), (true, (fp.rot + 3) & 3)].into_iter().find_map(|(ccw, rot)| {
        let paths: Vec<Vec<(i32, i32)>> = faults
            .iter()
            .map(|&i| {
                let (cell, side) = port_world(anchor, fp.w, fp.h, rot, &ports[i]);
                let (dx, dy) = unit_delta(side);
                vec![(cell.0 + dx, cell.1 + dy), (cell.0 + 2 * dx, cell.1 + 2 * dy)]
            })
            .collect();
        let all: Vec<(i32, i32)> = paths.iter().flatten().copied().collect();
        let free = all.iter().all(|&c| s.core().state.occupied(c).is_none() && c.0 >= 0 && c.1 >= 0);
        let distinct = all.iter().enumerate().all(|(i, c)| !all[..i].contains(c));
        (free && distinct).then_some((ccw, paths))
    });
    let (ccw, paths) = pick.expect("NON-VACUITY: one turn faces both Faults onto free cells");
    let belts: Vec<NodeId> = paths.iter().map(|p| draw(&mut s, p.clone()).1).collect();
    assert!(links(&s).iter().all(|(a, b)| belts.iter().all(|&x| a.0 != x && b.0 != x)), "NON-VACUITY: both Tails are loose");

    let before = s.edit_log().len();
    s.apply(GridCommand::Rotate { node: f, ccw }).expect("the turn is accepted");
    let group = appended_since(&s, before);
    let fault_docks: Vec<NodeId> = group
        .iter()
        .filter_map(|r| match r.op {
            EditOp::Dock { belt, port, .. } if port == FAULT_PORT => Some(belt),
            _ => None,
        })
        .collect();
    let mut group_links: Vec<((NodeId, PortId), (NodeId, PortId))> = group
        .iter()
        .filter_map(|r| match r.op {
            EditOp::Dock { belt, endpoint: fabrico_core::edit::BeltEnd::Tail, node, port } => Some(((node, port), (belt, 0))),
            EditOp::Dock { belt, endpoint: fabrico_core::edit::BeltEnd::Head, node, port } => Some(((belt, 0), (node, port))),
            _ => None,
        })
        .collect();
    group_links.sort();
    let mut after: Vec<((NodeId, PortId), (NodeId, PortId))> =
        links(&s).into_iter().filter(|(a, b)| belts.contains(&a.0) || belts.contains(&b.0)).collect();
    after.sort();
    eprintln!("P89-WR-A-02 ccw={ccw} paths={paths:?} belts={belts:?} fault_docks={fault_docks:?} group_links={group_links:?} after={after:?}");
    assert_eq!(
        vec![("fault_docks", format!("{fault_docks:?}")), ("after", format!("{after:?}"))],
        vec![("fault_docks", format!("{:?}", vec![belts[0]])), ("after", format!("{group_links:?}"))],
        "one Dock on FAULT_PORT, through the first Fault, and the links are the group's Docks"
    );
}
