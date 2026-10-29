// dirtyState.test.ts — the SAFE-03 dirty-since-last-save transition (T-34-DIRTY-FALSE).
//
// nextDirty is the whole dirty tracker: a pure boolean reducer over a tiny
// DirtyEvent union. The App keeps only a boolean + a mirroring ref and calls this
// for every transition, so the "warn ONLY when dirty" gate is provable here
// without React/DOM. The two Pitfall-3 failure modes the review flagged are the
// load-bearing cases: nag after a clean boot (never flips false->true without a
// real edit) and never-nags-after-an-edit (a genuine structural edit MUST flip).

import { describe, expect, it } from 'vitest';
import {
  dirtyAfterVerdict,
  dropOverdueEdits,
  editVerdictOf,
  isLoadSwap,
  nextDirty,
  type DirtyEvent,
  type EditVerdict,
} from './dirtyState.ts';
import { GESTURE_ACCEPT_KIND, parseGestureVerdict } from '../transport/transport.ts';

describe('dirtyState — SAFE-03 dirty transition', () => {
  it('a structural edit flips a clean board to dirty', () => {
    expect(nextDirty(false, 'structuralEdit')).toBe(true);
  });

  it('a structural edit on an already-dirty board stays dirty', () => {
    expect(nextDirty(true, 'structuralEdit')).toBe(true);
  });

  it('a save clears dirty to false', () => {
    expect(nextDirty(true, 'save')).toBe(false);
  });

  it('a save on a clean board stays clean', () => {
    expect(nextDirty(false, 'save')).toBe(false);
  });

  it('a load clears dirty to false (fresh scene)', () => {
    expect(nextDirty(true, 'load')).toBe(false);
  });

  it('a load-demo clears dirty to false (fresh scene)', () => {
    expect(nextDirty(true, 'loadDemo')).toBe(false);
  });

  // SAVE-04: a New yields a truly empty, freshly-clean board — it clears dirty
  // from either starting flag (a fresh empty board is never "unsaved").
  it('a new clears dirty to false from a dirty board (fresh empty board)', () => {
    expect(nextDirty(true, 'new')).toBe(false);
  });

  it('a new stays clean from an already-clean board', () => {
    expect(nextDirty(false, 'new')).toBe(false);
  });

  // Pitfall 3, mode A ("nag after a clean boot"): a non-structural / state-only
  // re-emit (IDLE->WORKING, pure item flow) MUST NOT dirty a clean board.
  it('a non-structural re-emit does NOT dirty a clean board', () => {
    expect(nextDirty(false, 'nonStructural')).toBe(false);
  });

  it('a non-structural re-emit leaves an already-dirty board untouched', () => {
    expect(nextDirty(true, 'nonStructural')).toBe(true);
  });

  // The guard's purpose (per the plan): undo/redo are NOT user edits, so they
  // never flip dirty true. A clean board stays clean across an undo/redo.
  it('an undo/redo does NOT dirty a clean board', () => {
    expect(nextDirty(false, 'undoRedo')).toBe(false);
  });

  it('an undo/redo leaves an already-dirty board untouched (never clears, never sets)', () => {
    expect(nextDirty(true, 'undoRedo')).toBe(true);
  });

  // Pitfall 3, mode B ("never nags after an edit"): the edit->save->edit cycle
  // must dirty, clear, then dirty again — the whole warn-only-when-dirty gate.
  it('edit -> save -> edit round-trips dirty -> clean -> dirty', () => {
    const sequence: DirtyEvent[] = ['structuralEdit', 'save', 'structuralEdit'];
    const dirty = sequence.reduce<boolean>((prev, ev) => nextDirty(prev, ev), false);
    expect(dirty).toBe(true);
  });

  it('a just-saved board that only sees item flow stays clean (no false nag)', () => {
    const sequence: DirtyEvent[] = [
      'structuralEdit',
      'save',
      'nonStructural',
      'nonStructural',
    ];
    const dirty = sequence.reduce<boolean>((prev, ev) => nextDirty(prev, ev), false);
    expect(dirty).toBe(false);
  });

  // Phase 90 red-first probes (plan 90-01, D-14), seen red at PHASE90_START behind the red-first
  // gate and turned on by plans 90-04 (WORK-10) and 90-05 (WORK-08). Review IN-B-07: they import
  // the functions the plans added directly, so tsc checks their signatures, and print nothing.

  it('a_load_swap_is_full_at_its_own_floor_and_above_the_dispatch_floor', () => {
    expect(isLoadSwap({ full: true, generation: 3, swap_floor: 3 }, 0), 'the swap keyframe').toBe(true);
    expect(isLoadSwap({ full: false, generation: 3, swap_floor: 3 }, 0), 'a diff after the swap').toBe(false);
    expect(isLoadSwap({ full: true, generation: 4, swap_floor: 3 }, 0), 'an Undo keyframe after the swap').toBe(false);
    expect(isLoadSwap({ full: true, generation: 0, swap_floor: 0 }, 0), 'the boot keyframe').toBe(false);
  });

  // Review IN-B-05: Undo and Redo never register as edits (`submitInput`'s `edit: false`), so the
  // rule has no `isEdit` term to read; the undo exclusion is the registration's.
  it('an_accepted_edit_marks_the_board_unsaved', () => {
    const edit: EditVerdict = { accepted: true, generation: 3, swapFloor: 3 };
    expect(dirtyAfterVerdict(false, edit), 'an accepted edit at the scene floor').toBe(true);
    for (const prev of [false, true]) {
      expect(dirtyAfterVerdict(prev, { ...edit, accepted: false }), `a refused edit keeps ${prev}`).toBe(prev);
      expect(dirtyAfterVerdict(prev, { ...edit, generation: 2 }), `an accept from below the swap floor keeps ${prev}`).toBe(prev);
    }
  });

  // Phase 90 validation audit (WORK-08's unit half): a Configure (the panel's `set_config` Apply)
  // answered by the host, through the real verdict parser and App's one mapping, marks the board
  // unsaved. Until this test the accept-to-unsaved rule was proved for config only by the live spec.
  it('a_set_config_accept_through_the_real_verdict_parser_marks_the_board_unsaved', () => {
    // The host's accept for the Configure gesture this page sent as seq 7 on generation 3, as
    // `transport_ws.rs` writes it (a Configure mints no handle).
    const accept = parseGestureVerdict(JSON.parse('{"kind":"gestureAccepted","seq":7,"generation":3,"minted":[]}'));
    expect(accept, 'the frame parses as an accept').not.toBeNull();
    expect(dirtyAfterVerdict(false, editVerdictOf(accept!, GESTURE_ACCEPT_KIND, 3)), 'the Apply lights Unsaved').toBe(true);
    const refusal = parseGestureVerdict(JSON.parse('{"kind":"gestureRefused","seq":7,"tag":"Malformed"}'));
    expect(refusal, 'the refusal parses').not.toBeNull();
    expect(dirtyAfterVerdict(false, editVerdictOf(refusal!, GESTURE_ACCEPT_KIND, 3)), 'a refused Apply leaves the board clean').toBe(false);
    const discard = parseGestureVerdict(JSON.parse('{"kind":"gestureDiscarded","seq":7}'));
    expect(discard, 'the discard parses').not.toBeNull();
    expect(dirtyAfterVerdict(false, editVerdictOf(discard!, GESTURE_ACCEPT_KIND, 3)), 'a discarded Apply leaves the board clean').toBe(false);
    expect(
      dirtyAfterVerdict(false, editVerdictOf(accept!, GESTURE_ACCEPT_KIND, 4)),
      'an accept from the board a swap replaced leaves the new board clean',
    ).toBe(false);
  });

  // Review IN-B-02: an edit whose verdict never pairs (a refusal with no seq, a frame the parser
  // dropped, a socket closed with gestures in flight) must not keep `editsAwaitingVerdict` above 0
  // until the next swap. A host answers an edit within a tick of folding it, and holds input at most
  // through a drain (the 1024-tick budget covers it), so an id older than that has lost its answer.
  it('an_edit_whose_answer_is_overdue_by_the_tick_budget_is_dropped', () => {
    const sent = new Map<number, number>([
      [1, 100],
      [2, 600],
      [3, 1124],
    ]);
    expect(dropOverdueEdits(sent, 1124, 1024), 'nothing is overdue at exactly the budget').toBe(0);
    expect([...sent.keys()]).toEqual([1, 2, 3]);
    expect(dropOverdueEdits(sent, 1125, 1024), 'the edit sent at tick 100 has lost its answer').toBe(1);
    expect([...sent.keys()]).toEqual([2, 3]);
    expect(dropOverdueEdits(sent, 1700, 1024)).toBe(1);
    expect([...sent.keys()]).toEqual([3]);
  });
});
