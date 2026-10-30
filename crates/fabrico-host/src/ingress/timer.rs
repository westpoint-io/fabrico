//! The timer source. It lives in `fabrico-engine`, so anything that runs the engine without
//! this host fires timers from the same code; this re-export keeps the old import paths working.

pub use fabrico_engine::timer::*;
