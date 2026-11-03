// Does this browser give the board a WebGL renderer?
//
// Pixi 8 doesn't fail without WebGL. Its renderer order is WebGL, WebGPU, then canvas, and with
// WebGL disabled `app.init` succeeds on the canvas renderer, which the board's layers were never
// built for. So the element asks twice. Before booting, `hasWebGL()` asks a throwaway canvas for a
// `webgl2` context, then a `webgl` one. After booting, `isWebGLRenderer(app)` checks the renderer
// Pixi picked. Either check failing shows the board's poster instead of a running board.
//
// The probe runs once per page. Its context is given back at once with `WEBGL_lose_context`, so
// it doesn't sit among the page's live contexts, which the browser caps at 16.

import { RendererType, type Application } from 'pixi.js';

let probed: boolean | null = null;

/** Can this page make a WebGL context? Asked once per page and remembered. */
export function hasWebGL(): boolean {
  if (probed !== null) return probed;
  let ok = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | WebGL2RenderingContext | null;
    if (gl !== null) {
      ok = true;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    ok = false;
  }
  probed = ok;
  return ok;
}

/** Did Pixi boot this app on WebGL, rather than on WebGPU or its canvas fallback? */
export function isWebGLRenderer(app: Pick<Application, 'renderer'>): boolean {
  return app.renderer.type === RendererType.WEBGL;
}
