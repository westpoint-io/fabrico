//! A board runs with its own scripted inputs and outside answers, using only `fabrico-engine`.
//!
//! Each test reads what the run logged, from `StepOutput`, and asserts exact ticks. "A result
//! arrived" would stay true if a reply landed on the wrong tick.

// The workspace-root `clippy.toml` disallows `std::net` to keep the sim core free of ambient IO.
// The socket check binds a real listener beside a run, so the lints are allowed in this one file.
#![allow(clippy::disallowed_types, clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::net::TcpListener;

use fabrico_command::CommandError;
use fabrico_core::command::{Command, EVENT_VERSION, Effect, Outcome, ResultEvent};
use fabrico_core::event::{Event, EventPayload};
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::{CommandId, NodeId};
use fabrico_core::state::HttpMethod;
use fabrico_core::wire::DEFAULT_WIRE_BUDGET;
use fabrico_engine::board::{BoardError, BoardFile, ExecutorSpec, OutboundOutcome, OutcomeRule, parse_board};
use fabrico_engine::envelope::{DEFAULT_ENDPOINT_DEADLINE_TICKS, RequestEnvelope, encode_request_envelope};
use fabrico_engine::scripted::{BoardRun, EffectSummary, ScriptedExecutor};
use fabrico_scenario::tick_hash;
use slotmap::SlotMap;

const BOARD: &str = include_str!("../../../examples/boards/docs/script-outcomes.board.ron");

const SLOW_URL: &str = "https://example.com/slow";
const BAD_URL: &str = "https://example.com/bad";
const LOST_URL: &str = "https://example.com/lost";

// The board's handles, in mint order.
const BAD_SOURCE_SINK: usize = 6;
const LOST_SOURCE_SINK: usize = 9;
const TIMER_SOURCE: usize = 11;
const ROUTE: usize = 14;
const HANDLES: usize = 18;

/// The tick of the board's `Request` entry.
const REQUEST_TICK: u64 = 250;
/// The tick of the board's two `Webhook` entries on one Source.
const PAIR_TICK: u64 = 300;
/// The tick of the board's `Edit`, which puts that Source on a 50-tick Timer.
const EDIT_TICK: u64 = 349;
/// The tick a test's extra script entry goes on: after the boot end, before the board's own.
const EARLY_TICK: u64 = 40;

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

/// The board's text with `entries` added at the head of its script.
fn with_entries(entries: &str) -> String {
    BOARD.replacen("script: [", &format!("script: [\n{entries},"), 1)
}

/// How many faults wait on a handle's fault port once the core has folded `tick`.
fn faults_after(src: &str, handle: usize, tick: u64) -> usize {
    let mut run = BoardRun::boot(parsed(src)).expect("the board boots");
    while run.engine().core().tick <= tick {
        run.step().expect("the step applies");
    }
    run.engine().core().state.inbox_of(run.minted()[handle]).map_or(0, |inbox| inbox.len_on(FAULT_PORT))
}

/// `(core tick, hash)` after each step of a whole run.
fn hashes(src: &str) -> Vec<(u64, String)> {
    let mut run = BoardRun::boot(parsed(src)).expect("the board boots");
    let mut out = Vec::new();
    while !run.is_finished() {
        run.step().expect("the step applies");
        out.push((run.engine().core().tick, tick_hash(run.engine().core())));
    }
    out
}

/// The core tick where two runs first differ, printing both hashes, or `None` if they match.
fn first_difference(a: &[(u64, String)], b: &[(u64, String)]) -> Option<u64> {
    assert_eq!(a.len(), b.len(), "the two runs have different lengths");
    let found = a.iter().zip(b).find(|(x, y)| x != y)?;
    println!("first difference: {:?} against {:?}", found.0, found.1);
    Some(found.0.0)
}

#[test]
fn the_board_mints_the_handles_these_tests_name() {
    let run = BoardRun::boot(parsed(BOARD)).expect("the board boots");
    assert_eq!(run.minted().len(), HANDLES);
}

#[test]
fn an_error_outcome_logs_a_failure_3_ticks_later_and_faults_that_sink() {
    let walked = walk(BOARD);
    let (command_tick, command) = http_command(&walked, BAD_URL);
    let result_tick = command_tick + 3;
    assert_eq!(result_of(&walked, command.id), vec![(result_tick, Outcome::Failure)]);
    assert_eq!(command.id.1, walked.run.minted()[BAD_SOURCE_SINK], "the board's second Sink emitted it");
    assert_eq!(faults_after(BOARD, BAD_SOURCE_SINK, result_tick - 1), 0);
    assert_eq!(faults_after(BOARD, BAD_SOURCE_SINK, result_tick), 1);
}

