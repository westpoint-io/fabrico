//! Undo/redo correctness on the REAL demo-seeded board, the board the shipped app boots
//! into, and on sessions whose undo projection is misaligned with their core on purpose.
//!
//! Phase 51's verification found ROADMAP SC2 ("the add/remove undoes and redoes as a
//! single step") FALSE on the demo board of that time: a gated-safe `RemovePort` followed
//! by one Undo restored NOTHING and still spent an undo step. Empirical probing found two
//! siblings from the identical root cause, one of them destructive:
//!
//! 1. `RemovePort` -> Undo restores nothing.
//! 2. `Configure`  -> Undo restores nothing (the `prior_configs` twin).
//! 3. `Place`      -> Undo leaves the placed machine standing and silently DESTROYS a
//!    pre-existing request-pair node instead.
//!
//! Root cause: `GridSession::reconstruct_projection` rebuilds `removed_ports` /
//! `prior_configs` / `original_placed` by re-folding `edit_log` on a THROWAWAY
//! `Core::genesis(..)`. The demo of that time minted its request pair (a caller, a handler
//! and two cables, FOUR nodes) DIRECTLY on `core.state`, outside the edit log, after the
//! scene's commands. From that point the live slotmap allocator ran 4 slots ahead of the
//! throwaway one, so every capture keyed by a LIVE `NodeId` missed and every id HARVESTED
//! from the throwaway fold named a node 4 slots too early.
//!
//! SINCE PLAN 85-08 THE DEMO MINTS NOTHING OUTSIDE THE LOG: its Route and HTTP Handler
//! and both cables are ordinary logged commands at the end of `demo_scene.ron`. The
//! demo-board arms below now run on that board, which must stay correct for the plain
//! reason that it is what a user edits first. The guard arms that need a misaligned
//! projection build one on purpose and by logged commands only (plan 85-09): four
//! machines placed through the log, then the projection rebuilt from the log with those
//! four records trimmed off while the core keeps their machines
//! ([`trimmed_log_session`]). That is the shape of a hand-edited file whose saved board
//! holds machines its edit log no longer describes, and it puts the projection four
//! allocator slots behind the core exactly as the old demo did.
//!
//! Every test here drives the certified live path - `apply_gesture` -> `tick_once`,
//! ONE gesture per tick - on a `Host` built the way `demo_regenerability.rs` builds it.
//! Each demo-board arm is paired with a WIRE-LESS control (the demo's commands without
//! its trailing request pair): the controls were GREEN before the 51-04 fix and must stay
//! green, which is what proves the fix restores a broken case rather than trading one for
//! another.

use fabrico_command::{CommandError, GridSession};
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord, MachineConfig};
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::Node;
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, demo_commands, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{load_project, save_project};
use fabrico_protocol::{GridCommand, machine_kind};
use fabrico_scenario::tick_hash;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A free 3x3 anchor well clear of the demo scene (rows 0..8), of the headline wire
/// (row 6, cols 10..14) and of the e2e placement zone (3x3 anchored at row 11).
const PROBE_CELL: (i32, i32) = (10, 15);

/// The dense render handle every gesture below carries. The probe's `resolve` closure
/// maps EVERY handle to the one machine under test, so the value is arbitrary — what
/// matters is that the host resolves it to the LIVE `NodeId`, exactly as the frontend's
/// handle table does.
const PROBE_HANDLE: u64 = 0;

/// A probe host plus the channel triple `tick_once` requires. The unused halves are
/// held so the senders/receivers stay alive for the probe's lifetime (the same shape
/// `seed_scene` uses internally — no items exist, so nothing rides them).
struct Probe {
    host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    results_rx: UnboundedReceiver<ResultEvent>,
    cmd_tx: UnboundedSender<Command>,
    _ingress_tx: UnboundedSender<EventPayload>,
    _res_tx: UnboundedSender<ResultEvent>,
    _cmd_rx: UnboundedReceiver<Command>,
    /// Every tempdir the probe's lifetime depends on. A save/load arm holds THREE
    /// (the source work dir, the dir the `.fab` was written into, and the fresh load
    /// work dir `load_project` requires), so this is a Vec rather than one dir.
    _dirs: Vec<tempfile::TempDir>,
}

impl Probe {
    /// Issue ONE gesture and fold it, RETURNING the host's verdict instead of
    /// asserting acceptance — the seam every "…is NOT refused" arm below reads, so a
    /// refusal is a named assertion failure rather than an opaque `expect` panic.
    fn try_gesture(&mut self, cmd: GridCommand, node: NodeId) -> Result<(), CommandError> {
        let r = apply_gesture(&mut self.host, cmd, move |_| Some(node));
        if r.is_ok() {
            self.tick();
        }
        r
    }

    /// Fold ONE tick (the certified `tick_once`).
    fn tick(&mut self) {
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("tick_once persists and folds");
    }

    /// Issue ONE gesture through the certified live path, then fold it in ONE tick.
    /// `resolve` maps every dense handle to `node` — the probe addresses exactly one
    /// machine, so a constant resolver is sufficient and unambiguous.
    fn gesture(&mut self, cmd: GridCommand, node: NodeId) {
        apply_gesture(&mut self.host, cmd, move |_| Some(node)).expect("the gesture is accepted");
        self.tick();
    }

