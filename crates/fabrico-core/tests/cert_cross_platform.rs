//! Criterion 4 (REPLAY-03) — the frozen golden-corpus replay runner.
//!
//! For each scenario in `tests/golden/<id>/`, this runner restores the frozen
//! genesis `Core`, decodes the frozen event log, folds it tick-by-tick, and
//! asserts the recomputed per-tick `blake3` hash sequence is byte-identical to the
//! frozen `hashes.txt` manifest. Because fixed-point math + deterministic postcard
//! serialization make these hashes platform-independent BY DESIGN, the same frozen
//! bytes re-prove on every OS in the CI matrix (wired in plan 03-04); this is the
//! substantive LOCAL proof.
//!
//! No runtime filesystem: every fixture's three DATA files are embedded at compile
//! time via `include_bytes!` / `include_str!`. The runner therefore needs no
//! `clippy::disallowed_methods` allow and stays fully inside the determinism gate,
//! and is robust to cwd/OS. Growing the corpus = adding one `CORPUS` record below
//! (the deliberate, reviewed act — intentional, not a limitation).
//!
//! Both this runner and the regen writer (`tests/regen.rs`) fold via the single
//! shared `common::fold_log_collecting_hashes` helper, so the frozen manifest and
//! this replay cannot drift.

mod common;

use common::fold_two_logs_collecting_hashes;
use fabrico_core::edit::{EditOp, EditRecord, MachineConfig};
use fabrico_core::event::Event;
use fabrico_core::snapshot;

/// One frozen scenario, embedded at compile time. `genesis`/`log`/`edit_log` are the
/// decode inputs; `hashes` is the assertion target (the per-tick manifest). `name`
/// is for failure messages only.
struct Fixture {
    name: &'static str,
    /// Genesis `Core` snapshot blob (decoded via the hardened `snapshot::restore`).
    genesis: &'static [u8],
    /// Frozen ordered event log (`postcard` `Vec<Event>`).
    log: &'static [u8],
    /// Frozen ordered topology edit-log (`postcard` `Vec<EditRecord>`) — empty for
    /// the migrated 0001-0006 (no topology edits), populated for 0007/0008.
    edit_log: &'static [u8],
    /// Frozen per-tick lowercase-hex blake3 manifest, one hash per line.
    hashes: &'static str,
}

