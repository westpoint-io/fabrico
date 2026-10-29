import { describe, expect, it } from 'vitest';
import { createQuietGestures } from './quietGestures';

describe('quietGestures (phase 88 security re-audit, T-88-25)', () => {
  it('hears a quiet gesture once, on any verdict kind, and never one it was not given', () => {
    const q = createQuietGestures();
    q.add(4);
    q.add(5);
    expect(q.hear({ seq: 3 }), 'a gesture never marked quiet').toBe(false);
    expect(q.hear({ seq: 4 }), 'the quiet one').toBe(true);
    expect(q.hear({ seq: 4 }), 'forgotten once answered').toBe(false);
    expect(q.hear({}), 'a verdict naming no gesture').toBe(false);
    expect(q.size()).toBe(1);
    expect(q.hear({ seq: 5 })).toBe(true);
    expect(q.size()).toBe(0);
  });

  it('forgets the oldest id past its cap, so lost verdicts cannot grow it', () => {
    const q = createQuietGestures(2);
    q.add(1);
    q.add(2);
    q.add(3);
    expect(q.size()).toBe(2);
    expect(q.hear({ seq: 1 }), 'the oldest was dropped').toBe(false);
    expect(q.hear({ seq: 3 })).toBe(true);
  });
});
