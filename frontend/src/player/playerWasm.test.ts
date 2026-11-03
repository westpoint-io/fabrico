import { describe, expect, it } from 'vitest';
import {
  type PlayerExports,
  PlayerError,
  PlayerTrapped,
  decodeBoardInfo,
  decodePlayerEffects,
  loadPlayerModule,
  playerModuleFrom,
} from './playerWasm.ts';

// The loader's own logic, on stub exports with no player build. The spec that runs the real module
// is in `player-tests/`.

const OUT_AT = 1024;

/** Stub exports over a real memory, where `setOut` plays the part of the player's out buffer. */
function stub(overrides: (setOut: (text: string) => number) => Partial<PlayerExports> = () => ({})): PlayerExports {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let outLen = 0;
  const setOut = (text: string): number => {
    const bytes = new TextEncoder().encode(text);
    new Uint8Array(memory.buffer, OUT_AT, bytes.length).set(bytes);
    outLen = bytes.length;
    return bytes.length;
  };
  return {
    memory,
    fp_alloc: () => 16,
    fp_free: () => {},
    fp_create: () => 1,
    fp_destroy: () => 0,
    fp_step: () => 0,
    fp_take_packet: () => {
      outLen = 0;
      return 0;
    },
    fp_take_effects: () => setOut('\0'),
    fp_restart: () => 0,
    fp_tick: () => 0n,
    fp_end_tick: () => 0n,
    fp_tick_hash: () => setOut('ab'),
    fp_board_info: () => setOut('\0\0\0\0\0'),
    fp_out_ptr: () => OUT_AT,
    fp_out_len: () => outLen,
    ...overrides(setOut),
  };
}

/** A module holding only imports, encoded by hand, so the check runs on a real compiled module. */
function moduleImporting(imports: readonly [string, string][]): Uint8Array<ArrayBuffer> {
  const name = (text: string): number[] => {
    const bytes = [...new TextEncoder().encode(text)];
    return [bytes.length, ...bytes];
  };
  const section = (id: number, body: number[]): number[] => [id, body.length, ...body];
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  // One function type, () -> i32.
  const types = section(1, [1, 0x60, 0, 1, 0x7f]);
  const importBody = [imports.length];
  for (const [module, field] of imports) importBody.push(...name(module), ...name(field), 0x00, 0);
  return new Uint8Array([...header, ...types, ...(imports.length > 0 ? section(2, importBody) : [])]);
}

describe('a trapped instance', () => {
  for (const [label, trap] of [
    ['RangeError', () => new RangeError('Maximum call stack size exceeded')],
    ['WebAssembly.RuntimeError', () => new WebAssembly.RuntimeError('unreachable')],
  ] as const) {
    it(`raises PlayerTrapped on a ${label}, and refuses every later call`, () => {
      const module = playerModuleFrom(
        stub(() => ({
          fp_step: () => {
            throw trap();
          },
        })),
      );
      const board = module.createBoard('board');

      expect(() => board.step(1)).toThrow(PlayerTrapped);
      expect(() => board.tick()).toThrow(PlayerTrapped);
      expect(() => board.takePacket()).toThrow(PlayerTrapped);
      expect(() => board.takeEffects()).toThrow(PlayerTrapped);
      expect(() => board.restart()).toThrow(PlayerTrapped);
      expect(() => board.tickHash()).toThrow(PlayerTrapped);
      expect(() => board.destroy()).toThrow(PlayerTrapped);
      expect(() => module.createBoard('another board')).toThrow(PlayerTrapped);
    });
  }

  it('leaves another kind of error alone, so a bug in a caller is not called a trap', () => {
    let calls = 0;
    const board = playerModuleFrom(
      stub(() => ({
        fp_step: () => {
          calls += 1;
          if (calls === 1) throw new TypeError('a stub bug');
          return 0;
        },
      })),
    ).createBoard('board');

    expect(() => board.step(1)).toThrow(TypeError);
    expect(() => board.step(1)).not.toThrow();
  });
});

describe('the import check', () => {
  const clock: [string, string] = ['env', '__rquickjs_host_now_us'];

  it('passes the check with only the clock, and gets as far as the missing exports', async () => {
    await expect(loadPlayerModule(moduleImporting([clock]))).rejects.toThrow(/has no memory/);
  });

  it('refuses a second import, naming it', async () => {
    await expect(loadPlayerModule(moduleImporting([clock, ['env', 'fetch']]))).rejects.toThrow(/env\.fetch/);
  });

  it('refuses one import that is not the clock, naming it', async () => {
    await expect(loadPlayerModule(moduleImporting([['wasi', 'clock_time_get']]))).rejects.toThrow(
      /wasi\.clock_time_get/,
    );
  });

  it('refuses a module with no imports', async () => {
    await expect(loadPlayerModule(moduleImporting([]))).rejects.toThrow(/imports: nothing/);
  });
});

