//! `read_project` - read a saved `.fab` project bundle OFFLINE and print what it
//! proves about a Router.
//!
//! Run it with:
//! ```text
//! cargo run -p fabrico-host --example read_project -- /path/to/factory.fab
//! ```
//!
//! # Why this exists (Phase 65, SC4)
//! The desktop application declares exactly two HTTP routes and both are POST-only
//! INJECT paths (`/hook/{target}` and `/endpoint/{target}`, see
//! `crate::ingress::webhook`). There is NO verb that returns board state, so
//! "read the routing outcome back through the running app" names something that
//! does not exist. The read-back that DOES exist is the saved project bundle: a
//! tick-boundary snapshot plus the certified edit log plus the ordered event log
//! (see [`fabrico_host::project`]). This example reads one and prints the two
//! halves of the routing claim:
//!
//! 1. **The certified record.** Every `EditOp::Configure` in the bundle's edit log
//!    that carries a router table, with its rules IN ORDER. This is what proves the
//!    table reached the log as a certified command rather than as a direct state
//!    write.
//! 2. **The resting state.** Each router's live ports with their roles and world
//!    cells, and, for every belt, which items are resting on which slot. This is
//!    what proves the items actually split.
//!
//! A screenshot is NOT a gate for that claim, and this report is why.
//!
//! # The untrusted-bytes boundary
//! The path is given at RUN TIME and nothing is embedded at compile time, because
//! the file it reads is produced by a human clicking save in the application. It is
//! read through the existing typed [`load_project`] loader, which refuses a forward
//! version, garbage bytes and an invariant-violating snapshot with typed errors and
//! never panics (T-65-39). A missing or malformed file leaves this example with a
//! one-line message and a non-zero exit, never a panic backtrace: the person running
//! it is reading a report, not debugging.

use std::path::Path;
use std::process::ExitCode;

