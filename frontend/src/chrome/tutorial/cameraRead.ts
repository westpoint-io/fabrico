// cameraRead.ts - the tutorial's one camera read and its one camera write, so a change to how the
// camera is exposed is a change here. The write is Show me's: it moves the view and nothing else, and
// the purity gate keeps `setCamera` out of every other tutorial file.

import type { SceneHandle } from '../../render/pixiApp';

export function readCamera(): { x: number; y: number; scale: number } | null {
  return window.__fabrico?.camera() ?? null;
}

/** Set the camera in one call, with no animation. It sends nothing to the host. A null handle does nothing. */
export function moveCamera(handle: SceneHandle | null, to: { x: number; y: number; scale: number }): void {
  if (handle === null) return;
  handle.cam.setCamera(to.scale, to.x, to.y);
}
