//! A board file: the one data format an example, a test and a docs page all read.
//!
//! A board is plain RON text at `examples/boards/<name>.board.ron`. It holds a format version, a
//! seed, the list of [`GridCommand`]s that build the board, a track of scripted inputs, the
//! answers a scripted run gives to outbound calls, a view hint and the tick a scripted run ends
//! on. It isn't a `.fab` save: the app refuses a save at each version bump, and a board is source
//! text a person edits.
//!
//! [`parse_board`] takes a string and reads no file. Everything it can be handed comes back as a
//! typed [`BoardError`], so a bad board can't panic. [`boot_engine`] builds the board on an
//! [`Engine`] through [`apply_gesture`], the path a user's own gesture takes, so a board can only
//! do what a user can.
//!
//! The app ignores `script`, `executor` and `end_tick`, so an example in the app needs a real
//! webhook or a timer to move.

use fabrico_command::CommandError;
use fabrico_core::ids::NodeId;
use fabrico_protocol::GridCommand;
use serde::Deserialize;

use crate::engine::Engine;
use crate::gesture::apply_gesture;
use crate::timer::project_timers;

/// The one board format this build reads. The check is exact in both directions, so an older
/// board and a newer one are both refused by name. There is no shim.
pub const BOARD_FORMAT: u32 = 1;

/// The ticks a boot folds after a board's last command: the history seal, one record in one tick.
/// A booted core therefore sits at `commands.len() + HISTORY_SEAL_TICKS`, which is the boot end.
pub const HISTORY_SEAL_TICKS: u64 = 1;

/// One board file, as parsed.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename = "Board", deny_unknown_fields)]
pub struct BoardFile {
    /// The format version, always [`BOARD_FORMAT`] once parsed.
    pub format: u32,
    /// The genesis seed the board boots on.
    pub seed: u64,
    /// The commands that build the board, applied in file order, one per tick. Dense handles
    /// resolve in the order these commands mint nodes.
    pub commands: Vec<GridCommand>,
    /// Scripted inputs in tick order. Entries on one tick apply in file order.
    pub script: Vec<ScriptEntry>,
    /// What a scripted run answers when the board calls out.
    pub executor: ExecutorSpec,
    /// How a viewer frames the board.
    pub view: ViewHints,
    /// The core tick a scripted run stops on.
    pub end_tick: u64,
}

/// One scripted input and the core tick it applies on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename = "At", deny_unknown_fields)]
pub struct ScriptEntry {
    /// An absolute core tick, later than the boot end.
    pub tick: u64,
    /// What arrives on that tick.
    pub input: ScriptInput,
}

/// What a script can feed a running board.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub enum ScriptInput {
    /// A webhook body delivered to a Source, addressed by its dense handle.
    Webhook {
        /// The Source's dense handle.
        source: u64,
        /// The request body.
        body: String,
    },
    /// An HTTP request delivered to a Route, addressed by its dense handle.
    Request {
        /// The Route's dense handle.
        route: u64,
        /// The HTTP method.
        method: String,
        /// The request path.
        path: String,
        /// The request body.
        body: String,
    },
    /// A command applied the way a user's gesture is.
    Edit(GridCommand),
}

/// The answers a scripted run gives to outbound calls.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename = "Executor", deny_unknown_fields)]
pub struct ExecutorSpec {
    /// The answer to any call no rule matches.
    pub default: OutboundOutcome,
    /// Answers by URL prefix, first match wins.
    pub rules: Vec<OutcomeRule>,
}

/// An answer for every outbound URL that starts with a prefix.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename = "Rule", deny_unknown_fields)]
pub struct OutcomeRule {
    /// The URL prefix this rule matches.
    pub url_prefix: String,
    /// The answer it gives.
    pub outcome: OutboundOutcome,
}

/// How one outbound call ends. A command emitted on tick T has already folded, so the earliest
/// answer arrives on T+1, and `after_ticks` is at least 1.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub enum OutboundOutcome {
    /// A successful reply after this many ticks.
    Reply {
        /// Ticks until the reply, at least 1.
        after_ticks: u64,
    },
    /// A failure after this many ticks.
    Error {
        /// Ticks until the failure, at least 1.
        after_ticks: u64,
    },
    /// No answer at all, so the call runs into its deadline.
    Timeout,
}

