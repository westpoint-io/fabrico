//! A command's ledger row has to be on disk before the executor can run its effect.
//!
//! If the effect ran first and the host crashed in between, recovery would find no row, and a
//! command with a real side effect could fire twice. A tick hash can't see this order, because
//! the ledger and the executor are both outside the fold, so `host_parity.rs` stays green if
//! the two calls swap. These tests are the check for it.
//!
//! The first test looks at the ledger from inside the dispatch closure, so it reads what recovery
//! would read if the host died at that exact moment. The second keeps the host to one channel
//! send, so nothing can reach the executor without going through that closure.

use std::collections::BTreeSet;

use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{CommandId, Item};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::SinkTemplate;
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;

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

    let mut dispatched: Vec<CommandId> = Vec::new();
    for byte in 0..TICKS {
        let ingress = vec![EventPayload::ManualInject {
            target: source,
            port: 0,
            item: Item(vec![byte]),
        }];
        let out = host.step_engine(ingress, Vec::new());
        host.finish_tick(out, |cmd, ledger| {
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

#[test]
fn the_host_sends_to_the_executor_in_one_place() {
    let src = include_str!("../src/driver.rs");
    let code: String = src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    // Assembled from pieces, so this file's own text can't be what gets counted.
    let send: String = ["cmd_tx", ".send("].concat();
    assert_eq!(
        code.matches(&send).count(),
        1,
        "the only send is the one inside finish_tick's dispatch closure, in tick_once"
    );
}
