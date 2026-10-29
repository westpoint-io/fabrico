// The transport abstraction: ONE interface, two byte-identical implementations.
//
// The app must run standalone in the browser (dev WebSocket against the axum
// host) AND under Tauri (a binary Channel) with the IDENTICAL postcard bytes on
// both paths (Pitfall 6). Neither impl leaks Tauri-only or ws-only symbols to
// the renderer — both are reached only through `ITransport`.
//
// The transport is created ONCE (module singleton). No per-frame reconnect, no
// React StrictMode duplication (Pitfall 5 / threat T-07-TRANSPORT-DUP).

import { makeDevWebSocketTransport } from './devWebSocket.ts';
import { makeTauriChannelTransport } from './tauriChannel.ts';

/**
 * The control intents the toolbar / gesture layer drives on the host. These are
 * NOT grid mutations — each maps to a discrete, capability-scoped host command
 * (Tauri) or a dev-server control frame (browser). Save/Load carry an
 * already-chosen path (from the native dialog or the dev prompt fallback);
 * loadExample carries a typed [`SceneWireId`].
 */
export type ControlKind =
  | 'pause'
  | 'resume'
  | 'step'
  | 'save'
  | 'load'
  | 'loadDemo'
  | 'loadExample'
  | 'new';

/**
 * The closed set of shipped-scene wire ids (EX-02, UI-SPEC A6). These are the
 * EXACT strings the host's typed `SceneId::parse` boundary accepts — typing the
 * `loadExample` arg as this union makes an unknown id a COMPILE-TIME error, so
 * the popover structurally cannot emit a bad id (the host's typed reject is
 * unreachable from the shipped UI).
 */
export type SceneWireId = 'demo_scene' | 'order_processing' | 'advanced';

/**
 * The `kind` discriminator on a host gesture-refusal TEXT frame. It must match
 * `GESTURE_REFUSAL_KIND` in `crates/fabrico-host/src/transport_ws.rs`.
 *
 * WHY A DISCRIMINATOR EXISTS AT ALL: outbound TEXT frames carried no kind tag
 * before Phase 64, and the config-query resolver returns `false` for anything it
 * does not recognise with no console warning and no else branch. An untagged
 * refusal frame would be swallowed in complete silence.
 */
export const GESTURE_REFUSAL_KIND = 'gestureRefused';

/**
 * The `kind` discriminator on a host gesture-ACCEPT frame (phase 88, D-06): the gesture
 * folded, and the frame names the render handles it minted. It must match
 * `GESTURE_ACCEPT_KIND` in `crates/fabrico-host/src/transport_ws.rs`, and that is a CHECK:
 * `command_error_view.rs`'s `the_frontend_gesture_accept_kind_matches_this_crates_wire_kind`
 * reads this literal out of this file.
 */
export const GESTURE_ACCEPT_KIND = 'gestureAccepted';

/**
 * The `kind` discriminator on a host gesture-DISCARD frame (phase 88, D-05, D-06): a board
 * swap (Load, an example, New) dropped the gesture before it folded. It must match
 * `GESTURE_DISCARD_KIND` in `crates/fabrico-host/src/transport_ws.rs`, checked by
 * `the_frontend_gesture_discard_kind_matches_this_crates_wire_kind`.
 */
export const GESTURE_DISCARD_KIND = 'gestureDiscarded';

/**
 * The `kind` discriminator on a host LOAD-REFUSAL frame (UNDO-09). It must match
 * `LOAD_REFUSAL_KIND` in `crates/fabrico-host/src/transport_ws.rs`, and that is a CHECK
 * rather than a comment: `command_error_view.rs`'s
 * `the_frontend_load_refusal_kind_matches_this_crates_wire_kind` `include_str!`s THIS
 * FILE and compares the two literals, so renaming either side alone reddens.
 *
 * WHY A DISCRIMINATOR EXISTS AT ALL: the same reason `GESTURE_REFUSAL_KIND` has one.
 * The config-query resolver returns `false` for anything it does not recognise with no
 * console warning and no else branch, so an untagged frame is swallowed in complete
 * silence.
 *
 * WHAT THIS FRAME CARRIES THAT THE GESTURE REFUSAL CANNOT. A gesture refusal is
 * payload-free by design - a fieldless tag and an integer, so no filesystem path, node
 * handle, internal index or host `Display` string can ride it (T-64-05-02). This frame
 * DELIBERATELY carries the host's `ProjectError` `Display` sentence, because UNDO-09's
 * requirement is the reason "in the words the host already wrote". The guarantee that
 * no path rides along is a host-side test over every `ProjectError` variant
 * (`crates/fabrico-host/tests/project_error_copy.rs`), not the shape of this frame.
 */
