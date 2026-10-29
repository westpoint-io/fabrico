//! Phase 39-03 — the certified `GridCommand::Configure` command-layer behaviors:
//! fold-through-the-session, undoable/redoable via an inverse Configure carrying the
//! PRIOR config, and — the headline CFG-02 proof — that undo of a Configure SURVIVES a
//! serialized save→load because the prior-config capture (`prior_configs`) is
//! NON-SERIALIZED and re-derived purely from the persisted edit-log on reconstruct (the
//! exact `removed_ports` / PORT-07 precedent).
//!
//! Everything drives through the public `GridSession::apply(GridCommand::…)` /
//! `Undo` / `Redo` seam and (for the survives-load case) the genuine
//! postcard(edit_log) → `GridSession::replay` path `undo_save_load.rs` uses.

use fabrico_command::{CommandError, GridSession, kind_has_catalog_arm, port_catalog};
// Core shapes for asserting on the EDIT-LOG records (EditOp::Configure carries the core
// MachineConfig); protocol shapes (below) build the GridCommands the session applies.
use fabrico_core::edit::{
    EditOp, EditRecord, MachineConfig as CoreConfig, SourceTrigger as CoreTrigger,
};
use fabrico_core::ids::NodeId;
use fabrico_core::state::{Medium, Node, Role};
use fabrico_protocol::{
    GridCommand, HttpMethod, MachineConfig, SinkTemplate, SourceTrigger, machine_kind, port_medium,
    port_role,
};

const SEED: u64 = 0xC0FFEE;

/// Place a machine of `kind` at a cell and return its minted `NodeId`.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> NodeId {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placed node minted an id")
}

/// The dense render handle for a `NodeId` (what `GridCommand` variants target).
fn handle(session: &GridSession, id: NodeId) -> u64 {
    session.view().handle_of(id).expect("live node has a handle")
}

/// Read a Factory node's current `source` bytes from the folded core.
fn factory_source(session: &GridSession, id: NodeId) -> String {
    match session.core().state.node(id) {
        Some(Node::Factory(f)) => f.source.clone(),
        other => panic!("expected a Factory node, got {other:?}"),
    }
}

/// Read a Sink node's current `template` from the folded core.
fn sink_template(session: &GridSession, id: NodeId) -> SinkTemplate {
    // Re-map the CORE SinkTemplate into the wire mirror for a stable comparison type.
    match session.core().state.node(id) {
        Some(Node::Sink(s)) => core_sink_to_wire(&s.template),
        other => panic!("expected a Sink node, got {other:?}"),
    }
}

/// Map a core `SinkTemplate` into the protocol wire mirror (test-only comparison shim).
fn core_sink_to_wire(t: &fabrico_core::state::SinkTemplate) -> SinkTemplate {
    use fabrico_core::state::{HttpMethod as CoreMethod, SinkTemplate as CoreSink};
    match t {
        CoreSink::Debug => SinkTemplate::Debug,
        CoreSink::Http { url, method } => SinkTemplate::Http {
            url: url.clone(),
            method: match method {
                CoreMethod::Get => HttpMethod::Get,
                CoreMethod::Post => HttpMethod::Post,
                CoreMethod::Put => HttpMethod::Put,
                CoreMethod::Patch => HttpMethod::Patch,
                CoreMethod::Delete => HttpMethod::Delete,
            },
        },
    }
}

/// The last `EditOp::Configure` record in the log (the one an undo/redo just appended).
fn last_configure(session: &GridSession) -> &EditRecord {
    session
        .edit_log()
        .iter()
        .rev()
        .find(|r| matches!(r.op, EditOp::Configure { .. }))
        .expect("a Configure record exists in the log")
}

const NEW_JS: &str = "export default (x) => x + 1";

/// configure_round_trips_via_session: applying a Configure through the session folds it
/// (Factory.source swaps) and the edit-log holds exactly one Configure action with a
/// ZEROED code_hash (the blake3 fence — the command layer never stamps).
#[test]
fn configure_round_trips_via_session() {
    let mut session = GridSession::new(SEED);
    let factory = place(&mut session, machine_kind::FACTORY, 0, 0);
    let h = handle(&session, factory);

    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Factory { source: NEW_JS.to_string() },
        })
        .expect("Configure accepted");

    // The fold swapped the Factory source to the exact new bytes.
    assert_eq!(factory_source(&session, factory), NEW_JS, "fold set Factory.source");

    // Exactly one Configure record, on the resolved node, with a zeroed code_hash.
    let configures: Vec<&EditRecord> = session
        .edit_log()
        .iter()
        .filter(|r| matches!(r.op, EditOp::Configure { .. }))
        .collect();
    assert_eq!(configures.len(), 1, "one Configure record in the log");
    match &configures[0].op {
        EditOp::Configure { node, code_hash, config } => {
            assert_eq!(*node, factory, "Configure freezes on the resolved node");
            assert_eq!(*code_hash, [0u8; 32], "the command layer zeroes code_hash (blake3 fence)");
            assert!(matches!(config, CoreConfig::Factory { source } if source == NEW_JS));
        }
        _ => unreachable!(),
    }
}

