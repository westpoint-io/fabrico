import { describe, expect, it, vi } from 'vitest';
import {
  COPY_RESULT_HOLD_MS,
  ClipboardUnavailableError,
  clipboardCopy,
  makeCopyMachine,
  runCopy,
  type CopyState,
} from './clipboardCopy.ts';

// QA-01 regression lock. This is deliberately a NODE test, not a Playwright e2e.
//
// Chromium on `localhost` is a secure context and DOES expose
// `navigator.clipboard`, so a browser suite goes green while the shipped
// WebKitGTK binary (custom protocol, not a secure context) silently no-ops. That
// is exactly how this bug shipped, and it is the same "green gate, broken WebKit"
// class that sank v6.0. Do NOT "improve" this coverage by adding an e2e spec.
//
// What is pinned here is the one claim the button makes: it says "Copied" only
// after a write it awaited and saw resolve, and it says "Copy failed" for every
// observed inability to write. The absent-API case below is the precise
// false-success the shipped `navigator.clipboard?.writeText(url)` optional chain
// produced.

describe('runCopy: a success verdict requires an awaited, resolved write', () => {
  const URL = 'http://127.0.0.1:8787/hook/src-3';

  it("returns 'copied' only after the injected write resolves", async () => {
    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = runCopy(URL, async (t) => {
      expect(t).toBe(URL);
      await gate;
      settled = true;
    });
    // The verdict is still unwritten while the promise is in flight: nothing
    // about elapsed time can produce one.
    expect(settled).toBe(false);
    release();
    expect(await pending).toBe('copied');
    expect(settled).toBe(true);
  });

  it("returns 'failed' when the write REJECTS (the discarded-promise false success)", async () => {
    expect(await runCopy(URL, () => Promise.reject(new Error('host refused')))).toBe('failed');
  });

  it("returns 'failed' when the writer THROWS synchronously", async () => {
    const throwsSync = (): Promise<void> => {
      throw new Error('no clipboard binding');
    };
    expect(await runCopy(URL, throwsSync)).toBe('failed');
  });

  it('has no clock: a slow write that eventually resolves is still a success', async () => {
    const slow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
    expect(await runCopy(URL, slow)).toBe('copied');
  });

  it('LOGS the rejection reason rather than deleting it', async () => {
    // The two words on screen are the same for a capability rejection, an
    // unfocused-document NotAllowedError and a missing plugin. QA-01 exists
    // because a clipboard failure was invisible in the shipped binary; a bare
    // `catch {}` here would have made this the second silent path in the same
    // feature. This pins the cause as recoverable, not the verdict as changed.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cause = new Error('host refused');
      expect(await runCopy(URL, () => Promise.reject(cause))).toBe('failed');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toBe(cause);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs NOTHING on the success path (the log is a diagnostic, not a trace)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runCopy(URL, async () => {})).toBe('copied');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('clipboardCopy: a provably absent API rejects rather than pretending', () => {
  const URL = 'http://127.0.0.1:8787/hook/src-3';

  it('rejects with ClipboardUnavailableError when there is no web clipboard write function', async () => {
    // The node env has no `navigator.clipboard`, which is the same shape as the
    // shipped WebKitGTK webview. The old optional chain evaluated to `undefined`
    // here and the button still said "Copied".
    await expect(clipboardCopy(URL, { hasTauri: false })).rejects.toBeInstanceOf(
      ClipboardUnavailableError,
    );
  });

  it("that rejection is what makes the button read 'Copy failed'", async () => {
    expect(await runCopy(URL, (t) => clipboardCopy(t, { hasTauri: false }))).toBe('failed');
  });

  it('uses the web clipboard write function when one IS present, and awaits it', async () => {
    const written: string[] = [];
    const original = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async (t: string) => {
            written.push(t);
          },
        },
      },
      configurable: true,
      writable: true,
    });
    try {
      expect(await runCopy(URL, (t) => clipboardCopy(t, { hasTauri: false }))).toBe('copied');
      expect(written).toEqual([URL]);
    } finally {
      if (original === undefined) {
        delete (globalThis as { navigator?: unknown }).navigator;
      } else {
        Object.defineProperty(globalThis, 'navigator', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    }
  });

  it('propagates a rejecting web clipboard write instead of swallowing it', async () => {
    const original = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } },
      configurable: true,
      writable: true,
    });
    try {
      await expect(clipboardCopy(URL, { hasTauri: false })).rejects.toThrow('denied');
      expect(await runCopy(URL, (t) => clipboardCopy(t, { hasTauri: false }))).toBe('failed');
    } finally {
      if (original === undefined) {
        delete (globalThis as { navigator?: unknown }).navigator;
      } else {
        Object.defineProperty(globalThis, 'navigator', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// makeCopyMachine: the guards, and the DECIDED hung-IPC end state.
//
// The machine is React-free on purpose (the statusMachine.ts / portEditLatch.ts
// house pattern), which is what lets every one of these run in the node env with
// no DOM and no browser. That matters more here than anywhere else in the repo:
// Chromium on `localhost` exposes the very clipboard API the shipped WebKitGTK
// binary lacks, so a Playwright spec for any of this would go green while the
// binary failed. Do NOT "improve" this coverage by adding an e2e.

/** A fake timer surface: nothing here reads a real clock. */
function fakeClock() {
  let next = 1;
  let now = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  return {
    setTimer: (fn: () => void, ms: number): number => {
      const id = next;
      next += 1;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id: number): void => {
      pending.delete(id);
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    get armed(): number {
      return pending.size;
    },
  };
}

/** A promise the test settles by hand: the in-flight window, held open. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the microtask queue (runCopy's await chain), never a real timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('makeCopyMachine: the in-flight guard cannot be spammed', () => {
  const URL = 'http://127.0.0.1:8787/hook/src-3';

  it('calls the injected write EXACTLY ONCE however many times it is clicked before the write settles', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    const gate = deferred();
    let calls = 0;
    const m = makeCopyMachine({
      copy: (t) => {
        calls += 1;
        expect(t).toBe(URL);
        return gate.promise;
      },
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    expect(m.click(URL)).toBe(true);
    // Four more clicks while the first write is still in flight.
    expect([m.click(URL), m.click(URL), m.click(URL), m.click(URL)]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(calls).toBe(1);
    expect(states).toEqual(['copying']);

    gate.resolve();
    await flush();
    expect(states).toEqual(['copying', 'copied']);
    expect(calls).toBe(1);
  });

  it('accepts the next click once the write has settled', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    let calls = 0;
    const m = makeCopyMachine({
      copy: async () => {
        calls += 1;
      },
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    m.click(URL);
    await flush();
    expect(m.click(URL)).toBe(true);
    await flush();
    expect(calls).toBe(2);
    expect(states).toEqual(['copying', 'copied', 'copying', 'copied']);
  });
});

describe('makeCopyMachine: both results hold for the SAME window, then rest', () => {
  const URL = 'http://127.0.0.1:8787/hook/src-3';

  it('holds a RESOLVED write on "copied" for COPY_RESULT_HOLD_MS and then returns to idle', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    const m = makeCopyMachine({
      copy: async () => {},
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    m.click(URL);
    await flush();
    expect(states).toEqual(['copying', 'copied']);
    clock.advance(COPY_RESULT_HOLD_MS - 1);
    expect(states).toEqual(['copying', 'copied']);
    clock.advance(1);
    expect(states).toEqual(['copying', 'copied', 'idle']);
    expect(clock.armed).toBe(0);
    void m;
  });

  it('holds a REJECTED write on "failed" for the SAME window (one window for both)', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    const m = makeCopyMachine({
      copy: () => Promise.reject(new Error('host refused')),
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    m.click(URL);
    await flush();
    expect(states).toEqual(['copying', 'failed']);
    clock.advance(COPY_RESULT_HOLD_MS - 1);
    expect(states).toEqual(['copying', 'failed']);
    clock.advance(1);
    expect(states).toEqual(['copying', 'failed', 'idle']);
  });
});

describe('makeCopyMachine: the click epoch, scoped to unmount and re-click', () => {
  const URL = 'http://127.0.0.1:8787/hook/src-3';

  it('lets a re-click CLEAR the standing hold timer, so the superseded timer can never flip the fresher state', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    const gate = deferred();
    let call = 0;
    const m = makeCopyMachine({
      copy: () => {
        call += 1;
        return call === 1 ? Promise.resolve() : gate.promise;
      },
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    m.click(URL);
    await flush();
    expect(states).toEqual(['copying', 'copied']);
    expect(clock.armed).toBe(1);

    // Re-click DURING the hold window: the standing timer is cleared, not left
    // to fire over the newer state.
    clock.advance(COPY_RESULT_HOLD_MS / 2);
    expect(m.click(URL)).toBe(true);
    expect(states).toEqual(['copying', 'copied', 'copying']);
    expect(clock.armed).toBe(0);

    // Far past the superseded window, with the newer write still in flight.
    clock.advance(COPY_RESULT_HOLD_MS * 10);
    await flush();
    expect(states).toEqual(['copying', 'copied', 'copying']);
  });

  it('reports a THROWING setState instead of leaving an unhandled rejection', async () => {
    // The settlement chain used to have no rejection handler. A `setState` that
    // throws (an error boundary tearing down mid-commit, a stale setter) throws
    // AFTER the result is committed and BEFORE the hold is armed: an unhandled
    // rejection plus a button stuck on its result with no timer to rest it. In
    // the shipped WebKit webview that rejection is a silent console entry.
    const clock = fakeClock();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const boom = new Error('setter torn down');
      const m = makeCopyMachine({
        copy: async () => {},
        setState: (s) => {
          if (s === 'copied') throw boom;
        },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      });
      m.click(URL);
      await flush();
      // The fault is REPORTED, not swallowed and not turned into a verdict.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toBe(boom);
      // And it never reached the clipboard writer's own diagnostic: this is a
      // commit fault, a different thing from a failed write.
      expect(spy.mock.calls[0]?.[0]).toContain('commit failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the superseded-hold guarantee even when the injected clearTimer does NOT clear', async () => {
    // `clearTimer` is a substitutable seam with no contract check, and it was
    // the SOLE thing standing between a superseded hold timer and a `commit`
    // over a live newer state. Here it is deliberately a liar (a no-op, the
    // shape of a fake-clock bug or a future AbortController seam), so the
    // standing timer really does fire after a re-click. The epoch comparison in
    // the callback - not the seam - is what must refuse it.
    const clock = fakeClock();
    const states: CopyState[] = [];
    const gate = deferred();
    let call = 0;
    const m = makeCopyMachine({
      copy: () => {
        call += 1;
        return call === 1 ? Promise.resolve() : gate.promise;
      },
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: () => {
        /* the dishonest seam: it does not clear */
      },
    });

    m.click(URL);
    await flush();
    expect(states).toEqual(['copying', 'copied']);
    expect(clock.armed).toBe(1);

    // Re-click inside the hold window. The standing timer survives the no-op
    // clear, so it is still queued behind a NEWER, in-flight write.
    clock.advance(COPY_RESULT_HOLD_MS / 2);
    expect(m.click(URL)).toBe(true);
    expect(states).toEqual(['copying', 'copied', 'copying']);
    expect(clock.armed).toBe(1);

    // It fires. It must change nothing: an idle button over a live write would
    // tell the user the copy is over while it is still running.
    clock.advance(COPY_RESULT_HOLD_MS);
    await flush();
    expect(states).toEqual(['copying', 'copied', 'copying']);

    // And the real result still lands when it actually arrives.
    gate.resolve();
    await flush();
    expect(states).toEqual(['copying', 'copied', 'copying', 'copied']);
  });

  it('makes a settlement that arrives after UNMOUNT change nothing and schedule nothing', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    const gate = deferred();
    const m = makeCopyMachine({
      copy: () => gate.promise,
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    m.click(URL);
    expect(states).toEqual(['copying']);

    m.dispose();
    gate.resolve();
    await flush();

    expect(states).toEqual(['copying']);
    expect(clock.armed).toBe(0);
    clock.advance(COPY_RESULT_HOLD_MS * 10);
    expect(states).toEqual(['copying']);
  });

  it('makes a REJECTED settlement after unmount equally inert', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    const gate = deferred();
    const m = makeCopyMachine({
      copy: () => gate.promise,
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    m.click(URL);
    m.dispose();
    gate.reject(new Error('gone'));
    await flush();
    expect(states).toEqual(['copying']);
    expect(clock.armed).toBe(0);
  });

  it('is INERT after dispose, never wedged: a click is refused and reaches neither the writer nor setState', async () => {
    // Two failure modes the explicit `disposed` flag closes, in one test.
    //
    // (1) WEDGED. Disposing mid-write used to leave `state === 'copying'`
    //     forever, so the re-entrancy early return refused every later click
    //     and the button was permanently dead. Only `machineRef.current = null`
    //     in a DIFFERENT file hid that from the app.
    // (2) The mirror image: disposing from REST left `state === 'idle'`, so a
    //     later click was ACCEPTED and drove a write plus a setState into a row
    //     that is gone. That is the bug the epoch exists to stop, arriving
    //     through the front door instead.
    const clock = fakeClock();
    const states: CopyState[] = [];
    let calls = 0;
    const m = makeCopyMachine({
      copy: async () => {
        calls += 1;
      },
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    // Disposed from REST (the settled, idle case).
    m.click(URL);
    await flush();
    expect(states).toEqual(['copying', 'copied']);
    expect(calls).toBe(1);
    m.dispose();
    expect(m.click(URL)).toBe(false);
    await flush();
    expect(calls).toBe(1);
    expect(states).toEqual(['copying', 'copied']);

    // Disposed MID-WRITE: the same refusal, from the other state.
    const gate = deferred();
    const mid = makeCopyMachine({
      copy: () => gate.promise,
      setState: () => {},
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    mid.click(URL);
    mid.dispose();
    gate.resolve();
    await flush();
    expect(mid.click(URL)).toBe(false);
  });

  it('cancels a standing hold timer on unmount, so no setState lands on a gone row', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    const m = makeCopyMachine({
      copy: async () => {},
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    m.click(URL);
    await flush();
    expect(clock.armed).toBe(1);
    m.dispose();
    expect(clock.armed).toBe(0);
    clock.advance(COPY_RESULT_HOLD_MS * 10);
    expect(states).toEqual(['copying', 'copied']);
  });
});

describe('makeCopyMachine: the hung IPC has NO elapsed-time transition (A1, T-52-16)', () => {
  const URL = 'http://127.0.0.1:8787/hook/src-3';

  it('leaves a NEVER-SETTLING write on "copying" forever: no copied, no failed, no timer', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    let calls = 0;
    const m = makeCopyMachine({
      // Never resolves, never rejects: the hung Tauri IPC round trip.
      copy: () => {
        calls += 1;
        return new Promise<void>(() => {});
      },
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    m.click(URL);
    await flush();
    expect(states).toEqual(['copying']);
    // No timer was ever armed for the in-flight window: state 3 is bounded by
    // the promise settling and by NOTHING else.
    expect(clock.armed).toBe(0);

    // Two orders of magnitude past the result-hold window, with microtasks
    // flushed at every step. This asserts the ABSENCE of an elapsed-time
    // transition rather than merely not having waited long enough: if any future
    // edit reintroduces the withdrawn 3000ms cap, this fails immediately.
    for (let i = 0; i < 100; i += 1) {
      clock.advance(COPY_RESULT_HOLD_MS);
      await flush();
    }
    expect(states).toEqual(['copying']);
    expect(clock.armed).toBe(0);

    // And it stays unspammable for that whole time: the guard is not released by
    // a clock either.
    expect(m.click(URL)).toBe(false);
    expect(calls).toBe(1);
  });

  it('a SLOW write that eventually resolves is still a success, however long it took', async () => {
    const clock = fakeClock();
    const states: CopyState[] = [];
    const gate = deferred();
    const m = makeCopyMachine({
      copy: () => gate.promise,
      setState: (s) => states.push(s),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    m.click(URL);
    for (let i = 0; i < 100; i += 1) clock.advance(COPY_RESULT_HOLD_MS);
    await flush();
    expect(states).toEqual(['copying']);
    // The truth arrives late. It is still the truth, and it is not overridden by
    // a guess made at some cap-fire moment.
    gate.resolve();
    await flush();
    expect(states).toEqual(['copying', 'copied']);
  });
});