export const LOAD_REFUSAL_KIND = 'loadRefused';

/**
 * The `kind` discriminator of the SIM-FATAL frame (phase 90, FAIL-01, D-11): the host's sim loop
 * ended and will not come back. Mirrored by `SIM_FATAL_KIND` in
 * `crates/fabrico-host/src/transport_ws.rs`, and that is a CHECK rather than a comment:
 * `command_error_view.rs`'s `the_frontend_sim_fatal_kind_matches_this_crates_wire_kind`
 * `include_str!`s THIS FILE and compares the two literals, so renaming either side alone reddens.
 *
 * The frame carries the host's reason sentence for the stopped card (plan 90-07). The status line
 * never shows it: it reads the generic `Simulation stopped` (T-32-06-01).
 */
export const SIM_FATAL_KIND = 'simFatal';

/**
 * Narrow an untrusted sim-fatal frame to its reason (phase 90, FAIL-01). REJECT-ONLY: the
 * `kind` must be {@link SIM_FATAL_KIND} and `reason` a string, an empty one kept (an empty
 * reason is still a stopped simulation); anything else is `null`. Never throws, so it is safe
 * inside a socket or channel callback. Shared by both transports so neither drifts.
 */
export function parseSimFatal(frame: unknown): string | null {
  if (frame === null || typeof frame !== 'object') return null;
  const r = frame as { kind?: unknown; reason?: unknown };
  if (r.kind !== SIM_FATAL_KIND) return null;
  if (typeof r.reason !== 'string') return null;
  return r.reason;
}

/**
 * The `kind` discriminator of a host SAVE-FAILURE frame (phase 90 review WR-A-03): the host could
 * not write a Save this page sent (a disk error, or a drain that ran out of budget with an effect
 * still in flight). Mirrored by `SAVE_FAILURE_KIND` in `crates/fabrico-host/src/transport_ws.rs`,
 * checked by `command_error_view.rs`'s `the_frontend_save_failure_kind_matches_this_crates_wire_kind`.
 * It rides the load-refusal path on both transports under this distinct kind.
 */
export const SAVE_FAILURE_KIND = 'saveFailed';

/**
 * Narrow an untrusted save-failure frame to its reason (phase 90 review WR-A-03). REJECT-ONLY,
 * the {@link parseSimFatal} shape: the `kind` must be {@link SAVE_FAILURE_KIND} and `reason` a
 * string; anything else is `null`. Never throws. Shared by both transports so neither drifts.
 */
export function parseSaveFailure(frame: unknown): string | null {
  if (frame === null || typeof frame !== 'object') return null;
  const r = frame as { kind?: unknown; reason?: unknown };
  if (r.kind !== SAVE_FAILURE_KIND) return null;
  if (typeof r.reason !== 'string') return null;
  return r.reason;
}

