//! A test harness for the wasm build. It replays the repo's fixtures through the same fold the
//! desktop build runs, and it probes the Factory limits on that target. Nothing here ships: the
//! player's dependency check refuses this crate by name, so a browser never downloads it.
//!
//! [`replay_golden`] and [`replay_scenario`] are the one code path for both targets. The native
//! report tool calls them directly, and the wasm module calls them through the `fc_` exports, so a
//! difference between the two reports comes from the target and not from two copies of a loop.
//!
//! The fixture bytes come from the caller. A fixture added to the repo then needs no table edit
//! here, and changing an expected hash needs no rebuild.
//!
//! A panic traps a wasm instance, so a fixture that won't decode comes back as a status with its
//! error text in the out buffer.
//!
//! [`fence`] runs one of the limit shapes once on a fresh Factory runtime. The shapes come from the
//! file the native pins use, included by path, so a shape can't differ between the targets.

#![deny(unsafe_op_in_unsafe_fn)]
#![warn(clippy::all)]

use std::cell::RefCell;
use std::fmt::Write as _;

use fabrico_core::core::{Core, MAX_REPLAY_SPAN};
use fabrico_core::edit::EditRecord;
use fabrico_core::event::{Event, LogHeader, SCHEMA_VERSION};
use fabrico_core::factory::{
    DEFAULT_GAS_BUDGET, DEFAULT_MEM_LIMIT, DEFAULT_STACK_LIMIT, FactoryRuntime,
};
use fabrico_core::fault::FaultReason;
use fabrico_core::rng::SimRng;
use fabrico_core::snapshot;
use fabrico_scenario::fixture::Scenario;
use fabrico_scenario::tick_hash;

/// The call succeeded, and the out buffer holds the replay's lines.
pub const FC_OK: u32 = 0;
/// The fixture was refused, and the out buffer holds the error text.
pub const FC_REFUSED: u32 = 1;

/// What one fixture's replay produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replay {
    /// The state hash after each tick, in tick order.
    pub hashes: Vec<String>,
    /// The entries in `core.last_tick.faulted`, summed over the ticks.
    pub faults: u64,
}

impl Replay {
    /// The text the wasm exports return: one `<tick index> <hash>` line per tick and a final
    /// `faults <n>` line.
    #[must_use]
    pub fn to_lines(&self) -> String {
        let mut text = String::new();
        for (index, hash) in self.hashes.iter().enumerate() {
            // Writing to a String can't fail.
            let _ = writeln!(text, "{index} {hash}");
        }
        let _ = writeln!(text, "faults {}", self.faults);
        text
    }
}

/// Replay a golden fixture for `ticks` ticks from its genesis snapshot. Each tick gathers the
/// contiguous edit and event records at `core.tick`, advances once with the edits first, counts
/// the faults and hashes the state.
///
/// # Errors
/// Returns the error text when the snapshot or either log won't decode.
pub fn replay_golden(
    genesis: &[u8],
    log: &[u8],
    edit_log: &[u8],
    ticks: u32,
) -> Result<Replay, String> {
    let mut core = snapshot::restore(genesis).map_err(|e| format!("genesis: {e:?}"))?;
    let events: Vec<Event> = postcard::from_bytes(log).map_err(|e| format!("log: {e}"))?;
    let edits: Vec<EditRecord> =
        postcard::from_bytes(edit_log).map_err(|e| format!("edit log: {e}"))?;

    let mut replay = Replay {
        hashes: Vec::with_capacity(ticks as usize),
        faults: 0,
    };
    let (mut event_at, mut edit_at) = (0usize, 0usize);
    for _ in 0..ticks {
        replay.faults += advance_one_tick(&mut core, &edits, &events, &mut edit_at, &mut event_at).faults;
        replay.hashes.push(tick_hash(&core));
    }
    Ok(replay)
}

