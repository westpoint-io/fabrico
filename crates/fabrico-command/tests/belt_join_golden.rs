//! The `belt_join` engine-verdict table (plan 74.1-15, gap N4): the contract anchor
//! between the host's belt-to-belt `Dock` rule (`command.rs` Dock arm, belt branch) and
//! its TypeScript mirror `acceptsDock` with a belt target (`frontend/src/protocol/ports.ts`),
//! which the handle-drag ranker and the drop ring use to predict the host.
//!
//! Every row is a REAL verdict: a fresh `GridSession`, two belts drawn through
//! `GridCommand::DrawBelt`, one `GridCommand::Dock` applied, and the answer recorded (`ok`,
//! or the refusal's `CommandError` name). Nothing here re-implements the rule. Since plan
//! 74.1-18 every refusal row is a belt-join tag (it was `InvalidDock`; re-blessed through
//! the freezer with verdict tags only, no case changed); since plan 74.1-24 (gap J11) the
//! `uturn` rows are `BeltJoinTurnsBack`, the `distance` rows `BeltEndsApart`, and the guard
//! asserts each family's tag on the rebuilt and the frozen rows ([`tag_of_family`]) and the
//! accept rows against the table as that plan found it ([`ACCEPT_DIGEST`]). The TS side
//! (`ports.test.ts`, the "belt_join.expected.json" block) reads the same file and asserts
//! `acceptsDock` agrees with every row.
//!
//! Two parts, the `seam_golden.rs` freezer discipline:
//!   - [`freeze_belt_join`] (`#[ignore]`d) is the ONLY writer of
//!     `tests/fixtures/belt_join.expected.json`. Re-freezing is an explicit, reviewed act:
//!     `cargo test -p fabrico-command --test belt_join_golden freeze_belt_join -- --ignored`
//!   - [`belt_join_matches_frozen`] (always runs) rebuilds every row through the host and
//!     asserts the result equals the committed file byte for byte, and asserts the
//!     non-vacuity counts on the FROZEN file: at least 20 accepts and at least one row of
//!     each refusal class (distance, inner tile, single tile, role, U-turn).
//!
//! THE CASES. A three-tile target belt whose named end sits on the fixed cell (10,10),
//! with each of the four outward sides; the carrier end on every FREE cell within
//! manhattan distance two of that end; every carrier direction whose inner tile is free
//! (the carrier is two tiles: its end and its inner tile); all four end pairings (the two
//! role-correct ones, carrier Tail onto target Head and carrier Head onto target Tail, and
//! the two role-mismatched ones); single-tile target rows; two-tile self-dock rows.
//!
//! `class` is the row's family, written by the ENUMERATOR from the geometry it built, not
//! read from the verdict: `accept`, `distance` (two cells apart), `inner` (the carrier end
//! is the target's inner tile, which only a self-dock reaches), `single` (one-tile target),
//! `role` (a Head onto a Head or a Tail onto a Tail) and `uturn` (one step apart and the
//! carrier's outward side equals the target end's side). The guard also asserts every
//! `accept` row verdict is `ok` and every other row is refused.
//!
//! The fixture lives under `crates/fabrico-command`, which is not a covered crate root of
//! the declared-moves gate, so it needs no declared-moves entry.
//!
//! `fabrico-command`'s `deps_are_headless` fence bans IO from the NORMAL tree only; this
//! freezer needs `std::fs`, so it carries the same file-scoped escape `seam_golden.rs` uses.
#![allow(clippy::disallowed_methods)] // golden freezer: needs std::fs (write/read); freeze step is #[ignore]d.

use fabrico_command::GridSession;
use fabrico_protocol::{BeltEnd, GridCommand};

/// Absolute path to the frozen table (CWD-independent).
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/belt_join.expected.json"
);

const SEED: u64 = 0x0074_0115_6017_0000;

/// The fixed cell the target end sits on.
const E: (i32, i32) = (10, 10);

/// The four unit steps, N E S W (y-down).
const STEPS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];

/// One row of the table.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
struct JoinCase {
    /// The carrier's cells, Tail first.
    carrier: Vec<[i32; 2]>,
    /// Which carrier end is dragged: "Head" or "Tail".
    carrier_end: String,
    /// The target's cells, Tail first. Equal to `carrier` for a self-dock row.
    target: Vec<[i32; 2]>,
    /// Which target end's port the Dock names: "Head" (port 1, Out) or "Tail" (port 0, In).
    target_end: String,
    /// The row's family, from the enumerator (see the module docblock).
    class: String,
    /// The host's verdict: "ok" or the `CommandError` name.
    verdict: String,
}

fn end_name(e: BeltEnd) -> String {
    match e {
        BeltEnd::Head => "Head".to_string(),
        BeltEnd::Tail => "Tail".to_string(),
    }
}

fn add(a: (i32, i32), d: (i32, i32), k: i32) -> (i32, i32) {
    (a.0 + d.0 * k, a.1 + d.1 * k)
}

