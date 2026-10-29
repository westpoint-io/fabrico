//! Shared harness for the Phase-1 determinism proof suite (SC#1–SC#4).
//!
//! These helpers are deliberately dependency-light and deterministic: they build
//! topologies through the public grid API, script `ManualInject` events, and
//! drive `Core` either purely or while drawing from the seeded rng. The
//! `snapshot` bytes are the state-equality oracle every proof compares against.
//!
//! Note on the "rng-drawing machine": Phase-1's `Node` enum is closed
//! (`Source` / `Belt`), and neither built-in draws from `ctx.rng()`, so an
//! integration test cannot inject a custom rng-consuming `Machine` into the
//! fold. [`advance_drawing_rng`] is the faithful equivalent reachable through the
//! public API — it advances the (public) `core.rng` once per tick so the rng's
//! counter STATE is non-trivial at every snapshot boundary. The SC#2 proptest
//! therefore still fails if the snapshot ever omits the rng state (Pitfall 7).

#![allow(dead_code)] // not every helper is used by every test binary

use fabrico_core::command::{Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::EditRecord;
use fabrico_core::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::factory::DEFAULT_GAS_BUDGET;
use fabrico_core::fault::{Fault, FaultReason, FAULT_PORT};
use fabrico_core::ids::{CommandId, Item, NodeId, PortId};
use fabrico_core::snapshot;
use fabrico_core::state::{Node, PortOutbox, RouteKey, SinkTemplate};

/// A genesis log header carrying `seed` (CORE-05).
pub fn header(seed: u64) -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed,
    }
}

/// The state-equality oracle: the whole `Core` serialized at a tick boundary.
pub fn state_bytes(core: &Core) -> Vec<u8> {
    snapshot::snapshot(core)
}

/// `tick_hash` — the single shared per-tick digest every certification criterion
/// compares against (Open Question 2: unify all five criteria on one hash).
///
/// Promoted (Phase 13) into the headless `fabrico-scenario::oracle` crate as THE
/// one public state-equality digest = `blake3(snapshot(core))`. This module now
/// RE-EXPORTS it so there is exactly ONE semantic digest path everywhere; the cert
/// suite stays byte-identical because it is the same function. There is deliberately
/// a SINGLE digest path (hash the snapshot bytes); never add a second/field-walking
/// digest — two paths are two ways to diverge (threat T-3-HASH / T-13-HASH).
pub use fabrico_scenario::oracle::tick_hash;

/// Closure-driven fold-and-hash driver (criteria 1 and 2).
///
/// While `core.tick < target`: call `step(core)` — which must perform exactly one
/// `advance()` internally (e.g. the existing `step_scenario` /
/// `step_balancer_scenario` / `step_merge_scenario`) — then capture [`tick_hash`].
/// Returns the per-tick hash sequence, single-sourcing the fold-and-hash loop so
/// criteria 1 and 2 cannot drift apart.
pub fn drive_collecting_hashes(
    core: &mut Core,
    target: u64,
    mut step: impl FnMut(&mut Core),
) -> Vec<String> {
    let mut hashes = Vec::new();
    while core.tick < target {
        step(core);
        hashes.push(tick_hash(core));
    }
    hashes
}

/// Static-log fold-and-hash driver (criterion 1's router static-log case and,
/// later, criterion 4's frozen-corpus runner + its regen writer).
///
/// Folds a STATIC, pre-built event `log` tick-by-tick from the core's current
/// tick, `ticks` times. Each iteration gathers the contiguous slice of `log`
/// whose `event.tick == core.tick` (empty on idle ticks), calls `core.advance`
/// exactly once on that slice, then captures [`tick_hash`]. Returns the per-tick
/// hash sequence.
///
/// `log` MUST be ordered so same-tick events are contiguous and ticks are
/// non-decreasing (the same contract as [`Core::run_log`]). The corpus runner and
/// the manifest generator both single-source this driver, so a frozen golden
/// hash sequence and its replay cannot drift.
pub fn fold_log_collecting_hashes(core: &mut Core, log: &[Event], ticks: u64) -> Vec<String> {
    let mut hashes = Vec::new();
    let mut idx = 0usize;
    for _ in 0..ticks {
        let t = core.tick;
        let start = idx;
        while idx < log.len() && log[idx].tick == t {
            idx += 1;
        }
        core.advance(&log[start..idx]);
        hashes.push(tick_hash(core));
    }
    hashes
}

