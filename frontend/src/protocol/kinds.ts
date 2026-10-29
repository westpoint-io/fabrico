// Frontend mirror of the `machine_kind` / `state_tag` u8 conventions defined in
// crates/fabrico-protocol/src/lib.rs. These bytes ride on NodeView.kind /
// NodeView.state; keeping a single named source here (rather than scattering
// magic numbers through the render layers) keeps the renderer honest against the
// Rust contract. They are bare bytes by design — NOT enum-index coupled — so the
// renderer maps a byte to a sprite/tint without a variant-index dependency.

/** NodeView.kind — the machine class. Must match `machine_kind` (Rust). */
export const machine_kind = {
  SOURCE: 0,
  BELT: 1,
  FACTORY: 2,
  TEE: 3,
  BALANCER: 4,
  ROUTER: 5,
  MERGE: 6,
  SINK: 7,
  // Appended LAST to catch up to the Rust `machine_kind` contract
  // (crates/fabrico-protocol/src/lib.rs:86,89). These bytes are NOT enum-index
  // coupled — they are appended by design; WIRE=8 is the request/response
  // transport wire (Phase-37 seam), ENDPOINT=9 the host-bridge endpoint (Phase-38).
  WIRE: 8,
  ENDPOINT: 9,
  // Appended LAST at the next free byte, same discipline as WIRE=8/ENDPOINT=9 above.
  // HANDLER=10 is the HTTP Handler (Phase-72 SERVE-03): user code a webhook reaches
  // over a wire. Must match `machine_kind::HANDLER` in
  // crates/fabrico-protocol/src/lib.rs. A Handler FOLDS to a Node::Factory in the
  // core (D-11), so this byte is the only thing that tells the two apart on screen:
  // the palette row, the config heading and both LOD tables read it.
  HANDLER: 10,
  // Appended LAST at the next free byte (phase 76, SHAPE-10). LABEL=11 is a note on the
  // board: a Node::Label carrying the user's words and one of six colours. Must match
  // `machine_kind::LABEL` in crates/fabrico-protocol/src/lib.rs, locked by
  // crates/fabrico-command/tests/ts_label_mirror.rs. A label is in neither LOD table; the
  // machines layer draws it by its own branch.
  LABEL: 11,
} as const;

/** NodeView.state — the visual state. Must match `state_tag` (Rust). */
export const state_tag = {
  IDLE: 0,
  WORKING: 1,
  FAULTED: 2,
  // Appended LAST at the next free byte to catch up to the Rust `state_tag`
  // contract (crates/fabrico-protocol/src/lib.rs). NOT enum-index coupled - it is
  // appended by design, exactly like WIRE=8/ENDPOINT=9 above. BACKED_UP=3 is the jam
  // mark. It means the machine's mechanical inbox is AT the admission cap and is
  // refusing further belt deliveries (PILE-08), or a Source's backlog is at its cap
  // (JAM-06), or, since phase 87 (JAM-04, D-06), the machine did not step this tick and
  // waits behind an output that cannot take one more item while holding work: a blocked
  // machine sleeps, and without this it would read IDLE. The host's order is FAULTED,
  // refusing, WORKING, waiting, IDLE. The magnitude rides beside it on NodeView.load as
  // a LEVEL of 0..4 already quantised host-side (a waiting machine's level can be below
  // 4): the cap itself is NEVER mirrored here, so there is one derivation, one place,
  // one cap.
  BACKED_UP: 3,
} as const;

/**
 * NodeView.load's top level: the machine's fullest mechanical inbox port is AT the admission
 * cap and refusing a belt delivery. Must match `LOAD_FULL` in
 * crates/fabrico-host/src/render_packet.rs, locked by crates/fabrico-host/tests/ts_load_full_mirror.rs.
 *
 * It is a LEVEL on the 0..4 scale the host quantises, not the cap itself (the cap is still
 * never mirrored here). It is the one byte that says "this machine takes no more from a belt"
 * whatever `state` reads: FAULTED wins the state byte over a full inbox, and BACKED_UP is also
 * worn by a machine waiting behind its output with room in its inbox. The port panel's
 * backed-up rule reads it (`portFlow.ts`, phase 91 review WR-A-01).
 */
export const LOAD_FULL = 4;

export type MachineKind = (typeof machine_kind)[keyof typeof machine_kind];
export type StateTag = (typeof state_tag)[keyof typeof state_tag];
