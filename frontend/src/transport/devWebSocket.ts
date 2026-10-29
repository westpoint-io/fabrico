// Dev transport: a browser WebSocket against the axum host's `/render` endpoint
// (loopback only). It carries the IDENTICAL postcard bytes the Tauri Channel
// path uses — `onPacket` receives raw render-packet bytes, `sendInput` writes a
// binary frame of encoded GridCommand bytes the host expects.

import type { ControlKind, GestureVerdict, ITransport } from './transport.ts';
import {
  failAllPendingDevWsQueries,
  registerDevWsQuerySender,
  registerGestureVerdictSink,
  registerLoadRefusalSink,
  registerSaveFailureSink,
  registerSimFatalSink,
  resolveDevWsReply,
  resolveGestureVerdict,
  resolveLoadRefusal,
  resolveSaveFailure,
  resolveSimFatal,
} from './devWsInvoke.ts';

/** Default dev render socket — loopback only, mirrors the host bind discipline. */
export const DEFAULT_DEV_WS_URL = 'ws://127.0.0.1:8787/render';

/**
 * Encode a control intent into the dev-server line grammar that
 * `crates/fabrico-host/src/transport_ws.rs::decode_control` reads (18-04):
 * argument-less kinds are the bare wire word; Save/Load are `kind\n<path>`;
 * loadExample is `load_example\n<scene-id>` (the arg-carrying save precedent).
 *
 * NOTE the wire words for `loadDemo` / `loadExample` are snake_case to match
 * the Rust decoder — and this is a TEXT frame (gestures ride BINARY), which is
 * how the dev server distinguishes control from grid commands. This is
 * deliberately NOT `JSON.stringify`: the Rust side decodes a newline-delimited
 * grammar, so a JSON payload would be a typed `Malformed` reject and Pause/Step
 * would silently no-op over the browser path.
 */
export function encodeControl(kind: ControlKind, arg?: string): string {
  switch (kind) {
    case 'pause':
      return 'pause';
    case 'resume':
      return 'resume';
    case 'step':
      return 'step';
    case 'loadDemo':
      return 'load_demo';
    case 'new':
      return 'new';
    case 'save':
      return `save\n${arg ?? ''}`;
    case 'load':
      return `load\n${arg ?? ''}`;
    case 'loadExample':
      // The arg is the typed SceneWireId (compile-time closed set at every call
      // site); the host's SceneId::parse is the runtime boundary (T-55-04).
      return `load_example\n${arg ?? ''}`;
  }
}

/**
 * Create the dev WebSocket transport. The socket is opened ONCE here; the
 * caller (makeTransport) ensures a single instance for the whole app.
 */
