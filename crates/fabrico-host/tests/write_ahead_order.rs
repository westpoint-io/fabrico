//! A command's ledger row has to be on disk before the executor can run its effect.
//!
//! If the effect ran first and the host crashed in between, recovery would find no row, and a
//! command with a real side effect could fire twice. A tick hash can't see this order, because
//! the ledger and the executor are both outside the fold, so `host_parity.rs` stays green if
//! the two calls swap. These tests are the check for it.
//!
//! The first test drives [`Host::tick_with_dispatch`], the function `tick_once` runs, and looks at
//! the ledger from inside the dispatch closure, so it reads what recovery would read if the host
//! died at that exact moment. The second holds `tick_once` to that one call and to the one send in
//! `driver.rs`.
//!
//! The third reads every `.rs` file under this crate's `src/` and `examples/`, because the
//! production sender lives in `sim_loop.rs` and a send written there would pass the first two. It
//! covers the files in [`FILES_NAMING_A_COMMAND_SENDER`]: `driver.rs`, `sim_loop.rs`,
//! `demo_scene.rs`, `input_apply.rs`, `project.rs`, `examples/read_project.rs` and
//! `examples/vertical_slice.rs`. The only sends it allows are the one in `tick_once` and the
//! `#[cfg(test)]` `test_send_command` in `sim_loop.rs`. It reads text, so a type alias for the
//! sender would get past it.

// The workspace-root `clippy.toml` disallows `std::fs::read_to_string` to keep the sim core free of
// ambient IO. The scan has to read the source files, so that lint is allowed in this one file.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use fabrico_core::command::ResultEvent;
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{CommandId, Item};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::SinkTemplate;
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use tokio::sync::mpsc::unbounded_channel;

/// Enough ticks for the source to push several items into the sink.
const TICKS: u8 = 10;
/// A floor on the dispatches seen, so the test can't pass on a run that dispatched nothing.
const MIN_DISPATCHES: usize = 3;

/// The files under `src/` and `examples/` that name a command sender. A new file on this list is a
/// new way to reach the executor, so the scan fails until someone has read it and added it here.
const FILES_NAMING_A_COMMAND_SENDER: &[&str] = &[
    "examples/read_project.rs",
    "examples/vertical_slice.rs",
    "src/demo_scene.rs",
    "src/driver.rs",
    "src/input_apply.rs",
    "src/project.rs",
    "src/sim_loop.rs",
];

/// How many sends on `cmd_tx` each file may hold. `driver.rs` has the one in `tick_once`, and
/// `sim_loop.rs` has the `#[cfg(test)]` `test_send_command`.
const ALLOWED_SENDS: &[(&str, usize)] = &[("src/driver.rs", 1), ("src/sim_loop.rs", 1)];

/// Every line in `sim_loop.rs` that mentions the production sender. Listing them whole catches an
/// alias or a clone taken from the field, and a renamed field, which the send count can't see.
const SIM_LOOP_CMD_TX_LINES: &[&str] = &[
    "cmd_tx: UnboundedSender<Command>,",
    "let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();",
    "cmd_tx,",
    "let _ = self.cmd_tx.send(cmd);",
    "self.host.tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)?;",
];

#[test]
fn a_commands_ledger_row_is_durable_when_its_dispatch_runs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 1,
    });
    let source = core.state.add_source();
    // A deadline this far out means no command times out during the run, so all of them are
    // still in flight when their row is read.
    let sink = core.state.add_sink(SinkTemplate::Debug, 1_000_000);
    core.state.link((source, 0), (sink, 0));
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");

    let (ingress_tx, mut ingress_rx) = unbounded_channel::<EventPayload>();
    let (_results_tx, mut results_rx) = unbounded_channel::<ResultEvent>();
    let mut dispatched: Vec<CommandId> = Vec::new();
    for byte in 0..TICKS {
        ingress_tx
            .send(EventPayload::ManualInject {
                target: source,
                port: 0,
                item: Item(vec![byte]),
            })
            .expect("the ingress channel is open");
        host.tick_with_dispatch(&mut ingress_rx, &mut results_rx, |cmd, ledger| {
            let recovery = ledger.recover(&BTreeSet::new()).expect("read the ledger");
            assert!(
                recovery.do_not_resend.iter().any(|(id, _)| *id == cmd.id),
                "command {:?} reached dispatch with no durable ledger row, so a crash here \
                 would lose the record that it was sent",
                cmd.id
            );
            dispatched.push(cmd.id);
        })
        .expect("finish the tick");
    }

    assert!(
        dispatched.len() >= MIN_DISPATCHES,
        "expected at least {MIN_DISPATCHES} dispatches, saw {}",
        dispatched.len()
    );
}

/// The text of `tick_once`'s body with comments and all whitespace removed.
fn tick_once_body(code: &str) -> String {
    let head = code.find("pub fn tick_once(").expect("driver.rs has tick_once");
    let open = head + code[head..].find(") -> Result<(), StoreError> {").expect("tick_once returns a Result");
    let body = open + code[open..].find('{').expect("tick_once has a body") + 1;
    let close = body + code[body..].find("\n    }\n").expect("tick_once's body closes at four spaces");
    code[body..close].chars().filter(|c| !c.is_whitespace()).collect()
}

