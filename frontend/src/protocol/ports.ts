// ports.ts — the single pure TS mirror of the Rust host's port/dock contract:
// keyspace resolution, the dock-accept predicate, and nub anchor geometry.
// The footprint.ts/route.ts family: zero Pixi/DOM imports, every function names
// the Rust source it mirrors, and every downstream Phase 21 consumer (belts,
// machines statics, overlay rings, gesture hit-maps) reads port math from HERE
// rather than hand-rolling it (Don't-Hand-Roll).
//
// Rust mirror sources:
//   - Side math:           crates/fabrico-core/src/state.rs:706-719
//   - port_world rotation: crates/fabrico-core/src/state.rs:765-784
//   - dock accept:         crates/fabrico-command/src/command.rs:472-537 and
//                          crates/fabrico-core/src/state.rs:1232-1313
//   - dock keyspaces:      crates/fabrico-command/src/command.rs:461-565
//                          (forward translation at freeze time) and
//                          crates/fabrico-core/src/state.rs:1243-1268 (reverse)
//
// Coordinate outputs (nub anchors, handle points) are render-side floats and
// NEVER flow into a logged command — commands carry only integer cells /
// handles / port indices (T-14-FLOAT-LEAK discipline).

import type {
  BeltDockView,
  BeltEnd,
  BeltView,
  CatalogPortView,
  NodeView,
  PortView,
  TileView,
} from './decode';
// INSET and NUB_PUSH are READ from the shared geometry module, not re-declared. They
// used to be private literals here while `shared/geometry.ts` exported the same two
// numbers as the declared single source, and `render/layers/machineState.ts` derives
// `MAX_NUB_REACH_PX` from THAT copy - so the nub anchor and the reach that measures it
// were two sources of truth for one pair of numbers. Nothing had drifted; the point is
// that nothing could have caught it if it had.
import { CELL, INSET, NUB_PUSH } from '../../shared/geometry';
// The ONE declaration of the 44px minimum interactive target (style bible 6d), read
// here rather than restated: `wireNubHitRadiusWorld` below halves it into a world-px
// radius, so the chrome rule and the canvas hit test cannot drift. The module is a
// pure `(Skin, number) -> string` emitter with no Pixi and no DOM import of its own,
// so this stays inside the file-head rule ("zero Pixi/DOM imports") above.
import { MIN_TARGET_PX } from '../render/synth/chrome/skinToCssVars';

/**
 * The wire sentinel for "dock to the node's fault port" — mirrors
 * `fabrico_core::FAULT_PORT` (u16::MAX). Read-side only: the live UI never
 * SENDS 65535 (nub-granular hit-testing addresses a spatial fault nub by its
 * catalog index; the host owns the sentinel translation at freeze time).
 */
export const FAULT_PORT = 65535;

/**
 * The `port_role` byte keyspace, mirroring `fabrico_protocol::port_role`
 * (crates/fabrico-protocol/src/lib.rs, the `IN = 0 / OUT = 1 / FAULT = 2` module
 * beside `machine_kind` and `state_tag`). Values are read from the RUST contract,
 * not inferred from the call sites that happen to compare against them.
 *
 * The same shape as `protocol/kinds.ts`'s `machine_kind` / `state_tag`, and for the
 * same stated reason: a single named source keeps the renderer honest against the
 * Rust contract instead of scattering the magic number through the render layers.
 * A bare byte by design, NOT enum-index coupled.
 *
 * Named NOW rather than later because plan 71-04 gives the Sink and the Router a
 * real spatial `Role::Fault` port (71-CONTEXT D-07). Byte 2 has until now appeared
 * on exactly one kind, the Factory, and is about to start appearing on two more, so
 * every production reader of it is about to run on inputs it has never run on. That
 * makes this a CONTRACT item landing ahead of the catalog change, not a tidy-up
 * landing after it.
 *
 * An UNKNOWN role byte is not an error: the wire keyspace is open (a future role 3
 * decodes and renders as neutral), matching how `side` and `medium` are read.
 */
export const PORT_ROLE = {
  /** An input port - a belt Head docks here (LOAD). */
  IN: 0,
  /** An output port - a belt Tail docks here (OFFLOAD). */
  OUT: 1,
  /** A fault-emitter port - a belt Tail docks here to drain refused output. */
  FAULT: 2,
} as const;

/** One value of the `port_role` keyspace, for a reader that wants the narrow type. */
export type PortRole = (typeof PORT_ROLE)[keyof typeof PORT_ROLE];

/**
 * Core Side (N=0, E=1, S=2, W=3) -> legacy `edgePoint` dir (0=E, 1=S, 2=W,
 * 3=N): `(side + 3) & 3`. The NAMED bridge between the two keyspaces — never
 * an inline arithmetic guess (P17 IN-02, the pre-identified 90-degree-rotation
 * bug class; UI-SPEC lock).
 */
export function sideToEdgeDir(side: number): number {
  return (side + 3) & 3;
}

/**
 * The outward unit step off a side: N=(0,-1), E=(1,0), S=(0,1), W=(-1,0).
 * Mirrors `unit_delta` (crates/fabrico-core/src/state.rs:706-713).
 */
export function unitDelta(side: number): [number, number] {
  switch (side & 3) {
    case 0:
      return [0, -1];
    case 1:
      return [1, 0];
    case 2:
      return [0, 1];
    default:
      return [-1, 0];
  }
}

/**
 * The opposite side: `(side + 2) & 3`. Mirrors `opposite`
 * (crates/fabrico-core/src/state.rs:715-719).
 */
export function oppositeSide(side: number): number {
  return (side + 2) & 3;
}

