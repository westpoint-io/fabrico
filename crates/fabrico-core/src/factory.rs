//! The deterministic JavaScript factory sandbox (FACT-01..04).
//!
//! A [`FactoryRuntime`] runs a user's `export default function(input, ctx)`
//! module inside a curated `rquickjs` (QuickJS-NG) context, **re-instantiating the
//! module into a fresh scope on every call** (see "Per-tick re-instantiation"
//! below) and running it once per input item. The sandbox boundary **is** the
//! determinism boundary: the whole point of this module is to let untrusted user
//! JS run without ever leaking a non-deterministic input into the certified core,
//! and without ever panicking — or hanging — the sim.
//!
//! # Per-tick FRESH CONTEXT (CR-01 / CR-02 — load-bearing)
//! Every [`run`](FactoryRuntime::run) builds a **brand-new `rquickjs` [`Context`]**
//! (reusing only the long-lived [`Runtime`] for the memory/interrupt fences),
//! re-installs the curated environment (host primitives, curated `Math`, the
//! prelude, frozen globals) into it, and re-declares + re-evaluates the user module
//! inside it — then drops the whole context at the end of the call. NOTHING is
//! compiled once and reused across ticks. Two invariants depend on this:
//!
//! 1. **`ctx.state` is the SOLE cross-tick state.** A fresh context recreates the
//!    ENTIRE JS realm each tick — globals, the curated `Math` object, every builtin
//!    prototype (`Object.prototype`, `Array.prototype`, …), the `__fab_*` prelude
//!    function objects, AND the engine's module-record table — so there is
//!    structurally NO mutable JS object that survives a tick. A module-scope
//!    `let count = 0`, a `globalThis.count = …`, a `Math.acc = …`, or an
//!    `Object.prototype.n = …` (every idiomatic way users *try* to keep state) is
//!    per-tick scratch that resets each call; none can accumulate on the live
//!    engine while living nowhere in the snapshot, which is exactly the
//!    persists-then-resets divergence CR-02 forbids (the non-negotiable SC#2). Only
//!    `ctx.state` (plain JSON, rehydrated each call) and the per-node [`SimRng`]
//!    (plain data, swapped in each call) cross a tick — both are snapshotted.
//!    `globalThis` is additionally `Object.freeze`d each tick so a *direct*
//!    `globalThis.x = …` write faults LOUDLY rather than silently resetting.
//!    (A shallow `Object.freeze(globalThis)` on a REUSED context was insufficient:
//!    it left `Math`, the prelude functions, and every prototype mutable and shared
//!    across ticks — the door the fresh context closes structurally. The fresh
//!    context ALSO resets the module-record table each tick, so per-tick
//!    `Module::declare` cannot accumulate engine-internal records and push a
//!    long-lived core toward the memory limit `FenceAllocator` enforces at a tick a
//!    cold-restored core would not — closing the long-horizon snapshot/restore
//!    divergence too.)
//! 2. **No untrusted code ever runs UNMETERED.** The module's top-level statements
//!    execute during that per-tick eval, which happens *under the armed gas fuse*
//!    (the fuse is held UNMETERED only while the TRUSTED environment is installed,
//!    then armed immediately before the user module is declared/evaluated), so a
//!    top-level `for(;;){}` trips the fuse to a `FactoryTimeout` fault instead of
//!    hanging the deterministic core (CR-01). Construction only *parses*
//!    (`Module::declare`) to validate syntax — it never evaluates user top-level
//!    code, so the build seam cannot hang either.
//!
//! # The determinism contract (load-bearing — the project's determinism non-negotiables)
//! Three independent mechanisms enforce it, all verified against the 04-01 spike
//! and the quickjs-ng C source (see `04-RESEARCH.md`):
//!
//! 1. **Ambient authority denied by absence.** The context is built from a
//!    *curated* intrinsic set ([`Curated`]) that OMITS `Date`. `fetch`,
//!    `setTimeout`, `setInterval`, `process`, and `require` never exist in a bare
//!    rquickjs context (they live in `quickjs-libc`, which is not installed). The
//!    global `Math` is REPLACED with a curated object exposing only the
//!    bit-exact / correctly-rounded members and the numeric constants —
//!    `Math.random` (ambient `gettimeofday` xorshift) and every platform-`libm`
//!    transcendental (`sin`/`cos`/`exp`/`log`/`pow`/…) are withheld. A factory
//!    that touches a withheld member gets a `TypeError` routed to a fault, so it
//!    cannot even silently leak nondeterminism.
//!
//! 2. **A deterministic, execution-driven gas fuse.** A shared
//!    [`Cell<u64>`](std::cell::Cell) budget is counted down inside the runtime's
//!    interrupt handler — which QuickJS-NG calls once per `JS_INTERRUPT_COUNTER_INIT`
//!    (10000) bytecode polls. The trip point is therefore a pure function of the
//!    executed bytecode path, identical on every CPU/OS, and **never** reads a
//!    clock (the `clippy.toml` gate structurally forbids `Instant`/`SystemTime`
//!    in this crate, so the wall-clock variant cannot even compile). The budget is
//!    armed before EVERY per-tick eval — including the module's top-level
//!    statements (CR-01) — and a forced abort is recorded in an explicit `tripped`
//!    flag so a fuse trip is told from an ordinary throw by *what happened*, not by
//!    inferring it from `budget == 0` (which a throw at exactly-exhausted budget
//!    would mislabel — WR-02).
//!
//! 3. **f64-free randomness.** `ctx.random()` / `ctx.randomInt()` draw from a
//!    per-node seeded [`SimRng`] (ChaCha8) substream: the host exposes only raw
//!    `u32` bits, and the half-open `[0, 1)` float division happens ENTIRELY
//!    inside the JS engine. No `f64`/`f32` token appears in this file, so the
//!    determinism clippy gate stays green with the JS boundary present.
//!
//! # Canonical JSON boundary
//! Every value crossing the JS↔Rust boundary (the decoded `input`, each
//! `ctx.emit` payload, each `ctx.command` effect, and the persisted `ctx.state`)
//! crosses as in-engine `JSON.stringify` / `JSON.parse` output. QuickJS-NG bundles
//! its own deterministic `dtoa`, JS object property order is spec-defined, and
//! `NaN`/`Infinity` canonicalize to `null` — so the bytes are byte-identical
//! across platforms. Untrusted bytes are decoded **behind a `Result`, never
//! `unwrap`** (Pitfall 4 / Security V5): a malformed item faults, it does not
//! panic the deterministic core.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use fabrico_qjs_alloc::FenceAllocator;
use rquickjs::context::intrinsic;
use rquickjs::prelude::Func;
use rquickjs::{CatchResultExt, Context, Ctx, Function, Module, Object, Runtime, Value};

use crate::command::{Command, EVENT_VERSION, Effect};
use crate::fault::{FAULT_PORT, Fault, FaultReason};
use crate::ids::{Item, NodeId, PortId};
use crate::rng::SimRng;
use crate::scheduler::Scheduler;
use crate::state::{Factory, PortInbox, PortOutbox};

/// The curated intrinsic set: `Eval` (run the prelude + compile the module),
/// `Json` (the canonical boundary encoding), and `Promise` — which is
/// **mandatory** for the `export default` module path: QuickJS-NG module
/// evaluation is promise-based and `Module::eval()` aborts the engine (SIGABRT)
/// without it (pinned by the 04-01 spike). `Promise` adds only deterministic
/// microtask machinery — no timers, no ambient nondeterminism. `Date` is
/// deliberately absent (it is `intrinsic::Date`, simply not listed).
type Curated = (intrinsic::Eval, intrinsic::Json, intrinsic::Promise);

/// Shared host-side collector for `ctx.emit`, captured during a call and drained after.
type EmitCollector = Rc<RefCell<EmitLog>>;

/// What one run's `ctx.emit` calls left behind (phase 87, JAM-05, D-07): the recorded
/// `(port, canonical-JSON bytes)` pairs in emission order, how many were recorded per port,
/// and how many per port were NOT recorded because that port already held
/// [`FACTORY_EMITS_PER_PORT`] emits from this run. A refused emit keeps no bytes, only a
/// count, so a run can never hold more than [`FACTORY_EMITS_PER_PORT`] items per port
/// however often it calls `ctx.emit`; the gas fuse bounds the calls themselves.
#[derive(Default)]
struct EmitLog {
    recorded: Vec<(u16, Vec<u8>)>,
    per_port: BTreeMap<u16, u32>,
    refused: BTreeMap<u16, u32>,
}

impl EmitLog {
    /// How many emits this run has recorded on `port`.
    fn recorded_on(&self, port: u16) -> u32 {
        self.per_port.get(&port).copied().unwrap_or(0)
    }

    /// Record one emit on `port`.
    fn record(&mut self, port: u16, bytes: Vec<u8>) {
        self.recorded.push((port, bytes));
        *self.per_port.entry(port).or_insert(0) += 1;
    }

    /// Count one emit on `port` that was not recorded.
    fn refuse(&mut self, port: u16) {
        let n = self.refused.entry(port).or_insert(0);
        *n = n.saturating_add(1);
    }

    /// Forget everything (before a call, and after a faulted one).
    fn clear(&mut self) {
        *self = Self::default();
    }
}

/// Default per-tick gas budget, in interrupt-handler callbacks. Each callback is
/// ~`JS_INTERRUPT_COUNTER_INIT` (10000) bytecode polls, so 256 callbacks ≈ a few
/// million polls per tick — generous for real factory work, while a `while(true){}`
/// trips in well under a millisecond. The value only bounds how much work a
/// factory may do per tick; it does not affect determinism (the trip point is a
/// pure function of the bytecode path at any fixed budget).
pub const DEFAULT_GAS_BUDGET: u64 = 256;

/// Default memory fence (bytes). Caps memory-bomb allocations. `FenceAllocator` enforces
/// it in the bytes it hands out, so the limit doesn't depend on QuickJS's platform
/// constant; an over-limit allocation returns null, and the engine raises that as a
/// catchable error → `FactoryError` fault.
///
/// Fixed-width `u32` (not `usize`): these fences are configuration values, not
/// serialized state, but keeping every numeric knob fixed-width keeps the
/// determinism story uniform and satisfies the pointer-width forward guard
/// (`scripts/check-no-usize-state.sh`); cast to `usize` only at the rquickjs
/// fence call site. 8 MiB fits `u32` with room to spare.
pub const DEFAULT_MEM_LIMIT: u32 = 8 * 1024 * 1024;

/// Default stack fence (bytes). Caps deep-recursion / stack-bomb factories.
/// Fixed-width `u32` for the same reason as [`DEFAULT_MEM_LIMIT`].
pub const DEFAULT_STACK_LIMIT: u32 = 256 * 1024;

/// Sentinel budget used while *building* the runtime (running the trusted prelude,
/// curating `Math`, and parse-validating the user source). The fuse must not trip
/// during construction regardless of how small a per-tick `gas_budget` the caller
/// chose, so the budget cell is held "unmetered" until [`FactoryRuntime::run`]
/// arms it per call. Crucially, build only *parses* the user module
/// (`Module::declare`) — it never *evaluates* untrusted top-level code while
/// UNMETERED, so the build seam cannot hang (CR-01).
const UNMETERED: u64 = u64::MAX;