#[test]
fn a_timeout_outcome_logs_no_result_and_times_out_at_the_deadline() {
    let walked = walk(BOARD);
    let (command_tick, command) = http_command(&walked, LOST_URL);
    assert_eq!(command.deadline, command_tick + 600, "a placed Sink's deadline is 600 ticks");
    assert!(command.deadline < parsed(BOARD).end_tick, "the board has to run past the deadline");
    assert_eq!(result_of(&walked, command.id), vec![]);
    let timeouts: Vec<u64> = walked
        .logged
        .iter()
        .filter(|e| matches!(&e.payload, EventPayload::Timeout { command_id } if *command_id == command.id))
        .map(|e| e.tick)
        .collect();
    assert_eq!(timeouts, vec![command.deadline]);
    assert_eq!(faults_after(BOARD, LOST_SOURCE_SINK, command.deadline - 1), 0);
    assert_eq!(faults_after(BOARD, LOST_SOURCE_SINK, command.deadline), 1);
}

/// A reply slower than the deadline loses to the timeout, and the engine drops it when it arrives.
#[test]
fn a_reply_later_than_the_deadline_loses_to_the_timeout() {
    let src = BOARD.replace("Reply(after_ticks: 40)", "Reply(after_ticks: 700)");
    let walked = walk(&src);
    let (_, command) = http_command(&walked, SLOW_URL);
    assert_eq!(result_of(&walked, command.id), vec![]);
    assert!(
        walked.logged.iter().any(|e| {
            e.tick == command.deadline
                && matches!(&e.payload, EventPayload::Timeout { command_id } if *command_id == command.id)
        }),
        "the call should time out at tick {}",
        command.deadline
    );
}

#[test]
fn a_request_reaches_the_route_and_the_reply_is_in_the_effect_list() {
    let walked = walk(BOARD);
    let requests: Vec<&Event> =
        walked.logged.iter().filter(|e| matches!(&e.payload, EventPayload::WireRequest { .. })).collect();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0].tick, REQUEST_TICK);
    let want = encode_request_envelope(&RequestEnvelope {
        method: "POST".to_owned(),
        path: "/endpoint/hello".to_owned(),
        query: String::new(),
        headers: BTreeMap::new(),
        body: r#"{"name":"docs"}"#.to_owned(),
    });
    match &requests[0].payload {
        EventPayload::WireRequest { correlation, deadline_tick, budget, return_addr, payload } => {
            assert_eq!(*correlation, 0, "the first request takes correlation 0");
            assert_eq!(*deadline_tick, REQUEST_TICK + DEFAULT_ENDPOINT_DEADLINE_TICKS);
            assert_eq!(*budget, DEFAULT_WIRE_BUDGET);
            assert_eq!(*return_addr, (walked.run.minted()[ROUTE], 0));
            assert_eq!(payload.0, want, "a scripted request has the bytes a real one has");
        }
        other => panic!("expected a WireRequest, got {other:?}"),
    }

    let replies: Vec<_> =
        walked.run.effects().iter().filter(|r| matches!(r.effect, EffectSummary::Reply { .. })).collect();
    assert_eq!(replies.len(), 1, "{replies:?}");
    assert!(replies[0].tick > REQUEST_TICK);
    match &replies[0].effect {
        EffectSummary::Reply { correlation, payload } => {
            assert_eq!(*correlation, 0);
            let text = String::from_utf8_lossy(payload);
            assert!(text.contains("hello"), "the Handler's body should be in the reply: {text}");
        }
        other => panic!("expected a reply, got {other:?}"),
    }
    assert_eq!(result_of(&walked, replies[0].command_id), vec![(replies[0].tick + 1, Outcome::Success)]);
}

/// A timer only fires if the runner projects the timers again after the edit. The edit folds on
/// tick 349, so the very next tick is the first multiple of 50 it can fire on.
#[test]
fn a_scripted_edit_to_a_timer_makes_the_source_fire_on_multiples_of_50() {
    let walked = walk(BOARD);
    let source = walked.run.minted()[TIMER_SOURCE];
    let injects: Vec<u64> = walked
        .logged
        .iter()
        .filter(|e| matches!(&e.payload, EventPayload::ManualInject { target, .. } if *target == source))
        .map(|e| e.tick)
        .collect();
    let mut want = vec![PAIR_TICK, PAIR_TICK];
    want.extend((EDIT_TICK + 1..parsed(BOARD).end_tick).filter(|t| t % 50 == 0));
    assert_eq!(want.len(), 15, "2 webhooks and 13 timer fires");
    assert_eq!(injects, want);
}

