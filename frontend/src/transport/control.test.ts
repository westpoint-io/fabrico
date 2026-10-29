// Control-routing tests for the transport seam (18-05).
//
// Two concerns:
//   1. `encodeControl` must emit the EXACT line grammar the Rust dev-server
//      decoder reads (`transport_ws.rs::decode_control`, 18-04) — NOT JSON. A
//      wrong grammar here means Pause/Step silently no-op over the browser path.
//   2. The dev WebSocket transport must send control as a TEXT frame (string),
//      distinct from the BINARY gesture frames, and buffer it before the socket
//      opens (mirroring `sendInput`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeControl, makeDevWebSocketTransport } from './devWebSocket.ts';

describe('encodeControl — the dev-server line grammar (18-04)', () => {
  it('encodes argument-less kinds as the bare wire word', () => {
    expect(encodeControl('pause')).toBe('pause');
    expect(encodeControl('resume')).toBe('resume');
    expect(encodeControl('step')).toBe('step');
  });

  it('maps loadDemo to the snake_case wire word load_demo', () => {
    expect(encodeControl('loadDemo')).toBe('load_demo');
  });

  it('encodes save/load as `kind\\n<path>` (newline-delimited, never JSON)', () => {
    expect(encodeControl('save', '/tmp/factory.fab')).toBe('save\n/tmp/factory.fab');
    expect(encodeControl('load', '/tmp/factory.fab')).toBe('load\n/tmp/factory.fab');
    // Guard against a regression to a JSON payload the Rust decoder would reject.
    expect(encodeControl('save', '/x.fab')).not.toContain('{');
  });

  it('encodes loadExample as `load_example\\n<scene-id>` (EX-02 arg-carrying verb)', () => {
    // The legal SceneWireIds — the exact wire strings the host's typed
    // SceneId::parse boundary accepts (quick 260916-adv).
    expect(encodeControl('loadExample', 'demo_scene')).toBe('load_example\ndemo_scene');
    expect(encodeControl('loadExample', 'order_processing')).toBe(
      'load_example\norder_processing',
    );
    expect(encodeControl('loadExample', 'advanced')).toBe('load_example\nadvanced');
  });
});

// ---- dev WebSocket control framing --------------------------------------

interface MockSocket {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((ev: unknown) => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let socket: MockSocket;

beforeEach(() => {
  socket = {
    readyState: 0, // CONNECTING
    binaryType: '',
    onopen: null,
    onmessage: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  };
  class FakeWebSocket {
    static readonly OPEN = 1;
    constructor() {
      return socket as unknown as FakeWebSocket;
    }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('devWebSocket.sendControl — TEXT frame + pre-open buffering', () => {
  it('sends a TEXT frame (string) immediately when the socket is open', () => {
    const t = makeDevWebSocketTransport('ws://test/render');
    socket.readyState = 1; // OPEN
    t.sendControl('pause');
    expect(socket.send).toHaveBeenCalledWith('pause');
    // A string arg is a TEXT frame — never an ArrayBuffer (that is the gesture path).
    expect(typeof socket.send.mock.calls[0][0]).toBe('string');
  });

  it('buffers control frames before open, then flushes them on open', () => {
    const t = makeDevWebSocketTransport('ws://test/render');
    socket.readyState = 0; // still CONNECTING
    t.sendControl('step');
    t.sendControl('save', '/tmp/f.fab');
    expect(socket.send).not.toHaveBeenCalled();
    socket.readyState = 1;
    socket.onopen?.();
    expect(socket.send).toHaveBeenNthCalledWith(1, 'step');
    expect(socket.send).toHaveBeenNthCalledWith(2, 'save\n/tmp/f.fab');
  });
});
