// cameraRead.ts - the one place the tutorial reads the camera, so a change to how the camera is
// exposed is a one-line change here.

export function readCamera(): { x: number; y: number; scale: number } | null {
  return window.__fabrico?.camera() ?? null;
}
