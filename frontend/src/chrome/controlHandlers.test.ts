// Smoke test (18-05, CLEAN-04): every Toolbar/gesture control handler drives a
// real host command through the transport control seam — NO bare stub survives.
// A fake transport records the `sendControl` calls; the dialog/prompt seams are
// injected so the test never opens a native dialog or a browser prompt.

import { describe, expect, it, vi } from 'vitest';
import {
  type ControlHandlerDeps,
  type StatusKind,
  STATUS_COPY,
  makeControlHandlers,
} from './controlHandlers.ts';
import type { ControlKind, ITransport } from '../transport/transport.ts';

// SAVE-03 smart-Save: the native save dialog is exercised through the REAL
// `defaultPickSavePath` (no injected pickSavePath), so we mock the dynamically
// imported plugin to spy the `save()` options and assert the untitled.fab
// default + the .fab filter without opening a native dialog. Least privilege is
// unchanged: still ONLY @tauri-apps/plugin-dialog (no filesystem plugin).
const saveSpy = vi.fn(async (_opts?: unknown) => '/native/untitled.fab');
const openSpy = vi.fn(async (_opts?: unknown) => '/native/open.fab');
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (opts?: unknown) => saveSpy(opts),
  open: (opts?: unknown) => openSpy(opts),
}));

interface Recorded {
  kind: ControlKind;
  path?: string;
}

function harness(over: Partial<ControlHandlerDeps> = {}) {
  const calls: Recorded[] = [];
  const status: StatusKind[] = [];
  const transport: ITransport = {
    onPacket: vi.fn(),
    sendInput: vi.fn(async () => null),
    onGestureVerdict: vi.fn(),
  onLoadRefused: vi.fn(),
  onSimFatal: vi.fn(),
  onSaveFailed: vi.fn(),
    sendControl: (kind, path) => {
      calls.push({ kind, path });
    },
    close: vi.fn(),
  };
  let playing = false;
  const handlers = makeControlHandlers({
    transport,
    isPlaying: () => playing,
    setPlaying: (next) => {
      playing = next;
    },
    hasTauri: false,
    promptPath: () => '/tmp/factory.fab',
    onStatus: (k) => status.push(k),
    ...over,
  });
  return { calls, status, handlers, setPlaying: (p: boolean) => (playing = p) };
}

