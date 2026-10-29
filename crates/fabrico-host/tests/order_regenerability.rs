//! THE ORDER-SCENE REGENERABILITY PROOF (Phase 55, EX-02): the shipped
//! order-processing scene is REGENERABLE from its command list — one list, two
//! independent appliers, one hash — exactly the LIVE-04 discipline the demo
//! earned in Phase 48 (`demo_regenerability.rs`, cloned here minus the two
//! demo-only steps of that time: NO genesis request-pair seed on EITHER applier, NO timer
//! install; since plan 85-08 the demo has no step outside its command list either).
//!
//! Applier A is the REAL live path: a `Host` over tempfile redb, genesis at
//! [`ORDER_GENESIS_SEED`], seeded by [`seed_scene`]`(order_commands())` through
//! the certified `apply_gesture` -> `enqueue_edit` -> `tick_once` path, one
//! command per tick. Applier B is the headless `GridSession`, folding the SAME
//! [`order_commands`] list one `apply` at a time from the same genesis seed.
//!
//! Equality is judged by ONE digest: `fabrico_scenario::tick_hash` =
//! blake3(snapshot(Core)) — the single sanctioned state-equality path (threat
//! T-13-HASH; never a field-walking comparison). The snapshot covers the ENTIRE
//! core including `tick` and the RNG state, so equality certifies the two
//! appliers consumed identical ticks AND identical RNG draws (each FACTORY
//! fold's `next_u64` sub-seed draw landed on the same tick on both sides) —
//! the one-command-per-tick discipline is load-bearing, not stylistic.
//!
//! The `code_hash` asymmetry is NOT a hash hazard: the host stamps the real
//! blake3 on its Configure records while `GridSession` freezes `[0u8; 32]`, but
//! the hash lives only on the EDIT RECORD (log), never in `GridState` — the
//! fold writes `Factory.source` / `Sink.template` verbatim and never reads the
//! hash, so the snapshot bytes match.