/// The corpus registry. Registering a NEW scenario = adding one record here (three
/// `include_bytes!`/`include_str!` lines) — the deliberate, reviewed act that grows
/// the forever-asserted corpus. Iterated in array order (deterministic).
// FIXTURE-ID RESERVATIONS, milestone v9.0 "The Thaw" (phases 70 through 78).
//
// WHY THIS TABLE IS HERE AND NOT IN A PLANNING DOCUMENT. The registration guard in
// `crates/fabrico-core/tests/corpus_registration.rs` catches a fixture DIRECTORY the
// runner never replays. It cannot catch a DUPLICATED INTENT: two phases each planning
// to author "0028" produce no red until one of them lands and the other collides. The
// v9.0 completeness review found exactly that, with two independent work clusters both
// claiming 0028 and 0029. The collision is prevented by VISIBILITY, not by a test, so
// the reservations live immediately above the registry that the next phase reaching for
// a number is already reading.
//
//   0028, 0029  Phase 70  (this phase: Router routing table, belt pace)
//   0030        Phase 71
//   0031, 0032, 0033  Phase 73  TAKEN by plan 73-02: 0031-undo-delete-of-a-wire,
//               0032-undo-delete-of-a-bare-belt and 0033-remove-out-port-repoints all
//               belong to Phase 73, and all three are registered below.
//   0034        Phase 74
//   0035        Phase 76  TAKEN by plan 76-05: 0035-label-inert-replay (Labels), registered
//               below.
//   0036        Phase 77, if it needs one. The footprint work in SEED-261004-vfw re-reads
//               its own id here when it is planned rather than assuming 0036. Phase 77
//               closed having taken none, so 0036 passed to milestone v11.0 (below).
//
// FIXTURE-ID RESERVATIONS, milestone v11.0 "The Cleanup".
//
//   0036 to 0040  v11.0 phase 87 ("No permanent jams")  TAKEN by plan 87-08, one golden per
//               core jam the phase fixed (D-10): 0036-balancer-both-inputs (JAM-01),
//               0037-tee-slow-branch (JAM-02), 0038-refused-fault-bounded (JAM-03),
//               0039-jammed-solid-goes-idle (JAM-04) and 0040-factory-two-emits (JAM-05),
//               all five registered below.
//
// A RECORDED DISCREPANCY, NOT A SILENTLY CHOSEN WINNER (plan 70-03 ruling R-15).
// Phase 70's decision D-09 reserved "0035-0036 -> Phase 76". The cumulative roadmap and
// requirements tables both reserve 0035 to Phase 76 and 0036 to Phase 77, and
// the cumulative chain is the named authority, so the split above is the one written
// down. The disagreement is recorded rather than resolved away: Phase 76 and Phase 77
// must MEET it here rather than each assuming 0036 is theirs.
//
// Taking a number means adding its `Fixture` record below in the same commit that
// freezes its directory. A reserved id with no record is a reservation; a directory
// with no record is a red.
const CORPUS: &[Fixture] = &[
    Fixture {
        name: "0001-source-belt-collector",
        genesis: include_bytes!("golden/0001-source-belt-collector/genesis.snapshot"),
        log: include_bytes!("golden/0001-source-belt-collector/log.postcard"),
        edit_log: include_bytes!("golden/0001-source-belt-collector/edit-log.postcard"),
        hashes: include_str!("golden/0001-source-belt-collector/hashes.txt"),
    },
    Fixture {
        name: "0002-merge-backlog",
        genesis: include_bytes!("golden/0002-merge-backlog/genesis.snapshot"),
        log: include_bytes!("golden/0002-merge-backlog/log.postcard"),
        edit_log: include_bytes!("golden/0002-merge-backlog/edit-log.postcard"),
        hashes: include_str!("golden/0002-merge-backlog/hashes.txt"),
    },
    Fixture {
        name: "0003-balancer-rotation",
        genesis: include_bytes!("golden/0003-balancer-rotation/genesis.snapshot"),
        log: include_bytes!("golden/0003-balancer-rotation/log.postcard"),
        edit_log: include_bytes!("golden/0003-balancer-rotation/edit-log.postcard"),
        hashes: include_str!("golden/0003-balancer-rotation/hashes.txt"),
    },
    Fixture {
        name: "0004-router-fault-mix",
        genesis: include_bytes!("golden/0004-router-fault-mix/genesis.snapshot"),
        log: include_bytes!("golden/0004-router-fault-mix/log.postcard"),
        edit_log: include_bytes!("golden/0004-router-fault-mix/edit-log.postcard"),
        hashes: include_str!("golden/0004-router-fault-mix/hashes.txt"),
    },
    // The first JS-boundary fixture: a stateful counter factory + a deterministic
    // fuse-trip tick. Re-proves on the 3-OS matrix IFF the curated Math, the
    // execution-driven gas fuse, the f64-free seeded random, and the canonical JSON
    // encoding are all platform-independent (the empirical cross-OS nondeterminism
    // guard for the JS boundary). Genesis is a COLD cache (plain data only); the
    // engine rebuilds lazily on replay.
    Fixture {
        name: "0005-factory-stateful",
        genesis: include_bytes!("golden/0005-factory-stateful/genesis.snapshot"),
        log: include_bytes!("golden/0005-factory-stateful/log.postcard"),
        edit_log: include_bytes!("golden/0005-factory-stateful/edit-log.postcard"),
        hashes: include_str!("golden/0005-factory-stateful/hashes.txt"),
    },
    // The Phase-5 EXECUTOR-seam fixture: a source -> sink(Http) whose STATIC log
    // bakes the host-logged command outcomes (a CommandResult{Success}, a
    // CommandResult{Failure}, and a Timeout). Replaying it with NO executor present
    // re-folds those logged outcomes verbatim through Plan-01's admit() arms — the
    // cross-platform half of REPLAY-04 — and reproduces the frozen per-tick hashes:
    // Success is audit-only, while Failure/Timeout each dead-letter a
    // CommandFailure/CommandTimeout fault on the emitting sink's FAULT_PORT inbox
    // (the EXEC-03 frozen proof). Platform-independent by construction (fixed-point
    // + deterministic postcard).
    Fixture {
        name: "0006-executor-loop",
        genesis: include_bytes!("golden/0006-executor-loop/genesis.snapshot"),
        log: include_bytes!("golden/0006-executor-loop/log.postcard"),
        edit_log: include_bytes!("golden/0006-executor-loop/edit-log.postcard"),
        hashes: include_str!("golden/0006-executor-loop/hashes.txt"),
    },
    // The Phase-8 INTERLEAVED edit-during-flow fixtures (08-03 / ELOG-03): the spike's
    // proof that the two-log merge is EDITS-FIRST. 0007 grafts a new branch onto a live
    // topology mid-flight (an edit at T is visible to flow at T); 0008 deletes a belt
    // carrying an in-flight item, which drops via the existing missing-link no-op (Q3).
    // NOTE: this `0007` is a fabrico-core CERT fixture — a DIFFERENT namespace from
    // fabrico-protocol's unrelated `0007-render-packet.bin` (RESEARCH Pitfall 1).
    Fixture {
        name: "0007-edit-add-during-flow",
        genesis: include_bytes!("golden/0007-edit-add-during-flow/genesis.snapshot"),
        log: include_bytes!("golden/0007-edit-add-during-flow/log.postcard"),
        edit_log: include_bytes!("golden/0007-edit-add-during-flow/edit-log.postcard"),
        hashes: include_str!("golden/0007-edit-add-during-flow/hashes.txt"),
    },
    Fixture {
        name: "0008-edit-delete-during-flow",
        genesis: include_bytes!("golden/0008-edit-delete-during-flow/genesis.snapshot"),
        log: include_bytes!("golden/0008-edit-delete-during-flow/log.postcard"),
        edit_log: include_bytes!("golden/0008-edit-delete-during-flow/edit-log.postcard"),
        hashes: include_str!("golden/0008-edit-delete-during-flow/hashes.txt"),
    },
    // The Phase-10 MULTI-CELL fixture (FOOT-01 / FOOT-03): two 2×3 exemplar machines
    // placed via frozen RESOLVED Place records (catalog-independent dims+ports) and a
    // VALID Out->In adjacent dock between them. Re-proves that multi-cell footprint
    // occupancy + a docked belt fold + replay byte-identically on every OS — the first
    // corpus fixture exercising a >1×1 machine.
    Fixture {
        name: "0009-multi-cell-footprint",
        genesis: include_bytes!("golden/0009-multi-cell-footprint/genesis.snapshot"),
        log: include_bytes!("golden/0009-multi-cell-footprint/log.postcard"),
        edit_log: include_bytes!("golden/0009-multi-cell-footprint/edit-log.postcard"),
        hashes: include_str!("golden/0009-multi-cell-footprint/hashes.txt"),
    },
    // The Phase-10 DELETE-WITH-CASCADE fixture (FOOT-04 / 10-05): deleting a 2×3
    // multi-cell machine mid-flow frees its WHOLE footprint AND cascade-detaches its
    // docked Wire-minted belts (one carrying an in-flight item), which DROPs via the
    // missing-link no-op (Q3), AR-3-safe. Re-proves the cascade folds + replays
    // byte-identically on every OS — the corpus anchor for FOOT-04.
    Fixture {
        name: "0010-delete-cascade-detach",
        genesis: include_bytes!("golden/0010-delete-cascade-detach/genesis.snapshot"),
        log: include_bytes!("golden/0010-delete-cascade-detach/log.postcard"),
        edit_log: include_bytes!("golden/0010-delete-cascade-detach/edit-log.postcard"),
        hashes: include_str!("golden/0010-delete-cascade-detach/hashes.txt"),
    },
    // The Phase-10 ROTATE-IN-PLACE fixture (FOOT-02 / 10-06; re-blessed under 17-05
    // selective de-dock): a 2×3 multi-cell machine with a docked empty-geometry belt is
    // rotated 90° FOUR times via the edit-log. The first rotate SELECTIVELY UNLINKS the
    // dock (the empty-geometry belt cannot face the port's new cell) — the belt SURVIVES
    // disconnected and last_tick.unlinked records it (NO destroy). The four +1
    // quarter-turns return the footprint occupancy to rot-0 (rotate90⁴ == footprint
    // identity; the dock is NOT restored — Landmine 4). Re-proves rotation + selective
    // de-dock fold + replay byte-identically on every OS — the corpus anchor for FOOT-02.
    Fixture {
        name: "0011-rotate-in-place",
        genesis: include_bytes!("golden/0011-rotate-in-place/genesis.snapshot"),
        log: include_bytes!("golden/0011-rotate-in-place/log.postcard"),
        edit_log: include_bytes!("golden/0011-rotate-in-place/edit-log.postcard"),
        hashes: include_str!("golden/0011-rotate-in-place/hashes.txt"),
    },
    // The Phase-11 LENGTH-AS-BUFFER / belt->belt BACKPRESSURE fixture (BELT-05/07): a
    // source feeds a length-2 per-tile beltA whose head feeds a length-1 beltB with a
    // DANGLING head (a permanently full tail). 12 items (> the 9-slot combined capacity)
    // bunch tile-by-tile backward into beltA's head + the source's queue — the blocked
    // downstream TAIL (NOT a stalled machine) Factorio backpressure the slot model exists
    // for. A standalone tick-0 DrawBelt grafts a 3-tile straight drawn belt (fold_draw_belt
    // + tile-cell claim, frozen in the snapshot). Re-proves the per-tile slot model +
    // length-as-buffer bunching replays byte-identically on every OS — the determinism
    // anchor that supersedes the retired "length-1 == v1.0 depth-1" anchor.
    Fixture {
        name: "0012-draw-belt-flow",
        genesis: include_bytes!("golden/0012-draw-belt-flow/genesis.snapshot"),
        log: include_bytes!("golden/0012-draw-belt-flow/log.postcard"),
        edit_log: include_bytes!("golden/0012-draw-belt-flow/edit-log.postcard"),
        hashes: include_str!("golden/0012-draw-belt-flow/hashes.txt"),
    },
    // The Phase-11 DELETE-BELT-WITH-IN-FLIGHT-ITEMS fixture (BELT-08 / 11-05): a DRAWN
    // per-tile belt (real geometry + claimed tile cells) carrying an in-flight slot item
    // is DELETED mid-flow via an edit-log Delete at tick 2. The belt + its item + its
    // claimed tile cells all go with it deterministically (the item drops, NOT a fault),
    // the AR-3 sched.remove forgets its wake, and no occupancy ghost / item resurrection /
    // panic survives. Re-proves the deterministic discard replays byte-identically on every
    // OS — the corpus anchor for BELT-08.
    Fixture {
        name: "0013-delete-belt-with-items",
        genesis: include_bytes!("golden/0013-delete-belt-with-items/genesis.snapshot"),
        log: include_bytes!("golden/0013-delete-belt-with-items/log.postcard"),
        edit_log: include_bytes!("golden/0013-delete-belt-with-items/edit-log.postcard"),
        hashes: include_str!("golden/0013-delete-belt-with-items/hashes.txt"),
    },
    // The Phase-12 UNDO-DELETE-WITH-DOCKED-BELT fixture (12-05 / RESEARCH Pitfall 2): a
    // port-bearing ROUTER with an OFFLOAD-docked DRAWN belt is DELETED (cascade-detaching
    // the belt + freeing its tile cells), then the delete is UNDONE — re-Placing the
    // machine and re-DrawBelt+re-Dock'ing the belt from the persisted captured subgraph
    // ALONE. Built through the REAL GridSession, so the edit-log carries a real-capture
    // Delete record + the real frozen undo group. Re-proves the delete-undo full-subgraph
    // restore (belt count + tile occupancy return to pre-delete) replays byte-identically
    // on every OS — the corpus anchor for UNDO-01's dominant complexity.
    Fixture {
        name: "0014-undo-delete-with-docked-belt",
        genesis: include_bytes!("golden/0014-undo-delete-with-docked-belt/genesis.snapshot"),
        log: include_bytes!("golden/0014-undo-delete-with-docked-belt/log.postcard"),
        edit_log: include_bytes!("golden/0014-undo-delete-with-docked-belt/edit-log.postcard"),
        hashes: include_str!("golden/0014-undo-delete-with-docked-belt/hashes.txt"),
    },
    // The Phase-12 UNDO-REDO-EACH-OP fixture (12-06, the phase-closing anchor): an
    // undo+redo round-trip of every undoable op type — Place, Rotate, DrawBelt and Dock
    // (node→node Wire retired in 17-02) — in ONE scenario, driven through the REAL
    // GridSession so the edit-log carries real lineage markers + frozen inverses + re-mint
    // groups. Each op is applied, undone (its frozen inverse folds), then redone (re-minted
    // under a fresh slotmap id — the accepted FLAG). Re-proves the WHOLE undo vocabulary
    // replays FORWARD to the same hash byte-identically on every OS (SC#3) — the corpus
    // anchor for UNDO-03.
    Fixture {
        name: "0015-undo-redo-each-op",
        genesis: include_bytes!("golden/0015-undo-redo-each-op/genesis.snapshot"),
        log: include_bytes!("golden/0015-undo-redo-each-op/log.postcard"),
        edit_log: include_bytes!("golden/0015-undo-redo-each-op/edit-log.postcard"),
        hashes: include_str!("golden/0015-undo-redo-each-op/hashes.txt"),
    },
    // The Phase-17 FACTORY 3×3 + FAULT-DOCK fixture (CAT-01/CAT-02/DET-05): a 3×3 FACTORY
    // with a belt OFFLOAD-docked to its S-center Role::Fault nub. The dock is keyed on
    // FAULT_PORT (== the fault-emit key, Option A reconciliation) so a faulted item would
    // ride the docked belt. Re-proves the reconciled fault dock snapshots + replays
    // byte-identically at schema 7 on every OS — the corpus anchor for the fault port.
    Fixture {
        name: "0016-factory-3x3-fault-dock",
        genesis: include_bytes!("golden/0016-factory-3x3-fault-dock/genesis.snapshot"),
        log: include_bytes!("golden/0016-factory-3x3-fault-dock/log.postcard"),
        edit_log: include_bytes!("golden/0016-factory-3x3-fault-dock/edit-log.postcard"),
        hashes: include_str!("golden/0016-factory-3x3-fault-dock/hashes.txt"),
    },
    // The Phase-17 ROTATE-RE-ROUTE SELECTIVE DE-DOCK fixture (CAT-06 / 17-05 Pitfall 1):
    // a belt docked at BOTH ends to one BALANCER is rotated once; the two directed docks
    // get INDEPENDENT verdicts — the Tail (to Out0) is KEPT (still faces the port's new
    // cell) while the Head (to In0) is UNLINKED. The belt SURVIVES disconnected and
    // last_tick.unlinked records exactly the dropped Head dock. Re-proves the both-ends
    // landmine (iterate raw docks, not deduped belts) replays byte-identically on every OS.
    Fixture {
        name: "0017-rotate-re-route-dedock",
        genesis: include_bytes!("golden/0017-rotate-re-route-dedock/genesis.snapshot"),
        log: include_bytes!("golden/0017-rotate-re-route-dedock/log.postcard"),
        edit_log: include_bytes!("golden/0017-rotate-re-route-dedock/edit-log.postcard"),
        hashes: include_str!("golden/0017-rotate-re-route-dedock/hashes.txt"),
    },
    // The Phase-17 WIRE-REMOVED DEFAULT MODEL fixture (CLEAN-01 / CAT-04): a
    // source -> belt -> sink graph built the ONLY way belts now exist — a drawn belt
    // whose Tail OFFLOAD-docks the source Out and whose Head LOAD-docks the sink In, with
    // NO Wire command anywhere. Re-proves the post-Wire default topology snapshots +
    // replays byte-identically at schema 7 on every OS — the corpus anchor for CLEAN-01.
    Fixture {
        name: "0018-wire-removed-drawbelt-dock",
        genesis: include_bytes!("golden/0018-wire-removed-drawbelt-dock/genesis.snapshot"),
        log: include_bytes!("golden/0018-wire-removed-drawbelt-dock/log.postcard"),
        edit_log: include_bytes!("golden/0018-wire-removed-drawbelt-dock/edit-log.postcard"),
        hashes: include_str!("golden/0018-wire-removed-drawbelt-dock/hashes.txt"),
    },
    // The Phase-36 ADD-REMOVE-PORT fixture (PORT-07, the port-edit corpus anchor): an
    // Item Router (Mechanical) PRESET (1-in/3-out, footprint 2×3 — the ROUTE-06 base) has
    // two `Out` ports ADDED via the real command layer (footprint grows 2×3 → 2×5 at 5
    // outputs — the `grow_to_fit` min-rect) then both `RemovePort`ed back (footprint FLOORS
    // to the frozen 2×3 base, never below — FOOT-05). Re-proves the add/remove-port
    // footprint-resize folds + replays byte-identically from genesis on every OS. ADDITIVE
    // Phase-36 port-edit fixture — registered LAST; 0001-0018 stay byte-frozen (no re-bless).
    Fixture {
        name: "0019-add-remove-port-router-preset",
        genesis: include_bytes!("golden/0019-add-remove-port-router-preset/genesis.snapshot"),
        log: include_bytes!("golden/0019-add-remove-port-router-preset/log.postcard"),
        edit_log: include_bytes!("golden/0019-add-remove-port-router-preset/edit-log.postcard"),
        hashes: include_str!("golden/0019-add-remove-port-router-preset/hashes.txt"),
    },
    // The Phase-36 FOOTPRINT-RESIZE fixture (PORT-07): an HTTP Router (Electrical) PRESET
    // is GROWN by four `Out` ports (footprint 2×3 → 2×7 — outputs stack down the E column)
    // then FLOORED back by four `RemovePort`s to the frozen 2×3 base. The resize is a PURE
    // function of the port list, so the genesis snapshot + re-folded edit-log reproduce
    // every intermediate footprint (2×3 → 2×7 → 2×3) byte-identically on every OS
    // (snapshot/restore round-trips the resized machine). ADDITIVE Phase-36 port-edit fixture.
    Fixture {
        name: "0020-footprint-resize-replay",
        genesis: include_bytes!("golden/0020-footprint-resize-replay/genesis.snapshot"),
        log: include_bytes!("golden/0020-footprint-resize-replay/log.postcard"),
        edit_log: include_bytes!("golden/0020-footprint-resize-replay/edit-log.postcard"),
        hashes: include_str!("golden/0020-footprint-resize-replay/hashes.txt"),
    },
    // The Phase-36 UNDO-PORT-EDIT SURVIVES SAVE/LOAD fixture (PORT-07 / UNDO-03 durability):
    // a port edit (`AddPort`) and its inverse (`RemovePort`) are each UNDONE on a reseat-
    // canonical Item Router preset. The genesis snapshot is the SAVE/LOAD boundary; re-folding
    // the whole edit-log FORWARD (AddPort+Undo, RemovePort+Undo) reproduces a byte-equal core
    // hash AND projection at every tick on every OS — undo survives save/load. ADDITIVE
    // Phase-36 port-edit fixture — registered LAST.
    Fixture {
        name: "0021-undo-port-edit-survives-save-load",
        genesis: include_bytes!("golden/0021-undo-port-edit-survives-save-load/genesis.snapshot"),
        log: include_bytes!("golden/0021-undo-port-edit-survives-save-load/log.postcard"),
        edit_log: include_bytes!("golden/0021-undo-port-edit-survives-save-load/edit-log.postcard"),
        hashes: include_str!("golden/0021-undo-port-edit-survives-save-load/hashes.txt"),
    },
    // The Phase-37 WIRE MULTI-HOP TRANSPORT fixture (WIRE-02/04): caller -> wire1 -> wire2
    // -> handler. A logged WireRequest admitted at tick 0 hops wire-to-wire (>= 1 tick/hop,
    // Plan-02 INGEST), spending one DEPTH-budget unit per wire it is DELIVERED into (entry
    // free, wire2 spends 1 => handler sees budget-1), and is delivered as an opaque
    // WireEnvelope through the ONE route_seq queue belt items use. Re-proves the multi-hop
    // transport replays byte-identically on every OS. ADDITIVE Phase-37 wire fixture —
    // registered LAST; 0001-0021 stay byte-frozen (no re-bless, no version bump).
    Fixture {
        name: "0022-wire-transport-basic",
        genesis: include_bytes!("golden/0022-wire-transport-basic/genesis.snapshot"),
        log: include_bytes!("golden/0022-wire-transport-basic/log.postcard"),
        edit_log: include_bytes!("golden/0022-wire-transport-basic/edit-log.postcard"),
        hashes: include_str!("golden/0022-wire-transport-basic/hashes.txt"),
    },
    // The Phase-37 WIRE REPLY ROUND-TRIP fixture (WIRE-01/04): caller -> forward_wire ->
    // factory-handler -> return_wire -> caller. A logged WireRequest reaches a factory whose
    // JS emits a ctx.command mapped (37-03 reply seam) to Effect::Reply, reverse-transported
    // back to the caller BY CORRELATION through the SAME route_seq queue, the reply INHERITING
    // the request's remaining budget (one budget bounds forward+return). The first corpus
    // reply across the JS boundary; re-proves the round-trip is a pure fold consequence that
    // replays byte-identically on every OS. ADDITIVE Phase-37 wire fixture.
    Fixture {
        name: "0023-wire-reply-round-trip",
        genesis: include_bytes!("golden/0023-wire-reply-round-trip/genesis.snapshot"),
        log: include_bytes!("golden/0023-wire-reply-round-trip/log.postcard"),
        edit_log: include_bytes!("golden/0023-wire-reply-round-trip/edit-log.postcard"),
        hashes: include_str!("golden/0023-wire-reply-round-trip/hashes.txt"),
    },
    // The Phase-37 SAME-TICK BELT+WIRE TIE-BREAK fixture (WIRE-02, the ONE-comparator anchor):
    // a wire REPLY and a belt item converge on the SAME machine (the caller) the SAME tick.
    // Both ride the SAME route_seq drain (belt/wire delivery indistinguishable to the ONE
    // comparator), so the canonical tie-break replays byte-identically on every OS. ADDITIVE
    // Phase-37 wire fixture.
    Fixture {
        name: "0024-same-tick-belt-wire-tiebreak",
        genesis: include_bytes!("golden/0024-same-tick-belt-wire-tiebreak/genesis.snapshot"),
        log: include_bytes!("golden/0024-same-tick-belt-wire-tiebreak/log.postcard"),
        edit_log: include_bytes!("golden/0024-same-tick-belt-wire-tiebreak/edit-log.postcard"),
        hashes: include_str!("golden/0024-same-tick-belt-wire-tiebreak/hashes.txt"),
    },
    // The Phase-37 WIRE BUDGET-OVERFLOW CYCLE fixture (WIRE-03 DEPTH bound, integration-proven):
    // caller -> wire_a <-> wire_b is a routing CYCLE. A logged WireRequest (budget 3) bounces
    // a<->b, budget-1 per delivered wire, until the budget hits 0 and it faults WireOverflow
    // (dead-lettered, decode-verified) at a DETERMINISTIC tick — and the cycle TERMINATES in
    // bounded ticks (both wires drain, never hangs/OOMs). Re-proves the DEPTH bound on a real
    // topology, byte-identically on every OS. ADDITIVE Phase-37 wire fixture.
    Fixture {
        name: "0025-wire-budget-overflow-cycle",
        genesis: include_bytes!("golden/0025-wire-budget-overflow-cycle/genesis.snapshot"),
        log: include_bytes!("golden/0025-wire-budget-overflow-cycle/log.postcard"),
        edit_log: include_bytes!("golden/0025-wire-budget-overflow-cycle/edit-log.postcard"),
        hashes: include_str!("golden/0025-wire-budget-overflow-cycle/hashes.txt"),
    },
    // The Phase-37 WIRE CAP-OVERFLOW FAN-IN fixture (WIRE-03 SPACE bound, integration-proven):
    // caller -> wire -> handler. A fan-IN of WIRE_INFLIGHT_CAP+1 (257) same-tick WireRequests
    // into the ONE entry wire fills the FIFO to EXACTLY the cap (256); the over-cap 257th
    // refuses admission and faults WireOverflow to the entry node — in_flight NEVER exceeds
    // the cap (cannot OOM). Re-proves the SPACE bound on a real topology, byte-identically on
    // every OS. ADDITIVE Phase-37 wire fixture — registered LAST.
    Fixture {
        name: "0026-wire-cap-overflow-fanin",
        genesis: include_bytes!("golden/0026-wire-cap-overflow-fanin/genesis.snapshot"),
        log: include_bytes!("golden/0026-wire-cap-overflow-fanin/log.postcard"),
        edit_log: include_bytes!("golden/0026-wire-cap-overflow-fanin/edit-log.postcard"),
        hashes: include_str!("golden/0026-wire-cap-overflow-fanin/hashes.txt"),
    },
    // source -> factory -> collector. An item fires through the factory under its
    // passthrough source (caching the compiled engine), then a logged Configure swaps the
    // source to a doubling handler AND evicts the NodeId-keyed runtime cache, then a second
    // item fires — emitting the DOUBLED value only because the stale engine was rebuilt from
    // the new source (CFG-02 / threat T-39-STALE-JS). The frozen per-tick hashes bake in the
    // NEW handler's output, so the source-swap + eviction replay byte-identically on every
    // OS. ADDITIVE Phase-39 config fixture — registered LAST; no version bump.
    Fixture {
        name: "0027-configure-factory-source-swap",
        genesis: include_bytes!("golden/0027-configure-factory-source-swap/genesis.snapshot"),
        log: include_bytes!("golden/0027-configure-factory-source-swap/log.postcard"),
        edit_log: include_bytes!("golden/0027-configure-factory-source-swap/edit-log.postcard"),
        hashes: include_str!("golden/0027-configure-factory-source-swap/hashes.txt"),
    },
    // source -> router(3 Out ports) -> one distinct collector per port. The SAME item
    // bytes fire before and after a logged Configure that installs a NEW routing table:
    // under the genesis table the matching RouteKey reaches Out port 2, and under the
    // configured table that same key reaches Out port 0, so the identical bytes land in a
    // DIFFERENT collector. The installed table is non-degenerate on purpose (two pairwise
    // distinct RouteKeys on two pairwise distinct Out ports, plus a Some(default) naming a
    // third port no route names), and its code_hash is the [0u8;32] N/A value the shipped
    // command path emits for a config carrying no Factory JS. The frozen per-tick hashes
    // bake the changed destination in, so a routing table set through the shipped
    // Configure record replays byte-identically on every OS. ADDITIVE Phase-70 fixture:
    // this is the corpus's FIRST MachineConfig::Router record (THAW-04 / ROUTE-03); no
    // version bump.
    Fixture {
        name: "0028-router-config-replay",
        genesis: include_bytes!("golden/0028-router-config-replay/genesis.snapshot"),
        log: include_bytes!("golden/0028-router-config-replay/log.postcard"),
        edit_log: include_bytes!("golden/0028-router-config-replay/edit-log.postcard"),
        hashes: include_str!("golden/0028-router-config-replay/hashes.txt"),
    },
    // source -> belt(1 tile) -> collector, the belt left at DEFAULT_TICKS_PER_SLOT in
    // genesis. The SAME item bytes traverse the belt before and after a logged Configure
    // that sets the belt's OWN advance interval to a NonZeroU32 differing from the
    // default, so the second traversal takes a DIFFERENT number of ticks. The generator
    // proves that against a CONTROL fold of the identical event log with an EMPTY edit
    // log, not against the first traversal, because the admission-alignment offset alone
    // makes two fires at different ticks differ even at an identical pace. The frozen
    // per-tick hashes bake both traversals in. ADDITIVE Phase-70 fixture: this is the
    // corpus's FIRST MachineConfig::Belt record (THAW-05 / BELT-02); no version bump.
    Fixture {
        name: "0029-belt-pace-replay",
        genesis: include_bytes!("golden/0029-belt-pace-replay/genesis.snapshot"),
        log: include_bytes!("golden/0029-belt-pace-replay/log.postcard"),
        edit_log: include_bytes!("golden/0029-belt-pace-replay/edit-log.postcard"),
        hashes: include_str!("golden/0029-belt-pace-replay/hashes.txt"),
    },
    // source -> belt(1 tile) -> collector, deliberately OVER-FED one ManualInject per
    // tick until the chain jams backwards from its far end, plus twenty logged Timeouts
    // aimed at the collector's UNLINKED FAULT_PORT. At the frozen final tick ALL FOUR
    // bounds Phase 71 introduced are holding at once: the collector's port-0 inbox at
    // MECHANICAL_INBOX_CAP (PILE-01/PILE-03), the belt's head RETAINED in slot 0 because
    // that inbox refused it, the belt's OWN staging inbox at the same MECHANICAL_INBOX_CAP
    // (one constant, two queues), the source's `pending` deque at SOURCE_PENDING_CAP
    // (PILE-04, the bound at the top of the chain), and the collector's FAULT_PORT bucket
    // at FAULT_QUEUE_CAP with the surplus timeouts DROPPED (PILE-09).
    //
    // WHAT REDDENS HERE, AND WHY IT IS THIS FILE RATHER THAN A UNIT TEST. A later phase
    // that weakens ANY ONE of those four bounds moves this fixture's per-tick hashes, so
    // the weakening surfaces in the forever-asserted corpus rather than only in a
    // crate-local test somebody can delete. The generator refuses to freeze an inert
    // board: it asserts every one of the four saturations, and proves the belt-head
    // REFUSAL from two probe points more than one advance interval apart, BEFORE it calls
    // `freeze`. ADDITIVE Phase-71 fixture (id reserved above); no version bump.
    Fixture {
        name: "0030-inbox-saturation-replay",
        genesis: include_bytes!("golden/0030-inbox-saturation-replay/genesis.snapshot"),
        log: include_bytes!("golden/0030-inbox-saturation-replay/log.postcard"),
        edit_log: include_bytes!("golden/0030-inbox-saturation-replay/edit-log.postcard"),
        hashes: include_str!("golden/0030-inbox-saturation-replay/hashes.txt"),
    },
    // THE THREE PHASE-73 PRE-FIX FIXTURES (UNDO-08, plan 73-02). All three were frozen on
    // a tree where NONE of the phase-73 undo fixes is applied, which is what makes them
    // able to go red at all: a golden fixture created AFTER a fix can never have moved,
    // and the pre-existing RemovePort corpus (0019, 0020, 0021) removes only the HIGHEST
    // index on preset Routers with an empty routing table and no docked belts, so the
    // whole of UNDO-04 and UNDO-05 could land with the corpus green and not one byte
    // moved.
    //
    // Their pre-fix `hashes.txt` digests were recorded during phase 73 and compared by a
    // gate that was DELIBERATELY red from the commit that froze them until plan 73-06
    // landed the fixes.
    //
    // draw-wire -> delete-wire -> undo. On the pre-fix tree the Undo is refused
    // (Err(Malformed)) and the wire does not come back; 0022 through 0026 carry wires and
    // never delete one, so UNDO-01 would otherwise ship uncertified. ADDITIVE; no bump.
    Fixture {
        name: "0031-undo-delete-of-a-wire",
        genesis: include_bytes!("golden/0031-undo-delete-of-a-wire/genesis.snapshot"),
        log: include_bytes!("golden/0031-undo-delete-of-a-wire/log.postcard"),
        edit_log: include_bytes!("golden/0031-undo-delete-of-a-wire/edit-log.postcard"),
        hashes: include_str!("golden/0031-undo-delete-of-a-wire/hashes.txt"),
    },
    // A three-tile BARE belt, no dock and no items, deleted and then undone. On the
    // pre-fix tree the Undo is refused and the belt does not come back.
    // `0013-delete-belt-with-items` deletes a belt and never undoes it, and 0014 undoes
    // the delete of a MACHINE whose cascade re-draws the belt from the machine's capture,
    // so nothing else in the corpus exercises UNDO-02. ADDITIVE; no bump.
    Fixture {
        name: "0032-undo-delete-of-a-bare-belt",
        genesis: include_bytes!("golden/0032-undo-delete-of-a-bare-belt/genesis.snapshot"),
        log: include_bytes!("golden/0032-undo-delete-of-a-bare-belt/log.postcard"),
        edit_log: include_bytes!("golden/0032-undo-delete-of-a-bare-belt/edit-log.postcard"),
        hashes: include_str!("golden/0032-undo-delete-of-a-bare-belt/hashes.txt"),
    },
    // The ONLY board in the corpus that can certify UNDO-04 and UNDO-05, because it is the
    // only one that gives either of them anything to do: a Router carrying a NON-EMPTY
    // routing table (installed through a certified Configure, since `fold_place`'s ROUTER
    // arm mints an empty one), a `default` naming a key ABOVE the one removed, a belt
    // docked to a HIGHER Out, and the EARLIEST Out removed rather than the highest. On the
    // pre-fix tree the Undo returns Ok and the restored Out lands LAST in the port array,
    // the table is never re-pointed, and the surviving dock silently names a different
    // physical port. ADDITIVE; no bump.
    Fixture {
        name: "0033-remove-out-port-repoints",
        genesis: include_bytes!("golden/0033-remove-out-port-repoints/genesis.snapshot"),
        log: include_bytes!("golden/0033-remove-out-port-repoints/log.postcard"),
        edit_log: include_bytes!("golden/0033-remove-out-port-repoints/edit-log.postcard"),
        hashes: include_str!("golden/0033-remove-out-port-repoints/hashes.txt"),
    },
    // THE PHASE-74 BELT-TO-BELT JUNCTION FIXTURE (LINK-01 / LINK-08, plan 74-08). Two
    // abutting drawn runs on one row, joined by the belt-to-belt `Dock` this phase shipped:
    // SOURCE -> belt A(3 tiles) -> belt B(2 tiles, THREE times slower) -> SINK, with A's
    // Head docked onto B's Tail through the certified command path. Before phase 74 that
    // exact command returned `Err(CommandError::InvalidDock)`, because a belt declared no
    // ports and the Dock arm's port resolve returned `None`; a belt now declares two and
    // the join is the first junction between two runs a user can build.
    //
    // The board is DRIVEN and then DISCONNECTED, so the frozen hashes carry the junction's
    // behaviour rather than only its presence: items cross it, bunch backwards over it into
    // the slower upstream, and after a logged `Unlink` of the same link the downstream
    // drains into the sink while the upstream stays packed against its now-dangling head.
    // Items are fired at belt A's OWN free-flow rate rather than over-fed, which is what
    // makes the bunching attributable to B's configured pace; the generator's sanity block
    // refuses to freeze a board where that is not true, and was proved able to fail against
    // four mutations recorded in plan 74-08's SUMMARY.
    //
    // WHAT IT DOES NOT CERTIFY, stated because a blessed fixture asserts whatever the code
    // produced on the day it was blessed: these hashes prove cross-platform REPLAY
    // determinism for this board, not that the junction's behaviour is right. A wrong
    // crossing would have been frozen just as faithfully. LINK-13's fan-in is absent and
    // that is measured rather than skipped: a belt end has exactly one outward direction, so
    // exactly one cell can host an upstream head and a second belt aimed at the same tail is
    // refused on adjacency. See the generator's docblock in `tests/regen.rs`.
    //
    // ADDITIVE Phase-74 fixture (id reserved above); no version bump - `SNAPSHOT_SCHEMA_VERSION`
    // already moved to 12 in plan 74-02 and this fixture is minted at it.
    Fixture {
        name: "0034-belt-to-belt-junction-replay",
        genesis: include_bytes!("golden/0034-belt-to-belt-junction-replay/genesis.snapshot"),
        log: include_bytes!("golden/0034-belt-to-belt-junction-replay/log.postcard"),
        edit_log: include_bytes!("golden/0034-belt-to-belt-junction-replay/edit-log.postcard"),
        hashes: include_str!("golden/0034-belt-to-belt-junction-replay/hashes.txt"),
    },
    // 0035 - A LABEL ON A FLOWING BOARD, CONFIGURED, DELETED AND UNDONE (SHAPE-11, D-08).
    // A Source, a belt and a Sink carry items while a label beside the belt is configured
    // (`Order intake`, Lilac, 6 by 2) through the shipped `Configure{Label}`, deleted, and
    // undone; the undo's re-`Place` and re-`Configure{Label}` are frozen like any record.
    // What it certifies is that the label's own bytes replay identically from genesis.
    // What it CANNOT see: this runner links no `fabrico-command`, so a `compute_inverse`
    // regression in the Delete inverse leaves 0035 green forever; that guard is
    // `crates/fabrico-command/tests/label.rs`. See the generator's docblock in
    // `tests/regen.rs`.
    //
    // ADDITIVE Phase-76 fixture (id reserved above); no version bump.
    Fixture {
        name: "0035-label-inert-replay",
        genesis: include_bytes!("golden/0035-label-inert-replay/genesis.snapshot"),
        log: include_bytes!("golden/0035-label-inert-replay/log.postcard"),
        edit_log: include_bytes!("golden/0035-label-inert-replay/edit-log.postcard"),
        hashes: include_str!("golden/0035-label-inert-replay/hashes.txt"),
    },
    // JAM-01, WINDOWS 175: a Balancer fed on both inputs drains both (87-RESEARCH P175 leg B).
    // Two Sources on In 0 and In 1, two Debug Sinks on the Outs; items from both Ins leave.
    //
    // ADDITIVE v11.0 phase 87 fixture (id reserved above), minted at SNAPSHOT 14. Like every
    // blessed fixture it proves the board replays identically, not that the behaviour is
    // right; that is graded by `tests/no_permanent_jams.rs`. See the generator's docblock in
    // `tests/regen.rs`.
    Fixture {
        name: "0036-balancer-both-inputs",
        genesis: include_bytes!("golden/0036-balancer-both-inputs/genesis.snapshot"),
        log: include_bytes!("golden/0036-balancer-both-inputs/log.postcard"),
        edit_log: include_bytes!("golden/0036-balancer-both-inputs/edit-log.postcard"),
        hashes: include_str!("golden/0036-balancer-both-inputs/hashes.txt"),
    },
    // JAM-02, WINDOWS 174: one slow Tee branch does not stop the healthy one (87-RESEARCH P174).
    // The healthy Sink keeps the feed's pace; the shed copies are counted on `Tee.faults`.
    //
    // ADDITIVE v11.0 phase 87 fixture (id reserved above), minted at SNAPSHOT 14. Like every
    // blessed fixture it proves the board replays identically, not that the behaviour is
    // right; that is graded by `tests/no_permanent_jams.rs`. See the generator's docblock in
    // `tests/regen.rs`.
    Fixture {
        name: "0037-tee-slow-branch",
        genesis: include_bytes!("golden/0037-tee-slow-branch/genesis.snapshot"),
        log: include_bytes!("golden/0037-tee-slow-branch/log.postcard"),
        edit_log: include_bytes!("golden/0037-tee-slow-branch/edit-log.postcard"),
        hashes: include_str!("golden/0037-tee-slow-branch/hashes.txt"),
    },
    // JAM-03, WINDOWS 176: a refused fault stays bounded (87-RESEARCH P176b). A Router that
    // faults every item, its fault port drained by a belt into a Sink; no fault nests and no
    // `OutputRefused` rests anywhere.
    //
    // ADDITIVE v11.0 phase 87 fixture (id reserved above), minted at SNAPSHOT 14. Like every
    // blessed fixture it proves the board replays identically, not that the behaviour is
    // right; that is graded by `tests/no_permanent_jams.rs`. See the generator's docblock in
    // `tests/regen.rs`.
    Fixture {
        name: "0038-refused-fault-bounded",
        genesis: include_bytes!("golden/0038-refused-fault-bounded/genesis.snapshot"),
        log: include_bytes!("golden/0038-refused-fault-bounded/log.postcard"),
        edit_log: include_bytes!("golden/0038-refused-fault-bounded/edit-log.postcard"),
        hashes: include_str!("golden/0038-refused-fault-bounded/hashes.txt"),
    },
    // JAM-04, WINDOWS 177: a board jammed solid goes idle, and one edit releases it
    // (87-RESEARCH P177B). Every machine and settled belt sleeps for 200 ticks, then a Dock of
    // a branch head into a Sink wakes the board and drains it.
    //
    // ADDITIVE v11.0 phase 87 fixture (id reserved above), minted at SNAPSHOT 14. Like every
    // blessed fixture it proves the board replays identically, not that the behaviour is
    // right; that is graded by `tests/no_permanent_jams.rs`. See the generator's docblock in
    // `tests/regen.rs`.
    Fixture {
        name: "0039-jammed-solid-goes-idle",
        genesis: include_bytes!("golden/0039-jammed-solid-goes-idle/genesis.snapshot"),
        log: include_bytes!("golden/0039-jammed-solid-goes-idle/log.postcard"),
        edit_log: include_bytes!("golden/0039-jammed-solid-goes-idle/edit-log.postcard"),
        hashes: include_str!("golden/0039-jammed-solid-goes-idle/hashes.txt"),
    },
    // JAM-05, WINDOWS 165: a Factory that emits twice on one port delivers both (87-RESEARCH
    // P165); the second emit waits in `Factory.pending_emits`.
    //
    // ADDITIVE v11.0 phase 87 fixture (id reserved above), minted at SNAPSHOT 14. Like every
    // blessed fixture it proves the board replays identically, not that the behaviour is
    // right; that is graded by `tests/no_permanent_jams.rs`. See the generator's docblock in
    // `tests/regen.rs`.
    Fixture {
        name: "0040-factory-two-emits",
        genesis: include_bytes!("golden/0040-factory-two-emits/genesis.snapshot"),
        log: include_bytes!("golden/0040-factory-two-emits/log.postcard"),
        edit_log: include_bytes!("golden/0040-factory-two-emits/edit-log.postcard"),
        hashes: include_str!("golden/0040-factory-two-emits/hashes.txt"),
    },
];

