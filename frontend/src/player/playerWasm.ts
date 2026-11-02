// The byte loader over the WebAssembly player's raw exports.
//
// The module has one import, the clock QuickJS reads when it creates a context, and this loader
// supplies it as a constant 0. A Factory never sees that clock, because the engine hides `Date`
// from it, and a constant keeps the run from depending on the time anyway. Any other import is
// refused: a Factory must have no route to a network or a real clock.
//
// A memory grow detaches every view of the old buffer, so each read here takes a fresh view of
// `memory.buffer` after the export call that may have grown it.

import { DecodeError, PostcardReader } from '../protocol/decode.ts';

/** The one function the module may import. */
const CLOCK_MODULE = 'env';
const CLOCK_NAME = '__rquickjs_host_now_us';

/** The player's status values, mirroring `FP_OK` and its neighbours in the Rust crate. */
const FP_OK = 0;

/** The player refused a board or a call. The message is the player's own error text. */
export class PlayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerError';
  }
}

/**
 * The wasm instance trapped: a wasm trap, or the JavaScript engine's own stack running out under
 * it. QuickJS's state inside that instance can't be trusted after either, so every later call on
 * the module throws this too. The caller has to load a new module.
 */
export class PlayerTrapped extends Error {
  constructor(cause: unknown) {
    super('the player instance trapped and can take no more calls, so load a new one', { cause });
    this.name = 'PlayerTrapped';
  }
}

/** The HTTP verbs, in the order `HttpMethod` declares them in Rust, which is the wire format. */
const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'] as const;

/** What a command asked the outside world to do. The player only records it. */
export type PlayerEffectKind =
  | { kind: 'Http'; url: string; method: (typeof HTTP_METHODS)[number]; body: Uint8Array }
  | { kind: 'Debug'; message: Uint8Array }
  | { kind: 'Noop' }
  | { kind: 'Reply'; correlation: number; payload: Uint8Array };

/** How the board's script answered a command. */
export type PlayerEffectOutcome =
  | { outcome: 'Reply'; afterTicks: number }
  | { outcome: 'Error'; afterTicks: number }
  | { outcome: 'Timeout' };

/** One outbound command a board's run emitted, and its answer. */
export interface PlayerEffect {
  tick: number;
  effect: PlayerEffectKind;
  answer: PlayerEffectOutcome;
}

function readBytes(r: PostcardReader): Uint8Array {
  return Uint8Array.from(r.vec(() => r.u8()));
}

function readEffectKind(r: PostcardReader): PlayerEffectKind {
  const tag = r.varintU();
  switch (tag) {
    case 0: {
      const url = r.str();
      const methodTag = r.varintU();
      const method = HTTP_METHODS[methodTag];
      if (method === undefined) throw new DecodeError(`unknown HttpMethod discriminant ${methodTag}`);
      return { kind: 'Http', url, method, body: readBytes(r) };
    }
    case 1:
      return { kind: 'Debug', message: readBytes(r) };
    case 2:
      return { kind: 'Noop' };
    case 3: {
      const correlation = r.varintU();
      return { kind: 'Reply', correlation, payload: readBytes(r) };
    }
    default:
      throw new DecodeError(`unknown PlayerEffectKind discriminant ${tag}`);
  }
}

function readEffectOutcome(r: PostcardReader): PlayerEffectOutcome {
  const tag = r.varintU();
  switch (tag) {
    case 0:
      return { outcome: 'Reply', afterTicks: r.varintU() };
    case 1:
      return { outcome: 'Error', afterTicks: r.varintU() };
    case 2:
      return { outcome: 'Timeout' };
    default:
      throw new DecodeError(`unknown PlayerEffectOutcome discriminant ${tag}`);
  }
}

/**
 * Decode what {@link BoardPlayer.takeEffects} returns, a postcard `Vec<PlayerEffect>`. The field and
 * variant order mirrors the Rust types in the player crate. Bytes left over are a decode error.
 */
