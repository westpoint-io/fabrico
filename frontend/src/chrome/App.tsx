import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { bootPixi, type SceneHandle } from '../render/pixiApp';
import { computeInspectorNudge, fitToFactory, type Insets } from '../render/camera';
import { createFrameProbe } from '../render/frameProbe';
import {
  countSends,
  makeTransport,
  type SendCounts,
  detectEnv,
  transportKind,
  GESTURE_ACCEPT_KIND,
  GESTURE_REFUSAL_KIND,
  type GestureRefusal,
  type GestureVerdict,
  type ITransport,
  type RefusalTag,
  type SceneWireId,
} from '../transport/transport';
import { devWsInvoke } from '../transport/devWsInvoke';
import { applyPacket, beltsDockedTo, isStaleDiff, sceneSnapshot, type FabricoScene } from '../render/sceneState';
import { beltRun, beltRunSignature, type BeltRunEntry } from '../render/beltRun';
import {
  detectStrandedDocks,
  detectKeyframeStrand,
  isStructuralEdit,
} from '../render/strandedDocks';
import { ringKey, ringStep, type StandingStrand } from '../render/strandLifetime';
import {
  DecodeError,
  decodeRenderPacket,
  encodeGestureFrame,
  encodeGridCommand,
  type NodeView,
  type PortView,
} from '../protocol/decode';
import { machine_kind } from '../protocol/kinds';
import { selectedNodePortFlow, type PortFlow } from '../protocol/portFlow';
import { addOutputVerdict, sceneCellOwner, type OccupancyScene } from '../protocol/addOutput';
import { anyPortEditUnfolded, createPortEditGrace, type PortEditGrace } from './portEditGrace';
import {
  IDLE_PORT_EDIT,
  beginPortEdit as closePortEditLatch,
  latchThenSend,
  isPortEditPending,
  isPortEditStale,
  isTimelineRestructure,
  remintedLatchHandles,
  observePorts,
  portsKeyOf,
  PORT_EDIT_STALL_TICKS,
  refusalReleasesPortEdit,
  resumePortEdit,
  type PortEditKind,
  type PortEditLatch,
} from './portEditLatch';
import { takeFit } from './sceneFit';
import { createGestureController, type GestureController } from '../input/gestures';
import { SHORTCUTS, matchesShortcut } from '../input/shortcuts';
import { footprintFits } from '../input/ghost';
import { cellsOfFootprint, effectiveBox } from '../protocol/footprint';
import { createQueuedClaims, type QueuedClaim } from '../input/queuedClaims';
import { createQuietGestures } from '../input/quietGestures';
import { Palette, type ArmedTool } from './Palette';
import { DeleteControl } from './DeleteControl';
import { beltPortRows, ConfigPanel, loadConfig, tauriInvoke } from './ConfigPanel';
import type { RouteNeighbour } from './RouteConfigBody';
import { Legend, LEGEND_PANEL_ID } from './Legend';
import { computeLegendBand, cornerLeftsReachingStrip, type LegendBand } from './legendBand';
import { createSelectionEpoch } from './selectionEpoch';
import { HelpPanel, HELP_PANEL_ID, HELP_SCROLL_ATTR } from './HelpPanel';
import { WelcomeCard } from './WelcomeCard';
import {
  CLIENT_REFUSAL_COPY,
  type ClientRefusalTag,
  REFUSAL_COPY,
  REFUSAL_HOLD_MS,
  RefusalMessage,
  type ScreenRect,
} from './RefusalMessage';
import { LoadRefusedCard } from './LoadRefusedCard';
import { SimStoppedCard } from './SimStoppedCard';
import { EMPTY_FLOOR_BODY, EMPTY_FLOOR_HEADING } from './configCopy';
import { MachineLabels } from './MachineLabels';
import { LabelWords } from './LabelWords';
import { Toolbar } from './Toolbar';
import {
  makeControlHandlers,
  type ControlHandlers,
  type StatusKind,
  STATUS_COPY,
} from './controlHandlers';
import { LOAD_TICK_BUDGET, makeStatusMachine, type StatusMachine } from './statusMachine';
import { makeHostWorkGate, makeStatusWatchdog, type HostWorkGate, type StatusWatchdog } from './statusWatchdog';
import { reducedMotionPins } from './reducedMotion';
import { SIM_BOOTS_PLAYING } from './bootState';
import { CameraCluster } from './CameraCluster';
import { DeleteGuardDialog } from './DeleteGuardDialog';
import { EXAMPLES_POPOVER_ID } from './ExamplesPopover';
import { QuitGuardDialog, type GuardAction, type GuardWork } from './QuitGuardDialog';
import {
  SCENE_DISPLAY_NAME,
  routeSceneLoad,
  sceneDisplayNameOf,
  type SceneDisplayName,
} from './sceneLoad';
import { dirtyAfterVerdict, dropOverdueEdits, editVerdictOf, isLoadSwap, nextDirty } from './dirtyState';
import { CELL, INSET, HANDLE_OFFSET } from '../../shared/geometry';
import { LOCKED_SKIN } from '../render/synth/skins/locked';
import { skinToCssVars } from '../render/synth/chrome/skinToCssVars';
// The injected chrome style block. Plan 59-03 moved it out of this file into its own
// module: the CSS walker gates parse it, the closed BEZEL_CLASSES literal is
// interpolated into it, and the DPR spike fixture applies the REAL rules rather than a
// hand-copied imitation. The Phase 47 two-font vector system (FEEL-05) - Martian Mono
// body + Sono title tier, both OFL-1.1 variable woff2 bundled locally for an offline app
// with no runtime fetch - moved with it, since the @font-face rules live in that text.
import { CHROME_CSS } from './chromeCss';

/** SHELL-07: how long a transient TERMINAL status lingers before fading to idle. */
const STATUS_AUTOCLEAR_MS = 4000;
/**
 * SHELL-07: a pending Load fails honestly when the host sends NO packet for this long
 * (phase 90: every packet restarts the window, so a long drain, which sends a packet every
 * tick, is never called a failure; `LOAD_TICK_BUDGET` covers a host that keeps ticking).
 */
const STATUS_LOAD_TIMEOUT_MS = 10000;
/**
 * SAFE-01: the render-stream stall threshold. A Playing sim emits a guaranteed
 * ~62.5 packets/s heartbeat (render_packet.rs on_tick), so ~16ms between packets;
 * 800ms is ~50 missed heartbeats - comfortably past normal frame jitter but still
 * a prompt honest signal that the live view has frozen. Gated on `playing` so a
 * paused sim's expected silence never trips it (T-34-DISCONNECT-FALSE).
 */
const DISCONNECT_MS = 800;

/** The delete-guard dialog state (REND-03). `null` = closed. */
export interface DeleteGuard {
  /** The target machine handle the resolved Delete commits against. */
  handle: number;
  /** The live in-flight item count (initial, then updated each drain poll). */
  count: number;
  /** Belt vs machine target — selects the body copy. */
  kind: 'belt' | 'machine';
  /** The docked belt ids whose item counts the drain poll sums (via window.__fabrico). */
  beltIds: number[];
  /** True while the passive drain poll is running (Cancel-only state). */
  draining: boolean;
}

/**
 * The read-only render-model introspection hook (REND-02). Exposes a single
 * getter returning a FRESH plain-data snapshot of the build-layer scene model —
 * never a setter, never a Pixi/live reference (threat T-14-FABRICO-RO). Tests
 * (and only tests) read `window.__fabrico.scene()` to assert scene facts DOM-free.
 */
declare global {
  interface Window {
    __fabrico?: {
      scene(): FabricoScene;
      stats(): { packetsApplied: number; decodeErrors: number };
      /**
       * Dev frame-time probe (v3.0 baseline for Phase 28 / GATE-05): the rolling
       * average of `app.ticker.deltaMS` in ms on the shipped default scene. A
       * read-only number getter - no setter, no Pixi ref (threat T-23-06).
       */
      frameTime(): number;
      /**
       * MOTION-04 deterministic frame readout: the quantized MOTION-01 frame index
       * of the render loop's EFFECTIVE clock. A read-only number getter that every
       * downstream frame probe (belt march, fault blink, working sweep) reads its
       * phase off - no setter, no Pixi ref (T-26-01 / T-14-FABRICO-RO).
       */
      frame(): number;
      /**
       * Phase 90 (FAIL-01): when the Pixi ticker last FINISHED a frame (`app.ticker.lastTime`,
       * set after every listener has returned). A read-only number. It is the render-health
       * read for a HELD board, where `frame()` stands still by design (the render clock
       * follows the sim clock): a listener that throws stops the ticker, and this with it.
       */
      tickerTime(): number;
      /**
       * NAV-01 camera introspection (T-14-FABRICO-RO, load-bearing). Returns a
       * FRESH plain `{x, y, scale}` snapshot of the live pan (root Container
       * position) + uniform zoom every call - never the live Pixi Container, no
       * setter, no mutator. Identical read-only discipline to `scene()` /
       * `frameTime()`: the camera state must never become a write path that
       * bypasses the command layer. The e2e coordinate helpers read it (in dev
       * AND CI) to transform world cells to live screen points, so it lives on
       * the always-exposed surface, not the DEV-guarded one.
       */
      camera(): { x: number; y: number; scale: number };
      /**
       * CONNECT-02 stranded-ring liveness (67-REVIEW WR-05). `true` while the
       * alert rings are actually PAINTED - the same `alertBornMs !== null` read the
       * gesture layer gates its stranded-ring hit test on, so this answers the one
       * question a reconnect spec has to ask before it presses: is the affordance
       * on screen at all?
       *
       * Without it, a build in which `showAlertRings` regressed but
       * `setStrandedRings` still fired passes both stranded specs - the
       * model-oracle blind spot this project has already been bitten by, where the
       * scene model says "docked" over a renderer that drew nothing. It also turns
       * a wait-for-ring timeout into a failure that NAMES the missing paint
       * instead of one that points at the feature.
       *
       * Read-only, no setter, no Pixi ref (T-14-FABRICO-RO), and always exposed
       * for the same reason `camera()` is: the live e2e reads it in dev AND CI.
       */
      alertRingsActive(): boolean;
      /**
       * The PLOT READ for the SAME rings (73-14), in the position and for the reason the
       * two gauge probes below occupy theirs.
       *
       * `alertRingsActive` above is a CALL LATCH: it answers off `alertBornMs`, which
       * `showAlertRings` stamps whatever the drawing that followed produced. A build whose
       * ring geometry plotted nothing passes it with every model-side stranded assertion
       * still green - so UNDO-06 walk step 5's whole user-visible claim, that exactly ONE
       * belt draws its rings, had no machine instrument and was carried by a human eye on
       * the acceptance walk (WINDOWS 219).
       *
       * A COUNT, not a boolean, matching `portNubInstructionsOn`: the live leg asserts the
       * count is non-zero while the belt is stranded and ZERO after the undo clears it, and
       * a boolean cannot express the second half as a number moving. Delegates to
       * `OverlayLayer.alertRingInstructions()`, which reads
       * `alertRings.context.instructions.length` straight off the Graphics. Read-only, no
       * setter, no Pixi ref (T-14-FABRICO-RO).
       */
      alertRingInstructions(): number;
      /**
       * WHERE the same rings are (plan 74.1-27, review WR-06): the world-px centre of
       * every circle the ring Graphics PLOTTED, delegating to
       * `OverlayLayer.alertRingCentres()`, which reads them back off the Graphics' own
       * instructions and never off the point list handed to `showAlertRings`. The count
       * above cannot see a ring on the wrong output (walk item N5); this can. Read-only,
       * a fresh array of plain numbers, no setter, no Pixi ref (T-14-FABRICO-RO).
       */
      alertRingCentres(): Array<{ x: number; y: number }>;
      /**
       * WHICH target rings a belt gesture has painted, and HOW (plan 74.1-33, review round 4
       * WR-02): the resting rings with their grabbed disc and the hovered drop ring with
       * whether it was drawn accepting, delegating to `OverlayLayer.targetRingsPlotted()`,
       * which reads both back off the two ring Graphics and never off the point lists handed
       * to the paints. Read-only, fresh plain objects, no setter, no Pixi ref
       * (T-14-FABRICO-RO).
       */
      targetRingsPlotted(): {
        resting: Array<{ x: number; y: number; filled: boolean }>;
        drop: { x: number; y: number; accepting: boolean } | null;
      };
      /**
       * The reject flash's PLOT read, delegating to `OverlayLayer.rejectFlashInstructions()`
       * exactly as the line above delegates. Added by 74-05 so LINK-02's browser spec can
       * pin the ring-sourced-flashes / handle-drag-stays-silent split from the same side of
       * the app the user sees. Read-only, no setter, no Pixi ref.
       */
      rejectFlashInstructions(): number;
      /**
       * WHERE the reject flash is plotted, delegating to `OverlayLayer.rejectFlashCell()`
       * (plan 89-09, D-12): the cell under the centre of the box the flash `Graphics` holds,
       * read off its own fill instruction, or null when it holds none. So a live spec grades
       * that the one flash names the cell the host's sentence is about. Read-only, a fresh
       * object each call, no setter, no Pixi ref.
       */
      rejectFlashCell(): { cx: number; cy: number } | null;
      /**
       * How many reject flashes have been shown since boot (review IN-C-01), delegating to
       * `OverlayLayer.rejectFlashSerial()`. Paired with `rejectFlashCell` by the live latch.
       */
      rejectFlashSerial(): number;
      /**
       * The pending "placing" shimmer's PLOT read, delegating to
       * `OverlayLayer.pendingInstructions()` exactly as the reject flash's read above does
       * (plan 88-05, D-10): the count of instructions the shimmer `Graphics` holds, so a live
       * spec grades that a refused Place leaves the red flash alone. Read-only, no setter, no
       * Pixi ref.
       */
      pendingInstructions(): number;
      /**
       * PILE-08 acceptance check 3 (71-06): is a BACKED_UP load gauge actually PAINTED
       * on the canvas right now?
       *
       * The SAME argument `alertRingsActive` above is here for, on a different cue. The
       * scene model cannot answer this: `node.load` arriving as 4 says only that the host
       * derived a full inbox, and a build whose gauge paint regressed entirely would
       * still report it. That is this project's recorded model-oracle blind spot, and a
       * hook that read the model would BE the blind spot rather than a probe for it.
       *
       * This delegates to `MachineLayer.loadGaugesPainted()`, whose membership test is
       * `gauge.context.instructions.length > 0` read back off the Graphics at the draw
       * call site. Making `drawLoadGauge` a no-op takes it to 0 with the model untouched.
       *
       * Read-only, no setter, no Pixi ref (T-14-FABRICO-RO): a boolean off a number, and
       * always exposed for the same reason `camera()` is - the live e2e reads it in dev
       * AND in CI.
       */
      backedUpMarksPainted(): boolean;
      /**
       * The SAME probe, SCOPED TO ONE NODE (71-review WR-05). `backedUpMarksPainted()`
       * is board-wide, and a spec that names a machine ("the Tee is BACKED_UP and the
       * mark is painted") cannot make that claim with it: the count stays non-zero on
       * a build where the named machine draws nothing and some other machine's 1..3
       * tick run still plots. Delegates to `MachineLayer.loadGaugePaintedOn(id)`, the
       * same painted set with the same plot-derived membership. Read-only.
       */
      backedUpMarkPaintedOn(id: number): boolean;
      /**
       * The FORM the load gauge on one node is drawn in, and the scene tick it was drawn
       * FROM (plan 77-07, phase 77 D-04). `backedUpMarkPaintedOn` is true at levels 1 to 3
       * too, so it cannot see the backed-up mark clear; an instruction count alone cannot
       * tell level 1 from the merged bar, so this also carries the drawn width, and
       * `merged` is true only for ONE filled rect in the gauge ink spanning the full run, on a
       * shown Graphics (`readLoadGaugeForm`). The model can be a
       * frame ahead of the canvas (`applyPacket` lands between draws), so the form carries
       * `drawnAtTick`. Delegates to `MachineLayer.loadGaugeFormOn(id)`, read off the gauge
       * Graphics' own context, never `node.load`. `null` for an id never drawn. Read-only.
       */
      loadGaugeFormOn(id: number): {
        instructions: number;
        width: number;
        merged: boolean;
        drawnAtTick: number;
      } | null;
      /**
       * The PORT-NUB paint probe (73-10), in the same position and for the same reason
       * as the two gauge probes above: the live oracle is model-only, so a spec that
       * clicks `+ Add output` and then reads the port list has proved the MODEL grew a
       * port and nothing whatsoever about whether a nub reached the screen.
       *
       * That gap was not hypothetical. The nub overlay's invalidation key carried no
       * port token, so on a freshly placed idle Factory an added output plotted nothing
       * and every surviving nub stayed at its pre-re-seat cell - and the whole live
       * suite passed, because the app's own hit test is model-derived too
       * (`gestures.ts nubsInRadius` over `worldNubSpecs`), which left the new nub
       * clickable but invisible.
       *
       * A COUNT, not a boolean, because the defect leaves a stale plot rather than an
       * empty one: "is anything painted" is true on the broken build. Delegates to
       * `MachineLayer.portNubInstructionsOn(id)`, which reads
       * `nubs.context.instructions.length` straight off the Graphics. Read-only.
       */
      portNubInstructionsOn(id: number): number;
      /**
       * The LABEL-BOX paint probe (phase 76, SHAPE-10), beside the port-nub probe and for
       * the same reason: the live oracle is model-only, so a scene that reports a node of
       * kind 11 has proved nothing about whether its box reached the screen. Returns what
       * the `label-box` Graphics PLOTTED, read back off its own instructions (fill colour
       * and alpha, stroke colour, alpha and width, the rectangle in world px), never the
       * values handed to the draw call; `null` when no box is held for `id`. Delegates to
       * `MachineLayer.labelBoxOn(id)`. Read-only.
       */
      labelBoxOn(id: number): {
        instructions: number;
        fill: { color: number; alpha: number } | null;
        stroke: { color: number; alpha: number; width: number } | null;
        rect: { x: number; y: number; w: number; h: number } | null;
      } | null;
      /**
       * THE MACHINE LAYER'S CENSUS (plan 76-08, verification truth 7, review CR-01): the
       * handles whose machine root and whose label box are children of the layer, read
       * off the Pixi DISPLAY LIST, plus a count of children neither accounts for. A
       * keyframe restarts handles at 0, so a handle that named a label can name a machine
       * after it; the scene model was right and the canvas held a ghost box, and a
       * model-only oracle could not see it. Delegates to `MachineLayer.drawnNodes()`.
       * Read-only, plain data.
       */
      drawnNodes(): { machines: number[]; labels: number[]; strays: number };
      /**
       * WHICH ART the machine root on `id` draws (plan 76-08): the subject whose shared
       * asset context the root's glyph Graphics holds right now, matched by identity
       * (`'source'`, `'sink'`, ...), or `null` without a root, without a glyph, or while
       * the body is hidden below the LOD cut. Closes the machine-to-machine half of the
       * same blind spot: a root kept on a reminted handle drawing the old kind's art.
       * Delegates to `MachineLayer.glyphSubjectOn(id)`, which never builds a context.
       * Read-only.
       */
      glyphSubjectOn(id: number): string | null;
      /**
       * WHERE the glyph on `id` is drawn and how big (plan 85-02, D-24): the glyph Graphics'
       * position, the drawn art's author box times its current scale, and the machine's
       * footprint read off the body's pivot, all in px in the body's unrotated frame, or
       * `null` exactly when `glyphSubjectOn` is. Lets a live spec prove no glyph draws past
       * its machine from the drawn objects, not the placement formula. Delegates to
       * `MachineLayer.glyphBoxOn(id)`. Read-only, plain numbers.
       */
      glyphBoxOn(
        id: number,
      ): { x: number; y: number; w: number; h: number; footW: number; footH: number } | null;
      /**
       * THE DRAWN ITEMS (plan 77-02, phase 77 D-04): the world-px position of every item
       * dot the item layer's latest draw placed, read off the ParticleContainer's own
       * children, never off the scene model. Closes the item half of the model-oracle blind
       * spot: an item layer drawing nothing while the model packs. Delegates to
       * `ItemLayer.plottedDots()`. Read-only, plain numbers.
       */
      itemDots(): Array<{ x: number; y: number }>;
      /**
       * THE DRAWN ITEMS AND THE SCENE TICK THEY WERE DRAWN FROM (plan 77-04, the 77-04 review
       * blocker): `dots` is exactly `itemDots()`, and `drawnAtTick` is the `scene.tick` the
       * item layer's latest draw read (`null` before the first). The model is updated as each
       * packet lands and the dots only inside a draw, so on a flowing belt a read of both can
       * pair tick T's model with the dots of T-1; a grader keys the dots by this tick.
       * Delegates to `ItemLayer.plottedDotsFrame()`. Read-only, plain numbers.
       */
      itemDotsFrame(): { drawnAtTick: number | null; dots: Array<{ x: number; y: number }> };
      /**
       * THE LIVE SELECTION (plan 76-15, review CR-01): the render handle the selection
       * ref holds RIGHT NOW, or `null`. It reads the live ref, not React state, so a
       * check can tell the keyframe branch's synchronous deselect (a keyframe remints
       * handles, and the ref is nulled on the frame it lands) from React's later commit
       * of the same deselect. A handle is a number every packet already carries.
       * Read-only: no setter, no scene, command or log write (T-14-FABRICO-RO).
       */
      selectedNode(): number | null;
      /**
       * The live BELT selection (the 76-17 refuter round): `selectedNode`'s twin for the
       * belt channel, the belt handle `selectedBeltRef` holds right now, or `null`.
       * Read-only, the same discipline as `selectedNode`.
       */
      selectedBelt(): number | null;
      /**
       * The label PENDING-SIZE OUTLINE probe (phase 76, plan 76-03, 76-UI-SPEC 5.4): what
       * the overlay's `label-resize-preview` Graphics PLOTTED, read back off its own
       * instructions (stroke colour, alpha and width, the rectangle in world px, whether
       * anything filled), or `null` when it holds nothing. Never the arguments handed to
       * the draw call. Delegates to `OverlayApi.labelResizePreview()`. Read-only.
       */
      labelResizePreview(): {
        instructions: number;
        stroke: { color: number; alpha: number; width: number } | null;
        rect: { x: number; y: number; w: number; h: number } | null;
        filled: boolean;
      } | null;
      /**
       * The BELT-END paint probe (74-09), in the same position and for the same reason
       * as the port-nub probe above: the live oracle is model-only, so a spec that
       * joins two belts with a pointer gesture and then reads `belts[].docks` has
       * proved the MODEL holds a link and nothing whatsoever about whether the
       * junction reached the screen.
       *
       * A COUNT, not a boolean, matching `portNubInstructionsOn`: the live leg asserts
       * the count is non-zero while the junction is joined and ZERO after the
       * Disconnect clears it, and a boolean cannot express the second half as a number
       * moving. Delegates to `BeltLayer.endInstructionsOn(id)`, which reads
       * `ends.context.instructions.length` straight off the Graphics.
       *
       * It counts BOTH of that belt's end marks, so a belt that also docks a machine
       * reports the sum; see the layer's own docblock. Read-only, no setter, no Pixi
       * ref (T-14-FABRICO-RO).
       */
      beltEndInstructionsOn(id: number): number;
      /**
       * Where belt `id`'s junction collar is plotted, in world px (review fix CR-C-01), delegating
       * to `BeltLayer.collarCentresOn`, which reads the stroked circles back off the belt's end
       * Graphics. The seam between two joined belts as the user sees it. Read-only, plain numbers.
       */
      beltCollarCentresOn(id: number): Array<{ x: number; y: number }>;
      /**
       * The DRAWN tile kinds of one belt (plan 74.1-20, review WR-05): the kinds its
       * current geometry was built from, tail first, or null for a belt with no sprite.
       * For the few frames between a release and its Dock echo the renderer draws a
       * predicted seam the packet does not carry yet, so `scene()` cannot say what was
       * on screen; this can. Delegates to `BeltLayer.drawnTilesOf`. Read-only, a fresh
       * array of plain kinds, no setter, no Pixi ref (T-14-FABRICO-RO).
       */
      beltDrawnKindsOf(id: number): unknown[] | null;
      /**
       * The draw-belt preview's PLOT read (plan 74.1-26, review WR-08), delegating to
       * `OverlayLayer.beltPreviewInstructions()`, which reads the preview Graphics'
       * `context.instructions.length`. With `beltDrawnKindsOf` it lets the live release
       * leg grade every frame after the pointerup on what was on screen: the preview, the
       * drawn belt, or neither. Read-only, a number, no setter, no Pixi ref.
       */
      beltPreviewInstructions(): number;
      /**
       * The wire drag preview's PLOT read (plan 75-05, CABLE-08), delegating to
       * `OverlayLayer.wirePreviewPolylines()`: every corridor the route Graphics stroked,
       * as world-px vertices read back off its own `context.instructions`, one array per
       * corridor. A count-and-shape read of what was drawn, never a latch on what
       * `showRoute` was called with, so a corridor that stops short of its nubs is visible
       * here while the gesture's arguments look right. Read-only, fresh arrays of plain
       * numbers, no setter, no Pixi ref (T-14-FABRICO-RO).
       */
      wirePreviewPolylines(): Array<Array<{ x: number; y: number }>>;
      /**
       * WHAT SHAPE the draw-belt preview plotted at one cell (plan 74.1-30, review round 4
       * CR-01), delegating to `OverlayLayer.beltPreviewKindAt`: the tile kind in the list
       * the preview surface last PLOTTED, recorded inside the plotting call, or null. The
       * count above cannot see a straight preview at a docked seam, which is how S1R stayed
       * green while the walk failed it; the live release leg grades every frame on this.
       * Read-only, a fresh plain kind, no setter, no Pixi ref.
       */
      beltPreviewKindAt(cellX: number, cellY: number): unknown;
      /**
       * WHICH WAY the belt tile on one cell is DRAWN (plan 89-03, BELT-10), delegating to
       * `BeltLayer.treadRotationAt`: the rotation of the tile object the belts layer drew
       * there, in radians (the native tread points West, so 0 is West, PI/2 North, PI East,
       * 3PI/2 South), or null when no drawn belt has a tile on that cell. The kind the scene
       * holds can be right while the tile is drawn the wrong way round; this reads the
       * drawing. Read-only, a plain number, no setter, no Pixi ref.
       */
      beltTreadRotationAt(cellX: number, cellY: number): number | null;
      /**
       * The draw-belt drag preview's COLOUR as plotted (plan 88-07, BELT-06), delegating to
       * `OverlayLayer.beltPreviewPlotted()`: the first stroke's colour off the preview
       * Graphics and whether it is the build accent, or null when it holds nothing. Read-only
       * plain data, no setter, no Pixi ref.
       */
      beltPreviewPlotted(): { color: number; valid: boolean } | null;
      /**
       * The placement ghost as plotted (plan 88-07, BELT-06), delegating to
       * `OverlayLayer.ghostPlotted()`: its body rectangle in world px, its fill colour and
       * whether that is the build accent, or null when it holds nothing. Read-only plain data.
       */
      ghostPlotted(): { rect: { x: number; y: number; w: number; h: number }; color: number; valid: boolean } | null;
      /**
       * The re-route mark's PLOT read (plan 75-06, CABLE-07), delegating to
       * `WireLayer.rerouteMarkStrokes()`: the number of strokes in the build accent the
       * `cables` Graphics holds after the last frame, read off its own
       * `context.instructions`. Above zero means a re-route mark was on screen in that
       * frame. A count of what was plotted, never a latch on what the layer decided, so a
       * mark that was decided and not drawn reads 0. It cannot say WHICH cable carries
       * the mark or at what alpha; vitest grades those. Read-only, a number, no setter,
       * no Pixi ref (T-14-FABRICO-RO).
       */
      rerouteMarkStrokes(): number;
      /**
       * The resting cables' PLOT read (plan 77-05, 77 D-04, done-test leg 5), delegating to
       * `WireLayer.cablePolylines()`: one array of world-px vertices per resting cable stroke
       * the `cables` Graphics holds after the last frame, read off its own
       * `context.instructions`, the re-route mark excluded by colour. The canvas half of "the
       * cable comes back in the same place": the model's `wires[].path` says where a cable
       * should be, this says where one was drawn. Read-only, fresh arrays of plain numbers, no
       * setter, no Pixi ref (T-14-FABRICO-RO).
       */
      cablePolylines(): Array<Array<{ x: number; y: number }>>;
      /**
       * MOTION-04 render-clock pin (production-inert). `pinClock(n)` freezes a
       * deterministic render frame for probes; `pinClock(null)` (the default)
       * restores live behavior. It controls ONLY the render clock (a display
       * concern) - it never writes scene.tick, never emits a GridCommand, never
       * touches the event log (threat T-26-01), so it cannot become a
       * determinism/tamper backdoor. Mirrors the read-only `scene()` discipline;
       * left null in production it is fully inert.
       */
      pinClock(n: number | null): void;
      /**
       * SLOT-04 trailing item-interpolation toggle (production-inert, D-10).
       * `setItemInterpolation(true)` makes each dot GLIDE from the slot it was in to the
       * slot it is in over that belt's own advance interval; `(false)` - THE DEFAULT -
       * draws every dot at its current slot, byte-identical to the pre-Phase-62 renderer.
       *
       * ALWAYS EXPOSED AND NOT OPTIONAL, on `pinClock`'s model rather than
       * `simulateStreamDrop`'s DEV gate, for a MEASURED reason: `import.meta.env.DEV` is
       * statically false in the production bundle the real WebKitGTK binary embeds, and
       * that binary is the ONLY build the D-19 pace sitting is held on (62-CONTEXT.md
       * D-16). A DEV-gated toggle would be absent exactly where it is needed. It is safe
       * to ship because it writes ONLY a render-side boolean the item layer reads when
       * placing dots - never scene.tick, never a GridCommand, never the event log
       * (threat T-62-15) - so inertness is the proof, not absence. This is deliberately a
       * DIFFERENT mechanism from the belt-speed switch (plan 62-07), which writes SIM
       * state and therefore needs a build gate and an absence proof.
       */
      setItemInterpolation(on: boolean): void;
      /**
       * SAFE-01 dev-only stream-drop simulator. `simulateStreamDrop(true)` makes
       * the transport.onPacket handler ignore inbound bytes entirely, so the
       * playing-gated stall watchdog stalls EXACTLY as a real render-stream drop
       * would (the canvas freezes on its last frame; the watchdog is never reset)
       * and flips the readout to the sticky 'disconnected' fault. `(false)`
       * resumes delivery, so the next real packet signals reconnect -> idle.
       * DEV-guarded at the install site so it is tree-shaken from production
       * (threat T-25-06-INFO); optional here because the property is absent in a
       * production build. It writes ONLY a render-delivery flag - no scene,
       * command, or log write (determinism boundary untouched, T-34-DET).
       */
      simulateStreamDrop?(on: boolean): void;
      /**
       * Phase 90 review WR-C-03 (DEV only): how many controls (`sendControl`) and gestures
       * (`sendInput`) the page has handed to the transport since it loaded. The fatal spec reads
       * them before and after the keys and clicks on a stopped board: nothing may be sent.
       */
      controlsSent?(): number;
      inputsSent?(): number;
      /**
       * SAFE-03 quit-guard entry (production-inert, always exposed). Runs the SAME
       * dirty-only decision the real Tauri `onCloseRequested` handler runs: if the
       * board is dirty it opens the QuitGuardDialog and returns `true` (intercepted,
       * matching `event.preventDefault()`); if it is clean/just-saved it opens
       * nothing and returns `false` (the window would quit with no nag). It only
       * ever opens a CANCELABLE confirm — it never writes scene/command/log and never
       * destroys the window itself (T-34-QUIT / T-34-DET). Always-exposed (like
       * `camera()`/`frame()`) because the Chromium e2e drives the dirty-only gate +
       * dialog discipline through it in dev AND CI; the real OS close still drives it
       * under Tauri where `onCloseRequested` fires instead.
       */
      requestQuit(): boolean;
      /**
       * Phase 90 (D-03, research Finding I): how many EDIT gestures this page has sent that
       * the host has not answered yet (the size of `editGesturesRef`). An accept marks the
       * board unsaved, so a live helper that reads the `Unsaved` badge before New or an
       * example waits for this to reach 0 on a playing board first. A read of a counter
       * only: it writes nothing (T-90-14). Always exposed, like `requestQuit`.
       */
      editsAwaitingVerdict(): number;
      /**
       * Phase 90 review WR-B-03: whether New, Open, an example or quit would ask first: the
       * board's unsaved edits, or edits queued on the paused board that the host holds until
       * Play. A read only: it writes nothing. Always exposed, like `requestQuit`.
       */
      hasUnsavedWork(): boolean;
      /**
       * WUI-01 live wire-visual gate helper: resolve a node handle to its loopback
       * POST URL over the dev-WS `webhook_url` bridge (40-05) — a `/hook/src-<id>` for
       * a Source or a `/endpoint/<path>` for a Route (`/route-<n>` until a path is
       * typed; the demo headline wire's
       * caller). Read-only introspection: it only READS the host-formatted URL (no
       * scene/command/log write), so the e2e can drive a REAL hop against the live
       * demo wire. Resolves `null` for a non-addressable handle or off the dev
       * transport. Always exposed (the live gate runs in CI on the dev transport).
       */
      webhookUrl(handle: number): Promise<string | null>;
    };
  }
}

