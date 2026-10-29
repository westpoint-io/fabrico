import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GESTURE_ACCEPT_KIND,
  GESTURE_DISCARD_KIND,
  GESTURE_REFUSAL_KIND,
  type ITransport,
  detectEnv,
  makeTransport,
  parseGestureVerdict,
  parseSaveFailure,
  resetTransportForTest,
  SAVE_FAILURE_KIND,
  transportKind,
} from './transport.ts';
import * as transportModule from './transport.ts';

afterEach(() => {
  resetTransportForTest();
});

const fakeTransport = (): ITransport => ({
  onPacket: vi.fn(),
  sendInput: vi.fn(async () => null),
  onGestureVerdict: vi.fn(),
  onLoadRefused: vi.fn(),
  onSimFatal: vi.fn(),
  onSaveFailed: vi.fn(),
  sendControl: vi.fn(),
  close: vi.fn(),
});

describe('transportKind — runtime selection', () => {
  it('selects the dev WebSocket outside Tauri (no window.__TAURI__)', () => {
    expect(transportKind({ hasTauri: false })).toBe('dev');
  });

  it('selects the Tauri channel under Tauri', () => {
    expect(transportKind({ hasTauri: true })).toBe('tauri');
  });

  it('detects no Tauri runtime in the node test environment', () => {
    expect(detectEnv().hasTauri).toBe(false);
  });
});

describe('makeTransport — create-once singleton (T-07-TRANSPORT-DUP)', () => {
  it('returns the dev impl outside Tauri', () => {
    const dev = fakeTransport();
    const tauri = fakeTransport();
    const t = makeTransport({ dev: () => dev, tauri: () => tauri });
    expect(t).toBe(dev);
  });

  it('returns the SAME instance on repeated calls (no per-frame reconnect)', () => {
    const dev = vi.fn(fakeTransport);
    const first = makeTransport({ dev });
    const second = makeTransport({ dev });
    expect(first).toBe(second);
    expect(dev).toHaveBeenCalledTimes(1);
  });
});

/**
 * Phase 88 (D-06): the ONE verdict parser both transports call. Moved here from
 * `tauriChannel.test.ts` (`parseGestureRefusal`, which only knew refusals) when every
 * gesture started getting an answer. REJECT-ONLY: a frame it cannot vouch for is `null`.
 */
// Phase 90 review WR-A-03: one parser for the save-failure frame, shared by both transports.
describe('parseSaveFailure - reject-only', () => {
  it('narrows a saveFailed frame to its reason and drops anything else', () => {
    expect(SAVE_FAILURE_KIND, 'the kind the host sends').toBe('saveFailed');
    expect(parseSaveFailure({ kind: SAVE_FAILURE_KIND, reason: 'x.' })).toBe('x.');
    expect(parseSaveFailure({ kind: 'loadRefused', reason: 'x.' }), 'a wrong kind').toBeNull();
    expect(parseSaveFailure({ kind: SAVE_FAILURE_KIND, reason: 7 }), 'a non-string reason').toBeNull();
    expect(parseSaveFailure(null), 'not an object').toBeNull();
  });
});

