//! The MILESTONE EXIT GATE (TEST-05) — a COMPLEX factory built, run, edited, and
//! undone ENTIRELY from a serialized command log, in a HEADLESS Rust test with NO
//! renderer and NO host present.
//!
//! This is THE proof the v2.0 command layer has not leaked: the headline scenario
//! `fixtures/01-exit-gate.postcard` (authored in `bless_fixtures.rs` purely through
//! `GridCommand` via the `Scene` builder) is decoded back to a [`Scenario`] and
//! reconstructed via [`GridSession::replay_two_logs`] — the FULL build→run→edit→undo
//! arc rebuilt from the two ordered logs alone. Every build/run/edit/undo step was a
//! `GridCommand`; nothing reached around the command layer into the core. If any step
//! had NOT been expressible through `GridCommand`, it could not have been authored into
//! the fixture in the first place — so a green exit gate IS the no-leak certification
//! (threat T-13-11).
//!
//! # Headless contract (no renderer / no host)
//! This test imports ONLY `fabrico_scenario` (the harness) + `fabrico_command`
//! (`GridSession`) + `fabrico_core` (the deterministic core). It imports NOTHING from
//! `fabrico-host`, any renderer (PixiJS / wgpu), `tokio`, `axum`, or the Tauri shell —
//! and the crate-wide `tests/deps_headless.rs` fence FAILS THE BUILD if such a crate
//! ever enters `fabrico-scenario`'s normal dependency tree. The exit gate is pure
//! headless Rust.
//!
//! # The one expressivity boundary (recorded, Pitfall 5)
//! The fixture's `FACTORY` node is a REAL running QuickJS node, but it runs the FIXED
//! default passthrough `ctx.emit(0, input)` — there is no `GridCommand` to author
//! CUSTOM factory JS, and (the same family) no command to configure a `ROUTER`'s route
//! table. Those are BEHAVIORAL CONFIG, deliberately off the command wire at v2.0; they
//! are recorded as future seeds in the plan SUMMARY, NOT worked around here. Everything
//! that IS topology — a multi-cell `ROUTER`, `DrawBelt`, `Dock`, `Rotate`,
//! `move`/`Undo` — is fully expressible and is exercised by this gate.
//!
//! # Wire-drawing, and why this gate does not exercise it
//! `GridCommand::DrawWire` EXISTS (discriminant 10, appended in plan 63-02), so a wire
//! is authored through the command wire like every other topology edit, and a drawn
//! wire is undoable through the same `Undo` verb this fixture drives. The Phase-17
//! removal that this note used to record is still true and still the reason the
//! discriminants sit where they do: the old node→node `Wire` command was deleted
//! outright, and `DrawWire` is a different op appended after it, not a revival.
//!
//! This fixture stays wire-free on purpose. Its board is Mechanical throughout, and a
//! `DrawWire` needs two `Medium::Electrical` ports, which only `place_router_preset`
//! produces — a different board, not a bigger one. Wire behaviour is proven where it
//! lives: `fabrico-core/tests/draw_wire.rs`, `fabrico-command/tests/draw_wire.rs` and
//! the request/response round trip in `fabrico-host/tests/headline.rs`.
//!
//! # Hash is primary (T-13-HASH)
//! The terminal `tick_hash` is the PRIMARY assertion (the one digest path). The id-free
//! `StateSummary` and the node-count deltas are secondary readability aids.

use fabrico_command::GridSession;
use fabrico_scenario::{
    Scenario, assert_arrival_order_independent, assert_replays, assert_snapshot_restore,
    tick_hash,
};

/// The committed headline fixture — the complex build→run→edit→undo command log,
/// embedded at compile time so the gate cannot run without it (and a missing fixture
/// is a COMPILE error, not a silent skip).
const EXIT_GATE_FIXTURE: &[u8] = include_bytes!("../fixtures/01-exit-gate.postcard");

