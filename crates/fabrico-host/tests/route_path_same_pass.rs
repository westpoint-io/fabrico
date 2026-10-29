//! Phase 91 review CR-A-01 and WR-A-04: a Route's path is judged against the board the fold
//! will see, by the key the host routes on, in both producers.
//!
//! WHY A HOST TEST. `SimLoop::acquire_input` applies every queued gesture through
//! `apply_gesture` with no fold between them, and a paused board queues every gesture until
//! Play, so a Place of a Route and a Configure of another Route's path are validated before
//! either folds. Phase 91 (D-13) made the default path `/route-N`, the smallest number no
//! Route holds, so the path a queued Place is about to take is the first thing a user would
//! type. Before the review fix the host's duplicate-path check (`HostGridLookup::
//! endpoint_path_owner`) read only the folded core: on a paused board both records were
//! accepted, both folded, two Routes held one path, and `project_routes` kept one of them
//! with no word. The headless `GridSession` folds each command before the next validates, so
//! it refused the same input `DuplicatePath`: two producers, two accept envelopes.
//!
//! THE HARNESS is `rotate_redock_same_pass.rs`'s (itself `label_same_pass.rs`'s):
//! consecutive `apply_gesture` calls with no `tick_once` between them ARE the paused drain
//! pass ([`pass`]), and [`fold`] is the tick Play runs. Every leg runs on the demo board, the
//! board the shipped app boots, whose one Route holds `/hello`, and every leg runs the same
//! commands through a `GridSession` and asserts the same verdicts there.
//!
//! Each leg asserts ONE labelled-pair `Vec` in ONE `assert_eq!` (`label_same_pass.rs`'s
//! rule), so a red prints every fact.
//!
//! Run target: `cargo test -p fabrico-host --test route_path_same_pass`

use fabrico_command::{CommandError, GridSession};
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::{GridState, Node};
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, demo_commands, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A demo-booted host plus the channel triple `tick_once` requires.
struct Probe {
    host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    results_rx: UnboundedReceiver<ResultEvent>,
    cmd_tx: UnboundedSender<Command>,
    _ingress_tx: UnboundedSender<EventPayload>,
    _res_tx: UnboundedSender<ResultEvent>,
    _cmd_rx: UnboundedReceiver<Command>,
    _dirs: Vec<tempfile::TempDir>,
}

/// A `Host` booted the way the shipped app boots (genesis at [`DEMO_GENESIS_SEED`], the
/// demo's commands through `seed_scene`). No timers, so the board stays quiescent.
fn demo_host() -> Probe {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: DEMO_GENESIS_SEED });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    seed_scene(&mut host, &demo_commands()).expect("seed_scene folds every demo command");
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

/// The same demo folded headlessly, one command at a time, sealed where `seed_scene` seals.
fn demo_session() -> GridSession {
    let mut session = GridSession::new(DEMO_GENESIS_SEED);
    for cmd in demo_commands() {
        session.apply(cmd).expect("the session accepts every demo command");
    }
    session.seal_history().expect("the session seals its history");
    session
}

/// Fold ONE tick: what Play runs after the drain pass.
fn fold(probe: &mut Probe) {
    probe
        .host
        .tick_once(&mut probe.ingress_rx, &mut probe.results_rx, &probe.cmd_tx)
        .expect("tick_once persists and folds");
}

/// Apply `cmds` through `apply_gesture` in order, every handle resolved through ONE table,
/// with NO fold between them (one drain pass), and return every verdict.
fn pass(probe: &mut Probe, table: &[(u64, NodeId)], cmds: Vec<GridCommand>) -> Vec<Result<(), CommandError>> {
    cmds.into_iter()
        .map(|cmd| apply_gesture(&mut probe.host, cmd, |h| table.iter().find(|(k, _)| *k == h).map(|(_, n)| *n)))
        .collect()
}

/// The Route holding `path`, by an ascending walk.
fn route_at(state: &GridState, path: &str) -> NodeId {
    state
        .node_ids()
        .find(|&id| matches!(state.node(id), Some(Node::Endpoint(ep)) if ep.path == path))
        .unwrap_or_else(|| panic!("a Route holds {path}"))
}

/// Every Route's path, in ascending node order.
fn route_paths(state: &GridState) -> Vec<String> {
    state
        .node_ids()
        .filter_map(|id| match state.node(id) {
            Some(Node::Endpoint(ep)) => Some(ep.path.clone()),
            _ => None,
        })
        .collect()
}

/// A Configure of handle `node`'s path.
fn set_path(node: u64, path: &str) -> GridCommand {
    GridCommand::Configure { node, config: MachineConfig::Endpoint { path: path.to_owned() } }
}

/// Debug text of any fact, for the labelled-pair `Vec`.
fn dbg<T: std::fmt::Debug>(v: T) -> String {
    format!("{v:?}")
}