/**
 * Resolve a wire `BeltDockView` to the docked node's `PortView` — the single
 * reader of ALL THREE dock keyspaces on the wire (RESEARCH Finding 2; mirrors
 * command.rs:461-565 forward translation and state.rs:1243-1268 reverse):
 *
 *   1. `port === 65535` (either end): the node's `role===2` fault port. A node
 *      WITHOUT a spatial fault port (e.g. ROUTER) resolves to `null` — docked
 *      but no spatial nub; render that end undocked-style, never throw.
 *   2. Tail, `port !== 65535`: the Out ROUTING key — the nth `role===1` port.
 *   3. Head: the raw catalog index (exact because In ports come FIRST in every
 *      catalog entry — the In-first invariant).
 *
 * Out-of-range values in any keyspace resolve to `null` (T-21-02: hostile wire
 * values degrade to undocked styling, never crash the renderer).
 */
export function dockPort(node: NodeView, dock: BeltDockView): PortView | null {
  if (dock.port === FAULT_PORT) {
    return node.ports.find((p) => p.role === PORT_ROLE.FAULT) ?? null;
  }
  if (dock.end === 'Tail') {
    return node.ports.filter((p) => p.role === PORT_ROLE.OUT)[dock.port] ?? null;
  }
  return node.ports[dock.port] ?? null;
}

/** One renderable/hit-testable nub: anchor center + outward normal + identity. */
export interface NubSpec {
  /** Nub center px (node-root-local or world, per the producing function). */
  x: number;
  y: number;
  /** Outward unit normal (= unitDelta(side)). */
  nx: number;
  ny: number;
  side: number;
  role: number;
  /**
   * The port's transport medium byte ({@link MEDIUM_MECHANICAL} /
   * {@link MEDIUM_ELECTRICAL}), carried so `drawRoleNub` can discriminate on the SECOND
   * silhouette axis without re-resolving the `PortView` it came from.
   *
   * OPTIONAL, and deliberately so: the keyspace is open on the wire and hand-built
   * specs in specs and spikes predate the field. An absent or unknown byte draws the
   * MECHANICAL disc and never throws, matching `chrome/portLabels.ts` reading an
   * unknown medium as `Item`.
   */
  medium?: number;
  index: number;
}

/**
 * The ROLE-SILHOUETTE geometry - the ONE definition of what each role looks
 * like, shared by the only two things that draw a port:
 *
 *   - `render/layers/machines.ts drawRoleNub`  the nub on the board
 *   - `chrome/PortIndicator.tsx`               the glyph in the config panel's
 *                                              I/O rows, at 12px
 *
 * The whole point of the panel glyph is that a reader can map a panel row to a
 * nub on the grid, so the two must never drift. They already had: the panel
 * copied the numbers as literals "verbatim from drawRoleNub", which is a comment,
 * not a constraint. Importing them is the constraint. (This module is the right
 * home - it is pixi-free and already owns "nub anchor geometry", so the chrome
 * can read it without pulling the renderer into its bundle.)
 *
 * The role encoding, non-colour by design (colour is only ever reinforcement -
 * the project SAFE rule):
 *
 *   role 0 (In)    a plain filled disc
 *   role 1 (Out)   the same disc + an outward stem: "something leaves here"
 *   role 2 (Fault) a SMALL core inside a ring at a LARGER radius - an annulus
 *
 * 51-UI-REVIEW fix 3 is that last line. Fault used to be `circle(r).fill()` plus
 * `circle(r).stroke()` - a stroke straddling the SAME radius as the fill, in the
 * SAME `currentColor`. That is not a ring, it is a disc that is 0.625 units
 * fatter: the two draws composite into one solid shape because nothing separates
 * them. On the board the extra radius at least read as "heavier"; in the panel,
 * rendered into a 12px box from the 13-unit viewBox (~0.92 px/unit) with
 * `crispEdges`, In and Fault differed by about half a device pixel and were the
 * same shape. Of the three roles the UI-SPEC says are "carried by silhouette",
 * only Out actually was.
 *
 * Pulling the ring OUT to `NUB_FAULT_RING_R` and shrinking the fill to
 * `NUB_FAULT_CORE_R` leaves visible substrate between them, so the fault exit is
 * a genuinely different shape at every scale - and it stays the heaviest of the
 * three, which is what the "danger exit" reading always intended. The role-2
 * invariant is untouched: BOTH parts are drawn in every state, so a dimming fill
 * never makes the shape disappear (RENDER-04 / VIS-03).
 */
/** Disc radius for roles 0 and 1. */
export const NUB_R = 3.5;
/** How far the role-1 stem reaches from the centre along the outward normal. */
export const NUB_STEM = 6.5;
/** Stroke width for the role-1 stem and the role-2 ring. */
export const NUB_STROKE = 1.25;
/** Role-2 core radius - deliberately SMALLER than {@link NUB_R} so the fault
 *  silhouette is not merely a heavier version of the In disc. */
export const NUB_FAULT_CORE_R = 2;
/** Role-2 ring radius - deliberately LARGER than {@link NUB_R}, and far enough
 *  outside the core that the gap survives a 12px raster. */
export const NUB_FAULT_RING_R = 5;

/**
 * The ELECTRICAL terminal square's half-extent -> a 10 px square (UI-SPEC 1.2).
 *
 * MOVED HERE from `render/layers/wires.ts`, where it was a module-private literal, so
 * that ONE number serves both places an electrical terminal is ever drawn. It carries
 * its original meaning unchanged: `CABLE_LANE_OFFSET` is capped by it, because a
 * clamped cable end sitting one lane offset off the nub centre must still land inside
 * the square.
 */
export const NUB_HALF = 5;