/// Each item that reaches the Debug sink is answered by the script one tick later.
#[test]
fn debug_effects_are_recorded_and_answered_one_tick_later() {
    let walked = walk(BOARD);
    let debugs: Vec<_> =
        walked.run.effects().iter().filter(|r| matches!(r.effect, EffectSummary::Debug { .. })).collect();
    assert_eq!(debugs.len(), 15, "2 webhooks and 13 timer fires");
    for record in debugs {
        assert_eq!(result_of(&walked, record.command_id), vec![(record.tick + 1, Outcome::Success)]);
    }
}

#[test]
fn an_entry_naming_an_unknown_handle_is_a_typed_error_naming_the_tick() {
    for entry in [
        r#"At(tick: 40, input: Webhook(source: 999, body: "{}"))"#,
        r#"At(tick: 40, input: Request(route: 999, method: "POST", path: "/x", body: "{}"))"#,
    ] {
        let mut run = BoardRun::boot(parsed(&with_entries(entry))).expect("the board boots");
        let want = BoardError::UnknownHandle { tick: EARLY_TICK, handle: 999 };
        assert_eq!(run.run_to_end(), Err(want.clone()), "{entry}");
        assert_eq!(run.engine().core().tick, EARLY_TICK, "the refused tick doesn't fold");
        assert_eq!(run.step().err(), Some(want), "a later step returns the same error");
        assert_eq!(run.engine().core().tick, EARLY_TICK, "and doesn't tick either");
    }
}

#[test]
fn a_refused_scripted_edit_is_a_typed_error_naming_the_tick() {
    for (edit, source) in [
        ("Place(kind: 0, cell_x: 1, cell_y: 2)", CommandError::FootprintCollision),
        ("Delete(node: 999)", CommandError::UnknownNode),
    ] {
        let entry = format!("At(tick: 40, input: Edit({edit}))");
        let mut run = BoardRun::boot(parsed(&with_entries(&entry))).expect("the board boots");
        assert_eq!(run.run_to_end(), Err(BoardError::ScriptEditRefused { tick: EARLY_TICK, source }), "{edit}");
    }
}

