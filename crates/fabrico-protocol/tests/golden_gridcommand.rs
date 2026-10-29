//! The `gridcommand` cross-language golden fixture — the contract anchor between
//! the Rust postcard encoder and the future hand-rolled TypeScript decoder that
//! drives the grid through [`GridCommand`] (CMD-04, "one schema, two producers").
//!
//! This is a SEPARATE artifact from the `0007` render-packet fixture (which pins
//! the sim→render `RenderPacket`). It is named `gridcommand` precisely to avoid
//! the `0007` confusion (RESEARCH Pitfall 1) and does NOT touch
//! `tests/fixtures/0007-render-packet.bin`.
//!
//! Two parts, mirroring the `golden_0007.rs` freezer discipline:
//!   - [`freeze_gridcommand`] (`#[ignore]`d) is the ONLY writer: it
//!     postcard-encodes the known [`fixture_commands`] to
//!     `tests/fixtures/gridcommand.bin` and the same value as pretty JSON to
//!     `tests/fixtures/gridcommand.expected.json`. `cargo test` NEVER runs it, so
//!     the fixture is never silently regenerated; re-freezing is an explicit,
//!     reviewed act:
//!     `cargo test -p fabrico-protocol freeze_gridcommand -- --ignored`
//!   - [`gridcommand_matches_frozen`] (always runs) re-encodes the same literal
//!     and asserts it equals the committed `.bin` bytes — so any schema drift
//!     FAILS CI instead of silently re-blessing (threat T-8-WIRE-DRIFT).
//!
//! Cross-language consumer: a future TS decoder reads
//! `crates/fabrico-protocol/tests/fixtures/gridcommand.bin` via a relative path,
//! decodes it, and asserts the decoded object deep-equals
//! `gridcommand.expected.json`. The `.bin` is the byte truth; the `.json` is the
//! human/TS-readable expected object.
//!
//! `fabrico-protocol` has no determinism clippy gate of its own, but the
//! workspace `clippy.toml` bans `std::fs::*`; this freezer legitimately needs it,
//! so it carries the same file-scoped escape `golden_0007.rs` uses — SCOPED to
//! this one file.
#![allow(clippy::disallowed_methods)] // golden freezer: needs std::fs (write/read); freeze step is #[ignore]d.

use fabrico_protocol::{GridCommand, machine_kind};

/// Absolute path to the frozen postcard bytes (resolved at compile time so the
/// test is CWD-independent).
const BIN_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/gridcommand.bin");
/// Absolute path to the human/TS-readable expected JSON sibling.
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/gridcommand.expected.json"
);

/// The known, deterministic `gridcommand` literal — one of each surviving variant:
/// a `Place` of a SOURCE at a distinct cell (disc 0), a `Delete` of a dense handle
/// (disc 1), a `Rotate` (disc 2) of a distinct dense handle counter-clockwise, and
/// a `DrawBelt` (disc 3) carrying a short orthogonal L-path. Wire removal (17-02)
/// renumbered the discriminants DOWN: `Delete 2→1, Rotate 3→2, DrawBelt 4→3` — this
/// fixture re-freezes to the post-Wire-removal byte shape that the TS
/// `encodeGridCommand` branches must reproduce.
fn fixture_commands() -> Vec<GridCommand> {
    vec![
        GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 3,
            cell_y: 4,
        },
        // disc 1 — a delete of a distinct dense handle.
        GridCommand::Delete { node: 300 },
        // disc 2 — a relative quarter-turn of a distinct dense handle, ccw.
        GridCommand::Rotate {
            node: 400,
            ccw: true,
        },
        // disc 3 — a short orthogonal drawn path (E then S; the route() L-bend).
        GridCommand::DrawBelt {
            cells: vec![(0, 0), (1, 0), (1, 1)],
        },
    ]
}

/// FREEZER — `#[ignore]`d so `cargo test` never runs it. Run explicitly to
/// (re)bless the fixture, then COMMIT the produced `.bin` + `.expected.json`:
///   `cargo test -p fabrico-protocol freeze_gridcommand -- --ignored`
#[test]
#[ignore = "explicit golden freezer; writes the committed gridcommand fixture"]
fn freeze_gridcommand() {
    let cmds = fixture_commands();

    let bytes = postcard::to_allocvec(&cmds).expect("encode gridcommand fixture");
    let json = serde_json::to_string_pretty(&cmds).expect("pretty-json gridcommand fixture");

    let dir = std::path::Path::new(BIN_PATH)
        .parent()
        .expect("fixture path has a parent dir");
    std::fs::create_dir_all(dir).expect("create fixtures dir");
    std::fs::write(BIN_PATH, &bytes).expect("write gridcommand .bin");
    std::fs::write(JSON_PATH, format!("{json}\n")).expect("write gridcommand .expected.json");
}

/// GUARD — always runs. Re-encodes the literal and asserts byte-equality with the
/// committed fixture; schema drift fails here rather than silently regenerating.
#[test]
fn gridcommand_matches_frozen() {
    let bytes = postcard::to_allocvec(&fixture_commands()).expect("encode gridcommand fixture");
    let frozen = std::fs::read(BIN_PATH)
        .expect("gridcommand fixture committed; run `freeze_gridcommand -- --ignored` to bless it");
    assert_eq!(
        bytes, frozen,
        "GridCommand schema drifted from the frozen bytes — re-bless deliberately, never silently",
    );
}
