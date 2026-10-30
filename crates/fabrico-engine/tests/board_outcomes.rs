//! A board runs with its own scripted inputs and outside answers, using only `fabrico-engine`.
//!
//! Each test reads what the run logged, from `StepOutput`, and asserts exact ticks. "A result
//! arrived" would stay true if a reply landed on the wrong tick.

use fabrico_core::command::{Command, Effect, Outcome};
use fabrico_core::event::{Event, EventPayload};
use fabrico_core::ids::CommandId;
use fabrico_core::state::HttpMethod;
use fabrico_engine::board::{BoardFile, OutboundOutcome, parse_board};
use fabrico_engine::scripted::{BoardRun, EffectSummary};

const BOARD: &str = include_str!("../../../examples/boards/docs/script-outcomes.board.ron");

const SLOW_URL: &str = "https://example.com/slow";

fn parsed(src: &str) -> BoardFile {
    parse_board(src).expect("the board parses")
}

/// What one whole run did, tick by tick.
struct Walked {
    run: BoardRun,
    /// Every event the run logged after boot.
    logged: Vec<Event>,
    /// Every command the run emitted after boot, with the tick that emitted it.
    commands: Vec<(u64, Command)>,
    /// `(tick stepped, in-flight count after that step)`.
    in_flight: Vec<(u64, usize)>,
}

fn walk(src: &str) -> Walked {
    let mut run = BoardRun::boot(parsed(src)).expect("the board boots");
    let (mut logged, mut commands, mut in_flight) = (Vec::new(), Vec::new(), Vec::new());
    while !run.is_finished() {
        let tick = run.engine().core().tick;
        let out = run.step().expect("the step applies");
        logged.extend(out.inbound);
        commands.extend(out.commands.into_iter().map(|c| (tick, c)));
        in_flight.push((tick, run.engine().in_flight_len()));
    }
    Walked { run, logged, commands, in_flight }
}

/// The one HTTP command to a URL, with the tick that emitted it.
fn http_command<'a>(walked: &'a Walked, want: &str) -> (u64, &'a Command) {
    let found: Vec<_> = walked
        .commands
        .iter()
        .filter(|(_, c)| matches!(&c.effect, Effect::Http { url, .. } if url == want))
        .collect();
    assert_eq!(found.len(), 1, "expected one command to {want}, got {found:?}");
    (found[0].0, &found[0].1)
}

/// The logged result of a command: `(tick logged, outcome)`.
fn result_of(walked: &Walked, id: CommandId) -> Vec<(u64, Outcome)> {
    walked
        .logged
        .iter()
        .filter_map(|e| match &e.payload {
            EventPayload::CommandResult(r) if r.command_id == id => Some((e.tick, r.outcome.clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn the_board_file_parses() {
    let board = parsed(BOARD);
    assert_eq!(board.format, 1);
    assert!(board.end_tick > board.script.last().expect("the board has a script").tick);
}

#[test]
fn a_run_finishes_at_exactly_its_end_tick() {
    let board = parsed(BOARD);
    let end_tick = board.end_tick;
    let mut run = BoardRun::boot(board).expect("the board boots");
    assert!(!run.is_finished());
    run.run_to_end().expect("the run ends");
    assert!(run.is_finished());
    assert_eq!(run.engine().core().tick, end_tick);
}

#[test]
fn the_scripted_reply_is_logged_exactly_40_ticks_after_the_command() {
    let walked = walk(BOARD);
    let (command_tick, command) = http_command(&walked, SLOW_URL);
    assert!(command_tick > 60, "the webhook at tick 60 had to cross two belts first");
    assert_eq!(result_of(&walked, command.id), vec![(command_tick + 40, Outcome::Success)]);
}

#[test]
fn the_effect_list_has_one_record_for_the_call() {
    let walked = walk(BOARD);
    let (command_tick, command) = http_command(&walked, SLOW_URL);
    let records: Vec<_> = walked
        .run
        .effects()
        .iter()
        .filter(|r| matches!(&r.effect, EffectSummary::Http { url, .. } if url == SLOW_URL))
        .collect();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0].tick, command_tick);
    assert_eq!(records[0].command_id, command.id);
    assert_eq!(records[0].outcome, OutboundOutcome::Reply { after_ticks: 40 });
    match &records[0].effect {
        EffectSummary::Http { method, .. } => assert_eq!(*method, HttpMethod::Post),
        other => panic!("expected an HTTP record, got {other:?}"),
    }
}

/// This call is the board's first, and it finishes before the script starts anything else, so the
/// count is exactly 1 while it is out and exactly 0 once it is answered.
#[test]
fn the_in_flight_count_falls_back_after_the_result() {
    let walked = walk(BOARD);
    let (command_tick, _) = http_command(&walked, SLOW_URL);
    let count_at = |tick: u64| {
        walked.in_flight.iter().find(|(t, _)| *t == tick).map(|(_, n)| *n).expect("the tick was stepped")
    };
    assert_eq!(count_at(command_tick - 1), 0);
    assert_eq!(count_at(command_tick), 1);
    assert_eq!(count_at(command_tick + 39), 1);
    assert_eq!(count_at(command_tick + 40), 0);
}
