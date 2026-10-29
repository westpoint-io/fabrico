// The mutable scene buffer the Pixi layers (07-07) read each frame.
//
// It applies a decoded RenderPacket diff: upsert placed NodeViews/BeltViews into
// handle-keyed maps, drop removed handles, and keep the latest tick. A `full`
// packet is a keyframe (every live cell) and resets the buffer before applying;
// a non-full packet is an active-set diff layered onto the current buffer.

import type {
  BeltView,
  NodeView,
  RenderPacket,
  TileKindView,
  TileView,
  WireView,
} from '../protocol/decode.ts';
import { cellsOfFootprint } from '../protocol/footprint.ts';
import type { WireBody } from '../protocol/wireRoute.ts';

/** The render-ready scene: handle-keyed nodes + belts at the latest sim tick. */
export interface SceneState {
  /** The sim tick the buffer currently reflects. */
  tick: number;
  /** Placed machines, keyed by dense render handle. */
  nodes: Map<number, NodeView>;
  /** Belts (+ their items), keyed by dense render handle. */
  belts: Map<number, BeltView>;
  /**
   * REVERSE DOCK INDEX (WR-06): node handle -> the handles of every belt with an
   * end docked to it. Maintained here, on the packet path, where the belts being
   * touched are ALREADY in hand (the active-set diff), so it costs a couple of
   * set operations per changed belt and nothing at all for an idle board.
   *
   * It exists so the config panel's ~10Hz per-port flow join is O(belts docked to
   * the SELECTED machine) instead of O(every belt in the scene). The old shape
   * walked the whole belt map ten times a second for as long as any machine was
   * selected - work that scaled with total board size rather than with the thing
   * being looked at. Read it through {@link beltsDockedTo}, never directly.
   *
   * A node with no docked belt has NO entry (empty sets are pruned), so `.size`
   * is a true count of docked-to nodes.
   */
  dockedBelts: Map<number, Set<number>>;
  /**
   * Electrical wires (+ their endpoints/path/in-flight pulses), keyed by dense
   * render handle (WUI-01). Fed from the packet's appended `wires` tail; the
   * `wires.ts` layer (40-04) reads this to draw the resting cable + animate the
   * forward/reply pulses. EMPTY until the first packet carrying a `Node::Wire`.
   */
  wires: Map<number, WireView>;
  /**
   * Whether the live GridSession has an undoable action (UNDO-06). Sourced from
   * every RenderPacket's mandatory trailing `can_undo` (diff AND keyframe) so the
   * App can poll it to grey out the toolbar Undo button. Initialised `false` by
   * {@link createSceneState}; every well-formed packet carries the bool, so it
   * reflects the host's live availability from the first applied packet.
   */
  canUndo: boolean;
  /** Whether the live GridSession has a redoable action (mirror of {@link canUndo}). */
  canRedo: boolean;
  /**
   * The BOARD GENERATION of the last applied packet (phase 88, D-02, D-05): the handle
   * table every handle in this scene belongs to. Every host reset (undo, redo, load, New,
   * scene swap) remints the handles and raises it by one. The send seam stamps it on every
   * gesture frame unless the caller names one (`App.tsx` `submitInput`), so the host can
   * resolve a handle against the table this scene was drawn from. `0` before the first
   * packet, which is also the generation of a fresh host's first table.
   */
  generation: number;
  /**
   * The SWAP FLOOR of the last applied packet (phase 88 security, T-88-11): the generation
   * the host's last board swap (Load, an example, New) installed, `0` before any. A
   * generation below it belongs to a replaced board, so the gesture controller never names a
   * machine or a belt again across it, whichever page asked for the swap.
   */
  swapFloor: number;
  /**
   * WUI-01 reply-home observation LATCH: a monotonic count of applied packets in
   * which a wire carried a REPLY-direction in-flight pulse (`direction === 1`). It is
   * a READ-ONLY, ephemeral render-side accumulator (like the decode counters) — NOT a
   * serialized field and NEVER written back to the sim. It exists so the live
   * wire-visual gate can robustly assert "the reply travelled home" despite the
   * ~1-tick on-cable pulse window: every per-tick diff is applied here, and a wire
   * with an active reply pulse re-emits in that tick's diff, so this latch catches the
   * reply-home hop that the wire layer draws as the amber comet.
   */
  replyPulsesObserved: number;
  /**
   * The same reply-home LATCH, PER WIRE (plan 84-18, push 6): wire handle -> the count of
   * applied packets in which THAT wire carried a REPLY-direction pulse. A reply pulse lives on
   * a wire for one packet (`WIRE_HOP_TICKS` 1: shown at tick N+1, gone at N+2, about 16 ms
   * apart), so a reader that samples `pulses[]` can miss it on a slow page (CI run 5,
   * `25-route-and-handler`: the board-wide latch read 1 while that wire's `pulses` read empty
   * on every one of 56 reads). This one cannot. Cleared exactly as {@link wireReroutes} is: a
   * keyframe clears it, a removed handle drops its entry (dense handles are reused).
   *
   * Read-only render-side state, one way: it never re-enters the sim, a GridCommand, the
   * event log or `scene.tick`; it is exposed on `sceneSnapshot` as each wire's
   * `replyPulsesSeen`.
   */
  wireReplyPulses: Map<number, number>;
  /**
   * PREVIOUS-SLOT CACHE (SLOT-04, D-13): belt handle -> the slot indices that belt's
   * items occupied in the packet BEFORE the one now held, plus the tick that packet
   * reflected. It is the SOURCING half of trailing interpolation - the drawing half is
   * a lerp in `layers/items.ts` and needs a from-slot per dot, which the wire does not
   * carry and which the overwrite at the belt apply loop destroys.
   *
   * IT IS MAINTAINED HERE, ON THE PACKET PATH, FOR THE SAME REASON {@link
   * SceneState.dockedBelts} is: `applyPacket` runs once per PACKET and already holds
   * the outgoing `BeltView` in hand, while `draw()` runs once per DISPLAY FRAME. A
   * cache rebuilt in `draw()` would pay per frame for a fact that changes per packet,
   * and would have nothing to read - the previous view is gone by then.
   *
   * `slots` is ASCENDING, as the host emits it (`render_packet.rs`'s
   * `slots.iter().enumerate().filter_map(...)`), and is copied out of the outgoing
   * view rather than aliased, so a later mutation of that view cannot reach back.
   * `atTick` is the tick the SLOTS were observed at, NOT the tick of the packet that
   * displaced them: the lerp runs from that observation forward, which is what makes it
   * trailing.
   *
   * A belt with no entry (first sight, or the first packet after a keyframe) resolves
   * every item to its own current slot, so a dot never slides in from off the belt.
   * Entries are dropped in the `packet.removed` handler and the whole map is cleared on
   * a keyframe - WR-01 is the recorded bug for forgetting exactly that reset on
   * {@link SceneState.replyPulsesObserved}, and this map would have it too.
   *
   * Read-only accumulator, one way: nothing here re-enters the sim, a GridCommand or
   * the event log, and it is deliberately NOT exposed on `sceneSnapshot`.
   *
   * DOCTRINE REVERSED (PILE-06, phase 71). This paragraph used to end by claiming the
   * item layer stays opaque: that a belt reports a COUNT and no per-slot fact at all.
   * That claim is now FALSE. `sceneSnapshot` reports `occupiedSlots` and
   * `headOccupied` per belt, because
   * a live spec has to tell a belt that is full-but-draining from a belt that is
   * full-and-HOLDING against a machine that refuses, and a bare count cannot say which
   * of the two it is looking at.
   *
   * What SURVIVES the reversal, unchanged: the deep-copy discipline and the read-only
   * snapshot contract (T-14-FABRICO-RO). The snapshot still hands out FRESH arrays,
   * still holds no live reference into `SceneState`, and THIS map in particular is
   * still not exposed - it is a per-frame interpolation buffer, not a fact about the
   * board. Only the opacity claim is reversed. It is reversed in writing, in the same
   * commit that contradicts it: a doctrine comment left to go quiet while the code
   * moves under it is the WINDOWS-107 shape.
   */
  prevItemSlots: Map<number, BeltSlotHistory>;
  /**
   * RE-ROUTE GENERATIONS (plan 75-06, CABLE-07, D-07): wire handle -> a counter bumped
   * each time a DIFF packet re-sends a wire this buffer already holds on a PATH that
   * differs from the held one in any cell or tile kind. The wire layer reads it each frame
   * and draws the build-accent re-route mark for about a second after a bump, so a user
   * who turns a machine sees which cables the turn moved.
   *
   * ONLY THE PATH IS COMPARED. The host re-sends a wire on every pulse change
   * (`render_packet.rs`, the wire re-emit), so comparing whole wires would bump on every
   * comet and the mark would flash for traffic. A FIRST SIGHTING never bumps: the user
   * just drew that cable. A `full` packet (undo, redo, load, New, a scene swap, a lag
   * resync) clears the map with no compare, so a keyframe never marks anything; a removed
   * handle drops its entry, because dense handles are reused.
   *
   * A generation is drawn from {@link SceneState.wireRerouteSeq}, never counted per wire
   * from 1, so a value is never reused after a keyframe clears the map. See that field for
   * the miss a per-wire count produced.
   *
   * Read-only render-side state, one way: it never re-enters the sim, a GridCommand, the
   * event log or `scene.tick` (T-42-DET), and it is not exposed on `sceneSnapshot`.
   */
  wireReroutes: Map<number, number>;
  /**
   * The last re-route generation handed out (plan 75-06), scene-wide and only ever
   * increasing: a keyframe clears {@link SceneState.wireReroutes} and does NOT reset this.
   *
   * WHY, MEASURED. The first cut counted each wire from 1. The wire layer keeps an expired
   * mark's generation so it never re-latches the same move; a keyframe then cleared the
   * map, and a re-route of the same wire before the layer's next frame was numbered 1
   * again, equal to the expired latch, so it was never drawn. The live undo leg's mutation
   * run (a keyframe allowed to compare) found it: a re-route numbered 1 after a clear stayed
   * invisible behind the rotate's expired latch.
   */
  wireRerouteSeq: number;
  /**
   * The number of `full` packets applied to this buffer (CR-01, plan 76-14), only ever
   * increasing and never reset.
   *
   * WHY IT EXISTS. The host mints node, belt and wire handles from ONE counter
   * (`render_packet.rs`, the handle mint), and a keyframe (undo, redo, load, New, a scene
   * swap, a resync after a `RenderProducer::reset`) can restart it, so after a keyframe a
   * handle may name a different object, even one of another kind. A render cache keyed by
   * handle must therefore forget on a keyframe, and it reads this count to know one
   * happened: the scene tick alone cannot say, because an Undo or Redo keyframe moves the
   * tick FORWARD by one. Readers compare it with the value they last saw.
   *
   * Read-only render-side state, one way: it never re-enters the sim, a GridCommand, the
   * event log or `scene.tick` (T-42-DET), and it is not exposed on `sceneSnapshot`.
   */
  keyframes: number;
  /**
   * THE QUEUED GESTURES THE EDITOR COUNTS AS TAKEN (phase 88, plan 88-07, BELT-06, D-09): the
   * claims store App owns (`input/queuedClaims.ts`), set once on the scene object every
   * occupancy reader already receives, so `ghost.ts` `cellOccupied` (the one occupancy
   * definition) and the gesture layer's source terms read it with no new parameter. Absent on
   * a scene no App built (a test rig that does not install one, a headless read), which reads
   * exactly as before. Never touched by `applyPacket` and never exposed on `sceneSnapshot`: it
   * is the client's prediction of what the host will hold, not a fact the host sent.
   */
  queuedClaims?: QueuedOccupancy;
}

