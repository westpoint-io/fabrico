// devWsInvoke tests (40-05): the dev-WS config request/reply bridge.
//
// Two concerns:
//   1. `devWsInvoke` sends a `query\n<json>` request frame (reqId + verb + args) and
//      resolves/rejects the correlated promise when `devWebSocket.ts::ws.onmessage`
//      routes the reply back through `resolveDevWsReply` by reqId.
//   2. The COMMIT path is untouched — the bridge is READ/validate only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDevWebSocketTransport } from './devWebSocket.ts';
import {
  DEV_WS_QUERY_PREFIX,
  devWsInvoke,
  failAllPendingDevWsQueries,
  registerGestureVerdictSink,
  registerSaveFailureSink,
  registerSimFatalSink,
  resolveDevWsReply,
  resolveGestureVerdict,
  resolveSaveFailure,
  resolveSimFatal,
} from './devWsInvoke.ts';
import {
  GESTURE_ACCEPT_KIND,
  GESTURE_DISCARD_KIND,
  GESTURE_REFUSAL_KIND,
  type GestureVerdict,
  isRefusalTag,
  LOAD_REFUSAL_KIND,
  SAVE_FAILURE_KIND,
  SIM_FATAL_KIND,
} from './transport.ts';

interface MockSocket {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((ev: unknown) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
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
    onclose: null,
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
  failAllPendingDevWsQueries('test teardown');
  vi.unstubAllGlobals();
});

describe('devWsInvoke — request/reply over the dev WS control channel', () => {
  it('sends a query\\n<json> TEXT frame carrying reqId + verb + args', () => {
    makeDevWebSocketTransport('ws://test/render');
    socket.readyState = 1; // OPEN

    devWsInvoke('machine_config', { node: 42 }).catch(() => {}); // never resolved in this test

    expect(socket.send).toHaveBeenCalledTimes(1);
    const frame = socket.send.mock.calls[0][0] as string;
    expect(typeof frame).toBe('string'); // a TEXT frame, never an ArrayBuffer gesture
    expect(frame.startsWith(DEV_WS_QUERY_PREFIX)).toBe(true);
    const payload = JSON.parse(frame.slice(DEV_WS_QUERY_PREFIX.length));
    expect(payload.verb).toBe('machine_config');
    expect(payload.args).toEqual({ node: 42 });
    expect(typeof payload.reqId).toBe('number');
  });

  it('resolves the pending promise when a reply frame arrives with the matching reqId', async () => {
    makeDevWebSocketTransport('ws://test/render');
    socket.readyState = 1;

    const p = devWsInvoke('machine_config', { node: 7 });
    const frame = socket.send.mock.calls[0][0] as string;
    const { reqId } = JSON.parse(frame.slice(DEV_WS_QUERY_PREFIX.length));

    // The host answers with a kind-tagged config value over a TEXT frame.
    socket.onmessage?.({
      data: JSON.stringify({ reqId, ok: true, value: { kind: 'Factory', source: 'x' } }),
    });

    await expect(p).resolves.toEqual({ kind: 'Factory', source: 'x' });
  });

  it('rejects the pending promise on an error reply', async () => {
    makeDevWebSocketTransport('ws://test/render');
    socket.readyState = 1;

    const p = devWsInvoke('validate_factory_js', { source: 'bad(' });
    const frame = socket.send.mock.calls[0][0] as string;
    const { reqId } = JSON.parse(frame.slice(DEV_WS_QUERY_PREFIX.length));

    socket.onmessage?.({ data: JSON.stringify({ reqId, ok: false, error: 'SyntaxError' }) });

    await expect(p).rejects.toBe('SyntaxError');
  });

  it('buffers a query issued before open and flushes it on open', () => {
    makeDevWebSocketTransport('ws://test/render');
    socket.readyState = 0; // still CONNECTING

    devWsInvoke('webhook_url', { node: 3 }).catch(() => {}); // never resolved in this test
    expect(socket.send).not.toHaveBeenCalled();

    socket.readyState = 1;
    socket.onopen?.();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect((socket.send.mock.calls[0][0] as string).startsWith(DEV_WS_QUERY_PREFIX)).toBe(true);
  });

  it('resolveDevWsReply ignores non-reply / unknown-reqId TEXT (returns false)', () => {
    makeDevWebSocketTransport('ws://test/render');
    expect(resolveDevWsReply('not json at all')).toBe(false);
    expect(resolveDevWsReply(JSON.stringify({ reqId: 9999, ok: true, value: null }))).toBe(false);
  });

  it('a closed socket fails in-flight queries (panel surfaces the failure)', async () => {
    makeDevWebSocketTransport('ws://test/render');
    socket.readyState = 1;
    const p = devWsInvoke('machine_config', { node: 1 });
    socket.onclose?.();
    await expect(p).rejects.toThrow('dev WS closed');
  });
});

