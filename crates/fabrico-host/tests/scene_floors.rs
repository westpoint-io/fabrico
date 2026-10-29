//! EX-03 BREATHING-ROOM FLOORS: "spaced for legibility" as CHECKABLE DATA over
//! ALL THREE shipped RON scenes (`scenes/demo_scene.ron`, `scenes/order_processing.ron`,
//! `scenes/advanced.ron`). A shipped scene this file does not enumerate is not checked,
//! so a new Examples entry must be enrolled here.
//!
//! The UI-SPEC's Breathing-Room Contract states five floors. They are FLOORS, not a
//! layout algorithm (UI-SPEC assumption A8: CONTEXT bars a rigid numeric grid rule),
//! and they deliberately do NOT try to automate the judgment half - a layout that
//! passes every floor here can still read badly on the real binary, which is what the
//! phase's own screenshot evidence and the FEEL-KIT walk are for.
//!
//! | Floor | Statement |
//! |-------|-----------|
//! | 1 | Every drawn belt run is >= 2 cells (a 1-cell belt reads as a smudge under the locked Direction B dash) |
//! | 2 | No two machine footprints share an edge: >= 1 empty cell on the axis they overlap (diagonal corner contact permitted) |
//! | 3 | Parallel belt CORRIDORS keep >= 2 empty rows (>= 3 row delta) at every shared column |
//! | 4 | Net flow is left-to-right: stage anchors strictly increase, and no belt runs net-backwards |
//! | 5 | The machine bounding box fits within 30 x 14 cells (fit-to-factory legibility) |
//! | 6 | No belt doubles back: once it steps one way along an axis it never steps the other way (plan 85-10, D-25) |
//!
//! Floor 6 is not in the UI-SPEC's contract; phase 85 added it (D-25) after the PR #2 review
//! found two Advanced belts that jogged west before their final eastward run. It was measured
//! red on exactly those two belts (17 and 21) before the Advanced re-layout turned it green.
//!
//! # Labels (plan 85-08, D-17)
//! A label is a note on the board, not a machine: it is exempt from floor 2 (it may sit
//! beside what it names) and from floor 4's stages (it carries nothing), but it counts in
//! floor 5's box because fit-to-factory frames it, and it must never cover a machine or a
//! belt ([`label_overlaps`]).
//!
//! # Geometry is DERIVED, never re-typed
//! Footprints come from [`port_catalog`] (the single source of per-kind dims), grown
//! by [`grow_to_fit`] for any `AddPort` the scene folds, rotated by the same
//! `(old_rot + if ccw {3} else {1}) & 3` rule the command layer applies, and expanded
//! by the core's own [`cells_of_footprint`]. Nothing in this file hardcodes a `w x h`,
//! so a catalog change reddens these tests instead of silently invalidating them.
//!
//! # Fail-first provenance (55-04)
//! This checker was authored and run BEFORE the demo re-space, and it was RED on
//! exactly the floor-2 pair the UI-SPEC names: `MERGE @ (22,2)` 2x2 sitting flush on
//! `SINK @ (22,4)`. The re-space (a pure data edit moving that sink one row south)
//! turned it green. A floor checker authored green would prove nothing.

use fabrico_command::command::port_catalog;
use fabrico_core::state::{Footprint, Medium, Port, Role, Side, cells_of_footprint, grow_to_fit};
use fabrico_host::demo_scene::{SceneId, demo_commands, order_commands};
use fabrico_protocol::{BeltEnd, GridCommand, MachineConfig, machine_kind, port_role};

// ── The floor constants (UI-SPEC Breathing-Room Contract) ────────────────────

/// Floor 1: the minimum drawn-belt run length. Under the locked Direction B belt
/// (10/6 centreline dash) a single cell reads as a smudge; two cells march.
const MIN_BELT_RUN: usize = 2;

/// Floor 2: the minimum empty-cell gap between two machine footprints on the axis
/// where their other axis overlaps. `1` = "they must not share an edge".
const MIN_MACHINE_GAP: i32 = 1;

/// Floor 3: the minimum row delta between two parallel belt corridors that share a
/// column. `3` == ">= 2 empty rows between them".
const MIN_CORRIDOR_ROW_DELTA: i32 = 3;

/// Floor 3: the minimum collinear cell count for a horizontal belt run to count as a
/// CORRIDOR. This threshold IS the "past the splitter mouth" exclusion the UI-SPEC
/// asks for, expressed as a data property rather than as a magic column number: at a
/// fan-out mouth the two tails are forced 1 row apart by port seating and must both
/// exit toward their port's facing side, so each produces a 2-cell stub before it
/// jogs away. A 2-cell stub is a fork, not a corridor; only where the branches
/// actually RUN IN PARALLEL (the UI-SPEC's own wording) does the separation floor
/// bite. See [`order_branch_corridors_stay_separable`] for the belt-pair form of the
/// same rule, which derives the mouth zone from the splitter's footprint directly.
const MIN_CORRIDOR_RUN: usize = 3;

/// Floor 5: the soft bounding-box ceiling, in cells.
const MAX_BOX_W: i32 = 30;
/// Floor 5: the soft bounding-box ceiling, in cells.
const MAX_BOX_H: i32 = 14;

// ── Scene parsing (commands -> geometry) ─────────────────────────────────────

/// One placed machine, resolved to its live footprint.
#[derive(Clone, Debug)]
struct Machine {
    /// The dense mint-order handle the RON's `Dock`/`Rotate`/`AddPort` lines target.
    handle: u64,
    kind: u8,
    anchor: (i32, i32),
    foot: Footprint,
    /// The port list as grown by `AddPort` (drives [`grow_to_fit`]).
    ports: Vec<Port>,
}