// ── Curated Math: keep only the deterministic members ───────────────────────────
//
// Installed into a FRESH context every tick (and into the build/probe context). We
// copy the bit-exact / correctly-rounded members
// and the numeric constants off the base `Math` into a fresh object, then replace
// the global `Math` with it and drop the reference to the original (which is then
// GC'd, taking `Math.random` and every transcendental with it). IEEE-754 mandates
// correct rounding for `sqrt`; `floor/ceil/round/trunc/abs/sign/min/max` are exact
// integer/compare ops; `fround/clz32/imul` are bit-defined. The constants are just
// stored doubles, identical on every platform.
const CURATE_MATH_JS: &str = r#"(function () {
  var M = Math;
  var c = {};
  var methods = ['floor','ceil','round','trunc','abs','sign','min','max','sqrt','fround','clz32','imul'];
  for (var i = 0; i < methods.length; i++) { c[methods[i]] = M[methods[i]]; }
  var consts = ['PI','E','LN2','LN10','LOG2E','LOG10E','SQRT2','SQRT1_2'];
  for (var j = 0; j < consts.length; j++) { c[consts[j]] = M[consts[j]]; }
  globalThis.Math = c;
})()"#;

// ── The JS prelude: host-primitive wrappers + the ctx factory ───────────────────
//
// Re-installed into a FRESH context every tick. `__fab_emit`/`__fab_command`/`__fab_random_bits`
// are host `Func`s (Rust closures) installed separately. The prelude defines the
// canonical JSON helpers and `__fab_make_ctx`, which builds the per-call `ctx`
// object the user's `default(input, ctx)` receives. The half-open `[0, 1)` float
// division and the `randomInt` integer math live HERE, inside the engine — Rust
// only ever sees the raw `u32` bits, so no float token enters `fabrico-core`.
//
// IMPORTANT — `>>> 0`: rquickjs encodes a host `u32` whose high bit is set as a
// *negative* JS int32 (the low 32 bits are preserved, but the sign is not). The
// `>>> 0` unsigned-shift coerces it back through ToUint32 to the correct value in
// `[0, 2^32)` regardless of how it was encoded. Without it, ~half of all draws
// would be negative — breaking both `[0, 1)` for `random()` and the range bound
// for `randomInt()`. (This is the f64-free path: the only number Rust produces is
// the raw u32; all the float/range math is in JS.)
//
// `ctx.randomInt(lo, hi)` returns an integer in the half-open range `[lo, hi)`
// (mirroring `ctx.random()`'s `[0, 1)` and slice semantics); `hi <= lo` yields
// `lo`. The modulo is deterministic (a small, documented bias is acceptable for
// v1 game/automation use; a rejection-sampling upgrade is a future option).
const PRELUDE_JS: &str = r#"(function () {
  globalThis.__fab_parse = function (s) { return JSON.parse(s); };
  globalThis.__fab_stringify = function (v) { return JSON.stringify(v); };
  globalThis.__fab_make_ctx = function (stateJson) {
    return {
      state: JSON.parse(stateJson),
      emit: function (port, data) { __fab_emit(port, JSON.stringify(data)); },
      command: function (effect, deadline) { __fab_command(JSON.stringify(effect), deadline); },
      random: function () { return (__fab_random_bits() >>> 0) / 4294967296; },
      randomInt: function (lo, hi) {
        lo = Math.floor(lo); hi = Math.floor(hi);
        var range = hi - lo;
        if (range <= 0) { return lo; }
        return lo + ((__fab_random_bits() >>> 0) % range);
      }
    };
  };
})()"#;

// ── Freeze the global scope so a DIRECT global write faults loudly ───────────────
//
// Run each tick, AFTER the prelude + curated `Math` are installed into the fresh
// context. The structural guarantee that `ctx.state` is the SOLE cross-tick state
// comes from the per-tick FRESH CONTEXT (see the module header + `run_inner`): the
// whole realm — globals, `Math`, every prototype, the prelude functions, the module
// table — is rebuilt each tick, so nothing mutable survives a tick regardless of
// this freeze. `Object.freeze(globalThis)` is kept as a LOUD-FAILURE convenience:
// because modules are strict-mode, a *direct* `globalThis.x = …` throws → the tick
// faults LOUDLY (FactoryError) instead of silently resetting to per-tick scratch, so
// a user stashing state on the global object is told immediately rather than
// debugging a "works in-session, resets on restart" mystery. (`Object.freeze` is
// shallow, so `Math.acc = …` / `Object.prototype.n = …` do NOT throw — they are
// harmless per-tick scratch under the fresh context, never cross-tick state.) Frozen
// properties stay readable/callable, so the curated `Math` and the `__fab_*` host
// primitives remain fully usable each tick.
const FREEZE_GLOBALS_JS: &str = "Object.freeze(globalThis);";

/// Install the curated, deterministic environment onto a context: the host
/// primitives (`__fab_emit` / `__fab_command` / `__fab_random_bits`, each wired to
/// the shared host-side collectors), the curated `Math`, the JS prelude, and the
/// `Object.freeze(globalThis)` loud-failure guard — in that order.
///
/// Called once on the build/probe context AND, crucially, **on a brand-new context
/// every tick** inside [`run_inner`](FactoryRuntime::run_inner). Re-running it each
/// tick is what makes "the JS realm is per-tick scratch" true by construction: the
/// curated `Math`, the `__fab_*` function objects, and every builtin prototype are
/// freshly created in the fresh context, so user mutations to any of them cannot
/// cross a tick (CR-01 — the shallow-freeze door). The host primitives capture
/// CLONES of the shared `emits`/`commands`/`rng` handles, so the per-tick context's
/// wrappers still write into the same collectors the caller drains.
///
/// The caller MUST hold the fuse UNMETERED while this runs (it is trusted setup, not
/// user code) and arm it only afterwards, so env installation is never charged to
/// the user's per-tick gas budget.
fn install_env(
    ctx: &Ctx<'_>,
    emits: &EmitCollector,
    commands: &Rc<RefCell<Vec<CommandIntent>>>,
    rng: &Rc<RefCell<SimRng>>,
) -> rquickjs::Result<()> {
    let g = ctx.globals();
    let emits_h = emits.clone();
    g.set(
        "__fab_emit",
        // WR-01: validate the port instead of truncating `u32 as u16`. An
        // out-of-range port (`>= FAULT_PORT`, the reserved `u16::MAX`) — including a
        // negative arg that coerces through ToUint32 to `0xFFFFFFFF`, which is
        // `>= FAULT_PORT` and therefore rejected — would otherwise silently collide
        // with the reserved fault port or wrap to a wrong port. Throw a JS exception
        // instead: the call faults (FactoryError) with a diagnostic, routed like any
        // other factory fault, never a silent misroute onto FAULT_PORT.
        Func::new(move |ctx: Ctx, port: u32, json: String| -> rquickjs::Result<()> {
            if port >= FAULT_PORT as u32 {
                let msg = format!("ctx.emit: port {port} is out of range (valid 0..{})", FAULT_PORT);
                let value = rquickjs::String::from_str(ctx.clone(), &msg)?.into_value();
                return Err(ctx.throw(value));
            }
            // THE PER-PORT CAP (phase 87, JAM-05, D-07). The first
            // `FACTORY_EMITS_PER_PORT` emits on a port in one run are recorded; each later
            // one on that port is counted, NOT recorded, and the call returns normally.
            // It is deliberately not a throw: a throw faults the whole run and would also
            // lose the 16 emits D-07 keeps. `step_factory` turns each counted emit into
            // its own `FactoryError` fault naming the port and the cap.
            let port = port as u16;
            let mut log = emits_h.borrow_mut();
            if (log.recorded_on(port) as usize) < FACTORY_EMITS_PER_PORT {
                log.record(port, json.into_bytes());
            } else {
                log.refuse(port);
            }
            Ok(())
        }),
    )?;
    let commands_h = commands.clone();
    g.set(
        "__fab_command",
        Func::new(move |json: String, deadline: u64| {
            commands_h.borrow_mut().push(CommandIntent { effect_json: json.into_bytes(), deadline });
        }),
    )?;
    let rng_h = rng.clone();
    g.set("__fab_random_bits", Func::new(move || rng_h.borrow_mut().next_u32()))?;
    ctx.eval::<(), _>(CURATE_MATH_JS)?;
    ctx.eval::<(), _>(PRELUDE_JS)?;
    // Freeze the global scope LAST, after every host primitive + the curated Math are
    // installed. Frozen globals stay readable/callable (see FREEZE_GLOBALS_JS).
    ctx.eval::<(), _>(FREEZE_GLOBALS_JS)?;
    Ok(())
}

/// A command-execution *intent* captured from `ctx.command(effect, deadline)`.
///
/// Plain data the fold (04-03) maps onto the Phase-1 [`Command`](crate::command::Command)
/// seam. `effect_json` is the canonical `JSON.stringify` of the effect descriptor;
/// `deadline` is a tick-based deadline. v1 only enqueues intent — the real
/// executor I/O is Phase 5.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CommandIntent {
    /// Canonical JSON bytes of the effect descriptor passed to `ctx.command`.
    pub effect_json: Vec<u8>,
    /// Tick-based deadline the Phase-5 executor will use for timeouts.
    pub deadline: u64,
}

/// The plain-data result of one [`FactoryRuntime::run`] invocation — everything
/// that crosses back into the deterministic fold (04-03 consumes this).
///
/// On success `fault` is `None`. On any failure (uncaught throw, withheld-global
/// reference, bad input bytes, or a fuse trip) `fault` is `Some(reason)`,
/// `fault_message` carries the JS error string bytes for the dead-letter payload,
/// `emits`/`commands` are empty (partial effects are discarded), and
/// `new_state_json` is the **unchanged** prior state (a faulted tick does not
/// mutate persisted state). No live engine handles appear here — the outcome is
/// pure serializable data.
///
/// An emit past [`FACTORY_EMITS_PER_PORT`] on its port is NOT a fault of the run
/// (phase 87, JAM-05, D-07): the run's other effects stand, its first 16 emits per port
/// are in `emits`, and each surplus emit is counted in `refused` so the fold faults it on
/// its own. A run that faults for its own reason still discards every emit and every
/// refusal (`refused` is empty).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FactoryOutcome {
    /// Items emitted via `ctx.emit(port, data)`, in emission order, each payload
    /// the canonical `JSON.stringify` bytes.
    pub emits: Vec<(PortId, Item)>,
    /// Command intents enqueued via `ctx.command(effect, deadline)`.
    pub commands: Vec<CommandIntent>,
    /// The canonical `JSON.stringify(ctx.state)` bytes after the call — the SOLE
    /// cross-tick state (04-03 folds this into the whole-`Core` snapshot). On a
    /// fault this is the unchanged prior state.
    pub new_state_json: Vec<u8>,
    /// `None` on success; the fault reason on any failure mode.
    pub fault: Option<FaultReason>,
    /// JS error message bytes (empty on success) — the fold stamps these into the
    /// [`Fault`](crate::fault::Fault) payload for dead-letter inspection.
    pub fault_message: Vec<u8>,
    /// Per output port, how many of this run's `ctx.emit` calls were NOT recorded because
    /// the port already held [`FACTORY_EMITS_PER_PORT`] emits from this run (phase 87,
    /// JAM-05, D-07). Ascending port order, no zero entries; empty on a faulted run.
    pub refused: BTreeMap<PortId, u32>,
}

/// A build-time failure (un-compilable user source or an engine setup error).
/// Carries a human-readable message for diagnostics. Distinct from a *runtime*
/// fault: a build error means the factory could never run, so it is surfaced to
/// the topology builder rather than routed as a [`Fault`](crate::fault::Fault).
#[derive(Clone, Debug)]
pub struct FactoryBuildError {
    message: String,
}

impl FactoryBuildError {
    fn engine(e: rquickjs::Error) -> Self {
        Self { message: format!("engine setup error: {e}") }
    }