/// configure_undo_restores_prior_factory: a Configure swaps Factory.source OLD->NEW;
/// undo restores OLD (via an inverse Configure carrying OLD) and redo re-applies NEW.
#[test]
fn configure_undo_restores_prior_factory() {
    let mut session = GridSession::new(SEED);
    let factory = place(&mut session, machine_kind::FACTORY, 0, 0);
    let h = handle(&session, factory);
    let old = factory_source(&session, factory);
    assert_ne!(old, NEW_JS, "the placement default differs from the new source");

    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Factory { source: NEW_JS.to_string() },
        })
        .expect("Configure accepted");
    assert_eq!(factory_source(&session, factory), NEW_JS, "swapped to NEW");

    session.apply(GridCommand::Undo).expect("undo the Configure");
    assert_eq!(factory_source(&session, factory), old, "undo restored the PRIOR source");

    session.apply(GridCommand::Redo).expect("redo the Configure");
    assert_eq!(factory_source(&session, factory), NEW_JS, "redo re-applied NEW");
}

/// configure_undo_restores_prior_sink: same certified undo/redo for a Sink.template swap.
#[test]
fn configure_undo_restores_prior_sink() {
    let mut session = GridSession::new(SEED);
    let sink = place(&mut session, machine_kind::SINK, 0, 0);
    let h = handle(&session, sink);
    let old = sink_template(&session, sink);

    let new = SinkTemplate::Http {
        url: "http://127.0.0.1/hook".to_string(),
        method: HttpMethod::Patch,
    };
    assert_ne!(old, new, "the placement default differs from the new target");

    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Sink { target: new.clone() },
        })
        .expect("Configure accepted");
    assert_eq!(sink_template(&session, sink), new, "swapped to NEW target");

    session.apply(GridCommand::Undo).expect("undo the Configure");
    assert_eq!(sink_template(&session, sink), old, "undo restored the PRIOR target");

    session.apply(GridCommand::Redo).expect("redo the Configure");
    assert_eq!(sink_template(&session, sink), new, "redo re-applied NEW target");
}

/// configure_undo_source_trigger: a Source config is a CORE no-op (no state), so the
/// undo's proof rides the INVERSE record — undo of a Configure{Source, Timer} appends an
/// inverse Configure carrying the prior trigger (default Webhook when it was the first),
/// and redo re-applies Timer.
#[test]
fn configure_undo_source_trigger() {
    let mut session = GridSession::new(SEED);
    let source = place(&mut session, machine_kind::SOURCE, 0, 0);
    let h = handle(&session, source);

    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 60 } },
        })
        .expect("Configure accepted");

    session.apply(GridCommand::Undo).expect("undo the Configure");
    // The inverse Configure carries the PRIOR trigger — the default Webhook (first config).
    match &last_configure(&session).op {
        EditOp::Configure { node, config, code_hash } => {
            assert_eq!(*node, source, "inverse Configure targets the source node");
            assert_eq!(*code_hash, [0u8; 32], "inverse zeroes code_hash (host re-stamps)");
            assert!(
                matches!(config, CoreConfig::Source { trigger: CoreTrigger::Webhook }),
                "undo restored the prior trigger (default Webhook), got {config:?}",
            );
        }
        _ => unreachable!(),
    }

    session.apply(GridCommand::Redo).expect("redo the Configure");
    // Redo re-applies the ORIGINAL Timer trigger.
    match &last_configure(&session).op {
        EditOp::Configure { config, .. } => assert!(
            matches!(config, CoreConfig::Source { trigger: CoreTrigger::Timer { interval_ticks: 60 } }),
            "redo re-applied the Timer trigger, got {config:?}",
        ),
        _ => unreachable!(),
    }
}