/// Two-log static fold-and-hash driver (Phase 8 / 08-03): the EDITS-FIRST analog
/// of [`fold_log_collecting_hashes`] threading BOTH ordered logs.
///
/// Folds a STATIC edit-log AND a STATIC event-log tick-by-tick from the core's
/// current tick, `ticks` times. Each iteration gathers the contiguous slice of each
/// log whose record `tick == core.tick` (empty on idle ticks), calls
/// `core.advance_edits(edits_slice, events_slice)` exactly once (edits applied
/// EDITS-FIRST inside the tick), then captures [`tick_hash`]. Returns the per-tick
/// hash sequence.
///
/// Both logs MUST be ordered so same-tick records are contiguous and ticks are
/// non-decreasing (the same contract as [`Core::run_log`]). The two-log corpus
/// runner and the regen writer both single-source this driver, so a frozen golden
/// hash sequence and its replay cannot drift.
pub fn fold_two_logs_collecting_hashes(
    core: &mut Core,
    edits: &[EditRecord],
    events: &[Event],
    ticks: u64,
) -> Vec<String> {
    let mut hashes = Vec::new();
    let mut eidx = 0usize;
    let mut didx = 0usize;
    for _ in 0..ticks {
        let t = core.tick;
        let dstart = didx;
        while didx < edits.len() && edits[didx].tick == t {
            didx += 1;
        }
        let estart = eidx;
        while eidx < events.len() && events[eidx].tick == t {
            eidx += 1;
        }
        core.advance_edits(&edits[dstart..didx], &events[estart..eidx]);
        hashes.push(tick_hash(core));
    }
    hashes
}

/// Just the grid-state projection bytes (excludes `tick`/`rng`/`sched`) — used
/// to assert an idle tick leaves the *grid* unchanged even as logical time ticks.
pub fn grid_state_bytes(core: &Core) -> Vec<u8> {
    postcard::to_allocvec(&core.state).expect("serialize grid state")
}

/// A single `ManualInject` Fire targeting `target`'s port 0 at `tick`.
pub fn fire(target: NodeId, seq: u64, tick: u64, item: Item) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::ManualInject {
            target,
            port: 0,
            item,
        },
    }
}

/// A single logged [`EventPayload::WireRequest`] whose reply address (and therefore
/// ENTRY node — the caller is both origin and reply target, `manual_inject.rs:149`)
/// is `return_addr`, carrying `correlation`/`budget`/`payload` at `seq`/`tick`.
///
/// The `fire()` sibling for the WIRE path (RESEARCH §7 step 1): the admit arm locates
/// the entry wire via `wire_from_node(return_addr.0)` and enqueues the message into
/// its in-flight FIFO + wakes it, so the request hops `>= 1` tick before delivery.
/// `deadline_tick` is the Phase-38 reply deadline, UNUSED this phase, so it is pinned
/// to `u64::MAX` (never a factor) and kept identical across a permuted batch.
pub fn wire_fire(
    return_addr: (NodeId, PortId),
    seq: u64,
    tick: u64,
    correlation: u64,
    budget: u64,
    payload: Item,
) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::WireRequest {
            correlation,
            deadline_tick: u64::MAX,
            budget,
            return_addr,
            payload,
        },
    }
}

