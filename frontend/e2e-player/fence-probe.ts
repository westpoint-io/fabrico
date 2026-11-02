// The stack probe the fence spec runs in three places: the test's own Node process, Chromium's main
// thread and a Chromium Worker. The two browser runs get this function as source text, so it has
// no imports and refers to nothing outside its own body.
//
// Each run takes a fresh instance of the corpus harness with the clock returning 0. A call that
// returns a status is the engine's answer. A call that throws is a trap: the JavaScript engine's
// own stack ran out under the wasm frames, and that instance can't be used again.

/** What one call did. */
export interface FenceCall {
  kind: 'ran' | 'fault' | 'trap';
  /** The harness's status, or -1 for a trap. */
  status: number;
  /** The fault text, or the thrown error's message for a trap. */
  text: string;
}

/** What the probe found for one recursion shape. */
export interface ShapeProbe {
  shape: number;
  /** The first depth that didn't run at the default limit. */
  firstFault: number;
  atFirstFault: FenceCall;
  belowAtDefault: FenceCall;
  belowAtQuarter: FenceCall;
  shallowDepth: number;
  shallow: FenceCall;
  runaway: FenceCall;
  /** Depth 100000 under the old 512 KiB limit, printed and not asserted. */
  runawayAtOldLimit: FenceCall;
}

export interface FenceProbeResult {
  defaultStack: number;
  shadowStack: number;
  shapes: ShapeProbe[];
}

/** The deepest recursion the probe tries, and the depth a runaway is run at. */
export const RUNAWAY = 100_000;

/** The shape numbers `fc_fence` takes, from the harness's `shape` module. */
export const RECURSION = 4;
export const MAP_RECURSION = 6;

/**
 * Probes both recursion shapes at this target's default stack limit. The constants are repeated
 * inside the body because the browser runs get only this function's source.
 */
export async function fenceProbe(bytes: Uint8Array<ArrayBuffer>): Promise<FenceProbeResult> {
  const runaway = 100_000;
  const oldLimit = 512 * 1024;
  // Plain recursion has to run at depth 50, and recursion through Array.map at depth 20.
  const shapes: Array<[number, number]> = [
    [4, 50],
    [6, 20],
  ];
  const module = await WebAssembly.compile(bytes);

  interface Exports {
    memory: WebAssembly.Memory;
    fc_fence(shape: number, n: number, gas: number, mem: number, stack: number): number;
    fc_default_stack(): number;
    fc_out_ptr(): number;
    fc_out_len(): number;
    __stack_low: WebAssembly.Global;
    __stack_high: WebAssembly.Global;
  }
  const fresh = async (): Promise<Exports> => {
    const instance = await WebAssembly.instantiate(module, { env: { __rquickjs_host_now_us: () => 0 } });
    return instance.exports as unknown as Exports;
  };

  const once = async (shape: number, depth: number, stack: number): Promise<FenceCall> => {
    const x = await fresh();
    try {
      const status = x.fc_fence(shape, depth, 0, 0, stack);
      const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.fc_out_ptr(), x.fc_out_len()));
      return { kind: status === 0 ? 'ran' : 'fault', status, text };
    } catch (error) {
      return { kind: 'trap', status: -1, text: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  };

  const first = await fresh();
  const defaultStack = first.fc_default_stack();
  const shadowStack = Number(first.__stack_high.value) - Number(first.__stack_low.value);

  const results: ShapeProbe[] = [];
  for (const [shape, shallowDepth] of shapes) {
    // The first depth that doesn't run, by bisection. A trap counts as not running, so a default
    // that traps before it faults shows up as a trap at this depth.
    let low = 1;
    let high = runaway;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if ((await once(shape, middle, 0)).kind === 'ran') low = middle + 1;
      else high = middle;
    }
    results.push({
      shape,
      firstFault: low,
      atFirstFault: await once(shape, low, 0),
      belowAtDefault: await once(shape, low - 1, 0),
      belowAtQuarter: await once(shape, low - 1, Math.floor(defaultStack / 4)),
      shallowDepth,
      shallow: await once(shape, shallowDepth, 0),
      runaway: await once(shape, runaway, 0),
      runawayAtOldLimit: await once(shape, runaway, oldLimit),
    });
  }
  return { defaultStack, shadowStack, shapes: results };
}