describe('control handlers — every affordance calls the transport control seam', () => {
  it('onStep sends step', () => {
    const { calls, handlers } = harness();
    handlers.onStep();
    expect(calls).toEqual([{ kind: 'step', path: undefined }]);
  });

  it('onLoadDemo sends loadDemo', () => {
    const { calls, handlers } = harness();
    handlers.onLoadDemo();
    expect(calls).toEqual([{ kind: 'loadDemo', path: undefined }]);
  });

  it('onPlayPause sends resume when paused, then pause when playing (optimistic flip)', () => {
    const { calls, handlers, setPlaying } = harness();
    setPlaying(false);
    handlers.onPlayPause(); // -> resume
    setPlaying(true);
    handlers.onPlayPause(); // -> pause
    expect(calls.map((c) => c.kind)).toEqual(['resume', 'pause']);
  });

  it('onSave (dev path) prompts for a path then sends save with it', async () => {
    const { calls, handlers } = harness({ promptPath: () => '/tmp/x.fab' });
    await handlers.onSave();
    expect(calls).toEqual([{ kind: 'save', path: '/tmp/x.fab' }]);
  });

  it('onLoad (dev path) prompts for a path then sends load with it', async () => {
    const { calls, handlers } = harness({ promptPath: () => '/tmp/x.fab' });
    await handlers.onLoad();
    expect(calls).toEqual([{ kind: 'load', path: '/tmp/x.fab' }]);
  });

  it('onSave sends NOTHING when the prompt is cancelled (no path chosen)', async () => {
    const { calls, handlers } = harness({ promptPath: () => null });
    await handlers.onSave();
    expect(calls).toEqual([]);
  });

  it('onSave (Tauri path) uses the native dialog, not the prompt', async () => {
    const pickSavePath = vi.fn(async () => '/native/chosen.fab');
    const promptPath = vi.fn(() => '/should-not-be-used');
    const { calls, handlers } = harness({ hasTauri: true, pickSavePath, promptPath });
    await handlers.onSave();
    expect(pickSavePath).toHaveBeenCalledOnce();
    expect(promptPath).not.toHaveBeenCalled();
    expect(calls).toEqual([{ kind: 'save', path: '/native/chosen.fab' }]);
  });

  it('onLoad (Tauri path) uses the native open dialog', async () => {
    const pickLoadPath = vi.fn(async () => '/native/open.fab');
    const { calls, handlers } = harness({ hasTauri: true, pickLoadPath });
    await handlers.onLoad();
    expect(pickLoadPath).toHaveBeenCalledOnce();
    expect(calls).toEqual([{ kind: 'load', path: '/native/open.fab' }]);
  });

  it('SAVE-05 / D-02: a dispatched Open reports its path as a pending load, then loading', async () => {
    // Opening X makes X the smart-Save target once the host confirms the Load (App moves it
    // on the swap keyframe). The handler reports the DISPATCHED path, after a successful
    // dispatch and before 'loading', KIND-free (never in a status string).
    const order: string[] = [];
    const onPathChosen = vi.fn();
    const onLoadDispatched = vi.fn((path: string) => order.push(`dispatched:${path}`));
    const pickLoadPath = vi.fn(async () => '/native/open.fab');
    const { handlers } = harness({
      hasTauri: true,
      pickLoadPath,
      onPathChosen,
      onLoadDispatched,
      onStatus: (kind) => order.push(`status:${kind}`),
    });
    await handlers.onLoad();
    expect(order).toEqual(['dispatched:/native/open.fab', 'status:loading']);
    expect(onPathChosen, 'an Open never reports a Save-As pick').not.toHaveBeenCalled();
  });

  it('SAVE-05: a cancelled Open records NO smart-Save path and no pending load', async () => {
    const onPathChosen = vi.fn();
    const onLoadDispatched = vi.fn();
    const pickLoadPath = vi.fn(async () => null);
    const { calls, handlers } = harness({ hasTauri: true, pickLoadPath, onPathChosen, onLoadDispatched });
    await handlers.onLoad();
    expect(onPathChosen).not.toHaveBeenCalled();
    expect(onLoadDispatched).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  // Phase 90 red-first probes (plan 90-01, D-14), seen red at PHASE90_START behind the red-first
  // gate and turned on by plans 90-02 (FAIL-03), 90-04 (WORK-07) and 90-06 (FAIL-01). Review IN-B-07:
  // each now reaches its plan's API directly, so tsc checks it, and prints nothing.

  // FAIL-03 (D-07): turned on by plan 90-02, its probe gate removed and its body unchanged.
  it('step_while_playing_pauses_before_it_steps', () => {
    for (const startsPlaying of [true, false]) {
      const order: string[] = [];
      let playing = startsPlaying;
      const transport: ITransport = {
        onPacket: vi.fn(),
        sendInput: vi.fn(async () => null),
        onGestureVerdict: vi.fn(),
        onLoadRefused: vi.fn(),
        onSimFatal: vi.fn(),
        onSaveFailed: vi.fn(),
        sendControl: (kind) => {
          order.push(`send:${kind}`);
        },
        close: vi.fn(),
      };
      const handlers = makeControlHandlers({
        transport,
        isPlaying: () => playing,
        setPlaying: (next) => {
          order.push(`setPlaying:${next}`);
          playing = next;
        },
        hasTauri: false,
        promptPath: () => '/tmp/factory.fab',
      });
      handlers.onStep();
      expect(order, startsPlaying ? 'playing: the page pauses itself, then steps' : 'paused: the step alone').toEqual(
        startsPlaying ? ['setPlaying:false', 'send:step'] : ['send:step'],
      );
    }
  });

  it('a_dispatched_open_moves_no_save_target_until_the_host_confirms', async () => {
    const onPathChosen = vi.fn();
    const onLoadDispatched = vi.fn();
    const pickLoadPath = vi.fn(async () => '/native/open.fab');
    const { calls, handlers } = harness({
      hasTauri: true,
      pickLoadPath,
      onPathChosen,
      onLoadDispatched,
    });
    await handlers.onLoad();
    expect(calls, 'the Load is dispatched').toEqual([{ kind: 'load', path: '/native/open.fab' }]);
    expect(onPathChosen, 'a dispatched Open moves no save target').not.toHaveBeenCalled();
    expect(onLoadDispatched, 'the dispatched path is held as a pending load').toHaveBeenCalledWith('/native/open.fab');
  });

  it('the_stopped_status_reads_simulation_stopped', () => {
    expect(STATUS_COPY.simStopped).toBe('Simulation stopped');
  });
});

// SAVE-03: smart-Save (re-save to the known path with NO dialog) + Save-As
// (forced prompt) + the untitled.fab native default. The known path is supplied
// by a currentPath getter (App wires it to currentFilePathRef); a chosen path is
// reported back via onPathChosen so App can update the ref after a Save-As.
describe('control handlers - SAVE-03 smart-Save / Save-As / untitled.fab default', () => {
  it('smart-Save: with a KNOWN path, plain Save re-saves to it and calls NO dialog/prompt', async () => {
    const pickSavePath = vi.fn(async () => '/native/should-not-open.fab');
    const promptPath = vi.fn(() => '/should-not-prompt.fab');
    const { calls, handlers } = harness({
      hasTauri: true,
      pickSavePath,
      promptPath,
      currentPath: () => '/known/current.fab',
    });
    await handlers.onSave();
    expect(pickSavePath).not.toHaveBeenCalled();
    expect(promptPath).not.toHaveBeenCalled();
    expect(calls).toEqual([{ kind: 'save', path: '/known/current.fab' }]);
  });

  it('no known path, plain Save: falls to the dialog (Save-As fallback) and records the chosen path', async () => {
    const pickSavePath = vi.fn(async () => '/native/chosen.fab');
    const onPathChosen = vi.fn();
    const { calls, handlers } = harness({
      hasTauri: true,
      pickSavePath,
      currentPath: () => null,
      onPathChosen,
    });
    await handlers.onSave();
    expect(pickSavePath).toHaveBeenCalledOnce();
    expect(onPathChosen).toHaveBeenCalledWith('/native/chosen.fab');
    expect(calls).toEqual([{ kind: 'save', path: '/native/chosen.fab' }]);
  });

  it('Save-As forced (saveAs=true) ALWAYS prompts, even when a path is known', async () => {
    const pickSavePath = vi.fn(async () => '/native/new-name.fab');
    const onPathChosen = vi.fn();
    const { calls, handlers } = harness({
      hasTauri: true,
      pickSavePath,
      currentPath: () => '/known/current.fab',
      onPathChosen,
    });
    await handlers.onSave(true);
    expect(pickSavePath).toHaveBeenCalledOnce();
    expect(onPathChosen).toHaveBeenCalledWith('/native/new-name.fab');
    expect(calls).toEqual([{ kind: 'save', path: '/native/new-name.fab' }]);
  });

  it('Save-As cancelled (falsy path) emits idle, dispatches NOTHING, records NO path', async () => {
    const pickSavePath = vi.fn(async () => null);
    const onPathChosen = vi.fn();
    const { calls, status, handlers } = harness({
      hasTauri: true,
      pickSavePath,
      currentPath: () => null,
      onPathChosen,
    });
    await handlers.onSave();
    expect(status).toEqual(['idle']);
    expect(onPathChosen).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('the native save dialog defaults to untitled.fab with the .fab filter', async () => {
    saveSpy.mockClear();
    // No injected pickSavePath -> the REAL defaultPickSavePath runs, importing
    // the mocked plugin and calling save() with the default options.
    const { handlers } = harness({ hasTauri: true, currentPath: () => null });
    await handlers.onSave();
    expect(saveSpy).toHaveBeenCalledOnce();
    const opts = saveSpy.mock.calls[0][0] as {
      defaultPath?: string;
      filters?: Array<{ extensions: string[] }>;
    };
    expect(opts.defaultPath).toBe('untitled.fab');
    expect(opts.filters?.[0]?.extensions).toContain('fab');
  });

  it('a forced Save-As with a known path still settles at the honest saveRequested ceiling', async () => {
    const pickSavePath = vi.fn(async () => '/native/as.fab');
    const { status, handlers } = harness({
      hasTauri: true,
      pickSavePath,
      currentPath: () => '/known/current.fab',
    });
    await handlers.onSave(true);
    expect(status).toEqual(['saveRequested']);
  });
});

// SHELL-07: the honest Save/Load status transitions the readout observes. The
// state machine emits KIND enums (never a path string), and the save-resolved
// copy is the dispatch-confirmed ceiling 'Save requested' - there is NO
// host-confirmed "Saved" in the copy map (the host sends no write-result echo).
describe('control handlers - SHELL-07 honest status transitions', () => {
  it('onLoad (truthy path) emits loading and dispatches load with the path', async () => {
    const { calls, status, handlers } = harness({ promptPath: () => '/tmp/x.fab' });
    await handlers.onLoad();
    // 'loading' stays until the App resolves 'loaded' on the first packet.full
    // keyframe (the spike-confirmed signal); the handler emits ONLY 'loading'.
    expect(status).toEqual(['loading']);
    expect(calls).toEqual([{ kind: 'load', path: '/tmp/x.fab' }]);
  });

  it('WR-02: a THROWING Load emits ONLY loadFailed, never loading (dirty stays honest)', async () => {
    // If sendControl throws, the board is never replaced. 'loading' must NOT be
    // emitted - the App keys the dirty-clear + demo-badge-hide off 'loading', so
    // emitting it here would falsely mark an unsaved board clean and defeat the
    // SAFE-03 quit guard. The handler must emit loadFailed and dispatch nothing
    // observable as a success.
    const throwingTransport: ITransport = {
      onPacket: vi.fn(),
      sendInput: vi.fn(async () => null),
      onGestureVerdict: vi.fn(),
  onLoadRefused: vi.fn(),
  onSimFatal: vi.fn(),
  onSaveFailed: vi.fn(),
      sendControl: () => {
        throw new Error('dispatch failed');
      },
      close: vi.fn(),
    };
    const { status, handlers } = harness({
      transport: throwingTransport,
      promptPath: () => '/tmp/x.fab',
    });
    await handlers.onLoad();
    expect(status).toEqual(['loadFailed']);
    expect(status).not.toContain('loading');
  });

  it('onSave (truthy path) settles directly to saveRequested (dispatch-confirmed)', async () => {
    // IN-01: no 'saving' pre-emit - it was synchronously superseded in the same
    // tick and never rendered, so the handler emits ONLY the honest ceiling.
    const { calls, status, handlers } = harness({ promptPath: () => '/tmp/x.fab' });
    await handlers.onSave();
    expect(status).toEqual(['saveRequested']);
    expect(calls).toEqual([{ kind: 'save', path: '/tmp/x.fab' }]);
  });

  it('onSave (cancelled dialog, falsy path) emits idle and dispatches NOTHING', async () => {
    // WR-01: a deliberate cancel is not a failure - it must NOT announce
    // "Save failed". The falsy path emits `idle` (no announcement).
    const { calls, status, handlers } = harness({ promptPath: () => null });
    await handlers.onSave();
    expect(status).toEqual(['idle']);
    expect(calls).toEqual([]);
  });

  it('onLoad (cancelled dialog, falsy path) emits idle and dispatches NOTHING', async () => {
    // WR-01: a deliberate cancel is not a failure - it must NOT announce
    // "Load failed". The falsy path emits `idle` (no announcement).
    const { calls, status, handlers } = harness({ promptPath: () => null });
    await handlers.onLoad();
    expect(status).toEqual(['idle']);
    expect(calls).toEqual([]);
  });

  it('the save-resolved copy is exactly the honest ceiling "Save requested"', () => {
    expect(STATUS_COPY.saveRequested).toBe('Save requested');
  });

  // BL-01 (data loss): onSave resolves a CONFIRMED-write signal so the discard
  // guard's Save-then-proceed can gate its destructive continuation on it. A
  // cancelled dialog or a failed write MUST resolve false so the board is kept.
  it('BL-01: onSave resolves TRUE on a confirmed dispatch (guard may proceed)', async () => {
    const { handlers } = harness({ promptPath: () => '/tmp/x.fab' });
    await expect(handlers.onSave()).resolves.toBe(true);
  });

  it('BL-01: onSave resolves FALSE on a cancelled dialog (guard must NOT proceed)', async () => {
    const { handlers } = harness({ promptPath: () => null });
    await expect(handlers.onSave()).resolves.toBe(false);
  });

  it('BL-01: onSave resolves FALSE when the dispatch throws (guard must NOT proceed)', async () => {
    const throwingTransport: ITransport = {
      onPacket: vi.fn(),
      sendInput: vi.fn(async () => null),
      onGestureVerdict: vi.fn(),
  onLoadRefused: vi.fn(),
  onSimFatal: vi.fn(),
  onSaveFailed: vi.fn(),
      sendControl: () => {
        throw new Error('dispatch failed');
      },
      close: vi.fn(),
    };
    const { status, handlers } = harness({
      transport: throwingTransport,
      promptPath: () => '/tmp/x.fab',
    });
    await expect(handlers.onSave()).resolves.toBe(false);
    expect(status).toEqual(['saveFailed']);
  });

  // BL-01 smart-Save (known path, no dialog) branch: same true/false contract.
  it('BL-01: smart-Save resolves TRUE on a known-path re-save', async () => {
    const { handlers } = harness({ currentPath: () => '/known/current.fab' });
    await expect(handlers.onSave()).resolves.toBe(true);
  });

  it('BL-01: smart-Save resolves FALSE when the known-path dispatch throws', async () => {
    const throwingTransport: ITransport = {
      onPacket: vi.fn(),
      sendInput: vi.fn(async () => null),
      onGestureVerdict: vi.fn(),
  onLoadRefused: vi.fn(),
  onSimFatal: vi.fn(),
  onSaveFailed: vi.fn(),
      sendControl: () => {
        throw new Error('dispatch failed');
      },
      close: vi.fn(),
    };
    const { handlers } = harness({
      transport: throwingTransport,
      currentPath: () => '/known/current.fab',
    });
    await expect(handlers.onSave()).resolves.toBe(false);
  });

  // MD-01: a REJECTING native save dialog must resolve false (Save failed), never
  // an unhandled rejection that would strand a pending New/Open in the guard.
  it('MD-01: onSave resolves FALSE (saveFailed) when the native dialog rejects', async () => {
    const pickSavePath = vi.fn(async () => {
      throw new Error('native dialog exploded');
    });
    const { status, handlers } = harness({
      hasTauri: true,
      pickSavePath,
      currentPath: () => null,
    });
    await expect(handlers.onSave()).resolves.toBe(false);
    expect(status).toEqual(['saveFailed']);
  });

  it('no status copy claims host-confirmed success or echoes a file path', () => {
    const values = Object.values(STATUS_COPY);
    // No host-confirmed Save success string (honesty lineage; host-confirm deferred).
    expect(values).not.toContain('Saved');
    for (const copy of values) {
      // Generic copy only (threat T-32-06-01): never a path separator / extension.
      expect(copy).not.toMatch(/[/\\]|\.fab/);
    }
  });
});

// Phase 90 review WR-B-04: the native Save As and Open dialogs can stay open for as long as the user
// likes, and the fatal can arrive meanwhile. A dialog answered after the stop sends nothing to the
// dead host and reports nothing that would mark the board saved or loading.
describe('control handlers - a dialog answered after the simulation stopped (review WR-B-04)', () => {
  function deferred(): { promise: Promise<string | null>; resolve: (v: string | null) => void } {
    let resolve!: (v: string | null) => void;
    const promise = new Promise<string | null>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('a_save_as_answered_after_the_stop_sends_nothing_and_reports_nothing', async () => {
    let stopped = false;
    const pick = deferred();
    const chosen: string[] = [];
    const { calls, status, handlers } = harness({
      hasTauri: true,
      pickSavePath: () => pick.promise,
      isStopped: () => stopped,
      onPathChosen: (p) => chosen.push(p),
    });
    const saved = handlers.onSave(true);
    stopped = true;
    pick.resolve('/native/after-the-stop.fab');
    expect(await saved, 'the Save did not happen').toBe(false);
    expect(calls, 'nothing was sent to the stopped host').toEqual([]);
    expect(status, 'no status that would clear the Unsaved badge').toEqual([]);
    expect(chosen, 'the save target did not move').toEqual([]);
  });

  it('an_open_answered_after_the_stop_sends_nothing_and_reports_nothing', async () => {
    let stopped = false;
    const pick = deferred();
    const dispatched: string[] = [];
    const { calls, status, handlers } = harness({
      hasTauri: true,
      pickLoadPath: () => pick.promise,
      isStopped: () => stopped,
      onLoadDispatched: (p) => dispatched.push(p),
    });
    const opened = handlers.onLoad();
    stopped = true;
    pick.resolve('/native/after-the-stop.fab');
    await opened;
    expect(calls).toEqual([]);
    expect(status).toEqual([]);
    expect(dispatched).toEqual([]);
  });
});