/// The ids a mixed belt+wire convergence grid hands back to the cert tests: several
/// DISTINCT belt-feeding sources and several DISTINCT wire-entry nodes (each with its
/// own wire) that ALL converge on ONE `collector` machine, so belt items and wire
/// deliveries can land at the same machine the same tick — ordered by the ONE
/// `route_seq` comparator (WIRE-02). See [`belt_wire_merge_collector`].
pub struct BeltWireTopology {
    /// One belt-feeding `Source` per belt lane: `source -> belt(1) -> collector`.
    /// A `fire()` into each delivers a belt item to the collector at tick `now = 3`.
    pub belt_sources: Vec<NodeId>,
    /// One wire-ENTRY `Source` per wire lane. A [`wire_fire`] whose `return_addr` is
    /// `(entry, 0)` admits into that entry's wire; the wire forwards the message into
    /// the collector one tick later (`>= 1` tick/hop). Exactly ONE request per entry
    /// preserves the distinct-source discipline (`cert_arrival_order.rs:11-25`).
    pub wire_entries: Vec<NodeId>,
    /// The `Node::Wire` for each wire lane (`from = (entry, 0)`, `to = (collector, 0)`),
    /// index-aligned with [`wire_entries`](Self::wire_entries).
    pub wires: Vec<NodeId>,
    /// The single collector `Source` both belt items and wire messages converge on;
    /// it ignores its input port, so delivered items rest in its inbox for inspection.
    pub collector: NodeId,
}

/// Build a mixed convergence grid where `belt_inputs` belt lanes and `wire_inputs`
/// wire lanes all feed ONE collector `Source`, from genesis seeded with `seed`
/// (RESEARCH §7 step 2 — the `multi_source_merge_collector` sibling for the belt+wire
/// comparator/arrival-order proofs).
///
/// Topology (each lane rooted at its OWN distinct source / wire-entry node, so the
/// distinct-source discipline `cert_arrival_order.rs:11-25` is natural — one same-tick
/// arrival per lane, never two into one holding buffer):
/// - belt lane `k`: `belt_source[k] -> belt(1) -> collector` (a `fire()` at tick 0
///   lands at the collector at `now = 3`).
/// - wire lane `k`: `wire_entry[k]` with `wire[k] = (entry,0)->(collector,0)`; a
///   [`wire_fire`] with `return_addr = (entry[k], 0)` admitted at tick `t` is forwarded
///   into the collector at `now = t + 1` through the SAME `route_seq` delivery queue
///   belt items use — so belt and wire delivery are indistinguishable to the comparator.
///
/// The collector is allocated FIRST (lowest [`NodeId`]); it is a `Source` that ignores
/// its input port, so every delivered belt item and wire envelope rests in its inbox.
pub fn belt_wire_merge_collector(
    seed: u64,
    belt_inputs: u16,
    wire_inputs: u16,
) -> (Core, BeltWireTopology) {
    let mut core = Core::genesis(header(seed));
    let collector = core.state.add_source();
    let mut belt_sources = Vec::new();
    for _ in 0..belt_inputs {
        let s = core.state.add_source();
        let b = core.state.add_belt(1);
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (collector, 0));
        belt_sources.push(s);
    }
    let mut wire_entries = Vec::new();
    let mut wires = Vec::new();
    for _ in 0..wire_inputs {
        let entry = core.state.add_source();
        // Entry wire: `from.node == entry` so `wire_from_node(entry)` selects it at
        // admit; it forwards on port 0, routed to the collector by the standard link.
        let w = core.state.add_wire((entry, 0), (collector, 0));
        core.state.link((w, 0), (collector, 0));
        wire_entries.push(entry);
        wires.push(w);
    }
    (
        core,
        BeltWireTopology {
            belt_sources,
            wire_entries,
            wires,
            collector,
        },
    )
}

/// Build `source -> belt(latency) -> collector` from genesis seeded with `seed`.
///
/// The collector is a `Source` node: it ignores its input port, so a routed item
/// rests in its inbox for inspection at exactly the arrival tick. Returns
/// `(core, source_id, collector_id)`.
pub fn source_belt_collector(seed: u64, latency: u32) -> (Core, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let b = core.state.add_belt(latency);
    let c = core.state.add_source();
    core.state.link((s, 0), (b, 0));
    core.state.link((b, 0), (c, 0));
    (core, s, c)
}

