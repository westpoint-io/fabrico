// devWsInvoke.ts — a `ConfigInvoke` over the dev WebSocket control channel (40-05).
//
// The ConfigPanel's config-READ bridges (`machine_config`, `webhook_url`,
// `validate_factory_js`) are Tauri `invoke`-only in production. Under the browser
// dev path (dev_render_server + `npm run dev`) there is no Tauri global, so this
// module re-frames those same reads as a request/reply over the dev WS: it sends a
// `query\n<json>` TEXT frame (a `reqId` + verb + args) and awaits a correlated
// reply that `devWebSocket.ts::ws.onmessage` routes back through `resolveDevWsReply`.
//
// This is READ/validate ONLY — the config COMMIT still rides the existing binary
// `GridCommand::Configure` gesture over `transport.sendInput` (unchanged). The wire
// is ephemeral dev-harness IPC (the Rust side answers with `serde_json`); nothing
// here touches a frozen serialized shape. Production stays on the Tauri path.

import type { ConfigInvoke } from '../chrome/ConfigPanel.tsx';
import {
  LOAD_REFUSAL_KIND,
  type GestureVerdict,
  parseGestureVerdict,
  parseSaveFailure,
  parseSimFatal,
} from './transport.ts';

/** The TEXT-frame prefix the Rust `transport_ws::decode_query` reads to tell a
 *  config-query request from a bare control frame (`decode_control`). Must match
 *  `QUERY_FRAME_PREFIX` on the Rust side. */
export const DEV_WS_QUERY_PREFIX = 'query\n';

/** One in-flight query awaiting its correlated reply. */
interface PendingQuery {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// Module-scoped correlation state. The dev WS transport is a process-wide singleton
// (one socket for the whole app), so a single shared pending-map + sender is exactly
// right — there is never more than one dev socket to correlate against.
const pending = new Map<number, PendingQuery>();
let nextReqId = 1;
let sendText: ((text: string) => void) | null = null;

/**
 * Register the dev WS TEXT sender (called once by `makeDevWebSocketTransport`). The
 * sender buffers-before-open exactly like the control path, so a query issued during
 * the initial connect still flushes on open.
 */
export function registerDevWsQuerySender(fn: (text: string) => void): void {
  sendText = fn;
}

/**
 * Fail every in-flight query and clear the sender (the socket closed / errored). A
 * pending ConfigPanel read then surfaces on its query-failure row rather than
 * hanging forever.
 */
export function failAllPendingDevWsQueries(reason: string): void {
  for (const p of pending.values()) {
    p.reject(new Error(reason));
  }
  pending.clear();
  sendText = null;
}

/**
 * Route an inbound TEXT frame to its pending query by `reqId`. Returns true if the
 * frame was a recognised reply (and was consumed), false otherwise so the caller can
 * ignore non-reply TEXT. Reject-only parsing: a malformed frame is dropped, never
 * thrown.
 */
export function resolveDevWsReply(text: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return false;
  }
  if (!msg || typeof msg !== 'object') return false;
  const r = msg as { reqId?: unknown; ok?: unknown; value?: unknown; error?: unknown };
  if (typeof r.reqId !== 'number') return false;
  const p = pending.get(r.reqId);
  if (!p) return false;
  pending.delete(r.reqId);
  if (r.ok === true) {
    p.resolve(r.value ?? null);
  } else {
    p.reject(typeof r.error === 'string' ? r.error : 'dev WS query failed');
  }
  return true;
}

// ---------------------------------------------------------------------------
// The gesture-verdict grammar (Phase 64, ERR-01) - the SECOND grammar on this
// socket's TEXT channel, beside the config-query reply above.
// ---------------------------------------------------------------------------

/** Where a parsed verdict goes. Module-scoped for the same reason `pending` is:
 *  the dev WS transport is a process-wide singleton, so there is never more than
 *  one socket to dispatch from. */
let verdictSink: ((v: GestureVerdict) => void) | null = null;

/**
 * Register the gesture-verdict sink (called by `makeDevWebSocketTransport`'s
 * `onGestureVerdict`). Last registration wins - the App wires exactly one handler.
 */
export function registerGestureVerdictSink(fn: (v: GestureVerdict) => void): void {
  verdictSink = fn;
}

/**
 * Route an inbound TEXT frame to the gesture-verdict sink. Returns true if the frame was a
 * recognised verdict (and was consumed), false otherwise so the caller can try the next
 * grammar.
 *
 * Since phase 88 (D-06) every gesture is answered: a refusal, an accept naming the handles
 * it minted, or a swap's discard. The frame is narrowed by `parseGestureVerdict`, the ONE
 * parser the Tauri transport also calls, so the two cannot drift. REJECT-ONLY PARSING,
 * copied from `resolveDevWsReply` above: parse behind a `try`, return `false` on anything
 * unrecognised, and NEVER let an exception escape a socket callback. `kind` is the
 * discriminator: a config-query reply has no `kind` field at all, so it can never be
 * mistaken for a verdict (and vice versa: a verdict carries no `reqId`, so
 * `resolveDevWsReply` always returns false for it - T-64-05-01).
 */
export function resolveGestureVerdict(text: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return false;
  }
  const verdict = parseGestureVerdict(msg);
  if (verdict === null) return false;
  verdictSink?.(verdict);
  return true;
}

// ---------------------------------------------------------------------------
// The load-refusal grammar (Phase 73, UNDO-09) - the THIRD grammar on this socket's
// TEXT channel, beside the config-query reply and the gesture verdict above.
// ---------------------------------------------------------------------------