    fn user(message: String) -> Self {
        Self { message: format!("factory source did not compile: {message}") }
    }

    /// The diagnostic message.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for FactoryBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FactoryBuildError {}

/// A compiled, curated, fenced factory engine — the live cache for one factory
/// node. **Not** serializable and deliberately **not** `Clone`: the live engine
/// handles are `Arc`-shared, so a derived `Clone` would *share* one mutable
/// engine across two `Core`s (a determinism hazard). 04-03 holds these in a
/// `#[serde(skip)]` cache and rebuilds lazily from the node's plain data.
pub struct FactoryRuntime {
    // ── Field DECLARATION ORDER IS DROP ORDER, and it is load-bearing ──────────
    // A Context references the live Runtime; freeing the Runtime while a Context is
    // still alive aborts the engine at the C level (SIGABRT). This runtime holds NO
    // persistent Context: every context (the per-tick one in `run_inner`, the
    // build-time parse-validation one, the test-only `probe` one) is created and
    // dropped BEFORE `_rt` within its own scope, so a context can never outlive the
    // runtime. No JS value of any kind outlives a call.
    /// The shared gas-fuse budget, counted down in the interrupt handler. Armed
    /// to `gas_budget` (and `tripped` reset) before each call by `run`.
    budget: Rc<Cell<u64>>,
    /// Set to `true` by the interrupt handler at the instant it *forces* an abort
    /// (budget exhausted). Read after a failed call to classify the fault:
    /// `tripped` ⇒ `FactoryTimeout`, otherwise `FactoryError`. Recording the cause
    /// explicitly (rather than inferring it from `budget == 0`) avoids mislabeling
    /// an ordinary throw that happened to coincide with an exhausted budget as a
    /// timeout (WR-02). Reset to `false` alongside arming the budget each call.
    tripped: Rc<Cell<bool>>,
    /// Host-side collector the JS `ctx.emit` writes into (port, canonical-JSON
    /// bytes). Cleared before each call, drained after.
    emits: EmitCollector,
    /// Host-side collector the JS `ctx.command` writes into.
    commands: Rc<RefCell<Vec<CommandIntent>>>,
    /// The per-node RNG substream backing `ctx.random`/`randomInt`. Swapped to
    /// the caller's snapshotted `SimRng` before each call and written back after,
    /// so the advanced stream position is what 04-03 snapshots.
    rng: Rc<RefCell<SimRng>>,
    /// The per-tick callback budget armed before each call.
    gas_budget: u64,
    /// The user JS module source, re-declared into a FRESH context on every call
    /// (`run_inner`) so neither module-scope bindings nor any other JS state can
    /// persist across ticks (CR-01/CR-02). Validated to parse at build time, so a
    /// re-declare here only fails on engine resource limits, never a surprise syntax
    /// error.
    source: String,
    /// Owns the QuickJS runtime (the interrupt handler + fences live on it). This is
    /// the ONLY persistent engine handle; every `Context` is short-lived and built
    /// against this runtime on demand. Declared LAST so it drops LAST — after any
    /// transient context that borrows it.
    _rt: Runtime,
}

impl FactoryRuntime {
    /// Compile `source` (an `export default function(input, ctx) { … }` module)
    /// into a curated, fenced runtime. Applies the memory and stack fences,
    /// installs the execution-driven interrupt handler, builds the curated
    /// context (no `Date`, curated `Math`), installs the host primitives + JS
    /// prelude, and persists the module's `default` export for "compile once,
    /// run many".
    ///
    /// Returns [`FactoryBuildError`] (never panics) if the source does not
    /// compile or the engine cannot be set up.
    pub fn build(
        source: &str,
        gas_budget: u64,
        mem_limit: u32,
        stack_limit: u32,
    ) -> Result<Self, FactoryBuildError> {
        // The fences are fixed-width `u32` (config, not serialized state); cast to
        // the `usize` these APIs take only here, at the single fence call site.
        let rt = Runtime::new_with_alloc(FenceAllocator::new(mem_limit as usize))
            .map_err(FactoryBuildError::engine)?;
        rt.set_max_stack_size(stack_limit as usize);

        // The fuse: a shared budget counted down in the interrupt handler. Held
        // UNMETERED during construction so the prelude/parse cannot trip it; armed
        // per call by `run`. The handler reads NO clock (deterministic by design;
        // the clippy gate also forbids the wall-clock variant from compiling).
        // `tripped` records WHEN the handler forces an abort so `run` can tell a
        // fuse trip (FactoryTimeout) from an ordinary throw (FactoryError) by cause
        // rather than by inferring it from `budget == 0` (WR-02).
        let budget = Rc::new(Cell::new(UNMETERED));
        let tripped = Rc::new(Cell::new(false));
        {
            let budget = budget.clone();
            let tripped = tripped.clone();
            rt.set_interrupt_handler(Some(Box::new(move || {
                let remaining = budget.get();
                if remaining == 0 {
                    tripped.set(true);
                    return true; // abort at a reproducible point
                }
                budget.set(remaining - 1);
                false
            })));
        }

        // A transient validation context (dropped at the end of `build`): used only
        // to confirm the curated environment installs and the user source PARSES. No
        // context is kept on the struct — `run_inner` builds a fresh one each tick.
        let ctx = Context::custom::<Curated>(&rt).map_err(FactoryBuildError::engine)?;

        let emits: EmitCollector = Rc::new(RefCell::new(EmitLog::default()));
        let commands: Rc<RefCell<Vec<CommandIntent>>> = Rc::new(RefCell::new(Vec::new()));
        let rng: Rc<RefCell<SimRng>> = Rc::new(RefCell::new(SimRng::from_seed_u64(0)));

        // Install the curated environment (host primitives, curated Math, prelude,
        // frozen globals) onto the validation context. The budget is UNMETERED here,
        // so this trusted setup cannot trip the fuse. The IDENTICAL environment is
        // re-installed into a FRESH context every tick by `run_inner` (see there).
        ctx.with(|ctx| install_env(&ctx, &emits, &commands, &rng))
            .map_err(FactoryBuildError::engine)?;

        // Validate the user module by PARSING it only (`Module::declare`), never
        // EVALUATING it (CR-01): evaluating would run untrusted top-level code, and
        // at build time the fuse is held UNMETERED, so a top-level `for(;;){}` would
        // hang the sim at the build seam. Parsing a finite source is bounded and
        // surfaces a syntax error as a caught `FactoryBuildError`, never a panic and
        // never a hang. The actual top-level evaluation happens per call in
        // `run_inner`, UNDER the armed fuse, into a fresh module scope. The parsed
        // module is dropped here without being evaluated (proven safe — no SIGABRT).
        if let Err(message) = ctx.with(|ctx| {
            let parsed = (|| -> rquickjs::Result<()> {
                let _module = Module::declare(ctx.clone(), "factory", source)?;
                Ok(())
            })();
            parsed.catch(&ctx).map_err(|e| e.to_string())
        }) {
            return Err(FactoryBuildError::user(message));
        }

        Ok(Self {
            budget,
            tripped,
            emits,
            commands,
            rng,
            gas_budget,
            source: source.to_owned(),
            _rt: rt,
        })
    }

    /// Build with the default fences ([`DEFAULT_GAS_BUDGET`], [`DEFAULT_MEM_LIMIT`],
    /// [`DEFAULT_STACK_LIMIT`]).
    pub fn build_default(source: &str) -> Result<Self, FactoryBuildError> {
        Self::build(source, DEFAULT_GAS_BUDGET, DEFAULT_MEM_LIMIT, DEFAULT_STACK_LIMIT)
    }

    /// Run the compiled factory once over `input_bytes` with the prior
    /// `state_json` and the node's `rng` substream, returning a plain-data
    /// [`FactoryOutcome`]. **Never panics** — every failure mode (bad input
    /// bytes, an uncaught JS throw, a withheld-global reference, a memory/stack
    /// limit hit, or a fuse trip) becomes a `fault` in the outcome.
    ///
    /// Determinism: the fuse is armed to `gas_budget` *before* the call (the trip
    /// point is a pure function of the bytecode path); the `rng` is swapped in
    /// before and written back after (so the advanced stream position is what
    /// 04-03 snapshots); and every boundary value crosses as canonical JSON.
    pub fn run(&mut self, input_bytes: &[u8], state_json: &[u8], rng: &mut SimRng) -> FactoryOutcome {
        // 1. Decode untrusted input + state as UTF-8 behind a Result — never
        //    unwrap (Pitfall 4). A non-UTF-8 item faults before touching the
        //    engine or the rng, leaving prior state unchanged.
        let input_str = match std::str::from_utf8(input_bytes) {
            Ok(s) => s,
            Err(_) => {
                return early_fault(
                    state_json,
                    FaultReason::FactoryError,
                    b"input bytes are not valid UTF-8".to_vec(),
                );
            }
        };
        let state_str: String = match std::str::from_utf8(state_json) {
            Ok("") => "null".to_owned(),
            Ok(s) => s.to_owned(),
            Err(_) => {
                return early_fault(
                    state_json,
                    FaultReason::FactoryError,
                    b"state bytes are not valid UTF-8".to_vec(),
                );
            }
        };

        // 2. Reset the trip flag and the per-call collectors, and swap in the
        //    caller's rng substream so `ctx.random` draws from it. The fuse is armed
        //    INSIDE `run_inner`, AFTER the trusted per-tick environment is installed
        //    (so env setup is never charged to the user's budget); clearing
        //    `tripped` here as well means a stale trip from a prior call cannot leak
        //    into this call's classification if `run_inner` fails before it arms.
        self.tripped.set(false);
        self.emits.borrow_mut().clear();
        self.commands.borrow_mut().clear();
        *self.rng.borrow_mut() = rng.clone();

        // 3. Run the user entry inside the curated, fenced context.
        let inner = self.run_inner(input_str, &state_str);

        // 4. Write the advanced rng substream back to the caller (the draws that
        //    happened are reproducible; 04-03 snapshots this position).
        *rng = self.rng.borrow().clone();

        // 5. Assemble the outcome. On failure, disambiguate timeout vs error via
        //    the explicit `tripped` flag the interrupt handler sets when it forces
        //    an abort (NOT `budget == 0`, which a throw at exactly-exhausted budget
        //    would mislabel as a timeout — WR-02), discard partial effects, and
        //    roll persisted state back to its prior value.
        match inner {
            Ok(new_state) => {
                let (emits, refused) = self.drain_emits();
                FactoryOutcome {
                    emits,
                    commands: self.commands.borrow_mut().drain(..).collect(),
                    new_state_json: new_state.into_bytes(),
                    fault: None,
                    fault_message: Vec::new(),
                    refused,
                }
            }
            Err(message) => {
                let reason = if self.tripped.get() {
                    FaultReason::FactoryTimeout
                } else {
                    FaultReason::FactoryError
                };
                self.emits.borrow_mut().clear();
                self.commands.borrow_mut().clear();
                FactoryOutcome {
                    emits: Vec::new(),
                    commands: Vec::new(),
                    new_state_json: state_json.to_vec(),
                    fault: Some(reason),
                    fault_message: message.into_bytes(),
                    refused: BTreeMap::new(),
                }
            }
        }
    }