// ---------------------------------------------------------------------------
// The gesture-verdict grammar (Phase 64, ERR-01/ERR-02).
// ---------------------------------------------------------------------------

describe('resolveGestureVerdict - the second TEXT grammar (every verdict kind since phase 88)', () => {
  /** Register a recording sink and return the array it fills. */
  function sink(): GestureVerdict[] {
    const seen: GestureVerdict[] = [];
    registerGestureVerdictSink((v) => seen.push(v));
    return seen;
  }

  it('dispatches a well-formed refusal to the sink and consumes the frame', () => {
    const seen = sink();
    const frame = JSON.stringify({
      kind: GESTURE_REFUSAL_KIND,
      seq: 12,
      tag: 'MediumMismatch',
    });
    expect(resolveGestureVerdict(frame)).toBe(true);
    expect(seen).toEqual([{ kind: GESTURE_REFUSAL_KIND, seq: 12, tag: 'MediumMismatch' }]);
  });

  it('carries the refused gesture\'s cmd and node when the host names them (plan 74.1-28)', () => {
    const seen = sink();
    const frame = JSON.stringify({
      kind: GESTURE_REFUSAL_KIND,
      seq: 3,
      tag: 'GrowCoversBelt',
      cmd: 'AddPort',
      node: 300,
    });
    expect(resolveGestureVerdict(frame)).toBe(true);
    expect(seen).toEqual([{ kind: GESTURE_REFUSAL_KIND, seq: 3, tag: 'GrowCoversBelt', cmd: 'AddPort', node: 300 }]);
  });

  it('accepts a frame without cmd and node (an undecodable gesture) and adds neither', () => {
    const seen = sink();
    expect(resolveGestureVerdict(JSON.stringify({ kind: GESTURE_REFUSAL_KIND, seq: 4, tag: 'Malformed' }))).toBe(true);
    expect(seen).toEqual([{ kind: GESTURE_REFUSAL_KIND, seq: 4, tag: 'Malformed' }]);
    expect(Object.keys(seen[0]).sort()).toEqual(['kind', 'seq', 'tag']);
  });

  it('delivers a refusal with NO seq (the host could not read its header), adding none', () => {
    // Phase 88 (D-06): an unreadable header names no gesture, so the host omits `seq`. The
    // refusal is still one the user must see.
    const seen = sink();
    expect(resolveGestureVerdict(JSON.stringify({ kind: GESTURE_REFUSAL_KIND, tag: 'Malformed' }))).toBe(true);
    expect(seen).toEqual([{ kind: GESTURE_REFUSAL_KIND, tag: 'Malformed' }]);
  });

  it('delivers an accept naming the handles it minted, and a discard (phase 88, D-06)', () => {
    const seen = sink();
    expect(
      resolveGestureVerdict(JSON.stringify({ kind: GESTURE_ACCEPT_KIND, seq: 7, generation: 2, minted: [9, 10] })),
    ).toBe(true);
    expect(resolveGestureVerdict(JSON.stringify({ kind: GESTURE_DISCARD_KIND, seq: 8 }))).toBe(true);
    expect(seen).toEqual([
      { kind: GESTURE_ACCEPT_KIND, seq: 7, generation: 2, minted: [9, 10] },
      { kind: GESTURE_DISCARD_KIND, seq: 8 },
    ]);
  });

  it('drops a mistyped cmd or node but still delivers the refusal', () => {
    const seen = sink();
    for (const [cmd, node] of [
      [7, 'AddPort'],
      [null, -1],
      ['AddPort', 1.5],
      ['AddPort', '300'],
    ] as const) {
      expect(resolveGestureVerdict(JSON.stringify({ kind: GESTURE_REFUSAL_KIND, seq: 5, tag: 'OutOfBounds', cmd, node }))).toBe(true);
    }
    expect(seen).toEqual([
      { kind: GESTURE_REFUSAL_KIND, seq: 5, tag: 'OutOfBounds' },
      { kind: GESTURE_REFUSAL_KIND, seq: 5, tag: 'OutOfBounds' },
      { kind: GESTURE_REFUSAL_KIND, seq: 5, tag: 'OutOfBounds', cmd: 'AddPort' },
      { kind: GESTURE_REFUSAL_KIND, seq: 5, tag: 'OutOfBounds', cmd: 'AddPort' },
    ]);
  });

  it('returns false for an unknown kind (the next grammar gets a turn)', () => {
    const seen = sink();
    const frame = JSON.stringify({ kind: 'somethingElse', seq: 1, tag: 'OutOfBounds' });
    expect(resolveGestureVerdict(frame)).toBe(false);
    expect(seen).toEqual([]);
  });

  it('returns false on malformed JSON and never throws out of a socket callback', () => {
    const seen = sink();
    expect(() => resolveGestureVerdict('not json at all')).not.toThrow();
    expect(resolveGestureVerdict('not json at all')).toBe(false);
    expect(resolveGestureVerdict('null')).toBe(false);
    expect(resolveGestureVerdict('"a bare string"')).toBe(false);
    expect(seen).toEqual([]);
  });

  it('returns false when the tag is not one of the 17 (a raw host string never renders)', () => {
    const seen = sink();
    // The exact shapes a Tauri rejection can carry that are NOT user copy.
    for (const tag of ['sim unavailable', 'could not decode gesture', 'Route', '', 'toString']) {
      const frame = JSON.stringify({ kind: GESTURE_REFUSAL_KIND, seq: 3, tag });
      expect(resolveGestureVerdict(frame), `tag ${JSON.stringify(tag)}`).toBe(false);
    }
    // A non-numeric seq is equally unusable for the stale-drop.
    expect(
      resolveGestureVerdict(
        JSON.stringify({ kind: GESTURE_REFUSAL_KIND, seq: 'twelve', tag: 'OutOfBounds' }),
      ),
    ).toBe(false);
    expect(seen).toEqual([]);
  });

  it('the two grammars never poach each other, in the order devWebSocket runs them', () => {
    makeDevWebSocketTransport('ws://test/render');
    socket.readyState = 1;
    const seen = sink();

    // A config-query reply: the refusal resolver must decline it FIRST (it is run
    // second on the socket, but declining is what makes the order safe either way),
    // and the query resolver must consume it.
    const p = devWsInvoke('machine_config', { node: 1 });
    const reqId = JSON.parse(
      (socket.send.mock.calls[0][0] as string).slice(DEV_WS_QUERY_PREFIX.length),
    ).reqId as number;
    const queryReply = JSON.stringify({ reqId, ok: true, value: null });
    expect(resolveGestureVerdict(queryReply)).toBe(false);
    expect(resolveDevWsReply(queryReply)).toBe(true);
    expect(seen).toEqual([]);

    // And the refusal frame carries NO reqId, so the query resolver declines it
    // (T-64-05-01: this is what keeps a refusal off an in-flight config promise).
    const refusal = JSON.stringify({ kind: GESTURE_REFUSAL_KIND, seq: 1, tag: 'InvalidDock' });
    expect(resolveDevWsReply(refusal)).toBe(false);
    expect(resolveGestureVerdict(refusal)).toBe(true);
    expect(seen).toEqual([{ kind: GESTURE_REFUSAL_KIND, seq: 1, tag: 'InvalidDock' }]);

    return expect(p).resolves.toBeNull();
  });
});

