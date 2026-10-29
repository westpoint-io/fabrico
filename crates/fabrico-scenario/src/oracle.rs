//! The single state-equality digest oracle (threat T-13-HASH).
//!
//! [`tick_hash`] is THE one public per-tick digest in the whole project. It is
//! promoted verbatim from `fabrico-core`'s former test-private oracle; that test
//! module now re-exports this function, so there is exactly ONE semantic digest
//! path everywhere.

use fabrico_core::core::Core;
use fabrico_core::snapshot;

/// `tick_hash` — the single shared per-tick digest every certification criterion
/// compares against (Open Question 2: unify all five criteria on one hash).
///
/// Returns the lowercase-hex `blake3::hash` of the PUBLIC `snapshot::snapshot`
/// bytes (the established state-equality oracle), and never mutates the core.
/// Equal snapshot bytes imply an equal hash, so nothing is lost versus comparing
/// raw `snapshot::snapshot` bytes directly — but the fixed-width hex string is
/// cheap to collect into per-tick sequences and to freeze into a golden corpus
/// manifest.
///
/// Valid ONLY at a clean tick boundary (between `advance()` calls), exactly like
/// the `snapshot` oracle it wraps. There is deliberately a SINGLE digest path
/// (hash the snapshot bytes); never add a second/field-walking digest — two paths
/// are two ways to diverge (threat T-13-HASH).
pub fn tick_hash(core: &Core) -> String {
    blake3::hash(&snapshot::snapshot(core)).to_hex().to_string()
}
