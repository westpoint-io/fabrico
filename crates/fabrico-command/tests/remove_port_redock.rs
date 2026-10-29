//! UNDO-05, the command half: ONE Ctrl+Z puts the output back in its slot AND re-docks the
//! belt that was released, in a single step, with the second belt untouched.
//!
//! From 74.1-12 to 74.1-16 a removal also released every surviving belt whose port the
//! re-seat moved. By design, since 74.1-16 (2026-10-04), a removal moves no other
//! port, so it releases exactly the removed port's own belt again; the surviving-belt row
//! below is re-authored as that named change.
//!
//! Since 73-06 `fold_remove_port` RELEASES the dock that was on the removed port and
//! records it on `core.last_tick.unlinked`, so `RemovePort` joined `Rotate` as a writer of
//! that field. This file is the command-layer half of that: `attribute_severances` widened
//! to name it, and `compute_inverse`'s `RemovePort` arm now emits a compensating
//! `EditOp::Dock` AFTER the `AddPort` that restores the port.
//!
//! # Every row drives the PUBLIC `GridSession::apply` seam
//! `Place`, `DrawBelt`, `Dock`, `RemovePort`, `Undo` - the same producer the UI is. No row
//! reaches into `GridState` to hand-write a link,
//! and no row forges an edit-log record at all.
//!
//! # The oracle is the serialized `links` map, never a count
//! Lifted from `rotate_undo_redock.rs`'s own discipline, and for its reason: a link COUNT
//! is satisfied by a build that re-docked the wrong belt to the wrong port. Every
//! behavioural row here compares a byte image of the whole map against one captured in the
//! same run.
//!
//! Run target: `cargo test -p fabrico-command --test remove_port_redock`.

use fabrico_command::GridSession;
use fabrico_core::edit::EditOp;
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{Port, Role};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0xFAB_C0DE;

/// The serialized `links` map - the oracle every behavioural row asserts on.
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

/// Place a machine of `kind` at a cell and return `(node id, dense handle)`.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> (NodeId, u64) {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    let id = *session.core().last_tick.placed.last().expect("the placed node was minted");
    (id, session.view().handle_of(id).expect("the placed node got a handle"))
}

/// Draw a belt along `cells` and return `(node id, dense handle)`.
fn draw(session: &mut GridSession, cells: Vec<(i32, i32)>) -> (NodeId, u64) {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    let id = *session.core().last_tick.placed.last().expect("the belt was minted");
    (id, last_minted_handle(session).expect("the belt got a handle"))
}

/// The machine's rot-0 port list.
fn ports(session: &GridSession, node: NodeId) -> Vec<Port> {
    session.core().state.ports_of(node).expect("the machine declares ports").to_vec()
}

/// The proven-valid OFFLOAD geometry, lifted verbatim from `rotate_undo_redock.rs`'s
/// `docked_router`: a 2x3 ROUTER anchored at `(0, y)` puts its CATALOG index 1 port at
/// world `(1, y+1)` facing E (the middle row since plan 74.1-14; it was `(1, y+2)`), and a
/// belt drawn tail-first at `(2, y+1) -> (3, y+1)` presents its tail one step E of that
/// port, facing W = `opposite(E)`.
///
/// Catalog index 1 is the FIRST `Role::Out`, so its LINK key is ROUTING key 0. The two
/// keyspaces collide on a Router and the collision is deliberate here, exactly as it is in
/// `gen_0033`: the `Dock` command takes the SPATIAL catalog index and the link it writes is
/// keyed on the routing index.
///
/// Returns `(router id, router handle, belt id, belt handle)`, docked.
fn docked_router(session: &mut GridSession, y: i32) -> (NodeId, u64, NodeId, u64) {
    let (r_id, r_h) = place(session, machine_kind::ROUTER, 0, y);
    let (b_id, b_h) = draw(session, vec![(2, y + 1), (3, y + 1)]);
    session
        .apply(GridCommand::Dock { belt: b_h, endpoint: BeltEnd::Tail, node: r_h, port: 1 })
        .expect("a valid offload dock is accepted");
    (r_id, r_h, b_id, b_h)
}

