// THE GUARD ON THE LIVE SUITE'S TWO PROJECTS (phase 90 review WR-C-01 and IN-C-01).
//
// The fatal sim error spec ends the one shared dev host, so it runs in its own `live-terminal`
// Playwright project, which the `live` project names as its `teardown`: after every other live
// test, and even when one of them failed. Until review pass 2 nothing pinned that wiring. Deleting
// the `teardown:` line, reordering the projects or widening `testIgnore` was caught only if the host
// happened to die early enough to redden other specs, and `scripts/check-live-red-set.sh` read a run
// with no terminal project at all as OK.
//
// This gate reads the committed sources, never imports them (the `glPinConfig.test.ts` reason:
// importing a Playwright config drags the runner into the unit suite). It holds:
//   - both live configs select terminal specs by the `*.terminal.spec.ts` suffix, `live` ignoring
//     them and `live-terminal` matching them with the same expression;
//   - the blocking config names `live-terminal` as `live`'s teardown; the reuse config does too,
//     behind its FABRICO_LIVE_TERMINAL switch (the caller owns its host);
//   - every `*.terminal.spec.ts` under `e2e-live/` is in the checker's TERMINAL_FILES, so the
//     checker refuses a full pass that never ran it, and the fatal spec is one of them;
//   - every live spec that fires the dev fault switch is a terminal spec.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(root(rel), 'utf8');

/** The one expression both projects use, as it is written in the source. */
const TERMINAL_RE_SOURCE = '/\\.terminal\\.spec\\.ts$/';

/** The dev host's fault switch frame (`transport_ws.rs` `DEV_FAULT_FRAME`). */
const DEV_FAULT_FRAME = "'dev_fault'";

function countOf(src: string, token: string): number {
  return src.split(token).length - 1;
}

describe('the live projects keep the terminal specs last (review WR-C-01, IN-C-01)', () => {
  const blocking = read('playwright.live.config.ts');
  const reuse = read('playwright.live.reuse.config.ts');
  const checker = read('../scripts/check-live-red-set.sh');
  const terminalSpecs = readdirSync(root('e2e-live')).filter((f) => f.endsWith('.terminal.spec.ts'));

  it('reads the real configs and the real checker (anti-vacuity)', () => {
    expect(blocking).toContain('projects:');
    expect(reuse).toContain('projects:');
    expect(checker).toContain('TERMINAL_FILES=');
  });

  it('both configs ignore terminal specs in live and match them in live-terminal, by one suffix', () => {
    for (const [name, src] of [
      ['playwright.live.config.ts', blocking],
      ['playwright.live.reuse.config.ts', reuse],
    ] as const) {
      expect(countOf(src, `testIgnore: ${TERMINAL_RE_SOURCE}`), `${name}: live ignores *.terminal.spec.ts`).toBe(1);
      expect(countOf(src, `testMatch: ${TERMINAL_RE_SOURCE}`), `${name}: live-terminal matches *.terminal.spec.ts`).toBe(1);
      expect(countOf(src, "name: 'live-terminal'"), `${name}: one live-terminal project`).toBe(1);
      expect(
        src.indexOf("name: 'live'") < src.indexOf("name: 'live-terminal'"),
        `${name}: live is declared before live-terminal`,
      ).toBe(true);
    }
  });

  it('the blocking config names live-terminal as live\'s teardown', () => {
    expect(countOf(blocking, "teardown: 'live-terminal'")).toBe(1);
  });

  it('the reuse config does too, behind its FABRICO_LIVE_TERMINAL switch', () => {
    expect(reuse).toContain("process.env.FABRICO_LIVE_TERMINAL === '1'");
    expect(countOf(reuse, "...(LIVE_TERMINAL ? { teardown: 'live-terminal' } : {})")).toBe(1);
    expect(countOf(reuse, '...(LIVE_TERMINAL')).toBe(2);
  });

  it('every terminal spec is in the checker\'s TERMINAL_FILES, the fatal spec among them', () => {
    expect(terminalSpecs).toContain('90-sim-fatal.terminal.spec.ts');
    const listed = /TERMINAL_FILES=\(([^)]*)\)/.exec(checker);
    expect(listed, 'the checker declares TERMINAL_FILES').not.toBeNull();
    const names = [...listed![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...terminalSpecs].sort());
  });

  it('every live spec that fires the dev fault switch is a terminal spec', () => {
    const firing = readdirSync(root('e2e-live'))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => countOf(read(`e2e-live/${f}`), DEV_FAULT_FRAME) > 0);
    expect(firing.length, 'the fatal spec fires it').toBeGreaterThan(0);
    expect(firing.filter((f) => !f.endsWith('.terminal.spec.ts'))).toEqual([]);
  });
});
