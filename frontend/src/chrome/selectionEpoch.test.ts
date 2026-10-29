// selectionEpoch.test.ts (the 76-17 refuter round, review CR-01, threat T-76-44): what
// moves the selection epoch App keys its ConfigPanels on and gates their sends on, and
// what does not. Each case names the App handler whose announcement it replays.

import { describe, expect, it } from 'vitest';
import { createSelectionEpoch } from './selectionEpoch.ts';

describe('the selection epoch', () => {
  it('a_new_node_selection_is_a_new_epoch_and_reannouncing_the_same_node_is_not', () => {
    const e = createSelectionEpoch();
    const first = e.node(1);
    expect(first, 'selecting node 1 from nothing moves the epoch').toBeGreaterThan(0);
    expect(e.current, 'the live value is what the announcement returned').toBe(first);
    expect(
      e.node(1),
      'clicking the selected machine again keeps the epoch, so its panel and buffer stay',
    ).toBe(first);
    expect(e.node(2), 'selecting node 2 moves the epoch').toBeGreaterThan(first);
  });

  it('a_new_belt_selection_is_a_new_epoch_and_reannouncing_the_same_belt_is_not', () => {
    const e = createSelectionEpoch();
    const first = e.belt(12);
    expect(first, 'selecting belt 12 from nothing moves the epoch').toBeGreaterThan(0);
    expect(e.belt(12), 'clicking the selected belt again keeps the epoch').toBe(first);
    expect(e.belt(null), 'clearing the belt selection moves the epoch').toBeGreaterThan(first);
  });

  it('null_then_the_same_handle_is_two_new_epochs', () => {
    // App's announcements when a keyframe's clear is followed by a reselect of the node
    // now on handle 1: `onSelect(null)`, then `onSelect(1)`.
    const e = createSelectionEpoch();
    const panel = e.node(1);
    const cleared = e.node(null);
    const reselected = e.node(1);
    expect(cleared, 'the clear moves the epoch').toBeGreaterThan(panel);
    expect(reselected, 'the reselect of the same number moves it again').toBeGreaterThan(cleared);
  });

  it('a_keyframe_moves_the_epoch_on_its_own', () => {
    const e = createSelectionEpoch();
    const panel = e.node(1);
    expect(
      e.keyframe(),
      'the keyframe branch alone, with no announcement after it, ends the selection',
    ).toBeGreaterThan(panel);
  });

  it('after_a_keyframe_announcing_the_same_number_again_is_a_new_epoch', () => {
    // The keyframe has reminted handles, so handle 1 after it is not handle 1 before it,
    // even when no clear was announced in between.
    const e = createSelectionEpoch();
    e.node(1);
    e.belt(12);
    const afterKeyframe = e.keyframe();
    expect(e.node(1), 'node 1 after a keyframe is a new selection').toBeGreaterThan(afterKeyframe);
    const afterNode = e.current;
    expect(e.belt(12), 'belt 12 after a keyframe is a new selection').toBeGreaterThan(afterNode);
  });
});
