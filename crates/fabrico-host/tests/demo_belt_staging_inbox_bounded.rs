//! PILE-03's SECOND named acceptance clause, on the board the app actually ships:
//! belt 12's staging inbox length is IDENTICAL at tick 3600 and tick 6000.
//!
//! # Why this file exists separately from the synthetic arm
//!
//! PILE-03 names two checks. The first is a `cargo test -p fabrico-core` case on a
//! hand-built source -> beltA -> Tee -> slow-beltB topology
//! (`tick_belt_staging_inbox_is_bounded_and_refuses_its_feeder`), and it proves the
//! bound EXISTS. It does not prove the bound BINDS on the demo board, and the demo
//! board is the one every user sees. WINDOWS 174 (fixed in phase 87, JAM-02) measured
//! the shipped board behaving unlike the synthetic ones (a jammed Tee branch starved the
//! healthy branches until phase 87 gave each branch its own hold). So the requirement
//! names a second, host-side check on the SHIPPED chain and this file is it.
//!
//! # THE CLAUSE'S SETTINGS ARE NOT THE SHIPPED DEFAULTS, AND THAT IS MEASURED
//!
//! PILE-03's clause reads *"on the SHIPPED demo board (belt 12, the long branch, at
//! 25 px/sec with the Source on Timer every 2 ticks)"*. **Both of those are settings
//! the clause imposes, not values `examples/boards/demo_scene.board.ron` carries.** The shipped RON
//! authors `Timer(interval_ticks: 8)` (`DEMO_INJECT_EVERY`) and no belt pace at all,
//! so every demo belt runs at `DEFAULT_TICKS_PER_SLOT` = 2 - about 250 px/sec at the
//! 62.5 t/s loop, ten times the clause's 25 px/sec. (25 px/sec IS 20 ticks/slot: 4
//! slots per 32px tile at 62.5 t/s.)
//!
//! **Measured on the shipped board at its own defaults, before anything is
//! reconfigured: belt 12's staging inbox reads 0 at ticks 400, 1200, 2400, 3600 AND
//! 6000, and so does every other inbox on the board.** At its shipped pace the long
//! branch keeps up with the Source and NOTHING stages anywhere. An assertion written
//! against the defaults would be `0 == 0` - the exact check-that-cannot-fail this
//! project keeps finding - which is why this file applies the clause's two settings
//! first, through the certified gesture path, and asserts they folded. That finding is
//! filed as a WINDOWS row so a later reader does not over-read the clause.
//!
//! # The measurement the clause was written against
//!
//! `71-RESEARCH.md` / `REQUIREMENTS.md` record the pre-phase probe on this chain under
//! exactly these settings (SOURCE -> belt 9 -> FACTORY -> belt 10 -> TEE -> belt 12,
//! the long branch): belt 12's staging inbox held **2 entries at tick 2400, 22 at tick
//! 3600 and 72 at tick 5999** - monotone growth, because nothing bounded a `PortInbox`
//! on any port. The assertion below therefore has real content: on the pre-phase tree
//! it is red by construction, and it can only be green because
//! `admit::MECHANICAL_INBOX_CAP` now governs a belt's staging inbox exactly as it
//! governs a machine's (ruling R-1).
//!
//! # The board is BOOTED, not approximated
//!
//! `DemoBoard::boot` reproduces the Tauri shell's order verbatim (`fabrico-app`:
//! `Core::genesis(DEMO_GENESIS_SEED)` -> `boot_scene`, which is `seed_scene(demo_commands())`
//! -> `timers_from_log` -> install, kept as those steps here because the test needs the
//! mint-order ledger `seed_scene` returns). Nothing here hand-builds a
//! chain, hand-links a port or hand-installs a timer: every node and every dock comes
//! from `examples/boards/demo_scene.board.ron` through the certified gesture path, and the two clause
//! settings are applied as ordinary `GridCommand::Configure` gestures - the same
//! gestures a user makes in the config panel - with the `TimerSet` re-projected from
//! the edit-log afterwards exactly as `SimLoop::tick_body` does it. A test that built
//! its own approximation would be satisfied by an engine that ignored the shipped
//! scene entirely.
//!
//! # THE TRAP: an equal length is FREE on a queue that never filled
//!
//! `0 == 0` at two tick marks proves nothing, and (see above) it is precisely what
//! this board produces if either Configure fails to fold. Four clauses close that,
//! each with its own failure message:
//!
//!   1. **Both gestures FOLDED** - belt 12 really advances every 20 ticks, and the
//!      logged injection cadence across the sampled window really is every 2 ticks.
//!   2. **The queue is at `MECHANICAL_INBOX_CAP` at both points** - it is the BOUND
//!      holding it level, not a lightly-loaded board sitting in equilibrium.
//!   3. **An EARLY sample is strictly SMALLER** - the queue demonstrably GROWS before
//!      it plateaus, so the level stretch between 3600 and 6000 is a property of this
//!      board under load and not a constant the test could never have seen move.
//!   4. **The feeder is refused too** - PILE-03 names the refusal, not just the queue,
//!      so the TEE that feeds belt 12 must have been refused on that branch. Until phase
//!      87 that read "the Tee backed up"; since JAM-02 (D-03) the Tee is refused per
//!      branch, so each copy belt 12 cannot take is counted on `Tee.faults` and the Tee
//!      keeps feeding its other branch (re-pinned by plan 87-05, recorded in
//!      `87-EVIDENCE.md` `## Pinned moves`).
//!
//! Non-vacuity was also PROVED BY MUTATION while this file was written, not merely
//! argued: with `accepts_n`'s `Mechanical` arm short-circuited to `true` (the bound
//! deleted outright) the clause assertion goes RED reading **1589 at tick 3600 and
//! 2669 at tick 6000** instead of 16 and 16. The mutation was run against a scratch
//! edit of `crates/fabrico-core/src/admit.rs` and reverted; it is recorded here so a
//! later reader does not have to take the claim on trust.