/**
 * The closed set of host refusal tags (ERR-02). These are EXACTLY the variant names
 * of `CommandErrorView` in `crates/fabrico-host/src/command_error_view.rs`: the 19
 * payload-free `CommandError` variants plus `Route(..)` flattened into three peers.
 *
 * A Rust test reddens if a tag is renamed on that side, and the link is REAL rather
 * than asserted: `command_error_view.rs::the_frontend_refusal_tag_set_matches_this_crates_wire_tags`
 * `include_str!`s THIS FILE, parses the `REFUSAL_TAGS` keys below out of it, and
 * compares them to the Rust `WIRE_TAGS` table. Renaming a tag on both Rust sides -
 * the variant and its table row - leaves every other test in the workspace green and
 * fails that one alone. An earlier revision of this comment made the same claim while
 * the only test behind it pinned Rust against Rust, so a Rust rename would have
 * narrowed to nothing here and shipped the refusal as silence.
 *
 * The union is CLOSED on purpose. The copy table (plan 64-09) is a
 * `Record<RefusalTag, string>`, so a new host tag becomes a compile error here
 * rather than a refusal that reaches a user with no sentence attached - which is
 * the invented-generic-string failure ERR-02 exists to forbid.
 *
 * IT IS 38 TAGS. It was 17 until plan 68-04 added `PaceOutOfRange`, 18 until plan
 * 72-07 added `DuplicatePath` (SERVE-08: a second Route claiming an address a live
 * Route already answers at), and 19 until plan 74.1-18 added three belt refusals:
 * `RotateCoversBelt` (review WR-03, the maintainers' "Refuse, say why": a turn that would cover a
 * belt), `GrowCoversBelt` (an output add whose grown box would cover a belt) and
 * `InvalidBeltJoin` (gap N4c: a belt-to-belt join that breaks the belt rule), and 22 until plan
 * 74.1-24 split two causes out of that last one (gap J11): `BeltJoinTurnsBack` (the U-turn
 * join) and `BeltEndsApart` (belt ends that do not touch), and 24 until plan 74.1-32 added
 * `BeltEndTaken` (the third re-walk's HEAD-WORDS: a dock whose taken source is a belt's end,
 * which until then read the machine-output sentence), and 25 until plan 76-02 added
 * `ResizeCovers` (phase 76, D-04: a size change whose new box would cover something, first
 * produced by a label growing over a neighbour), and 26 until plan 76-04 added
 * `LabelDoesNotConnect` (phase 76, D-07: a forged Dock, DrawWire or AddPort naming a label),
 * and 27 until plan 86-06 added `UndoSpaceTaken` (phase 86, D-04: an Undo whose restore would
 * land on cells another node now holds, reachable only from a forged or corrupted history),
 * and 28 until plan 88-02 split the three tags that carried two causes (phase 88, FAIL-09,
 * D-11): `Malformed` narrowed to a frame the host cannot read, with `NoSuchPort`,
 * `UnknownOption`, `OverLimit`, `InvalidPath`, `WrongKind` and `UndoDoesNotFit` for the
 * frames it read and cannot carry out (WINDOWS 81); `MachineTooBig` out of `OutOfBounds` for
 * a machine grown past the size limit (WINDOWS 83); `RotateBlocked` and `GrowBlocked` out of
 * `FootprintCollision` for a turn or an output add blocked by a machine (WINDOWS 84); and
 * `BoardChanged` (D-03), which plan 88-04's generation resolver produces, added in the same
 * commit so the count moves once.
 * Widening is exactly what `error.rs`'s own docblock says
 * the mechanism is: a new `CommandError` variant is a SPEC change rather than a copy
 * change. The count moves in FOUR places at once - here, `REFUSAL_TAGS` below, the Rust
 * `WIRE_TAGS` table and its two count assertions - and the Rust-side parse below is
 * what makes forgetting one of them a red rather than a refusal the user reads as
 * silence.
 */
export type RefusalTag =
  | 'FootprintCollision'
  | 'OutOfBounds'
  | 'UnknownNode'
  | 'IncompatiblePorts'
  | 'PortOccupied'
  | 'UnknownKind'
  | 'BeltNotPlaceable'
  | 'InvalidDock'
  | 'Malformed'
  | 'BeltTooLong'
  | 'NothingToUndo'
  | 'NothingToRedo'
  | 'MediumMismatch'
  | 'ZeroBeltInterval'
  | 'PaceOutOfRange'
  | 'RouteEmpty'
  | 'RouteNonAdjacent'
  | 'RouteSelfCrossing'
  | 'DuplicatePath'
  | 'RotateCoversBelt'
  | 'GrowCoversBelt'
  | 'InvalidBeltJoin'
  | 'BeltJoinTurnsBack'
  | 'BeltEndsApart'
  | 'BeltEndTaken'
  | 'ResizeCovers'
  | 'LabelDoesNotConnect'
  | 'UndoSpaceTaken'
  | 'NoSuchPort'
  | 'UnknownOption'
  | 'OverLimit'
  | 'InvalidPath'
  | 'WrongKind'
  | 'UndoDoesNotFit'
  | 'MachineTooBig'
  | 'RotateBlocked'
  | 'GrowBlocked'
  | 'BoardChanged';