/// The PINNED terminal `tick_hash` of the exit-gate scenario after the full
/// build→run→edit→undo replay. Frozen from the authored scenario (the one digest path,
/// `oracle::tick_hash`); a drift here is a deliberate, reviewable change (and the
/// `bless_fixtures::committed_fixtures_match_authoring` guard catches authoring drift
/// independently).
///
/// Re-pinned by Phase 60 (`60-02`), the belt slot-density change. The scenario carries
/// belts, so both the belt timing and the snapshot version tag inside the hashed bytes
/// moved:
///   OLD `8b7782e3d8cf2238bcb962bc62cba7fbede913a9aa25d39d14d0a33ae67272b3`
///   NEW `7c4a2b288eda5c0b41ccee69669a9f696deec5e91ffb322a17f800aa2ce886bc`
/// The committed `fixtures/01-exit-gate.postcard` is BYTE-IDENTICAL across the change
/// (`bless_fixtures::committed_fixtures_match_authoring` stayed green), so what moved is
/// the replayed terminal STATE, not the authored scenario. The matching
/// `snapshots/01-exit-gate.snap` moved to the same value, and its identifier-free state
/// summary line (`nodes=8 belts=3 items=1 faulted=[]`) is byte-identical before and
/// after: topology and item conservation are untouched, only timing and capacity moved.
///
/// This is a HAND-WRITTEN literal and it must stay one. It is `fabrico-scenario`'s only
/// gate on core replay behaviour; derived from `SLOTS_PER_TILE` it would agree with the
/// constant at every value.
///
/// # Re-pinned by Phase 62 (plan 62-09, 2026-08-14): the belt ADVANCE INTERVAL
/// `Belt.ticks_per_slot` became serialized per-belt state (SLOT-03) and the shipped
/// default moved from the pre-change identity of 1 to **2** - the maintainer's value, chosen
/// at a pace review.
/// `SNAPSHOT_SCHEMA_VERSION` moved 9 -> 10 and `PROJECT_FILE_VERSION` 7 -> 8 in lockstep
/// (plan 62-06). The exit-gate scene carries three belts, so this hash moves on all
/// three counts: the new serialized field, the version tag inside the hashed bytes, and
/// the item slot positions the slower advance produces.
///   OLD `7c4a2b288eda5c0b41ccee69669a9f696deec5e91ffb322a17f800aa2ce886bc`
///   NEW `4a82af357a57279ad994575541f33e2a95076977125a1cf00f67f506968afd37`
///
/// **THE PHASE 60 CLAUSE ABOVE NO LONGER HOLDS, AND THAT IS RECORDED RATHER THAN
/// SILENTLY OVERWRITTEN.** `fixtures/01-exit-gate.postcard` is NOT byte-identical across
/// this change: it grew from 416 to 424 bytes. `bless_fixtures.rs`'s `SETTLE` budget is
/// `64 * DEFAULT_TICKS_PER_SLOT` (plan 62-03), so doubling the interval doubles the
/// settle from 64 to 128 ticks and every tick stamp in the authored log shifts by +64 -
/// far enough that several cross the postcard one-byte varint boundary at 128 and take a
/// second byte. **So what moved this time is the AUTHORED SCENARIO as well as the
/// replayed state**, and Phase 60's strengthened fixtures clause is superseded by name.
///
/// **ORDER MATTERS WHEN RE-PINNING THIS, and getting it wrong is silent.** `exit_gate.rs`
/// and `golden_hashes.rs` both `include_bytes!` the committed fixture, so the scenario
/// fixtures MUST be re-authored (`cargo test -p fabrico-scenario --test bless_fixtures --
/// --ignored`) BEFORE the insta snapshots are re-blessed and before this literal is read.
/// Plan 62-09 did it in the wrong order first and measured
/// `9a4fa79d745af1fb93245e1c928344b486ea0932c2ddd99318764e7ee4736064` - a perfectly
/// stable, perfectly reproducible hash of the NEW core replaying the OLD fixture. It
/// would have passed forever and certified a scenario nobody authored.
///
/// # Re-pinned by Phase 63 (plan 63-12, 2026-08-19): the ROUTER port arity, NOT the schema bump
/// The one deliberate re-bless of milestone v8.0 moved this literal, and the cause is the
/// one a reader would not guess from the commit it lands in. Plan 63-11 bumped
/// `EDIT_SCHEMA_VERSION` 6 -> 7, and **that bump contributes ZERO to this hash**: the
/// version tag is never folded into `GridState`, so it cannot reach `tick_hash`.
///   OLD `4a82af357a57279ad994575541f33e2a95076977125a1cf00f67f506968afd37`
///   NEW `153f30885af109b934d9dc18f52c5c257553dd9b3e4ed85adfa713fa437c85cc`
///
/// What moved it is plan 63-07's ROUTE-02 change, which widened `port_catalog(ROUTER)`
/// from one `Role::Out` to `ROUTER_OUT_ARITY` (three). The scene places its ROUTER
/// through the command layer, so its `Place{ROUTER}` record now carries four ports
/// instead of two, and the replayed board therefore holds two more `GridState.ports`
/// entries. The scenario corpus was left deliberately unblessed from that plan until
/// this one, which is why a change made at plan 63-07 surfaces here.
///
/// MEASURED, not reasoned: a scratch worktree at plan 63-07's own commit
/// (edit schema version SIX) was re-blessed and replayed, and produced
/// `153f3088...` exactly. Same hash at version 6 and at version 7 is the direct
/// evidence that the version tag does not reach the fold.
///
/// The `fixtures/01-exit-gate.postcard` byte growth splits the same way, each half
/// measured in its own scratch worktree: 424 -> 426 at plan 63-06, two
/// `Delete` records each gaining one empty-`Vec` varint for the `DeletedSubgraph` wire
/// capture; 426 -> 436 at plan 63-07, two extra five-byte `Port` entries on
/// the one catalog-authored `Place{ROUTER}`; and 436 -> 436 here, a `0x06` -> `0x07`
/// substitution at each of the 22 record starts with no length change.
///
/// The state summary line (`nodes=8 belts=3 items=1 faulted=[]`) is byte-identical
/// before and after, which is `bless_fixtures.rs`'s free tell that no fixture was
/// blessed mid-transport.
///
/// RE-PINNED BY PLAN 71-07 for plan 71-04's PILE-10 fault nub. `port_catalog` appends a
/// real `Role::Fault` port to the SINK and ROUTER entries, and the exit-gate scene places
/// both, so the terminal snapshot this digest covers grew by two `GridState.ports`
/// entries. This target re-authors from the command log rather than reading the committed
/// fixture, so it is an AUTHORING-side detector like `committed_fixtures_match_authoring`
/// and it reddened the moment the catalog moved, one plan before the corpus was blessed.
///
/// THE RE-PIN IS CHECKED, not taken: the new value is BYTE-EQUAL to the re-blessed
/// `crates/fabrico-scenario/snapshots/01-exit-gate.snap`, which was regenerated by a
/// different path (insta over `golden_hashes.rs`, replaying the COMMITTED fixture bytes)
/// in the same commit. Two independent paths landing on one hash is what makes this a
/// re-pin rather than a red typed away. The SECONDARY count assertions below are
/// UNCHANGED and still pass at 8 nodes: a Fault nub is a PORT on an existing node, so
/// nothing about the post-undo topology moved.
///   OLD `153f30885af109b934d9dc18f52c5c257553dd9b3e4ed85adfa713fa437c85cc`
///   NEW `8604832e1e234b9df8db7f0bde7b0d09e28a91acbea59775ff0e4a201c730988`
///
/// RE-PINNED BY PLAN 72-12 for the D-20 schema bump, and this move has no scene cause at
/// all. `SNAPSHOT_SCHEMA_VERSION` went 10 to 11, `snapshot()` prefixes that value as a
/// little-endian tag ahead of the postcard body (`snapshot.rs:233-236`), and `tick_hash`
/// is `blake3` over exactly those bytes. So this digest moved on the TAG, with the
/// exit-gate scene, its command log and its catalog all byte-identical.
///
/// THE RE-PIN IS CHECKED, not taken, by the SAME two-path rule the 71-07 note above
/// established: the new value is BYTE-EQUAL to the re-blessed
/// `crates/fabrico-scenario/snapshots/01-exit-gate.snap`, regenerated in this same commit
/// by insta over `golden_hashes.rs`, which replays the COMMITTED fixture bytes rather
/// than re-authoring them. Two independent paths landing on one hash is what separates a
/// re-pin from a red typed away. The SECONDARY count assertions below are UNCHANGED and
/// still pass at 8 nodes: a version tag is not a topology.
///
/// The record-count arithmetic in the paragraph above this one is likewise UNCHANGED at
/// 436, and that is worth stating rather than leaving to be re-derived: the tag prefixes
/// the SNAPSHOT, not the edit log, so no `EditRecord` grew and `EDIT_SCHEMA_VERSION` is
/// still 7 (D-21).
///   OLD `8604832e1e234b9df8db7f0bde7b0d09e28a91acbea59775ff0e4a201c730988`
///   NEW `e8bb8d15850fb04a4b066235e47aa99755b05d25d183361ed3a1d087ee394032`
///
/// RE-PINNED BY PLAN 74-02 for the belt-is-a-ported-node break (LINK-08 / D-04 / D-09):
/// `SNAPSHOT_SCHEMA_VERSION` 11 -> 12, `PROJECT_FILE_VERSION` 10 -> 11. Unlike the 72-12
/// move above, this one has TWO causes and neither is a scene cause. The version tag moves
/// every state digest in the repository, and on top of that the exit-gate board carries
/// THREE belts, each of which now declares two stored `Port` records where it declared
/// none, so the hashed bytes grow as well. The scene, its command log and its catalog are
/// all byte-identical.
///
/// THE RE-PIN IS CHECKED, not taken, by the same two-path rule: the new value is
/// BYTE-EQUAL to the re-blessed `crates/fabrico-scenario/snapshots/01-exit-gate.snap`,
/// regenerated in this same commit by insta over `golden_hashes.rs`, which replays the
/// COMMITTED fixture bytes rather than re-authoring them. The SECONDARY count assertions
/// below are UNCHANGED and still pass at 8 nodes, and the `.snap`'s own summary line still
/// reads `nodes=8 belts=3 items=1 faulted=[]`: a belt gaining ports is not a topology.
///
/// The record-count arithmetic further above is likewise UNCHANGED at 436, for the same
/// reason the 72-12 note gives: the belt ports are a `GridState` shape, not an
/// `EditRecord` field, so no record grew and `EDIT_SCHEMA_VERSION` is still 8 (D-01).
///   OLD `e8bb8d15850fb04a4b066235e47aa99755b05d25d183361ed3a1d087ee394032`
///   NEW `6a8f0fd5073c248a37e58694e8b9faa7c7941c5fc5723f54efde66f0a51d5230`
///
/// RE-PINNED BY PLAN 74.1-14 (CORNER-06, the "Edits keep middle
/// layout" rule) as a NAMED SCENE CHANGE, the first in this list. The Router catalog took the
/// port-edit reseat rule's output, so the exit-gate Router's In moved to (5,1) and its
/// first Out to (6,1); `bless_fixtures.rs` redrew the belt into the In to end on (4,1) (one
/// more tile) and the offload belt to start on (7,1), and the `Place{ROUTER}` record freezes
/// the new offsets. `EDIT_SCHEMA_VERSION` 9 -> 10 moved every record's tag. The re-pin is
/// CHECKED by the same two-path rule: the new value is byte-equal to the re-blessed
/// `crates/fabrico-scenario/snapshots/01-exit-gate.snap`, whose summary line still reads
/// `nodes=8 belts=3 items=1 faulted=[]`.
///   OLD `6a8f0fd5073c248a37e58694e8b9faa7c7941c5fc5723f54efde66f0a51d5230`
///   NEW `da34c9a879bfb80403fe808cc90cf756397b26af381a67e4e7b9d5110d27104e`
///
/// RE-PINNED BY PLAN 85-05 for the Email removal (CHROME-04, D-08): `SNAPSHOT_SCHEMA_VERSION`
/// 12 -> 13 and `EDIT_SCHEMA_VERSION` 11 -> 12. Not a scene change: the version tag moves
/// every state digest, and every record of the fixture's edit log carries the new tag. The
/// scene, its command log and its catalog are otherwise byte-identical. The re-pin is
/// CHECKED by the same two-path rule: the new value is byte-equal to the re-blessed
/// `crates/fabrico-scenario/snapshots/01-exit-gate.snap`, whose summary line still reads
/// `nodes=8 belts=3 items=1 faulted=[]`.
///   OLD `da34c9a879bfb80403fe808cc90cf756397b26af381a67e4e7b9d5110d27104e`
///   NEW `50f82d60d69a4f777569e548300e90284632ba5556f636085afd236b080d8529`
///
/// RE-PINNED BY PLAN 87-08 (JAM-01 to JAM-05, D-10, D-11): `SNAPSHOT_SCHEMA_VERSION` 13 -> 14,
/// which adds `Balancer.next_in`, `Tee.faults`, `Factory.pending_emits` and
/// `Scheduler.blocked` to every state digest, and plan 87-07's settled-belt sleep, which this
/// scene's packed belt reaches (a settled belt joins `Scheduler.blocked`, a digested field). The
/// command log, the edit log and the catalog are byte-identical; the per-tick item census of
/// this fixture is recorded in the phase 87 evidence. The re-pin is CHECKED by the same
/// two-path rule: the new value is byte-equal to the re-blessed
/// `crates/fabrico-scenario/snapshots/01-exit-gate.snap`, whose summary line still reads
/// `nodes=8 belts=3 items=1 faulted=[]`.
///   OLD `50f82d60d69a4f777569e548300e90284632ba5556f636085afd236b080d8529`
///   NEW `be99b046d6727010a348e21fdf827e877bb70f07a1d6a07c2009e0c2faaa2bd2`
const EXIT_GATE_HASH: &str = "be99b046d6727010a348e21fdf827e877bb70f07a1d6a07c2009e0c2faaa2bd2";

