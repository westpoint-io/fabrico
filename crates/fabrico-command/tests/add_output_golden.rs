//! The `add_output` engine-verdict table (plan 74.1-19, review WR-02, re-walk J10): the
//! contract anchor between the host's `AddPort` validate arm (`command.rs`, the arm that
//! refuses a growth over a belt as `GrowCoversBelt` since plan 74.1-18) and its
//! TypeScript mirror `addOutputVerdict` (`frontend/src/protocol/addOutput.ts`), which
//! decides whether the note beside `+ Add output` is shown.
//!
//! # Why the note is tied to the engine
//! The note it replaces ("Adding an output makes this machine bigger and disconnects its
//! fault belt.") was a hand rule written from a belief about the fold, and the review
//! found it false at every rotation: since plan 74.1-16 an accepted add releases no belt,
//! and an add whose grown box would cover a belt is refused. A note that predicts the
//! host can only be trusted if it is held to the host's own answers, so every row here is
//! a REAL verdict: a fresh `GridSession`, a Factory placed and turned through `Place` and
//! `Rotate`, its outputs edited through `AddPort` / `RemovePort`, belts drawn and docked
//! through `DrawBelt` / `Dock`, then ONE `AddPort` of a Mechanical Out applied and the
//! answer recorded. Nothing here re-implements the rule.
//!
//! # What a row carries
//! The facts the client sees in its render packet (the Factory's anchor, rot-0 `w` and
//! `h`, `rot`, and every port's world cell, world side, role and list index, each
//! through `port_world` exactly as `render_packet.rs` ships it), the occupied cells near
//! the box with the kind of their owner (`belt` or `machine`, never the Factory itself),
//! and the verdict: `ok` with the new port's world cell and side and the box and anchor
//! after, or the refusal's `CommandError` name.
//!
//! # The case axes
//! Rotation 0..3; the board before the add (one, two, three or four outputs, and a
//! three-output board whose middle-row output was removed, so the add fills a freed
//! slot); belts docked on none, the In, each Out, the Fault, or all of them; and the
//! obstacle rows: a stray (undocked) belt on the growth strip, a machine there, and the
//! two orders of a belt and a machine on the same strip, so the "first occupied cell in
//! the host's walk decides" rule is pinned in both directions.
//!
//! The growth strip is the one row the box would gain on its rot-0 south edge as
//! turned, which a turn puts at world S, W, N and E in turn (plan 74.1-16's table). On a
//! board whose add does not grow the box the strip is still filled, and the add is
//! accepted: those rows are the controls that keep the client from refusing on mere
//! proximity.
//!
//! # The guard
//! Every accepted row's release set (`core().last_tick.unlinked`) is asserted EMPTY in
//! the freezer and in the guard, so the note's premise (an accepted add lets no belt go)
//! is the fold's measured behaviour, not a sentence. Non-vacuity, on the FROZEN file: per
//! rotation at least one `ok`, one `GrowCoversBelt` and one `GrowBlocked` (the machine
//! refusal, `FootprintCollision` until plan 88-02 re-froze its 16 rows, D-11).
//!
//! Two parts, the `seam_golden.rs` / `belt_join_golden.rs` freezer discipline:
//!   - [`freeze_add_output`] (`#[ignore]`d) is the ONLY writer of
//!     `tests/fixtures/add_output.expected.json`:
//!     `cargo test -p fabrico-command --test add_output_golden freeze_add_output -- --ignored`
//!   - [`add_output_matches_frozen`] (always runs) rebuilds every row through the host
//!     and asserts the result equals the committed file byte for byte.
//!
//! The TS side (`frontend/src/protocol/addOutput.test.ts`) reads the same file and
//! asserts `addOutputVerdict` agrees with every row.
//!
//! The fixture lives under `crates/fabrico-command`, which is not a covered crate root of
//! the declared-moves gate, so it needs no declared-moves entry.
//!
//! `fabrico-command`'s `deps_are_headless` fence bans IO from the NORMAL tree only; this
//! freezer needs `std::fs`, so it carries the same file-scoped escape `seam_golden.rs` uses.
#![allow(clippy::disallowed_methods)] // golden freezer: needs std::fs (write/read); freeze step is #[ignore]d.

