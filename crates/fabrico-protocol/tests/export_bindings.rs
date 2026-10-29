//! ts-rs binding export — keeps the TypeScript shape in lock-step with the Rust
//! DTOs (threat T-07-WIRE-DRIFT). Running `cargo test` writes `RenderPacket.ts`
//! and its sibling type files into the crate's `bindings/` dir.
//!
//! The output dir is the ts-rs default (`./bindings`, overridable via
//! `TS_RS_EXPORT_DIR`), relative to the crate root during `cargo test`. That dir
//! is generated, never committed — its `.gitignore` entry is owned by 07-03, the
//! single Wave-1 `.gitignore` writer (Open Q3 / W3).
//!
//! NOTE: the `#[ts(export)]` attribute on each DTO ALSO emits its own
//! `export_bindings_*` test, so the bindings are produced even without this file;
//! this test additionally asserts the programmatic `export_all` API succeeds and
//! that the canonical `RenderPacket.ts` lands on disk.

use fabrico_protocol::{GridCommand, MachineCatalogEntry, RenderPacket};
use ts_rs::{Config, TS};

#[test]
fn export_bindings() {
    // `Config::from_env()` reads `TS_RS_EXPORT_DIR` (default `./bindings`)
    // internally — we read the resolved dir back off the Config rather than
    // touching `std::env::var` directly (banned by the workspace determinism
    // clippy gate; the env read lives inside ts-rs, not this crate).
    let cfg = Config::from_env();

    // Exporting each root type pulls in every dependency (NodeView, BeltView,
    // ItemView for the packet). export_all returns Ok or a typed ExportError.
    RenderPacket::export_all(&cfg).expect("RenderPacket bindings export");
    GridCommand::export_all(&cfg).expect("GridCommand bindings export");
    // CAT-05: the pre-placement ghost catalog surface (+ its CatalogPortView dep).
    MachineCatalogEntry::export_all(&cfg).expect("MachineCatalogEntry bindings export");

    // ts-rs resolves the (relative) export dir against the test's working
    // directory, which is the crate root under `cargo test`.
    let out_dir = std::env::current_dir()
        .expect("cwd available")
        .join(cfg.out_dir());
    let render_packet_ts = out_dir.join("RenderPacket.ts");
    assert!(
        render_packet_ts.exists(),
        "expected ts-rs to write {render_packet_ts:?}",
    );
    let grid_command_ts = out_dir.join("GridCommand.ts");
    assert!(
        grid_command_ts.exists(),
        "expected ts-rs to write {grid_command_ts:?}",
    );
    let catalog_ts = out_dir.join("MachineCatalogEntry.ts");
    assert!(
        catalog_ts.exists(),
        "expected ts-rs to write {catalog_ts:?}",
    );
    let catalog_port_ts = out_dir.join("CatalogPortView.ts");
    assert!(
        catalog_port_ts.exists(),
        "expected ts-rs to write {catalog_port_ts:?}",
    );
}