// Phase 90 (FAIL-01, D-11): the sim-fatal frame, the fourth TEXT grammar on the dev socket.
describe('resolveSimFatal - the sim-fatal TEXT grammar', () => {
  /** Register a recording sink and return the array it fills. */
  function sink(): string[] {
    const seen: string[] = [];
    registerSimFatalSink((r) => seen.push(r));
    return seen;
  }

  it('routes a simFatal frame to the sink and consumes it', () => {
    const seen = sink();
    expect(resolveSimFatal(JSON.stringify({ kind: SIM_FATAL_KIND, reason: 'the sim stopped' }))).toBe(true);
    expect(seen).toEqual(['the sim stopped']);
  });

  it('keeps an empty reason: it is still a stopped simulation', () => {
    const seen = sink();
    expect(resolveSimFatal(JSON.stringify({ kind: SIM_FATAL_KIND, reason: '' }))).toBe(true);
    expect(seen).toEqual(['']);
  });

  it.each([
    ['a load refusal (another kind)', JSON.stringify({ kind: LOAD_REFUSAL_KIND, reason: 'x' })],
    ['a non-string reason', JSON.stringify({ kind: SIM_FATAL_KIND, reason: 7 })],
    ['no reason', JSON.stringify({ kind: SIM_FATAL_KIND })],
    ['no kind', JSON.stringify({ reason: 'x' })],
    ['not JSON', '{not json'],
    ['JSON null', 'null'],
  ])('drops %s and leaves the frame to the next grammar', (_name, text) => {
    const seen = sink();
    expect(resolveSimFatal(text)).toBe(false);
    expect(seen).toEqual([]);
  });

  it('the dev socket hands a simFatal TEXT frame to onSimFatal', () => {
    const transport = makeDevWebSocketTransport('ws://127.0.0.1:8787/render');
    const seen: string[] = [];
    transport.onSimFatal((r) => seen.push(r));
    socket.onmessage?.({ data: JSON.stringify({ kind: SIM_FATAL_KIND, reason: 'r' }) });
    expect(seen).toEqual(['r']);
  });
});

