/**
 * The gestures whose refusal shows no sentence (phase 88 security re-audit, T-88-25).
 *
 * A Place's follow-ups (its queued Rotates and a Router preset's seeding) are sent by the
 * client, not by a hand. When a later keyframe overtook the Place's accept, the client sends
 * them to the accept's own (generation, handle), the only address that names the machine the
 * Place minted: the host resolves it while that machine lives and refuses it once it is gone
 * (an Undo then a Redo re-mints it). It cannot tell those two apart, so it marks such a send
 * QUIET, and its refusal does not put a sentence in the band about a turn the user made on a
 * ghost the board no longer shows. The red flash and the host's own refusal are unchanged;
 * only the sentence is withheld.
 *
 * App's send seam adds the gesture id it returned; the verdict listener asks once per verdict
 * and the id is forgotten on any answer. Verdicts can be lost (a socket that reconnected), so
 * the set is bounded: past `cap` the oldest id is forgotten, which can only let one late
 * refusal show its sentence, the behaviour before this set existed.
 */

/** How many unanswered quiet gesture ids are remembered at most. */
export const QUIET_GESTURES_CAP = 256;

export interface QuietGestures {
  /** Remember gesture `id` as quiet until its verdict arrives. */
  add(id: number): void;
  /** Whether the gesture `verdict` answers was sent quiet; it is forgotten either way. */
  hear(verdict: { seq?: number }): boolean;
  /** How many quiet ids still wait for a verdict. */
  size(): number;
}

export function createQuietGestures(cap: number = QUIET_GESTURES_CAP): QuietGestures {
  const ids = new Set<number>();
  return {
    add(id: number): void {
      ids.add(id);
      while (ids.size > cap) {
        // A Set iterates in insertion order, so the first id is the oldest.
        const oldest = ids.values().next().value as number;
        ids.delete(oldest);
      }
    },
    hear(verdict: { seq?: number }): boolean {
      return verdict.seq !== undefined && ids.delete(verdict.seq);
    },
    size(): number {
      return ids.size;
    },
  };
}
