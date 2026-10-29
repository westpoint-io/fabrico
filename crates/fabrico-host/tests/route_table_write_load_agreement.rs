//! Phase 65 review gap-closure - the route-table WRITE/LOAD agreement, with
//! `load_project` CALLED rather than restated.
//!
//! # What this file is for, and why the command layer's own test is not it
//! A phase 65 fix closed a data-loss bug: a Router "Match text" pattern one byte past
//! `MAX_ROUTE_EXPECT_BYTES` was accepted by the command layer, folded, written to the
//! certified edit log and SAVED, and the saved bundle then permanently refused to load.
//! The user's work was gone with no way back. The fix bounds the table where it is
//! WRITTEN, so nothing the command layer accepts can be refused by `load_project`.
//!
//! Its own test group flagged an honest limitation, and this file closes it.
//! `fabrico-command` is HEADLESS BY CONTRACT - its `deps_are_headless` fence forbids a
//! `fabrico-host` dependency - so `load_project` is not linkable there. The agreement
//! test in `command.rs` therefore RESTATES `load_project`'s refusal predicate in a test
//! helper (`load_bound_admits`) and drives the executable half through `edit::upcast`,
//! which applies the identical constant pair. That is a good approximation and it is
//! still an approximation: a restated predicate agrees with the function it stands in
//! for only for as long as someone keeps them in step, and `edit::upcast` is a DIFFERENT
//! boundary with a DIFFERENT (stricter) guard set, documented as such in `project.rs`
//! under named debt T-63-26.
//!
//! `fabrico-host` is where both halves link, so here the claim is made by CALLING the
//! function: drive a real `Configure{Router}` through the real command layer via
//! `apply_gesture`, fold it, `save_project` it to a real `.fab`, and hand that file to
//! the real `load_project`. No predicate is restated anywhere in this file.
//!
//! # The three claims
//! - `a_router_table_at_both_caps_saves_and_load_project_accepts_it` - the MAXIMAL legal
//!   table (`MAX_ROUTES` rules, each carrying a `MAX_ROUTE_EXPECT_BYTES` pattern)
//!   survives the whole write path and `load_project` returns `Ok`. This is the exact
//!   shape the pre-fix off-by-one direction would have refused.
//! - `one_over_either_cap_is_refused_before_it_can_reach_a_save` - both one-over
//!   dimensions are refused at the command layer, append NO record, and the `.fab`
//!   written afterwards carries no `Configure` at all. The unloadable bundle cannot be
//!   produced, which is stronger than proving the loader would have refused it.
//! - `the_command_accept_envelope_and_load_project_agree_at_both_caps` - the complement
//!   property over all four boundary cases, with `load_project` called on every one.
//!
//! EVERY size is DERIVED from `MAX_ROUTES` / `MAX_ROUTE_EXPECT_BYTES`. A literal `1024`
//! or `1025` anywhere here would keep passing if a cap moved and would stop testing the
//! rule.
//!
//! # Mutation proof
//! RUN, not described, on 2026-08-22. Both mutations are of the write-side guard in
//! `fabrico_command::validate_normalize`'s `Configure` arm. That file was being changed in
//! parallel, so each mutation was applied to a byte-exact copy, run, and the
//! original restored and verified with `sha256sum -c` plus `git diff --quiet`.
//!
//!   M-A, DISABLE the guard (both caps widened to `* 4`, the pre-fix behaviour). Reddens
//!        `one_over_either_cap_..` and DIRECTION A of the agreement test, the latter with
//!        `EditRoutePatternTooLong { len: 1025, cap: 1024 }` - the reported bug's own
//!        reproduction, produced by a test instead of by a user. The at-cap test stays
//!        green, which is correct: removing a guard cannot make an accept-test fail.
//!   M-B, WEAKEN the guard by an off-by-one (`>` becomes `>=`). Reddens
//!        `a_router_table_at_both_caps_..` and DIRECTION B of the agreement test. The
//!        over-cap test stays green, which is again correct: a stricter guard still
//!        refuses what was already refused.
//!
//! Neither mutation alone reddens everything, and NEITHER DIRECTION of the agreement
//! test is redundant: direction A cannot see M-B at all, because a refused table
//! produces no save for it to inspect. The first version of this file had only direction
//! A and passed M-B cleanly; that is why direction B exists.
//!
//! Run target: `cargo test -p fabrico-host --test route_table_write_load_agreement`