/// Replay a scenario fixture from genesis, hashing after each tick. This repeats the loop in
/// `Core::run_log_two_logs`, which is what `GridSession::replay_two_logs` runs: every tick from 0 to
/// the highest tick in either log. Logs with no records give one hash, of the genesis core.
///
/// `run_log_two_logs` adds the events it consumed to `core.cursor` once, after its loop, and the
/// snapshot holds the cursor. This adds them tick by tick, so each hash is the one a replay stopped
/// at that tick would end on, and the last is the hash in the fixture's committed `.snap`.
///
/// # Errors
/// Returns the error text when the fixture won't decode or its span is one that
/// `run_log_two_logs` refuses.
pub fn replay_scenario(bytes: &[u8]) -> Result<Replay, String> {
    let scenario = Scenario::from_bytes(bytes).map_err(|e| format!("scenario: {e}"))?;
    let mut core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: scenario.seed,
    });
    let highest_event = scenario.event_log.iter().map(|e| e.tick).max();
    let highest_edit = scenario.edit_log.iter().map(|e| e.tick).max();
    let Some(highest_tick) = highest_event.max(highest_edit) else {
        return Ok(Replay {
            hashes: vec![tick_hash(&core)],
            faults: 0,
        });
    };
    if highest_tick > MAX_REPLAY_SPAN {
        return Err(format!(
            "scenario: its highest tick {highest_tick} is over the replay limit {MAX_REPLAY_SPAN}"
        ));
    }

    let mut replay = Replay {
        hashes: Vec::new(),
        faults: 0,
    };
    let (mut event_at, mut edit_at) = (0usize, 0usize);
    while core.tick <= highest_tick {
        let advanced = advance_one_tick(
            &mut core,
            &scenario.edit_log,
            &scenario.event_log,
            &mut edit_at,
            &mut event_at,
        );
        core.cursor += advanced.events;
        replay.faults += advanced.faults;
        replay.hashes.push(tick_hash(&core));
    }
    Ok(replay)
}

/// What one tick of the fold did.
struct Advanced {
    /// The event records this tick consumed.
    events: u64,
    /// The entries in `core.last_tick.faulted` after this tick.
    faults: u64,
}

/// One tick of the fold: the same gather and advance order on both targets, edits first.
fn advance_one_tick(
    core: &mut Core,
    edits: &[EditRecord],
    events: &[Event],
    edit_at: &mut usize,
    event_at: &mut usize,
) -> Advanced {
    let tick = core.tick;
    let edit_start = *edit_at;
    while *edit_at < edits.len() && edits[*edit_at].tick == tick {
        *edit_at += 1;
    }
    let event_start = *event_at;
    while *event_at < events.len() && events[*event_at].tick == tick {
        *event_at += 1;
    }
    core.advance_edits(&edits[edit_start..*edit_at], &events[event_start..*event_at]);
    Advanced {
        events: (*event_at - event_start) as u64,
        faults: core.last_tick.faulted.len() as u64,
    }
}

#[path = "../../fabrico-core/tests/common/fence_shapes.rs"]
mod fence_shapes;

/// The shape numbers [`fence`] and `fc_fence` take.
pub mod shape {
    /// 1000-element arrays, counted to the memory limit.
    pub const ARRAYS: u32 = 0;
    /// 1 KiB strings, counted to the memory limit.
    pub const STRINGS: u32 = 1;
    /// Small objects, counted to the memory limit.
    pub const OBJECTS: u32 = 2;
    /// Self-referring objects, half of them garbage, counted to the memory limit.
    pub const CYCLIC: u32 = 3;
    /// Plain recursion, counted to the stack limit.
    pub const RECURSION: u32 = 4;
    /// A loop of additions, counted to the gas budget.
    pub const GAS_LOOP: u32 = 5;
    /// Recursion through `Array.map`, counted to the stack limit.
    pub const MAP_RECURSION: u32 = 6;
}

/// The Factory ran with no fault.
pub const FENCE_RAN: u32 = 0;
/// The Factory faulted with `FactoryError`, the reason a memory or stack limit gives.
pub const FENCE_ERROR: u32 = 1;
/// The Factory faulted with `FactoryTimeout`, the reason the gas fuse gives.
pub const FENCE_TIMEOUT: u32 = 2;
/// Any other fault, an unknown shape, or a runtime that wouldn't build.
pub const FENCE_OTHER: u32 = 3;

/// A gas budget no shape can spend, so a fault can only come from the limit under test. The native
/// pins use the same value.
pub const UNSPENDABLE_GAS: u64 = 1 << 40;

/// The source of shape `shape` at size `n`, or `None` for an unknown shape number.
#[must_use]
pub fn fence_source(shape: u32, n: u64) -> Option<String> {
    let make: fn(u64) -> String = match shape {
        shape::ARRAYS => fence_shapes::arrays,
        shape::STRINGS => fence_shapes::strings,
        shape::OBJECTS => fence_shapes::objects,
        shape::CYCLIC => fence_shapes::cyclic,
        shape::RECURSION => fence_shapes::recursion,
        shape::GAS_LOOP => fence_shapes::gas_loop,
        shape::MAP_RECURSION => fence_shapes::map_recursion,
        _ => return None,
    };
    Some(make(n))
}