/**
 * THE NUB RING - r 7, stroke 2 - and the ONE declaration of it.
 *
 * Shipped since Phase 21 as a pair of bare literals inside `overlay.showNubRing`, and
 * copied verbatim into `overlay.showWireTargets` in plan 66-06 with a comment saying
 * "the radii mirror `showNubRing` exactly", which is a description of a duplication and
 * not of a shared source. Phase 74 adds a THIRD and a FOURTH reader - the armed Belt
 * tool's dock target rings and the junction collar in `belts.ts`, which derives BOTH
 * its disc radius and its low-zoom ceiling from these two numbers - so the copy stops
 * being survivable: the collar's disc is `NUB_RING_R - NUB_RING_STROKE / 2` and must
 * land exactly on the ring's inner edge, at every zoom, by construction rather than by
 * two files agreeing.
 *
 * They live HERE rather than in `overlay.ts` for the reason `NUB_HALF` moved here: this
 * module is Pixi-free and already owns nub geometry, so the belts layer can read it
 * without either renderer importing the other. 74-UI-SPEC 1.2 and 2.1 are the contract.
 *
 * The rotate handle's own 7 and 1.5 (`overlay.ts` `drawRotateHandle`) are deliberately
 * NOT folded in. They are an unrelated mark with an unrelated meaning, and a constant
 * that swallowed them would tie the rotate handle's size to the nub ring's forever.
 */
export const NUB_RING_R = 7;
/** The nub ring's stroke width in world px. See {@link NUB_RING_R}. */
export const NUB_RING_STROKE = 2;

/**
 * The half-extent of the ELECTRICAL port silhouette: a square of side
 * `2 * NUB_ELECTRICAL_HALF` where a mechanical port draws a disc of radius
 * {@link NUB_R}.
 *
 * WRITTEN AS THE ALIAS, NEVER AS THE NUMBER, AND THE DERIVATION IS THE VALUE. An
 * unconnected electrical port must be the SAME OBJECT at the SAME size as the terminal
 * `wires.ts` stamps when a cable lands on it - a connected and an unconnected port are
 * one thing, not two that happen to look alike. A literal `5` here and a `NUB_HALF`
 * there is two sources of truth for one silhouette, and they will drift. This is the
 * same "one declaration, two spellings" idiom {@link ROLE_IN} already uses.
 *
 * MEDIUM IS A SILHOUETTE CUE, NEVER A COLOUR CUE (72-09 R-59). An electrical In draws
 * `ramp[3]` and an electrical Out draws `ramp[4]`, exactly as their mechanical
 * siblings do via `machines.ts nubColor`. Painting it `accents.electric` is refused on
 * two counts: the locked bible reserves that ink for wire ENERGY and a resting nub
 * carries none (the resting cable is `palette.cable` until a pulse rides it), and
 * `nubColor` already carries the machine-STATE channel, which a medium-keyed hue would
 * collide with head on. This phase mints NO hue.
 *
 * IT DOES NOT MOVE `MAX_NUB_REACH_PX`, and that is the one thing it could have broken.
 * Reach is `extent - INSET + NUB_PUSH`, so the square reaches 5.500 px outside the box
 * edge: between the role-0 disc (4.000) and the role-2 annulus (6.125), and well inside
 * the role-1 stem (7.625) that already defines the maximum. `ALERT_RING_OUTSET_U` is
 * untouched, and the square crosses the alert-ring band (2.000 .. 4.000 px outside the
 * edge) exactly as all three shipped silhouettes already do.
 *
 * The two drawers, which are checked SEPARATELY because the defect is the two
 * DISAGREEING and a test on either side alone cannot see a disagreement (R-56):
 *   - `render/layers/machines.ts drawRoleNub`  the nub on the board
 *   - `chrome/PortIndicator.tsx`               the glyph in the config panel's I/O rows
 */
export const NUB_ELECTRICAL_HALF = NUB_HALF;

/**
 * The nub anchor for one port cell + side, in the frame of `(cellX, cellY)`:
 * the edge midpoint of that CELL on the side, pushed 2.5px along the outward
 * normal. Reproduces the machines.ts nub geometry EXACTLY (CELL=32,
 * INSET=2, push=2.5) but per-CELL rather than per-effective-box, which is what
 * lands multi-cell ports on the right perimeter cell. Exported so the overlay
 * ghost port preview shares this exact math (Don't-Hand-Roll).
 */
export function nubAnchor(cellX: number, cellY: number, side: number): { x: number; y: number } {
  const [nx, ny] = unitDelta(side);
  let x: number;
  let y: number;
  switch (side & 3) {
    case 0: // N
      x = cellX * CELL + CELL / 2;
      y = cellY * CELL + INSET;
      break;
    case 1: // E
      x = cellX * CELL + CELL - INSET;
      y = cellY * CELL + CELL / 2;
      break;
    case 2: // S
      x = cellX * CELL + CELL / 2;
      y = cellY * CELL + CELL - INSET;
      break;
    default: // W
      x = cellX * CELL + INSET;
      y = cellY * CELL + CELL / 2;
      break;
  }
  return { x: x + nx * NUB_PUSH, y: y + ny * NUB_PUSH };
}

function nubSpecAt(p: PortView, cellX: number, cellY: number): NubSpec {
  const [nx, ny] = unitDelta(p.side);
  const { x, y } = nubAnchor(cellX, cellY, p.side);
  return { x, y, nx, ny, side: p.side, role: p.role, medium: p.medium, index: p.index };
}

/**
 * Node-root-local nub specs for machine STATICS (machines.ts draws in the
 * node-root frame): local cell = `port.cell - node.cell`, then the shared
 * anchor math. Port order preserved.
 */
export function localNubSpecs(node: NodeView): NubSpec[] {
  return node.ports.map((p) => nubSpecAt(p, p.cell_x - node.cell_x, p.cell_y - node.cell_y));
}

