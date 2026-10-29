//! Tauri build script — embeds `tauri.conf.json` (config + context) into the
//! binary at compile time. Required for `tauri::generate_context!()` in `lib.rs`.

fn main() {
    tauri_build::build();
}