// `fabrico-host` is the project's sanctioned I/O home and does NOT carry the determinism
// clippy gate (that lives only in `fabrico-core`). Reading back a `.fab` this test just
// wrote, and writing the spliced one to a tempfile, is exactly the test IO that belongs
// here; scope the allow defensively in case CI promotes the lint workspace-wide. Same
// reasoning, same wording, as `tests/fuzz_two_log.rs`.
#![allow(clippy::disallowed_methods)]

use fabrico_command::CommandError;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{
    EditOp, MAX_ROUTE_EXPECT_BYTES, MAX_ROUTES, MachineConfig as CoreConfig,
};
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{load_project, save_project};
use fabrico_protocol::{GridCommand, MachineConfig, RouteKey, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// The genesis seed for every host in this file. Any value works (nothing here is
/// random); it is pinned so a rerun folds the identical scene.
const SEED: u64 = 0x0065_C0DE_B007_E000;

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: SEED,
    }
}

/// A real `Host` over tempfile redb stores (mirrors `tests/configure_host.rs`).
fn test_host() -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    (dir, Host::new(core, store, ledger, None).expect("open host"))
}

/// The per-tick channels `tick_once` drains (gestures ride the EDIT log, not these).
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

/// A live host carrying one placed, folded Router, plus the channels a tick needs.
#[allow(clippy::type_complexity)]
fn host_with_router() -> (
    tempfile::TempDir,
    Host,
    NodeId,
    UnboundedReceiver<EventPayload>,
    UnboundedSender<Command>,
    UnboundedReceiver<ResultEvent>,
) {
    let (dir, mut host) = test_host();
    let (mut ingress_rx, cmd_tx, mut results_rx) = channels();
    apply_gesture(
        &mut host,
        GridCommand::Place {
            kind: machine_kind::ROUTER,
            cell_x: 0,
            cell_y: 0,
        },
        |_h| None,
    )
    .expect("place a Router at a free cell");
    host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
        .expect("tick folds the placed Router");
    let router = *host
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placed Router minted an id");
    (dir, host, router, ingress_rx, cmd_tx, results_rx)
}

/// A wire-side `Router` table of `rules` entries, each carrying an `expect` pattern of
/// `expect_len` bytes, all aimed at output port 0.
///
/// The pattern byte VARIES per rule so no two rules are identical: a dedup anywhere in
/// the path would otherwise shrink the table and make a cap case pass vacuously.
fn router_table(rules: usize, expect_len: usize) -> MachineConfig {
    MachineConfig::Router {
        routes: (0..rules)
            .map(|i| {
                (
                    RouteKey {
                        offset: 0,
                        expect: vec![(i % 251) as u8; expect_len],
                    },
                    0u16,
                )
            })
            .collect(),
        default: None,
    }
}

/// Drive a `Configure{Router}` at `router` through the REAL command layer.
fn configure(host: &mut Host, router: NodeId, config: MachineConfig) -> Result<(), CommandError> {
    apply_gesture(
        host,
        GridCommand::Configure { node: 0, config },
        move |h| (h == 0).then_some(router),
    )
}

/// The `(rules, longest_pattern)` shape of the LAST `Configure{Router}` in `host`'s
/// persisted edit log, or `None` when it carries no Router config at all.
///
/// Read out of the log rather than asserted against a remembered value, so the numbers
/// below describe what actually crossed the boundary.
fn logged_router_shape(host: &Host) -> Option<(usize, usize)> {
    host.logged_edits()
        .expect("read the persisted edit log")
        .iter()
        .rev()
        .find_map(|record| match &record.op {
            EditOp::Configure {
                config: CoreConfig::Router { routes, .. },
                ..
            } => Some((
                routes.len(),
                routes.iter().map(|(key, _)| key.expect.len()).max().unwrap_or(0),
            )),
            _ => None,
        })
}

/// The same table as [`router_table`], in the CORE shape an `EditRecord` carries.
///
/// Used only by [`load_admits`] to splice a candidate table into a real bundle. This is
/// data construction, not a restatement of anyone's predicate: no bound is expressed
/// here, only a table of a given size.
fn core_router_table(rules: usize, expect_len: usize) -> CoreConfig {
    CoreConfig::Router {
        routes: (0..rules)
            .map(|i| {
                (
                    fabrico_core::state::RouteKey {
                        offset: 0,
                        expect: vec![(i % 251) as u8; expect_len],
                    },
                    0u16,
                )
            })
            .collect(),
        default: None,
    }
}