describe('ticks', () => {
  it('throws on a u64 above Number.MAX_SAFE_INTEGER rather than losing precision', () => {
    const board = playerModuleFrom(
      stub(() => ({ fp_tick: () => BigInt(Number.MAX_SAFE_INTEGER) + 1n })),
    ).createBoard('board');
    expect(() => board.tick()).toThrow(PlayerError);
  });

  it('returns Number.MAX_SAFE_INTEGER exactly', () => {
    const board = playerModuleFrom(
      stub(() => ({ fp_end_tick: () => BigInt(Number.MAX_SAFE_INTEGER) })),
    ).createBoard('board');
    expect(board.endTick()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reads a u64 with the top bit set as unsigned, and reports the error text beside it', () => {
    // A BigInt from wasm is signed, so u64::MAX arrives as -1.
    const board = playerModuleFrom(
      stub((setOut) => ({
        fp_tick: () => {
          setOut('no player has handle 1');
          return -1n;
        },
      })),
    ).createBoard('board');
    expect(() => board.tick()).toThrow('no player has handle 1');
  });
});

describe('statuses', () => {
  it('throws PlayerError carrying the out text on a non-zero status', () => {
    const board = playerModuleFrom(
      stub((setOut) => ({
        fp_step: () => {
          setOut('the board stopped');
          return 1;
        },
      })),
    ).createBoard('board');

    expect(() => board.step(1)).toThrow(PlayerError);
    expect(() => board.step(1)).toThrow('the board stopped');
  });

  it('throws PlayerError carrying the out text when a board is refused', () => {
    const module = playerModuleFrom(
      stub((setOut) => ({
        fp_create: () => {
          setOut('the board file failed to parse');
          return 0;
        },
      })),
    );
    expect(() => module.createBoard('board')).toThrow('the board file failed to parse');
  });

  it('frees the board text whether the board loaded or not', () => {
    const freed: [number, number][] = [];
    const module = playerModuleFrom(
      stub((setOut) => ({
        fp_free: (ptr, len) => {
          freed.push([ptr, len]);
        },
        fp_create: (_ptr, len) => {
          setOut('refused');
          return len === 2 ? 1 : 0;
        },
      })),
    );
    module.createBoard('ok');
    expect(() => module.createBoard('bad')).toThrow(PlayerError);
    expect(freed).toEqual([
      [16, 2],
      [16, 3],
    ]);
  });

  it('tells a stale handle from an empty queue', () => {
    const empty = playerModuleFrom(stub()).createBoard('board');
    expect(empty.takePacket()).toBeNull();

    const stale = playerModuleFrom(
      stub((setOut) => ({
        fp_take_packet: () => {
          setOut('no player has handle 1');
          return 0;
        },
      })),
    ).createBoard('board');
    expect(() => stale.takePacket()).toThrow('no player has handle 1');
  });

  it('refuses a tick count that is not a whole u32', () => {
    const board = playerModuleFrom(stub()).createBoard('board');
    for (const ticks of [-1, 1.5, 2 ** 32, Number.NaN]) {
      expect(() => board.step(ticks)).toThrow(PlayerError);
    }
    expect(() => board.step(2 ** 32 - 1)).not.toThrow();
  });
});

describe('board info', () => {
  const text = (value: string): number[] => {
    const bytes = [...new TextEncoder().encode(value)];
    return [bytes.length, ...bytes];
  };

  it('decodes the title, the captions with and without a render handle, the factories and the flag', () => {
    const bytes = new Uint8Array([
      ...text('T'),
      0xb0, 0x09, // end tick 1200
      2, // two captions
      88, 1, 1, 40, ...text('a'), // tick 88, handle 1, Some(40)
      253, 1, 5, 0, ...text('b'), // tick 253 (two varint bytes), handle 5, None
      2, // two factories
      41, 2, ...text('f'),
      42, 10, ...text('h'),
      1, // calls out
    ]);
    expect(decodeBoardInfo(bytes)).toEqual({
      title: 'T',
      endTick: 1200,
      captions: [
        { tick: 88, highlight: 1, renderHandle: 40, text: 'a' },
        { tick: 253, highlight: 5, renderHandle: null, text: 'b' },
      ],
      factories: [
        { renderHandle: 41, kind: 2, source: 'f' },
        { renderHandle: 42, kind: 10, source: 'h' },
      ],
      callsOut: true,
    });
  });

  it('refuses a bad option tag, a bad flag byte and bytes left over', () => {
    expect(() => decodeBoardInfo(new Uint8Array([0, 0, 1, 1, 0, 2]))).toThrow(/option tag 2/);
    expect(() => decodeBoardInfo(new Uint8Array([0, 0, 0, 0, 2]))).toThrow(/calls_out byte 2/);
    expect(() => decodeBoardInfo(new Uint8Array([0, 0, 0, 0, 0, 9]))).toThrow(/1 bytes left over/);
  });

  it('throws the out text when fp_board_info returns 0', () => {
    const board = playerModuleFrom(
      stub((setOut) => ({
        fp_board_info: () => {
          setOut('no player has handle 1');
          return 0;
        },
      })),
    ).createBoard('board');
    expect(() => board.boardInfo()).toThrow('no player has handle 1');
  });
});

describe('effects', () => {
  it('throws the out text when fp_take_effects returns 0, because an empty list is one byte', () => {
    const board = playerModuleFrom(
      stub((setOut) => ({
        fp_take_effects: () => {
          setOut('no player has handle 1');
          return 0;
        },
      })),
    ).createBoard('board');
    expect(() => board.takeEffects()).toThrow('no player has handle 1');
  });

  it('throws the out text when a restart returns a status', () => {
    const board = playerModuleFrom(
      stub((setOut) => ({
        fp_restart: () => {
          setOut('a command was refused');
          return 1;
        },
      })),
    ).createBoard('board');
    expect(() => board.restart()).toThrow('a command was refused');
  });

  it('decodes an empty list', () => {
    expect(decodePlayerEffects(new Uint8Array([0]))).toEqual([]);
  });

  it('decodes each kind and each outcome in the order the Rust types declare them', () => {
    const url = [...new TextEncoder().encode('u')];
    const bytes = new Uint8Array([
      4,
      // tick 300 as a varint, Http, the url, Put, a 1-byte body, Reply after 40.
      0xac, 0x02, 0, url.length, ...url, 2, 1, 9, 0, 40,
      // tick 2, Debug with a 1-byte message, Error after 3.
      2, 1, 1, 8, 1, 3,
      // tick 3, Noop, Timeout.
      3, 2, 2,
      // tick 4, Reply to correlation 5 with a 1-byte payload, Reply after 1.
      4, 3, 5, 1, 7, 0, 1,
    ]);
    expect(decodePlayerEffects(bytes)).toEqual([
      {
        tick: 300,
        effect: { kind: 'Http', url: 'u', method: 'Put', body: new Uint8Array([9]) },
        answer: { outcome: 'Reply', afterTicks: 40 },
      },
      { tick: 2, effect: { kind: 'Debug', message: new Uint8Array([8]) }, answer: { outcome: 'Error', afterTicks: 3 } },
      { tick: 3, effect: { kind: 'Noop' }, answer: { outcome: 'Timeout' } },
      {
        tick: 4,
        effect: { kind: 'Reply', correlation: 5, payload: new Uint8Array([7]) },
        answer: { outcome: 'Reply', afterTicks: 1 },
      },
    ]);
  });

  it('refuses an unknown kind, an unknown verb and bytes left over', () => {
    expect(() => decodePlayerEffects(new Uint8Array([1, 1, 9]))).toThrow(/PlayerEffectKind discriminant 9/);
    expect(() => decodePlayerEffects(new Uint8Array([1, 1, 0, 0, 9]))).toThrow(/HttpMethod discriminant 9/);
    expect(() => decodePlayerEffects(new Uint8Array([0, 0]))).toThrow(/left over/);
  });
});

describe('memory', () => {
  // A memory grow detaches the old buffer, and building a view on a detached buffer throws, so a
  // loader that kept a view from before the call fails both of these.
  it('reads the out buffer through a fresh view after a call grows the memory', () => {
    const exports = stub((setOut) => ({
      fp_tick_hash: () => {
        exports.memory.grow(1);
        return setOut('hash after a grow');
      },
    }));
    const board = playerModuleFrom(exports).createBoard('board');

    expect(board.tickHash()).toBe('hash after a grow');
    expect(exports.memory.buffer.byteLength).toBe(2 * 65536);
  });

  it('writes the board text through a fresh view after the allocation grows the memory', () => {
    let received = '';
    const exports = stub(() => ({
      fp_alloc: () => {
        exports.memory.grow(1);
        return 16;
      },
      fp_create: (ptr, len) => {
        received = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));
        return 1;
      },
    }));
    playerModuleFrom(exports).createBoard('the board text');

    expect(received).toBe('the board text');
  });

  it('copies a packet, so a later call cannot change what a caller holds', () => {
    let writeOut: (text: string) => number = () => 0;
    const board = playerModuleFrom(
      stub((setOut) => {
        writeOut = setOut;
        return { fp_take_packet: () => setOut('first') };
      }),
    ).createBoard('board');

    const packet = board.takePacket();
    writeOut('other');
    expect(new TextDecoder().decode(packet as Uint8Array)).toBe('first');
  });
});