/// `tick_once` holds one statement, so the first test's function is the path production runs. A
/// send moved ahead of the ledger row has to be written in `tick_once`, which fails this exact
/// comparison, or in `tick_with_dispatch`, where the first test sees it. A count of the text
/// `cmd_tx.send(` passed the first of those and lost to a renamed variable.
#[test]
fn the_host_sends_to_the_executor_in_one_place() {
    let src = include_str!("../src/driver.rs");
    let code: String = src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    // Assembled from pieces, so this file's own text can't be what gets counted.
    let send: String = [".", "send("].concat();
    assert_eq!(
        code.matches(&send).count(),
        1,
        "driver.rs holds exactly one channel send, the one in tick_once's dispatch closure"
    );
    let want: String = ["self.tick_with_dispatch(ingress_rx,results_rx,|cmd,_ledger|{", "let_=cmd_tx", ".send(cmd.clone());})"].concat();
    assert_eq!(
        tick_once_body(&code),
        want,
        "tick_once must be one call to tick_with_dispatch with the send as its closure, because \
         a_commands_ledger_row_is_durable_when_its_dispatch_runs drives tick_with_dispatch and \
         sees nothing written around it"
    );
}

/// A file's text with its comment lines removed.
fn code_of(src: &str) -> String {
    src.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every `.rs` file under `dir`, at any depth.
fn rust_files_under(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("read a directory entry").path();
        if path.is_dir() {
            rust_files_under(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// True if the line writes `Sender<Command>` or `channel::<Command>`, with or without a module path.
fn names_a_command_sender(line: &str) -> bool {
    ["Sender<", "channel::<"].iter().any(|open| {
        line.split(open).skip(1).any(|rest| {
            let ty = rest.split('>').next().unwrap_or("");
            ty == "Command" || ty.ends_with("::Command")
        })
    })
}

/// A send written outside `tick_once` skips the ledger row, and the first test can't see it because
/// it drives `Host` directly. `Host::recover` hands replayed commands back to its caller, so
/// `sim_loop.rs` is a realistic place for one, and re-sending those is what the crash-recovery rule
/// forbids.
#[test]
fn only_tick_once_sends_on_a_command_sender_in_src_and_examples() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut paths = Vec::new();
    rust_files_under(&root.join("src"), &mut paths);
    rust_files_under(&root.join("examples"), &mut paths);
    let files: BTreeMap<String, String> = paths
        .iter()
        .map(|path| {
            let relative = path.strip_prefix(&root).expect("the walk stays under the crate root");
            let src = std::fs::read_to_string(path).expect("read a source file");
            (relative.to_string_lossy().replace('\\', "/"), code_of(&src))
        })
        .collect();

    let naming: Vec<&str> = files
        .iter()
        .filter(|(_, code)| code.lines().any(names_a_command_sender))
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(
        naming, FILES_NAMING_A_COMMAND_SENDER,
        "the files naming a command sender changed. Read any new one for a send that skips \
         tick_once, then update FILES_NAMING_A_COMMAND_SENDER"
    );

    for (name, code) in &files {
        for line in code.lines().filter(|l| names_a_command_sender(l)) {
            let bare_type = line.trim() == "UnboundedSender<Command>,";
            assert!(
                bare_type || line.contains("cmd_tx"),
                "{name} gives a command sender a name other than cmd_tx, so the send count below \
                 can't see it: {line}"
            );
        }
    }

    let mut sends: BTreeMap<&str, usize> = BTreeMap::new();
    for (name, code) in &files {
        let squeezed: String = code.chars().filter(|c| !c.is_whitespace()).collect();
        assert_eq!(
            squeezed.matches("::send(").count(),
            0,
            "{name} calls send by its path, which the count below can't see. Write it as a method \
             call"
        );
        let count = squeezed.matches("cmd_tx.send(").count();
        if count > 0 {
            sends.insert(name, count);
        }
    }
    assert_eq!(
        sends,
        ALLOWED_SENDS.iter().copied().collect::<BTreeMap<_, _>>(),
        "a send on cmd_tx outside tick_once and the test-only test_send_command skips the ledger \
         row, so a crash could fire that command twice"
    );

    let sim_loop = &files["src/sim_loop.rs"];
    let mentions: Vec<&str> =
        sim_loop.lines().filter(|l| l.contains("cmd_tx")).map(str::trim).collect();
    assert_eq!(
        mentions, SIM_LOOP_CMD_TX_LINES,
        "sim_loop.rs uses the production sender in a new way. Its only production use is passing \
         it to tick_once, and a copy of it can send outside tick_once"
    );
    let squeezed: String = sim_loop.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(
        squeezed.contains(
            "#[cfg(test)]pub(crate)fntest_send_command(&self,cmd:Command){let_=self.cmd_tx.send(cmd);}"
        ),
        "test_send_command in sim_loop.rs has to stay #[cfg(test)], because without that it is a \
         production send that skips the ledger row"
    );
}