    /// The in-engine call: **build a FRESH context**, re-install the curated
    /// environment, re-declare + re-evaluate the user module inside it, build the
    /// per-call `ctx`, parse the input, invoke the user's `default(input, ctx)`, and
    /// read `ctx.state` back out — all behind a single `Result` caught at the
    /// boundary. Returns `Ok(new_state_json)` or `Err(error_message)`. The exception
    /// is retrieved and cleared via [`CatchResultExt::catch`]; the fresh context is
    /// dropped at the end of the call (after `with` returns).
    ///
    /// # Why a FRESH context every call (CR-01 / CR-02)
    /// A brand-new [`Context`] on the shared [`Runtime`] is built HERE, the curated
    /// environment is re-installed via [`install_env`], and the module is re-declared
    /// from [`source`](Self::source) — nothing is compiled once and reused — so:
    /// - the ENTIRE JS realm (globals, curated `Math`, every builtin prototype, the
    ///   `__fab_*` prelude functions, AND the module-record table) is recreated each
    ///   tick and dropped at call end, so NO mutable JS object — not a module-scope
    ///   `let`, not `globalThis.x`, not `Math.acc`, not `Object.prototype.n` — can
    ///   accumulate cross-tick state outside `ctx.state` (CR-01/CR-02 — the
    ///   shallow-freeze + module-accumulation snapshot/replay equivalence breaks);
    /// - the fuse is held UNMETERED only while the TRUSTED environment is installed,
    ///   then armed immediately before the user module is declared/evaluated, so the
    ///   module's **top-level statements run UNDER the armed fuse** and a top-level
    ///   `for(;;){}` trips the fuse to a `FactoryTimeout` instead of hanging the sim
    ///   (CR-01) — while env setup is never charged to the user's budget.
    ///
    /// The promise returned by `eval()` MUST be finished (driving module evaluation
    /// to completion) or the engine aborts (SIGABRT) — pinned by the 04-01 spike.
    fn run_inner(&self, input_str: &str, state_str: &str) -> Result<String, String> {
        // Hold the fuse UNMETERED while the fresh context is built + the trusted
        // environment is installed (none of which is user code), then arm it just
        // before the user module is declared/evaluated, below.
        self.budget.set(UNMETERED);
        let fresh = match Context::custom::<Curated>(&self._rt) {
            Ok(c) => c,
            Err(e) => return Err(format!("engine setup error: {e}")),
        };
        fresh.with(|ctx| {
            let attempt = (|| -> rquickjs::Result<String> {
                // Re-install the curated env into the fresh realm (UNMETERED).
                install_env(&ctx, &self.emits, &self.commands, &self.rng)?;
                // Arm the deterministic fuse NOW: everything below is user code (the
                // module's parse-validated top level + its `default`), so a runaway
                // trips the fuse instead of hanging (CR-01). `tripped` is (re)cleared
                // here so it reflects only this metered region.
                self.budget.set(self.gas_budget);
                self.tripped.set(false);
                let module = Module::declare(ctx.clone(), "factory", self.source.as_str())?;
                let (evaluated, promise) = module.eval()?;
                promise.finish::<()>()?;
                let entry: Function = evaluated.get("default")?;
                let make: Function = ctx.globals().get("__fab_make_ctx")?;
                let ctx_obj: Object = make.call((state_str,))?;
                let parse: Function = ctx.globals().get("__fab_parse")?;
                let input_val: Value = parse.call((input_str,))?;
                let _ret: Value = entry.call((input_val, ctx_obj.clone()))?;
                let state_val: Value = ctx_obj.get("state")?;
                let stringify: Function = ctx.globals().get("__fab_stringify")?;
                let new_state: String = stringify.call((state_val,))?;
                Ok(new_state)
            })();
            attempt.catch(&ctx).map_err(|e| e.to_string())
        })
    }

    /// Drain the emit collector into owned `(port, Item)` pairs in emission order, and
    /// the per-port counts of emits refused past the cap.
    fn drain_emits(&self) -> (Vec<(PortId, Item)>, BTreeMap<PortId, u32>) {
        let log = std::mem::take(&mut *self.emits.borrow_mut());
        let emits = log.recorded.into_iter().map(|(port, bytes)| (port, Item(bytes))).collect();
        (emits, log.refused)
    }

    /// Evaluate a probe expression in a freshly-built curated context, returning its
    /// value coerced to a string. Test-only: used to assert ambient-authority absence
    /// and the curated-`Math` surface without driving a full `run`. Builds the same
    /// per-tick environment `run_inner` does, so a probe sees exactly what user code
    /// sees each tick.
    #[cfg(test)]
    fn probe(&self, expr: &str) -> String {
        let ctx = Context::custom::<Curated>(&self._rt).expect("probe context builds");
        ctx.with(|ctx| {
            install_env(&ctx, &self.emits, &self.commands, &self.rng).expect("probe env installs");
            ctx.eval::<String, _>(expr).expect("probe expr evaluates to a string")
        })
    }

    /// The remaining fuse budget after the last call. Test-only: lets the WR-02
    /// regression assert the budget actually reached `0` (so the fault was
    /// classified by the explicit `tripped` flag, not by inference) while still
    /// proving a coincident throw is a `FactoryError`, not a `FactoryTimeout`.
    #[cfg(test)]
    fn budget_remaining(&self) -> u64 {
        self.budget.get()
    }
}

/// Build a fault outcome for a pre-engine failure (bad input/state bytes):
/// no emits/commands, prior state unchanged, the given reason + message.
fn early_fault(state_json: &[u8], reason: FaultReason, message: Vec<u8>) -> FactoryOutcome {
    FactoryOutcome {
        emits: Vec::new(),
        commands: Vec::new(),
        new_state_json: state_json.to_vec(),
        fault: Some(reason),
        fault_message: message,
        refused: BTreeMap::new(),
    }
}

/// The live, **non-serialized** engine cache: one compiled [`FactoryRuntime`] per
/// factory `NodeId`, held on `Core` behind `#[serde(skip)]` so only plain data
/// crosses the snapshot boundary (RESEARCH primary recommendation, threat T-04-SNAP).
///
/// # Clone returns an EMPTY cache (load-bearing)
/// `Core` derives `Clone`, but the live engine handles are `Arc`-shared (a derived
/// `Clone` would *share* one mutable engine across two `Core`s — a determinism
/// hazard, per the 04-01 Clone/Send finding). The cache is fully rebuildable from the
/// `Node::Factory` plain data, so cloning deliberately **forgets** it: a cloned (or
/// snapshot-restored) `Core` starts cold and rebuilds each engine lazily on the next
/// factory step. This is what keeps two `Core`s from ever sharing one engine.
#[derive(Default)]
pub struct FactoryRuntimeCache(BTreeMap<NodeId, FactoryRuntime>);

impl Clone for FactoryRuntimeCache {
    fn clone(&self) -> Self {
        // Intentionally empty: never deep-clone or share live engines — rebuild
        // lazily from plain data instead (see the type doc).
        Self(BTreeMap::new())
    }
}

impl FactoryRuntimeCache {
    /// Number of live engines currently cached (diagnostics / tests).
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// True when no engine is cached — the cold state after a clone/restore.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Drop the cached engine for `id`, forcing the next
    /// [`get_or_build`](Self::get_or_build) to rebuild it from the factory's CURRENT
    /// plain data (CFG-02, threat T-39-STALE-JS). Called by
    /// [`fold_configure`](crate::tick) after a `Configure` swaps a factory's
    /// `source`: the cache keys ONLY on [`NodeId`], so without this eviction a source
    /// swap would keep running the STALE compiled engine — a behavior AND
    /// replay-divergence hazard. The runtime is fully rebuildable from plain data
    /// (see the type doc), so dropping it is safe; evicting an absent id is a no-op.
    pub fn evict(&mut self, id: NodeId) {
        self.0.remove(&id);
    }

