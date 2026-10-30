//! Running a board with no host and no network.
//!
//! A board file carries its own inputs (`script`) and its own answers to outbound calls
//! (`executor`). [`BoardRun`] feeds both through [`Engine::step`], the same function the desktop
//! host calls, so a result from the [`ScriptedExecutor`] enters the fold by the route a real
//! executor's result takes, and a call the script never answers times out through the engine's
//! own deadline check.
//!
//! # The order of one tick
//! With `tick` the core tick at the head of the step:
//! 1. script entries due at `tick`, in file order: an edit goes through [`apply_gesture`], and a
//!    webhook or a request becomes an ingress payload;
//! 2. results due at `tick` from the executor;
//! 3. [`Engine::step`];
//! 4. the handles minted on that tick join the handle list;
//! 5. each emitted command goes to the executor, which queues its answer or doesn't;
//! 6. if an edit folded, the timers are projected again from the edit log, which `step` leaves to
//!    its caller on purpose.
//!
//! `crates/fabrico-host/tests/board_host_parity.rs` runs this order against the desktop host and
//! compares the two at every tick.
//!
//! Nothing here opens a socket, reads a clock or holds global state. An outbound call only ever
//! becomes an [`EffectRecord`].

use std::collections::BTreeMap;

use fabrico_core::command::{Command, Effect, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{CommandId, Item, NodeId};
use fabrico_core::state::HttpMethod;
use fabrico_core::wire::DEFAULT_WIRE_BUDGET;

use crate::board::{BoardError, BoardFile, ExecutorSpec, OutboundOutcome, ScriptInput, boot_engine, validate};
use crate::engine::{Engine, StepOutput};
use crate::envelope::{DEFAULT_ENDPOINT_DEADLINE_TICKS, RequestEnvelope, encode_request_envelope};
use crate::gesture::apply_gesture;
use crate::timer::project_timers;

/// One outbound command a run emitted, and how the script answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectRecord {
    /// The tick the command was emitted on.
    pub tick: u64,
    /// The command's id.
    pub command_id: CommandId,
    /// What the command asked for.
    pub effect: EffectSummary,
    /// How the script answered it. An effect that never leaves a real host reads as a reply after
    /// 1 tick, because that's what it gets.
    pub outcome: OutboundOutcome,
}

/// What a command asked the outside world to do, as plain data.
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
    /// No side effect.
    Noop,
    /// A reply to a request that came in through a Route.
    Reply {
        /// The request's correlation id.
        correlation: u64,
        /// The reply's bytes.
        payload: Vec<u8>,
    },
}

/// Answers outbound commands from a board's [`ExecutorSpec`], on the ticks the spec says.
///
/// The queue is a `BTreeMap` so the order of answers is fixed. Results carry `tick: 0` because the
/// engine stamps the tick it admits them on.
pub struct ScriptedExecutor {
    spec: ExecutorSpec,
    queue: BTreeMap<u64, Vec<ResultEvent>>,
    effects: Vec<EffectRecord>,
}

impl ScriptedExecutor {
    /// An executor with nothing queued.
    #[must_use]
    pub fn new(spec: ExecutorSpec) -> Self {
        Self { spec, queue: BTreeMap::new(), effects: Vec::new() }
    }

    /// Take a command emitted on `tick`: record it and queue its answer.
    ///
    /// For an HTTP call the first rule whose `url_prefix` starts the URL wins, in file order, and
    /// otherwise `default` applies. `Timeout` queues nothing, so the command reaches its deadline.
    /// `Noop`, `Debug` and `Reply` effects never leave a real host, and the real executor answers
    /// them with success, so they get [`Outcome::Success`] one tick later.
    pub fn on_command(&mut self, tick: u64, cmd: &Command) {
        let (effect, outcome) = match &cmd.effect {
            Effect::Http { url, body, method } => (
                EffectSummary::Http { url: url.clone(), method: *method, body: body.clone() },
                self.outcome_for(url),
            ),
            Effect::Debug { message } => {
                (EffectSummary::Debug { message: message.clone() }, OutboundOutcome::Reply { after_ticks: 1 })
            }
            Effect::Noop => (EffectSummary::Noop, OutboundOutcome::Reply { after_ticks: 1 }),
            Effect::Reply { correlation, payload, .. } => (
                EffectSummary::Reply { correlation: *correlation, payload: payload.0.clone() },
                OutboundOutcome::Reply { after_ticks: 1 },
            ),
        };
        let answer = match outcome {
            OutboundOutcome::Reply { after_ticks } => Some((after_ticks, Outcome::Success)),
            OutboundOutcome::Error { after_ticks } => Some((after_ticks, Outcome::Failure)),
            OutboundOutcome::Timeout => None,
        };
        if let Some((after_ticks, result)) = answer {
            self.queue.entry(tick + after_ticks).or_default().push(ResultEvent {
                command_id: cmd.id,
                tick: 0,
                outcome: result,
            });
        }
        self.effects.push(EffectRecord { tick, command_id: cmd.id, effect, outcome });
    }

    /// The results due on `tick`, in the order their commands were emitted.
    pub fn due(&mut self, tick: u64) -> Vec<ResultEvent> {
        self.queue.remove(&tick).unwrap_or_default()
    }

    /// Every command taken so far, in emission order.
    #[must_use]
    pub fn effects(&self) -> &[EffectRecord] {
        &self.effects
    }

    fn outcome_for(&self, url: &str) -> OutboundOutcome {
        self.spec
            .rules
            .iter()
            .find(|rule| url.starts_with(&rule.url_prefix))
            .map_or_else(|| self.spec.default.clone(), |rule| rule.outcome.clone())
    }
}