/// configure_undo_survives_load: reconstruct the session from ONLY the persisted
/// edit-log (postcard round-trip → `replay`, NO live capture in memory), then undo the
/// Configure and assert the prior Factory source is restored — proving `prior_configs`
/// is re-derived on reconstruct (a NON-serialized capture that survives save/load, the
/// CFG-02 headline).
#[test]
fn configure_undo_survives_load() {
    let mut session = GridSession::new(SEED);
    let factory = place(&mut session, machine_kind::FACTORY, 0, 0);
    let h = handle(&session, factory);
    let old = factory_source(&session, factory);

    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Factory { source: NEW_JS.to_string() },
        })
        .expect("Configure accepted");

    // SAVE → LOAD: serialize the edit-log exactly as ProjectFile persists it, decode it
    // back, and re-fold from genesis. The reloaded session has an EMPTY in-memory capture
    // until reconstruct_projection re-derives prior_configs purely from the log.
    let bytes = postcard::to_allocvec(&session.edit_log().to_vec()).expect("edit-log encodes");
    let records: Vec<EditRecord> = postcard::from_bytes(&bytes).expect("edit-log decodes");
    let mut reloaded = GridSession::replay(SEED, &records);

    // The same Factory id re-mints deterministically; find it on the reloaded core.
    let reloaded_factory = reloaded
        .core()
        .state
        .node_ids()
        .find(|id| matches!(reloaded.core().state.node(*id), Some(Node::Factory(_))))
        .expect("the reloaded core holds the Factory");
    assert_eq!(factory_source(&reloaded, reloaded_factory), NEW_JS, "reload folded to NEW");
    assert!(reloaded.can_undo(), "the reloaded session can undo the Configure");

    // THE PROOF: undo on the RELOADED session restores the prior source — only possible
    // if prior_configs was re-derived from the persisted log (no serialized field).
    reloaded.apply(GridCommand::Undo).expect("undo on the reloaded session");
    assert_eq!(
        factory_source(&reloaded, reloaded_factory),
        old,
        "undo-after-load restored the PRIOR source (prior_configs re-derived on reconstruct)",
    );
}

// ── the Belt and Router config variants (63-04, BELT-02 / ROUTE-03) ───────────

/// Draw a one-cell belt and return its minted `NodeId`.
fn draw_belt(session: &mut GridSession, cells: Vec<(i32, i32)>) -> NodeId {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("draw a belt on free cells");
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the drawn belt minted an id")
}

/// Read a Belt node's current advance interval from the folded core.
fn belt_interval(session: &GridSession, id: NodeId) -> u32 {
    match session.core().state.node(id) {
        Some(Node::Belt(b)) => b.ticks_per_slot.get(),
        other => panic!("expected a Belt node, got {other:?}"),
    }
}

/// Read a Router node's `(routes, default, faults)` from the folded core.
#[allow(clippy::type_complexity)]
fn router_state(
    session: &GridSession,
    id: NodeId,
) -> (Vec<(fabrico_core::state::RouteKey, u16)>, Option<u16>, u64) {
    match session.core().state.node(id) {
        Some(Node::Router(r)) => (r.routes.clone(), r.default, r.faults),
        other => panic!("expected a Router node, got {other:?}"),
    }
}

/// The LAST addressable routing key on `id`: `out_count - 1`, counted off the live node.
///
/// Since 65-04 a `Configure{Router}` naming a key at or past the node's live `Role::Out`
/// COUNT is a typed `Malformed` reject, so these tests derive their default from the node
/// instead of naming a literal. The literal that used to sit here was `Some(5)`, which was
/// unaddressable on a 3-Out Router and only ever folded because the arm was resolve-only.
fn last_addressable_out(session: &GridSession, id: NodeId) -> u16 {
    let outs = session
        .core()
        .state
        .ports_of(id)
        .expect("a placed node declares ports")
        .iter()
        .filter(|p| p.role == Role::Out)
        .count();
    assert!(outs >= 2, "the Router tests need at least two Outs to pick a non-zero default");
    u16::try_from(outs - 1).expect("an Out count fits a PortId")
}

/// The wire-side routing table used by the Router tests.
fn wire_routes() -> Vec<(fabrico_protocol::RouteKey, u16)> {
    vec![
        (
            fabrico_protocol::RouteKey {
                offset: 0,
                expect: b"alpha".to_vec(),
            },
            1,
        ),
        (
            fabrico_protocol::RouteKey {
                offset: 2,
                expect: b"beta".to_vec(),
            },
            2,
        ),
    ]
}

/// The core-side twin of [`wire_routes`], for asserting on the folded node.
fn core_routes() -> Vec<(fabrico_core::state::RouteKey, u16)> {
    use fabrico_core::state::RouteKey;
    vec![
        (RouteKey::new(0, b"alpha".to_vec()), 1),
        (RouteKey::new(2, b"beta".to_vec()), 2),
    ]
}