/// **The headline.** RED ON HEAD BECAUSE, on two independent counts: the `AddPort` the
/// inverse emitted put the port back LAST rather than in its own slot (which plan 73-03
/// fixed), and NOTHING re-docked, because before 73-06 the fold released nothing and the
/// inverse emitted no compensating `Dock`.
///
/// The severed set is READ off `core.last_tick.unlinked` and asserted non-empty FIRST, so a
/// build in which the fold recorded nothing cannot pass this vacuously.
#[test]
fn one_undo_re_adds_the_port_and_re_docks_the_released_belt() {
    let mut session = GridSession::new(SEED);
    let (r_id, r_h, _b_id, _b_h) = docked_router(&mut session, 0);

    let ports_before = ports(&session, r_id);
    let links_before = link_bytes(&session);

    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("removing the docked Out is accepted");
    assert_eq!(
        session.core().last_tick.unlinked.len(),
        1,
        "the fold released EXACTLY the dock that was on the removed port - read, never \
         hand-written, so a build that recorded nothing fails here rather than later"
    );
    assert_ne!(link_bytes(&session), links_before, "and the links map really moved");

    session.apply(GridCommand::Undo).expect("ONE Undo");

    assert_eq!(
        link_bytes(&session),
        links_before,
        "one press of Ctrl+Z leaves the links map BYTE-IDENTICAL to its pre-removal value"
    );
    // THE PORT LIST COMES BACK IN BYTES SINCE 74.1-16. Until then this comment said it came
    // back in ORDER only: every port edit re-seated the whole list, so the undo could not
    // un-canonicalise it. Since 74.1-16 no port edit moves a port and the inverse re-inserts
    // the removed one on its CAPTURED slot, so the list is byte-identical. Order is still
    // asserted on its own, because order is what every dock key and every routing key is.
    assert_eq!(ports(&session, r_id), ports_before, "the port list comes back byte for byte");
    let roles = |ps: &[Port]| ps.iter().map(|p| p.role).collect::<Vec<_>>();
    assert_eq!(
        roles(&ports(&session, r_id)),
        roles(&ports_before),
        "and the port list comes back in the SAME ORDER, which is what every dock key is"
    );
    assert_eq!(
        ports(&session, r_id).len(),
        ports_before.len(),
        "with no port gained or lost"
    );
}

/// RED ON HEAD BEFORE PLAN 73-03: the restored Out was appended LAST, so the port count
/// came back right and only the ORDER was wrong - and order is what every belt dock key is.
/// This row is the `AddPort.index` half of the same single undo, asserted by POSITION and
/// never by a count, because a count is satisfied by the reversed list the bug produces.
#[test]
fn the_re_added_port_lands_at_its_original_index() {
    let mut session = GridSession::new(SEED);
    let (r_id, r_h, _, _) = docked_router(&mut session, 0);

    let roles_before: Vec<Role> = ports(&session, r_id).iter().map(|p| p.role).collect();
    let removed_role = roles_before[1];

    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("remove the FIRST Out, not the last");
    session.apply(GridCommand::Undo).expect("ONE Undo");

    let roles_after: Vec<Role> = ports(&session, r_id).iter().map(|p| p.role).collect();
    assert_eq!(roles_after, roles_before, "the roles come back IN ORDER, not merely in count");
    assert_eq!(
        roles_after[1], removed_role,
        "the restored port is at the index it was removed from, not at the end"
    );
}

/// A Router placed from the catalog at `(0, 0)`. Under the "Edits keep middle layout"
/// rule (plan 74.1-14, 2026-10-04) its catalog layout is the one every port edit
/// and every undo re-seats to, so no warm-up edit is needed: routing key `k` sits at local
/// `(1, [1, 2, 0][k])`, doorstep world `(2, [1, 2, 0][k])`. Asserted, not assumed.
/// Returns `(router id, router handle)`.
///
/// Until 74.1-14 this helper made the Router's first port edit (an Out added and removed)
/// before any belt was drawn, because the catalog seated its Outs at rows 2, 0, 1 and the
/// fold re-seated by index, so the undo's own re-seat could move a survivor's port.
fn catalog_router(session: &mut GridSession) -> (NodeId, u64) {
    let (r_id, r_h) = place(session, machine_kind::ROUTER, 0, 0);
    let p = ports(session, r_id);
    assert_eq!(
        p,
        fabrico_core::state::reseat_ports(fabrico_core::state::Footprint { w: 2, h: 3, rot: 0 }, 2, 3, &p),
        "the catalog Router already sits where every port edit re-seats it"
    );
    (r_id, r_h)
}