    /// The node's port list as `(role, medium)` wire bytes — read through the core's
    /// single port authority, never a hand-rolled whole-core comparison.
    fn port_shapes(&self, node: NodeId) -> Vec<(u8, u8)> {
        self.host
            .core()
            .state
            .ports_of(node)
            .map(|ps| {
                ps.iter()
                    .map(|p| (p.role as u8, p.medium as u8))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    }

    /// Every live node id, as a sorted set for difference checks.
    fn node_ids(&self) -> Vec<NodeId> {
        let mut ids: Vec<NodeId> = self.host.core().state.node_ids().collect();
        ids.sort_unstable();
        ids
    }

    /// The Factory's authored JS source, or `None` if the node is not a live Factory.
    fn factory_source(&self, node: NodeId) -> Option<String> {
        match self.host.core().state.node(node) {
            Some(Node::Factory(f)) => Some(f.source.clone()),
            _ => None,
        }
    }
}

/// The demo's command list WITHOUT its request pair: the five commands at its end that
/// place the Route and HTTP Handler, configure them and draw their cables (one DrawWire
/// mints both; D-03 puts them last, so cutting them leaves every earlier handle as it
/// was). The wire-less control board.
fn demo_commands_without_the_request_pair() -> Vec<GridCommand> {
    let cmds = demo_commands();
    let at = cmds
        .iter()
        .position(|c| matches!(c, GridCommand::Place { kind: machine_kind::ENDPOINT, .. }))
        .expect("the demo places its caller Route");
    assert_eq!(cmds.len() - at, 5, "the request pair is the demo's last five commands");
    cmds[..at].to_vec()
}

/// Build a `Host` seeded the way the shipped app seeds it: genesis at
/// [`DEMO_GENESIS_SEED`], the demo's commands through the certified gesture path
/// (`seed_scene`, which seals the history). With `with_request_pair` the whole demo,
/// Route, HTTP Handler and both cables included; without it, the wire-less control.
/// No timers are installed, so the probe board stays quiescent between gestures.
fn demo_host(with_request_pair: bool) -> Probe {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: DEMO_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    let cmds = if with_request_pair {
        demo_commands()
    } else {
        demo_commands_without_the_request_pair()
    };
    seed_scene(&mut host, &cmds).expect("seed_scene folds every demo command");

    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    Probe {
        host,
        ingress_rx,
        results_rx,
        cmd_tx,
        _ingress_tx: ingress_tx,
        _res_tx: res_tx,
        _cmd_rx: cmd_rx,
        _dirs: vec![dir],
    }
}

/// Place a Factory at [`PROBE_CELL`] and fold it, returning its live `NodeId`.
/// The `Place` gesture takes no handle, so the resolver is irrelevant here.
fn place_probe_factory(probe: &mut Probe) -> NodeId {
    apply_gesture(
        &mut probe.host,
        GridCommand::Place {
            kind: machine_kind::FACTORY,
            cell_x: PROBE_CELL.0,
            cell_y: PROBE_CELL.1,
        },
        |_| None,
    )
    .expect("the probe cell is free");
    probe.tick();
    *probe
        .host
        .core()
        .last_tick
        .placed
        .last()
        .expect("the Place minted the probe Factory")
}

/// The `+ Add output` gesture the panel ships: exactly one `{Out, E, Mechanical}`.
fn add_output() -> GridCommand {
    GridCommand::AddPort {
        node: PROBE_HANDLE,
        role: 1,   // Out
        side: 1,   // E
        medium: 0, // Mechanical
    }
}

// ── Task 1: RemovePort ───────────────────────────────────────────────────────────

/// THE REPORTED GAP (ROADMAP SC2). On the board the app boots into, remove an output
/// and press Undo once: the port must come back.
#[test]
fn remove_undo_restores_the_port_on_the_demo_board() {
    let mut probe = demo_host(true);
    let node = place_probe_factory(&mut probe);

    probe.gesture(add_output(), node);
    let after_add = probe.port_shapes(node);
    assert_eq!(after_add.len(), 4, "the AddPort appended a fourth port");

    let last = u16::try_from(after_add.len() - 1).expect("a port index fits u16");
    probe.gesture(GridCommand::RemovePort { node: PROBE_HANDLE, index: last }, node);
    assert_eq!(
        probe.port_shapes(node).len(),
        3,
        "the RemovePort folded (precondition for the undo probe)"
    );

    probe.gesture(GridCommand::Undo, node);
    assert_eq!(
        probe.port_shapes(node),
        after_add,
        "one Undo of a RemovePort must RESTORE the removed port on the demo board"
    );
}

/// The regression control: the identical sequence on a board seeded WITHOUT the
/// headline wire. Green before the fix, and must stay green after it.
#[test]
fn remove_undo_control_on_a_wire_less_board() {
    let mut probe = demo_host(false);
    let node = place_probe_factory(&mut probe);

    probe.gesture(add_output(), node);
    let after_add = probe.port_shapes(node);

    let last = u16::try_from(after_add.len() - 1).expect("a port index fits u16");
    probe.gesture(GridCommand::RemovePort { node: PROBE_HANDLE, index: last }, node);
    probe.gesture(GridCommand::Undo, node);

    assert_eq!(
        probe.port_shapes(node),
        after_add,
        "the wire-less control must keep restoring the removed port"
    );
}

/// Undo/redo symmetry: the Redo removes the port again (the fix must not make the
/// pair asymmetric).
#[test]
fn remove_redo_removes_it_again() {
    let mut probe = demo_host(true);
    let node = place_probe_factory(&mut probe);

    probe.gesture(add_output(), node);
    let after_add = probe.port_shapes(node);

    let last = u16::try_from(after_add.len() - 1).expect("a port index fits u16");
    probe.gesture(GridCommand::RemovePort { node: PROBE_HANDLE, index: last }, node);
    let after_remove = probe.port_shapes(node);

    probe.gesture(GridCommand::Undo, node);
    assert_eq!(probe.port_shapes(node), after_add, "the Undo restored the port");

    probe.gesture(GridCommand::Redo, node);
    assert_eq!(
        probe.port_shapes(node),
        after_remove,
        "the Redo removes the restored port again (symmetric undo/redo)"
    );
}

// ── Task 2: the Configure twin and the minted-id harvest ─────────────────────────

/// The `prior_configs` twin the verifier flagged unprobed: an undo of a Factory
/// Configure must restore the PRIOR source.
#[test]
fn configure_undo_restores_the_prior_source_on_the_demo_board() {
    let mut probe = demo_host(true);
    let node = place_probe_factory(&mut probe);
    let original = probe
        .factory_source(node)
        .expect("the probe machine is a live Factory");

    probe.gesture(
        GridCommand::Configure {
            node: PROBE_HANDLE,
            config: probe_config(),
        },
        node,
    );
    assert_ne!(
        probe.factory_source(node).as_deref(),
        Some(original.as_str()),
        "the Configure folded (precondition for the undo probe)"
    );

    probe.gesture(GridCommand::Undo, node);
    assert_eq!(
        probe.factory_source(node),
        Some(original),
        "one Undo of a Configure must restore the PRIOR source on the demo board"
    );
}

/// The wire-less control for the Configure arm.
#[test]
fn configure_undo_control_on_a_wire_less_board() {
    let mut probe = demo_host(false);
    let node = place_probe_factory(&mut probe);
    let original = probe
        .factory_source(node)
        .expect("the probe machine is a live Factory");

    probe.gesture(
        GridCommand::Configure {
            node: PROBE_HANDLE,
            config: probe_config(),
        },
        node,
    );
    probe.gesture(GridCommand::Undo, node);

    assert_eq!(
        probe.factory_source(node),
        Some(original),
        "the wire-less control must keep restoring the prior source"
    );
}

/// THE DESTRUCTIVE SIBLING. An Undo of a Place must delete the PLACED machine and
/// nothing else — today it leaves the machine standing and kills a headline-wire node.
#[test]
fn place_undo_removes_the_placed_machine_and_destroys_nothing_else() {
    let mut probe = demo_host(true);
    let before = probe.node_ids();

    let node = place_probe_factory(&mut probe);
    probe.gesture(GridCommand::Undo, node);

    assert!(
        probe.host.core().state.node(node).is_none(),
        "the Undo of a Place must DELETE the placed machine"
    );
    let after = probe.node_ids();
    let destroyed: Vec<NodeId> = before.iter().copied().filter(|id| !after.contains(id)).collect();
    assert!(
        destroyed.is_empty(),
        "the Undo of a Place must destroy NO pre-existing node, but it destroyed {destroyed:?}"
    );
}

/// The wire-less control for the Place arm.
#[test]
fn place_undo_control_on_a_wire_less_board() {
    let mut probe = demo_host(false);
    let before = probe.node_ids();

    let node = place_probe_factory(&mut probe);
    probe.gesture(GridCommand::Undo, node);

    assert!(
        probe.host.core().state.node(node).is_none(),
        "the wire-less control must keep deleting the placed machine"
    );
    let after = probe.node_ids();
    let destroyed: Vec<NodeId> = before.iter().copied().filter(|id| !after.contains(id)).collect();
    assert!(
        destroyed.is_empty(),
        "the wire-less control must destroy no pre-existing node, but it destroyed {destroyed:?}"
    );
}

/// Undo then Redo re-mints the machine and leaves the pre-existing node set intact —
/// pins the `Redo` marker's `xlate` refresh, which reads the same minted-id harvest.
#[test]
fn place_undo_redo_round_trips_the_machine() {
    let mut probe = demo_host(true);
    let before = probe.node_ids();

    let node = place_probe_factory(&mut probe);
    probe.gesture(GridCommand::Undo, node);
    probe.gesture(GridCommand::Redo, node);

    let after = probe.node_ids();
    let destroyed: Vec<NodeId> = before.iter().copied().filter(|id| !after.contains(id)).collect();
    assert!(
        destroyed.is_empty(),
        "the Redo must leave every pre-existing node alive, but these are gone: {destroyed:?}"
    );
    assert_eq!(
        after.len(),
        before.len() + 1,
        "the Redo re-minted exactly the one machine the Place minted"
    );
    let remint: Vec<NodeId> = after.iter().copied().filter(|id| !before.contains(id)).collect();
    assert_eq!(remint.len(), 1, "exactly one node was re-minted");
    assert!(
        matches!(
            probe.host.core().state.node(remint[0]),
            Some(Node::Factory(_))
        ),
        "the re-minted node is the probe Factory"
    );
}

/// The probe config: a Factory source that is never the placed default, so the
/// "did the Configure fold?" precondition is unambiguous.
fn probe_config() -> fabrico_protocol::MachineConfig {
    fabrico_protocol::MachineConfig::Factory {
        source: "export default function (input, ctx) { /*PROBE-A*/ }".to_owned(),
    }
}

// ── 51-05 Task 1: the target-identity guard ──────────────────────────────────────
//
// 51-04 made the LIVE session's captures authoritative, which removed today's CAUSE
// of a misaligned inverse. These arms pin the BACKSTOP for the whole CLASS: an
// inverse that would `Delete` a node the record does not describe is REFUSED, not
// executed. The refusal is a typed `CommandError` - loud to callers, to these tests
// and, since Phase 64, to the user: the gesture drain (`SimLoop::acquire_input` in
// `crates/fabrico-host/src/sim_loop.rs`) answers the gesture envelope's reply with the
// verdict instead of discarding it, so a refused Ctrl+Z shows "The host could not read
// that gesture." rather than doing nothing in silence. That is strictly better than
// destroying a bystander node and strictly worse than working; it is a residual,
// never a repair.

/// The cell the misalignment arms place their probe Factory at, clear of the four
/// leading machines and of [`PROBE_CELL`].
const MISALIGN_CELL: (i32, i32) = (20, 20);

/// How many leading records [`place_four_by_the_log`] writes, and therefore how many the
/// trimmed projection drops.
const LEADING_RECORDS: usize = 4;

/// Place FOUR machines through the log, one `Place` record each, at cells the probe never
/// touches: the first [`LEADING_RECORDS`] records of every session the guard arms build.
fn place_four_by_the_log(live: &mut GridSession) {
    for (kind, x, y) in [
        (machine_kind::SOURCE, 10, 6),
        (machine_kind::FACTORY, 14, 6),
        (machine_kind::SOURCE, 10, 12),
        (machine_kind::FACTORY, 14, 12),
    ] {
        live.apply(GridCommand::Place { kind, cell_x: x, cell_y: y })
            .expect("a leading machine's cells are free");
    }
    assert_eq!(live.edit_log().len(), LEADING_RECORDS, "one record per leading machine");
}

/// The LOAD PATH over a file whose edit log was trimmed of its leading records: the undo
/// projection is a PURE fold of what the log still holds (`GridSession::replay`, which is
/// what `Host::recover` uses), while the core is the saved FULL-STATE board, which still
/// holds the four leading machines. The projection's throwaway allocator therefore runs
/// four slots behind the core. Every node was minted by a logged command; only the file's
/// log is short.
fn trimmed_log_load(live: &GridSession) -> GridSession {
    let mut loaded = GridSession::replay(DEMO_GENESIS_SEED, &live.edit_log()[LEADING_RECORDS..]);
    *loaded.core_mut() = live.core().clone();
    loaded
}

/// A headless `GridSession` with the four leading machines ([`place_four_by_the_log`])
/// and ONE more logged `Place` on top. Returns the session, the id that `Place` really
/// minted, and every id that existed before it.
fn trimmed_log_session() -> (GridSession, NodeId, Vec<NodeId>) {
    let mut live = GridSession::new(DEMO_GENESIS_SEED);
    place_four_by_the_log(&mut live);
    let before: Vec<NodeId> = sorted_ids(live.core());
    live.apply(GridCommand::Place {
        kind: machine_kind::FACTORY,
        cell_x: MISALIGN_CELL.0,
        cell_y: MISALIGN_CELL.1,
    })
    .expect("the misalignment probe cell is free");
    let placed = *live
        .core()
        .last_tick
        .placed
        .last()
        .expect("the Place minted the probe Factory");
    (live, placed, before)
}

/// Every live node id in `core`, sorted (the difference-check basis).
fn sorted_ids(core: &Core) -> Vec<NodeId> {
    let mut ids: Vec<NodeId> = core.state.node_ids().collect();
    ids.sort_unstable();
    ids
}

/// THE MISALIGNMENT, by logged commands only (plan 85-09). [`trimmed_log_load`] is the
/// load path over a file whose edit log no longer describes four machines its saved
/// board holds, so the projection and the core disagree and `original_placed` names a
/// real-but-WRONG node. Before the guard, the Place inverse emitted
/// `Delete { node: <that bystander> }` and the undo silently destroyed it while leaving
/// the placed machine standing. It must be a typed refusal that leaves the core
/// byte-identical.
///
/// Until plan 85-09 the misalignment came from four nodes minted straight onto the core,
/// the shipped demo's shape of the time. No shipped board has that shape now, but a
/// hand-edited file still can disagree with its own log, and the guard is what stands
/// between that file and a bystander, so the arm is kept in this logged-only form.
#[test]
fn misaligned_place_undo_is_refused_not_destructive() {
    let (live, placed, _before) = trimmed_log_session();

    let mut loaded = trimmed_log_load(&live);

    let before_ids = sorted_ids(loaded.core());
    let before_hash = tick_hash(loaded.core());
    assert!(
        loaded.can_undo(),
        "the reloaded session still carries the Place as an undoable action"
    );

    let verdict = loaded.apply(GridCommand::Undo).map(|_| ());

    // THE DATA-LOSS HALF FIRST, unconditionally — this is the assertion that was
    // empirically false before the guard (the undo deleted a bystander node).
    let after_ids = sorted_ids(loaded.core());
    let destroyed: Vec<NodeId> = before_ids
        .iter()
        .copied()
        .filter(|id| !after_ids.contains(id))
        .collect();
    assert!(
        destroyed.is_empty(),
        "a misaligned undo must destroy NOTHING, but these nodes are gone: {destroyed:?} \
         (verdict was {verdict:?})"
    );
    assert!(
        matches!(verdict, Err(CommandError::UndoDoesNotFit)),
        "a Place inverse whose target is not the node the record describes must be a \
         typed refusal, got {verdict:?}"
    );
    assert_eq!(
        tick_hash(loaded.core()),
        before_hash,
        "a refused undo leaves the core BYTE-IDENTICAL (SC#2: no mutation on reject)"
    );
    assert!(
        loaded.core().state.node(placed).is_some(),
        "the placed machine is untouched by the refusal"
    );
}

/// The no-fire control on the IDENTICAL board and the IDENTICAL action: the LIVE
/// session, whose projection is aligned, must pass the guard untouched. Same leading
/// machines, same Place, opposite verdict, which is what proves the guard discriminates
/// on target identity and not merely on "this board has other machines".
#[test]
fn legitimate_place_undo_still_passes_the_guard() {
    let (mut live, placed, before) = trimmed_log_session();

    live.apply(GridCommand::Undo)
        .expect("a legitimate Place undo must NOT be refused");

    assert!(
        live.core().state.node(placed).is_none(),
        "the legitimate undo still DELETES the placed machine"
    );
    let after = sorted_ids(live.core());
    let destroyed: Vec<NodeId> = before.iter().copied().filter(|id| !after.contains(id)).collect();
    assert!(
        destroyed.is_empty(),
        "the legitimate undo destroys no pre-existing node, but these are gone: {destroyed:?}"
    );
}

/// A `DrawBelt` inverse carries `kind = BELT` and a SENTINEL cell `(0, 0)` by
/// construction (`command.rs` DrawBelt arm), so the guard's cell clause MUST NOT be
/// applied to belts. Asserted explicitly here rather than discovered as a regression.
#[test]
fn belt_undo_still_passes_the_guard() {
    let mut probe = demo_host(true);
    let before = probe.node_ids();

    apply_gesture(
        &mut probe.host,
        GridCommand::DrawBelt {
            cells: vec![(20, 30), (21, 30), (22, 30)],
        },
        |_| None,
    )
    .expect("the belt cells are free");
    probe.tick();
    let belt = *probe
        .host
        .core()
        .last_tick
        .placed
        .last()
        .expect("the DrawBelt minted a belt");

    apply_gesture(&mut probe.host, GridCommand::Undo, |_| None)
        .expect("a legitimate belt undo must NOT be refused (sentinel cell (0,0))");
    probe.tick();

    assert!(
        probe.host.core().state.node(belt).is_none(),
        "the Undo of a DrawBelt still removes the belt"
    );
    let after = probe.node_ids();
    let destroyed: Vec<NodeId> = before.iter().copied().filter(|id| !after.contains(id)).collect();
    assert!(
        destroyed.is_empty(),
        "the belt undo destroys no pre-existing node, but these are gone: {destroyed:?}"
    );
}

/// The FOOTPRINT-GROWTH arm, on the REAL demo board. `AddPort` grows the footprint, so
/// by the time the Place inverse is computed the node's footprint is NOT the one it had
/// when the Place record was written. The guard's cell clause reads the ANCHOR
/// (`GridState::cell_of`). Since 74.1-16 a growing add on a TURNED machine shifts the
/// anchor by the growth (review WR-01), and the add's own inverse carries the pre-add box
/// and anchor back (`RemovePort.restore`), so by the time the Place inverse runs the
/// anchor is the placed one again. This arm (an unturned Factory) proves the two undos
/// still pass the guard rather than assuming it; `port_edits_keep_place.rs` pins the
/// turned anchor's restore.
#[test]
fn place_then_add_output_then_two_undos_are_not_refused() {
    let mut probe = demo_host(true);
    let before = probe.node_ids();

    let node = place_probe_factory(&mut probe);
    probe
        .try_gesture(add_output(), node)
        .expect("the + Add output gesture is accepted");
    assert_eq!(
        probe.port_shapes(node).len(),
        4,
        "the AddPort grew the port list (and the footprint) before the undos"
    );

    probe
        .try_gesture(GridCommand::Undo, node)
        .expect("the FIRST undo (inverting the AddPort) must not be refused");
    probe
        .try_gesture(GridCommand::Undo, node)
        .expect("the SECOND undo (inverting the Place) must NOT be refused after a footprint growth");

    assert!(
        probe.host.core().state.node(node).is_none(),
        "the second undo deleted the placed machine"
    );
    let after = probe.node_ids();
    let destroyed: Vec<NodeId> = before.iter().copied().filter(|id| !after.contains(id)).collect();
    assert!(
        destroyed.is_empty(),
        "no pre-place node may be lost, but these are gone: {destroyed:?}"
    );
}

// ── UO-1: the target-identity guard, REDO direction ──────────────────────────────
//
// The arms above guard the two UNDO sites that emit a `Delete`. `compute_inverse`'s
// REDO arm emits a third — re-deleting a machine an undo had restored — and T-51H-01
// scoped itself to undo, leaving that one unguarded. Same destruction class, opposite
// direction: a `Delete` whose `live(node)` names a node the record does not describe
// destroys a bystander. Reachability is narrower (it needs an ALREADY-misaligned
// projection AND a prior SUCCESSFUL undo of a Delete-bearing group), which is why the
// security audit rated it medium and non-blocking — but a guard applied to one
// direction of a symmetric operation is the shape of defect this phase exists to stop
// shipping.
//
// The redo guard reads `self.core` (the state the redo group folds against) and is
// DISCRIMINATED exactly like the capture-miss guards: it refuses only when it can
// PROVE a wrong target (the node is live AND its kind/anchor disagree with the
// record). An absent target emits an inert Delete and is left alone, because refusing
// there would over-block. The belt cell clause is skipped for the same reason it is
// skipped on the DrawBelt undo arm — a belt has no anchor and its Delete record
// carries the sentinel `(0, 0)`.

/// A misaligned session whose most recent action is a SUCCESSFUL undo of a logged
/// `Delete` — UO-1's precondition, built the same way [`trimmed_log_session`] builds
/// T-51H-01's. The undo happens on the LIVE session (so it is genuinely legitimate and
/// genuinely succeeds); the misalignment is introduced afterwards by the trimmed-log
/// LOAD path ([`trimmed_log_load`]), where `reconstruct_projection` refreshes `xlate`
/// from a throwaway re-fold that never folds the four leading machines, so `xlate` maps
/// the deleted machine onto a real-but-WRONG live node.
fn trimmed_log_delete_undone_session() -> (GridSession, NodeId, Vec<NodeId>) {
    let mut live = GridSession::new(DEMO_GENESIS_SEED);
    place_four_by_the_log(&mut live);
    live.apply(GridCommand::Place {
        kind: machine_kind::FACTORY,
        cell_x: MISALIGN_CELL.0,
        cell_y: MISALIGN_CELL.1,
    })
    .expect("the misalignment probe cell is free");
    let placed = *live
        .core()
        .last_tick
        .placed
        .last()
        .expect("the Place minted the probe Factory");
    let handle = live
        .view()
        .handle_of(placed)
        .expect("the placed Factory carries a dense render handle");
    live.apply(GridCommand::Delete { node: handle })
        .expect("the probe Factory is deletable");
    live.apply(GridCommand::Undo)
        .expect("the delete-undo restores the Factory (no guard on the Delete undo arm)");
    let restored = *live
        .core()
        .last_tick
        .placed
        .first()
        .expect("the delete-undo re-minted the machine");

    let loaded = trimmed_log_load(&live);
    let before = sorted_ids(loaded.core());
    (loaded, restored, before)
}

/// THE FIRE TEST. A redo of a `Delete` on a misaligned projection must be a typed
/// refusal that destroys nothing — NOT a `Delete` aimed at whatever node `xlate`
/// happens to name. Written as the data-loss assertion FIRST, unconditionally: that is
/// the half that is empirically false without the guard.
#[test]
fn misaligned_delete_redo_is_refused_not_destructive() {
    let (mut loaded, restored, before_ids) = trimmed_log_delete_undone_session();
    let before_hash = tick_hash(loaded.core());
    assert!(
        loaded.can_redo(),
        "the reloaded session still offers the undone Delete as a redo"
    );

    let verdict = loaded.apply(GridCommand::Redo).map(|_| ());

    // THE DATA-LOSS HALF FIRST. A refused redo folds NOTHING, so the pre-redo id set
    // must be entirely intact — including the machine the redo was aiming at.
    let after_ids = sorted_ids(loaded.core());
    let destroyed: Vec<NodeId> = before_ids
        .iter()
        .copied()
        .filter(|id| !after_ids.contains(id))
        .collect();
    assert!(
        destroyed.is_empty(),
        "a misaligned redo must destroy NOTHING, but these nodes are gone: {destroyed:?} \
         (verdict was {verdict:?})"
    );
    assert!(
        matches!(verdict, Err(CommandError::UndoDoesNotFit)),
        "a Delete redo whose target is not the node the record describes must be a \
         typed refusal, got {verdict:?}"
    );
    assert_eq!(
        tick_hash(loaded.core()),
        before_hash,
        "a refused redo leaves the core BYTE-IDENTICAL (SC#2: no mutation on reject)"
    );
    assert!(
        loaded.core().state.node(restored).is_some(),
        "the restored machine the redo was aiming at is untouched by the refusal"
    );
}

/// THE NO-FIRE CONTROL, on the IDENTICAL board and the IDENTICAL action sequence: the
/// LIVE session (whose projection is aligned) must redo the delete untouched. Same
/// leading machines, same place/delete/undo, opposite verdict, which is what proves the
/// redo guard discriminates on target identity and not merely on "this board has other
/// machines". A redo guard that refuses a legitimate redo is a worse defect than the one
/// it fixes.
#[test]
fn legitimate_delete_redo_still_passes_the_guard() {
    let mut live = GridSession::new(DEMO_GENESIS_SEED);
    place_four_by_the_log(&mut live);
    let before = sorted_ids(live.core());
    live.apply(GridCommand::Place {
        kind: machine_kind::FACTORY,
        cell_x: MISALIGN_CELL.0,
        cell_y: MISALIGN_CELL.1,
    })
    .expect("the misalignment probe cell is free");
    let placed = *live
        .core()
        .last_tick
        .placed
        .last()
        .expect("the Place minted the probe Factory");
    let handle = live
        .view()
        .handle_of(placed)
        .expect("the placed Factory carries a dense render handle");
    live.apply(GridCommand::Delete { node: handle })
        .expect("the probe Factory is deletable");
    live.apply(GridCommand::Undo)
        .expect("the delete-undo restores the Factory");
    let restored = *live
        .core()
        .last_tick
        .placed
        .first()
        .expect("the delete-undo re-minted the machine");

    live.apply(GridCommand::Redo)
        .expect("a legitimate Delete redo must NOT be refused");

    assert!(
        live.core().state.node(restored).is_none(),
        "the legitimate redo still DELETES the restored machine"
    );
    let after = sorted_ids(live.core());
    let destroyed: Vec<NodeId> = before.iter().copied().filter(|id| !after.contains(id)).collect();
    assert!(
        destroyed.is_empty(),
        "the legitimate redo destroys no pre-existing node, but these are gone: {destroyed:?}"
    );
}

/// THE BELT NO-FIRE CONTROL, and the redo-side mirror of
/// [`belt_undo_still_passes_the_guard`]. A belt's `Delete` record carries `kind = BELT`
/// and the SENTINEL cell `(0, 0)` — `validate_normalize` writes
/// `cell_of(belt).unwrap_or((0, 0))` and `cell_of` is `None` for a belt (belts are
/// minted by `fold_draw_belt`, which claims tiles but never inserts a `cells` anchor).
/// Applying the guard's cell clause to belts would therefore refuse EVERY legitimate
/// belt redo. Pinned explicitly rather than discovered as a regression.
///
/// Driven through the pub `replay` primitive on a hand-built log rather than through
/// `apply(Delete) + apply(Undo)`. That choice is HISTORICAL and this paragraph records
/// why, because the reason it was made is no longer true and a reader who inherits the
/// old wording re-derives a defect that is fixed.
///
/// WHAT THIS COMMENT USED TO SAY, and why it is wrong now. It said the live route
/// could not reach a belt redo at all, because the `Delete` UNDO arm restored a
/// machine by re-emitting `Place { kind }`, `fold_place` refuses to mint a BELT
/// (17-02 removed the belt mint arm), and `command.rs`'s
/// `.expect("the re-Place re-mints the machine")` therefore blew up on the undo
/// before any redo existed.
///
/// WHAT THE CODE DOES TODAY, measured 2026-09-05. The panic went first: plan 63-03
/// replaced it with a typed `CommandError::Malformed` refusal, so the undo stopped
/// unwinding the session. Then plan 73-05 gave the `Delete` UNDO arm a `DrawBelt`
/// self-record leg off `DeletedSubgraph.self_record`, so undoing the delete of a bare
/// drawn belt now returns `Ok` and hands the belt back with its own tiles, its cells
/// re-claimed and its docks re-linked. Pinned by
/// `crates/fabrico-command/tests/undo_restores_a_bare_belt.rs`. The only remaining
/// refusal on that path is a self-record carrying zero tiles, which is refused
/// deliberately rather than folded into a degenerate belt.
///
/// The forged-log path is KEPT because it still buys what it always bought: it pins
/// the guard's belt discrimination independently of whatever the undo arm happens to
/// do, so a later change to the restore leg cannot silently make the belt redo start
/// refusing without this row noticing.
#[test]
fn belt_delete_redo_is_not_refused_by_the_sentinel_cell() {
    const BELT_CELLS: [(i32, i32); 3] = [(20, 30), (21, 30), (22, 30)];

    // Learn the real `DrawBelt` record + the belt id a genesis core mints for it.
    let mut probe = GridSession::new(DEMO_GENESIS_SEED);
    probe
        .apply(GridCommand::DrawBelt {
            cells: BELT_CELLS.to_vec(),
        })
        .expect("the belt cells are free");
    let belt = *probe
        .core()
        .last_tick
        .placed
        .last()
        .expect("the DrawBelt minted a belt");
    let draw = probe.edit_log()[0].op.clone();

    // A log in the shape a delete-then-undo leaves behind: draw (action 0), delete the
    // belt (action 1), then an Undo group for action 1 that physically re-draws it.
    let rec = |sequence: u64, tick: u64, action: u64, op: EditOp| EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence,
        tick,
        action,
        op,
    };
    let forged = vec![
        rec(0, 0, 0, draw.clone()),
        rec(
            1,
            1,
            1,
            EditOp::Delete {
                node: belt,
                kind: machine_kind::BELT,
                cell_x: 0,
                cell_y: 0,
                captured: fabrico_core::edit::DeletedSubgraph::default(),
            },
        ),
        rec(2, 2, 2, EditOp::Undo { target_action: 1 }),
        rec(3, 2, 2, draw),
    ];
    let session = GridSession::replay(DEMO_GENESIS_SEED, &forged);
    assert!(
        session.can_redo(),
        "the undone Delete is on the redo stack (fixture precondition)"
    );

    let group = session
        .resolve_redo()
        .expect("a BELT Delete redo must NOT be refused by the sentinel-cell clause");

    let target = group
        .iter()
        .find_map(|r| match &r.op {
            EditOp::Delete { node, kind, .. } => Some((*node, *kind)),
            _ => None,
        })
        .expect("the redo group re-emits the Delete");
    assert_eq!(target.1, machine_kind::BELT, "it is the BELT delete");
    assert!(
        session.core().state.node(target.0).is_some(),
        "and it is retargeted at the LIVE re-drawn belt, not the stale pre-undo id"
    );
    assert!(
        session.core().state.cell_of(target.0).is_none(),
        "the live belt has NO anchor cell — which is exactly why the guard's cell \
         clause must not be applied to it"
    );
}

/// THE OVER-BLOCK CONTROL for the guard's `is_some()` pre-filter — the clause that
/// makes this a refuse-only-on-PROOF guard rather than a blanket reject. A redo whose
/// `Delete` target is ABSENT from the core has nothing to destroy: the record folds as
/// a documented no-op. The guard must SKIP it, exactly as the `RemovePort` capture-miss
/// arm skips an absent node (`command.rs:1944-1945`), because refusing there would
/// refuse a redo purely for being inert.
///
/// Mutation-checked: without the `is_some()` clause `inverse_target_matches` returns
/// `false` on an absent node and this arm becomes `Err(UndoDoesNotFit)`. That mutation is
/// caught by NO other test in the workspace (885 green either way), which is why this
/// control exists — the discrimination would otherwise read as removable noise.
#[test]
fn redo_of_a_delete_whose_target_is_absent_is_skipped_not_refused() {
    // Learn the real Place record + the node id a genesis core mints for it.
    let mut probe = GridSession::new(DEMO_GENESIS_SEED);
    probe
        .apply(GridCommand::Place {
            kind: machine_kind::FACTORY,
            cell_x: MISALIGN_CELL.0,
            cell_y: MISALIGN_CELL.1,
        })
        .expect("the misalignment probe cell is free");
    let node = *probe
        .core()
        .last_tick
        .placed
        .last()
        .expect("the Place minted the probe Factory");
    let place = probe.edit_log()[0].op.clone();

    let rec = |sequence: u64, tick: u64, action: u64, op: EditOp| EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence,
        tick,
        action,
        op,
    };
    // place (action 0), delete it (action 1), then a BARE `Undo` marker for action 1
    // that restores nothing — so at redo time the target is genuinely gone.
    let forged = vec![
        rec(0, 0, 0, place),
        rec(
            1,
            1,
            1,
            EditOp::Delete {
                node,
                kind: machine_kind::FACTORY,
                cell_x: MISALIGN_CELL.0,
                cell_y: MISALIGN_CELL.1,
                captured: fabrico_core::edit::DeletedSubgraph::default(),
            },
        ),
        rec(2, 2, 2, EditOp::Undo { target_action: 1 }),
    ];
    let session = GridSession::replay(DEMO_GENESIS_SEED, &forged);
    assert!(
        session.core().state.node(node).is_none(),
        "fixture precondition: the redo's target is ABSENT from the core"
    );
    assert!(session.can_redo(), "fixture precondition: the Delete is redoable");