/// A handle a scripted edit mints joins the list after its tick folds, as a board's own do.
#[test]
fn a_handle_minted_by_a_scripted_edit_resolves_from_the_next_tick() {
    let place = "At(tick: 40, input: Edit(Place(kind: 0, cell_x: 20, cell_y: 14)))";
    let next_tick = format!(r#"{place}, At(tick: 41, input: Webhook(source: {HANDLES}, body: "{{}}"))"#);
    let walked = walk(&with_entries(&next_tick));
    let new_source = walked.run.minted()[HANDLES];
    assert!(
        walked.logged.iter().any(|e| {
            e.tick == EARLY_TICK + 1
                && matches!(&e.payload, EventPayload::ManualInject { target, .. } if *target == new_source)
        }),
        "the webhook should reach the new Source on tick 41"
    );

    let same_tick = format!(r#"{place}, At(tick: 40, input: Webhook(source: {HANDLES}, body: "{{}}"))"#);
    let mut run = BoardRun::boot(parsed(&with_entries(&same_tick))).expect("the board boots");
    assert_eq!(run.run_to_end(), Err(BoardError::UnknownHandle { tick: EARLY_TICK, handle: HANDLES as u64 }));
}

/// `boot` runs the parser's checks too, so a board built in code can't skip them.
#[test]
fn boot_refuses_a_board_the_parser_would_refuse() {
    let mut board = parsed(BOARD);
    board.end_tick = EARLY_TICK;
    assert!(matches!(BoardRun::boot(board), Err(BoardError::ScriptTickAfterEnd { .. })));
}

#[test]
fn two_entries_on_one_tick_apply_in_file_order() {
    assert_eq!(first_difference(&hashes(BOARD), &hashes(BOARD)), None, "the same text runs the same way");
    let (first, second) = (r#"{"order":"first"}"#, r#"{"order":"second"}"#);
    assert!(BOARD.contains(first) && BOARD.contains(second), "the board has both entries");
    let swapped = BOARD.replace(first, "@@").replace(second, first).replace("@@", second);
    assert_ne!(swapped, BOARD);
    assert_eq!(
        first_difference(&hashes(BOARD), &hashes(&swapped)),
        Some(PAIR_TICK + 1),
        "swapping the two entries should change the hash on the tick they fold"
    );
}

/// Two runs on one thread, stepped in turn. A run with shared global state would drift here.
#[test]
fn two_runs_stepped_alternately_match_at_every_tick() {
    let mut a = BoardRun::boot(parsed(BOARD)).expect("the board boots");
    let mut b = BoardRun::boot(parsed(BOARD)).expect("the board boots");
    assert_eq!(tick_hash(a.engine().core()), tick_hash(b.engine().core()), "after boot");
    while !a.is_finished() {
        a.step().expect("run a steps");
        b.step().expect("run b steps");
        let (ha, hb) = (tick_hash(a.engine().core()), tick_hash(b.engine().core()));
        let tick = a.engine().core().tick;
        assert_eq!(ha, hb, "the runs differ at tick {tick}: {ha} against {hb}");
    }
    assert_eq!(a.effects(), b.effects());
    assert!(!a.effects().is_empty(), "the runs did something");
}

/// A real listener sits on the port the board's sink calls. The run finishes, the effect list shows
/// the call answered by the script, and the listener has no connection waiting.
#[test]
fn a_run_opens_no_socket_even_to_a_listener_on_loopback() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback listener");
    listener.set_nonblocking(true).expect("make accept return at once");
    let url = format!("http://127.0.0.1:{}/slow", listener.local_addr().expect("the listener's address").port());
    let walked = walk(&BOARD.replace(SLOW_URL, &url));

    let (command_tick, command) = http_command(&walked, &url);
    assert_eq!(result_of(&walked, command.id), vec![(command_tick + 40, Outcome::Success)]);
    assert!(walked.run.effects().iter().any(|r| {
        r.outcome == (OutboundOutcome::Reply { after_ticks: 40 })
            && matches!(&r.effect, EffectSummary::Http { url: u, .. } if *u == url)
    }));

    match listener.accept() {
        Err(e) if e.kind() == ErrorKind::WouldBlock => {}
        Ok((_, peer)) => panic!("the run connected to the listener from {peer}"),
        Err(e) => panic!("accept failed for another reason: {e}"),
    }
}

/// The first rule that matches wins, in file order, and otherwise the default applies. Effects that
/// never leave a host get a success one tick later, whatever the rules say.
#[test]
fn the_first_matching_rule_wins_and_the_default_covers_the_rest() {
    let rule = |url_prefix: &str, outcome| OutcomeRule { url_prefix: url_prefix.to_owned(), outcome };
    let mut executor = ScriptedExecutor::new(ExecutorSpec {
        default: OutboundOutcome::Timeout,
        rules: vec![
            rule("https://example.com/a", OutboundOutcome::Reply { after_ticks: 2 }),
            rule("https://example.com/", OutboundOutcome::Error { after_ticks: 3 }),
        ],
    });
    let mut nodes: SlotMap<NodeId, ()> = SlotMap::with_key();
    let node = nodes.insert(());
    let command = |seq, effect| Command { event_version: EVENT_VERSION, id: (5, node, seq), partition: 0, effect, deadline: 100 };
    let http = |url: &str| Effect::Http { url: url.to_owned(), body: Vec::new(), method: HttpMethod::Post };

    executor.on_command(5, &command(0, http("https://example.com/a/b")));
    executor.on_command(5, &command(1, http("https://example.com/c")));
    executor.on_command(5, &command(2, http("https://elsewhere.example.com/")));
    executor.on_command(5, &command(3, Effect::Noop));
    executor.on_command(5, &command(4, Effect::Debug { message: b"m".to_vec() }));

    let result = |seq, outcome| ResultEvent { command_id: (5, node, seq), tick: 0, outcome };
    assert_eq!(executor.due(6), vec![result(3, Outcome::Success), result(4, Outcome::Success)]);
    assert_eq!(executor.due(7), vec![result(0, Outcome::Success)]);
    assert_eq!(executor.due(8), vec![result(1, Outcome::Failure)]);
    assert_eq!(executor.due(9), vec![], "a Timeout queues nothing");
    assert_eq!(executor.due(6), vec![], "a result comes out once");
    assert_eq!(executor.effects().len(), 5);
    assert_eq!(executor.effects()[2].outcome, OutboundOutcome::Timeout);
}
