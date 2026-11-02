import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { type RenderPacket, decodeRenderPacket } from '../src/protocol/decode.ts';
import { applyPacket, createSceneState } from '../src/render/sceneState.ts';
import {
  type BoardPlayer,
  type PlayerEffect,
  type PlayerModule,
  PlayerError,
  decodePlayerEffects,
  loadPlayerModule,
} from '../src/player/playerWasm.ts';

// The whole route for each board: its data file goes into the engine in wasm, and the packets come
// out through the app's own decoder and are compared with a native run at this same revision. A
// missing build or dump is a red and never a skip, because a skipped spec here would read as the
// route working.
const BOARDS_DIR = 'examples/boards';
const DEMO = `${BOARDS_DIR}/demo_scene.board.ron`;
const ORDER = `${BOARDS_DIR}/order_processing.board.ron`;
const OUTCOMES = `${BOARDS_DIR}/docs/script-outcomes.board.ron`;

/** The walk has to find at least this many, so an emptied folder can't pass. */
const BOARD_FLOOR = 4;
/** A whole board at one tick per call, hashed and compared at each tick. */
const BOARD_TIMEOUT_MS = 120_000;

const repoPath = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const repoFile = (path: string): string => readFileSync(repoPath(path), 'utf8');

/** Every `*.board.ron` under the boards folder at any depth, the same rule the manifest test uses. */
function walkBoards(relative: string = BOARDS_DIR): string[] {
  return readdirSync(repoPath(relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) return walkBoards(child);
      return entry.name.endsWith('.board.ron') ? [child] : [];
    })
    .sort();
}

/** The manifest the native engine wrote, as board path to its end tick and hash. */
function readManifest(): Map<string, { endTick: number; hash: string }> {
  const lines = repoFile(`${BOARDS_DIR}/hashes.manifest`)
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'));
  return new Map(
    lines.map((line) => {
      const [path, endTick, hash] = line.split(' ');
      return [path, { endTick: Number(endTick), hash }];
    }),
  );
}

function manifestLine(path: string): { endTick: number; hash: string } {
  const line = readManifest().get(path);
  if (line === undefined) throw new Error(`hashes.manifest has no line for ${path}`);
  return line;
}

function wasmBytes(): Uint8Array<ArrayBuffer> {
  const wasmPath = process.env.FABRICO_PLAYER_WASM;
  if (wasmPath === undefined || !existsSync(wasmPath)) {
    throw new Error(
      `FABRICO_PLAYER_WASM is ${wasmPath ?? 'unset'}. Build the player and run this through scripts/check-wasm-player.sh.`,
    );
  }
  return new Uint8Array(readFileSync(wasmPath));
}

const loadFresh = (): Promise<PlayerModule> => loadPlayerModule(wasmBytes());

function nativeDumpDir(): string {
  const dumpDir = process.env.FABRICO_PLAYER_NATIVE_DUMP;
  if (dumpDir === undefined || !existsSync(dumpDir)) {
    throw new Error(
      `FABRICO_PLAYER_NATIVE_DUMP is ${dumpDir ?? 'unset'}. Build the player and run this through scripts/check-wasm-player.sh.`,
    );
  }
  return dumpDir;
}

/** Split a dump file made of records, each prefixed with its length as a little-endian u32. */
function readRecords(file: string): Uint8Array[] {
  const bytes = new Uint8Array(readFileSync(file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const len = view.getUint32(at, true);
    records.push(bytes.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  return records;
}

interface NativeDump {
  packets: Uint8Array[];
  effects: Uint8Array[];
  hashes: { tick: number; hash: string }[];
}

function readNativeDump(board: string): NativeDump {
  const stem = `${nativeDumpDir()}/${board.replaceAll('/', '_')}`;
  const hashes = readFileSync(`${stem}.hashes`, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [tick, hash] = line.split(' ');
      return { tick: Number(tick), hash };
    });
  return { packets: readRecords(`${stem}.packets`), effects: readRecords(`${stem}.effects`), hashes };
}

/** The first place two byte strings differ, in words, or null when they're equal. */
function byteDifference(wasm: Uint8Array, native: Uint8Array): string | null {
  if (wasm.length !== native.length) {
    return `is ${wasm.length} bytes in wasm and ${native.length} in native`;
  }
  for (let i = 0; i < wasm.length; i++) {
    if (wasm[i] !== native[i]) return `differs at byte ${i}: ${wasm[i]} in wasm, ${native[i]} in native`;
  }
  return null;
}

/** Fail naming the board and the tick, because a bare byte comparison says neither. */
function expectSameBytes(what: string, board: string, tick: number, wasm: Uint8Array, native: Uint8Array): void {
  const difference = byteDifference(wasm, native);
  if (difference !== null) expect.fail(`${board} at tick ${tick}: the ${what} ${difference}`);
}

function drainPackets(board: BoardPlayer): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let bytes = board.takePacket(); bytes !== null; bytes = board.takePacket()) packets.push(bytes);
  return packets;
}

