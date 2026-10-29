//! The `configure-gridcommand` cross-language golden fixture — the byte anchor for
//! the CFG-01 [`GridCommand::Configure`] wire shape (disc 9), pinning the exact
//! postcard bytes the future hand-rolled TypeScript encoder (Phase 39-05) must
//! reproduce.
//!
//! This is a SEPARATE artifact from the `gridcommand` fixture (which pins the
//! surviving Place/Delete/Rotate/DrawBelt variants and MUST stay byte-identical when
//! `Configure` is appended last). It exists because `MachineConfig` and its nested
//! `SourceTrigger`/`SinkTemplate`/`HttpMethod` enums have a LOAD-BEARING variant order
//! (Factory=0/Source=1/Sink=2/Belt=3/Router=4; Webhook=0/Timer=1;
//! Debug=0/Http=1; Get=0..Delete=4) that the TS encoder mirrors — a single
//! `.bin` covering every nested variant is what actually protects the cross-language
//! byte contract (T-39-WIRE-DRIFT).
//!
//! `Belt` and `Router` were appended to `MachineConfig` in Phase 63-04 and added to
//! this vector in 63-05. Extending it was a DECISION, not a default: the fixture stayed
//! green without them, because no entry constructed one and the appends therefore moved
//! no encoded byte — which is exactly the problem. Two of five variants would have been
//! pinned by nothing while this header went on claiming the file covers every one.
//!
//! Two parts, mirroring `golden_gridcommand.rs`'s freezer discipline:
//!   - [`freeze_configure_gridcommand`] (`#[ignore]`d) is the ONLY writer: it
//!     postcard-encodes [`fixture_commands`] to
//!     `tests/fixtures/configure-gridcommand.bin` and the same value as pretty JSON to
//!     `tests/fixtures/configure-gridcommand.expected.json`. `cargo test` NEVER runs it,
//!     so the fixture is never silently regenerated; re-freezing is explicit:
//!     `cargo test -p fabrico-protocol freeze_configure_gridcommand -- --ignored`
//!   - [`configure_gridcommand_matches_frozen`] (always runs) re-encodes the same
//!     literal and asserts it equals the committed `.bin` bytes AND decodes back equal —
//!     so any schema drift FAILS CI instead of silently re-blessing (T-39-WIRE-DRIFT).
//!
//! Cross-language consumer: the 39-05 TS encoder reads
//! `crates/fabrico-protocol/tests/fixtures/configure-gridcommand.bin` via a relative
//! path, decodes it, and asserts the decoded object deep-equals
//! `configure-gridcommand.expected.json`. The `.bin` is the byte truth; the `.json` is
//! the human/TS-readable expected object.
#![allow(clippy::disallowed_methods)] // golden freezer: needs std::fs (write/read); freeze step is #[ignore]d.

use fabrico_protocol::{
    GridCommand, HttpMethod, MachineConfig, RouteKey, SinkTemplate, SourceTrigger,
};

/// Absolute path to the frozen postcard bytes (resolved at compile time so the test is
/// CWD-independent).
const BIN_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/configure-gridcommand.bin"
);
/// Absolute path to the human/TS-readable expected JSON sibling.
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/configure-gridcommand.expected.json"
);

