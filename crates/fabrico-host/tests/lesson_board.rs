//! The "Belts that join" lesson board, booted the way the app boots it and run long.
//!
//! The board's own manifest run stops at its `end_tick` (360), long before the belt that stops
//! short fills. This test boots the board through `boot_scene` with `BoardId::Lesson`, ticks it
//! for [`RUN_TICKS`] with its timer firing, and records three things the lesson depends on:
//!
//! - the first tick every slot on the stub holds an item (`fill_tick`);
//! - the first tick the Source reads backed up, the jam mark the render packet sends
//!   (`backed_up_tick`);
//! - every tick a node faulted. None is expected: a gated Source refuses timer items silently,
//!   and a board with no line in `examples/boards/faults.manifest` must raise no fault.
//!
//! Ticks are counted from the tick the board arrives (the boot's last tick), so a reader can turn
//! them into seconds at the 62.5 ticks/s the loop runs at. The whole run happens twice and both
//! runs must give the same numbers.
//!
//! It also checks the board's shape before any tick: the Sink's input faces north, the stub's
//! end docks to nothing, the cell past that end is empty, and Undo is greyed.

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::{Node, Role, Side, port_world};
use fabrico_host::demo_scene::{BoardId, LessonBoard, boot_scene};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::derive_state;
use fabrico_protocol::state_tag;
use tokio::sync::mpsc::unbounded_channel;

/// How long each run lasts. At 62.5 ticks/s that is 48 s, past both the fill and the back-up.
const RUN_TICKS: u64 = 3000;

/// The cell past the stub's free end, the cell the app rings while the Belt tool is armed.
const RING_CELL: (i32, i32) = (6, 2);

/// What one run measured, counted in ticks after the board arrived.
#[derive(Debug, PartialEq, Eq)]
struct Measure {
    /// The first tick an item rides the stub.
    first_item_tick: Option<u64>,
    /// The first tick every slot on the stub holds an item.
    fill_tick: Option<u64>,
    /// The first tick the Source reads backed up.
    backed_up_tick: Option<u64>,
    /// `(tick, node)` for every node that read faulted, emitted a fault or held one.
    faults: Vec<(u64, NodeId)>,
}

/// Boot the lesson board on a fresh genesis host at its own seed, through `boot_scene`.
fn boot(dir: &std::path::Path) -> Host {
    let id = BoardId::Lesson(LessonBoard::BeltsThatJoin);
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: id.genesis_seed(),
    });
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    boot_scene(host, id).unwrap_or_else(|e| panic!("{e}"))
}

/// The one node of the kind `pick` accepts.
fn only(host: &Host, what: &str, pick: impl Fn(&Node) -> bool) -> NodeId {
    let state = &host.core().state;
    let found: Vec<NodeId> = state
        .node_ids()
        .filter(|&id| state.node(id).is_some_and(&pick))
        .collect();
    assert_eq!(found.len(), 1, "the lesson board holds exactly one {what}: {found:?}");
    found[0]
}

/// The board as it arrives: its shape, and Undo greyed.
fn assert_shape(host: &Host) -> (NodeId, NodeId) {
    let state = &host.core().state;
    assert_eq!(state.node_count(), 3, "a Source, a Sink and one belt");
    assert!(!host.can_undo(), "the board arrives with Undo greyed");

    let source = only(host, "Source", |n| matches!(n, Node::Source(_)));
    let sink = only(host, "Sink", |n| matches!(n, Node::Sink(_)));
    let stub = only(host, "belt", |n| matches!(n, Node::Belt(_)));

    let foot = state.footprint_of(sink).expect("the Sink has a footprint");
    let anchor = state.cell_of(sink).expect("the Sink has a cell");
    let input = state
        .ports_of(sink)
        .and_then(|ports| ports.iter().find(|p| p.role == Role::In))
        .expect("the Sink has an input");
    let (input_cell, input_side) = port_world(anchor, foot.w, foot.h, foot.rot, input);
    assert_eq!(input_side, Side::N, "the Sink's input faces north");
    assert_eq!(
        input_cell,
        (RING_CELL.0, RING_CELL.1 + 4),
        "the Sink sits in the ring cell's column, with three free cells between them"
    );

    assert_eq!(
        state.links_from(stub).count(),
        0,
        "the stub's end docks to nothing"
    );
    assert!(
        state.links_from(source).any(|(_, (to, _))| to == stub),
        "the stub's start docks to the Source's output"
    );
    assert_eq!(state.occupied(RING_CELL), None, "the cell past the stub's end is empty");
    for y in 3..=5 {
        assert_eq!(state.occupied((6, y)), None, "the column down to the Sink is free at (6,{y})");
    }
    (source, stub)
}

/// One long run from boot.
fn run() -> Measure {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut host = boot(dir.path());
    let (source, stub) = assert_shape(&host);
    let arrived = host.core().tick;

    let (_ingress_tx, mut ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, mut results_rx) = unbounded_channel::<ResultEvent>();

    let mut m = Measure {
        first_item_tick: None,
        fill_tick: None,
        backed_up_tick: None,
        faults: Vec::new(),
    };
    for _ in 0..RUN_TICKS {
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick persists");
        let core = host.core();
        let t = core.tick - arrived;
        let state = &core.state;
        let obs = &core.last_tick;

        for id in state.node_ids() {
            let holds_fault = state.inbox_of(id).is_some_and(|inbox| inbox.has_on(FAULT_PORT));
            if obs.faulted.contains(&id)
                || holds_fault
                || derive_state(id, obs, state) == state_tag::FAULTED
            {
                m.faults.push((t, id));
            }
        }

        let Some(Node::Belt(b)) = state.node(stub) else {
            panic!("the stub is still a belt at tick {t}");
        };
        if m.first_item_tick.is_none() && b.slots.iter().any(Option::is_some) {
            m.first_item_tick = Some(t);
        }
        if m.fill_tick.is_none() && b.slots.iter().all(Option::is_some) {
            m.fill_tick = Some(t);
        }
        if m.backed_up_tick.is_none() && derive_state(source, obs, state) == state_tag::BACKED_UP {
            m.backed_up_tick = Some(t);
        }
    }
    m
}

#[test]
fn the_lesson_board_fills_its_stub_and_backs_up_with_no_fault() {
    let first = run();
    let second = run();
    assert_eq!(first, second, "two runs of the same board give the same numbers");

    let first_item = first.first_item_tick.expect("an item rides the stub");
    let fill = first.fill_tick.expect("the stub fills inside the run");
    let backed_up = first.backed_up_tick.expect("the Source reads backed up inside the run");
    assert!(first.faults.is_empty(), "no node faulted at any tick: {:?}", first.faults);
    assert!(first_item < fill, "items move on the stub before it fills");
    assert!(fill <= backed_up, "the Source backs up once the stub is full");

    println!(
        "lesson-board fill_tick={fill} backed_up_tick={backed_up} faults={} first_item_tick={first_item}",
        first.faults.len()
    );
}