/// RED ON HEAD BECAUSE: on HEAD the fold released nothing, so there is nothing to get
/// wrong here yet.
///
/// RE-AUTHORED TWICE. In 74.1-12 it became `the_surviving_belt_whose_port_moved_is_released_
/// and_one_undo_re_docks_it` (was `the_surviving_belt_did_not_move`): removing the first
/// Out re-seated the second into its row and released both belts. RE-AUTHORED IN 74.1-16
/// as `the_surviving_belt_is_kept_re_keyed_and_one_undo_re_docks_only_the_released_one`,
/// back to the row's ORIGINAL subject, because by design removing an
/// output moves no other port: the second Out stays on row 2, its belt stays docked and is
/// re-keyed 1 -> 0, and only the belt on the removed output is released. What the row
/// asserts is still the RESOLVED DESTINATION, before and after the undo.
#[test]
fn the_surviving_belt_is_kept_re_keyed_and_one_undo_re_docks_only_the_released_one() {
    let mut session = GridSession::new(SEED);
    let (r_id, r_h) = catalog_router(&mut session);
    // Routing key 0 (catalog 1) faces (2,1); routing key 1 (catalog 2) faces (2,2)
    // (the 74.1-14 catalog rows 1, 2, 0).
    let (on_removed, on_removed_h) = draw(&mut session, vec![(2, 1), (3, 1)]);
    session
        .apply(GridCommand::Dock { belt: on_removed_h, endpoint: BeltEnd::Tail, node: r_h, port: 1 })
        .expect("a valid offload dock on the first Out");
    let (survivor, survivor_h) = draw(&mut session, vec![(2, 2), (3, 2)]);
    session
        .apply(GridCommand::Dock { belt: survivor_h, endpoint: BeltEnd::Tail, node: r_h, port: 2 })
        .expect("a valid offload dock on the second Out");
    assert_eq!(session.core().state.link_target((r_id, 1)), Some((survivor, 0)), "the survivor is on routing key 1");
    let links_before = link_bytes(&session);
    let survivor_port = ports(&session, r_id)[2];

    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("remove the FIRST Out");
    let released: Vec<NodeId> = session.core().last_tick.unlinked.iter().map(|u| u.belt).collect();
    assert_eq!(released, vec![on_removed], "exactly the belt on the removed output is released");
    assert_eq!(
        session.core().state.link_target((r_id, 0)),
        Some((survivor, 0)),
        "the survivor is kept, re-keyed 1 -> 0"
    );
    assert_eq!(
        ports(&session, r_id)[1],
        survivor_port,
        "and its port did not move: it is the same rot-0 port on the same row"
    );

    session.apply(GridCommand::Undo).expect("ONE Undo");

    assert_eq!(
        session.core().state.link_target((r_id, 1)),
        Some((survivor, 0)),
        "after the undo the survivor resolves to the same downstream node it did before"
    );
    assert_eq!(link_bytes(&session), links_before, "and the whole links map is restored");
}

/// The ABSENT-ENTRY half of R-28's capture-miss policy. A `RemovePort` of an UNDOCKED port
/// severed nothing, so its inverse is an `AddPort` alone and emitting no `Dock` is correct
/// rather than a miss.
///
/// RED ON HEAD BECAUSE: it is NOT, and that is declared rather than left to be discovered.
/// This is a NEGATIVE CONTROL. On HEAD no `RemovePort` emitted a compensating `Dock` at
/// all, so "emits none here" was true for the wrong reason. It earns its place beside the
/// row above: together they pin that the arm emits a `Dock` when and only when the fold
/// recorded a release.
#[test]
fn an_action_that_severed_nothing_emits_no_compensating_dock() {
    let mut session = GridSession::new(SEED);
    let (_r_id, r_h) = place(&mut session, machine_kind::ROUTER, 0, 0);

    let before = session.edit_log().len();
    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("remove an UNDOCKED Out");
    assert!(
        session.core().last_tick.unlinked.is_empty(),
        "nothing was docked, so nothing is released"
    );
    session.apply(GridCommand::Undo).expect("ONE Undo");

    let emitted: Vec<&EditOp> = session.edit_log()[before + 1..].iter().map(|r| &r.op).collect();
    assert!(
        emitted.iter().any(|op| matches!(op, EditOp::AddPort { .. })),
        "the inverse still restores the port"
    );
    assert!(
        !emitted.iter().any(|op| matches!(op, EditOp::Dock { .. })),
        "and emits NO compensating Dock, because there was no severance to invert"
    );
}