/**
 * World-px nub specs — the shared source for gesture hit-maps, overlay rings,
 * and belt end-cap anchors. Port order preserved.
 */
export function worldNubSpecs(node: NodeView): NubSpec[] {
  return node.ports.map((p) => nubSpecAt(p, p.cell_x, p.cell_y));
}

/**
 * The grid cell of a belt end: Head = LAST tile's cell, Tail = FIRST tile's
 * cell (RESEARCH Finding 1; mirrors the host end-cell resolution in
 * command.rs:472-537). Assumes `tiles.length >= 1` (post-P20 every belt is
 * DrawBelt-minted with tiles >= 1).
 */
export function beltEndCell(tiles: TileView[], end: BeltEnd): [number, number] {
  const t = end === 'Head' ? tiles[tiles.length - 1] : tiles[0];
  return [t.cell_x, t.cell_y];
}

/**
 * The outward direction of a belt end: `endCell - innerNeighbour` (Head inner
 * = tiles[len-2], Tail inner = tiles[1]). `null` for a single-tile belt — the
 * host skips the facing check in that case (command.rs / state.rs mirror).
 */
export function beltEndOutward(tiles: TileView[], end: BeltEnd): [number, number] | null {
  if (tiles.length < 2) {
    return null;
  }
  const [ex, ey] = beltEndCell(tiles, end);
  const inner = end === 'Head' ? tiles[tiles.length - 2] : tiles[1];
  return [ex - inner.cell_x, ey - inner.cell_y];
}

/**
 * The side an outward unit step points along - the inverse of {@link unitDelta},
 * and the TS mirror of `side_of_unit_delta` (crates/fabrico-core/src/state.rs).
 * A non-unit or zero delta has no side and answers `null` rather than a guess.
 */
export function sideOfUnitDelta(d: [number, number]): number | null {
  const [dx, dy] = d;
  if (dx === 0 && dy === -1) return 0; // N
  if (dx === 1 && dy === 0) return 1; // E
  if (dx === 0 && dy === 1) return 2; // S
  if (dx === -1 && dy === 0) return 3; // W
  return null;
}

// ---- a belt's own two ports, and the seam two joined belts share -----------
//
// Phase 74 (LINK-01/02/03/10). A belt is a PORTED NODE in the core from 74-02 on:
// `add_belt` declares exactly two `Port` records, Tail `Role::In` FIRST and Head
// `Role::Out` SECOND, both Mechanical. That order is a CONTRACT the core pins by
// name (`belt_ports_are_ordered_in_before_out_which_is_a_contract_not_a_convention`),
// and the two indices below are that contract read from this side of the wire.
//
// WHY THE FRONTEND HAS TO DERIVE THE SPATIAL HALF AT ALL. The core stores both belt
// ports at cell (0,0) with `Side::default()`, because a belt's endpoint geometry is
// not knowable at mint time (a Wire-minted belt never gets any). The host resolves the
// spatial answer on demand through `belt_end_world`, and D-05 keeps `ports` off
// `BeltView`, so there is nothing on the wire to read. `beltEndPort` below is that
// resolver's twin: it answers with the SAME shape a machine port answers with, so a
// belt end drops into `acceptsDock`, the nub hit set and the dock ranker with no
// second code path anywhere downstream.

/** A belt's Tail port index: `Role::In`, declared FIRST (74-02). */
export const BELT_PORT_TAIL = 0;
/** A belt's Head port index: `Role::Out`, declared SECOND (74-02). */
export const BELT_PORT_HEAD = 1;

/**
 * Which end of the TARGET belt a dock at `end` names - read off the ROLE the
 * direction rule already agreed with, exactly as `command.rs`'s Dock arm reads it:
 * a Head (load) dock targets the partner's admit end (`Role::In` = Tail); a Tail
 * (offload) dock targets its deliver end (`Role::Out` = Head).
 */
export function beltDockPartnerEnd(end: BeltEnd): BeltEnd {
  return end === 'Head' ? 'Tail' : 'Head';
}

/**
 * A belt end's SPATIAL port - the frontend twin of `belt_end_world`
 * (crates/fabrico-core/src/state.rs:1096).
 *
 * `cell` is the end tile's cell and `side` is the end's OUTWARD side, which plays
 * exactly the role a machine port's facing side plays: the direction the dock partner
 * sits in. `index` is the catalog index the `Dock` command carries, `role` is In for a
 * Tail and Out for a Head, and the medium is always Mechanical - a belt is always a
 * mechanical carrier.
 *
 * A SINGLE-TILE belt answers `null`, and that is the host's own answer rather than a
 * convenience: it has an end cell but no inherent direction, so there is no side for
 * the facing rule to judge, and `command.rs` refuses such a target outright
 * (`tside.ok_or(CommandError::InvalidDock)`). Answering with a fabricated side here
 * would make the client rank a target the host cannot accept.
 */
export function beltEndPort(tiles: TileView[], end: BeltEnd): PortView | null {
  if (tiles.length === 0) {
    return null;
  }
  const outward = beltEndOutward(tiles, end);
  if (!outward) {
    return null;
  }
  const side = sideOfUnitDelta(outward);
  if (side === null) {
    return null;
  }
  const [cx, cy] = beltEndCell(tiles, end);
  return {
    index: end === 'Head' ? BELT_PORT_HEAD : BELT_PORT_TAIL,
    cell_x: cx,
    cell_y: cy,
    side,
    role: end === 'Head' ? PORT_ROLE.OUT : PORT_ROLE.IN,
    medium: MEDIUM_MECHANICAL,
  };
}

