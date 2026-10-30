//! The shipped scenes as DATA, and THE one function that boots any of them.
//!
//! The boards live in `examples/boards/`, with one `<wire id>.board.ron` per [`SceneId`]. This
//! module embeds them at build time, so no file is read at run time and [`SceneId`] stays a closed
//! list: a board in `examples/boards/docs/` never reaches the Examples menu. A test in
//! `tests/scene_catalog_guard.rs` holds the files and the catalog together.
//!
//! Every shipped board (the demo, the order-processing example and the advanced example) is
//! a build-embedded board file (`examples/boards/*.board.ron`) holding a list of
//! [`GridCommand`]s, the same commands a user's own gestures produce. [`boot_scene`] applies a scene to a fresh-genesis [`Host`] through
//! the certified gesture path (`apply_gesture` -> `enqueue_edit` -> `tick_once`, one command
//! per tick, never the `core_mut` backdoor), seals the history so the scene's own commands
//! are not undo steps (plan 85-06, D-10), and projects the board's timers out of the edit log
//! it just wrote. The Tauri shell's boot, the dev render server's boot and every `LoadScene`
//! swap call it, so a board is built one way whichever door it came in by (plan 85-08, D-02).
//!
//! # Nothing on a shipped board is minted outside the edit log
//! Every node is a `Place`, a `DrawBelt` or a `DrawWire` record in the log, so the history
//! is a pure function of the log, a reopened board needs no side marker, and the catalog
//! guard can rebuild each node from its logged kind (plan 85-08, D-02, D-03). The demo's
//! request/response pair is an ordinary Route and HTTP Handler, placed, configured and wired
//! by commands at the END of `demo_scene.board.ron`, so every earlier handle keeps its number. One
//! `DrawWire` between them mints both cables, request first, exactly as a user's drag does.
//!
//! - **LIVE-02**: [`demo_commands`] is the ENTIRE demo: Place, Configure, Rotate, DrawBelt,
//!   Dock and DrawWire, in one static list.
//! - **LIVE-04**: the list is REGENERABLE: a second, independent applier (`GridSession`)
//!   folding the same list from the same genesis seed produces an IDENTICAL `blake3`
//!   tick-hash (`tests/demo_regenerability.rs`).
//! - **LIVE-05**: items FLOW: the Source's `Configure{Source, Timer}` record is projected
//!   back out of the edit log ([`timers_from_log`]) and injects canonical JSON on a cadence.
//! - **DEMO-09**: a scene that fails to load says which scene it was ([`SceneLoadError`]).

use fabrico_command::CommandError;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::event::EventPayload;
use fabrico_core::ids::NodeId;
use fabrico_core::persist::StoreError;
use fabrico_engine::board::{BoardError, parse_board};
use fabrico_protocol::GridCommand;
use tokio::sync::mpsc::unbounded_channel;

use crate::driver::Host;
use crate::ingress::timer::{TimerSet, project_timers};
use crate::input_apply::apply_gesture;

/// The demo scene's genesis seed - fixed for determinism. THE one canonical copy
/// (consolidated here in Plan 20-03; `sim_loop.rs`'s and the entrypoints' local
/// copies die in Plan 20-04). Both regenerability appliers genesis from this seed.
pub const DEMO_GENESIS_SEED: u64 = 7;

/// The canonical demo injection payload: canonical JSON (`{}`) - valid input for
/// the default passthrough factory transform (a non-JSON item would fault the
/// factory on every fire). Byte-stable across runs and replays (the
/// `TimerConfig::item` determinism contract).
pub const DEMO_ITEM: &[u8] = b"{}";

/// The demo timer cadence: inject one item every N ticks (~8 items/s at the
/// 62.5 t/s loop).
///
/// This is a PIN, not an installer. The shipped cadence is authored as a
/// `Configure{Source, Timer}` record in `examples/boards/demo_scene.board.ron` and installed by
/// projecting it back out of the edit-log ([`timers_from_log`]);
/// `demo_scene_authors_its_source_timer_as_a_logged_edit` asserts the RON's value
/// equals this constant, so the two can never drift. Re-pacing the demo means
/// editing BOTH (the test will tell you if you edit only one).
pub const DEMO_INJECT_EVERY: u64 = 8;

/// The build-embedded demo board (EX-01), authored as data in
/// `examples/boards/demo_scene.board.ron`. No file is read at run time, and editing the
/// shipped factory is a data-file edit, not a change to this module.
const DEMO_SCENE_RON: &str = include_str!("../../../examples/boards/demo_scene.board.ron");

/// The build-embedded order-processing teaching scene asset (EX-02): the second
/// shipped scene — webhook Source -> validate/split Factory -> invoice +
/// fulfillment corridors over belts -> invoice Debug sink + HTTP sink. A board file, like
/// [`DEMO_SCENE_RON`].
const ORDER_SCENE_RON: &str = include_str!("../../../examples/boards/order_processing.board.ron");

/// The build-embedded "advanced" scene asset (quick 260916-adv): the third shipped scene, a
/// larger order-fulfilment board (two ingress Sources -> ingress Merge -> a
/// validate/split Factory with a wired dead-letter Sink on its Fault port ->
/// parallel worker Factories behind a Balancer, re-merged into an HTTP sink, plus
/// an invoice Factory -> Debug sink). A board file, like the other two.
const ADVANCED_SCENE_RON: &str = include_str!("../../../examples/boards/advanced.board.ron");

/// The order-processing scene's genesis seed — fixed for determinism, DISTINCT
/// from [`DEMO_GENESIS_SEED`] (7) so no two of the three shipped scenes share a
/// factory sub-seed stream by accident. Value arbitrary; logged in the
/// `LogHeader` exactly like the demo's. Both order regenerability appliers
/// genesis from this seed.
pub const ORDER_GENESIS_SEED: u64 = 55;

/// The advanced scene's genesis seed — fixed for determinism, DISTINCT from
/// [`DEMO_GENESIS_SEED`] (7) and [`ORDER_GENESIS_SEED`] (55) so no two shipped
/// scenes share a factory sub-seed stream by accident. Value arbitrary; logged
/// in the `LogHeader` exactly like the others.
pub const ADVANCED_GENESIS_SEED: u64 = 88;