/// Run shape `shape` at size `n` once, on a runtime built with these limits, as the native pins
/// do. Returns one of the `FENCE_` statuses and the fault text, which is empty when it ran.
#[must_use]
pub fn fence(shape: u32, n: u64, gas: u64, mem_limit: u32, stack_limit: u32) -> (u32, String) {
    let Some(source) = fence_source(shape, n) else {
        return (FENCE_OTHER, format!("unknown shape {shape}"));
    };
    let mut factory = match FactoryRuntime::build(&source, gas, mem_limit, stack_limit) {
        Ok(factory) => factory,
        Err(error) => return (FENCE_OTHER, format!("build: {error:?}")),
    };
    let mut rng = SimRng::from_seed_u64(1);
    let outcome = factory.run(b"1", b"{}", &mut rng);
    let status = match outcome.fault {
        None => FENCE_RAN,
        Some(FaultReason::FactoryError) => FENCE_ERROR,
        Some(FaultReason::FactoryTimeout) => FENCE_TIMEOUT,
        Some(_) => FENCE_OTHER,
    };
    (status, String::from_utf8_lossy(&outcome.fault_message).into_owned())
}

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn finish(result: Result<Replay, String>) -> u32 {
    let (status, text) = match result {
        Ok(replay) => (FC_OK, replay.to_lines()),
        Err(error) => (FC_REFUSED, error),
    };
    OUT.with(|out| *out.borrow_mut() = text.into_bytes());
    status
}

/// Borrow `len` bytes at `ptr`, treating a length of 0 as empty, because `fc_alloc` returns null
/// for 0.
///
/// # Safety
/// When `len` is above 0, `ptr` must point at `len` initialised bytes that stay valid and unchanged
/// for the returned lifetime.
unsafe fn bytes_at<'a>(ptr: *const u8, len: u32) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        return &[];
    }
    // SAFETY: the caller promises `ptr` points at `len` initialised bytes for this lifetime.
    unsafe { std::slice::from_raw_parts(ptr, len as usize) }
}

/// Allocate `len` bytes for the runner to write a fixture into. Returns null for 0, and null if the
/// memory can't grow.
#[unsafe(no_mangle)]
pub extern "C" fn fc_alloc(len: u32) -> *mut u8 {
    let len = len as usize;
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut bytes = Vec::new();
    if bytes.try_reserve_exact(len).is_err() {
        return std::ptr::null_mut();
    }
    bytes.resize(len, 0u8);
    Box::into_raw(bytes.into_boxed_slice()).cast::<u8>()
}

/// Free bytes from [`fc_alloc`]. A null pointer or a length of 0 does nothing.
///
/// # Safety
/// `ptr` and `len` must be a pair `fc_alloc` returned, and this must be the only free of it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fc_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let slice = std::ptr::slice_from_raw_parts_mut(ptr, len as usize);
    // SAFETY: the caller promises `ptr` and `len` came from `fc_alloc`, which made them from a
    // `Box<[u8]>` of exactly this length, and that this is the only free.
    drop(unsafe { Box::from_raw(slice) });
}

/// Replay a golden fixture from three byte ranges. Returns [`FC_OK`] with the replay's lines in the
/// out buffer, or [`FC_REFUSED`] with the error text there.
///
/// # Safety
/// Each pointer must point at its length of initialised bytes, or be null with a length of 0, and
/// those bytes must stay valid for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fc_replay_golden(
    genesis_ptr: *const u8,
    genesis_len: u32,
    log_ptr: *const u8,
    log_len: u32,
    edit_log_ptr: *const u8,
    edit_log_len: u32,
    ticks: u32,
) -> u32 {
    // SAFETY: the caller promises each pointer and length describes valid bytes for this call.
    let (genesis, log, edit_log) = unsafe {
        (
            bytes_at(genesis_ptr, genesis_len),
            bytes_at(log_ptr, log_len),
            bytes_at(edit_log_ptr, edit_log_len),
        )
    };
    finish(replay_golden(genesis, log, edit_log, ticks))
}

/// Replay a scenario fixture from one byte range. Returns [`FC_OK`] with the replay's lines in the
/// out buffer, or [`FC_REFUSED`] with the error text there.
///
/// # Safety
/// `ptr` must point at `len` initialised bytes, or be null with a length of 0, and those bytes must
/// stay valid for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fc_replay_scenario(ptr: *const u8, len: u32) -> u32 {
    // SAFETY: the caller promises the pointer and length describe valid bytes for this call.
    let bytes = unsafe { bytes_at(ptr, len) };
    finish(replay_scenario(bytes))
}

