//! LINK-08 clause (iv): a board carrying a belt-to-belt run is written to a real `.fab`
//! and read back with the run INTACT, asserted on the LOADED host.
//!
//! # What this closes, and why nothing else in the phase does
//!
//! LINK-08 clause (iv) and ROADMAP success criterion 5 both OPEN with the same sentence:
//! "A board carrying a belt-to-belt run saves and reloads with the run intact." Before
//! this file nothing in phase 74 wrote a `.fab` and read one back. The golden corpus
//! certifies edit-log REPLAY, which is a different claim: replay rebuilds a board from
//! records that never left memory. LINK-14's two frozen witnesses prove that an OLD board
//! is REFUSED, which is the opposite direction entirely. And `PROJECT_FILE_VERSION` moved
//! 10 to 11 in plan 74-02 with no round-trip coverage at all: the phase proved that a
//! pre-thaw file does not open, and proved nothing about whether a post-thaw one does.
//!
//! # Which board shape this leg does NOT cover, said here so nobody over-reads it
//!
//! The `.fab` written below comes from a host built ENTIRELY through the edit log. WINDOWS
//! row 1 records that the shipped application's own save/load defect came from the old
//! demo boot minting its request pair outside the edit log (removed by plan 85-08), which
//! ran the slotmap allocator AHEAD of the edit log, so the saved board held nodes no
//! record accounts for. A log-built host cannot
//! reproduce that by construction, and this file therefore says nothing about it. That
//! half is covered by `frontend/e2e-live/24-one-board-all-six.spec.ts` leg 5. Both halves
//! are named so a later reader does not mistake this leg for whole-of-save/load coverage.
//!
//! # The method is copied from `route_table_write_load_agreement.rs`, not its subject
//!
//! That file exists to make the same class of point and its header states the rule: CALL
//! the real `load_project` and let it answer. No predicate is restated anywhere in this
//! file either. Its `save_then_load` shape is reused whole:
//!
//! 1. assert quiescence first, because `save_project` refuses a host with a command
//!    in flight (`ProjectError::NotQuiescent`) and a leg that tripped on that would be
//!    failing for a reason with nothing to do with belts;
//! 2. `save_project` into a real file under a `tempfile::tempdir()`;
//! 3. `load_project` with a FRESH work dir, because a reused one lets state already on
//!    disk answer where the file should have;
//! 4. assert on the LOADED `Host`, never on the host that saved.
//!
//! # The inverted companion is what gives the joined arm a failing direction
//!
//! `two_unjoined_belts_reload_with_no_dock_between_them` saves the SAME two belts with no
//! dock and asserts that neither belt's `docks` names the other. Without it, a `docks`
//! reader that answered "joined" for every board would pass the joined arm, and this leg
//! would be a check that cannot fail.
//!
//! Run target: `cargo test -p fabrico-host --test belt_run_save_reload`.

// `fabrico-host` is the project's sanctioned I/O home and does NOT carry the determinism
// clippy gate (that lives only in `fabrico-core`). Reading back the `.fab` this test just
// wrote, so the envelope version can be read off the BUNDLE rather than off prose, is
// exactly the test IO that belongs here; scope the allow defensively in case CI promotes
// the lint workspace-wide. Same reasoning, same wording, as
// `tests/route_table_write_load_agreement.rs`, whose method this file copies.
#![allow(clippy::disallowed_methods)]

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::Node;
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{PROJECT_FILE_VERSION, ProjectFile, load_project, save_project};
use fabrico_host::render_packet::RenderPacketBuilder;
use fabrico_protocol::{BeltEnd, GridCommand};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// The genesis seed for every host here. Pinned so a rerun folds the identical scene.
const SEED: u64 = 0x0074_0011_5AFE_0000;