function runToEnd(board: BoardPlayer): void {
  board.step(board.endTick());
  drainPackets(board);
}

/**
 * Compare one player with the native dump from record `from` to the end, a tick at a time. The
 * player has to be at that record, with its packet queued and its effects not taken yet.
 */
function expectMatchesNative(path: string, board: BoardPlayer, native: NativeDump, from: number): void {
  for (let record = from; ; record++) {
    const tick = board.tick();
    const expected = native.hashes[record];
    if (expected === undefined) expect.fail(`${path} at tick ${tick}: the native dump ends at record ${record - 1}`);
    if (tick !== expected.tick) expect.fail(`${path}: wasm is at tick ${tick} and native at tick ${expected.tick}`);

    const queued = drainPackets(board);
    if (queued.length !== 1) expect.fail(`${path} at tick ${tick}: wasm queued ${queued.length} packets, not 1`);
    expectSameBytes('packet', path, tick, queued[0], native.packets[record]);
    expectSameBytes('effect list', path, tick, board.takeEffects(), native.effects[record]);
    const hash = board.tickHash();
    if (hash !== expected.hash) {
      expect.fail(`${path} at tick ${tick}: the hash is ${hash} in wasm and ${expected.hash} in native`);
    }

    if (tick >= board.endTick()) {
      if (record !== native.hashes.length - 1) {
        expect.fail(`${path} at tick ${tick}: wasm ended at record ${record} of ${native.hashes.length - 1}`);
      }
      return;
    }
    board.step(1);
  }
}

describe('the walk of the boards folder', () => {
  it(`finds at least ${BOARD_FLOOR} boards`, () => {
    expect(walkBoards().length).toBeGreaterThanOrEqual(BOARD_FLOOR);
  });

  it('gives each board a manifest line, and each manifest line a board', () => {
    expect(walkBoards()).toEqual([...readManifest().keys()].sort());
  });

  it('gives each board 3 native dump files, and leaves no others in the dump', () => {
    const expected = walkBoards()
      .flatMap((board) => {
        const stem = board.replaceAll('/', '_');
        return [`${stem}.effects`, `${stem}.hashes`, `${stem}.packets`];
      })
      .sort();
    expect(readdirSync(nativeDumpDir()).sort()).toEqual(expected);
  });
});

describe.each(walkBoards())('%s in wasm under Node', (path) => {
  let module: PlayerModule;

  beforeAll(async () => {
    module = await loadFresh();
  });

  it(
    'emits the same packets, effects and hash as the native build at each tick',
    () => {
      const native = readNativeDump(path);
      const board = module.createBoard(repoFile(path));
      expectMatchesNative(path, board, native, 0);
      board.destroy();
    },
    BOARD_TIMEOUT_MS,
  );

  it(
    'ends on the tick and the whole hash in the manifest',
    () => {
      const expected = manifestLine(path);
      const board = module.createBoard(repoFile(path));
      expect(board.endTick(), `${path}: the end tick in the board file`).toBe(expected.endTick);
      runToEnd(board);
      expect(board.tick(), `${path}: the tick the run stopped at`).toBe(expected.endTick);
      expect(board.tickHash(), `${path} at tick ${expected.endTick}: the end hash`).toBe(expected.hash);
      board.destroy();
    },
    BOARD_TIMEOUT_MS,
  );

  it(
    'decodes each packet through the app decoder',
    () => {
      const board = module.createBoard(repoFile(path));
      board.step(board.endTick());
      const decoded = drainPackets(board).map((bytes, index) => {
        try {
          return decodeRenderPacket(bytes);
        } catch (error) {
          throw new Error(`${path}: packet ${index} doesn't decode: ${String(error)}`, { cause: error });
        }
      });
      expect(decoded[0].full, `${path}: the first packet is a keyframe`).toBe(true);
      expect(decoded[decoded.length - 1].tick, `${path}: the last packet's tick`).toBe(board.endTick());
      board.destroy();
    },
    BOARD_TIMEOUT_MS,
  );
});