impl Machine {
    /// The occupied rectangle, with rotation applied (odd `rot` swaps w/h).
    fn rect(&self) -> Rect {
        Rect::of_cells(cells_of_footprint(
            self.anchor,
            self.foot.w,
            self.foot.h,
            self.foot.rot,
        ))
        .expect("a placed machine always claims at least one cell")
    }

    fn label(&self) -> String {
        let r = self.rect();
        format!(
            "{}#{} @({},{}) [x{}..{}, y{}..{}]",
            kind_name(self.kind),
            self.handle,
            self.anchor.0,
            self.anchor.1,
            r.x0,
            r.x1,
            r.y0,
            r.y1
        )
    }
}

/// One drawn belt, as authored.
#[derive(Clone, Debug)]
struct Belt {
    handle: u64,
    cells: Vec<(i32, i32)>,
}

/// A parsed scene: machines, labels and belts in mint order, and every Dock. Since plan
/// 85-08 every node on a shipped board is a command (the demo's Route and HTTP Handler
/// included), so this is the whole board; there is no second, out-of-list node set.
#[derive(Clone, Debug)]
struct Scene {
    name: &'static str,
    machines: Vec<Machine>,
    /// Label nodes (kind 11), resized by their `Configure(Label)` as the fold does.
    labels: Vec<Machine>,
    belts: Vec<Belt>,
    /// Every `Dock` as `(belt, endpoint, node)`, for the topology checks.
    docks: Vec<(u64, BeltEnd, u64)>,
}

impl Scene {
    fn machine(&self, handle: u64) -> &Machine {
        self.machines
            .iter()
            .find(|m| m.handle == handle)
            .unwrap_or_else(|| panic!("{}: no machine at handle {handle}", self.name))
    }

    fn belt(&self, handle: u64) -> &Belt {
        self.belts
            .iter()
            .find(|b| b.handle == handle)
            .unwrap_or_else(|| panic!("{}: no belt at handle {handle}", self.name))
    }
}

fn kind_name(kind: u8) -> &'static str {
    match kind {
        machine_kind::SOURCE => "SOURCE",
        machine_kind::FACTORY => "FACTORY",
        machine_kind::TEE => "TEE",
        machine_kind::BALANCER => "BALANCER",
        machine_kind::ROUTER => "ROUTER",
        machine_kind::MERGE => "MERGE",
        machine_kind::SINK => "SINK",
        machine_kind::ENDPOINT => "ENDPOINT",
        // The demo's HTTP Handler is placed by a logged `Place(kind: 10)` since plan 85-08.
        machine_kind::HANDLER => "HANDLER",
        machine_kind::LABEL => "LABEL",
        other => panic!("a shipped scene placed an unexpected machine kind {other}"),
    }
}

/// The core `Role` a wire role byte denotes (the `AddPort` command's `role` field).
fn role_of(byte: u8) -> Role {
    match byte {
        port_role::IN => Role::In,
        port_role::OUT => Role::Out,
        port_role::FAULT => Role::Fault,
        other => panic!("a shipped scene authored an unknown AddPort role byte {other}"),
    }
}

