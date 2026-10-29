//! The `seam` cross-language golden fixture: the contract anchor between the Rust seam
//! table [`seam_end_kind`] (`fabrico-core` `state.rs`, phase 74.1 gap closure) and its
//! TypeScript port `seamEndKind` (`frontend/src/protocol/seam.ts`), which the draw-belt
//! PREVIEW calls so the ghost a hand drags already shows the corner the host will ship
//! at a docked end. It freezes the table's answer over every input a belt end can
//! reach, so the TS port answers identically case by case and `preview == commit`
//! holds CROSS-LANGUAGE at the seam (BELT-03, 74.1-SEAM-DESIGN.md section 5).
//!
//! Two parts, mirroring `route_golden.rs`'s freezer discipline verbatim:
//!   - [`freeze_seam`] (`#[ignore]`d) is the ONLY writer: it postcard-encodes the
//!     enumerated [`seam_cases`] to `tests/fixtures/seam.bin` and the same value as
//!     pretty JSON to `tests/fixtures/seam.expected.json`. `cargo test` NEVER runs it,
//!     so the fixture is never silently regenerated; re-freezing is an explicit,
//!     reviewed act:
//!     `cargo test -p fabrico-command freeze_seam -- --ignored`
//!   - [`seam_matches_frozen`] (always runs) re-derives every case through
//!     `seam_end_kind` and asserts the encoding equals the committed `.bin` bytes, so
//!     any drift in the Rust table FAILS CI instead of silently re-blessing. The TS
//!     side (`seam.test.ts`) decodes the same `.bin` and fails on its own drift. The
//!     case count is asserted on both sides against the same literal.
//!
//! WHY THIS GOLDEN LIVES IN `fabrico-command` AND NOT `fabrico-protocol` (a measured
//! correction to 74.1-SEAM-DESIGN.md section 5). `fabrico-protocol` has no dependency
//! on `fabrico-core`; giving it one would change `Cargo.lock`, which
//! the declared-moves gate refuses and no declaration can permit.
//! `fabrico-command` already depends on `fabrico-core`, `postcard` and `serde_json`
//! for `route_golden.rs` and is not a covered crate, so this file needs no
//! declared-moves entry.
//!
//! THE WIRE FORM IS PLAIN INTEGERS, on purpose. Each case is a test-local struct of
//! `u8`s (`TileKind` as a tag plus two payload bytes, each direction as its `Dir` byte
//! `N=0 E=1 S=2 W=3`, `Axis` as `X=0 Y=1`), so the TS reader needs nothing but
//! `PostcardReader.u8` and `vec` and cannot be wrong about a serde enum layout.
//!
//! `fabrico-command`'s `deps_are_headless` fence bans renderer/IO/host deps from the
//! NORMAL tree only; this freezer legitimately needs `std::fs`, so it carries the same
//! file-scoped escape `route_golden.rs` uses, SCOPED to this one test file.
#![allow(clippy::disallowed_methods)] // golden freezer: needs std::fs (write/read); freeze step is #[ignore]d.

use fabrico_core::state::{Axis, Dir, TileKind, seam_end_kind};

/// Absolute path to the frozen postcard bytes (CWD-independent).
const BIN_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/seam.bin");
/// Absolute path to the human/TS-readable expected JSON sibling.
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/seam.expected.json"
);

/// The case count, asserted here and as the same literal in `seam.test.ts`. A change to
/// the enumeration that adds or drops cases moves it on purpose, in both files.
const SEAM_CASE_COUNT: usize = 490;

const DIRS: [Dir; 4] = [Dir::N, Dir::E, Dir::S, Dir::W];

/// One seam case as plain integers. `stored` and `answer` are `[tag, a, b]`:
/// tag 0 = Straight (`a` = axis, `b` = 0), tag 1 = Corner (`a` = from, `b` = to).
#[derive(serde::Serialize)]
struct SeamCase {
    stored: [u8; 3],
    own_in: Option<u8>,
    own_out: Option<u8>,
    feeds: Vec<u8>,
    drain: Option<u8>,
    answer: [u8; 3],
}

fn dir_byte(d: Dir) -> u8 {
    d as u8
}

fn kind_bytes(k: TileKind) -> [u8; 3] {
    match k {
        TileKind::Straight { axis } => [
            0,
            match axis {
                Axis::X => 0,
                Axis::Y => 1,
            },
            0,
        ],
        TileKind::Corner { from, to } => [1, dir_byte(from), dir_byte(to)],
    }
}

fn case(
    stored: TileKind,
    own_in: Option<Dir>,
    own_out: Option<Dir>,
    feeds: &[Dir],
    drain: Option<Dir>,
) -> SeamCase {
    SeamCase {
        stored: kind_bytes(stored),
        own_in: own_in.map(dir_byte),
        own_out: own_out.map(dir_byte),
        feeds: feeds.iter().copied().map(dir_byte).collect(),
        drain: drain.map(dir_byte),
        answer: kind_bytes(seam_end_kind(stored, own_in, own_out, feeds, drain)),
    }
}

