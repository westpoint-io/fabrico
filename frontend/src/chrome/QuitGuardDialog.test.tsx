import { describe, expect, it } from 'vitest';
import {
  GUARD_COPY,
  isThreeChoiceAction,
  type GuardAction,
} from './QuitGuardDialog.tsx';

// The vitest env is `node` (no DOM, no testing-library). QuitGuardDialog is a
// hooked component (focus trap + Escape handling), so it cannot be invoked
// directly here (the 53-07 hook-free lesson). The node-provable halves are
// pinned as data instead: the per-action copy table (verbatim UI-SPEC contract)
// and the pure branch selection that decides 2-choice vs 3-choice. The rendered
// dialog behaviour on the real click path is covered by e2e/quit-guard.spec.ts.

/** U+2014 as an escape so the guard cannot be defeated by its own copy. */
const EM_DASH = '\u2014';

describe("GUARD_COPY 'example' action (EX-02 / UI-SPEC A3)", () => {
  it('carries the verbatim UI-SPEC heading and body', () => {
    expect(GUARD_COPY.example.heading).toBe('Load an example?');
    expect(GUARD_COPY.example.body).toBe(
      'You have edits that have not been saved. If you load an example now, they will be lost.',
    );
  });

  it('matches the new/open sentence shape (same warning preamble)', () => {
    const preamble = 'You have edits that have not been saved.';
    for (const action of ['new', 'open', 'example'] as const) {
      expect(GUARD_COPY[action].body.startsWith(preamble)).toBe(true);
    }
  });

  it('carries no em dash anywhere in the copy table (house rule)', () => {
    for (const { heading, body } of Object.values(GUARD_COPY)) {
      expect(heading).not.toContain(EM_DASH);
      expect(body).not.toContain(EM_DASH);
    }
  });
});

describe('guard branch selection (2-choice quit vs 3-choice discard)', () => {
  it("renders 'example' as the 3-choice Cancel / Discard / Save branch", () => {
    expect(isThreeChoiceAction('example')).toBe(true);
  });

  it("keeps 'new'/'open' 3-choice and 'quit' 2-choice (unchanged)", () => {
    expect(isThreeChoiceAction('new')).toBe(true);
    expect(isThreeChoiceAction('open')).toBe(true);
    expect(isThreeChoiceAction('quit')).toBe(false);
  });

  it('covers every GuardAction in the copy table (exhaustive union)', () => {
    const actions: GuardAction[] = ['quit', 'new', 'open', 'example'];
    for (const action of actions) {
      expect(GUARD_COPY[action].heading.length).toBeGreaterThan(0);
      expect(GUARD_COPY[action].body.length).toBeGreaterThan(0);
    }
    expect(Object.keys(GUARD_COPY).sort()).toEqual([...actions].sort());
  });
});