/// Build `source -> tee(n) -> [collector_0 .. collector_{n-1}]` from genesis
/// seeded with `seed`. Each tee output port `k` is wired to a distinct collector
/// `Source` (which ignores its input port, so a routed item rests in its inbox
/// for inspection). Returns `(core, source_id, collector_ids)`.
pub fn source_tee_collectors(seed: u64, n: u16) -> (Core, NodeId, Vec<NodeId>) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let t = core.state.add_tee(n);
    core.state.link((s, 0), (t, 0));
    let mut collectors = Vec::new();
    for port in 0..n {
        let c = core.state.add_source();
        core.state.link((t, port), (c, 0));
        collectors.push(c);
    }
    (core, s, collectors)
}

/// Build `source -> balancer(n) -> [collector_0 .. collector_{n-1}]` from
/// genesis seeded with `seed`. Each balancer output port `k` is wired to a
/// distinct collector `Source`. Returns `(core, source_id, collector_ids)`.
pub fn source_balancer_collectors(seed: u64, n: u16) -> (Core, NodeId, Vec<NodeId>) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let bal = core.state.add_balancer(n);
    core.state.link((s, 0), (bal, 0));
    let mut collectors = Vec::new();
    for port in 0..n {
        let c = core.state.add_source();
        core.state.link((bal, port), (c, 0));
        collectors.push(c);
    }
    (core, s, collectors)
}

/// Count (and drain) the items resting on port 0 of `id`'s inbox — the items a
/// collector `Source` has accumulated.
pub fn collector_count(core: &Core, id: NodeId) -> usize {
    let mut inbox = core.state.inbox_of(id).cloned().expect("collector inbox");
    let mut n = 0;
    while inbox.take(0).is_some() {
        n += 1;
    }
    n
}

/// Drain the items resting on port 0 of `id`'s inbox **in order** — the merged
/// stream a collector `Source` has accumulated (FIFO). Used to assert the exact
/// round-robin(port)-then-FIFO merge order.
pub fn collector_items(core: &Core, id: NodeId) -> Vec<Item> {
    let mut inbox = core.state.inbox_of(id).cloned().expect("collector inbox");
    let mut out = Vec::new();
    while let Some((_seq, item)) = inbox.take(0) {
        out.push(item);
    }
    out
}

/// Build `[source_0 .. source_{n-1}] -> merge(n) -> collector` from genesis seeded
/// with `seed`. Each source `k` is wired to a distinct input port `k` of one
/// `add_merge(n)`; the merge's single output port 0 is wired to a collector
/// `Source` (which ignores its input port, so merged items rest in its inbox for
/// inspection). Returns `(core, source_ids, collector_id)`.
pub fn multi_source_merge_collector(seed: u64, inputs: u16) -> (Core, Vec<NodeId>, NodeId) {
    let mut core = Core::genesis(header(seed));
    let merge = core.state.add_merge(inputs);
    let mut sources = Vec::new();
    for port in 0..inputs {
        let s = core.state.add_source();
        core.state.link((s, 0), (merge, port));
        sources.push(s);
    }
    let c = core.state.add_source();
    core.state.link((merge, 0), (c, 0));
    (core, sources, c)
}

/// Build `source -> router(routes, default)` with the router's reserved
/// `FAULT_PORT` wired to a collector `Source` sink (the **dead-letter** topology,
/// API-05). The source is wired to the router's input port 0; the router's
/// `FAULT_PORT` is wired to a collector that ignores its input port, so a faulted
/// item rests in its inbox for inspection. Returns
/// `(core, source_id, router_id, sink_id)`.
pub fn router_dead_letter(
    seed: u64,
    routes: Vec<(RouteKey, PortId)>,
    default: Option<PortId>,
) -> (Core, NodeId, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let router = core.state.add_router(routes, default);
    core.state.link((s, 0), (router, 0));
    let sink = core.state.add_source();
    core.state.link((router, FAULT_PORT), (sink, 0));
    (core, s, router, sink)
}

/// Build `source -> router` whose `FAULT_PORT` is wired back **through a delay
/// belt** of `latency` ticks to a downstream collector (the **retry-loop**
/// topology, API-05). The router has an empty route table and no default, so
/// every inbound item faults; the fault then traverses the belt and re-arrives at
/// the collector after exactly `latency` ticks. Returns
/// `(core, source_id, router_id, collector_id)`.
pub fn router_retry_loop(seed: u64, latency: u32) -> (Core, NodeId, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    // Empty routes + no default => every item faults (the first fault producer).
    let router = core.state.add_router(Vec::new(), None);
    core.state.link((s, 0), (router, 0));
    let belt = core.state.add_belt(latency);
    core.state.link((router, FAULT_PORT), (belt, 0));
    let c = core.state.add_source();
    core.state.link((belt, 0), (c, 0));
    (core, s, router, c)
}