/// configure_belt_undo_restores_the_previous_interval: the inverse of a belt-speed
/// Configure is the belt's PREVIOUS interval read off the live node — not a default and
/// not a no-op.
#[test]
fn configure_belt_undo_restores_the_previous_interval() {
    let mut session = GridSession::new(SEED);
    let belt = draw_belt(&mut session, vec![(1, 0), (2, 0)]);
    let h = handle(&session, belt);
    let old = belt_interval(&session, belt);

    // A value that is deliberately NOT the crate default, so an inverse that emitted a
    // default would restore `old` by accident and this test would not notice.
    let new = old + 11;
    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Belt { ticks_per_slot: new },
        })
        .expect("Configure accepted");
    assert_eq!(belt_interval(&session, belt), new, "swapped to the NEW interval");

    session.apply(GridCommand::Undo).expect("undo the Configure");
    assert_eq!(
        belt_interval(&session, belt),
        old,
        "undo restored the PREVIOUS interval, read from the live node"
    );
    assert_ne!(old, new, "the previous interval really did differ from the new one");

    session.apply(GridCommand::Redo).expect("redo the Configure");
    assert_eq!(belt_interval(&session, belt), new, "redo re-applied the NEW interval");
}

/// configure_router_undo_restores_the_table_and_leaves_faults_alone: the inverse
/// restores `routes` and `default`, and the snapshot-captured fault counter is untouched
/// by BOTH directions (T-63-23).
#[test]
fn configure_router_undo_restores_the_table_and_leaves_faults_alone() {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, 0, 0);
    let h = handle(&session, router);
    let (old_routes, old_default, faults_before) = router_state(&session, router);
    let new_default = last_addressable_out(&session, router);
    assert_ne!(
        Some(new_default),
        old_default,
        "the new default really does differ from the one the fold minted"
    );

    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Router {
                routes: wire_routes(),
                default: Some(new_default),
            },
        })
        .expect("Configure accepted");
    let (routes, default, faults_after_configure) = router_state(&session, router);
    assert_eq!(routes, core_routes(), "the table folded VERBATIM, in order");
    assert_eq!(default, Some(new_default), "the default port folded");
    assert_eq!(
        faults_after_configure, faults_before,
        "configuring a router leaves its fault counter alone"
    );

    session.apply(GridCommand::Undo).expect("undo the Configure");
    let (routes, default, faults_after_undo) = router_state(&session, router);
    assert_eq!(routes, old_routes, "undo restored the PREVIOUS table");
    assert_eq!(default, old_default, "undo restored the PREVIOUS default port");
    assert_eq!(
        faults_after_undo, faults_before,
        "undoing a router config leaves its fault counter alone too"
    );

    session.apply(GridCommand::Redo).expect("redo the Configure");
    let (routes, default, _) = router_state(&session, router);
    assert_eq!(routes, core_routes(), "redo re-applied the table");
    assert_eq!(default, Some(new_default), "redo re-applied the default port");
}

/// Serialize a session's edit-log exactly as `ProjectFile` persists it, decode it back
/// and re-fold from genesis — the genuine save/load path, not a shortcut.
fn save_and_load(session: &GridSession) -> GridSession {
    let bytes = postcard::to_allocvec(&session.edit_log().to_vec()).expect("edit-log encodes");
    let records: Vec<EditRecord> = postcard::from_bytes(&bytes).expect("edit-log decodes");
    GridSession::replay(SEED, &records)
}

/// configure_belt_undo_survives_load: the belt prior-config capture is NON-serialized
/// and re-derived from the persisted edit log, so undo after a save/load must restore the
/// same previous interval the live session would have. This is what catches the live and
/// reconstruct-time captures drifting apart.
#[test]
fn configure_belt_undo_survives_load() {
    let mut session = GridSession::new(SEED);
    let belt = draw_belt(&mut session, vec![(1, 0), (2, 0)]);
    let h = handle(&session, belt);
    let old = belt_interval(&session, belt);

    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Belt { ticks_per_slot: old + 11 },
        })
        .expect("Configure accepted");

    let mut reloaded = save_and_load(&session);
    let reloaded_belt = reloaded
        .core()
        .state
        .node_ids()
        .find(|id| matches!(reloaded.core().state.node(*id), Some(Node::Belt(_))))
        .expect("the reloaded core holds the belt");
    assert_eq!(
        belt_interval(&reloaded, reloaded_belt),
        old + 11,
        "the reload folded the NEW interval"
    );

    reloaded.apply(GridCommand::Undo).expect("undo on the reloaded session");
    assert_eq!(
        belt_interval(&reloaded, reloaded_belt),
        old,
        "undo-after-load restored the PREVIOUS interval (the capture was re-derived)"
    );
}

