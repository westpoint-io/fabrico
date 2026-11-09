// Which board a page's <Board name> means, decided while the site builds. A name that matches no
// board file fails the build with a message naming the page and the name, so a page can never ship
// a board that doesn't exist or quietly show a different one.
//
// No Astro import here: the unit tests load this file with plain Node.

import { boardIdOf } from '../../../frontend/src/embed/boardIds.ts';

/** A board the site can embed: its id and the alt text of its poster. */
export interface KnownBoard {
  id: string;
  posterAlt: string;
}

/** The board ids for a list of repo paths of board files, sorted, skipping any non-board path. */
export function boardIdsOf(paths: readonly string[]): string[] {
  const ids: string[] = [];
  for (const p of paths) {
    const id = boardIdOf(p);
    if (id !== null) ids.push(id);
  }
  return ids.sort(compare);
}

/** The board a page names, or a thrown Error with the message an author sees in the build log. */
export function resolveBoard(name: string | undefined, page: string, known: readonly KnownBoard[]): KnownBoard {
  if (name === undefined || name === '') {
    throw new Error(`[Board] ${page} has a <Board> with no name. Give it a board id, for example <Board name="demo_scene" />.`);
  }
  const found = known.find((b) => b.id === name);
  if (found !== undefined) return found;
  const ids = known.map((b) => b.id);
  let message =
    `[Board] ${page} names board "${name}", and examples/boards/ has no board with that id. ` +
    `Known boards: ${ids.join(', ')}. ` +
    'A board id is its path under examples/boards/ without .board.ron, with / turned into -.';
  const guess = suggest(name, ids);
  if (guess !== null) message += ` Did you mean "${guess}"?`;
  throw new Error(message);
}

/** The first id (in sorted order) that starts with the name or is within 3 edits of it. */
export function suggest(name: string, ids: readonly string[]): string | null {
  for (const id of ids) if (id.startsWith(name)) return id;
  let best: string | null = null;
  let bestDistance = 4;
  for (const id of ids) {
    const d = editDistance(name, id);
    if (d < bestDistance) {
      best = id;
      bestDistance = d;
    }
  }
  return best;
}

/** Levenshtein distance: the fewest single-character inserts, deletes and swaps from a to b. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost));
    }
    previous = current;
  }
  return previous[b.length];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