/// The typed scene-id boundary (EX-02): the ONE choke point every path that
/// names a shipped scene parses through — the dev-WS `load_example` verb, the
/// Tauri `load_example` command, the `FABRICO_BOOT_SCENE` boot seam, and the
/// frontend popover's wire ids. Wire ids are exactly `demo_scene`,
/// `order_processing`, and `advanced` (quick 260916-adv); anything else is a typed error at
/// each transport's own decode boundary — NEVER a silent demo fallback (T-55-04).
///
/// Phase 62 added a THIRD, development-only variant behind a non-default cargo
/// feature. Plan 68-07 removed it with the rest of the development pace switch
/// (BELT-05 / D-68-12, D-68-14): once a belt's pace is a logged command that
/// replays byte-identically, any scene is a board a human can judge a pace on,
/// and a surviving dev-only scene would keep a `#[cfg]` arm alive for the
/// absence gate to carve around permanently. The enum carries only SHIPPED
/// scenes, unconditionally, with no feature-shaped variants: Demo,
/// OrderProcessing, and the larger Advanced order-fulfilment example (quick 260916-adv).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneId {
    /// The command-built default demo scene (`examples/boards/demo_scene.board.ron`).
    Demo,
    /// The order-processing teaching example (`examples/boards/order_processing.board.ron`).
    OrderProcessing,
    /// The larger "advanced" order-fulfilment example (`examples/boards/advanced.board.ron`):
    /// two Sources -> Merge -> validate/split Factory (dead-letter on Fault) ->
    /// Balancer + parallel worker Factories -> Merge -> HTTP sink, plus an invoice
    /// Factory -> Debug sink. Shipped as the third Examples entry.
    Advanced,
}

impl SceneId {
    /// Every shipped scene, once each (plan 85-08, D-23). A check that must cover every
    /// scene iterates this; `scene_id_all_lists_every_variant_once` matches each member
    /// exhaustively, so a fourth variant is a compile error there until it is listed here.
    pub const ALL: [SceneId; 3] = [Self::Demo, Self::OrderProcessing, Self::Advanced];

    /// Parse a wire id into a [`SceneId`]. Exactly `"demo_scene"`,
    /// `"order_processing"` and `"advanced"` are legal; anything else (unknown, empty, wrong
    /// case) is `None` — the caller maps it to ITS transport's typed error
    /// (`CommandError::Malformed` on the dev WS, `Err(String)` on Tauri, a
    /// loud stderr warning on the boot seam). Accepts ids only, never a path.
    #[must_use]
    pub fn parse(wire: &str) -> Option<Self> {
        match wire {
            "demo_scene" => Some(Self::Demo),
            "order_processing" => Some(Self::OrderProcessing),
            "advanced" => Some(Self::Advanced),
            _ => None,
        }
    }

    /// The scene's ENTIRE command list, materialized from its build-embedded
    /// RON asset. Build-time assets only — no runtime file read on any load
    /// path.
    ///
    /// FALLIBLE by design (WR-08). This is the PRODUCTION accessor: it runs on
    /// the single-threaded sim thread on every `LoadScene` control message, and
    /// every other failure in `load_scene_swap` (tempdir, store, ledger,
    /// seen-set, host, seed) is deliberately non-fatal (warn + keep the current
    /// scene). A RON parse failure must not be the one arm that aborts the
    /// process and kills the simulation at an arbitrary user click. The
    /// infallible [`demo_commands`] / [`order_commands`] remain for the tests
    /// and goldens, where a broken embed genuinely IS a broken build.
    ///
    /// # Errors
    /// [`SeedError::Board`] with the `ron` line/col span if the embedded asset is
    /// not well-formed `Vec<GridCommand>`.
    pub fn commands(self) -> Result<Vec<GridCommand>, SeedError> {
        match self {
            Self::Demo => load_board_commands(DEMO_SCENE_RON),
            Self::OrderProcessing => load_board_commands(ORDER_SCENE_RON),
            Self::Advanced => load_board_commands(ADVANCED_SCENE_RON),
        }
    }

    /// The scene's WIRE id — the exact string [`SceneId::parse`] accepts, so
    /// `parse(id.wire_id()) == Some(id)` for every variant (asserted in this
    /// module's tests). This is the INVERSE the badge echo needs (WR-03): the
    /// frontend asks the host which shipped scene is loaded and maps the answer
    /// through its own closed `SceneWireId` union.
    #[must_use]
    pub fn wire_id(self) -> &'static str {
        match self {
            Self::Demo => "demo_scene",
            Self::OrderProcessing => "order_processing",
            Self::Advanced => "advanced",
        }
    }

    /// The scene's fixed genesis seed ([`DEMO_GENESIS_SEED`],
    /// [`ORDER_GENESIS_SEED`] or [`ADVANCED_GENESIS_SEED`]) — determinism-critical, logged in the
    /// `LogHeader` so every replay reproduces the scene's RNG stream.
    #[must_use]
    pub fn genesis_seed(self) -> u64 {
        match self {
            Self::Demo => DEMO_GENESIS_SEED,
            Self::OrderProcessing => ORDER_GENESIS_SEED,
            Self::Advanced => ADVANCED_GENESIS_SEED,
        }
    }
}

/// Parse a board file's text and return its command list.
///
/// # Errors
/// Returns [`SeedError::Board`] carrying the [`BoardError`], with a line and column if `src` isn't
/// a well-formed board: a typed `Err`, never a panic.
pub fn load_board_commands(src: &str) -> Result<Vec<GridCommand>, SeedError> {
    Ok(parse_board(src)?.commands)
}

/// THE replayable scene (LIVE-02/LIVE-04): the ENTIRE default factory as one
/// [`GridCommand`] list exercising all four command families, materialized from
/// the build-embedded demo board.
///
/// Handle convention: dense `u64` handles are minted monotonic from 0 in
/// mint order (machines first, in Place order; then belts, in DrawBelt order) -
/// the SAME convention `GridView` and the render producer use, so the static
/// handles authored in `examples/boards/demo_scene.board.ron` resolve identically on every
/// applier. Every Dock/Rotate appears strictly AFTER the command that mints its
/// target; combined with the one-command-per-tick application discipline
/// ([`seed_scene`]) that makes handle resolution structurally safe (each
/// dependency is folded a tick before its dependent).
///
/// Port convention: `Dock` carries the CATALOG port index on the wire
/// (SOURCE Out = 0; FACTORY In/Out/Fault = 0/1/2; TEE In/Out/Out = 0/1/2;
/// SINK In = 0). `validate_normalize` freezes the resolved link key: Out docks
/// freeze in the EMIT/routing keyspace (Plan 20-01) and the FACTORY's fault nub
/// (catalog 2) freezes to the reserved `FAULT_PORT` (17-04).
#[must_use]
pub fn demo_commands() -> Vec<GridCommand> {
    // The embedded RON is a TRUSTED build-time asset: a broken embed is a broken
    // build (the boot-`expect` style already used at app/lib.rs:322), so the
    // infallible `#[must_use]` signature is preserved via `.expect`. The fallible
    // `load_board_commands` above carries the typed-error story for any runtime
    // path and for the malformed-input test.
    load_board_commands(DEMO_SCENE_RON)
        .expect("embedded demo_scene.board.ron is a build-time asset and must parse")
}

/// THE order-processing scene (EX-02): the ENTIRE teaching factory as one
/// [`GridCommand`] list — 6 Place + 1 AddPort + 5 DrawBelt + 10 Dock +
/// 6 Configure = 28 commands, materialized from the build-embedded
/// [`ORDER_SCENE_RON`] asset. Every command is UI-producible (the v6.2 done-test
/// contract — enforced by `tests/order_flow.rs`'s census test).
///
/// Same handle + port conventions as [`demo_commands`]; see the board file's header for
/// the AddPort re-seat note (the splitter's grown second Out is catalog 3 ->
/// emit 1).
#[must_use]
pub fn order_commands() -> Vec<GridCommand> {
    // Embedded RON is a TRUSTED build-time asset (same discipline as
    // `demo_commands`): a broken embed is a broken build.
    load_board_commands(ORDER_SCENE_RON)
        .expect("embedded order_processing.board.ron is a build-time asset and must parse")
}