/// One deterministic step of the merge snapshot scenario. The injection schedule
/// depends ONLY on `core.tick`, so an uninterrupted run and a restored-then-
/// continued run produce byte-identical event streams.
///
/// Each tick fires one item into a **rotating** input `sources[tick % n]` (so the
/// merge's round-robin pointer advances and a snapshot boundary lands mid-cycle).
/// On even ticks it fires a SECOND item into that same input, creating a backlog
/// the merge cannot drain in one pass — exercising the `tick+1` re-wake and
/// leaving un-served items + a pending wake at the snapshot boundary (so the
/// equivalence proof also covers the merge inbox + scheduler wheel, not just
/// `next`). Also draws the rng so the rng counter is non-trivial at the boundary.
pub fn step_merge_scenario(core: &mut Core, sources: &[NodeId]) {
    let n = sources.len() as u64;
    let t = core.tick;
    let primary = (t % n) as usize;
    let mut inbound = vec![fire(sources[primary], t, t, Item(vec![(t % 251) as u8]))];
    if t.is_multiple_of(2) {
        // A second item onto the SAME input port => the merge leaves a backlog
        // (one item per input per pass), forcing a tick+1 re-wake.
        inbound.push(fire(
            sources[primary],
            t,
            t,
            Item(vec![((t + 128) % 251) as u8]),
        ));
    }
    advance_drawing_rng(core, &inbound);
}

/// Run the merge snapshot scenario from genesis up to (but not including)
/// `target` tick, returning `(core, source_ids, collector_id)`.
pub fn run_merge_to(seed: u64, inputs: u16, target: u64) -> (Core, Vec<NodeId>, NodeId) {
    let (mut core, sources, c) = multi_source_merge_collector(seed, inputs);
    while core.tick < target {
        step_merge_scenario(&mut core, &sources);
    }
    (core, sources, c)
}

/// Advance exactly one tick while drawing one value from the seeded rng, so the
/// rng's counter STATE advances and becomes part of the tick-boundary snapshot
/// (the faithful stand-in for a per-tick rng-drawing machine — see module note).
pub fn advance_drawing_rng(core: &mut Core, inbound: &[Event]) {
    let _ = core.rng.next_u64();
    core.advance(inbound);
}

/// One deterministic step of the balancer snapshot scenario: fire EXACTLY ONE
/// item every tick into `source` (so the balancer's round-robin pointer advances
/// one step per tick and a snapshot boundary lands mid-rotation) and draw the
/// rng. The injection schedule depends ONLY on `core.tick`, so an uninterrupted
/// run and a restored-then-continued run produce byte-identical event streams.
pub fn step_balancer_scenario(core: &mut Core, source: NodeId) {
    let inbound = vec![fire(
        source,
        core.tick,
        core.tick,
        Item(vec![(core.tick % 251) as u8]),
    )];
    advance_drawing_rng(core, &inbound);
}

/// Run the balancer snapshot scenario from genesis up to (but not including)
/// `target` tick, returning `(core, source_id)`.
pub fn run_balancer_to(seed: u64, outputs: u16, target: u64) -> (Core, NodeId) {
    let (mut core, s, _collectors) = source_balancer_collectors(seed, outputs);
    while core.tick < target {
        step_balancer_scenario(&mut core, s);
    }
    (core, s)
}

// ── Factory (Phase 4) helpers — single-sourced so 04-03 and 04-04 share them ──