#[test]
fn golden_corpus_replays_to_frozen_hashes() {
    // DEMOTED, NOT DELETED (plan 70-03 ruling R-13). This floor is no longer the
    // corpus's REGISTRATION guard: it cannot see a fixture directory on disk that no
    // record names, so a planted directory used to ride in green. The registration
    // guard is now `crates/fabrico-core/tests/corpus_registration.rs`, which walks the
    // golden directory at RUN time and asserts set equality with the `CORPUS` names in
    // both directions.
    //
    // The floor stays byte-identical and keeps doing the one thing it can do: a
    // zero-length `CORPUS` is still a red. Deleting a working check to make room for a
    // stronger one leaves the weaker case uncovered for no gain.
    assert!(
        !CORPUS.is_empty(),
        "golden corpus must hold at least one frozen fixture"
    );

    for fixture in CORPUS {
        // Decode the genesis Core through the HARDENED, non-panicking path
        // (V5 / threat T-3-DEC) — never raw-decode the Core.
        let mut core = snapshot::restore(fixture.genesis).unwrap_or_else(|_| {
            panic!(
                "golden corpus '{}': genesis.snapshot must restore (hardened decode)",
                fixture.name
            )
        });

        // Decode the frozen log via the Result-returning postcard path.
        let log: Vec<Event> = postcard::from_bytes(fixture.log).unwrap_or_else(|_| {
            panic!(
                "golden corpus '{}': log.postcard must decode to Vec<Event>",
                fixture.name
            )
        });

        // Decode the frozen edit-log via the same Result path (empty for 0001-0006).
        let edit_log: Vec<EditRecord> = postcard::from_bytes(fixture.edit_log).unwrap_or_else(|_| {
            panic!(
                "golden corpus '{}': edit-log.postcard must decode to Vec<EditRecord>",
                fixture.name
            )
        });

        // The number of ticks to drive is EXACTLY the number of frozen hash lines.
        let expected: Vec<&str> = fixture
            .hashes
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        assert!(
            !expected.is_empty(),
            "golden corpus '{}': hashes.txt must hold at least one frozen hash",
            fixture.name
        );

        // Fold BOTH logs via the SAME two-log helper the regen writer used
        // (single-sourced loop; EDITS-FIRST inside each tick).
        let got = fold_two_logs_collecting_hashes(&mut core, &edit_log, &log, expected.len() as u64);

        assert_eq!(
            got, expected,
            "golden corpus '{}' replays from its frozen genesis to its frozen per-tick hashes \
             (criterion 4 / REPLAY-03)",
            fixture.name
        );
    }
}