/// Turn a webhook or request entry into the payload the host's own ingress builds for one, or
/// `None` for an edit.
///
/// A request takes the next `correlation`, which starts at 0 as the host's counter does. Its query
/// and headers are empty, because a board file can't spell them.
///
/// # Errors
/// [`BoardError::UnknownHandle`] if the entry names a handle that isn't minted yet.
pub fn script_payload(
    input: &ScriptInput,
    tick: u64,
    minted: &[NodeId],
    correlation: &mut u64,
) -> Result<Option<EventPayload>, BoardError> {
    let resolve = |handle: u64| {
        minted.get(handle as usize).copied().ok_or(BoardError::UnknownHandle { tick, handle })
    };
    match input {
        ScriptInput::Webhook { source, body } => Ok(Some(EventPayload::ManualInject {
            target: resolve(*source)?,
            port: 0,
            item: Item(body.clone().into_bytes()),
        })),
        ScriptInput::Request { route, method, path, body } => {
            let target = resolve(*route)?;
            let envelope = RequestEnvelope {
                method: method.clone(),
                path: path.clone(),
                query: String::new(),
                headers: BTreeMap::new(),
                body: body.clone(),
            };
            let this_correlation = *correlation;
            *correlation += 1;
            Ok(Some(EventPayload::WireRequest {
                correlation: this_correlation,
                deadline_tick: tick + DEFAULT_ENDPOINT_DEADLINE_TICKS,
                budget: DEFAULT_WIRE_BUDGET,
                return_addr: (target, 0),
                payload: Item(encode_request_envelope(&envelope)),
            }))
        }
        ScriptInput::Edit(_) => Ok(None),
    }
}

/// One board, running on its own script with no host and no network.
///
/// A run keeps everything in this value, so two runs on one thread can't affect each other.
pub struct BoardRun {
    engine: Engine,
    minted: Vec<NodeId>,
    board: BoardFile,
    executor: ScriptedExecutor,
    /// The index of the next script entry to apply.
    cursor: usize,
    /// The next correlation id a request takes.
    correlation: u64,
    /// The error that stopped this run. A failed step may have enqueued some of its tick's edits,
    /// so stepping again would apply them twice. Every later step returns this instead.
    failed: Option<BoardError>,
}

impl BoardRun {
    /// Boot `board` on a fresh core at its seed. The core ends on the board's boot end with its
    /// history sealed and its timers installed.
    ///
    /// # Errors
    /// [`BoardError`] if the board fails the parser's checks or a command is refused.
    pub fn boot(board: BoardFile) -> Result<Self, BoardError> {
        validate(&board)?;
        let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: board.seed });
        let mut engine = Engine::from_core(core);
        let minted = boot_engine(&mut engine, &board)?;
        let executor = ScriptedExecutor::new(board.executor.clone());
        Ok(Self { engine, minted, board, executor, cursor: 0, correlation: 0, failed: None })
    }

    /// Run one tick, in the order the module docs give, and return what it folded.
    ///
    /// Stepping past the end tick still ticks, because the engine can always advance.
    /// [`BoardRun::is_finished`] is how a caller knows to stop.
    ///
    /// # Errors
    /// [`BoardError::UnknownHandle`] or [`BoardError::ScriptEditRefused`], naming the tick. The
    /// run can't continue after either one.
    pub fn step(&mut self) -> Result<StepOutput, BoardError> {
        if let Some(error) = &self.failed {
            return Err(error.clone());
        }
        let stepped = self.step_inner();
        if let Err(error) = &stepped {
            self.failed = Some(error.clone());
        }
        stepped
    }

    fn step_inner(&mut self) -> Result<StepOutput, BoardError> {
        let tick = self.engine.core().tick;

        let mut ingress = Vec::new();
        while let Some(entry) = self.board.script.get(self.cursor).filter(|entry| entry.tick == tick) {
            if let ScriptInput::Edit(cmd) = &entry.input {
                let minted = &self.minted;
                apply_gesture(&mut self.engine, cmd.clone(), |h| minted.get(h as usize).copied())
                    .map_err(|source| BoardError::ScriptEditRefused { tick, source })?;
            } else if let Some(payload) = script_payload(&entry.input, tick, &self.minted, &mut self.correlation)? {
                ingress.push(payload);
            }
            self.cursor += 1;
        }

        let results = self.executor.due(tick);
        let out = self.engine.step(ingress, results);
        self.minted.extend(self.engine.core().last_tick.placed.iter().copied());
        for cmd in &out.commands {
            self.executor.on_command(tick, cmd);
        }
        if out.edits_folded {
            let timers = project_timers(self.engine.session().edit_log());
            self.engine.set_timers(timers);
        }
        Ok(out)
    }

    /// Step until the core reaches the board's end tick.
    ///
    /// # Errors
    /// Whatever [`BoardRun::step`] returns.
    pub fn run_to_end(&mut self) -> Result<(), BoardError> {
        while !self.is_finished() {
            self.step()?;
        }
        Ok(())
    }

    /// Whether the core has reached the board's end tick.
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.engine.core().tick >= self.board.end_tick
    }

    /// The engine, for reading state.
    #[must_use]
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Every outbound command so far, in emission order, with the script's answer to it.
    #[must_use]
    pub fn effects(&self) -> &[EffectRecord] {
        self.executor.effects()
    }

    /// The minted nodes in handle order: handle `h` is element `h`.
    #[must_use]
    pub fn minted(&self) -> &[NodeId] {
        &self.minted
    }
}
