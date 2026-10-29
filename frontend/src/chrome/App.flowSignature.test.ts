// The PANEL-04 flow churn guard, and specifically the half of it that decides
// WHICH link the Disconnect control names (WINDOWS row 126, 67-SECURITY warning
// 2, 67-REVIEW IN-02).
//
// THE BUG THIS EXISTS FOR. `PortFlow.link` was added by plan 67-02 so the
// per-row Disconnect button could resolve `{belt, endpoint, node, port}` from
// the same join that decides `docked`. `flowSignature` - the ~10Hz churn guard
// that decides whether the panel rebuilds - did not hash it. So a link REPLACED
// between two polls (unlink one belt, dock another to the same port, both
// carrying the same item count) left `{docked, count}` byte-identical, the guard
// short-circuited, and the panel went on offering a Disconnect that named the
// OLD belt. Plan 67-05 fixed it as deviation 5 and recorded, plainly, that it
// shipped with no test.
//
// WHY THE TEST IMPORTS App.tsx RATHER THAN A NEW MODULE. Review IN-02's close
// was "export `linkTag` alone - a two-line unit test pins the three tags and the
// `'-'` sentinel without touching App.tsx's structure". Half of that survives
// and half does not:
//
//   - It survives mechanically. App.tsx imports cleanly under vitest (measured:
//     ~0.5s, no jsdom canvas complaint reaches this file), so no extraction and
//     no component test file is needed. The export IS the seam.
//   - It does NOT survive as coverage. A `linkTag`-only suite asserts that the
//     tag vocabulary is distinct; it says nothing about whether anything CALLS
//     it. Revert `flowSignature` to the shipped-broken `|${index},${docked},
//     ${count}` and every `linkTag` assertion stays green. That is the defect
//     passing its own test.
//
// So `flowSignature` is exported too, and the FIRST case below is the mechanism:
// two signatures whose states are identical and whose links differ must
// differ. It is the case a revert reddens.
import { describe, expect, it } from 'vitest';
import { flowSignature, linkTag } from './App.tsx';
import type { PortFlow } from '../protocol/portFlow.ts';

/** One docked port on the belt named by `link`, carrying items or not, never backed up. */
const flowOf = (link: PortFlow['link'], carrying: boolean): Map<number, PortFlow> =>
  new Map([[1, { docked: true, carrying, backedUp: false, link }]]);

const BELT_A: PortFlow['link'] = { kind: 'belt', belt: 3, end: 'Tail' };
const BELT_B: PortFlow['link'] = { kind: 'belt', belt: 9, end: 'Tail' };

