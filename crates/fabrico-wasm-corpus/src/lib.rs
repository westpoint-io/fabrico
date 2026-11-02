//! A test harness for the wasm build. It replays the repo's fixtures through the same fold the
//! desktop build runs, and it probes the Factory limits on that target. Nothing here ships: the
//! player's dependency check refuses this crate by name, so a browser never downloads it.
//!
//! [`replay_golden`] is the one code path for both targets. The native report tool calls it
//! directly, and the wasm module calls it through the `fc_` exports, so a difference between the
//! two reports comes from the target and not from two copies of a loop.
//!
//! The fixture bytes come from the caller. A fixture added to the repo then needs no table edit
//! here, and changing an expected hash needs no rebuild.
//!
//! A panic traps a wasm instance, so a fixture that won't decode comes back as a status with its
//! error text in the out buffer.

#![deny(unsafe_op_in_unsafe_fn)]
#![warn(clippy::all)]

use std::cell::RefCell;
use std::fmt::Write as _;

use fabrico_core::core::Core;
use fabrico_core::edit::EditRecord;
use fabrico_core::event::Event;
use fabrico_core::snapshot;
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
        advance_one_tick(&mut core, &edits, &events, &mut edit_at, &mut event_at, &mut replay);
    }
    Ok(replay)
}

/// One tick of the fold: the same gather, advance and hash order on both targets.
fn advance_one_tick(
    core: &mut Core,
    edits: &[EditRecord],
    events: &[Event],
    edit_at: &mut usize,
    event_at: &mut usize,
    replay: &mut Replay,
) {
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
    replay.faults += core.last_tick.faulted.len() as u64;
    replay.hashes.push(tick_hash(core));
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