export function decodePlayerEffects(bytes: Uint8Array): PlayerEffect[] {
  const r = new PostcardReader(bytes);
  const effects = r.vec(() => {
    const tick = r.varintU();
    const effect = readEffectKind(r);
    const answer = readEffectOutcome(r);
    return { tick, effect, answer };
  });
  if (r.remaining() !== 0) {
    throw new DecodeError(`${r.remaining()} bytes left over after the player's effects`);
  }
  return effects;
}

/** One running board on a loaded module. */
export interface BoardPlayer {
  /** Run up to `ticks` ticks, stopping at the end tick. Each tick queues one packet. */
  step(ticks: number): void;
  /** A copy of the next queued packet's bytes, or null when the queue is empty. */
  takePacket(): Uint8Array | null;
  /**
   * The effects emitted since the last call, as bytes for {@link decodePlayerEffects}. With none,
   * these are the bytes of an empty list.
   */
  takeEffects(): Uint8Array;
  /** Boot the same board again from its text. The next packet is a keyframe. */
  restart(): void;
  tick(): number;
  endTick(): number;
  /** The state hash at the current tick, as 64 hex characters. */
  tickHash(): string;
  destroy(): void;
}

/** A loaded module, which can run any number of boards. */
export interface PlayerModule {
  /** Load a board from its file text. A board the player refuses throws {@link PlayerError}. */
  createBoard(text: string): BoardPlayer;
}

/**
 * The raw exports. Rust's `u32` crosses as a signed JavaScript number and its `u64` as a signed
 * BigInt, so every read below converts them back.
 */
export interface PlayerExports {
  memory: WebAssembly.Memory;
  fp_alloc(len: number): number;
  fp_free(ptr: number, len: number): void;
  fp_create(ptr: number, len: number): number;
  fp_destroy(handle: number): number;
  fp_step(handle: number, ticks: number): number;
  fp_take_packet(handle: number): number;
  fp_take_effects(handle: number): number;
  fp_restart(handle: number): number;
  fp_tick(handle: number): bigint;
  fp_end_tick(handle: number): bigint;
  fp_tick_hash(handle: number): number;
  fp_out_ptr(): number;
  fp_out_len(): number;
}

const EXPORT_NAMES: readonly (keyof PlayerExports)[] = [
  'memory',
  'fp_alloc',
  'fp_free',
  'fp_create',
  'fp_destroy',
  'fp_step',
  'fp_take_packet',
  'fp_take_effects',
  'fp_restart',
  'fp_tick',
  'fp_end_tick',
  'fp_tick_hash',
  'fp_out_ptr',
  'fp_out_len',
];

/** Throw unless the module imports exactly the clock and nothing else. */
function assertOnlyTheClockImport(descriptors: readonly WebAssembly.ModuleImportDescriptor[]): void {
  const named = descriptors.map((d) => `${d.module}.${d.name} (${d.kind})`);
  const [only] = descriptors;
  const isTheClock =
    descriptors.length === 1 &&
    only.module === CLOCK_MODULE &&
    only.name === CLOCK_NAME &&
    only.kind === 'function';
  if (!isTheClock) {
    throw new PlayerError(
      `the player must import only ${CLOCK_MODULE}.${CLOCK_NAME}, and this module imports: ${
        named.join(', ') || 'nothing'
      }`,
    );
  }
}

/** The same exports, each marking the whole module as trapped when a call traps. */
function guardExports(raw: PlayerExports): PlayerExports {
  let trap: { cause: unknown } | null = null;
  const guard = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => {
    if (trap !== null) throw new PlayerTrapped(trap.cause);
    try {
      return call(...args);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError || error instanceof RangeError) {
        trap = { cause: error };
        throw new PlayerTrapped(error);
      }
      throw error;
    }
  };
  return {
    memory: raw.memory,
    fp_alloc: guard(raw.fp_alloc),
    fp_free: guard(raw.fp_free),
    fp_create: guard(raw.fp_create),
    fp_destroy: guard(raw.fp_destroy),
    fp_step: guard(raw.fp_step),
    fp_take_packet: guard(raw.fp_take_packet),
    fp_take_effects: guard(raw.fp_take_effects),
    fp_restart: guard(raw.fp_restart),
    fp_tick: guard(raw.fp_tick),
    fp_end_tick: guard(raw.fp_end_tick),
    fp_tick_hash: guard(raw.fp_tick_hash),
    fp_out_ptr: guard(raw.fp_out_ptr),
    fp_out_len: guard(raw.fp_out_len),
  };
}

