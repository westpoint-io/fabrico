// ExamplesPopover.tsx — the Examples disclosure popover (EX-02, UI-SPEC §1-2).
//
// A `.fab-panel` overlay anchored under the Toolbar `Examples` CTA (the trigger
// wraps both in a position:relative box; this panel is absolute, right-aligned
// to it, zIndex above the canvas), mounted ONLY while open — the Legend/Help
// mount-only-while-open discipline, so closed costs zero DOM. It contains one
// full-width `.fab-tool-btn--labeled` button per shipped scene, in natural DOM
// order (EXAMPLE_ENTRIES): no heading, no separator, no "coming soon" filler.
//
// This is a DISCLOSURE, not an ARIA menu (UI-SPEC A2): the trigger carries
// aria-expanded + aria-controls naming this panel (the Legend/Help idiom);
// there is NO role=menu, NO roving tabindex, NO arrow-key machinery — two real
// buttons, natural Tab. Half-implementing the menu pattern would be an a11y lie.
//
// Copy contract (UI-SPEC Copywriting Contract, verbatim): entry 1 relocates the
// shipped `Load demo scene` text + title UNCHANGED (this is what keeps the
// getByTitle e2e selectors alive after the open-popover step); entry 2 is the
// order-processing pair; entry 3 is the advanced order-fulfilment example. All
// strings render as React text children.
//
// HOOK-FREE by design (the 53-07 lesson: the node vitest env invokes components
// directly and cannot expand hooks): focus-on-open rides a module-level STABLE
// callback ref (mount-only, so it never re-fires on re-render and never fights
// Tab); Escape closes via the panel's own onKeyDown; the outside-click close +
// focus-return-to-trigger live in App.tsx (which owns `examplesOpen`, like
// legendOpen/helpOpen). Selecting an entry closes then fires the load callback
// with its typed SceneWireId — the popover structurally cannot emit a bad id.

import type { JSX } from 'react';
import type { SceneWireId } from '../transport/transport.ts';

/** The popover's stable DOM id — the Examples CTA aria-controls it. */
export const EXAMPLES_POPOVER_ID = 'fab-examples-popover';

/** One shipped-scene entry: typed wire id + verbatim UI-SPEC label/title pair. */
export interface ExampleEntry {
  id: SceneWireId;
  label: string;
  title: string;
}

/**
 * The popover's ENTIRE vocabulary (one entry per shipped scene). Exported so the
 * node test asserts the copy verbatim as data AND the rendered tree; entry 1's
 * strings are the shipped CTA strings RELOCATED byte-identical.
 */
export const EXAMPLE_ENTRIES: readonly ExampleEntry[] = [
  {
    id: 'demo_scene',
    label: 'Load demo scene',
    title: 'Load the demo scene and watch the engine run',
  },
  {
    id: 'order_processing',
    label: 'Load order processing',
    title: 'Load the order-processing example (webhook in, HTTP out)',
  },
  {
    id: 'advanced',
    label: 'Load advanced pipeline',
    title: 'Load the advanced order-fulfilment example (parallel workers, dead-letter queue)',
  },
];

/**
 * MODULE-LEVEL stable callback ref: focus entry 1 when it MOUNTS (the popover
 * mounts only while open, so mount == open). Stability is load-bearing — an
 * inline arrow would detach/re-attach on every re-render (the ~10Hz tick poll
 * re-renders the whole chrome) and steal focus back from a Tab-focused entry 2.
 */
function focusOnMount(el: HTMLButtonElement | null): void {
  el?.focus();
}

export interface ExamplesPopoverProps {
  /** Selecting an entry: App closes the popover then fires the guarded load. */
  onSelect: (id: SceneWireId) => void;
  /** Escape pressed inside the panel: App closes + returns focus to the trigger. */
  onEscape: () => void;
}

export function ExamplesPopover({ onSelect, onEscape }: ExamplesPopoverProps): JSX.Element {
  return (
    <div
      id={EXAMPLES_POPOVER_ID}
      className="fab-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Escape closes the popover only — it must not also disarm a tool /
          // clear a selection behind it (the gesture layer's Escape stack).
          e.preventDefault();
          e.stopPropagation();
          onEscape();
        }
      }}
      style={{
        position: 'absolute',
        top: 'calc(100% + var(--fab-space-xs))',
        right: 0,
        zIndex: 3,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--fab-space-xs)',
        // Ring padding (plan 59-03): the 6px the retired border reserved.
        padding: 'calc(var(--fab-space-sm) + var(--fab-bezel-ring))',
        whiteSpace: 'nowrap',
      }}
    >
      {EXAMPLE_ENTRIES.map((entry, i) => (
        <button
          key={entry.id}
          type="button"
          ref={i === 0 ? focusOnMount : undefined}
          className="fab-tool-btn fab-tool-btn--labeled"
          style={{ width: '100%' }}
          title={entry.title}
          onClick={() => onSelect(entry.id)}
        >
          <span>{entry.label}</span>
        </button>
      ))}
    </div>
  );
}
