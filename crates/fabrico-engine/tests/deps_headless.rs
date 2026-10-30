//! The dependency check for the headless engine.
//!
//! `fabrico-engine` has to run outside the desktop host, so an async runtime, an HTTP stack, a
//! file database, a mailer, a renderer or the desktop shell must never enter its normal
//! dependency tree. This test asks `cargo tree` for the tree on every target, so a dependency
//! that exists on only one platform shows up too, and it compares exact package names, so a
//! longer name that happens to contain a forbidden word doesn't trip it.

// The workspace-root `clippy.toml` disallows `std::process::Command` to keep the sim core free
// of ambient process IO. Spawning `cargo tree` from this test is the way to read the dependency
// tree, so the determinism lints are allowed in this one file.
#![allow(clippy::disallowed_types, clippy::disallowed_methods)]

use std::collections::BTreeSet;
use std::process::Command;

/// Packages that must never appear in the engine's normal dependency tree.
const FORBIDDEN: &[&str] = &[
    "tokio", "axum", "reqwest", "redb", "tauri", "lettre", "pixi", "wgpu",
];

/// Packages that must appear. A broken or empty `cargo tree` would otherwise pass.
const REQUIRED: &[&str] = &["fabrico-core", "fabrico-protocol"];

#[test]
fn deps_are_headless() {
    let output = Command::new(env!("CARGO"))
        .args([
            "tree",
            "-p",
            "fabrico-engine",
            "-e",
            "normal",
            "--target",
            "all",
            "--prefix",
            "none",
            "--format",
            "{p}",
        ])
        .output()
        .expect("run `cargo tree` to read the normal dependency tree");

    assert!(
        output.status.success(),
        "`cargo tree` failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let tree = String::from_utf8_lossy(&output.stdout);
    // Each line is `name vX.Y.Z`, sometimes followed by a path or `(*)`.
    let names: BTreeSet<&str> = tree
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .collect();

    for required in REQUIRED {
        assert!(
            names.contains(required),
            "`{required}` is missing from fabrico-engine's dependency tree, so this check is \
             not reading the tree it thinks it is.\n--- cargo tree ---\n{tree}"
        );
    }

    let breaches: Vec<&str> = FORBIDDEN
        .iter()
        .copied()
        .filter(|forbidden| names.contains(forbidden))
        .collect();
    assert!(
        breaches.is_empty(),
        "{breaches:?} entered fabrico-engine's normal dependency tree, and the engine has to \
         stay free of host I/O crates.\n--- cargo tree ---\n{tree}"
    );
}