/**
 * The runtime key set behind [`isRefusalTag`]. Typed `Record<RefusalTag, true>` so
 * the compiler rejects a MISSING key and an EXTRA one alike - that is the only
 * reason it is safe for the union above and this set to both exist. That weld is also
 * why the Rust-side lock pins THIS object rather than the union: this is the half
 * `isRefusalTag` narrows against at runtime, and the compiler carries the union along.
 *
 * PARSED BY RUST. `command_error_view.rs` reads these keys out of this file's source
 * with a deliberately strict `Tag: true,` line parser that PANICS on any other shape.
 * Keep one entry per line in exactly that form - a spread, a computed key or a
 * trailing comment on the same line fails the parse loudly rather than silently
 * dropping a tag from the comparison.
 */
const REFUSAL_TAGS: Record<RefusalTag, true> = {
  FootprintCollision: true,
  OutOfBounds: true,
  UnknownNode: true,
  IncompatiblePorts: true,
  PortOccupied: true,
  UnknownKind: true,
  BeltNotPlaceable: true,
  InvalidDock: true,
  Malformed: true,
  BeltTooLong: true,
  NothingToUndo: true,
  NothingToRedo: true,
  MediumMismatch: true,
  ZeroBeltInterval: true,
  PaceOutOfRange: true,
  RouteEmpty: true,
  RouteNonAdjacent: true,
  RouteSelfCrossing: true,
  DuplicatePath: true,
  RotateCoversBelt: true,
  GrowCoversBelt: true,
  InvalidBeltJoin: true,
  BeltJoinTurnsBack: true,
  BeltEndsApart: true,
  BeltEndTaken: true,
  ResizeCovers: true,
  LabelDoesNotConnect: true,
  UndoSpaceTaken: true,
  NoSuchPort: true,
  UnknownOption: true,
  OverLimit: true,
  InvalidPath: true,
  WrongKind: true,
  UndoDoesNotFit: true,
  MachineTooBig: true,
  RotateBlocked: true,
  GrowBlocked: true,
  BoardChanged: true,
};

/**
 * Narrow an untrusted wire value to a [`RefusalTag`]. It lives beside the union so
 * the two are one edit, and it is exported because BOTH transports need it: a Tauri
 * rejection (plan 64-07) can also carry the host's own decode-failure or
 * sim-unavailable strings, and those are NOT user copy. They must narrow to nothing
 * and render nothing rather than reaching a user as a raw host string.
 *
 * `Object.hasOwn`, never `in`: `'toString' in REFUSAL_TAGS` is true, so `in` would
 * narrow a prototype key to a `RefusalTag` and hand the copy table a lookup miss.
 */
export function isRefusalTag(value: unknown): value is RefusalTag {
  return typeof value === 'string' && Object.hasOwn(REFUSAL_TAGS, value);
}

/**
 * The host REFUSED one gesture. `seq` is the page's own gesture id for it (the id
 * `App.tsx` `submitInput` put in the frame header, phase 88), ABSENT only when the host
 * could not read the header at all, so the frame names no gesture.
 */
export interface GestureRefusal {
  kind: typeof GESTURE_REFUSAL_KIND;
  /** The page's gesture id this answers; absent for a frame whose header was unreadable. */
  seq?: number;
  /** The typed refusal, one of the host tags in {@link RefusalTag}. */
  tag: RefusalTag;
  /**
   * Plan 74.1-28 (re-walk G1): the refused command's variant name (`"AddPort"`,
   * `"RemovePort"`, ...), read by the host off the frame it decoded
   * (`GestureFrame::subject`). Absent on a refusal of an undecodable frame. It is what
   * lets the panel's port-edit latch tell a refusal of ITS edit from any other; it is
   * never copy and never shown.
   */
  cmd?: string;
  /**
   * The one node the refused command names, as the dense render handle every render
   * packet already carries (`NodeView.id`). Present for `Delete`, `Rotate`, `AddPort`,
   * `RemovePort` and `Configure`; absent otherwise.
   */
  node?: number;
}