use fabrico_command::GridSession;
use fabrico_core::ids::NodeId;
use fabrico_core::state::{
    Footprint, Node, Port, Role, Side, cells_of_footprint, effective_box, port_world, unit_delta,
};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind, port_medium, port_role};

/// Absolute path to the frozen table (CWD-independent).
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/add_output.expected.json"
);

const SEED: u64 = 0x0074_0119_0ADD_0000;

/// Every Factory is placed with its anchor here, on its own fresh session.
const ANCHOR: (i32, i32) = (20, 20);

/// A world cell.
type Cell = (i32, i32);

/// One port as the render packet ships it.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
struct PortRow {
    index: u16,
    cell: [i32; 2],
    side: u8,
    role: u8,
}

/// One occupied cell near the box, and the kind of its owner.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
struct Occupied {
    cell: [i32; 2],
    owner: String,
}

/// The host's answer.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
struct Verdict {
    /// `ok` or the `CommandError` name.
    tag: String,
    /// `ok` only: the new port's world cell.
    port_cell: Option<[i32; 2]>,
    /// `ok` only: the new port's world side.
    port_side: Option<u8>,
    /// `ok` only: the anchor after.
    anchor: Option<[i32; 2]>,
    /// `ok` only: the rot-0 width after.
    w: Option<u16>,
    /// `ok` only: the rot-0 height after.
    h: Option<u16>,
}

/// One row of the table.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
struct AddCase {
    /// A readable name: rotation, board and what is docked or in the way.
    name: String,
    /// The board: `outs1` .. `outs4`, or `freed` (three outputs, the middle-row one removed).
    board: String,
    /// What is docked or in the way: `none`, `In`, `Out0`.., `Fault`, `all`,
    /// `stray-belt`, `machine`, `belt-then-machine`, `machine-then-belt`.
    setup: String,
    anchor: [i32; 2],
    w: u16,
    h: u16,
    rot: u8,
    ports: Vec<PortRow>,
    occupied: Vec<Occupied>,
    verdict: Verdict,
}

/// One Factory on its own session.
struct Board {
    s: GridSession,
    m: NodeId,
    h: u64,
}

fn place_factory(rot: u8, outs: usize, freed: bool) -> Board {
    let mut s = GridSession::new(SEED);
    s.apply(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: ANCHOR.0, cell_y: ANCHOR.1 })
        .expect("place the factory on clear floor");
    let m = *s.core().last_tick.placed.last().expect("the factory was minted");
    let h = s.view().handle_of(m).expect("the factory got a handle");
    for _ in 0..rot {
        s.apply(GridCommand::Rotate { node: h, ccw: false }).expect("turn the undocked factory");
    }
    let mut b = Board { s, m, h };
    for _ in 1..outs {
        add_out(&mut b).expect("an add on a clear patch is accepted");
    }
    if freed {
        // The first Out in list order sits on the middle row (slot 1).
        let i = out_index(&b, 0);
        b.s.apply(GridCommand::RemovePort { node: b.h, index: i }).expect("remove the middle-row output");
    }
    b
}

fn add_out(b: &mut Board) -> Result<(), fabrico_command::CommandError> {
    b.s.apply(GridCommand::AddPort {
        node: b.h,
        role: port_role::OUT,
        side: Side::E as u8,
        medium: port_medium::MECHANICAL,
    })
    .map(|_| ())
}

fn ports(b: &Board) -> Vec<Port> {
    b.s.core().state.ports_of(b.m).expect("the factory declares ports").to_vec()
}

fn footprint(b: &Board) -> Footprint {
    b.s.core().state.footprint_of(b.m).unwrap_or(Footprint { w: 1, h: 1, rot: 0 })
}

fn anchor(b: &Board) -> Cell {
    b.s.core().state.cell_of(b.m).expect("the factory has a cell")
}

