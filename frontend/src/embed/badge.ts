// The hash badge's words: what the board's state hash was at its end tick, and whether that is the
// value `examples/boards/hashes.manifest` pins for the board. Pure functions, so the element and
// its tests read the same text.
//
// "match" stays in ink. Only the two failures, "mismatch" and "not pinned", get the warning glyph
// and the destructive colour, and the badge is a substrate well because the destructive colour
// doesn't reach contrast on the panel fill.
//
// The manifest pins the file-order run only. A board loaded with `order="reversed"` that ends off
// that pin reads "order-dependent", in ink: its result depends on the order same-tick events
// arrive in, which is what the "run it twice" pair is there to show, and not a failure.

import type { ManifestEntry } from './registry';

export type Verdict = 'match' | 'mismatch' | 'not pinned' | 'order-dependent';

/** What the badge shows: nothing yet, or the end hash and its verdict. */
export interface BadgeState {
  hash: string | null;
  verdict: Verdict | null;
}

/** How many hash characters the badge prints. */
export const BADGE_HASH_CHARS = 8;
/** Holds the badge's width before the end tick: 8 middle dots, U+00B7. */
export const BADGE_PLACEHOLDER = '·'.repeat(BADGE_HASH_CHARS);
export const BADGE_LABEL = 'final state';

/**
 * Compare the run's end hash with the board's manifest line, which pins the file-order run. A
 * reversed run that ends elsewhere is order-dependent rather than a mismatch.
 */
export function verdictOf(hash: string, entry: ManifestEntry | null, order: 'forward' | 'reversed' = 'forward'): Verdict {
  if (entry === null) return 'not pinned';
  if (hash === entry.hash) return 'match';
  return order === 'reversed' ? 'order-dependent' : 'mismatch';
}

/** Is this verdict a failure the reader should see flagged? */
export function isFailure(verdict: Verdict | null): boolean {
  return verdict === 'mismatch' || verdict === 'not pinned';
}

/** The badge's visible text, exactly as `textContent` reads it. */
export function badgeText(state: BadgeState): string {
  if (state.hash === null || state.verdict === null) return `${BADGE_LABEL} ${BADGE_PLACEHOLDER}`;
  return `${BADGE_LABEL} ${state.hash.slice(0, BADGE_HASH_CHARS)} ${state.verdict}`;
}

/**
 * The badge's title. Before the end tick it says what the badge will show; the three verdict
 * titles are the UI-SPEC copy.
 */
export function badgeTitle(verdict: Verdict | null, entry: ManifestEntry | null): string {
  switch (verdict) {
    case 'match':
      return "The engine's state hash at the last tick. It equals the value pinned for this board, so this run ended exactly where every run of it ends.";
    case 'mismatch':
      return `Pinned value is ${(entry?.hash ?? '').slice(0, BADGE_HASH_CHARS)}. This run ended somewhere else, which is a bug: report it with the board name.`;
    case 'not pinned':
      return 'examples/boards/hashes.manifest has no entry for this board, so nothing can check it.';
    case 'order-dependent':
      return `The file-order run is pinned at ${(entry?.hash ?? '').slice(0, BADGE_HASH_CHARS)}. This run fed same-tick events in reverse order and ended somewhere else, so this board's result depends on the order its events arrive in.`;
    default:
      return "The engine's state hash at the last tick. It shows here when the board gets there.";
  }
}