/// Fold a scene's command list into geometry, applying the SAME resolution rules the
/// command layer applies: dense handles mint monotonic from 0 in mint order (machines
/// in `Place` order, then belts in `DrawBelt` order); `Rotate` is a relative
/// quarter-turn; `AddPort` appends a port and re-sizes via [`grow_to_fit`].
fn parse_scene(name: &'static str, commands: &[GridCommand]) -> Scene {
    let mut machines: Vec<Machine> = Vec::new();
    let mut labels: Vec<Machine> = Vec::new();
    let mut belts: Vec<Belt> = Vec::new();
    let mut docks: Vec<(u64, BeltEnd, u64)> = Vec::new();
    let mut next_handle: u64 = 0;

    for cmd in commands {
        match cmd {
            GridCommand::Place {
                kind,
                cell_x,
                cell_y,
            } => {
                let (foot, ports) = port_catalog(*kind);
                let placed = Machine {
                    handle: next_handle,
                    kind: *kind,
                    anchor: (*cell_x, *cell_y),
                    foot,
                    ports,
                };
                if *kind == machine_kind::LABEL {
                    labels.push(placed);
                } else {
                    machines.push(placed);
                }
                next_handle += 1;
            }
            GridCommand::DrawBelt { cells } => {
                belts.push(Belt {
                    handle: next_handle,
                    cells: cells.clone(),
                });
                next_handle += 1;
            }
            // A cable (63-02) claims NO cell - its route is drawn over the board, never
            // claimed - but it MINTS a `Node::Wire`, and a minted node takes the next
            // dense handle (`GridView::apply_tick` gives one to every id in
            // `last_tick.placed`). A DrawWire joining a Route and an HTTP Handler mints
            // TWO, the request and its reply leg (phase 72, D-04). So it advances the
            // handle counter and nothing else; a wrong count would shift every later
            // machine and belt and match the wrong node (plan 85-08).
            GridCommand::DrawWire { from_node, to_node, .. } => {
                let kind_of = |h: u64| machines.iter().find(|m| m.handle == h).map(|m| m.kind);
                let pair = [kind_of(*from_node), kind_of(*to_node)];
                let paired = pair.contains(&Some(machine_kind::ENDPOINT))
                    && pair.contains(&Some(machine_kind::HANDLER));
                next_handle += if paired { 2 } else { 1 };
            }
            GridCommand::Rotate { node, ccw } => {
                let m = machines
                    .iter_mut()
                    .find(|m| m.handle == *node)
                    .unwrap_or_else(|| panic!("{name}: Rotate targets unminted handle {node}"));
                // The command layer's exact relative -> absolute resolution.
                m.foot.rot = (m.foot.rot + if *ccw { 3 } else { 1 }) & 3;
            }
            GridCommand::AddPort {
                node, role, medium, ..
            } => {
                let m = machines
                    .iter_mut()
                    .find(|m| m.handle == *node)
                    .unwrap_or_else(|| panic!("{name}: AddPort targets unminted handle {node}"));
                // `local_offset`/`side` are placeholders: the fold re-seats the WHOLE
                // port list as a pure function of list position, and only the ROLE
                // multiset feeds `grow_to_fit`.
                m.ports.push(Port {
                    local_offset: (0, 0),
                    side: Side::E,
                    role: role_of(*role),
                    medium: if *medium == 0 {
                        Medium::Mechanical
                    } else {
                        Medium::Electrical
                    },
                });
                let base = port_catalog(m.kind).0;
                let grown = grow_to_fit(base, &m.ports);
                m.foot = Footprint {
                    w: grown.w,
                    h: grown.h,
                    rot: m.foot.rot,
                };
            }
            // A label's Configure carries its size (phase 76): the fold resizes the label's
            // footprint to `w x h` from its anchor, so the parse does too.
            GridCommand::Configure {
                node,
                config: MachineConfig::Label { w, h, .. },
            } => {
                let l = labels
                    .iter_mut()
                    .find(|l| l.handle == *node)
                    .unwrap_or_else(|| panic!("{name}: a Label Configure targets non-label handle {node}"));
                l.foot = Footprint { w: *w, h: *h, rot: l.foot.rot };
            }
            GridCommand::Dock { belt, endpoint, node, .. } => docks.push((*belt, *endpoint, *node)),
            // Unlink removes a link (63-05), and every other Configure edits a machine
            // BODY: neither moves a cell or mints a node.
            GridCommand::Unlink { .. } | GridCommand::Configure { .. } => {}
            // GEOMETRY-CHANGING and NOT modelled here (WR-05). The old wildcard
            // claimed all four of Dock/Configure/Delete/RemovePort "carry no
            // geometry", which is false for two of them: a Delete frees a
            // machine's or belt's cells, and a RemovePort SHRINKS a footprint
            // through the same `grow_to_fit` path `AddPort` grows it through.
            // Undo/Redo replay either. A scene that authored one would have every
            // floor below validated against a PHANTOM layout, silently, so fail
            // loudly instead of measuring the wrong board.
            GridCommand::Delete { .. }
            | GridCommand::RemovePort { .. }
            | GridCommand::Undo
            | GridCommand::Redo => panic!(
                "{name}: authored a geometry-changing command parse_scene does not model \
                 ({cmd:?}) - the breathing-room floors would validate a phantom layout"
            ),
            // NOTE: this match is deliberately EXHAUSTIVE (no `_` arm), so a new
            // GridCommand variant is a COMPILE error here rather than a silently
            // absorbed geometry change - the header's own stated contract that a
            // catalog change reddens these tests instead of invalidating them.
        }
    }

    Scene {
        name,
        machines,
        labels,
        belts,
        docks,
    }
}

/// The demo scene: its command list, the Route and HTTP Handler included (plan 85-08).
fn demo_scene() -> Scene {
    parse_scene("demo_scene.ron", &demo_commands())
}

fn order_scene() -> Scene {
    parse_scene("order_processing.ron", &order_commands())
}

fn advanced_scene() -> Scene {
    parse_scene(
        "advanced.ron",
        &SceneId::Advanced
            .commands()
            .expect("the embedded advanced RON parses"),
    )
}

// ── Rect + gap algebra ───────────────────────────────────────────────────────

/// An inclusive cell rectangle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

impl Rect {
    fn of_cells(cells: impl IntoIterator<Item = (i32, i32)>) -> Option<Self> {
        let mut it = cells.into_iter();
        let (fx, fy) = it.next()?;
        let mut r = Rect {
            x0: fx,
            y0: fy,
            x1: fx,
            y1: fy,
        };
        for (x, y) in it {
            r.x0 = r.x0.min(x);
            r.x1 = r.x1.max(x);
            r.y0 = r.y0.min(y);
            r.y1 = r.y1.max(y);
        }
        Some(r)
    }

    /// Empty cells between the two x ranges. NEGATIVE when the ranges overlap, `0`
    /// when they are flush (share an edge), `>= 1` when separated.
    fn gap_x(self, o: Self) -> i32 {
        (o.x0 - self.x1 - 1).max(self.x0 - o.x1 - 1)
    }

    /// Empty cells between the two y ranges - see [`Rect::gap_x`].
    fn gap_y(self, o: Self) -> i32 {
        (o.y0 - self.y1 - 1).max(self.y0 - o.y1 - 1)
    }
}

// ── The five floors ──────────────────────────────────────────────────────────

/// FLOOR 1 - visible belt runs: every drawn belt is at least [`MIN_BELT_RUN`] cells.
fn floor_1_violations(scene: &Scene) -> Vec<String> {
    scene
        .belts
        .iter()
        .filter(|b| b.cells.len() < MIN_BELT_RUN)
        .map(|b| {
            format!(
                "belt#{} is {} cell(s) long ({:?}); floor 1 needs >= {MIN_BELT_RUN}",
                b.handle,
                b.cells.len(),
                b.cells
            )
        })
        .collect()
}