/// A [`seed_scene`] failure - a typed error, never a panic. Scene-neutral on purpose: the
/// same type fails every shipped scene, and the scene's name rides on the
/// [`SceneLoadError`] that wraps it (plan 85-08, D-25).
#[derive(Debug)]
pub enum SeedError {
    /// A command in the scene's list was rejected by `validate_normalize`.
    Command(CommandError),
    /// A tick failed to persist its folded batch, or the edit log could not be read back
    /// for the timer projection.
    Store(StoreError),
    /// The applied list minted no nodes (structurally impossible for a shipped list,
    /// kept so seeding has no panic path).
    EmptyScene,
    /// A board file was refused. A parse failure carries the `ron` line and column.
    Board(BoardError),
}

impl std::fmt::Display for SeedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Command(e) => write!(f, "a scene command was rejected: {e}"),
            Self::Store(e) => write!(f, "a scene seed tick failed to persist: {e}"),
            Self::EmptyScene => write!(f, "the scene minted no nodes"),
            Self::Board(e) => write!(f, "the scene's board file was refused: {e}"),
        }
    }
}

impl std::error::Error for SeedError {}

impl From<CommandError> for SeedError {
    fn from(e: CommandError) -> Self {
        Self::Command(e)
    }
}

impl From<BoardError> for SeedError {
    fn from(e: BoardError) -> Self {
        Self::Board(e)
    }
}

impl From<StoreError> for SeedError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

/// The sim ticks [`seed_scene`] folds AFTER a scene's last command. The engine owns the number,
/// because a board's boot end depends on it; the tick-parity tests read it through this name.
pub use fabrico_engine::board::HISTORY_SEAL_TICKS;

/// Apply a scene's `commands` to a fresh-genesis `host` through the certified
/// live path - `apply_gesture` -> `enqueue_edit` -> `tick_once`, ONE COMMAND PER
/// TICK - and return the full mint-order handle ledger (dense handle `h`
/// resolves to `ledger[h]`). NEVER touches `core_mut` (D-02): a seeded scene is
/// edit-log-consistent by construction, so live undo/redo works on it. After the last
/// command it seals the history (plan 85-06, D-10) and folds the seal in one more tick,
/// so the scene's own commands sit below the undo floor and only the user's later edits
/// are undoable.
///
/// THE one shared applier (Phase 55). [`boot_scene`] is how every boot site reaches it;
/// tests that need a scene's board without its timers call it directly.
///
/// # Errors
/// Returns [`SeedError`] if any command is rejected, a tick fails to persist, or
/// the list minted no nodes; the caller keeps its current scene (non-fatal style).
pub fn seed_scene(host: &mut Host, commands: &[GridCommand]) -> Result<Vec<NodeId>, SeedError> {
    // Throwaway per-tick channels: `tick_once` requires the three handles, but no
    // items exist during seeding, so nothing rides them (the unused halves drop
    // harmlessly - the same shape as `input_apply.rs::tests::channels()`, which is
    // cfg(test) and therefore replicated here as locals).
    let (_ingress_tx, mut ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, mut results_rx) = unbounded_channel::<ResultEvent>();

    // Mint-order handle ledger: dense handle h resolves to minted[h]. Extended from
    // `last_tick.placed` after every tick (reset at the top of each fold, so the
    // per-tick read yields exactly the node(s) minted that tick; covers machines
    // AND belts - both fold_place and fold_draw_belt push into `placed`).
    let mut minted: Vec<NodeId> = Vec::new();

    // ONE COMMAND PER TICK - load-bearing for LIVE-04 (Pitfall 2): the second
    // regenerability applier (`GridSession::apply`) folds exactly ONE record then
    // advances one tick, and `oracle::tick_hash` covers `core.tick` + the RNG, so
    // batching commands here would advance fewer ticks than the session and make
    // hash equality structurally impossible. It also makes handle resolution safe
    // by construction: every Dock/Rotate target was folded a tick earlier.
    for cmd in commands {
        apply_gesture(host, cmd.clone(), |h| minted.get(h as usize).copied())?;
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)?;
        minted.extend(host.core().last_tick.placed.iter().copied());
    }

    // THE HISTORY SEAL (plan 85-06, D-10, D-11, DEMO-05). This is the ONE place a scene's
    // history is sealed, and no call site seals on its own: the demo at boot, every example
    // on LoadScene and the dev server all reach a scene through this function. The seal is
    // a logged record (`EditOp::SealHistory`), folded in one more tick like every command
    // above, so the undo floor it sets is a pure function of the log and survives Save and
    // reopen. Without it every command above was an undo step, and each Ctrl+Z on a freshly
    // loaded scene took one of the scene's own pieces away (walk-112). The headless
    // regenerability appliers call `GridSession::seal_history` at the same point, so both
    // appliers advance the same ticks.
    host.seal_history();
    host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)?;

    if minted.is_empty() {
        return Err(SeedError::EmptyScene);
    }
    Ok(minted)
}

/// A shipped scene that failed to load, naming the scene (plan 85-08, D-25, DEMO-09).
///
/// The only way to reach one is a broken embedded asset (a RON that does not parse, or a
/// list the command layer refuses), which a build that passed its own tests cannot carry. It
/// still has a typed path: the boot sites treat it as startup-fatal with the scene named, and
/// `load_scene_swap` warns with the scene named and keeps the board it has.
#[derive(Debug)]
pub struct SceneLoadError {
    /// The scene that failed.
    pub scene: SceneId,
    /// Why it failed.
    pub source: SeedError,
}

impl std::fmt::Display for SceneLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "scene \"{}\" failed to load: {}", self.scene.wire_id(), self.source)
    }
}

impl std::error::Error for SceneLoadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

/// THE one way a shipped scene reaches a board (plan 85-08, D-02): take the scene's command
/// list, apply it to `host` with [`seed_scene`] (which seals the history after the last
/// command), then project the board's timers out of the edit log it just wrote and install
/// them. The Tauri shell's boot, the dev render server's boot and `load_scene_swap` all call
/// this, so the three can never build a scene three ways again.
///
/// `host` must be a fresh genesis host at the scene's [`SceneId::genesis_seed`]. Timers come
/// strictly AFTER seeding: a timer installed first would fire during the seed ticks and
/// inject into a half-built board, diverging the regenerability hash (Pitfall 3).
///
/// # Errors
/// [`SceneLoadError`] naming `id` if the embedded RON does not parse, a command is refused,
/// a tick fails to persist, the list mints nothing, or the edit log cannot be read back.
pub fn boot_scene(host: Host, id: SceneId) -> Result<Host, SceneLoadError> {
    boot_scene_from(host, id, id.commands())
}