    let group = session
        .resolve_redo()
        .expect("a redo whose Delete target is absent is INERT, and must not be refused");
    assert!(
        group
            .iter()
            .any(|r| matches!(&r.op, EditOp::Delete { node: n, .. } if *n == node)),
        "the inert Delete is still emitted unchanged (behaviour preserved, not repaired)"
    );
}

// ── 51-05 Task 2: the capture-miss refusal ───────────────────────────────────────
//
// Task 1 guards the arms that EMIT a Delete. These arms guard the two that emit
// NOTHING - `compute_inverse`'s `RemovePort` / `Configure` `if let Some(..) … else
// skip`, which is the precise mechanism of the reported defect: the inverse group was
// emitted with the restoring op MISSING while the undo cursor still moved, so the user
// spent an undo step and got nothing back.
//
// The discriminator is `pred` (the walked-forward live core), never the capture map: a
// capture-miss against a LIVE node means the projection has lost id alignment and is
// refused; a genuine fold no-op (absent node, or a wrong-kind Configure) still skips.
// The refusal is typed to callers and to these tests and SILENT to the user - a
// refused Ctrl+Z does nothing, with no message.

/// Build a FORGED log through the pub `replay` primitive: a `Place` and a second
/// record COLLAPSED into the same action AND the same tick. `reconstruct_projection`
/// captures a whole tick-slice from the throwaway genesis core BEFORE that slice
/// folds, so a record naming a node the SAME slice mints reads an unminted id and
/// captures NOTHING - the load-path analogue of a core holding nodes its edit log never
/// minted (the demo board's shape until plan 85-08), reproduced without a `.fab`. A `GridSession` never produces this shape (one
/// apply = one record = one tick), which is exactly why it belongs on the forged-log
/// path the CR-01 parity reject already lives on.
fn forged_capture_miss_session(op_after_place: impl Fn(NodeId) -> EditOp) -> GridSession {
    let mut live = GridSession::new(DEMO_GENESIS_SEED);
    live.apply(GridCommand::Place {
        kind: machine_kind::FACTORY,
        cell_x: MISALIGN_CELL.0,
        cell_y: MISALIGN_CELL.1,
    })
    .expect("the misalignment probe cell is free");
    let node = *live
        .core()
        .last_tick
        .placed
        .last()
        .expect("the Place minted the probe Factory");
    let place = live.edit_log()[0].clone();
    let forged = vec![
        place.clone(),
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: place.sequence + 1,
            tick: place.tick,
            action: place.action,
            op: op_after_place(node),
        },
    ];
    GridSession::replay(DEMO_GENESIS_SEED, &forged)
}

