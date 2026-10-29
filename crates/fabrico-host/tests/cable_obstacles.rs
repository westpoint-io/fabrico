//! CHROME-19 (phase 92, D-09): a landed cable goes around a third machine, graded on the
//! REAL render packet the host builds, never on the router alone.
//!
//! # What this file grades
//! `crates/fabrico-command/tests/wire_obstacles.rs` proves the pure router
//! (`wire_route_avoiding`) goes around a machine when it is handed one. That proof cannot see
//! the CALLER: a render packet that keeps calling the two-argument ladder, or that hands the
//! router an empty or wrongly built machine list, passes every router test while the user
//! still sees a cable drawn straight through a Factory. So every case here builds a board
//! through the same `GridCommand`s a gesture sends (`apply_gesture`, the host's one gesture
//! seam), folds it with real ticks, and reads the `WireView.path` the packet builder wrote.
//!
//! # Why it lives under `tests/`
//! `crates/fabrico-host/src/sim_loop.rs` carried a parallel change's uncommitted test; a test
//! added in `src/` beside the packet builder would share no hunk with it, but the phase rule
//! (D-20, the `tests/gesture_wire.rs` header) is that new host tests live here, so staging
//! this phase's lines never has to reason about that file.
//!
//! Run target: `cargo test -p fabrico-host --test cable_obstacles`