describe('flowSignature hashes the LINK, not only presence and state (WINDOWS row 126)', () => {
  it('THE MECHANISM: identical state, a different belt -> a DIFFERENT signature', () => {
    // The exact shipped shape of the bug: a Disconnect naming belt 3 is on
    // screen, one poll later the port is docked to belt 9 instead, and both
    // belts happen to be moving. `{docked, carrying, backedUp}` cannot tell these
    // apart; the panel must still rebuild, or the button keeps naming belt 3.
    const before = flowSignature(flowOf(BELT_A, true));
    const after = flowSignature(flowOf(BELT_B, true));

    expect(after, 'a replaced link must move the signature').not.toBe(before);
  });

  it('the same belt at the OTHER END is a different link too (endpoint is dispatched on)', () => {
    // `Unlink` takes `{belt, endpoint, ...}`. A signature that hashed the belt
    // handle but dropped the end would pass the case above and still let the
    // button name the wrong endpoint of the right belt.
    const head = flowSignature(flowOf({ kind: 'belt', belt: 3, end: 'Head' }, true));
    const tail = flowSignature(flowOf({ kind: 'belt', belt: 3, end: 'Tail' }, true));

    expect(head).not.toBe(tail);
  });

  it('a wire link and a belt link at the same port are different signatures (D1: two verbs)', () => {
    // The two mediums dispatch two DIFFERENT commands - `Unlink` on a belt,
    // `Delete {node: wireId}` on a wire - so confusing them is worse than naming
    // the wrong belt.
    const belt = flowSignature(flowOf({ kind: 'belt', belt: 4, end: 'Tail' }, false));
    const wire = flowSignature(flowOf({ kind: 'wire', wire: 4 }, false));

    expect(belt).not.toBe(wire);
  });

  it('NOT VACUOUS: an unchanged flow still produces the SAME signature', () => {
    // Without this, every case above passes against a `flowSignature` that
    // returns a fresh random string - which would "fix" the bug by destroying
    // the guard, re-rendering the whole I/O list at 10Hz forever. The guard's
    // whole job is to quiesce, and this is the half that says so.
    expect(flowSignature(flowOf(BELT_A, true))).toBe(flowSignature(flowOf(BELT_A, true)));

    // And the state fields still move it, unchanged by the link half.
    expect(flowSignature(flowOf(BELT_A, true))).not.toBe(flowSignature(flowOf(BELT_A, false)));
    expect(flowSignature(new Map([[1, { docked: false, carrying: false, backedUp: false }]]))).not.toBe(
      flowSignature(new Map([[1, { docked: true, carrying: false, backedUp: false }]])),
    );
  });

  it('a belt that jams moves the signature: moving to backed up, the same belt (phase 91, CHROME-13)', () => {
    // The row's word changes from `moving` to `backed up` with nothing else moving:
    // the same link, still carrying. A guard that skipped `backedUp` would leave the
    // jammed belt reading moving, the very lie CHROME-13 removes.
    const moving = flowSignature(new Map([[1, { docked: true, carrying: true, backedUp: false, link: BELT_A }]]));
    const jammed = flowSignature(new Map([[1, { docked: true, carrying: true, backedUp: true, link: BELT_A }]]));
    expect(jammed).not.toBe(moving);
  });

  it('a belt re-docked to a different machine moves the signature (the Router names it, UI-SPEC 8.6)', () => {
    const at = (node: number, kind: number): Map<number, PortFlow> =>
      new Map([[1, { docked: true, carrying: false, backedUp: false, link: BELT_A, reaches: { node, kind, input: 1, inputs: 1 } }]]);
    expect(flowSignature(at(20, 7))).not.toBe(flowSignature(at(22, 6)));
    expect(flowSignature(at(20, 7))).not.toBe(flowSignature(flowOf(BELT_A, false)));
    expect(flowSignature(at(20, 7))).toBe(flowSignature(at(20, 7)));
  });
});

describe('linkTag: the three tag shapes and the undocked sentinel (67-REVIEW IN-02)', () => {
  it('a belt link tags as b{belt}.{end}', () => {
    expect(linkTag({ kind: 'belt', belt: 3, end: 'Tail' })).toBe('b3.Tail');
    expect(linkTag({ kind: 'belt', belt: 3, end: 'Head' })).toBe('b3.Head');
  });

  it('a wire link tags as w{wire}', () => {
    expect(linkTag({ kind: 'wire', wire: 7 })).toBe('w7');
  });

  it('an unresolved link is the "-" sentinel, which no real tag can collide with', () => {
    // `link` is optional and fails CLOSED (portFlow.ts): an entry with no
    // resolvable link renders no Disconnect at all. The sentinel has to be
    // distinguishable from every real tag or "no link" and "some link" would
    // hash the same and the control would not appear or disappear on the poll
    // that changed it.
    expect(linkTag(undefined)).toBe('-');
    expect(linkTag(undefined)).not.toBe(linkTag({ kind: 'belt', belt: 0, end: 'Head' }));
    expect(linkTag(undefined)).not.toBe(linkTag({ kind: 'wire', wire: 0 }));
  });

  it('the field separator cannot be forged: no tag contains the signature delimiters', () => {
    // `flowSignature` joins fields with `,` and records with `|`. A tag carrying
    // either would let two different flows serialise to the same string.
    for (const tag of [
      linkTag({ kind: 'belt', belt: 12, end: 'Head' }),
      linkTag({ kind: 'wire', wire: 12 }),
      linkTag(undefined),
    ]) {
      expect(tag).not.toContain(',');
      expect(tag).not.toContain('|');
    }
  });
});
