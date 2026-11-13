import { describe, expect, it } from 'vitest';
import { NO_ROUTE_URL, heldRouteUrl, readRouteUrl, type RouteUrlHeld } from './routeUrlRead';

// The row's own words are kept out of this file on purpose: the tutorial folders may not import the row
// (the purity gate), and all that matters here is that `acceptRouteUrl` refuses them.
const NOT_READY = 'Webhook not ready';
const ROUTE = 7;
const OTHER = 9;
const URL = 'http://127.0.0.1:41234/endpoint/route-1';
const ORDERS = 'http://127.0.0.1:41234/endpoint/orders';

interface Frame {
  selected: number | null;
  text: string | null;
  generation?: number;
}

/** Play frames through `readRouteUrl` the way the layer's frame loop does, and give the URL after each. */
function play(frames: Frame[], start: RouteUrlHeld = NO_ROUTE_URL): (string | null)[] {
  let held = start;
  return frames.map((f) => {
    held = readRouteUrl(held, ROUTE, f.selected, f.generation ?? 1, f.text);
    return heldRouteUrl(held)?.url ?? null;
  });
}

describe('readRouteUrl', () => {
  it('keeps a held URL when the Route is selected again and its freshly mounted row reads not ready', () => {
    const urls = play([
      { selected: ROUTE, text: URL },
      { selected: OTHER, text: null },
      // The row mounts again for the Route and reads its not-ready words until the host answers.
      { selected: ROUTE, text: NOT_READY },
      { selected: ROUTE, text: NOT_READY },
    ]);
    expect(urls).toEqual([URL, URL, URL, URL]);
  });

  it('drops a held URL when the board generation changes', () => {
    const urls = play([
      { selected: ROUTE, text: URL },
      { selected: null, text: null },
      { selected: null, text: null, generation: 2 },
    ]);
    expect(urls).toEqual([URL, URL, null]);
  });

  it('drops a held URL once the row that showed it stops showing an accepted URL, and takes the next one', () => {
    const urls = play([
      { selected: ROUTE, text: URL },
      { selected: ROUTE, text: URL },
      // A path Apply whose URL fetch failed: the same row, still selected, now reads not ready.
      { selected: ROUTE, text: NOT_READY },
      { selected: ROUTE, text: NOT_READY },
      { selected: ROUTE, text: ORDERS },
    ]);
    expect(urls, 'the old path URL left the card when the row stopped showing it').toEqual([URL, URL, null, null, ORDERS]);
  });

  it('keeps a held URL across a reselect that reads not ready before the answer comes', () => {
    const urls = play([
      { selected: ROUTE, text: URL },
      { selected: null, text: null },
      { selected: ROUTE, text: NOT_READY },
      { selected: ROUTE, text: URL },
      { selected: null, text: null },
      { selected: ROUTE, text: NOT_READY },
      { selected: ROUTE, text: NOT_READY },
      { selected: ROUTE, text: URL },
    ]);
    expect(urls).toEqual([URL, URL, URL, URL, URL, URL, URL, URL]);
  });
});