    /// Get the cached engine for `id`, lazily building it from the factory's plain
    /// data (source + gas budget + the default mem/stack fences) on a cold cache.
    /// Returns the build error (never panics) if the user source cannot compile —
    /// the caller turns that into a routed `FactoryError` fault, not a sim crash.
    fn get_or_build(
        &mut self,
        id: NodeId,
        source: &str,
        gas_budget: u64,
    ) -> Result<&mut FactoryRuntime, FactoryBuildError> {
        use std::collections::btree_map::Entry;
        match self.0.entry(id) {
            Entry::Occupied(e) => Ok(e.into_mut()),
            Entry::Vacant(e) => {
                let rt =
                    FactoryRuntime::build(source, gas_budget, DEFAULT_MEM_LIMIT, DEFAULT_STACK_LIMIT)?;
                Ok(e.insert(rt))
            }
        }
    }
}

/// The number of input items a factory processes per tick. Bounded to a fixed
/// constant so per-tick CPU never scales with inbox depth (WR-03 / CORE-07): each
/// JS `run` costs up to `gas_budget` interrupt callbacks, so draining a whole inbox
/// in one tick would do up to `N * gas_budget` callbacks for an unbounded `N` and
/// let one factory monopolize a tick. Mirroring the merge operator's one-item-per
/// -pass discipline, a factory takes at most [`FACTORY_ITEMS_PER_TICK`] item(s) and
/// re-wakes itself at `tick + 1` while a backlog remains (see [`step_factory`]).
/// The cap is a fixed constant (NOT data-dependent), so the per-tick item count is
/// deterministic and replay-safe.
const FACTORY_ITEMS_PER_TICK: u32 = 1;

/// The most emits one factory run may send on ONE output port (phase 87, JAM-05,
/// D-07, WINDOWS 165). The first emit per port leaves through the gate the fold already
/// cleared; the rest wait in [`Factory::pending_emits`](crate::state::Factory) and leave
/// one per step as the belt takes them. Bounded to a fixed constant so the queue a run can
/// build, and the drain work it costs, never scale with user code: 16 is the phase 71 cap
/// number, the same as `MECHANICAL_INBOX_CAP` and `SOURCE_PENDING_CAP`. The cap is a
/// fixed constant (NOT data-dependent), so the per-run queue bound is deterministic and
/// replay-safe.
///
/// Enforced at the emit primitive (`__fab_emit` in `install_env`): the first 16 emits per
/// port per run are kept, and each later one is not recorded and faults on its own, one
/// `FactoryError` whose sentence names the port and the cap, while the run's other effects
/// stand. The snapshot trust gate bounds the queue below the cap
/// (`StateInvariant::FactoryPendingEmits` refuses 16 or more, since plan 87-03): a run
/// leaves the first of its 16 at once, so at most 15 ever wait.
///
/// The cap counts EVERY port a run emits on, linked or not (87-REVIEW IN-02). Twenty emits
/// on a port with no link were twenty no-ops before plan 87-04; now the first 16 are no-ops
/// as before and the last four are `FactoryError` faults, so the Factory reads FAULTED. Kept
/// by D-07's wording ("one invocation's emits per port are capped"): a run that emits more
/// than 16 times on one port is told so, whether or not anything is docked there yet.
pub const FACTORY_EMITS_PER_PORT: usize = 16;

/// Drive a single [`Node::Factory`](crate::state::Node::Factory) for one tick: run
/// the sandboxed JS over a BOUNDED number of queued inputs and route the results
/// through the existing fold machinery. The fold (`tick::step_node`) calls this with
/// the node's inbox already taken out (split-borrow) and routes the populated
/// `outbox` through `links` afterwards exactly like any other node's output.
///
/// For each input item drained from input **port 0** (at most
/// [`FACTORY_ITEMS_PER_TICK`] per tick) it:
/// - lazily (re)builds the engine from the factory's plain data on a cold cache;
/// - calls [`FactoryRuntime::run`] with the item bytes + the node's current
///   `state_json` + a borrow of the node's per-node `SimRng`;
/// - pushes the FIRST `ctx.emit(port, data)` output per port onto the `outbox` so the
///   fold's deterministic output-routing carries it through links (never bypassing it),
///   queues each later one on a linked port in `Factory::pending_emits`, and faults each
///   emit past [`FACTORY_EMITS_PER_PORT`] on its own (phase 87, JAM-05, D-07);
/// - enqueues each `ctx.command` intent as a [`Command`] (`Effect::Noop` — the real
///   executor is Phase 5; this exercises only the seam) stamped with a deterministic
///   `(tick, node, per-call seq)` id and a `now + offset` deadline;
/// - writes the advanced `new_state_json` + `SimRng` back into the node's plain data;
/// - on a fault pushes `Fault::factory(node, reason, message).encode()` onto the
///   reserved [`FAULT_PORT`], so the fold delivers it like any other output (an
///   unwired fault port drops via the existing missing-link no-op — never a panic).
///
/// # Bounded per-tick work + re-wake (WR-03 / CORE-07, mirrors the merge operator)
/// At most [`FACTORY_ITEMS_PER_TICK`] item(s) are processed per call; while input
/// **port 0** still holds a backlog afterward, the factory re-wakes itself at a
/// **strictly-future** `now + 1` through `sched` (NOT `now`, which is promoted to a
/// same-tick fixpoint re-entry and would drain faster than the cap). A fully drained
/// factory schedules no wake and sleeps (CORE-07). This bounds per-tick CPU by a
/// constant regardless of how deep an upstream tee/source floods the inbox, honoring
/// the bounded-active-set-work invariant the merge operator already upholds
/// (`state::Merge`, `merge::Machine::step`). It is deterministic — the item cap is a
/// fixed constant, the re-wake gate is a pure inbox read — so replay is unaffected.
///
/// **Panic-free** (threat T-04-FOLD): `run` returns faults instead of panicking, and a
/// cold-cache build failure becomes a `FactoryError` fault for the processed input(s)
/// (the same bounded one-per-tick discipline, re-waking while a backlog remains).
///
/// # `port_zero_is_electrical`: what makes a delivery a wire request
/// The caller passes the DECLARED medium of this node's inbox port 0, read once from
/// the snapshot by [`crate::admit::inbox_class`] BEFORE the node borrow is taken
/// (`tick::step_node`, ruling R-22). It is a `Copy` scalar rather than a `&GridState`
/// or a `&[Port]` because the fold holds `&mut core.state` across the whole match
/// block, so no borrow of state can cross this seam. It is read by the HOST side of
/// the sandbox seam and is never exposed to JS.
///
/// # `linked_out_ports`: which emits may wait
/// The caller passes the output ports this Factory has a link from (its `FAULT_PORT`
/// excluded), read once from `GridState::links_from(id)` BEFORE the node borrow, as an
/// owned set: the same ruling R-22 shape as `port_zero_is_electrical`, so no borrow of
/// state crosses this seam. Only those ports queue a run's later emits (JAM-05, D-07).
///
/// # Golden-rule capability model preserved
/// The factory is special-cased (not driven through the `Machine` trait) only because
/// it needs the Core-level runtime cache, which `StepCtx` deliberately does not expose.
/// User code still reaches the world ONLY through the injected `ctx` (emit/command/
/// random/state) — never sim internals. The `sched` borrow is used ONLY to re-wake
/// *this* node (self-targeting), exactly like `StepCtx::schedule_wake`.
#[allow(clippy::too_many_arguments)]
pub fn step_factory(
    now: u64,
    id: NodeId,
    factory: &mut Factory,
    cache: &mut FactoryRuntimeCache,
    inbox: &mut PortInbox,
    port_zero_is_electrical: bool,
    linked_out_ports: &BTreeSet<PortId>,
    outbox: &mut PortOutbox,
    commands: &mut Vec<Command>,
    sched: &mut Scheduler,
) {
    // THE QUEUE LEAVES FIRST, AND WHILE IT HOLDS ANYTHING NO INPUT IS TAKEN (phase 87,
    // JAM-05, D-07, WINDOWS 165). The fold's output gate (`tick::outputs_blocked`) clears
    // ONE item per linked output port before this step runs. A run that emits twice on one
    // port used to push both, and under load the second was refused at the outbox drain
    // and became an `OutputRefused` dead letter on this Factory's fault port (P165: 347 of
    // 1200 delivered). So a run's FIRST emit per port leaves through the gate it was given
    // and the rest wait here, in `Factory::pending_emits`, and leave one per port per step.
    //
    // A step whose queue is not empty pushes the front item of each queued port and
    // RETURNS without taking an input. That is back-pressure like the six machines phase
    // 71 gated: the Factory stops consuming while its outputs owe items, so its inbox and
    // the belt in front of it pack backwards instead of the Factory running ahead of what
    // its belts can carry. An emptied queue is removed from the map, never left empty (the
    // trust gate refuses an empty one). The queue is plain snapshot state, appended by
    // plan 87-03's one SNAPSHOT bump, so a save taken mid-queue restores it.
    if !factory.pending_emits.is_empty() {
        drain_pending_emits(factory, outbox);
        // Re-wake at a strictly-future tick while the queue or the port-0 inbox still
        // holds work (the same `now + 1` rule as the backlog re-wake below).
        if !factory.pending_emits.is_empty() || inbox.has_on(0) {
            sched.schedule_wake(id, now + 1);
        }
        return;
    }

    // A per-call sequence making each command's (tick, node, seq) id unique within
    // this tick for this node, across every drained item.
    let mut cmd_seq: u32 = 0;

    match cache.get_or_build(id, &factory.source, factory.gas_budget) {
        Ok(runtime) => {
            // Process up to FACTORY_ITEMS_PER_TICK items from port 0 (FIFO), then
            // re-wake while a backlog remains — bounded per-tick work (WR-03).
            // A run that left emits waiting ends the slice: the next input waits for the
            // queue.
            for _ in 0..FACTORY_ITEMS_PER_TICK {
                if !factory.pending_emits.is_empty() {
                    break;
                }
                let Some((_event_seq, item)) = inbox.take(0) else {
                    break;
                };
                // WHAT MAKES THIS DELIVERY A WIRE REQUEST: the DECLARED MEDIUM of
                // this node's inbox port 0, and nothing about the bytes (D-16). If port
                // 0 is declared `Medium::Electrical` the item is an opaque
                // `WireEnvelope` the wire fold delivered (a serviced request, WIRE-04),
                // so it is UNWRAPPED: the JS handler runs on the request's inner
                // `payload` (the real request body) and its `correlation` is recovered
                // so any command the handler emits WHILE servicing this item resolves as
                // an `Effect::Reply` reverse-routed to the caller by the fold
                // (`tick::route_replies`). The envelope's correlation/return_addr/budget
                // are TRANSPORT metadata the host strips: they never reach user JS. If
                // port 0 is Mechanical, or the node declares NO PORTS AT ALL, the item is
                // never treated as an envelope and the whole bytes are the JS input.
                //
                // WHAT WAS DELETED HERE, AND WHY, so a reader looking for the old
                // mechanism finds an account rather than a silence. Until phase 72 the
                // discriminator was a structural byte sniff,
                // `decode(&item).ok().filter(|env| env.encode() == item)`: a CANONICAL
                // round-trip applied with no reference to any port. That guard was
                // PROBABILISTIC. An ordinary belt item whose bytes merely HAPPEN to be a
                // canonical envelope encoding was reinterpreted as transport (payload
                // stripped, an `Effect::Reply` emitted instead of the muted
                // `Effect::Noop`), which is a confused deputy;
                // `crates/fabrico-core/tests/factory_medium.rs` builds exactly such an
                // item and proves it. The comment that stood here named its own successor
                // in as many words, "a `Medium::Electrical` tag on the delivering port",
                // and this is that successor. The round-trip filter is GONE rather than
                // kept beside this rule (D-17): two discriminators that can disagree are
                // worse than either alone, because nothing then says which one shipped.
                //
                // AN ELECTRICAL PORT 0 DELIVERED BYTES THAT DO NOT DECODE DROPS THEM,
                // WITH NO FAULT, and never enters the sandbox (D-17, SERVE-09). Raw
                // transport bytes are not user input, and this repository's own precedent
                // for a malformed envelope is a DROP rather than a fault (the wire
                // ingest's own malformed-delivery drop in `tick.rs`). `decode()` ALONE
                // decides now. It is total over malformed bytes (never a panic) and it
                // touches NO serialized shape: an in-memory host bridge only.
                //
                // ONE READING, SHARED WITH THE CAP SITE, AND THE OTHER CLASSIFIER ANSWERS
                // A DIFFERENT QUESTION (rulings R-3, R-6, R-23). `port_zero_is_electrical`
                // reaches this function from [`crate::admit::inbox_class`], the same
                // predicate the mechanical inbox cap and the load gauge read, so no second
                // reading of "is this port electrical" is minted in this crate. It is
                // deliberately NOT [`crate::admit::admit_class`], which layers an EMITTER
                // clause on top of that predicate (any delivery whose emitter is a
                // `Node::Wire` reads Electrical). That clause is the right answer to "may
                // this delivery exceed the inbox cap" and the WRONG answer to "is this
                // machine a handler": under it a port-less Factory would become
                // serviceable merely because its feeder is a wire.
                let serviced = if port_zero_is_electrical {
                    match crate::wire::WireEnvelope::decode(&item) {
                        Ok(env) => Some(env),
                        // Dropped, no fault, no sandbox entry. `continue` takes the next
                        // item rather than falling through to `runtime.run`.
                        Err(_) => continue,
                    }
                } else {
                    None
                };
                // THE ENVELOPE IS THE RECORD OF WHO ASKED (Phase 72 plan 04). All three
                // values a reply needs (the correlation it answers, the caller's reply
                // ADDRESS, and the request's REMAINING budget) are read off the ONE
                // `WireEnvelope` this delivery arrived in. None of them is re-derived
                // from a second place: a second derivation would be a second source of
                // truth for the one fact the reply exists to carry, and the mechanism
                // this replaces (`tick.rs`'s per-tick correlation scratch map) was
                // exactly that second source, rebuilt EMPTY every tick and silently
                // losing every reply emitted on a later tick than its request's hop.
                let serviced_reply: Option<(u64, (NodeId, PortId), u64)> =
                    serviced.as_ref().map(|env| (env.correlation, env.return_addr, env.budget));
                let js_input: &[u8] = match &serviced {
                    Some(env) => &env.payload.0,
                    None => &item.0,
                };
                let outcome = runtime.run(js_input, &factory.state_json, &mut factory.rng);

                // Write the advanced ctx.state back (unchanged on fault — run rolls
                // it back) so it rides the whole-Core snapshot.
                factory.state_json = outcome.new_state_json;

                // Route emits through the outbox → the fold's deterministic routing: the
                // FIRST emit per port now (the one the gate cleared), the rest queued on
                // `pending_emits` to leave one per step (JAM-05, D-07; see the head of this
                // function).
                route_emits(factory, outcome.emits, linked_out_ports, outbox);

                // EACH EMIT PAST THE PER-PORT CAP IS ITS OWN FAULT (JAM-05, D-07, T-87-11).
                // One `FactoryError` per refused emit on `FAULT_PORT`, whose sentence names
                // the port and the cap, so the Factory reads FAULTED on this tick and every
                // refused emit is carried down a docked fault belt or counted on
                // `Factory::faults`, never lost without a trace. Empty on a faulted run.
                for (&port, &n) in &outcome.refused {
                    for _ in 0..n {
                        let fault = Fault::factory(id, FaultReason::FactoryError, emit_cap_sentence(port));
                        outbox.push(FAULT_PORT, fault.encode());
                    }
                }

                // Enqueue command intents on the Command seam. When this item is a
                // serviced wire request (37-03), a command carries the handler's computed
                // result BACK to the caller as `Effect::Reply { correlation, payload }` —
                // the payload riding as opaque `Item` bytes (the canonical-JSON effect
                // descriptor, the same encoding sinks use for `Effect::Http.body`), so NO
                // instanced serialized shape is touched (`CommandIntent`/`Item`/the
                // Factory fields are all unchanged; the seam is in-memory host-bridge code
                // only). Otherwise the intent stays the muted `Effect::Noop` (real I/O is
                // Phase 5). The JS-supplied deadline is a relative offset from `now`.
                for intent in outcome.commands {
                    let CommandIntent { effect_json, deadline } = intent;
                    let effect = match serviced_reply {
                        Some((correlation, return_addr, budget)) => Effect::Reply {
                            correlation,
                            payload: Item(effect_json),
                            // Both taken from the serviced envelope above. `budget` is the
                            // REMAINING budget as the request reached this handler, so the
                            // reply inherits it and the whole forward+return round trip is
                            // bounded by ONE budget.
                            return_addr,
                            budget,
                        },
                        None => Effect::Noop,
                    };
                    commands.push(Command {
                        event_version: EVENT_VERSION,
                        id: (now, id, cmd_seq),
                        partition: 0,
                        effect,
                        deadline: now.saturating_add(deadline),
                    });
                    cmd_seq += 1;
                }

                // A fault rides the reserved FAULT_PORT exactly like any other
                // output; the fold's existing routing delivers or drops it.
                if let Some(reason) = outcome.fault {
                    let fault = Fault::factory(id, reason, outcome.fault_message);
                    outbox.push(FAULT_PORT, fault.encode());
                }
            }
        }
        Err(build_err) => {
            // The engine could not compile from the node's plain data: fault the
            // processed input(s) with a FactoryError carrying the build message,
            // rather than panicking the sim (threat T-04-FOLD). Bounded the same way
            // (one per tick, re-wake on backlog) so a flooded build-error factory
            // cannot monopolize a tick either. ctx.state is left unchanged (no run).
            let message = build_err.message().as_bytes().to_vec();
            for _ in 0..FACTORY_ITEMS_PER_TICK {
                if inbox.take(0).is_none() {
                    break;
                }
                let fault = Fault::factory(id, FaultReason::FactoryError, message.clone());
                outbox.push(FAULT_PORT, fault.encode());
            }
        }
    }

    // Re-wake at a strictly-future tick while input port 0 still has a backlog, so
    // the next bounded slice runs next tick (WR-03, mirroring `merge`'s tick+1
    // re-wake), or while this run left emits waiting (JAM-05: they leave one per port
    // per step). A drained factory schedules nothing and sleeps (CORE-07). `now + 1`
    // is always strictly future, so it lands on the wake wheel (never a same-tick
    // fixpoint re-entry that would exceed the per-tick cap).
    if inbox.has_on(0) || !factory.pending_emits.is_empty() {
        sched.schedule_wake(id, now + 1);
    }
}

/// Route one run's emits (phase 87, JAM-05, D-07). Per port, in emission order: the FIRST
/// emit goes to the `outbox`, through the one-item clearance the fold's output gate gave
/// that port; each later emit on a port in `linked_out_ports` is appended to that port's
/// queue in [`Factory::pending_emits`]; a later emit on a port no link names is dropped,
/// exactly as the drain drops the first one there (an emit on an unlinked port has always
/// been a no-op at the fold's missing-link arm). Only linked ports queue, so the queue is
/// bounded by the Factory's links, and the snapshot trust gate's rule (no queue on a port
/// without a link) holds when the step ends.
fn route_emits(
    factory: &mut Factory,
    emits: Vec<(PortId, Item)>,
    linked_out_ports: &BTreeSet<PortId>,
    outbox: &mut PortOutbox,
) {
    let mut sent: BTreeSet<PortId> = BTreeSet::new();
    for (port, out_item) in emits {
        if sent.insert(port) {
            outbox.push(port, out_item);
        } else if linked_out_ports.contains(&port) {
            factory.pending_emits.entry(port).or_default().push_back(out_item);
        }
    }
}

/// The sentence a refused emit's `FactoryError` carries (phase 87, JAM-05, D-07): it names
/// the port and the cap.
fn emit_cap_sentence(port: PortId) -> Vec<u8> {
    format!(
        "ctx.emit: port {port} already had {FACTORY_EMITS_PER_PORT} emits in this run, the most one run may send on a port; this emit was not sent"
    )
    .into_bytes()
}

/// Push the front item of every queued port to the `outbox`, one per port, in ascending
/// port order (the `BTreeMap`'s own order), and remove each queue this empties (phase 87,
/// JAM-05, D-07). One per port is exactly what the fold's output gate cleared.
fn drain_pending_emits(factory: &mut Factory, outbox: &mut PortOutbox) {
    for (&port, queue) in factory.pending_emits.iter_mut() {
        if let Some(item) = queue.pop_front() {
            outbox.push(port, item);
        }
    }
    factory.pending_emits.retain(|_, queue| !queue.is_empty());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a runtime with the default fences, asserting success.
    fn rt(source: &str) -> FactoryRuntime {
        FactoryRuntime::build_default(source).expect("well-formed source builds")
    }

    /// A trivial valid factory module (used where the body is irrelevant).
    const NOOP_SRC: &str = "export default function (input, ctx) { return input; }";

    #[test]
    fn build_succeeds_for_well_formed_source() {
        // A well-formed `export default function` module compiles without panic.
        let _ = rt(NOOP_SRC);
    }

    #[test]
    fn build_bad_source_returns_err_not_panic() {
        // An un-compilable source returns a typed FactoryBuildError, never a
        // panic and never a SIGABRT (the promise-finish discipline holds).
        // (Matched rather than `expect_err` because FactoryRuntime is
        // deliberately not Debug — its handles must not be casually formatted.)
        match FactoryRuntime::build_default("export default function (") {
            Ok(_) => panic!("syntactically invalid source must not build"),
            Err(err) => assert!(
                !err.message().is_empty(),
                "build error carries a diagnostic message"
            ),
        }
    }

    #[test]
    fn ambient_authority_is_withheld() {
        // FACT-02 (context-level): the ambient-authority and nondeterministic
        // globals are all `undefined` in the curated context.
        let r = rt(NOOP_SRC);
        for global in ["Date", "fetch", "setTimeout", "setInterval", "process", "require"] {
            assert_eq!(
                r.probe(&format!("typeof {global}")),
                "undefined",
                "{global} must be absent from the sandbox"
            );
        }
        // Math.random (ambient gettimeofday xorshift) is withheld by curation.
        assert_eq!(r.probe("typeof Math.random"), "undefined", "Math.random withheld");
    }

    #[test]
    fn transcendental_math_is_withheld() {
        // FACT-02 (determinism): every platform-libm transcendental is withheld,
        // so a factory cannot leak cross-platform-divergent math.
        let r = rt(NOOP_SRC);
        for member in [
            "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "exp", "expm1", "log", "log1p",
            "log2", "log10", "pow", "cbrt", "hypot", "sinh", "cosh", "tanh", "asinh", "acosh",
            "atanh", "random",
        ] {
            assert_eq!(
                r.probe(&format!("typeof Math.{member}")),
                "undefined",
                "transcendental/random Math.{member} must be withheld"
            );
        }
    }

    // ── Task 3: FactoryRuntime::run — the FACT-01..04 behavior suite ───────────

    /// Build with a custom gas budget (default mem/stack), asserting success.
    fn rt_budget(source: &str, gas_budget: u64) -> FactoryRuntime {
        FactoryRuntime::build(source, gas_budget, DEFAULT_MEM_LIMIT, DEFAULT_STACK_LIMIT)
            .expect("well-formed source builds")
    }

    /// Run `source` once over `input`/`state` with a fresh `seed`ed substream.
    fn run_once(source: &str, input: &[u8], state: &[u8], seed: u64) -> FactoryOutcome {
        let mut r = rt(source);
        let mut rng = SimRng::from_seed_u64(seed);
        r.run(input, state, &mut rng)
    }

    #[test]
    fn runs_user_js_and_emits() {
        // FACT-01: the factory receives `input` and emits a transformed value
        // through `ctx.emit`; the payload is the canonical JSON of the result.
        let out = run_once(
            "export default function (input, ctx) { ctx.emit(0, input * 2); }",
            b"21",
            b"{}",
            1,
        );
        assert_eq!(out.fault, None, "a clean run does not fault");
        assert_eq!(out.emits, vec![(0u16, Item(b"42".to_vec()))], "emit(0, 21*2) == 42");
        assert!(out.commands.is_empty());
    }

    #[test]
    fn ctx_emit_records_port_and_canonical_json() {
        // ctx.emit captures (port, JSON.stringify(data)) in emission order, for
        // arbitrary ports and structured payloads.
        let out = run_once(
            "export default function (i, ctx) { ctx.emit(0, {a:1,b:[2,3]}); ctx.emit(7, \"hi\"); }",
            b"null",
            b"{}",
            1,
        );
        assert_eq!(out.fault, None);
        assert_eq!(
            out.emits,
            vec![
                (0u16, Item(b"{\"a\":1,\"b\":[2,3]}".to_vec())),
                (7u16, Item(b"\"hi\"".to_vec())),
            ],
            "emits preserve port + canonical JSON + order"
        );
    }

    /// A module that emits `n` times on each port in `ports`, the loop index as the item.
    fn emit_n_src(ports: &[u16], n: u32) -> String {
        format!(
            "export default function (input, ctx) {{ ctx.state.n = 7; for (const p of {ports:?}) {{ for (let i = 0; i < {n}; i++) {{ ctx.emit(p, i); }} }} }}"
        )
    }

    /// The items `0..n` as canonical JSON, all on `port`.
    fn numbered(port: PortId, n: u32) -> Vec<(PortId, Item)> {
        (0..n).map(|i| (port, Item(i.to_string().into_bytes()))).collect()
    }

    #[test]
    fn ctx_emit_sixteen_on_one_port_is_accepted() {
        // Phase 87, JAM-05, D-07: FACTORY_EMITS_PER_PORT (16) emits on one port in one run
        // are all recorded, in emission order, and none is refused.
        let out = run_once(&emit_n_src(&[0], 16), b"null", b"{}", 1);
        assert_eq!(out.fault, None);
        assert_eq!(out.emits, numbered(0, 16), "all 16 recorded in emission order");
        assert!(out.refused.is_empty(), "sixteen on one port refuses nothing");

        // Routed by the fold on a board whose Out 0 is linked: one leaves, 15 wait, and the
        // board saves and reopens (the trust gate refuses a queue of 16 or more).
        let mut core = crate::core::Core::genesis(crate::event::LogHeader {
            schema_version: crate::event::SCHEMA_VERSION,
            seed: 0x87_0416,
        });
        let f = core.state.add_factory(emit_n_src(&[0], 16), DEFAULT_GAS_BUDGET, 7);
        let c = core.state.add_source();
        core.state.link((f, 0), (c, 0));
        core.advance(&[crate::event::Event {
            schema_version: crate::event::SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            payload: crate::event::EventPayload::Input { target: f, port: 0, item: Item(b"1".to_vec()) },
        }]);
        let delivered = core.state.inbox_of(c).map_or(0, |i| i.len_on(0));
        let queued: Vec<(PortId, usize)> = match core.state.node(f) {
            Some(crate::state::Node::Factory(fac)) => fac.pending_emits.iter().map(|(&p, q)| (p, q.len())).collect(),
            _ => panic!("the Factory exists"),
        };
        assert_eq!((delivered, queued), (1, vec![(0, 15)]), "one out, fifteen wait on Out 0");
        assert!(
            crate::snapshot::restore(&crate::snapshot::snapshot(&core)).is_ok(),
            "a queue of fifteen saves and reopens"
        );
    }

    #[test]
    fn ctx_emit_past_the_per_port_cap_faults_only_the_surplus() {
        // Phase 87, JAM-05, D-07: 20 emits on port 0 in one run. The run does NOT fault:
        // the first 16 are recorded in emission order, the 4 past the cap are counted on
        // port 0 and not recorded, and `ctx.state` is the state the run returned.
        let out = run_once(&emit_n_src(&[0], 20), b"null", b"{}", 1);
        assert_eq!(out.fault, None, "an emit past the cap is not a fault of the run");
        assert_eq!(out.emits, numbered(0, 16), "the first 16 are kept, in emission order");
        assert_eq!(out.refused, BTreeMap::from([(0u16, 4u32)]), "the 4 past the cap are counted on port 0");
        assert_eq!(out.new_state_json, b"{\"n\":7}".to_vec(), "ctx.state is kept");
    }

    #[test]
    fn ctx_emit_cap_is_per_port() {
        // Phase 87, JAM-05, D-07: 16 on port 0 and 16 on port 1 in one run are all
        // recorded: the cap counts each port on its own.
        let out = run_once(&emit_n_src(&[0, 1], 16), b"null", b"{}", 1);
        assert_eq!(out.fault, None);
        let mut want = numbered(0, 16);
        want.extend(numbered(1, 16));
        assert_eq!(out.emits, want, "all 32 recorded");
        assert!(out.refused.is_empty(), "the cap is per port, so nothing is refused");
    }

    #[test]
    fn ctx_command_records_intent() {
        // ctx.command(effect, deadline) records a CommandIntent (canonical-JSON
        // effect + tick deadline) for the fold to map onto the Command seam.
        let out = run_once(
            "export default function (i, ctx) { ctx.command({kind:\"http\"}, 99); }",
            b"null",
            b"{}",
            1,
        );
        assert_eq!(out.fault, None);
        assert_eq!(
            out.commands,
            vec![CommandIntent { effect_json: b"{\"kind\":\"http\"}".to_vec(), deadline: 99 }],
            "command intent carries the canonical effect JSON + deadline"
        );
    }

    #[test]
    fn ctx_state_rehydrates_and_persists() {
        // ctx.state is rehydrated from the passed state bytes, mutated by the
        // factory, and read back out as the new canonical state — the SOLE
        // cross-tick state (criterion-5 substrate).
        let src =
            "export default function (input, ctx) { ctx.state.count = (ctx.state.count || 0) + input; ctx.emit(0, ctx.state.count); }";
        let mut r = rt(src);
        let mut rng = SimRng::from_seed_u64(1);

        let first = r.run(b"5", b"{}", &mut rng);
        assert_eq!(first.fault, None);
        assert_eq!(first.new_state_json, b"{\"count\":5}".to_vec(), "state accumulates to 5");
        assert_eq!(first.emits, vec![(0u16, Item(b"5".to_vec()))]);

        // Feed the new state back in: the count carries across the tick boundary.
        let second = r.run(b"3", &first.new_state_json, &mut rng);
        assert_eq!(second.new_state_json, b"{\"count\":8}".to_vec(), "5 + 3 == 8");
        assert_eq!(second.emits, vec![(0u16, Item(b"8".to_vec()))]);
    }

    #[test]
    fn ambient_authority_withheld() {
        // FACT-02: at call time Date/fetch/setTimeout/Math.random/Math.sin are all
        // undefined, AND ctx.random() is seeded-deterministic — the same seed +
        // same source twice yields byte-identical emitted JSON.
        // The emitted object includes a seed-DEPENDENT integer (`rv`) derived
        // from ctx.random so two different seeds produce different JSON bytes, and
        // a boolean confirming the [0,1) range — all computed in JS (no float
        // crosses into Rust).
        let src = "export default function (input, ctx) { \
            var r = ctx.random(); \
            ctx.emit(0, { \
                date: typeof Date, fetch: typeof fetch, st: typeof setTimeout, \
                rand: typeof Math.random, sin: typeof Math.sin, \
                r_in_unit: (r >= 0 && r < 1), \
                rv: Math.floor(r * 1000000000) \
            }); }";

        let a = run_once(src, b"null", b"{}", 42);
        let b = run_once(src, b"null", b"{}", 42);
        assert_eq!(a.fault, None);
        assert_eq!(a.emits, b.emits, "same seed + same source => byte-identical emit (seeded)");

        let bytes = &a.emits[0].1.0;
        let text = String::from_utf8_lossy(bytes);
        for absent in ["\"date\":\"undefined\"", "\"fetch\":\"undefined\"", "\"st\":\"undefined\"", "\"rand\":\"undefined\"", "\"sin\":\"undefined\""] {
            assert!(text.contains(absent), "expected {absent} in {text}");
        }
        assert!(text.contains("\"r_in_unit\":true"), "ctx.random() lies in [0,1): {text}");

        // A different seed diverges (guards against the seed being ignored).
        let c = run_once(src, b"null", b"{}", 7);
        assert_ne!(a.emits, c.emits, "different seed => different ctx.random draw");
    }

    #[test]
    fn ctx_random_int_in_range_and_deterministic() {
        // ctx.randomInt(lo, hi) returns integers in [lo, hi); the JS asserts the
        // range so no float crosses into Rust. Same seed twice is identical.
        let src = "export default function (i, ctx) { \
            var ok = true; \
            for (var k = 0; k < 200; k++) { var v = ctx.randomInt(5, 10); if (v < 5 || v >= 10 || Math.floor(v) !== v) ok = false; } \
            ctx.emit(0, ok); }";
        let a = run_once(src, b"null", b"{}", 3);
        let b = run_once(src, b"null", b"{}", 3);
        assert_eq!(a.fault, None);
        assert_eq!(a.emits, vec![(0u16, Item(b"true".to_vec()))], "all draws in [5,10)");
        assert_eq!(a.emits, b.emits, "randomInt is seeded-deterministic");
    }

    #[test]
    fn denied_global_faults() {
        // FACT-02/04: referencing a withheld global (Math.sin) throws a TypeError
        // that becomes a FactoryError fault — never a panic.
        let out = run_once(
            "export default function (input, ctx) { ctx.emit(0, Math.sin(input)); }",
            b"1",
            b"{}",
            1,
        );
        assert_eq!(out.fault, Some(FaultReason::FactoryError), "withheld global => FactoryError");
        assert!(out.emits.is_empty(), "partial emits discarded on fault");
        assert!(!out.fault_message.is_empty(), "error message carried for the dead-letter payload");
    }

    #[test]
    fn within_budget_completes() {
        // FACT-03: a bounded loop under budget completes with no false trip.
        let out = run_once(
            "export default function (input, ctx) { var s = 0; for (var i = 0; i < 1000; i++) { s += i; } ctx.emit(0, s); }",
            b"null",
            b"{}",
            1,
        );
        assert_eq!(out.fault, None, "within-budget work must not false-trip the fuse");
        assert_eq!(out.emits, vec![(0u16, Item(b"499500".to_vec()))]);
    }

    #[test]
    fn fuse_bounds_runaway() {
        // FACT-03: an infinite loop trips the deterministic fuse to FactoryTimeout
        // and run() RETURNS (no hang). The same source + budget trips identically
        // across repeated runs, and the context stays reusable after an abort.
        let mut r = rt_budget("export default function (input, ctx) { while (true) {} }", 32);
        let mut rng = SimRng::from_seed_u64(1);

        let first = r.run(b"null", b"{}", &mut rng);
        assert_eq!(first.fault, Some(FaultReason::FactoryTimeout), "runaway => FactoryTimeout");
        assert!(first.emits.is_empty());

        // Reproducible AND the engine survived the abort (a poisoned context would
        // not produce the same clean trip on the second run).
        let second = r.run(b"null", b"{}", &mut rng);
        assert_eq!(second.fault, Some(FaultReason::FactoryTimeout), "fuse trips identically on replay");
    }

    #[test]
    fn engine_reusable_after_fuse_trip() {
        // A factory that loops only when asked: prove the context still runs a
        // normal call after a prior call tripped the fuse (compile-once reuse).
        let mut r = rt_budget(
            "export default function (input, ctx) { if (input) { while (true) {} } ctx.emit(0, 1); }",
            32,
        );
        let mut rng = SimRng::from_seed_u64(1);

        let tripped = r.run(b"true", b"{}", &mut rng);
        assert_eq!(tripped.fault, Some(FaultReason::FactoryTimeout));

        let ok = r.run(b"false", b"{}", &mut rng);
        assert_eq!(ok.fault, None, "context reusable after a fuse abort");
        assert_eq!(ok.emits, vec![(0u16, Item(b"1".to_vec()))]);
    }

    #[test]
    fn throw_routes_fault() {
        // FACT-04: an uncaught JS throw surfaces as a FactoryError carrying the
        // error message bytes (for the fold to stamp into the Fault payload).
        let out = run_once(
            "export default function (input, ctx) { throw new Error(\"boom\"); }",
            b"null",
            b"{}",
            1,
        );
        assert_eq!(out.fault, Some(FaultReason::FactoryError), "throw => FactoryError");
        let msg = String::from_utf8_lossy(&out.fault_message);
        assert!(msg.contains("boom"), "the JS error message is carried: {msg}");
    }

    #[test]
    fn timeout_vs_error_reason_are_distinct() {
        // FACT-04: the runaway case yields FactoryTimeout; the throw case yields
        // FactoryError — the budget-cell disambiguation gives distinct reasons.
        let timeout = {
            let mut r = rt_budget("export default function (i, ctx) { while (true) {} }", 32);
            let mut rng = SimRng::from_seed_u64(1);
            r.run(b"null", b"{}", &mut rng).fault
        };
        let error = run_once(
            "export default function (i, ctx) { throw new Error(\"x\"); }",
            b"null",
            b"{}",
            1,
        )
        .fault;
        assert_eq!(timeout, Some(FaultReason::FactoryTimeout));
        assert_eq!(error, Some(FaultReason::FactoryError));
        assert_ne!(timeout, error, "timeout and error are distinct fault reasons");
    }

    #[test]
    fn bad_input_bytes_fault_not_panic() {
        // Pitfall 4 / Security V5: untrusted item bytes that are not valid JSON
        // (or not valid UTF-8) fault rather than panicking the deterministic core.
        // Valid UTF-8 but not JSON: JSON.parse throws inside the engine.
        let not_json = run_once(
            "export default function (input, ctx) { ctx.emit(0, input); }",
            b"this is not json",
            b"{}",
            1,
        );
        assert_eq!(not_json.fault, Some(FaultReason::FactoryError), "non-JSON input => fault");
        assert!(not_json.emits.is_empty());

        // Not even valid UTF-8: refused before the engine is touched.
        let not_utf8 = run_once(
            "export default function (input, ctx) { ctx.emit(0, input); }",
            &[0xff, 0xfe, 0x00],
            b"{}",
            1,
        );
        assert_eq!(not_utf8.fault, Some(FaultReason::FactoryError), "non-UTF8 input => fault");
        assert!(not_utf8.emits.is_empty());
    }

    #[test]
    fn fault_rolls_back_state_unchanged() {
        // A faulted tick does not mutate persisted state: the outcome carries the
        // prior state bytes back unchanged (so the node's snapshot is stable).
        let out = run_once(
            "export default function (input, ctx) { ctx.state.touched = true; throw new Error(\"late\"); }",
            b"null",
            b"{\"count\":1}",
            1,
        );
        assert_eq!(out.fault, Some(FaultReason::FactoryError));
        assert_eq!(out.new_state_json, b"{\"count\":1}".to_vec(), "state rolled back on fault");
    }

    #[test]
    fn curated_math_members_and_constants_are_present() {
        // The bit-exact / correctly-rounded members and the numeric constants
        // survive curation (typeof function / number respectively).
        let r = rt(NOOP_SRC);
        for method in [
            "floor", "ceil", "round", "trunc", "abs", "sign", "min", "max", "sqrt", "fround",
            "clz32", "imul",
        ] {
            assert_eq!(
                r.probe(&format!("typeof Math.{method}")),
                "function",
                "deterministic Math.{method} must be present"
            );
        }
        for konst in ["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"] {
            assert_eq!(
                r.probe(&format!("typeof Math.{konst}")),
                "number",
                "numeric constant Math.{konst} must be present"
            );
        }
        // And they still compute (sqrt is IEEE-754 correctly rounded).
        assert_eq!(r.probe("String(Math.floor(3.9))"), "3");
        assert_eq!(r.probe("String(Math.sqrt(16))"), "4");
    }

    // ── CR-01: untrusted TOP-LEVEL module code is metered (no build/run hang) ──

    #[test]
    fn top_level_infinite_loop_trips_the_fuse_not_hangs() {
        // CR-01 (BLOCKER): a module whose TOP-LEVEL is `for(;;){}` must trip the
        // deterministic gas fuse and return a FactoryTimeout — NOT hang the sim.
        // Under the old "eval at build, unmetered" path this hung at construction;
        // now build only PARSES (never evals) and the top-level runs per call UNDER
        // the armed fuse, so the runaway loop trips and run() RETURNS.
        let mut r = rt_budget(
            "for (;;) {}\nexport default function (input, ctx) { ctx.emit(0, 1); }",
            32,
        );
        let mut rng = SimRng::from_seed_u64(1);
        let out = r.run(b"null", b"{}", &mut rng);
        assert_eq!(
            out.fault,
            Some(FaultReason::FactoryTimeout),
            "a top-level infinite loop trips the fuse to FactoryTimeout (no hang)"
        );
        assert!(out.emits.is_empty(), "a tripped tick emits nothing");
    }

    #[test]
    fn build_does_not_run_top_level_user_code() {
        // CR-01: construction must NOT evaluate the user module's top level — it
        // only parses to validate syntax. A top-level side effect (an emit) must
        // therefore NOT fire at build time; it fires only when `run` is called.
        // (We prove "build didn't run it" indirectly: building a top-level-looping
        // factory with a tiny budget RETURNS a runtime — build did not hang/eval —
        // and the loop only trips later, inside `run`, asserted above.)
        let _r = rt_budget(
            "for (;;) {}\nexport default function (i, c) {}",
            8,
        );
        // Reaching here at all means `build` did not evaluate (and hang on) the
        // top-level loop — it parsed only.
    }

    // ── CR-02: module-scope state cannot persist across calls ──────────────────

    #[test]
    fn module_scope_state_resets_each_call() {
        // CR-02 (BLOCKER): a counter held in a MODULE-SCOPE `let` (NOT ctx.state)
        // must NOT accumulate across calls — the module is re-instantiated into a
        // fresh scope every tick, so `count` is always 1 when emitted. This is what
        // makes ctx.state the SOLE cross-tick state and keeps snapshot/replay
        // equivalence (SC#2) true for idiomatic-but-wrong user code.
        let src = "let count = 0; export default function (i, ctx) { count = count + 1; ctx.emit(0, count); }";
        let mut r = rt(src);
        let mut rng = SimRng::from_seed_u64(1);
        for _ in 0..5 {
            let out = r.run(b"null", b"{}", &mut rng);
            assert_eq!(out.fault, None);
            assert_eq!(
                out.emits,
                vec![(0u16, Item(b"1".to_vec()))],
                "module-scope `let` resets each call (cannot accumulate cross-tick)"
            );
        }
    }

    #[test]
    fn global_scope_stash_faults_not_persists() {
        // CR-01/CR-02: a DIRECT write of cross-tick state onto `globalThis` must
        // FAULT (frozen global scope), not silently persist within a session and
        // reset on restore. Modules are strict-mode, so the write throws →
        // FactoryError. (The per-tick fresh context would ALSO make this per-tick
        // scratch; the freeze additionally turns it into a LOUD failure.)
        let src = "export default function (i, ctx) { globalThis.count = (globalThis.count || 0) + 1; ctx.emit(0, globalThis.count); }";
        let out = run_once(src, b"null", b"{}", 1);
        assert_eq!(
            out.fault,
            Some(FaultReason::FactoryError),
            "stashing state on frozen globalThis faults loudly, never persists silently"
        );
        assert!(out.emits.is_empty(), "the faulted tick emits nothing");
    }

    // ── CR-01: shallow-freeze door — intrinsic/prototype mutation is per-tick scratch ──

    #[test]
    fn curated_math_mutation_is_per_tick_scratch_not_cross_tick_state() {
        // CR-01 (the shallow-freeze BLOCKER): `Object.freeze(globalThis)` is shallow,
        // so the curated `Math` object stays mutable. On a REUSED context `Math.acc`
        // would accumulate live (1,2,3,…) yet live NOWHERE in the snapshot — a
        // persists-then-resets divergence on snapshot/restore (SC#2). With a FRESH
        // context every tick the curated `Math` is rebuilt each call, so `Math.acc`
        // is per-tick scratch: it is ALWAYS `1` when emitted, never accumulates, and
        // therefore cannot diverge across a snapshot/restore. It must NOT fault
        // (Math is not frozen) — it is simply discarded each tick.
        let src = "export default function (i, ctx) { Math.acc = (Math.acc || 0) + 1; ctx.emit(0, Math.acc); }";
        let mut r = rt(src);
        let mut rng = SimRng::from_seed_u64(1);
        for _ in 0..6 {
            let out = r.run(b"null", b"{}", &mut rng);
            assert_eq!(out.fault, None, "mutating the curated Math object does not fault");
            assert_eq!(
                out.emits,
                vec![(0u16, Item(b"1".to_vec()))],
                "Math.acc resets every tick (curated Math is per-tick scratch, never cross-tick state)"
            );
        }
    }

    #[test]
    fn prototype_pollution_is_per_tick_scratch_not_cross_tick_state() {
        // CR-01: the same shallow-freeze door via builtin-prototype pollution. On a
        // REUSED context `Object.prototype.n` would accumulate live yet be absent
        // from the snapshot; with a fresh context every tick `Object.prototype` is
        // rebuilt, so `n` is always `1` when emitted — per-tick scratch, never a
        // hidden cross-tick channel, and no fault (the prototype is not frozen).
        let src = "export default function (i, ctx) { Object.prototype.n = (Object.prototype.n || 0) + 1; ctx.emit(0, ({}).n); }";
        let mut r = rt(src);
        let mut rng = SimRng::from_seed_u64(1);
        for _ in 0..6 {
            let out = r.run(b"null", b"{}", &mut rng);
            assert_eq!(out.fault, None, "polluting Object.prototype does not fault");
            assert_eq!(
                out.emits,
                vec![(0u16, Item(b"1".to_vec()))],
                "Object.prototype.n resets every tick (prototypes are per-tick scratch)"
            );
        }
    }

    #[test]
    fn prelude_function_mutation_is_per_tick_scratch() {
        // CR-01: stashing state on a `__fab_*` prelude FUNCTION object (also left
        // mutable by the shallow freeze) is per-tick scratch under the fresh context
        // — the function objects are recreated each tick, so a property on them
        // cannot carry state across a tick. Always emits `1`.
        let src = "export default function (i, ctx) { __fab_emit.x = (__fab_emit.x || 0) + 1; ctx.emit(0, __fab_emit.x); }";
        let mut r = rt(src);
        let mut rng = SimRng::from_seed_u64(1);
        for _ in 0..4 {
            let out = r.run(b"null", b"{}", &mut rng);
            assert_eq!(out.fault, None);
            assert_eq!(
                out.emits,
                vec![(0u16, Item(b"1".to_vec()))],
                "a property stashed on a prelude function resets every tick"
            );
        }
    }

    // ── WR-01: ctx.emit port range is validated, never truncated ───────────────

    #[test]
    fn emit_reserved_or_out_of_range_port_faults() {
        // WR-01: `ctx.emit(port, …)` with a port `>= FAULT_PORT` (the reserved
        // u16::MAX) must FAULT instead of truncating `u32 as u16` and silently
        // colliding with the reserved fault port. 65535 == FAULT_PORT; 65536 would
        // truncate to 0; a negative arg wraps through u32 to 0xFFFF == FAULT_PORT.
        for bad in ["65535", "65536", "-1"] {
            let src = format!("export default function (i, ctx) {{ ctx.emit({bad}, 1); }}");
            let out = run_once(&src, b"null", b"{}", 1);
            assert_eq!(
                out.fault,
                Some(FaultReason::FactoryError),
                "emit(port={bad}) is rejected with a FactoryError, never misrouted"
            );
            assert!(out.emits.is_empty(), "no item is emitted for an invalid port");
        }
        // The largest LEGAL port (FAULT_PORT - 1) still emits normally.
        let legal = format!(
            "export default function (i, ctx) {{ ctx.emit({}, 1); }}",
            FAULT_PORT - 1
        );
        let ok = run_once(&legal, b"null", b"{}", 1);
        assert_eq!(ok.fault, None, "the largest legal port still emits");
        assert_eq!(ok.emits, vec![(FAULT_PORT - 1, Item(b"1".to_vec()))]);
    }

    // ── WR-02: a throw at exactly-exhausted budget stays FactoryError ──────────

    #[test]
    fn throw_at_exhausted_budget_is_error_not_timeout() {
        // WR-02: the interrupt handler decrements the budget to 0 on one callback
        // but only ABORTS on the next. If user code throws in that window — an
        // ordinary `throw`, not a fuse trip — the budget is already 0 yet the fuse
        // never forced an abort. Classifying on `budget == 0` would mislabel this as
        // FactoryTimeout; classifying on the explicit `tripped` flag correctly keeps
        // it a FactoryError. We drive the budget to exactly 0 with a bounded loop,
        // then throw, and assert: (a) budget reached 0, (b) reason is FactoryError.
        // Budget 1 => the first interrupt callback (~10000 polls) sets budget 0; the
        // loop (7500 iters ≈ 15000 polls) then finishes and throws BEFORE the next
        // callback (~20000 polls) can force the abort. The trip boundary for this
        // body sits at ~10000 iters, so 7500 is comfortably inside the
        // budget-is-0-but-not-tripped window (empirically pinned; deterministic, so
        // stable on every platform — the trip point is a pure function of the
        // bytecode path).
        let mut r = rt_budget(
            "export default function (i, ctx) { var s = 0; for (var k = 0; k < 7500; k++) { s += k; } throw new Error(\"after budget\"); }",
            1,
        );
        let mut rng = SimRng::from_seed_u64(1);
        let out = r.run(b"null", b"{}", &mut rng);
        assert_eq!(
            r.budget_remaining(),
            0,
            "the bounded loop drove the fuse budget to exactly 0 before the throw"
        );
        assert_eq!(
            out.fault,
            Some(FaultReason::FactoryError),
            "an ordinary throw at exhausted budget is a FactoryError, not a FactoryTimeout (WR-02)"
        );
        let msg = String::from_utf8_lossy(&out.fault_message);
        assert!(msg.contains("after budget"), "the thrown error message is carried: {msg}");
    }
}