/// How a viewer frames the board.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename = "View", deny_unknown_fields)]
pub struct ViewHints {
    /// What the view fits to.
    pub fit: ViewFit,
}

/// What a view fits to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub enum ViewFit {
    /// The whole board.
    Board,
}

/// Why a board file was refused. It is a value, never a panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoardError {
    /// The text isn't RON or doesn't have a board's shape. Carries the line and column.
    Parse(ron::error::SpannedError),
    /// The format field isn't the one this build reads.
    UnknownFormat(u32),
    /// The board has no commands, or its commands minted no node.
    EmptyBoard,
    /// An outcome says `after_ticks: 0`.
    ZeroAfterTicks,
    /// An outcome's `after_ticks` is larger than the board's `end_tick`, so its answer could only
    /// land after the run has stopped.
    AfterTicksPastEnd {
        /// The outcome's delay.
        after_ticks: u64,
        /// The board's end tick.
        end_tick: u64,
    },
    /// A script entry falls at or before the boot end.
    ScriptTickBeforeBoot {
        /// The entry's tick.
        tick: u64,
        /// The tick the boot ends on.
        boot_end: u64,
    },
    /// A script entry has a lower tick than the one before it.
    ScriptOutOfOrder {
        /// The entry's tick.
        tick: u64,
    },
    /// `end_tick` falls before the boot end.
    EndTickBeforeBoot {
        /// The board's end tick.
        end_tick: u64,
        /// The tick the boot ends on.
        boot_end: u64,
    },
    /// A script entry falls on or after `end_tick`, so a run would stop before applying it. A run
    /// ends once the core reaches `end_tick`, so the last tick that folds is the one before it.
    ScriptTickAfterEnd {
        /// The entry's tick.
        tick: u64,
        /// The board's end tick.
        end_tick: u64,
    },
    /// A command in the board was refused while it was being applied.
    Command(CommandError),
    /// A script entry names a handle that no command has minted by its tick.
    UnknownHandle {
        /// The entry's tick.
        tick: u64,
        /// The handle it names.
        handle: u64,
    },
    /// The command layer refused a scripted edit.
    ScriptEditRefused {
        /// The entry's tick.
        tick: u64,
        /// Why it was refused.
        source: CommandError,
    },
}

impl std::fmt::Display for BoardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(e) => write!(f, "the board file failed to parse: {e}"),
            Self::UnknownFormat(found) => {
                write!(f, "the board file has format {found}, and this build reads format {BOARD_FORMAT}")
            }
            Self::EmptyBoard => write!(f, "the board has no commands that mint a node"),
            Self::ZeroAfterTicks => write!(f, "an outcome has after_ticks: 0, and the earliest answer is 1 tick later"),
            Self::AfterTicksPastEnd { after_ticks, end_tick } => {
                write!(f, "an outcome has after_ticks: {after_ticks}, and the run ends at tick {end_tick}")
            }
            Self::ScriptTickBeforeBoot { tick, boot_end } => {
                write!(f, "a script entry at tick {tick} is at or before the boot end, tick {boot_end}")
            }
            Self::ScriptOutOfOrder { tick } => {
                write!(f, "the script entry at tick {tick} is earlier than the one before it")
            }
            Self::EndTickBeforeBoot { end_tick, boot_end } => {
                write!(f, "end_tick {end_tick} is before the boot end, tick {boot_end}")
            }
            Self::ScriptTickAfterEnd { tick, end_tick } => {
                write!(f, "a script entry at tick {tick} would never apply, because the run ends at tick {end_tick}")
            }
            Self::Command(e) => write!(f, "a board command was refused: {e}"),
            Self::UnknownHandle { tick, handle } => {
                write!(f, "the script entry at tick {tick} names handle {handle}, which isn't minted yet")
            }
            Self::ScriptEditRefused { tick, source } => {
                write!(f, "the scripted edit at tick {tick} was refused: {source}")
            }
        }
    }
}

impl std::error::Error for BoardError {}

impl From<CommandError> for BoardError {
    fn from(e: CommandError) -> Self {
        Self::Command(e)
    }
}

