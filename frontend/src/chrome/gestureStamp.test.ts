// @vitest-environment jsdom
//
// gestureStamp.test.ts (phase 88, plan 88-03, D-02, D-06): what App's one send seam,
// `submitInput`, stamps on every gesture. App itself cannot be mounted here (Pixi needs a GL
// context), so the stamp is the exported `stampGesture` that `submitInput` calls, and the
// frame is the `encodeGestureFrame` it calls next. The real-App half is
// `frontend/e2e-live/88-verdicts-on-the-wire.live.spec.ts`, which reads the header off the
// frames the page really sends.

import { describe, expect, it } from 'vitest';

import { stampGesture } from './App.tsx';
import { GESTURE_FRAME_VERSION, PostcardReader, encodeGestureFrame } from '../protocol/decode.ts';

describe('the send seam stamps every gesture (phase 88, D-02, D-06)', () => {
  it('hands out ids 1, 2, 3 for three sends, from one page-lifetime counter', () => {
    const counter = { current: 0 };
    expect([1, 2, 3].map(() => stampGesture(counter, 0).gestureId)).toEqual([1, 2, 3]);
    expect(counter.current, 'the counter holds the last id handed out').toBe(3);
  });

  it("stamps the latest applied packet's generation unless the caller names one", () => {
    const counter = { current: 0 };
    expect(stampGesture(counter, 5)).toEqual({ gestureId: 1, generation: 5 });
    // A follow-up made from an older verdict names that verdict's generation (plan 88-05).
    expect(stampGesture(counter, 5, { generation: 3 })).toEqual({ gestureId: 2, generation: 3 });
    // Naming generation 0 is a real choice, not an absence.
    expect(stampGesture(counter, 5, { generation: 0 })).toEqual({ gestureId: 3, generation: 0 });
    expect(stampGesture(counter, 6, {})).toEqual({ gestureId: 4, generation: 6 });
  });

  it('frames the body behind the header the stamp produced, the body untouched', () => {
    const counter = { current: 0 };
    const body = new Uint8Array([5]); // GridCommand::Undo
    const { gestureId, generation } = stampGesture(counter, 2);
    const r = new PostcardReader(encodeGestureFrame(generation, gestureId, body));
    expect([r.u8(), r.varintU(), r.varintU(), r.u8()]).toEqual([GESTURE_FRAME_VERSION, 2, 1, 5]);
    expect(r.remaining()).toBe(0);
  });
});