use fabrico_command::GridSession;
use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::RedbStore;
use fabrico_host::demo_scene::{ORDER_GENESIS_SEED, order_commands, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_scenario::tick_hash;

/// The order scene's absolute state digest (the anchor the demo's
/// `GOLDEN_TICK_HASH` precedent pins): the blake3 `tick_hash` the shipped
/// `order_processing.ron` produces at the seed boundary. A NEW pin — no prior
/// digest exists for this scene (48's discipline: first run with a placeholder,
/// read the live hash from the assert output, pin it, state the value in the
/// commit). Any transcription drift in `scenes/order_processing.ron` reddens
/// this test.
///
/// Note: `fabrico_scenario::tick_hash` returns the hex `String` digest (never a
/// forked bit-comparison; threat T-13-HASH), so the pin is a `&str`, not `[u8; 32]`.
///
/// Re-pinned by Phase 60 (`60-02`), the belt slot-density change (`SLOTS_PER_TILE`
/// three -> four, in lockstep with `SNAPSHOT_SCHEMA_VERSION` 8 -> 9 and
/// `PROJECT_FILE_VERSION` 6 -> 7). `scenes/order_processing.ron` is BYTE-IDENTICAL, so
/// this is not the transcription drift the note above warns about: the order scene
/// carries belts, and the hash moves on the belt slot-vector shape plus the version tag
/// inside the hashed bytes. The two-applier equality below still holds.
///   OLD `d65daf69b397b9b1c4826eed91b525e9334edef42744feba31f7d0149766a2d5`
///   NEW `5955321987229b43cb408c8eaf16790ae77dceb6f76ff0bbf181684b17c4ed28`
///
/// Re-pinned again by Phase 62 (plan 62-09, 2026-08-14), the belt ADVANCE-INTERVAL change
/// (SLOT-03/SLOT-04): `Belt.ticks_per_slot` became serialized per-belt state and the
/// shipped default moved from the pre-change identity of 1 to **2**, the value chosen
/// after a pace review, in lockstep with
/// `SNAPSHOT_SCHEMA_VERSION` 9 -> 10 and `PROJECT_FILE_VERSION` 7 -> 8 (plan 62-06).
/// `scenes/order_processing.ron` is BYTE-IDENTICAL, so this is again not the transcription
/// drift the note above warns about: the order scene carries belts, and the hash moves on
/// the new field, the version tag and the item slot positions the slower advance produces.
/// The two-applier equality below still holds.
///
/// **It moved TOGETHER with its sibling `GOLDEN_TICK_HASH` in `demo_regenerability.rs`,
/// exactly as `62-CORPUS-REVIEW.md`'s prediction P5 said the pair must**: they are the
/// same class of frozen tick hash over a shipped belt-bearing scene, so either both move
/// or neither does, and a change that moved one alone would be a defect rather than a
/// re-pin.
///   OLD `5955321987229b43cb408c8eaf16790ae77dceb6f76ff0bbf181684b17c4ed28`
///   NEW `40c167ec47eb99a735dcf69f77cac995bad7dc49554399597cd9945ccef88d20`
///
/// Re-pinned again by Phase 71 (plan 71-07) for plan 71-04's PILE-10 fault nub:
/// `port_catalog` appends a real `Role::Fault` port to the SINK and ROUTER entries, so
/// every such node in the order scene carries one more `GridState.ports` entry.
/// `scenes/order_processing.ron` is BYTE-IDENTICAL, so this is again a catalog change and
/// not the transcription drift the note above warns about, and the two-applier equality
/// below still holds.
///
/// **It moved TOGETHER with its sibling `GOLDEN_TICK_HASH` again**, which is the P5
/// prediction holding a second time: the order scene and the demo scene both place a Sink,
/// so either both move or neither does.
///   OLD `40c167ec47eb99a735dcf69f77cac995bad7dc49554399597cd9945ccef88d20`
///   NEW `4cd9a90de88e22e534c3e1f6744fb614d6ee2778859fd223beb21401a3579c1c`
///
/// Re-pinned again by Phase 72 (plan 72-12) for the D-20 schema bump, and this move has a
/// different CAUSE from all three above: no scene changed, no catalog changed and no node
/// gained a field here. `SNAPSHOT_SCHEMA_VERSION` went 10 to 11, `snapshot()` prefixes
/// that value as a little-endian tag ahead of the postcard body, and `tick_hash` is
/// `blake3` over exactly those bytes. So this hash moved on the TAG ALONE. A reader must
/// not go hunting a board change to explain it.
///
/// **It moved TOGETHER with its sibling `GOLDEN_TICK_HASH` a third time**, and on a
/// version-tag bump that is not a coincidence to be noted but a tautology to be checked:
/// a tag move reaches every state digest in the repository, so a run in which ONE of the
/// pair moved would mean something other than the bump had moved it.
///   OLD `4cd9a90de88e22e534c3e1f6744fb614d6ee2778859fd223beb21401a3579c1c`
///   NEW `820ef81ace335eb631f3f7e84df653de1e4c7c66ba4b1d384a1ca8fdf9a78197`
///
/// Re-pinned again by Phase 74 (plan 74-02) for the belt-is-a-ported-node break
/// (LINK-08 / D-04 / D-09): `SNAPSHOT_SCHEMA_VERSION` 11 -> 12 and `PROJECT_FILE_VERSION`
/// 10 -> 11. `scenes/order_processing.ron` is BYTE-IDENTICAL and no catalog entry moved,
/// so this is neither a transcription drift nor a catalog change.
///
/// TWO causes stack here, and separating them is the point of this entry. The version tag
/// moves every state digest in the repository, exactly as the 72-12 entry above records.
/// On top of that the order scene CARRIES BELTS, and a `Belt` now declares two stored
/// `Port` records where it declared none, so the hashed bytes grow per belt as well.
///
/// **It moved TOGETHER with its sibling `GOLDEN_TICK_HASH` a fourth time**, and this time
/// BOTH halves of the P5 prediction are load-bearing at once: a tag move alone would
/// already force the pair, and both scenes place belts, so a run in which one moved and
/// the other did not would be a defect, never a re-pin.
///   OLD `820ef81ace335eb631f3f7e84df653de1e4c7c66ba4b1d384a1ca8fdf9a78197`
///   NEW `bfa2617aaf4178499594cf695ea3938c048fe0625e47421881ac3fa002b4e60d`
///
/// **74.1-14 (CORNER-06, the "Edits keep middle layout" rule)**, a
/// LAYOUT EDIT, named. The splitter's AddPort now keeps every catalog port (In (0,1),
/// Out_0 (2,1), Fault (1,2)) and seats the new Out at (2,2), so belts 6, 7 and 8 were
/// redrawn one row lower onto In (5,6), Out_0 (7,6) and Out_1 (7,7). Every machine, Dock
/// port index and Configure stays; each flow carries the same jobs to the same machines.
/// It did NOT move together with its siblings for a shared cause: each scene was
/// re-authored on its own. THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `bfa2617aaf4178499594cf695ea3938c048fe0625e47421881ac3fa002b4e60d`
///   NEW `e7b5fb725363e66aff705a3c8197f1e92161116db69c95703d73c48f6ca085d5`
///
/// **85-03 (CHROME-04, D-08), the invoice sink Email to Debug**, a SCENE EDIT, named.
/// Node 4's Configure went from `Sink(target: Email(to: .., subject: ..))` to
/// `Sink(target: Debug)`, so the order example no longer offers a sink the shipped app
/// cannot send through. Every Place, AddPort, DrawBelt and Dock is unchanged and the
/// census stays 28 commands; only the stored sink template of node 4 moved. No sibling
/// pin moved with it: the demo and advanced scenes never configured an Email sink.
/// THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `e7b5fb725363e66aff705a3c8197f1e92161116db69c95703d73c48f6ca085d5`
///   NEW `ef4cb65efa04b9f3666d20579e359c99250fa3068eca2468910556bc0e752ac3`
///
/// **85-05 (CHROME-04, D-08), the SNAPSHOT 12 -> 13 bump**, plan 85-05 re-pins it.
/// This plan does not touch the scene: `SNAPSHOT_SCHEMA_VERSION` 12 -> 13 (the Email sink
/// target's deletion, CHROME-04 / D-08) moves the version tag inside the hashed bytes,
/// which moves every state digest. The demo, order and advanced pins move together for
/// that one shared cause. THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `ef4cb65efa04b9f3666d20579e359c99250fa3068eca2468910556bc0e752ac3`
///   NEW `00fce0c7f1845f60a38a6a47ea62b4621dd0baef97e2f8d3133fea0c13895a93`
///
/// **85-06 (DEMO-05, D-10), the history seal**, plan 85-06 re-pins it.
/// This plan does not touch the scene's commands: `seed_scene` now ends with one
/// `EditOp::SealHistory` record (the undo floor) folded in ONE more tick, so the seeded
/// core is one tick further on and `tick_hash` covers `core.tick`. The record changes no
/// grid state (the core's NOOP arm); the tick alone moves the digest. Applier B seals at
/// the same point (`GridSession::seal_history`), so THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `00fce0c7f1845f60a38a6a47ea62b4621dd0baef97e2f8d3133fea0c13895a93`
///   NEW `0622c3480a72b66e8d9263b1504caac6404b37ad2367dbaef1d7e15fbc0f6521`
///
/// **87-03 (JAM-01, D-02 to D-07), the SNAPSHOT 13 -> 14 bump**, plan 87-03 re-pins it.
/// This plan does not touch the scene: `SNAPSHOT_SCHEMA_VERSION` 13 -> 14 (phase 87's four
/// appended fields, `Balancer::next_in`, `Tee::faults`, `Factory::pending_emits` and
/// `Scheduler::blocked`) moves the version tag inside the hashed bytes and adds the new
/// fields' bytes (the Balancer's `next_in`, every Tee's and Factory's new field, and the
/// scheduler's empty `blocked` set), which moves every state digest. The demo, order and
/// advanced pins move together for that one shared cause. THE TWO-APPLIER EQUALITY STILL
/// HOLDS.
///   OLD `0622c3480a72b66e8d9263b1504caac6404b37ad2367dbaef1d7e15fbc0f6521`
///   NEW `141c41cb04f66085f7c120d12d578311109c716a10e1a17d1f6648449a6df28c`
const ORDER_GOLDEN_TICK_HASH: &str =
    "141c41cb04f66085f7c120d12d578311109c716a10e1a17d1f6648449a6df28c";

#[test]
fn order_scene_regenerates_to_an_identical_hash_from_two_appliers() {
    // ── Applier A: the REAL live Host, seeded through the certified path ─────
    // Nothing outside the command list and NO timers (the
    // order scene is webhook-driven; a timer's `{}` items would fault the
    // splitter — RESEARCH Pitfall 4).
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: ORDER_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    let minted = seed_scene(&mut host, &order_commands())
        .expect("seed_scene folds every order-scene command");
    assert_eq!(minted.len(), 11, "6 machines + 5 belts mint in ledger order");
    let live_hash = tick_hash(host.core());

    // ── Applier B: the headless GridSession, folding the SAME static list ────
    let mut session = GridSession::new(ORDER_GENESIS_SEED);
    for cmd in order_commands() {
        session
            .apply(cmd)
            .expect("the session accepts every order-scene command");
    }
    // Plan 85-06 (D-10): `seed_scene` ends with the history seal folded in one more tick,
    // so the headless applier seals at the same point and advances the same ticks.
    session.seal_history().expect("sealing the history is always accepted");
    let session_hash = tick_hash(session.core());

    // ── THE PROOF: one list, two appliers, ONE hash ──────────────────────────
    assert_eq!(
        live_hash, session_hash,
        "the shipped order scene must be regenerable from its command list - \
         the live Host (certified gesture path, one command per tick) and an \
         independent GridSession folding the same order_commands() from the \
         same genesis seed must produce an IDENTICAL blake3 tick_hash"
    );

    // ── The ABSOLUTE anchor: the pinned golden digest ────────────────────────
    assert_eq!(
        live_hash, ORDER_GOLDEN_TICK_HASH,
        "the RON-sourced order scene must reproduce the pinned state tick_hash \
         (behavioral identity as an absolute anchor - a one-cell typo in \
         scenes/order_processing.ron moves this hash and fails here)"
    );
}