/// THE REPORTED MECHANISM. A `RemovePort` whose capture is missing while the target
/// node is LIVE must be a typed refusal, not an inverse group with the `AddPort`
/// silently absent. The anti-symptom assertion is the second `resolve_undo`: the
/// verifier's finding was "restores nothing AND spends the step", so the step must not
/// be spent.
#[test]
fn capture_miss_on_remove_port_undo_is_refused() {
    let session = forged_capture_miss_session(|node| EditOp::RemovePort { node, index: 0, restore: None });
    let before_hash = tick_hash(session.core());

    let first = session.resolve_undo();
    assert!(
        matches!(first, Err(CommandError::UndoDoesNotFit)),
        "a RemovePort capture-miss against a LIVE node must be a typed refusal, got {first:?}"
    );
    assert_eq!(
        tick_hash(session.core()),
        before_hash,
        "a refused undo leaves the core BYTE-IDENTICAL"
    );
    let second = session.resolve_undo();
    assert!(
        matches!(second, Err(CommandError::UndoDoesNotFit)),
        "the undo cursor did NOT move - the refused step was not spent, got {second:?}"
    );
}

/// The `prior_configs` twin, same shape.
#[test]
fn capture_miss_on_configure_undo_is_refused() {
    let session = forged_capture_miss_session(|node| EditOp::Configure {
        node,
        config: MachineConfig::Factory {
            source: "export default function (input, ctx) { /*PROBE-B*/ }".to_owned(),
        },
        code_hash: [0u8; 32],
    });
    let before_hash = tick_hash(session.core());

    let first = session.resolve_undo();
    assert!(
        matches!(first, Err(CommandError::UndoDoesNotFit)),
        "a Configure capture-miss against a LIVE matching-kind node must be a typed \
         refusal, got {first:?}"
    );
    assert_eq!(
        tick_hash(session.core()),
        before_hash,
        "a refused undo leaves the core BYTE-IDENTICAL"
    );
    let second = session.resolve_undo();
    assert!(
        matches!(second, Err(CommandError::UndoDoesNotFit)),
        "the undo cursor did NOT move - the refused step was not spent, got {second:?}"
    );
}

