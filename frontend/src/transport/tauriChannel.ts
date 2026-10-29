// Tauri prod transport: four binary/JSON `Channel`s opened at construction.
// `subscribe_render` (the IDENTICAL postcard bytes the dev WebSocket carries),
// `subscribe_gesture_verdicts` (every gesture's one verdict, out of band, phase 88) and
// `subscribe_load_refusals` (why a `.fab` file will not open, also out of band,
// UNDO-09), and `subscribe_sim_fatal` (the host's held fatal sim error, sent on subscribe
// when the sim has already stopped, phase 90 FAIL-01). `sendInput` round-trips encoded GridCommand bytes through the
// `submit_input` command and does NOT wait for an answer.
//
// `@tauri-apps/api` is imported DYNAMICALLY so this module never evaluates the
// Tauri runtime outside Tauri — the browser/dev/node paths never load it
// (keeps the dev build and node tests free of Tauri-only symbols).
//
// # Why the verdict rides its own channel instead of the `submit_input` Promise
// `submit_input` used to be an `async` Tauri command that awaited the host's oneshot,
// so its rejection carried the refusal. `#[tauri::command]` reads a function's
// asyncness: an `async fn` is dispatched through `async_runtime::spawn` on a
// MULTI-THREADED runtime, so each invoke reached the host's gesture channel from its
// own spawned task and a burst of gestures could enqueue OUT OF ORDER. `seedRouterPreset`
// (`../input/gestures.ts`) fires five in one synchronous burst whose order is
// load-bearing. The command is now a blocking `fn` that enqueues inline and returns at
// once, which is only possible because the verdict comes home somewhere else.
//
// Chaining the sends here instead — awaiting gesture N's verdict before invoking N+1 —
// was considered and REJECTED: it would serialise the UI's gesture stream behind the host,
// which is the opposite of D-05 ("the UI never blocks on this"). The 30-second host bound
// that rejection also cited was deleted in phase 88 with the per-gesture task it bounded.

import {
  LOAD_REFUSAL_KIND,
  parseGestureVerdict,
  parseSaveFailure,
  parseSimFatal,
} from './transport.ts';
import type { ControlKind, GestureVerdict, ITransport } from './transport.ts';

/**
 * Narrow one inbound load-refusal-channel message to the host's reason string, or `null`.
 *
 * REJECT-ONLY PARSING, the same discipline `devWsInvoke.ts::resolveLoadRefusal` applies
 * to the dev wire, against the same frame shape: the host stamps `{kind, reason}` on BOTH
 * transports from one shared `LOAD_REFUSAL_KIND` constant, so one shape covers both and
 * neither can drift into one of its own. `fabrico_host::command_error_view`'s
 * `the_frontend_load_refusal_kind_matches_this_crates_wire_kind` `include_str!`s
 * `transport.ts` and pins that constant across the language boundary.
 *
 * The `reason` passes through UNVALIDATED and is rendered verbatim, which is the
 * requirement ("in the words the host already wrote"). What keeps that safe is enforced
 * host-side over every `ProjectError` variant by
 * `crates/fabrico-host/tests/project_error_copy.rs`: no filesystem path, no debug
 * payload. React escapes it as a text child, so no markup can ride it either.
 *
 * Exported for its own unit tests: a mutation that swallows the refusal has to redden
 * something, and this is the function that would swallow it.
 */
export function parseLoadRefusal(frame: unknown): string | null {
  if (frame === null || typeof frame !== 'object') return null;
  const r = frame as { kind?: unknown; reason?: unknown };
  if (r.kind !== LOAD_REFUSAL_KIND) return null;
  if (typeof r.reason !== 'string') return null;
  return r.reason;
}

/**
 * Create the Tauri Channel transport. Construction kicks off the async channel
 * subscriptions; `onPacket`/`sendInput` work once they are live. Caller
 * (makeTransport) guarantees a single instance.
 */