/// The cells of a straight belt whose `end` sits on `cell`, with outward step `out`, and
/// `len` tiles, Tail first.
fn belt_cells(cell: (i32, i32), out: (i32, i32), end: BeltEnd, len: i32) -> Vec<(i32, i32)> {
    // From the far end to `cell`: the inner tiles are `cell - k * out`.
    let mut toward_end: Vec<(i32, i32)> = (0..len).rev().map(|k| add(cell, out, -k)).collect();
    match end {
        // The Head is the LAST tile, so the run ends on `cell`.
        BeltEnd::Head => toward_end,
        // The Tail is the FIRST tile, so the run starts on `cell`.
        BeltEnd::Tail => {
            toward_end.reverse();
            toward_end
        }
    }
}

/// Run one row through a fresh `GridSession` and record the verdict.
fn verdict(
    carrier: &[(i32, i32)],
    carrier_end: BeltEnd,
    target: Option<&[(i32, i32)]>,
    target_end: BeltEnd,
) -> String {
    let mut s = GridSession::new(SEED);
    let draw = |s: &mut GridSession, cells: &[(i32, i32)]| -> u64 {
        s.apply(GridCommand::DrawBelt { cells: cells.to_vec() })
            .unwrap_or_else(|e| panic!("the table only draws clear paths: {cells:?} gave {e:?}"));
        let id = *s.core().last_tick.placed.last().expect("the belt was minted");
        s.view().handle_of(id).expect("the belt got a handle")
    };
    // A self-dock row passes `None`: the carrier is its own target.
    let t_h = match target {
        Some(t) => draw(&mut s, t),
        None => u64::MAX,
    };
    let c_h = draw(&mut s, carrier);
    let node = if target.is_some() { t_h } else { c_h };
    let port = match target_end {
        BeltEnd::Tail => 0,
        BeltEnd::Head => 1,
    };
    match s.apply(GridCommand::Dock { belt: c_h, endpoint: carrier_end, node, port }) {
        Ok(_) => "ok".to_string(),
        Err(e) => format!("{e:?}"),
    }
}

fn row(
    carrier: Vec<(i32, i32)>,
    carrier_end: BeltEnd,
    target: Option<Vec<(i32, i32)>>,
    target_end: BeltEnd,
    class: &str,
) -> JoinCase {
    let v = verdict(&carrier, carrier_end, target.as_deref(), target_end);
    let cells = |c: &[(i32, i32)]| c.iter().map(|&(x, y)| [x, y]).collect::<Vec<_>>();
    JoinCase {
        target: cells(target.as_deref().unwrap_or(&carrier)),
        carrier: cells(&carrier),
        carrier_end: end_name(carrier_end),
        target_end: end_name(target_end),
        class: class.to_string(),
        verdict: v,
    }
}

fn cases() -> Vec<JoinCase> {
    let mut out = Vec::new();
    let ends = [BeltEnd::Tail, BeltEnd::Head];
    // 1. A three-tile target, its named end on E, each outward side.
    for tout in STEPS {
        for target_end in ends {
            let target = belt_cells(E, tout, target_end, 3);
            for dy in -2..=2i32 {
                for dx in -2..=2i32 {
                    let dist = dx.abs() + dy.abs();
                    let c = (E.0 + dx, E.1 + dy);
                    if dist == 0 || dist > 2 || target.contains(&c) {
                        continue;
                    }
                    for cout in STEPS {
                        let inner = add(c, cout, -1);
                        if target.contains(&inner) {
                            continue;
                        }
                        for carrier_end in ends {
                            let carrier = belt_cells(c, cout, carrier_end, 2);
                            let class = if carrier_end == target_end {
                                "role"
                            } else if dist == 2 {
                                "distance"
                            } else if cout == tout {
                                "uturn"
                            } else {
                                "accept"
                            };
                            out.push(row(carrier, carrier_end, Some(target.clone()), target_end, class));
                        }
                    }
                }
            }
        }
    }
    // 2. A one-tile target on E: every neighbour, every free carrier direction, the two
    //    role-correct pairings.
    for step in STEPS {
        let c = add(E, step, 1);
        for cout in STEPS {
            if add(c, cout, -1) == E {
                continue;
            }
            for (carrier_end, target_end) in [(BeltEnd::Tail, BeltEnd::Head), (BeltEnd::Head, BeltEnd::Tail)] {
                let carrier = belt_cells(c, cout, carrier_end, 2);
                out.push(row(carrier, carrier_end, Some(vec![E]), target_end, "single"));
            }
        }
    }
    // 3. A two-tile belt docking an end onto its OWN other end, both ways: the carrier end
    //    is the target's inner tile.
    let two = vec![(20, 20), (21, 20)];
    out.push(row(two.clone(), BeltEnd::Tail, None, BeltEnd::Head, "inner"));
    out.push(row(two, BeltEnd::Head, None, BeltEnd::Tail, "inner"));
    out
}