/// THE LOAD-BEARING NEGATIVE CONTROL. `apply(Configure{Factory{..}})` against a
/// NON-Factory node is ACCEPTED by `validate_normalize` today (it deliberately does not
/// gate on kind) and folds to a documented panic-free no-op, so its undo has genuinely
/// nothing to invert. It must still SKIP. This arm is what stops the capture-miss guard
/// from degenerating into a blanket "no capture -> reject", which would break a
/// legitimate shipped path.
#[test]
fn wrong_kind_configure_undo_still_skips_not_refuses() {
    let mut session = GridSession::new(DEMO_GENESIS_SEED);
    session
        .apply(GridCommand::Place {
            kind: machine_kind::SINK,
            cell_x: MISALIGN_CELL.0,
            cell_y: MISALIGN_CELL.1,
        })
        .expect("the probe cell is free");
    // Handle 0: the first node a fresh GridView projects (dense handles start at 0).
    session
        .apply(GridCommand::Configure {
            node: 0,
            config: probe_config(),
        })
        .expect("a wrong-kind Configure is ACCEPTED today (resolve-only gate)");

    let group = session
        .resolve_undo()
        .expect("a wrong-kind Configure undo must SKIP, never refuse");
    assert!(
        !group.iter().any(|r| matches!(r.op, EditOp::Configure { .. })),
        "the fold was a no-op, so the inverse group carries no Configure to restore"
    );
}