use fabrico_core::admit::MECHANICAL_INBOX_CAP;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::Node;
use fabrico_host::demo_scene::{
    DEMO_GENESIS_SEED, demo_commands, seed_scene, timers_from_log,
};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_protocol::{GridCommand, MachineConfig, SourceTrigger};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// The dense render handle of the belt the clause calls "belt 12, the long branch": the
/// TEE's second output. PILE-03 named it by its handle on the demo of its day, a 12-tile
/// run into a long-branch sink. Plan 85-08 rebuilt the demo (D-14 to D-16): the TEE's
/// second output is now the AUDIT COPY belt, three tiles from (11,4) to (13,4) into the
/// Audit sink at (14,4), minted at handle 21 (11 machines and 7 labels, then belts 18..=28
/// in `DrawBelt` order, so it is the fourth drawn belt still). The clause's subject is the
/// same queue - the Tee's second branch, slowed to 25 px/sec while its feeder runs fast -
/// and only its handle and length moved. `examples/boards/demo_scene.board.ron` names it at its
/// `Dock(belt: 21, ...)` lines, and `belt_12_is_the_long_branch_belt_the_clause_names`
/// below asserts the resolution rather than trusting the convention.
const BELT_12_HANDLE: u64 = 21;

/// The TEE's handle - belt 12's feeder, the machine the bound refuses.
const TEE_HANDLE: u64 = 2;

/// The SOURCE's handle - the first `Place` in the RON, and the node the clause's Timer
/// setting targets.
const SOURCE_HANDLE: u64 = 0;

/// The port a belt admits on. `Belt::step` reads `ctx.take_input(0)` and nothing else,
/// so a belt's whole staging queue lives on port 0.
const BELT_ADMIT_PORT: u16 = 0;