fn world(b: &Board, p: &Port) -> (Cell, Side) {
    let fp = footprint(b);
    port_world(anchor(b), fp.w, fp.h, fp.rot, p)
}

fn facing(b: &Board, p: &Port) -> Cell {
    let (c, side) = world(b, p);
    let (dx, dy) = unit_delta(side);
    (c.0 + dx, c.1 + dy)
}

fn out_index(b: &Board, k: usize) -> u16 {
    let i = ports(b)
        .iter()
        .enumerate()
        .filter(|(_, p)| p.role == Role::Out)
        .nth(k)
        .map(|(i, _)| i)
        .expect("the factory has that many outputs");
    u16::try_from(i).expect("a catalog index fits")
}

fn first_index(b: &Board, role: Role) -> u16 {
    let i = ports(b).iter().position(|p| p.role == role).expect("the factory has that role");
    u16::try_from(i).expect("a catalog index fits")
}

fn last_minted(b: &Board) -> (NodeId, u64) {
    let id = *b.s.core().last_tick.placed.last().expect("a node was minted");
    (id, b.s.view().handle_of(id).expect("the node got a handle"))
}

/// A two-tile belt leaving port `idx` outward from its facing cell, Tail docked there.
fn offload(b: &mut Board, idx: u16) {
    let p = ports(b)[usize::from(idx)];
    let f = facing(b, &p);
    let (dx, dy) = unit_delta(world(b, &p).1);
    b.s.apply(GridCommand::DrawBelt { cells: vec![f, (f.0 + dx, f.1 + dy)] })
        .expect("the offload path is clear");
    let (_, bh) = last_minted(b);
    b.s.apply(GridCommand::Dock { belt: bh, endpoint: BeltEnd::Tail, node: b.h, port: idx })
        .expect("a Tail on the port's facing cell docks");
}

/// A two-tile belt arriving at port `idx`'s facing cell from outside, Head docked there.
fn feed(b: &mut Board, idx: u16) {
    let p = ports(b)[usize::from(idx)];
    let f = facing(b, &p);
    let (dx, dy) = unit_delta(world(b, &p).1);
    b.s.apply(GridCommand::DrawBelt { cells: vec![(f.0 + dx, f.1 + dy), f] })
        .expect("the feed path is clear");
    let (_, bh) = last_minted(b);
    b.s.apply(GridCommand::Dock { belt: bh, endpoint: BeltEnd::Head, node: b.h, port: idx })
        .expect("a Head on the port's facing cell docks");
}

/// The growth strip: the cells one more rot-0 row would add, in the host's walk order
/// (row-major over the grown box), and the world step pointing away from the machine.
/// Shift per rotation from plan 74.1-16's table: rot 0 `(0, 0)`, rot 1 `(-1, 0)`, rot 2
/// `(0, -1)`, rot 3 `(0, 0)`, for a growth of one row.
fn growth_strip(b: &Board) -> (Vec<Cell>, (i32, i32)) {
    let (a, fp) = (anchor(b), footprint(b));
    let (sx, sy, out) = match fp.rot & 3 {
        0 => (0, 0, (0, 1)),
        1 => (-1, 0, (-1, 0)),
        2 => (0, -1, (0, -1)),
        _ => (0, 0, (1, 0)),
    };
    let own: Vec<Cell> = cells_of_footprint(a, fp.w, fp.h, fp.rot).collect();
    let strip = cells_of_footprint((a.0 + sx, a.1 + sy), fp.w, fp.h + 1, fp.rot)
        .filter(|c| !own.contains(c))
        .collect::<Vec<_>>();
    assert_eq!(strip.len(), usize::from(fp.w), "the strip is one rot-0 row of the box");
    (strip, out)
}

/// A stray two-tile belt on strip cell `c`, running away from the machine; not docked.
fn stray_belt(b: &mut Board, c: Cell, out: (i32, i32)) {
    b.s.apply(GridCommand::DrawBelt { cells: vec![c, (c.0 + out.0, c.1 + out.1)] })
        .expect("the stray belt's path is clear");
}

