// The script of `player-test.html`. It runs one board through the WebAssembly player, from the two
// files the Chromium spec serves, and decodes each packet with the app's own decoder. It lives in
// `src/spike/` so the build guard fails if the app ever imports it.

import { loadPlayerModule } from '../player/playerWasm.ts';
import { decodeRenderPacket } from '../protocol/decode.ts';

export type PlayerResult =
  | {
      endTick: number;
      hash: string;
      packets: number;
      placed: number;
      belts: number;
      sawItem: boolean;
    }
  | { error: string };

declare global {
  interface Window {
    /** Set once, when the run ends or fails, so a failure reports its message and doesn't time out. */
    __playerResult?: PlayerResult;
  }
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

async function runBoard(): Promise<PlayerResult> {
  const [wasm, text] = await Promise.all([
    fetchOk('/__fabrico_player/fabrico_player.wasm').then((response) => response.arrayBuffer()),
    fetchOk('/__fabrico_player/board.ron').then((response) => response.text()),
  ]);
  const module = await loadPlayerModule(wasm);
  const board = module.createBoard(text);

  let packets = 0;
  let placed = 0;
  let belts = 0;
  let sawItem = false;
  const drain = (): void => {
    for (let bytes = board.takePacket(); bytes !== null; bytes = board.takePacket()) {
      const packet = decodeRenderPacket(bytes);
      if (packets === 0) {
        placed = packet.placed.length;
        belts = packet.belts.length;
      }
      packets += 1;
      sawItem ||= packet.belts.some((belt) => belt.items.length > 0);
    }
  };

  drain();
  while (board.tick() < board.endTick()) {
    board.step(1);
    drain();
  }
  const result = { endTick: board.tick(), hash: board.tickHash(), packets, placed, belts, sawItem };
  board.destroy();
  return result;
}

try {
  window.__playerResult = await runBoard();
} catch (error) {
  window.__playerResult = { error: error instanceof Error ? error.message : String(error) };
}