/**
 * The read half of the claims store (phase 88, plan 88-07), declared here so the render
 * module does not import the input layer. `occupies` answers for a cell (a resize claim of the
 * label `exclude` names does not count, the `cellOccupied` exclude rule), `doorstepTaken` for a
 * `(handle, port)` source a queued link will use, and `beltEndTaken` for a belt end (a Head
 * whose one outgoing link a queued Dock or held belt takes; a Tail is never taken).
 *
 * Every read names `generation`, the handle table of the scene the reader holds (phase 88
 * review, WR-01): a handle a claim took counts only in the table it was taken from.
 */
export interface QueuedOccupancy {
  occupies(cx: number, cy: number, generation: number, exclude?: number): boolean;
  doorstepTaken(node: number, port: number, generation: number): boolean;
  beltEndTaken(belt: number, end: 'Head' | 'Tail', generation: number): boolean;
  /**
   * The queued edits a cable is routed round (review fix pass 1, WR-A-04): the box each
   * queued Place adds to a cable's way, and the nodes queued Deletes remove (handles of
   * `generation`'s table). The drag preview reads it so it routes round the board the landed
   * cable will see once the queue folds.
   */
  wireBoard(generation: number): WireBoardEdits;
}

/** What `QueuedOccupancy.wireBoard` answers. */
export interface WireBoardEdits {
  boxes: readonly WireBody[];
  deleted: ReadonlySet<number>;
}

