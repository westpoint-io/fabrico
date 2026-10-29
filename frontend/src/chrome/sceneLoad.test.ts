import { describe, expect, it } from 'vitest';
import { SCENE_DISPLAY_NAME, routeSceneLoad, sceneDisplayNameOf } from './sceneLoad.ts';

// The guard-routing lock (EX-02 / UI-SPEC A3): App.tsx's doLoadScene delegates
// its dirty gate to the pure routeSceneLoad (the dirtyState/statusMachine house
// pattern — guards in pure modules, provable in the node env). These cases pin
// the two behaviours the plan requires: a dirty board routes through the guard
// (proceed deferred to the continuation, Cancel = never run), a clean board
// loads immediately.

describe('routeSceneLoad — the A3 dirty gate', () => {
  it('a CLEAN board proceeds immediately and never opens the guard', () => {
    let guardOpened = 0;
    let proceeded = 0;
    routeSceneLoad(false, () => guardOpened++, () => proceeded++);
    expect(proceeded).toBe(1);
    expect(guardOpened).toBe(0);
  });

  it('a DIRTY board opens the guard FIRST and defers proceed to the continuation', () => {
    let captured: (() => void) | null = null;
    let proceeded = 0;
    routeSceneLoad(
      true,
      (proceed) => {
        captured = proceed;
      },
      () => proceeded++,
    );
    // Nothing issued yet — the pending scene load rides the continuation.
    expect(proceeded).toBe(0);
    expect(captured).not.toBeNull();
    // Discard/Save resolve by running the continuation (SAVE-05 machinery)...
    captured!();
    expect(proceeded).toBe(1);
  });

  it('Cancel (dropping the continuation) issues nothing', () => {
    let proceeded = 0;
    routeSceneLoad(true, () => {
      /* the guard opens; Cancel nulls discardProceedRef — continuation dropped */
    }, () => proceeded++);
    expect(proceeded).toBe(0);
  });
});

describe('SCENE_DISPLAY_NAME — the badge copy map', () => {
  it('maps the wire ids to the verbatim display names', () => {
    // 'Demo scene' must stay byte-identical to the shipped ONB-01 badge string
    // (14-demo-badge's exact-match assertion depends on it).
    expect(SCENE_DISPLAY_NAME.demo_scene).toBe('Demo scene');
    expect(SCENE_DISPLAY_NAME.order_processing).toBe('Order processing');
    expect(SCENE_DISPLAY_NAME.advanced).toBe('Advanced pipeline');
    expect(Object.keys(SCENE_DISPLAY_NAME).sort()).toEqual([
      'advanced',
      'demo_scene',
      'order_processing',
    ]);
  });
});

describe('sceneDisplayNameOf - the HOST echo -> badge mapping (WR-03)', () => {
  it('maps each wire id the host can answer with to its display name', () => {
    expect(sceneDisplayNameOf('demo_scene')).toBe('Demo scene');
    expect(sceneDisplayNameOf('order_processing')).toBe('Order processing');
    expect(sceneDisplayNameOf('advanced')).toBe('Advanced pipeline');
  });

  it('a null answer (a USER board: New, or a loaded .fab) renders NO badge', () => {
    expect(sceneDisplayNameOf(null)).toBeNull();
    expect(sceneDisplayNameOf(undefined)).toBeNull();
  });

  it('an unrecognised or malformed answer renders NO badge, never a guess', () => {
    // The whole point of deriving the badge from the host is that ABSENT beats
    // WRONG: a newer host naming a scene this build does not know must not fall
    // back to "Demo scene".
    expect(sceneDisplayNameOf('a_scene_from_a_newer_host')).toBeNull();
    expect(sceneDisplayNameOf('')).toBeNull();
    expect(sceneDisplayNameOf(42)).toBeNull();
    expect(sceneDisplayNameOf({ demo_scene: true })).toBeNull();
  });

  it('does not resolve inherited Object keys as scene ids', () => {
    // A prototype-chain hit ('toString', 'constructor') must not be read as a
    // known id; the lookup is an own-property check for exactly that reason.
    expect(sceneDisplayNameOf('toString')).toBeNull();
    expect(sceneDisplayNameOf('constructor')).toBeNull();
    expect(sceneDisplayNameOf('__proto__')).toBeNull();
  });
});