/**
 * Track `window.devicePixelRatio` and re-render on a DPR change (CHROME-04). A
 * `matchMedia('(resolution: <dpr>dppx)')` query matches ONLY while the DPR equals
 * the value it was built with, so its `change` event fires exactly when the DPR
 * shifts (e.g. the window is dragged across a monitor boundary) - far cheaper and
 * more precise than polling `devicePixelRatio` on every resize (RESEARCH "Don't
 * Hand-Roll"). After a change we re-subscribe with the NEW dpr query (effect dep).
 * SUPERSEDED CLAUSE, QUOTED (plan 59-05). This said the value "drives the bezel re-bake
 * + `--fab-bezel-width` in `skinToCssVars`". Both named things are gone: 59-03 replaced
 * the raster bezel with a composed inset ring and 59-05 deleted the token and the bake.
 * What the value drives now is `--fab-bezel-band`, the ring's hairline snap
 * (`round(dpr)/dpr`), so each band is a WHOLE number of device px at every bucket. The
 * ring THICKNESS is deliberately DPR-invariant, which is why the border box no longer
 * moves with the DPR. Font sizes have been DPR-independent since Phase 47, so the band
 * snap is the only remaining consumer.
 */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() =>
    typeof window !== 'undefined' ? window.devicePixelRatio : 1,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onChange = (): void => setDpr(window.devicePixelRatio);
    const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    // `change` on the resolution query fires when this DPR stops matching; the
    // resize fallback covers engines that don't emit resolution-media changes.
    mql.addEventListener?.('change', onChange);
    window.addEventListener('resize', onChange);
    return () => {
      mql.removeEventListener?.('change', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, [dpr]); // re-subscribe against the new DPR query after each change
  return dpr;
}

/**
 * The stable empty ports array handed to the ConfigPanel when nothing is
 * selected / the selected node is portless. A module-level singleton so the
 * no-ports case never allocates a fresh array per poll tick (which would defeat
 * React's bail-out and re-render the panel 10x/sec forever).
 */
const NO_PORTS: PortView[] = [];

/**
 * The stable empty flow map for the no-selection / portless case - the `NO_PORTS`
 * sibling. A fresh `new Map()` per poll tick would be a new reference every
 * 100ms, defeating React's bail-out exactly the way a fresh array would.
 */
const NO_FLOW: Map<number, PortFlow> = new Map();

/**
 * BELT-01: the stable EMPTY belt run - the `NO_PORTS`/`NO_FLOW` sibling, held for
 * the same identity reason. Passed while no belt is selected (at which point the
 * belt ConfigPanel is not mounted at all), and for the transient in which a
 * selected belt has already left the scene.
 */
const NO_RUN: BeltRunEntry[] = [];

/**
 * LINK-09: the stable EMPTY belt rows - the `NO_PORTS`/`NO_FLOW` sibling, held for
 * the transient in which a belt has left the scene while the selection has not yet
 * cleared. A belt that IS in the scene always has two rows (D-06); this is the
 * answer for one that is not, and it is a singleton so the poll bails out of a
 * React update by IDENTITY.
 */
const NO_BELT_ROWS: { ports: PortView[]; flow: Map<number, PortFlow> } = {
  ports: NO_PORTS,
  flow: NO_FLOW,
};

/**
 * SERVE-05: the stable EMPTY neighbour list - the `NO_PORTS`/`NO_FLOW`/`NO_RUN`
 * sibling, held for the same identity reason. Passed whenever the selected machine
 * is not a Route (so there are no other Routes to be duplicated against) and for
 * the transient before the first sweep resolves.
 *
 * It is a REAL value a caller passes deliberately, never a default the type system
 * hands out: an empty list reads as "no other Route claims this path", so a
 * forgotten prop would turn the duplicate gate off in silence.
 */
const NO_ROUTES: readonly RouteNeighbour[] = [];

/**
 * SERVE-05: how often the OTHER Routes' committed paths are re-read, in ms.
 *
 * Slower than the ~10Hz chrome poll ON PURPOSE, and only running at all while a
 * Route is selected. A neighbour's committed path changes on exactly one event -
 * that neighbour's own Apply - which is a human gesture on a machine the user is
 * not currently looking at. A second is far inside the time it takes to type a path
 * and press Apply, and each sweep costs ONE host query per other Route on the board.
 *
 * A stale entry cannot produce a wrong COMMIT in any case: the client gate is a
 * courtesy and `fabrico-command`'s `Configure` arm refuses a duplicate
 * independently (D-13). The worst a stale sweep can do is offer an Apply the host
 * then refuses with its own typed sentence, which is the ordinary pre-72-10
 * experience rather than a new failure.
 */
const ROUTE_SWEEP_MS = 1000;

/** A stable signature of a neighbour list, so a sweep that found nothing new bails
 *  out of the React update by IDENTITY - the `NO_PORTS`/`NO_FLOW` discipline. */
function routeNeighbourSignature(routes: readonly RouteNeighbour[]): string {
  return routes.map((r) => `${r.node}:${r.cell_x},${r.cell_y}:${r.path}`).join('|');
}

/**
 * BELT-01: the belt panel's port-edit funnel, which REFUSES every edit.
 *
 * `sendPortEdit` is `ConfigPanelProps`' only route from the panel to an
 * `AddPort`/`RemovePort` on the wire, and a belt panel can raise neither.
 *
 * 74-07 CORRECTS THE REASON THIS USED TO GIVE, which was that a belt declares no
 * `Port` records and its `PortsSection` is gated off entirely. Both halves are
 * now false: a belt declares two ports (74-02) and it renders the section like
 * every other kind (LINK-09). The CONCLUSION is unchanged and is now a narrower,
 * truer statement - `PortsSection` gates `+ Add output` and every per-row `Remove`
 * to `kind === machine_kind.FACTORY`, so no control on a belt panel can reach this
 * funnel, and the core forbids a third belt port in any case. Returning false is
 * the HONEST answer -
 * it says nothing was sent, which is true - rather than arming App's node-keyed
 * latch on a node kind that can never fold the edit that closed it, which is the
 * shape that stranded a panel in CR-01. A module singleton so the identity is
 * stable across renders.
 */
const NO_PORT_EDIT = (): boolean => false;

/**
 * CR-01: the RENDER MIRROR of the selected node's in-flight port edit.
 *
 * The authority is the node-keyed `Map<number, PortEditLatch>` in a ref (below) -
 * a ref, because the send guard has to be correct between two clicks that share
 * one render, and a guard reading state would be trusting a re-render to have
 * landed. This is only what the panel needs to PAINT: is an edit unacknowledged,
 * and has it gone unfolded long enough (in SIMULATED ticks) to offer the user a
 * way out (WR-01).
 */
interface PortEditMirror {
  readonly pending: boolean;
  readonly stalled: boolean;
  /** 74.1-19 (re-walk J10): the pending status LINE may show, from `portEditGrace`:
   *  false for `PORT_EDIT_PENDING_GRACE_MS` after a send (true at once while paused),
   *  so a fold inside the grace paints no status text. */
  readonly visible: boolean;
}

/** The stable "no edit in flight" mirror - a singleton so the poll can bail out
 *  of a React update by IDENTITY, the `NO_PORTS`/`NO_FLOW` discipline. */
const PORT_EDIT_IDLE_MIRROR: PortEditMirror = { pending: false, stalled: false, visible: false };

/**
 * 74.1-19: would the host refuse one more output on `node` because a belt is in the way?
 * Only a Factory edits its outputs, so every other kind answers false without a walk.
 * The walk asks only about the cells the box would GROW onto, so a Factory with a free
 * Out slot costs nothing beyond reading its ports.
 */
function addBlockedByBelt(scene: OccupancyScene, node: NodeView | undefined): boolean {
  return (
    node !== undefined &&
    node.kind === machine_kind.FACTORY &&
    addOutputVerdict(node, sceneCellOwner(scene)).kind === 'blocked-by-belt'
  );
}

/**
 * A cheap structural signature of a node's ports (PANEL-02 churn guard, the WR-06
 * discipline the chrome snapshot uses at ~10Hz). Every field is an integer, so
 * the string compare is EXACT - no float drift, no deep-equal walk. Ports change
 * only on an AddPort/RemovePort/Rotate/Move, i.e. a handful of times per session,
 * so the panel quiesces between edits instead of re-rendering on every poll.
 */
function portsSignature(ports: PortView[]): string {
  let sig = String(ports.length);
  for (const p of ports) {
    sig += `|${p.index},${p.role},${p.side},${p.medium},${p.cell_x},${p.cell_y}`;
  }
  return sig;
}

/**
 * The PANEL-04 flow churn guard: a per-port `{docked, carrying, backedUp}` signature, kept
 * SEPARATE from `portsSignature` on purpose. Flow changes whenever a docked belt
 * fills, empties or jams (often); port topology changes only on an
 * AddPort/RemovePort/Rotate/Move (rarely). Folding the two together would make a
 * filling belt look like a topology change and re-run the whole I/O list build,
 * so each payload carries its own guard and quiesces independently.
 *
 * Iteration is over the map's INSERTION order, which `selectedNodePortFlow` seeds
 * from `node.ports` - a deterministic order, and every field is an integer (or a
 * short ASCII link tag), so the string compare is exact.
 *
 * THE LINK IS PART OF THE SIGNATURE (WINDOWS row 126, closed by plan 67-05).
 * `PortFlow.link` was added by 67-02 for CONNECT-01's Disconnect control and the
 * guard did not hash it, so a link REPLACED between two 10Hz polls - unlink one
 * belt, dock another to the same port, both carrying the same item count - left
 * `{docked, count}` byte-identical and the panel kept a Disconnect naming the
 * OLD belt id. The host re-resolves the port and answers an already-gone link as
 * an accepted no-op, so the worst case was one wasted command rather than a
 * wrong-target unlink; it is fixed because a control that names a stale target is
 * still a control that is lying about what it will do. Every field the button
 * DISPATCHES on is now hashed: the kind, the belt handle and its end, or the
 * wire node handle. Item flow never changes a link identity, so this adds no
 * churn to the case the separate flow guard exists for.
 *
 * EXPORTED FOR ONE REASON: to be tested (67-REVIEW IN-02, 67-SECURITY warning
 * 2). The fix above shipped with zero coverage and 67-05 said so plainly rather
 * than hiding it. IN-02 proposed exporting `linkTag` ALONE; that half does not
 * survive contact with the mechanism, because a `linkTag` assertion stays green
 * against a `flowSignature` that never calls it - which is exactly the bug. So
 * `flowSignature` is exported too and `App.flowSignature.test.ts` pins the
 * mechanism: identical counts, different links, DIFFERENT signatures. Neither
 * function is used outside this module in production; the export is the seam,
 * not an interface.
 */
export const linkTag = (link: PortFlow['link']): string => {
  if (link === undefined) {
    return '-';
  }
  if (link.kind !== 'belt') {
    return `w${link.wire}`;
  }
  // LINK-09: THE TARGET IS PART OF THE TAG, for the reason WINDOWS row 126 records
  // about the link itself. `{belt, end}` alone is not a link identity on a BELT
  // row: an upstream Head that unlinks from one neighbour and re-docks to another
  // between two 10Hz polls keeps the same carrier and the same end, so an
  // untagged target would leave the panel offering a Disconnect that names the
  // node it used to reach. Every field the button DISPATCHES on is hashed.
  const target = link.target === undefined ? '' : `>${link.target.node}.${link.target.port}`;
  return `b${link.belt}.${link.end}${target}`;
};

/** The reached machine's tag (phase 91, UI-SPEC 8.6): a Router names its outputs by
 *  it, so a belt re-docked from a Sink to a Merge between two polls must move the
 *  signature, or the segment keeps naming the Sink. */
const reachTag = (reach: PortFlow['reaches']): string =>
  reach === undefined ? '-' : `${reach.node}.${reach.kind}.${reach.input}.${reach.inputs}`;

export function flowSignature(flow: Map<number, PortFlow>): string {
  let sig = String(flow.size);
  for (const [index, entry] of flow) {
    // Phase 91 (CHROME-13): the STATE, never a count. A row shows `idle`, `moving` or
    // `backed up`, so an item stepping along a moving belt changes nothing on screen
    // and must not re-render the list; a belt jamming (moving to backed up, the item
    // count unchanged) must.
    sig += `|${index},${entry.docked ? 1 : 0},${entry.carrying ? 1 : 0},${entry.backedUp ? 1 : 0},${linkTag(entry.link)},${reachTag(entry.reaches)}`;
  }
  return sig;
}

/** The delete control's size in px (DeleteControl width): it is 32px square. */
const DELETE_CONTROL_SIZE = 32;

/**
 * One frame of the floating DeleteControl's placement (IX-04, plan 76-15): glue the
 * anchor `el` to the TOP-LEFT corner of `node`'s selection ring, projected to screen
 * through the read-only camera snapshot `cam` (world * scale + pan). The rotate handle
 * sits diagonally outside the ring's TOP-RIGHT corner (+HANDLE_OFFSET, overlay.ts); the
 * delete control mirrors it at the TOP-LEFT (-HANDLE_OFFSET - size) so the two
 * affordances never overlap (UI-SPEC 4). The ring origin mirrors overlay.showSelection:
 * cellOriginX(cell_x)+INSET, cellOriginY(cell_y)+INSET.
 *
 * Exported as the seam a jsdom case drives on a detached element, because the frame it
 * guards (a keyframe applied, React not yet committed) cannot be reached through
 * React's own rendering in a unit test. `stillSelected` says whether the handle React
 * last rendered is still the live selection; when it is not, the anchor is hidden.
 * `node` is what the live scene holds on that handle, `undefined` when it holds nothing
 * (a keyframe from an Undo of that machine's Place, a New, or a Load of a smaller
 * board); then the anchor is hidden too, whatever `stillSelected` says.
 */
export function placeDeleteAnchor(
  el: HTMLElement,
  cam: { x: number; y: number; scale: number },
  node: (Pick<NodeView, 'cell_x' | 'cell_y'> & Partial<Pick<NodeView, 'w' | 'h' | 'rot'>>) | undefined,
  stillSelected: boolean,
  rings: ReadonlyArray<{ x: number; y: number }> = [],
): void {
  // CR-01: on the frame a keyframe reminted the selected handle (the live selection
  // nulled, React not yet committed) the control is hidden where it stands, never
  // moved onto the node the keyframe put on the handle. A handle the scene no longer
  // holds hides it the same way (76-15 refuter round): the control would otherwise
  // stay shown at the vanished machine's old position until React commits.
  if (!stillSelected || node === undefined) {
    el.style.visibility = 'hidden';
    return;
  }
  el.style.visibility = 'visible';
  const { ew, eh } = effectiveBox(node.w ?? 1, node.h ?? 1, node.rot ?? 0);
  const worldX = node.cell_x * CELL + INSET;
  const worldY = node.cell_y * CELL + INSET;
  const ringL = worldX * cam.scale + cam.x;
  const ringT = worldY * cam.scale + cam.y;
  const ringR = (worldX + ew * CELL - 2 * INSET) * cam.scale + cam.x;
  const ringB = (worldY + eh * CELL - 2 * INSET) * cam.scale + cam.y;
  // THE CONTROL NEVER COVERS A WARNING RING (phase 89 UI review UI-01). Right after a turn cuts
  // a belt the turned machine is still selected, and the control's shipped place, beside the
  // ring's top-left corner, sat on the cut belt end's ring whenever that end was the tile left of
  // the machine's top row: half the one cue that says a feed is cut, under an opaque button. So
  // four places are tried in order, and the first whose square clears every PLOTTED ring
  // (`rings`, world px, read off the ring Graphics by App) is used: beside the top-left (shipped,
  // mirroring the rotate handle outside the top-right), under the bottom-left, over the top-left,
  // beside the bottom-right. With every place covered it stays where it always was.
  const corners: Array<[number, number]> = [
    [ringL - HANDLE_OFFSET - DELETE_CONTROL_SIZE, ringT - HANDLE_OFFSET],
    [ringL - HANDLE_OFFSET, ringB + HANDLE_OFFSET],
    [ringL - HANDLE_OFFSET, ringT - HANDLE_OFFSET - DELETE_CONTROL_SIZE],
    [ringR + HANDLE_OFFSET, ringB + HANDLE_OFFSET - DELETE_CONTROL_SIZE],
  ];
  const reach = (DELETE_RING_CLEAR_R * cam.scale) + DELETE_RING_MARGIN_PX;
  const covers = ([x, y]: [number, number]): boolean =>
    rings.some((r) => {
      const sx = r.x * cam.scale + cam.x;
      const sy = r.y * cam.scale + cam.y;
      const dx = Math.max(x - sx, 0, sx - (x + DELETE_CONTROL_SIZE));
      const dy = Math.max(y - sy, 0, sy - (y + DELETE_CONTROL_SIZE));
      return Math.hypot(dx, dy) < reach;
    });
  const [left, top] = corners.find((c) => !covers(c)) ?? corners[0];
  el.style.transform = `translate(${left}px, ${top}px)`;
}

/** The warning ring's outer radius in world px: radius 8 plus half its 2 px stroke (overlay.ts). */
const DELETE_RING_CLEAR_R = 9;
/** Screen px of floor the control keeps between itself and a warning ring. */
const DELETE_RING_MARGIN_PX = 2;

/** The ConfigPanel's port-edit seam (`ConfigPanelProps.sendPortEdit`). */
type PortEditSend = (
  node: number,
  kind: PortEditKind,
  portsKey: string,
  bytes: Uint8Array,
) => boolean;

/** What a caller of the send seam may say about one gesture (phase 88, D-02). */
export interface GestureSendOpts {
  /**
   * The board generation of the handles this gesture names. Omitted, the seam stamps the
   * generation of the latest applied packet, which is right for a gesture made from what is
   * on screen now. A follow-up made from an older verdict names that verdict's generation
   * (plan 88-05), so it is resolved against the table its handles came from.
   */
  generation?: number;
  /**
   * What this gesture will take once it folds (phase 88, plan 88-07, BELT-06, D-09): its cells
   * and the sources its links will use, built by the caller from the typed command it still
   * holds (never by decoding the outgoing bytes). The seam registers it under the gesture id it
   * returns, in the claims store every occupancy reader receives on the scene, and the claim
   * ends on that gesture's own answer, at a swap, or on the playing-tick fallback.
   */
  claim?: QueuedClaim;
  /**
   * A follow-up the client sends on its own, addressed where only the host can tell whether
   * its machine still lives (phase 88 security re-audit, T-88-25): its refusal shows no
   * sentence (`input/quietGestures.ts`). The host still answers it and nothing else changes.
   */
  quiet?: boolean;
  /**
   * Whether this gesture is an edit the user made (phase 90, D-03). Omitted means an edit:
   * its accept marks the board unsaved (`dirtyAfterVerdict`). Only Undo and Redo pass
   * `false`, so their accepts keep the undo rule (they never set the flag).
   */
  edit?: boolean;
}

/**
 * The id and generation the send seam stamps on ONE gesture (phase 88, D-02, D-06), split
 * out of `App`'s `submitInput` so it can be tested without mounting App (Pixi needs a GL
 * context). `counter` is the page-lifetime gesture counter: it starts at 0, so the first
 * gesture is 1, and it advances by exactly one per call. `sceneGeneration` is the latest
 * applied packet's generation, used unless `opts.generation` names one.
 */
export function stampGesture(
  counter: { current: number },
  sceneGeneration: number,
  opts?: GestureSendOpts,
): { gestureId: number; generation: number } {
  counter.current += 1;
  return { gestureId: counter.current, generation: opts?.generation ?? sceneGeneration };
}

/**
 * The ConfigPanel's `sendInput` seam for a panel rendered for selection `subject` (plan
 * 76-17 and its refuter round, review CR-01, threat T-76-44): it sends only while `live`
 * still equals `subject`. App passes its SELECTION EPOCH (`selectionEpoch.ts`): `live`
 * is the live counter, which every selection change and every full keyframe moves
 * synchronously, and `subject` is the epoch the panel was rendered for.
 *
 * WHY. A full keyframe (after an Undo, a Redo, a Load or a New) remints render handles,
 * and the panel unmounts only when React commits the deselect that keyframe queues.
 * Until then its Apply, belt pace and Disconnect still send to the old handle, which now
 * names whatever node the keyframe put there. The host's kind pairing
 * (`crates/fabrico-command/src/command.rs`, the Configure arm near line 838) refuses a
 * Label config only onto a MACHINE, so a label handle reminted onto another label would
 * have that label's words, colour and size silently overwritten. Every command the panel
 * transmits goes through this seam or `portEditWhileSelected`, so gating both here
 * covers every control by construction.
 *
 * WHY AN EPOCH AND NOT THE HANDLE (the 76-17 refuter round). Plan 76-17 compared the
 * selected HANDLE, which cannot tell the old node from the node a keyframe reminted onto
 * the same number: the keyframe clears the selection, the user selects the node now on
 * that handle, and the number is back. Then a Factory Apply still awaiting
 * `validate_factory_js` sent the old source onto that node. A reselect made before React
 * committed the deselect kept the old panel mounted, with the old buffer, under the same
 * key. The epoch moves on both of those events, so neither passes.
 *
 * ONE BEHAVIOUR CHANGE, ACCEPTED. A Factory Apply awaits `validate_factory_js` before it
 * sends. If the selection changes, or a keyframe lands, while that round trip is in
 * flight, the Apply is dropped rather than sent after its panel has unmounted, even when
 * the user comes back to a node on the same handle number.
 */
export function sendWhileSelected(
  live: { readonly current: number | null },
  subject: number | null,
  send: (bytes: Uint8Array, opts?: GestureSendOpts) => void,
): (bytes: Uint8Array, opts?: GestureSendOpts) => void {
  // Plan 88-07: `opts` (a label resize's claim) passes through untouched.
  return (bytes, opts) => {
    if (live.current !== subject) return;
    if (opts === undefined) send(bytes);
    else send(bytes, opts);
  };
}

/**
 * The ConfigPanel's `sendPortEdit` seam for a panel rendered for selection `subject`
 * (plan 76-17, CR-01): `sendWhileSelected`'s twin for Add output and Remove, over the
 * same selection epoch. When `live` no longer
 * equals `subject` nothing is sent and it reports `false` (nothing was sent), so no
 * port-edit latch is armed for an edit that never left; otherwise it returns what
 * `sendPortEdit` returns.
 */
export function portEditWhileSelected(
  live: { readonly current: number | null },
  subject: number | null,
  sendPortEdit: PortEditSend,
): PortEditSend {
  return (node, kind, portsKey, bytes) => {
    if (live.current !== subject) return false;
    return sendPortEdit(node, kind, portsKey, bytes);
  };
}

/** What `useDeleteGuard` needs from App: the one Delete emit path and a belt read. */
export interface DeleteGuardDeps {
  /** Issue the single logged Delete for `handle` (gestures.commitDelete). */
  commitDelete(handle: number): void;
  /**
   * The summed in-flight item count of the belts `beltIds`, read off the live render
   * model (window.__fabrico), or `null` while that model is briefly absent (e.g. a
   * StrictMode remount window), which the drain treats as "keep waiting", never as zero.
   */
  beltItems(beltIds: number[]): number | null;
}

/** The delete guard's state and its outcomes, as `useDeleteGuard` returns them. */
export interface DeleteGuardApi {
  /** The open guard, or `null` when closed (React state: what the dialog renders). */
  guard: DeleteGuard | null;
  /** A ref mirror of `guard`, readable by the once-created gesture controller. */
  guardRef: { current: DeleteGuard | null };
  /** Open the guard (the gesture layer's `onDeleteWithItems`). Ref-stable. */
  openGuard(handle: number, count: number, kind: 'belt' | 'machine', beltIds: number[]): void;
  /** Cancel / Escape / scrim-click / full keyframe: stop any drain, issue nothing. Ref-stable. */
  cancelGuard(): void;
  /** Stop the passive drain poll, if one is running. Ref-stable. */
  stopDrain(): void;
  /** Delete anyway: one Delete now. */
  deleteAnyway(): void;
  /** Drain first: poll the docked belts to zero, then one Delete. */
  drainFirst(): void;
}

/**
 * The delete-with-in-flight-items guard (REND-03): its state, its drain poll and its
 * three outcomes. Every outcome routes through the single `deps.commitDelete` emit
 * path, so exactly one logged Delete is ever issued (Cancel issues none). No new command
 * vocabulary: "Drain first" is a UI-orchestrated wait, NOT a stop-feed command.
 *
 * A hook (plan 76-16) so a jsdom case can drive the real outcomes through the real
 * DeleteGuardDialog on the frame a keyframe lands, which App itself cannot be mounted
 * to reach (Pixi needs a GL context).
 */
export function useDeleteGuard(deps: DeleteGuardDeps): DeleteGuardApi {
  // `null` until a delete of an item-carrying element intercepts; resolves into
  // exactly one commitDelete.
  const [guard, setGuard] = useState<DeleteGuard | null>(null);
  // A ref mirror of `guard` so the gesture controller (created ONCE in the mount
  // effect, closing over the initial state) can read the LIVE modal-open status
  // via `isModalOpen` without being re-created (WR-01). Kept in sync below.
  const guardRef = useRef<DeleteGuard | null>(null);
  guardRef.current = guard;
  // The active passive-drain rAF handle (0 = idle). Held in a ref so Cancel /
  // unmount can stop the poll without re-rendering.
  const drainRaf = useRef(0);

  const stopDrain = useCallback((): void => {
    if (drainRaf.current) {
      cancelAnimationFrame(drainRaf.current);
      drainRaf.current = 0;
    }
  }, []);

  /**
   * Cancel / Escape / scrim-click / full keyframe: stop any drain and issue
   * NOTHING. Ref-stable (useCallback, stable deps) so the once-registered
   * packet handler can invoke it on a `full:true` keyframe (WR-06) without
   * closing over a stale render's state.
   *
   * CR-01 (plan 76-16): the ref is nulled FIRST and synchronously. `setGuard(null)`
   * only queues React state, so on the in-between frame (a keyframe applied, React
   * not yet committed) the dialog rendered for the old handle is still mounted with
   * Delete anyway and Drain first live, and a keyframe remints handles, so the old
   * handle may now name a different node. Both outcomes and the drain tick read this
   * ref, never the render's `guard`, so a click on that frame sends nothing.
   */
  const cancelGuard = useCallback((): void => {
    guardRef.current = null;
    stopDrain();
    setGuard(null);
  }, [stopDrain]);

  // REND-03: a delete of an element still carrying in-flight items defers here
  // (no command emitted yet). If a guard is ALREADY open, ignore: never reset a
  // guard mid-drain (WR-01: a reset would resurrect the Drain/Delete buttons over
  // a running loop). Ref-stable, because the mount-once gesture controller
  // captures it.
  const openGuard = useCallback(
    (handle: number, count: number, kind: 'belt' | 'machine', beltIds: number[]): void => {
      if (guardRef.current) {
        return;
      }
      setGuard({ handle, count, kind, beltIds, draining: false });
    },
    [],
  );

  /**
   * Delete anyway: one Delete now; core BELT-08 deterministically discards items.
   * Reads the LIVE ref (CR-01, WR-06): after a keyframe's `cancelGuard` it is null on
   * the in-between frame, so a click there sends no Delete for the reminted handle.
   * Closing through `cancelGuard` nulls the ref too, so a second click before React
   * commits cannot send a second Delete.
   */
  const deleteAnyway = (): void => {
    const g = guardRef.current;
    if (!g) {
      return;
    }
    cancelGuard();
    deps.commitDelete(g.handle);
  };

  /**
   * Drain first: PASSIVE poll-until-zero (CONTEXT / RESEARCH Pitfall 3): there is
   * NO stop-feed GridCommand, so we just poll the docked belts' in-flight item
   * COUNT via the read-only window.__fabrico introspection model until it reaches
   * zero, updating the "Draining… N left" readout each tick, then issue the SINGLE
   * Delete. Cancel stops the poll with no command. If an upstream source keeps
   * feeding, the count may never converge; the dialog stays Cancel-able and the
   * user is expected to pause the sim; we introduce NO new command and NO extra
   * Unlink/Delete.
   */
  const drainFirst = (): void => {
    // CR-01, WR-06: the LIVE ref, null on the in-between frame after a keyframe's
    // `cancelGuard`, so a click there starts no loop and never brings the dialog back
    // over the new board.
    const g = guardRef.current;
    if (!g) {
      return;
    }
    // Cancel any in-flight drain before starting a new loop (WR-01). Without this
    // a second "Drain first" would overwrite `drainRaf.current` and leave the
    // prior rAF loop running; two loops would each fire `commitDelete` at zero,
    // logging two `Delete`s for one node (SC5 violation).
    stopDrain();
    // The ref mirrors the draining guard at once (not only on React's next render),
    // because the drain tick below reads it.
    const draining = { ...g, draining: true };
    guardRef.current = draining;
    setGuard(draining);
    const tick = (): void => {
      // CR-01: the drain commits only while the guard is still open. A keyframe's
      // `cancelGuard` nulls the ref (and stops this loop), so a tick that still runs
      // never sends a Delete for a handle the keyframe reminted.
      if (guardRef.current === null) {
        drainRaf.current = 0;
        return;
      }
      const remaining = deps.beltItems(g.beltIds);
      if (remaining === null) {
        // Hook briefly absent (e.g. a StrictMode remount window): keep waiting
        // rather than treating "no scene" as drained to zero.
        drainRaf.current = requestAnimationFrame(tick);
        return;
      }
      setGuard((cur) => (cur ? { ...cur, count: remaining } : cur));
      if (remaining <= 0) {
        drainRaf.current = 0;
        cancelGuard();
        deps.commitDelete(g.handle);
        return;
      }
      drainRaf.current = requestAnimationFrame(tick);
    };
    drainRaf.current = requestAnimationFrame(tick);
  };

  return { guard, guardRef, openGuard, cancelGuard, stopDrain, deleteAnyway, drainFirst };
}

/**
 * App chrome root. The Pixi canvas is mounted OUTSIDE React's reconciler
 * (`app.canvas` appended once to a ref'd div, Pattern 1) and React renders ONLY
 * the floating chrome (Palette / Toolbar / panels) over it; it never re-renders or
 * wraps the canvas (T-07-STRICTMODE-DUP). React 19 StrictMode double-invokes this
 * effect in dev, so a `disposed` flag + `app.destroy(true)` guard keeps a single
 * Application / canvas / GL context.
 *
 * Wiring (07-09): on boot it connects the transport's inbound packets into the
 * scene buffer (the authoritative echo path), builds the gesture controller bound
 * to 07-07's overlay handle, and polls the echoed scene to drive the chrome
 * readouts. Every gesture is one logged GridCommand; the canvas reflects only the
 * sim echo — no optimistic local writes (SC5, VIS-05).
 */
