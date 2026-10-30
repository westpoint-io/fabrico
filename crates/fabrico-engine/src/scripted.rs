//! Running a board with no host and no network.

use std::collections::BTreeMap;

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{CommandId, NodeId};
use fabrico_core::state::HttpMethod;

use crate::board::{BoardError, BoardFile, ExecutorSpec, OutboundOutcome, ScriptInput, boot_engine};
use crate::engine::{Engine, StepOutput};

/// One outbound call a run made, and how the script answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectRecord {
    /// The tick the command was emitted on.
    pub tick: u64,
    /// The command's id.
    pub command_id: CommandId,
    /// What the command asked for.
    pub effect: EffectSummary,
    /// How the script answered it.
    pub outcome: OutboundOutcome,
}

/// What a command asked the outside world to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffectSummary {
    /// An HTTP call.
    Http {
        /// The target URL.
        url: String,
        /// The verb.
        method: HttpMethod,
        /// The request body.
        body: Vec<u8>,
    },
    /// A message for the debug sink.
    Debug {
        /// The message bytes.
        message: Vec<u8>,
    },
    /// Nothing at all.
    Noop,
    /// A reply to a request.
    Reply {
        /// The request's correlation id.
        correlation: u64,
        /// The reply's bytes.
        payload: Vec<u8>,
    },
}

/// Stub: answers nothing yet.
pub struct ScriptedExecutor {
    spec: ExecutorSpec,
    queue: BTreeMap<u64, Vec<ResultEvent>>,
    effects: Vec<EffectRecord>,
}

impl ScriptedExecutor {
    /// Stub.
    #[must_use]
    pub fn new(spec: ExecutorSpec) -> Self {
        Self { spec, queue: BTreeMap::new(), effects: Vec::new() }
    }

    /// Stub.
    pub fn on_command(&mut self, _tick: u64, _cmd: &Command) {
        let _ = (&self.spec, &self.queue);
    }

    /// Stub.
    pub fn due(&mut self, _tick: u64) -> Vec<ResultEvent> {
        Vec::new()
    }

    /// Stub.
    #[must_use]
    pub fn effects(&self) -> &[EffectRecord] {
        &self.effects
    }
}

/// Stub.
///
/// # Errors
/// None yet.
pub fn script_payload(
    _input: &ScriptInput,
    _tick: u64,
    _minted: &[NodeId],
    _correlation: &mut u64,
) -> Result<Option<EventPayload>, BoardError> {
    Ok(None)
}

/// Stub: ticks with no inputs.
pub struct BoardRun {
    engine: Engine,
    minted: Vec<NodeId>,
    board: BoardFile,
    executor: ScriptedExecutor,
}

impl BoardRun {
    /// Boot a board.
    ///
    /// # Errors
    /// [`BoardError`] if the boot is refused.
    pub fn boot(board: BoardFile) -> Result<Self, BoardError> {
        let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: board.seed });
        let mut engine = Engine::from_core(core);
        let minted = boot_engine(&mut engine, &board)?;
        let executor = ScriptedExecutor::new(board.executor.clone());
        Ok(Self { engine, minted, board, executor })
    }

    /// Stub.
    ///
    /// # Errors
    /// None yet.
    pub fn step(&mut self) -> Result<StepOutput, BoardError> {
        Ok(self.engine.step(vec![], vec![]))
    }

    /// Stub.
    ///
    /// # Errors
    /// None yet.
    pub fn run_to_end(&mut self) -> Result<(), BoardError> {
        while !self.is_finished() {
            self.step()?;
        }
        Ok(())
    }

    /// Whether the run has reached the board's end tick.
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.engine.core().tick >= self.board.end_tick
    }

    /// The engine.
    #[must_use]
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// The calls so far.
    #[must_use]
    pub fn effects(&self) -> &[EffectRecord] {
        self.executor.effects()
    }

    /// The minted nodes.
    #[must_use]
    pub fn minted(&self) -> &[NodeId] {
        &self.minted
    }
}
