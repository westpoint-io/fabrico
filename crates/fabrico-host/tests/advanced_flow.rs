//! The "advanced" example scene (quick 260916-adv): it seeds, and it RUNS.
//!
//! The scene is authored as RON data (`src/scenes/advanced.ron`). The first test
//! seeds it through the ONE certified applier (`seed_scene` -> `apply_gesture` ->
//! `tick_once`, one command per tick) exactly as the app's Examples load path does,
//! so every command's geometry (footprints, dock legality, belt paths, the AddPort
//! reseat, the dead-letter Sink rotate) is asserted accepted, not guessed.
//!
//! Seeding alone proves nothing about what the board DOES: a validate JS that
//! throws on every item, swapped emit ports, a Dock to a legal but wrong catalog
//! port or a dropped Timer Configure would all still seed. So the remaining tests
//! TICK the board (quick 260929-p7p, review WR-01): timers are projected from the
//! seeded log exactly as the `SceneId::Advanced` swap arm does, the host runs
//! about 1500 ticks, every Sink command is resolved as Success by a tiny
//! in-test executor, and each command is counted by the Sink it was addressed to.
//!
//! The dead-letter queue is the feature the Examples popover advertises, so the
//! live-POST test pins it (review CR-01): every id-less or item-less body lands on
//! the dead-letter Sink, and a valid order still flows to both terminals.

use std::collections::BTreeMap;