/// The PRESENT-BUT-BROKEN half of R-28's capture-miss policy, and the row where the
/// `RemovePort` arm deliberately differs from the `Rotate` arm.
///
/// # THIS ROW IS A DECLARED NON-BITE, AND SAYING SO IS THE POINT
/// RED ON HEAD BECAUSE: it is NOT, and it cannot be made so on any board reachable today.
/// The refusal it describes is DEFENSIVE, and the honest thing is to record that rather
/// than to shape a board until something goes red.
///
/// The reason it is unreachable was MEASURED, not assumed. `GridState::judge_docks`
/// collects candidates only where the far end is a `Node::Belt`, so `last_tick.unlinked`
/// can only ever name a real belt. The belt then SURVIVES the removal (only the link is
/// dropped), so at inverse time it is still live and still a belt, and
/// `compensating_dock_is_foldable` cannot be false. Three constructions were tried and all
/// three came back `Ok`: deleting the belt in a later action and undoing twice (the belt is
/// re-minted and the `Dock` retargets through `xlate`, links byte-identical), forging the
/// `DrawBelt` record into a `Place` (the kind filter then collects no candidate, so the
/// entry is ABSENT rather than broken), and driving the whole thing through
/// `GridSession::replay` on a forged log (same).
///
/// So what this row asserts is the reachable half: an undo whose severance IS invertible
/// restores the WHOLE board rather than the port alone. The refusal branch beside it is
/// kept because the policy is right and it costs one line - if a later phase makes the
/// unfoldable shape reachable (phase 76's SHAPE-06 is the candidate, since a footprint
/// resize can strand a belt whose node moves), this row is where its red belongs.
#[test]
fn a_recorded_severance_that_cannot_be_inverted_refuses_the_group() {
    let mut session = GridSession::new(SEED);
    let (r_id, r_h, b_id, _b_h) = docked_router(&mut session, 0);
    let links_before = link_bytes(&session);

    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("removing the docked Out is accepted");
    assert_eq!(
        session.core().last_tick.unlinked[0].belt,
        b_id,
        "the recorded severance names a real, live BELT - which is why the unfoldable \
         branch has no reachable board"
    );

    session.apply(GridCommand::Undo).expect("ONE Undo");
    assert_eq!(
        link_bytes(&session),
        links_before,
        "an invertible severance restores the WHOLE board, never the port alone"
    );
    assert_eq!(
        session.core().state.link_target((r_id, 0)),
        Some((b_id, 0)),
        "and the restored link names the SAME belt, resolved, not merely some belt"
    );
}

/// RED ON HEAD BECAUSE: no compensating `Dock` was emitted at all, so there was no port to
/// pass through and no translation to get wrong.
///
/// `UnlinkedDock.port` is ALREADY the LINK key `fold_dock` wrote. `GridCommand::Unlink.port`
/// is a DIFFERENT keyspace - a spatial catalog index translated at validate time - so
/// routing this one through `dock_link_key` is a bug that TYPECHECKS. This row is what
/// makes it a red instead: the board is a Router, where catalog index 1 translates to
/// routing key 0, so the two keyspaces carry DIFFERENT numbers and a translation cannot
/// hide.
#[test]
fn the_compensating_dock_port_is_passed_through_untranslated() {
    let mut session = GridSession::new(SEED);
    let (_r_id, r_h, _b_id, _b_h) = docked_router(&mut session, 0);

    let before = session.edit_log().len();
    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("removing the docked Out is accepted");
    let recorded = *session
        .core()
        .last_tick
        .unlinked
        .first()
        .expect("the fold recorded the release");
    assert_eq!(
        recorded.port, 0,
        "the fold records the LINK key (routing 0), not the catalog index (1) the Dock \
         command was given - which is what makes the next assertion able to fail"
    );

    session.apply(GridCommand::Undo).expect("ONE Undo");

    let dock = session.edit_log()[before + 1..]
        .iter()
        .find_map(|r| match &r.op {
            EditOp::Dock { port, .. } => Some(*port),
            _ => None,
        })
        .expect("the inverse emitted a compensating Dock");
    assert_eq!(
        dock, recorded.port,
        "the emitted Dock's port equals UnlinkedDock.port with NO dock_link_key translation"
    );
}