use fabrico_core::edit::{EditOp, MachineConfig};
use fabrico_core::ids::PortId;
use fabrico_core::state::{Footprint, Medium, Node, Port, Role, RouteKey, Side, port_world};
use fabrico_host::driver::Host;
use fabrico_host::project::load_project;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(raw) = args.next() else {
        eprintln!(
            "read_project: no bundle path given.\n\
             usage: cargo run -p fabrico-host --example read_project -- <path-to.fab>"
        );
        return ExitCode::FAILURE;
    };
    if args.next().is_some() {
        eprintln!("read_project: expected exactly one argument, a path to a saved .fab bundle.");
        return ExitCode::FAILURE;
    }
    match report_for_path(Path::new(&raw)) {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("read_project: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Load `path` into a throwaway work dir and render the report.
///
/// Every failure is a message a reader can act on, never a panic: a missing file,
/// an unreadable temp dir, and each typed [`fabrico_host::project::ProjectError`]
/// all arrive here as `Err(String)`.
fn report_for_path(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Err(format!("{} does not exist.", path.display()));
    }
    // `load_project` REQUIRES a fresh, empty work dir (its next-sequence high-water
    // mark is correct by construction only over an empty store). A tempdir gives one
    // and drops it when the report is done - this reader never writes beside the
    // bundle it is reading.
    let work_dir = tempfile::tempdir()
        .map_err(|e| format!("could not open a temporary work directory: {e}"))?;
    let host = load_project(path, work_dir.path(), None)
        .map_err(|e| format!("{} could not be read: {e}", path.display()))?;
    Ok(render_report(&host, &path.display().to_string()))
}

/// The report itself: a header, the certified router configure records, the routers
/// in the restored state, and the per-belt resting items.
///
/// Pure over an already-loaded [`Host`], so the example and its test exercise the
/// SAME code path over the SAME bundle shape.
fn render_report(host: &Host, label: &str) -> String {
    let mut out = String::new();
    let edits = host.logged_edits().unwrap_or_default();
    let state = &host.core().state;

    out.push_str("fabrico project bundle report\n");
    out.push_str(&format!("  file: {label}\n"));
    out.push_str(&format!("  head tick: {}\n", host.core().tick));
    out.push_str(&format!("  nodes: {}\n", state.node_count()));
    out.push_str(&format!("  edit records: {}\n", edits.len()));

    // ---- half 1: the certified record ----------------------------------------
    out.push_str("\n== certified router configure records ==\n");
    let mut found = 0usize;
    for record in &edits {
        let EditOp::Configure { node, config, .. } = &record.op else {
            continue;
        };
        let MachineConfig::Router { routes, default } = config else {
            continue;
        };
        found += 1;
        out.push_str(&format!(
            "record {found}: edit sequence {}, tick {}, action {}, node {:?}\n",
            record.sequence, record.tick, record.action, node
        ));
        out.push_str(&render_table(routes, *default, "  "));
    }
    if found == 0 {
        out.push_str("none. No configure record in this bundle carries a router table.\n");
    }

    // ---- half 2: the resting state -------------------------------------------
    out.push_str("\n== routers in the restored state ==\n");
    let mut routers = 0usize;
    for id in state.node_ids().collect::<Vec<_>>() {
        let Some(Node::Router(router)) = state.node(id) else {
            continue;
        };
        routers += 1;
        let anchor = state.cell_of(id).unwrap_or((0, 0));
        let footprint = state
            .footprint_of(id)
            .unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
        out.push_str(&format!(
            "router {id:?} at cell ({}, {}), footprint {}x{} rot {}\n",
            anchor.0, anchor.1, footprint.w, footprint.h, footprint.rot
        ));
        let ports = state.ports_of(id).unwrap_or(&[]);
        if ports.is_empty() {
            out.push_str("  ports: none declared.\n");
        }
        let mut out_key: PortId = 0;
        for (index, port) in ports.iter().enumerate() {
            let (cell, side) = port_world(anchor, footprint.w, footprint.h, footprint.rot, port);
            // The ROUTING key of an Out port is its 0-based position among the node's
            // Role::Out ports, NOT its catalog index (`dock_link_key`). A rules table
            // names the routing key, so the report has to print both or a reader
            // cannot tie a rule to a nub.
            let key = match port.role {
                Role::Out => {
                    let k = out_key;
                    out_key += 1;
                    format!("out key {k}")
                }
                Role::Fault => "fault sentinel".to_string(),
                Role::In => "in".to_string(),
            };
            let link = match state.link_target((id, routing_key_of(ports, index))) {
                Some((to_node, to_port)) => format!(" -> linked to {to_node:?} port {to_port}"),
                None => String::new(),
            };
            out.push_str(&format!(
                "  port {index}: {} {} at ({}, {}) facing {} [{key}]{link}\n",
                role_label(port.role),
                medium_label(port.medium),
                cell.0,
                cell.1,
                side_label(side),
            ));
        }
        out.push_str("  live table:\n");
        out.push_str(&render_table(&router.routes, router.default, "    "));
        out.push_str(&format!("  faults: {}\n", router.faults));
    }
    if routers == 0 {
        out.push_str("none. This bundle restores no router node.\n");
    }

    out.push_str("\n== belts in the restored state ==\n");
    let mut belts = 0usize;
    for id in state.node_ids().collect::<Vec<_>>() {
        let Some(Node::Belt(belt)) = state.node(id) else {
            continue;
        };
        belts += 1;
        let cells = belt
            .geometry
            .iter()
            .map(|t| format!("({}, {})", t.cell.0, t.cell.1))
            .collect::<Vec<_>>()
            .join(" ");
        out.push_str(&format!(
            "belt {id:?}, {} tiles, {} slots, cells: {}\n",
            belt.tiles,
            belt.slots.len(),
            if cells.is_empty() {
                "none (a wire-minted logical belt)".to_string()
            } else {
                cells
            },
        ));
        let mut resting = 0usize;
        for (slot, held) in belt.slots.iter().enumerate() {
            if let Some(item) = held {
                resting += 1;
                out.push_str(&format!("  slot {slot}: {}\n", bytes_label(&item.0)));
            }
        }
        if resting == 0 {
            out.push_str("  no items resting.\n");
        }
    }
    if belts == 0 {
        out.push_str("none. This bundle restores no belt.\n");
    }

    out
}

/// The catalog index a link is keyed on for port `index` of `ports`.
///
/// `fold_dock` writes links in the EMIT keyspace: an `Role::Out` port's link key is
/// its 0-based position among the node's Out ports, an `Role::In` port's key is its
/// catalog index, and a `Role::Fault` port's key is the reserved `FAULT_PORT`
/// sentinel. This mirrors `fabrico_command`'s `dock_link_key` so the report can look
/// up the belt a nub actually feeds.
fn routing_key_of(ports: &[Port], index: usize) -> PortId {
    match ports[index].role {
        Role::Out => ports[..index]
            .iter()
            .filter(|p| p.role == Role::Out)
            .count()
            .try_into()
            .unwrap_or(PortId::MAX),
        Role::Fault => PortId::MAX,
        Role::In => PortId::try_from(index).unwrap_or(PortId::MAX),
    }
}

/// Render a routing table (rules in authored order, then the default) at `indent`.
///
/// ORDER IS THE BEHAVIOUR - the first matching rule wins - so the rules are printed
/// in the order they are stored, never sorted, and each carries its own index.
fn render_table(routes: &[(RouteKey, PortId)], default: Option<PortId>, indent: &str) -> String {
    let mut out = String::new();
    if routes.is_empty() {
        out.push_str(&format!("{indent}rules: none (an empty table).\n"));
    }
    for (rule, (key, port)) in routes.iter().enumerate() {
        out.push_str(&format!(
            "{indent}rule {rule}: offset {}, expect {} -> out key {port}\n",
            key.offset,
            bytes_label(&key.expect),
        ));
    }
    match default {
        Some(port) => out.push_str(&format!("{indent}default: out key {port}\n")),
        None => out.push_str(&format!(
            "{indent}default: none, so an unmatched item leaves on the fault port.\n"
        )),
    }
    out
}

/// A byte string as both its printable-ASCII text (when it is one) and its hex, so
/// the report is readable for the `b"A"` case without lying about a non-UTF-8 one.
fn bytes_label(bytes: &[u8]) -> String {
    let hex = bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ");
    if bytes.is_empty() {
        return "(empty)".to_string();
    }
    if bytes.iter().all(|b| (0x20..0x7f).contains(b)) {
        let text = String::from_utf8_lossy(bytes);
        format!("\"{text}\" (0x{hex})")
    } else {
        format!("0x{hex}")
    }
}

fn role_label(role: Role) -> &'static str {
    match role {
        Role::In => "in   ",
        Role::Out => "out  ",
        Role::Fault => "fault",
    }
}