/**
 * The host ACCEPTED one gesture and the tick that folded it has run (phase 88, D-06).
 * `minted` lists the render handles its Place, DrawBelt or DrawWire records minted, in
 * fold order (a DrawWire names two), in the handle table of `generation`: the table of the
 * packet that tick broadcast. A gesture that mints nothing (a Rotate, a Configure, an Undo
 * of nothing new) carries an empty list. It shows the user nothing.
 */
export interface GestureAccept {
  kind: typeof GESTURE_ACCEPT_KIND;
  /** The page's gesture id this answers. */
  seq: number;
  /** The board generation `minted` belongs to (`RenderPacket.generation`). */
  generation: number;
  /** The render handles the gesture minted, in fold order. */
  minted: number[];
}

/**
 * A board swap dropped one gesture before it folded (phase 88, D-05). It shows the user
 * nothing: they asked for the old board to be replaced.
 */
export interface GestureDiscard {
  kind: typeof GESTURE_DISCARD_KIND;
  /** The page's gesture id this answers. */
  seq: number;
}

/**
 * The host's ONE answer to one gesture (phase 88, D-06), on both transports alike. Until
 * plan 88-03 only refusals were carried and an accepted gesture produced no frame at all
 * (D-30); now every gesture gets exactly one of these three, paired with the gesture by
 * `seq`, the page's own gesture id. Ordering against render packets is NOT promised by
 * either transport (research Pitfall 3); the display layer stale-drops refusals by `seq`.
 */
export type GestureVerdict = GestureRefusal | GestureAccept | GestureDiscard;

/** A safe, non-negative integer: the only numbers a gesture id, generation or handle is. */
function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Narrow ONE untrusted verdict frame to a {@link GestureVerdict}, or `null` (phase 88,
 * D-06). The ONE parser both transports call: the dev WebSocket's TEXT frames
 * (`devWsInvoke.ts` `resolveGestureVerdict`) and the Tauri verdict channel
 * (`tauriChannel.ts`), whose frames the host writes from one Rust type, so neither can
 * drift into a shape of its own.
 *
 * REJECT-ONLY: anything unrecognised is `null` and renders nothing.
 * - A refusal with an unknown `tag` is dropped: the copy table is keyed on the closed tag
 *   union, and a raw host string reaching a user is what ERR-02 forbids. A refusal WITHOUT
 *   `seq` is kept (the host could not read its header); a `seq` that is not an index is not.
 * - An accept needs an index `seq` and `generation`, and a `minted` that is an ARRAY of
 *   indexes; anything else is dropped rather than pairing a gesture with a bogus handle.
 * - A discard needs an index `seq`.
 */
export function parseGestureVerdict(frame: unknown): GestureVerdict | null {
  if (frame === null || typeof frame !== 'object') return null;
  const r = frame as {
    kind?: unknown;
    seq?: unknown;
    tag?: unknown;
    cmd?: unknown;
    node?: unknown;
    generation?: unknown;
    minted?: unknown;
  };
  switch (r.kind) {
    case GESTURE_REFUSAL_KIND: {
      if (r.seq !== undefined && !isIndex(r.seq)) return null;
      if (!isRefusalTag(r.tag)) return null;
      // Plan 74.1-28: the refused gesture's `cmd` and `node`, when the host named them.
      return {
        kind: GESTURE_REFUSAL_KIND,
        ...(r.seq === undefined ? {} : { seq: r.seq }),
        tag: r.tag,
        ...refusalSubject(r),
      };
    }
    case GESTURE_ACCEPT_KIND: {
      if (!isIndex(r.seq) || !isIndex(r.generation)) return null;
      if (!Array.isArray(r.minted) || !r.minted.every(isIndex)) return null;
      return { kind: GESTURE_ACCEPT_KIND, seq: r.seq, generation: r.generation, minted: [...r.minted] };
    }
    case GESTURE_DISCARD_KIND: {
      if (!isIndex(r.seq)) return null;
      return { kind: GESTURE_DISCARD_KIND, seq: r.seq };
    }
    default:
      return null;
  }
}

/**
 * Plan 74.1-28: narrow the two optional subject fields of an untrusted refusal frame.
 * A field of the wrong type is DROPPED rather than failing the frame: the refusal is
 * still a refusal the user must see, it just names nothing the latch can act on. Shared
 * by both transports' parsers so neither can drift into a looser rule.
 */