/// Every 51-04 arm on the REAL demo board, re-asserted on the VERDICT rather than on
/// the restored value: on a live session the capture can only miss if the projection is
/// misaligned, so the refusal must be invisible on all of them.
#[test]
fn port_and_config_undo_arms_from_51_04_stay_green() {
    let mut probe = demo_host(true);
    let node = place_probe_factory(&mut probe);

    probe
        .try_gesture(add_output(), node)
        .expect("AddPort is accepted");
    let after_add = probe.port_shapes(node);
    let last = u16::try_from(after_add.len() - 1).expect("a port index fits u16");

    probe
        .try_gesture(GridCommand::RemovePort { node: PROBE_HANDLE, index: last }, node)
        .expect("RemovePort is accepted");
    probe
        .try_gesture(GridCommand::Undo, node)
        .expect("the RemovePort undo must NOT be refused on a live demo board");
    assert_eq!(
        probe.port_shapes(node),
        after_add,
        "and it still restores the port"
    );

    let original = probe
        .factory_source(node)
        .expect("the probe machine is a live Factory");
    probe
        .try_gesture(
            GridCommand::Configure { node: PROBE_HANDLE, config: probe_config() },
            node,
        )
        .expect("Configure is accepted");
    probe
        .try_gesture(GridCommand::Undo, node)
        .expect("the Configure undo must NOT be refused on a live demo board");
    assert_eq!(
        probe.factory_source(node),
        Some(original),
        "and it still restores the prior source"
    );
}

// ── 51-05 Task 3: the post-load residual, MEASURED ───────────────────────────────
//
// 51-04's live captures are empty BY CONSTRUCTION on a session rebuilt by
// `GridSession::replay_two_logs`, which is what `Host::recover` (`driver.rs:647`) and
// therefore `load_project` use. Until plan 85-08 a demo-derived `.fab` carried a
// FULL-STATE snapshot (all nodes, the request pair included) plus an edit log that never
// described that pair, so the load-path projection was misaligned for exactly the same
// reason the live path was - and 51-04 did NOT fix it there. Since 85-08 the pair is
// logged, and the arms below hold that the reloaded demo stays aligned.
//
// WHICH ACTION IS MEASURED IS THE WHOLE POINT. `AddPort`'s inverse is computed from
// the LIVE predicted core (`command.rs` AddPort arm), so it is the ONE operation this
// root cause has never broken - the phase verifier said so explicitly. An AddPort
// pre-save probe therefore comes back green on a board where the defect is present and
// CANNOT be cited as evidence about the load path. The MEASUREMENTS are ARM 1 (a
// `RemovePort`, the ROADMAP SC2 clause) and ARM 2 (a `Place`, the destructive clause).

/// Save `probe`'s host to a `.fab` and reopen it into a FRESH `Probe` over a fresh work
/// dir - the exact `save_project` -> `load_project` -> `Host::recover` path the app's
/// Save/Load buttons drive (and the same pair the live spec's save/load arm exercises).
fn save_and_reload(probe: Probe) -> Probe {
    assert_eq!(
        probe.host.in_flight_len(),
        0,
        "the probe board is quiescent (the save_project precondition)"
    );
    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("probe.fab");
    save_project(&probe.host, &fab).expect("save the probe board");

    let load_dir = tempfile::tempdir().expect("load work_dir");
    let host = load_project(&fab, load_dir.path(), None).expect("reopen the saved board");

    let mut dirs = probe._dirs;
    dirs.push(save_dir);
    dirs.push(load_dir);

    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    Probe {
        host,
        ingress_rx,
        results_rx,
        cmd_tx,
        _ingress_tx: ingress_tx,
        _res_tx: res_tx,
        _cmd_rx: cmd_rx,
        _dirs: dirs,
    }
}


/// ARM 1 - MEASUREMENT (the ROADMAP SC2 clause: "the add/remove undoes and redoes as
/// a single step AND survives save/load").
///
/// MEASURED OUTCOME AS OF PLAN 73-07: **RESTORED**. Place -> AddPort -> RemovePort ->
/// save -> load -> one Undo puts the Out back on the node.
///
/// # This assertion was INVERTED, and that is the evidence
/// Until this plan the body below asserted `Err(CommandError::Malformed)` with nothing
/// restored and nothing changed, and it was GREEN. Rewriting it to assert restoration
/// inverts a passing assertion, which is the strongest non-vacuity evidence available
/// here: it is not satisfiable by weakening a check, only by the load path actually
/// having been repaired. The history in order, so no reader has to reconstruct it:
///
/// 1. Before plan 51-04 the sequence returned `Ok(())` and restored NOTHING, and a
///    second Undo also returned `Ok(())` - the step was spent for nothing. That is the
///    originally reported symptom, structurally present on every `.fab` load.
/// 2. Plan 51-05 turned the silent no-op into a typed refusal. A refusal is a RESIDUAL,
///    not a fix: the undo still did not happen, it just said so. Since Phase 64 the
///    gesture drain (`SimLoop::acquire_input`) answers the gesture envelope's reply with
///    the verdict, so Ctrl+Z showed "The host could not carry out that gesture."
/// 3. Plan 73-07 fixed the CAUSE for the board of that time. `reconstruct_projection`'s
///    throwaway re-fold could only ever see nodes the edit log minted, so on a
///    demo-derived board it ran four allocator slots behind and its capture missed on a
///    node that IS live in the predicted core. 73-07 persisted a record of those four
///    mints so the re-fold could mint stand-ins and keep pace.
/// 4. Plan 85-08 removed the cause itself: the demo's request pair is ordinary logged
///    commands, so the re-fold sees every node and the two allocators agree with no
///    record at all. Plan 85-09 deleted the record.
///
/// Closes the internal todo "post-load undo projection alignment" (2026-07-25).
#[test]
fn post_load_undo_of_a_pre_save_remove_port() {
    let mut probe = demo_host(true);
    let node = place_probe_factory(&mut probe);
    let before_add = probe.port_shapes(node);
    probe.gesture(add_output(), node);
    let after_add = probe.port_shapes(node);
    let last = u16::try_from(after_add.len() - 1).expect("a port index fits u16");
    probe.gesture(GridCommand::RemovePort { node: PROBE_HANDLE, index: last }, node);
    let after_remove = probe.port_shapes(node);
    assert_eq!(after_remove.len(), 3, "the RemovePort folded before the save");

    let before_ids = probe.node_ids();
    let mut probe = save_and_reload(probe);
    assert!(
        probe.host.can_undo(),
        "the reloaded board still carries the RemovePort as an undoable action"
    );

    let verdict = apply_gesture(&mut probe.host, GridCommand::Undo, |_| None);
    if verdict.is_ok() {
        probe.tick();
    }

    // UNCONDITIONAL: whatever the verdict, no pre-existing node may be lost.
    let after_ids = probe.node_ids();
    let destroyed: Vec<NodeId> = before_ids
        .iter()
        .copied()
        .filter(|id| !after_ids.contains(id))
        .collect();
    assert!(
        destroyed.is_empty(),
        "the post-load undo destroyed pre-existing nodes: {destroyed:?}"
    );

    // THE MEASUREMENT, INVERTED BY 73-07: the undo is ACCEPTED, not refused.
    assert!(
        verdict.is_ok(),
        "the post-load RemovePort-undo must be ACCEPTED; got {verdict:?}. A `Malformed` \
         here means the reloaded projection no longer tracks the live allocator (since \
         plan 85-08 the demo mints every node by a logged command)"
    );
    // And the half a mere `Ok` does not prove: the port is actually BACK, in the slot
    // it came out of. `after_add` is the port list as it stood before the RemovePort,
    // read from the live core rather than from a copied literal.
    assert_eq!(
        probe.port_shapes(node),
        after_add,
        "the removed Out is restored, in its own slot, on a board that was saved and \
         reopened through the real save_project/load_project pair"
    );

    // The step WAS spent, exactly once. A second Undo must now walk one further back in
    // the history (the AddPort) rather than repeating this one - so it is accepted and
    // the port list shrinks again. This is the counterpart of the old anti-symptom
    // assertion: it used to prove a refusal did not consume the step; it now proves an
    // acceptance consumed exactly one.
    let second = apply_gesture(&mut probe.host, GridCommand::Undo, |_| None);
    assert!(
        second.is_ok(),
        "the undo cursor moved on, so the next Undo resolves too; got {second:?}"
    );
    probe.tick();
    assert_eq!(
        probe.port_shapes(node),
        before_add,
        "the second Undo undoes the ADD, which is the step before it - the cursor moved \
         exactly one, and no step was spent for nothing"
    );
}