/// FLOOR 2 - no adjacent-cell machine walls.
///
/// For every pair: if their x ranges overlap they must be separated on y by at least
/// [`MIN_MACHINE_GAP`] empty rows, and symmetrically for y. Diagonal CORNER contact
/// (both gaps exactly `0`) is permitted by the UI-SPEC and passes. An actual
/// intersection is structurally impossible (the command layer rejects a colliding
/// placement) but is reported loudly if a scene ever authors one.
///
/// Runs over every placed machine, the demo's Route and HTTP Handler included: they are
/// ordinary `Place` commands since plan 85-08 (WR-06 carried them as a separate seeded
/// set until then, because a re-space edge-flush with one of them used to report green).
fn floor_2_violations(scene: &Scene) -> Vec<String> {
    let all: Vec<&Machine> = scene.machines.iter().collect();
    let mut out = Vec::new();
    for (i, a) in all.iter().enumerate() {
        for b in &all[i + 1..] {
            let (ra, rb) = (a.rect(), b.rect());
            let (gx, gy) = (ra.gap_x(rb), ra.gap_y(rb));
            if gx < 0 && gy < 0 {
                out.push(format!(
                    "{} INTERSECTS {} (overlapping footprints)",
                    a.label(),
                    b.label()
                ));
            } else if gx < 0 && gy < MIN_MACHINE_GAP {
                out.push(format!(
                    "{} shares an edge with {}: x ranges overlap and the row gap is {gy} \
                     (floor 2 needs >= {MIN_MACHINE_GAP} empty row)",
                    a.label(),
                    b.label()
                ));
            } else if gy < 0 && gx < MIN_MACHINE_GAP {
                out.push(format!(
                    "{} shares an edge with {}: y ranges overlap and the column gap is {gx} \
                     (floor 2 needs >= {MIN_MACHINE_GAP} empty column)",
                    a.label(),
                    b.label()
                ));
            }
        }
    }
    out
}

/// A maximal horizontal run of collinear belt cells that is long enough to read as a
/// CORRIDOR (see [`MIN_CORRIDOR_RUN`]).
#[derive(Clone, Copy, Debug)]
struct Corridor {
    belt: u64,
    y: i32,
    x0: i32,
    x1: i32,
}

/// Every corridor in the scene, in belt mint order.
fn corridors(scene: &Scene) -> Vec<Corridor> {
    let mut out = Vec::new();
    for b in &scene.belts {
        // Walk the authored cell path and cut it into maximal same-row runs.
        let mut run: Vec<(i32, i32)> = Vec::new();
        let flush = |run: &mut Vec<(i32, i32)>, out: &mut Vec<Corridor>| {
            if run.len() >= MIN_CORRIDOR_RUN {
                let xs: Vec<i32> = run.iter().map(|c| c.0).collect();
                out.push(Corridor {
                    belt: b.handle,
                    y: run[0].1,
                    x0: *xs.iter().min().expect("non-empty run"),
                    x1: *xs.iter().max().expect("non-empty run"),
                });
            }
            run.clear();
        };
        for &cell in &b.cells {
            match run.last() {
                // Same row AND orthogonally adjacent: the run continues.
                Some(&(px, py)) if py == cell.1 && (px - cell.0).abs() == 1 => run.push(cell),
                Some(_) => {
                    flush(&mut run, &mut out);
                    run.push(cell);
                }
                None => run.push(cell),
            }
        }
        flush(&mut run, &mut out);
    }
    out
}

/// FLOOR 3 - branch separability: two corridors that share a column must be at least
/// [`MIN_CORRIDOR_ROW_DELTA`] rows apart (>= 2 empty rows between them).
fn floor_3_violations(scene: &Scene) -> Vec<String> {
    let cs = corridors(scene);
    let mut out = Vec::new();
    for (i, a) in cs.iter().enumerate() {
        for b in &cs[i + 1..] {
            let shares_column = a.x0 <= b.x1 && b.x0 <= a.x1;
            let delta = (a.y - b.y).abs();
            if shares_column && delta < MIN_CORRIDOR_ROW_DELTA {
                out.push(format!(
                    "corridor belt#{} (y{}, x{}..{}) runs {delta} row(s) from corridor belt#{} \
                     (y{}, x{}..{}) over shared columns; floor 3 needs >= \
                     {MIN_CORRIDOR_ROW_DELTA}",
                    a.belt, a.y, a.x0, a.x1, b.belt, b.y, b.x0, b.x1
                ));
            }
        }
    }
    out
}

/// FLOOR 4 (per-belt half) - no belt runs NET backwards: its last cell is never west
/// of its first. Vertical jogs are for branching; the locked belt's march must not be
/// the only direction cue a reader has.
fn floor_4_belt_violations(scene: &Scene) -> Vec<String> {
    scene
        .belts
        .iter()
        .filter_map(|b| {
            let (first, last) = (*b.cells.first()?, *b.cells.last()?);
            (last.0 < first.0).then(|| {
                format!(
                    "belt#{} runs net-backwards: tail ({},{}) -> head ({},{})",
                    b.handle, first.0, first.1, last.0, last.1
                )
            })
        })
        .collect()
}

/// FLOOR 4 (stage half) - each pipeline stage's anchor x strictly increases along the
/// flow. `stages` is the scene's flow order as mint-order handles.
fn floor_4_stage_violations(scene: &Scene, stages: &[&[u64]]) -> Vec<String> {
    let mut out = Vec::new();
    for w in stages.windows(2) {
        let (lhs, rhs) = (w[0], w[1]);
        let lhs_max = lhs
            .iter()
            .map(|h| scene.machine(*h).anchor.0)
            .max()
            .expect("a stage is never empty");
        let rhs_min = rhs
            .iter()
            .map(|h| scene.machine(*h).anchor.0)
            .min()
            .expect("a stage is never empty");
        if lhs_max >= rhs_min {
            out.push(format!(
                "stage {lhs:?} reaches anchor x={lhs_max} but the next stage {rhs:?} starts at \
                 x={rhs_min}; floor 4 needs strictly increasing stage anchors"
            ));
        }
    }
    out
}

