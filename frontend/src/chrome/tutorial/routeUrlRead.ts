import { acceptRouteUrl } from '../../tutorial/request';
import type { ChromeFacts } from '../../tutorial/types';

/**
 * What the layer holds between frames about the bound Route's URL: the URL the card shows, and the
 * selection and board generation whose POST URL row has shown an accepted URL, or null when the row
 * hasn't shown one since the selection or the generation last changed.
 */
export interface RouteUrlHeld {
  url: ChromeFacts['routeUrl'];
  shownFor: { selectedNode: number; generation: number } | null;
}

/** Nothing held: a lesson start, or a layer that has read no URL yet. */
export const NO_ROUTE_URL: RouteUrlHeld = { url: null, shownFor: null };

/** The URL the card shows from what is held. */
export function heldRouteUrl(held: RouteUrlHeld): ChromeFacts['routeUrl'] {
  return held.url;
}

/**
 * The bound Route's URL for this frame, from the text in the inspector's POST URL row (`rowText`, null
 * with no such row). It is read off the row only while that Route is selected, and only in the strict
 * endpoint shape, so the row's "Webhook not ready" words or a port 0 URL never reach the card. Otherwise
 * the URL already held stands, as long as it was read about the same handle at the same board
 * generation: an Undo keyframe re-mints handles, and a URL from before it is dropped.
 *
 * A read that finds no URL keeps the held one while the row hasn't shown an accepted URL for this
 * selection, because a freshly mounted row shows its not-ready words until the host answers, and the
 * card shouldn't lose its line on every reselect. Once this selection's row has shown an accepted URL,
 * a read that finds none drops the held URL: the row stopped showing it, as after a path Apply whose
 * URL fetch failed, and a line for a path the listener no longer serves would only answer 404.
 */
export function readRouteUrl(
  held: RouteUrlHeld,
  route: number | undefined,
  selectedNode: number | null,
  generation: number,
  rowText: string | null,
): RouteUrlHeld {
  const prev = held.url;
  const kept = prev !== null && prev.node === route && prev.generation === generation ? prev : null;
  const shown = held.shownFor;
  const shownHere = shown !== null && shown.selectedNode === selectedNode && shown.generation === generation ? shown : null;
  if (route === undefined || selectedNode !== route) return { url: kept, shownFor: null };
  const url = acceptRouteUrl(rowText);
  if (url === null) return { url: shownHere === null ? kept : null, shownFor: shownHere };
  const next = kept?.url === url ? kept : { node: route, generation, url };
  return { url: next, shownFor: shownHere ?? { selectedNode: route, generation } };
}