/// A Source (1x1) placed on strip cell `c`.
fn machine_at(b: &mut Board, c: Cell) {
    b.s.apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: c.0, cell_y: c.1 })
        .expect("the strip cell is clear for a Source");
}

/// The packet-shaped facts of the board as it stands.
fn snapshot(b: &Board) -> (Cell, Footprint, Vec<PortRow>, Vec<Occupied>) {
    let (a, fp) = (anchor(b), footprint(b));
    let rows = ports(b)
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let (c, side) = world(b, p);
            PortRow {
                index: u16::try_from(i).expect("fits"),
                cell: [c.0, c.1],
                side: side as u8,
                role: p.role as u8,
            }
        })
        .collect();
    let (ew, eh) = effective_box(fp.w, fp.h, fp.rot);
    let state = &b.s.core().state;
    let mut occ = Vec::new();
    for y in (a.1 - 3)..(a.1 + eh + 3) {
        for x in (a.0 - 3)..(a.0 + ew + 3) {
            let Some(owner) = state.occupied((x, y)) else { continue };
            if owner == b.m {
                continue;
            }
            let kind = if matches!(state.node(owner), Some(Node::Belt(_))) { "belt" } else { "machine" };
            occ.push(Occupied { cell: [x, y], owner: kind.to_string() });
        }
    }
    (a, fp, rows, occ)
}

/// Apply the add and record the verdict, asserting an accepted add released nothing.
fn verdict_of(b: &mut Board, name: &str) -> Verdict {
    let before = ports(b).len();
    match add_out(b) {
        Ok(()) => {
            assert!(
                b.s.core().last_tick.unlinked.is_empty(),
                "{name}: an accepted add releases no belt, got {:?}",
                b.s.core().last_tick.unlinked
            );
            let ps = ports(b);
            assert_eq!(ps.len(), before + 1, "{name}: the add appended one port");
            let p = ps[before];
            assert_eq!(p.role, Role::Out, "{name}: the appended port is an Out");
            let (c, side) = world(b, &p);
            let (a, fp) = (anchor(b), footprint(b));
            Verdict {
                tag: "ok".to_string(),
                port_cell: Some([c.0, c.1]),
                port_side: Some(side as u8),
                anchor: Some([a.0, a.1]),
                w: Some(fp.w),
                h: Some(fp.h),
            }
        }
        Err(e) => Verdict { tag: format!("{e:?}"), port_cell: None, port_side: None, anchor: None, w: None, h: None },
    }
}

fn row(rot: u8, board: &str, setup: &str, b: &mut Board) -> AddCase {
    let name = format!("rot{rot} {board} {setup}");
    let (a, fp, ports, occupied) = snapshot(b);
    let verdict = verdict_of(b, &name);
    AddCase {
        name,
        board: board.to_string(),
        setup: setup.to_string(),
        anchor: [a.0, a.1],
        w: fp.w,
        h: fp.h,
        rot: fp.rot,
        ports,
        occupied,
        verdict,
    }
}

/// The boards: `(name, outputs placed, freed)`.
const BOARDS: [(&str, usize, bool); 5] = [
    ("outs1", 1, false),
    ("outs2", 2, false),
    ("outs3", 3, false),
    ("outs4", 4, false),
    ("freed", 3, true),
];