/// FLOOR 5 - the machine bounding box fits the fit-to-factory ceiling, measured over
/// every placed node, labels included: fit-to-factory frames what the user SEES.
fn floor_5_violations(scene: &Scene) -> Vec<String> {
    let cells: Vec<(i32, i32)> = scene
        .machines
        .iter()
        .chain(&scene.labels)
        .flat_map(|m| cells_of_footprint(m.anchor, m.foot.w, m.foot.h, m.foot.rot))
        .collect();
    let r = Rect::of_cells(cells).expect("a shipped scene always places a machine");
    let (w, h) = (r.x1 - r.x0 + 1, r.y1 - r.y0 + 1);
    if w > MAX_BOX_W || h > MAX_BOX_H {
        vec![format!(
            "machine bounding box is {w} x {h} (x{}..{}, y{}..{}); floor 5 ceiling is \
             {MAX_BOX_W} x {MAX_BOX_H}",
            r.x0, r.x1, r.y0, r.y1
        )]
    } else {
        Vec::new()
    }
}

/// FLOOR 6 (plan 85-10, D-25) - no belt doubles back: once a belt's path has stepped one way
/// along an axis, it never steps the opposite way along that axis. A belt that runs east,
/// drops south and then jogs west before running east again reads as a tangle at fit zoom
/// even though floor 4 (its last cell is not west of its first) passes it. Each violation
/// names the scene, the belt and the two cells of the step that turned back. Every shipped
/// belt is measured: a kink is fixed in the scene, never waved through here.
fn floor_6_violations(scene: &Scene) -> Vec<String> {
    let mut out = Vec::new();
    for b in &scene.belts {
        // The sign of the first step taken along each axis (0 until the belt moves on it).
        let (mut dir_x, mut dir_y) = (0i32, 0i32);
        for pair in b.cells.windows(2) {
            let (from, to) = (pair[0], pair[1]);
            let (dx, dy) = ((to.0 - from.0).signum(), (to.1 - from.1).signum());
            for (axis, step, dir) in [("x", dx, &mut dir_x), ("y", dy, &mut dir_y)] {
                if step == 0 {
                    continue;
                }
                if *dir == 0 {
                    *dir = step;
                } else if *dir != step {
                    out.push(format!(
                        "{}: belt#{} doubles back on {axis}: ({},{}) -> ({},{}) steps {} after \
                         the belt already stepped {}",
                        scene.name,
                        b.handle,
                        from.0,
                        from.1,
                        to.0,
                        to.1,
                        if step > 0 { "+" } else { "-" },
                        if *dir > 0 { "+" } else { "-" },
                    ));
                }
            }
        }
    }
    out
}

/// THE LABEL ARM (plan 85-08, D-17): no label cell is a machine cell or a belt tile, and no
/// two labels share a cell. A label may sit flush beside what it names (floor 2 exempts it).
fn label_overlaps(scene: &Scene) -> Vec<String> {
    let cells_of = |m: &Machine| cells_of_footprint(m.anchor, m.foot.w, m.foot.h, m.foot.rot).collect::<Vec<_>>();
    let mut out = Vec::new();
    for (i, l) in scene.labels.iter().enumerate() {
        let lc = cells_of(l);
        for m in &scene.machines {
            if cells_of(m).iter().any(|c| lc.contains(c)) {
                out.push(format!("{} covers {}", l.label(), m.label()));
            }
        }
        for b in &scene.belts {
            if b.cells.iter().any(|c| lc.contains(c)) {
                out.push(format!("{} covers belt#{}", l.label(), b.handle));
            }
        }
        for o in &scene.labels[i + 1..] {
            if cells_of(o).iter().any(|c| lc.contains(c)) {
                out.push(format!("{} overlaps {}", l.label(), o.label()));
            }
        }
    }
    out
}

/// How a scene's flow is shaped, for floor 4's STAGE half (WR-04).
///
/// This used to be a bare `&[&[u64]]`, and the demo passed a ONE-element slice.
/// `floor_4_stage_violations` iterates `stages.windows(2)`, which is empty for a
/// single element, so the stage half executed ZERO comparisons for the demo while
/// `assert_floors` still reported "passes all floors". Making the two shapes
/// distinct variants means a scene must SAY which it is, and the runner then
/// reports only the floors it actually ran.
#[derive(Clone, Copy, Debug)]
enum StageFlow<'a> {
    /// A staged pipeline: floor 4's stage half compares consecutive stages. At
    /// least two stages, or there is nothing to compare.
    Staged(&'a [&'a [u64]]),
}

/// Run the shared floors and panic with EVERY violation listed (not just the first) -
/// a re-space wants the whole list in one run, not a one-at-a-time whack-a-mole.
///
/// `want_machines` / `want_belts` are an ANTI-VACUITY CENSUS (WR-04). Floors 1, 3
/// and 4-belt iterate collections; floors 2 and 4-stage iterate pairs/windows. A
/// scene that parsed to zero belts, or to one machine, would sail through nearly
/// all of them while `assert_floors` still reported a pass. Pinning the counts is
/// the same `checked > 0` / `files > 0` discipline this file and
/// `fabrico-app`'s `granted_permissions` already use elsewhere; it just was not
/// applied to the shared runner.
///
/// The panic message names the floors that ACTUALLY RAN, so it can never again
/// claim coverage the scene's shape does not admit.
fn assert_floors(scene: &Scene, flow: StageFlow<'_>, want_machines: usize, want_belts: usize) {
    // ── Census first: an empty/short parse makes every floor below vacuous. ──
    assert_eq!(
        scene.machines.len(),
        want_machines,
        "{}: the parse yielded {} command-placed machines, not the expected {want_machines} - \
         the floor checks below would be measuring a different board",
        scene.name,
        scene.machines.len()
    );
    assert_eq!(
        scene.belts.len(),
        want_belts,
        "{}: the parse yielded {} belts, not the expected {want_belts} - floors 1, 3 and \
         4-belt iterate the belt list and would be vacuous",
        scene.name,
        scene.belts.len()
    );

    let mut ran = vec![
        "1 (belt run length)",
        "2 (machine gaps)",
        "labels (cover no machine, belt or label)",
        "3 (corridor separation)",
        "4-belt (no net-backwards run)",
        "5 (bounding box)",
        "6 (no belt doubles back)",
    ];
    let mut violations = Vec::new();
    violations.extend(floor_1_violations(scene));
    violations.extend(floor_2_violations(scene));
    violations.extend(floor_3_violations(scene));
    violations.extend(floor_4_belt_violations(scene));
    violations.extend(floor_5_violations(scene));
    violations.extend(floor_6_violations(scene));
    violations.extend(label_overlaps(scene));

    let StageFlow::Staged(stages) = flow;
    assert!(
        stages.len() >= 2,
        "{}: a Staged scene must declare >= 2 stages or floor 4's stage half is a \
         silent no-op (windows(2) over {} stage(s) compares nothing)",
        scene.name,
        stages.len()
    );
    violations.extend(floor_4_stage_violations(scene, stages));
    ran.push("4-stage (strictly increasing stage anchors)");

    assert!(
        violations.is_empty(),
        "{} violates the EX-03 breathing-room floors [{}]:\n  - {}",
        scene.name,
        ran.join(", "),
        violations.join("\n  - ")
    );
}

