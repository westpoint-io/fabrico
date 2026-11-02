//! The engine as a WebAssembly module.
//!
//! [`Player`] takes a board file's text, steps it and queues one encoded render packet per tick.
//! It holds no tick loop of its own: each tick is one call to
//! [`BoardRun::step`](fabrico_engine::scripted::BoardRun::step), and the state hash comes from
//! [`fabrico_scenario::tick_hash`], the one digest. So a board run here is the same run the
//! desktop's engine makes.
//!
//! Below `Player` are the raw `extern "C"` exports the JavaScript loader calls. They pass bytes
//! through pointers into linear memory, with no generated bindings. Results that are bytes go in
//! one out buffer, which stays valid until the next export call.
//!
//! Players live in a thread-local table keyed by handle, because the core's QuickJS runtimes can't
//! move between threads. With a table, a stale handle returns a status and can't reach freed
//! memory.
//!
//! A panic traps a wasm instance, so no bad-input path here panics. A board that doesn't parse, a
//! stale handle and text that isn't UTF-8 all come back as values.

#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::disallowed_types, clippy::disallowed_methods)]
#![warn(clippy::all)]

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::fmt;

use fabrico_engine::board::{BoardError, parse_board};
use fabrico_engine::render_packet::RenderPacketBuilder;
use fabrico_engine::scripted::BoardRun;
use serde::Serialize;

/// The call succeeded.
pub const FP_OK: u32 = 0;
/// The board was refused or its run stopped. The out buffer holds the error text.
pub const FP_BOARD_ERROR: u32 = 1;
/// No player has this handle. The out buffer holds the error text.
pub const FP_NO_SUCH_HANDLE: u32 = 2;

/// What `fp_tick` and `fp_end_tick` return for a handle no player has. No run can reach this tick,
/// and the loader refuses any tick above JavaScript's safe integers.
const NO_TICK: u64 = u64::MAX;

/// Why a player couldn't load a board or step it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlayerError {
    /// The board was refused, or its run stopped on an error.
    Board(BoardError),
    /// A render packet failed to encode.
    Encode(String),
}

impl fmt::Display for PlayerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Board(error) => write!(f, "{error}"),
            Self::Encode(error) => write!(f, "a render packet failed to encode: {error}"),
        }
    }
}

impl std::error::Error for PlayerError {}

impl From<BoardError> for PlayerError {
    fn from(error: BoardError) -> Self {
        Self::Board(error)
    }
}

fn encode(packet: &impl Serialize) -> Result<Vec<u8>, PlayerError> {
    postcard::to_allocvec(packet).map_err(|error| PlayerError::Encode(error.to_string()))
}

/// One board running from its data file.
///
/// A player keeps everything in this value, so two players on one module can't affect each other.
pub struct Player {
    board_text: String,
    run: BoardRun,
    end_tick: u64,
    builder: RenderPacketBuilder,
    packets: VecDeque<Vec<u8>>,
}

impl Player {
    /// Load a board and boot it. The first packet in the queue is a keyframe of the booted board.
    ///
    /// # Errors
    /// [`PlayerError::Board`] if the text isn't a valid board or a command in it is refused.
    pub fn new(board_text: &str) -> Result<Self, PlayerError> {
        let board = parse_board(board_text)?;
        let end_tick = board.end_tick;
        let run = BoardRun::boot(board)?;

        // The builder's diff baseline starts empty, and a desktop producer has been building since
        // boot. Without this discarded diff, the first diff after the keyframe would repeat the
        // whole board.
        let mut builder = RenderPacketBuilder::new();
        let _baseline = builder.build(run.engine());
        let keyframe = builder.build_keyframe(run.engine());

        let mut packets = VecDeque::new();
        packets.push_back(encode(&keyframe)?);
        Ok(Self { board_text: board_text.to_owned(), run, end_tick, builder, packets })
    }

    /// Run up to `ticks` ticks, stopping at the board's end tick, and queue one packet per tick. A
    /// diff is defined per tick, so a caller stepping many ticks at once still gets every one.
    ///
    /// # Errors
    /// [`PlayerError::Board`] if the run stopped on an error, and every later step returns it too.
    pub fn step(&mut self, ticks: u32) -> Result<(), PlayerError> {
        for _ in 0..ticks {
            if self.run.is_finished() {
                break;
            }
            self.run.step()?;
            let packet = self.builder.build(self.run.engine());
            self.packets.push_back(encode(&packet)?);
        }
        Ok(())
    }