/**
 * THE DOORSTEP: the floor cell a port feeds, `port cell + unitDelta(port.side)`. For a
 * machine port it is the cell just outside the machine, in front of that port. For a
 * belt Head (through {@link beltEndPort}) it is the cell one past the belt's last tile,
 * along its direction of travel. It is where a belt docked to that port has its end
 * tile, which is the host's adjacency rule (`command.rs` Dock arm, `unit_delta(mside)`).
 *
 * THE ONE DEFINITION, AND EVERY READER READS IT (phase 74.1, CORNER-02). With the Belt
 * tool armed, the press lookup compares the pressed cell against it, the draw is seeded
 * on it, the armed ring and the belt Head's resting ring are centred on it, the release
 * path's In-port facing cell is it, and {@link acceptsDock}'s MACHINE-target adjacency term
 * is it (a BELT target is judged by the one-step rule since plan 74.1-15).
 * "Where you press is where the draw starts" is true by construction only because those
 * readers share this function: two copies of `cell + unitDelta(side)` that agree today
 * and drift later is this repository's named failure class (T-63-14).
 */
export function doorstepCell(port: PortView): [number, number] {
  const [dx, dy] = unitDelta(port.side);
  return [port.cell_x + dx, port.cell_y + dy];
}

/**
 * THE ONE SEAM DEFINITION: given a belt end docked to ANOTHER BELT, where on screen
 * that joint is. `null` for an undocked end, for an end docked to a MACHINE (that is
 * `dockPort`'s question), and for a dock naming a belt this client has never seen.
 *
 * The seam is the MIDPOINT OF THE TWO ABUTTING END TILE CENTRES, which lies exactly on
 * their shared cell edge. Two abutting cells are `CELL` apart, so the point is half a
 * cell outward from either end - but it is computed from BOTH centres rather than from
 * one centre plus an outward step, so a stale frame in which the two ends are not yet
 * abutting degrades to the midpoint of where they are instead of to a confident lie.
 *
 * THREE READERS AND NO FOURTH DERIVATION (74-UI-SPEC 2.5). `belts.ts resolveEndAnchor`
 * draws the collar here, `beltHandlePoints` below puts the grab dot here, and
 * `gestures.ts nubsInRadius` hit-tests belt ends through `beltEndPort` above. This is
 * the frontend twin of LINK-11's Rust resolver and it exists for the same reason: two
 * copies that agree on the first abutting belt pair and drift later is this
 * repository's named historical failure class (T-63-14,
 * `crates/fabrico-command/src/command.rs:737`).
 */
export function beltSeamPoint(
  belts: ReadonlyMap<number, BeltView>,
  belt: BeltView,
  end: BeltEnd,
): { x: number; y: number } | null {
  const atEnd = belt.docks.filter((d) => d.end === end);
  // A FAN-IN TAIL HAS NO SINGLE SEAM, and this is the 74-04 handover landing here.
  // `belt_docks` reports EVERY Tail upstream since LINK-13, so a downstream belt fed by
  // two upstreams carries two Tail docks - and the two joints sit at two different
  // half-cell offsets from the ONE Tail end tile centre. There is no honest single
  // point, so this answers null and the grab dot falls back to the end tile centre,
  // which is where it has always been. A `find`-first here would put the handle on
  // whichever upstream ascending link order happened to reach first, and move it when
  // the user added a second branch. Nothing else is affected: the collar is owned by
  // the upstream HEAD (74-UI-SPEC 2.3), and a Head is a single `(node, port)` with at
  // most one outgoing link, so a Head can never be ambiguous.
  if (atEnd.length !== 1) {
    return null;
  }
  const dock = atEnd[0];
  const other = belts.get(dock.node);
  if (!other || other.id === belt.id) {
    return null;
  }
  if (belt.tiles.length === 0 || other.tiles.length === 0) {
    return null;
  }
  const [ax, ay] = beltEndCell(belt.tiles, end);
  const [bx, by] = beltEndCell(other.tiles, beltDockPartnerEnd(end));
  return {
    x: ((ax + bx) * CELL + CELL) / 2,
    y: ((ay + by) * CELL + CELL) / 2,
  };
}

/**
 * Port transport medium wire bytes (mirror `fabrico_protocol::port_medium`). A
 * belt is ALWAYS a `Mechanical` carrier, so a belt dock is only medium-legal
 * onto a Mechanical port (PORT-08, plan 36-03).
 */
export const MEDIUM_MECHANICAL = 0;
export const MEDIUM_ELECTRICAL = 1;

/**
 * The shared type-compatibility predicate — the TS mirror of
 * `fabrico_command::mediums_compatible` (plan 36-03). Currently exact-match; the
 * SINGLE rule the host applies in BOTH directions — `validate_normalize`'s `Dock`
 * arm for belt->port, and its `DrawWire` arm for wire->port on both of a drawn
 * wire's endpoints (plan 63-02). Keep this the one place the frontend encodes
 * medium compatibility, so the cross-language claim stays checkable against one
 * Rust definition.
 */
export function mediumsCompatible(a: number, b: number): boolean {
  return a === b;
}

/**
 * THE ROLE HALF OF THE DOCK RULE, ON ITS OWN: a HEAD (load) dock targets a `Role::In`;
 * a TAIL (offload) dock targets a `Role::Out` OR the output `Role::Fault` port. Errors
 * flow OUT of a fault port, so a belt may only OFFLOAD from it and never flow in.
 * Mirrors `command.rs`'s `role_ok` in the Dock arm, verbatim.
 *
 * EXTRACTED IN PHASE 74 for the drag-time drop-target rings (74-UI-SPEC 3.1), which
 * read the role rule WITHOUT the geometry so that every end that could accept the
 * dragged end was ringed. Plan 74.1-25 (finding N4-RING) retired that reader: the
 * carrier's end cell does not move during the drag, so a ring at a target it does not
 * touch promised a join the host then refused, and the rings now read the full
 * `acceptsDock` plus the host's occupancy terms (`dropAccepts` in gestures.ts). The
 * function stays the role half of {@link acceptsDock}, its one reader, pinned on its own
 * in ports.test.ts.
 */