describe('the demo board in wasm under Node', () => {
  let packets: RenderPacket[];
  let endTick: number;

  beforeAll(async () => {
    const player = await loadFresh();
    const board = player.createBoard(repoFile(DEMO));
    endTick = board.endTick();

    packets = [];
    const drain = () => {
      for (const bytes of drainPackets(board)) packets.push(decodeRenderPacket(bytes));
    };
    drain();
    while (board.tick() < endTick) {
      board.step(1);
      drain();
    }
    board.destroy();
  });

  it('starts with a full packet listing machines and belts', () => {
    const [first] = packets;
    expect(first.full).toBe(true);
    expect(first.placed.length).toBeGreaterThan(0);
    expect(first.belts.length).toBeGreaterThan(0);
  });

  it('emits a first diff that does not repeat the whole board', () => {
    const [keyframe, firstDiff] = packets;
    expect(firstDiff.full).toBe(false);
    expect(firstDiff.placed.length).toBeLessThan(keyframe.placed.length);
    expect(firstDiff.belts.length).toBeLessThan(keyframe.belts.length);
  });

  it('emits packets whose ticks rise by one, up to the end tick', () => {
    const ticks = packets.map((packet) => packet.tick);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBe(ticks[i - 1] + 1);
    expect(ticks[ticks.length - 1]).toBe(endTick);
  });

  it('carries an item on a belt during the run', () => {
    expect(packets.some((packet) => packet.belts.some((belt) => belt.items.length > 0))).toBe(true);
  });

  it('folds through the scene code the app renders from', () => {
    const scene = createSceneState();
    for (const packet of packets) applyPacket(scene, packet);
    const [first] = packets;
    expect(scene.tick).toBe(endTick);
    expect(scene.nodes.size).toBe(first.placed.length);
    expect(scene.belts.size).toBe(first.belts.length);
  });
});