    /// The next queued packet, in postcard bytes.
    pub fn take_packet(&mut self) -> Option<Vec<u8>> {
        self.packets.pop_front()
    }

    /// The core's current tick.
    #[must_use]
    pub fn tick(&self) -> u64 {
        self.run.engine().core().tick
    }

    /// The tick this board's run stops at.
    #[must_use]
    pub fn end_tick(&self) -> u64 {
        self.end_tick
    }

    /// The state hash at the current tick, as 64 hex characters.
    #[must_use]
    pub fn tick_hash(&self) -> String {
        fabrico_scenario::tick_hash(self.run.engine().core())
    }

    /// The board file's text, as it was loaded.
    #[must_use]
    pub fn board_text(&self) -> &str {
        &self.board_text
    }
}

/// What the exports share. The one import, the clock, doesn't call back in, so a borrow held across
/// a step can't be taken twice.
struct Exports {
    players: BTreeMap<u32, Player>,
    next_handle: u32,
    out: Vec<u8>,
}

impl Exports {
    /// Put an error's text in the out buffer.
    fn set_error(&mut self, text: impl fmt::Display) {
        self.out = text.to_string().into_bytes();
    }

    /// Put the no-such-handle text in the out buffer and return its status.
    fn no_such_handle(&mut self, handle: u32) -> u32 {
        self.set_error(format_args!("no player has handle {handle}"));
        FP_NO_SUCH_HANDLE
    }
}

thread_local! {
    static EXPORTS: RefCell<Exports> = const {
        RefCell::new(Exports { players: BTreeMap::new(), next_handle: 1, out: Vec::new() })
    };
}

fn with_exports<R>(f: impl FnOnce(&mut Exports) -> R) -> R {
    EXPORTS.with(|exports| f(&mut exports.borrow_mut()))
}

/// A length as the `u32` the exports use. Wasm32 lengths always fit. A desktop build saturates,
/// and it never holds a packet that large.
fn len_u32(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}

/// Allocate `len` bytes for the loader to write into. Returns null for 0, and null if the memory
/// can't grow, so an oversized board text is a value and not a trap.
#[unsafe(no_mangle)]
pub extern "C" fn fp_alloc(len: u32) -> *mut u8 {
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

/// Free what [`fp_alloc`] returned. A null pointer or a length of 0 does nothing.
///
/// # Safety
/// A non-null `ptr` must have come from `fp_alloc(len)` with this same `len`, and must not have
/// been freed already.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fp_free(ptr: *mut u8, len: u32) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let slice = std::ptr::slice_from_raw_parts_mut(ptr, len as usize);
    // SAFETY: the caller promises `ptr` and `len` came from `fp_alloc`, which made them from a
    // `Box<[u8]>` of exactly this length, and that this is the only free.
    drop(unsafe { Box::from_raw(slice) });
}

/// Load a board from `len` bytes of UTF-8 text at `ptr`, which are copied. Returns a handle above
/// 0, or 0 with the error text in the out buffer.
///
/// # Safety
/// When `len` is above 0, `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fp_create(ptr: *const u8, len: u32) -> u32 {
    let bytes: &[u8] = if len == 0 || ptr.is_null() {
        &[]
    } else {
        // SAFETY: the caller promises `len` readable bytes at `ptr`, and the slice ends before
        // this function returns.
        unsafe { std::slice::from_raw_parts(ptr, len as usize) }
    };
    let loaded = match std::str::from_utf8(bytes) {
        Ok(text) => Player::new(text).map_err(|error| error.to_string()),
        Err(error) => Err(format!("the board text is not UTF-8: {error}")),
    };
    with_exports(|exports| {
        exports.out.clear();
        let player = match loaded {
            Ok(player) => player,
            Err(text) => {
                exports.set_error(text);
                return 0;
            }
        };
        // A handle is never reused, so a stale one can't reach a later board.
        let handle = exports.next_handle;
        let Some(next_handle) = handle.checked_add(1) else {
            exports.set_error("this module has run out of player handles");
            return 0;
        };
        exports.next_handle = next_handle;
        exports.players.insert(handle, player);
        handle
    })
}

