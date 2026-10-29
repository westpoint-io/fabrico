//! Seeded, state-serializable deterministic PRNG for the sim core (CORE-05).
//!
//! [`SimRng`] wraps a [`ChaCha8Rng`]. The genesis seed is recorded in the log
//! header ([`crate::event::LogHeader`]); the RNG's **current counter state** is
//! captured in snapshots via serde (the `rand_chacha` `serde` feature
//! serializes the advanced state, not just the seed — RESEARCH Pitfall 7). This
//! is load-bearing for snapshot/restore: restoring re-seeds nothing, it resumes
//! the exact stream position, so a restored run produces the same draws as the
//! uninterrupted run.
//!
//! Ambient/unseeded RNG (`thread_rng`, `rand::random`, `fastrand`) is banned in
//! this crate by the determinism lints — `SimRng` is the only sanctioned source
//! of randomness, reached through the capability `Ctx` in later plans.

use rand_chacha::ChaCha8Rng;
use rand_core::{RngCore, SeedableRng};

/// Deterministic, seeded, snapshot-serializable PRNG.
///
/// `Serialize`/`Deserialize` capture the **current** ChaCha8 state, so a
/// round-tripped `SimRng` continues the identical stream.
///
/// # Derives
/// `Debug`, `PartialEq`, `Eq` are derived (all implemented by `ChaCha8Rng`) so a
/// struct that *embeds* a `SimRng` — notably the Phase-4
/// [`Factory`](crate::state::Factory) plain data, whose per-node substream is one
/// of its fields — can itself derive `Debug`/`PartialEq`/`Eq` exactly like the
/// other `Node` variants. `PartialEq`/`Eq` compare the **full advanced counter
/// state**, so two `SimRng`s are equal iff they would produce the identical
/// remaining stream — the precise notion the snapshot equality oracle needs.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SimRng(ChaCha8Rng);

impl SimRng {
    /// Construct from a 64-bit genesis seed (recorded in the log header).
    pub fn from_seed_u64(seed: u64) -> Self {
        Self(ChaCha8Rng::seed_from_u64(seed))
    }

    /// Construct from a full 32-byte seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self(ChaCha8Rng::from_seed(seed))
    }

    /// Next 64-bit draw, advancing the state.
    pub fn next_u64(&mut self) -> u64 {
        self.0.next_u64()
    }

    /// Next 32-bit draw, advancing the state.
    pub fn next_u32(&mut self) -> u32 {
        self.0.next_u32()
    }

    /// Fill `dest` with random bytes, advancing the state.
    pub fn fill_bytes(&mut self, dest: &mut [u8]) {
        self.0.fill_bytes(dest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_same_seed_reproduces_stream() {
        let mut a = SimRng::from_seed_u64(7);
        let mut b = SimRng::from_seed_u64(7);
        for _ in 0..3 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn rng_different_seeds_diverge() {
        let mut a = SimRng::from_seed_u64(7);
        let mut b = SimRng::from_seed_u64(8);
        // Extremely unlikely to match on the first draw; guards against a
        // seed being silently ignored.
        assert_ne!(a.next_u64(), b.next_u64());
    }

    #[test]
    fn rng_state_round_trips_and_continues_same_stream() {
        // Advance by K draws, snapshot the CURRENT state, restore, and assert
        // the restored RNG continues the identical stream (Pitfall 7).
        let mut live = SimRng::from_seed_u64(42);
        for _ in 0..5 {
            let _ = live.next_u64();
        }

        let bytes = postcard::to_allocvec(&live).expect("serialize rng state");
        let mut restored: SimRng = postcard::from_bytes(&bytes).expect("deserialize rng state");

        // The next 4 draws from the live and restored RNGs must match exactly.
        for _ in 0..4 {
            assert_eq!(live.next_u64(), restored.next_u64());
        }
    }
}