// ── The scene tests ──────────────────────────────────────────────────────────

/// The order scene's flow stages, in mint-order handles: webhook Source -> the
/// validate/split Factory -> the two branch Factories -> the two Sinks.
const ORDER_STAGES: [&[u64]; 4] = [&[0], &[1], &[2, 3], &[4, 5]];

/// The order scene's census: six `Place` commands and five `DrawBelt` commands.
const ORDER_MACHINES: usize = 6;
/// The order scene's census - see [`ORDER_MACHINES`].
const ORDER_BELTS: usize = 5;

/// The demo scene's census: thirteen placed machines (the Route and the HTTP Handler
/// included, plan 85-08), seven labels and eleven drawn belts.
const DEMO_MACHINES: usize = 13;
/// The demo scene's census - see [`DEMO_MACHINES`].
const DEMO_LABELS: usize = 7;
/// The demo scene's census - see [`DEMO_MACHINES`].
const DEMO_BELTS: usize = 11;

/// The demo's flow stages, in mint-order handles: the Source -> the order Factory -> the
/// Tee -> the Router -> the Merge and the Balancer -> the Post sink and the two dock sinks.
/// The Audit sink (4) hangs off the Tee's copy and the Rejects sink (5) off the Factory's
/// fault, as the order scene leaves its branches out; the Route and the HTTP Handler are a
/// separate section (D-18).
const DEMO_STAGES: [&[u64]; 6] = [&[0], &[1], &[2], &[7], &[8, 6], &[3, 9, 10]];

/// The advanced scene's flow stages, in mint-order handles: the two ingress
/// Sources -> the ingress Merge -> the validate Factory -> the Balancer -> the two
/// worker Factories -> the fan-in Merge -> the fulfilment Sink. The dead-letter
/// Sink (4) and the invoice branch (10, 11) stay out of the staged list, as the
/// order scene leaves its branches out: the dead-letter Sink shares x with the
/// validate Factory by design (it hangs off the south Fault port).
const ADVANCED_STAGES: [&[u64]; 7] = [&[0, 1], &[2], &[3], &[5], &[6, 7], &[8], &[9]];

/// The advanced scene's census: twelve `Place` commands and twelve `DrawBelt`
/// commands.
const ADVANCED_MACHINES: usize = 12;
/// The advanced scene's census - see [`ADVANCED_MACHINES`].
const ADVANCED_BELTS: usize = 12;

/// The third shipped scene (quick 260916-adv) is held to the same EX-03 floors as
/// the other two (quick 260929-p7p, review CR-02). Fail-first: on the scene as the
/// PR first shipped it, this was RED on exactly one floor-2 pair, the two ingress
/// Sources stacked flush at (1,6) and (1,7).
#[test]
fn advanced_scene_passes_all_floors() {
    assert_floors(
        &advanced_scene(),
        StageFlow::Staged(&ADVANCED_STAGES),
        ADVANCED_MACHINES,
        ADVANCED_BELTS,
    );
}

/// FLOOR 6 over every shipped scene (plan 85-10, D-25): no belt on the demo, on Order
/// processing or on Advanced doubles back. Every scene is measured whole; the census of
/// belts checked keeps the test from passing over an empty parse.
#[test]
fn every_scene_passes_floor_6() {
    let scenes = [demo_scene(), order_scene(), advanced_scene()];
    let checked: usize = scenes.iter().map(|s| s.belts.len()).sum();
    assert_eq!(
        checked,
        DEMO_BELTS + ORDER_BELTS + ADVANCED_BELTS,
        "floor 6 measures every shipped belt"
    );
    let violations: Vec<String> = scenes.iter().flat_map(floor_6_violations).collect();
    assert!(
        violations.is_empty(),
        "a shipped belt doubles back (floor 6):\n  - {}",
        violations.join("\n  - ")
    );
}

/// A one-belt board for the floor 6 cases below.
fn one_belt(cells: &[(i32, i32)]) -> Scene {
    Scene {
        name: "synthetic",
        machines: Vec::new(),
        labels: Vec::new(),
        belts: vec![Belt { handle: 0, cells: cells.to_vec() }],
        docks: Vec::new(),
    }
}

/// Floor 6 reddens on a belt that runs east, drops a row and runs back west: the U.
#[test]
fn floor_6_names_a_belt_that_runs_back_west() {
    let v = floor_6_violations(&one_belt(&[(0, 0), (1, 0), (1, 1), (0, 1)]));
    assert_eq!(v.len(), 1, "one step turns back: {v:?}");
    assert!(
        v[0].contains("belt#0") && v[0].contains("on x") && v[0].contains("(1,1) -> (0,1)"),
        "the violation names the belt, the axis and the step: {}",
        v[0]
    );
}

