//! `replay_hash` - read a saved `.fab` bundle headlessly and print the tick it holds, the
//! state digest of that tick and its edit log.
//!
//! Run it with:
//! ```text
//! cargo run -p fabrico-host --example replay_hash -- /path/to/board.fab
//! ```
//!
//! The output is three kinds of line, in this order:
//! ```text
//! tick <head tick>
//! hash <tick_hash of the loaded core>
//! edit <sequence> <tick> <action> <op, Debug form>
//! ```
//!
//! # Why this exists
//! The frontend, the live suite and the desktop app read no state digest, and a live board
//! advances on wall-clock time. To say that two sittings of the same gestures produced the
//! same board, a test saves each board through the toolbar and compares what this tool prints
//! from the files. The edit lines are printed as well as the hash because a save may bundle
//! the head snapshot as its base, in which case the load replays nothing and the hash alone
//! would say nothing about the log.
//!
//! This is a test tool. Cargo builds it only when asked for the example, and the desktop app
//! links the `fabrico-host` library and never its examples.
//!
//! # The untrusted-bytes boundary
//! The path is given at run time and the bytes are read through the typed [`load_project`]
//! loader. A missing or malformed file ends in a one-line message and a non-zero exit, never
//! a panic.

use std::path::Path;
use std::process::ExitCode;

use fabrico_host::project::load_project;
use fabrico_scenario::oracle::tick_hash;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(raw) = args.next() else {
        eprintln!("replay_hash: no bundle path given. usage: replay_hash <path-to.fab>");
        return ExitCode::FAILURE;
    };
    if args.next().is_some() {
        eprintln!("replay_hash: expected exactly one argument, a path to a saved .fab bundle.");
        return ExitCode::FAILURE;
    }
    match report_for_path(Path::new(&raw)) {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("replay_hash: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Load `path` into a throwaway work dir and print its tick, hash and edit lines.
///
/// A broken edit log is an error here rather than an empty list: a comparison over a log
/// that failed to read would pass for the wrong reason.
fn report_for_path(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Err(format!("{} does not exist.", path.display()));
    }
    // `load_project` requires a fresh, empty work dir, and this reader never writes beside
    // the bundle it is reading.
    let work_dir = tempfile::tempdir()
        .map_err(|e| format!("could not open a temporary work directory: {e}"))?;
    let host = load_project(path, work_dir.path(), None)
        .map_err(|e| format!("{} could not be read: {e}", path.display()))?;
    let edits = host
        .logged_edits()
        .map_err(|e| format!("{} holds an edit log that could not be read: {e}", path.display()))?;

    let mut out = String::new();
    out.push_str(&format!("tick {}\n", host.core().tick));
    out.push_str(&format!("hash {}\n", tick_hash(host.core())));
    for edit in &edits {
        out.push_str(&format!(
            "edit {} {} {} {:?}\n",
            edit.sequence, edit.tick, edit.action, edit.op
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    //! Save real bundles with `save_project`, driven through the real gesture path, and read
    //! them back through the same `report_for_path` that `main` calls. The example target
    //! sets `test = true` in `crates/fabrico-host/Cargo.toml` so these run at all.

    use super::*;
    use fabrico_core::command::{Command, ResultEvent};
    use fabrico_core::core::Core;
    use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
    use fabrico_core::persist::RedbStore;
    use fabrico_host::driver::Host;
    use fabrico_host::input_apply::apply_gesture;
    use fabrico_host::ledger::DispatchLedger;
    use fabrico_host::project::save_project;
    use fabrico_protocol::{GridCommand, machine_kind};
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

    /// A host with one Source placed through the gesture path and `ticks` ticks folded after
    /// it, plus the tempdir that owns its stores.
    fn host_with_a_source(ticks: u32) -> (tempfile::TempDir, Host) {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let mut host = Host::new(core, store, ledger, Some(1)).expect("open host");
        let (mut ingress_rx, cmd_tx, mut results_rx) = channels();
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 4,
                cell_y: 1,
            },
            |_h| None,
        )
        .expect("place the source");
        for _ in 0..ticks {
            host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
                .expect("fold a tick");
        }
        (dir, host)
    }

    fn line_with<'a>(text: &'a str, prefix: &str) -> &'a str {
        text.lines()
            .find_map(|l| l.strip_prefix(prefix))
            .unwrap_or_else(|| panic!("no `{prefix}` line in:\n{text}"))
    }

    #[test]
    fn a_saved_bundle_reports_the_hash_of_the_host_that_saved_it() {
        let (dir, host) = host_with_a_source(3);
        let path = dir.path().join("board.fab");
        save_project(&host, &path).expect("save the bundle");

        let text = report_for_path(&path).expect("the saved bundle reads back");
        assert_eq!(line_with(&text, "tick "), host.core().tick.to_string());
        assert_eq!(line_with(&text, "hash "), tick_hash(host.core()));
        let edits: Vec<&str> = text.lines().filter(|l| l.starts_with("edit ")).collect();
        assert_eq!(edits.len(), 1, "the one placed Source is the one edit:\n{text}");
        assert!(
            edits[0].contains("Place"),
            "the edit line names the operation: {}",
            edits[0]
        );
    }

    #[test]
    fn one_more_tick_changes_both_the_tick_and_the_hash() {
        let (dir_a, host_a) = host_with_a_source(3);
        let (dir_b, host_b) = host_with_a_source(4);
        let path_a = dir_a.path().join("a.fab");
        let path_b = dir_b.path().join("b.fab");
        save_project(&host_a, &path_a).expect("save a");
        save_project(&host_b, &path_b).expect("save b");
        let a = report_for_path(&path_a).expect("read a");
        let b = report_for_path(&path_b).expect("read b");
        assert_ne!(line_with(&a, "tick "), line_with(&b, "tick "));
        assert_ne!(line_with(&a, "hash "), line_with(&b, "hash "));
    }

    #[test]
    fn two_bundles_of_the_same_gestures_print_the_same_report() {
        let (dir_a, host_a) = host_with_a_source(3);
        let (dir_b, host_b) = host_with_a_source(3);
        let path_a = dir_a.path().join("a.fab");
        let path_b = dir_b.path().join("b.fab");
        save_project(&host_a, &path_a).expect("save a");
        save_project(&host_b, &path_b).expect("save b");
        assert_eq!(
            report_for_path(&path_a).expect("read a"),
            report_for_path(&path_b).expect("read b")
        );
    }

    #[test]
    fn a_missing_file_is_a_message_not_a_panic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("nothing-here.fab");
        let err = report_for_path(&missing).expect_err("a missing file is refused");
        assert!(err.contains("does not exist"), "the refusal says what is wrong: {err}");
    }

    // `fabrico-host` is the sanctioned I/O home and this test writes a corrupt file on purpose.
    #[allow(clippy::disallowed_methods)]
    #[test]
    fn garbage_bytes_are_a_message_not_a_panic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("garbage.fab");
        std::fs::write(&path, [0xffu8; 64]).expect("write garbage");
        let err = report_for_path(&path).expect_err("garbage is refused");
        assert!(err.contains("could not be read"), "the refusal names the reason: {err}");
    }
}
