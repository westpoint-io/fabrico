// The FIRST tests this module has ever had, and it is the only transport a user runs.
//
// Everything below Phase 64 covered the dev WebSocket: both Playwright configs and every
// other vitest file take the `transportKind() === 'dev'` branch, `crates/fabrico-app`
// launches no binary in CI, and Playwright-WebKit does not start on the maintainer's
// machine. The demonstrated cost of that gap: replacing this module's verdict handling
// with a no-op left EVERY suite green while the shipped desktop build showed no refusal
// for any gesture — Phase 64's own bug, restored, on the transport that ships.
//
// `@tauri-apps/api/core` is stubbed, so these run in plain node with no webview.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The stub Tauri core module. `vi.hoisted` because `vi.mock`'s factory is hoisted
 *  above the imports and cannot close over an ordinary top-level const. */
const tauri = vi.hoisted(() => {
  /** Stands in for `tauri::ipc::Channel` — a JS object the host later pushes to. */
  class Channel<T> {
    onmessage: ((message: T) => void) | null = null;
  }
  const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
  return { Channel, invoke };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  Channel: tauri.Channel,
}));

import {
  GESTURE_ACCEPT_KIND,
  GESTURE_REFUSAL_KIND,
  LOAD_REFUSAL_KIND,
  SAVE_FAILURE_KIND,
  SIM_FATAL_KIND,
  type GestureVerdict,
  type ITransport,
} from './transport.ts';
import { makeTauriChannelTransport, parseLoadRefusal } from './tauriChannel.ts';

/** Every channel the transport handed to a `subscribe_*` command, by command name. */
const channels = new Map<string, { onmessage: ((m: never) => void) | null }>();

/**
 * The DEFAULT stub, and the one detail that is not cosmetic: `subscribe_render` returns
 * a promise that NEVER settles, because the real command is the host's forever
 * diff-forwarding loop. Anything the transport awaits after it never runs at all, which
 * is what makes the subscription ORDER assertion below a real test.
 */
function defaultInvoke(cmd: string, args?: unknown): Promise<unknown> {
  const channel = (args as { channel?: { onmessage: null } } | undefined)?.channel;
  if (channel) channels.set(cmd, channel);
  if (cmd === 'subscribe_render') return new Promise<never>(() => {});
  return Promise.resolve(undefined);
}

/** Let the transport's `import()` + subscription promise chain run to completion. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Build a transport and wait until all three channels are open. */
async function subscribed(): Promise<ITransport> {
  const transport = makeTauriChannelTransport();
  await flush();
  return transport;
}

/** Push one message down whichever channel the transport opened for `cmd`. */
function push(cmd: string, message: unknown): void {
  const channel = channels.get(cmd);
  if (!channel) throw new Error(`no channel was opened for ${cmd}`);
  (channel.onmessage as ((m: unknown) => void) | null)?.(message);
}

/** The commands invoked so far, in invocation order. */
const invokedCommands = (): string[] => tauri.invoke.mock.calls.map((c) => c[0]);