export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<SceneHandle | null>(null);
  /**
   * The page-lifetime gesture counter (phase 88, D-06): the id of the last gesture
   * `submitInput` framed. Every gesture takes the next one, starting at 1; the host's
   * verdict on a gesture names it back as `seq`. Never reset within a page. A reload starts
   * a new page whose counter starts at 1 again, so ids repeat across page loads; what keeps
   * the old page's answers off the new page is the host, not the id. The dev WebSocket
   * answers each gesture on the socket that sent it, and the Tauri shell on the verdict
   * route that was current when it was sent, one route per `subscribe_gesture_verdicts`
   * (`crates/fabrico-app/src/lib.rs` `VerdictRoutes`, phase 88 review CR-01). Until that
   * fix the Tauri shell had one verdict channel for the process, and a reload handed the
   * old page's queued verdicts to the new page under ids it was about to reuse.
   */
  const gestureIdRef = useRef(0);
  /**
   * The queued gestures the editor counts as taken (phase 88, plan 88-07, BELT-06, D-09): one
   * claim per gesture sent and not yet answered, keyed by the id `submitInput` returned. It is
   * put on the scene object every occupancy reader receives (`sceneState.queuedClaims`), fed
   * every verdict, packet and Resume, and cleared on a swap's keyframe. One per page.
   */
  const queuedClaimsRef = useRef(createQueuedClaims());
  /** The gestures sent quiet and not yet answered (T-88-25 re-audit, `quietGestures.ts`). */
  const quietGesturesRef = useRef(createQuietGestures());
  /**
   * The EDIT gestures sent and not yet answered (phase 90, D-03, WORK-08): every id
   * `submitInput` returns except an Undo's or a Redo's. Its verdict leaves the set and goes
   * through `dirtyAfterVerdict`, so an edit the host accepts marks the board unsaved even when
   * no render packet shows its shape changing. Cleared at every board swap this page
   * dispatches (New, an example) or commits (an Open's swap): an answer that comes after it
   * belongs to the board the swap replaced. Its size is `window.__fabrico.editsAwaitingVerdict`.
   */
  // Review IN-B-02: id -> the scene tick it was sent at, so an id whose answer never pairs is
  // dropped once it is overdue (`dropOverdueEdits`, on every packet) rather than kept until a swap.
  const editGesturesRef = useRef(new Map<number, number>());
  /** A New, an example or an Open was requested: the next restructure keyframe is the swap's. */
  const claimSwapRef = useRef(false);
  /**
   * The cuts still ringed (`strandLifetime.ts`, TODO-FANIN): a warning ring stays until its cut
   * is resolved, so App carries the cuts between packets, and the ring points last shown so an
   * edit that moves no ring repaints nothing (the pulse is not restarted).
   */
  const standingStrandsRef = useRef<StandingStrand[]>([]);
  const shownRingKeyRef = useRef('');
  const gesturesRef = useRef<GestureController | null>(null);
  const transportRef = useRef<ITransport | null>(null);
  // SAFE-03: the dirty-since-last-save flag lives in a REF (not React state) so the
  // async OS close callbacks (Tauri onCloseRequested / web beforeunload) read the
  // CURRENT value without a stale closure. It is the whole dirty tracker: flipped
  // via the pure dirtyState.nextDirty on a genuine non-keyframe structural edit,
  // cleared on Save (dispatch-confirmed) and on Load / Load-demo. Undo/redo
  // keyframes and non-structural re-emits never touch it (T-34-DIRTY-FALSE).
  const dirtyRef = useRef(false);
  // Phase 90 review WR-A-03: the unsaved flag as it stood when the latest Save was sent. The page
  // clears the flag on the send (`saveRequested`); a `saveFailed` from the host puts it back from
  // here, so a Save that was never written cannot leave the board reading saved.
  const dirtyBeforeSaveRef = useRef(false);
  // SAVE-03 smart-Save: the CURRENT known .fab path (frontend-only, never a
  // security decision). Mirrors the dirtyRef shape so async callbacks read the
  // live value. Written by a Save-As pick (onPathChosen below) and by Open (Plan
  // 03); read by smart-Save to re-save with no dialog. NEVER echoed into a
  // status/label/aria-live string (T-32-06-01) - it only routes the dispatch.
  const currentFilePathRef = useRef<string | null>(null);
  // Phase 90 (WORK-07, D-02, research Finding K): a DISPATCHED Open the host has not yet
  // answered. The save target (currentFilePathRef) and the unsaved flag move only on this
  // Load's own swap keyframe (`isLoadSwap` over `floorAtDispatch`, the swap floor the scene
  // stood at when it was dispatched), so a refused or superseded Load never makes Ctrl+S
  // write the board on screen into the file the user tried to open. Dropped by a refusal and
  // by New or an example; replaced by a second Open; NOT dropped by the page's load cut-off,
  // so a swap that still comes moves the target with the board. Never shown (T-32-06-01).
  const pendingLoadRef = useRef<{ path: string; floorAtDispatch: number } | null>(null);
  // SAVE-03: a ref mirror of the freshly-built control handlers so the ONCE-created
  // gesture controller (keyboard Ctrl+S / Ctrl+Shift+S) can reach the LIVE
  // smart-Save closure (which closes over the current transport + path ref)
  // without being re-created each render. Same closure->ref pattern as guardRef.
  const controlsRef = useRef<ControlHandlers | null>(null);
  // Holds the dev frame-time probe so the effect cleanup can detach its ticker
  // callback (GATE-05 baseline), consistent with the reassign-per-mount lifecycle.
  const frameProbeRef = useRef<{ stop(): void } | null>(null);
  // NAV-01: a ref to the ONE shared `doFit` closure created in the mount effect,
  // so the render-level Fit button, boot-fit and the Home key all invoke the SAME
  // fit body (no duplicated fitToFactory call). Assigned once `handle` exists,
  // nulled in cleanup so a torn-down handle is never re-fit.
  const doFitRef = useRef<(() => void) | null>(null);
  // DEMO-07 / D-12 (plan 85-06): a camera fit is PENDING for the next board that loads.
  // Pending at boot (the mount effect re-arms it per mount), set again when the demo or an
  // example is requested (`doLoadScene`), cleared when a Load is refused (no keyframe will
  // come), and taken through `takeFit` by the next restructure keyframe that has nodes. New
  // and a user's .fab Open never set it: New's empty board has nothing to frame, and a user's
  // own board keeps the camera they had (see `onStatus('loading')`). A ref, not a per-mount
  // closure latch, because the load requests are made outside the mount effect.
  const fitPendingRef = useRef(true);
  // Whether the pending fit is the BOOT one rather than a load request's (phase 89, plan 89-07).
  // A board that boots empty leaves the boot fit pending (`takeFit` skips a keyframe with no node),
  // and an Undo or Redo is not a load, so it ends that boot fit (see `doUndo`). A load request's
  // fit is never ended by one: an Undo pressed as an example loads still lets it arrive framed.
  const fitIsBootRef = useRef(true);

  // SAVE-05: the dirty flag surfaced as React state so the Toolbar's "Unsaved"
  // badge reacts to it; the badge is the one unsaved cue (phase 90, CHROME-05: the
  // old tab title marker was never seen in the shipped app and is gone). `dirtyRef`
  // (above) stays the async-safe source of truth for the OS-close callbacks;
  // `setDirty` is the ONE writer that keeps the ref and the React state together. It
  // is change-guarded so the ~60Hz packet path (where most re-emits are
  // non-structural no-ops) never re-renders the chrome.
  const [dirty, setDirtyState] = useState(false);
  const setDirty = useCallback((next: boolean): void => {
    if (dirtyRef.current === next) return;
    dirtyRef.current = next;
    setDirtyState(next);
  }, []);

  // SAVE-05: the per-action discard guard state. `discardGuardOpen` shows the ONE
  // generalized QuitGuardDialog with `discardAction` ('new'|'open'|'example'); a
  // dirty New, Open, or example load opens it BEFORE any board swap / native
  // dialog. `discardGuardOpenRef` mirrors it (like quitGuardOpenRef) so the
  // once-created gesture controller reads the LIVE modal-open status via
  // `isModalOpen`. `discardProceedRef` holds the pending "proceed" continuation
  // the chosen outcome runs (Discard/Save) or drops (Cancel) — for an example
  // load the pending scene id rides this closure (UI-SPEC A3, zero new plumbing).
  const [discardGuardOpen, setDiscardGuardOpen] = useState(false);
  const [discardAction, setDiscardAction] = useState<Exclude<GuardAction, 'quit'>>('new');
  const discardGuardOpenRef = useRef(false);
  discardGuardOpenRef.current = discardGuardOpen;
  const discardProceedRef = useRef<(() => void) | null>(null);
  // Review WR-B-03 / WR-C-10 (walk todo 2026-10-24): THE WORK A NEW, AN OPEN, AN EXAMPLE OR QUIT
  // WOULD LOSE. Since D-03 the board reads unsaved only once the host ACCEPTS an edit, and a paused
  // host answers nothing until Play, so an edit made on a paused board (a Place, a Configure's
  // Apply, an Undo) leaves `dirtyRef` false while it is very much the user's work. The guards ask
  // about both; the `Unsaved` badge stays accept-driven. `queuedEditsRef` (declared below, read at
  // call time) is the page's one record of the queue.
  const unsavedWork = (): GuardWork => ({ unsaved: dirtyRef.current, queued: queuedEditsRef.current !== null });
  const hasUnsavedWork = (): boolean => dirtyRef.current || queuedEditsRef.current !== null;
  // The work as it stood when a guard opened, so the dialog's sentence says what would be lost.
  const [guardWork, setGuardWork] = useState<GuardWork>({ unsaved: true, queued: false });
  const openDiscardGuard = useCallback(
    (action: Exclude<GuardAction, 'quit'>, proceed: () => void): void => {
      discardProceedRef.current = proceed;
      setGuardWork(unsavedWork());
      setDiscardAction(action);
      setDiscardGuardOpen(true);
    },
    [],
  );
  // Cancel: keep the board, drop the pending action, issue NOTHING.
  const cancelDiscardGuard = useCallback((): void => {
    setDiscardGuardOpen(false);
    discardProceedRef.current = null;
  }, []);
  // Discard: proceed losing the unsaved edits (run the pending continuation).
  const discardAnyway = useCallback((): void => {
    setDiscardGuardOpen(false);
    const proceed = discardProceedRef.current;
    discardProceedRef.current = null;
    proceed?.();
  }, []);
  // Save: save THEN proceed (safe: the app keeps running, no destroy race). Routes
  // through the LIVE smart-Save closure (known path re-saves with no dialog, else
  // the Save-As prompt), then runs the pending continuation ONLY on a confirmed write.
  const saveThenProceed = useCallback((): void => {
    if (simStoppedRef.current) return;
    // BL-01 (data loss): the destructive continuation (the New swap / the Open
    // dialog) must run ONLY when the Save genuinely succeeded. onSave resolves
    // `true` on a dispatch-confirmed write, `false` on a cancelled dialog (`idle`)
    // or a failed write (`saveFailed`). On `false` we keep the current board, keep
    // the guard OPEN so the user can re-decide (Save again / Discard / Cancel), and
    // abort the pending New/Open - never silently discarding an unsaved factory
    // (the milestone CANNOT-STRAND / no-data-loss target). We DELIBERATELY do not
    // close the guard or null discardProceedRef up front - both happen only inside
    // the success branch, so a cancel/fail leaves the guard usable rather than
    // stranding the user with a closed dialog and lost work.
    const proceed = discardProceedRef.current;
    void Promise.resolve(controlsRef.current?.onSave())
      .then((saved) => {
        if (saved !== true) return; // cancelled / failed -> keep board + guard
        setDiscardGuardOpen(false);
        discardProceedRef.current = null;
        proceed?.();
      })
      .catch(() => {
        // MD-01: onSave already catches its own dialog rejection and resolves
        // `false`, so this is defense in depth - a stray rejection must not become
        // an unhandled rejection nor strand the pending action. Keep the board and
        // the guard intact so the user can re-decide.
      });
  }, []);

  const [ready, setReady] = useState(false);
  // WR-03: initialize the glyph to match the sim's boot state — it boots in
  // RunState::Playing and ticks live from tick 0, so a `false` here would show a
  // paused glyph over a live-ticking sim until the first click.
  const [playing, setPlaying] = useState(SIM_BOOTS_PLAYING);
  // A ref mirror of `playing` so the once-created gesture controller can read the
  // LIVE optimistic state (for the keyboard Space toggle) without being re-created.
  const playingRef = useRef(SIM_BOOTS_PLAYING);
  playingRef.current = playing;
  // FAIL-01 (D-12): true once the host's sim loop has ended. The stall watchdog writes the
  // status DIRECTLY, past the status machine, so its two writes read this and stand down: the
  // `disconnected` overlay can never replace `simStopped` (research, Anti-Patterns). Plan 90-07:
  // it is also the ONE flag every path that would send to the host reads. The choke points below
  // (`togglePlay`, `doStep`, `doUndo`, `doRedo`, `doLoadScene`, `doNew`, `doOpen`, the Save
  // handlers and `submitInput`) return at once while it is set, the Toolbar and Palette render
  // disabled, and the gesture layer reads it as `isSimStopped`. Declared here, above the first of
  // them.
  const simStoppedRef = useRef(false);
  // SAFE-01: the playing-gated stall watchdog (created lazily below, after the
  // status setter exists). Held in a ref so the once-registered transport.onPacket
  // handler and the play/pause effect both reach the SAME instance without churn.
  const watchdogRef = useRef<StatusWatchdog | null>(null);
  // Review WR-B-02: what a stall writes while the host works on a request (created with the
  // watchdog, below).
  const hostWorkRef = useRef<HostWorkGate | null>(null);
  // SAFE-01 dev-only: when true, transport.onPacket ignores inbound bytes so the
  // watchdog stalls exactly as a real stream drop would (set via the DEV-guarded
  // window.__fabrico.simulateStreamDrop hook). Always false in production.
  const streamDropSimRef = useRef(false);
  // Review WR-C-03: the page-side send counts (`countSends`), read by the DEV hooks.
  const sendCountsRef = useRef<SendCounts>({ controls: 0, inputs: 0 });
  // THE EMPTY-BOARD HINT'S GATE (phase 91, D-10, CHROME-10, research Finding Q). True while the
  // latest decoded scene holds no node (labels included, plan 77-04: a board holding only a note
  // is not an empty floor) and no belt (plan 74.1-31: a board of belts is not empty either). It
  // used to be read off the ~10 Hz chrome poll below, so the hint stayed over the first machine
  // for up to 100 ms after the canvas drew it. It is now set by the packet handler on the empty
  // to non-empty edge (and back) only, inside `flushSync`, so the hint's commit lands before the
  // next animation frame draws the machine. The ref is the edge detector, so no other packet
  // sets state for it.
  const [boardEmpty, setBoardEmpty] = useState(true);
  const boardEmptyRef = useRef(true);
  const [snap, setSnap] = useState({
    tick: 0,
    // Undo/Redo availability from the packet-driven scene (Plan 05). Drives the
    // greyed Toolbar buttons; doUndo / doRedo gate on the live scene at the press.
    canUndo: false,
    canRedo: false,
    // NAV-02 live zoom: the camera worldScale folded into the same ~10Hz poll
    // that feeds the toolbar tick, so the CameraCluster readout tracks pan/zoom live.
    worldScale: 1,
  });

  /**
   * Plan 74.1-31 (PAUSE-TOOLBAR): THE UNDO HOLD. Non-null while edits made on a paused
   * board have not landed; `submitInput` sets it, the packet path clears it. While it is
   * set `doUndo` and `doRedo` send nothing and say so, and the Toolbar renders both
   * buttons disabled (`undoHeld`). See `submitInput`'s docblock for the rule and its
   * reason.
   *
   * The hold ends in one of two ways, and nothing else ends it.
   *
   * 1. THE EDITS LAND. `foldTick` is the scene tick on screen when Play or Step was
   *    requested (`requestQueuedFold`), or null while neither has been. The hold clears on
   *    the first packet whose tick differs from it. It deliberately does NOT clear on any
   *    later tick while paused: a pause DRAINS (`RunState::Draining` keeps ticking for up
   *    to `MAX_SETTLE_TICKS` with input held), so a moving tick on a paused board is not
   *    evidence that anything landed. Measured live on the demo board: 66 to 188 in 3 s
   *    after the Pause click, with the edit still held.
   * 2. A BOARD SWAP DISCARDS THEM (plan 74.1-35, review round 5 CR-01). New, an example
   *    or Open set `swapRequested` (`requestSwapDiscard`), and the hold clears on the
   *    first TIMELINE-RESTRUCTURE keyframe after that (`isTimelineRestructure`: `full` and
   *    not `resync`), which is the keyframe `producer.reset` emits inside the host's
   *    `install_swapped_host`, AFTER the host has discarded every edit queued on the old
   *    board. Not on the request, and not on a tick: a swap requested while the pause
   *    still drains is latched by the host until the drain freezes, and every drained
   *    tick before it is the OLD board with the edits still queued. A default the
   *    maintainer can overturn: the rule reads the packet, not the status machine's
   *    load latch, because a held Ctrl+Z can supersede that latch (review IN-01). A
   *    paused edit sent after the swap request re-arms the hold with `swapRequested`
   *    false, the safe direction: it then waits for Play or Step.
   */
  const queuedEditsRef = useRef<{ foldTick: number | null; swapRequested: boolean } | null>(null);
  const [undoHeld, setUndoHeld] = useState(false);
  /** Play or Step: the queued edits may land from the next tick on. */
  const requestQueuedFold = useCallback((): void => {
    const q = queuedEditsRef.current;
    if (q !== null) q.foldTick = handleRef.current?.sceneState.tick ?? 0;
  }, []);
  /** New, an example or Open: the host discards the queued edits at the swap's keyframe. */
  const requestSwapDiscard = useCallback((): void => {
    const q = queuedEditsRef.current;
    if (q !== null) q.swapRequested = true;
    // Plan 88-07: the swap discards every queued gesture, so their claims end on its keyframe
    // too (each also hears its own discard verdict; this is the floor if one is lost).
    claimSwapRef.current = true;
  }, []);

  // Plan 74.1-28 (WR-05): every play/pause flip tells the port-edit grace IN THE SAME
  // BATCH as the glyph, so the frame that first shows the sim running never shows the
  // grace's stale `visible`. The `[playing]` effect below still runs (it is idempotent),
  // but on its own it landed one frame late: measured live, one frame of "Waiting for the
  // host to apply this change." between the paused wording and nothing. The grace is
  // read through its ref at call time, so declaring it further down is fine.
  const setPlayingNow = useCallback((next: boolean): void => {
    // Review IN-B-04: the ref the keyboard reads moves NOW, not on the next render, so a Space
    // handled in the same frame as a Step's pause reads the board as paused and sends `resume`.
    playingRef.current = next;
    portEditGraceRef.current?.setPaused(!next);
    // Plan 74.1-31: Resume lets the queued edits land (the undo hold may end), and the
    // stall count of every pending port edit restarts here (PAUSED-READOUT: the ticks a
    // pause drained ran with input held, so none of them counts against the edit).
    if (next) {
      requestQueuedFold();
      const tick = handleRef.current?.sceneState.tick ?? 0;
      const latches = portEditLatchesRef.current;
      for (const [node, latch] of latches) latches.set(node, resumePortEdit(latch, tick));
      // Plan 88-05 (D-07): the gesture layer's timed counts (a Place whose verdict was lost,
      // a pending turn) restart at the same Resume tick, by the same rule.
      gesturesRef.current?.onResume(tick);
      // Plan 88-07: so does every queued claim's fallback.
      queuedClaimsRef.current.onResume(tick);
    }
    setPlaying(next);
  }, []);

  // Optimistic Play/Pause: flip the glyph immediately and drive the real host
  // (pause/resume) through the transport control seam (CLEAN-04). Ref-stable so
  // the keyboard gesture (created once in the mount effect) can share it; reads
  // the live transport/playing via refs so it never captures a stale null
  // transport. The glyph reflects sim state with NO schema/IPC field — draining
  // vs settled is inferable from tick-progress (Open Q3 / HOST-02).
  const togglePlay = useCallback((): void => {
    if (simStoppedRef.current) return;
    const next = !playingRef.current;
    setPlayingNow(next);
    transportRef.current?.sendControl(next ? 'resume' : 'pause');
  }, []);

  // D-07 (phase 90, FAIL-03): the ONE step handler, shared by the `.` key (the gesture
  // controller, created once in the mount effect) and the toolbar's Step button, so the two
  // entry points cannot drift. Plan 74.1-31: a Step folds the queued edits (the undo hold may
  // end). Then `controls.onStep`, read through its ref so it is the live closure: on a playing
  // board it calls `setPlaying(false)` (through `setPlayingNow`, which flips the glyph, tells
  // the port-edit grace the board is paused and, through the `[playing]` effect, stops the
  // stall watchdog) before it sends `step`. Ref-stable, like `togglePlay`.
  const doStep = useCallback((): void => {
    if (simStoppedRef.current) return;
    requestQueuedFold();
    controlsRef.current?.onStep();
  }, []);

  // Undo/Redo dispatch (UNDO-04). These ride the GESTURE channel (sendInput), NOT
  // the control seam: Undo/Redo ARE edits and must fold EDITS-FIRST (Area 2 Q1).
  // Ref-stable so the once-created gesture controller shares the SAME gated path
  // as the Toolbar buttons — a single implementation gates both entry points on
  // availability, so no undo/redo command is ever emitted against an empty stack
  // (T-19-03; the host also typed-rejects as defense in depth). Reads transport +
  // availability via refs so it never captures a stale null transport.
  const doUndo = useCallback((): void => {
    if (simStoppedRef.current) return;
    // Plan 74.1-31: held behind paused edits that have not landed. Nothing is sent, and
    // the status says what to do (checked before availability: the paused draw the user
    // most likely means to undo has no undo step of its own until it lands).
    if (queuedEditsRef.current !== null) {
      applyStatus('undoHeld');
      return;
    }
    // Availability is read off the packet-driven scene itself at the press (plan 84-12),
    // so both entry points gate on it and the UI never emits an Undo/Redo the session
    // would reject (Area 4 Q4 - no toast). It used to be a per-frame copy refreshed by the
    // chrome poll, so a key pressed after a packet landed and before the next animation
    // frame read the packet before: on CI's two-core runner a Ctrl+Shift+Z right after an
    // undo was dropped without a word (the early 2026-10-13 CI run, `74.1-port-edit-rings`).
    if (handleRef.current?.sceneState.canUndo === true) {
      // An Undo during a Load leaves the Load pending (phase 90, D-06): its keyframe can no
      // longer resolve `Loaded` (only the Load's own swap keyframe does, `isLoadSwap`), so
      // there is nothing to supersede, and the host discards the Undo with the old board.
      // AN UNDO IS NOT A LOAD (phase 89, plan 89-07): it ends the BOOT fit. A board that booted
      // EMPTY leaves the boot fit pending (`takeFit` skips a keyframe with no node), so until
      // 89-07 the first Undo after building on it re-framed the camera, and mid-draw the board
      // jumped under the hand and the kept path stopped extending (BELT-08's keyframe leg).
      // Between loads nothing re-fits (`sceneFit.ts`). A load request's pending fit is kept:
      // an Undo pressed as an example loads must not cost that example its framing.
      if (fitIsBootRef.current) {
        fitPendingRef.current = false;
      }
      submitInput(encodeGridCommand({ kind: 'Undo' }), { edit: false });
    }
  }, []);
  const doRedo = useCallback((): void => {
    if (simStoppedRef.current) return;
    if (queuedEditsRef.current !== null) {
      applyStatus('undoHeld');
      return;
    }
    if (handleRef.current?.sceneState.canRedo === true) {
      // Nor does a Redo cancel a pending Load (D-06): see doUndo.
      // Nor is a Redo a load: it ends the boot fit too, and keeps a load's (see doUndo).
      if (fitIsBootRef.current) {
        fitPendingRef.current = false;
      }
      submitInput(encodeGridCommand({ kind: 'Redo' }), { edit: false });
    }
  }, []);
  // WR-03 scene loads: New or an example during a Load is a swap of its own, which
  // replaces the pending Load (else its swap keyframe would resolve 'Loaded' for a board
  // the Load did not produce). Ref-stable so the once-created gesture path + Toolbar
  // share it. Defined via a ref so doLoadScene/doNew can reach the LIVE implementation
  // without a declaration-order dependency.
  const supersedeLoadInFlightRef = useRef<(() => void) | null>(null);
  // EX-02: ONE parameterized scene-load path for EVERY shipped scene (the demo,
  // Order processing and Advanced; the demo entry also rides the `loadExample`
  // verb — one path, not two). The dirty gate
  // wraps it per UI-SPEC A3: a dirty board opens the 'example' discard guard
  // FIRST (the pending scene id rides the closure through the shipped
  // discardProceedRef continuation; Cancel drops it — SAVE-05 machinery, zero
  // new plumbing); a clean board loads immediately. The demo load DELIBERATELY
  // gains the guard it lacked before Phase 55 (A3, a closed silent-discard hole).
  const doLoadScene = useCallback(
    (id: SceneWireId): void => {
      if (simStoppedRef.current) return;
      const proceed = (): void => {
        // WR-03 supersede FIRST — same body order the shipped doLoadDemo had.
        supersedeLoadInFlightRef.current?.();
        const transport = transportRef.current;
        if (!transport) {
          // WR-03: with no transport the frame is NOT dispatched, so the host's
          // board never changes. Claiming the scene here (and clearing dirty)
          // would make the badge name a scene the host never loaded and would
          // silently discard the user's dirty marker with it. Do neither.
          return;
        }
        // Plan 74.1-35: the swap discards the edits queued on this board; the hold ends
        // on the swap's own keyframe, never here.
        requestSwapDiscard();
        // DEMO-07 (plan 85-06): the scene's keyframe frames the new board.
        fitPendingRef.current = true;
        fitIsBootRef.current = false;
        transport.sendControl('loadExample', id);
        // Review WR-B-02: the host installs the example in silence.
        if (playingRef.current) hostWorkRef.current?.begin('swap');
        // D-03 (phase 90): an answer to an edit sent before this swap belongs to the board it
        // replaces, so it no longer counts toward the unsaved flag.
        editGesturesRef.current.clear();
        // D-02 (phase 90): the example is not the file the board came from, so the next
        // Ctrl+S asks for a new one; a pending Open is superseded by this swap. After the
        // dispatch, so a Cancel in the discard guard changes neither.
        pendingLoadRef.current = null;
        currentFilePathRef.current = null;
        // A local action now owns the badge: the boot-time host echo must not
        // clobber it if it is still in flight.
        sceneActedRef.current = true;
        // ONB-01 generalized: the badge tracks the control action (the scene's
        // display name), not the resulting keyframe.
        setLoadedScene(SCENE_DISPLAY_NAME[id]);
        // SAFE-03: a scene load replaces the board with a fresh scene, so it is
        // clean (the resulting full keyframe is NOT counted as a user edit).
        // REUSES the existing 'loadDemo' DirtyEvent for ALL scene loads — the
        // dirtyState machine does not grow (SAVE-05: the toolbar badge clears).
        setDirty(nextDirty(dirtyRef.current, 'loadDemo'));
      };
      routeSceneLoad(hasUnsavedWork(), (p) => openDiscardGuard('example', p), proceed);
    },
    [setDirty, openDiscardGuard],
  );

  // SAVE-04/SAVE-05: start a truly EMPTY board via the host-swap New, behind the
  // dirty-discard gate. The `proceed` body is the shipped SAVE-04 swap (sendControl
  // + clear Demo badge + clear dirty via a fresh empty board). SAVE-05 gates it:
  // when the board is dirty, open the 3-choice discard guard FIRST (no swap until a
  // choice); a clean board proceeds directly. A stray New must never silently
  // destroy an in-progress factory (the milestone done-test builds from empty).
  const doNew = useCallback((): void => {
    if (simStoppedRef.current) return;
    const proceed = (): void => {
      supersedeLoadInFlightRef.current?.();
      // Plan 74.1-35: the swap discards the edits queued on this board; the hold ends on
      // the swap's own keyframe, never here.
      requestSwapDiscard();
      transportRef.current?.sendControl('new');
      // Review WR-B-02: the host installs the empty board in silence.
      if (playingRef.current) hostWorkRef.current?.begin('swap');
      // D-03 (phase 90): an answer to an edit sent before this swap belongs to the board it
      // replaces, so it no longer counts toward the unsaved flag.
      editGesturesRef.current.clear();
      // D-02 (phase 90): a New board has no file yet, so the next Ctrl+S opens Save As
      // instead of overwriting the previous board's file; a pending Open is superseded.
      // After the dispatch, so a Cancel in the discard guard changes neither.
      pendingLoadRef.current = null;
      currentFilePathRef.current = null;
      sceneActedRef.current = true;
      setLoadedScene(null);
      setDirty(nextDirty(dirtyRef.current, 'new'));
    };
    if (hasUnsavedWork()) {
      openDiscardGuard('new', proceed);
    } else {
      proceed();
    }
  }, [setDirty, openDiscardGuard]);

  // SAVE-05: open a saved .fab behind the SAME dirty-discard gate as New. The
  // `proceed` body is the Plan-02 smart-Load handler (controlsRef.onLoad: the
  // native Open dialog under Tauri, the dev-prompt fallback otherwise), which on a
  // successful pick dispatches the Load and holds the picked path as pending
  // (`pendingLoadRef`). The Demo badge, the unsaved flag and the save target move on
  // the Load's own swap keyframe (`isLoadSwap`, D-02, review WR-B-06), never on the
  // dispatch. When the board holds unsaved work (review WR-B-03), the guard fires
  // BEFORE the native dialog; otherwise the dialog opens directly.
  const doOpen = useCallback((): void => {
    if (simStoppedRef.current) return;
    const proceed = (): void => {
      void controlsRef.current?.onLoad();
    };
    if (hasUnsavedWork()) {
      openDiscardGuard('open', proceed);
    } else {
      proceed();
    }
  }, [openDiscardGuard]);

  // NAV-01 camera cluster handlers — VIEW-ONLY: they mutate only the camera
  // Container and emit no GridCommand / no packet. Ref-stable so the once-rendered
  // CameraCluster shares them; both guard on handleRef.current (null before ready).
  //
  // onFit re-frames the factory via the SAME `doFit` closure boot-fit + the Home
  // key use (invoked through doFitRef — single source, no duplicated fit body).
  const onFit = useCallback((): void => {
    doFitRef.current?.();
  }, []);
  // onResetZoom snaps zoom to exactly 1.0 while keeping the viewport-centre world
  // point fixed: read the world point under the screen centre, then setCamera(1,
  // panX, panY) so that same world point still lands at the screen centre.
  const onResetZoom = useCallback((): void => {
    const handle = handleRef.current;
    if (!handle) return;
    const cx = handle.app.screen.width / 2;
    const cy = handle.app.screen.height / 2;
    const w = handle.cam.screenToWorld(cx, cy);
    handle.cam.setCamera(1, cx - w.x, cy - w.y);
  }, []);
  // IX-03: the armed tool surfaced from gestures.ts (`onArmedChange`) into React
  // so exactly one Palette item renders `.is-armed`. Edge-driven (set on every
  // arm/disarm/switch), never polled. `null` when nothing is in hand.
  const [armed, setArmed] = useState<ArmedTool | null>(null);
  // IX-04/IX-07: the currently-selected node handle surfaced from gestures.ts
  // (`onSelect`) into React so the discoverable DeleteControl can mount glued to
  // its selection ring. Edge-driven like `armed` (set on every select/clear),
  // never polled. `null` when nothing is selected — the control unmounts.
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  // Phase 76 (plan 76-02, 76-UI-SPEC 2.1): the label the user has JUST placed, whose panel
  // should hand the keyboard to its Text field once its config loads. Set by the gesture
  // layer's `onLabelPlaced` (fired only from the label echo), cleared on every selection
  // change and as soon as the panel has given the focus, so a later plain click on a label
  // never steals focus from the board.
  const [labelFocusNode, setLabelFocusNode] = useState<number | null>(null);
  const clearLabelFocus = useCallback(() => setLabelFocusNode(null), []);
  // Phase 76 (plan 76-03, 76-UI-SPEC 5.4, U-5): the label whose panel holds a PENDING SIZE
  // (width or depth differing from the committed size), and that size. The overlay draws
  // the outline the label would have, `build` where it fits and `fault` where it would
  // cover something or pass the grid edge, by the ONE client prediction (`ghost.ts`
  // `footprintFits`, the label's own cells excluded). A ref, not state: it is repainted
  // from the packet path as well as from the panel, and nothing renders from it.
  const labelResizeRef = useRef<{ node: number; w: number; h: number } | null>(null);
  /** Repaint (or clear) the pending-size outline from `labelResizeRef` and the live scene.
   *  A label that is gone from the scene clears it. */
  const paintLabelResize = useCallback((): void => {
    const handle = handleRef.current;
    if (!handle) return;
    const pending = labelResizeRef.current;
    const node = pending ? handle.sceneState.nodes.get(pending.node) : undefined;
    if (!pending || !node || node.kind !== machine_kind.LABEL) {
      handle.overlay.clearLabelResize();
      return;
    }
    const anchor = { cx: node.cell_x, cy: node.cell_y };
    const fits = footprintFits(
      handle.sceneState,
      anchor,
      { w: pending.w, h: pending.h, rot: 0 },
      pending.node,
    );
    handle.overlay.showLabelResize(anchor, pending.w, pending.h, fits);
  }, []);
  /** Plan 88-07 (D-09): label `id`'s box as the scene shows it now, or null for a non-label.
   *  A label never turns, so its anchor and its `w` by `h` are its box. */
  const labelBoxOf = useCallback(
    (id: number): { id: number; cx: number; cy: number; w: number; h: number } | null => {
      const n = handleRef.current?.sceneState.nodes.get(id);
      return n !== undefined && n.kind === machine_kind.LABEL
        ? { id, cx: n.cell_x, cy: n.cell_y, w: n.w, h: n.h }
        : null;
    },
    [],
  );
  /** The label panel reports its pending size, or `null` once it matches the committed
   *  size again (Apply landed, Revert) or the panel closes (deselect, a full keyframe). */
  const onLabelResize = useCallback(
    (node: number, pending: { w: number; h: number } | null): void => {
      labelResizeRef.current = pending ? { node, ...pending } : null;
      paintLabelResize();
    },
    [paintLabelResize],
  );
  // BELT-01: the currently-selected BELT handle, on its OWN channel
  // (`onSelectBelt`), never `onSelect`. The two are mutually exclusive by
  // construction - the gesture layer drives both from all seven selection sites -
  // and App must not re-derive that.
  //
  // IT IS A SECOND STATE RATHER THAN A WIDER `selectedNode` BECAUSE
  // `selectedNode` GATES THE MACHINE'S DESTRUCTIVE CONTROLS. The DeleteControl mount
  // below reads it, and in the gesture layer `selectedNode()` is the machine's
  // keyboard Delete and rotate target. A belt arriving in `selectedNode` would gain
  // the floating machine delete button and the machine's delete path (68-UI-SPEC
  // FINDING 3). The DeleteControl gate takes a ZERO diff. Since phase 89 (D-07) a
  // selected belt is deleted by its own guarded path, `requestBeltDelete`: the
  // Delete key in the gesture layer and the belt panel's `Delete belt` button below.
  const [selectedBelt, setSelectedBelt] = useState<number | null>(null);
  /** BELT-01: the belts the belt panel's Apply writes to - the whole contiguous
   *  run the clicked belt belongs to, in flow order, each carrying its own live
   *  pace (`beltRun.ts`).
   *
   *  DERIVED ON TWO EDGES AND NOWHERE ELSE: the belt SELECTION (seeded
   *  synchronously below, so the run line is right on the first paint rather than
   *  100ms later) and the ~10Hz chrome poll, behind `beltRunSigRef` - the
   *  `portsSigRef` / `flowSigRef` discipline, for the identical reason. The walk
   *  is NEVER run per frame: the project constraint is that idle ticks are nearly
   *  free, and a graph walk does not belong in the render loop. The signature
   *  folds the PACES in as well as the handles, because a neighbour whose pace
   *  changed is a run change the panel must see (it flips the Mixed state and it
   *  is what the whole-run applied observation reads). */
  const [selectedBeltRun, setSelectedBeltRun] = useState<BeltRunEntry[]>(NO_RUN);
  /**
   * LINK-09: the selected BELT's two synthesised port rows and their flow.
   *
   * Seeded on the selection edge and refreshed on the ~10Hz poll behind ONE
   * signature, exactly as `selectedNodePorts` / `selectedNodeFlow` are for a
   * machine - and for the same reason: a poll-only derivation would leave the
   * PREVIOUS belt's rows on screen for up to 100ms on the very interaction the
   * section exists for, and an unguarded one would hand the panel a fresh Map
   * identity ten times a second.
   *
   * ONE signature over BOTH halves, where the machine path carries two. The
   * machine split exists because its flow churns (an item stepping onto a docked
   * belt) while its port topology does not, so folding them would re-run the whole
   * I/O list build on a filling belt. A belt's two rows are FIXED - two records,
   * always, whatever the geometry - so its `portsSignature` half is constant by
   * construction and there is no churn for a second guard to separate out.
   */
  const [selectedBeltPorts, setSelectedBeltPorts] = useState<{
    ports: PortView[];
    flow: Map<number, PortFlow>;
  }>(NO_BELT_ROWS);
  const beltRowsSigRef = useRef<string>('');
  const beltRunSigRef = useRef<string>('');
  // The selected node's machine-kind byte, captured alongside the handle so the
  // ConfigPanel can render its kind heading immediately (before machine_config
  // resolves). Read from the authoritative NodeView map at selection time.
  const [selectedNodeKind, setSelectedNodeKind] = useState<number | null>(null);
  // PANEL-02: the selected node's LIVE render-packet ports, threaded into the
  // ConfigPanel (which owns no scene access of its own). Seeded synchronously at
  // selection so the I/O list is right on the first paint, then refreshed by the
  // ~10Hz chrome poll behind a structural-signature guard - `portsSigRef` holds
  // the signature currently in state, shared by BOTH writers so neither re-sets
  // work the other already did.
  const [selectedNodePorts, setSelectedNodePorts] = useState<PortView[]>(NO_PORTS);
  const portsSigRef = useRef<string>('');
  // 74.1-19: would the host refuse one more output on the selected machine because a
  // belt is in the way? `addOutputVerdict` (held to the engine's own AddPort verdicts)
  // answers it off the echoed scene. Written by BOTH writers of `selectedNodePorts`,
  // but on EVERY poll rather than behind the ports signature: a belt drawn or deleted
  // beside the machine changes the answer without changing a single port. A boolean,
  // so an unchanged answer bails out of React by value.
  const [selectedNodeAddBlocked, setSelectedNodeAddBlocked] = useState<boolean>(false);
  // PANEL-04: the selected node's LIVE per-port flow ({docked, carrying, backedUp}), derived
  // in the SAME poll block from `sceneState.belts` (items ride on belts, never on
  // nodes). Seeded at selection like `selectedNodePorts`, and guarded by its OWN
  // signature so a filling belt never invalidates the port-topology payload.
  const [selectedNodeFlow, setSelectedNodeFlow] = useState<Map<number, PortFlow>>(NO_FLOW);
  const flowSigRef = useRef<string>('');
  // SERVE-05: the OTHER Routes' COMMITTED paths and cells, for the Route card's
  // duplicate-path courtesy gate. It is NOT in the ~10Hz poll block above and could
  // not be: `path` is a CONFIG field, not a render-packet one, so it is only
  // readable over the `machine_config` host query. The sweep effect below owns it.
  const [otherRoutes, setOtherRoutes] = useState<readonly RouteNeighbour[]>(NO_ROUTES);
  // The live selection read by the mount-once poll closure (which captured its
  // scope before any selection existed) - the same `xRef.current = x` discipline
  // as guardRef / playingRef / welcomeSeenRef.
  const selectedNodeRef = useRef<number | null>(null);
  selectedNodeRef.current = selectedNode;
  // BELT-01: the same discipline for the belt channel, read by the same poll
  // closure. The two are mutually exclusive by construction (the gesture layer
  // drives both), so at most one of them is ever non-null.
  const selectedBeltRef = useRef<number | null>(null);
  selectedBeltRef.current = selectedBelt;
  // CR-01, the 76-17 refuter round: the SELECTION EPOCH (`selectionEpoch.ts`), one number
  // per selection rather than per render handle. `liveEpoch` is moved synchronously by
  // `onSelect`, `onSelectBelt` and the keyframe branch, and never written from a render;
  // `selectionEpoch` is the value React rendered. Both ConfigPanels are keyed on
  // `selectionEpoch` and gate every send on `liveEpoch.current === selectionEpoch`, so a
  // keyframe that remints the selected handle, followed by a reselect of whatever node
  // now holds that number, is a new panel and closes the old one's sends.
  const [liveEpoch] = useState(createSelectionEpoch);
  const [selectionEpoch, setSelectionEpoch] = useState(0);

  // -------------------------------------------------------------------------
  // CR-01: the IN-FLIGHT PORT EDIT LATCH, owned HERE rather than in the panel.
  //
  // The invariant and its full reasoning live in `portEditLatch.ts`. In one line:
  // at most ONE port edit may be sent against any ONE observed port topology,
  // because `command.rs:855-864` validates a `RemovePort` index by RANGE alone -
  // so a duplicate splices whatever slid into that slot when the first folded
  // (on a `[In@0, Out@1, Fault@2, Out@3]` Factory, the FAULT port, whose belt
  // `fold_remove_port` then leaves docked to a port that no longer exists).
  //
  // WHY APP AND NOT THE PANEL. The latch used to be a `useRef` inside
  // `ConfigPanel`, which App remounts per selection (`key={selectionEpoch}`, once `key={selectedNode}`).
  // Deselecting therefore threw away the in-flight record while the edit was
  // still in the host's UNBOUNDED gesture channel, and the remounted panel
  // cheerfully offered the same stale index again - three ordinary clicks
  // ("another machine, back, x again"), and during a PAUSED build the only way
  // the panel would accept a second port edit at all. The safety property has to
  // outlive the component that renders it, so it lives on the node instead.
  //
  // Keyed by node handle so an edit pending on machine A cannot gate machine B,
  // and pruned in the poll when a node leaves the scene (a delete / a load) so
  // the map cannot grow for the session. Only PENDING latches are ever stored -
  // a release deletes the entry - so it holds 0 or 1 entries in practice.
  const portEditLatchesRef = useRef(new Map<number, PortEditLatch>());
  const [portEditMirror, setPortEditMirror] = useState<PortEditMirror>(PORT_EDIT_IDLE_MIRROR);
  // 74.1-19 (re-walk J10): WHEN the pending status line may show. The latch above
  // disables the controls from the press; this only holds back the SENTENCE for
  // `PORT_EDIT_PENDING_GRACE_MS`, because a manual walk saw it paint for 59 to 173 ms on every
  // add and read it as a flash. One controller for the session: it is armed by the one
  // send funnel and released on every path that ends a latch. Its timer callback only
  // ever flips `visible` on a mirror that is already pending, so an idle panel stays
  // on the identity singleton.
  const portEditGraceRef = useRef<PortEditGrace | null>(null);
  if (portEditGraceRef.current === null) {
    portEditGraceRef.current = createPortEditGrace(
      {
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (h) => window.clearTimeout(h as number),
      },
      (visible) =>
        setPortEditMirror((prev) => (prev.pending && prev.visible !== visible ? { ...prev, visible } : prev)),
      // Plan 84-17: when the grace runs out, the line shows only if the scene still shows an edit
      // unapplied. The poll that releases the latch runs on animation frames; on a slow renderer it
      // came 448 to 641 ms after Resume while the scene showed the add applied at 24 to 63 ms.
      () => {
        const scene = handleRef.current?.sceneState;
        if (!scene) return true;
        return anyPortEditUnfolded(
          portEditLatchesRef.current,
          (node) => scene.nodes.get(node)?.ports,
          keyframeSinceLatchRef.current,
        );
      },
    );
  }
  const portEditGrace = portEditGraceRef.current;
  // A paused sim holds the edit, and saying so at once is not a flash.
  useEffect(() => {
    portEditGrace.setPaused(!playing);
  }, [playing, portEditGrace]);
  // Unmount: no timer outlives the app.
  useEffect(() => () => portEditGrace.release(), [portEditGrace]);

  /**
   * 73-08 / R-40: HAS A KEYFRAME BEEN APPLIED SINCE THE LIVE LATCH CLOSED?
   *
   * `observePorts` releases a pending edit on a `full: true` packet, because a
   * keyframe means the timeline was restructured by something other than our edit
   * (undo, redo, load, scene swap) and the index our edit was addressed against
   * means nothing after it. The flag has to be carried across two seams: the
   * keyframe is observed on the PACKET path, and the latch is fed on the ~10Hz
   * POLL, which are different callbacks.
   *
   * It is set on a restructure keyframe and cleared in `sendPortEdit`, so it reads
   * exactly "a keyframe has landed SINCE this latch closed" rather than "a keyframe
   * happened at some point". Clearing at close is not bookkeeping: without it, a
   * keyframe that landed in the ~100ms BEFORE the user's click would release the
   * click's own latch on the very next poll, with the edit still in the host's
   * gesture channel - which is the releases-too-early direction that killed the
   * latch's first iteration.
   *
   * 73-12 (73-REVIEW WR-03): PER NODE, KEYED THE SAME WAY THE LATCHES ARE. It was a
   * single board-wide boolean, and `sendPortEdit` cleared it for the whole board. So
   * with an edit pending on machine A, selecting machine B and clicking its `x`
   * cleared the keyframe evidence that was about to release A - leaving A latched
   * until the user found the [Try again] escape. The inverse held too: a keyframe
   * plus a poll on B released nothing for A and consumed nothing either, so the flag
   * persisted and would release the NEXT latch that happened to be polled.
   *
   * In practice only one latch is ever open, which is why this read as latent rather
   * than live. The latch map is keyed per node PRECISELY BECAUSE that is a property
   * of today's UI and not an enforced invariant, and evidence about those latches has
   * to be keyed the same way or the two disagree the first time the assumption
   * breaks. Same lifetime rules as the map beside it: an entry is added only for a
   * node with a PENDING latch, and removed when that latch closes or releases.
   */
  const keyframeSinceLatchRef = useRef(new Set<number>());

  /**
   * Feed the SELECTED node's freshly-observed port topology + sim tick through
   * the latch, and refresh the render mirror.
   *
   * This is the RELEASE path, and it runs in App's poll (plus synchronously on
   * the selection edge) rather than in a panel effect - which is the whole point
   * of the hoist: a fold that lands while the panel is unmounted still releases
   * the latch, so reselecting the machine can never resurrect a stale index.
   */
  const syncPortEdit = useCallback((node: number | null, ports: PortView[], tick: number): void => {
    const latches = portEditLatchesRef.current;
    const latch = node === null ? undefined : latches.get(node);
    if (latch === undefined) {
      setPortEditMirror((prev) => (prev === PORT_EDIT_IDLE_MIRROR ? prev : PORT_EDIT_IDLE_MIRROR));
      return;
    }
    // 73-08 / R-40: the keyframe arm. A `full: true` packet since this latch
    // closed releases it whatever the key looks like - the walked UNDO-06 gesture
    // folds the remove and its undo inside ONE poll window, so the key on screen
    // is byte-identical to the one we sent against and the successor check can
    // never see the move.
    const next = observePorts(
      latch,
      portsKeyOf(ports),
      keyframeSinceLatchRef.current.has(node as number),
    );
    if (!isPortEditPending(next)) {
      latches.delete(node as number);
      // WR-03: the evidence dies with the latch it was evidence about.
      keyframeSinceLatchRef.current.delete(node as number);
      // 74.1-19: and the grace with it, once no edit is left in flight.
      if (latches.size === 0) portEditGrace.release();
      setPortEditMirror((prev) => (prev === PORT_EDIT_IDLE_MIRROR ? prev : PORT_EDIT_IDLE_MIRROR));
      return;
    }
    if (next !== latch) latches.set(node as number, next);
    // WR-01: still unfolded. Decide only whether to OFFER the escape - crossing
    // the tick threshold never releases the latch and never claims a verdict.
    // Plan 74.1-31 (PAUSED-READOUT): a paused host drains with input held, so the
    // forward stall count is off while the client believes it is paused.
    const stalled = isPortEditStale(next, tick, PORT_EDIT_STALL_TICKS, !playingRef.current);
    const visible = portEditGrace.visible();
    setPortEditMirror((prev) =>
      prev.pending && prev.stalled === stalled && prev.visible === visible
        ? prev
        : { pending: true, stalled, visible },
    );
  }, [portEditGrace]);

  /**
   * The ONE funnel every port edit passes through (the panel has no other way to
   * put `AddPort`/`RemovePort` bytes on the wire). Returns false when nothing was
   * sent.
   *
   * The send sits INSIDE the guard rather than after a boolean the caller might
   * forget to read: there is no path to `sendInput` that skips the latch.
   *
   * WR-01: a missing transport refuses the edit WITHOUT latching. The panel's
   * `sendInput` seam is `submitInput`, which is a silent no-op before the transport
   * exists - and closing the latch on a command that was never transmitted would
   * guarantee a fold that can never come. The explicit null-transport check below is
   * therefore kept rather than delegated. Since phase 88 `submitInput` returns the gesture
   * id it sent under, and 0 when nothing was sent; this funnel still checks the transport
   * itself before it closes a latch, so the rule stays where the latch is.
   */
  const sendPortEdit = useCallback(
    (node: number, kind: PortEditKind, portsKey: string, bytes: Uint8Array): boolean => {
      const transport = transportRef.current;
      if (!transport) return false;
      const latches = portEditLatchesRef.current;
      const next = closePortEditLatch(
        latches.get(node) ?? IDLE_PORT_EDIT,
        kind,
        portsKey,
        handleRef.current?.sceneState.tick ?? 0,
      );
      if (next === null) return false;
      // Review IN-B-03: the latch closes only on an edit that went on the wire (`submitInput`
      // returns 0 on a stopped sim or with no transport); otherwise it is put back as it was.
      if (!latchThenSend(latches, node, next, () => submitInput(bytes))) return false;
      // 73-08 / R-40: this latch is closed against the topology on screen NOW, so
      // any keyframe already observed belongs to the timeline BEFORE it and must
      // not release it. WR-03: cleared for THIS NODE only - clearing the board
      // would throw away evidence about a latch pending on a different machine.
      keyframeSinceLatchRef.current.delete(node);
      // 74.1-19: the sentence waits out the grace; a paused sim speaks at once.
      portEditGrace.arm(!playingRef.current);
      setPortEditMirror({ pending: true, stalled: false, visible: portEditGrace.visible() });
      return true;
    },
    [portEditGrace],
  );

  /**
   * WR-01: the user's explicit way out of an edit the host is never going to
   * fold. It clears the latch and NOTHING else - it does not re-send, does not
   * cancel anything host-side (there is no channel that could), and makes no
   * claim about what happened. The next click is then an ordinary edit addressed
   * against the topology the user can see on screen.
   */
  const resetPortEdit = useCallback((node: number): void => {
    portEditLatchesRef.current.delete(node);
    // WR-03: the keyframe evidence dies with the latch it was evidence about, on
    // EVERY path that ends a latch - this one, the release in `syncPortEdit`, and
    // the scene-departure prune in the poll.
    keyframeSinceLatchRef.current.delete(node);
    if (portEditLatchesRef.current.size === 0) portEditGrace.release();
    setPortEditMirror(PORT_EDIT_IDLE_MIRROR);
  }, [portEditGrace]);

  /**
   * Plan 74.1-28 (re-walk G1): A HOST REFUSAL THAT NAMES THE LATCHED EDIT ENDS THE WAIT.
   *
   * A refusal is proof the edit will never fold, and the host's refusal frame names the
   * refused command and its node, so a refusal of THIS node's pending `AddPort` /
   * `RemovePort` releases its latch, its keyframe evidence and (with no latch left) the
   * grace, through the same `resetPortEdit` [Try again] uses. The panel then shows the
   * refusal sentence and nothing else, its controls usable. Anything else - another
   * node, another command, an unnamed frame, an accept - releases nothing
   * (`refusalReleasesPortEdit`, threat T-74.1-97).
   *
   * Registered on `onGestureVerdict` AHEAD of `showRefusal`, whose stale-drop and
   * same-tag early return would otherwise swallow a repeated refusal before it could
   * release anything.
   */
  const releaseRefusedPortEdit = useCallback(
    (verdict: GestureRefusal): void => {
      const node = refusalReleasesPortEdit(portEditLatchesRef.current, verdict);
      if (node !== null) resetPortEdit(node);
    },
    [resetPortEdit],
  );
  const releaseRefusedPortEditRef = useRef(releaseRefusedPortEdit);
  releaseRefusedPortEditRef.current = releaseRefusedPortEdit;
  // READ-01 legibility chrome state. `legendOpen` toggles the collapsible Legend
  // panel from the Toolbar Legend button (CLOSED by default — zero permanent
  // screen cost). `labelsToggled` is the PERSISTENT machine-name reveal toggle;
  // `altHeld` (below) is the MOMENTARY Factorio alt-mode sibling. Both are plain
  // edge-driven React state alongside `armed`/`selectedNode`; the labels overlay
  // derives `labelsVisible = altHeld || labelsToggled`.
  const [legendOpen, setLegendOpen] = useState(false);
  // 52-06 (WINDOWS id 2): the horizontal band the bottom Legend strip may occupy,
  // MEASURED from the shipped panels rather than written as a literal inset. The
  // Palette is `width: fit-content` and grew 153 to 174px earlier in phase 52, so
  // a literal would silently drift back into the collision the strip replaces.
  //   paletteRightPx = the Palette column's right edge
  //   cornerInsetPx  = the width reserved on the right for the LEFTMOST
  //                    right-docked surface: the CameraCluster, or the
  //                    ConfigPanel while a machine is selected.
  //
  // `null` means UNMEASURABLE, and the Legend is then not mounted at all (see the
  // render gate). It is not an initial value to be painted over: 52-06 seeded this
  // with `{0, 0}`, which renders `left: calc(0px + var(--fab-space-lg))` - exactly
  // the bottom-left dock whose occlusion of the Belt tool this strip exists to
  // remove - so every degradation path silently restored the defect. The whole
  // model now lives in `legendBand.ts` as a pure function with named refusals.
  const [legendBand, setLegendBand] = useState<LegendBand | null>(null);
  const [labelsToggled, setLabelsToggled] = useState(false);
  // CR-01: the ConfigPanel is a right-docked surface that MOUNTS AND UNMOUNTS with
  // the selection, so the band must be re-measured when it appears. A
  // ResizeObserver registered at effect time can never see an element that did not
  // exist yet, so the mount identity is a dependency of the effect below. The
  // panel is keyed on the selection epoch, so the epoch is the mount identity.
  const configDockKey = selectedNode !== null && selectedNodeKind !== null ? selectionEpoch : null;
  // The belt inspector's own key (phase 91, plan 91-11). A belt selection mounts the same docked
  // `aside` as a machine's, but `configDockKey` is null for it, so the two measuring effects below
  // did not re-run when a belt was selected from nothing: the status strip stayed at the plain
  // right end, under the belt inspector, and `Unsaved` was covered (seen on the 91-11 walk).
  const beltDockKey = selectedBelt !== null ? selectionEpoch : null;
  // The Legend strip is on screen: open, and a band measured for it (the mount condition below).
  const legendMounted = legendOpen && legendBand !== null;
  // Measure that band from the LIVE DOM, gated on `ready` (the commit that mounts
  // the Palette and the CameraCluster).
  useLayoutEffect(() => {
    if (!ready) {
      return;
    }
    // WR-03: compute the positioning container ONCE and both measure against it
    // and OBSERVE it. 52-06 measured against `left.offsetParent` while observing
    // `document.body`; they coincide only because `#root` and `body` are both
    // `position: static` in index.html, an invariant held by an unrelated file
    // that nothing tests. The moment any ancestor becomes positioned (a scrim, a
    // page-transition transform, a `position: relative` wrapper) the offsetParent
    // moves there and its resizes go entirely unobserved.
    const leftAtSetup = document.querySelector<HTMLElement>('[data-fab-left-dock]');
    const container = (leftAtSetup?.offsetParent as HTMLElement | null) ?? document.body;
    // The open strip's top in the container's space, or null while the Legend is closed.
    const stripTop = (): number | null => {
      const strip = document.getElementById(LEGEND_PANEL_ID);
      return strip !== null && strip.offsetHeight > 0 ? strip.offsetTop : null;
    };
    const measure = (): void => {
      // querySelectorALL, not querySelector: the singular form silently takes the
      // first match in document order, so a second element ever carrying the
      // attribute would re-point the band with no type error and no test error.
      const lefts = [...document.querySelectorAll<HTMLElement>('[data-fab-left-dock]')];
      const left = lefts[0] ?? null;
      const corners = [...document.querySelectorAll<HTMLElement>('[data-fab-corner-dock]')];
      // A `display:none` dock reports `offsetLeft === 0`, which would make the
      // reserve the entire container width and invert the strip (WR-02).
      const docks = corners
        .filter((el) => el.offsetWidth > 0)
        .map((el) => ({ left: el.offsetLeft, bottom: el.offsetTop + el.offsetHeight }));
      const bandFrom = (reachTop: number | null) =>
        computeLegendBand({
          containerWidth: container.clientWidth,
          leftDockCount: lefts.length,
          leftDockRightPx: left === null ? null : left.offsetLeft + left.offsetWidth,
          // Only a dock whose bottom reaches the open strip's top is reserved (review
          // IN-B-04, `cornerLeftsReachingStrip`): a short inspector ends far above the strip.
          visibleCornerLeftsPx: cornerLeftsReachingStrip(docks, reachTop),
          // The gutter is READ, never written as a literal here - it is the same
          // `--fab-space-lg` the Legend's own `calc()` uses.
          spaceLgPx: Number.parseFloat(
            getComputedStyle(container).getPropertyValue('--fab-space-lg'),
          ),
        });
      // WHICH TOP THE REACH IS READ AGAINST: THE WIDEST STRIP'S (phase 92, plan 92-05). The reach
      // used to be read against the strip's CURRENT top, and the Legend opens from the closed band,
      // which reserves every dock, so it opens narrow. Since phase 92 the strip lists every palette
      // entry, the ports and the four groups, so beside the short Source inspector at 1280x800 the
      // narrow strip's top (456) rose above the panel's bottom (521.6): the panel then counted as
      // reached, the strip stayed narrow, and the 400 px review IN-B-04 won back were lost again,
      // although the wide strip's top (554) clears the panel. So the strip is laid out once, in this
      // same pass and before any paint, at the band that reserves only the docks a one-line strip
      // would reach (the camera cluster, whose bottom is the strip's), and the reach is read against
      // that top. A dock reached there is reached by every narrower strip (a narrower strip is
      // taller), so the band chosen is the widest one that runs under nothing, whatever band was
      // showing before: it depends on the docks' boxes, never on history. The style is put back
      // before this function returns; React owns it, and the band below sets it on the next render.
      const reachTop = (): number | null => {
        const strip = document.getElementById(LEGEND_PANEL_ID);
        const top = stripTop();
        if (strip === null || top === null) return null;
        const wide = bandFrom(top + strip.offsetHeight - 1);
        if (!wide.ok) return top;
        const shown = strip.style.right;
        strip.style.right = `calc(${wide.band.cornerInsetPx}px + var(--fab-space-lg))`;
        const wideTop = strip.offsetTop;
        strip.style.right = shown;
        return wideTop;
      };
      // HELP'S BOUND (phase 92, CHROME-12, D-05, RESEARCH Finding L). With the Legend open, Help
      // stops 8 px above the strip (`HelpPanel.tsx` reads this property in its max height). It is a
      // custom property on the positioning container, written here, never a React prop: this
      // function runs in the layout effect and in the ResizeObserver callback, and a style written
      // there is laid out before the frame paints, so when the strip moves (it opens, closes or
      // wraps onto more lines on a resize) Help follows in the same frame. A prop set from the
      // observer would re-render after that frame painted, one frame with Help over the strip. The
      // strip's top is read as it is shown, and nothing about the strip reads Help, so there is no
      // loop. Removed while the Legend is closed, which hands Help its cluster bound back. Read off
      // the boxes rather than `offsetTop`, which rounds to a whole pixel: at the 1.18 text scale
      // the strip's top is fractional, and a top rounded up by half a pixel would take it from
      // Help's 8 px gap.
      const shown = document.getElementById(LEGEND_PANEL_ID);
      if (shown === null || stripTop() === null) container.style.removeProperty('--fab-legend-top');
      else {
        const top = shown.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop;
        container.style.setProperty('--fab-legend-top', `${top}px`);
      }
      const result = bandFrom(reachTop());
      if (!result.ok) {
        // Fail CLOSED and LOUDLY. The Legend simply does not open, which is a
        // visible, reportable failure; a Legend that opens over the Belt tool is
        // not, and that is the trade 52-06 got backwards.
        console.error(
          '[fabrico] legend band unmeasurable (%s) - the Legend will not open',
          result.reason,
        );
        setLegendBand(null);
        return;
      }
      const { paletteRightPx, cornerInsetPx } = result.band;
      // T-52-16: return the PREVIOUS object unchanged when nothing moved. Without
      // this identity guard a ResizeObserver callback that always sets fresh state
      // can drive a resize/render feedback loop.
      setLegendBand((prev) =>
        prev !== null &&
        prev.paletteRightPx === paletteRightPx &&
        prev.cornerInsetPx === cornerInsetPx
          ? prev
          : result.band,
      );
    };
    measure();
    // Observe the container and the docks themselves, never the Legend this sizes.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (leftAtSetup !== null) {
      observer.observe(leftAtSetup);
    }
    document.querySelectorAll<HTMLElement>('[data-fab-corner-dock]').forEach((el) => {
      observer.observe(el);
    });
    // The open Legend too (review IN-B-04): its height decides which docks it reaches.
    const legendAtSetup = document.getElementById(LEGEND_PANEL_ID);
    if (legendAtSetup !== null) observer.observe(legendAtSetup);
    return () => {
      observer.disconnect();
    };
    // `legendMounted`, not `legendOpen` (phase 92 review WR-B-03): the strip renders only once a band
    // is measured, so a band refused while the Legend is open (a window narrowed past the strip's
    // minimum) and measured again later mounts the strip in a commit after this effect ran, with
    // `legendOpen` unchanged. Keyed on the mount itself, the effect re-runs then, observes the new
    // strip and writes Help's bound off it.
  }, [ready, configDockKey, beltDockKey, legendMounted]);
  // ONB-03: the top-right disclosure, as ONE value rather than a boolean. It held the
  // Help / Graphics pair (BELT-06) so that two panels that both close on Escape and both
  // return focus to their own trigger could never be open at once. Plan 91-03 deleted
  // the Graphics panel (CHROME-03, D-04), so Help is its one member today; a future
  // global disclosure joins THIS union rather than adding a second boolean, which keeps
  // "two open at once" a state that cannot be reached.
  const [topRightPanel, setTopRightPanel] = useState<'help' | null>(null);
  const helpOpen = topRightPanel === 'help';
  // Plan 74.1-31 (PAUSE-TOOLBAR): WHERE THE TOOLBAR'S STATUS STRIP MAY HANG. The strip
  // (the status readout and the Unsaved badge, out of the button row) is right-aligned
  // under the toolbar's right end by default, but the ConfigPanel is `top: lg` and covers
  // that end while a machine is selected, and the Help panel hangs below it while open;
  // both paint over the strip. So the band is MEASURED like the Legend's: right of the
  // Palette and left of every visible top-right panel, one `--fab-space-sm` gutter each
  // side, and handed to the Toolbar as the strip's right edge and its widest extent.
  // Re-measured when the ConfigPanel mounts (`configDockKey`, or `beltDockKey` for a belt), when Help opens or closes,
  // when the Examples popover opens or closes (plan 91-10), and on any resize of the container
  // or the docks. Same identity guard as the Legend.
  const [statusStripPlacement, setStatusStripPlacement] = useState<{ right: number; maxWidth: number } | null>(null);
  // EX-02: the Examples popover's open flag (its handlers are further down, with the popover's
  // other state). DECLARED HERE, above the measuring effect below, because that effect reads it
  // (phase 91, plan 91-10, CHROME-15, UI-SPEC 5.5): the open popover hangs from the toolbar's
  // right cluster into the strip's band and covered `Unsaved`, so the strip dodges it as it dodges
  // the inspector and Help. Read in the effect's deps before a later `useState` it would be a
  // temporal-dead-zone error at render (research Finding M).
  const [examplesOpen, setExamplesOpen] = useState(false);
  useLayoutEffect(() => {
    if (!ready) {
      return;
    }
    const topRightPanels = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>(
        `aside[aria-labelledby="fab-config-heading"], #${HELP_PANEL_ID}, #${EXAMPLES_POPOVER_ID}`,
      ),
    ];
    const measure = (): void => {
      const strip = document.querySelector<HTMLElement>('[data-fab-status-strip]');
      const header = (strip?.offsetParent as HTMLElement | null) ?? null;
      if (strip === null || header === null) {
        setStatusStripPlacement(null);
        return;
      }
      const h = header.getBoundingClientRect();
      const gutter = Number.parseFloat(getComputedStyle(header).getPropertyValue('--fab-space-sm')) || 0;
      let left = h.left;
      let right = h.right;
      const palette = document.querySelector<HTMLElement>('[data-fab-left-dock]');
      if (palette !== null && palette.offsetWidth > 0) {
        left = Math.max(left, palette.getBoundingClientRect().right + gutter);
      }
      for (const panel of topRightPanels()) {
        if (panel.offsetWidth > 0) right = Math.min(right, panel.getBoundingClientRect().left - gutter);
      }
      const next = { right: Math.round(h.right - right), maxWidth: Math.max(0, Math.floor(right - left)) };
      setStatusStripPlacement((prev) =>
        prev !== null && prev.right === next.right && prev.maxWidth === next.maxWidth ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    const palette = document.querySelector<HTMLElement>('[data-fab-left-dock]');
    if (palette !== null) observer.observe(palette);
    topRightPanels().forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
    };
  }, [ready, configDockKey, beltDockKey, helpOpen, examplesOpen]);
  const onToggleHelp = useCallback((): void => {
    setTopRightPanel((v) => (v === 'help' ? null : 'help'));
  }, []);
  // Phase 91, plan 91-09 (CHROME-07, UI-SPEC 2.3): HELP AND THE INSPECTOR SHARE ONE SLOT. Both
  // dock top-right at the shared offset, so they are shown one at a time: a selection closes
  // Help (`onSelect` / `onSelectBelt`), and Help opened over a showing inspector HIDES it with
  // an inline `display: none` (the panel stays mounted with its edit, its marker and its
  // selection) until Help closes again. `inspectorDirty` is the mounted panel's not-applied
  // condition, reported up by the panel itself.
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const inspectorHidden = helpOpen && (configDockKey !== null || selectedBelt !== null);
  /** Bring a hidden inspector back: close Help, which is what hides it. */
  const restoreHiddenInspector = useCallback((): void => {
    setTopRightPanel(null);
  }, []);
  // T-91-28: WHILE HELP HIDES THE INSPECTOR, the first Escape only brings the inspector back
  // and does nothing else (UI-SPEC 2.3's Escape row, clean or dirty: review WR-B-03); and while
  // the hidden inspector is DIRTY, so does the first board press, the board's trash button, and
  // every key that deletes or undoes the selection (Delete, Backspace, Ctrl+Z, Ctrl+Shift+Z,
  // Ctrl+Y: review WR-B-02), so an unapplied edit is never dropped by a key or a press whose
  // effect the user cannot see (a deselect or a delete unmounts the panel and its buffer). The
  // gesture layer and the camera listen on the canvas and the window in the bubble phase, so App
  // wins the event with WINDOW CAPTURE-PHASE listeners, installed only in this state and removed
  // as soon as it ends; a layout effect, so the listeners are live in the same commit that hides
  // the panel. The swallowed press also takes its pointerup with it: the gesture layer selects on
  // release only after its own press (`gestures.ts` `onWinUp`), which never ran. The trash
  // button is a DOM button the canvas listener never sees, and it acts on `click`, after this
  // state has ended; its own `onDelete` (below, at its mount) restores instead in this state.
  //
  // THE GUARD STANDS DOWN WHILE SOMETHING ELSE OWNS THE KEYS: the delete or quit dialog (a modal),
  // the Examples popover or the load-refused card, each of which closes on its own Escape. It used
  // to run first (it is installed before them) and close Help behind the dialog instead (review
  // WR-B-02). A key typed into a text field is the field's, as the gesture layer's guard has it.
  // Every key is tested through the shortcut table (`input/shortcuts.ts`, review WR-C03).
  useLayoutEffect(() => {
    if (!inspectorHidden) {
      return;
    }
    const dirty = inspectorDirty;
    const swallow = (e: Event): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      restoreHiddenInspector();
    };
    const keysOwnedElsewhere = (e: KeyboardEvent): boolean => {
      if (
        document.querySelector(`[aria-modal="true"], #${EXAMPLES_POPOVER_ID}, [data-fab-load-refused-body]`) !== null
      ) {
        return true;
      }
      const t = e.target as HTMLElement | null;
      return t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
    };
    const onKeyCapture = (e: KeyboardEvent): void => {
      if (keysOwnedElsewhere(e)) return;
      if (matchesShortcut(e, SHORTCUTS.escape)) {
        swallow(e);
        return;
      }
      if (
        dirty &&
        (matchesShortcut(e, SHORTCUTS.delete) ||
          matchesShortcut(e, SHORTCUTS.undo) ||
          matchesShortcut(e, SHORTCUTS.redo) ||
          matchesShortcut(e, SHORTCUTS.redoY))
      ) {
        swallow(e);
      }
    };
    const onPointerCapture = (e: PointerEvent): void => {
      const canvas = handleRef.current?.app.canvas ?? null;
      if (dirty && canvas !== null && e.target === canvas) swallow(e);
    };
    window.addEventListener('keydown', onKeyCapture, true);
    window.addEventListener('pointerdown', onPointerCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyCapture, true);
      window.removeEventListener('pointerdown', onPointerCapture, true);
    };
  }, [inspectorHidden, inspectorDirty, restoreHiddenInspector]);
  // Phase 91, plan 91-09 (CHROME-07, D-06, UI-SPEC 2.4): THE SELECTED MACHINE STAYS VISIBLE.
  // Once per selection epoch, for a node selection (a machine or a label, never a belt), in the
  // layout pass the inspector first lays out in: when the column the panel can grow into (its
  // left edge, from its top to 8 px above the camera cluster's top) would cover the node's footprint,
  // the board pans LEFT by `computeInspectorNudge`'s distance through `cam.setCamera`, the one
  // camera write seam Fit and Home use. Instant, no zoom or vertical change, no sim command,
  // nothing logged. A layout effect and not a `requestAnimationFrame`: the camera is final
  // before any later reader (a helper that projects a cell to a point) can run (research
  // Finding N). Recorded per epoch, so it never runs again for the same selection: a later
  // pan, zoom, Fit or Home is left alone, a resize or a panel size change never re-pans, Help
  // restoring the panel after the nudge does not re-run it, and a deselect never pans back.
  //
  // THE EPOCH IS SPENT ONLY ON A MEASURED PANEL (phase 91 review WR-A-03). While Help holds the
  // slot the panel is `display: none` and measures 0 wide, so a selection whose first layout
  // pass met a hidden panel is left unspent and nudged when the panel shows (`inspectorHidden`
  // is a dependency for that). In the shipped code a selection closes Help in the same commit,
  // so the first pass already sees a shown panel; this keeps the nudge true if Help ever gives
  // way later.
  const nudgedEpochRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (configDockKey === null || selectedNode === null) {
      return;
    }
    if (nudgedEpochRef.current === configDockKey) {
      return;
    }
    const handle = handleRef.current;
    const node = handle?.sceneState.nodes.get(selectedNode);
    const panel = document.querySelector<HTMLElement>('aside[aria-labelledby="fab-config-heading"]');
    if (!handle || !node || panel === null || panel.offsetWidth === 0) {
      return;
    }
    nudgedEpochRef.current = configDockKey;
    const cam = handle.cam;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [cx, cy] of cellsOfFootprint(node.cell_x, node.cell_y, node.w, node.h, node.rot)) {
      minX = Math.min(minX, cx);
      minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx + 1);
      maxY = Math.max(maxY, cy + 1);
    }
    // The camera answers canvas-relative px; the panel's box is in the page's client space.
    const c = handle.app.canvas.getBoundingClientRect();
    const tl = cam.cellToScreen(minX, minY);
    const br = cam.cellToScreen(maxX, maxY);
    const p = panel.getBoundingClientRect();
    const frame = ((panel.offsetParent as HTMLElement | null) ?? document.body).getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(panel).getPropertyValue('--fab-space-lg'));
    const palette = document.querySelector<HTMLElement>('[data-fab-left-dock]');
    const paletteRight = palette !== null && palette.offsetWidth > 0 ? palette.getBoundingClientRect().right : frame.left;
    // The column ends where the panel's max height does: 8 px above the camera cluster's top
    // (`CAMERA_CLUSTER_CLEARANCE`, review WR-B-06), or 24 px above the window's bottom edge if the
    // cluster reports no box.
    const cluster = document.querySelector<HTMLElement>('[data-fab-camera-cluster]');
    const sm = Number.parseFloat(getComputedStyle(panel).getPropertyValue('--fab-space-sm'));
    const maxBottom =
      cluster !== null && cluster.offsetHeight > 0 && Number.isFinite(sm)
        ? cluster.getBoundingClientRect().top - sm
        : frame.bottom - gap;
    const d = computeInspectorNudge(
      { left: c.left + tl.x, top: c.top + tl.y, right: c.left + br.x, bottom: c.top + br.y },
      { left: p.left, top: p.top, maxBottom },
      paletteRight,
      gap,
    );
    if (d > 0) {
      cam.setCamera(cam.worldScale(), cam.container.x - d, cam.container.y);
    }
  }, [configDockKey, selectedNode, inspectorHidden]);
  // EX-02: the Examples popover disclosure state (the Legend/Help idiom: closed
  // by default, mounted only while open). App owns the open flag + every close
  // path's focus-return so the popover component itself stays hook-free (the
  // 53-07 node-vitest lesson). `examplesTriggerRef` is assigned to the Toolbar
  // CTA; "focus is never stranded" (UI-SPEC): each close path refocuses it.
  // `examplesOpen` itself is declared above the status strip's measuring effect, which reads it
  // (plan 91-10, research Finding M).
  const examplesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeExamples = useCallback((): void => {
    setExamplesOpen(false);
    examplesTriggerRef.current?.focus();
  }, []);
  const onToggleExamples = useCallback((): void => {
    // The toggle click already has focus on the trigger; no explicit refocus.
    setExamplesOpen((v) => !v);
  }, []);
  // Selecting an entry: close FIRST (focus returns to the trigger), then run the
  // guarded parameterized load (a dirty board opens the 'example' guard, which
  // then takes focus per the dialog's own discipline).
  const onSelectExample = useCallback(
    (id: SceneWireId): void => {
      closeExamples();
      doLoadScene(id);
    },
    [closeExamples, doLoadScene],
  );
  // Outside click closes (UI-SPEC §2): a document-level capture listener active
  // ONLY while open. Clicks inside the popover or on the trigger are excluded
  // (the trigger's own click is the toggle; without the exclusion the capture
  // close + the click toggle would cancel out and the CTA could never close it).
  useEffect(() => {
    if (!examplesOpen) {
      return;
    }
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest(`#${EXAMPLES_POPOVER_ID}`) === null &&
        target.closest(`[aria-controls="${EXAMPLES_POPOVER_ID}"]`) === null
      ) {
        closeExamples();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [examplesOpen, closeExamples]);
  // ONB-01 first-run onboarding gate. `welcomeSeen` reads the versioned
  // localStorage flag ONCE (untrusted client state, gates re-showing only — no
  // security decision rides it, threat T-34-LS). The welcome card is a SEPARATE
  // first-run surface, INDEPENDENT of the EmptyState empty-board gate, so it
  // shows over the non-empty demo boot (fixing "EmptyState guidance is dead code
  // on boot"). The versioned key lets a future onboarding revamp re-show once.
  const [welcomeSeen, setWelcomeSeen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('fab.onboarding.seen.v1') === '1';
    } catch {
      // localStorage can throw in a locked-down webview; treat as "not seen" so
      // the card still shows (a soft dismiss, never a hard dependency).
      return false;
    }
  });
  const dismissWelcome = useCallback((): void => {
    try {
      localStorage.setItem('fab.onboarding.seen.v1', '1');
    } catch {
      // Persisting failed (private mode / quota) — still dismiss for this session
      // so the card never nags within the run; it may re-show on the next boot.
    }
    setWelcomeSeen(true);
  }, []);
  // IX-07: a ref mirror of `welcomeSeen` so the once-created gesture controller's
  // Escape fallback reads the LIVE showing/dismissed state (like playingRef /
  // guardRef) without being re-created. The gesture Escape stack calls the
  // fallback ONLY when Escape was otherwise a no-op (nothing armed, nothing
  // selected); we then dismiss the card ONLY if it is still up, so a stray Escape
  // on an already-dismissed board stays a true no-op.
  const welcomeSeenRef = useRef(welcomeSeen);
  welcomeSeenRef.current = welcomeSeen;

  // -------------------------------------------------------------------------
  // ERR-01: the host refusal display path. ONE handler, both transports.
  // -------------------------------------------------------------------------
  //
  // Before phase 64 a refused gesture was silent end to end: the host answered with a
  // typed `CommandError`, the answer died at the transport, and the user saw a board
  // that simply did not change. Everything below is the far end of that path.
  //
  // The sentence currently held, or null when nothing is showing. It is ALWAYS a value
  // read out of REFUSAL_COPY or, since plan 75-07, the closed CLIENT_REFUSAL_COPY - never
  // a host string and never free client prose, so no path, node handle or `Display`
  // string can reach the a11y tree (T-64-06-01).
  const [refusalMessage, setRefusalMessage] = useState<string | null>(null);
  /**
   * Phase 89 UI review UI-02: the screen box of the cell the reject flash names at the moment a
   * sentence is shown, or null. The band steps below it when it would cover it, so the WHERE
   * (the flash) is never hidden by the WHY (the sentence). Read off the PLOTTED flash
   * (`rejectFlashCell`) and the read-only camera; a refusal whose flash is gone (a paused board
   * answered at Play) has nothing to avoid.
   */
  const [refusalAvoid, setRefusalAvoid] = useState<ScreenRect | null>(null);
  const flashedCellOnScreen = useCallback((): ScreenRect | null => {
    try {
      const cell = handleRef.current?.overlay.rejectFlashCell() ?? null;
      const cam = window.__fabrico?.camera();
      if (cell === null || !cam) return null;
      const s = cam.scale;
      return {
        left: cell.cx * CELL * s + cam.x,
        top: cell.cy * CELL * s + cam.y,
        right: (cell.cx + 1) * CELL * s + cam.x,
        bottom: (cell.cy + 1) * CELL * s + cam.y,
      };
    } catch {
      return null;
    }
  }, []);
  /**
   * UNDO-09: the host's own sentence explaining why a `.fab` file will not open, or
   * `null` when nothing is held.
   *
   * THE SLOT AND THE MOUNT ARE COPIED FROM THE REFUSAL ABOVE; THE TIMER IS NOT, AND
   * DROPPING IT IS THE POINT. `REFUSAL_HOLD_MS` is 4000 ms against a sentence that is
   * 674 characters at worst, about 27 seconds of reading. This card is dismissed by the
   * user (its `Close` button or `Escape`) and by nothing else - see `LoadRefusedCard.tsx`
   * for the other two independent grounds it is not routed through `RefusalMessage`.
   *
   * Unlike `refusalMessage` this IS a host string rather than a value read out of a
   * closed `Record`, which is deliberate ("in the words the host already wrote") and is
   * why the host-side copy gate over every `ProjectError` variant exists.
   */
  const [loadRefusedReason, setLoadRefusedReason] = useState<string | null>(null);
  const dismissLoadRefusal = useCallback(() => setLoadRefusedReason(null), []);
  // The ref mirror the once-created transport wiring reads, the same idiom
  // `showRefusalRef` uses below: the registration happens once and must always reach
  // the LIVE setter.
  const setLoadRefusedReasonRef = useRef(setLoadRefusedReason);
  setLoadRefusedReasonRef.current = setLoadRefusedReason;
  /**
   * The sequence number of the last verdict SHOWN. Not the last RECEIVED, and the
   * distinction is the whole of threat T-64-06-02.
   *
   * Since phase 88 (D-06) an ACCEPTED gesture is answered too, on both wires, but an
   * accept never reaches this handler: only a refusal is shown. If an accept raised the
   * bar, a genuine refusal at a LOWER sequence arriving one message later would be
   * dropped as stale. That is this phase's own bug, recreated at a different
   * seam, and the warning sign is a burst of gestures that shows nothing at all. So
   * this is written in exactly ONE place: the branch that writes the text.
   */
  const lastShownSeqRef = useRef(0);
  /**
   * The tag currently on screen, so a repeat of it can re-arm without re-announcing. Either
   * kind: a host tag from a verdict, or a client tag from `showClientRefusal` (plan 75-07).
   * The two unions share no member, so a host verdict never matches a client tag here.
   */
  const shownTagRef = useRef<RefusalTag | ClientRefusalTag | null>(null);
  /**
   * The hold timer, a plain WALL-CLOCK setTimeout in a ref (D-19) - never the overlay
   * tick, never the render loop and never a sim tick. Cleared on supersede AND in the
   * unmount cleanup below: a leaked timer writing into an unmounted tree is a React
   * warning and a real leak (T-64-06-04).
   */
  const refusalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Show one host refusal. The ONLY path to the message surface, fed by BOTH transports
   * so neither can drift into a display path of its own.
   */
  const showRefusal = useCallback(
    (verdict: GestureRefusal): void => {
      // STALE-DROP (D-15). Strictly greater than: a verdict whose sequence EQUALS the
      // last shown is a duplicate and is dropped. Since phase 88 `seq` is the page's own
      // gesture id (monotonic per page load), and a refusal can still arrive after a later
      // gesture's (verdicts and packets ride separate channels), so out-of-order arrival is
      // real rather than theoretical. A refusal with NO `seq` (the host could not read its
      // header, so it names no gesture) is always shown and never stale-dropped.
      //
      // A `Malformed` refusal takes no part in the order at all (phase 88 review, WR-02): it is
      // shown, never stale-dropped, and never moves the bar. It answers a frame the host could
      // not read, which a transport refuses INLINE at receipt, while a readable gesture is
      // answered when the sim drains it (on a paused board, at Play). So a Malformed for
      // gesture 10 can arrive before gesture 7's true refusal, and had it raised the bar to 10
      // that refusal would have been dropped as stale: the red flash with no reason.
      const ordered = verdict.tag !== 'Malformed';
      if (ordered && verdict.seq !== undefined && verdict.seq <= lastShownSeqRef.current) return;

      // D-27, decided 2026-08-21 with the cost stated. The welcome card sits at
      // the IDENTICAL anchor, so without this a first-run user reads a half-occluded
      // onboarding card under a refusal box for four seconds, with two buttons they can
      // no longer see. A refused gesture is proof the user has already started building,
      // which is exactly the exit condition the card's own primary CTA encodes.
      //
      // ACCEPTED COST, recorded rather than hidden: a first-run user whose very first
      // gesture is refused loses the rest of the welcome copy permanently, and the "?"
      // toolbar button is its only re-entry (the card is deliberately non-repeating).
      // The alternative - suppressing the refusal while the card is up - is the silence
      // this phase exists to end, and is not on the table.
      if (!welcomeSeenRef.current) dismissWelcome();

      if (refusalTimerRef.current !== null) clearTimeout(refusalTimerRef.current);
      refusalTimerRef.current = setTimeout(() => {
        refusalTimerRef.current = null;
        shownTagRef.current = null;
        setRefusalMessage(null);
      }, REFUSAL_HOLD_MS);
      // UI-02: the flash this sentence answers, read now, while it is plotted. Set on the
      // same-tag path too: the text does not change (no re-announce), the band's place may.
      setRefusalAvoid(flashedCellOnScreen());

      // SAME TAG: re-arm the hold and return WITHOUT touching the text setter (D-20).
      // This is a REACT IDENTITY requirement rather than an optimisation. Re-setting
      // the same string would remount the text node, a remount is an `additions`
      // mutation, and a polite live region announces it again - so a user hammering
      // one wall would hear the same sentence once per gesture. One announcement.
      //
      // `lastShownSeq` is deliberately NOT advanced here: only the branch that writes
      // the text moves it.
      if (shownTagRef.current === verdict.tag) return;

      // Otherwise write the sentence. ONE SLOT, LAST WINS, never a queue: a queue would
      // replay stale reasons against a board the user has already changed.
      shownTagRef.current = verdict.tag;
      if (ordered && verdict.seq !== undefined) lastShownSeqRef.current = verdict.seq;
      setRefusalMessage(REFUSAL_COPY[verdict.tag]);
    },
    [dismissWelcome, flashedCellOnScreen],
  );
  // A ref mirror so the once-created transport/gesture wiring below reads the LIVE
  // handler without being re-created (the welcomeSeenRef / playingRef idiom).
  const showRefusalRef = useRef(showRefusal);
  showRefusalRef.current = showRefusal;

  /**
   * Show one CLIENT-authored refusal (plan 75-07, D-12): a sentence from the closed
   * `CLIENT_REFUSAL_COPY`, raised by the gesture layer where the press forms no command.
   *
   * THE SAME SLOT, HOLD AND LIVE REGION as `showRefusal`, and the same welcome-card dismissal:
   * one band, last wins, never a queue.
   *
   * IT NEVER TOUCHES `lastShownSeqRef`. That bar belongs to host verdicts; a client sentence
   * has no sequence number. Leaving it alone is what lets a host verdict that arrives after
   * this one replace it (UI-SPEC 5.3): its seq is still above the last host verdict shown.
   *
   * SAME SENTENCE: re-arm the hold and return without writing the text, so a user pressing
   * the same belt-only port again hears it once (the D-20 rule `showRefusal` keeps).
   */
  const showClientRefusal = useCallback(
    (tag: ClientRefusalTag): void => {
      if (!welcomeSeenRef.current) dismissWelcome();

      if (refusalTimerRef.current !== null) clearTimeout(refusalTimerRef.current);
      refusalTimerRef.current = setTimeout(() => {
        refusalTimerRef.current = null;
        shownTagRef.current = null;
        setRefusalMessage(null);
      }, REFUSAL_HOLD_MS);
      setRefusalAvoid(flashedCellOnScreen());

      if (shownTagRef.current === tag) return;
      shownTagRef.current = tag;
      setRefusalMessage(CLIENT_REFUSAL_COPY[tag]);
    },
    [dismissWelcome, flashedCellOnScreen],
  );
  const showClientRefusalRef = useRef(showClientRefusal);
  showClientRefusalRef.current = showClientRefusal;

  useEffect(
    () => () => {
      if (refusalTimerRef.current !== null) clearTimeout(refusalTimerRef.current);
    },
    [],
  );

  /**
   * The ONE gesture-send seam in this file. Every encoded GridCommand App puts on the
   * wire goes through here, so no call site can quietly opt out of the refusal path.
   *
   * IT SENDS AND RETURNS. The verdict does not come back here on either transport - it
   * arrives out of band on `transport.onGestureVerdict`, wired once below, which is the
   * only path to `showRefusal`. The UI never blocks on a gesture (D-05).
   *
   * There is deliberately no CONFIRMED-ACCEPT branch any more. The Tauri transport used
   * to resolve a Promise on accept and App cancelled the optimistic reject flash on it,
   * which was wrong twice over: `clearRejectFlash` takes no argument and clears whatever
   * flash is painted, so an accepted `DrawBelt` wiped the flash belonging to the failed
   * Head dock emitted from the same pointerup (CR-01); and the "accept" was not one - a
   * dead sim and an elapsed 30-second host bound both resolved through the same arm. The
   * flash now expires on its own 180ms timer on both transports, roughly 120ms later and
   * always for its own gesture.
   *
   * IT ALSO ANNOUNCES A QUEUED EDIT (quick/260825-iae). `SimLoop::step` calls
   * `acquire_input()` only in the `RunState::Playing` arm over an unbounded channel, so an
   * edit issued on a paused board is HELD and applied on resume - correct, and until now
   * completely silent, which left a user believing placement was broken.
   * Three things about the check:
   *
   *   (a) It is UNCONDITIONAL rather than per-kind. Every command that rides this channel
   *       (Place, Delete, Rotate, DrawBelt, Dock, Undo, Redo, AddPort, RemovePort,
   *       Configure) is an EDIT the host holds while paused, so there is no kind to
   *       exempt, and one check here cannot be forgotten by a later call site the way ten
   *       scattered ones could.
   *   (b) The pause signal is the CLIENT's OPTIMISTIC `playingRef`, not a host fact. On a
   *       resume race the notice can therefore MISS - leaving the user exactly as informed
   *       as they are today - but it structurally cannot LIE, because it can only fire
   *       while the client itself believes the sim is not live.
   *   (c) It routes through `applyStatus`, never the raw `setStatus`, so the transient
   *       auto-clear tier and the WR-02/WR-03 reconciliation rules both apply to it.
   *
   * The null-transport early return replaces the optional-chain call with identical
   * observable behaviour. Its purpose is ordering: the notice fires ONLY after bytes were
   * really handed to the transport, so the app never claims an edit was queued when
   * nothing was ever sent (the WR-01 shape).
   *
   * THE ONE PLACE A GESTURE HEADER IS WRITTEN (phase 88, D-02, D-06). Every gesture rides
   * this funnel, and here it is framed `[generation][gesture id][body]`
   * (`encodeGestureFrame`): the generation of the latest applied packet unless the caller
   * names one (`opts.generation`), and the next id from a page-lifetime counter that starts
   * at 1. It returns that id, so a caller can pair the host's verdict (`seq`) with the
   * gesture it made; it returns 0, and takes no id, when there is no transport and nothing
   * was sent.
   *
   * AND IT HOLDS UNDO AND REDO BEHIND THE QUEUE (plan 74.1-31, PAUSE-TOOLBAR; a
   * default the maintainer can overturn). On the third re-walk a belt drawn on a paused
   * board was followed by an Undo (a click where Play had been, which landed on Undo):
   * the log shows seq 11 DrawBelt, then seq 12 Undo and Delete, all folding on Play, and
   * the belt the user had just drawn vanished with no message. The rule: an edit that
   * reaches the transport while paused sets `queuedEditsRef`, and while it is set
   * `doUndo` / `doRedo` send nothing, show `undoHeld` ("Paused - press Play before undo
   * or redo") and the Toolbar greys both buttons. An Undo pressed on a paused board with
   * nothing queued behaves exactly as before (and, being an edit, is itself queued).
   *
   * The hold ends on the first scene packet whose tick differs from the tick on screen
   * when Play or Step was requested (`requestQueuedFold`), or on the first timeline-
   * restructure keyframe after New, an example or Open was requested
   * (`requestSwapDiscard`; plan 74.1-35: the host discards every edit queued on the
   * replaced board at the swap, and that keyframe is emitted after it). Not on any
   * moving tick: a pause drains for up to `MAX_SETTLE_TICKS` with input held, so ticks
   * advance on a paused board while nothing has landed. A new paused edit after a Step
   * or a swap request re-arms the hold with no request recorded and waits for the next.
   *
   * RESIDUAL, accepted (T-74.1-108): a packet from a tick that ran just before the host
   * saw the Resume can arrive after the Play click and end the hold a tick early. An Undo
   * pressed in that frame still rides the same FIFO channel behind the queued edits, so
   * it undoes the edit the user just saw land, which is an ordinary undo.
   */
  const submitInput = useCallback((body: Uint8Array, opts?: GestureSendOpts): number => {
    if (simStoppedRef.current) return 0;
    const transport = transportRef.current;
    if (!transport) return 0;
    const { gestureId, generation } = stampGesture(
      gestureIdRef,
      handleRef.current?.sceneState.generation ?? 0,
      opts,
    );
    transport.sendInput(encodeGestureFrame(generation, gestureId, body));
    // T-88-25 re-audit: a quiet follow-up's refusal shows no sentence; registered under the id
    // its verdict will name, before that verdict can arrive.
    if (opts?.quiet === true) quietGesturesRef.current.add(gestureId);
    // D-03 (phase 90): an edit's accept marks the board unsaved; registered under the id its
    // verdict will name, before that verdict can arrive. Undo and Redo pass `edit: false`.
    if (opts?.edit !== false) editGesturesRef.current.set(gestureId, handleRef.current?.sceneState.tick ?? 0);
    // Plan 88-07 (D-09): the gesture's claim, from the caller that holds the typed command,
    // registered under the id the host's verdict will name, before any reader asks again.
    if (opts?.claim !== undefined) {
      // Its handles are of the table the header names (WR-01), so the claim records that.
      queuedClaimsRef.current.add(gestureId, opts.claim, {
        generation,
        tick: handleRef.current?.sceneState.tick ?? 0,
      });
    }
    if (!playingRef.current) {
      // Set only after the bytes were handed over (the WR-01 ordering above). A further
      // paused edit after a Step or Play request waits for the next one.
      queuedEditsRef.current = { foldTick: null, swapRequested: false };
      setUndoHeld(true);
      applyStatus('editsQueued');
    }
    return gestureId;
  }, []);

  // CR-01 (plan 76-17 and its refuter round): the two ConfigPanels' send seams, built
  // per selection. Every command a panel transmits goes through one of these, and each
  // sends only while the live selection epoch still equals the epoch the panel was
  // rendered for. So a control used on the frame a keyframe lands (React not yet
  // committed), or a Factory Apply whose validate answers after the selection moved on,
  // sends nothing, even when the new selection holds the same handle number.
  const nodePanelSendInput = useMemo(
    () => sendWhileSelected(liveEpoch, selectionEpoch, submitInput),
    [liveEpoch, selectionEpoch, submitInput],
  );
  const nodePanelSendPortEdit = useMemo(
    () => portEditWhileSelected(liveEpoch, selectionEpoch, sendPortEdit),
    [liveEpoch, selectionEpoch, sendPortEdit],
  );
  const beltPanelSendInput = useMemo(
    () => sendWhileSelected(liveEpoch, selectionEpoch, submitInput),
    [liveEpoch, selectionEpoch, submitInput],
  );

  // ONB-01 scene badge state, generalized (EX-02): the nullable loaded-scene
  // DISPLAY NAME, or null for a user board (null renders no badge).
  //
  // WR-03: this starts at null and is SEEDED FROM THE HOST on mount (the
  // `loaded_scene` query below), not from an unconditional 'Demo scene' guess.
  // The host is a long-lived process whose scene survives a webview/page reload,
  // so the old initial value made the toolbar read "Demo scene" over an
  // order-processing board after any reload - and Phase 55 had just upgraded the
  // badge from a soft boolean to a hard claim about WHICH example is on screen,
  // which is exactly what a teaching example must not get wrong. Absent beats
  // wrong, and the host's answer beats both.
  //
  // After mount it tracks the control ACTION: set per-scene in doLoadScene, cleared on
  // New, and cleared by a user Open only on that Load's own swap keyframe (`isLoadSwap`,
  // review WR-B-06), so a refused file keeps the badge of the board still on screen.
  // Undo/Redo keyframes never pass `isLoadSwap`, so they never flip it.
  const [loadedScene, setLoadedScene] = useState<SceneDisplayName | null>(null);
  // WR-03: true once a LOCAL control action has authored the badge. The host echo
  // below is asynchronous, so without this a user who clicks an example inside the
  // query's flight window would have their (correct, newer) badge clobbered by the
  // (correct, older) boot answer. Local action wins after it happens; the echo only
  // ever fills the boot-time blank.
  const sceneActedRef = useRef(false);
  // Flipped once the transport singleton exists (set in the transport effect
  // below). The scene query MUST NOT run before it: `devWsInvoke` rejects
  // outright when `registerDevWsQuerySender` has not run yet, and that registration
  // happens inside `makeDevWebSocketTransport`. Gating on state rather than relying
  // on hook DECLARATION order keeps the dependency explicit instead of fragile.
  const [transportReady, setTransportReady] = useState(false);
  useEffect(() => {
    if (!transportReady) return;
    // Ask the HOST which shipped scene the board holds. Read-only: it takes no
    // args, enqueues nothing, and is serviced on the same tick-boundary oneshot
    // seam as machine_config / webhook_url. Both transports answer it (the dev-WS
    // `loaded_scene` query verb; the Tauri `loaded_scene` command), and the dev-WS
    // sender buffers before open, so a boot-time query still flushes on connect.
    let cancelled = false;
    const ask: Promise<unknown> =
      transportKind() === 'dev'
        ? devWsInvoke('loaded_scene', {})
        : import('@tauri-apps/api/core').then(
            ({ invoke }) => invoke('loaded_scene') as Promise<unknown>,
          );
    ask
      .then((wire) => {
        if (cancelled || sceneActedRef.current) return;
        setLoadedScene(sceneDisplayNameOf(wire));
      })
      .catch((e: unknown) => {
        // A broken bridge LEAVES THE BADGE ABSENT and says so, rather than
        // silently falling back to a guess (the 40-review WR-04 discipline).
        console.error('[fabrico] loaded_scene bridge error', e);
      });
    return () => {
      cancelled = true;
    };
  }, [transportReady]);
  // Alt-hold reveal (Factorio alt-mode), tracked SEPARATELY from the persistent
  // toggle so a lost keyup can be reset without clearing the user's persistent
  // choice. The window-level Alt keydown/keyup listeners set/clear it, and a
  // window blur + a document visibilitychange BOTH force it false (RESEARCH
  // Pitfall 4) so a held Alt that loses focus (Alt+Tab / OS menu steal in a
  // webview) never sticks the labels on.
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Guard on the actual Alt key (not altKey on unrelated chords) so only a
      // bare Alt hold reveals labels. `.repeat` no-ops keep it a cheap set. The key is the
      // shortcut table's `names` entry (phase 91, D-11), the one Help's Show names row cites.
      if (matchesShortcut(e, SHORTCUTS.names) && !e.repeat) setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (matchesShortcut(e, SHORTCUTS.names)) setAltHeld(false);
    };
    const reset = (): void => setAltHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, []);
  // READ-01: the machine-name chips show while the persistent toggle is on OR Alt
  // is held. Derived (never stored), so the two reveal paths compose cleanly.
  const labelsVisible = altHeld || labelsToggled;
  // The screen-space anchor for the floating DeleteControl. Positioned
  // IMPERATIVELY (transform written each frame by the rAF below) rather than via
  // React state, so gluing the control to the ring during a pan/zoom costs a
  // cheap DOM write and never re-renders the whole chrome tree at 60fps.
  const deleteAnchorRef = useRef<HTMLDivElement | null>(null);
  // The delete-with-in-flight-items guard (REND-03): its state, its drain poll and
  // its outcomes live in `useDeleteGuard` (plan 76-16). `guardRef` is the ref mirror
  // the once-created gesture controller reads via `isModalOpen` (WR-01);
  // `cancelGuard`, `openGuard` and `stopDrain` are ref-stable, so the once-registered
  // packet handler and the mount effect can hold them.
  const { guard, guardRef, openGuard, cancelGuard, stopDrain, deleteAnyway, drainFirst } =
    useDeleteGuard({
      commitDelete: (handle) => gesturesRef.current?.commitDelete(handle),
      beltItems: (beltIds) => {
        const scene = window.__fabrico?.scene();
        if (!scene) {
          return null;
        }
        return scene.belts
          .filter((b) => beltIds.includes(b.id))
          .reduce((sum, b) => sum + b.items, 0);
      },
    });
  // SAFE-03: whether the warn-on-quit QuitGuardDialog is shown. Opened by the OS
  // close interception (Tauri onCloseRequested / the requestQuit test seam) ONLY
  // when dirty; a clean/just-saved board never opens it.
  const [quitGuardOpen, setQuitGuardOpen] = useState(false);
  // CR-01: a ref mirror of `quitGuardOpen` so the once-created gesture controller
  // can read the LIVE quit-modal-open status via `isModalOpen` (the same pattern
  // as guardRef). Without this the QuitGuardDialog is NOT in the gesture layer's
  // modal gate, so canvas shortcuts (Space/./r/Delete, r+Delete emit real
  // GridCommands) fire behind the open "unsaved changes" dialog.
  const quitGuardOpenRef = useRef(false);
  quitGuardOpenRef.current = quitGuardOpen;

  // ---- SAFE-03 warn-on-quit outcomes ---------------------------------------
  // Cancel keeps the window (dismiss the dialog, issue nothing). "Quit anyway"
  // upholds the CANNOT-STRAND invariant (T-34-QUIT): it ALWAYS proceeds to
  // destroy the window, so the dirty flag can never trap the user unable to quit.
  // The destroy uses the narrow core:window:allow-destroy capability; it is
  // attempted only under Tauri (the web fallback quits via the native
  // beforeunload prompt, never this dialog).
  const cancelQuitGuard = useCallback((): void => {
    setQuitGuardOpen(false);
  }, []);
  const quitAnyway = useCallback((): void => {
    // Dismiss first so the guard can never re-intercept, THEN destroy — the guard
    // is out of the way regardless of how the destroy resolves (no strand).
    setQuitGuardOpen(false);
    if (detectEnv().hasTauri) {
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().destroy())
        .catch((err: unknown) => {
          // IN-02: a failed dynamic import or destroy() must NOT become a silent
          // unhandled rejection. The guard is already dismissed above, so the
          // CANNOT-STRAND invariant still holds (the user can re-trigger close);
          // log the failure so a non-destroying close is observable rather than
          // invisible console noise.
          console.error('[fabrico] quitAnyway: window destroy failed', err);
        });
    }
  }, []);

  // ---- SHELL-07 honest Save/Load status (role=status readout) --------------
  // A chrome-only state machine observing the EXISTING render stream: no host
  // echo, no packet/command change. Load resolves on the Load's own swap keyframe
  // (`isLoadSwap`, D-06), never on an Undo's or Redo's; Save settles at the
  // honest dispatch-confirmed ceiling 'Save requested' (never a host-confirmed
  // 'Saved'). The status string is generic - it NEVER carries the file path
  // (threat T-32-06-01).
  const [status, setStatus] = useState<{ kind: StatusKind; at: number }>({
    kind: 'idle',
    at: 0,
  });
  // The SHELL-07 latch/timers now live in a dependency-injected state machine
  // (statusMachine.ts) so the honesty-critical reconciliation (WR-02/WR-03) is
  // directly unit-testable. Created ONCE per component instance; `setStatus` (the
  // React setter) is stable, so the machine stamps + commits without re-creation.
  // The packet resolver, undo/redo/loadDemo supersede, and mount cleanup all
  // reach it through this ref (no per-render closure churn).
  const statusMachineRef = useRef<StatusMachine | null>(null);
  // FAIL-01 (phase 90, D-11, D-12): the host's reason once its sim loop has ended, `null` while
  // it runs. The stopped card (`SimStoppedCard`) is its only reader; it never reaches the status
  // line, which reads the generic `Simulation stopped` (T-32-06-01).
  const [simFatalReason, setSimFatalReason] = useState<string | null>(null);
  if (statusMachineRef.current === null) {
    statusMachineRef.current = makeStatusMachine({
      setStatus: (kind) => setStatus({ kind, at: performance.now() }),
      loadTimeoutMs: STATUS_LOAD_TIMEOUT_MS,
      loadTickBudget: LOAD_TICK_BUDGET,
      autoClearMs: STATUS_AUTOCLEAR_MS,
      // D-06: the swap floor the scene stands at when a Load is dispatched, so only that
      // Load's own swap keyframe resolves `Loaded` (an Undo's keyframe never does).
      readSwapFloor: () => handleRef.current?.sceneState.swapFloor ?? 0,
      // WR-03: when a transient status (e.g. 'Save requested') auto-clears while
      // the render stream is still down, re-assert 'disconnected' instead of
      // 'idle'. The watchdog's sticky latch IS the stream-down signal; it fires
      // onDisconnect only once per stall, so without this a transient status that
      // displaced 'disconnected' would leave a frozen board passing as idle
      // forever (no reconnecting packet ever comes to re-fire the watchdog).
      // Review WR-B-02: not while the host-work gate holds a stall back for a Save, New or
      // example the host is still working on (it writes `Disconnected` itself if the window runs
      // out with the stream still down).
      isStreamDown: () =>
        (watchdogRef.current?.isDisconnected() ?? false) && hostWorkRef.current?.isHoldingStall() !== true,
    });
  }

  // Thin, stable wrapper the control handlers (`onStatus`) drive.
  const applyStatus = useCallback((kind: StatusKind): void => {
    statusMachineRef.current?.apply(kind);
  }, []);

  // SAFE-01: the playing-gated stall watchdog, created ONCE per instance. It sets
  // 'disconnected' DIRECTLY (NOT via statusMachine.apply, RESEARCH Open Q1): a
  // system-fault overlay on top of whatever was showing, so it never clobbers an
  // in-flight load latch. On reconnect it restores 'idle' ONLY if the readout is
  // still disconnected (a genuine save/load status raced onto the readout in the
  // meantime is left alone). `isPlaying` reads the live playingRef so the gate is
  // always fresh. `setStatus` is a stable React setter, safe from this closure.
  // Phase 90 review WR-B-02 (walk todo 2026-10-24): the host sends nothing while it swaps a board
  // or writes a file, so a playing board's stall during a Load, a Save, a New or an example that
  // then succeeds is not a dropped stream. The gate (`statusWatchdog.ts`) decides what the stall
  // writes: nothing during a Load (its own cut-off names a dead host), a check deferred by the load
  // window during a Save, New or example, the write at once otherwise. Created before the watchdog.
  if (hostWorkRef.current === null) {
    hostWorkRef.current = makeHostWorkGate({
      isStreamDown: () => watchdogRef.current?.isDisconnected() ?? false,
      isLoadInFlight: () => statusMachineRef.current?.isLoadInFlight() === true,
      isStopped: () => simStoppedRef.current,
      writeDisconnected: () => setStatus({ kind: 'disconnected', at: performance.now() }),
      windowMs: STATUS_LOAD_TIMEOUT_MS,
      tickBudget: LOAD_TICK_BUDGET,
    });
  }
  if (watchdogRef.current === null) {
    watchdogRef.current = makeStatusWatchdog({
      isPlaying: () => playingRef.current,
      // FAIL-01 (D-12): once the simulation stopped neither write runs, so `simStopped` is
      // never replaced by `Disconnected` or cleared to idle by a late packet (the gate reads the
      // stop too).
      onDisconnect: () => {
        hostWorkRef.current?.onStall();
      },
      onReconnect: () => {
        if (simStoppedRef.current) return;
        hostWorkRef.current?.onReconnect();
        setStatus((s) =>
          s.kind === 'disconnected' ? { kind: 'idle', at: performance.now() } : s,
        );
      },
      thresholdMs: DISCONNECT_MS,
    });
  }

  // SAFE-01: drive the watchdog gate from the single `playing` source, so BOTH
  // toggle paths (Toolbar button + keyboard Space) and boot are covered. Resume
  // arms the stall timer; pause disarms it (a paused sim emits zero packets by
  // design, so a pending timer must be cancelled or it would false-fire). Reads
  // the fresh playingRef via the watchdog's own isPlaying gate.
  useEffect(() => {
    // WR-01: `arm()` is a no-op until the watchdog has seen its first packet
    // (the stall timer never runs against a stream that has not started), so a
    // cold boot slower than DISCONNECT_MS can no longer flash a false
    // "Disconnected". The first arm happens inside watchdog.onPacket on the first
    // delivery; this effect governs the later pause/resume toggles.
    // FAIL-01 (D-12): a stopped simulation never re-arms it.
    if (playing && !simStoppedRef.current) watchdogRef.current?.arm();
    else watchdogRef.current?.clear();
  }, [playing]);

  // WR-03: drop a pending Load latch (and clear the `Loading…` it left). Wired into the
  // earlier-declared doLoadScene/doNew via supersedeLoadInFlightRef, the two swaps a page
  // can issue over a pending Load. Save and a fresh Load already supersede via `apply`;
  // Undo and Redo no longer do (D-06).
  supersedeLoadInFlightRef.current = (): void => {
    statusMachineRef.current?.supersedeLoad();
  };

  useEffect(() => {
    let disposed = false;
    let pollRaf = 0;
    // IN-03 boot-fit deferral rAF handle, held at effect scope so the mount-once
    // cleanup below can cancel a pending chrome-ready poll exactly like pollRaf
    // (no rAF leak across the StrictMode double-boot). Assigned inside the IIFE
    // while the deferred boot-fit waits for the React chrome DOM to commit.
    let bootFitRaf = 0;
    // NAV-01 Home-key re-fit listener, held at effect scope so the mount-once
    // cleanup below can remove it exactly like pollRaf (no window-level leak
    // across the StrictMode double-boot). Assigned inside the IIFE once `handle`
    // (the fit target) exists; null until then.
    let onHomeKey: ((e: KeyboardEvent) => void) | null = null;

    void (async () => {
      const handle = await bootPixi();
      if (disposed) {
        // StrictMode cleanup already ran before init resolved — tear down.
        handle.app.destroy(true);
        return;
      }
      handleRef.current = handle;
      // Plan 88-07 (D-09): every occupancy reader receives this scene, so the claims ride on it.
      handle.sceneState.queuedClaims = queuedClaimsRef.current;
      hostRef.current?.appendChild(handle.app.canvas);

      // Install the read-only introspection hook (REND-02). Reassigned on each
      // mount so a StrictMode double-boot always points `scene()` at the LIVE
      // handle (Pitfall 6); the cleanup nulls it so a torn-down handle is never
      // queried. It returns ONLY a fresh plain-data snapshot — no setters, no
      // Pixi refs — so it can never mutate the scene or bypass the command layer
      // (threat T-14-FABRICO-RO). The WebGL item layer stays opaque (counts only).
      // `stats()` is the second read: process-lifetime monotonic decode counters
      // (packetsApplied / decodeErrors) that make the WR-07 silently-dropped
      // DecodeError observable to the live E2E gate - a fresh plain object per
      // call, no setters, same T-14-FABRICO-RO discipline. The closure counters
      // die with the effect; the cleanup below nulls the hook.
      let packetsApplied = 0;
      let decodeErrors = 0;
      // NAV-01 boot fit, per LOAD since plan 85-06 (DEMO-07, D-12). Re-armed here on
      // every mount, so the StrictMode double-boot frames cleanly per mount, exactly as
      // the old per-mount closure latch did. The board the app boots into is framed by
      // its first restructure keyframe with nodes, and every later load re-arms the fit
      // through `fitPendingRef` (see the take site below).
      fitPendingRef.current = true;
      fitIsBootRef.current = true;

      // Read the live chrome insets from the toolbar/palette getBoundingClientRect
      // at fit time (their rendered heights are not source constants — RESEARCH
      // Open Question 2 / A3). The toolbar is the only `header.fab-panel`, the
      // palette the only `aside.fab-panel`. Rects are viewport-relative, so we
      // rebase them onto the canvas-local screen space `app.screen`/the camera use.
      // A missing or zero-size rect falls back to the constant insets.
      const CHROME_GAP = 24; // breathing gap between a chrome edge and the factory
      const INSET_FALLBACK: Insets = { top: 72, left: 96, right: 24, bottom: 24 };
      const computeChromeInsets = (): Insets => {
        const canvasRect = (handle.app.canvas as HTMLCanvasElement).getBoundingClientRect();
        const tRect = document.querySelector('header.fab-panel')?.getBoundingClientRect();
        const pRect = document.querySelector('aside.fab-panel')?.getBoundingClientRect();
        const top =
          tRect && tRect.height > 0
            ? tRect.bottom - canvasRect.top + CHROME_GAP
            : INSET_FALLBACK.top;
        const left =
          pRect && pRect.width > 0
            ? pRect.right - canvasRect.left + CHROME_GAP
            : INSET_FALLBACK.left;
        return { top, left, right: INSET_FALLBACK.right, bottom: INSET_FALLBACK.bottom };
      };
      // The single fit entry point shared by boot (the latch) and the Home key —
      // view-only: reads the decoded sceneState and mutates only the camera
      // Container, emitting no GridCommand and touching no packet/transport.
      const doFit = (): void => {
        fitToFactory(
          handle.cam,
          handle.sceneState,
          handle.app.screen.width, // CSS px (NOT app.renderer.width device px)
          handle.app.screen.height,
          computeChromeInsets(),
        );
      };
      // NAV-01: publish the shared fit closure so the render-level Fit button
      // (CameraCluster onFit) invokes this EXACT body — one fit source for boot,
      // the Home key, and the button. Nulled in the cleanup below.
      doFitRef.current = doFit;
      // IN-03: true once the React chrome (toolbar + palette) has committed to
      // the DOM AND laid out, so computeChromeInsets() will read REAL rects
      // instead of INSET_FALLBACK. Mirrors the exact selectors + non-zero-size
      // predicate computeChromeInsets uses, so "chrome ready" here means "the
      // insets a Fit click would read are now measurable".
      const chromeInsetsReady = (): boolean => {
        const tRect = document.querySelector('header.fab-panel')?.getBoundingClientRect();
        const pRect = document.querySelector('aside.fab-panel')?.getBoundingClientRect();
        return !!tRect && tRect.height > 0 && !!pRect && pRect.width > 0;
      };
      // IN-03: run the boot-fit ONLY once the chrome insets are measurable,
      // polling per animation frame until then. The packet handler can process
      // the first full keyframe BEFORE React commits the chrome DOM (setReady is
      // called after this handler is registered), so firing doFit synchronously
      // there races the commit and can boot-frame at INSET_FALLBACK (72/96/24/24)
      // — while a later Fit click reads the real chrome rects, breaking NAV-01's
      // "Fit == boot" invariant and flaking the live zoom-readout gate. Deferring
      // until the insets exist makes boot-fit read the IDENTICAL insets the Fit
      // button reads, so the two frame to the same zoom deterministically. Self-
      // terminates on `disposed` (StrictMode double-boot safe); the pending rAF is
      // tracked in `bootFitRaf` so the mount cleanup can cancel it.
      const fitWhenChromeReady = (): void => {
        if (disposed) return;
        if (chromeInsetsReady()) {
          bootFitRaf = 0;
          doFit();
        } else {
          bootFitRaf = requestAnimationFrame(fitWhenChromeReady);
        }
      };
      // The frame-time probe (GATE-05 baseline groundwork): a bounded rolling
      // average of the render ticker's per-frame deltaMS on the shipped default
      // scene. Read-only introspection only - `frameTime()` returns a fresh
      // number, exposes no setter and no Pixi ref, and never mutates the scene
      // or the deterministic sim clock (T-23-06 / T-14-FABRICO-RO). Detached in
      // the cleanup below, consistent with the reassign-per-mount lifecycle.
      const frameProbe = createFrameProbe(handle.app);
      frameProbeRef.current = frameProbe;
      window.__fabrico = {
        scene: () => sceneSnapshot(handle.sceneState),
        stats: () => ({ packetsApplied, decodeErrors }),
        frameTime: () => frameProbe.avg(),
        // MOTION-04 deterministic probe spine: read the effective render frame and
        // pin/unpin the render clock. Always exposed (not DEV-guarded) because it
        // is the substrate the live e2e frame probes ride; it is production-inert
        // (pinnedClock defaults null) and controls ONLY the render clock - it never
        // writes scene.tick, a command, or the log (threat T-26-01), mirroring the
        // read-only scene() oracle discipline.
        frame: () => handle.frame(),
        // Phase 90 (FAIL-01): the ticker's last finished frame, the render-health read for a
        // held board (`expectRenderLoopAlive(.., { boardHeld: true })`). Read-only.
        tickerTime: () => handle.app.ticker.lastTime,
        // NAV-01 read-only camera snapshot (T-14-FABRICO-RO): a BRAND-NEW object
        // literal each call reading the root Container pan (handle.camera.x/y) and
        // the uniform zoom (handle.cam.worldScale()). handle.camera (the live
        // Container) is NEVER returned, and there is no setter/mutator, so this
        // getter can never become a write path into camera/view state. Always
        // exposed (not DEV-guarded) because the e2e coordinate transform rides it
        // in both dev and CI.
        camera: () => ({
          x: handle.camera.x,
          y: handle.camera.y,
          scale: handle.cam.worldScale(),
        }),
        // CONNECT-02 (67-REVIEW WR-05): the ring-paint liveness probe. A pure read
        // of `alertBornMs !== null` inside the overlay - the SAME state the paint
        // and the TTL are driven from, and the same one the gesture layer's hit
        // test gates on - so it can never report a ring the user cannot see. No
        // setter, no Pixi ref, no scene/command/log write.
        alertRingsActive: () => handle.overlay.alertRingsActive(),
        // 73-14: the PLOT half of the probe directly above, and the thing that makes the
        // stranded ring assertable at all. The latch says the paint was CALLED; this says
        // the Graphics HOLDS GEOMETRY. Both are exposed because they answer different
        // questions - the latch is what the gesture layer gates its hit test on, so a spec
        // asserting pressability still wants it - and neither is a setter.
        alertRingInstructions: () => handle.overlay.alertRingInstructions(),
        // 74.1-27: the ring centres as PLOTTED, beside the count, so a live leg grades
        // where the rings are and not only that some ring drew. A fresh array each call.
        alertRingCentres: () => handle.overlay.alertRingCentres(),
        // 74.1-33: the target rings as PLOTTED, so a live leg grades that no ring invites
        // a drop the host refuses (WR-02) off the canvas and not off the predicate.
        targetRingsPlotted: () => handle.overlay.targetRingsPlotted(),
        // 74-05: the reject flash's plot half, in the same position and delegating the
        // same way. The flash is the ONLY visible answer a ring-sourced near-miss gets,
        // and until now nothing outside a unit test could see whether it painted.
        rejectFlashInstructions: () => handle.overlay.rejectFlashInstructions(),
        // 89-09: WHERE the flash is plotted, beside how much of it is, so a refusal leg grades
        // the cell the flash names off the canvas and not off the call that asked for it.
        rejectFlashCell: () => handle.overlay.rejectFlashCell(),
        // Review IN-C-01: the flash serial, so the live latch tells two flashes on one cell apart.
        rejectFlashSerial: () => handle.overlay.rejectFlashSerial(),
        // 88-05: the pending shimmer's plot half, beside the flash's, so FAIL-07's live spec
        // reads what is drawn on the cell after a refusal and not a model flag.
        pendingInstructions: () => handle.overlay.pendingInstructions(),
        // PILE-08 check 3 (71-06): the gauge-paint liveness probe, in exactly the position
        // `alertRingsActive` above occupies. A pure read of the machine layer's own
        // painted set, whose membership is decided by whether the gauge Graphics HOLDS
        // GEOMETRY - so it cannot report a mark the user cannot see. No setter, no Pixi
        // ref, no scene/command/log write.
        backedUpMarksPainted: () => handle.machines.loadGaugesPainted() > 0,
        // WR-05: the per-node form of the probe above, so a spec that NAMES a machine
        // can assert about that machine rather than about the board. Same painted set,
        // same plot-derived membership, one id.
        backedUpMarkPaintedOn: (id: number) => handle.machines.loadGaugePaintedOn(id),
        // Plan 77-07: the gauge's drawn FORM on one node and the scene tick it was drawn
        // from, plain data read back off the gauge Graphics, never off node.load.
        loadGaugeFormOn: (id: number) => handle.machines.loadGaugeFormOn(id),
        // 73-10: the port-nub paint probe, beside the two gauge probes and delegating
        // the same way - a number read back off the nub Graphics, never off node.ports.
        // A hook that answered from the port list would BE the model-oracle blind spot
        // rather than a probe for it.
        portNubInstructionsOn: (id: number) => handle.machines.portNubInstructionsOn(id),
        // Phase 76: the label-box paint probe, delegating exactly as the line above does -
        // plain data read back off the label's own Graphics, never off the scene model.
        labelBoxOn: (id: number) => handle.machines.labelBoxOn(id),
        // Plan 76-08: the layer's census and the art each root draws, both read back off
        // the display list (the root's children and the glyph's own context), never off
        // the scene model, delegating exactly as the line above does.
        drawnNodes: () => handle.machines.drawnNodes(),
        glyphSubjectOn: (id: number) => handle.machines.glyphSubjectOn(id),
        // Plan 85-02: the glyph's drawn box and the machine's footprint, off the same objects.
        glyphBoxOn: (id: number) => handle.machines.glyphBoxOn(id),
        // Plan 77-02: the item dots the item layer placed, read back off its own batch.
        itemDots: () => handle.items.plottedDots(),
        // Plan 77-04: the same dots with the scene tick the latest item draw read them from.
        itemDotsFrame: () => handle.items.plottedDotsFrame(),
        // Plan 76-15: the live selection ref, read-only, so a check can act between the
        // keyframe branch and React's commit and know which side of it it is on.
        selectedNode: () => selectedNodeRef.current,
        // The 76-17 refuter round: the live belt selection ref, read-only, the belt
        // channel's twin of `selectedNode` above.
        selectedBelt: () => selectedBeltRef.current,
        // Plan 76-03: the label's pending-size outline, read back off the overlay's
        // `label-resize-preview` Graphics, or null when it holds nothing.
        labelResizePreview: () => handle.overlay.labelResizePreview(),
        // 74-09: the BELT-END paint probe, delegating exactly as the line above does -
        // a number read back off that belt's `ends` Graphics, never off `belt.docks`.
        beltEndInstructionsOn: (id: number) => handle.belts.endInstructionsOn(id),
        beltCollarCentresOn: (id: number) => handle.belts.collarCentresOn(id),
        // 74.1-20: what the belts layer DREW, read back off its own geometry record.
        beltDrawnKindsOf: (id: number) =>
          handle.belts.drawnTilesOf(id)?.map((t) => JSON.parse(JSON.stringify(t.kind))) ?? null,
        // 74.1-26: the preview's plot half, beside the drawn-kinds read it is graded with.
        beltPreviewInstructions: () => handle.overlay.beltPreviewInstructions(),
        // 75-05: the wire drag preview's plot read, delegating exactly as the line above does.
        wirePreviewPolylines: () => handle.overlay.wirePreviewPolylines(),
        // 74.1-30 (CR-01): the preview's SHAPE half, the plotted kind at one cell.
        beltPreviewKindAt: (cellX: number, cellY: number) => handle.overlay.beltPreviewKindAt(cellX, cellY),
        // 89-03 (BELT-10): the tread rotation the belts layer drew at one cell, off its tile object.
        beltTreadRotationAt: (cellX: number, cellY: number) => handle.belts.treadRotationAt(cellX, cellY),
        // 88-07: the drag preview's colour and the ghost's body and colour, as plotted, so the
        // BELT-06 legs grade the "no" the user is shown off the canvas, not off the prediction.
        beltPreviewPlotted: () => handle.overlay.beltPreviewPlotted(),
        ghostPlotted: () => handle.overlay.ghostPlotted(),
        // 75-06: the re-route mark's plot read, a number off the cables Graphics.
        rerouteMarkStrokes: () => handle.wires.rerouteMarkStrokes(),
        // 77-05: the resting cables' plot read, delegating exactly as the line above does.
        cablePolylines: () => handle.wires.cablePolylines(),
        pinClock: (n: number | null) => handle.pinClock(n),
        // SLOT-04 (D-10): the trailing-interpolation toggle, exposed on the SAME
        // always-shipped production-inert surface as pinClock (see the interface
        // docblock for why a DEV gate would be absent from the one build that needs
        // it). Default OFF; it writes a render-side boolean and nothing else.
        setItemInterpolation: (on: boolean) => handle.setItemInterpolation(on),
        // WUI-01: resolve a node handle to its loopback POST URL over the dev-WS
        // webhook_url bridge (40-05) — used by the live wire-visual gate to drive a
        // REAL hop against the demo headline wire's endpoint. Read-only (URL fetch
        // only, no scene/command/log write). Null off the dev transport or for a
        // non-addressable handle; never throws. WR-04 (40-review): a bridge error is
        // LOGGED (not silently swallowed) so a broken CI bridge is diagnosable rather
        // than masquerading as an indistinguishable "non-addressable" null.
        webhookUrl: (h: number): Promise<string | null> =>
          devWsInvoke('webhook_url', { node: h })
            .then((u) => (typeof u === 'string' ? u : null))
            .catch((e) => {
              console.error('[fabrico] webhookUrl bridge error', e);
              return null;
            }),
        // SAFE-03: the dirty-only quit decision, exposed always (like camera/frame)
        // so the Chromium e2e drives the dirty-only gate + dialog discipline in CI
        // without a real OS close. Mirrors the Tauri onCloseRequested body exactly:
        // open the guard + report "intercepted" ONLY when dirty. Production-inert —
        // it opens a cancelable confirm and writes no scene/command/log (T-34-QUIT).
        requestQuit: (): boolean => {
          if (hasUnsavedWork()) {
            setGuardWork(unsavedWork());
            setQuitGuardOpen(true);
            return true;
          }
          return false;
        },
        // Review WR-B-03: the guards' predicate, the board's unsaved edits or the edits queued on
        // the paused board. A read; it writes nothing. The live helpers read it before a New, an
        // Open or an example, to know whether the guard will ask.
        hasUnsavedWork: (): boolean => hasUnsavedWork(),
        // Phase 90 (D-03, Finding I): the edit gestures sent and not yet answered. A read of
        // a set's size; it writes nothing (T-90-14). Always exposed, like requestQuit.
        editsAwaitingVerdict: (): number => editGesturesRef.current.size,
        ...(import.meta.env.DEV
          ? {
              // SAFE-01: flip the dev stream-drop simulator (see the ref + the
              // onPacket short-circuit). Writes ONLY the render-delivery flag; no
              // scene/command/log write (T-34-DET). DEV-guarded so it is
              // tree-shaken from production.
              simulateStreamDrop: (on: boolean): void => {
                streamDropSimRef.current = on;
              },
              // Review WR-C-03: how many controls and gestures the page has handed to the
              // transport. Reads of two counters; they write nothing.
              controlsSent: (): number => sendCountsRef.current.controls,
              inputsSent: (): number => sendCountsRef.current.inputs,
            }
          : {}),
      };

      // The authoritative echo path: inbound render-packets flow into the scene
      // buffer the Pixi layers + the chrome read. The transport is a process-wide
      // singleton (created once); the dev WebSocket fails quiet with no host, so
      // a freshly-placed ghost simply persists until a host echoes it (07-08).
      // Review WR-C-03: every control and gesture the page hands over is counted (two integers),
      // and the DEV hooks `controlsSent` / `inputsSent` read the counts.
      const transport = countSends(makeTransport(), sendCountsRef.current);
      transportRef.current = transport;
      // ERR-01: THE verdict path, and on both transports alike since the Tauri gesture
      // command became a blocking enqueue. The dev WebSocket routes a verdict TEXT frame
      // here; the Tauri transport routes a `subscribe_gesture_verdicts` channel message
      // here. Since phase 88 (D-06) every gesture is answered: a refusal, an accept naming
      // the handles it minted, or a swap's discard. Read through the ref mirrors so this
      // once-only registration always calls the LIVE handlers.
      transport.onGestureVerdict((verdict: GestureVerdict) => {
        // Every verdict, of every kind, reaches the gesture controller FIRST (plan 88-05,
        // D-06): the pending Place with that gesture id ends on it, or waits for the packet
        // that shows the handle its accept names. A refused Place's waiting shimmer clears
        // here, so the band's sentence never stands beside it (D-10).
        // Plan 88-07: the gesture's claim ends on its refusal or discard, or is armed to end on
        // the packet that shows its accept. First, so a repaint the controller makes reads it.
        queuedClaimsRef.current.onVerdict(verdict, handleRef.current?.sceneState);
        gesturesRef.current?.onVerdict(verdict);
        // T-88-25 re-audit: asked once per verdict, so a quiet id is forgotten on any answer.
        const quiet = quietGesturesRef.current.hear(verdict);
        // D-03 (phase 90, WORK-08): an edit this page sent is answered. Its accept marks the
        // board unsaved (`dirtyAfterVerdict`); a refusal, a discard, or an accept from a board a
        // swap has replaced (below the scene's swap floor) leaves the flag as it was. A refusal
        // with no `seq` names no gesture and matches nothing.
        const seq = verdict.seq;
        if (seq !== undefined && editGesturesRef.current.delete(seq)) {
          setDirty(
            dirtyAfterVerdict(
              dirtyRef.current,
              editVerdictOf(verdict, GESTURE_ACCEPT_KIND, handleRef.current?.sceneState.swapFloor ?? 0),
            ),
          );
        }
        // ONLY a refusal reaches the user (Pitfall 8): an accept and a discard show no
        // sentence. Plan 74.1-28: a refusal naming a latched port edit releases it FIRST,
        // before the display's stale-drop can swallow the verdict.
        if (verdict.kind === GESTURE_REFUSAL_KIND) {
          releaseRefusedPortEditRef.current(verdict);
          // A quiet follow-up (T-88-25 re-audit) is refused in silence: the user never sent it.
          if (!quiet) showRefusalRef.current(verdict);
        }
      });
      transport.onLoadRefused((reason) => {
        // DEMO-07 (plan 85-06): a refused load emits no keyframe and the board on screen
        // stays, so a pending fit is dropped here. Left pending, it would be taken by the
        // next unrelated restructure (an Undo's keyframe) and yank the camera.
        fitPendingRef.current = false;
        // Plan 88-07: and no swap keyframe will come to end the queued claims.
        claimSwapRef.current = false;
        setLoadRefusedReasonRef.current(reason);
        // UI-SPEC A9: the strip agrees with the card the moment it appears. D-02 (phase 90): the
        // refused file never becomes the save target, and the board on screen keeps its unsaved
        // flag. Review WR-B-07: both only for a Load this page still awaits (`isAwaitingSwap`,
        // which holds past the cut-off), so another client's refused Load neither writes over an
        // unrelated status here nor drops a pending Open of this page that the host is answering.
        const machine = statusMachineRef.current;
        if (machine?.isAwaitingSwap() === true) {
          pendingLoadRef.current = null;
          machine.refuseLoad();
        }
      });
      // Phase 90 review WR-A-03: the host could not write a Save this page sent (a disk error, or a
      // drain that ran out of budget with an effect still in flight). The strip says so and the
      // board reads unsaved again if it was when the Save went out, or has been edited since. The
      // host's sentence is not shown (the strip carries no host text, T-32-06-01).
      transport.onSaveFailed(() => {
        if (simStoppedRef.current) return;
        // Review WR-B-02: the host answered the Save, so it is no longer working on it.
        hostWorkRef.current?.end();
        setDirty(dirtyRef.current || dirtyBeforeSaveRef.current);
        dirtyBeforeSaveRef.current = false;
        statusMachineRef.current?.apply('saveFailed');
      });
      // FAIL-01 (phase 90, D-11, D-12): the host's sim loop ended. Both transports deliver it
      // out of band, on connect too, so a page that loads after the fatal is told. The reason
      // is kept for the stopped card; the status line reads `Simulation stopped`.
      transport.onSimFatal((reason) => {
        setSimFatalReason(reason);
        // Sticky and highest (UI-SPEC 1.5): the machine drops a latched Load and its timers,
        // commits `simStopped` and ignores every later status; the watchdog is cleared and
        // its writes stand down; the page is paused, because the sim is not running.
        simStoppedRef.current = true;
        statusMachineRef.current?.stop();
        watchdogRef.current?.clear();
        hostWorkRef.current?.end();
        setPlayingNow(false);
        // Plan 90-07 (UI-SPEC 1.4): everything the board had in hand closes with nothing sent.
        // A draw in flight ends, an armed tool is put away and the selection clears (so a
        // config panel unmounts), the Examples popover closes, and an open discard or delete
        // guard closes as if Cancel was pressed. The quit guard is left as shipped: its words
        // are true here.
        gesturesRef.current?.standDown();
        setExamplesOpen(false);
        cancelDiscardGuard();
        cancelGuard();
      });
      // WR-03: the dev-WS query sender is registered by makeTransport above, so
      // only NOW may the loaded_scene query run (see `transportReady`).
      setTransportReady(true);
      transport.onPacket((bytes) => {
        // SAFE-01 dev-only: simulate a dropped stream by ignoring inbound bytes
        // entirely, so the watchdog stalls exactly as a real drop would (the
        // canvas freezes on its last frame; the watchdog is never reset). The
        // ref is always false in production (the setter is DEV-guarded below).
        if (streamDropSimRef.current) return;
        // SAFE-01: a byte delivery = the stream is alive. Reset the stall
        // watchdog (and signal reconnect -> idle if we were disconnected). Runs
        // BEFORE decode so even a malformed frame counts as liveness - a stalled
        // producer, not a bad byte, is what the watchdog watches for.
        watchdogRef.current?.onPacket();
        try {
          const packet = decodeRenderPacket(bytes);
          // FAIL-05 (D-09): a diff older than the scene is dropped here, before every reader
          // below (it must not end an undo hold or clear a wire latch); the watchdog above
          // already counted its bytes as liveness, and it is not counted as applied.
          if (isStaleDiff(handle.sceneState, packet)) return;
          // Review WR-B-02: the ticks a Save, New or example has taken since it was sent; a New's
          // or an example's work ends at its swap keyframe.
          hostWorkRef.current?.onPacket(packet.tick, isTimelineRestructure(packet));
          // Review IN-B-02: an edit whose answer is overdue lost it; it no longer counts as awaited.
          dropOverdueEdits(editGesturesRef.current, packet.tick, LOAD_TICK_BUDGET);
          // Decode succeeded: count it BEFORE any downstream handler work, so
          // the counter reads as decode outcomes only (not handler health).
          packetsApplied += 1;
          // Plan 74.1-31: the undo hold ends on the first packet whose tick differs from
          // the one on screen when Play or Step was requested. Plan 74.1-35: or, after
          // New, an example or Open, on the swap's own keyframe (a restructure, never a
          // resync and never a drained tick), which the host emits after discarding the
          // edits queued on the old board.
          const queued = queuedEditsRef.current;
          if (queued !== null) {
            const landed = queued.foldTick !== null && packet.tick !== queued.foldTick;
            const discarded = queued.swapRequested && isTimelineRestructure(packet);
            if (landed || discarded) {
              queuedEditsRef.current = null;
              setUndoHeld(false);
            }
            // The edits the queued or held notice names no longer exist, so it goes at
            // once. With a load in flight `resolveKeyframe` below replaces it with
            // `Loaded` instead, as before.
            if (discarded && !landed && statusMachineRef.current?.isLoadInFlight() !== true) {
              setStatus((st) =>
                st.kind === 'editsQueued' || st.kind === 'undoHeld' ? { kind: 'idle', at: performance.now() } : st,
              );
            }
          }
          // D-15 stranded-dock probe (REND-06): diff the incoming packet against
          // the scene BEFORE applyPacket overwrites the baseline — a rotate-unlink
          // arrives as "belt re-emitted WITHOUT the dock the scene still holds".
          // Returns [] on full:true by construction (keyframes re-mint handles;
          // undo/redo/load restructure legitimately — zero false rings).
          const stranded = detectStrandedDocks(handle.sceneState, packet);
          // The keyframe sibling (`detectKeyframeStrand`, widened by 74.1-27 from the
          // MOTION-06b undo-of-a-turn detector): detectStrandedDocks returns [] on a full
          // keyframe by construction, and an undo or redo always arrives as one. It
          // fires when a keyframe that is neither a resync nor a load (tick continuity)
          // changes one machine's turn or port count and a belt lost its dock to it -
          // the redo of `Remove output 1` is the case (walk item N5B). Both detectors run
          // PRE-apply against the same baseline; the keyframe path also carries the
          // node's structural identity so `strandRingPoints` finds the re-minted node
          // after the apply (WR-01).
          const events =
            stranded.length > 0
              ? stranded
              : packet.full
                ? detectKeyframeStrand(handle.sceneState, packet)
                : [];
          // MOTION-06a: classify the edit-clear BEFORE applyPacket overwrites the
          // baseline (same PRE-apply prev the strand probe needs). Holding the
          // boolean lets the clear branch below fire ONLY on a genuine
          // place/remove/rotate/dock-change — a state-only IDLE->WORKING re-emit
          // (which rides packet.placed with just its `state` byte changed) is
          // NON-structural, so a fired ring survives a flowing scene instead of
          // vanishing after ~1 tick (RESEARCH Pitfall 5). Since the 2026-08-30 TTL
          // retirement "survives" means until a real edit resolves it, which makes
          // this classification the whole clear side of the ring's lifetime.
          const structural = isStructuralEdit(handle.sceneState, packet);
          // SAFE-03: reuse the SAME pre-apply structural classification to maintain
          // the dirty flag. A genuine NON-keyframe structural edit (place / rotate /
          // delete / dock via a diff packet) dirties the board; a state-only re-emit
          // (IDLE->WORKING) or pure item-flow packet does NOT (nonStructural = no
          // change). Full keyframes are handled by their SOURCE, never here: undo/
          // redo must not dirty (not user edits) and load/loadDemo CLEAR via their
          // control handlers — so the packet path only ever flips dirty TRUE, and
          // only on a real diff-packet edit (T-34-DIRTY-FALSE).
          if (!packet.full) {
            // SAVE-05: route through setDirty so a genuine structural edit lights
            // the toolbar Unsaved badge. Change-guarded inside setDirty, so a
            // non-structural re-emit (the common per-tick packet) is a no-op and
            // never re-renders the chrome.
            setDirty(
              nextDirty(
                dirtyRef.current,
                structural ? 'structuralEdit' : 'nonStructural',
              ),
            );
          }
          // 74.1-27 (N5): the board as it was BEFORE this packet, kept only when a strand
          // was detected (a shallow copy of the node map; `applyPacket` replaces node
          // objects rather than mutating them). The vacated nub is resolved against it,
          // because after a port edit the dock's old key names a different port.
          const preApply =
            events.length > 0 || (structural && standingStrandsRef.current.length > 0)
              ? { nodes: new Map(handle.sceneState.nodes) }
              : null;
          // Plan 76-19: the nodes the pending port-edit latches were about, kept only for a
          // `full` packet with a latch open (a shallow copy; `applyPacket` clears the map).
          const latchedBefore =
            packet.full && portEditLatchesRef.current.size > 0 ? new Map(handle.sceneState.nodes) : null;
          applyPacket(handle.sceneState, packet);
          // Phase 91 (D-10, CHROME-10): the empty-board hint follows the scene on the packet that
          // changes it, committed synchronously, so no drawn frame holds both the hint and the
          // first machine. Only the edge commits; every other packet leaves React alone.
          const emptyNow = handle.sceneState.nodes.size === 0 && handle.sceneState.belts.size === 0;
          if (emptyNow !== boardEmptyRef.current) {
            boardEmptyRef.current = emptyNow;
            flushSync(() => setBoardEmpty(emptyNow));
          }
          // Plan 88-07 (D-09): an accepted claim the scene now shows ends (the scene carries it),
          // and a claim with no verdict ends on playing ticks only. A swap's keyframe ends them
          // all: the host discarded every gesture queued on the replaced board.
          if (claimSwapRef.current && isTimelineRestructure(packet)) {
            claimSwapRef.current = false;
            queuedClaimsRef.current.clear();
            // Phase 88 (T-88-11): and every held belt ends with nothing sent. Its Docks were owed
            // on the replaced board; named again in this one they could dock a belt the user
            // never drew here. Before `clearSelection` below, so no frame lands one first. A swap
            // this page did not ask for (another client's Load) never reaches here; the
            // controller reads the packet's swap floor for that (T-88-11 re-audit).
            gesturesRef.current?.onSwap();
          }
          queuedClaimsRef.current.onPacket(handle.sceneState, playingRef.current);
          // NAV-01 / DEMO-07: FRAME EACH LOADED SCENE ONCE (plan 85-06, D-12). The
          // latch is per LOAD now, not per mount: until 85-06 it fired once at boot and
          // never again, so an example kept the previous board's zoom and could open with
          // most of its machines off screen (walk-113).
          // `fitPendingRef` is armed at boot and by every scene load request (the demo,
          // an example), cleared on a refused Load, and taken here by the next
          // TIMELINE-RESTRUCTURE keyframe (full, not a lag resync) that carries a node
          // (`takeFit`, src/chrome/sceneFit.ts). A diff never takes it, so a manual
          // placement into an empty floor never yanks the camera onto a lone footprint
          // (WR-01). New and a user's .fab Open do not arm it: an empty board has nothing
          // to frame, and a user's own board keeps the camera they had. Between loads
          // nothing re-fits, so the fit never fights the user's own pan and zoom.
          if (takeFit(fitPendingRef.current, packet, handle.sceneState.nodes.size)) {
            // Clear IMMEDIATELY (before the deferred fit runs) so a second keyframe
            // arriving during the chrome-ready wait cannot schedule a second fit
            // (WR-01's latch-before-fit order).
            fitPendingRef.current = false;
            // IN-03: defer the actual fit until the React chrome DOM has committed
            // so computeChromeInsets() reads the SAME real insets a Fit click
            // reads (see fitWhenChromeReady). Fires synchronously if the chrome is
            // already laid out, otherwise on the first frame it is.
            fitWhenChromeReady();
          }
          // SHELL-07 / D-06: every packet goes to the status machine. A pending Load
          // resolves 'loaded' ONLY on its own swap keyframe (`isLoadSwap`: full, the swap
          // floor equal to the generation and above the floor at dispatch), so an Undo's
          // or Redo's keyframe never stands in for it. Every other packet tells the
          // machine the host is still answering (its silence window and tick budget).
          // READ-ONLY observation - no scene/command write, no host echo.
          // Review WR-B-07: whether the machine still awaited a swap BEFORE this packet. The
          // pending save target lives exactly as long (`isAwaitingSwap`): a Load the machine
          // let go of with no swap (a stop, a dispatch it never latched) holds no target.
          const awaitingSwap = statusMachineRef.current?.isAwaitingSwap() === true;
          statusMachineRef.current?.resolveKeyframe(packet);
          // D-02 (phase 90, research Finding K): the same swap test moves the save target to
          // the opened file and marks the loaded board clean, now that the host confirmed it.
          const pendingLoad = pendingLoadRef.current;
          if (pendingLoad !== null && !awaitingSwap) {
            pendingLoadRef.current = null;
          } else if (pendingLoad !== null && isLoadSwap(packet, pendingLoad.floorAtDispatch)) {
            currentFilePathRef.current = pendingLoad.path;
            setDirty(nextDirty(dirtyRef.current, 'load'));
            pendingLoadRef.current = null;
            // D-03 (phase 90): the Open's swap is committed, so an answer to an edit sent
            // before it belongs to the board it replaced.
            editGesturesRef.current.clear();
            // Review WR-B-06 (D-02's "only on host confirm"): the scene badge goes with the
            // board it named, on the swap, not on the dispatch. A refused Open keeps the demo on
            // screen, so it keeps `Demo scene` too. A local action now owns the badge, so the
            // boot-time host echo must not set it back.
            sceneActedRef.current = true;
            setLoadedScene(null);
          }
          // WR-01 / UNDO-06: a full keyframe (emitted after any undo/redo/load
          // fold, Pitfall 3) rebuilds the host render-handle table from 0, so a
          // handle can be REUSED for a DIFFERENT node. Clear the ephemeral
          // selection UNCONDITIONALLY so a stale handle can never silently retarget
          // a later Delete at the wrong node (selection is frontend-ephemeral).
          if (packet.full) {
            // Plan 76-19 (audit F2): a pending port-edit latch whose handle the keyframe
            // handed to a machine with another origin cell or kind is dropped with its
            // evidence, on EVERY full packet. A guard, not the fix: since the 76-19 refuter
            // round the host sends a lag that spanned a `RenderProducer::reset` as a
            // restructure (`resync: false`), so the evidence below releases every latch,
            // including the ones this check cannot see (another Factory on the same cell,
            // or the user's own edit undone in the lag). See `remintedLatchHandles`.
            if (latchedBefore !== null) {
              const latches = portEditLatchesRef.current;
              for (const h of remintedLatchHandles(latches.keys(), latchedBefore, handle.sceneState.nodes)) {
                latches.delete(h);
                keyframeSinceLatchRef.current.delete(h);
              }
              if (latches.size === 0) portEditGrace.release();
            }
            // Plan 76-03 (76-UI-SPEC 5.4): a full keyframe clears the label's
            // pending-size outline. The selection clear below unmounts the panel,
            // whose own clear follows; this one does not wait for React.
            labelResizeRef.current = null;
            handle.overlay.clearLabelResize();
            // 73-08 / R-40: record the keyframe for the port-edit latch, which is
            // fed on the ~10Hz poll rather than here. A keyframe means the timeline
            // was restructured by something other than our edit, so a pending port
            // edit's packet index means nothing after it and the latch releases.
            // Read off the packet itself - never inferred from the key or the
            // clock. Cleared when the next latch closes (`sendPortEdit`).
            //
            // 73-12 (73-REVIEW WR-01): `full` ALONE IS NOT THE RESTRUCTURE SIGNAL,
            // and reading it as one reopened the releases-too-early direction this
            // latch exists to close. Both transports resend the CURRENT keyframe -
            // `full: true` - to a connection that fell past the bounded diff
            // broadcast, on which the timeline did NOT move and the pending
            // `RemovePort` may still be unfolded in the host's gesture channel. The
            // user's obvious response to a released latch is to click again, which
            // queues the exact duplicate the latch prevents. The host now says which
            // of the two happened, so this arm asks.
            // WR-03: recorded for every node that currently holds a pending latch,
            // because the evidence is per node. A node with no latch gets no entry,
            // which is what keeps this from growing for the session.
            if (isTimelineRestructure(packet)) {
              for (const pending of portEditLatchesRef.current.keys()) {
                keyframeSinceLatchRef.current.add(pending);
              }
            }
            // CR-01 (plan 76-15): `clearSelection()` below only QUEUES the deselect;
            // React commits it later. On the frame in between, the controls rendered
            // for the old selection are still mounted and their closures still hold
            // the pre-keyframe handle, which now names whatever node the keyframe
            // reminted onto it. Null the live refs here, synchronously, so every
            // per-frame, polled or click-time reader of the selection sees the
            // deselect on THIS frame. This also stops the ~10Hz poll seeding the panel
            // with the reminted node's ports.
            selectedNodeRef.current = null;
            selectedBeltRef.current = null;
            // The 76-17 refuter round: a remint ends the selection itself, not only the
            // handle number, so the panels' sends close here on this frame and a reselect
            // of the node now on the same number starts a new epoch (`selectionEpoch.ts`).
            liveEpoch.keyframe();
            gesturesRef.current?.clearSelection();
            // WR-06: the open delete-guard captured a machine handle (and the
            // docked belt ids its drain polls) — the SAME wrong-target Delete
            // class the selection clear above closes (T-21-08). A keyframe
            // remints handles, so `guard.handle` may now name a DIFFERENT
            // node: cancel the guard (stop any drain, no command issued)
            // rather than let deleteAnyway / the drain zero-poll commit a
            // Delete against a remint.
            cancelGuard();
          } else if (packet.placed.length > 0 || packet.belts.length > 0) {
            // WR-01/WR-02: a Rotate echo re-emits the rotated node and a Dock
            // echo re-emits the docked belt. If the re-emitted element is the
            // SELECTED one, its affordances may have moved (effective box /
            // rotate-handle corner for a node; endpoint handle anchors for a
            // belt) — re-derive them from the post-apply scene so the drawn
            // affordance matches the hit-tested one. No-op unless the current
            // selection is in the packet.
            gesturesRef.current?.refreshSelection(
              packet.placed.map((n) => n.id),
              packet.belts.map((b) => b.id),
            );
          }
          // Plan 76-03: a pending label size is re-judged against the scene this
          // packet left (a neighbour placed or removed while the panel is open turns
          // the outline red or blue). A no-op unless a label panel holds a pending size.
          if (!packet.full && labelResizeRef.current !== null) paintLabelResize();
          if (preApply) {
            // THE RING LIFETIME (`strandLifetime.ts`, TODO-FANIN option 3, amending 89-UI-SPEC
            // 4.2): a warning ring stays until its cut is resolved: the cut dock comes back, its
            // belt end takes another dock, its belt or machine is deleted, or the machine's port
            // list changes. A full keyframe (undo, redo, load) clears every ring unless the
            // keyframe detector rang a cut in it. Any other edit leaves the ring, including a turn
            // that joins nothing: D-08 never joins an end that still holds a dock, so a fan-in
            // upstream turned back stays cut, and until this rule the turn back wiped its ring
            // and the board showed a cut port with no warning.
            //
            // The ring points (74.1-27, `strandRings.ts`): a fresh cut's vacated nub resolved
            // against the node as it was BEFORE the packet, and on the post-apply node only when
            // its port count did not change (a turn moves the nub with the machine); a standing
            // cut's nub on the post-apply node, where it is now; the orphaned belt end at its end
            // tile's centre, post-apply (UI-SPEC section 6: both the vacated nub and the orphaned
            // belt end).
            //
            // CONNECT-02: the STRUCTURED hand-off (`step.rings`) runs alongside the paint. The
            // point list is flat and bare by design - the overlay is paint-only and stays that
            // way - and the gesture layer cannot see it, so each ring record carries the belt
            // handle, the event's own recorded BeltEnd (VERBATIM, never assumed from the
            // geometry, 67-UI-SPEC 4.2, threat T-67-05-02) and the ORPHANED BELT END point only,
            // the one drag source of the two. The pressable set is driven in the SAME place as
            // the paint, from the SAME records and the same point objects, so the two never
            // disagree; on a clear it is handed over EMPTY rather than left alone, because a
            // retained record could name a DIFFERENT belt after a keyframe re-mints handles
            // (threat T-67-05-01). `overlay.tick` drives the ring's 1Hz pulse and its settle at
            // ALERT_SETTLE_MS; it never retires the ring (post-UI-review F2: a stranded
            // dock is a broken state and must not heal by being ignored).
            const step = ringStep({
              standing: standingStrandsRef.current,
              pre: preApply,
              post: handle.sceneState,
              events,
              full: packet.full,
              structural,
              shownKey: shownRingKeyRef.current,
            });
            standingStrandsRef.current = step.standing;
            if (step.paint === 'show') {
              handle.overlay.showAlertRings(step.pts, performance.now());
              shownRingKeyRef.current = ringKey(step.pts);
              gesturesRef.current?.setStrandedRings(step.rings);
            } else if (step.paint === 'clear') {
              handle.overlay.clearAlertRings();
              shownRingKeyRef.current = '';
              gesturesRef.current?.setStrandedRings([]);
            }
          } else if (structural) {
            // No cut is ringed and none was found: the shipped clear, which empties a ring this
            // packet's detectors could not explain (a port-edit cut, which does not stand, see
            // `StandingStrand`) and the pressable set with it.
            handle.overlay.clearAlertRings();
            shownRingKeyRef.current = '';
            gesturesRef.current?.setStrandedRings([]);
          }
        } catch (e) {
          // The decoder is bounds-checked; drop a malformed frame at the edge
          // rather than crash the renderer (defense-in-depth, loopback host).
          // WR-07: ONLY DecodeError is the anticipated, silently-dropped case.
          // Anything else (stranded-dock probe, applyPacket, ring math) is a
          // real handler regression — if it were swallowed too, applyPacket
          // may never run again and the scene would silently freeze with zero
          // signal. Surface it loudly, but never rethrow into the transport.
          // The DecodeError branch now increments the stats() counter so the
          // drop is countable in-page (still no console noise, still no rethrow).
          if (e instanceof DecodeError) {
            decodeErrors += 1;
          } else {
            console.error('packet handler failed', e);
          }
        }
      });

      // The gesture controller drives 07-07's overlay handle and emits one logged
      // GridCommand per gesture — it never mutates the grid locally.
      gesturesRef.current = createGestureController({
        canvas: handle.app.canvas as HTMLCanvasElement,
        cam: handle.cam,
        overlay: handle.overlay,
        getScene: () => handle.sceneState,
        // ERR-01: every gesture goes through the ONE send seam, so a refusal the
        // host returns for a placement, a draw or a dock reaches the message surface
        // by the same route as one returned for an Undo. Phase 88 (D-06): the seam's
        // gesture id comes back to the controller, which pairs each pending Place with
        // its verdict by it, and a follow-up names the generation its accept was in.
        sendInput: (b, o) => submitInput(b, o),
        // D-07 (plan 88-05): the play state the chrome believes, read live, so the gesture
        // layer's one remaining timer never counts a tick a pause drained.
        isPlaying: () => playingRef.current,
        // D-12 (plan 75-07): a Wire-tool press on a belt-only port forms no command, so
        // the gesture layer raises the client sentence through the same single slot.
        onClientRefusal: (tag) => showClientRefusalRef.current(tag),
        // CLEAN-04: keyboard Play/Pause drives the real host (optimistic flip +
        // pause/resume) through the same ref-stable toggle the Toolbar button uses.
        onTogglePlay: togglePlay,
        // CLEAN-04: the keyboard single-step drives the real host step command
        // through the transport control seam (no local grid mutation), by the SAME
        // ref-stable handler the Toolbar's Step button uses (D-07).
        onStep: doStep,
        // UNDO-04: keyboard Ctrl/Cmd+Z / Shift+Z / Ctrl+Y drive the SAME gated
        // gesture-channel handlers the Toolbar buttons use (availability-gated).
        onUndo: doUndo,
        onRedo: doRedo,
        // SAVE-03: keyboard Ctrl/Cmd+S = smart-Save, Ctrl/Cmd+Shift+S = Save-As.
        // Routed through the SAME gesture onKey path (already gated by isModalOpen
        // + the editable/BUTTON focus guard) so both no-op while a modal/guard is
        // open. Reads the LIVE smart-Save closure via controlsRef.
        onSave: (saveAs) => {
          if (simStoppedRef.current) return;
          void controlsRef.current?.onSave(saveAs);
        },
        // SAVE-05: keyboard Ctrl/Cmd+N = New, Ctrl/Cmd+O = Open. Both route through
        // the SAME dirty-guarded handlers the Toolbar New button + Load button use
        // (doNew / doOpen consult dirtyRef first), and sit behind the SAME
        // isModalOpen + editable-focus guards as Ctrl+S, so they no-op while any
        // guard is open. This makes the New button's advertised "Ctrl+N" tooltip and
        // the UI-SPEC Ctrl+O shortcut real.
        onNew: doNew,
        onOpen: doOpen,
        // IX-04/IX-07: surface the selected node handle (or null on clear) into
        // React so the discoverable DeleteControl mounts glued to the selection
        // ring and unmounts when the selection clears (Escape / keyframe / a
        // committed delete). The same edge-driven closure->React pattern as
        // onArmedChange; the overlay still renders the ring itself.
        onSelect: (node: number | null) => {
          setSelectedNode(node);
          // Phase 91, plan 91-09 (UI-SPEC 2.3): Help and the inspector share one slot, so a
          // selection closes Help and its inspector shows. A deselect leaves Help as it is.
          if (node !== null) setTopRightPanel(null);
          // CR-01, the 76-17 refuter round: a CHANGE of node selection is a new epoch,
          // which remounts the panel and closes the old one's sends (`selectionEpoch.ts`).
          setSelectionEpoch(liveEpoch.node(node));
          // 76-02: every selection change forgets a pending label-focus request. The
          // label echo re-asks through `onLabelPlaced` right after this call, so only the
          // label the user just placed is ever focused (76-UI-SPEC 2.1).
          setLabelFocusNode(null);
          // Capture the kind byte for the ConfigPanel heading from the same
          // authoritative NodeView map the delete anchor reads (CFG-01). null on
          // clear or an already-gone node keeps the panel unmounted.
          setSelectedNodeKind(
            node === null ? null : (handle.sceneState.nodes.get(node)?.kind ?? null),
          );
          // PANEL-02: seed the panel's I/O list from the SAME authoritative
          // NodeView map, synchronously at selection. Without this the list would
          // show the PREVIOUS machine's ports for up to one poll period (100ms)
          // after switching selection - a visible wrong-data flash. The poll's
          // signature ref is updated in lockstep so it does not immediately
          // re-set the identical value.
          const picked = node === null ? undefined : handle.sceneState.nodes.get(node);
          const ports = picked?.ports ?? NO_PORTS;
          portsSigRef.current = node === null ? '' : portsSignature(ports);
          setSelectedNodePorts(ports);
          setSelectedNodeAddBlocked(addBlockedByBelt(handle.sceneState, picked));
          // PANEL-04: seed the flow snapshot on the SAME edge, for the same
          // reason - a poll-only flow would show the PREVIOUS machine's counts
          // for up to 100ms on exactly the interaction the readout exists for.
          //
          // WR-06: through `beltsDockedTo`, the SAME derivation the poll below
          // uses (App.tsx `:1415`). This edge used to full-scan `scene.belts`
          // instead, so two code paths produced what must be the identical map -
          // feeding a gate whose wrong answer strands a belt. They agreed (the
          // reverse index is retraction-symmetric and can only ever be a
          // superset), but a future divergence would surface as a dock state that
          // flips between the first paint and the first poll: a remove control
          // offered for 100ms and then withdrawn, or the reverse. One derivation
          // cannot disagree with itself - and this also drops the last O(all
          // belts) scan off the selection path.
          //
          // WIRE-05: the wires go in WHOLE, with no reverse index behind them.
          // `dockedBelts` exists because that join scaled with total board size;
          // a maximal v8.0 board is ~8 wires x 2 endpoints, so a scan is smaller
          // than the index would be and cannot fall out of step with the packet.
          const flow = picked
            ? selectedNodePortFlow(
                picked,
                beltsDockedTo(handle.sceneState, picked.id),
                handle.sceneState.wires.values(),
                handle.sceneState,
              )
            : NO_FLOW;
          flowSigRef.current = picked ? flowSignature(flow) : '';
          setSelectedNodeFlow(flow);
          // CR-01: re-derive the port-edit mirror for the node being selected, on
          // the SAME edge and for the same reason as the two seeds above - the
          // poll would otherwise leave the panel showing the PREVIOUS node's
          // pending state for up to 100ms. This is also where a reselect gets its
          // answer: if the host folded our edit while the panel was unmounted,
          // `observePorts` sees it here and the controls come straight back.
          syncPortEdit(node, ports, handle.sceneState.tick);
        },
        // Phase 76 (plan 76-02, 76-UI-SPEC 2.1): a label the user has just PLACED is
        // selected (above, through `onSelect`) and then named here, so its panel focuses
        // the Text field once its config loads. Never fired for a plain click.
        onLabelPlaced: (node: number) => {
          setLabelFocusNode(node);
        },
        // BELT-01: the SECOND selection channel. It carries a belt handle where
        // `onSelect` carries a node handle, and the gesture layer drives both
        // from every selection site so the two states can never both be
        // non-null.
        //
        // It does PART of the seeding `onSelect` does above, and the split is by
        // subject rather than by convenience:
        //
        //  - NOT seeded, and not polled either: ports, per-port flow and the
        //    port-edit latch. A belt has none of the three, so `NO_PORTS` /
        //    `NO_FLOW` are passed at the mount and no poll touches them.
        //  - SEEDED here, on this same edge, for the reason `selectedNodePorts`
        //    is: the RUN. A poll-only run would show the PREVIOUS belt's run line
        //    and Mixed state for up to one poll period (100ms) on exactly the
        //    interaction the panel exists for. The signature ref moves in
        //    lockstep so the ~10Hz poll below does not immediately re-set the
        //    identical value.
        onSelectBelt: (belt: number | null) => {
          setSelectedBelt(belt);
          // The belt channel's twin of `onSelect`'s Help close (UI-SPEC 2.3).
          if (belt !== null) setTopRightPanel(null);
          // CR-01: the belt channel's epoch move, the twin of `onSelect`'s.
          setSelectionEpoch(liveEpoch.belt(belt));
          const run = belt === null ? NO_RUN : beltRun(handle.sceneState, belt);
          beltRunSigRef.current = belt === null ? '' : beltRunSignature(run);
          setSelectedBeltRun(run);
          // LINK-09: the belt's two port rows, seeded on this SAME edge and for the
          // same reason the run is - a poll-only derivation shows the PREVIOUS
          // belt's Disconnect for up to 100ms, and that control names a link.
          const view = belt === null ? undefined : handle.sceneState.belts.get(belt);
          const rows = view ? beltPortRows(view, handle.sceneState) : NO_BELT_ROWS;
          beltRowsSigRef.current = view ? flowSignature(rows.flow) : '';
          setSelectedBeltPorts(rows);
        },
        // IX-03: surface the armed tool into React so the Palette can render the
        // visibly-armed state. The same closure->React pattern as onSelect; the
        // gesture layer fires this on every arm/disarm/switch (exactly one armed).
        onArmedChange: setArmed,
        // REND-03: a delete of an element still carrying in-flight items defers
        // here (no command emitted yet). Open the guard dialog; its outcome
        // resolves into exactly one commitDelete (or nothing on Cancel). If a
        // guard is ALREADY open, ignore — never reset a guard mid-drain (WR-01:
        // a reset would resurrect the Drain/Delete buttons over a running loop).
        onDeleteWithItems: openGuard,
        // WR-01: the gesture layer ignores all global shortcuts while the
        // delete-guard modal owns the interaction (read live via the ref).
        // CR-01: the SAFE-03 quit guard is ALSO a modal — while it is open the
        // canvas shortcuts (Space/./r/Delete) must be suppressed too, so no
        // Rotate/Delete GridCommand fires behind the "unsaved changes" dialog.
        // SAVE-05: the per-action discard guard (dirty New/Open) is the THIRD modal
        // in the gate: its open-ref is OR'd in so canvas shortcuts stay dead behind
        // the New/Open dialog exactly as they do behind the delete + quit guards.
        isModalOpen: () =>
          guardRef.current !== null ||
          quitGuardOpenRef.current ||
          discardGuardOpenRef.current,
        // FAIL-01 (D-12): a stopped simulation, its OWN gate and not the modal one above, which
        // swallows every key: Escape and the camera must keep working on a stopped board.
        isSimStopped: () => simStoppedRef.current,
        // ONB-01/IX-07: the LOWEST-priority Escape action. The gesture Escape
        // stack calls this only when Escape was otherwise a no-op (nothing armed,
        // nothing selected); dismiss the first-run welcome card ONLY if it is
        // still showing (read live via the ref), so Escape never dismisses the
        // card ahead of disarming a tool or clearing a selection (IX-07 wins).
        onEscapeFallback: () => {
          if (!welcomeSeenRef.current) {
            dismissWelcome();
          }
        },
      });

      setReady(true);

      // NAV-01 Home key re-fits the view to the factory (same idempotent doFit as
      // boot). Window-level so it works with the canvas unfocused, but guarded so
      // it never steals Home from a focused chrome control (button/input/textarea/
      // select/contenteditable) — mirrors the IX-09 typing-focus spirit early.
      // Registered here where `handle` exists; removed in the mount-once cleanup like
      // pollRaf. The key is the shortcut table's `fit` entry (phase 91, D-11), the one the
      // Help panel's Fit to factory row and the Fit button's title cite.
      onHomeKey = (e: KeyboardEvent): void => {
        if (!matchesShortcut(e, SHORTCUTS.fit)) return;
        const el = document.activeElement as HTMLElement | null;
        // The focused Help list keeps Home too: it scrolls the list to its top (review WR-B-05).
        if (
          el &&
          (el.tagName === 'BUTTON' ||
            el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            el.isContentEditable ||
            el.hasAttribute(HELP_SCROLL_ATTR))
        ) {
          return;
        }
        e.preventDefault();
        doFit();
      };
      window.addEventListener('keydown', onHomeKey);

      // Poll the echoed scene to drive the chrome readouts (the toolbar tick, undo
      // availability and the zoom readout; the empty-board hint follows the packet
      // handler instead, phase 91 D-10). This
      // re-renders ONLY the DOM chrome, never the canvas. Throttled to ~10Hz so the
      // tiny chrome tree updates cheaply.
      let lastEmit = 0;
      const poll = (): void => {
        const now = performance.now();
        if (now - lastEmit >= 100) {
          lastEmit = now;
          const next = {
            tick: handle.sceneState.tick,
            canUndo: handle.sceneState.canUndo,
            canRedo: handle.sceneState.canRedo,
            // NAV-02: the live uniform zoom, so the CameraCluster readout tracks
            // the camera as the user zooms (same ~10Hz cadence as the toolbar tick).
            worldScale: handle.cam.worldScale(),
          };
          // WR-06: skip the state update when NO displayed field changed. Returning
          // the SAME reference makes React bail out of the re-render, so an idle /
          // paused grid QUIESCES instead of re-rendering App + the (un-memoized)
          // Toolbar/Palette/CameraCluster/header lockup 10x/sec forever - which
          // re-ran their per-render sprite/box-shadow builders on every tick. Every
          // field is an int or a discrete fixed-point zoom stop, so a per-field
          // compare is exact (no float drift on a still camera). Cadence + sim are
          // untouched: this is a pure render-churn guard.
          setSnap((prev) =>
            prev.tick === next.tick &&
            prev.canUndo === next.canUndo &&
            prev.canRedo === next.canRedo &&
            prev.worldScale === next.worldScale
              ? prev
              : next,
          );

          // PANEL-02: refresh the selected machine's I/O list off the SAME
          // authoritative NodeView map, on this SAME ~10Hz throttle - never at
          // packet rate (~62.5/s). Scoped to the one selected node (no scan) and
          // gated on a structural signature, so an idle panel does zero React
          // work; a rotate / AddPort / RemovePort that actually moves or
          // renumbers a port flips the signature and the list follows within a
          // frame or two (threat T-51-02).
          const sel = selectedNodeRef.current;
          const selNode = sel === null ? undefined : handle.sceneState.nodes.get(sel);
          const ports = selNode?.ports ?? NO_PORTS;
          const sig = sel === null ? '' : portsSignature(ports);
          if (sig !== portsSigRef.current) {
            portsSigRef.current = sig;
            setSelectedNodePorts(ports);
          }
          // 74.1-19: outside the signature guard on purpose (see the state's comment).
          setSelectedNodeAddBlocked(addBlockedByBelt(handle.sceneState, selNode));

          // PANEL-04: the live per-port flow, on the SAME ~10Hz throttle and the
          // SAME single-node scope. This one DOES change often (every item that
          // steps onto a docked belt), which is precisely why it is derived here
          // rather than on the packet path (~62.5/s) and why it carries its own
          // signature: the panel re-renders when a COUNT changes, never merely
          // because a packet arrived (threat T-51-04).
          //
          // WR-06: the join is INVERTED. It used to walk the scene's ENTIRE belt
          // map (and every dock on it) ten times a second for as long as anything
          // was selected - cost that scaled with total board size rather than with
          // the machine being inspected. `beltsDockedTo` reads the reverse index
          // maintained on the packet path, so this is O(belts docked to THIS node).
          //
          // WIRE-05: the wire half is a plain scan of `scene.wires` (see the
          // selection-edge seed above). One consequence, stated rather than
          // discovered: `flowSignature` folds `docked` into its churn guard, so
          // a wire landing on the selected node's Out re-renders the panel once.
          // That is correct and it is the point - the row it re-renders is the
          // one that used to read "not connected" under a live cable.
          const flow = selNode
            ? selectedNodePortFlow(
                selNode,
                beltsDockedTo(handle.sceneState, selNode.id),
                handle.sceneState.wires.values(),
                handle.sceneState,
              )
            : NO_FLOW;
          const fsig = selNode ? flowSignature(flow) : '';
          if (fsig !== flowSigRef.current) {
            flowSigRef.current = fsig;
            setSelectedNodeFlow(flow);
          }

          // BELT-01: the selected belt's RUN, re-walked on this SAME ~10Hz
          // throttle - never at packet rate (~62.5/s) and never per frame. A
          // neighbour drawn or deleted while the panel is open changes the run;
          // a neighbour's PACE changing flips the Mixed state; both must reach
          // the panel, and both are in the signature, so an idle board does zero
          // React work while a real change lands within a frame or two.
          //
          // The panel does NOT remount on a run change: `key` is the belt id and
          // the belt id did not change. The run line and the Mixed state update
          // in place, which is the honest reading (68-UI-SPEC 12, E4/partial).
          const selBelt = selectedBeltRef.current;
          const run = selBelt === null ? NO_RUN : beltRun(handle.sceneState, selBelt);
          const rsig = selBelt === null ? '' : beltRunSignature(run);
          if (rsig !== beltRunSigRef.current) {
            beltRunSigRef.current = rsig;
            setSelectedBeltRun(run);
          }

          // LINK-09: the belt's two port rows, on this SAME ~10Hz throttle and the
          // same single-belt scope. What actually moves here is the FLOW - a
          // neighbour joined or disconnected, a neighbour's item count - so the
          // guard is `flowSignature`, which hashes `docked`, the state and the whole
          // link identity including its target. The two rows themselves are fixed
          // by construction (D-06), so there is nothing for a second guard to
          // separate out. An idle belt panel does zero React work.
          const selBeltView = selBelt === null ? undefined : handle.sceneState.belts.get(selBelt);
          const beltRows = selBeltView
            ? beltPortRows(selBeltView, handle.sceneState)
            : NO_BELT_ROWS;
          const brsig = selBeltView ? flowSignature(beltRows.flow) : '';
          if (brsig !== beltRowsSigRef.current) {
            beltRowsSigRef.current = brsig;
            setSelectedBeltPorts(beltRows);
          }

          // CR-01: the latch RELEASE, driven from here rather than from a panel
          // effect - which is what makes it survive the panel being unmounted
          // while the edit is in flight. Unconditional (not behind the signature
          // guards above) because it also has to re-evaluate the WR-01 stall
          // threshold as the sim tick advances, which it does on ticks where the
          // topology has NOT changed. It bails out of the React update by
          // identity when nothing moved, so an idle panel still quiesces.
          syncPortEdit(sel, ports, handle.sceneState.tick);

          // Prune latches for nodes that have left the scene (a delete, or a load
          // that re-mints every render handle), so the map cannot accumulate for
          // the session. It holds only PENDING edits - 0 or 1 entries in practice -
          // so this walk is free, and deleting during iteration is well-defined.
          if (portEditLatchesRef.current.size > 0) {
            for (const handleId of portEditLatchesRef.current.keys()) {
              if (!handle.sceneState.nodes.has(handleId)) {
                portEditLatchesRef.current.delete(handleId);
                // WR-03: prune the per-node keyframe evidence with it, or the set
                // outlives the map it is keyed against and grows for the session.
                keyframeSinceLatchRef.current.delete(handleId);
              }
            }
            // 74.1-19: no edit left in flight, so no grace timer either.
            if (portEditLatchesRef.current.size === 0) portEditGrace.release();
          }
        }
        pollRaf = requestAnimationFrame(poll);
      };
      pollRaf = requestAnimationFrame(poll);
    })();

    return () => {
      disposed = true;
      if (pollRaf) cancelAnimationFrame(pollRaf);
      // IN-03: cancel a pending deferred boot-fit poll so a torn-down handle is
      // never fit across the StrictMode double-boot (leak-free, like pollRaf).
      if (bootFitRaf) cancelAnimationFrame(bootFitRaf);
      // NAV-01: drop the window-level Home listener so a torn-down handle is
      // never re-fit across the StrictMode double-boot (leak-free, like pollRaf).
      if (onHomeKey) window.removeEventListener('keydown', onHomeKey);
      // NAV-01: drop the shared fit closure so the Fit button never re-fits a
      // torn-down handle (the next mount republishes it against the fresh handle).
      doFitRef.current = null;
      stopDrain();
      // SHELL-07: cancel any pending status timers so a torn-down handle never
      // fires a late auto-clear / load-timeout (leak-free, like pollRaf).
      statusMachineRef.current?.dispose();
      // SAFE-01: cancel any pending stall timer so a torn-down handle never fires
      // a late 'disconnected' (leak-free across the StrictMode double-boot).
      watchdogRef.current?.dispose();
      hostWorkRef.current?.dispose();
      gesturesRef.current?.destroy();
      gesturesRef.current = null;
      // Detach the frame-time probe's ticker callback before the app is destroyed.
      frameProbeRef.current?.stop();
      frameProbeRef.current = null;
      // Leave the transport singleton alive across a StrictMode remount; the next
      // mount re-points its onPacket at the new scene. The canvas is torn down.
      handleRef.current?.stop();
      handleRef.current?.app.destroy(true);
      handleRef.current = null;
      // Drop the introspection hook so `scene()` never queries a destroyed
      // handle; the next mount reinstalls it against the fresh handle.
      window.__fabrico = undefined;
    };
  }, []); // mount once, never re-run

  // SERVE-05 (72-10): the OTHER Routes' committed paths, swept while a Route is
  // selected, so the Route card can name the owner of a taken address BEFORE Apply.
  //
  // WHY IT IS A SEPARATE EFFECT AND NOT PART OF THE ~10Hz POLL. The poll reads the
  // render packet, and a Route's `path` is not on it: it is a CONFIG field, reachable
  // only over the `machine_config` host query. Folding an async per-node query into
  // the rAF poll would put N awaits on the frame path for a value that changes on a
  // human gesture.
  //
  // WHY IT IS SCOPED TO A SELECTED ROUTE. The list has exactly one consumer, the
  // Route card's duplicate gate, and that card exists only while a Route is
  // selected. Sweeping the board the rest of the time would spend host queries on a
  // value nothing reads.
  //
  // THE SWEEP IS A COURTESY, NOT A LOCK. `fabrico-command`'s `Configure` arm refuses
  // a duplicate independently and plan 72-07 proved it does with no frontend in the
  // loop (D-13). A neighbour that fails to answer is therefore dropped rather than
  // treated as a claim on an address: refusing to offer Apply because a query failed
  // would block a legal edit on a transport hiccup, and the host would have caught a
  // real collision anyway.
  useEffect(() => {
    if (selectedNode === null || selectedNodeKind !== machine_kind.ENDPOINT) {
      // Bail out by IDENTITY when it is already empty, so deselecting a non-Route
      // machine does no React work (the NO_PORTS/NO_FLOW discipline).
      setOtherRoutes((prev) => (prev.length === 0 ? prev : NO_ROUTES));
      return;
    }
    const invoke = transportKind() === 'dev' ? devWsInvoke : tauriInvoke;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sweep = async (): Promise<void> => {
      const nodes = handleRef.current?.sceneState.nodes;
      if (nodes !== undefined) {
        const targets = [...nodes.values()].filter(
          (n) => n.kind === machine_kind.ENDPOINT && n.id !== selectedNode,
        );
        const next: RouteNeighbour[] = [];
        for (const n of targets) {
          try {
            const cfg = await loadConfig(n.id, invoke);
            if (cfg !== null && cfg.kind === 'Endpoint') {
              next.push({ node: n.id, path: cfg.path, cell_x: n.cell_x, cell_y: n.cell_y });
            }
          } catch {
            // See the header: a neighbour that will not answer is not a claim on an
            // address. Dropped, never counted as a collision.
          }
        }
        if (!disposed) {
          const sig = routeNeighbourSignature(next);
          setOtherRoutes((prev) => (routeNeighbourSignature(prev) === sig ? prev : next));
        }
      }
      if (!disposed) {
        timer = setTimeout(() => {
          void sweep();
        }, ROUTE_SWEEP_MS);
      }
    };
    void sweep();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [selectedNode, selectedNodeKind]);

  // SAFE-02: honor prefers-reduced-motion by freezing the animated motion to one
  // representative frame while keeping every machine's kind + state legible. Mirrors
  // the DPR matchMedia precedent (useDevicePixelRatio above): read the ONE media
  // query, and on mount + every change drive BOTH freeze gates from a single pure
  // decision (reducedMotionPins) - pinClock (gate 1: belts/items/fault-blink) AND
  // pinOverlay (gate 2: the overlay alert-ring wall-clock pulse pinClock does NOT
  // cover, RESEARCH Pitfall 2). This is the ONLY place reduced motion is read; no
  // reduced-motion conditional is threaded through synth/generators/layers (the
  // "keep the pipeline pure" principle). Both pins write ONLY the render clock -
  // never scene.tick / a command / the log (threat T-34-DET). Gated on `ready` so
  // the effect (re-)applies once the render handle exists, and restores (null /
  // false) when the query stops matching or on unmount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (matches: boolean): void => {
      const handle = handleRef.current;
      if (!handle) return;
      const pins = reducedMotionPins(matches);
      handle.pinClock(pins.frame); // gate 1
      handle.pinOverlay(pins.overlayFrozen); // gate 2
    };
    const onChange = (): void => apply(mql.matches);
    apply(mql.matches); // sync the initial preference now the handle is ready
    mql.addEventListener?.('change', onChange);
    return () => {
      mql.removeEventListener?.('change', onChange);
      // Restore live motion for a torn-down/re-mounting handle so a stale freeze
      // never persists across the StrictMode double-boot.
      const handle = handleRef.current;
      handle?.pinClock(null);
      handle?.pinOverlay(false);
    };
  }, [ready]); // (re)apply once the render handle is live

  // SAFE-03 (Tauri path): intercept the OS window close. The window lifecycle stays
  // FRONTEND-driven — getCurrentWindow().onCloseRequested fires before the window
  // dies; when the board is dirty we preventDefault() and open the QuitGuardDialog,
  // and "Quit anyway" resolves to getCurrentWindow().destroy() (the narrow
  // core:window:allow-destroy capability). A clean/just-saved board never
  // preventDefaults, so it quits with no nag. `@tauri-apps/api/window` is imported
  // DYNAMICALLY so a plain browser / node test never evaluates the Tauri runtime
  // (mirrors tauriChannel.ts). dirtyRef is read live inside the async callback so
  // the decision always reflects the CURRENT edit state.
  useEffect(() => {
    if (!detectEnv().hasTauri) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (disposed) return;
      void getCurrentWindow()
        .onCloseRequested((event) => {
          if (hasUnsavedWork()) {
            event.preventDefault();
            setGuardWork(unsavedWork());
            setQuitGuardOpen(true);
          }
        })
        .then((fn) => {
          // The listener may resolve after unmount (StrictMode double-boot) — if so,
          // detach immediately so no stale handler survives the remount.
          if (disposed) fn();
          else unlisten = fn;
        });
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []); // register once (dirty is read via the live ref, not a dep)

  // SAFE-03 (web fallback): outside Tauri there is no onCloseRequested, so gate the
  // native `beforeunload` prompt on dirty. Setting a non-empty returnValue triggers
  // the browser's generic "Leave site?" dialog (the copy is not app-customisable —
  // the real shipped experience is the Tauri QuitGuardDialog above). A clean board
  // sets nothing, so the page unloads with no prompt. Registered only when NOT in
  // Tauri so the two paths never double-guard.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (detectEnv().hasTauri) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (hasUnsavedWork()) {
        e.preventDefault();
        // Legacy browsers gate on a non-empty returnValue string.
        e.returnValue = 'You have unsaved changes.';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []); // register once (dirty is read via the live ref, not a dep)

  // IX-04: glue the floating DeleteControl to the selected node's ring TOP-LEFT
  // corner, projected to screen through the READ-ONLY window.__fabrico.camera()
  // (world*scale + pan), re-projected EVERY FRAME while a node is selected so it
  // stays stuck as the camera pans/zooms/resizes. A per-frame rAF (NOT the ~10Hz
  // chrome poll, which would visibly trail a fast pan — RESEARCH Pitfall 3); the
  // loop is scoped to [selectedNode] so it runs ONLY while selected and is torn
  // down the instant the selection clears. Positioning is a cheap DOM transform
  // write on the anchor wrapper — no scene write, no new window.__fabrico setter
  // (T-30-03: camera() is consumed read-only). useLayoutEffect + an immediate
  // project() paints the first frame in the right place (no origin flash).
  useLayoutEffect(() => {
    // Gate on the SAME condition as the render below (selected AND not armed) so
    // the rAF runs exactly while the control is mounted: a synchronous project()
    // paints the first frame in place (no origin flash) whether the control
    // appears via a fresh selection or via a tool disarm over a standing one.
    if (selectedNode === null || armed !== null) return;
    let raf = 0;
    const project = (): void => {
      const el = deleteAnchorRef.current;
      // Read the fresh read-only camera snapshot and the selected node's live
      // cell. handle.sceneState.nodes is the authoritative NodeView map (cheap,
      // no snapshot allocation). The placement itself is `placeDeleteAnchor`, called
      // with or without a node: a keyframe that leaves nothing on the handle must
      // still reach its hide (76-15 refuter round).
      const cam = window.__fabrico?.camera();
      const node = handleRef.current?.sceneState.nodes.get(selectedNode);
      if (el && cam) {
        // UI-01: the rings as PLOTTED, so the control steps off whatever ring is on screen.
        // A failed plot read places the control where it always went, never stops the loop.
        let rings: Array<{ x: number; y: number }> = [];
        try {
          rings = handleRef.current?.overlay.alertRingCentres() ?? [];
        } catch {
          rings = [];
        }
        placeDeleteAnchor(el, cam, node, selectedNodeRef.current === selectedNode, rings);
      }
      raf = requestAnimationFrame(project);
    };
    project(); // paint the first frame synchronously (pre-paint, no flash)
    return () => cancelAnimationFrame(raf);
  }, [selectedNode, armed]);

  // ---- delete-guard outcomes (REND-03) -----------------------------------
  // `deleteAnyway` and `drainFirst` come from `useDeleteGuard` above; both route
  // through the single gestures.commitDelete emit path.

  // The real control handlers (CLEAN-04) — rebuilt each render so they close over
  // the current transport (populated by the async boot effect). Save/Load open the
  // native dialog under Tauri, else fall back to a dev-only prompt; every handler
  // routes to a real host command via the transport control seam. No stub remains.
  const controls = makeControlHandlers({
    transport: transportRef.current,
    isPlaying: () => playingRef.current,
    setPlaying: (next) => setPlayingNow(next),
    // Review WR-B-04: read again after a native dialog resolves (the fatal can come meanwhile).
    isStopped: () => simStoppedRef.current,
    // SAVE-03 smart-Save: read the current known path so a plain Save re-saves to
    // it with no dialog; record a Save-As pick so the NEXT plain Save re-saves.
    // The path is used ONLY to route the dispatch, never shown (T-32-06-01).
    currentPath: () => currentFilePathRef.current,
    onPathChosen: (path) => {
      currentFilePathRef.current = path;
    },
    // D-02 (phase 90): a dispatched Open is held as pending; the save target moves on its
    // swap keyframe (above), never here. A second Open replaces the entry.
    onLoadDispatched: (path) => {
      pendingLoadRef.current = { path, floorAtDispatch: handleRef.current?.sceneState.swapFloor ?? 0 };
    },
    // SHELL-07: honest Save/Load feedback. Save settles at 'saveRequested'
    // (dispatch-confirmed); Load stays 'loading' until its own swap keyframe
    // (`isLoadSwap`) resolves it above, a refusal, or the cut-off. onStatus is
    // stable ([] deps) so this is safe to recreate each render.
    //
    // ONB-01: a user Load emits 'loading' ONLY once a path is chosen and the load
    // command is dispatched (a cancelled dialog emits 'idle'). The "Demo scene" badge
    // clears on that Load's own swap keyframe (`isLoadSwap`, the packet path), never on
    // this dispatch and never on an Undo's or Redo's keyframe (review WR-B-06).
    onStatus: (kind: StatusKind) => {
      // Review WR-B-04: a native dialog can stay open across the fatal. Once the simulation
      // stopped, a Save or Open answered after it changes nothing on the page: the badge, the
      // scene badge and the queued-edit hold stay as the stop left them (the handlers also send
      // nothing then, `isStopped`).
      if (simStoppedRef.current) return;
      if (kind === 'loading') {
        // Plan 74.1-35: a dispatched Load swaps the board, and the swap discards the edits
        // queued on this one; the hold ends on the swap's own keyframe, never here. A
        // refused Load emits no keyframe, so its queued edits keep the hold until Play.
        requestSwapDiscard();
        // DEMO-07 (plan 85-06): a user's .fab Open does NOT arm the camera fit; only the
        // demo and the examples do (`doLoadScene`). Measured: the done-walk spec
        // (77-one-board-all-five leg 4) saves, wipes and reopens a board and expects every
        // word of its label back at the same place on screen, which a re-fit on Open moves.
        // The camera a user had on their own board stays theirs across Save and Open.
        // Review WR-B-06: the scene badge is NOT cleared here either; it goes on the Load's own
        // swap keyframe (the packet path), so a refused file leaves `Demo scene` on the demo.
        // SAFE-03 / D-02 (phase 90): the unsaved flag is NOT cleared here. A dispatch is not
        // a swap: the host may refuse the file, and the board on screen would then be
        // marked clean with its edits unsaved. The flag clears on the Load's own swap
        // keyframe, with the save target (the packet path, `pendingLoadRef`), so the
        // Unsaved badge stays up while `Loading…` shows and goes on `Loaded`.
      }
      if (kind === 'saveRequested') {
        // Review WR-B-02: a running board drains, writes in silence and plays on (D-08).
        if (playingRef.current) hostWorkRef.current?.begin('save');
        // SAFE-03: a dispatch-confirmed Save is the honest "saved" point → clean, unless the
        // host reports the write failed (WR-A-03, `onSaveFailed`), which restores this.
        dirtyBeforeSaveRef.current = dirtyRef.current;
        setDirty(nextDirty(dirtyRef.current, 'save'));
      }
      applyStatus(kind);
    },
  });
  // SAVE-03: expose the live handlers to the once-created gesture controller so
  // keyboard Ctrl+S / Ctrl+Shift+S route through the SAME smart-Save closure the
  // Toolbar uses (which reads the live transport + current-path ref).
  controlsRef.current = controls;
  // FAIL-01 (D-12): the toolbar's Play / Pause and Save, which reach the host through `controls`
  // rather than through a ref-stable handler above, take the same stopped gate.
  const onPlayPause = (): void => {
    if (simStoppedRef.current) return;
    controls.onPlayPause();
  };
  const onSave = (saveAs?: boolean): void => {
    if (simStoppedRef.current) return;
    void controls.onSave(saveAs);
  };

  // CHROME-03 / CONTEXT Area 3: the ONE runtime token source. Computed
  // SYNCHRONOUSLY during render (via useMemo, not a post-paint useEffect) so the
  // first paint already carries the --fab-* vars - FOUC-safe (RESEARCH Pitfall 3).
  // The tokens resolve from the ONE locked skin (SKIN-02 / D-22), so the memo depends on
  // the DPR alone and never re-runs on the ~10Hz chrome-readout poll re-render.
  //
  // SUPERSEDED CLAUSE, QUOTED (plan 59-05). This said "the bezel PNG is re-baked only on
  // a DPR change" and "`bezelUrl` is baked here (DOM canvas) and threaded into the pure
  // `skinToCssVars`". There is no bake and no DOM canvas on this path any more: the third
  // argument and `chrome/bezelUrl.ts` are deleted. The memo is now a pure string build,
  // and its DPR dependency survives for one reason only - the ring's hairline band snap.
  const dpr = useDevicePixelRatio();
  const tokens = useMemo(() => skinToCssVars(LOCKED_SKIN, dpr), [dpr]);

  return (
    <>
      {/* FOUC-safe: React emits <style> before siblings in the same commit, so the
          --fab-* vars exist before the chrome paints. Must stay the FIRST child,
          BEFORE the var()-consuming CHROME_CSS block below. */}
      <style id="fab-tokens">{tokens}</style>
      <style>{CHROME_CSS}</style>

      {/* Canvas host — owned by Pixi, never re-rendered by React (Pattern 1). */}
      <div ref={hostRef} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />

      {/* SAFE-01: the stale-dim overlay. While the render stream is disconnected
          the last frame is FROZEN, so it must be visibly de-emphasised - a grey,
          darkened wash - so a stale board cannot pass as live. Display-only: it
          reads NO packet and writes NO scene/command/log (T-34-DET); it sits above
          the canvas (zIndex 1) but below the chrome, and never blocks a gesture
          (pointerEvents none). The honest word+glyph+tint readout in the Toolbar
          is the primary announced signal; this is the corroborating canvas cue. */}
      {/* FAIL-01 (UI-SPEC 1.5): the same dim, unchanged, also covers a stopped simulation. */}
      {(status.kind === 'disconnected' || status.kind === 'simStopped') && (
        <div
          data-fab-disconnected-dim
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            pointerEvents: 'none',
            // Desaturate + darken the frozen frame beneath. The substrate-tinted
            // wash matches the dialog-scrim token discipline (no hand-authored hex).
            backdropFilter: 'grayscale(1) brightness(0.55)',
            WebkitBackdropFilter: 'grayscale(1) brightness(0.55)',
            background: 'color-mix(in srgb, var(--fab-substrate) 45%, transparent)',
          }}
        />
      )}

      {/* The empty-board hint, on a board holding NO node AND NO belt. Plan 74.1-31
          (third re-walk EMPTY-FLOOR): this was gated on `machineCount === 0` alone, so
          "EMPTY FACTORY FLOOR" stayed in the middle of a board full of belts. Plan 77-04:
          it reads `nodeCount`, every node, labels included, because a board holding only
          a label is not an empty floor. Phase 91 (D-10): the gate is `boardEmpty`, set by the
          packet handler on the edge, not the 10 Hz poll. */}
      {ready && boardEmpty && <EmptyState />}

      {/* ONB-01: the first-run welcome card — a SEPARATE first-run-gated surface,
          INDEPENDENT of the EmptyState empty-board gate above, so it shows
          over the non-empty demo boot and never nags returning users (localStorage
          fab.onboarding.seen.v1). "Show the gestures" opens the Help panel and
          dismisses in one step. */}
      {ready && !welcomeSeen && (
        <WelcomeCard
          onStartBuilding={dismissWelcome}
          onShowGestures={() => {
            // Opens Help through the one top-right value.
            setTopRightPanel('help');
            dismissWelcome();
          }}
        />
      )}

      {ready && (
        <>
          <Palette
            disabled={simFatalReason !== null}
            onBeginPlacement={(kind) => gesturesRef.current?.beginPlacement(kind)}
            onArmBeltDraw={() => gesturesRef.current?.armBeltDraw()}
            onArmWireDraw={() => gesturesRef.current?.armWireDraw()}
            onBeginRouterPreset={(medium) => gesturesRef.current?.beginRouterPreset(medium)}
            armed={armed}
          />
          <Toolbar
            tick={snap.tick}
            playing={playing}
            simStopped={simFatalReason !== null}
            onPlayPause={onPlayPause}
            onStep={doStep}
            onNew={doNew}
            onSave={onSave}
            onLoad={doOpen}
            examplesOpen={examplesOpen}
            onToggleExamples={onToggleExamples}
            onCloseExamples={closeExamples}
            onLoadScene={onSelectExample}
            examplesTriggerRef={examplesTriggerRef}
            dirty={dirty}
            onUndo={doUndo}
            onRedo={doRedo}
            canUndo={snap.canUndo}
            canRedo={snap.canRedo}
            undoHeld={undoHeld}
            statusStripPlacement={statusStripPlacement}
            status={STATUS_COPY[status.kind]}
            statusKind={status.kind}
            legendOpen={legendOpen}
            onToggleLegend={() => setLegendOpen((v) => !v)}
            labelsToggled={labelsToggled}
            onToggleLabels={() => setLabelsToggled((v) => !v)}
            legendPanelId={LEGEND_PANEL_ID}
            loadedScene={loadedScene}
            helpOpen={helpOpen}
            onToggleHelp={onToggleHelp}
            helpPanelId={HELP_PANEL_ID}
          />
          {/* ERR-01: the host-refusal message surface. The outer live region is ALWAYS
              mounted from here on and renders nothing when idle - a region that mounts
              together with its content is unreliably announced.

              THE MOUNT POINT IS BINDING, NOT A PREFERENCE. `chrome-bezel.spec.ts` reads
              a BARE `document.querySelector('.fab-panel')` and takes the first DOM-order
              match. That query is correct today only because this element's inner
              `.fab-panel` node is unmounted at rest AND this mount sits AFTER the
              Toolbar header above. Hoisting it, or driving a refusal before that query,
              breaks that spec silently rather than loudly.

              There is deliberately NO branch here for a paused board (D-12): a gesture
              on a paused board is QUEUED, not refused, so no verdict ever arrives and
              the region stays empty. A "waiting for the host" line would be the frontend
              fabricating a cause, which this repo has reverted once already. */}
          <RefusalMessage
            message={refusalMessage}
            avoid={refusalAvoid}
            dodgeKey={`${configDockKey ?? ''}|${beltDockKey ?? ''}|${helpOpen ? 'help' : ''}|${inspectorHidden ? 'hidden' : ''}`}
          />
          {/* UNDO-09: the card that says why a file will not open. Mounted from its own
              slot, at the viewport centre rather than this band's anchor, so a gesture
              refusal and a load refusal cannot overlap. Conditional: at rest it adds +0
              to every page-wide role locator, which is what protects the eight shipped
              alert-count-zero assertions. */}
          {/* FAIL-01 (D-12, UI-SPEC A2): while the simulation is stopped its card takes this
              centre slot INSTEAD of the load refusal card. No Load can be serviced on a dead
              sim, and one centre card at a time cannot overlap. */}
          {simFatalReason !== null ? (
            <SimStoppedCard reason={simFatalReason} lastTick={() => handleRef.current?.sceneState.tick ?? 0} />
          ) : (
            <LoadRefusedCard reason={loadRefusedReason} onDismiss={dismissLoadRefusal} />
          )}
          {/* READ-01: the collapsible Legend key, mounted ONLY while open (closed
              by default - the Toolbar Legend button toggles legendOpen) AND ONLY
              once the band has actually been measured. `legendBand === null` is
              the fail-CLOSED path (see the useLayoutEffect above): rather than
              paint the strip at an unmeasured `{0, 0}` - which is the old
              bottom-left dock, i.e. the Belt tool unclickable again - it does not
              open at all and says why on the console. */}
          {legendOpen && legendBand !== null && (
            <Legend
              paletteRightPx={legendBand.paletteRightPx}
              cornerInsetPx={legendBand.cornerInsetPx}
            />
          )}
          {/* ONB-03: the collapsible Help panel, mounted ONLY while open (closed
              by default — the Toolbar "?" button toggles helpOpen), mirroring the
              Legend mount exactly. */}
          {helpOpen && <HelpPanel />}
          {/* Phase 76 (plan 76-02, D-06): a label's WORDS, a DOM overlay pinned to each
              label every frame. ALWAYS mounted (a note's words are not an alt-mode
              reveal), z-index 1 under every panel. It reads the same read-only camera
              snapshot; no setter, no scene write. Name tags sit over label words and
              under every panel: they are z-index 1 too and mount just after this. */}
          <LabelWords handleRef={handleRef} />
          {/* READ-01: the Alt-hold / toggle machine-name chip overlay, mounted
              ONLY while labelsVisible so its per-frame rAF anchor exists exactly
              while names are shown (blur-safe via altHeld above). The chips read
              the SAME read-only camera the DeleteControl anchor uses: no setter,
              no scene write. CHROME-08 (phase 91, D-07): z-index 1, mounted AFTER
              LabelWords, so a tag paints over label words and under every chrome
              surface at 2 (Toolbar, Palette, Legend, Help, inspector, camera cluster). */}
          {labelsVisible && <MachineLabels handleRef={handleRef} />}
          {/* NAV-01/02: the interactive camera cluster, live zoom readout + Fit. It is
              the one surface in the bottom-right corner (plan 91-03 removed the passive
              tick / fps / machine readout that sat under it, CHROME-01), pointer-events:auto
              so its buttons are clickable. */}
          <CameraCluster
            zoomPct={snap.worldScale * 100}
            onFit={onFit}
            onResetZoom={onResetZoom}
          />
          <DeleteGuardDialog
            open={guard !== null}
            itemCount={guard?.count ?? 0}
            kind={guard?.kind ?? 'machine'}
            draining={guard?.draining ?? false}
            onCancel={cancelGuard}
            onDrainFirst={drainFirst}
            onDeleteAnyway={deleteAnyway}
          />
          {/* SAFE-03: the warn-on-quit alertdialog (same .fab-dialog discipline as
              the DeleteGuardDialog). Opened ONLY when the board is dirty and the OS
              close is intercepted; Cancel keeps the window, "Quit anyway" always
              destroys it (CANNOT-STRAND, T-34-QUIT). */}
          <QuitGuardDialog
            open={quitGuardOpen}
            action="quit"
            work={guardWork}
            onCancel={cancelQuitGuard}
            onQuitAnyway={quitAnyway}
          />
          {/* SAVE-05: the per-action discard guard, the SAME generalized
              QuitGuardDialog component, driven by `discardAction` ('new'|'open') as
              a 3-choice (Cancel / Discard / Save) dialog. Opened ONLY when a New or
              Open is invoked on a dirty board; Cancel keeps the board, Discard
              proceeds losing edits, Save saves-then-proceeds. */}
          <QuitGuardDialog
            open={discardGuardOpen}
            action={discardAction}
            work={guardWork}
            onCancel={cancelDiscardGuard}
            onDiscard={discardAnyway}
            onSave={saveThenProceed}
          />
          {/* IX-04: the discoverable delete control, mounted ONLY while a machine
              is selected AND no tool is armed (an armed tool owns the interaction;
              the control would collide with the follow-ghost). The anchor wrapper
              is positioned imperatively each frame by the rAF above (transform),
              so DeleteControl stays purely presentational (told left/top = 0 within
              its glued anchor). onDelete routes to the SHARED guarded requestDelete
              (30-04): in-flight items open the DeleteGuardDialog, otherwise one
              commitDelete — the exact path the keyboard Delete uses (T-30-01, no
              unguarded delete, no duplicated React-side logic). CR-01 (plan 76-15):
              the click sends only while the live selection ref still equals the
              handle this closure rendered; on the in-between frame a keyframe left
              (ref nulled, React not yet committed) it sends nothing.
              UNDER THE CHROME (phase 92 review WR-B-04): z-index 1, the level of the
              label words and the name tags, below every panel at 2. At 2, and later in
              the markup than the Palette, the Toolbar, the Legend, Help and the camera
              cluster, it painted over each of them and took the click (the trash button
              over the open Legend's `Source` row at 1024x768). Later in the markup than
              the label words and the tags, it still paints over those. Graded by
              `delete-control-under-chrome.spec.ts`. */}
          {selectedNode !== null && armed === null && (
            <div
              ref={deleteAnchorRef}
              style={{ position: 'absolute', top: 0, left: 0, zIndex: 1, willChange: 'transform' }}
            >
              <DeleteControl
                left={0}
                top={0}
                onDelete={() => {
                  // T-91-28 (review WR-B-02): while Help hides a dirty inspector, the trash button
                  // only brings the inspector back, like every other press that would drop it.
                  if (inspectorHidden && inspectorDirty) {
                    restoreHiddenInspector();
                    return;
                  }
                  if (selectedNodeRef.current === selectedNode) gesturesRef.current?.requestDelete(selectedNode);
                }}
              />
            </div>
          )}
          {/* CFG-01/CFG-03: the selection-reactive machine-config panel. Mounts on
              the SAME selectedNode gate as the DeleteControl (deselect unmounts it
              ; no panel is the empty state). `key={selectionEpoch}` forces a fresh
              instance per selection, so switching machines mid-edit cleanly
              discards the uncommitted buffer (the dirty-loss backstop) and re-pulls
              machine_config for the new node. Keyed on the selection epoch, not the
              handle (the 76-17 refuter round): after a keyframe remints handles, a
              reselect of the node now on the old number is a new panel too. It commits
              a Configure through the transport sendInput seam (the same path
              Undo/Redo/Delete use). */}
          {selectedNode !== null && selectedNodeKind !== null && (
            <ConfigPanel
              key={selectionEpoch}
              node={selectedNode}
              kind={selectedNodeKind}
              // PANEL-02: the scene-access seam. The panel has no SceneState of
              // its own; App polls the selected node's ports and hands them down.
              ports={selectedNodePorts}
              // 74.1-19: the host would refuse one more output for a belt.
              addBlockedByBelt={selectedNodeAddBlocked}
              // BELT-01: a MACHINE has no belt run. `commitConfig`'s run-pace
              // branch is reachable only for `config.kind === 'Belt'`, which a
              // machine's config can never be, so the empty singleton is the
              // honest value rather than a placeholder.
              run={NO_RUN}
              // PANEL-04: the live per-port {docked, carrying, backedUp} snapshot, derived in
              // the same poll block from the scene's belts.
              flow={selectedNodeFlow}
              // SERVE-05: the OTHER Routes' COMMITTED paths and cells, swept by the
              // effect above while a Route is selected. Empty for every other kind,
              // which is the truth rather than a placeholder: no other machine has
              // an address that can be taken.
              otherRoutes={otherRoutes}
              // CR-01: copy-only. A paused/draining host HOLDS a queued port
              // edit (`SimLoop::step`), so the panel's pending status says
              // "applies when you resume" rather than "waiting for the host".
              // This never gates a send - the optimistic value is safe here.
              playing={playing}
              // CR-01: the port-edit guard + its render mirror both live in App
              // now, keyed by node, so they OUTLIVE this component. `key={node}`
              // remounts the panel on every selection change; a latch that
              // remounted with it discarded an edit that was still in the host's
              // unbounded gesture channel, and the fresh instance re-offered the
              // stale index. The panel keeps the encoding (it owns the AddPort
              // shape); App keeps the safety property.
              sendPortEdit={nodePanelSendPortEdit}
              portEditPending={portEditMirror.pending}
              // WR-01: the edit has gone unfolded for PORT_EDIT_STALL_TICKS of
              // SIMULATED time, so the panel offers [Try again] instead of a
              // promise it cannot keep. Zero while paused, by construction.
              portEditStalled={portEditMirror.stalled}
              // 74.1-19 (re-walk J10): the status line waits out the grace.
              portEditPendingVisible={portEditMirror.visible}
              onPortEditReset={resetPortEdit}
              sendInput={nodePanelSendInput}
              // Plan 88-07 (D-09): the label's box as the scene shows it, read at Apply, so its
              // Configure claims the cells a grow takes until the host answers it.
              labelBoxOf={labelBoxOf}
              // On the dev WS transport the config-READ bridges are serviced by the
              // request/reply query verb (40-05); under Tauri the panel keeps its
              // default tauriInvoke. The COMMIT rides sendInput either way.
              invoke={transportKind() === 'dev' ? devWsInvoke : undefined}
              // 76-02: a label just placed opens with its Text field focused, once.
              focusTextOnLoad={labelFocusNode === selectedNode}
              onTextFocused={clearLabelFocus}
              // 76-03: the label's pending size, previewed on the board.
              onLabelResize={onLabelResize}
              // Phase 91 (UI-SPEC 2.3): hidden while Help holds the shared slot.
              hidden={inspectorHidden}
              onDirtyChange={setInspectorDirty}
            />
          )}
          {/* BELT-01: the SAME ConfigPanel on the belt channel. `key={selectionEpoch}`
              gives it the identical per-selection remount discipline every other
              kind gets, so switching belts mid-edit discards the uncommitted
              buffer and re-pulls `machine_config` for the new belt.

              `BeltView.id` is a dense render handle from the SAME `handles` map
              as `NodeView.id` (`render_packet.rs`), so `machine_config(beltId)`
              answers and the run-pace frame's handles resolve.

              `ports` / `flow` are the belt's TWO SYNTHESISED ROWS (LINK-09):
              `Input - Item` from the Tail at index 0 and `Output - Item` from the
              Head at index 1, built by `beltPortRows` off this belt's own
              `BeltView` because D-05 keeps `ports` off the wire. They replace the
              empty singletons this passed until 74-07, whose reason - a belt
              declares no `Port` records, so the section would read
              "Inputs / None / Outputs / None" - both halves of this phase made
              false. Seeded on the selection edge and re-derived on the ~10Hz poll,
              the `selectedNodePorts` discipline.

              `run` is the belts this Apply writes to: the contiguous chain the
              clicked belt belongs to, in flow order, from `beltRun.ts` (68-05),
              each entry carrying its own live pace off the render packet. It is
              seeded synchronously in `onSelectBelt` and re-walked on the ~10Hz
              poll. It is passed explicitly rather than defaulted inside the
              panel precisely so that narrowing to the clicked belt cannot happen
              silently - see `commitConfig`'s Belt branch, and the three-belt
              cases in `ConfigPanel.test.tsx` and `e2e/belt-pace.spec.ts` that
              are the only things in the tree that can catch that narrowing.

              `sendPortEdit` refuses everything: a belt has no port edits to make,
              the panel's Outputs group is not rendered for it, and returning
              false is the honest answer rather than arming a latch on a node kind
              that can never fold one. */}
          {selectedBelt !== null && (
            <ConfigPanel
              key={selectionEpoch}
              node={selectedBelt}
              kind={machine_kind.BELT}
              ports={selectedBeltPorts.ports}
              // A belt grows no outputs, so the add note never applies.
              addBlockedByBelt={false}
              flow={selectedBeltPorts.flow}
              run={selectedBeltRun}
              // A belt has no address and cannot collide with a Route's. The empty
              // singleton is the honest value, passed deliberately.
              otherRoutes={NO_ROUTES}
              playing={playing}
              sendPortEdit={NO_PORT_EDIT}
              portEditPending={false}
              portEditStalled={false}
              portEditPendingVisible={false}
              onPortEditReset={resetPortEdit}
              sendInput={beltPanelSendInput}
              invoke={transportKind() === 'dev' ? devWsInvoke : undefined}
              // BELT-02 (phase 89, D-07, T-89-15): the panel's `Delete belt` button, through the
              // SAME guarded path as the Delete key. It sends only while the live belt selection
              // still equals the belt this closure rendered (the machine control's own check): on
              // the in-between frame a keyframe left, the ref is nulled and it sends nothing.
              onDeleteBelt={() => {
                if (selectedBeltRef.current === selectedBelt) gesturesRef.current?.requestBeltDelete(selectedBelt);
              }}
              hidden={inspectorHidden}
              onDirtyChange={setInspectorDirty}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * Centered empty-state copy (UI-SPEC copywriting). Never blocks canvas gestures.
 * CHROME-03: theme-free - every style reads a `var(--fab-*)` token so it re-themes
 * with the active skin and imports NOTHING from theme.ts. Phase 47 vector text:
 * Sono title tier for the heading (.fab-title), Martian Mono base for the body,
 * both smooth and DPR-independent.
 */
function EmptyState() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--fab-space-md)',
        pointerEvents: 'none',
        userSelect: 'none',
        fontFamily: 'var(--fab-font)',
        color: 'var(--fab-ink)',
        textAlign: 'center',
      }}
    >
      {/* IN-03: a real <h2> (not a plain <div>) so screen-reader heading nav
          reaches the empty-state title - it sits under the Toolbar wordmark's h1,
          keeping the h1->h2 document order. It joins the Phase 47 Sono title tier
          via .fab-title (D-08). */}
      <h2 className="fab-title" style={{ margin: 0, fontSize: 'var(--fab-font-size-hero)', lineHeight: 1.2 }}>
        {EMPTY_FLOOR_HEADING}
      </h2>
      <div style={{ fontSize: 'var(--fab-font-size-base)', maxWidth: 640, lineHeight: 1.4 }}>
        {EMPTY_FLOOR_BODY}
      </div>
    </div>
  );
}

