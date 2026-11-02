import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { type RenderPacket, decodeRenderPacket } from '../src/protocol/decode.ts';
import { applyPacket, createSceneState } from '../src/render/sceneState.ts';
import { loadPlayerModule } from '../src/player/playerWasm.ts';

// The whole route for one board: its data file goes into the engine in wasm, and the packets come
// out through the app's own decoder. A missing build is a red and never a skip, because a skipped
// spec here would read as the route working.
const BOARD_PATH = 'examples/boards/demo_scene.board.ron';

const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

/** The demo line of the manifest the native engine wrote. */
function manifestLine(path: string): { endTick: number; hash: string } {
  const line = repoFile('examples/boards/hashes.manifest')
    .split('\n')
    .find((candidate) => candidate.startsWith(`${path} `));
  if (line === undefined) throw new Error(`hashes.manifest has no line for ${path}`);
  const [, endTick, hash] = line.split(' ');
  return { endTick: Number(endTick), hash };
}

describe('the demo board in wasm under Node', () => {
  let packets: RenderPacket[];
  let endTick: number;
  let tick: number;
  let hash: string;

  beforeAll(async () => {
    const wasmPath = process.env.FABRICO_PLAYER_WASM;
    if (wasmPath === undefined || !existsSync(wasmPath)) {
      throw new Error(
        `FABRICO_PLAYER_WASM is ${wasmPath ?? 'unset'}. Build the player and run this through scripts/check-wasm-player.sh.`,
      );
    }
    const player = await loadPlayerModule(new Uint8Array(readFileSync(wasmPath)));
    const board = player.createBoard(repoFile(BOARD_PATH));
    endTick = board.endTick();

    packets = [];
    const drain = () => {
      for (let bytes = board.takePacket(); bytes !== null; bytes = board.takePacket()) {
        packets.push(decodeRenderPacket(bytes));
      }
    };
    drain();
    while (board.tick() < endTick) {
      board.step(1);
      drain();
    }
    tick = board.tick();
    hash = board.tickHash();
    board.destroy();
  });

  it('ends on the tick and the whole hash in the manifest', () => {
    const expected = manifestLine(BOARD_PATH);
    expect(hash).toHaveLength(64);
    expect(endTick).toBe(expected.endTick);
    expect(tick).toBe(expected.endTick);
    expect(hash).toBe(expected.hash);
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