export function refusalSubject(frame: { cmd?: unknown; node?: unknown }): { cmd?: string; node?: number } {
  const out: { cmd?: string; node?: number } = {};
  if (typeof frame.cmd === 'string') out.cmd = frame.cmd;
  if (typeof frame.node === 'number' && Number.isSafeInteger(frame.node) && frame.node >= 0) out.node = frame.node;
  return out;
}

/**
 * The single seam between the renderer and the byte source. Both transports
 * deliver and accept the SAME postcard bytes.
 */
export interface ITransport {
  /** Register the callback that receives each inbound render-packet's bytes. */
  onPacket(cb: (bytes: Uint8Array) => void): void;
  /**
   * Send one framed gesture (`encodeGestureFrame`: the phase 88 header, then the encoded
   * GridCommand) to the host and RETURN. It carries no verdict and hands back nothing to
   * await: every gesture's one answer arrives out of band on [`onGestureVerdict`], on both
   * transports identically.
   *
   * SYMMETRIC, and the symmetry was bought deliberately. The Tauri impl used to
   * resolve a Promise with the verdict, which forced its host command to be an `async`
   * Tauri command - and an `async` command is dispatched through a spawned task on a
   * multi-threaded runtime, so a burst of gestures could reach the host's queue OUT OF
   * SUBMISSION ORDER. `seedRouterPreset` fires five gestures in one synchronous burst
   * whose order is load-bearing. Returning nothing is what lets the host command be a
   * blocking `fn` that enqueues inline.
   *
   * Since phase 88 (D-06) every gesture is answered, an accept included, so a client may
   * keep a per-gesture entry (plan 88-05) that its own answer ends.
   *
   * The UI must NEVER block on a gesture (D-05). The feedback rule is
   * optimistic-then-corrected: the canvas flash fires from the client prediction at
   * once and says WHERE, and the host's verdict, if one comes, names WHY.
   */
  sendInput(bytes: Uint8Array): void;
  /**
   * Register the sink for host verdicts, which arrive OUT OF BAND on BOTH transports:
   * a dev-WS verdict TEXT frame, or a Tauri `subscribe_gesture_verdicts` channel
   * message, each narrowed by the one {@link parseGestureVerdict}. One App-level handler is
   * wired to it, so the two transports feed the SAME display path and neither can drift
   * into one of its own.
   */
  onGestureVerdict(cb: (v: GestureVerdict) => void): void;
  /**
   * Register the sink for a REFUSED project-file load (UNDO-09). Like a gesture
   * verdict it arrives OUT OF BAND on BOTH transports - a dev-WS `loadRefused` TEXT
   * frame, or a Tauri `subscribe_load_refusals` channel message - because
   * `ControlMsg::Load` carries no reply channel and `load_project_cmd` returns the
   * instant the control message is enqueued.
   *
   * The callback receives the host's OWN sentence, verbatim. App renders it without
   * re-authoring it: re-authoring would put the app's copy and the host's refusal out
   * of sync at the first schema change.
   *
   * BOTH transports implement it, and the reason is measured rather than assumed:
   * `npm run e2e:live` builds and runs `dev_render_server`, so a WebSocket-only
   * implementation passes every automated gate in this repository and is invisible in
   * the shipped Tauri binary.
   */
  onLoadRefused(cb: (reason: string) => void): void;
  /**
   * Register the sink for a FATAL sim error (phase 90, FAIL-01, D-11): the host's sim loop ended
   * and will not come back. Out of band on BOTH transports: a dev-WS `simFatal` TEXT frame, sent
   * after the opening keyframe and on change, or a Tauri `subscribe_sim_fatal` channel message,
   * sent on subscribe when the host already holds one. Both narrow through
   * {@link parseSimFatal}. The host HOLDS the reason, so a page that connects or reloads after
   * the fatal is told too.
   *
   * The callback receives the host's reason sentence, verbatim, for the stopped card; App puts
   * only the generic `Simulation stopped` in the status line.
   */
  onSimFatal(cb: (reason: string) => void): void;
  /**
   * Register the sink for a FAILED Save (phase 90 review WR-A-03): the host could not write a
   * Save this page sent. Out of band on BOTH transports, as a load refusal is: a dev-WS
   * `saveFailed` TEXT frame, or a `saveFailed` message on the Tauri load-refusal channel, each
   * narrowed by {@link parseSaveFailure}. App shows `Save failed` and puts the Unsaved badge
   * back; the reason is the host's sentence and is not rendered.
   */
  onSaveFailed(cb: (reason: string) => void): void;
  /**
   * Drive a host control intent (pause/resume/step/save/load/loadDemo/
   * loadExample). Under Tauri this routes to the discrete capability-scoped
   * command; under the dev WebSocket it becomes a control TEXT frame the dev
   * server decodes. Save/Load receive an already-chosen `path` — the transport
   * never opens a dialog. `loadExample` REQUIRES a typed [`SceneWireId`]
   * (the overload makes an unknown id a compile-time error).
   */
  sendControl(kind: 'loadExample', sceneId: SceneWireId): void;
  sendControl(kind: Exclude<ControlKind, 'loadExample'>, path?: string): void;
  /** Tear the transport down (close socket / drop channel). */
  close(): void;
}

