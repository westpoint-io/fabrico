//! Wave-0 build-gate spike for the Phase-04 factory sandbox (plan 04-01).
//!
//! This is a STANDALONE integration test that exercises the `rquickjs` 0.12 crate
//! directly — it is deliberately NOT wired into any `src` module. Its job is to
//! de-risk the first vendored-C runtime dependency and to PIN the exact 0.12 API
//! spellings, trait bounds, and the f64-free patterns that plan 04-02 will build
//! the real `FactoryRuntime` against (so 04-02 codes against confirmed APIs, not
//! the RESEARCH pseudocode / Open Questions A1-A5).
//!
//! Every assertion here is clock-free, IO-free, and float-free so this file passes
//! the crate's determinism clippy gate (`-D warnings`, workspace `clippy.toml`
//! bans `f64`/`HashMap`/`Instant`/IO) UNCHANGED with the new engine present.
//!
//! ─────────────────────────────────────────────────────────────────────────────
//! PINNED rquickjs 0.12.0 API (consumed by plan 04-02) — verified against the
//! crate source in ~/.cargo and proven by the tests below:
//!
//! Imports / public paths:
//!   use rquickjs::{Runtime, Context, Module, Object, Function, Persistent};
//!   use rquickjs::context::intrinsic;              // intrinsic::{Eval, Json, Date, ...}
//!   use rquickjs::prelude::Func;
//!
//! Runtime + fences (all on the SYNC `Runtime`):
//!   let rt = Runtime::new()?;                       // -> Runtime  (Clone, Send; NOT Sync)
//!   rt.set_memory_limit(bytes: usize);             // -> ()
//!   rt.set_max_stack_size(bytes: usize);           // -> ()
//!   rt.set_interrupt_handler(Some(Box::new(move || -> bool { .. })));
//!     // InterruptHandler = Box<dyn FnMut() -> bool + 'static>   (NON-Send: no `parallel` feature)
//!     // return `true` to ABORT execution at the current poll point.
//!
//! Context + intrinsic composition (curated, deny-by-absence):
//!   Context::custom::<(intrinsic::Eval, intrinsic::Json, intrinsic::Promise)>(&rt)?  // -> Context
//!     // `Promise` is MANDATORY for the `export default` module entry path: QuickJS-NG module
//!     // evaluation is promise-based and `Module::eval()` ABORTS (SIGABRT) without it. It adds
//!     // only deterministic microtasks (no timers/no ambient nondeterminism). The closure-wrap
//!     // fallback works on the minimal `(Eval, Json)` set (proven in the entry-shape test).
//!     // NOTE: Context::custom ALWAYS adds JS_AddIntrinsicBaseObjects, so base `Math`
//!     // (incl. Math.random + transcendentals) is PRESENT even in a custom context.
//!     // `Date` IS omittable (it is the `intrinsic::Date` builtin — just leave it out).
//!     // To withhold `Math.random`/`Math.sin` etc, 04-02 must DELETE/replace them
//!     // post-build (e.g. `delete Math.random`) — proven below.
//!   ctx.with(|ctx| -> rquickjs::Result<R> { .. })  // R must be 'static (cannot return a 'js Value out)
//!   ctx.eval::<T, _>(src) -> rquickjs::Result<T>    // T: FromJs
//!   ctx.globals() -> Object
//!
//! Host bindings:
//!   Object::new(ctx.clone())? -> Object
//!   obj.set(name, value)?;  value may be `Func::new(closure)`, a primitive, or an Object
//!   Func::new(|a: i32, b: i32| a + b)               // sync closures need NOT be Send here
//!   func.call::<_, T>((arg0, arg1, ..))? -> T       // args as a tuple
//!
//! Entry shape (LOCKED `export default function(input, ctx)` — module path WORKS):
//!   let m = Module::declare(ctx.clone(), "factory", source)?;   // -> Module<Declared>
//!   let (evaluated, promise) = m.eval()?;                        // -> (Module<Evaluated>, Promise)
//!   promise.finish::<()>()?;   // MANDATORY: drive eval to completion; dropping it un-finished
//!                              // leaves the module half-evaluated and ABORTS the engine (SIGABRT).
//!   let default_fn: Function = evaluated.get("default")?;        // namespace().get under the hood
//!   default_fn.call::<_, i32>((input, ctx_obj))?
//!   // (The closure-wrap fallback `(function(input,ctx){..})` evaluated via ctx.eval
//!   //  also works — see persistent test — but 04-02 should use the module path.)
//!
//! Compile-once / run-many across ticks (Persistent):
//!   let saved = ctx.with(|ctx| Ok(Persistent::save(&ctx, f)))?;  // -> Persistent<Function<'static>>
//!     // Persistent<T: Clone>: Clone (+ Eq, PartialEq, Hash). Function IS Clone.
//!   let f = saved.clone().restore(&ctx)?;          // restore CONSUMES self -> clone() each tick
//!
//! Clone/Send facts for caching a live engine on `Core` (drives the 04-03 cache):
//!   Runtime: #[derive(Clone)] + `unsafe impl Send`  (NOT Sync). Clone = Arc-shared handle.
//!   Context: #[derive(Clone)] + `unsafe impl Send` + `unsafe impl Sync`. Clone = Arc-shared handle.
//!   Persistent<Function>: Clone.
//!   => A `FactoryRuntime { rt, ctx, default_fn: Persistent<Function> }` is technically Clone,
//!      but Clone SHARES the same live engine (Arc), it does NOT deep-copy. So 04-03 should hold
//!      the cache as `#[serde(skip, default)] BTreeMap<NodeId, FactoryRuntime>` and REBUILD it
//!      lazily (never rely on the derived Clone to duplicate engines, and reset-to-empty on a
//!      Core clone/restore so two Cores never share one mutable engine — a determinism hazard).
//!
//! f64-free randomness path (clippy bans f64 in this crate):
//!   Host exposes ONLY raw u32 bits via `Func`; the half-open [0,1) division
//!   `bits / 4294967296` happens ENTIRELY inside JS. Rust never reads a float back.
//! ─────────────────────────────────────────────────────────────────────────────

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use rquickjs::context::intrinsic;
use rquickjs::prelude::Func;
use rquickjs::{Context, Function, Module, Object, Persistent, Runtime};

