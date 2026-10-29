// DeleteControl.tsx — the discoverable delete affordance (IX-04, UI-SPEC §4).
//
// A small, keyboard-operable trash button that App glues to the top-LEFT corner
// of the selection ring (mirroring the rotate handle's top-right position) so
// delete is reachable without the keyboard. This component is PURELY
// PRESENTATIONAL: it is TOLD its screen position ({left, top}) and raises intent
// via an `onDelete` callback only. It holds NO delete logic and imports no gesture
// controller, no view-projection helper, and no global introspection handle — the
// screen projection and the guarded delete path (requestDelete: in-flight-items
// check + DeleteGuardDialog + single commitDelete) live App-side and are wired in
// 30-06 (threat T-30-01 / T-30-03: no unguarded delete can originate here; the
// projection stays read-only App-side). Because position + onDelete are props, the
// control is decoupled from the gesture layer and ships/tests in Wave 1.
//
// Skin, not skeleton: every colour is a --fab-* token (no new hex). States follow
// UI-SPEC §4 — idle neutral face + --fab-ink glyph; hover tints the glyph + 1px
// border --fab-destructive (the delete-danger telegraph); :focus-visible shows the
// 2px --fab-focus build ring; active sinks 1px. The control is 32px square (a
// documented sub-44px UI-SPEC exception: a 44px DOM target adjacent to the ~28px
// selection ring would occlude the machine and collide with the rotate handle).

import type { JSX } from 'react';
import { TrashIcon } from './icons';

export interface DeleteControlProps {
  /** Screen-space left (px), projected App-side from the selection ring corner. */
  left: number;
  /** Screen-space top (px), projected App-side from the selection ring corner. */
  top: number;
  /** Raise delete intent. App supplies the guarded requestDelete path (30-06). */
  onDelete: () => void;
  /** Tooltip / accessible name. Defaults to the UI-SPEC copy "Delete machine". */
  title?: string;
}

// Co-located state rules: hover/:focus-visible/:active are pseudo-classes and
// cannot be expressed inline, so the small state block ships with the component
// (keeping it self-contained pre-App-wiring). Tokens only — no hand-authored hex.
const STYLE = `
.fab-delete-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  background: var(--fab-btn-neutral);
  color: var(--fab-ink);
  cursor: pointer;
  /* image-rendering: pixelated WAS HERE and is deleted by plan 59-02 (CHROME-01). Its
     only raster subject was the trash glyph, which was a box-shadow bit-matrix sprite and
     is now an inline SVG over an authored 32u asset. A nearest-neighbour hint on a
     surface with no raster is not harmless: it reads as intent, and plan 59-03's
     retirement gate fires on the hint in a module with no baked-matrix source. */
  transition: color 120ms ease, border-color 120ms ease, transform 80ms ease;
}
.fab-delete-control:hover {
  color: var(--fab-destructive);
  border-color: var(--fab-destructive);
}
.fab-delete-control:focus-visible {
  outline: 2px solid var(--fab-focus);
  outline-offset: 2px;
}
.fab-delete-control:active { transform: translateY(1px); }
`;

export function DeleteControl({
  left,
  top,
  onDelete,
  title = 'Delete machine',
}: DeleteControlProps): JSX.Element {
  return (
    <>
      <style>{STYLE}</style>
      <button
        type="button"
        className="fab-delete-control"
        title={title}
        aria-label="Delete machine"
        style={{ position: 'absolute', left, top }}
        onClick={onDelete}
      >
        {/* color=currentColor so the box-shadow trash sprite inherits the button
            ink and flips to --fab-destructive on hover with the button colour. */}
        <TrashIcon color="currentColor" />
      </button>
    </>
  );
}
