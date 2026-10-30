//! THE LIVE-04 PROOF: the shipped default scene is REGENERABLE from its command
//! list - one list, two independent appliers, one hash.
//!
//! Applier A is the REAL live path: a `Host` over tempfile redb, genesis at
//! [`DEMO_GENESIS_SEED`], seeded by [`seed_scene`] through the certified
//! `apply_gesture` -> `enqueue_edit` -> `tick_once` path, one command per tick.
//! Applier B is the headless `GridSession`, folding the SAME [`demo_commands`]
//! list one `apply` at a time from the same genesis seed. The static list's dense
//! `u64` handles resolve identically on both sides because handles are minted
//! monotonic from 0 in mint order by construction.
//!
//! Equality is judged by ONE digest: `fabrico_scenario::tick_hash` =
//! blake3(snapshot(Core)) - the single sanctioned state-equality path (threat
//! T-13-HASH; never a field-walking comparison). The snapshot covers the ENTIRE
//! core including `tick` and the RNG state, so equality certifies the two
//! appliers consumed identical ticks AND identical RNG draws (the FACTORY fold's
//! one `next_u64` sub-seed draw landed on the same tick on both sides) - the
//! one-command-per-tick discipline is load-bearing, not stylistic.
//!
//! The comparison happens at the SEED BOUNDARY: immediately after seeding, before
//! any timer install and before any live tick. A second assertion then pins the
//! Pitfall-3 tripwire: installing the projected timer set ([`timers_from_log`])
//! AFTER seeding is pure host configuration and never touches the core (the hash
//! must not move). The scene AUTHORS its timer as a logged edit, so that
//! projection is non-empty - an empty one is the `demo-timer-wiped-on-first-edit`
//! defect, and this file asserts against it directly. A third read boots the same scene
//! through [`boot_scene`], the one function every boot site uses, and asserts it lands on
//! the same hash: the boot adds the timer projection and nothing else.
//!
//! Since plan 85-08 the demo's request pair (a Route, an HTTP Handler and their two
//! cables) is part of the command list, so both appliers fold it like every other node.

use fabrico_command::GridSession;
use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::RedbStore;
use fabrico_engine::board::{boot_engine, parse_board};
use fabrico_engine::engine::Engine;
use fabrico_host::demo_scene::{
    DEMO_GENESIS_SEED, DEMO_INJECT_EVERY, SceneId, boot_scene, demo_commands, seed_scene,
    timers_from_log,
};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_scenario::tick_hash;

