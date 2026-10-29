// WR-03 glyph smoke test: the boot Play/Pause glyph must match the sim's real
// boot state. The sim boots in `RunState::Playing` and ticks live from tick 0, so
// the chrome's optimistic `playing` state must initialize to `true` — otherwise
// the toolbar shows a paused glyph over a live-ticking sim until the first click.

import { describe, expect, it } from 'vitest';
import { SIM_BOOTS_PLAYING } from './bootState.ts';

describe('boot Play/Pause glyph parity (WR-03)', () => {
  it('initializes the glyph to "playing" to match the sim booting in RunState::Playing', () => {
    expect(SIM_BOOTS_PLAYING).toBe(true);
  });
});