/// Belt A's drawn cells. Its HEAD tile is `(2,0)` and its outward side there is E.
const RUN_A: [(i32, i32); 2] = [(1, 0), (2, 0)];
/// Belt B's drawn cells. Its TAIL tile is `(3,0)` and its outward side there is W, so
/// each end's outward step lands exactly on the other's end tile. THE ADJACENCY EDGE:
/// the two runs genuinely abut, and the join below is one a user can build.
const RUN_B: [(i32, i32); 2] = [(3, 0), (4, 0)];

// ---------------------------------------------------------------------------
// The rig.
// ---------------------------------------------------------------------------

/// A real `Host` over tempfile redb stores, plus the per-tick channels `tick_once` drains.
/// The `TempDir` is returned so it outlives the stores.
struct Rig {
    dir: tempfile::TempDir,
    host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    cmd_tx: UnboundedSender<Command>,
    results_rx: UnboundedReceiver<ResultEvent>,
    /// The dense handle table gesture frames address the board by (handle IS the index).
    nodes: Vec<NodeId>,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: SEED,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");
        let (_ingress_tx, ingress_rx) = unbounded_channel();
        let (cmd_tx, _cmd_rx) = unbounded_channel();
        let (_res_tx, results_rx) = unbounded_channel();
        Self {
            dir,
            host,
            ingress_rx,
            cmd_tx,
            results_rx,
            nodes: Vec::new(),
        }
    }

    /// Apply ONE `GridCommand` through the certified gesture path and fold it in ONE tick.
    /// One command per tick is structural: a `Dock` resolves its target against the LIVE
    /// core, so a dependency must be folded a tick before its dependent.
    fn apply(&mut self, cmd: GridCommand, what: &str) {
        let table = self.nodes.clone();
        apply_gesture(&mut self.host, cmd, move |h| table.get(h as usize).copied())
            .unwrap_or_else(|e| panic!("{what}: rejected with {e:?}"));
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("tick persists");
        let placed: Vec<NodeId> = self.host.core().last_tick.placed.to_vec();
        self.nodes.extend(placed);
    }
}

/// Two abutting belt runs on row 0, drawn through the certified path. Handles are dense
/// and assigned in mint order, so belt A is handle 0 and belt B is handle 1.
fn two_abutting_runs() -> Rig {
    let mut rig = Rig::new();
    rig.apply(
        GridCommand::DrawBelt {
            cells: RUN_A.to_vec(),
        },
        "draw belt A, the upstream run",
    );
    rig.apply(
        GridCommand::DrawBelt {
            cells: RUN_B.to_vec(),
        },
        "draw belt B, the downstream run",
    );
    assert_eq!(
        rig.nodes.len(),
        2,
        "the board minted exactly two belts, in gesture order"
    );
    rig
}

/// The belt whose drawn geometry is exactly `cells`, resolved by GEOMETRY rather than by
/// a carried `NodeId`.
///
/// Reading the loaded board back by id would be a weaker claim that happens to hold: it
/// would pass on a loader that restored the ids and lost the geometry. Naming the belt by
/// the cells the user drew is the identity a user would recognise, and it is the identity
/// the assertions below are about.
fn belt_at(host: &Host, cells: &[(i32, i32)]) -> NodeId {
    let state = &host.core().state;
    let mut found: Vec<NodeId> = Vec::new();
    for id in state.node_ids() {
        if let Some(Node::Belt(b)) = state.node(id) {
            let drawn: Vec<(i32, i32)> = b.geometry.iter().map(|t| t.cell).collect();
            if drawn == cells {
                found.push(id);
            }
        }
    }
    assert_eq!(
        found.len(),
        1,
        "exactly one belt on the loaded board is drawn on {cells:?}; found {found:?}"
    );
    found[0]
}

/// Every `(source_node, source_port)` whose link TARGETS `(node, 0)`.
///
/// This is the read FROM THE DOWNSTREAM SIDE. A belt-to-belt join writes ONE directed
/// entry, `(A,0) -> (B,0)`, so `link_target` answers only from A. Asking who points AT B
/// is the other half of "both sides" on the core state, and a loader that restored the
/// link under the wrong key would answer this differently.
fn upstreams_of(host: &Host, node: NodeId) -> Vec<(NodeId, PortId)> {
    let mut sources: Vec<(NodeId, PortId)> = host
        .core()
        .state
        .links_iter()
        .filter(|(_, to)| to.0 == node)
        .map(|(from, _)| from)
        .collect();
    sources.sort_unstable();
    sources
}