/** One belt's previous-packet item slots plus the tick they were observed at. */
export interface BeltSlotHistory {
  /** Occupied slot indices in the previous packet, ASCENDING (host emission order). */
  slots: number[];
  /** The sim tick those slot indices were observed at. */
  atTick: number;
}

/** The REPLY pulse direction byte (host-derived; 0 = FORWARD, 1 = REPLY). */
const WIRE_DIR_REPLY = 1;

/**
 * Resolve each CURRENT item's FROM-slot: where that same item sat in the previous
 * packet (D-13). Both inputs are ASCENDING slot indices; slot 0 is the HEAD.
 *
 * THE WIRE CARRIES NO ITEM ID, BUT IT CARRIES SOMETHING BETTER - THE EXACT SLOT.
 * `ItemView.arrival_tick` IS the slot index and `BeltView.latency` IS the total slot
 * count. Both are Phase-14 legacy misnomers, documented as such at both ends
 * (`crates/fabrico-host/src/render_packet.rs` writes `arrival_tick: i as u64` from
 * `enumerate()`, and `interp.ts slotArcLength` reads it back that way). NEITHER IS
 * RENAMED IN THIS PHASE: research Open Question 2 defers it deliberately, because a
 * cosmetic rename inside the one phase that already breaks the protocol crate is how a
 * bounded exception turns into a licence.
 *
 * SO THIS IS A TWO-POINTER WALK, NOT A RANK HEURISTIC, AND THE DIFFERENCE IS THE HEAD
 * DELIVERY. The sim invariant is that an item moves AT MOST ONE SLOT TOWARD THE HEAD
 * per advance and items NEVER REORDER (`crates/fabrico-core/src/belt_slots.rs
 * advance_slots`), so the k-th surviving previous item is the k-th current item. When
 * the head item is DELIVERED off slot 0 the array shrinks from the front, and every
 * surviving dot's RANK drops by one - a rank/index match would then hand each dot the
 * from-slot of the item AHEAD of it and slide the whole belt backwards by a slot. The
 * walk cannot make that mistake because it compares slot VALUES.
 *
 * THE WALK RUNS RIGHT TO LEFT - TAIL FIRST - AND THE DIRECTION IS THE CORRECTNESS
 * ARGUMENT, NOT A STYLE CHOICE. Both ends of the array move between packets, but they
 * move in ways that are not equally recoverable:
 *
 *   - the HEAD (index 0, lowest slot) is where items are DELETED. A delivery shifts
 *     every surviving entry down one index while the slot values also drop by one, so
 *     an unmatched prev entry and a matched one look identical from the left. A walk
 *     anchored there and testing `prev === cur` first therefore takes the greedy
 *     reading on a DRAINING CONTIGUOUS RUN - resolveFromSlots([1,2,3],[1,2]) answers
 *     [1,2], reading "nothing moved" off a belt that visibly drained, and every dot on
 *     it freezes. That was the shipped bug.
 *   - the TAIL (last index, highest slot) is where items are ADMITTED and where a
 *     deletion can never occur, because delivery only happens off the head. An
 *     admission is detectable from its slot VALUE alone (an item enters at the belt's
 *     tail slot, above every prev slot still unmatched), so the tail-anchored reading
 *     is unambiguous. Hence: start at the tail, walk toward the head.
 *
 * Walking DOWN from `i = prevSlots.length - 1`, `j = curSlots.length - 1`:
 *
 *   i < 0                   -> nothing left to match; from = cur's own slot
 *   prev[i] === cur[j] + 1  -> it advanced exactly one slot toward the head
 *   prev[i] === cur[j]      -> the item did not move this interval
 *   prev[i] <  cur[j]       -> cur[j] is NEWLY ADMITTED behind it; from = its own slot
 *   otherwise (prev > cur+1)-> prev[i] has no current claimant; skip it (i--)
 *
 * O(items), one pass, no `indexOf` / `findIndex` / rank comparison. A newly admitted
 * item resolving to its own slot is what stops a dot sliding in from off the belt, and
 * a prev array that runs out mid-walk takes the same branch.
 *
 * Pure: it allocates one result array and touches nothing else.
 */
