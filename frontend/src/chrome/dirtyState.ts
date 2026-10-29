// dirtyState.ts - the PURE dirty-since-last-save transition (SAFE-03 /
// T-34-DIRTY-FALSE). There is NO existing dirty tracker in the app; this is it,
// extracted as a single pure reducer so the whole "warn ONLY when dirty" gate is
// unit-provable without React or DOM. App.tsx keeps only a boolean (+ a mirroring
// ref for async close callbacks) and routes every transition through nextDirty.
//
// Pure module discipline: no React, no DOM, no imports. A packet is classified
// upstream (isStructuralEdit in render/strandedDocks.ts) into one of these events;
// the control handlers map Save/Load/LoadDemo to their clearing events.

/**
 * The transitions that can move the dirty flag:
 *   - `structuralEdit` - a genuine place/rotate/delete/dock edit → dirty.
 *   - `save`           - a dispatch-confirmed Save → clean (saved).
 *   - `load`           - a user Load of a file → clean (fresh scene).
 *   - `loadDemo`       - a Load-demo → clean (fresh scene).
 *   - `new`            - a New → clean (a truly empty, freshly-clean board).
 *   - `nonStructural`  - a state-only re-emit (IDLE->WORKING) or pure item flow →
 *                        NO change (never a false nag on a clean/flowing board).
 *   - `undoRedo`       - an undo/redo keyframe → NO change. Undo/redo are not user
 *                        edits for the guard's purpose: they never SET dirty, and
 *                        (to avoid a false "clean" claim) never CLEAR it either.
 */
export type DirtyEvent =
  | 'structuralEdit'
  | 'save'
  | 'load'
  | 'loadDemo'
  | 'new'
  | 'nonStructural'
  | 'undoRedo';

/**
 * The swap fields of a decoded render packet, structurally (this module imports nothing):
 * `RenderPacket.full`, `.generation` and `.swap_floor` (frontend/src/protocol/decode.ts).
 */
export interface SwapFields {
  full: boolean;
  generation: number;
  swap_floor: number;
}

/**
 * Is this packet the keyframe of the board swap a Load dispatched at `floorAtDispatch`
 * produced (phase 90, D-06 and D-02, research Finding D)? The one swap test the status
 * strip's `Loaded` (statusMachine.resolveKeyframe) and the save target's move (App's
 * pending load) share. All three terms are needed, and each excludes one kind of packet:
 *
 *   - `full`: every DIFF after a swap also has `swap_floor === generation` until the next
 *     Undo or Redo, so without it the first post-swap diff would pass.
 *   - `swap_floor === generation`: an Undo or Redo keyframe raises the generation and
 *     leaves the floor where the last swap put it, so it is never mistaken for the swap.
 *   - `swap_floor > floorAtDispatch`: the boot keyframe (both 0 before any swap) and every
 *     keyframe of a swap older than this Load (a lag resync of the previous board) fail.
 *
 * A lag-resync keyframe that arrives after this Load's swap passes, which is correct: the
 * swap did happen. Integer equality on decoded fields only.
 */
export function isLoadSwap(p: SwapFields, floorAtDispatch: number): boolean {
  return p.full && p.swap_floor === p.generation && p.swap_floor > floorAtDispatch;
}

/**
 * One host verdict for a gesture this page sent, as the accept rule reads it (phase 90,
 * D-03), structurally (this module imports nothing):
 *
 *   - `accepted`: the verdict is an accept (`GestureAccept`), not a refusal or a discard.
 *   - `generation`: the board generation the accept names (0 for a refusal or a discard).
 *   - `swapFloor`: the swap floor of the scene on screen when the verdict arrives.
 *
 * Only an EDIT's verdict reaches the rule: Undo and Redo never register as edits (`submitInput`'s
 * `edit: false`), so the undo exclusion is the registration's (review IN-B-05 dropped the
 * `isEdit` term, which was always true at its only call site).
 */
export interface EditVerdict {
  accepted: boolean;
  generation: number;
  swapFloor: number;
}

/** A host verdict as the dirty rule reads it, structurally: its kind word, and an accept's generation. */
export interface VerdictFields {
  kind: string;
  generation?: number;
}

/**
 * App's one mapping from a host verdict for an edit this page sent to the rule's input (phase 90
 * validation audit, WORK-08): an accept (`acceptKind`, `GESTURE_ACCEPT_KIND`) names its generation;
 * a refusal or a discard is not an accept. `swapFloor` is the scene's when the verdict arrives.
 */
export function editVerdictOf(v: VerdictFields, acceptKind: string, swapFloor: number): EditVerdict {
  const accepted = v.kind === acceptKind;
  return { accepted, generation: accepted ? (v.generation ?? 0) : 0, swapFloor };
}

/**
 * Drop the edit gestures whose answer is overdue (review IN-B-02): `sent` maps a gesture id to the
 * scene tick it was sent at, and an id sent more than `budget` ticks before `tick` is removed. A
 * host answers an edit within a tick of folding it and holds input at most through a drain, so an
 * id past the budget lost its verdict (a refusal with no `seq`, a frame the parser dropped, a socket
 * closed with gestures in flight). Ticks do not move on a paused board, so a queued edit is never
 * dropped while it waits for Play. Returns how many were dropped.
 */
export function dropOverdueEdits(sent: Map<number, number>, tick: number, budget: number): number {
  let dropped = 0;
  for (const [id, at] of sent) {
    if (tick - at > budget) {
      sent.delete(id);
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * The accept-driven dirty rule (phase 90, D-03, WORK-08): the board is unsaved once the host
 * ACCEPTS an edit, whatever that edit does to the board's shape. A Factory code, a pace, a
 * Route path, a cable draw or a cable disconnect changes nothing `isStructuralEdit` reads, so
 * before this rule New, Load and quit discarded them without a warning. The packet-shape path
 * (`nextDirty(prev, 'structuralEdit')`) stays as it is; this rule only adds to it.
 *
 *   - an accepted edit at or above the scene's swap floor: true;
 *   - a refusal or a discard (`accepted` false): `prev`, the host took nothing;
 *   - an accept whose generation is below the swap floor: `prev`. That gesture folded on the
 *     board a swap (New, an example, an Open) has since replaced, so the edit is not on the
 *     board the user now looks at, and it must not mark that fresh board unsaved.
 *
 * Never clears the flag: a true `prev` stays true in every case.
 */
export function dirtyAfterVerdict(prev: boolean, v: EditVerdict): boolean {
  if (v.accepted && v.generation >= v.swapFloor) return true;
  return prev;
}

/**
 * The pure dirty transition. Given the previous dirty flag and an event, return
 * the next flag. Total over the union (an exhaustive switch); unknown inputs are
 * treated as a no-op re-emit so a stray event can never spuriously flip the flag.
 */
export function nextDirty(prev: boolean, event: DirtyEvent): boolean {
  switch (event) {
    case 'structuralEdit':
      return true;
    case 'save':
    case 'load':
    case 'loadDemo':
    case 'new':
      return false;
    case 'nonStructural':
    case 'undoRedo':
      return prev;
    default:
      return prev;
  }
}