/// The canonical **stateful counter** factory used across the factory test
/// scenarios (and the 04-04 golden fixture), so every factory test drives the same
/// source and they cannot drift.
///
/// Behavior: on the sentinel input `"loop"` it runs an unbounded loop (so a fixture
/// can capture a deterministic **fuse-trip** tick → `FactoryTimeout`). Otherwise it
/// increments a counter held in `ctx.state` — the SOLE cross-tick state — and emits
/// the running count on output port 0. The increment is independent of the input
/// value, so any non-sentinel input advances the counter by one, proving `ctx.state`
/// crosses ticks (criterion-5 groundwork).
pub const COUNTER_FACTORY_JS: &str = r#"export default function (input, ctx) {
  if (input === "loop") { while (true) {} }
  ctx.state.count = (ctx.state.count || 0) + 1;
  ctx.emit(0, ctx.state.count);
}"#;

/// A factory that **incorrectly** keeps its counter in a MODULE-SCOPE `let`
/// (`count`) instead of `ctx.state` — the idiomatic mistake CR-02 guards against.
///
/// Under "compile once, run many" this `count` would persist across ticks on the
/// live engine yet live NOWHERE in the snapshot, so it would reset to cold on
/// snapshot/restore and diverge the replay (a break of the non-negotiable SC#2).
/// With per-tick module re-instantiation, the module's top-level `let count = 0`
/// gets a FRESH scope every call, so `count` is always `1` when emitted — identical
/// genesis-vs-genesis AND across snapshot/restore. This source is the regression
/// fixture proving module-scope state can no longer diverge: it is exercised through
/// both `cert_golden_replay` (genesis-vs-genesis) and `cert_snapshot_equiv`
/// (mid-run snapshot/restore). `ctx.state` remains the SOLE cross-tick state.
pub const MODULE_SCOPE_COUNTER_FACTORY_JS: &str = r#"let count = 0;
export default function (input, ctx) {
  count = count + 1;
  ctx.emit(0, count);
}"#;

/// A factory that **incorrectly** stashes its counter on the curated `Math` object
/// (and pollutes `Object.prototype`) instead of `ctx.state` — the shallow-freeze
/// door CR-01 (iteration 2) guards against.
///
/// `Object.freeze(globalThis)` is shallow, so on a REUSED context `Math.acc` and
/// `Object.prototype.n` would accumulate on the live engine yet live NOWHERE in the
/// snapshot — a persists-then-resets divergence on snapshot/restore (the
/// non-negotiable SC#2), exactly the CR-02 failure mode reintroduced through a
/// different door. With a FRESH context every tick the curated `Math` and every
/// prototype are rebuilt each call, so the emitted `Math.acc` is ALWAYS `1` —
/// identical genesis-vs-genesis AND across snapshot/restore. This source is the
/// regression fixture proving intrinsic/prototype mutation can no longer diverge: it
/// is exercised through both `cert_golden_replay` (genesis-vs-genesis) and
/// `cert_snapshot_equiv` (mid-run snapshot/restore). It emits the STASHED value (not
/// `ctx.state`) on purpose — a REUSED-context regression would diverge here, a
/// fresh-context core stays byte-identical. `ctx.state` remains the SOLE cross-tick
/// state.
pub const INTRINSIC_STASH_FACTORY_JS: &str = r#"export default function (input, ctx) {
  Math.acc = (Math.acc || 0) + 1;
  Object.prototype.n = (Object.prototype.n || 0) + 1;
  ctx.emit(0, Math.acc);
}"#;

/// Build `source -> factory(source_js) -> collector` from genesis seeded with `seed`
/// (the factory uses [`DEFAULT_GAS_BUDGET`]). The links are instant (no belts), so a
/// fire reaches the collector within the same tick via the fold's fixpoint. The
/// collector is a `Source` that ignores its input port, so emitted items rest in its
/// inbox for inspection (mirroring [`source_belt_collector`]). Returns
/// `(core, source_id, factory_id, collector_id)`.
pub fn source_factory_collector(seed: u64, source_js: &str) -> (Core, NodeId, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let f = core.state.add_factory(source_js.to_owned(), DEFAULT_GAS_BUDGET, seed);
    let c = core.state.add_source();
    core.state.link((s, 0), (f, 0));
    core.state.link((f, 0), (c, 0));
    (core, s, f, c)
}