/// [`boot_scene`]'s body over an already-materialized command list, so a test can hand it a
/// malformed RON or an empty list for any scene (the DEMO-09 proof) without a broken build.
fn boot_scene_from(
    mut host: Host,
    id: SceneId,
    commands: Result<Vec<GridCommand>, SeedError>,
) -> Result<Host, SceneLoadError> {
    let named = |source: SeedError| SceneLoadError { scene: id, source };
    let commands = commands.map_err(named)?;
    seed_scene(&mut host, &commands).map_err(named)?;
    let timers = timers_from_log(&host).map_err(|e| named(SeedError::Store(e)))?;
    Ok(host.with_timers(timers))
}

/// THE injection mechanism for a seeded scene: project the live [`TimerSet`] from
/// `host`'s certified edit-log.
///
/// # Why this is a projection and not a hand-built set
/// This REPLACED a `demo_timers` helper that built the demo's timer
/// imperatively from [`DEMO_INJECT_EVERY`] without ever writing it to the
/// edit-log. `SimLoop::tick_body` re-derives the timer set from that same log on
/// every gesture tick and installs it with `Host::set_timers`, which REPLACES -
/// so the unlogged timer was wiped by the user's FIRST edit of any kind and the
/// shipped demo board silently died forever (bug
/// `demo-timer-wiped-on-first-edit`, v7.0). Reading the set from the log at boot
/// too means the boot set and the post-edit set are the SAME derivation of the
/// SAME records, and can never disagree again. The demo's cadence is authored
/// where the rest of the board is authored: `examples/boards/demo_scene.board.ron`.
///
/// # The timers-after-seeding contract (unchanged)
/// Call this strictly AFTER the scene is seeded ([`boot_scene`] does: build Host ->
/// `seed_scene` -> `with_timers(timers_from_log(..))` -> `SimLoop::new` /
/// `install_swapped_host`).
/// A pre-installed timer would fire during the seed ticks (`tick % interval == 0`
/// fires at every multiple), injecting logged events into a half-built grid and
/// diverging the regenerability hash. A `Load(path)` of a USER project runs the
/// same projection over the USER's log, so a user board gets exactly the timers
/// its own author configured and never the demo's.
///
/// # Errors
/// [`StoreError`] if the edit-log cannot be read or decoded. Deliberately NOT
/// swallowed into an empty set: an empty `TimerSet` is precisely what the bug
/// above looked like, so a read failure must be loud at the call site rather
/// than silently producing a dead board.
pub fn timers_from_log(host: &Host) -> Result<TimerSet, StoreError> {
    Ok(project_timers(&host.logged_edits()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_protocol::{BeltEnd, MachineConfig, SourceTrigger, machine_kind};

    use fabrico_core::core::Core;
    use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
    use fabrico_core::persist::RedbStore;
    use fabrico_core::state::Node;

    use crate::ledger::DispatchLedger;

    /// The demo scene AUTHORS its item source's timer as a logged edit (the
    /// `demo-timer-wiped-on-first-edit` fix). This pins all three properties the
    /// fix depends on:
    ///
    /// - it EXISTS, targets handle 0 (the SOURCE) and carries
    ///   [`DEMO_INJECT_EVERY`] - so `project_timers` reproduces exactly the set
    ///   the board boots with;
    /// - it is not FIRST - handle 0 must already be minted when it is applied;
    /// - it is not LAST - a trailing timer record would let one Ctrl+Z on a
    ///   freshly-booted board undo the item source, reproducing the dead
    ///   first-run experience by another route.
    #[test]
    fn demo_scene_authors_its_source_timer_as_a_logged_edit() {
        let cmds = demo_commands();
        let at = cmds
            .iter()
            .position(|c| {
                matches!(
                    c,
                    GridCommand::Configure {
                        node: 0,
                        config: MachineConfig::Source {
                            trigger: SourceTrigger::Timer { interval_ticks },
                        },
                    } if *interval_ticks == DEMO_INJECT_EVERY
                )
            })
            .expect(
                "the demo scene must carry a Configure{Source, Timer} on handle 0 - \
                 without it project_timers returns an EMPTY set and the first user \
                 edit permanently stops the shipped board",
            );
        assert!(
            at > 0,
            "the timer Configure must come AFTER the Place that mints handle 0"
        );
        assert!(
            at < cmds.len() - 1,
            "the timer Configure must NOT be the last command - one Ctrl+Z on a \
             fresh board would undo the item source"
        );
    }

    /// T-55-04: the typed scene-id boundary parses EXACTLY the shipped wire ids;
    /// an unknown id and the empty string are `None` (each transport maps that
    /// to its own typed error — never a silent demo fallback).
    #[test]
    fn scene_id_parses_exactly_the_shipped_wire_ids() {
        assert_eq!(SceneId::parse("demo_scene"), Some(SceneId::Demo));
        assert_eq!(
            SceneId::parse("order_processing"),
            Some(SceneId::OrderProcessing)
        );
        assert_eq!(SceneId::parse("advanced"), Some(SceneId::Advanced));
        assert_eq!(SceneId::parse("bogus_scene"), None, "unknown id is None");
        assert_eq!(SceneId::parse(""), None, "the empty string is None");
        assert_eq!(
            SceneId::parse("Demo_Scene"),
            None,
            "ids are exact (case-sensitive) — no fuzzy fallback"
        );
    }

    /// WR-03: `wire_id` is the exact INVERSE of `parse` over the closed set, so a
    /// scene echoed back to the frontend round-trips through the SAME boundary
    /// every load path uses. A drifted literal would break the badge silently.
    #[test]
    fn scene_id_wire_id_round_trips_through_parse() {
        for id in [
            SceneId::Demo,
            SceneId::OrderProcessing,
            SceneId::Advanced,
        ] {
            assert_eq!(
                SceneId::parse(id.wire_id()),
                Some(id),
                "{id:?}.wire_id() must parse back to itself"
            );
        }
        assert_eq!(SceneId::Demo.wire_id(), "demo_scene");
        assert_eq!(SceneId::OrderProcessing.wire_id(), "order_processing");
        assert_eq!(SceneId::Advanced.wire_id(), "advanced");
    }

    /// The SceneId dispatchers hand back the SAME artifacts the direct demo /
    /// order paths use (one choke point, zero drift).
    #[test]
    fn scene_id_dispatches_to_the_canonical_scene_artifacts() {
        assert_eq!(SceneId::Demo.genesis_seed(), DEMO_GENESIS_SEED);
        assert_eq!(SceneId::OrderProcessing.genesis_seed(), ORDER_GENESIS_SEED);
        assert_eq!(SceneId::Advanced.genesis_seed(), ADVANCED_GENESIS_SEED);
        assert_eq!(
            SceneId::Demo.commands().expect("the embedded demo board parses"),
            demo_commands()
        );
        assert_eq!(
            SceneId::OrderProcessing
                .commands()
                .expect("the embedded order board parses"),
            order_commands()
        );
        // The advanced scene's genesis seed is distinct from the other two, so no
        // two shipped scenes share a factory sub-seed stream.
        assert_ne!(ADVANCED_GENESIS_SEED, DEMO_GENESIS_SEED);
        assert_ne!(ADVANCED_GENESIS_SEED, ORDER_GENESIS_SEED);
        // The advanced board is a well-formed command list too.
        assert!(
            SceneId::Advanced.commands().is_ok(),
            "the embedded advanced board parses"
        );
    }

    /// Fail-loud contract (threat T-48-01): a malformed board returns a typed
    /// `SeedError::Board`, NEVER a panic and never a silently-wrong scene.
    #[test]
    fn malformed_ron_errors_loudly() {
        let err = load_board_commands("this is not ron [[[").unwrap_err();
        assert!(
            matches!(err, SeedError::Board(BoardError::Parse(_))),
            "malformed RON must surface as a typed SeedError::Board(BoardError::Parse), not a panic"
        );
    }

    /// The seed constants and the board files say the same thing, so they can't drift.
    #[test]
    fn each_board_carries_its_scene_seed() {
        let demo = parse_board(DEMO_SCENE_RON).expect("the embedded demo board parses");
        assert_eq!(demo.seed, DEMO_GENESIS_SEED);
        let order = parse_board(ORDER_SCENE_RON).expect("the embedded order board parses");
        assert_eq!(order.seed, ORDER_GENESIS_SEED);
        let advanced = parse_board(ADVANCED_SCENE_RON).expect("the embedded advanced board parses");
        assert_eq!(advanced.seed, ADVANCED_GENESIS_SEED);
    }

    /// Phase-55 (EX-02) substrate proof: the RON format is expressive enough to
    /// carry inline factory JS as a `Configure(Factory {{ source }})` WITHOUT any
    /// `Configure` being injected into the shipped verbatim scene (Pitfall 3). This
    /// certifies the authoring substrate the next milestone sits on.
    #[test]
    fn configure_factory_ron_parses() {
        use fabrico_protocol::MachineConfig;
        let src = r#"[Configure(node: 1, config: Factory(source: "export default (i)=>i"))]"#;
        let cmds = ron::from_str::<Vec<GridCommand>>(src)
            .expect("a Configure(Factory) command parses from RON");
        assert!(
            matches!(
                cmds[0],
                GridCommand::Configure {
                    config: MachineConfig::Factory { .. },
                    ..
                }
            ),
            "Configure(Factory {{ source }}) round-trips through RON into the frozen enum"
        );

        // Phase-55 Assumption A1: RON raw strings (`r#"..."#`) carry a MULTI-LINE JS
        // body byte-verbatim — the form `examples/boards/order_processing.board.ron` uses so its
        // teaching JS stays readable (double quotes unescaped). If this case ever
        // regresses, the scene falls back to ordinary RON strings with single-quoted
        // JS string literals.
        let raw_src = r##"[Configure(node: 1, config: Factory(source: r#"// validate the order
export default function (input, ctx) {
  if (!input || !input.id) { throw new Error("not an order"); }
  ctx.emit(0, { kind: "ok", order: input.id });
}"#))]"##;
        let raw_cmds = ron::from_str::<Vec<GridCommand>>(raw_src)
            .expect("a raw-string multi-line Factory source parses from RON (A1)");
        match &raw_cmds[0] {
            GridCommand::Configure {
                config: MachineConfig::Factory { source },
                ..
            } => {
                assert!(
                    source.starts_with("// validate the order\n"),
                    "the raw string preserves the leading comment line verbatim"
                );
                assert!(
                    source.contains(r#"throw new Error("not an order")"#),
                    "inner double quotes survive unescaped inside the raw string"
                );
            }
            other => panic!("expected a Configure(Factory), got {other:?}"),
        }
    }

    /// A real `Host` over tempfile redb stores at the DEMO genesis seed, on an
    /// EMPTY grid: the entire scene below enters through the edit-log (commands).
    fn test_host() -> (tempfile::TempDir, Host) {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: DEMO_GENESIS_SEED,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");
        (dir, host)
    }

    /// The demo's command list, by family. Every node on the board is one of these records:
    /// a `Place` (machines, the caller Route and the HTTP Handler), a `DrawBelt` or a
    /// `DrawWire` (plan 85-08, D-02).
    #[test]
    fn demo_commands_exercise_every_family() {
        let cmds = demo_commands();
        let count = |f: fn(&GridCommand) -> bool| cmds.iter().filter(|c| f(c)).count();
        let places = count(|c| matches!(c, GridCommand::Place { .. }));
        let rotates = count(|c| matches!(c, GridCommand::Rotate { .. }));
        let docks = count(|c| matches!(c, GridCommand::Dock { .. }));
        let wires = count(|c| matches!(c, GridCommand::DrawWire { .. }));
        let draw_lens: Vec<usize> = cmds
            .iter()
            .filter_map(|c| match c {
                GridCommand::DrawBelt { cells } => Some(cells.len()),
                _ => None,
            })
            .collect();

        assert_eq!(
            places, 20,
            "1 SOURCE + 1 FACTORY + 1 TEE + 5 SINKs + BALANCER + ROUTER + MERGE + 7 labels + \
             the caller Route + the HTTP Handler"
        );
        assert_eq!(rotates, 1, "exactly ONE functionally-necessary Rotate");
        assert_eq!(draw_lens.len(), 11, "eleven drawn belts");
        assert_eq!(docks, 2 * draw_lens.len(), "every belt end is docked");
        assert_eq!(
            wires, 1,
            "ONE DrawWire: between a Route and an HTTP Handler it mints the request cable and \
             its reply leg together (phase 72, D-04)"
        );
        assert!(
            draw_lens.iter().all(|&n| n >= 2),
            "every drawn belt is at least two cells (floor 1)"
        );
        assert!(
            cmds.iter().any(|c| matches!(
                c,
                GridCommand::Dock {
                    endpoint: BeltEnd::Tail,
                    node: 1,
                    port: 2,
                    ..
                }
            )),
            "a Tail dock targets catalog port 2 of the FACTORY (the fault nub)"
        );
    }

    /// The demo's request/response pair is the LAST five commands, in D-03's order: Place
    /// the Route, Place the HTTP Handler, Configure the handler, Configure the Route's path,
    /// then ONE DrawWire from the Route's Out to the handler's In, which mints the request
    /// cable and its reply leg together (phase 72, D-04: a second DrawWire for the reply is
    /// refused as an occupied port). Last, so every earlier handle keeps its number.
    #[test]
    fn the_demo_pair_is_the_last_five_commands_in_order() {
        let cmds = demo_commands();
        let tail = &cmds[cmds.len() - 5..];
        assert!(
            matches!(tail[0], GridCommand::Place { kind: machine_kind::ENDPOINT, .. }),
            "the caller Route is placed first: {:?}",
            tail[0]
        );
        assert!(
            matches!(tail[1], GridCommand::Place { kind: machine_kind::HANDLER, .. }),
            "then the HTTP Handler: {:?}",
            tail[1]
        );
        assert!(
            matches!(tail[2], GridCommand::Configure { config: MachineConfig::Factory { .. }, .. }),
            "then the handler's code: {:?}",
            tail[2]
        );
        assert!(
            matches!(&tail[3], GridCommand::Configure { config: MachineConfig::Endpoint { path }, .. } if path == "/hello"),
            "then the Route's readable path /hello (D-05): {:?}",
            tail[3]
        );
        // The Route's and the Handler's dense handles: one per node minted before them.
        let route = cmds[..cmds.len() - 5]
            .iter()
            .filter(|c| matches!(c, GridCommand::Place { .. } | GridCommand::DrawBelt { .. }))
            .count() as u64;
        assert!(
            matches!(tail[4], GridCommand::DrawWire { from_node, from_port: 1, to_node, to_port: 0 }
                if from_node == route && to_node == route + 1),
            "then the cable, the Route's Out (1) to the handler's In (0): {:?}",
            tail[4]
        );
    }

    /// The demo handler's code passes the same shape rule `fabrico-core`'s
    /// `handler_place.rs` readability walk applies to the palette Handler's preset: more
    /// than one line, and exactly one `body:` line, which carries `home` (D-04). The
    /// `x-fab: home` header is what spec 21 tells the demo handler from a palette one by.
    #[test]
    fn the_demo_handler_source_passes_the_readability_walk() {
        let source = demo_commands()
            .into_iter()
            .rev()
            .find_map(|c| match c {
                GridCommand::Configure {
                    config: MachineConfig::Factory { source },
                    ..
                } if source.contains("ctx.command(") => Some(source),
                _ => None,
            })
            .expect("the demo configures its HTTP Handler with code that replies");
        let lines: Vec<&str> = source.lines().collect();
        assert!(lines.len() > 1, "the handler code spans more than one line: {source:?}");
        let body_lines: Vec<&&str> = lines.iter().filter(|l| l.contains("body:")).collect();
        assert_eq!(body_lines.len(), 1, "exactly one `body:` line: {body_lines:?}");
        assert!(body_lines[0].contains("\"home\""), "the body is `home`: {}", body_lines[0]);
        assert!(
            source.contains("\"x-fab\": \"home\""),
            "the reply carries the `x-fab: home` header: {source:?}"
        );
    }

    /// `SceneId::ALL` holds every variant exactly once. The match is exhaustive with no
    /// wildcard, so a new variant fails to compile here until it is placed in `ALL`.
    #[test]
    fn scene_id_all_lists_every_variant_once() {
        let mut seen = [0usize; 3];
        for id in SceneId::ALL {
            let slot = match id {
                SceneId::Demo => 0,
                SceneId::OrderProcessing => 1,
                SceneId::Advanced => 2,
            };
            seen[slot] += 1;
        }
        assert_eq!(seen, [1, 1, 1], "every SceneId appears in ALL exactly once");
    }

    /// DEMO-09: a scene that fails to load names itself, by the exact string
    /// `SceneId::wire_id` returns, for every shipped scene and both ways a load can fail
    /// before anything is on the board: a malformed RON and an empty command list. The
    /// wrapped `SeedError`'s own sentence names no scene (D-25).
    #[test]
    fn every_scene_load_error_names_its_scene() {
        for id in SceneId::ALL {
            let cases: [(&str, Result<Vec<GridCommand>, SeedError>); 2] = [
                ("a malformed RON", load_board_commands("this is not ron [[[")),
                ("an empty command list", Ok(Vec::new())),
            ];
            for (what, commands) in cases {
                let (_dir, host) = test_host();
                let err = boot_scene_from(host, id, commands)
                    .err()
                    .unwrap_or_else(|| panic!("{} with {what} must fail to load", id.wire_id()));
                assert_eq!(err.scene, id, "the error carries the scene it came from");
                let msg = err.to_string();
                assert!(
                    msg.starts_with(&format!("scene \"{}\"", id.wire_id())),
                    "{what}: the sentence leads with the scene's wire id: {msg}"
                );
                let inner = err.source.to_string();
                assert!(
                    !inner.to_lowercase().contains("demo"),
                    "{what}: the SeedError sentence names no scene: {inner}"
                );
                assert!(
                    std::error::Error::source(&err).is_some(),
                    "{what}: the cause is chained"
                );
            }
        }
    }

    /// Every shipped scene boots through `boot_scene`, and every node on the booted board
    /// was minted by a record in its edit log (plan 85-08, D-02): the board's node count is
    /// what its minting commands mint, one per `Place` and `DrawBelt`, and per `DrawWire`
    /// one cable, or two when it joins a Route and an HTTP Handler (phase 72, D-04).
    #[test]
    fn every_scene_boots_through_boot_scene_with_every_node_from_the_log() {
        for id in SceneId::ALL {
            let dir = tempfile::tempdir().expect("tempdir");
            let core = Core::genesis(LogHeader {
                schema_version: SCHEMA_VERSION,
                seed: id.genesis_seed(),
            });
            let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
            let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
            let host = Host::new(core, store, ledger, None).expect("open host");
            let host = boot_scene(host, id).unwrap_or_else(|e| panic!("{e}"));
            let cmds = id.commands().expect("the embedded RON parses");
            // The kind each dense handle names, in mint order (a belt or cable as BELT/WIRE).
            let mut kinds: Vec<u8> = Vec::new();
            for c in &cmds {
                match c {
                    GridCommand::Place { kind, .. } => kinds.push(*kind),
                    GridCommand::DrawBelt { .. } => kinds.push(machine_kind::BELT),
                    GridCommand::DrawWire { from_node, to_node, .. } => {
                        let pair = [kinds[*from_node as usize], kinds[*to_node as usize]];
                        let paired = pair.contains(&machine_kind::ENDPOINT) && pair.contains(&machine_kind::HANDLER);
                        kinds.push(machine_kind::WIRE);
                        if paired {
                            kinds.push(machine_kind::WIRE);
                        }
                    }
                    _ => {}
                }
            }
            let minting = kinds.len();
            assert_eq!(
                host.core().state.node_ids().count(),
                minting,
                "{}: every node on the booted board is a logged Place, DrawBelt or DrawWire",
                id.wire_id()
            );
            assert!(!host.can_undo(), "{}: the scene's own commands sit under the undo floor", id.wire_id());
        }
    }

    #[test]
    fn boot_scene_builds_the_demo_through_the_certified_path() {
        // The happy path folds EVERY command (any reject is an Err), one per tick,
        // yielding the exact canonical topology.
        let (_dir, host) = test_host();
        let host = boot_scene(host, SceneId::Demo).unwrap_or_else(|e| panic!("{e}"));

        // One command per tick, then the history seal's tick (plan 85-06): the seeded core
        // sits exactly at tick == list len + HISTORY_SEAL_TICKS.
        assert_eq!(
            host.core().tick,
            demo_commands().len() as u64 + HISTORY_SEAL_TICKS,
            "one command folded per tick, then the seal (LIVE-04's tick-parity discipline)"
        );

        let core = &host.core().state;
        let (
            mut sources,
            mut belts,
            mut factories,
            mut tees,
            mut sinks,
            mut balancers,
            mut routers,
            mut merges,
            mut endpoints,
            mut wires,
            mut labels,
        ) = (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        for id in core.node_ids() {
            match core.node(id) {
                Some(Node::Source(_)) => sources += 1,
                Some(Node::Belt(_)) => belts += 1,
                Some(Node::Factory(_)) => factories += 1,
                Some(Node::Tee(_)) => tees += 1,
                Some(Node::Sink(_)) => sinks += 1,
                Some(Node::Balancer(_)) => balancers += 1,
                Some(Node::Router(_)) => routers += 1,
                Some(Node::Merge(_)) => merges += 1,
                Some(Node::Endpoint(_)) => endpoints += 1,
                Some(Node::Wire(_)) => wires += 1,
                Some(Node::Label(_)) => labels += 1,
                other => panic!("the demo minted an unexpected node {other:?}"),
            }
        }
        assert_eq!(sources, 1, "one SOURCE");
        assert_eq!(factories, 2, "the FACTORY and the HTTP Handler (a Handler folds to a Factory)");
        assert_eq!(tees, 1, "one TEE copies every order");
        assert_eq!(sinks, 5, "Post, Audit, Rejects and two freight docks");
        assert_eq!(balancers, 1, "one BALANCER");
        assert_eq!(routers, 1, "one ROUTER");
        assert_eq!(merges, 1, "one MERGE");
        assert_eq!(endpoints, 1, "one caller Route");
        assert_eq!(wires, 2, "the request cable and the reply cable");
        assert_eq!(belts, 11, "eleven drawn belts");
        assert_eq!(labels, 7, "seven section labels");

        // The HTTP Handler is the catalog's 3x3 with In, Out and Fault, unturned (D-01).
        let handler = core
            .node_ids()
            .find(|&id| {
                matches!(core.node(id), Some(n @ Node::Factory(_)) if fabrico_command::is_handler_shape(n, core.ports_of(id)))
            })
            .expect("the demo carries an HTTP Handler");
        let foot = core.footprint_of(handler).expect("the handler has a footprint");
        assert_eq!((foot.w, foot.h, foot.rot), (3, 3, 0), "the handler is the unturned catalog 3x3");
        assert_eq!(
            core.ports_of(handler).map(<[_]>::len),
            Some(3),
            "the handler carries the catalog's In, Out and Fault"
        );
        let caller = core
            .node_ids()
            .find(|&id| matches!(core.node(id), Some(Node::Endpoint(_))))
            .expect("the demo carries its caller Route");

        // The two cables dock separate nubs (D-01, DEMO-02).
        let links: Vec<((NodeId, u16), (NodeId, u16))> = core
            .node_ids()
            .filter_map(|id| match core.node(id) {
                Some(Node::Wire(w)) => Some((w.from, w.to)),
                _ => None,
            })
            .collect();
        assert!(
            links.contains(&((caller, 1), (handler, 0))),
            "the forward cable leaves the caller's Out (1) and enters the handler's In (0): {links:?}"
        );
        assert!(
            links.contains(&((handler, 1), (caller, 0))),
            "the return cable leaves the handler's Out (1) and enters the caller's In (0): {links:?}"
        );

        // The Rejects sink (anchored at (5,8)) carries the scene's one Rotate:
        // rot == 1 (one clockwise quarter-turn, In W -> N).
        let fault_sink = core
            .node_ids()
            .find(|&id| core.cell_of(id) == Some((5, 8)))
            .expect("the fault sink sits at (5,8)");
        assert!(
            matches!(core.node(fault_sink), Some(Node::Sink(_))),
            "the node at (5,8) is the fault SINK"
        );
        assert_eq!(
            core.footprint_of(fault_sink).expect("fault sink has a footprint").rot,
            1,
            "the fault sink was rotated one clockwise quarter-turn (In W -> N)"
        );
    }

    // ── DEMO-06: the jobs, proved on the seeded board (plan 85-08, D-14, D-15) ──────────

    /// The handles these tests address, read from `demo_scene.board.ron`'s own legend and pinned by
    /// [`the_demo_job_handles_are_the_ones_the_ron_docks`].
    const FACTORY: u64 = 1;
    const ROUTER: u64 = 7;
    const SMALL_LANE: u64 = 23;
    const MEDIUM_LANE: u64 = 24;
    const LARGE_LANE: u64 = 25;
    const POST_FEED: u64 = 26;
    const DOCK_A_FEED: u64 = 27;
    const DOCK_B_FEED: u64 = 28;
    /// The demo's belts, every one, so a test can say which carried an item.
    const BELTS: std::ops::RangeInclusive<u64> = 18..=28;

    /// A seeded demo (no timers, so the only items are the ones a test injects) with the
    /// channels `tick_once` needs and the Commands its sinks emit kept for reading.
    struct JobRig {
        _dir: tempfile::TempDir,
        host: Host,
        minted: Vec<NodeId>,
        ingress_tx: tokio::sync::mpsc::UnboundedSender<EventPayload>,
        ingress_rx: tokio::sync::mpsc::UnboundedReceiver<EventPayload>,
        cmd_tx: tokio::sync::mpsc::UnboundedSender<Command>,
        cmd_rx: tokio::sync::mpsc::UnboundedReceiver<Command>,
        results_rx: tokio::sync::mpsc::UnboundedReceiver<ResultEvent>,
        _res_tx: tokio::sync::mpsc::UnboundedSender<ResultEvent>,
    }

    impl JobRig {
        fn new() -> Self {
            let (dir, mut host) = test_host();
            let minted = seed_scene(&mut host, &demo_commands()).expect("the demo seeds");
            let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
            let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
            let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();
            Self {
                _dir: dir,
                host,
                minted,
                ingress_tx,
                ingress_rx,
                cmd_tx,
                cmd_rx,
                results_rx,
                _res_tx: res_tx,
            }
        }

        fn id(&self, handle: u64) -> NodeId {
            self.minted[handle as usize]
        }

        /// Hand one item to the demo's SOURCE (handle 0), the way its timer does.
        fn inject_source(&mut self, bytes: &[u8]) {
            let target = self.id(0);
            self.ingress_tx
                .send(EventPayload::ManualInject {
                    target,
                    port: 0,
                    item: fabrico_core::ids::Item(bytes.to_vec()),
                })
                .expect("the ingress channel is open");
        }

        /// Deliver one item straight into `handle`'s input port 0 (a logged `Input` event).
        fn input(&mut self, handle: u64, bytes: &[u8]) {
            let target = self.id(handle);
            self.ingress_tx
                .send(EventPayload::Input {
                    target,
                    port: 0,
                    item: fabrico_core::ids::Item(bytes.to_vec()),
                })
                .expect("the ingress channel is open");
        }

        fn tick(&mut self) {
            self.host
                .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
                .expect("tick persists");
        }

        /// The demo belts holding an item right now, by handle.
        fn carrying(&self) -> Vec<u64> {
            BELTS
                .filter(|&h| match self.host.core().state.node(self.id(h)) {
                    Some(Node::Belt(b)) => b.slots.iter().any(Option::is_some),
                    _ => false,
                })
                .collect()
        }

        /// Every Debug message the sinks emitted since the last read: one per item a sink took.
        fn sink_messages(&mut self) -> Vec<Vec<u8>> {
            let mut out = Vec::new();
            while let Ok(cmd) = self.cmd_rx.try_recv() {
                if let fabrico_core::command::Effect::Debug { message } = cmd.effect {
                    out.push(message);
                }
            }
            out
        }
    }

    /// The handle constants above are the ones `demo_scene.board.ron` docks, read off the list.
    #[test]
    fn the_demo_job_handles_are_the_ones_the_ron_docks() {
        let cmds = demo_commands();
        let dock = |belt: u64, endpoint: BeltEnd| {
            cmds.iter().find_map(|c| match c {
                GridCommand::Dock { belt: b, endpoint: e, node, port } if *b == belt && *e == endpoint => {
                    Some((*node, *port))
                }
                _ => None,
            })
        };
        assert_eq!(dock(SMALL_LANE, BeltEnd::Tail), Some((ROUTER, 3)), "the small lane leaves emit 2");
        assert_eq!(dock(MEDIUM_LANE, BeltEnd::Tail), Some((ROUTER, 1)), "the medium lane leaves emit 0");
        assert_eq!(dock(LARGE_LANE, BeltEnd::Tail), Some((ROUTER, 2)), "the large lane leaves emit 1");
        assert_eq!(dock(POST_FEED, BeltEnd::Tail), Some((8, 2)), "the Post feed leaves the Merge");
        assert_eq!(dock(DOCK_A_FEED, BeltEnd::Tail), Some((6, 2)), "dock A's feed leaves the Balancer");
        assert_eq!(dock(DOCK_B_FEED, BeltEnd::Tail), Some((6, 3)), "dock B's feed leaves the Balancer");
        assert!(
            matches!(cmds.get(FACTORY as usize + 1), Some(GridCommand::Place { kind: machine_kind::FACTORY, .. })),
            "handle 1 is the order FACTORY (the third command, after the Source and its timer)"
        );
    }

    /// D-15 edges: encoding (each rule's `expect` is the exact UTF-8 prefix), ordering (size
    /// first, rules first-match, small before large, medium by the default), and every output
    /// docked. One order of each size, injected straight into the Router in the exact shape
    /// the Factory emits, rides ITS lane and nothing else, and a sink takes it.
    #[test]
    fn one_order_of_each_size_reaches_its_lane_sink() {
        let cases: [(&str, u64, &[u64]); 3] = [
            (r#"{"size":"small","order":1,"qty":2}"#, SMALL_LANE, &[POST_FEED]),
            (r#"{"size":"medium","order":2,"qty":5}"#, MEDIUM_LANE, &[POST_FEED]),
            (r#"{"size":"large","order":3,"qty":8}"#, LARGE_LANE, &[DOCK_A_FEED, DOCK_B_FEED]),
        ];
        for (order, lane, sink_feeds) in cases {
            let mut rig = JobRig::new();
            rig.input(ROUTER, order.as_bytes());
            let mut carried: Vec<u64> = Vec::new();
            for _ in 0..400 {
                rig.tick();
                for h in rig.carrying() {
                    if !carried.contains(&h) {
                        carried.push(h);
                    }
                }
            }
            let lanes: Vec<u64> = carried
                .iter()
                .copied()
                .filter(|h| [SMALL_LANE, MEDIUM_LANE, LARGE_LANE].contains(h))
                .collect();
            assert_eq!(lanes, vec![lane], "{order} rides its own lane and no other (carried {carried:?})");
            assert!(
                sink_feeds.iter().any(|f| carried.contains(f)),
                "{order} goes on from its lane to its sink's feed belt {sink_feeds:?} (carried {carried:?})"
            );
            assert!(rig.carrying().is_empty(), "{order} is off every belt: a sink took it");
            assert_eq!(
                rig.sink_messages(),
                vec![order.as_bytes().to_vec()],
                "exactly one sink took exactly that order"
            );
        }
    }

    /// D-14 edges, through the real chain (each input handed to the SOURCE, as its timer
    /// does, then the Factory, the Tee and on): empty input (the timer's `{}` makes an
    /// order), any JSON object makes an order, ordering (`size` is the first key, so the Router's prefix is stable), and the
    /// only throw is the deliberate reject, which carries its own sentence down the fault belt
    /// and never takes an order number.
    #[test]
    fn the_demo_factory_makes_an_order_from_any_object_input() {
        let inputs: [&[u8]; 4] = [b"{}", br#"{"customer":"demo"}"#, br#"{"size":"huge","n":3}"#, br#"{"order":99}"#];
        let mut rig = JobRig::new();
        let injected = 120usize;
        for i in 0..injected {
            rig.inject_source(inputs[i % inputs.len()]);
            for _ in 0..DEMO_INJECT_EVERY {
                rig.tick();
            }
        }
        for _ in 0..600 {
            rig.tick();
        }
        let mut orders: Vec<serde_json::Value> = Vec::new();
        let mut rejects = 0usize;
        for msg in rig.sink_messages() {
            if let Ok(fault) = fabrico_core::fault::Fault::decode(&fabrico_core::ids::Item(msg.clone())) {
                let text = String::from_utf8_lossy(&fault.payload).into_owned();
                assert!(
                    text.contains("rejected: no delivery address"),
                    "the only fault is the deliberate reject, got {text:?}"
                );
                rejects += 1;
                continue;
            }
            let text = String::from_utf8(msg).expect("an order is UTF-8 JSON");
            assert!(text.starts_with(r#"{"size":""#), "size is emitted first: {text}");
            let v: serde_json::Value = serde_json::from_str(&text).expect("an order is JSON");
            assert!(
                matches!(v["size"].as_str(), Some("small" | "medium" | "large")),
                "a size the Router sorts: {text}"
            );
            assert!(v["qty"].as_u64().is_some_and(|q| (1..10).contains(&q)), "qty in 1..10: {text}");
            orders.push(v);
        }
        // Every order reaches TWO sinks (the Audit copy and its lane's sink); a reject one.
        assert_eq!(orders.len() % 2, 0, "each order is sunk twice, the audit copy and its lane");
        let made = orders.len() / 2;
        assert_eq!(made + rejects, injected, "every input became an order or a reject, nothing lost");
        assert!(rejects > 0, "non-vacuity: about one in twenty is rejected, {rejects} of {injected}");
        assert!(rejects < injected / 5, "but only about one in twenty: {rejects} of {injected}");
        let mut numbers: Vec<u64> = orders.iter().filter_map(|v| v["order"].as_u64()).collect();
        numbers.sort_unstable();
        numbers.dedup();
        assert_eq!(
            numbers,
            (1..=made as u64).collect::<Vec<_>>(),
            "orders are numbered 1..=made with no gap, so a reject never took a number"
        );
    }
}
