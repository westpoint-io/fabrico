//! The `route` cross-language golden fixture — the contract anchor between the Rust
//! pure belt normalizer [`route`] and the future hand-rolled TypeScript `route()` port
//! (14-06) that powers the draw-belt GHOST preview. It freezes the exact
//! `cells -> Vec<BeltTile>` mapping so the TS preview produces shape-identical tiles
//! and `preview == commit` holds CROSS-LANGUAGE (BELT-03).
//!
//! This is a SEPARATE artifact from the `gridcommand` fixture (which pins the
//! render→sim COMMAND wire bytes). `route` pins the RESOLVED tile geometry the
//! command layer derives from a `DrawBelt`'s raw cells — the same fn the UI ghost calls.
//!
//! Two parts, mirroring the `golden_gridcommand.rs` freezer discipline verbatim:
//!   - [`freeze_route`] (`#[ignore]`d) is the ONLY writer: it postcard-encodes the
//!     known [`fixture_tiles`] to `tests/fixtures/route.bin` and the same value as
//!     pretty JSON to `tests/fixtures/route.expected.json`. `cargo test` NEVER runs
//!     it, so the fixture is never silently regenerated; re-freezing is an explicit,
//!     reviewed act:
//!     `cargo test -p fabrico-command freeze_route -- --ignored`
//!   - [`route_matches_frozen`] (always runs) re-routes the same cells and asserts the
//!     encoding equals the committed `.bin` bytes — so any drift in `route()`'s
//!     geometry FAILS CI instead of silently re-blessing (threat T-14-PREVIEW-DRIFT).
//!
//! Cross-language consumer: a future TS `route.test.ts` (14-06) reads
//! `crates/fabrico-command/tests/fixtures/route.bin` (or the `.expected.json`) via a
//! relative path and asserts its `route()` port produces shape-identical tiles. The
//! `.bin` is the byte truth; the `.json` is the human/TS-readable expected object.
//!
//! `fabrico-command`'s `deps_are_headless` fence bans renderer/IO/host deps from the
//! NORMAL tree only; this freezer legitimately needs `std::fs`, so it carries the same
//! file-scoped escape `golden_gridcommand.rs` uses — SCOPED to this one test file.
#![allow(clippy::disallowed_methods)] // golden freezer: needs std::fs (write/read); freeze step is #[ignore]d.

use fabrico_command::route;
use fabrico_core::state::BeltTile;

/// Absolute path to the frozen postcard bytes (resolved at compile time so the
/// test is CWD-independent).
const BIN_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/route.bin");
/// Absolute path to the human/TS-readable expected JSON sibling.
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/route.expected.json"
);

/// The known, deterministic drawn path the golden freezes: the canonical L-bend
/// `(0,0) -> (1,0) -> (1,1)` (travel E into the bend, then S out of it). It exercises
/// BOTH a `Straight` run AND an auto-inferred `Corner` in one short fixture:
///   - tile 0 `(0,0)` = `Straight { axis: X }` (tail/admit end, single out-dir E)
///   - tile 1 `(1,0)` = `Corner   { from: E, to: S }` (the single bend)
///   - tile 2 `(1,1)` = `Straight { axis: Y }` (head/deliver end, single in-dir S)
///
/// This is the exact mapping `route.rs::l_bend_produces_exactly_one_corner...` asserts.
const FIXTURE_CELLS: &[(i32, i32)] = &[(0, 0), (1, 0), (1, 1)];

/// Route the known cells into the typed tiles the golden freezes. `route()` is PURE
/// and deterministic, so this is the byte-identical value both the freezer and the
/// guard encode (preview == commit at the function level).
fn fixture_tiles() -> Vec<BeltTile> {
    route(FIXTURE_CELLS).expect("the canonical L-bend routes (straight + corner + straight)")
}

/// FREEZER — `#[ignore]`d so `cargo test` never runs it. Run explicitly to
/// (re)bless the fixture, then COMMIT the produced `.bin` + `.expected.json`:
///   `cargo test -p fabrico-command freeze_route -- --ignored`
#[test]
#[ignore = "explicit golden freezer; writes the committed route fixture"]
fn freeze_route() {
    let tiles = fixture_tiles();

    let bytes = postcard::to_allocvec(&tiles).expect("encode route fixture");
    let json = serde_json::to_string_pretty(&tiles).expect("pretty-json route fixture");

    let dir = std::path::Path::new(BIN_PATH)
        .parent()
        .expect("fixture path has a parent dir");
    std::fs::create_dir_all(dir).expect("create fixtures dir");
    std::fs::write(BIN_PATH, &bytes).expect("write route .bin");
    std::fs::write(JSON_PATH, format!("{json}\n")).expect("write route .expected.json");
}

/// GUARD — always runs. Re-routes the same cells and asserts byte-equality with the
/// committed fixture; any geometry drift fails here rather than silently regenerating.
#[test]
fn route_matches_frozen() {
    let bytes = postcard::to_allocvec(&fixture_tiles()).expect("encode route fixture");
    let frozen = std::fs::read(BIN_PATH)
        .expect("route fixture committed; run `freeze_route -- --ignored` to bless it");
    assert_eq!(
        bytes, frozen,
        "route() geometry drifted from the frozen bytes — re-bless deliberately, never silently",
    );
}