/// configure_router_undo_survives_load: the same proof for the routing table, which is
/// the field that would silently come back empty if the reconstruct-time capture arm were
/// missing or written differently from the live one.
#[test]
fn configure_router_undo_survives_load() {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, 0, 0);
    let h = handle(&session, router);
    let (old_routes, old_default, _) = router_state(&session, router);

    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Router {
                routes: wire_routes(),
                default: Some(last_addressable_out(&session, router)),
            },
        })
        .expect("Configure accepted");

    let mut reloaded = save_and_load(&session);
    let reloaded_router = reloaded
        .core()
        .state
        .node_ids()
        .find(|id| matches!(reloaded.core().state.node(*id), Some(Node::Router(_))))
        .expect("the reloaded core holds the router");
    assert_eq!(
        router_state(&reloaded, reloaded_router).0,
        core_routes(),
        "the reload folded the NEW table"
    );

    reloaded.apply(GridCommand::Undo).expect("undo on the reloaded session");
    let (routes, default, _) = router_state(&reloaded, reloaded_router);
    assert_eq!(routes, old_routes, "undo-after-load restored the PREVIOUS table");
    assert_eq!(default, old_default, "undo-after-load restored the PREVIOUS default");
}

/// configure_wrong_kind_belt_and_router_are_skips_not_refusals: aiming a Belt config at a
/// router (and a Router config at a belt) is accepted at validate time — validity there is
/// a resolve-only gate — folds to nothing, and its undo is a SKIP rather than a refusal,
/// exactly as for the other three variants.
#[test]
fn configure_wrong_kind_belt_and_router_are_skips_not_refusals() {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, 0, 0);
    let belt = draw_belt(&mut session, vec![(2, 2), (3, 2)]);
    let router_h = handle(&session, router);
    let belt_h = handle(&session, belt);
    let belt_before = belt_interval(&session, belt);
    let router_before = router_state(&session, router);

    // A Belt config aimed at the ROUTER.
    session
        .apply(GridCommand::Configure {
            node: router_h,
            // 7, not the 99 that stood here until plan 68-04. The value is arbitrary to
            // THIS test's question - whether a wrong-KIND Configure is a fold no-op with
            // a skipped undo - but it is no longer arbitrary to the layer: the `2..=20`
            // pace bound runs on the CONFIG's shape and not on the target's kind (the
            // same reading as the router target-port check's settled decision 1), so 99
            // is now `PaceOutOfRange` and would refuse before this test's question is
            // ever asked. 7 is in range and is deliberately NOT one of the five offered
            // steps.
            config: MachineConfig::Belt { ticks_per_slot: 7 },
        })
        .expect("a wrong-kind Configure is a resolve-only accept");
    // A Router config aimed at the BELT. The table is EMPTY with no default, because
    // since 65-04 a routing table is bounded against the TARGET NODE's live `Role::Out`
    // count regardless of its kind, and a belt has none. The empty table is a legal core
    // state (every item faults) and is the only Router shape a portless node can carry,
    // so it is what this test uses to keep asking its own question: whether a wrong-KIND
    // Configure is a fold no-op with a SKIPPED undo rather than a refusal. The
    // out-of-range half now has its own coverage in the crate's `Configure` arm tests.
    session
        .apply(GridCommand::Configure {
            node: belt_h,
            config: MachineConfig::Router {
                routes: Vec::new(),
                default: None,
            },
        })
        .expect("a wrong-kind Configure is a resolve-only accept");

    assert_eq!(belt_interval(&session, belt), belt_before, "the belt is untouched");
    assert_eq!(router_state(&session, router), router_before, "the router is untouched");

    // Both undos SUCCEED (a skip, not a refusal): there is genuinely nothing to invert.
    session.apply(GridCommand::Undo).expect("undo the wrong-kind Router config");
    session.apply(GridCommand::Undo).expect("undo the wrong-kind Belt config");
    assert_eq!(belt_interval(&session, belt), belt_before, "still untouched after undo");
    assert_eq!(router_state(&session, router), router_before, "still untouched after undo");
}