/// The table as JSON with ONE ROW PER LINE, so a re-bless diff names the rows that moved.
fn to_json(cases: &[JoinCase]) -> String {
    let rows: Vec<String> = cases
        .iter()
        .map(|c| serde_json::to_string(c).expect("json belt_join row"))
        .collect();
    format!("[\n{}\n]\n", rows.join(",\n"))
}

#[test]
#[ignore = "explicit golden freezer; writes the committed belt_join table"]
fn freeze_belt_join() {
    let json = to_json(&cases());
    std::fs::write(JSON_PATH, json).expect("write belt_join.expected.json");
}

/// The refusal tag each refused family must carry, from the family the ENUMERATOR wrote,
/// never from the verdict (plan 74.1-24, gap J11: each tag names the clause the join broke):
/// the U-turn `BeltJoinTurnsBack`, ends that do not touch (`distance`: two apart or a
/// diagonal neighbour) `BeltEndsApart`, and the role, one-tile-target and own-inner-tile
/// families `InvalidBeltJoin`.
fn tag_of_family(class: &str) -> &'static str {
    match class {
        "uturn" => "BeltJoinTurnsBack",
        "distance" => "BeltEndsApart",
        "role" | "single" | "inner" => "InvalidBeltJoin",
        other => panic!("no refusal tag for family {other:?}"),
    }
}

/// The ACCEPT rows of the table as plan 74.1-24 found it (the file at a pre-release revision): their
/// count and an FNV-1a 64 digest over each accept row's JSON line plus a newline, in table
/// order. Plan 74.1-24 moved refusal TAGS only, so no accept row may move; a later plan that
/// changes which joins are accepted moves these two numbers on purpose, as a named change.
const ACCEPT_ROWS: usize = 56;
const ACCEPT_DIGEST: u64 = 0xe05f_770d_b43b_7e6d;

/// FNV-1a 64 over `bytes`, continuing from `h`.
fn fnv1a(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// Assert the family-to-tag map on every row of `rows` (`which` names the copy in a red).
fn assert_families(rows: &[JoinCase], which: &str) {
    for c in rows {
        let accepted = c.verdict == "ok";
        assert_eq!(accepted, c.class == "accept", "{which} row {c:?}: the verdict disagrees with its class");
        if !accepted {
            assert_eq!(
                c.verdict,
                tag_of_family(&c.class),
                "{which} row {c:?}: a refused join carries the tag of the clause its family breaks",
            );
        }
    }
}

#[test]
fn belt_join_matches_frozen() {
    let rebuilt = cases();
    let frozen_text = std::fs::read_to_string(JSON_PATH)
        .expect("belt_join table committed; run `freeze_belt_join -- --ignored` to bless it");
    let frozen: Vec<JoinCase> = serde_json::from_str(&frozen_text).expect("the table parses");
    // Every row's verdict agrees with the family the enumerator built it as, and every
    // refusal carries the tag of the clause it broke (never the machine tag `InvalidDock`,
    // whose sentence names output and input). Asserted on the REBUILT rows (the host now)
    // and on the FROZEN rows BEFORE the byte comparison, so a hand-edited tag in the file
    // reddens here, naming the family, rather than only as an anonymous byte drift.
    assert_families(&rebuilt, "rebuilt");
    assert_families(&frozen, "frozen");
    // The accept rows are the ones plan 74.1-24 found, byte for byte.
    let accept_lines: Vec<String> = frozen
        .iter()
        .filter(|c| c.class == "accept")
        .map(|c| serde_json::to_string(c).expect("json belt_join row"))
        .collect();
    assert_eq!(accept_lines.len(), ACCEPT_ROWS, "the accept rows are the 56 the table had at a pre-release revision");
    let digest = accept_lines
        .iter()
        .fold(0xcbf2_9ce4_8422_2325, |h, l| fnv1a(fnv1a(h, l.as_bytes()), b"\n"));
    assert_eq!(
        digest, ACCEPT_DIGEST,
        "an accept row moved: plan 74.1-24 moved refusal tags only, and which joins are accepted is pinned",
    );
    assert_eq!(
        to_json(&rebuilt),
        frozen_text,
        "the host's belt-join verdicts drifted from the frozen table; re-bless deliberately, never silently",
    );
    // NON-VACUITY, on the FROZEN file.
    let count = |class: &str| frozen.iter().filter(|c| c.class == class).count();
    let accepts = frozen.iter().filter(|c| c.verdict == "ok").count();
    assert!(accepts >= 20, "at least 20 accepted rows, got {accepts}");
    for class in ["distance", "inner", "single", "role", "uturn"] {
        assert!(count(class) >= 1, "at least one `{class}` refusal row, got 0");
    }
    for tag in ["BeltEndsApart", "BeltJoinTurnsBack", "InvalidBeltJoin"] {
        assert!(frozen.iter().any(|c| c.verdict == tag), "at least one `{tag}` row");
    }
}