export function resolveFromSlots(
  prevSlots: readonly number[],
  curSlots: readonly number[],
): number[] {
  const from = new Array<number>(curSlots.length);
  let i = prevSlots.length - 1;
  let j = curSlots.length - 1;
  while (j >= 0) {
    const cur = curSlots[j];
    if (i < 0) {
      from[j--] = cur; // nothing left to match: no slide-in from off the belt
      continue;
    }
    const prev = prevSlots[i];
    if (prev === cur + 1) {
      from[j--] = prev; // advanced one slot toward the head
      i--;
    } else if (prev === cur) {
      from[j--] = cur; // blocked, or between due ticks: it did not move
      i--;
    } else if (prev < cur) {
      from[j--] = cur; // newly admitted at the tail: no slide-in
    } else {
      i--; // prev sits further back than any claimant; skip it
    }
  }
  return from;
}

/** Drop `belt` from the reverse dock index, pruning nodes that end up with none. */
function unindexDocks(scene: SceneState, belt: BeltView): void {
  for (const dock of belt.docks) {
    const set = scene.dockedBelts.get(dock.node);
    if (!set) continue;
    set.delete(belt.id);
    if (set.size === 0) scene.dockedBelts.delete(dock.node);
  }
}

/** Add `belt` to the reverse dock index (both ends; a belt may dock two nodes). */
function indexDocks(scene: SceneState, belt: BeltView): void {
  for (const dock of belt.docks) {
    const set = scene.dockedBelts.get(dock.node);
    if (set) {
      set.add(belt.id);
    } else {
      scene.dockedBelts.set(dock.node, new Set([belt.id]));
    }
  }
}

/**
 * Every belt with an end docked to `nodeId` (WR-06). O(docked belts), not O(all
 * belts) - this is the whole point of {@link SceneState.dockedBelts}.
 *
 * Returns a FRESH array of LIVE `BeltView` references: the caller reads item
 * counts off them, and the index is rebuilt from the packet path rather than
 * mutated by readers. A handle in the index always resolves (both are maintained
 * in the same `applyPacket` pass), but a stale id is skipped rather than trusted.
 */
export function beltsDockedTo(scene: SceneState, nodeId: number): BeltView[] {
  const ids = scene.dockedBelts.get(nodeId);
  if (!ids) return [];
  const out: BeltView[] = [];
  for (const id of ids) {
    const belt = scene.belts.get(id);
    if (belt) out.push(belt);
  }
  return out;
}

/** A fresh, empty scene buffer. */
export function createSceneState(): SceneState {
  return {
    tick: 0,
    nodes: new Map(),
    belts: new Map(),
    dockedBelts: new Map(),
    wires: new Map(),
    canUndo: false,
    canRedo: false,
    generation: 0,
    swapFloor: 0,
    replyPulsesObserved: 0,
    wireReplyPulses: new Map(),
    prevItemSlots: new Map(),
    wireReroutes: new Map(),
    wireRerouteSeq: 0,
    keyframes: 0,
  };
}

/** Same tile kind: same variant and the same fields. */
function sameTileKind(a: TileKindView, b: TileKindView): boolean {
  if ('Straight' in a) return 'Straight' in b && a.Straight.axis === b.Straight.axis;
  return 'Corner' in b && a.Corner.from === b.Corner.from && a.Corner.to === b.Corner.to;
}

/**
 * Whether two wire paths differ (plan 75-06, D-07): length first, then each tile's cell
 * and kind in order. Pulses are not an argument, on purpose: see
 * {@link SceneState.wireReroutes}.
 */
export function wirePathChanged(held: readonly TileView[], incoming: readonly TileView[]): boolean {
  if (held.length !== incoming.length) return true;
  for (let i = 0; i < held.length; i++) {
    const a = held[i];
    const b = incoming[i];
    if (a.cell_x !== b.cell_x || a.cell_y !== b.cell_y) return true;
    if (!sameTileKind(a.kind, b.kind)) return true;
  }
  return false;
}

/**
 * Whether a decoded packet is a DIFF OLDER THAN THE SCENE it would be applied to (phase 90,
 * FAIL-05, D-09): true only for a non-full packet whose generation is below the scene's, or
 * whose generation equals it and whose tick is strictly below. App drops such a packet right
 * after decode, before any reader of it; the host relay already drops a lagged connection's
 * backlog, so this is the client's own one-comparison guard behind it.
 *
 * It only DROPS, never invents: a dropped diff changes nothing, and the scene keeps the newer
 * state it already holds. Strict on the tick, because a paused board sends diffs that share
 * one tick. A full packet always passes: every reset (Undo, Redo, Load, New) arrives as a
 * keyframe with a higher generation, and a keyframe replaces the scene whole, so no full
 * packet can lay an old handle table over a newer one. A diff of a higher generation with a
 * lower tick passes too: a swap re-seeds the tick inside the new generation.
 */
