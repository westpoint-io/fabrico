// MachineLabels.tsx — the Alt-hold / toggle machine-name chip overlay (READ-01).
//
// A pointer-events:none DOM overlay that reveals a kind-name chip over EVERY
// machine at once (Factorio alt-mode), so the canvas stays clean by default and
// identity is a keypress away. It is mounted by App ONLY while labelsVisible
// (altHeld || labelsToggled), so an unmount tears the rAF down.
//
// Anchoring mirrors the DeleteControl per-frame anchor (App.tsx §861-892): ONE
// batched requestAnimationFrame reads the READ-ONLY window.__fabrico.camera()
// snapshot and the live sceneState.nodes, projects each machine's top-edge anchor
// to screen (world*scale + pan), and writes each chip's CSS transform. Chip
// positions are NEVER React state (that would re-render the tree at 60fps) and
// there is never a camera() setter — the snapshot is consumed one-way,
// display-only (T-30-03 / T-14-FABRICO-RO). The only React state here is the
// low-frequency id+kind LIST of machines (changes on edits, not per frame), so
// the chip TEXT renders as a React text child (never innerHTML — T-33-XSS).
//
// BELT nodes are skipped: a belt is not a machine to name here. LABEL nodes are skipped
// too (phase 76, plan 76-03, D-09, 76-UI-SPEC 4.3): a label already shows its own words,
// and a chip reading "Label" over them would compete with them. One predicate,
// `namesChip`, decides both sites below.

import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react';
import type { SceneHandle } from '../render/pixiApp';
import { CELL, INSET } from '../../shared/geometry';
import { effectiveBox } from '../protocol/footprint';
import { machine_kind } from '../protocol/kinds';
import { KIND_NAMES } from './kindNames';

export interface MachineLabelsProps {
  /** The live scene handle ref (App's handleRef) — the authoritative NodeView map. */
  handleRef: RefObject<SceneHandle | null>;
}

/** One labelled machine: its stable handle id + kind byte (drives the chip text). */
interface Chip {
  id: number;
  kind: number;
}

/** Gap in px between the chip's bottom edge and the machine's top edge. */
const CHIP_GAP_PX = 4;

const chipStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  willChange: 'transform',
  pointerEvents: 'none',
  // Start hidden: a chip mounted mid-session (a machine placed while labels are
  // already visible) is added by a setChips() call that fires AFTER this frame's
  // positioning loop, so it would otherwise paint once at the untransformed
  // origin (top-left of the inset:0 overlay = screen origin) before the next rAF
  // repositions it. It is flipped to `visible` in project() the first time its
  // transform is written. The initial-reveal path stays flash-free too: those
  // chips are seeded synchronously and get their transform (and this flip) in the
  // pre-paint project() call below, so they are already visible on first paint.
  visibility: 'hidden',
  whiteSpace: 'nowrap',
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-hud)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
  padding: 'var(--fab-space-xs)',
  // A translucent substrate backing + hairline outline so the name reads over a
  // busy/flowing canvas without hiding it.
  background: 'color-mix(in srgb, var(--fab-substrate) 85%, transparent)',
  border: '1px solid var(--fab-outline)',
};

/** Does a node of `kind` get a name chip? Every machine; never a belt or a label. */
function namesChip(kind: number): boolean {
  return kind !== machine_kind.BELT && kind !== machine_kind.LABEL;
}

/**
 * Does this node still match a chip drawn for `kind` (CR-01, plan 76-14)? Present, a kind
 * that gets a chip, and the SAME kind the chip names. A keyframe (undo, redo, load, New, a
 * resync after a `RenderProducer::reset`) can hand a machine's handle to a label, to
 * another kind, or to nothing, and the chip set only follows on React's next commit. On
 * the frames in between a chip failing this is hidden, so no name ever sits over the
 * wrong node; an absent node fails it, so a deleted machine's chip hides on that frame too.
 */
export function chipMatchesNode<N extends { kind: number }>(kind: number, node: N | undefined): node is N {
  return node !== undefined && namesChip(node.kind) && node.kind === kind;
}

/** Read the current named machines as a fresh id+kind list from the handle. */
function readChips(handle: SceneHandle | null): Chip[] {
  const list: Chip[] = [];
  const nodes = handle?.sceneState.nodes;
  if (!nodes) return list;
  for (const n of nodes.values()) {
    if (!namesChip(n.kind)) continue;
    list.push({ id: n.id, kind: n.kind });
  }
  return list;
}

/** A stable signature of the chip list so we only setState when the SET changes. */
function chipSig(chips: Chip[]): string {
  return chips.map((c) => `${c.id}:${c.kind}`).join(',');
}