/** Where a parsed load refusal goes. Module-scoped for the same reason `verdictSink`
 *  is: the dev WS transport is a process-wide singleton, so there is never more than
 *  one socket to dispatch from. */
let loadRefusalSink: ((reason: string) => void) | null = null;

/**
 * Register the load-refusal sink (called by `makeDevWebSocketTransport`'s
 * `onLoadRefused`). Last registration wins - the App wires exactly one handler.
 */
export function registerLoadRefusalSink(fn: (reason: string) => void): void {
  loadRefusalSink = fn;
}

/**
 * Route an inbound TEXT frame to the load-refusal sink. Returns true if the frame was a
 * recognised load refusal (and was consumed), false otherwise so the caller can try the
 * next grammar.
 *
 * REJECT-ONLY PARSING, the same discipline `resolveGestureVerdict` above applies: parse
 * behind a `try`, return `false` on anything unrecognised, and NEVER let an exception
 * escape a socket callback.
 *
 * Unlike a gesture verdict this frame carries NO `seq` and needs none. A gesture verdict
 * answers ONE gesture out of a stream the frontend numbered, and the stale-drop by `seq`
 * is what stops an out-of-order verdict overwriting a newer one. A load refusal answers
 * the one Load the user just dispatched; there is no stream to be out of order within,
 * and the surface it feeds is explicitly dismissed rather than auto-cleared.
 *
 * The `reason` is passed through UNVALIDATED as text and rendered verbatim, which is the
 * requirement. What keeps that safe is enforced on the host side, over every
 * `ProjectError` variant, by `crates/fabrico-host/tests/project_error_copy.rs`: no
 * filesystem path, no debug payload. React escapes it as a text child, so no markup can
 * ride it either.
 */
export function resolveLoadRefusal(text: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return false;
  }
  if (!msg || typeof msg !== 'object') return false;
  const r = msg as { kind?: unknown; reason?: unknown };
  // `kind` is the discriminator. A config-query reply has no `kind` field at all and a
  // gesture verdict carries a DIFFERENT one, so the three grammars cannot collide.
  if (r.kind !== LOAD_REFUSAL_KIND) return false;
  if (typeof r.reason !== 'string') return false;
  loadRefusalSink?.(r.reason);
  return true;
}

// ---------------------------------------------------------------------------
// The save-failure grammar (phase 90 review WR-A-03): the host could not write a Save this page
// sent. It rides the load-refusal fan-out on the host, under its own `kind`.
// ---------------------------------------------------------------------------

/** Where a parsed save failure goes. Module-scoped for the `loadRefusalSink` reason. */
let saveFailureSink: ((reason: string) => void) | null = null;

/**
 * Register the save-failure sink (called by `makeDevWebSocketTransport`'s `onSaveFailed`). Last
 * registration wins - the App wires exactly one handler.
 */
export function registerSaveFailureSink(fn: (reason: string) => void): void {
  saveFailureSink = fn;
}

/**
 * Route an inbound TEXT frame to the save-failure sink. Returns true if the frame was a
 * recognised save failure (and was consumed), false otherwise so the caller can try the next
 * grammar. Reject-only behind a `try`, through the one shared {@link parseSaveFailure}.
 */
export function resolveSaveFailure(text: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return false;
  }
  const reason = parseSaveFailure(msg);
  if (reason === null) return false;
  saveFailureSink?.(reason);
  return true;
}

// ---------------------------------------------------------------------------
// The sim-fatal grammar (phase 90, FAIL-01, D-11) - the FOURTH grammar on this socket's TEXT
// channel. The dev host sends it after the opening keyframe when its sim loop has already ended,
// and on change, so every page that connects is told.
// ---------------------------------------------------------------------------

/** Where a parsed sim-fatal reason goes. Module-scoped for the `loadRefusalSink` reason. */
let simFatalSink: ((reason: string) => void) | null = null;

/**
 * Register the sim-fatal sink (called by `makeDevWebSocketTransport`'s `onSimFatal`). Last
 * registration wins - the App wires exactly one handler.
 */
export function registerSimFatalSink(fn: (reason: string) => void): void {
  simFatalSink = fn;
}

/**
 * Route an inbound TEXT frame to the sim-fatal sink. Returns true if the frame was a recognised
 * sim-fatal frame (and was consumed), an empty reason included; false otherwise so the caller
 * can try the next grammar. Reject-only behind a `try`, through the one shared
 * {@link parseSimFatal}; no exception escapes a socket callback.
 */
export function resolveSimFatal(text: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return false;
  }
  const reason = parseSimFatal(msg);
  if (reason === null) return false;
  simFatalSink?.(reason);
  return true;
}

/**
 * The dev-path `ConfigInvoke`: send a `query\n<json>` request frame and return a
 * Promise resolved by the correlated reply. Injected into `ConfigPanel` (and the
 * `WebhookUrlRow`/`SourceConfigBody` it owns) in place of `tauriInvoke` on the dev
 * WS transport.
 */
export const devWsInvoke: ConfigInvoke = (cmd, args) =>
  new Promise((resolve, reject) => {
    if (!sendText) {
      reject(new Error('dev WS config bridge not connected'));
      return;
    }
    const reqId = nextReqId++;
    let frame: string;
    try {
      frame = DEV_WS_QUERY_PREFIX + JSON.stringify({ reqId, verb: cmd, args });
    } catch (err) {
      reject(err);
      return;
    }
    pending.set(reqId, { resolve, reject });
    try {
      sendText(frame);
    } catch (err) {
      pending.delete(reqId);
      reject(err);
    }
  });