/// configure_belt_capture_miss_on_a_live_belt_is_refused: the capture-miss discriminator
/// learned both new variants, so a miss against a LIVE node of the MATCHING kind is a
/// REFUSAL. Without that clause the predicate answers `false`, the group is skipped, and
/// the user spends an undo step and gets nothing back with no message (T-51H-03).
///
/// The miss is forged the only way it can occur: the `Configure` sits in the SAME tick
/// slice as the `DrawBelt` that mints its target, so the capture reads the pre-slice core,
/// finds no such node, and skips — while by undo time the belt is live and is a belt.
///
/// What the missing pair actually costs, MEASURED by removing it and re-running rather
/// than predicted: the undo does not fail loudly and it does not do nothing either. It
/// returns `Ok`, emits the `DrawBelt`'s inverse, and SILENTLY DROPS the config restore —
/// so the undo looks like it worked. With the pair present the whole group is refused.
#[test]
fn configure_belt_capture_miss_on_a_live_belt_is_refused() {
    // Learn the deterministic ids and the exact frozen records from a normal session.
    let mut donor = GridSession::new(SEED);
    let belt = draw_belt(&mut donor, vec![(1, 0), (2, 0)]);
    let h = handle(&donor, belt);
    donor
        .apply(GridCommand::Configure {
            node: h,
            // 11, not the 42 that stood here until plan 68-04: the `2..=20` write bound
            // makes 42 a `PaceOutOfRange` refusal, and this test needs an ACCEPTED
            // Configure to forge its capture miss from. 11 is in range and is not one of
            // the five offered steps, so it is still visibly not a default.
            config: MachineConfig::Belt { ticks_per_slot: 11 },
        })
        .expect("Configure accepted");

    // Re-stamp both records into ONE tick AND one action. That is what forges the miss:
    // the projection walk captures a Configure's prior value from the core as it stands
    // before its slice folds, and here the `DrawBelt` that mints the target sits in the
    // same slice — so at capture time there is no such node and the capture is skipped,
    // while by undo time the belt is live and IS a belt. (Splitting the two records into
    // separate actions does NOT reproduce it: the walk then folds the DrawBelt's slice
    // first and the capture succeeds. Measured, not assumed.) Replay re-mints the belt
    // with the same generational id, so the Configure still names it.
    let forged: Vec<EditRecord> = donor
        .edit_log()
        .iter()
        .enumerate()
        .map(|(i, r)| EditRecord {
            sequence: i as u64,
            tick: 0,
            action: 1,
            ..r.clone()
        })
        .collect();
    let mut session = GridSession::replay(SEED, &forged);
    let live_belt = session
        .core()
        .state
        .node_ids()
        .find(|id| matches!(session.core().state.node(*id), Some(Node::Belt(_))))
        .expect("the replayed core holds the belt");
    assert_eq!(belt_interval(&session, live_belt), 11, "the forged log folded the config");

    let before = postcard::to_allocvec(&session.core().state).expect("serialize GridState");
    assert_eq!(
        session.apply(GridCommand::Undo),
        Err(fabrico_command::CommandError::UndoDoesNotFit),
        "a capture miss against a LIVE belt of the matching kind is a typed refusal"
    );
    assert_eq!(
        postcard::to_allocvec(&session.core().state).expect("serialize GridState"),
        before,
        "the refused undo mutated nothing"
    );
}

/// configure_belt_zero_interval_is_refused: the wire carries a plain `u32` and the core
/// carries `NonZeroU32`, so the conversion is fallible. A zero is a typed reject that
/// produces NOTHING — never a belt running at a speed the user did not choose (T-63-24).
#[test]
fn configure_belt_zero_interval_is_refused() {
    let mut session = GridSession::new(SEED);
    let belt = draw_belt(&mut session, vec![(1, 0), (2, 0)]);
    let h = handle(&session, belt);
    let before = belt_interval(&session, belt);
    let log_len = session.edit_log().len();

    assert_eq!(
        session.apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Belt { ticks_per_slot: 0 },
        }),
        Err(fabrico_command::CommandError::ZeroBeltInterval),
        "a zero belt interval is refused with its own typed error"
    );
    assert_eq!(session.edit_log().len(), log_len, "the refusal appended NO record");
    assert_eq!(belt_interval(&session, belt), before, "the belt is untouched");

    // And the neighbouring ACCEPTED value is applied, so the guard is a bound and not a
    // blanket refusal of the variant.
    //
    // That neighbour is 2 and not 1 since plan 68-04. `ticks_per_slot = 1` is still a
    // legal CORE value - it is what every pre-68 save and the whole load path may carry -
    // but it is exactly the measured direction-ambiguity wall, so the `2..=20` write
    // bound refuses it with `PaceOutOfRange`. The two refusals are asserted as DISTINCT
    // here, which is the property that keeps each sentence true of its own cause: "A belt
    // needs a speed above zero." is false for someone who typed a large pace, and "That
    // pace is outside the Belt pace scale." is a poor answer for an empty field.
    assert_eq!(
        session.apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Belt { ticks_per_slot: 1 },
        }),
        Err(fabrico_command::CommandError::PaceOutOfRange),
        "the wall value 1 is refused by the write bound, with its OWN tag"
    );
    assert_eq!(session.edit_log().len(), log_len, "that refusal appended no record either");
    session
        .apply(GridCommand::Configure {
            node: h,
            config: MachineConfig::Belt { ticks_per_slot: 2 },
        })
        .expect("the fastest OFFERED pace is accepted");
    assert_eq!(belt_interval(&session, belt), 2, "ticks_per_slot 2 folded");
}

