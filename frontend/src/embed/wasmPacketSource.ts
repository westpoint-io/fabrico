// The packet source for one board on a page: the bytes come from that board's own player
// instance, and nothing goes back. It has no method that sends anything, by design.

import type { BoardPlayer } from '../player/playerWasm';
import type { IPacketSource } from '../transport/packetSource';

export interface WasmPacketSource extends IPacketSource {
  /** Hand every packet the player has queued to the callback, in order. Returns how many. */
  drain(): number;
}

export function createWasmPacketSource(player: BoardPlayer): WasmPacketSource {
  let onPacketCb: ((bytes: Uint8Array) => void) | null = null;
  return {
    onPacket(cb: (bytes: Uint8Array) => void): void {
      onPacketCb = cb;
    },
    drain(): number {
      let n = 0;
      for (let bytes = player.takePacket(); bytes !== null; bytes = player.takePacket()) {
        n += 1;
        onPacketCb?.(bytes);
      }
      return n;
    },
  };
}