/// Every feed list a Tail end can carry in the enumeration: none, one from each of the
/// four directions, and every ordered pair of two (a fan-in), in a fixed order.
fn feed_lists() -> Vec<Vec<Dir>> {
    let mut out = vec![Vec::new()];
    for d in DIRS {
        out.push(vec![d]);
    }
    for a in DIRS {
        for b in DIRS {
            out.push(vec![a, b]);
        }
    }
    out
}

/// The enumerated case set, nested loops in a fixed order (no hashing), covering every
/// input a belt end reaches the way `effective_belt_tiles` calls the table:
///
/// - TAIL ends: each stored straight, each own direction (`own_in == own_out`, the
///   step from tiles[0] to tiles[1]), feeds 0, 1 or 2 from the four directions, no
///   drain. 2 x 4 x 21 = 168.
/// - HEAD ends: each stored straight, each own direction (tiles[n-2] to tiles[n-1]),
///   no drain or each of the four drains, no feeds. 2 x 4 x 5 = 40.
/// - SINGLE tiles: each stored straight, no own direction, feeds 0 to 2, no drain or
///   each of the four. 2 x 21 x 5 = 210.
/// - STORED CORNERS, the no-seam and reversing passthrough: each of the 8 perpendicular
///   corners on a single tile with no seam, as a Tail with each own direction and no
///   seam, and as a Tail with each own direction fed straight against it. 8 x 9 = 72.
fn seam_cases() -> Vec<SeamCase> {
    let straights = [
        TileKind::Straight { axis: Axis::X },
        TileKind::Straight { axis: Axis::Y },
    ];
    let mut out = Vec::new();
    for stored in straights {
        for d in DIRS {
            for feeds in feed_lists() {
                out.push(case(stored, Some(d), Some(d), &feeds, None));
            }
        }
    }
    for stored in straights {
        for d in DIRS {
            out.push(case(stored, Some(d), Some(d), &[], None));
            for drain in DIRS {
                out.push(case(stored, Some(d), Some(d), &[], Some(drain)));
            }
        }
    }
    for stored in straights {
        for feeds in feed_lists() {
            out.push(case(stored, None, None, &feeds, None));
            for drain in DIRS {
                out.push(case(stored, None, None, &feeds, Some(drain)));
            }
        }
    }
    for from in DIRS {
        for to in DIRS {
            // Perpendicular pairs only: a `Corner` whose ends are equal or opposite is
            // not a bend `route()` can type.
            if (dir_byte(from) + dir_byte(to)).is_multiple_of(2) {
                continue;
            }
            let stored = TileKind::Corner { from, to };
            out.push(case(stored, None, None, &[], None));
            for d in DIRS {
                out.push(case(stored, Some(d), Some(d), &[], None));
            }
            for d in DIRS {
                let against = DIRS[(dir_byte(d) as usize + 2) % 4];
                out.push(case(stored, Some(d), Some(d), &[against], None));
            }
        }
    }
    out
}

/// FREEZER: `#[ignore]`d so `cargo test` never runs it. Run explicitly to (re)bless
/// the fixture, then COMMIT the produced `.bin` and `.expected.json`:
///   `cargo test -p fabrico-command freeze_seam -- --ignored`
#[test]
#[ignore = "explicit golden freezer; writes the committed seam fixture"]
fn freeze_seam() {
    let cases = seam_cases();
    assert_eq!(
        cases.len(),
        SEAM_CASE_COUNT,
        "the enumeration moved; update both literals"
    );

    let bytes = postcard::to_allocvec(&cases).expect("encode seam fixture");
    let json = serde_json::to_string_pretty(&cases).expect("pretty-json seam fixture");

    let dir = std::path::Path::new(BIN_PATH)
        .parent()
        .expect("fixture path has a parent dir");
    std::fs::create_dir_all(dir).expect("create fixtures dir");
    std::fs::write(BIN_PATH, &bytes).expect("write seam .bin");
    std::fs::write(JSON_PATH, format!("{json}\n")).expect("write seam .expected.json");
}

/// GUARD: always runs. Re-derives every case and asserts byte-equality with the
/// committed fixture; any drift in the Rust seam table fails here rather than silently
/// regenerating.
#[test]
fn seam_matches_frozen() {
    let cases = seam_cases();
    assert_eq!(
        cases.len(),
        SEAM_CASE_COUNT,
        "the enumeration moved; update both literals"
    );
    let bytes = postcard::to_allocvec(&cases).expect("encode seam fixture");
    let frozen = std::fs::read(BIN_PATH)
        .expect("seam fixture committed; run `freeze_seam -- --ignored` to bless it");
    assert_eq!(
        bytes, frozen,
        "seam_end_kind drifted from the frozen bytes; re-bless deliberately, never silently",
    );
}