/// The curated intrinsic set this phase uses: evaluation + JSON + Promise, and
/// crucially NO `Date`. (Base objects — Object/Array/Function/Math — are always
/// present.) `Promise` is REQUIRED because QuickJS-NG module evaluation is
/// promise-based: `Module::eval()` ABORTS the engine (SIGABRT) without it. The
/// Promise intrinsic adds only the deterministic microtask machinery (drained via
/// `promise.finish()`/`execute_pending_job`) — NO timers, NO ambient nondeterminism.
/// (The closure-wrap entry fallback needs only `(Eval, Json)` — see test below.)
type Curated = (intrinsic::Eval, intrinsic::Json, intrinsic::Promise);

/// (a) A `Runtime` + curated `Context` build, and a trivial expression evaluates
/// to the expected value. Pins `Context::custom::<Curated>` (Date omitted).
#[test]
fn trivial_eval_in_curated_context() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::custom::<Curated>(&rt).unwrap();
    let sum = ctx.with(|ctx| ctx.eval::<i32, _>("2 + 2 + 3").unwrap());
    assert_eq!(sum, 7);
}

/// (b) Ambient authority is absent: `fetch`/`setTimeout`/`process`/`require` never
/// exist in a bare rquickjs context, and `Date` is undefined because we omitted the
/// `Date` intrinsic. Also pins the curate-by-delete technique 04-02 needs for `Math`
/// (base `Math.random` is present and deletable).
#[test]
fn ambient_authority_absent() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::custom::<Curated>(&rt).unwrap();
    ctx.with(|ctx| {
        for src in [
            "typeof Date === 'undefined'",
            "typeof fetch === 'undefined'",
            "typeof setTimeout === 'undefined'",
            "typeof setInterval === 'undefined'",
            "typeof process === 'undefined'",
            "typeof require === 'undefined'",
        ] {
            let absent: bool = ctx.eval(src).unwrap();
            assert!(absent, "expected ambient authority absent: {src}");
        }
        // Base objects DO include a full `Math` (random + platform-libm transcendentals).
        // 04-02 withholds them by deletion/replacement — prove that path here.
        let has_random: bool = ctx.eval("typeof Math.random === 'function'").unwrap();
        assert!(has_random, "base Math.random is present pre-curation");
        let deleted: bool = ctx
            .eval("delete Math.random; typeof Math.random === 'undefined'")
            .unwrap();
        assert!(deleted, "Math.random is deletable → curated Math is viable for 04-02");
    });
}