/// Does the REAL `load_project` admit a bundle whose `Configure{Router}` carries a table
/// of `rules` rules by `expect_len` bytes?
///
/// # Why this splices a real bundle instead of asking a predicate
/// The agreement below needs BOTH implications, and the command layer can only ever
/// produce bundles it ACCEPTED - so the reverse direction ("if the loader would take
/// this table, the command layer must not have refused it") has no bundle to work with
/// unless one is built. The sibling test in `command.rs` closes that gap by restating
/// `load_project`'s predicate in Rust, which is exactly the restatement this file exists
/// to replace.
///
/// So the bundle is built from a REAL one: `baseline` is a `.fab` this crate saved from
/// a real scene, and the only thing changed in it is the CONTENT of its
/// `Configure{Router}` table. Everything else - version, snapshot, event log, record
/// keys, ticks - is byte-for-byte what `save_project` wrote. The answer therefore comes
/// from calling `load_project`, never from a predicate written here.
///
/// The loader decides the route-table question from `bundle.edit_log` alone, BEFORE it
/// restores or replays anything, so this reads the accept envelope directly. It does not
/// claim the spliced table would fold, and nothing below asserts that it does.
fn load_admits(baseline: &std::path::Path, rules: usize, expect_len: usize) -> bool {
    let bytes = std::fs::read(baseline).expect("read the baseline bundle");
    let mut bundle: fabrico_host::project::ProjectFile =
        postcard::from_bytes(&bytes).expect("the baseline bundle decodes");
    let record = bundle
        .edit_log
        .iter_mut()
        .rev()
        .find(|r| {
            matches!(
                &r.op,
                EditOp::Configure { config: CoreConfig::Router { .. }, .. }
            )
        })
        .expect("the baseline scene carries a Configure{Router} to splice");
    match &mut record.op {
        EditOp::Configure { config, .. } => *config = core_router_table(rules, expect_len),
        _ => unreachable!("filtered to Configure above"),
    }
    let dir = tempfile::tempdir().expect("tempdir for the spliced bundle");
    let spliced = dir.path().join("spliced.fab");
    std::fs::write(
        &spliced,
        postcard::to_allocvec(&bundle).expect("the spliced bundle encodes"),
    )
    .expect("write the spliced bundle");
    let work = tempfile::tempdir().expect("a FRESH work_dir");
    load_project(&spliced, work.path(), Some(1)).is_ok()
}

/// Save `host` to a `.fab` inside `dir` and hand the file to the REAL `load_project`.
///
/// Returns the loaded `Host`. The work dir is FRESH per load (a `load_project`
/// precondition) and is leaked into the returned tuple so it outlives the store.
fn save_then_load(host: &Host, dir: &std::path::Path, name: &str) -> (tempfile::TempDir, Host) {
    assert_eq!(
        host.in_flight_len(),
        0,
        "the scene must be quiescent before a save (save_project refuses otherwise)"
    );
    let fab = dir.join(name);
    save_project(host, &fab).expect("a quiescent scene saves");
    let work = tempfile::tempdir().expect("a FRESH work_dir for the load");
    let loaded = load_project(&fab, work.path(), Some(1))
        .unwrap_or_else(|err| panic!("load_project REFUSED a bundle the command layer produced: {err}"));
    (work, loaded)
}

// ---------------------------------------------------------------------------
// The claims.
// ---------------------------------------------------------------------------

#[test]
fn a_router_table_at_both_caps_saves_and_load_project_accepts_it() {
    // The MAXIMAL legal table: `MAX_ROUTES` rules, every one carrying a pattern of
    // exactly `MAX_ROUTE_EXPECT_BYTES`. `load_project` admits `<= cap` on BOTH
    // dimensions, so this table must survive the entire write path. An off-by-one that
    // refused it would be its own data-loss bug in the opposite direction: a legal
    // routing table the user could no longer author.
    let (dir, mut host, router, mut ingress_rx, cmd_tx, mut results_rx) = host_with_router();

    configure(&mut host, router, router_table(MAX_ROUTES, MAX_ROUTE_EXPECT_BYTES))
        .expect("a table at exactly both caps is legal at the command layer");
    host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
        .expect("tick folds the Configure");

    // NOT merely "a Configure was logged": the table that reached the certified log is
    // the at-cap table, so what `load_project` is about to read is genuinely maximal.
    assert_eq!(
        logged_router_shape(&host),
        Some((MAX_ROUTES, MAX_ROUTE_EXPECT_BYTES)),
        "the at-cap table reached the certified edit log intact - a shrunk table here \
         would make the load below pass over something smaller than the cap"
    );

    let (_work, loaded) = save_then_load(&host, dir.path(), "at-both-caps.fab");

    assert_eq!(
        loaded.core().tick,
        host.core().tick,
        "the at-cap scene round-trips through the REAL load_project to head_tick"
    );
    // And the table is still there afterwards. `load_project` returning Ok over a
    // bundle whose Configure had been dropped would be a quieter version of the same
    // data loss.
    assert_eq!(
        logged_router_shape(&loaded),
        Some((MAX_ROUTES, MAX_ROUTE_EXPECT_BYTES)),
        "the loaded scene still carries the at-cap table, rule for rule and byte for byte"
    );
}