/// ARM 2 - MEASUREMENT (the DESTRUCTIVE clause).
///
/// MEASURED OUTCOME AS OF PLAN 73-07: **RESTORED**. Place (as the last pre-save
/// action) -> save -> load -> Undo removes the placed machine and leaves every
/// pre-existing node standing.
///
/// # This assertion was INVERTED too, and it is the destructive half
/// The history here is worse than ARM 1's and the inversion is worth more. Before plan
/// 51-04 this exact sequence, through the REAL `save_project` / `load_project` pair,
/// returned `Ok(())`, left the placed machine STANDING, and silently DESTROYED
/// `NodeId(19v1)` - a headline-wire node, the same identity the phase verifier's live
/// probe named. The undo deleted the wrong node, because the throwaway re-fold's minted
/// id harvest named a node four allocator slots too early. 51-05 made that a typed
/// refusal. 73-07 made it correct with a persisted record of the out-of-log mints, and
/// since plan 85-08 the demo has none, so the harvest names the node the live fold
/// actually minted and the Delete lands on the placed machine.
///
/// The unconditional no-bystander-lost assertion below is kept EXACTLY as 51-05 wrote
/// it. It was the load-bearing assertion of that plan and it is the one that would fire
/// if a future change re-introduced the off-by-four - a wrong-node delete would show up
/// here as a destroyed bystander, not as a failed positive.
#[test]
fn post_load_undo_of_a_pre_save_place() {
    let mut probe = demo_host(true);
    let before_place = probe.node_ids();
    let node = place_probe_factory(&mut probe);

    let mut probe = save_and_reload(probe);
    assert!(
        probe.host.can_undo(),
        "the reloaded board still carries the Place as an undoable action"
    );

    let verdict = apply_gesture(&mut probe.host, GridCommand::Undo, |_| None);
    if verdict.is_ok() {
        probe.tick();
    }

    // UNCONDITIONAL, and the load-bearing assertion of this whole plan: the pre-place
    // id set is entirely intact. This is the assertion that was FALSE before Task 1.
    let after = probe.node_ids();
    let destroyed: Vec<NodeId> = before_place
        .iter()
        .copied()
        .filter(|id| !after.contains(id))
        .collect();
    assert!(
        destroyed.is_empty(),
        "the post-load Place-undo destroyed pre-existing nodes: {destroyed:?} \
         (before this plan it destroyed NodeId(19v1) here)"
    );

    // THE MEASUREMENT, INVERTED BY 73-07: the undo is ACCEPTED, not refused.
    assert!(
        verdict.is_ok(),
        "the post-load Place-undo must be ACCEPTED after 73-07; got {verdict:?}"
    );
    // And it undid the RIGHT node. This is the pair that has to be read together: the
    // unconditional check above says no bystander died, this one says the placed machine
    // did. Either alone is satisfiable by a no-op.
    assert!(
        probe.host.core().state.node(node).is_none(),
        "the undo removed the machine the Place minted, on a board that was saved and \
         reopened through the real save_project/load_project pair"
    );
    assert_eq!(
        probe.node_ids(),
        before_place,
        "and the board is back to exactly its pre-Place id set - nothing extra removed, \
         nothing left behind"
    );
}

/// ARM 3 - LABELLED CONTROL. **This arm proves NOTHING about the load path and its
/// green result may NOT be cited as evidence about it, anywhere.**
///
/// `AddPort`'s inverse is computed from the LIVE predicted core (`command.rs`'s
/// AddPort arm reads `pred.state.ports_of(..)` and removes the last slot), never from
/// a log-refold capture. It is the ONE operation this root cause has never broken, so
/// it comes back green on a board where the defect is fully present. Its only job here
/// is to prove the save/load FIXTURE itself works, so that a refusing ARM 1 cannot be
/// waved away as a broken harness.
///
/// **73-07 left this arm UNCHANGED, deliberately.** ARM 1 and ARM 2 above were inverted
/// from refusal to restoration in that plan, and an inverted assertion is only evidence
/// if something independent still proves the fixture underneath it works. This arm is
/// that something. Weakening it, or folding it into the two arms it guards, would leave
/// a green ARM 1 and ARM 2 unable to distinguish "the load path was repaired" from "the
/// harness stopped exercising the load path at all".
#[test]
fn post_load_undo_of_a_pre_save_add_port_is_a_control_only() {
    let mut probe = demo_host(true);
    let node = place_probe_factory(&mut probe);
    let before_add = probe.port_shapes(node);
    probe.gesture(add_output(), node);
    assert_eq!(probe.port_shapes(node).len(), before_add.len() + 1);

    let mut probe = save_and_reload(probe);
    apply_gesture(&mut probe.host, GridCommand::Undo, |_| None)
        .expect("the AddPort inverse is read from the live predicted core, so it resolves");
    probe.tick();

    assert_eq!(
        probe.port_shapes(node),
        before_add,
        "the harness works: a save/load round-trip preserves the board and the undo path"
    );
}

/// A CONTROL ON A WIRE-LESS BOARD: every node came through the command layer, so the
/// reopened board's projection rebuild re-folds the edit log alone and its throwaway core
/// mints exactly the ids the live one did. A post-load Undo of a pre-save Place removes
/// that machine and nothing else.
///
/// Until plan 85-09 this arm also asserted that such a board recorded, and carried across
/// the save, an empty record of nodes minted outside the edit log. Project file v12 has no
/// such record (every node on every board is minted by the log), so those two asserts went
/// with it; the alignment they guarded is what the rest of the arm still checks.
#[test]
fn a_reloaded_command_built_board_undoes_a_pre_save_place() {
    let mut probe = demo_host(false);

    let before_place = probe.node_ids();
    let node = place_probe_factory(&mut probe);

    let mut probe = save_and_reload(probe);

    apply_gesture(&mut probe.host, GridCommand::Undo, |_| None)
        .expect("the post-load undo resolves on a board the edit log built");
    probe.tick();

    assert!(
        probe.host.core().state.node(node).is_none(),
        "the placed machine is gone"
    );
    assert_eq!(
        probe.node_ids(),
        before_place,
        "and the board is back to its pre-Place id set"
    );
}

/// THE SHIPPED DEMO REALIGNS AFTER A RELOAD (plans 85-08 and 85-09).
///
/// Until plan 85-08 this arm was the positive evidence that a persisted record of nodes
/// minted outside the edit log is what realigned a reloaded projection: the shipped demo
/// minted its request pair outside the log. Plan 85-08 made the pair ordinary logged
/// commands, and plan 85-09 deleted the record and everything that read it, so that half
/// is gone rather than kept standing.
///
/// What it proves now, on the board a user edits first: the shipped demo, request pair
/// included, saves and reopens, and a post-load Undo of a pre-save Place removes the right
/// machine and no bystander. A misaligned harvest would show up here as a cable, the Route
/// or the HTTP Handler going missing.
#[test]
fn the_shipped_demo_realigns_after_a_reload() {
    let mut probe = demo_host(true);
    assert_eq!(
        probe
            .host
            .core()
            .state
            .node_ids()
            .filter(|&id| matches!(probe.host.core().state.node(id), Some(Node::Wire(_))))
            .count(),
        2,
        "non-vacuity: the board under test carries the request pair's two cables"
    );

    // A real pre-save edit, then the real save and load pair.
    let node = place_probe_factory(&mut probe);
    let before_ids = probe.node_ids();
    let mut probe = save_and_reload(probe);

    let verdict = apply_gesture(&mut probe.host, GridCommand::Undo, |_| None);
    assert!(
        verdict.is_ok(),
        "the reloaded board's undo must RESTORE; got {verdict:?}"
    );
    probe.tick();

    assert!(
        probe.host.core().state.node(node).is_none(),
        "the undo removed the machine the Place minted"
    );
    let after = probe.node_ids();
    let destroyed: Vec<NodeId> = before_ids
        .iter()
        .copied()
        .filter(|id| *id != node && !after.contains(id))
        .collect();
    assert!(
        destroyed.is_empty(),
        "and it destroyed no bystander - a misaligned harvest shows up HERE, as a \
         request-pair node going missing: {destroyed:?}"
    );
}

