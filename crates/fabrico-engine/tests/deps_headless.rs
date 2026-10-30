//! The dependency check for the headless engine.
//!
//! `fabrico-engine` has to run outside the desktop host, so an async runtime, an HTTP stack, a
//! file database, a mailer, a renderer or the desktop shell must never enter its normal
//! dependency tree. This test asks `cargo tree` for the tree on every target, so a dependency
//! that exists on only one platform shows up too, and it compares exact package names, so a
//! longer name that happens to contain a forbidden word doesn't trip it.
//!
//! The tree is compared with a committed list, so any new package is a red test that someone has
//! to review, whatever it is called. The forbidden names are a second check: adding one of them to
//! the list stays red.

// The workspace-root `clippy.toml` disallows `std::process::Command` to keep the sim core free
// of ambient process IO. Spawning `cargo tree` from this test is the way to read the dependency
// tree, so the determinism lints are allowed in this one file.
#![allow(clippy::disallowed_types, clippy::disallowed_methods)]

use std::collections::BTreeSet;
use std::process::Command;

/// Every package the engine's normal dependency tree may hold, on any target, by name.
const ALLOWED: &[&str] = &[
    "allocator-api2",
    "arrayref",
    "arrayvec",
    "atomic-polyfill",
    "az",
    "bitflags",
    "blake3",
    "bytemuck",
    "byteorder",
    "cfg-if",
    "cobs",
    "constant_time_eq",
    "cpufeatures",
    "critical-section",
    "crunchy",
    "equivalent",
    "fabrico-command",
    "fabrico-core",
    "fabrico-engine",
    "fabrico-protocol",
    "fabrico-qjs-alloc",
    "fixed",
    "foldhash",
    "half",
    "hash32",
    "hashbrown",
    "heapless",
    "itoa",
    "libc",
    "lock_api",
    "memchr",
    "once_cell",
    "postcard",
    "ppv-lite86",
    "proc-macro2",
    "quote",
    "rand_chacha",
    "rand_core",
    "relative-path",
    "ron",
    "rquickjs",
    "rquickjs-core",
    "rquickjs-sys",
    "rustc-hash",
    "scopeguard",
    "serde",
    "serde_core",
    "serde_derive",
    "serde_json",
    "slotmap",
    "spin",
    "stable_deref_trait",
    "syn",
    "termcolor",
    "thiserror",
    "thiserror-impl",
    "ts-rs",
    "ts-rs-macros",
    "typeid",
    "typenum",
    "unicode-ident",
    "winapi-util",
    "windows-link",
    "windows-sys",
    "zerocopy",
    "zerocopy-derive",
    "zmij",
];

/// Packages that must never appear in the engine's normal dependency tree, and that a review must
/// not add to [`ALLOWED`].
const FORBIDDEN: &[&str] = &[
    "tokio",
    "async-std",
    "smol",
    "mio",
    "axum",
    "hyper",
    "reqwest",
    "ureq",
    "redb",
    "rusqlite",
    "sled",
    "tauri",
    "tauri-runtime",
    "wry",
    "lettre",
    "wgpu",
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

    let new: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| !ALLOWED.contains(name))
        .collect();
    assert!(
        new.is_empty(),
        "{new:?} entered fabrico-engine's normal dependency tree and is not on the allowed list.\n\
         Run `cargo tree -p fabrico-engine -e normal --target all -i <package>` to see what pulled \
         it in, and review what it does: the engine must stay free of an async runtime, an HTTP \
         stack, a file database, a mailer, a renderer and the desktop shell. If it does none of \
         those, add its name to ALLOWED in crates/fabrico-engine/tests/deps_headless.rs. Adding \
         it changes Cargo.lock, which also takes a reviewed move of the public-base tag.\n\
         --- cargo tree ---\n{tree}"
    );

    let stale: Vec<&str> = ALLOWED
        .iter()
        .copied()
        .filter(|allowed| !names.contains(allowed))
        .collect();
    assert!(
        stale.is_empty(),
        "{stale:?} are on the allowed list but not in fabrico-engine's normal dependency tree. \
         Remove them from ALLOWED in crates/fabrico-engine/tests/deps_headless.rs: an entry that \
         outlives its package would let that package come back with no review.\n\
         --- cargo tree ---\n{tree}"
    );
}