export function MachineLabels({ handleRef }: MachineLabelsProps): JSX.Element {
  // The LOW-FREQUENCY machine list. Seeded synchronously from the live handle so
  // the first paint already has the chip elements (the useLayoutEffect below
  // positions them pre-paint — no origin flash on reveal).
  const [chips, setChips] = useState<Chip[]>(() => readChips(handleRef.current));
  // Per-id chip DOM refs — positioned imperatively each frame (never React state).
  const elRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useLayoutEffect(() => {
    let raf = 0;
    let lastSig = chipSig(chips);
    const project = (): void => {
      const cam = window.__fabrico?.camera();
      const nodes = handleRef.current?.sceneState.nodes;
      if (cam && nodes) {
        // Re-sync the chip element set only when the machine set actually changes
        // (an edit), NOT every frame — positions below still update every frame.
        const list = readChips(handleRef.current);
        const sig = chipSig(list);
        if (sig !== lastSig) {
          lastSig = sig;
          setChips(list);
        }
        // Position every chip over its machine's top-edge centre, this frame. The loop
        // walks the CHIP ELEMENTS, never the nodes (CR-01): a chip whose handle became a
        // label, another kind or nothing would otherwise keep its last place, shown,
        // until React's commit. Such a chip is hidden on this very frame.
        for (const [id, el] of elRefs.current) {
          const n = nodes.get(id);
          if (!chipMatchesNode(Number(el.dataset.kind), n)) {
            el.style.visibility = 'hidden';
            continue;
          }
          const { ew } = effectiveBox(n.w, n.h, n.rot);
          // World top-centre of the machine body: horizontal centre of the
          // effective footprint, at its top edge (INSET inside the cell).
          const worldCx = (n.cell_x + ew / 2) * CELL;
          const worldTop = n.cell_y * CELL + INSET;
          const sx = worldCx * cam.scale + cam.x;
          const sy = worldTop * cam.scale + cam.y;
          // Centre the chip horizontally (-50%) and sit it just above the top
          // edge (-100% of its own height minus the gap).
          el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, calc(-100% - ${CHIP_GAP_PX}px))`;
          // Reveal now that the chip is positioned — a no-op after the first write,
          // but it flips a freshly mounted chip visible only once anchored (no
          // one-frame origin flash for machines added while labels are visible).
          el.style.visibility = 'visible';
        }
      }
      raf = requestAnimationFrame(project);
    };
    // Paint the first frame synchronously (pre-paint) so chips never flash at the
    // origin when the overlay is revealed.
    project();
    return () => cancelAnimationFrame(raf);
    // Mount-once: the loop reads the live handle/camera each frame, so it never
    // needs to re-subscribe. `chips` is intentionally excluded (positions are
    // imperative; the list re-syncs inside the loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleRef]);

  return (
    <div
      aria-hidden
      // CHROME-08 (phase 91, plan 91-09, D-07): zIndex 1, UNDER every chrome surface at 2 (the
      // Toolbar, the Palette, the Legend, Help, the inspector, the camera cluster, the delete
      // control) and the Examples popover at 3, so a tag that reaches a panel is cut at its
      // edge and never reads as part of it. It shared their 2 and mounted after most of them,
      // so it painted over the Toolbar, the Palette, the Legend and Help. App mounts it just
      // after `LabelWords` (also 1), so tags still paint over a label's words.
      style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }}
    >
      {chips.map((c) => (
        <div
          key={c.id}
          data-testid="machine-label"
          data-kind={c.kind}
          ref={(el) => {
            if (el) elRefs.current.set(c.id, el);
            else elRefs.current.delete(c.id);
          }}
          style={chipStyle}
        >
          {/*
            TWO ARMS, NOT THREE (72-10 / D-10). The middle arm used to read a SECOND name
            map beside `KIND_NAMES`, because kind 9 was deliberately kept out of the first
            one - and before that fall-through existed at all, a bare lookup rendered
            `undefined` for kind 9: a bordered, substrate-backed chip with NO TEXT IN IT,
            on a demo scene that ships a pre-placed Route.

            The second map is now DELETED and `KIND_NAMES` names every kind this overlay
            can meet, so the fall-through has nothing left to fall through to. The reason
            the split existed - that the Legend iterates a name table - is answered by
            the Legend iterating `KIND_LEGEND_ORDER`, its own ordered view; see `kindNames.ts`.

            The final 'Machine' arm STAYS. It catches WIRE (kind 8), which is a transport
            seam rather than a node and should never reach this list at all; if one ever
            does it reads as a machine rather than as a blank box.
          */}
          {KIND_NAMES[c.kind] ?? 'Machine'}
        </div>
      ))}
    </div>
  );
}
