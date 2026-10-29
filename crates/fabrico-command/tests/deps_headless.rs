//! The CMD-03 / SC#1 dependency fence.
//!
//! `fabrico-command` is the HEADLESS command layer: it must never pull a renderer,
//! an async runtime, an HTTP stack, a mailer, or the desktop shell into its normal
//! dependency tree. This test runs `cargo tree -p fabrico-command -e normal` and
//! fails the build if any of those forbidden crates appear — so a future `use
//! tokio::…` or a stray dependency edit is caught in CI, not in review.
//!
//! Spawning `cargo` from a test is fine here: `fabrico-command` has NO crate-scoped
//! determinism clippy gate of its own (only `fabrico-core` does), so this process
//! spawn does not violate any determinism discipline.

// The workspace-root `clippy.toml` disallows `std::process::Command` to keep the
// sim CORE free of ambient process IO. `fabrico-command` has no such determinism
// gate of its own (only `fabrico-core` does); spawning `cargo tree` from THIS test
// is the sanctioned way to inspect the dependency tree, so the determinism lints are
// allowed for this fence test only.
#![allow(clippy::disallowed_types, clippy::disallowed_methods)]

use std::process::Command;

/// The renderer/IO/host crates that must NEVER appear in the headless normal tree.
const FORBIDDEN: &[&str] = &[
    "tauri", "tokio", "axum", "reqwest", "lettre", "pixi", "wgpu",
];

#[test]
fn deps_are_headless() {
    let output = Command::new(env!("CARGO"))
        .args(["tree", "-p", "fabrico-command", "-e", "normal"])
        .output()
        .expect("run `cargo tree` to inspect the normal dependency tree");

    assert!(
        output.status.success(),
        "`cargo tree` failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let tree = String::from_utf8_lossy(&output.stdout);
    for forbidden in FORBIDDEN {
        assert!(
            !tree.contains(forbidden),
            "headless dependency fence breached (CMD-03/SC#1): `{forbidden}` is in \
             fabrico-command's normal dependency tree.\n--- cargo tree -e normal ---\n{tree}"
        );
    }
}