/// (c) The three resource fences are callable, and a COUNTER-DRIVEN interrupt
/// (never wall-clock) aborts a runaway `while(true){}` so eval returns Err instead
/// of hanging. The exhausted budget (== 0) is the flag 04-02 uses to disambiguate
/// a fuse-trip (FactoryTimeout) from a thrown error (FactoryError).
#[test]
fn fences_and_counter_interrupt_abort_runaway() {
    let rt = Runtime::new().unwrap();
    rt.set_memory_limit(16 * 1024 * 1024);
    rt.set_max_stack_size(512 * 1024);

    let budget = Rc::new(Cell::new(64u64));
    let budget_in_handler = budget.clone();
    rt.set_interrupt_handler(Some(Box::new(move || {
        let remaining = budget_in_handler.get();
        if remaining == 0 {
            return true; // abort at a REPRODUCIBLE point (pure function of execution path)
        }
        budget_in_handler.set(remaining - 1);
        false
    })));

    let ctx = Context::custom::<Curated>(&rt).unwrap();
    let aborted = ctx.with(|ctx| {
        let result: rquickjs::Result<()> = ctx.eval("while(true){}");
        result.is_err()
    });
    assert!(aborted, "runaway loop must trip the fuse and return Err, not hang");
    assert_eq!(budget.get(), 0, "budget exhausted → disambiguates FactoryTimeout");
}

/// (d) A host Rust closure is injectable via `Func` + `Object::set` and callable
/// from JS, and a JS value crosses back to Rust via in-engine `JSON.stringify`
/// (the canonical, deterministic boundary encoding).
#[test]
fn host_func_injectable_and_json_boundary() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::custom::<Curated>(&rt).unwrap();

    let captured: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = captured.clone();

    ctx.with(|ctx| {
        let host = Object::new(ctx.clone()).unwrap();
        host.set("add", Func::new(|a: i32, b: i32| a + b)).unwrap();
        host.set(
            "emit",
            Func::new(move |json: String| {
                sink.borrow_mut().push(json);
            }),
        )
        .unwrap();
        ctx.globals().set("host", host).unwrap();

        let sum: i32 = ctx.eval("host.add(40, 2)").unwrap();
        assert_eq!(sum, 42, "host closure callable from JS");

        // Value crosses back as canonical JSON produced inside the engine.
        let _: () = ctx
            .eval("host.emit(JSON.stringify({ a: 1, b: [2, 3] }))")
            .unwrap();
    });

    assert_eq!(
        captured.borrow().as_slice(),
        &[String::from("{\"a\":1,\"b\":[2,3]}")],
        "JSON.stringify boundary round-trips deterministically"
    );
}