/// Save `rig`'s host to a `.fab` and hand the file to the REAL `load_project`.
///
/// Returns `(fab_path, work_dir, loaded_host)`. The work dir is FRESH per load (a
/// `load_project` precondition) and returned so it outlives the loaded host's store.
fn save_then_load(rig: &Rig, name: &str) -> (std::path::PathBuf, tempfile::TempDir, Host) {
    assert_eq!(
        rig.host.in_flight_len(),
        0,
        "the scene must be quiescent before a save; save_project refuses otherwise and \
         the refusal would have nothing to do with belts"
    );
    let fab = rig.dir.path().join(name);
    save_project(&rig.host, &fab).expect("a quiescent board saves");
    let work = tempfile::tempdir().expect("a FRESH work_dir for the load");
    let loaded = load_project(&fab, work.path(), Some(1)).unwrap_or_else(|err| {
        panic!("load_project REFUSED a bundle save_project had just written: {err}")
    });
    (fab, work, loaded)
}

// ---------------------------------------------------------------------------
// The claims.
// ---------------------------------------------------------------------------

#[test]
fn a_board_carrying_a_belt_to_belt_run_saves_and_reloads_with_the_run_intact() {
    let mut rig = two_abutting_runs();
    rig.apply(
        GridCommand::Dock {
            belt: 0,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        },
        "join belt A's head to belt B's tail",
    );

    // The board really carries the run BEFORE the save, so what crosses the file is a
    // joined board rather than a pair of loose belts the reload could not have joined.
    let (saved_a, saved_b) = (belt_at(&rig.host, &RUN_A), belt_at(&rig.host, &RUN_B));
    assert_eq!(
        rig.host.core().state.link_target((saved_a, 0)),
        Some((saved_b, 0)),
        "the SAVING board carries the belt-to-belt link"
    );

    let (_fab, _work, loaded) = save_then_load(&rig, "joined-run.fab");

    // From here on every read is off the LOADED host. Its belts are resolved by the cells
    // the user drew, not by the ids the saving board happened to hold.
    let a = belt_at(&loaded, &RUN_A);
    let b = belt_at(&loaded, &RUN_B);

    // (1) The core state, from A's side.
    assert_eq!(
        loaded.core().state.link_target((a, 0)),
        Some((b, 0)),
        "the loaded board's belt A still delivers into belt B"
    );
    // (2) The core state, from B's side: who points AT B.
    assert_eq!(
        upstreams_of(&loaded, b),
        vec![(a, 0)],
        "the loaded board's belt B is still fed by belt A and by nothing else"
    );

    // (3) The RENDER PACKET, both sides. The state assertions prove the bytes survived;
    //     this proves the surface the frontend actually consumes still projects the join.
    //     A fresh builder mints its own handle table, so both handles are read back off
    //     the builder that produced the packet rather than assumed equal to any NodeId.
    let mut builder = RenderPacketBuilder::new();
    let pkt = builder.build_keyframe(&loaded);
    let ha = builder
        .handle_for_node(a)
        .expect("belt A is in the loaded keyframe");
    let hb = builder
        .handle_for_node(b)
        .expect("belt B is in the loaded keyframe");
    let view = |h: u64| {
        pkt.belts
            .iter()
            .find(|v| v.id == h)
            .unwrap_or_else(|| panic!("the loaded keyframe carries the belt at handle {h}"))
    };
    let a_docks = &view(ha).docks;
    assert!(
        a_docks
            .iter()
            .any(|d| d.end == BeltEnd::Head && d.node == hb && d.port == 0),
        "the LOADED packet gives belt A a HEAD dock naming belt B: got {a_docks:?}",
    );
    let b_docks = &view(hb).docks;
    assert!(
        b_docks
            .iter()
            .any(|d| d.end == BeltEnd::Tail && d.node == ha && d.port == 0),
        "the LOADED packet gives belt B a TAIL dock naming belt A: got {b_docks:?}",
    );
}