/// The clause's belt-12 pace: 25 px/sec. A tile is 32px and carries `SLOTS_PER_TILE` =
/// 4 slots, so a slot is 8px; at the 62.5 t/s loop, 25 px/sec is 3.125 slots/sec is
/// one slot every 20 ticks.
const CLAUSE_BELT_12_TICKS_PER_SLOT: u32 = 20;

/// The clause's Source cadence: Timer every 2 ticks.
const CLAUSE_SOURCE_INTERVAL: u64 = 2;

/// The clause's two named sample points, verbatim from PILE-03.
const FIRST_SAMPLE_TICK: u64 = 3600;
const SECOND_SAMPLE_TICK: u64 = 6000;

/// The early sample that proves the queue is not a constant. Measured on this board
/// (re-measured by plan 85-08, whose longer demo list seeds to tick 68 and lands the
/// clause's two settings at tick 70): the Tee's second branch's staging inbox reads 0 up
/// to tick 100, 4 at tick 110, 13 at tick 130, and it is pegged at the cap from tick 140
/// onwards. (On the demo before plan 85-08 the same climb ran 0 at tick 60, 5 at 80, 14 at
/// 100 and the cap from 120: the same shape, about thirty ticks earlier.) Tick 90 is taken
/// from BEFORE the climb rather than inside it deliberately - ANY value below the cap
/// satisfies the clause, and the pre-climb reading is the one that cannot be walked into
/// the cap by a few ticks of boot-timing drift. Only a board that saturated its branch
/// within twenty ticks of the settings landing could make this clause vacuous, and that
/// would itself be worth failing on.
const EARLY_SAMPLE_TICK: u64 = 90;

/// The floor the logged injection count must clear across the sampled window. At the
/// clause's interval of 2, the 2400 ticks between the two sample points carry ~1200
/// `ManualInject` events; at the RON's shipped interval of 8 they carry ~300. 1000
/// separates the two by a wide margin, so this reads "the Configure folded AND was
/// projected into the live TimerSet", not merely "some timer is running".
const MIN_INJECTS_IN_WINDOW: usize = 1000;

/// The shipped demo board, booted the way the Tauri shell boots it, plus the
/// throwaway channels `Host::tick_once` requires.
struct DemoBoard {
    _dir: tempfile::TempDir,
    host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    cmd_tx: UnboundedSender<Command>,
    _cmd_rx: UnboundedReceiver<Command>,
    results_rx: UnboundedReceiver<ResultEvent>,
    /// Mint-order handle ledger: dense handle `h` resolves to `minted[h]`.
    minted: Vec<NodeId>,
}

impl DemoBoard {
    /// Genesis -> `seed_scene(demo_commands())` -> `timers_from_log`, the steps
    /// `boot_scene` takes. The timer projection runs strictly AFTER seeding, which is
    /// the shell's own contract: a pre-installed timer fires during the seed ticks and
    /// injects into a half-built grid.
    fn boot() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: DEMO_GENESIS_SEED,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let mut host = Host::new(core, store, ledger, None).expect("open host");
        let minted = seed_scene(&mut host, &demo_commands()).expect("seed the shipped demo scene");
        let timers = timers_from_log(&host).expect("project the demo timers from the seeded log");
        let host = host.with_timers(timers);