beforeEach(() => {
  channels.clear();
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(defaultInvoke);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The verdict parser's own cases moved to `transport.test.ts` in plan 88-03, with the parser
// (`parseGestureVerdict`, the one both transports call). This file keeps the Tauri PATH.

describe('makeTauriChannelTransport — the verdict path', () => {
  it('delivers a host refusal to the registered onGestureVerdict handler', async () => {
    const transport = await subscribed();
    const seen: GestureVerdict[] = [];
    transport.onGestureVerdict((v) => seen.push(v));

    push('subscribe_gesture_verdicts', {
      kind: GESTURE_REFUSAL_KIND,
      seq: 9,
      tag: 'IncompatiblePorts',
    });

    // THE MUTATION THIS CATCHES: make the channel's onmessage a no-op, drop the
    // `verdictCb?.(verdict)` call, or have `parseGestureVerdict` return null, and the
    // shipped desktop build shows no refusal for ANY gesture. That is the whole of
    // Phase 64 undone, and before this test nothing in the repo could see it.
    expect(seen).toEqual([{ kind: GESTURE_REFUSAL_KIND, seq: 9, tag: 'IncompatiblePorts' }]);
  });

  it('delivers a host ACCEPT naming its minted handles to the same handler (phase 88, D-06)', async () => {
    const transport = await subscribed();
    const seen: GestureVerdict[] = [];
    transport.onGestureVerdict((v) => seen.push(v));
    push('subscribe_gesture_verdicts', { kind: GESTURE_ACCEPT_KIND, seq: 3, generation: 1, minted: [4] });
    expect(seen).toEqual([{ kind: GESTURE_ACCEPT_KIND, seq: 3, generation: 1, minted: [4] }]);
  });

  it('drops an unparseable verdict frame instead of showing a raw host string', async () => {
    const transport = await subscribed();
    const seen: GestureVerdict[] = [];
    transport.onGestureVerdict((v) => seen.push(v));

    push('subscribe_gesture_verdicts', { kind: GESTURE_REFUSAL_KIND, seq: 1, tag: 'nonsense' });
    push('subscribe_gesture_verdicts', { reqId: 1, ok: true, value: null });

    expect(seen).toEqual([]);
  });

  it('delivers verdicts that arrive BEFORE App registers its handler to nobody, and later ones to the handler', async () => {
    const transport = await subscribed();
    // A refusal landing before the handler is wired is dropped rather than thrown: the
    // channel opens at construction, App wires its handler a tick later.
    expect(() =>
      push('subscribe_gesture_verdicts', {
        kind: GESTURE_REFUSAL_KIND,
        seq: 1,
        tag: 'OutOfBounds',
      }),
    ).not.toThrow();

    const seen: GestureVerdict[] = [];
    transport.onGestureVerdict((v) => seen.push(v));
    push('subscribe_gesture_verdicts', { kind: GESTURE_REFUSAL_KIND, seq: 2, tag: 'OutOfBounds' });
    expect(seen).toEqual([{ kind: GESTURE_REFUSAL_KIND, seq: 2, tag: 'OutOfBounds' }]);
  });

  it('opens BOTH refusal channels BEFORE subscribe_render, which never resolves', async () => {
    await subscribed();
    // Move either subscribe AFTER `subscribe_render` and it is never reached at all -
    // that command is the host's forever diff-forwarding loop. The app would then ship
    // with no gesture-refusal path, or (since plan 73-04) no LOAD-refusal path, and every
    // other test here would still pass because nothing else observes the order.
    expect(invokedCommands()).toEqual([
      'subscribe_gesture_verdicts',
      'subscribe_load_refusals',
      // Phase 90 (FAIL-01): the held fatal sim error, before the render loop for the same reason.
      'subscribe_sim_fatal',
      'subscribe_render',
    ]);
    expect(channels.has('subscribe_gesture_verdicts')).toBe(true);
    expect(channels.has('subscribe_load_refusals')).toBe(true);
  });
});

describe('parseLoadRefusal - reject-only narrowing of the load-refusal frame', () => {
  it('accepts the host frame and yields the reason VERBATIM', () => {
    const reason = 'malformed project file (postcard decode failed).';
    expect(parseLoadRefusal({ kind: LOAD_REFUSAL_KIND, reason })).toBe(reason);
  });

  it('does not narrow, truncate or re-author a long host sentence', () => {
    // The longest shipped `ProjectError` sentence runs to 674 characters. Anything that
    // shortened it here would put the app's copy and the host's refusal out of sync,
    // which is what UNDO-09's "in the words the host already wrote" forbids.
    const reason = `x${'y'.repeat(700)}z`;
    expect(parseLoadRefusal({ kind: LOAD_REFUSAL_KIND, reason })).toBe(reason);
  });

  it.each([
    ['null', null],
    ['a string', 'loadRefused'],
    ['a frame with no kind', { reason: 'why not' }],
    ['a frame with the GESTURE kind', { kind: GESTURE_REFUSAL_KIND, reason: 'why not' }],
    ['a frame with some other kind', { kind: 'somethingElse', reason: 'why not' }],
    ['a non-string reason', { kind: LOAD_REFUSAL_KIND, reason: 3 }],
    ['a missing reason', { kind: LOAD_REFUSAL_KIND }],
  ])('drops %s', (_label, frame) => {
    expect(parseLoadRefusal(frame)).toBeNull();
  });
});

describe('makeTauriChannelTransport - the LOAD-refusal path (UNDO-09)', () => {
  it('delivers the host reason to the registered onLoadRefused handler', async () => {
    const transport = await subscribed();
    const seen: string[] = [];
    transport.onLoadRefused((r) => seen.push(r));

    const reason =
      'bundled edit record schema_version 7 is not the version this build reads (8).';
    push('subscribe_load_refusals', { kind: LOAD_REFUSAL_KIND, reason });

    // THE MUTATION THIS CATCHES, and it is the one ruling R-14 exists for: make this
    // channel's onmessage a no-op, drop the `loadRefusedCb?.(reason)` call, or leave
    // `onLoadRefused` the stub task 1 landed, and the SHIPPED desktop build goes silent
    // for every unopenable `.fab` while `npm run e2e:live` stays green - that suite
    // drives `dev_render_server` and never this transport.
    expect(seen).toEqual([reason]);
  });

  it('drops an unparseable load-refusal frame rather than rendering a raw object', async () => {
    const transport = await subscribed();
    const seen: string[] = [];
    transport.onLoadRefused((r) => seen.push(r));

    push('subscribe_load_refusals', { kind: LOAD_REFUSAL_KIND, reason: { nested: 'oops' } });
    push('subscribe_load_refusals', { kind: GESTURE_REFUSAL_KIND, seq: 1, tag: 'OutOfBounds' });

    expect(seen).toEqual([]);
  });

  it('drops a refusal that lands before App registers its handler, without throwing', async () => {
    const transport = await subscribed();
    expect(() =>
      push('subscribe_load_refusals', { kind: LOAD_REFUSAL_KIND, reason: 'too early.' }),
    ).not.toThrow();

    const seen: string[] = [];
    transport.onLoadRefused((r) => seen.push(r));
    push('subscribe_load_refusals', { kind: LOAD_REFUSAL_KIND, reason: 'in time.' });
    expect(seen).toEqual(['in time.']);
  });
});

// Phase 90 (FAIL-01, D-11): the desktop app's held fatal sim error.
describe('makeTauriChannelTransport - the SIM-FATAL path (FAIL-01)', () => {
  it('opens subscribe_sim_fatal BEFORE subscribe_render, which never returns', async () => {
    await subscribed();
    const order = invokedCommands();
    // THE MUTATION THIS CATCHES: open the fatal channel after `subscribe_render` (or not at all)
    // and the shipped desktop app never hears a stopped sim; the dev suite cannot see it.
    expect(order, 'the fatal channel is opened').toContain('subscribe_sim_fatal');
    expect(order.indexOf('subscribe_sim_fatal'), 'and before the render loop').toBeLessThan(order.indexOf('subscribe_render'));
  });

  it('delivers the host reason to the registered onSimFatal handler, an empty one included', async () => {
    const transport = await subscribed();
    const seen: string[] = [];
    transport.onSimFatal((r) => seen.push(r));
    push('subscribe_sim_fatal', { kind: SIM_FATAL_KIND, reason: 'sim loop terminated with a fatal store error: x' });
    push('subscribe_sim_fatal', { kind: SIM_FATAL_KIND, reason: '' });
    expect(seen).toEqual(['sim loop terminated with a fatal store error: x', '']);
  });

  it('drops a frame of another kind or with a non-string reason', async () => {
    const transport = await subscribed();
    const seen: string[] = [];
    transport.onSimFatal((r) => seen.push(r));
    push('subscribe_sim_fatal', { kind: LOAD_REFUSAL_KIND, reason: 'x' });
    push('subscribe_sim_fatal', { kind: SIM_FATAL_KIND, reason: 7 });
    expect(seen).toEqual([]);
  });
});

describe('makeTauriChannelTransport — sendInput is fire-and-forget and ordered', () => {
  it('forwards the encoded bytes to submit_input and returns nothing to await', async () => {
    const transport = await subscribed();
    const returned = transport.sendInput(new Uint8Array([1, 2, 3]));
    expect(returned).toBeUndefined();
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('submit_input', { bytes: [1, 2, 3] });
  });

  it('issues a synchronous burst in submission order', async () => {
    const transport = await subscribed();
    // seedRouterPreset's shape: several gestures from ONE synchronous call, whose order
    // is load-bearing on the host side.
    transport.sendInput(new Uint8Array([10]));
    transport.sendInput(new Uint8Array([20]));
    transport.sendInput(new Uint8Array([30]));
    await flush();

    const sent = tauri.invoke.mock.calls
      .filter((c) => c[0] === 'submit_input')
      .map((c) => (c[1] as { bytes: number[] }).bytes);
    expect(sent).toEqual([[10], [20], [30]]);
  });

  it('swallows the host DIAGNOSTIC rejections without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      tauri.invoke.mockImplementation((cmd, args) => {
        if (cmd === 'submit_input') return Promise.reject('decode');
        return defaultInvoke(cmd, args);
      });
      const transport = await subscribed();
      const seen: GestureVerdict[] = [];
      transport.onGestureVerdict((v) => seen.push(v));

      transport.sendInput(new Uint8Array([0xff]));
      await flush();

      // "decode" and "sim unavailable" are host internals, not user copy: they must
      // reach no display path. The user-facing answer for an undecodable gesture is the
      // `Malformed` refusal the host pushes on the verdict channel instead.
      expect(seen).toEqual([]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

// Phase 90 review WR-B-04: a control sent to a host that refuses it (the stopped sim, a Save the
// command could not take) must not become an unhandled rejection, the same as `sendInput`.
describe('makeTauriChannelTransport - control commands', () => {
  it('a_rejected_control_command_is_not_an_unhandled_rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      tauri.invoke.mockImplementation((cmd, args) => {
        if (cmd === 'save_project_cmd' || cmd === 'pause') return Promise.reject('sim unavailable');
        return defaultInvoke(cmd, args);
      });
      const transport = await subscribed();
      transport.sendControl('save', '/tmp/x.fab');
      transport.sendControl('pause');
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('makeTauriChannelTransport — render packets', () => {
  it('hands inbound channel bytes to the onPacket callback as a Uint8Array', async () => {
    const transport = await subscribed();
    const received: Uint8Array[] = [];
    transport.onPacket((bytes) => received.push(bytes));

    push('subscribe_render', new Uint8Array([7, 8, 9]).buffer);

    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([7, 8, 9]);
  });
});

describe('makeTauriChannelTransport — sendControl routes to capability-scoped commands', () => {
  it.each([
    ['pause', 'pause', undefined, undefined],
    ['resume', 'resume', undefined, undefined],
    ['step', 'step', undefined, undefined],
    ['loadDemo', 'load_demo', undefined, undefined],
    ['new', 'ctrl_new', undefined, undefined],
    ['save', 'save_project_cmd', '/tmp/a.fab', { path: '/tmp/a.fab' }],
    ['load', 'load_project_cmd', '/tmp/a.fab', { path: '/tmp/a.fab' }],
  ] as const)('%s -> %s', async (kind, command, arg, args) => {
    const transport = await subscribed();
    transport.sendControl(kind as Exclude<typeof kind, 'loadExample'>, arg);
    await flush();
    const call = tauri.invoke.mock.calls.find((c) => c[0] === command);
    expect(call, `${kind} must invoke ${command}`).toBeDefined();
    expect(call?.[1]).toEqual(args);
  });

  it('loadExample carries the typed scene id as the camelCase sceneId key', async () => {
    const transport = await subscribed();
    transport.sendControl('loadExample', 'order_processing');
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('load_example', { sceneId: 'order_processing' });
  });
});

// Phase 90 review WR-A-03: the desktop app's failed Save rides the load-refusal channel under
// its own kind, so the shipped build says `Save failed` too (the dev suite cannot see this one).
describe('makeTauriChannelTransport - the SAVE-failure path (WR-A-03)', () => {
  it('delivers a saveFailed frame on the load-refusal channel to onSaveFailed only', async () => {
    const transport = await subscribed();
    const saved: string[] = [];
    const refused: string[] = [];
    transport.onSaveFailed((r) => saved.push(r));
    transport.onLoadRefused((r) => refused.push(r));
    push('subscribe_load_refusals', { kind: SAVE_FAILURE_KIND, reason: 'disk full.' });
    expect(saved).toEqual(['disk full.']);
    expect(refused, 'a save failure is not a load refusal').toEqual([]);
  });
});