/// Only the format field, so the version is read before the shape: a newer file can change every
/// other field and still get [`BoardError::UnknownFormat`]. RON skips the fields this struct
/// doesn't name, which a test holds it to.
#[derive(Deserialize)]
#[serde(rename = "Board")]
struct FormatOnly {
    format: u32,
}

/// Parse and check a board file's text.
///
/// # Errors
/// [`BoardError`] names what is wrong with the text.
pub fn parse_board(src: &str) -> Result<BoardFile, BoardError> {
    let FormatOnly { format } = ron::from_str(src).map_err(BoardError::Parse)?;
    if format != BOARD_FORMAT {
        return Err(BoardError::UnknownFormat(format));
    }
    let board: BoardFile = ron::from_str(src).map_err(BoardError::Parse)?;
    validate(&board)?;
    Ok(board)
}

/// The checks RON can't make. The boot end comes from the command count because each command
/// takes one tick.
pub(crate) fn validate(board: &BoardFile) -> Result<(), BoardError> {
    if board.commands.is_empty() {
        return Err(BoardError::EmptyBoard);
    }
    let outcomes = || std::iter::once(&board.executor.default).chain(board.executor.rules.iter().map(|rule| &rule.outcome));
    for outcome in outcomes() {
        if matches!(outcome, OutboundOutcome::Reply { after_ticks: 0 } | OutboundOutcome::Error { after_ticks: 0 }) {
            return Err(BoardError::ZeroAfterTicks);
        }
    }
    let boot_end = board.commands.len() as u64 + HISTORY_SEAL_TICKS;
    let mut previous = 0;
    for entry in &board.script {
        if entry.tick <= boot_end {
            return Err(BoardError::ScriptTickBeforeBoot { tick: entry.tick, boot_end });
        }
        if entry.tick < previous {
            return Err(BoardError::ScriptOutOfOrder { tick: entry.tick });
        }
        previous = entry.tick;
    }
    if board.end_tick < boot_end {
        return Err(BoardError::EndTickBeforeBoot { end_tick: board.end_tick, boot_end });
    }
    if let Some(entry) = board.script.iter().find(|entry| entry.tick >= board.end_tick) {
        return Err(BoardError::ScriptTickAfterEnd { tick: entry.tick, end_tick: board.end_tick });
    }
    for outcome in outcomes() {
        if let OutboundOutcome::Reply { after_ticks } | OutboundOutcome::Error { after_ticks } = outcome
            && *after_ticks > board.end_tick
        {
            return Err(BoardError::AfterTicksPastEnd { after_ticks: *after_ticks, end_tick: board.end_tick });
        }
    }
    Ok(())
}