/// Decode the committed fixture to a [`Scenario`]. Decode is REJECT-ONLY
/// (`Scenario::from_bytes` returns a typed `Result`, never panics on bytes — T-13-10);
/// a committed-fixture decode FAILURE is nonetheless a hard test failure (the fixture
/// is trusted/committed, so it MUST decode).
fn load_exit_gate() -> Scenario {
    Scenario::from_bytes(EXIT_GATE_FIXTURE)
        .expect("the committed exit-gate fixture decodes (trusted, but decoded reject-only)")
}

/// THE EXIT GATE: the full build→run→edit→undo sequence reconstructs from the
/// serialized two-log command log via `replay_two_logs`, HEADLESS, to the PINNED
/// terminal hash. Hash is primary (T-13-HASH).
#[test]
fn exit_gate_replays_from_command_log_to_stable_hash() {
    let scenario = load_exit_gate();

    // Reconstruct the COMPLETE build→run→edit→undo arc from the two ordered logs alone
    // — no renderer, no host (the headless deps fence enforces the absence crate-wide).
    let session = GridSession::replay_two_logs(scenario.seed, &scenario.edit_log, &scenario.event_log);

    // PRIMARY assertion: the one digest path equals the pinned terminal hash.
    assert_eq!(
        tick_hash(session.core()),
        EXIT_GATE_HASH,
        "the exit-gate command log must replay to the pinned terminal tick_hash (HASH PRIMARY)"
    );

    // SECONDARY readability: the reconstructed grid is the post-undo topology (the move
    // was undone, so the sink + its cascade belt are restored) — id-free counts only.
    let nodes = session.core().state.node_count();
    assert_eq!(
        nodes, 8,
        "post-undo topology: ROUTER + 2 sources + FACTORY + SINK + 3 belts (id-free count)"
    );
}