/// Drop a player. Returns a status.
#[unsafe(no_mangle)]
pub extern "C" fn fp_destroy(handle: u32) -> u32 {
    with_exports(|exports| {
        exports.out.clear();
        if exports.players.remove(&handle).is_some() { FP_OK } else { exports.no_such_handle(handle) }
    })
}

/// Run up to `ticks` ticks, stopping at the end tick. Each tick queues one packet. Returns a
/// status.
#[unsafe(no_mangle)]
pub extern "C" fn fp_step(handle: u32, ticks: u32) -> u32 {
    with_exports(|exports| {
        exports.out.clear();
        let Some(player) = exports.players.get_mut(&handle) else {
            return exports.no_such_handle(handle);
        };
        match player.step(ticks) {
            Ok(()) => FP_OK,
            Err(error) => {
                exports.set_error(error);
                FP_BOARD_ERROR
            }
        }
    })
}

/// Move the next packet to the out buffer and return its byte length. Returns 0 with an empty out
/// buffer when the queue is empty, and 0 with the error text in the out buffer for a stale handle.
#[unsafe(no_mangle)]
pub extern "C" fn fp_take_packet(handle: u32) -> u32 {
    with_exports(|exports| {
        exports.out.clear();
        let Some(player) = exports.players.get_mut(&handle) else {
            exports.no_such_handle(handle);
            return 0;
        };
        match player.take_packet() {
            Some(packet) => {
                let len = len_u32(packet.len());
                exports.out = packet;
                len
            }
            None => 0,
        }
    })
}

/// The player's current tick, or `u64::MAX` with the error text in the out buffer for a stale
/// handle.
#[unsafe(no_mangle)]
pub extern "C" fn fp_tick(handle: u32) -> u64 {
    read_tick(handle, Player::tick)
}

/// The tick the player's run stops at, or `u64::MAX` with the error text in the out buffer for a
/// stale handle.
#[unsafe(no_mangle)]
pub extern "C" fn fp_end_tick(handle: u32) -> u64 {
    read_tick(handle, Player::end_tick)
}

fn read_tick(handle: u32, read: fn(&Player) -> u64) -> u64 {
    with_exports(|exports| {
        exports.out.clear();
        match exports.players.get(&handle) {
            Some(player) => read(player),
            None => {
                exports.no_such_handle(handle);
                NO_TICK
            }
        }
    })
}

/// Put the hex state hash in the out buffer and return its byte length. Returns 0 with the error
/// text in the out buffer for a stale handle.
#[unsafe(no_mangle)]
pub extern "C" fn fp_tick_hash(handle: u32) -> u32 {
    with_exports(|exports| {
        exports.out.clear();
        let Some(player) = exports.players.get(&handle) else {
            exports.no_such_handle(handle);
            return 0;
        };
        let hash = player.tick_hash().into_bytes();
        let len = len_u32(hash.len());
        exports.out = hash;
        len
    })
}

/// The out buffer's address, valid until the next export call.
#[unsafe(no_mangle)]
pub extern "C" fn fp_out_ptr() -> *const u8 {
    with_exports(|exports| exports.out.as_ptr())
}