        let (_ingress_tx, ingress_rx) = unbounded_channel();
        let (cmd_tx, _cmd_rx) = unbounded_channel();
        let (_results_tx, results_rx) = unbounded_channel();
        Self {
            _dir: dir,
            host,
            ingress_rx,
            cmd_tx,
            _cmd_rx,
            results_rx,
            minted,
        }
    }

    fn handle(&self, h: u64) -> NodeId {
        *self
            .minted
            .get(h as usize)
            .unwrap_or_else(|| panic!("the shipped demo scene minted a node for handle {h}"))
    }

    /// Send ONE gesture down the certified path, fold it on the next tick, then
    /// re-project the live `TimerSet` from the edit-log the way `SimLoop::tick_body`
    /// does after every edit-bearing gesture. Re-projecting here is not decoration:
    /// `set_timers` REPLACES, and a Configure that changed the cadence in the log but
    /// not in the live set is the exact shape of the `demo-timer-wiped-on-first-edit`
    /// bug.
    fn configure(&mut self, cmd: GridCommand) {
        let minted = self.minted.clone();
        apply_gesture(&mut self.host, cmd, |h| minted.get(h as usize).copied())
            .expect("the clause's Configure gesture must be accepted");
        self.tick();
        let timers = timers_from_log(&self.host).expect("re-project timers after the Configure");
        self.host.set_timers(timers);
    }

    fn tick(&mut self) {
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("tick persists");
    }

    /// Advance until the core's tick equals `target`. Sampling happens ON the tick the
    /// clause names, not "about there": belt 12 advances once every 20 ticks under the
    /// clause's pace, so an off-by-a-few sample reads a different phase of the cycle.
    fn run_to(&mut self, target: u64) {
        while self.host.core().tick < target {
            self.tick();
        }
        assert_eq!(
            self.host.core().tick,
            target,
            "run_to must land exactly on its sample tick"
        );
    }

    /// The length of `node`'s staging inbox on the belt admission port.
    fn staged_on(&self, node: NodeId) -> usize {
        self.host
            .core()
            .state
            .inbox_of(node)
            .map_or(0, |i| i.len_on(BELT_ADMIT_PORT))
    }

    fn logged(&self) -> Vec<Event> {
        self.host.logged_events().expect("read the event log")
    }

    /// `Tee.faults`: the copies the Tee's busy branches could not take (phase 87, JAM-02).
    fn tee_faults(&self, node: NodeId) -> u64 {
        match self.host.core().state.node(node) {
            Some(Node::Tee(t)) => t.faults,
            _ => panic!("that handle does not resolve to a Tee"),
        }
    }

    fn belt_pace(&self, node: NodeId) -> u32 {
        match self.host.core().state.node(node) {
            Some(Node::Belt(b)) => b.ticks_per_slot.get(),
            _ => panic!("that handle does not resolve to a Belt"),
        }
    }
}

