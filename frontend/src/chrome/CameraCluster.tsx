// CameraCluster.tsx — the on-canvas camera control cluster (UI-SPEC section 1,
// NAV-01 controls + NAV-02 readout).
//
// The one NEW interactive DOM surface of Phase 29: a small bottom-right bezel
// cluster carrying a Fit-to-factory button and a live zoom-percentage readout.
// It owns the bottom-right corner alone (`pointer-events:auto`, `zIndex:2`): the
// passive tick / fps / machine readout that once shared this anchor sat under the
// cluster, unreadable, and was removed in plan 91-03 (CHROME-01). The tick lives in
// the toolbar.
//
// CHROME-01/02 idioms (reused verbatim, no new CSS): a `.fab-panel` 9-slice bezel
// container, `.fab-tool-btn` chunky bevel buttons, the in-code `FitIcon` bit
// matrix. Colour discipline (UI-SPEC Color, pre-honours SHELL-05): the zoom
// readout TEXT is `--fab-ink`, NEVER the build accent — the build accent
// (`--fab-btn-primary`/`--fab-focus`) is the interactive/focus cue only, applied
// by the bevel button affordance + `:focus-visible` ring, not by tinting glyphs.
// The readout uses `--fab-font-size-base` (12px vector Martian Mono, the Phase 47
// token; the x16 crisp grid is retired and the build-accent reserve still
// applies), with `tabular-nums` so its width never jitters.

// TWO CONTROLS, AND ONLY TWO (plan 91-03, CHROME-03, D-04): Fit and the zoom readout. The
// cluster also carried a Graphics trigger and its panel (plan 61-06), a belt step-count
// setting with no visible effect at the shipped belt rate; both were deleted. The cluster is
// a `[data-fab-corner-dock]`, so its width sets the bottom Legend strip's right reserve
// through `cornerInsetPx`; a control added here narrows that strip, and
// `e2e/palette-grouping.spec.ts`'s covered-tool count is the oracle for it.

import type { JSX } from 'react';
import { FitIcon } from './icons';
import { SHORTCUTS } from '../input/shortcuts';

/**
 * How far above the window's bottom edge a TOP-RIGHT panel (the inspector, Help) may reach: the
 * cluster's 24 px inset, its height (a 44 px button inside 14 px of ring padding above and below,
 * 72 px) and an 8 px gap, 104 px in all (phase 91 review WR-B-06, UI review item 1). The cluster
 * shares the panels' right column, so a panel's max height used to end at the cluster's own bottom
 * inset and the two covered each other: a tall inspector painted over Fit and the zoom button, and
 * on a short window the cluster painted over Help's last rows. A parenthesized token sum, so a
 * spacing change moves the panels and the cluster together; `ConfigPanel.tsx` and `HelpPanel.tsx`
 * put it in their `maxHeight`.
 */
export const CAMERA_CLUSTER_CLEARANCE =
  '(var(--fab-space-lg) + var(--fab-min-target) + 2 * (var(--fab-space-sm) + var(--fab-bezel-ring)) + var(--fab-space-sm))';

export interface CameraClusterProps {
  /** The live zoom percentage (worldScale * 100); rendered as `Math.round(...)%`. */
  zoomPct: number;
  /** Re-frame the factory — the same fit action as boot / the Home key. */
  onFit: () => void;
  /** Reset zoom to 100%, keeping the viewport-centre world point fixed. */
  onResetZoom: () => void;
}

export function CameraCluster({
  zoomPct,
  onFit,
  onResetZoom,
}: CameraClusterProps): JSX.Element {
  return (
    <div
      // LAYOUT CONTRACT (52-06): App measures this element's left edge and hands
      // it to `Legend` as part of `cornerInsetPx`, so the bottom Legend strip
      // stops short of these controls and cannot swallow a Fit / zoom click. The
      // reserve is taken from the LEFTMOST `[data-fab-corner-dock]`, which is this
      // cluster, or the ConfigPanel while a machine is selected.
      data-fab-corner-dock=""
      // The inspector nudge reads this element's top as the lowest the inspector reaches (less
      // the 8 px gap of CAMERA_CLUSTER_CLEARANCE), so its column matches the panel's max height.
      data-fab-camera-cluster=""
      className="fab-panel"
      style={{
        position: 'absolute',
        right: 'var(--fab-space-lg)',
        bottom: 'var(--fab-space-lg)',
        zIndex: 2,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--fab-space-sm)',
        // Ring padding (plan 59-03), TWO-value: both axes carry the calc.
        padding:
          'calc(var(--fab-space-sm) + var(--fab-bezel-ring)) calc(var(--fab-space-md) + var(--fab-bezel-ring))',
      }}
    >
      {/* Fit-to-factory — icon-only; the same idempotent re-frame as boot/Home. */}
      <button
        type="button"
        className="fab-tool-btn"
        onClick={onFit}
        title={`Fit factory to view (${SHORTCUTS.fit.label})`}
        aria-label="Fit factory to view"
      >
        <FitIcon />
      </button>
      {/* Zoom readout — clicking resets to 100%. The TEXT stays --fab-ink (never
          the build accent); interactivity is signalled by the bezel + focus ring. */}
      <button
        type="button"
        className="fab-tool-btn fab-tool-btn--labeled"
        onClick={onResetZoom}
        title="Reset zoom to 100%"
      >
        <span
          style={{
            fontFamily: 'var(--fab-font)',
            fontSize: 'var(--fab-font-size-base)',
            color: 'var(--fab-ink)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            lineHeight: 1,
          }}
        >
          {`${Math.round(zoomPct)}%`}
        </span>
      </button>
    </div>
  );
}
