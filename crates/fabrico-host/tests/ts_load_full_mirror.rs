//! Phase 91 review WR-A-01: the gauge's top level is mirrored once in TypeScript, and this locks
//! the two together.
//!
//! The port panel's backed-up rule (`frontend/src/protocol/portFlow.ts`) asks whether a
//! consumer takes any more from a belt by reading `NodeView.load === LOAD_FULL`, because the
//! state byte cannot answer it (FAULTED wins over a full inbox; BACKED_UP is also worn by a
//! machine waiting with room). The level is a host constant
//! ([`fabrico_host::render_packet::LOAD_FULL`]); the frontend copy must equal it.
//!
//! The `include_str!` plus named-anchor plus panic-on-miss idiom of
//! `crates/fabrico-command/tests/ts_label_mirror.rs`: an extractor that found nothing must not
//! let the comparison pass over it.
//!
//! Run target: `cargo test -p fabrico-host --test ts_load_full_mirror`

/// The frontend kind table, embedded at COMPILE time.
const KINDS_TS: &str = include_str!("../../../frontend/src/protocol/kinds.ts");

/// The declaration, written from the start of its line so a mention in a comment cannot match.
const ANCHOR: &str = "\nexport const LOAD_FULL = ";

/// The level the TypeScript side declares. PANICS on a missing anchor or a value that does not
/// parse.
fn ts_load_full() -> u8 {
    let at = KINDS_TS
        .find(ANCHOR)
        .unwrap_or_else(|| panic!("kinds.ts declares `export const LOAD_FULL = ` at the start of a line"));
    let rest = &KINDS_TS[at + ANCHOR.len()..];
    let value = rest.split(';').next().expect("the declaration ends with a semicolon").trim();
    value
        .parse()
        .unwrap_or_else(|e| panic!("kinds.ts LOAD_FULL is a plain integer, found {value:?}: {e}"))
}

#[test]
fn the_frontend_load_full_level_matches_the_host() {
    assert_eq!(
        ts_load_full(),
        fabrico_host::render_packet::LOAD_FULL,
        "frontend/src/protocol/kinds.ts LOAD_FULL must equal render_packet.rs LOAD_FULL"
    );
}