export function makeDevWebSocketTransport(
  url: string = DEFAULT_DEV_WS_URL,
): ITransport {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  let onPacketCb: ((bytes: Uint8Array) => void) | null = null;
  // Binary gesture frames queued before the socket finishes opening; flushed on 'open'.
  const pending: Uint8Array[] = [];
  // Control TEXT frames queued before open; flushed on 'open' after the gestures.
  const pendingText: string[] = [];

  // Copy into a fresh, ArrayBuffer-backed view so `ws.send` accepts it (the
  // bytes from the encoder may be backed by an ArrayBufferLike, which the DOM
  // BufferSource type rejects).
  const rawSend = (bytes: Uint8Array): void => {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    ws.send(ab);
  };

  // Control rides a TEXT frame (a string arg → a WebSocket text frame), which is
  // how the dev server tells control from the BINARY gesture frames. Config-query
  // request frames (`query\n<json>`, 40-05) ride the SAME TEXT channel.
  const rawSendText = (text: string): void => {
    ws.send(text);
  };

  // A TEXT sender for config-query request frames that buffers-before-open exactly
  // like the control path, so a query issued during connect still flushes on open.
  const sendQueryText = (text: string): void => {
    if (ws.readyState === WebSocket.OPEN) {
      rawSendText(text);
    } else {
      pendingText.push(text);
    }
  };
  // Register the sender so `devWsInvoke` can drive config reads over this socket.
  registerDevWsQuerySender(sendQueryText);

  ws.onmessage = (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) {
      // BINARY: a render-packet's raw bytes → the renderer.
      onPacketCb?.(new Uint8Array(ev.data));
    } else if (typeof ev.data === 'string') {
      // TEXT: one socket, FOUR grammars, and the ORDER IS LOAD-BEARING.
      //
      // The config-query reply (40-05) is the OLDER grammar and keys on `reqId`, a
      // field the Phase 64 refusal frame deliberately LACKS - `nextReqId` and the
      // host's gesture counter both start at 1, so a shared field would resolve an
      // unrelated config query with a refusal tag (T-64-05-01). Running the query
      // resolver first therefore cannot misroute a refusal, and the refusal
      // resolver cannot misroute a query reply (which carries no `kind`).
      if (resolveDevWsReply(ev.data)) return;
      // Then the gesture verdict, discriminated by its `kind` field.
      if (resolveGestureVerdict(ev.data)) return;
      // Then the LOAD refusal (UNDO-09), discriminated by a DIFFERENT `kind`. Its
      // position in this ladder is free rather than load-bearing - the two `kind`
      // values are distinct and the query reply carries none at all - but it goes last
      // because it is the rarest frame on this socket by a wide margin.
      if (resolveLoadRefusal(ev.data)) return;
      // Then the SIM-FATAL frame (phase 90, FAIL-01, D-11), discriminated by a fourth `kind`.
      // Free in position for the load refusal's reason; the host sends it after the opening
      // keyframe when its sim loop has already ended, and on change.
      if (resolveSimFatal(ev.data)) return;
      // Then the SAVE-FAILURE frame (phase 90 review WR-A-03), a fifth `kind`, free in position.
      if (resolveSaveFailure(ev.data)) return;
      // Anything else is unrecognised TEXT and is dropped in silence, exactly as it
      // always was - a console warning on the render socket is noise. The silence
      // now has NAMED cases rather than being the only case.
    }
  };
  ws.onopen = () => {
    for (const frame of pending) {
      rawSend(frame);
    }
    pending.length = 0;
    for (const frame of pendingText) {
      rawSendText(frame);
    }
    pendingText.length = 0;
  };
  // Swallow connection errors at the transport edge — the renderer keeps running
  // and the socket retry policy (if any) lives above this layer, not per-frame. A
  // dropped socket also fails any in-flight config query so the panel surfaces it
  // rather than hanging.
  ws.onerror = () => {
    /* intentionally quiet: do not crash the renderer on a refused dev socket */
  };
  ws.onclose = () => {
    failAllPendingDevWsQueries('dev WS closed');
  };

  return {
    onPacket(cb: (bytes: Uint8Array) => void): void {
      onPacketCb = cb;
    },
    sendInput(bytes: Uint8Array): void {
      if (ws.readyState === WebSocket.OPEN) {
        rawSend(bytes);
      } else {
        pending.push(bytes);
      }
      // Returns IMMEDIATELY with NO verdict, and the UI never blocks on a gesture
      // (D-05). Since phase 88 (D-06) every gesture is answered, an accept, a refusal or
      // a swap's discard, and each answer arrives out of band as a TEXT frame through
      // `onGestureVerdict` (the Tauri transport delivers them the same way), so there is
      // nothing to await here and no per-sequence pending map to grow (T-64-05-05).
    },
    onGestureVerdict(cb: (v: GestureVerdict) => void): void {
      registerGestureVerdictSink(cb);
    },
    onLoadRefused(cb: (reason: string) => void): void {
      registerLoadRefusalSink(cb);
    },
    onSimFatal(cb: (reason: string) => void): void {
      registerSimFatalSink(cb);
    },
    onSaveFailed(cb: (reason: string) => void): void {
      registerSaveFailureSink(cb);
    },
    sendControl(kind: ControlKind, arg?: string): void {
      const frame = encodeControl(kind, arg);
      if (ws.readyState === WebSocket.OPEN) {
        rawSendText(frame);
      } else {
        pendingText.push(frame);
      }
    },
    close(): void {
      ws.close();
    },
  };
}