/** Build the module API over a set of exports. */
export function playerModuleFrom(rawExports: PlayerExports): PlayerModule {
  const exports = guardExports(rawExports);
  const readOut = (len: number): Uint8Array => {
    const ptr = exports.fp_out_ptr() >>> 0;
    return new Uint8Array(exports.memory.buffer, ptr, len).slice();
  };
  const outText = (): string => {
    const len = exports.fp_out_len() >>> 0;
    return len === 0 ? '' : new TextDecoder().decode(readOut(len));
  };
  const checkStatus = (status: number): void => {
    if (status >>> 0 !== FP_OK) throw new PlayerError(outText());
  };
  const safeNumber = (raw: bigint): number => {
    const value = BigInt.asUintN(64, raw);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PlayerError(outText() || `${value} doesn't fit a JavaScript number exactly`);
    }
    return Number(value);
  };

  return {
    createBoard(text) {
      const bytes = new TextEncoder().encode(text);
      const ptr = exports.fp_alloc(bytes.length) >>> 0;
      if (ptr === 0 && bytes.length > 0) {
        throw new PlayerError(`the player has no memory for ${bytes.length} bytes of board text`);
      }
      let handle: number;
      try {
        if (bytes.length > 0) new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
        handle = exports.fp_create(ptr, bytes.length) >>> 0;
        if (handle === 0) throw new PlayerError(outText());
      } finally {
        exports.fp_free(ptr, bytes.length);
      }

      return {
        step(ticks) {
          if (!Number.isInteger(ticks) || ticks < 0 || ticks > 0xffffffff) {
            throw new PlayerError(`step takes a whole number of ticks up to 2^32-1, not ${ticks}`);
          }
          checkStatus(exports.fp_step(handle, ticks));
        },
        takePacket() {
          const len = exports.fp_take_packet(handle) >>> 0;
          if (len === 0) {
            const error = outText();
            if (error !== '') throw new PlayerError(error);
            return null;
          }
          return readOut(len);
        },
        takeEffects() {
          const len = exports.fp_take_effects(handle) >>> 0;
          if (len === 0) throw new PlayerError(outText());
          return readOut(len);
        },
        restart() {
          checkStatus(exports.fp_restart(handle));
        },
        tick: () => safeNumber(exports.fp_tick(handle)),
        endTick: () => safeNumber(exports.fp_end_tick(handle)),
        tickHash() {
          const len = exports.fp_tick_hash(handle) >>> 0;
          if (len === 0) throw new PlayerError(outText());
          return new TextDecoder().decode(readOut(len));
        },
        destroy() {
          checkStatus(exports.fp_destroy(handle));
        },
      };
    },
  };
}

/** Compile and instantiate the player from its bytes, refusing a module with any other import. */
export async function loadPlayerModule(bytes: BufferSource): Promise<PlayerModule> {
  const module = await WebAssembly.compile(bytes);
  assertOnlyTheClockImport(WebAssembly.Module.imports(module));
  const instance = await WebAssembly.instantiate(module, {
    [CLOCK_MODULE]: { [CLOCK_NAME]: () => 0 },
  });
  const missing = EXPORT_NAMES.filter((name) => !(name in instance.exports));
  if (missing.length > 0) {
    throw new PlayerError(`this module has no ${missing.join(', ')}`);
  }
  return playerModuleFrom(instance.exports as unknown as PlayerExports);
}