describe('the player interface', () => {
  let module: PlayerModule;

  beforeAll(async () => {
    module = await loadFresh();
  });

  it(
    'runs 2 boards stepped in turn on one instance to their own manifest hashes',
    () => {
      const demo = module.createBoard(repoFile(DEMO));
      const order = module.createBoard(repoFile(ORDER));
      while (demo.tick() < demo.endTick() || order.tick() < order.endTick()) {
        demo.step(1);
        order.step(1);
      }
      expect(demo.tickHash(), `${DEMO} at tick ${demo.tick()}`).toBe(manifestLine(DEMO).hash);
      expect(order.tickHash(), `${ORDER} at tick ${order.tick()}`).toBe(manifestLine(ORDER).hash);
      demo.destroy();
      order.destroy();
    },
    BOARD_TIMEOUT_MS,
  );

  it(
    'sends a keyframe after a restart mid-run, then matches an uninterrupted native run',
    () => {
      const native = readNativeDump(DEMO);
      const board = module.createBoard(repoFile(DEMO));
      board.step(300);
      drainPackets(board);
      board.takeEffects();
      board.step(5);

      board.restart();
      const keyframe = board.takePacket();
      if (keyframe === null) expect.fail(`${DEMO}: a restart queued no packet`);
      expect(decodeRenderPacket(keyframe).full, `${DEMO}: the packet after a restart`).toBe(true);
      expectSameBytes('keyframe after a restart', DEMO, board.tick(), keyframe, native.packets[0]);
      expect(board.takePacket(), `${DEMO}: the old run's packets after a restart`).toBeNull();
      expectSameBytes('effect list after a restart', DEMO, board.tick(), board.takeEffects(), native.effects[0]);

      board.step(1);
      expectMatchesNative(DEMO, board, native, 1);
      expect(board.tickHash(), `${DEMO} at tick ${board.tick()}`).toBe(manifestLine(DEMO).hash);
      board.destroy();
    },
    BOARD_TIMEOUT_MS,
  );

  it('queues the same packets for 10 ticks in one call as for 10 one-tick calls', () => {
    const together = module.createBoard(repoFile(DEMO));
    const singly = module.createBoard(repoFile(DEMO));
    // Past the boot, so the 10 ticks hold the items and packets a real run has.
    together.step(100);
    singly.step(100);
    drainPackets(together);
    drainPackets(singly);

    const fromTick = together.tick();
    together.step(10);
    for (let i = 0; i < 10; i++) singly.step(1);
    const one = drainPackets(together);
    const many = drainPackets(singly);

    expect(one.length, `${DEMO} from tick ${fromTick}: packets from one 10-tick call`).toBe(10);
    expect(many.length, `${DEMO} from tick ${fromTick}: packets from 10 one-tick calls`).toBe(10);
    many.forEach((bytes, i) => expectSameBytes('packet', DEMO, fromTick + i + 1, one[i], bytes));
    expect(together.tickHash()).toBe(singly.tickHash());
    together.destroy();
    singly.destroy();
  });

  it(
    'queues no packet and leaves the hash alone when stepped past the end tick',
    () => {
      const board = module.createBoard(repoFile(DEMO));
      runToEnd(board);
      const tick = board.tick();
      const hash = board.tickHash();

      board.step(10);
      expect(board.takePacket(), `${DEMO} past tick ${tick}`).toBeNull();
      expect(board.tick()).toBe(tick);
      expect(board.tickHash()).toBe(hash);
      board.destroy();
    },
    BOARD_TIMEOUT_MS,
  );

  it(
    'refuses a bad board with PlayerError naming the parse failure, and the instance still runs',
    () => {
      expect(() => module.createBoard('not a board')).toThrow(PlayerError);
      expect(() => module.createBoard('not a board')).toThrow(/failed to parse/);

      const board = module.createBoard(repoFile(ORDER));
      runToEnd(board);
      expect(board.tickHash(), `${ORDER} at tick ${board.tick()}`).toBe(manifestLine(ORDER).hash);
      board.destroy();
    },
    BOARD_TIMEOUT_MS,
  );

  it('answers a destroyed handle with a status error rather than a trap', () => {
    const board = module.createBoard(repoFile(DEMO));
    board.destroy();

    const calls: [string, () => unknown][] = [
      ['step', () => board.step(1)],
      ['takePacket', () => board.takePacket()],
      ['takeEffects', () => board.takeEffects()],
      ['restart', () => board.restart()],
      ['tick', () => board.tick()],
      ['endTick', () => board.endTick()],
      ['tickHash', () => board.tickHash()],
      ['destroy', () => board.destroy()],
    ];
    for (const [name, call] of calls) {
      expect(call, name).toThrow(PlayerError);
      expect(call, name).toThrow(/no player has handle/);
    }

    const next = module.createBoard(repoFile(DEMO));
    next.step(1);
    next.destroy();
  });

  it(
    'decodes the script-outcomes board answering /slow, /bad and /lost as its file says',
    () => {
      const board = module.createBoard(repoFile(OUTCOMES));
      const effects: PlayerEffect[] = [...decodePlayerEffects(board.takeEffects())];
      while (board.tick() < board.endTick()) {
        board.step(1);
        effects.push(...decodePlayerEffects(board.takeEffects()));
      }
      board.destroy();

      const answerFor = (url: string) =>
        effects.filter(({ effect }) => effect.kind === 'Http' && effect.url === url).map(({ answer }) => answer);
      expect(answerFor('https://example.com/slow')).toEqual([{ outcome: 'Reply', afterTicks: 40 }]);
      expect(answerFor('https://example.com/bad')).toEqual([{ outcome: 'Error', afterTicks: 3 }]);
      expect(answerFor('https://example.com/lost')).toEqual([{ outcome: 'Timeout' }]);

      const http = effects.find(({ effect }) => effect.kind === 'Http');
      expect(http?.effect).toMatchObject({ method: 'Post' });
      expect(effects.some(({ effect }) => effect.kind === 'Debug')).toBe(true);
      expect(effects.some(({ effect }) => effect.kind === 'Reply')).toBe(true);
    },
    BOARD_TIMEOUT_MS,
  );
});

describe('the shipped module', () => {
  it('has a linear-memory stack larger than its default stack limit', async () => {
    const instance = await WebAssembly.instantiate(await WebAssembly.compile(wasmBytes()), {
      env: { __rquickjs_host_now_us: () => 0 },
    });
    const exports = instance.exports as unknown as {
      __stack_low: WebAssembly.Global;
      __stack_high: WebAssembly.Global;
      fp_stack_limit(): number;
    };
    const stack = Number(exports.__stack_high.value) - Number(exports.__stack_low.value);
    const limit = exports.fp_stack_limit() >>> 0;
    expect(limit).toBeGreaterThan(0);
    expect(stack, `the stack is ${stack} bytes and the limit is ${limit}`).toBeGreaterThan(limit);
  });
});