/// Floor 6 passes an east, south, east staircase: every step keeps its axis's direction.
#[test]
fn floor_6_passes_a_staircase() {
    assert!(floor_6_violations(&one_belt(&[(0, 0), (1, 0), (1, 1), (2, 1)])).is_empty());
}

/// Floor 6 also reads the y axis: down then back up is a doubled-back belt.
#[test]
fn floor_6_names_a_belt_that_climbs_back_up() {
    let v = floor_6_violations(&one_belt(&[(0, 0), (0, 1), (1, 1), (1, 0)]));
    assert_eq!(v.len(), 1, "one step turns back: {v:?}");
    assert!(v[0].contains("on y"), "the y axis is named: {}", v[0]);
}

/// THE BILLING BELT CLEARS THE BALANCER (plan 85-10, the PR #2 review's WR-05): the invoice
/// belt (validate's second Out to the invoice Factory) makes its first turn at least two
/// columns west of the cell the Balancer's unused second input faces, so a clear column
/// separates the turn from that mouth and the billing branch no longer reads as feeding the
/// Balancer. The mouth is read off the Balancer's own catalog port, never re-typed.
#[test]
fn advanced_invoice_belt_turns_clear_of_the_balancer_mouth() {
    let scene = advanced_scene();
    let balancer = scene.machine(5);
    assert_eq!(balancer.kind, machine_kind::BALANCER, "handle 5 is the Balancer");
    assert_eq!(balancer.foot.rot, 0, "the Balancer is not rotated, so catalog seats are world seats");
    let in1 = &balancer.ports[1];
    assert_eq!(in1.role, Role::In, "catalog port 1 of a Balancer is its second input");
    let (dx, dy) = match in1.side {
        Side::N => (0, -1),
        Side::E => (1, 0),
        Side::S => (0, 1),
        Side::W => (-1, 0),
    };
    let mouth = (
        balancer.anchor.0 + in1.local_offset.0 + dx,
        balancer.anchor.1 + in1.local_offset.1 + dy,
    );

    let invoice = scene.belt(17);
    let turn = invoice
        .cells
        .windows(3)
        .find(|w| (w[1].0 - w[0].0, w[1].1 - w[0].1) != (w[2].0 - w[1].0, w[2].1 - w[1].1))
        .map(|w| w[1])
        .expect("the invoice belt turns at least once");
    assert_ne!(turn, mouth, "the invoice belt turns in the Balancer's second-input mouth");
    assert!(
        turn.0 <= mouth.0 - 2,
        "the invoice belt turns at ({},{}), within a column of the Balancer's second-input mouth \
         ({},{}); a clear column must separate them",
        turn.0,
        turn.1,
        mouth.0,
        mouth.1
    );
}

#[test]
fn order_scene_passes_all_floors() {
    assert_floors(
        &order_scene(),
        StageFlow::Staged(&ORDER_STAGES),
        ORDER_MACHINES,
        ORDER_BELTS,
    );
}

/// The demo is a staged order line since plan 85-08 (D-14 to D-16): every floor applies to
/// it, floor 4's stage half included, and its labels obey the label arm.
#[test]
fn demo_scene_passes_all_floors() {
    let scene = demo_scene();
    assert_eq!(
        scene.labels.len(),
        DEMO_LABELS,
        "demo_scene.ron: the parse yielded {} labels, not the expected {DEMO_LABELS}",
        scene.labels.len()
    );
    assert_floors(&scene, StageFlow::Staged(&DEMO_STAGES), DEMO_MACHINES, DEMO_BELTS);
}

/// FLOOR 3, the belt-pair form the UI-SPEC states literally: the order scene's two
/// branch belts must stay >= 2 empty rows apart at every shared column PAST THE
/// SPLITTER MOUTH.
///
/// The mouth zone is DERIVED from the splitter's own footprint, never hardcoded: the
/// two E-side Out ports are structurally 1 row apart, and the dock facing-opposite
/// rule forbids a tail from jogging inside its port's own exit column, so the first
/// column at which a tail may legally turn is `east_edge + 2`. Everything from
/// `east_edge + 3` east is genuine parallel corridor and is checked. The check
/// asserts its own non-vacuity, so the exclusion can never quietly swallow the whole
/// overlap.
#[test]
fn order_branch_corridors_stay_separable() {
    let scene = order_scene();
    let splitter = scene.machine(1);
    let mouth_end = splitter.rect().x1 + 2;
    let (upper, lower) = (scene.belt(7), scene.belt(8));

    let east_end = upper
        .cells
        .iter()
        .chain(&lower.cells)
        .map(|c| c.0)
        .max()
        .expect("both branch belts have cells");

    let mut checked = 0usize;
    for x in (mouth_end + 1)..=east_end {
        let ys_u: Vec<i32> = upper
            .cells
            .iter()
            .filter(|c| c.0 == x)
            .map(|c| c.1)
            .collect();
        let ys_l: Vec<i32> = lower
            .cells
            .iter()
            .filter(|c| c.0 == x)
            .map(|c| c.1)
            .collect();
        if ys_u.is_empty() || ys_l.is_empty() {
            continue;
        }
        let delta = ys_u
            .iter()
            .flat_map(|a| ys_l.iter().map(move |b| (a - b).abs()))
            .min()
            .expect("both column slices are non-empty");
        assert!(
            delta >= MIN_CORRIDOR_ROW_DELTA,
            "the order scene's branch belts run {delta} row(s) apart at column {x} (past the \
             splitter mouth, which ends at x={mouth_end}); floor 3 needs >= \
             {MIN_CORRIDOR_ROW_DELTA}"
        );
        checked += 1;
    }
    assert!(
        checked > 0,
        "floor 3's branch check is VACUOUS: the mouth exclusion (x <= {mouth_end}) swallowed \
         every shared column - the exclusion is wrong, or the branches never run in parallel"
    );
}