fn cases() -> Vec<AddCase> {
    let mut out = Vec::new();
    for rot in 0..4u8 {
        for (board, outs, freed) in BOARDS {
            let n_out = if freed { outs - 1 } else { outs };
            // Dock sets: none, the In, each Out, the Fault, all of them.
            let mut sets: Vec<String> = vec!["none".into(), "In".into()];
            sets.extend((0..n_out).map(|k| format!("Out{k}")));
            sets.push("Fault".into());
            sets.push("all".into());
            for set in &sets {
                let mut b = place_factory(rot, outs, freed);
                let dock_in = set == "In" || set == "all";
                let dock_fault = set == "Fault" || set == "all";
                if dock_in {
                    let i = first_index(&b, Role::In);
                    feed(&mut b, i);
                }
                for k in 0..n_out {
                    if set == "all" || *set == format!("Out{k}") {
                        let i = out_index(&b, k);
                        offload(&mut b, i);
                    }
                }
                if dock_fault {
                    let i = first_index(&b, Role::Fault);
                    offload(&mut b, i);
                }
                out.push(row(rot, board, set, &mut b));
            }
            // The obstacle rows, each on an otherwise bare board.
            for setup in ["stray-belt", "machine", "belt-then-machine", "machine-then-belt"] {
                let mut b = place_factory(rot, outs, freed);
                let (strip, step) = growth_strip(&b);
                let (first, last) = (strip[0], strip[strip.len() - 1]);
                match setup {
                    "stray-belt" => stray_belt(&mut b, strip[1], step),
                    "machine" => machine_at(&mut b, strip[1]),
                    "belt-then-machine" => {
                        stray_belt(&mut b, first, step);
                        machine_at(&mut b, last);
                    }
                    _ => {
                        machine_at(&mut b, first);
                        stray_belt(&mut b, last, step);
                    }
                }
                out.push(row(rot, board, setup, &mut b));
            }
        }
    }
    out
}

/// The table as JSON with ONE ROW PER LINE, so a re-bless diff names the rows that moved.
fn to_json(cases: &[AddCase]) -> String {
    let rows: Vec<String> = cases
        .iter()
        .map(|c| serde_json::to_string(c).expect("json add_output row"))
        .collect();
    format!("[\n{}\n]\n", rows.join(",\n"))
}

#[test]
#[ignore = "explicit golden freezer; writes the committed add_output table"]
fn freeze_add_output() {
    let json = to_json(&cases());
    std::fs::write(JSON_PATH, json).expect("write add_output.expected.json");
}

#[test]
fn add_output_matches_frozen() {
    // `cases()` asserts, row by row, that every accepted add released nothing.
    let rebuilt = cases();
    let frozen_text = std::fs::read_to_string(JSON_PATH)
        .expect("add_output table committed; run `freeze_add_output -- --ignored` to bless it");
    assert_eq!(
        to_json(&rebuilt),
        frozen_text,
        "the host's AddPort verdicts drifted from the frozen table; re-bless deliberately, never silently",
    );
    // NON-VACUITY, on the FROZEN file, per rotation.
    let frozen: Vec<AddCase> = serde_json::from_str(&frozen_text).expect("the table parses");
    for rot in 0..4u8 {
        let of = |tag: &str| frozen.iter().filter(|c| c.rot == rot && c.verdict.tag == tag).count();
        assert!(of("ok") >= 1, "rot {rot}: at least one accepted add");
        assert!(of("GrowCoversBelt") >= 1, "rot {rot}: at least one GrowCoversBelt");
        assert!(of("GrowBlocked") >= 1, "rot {rot}: at least one GrowBlocked");
        // The note's case: a growing add with a fault belt is refused for that belt.
        let fault = frozen
            .iter()
            .find(|c| c.rot == rot && c.board == "outs3" && c.setup == "Fault")
            .expect("the outs3 Fault row exists");
        assert_eq!(fault.verdict.tag, "GrowCoversBelt", "rot {rot}: the fault belt refuses the growing add");
    }
    // Every accepted row grew no further than one row and names a new port.
    for c in frozen.iter().filter(|c| c.verdict.tag == "ok") {
        assert!(c.verdict.port_cell.is_some() && c.verdict.h.is_some(), "{}: an ok row carries the after-state", c.name);
    }
    // Only the three tags the arm can return on open floor appear.
    for c in &frozen {
        assert!(
            ["ok", "GrowCoversBelt", "GrowBlocked"].contains(&c.verdict.tag.as_str()),
            "{}: unexpected verdict {}",
            c.name,
            c.verdict.tag
        );
    }
}