export function makeTauriChannelTransport(): ITransport {
  let onPacketCb: ((bytes: Uint8Array) => void) | null = null;
  // The verdict sink, registered by App through `onGestureVerdict`. Read at DELIVERY
  // time rather than captured, so the channel can open before App has wired its
  // handler without losing the wiring.
  let verdictCb: ((v: GestureVerdict) => void) | null = null;
  // The load-refusal sink (UNDO-09), read at DELIVERY time for the same reason
  // `verdictCb` is: the channel opens during construction, before App has wired a handler.
  let loadRefusedCb: ((reason: string) => void) | null = null;
  // The sim-fatal sink (phase 90, FAIL-01), read at DELIVERY time for the `verdictCb` reason.
  let simFatalCb: ((reason: string) => void) | null = null;
  // The save-failure sink (phase 90 review WR-A-03), read at DELIVERY time likewise.
  let saveFailedCb: ((reason: string) => void) | null = null;

  // Lazily resolve the Tauri core module ONCE; reused by every subscription + sendInput.
  const core = import('@tauri-apps/api/core');

  // Open every channel as soon as the module resolves, in the order below.
  void core.then(async ({ invoke, Channel }) => {
    // THE VERDICT CHANNEL IS OPENED FIRST, AND THE ORDER IS NOT COSMETIC.
    // `subscribe_render` is the host's diff-forwarding loop: it does not resolve while the
    // sim runs (only once a fatal has ended the sim, phase 90 review IN-A-05),
    // so anything awaited after it never runs at all. Opened the other way round, the
    // app would ship with no refusal path whatsoever.
    const verdicts = new Channel<unknown>();
    verdicts.onmessage = (frame: unknown): void => {
      const verdict = parseGestureVerdict(frame);
      if (verdict !== null) verdictCb?.(verdict);
    };
    await invoke('subscribe_gesture_verdicts', { channel: verdicts });

    // THE LOAD-REFUSAL CHANNEL, OPENED BEFORE `subscribe_render` FOR THE SAME REASON THE
    // VERDICT CHANNEL IS. `subscribe_render` is the host's diff-forwarding loop: it does not
    // resolve while the sim runs, so anything awaited after it never runs. Opened the other
    // way round, the shipped app would have no load-refusal path whatsoever - which is
    // exactly the silence UNDO-09 exists to end, reintroduced by an ordering mistake.
    const loadRefusals = new Channel<unknown>();
    loadRefusals.onmessage = (frame: unknown): void => {
      const reason = parseLoadRefusal(frame);
      if (reason !== null) {
        loadRefusedCb?.(reason);
        return;
      }
      // Phase 90 review WR-A-03: a failed Save rides this channel under its own kind.
      const saveFailure = parseSaveFailure(frame);
      if (saveFailure !== null) saveFailedCb?.(saveFailure);
    };
    await invoke('subscribe_load_refusals', { channel: loadRefusals });

    // THE SIM-FATAL CHANNEL (phase 90, FAIL-01, D-11), OPENED BEFORE `subscribe_render` FOR
    // THE SAME REASON AS THE TWO ABOVE: that command does not resolve while the sim runs, so
    // a channel opened after it is never opened at all, and the shipped app would freeze
    // silently on a stopped sim.
    // The host holds the reason and sends it on subscribe when the sim has already stopped,
    // so a reload is told too.
    const simFatal = new Channel<unknown>();
    simFatal.onmessage = (frame: unknown): void => {
      const reason = parseSimFatal(frame);
      if (reason !== null) simFatalCb?.(reason);
    };
    await invoke('subscribe_sim_fatal', { channel: simFatal });

    const packets = new Channel<ArrayBuffer>();
    packets.onmessage = (buf: ArrayBuffer): void => {
      if (onPacketCb) {
        onPacketCb(new Uint8Array(buf));
      }
    };
    await invoke('subscribe_render', { channel: packets });
  });

  return {
    onPacket(cb: (bytes: Uint8Array) => void): void {
      onPacketCb = cb;
    },
    sendInput(bytes: Uint8Array): void {
      void core.then(({ invoke }) =>
        // Tauri serializes the byte array to the host's Vec<u8>; the host decodes
        // the SAME postcard GridCommand bytes the dev path sends. FIRE AND FORGET:
        // the command enqueues inline and returns, and the verdict — if the gesture is
        // refused — arrives on the verdict channel above.
        invoke('submit_input', { bytes: Array.from(bytes) }).catch(() => {
          // SWALLOWED, AND ONLY THESE. The rejected arm now carries ONLY the host's
          // `"decode"` and `"sim unavailable"` diagnostics; a refusal never comes back
          // this way. Both are host internals, not user copy, so announcing them to a
          // screen reader as though they were a sentence written for a person is the
          // ERR-02 failure. The user-facing answer for an undecodable gesture is the
          // `Malformed` refusal the host pushes on the verdict channel — this catch
          // exists to stop an unhandled rejection, not to hide a verdict.
        }),
      );
    },
    onGestureVerdict(cb: (v: GestureVerdict) => void): void {
      verdictCb = cb;
    },
    onLoadRefused(cb: (reason: string) => void): void {
      loadRefusedCb = cb;
    },
    onSimFatal(cb: (reason: string) => void): void {
      simFatalCb = cb;
    },
    onSaveFailed(cb: (reason: string) => void): void {
      saveFailedCb = cb;
    },
    sendControl(kind: ControlKind, arg?: string): void {
      // Route each intent to its discrete, capability-scoped command (18-04).
      // The webview NEVER touches Host state — every command only enqueues a
      // typed ControlMsg serviced at the tick boundary (SC5 / T-18-FE-CTRL).
      void core.then(({ invoke }) => {
        switch (kind) {
          case 'pause':
            return invoke('pause');
          case 'resume':
            return invoke('resume');
          case 'step':
            return invoke('step');
          case 'save':
            // The native dialog already yielded the path; the hardened Rust
            // command owns the bytes (fs:* withheld — T-18-FE-PATH).
            return invoke('save_project_cmd', { path: arg });
          case 'load':
            return invoke('load_project_cmd', { path: arg });
          case 'loadDemo':
            return invoke('load_demo');
          case 'loadExample':
            // The arg is the typed SceneWireId; Tauri maps the camelCase
            // `sceneId` key onto the Rust command's snake_case `scene_id`
            // param, which re-parses through the SAME SceneId boundary
            // (T-55-04 — an unknown id is a typed Err, never a demo load).
            return invoke('load_example', { sceneId: arg });
          case 'new':
            return invoke('ctrl_new');
        }
      }).catch(() => {
        // Phase 90 review WR-B-04: SWALLOWED, as `sendInput`'s are. A control the host could not
        // take (the stopped sim's "sim unavailable", a busy command) is a host diagnostic, not user
        // copy; the user-facing answers arrive on their own channels (a Save failure, a Load
        // refusal, the sim fatal). This catch stops an unhandled rejection, it hides no verdict.
      });
    },
    close(): void {
      // The Channels are dropped on the host side when the webview tears down; no
      // explicit close command in the v1 protocol.
    },
  };
}
