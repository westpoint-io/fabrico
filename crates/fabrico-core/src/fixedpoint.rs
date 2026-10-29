//! Fixed-point sim scalar (`Fx = I32F32`) — the ONLY scalar type used for
//! positions, belt rates, and latencies in the deterministic core (CORE-04).
//!
//! # Why fixed-point
//! `f32`/`f64` are non-deterministic across CPU/OS/compiler (rounding, FMA
//! contraction, x87 vs SSE), which would break replay equality — the core's
//! whole promise. `fixed::types::I32F32` is a typed Q32.32 integer: every
//! add/mul/compare is a deterministic, portable integer operation. The four
//! determinism lints (clippy `disallowed-types`) hard-deny `f32`/`f64` in this
//! crate, so `Fx` is the only sanctioned scalar.
//!
//! # Overflow policy (RESEARCH Pitfall 2)
//! `I32F32` has 32 integer bits, so the magnitude range is generous, but the
//! intermediate of a multiply of two large values can still overflow and
//! silently wrap. Therefore:
//!
//! - At **user-controlled boundaries** (anything derived from a logged event /
//!   save file), use the checked/saturating variants and handle the `None`:
//!   - `Fx::checked_add` / `Fx::checked_mul` return `Option<Fx>`.
//!   - `Fx::saturating_add` / `Fx::saturating_mul` clamp to `MIN`/`MAX`.
//! - For **internal, provably-bounded** arithmetic, the plain operators are
//!   acceptable. A wrap there is a logic bug to fix, not an untrusted input.
//! - Construct constants with the const `Fx::lit` (e.g. `Fx::lit("0.5")`) or
//!   `Fx::from_num`; use [`ZERO`] / [`ONE`].
//! - **Never** mix `I32F32` with another Q-format without an explicit
//!   `to_num`/`from_num` conversion.

/// The canonical fixed-point scalar for all sim math (Q32.32).
///
/// Aliased from [`fixed::types::I32F32`] so the rest of the crate never names a
/// concrete float and the determinism lint stays green.
pub type Fx = fixed::types::I32F32;

/// Fixed-point zero. Equivalent to `Fx::from_num(0)`, usable in `const` context.
pub const ZERO: Fx = Fx::lit("0");

/// Fixed-point one. Equivalent to `Fx::from_num(1)`, usable in `const` context.
pub const ONE: Fx = Fx::lit("1");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixedpoint_mul_is_exact() {
        // 2 * 3 == 6, exactly, no float drift.
        assert_eq!(Fx::from_num(2) * Fx::from_num(3), Fx::from_num(6));
    }

    #[test]
    fn fixedpoint_zero_and_one_consts() {
        assert_eq!(ZERO, Fx::from_num(0));
        assert_eq!(ONE, Fx::from_num(1));
        // The inherent associated consts exist too.
        assert_eq!(ZERO, Fx::ZERO);
        assert_eq!(ONE, Fx::ONE);
    }

    #[test]
    fn fixedpoint_checked_overflow_is_none_not_wrap() {
        // checked_mul at the boundary returns None instead of silently wrapping.
        assert!(Fx::MAX.checked_mul(Fx::from_num(2)).is_none());
        // saturating_mul clamps to MAX.
        assert_eq!(Fx::MAX.saturating_mul(Fx::from_num(2)), Fx::MAX);
    }

    #[test]
    fn fixedpoint_lit_matches_from_num() {
        assert_eq!(Fx::lit("0.5"), Fx::from_num(1) / Fx::from_num(2));
    }
}
