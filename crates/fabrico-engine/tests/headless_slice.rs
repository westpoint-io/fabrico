//! The whole path with no host: an [`Engine`] takes gestures, ticks, and turns a real item into
//! a command for the outside world.
//!
//! This file uses only `fabrico-engine` and its dev dependencies. `fabrico-host` isn't among
//! them, so the test can't compile if the path needs the host.

use fabrico_core::command::{Command, Effect};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_engine::engine::Engine;
use fabrico_engine::gesture::apply_gesture;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

/// How many ticks an injected item gets to reach the Sink before the test fails. The belt is
/// three cells long, so a working board takes far fewer.
const TICK_BOUND: u32 = 200;

/// A fresh engine holding nothing, on a fixed seed.
fn fresh_engine() -> Engine {
    Engine::from_core(Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 7,
    }))
}

/// Source at (1,6), a three-cell belt, Sink at (5,6), and the two Docks that join them, as
/// handles 0, 1 and 2 in the order the core mints them.
fn board_commands() -> Vec<GridCommand> {
    vec![
        GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 1, cell_y: 6 },
        GridCommand::Place { kind: machine_kind::SINK, cell_x: 5, cell_y: 6 },
        GridCommand::DrawBelt { cells: vec![(2, 6), (3, 6), (4, 6)] },
        GridCommand::Dock { belt: 2, endpoint: BeltEnd::Tail, node: 0, port: 0 },
        GridCommand::Dock { belt: 2, endpoint: BeltEnd::Head, node: 1, port: 0 },
    ]
}

/// Applies each command and folds it in its own tick, the way a scene is seeded, and returns
/// the minted nodes in handle order.
fn build_board(engine: &mut Engine) -> Vec<NodeId> {
    let mut minted: Vec<NodeId> = Vec::new();
    for cmd in board_commands() {
        let what = format!("{cmd:?}");
        apply_gesture(engine, cmd, |h| minted.get(h as usize).copied())
            .unwrap_or_else(|e| panic!("the engine refused {what}: {e:?}"));
        engine.step(vec![], vec![]);
        minted.extend(engine.core().last_tick.placed.iter().copied());
    }
    assert_eq!(minted.len(), 3, "two machines and a belt were minted");
    minted
}

/// Injects one item at the Source and steps until the Sink emits, failing past [`TICK_BOUND`].
fn run_item_to_a_command(engine: &mut Engine, source: NodeId) -> Command {
    let inject = EventPayload::ManualInject { target: source, port: 0, item: Item(b"{}".to_vec()) };
    let mut ingress = vec![inject];
    for _ in 0..TICK_BOUND {
        let output = engine.step(std::mem::take(&mut ingress), vec![]);
        if let Some(command) = output.commands.into_iter().next() {
            return command;
        }
    }
    panic!("no command after {TICK_BOUND} ticks: the item never reached the Sink");
}

#[test]
fn an_engine_with_no_host_turns_a_gesture_built_board_and_an_item_into_a_command() {
    let mut engine = fresh_engine();
    let minted = build_board(&mut engine);
    assert_eq!(engine.in_flight_len(), 0, "nothing is in flight before the item goes in");

    let command = run_item_to_a_command(&mut engine, minted[0]);

    match &command.effect {
        Effect::Debug { message } => {
            assert_eq!(message.as_slice(), b"{}", "the Sink carries the injected bytes");
        }
        other => panic!("a default Sink emits a Debug effect, this one emitted {other:?}"),
    }
    assert_eq!(command.id.1, minted[1], "the Sink is the node that emitted the command");
    assert_eq!(engine.in_flight_len(), 1, "the emitted command is recorded as in flight");
}

#[test]
fn a_refused_gesture_changes_nothing_on_an_engine_with_no_host() {
    let mut engine = fresh_engine();
    let minted = build_board(&mut engine);
    let tick = engine.core().tick;

    // The Source's cell is taken, so a second machine there is refused.
    let refused = apply_gesture(
        &mut engine,
        GridCommand::Place { kind: machine_kind::SINK, cell_x: 1, cell_y: 6 },
        |h| minted.get(h as usize).copied(),
    );

    assert!(refused.is_err(), "a Place on a taken cell is refused");
    assert!(engine.pending_edits().is_empty(), "a refused gesture enqueues nothing");
    assert_eq!(engine.core().tick, tick, "a refused gesture does not advance the core");
}