/// PILE-03, second clause: belt 12's staging inbox is the SAME LENGTH at tick 3600 and
/// tick 6000 on the shipped demo board at the settings the clause names.
#[test]
fn demo_belt_12_staging_inbox_is_level_between_tick_3600_and_6000() {
    let mut board = DemoBoard::boot();
    let belt12 = board.handle(BELT_12_HANDLE);
    let tee = board.handle(TEE_HANDLE);
    let source = board.handle(SOURCE_HANDLE);

    // ── The clause's two settings, applied as ordinary user gestures ─────────
    board.configure(GridCommand::Configure {
        node: BELT_12_HANDLE,
        config: MachineConfig::Belt {
            ticks_per_slot: CLAUSE_BELT_12_TICKS_PER_SLOT,
        },
    });
    board.configure(GridCommand::Configure {
        node: SOURCE_HANDLE,
        config: MachineConfig::Source {
            trigger: SourceTrigger::Timer {
                interval_ticks: CLAUSE_SOURCE_INTERVAL,
            },
        },
    });

    // ── Trap 1a: the belt Configure really FOLDED ────────────────────────────
    let pace = board.belt_pace(belt12);
    assert_eq!(
        pace, CLAUSE_BELT_12_TICKS_PER_SLOT,
        "the belt-pace Configure must FOLD: belt 12 is running at {pace} ticks/slot, not \
         the clause's {CLAUSE_BELT_12_TICKS_PER_SLOT} (25 px/sec). At the shipped default \
         of 2 the long branch keeps up with the Source and NOTHING stages anywhere, so \
         every assertion below would read 0 == 0 and prove nothing."
    );

    board.run_to(EARLY_SAMPLE_TICK);
    let early = board.staged_on(belt12);

    board.run_to(FIRST_SAMPLE_TICK);
    let at_3600 = board.staged_on(belt12);
    let tee_at_3600 = board.staged_on(tee);
    let busy_at_3600 = board.tee_faults(tee);

    board.run_to(SECOND_SAMPLE_TICK);
    let at_6000 = board.staged_on(belt12);
    let tee_at_6000 = board.staged_on(tee);
    let busy_at_6000 = board.tee_faults(tee);
    eprintln!(
        "PILE-03 demo: belt12 staging early={early} 3600={at_3600} 6000={at_6000}; tee inbox \
         3600={tee_at_3600} 6000={tee_at_6000}; Tee.faults 3600={busy_at_3600} 6000={busy_at_6000}"
    );

    // ── THE CLAUSE ───────────────────────────────────────────────────────────
    assert_eq!(
        at_3600, at_6000,
        "PILE-03, SECOND CLAUSE: belt 12's staging inbox must hold the SAME NUMBER of \
         items at tick {FIRST_SAMPLE_TICK} and tick {SECOND_SAMPLE_TICK} on the shipped \
         demo board. Measured {at_3600} then {at_6000}. Before this phase the same probe \
         read 22 then 72 - monotone growth in a queue the render packet never draws. If \
         this has reddened, a feeder is admitting past `MECHANICAL_INBOX_CAP` again and \
         the invisible pile is back on the board every user sees."
    );

    // ── Trap 1b: the Source Configure FOLDED and was PROJECTED ───────────────
    let injects = board
        .logged()
        .iter()
        .filter(|e| {
            e.tick >= FIRST_SAMPLE_TICK
                && e.tick < SECOND_SAMPLE_TICK
                && matches!(e.payload, EventPayload::ManualInject { target, .. } if target == source)
        })
        .count();
    assert!(
        injects >= MIN_INJECTS_IN_WINDOW,
        "the Source-cadence Configure must FOLD and be re-projected into the live \
         TimerSet: only {injects} logged injections between ticks {FIRST_SAMPLE_TICK} and \
         {SECOND_SAMPLE_TICK} (expected >= {MIN_INJECTS_IN_WINDOW} at the clause's \
         interval of {CLAUSE_SOURCE_INTERVAL}; the RON's shipped interval of 8 would give \
         ~300). A board fed at the shipped cadence is not the board the clause measures."
    );

    // ── Trap 2: it is the BOUND holding the queue level, not a light load ────
    assert_eq!(
        at_3600, MECHANICAL_INBOX_CAP,
        "NON-VACUITY: belt 12's staging inbox is level at {at_3600}, but that is not \
         `MECHANICAL_INBOX_CAP` ({MECHANICAL_INBOX_CAP}). A level queue below the cap is a \
         board in equilibrium, not a board being REFUSED, and this clause is about the \
         refusal. Either the cap moved (golden 0030 pins its value - move that first) or \
         the demo board no longer saturates its long branch at 25 px/sec."
    );
    assert_eq!(
        at_6000, MECHANICAL_INBOX_CAP,
        "NON-VACUITY: same as above at tick {SECOND_SAMPLE_TICK} (read {at_6000})"
    );

    // ── Trap 3: the value is not a constant this test could never see move ───
    assert!(
        early < at_3600,
        "NON-VACUITY: belt 12's staging inbox reads {early} at tick {EARLY_SAMPLE_TICK} and \
         {at_3600} at tick {FIRST_SAMPLE_TICK} - it did not GROW between them. If this \
         value were the same at every tick then the equality at {FIRST_SAMPLE_TICK} / \
         {SECOND_SAMPLE_TICK} would be a check that cannot fail, which is the one thing \
         this file must never become."
    );

    // ── Trap 4: the refusal reached the feeder, and is ACCOUNTED ─────────────
    //
    // PHASE 87 (JAM-02, 87-CONTEXT D-03) re-pinned this trap. Until then it asserted the
    // Tee's own inbox backed up (> 0 at both points), because one full branch stopped the
    // whole Tee; that stop was the defect WINDOWS 174 measured, and phase 87 removed it.
    // The Tee is now refused PER BRANCH: belt 12 still refuses every copy past its bound
    // (the clause above), the Tee counts each refused copy on `Tee.faults` as a
    // `BranchBusy` fault instead of stopping, and its short branch keeps its pace. So the
    // feeder is graded on both halves of that: it was refused (the count grew by more
    // copies than belt 12 could have taken in the window, so the bound was hit on most of
    // the Tee's steps rather than a few), and it did not stop (its inbox is below the cap).
    // Measured at plan 87-05: Tee.faults 1464 at tick 3600 and 2479 at tick 6000, the Tee's
    // inbox 0 at both; under the old gate the count reads 0 and this reddens.
    let refused_in_window = busy_at_6000 - busy_at_3600;
    let belt_12_intake_bound =
        (SECOND_SAMPLE_TICK - FIRST_SAMPLE_TICK) / u64::from(CLAUSE_BELT_12_TICKS_PER_SLOT);
    assert!(
        refused_in_window > belt_12_intake_bound,
        "PILE-03 names the feeder, not just the queue: with belt 12's staging inbox at its \
         bound the TEE must be REFUSED on that branch, and since phase 87 every refused copy \
         is counted on Tee.faults. It counted {refused_in_window} between {FIRST_SAMPLE_TICK} \
         and {SECOND_SAMPLE_TICK}, not more than the {belt_12_intake_bound} belt 12 could \
         have taken at its pace. A bounded belt whose feeder neither stops nor counts what it \
         could not deliver is a bound that DROPPED items instead of refusing them."
    );
    assert!(
        tee_at_3600 < MECHANICAL_INBOX_CAP && tee_at_6000 < MECHANICAL_INBOX_CAP,
        "JAM-02 on the shipped board: one slowed branch must not stop the Tee, so its inbox \
         stays below the cap. It read {tee_at_3600} at {FIRST_SAMPLE_TICK} and \
         {tee_at_6000} at {SECOND_SAMPLE_TICK}."
    );
}