#[test]
fn two_unjoined_belts_reload_with_no_dock_between_them() {
    // THE INVERTED COMPANION, and the reason the arm above is evidence for anything. The
    // same two abutting belts, on the same rig, through the same save and the same load,
    // with the ONE difference that no Dock was ever applied. A `docks` reader that
    // answered "joined" for every board passes the joined arm and fails here.
    let rig = two_abutting_runs();
    let (_fab, _work, loaded) = save_then_load(&rig, "unjoined-runs.fab");

    let a = belt_at(&loaded, &RUN_A);
    let b = belt_at(&loaded, &RUN_B);

    assert_eq!(
        loaded.core().state.link_target((a, 0)),
        None,
        "belt A delivers into nothing on the loaded unjoined board"
    );
    assert_eq!(
        upstreams_of(&loaded, b),
        Vec::new(),
        "nothing feeds belt B on the loaded unjoined board"
    );

    let mut builder = RenderPacketBuilder::new();
    let pkt = builder.build_keyframe(&loaded);
    let ha = builder
        .handle_for_node(a)
        .expect("belt A is in the loaded keyframe");
    let hb = builder
        .handle_for_node(b)
        .expect("belt B is in the loaded keyframe");
    let view = |h: u64| {
        pkt.belts
            .iter()
            .find(|v| v.id == h)
            .unwrap_or_else(|| panic!("the loaded keyframe carries the belt at handle {h}"))
    };
    assert!(
        !view(ha).docks.iter().any(|d| d.node == hb),
        "the LOADED packet does NOT have belt A naming belt B: got {:?}",
        view(ha).docks,
    );
    assert!(
        !view(hb).docks.iter().any(|d| d.node == ha),
        "the LOADED packet does NOT have belt B naming belt A: got {:?}",
        view(hb).docks,
    );
}

#[test]
fn the_fab_this_leg_round_trips_carries_project_file_version_thirteen() {
    // Read off the BUNDLE, not off prose. Two claims, and they are different:
    //
    //  - the file `save_project` wrote is stamped with whatever `PROJECT_FILE_VERSION`
    //    currently reads, so the round trip above exercised the LIVE envelope version;
    //  - and that constant is 13, where plan 87-03 moved it in lockstep with
    //    `SNAPSHOT_SCHEMA_VERSION` 14 (phase 87's four appended core fields). It was 12 from
    //    plan 85-09 (the file's last field, a record of nodes minted outside the edit log,
    //    removed) and 11 from plan 74-02 (in lockstep with `SNAPSHOT_SCHEMA_VERSION` 12).
    //
    // The second half is deliberately a hard literal. A future bump makes this leg SAY so
    // rather than silently round-tripping some other version and leaving the reader to
    // assume it was this one.
    let mut rig = two_abutting_runs();
    rig.apply(
        GridCommand::Dock {
            belt: 0,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        },
        "join belt A's head to belt B's tail",
    );
    let (fab, _work, _loaded) = save_then_load(&rig, "version-arm.fab");

    let bytes = std::fs::read(&fab).expect("the saved bundle is readable");
    let bundle: ProjectFile =
        postcard::from_bytes(&bytes).expect("the saved bundle decodes as a ProjectFile");

    assert_eq!(
        bundle.version, PROJECT_FILE_VERSION,
        "the bundle carries the envelope version this tree writes"
    );
    assert_eq!(
        PROJECT_FILE_VERSION, 13,
        "PROJECT_FILE_VERSION reads 13 after plan 87-03's bump, so the round trip above \
         exercised THIS version and not one the tree no longer writes"
    );
    assert_eq!(
        bundle.head_tick,
        rig.host.core().tick,
        "the bundle was taken at the board's own head tick"
    );
}