export function dockRoleOk(port: PortView, end: BeltEnd): boolean {
  return end === 'Head'
    ? port.role === PORT_ROLE.IN
    : port.role === PORT_ROLE.OUT || port.role === PORT_ROLE.FAULT;
}

/**
 * THE TARGET'S SHAPE, which picks the adjacency rule (plan 74.1-15, gap N4). The host's
 * `Dock` arm splits on exactly this: a MACHINE port keeps the doorstep rule, and a BELT
 * end is accepted from any orthogonal neighbour of its end cell except its own INNER
 * tile (the tile next to the end, inside the target belt). `inner` is `null` for a
 * single-tile belt, which has no inner tile and no direction, and which the host refuses
 * as a target outright (`tside.ok_or(CommandError::InvalidDock)`).
 *
 * REQUIRED at every call, never defaulted: a defaulted shape is how a belt-end hit would
 * quietly be judged by the machine rule again, which is the asymmetry that was rejected.
 */
export type DockTargetShape =
  | { readonly kind: 'machine' }
  | { readonly kind: 'belt'; readonly inner: readonly [number, number] | null };

/** The shape every MACHINE-port caller passes (the doorstep rule). */
export const MACHINE_TARGET: DockTargetShape = { kind: 'machine' };

/**
 * The inner tile of a belt end: the tile next to the end inside the belt (Head inner =
 * tiles[len-2], Tail inner = tiles[1]), or `null` for a single-tile belt. It is the end
 * cell stepped against {@link beltEndOutward}, the cell the host derives the same way.
 */
export function beltEndInner(tiles: TileView[], end: BeltEnd): [number, number] | null {
  if (tiles.length < 2) {
    return null;
  }
  const t = end === 'Head' ? tiles[tiles.length - 2] : tiles[1];
  return [t.cell_x, t.cell_y];
}

/** The target shape of a belt's `end`, for {@link acceptsDock}. */
export function beltTarget(tiles: TileView[], end: BeltEnd): DockTargetShape {
  return { kind: 'belt', inner: beltEndInner(tiles, end) };
}

/**
 * Role + adjacency + facing dock geometry (the pre-medium half of the host
 * predicate). It was split out so a caller could tell a MEDIUM-only reject apart
 * from a plain geometric miss, which is a distinction Phase 64 retired: the
 * client no longer names a reason, so both are emitted and the host answers.
 * Kept split because {@link acceptsDock} reads better as geometry-then-medium.
 * Not exported — {@link acceptsDock} is the only caller.
 */
function dockGeometryOk(
  port: PortView,
  end: BeltEnd,
  endCell: [number, number],
  outward: [number, number] | null,
  target: DockTargetShape,
): boolean {
  if (!dockRoleOk(port, end)) {
    return false;
  }
  if (target.kind === 'machine') {
    // A MACHINE port: the doorstep rule, unchanged.
    const [doorX, doorY] = doorstepCell(port);
    if (doorX !== endCell[0] || doorY !== endCell[1]) {
      return false;
    }
  } else {
    // A BELT end (plan 74.1-15, gap N4), mirroring `command.rs`'s belt branch: a
    // single-tile target is refused; otherwise the carrier end must be ONE orthogonal
    // step from the target end cell and must not be the target's inner tile. Either
    // belt may then turn at the seam.
    if (target.inner === null) {
      return false;
    }
    const step = Math.abs(endCell[0] - port.cell_x) + Math.abs(endCell[1] - port.cell_y);
    if (step !== 1) {
      return false;
    }
    if (endCell[0] === target.inner[0] && endCell[1] === target.inner[1]) {
      return false;
    }
  }
  // FACING, NARROWED WITH THE HOST IN PHASE 74.1 (D-02), ONE TERM FOR BOTH SHAPES. The
  // carrier is refused only when its outward side EQUALS the target side. For a machine
  // that is the geometry where its inner tile would sit on the target's own cell; for a
  // belt target it is the U-turn (two side-by-side belts running opposite ways), which
  // stays refused in both drag directions as plan 74.1-15's stated assumption.
  // This stays a MIRROR: the host is the judge, this only ranks and colours.
  if (outward) {
    const [sx, sy] = unitDelta(port.side);
    if (outward[0] === sx && outward[1] === sy) {
      return false;
    }
  }
  return true;
}

/**
 * The EXACT host dock-accept predicate (command.rs validate arm +
 * `dock_still_reaches` + the PORT-08 MediumMismatch gate, verbatim — host mirror
 * or nothing; an approximation now ranks the wrong nub and paints the wrong
 * colour rather than swallowing a gesture, but it is still wrong):
 *
 *   - role by end: Head -> In (0); Tail -> Out (1) or Fault (2)
 *   - adjacency:   by the TARGET's shape (plan 74.1-15). A machine port:
 *                  `doorstepCell(port) == endCell`. A belt end: `endCell` is one
 *                  orthogonal step from the end cell and is not the target's inner
 *                  tile; a single-tile belt target is refused.
 *   - facing:      when `outward` present, `outward != unitDelta(side)`: refused only
 *                  when the carrier points INTO the target (its inner tile would be the
 *                  target's own cell); a carrier that turns at the doorstep is accepted
 *                  (phase 74.1, D-02, narrowed with `command.rs` in the same plan)
 *   - medium:      the belt is Mechanical, so `mediumsCompatible(port.medium,
 *                  MECHANICAL)` must hold (PORT-08 — a belt onto an Electrical
 *                  wire port is host-rejected as MediumMismatch, plan 36-03).
 *
 * WHAT THIS PREDICATE IS FOR, since Phase 64 (D-07): a RANKER and a colour
 * source, never a gate. It chooses WHICH port a gesture addresses (the nearest
 * accepting nub inside the pointer's hit radius) and whether the nub ring paints
 * accepting; the gesture is then emitted either way. The HOST is the sole judge
 * and its typed refusal is what the user reads. The sentence that stood here
 * before — that a gesture gated on this never emits a command the host would
 * reject — is retired with the gates it described: nothing is gated on it now,
 * and while it was, it disagreed with the host in six documented ways (a
 * predicate cannot see host-only state such as occupancy and catalog rules).
 */