/// The handle convention is ASSERTED, not assumed: the clause's belt really is the TEE's
/// second branch, the 3-tile audit copy belt from (11,4) to (13,4) (plan 85-08). Without this, a future edit to
/// `demo_scene.board.ron`'s command order would silently repoint the test above at a
/// different belt and it would keep passing while measuring the wrong queue.
#[test]
fn belt_12_is_the_long_branch_belt_the_clause_names() {
    let board = DemoBoard::boot();
    let belt12 = board.handle(BELT_12_HANDLE);

    let Some(Node::Belt(belt)) = board.host.core().state.node(belt12) else {
        panic!("demo handle {BELT_12_HANDLE} must resolve to a Belt");
    };
    assert_eq!(
        belt.tiles, 3,
        "the Tee's second branch is the 3-tile audit copy run authored at `demo_scene.board.ron`'s \
         fourth DrawBelt; handle {BELT_12_HANDLE} resolved to a {}-tile belt instead, so the \
         mint-order convention has drifted and the clause above is measuring the wrong \
         queue",
        belt.tiles
    );
    assert_eq!(
        belt.geometry.first().map(|t| t.cell),
        Some((11, 4)),
        "the Tee's second branch starts at (11,4), east of the TEE"
    );
    assert_eq!(
        belt.geometry.last().map(|t| t.cell),
        Some((13, 4)),
        "the Tee's second branch ends at (13,4), facing the Audit sink's W-facing In"
    );
    assert_eq!(
        board.belt_pace(belt12),
        fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT.get(),
        "and it ships at the DEFAULT pace, not the clause's 25 px/sec - the record that \
         the clause's settings are imposed by the test above rather than authored in \
         `examples/boards/demo_scene.board.ron`"
    );
}
