//! The one sentence a fatal sim error reaches the user in (phase 90, FAIL-01, D-11).
//!
//! Both hosts run their sim loop through [`fatal_reason`]: the Tauri shell
//! (`fabrico-app`'s `run_sim_thread`) and the browser-dev host (`dev_render_server`). So the
//! sentence the page shows cannot drift between them, and a panic on the sim thread becomes
//! the same kind of message a store error does instead of a dead thread nobody hears.
//!
//! The sentence is the host's own: a store error's `Display` (for the dev fault seam,
//! `persistence backend error: dev fault injected by dev_render_server`) behind a fixed
//! prefix, or a panic's text payload. It reaches only the stopped card (plan 90-07); the
//! status line carries the generic `Simulation stopped` (T-32-06-01).

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};

use fabrico_core::persist::StoreError;

/// The prefix of a store error's reason (Finding L: the Tauri shell's sentence before phase 90,
/// kept word for word).
pub const STORE_ERROR_PREFIX: &str = "sim loop terminated with a fatal store error: ";

/// The prefix of a panic's reason (D-11).
pub const PANIC_PREFIX: &str = "sim thread panicked: ";

/// The payload word for a panic whose payload is neither a `&str` nor a `String`.
pub const NON_TEXT_PAYLOAD: &str = "(non-text payload)";

/// The reason when the loop returns without an error. `run(None, ..)` loops until a store
/// error, so this is a loop that was asked to stop, which no host does today; it is still a
/// stopped simulation and is said as one.
pub const STOPPED_WITHOUT_ERROR: &str = "sim loop stopped without an error";

/// Run the sim loop and turn how it ended into the one reason sentence.
///
/// `run` is the loop itself (`|| sim.run(None, TICK_PAUSE)`), run inside
/// [`catch_unwind`] so a panic on the sim thread is contained here and becomes a reason. The
/// loop's state is not used after a panic (the caller only reports and parks), which is what
/// makes the [`AssertUnwindSafe`] sound.
///
/// - `Ok(Err(e))`: `sim loop terminated with a fatal store error: <e>`
/// - a panic with a `&str` or `String` payload: `sim thread panicked: <payload>`
/// - a panic with any other payload: `sim thread panicked: (non-text payload)`
/// - `Ok(Ok(()))`: `sim loop stopped without an error`
pub fn fatal_reason(run: impl FnOnce() -> Result<(), StoreError>) -> String {
    match catch_unwind(AssertUnwindSafe(run)) {
        Ok(Err(e)) => format!("{STORE_ERROR_PREFIX}{e}"),
        Ok(Ok(())) => STOPPED_WITHOUT_ERROR.to_owned(),
        Err(payload) => panic_reason(payload.as_ref()),
    }
}

/// A contained panic's payload as the reason sentence: `sim thread panicked: <payload>`, the
/// sentence [`fatal_reason`] gives a panic in the loop. Public so a host that contains a panic
/// in the sim thread's SETUP, before the loop runs (the Tauri shell, phase 90 review IN-A-06),
/// says it in the same words.
#[must_use]
pub fn panic_reason(payload: &(dyn Any + Send)) -> String {
    format!("{PANIC_PREFIX}{}", panic_text(payload))
}

/// A panic payload as text: the `&str` or `String` a `panic!` carries, else a fixed word.
fn panic_text(payload: &(dyn Any + Send)) -> &str {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.as_str()
    } else {
        NON_TEXT_PAYLOAD
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store error is the shell's sentence over the error's own `Display` (Finding L).
    #[test]
    fn a_store_error_becomes_the_fatal_store_error_sentence() {
        assert_eq!(
            fatal_reason(|| Err(StoreError::Backend("x".into()))),
            "sim loop terminated with a fatal store error: persistence backend error: x"
        );
    }

    /// A panic with a `&str` payload is contained and becomes the panic sentence.
    #[test]
    fn a_str_panic_becomes_the_panic_sentence() {
        assert_eq!(fatal_reason(|| panic!("boom")), "sim thread panicked: boom");
    }

    /// A panic with a formatted (`String`) payload reads the same way.
    #[test]
    fn a_string_panic_becomes_the_panic_sentence() {
        let n = 7;
        assert_eq!(fatal_reason(|| panic!("boom {n}")), "sim thread panicked: boom 7");
    }

    /// A panic whose payload is not text names no payload it cannot read.
    #[test]
    fn a_non_text_panic_says_so() {
        assert_eq!(
            fatal_reason(|| std::panic::panic_any(42_u32)),
            "sim thread panicked: (non-text payload)"
        );
    }

    /// A loop that returns without an error is still a stopped simulation.
    #[test]
    fn a_loop_that_returns_ok_says_it_stopped() {
        assert_eq!(fatal_reason(|| Ok(())), "sim loop stopped without an error");
    }
}
