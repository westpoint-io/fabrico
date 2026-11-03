// The one path a render packet takes from bytes to the scene: decode, drop a stale diff, count,
// apply. The app and the read-only board both call it, so the two can't drift on the order of
// those steps or on what happens to a bad frame.
//
// The order is the app's packet handler's order. A diff older than the scene is dropped before it
// is counted and before any hook sees it. A decoded packet is counted before the hooks run, so the
// counter reads as decode outcomes, not as hook health. A `DecodeError` is counted and dropped
// with no console output (the decoder is bounds-checked, and a malformed frame is not a renderer
// fault). Any other error is a real fault in a hook or in `applyPacket`, so it goes to
// `console.error`. Nothing is rethrown, because the caller is a transport callback and a throw
// there would stop every later packet.

import { DecodeError, decodeRenderPacket, type RenderPacket } from '../protocol/decode';
import { applyPacket, isStaleDiff, type SceneState } from './sceneState';

/**
 * Work a caller does around `applyPacket`. `beforeApply` sees the scene as it was before this
 * packet; whatever it returns is handed to `afterApply`, which sees the scene after.
 */
export interface PacketPipelineHooks<C = unknown> {
  beforeApply?(packet: RenderPacket, scene: SceneState): C;
  afterApply?(packet: RenderPacket, scene: SceneState, ctx: C): void;
}

/** The pipeline's two counters, as a fresh plain object per read. */
export interface PacketPipelineStats {
  packetsApplied: number;
  decodeErrors: number;
}

export interface PacketPipeline {
  /** Run one packet's bytes through decode, the stale check and apply. Never throws. */
  handle(bytes: Uint8Array): void;
  stats(): PacketPipelineStats;
}

/**
 * Build a pipeline over the scene `getScene` returns. `getScene` is read once per packet, so a
 * caller that swaps its scene object is picked up on the next packet.
 */
export function createPacketPipeline<C = undefined>(
  getScene: () => SceneState,
  hooks: PacketPipelineHooks<C> = {},
): PacketPipeline {
  let packetsApplied = 0;
  let decodeErrors = 0;
  return {
    handle(bytes: Uint8Array): void {
      try {
        const packet = decodeRenderPacket(bytes);
        const scene = getScene();
        if (isStaleDiff(scene, packet)) return;
        packetsApplied += 1;
        const ctx = hooks.beforeApply ? hooks.beforeApply(packet, scene) : (undefined as C);
        applyPacket(scene, packet);
        hooks.afterApply?.(packet, scene, ctx);
      } catch (e) {
        if (e instanceof DecodeError) {
          decodeErrors += 1;
        } else {
          console.error('packet handler failed', e);
        }
      }
    },
    stats: (): PacketPipelineStats => ({ packetsApplied, decodeErrors }),
  };
}