/// The RUN actually advanced: replaying the SAME edit-log WITHOUT the runtime event-log
/// (no pumped items) reaches a DIFFERENT terminal hash — so the pumped distinct-source
/// batch + settle genuinely drove the sim (the factory chain transported + processed
/// its item). Evidence via the one digest path, not raw ids.
#[test]
fn exit_gate_run_advanced() {
    let scenario = load_exit_gate();

    let with_run =
        GridSession::replay_two_logs(scenario.seed, &scenario.edit_log, &scenario.event_log);
    let build_only = GridSession::replay_two_logs(scenario.seed, &scenario.edit_log, &[]);

    assert_ne!(
        tick_hash(with_run.core()),
        tick_hash(build_only.core()),
        "the pumped run (events + settle) must change the terminal state vs build-only — \
         the run advanced (the factory/source chain processed the pumped items)"
    );
}

/// The three determinism properties hold for the exit-gate scenario: replay-from-genesis
/// is a byte-identical re-fold, snapshot→restore round-trips byte-identically, and the
/// distinct-source same-tick injection batch is arrival-order independent. These reuse
/// the core primitives + the one digest path (no forked fold/digest).
#[test]
fn exit_gate_determinism_holds() {
    let scenario = load_exit_gate();

    assert_replays(&scenario);
    assert_snapshot_restore(&scenario);
    assert!(
        assert_arrival_order_independent(&scenario),
        "the exit gate pumps a DISTINCT-source same-tick batch (source A + source B), so the \
         arrival-order proof must RUN (not skip) and hold"
    );
}