/// The demo scene's absolute state digest (Proof B): the blake3 `tick_hash` the
/// shipped demo produces at the seed boundary. It turns the relative two-applier
/// equality into an ABSOLUTE anchor: any edit to `examples/boards/demo_scene.board.ron` moves it, so
/// every layout change is a named re-pin below rather than a silent drift.
///
/// Note: `fabrico_scenario::tick_hash` returns the hex `String` digest (never a
/// forked bit-comparison; threat T-13-HASH), so the pin is a `&str`, not `[u8; 32]`.
///
/// # Re-pin log (Phase 48's old-and-new-digest discipline)
/// The digest covers the WHOLE core snapshot including every machine cell and belt
/// tile, so any layout edit moves it by construction. Every re-pin records both
/// values here and in its commit message, so a silent drift can never hide behind a
/// "just re-pinned it" commit.
///
/// - 55-04 (EX-03 breathing-room re-space: long-branch SINK (22,4) -> (22,5), belt 12
///   re-jogged to 12 cells). This is a PURE DATA edit to `scenes/demo_scene.ron`; the
///   two-applier equality below is what proves the re-space changed LAYOUT and
///   nothing else.
///   OLD `cb76f03ec64f7d132c11de9f7459cf061f1af9ee26d5a90e839602b0ba879469`
///   NEW `dd2c611a408c299e1cd05704c163c4e13fc7b5d2953bfa7f9db8af64e574da19`
///
/// - 60-02 (the belt slot-density change: `SLOTS_PER_TILE` three -> four, in lockstep
///   with `SNAPSHOT_SCHEMA_VERSION` 8 -> 9 and `PROJECT_FILE_VERSION` 6 -> 7). NOT a
///   layout edit: `scenes/demo_scene.ron` is byte-identical. The demo scene carries
///   belts, so the hash moves on the belt slot-vector shape and on the version tag
///   inside the hashed bytes. The two-applier equality below still holds, which is what
///   proves this is a core-model change and not a scene transcription drift.
///   OLD `dd2c611a408c299e1cd05704c163c4e13fc7b5d2953bfa7f9db8af64e574da19`
///   NEW `d436ae72514fdaeffaf5cfe372f9618619f953f6ac498fe92fd0cc8c5e55fde9`
///
/// - 62-09 (the belt ADVANCE-INTERVAL change, SLOT-03/SLOT-04). `Belt.ticks_per_slot`
///   became serialized per-belt state and the shipped default moved from the pre-change
///   identity of 1 to **2** - the value chosen after a pace review on 2026-08-14 - in lockstep with
///   `SNAPSHOT_SCHEMA_VERSION` 9 -> 10 and `PROJECT_FILE_VERSION` 7 -> 8 (plan 62-06).
///   NOT a layout edit: `scenes/demo_scene.ron` is byte-identical. The demo scene carries
///   belts, so the hash moves on the new serialized field, on the version tag inside the
///   hashed bytes, and on the item slot positions the slower advance produces. **The
///   two-applier equality below still holds**, which is what proves this is a core-model
///   change and not a scene transcription drift.
///   OLD `d436ae72514fdaeffaf5cfe372f9618619f953f6ac498fe92fd0cc8c5e55fde9`
///   NEW `a182113f8f204b0cb8fe678baad297c926be6f10405f7743e3a524bc02977458`
///
/// - `demo-timer-wiped-on-first-edit` (the v7.0 debug fix). The demo's item-source
///   TIMER became a real logged edit - a `Configure(node: 0, Source(Timer(8)))`
///   inserted at index 1 of `scenes/demo_scene.ron` - because
///   `SimLoop::tick_body` REPLACES the live `TimerSet` with `project_timers(log)`
///   on every gesture tick, so a timer that was not in the log was wiped by the
///   user's first edit and the shipped board silently died forever.
///   NOT a layout edit: no cell, port, belt, rotation or RNG draw moved. The list
///   is 37 -> 38 commands and `seed_scene` folds ONE per tick, so the seeded core
///   sits at tick 38 instead of 37 - and `tick_hash` covers `core.tick`. That tick
///   is the ONLY thing that moved: `fold_configure`'s
///   `MachineConfig::Source { .. } => {}` arm (fabrico-core/src/tick.rs) writes
///   zero GridState bytes, verified directly by seeding the 37-command list plus
///   one empty tick and asserting `snapshot(core)` is byte-identical to the
///   38-command seed. The index-1 position keeps every dense handle (0..=17) and
///   the FACTORY fold's `next_u64` sub-seed draw exactly where they were.
///   **The two-applier equality below still holds**, which is what proves this is
///   an authored-scene change and not a transcription drift.
///   OLD `a182113f8f204b0cb8fe678baad297c926be6f10405f7743e3a524bc02977458`
///   NEW `5e0b2fe6e5ddeac647c6392b17a6ef96f86ee92710934c7e13337c8eb9f5a64c`
///
/// - 63-07 (ROUTE-02, the Router output-port arity). `port_catalog(ROUTER)` went from
///   one `Role::Out` to `ROUTER_OUT_ARITY` (three), so the demo's ROUTER at handle 7
///   carries two more entries in `GridState.ports` and the snapshot the digest covers
///   grew. NOT a layout edit: `src/scenes/demo_scene.ron` is byte-identical, the command
///   list is still 38, no cell/belt/rotation/RNG draw moved, and every dock still names
///   the SAME catalog index (belt 11 -> port 0 the In, belt 14 -> port 1 the first Out)
///   because the widening APPENDS and shifts no index. **The two-applier equality below
///   still holds**, which is what proves this is a catalog change and not a scene
///   transcription drift.
///
///   This re-pin is the reason ROUTE-02's arity had to land in Phase 63 at all: the
///   catalog is an UNFROZEN function whose output is serialized into FROZEN artifacts,
///   and this hash is the third such artifact after the golden corpus and the scenario
///   fixtures. See `63-KEYSTONE-HANDOFF.md`, "The unfrozen-function, frozen-artifact
///   class".
///   OLD `5e0b2fe6e5ddeac647c6392b17a6ef96f86ee92710934c7e13337c8eb9f5a64c`
///   NEW `c9b3f521cff5ba7e3aa2628bffea942356d23a5c70d9112f3eb610d9676114a4`
///
/// - 71-04 (PILE-10, the fault nub), re-pinned by plan 71-07. `port_catalog` appends a
///   real `Role::Fault` port to the SINK and ROUTER entries, so the demo's Sink and its
///   Router each carry one more entry in `GridState.ports` and the snapshot the digest
///   covers grew again. It is the SAME class of change as the 63-07 note above and it is
///   NOT a scene edit: `src/scenes/demo_scene.ron` is byte-identical, the command list is
///   unchanged, and the widening APPENDS so every dock still names the same catalog index.
///   The two-applier equality below still holds, which is again what separates a catalog
///   change from a transcription drift.
///
///   MEASURED rather than assumed: the golden and scenario corpora moved in exactly the
///   same shape in the same commit, and the fixtures that moved there are exactly the ones
///   that place a SINK or a ROUTER. Plan 71-04's own SUMMARY proved the cause by reverting
///   `crates/fabrico-command/src/command.rs` alone and watching this target go green.
///   OLD `c9b3f521cff5ba7e3aa2628bffea942356d23a5c70d9112f3eb610d9676114a4`
///   NEW `67bb94dd9e318fbd25fdff26ead56b3ccbfe05f01281abdc184748a2c2bcb601`
///
/// - 72-06 (D-26, the DEMO BOARD UPGRADE). This one is DIFFERENT IN KIND from the three
///   above and the difference is the whole reason it is written out here. Those were
///   CATALOG widenings that reached the demo through machines it places. This is a
///   deliberate edit to the genesis seam that then minted the request pair outside the
///   edit log (removed by plan 85-08): the genesis handler gains a second
///   port (an electrical `Role::Out` at `local_offset (0,0)` side E) and the genesis
///   RETURN wire's `from` moves from `(factory, 0)` to `(factory, 1)`. So TWO things
///   moved in `GridState`, one port entry and one `WireLink.from` port index, and both
///   were chosen rather than inherited.
///
///   WHY THE BOARD WAS CHANGED AT ALL. Port 0 of that node is a declared `Role::In`, so
///   the shipped demo had a cable LEAVING AN INPUT, which is the exact lie D-05 refuses
///   to introduce, standing on the one board every user sees first. And under D-26 a
///   `Node::Factory` is NAMED a Handler only when it has an electrical In at port 0 AND
///   an electrical Out; without the Out this machine would keep doing the handler's job
///   under the other machine's name. The board was upgraded rather than relaxing
///   the rule, so the first board a user opens can do what phase 72 is named for.
///
///   `src/scenes/demo_scene.ron` is BYTE-IDENTICAL and the command list is unchanged:
///   the headline pair is a genesis seed, not a command. The two-applier equality below
///   still holds, which is again what separates a deliberate seam change from a scene
///   transcription drift. Re-pinned in the plan that moved it, exactly as 71-07 re-pinned
///   71-04's move; this hash is NOT part of plan 72-12's corpus and schema-constant bump.
///   OLD `67bb94dd9e318fbd25fdff26ead56b3ccbfe05f01281abdc184748a2c2bcb601`
///   NEW `7fcd9713f3f2b92c12b89559492e5c79de7957d214f3617b8e64fa9aba45ec05`
///
/// - 72-07 (SERVE-08, THE ROUTE'S OWN ADDRESS). A THIRD kind of move, and the smallest
///   of the three to state: nothing about the demo BOARD changed. `demo_scene.ron` is
///   byte-identical again, the genesis request-pair seam is untouched, and the command list is
///   the same list. What moved is the SHAPE OF A NODE: `state::Endpoint` grew a
///   serialized `path: String`, seeded by `add_endpoint` (to `/ep-<as_ffi>` then; to a
///   readable `/route-N` since phase 91, D-13). The demo board carries one Endpoint, so its `GridState` bytes grew by that
///   one length-prefixed string and the digest moved with them.
///
///   THE TWO-APPLIER EQUALITY STILL HOLDS, which is this file's own stated test for a
///   deliberate change against a scene transcription drift: both appliers moved to the
///   SAME new digest, because both mint their endpoint through the same seam.
///
///   Re-pinned HERE rather than deferred, on 72-06's precedent recorded directly above:
///   this hash is HOST-SIDE and is NOT part of plan 72-12's corpus and schema-constant
///   bump. The fixtures that ARE part of that bump (goldens 0023-0026, scenario 04 and
///   07) are deliberately NOT re-blessed by this plan and ride the phase red set instead.
///   OLD `7fcd9713f3f2b92c12b89559492e5c79de7957d214f3617b8e64fa9aba45ec05`
///   NEW `deb042e6032813bbc52d915c6448483c612f5256af9012f09469d6fdc4403772`
///
/// - 72-12 (D-20, THE SCHEMA BUMP ITSELF). The FOURTH kind of move, and the one that
///   moves this hash without touching one thing this file describes. Nothing about the
///   demo board changed, no node's shape changed, no applier changed: what changed is
///   that `SNAPSHOT_SCHEMA_VERSION` went 10 to 11, and `snapshot()` prefixes that value
///   as a little-endian tag before the postcard body (`snapshot.rs:233-236`). `tick_hash`
///   is `blake3` over exactly those bytes, so EVERY state digest in the repository moved
///   on the tag alone. That is the class of move to expect here on any future bump, and
///   it is why a reader must not go looking for a board change to explain it.
///
///   Re-pinned in the plan that TOOK the bump, which is the same discipline the three
///   entries above follow, arriving from the other direction: 72-06 and 72-07 re-pinned
///   here because the move was host-side and NOT the corpus bump; this one is re-pinned
///   here because it IS the corpus bump and R-74 requires every byte that rides the bump
///   to land in its ONE commit. This assertion sits OUTSIDE the declared-moves gate's
///   covered crates, so nothing but this line names it.
///
///   THE TWO-APPLIER EQUALITY STILL HOLDS, once more, and it is the reason a tag-only
///   move is distinguishable from a scene transcription drift at all.
///   OLD `deb042e6032813bbc52d915c6448483c612f5256af9012f09469d6fdc4403772`
///   NEW `bbcbf6415218f44f89873db505b366bd85b25891ba330a7ce3b2b670caadb2f5`
///
/// - 74-02 (the belt-is-a-ported-node break, LINK-08 / D-04 / D-09, in lockstep with
///   `SNAPSHOT_SCHEMA_VERSION` 11 -> 12 and `PROJECT_FILE_VERSION` 10 -> 11). NOT a
///   layout edit: `scenes/demo_scene.ron` is byte-identical.
///
///   THIS ONE MOVES TWICE OVER, and the two causes are worth separating because only one
///   of them is generic. First, the version tag, exactly as the 72-12 entry above
///   describes: every state digest in the repository moves on a snapshot bump whatever it
///   carries. Second, and specific to this bump, the demo scene CARRIES BELTS, and a
///   `Belt` now declares two stored `Port` records where it declared none - so the hashed
///   bytes grow per belt as well. A reader who checked only the tag would still be
///   surprised by the size of the diff; both causes are named so nobody goes looking for
///   a third.
///
///   Re-pinned in the plan that TOOK the bump, same discipline as the entry above.
///   THE TWO-APPLIER EQUALITY STILL HOLDS, which is again what separates a core-model
///   move from a scene transcription drift.
///   OLD `bbcbf6415218f44f89873db505b366bd85b25891ba330a7ce3b2b670caadb2f5`
///   NEW `e42d9831a2c4aa248f7840211a734ee2db965134ce5ac9930f327f18d14e31e1`
///
/// - 74.1-14 (CORNER-06, the "Edits keep middle layout" rule). A LAYOUT
///   EDIT, named: the Router catalog took the port-edit reseat rule's output, so the demo
///   Router's In and first Out moved to its middle row, (14,1) and (15,1). Belt 11 now
///   ends at (13,1) and enters that In straight; belt 14 starts at (16,1) and jogs one row
///   down into the Balancer. Every machine keeps its place, every Dock its port index.
///   `scenes/demo_scene.ron` and the hardcoded builder moved together (Proof A holds).
///   THE TWO-APPLIER EQUALITY STILL HOLDS, which is what separates this named change
///   from a transcription drift.
///   OLD `e42d9831a2c4aa248f7840211a734ee2db965134ce5ac9930f327f18d14e31e1`
///   NEW `17cb144eae33e79351d66468e0638c9cbb273b88b54c9a08b014472907c654cb`
///
/// - 85-05 (CHROME-04, D-08), the SNAPSHOT 12 -> 13 bump, plan 85-05 re-pins it.
///   This plan does not touch the scene: `SNAPSHOT_SCHEMA_VERSION` 12 -> 13 (the Email sink
///   target's deletion, CHROME-04 / D-08) moves the version tag inside the hashed bytes,
///   which moves every state digest. The demo, order and advanced pins move together for
///   that one shared cause. THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `17cb144eae33e79351d66468e0638c9cbb273b88b54c9a08b014472907c654cb`
///   NEW `3523f19fb513d6afd231781a82d772079e4d69e4a0de06b8c313b924a3ce90e1`
///
/// - 85-06 (DEMO-05, D-10), the history seal, plan 85-06 re-pins it.
///   This plan does not touch the scene's commands: `seed_scene` now ends with one
///   `EditOp::SealHistory` record (the undo floor) folded in ONE more tick, so the seeded
///   core is one tick further on and `tick_hash` covers `core.tick`. The record changes no
///   grid state (the core's NOOP arm); the tick alone moves the digest. Applier B seals at
///   the same point (`GridSession::seal_history`), so THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `3523f19fb513d6afd231781a82d772079e4d69e4a0de06b8c313b924a3ce90e1`
///   NEW `b955938f86c206682fa0c77c061b17415fec8a36293c8ad7299d4bff0e05d097`
///
/// - 85-08 (DEMO-01, D-02, D-03), the request pair from the log, plan 85-08 re-pins it.
///   The Route and the HTTP Handler are now six logged commands at the END of the list
///   (Place, Place, Configure the handler's code, Configure the Route's path `/hello`, and
///   one DrawWire that mints both cables) instead of four nodes the core seam minted after
///   the seed: five more seed ticks, the handler a 3x3 catalog HTTP Handler at (14,5) with
///   In, Out and Fault, the forward cable on the Route's Out, and the pair under the undo
///   floor. Both appliers fold the same list, so THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `b955938f86c206682fa0c77c061b17415fec8a36293c8ad7299d4bff0e05d097`
///   NEW `d9a2e747178b77bf4363eafa4f8d9f1fb70f8b6e59cec7be337c939c8473d5be`
///
/// - 85-08 (DEMO-06, D-06, D-14 to D-18), the new layout, plan 85-08 re-pins it again. A
///   LAYOUT AND CONTENT EDIT, named: the right half is rebuilt so every machine does a job
///   (the Router docks all three outputs with two size rules and a default; a Merge joins
///   the small and medium lanes into a Post sink; a Balancer takes the large lane on its
///   first input into two dock sinks; the Tee's copy runs three tiles to an Audit sink),
///   the Factory runs the order code, seven Sand labels name the sections, and the Route
///   and HTTP Handler re-anchor at (13,6) and (16,5) on the measured layout. 67 commands,
///   so the seed sits at a later tick, and every machine, belt, port and label is in the
///   hashed bytes. THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `d9a2e747178b77bf4363eafa4f8d9f1fb70f8b6e59cec7be337c939c8473d5be`
///   NEW `dcb2866b00baf40eb066cff261a57b9d7efd4151d9eef5fb3f9a7361cf6158a4`
///
/// - 87-03 (JAM-01, D-02 to D-07), the SNAPSHOT 13 -> 14 bump, plan 87-03 re-pins it.
///   This plan does not touch the scene: `SNAPSHOT_SCHEMA_VERSION` 13 -> 14 (phase 87's four
///   appended fields, `Balancer::next_in`, `Tee::faults`, `Factory::pending_emits` and
///   `Scheduler::blocked`) moves the version tag inside the hashed bytes and adds the new
///   fields' bytes (the Balancer's `next_in`, every Tee's and Factory's new field, and the
///   scheduler's empty `blocked` set), which moves every state digest. The demo, order and
///   advanced pins move together for that one shared cause. THE TWO-APPLIER EQUALITY STILL
///   HOLDS.
///   OLD `dcb2866b00baf40eb066cff261a57b9d7efd4151d9eef5fb3f9a7361cf6158a4`
///   NEW `ae70bc15f8d6d77e8d4cbfab7536c72404312c73e9bd73c10ccd0ae8a35a9cbe`
const GOLDEN_TICK_HASH: &str =
    "ae70bc15f8d6d77e8d4cbfab7536c72404312c73e9bd73c10ccd0ae8a35a9cbe";