// ───────────────────── WIRE-03 (63-07): the HTTP Endpoint becomes placeable ──────────
//
// `Node::Endpoint` and `add_endpoint` have existed since Phase 38 and `fold_place` has
// minted one from kind 9 since 63-04, but `validate_normalize` refused the byte before
// the catalog was ever consulted, so nothing could ask for one through the command
// layer. These cases land the two remaining halves with a frozen byte consequence: the
// Place gate and the catalog arm. No palette entry, no webhook URL surfacing, no UI:
// WIRE-03's user-facing half is Phase 66.

/// The catalog index of the first port on `id` with `role`, or a panic naming what was
/// found instead. Read back rather than written down: 63-07 moved several of these.
fn port_index(session: &GridSession, id: NodeId, role: Role, medium: Medium) -> u16 {
    let ports = session
        .core()
        .state
        .ports_of(id)
        .expect("the node carries ports");
    let idx = ports
        .iter()
        .position(|p| p.role == role && p.medium == medium)
        .unwrap_or_else(|| panic!("no {role:?}/{medium:?} port among {ports:?}"));
    u16::try_from(idx).expect("port index fits u16")
}

#[test]
fn place_endpoint_is_accepted_and_freezes_its_catalog_footprint_and_ports() {
    let mut session = GridSession::new(SEED);
    let ep = place(&mut session, machine_kind::ENDPOINT, 2, 2);
    let (foot, ports) = port_catalog(machine_kind::ENDPOINT);
    match &session.edit_log().last().expect("a record was appended").op {
        EditOp::Place { kind, cell_x, cell_y, w, h, ports: frozen, rot } => {
            assert_eq!(*kind, machine_kind::ENDPOINT);
            assert_eq!((*cell_x, *cell_y), (2, 2));
            assert_eq!(*rot, 0, "a forward placement is unturned (EDIT 13)");
            assert_eq!((*w, *h), (foot.w, foot.h), "the record freezes the catalog dims");
            assert_eq!(frozen, &ports, "the record freezes the catalog ports VERBATIM");
        }
        other => panic!("expected an EditOp::Place, got {other:?}"),
    }
    assert!(
        matches!(session.core().state.node(ep), Some(Node::Endpoint(_))),
        "the accepted Place folded to a Node::Endpoint",
    );
}

#[test]
fn port_catalog_endpoint_carries_the_repositorys_first_electrical_ports() {
    // Every one of the 17 ports across the pre-63-07 catalog arms is Mechanical. Until
    // now the only electrical ports the command layer could produce came from
    // `place_router_preset(Medium::Electrical, ..)` re-seeding via AddPort. This is the
    // first arm that declares them, which is why it is asserted rather than assumed.
    let (foot, ports) = port_catalog(machine_kind::ENDPOINT);
    assert!(
        ports.iter().any(|p| p.role == Role::Out && p.medium == Medium::Electrical),
        "the endpoint has an electrical Out for the request leg",
    );
    assert!(
        ports.iter().any(|p| p.role == Role::In && p.medium == Medium::Electrical),
        "the endpoint has an electrical In for the reply leg",
    );
    assert!(
        ports.iter().all(|p| p.medium == Medium::Electrical),
        "an endpoint speaks only the wire medium",
    );
    for (i, p) in ports.iter().enumerate() {
        let (x, y) = p.local_offset;
        assert!(
            x >= 0 && y >= 0 && x < i32::from(foot.w) && y < i32::from(foot.h),
            "endpoint port {i} at {:?} is outside its {}x{} footprint",
            p.local_offset,
            foot.w,
            foot.h,
        );
    }
}

#[test]
fn place_wire_is_still_refused_as_unknown_kind() {
    // The trap the ENDPOINT bound had to step around. WIRE is 8 and ENDPOINT is 9, so
    // raising a `kind > SINK` ceiling to admit 9 would silently have admitted 8 too. A
    // wire comes only from DrawWire, exactly as a belt comes only from DrawBelt.
    let mut session = GridSession::new(SEED);
    assert_eq!(
        session
            .apply(GridCommand::Place { kind: machine_kind::WIRE, cell_x: 0, cell_y: 0 })
            .expect_err("Place{WIRE} is refused"),
        CommandError::UnknownKind,
        "a refusal, not a no-op: nothing is minted and nothing is logged",
    );
    assert!(session.edit_log().is_empty(), "a refused Place appends no record");
    assert_eq!(session.core().state.node_count(), 0, "a refused Place mints nothing");
}

