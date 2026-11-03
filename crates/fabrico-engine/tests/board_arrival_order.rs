//! A board played as written and with its same-tick inputs reversed, compared at every tick.
//!
//! `examples/boards/docs/arrival-order.board.ron` sends same-tick webhooks to different Sources, so
//! its run can't depend on the order they arrive in: the two runs give the same hash after every
//! tick. A variant of the same board that sends those webhooks to one Source is order-sensitive by
//! design (`fabrico-core`'s `cert_arrival_order.rs` says why), so the same comparison has to find a
//! tick where the two runs differ. That variant is the comparison's standing failure: if it stopped
//! differing, the comparison would no longer be able to tell the two cases apart.

// The board file lives on disk.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeSet;

use fabrico_engine::board::{BoardFile, ScriptInput, parse_board, reverse_same_tick_runs};
use fabrico_engine::scripted::BoardRun;
use fabrico_scenario::tick_hash;

const ARRIVAL_ORDER: &str = include_str!("../../../examples/boards/docs/arrival-order.board.ron");

fn arrival_order() -> BoardFile {
    parse_board(ARRIVAL_ORDER).expect("the arrival-order board parses")
}

/// The same board with its script reversed inside each tick.
fn reversed(board: &BoardFile) -> BoardFile {
    BoardFile { script: reverse_same_tick_runs(&board.script), ..board.clone() }
}

/// Step two runs of the same length together and return the first core tick whose hash differs,
/// or `None` when every tick matched. The tick is the one the core reached after the step.
fn first_differing_tick(forward: BoardFile, backward: BoardFile) -> Option<u64> {
    let mut one = BoardRun::boot(forward).expect("the forward board boots");
    let mut two = BoardRun::boot(backward).expect("the reversed board boots");
    if tick_hash(one.engine().core()) != tick_hash(two.engine().core()) {
        return Some(one.engine().core().tick);
    }
    while !one.is_finished() {
        one.step().expect("the forward board steps");
        two.step().expect("the reversed board steps");
        let tick = one.engine().core().tick;
        assert_eq!(tick, two.engine().core().tick, "the two runs step in lockstep");
        if tick_hash(one.engine().core()) != tick_hash(two.engine().core()) {
            return Some(tick);
        }
    }
    None
}

/// The ticks that send a webhook to at least two different Sources, with how many Sources each.
fn ticks_with_distinct_sources(board: &BoardFile) -> Vec<(u64, usize)> {
    let mut by_tick: Vec<(u64, BTreeSet<u64>)> = Vec::new();
    for entry in &board.script {
        if let ScriptInput::Webhook { source, .. } = entry.input {
            match by_tick.last_mut() {
                Some((tick, sources)) if *tick == entry.tick => {
                    sources.insert(source);
                }
                _ => by_tick.push((entry.tick, BTreeSet::from([source]))),
            }
        }
    }
    by_tick.into_iter().filter(|(_, sources)| sources.len() >= 2).map(|(tick, sources)| (tick, sources.len())).collect()
}

#[test]
fn the_board_has_two_ticks_that_each_send_a_webhook_to_distinct_sources() {
    let board = arrival_order();
    let ticks = ticks_with_distinct_sources(&board);
    assert!(ticks.len() >= 2, "ticks with webhooks to 2 or more Sources: {ticks:?}");
    for (tick, sources) in &ticks {
        let entries = board.script.iter().filter(|entry| entry.tick == *tick).count();
        assert_eq!(entries, *sources, "tick {tick} sends exactly one webhook to each of its Sources");
    }
}

#[test]
fn reversing_the_board_changes_its_script() {
    let board = arrival_order();
    assert_ne!(reverse_same_tick_runs(&board.script), board.script, "a reversal that changes nothing proves nothing");
}

#[test]
fn the_board_and_its_reversed_copy_match_after_every_tick() {
    let board = arrival_order();
    let backward = reversed(&board);
    assert_eq!(first_differing_tick(board, backward), None);
}

/// The order-sensitive case: every webhook goes to the first Source, so each same-tick run queues
/// its items in the order they arrive. Reversed, the runs have to differ at some tick.
#[test]
fn a_variant_that_sends_every_webhook_to_one_source_differs_when_reversed() {
    let mut board = arrival_order();
    for entry in &mut board.script {
        if let ScriptInput::Webhook { source, .. } = &mut entry.input {
            *source = 0;
        }
    }
    let backward = reversed(&board);
    let tick = first_differing_tick(board, backward);
    println!("the same-Source variant first differs at tick {tick:?}");
    assert!(tick.is_some(), "the same-Source variant matched at every tick, so the comparison can't fail");
}