fn medium_label(medium: Medium) -> &'static str {
    match medium {
        Medium::Mechanical => "mechanical",
        Medium::Electrical => "electrical",
    }
}

fn side_label(side: Side) -> &'static str {
    match side {
        Side::N => "N",
        Side::E => "E",
        Side::S => "S",
        Side::W => "W",
    }
}

#[cfg(test)]
mod tests {
    //! The reader is itself verified: build a scene in memory, drive the router's
    //! table through the REAL certified gesture path, save a bundle with
    //! `save_project`, and read it back through the SAME `report_for_path` the
    //! example's `main` calls. The example target sets `test = true` in
    //! `crates/fabrico-host/Cargo.toml` so `cargo test -p fabrico-host` runs this.

    use super::*;
    use fabrico_core::command::{Command, ResultEvent};
    use fabrico_core::core::Core;
    use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
    use fabrico_core::ids::Item;
    use fabrico_core::persist::RedbStore;
    use fabrico_host::input_apply::apply_gesture;
    use fabrico_host::ledger::DispatchLedger;
    use fabrico_host::project::save_project;
    use fabrico_protocol::{
        GridCommand, MachineConfig as WireConfig, RouteKey as WireRouteKey, machine_kind,
    };
    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

    #[allow(clippy::type_complexity)]
    fn channels() -> (
        UnboundedReceiver<EventPayload>,
        UnboundedSender<Command>,
        UnboundedReceiver<ResultEvent>,
    ) {
        let (_ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
        let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, results_rx) = unbounded_channel::<ResultEvent>();
        (ingress_rx, cmd_tx, results_rx)
    }

    #[allow(clippy::disallowed_methods)]
    /// A bundle carrying a certified two-rule router table and one item resting on a
    /// belt, plus the tempdir that owns the file.
    fn saved_bundle() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        // snapshot_every = 1 so the persisted base snapshot is taken AT the head tick:
        // `save_project` then bundles a base whose tick equals `head_tick`, and the
        // load replays nothing forward. That is what makes the resting state the
        // report prints the state that was actually saved.
        let mut host = Host::new(core, store, ledger, Some(1)).expect("open host");
        let (mut ingress_rx, cmd_tx, mut results_rx) = channels();

