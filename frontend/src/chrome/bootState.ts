// WR-03: boot-time Play/Pause glyph parity.
//
// The sim boots in `RunState::Playing` and `run_sim_thread` immediately calls
// `sim.run(...)`, so the sim ticks live from tick 0 (see
// `crates/fabrico-app/src/lib.rs` -> `sim.run(None, ...)` and
// `crates/fabrico-host/src/sim_loop.rs` -> `run_state: RunState::Playing`). The
// chrome must therefore initialize its optimistic Play/Pause glyph to "playing"
// so the toolbar glyph agrees with reality on every boot. Initializing it to
// `false` showed a *paused* glyph over a live-ticking sim until the first click,
// whose `resume` was then a no-op against the already-Playing sim.
//
// Kept in a tiny import-light module so the boot invariant is unit-testable
// without importing the Pixi/React `App` tree (the vitest suite runs in a `node`
// environment with no DOM/WebGL).
export const SIM_BOOTS_PLAYING = true;