#[test]
fn one_over_either_cap_is_refused_before_it_can_reach_a_save() {
    // The reported defect, from the other side. Proving that `load_project` WOULD refuse
    // an over-cap bundle is not the property that matters, because by then the user's
    // work is already unreachable. The property that matters is that the command layer
    // refuses first, so the unloadable bundle CANNOT BE PRODUCED.
    //
    // Both dimensions, one over each cap, sizes derived from the constants.
    for (label, rules, expect_len) in [
        ("pattern", 1, MAX_ROUTE_EXPECT_BYTES + 1),
        ("table", MAX_ROUTES + 1, 1),
    ] {
        let (dir, mut host, router, mut ingress_rx, cmd_tx, mut results_rx) = host_with_router();
        let log_len = host.logged_edits().expect("read the edit log").len();

        // OBSERVED, verbatim, with the write-side guard widened to 4x the caps:
        //   `an over-cap PATTERN must be refused at the command layer: ()`
        // The `()` is the accepted `Ok(())` - the over-cap table was taken, and the
        // save two lines below is the one that wrote the unloadable bundle.
        let outcome = configure(&mut host, router, router_table(rules, expect_len));
        let err = outcome.expect_err(match label {
            "pattern" => "an over-cap PATTERN must be refused at the command layer",
            _ => "an over-cap TABLE must be refused at the command layer",
        });
        assert_eq!(
            err,
            CommandError::OverLimit,
            "the over-cap {label} is refused as OverLimit, the tag plan 88-02 split out of \
             Malformed for a setting past a bound the app sets"
        );

        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick after the refusal");
        assert_eq!(
            host.logged_edits().expect("read the edit log").len(),
            log_len,
            "the refused over-cap {label} appended NO record - nothing to save, nothing to lose"
        );

        // The save that follows the refusal is the whole point: it produces a file, and
        // that file loads. Pre-fix this is the step that wrote the unloadable bundle.
        let (_work, loaded) = save_then_load(&host, dir.path(), "after-refusal.fab");
        assert_eq!(
            logged_router_shape(&loaded),
            None,
            "the saved bundle carries NO Router config at all, so the over-cap {label} never \
             reached a save and no reload can be refused for it"
        );
    }
}

