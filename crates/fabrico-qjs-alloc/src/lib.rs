//! The Factory runtime's memory-limited allocator.
//!
//! The allocator decides when a Factory runs out of memory, so it has to behave the same on
//! every platform. It lives in this crate because writing one needs `unsafe`, and `fabrico-core`
//! forbids `unsafe`.