/// The UNDO step is present in the serialized log AND changed state: dropping the final
/// (undo) action group from the edit-log replays to a DIFFERENT hash AND a different
/// node count (the un-undone `move` left the sink relocated + its cascade belt removed;
/// the undo restored both). Asserts the undo DELTA via the one digest path + an id-free
/// count.
#[test]
fn exit_gate_undo_changed_state() {
    let scenario = load_exit_gate();

    // The undo group is the LAST logged action (highest `action` id) — drop it to get
    // the pre-undo (post-move) topology.
    let max_action = scenario
        .edit_log
        .iter()
        .map(|r| r.action)
        .max()
        .expect("the exit-gate edit-log is non-empty");
    let pre_undo_edits: Vec<_> = scenario
        .edit_log
        .iter()
        .filter(|r| r.action != max_action)
        .cloned()
        .collect();
    assert!(
        pre_undo_edits.len() < scenario.edit_log.len(),
        "dropping the undo action group must remove at least one record (the undo IS in the log)"
    );

    let post_undo =
        GridSession::replay_two_logs(scenario.seed, &scenario.edit_log, &scenario.event_log);
    let pre_undo =
        GridSession::replay_two_logs(scenario.seed, &pre_undo_edits, &scenario.event_log);

    assert_ne!(
        tick_hash(pre_undo.core()),
        tick_hash(post_undo.core()),
        "the undo must change the terminal state (pre-undo vs post-undo hashes differ)"
    );
    assert_eq!(
        pre_undo.core().state.node_count(),
        7,
        "pre-undo (post-move) topology: the moved sink dropped its cascade belt (id-free count)"
    );
    assert_eq!(
        post_undo.core().state.node_count(),
        8,
        "the undo RESTORED the sink + its cascade belt (id-free count delta: 7 -> 8)"
    );
}