/// A third applier with no host at all: the board file, parsed and booted on a bare [`Engine`],
/// lands on the pinned hash. So the host's boot and the headless boot build one board.
#[test]
fn the_demo_board_boots_on_an_engine_with_no_host_to_the_pinned_hash() {
    let board = parse_board(include_str!("../../../examples/boards/demo_scene.board.ron"))
        .expect("the demo board parses");
    let mut engine = Engine::from_core(Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: board.seed,
    }));
    let minted = boot_engine(&mut engine, &board).expect("the demo board boots with no host");
    assert_eq!(tick_hash(engine.core()), GOLDEN_TICK_HASH);
    assert_eq!(
        engine.timers().interval_for(minted[0]),
        Some(DEMO_INJECT_EVERY),
        "the boot installs the Source's timer from the log it wrote"
    );
    assert!(!engine.can_undo(), "the boot seals the history");
}

#[test]
fn demo_scene_regenerates_to_an_identical_hash_from_two_appliers() {
    // ── Applier A: the REAL live Host, seeded through the certified path ─────
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: DEMO_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    let minted = seed_scene(&mut host, &demo_commands()).expect("seed_scene folds every demo command");
    // Handle 0 is the SOURCE, the first Place in the list and the timer's target.
    let main_source = minted[0];
    let live_hash = tick_hash(host.core());

    // Proof B (absolute anchor): the RON-sourced scene reproduces the pinned
    // pre-extraction state hash. A transcription drift in demo_scene.board.ron that
    // slipped past the derived-Eq gate would move this hash and fail here.
    assert_eq!(
        live_hash, GOLDEN_TICK_HASH,
        "the RON-sourced demo scene must reproduce the pinned pre-extraction \
         state tick_hash (behavioral identity as an absolute anchor)"
    );

    // ── Applier B: the headless GridSession, folding the SAME static list ────
    let mut session = GridSession::new(DEMO_GENESIS_SEED);
    for cmd in demo_commands() {
        session
            .apply(cmd)
            .expect("the session accepts every demo command");
    }
    // Plan 85-06 (D-10): `seed_scene` ends with the history seal folded in one more tick,
    // so the headless applier seals at the same point and advances the same ticks.
    session.seal_history().expect("sealing the history is always accepted");
    let session_hash = tick_hash(session.core());

    // ── THE PROOF (LIVE-04): one list, two appliers, ONE hash ────────────────
    assert_eq!(
        live_hash, session_hash,
        "LIVE-04: the shipped default scene must be regenerable from its command \
         list - the live Host (certified gesture path, one command per tick) and \
         an independent GridSession folding the same demo_commands() from the \
         same genesis seed must produce an IDENTICAL blake3 tick_hash"
    );

    // ── Pitfall-3 tripwire: timers install AFTER seeding, never touch the core ─
    // The set is now PROJECTED from the seeded edit-log (`timers_from_log`) rather
    // than hand-built, which is the whole `demo-timer-wiped-on-first-edit` fix - so
    // this tripwire exercises the REAL boot path the shell and dev server use.
    let timers = timers_from_log(&host).expect("project the demo timers from the seeded log");
    assert_eq!(
        timers.interval_for(main_source),
        Some(DEMO_INJECT_EVERY),
        "the projection must reproduce the shipped cadence for the demo's SOURCE - \
         an empty projection here is exactly the defect that killed the board on \
         the user's first edit"
    );
    let host = host.with_timers(timers);
    assert_eq!(
        tick_hash(host.core()),
        live_hash,
        "installing the projected timers after seeding is pure host configuration - \
         the core (and therefore the regenerability hash) must not move"
    );

    // ── The one boot function lands on the same board ────────────────────────
    // `boot_scene` is what the shell, the dev server and every LoadScene swap call: the
    // seed above plus the timer projection. It must reach the same hash, so the three boot
    // sites build exactly the board this file pins.
    let dir_b = tempfile::tempdir().expect("tempdir");
    let core_b = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: DEMO_GENESIS_SEED,
    });
    let store_b = RedbStore::open(dir_b.path().join("log.redb")).expect("open log");
    let ledger_b = DispatchLedger::open(dir_b.path().join("ledger.redb")).expect("open ledger");
    let host_b = Host::new(core_b, store_b, ledger_b, None).expect("open host");
    let booted = boot_scene(host_b, SceneId::Demo).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        tick_hash(booted.core()),
        live_hash,
        "boot_scene builds the board the two appliers agree on"
    );
}