export function acceptsDock(
  port: PortView,
  end: BeltEnd,
  endCell: [number, number],
  outward: [number, number] | null,
  target: DockTargetShape,
): boolean {
  return (
    dockGeometryOk(port, end, endCell, outward, target) &&
    mediumsCompatible(port.medium, MEDIUM_MECHANICAL)
  );
}

/**
 * Port role wire bytes, retained as the names their existing call sites already
 * import (gestures.ts's nub ranking, the wire-target predicate below). They are now
 * ALIASES of {@link PORT_ROLE} rather than a second copy of the same two bytes: one
 * declaration of the keyspace, two spellings of it. New readers should use
 * `PORT_ROLE`, which also carries FAULT.
 */
export const ROLE_IN = PORT_ROLE.IN;
export const ROLE_OUT = PORT_ROLE.OUT;

/**
 * The client's accept predicate for a WIRE's TARGET port - `acceptsDock`'s electrical
 * sibling (plan 66-01, WIRE-02). `acceptsDock` hardcodes
 * `mediumsCompatible(port.medium, MEDIUM_MECHANICAL)` and cannot serve a wire.
 *
 * WHAT THIS PREDICATE IS FOR: a RANKER and a colour source, NEVER a gate. Phase 64
 * (D-07/D-08) removed client-side re-validation before emit, because a locally-swallowed
 * gesture produced no dock, no flash and no log line. This predicate chooses WHICH nub a
 * release addresses (the nearest ACCEPTING hit inside the pointer's hit radius, falling
 * back to the nearest hit of any kind) and whether the target paints accepting. The
 * `DrawWire` is then emitted either way. The HOST is the sole judge and its typed
 * refusal is what the user reads. A future edit that makes emission conditional on this
 * function would move authorisation out of `command.rs` and is the thing this docblock
 * exists to prevent.
 *
 * THE HOST ARM IT MIRRORS is `fabrico-command`'s `validate_normalize` DrawWire arm
 * (`command.rs:1338-1400`), transcribed here step by step as `acceptsDock` transcribes
 * its own:
 *
 *   1. both node handles resolve                            -> `UnknownNode`
 *   2. not a self-loop (`from_id != to_id`)                 -> `IncompatiblePorts`
 *   3. both port indices name a declared port               -> `IncompatiblePorts`
 *   4. `fport.role == Out` AND `tport.role == In`. `Role::Fault` is deliberately NOT
 *      accepted on the source side                          -> `IncompatiblePorts`
 *   5. `mediums_compatible(Electrical, fport.medium)` and the same for `tport` - the
 *      SAME predicate the Dock arm calls                    -> `MediumMismatch`
 *   6. the source port is free: no belt link and no wire already drawn from it
 *                                                           -> `PortOccupied`
 *
 * THERE IS NO SPATIAL CHECK, which is why this has no `dockGeometryOk` equivalent.
 * `add_wire` claims no cells (`state.rs:1318-1330`); adjacency, facing and distance play
 * no part, and a wire may be drawn between any two machines anywhere on the grid. The
 * preview must therefore never paint red for distance or for crossing something.
 *
 * WHAT THIS COVERS OF THE SIX, HONESTLY. Steps 4 and 5, for the TARGET end only, which
 * is all a single `PortView` can answer. Steps 1, 2 and 3 are handle resolution the
 * client cannot repeat. Step 6 - the free-source test - needs the scene's wires rather
 * than a port, and is out of reach until 66-07 folds wire endpoints into
 * `selectedNodePortFlow`. Named rather than silently omitted: an incomplete RANKER ranks
 * a nub the host will refuse, which costs a refusal sentence the user can read, whereas
 * an incomplete GATE would swallow the gesture entirely.
 *
 * `mediumsCompatible` and `MEDIUM_ELECTRICAL` are READ, never re-implemented:
 * `mediums_compatible` is ONE predicate serving both `Dock` and `DrawWire`, and a second
 * copy is how the two accept-envelopes start drifting apart.
 */
export function acceptsWireTarget(port: PortView): boolean {
  return port.role === ROLE_IN && mediumsCompatible(port.medium, MEDIUM_ELECTRICAL);
}

/**
 * All `(node, port)` pairs over `nodes` where {@link acceptsDock} holds for
 * the given belt end — the shared source for auto-dock exactly-one counting
 * (fire only when length === 1) and armed-ring dock candidates. Every `node` here is
 * a MACHINE (`NodeView`; a belt end is never in this set), so each port is judged with
 * {@link MACHINE_TARGET}.
 */
export function dockCandidates(
  nodes: Iterable<NodeView>,
  end: BeltEnd,
  endCell: [number, number],
  outward: [number, number] | null,
): Array<{ node: NodeView; port: PortView }> {
  const out: Array<{ node: NodeView; port: PortView }> = [];
  for (const node of nodes) {
    for (const port of node.ports) {
      if (acceptsDock(port, end, endCell, outward, MACHINE_TARGET)) {
        out.push({ node, port });
      }
    }
  }
  return out;
}