/// The handle `GridSession` gives `node`.
fn session_handle(session: &GridSession, node: NodeId) -> u64 {
    session.view().handle_of(node).expect("a live node has a handle")
}

/// CR-A-01. On the paused demo board (its one Route at `/hello`), ONE pass: Place a Route,
/// whose fold will mint `/route-1`, then give the demo Route `/route-1`. The host must refuse
/// the Configure `DuplicatePath`, as the headless session does, and after Play no two Routes
/// share a path.
///
/// RED before the fix: the host answered the Configure `Ok(())`, and after the fold both
/// Routes held `/route-1`.
#[test]
fn a_path_a_queued_place_will_mint_is_refused_on_the_host_as_headless() {
    let mut probe = demo_host();
    let hello = route_at(&probe.host.core().state, "/hello");
    let verdicts = pass(
        &mut probe,
        &[(0, hello)],
        vec![
            GridCommand::Place { kind: machine_kind::ENDPOINT, cell_x: 2, cell_y: 30 },
            set_path(0, "/route-1"),
        ],
    );
    fold(&mut probe);
    let host_paths = route_paths(&probe.host.core().state);

    let mut session = demo_session();
    let s_hello = route_at(&session.core().state, "/hello");
    let s_place = session
        .apply(GridCommand::Place { kind: machine_kind::ENDPOINT, cell_x: 2, cell_y: 30 })
        .map(|_| ());
    let s_configure = session.apply(set_path(session_handle(&session, s_hello), "/route-1")).map(|_| ());

    let facts: Vec<(&'static str, String)> = vec![
        ("host_place", dbg(verdicts[0])),
        ("host_configure", dbg(verdicts[1])),
        ("host_paths", dbg(&host_paths)),
        ("session_place", dbg(s_place)),
        ("session_configure", dbg(s_configure)),
        ("session_paths", dbg(route_paths(&session.core().state))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("host_place", "Ok(())".to_owned()),
        ("host_configure", "Err(DuplicatePath)".to_owned()),
        ("host_paths", dbg(["/hello", "/route-1"])),
        ("session_place", "Ok(())".to_owned()),
        ("session_configure", "Err(DuplicatePath)".to_owned()),
        ("session_paths", dbg(["/hello", "/route-1"])),
    ];
    assert_eq!(facts, expected, "a Place of a Route then a Configure onto the path it mints, in one drain pass");
}

/// CR-A-01, the other direction. The demo board plus one placed Route (`/route-1`), folded.
/// ONE pass: move the demo Route from `/hello` to `/greet`, then give the new Route `/hello`.
/// The fold will see `/hello` free, so both are accepted, on the host as headless.
///
/// RED before the fix: the host refused the second Configure `DuplicatePath`, reading the
/// demo Route's committed `/hello` past the pending rename.
#[test]
fn a_path_a_queued_rename_frees_is_accepted_on_the_host_as_headless() {
    let mut probe = demo_host();
    apply_gesture(
        &mut probe.host,
        GridCommand::Place { kind: machine_kind::ENDPOINT, cell_x: 2, cell_y: 30 },
        |_| None,
    )
    .expect("the place is accepted");
    fold(&mut probe);
    let hello = route_at(&probe.host.core().state, "/hello");
    let fresh = route_at(&probe.host.core().state, "/route-1");
    let verdicts = pass(&mut probe, &[(0, hello), (1, fresh)], vec![set_path(0, "/greet"), set_path(1, "/hello")]);
    fold(&mut probe);
    let host_paths = route_paths(&probe.host.core().state);

    let mut session = demo_session();
    session
        .apply(GridCommand::Place { kind: machine_kind::ENDPOINT, cell_x: 2, cell_y: 30 })
        .expect("the session places the Route");
    let s_hello = route_at(&session.core().state, "/hello");
    let s_fresh = route_at(&session.core().state, "/route-1");
    let s_rename = session.apply(set_path(session_handle(&session, s_hello), "/greet")).map(|_| ());
    let s_take = session.apply(set_path(session_handle(&session, s_fresh), "/hello")).map(|_| ());

    let facts: Vec<(&'static str, String)> = vec![
        ("host_rename", dbg(verdicts[0])),
        ("host_take", dbg(verdicts[1])),
        ("host_paths", dbg(&host_paths)),
        ("session_rename", dbg(s_rename)),
        ("session_take", dbg(s_take)),
        ("session_paths", dbg(route_paths(&session.core().state))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("host_rename", "Ok(())".to_owned()),
        ("host_take", "Ok(())".to_owned()),
        ("host_paths", dbg(["/greet", "/hello"])),
        ("session_rename", "Ok(())".to_owned()),
        ("session_take", "Ok(())".to_owned()),
        ("session_paths", dbg(["/greet", "/hello"])),
    ];
    assert_eq!(facts, expected, "a rename away from a path then a Configure onto it, in one drain pass");
}