export function isStaleDiff(
  scene: Pick<SceneState, 'generation' | 'tick'>,
  packet: Pick<RenderPacket, 'full' | 'generation' | 'tick'>,
): boolean {
  if (packet.full) return false;
  if (packet.generation !== scene.generation) return packet.generation < scene.generation;
  return packet.tick < scene.tick;
}

/**
 * Apply one decoded packet to the scene buffer in place.
 *
 * - `full` (keyframe): clear the buffer first, then upsert everything.
 * - diff: upsert placed/belts, delete removed handles (a removed handle may be
 *   a node OR a belt — they share the dense handle space, so drop from both).
 * - Always advance to the packet's tick.
 */
export function applyPacket(scene: SceneState, packet: RenderPacket): void {
  if (packet.full) {
    scene.nodes.clear();
    scene.belts.clear();
    scene.dockedBelts.clear();
    scene.wires.clear();
    // WR-01 (40-review): a keyframe is a fresh scene (connect / LoadDemo genesis
    // swap), so the reply-home observation count belongs to the NEW scene — reset it.
    // Without this the monotonic latch leaks across a swap or a reused live server,
    // making the wire-visual gate's `replyPulsesObserved === 0` idle-read order-
    // dependent. (The delta read `> before` stays correct either way.)
    scene.replyPulsesObserved = 0;
    // SLOT-04 (D-13): the previous-slot cache belongs to the OLD scene. A keyframe is
    // a fresh one (connect / LoadDemo genesis swap), and a stale entry would hand a
    // dot on the NEW board a from-slot from a belt that no longer exists, sliding it
    // across the grid on the first frame after the swap. Same reset WR-01 records as
    // the bug `replyPulsesObserved` had.
    scene.prevItemSlots.clear();
    // CABLE-07 (D-07): a keyframe is a restructure (undo, redo, load, New, a scene swap)
    // or a resync, never an edit the user should see a cable move for. Every generation
    // goes with the old scene, and the wire loop below runs no compare on a keyframe.
    scene.wireReroutes.clear();
    // ...and the per-wire reply latch (plan 84-18), for the same fresh-scene reason.
    scene.wireReplyPulses.clear();
    // CR-01 (plan 76-14): count the keyframe, so every render cache keyed by handle can
    // tell that the handles may have been reminted (see SceneState.keyframes).
    scene.keyframes += 1;
  }
  for (const node of packet.placed) {
    scene.nodes.set(node.id, node);
  }
  for (const handle of packet.removed) {
    scene.nodes.delete(handle);
    // Un-index BEFORE the delete - the docks to retract are read off the belt.
    const goneBelt = scene.belts.get(handle);
    if (goneBelt) unindexDocks(scene, goneBelt);
    scene.belts.delete(handle);
    // A removed handle may be a node, a belt, OR a wire — they share the dense
    // handle space, so drop from all three (WUI-01).
    scene.wires.delete(handle);
    // ...and from the previous-slot cache (SLOT-04), for the same shared-handle-space
    // reason. A dense handle is reused, so an entry left behind here would be read as
    // the previous slots of whatever belt is minted onto that handle next.
    scene.prevItemSlots.delete(handle);
    // ...and from the re-route generations (CABLE-07), for the same reused-handle reason.
    scene.wireReroutes.delete(handle);
    // ...and from the per-wire reply latch (plan 84-18), for the same reused-handle reason.
    scene.wireReplyPulses.delete(handle);
  }
  for (const belt of packet.belts) {
    // A re-emitted belt may have DIFFERENT docks than the copy we hold (a Dock /
    // Unlink fold re-emits it), so retract the old entries before adding the new
    // ones - otherwise a de-docked belt would haunt its old node forever.
    const prev = scene.belts.get(belt.id);
    if (prev) {
      unindexDocks(scene, prev);
      // SLOT-04 (D-13): snapshot the OUTGOING view's slot indices HERE, before the
      // `set` below destroys it. `scene.tick` is still the tick those slots were
      // observed at (the packet's own tick is applied at the end of this function),
      // which is exactly the observation instant the trailing lerp measures from.
      // Copied, not aliased. A first-sight belt writes NO entry, so its items resolve
      // to their own slots and no dot slides in from off the belt.
      scene.prevItemSlots.set(belt.id, {
        slots: prev.items.map((it) => it.arrival_tick),
        atTick: scene.tick,
      });
    }
    scene.belts.set(belt.id, belt);
    indexDocks(scene, belt);
  }
  // Upsert the appended wire projections (WUI-01) — same diff/keyframe discipline
  // as belts: a changed/pulsing wire re-emits, an idle wire drops out of the diff.
  for (const wire of packet.wires) {
    // CABLE-07 (D-07): a DIFF re-sending a wire already held on a different PATH bumps
    // its re-route generation. Read the held copy BEFORE the set below replaces it. A
    // keyframe never compares (its clear above already emptied `wires`), and a first
    // sighting has no held copy.
    if (!packet.full) {
      const held = scene.wires.get(wire.id);
      if (held && wirePathChanged(held.path, wire.path)) {
        scene.wireRerouteSeq += 1;
        scene.wireReroutes.set(wire.id, scene.wireRerouteSeq);
      }
    }
    scene.wires.set(wire.id, wire);
    // Latch a reply-home observation (read-only accumulator): a wire re-emits every
    // tick it carries an in-flight pulse, so a REPLY-direction pulse in this diff is
    // the amber reply-home comet the layer draws. One-way; never re-enters the sim.
    if ((wire.pulses ?? []).some((p) => p.direction === WIRE_DIR_REPLY)) {
      scene.replyPulsesObserved += 1;
      scene.wireReplyPulses.set(wire.id, (scene.wireReplyPulses.get(wire.id) ?? 0) + 1);
    }
  }
  // Undo/redo availability rides EVERY packet (diff AND keyframe) and is now
  // mandatory on the wire, so apply it unconditionally — the decoder already
  // threw a DecodeError if the trailing bools were missing (truncated packet).
  scene.canUndo = packet.can_undo;
  scene.canRedo = packet.can_redo;
  // Phase 88 (D-02): every packet names its handle table's generation, diff and keyframe
  // alike, and the decoder read it strictly, so it is applied unconditionally.
  scene.generation = packet.generation;
  // Phase 88 security (T-88-11): and the swap floor beside it, read as strictly.
  scene.swapFloor = packet.swap_floor;
  scene.tick = packet.tick;
}

