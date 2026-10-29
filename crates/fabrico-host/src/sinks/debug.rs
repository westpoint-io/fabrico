//! The `Effect::Debug` sink: surfaces per-item payload bytes in-host with no
//! I/O — the first, simplest sink, built ahead of http.
//!
//! It opens no socket, builds no provider message, and reads no host config: it
//! exists to exercise the full `emit → dispatch → Outcome` path before any real
//! I/O lands. It is therefore infallible and always reports
//! `Outcome::Success` (SINK-01). Because it performs no network work it
//! pulls in no HTTP client crate.

use fabrico_core::command::Outcome;

/// Handle an `Effect::Debug` in-host: observe the per-item `message` bytes and
/// report success. No socket, no executor, no host config.
///
/// In a desktop build this is where the debug machine surfaces the bytes to the
/// inspector UI; here it records the payload length as the observable side
/// effect and returns `Outcome::Success`. The full byte slice is available to a
/// future tracing/inspector hook without changing this signature.
#[must_use]
pub fn dispatch_debug(message: &[u8]) -> Outcome {
    // The observable, I/O-free "effect": note how many bytes the debug sink saw.
    // (A desktop build forwards `message` to the inspector channel here.)
    let _observed_len = message.len();
    Outcome::Success
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_no_executor() {
        // The debug sink needs no executor / no socket and always succeeds.
        assert_eq!(dispatch_debug(b"hello debug payload"), Outcome::Success);
        // Empty payloads are handled the same way (no panic, still Success).
        assert_eq!(dispatch_debug(&[]), Outcome::Success);
    }
}