/// (e) The LOCKED entry shape `export default function(input, ctx)` works via the
/// module path: declare → eval → get("default") → call with host-injected args.
#[test]
fn entry_shape_module_default_export() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::custom::<Curated>(&rt).unwrap();
    ctx.with(|ctx| {
        let source = "export default function (input, ctx) { return input * ctx.scale + ctx.offset; }";
        let module = Module::declare(ctx.clone(), "factory", source).unwrap();
        let (evaluated, promise) = module.eval().unwrap();
        // MANDATORY: drive the module-evaluation promise to completion before touching the
        // namespace. Dropping it un-finished leaves the module half-evaluated and aborts the
        // engine at the C level (SIGABRT). For our synchronous module this resolves immediately.
        promise.finish::<()>().unwrap();
        let default_fn: Function = evaluated.get("default").unwrap();

        let cfg = Object::new(ctx.clone()).unwrap();
        cfg.set("scale", 3).unwrap();
        cfg.set("offset", 1).unwrap();

        let out: i32 = default_fn.call((7, cfg)).unwrap();
        assert_eq!(out, 22, "default(7, {{scale:3, offset:1}}) == 7*3+1");
    });
}

/// (e, fallback) The closure-wrap entry path — wrapping the user body in a function
/// expression evaluated via `ctx.eval` — works on the MINIMAL `(Eval, Json)` set with
/// NO `Promise` intrinsic. This is the documented A1 fallback if 04-02 ever wants to
/// avoid the module machinery; the module path above is the preferred default.
#[test]
fn entry_shape_closure_wrap_fallback_minimal_set() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::custom::<(intrinsic::Eval, intrinsic::Json)>(&rt).unwrap();
    ctx.with(|ctx| {
        let f: Function = ctx
            .eval("(function (input, ctx) { return input * ctx.scale + ctx.offset; })")
            .unwrap();
        let cfg = Object::new(ctx.clone()).unwrap();
        cfg.set("scale", 3).unwrap();
        cfg.set("offset", 1).unwrap();
        let out: i32 = f.call((7, cfg)).unwrap();
        assert_eq!(out, 22, "closure-wrap entry works without the Promise intrinsic");
    });
}

/// (f) A compiled `Function` survives across separate `ctx.with` calls (i.e. across
/// ticks) when held in a `Persistent` — the "compile once, run many" substrate.
/// Pins that `restore` consumes self, so each tick clones the `Persistent` first.
#[test]
fn persistent_function_survives_across_with_calls() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::custom::<Curated>(&rt).unwrap();

    // "compile" tick: save the user function into a Persistent.
    let saved = ctx
        .with(|ctx| {
            let f: Function = ctx.eval("(function (x) { return x + 1; })")?;
            Ok::<_, rquickjs::Error>(Persistent::save(&ctx, f))
        })
        .unwrap();

    // a later "tick": clone-then-restore and call (clone proves we can do this every tick).
    let out = ctx
        .with(|ctx| {
            let f = saved.clone().restore(&ctx)?;
            f.call::<_, i32>((41,))
        })
        .unwrap();
    assert_eq!(out, 42);
}

/// (g) The f64-free randomness path: the host exposes ONLY raw u32 bits; the
/// half-open [0,1) division happens entirely in JS. The integer round-trips intact
/// and Rust never reads a float back (no `f64` token → determinism gate stays green).
#[test]
fn f64_free_random_path() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::custom::<Curated>(&rt).unwrap();
    ctx.with(|ctx| {
        let host = Object::new(ctx.clone()).unwrap();
        host.set("randomBits", Func::new(|| 0x1234_5678_u32)).unwrap();
        ctx.globals().set("host", host).unwrap();

        // The u32 becomes a JS Number and round-trips back as an integer, intact.
        let echoed: u32 = ctx.eval("host.randomBits()").unwrap();
        assert_eq!(echoed, 0x1234_5678);

        // The division to [0,1) stays INSIDE JS; Rust only reads the boolean predicate.
        let in_unit: bool = ctx
            .eval("var r = host.randomBits() / 4294967296; r >= 0 && r < 1")
            .unwrap();
        assert!(in_unit, "u32 bits / 2^32 is a half-open [0,1) double, entirely in JS");
    });
}