/// The known, deterministic `Configure` reference vector — one command per nested wire
/// variant so the cross-language golden pins EVERY load-bearing discriminant:
///   1. `Factory` (disc 0) with a short JS string — the representative Factory config.
///   2. `Source{Timer}` (Source disc 1, trigger disc 1) with an interval.
///   3. `Source{Webhook}` (trigger disc 0, fieldless).
///   4. `Sink{Http}` (Sink disc 2, template disc 1) with a NON-default `HttpMethod::Patch`
///      (disc 3) — pins both the `SinkTemplate::Http` and the `HttpMethod` byte.
///   5. `Sink{Debug}` (template disc 0, fieldless).
///   6. `Belt` (disc 3, Phase 63) with a plain varint interval.
///   7. `Router` (disc 4, Phase 63) with a NON-empty `routes` table whose two rules carry
///      `expect` byte vectors of DIFFERENT lengths, and a `Some` default.
///
/// The Belt and Router entries were APPENDED at the end of the list (63-05) so the
/// original commands kept their positions and the re-freeze diff stayed legible. Phase
/// 85 (plan 85-05, D-08) deleted the `Sink{Email}` entry with the Email target itself:
/// `SinkTemplate::Http` moved from discriminant 2 to 1, and the fixture was re-frozen.
///
/// # Why the Router entry is not empty
/// An empty `routes` with `default: None` would pin the DISCRIMINANT and nothing about
/// the payload, and the payload is where a cross-language encoder actually drifts: a
/// `Vec<(RouteKey, u16)>` is a length prefix, then per rule a `u16` offset, a
/// length-prefixed byte vector and a `u16` port. Two rules with different `expect`
/// lengths is what makes a mis-sized length prefix visible rather than accidentally
/// correct.
///
/// Every command rides `GridCommand::Configure` at disc 9 with NO `code_hash` on the wire.
fn fixture_commands() -> Vec<GridCommand> {
    vec![
        GridCommand::Configure {
            node: 42,
            config: MachineConfig::Factory {
                source: "export default (x) => x + 1".to_string(),
            },
        },
        GridCommand::Configure {
            node: 7,
            config: MachineConfig::Source {
                trigger: SourceTrigger::Timer { interval_ticks: 60 },
            },
        },
        GridCommand::Configure {
            node: 9,
            config: MachineConfig::Source {
                trigger: SourceTrigger::Webhook,
            },
        },
        GridCommand::Configure {
            node: 3,
            config: MachineConfig::Sink {
                target: SinkTemplate::Http {
                    url: "http://127.0.0.1/hook".to_string(),
                    method: HttpMethod::Patch,
                },
            },
        },
        GridCommand::Configure {
            node: 6,
            config: MachineConfig::Sink {
                target: SinkTemplate::Debug,
            },
        },
        GridCommand::Configure {
            node: 11,
            config: MachineConfig::Belt {
                ticks_per_slot: 12,
            },
        },
        GridCommand::Configure {
            node: 13,
            config: MachineConfig::Router {
                routes: vec![
                    (
                        RouteKey {
                            offset: 0,
                            expect: vec![0x7b],
                        },
                        1,
                    ),
                    (
                        RouteKey {
                            offset: 4,
                            expect: vec![0xde, 0xad, 0xbe, 0xef],
                        },
                        2,
                    ),
                ],
                default: Some(0),
            },
        },
    ]
}

/// FREEZER — `#[ignore]`d so `cargo test` never runs it. Run explicitly to (re)bless the
/// fixture, then COMMIT the produced `.bin` + `.expected.json`:
///   `cargo test -p fabrico-protocol freeze_configure_gridcommand -- --ignored`
#[test]
#[ignore = "explicit golden freezer; writes the committed configure-gridcommand fixture"]
fn freeze_configure_gridcommand() {
    let cmds = fixture_commands();

    let bytes = postcard::to_allocvec(&cmds).expect("encode configure-gridcommand fixture");
    let json =
        serde_json::to_string_pretty(&cmds).expect("pretty-json configure-gridcommand fixture");

    let dir = std::path::Path::new(BIN_PATH)
        .parent()
        .expect("fixture path has a parent dir");
    std::fs::create_dir_all(dir).expect("create fixtures dir");
    std::fs::write(BIN_PATH, &bytes).expect("write configure-gridcommand .bin");
    std::fs::write(JSON_PATH, format!("{json}\n")).expect("write configure-gridcommand .expected.json");
}

/// GUARD — always runs. Re-encodes the literal and asserts byte-equality with the
/// committed fixture AND that the frozen bytes decode back to the same value; schema
/// drift fails here rather than silently regenerating.
#[test]
fn configure_gridcommand_matches_frozen() {
    let cmds = fixture_commands();
    let bytes = postcard::to_allocvec(&cmds).expect("encode configure-gridcommand fixture");
    let frozen = std::fs::read(BIN_PATH).expect(
        "configure-gridcommand fixture committed; run \
         `freeze_configure_gridcommand -- --ignored` to bless it",
    );
    assert_eq!(
        bytes, frozen,
        "GridCommand::Configure schema drifted from the frozen bytes — re-bless deliberately, never silently",
    );
    // The frozen bytes decode back to the exact source commands (round-trip closure).
    let decoded: Vec<GridCommand> =
        postcard::from_bytes(&frozen).expect("the frozen configure-gridcommand bytes decode");
    assert_eq!(
        decoded, cmds,
        "the frozen configure-gridcommand bytes decode back to the source commands",
    );
}
