//! Pins what the host's tick loop does on the three shipped scenes, one hash per tick.
//!
//! `drive` boots a scene through `apply_gesture` and `Host::tick_once`, then runs it for
//! [`PARITY_TICKS`] more ticks with the things whose order matters all happening inside the
//! run: timer fires, refused timer fires, webhook items, command results, withheld commands
//! and timeouts on two nodes in one tick. Every tick's `tick_hash` goes into a line of a
//! committed fixture, and `host_matches_the_recorded_fixture` compares a fresh run against it.
//!
//! The fixtures are the only record of how the loop behaved when they were written, so they
//! are worth more than a green test. Don't re-record them to make this test pass. A mismatch
//! means the order of work inside a tick moved, and that's what this file exists to report.
//! `record_host_parity_fixture` is ignored for that reason and only runs by hand, and
//! `scripts/check-core-declared.sh` reddens on any change to the fixtures unless
//! `docs/DECLARED-MOVES.txt` declares it.
//!
//! No single scene catches every reordering, so the compare test checks all three scenes and
//! reports each one before it fails. It also checks its own coverage, because a run that
//! stopped refusing fires or stopped timing out two nodes together would still match a
//! fixture recorded from the same run, and it would prove nothing.
//!
//! This file uses the public `Host` API only, so it runs unchanged however the loop behind
//! `tick_once` is arranged.

// The fixtures live on disk, so the generator and the compare read and write files.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};

use fabrico_core::admit::{SOURCE_PENDING_CAP, source_accepts_one};
use fabrico_core::command::{Command, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::Node;
use fabrico_host::demo_scene::{SceneId, boot_scene, timers_from_log};
use fabrico_host::driver::Host;
use fabrico_host::ingress::timer::project_timers;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_protocol::{BeltEnd, GridCommand};
use fabrico_scenario::tick_hash;
use tokio::sync::mpsc::unbounded_channel;

/// Ticks driven after boot. Long enough to pass the Sink deadline of 600 ticks twice over,
/// and to run for 1000 ticks after the jam at [`JAM_AT`].
const PARITY_TICKS: u64 = 2500;

/// Every this many ticks, each Source gets a webhook item.
const INJECT_EVERY: u64 = 11;

/// The run tick where the first two Sinks each get an item directly, so two different nodes
/// emit a command on one tick.
const TWO_SINKS_AT: u64 = 300;

/// The last run tick whose commands from those two Sinks get no result, so both time out
/// together at their deadline.
const WITHHOLD_UNTIL: u64 = 304;

/// The run tick where the belt leaving the first Source loses its Head. From then on the
/// Source's pending queue fills to the cap and its timer fires get refused.
const JAM_AT: u64 = 1500;

const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/host_parity/");

/// What one run exercised, counted from the run itself and printed when a floor is missed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Coverage {
    /// Commands the host dispatched during the run.
    commands: u64,
    /// `Timeout` events in the log.
    timeouts: u64,
    /// Ticks where timeouts hit two or more different nodes.
    same_tick_cross_node_timeouts: u64,
    /// Timer fires the first Source refused because its pending queue was full.
    refused_fires: u64,
    /// The first Source's pending queue length at the end of the run.
    first_source_pending: usize,
    /// The first Source's timer interval, if it has a timer.
    timer_interval: Option<u64>,
}

/// One scene's run: one `<core tick> <hex hash>` line per tick, boot ticks included.
struct ParityRun {
    lines: Vec<String>,
    coverage: Coverage,
}

fn fixture_path(id: SceneId) -> String {
    format!("{FIXTURE_DIR}{}.hashes", id.wire_id())
}

/// A body the scene's Source accepts and its machines act on.
fn body(id: SceneId, t: u64) -> Vec<u8> {
    match id {
        SceneId::OrderProcessing => {
            format!(r#"{{"id":"o-{t}","items":[{{"sku":"widget","qty":2,"price":5}}]}}"#)
        }
        _ => format!(r#"{{"id":{t},"qty":2}}"#),
    }
    .into_bytes()
}

fn fresh_host(id: SceneId, dir: &std::path::Path) -> Host {
    let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: id.genesis_seed() });
    let store = RedbStore::open(dir.join("log.redb")).expect("open the event log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open the ledger");
    Host::new(core, store, ledger, None).expect("build the host")
}

fn line(host: &Host) -> String {
    format!("{} {}", host.core().tick, tick_hash(host.core()))
}