use fabrico_core::command::{Command, Effect, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_host::demo_scene::{ADVANCED_GENESIS_SEED, SceneId, seed_scene, timers_from_log};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_protocol::GridCommand;
use tokio::sync::mpsc::unbounded_channel;

/// Mint-order handles of the machines the runtime tests address (Place order in
/// `advanced.ron`, machines first).
const WEBHOOK_SOURCE: usize = 1;
const DEAD_LETTER_SINK: usize = 4;
const FULFILMENT_SINK: usize = 9;
const INVOICE_SINK: usize = 11;

/// How long the runtime tests drive the board: long enough for ~90 Timer fires
/// (interval 16) to cross the whole board and drain, well inside a test budget.
const RUN_TICKS: u64 = 1500;

fn test_host(dir: &std::path::Path) -> Host {
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: ADVANCED_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    Host::new(core, store, ledger, None).expect("open host")
}

#[test]
fn advanced_scene_ron_parses_and_every_command_is_accepted() {
    let cmds = SceneId::Advanced
        .commands()
        .expect("advanced.ron is a well-formed Vec<GridCommand>");

    // Census: 12 Place + 1 AddPort + 2 Rotate + 12 DrawBelt + 24 Dock + 6 Configure.
    // (2 Rotates since plan 74.1-14: the dead-letter sink turns W -> E, not W -> N, so the
    // fault belt from the re-seated Fault at (9,8) never runs west; see advanced.ron.)
    // Exhaustive: any other variant (Undo, Delete, a wire op...) is a defect here.
    let mut places = 0;
    let mut add_ports = 0;
    let mut rotates = 0;
    let mut belts = 0;
    let mut docks = 0;
    let mut configs = 0;
    for c in &cmds {
        match c {
            GridCommand::Place { .. } => places += 1,
            GridCommand::AddPort { .. } => add_ports += 1,
            GridCommand::Rotate { .. } => rotates += 1,
            GridCommand::DrawBelt { .. } => belts += 1,
            GridCommand::Dock { .. } => docks += 1,
            GridCommand::Configure { .. } => configs += 1,
            other => panic!(
                "unexpected command in the shipped advanced scene: {other:?} - it is \
                 authored from Place/AddPort/Rotate/DrawBelt/Dock/Configure only"
            ),
        }
    }
    assert_eq!(places, 12, "12 machines placed");
    assert_eq!(add_ports, 1, "one AddPort (validate factory's 2nd Out)");
    assert_eq!(rotates, 2, "two Rotates (dead-letter sink W->E, 74.1-14)");
    assert_eq!(belts, 12, "12 belts drawn");
    assert_eq!(docks, 24, "24 docks (2 per belt)");
    assert_eq!(
        configs, 6,
        "6 Configures (2 sources, 4 factories; sinks are Debug)"
    );
    assert_eq!(
        cmds.len(),
        57,
        "exactly 57 commands (12 + 1 + 2 + 12 + 24 + 6); an extra command of a \
         counted kind would slip past the per-kind asserts without this total"
    );

    let dir = tempfile::tempdir().expect("tempdir");
    let mut host = test_host(dir.path());
    let ledger = seed_scene(&mut host, &cmds)
        .expect("every advanced-scene command is accepted by validate_normalize");

    // 12 machines + 12 belts mint through the one-command-per-tick applier.
    assert_eq!(ledger.len(), 24, "12 machines + 12 belts minted");
}

/// What one driven run of the board produced.
struct Run {
    /// Commands addressed to each Sink, by name. Anything addressed elsewhere
    /// lands under "OTHER", which every test asserts stays absent.
    per_sink: BTreeMap<&'static str, usize>,
    /// Fulfilment jobs by worker lane, decoded from the `station` field the
    /// worker Factories write into the job the fulfilment Sink receives.
    lane_a: usize,
    lane_b: usize,
    /// The dead-letter Sink's Debug message bodies, in arrival order.
    dead_letters: Vec<String>,
    /// The fulfilment and invoice Sinks' Debug message bodies.
    fulfilment_msgs: Vec<String>,
    invoice_msgs: Vec<String>,
    /// Timer fires logged against Source 0.
    timer_injects: usize,
    snapshot: Vec<u8>,
}

/// Seed the advanced scene, project its timers from the log exactly as the
/// `SceneId::Advanced` swap arm does, then drive `ticks` ticks. `extra` injects a
/// body into a machine (by mint-order handle) on a given loop tick, the way a
/// webhook POST lands (`ManualInject` on port 0).
fn run(ticks: u64, extra: &[(usize, u64, &[u8])]) -> Run {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut host = test_host(dir.path());
    let cmds = SceneId::Advanced.commands().expect("advanced.ron parses");
    let minted = seed_scene(&mut host, &cmds).expect("seed the advanced scene");
    let timers = timers_from_log(&host).expect("project timers from the seeded log");
    let mut host = host.with_timers(timers);

    let names: BTreeMap<NodeId, &'static str> = [
        (minted[DEAD_LETTER_SINK], "dead_letter"),
        (minted[FULFILMENT_SINK], "fulfilment"),
        (minted[INVOICE_SINK], "invoice"),
    ]
    .into_iter()
    .collect();

    let mut out = Run {
        per_sink: BTreeMap::new(),
        lane_a: 0,
        lane_b: 0,
        dead_letters: Vec::new(),
        fulfilment_msgs: Vec::new(),
        invoice_msgs: Vec::new(),
        timer_injects: 0,
        snapshot: Vec::new(),
    };

    let (itx, mut irx) = unbounded_channel::<EventPayload>();
    let (ctx, mut crx) = unbounded_channel::<Command>();
    let (rtx, mut rrx) = unbounded_channel::<ResultEvent>();
    for t in 0..ticks {
        for (h, at, body) in extra {
            if *at == t {
                itx.send(EventPayload::ManualInject {
                    target: minted[*h],
                    port: 0,
                    item: Item(body.to_vec()),
                })
                .expect("inject");
            }
        }
        host.tick_once(&mut irx, &mut rrx, &ctx).expect("tick");
        // The in-test executor: every Sink command resolves as Success, so no
        // effect stays in flight and no Sink faults.
        while let Ok(c) = crx.try_recv() {
            let name = names.get(&c.id.1).copied().unwrap_or("OTHER");
            *out.per_sink.entry(name).or_default() += 1;
            if let Effect::Debug { message } = &c.effect {
                let txt = String::from_utf8_lossy(message).to_string();
                if name == "fulfilment" {
                    if txt.contains("\"station\":\"A\"") {
                        out.lane_a += 1;
                    }
                    if txt.contains("\"station\":\"B\"") {
                        out.lane_b += 1;
                    }
                }
                match name {
                    "dead_letter" => out.dead_letters.push(txt),
                    "fulfilment" => out.fulfilment_msgs.push(txt),
                    "invoice" => out.invoice_msgs.push(txt),
                    _ => {}
                }
            }
            rtx.send(ResultEvent {
                command_id: c.id,
                tick: host.core().tick,
                outcome: Outcome::Success,
            })
            .expect("resolve");
        }
    }
    for e in host.logged_events().expect("read log") {
        if let EventPayload::ManualInject { target, .. } = e.payload
            && target == minted[0]
        {
            out.timer_injects += 1;
        }
    }
    out.snapshot = host.snapshot_bytes();
    out
}

fn count(r: &Run, sink: &str) -> usize {
    r.per_sink.get(sink).copied().unwrap_or(0)
}

