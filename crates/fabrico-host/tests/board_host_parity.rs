//! The check that the same board runs the same way with the desktop host and without it.
//!
//! For every board file under `examples/boards/`, this drives `Host::tick_once`, with its stores
//! and its channels, beside the host-free `BoardRun`, and compares `tick_hash` after boot and after
//! every tick up to the board's end tick. At the end it compares the two effect lists.
//!
//! The host side here spells out the per-tick order that `BoardRun::step` follows: script entries,
//! due results, the tick, new handles, commands to the executor, then the timers again after an
//! edit. It shares `script_payload` and `ScriptedExecutor` with the engine, so what's left to
//! disagree is the order and the two tick paths, and those are what this file exists to compare.
//!
//! All the boards are checked before anything is asserted, so one failure doesn't hide another.

// The board files live on disk, and this file walks the folder to find them.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_engine::board::{BoardFile, ScriptInput, parse_board};
use fabrico_engine::scripted::{BoardRun, EffectRecord, ScriptedExecutor, script_payload};
use fabrico_host::demo_scene::{seed_scene, timers_from_log};
use fabrico_host::driver::Host;
use fabrico_host::ingress::timer::project_timers;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_scenario::tick_hash;
use tokio::sync::mpsc::unbounded_channel;

const BOARDS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/boards");

/// The 3 shipped boards and the docs test board. A walk that finds fewer is broken, and an empty
/// walk would otherwise pass.
const BOARD_FLOOR: usize = 4;

/// Every `*.board.ron` under `dir`, at any depth, in sorted order.
fn board_files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).expect("read the boards folder") {
        let path = entry.expect("read a folder entry").path();
        if path.is_dir() {
            found.extend(board_files(&path));
        } else if path.to_string_lossy().ends_with(".board.ron") {
            found.push(path);
        }
    }
    found.sort();
    found
}

/// What one board's comparison found: a failure line, or the effect count on success.
fn compare(name: &str, board: &BoardFile) -> Result<usize, String> {
    let mut run = BoardRun::boot(board.clone()).map_err(|e| format!("{name}: BoardRun boot: {e}"))?;

    let dir = tempfile::tempdir().expect("temp dir");
    let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: board.seed });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open the event log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open the ledger");
    let mut host = Host::new(core, store, ledger, None).expect("build the host");
    let mut minted: Vec<NodeId> = seed_scene(&mut host, &board.commands).map_err(|e| format!("{name}: seed: {e:?}"))?;
    host.set_timers(timers_from_log(&host).expect("read the edit log"));

    let (host_hash, run_hash) = (tick_hash(host.core()), tick_hash(run.engine().core()));
    if host_hash != run_hash {
        return Err(format!(
            "{name}: differs after boot at tick {}: host {host_hash}, host-free {run_hash}",
            host.core().tick
        ));
    }

    let (ingress_tx, mut ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (results_tx, mut results_rx) = unbounded_channel::<ResultEvent>();
    let mut executor = ScriptedExecutor::new(board.executor.clone());
    let mut cursor = 0;
    let mut correlation = 0;

    while host.core().tick < board.end_tick {
        let tick = host.core().tick;

        while let Some(entry) = board.script.get(cursor).filter(|entry| entry.tick == tick) {
            if let ScriptInput::Edit(cmd) = &entry.input {
                apply_gesture(&mut host, cmd.clone(), |h| minted.get(h as usize).copied())
                    .map_err(|e| format!("{name}: host refused the edit at tick {tick}: {e}"))?;
            } else if let Some(payload) = script_payload(&entry.input, tick, &minted, &mut correlation)
                .map_err(|e| format!("{name}: host script at tick {tick}: {e}"))?
            {
                ingress_tx.send(payload).expect("ingress open");
            }
            cursor += 1;
        }
        for result in executor.due(tick) {
            results_tx.send(result).expect("results open");
        }

        let edit_tick = !host.pending_edits().is_empty();
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("host tick");
        minted.extend(host.core().last_tick.placed.iter().copied());
        while let Ok(cmd) = cmd_rx.try_recv() {
            executor.on_command(tick, &cmd);
        }
        if edit_tick {
            host.set_timers(project_timers(&host.logged_edits().expect("read the edit log")));
        }

        run.step().map_err(|e| format!("{name}: host-free step at tick {tick}: {e}"))?;

        let (host_hash, run_hash) = (tick_hash(host.core()), tick_hash(run.engine().core()));
        if host_hash != run_hash {
            return Err(format!(
                "{name}: differs after the step at tick {tick}: host {host_hash}, host-free {run_hash}"
            ));
        }
    }

    if !run.is_finished() {
        return Err(format!("{name}: the host-free run isn't finished at tick {}", host.core().tick));
    }
    let (host_effects, run_effects): (&[EffectRecord], &[EffectRecord]) = (executor.effects(), run.effects());
    if host_effects != run_effects {
        let first = host_effects.iter().zip(run_effects).find(|(a, b)| a != b);
        return Err(format!(
            "{name}: the effect lists differ: host has {}, host-free has {}, first difference {first:?}",
            host_effects.len(),
            run_effects.len()
        ));
    }
    Ok(run_effects.len())
}

#[test]
fn every_board_gives_the_same_hash_with_the_host_and_without_it() {
    let root = Path::new(BOARDS_DIR);
    let files = board_files(root);

    let mut problems = Vec::new();
    let mut checked = Vec::new();
    for path in &files {
        let name = path.strip_prefix(root).expect("under the boards folder").display().to_string();
        let text = std::fs::read_to_string(path).expect("read the board file");
        let board = parse_board(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        match compare(&name, &board) {
            Ok(effects) => {
                println!("checked {name}: end tick {}, {effects} effects", board.end_tick);
                checked.push((name, effects));
            }
            Err(problem) => {
                println!("FAILED {problem}");
                problems.push(problem);
            }
        }
    }

    assert!(problems.is_empty(), "{} of {} boards differ:\n{}", problems.len(), files.len(), problems.join("\n"));
    assert!(files.len() >= BOARD_FLOOR, "the walk found {} boards: {files:?}", files.len());
    assert!(
        checked.iter().any(|(name, effects)| name.ends_with("script-outcomes.board.ron") && *effects > 0),
        "the docs test board should run and emit effects: {checked:?}"
    );
}