/// Drive a single `Node::Factory` (`id`) for ONE tick over its queued inputs in
/// isolation (not the full fold), returning the drained `(port, item)` outputs —
/// including any items on the reserved [`FAULT_PORT`] — in deterministic
/// `(port asc, FIFO)` order. Mirrors the `step_source`/`step_router`-style isolated
/// drivers for unit-level assertions. Rebuilds the live engine lazily through the
/// Core's runtime cache exactly like the production fold.
///
/// THE WIRE-REQUEST DISCRIMINATOR IS COMPUTED HERE, NEVER TAKEN AS AN ARGUMENT, and
/// that is the whole point rather than a style choice. `step_factory` decides whether a
/// delivery is a wire request from the DECLARED MEDIUM of inbox port 0 (D-16). A helper
/// that let its CALLER supply that fact could produce any answer the test author wanted,
/// and every test built on it would then assert the author's intent rather than the
/// fold's behaviour. So this reads it from the state it was given, with the same
/// predicate the production fold uses (`tick::step_node` calls `admit::inbox_class` and
/// nothing else), and a divergence between the two becomes a visible edit to one line
/// rather than a silent disagreement between a test and the code it claims to measure.
/// `crates/fabrico-core/tests/factory_medium.rs` refuses this helper outright for the
/// same reason one layer up: its boards go through `Core::advance`, so a signature
/// change cannot make them pass by construction.
///
/// AT PHASE 72 THIS HELPER HAS ZERO CALLERS (measured, not assumed:
/// `grep -rn '\bstep_factory\b' crates/ --include='*.rs'` names only this definition,
/// the production function and prose). The crate-level `#![allow(dead_code)]` at the top
/// of this module is what keeps that quiet, so nothing warns when its signature drifts.
/// It is kept because the `step_source`/`step_router` isolated drivers beside it are the
/// established idiom for unit-level assertions, and it is written to compute rather than
/// accept so that the first test to use it cannot start life asserting its own input.
pub fn step_factory(core: &mut Core, id: NodeId) -> Vec<(PortId, Item)> {
    let now = core.tick;
    // Computed, not supplied. See the note above.
    let port_zero_is_electrical = matches!(
        fabrico_core::admit::inbox_class(&core.state, id, 0),
        fabrico_core::admit::AdmitClass::Electrical
    );
    // The linked output ports, computed the way `tick::step_node` computes them (phase 87,
    // JAM-05), for the same reason as the discriminator above.
    let linked_out_ports: std::collections::BTreeSet<PortId> = core
        .state
        .links_from(id)
        .map(|((_, port), _)| port)
        .filter(|&port| port != fabrico_core::fault::FAULT_PORT)
        .collect();
    let mut inbox = std::mem::take(core.state.inbox_mut(id));
    let mut outbox = PortOutbox::new();
    let mut commands = Vec::new();
    match core.state.node_mut(id).expect("step_factory: node exists") {
        Node::Factory(factory) => fabrico_core::factory::step_factory(
            now,
            id,
            factory,
            &mut core.factory_runtimes,
            &mut inbox,
            port_zero_is_electrical,
            &linked_out_ports,
            &mut outbox,
            &mut commands,
            &mut core.sched,
        ),
        _ => panic!("step_factory: node {id:?} is not a Node::Factory"),
    }
    *core.state.inbox_mut(id) = inbox;
    outbox.drain_sorted()
}

/// One deterministic step of the factory snapshot scenario: fire EXACTLY ONE input
/// per tick into `source` and advance the full fold. The injection schedule depends
/// ONLY on `core.tick`, so an uninterrupted run and a restored-then-continued run
/// produce byte-identical event streams (the snapshot-equivalence contract). The
/// fired item is a constant non-sentinel value, so the [`COUNTER_FACTORY_JS`] factory
/// advances its `ctx.state` counter by one per tick.
pub fn step_factory_scenario(core: &mut Core, source: NodeId) {
    let inbound = vec![fire(source, core.tick, core.tick, Item(b"1".to_vec()))];
    core.advance(&inbound);
}