/// Run shape `shape` at size `n` once, with the fault text in the out buffer. A 0 for `gas` means a
/// budget no shape can spend, and a 0 for `mem` or `stack` means this target's default. Returns one
/// of the `FENCE_` statuses.
#[unsafe(no_mangle)]
pub extern "C" fn fc_fence(shape: u32, n: u32, gas: u32, mem: u32, stack: u32) -> u32 {
    let gas = if gas == 0 { UNSPENDABLE_GAS } else { u64::from(gas) };
    let mem = if mem == 0 { DEFAULT_MEM_LIMIT } else { mem };
    let stack = if stack == 0 { DEFAULT_STACK_LIMIT } else { stack };
    let (status, text) = fence(shape, u64::from(n), gas, mem, stack);
    OUT.with(|out| *out.borrow_mut() = text.into_bytes());
    status
}

/// This target's default memory limit in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn fc_default_mem() -> u32 {
    DEFAULT_MEM_LIMIT
}

/// This target's default stack limit in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn fc_default_stack() -> u32 {
    DEFAULT_STACK_LIMIT
}

/// This target's default gas budget. It fits a `u32`, and a budget that didn't would read as
/// `u32::MAX`, which the report's equality rule then catches.
#[unsafe(no_mangle)]
pub extern "C" fn fc_default_gas() -> u32 {
    u32::try_from(DEFAULT_GAS_BUDGET).unwrap_or(u32::MAX)
}

/// The out buffer's address, valid until the next export call.
#[unsafe(no_mangle)]
pub extern "C" fn fc_out_ptr() -> *const u8 {
    OUT.with(|out| out.borrow().as_ptr())
}

/// The out buffer's length in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn fc_out_len() -> u32 {
    OUT.with(|out| u32::try_from(out.borrow().len()).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_golden_fixture_replays_to_its_committed_hashes() {
        let replay = replay_golden(
            include_bytes!("../../fabrico-core/tests/golden/0001-source-belt-collector/genesis.snapshot"),
            include_bytes!("../../fabrico-core/tests/golden/0001-source-belt-collector/log.postcard"),
            include_bytes!("../../fabrico-core/tests/golden/0001-source-belt-collector/edit-log.postcard"),
            10,
        )
        .expect("a committed fixture decodes");
        let committed: Vec<&str> =
            include_str!("../../fabrico-core/tests/golden/0001-source-belt-collector/hashes.txt")
                .lines()
                .collect();
        assert_eq!(replay.hashes, committed);
    }

    #[test]
    fn a_scenario_ends_on_the_hash_in_its_committed_snap() {
        let replay =
            replay_scenario(include_bytes!("../../fabrico-scenario/fixtures/01-exit-gate.postcard"))
                .expect("a committed fixture decodes");
        let snap = include_str!("../../fabrico-scenario/snapshots/01-exit-gate.snap");
        // The body starts after the second `---` of the header.
        let committed = snap.split("---\n").nth(2).and_then(|body| body.lines().next());
        assert!(committed.is_some(), "the snap has a hash line");
        assert_eq!(replay.hashes.last().map(String::as_str), committed);
    }

    #[test]
    fn a_scenario_with_empty_logs_gives_one_hash_of_the_genesis_core() {
        let bytes = Scenario::new(7, Vec::new(), Vec::new()).to_bytes();
        let replay = replay_scenario(&bytes).expect("an empty scenario decodes");
        let genesis = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        });
        assert_eq!(replay.hashes, vec![tick_hash(&genesis)]);
    }

    #[test]
    fn bytes_that_are_not_a_scenario_come_back_as_an_error() {
        let error = replay_scenario(&[0xff; 4]).expect_err("refused");
        assert!(error.starts_with("scenario:"), "{error}");
    }

    #[test]
    fn bytes_that_are_not_a_snapshot_come_back_as_an_error() {
        let error = replay_golden(b"not a snapshot", &[0], &[0], 1).expect_err("refused");
        assert!(error.starts_with("genesis:"), "{error}");
    }

    #[test]
    fn the_lines_hold_one_row_per_tick_and_the_fault_count() {
        let replay = Replay {
            hashes: vec!["aa".to_owned(), "bb".to_owned()],
            faults: 3,
        };
        assert_eq!(replay.to_lines(), "0 aa\n1 bb\nfaults 3\n");
    }
}