use fabrico_command::{WireBody, WireDock, around_machines_window, wire_route};
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::effective_box;
use fabrico_host::demo_scene::{SceneId, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderPacketBuilder;
use fabrico_protocol::{GridCommand, RenderPacket, WireDockView, WireView, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A fresh host plus the channel triple `tick_once` requires, and the packet builder whose
/// handle table every gesture below resolves through.
struct Probe {
    host: Host,
    builder: RenderPacketBuilder,
    ingress_rx: UnboundedReceiver<EventPayload>,
    results_rx: UnboundedReceiver<ResultEvent>,
    cmd_tx: UnboundedSender<Command>,
    _ingress_tx: UnboundedSender<EventPayload>,
    _res_tx: UnboundedSender<ResultEvent>,
    _cmd_rx: UnboundedReceiver<Command>,
    _dir: tempfile::TempDir,
}

/// An empty board at genesis.
fn probe() -> Probe {
    probe_at(92)
}

/// An empty board at genesis seed `seed`.
fn probe_at(seed: u64) -> Probe {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    Probe {
        host,
        builder: RenderPacketBuilder::new(),
        ingress_rx,
        results_rx,
        cmd_tx,
        _ingress_tx: ingress_tx,
        _res_tx: res_tx,
        _cmd_rx: cmd_rx,
        _dir: dir,
    }
}

impl Probe {
    /// One tick, then one keyframe, so every node folded so far has a render handle.
    fn fold(&mut self) -> RenderPacket {
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("tick_once persists and folds");
        self.builder.build_keyframe(&self.host)
    }

    /// Send one gesture through the host's gesture seam, handles resolved through the
    /// builder's own table, and fold it.
    fn gesture(&mut self, cmd: GridCommand) -> RenderPacket {
        let table = handle_table(&self.builder);
        apply_gesture(&mut self.host, cmd.clone(), |h| table.get(&h).copied())
            .unwrap_or_else(|e| panic!("the gesture {cmd:?} is accepted, got {e:?}"));
        self.fold()
    }

    /// Place a catalog machine of `kind` at its anchor `(x, y)` and answer its id.
    fn place(&mut self, kind: u8, x: i32, y: i32) -> NodeId {
        self.gesture(GridCommand::Place { kind, cell_x: x, cell_y: y });
        *self
            .host
            .core()
            .last_tick
            .placed
            .last()
            .expect("the placement minted an id")
    }

    fn handle(&self, id: NodeId) -> u64 {
        self.builder
            .handle_for_node(id)
            .expect("a folded node has a render handle after a keyframe")
    }
}

/// The builder's handle table as a plain map, so a gesture can resolve handles while the
/// probe is borrowed mutably. The builder mints handles densely from 0, so walking up to the
/// first miss reads the whole table through its public accessor.
fn handle_table(builder: &RenderPacketBuilder) -> std::collections::BTreeMap<u64, NodeId> {
    let mut out = std::collections::BTreeMap::new();
    let mut h = 0u64;
    while let Some(id) = builder.node_for_handle(h) {
        out.insert(h, id);
        h += 1;
    }
    out
}

/// An inclusive cell rectangle `(min_x, min_y, max_x, max_y)`.
type Rect = (i32, i32, i32, i32);

/// The cells of `wire` that fall inside `rect`.
fn cells_inside(wire: &WireView, rect: Rect) -> Vec<(i32, i32)> {
    wire.path
        .iter()
        .map(|t| (t.cell_x, t.cell_y))
        .filter(|&(x, y)| x >= rect.0 && x <= rect.2 && y >= rect.1 && y <= rect.3)
        .collect()
}

fn path_of(wire: &WireView) -> Vec<(i32, i32)> {
    wire.path.iter().map(|t| (t.cell_x, t.cell_y)).collect()
}

/// The board every CHROME-19 case shares with `92-cable-around-machine.live.spec.ts`: a 1x1
/// Route anchored at (8,8), its electrical Out on its one cell facing E; a 3x3 Factory
/// anchored at (12,7), so its box is (12..14, 7..9); a 3x3 HTTP Handler anchored at (18,7),
/// its electrical In at (18,8) facing W. The ladder runs the Route's Out straight along row 8
/// to the Handler's In, which is through the Factory's middle row.
const ROUTE_AT: (i32, i32) = (8, 8);
const FACTORY_AT: (i32, i32) = (12, 7);
const HANDLER_AT: (i32, i32) = (18, 7);
/// The Factory's catalog box (`port_catalog(FACTORY)` is 3x3, rot 0).
const FACTORY_BOX: Rect = (12, 7, 14, 9);
/// The catalog port indexes the drag uses (Route Out = 1, Handler In = 0), as the demo's RON
/// header states them.
const ROUTE_OUT: u16 = 1;
const HANDLER_IN: u16 = 0;

/// Build the three machines and draw the one Route-to-Handler wire; answer the packet that
/// carries the cables and the two handles.
fn route_factory_handler() -> (Probe, RenderPacket, u64, u64) {
    let mut p = probe();
    let route = p.place(machine_kind::ENDPOINT, ROUTE_AT.0, ROUTE_AT.1);
    let _factory = p.place(machine_kind::FACTORY, FACTORY_AT.0, FACTORY_AT.1);
    let handler = p.place(machine_kind::HANDLER, HANDLER_AT.0, HANDLER_AT.1);
    let (hr, hh) = (p.handle(route), p.handle(handler));
    let pkt = p.gesture(GridCommand::DrawWire {
        from_node: hr,
        from_port: ROUTE_OUT,
        to_node: hh,
        to_port: HANDLER_IN,
    });
    (p, pkt, hr, hh)
}

/// CHROME-19-host: on a board built by gestures, the landed cable from the Route to the
/// Handler, and the paired return cable the same drag mints (72-08), enter no cell of the
/// Factory between them, and the forward cable still docks at both ports.
///
/// RED AT `PHASE92_START`: the packet builder called the two-argument `wire_route`, whose
/// ladder knows only the two endpoint bodies, so the forward cable ran straight along row 8
/// through (12,8), (13,8) and (14,8).
#[test]
fn cables_avoid_third_machines_on_a_built_board() {
    let (p, pkt, hr, hh) = route_factory_handler();
    assert_eq!(
        pkt.wires.len(),
        2,
        "PRECONDITION: one Route-to-Handler drag mints both cable legs (72-08)"
    );
    assert_eq!(p.builder.wire_route_failures(), 0, "PRECONDITION: no wire fell back to the stub");
    let forward = pkt
        .wires
        .iter()
        .find(|w| w.from.node == hr && w.to.node == hh)
        .expect("the forward cable Route Out -> Handler In is in the packet");
    let fp = path_of(forward);
    assert_eq!(
        (fp.first().copied(), fp.last().copied()),
        (Some(ROUTE_AT), Some((HANDLER_AT.0, HANDLER_AT.1 + 1))),
        "the forward cable still docks at the Route's Out cell and the Handler's In cell: {fp:?}"
    );
    let inside: Vec<(u64, Vec<(i32, i32)>)> = pkt
        .wires
        .iter()
        .map(|w| (w.id, cells_inside(w, FACTORY_BOX)))
        .filter(|(_, cells)| !cells.is_empty())
        .collect();
    assert!(
        inside.is_empty(),
        "RED-FIRST CHROME-19-host: no cable of the packet enters the Factory's box {FACTORY_BOX:?}; \
         cells inside, by wire handle: {inside:?}; forward path {fp:?}"
    );
}

/// The dock a packet's wire end names, rebuilt from the packet's own `NodeView` and
/// `PortView`: the port's world cell and side, and the node's box through core
/// `effective_box`. What a reader of the packet sees, so a test can ask the router what it
/// would draw between the same two docks.
fn dock_of(pkt: &RenderPacket, end: &WireDockView) -> WireDock {
    let n = pkt
        .placed
        .iter()
        .find(|n| n.id == end.node)
        .unwrap_or_else(|| panic!("the wire end's node {} is in the keyframe", end.node));
    let port = n
        .ports
        .iter()
        .find(|p| p.index == end.port)
        .unwrap_or_else(|| panic!("node {} declares port {}", end.node, end.port));
    let (bw, bh) = effective_box(n.w, n.h, n.rot);
    WireDock {
        cell: (port.cell_x, port.cell_y),
        side: port.side,
        body: WireBody {
            min_x: n.cell_x,
            min_y: n.cell_y,
            max_x: n.cell_x + bw - 1,
            max_y: n.cell_y + bh - 1,
        },
    }
}

/// A cable that left the ladder's path: its handle, the drawn path and the ladder's.
type Moved = (u64, Vec<(i32, i32)>, Vec<(i32, i32)>);

/// The two-argument ladder's path between the docks `wire` names on `pkt`: today's path,
/// the one a cable with no machine in its way keeps (D-09).
fn ladder_of(pkt: &RenderPacket, wire: &WireView) -> Vec<(i32, i32)> {
    wire_route(dock_of(pkt, &wire.from), dock_of(pkt, &wire.to))
        .expect("the ladder routes every dock pair a gesture can build")
        .tiles
        .iter()
        .map(|t| t.cell)
        .collect()
}

/// A keyframe of `id` booted the way the shipped app boots it.
fn scene_packet(id: SceneId) -> RenderPacket {
    let mut p = probe_at(id.genesis_seed());
    let cmds = id.commands().expect("a shipped scene parses");
    seed_scene(&mut p.host, &cmds).expect("a shipped scene seeds");
    let pkt = p.builder.build_keyframe(&p.host);
    assert_eq!(p.builder.wire_route_failures(), 0, "{id:?}: no wire fell back to the stub");
    pkt
}

/// The demo's two cables as the packet drew them at `PHASE92_START` (read off a keyframe of
/// the demo genesis there and here): wire 31, the request from the caller Route's Out to the
/// HTTP Handler's In, and wire 32, the reply back to the Route's In (92-MEASURE.md section 4:
/// they cross no third machine).
const DEMO_REQUEST: &[(i32, i32)] = &[(13, 6), (14, 6), (15, 6), (16, 6)];
const DEMO_REPLY: &[(i32, i32)] = &[
    (18, 6),
    (19, 6),
    (19, 7),
    (19, 8),
    (18, 8),
    (17, 8),
    (16, 8),
    (15, 8),
    (14, 8),
    (13, 8),
    (12, 8),
    (12, 7),
    (12, 6),
    (13, 6),
];

/// D-09, UI-SPEC 4.1 rule 2: a cable with no machine in its way takes exactly the path it
/// takes today. The demo's two cables equal the ladder between the same docks and the
/// literals above; Order Processing and Advanced hold no wire, so they draw no cable at all.
#[test]
fn every_shipped_scene_routes_identically() {
    let demo = scene_packet(SceneId::Demo);
    assert_eq!(demo.wires.len(), 2, "the demo holds the one Route-to-Handler pair");
    let paths: Vec<Vec<(i32, i32)>> = demo.wires.iter().map(path_of).collect();
    let ladders: Vec<Vec<(i32, i32)>> = demo.wires.iter().map(|w| ladder_of(&demo, w)).collect();
    assert_eq!(paths, ladders, "each demo cable is the ladder's path between its two docks");
    assert_eq!(
        paths,
        vec![DEMO_REQUEST.to_vec(), DEMO_REPLY.to_vec()],
        "the demo's cables are the paths they took at PHASE92_START"
    );
    for id in [SceneId::OrderProcessing, SceneId::Advanced] {
        assert!(scene_packet(id).wires.is_empty(), "{id:?} holds no wire");
    }
}

/// UI-SPEC 4.1 rule 4: cables may cross belts, other cables and Labels; only machines are in
/// the way. On the Route-to-Handler board with no Factory, a Label (kind 11, 4x1) laid on the
/// cable's row, a belt drawn across it and a second cable crossing it leave both legs of the
/// pair on the ladder's path, and the forward leg really does run through all three (so the
/// case cannot pass on a board where nothing was in the cable's way).
#[test]
fn obstacles_exclude_labels_belts_wires() {
    let mut p = probe();
    let route = p.place(machine_kind::ENDPOINT, ROUTE_AT.0, ROUTE_AT.1);
    let handler = p.place(machine_kind::HANDLER, HANDLER_AT.0, HANDLER_AT.1);
    // A Label on row 8, cells (10..13, 8).
    p.place(machine_kind::LABEL, 10, 8);
    // A belt across row 8 at column 15, rows 7..9.
    p.gesture(GridCommand::DrawBelt { cells: vec![(15, 7), (15, 8), (15, 9)] });
    // A second cable, Route C at (16,4) to Route D at (16,12): it runs down across row 8.
    let c = p.place(machine_kind::ENDPOINT, 16, 4);
    let d = p.place(machine_kind::ENDPOINT, 16, 12);
    let (hc, hd) = (p.handle(c), p.handle(d));
    p.gesture(GridCommand::DrawWire { from_node: hc, from_port: ROUTE_OUT, to_node: hd, to_port: 0 });
    let (hr, hh) = (p.handle(route), p.handle(handler));
    let pkt = p.gesture(GridCommand::DrawWire {
        from_node: hr,
        from_port: ROUTE_OUT,
        to_node: hh,
        to_port: HANDLER_IN,
    });
    assert_eq!(pkt.wires.len(), 3, "PRECONDITION: the crossing cable and both legs of the pair");
    assert_eq!(p.builder.wire_route_failures(), 0, "PRECONDITION: no wire fell back to the stub");
    let forward = pkt.wires.iter().find(|w| w.from.node == hr).expect("the forward cable");
    let crossing = pkt.wires.iter().find(|w| w.from.node == hc).expect("the crossing cable");
    let fp = path_of(forward);
    let cp = path_of(crossing);
    let label_cells: Vec<(i32, i32)> = (10..=13).map(|x| (x, 8)).collect();
    // NON-VACUITY: the forward cable's path enters the Label, the belt and the other cable.
    assert!(
        label_cells.iter().any(|c| fp.contains(c)),
        "PRECONDITION: the forward cable runs through the Label: {fp:?}"
    );
    assert!(fp.contains(&(15, 8)), "PRECONDITION: the forward cable runs across the belt: {fp:?}");
    assert!(
        cp.iter().any(|c| fp.contains(c)),
        "PRECONDITION: the forward cable crosses the other cable: {fp:?} and {cp:?}"
    );
    let moved: Vec<Moved> = pkt
        .wires
        .iter()
        .filter(|w| w.from.node == hr || w.from.node == hh)
        .map(|w| (w.id, path_of(w), ladder_of(&pkt, w)))
        .filter(|(_, got, ladder)| got != ladder)
        .collect();
    assert!(
        moved.is_empty(),
        "a Label, a belt or another cable never diverts a cable; (handle, drawn, ladder): {moved:?}"
    );
}

/// The packet routes every cable through the one avoiding form, and never through the
/// two-argument ladder, which cannot see a third machine (D-09). Comments are stripped
/// first, as the TypeScript R-70 scan strips them, so prose naming either function never
/// counts; the stripper is checked against the file it strips.
#[test]
fn render_packet_calls_only_the_avoiding_router() {
    let src = include_str!("../src/render_packet.rs");
    let code: String = src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    // Assembled, never spelled, so this file's own text cannot be what is counted.
    let avoiding: String = ["wire_route", "_avoiding("].concat();
    let ladder: String = ["wire_route", "("].concat();
    let traced: String = ["wire_route", "_traced("].concat();
    assert_eq!(code.matches(&avoiding).count(), 1, "one routing call site in the packet builder");
    assert_eq!(code.matches(&ladder).count(), 0, "the two-argument ladder routes no cable");
    // Review IN-A-04: the traced ladder and a renamed import are the ladder too.
    assert_eq!(code.matches(&traced).count(), 0, "the traced ladder routes no cable");
    let imports: String = code
        .split(';')
        .filter(|stmt| stmt.trim_start().starts_with("use fabrico_command"))
        .collect::<Vec<_>>()
        .join(";");
    assert!(imports.contains("is_wire_obstacle"), "the stripper left the fabrico_command imports it reads");
    for ladder_fn in ["wire_route,", "wire_route}", "wire_route ", "wire_route_traced", " as "] {
        assert!(
            !imports.contains(ladder_fn),
            "the packet builder imports a ladder function or renames an import ({ladder_fn:?}): {imports}"
        );
    }
    assert!(
        code.contains("wire_route_avoiding(from_dock, to_dock, &machines)"),
        "the stripper left the call site it counts around"
    );
    assert!(
        src.matches(&ladder).count() > 0,
        "the file's own prose names the ladder, so the comment stripper is really stripping"
    );
}

/// RESEARCH Pitfall 5 and Open Question 1, threat T-92-10: a cable whose ladder crosses a
/// machine re-ran the around-machines search on every `build` and `build_keyframe` until the
/// route memo of review fix pass 1; the builds timed here now reuse the routes, and
/// `bench_routing_per_tick` measures the cables' share of a tick on larger boards. Ten such
/// cables, each between two Routes 30 columns apart on its own row, every row crossed by two
/// touching columns of ten 3x3 Factories, so each search window holds the twenty Factories
/// and the other Routes in its box. Prints the mean per-build time over `BUILDS` keyframes.
///
/// Run: `cargo test -p fabrico-host --test cable_obstacles [--release] -- --ignored
/// --nocapture bench_ten_crossing_wires_per_build`.
#[test]
#[ignore = "a timing bench, run by hand in release and debug"]
// The wall clock is what a bench measures; it is read here, in an ignored test, and never
// by the sim (the workspace's disallowed-types rule is about the sim's time).
#[allow(clippy::disallowed_types, clippy::disallowed_methods)]
fn bench_ten_crossing_wires_per_build() {
    use std::time::Instant;
    const WIRES: i32 = 10;
    const BUILDS: u32 = 50;
    let mut p = probe();
    let mut pairs = Vec::new();
    for i in 0..WIRES {
        p.place(machine_kind::FACTORY, 8, 3 * i);
        p.place(machine_kind::FACTORY, 20, 3 * i);
        let a = p.place(machine_kind::ENDPOINT, 0, 3 * i + 1);
        let b = p.place(machine_kind::ENDPOINT, 30, 3 * i + 1);
        pairs.push((a, b));
    }
    for &(a, b) in &pairs {
        let (ha, hb) = (p.handle(a), p.handle(b));
        p.gesture(GridCommand::DrawWire { from_node: ha, from_port: ROUTE_OUT, to_node: hb, to_port: 0 });
    }
    let pkt = p.builder.build_keyframe(&p.host);
    assert_eq!(pkt.wires.len(), WIRES as usize, "PRECONDITION: ten cables");
    let machines: Vec<WireBody> = pkt
        .placed
        .iter()
        .filter(|n| fabrico_command::is_wire_obstacle(n.kind))
        .map(|n| {
            let (bw, bh) = effective_box(n.w, n.h, n.rot);
            WireBody { min_x: n.cell_x, min_y: n.cell_y, max_x: n.cell_x + bw - 1, max_y: n.cell_y + bh - 1 }
        })
        .collect();
    let mut windows = Vec::new();
    for w in &pkt.wires {
        let ladder = ladder_of(&pkt, w);
        let crosses = ladder.iter().any(|&(x, y)| {
            pkt.placed.iter().any(|n| {
                n.kind == machine_kind::FACTORY && x >= n.cell_x && x <= n.cell_x + 2 && y >= n.cell_y && y <= n.cell_y + 2
            })
        });
        assert!(crosses, "PRECONDITION: every cable's ladder crosses a Factory: {ladder:?}");
        let factory_cells = path_of(w)
            .iter()
            .filter(|&&(x, y)| ((8..=10).contains(&x) || (20..=22).contains(&x)) && (0..3 * WIRES).contains(&y))
            .count();
        assert_eq!(factory_cells, 0, "every cable goes around the Factory columns: {:?}", path_of(w));
        windows.push(around_machines_window(dock_of(&pkt, &w.from), dock_of(&pkt, &w.to), &machines).obstacles.len());
    }
    let factories_in_every_window = windows.iter().all(|&n| n >= 20);
    assert!(factories_in_every_window, "PRECONDITION: each window holds the twenty Factories: {windows:?}");
    for _ in 0..3 {
        p.builder.build_keyframe(&p.host);
    }
    let t0 = Instant::now();
    for _ in 0..BUILDS {
        std::hint::black_box(p.builder.build_keyframe(&p.host));
    }
    let per_build_ms = t0.elapsed().as_secs_f64() * 1000.0 / f64::from(BUILDS);
    println!(
        "BENCH_RESULT per_build_ms={per_build_ms:.3} wires={WIRES} builds={BUILDS} window_obstacles={windows:?} profile={}",
        if cfg!(debug_assertions) { "debug" } else { "release" }
    );
}

/// A board for the per-tick routing cost (threats T-92-06 and T-92-10, security audit
/// figures): `routes` pairs of 1x1 Routes, each pair joined by one cable, and `filler` more
/// machines, built with every Place sent before one fold and every DrawWire before another,
/// so a board of thousands of machines builds in one pass. `pair_at(i)` answers the two
/// Routes' anchors; `filler_at(i)` the kind and anchor of filler machine `i`.
fn routing_board(
    cables: bool,
    pairs: usize,
    pair_at: &dyn Fn(usize) -> ((i32, i32), (i32, i32)),
    filler: usize,
    filler_at: &dyn Fn(usize) -> (u8, (i32, i32)),
) -> Probe {
    let mut p = probe();
    let place = |p: &mut Probe, kind: u8, (x, y): (i32, i32)| {
        let table = handle_table(&p.builder);
        let cmd = GridCommand::Place { kind, cell_x: x, cell_y: y };
        apply_gesture(&mut p.host, cmd.clone(), |h| table.get(&h).copied())
            .unwrap_or_else(|e| panic!("the gesture {cmd:?} is accepted, got {e:?}"));
    };
    for i in 0..pairs {
        let (a, b) = pair_at(i);
        place(&mut p, machine_kind::ENDPOINT, a);
        place(&mut p, machine_kind::ENDPOINT, b);
    }
    for i in 0..filler {
        let (kind, at) = filler_at(i);
        place(&mut p, kind, at);
    }
    let pkt = p.fold();
    let at: std::collections::BTreeMap<(i32, i32), u64> =
        pkt.placed.iter().map(|n| ((n.cell_x, n.cell_y), n.id)).collect();
    if !cables {
        return p;
    }
    let table = handle_table(&p.builder);
    for i in 0..pairs {
        let (a, b) = pair_at(i);
        let cmd = GridCommand::DrawWire { from_node: at[&a], from_port: ROUTE_OUT, to_node: at[&b], to_port: 0 };
        apply_gesture(&mut p.host, cmd.clone(), |h| table.get(&h).copied())
            .unwrap_or_else(|e| panic!("the gesture {cmd:?} is accepted, got {e:?}"));
    }
    let pkt = p.fold();
    assert_eq!(pkt.wires.len(), pairs, "PRECONDITION: one cable per pair");
    assert_eq!(pkt.placed.len(), 2 * pairs + filler, "PRECONDITION: every machine placed");
    p
}

/// The audit's two boards (`92-SECURITY.md`, T-92-06 and T-92-10):
/// - `wide`: 2,025 machines and 1,000 cables, each between two Routes three columns apart with
///   nothing between them, so no cable enters a machine (12.0 ms per tick in release before
///   the memo);
/// - `dense`: a hundred 100-cell tiles, each with one cable corner to corner and 62 more 1x1
///   machines at distinct coordinates, one on the cable's ladder path, so every cable's window
///   is crowded (the audit's forged board, 819 ms per tick).
fn wide_board(cables: bool) -> Probe {
    routing_board(
        cables,
        1000,
        &|i| {
            let (col, row) = (i32::try_from(i % 25).expect("small"), i32::try_from(i / 25).expect("small"));
            ((-500 + 8 * col, -500 + 2 * row), (-497 + 8 * col, -500 + 2 * row))
        },
        25,
        &|i| (machine_kind::FACTORY, (-500 + 8 * i32::try_from(i).expect("small"), 300)),
    )
}

fn dense_board(cables: bool) -> Probe {
    let tile = |t: usize| -> (i32, i32) {
        let t = i32::try_from(t).expect("small");
        (-510 + (t % 10) * 102, -510 + (t / 10) * 102)
    };
    let fillers: Vec<(i32, i32)> = (0..100)
        .flat_map(|t| {
            let (ox, oy) = tile(t);
            let from = WireDock { cell: (ox, oy), side: 1, body: WireBody { min_x: ox, min_y: oy, max_x: ox, max_y: oy } };
            let to = WireDock {
                cell: (ox + 98, oy + 98),
                side: 3,
                body: WireBody { min_x: ox + 98, min_y: oy + 98, max_x: ox + 98, max_y: oy + 98 },
            };
            let ladder = wire_route(from, to).expect("routes");
            let mid = ladder.tiles[ladder.tiles.len() / 3].cell;
            let mut m = vec![mid];
            let mut k = 1;
            while m.len() < 62 && k < 5000 {
                let (x, y) = (ox + 2 + (k * 37) % 95, oy + 2 + (k * 61) % 95);
                k += 1;
                if !m.iter().any(|q| q.0 == x || q.1 == y) {
                    m.push((x, y));
                }
            }
            m
        })
        .collect();
    let n = fillers.len();
    routing_board(
        cables,
        100,
        &|t| {
            let (ox, oy) = tile(t);
            ((ox, oy), (ox + 98, oy + 98))
        },
        n,
        &|i| (machine_kind::SOURCE, fillers[i]),
    )
}

/// Mean milliseconds per quiet tick, both builds a tick runs (`build`, then `build_keyframe`,
/// as `RenderProducer::on_tick` runs them), after two warm-up ticks.
#[allow(clippy::disallowed_types, clippy::disallowed_methods)]
fn quiet_tick_ms(p: &mut Probe, ticks: u32) -> f64 {
    use std::time::Instant;
    for _ in 0..2 {
        p.builder.build(&p.host);
        p.builder.build_keyframe(&p.host);
    }
    let t0 = Instant::now();
    for _ in 0..ticks {
        std::hint::black_box(p.builder.build(&p.host));
        std::hint::black_box(p.builder.build_keyframe(&p.host));
    }
    t0.elapsed().as_secs_f64() * 1000.0 / f64::from(ticks)
}

/// THE CABLES' SHARE OF A QUIET TICK (threats T-92-06 and T-92-10), on the audit's two boards:
/// the tick with the cables less the same board's tick with none (the packet's other work, a
/// view per machine, is the phase's baseline and not the router's). BOUND: in a release build
/// the cables cost under 1.6 ms per tick, a tenth of the 16 ms tick. Seen red before the route
/// memo (`92-GATES.md` `## Review fix pass 1`): 16.0 and 822.3 ms per tick at a pre-release revision.
///
/// Run: `cargo test -p fabrico-host --test cable_obstacles --release -- --ignored --nocapture
/// bench_routing_per_tick`.
#[test]
#[ignore = "a timing bench, run by hand in release and debug"]
fn bench_routing_per_tick() {
    const TICKS: u32 = 10;
    let mut over = Vec::new();
    type Board = fn(bool) -> Probe;
    let boards: [(&str, Board); 2] = [("wide", wide_board), ("dense", dense_board)];
    for (name, board) in boards {
        let mut with = board(true);
        let mut without = board(false);
        let machines = with.builder.build_keyframe(&with.host).placed.len();
        let cables_ms = quiet_tick_ms(&mut with, TICKS);
        let base_ms = quiet_tick_ms(&mut without, TICKS);
        let share_ms = cables_ms - base_ms;
        let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
        println!(
            "BENCH_RESULT board={name} machines={machines} per_tick_ms={cables_ms:.3} \
             without_cables_ms={base_ms:.3} cables_share_ms={share_ms:.3} profile={profile}"
        );
        if !cfg!(debug_assertions) && share_ms >= 1.6 {
            over.push(format!("{name} {share_ms:.3} ms"));
        }
    }
    assert!(
        over.is_empty(),
        "a quiet tick's cables cost over a tenth of the 16 ms tick: {over:?}"
    );
}

/// THE ROUTE MEMO (review fix pass 1, WR-A-03, threats T-92-06 and T-92-10): a quiet tick
/// routes no cable, the keyframe a tick builds after its diff reuses the diff's routes, and
/// any change to the machine list routes every cable again. The memo's answers are the
/// router's: a fresh builder on the same board, which has routed nothing yet, draws the same
/// paths.
#[test]
fn a_quiet_tick_routes_no_cable() {
    let mut p = routing_board(
        true,
        12,
        &|i| {
            let y = 4 * i32::try_from(i).expect("small");
            ((0, y + 1), (30, y + 1))
        },
        12,
        &|i| (machine_kind::FACTORY, (12, 4 * i32::try_from(i).expect("small"))),
    );
    let first = p.builder.wire_routes_computed();
    assert!(first >= 12, "PRECONDITION: the folds routed every cable at least once");
    p.builder.build(&p.host);
    assert_eq!(p.builder.wire_routes_computed(), first, "a quiet diff build routes no cable");
    p.builder.build_keyframe(&p.host);
    for _ in 0..3 {
        p.host
            .tick_once(&mut p.ingress_rx, &mut p.results_rx, &p.cmd_tx)
            .expect("tick_once persists and folds");
        p.builder.build(&p.host);
        p.builder.build_keyframe(&p.host);
    }
    assert_eq!(p.builder.wire_routes_computed(), first, "quiet ticks route no cable");

    let mut fresh = RenderPacketBuilder::new();
    let a = p.builder.build_keyframe(&p.host);
    let b = fresh.build_keyframe(&p.host);
    let paths = |pkt: &RenderPacket| -> Vec<Vec<(i32, i32)>> { pkt.wires.iter().map(path_of).collect() };
    assert_eq!(paths(&a), paths(&b), "the memo's paths are the router's");
    assert_eq!(fresh.wire_routes_computed(), 12, "a fresh builder routes each cable once");
    let crossing = paths(&a)
        .iter()
        .filter(|path| path.iter().any(|&(x, y)| (12..=14).contains(&x) && y % 4 != 3 && (0..48).contains(&y)))
        .count();
    assert_eq!(crossing, 0, "PRECONDITION: every cable goes round its Factory");

    // One more machine, on the last cable's row past its Factory: the list changed, so every
    // cable is routed again, and the last cable goes round the new machine too.
    let last = paths(&a).into_iter().find(|path| path.first() == Some(&(0, 45))).expect("the last cable");
    assert!(last.contains(&(21, 43)), "PRECONDITION: the last cable runs through (21, 43): {last:?}");
    let pkt = p.gesture(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 20, cell_y: 42 });
    let moved = pkt.wires.iter().map(path_of).find(|path| path.first() == Some(&(0, 45))).expect("the last cable");
    assert!(
        !moved.iter().any(|&(x, y)| (20..=22).contains(&x) && (42..=44).contains(&y)),
        "a machine placed on a cable's path re-routes it: {moved:?}"
    );
    let before = p.builder.wire_routes_computed();
    p.builder.build(&p.host);
    p.builder.build_keyframe(&p.host);
    assert_eq!(
        p.builder.wire_routes_computed(),
        before,
        "the fold's own keyframe already re-routed the cables round the new list"
    );
    assert!(before >= first + 12, "the new machine re-routed every cable");
}