#[test]
fn the_command_accept_envelope_and_load_project_agree_at_both_caps() {
    // THE PROPERTY, with the function CALLED. `command.rs`'s sibling test asserts this
    // against a RESTATED predicate because `load_project` is not linkable from a
    // headless crate. Here it is the real function, over the same four boundary cases.
    //
    // The claim, in BOTH directions, because the bound can fail either way and the two
    // failures are different bugs:
    //   A. accepted  =>  `load_project` takes the resulting `.fab`. Violating this is
    //      the REPORTED bug: certified, saved, and unloadable forever.
    //   B. the loader would take this table  =>  the command layer accepted it.
    //      Violating this is the OPPOSITE bug: a legal routing table the user can no
    //      longer author, refused by an over-strict write guard.
    // Direction A is read off the real save. Direction B is read off a real bundle with
    // only the table content spliced (see `load_admits`), because a refused table never
    // reaches a save and so leaves direction A nothing to look at. Neither direction
    // consults a predicate written in this file.
    //
    // Both directions are proved reachable, by RUNNING two mutations of the write-side
    // guard in `fabrico_command::validate_normalize` and restoring it byte-exactly after
    // each (verified with `sha256sum -c`; the file had a parallel change in flight and was
    // left at HEAD). Observed messages are recorded verbatim beside the assertions below.
    //
    // A baseline `.fab` from a real scene with a small legal table, spliced by
    // `load_admits` to ask the loader about each candidate.
    let (base_dir, mut base_host, base_router, mut b_in, b_cmd, mut b_res) = host_with_router();
    configure(&mut base_host, base_router, router_table(1, 1))
        .expect("a one-rule one-byte table is legal by any reading of the caps");
    base_host
        .tick_once(&mut b_in, &mut b_res, &b_cmd)
        .expect("tick folds the baseline Configure");
    let baseline = base_dir.path().join("baseline.fab");
    save_project(&base_host, &baseline).expect("the baseline scene saves");

    let cases: [(&str, usize, usize); 4] = [
        ("at the pattern cap", 1, MAX_ROUTE_EXPECT_BYTES),
        ("one byte over the pattern cap", 1, MAX_ROUTE_EXPECT_BYTES + 1),
        ("at the table cap", MAX_ROUTES, 1),
        ("one rule over the table cap", MAX_ROUTES + 1, 1),
    ];
    for (label, rules, expect_len) in cases {
        let (dir, mut host, router, mut ingress_rx, cmd_tx, mut results_rx) = host_with_router();
        let accepted = configure(&mut host, router, router_table(rules, expect_len)).is_ok();
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds whatever was accepted");

        assert_eq!(
            host.in_flight_len(),
            0,
            "a Configure dispatches nothing, so the scene is quiescent and savable ({label})"
        );
        let fab = dir.path().join("agreement.fab");
        save_project(&host, &fab).expect("the scene saves");
        let work = tempfile::tempdir().expect("a FRESH work_dir");
        let outcome = load_project(&fab, work.path(), Some(1));

        // DIRECTION A. `load_project` is CALLED, not restated: this is the line the
        // headless sibling could not write.
        //
        // OBSERVED, verbatim, with the write-side guard widened to 4x the caps (the
        // pre-fix state, in which the command layer accepts an over-cap table):
        //   `the command layer accepted a table one byte over the pattern cap (rules=1,
        //    expect_len=1025) and saved it, and load_project then REFUSED the saved
        //    bundle: Some(EditRoutePatternTooLong { len: 1025, cap: 1024 }). That is the
        //    reported data-loss bug verbatim - certified, saved, and unloadable.`
        // That `EditRoutePatternTooLong { len: 1025, cap: 1024 }` is the reported bug's
        // own reproduction, now produced by a test instead of by a user.
        assert!(
            outcome.is_ok(),
            "the command layer accepted a table {label} (rules={rules}, expect_len={expect_len}) \
             and saved it, and load_project then REFUSED the saved bundle: {:?}. That is the \
             reported data-loss bug verbatim - certified, saved, and unloadable.",
            outcome.err(),
        );
        let loaded = outcome.expect("checked Ok above");

        // DIRECTION B. The same question asked of the loader about the table it never
        // got to see, by handing it a real bundle carrying exactly that table.
        //
        // OBSERVED, verbatim, with the write-side guard's `>` weakened to `>=` (an
        // over-strict guard that refuses a legal table):
        //   `the command layer and load_project disagree about a table at the pattern
        //    cap (rules=1, expect_len=1024): the command layer accepted=false, and
        //    load_project admits the same table=true. A table the loader would take and
        //    the command layer will not write is a routing table the user can no longer
        //    author.`
        // Direction A cannot see this mutation at all - a refused table produces no save
        // for it to inspect - which is why both directions are here.
        assert_eq!(
            accepted,
            load_admits(&baseline, rules, expect_len),
            "the command layer and load_project disagree about a table {label} (rules={rules}, \
             expect_len={expect_len}): the command layer accepted={accepted}, and load_project \
             admits the same table={}. A table the loader would take and the command layer will \
             not write is a routing table the user can no longer author.",
            load_admits(&baseline, rules, expect_len),
        );

        // And the two sides say the same thing about WHY. When the command layer
        // accepted, the table must be in the loaded scene; when it refused, there must
        // be nothing there to have been refused for.
        let shape = logged_router_shape(&loaded);
        if accepted {
            assert_eq!(
                shape,
                Some((rules, expect_len)),
                "the command layer accepted a table {label} but the loaded scene does not carry \
                 it - an accepted table that vanishes on reload is the same loss by a quieter door"
            );
        } else {
            assert_eq!(
                shape,
                None,
                "the command layer refused a table {label}, so no Router config may appear in the \
                 saved bundle"
            );
        }
    }
}