        // The router goes in through the REAL gesture path, so its ports come from
        // the shared catalog rather than from a literal written here.
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::ROUTER,
                cell_x: 4,
                cell_y: 1,
            },
            |_h| None,
        )
        .expect("place the router");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("fold the place");
        let router = *host
            .core()
            .last_tick
            .placed
            .last()
            .expect("the placed router minted an id");

        // The table goes in as a certified `EditOp::Configure`, never as a direct
        // state write - that is the half of the report this asserts.
        apply_gesture(
            &mut host,
            GridCommand::Configure {
                node: 0,
                config: WireConfig::Router {
                    routes: vec![
                        (
                            WireRouteKey {
                                offset: 0,
                                expect: b"A".to_vec(),
                            },
                            0,
                        ),
                        (
                            WireRouteKey {
                                offset: 0,
                                expect: b"B".to_vec(),
                            },
                            1,
                        ),
                    ],
                    default: Some(2),
                },
            },
            move |h| (h == 0).then_some(router),
        )
        .expect("configure the router");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("fold the configure");

        // A belt with an item resting on its HEAD slot. The head is DANGLING (no link
        // out of it), which is exactly the 65-08 offload shape: a dangling head HOLDS
        // the item, so the outcome stays readable from `GridState` instead of being a
        // transient a sink would consume.
        let belt = host.core_mut().state.add_belt(1);
        if let Some(Node::Belt(b)) = host.core_mut().state.node_mut(belt) {
            b.slots[0] = Some(Item(b"A".to_vec()));
        }
        // An occupied belt MUST be on the wheel: `snapshot::restore`'s trust gate
        // rejects an occupied-but-unscheduled belt as
        // `StateInvariant::BeltWakeMissing`, and it caught this fixture the first time
        // it was written. Waking it is what a real admit would have done.
        let now = host.core().tick;
        host.core_mut().sched.schedule_wake(belt, now);
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick to a snapshot boundary that captures the resting item");

        let path = dir.path().join("router.fab");
        save_project(&host, &path).expect("save the bundle");
        // Evidence hook: set FABRICO_BUNDLE_OUT to keep a copy of this bundle
        // somewhere that outlives the tempdir, so the EXAMPLE BINARY can be run
        // against it and its real stdout pasted into an evidence artifact. Absent
        // the variable this is a no-op, so a plain `cargo test` writes nothing
        // outside its own tempdir.
        if let Ok(out) = std::env::var("FABRICO_BUNDLE_OUT") {
            std::fs::copy(&path, out).expect("copy the bundle to FABRICO_BUNDLE_OUT");
        }
        (dir, path)
    }

    #[test]
    fn report_names_the_certified_table_and_the_resting_item() {
        let (_dir, path) = saved_bundle();
        let text = report_for_path(&path).expect("the saved bundle reads back");

        // Half 1: the certified record, rules IN ORDER.
        assert!(
            text.contains("== certified router configure records =="),
            "the report has a certified-record section:\n{text}"
        );
        assert!(
            text.contains("record 1:"),
            "the configure record is found:\n{text}"
        );
        let first = text
            .find("rule 0: offset 0, expect \"A\" (0x41) -> out key 0")
            .unwrap_or_else(|| panic!("rule 0 is reported verbatim:\n{text}"));
        let second = text
            .find("rule 1: offset 0, expect \"B\" (0x42) -> out key 1")
            .unwrap_or_else(|| panic!("rule 1 is reported verbatim:\n{text}"));
        assert!(
            first < second,
            "order IS the behaviour, so rule 0 must print before rule 1:\n{text}"
        );
        assert!(
            text.contains("default: out key 2"),
            "the default is reported:\n{text}"
        );

        // Half 2: the resting state.
        assert!(
            text.contains("router "),
            "the restored router is reported:\n{text}"
        );
        assert!(
            text.contains("out key 0"),
            "the router's Out nubs carry their routing keys:\n{text}"
        );
        assert!(
            text.contains("slot 0: \"A\" (0x41)"),
            "the item resting on the belt is reported with its slot:\n{text}"
        );
    }

    #[test]
    fn a_missing_file_is_a_message_not_a_panic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("nothing-here.fab");
        let err = report_for_path(&missing).expect_err("a missing file is refused");
        assert!(
            err.contains("does not exist"),
            "the refusal says what is wrong: {err}"
        );
    }

    // `fabrico-host` is the project's sanctioned I/O home and this test writes a
    // deliberately corrupt file to prove the refusal path; scope the determinism-gate
    // allow to it, exactly as `project::save_project` scopes its own.
    #[allow(clippy::disallowed_methods)]
    #[test]
    fn garbage_bytes_are_a_typed_refusal_not_a_panic() {
        // T-65-39: the reader goes through the existing typed loader, so a hostile or
        // corrupt file is a message and a non-zero exit rather than a panic backtrace.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("garbage.fab");
        std::fs::write(&path, [0xffu8; 64]).expect("write garbage");
        let err = report_for_path(&path).expect_err("garbage is refused");
        assert!(
            err.contains("could not be read"),
            "the refusal names the file and the reason: {err}"
        );
    }
}