/// Run one scene from genesis through boot and [`PARITY_TICKS`] more ticks.
fn drive(id: SceneId) -> ParityRun {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut host = fresh_host(id, dir.path());
    let commands = id.commands().expect("the shipped scene parses");

    let (ingress_tx, mut ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (results_tx, mut results_rx) = unbounded_channel::<ResultEvent>();
    let mut lines = Vec::new();

    // Boot through this file's own loop, so the boot ticks get hashed too. It's `seed_scene`'s
    // order: one command per tick, the history seal in one more tick, then the timers.
    let mut minted: Vec<NodeId> = Vec::new();
    for cmd in &commands {
        apply_gesture(&mut host, cmd.clone(), |h| minted.get(h as usize).copied())
            .expect("the shipped scene's command applies");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("boot tick");
        minted.extend(host.core().last_tick.placed.iter().copied());
        lines.push(line(&host));
    }
    host.seal_history();
    host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("seal tick");
    lines.push(line(&host));
    host.set_timers(timers_from_log(&host).expect("read the edit log"));

    // Production's boot has to land on the same state, or this loop isn't testing production.
    let boot_dir = tempfile::tempdir().expect("temp dir");
    let booted = boot_scene(fresh_host(id, boot_dir.path()), id).expect("boot the shipped scene");
    assert_eq!(
        tick_hash(booted.core()),
        tick_hash(host.core()),
        "{}: this file's boot loop and boot_scene differ at the seal",
        id.wire_id()
    );

    // A scene's dense command handle is the index into `minted`.
    let handles_of = |want_source: bool| -> Vec<usize> {
        (0..minted.len())
            .filter(|&h| match host.core().state.node(minted[h]) {
                Some(Node::Source(_)) => want_source,
                Some(Node::Sink(_)) => !want_source,
                _ => false,
            })
            .collect()
    };
    let sources = handles_of(true);
    let sinks = handles_of(false);
    assert!(!sources.is_empty(), "{}: the scene has no Source", id.wire_id());
    assert!(sinks.len() >= 2, "{}: the scene has fewer than two Sinks", id.wire_id());
    let first_source_handle = sources[0];
    let first_source = minted[first_source_handle];
    let (sink_a, sink_b) = (minted[sinks[0]], minted[sinks[1]]);

    // The belt leaving the first Source, and what its Head is docked to.
    let belt = commands
        .iter()
        .find_map(|c| match c {
            GridCommand::Dock { belt, endpoint: BeltEnd::Tail, node, .. }
                if *node == first_source_handle as u64 =>
            {
                Some(*belt)
            }
            _ => None,
        })
        .expect("a belt leaves the first Source");
    let (downstream, downstream_port) = commands
        .iter()
        .find_map(|c| match c {
            GridCommand::Dock { belt: b, endpoint: BeltEnd::Head, node, port } if *b == belt => {
                Some((*node, *port))
            }
            _ => None,
        })
        .expect("that belt's Head is docked");

    let mut due_results: BTreeMap<u64, Vec<ResultEvent>> = BTreeMap::new();
    let mut commands_seen = 0u64;
    let mut refused_fires = 0u64;

    for t in 0..PARITY_TICKS {
        let tick = host.core().tick;

        if t % INJECT_EVERY == 0 {
            for &s in &sources {
                let item = Item(body(id, t));
                ingress_tx
                    .send(EventPayload::ManualInject { target: minted[s], port: 0, item })
                    .expect("ingress open");
            }
        }
        if t == TWO_SINKS_AT {
            for target in [sink_a, sink_b] {
                let item = Item(b"{}".to_vec());
                ingress_tx.send(EventPayload::Input { target, port: 0, item }).expect("ingress open");
            }
        }
        if t == JAM_AT {
            let unlink = GridCommand::Unlink {
                belt,
                endpoint: BeltEnd::Head,
                node: downstream,
                port: downstream_port,
            };
            apply_gesture(&mut host, unlink, |h| minted.get(h as usize).copied())
                .expect("the unlink applies");
        }

        // The same question `tick_once` asks at the head of the tick, counted from outside it.
        let fires_this_tick =
            host.timers().interval_for(first_source).is_some_and(|i| i != 0 && tick.is_multiple_of(i));
        if fires_this_tick
            && let Some(Node::Source(source)) = host.core().state.node(first_source)
            && !source_accepts_one(source)
        {
            refused_fires += 1;
        }

        if let Some(due) = due_results.remove(&tick) {
            for result in due {
                results_tx.send(result).expect("results open");
            }
        }

        // The real loop re-projects the timers after any tick that folded an edit.
        let edit_tick = !host.pending_edits().is_empty();
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("run tick");
        if edit_tick {
            host.set_timers(project_timers(&host.logged_edits().expect("read the edit log")));
        }

        while let Ok(cmd) = cmd_rx.try_recv() {
            commands_seen += 1;
            let from_the_two_sinks = cmd.id.1 == sink_a || cmd.id.1 == sink_b;
            if (TWO_SINKS_AT..=WITHHOLD_UNTIL).contains(&t) && from_the_two_sinks {
                continue;
            }
            let result = |outcome| ResultEvent { command_id: cmd.id, tick: 0, outcome };
            match commands_seen % 3 {
                0 => {}
                1 => due_results.entry(tick + 2).or_default().push(result(Outcome::Success)),
                _ => due_results.entry(tick + 3).or_default().push(result(Outcome::Failure)),
            }
        }

        lines.push(line(&host));
    }

    let mut timeouts = 0u64;
    let mut timed_out_nodes: BTreeMap<u64, BTreeSet<NodeId>> = BTreeMap::new();
    for event in host.logged_events().expect("read the event log") {
        if let EventPayload::Timeout { command_id } = event.payload {
            timeouts += 1;
            timed_out_nodes.entry(event.tick).or_default().insert(command_id.1);
        }
    }
    let first_source_pending = match host.core().state.node(first_source) {
        Some(Node::Source(source)) => source.pending.len(),
        _ => 0,
    };

    ParityRun {
        lines,
        coverage: Coverage {
            commands: commands_seen,
            timeouts,
            same_tick_cross_node_timeouts: timed_out_nodes
                .values()
                .filter(|nodes| nodes.len() >= 2)
                .count() as u64,
            refused_fires,
            first_source_pending,
            timer_interval: host.timers().interval_for(first_source),
        },
    }
}

/// How one scene's run differs from its fixture, or `None` when they match.
fn divergence(id: SceneId, got: &[String], want: &[String]) -> Option<String> {
    let name = id.wire_id();
    let first_diff = got.iter().zip(want).position(|(a, b)| a != b);
    match first_diff {
        Some(i) => Some(format!(
            "{name}: first diverging line {i} of {}: recorded `{}`, this run `{}`",
            want.len(),
            want[i],
            got[i]
        )),
        None if got.len() != want.len() => {
            Some(format!("{name}: this run has {} lines, the fixture has {}", got.len(), want.len()))
        }
        None => None,
    }
}

/// The floors one scene's run has to clear, as one failure line per missed floor.
fn coverage_problems(id: SceneId, c: &Coverage) -> Vec<String> {
    let name = id.wire_id();
    let mut problems = Vec::new();
    let mut floor = |ok: bool, what: &str| {
        if !ok {
            problems.push(format!("{name}: coverage floor missed: {what}. Counted: {c:?}"));
        }
    };
    floor(c.commands > 0, "commands above 0");
    floor(c.timeouts > 0, "timeouts above 0");
    floor(c.same_tick_cross_node_timeouts > 0, "same-tick cross-node timeouts above 0");
    floor(
        c.first_source_pending == SOURCE_PENDING_CAP,
        "first Source's pending length equal to SOURCE_PENDING_CAP",
    );
    // Written per scene, so a scene that lost its timer can't skip the refused-fire floor.
    let has_timer = !matches!(id, SceneId::OrderProcessing);
    floor(c.timer_interval.is_some() == has_timer, "the first Source's timer matches the scene");
    if has_timer {
        floor(c.refused_fires > 0, "refused fires above 0");
    }
    problems
}

#[test]
#[ignore = "writes the fixture by hand; never run on a failure"]
fn record_host_parity_fixture() {
    std::fs::create_dir_all(FIXTURE_DIR).expect("create the fixture directory");
    for id in SceneId::ALL {
        let mut text = drive(id).lines.join("\n");
        text.push('\n');
        std::fs::write(fixture_path(id), text).expect("write the fixture");
    }
}

#[test]
fn host_matches_the_recorded_fixture() {
    let mut problems = Vec::new();
    for id in SceneId::ALL {
        let run = drive(id);
        println!("{}: {:?}", id.wire_id(), run.coverage);
        problems.extend(coverage_problems(id, &run.coverage));

        let path = fixture_path(id);
        let Ok(text) = std::fs::read_to_string(&path) else {
            problems.push(format!("{}: can't read the fixture at {path}", id.wire_id()));
            continue;
        };
        let want: Vec<String> = text.lines().map(String::from).collect();
        if (want.len() as u64) < PARITY_TICKS {
            problems.push(format!(
                "{}: the fixture has {} lines, fewer than {PARITY_TICKS}",
                id.wire_id(),
                want.len()
            ));
        }
        problems.extend(divergence(id, &run.lines, &want));
    }
    assert!(problems.is_empty(), "host parity failed:\n{}", problems.join("\n"));
}