// ---------------------------------------------------------------------------
// The read-only introspection surface (REND-02 / window.__fabrico.scene()).
//
// `sceneSnapshot` is the BUILD-LAYER query surface: a pure function that returns
// a FRESH plain-data snapshot of the scene model each call — no Pixi refs, no
// live Map references, no setters. This formalizes the build-layer / item-layer
// split: the build layer (grid/machines/belts/overlay, driven by `SceneState`)
// is queryable here; the WebGL ITEM layer (the ParticleContainer) is NEVER
// individually queryable — a belt exposes only its item COUNT.
//
// Snapshot semantics are the security property (threat T-14-FABRICO-RO,
// Tampering, high): because every call deep-copies into new objects/arrays, the
// returned value can never mutate the live `SceneState` and is not a backdoor
// that bypasses the command layer / host echo. The hook is a read-only getter,
// not an event emitter.
// ---------------------------------------------------------------------------

/** One resolved port in the read-only snapshot (deep-copied from wire `ports[]`). */
export interface FabricoPort {
  /** Port index in the kind's catalog order (identity-stable across Rotate). */
  index: number;
  /** Host-resolved WORLD cell (rot-applied). */
  cell_x: number;
  cell_y: number;
  /** Cell edge the port faces: N=0, E=1, S=2, W=3 (rot-applied). */
  side: number;
  /** Port role: In=0, Out=1, Fault=2. */
  role: number;
  /**
   * Port transport medium: Mechanical=0, Electrical=1 (PORT-06, appended LAST on
   * the wire, 35-03). Exposed on the oracle so the live gate can verify the
   * ROUTE-06 presets seed the correct medium (HTTP=Electrical, Item=Mechanical).
   */
  medium: number;
}

/** One placed machine in the read-only snapshot: its kind/state + every cell it occupies. */
export interface FabricoNode {
  /** Dense render handle (stable id). */
  id: number;
  /** Machine class byte (machine_kind). */
  kind: number;
  /** Visual state byte (state_tag — 2 = faulted). */
  state: number;
  /** Every world cell the footprint occupies, expanded via `cellsOfFootprint`. */
  cells: [number, number][];
  /**
   * Host-resolved port roles + world cells (deep-copied, port order preserved).
   * The P22 E2E-03 oracle surface: "a placed factory reports its In/Out/Fault
   * port roles from real packet data, and a Rotate re-stamps footprint + ports"
   * asserts against THIS field — read-only, no schema/packet change.
   */
  ports: FabricoPort[];
  /**
   * A label's COMMITTED words and colour byte (phase 76, plan 76-02), deep-copied from the
   * wire `NodeView.label`; `null` on every other kind. The model's reading: a live spec
   * that asserts it also reads the words overlay in the DOM, because the model cannot
   * tell drawn words from missing ones.
   */
  label: { text: string; colour: number } | null;
}

/** One belt tile in the read-only snapshot: its cell plus a deep-copied geometry. */
export interface FabricoBeltTile {
  cell_x: number;
  cell_y: number;
  kind: TileKindView;
}

/** One per-end dock in the read-only snapshot (deep-copied from wire `docks[]`). */
export interface FabricoDock {
  /** Which belt end docks: Head or Tail. */
  end: 'Head' | 'Tail';
  /** The docked machine's dense render handle. */
  node: number;
  /** The dock's wire port value (keyspace per BeltDockView — see ports.dockPort). */
  port: number;
}

/**
 * One belt in the read-only snapshot: its path tiles, an item COUNT, and (since
 * PILE-06) WHICH slots those items sit in.
 *
 * DOCTRINE REVERSED (PILE-06, phase 71). This header used to promise an item count
 * and no per-slot detail. The count is still here and still what most callers read;
 * what is no longer true is that it is ALL a caller gets. See
 * {@link FabricoBelt.occupiedSlots}.
 */