/// FLOOR 3 is ASSERTED on the demo, and it is not vacuous (plan 85-08, D-06). The Router's
/// three lanes, the Post feed and the two dock feeds make parallel corridors, and floor 3
/// is only a check if some pairs of them share columns: this counts those pairs, requires
/// at least two, and requires every one of them to sit at least
/// [`MIN_CORRIDOR_ROW_DELTA`] rows apart.
#[test]
fn demo_scene_floor_3_compares_real_corridor_pairs() {
    let scene = demo_scene();
    let cs = corridors(&scene);
    let sharing: Vec<(Corridor, Corridor)> = cs
        .iter()
        .enumerate()
        .flat_map(|(i, a)| cs[i + 1..].iter().map(move |b| (*a, *b)))
        .filter(|(a, b)| a.x0 <= b.x1 && b.x0 <= a.x1)
        .collect();
    assert!(
        sharing.len() >= 2,
        "floor 3 is vacuous on the demo: only {} corridor pair(s) share a column ({cs:?})",
        sharing.len()
    );
    for (a, b) in &sharing {
        assert!(
            (a.y - b.y).abs() >= MIN_CORRIDOR_ROW_DELTA,
            "corridor belt#{} (y{}) and belt#{} (y{}) share columns {}..{} and {}..{} but run \
             {} row(s) apart; floor 3 needs >= {MIN_CORRIDOR_ROW_DELTA}",
            a.belt,
            a.y,
            b.belt,
            b.y,
            a.x0,
            a.x1,
            b.x0,
            b.x1,
            (a.y - b.y).abs()
        );
    }
    assert!(floor_3_violations(&scene).is_empty(), "and the shared runner agrees");
}

/// D-16: no belt runs from a Balancer Out into a Merge In (the shape walk-112 found, which
/// undoes the Balancer's job), read off the parsed docks.
#[test]
fn demo_scene_never_feeds_a_balancer_into_a_merge() {
    let scene = demo_scene();
    let kind_of = |h: u64| scene.machines.iter().find(|m| m.handle == h).map(|m| m.kind);
    let end = |belt: u64, e: BeltEnd| {
        scene
            .docks
            .iter()
            .find(|(b, end, _)| *b == belt && *end == e)
            .map(|(_, _, n)| *n)
    };
    let mut checked = 0;
    for b in &scene.belts {
        let (Some(tail), Some(head)) = (end(b.handle, BeltEnd::Tail), end(b.handle, BeltEnd::Head)) else {
            panic!("demo belt#{} is not docked at both ends", b.handle);
        };
        assert!(
            !(kind_of(tail) == Some(machine_kind::BALANCER) && kind_of(head) == Some(machine_kind::MERGE)),
            "belt#{} runs from a Balancer Out into a Merge In",
            b.handle
        );
        checked += 1;
    }
    assert_eq!(checked, DEMO_BELTS, "every demo belt was checked");
    assert!(
        scene.belts.iter().any(|b| end(b.handle, BeltEnd::Tail).and_then(kind_of) == Some(machine_kind::BALANCER)),
        "non-vacuity: the demo has a Balancer with an output belt"
    );
}

/// FLOOR 4 for the demo: the SOURCE is the UNIQUE leftmost machine, and the three terminal
/// sinks (Post and the two freight docks) are the rightmost.
#[test]
fn demo_scene_flows_left_to_right() {
    let scene = demo_scene();
    let leftmost: Vec<&Machine> = {
        let min = scene
            .machines
            .iter()
            .map(|m| m.rect().x0)
            .min()
            .expect("the demo places machines");
        scene
            .machines
            .iter()
            .filter(|m| m.rect().x0 == min)
            .collect()
    };
    assert_eq!(
        leftmost.iter().map(|m| m.handle).collect::<Vec<_>>(),
        vec![0],
        "floor 4: the SOURCE (handle 0) must be the unique leftmost machine, found {:?}",
        leftmost.iter().map(|m| m.label()).collect::<Vec<_>>()
    );

    let rightmost: Vec<&Machine> = {
        let max = scene
            .machines
            .iter()
            .map(|m| m.rect().x1)
            .max()
            .expect("the demo places machines");
        scene
            .machines
            .iter()
            .filter(|m| m.rect().x1 == max)
            .collect()
    };
    assert_eq!(
        rightmost.iter().map(|m| m.handle).collect::<Vec<_>>(),
        vec![3, 9, 10],
        "floor 4: the Post sink (3) and the two dock sinks (9, 10) must be the rightmost machines, \
         found {:?}",
        rightmost.iter().map(|m| m.label()).collect::<Vec<_>>()
    );
}

/// FLOOR 4 for the order scene, the UI-SPEC's endpoints clause: the webhook Source is
/// the leftmost machine and the two Sinks are the rightmost.
#[test]
fn order_scene_source_is_leftmost_and_sinks_are_rightmost() {
    let scene = order_scene();
    let min_x = scene
        .machines
        .iter()
        .map(|m| m.rect().x0)
        .min()
        .expect("the order scene places machines");
    assert_eq!(
        scene.machine(0).rect().x0,
        min_x,
        "floor 4: the webhook SOURCE must be the leftmost machine"
    );
    let max_x = scene
        .machines
        .iter()
        .map(|m| m.rect().x1)
        .max()
        .expect("the order scene places machines");
    let rightmost: Vec<u64> = scene
        .machines
        .iter()
        .filter(|m| m.rect().x1 == max_x)
        .map(|m| m.handle)
        .collect();
    assert_eq!(
        rightmost,
        vec![4, 5],
        "floor 4: the two SINKs (handles 4 and 5) must be the rightmost machines"
    );
}
