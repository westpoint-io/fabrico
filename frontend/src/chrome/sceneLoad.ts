// sceneLoad.ts — the PURE scene-load routing seam (EX-02, UI-SPEC A3). House
// pattern (dirtyState/statusMachine discipline): guards live in pure modules,
// not React hooks, so the node vitest env can prove the dirty gate without a
// DOM (guards left inside App.tsx would be coverable only by Playwright).
// App.tsx's `doLoadScene` delegates here; the Playwright quit-guard spec covers
// the rendered dialog behaviour on the real click path.

import type { SceneWireId } from '../transport/transport.ts';

/**
 * The scene badge display names (UI-SPEC Copywriting Contract, verbatim):
 * `Demo scene` stays byte-identical to the shipped ONB-01 badge string so the
 * 14-demo-badge exact-match assertion stays true by design.
 */
export type SceneDisplayName = 'Demo scene' | 'Order processing' | 'Advanced pipeline';

/** Wire id -> badge display name, 1:1 over the closed [`SceneWireId`] set. */
export const SCENE_DISPLAY_NAME: Record<SceneWireId, SceneDisplayName> = {
  demo_scene: 'Demo scene',
  order_processing: 'Order processing',
  advanced: 'Advanced pipeline',
};

/**
 * Map the HOST's `loaded_scene` answer to a badge name (WR-03).
 *
 * The host answers with a wire id, or `null` for a user board (New / a loaded
 * `.fab`). Anything else - an unknown id from a newer host, a malformed reply -
 * yields `null`, i.e. NO badge. That is the whole point of deriving the badge
 * from the host: absent beats wrong. A teaching example's badge naming the wrong
 * example is worse than no badge at all.
 */
export function sceneDisplayNameOf(wire: unknown): SceneDisplayName | null {
  if (typeof wire !== 'string') return null;
  return Object.hasOwn(SCENE_DISPLAY_NAME, wire)
    ? SCENE_DISPLAY_NAME[wire as SceneWireId]
    : null;
}

/**
 * Route a scene load through the dirty gate (UI-SPEC A3): a DIRTY board opens
 * the discard guard with `proceed` as the pending continuation (Cancel drops
 * it — the shipped SAVE-05 `discardProceedRef` machinery, zero new plumbing);
 * a CLEAN board proceeds immediately. EVERY Examples-popover entry (the demo,
 * Order processing and Advanced) routes here, so the demo load DELIBERATELY gains the guard it lacked before Phase
 * 55 (A3 — a closed silent-discard hole, not an accident).
 */
export function routeSceneLoad(
  dirty: boolean,
  openGuard: (proceed: () => void) => void,
  proceed: () => void,
): void {
  if (dirty) {
    openGuard(proceed);
  } else {
    proceed();
  }
}