describe('isRefusalTag - the runtime narrowing 64-07 reuses', () => {
  it('accepts every one of the 17 host tags', () => {
    const tags = [
      'FootprintCollision',
      'OutOfBounds',
      'UnknownNode',
      'IncompatiblePorts',
      'PortOccupied',
      'UnknownKind',
      'BeltNotPlaceable',
      'InvalidDock',
      'Malformed',
      'BeltTooLong',
      'NothingToUndo',
      'NothingToRedo',
      'MediumMismatch',
      'ZeroBeltInterval',
      'RouteEmpty',
      'RouteNonAdjacent',
      'RouteSelfCrossing',
    ];
    expect(tags).toHaveLength(17);
    for (const tag of tags) {
      expect(isRefusalTag(tag), tag).toBe(true);
    }
  });

  it('rejects a prototype key (`in` would have narrowed these)', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(isRefusalTag(key), key).toBe(false);
    }
  });

  it('rejects non-strings and unknown strings', () => {
    expect(isRefusalTag(undefined)).toBe(false);
    expect(isRefusalTag(null)).toBe(false);
    expect(isRefusalTag(7)).toBe(false);
    expect(isRefusalTag('sim unavailable')).toBe(false);
  });
});

// Phase 90 review WR-A-03: a Save the host could not write reaches the page.
describe('resolveSaveFailure - the save-failure TEXT grammar', () => {
  /** Register a recording sink and return the array it fills. */
  function sink(): string[] {
    const seen: string[] = [];
    registerSaveFailureSink((r) => seen.push(r));
    return seen;
  }

  it('routes a saveFailed frame to the sink and consumes it', () => {
    const seen = sink();
    expect(resolveSaveFailure(JSON.stringify({ kind: SAVE_FAILURE_KIND, reason: 'disk full.' }))).toBe(true);
    expect(seen).toEqual(['disk full.']);
  });

  it.each([
    ['a load refusal (another kind)', JSON.stringify({ kind: LOAD_REFUSAL_KIND, reason: 'x' })],
    ['a non-string reason', JSON.stringify({ kind: SAVE_FAILURE_KIND, reason: 7 })],
    ['not JSON', '{not json'],
  ])('drops %s', (_name, text) => {
    const seen = sink();
    expect(resolveSaveFailure(text)).toBe(false);
    expect(seen).toEqual([]);
  });

  it('the dev socket hands a saveFailed TEXT frame to onSaveFailed, not to onLoadRefused', () => {
    const transport = makeDevWebSocketTransport('ws://127.0.0.1:8787/render');
    const saved: string[] = [];
    const refused: string[] = [];
    transport.onSaveFailed((r) => saved.push(r));
    transport.onLoadRefused((r) => refused.push(r));
    socket.onmessage?.({ data: JSON.stringify({ kind: SAVE_FAILURE_KIND, reason: 'r.' }) });
    expect(saved).toEqual(['r.']);
    expect(refused).toEqual([]);
  });
});