/// ARM 4 - a POST-LOAD action undone on the SAME loaded host. Exercises 51-04's live
/// capture on a reloaded session: the action was folded LIVE, so its captures are
/// authoritative and the undo is correct. Expected green, and it is: this is what
/// bounds the residual to actions that PREDATE the save.
#[test]
fn post_load_undo_of_a_post_load_action() {
    let probe = demo_host(true);
    let mut probe = save_and_reload(probe);
    let before = probe.node_ids();

    let node = place_probe_factory(&mut probe);
    apply_gesture(&mut probe.host, GridCommand::Undo, |_| None)
        .expect("an action folded live on the loaded host undoes correctly");
    probe.tick();

    assert!(
        probe.host.core().state.node(node).is_none(),
        "the post-load Place is undone: the placed machine is deleted"
    );
    let after = probe.node_ids();
    let destroyed: Vec<NodeId> = before.iter().copied().filter(|id| !after.contains(id)).collect();
    assert!(
        destroyed.is_empty(),
        "and no pre-existing node is lost: {destroyed:?}"
    );
}

// ── 73-12 / CR-02: the headline cable on the SHIPPED demo board ───────────────────

/// The demo's HTTP Handler: the LAST `Node::Factory` on the board (a Handler folds to a
/// Factory), because the request pair is placed after every other command and mints
/// ascending ids.
fn headline_handler(probe: &Probe) -> NodeId {
    let core = probe.host.core();
    let factories: Vec<NodeId> = core
        .state
        .node_ids()
        .filter(|&id| matches!(core.state.node(id), Some(Node::Factory(_))))
        .collect();
    *factories.last().expect("the headline handler is on the board")
}

/// The `machine_kind` byte the render packet gives `node` - the byte the panel's
/// `editable = kind === machine_kind.FACTORY` gate reads.
fn packet_kind(probe: &Probe, node: NodeId) -> u8 {
    let core = probe.host.core();
    let n = core.state.node(node).expect("the node is live");
    if fabrico_command::is_handler_shape(n, core.state.ports_of(node)) {
        machine_kind::HANDLER
    } else {
        machine_kind::FACTORY
    }
}

/// **THE MEASUREMENT THAT CORRECTS 73-REVIEW's CR-02 SEVERITY CLAIM.**
///
/// The review reports the headline Factory's lone Out as removable "in ONE CLICK on the
/// shipped demo board". It is not, and this row is what says so on the real board rather
/// than in prose. The demo's HTTP Handler carries the catalog's electrical `In@0`, electrical
/// `Out@1` and mechanical `Fault@2`, which is exactly `fabrico_command::is_handler_shape`, so both
/// render-packet mappers emit `machine_kind::HANDLER` for it - and
/// `PortsSection.tsx`'s `editable` gate is `kind === machine_kind.FACTORY`, so the panel
/// renders NO port-edit controls on it at all. The defect CR-02 names is real; its stated
/// reachability is not.
///
/// This row is what would go red if a later phase made a wire-carrying machine
/// port-editable while the cable was still unprotected.
#[test]
fn the_headline_handler_offers_no_port_edit_controls_at_all() {
    let probe = demo_host(true);
    let hw_factory = headline_handler(&probe);

    assert_eq!(
        probe.port_shapes(hw_factory).len(),
        3,
        "the demo's HTTP Handler carries the catalog's three ports, In, Out and Fault"
    );
    assert_eq!(
        packet_kind(&probe, hw_factory),
        machine_kind::HANDLER,
        "so the packet names it a HANDLER, and the panel's FACTORY-only edit gate hides \
         every port control - the review's one-click claim does not hold on this board"
    );
}

/// **THE CR-02 HEADLINE ON THE SHIPPED BOARD.** Reached the only way a user could reach
/// it if the panel ever offered the control: the certified live gesture path, against the
/// real headline handler's electrical Out - the port the RETURN cable leaves from.
///
/// RED ON HEAD BECAUSE: the host ACCEPTS it. The port goes, `fold_remove_port` never looks
/// at a `Node::Wire`, and the return cable is left naming catalog index 1 on a machine
/// that now has one port. The renderer's `resolve_wire_dock` degrades to the node origin
/// (WINDOWS 116), which is precisely the trigger `wires.ts`'s WR-02 magnitude bound exists
/// to contain.
///
/// After 73-12 the host REFUSES it with `PortOccupied` - "That output is already
/// connected. Disconnect it first." - and both cables are untouched.
#[test]
fn removing_the_headline_handlers_out_is_refused_and_both_cables_survive() {
    let mut probe = demo_host(true);
    let hw_factory = headline_handler(&probe);

    let wires_before: Vec<NodeId> = probe
        .host
        .core()
        .state
        .node_ids()
        .filter(|&id| matches!(probe.host.core().state.node(id), Some(Node::Wire(_))))
        .collect();
    assert_eq!(wires_before.len(), 2, "the demo board ships two cables");

    let verdict = probe.try_gesture(
        GridCommand::RemovePort {
            node: PROBE_HANDLE,
            index: 1,
        },
        hw_factory,
    );
    assert_eq!(
        verdict,
        Err(CommandError::PortOccupied),
        "removing the output a cable leaves from is refused with the sentence the panel \
         already ships for a busy output"
    );

    assert_eq!(
        probe.port_shapes(hw_factory).len(),
        3,
        "the handler kept all three of its ports"
    );
    let wires_after: Vec<NodeId> = probe
        .host
        .core()
        .state
        .node_ids()
        .filter(|&id| matches!(probe.host.core().state.node(id), Some(Node::Wire(_))))
        .collect();
    assert_eq!(wires_after, wires_before, "and both cables are exactly where they were");
    for &w in &wires_after {
        match probe.host.core().state.node(w) {
            Some(Node::Wire(link)) => {
                let ports = probe.port_shapes(link.from.0).len();
                assert!(
                    usize::from(link.from.1) < ports,
                    "every cable's source endpoint still names a port that exists"
                );
            }
            other => panic!("expected a Wire, got {other:?}"),
        }
    }
}

/// The FORWARD cable's arrival port is protected by the SAME rule, which is what says the
/// rule is about the PORT a cable names rather than about the machine carrying one.
///
/// # The re-point half cannot be shown on THIS board, and that is stated rather than faked
/// The demo's HTTP Handler has a cable on its first two ports: the forward cable arrives
/// at catalog index 0 and the return cable leaves catalog index 1. Its third port, the
/// Fault at index 2, carries no cable, so no cable endpoint sits ABOVE a port that could
/// be removed, and the shipped demo board cannot exercise the shift at all. That half is pinned by
/// `crates/fabrico-core/tests/remove_port_repoint.rs`, on boards built for it.
#[test]
fn removing_the_in_the_forward_cable_arrives_at_is_refused_too() {
    let mut probe = demo_host(true);
    let hw_factory = headline_handler(&probe);

    let return_wire = probe
        .host
        .core()
        .state
        .node_ids()
        .find(|&id| {
            matches!(probe.host.core().state.node(id), Some(Node::Wire(w)) if w.from == (hw_factory, 1))
        })
        .expect("the return cable leaves the handler's Out at catalog index 1");

    // Remove the handler's In at catalog index 0 - BELOW the cable's source port. The
    // FORWARD cable arrives there, so this is refused for that reason; what this row
    // pins is that the refusal names the arriving cable, not the machine.
    let verdict = probe.try_gesture(
        GridCommand::RemovePort {
            node: PROBE_HANDLE,
            index: 0,
        },
        hw_factory,
    );
    assert_eq!(
        verdict,
        Err(CommandError::PortOccupied),
        "the In the forward cable arrives at is protected by the same rule"
    );

    match probe.host.core().state.node(return_wire) {
        Some(Node::Wire(w)) => assert_eq!(
            w.from,
            (hw_factory, 1),
            "and nothing moved, because nothing folded"
        ),
        other => panic!("expected a Wire, got {other:?}"),
    }
}