export interface FabricoBelt {
  /** Dense render handle (stable id). */
  id: number;
  /** The drawn path tiles (deep-copied; empty for a Wire-minted belt). */
  tiles: FabricoBeltTile[];
  /**
   * How many items are currently on the belt: a raw count of the item views on the
   * wire, NOT deduped. Unchanged by PILE-06 and deliberately kept: it is what every
   * existing live spec reads, and removing it would move all of them for no gain.
   * For WHERE those items sit, read {@link FabricoBelt.occupiedSlots}.
   */
  items: number;
  /**
   * Which slot indices hold an item, ASCENDING and without duplicates (PILE-06).
   *
   * The slot index is already on the wire as `ItemView.arrival_tick`: the host fills
   * it with the `.enumerate()` index taken over `belt.slots` BEFORE the `filter_map`
   * (`crates/fabrico-host/src/render_packet.rs`), so the value is the slot position
   * including empties. {@link SceneState.prevItemSlots} already reads it that way;
   * this field is the same derivation, promoted to the read-only snapshot.
   *
   * A FRESH array per `sceneSnapshot` call, never a live reference into `SceneState`
   * (T-14-FABRICO-RO). Slot indices are reported as they arrive, unclamped: an
   * out-of-range index from a hostile packet sorts and reports without indexing
   * anything, matching the open-keyspace rule the same reader applies to `role`,
   * `side` and `medium`.
   */
  occupiedSlots: number[];
  /**
   * Whether slot 0 holds an item (PILE-06). Slot 0 is the HEAD by core convention
   * (`crates/fabrico-core/src/belt_slots.rs`): the deliver / output end, so this is
   * the tile pressed against the DOWNSTREAM machine, not the far end of the belt.
   *
   * This is the one bit an overload spec judges: a belt whose head slot stays
   * occupied across ticks is holding against a machine that will not take the item,
   * which a count of items cannot express because a full-and-draining belt and a
   * full-and-jammed belt report the same count.
   */
  headOccupied: boolean;
  /** Per-end docks (deep-copied, wire order preserved; empty for an undocked belt). */
  docks: FabricoDock[];
  /**
   * This belt's advance interval in sim ticks per slot (SLOT-03, `BeltView`'s
   * appended-LAST field). Larger means slower; the core holds it as a
   * `NonZeroU32` and the wire carries a plain integer.
   *
   * EXPOSED FOR THE SAME REASON `FabricoPort.medium` IS, and with the same
   * discipline. BELT-02 makes this the one field a user can now edit on a belt,
   * and the LIVE e2e gate has no other way to read it: it is on the render
   * packet for every belt, it is what `machine_config(belt)` must agree with
   * (68-UI-SPEC 3.3's two-sources rule), and without it a live spec asserting a
   * pace edit can only re-read the panel that produced it. A scalar copy off the
   * wire - no live reference, no setter and no new packet field. (The clause that
   * once closed this sentence, "and the item layer stays opaque exactly as before",
   * is retired by PILE-06: the deep-copy half of that promise still holds, the
   * opacity half does not.)
   */
  ticksPerSlot: number;
}

/** One in-flight wire pulse in the read-only snapshot (WUI-01). */
export interface FabricoWirePulse {
  /** The tick this pulse was admitted to its wire (the hop-maturation clock). */
  entry_tick: number;
  /** The hop length in ticks (the interpolation denominator). */
  hop_ticks: number;
  /** Host-derived direction: 0 = FORWARD (request out), 1 = REPLY (response home). */
  direction: number;
}

/** One electrical wire in the read-only snapshot (WUI-01): endpoints + pulse facts. */
export interface FabricoWire {
  /** Dense render handle (stable id). */
  id: number;
  /** The `from`/`to` endpoint docks (dense node handle + port). */
  from: { node: number; port: number };
  to: { node: number; port: number };
  /** The routed cable's tile count (path length) — geometry presence, not pixels. */
  tiles: number;
  /**
   * The routed cable's CELLS, in order from the source port to the target port
   * (deep-copied fresh objects). Phase 75 (CABLE-06): a count cannot say which way a
   * cable leaves its port or enters the other, and the live specs that grade "the cable
   * plugs in head-on" read the first and last step from these cells.
   */
  path: { cell_x: number; cell_y: number }[];
  /** In-flight request/reply pulses (deep-copied; EMPTY for a dormant wire). */
  pulses: FabricoWirePulse[];
  /**
   * How many applied packets carried a REPLY pulse on THIS wire since the last keyframe (plan
   * 84-18; {@link SceneState.wireReplyPulses}). A one-packet pulse a reader missed still counts.
   */
  replyPulsesSeen: number;
}

/** A fresh, plain-data snapshot of the build-layer scene model at one tick. */
export interface FabricoScene {
  /** The sim tick this snapshot reflects. */
  tick: number;
  /** Placed machines, ordered by id for deterministic reads. */
  nodes: FabricoNode[];
  /** Belts, ordered by id for deterministic reads. */
  belts: FabricoBelt[];
  /**
   * Electrical wires (WUI-01), ordered by id — the request/response cables + their
   * in-flight pulses. Deep-copied plain data (no live Map ref, T-14-FABRICO-RO); the
   * live wire-visual gate reads this to assert the dormant cable and the reply-home
   * pulse without touching pixels.
   */
  wires: FabricoWire[];
  /**
   * The monotonic reply-home observation count (see {@link SceneState.replyPulsesObserved}).
   * A plain number copied by value — mutating it on the snapshot never reaches the
   * live scene. The live gate polls this to prove the reply travelled home.
   */
  replyPulsesObserved: number;
  /**
   * Whether the live GridSession has an undoable action, mirrored from the
   * packet (see {@link SceneState.canUndo}). A plain boolean copied by value -
   * mutating it on the snapshot never reaches the live scene (T-14-FABRICO-RO).
   */
  canUndo: boolean;
  /** Whether the live GridSession has a redoable action (mirror of {@link canUndo}). */
  canRedo: boolean;
  /**
   * The board generation of the last applied packet (see {@link SceneState.generation}),
   * copied by value (phase 88, D-02). The live oracle reads it to see a reset happen.
   */
  generation: number;
  /** The swap floor of the last applied packet (see {@link SceneState.swapFloor}). */
  swapFloor: number;
}