/// Timer-only: the heartbeat drives BOTH terminals and BOTH worker lanes, and
/// nothing is dead-lettered.
#[test]
fn advanced_scene_timer_flow_feeds_both_terminals_and_both_lanes() {
    let r = run(RUN_TICKS, &[]);
    eprintln!(
        "timer-only {RUN_TICKS} ticks: injects={} sinks={:?} lane_a={} lane_b={}",
        r.timer_injects, r.per_sink, r.lane_a, r.lane_b
    );
    assert!(
        r.timer_injects > 0,
        "the Timer source fired (timers projected from the log)"
    );
    assert!(count(&r, "fulfilment") > 0, "fulfilment Sink received jobs");
    assert!(count(&r, "invoice") > 0, "invoice Sink received invoices");
    assert!(
        r.lane_a > 0,
        "worker lane A (behind Balancer Out0) carried jobs"
    );
    assert!(
        r.lane_b > 0,
        "worker lane B (behind Balancer Out1) carried jobs"
    );
    assert_eq!(
        r.lane_a + r.lane_b,
        count(&r, "fulfilment"),
        "every fulfilment job came through exactly one worker lane"
    );
    assert!(
        r.invoice_msgs.iter().all(|m| m.contains("\"total\"")),
        "the invoice Sink receives invoice totals (emit 1 -> invoice Factory), not \
         fulfilment jobs: {:?}",
        r.invoice_msgs.first()
    );
    assert_eq!(
        count(&r, "dead_letter"),
        0,
        "the `{{}}` heartbeat is a valid (synthesised) order: nothing is dead-lettered"
    );
    assert_eq!(
        count(&r, "OTHER"),
        0,
        "no command addressed any other machine"
    );
}

/// Live bodies into the webhook Source: every id-less or item-less body is
/// dead-lettered with the validate Factory's message, and a valid order still
/// reaches both terminals.
#[test]
fn advanced_scene_dead_letters_every_invalid_live_body() {
    let bad: [&[u8]; 4] = [
        br#"{"id":"x"}"#,                           // an id, no items
        br#"{"order_id":"x","items":[{"qty":1}]}"#, // a typo'd id key (CR-01)
        br#"[{"id":"x","items":[{"qty":1}]}]"#,     // a JSON array
        br#""just a string""#,                      // a bare JSON string
    ];
    let good: &[u8] = br#"{"id":"ord-live","items":[{"sku":"gear","qty":3,"price":4}]}"#;

    let baseline = run(RUN_TICKS, &[]);
    let mut extra: Vec<(usize, u64, &[u8])> = bad
        .iter()
        .enumerate()
        .map(|(i, b)| (WEBHOOK_SOURCE, 50 + 10 * i as u64, *b))
        .collect();
    extra.push((WEBHOOK_SOURCE, 120, good));
    let r = run(RUN_TICKS, &extra);
    eprintln!(
        "with live bodies: sinks={:?} dead_letters={:?}",
        r.per_sink, r.dead_letters
    );

    assert_eq!(
        count(&r, "dead_letter"),
        bad.len(),
        "each of the {} invalid bodies lands on the dead-letter Sink, and nothing else \
         does: {:?}",
        bad.len(),
        r.dead_letters
    );
    assert!(
        r.dead_letters
            .iter()
            .all(|m| m.contains("not a valid order")),
        "every dead letter carries the validate Factory's message: {:?}",
        r.dead_letters
    );
    assert!(
        !r.fulfilment_msgs
            .iter()
            .chain(r.invoice_msgs.iter())
            .any(|m| m.contains("\"order\":\"x\"")),
        "no invalid body was laundered into an order that reached a terminal"
    );
    assert!(
        r.fulfilment_msgs
            .iter()
            .any(|m| m.contains("\"order\":\"ord-live\"")),
        "the valid live order reached the fulfilment Sink"
    );
    assert!(
        r.invoice_msgs
            .iter()
            .any(|m| m.contains("\"order\":\"ord-live\"") && m.contains("\"total\":12")),
        "the valid live order reached the invoice Sink with its total (3 x 4)"
    );
    assert_eq!(
        count(&r, "fulfilment"),
        count(&baseline, "fulfilment") + 1,
        "the valid order adds exactly one fulfilment job; no bad body added one"
    );
    assert_eq!(
        count(&r, "invoice"),
        count(&baseline, "invoice") + 1,
        "the valid order adds exactly one invoice; no bad body added one"
    );
    assert_eq!(
        count(&r, "OTHER"),
        0,
        "no command addressed any other machine"
    );
}

/// Two identical runs end in byte-identical core snapshots.
#[test]
fn advanced_scene_run_is_deterministic() {
    let a = run(RUN_TICKS, &[]);
    let b = run(RUN_TICKS, &[]);
    assert!(!a.snapshot.is_empty(), "the snapshot is non-empty");
    assert_eq!(
        a.snapshot, b.snapshot,
        "two identical runs, byte-identical snapshots"
    );
}