// ── 73-12 / CR-01: the routing table the removal DESTROYED comes back ─────────────

/// Install a routing table on `router_h` through the public `Configure` seam.
fn configure_router(
    session: &mut GridSession,
    router_h: u64,
    routes: Vec<(&str, PortId)>,
    default: Option<PortId>,
) {
    session
        .apply(GridCommand::Configure {
            node: router_h,
            config: fabrico_protocol::MachineConfig::Router {
                routes: routes
                    .into_iter()
                    .map(|(tag, port)| {
                        (
                            fabrico_protocol::RouteKey {
                                offset: 0,
                                expect: tag.as_bytes().to_vec(),
                            },
                            port,
                        )
                    })
                    .collect(),
                default,
            },
        })
        .expect("install the routing table");
}

/// The live `(routes, default)` of a Router, resolved - the oracle both CR-01 rows read.
fn router_table(session: &GridSession, router: NodeId) -> (Vec<(Vec<u8>, PortId)>, Option<PortId>) {
    match session.core().state.node(router) {
        Some(fabrico_core::state::Node::Router(r)) => (
            r.routes
                .iter()
                .map(|(k, p)| (k.expect.clone(), *p))
                .collect(),
            r.default,
        ),
        other => panic!("expected a Router, got {other:?}"),
    }
}

/// **THE CR-01 HEADLINE.** A rule that names the REMOVED output is DROPPED by the fold,
/// and one Ctrl+Z has to put it back. Nothing captured it before this plan, so the undo
/// returned `Ok(())`, restored the port and the docks, and handed back a board short one
/// routing rule.
///
/// RED ON HEAD BECAUSE: `fold_remove_port`'s `r.routes.retain(|(_, port)| *port != k)` is
/// information-destroying and `compute_inverse`'s `RemovePort` arm emits an `AddPort` plus
/// compensating `Dock`s and nothing else. `fold_add_port`'s mirror only INCREMENTS keys at
/// or above the insert point; it cannot re-create a dropped rule.
///
/// The board deliberately carries a rule on the removed key AND rules above it, so the
/// row discriminates between "restores everything" and "restores only the shifted ones".
#[test]
fn a_rule_naming_the_removed_output_survives_one_undo() {
    let mut session = GridSession::new(SEED);
    let (r_id, r_h) = place(&mut session, machine_kind::ROUTER, 0, 0);
    // Catalog index 1 is the FIRST Role::Out and therefore ROUTING KEY 0. Rule "A" names
    // exactly that key; "B" and "C" name keys above it.
    configure_router(&mut session, r_h, vec![("A", 0), ("B", 1), ("C", 2)], Some(1));

    let before = router_table(&session, r_id);
    assert_eq!(
        before,
        (
            vec![(b"A".to_vec(), 0), (b"B".to_vec(), 1), (b"C".to_vec(), 2)],
            Some(1)
        ),
        "the board really carries a rule ON the key about to be removed"
    );

    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("remove the FIRST Out");
    assert_eq!(
        router_table(&session, r_id),
        (vec![(b"B".to_vec(), 0), (b"C".to_vec(), 1)], Some(0)),
        "the removal DROPS the rule that named the removed key and decrements the rest - \
         asserted before the undo so a restoration that passed because nothing moved \
         cannot read as a success"
    );

    session.apply(GridCommand::Undo).expect("ONE Undo");

    assert_eq!(
        router_table(&session, r_id),
        before,
        "one press of Ctrl+Z hands back the table the user authored, rule 'A' included"
    );
}

