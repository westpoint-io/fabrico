/**
 * Anything that hands render-packet bytes to a renderer, and nothing else.
 *
 * The app's transports send gestures and control frames too; a read-only board on a page
 * only receives. Code that only draws takes this narrow shape, so it has no method that could
 * send anything back to an engine.
 */
export interface IPacketSource {
  /** Register the callback that receives each render-packet's bytes, in order. */
  onPacket(cb: (bytes: Uint8Array) => void): void;
}