/**
 * Endpoint handle anchors for a belt: a docked end anchors at the resolved nub
 * center ({@link dockPort} + the shared anchor math); an end docked to ANOTHER BELT
 * anchors at the SEAM ({@link beltSeamPoint}); an undocked end - or a dock that fails
 * to resolve (unknown node handle, or the null non-spatial fault case) - anchors at
 * the end tile's center (`cell*CELL + CELL/2`).
 *
 * THE BELT-SEAM ARM IS A POSITION FIX AND NOT A NEW MARK (74-UI-SPEC 1.3). `dockPort`
 * answers `null` for a belt-handled dock, because the target has no `NodeView` and no
 * `ports` on the wire, so a belt-to-belt dock used to fall through to the end tile
 * centre - half a cell away from the collar the belts layer draws. The grab dot a user
 * sees and the point `hitHandle` grabs are then the SAME point, which is the whole
 * claim; the r5 `build` circle itself is shipped and unmoved.
 */
export function beltHandlePoints(
  nodes: ReadonlyMap<number, NodeView>,
  belts: ReadonlyMap<number, BeltView>,
  belt: BeltView,
): { head: { x: number; y: number }; tail: { x: number; y: number } } {
  const endPoint = (end: BeltEnd): { x: number; y: number } => {
    const dock = belt.docks.find((d) => d.end === end);
    if (dock) {
      const seam = beltSeamPoint(belts, belt, end);
      if (seam) {
        return seam;
      }
      const node = nodes.get(dock.node);
      const port = node ? dockPort(node, dock) : null;
      if (port) {
        return nubAnchor(port.cell_x, port.cell_y, port.side);
      }
    }
    const [cx, cy] = beltEndCell(belt.tiles, end);
    return { x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 };
  };
  return { head: endPoint('Head'), tail: endPoint('Tail') };
}

/**
 * Local rotation of a CATALOG port for the anchorless placement ghost ONLY —
 * the TS mirror of the `port_world` closed form
 * (crates/fabrico-core/src/state.rs:765-784): rot&3; r1 -> [h-1-y, x];
 * r2 -> [w-1-x, h-1-y]; r3 -> [y, w-1-x]; side (side+r)&3. PLACED nodes always
 * use host-resolved `ports[]` — never rotate those locally.
 */
export function rotateCatalogPort(
  p: CatalogPortView,
  w: number,
  h: number,
  rot: number,
): { lx: number; ly: number; side: number } {
  const r = rot & 3;
  const { local_x: x, local_y: y } = p;
  const [lx, ly] =
    r === 0 ? [x, y] : r === 1 ? [h - 1 - y, x] : r === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
  return { lx, ly, side: (p.side + r) & 3 };
}

/**
 * Nub hit radius in WORLD px for the given camera scale: `12 / min(1, scale)`.
 * This LOCKS the Open Question 2 zoom policy (D-16 hit-radius discretion): a
 * nub is a >=12 screen-px Fitts target at EVERY zoom — 12 world px at zoom>=1,
 * growing in world units below zoom 1 (48 world px at MIN_ZOOM 0.25), so hit
 * targets never die at low zoom (Pitfall 5).
 */
export function nubHitRadiusWorld(scale: number): number {
  return 12 / Math.min(1, scale);
}

/**
 * Wire-tool nub hit radius in WORLD px: `(MIN_TARGET_PX / 2) / min(1, scale)`.
 *
 * THE RULE, AND BOTH HALVES ARE DERIVED. The canvas equivalent of a 44px minimum
 * EDGE is a 22px RADIUS, because a 22px radius guarantees at least 44px through the
 * centre in EVERY direction; a circle rather than a square because a nub has no
 * preferred approach axis. So the base is `MIN_TARGET_PX / 2` read from the chrome
 * emitter, never a bare 22 written here - a restated 22 is exactly the drift the
 * export exists to prevent, and it would let `--fab-min-target` and this hit test
 * disagree silently. The divisor is the D-16 zoom policy copied verbatim from
 * {@link nubHitRadiusWorld}: it holds the target at a CONSTANT DEVICE size at and
 * below zoom 1 (22 device px radius at every zoom down to MIN_ZOOM 0.25) and lets it
 * grow on screen above zoom 1.
 *
 * WHY A SECOND FUNCTION RATHER THAN WIDENING THE FIRST (plan 66-06, UI-SPEC 6.1).
 * `nubHitRadiusWorld` is shared with the belt dock path, the idle nub hover and both
 * belt port-to-port endpoints. Widening it would silently re-tune the belt dock ranker
 * Phase 64 stabilised, and Phase 67 owns the belt half of `WINDOWS.md` row 113. This
 * radius is scoped to CIRCULAR GRAB TARGETS THAT ARE NOT THE BELT-HANDLE HIT TEST: the
 * ARMED WIRE TOOL's press and release hit tests, and (plan 67-05, CONNECT-02) the
 * stranded-dock reconnect ring, which is the same kind of target and takes the same
 * number by binding this function rather than restating it. `hitHandle`'s own radius is
 * still deliberately untouched - decision D4 and 67-UI-SPEC fence that out of Phase 67.
 * A previous revision of this paragraph said "scoped to the ARMED WIRE TOOL ... and to
 * nothing else", which stopped being true the moment the second caller landed.
 *
 * THE AMBIGUITY IT ADMITS, AND WHERE THAT IS ANSWERED. At 22 world px two Out nubs one
 * cell apart (32 world px) are both in range at their midpoint. `nubsInRadius` is
 * sorted nearest-first, so the resolution is deterministic, and the gesture layer PAINTS
 * the resolved source nub filled - the user sees which port they grabbed before they
 * release. An invisible disambiguation would be a worse defect than the small target.
 */
export function wireNubHitRadiusWorld(scale: number): number {
  return MIN_TARGET_PX / 2 / Math.min(1, scale);
}