/// Run the factory snapshot scenario from genesis up to (but not including) `target`
/// tick, returning `(core, source_id, factory_id, collector_id)`.
pub fn run_factory_to(seed: u64, source_js: &str, target: u64) -> (Core, NodeId, NodeId, NodeId) {
    let (mut core, s, f, c) = source_factory_collector(seed, source_js);
    while core.tick < target {
        step_factory_scenario(&mut core, s);
    }
    (core, s, f, c)
}

// ── Executor seam (Phase 5) helpers — the source->sink dead-letter topology ──

/// Build `source -> sink(template, deadline_ticks)` from genesis seeded with `seed`
/// — the Phase-5 executor-seam topology (Plan 05-05).
///
/// The sink consumes each item on input port 0 and emits one side-effecting
/// `Command` of intent (no belt output). When a logged `CommandResult{Failure}` or
/// `Timeout` re-enters the fold, [`fabrico_core::manual_inject::admit`] routes the
/// fault to the **emitting sink's own FAULT_PORT inbox** — it is *deposited* into
/// that inbox, NOT *emitted* to an outbox — so the dead-letter resting place here
/// is the sink's FAULT_PORT inbox itself, with NO separate downstream node. (This
/// is the load-bearing asymmetry vs. [`source_factory_collector`]: a factory
/// *emits* its FactoryTimeout to its outbox `FAULT_PORT`, which the tick loop then
/// routes along a link to a dead-letter node; a command fault never touches an
/// outbox, so a `link((sink, FAULT_PORT), …)` would carry nothing.) Returns
/// `(core, source_id, sink_id)`; observe the dead-letter with [`fault_port_reasons`].
pub fn source_sink_deadletter(
    seed: u64,
    template: SinkTemplate,
    deadline_ticks: u64,
) -> (Core, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let k = core.state.add_sink(template, deadline_ticks);
    core.state.link((s, 0), (k, 0));
    (core, s, k)
}

/// A logged `CommandResult` event re-entering the fold (Phase-5 EXEC seam): the
/// host's recorded outcome for a dispatched command. On replay `admit()` re-folds
/// it verbatim with zero real dispatch (the cross-platform half of REPLAY-04).
pub fn command_result(command_id: CommandId, seq: u64, tick: u64, outcome: Outcome) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::CommandResult(ResultEvent {
            command_id,
            tick,
            outcome,
        }),
    }
}

/// A logged `Timeout` event re-entering the fold (Phase-5 EXEC-03): the host
/// synthesized this when a command's logged deadline passed unresolved. It is
/// BAKED into the static corpus log (the cert runner has no host to synthesize it).
pub fn command_timeout(command_id: CommandId, seq: u64, tick: u64) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::Timeout { command_id },
    }
}

/// Drain and decode the faults resting on `node`'s reserved [`FAULT_PORT`] inbox,
/// in FIFO order — the dead-lettered command faults a sink accumulates (Plan 05-05).
pub fn fault_port_reasons(core: &Core, node: NodeId) -> Vec<FaultReason> {
    let mut inbox = core.state.inbox_of(node).cloned().expect("node inbox");
    let mut reasons = Vec::new();
    while let Some((_seq, item)) = inbox.take(FAULT_PORT) {
        reasons.push(Fault::decode(&item).expect("decode dead-letter fault").reason);
    }
    reasons
}

/// One deterministic step of the SC#2 scenario: inject an item every third tick
/// (keeping the belt populated with in-flight items) and draw the rng. The
/// injection schedule depends ONLY on `core.tick`, so an uninterrupted run and a
/// restored-then-continued run produce byte-identical event streams.
pub fn step_scenario(core: &mut Core, source: NodeId) {
    let inbound = if core.tick.is_multiple_of(3) {
        vec![fire(
            source,
            core.tick,
            core.tick,
            Item(vec![(core.tick % 251) as u8]),
        )]
    } else {
        Vec::new()
    };
    advance_drawing_rng(core, &inbound);
}

/// Run the SC#2 scenario from genesis up to (but not including) `target` tick,
/// returning `(core, source_id)`.
pub fn run_scenario_to(seed: u64, latency: u32, target: u64) -> (Core, NodeId) {
    let (mut core, s, _c) = source_belt_collector(seed, latency);
    while core.tick < target {
        step_scenario(&mut core, s);
    }
    (core, s)
}