/** Deep-copy a belt tile's geometry so the snapshot holds no live reference. */
function cloneTileKind(kind: TileKindView): TileKindView {
  if ('Straight' in kind) {
    return { Straight: { axis: kind.Straight.axis } };
  }
  return { Corner: { from: kind.Corner.from, to: kind.Corner.to } };
}

/**
 * The occupied slot indices of one belt's item views, ASCENDING and deduped, in a
 * FRESH array (PILE-06).
 *
 * The host emits ascending-unique already (`.enumerate().filter_map(..)` over
 * `belt.slots`), so the sort and the dedupe are not for the host: they are what makes
 * "ascending, no duplicates" a property of this function rather than an inherited
 * accident, and they hold for a replayed or hand-fed packet too. Numeric sort, not
 * lexicographic - slot 10 must land after slot 9.
 */
function occupiedSlotsOf(items: BeltView['items']): number[] {
  const sorted = items.map((it) => it.arrival_tick).sort((a, b) => a - b);
  const out: number[] = [];
  for (const slot of sorted) {
    if (out.length === 0 || out[out.length - 1] !== slot) {
      out.push(slot);
    }
  }
  return out;
}

/**
 * Build a fresh read-only snapshot of the build-layer scene model.
 *
 * Pure (snapshot semantics): every node/belt/tile/cell is a NEW object or array,
 * so mutating the returned value can never reach back into `SceneState`. Each
 * node's `cells` are expanded via the shared `cellsOfFootprint` (the same
 * primitive the sim + renderer use) and sorted deterministically. Nodes and belts
 * are sorted by id so two snapshots of the same scene compare equal regardless of
 * Map insertion order.
 *
 * DOCTRINE REVERSED (PILE-06, phase 71). This docblock used to say "each belt
 * reports `items` as a COUNT only (build/item split)". A belt now ALSO reports
 * `occupiedSlots` and `headOccupied`, because whether the tile touching a machine
 * is occupied is the fact an overload acceptance turns on and a count cannot carry
 * it. What survives unchanged is everything the sentence was actually protecting:
 * this function is still pure, every node, belt, tile, cell and now slot array is
 * still a NEW object, and mutating the returned value still cannot reach back into
 * `SceneState` (T-14-FABRICO-RO). The reversal is written down at both sites that
 * stated the doctrine, in the commit that contradicts it.
 */
export function sceneSnapshot(scene: SceneState): FabricoScene {
  const nodes: FabricoNode[] = [];
  for (const n of scene.nodes.values()) {
    const cells = cellsOfFootprint(n.cell_x, n.cell_y, n.w, n.h, n.rot);
    // Deterministic cell order (cellsOfFootprint is already row-major, but sort
    // explicitly so the snapshot contract never depends on expansion order).
    cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    nodes.push({
      id: n.id,
      kind: n.kind,
      state: n.state,
      cells,
      // FRESH object per port (the cloneTileKind discipline): the snapshot
      // holds no live reference into the wire NodeView (T-14-FABRICO-RO).
      ports: n.ports.map((p) => ({
        index: p.index,
        cell_x: p.cell_x,
        cell_y: p.cell_y,
        side: p.side,
        role: p.role,
        medium: p.medium,
      })),
      // FRESH object (T-14-FABRICO-RO): the snapshot holds no live reference into the
      // wire NodeView. Absent (a hand-built test NodeView may omit it) reads as `null`.
      label: n.label ? { text: n.label.text, colour: n.label.colour } : null,
    });
  }
  nodes.sort((a, b) => a.id - b.id);

  const belts: FabricoBelt[] = [];
  for (const b of scene.belts.values()) {
    const occupiedSlots = occupiedSlotsOf(b.items);
    belts.push({
      id: b.id,
      tiles: b.tiles.map((t) => ({
        cell_x: t.cell_x,
        cell_y: t.cell_y,
        kind: cloneTileKind(t.kind),
      })),
      items: b.items.length,
      // PILE-06: WHICH slots hold an item, and whether the head slot (slot 0, the
      // tile touching the downstream machine) is one of them. A FRESH array per
      // call - `occupiedSlotsOf` builds a new one and aliases nothing.
      occupiedSlots,
      headOccupied: occupiedSlots.includes(0),
      // FRESH object per dock - same deep-copy discipline as ports above.
      docks: b.docks.map((d) => ({ end: d.end, node: d.node, port: d.port })),
      ticksPerSlot: b.ticks_per_slot,
    });
  }
  belts.sort((a, b) => a.id - b.id);

  // WUI-01: deep-copy every wire + its pulses (fresh objects — the snapshot holds no
  // live reference into scene.wires, T-14-FABRICO-RO), ordered by id for deterministic
  // reads. A dormant wire has an empty `pulses` array (the empty read).
  const wires: FabricoWire[] = [];
  for (const w of scene.wires.values()) {
    wires.push({
      id: w.id,
      from: { node: w.from.node, port: w.from.port },
      to: { node: w.to.node, port: w.to.port },
      tiles: w.path.length,
      path: w.path.map((t) => ({ cell_x: t.cell_x, cell_y: t.cell_y })),
      pulses: w.pulses.map((p) => ({
        entry_tick: p.entry_tick,
        hop_ticks: p.hop_ticks,
        direction: p.direction,
      })),
      replyPulsesSeen: scene.wireReplyPulses.get(w.id) ?? 0,
    });
  }
  wires.sort((a, b) => a.id - b.id);

  return {
    tick: scene.tick,
    nodes,
    belts,
    wires,
    replyPulsesObserved: scene.replyPulsesObserved,
    canUndo: scene.canUndo,
    canRedo: scene.canRedo,
    generation: scene.generation,
    swapFloor: scene.swapFloor,
  };
}
