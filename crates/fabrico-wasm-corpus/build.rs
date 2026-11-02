//! Exports the bounds of wasm's linear-memory stack from the harness module, so the fence report
//! can read its size and check that it is larger than the stack limit. A native build gets
//! nothing from this file.

// Reading the environment is how a build script learns its target. The lint's rule is about the
// simulation, and this file never runs inside one.
#![allow(clippy::disallowed_methods)]

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-cdylib-link-arg=--export=__stack_low");
        println!("cargo:rustc-cdylib-link-arg=--export=__stack_high");
    }
}