/// The `default` half of the same destruction, kept as its own row because it travels a
/// DIFFERENT arm of the fold (`Some(p) if p == k => None`) and a fix that restores the
/// rules can still leave the fallback cleared.
///
/// RED ON HEAD BECAUSE: `r.default` goes `Some(0)` -> `None` on the removal and nothing
/// puts it back. A board whose unmatched items used to leave on output 1 silently starts
/// FAULTING them, and the undo says `Ok`.
#[test]
fn a_default_naming_the_removed_output_survives_one_undo() {
    let mut session = GridSession::new(SEED);
    let (r_id, r_h) = place(&mut session, machine_kind::ROUTER, 0, 0);
    configure_router(&mut session, r_h, vec![("B", 1)], Some(0));

    let before = router_table(&session, r_id);
    assert_eq!(before.1, Some(0), "the default names the key about to be removed");

    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("remove the FIRST Out");
    assert_eq!(
        router_table(&session, r_id).1,
        None,
        "the removal CLEARS a default that named the removed output (R-25, ruled 2026-09-05)"
    );

    session.apply(GridCommand::Undo).expect("ONE Undo");

    assert_eq!(
        router_table(&session, r_id),
        before,
        "and one Ctrl+Z restores the fallback the user chose"
    );
}

/// The NEGATIVE CONTROL for the two rows above, DECLARED as one rather than left reading
/// as coverage. A removal whose table needs no repair must emit NO compensating
/// `Configure`: the shift-only case is already exactly reversed by `fold_add_port`'s
/// mirror, and a fix that emitted a `Configure` unconditionally would move every frozen
/// fixture that undoes a Router port edit for no behavioural reason.
///
/// RED ON HEAD BECAUSE: it is NOT. On HEAD no `RemovePort` inverse emits a `Configure` at
/// all, so "emits none here" is true for the wrong reason. It earns its place beside the
/// two rows above: together they pin that the arm emits a `Configure` when and only when
/// the fold destroyed something the mirror cannot rebuild.
#[test]
fn a_removal_whose_table_needs_no_repair_emits_no_compensating_configure() {
    let mut session = GridSession::new(SEED);
    let (r_id, r_h) = place(&mut session, machine_kind::ROUTER, 0, 0);
    // Every rule names a key ABOVE the removed one, and so does the default. This is the
    // shape golden 0033 was frozen with, and it is the shape that CANNOT catch CR-01.
    configure_router(&mut session, r_h, vec![("B", 1), ("C", 2)], Some(2));
    let before = router_table(&session, r_id);

    let log_len = session.edit_log().len();
    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("remove the FIRST Out");
    session.apply(GridCommand::Undo).expect("ONE Undo");

    assert_eq!(
        router_table(&session, r_id),
        before,
        "the shift-only case round-trips through the fold mirror alone"
    );
    let emitted: Vec<&EditOp> = session.edit_log()[log_len + 1..].iter().map(|r| &r.op).collect();
    assert!(
        emitted.iter().any(|op| matches!(op, EditOp::AddPort { .. })),
        "the inverse still restores the port"
    );
    assert!(
        !emitted
            .iter()
            .any(|op| matches!(op, EditOp::Configure { .. })),
        "and emits NO compensating Configure, because the mirror already owed nothing"
    );
}

/// The capture has to survive a SAVE and a LOAD, or the repair works in every live session
/// and silently does nothing from disk - the exact half `severed_docks`' own save/load leg
/// exists to catch (67-03, Finding 7).
///
/// RED ON HEAD BECAUSE: the capture does not exist on either path.
#[test]
fn the_table_repair_survives_a_replay_from_the_edit_log() {
    let mut session = GridSession::new(SEED);
    let (r_id, r_h) = place(&mut session, machine_kind::ROUTER, 0, 0);
    configure_router(&mut session, r_h, vec![("A", 0), ("B", 1)], Some(0));
    let before = router_table(&session, r_id);

    session
        .apply(GridCommand::RemovePort { node: r_h, index: 1 })
        .expect("remove the FIRST Out");

    // Rebuild the session PURELY from the edit log, the way a load does. The live capture
    // maps are empty by construction on this path, so the repair can only come from the
    // re-fold harvest in `reconstruct_projection`.
    let mut loaded = GridSession::replay(SEED, session.edit_log());
    loaded.apply(GridCommand::Undo).expect("ONE Undo after the load");

    assert_eq!(
        router_table(&loaded, r_id),
        before,
        "the reloaded board restores the same table the live one does"
    );
}