#[test]
fn the_place_gate_and_the_catalog_are_one_contract() {
    // The gate and `port_catalog` are ONE contract in both directions, checked over the
    // WHOLE byte range rather than over a list somebody has to remember to extend:
    //   - every kind the gate admits HAS a catalog arm, or `port_catalog`'s
    //     `unreachable!` fires and this test panics;
    //   - every kind it does not admit is refused with UnknownKind BEFORE the catalog is
    //     reached, which is what keeps that `unreachable!` unreachable.
    let mut session = GridSession::new(SEED);
    for kind in 0..=u8::MAX {
        if kind_has_catalog_arm(kind) {
            let _ = port_catalog(kind);
        } else {
            assert_eq!(
                session
                    .apply(GridCommand::Place { kind, cell_x: 0, cell_y: 0 })
                    .expect_err("a kind with no catalog arm is refused"),
                CommandError::UnknownKind,
                "kind {kind} has no catalog arm and must be refused before the catalog",
            );
        }
    }
}

#[test]
fn a_command_placed_endpoint_is_identical_to_an_add_endpoint_one() {
    // `fold_place`'s ENDPOINT arm was proved byte-identical to `add_endpoint` in 63-04
    // over a hand-built record. This is the same claim from the COMMAND layer, which is
    // the half 63-04 could not reach because the Place gate refused kind 9.
    let mut session = GridSession::new(SEED);
    let ep = place(&mut session, machine_kind::ENDPOINT, 0, 0);
    assert!(
        session.core().state.inbox_of(ep).is_some(),
        "the minted endpoint carries its inbox (the add_endpoint seam, not a bare node)",
    );

    let mut direct = fabrico_core::core::Core::genesis(fabrico_core::event::LogHeader {
        schema_version: fabrico_core::event::SCHEMA_VERSION,
        seed: SEED,
    });
    let id = direct.state.add_endpoint();
    let (foot, ports) = port_catalog(machine_kind::ENDPOINT);
    direct.state.claim_footprint(id, (0, 0), foot.w, foot.h, 0);
    direct.state.set_ports(id, ports);
    assert_eq!(
        postcard::to_allocvec(&session.core().state).expect("serialize the session state"),
        postcard::to_allocvec(&direct.state).expect("serialize the direct state"),
        "a command-placed endpoint is byte-identical to a directly minted, claimed one",
    );
}

#[test]
fn a_wire_runs_from_a_placed_endpoint_to_an_add_ported_electrical_in() {
    // THE DECIDED DESTINATION. A wire drawn from an endpoint needs an electrical
    // `Role::In` at the far end. Three ways to supply one were considered; the chosen
    // one is `GridCommand::AddPort` with an explicit medium byte, because it adds NO new
    // catalog surface and NO new serialized shape (a new electrical HANDLER catalog arm
    // or a second preset would each be another unfrozen-function-into-frozen-artifact
    // surface, and Phase 66 might reasonably want to change it once it has a handler
    // UI). This case proves the choice is expressible entirely through GridCommands.
    let mut session = GridSession::new(SEED);
    let ep = place(&mut session, machine_kind::ENDPOINT, 0, 0);
    let factory = place(&mut session, machine_kind::FACTORY, 5, 0);
    let factory_h = handle(&session, factory);
    session
        .apply(GridCommand::AddPort {
            node: factory_h,
            role: port_role::IN,
            side: 3, // W
            medium: port_medium::ELECTRICAL,
        })
        .expect("an electrical In is addable to a placed factory");

    let from_port = port_index(&session, ep, Role::Out, Medium::Electrical);
    let to_port = port_index(&session, factory, Role::In, Medium::Electrical);
    session
        .apply(GridCommand::DrawWire {
            from_node: handle(&session, ep),
            from_port,
            to_node: factory_h,
            to_port,
        })
        .expect("the wire is legal: electrical Out to electrical In, no self-loop");

    let wire = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the DrawWire minted a wire id");
    assert!(
        matches!(session.core().state.node(wire), Some(Node::Wire(_))),
        "the fold minted a Node::Wire",
    );
    assert_eq!(
        session.core().state.link_target((wire, 0)),
        Some((factory, to_port)),
        "the wire's forward link reaches the AddPort-ed electrical In",
    );
}
