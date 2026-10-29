//! The Fabrico desktop binary — a thin entrypoint into the shell library.
//!
//! Desktop-window run/packaging is DEFERRED to the developer (CONTEXT); this
//! crate's Wave-5 gate is only that it `cargo check`s. Run it (once GTK/webkit dev
//! libs are present) with `cargo run -p fabrico-app`.

// Hide the extra console window on Windows in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fabrico_app_lib::run();
}