/// THAW-04 / THAW-05: the corpus must certify a Router routing table AND a belt pace
/// that were set through the SHIPPED `EditOp::Configure` record; since 76-05 (SHAPE-11),
/// a label's words, colour and box too.
///
/// # Why this iterates the CORPUS TABLE and never a directory listing
/// A directory listing would find a fixture directory planted on disk that no `CORPUS`
/// record names, and count it as coverage even though the runner above never replays
/// it. The registry is the only thing that is actually asserted forever, so the registry
/// is what this walks. `CORPUS` is a `&[Fixture]` iterated in array order, which is
/// deterministic (stated in the registry docblock above), so the Router, Belt and Label
/// arms below see the same records in the same order and cannot disagree about what they
/// saw.
///
/// # Why the failures are DEFERRED into one message
/// Rust panics on the first `assert!`, so two sequential assertions would report ONE
/// missing variant and hide the other, and a reader would fix one, re-run, and discover
/// the next. Every gate under `scripts/` defers its exit for this reason and this test
/// does the same: every unmet clause is collected and reported together, numbered.
///
/// # Why the walked count is itself a clause
/// An empty `CORPUS` makes both arms vacuously UNSATISFIABLE rather than vacuously
/// satisfiable, so the counts alone would still redden. Naming the walked count in every
/// message is what makes a red from an empty table read differently from a red from a
/// covered-but-absent variant, which are different defects with different fixes.
#[test]
fn corpus_carries_a_configure_of_each_shipped_machine_config_variant() {
    let mut walked = 0usize;
    let mut router_fixtures: Vec<&str> = Vec::new();
    let mut belt_fixtures: Vec<&str> = Vec::new();
    let mut label_fixtures: Vec<&str> = Vec::new();

    for fixture in CORPUS {
        walked += 1;

        // The SAME Result-returning postcard path the replay runner above uses, so a
        // fixture this test can read is a fixture that test can read.
        let edit_log: Vec<EditRecord> = postcard::from_bytes(fixture.edit_log).unwrap_or_else(|_| {
            panic!(
                "golden corpus '{}': edit-log.postcard must decode to Vec<EditRecord>",
                fixture.name
            )
        });

        for record in &edit_log {
            if let EditOp::Configure { config, .. } = &record.op {
                match config {
                    MachineConfig::Router { .. } => router_fixtures.push(fixture.name),
                    MachineConfig::Belt { .. } => belt_fixtures.push(fixture.name),
                    // 76-05 (SHAPE-11, research Pitfall 3): a label's words, colour and
                    // box ride a Configure{Label}; without this arm the `_` arm below
                    // swallowed a corpus that carried none.
                    MachineConfig::Label { .. } => label_fixtures.push(fixture.name),
                    // Factory / Source / Sink / Endpoint configs are covered elsewhere
                    // (0027 is the Factory anchor); this test is about the variants that
                    // shipped with no fixture at all: the two of v8.0 and the label.
                    _ => {}
                }
            }
        }
    }

    let mut unmet: Vec<String> = Vec::new();

    if walked == 0 {
        unmet.push(
            "CORPUS arm: 0 records walked. An empty registry certifies nothing, and \
             every coverage arm below is unsatisfiable rather than satisfied."
                .to_owned(),
        );
    }

    if router_fixtures.is_empty() {
        unmet.push(format!(
            "Router arm: {} CORPUS record(s) carry an EditOp::Configure whose config is \
             MachineConfig::Router {{ .. }}, out of {walked} record(s) walked. The \
             routing-rule editor shipped in v8.0 and no frozen fixture exercises it, so \
             replaying a board whose routing table was set through the shipped Configure \
             record is certified by nothing (THAW-04).",
            router_fixtures.len()
        ));
    }

    if label_fixtures.is_empty() {
        unmet.push(format!(
            "Label arm: {} CORPUS record(s) carry an EditOp::Configure whose config is \
             MachineConfig::Label {{ .. }}, out of {walked} record(s) walked: no fixture \
             carries a Configure{{Label}}. Phase 76 appended a label's text and colour to \
             the snapshot, and replaying a board whose label was configured through the \
             shipped Configure record is certified by nothing (SHAPE-11; the fixture is \
             0035-label-inert-replay).",
            label_fixtures.len()
        ));
    }

    if belt_fixtures.is_empty() {
        unmet.push(format!(
            "Belt arm: {} CORPUS record(s) carry an EditOp::Configure whose config is \
             MachineConfig::Belt {{ .. }}, out of {walked} record(s) walked. The per-belt \
             pace panel shipped in v8.0 and no frozen fixture exercises it, so replaying \
             a board whose belt pace was set through the shipped Configure record is \
             certified by nothing (THAW-05).",
            belt_fixtures.len()
        ));
    }

    assert!(
        unmet.is_empty(),
        "the golden corpus does not certify every shipped MachineConfig variant \
         ({} unmet clause(s) of 4 checked, {walked} CORPUS record(s) walked):\n{}",
        unmet.len(),
        unmet
            .iter()
            .enumerate()
            .map(|(i, m)| format!("  {}. {m}", i + 1))
            .collect::<Vec<_>>()
            .join("\n")
    );
}
