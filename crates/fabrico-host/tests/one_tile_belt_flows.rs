//! Phase 89 (BELT-10, D-15): a one-tile belt flowing West is shipped as a West-flowing
//! tile kind.
//!
//! Measured at a pre-release revision in `89-MEASURE.md` (BELT-10): a one-tile belt's stored geometry
//! carries only an axis, and the seam table (`seam_end_kind` in
//! `crates/fabrico-core/src/state.rs`, its TypeScript mirror `seamEndKind` in
//! `frontend/src/protocol/seam.ts`) turns every single-tile seam whose entry equals its
//! exit into `Straight { axis }`, so the direction is gone before the render packet goes
//! out and both renderers draw it flowing East. D-15: a single tile whose entry equals its
//! exit is a zero-turn corner, `Corner { from: e, to: e }`.
//!
//! WHY HERE AND NOT IN `crates/fabrico-core/tests/seam_end_kind.rs`. That file is under a
//! covered root (the declared-moves gate), and phase 89 makes its one declared pass in plan
//! 89-03. This probe reads the SHIPPED answer, `GridState::effective_belt_tiles`, the
//! function `render_packet.rs` calls, on a host board built through the gesture path, so
//! plan 89-01 moves no covered byte. The precedent for a host-side reader is
//! `tile_kind_readers.rs`.
//!
//! THE BOARD. A 1x1 SINK and a 1x1 SOURCE on one row with one empty cell between them, each
//! turned twice so the Source's Out faces West and the Sink's In faces East, both onto the
//! empty cell; a one-tile belt on that cell, its Tail docked to the Source's Out and its
//! Head to the Sink's In. Items flow West across the tile.
//!
//! RED FIRST (D-01, D-16): seen FAILED at `PHASE89_START`; plan 89-03 removed the
//! `#[ignore]` and changed nothing else.

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::{Dir, TileKind};
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, demo_commands, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A demo-booted host plus the channel triple `tick_once` requires (`label_same_pass.rs`).
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

fn fold(probe: &mut Probe) {
    probe
        .host
        .tick_once(&mut probe.ingress_rx, &mut probe.results_rx, &probe.cmd_tx)
        .expect("tick_once persists and folds");
}

/// Apply one gesture in its own tick, handles resolved through `table`.
fn gesture(probe: &mut Probe, table: &[(u64, NodeId)], cmd: GridCommand) {
    let what = format!("{cmd:?}");
    apply_gesture(&mut probe.host, cmd, |h| table.iter().find(|(k, _)| *k == h).map(|(_, n)| *n))
        .unwrap_or_else(|e| panic!("{what} is accepted: {e:?}"));
    fold(probe);
}

/// The row the board is built on: clear floor on the demo board.
const ROW: i32 = 40;

#[test]
fn a_one_tile_belt_docked_west_ships_a_west_flowing_kind() {
    let mut probe = demo_host();
    for cell in [(40, ROW), (41, ROW), (42, ROW)] {
        assert!(probe.host.core().state.occupied(cell).is_none(), "premise: {cell:?} is clear floor");
    }
    gesture(&mut probe, &[], GridCommand::Place { kind: machine_kind::SINK, cell_x: 40, cell_y: ROW });
    let sink = probe.host.core().last_tick.placed[0];
    gesture(&mut probe, &[], GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 42, cell_y: ROW });
    let source = probe.host.core().last_tick.placed[0];
    let table = [(1, sink), (2, source)];
    for h in [1, 2, 1, 2] {
        gesture(&mut probe, &table, GridCommand::Rotate { node: h, ccw: false });
    }
    gesture(&mut probe, &table, GridCommand::DrawBelt { cells: vec![(41, ROW)] });
    let belt = probe.host.core().last_tick.placed[0];
    let table = [(1, sink), (2, source), (3, belt)];
    gesture(&mut probe, &table, GridCommand::Dock { belt: 3, endpoint: BeltEnd::Tail, node: 2, port: 0 });
    gesture(&mut probe, &table, GridCommand::Dock { belt: 3, endpoint: BeltEnd::Head, node: 1, port: 0 });

    let st = &probe.host.core().state;
    let links: Vec<_> = st.links_iter().filter(|(f, t)| f.0 == belt || t.0 == belt).collect();
    let shipped = st.effective_belt_tiles(belt, None).expect("the belt has tiles");
    let kinds: Vec<TileKind> = shipped.iter().map(|t| t.tile_kind()).collect();
    eprintln!("P89-BELT-10 one-tile-west links={links:?} shipped={kinds:?}");
    assert_eq!(links.len(), 2, "premise: the belt is docked at both ends");
    assert_eq!(
        kinds,
        vec![TileKind::Corner { from: Dir::W, to: Dir::W }],
        "a one-tile belt fed and drained West ships Corner {{ from: W, to: W }}, a zero-turn \
         corner that keeps the flow direction, not Straight on the X axis (which both \
         renderers draw flowing East)"
    );
}
