//! A command's ledger row has to be on disk before the executor can run its effect.
//!
//! If the effect ran first and the host crashed in between, recovery would find no row, and a
//! command with a real side effect could fire twice. A tick hash can't see this order, because
//! the ledger and the executor are both outside the fold, so `host_parity.rs` stays green if
//! the two calls swap. These tests are the check for it.
//!
//! The first test drives [`Host::tick_with_dispatch`], the function `tick_once` runs, and looks at
//! the ledger from inside the dispatch closure, so it reads what recovery would read if the host
//! died at that exact moment. The second holds `tick_once` to that one call and the one send, so
//! nothing can reach the executor without going through the function the first test drives.

use std::collections::BTreeSet;

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