/** Runtime detection inputs — injectable for hermetic tests. */
export interface TransportEnv {
  hasTauri: boolean;
}

/**
 * Detect whether we are running inside the Tauri webview. Tauri 2 injects
 * `__TAURI_INTERNALS__` (and historically `__TAURI__`) onto `window`; in a plain
 * browser or a node test neither is present.
 */
export function detectEnv(): TransportEnv {
  const hasTauri =
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
  return { hasTauri };
}

/** Which transport the current runtime selects. Pure — easy to unit-test. */
export function transportKind(env: TransportEnv = detectEnv()): 'tauri' | 'dev' {
  return env.hasTauri ? 'tauri' : 'dev';
}

/** Optional injected factories so tests never open a live socket/channel. */
export interface TransportDeps {
  dev?: () => ITransport;
  tauri?: () => ITransport;
}

let singleton: ITransport | null = null;

/** How many controls and gestures the page handed to the transport (review WR-C-03). */
export interface SendCounts {
  controls: number;
  inputs: number;
}

/**
 * Count every `sendControl` and `sendInput` the page makes through `t` into `counts`, passing each
 * call through unchanged (phase 90 review WR-C-03). The fatal spec reads the counts (DEV hooks
 * `controlsSent` and `inputsSent`) to prove a stopped page SENDS nothing, which a tick that does not
 * move cannot prove: a dead host moves no tick whatever it is sent. The two seams are replaced on
 * `t` itself, so the singleton every caller holds is the counted one, and only once.
 */
const COUNTED = new WeakSet<ITransport>();

export function countSends(t: ITransport, counts: SendCounts): ITransport {
  // The transport is a process-wide singleton and App's mount effect runs twice under StrictMode:
  // a second wrap would count every send twice.
  if (COUNTED.has(t)) return t;
  COUNTED.add(t);
  const sendControl = t.sendControl.bind(t) as (kind: ControlKind, arg?: string) => void;
  const sendInput = t.sendInput.bind(t);
  t.sendControl = ((kind: ControlKind, arg?: string): void => {
    counts.controls += 1;
    sendControl(kind, arg);
  }) as ITransport['sendControl'];
  t.sendInput = (bytes: Uint8Array): void => {
    counts.inputs += 1;
    sendInput(bytes);
  };
  return t;
}

/**
 * Get the process-wide transport, creating it ONCE. Picks the Tauri channel
 * under Tauri, else the dev WebSocket (browser fallback). Subsequent calls
 * return the same instance — StrictMode-safe, no duplicate connections.
 */
export function makeTransport(deps?: TransportDeps): ITransport {
  if (singleton) {
    return singleton;
  }
  const dev = deps?.dev ?? makeDevWebSocketTransport;
  const tauri = deps?.tauri ?? makeTauriChannelTransport;
  singleton = transportKind() === 'tauri' ? tauri() : dev();
  return singleton;
}

/** Drop the singleton (test isolation only — never called by the app). */
export function resetTransportForTest(): void {
  if (singleton) {
    singleton.close();
  }
  singleton = null;
}