/// The out buffer's length in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn fp_out_len() -> u32 {
    with_exports(|exports| len_u32(exports.out.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO_BOARD: &str = include_str!("../../../examples/boards/demo_scene.board.ron");
    const MANIFEST: &str = include_str!("../../../examples/boards/hashes.manifest");

    fn out_text() -> String {
        with_exports(|exports| String::from_utf8_lossy(&exports.out).into_owned())
    }

    fn create(text: &[u8]) -> u32 {
        let len = len_u32(text.len());
        let ptr = fp_alloc(len);
        if len > 0 {
            // SAFETY: `fp_alloc(len)` returned room for `len` bytes, and `text` has exactly `len`.
            unsafe { std::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len()) };
        }
        // SAFETY: `ptr` holds `len` readable bytes, or `len` is 0.
        let handle = unsafe { fp_create(ptr, len) };
        // SAFETY: `ptr` came from `fp_alloc(len)` above and this is its only free.
        unsafe { fp_free(ptr, len) };
        handle
    }

    #[test]
    fn the_demo_board_ends_on_its_manifest_line_through_the_exports() {
        let (_, end_tick, hash) = MANIFEST
            .lines()
            .filter_map(|line| {
                let mut fields = line.split(' ');
                Some((fields.next()?, fields.next()?, fields.next()?))
            })
            .find(|(path, _, _)| *path == "examples/boards/demo_scene.board.ron")
            .expect("the manifest has a demo line");

        let handle = create(DEMO_BOARD.as_bytes());
        assert!(handle > 0, "the demo board loads: {}", out_text());
        assert_eq!(fp_end_tick(handle).to_string(), end_tick);

        // This asks for far more ticks than the run has, to show a step stops at the end tick.
        assert_eq!(fp_step(handle, u32::MAX), FP_OK);
        assert_eq!(fp_tick(handle).to_string(), end_tick);
        assert_eq!(fp_tick_hash(handle), 64);
        assert_eq!(out_text(), hash);
        assert_eq!(fp_destroy(handle), FP_OK);
    }

    #[test]
    fn a_board_that_does_not_parse_returns_no_handle_and_the_error_text() {
        assert_eq!(create(b"not a board"), 0);
        assert!(out_text().contains("failed to parse"), "got: {}", out_text());
    }

    #[test]
    fn empty_text_returns_no_handle_and_the_error_text() {
        assert_eq!(create(b""), 0);
        assert!(!out_text().is_empty());
    }

    #[test]
    fn text_that_is_not_utf8_returns_no_handle_and_the_error_text() {
        assert_eq!(create(&[0xff, 0xfe, 0xfd]), 0);
        assert!(out_text().contains("not UTF-8"), "got: {}", out_text());
    }

    #[test]
    fn a_stale_handle_gets_a_status_from_every_export_that_takes_one() {
        let handle = create(DEMO_BOARD.as_bytes());
        assert_eq!(fp_destroy(handle), FP_OK);

        assert_eq!(fp_destroy(handle), FP_NO_SUCH_HANDLE);
        assert_eq!(fp_step(handle, 1), FP_NO_SUCH_HANDLE);
        assert!(out_text().contains("no player has handle"), "got: {}", out_text());

        assert_eq!(fp_take_packet(handle), 0);
        assert!(!out_text().is_empty(), "a stale handle differs from an empty queue");

        assert_eq!(fp_tick(handle), NO_TICK);
        assert_eq!(fp_end_tick(handle), NO_TICK);
        assert_eq!(fp_tick_hash(handle), 0);
        assert!(!out_text().is_empty());
    }

    #[test]
    fn an_empty_queue_returns_0_with_an_empty_out_buffer() {
        let handle = create(DEMO_BOARD.as_bytes());
        assert!(fp_take_packet(handle) > 0, "the keyframe is queued at boot");
        assert_eq!(fp_take_packet(handle), 0);
        assert_eq!(fp_out_len(), 0);
        assert_eq!(fp_destroy(handle), FP_OK);
    }

    #[test]
    fn two_players_on_one_thread_do_not_affect_each_other() {
        let mut alone = Player::new(DEMO_BOARD).expect("the demo board loads");
        alone.step(50).expect("it steps");

        let mut first = Player::new(DEMO_BOARD).expect("the demo board loads");
        let mut second = Player::new(DEMO_BOARD).expect("the demo board loads");
        for _ in 0..50 {
            first.step(1).expect("it steps");
            second.step(1).expect("it steps");
        }
        assert_eq!(first.tick_hash(), alone.tick_hash());
        assert_eq!(second.tick_hash(), alone.tick_hash());
    }

    #[test]
    fn fp_alloc_returns_null_for_0_and_fp_free_ignores_null() {
        assert!(fp_alloc(0).is_null());
        // SAFETY: a null pointer is documented to do nothing.
        unsafe { fp_free(std::ptr::null_mut(), 8) };
    }
}