describe('parseGestureVerdict - one parser, three kinds, reject-only', () => {
  it('narrows a refusal, keeping cmd and node when the host names them', () => {
    expect(parseGestureVerdict({ kind: GESTURE_REFUSAL_KIND, seq: 4, tag: 'MediumMismatch' })).toEqual({
      kind: GESTURE_REFUSAL_KIND,
      seq: 4,
      tag: 'MediumMismatch',
    });
    expect(
      parseGestureVerdict({ kind: GESTURE_REFUSAL_KIND, seq: 4, tag: 'GrowCoversBelt', cmd: 'AddPort', node: 300 }),
    ).toEqual({ kind: GESTURE_REFUSAL_KIND, seq: 4, tag: 'GrowCoversBelt', cmd: 'AddPort', node: 300 });
  });

  it('accepts a refusal WITHOUT seq (an unreadable header names no gesture) and adds no key', () => {
    const v = parseGestureVerdict({ kind: GESTURE_REFUSAL_KIND, tag: 'Malformed' });
    expect(v).toEqual({ kind: GESTURE_REFUSAL_KIND, tag: 'Malformed' });
    expect(Object.keys(v ?? {}).sort()).toEqual(['kind', 'tag']);
  });

  it('drops a mistyped cmd or node but still yields the refusal', () => {
    expect(parseGestureVerdict({ kind: GESTURE_REFUSAL_KIND, seq: 1, tag: 'OutOfBounds', cmd: 7, node: -2 })).toEqual({
      kind: GESTURE_REFUSAL_KIND,
      seq: 1,
      tag: 'OutOfBounds',
    });
  });

  it('narrows an accept, its minted handles copied rather than aliased', () => {
    const minted = [9, 10];
    const v = parseGestureVerdict({ kind: GESTURE_ACCEPT_KIND, seq: 5, generation: 2, minted });
    expect(v).toEqual({ kind: GESTURE_ACCEPT_KIND, seq: 5, generation: 2, minted: [9, 10] });
    minted.push(11);
    expect(v?.kind === GESTURE_ACCEPT_KIND && v.minted, 'the frame cannot be mutated through the verdict').toEqual([9, 10]);
    expect(parseGestureVerdict({ kind: GESTURE_ACCEPT_KIND, seq: 6, generation: 0, minted: [] })).toEqual({
      kind: GESTURE_ACCEPT_KIND,
      seq: 6,
      generation: 0,
      minted: [],
    });
  });

  // Phase 90 red-first probe (plan 90-01, D-14), seen red at PHASE90_START behind the red-first
  // gate and turned on by plan 90-06 (FAIL-01); its body did not change, so the parser that plan
  // added is still reached through a cast.
  it('a_sim_fatal_frame_parses_to_its_reason', () => {
    const mod = transportModule as unknown as { SIM_FATAL_KIND?: string; parseSimFatal?: (frame: unknown) => string | null };
    console.log(`P90-FAIL-01-frame kind=${JSON.stringify(mod.SIM_FATAL_KIND)} parser=${typeof mod.parseSimFatal}`);
    expect(mod.SIM_FATAL_KIND, 'the fatal frame kind').toBe('simFatal');
    expect(typeof mod.parseSimFatal, 'one parser for the fatal frame').toBe('function');
    expect(mod.parseSimFatal!({ kind: 'simFatal', reason: 'x' })).toBe('x');
    expect(mod.parseSimFatal!({ kind: 'loadRefused', reason: 'x' }), 'a wrong kind').toBeNull();
    expect(mod.parseSimFatal!({ kind: 'simFatal', reason: 7 }), 'a non-string reason').toBeNull();
  });

  it('narrows a discard', () => {
    expect(parseGestureVerdict({ kind: GESTURE_DISCARD_KIND, seq: 7 })).toEqual({ kind: GESTURE_DISCARD_KIND, seq: 7 });
  });

  it.each([
    ['a null frame', null],
    ['a bare string', 'MediumMismatch'],
    ['a number', 7],
    ['a frame with no kind', { seq: 1, tag: 'OutOfBounds' }],
    ['a frame with the wrong kind', { kind: 'somethingElse', seq: 1, tag: 'OutOfBounds' }],
    ['a refusal with a non-numeric seq', { kind: GESTURE_REFUSAL_KIND, seq: '1', tag: 'OutOfBounds' }],
    ['a refusal with a NaN seq', { kind: GESTURE_REFUSAL_KIND, seq: Number.NaN, tag: 'OutOfBounds' }],
    ['a refusal with a negative seq', { kind: GESTURE_REFUSAL_KIND, seq: -1, tag: 'OutOfBounds' }],
    // A tag outside the closed union is DROPPED, never passed through: the copy table is
    // keyed on that union and a raw host string reaching a user is what ERR-02 forbids.
    ['a refusal with an unknown tag', { kind: GESTURE_REFUSAL_KIND, seq: 1, tag: 'KabooM' }],
    ['a refusal with a prototype key as the tag', { kind: GESTURE_REFUSAL_KIND, seq: 1, tag: 'toString' }],
    ['a refusal with a non-string tag', { kind: GESTURE_REFUSAL_KIND, seq: 1, tag: 3 }],
    // An accept that cannot be paired safely is dropped rather than pairing a gesture with
    // a bogus handle.
    ['an accept with no seq', { kind: GESTURE_ACCEPT_KIND, generation: 0, minted: [] }],
    ['an accept with no generation', { kind: GESTURE_ACCEPT_KIND, seq: 1, minted: [] }],
    ['an accept with no minted list', { kind: GESTURE_ACCEPT_KIND, seq: 1, generation: 0 }],
    ['an accept whose minted is not an array', { kind: GESTURE_ACCEPT_KIND, seq: 1, generation: 0, minted: 3 }],
    ['an accept minting a negative handle', { kind: GESTURE_ACCEPT_KIND, seq: 1, generation: 0, minted: [-1] }],
    ['an accept minting a fractional handle', { kind: GESTURE_ACCEPT_KIND, seq: 1, generation: 0, minted: [1.5] }],
    ['an accept minting an unsafe handle', { kind: GESTURE_ACCEPT_KIND, seq: 1, generation: 0, minted: [2 ** 53] }],
    ['an accept minting a string', { kind: GESTURE_ACCEPT_KIND, seq: 1, generation: 0, minted: ['4'] }],
    ['a discard with no seq', { kind: GESTURE_DISCARD_KIND }],
  ])('drops %s', (_label, frame) => {
    expect(parseGestureVerdict(frame)).toBeNull();
  });
});

// Phase 90 review WR-C-03: the fatal spec counts what the page SENDS on a stopped simulation, not
// what the dead host does (a dead host moves no tick whatever the page sends). The count wraps the
// transport's two send seams and nothing else.
describe('countSends - the page-side send counter (review WR-C-03)', () => {
  it('counts every control and every gesture handed to the transport, and passes each through', () => {
    const controls: string[] = [];
    const inputs: number[] = [];
    const inner = {
      onPacket: vi.fn(),
      sendInput: (bytes: Uint8Array) => inputs.push(bytes.length),
      onGestureVerdict: vi.fn(),
      onLoadRefused: vi.fn(),
      onSimFatal: vi.fn(),
      onSaveFailed: vi.fn(),
      sendControl: (kind: string) => controls.push(kind),
      close: vi.fn(),
    } as unknown as transportModule.ITransport;
    const counts = { controls: 0, inputs: 0 };
    const t = transportModule.countSends(inner, counts);
    t.sendControl('pause');
    t.sendControl('save', '/tmp/x.fab');
    t.sendInput(new Uint8Array([1, 2, 3]));
    expect(counts).toEqual({ controls: 2, inputs: 1 });
    expect(controls).toEqual(['pause', 'save']);
    expect(inputs).toEqual([3]);
  });
});