/// Build `board` on `engine`, which must be a fresh genesis at `board.seed`, and return the minted
/// nodes in handle order: handle `h` is element `h`.
///
/// One command per tick, so each command's targets folded a tick before it and a board's dense
/// handles resolve the way they do on a user's own board. Then the history seal, in one more tick,
/// so the board's own commands aren't undo steps. The timers come last, projected from the log the
/// boot just wrote: a timer installed earlier fires into a half-built board.
///
/// # Errors
/// [`BoardError::Command`] if a command is refused, and [`BoardError::EmptyBoard`] if the commands
/// minted nothing.
pub fn boot_engine(engine: &mut Engine, board: &BoardFile) -> Result<Vec<NodeId>, BoardError> {
    let mut minted: Vec<NodeId> = Vec::new();
    for cmd in &board.commands {
        apply_gesture(engine, cmd.clone(), |h| minted.get(h as usize).copied())?;
        engine.step(vec![], vec![]);
        minted.extend(engine.core().last_tick.placed.iter().copied());
    }
    engine.seal_history();
    engine.step(vec![], vec![]);
    if minted.is_empty() {
        return Err(BoardError::EmptyBoard);
    }
    let timers = project_timers(engine.session().edit_log());
    engine.set_timers(timers);
    Ok(minted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::core::Core;
    use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
    use proptest::prelude::*;

    /// A one-command board with the rest of its fields spelled out, so a test changes one thing.
    fn board_text(format: u32, commands: &str, script: &str, executor: &str, end_tick: u64) -> String {
        format!(
            "Board(format: {format}, seed: 7, commands: [{commands}], script: [{script}], \
             executor: {executor}, view: View(fit: Board), end_tick: {end_tick})"
        )
    }

    const ONE_PLACE: &str = "Place(kind: 0, cell_x: 1, cell_y: 3)";
    const PLAIN_EXECUTOR: &str = "Executor(default: Reply(after_ticks: 1), rules: [])";

    /// One command plus the seal, so a one-command board's boot ends on tick 2.
    const ONE_PLACE_BOOT_END: u64 = 2;

    fn webhook_at(tick: u64, body: &str) -> String {
        format!(r#"At(tick: {tick}, input: Webhook(source: 0, body: "{body}"))"#)
    }

    fn fresh_engine(seed: u64) -> Engine {
        Engine::from_core(Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed }))
    }

    /// The version comes first: a newer file with a field this build has never heard of still
    /// gets the format error, rather than a parse error about the field.
    #[test]
    fn a_newer_format_with_an_unknown_field_is_refused_by_its_format() {
        let src = "Board(format: 99, warp_drive: Engaged(level: 3), commands: \"later\")";
        assert_eq!(parse_board(src), Err(BoardError::UnknownFormat(99)));
    }

    /// The check is exact in both directions, so an older number is refused the same way.
    #[test]
    fn an_older_format_is_refused_too() {
        let src = board_text(0, ONE_PLACE, "", PLAIN_EXECUTOR, 900);
        assert_eq!(parse_board(&src), Err(BoardError::UnknownFormat(0)));
    }

    #[test]
    fn garbage_and_empty_text_are_parse_errors_with_a_position() {
        for src in ["this is not ron [[[", "", "Board(", "Board(format: \"one\")"] {
            match parse_board(src) {
                Err(BoardError::Parse(e)) => {
                    assert!(e.span.start.line >= 1 && e.span.start.col >= 1, "{src:?}: {e:?}");
                }
                other => panic!("{src:?} should be a parse error, got {other:?}"),
            }
        }
    }

    /// In the format this build reads, a misspelt or stray field is an error rather than a line
    /// that does nothing.
    #[test]
    fn a_stray_field_in_the_current_format_is_a_parse_error() {
        let src = board_text(1, ONE_PLACE, "", PLAIN_EXECUTOR, 900).replace("seed: 7,", "seed: 7, sneed: 8,");
        assert!(matches!(parse_board(&src), Err(BoardError::Parse(_))), "{src}");
    }

    #[test]
    fn an_empty_command_list_is_refused_and_an_empty_script_and_rule_list_are_fine() {
        assert_eq!(
            parse_board(&board_text(1, "", "", PLAIN_EXECUTOR, 900)),
            Err(BoardError::EmptyBoard)
        );
        let board = parse_board(&board_text(1, ONE_PLACE, "", PLAIN_EXECUTOR, 900)).expect("a valid board");
        assert!(board.script.is_empty());
        assert!(board.executor.rules.is_empty());
        assert_eq!(board.commands.len(), 1);
        assert_eq!(board.seed, 7);
        assert_eq!(board.end_tick, 900);
        assert_eq!(board.view.fit, ViewFit::Board);
    }

    /// A zero anywhere an answer can come from is refused: the default, or a rule of either kind.
    #[test]
    fn after_ticks_zero_is_refused_wherever_it_appears() {
        for executor in [
            "Executor(default: Reply(after_ticks: 0), rules: [])",
            "Executor(default: Error(after_ticks: 0), rules: [])",
            r#"Executor(default: Timeout, rules: [Rule(url_prefix: "https://a", outcome: Reply(after_ticks: 0))])"#,
            r#"Executor(default: Timeout, rules: [Rule(url_prefix: "https://a", outcome: Error(after_ticks: 0))])"#,
        ] {
            assert_eq!(
                parse_board(&board_text(1, ONE_PLACE, "", executor, 900)),
                Err(BoardError::ZeroAfterTicks),
                "{executor}"
            );
        }
    }

    /// A delay past the end tick is refused wherever an answer can come from, with `u64::MAX` as
    /// the case that used to panic in a debug build and act as no answer in a release one. A delay
    /// equal to the end tick is the largest one accepted.
    #[test]
    fn after_ticks_past_the_end_tick_is_refused_wherever_it_appears() {
        for after_ticks in [901, u64::MAX] {
            for executor in [
                format!("Executor(default: Reply(after_ticks: {after_ticks}), rules: [])"),
                format!("Executor(default: Error(after_ticks: {after_ticks}), rules: [])"),
                format!(r#"Executor(default: Timeout, rules: [Rule(url_prefix: "https://a", outcome: Reply(after_ticks: {after_ticks}))])"#),
                format!(r#"Executor(default: Timeout, rules: [Rule(url_prefix: "https://a", outcome: Error(after_ticks: {after_ticks}))])"#),
            ] {
                assert_eq!(
                    parse_board(&board_text(1, ONE_PLACE, "", &executor, 900)),
                    Err(BoardError::AfterTicksPastEnd { after_ticks, end_tick: 900 }),
                    "{executor}"
                );
            }
        }
        let at_end = "Executor(default: Reply(after_ticks: 900), rules: [])";
        assert!(parse_board(&board_text(1, ONE_PLACE, "", at_end, 900)).is_ok());
    }

    #[test]
    fn a_script_entry_at_the_boot_end_is_refused_and_one_tick_later_is_accepted() {
        let at_end = board_text(1, ONE_PLACE, &webhook_at(ONE_PLACE_BOOT_END, "a"), PLAIN_EXECUTOR, 900);
        assert_eq!(
            parse_board(&at_end),
            Err(BoardError::ScriptTickBeforeBoot { tick: ONE_PLACE_BOOT_END, boot_end: ONE_PLACE_BOOT_END })
        );
        let after = board_text(1, ONE_PLACE, &webhook_at(ONE_PLACE_BOOT_END + 1, "a"), PLAIN_EXECUTOR, 900);
        let board = parse_board(&after).expect("an entry one tick after the boot end is valid");
        assert_eq!(board.script[0].tick, ONE_PLACE_BOOT_END + 1);
    }

    #[test]
    fn script_ticks_running_backwards_are_refused() {
        let script = format!("{}, {}", webhook_at(50, "a"), webhook_at(40, "b"));
        assert_eq!(
            parse_board(&board_text(1, ONE_PLACE, &script, PLAIN_EXECUTOR, 900)),
            Err(BoardError::ScriptOutOfOrder { tick: 40 })
        );
    }

    #[test]
    fn two_entries_on_one_tick_are_accepted_and_keep_file_order() {
        let script = format!("{}, {}, {}", webhook_at(50, "first"), webhook_at(50, "second"), webhook_at(51, "third"));
        let board = parse_board(&board_text(1, ONE_PLACE, &script, PLAIN_EXECUTOR, 900)).expect("a valid script");
        let bodies: Vec<&str> = board
            .script
            .iter()
            .map(|entry| match &entry.input {
                ScriptInput::Webhook { body, .. } => body.as_str(),
                other => panic!("expected a webhook, got {other:?}"),
            })
            .collect();
        assert_eq!(bodies, ["first", "second", "third"]);
    }

    #[test]
    fn an_end_tick_before_the_boot_end_is_refused_and_one_on_it_is_accepted() {
        assert_eq!(
            parse_board(&board_text(1, ONE_PLACE, "", PLAIN_EXECUTOR, ONE_PLACE_BOOT_END - 1)),
            Err(BoardError::EndTickBeforeBoot { end_tick: ONE_PLACE_BOOT_END - 1, boot_end: ONE_PLACE_BOOT_END })
        );
        assert!(parse_board(&board_text(1, ONE_PLACE, "", PLAIN_EXECUTOR, ONE_PLACE_BOOT_END)).is_ok());
    }

    /// A run stops when the core reaches `end_tick`, so an entry on that tick would never apply.
    #[test]
    fn a_script_entry_on_the_end_tick_is_refused_and_one_tick_earlier_is_accepted() {
        let on_end = board_text(1, ONE_PLACE, &webhook_at(50, "a"), PLAIN_EXECUTOR, 50);
        assert_eq!(parse_board(&on_end), Err(BoardError::ScriptTickAfterEnd { tick: 50, end_tick: 50 }));
        let past_end = board_text(1, ONE_PLACE, &webhook_at(60, "a"), PLAIN_EXECUTOR, 50);
        assert_eq!(parse_board(&past_end), Err(BoardError::ScriptTickAfterEnd { tick: 60, end_tick: 50 }));
        let before_end = board_text(1, ONE_PLACE, &webhook_at(49, "a"), PLAIN_EXECUTOR, 50);
        assert!(parse_board(&before_end).is_ok());
    }

    /// Every input and outcome in the format reads back as the value the file spells.
    #[test]
    fn each_input_and_outcome_reads_back_as_written() {
        let script = r#"
            At(tick: 120, input: Webhook(source: 0, body: "{}")),
            At(tick: 200, input: Request(route: 3, method: "POST", path: "/hello", body: "{}")),
            At(tick: 300, input: Edit(Delete(node: 7))),
        "#;
        let executor = r#"Executor(default: Reply(after_ticks: 1), rules: [
            Rule(url_prefix: "https://example.com/slow", outcome: Reply(after_ticks: 40)),
            Rule(url_prefix: "https://example.com/bad", outcome: Error(after_ticks: 3)),
            Rule(url_prefix: "https://example.com/lost", outcome: Timeout),
        ])"#;
        let board = parse_board(&board_text(1, ONE_PLACE, script, executor, 900)).expect("a valid board");
        assert_eq!(board.script[0].input, ScriptInput::Webhook { source: 0, body: "{}".to_owned() });
        assert_eq!(
            board.script[1].input,
            ScriptInput::Request {
                route: 3,
                method: "POST".to_owned(),
                path: "/hello".to_owned(),
                body: "{}".to_owned()
            }
        );
        assert_eq!(board.script[2].input, ScriptInput::Edit(GridCommand::Delete { node: 7 }));
        assert_eq!(board.executor.default, OutboundOutcome::Reply { after_ticks: 1 });
        assert_eq!(board.executor.rules[0].outcome, OutboundOutcome::Reply { after_ticks: 40 });
        assert_eq!(board.executor.rules[1].outcome, OutboundOutcome::Error { after_ticks: 3 });
        assert_eq!(board.executor.rules[2].outcome, OutboundOutcome::Timeout);
    }

    /// A boot folds one tick per command and one for the seal, leaves nothing to undo, returns the
    /// handles in mint order, and only then installs the timers the log asks for.
    #[test]
    fn a_boot_ends_on_the_boot_end_sealed_with_its_timers_installed() {
        let commands = "Place(kind: 0, cell_x: 1, cell_y: 3), \
                        Place(kind: 7, cell_x: 5, cell_y: 3), \
                        Configure(node: 0, config: Source(trigger: Timer(interval_ticks: 8)))";
        let board = parse_board(&board_text(1, commands, "", PLAIN_EXECUTOR, 900)).expect("a valid board");
        let mut engine = fresh_engine(board.seed);
        let minted = boot_engine(&mut engine, &board).expect("the board boots");
        assert_eq!(minted.len(), 2);
        assert_eq!(engine.core().tick, 4, "3 commands and the seal");
        assert!(!engine.can_undo(), "the board's own commands are not undo steps");
        assert_eq!(engine.timers().interval_for(minted[0]), Some(8));
    }

    /// A board goes through the same validation as a gesture, and a refusal comes back typed.
    #[test]
    fn a_refused_command_comes_back_as_a_typed_error() {
        let commands = "Place(kind: 0, cell_x: 1, cell_y: 3), Place(kind: 7, cell_x: 1, cell_y: 3)";
        let board = parse_board(&board_text(1, commands, "", PLAIN_EXECUTOR, 900)).expect("the text is valid");
        let mut engine = fresh_engine(board.seed);
        assert!(matches!(boot_engine(&mut engine, &board), Err(BoardError::Command(_))));
    }

    proptest! {
        /// No text at all can panic the parser.
        #[test]
        fn no_text_panics_the_parser(src in "\\PC*") {
            let _ = parse_board(&src);
        }
    }
}
