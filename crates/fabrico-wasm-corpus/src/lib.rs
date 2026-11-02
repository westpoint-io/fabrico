//! A test harness for the wasm build. It replays the repo's fixtures through the same fold the
//! desktop build runs, and it probes the Factory limits on that target. Nothing here ships: the
//! player's dependency check refuses this crate by name, so a browser never downloads it.
#![deny(unsafe_op_in_unsafe_fn)]
