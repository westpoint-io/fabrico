// selectionEpoch.ts (phase 76, the 76-17 refuter round, review CR-01, threat T-76-44).
//
// WHAT IT IS. A counter that names one SELECTION, not one render handle. App keys both
// ConfigPanels on it and gates every command a panel sends on it (`sendWhileSelected`,
// `portEditWhileSelected`): a panel sends only while the live epoch still equals the
// epoch it was rendered for.
//
// WHY NOT THE HANDLE. A full keyframe (an Undo, a Redo, a Load or a New) remints render
// handles from 0, so handle 1 before the keyframe and handle 1 after it can be two
// different nodes. A gate that compares handle numbers has an ABA hole: the keyframe
// clears the selection (1 -> null), the user selects the node now on handle 1
// (null -> 1), and the number is back where the old panel expects it. Two shapes reach
// that hole:
//
//  - The reselect lands before React commits the keyframe's deselect. React then commits
//    `selectedNode` 1 -> 1, a panel keyed on the handle never remounts, and it offers the
//    OLD node's buffer to the node now on handle 1.
//  - A Factory Apply is awaiting `validate_factory_js` when the keyframe lands. The user
//    selects the node now on handle 1 before validate answers, and the old panel's
//    continuation sends the old source onto it.
//
// The epoch moves on every keyframe and on every CHANGE of either selection channel, so
// "null, then the same number" is a new epoch and neither shape can pass. It does NOT move
// when a channel is re-announced with the value it already holds (clicking the selected
// machine again), so that click keeps the panel and its uncommitted buffer, as before.
//
// The live value is read off `current` synchronously by the gates; nothing writes it from
// a React render, so a render of stale state cannot put an old epoch back.

/** One selection's identity, and the three things that can end it. */
export interface SelectionEpoch {
  /** The live epoch. Read by the panel gates at send time. */
  readonly current: number;
  /** The node channel announced `next` (App's `onSelect`). Returns the epoch after it. */
  node(next: number | null): number;
  /** The belt channel announced `next` (App's `onSelectBelt`). Returns the epoch after it. */
  belt(next: number | null): number;
  /**
   * A full keyframe landed. Ends the current selection whatever the channels hold, and
   * forgets what they announced: after a remint no handle number names what it did, so
   * the next announcement on either channel starts a new selection even if it repeats a
   * number. Returns the epoch after it.
   */
  keyframe(): number;
}

/** What a channel last announced. `FORGOTTEN` after a keyframe: no value equals it. */
const FORGOTTEN = Symbol('forgotten');
type Announced = number | null | typeof FORGOTTEN;

/** A fresh epoch at 0 with both channels announced empty. */
export function createSelectionEpoch(): SelectionEpoch {
  let epoch = 0;
  let node: Announced = null;
  let belt: Announced = null;
  return {
    get current() {
      return epoch;
    },
    node(next) {
      if (next !== node) {
        node = next;
        epoch += 1;
      }
      return epoch;
    },
    belt(next) {
      if (next !== belt) {
        belt = next;
        epoch += 1;
      }
      return epoch;
    },
    keyframe() {
      node = FORGOTTEN;
      belt = FORGOTTEN;
      epoch += 1;
      return epoch;
    },
  };
}
