// ConfigPanel.tsx - the selection-reactive machine-config shell (CFG-01/CFG-03).
//
// A docked right-edge `.fab-panel` aside that mounts ONLY while a machine is
// selected (App owns the `selectedNode` gate + remounts on selection change via
// `key={node}`, exactly the HelpPanel/DeleteControl mount discipline) and
// unmounts on deselect - no machine selected renders NO panel (the empty state).
//
// On mount it pulls the machine's CURRENT config over the injected `invoke`
// bridge (`machine_config`), pre-fills the per-kind body, and commits an edit on
// Apply by encoding a `GridCommand::Configure` (encodeGridCommand) through the
// injected `sendInput` seam - the SAME command path DeleteControl/Toolbar use
// (`submit_input`). The panel HOLDS the in-progress buffer + dirty/error state
// (parent-held buffer), so the Factory editor widget can be swapped textarea ->
// CodeMirror in 39-08 with no rebuild (RESEARCH Q1). It is purely presentational:
// told state via the injected bridges, raising intent via the body callbacks; it
// owns no gesture controller and no `window.__fabrico` introspection.
//
// Skin, not skeleton (a hard project requirement): every colour is a `--fab-*`
// token, all text rides the Phase-47 vector typography tokens (Martian Mono body,
// Sono title tier via `.fab-title`), and the fields are the app's first
// `.fab-field` control (added to CHROME_CSS). No hand-authored hex anywhere.
// The panel reads as part of the game HUD.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react';
import {
  encodeBeltRunPace,
  encodeGridCommand,
  MAX_RUN_PACE_BELTS,
  type BeltEnd,
  type BeltView,
  type GridCommand,
  type MachineConfig,
  type PortView,
} from '../protocol/decode.ts';
import { beltBackedUp, type PacketLookup, type PortFlow, type PortLink } from '../protocol/portFlow.ts';
import {
  BELT_PORT_HEAD,
  BELT_PORT_TAIL,
  beltEndPort,
  MEDIUM_MECHANICAL,
  PORT_ROLE,
} from '../protocol/ports.ts';
import type { BeltRunEntry } from '../render/beltRun.ts';
import { machine_kind } from '../protocol/kinds.ts';
import { resizeClaim, type QueuedClaim } from '../input/queuedClaims.ts';
import { KIND_NAMES } from './kindNames.ts';
import { CONFIG_NOT_APPLIED_MARKER, CONFIG_NOT_APPLIED_SUFFIX } from './configCopy.ts';
import { TrashIcon, WarningIcon } from './icons.tsx';
import { PortsSection, ROLE_OUT } from './PortsSection.tsx';
import { portsKeyOf, type PortEditKind } from './portEditLatch.ts';
import { SourceConfigBody } from './SourceConfigBody.tsx';
import { CAMERA_CLUSTER_CLEARANCE } from './CameraCluster.tsx';
import { SinkConfigBody } from './SinkConfigBody.tsx';
import { RouterConfigSection } from './RouterConfigBody.tsx';
import { BeltConfigBody, paceToTicks } from './BeltConfigBody.tsx';
import {
  FactoryConfigBody,
  FACTORY_EDITOR_LABELS,
  type FactoryEditorHandle,
} from './FactoryConfigBody.tsx';
import { WebhookUrlRow } from './WebhookUrlRow.tsx';
import {
  RouteConfigBody,
  routePathDispatchable,
  routePathError,
  type RouteNeighbour,
} from './RouteConfigBody.tsx';
import {
  LABEL_TEXT_FIELD_ID,
  LabelConfigBody,
  labelTextDispatchable,
  labelTextError,
} from './LabelConfigBody.tsx';

/** The injected host bridge (the Tauri `invoke`, or a spy in tests). */
export type ConfigInvoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** The default bridge: the real Tauri `invoke`, dynamically imported so this
 *  module never evaluates the Tauri runtime outside Tauri (the tauriChannel
 *  discipline). Tests inject their own spy and never touch this. */
export const tauriInvoke: ConfigInvoke = (cmd, args) =>
  import('@tauri-apps/api/core').then(({ invoke }) => invoke(cmd, args) as Promise<unknown>);

/** Normalise a rejected-invoke value into a display reason string. */
export function reasonOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Read a node's CURRENT config over the host bridge (null for a machine kind
 *  with no config, e.g. a Tee). Rejection surfaces to the query-failure row. */
export async function loadConfig(node: number, invoke: ConfigInvoke): Promise<MachineConfig | null> {
  return (await invoke('machine_config', { node })) as MachineConfig | null;
}

/** What a commit attempt is able to report, which is LESS than a verdict.
 *
 *  `dispatched` means the `Configure` bytes were handed to the send seam. It is
 *  NOT "the host accepted it", and the field is named this way so it cannot be
 *  read as one. It used to be called `sent`, and `onApply` treated a true `sent`
 *  as success: the panel showed `Applied`, cleared the not-applied marker and
 *  recorded the edit as committed for a table the host had thrown away (65-REVIEW
 *  CR-02).
 *
 *  THE VERDICT IS NOT AVAILABLE HERE, and that is a property of the transport
 *  rather than an omission. `ITransport.sendInput` returns `void` on BOTH wires
 *  ("it carries no verdict and hands back nothing to await", `transport.ts`), and
 *  Phase 64 made it that way deliberately: an `async` Tauri command is dispatched
 *  through a spawned task, so a burst of gestures could reach the host out of
 *  submission order, and a per-sequence pending map would grow without bound
 *  because an ACCEPTED gesture produces no frame at all. Refusals arrive OUT OF
 *  BAND on `onGestureVerdict`, and App routes them to the shared `#fab-refusal`
 *  surface, which is where the REASON belongs and the only place it is stated.
 *
 *  So this function reports what it did, and {@link configApplied} is what
 *  establishes, by observation rather than by assumption, whether it worked. */
export interface CommitAttempt {
  /** The `Configure` bytes reached `sendInput`. Says nothing about the host. */
  dispatched: boolean;
  /** The Factory JS pre-check reason when nothing was dispatched, else null. */
  error: string | null;
}

/**
 * Can a run-pace frame for this config and this run be ACCEPTED by the host?
 *
 * True for every non-Belt config: they take the `Configure` path and this says
 * nothing about them. For a Belt it answers the two shapes `apply_run_pace`
 * refuses as `CommandError::Malformed`, both of which the client already knows
 * about before it spends a gesture (68-REVIEW WR-03):
 *
 *  - **an EMPTY run.** `beltRun` returns `[]` when the clicked belt is no longer
 *    in the scene - a transient its own docblock names - and App passes `NO_RUN`.
 *    The Belt branch ignores `node` entirely, so without this guard Apply emits a
 *    ZERO-belt frame and the user reads "The host could not carry out that
 *    gesture." for pressing Apply on a panel that is still showing a config.
 *  - **an OVER-CAP run.** `beltRun` is bounded only by `scene.belts.size`, so a
 *    contiguous chain past {@link MAX_RUN_PACE_BELTS} is buildable, if tedious.
 *    Same causeless sentence, on a gesture that looked ordinary.
 *
 * Neither is data loss - the never-mutates-on-error contract holds on both paths
 * and `configAppliedToRun` correctly claims nothing for an empty run - but the
 * phase's standing rule is that a refusal's sentence must be TRUE OF ITS CAUSE in
 * a useful way, and the `Malformed` sentence ("the host could not read that gesture"
 * since plan 88-02) is not that for either. So the control states the constraint (Apply is disabled) instead of the
 * refusal region stating it after the fact.
 *
 * THE CAP IS NOT TRANSCRIBED. {@link MAX_RUN_PACE_BELTS} is declared once in
 * `protocol/decode.ts` and `crates/fabrico-host/tests/pace_scale_pin.rs` parses
 * that declaration and pins it to the host's constant, so a client guard that
 * drifted below the host's cap (silently refusing runs the host would take) or
 * above it (dispatching frames the host refuses) is a RED, not a surprise.
 */
/**
 * LINK-09: the belt panel's TWO port rows, synthesised frontend-side from the
 * selected `BeltView` (74-UI-SPEC 4.1).
 *
 * WHY THE FRONTEND SYNTHESISES THEM AT ALL. A belt is a ported node in the core
 * from 74-02 on, but D-05 keeps `ports` OFF `BeltView`, so there is nothing on the
 * wire for the panel to read. `ports.ts` already holds the frontend's half of that
 * contract - `BELT_PORT_TAIL` / `BELT_PORT_HEAD` and `beltEndPort` - and this is
 * the panel's reader of it, not a second derivation of it.
 *
 * ALWAYS TWO ROWS, NEVER A `None` ROW. D-06 gives every belt both `Port` records,
 * geometry-empty (Wire-minted) ones included, so `PortsSection`'s empty-group path
 * is unreachable on a belt by CONSTRUCTION rather than by luck. `beltEndPort`
 * answers `null` for exactly the belts that have no resolvable outward side (empty
 * or single-tile geometry), which is the honest answer to "where on screen is this
 * end" and the WRONG answer to "does this belt have this port". So an unresolvable
 * end still gets its row, with a zeroed spatial half: the panel reads `index`,
 * `role` and `medium` and nothing else, and a fabricated cell/side would be a
 * confident lie in the one field a future reader might trust.
 *
 * IN FIRST, AND THAT IS A CONTRACT. `command.rs`'s port-catalog arm warns that an
 * `Out` declared before an `In` mis-keys every Head dock into the wrong inbox. A
 * panel listing them the other way would teach the user a false model of the same
 * order, so the row order mirrors the core's rather than choosing its own.
 *
 * WHICH LINK A ROW OFFERS TO DISCONNECT, and where it deliberately offers none:
 *
 *   - The `Outputs` row (Head) carries the link whenever this belt's Head docks
 *     anywhere. The carrier is THIS belt, so the `Unlink`'s target side is the
 *     neighbour, and that neighbour's handle and port ride on the link as its
 *     `target` - read verbatim off the dock record, which for a Head dock is a raw
 *     catalog index in the target's own keyspace (`belt_docks`). It works whether
 *     the neighbour is another belt or a machine.
 *   - The `Inputs` row (Tail) carries the link only when EXACTLY ONE upstream docks
 *     there AND that upstream is a BELT. Then the carrier is the upstream belt and
 *     the target side is this belt's own admit port, so no `target` rides: the
 *     shipped `subject + port.index` encode already names it, and both sides of the
 *     one link therefore emit the IDENTICAL `Unlink`.
 *   - It carries NO link for a MACHINE upstream. The target side would be that
 *     machine's `Out`, whose spatial index is not derivable from the Out ROUTING
 *     key a Tail dock records without a reverse map - the Pitfall-6 keyspace bug
 *     that would typecheck. Nothing is unreachable: that link's Disconnect is on
 *     the machine's own port row, where it has always been.
 *   - It carries NO link for a FAN-IN. 74-04 made `belt_docks` report EVERY
 *     upstream, so a belt fed by two carries two Tail docks and one row cannot
 *     honestly name one of them. A `find`-first would destroy a link the user did
 *     not point at (T-74-33), which is the whole threat this encode exists to
 *     close. `beltSeamPoint` fails closed at the identical ambiguity for the
 *     identical reason. Each upstream's own `Outputs` row stays unambiguous, so the
 *     verb is still reachable for every branch.
 *
 * In all three of those cases the row still RENDERS and still reads `Input - Item`;
 * `disconnectControl` simply returns `undefined` for a link it cannot resolve,
 * which is the documented fail-closed degrade in `PortFlow.link`'s own docblock.
 *
 * `docked` is whether that end has a dock; `carrying` and `backedUp` describe the
 * belt whose items CROSS that seam (phase 91, CHROME-13: the state words of
 * `selectedNodePortFlow`, read by `beltBackedUp`), which is the belt a machine's own
 * port row reads for the same seam, so the two panels never disagree (phase 91 review
 * WR-B-07):
 *   - the `Outputs` row (Head) is the selected belt's own state, whatever it docks
 *     into: its items are the ones leaving, and `beltBackedUp` already judges the
 *     machine or belt at its head;
 *   - the `Inputs` row (Tail) is each upstream BELT's state, and the selected belt's
 *     own state for a MACHINE upstream (that machine's Out row reads this belt).
 * Until the review fix a machine neighbour gave presence only, so a belt packed against
 * a jammed machine read `idle` on both rows while the machine said `backed up` (the
 * 91-11 walk, `91-EVIDENCE.md` `### Item 2`), and a joined pair described each other.
 *
 * @param belt  The selected belt's live `BeltView`.
 * @param scene The packet's belts and machines by handle (`SceneState` at the call
 *              site), for a neighbour's state and for telling a belt neighbour from
 *              a machine one. Read by handle only - no scan.
 */
export function beltPortRows(
  belt: BeltView,
  scene: PacketLookup,
): { ports: PortView[]; flow: Map<number, PortFlow> } {
  const belts = scene.belts;
  const rowFor = (end: BeltEnd): PortView =>
    beltEndPort(belt.tiles, end) ?? {
      index: end === 'Head' ? BELT_PORT_HEAD : BELT_PORT_TAIL,
      cell_x: 0,
      cell_y: 0,
      side: 0,
      role: end === 'Head' ? PORT_ROLE.OUT : PORT_ROLE.IN,
      medium: MEDIUM_MECHANICAL,
    };

  const tailPort = rowFor('Tail');
  const headPort = rowFor('Head');
  /** A belt's state words: does it carry items, and can its head item not leave. */
  const stateOf = (b: BeltView): { carrying: boolean; backedUp: boolean } => ({
    carrying: b.items.length > 0,
    backedUp: beltBackedUp(b, scene),
  });
  const own = stateOf(belt);
  /** The belt crossing the seam with the node at the Tail end: that belt, or this one. */
  const feeding = (id: number): { carrying: boolean; backedUp: boolean } => {
    const upstream = belts.get(id);
    return upstream === undefined ? own : stateOf(upstream);
  };

  const tailDocks = belt.docks.filter((d) => d.end === 'Tail');
  const headDocks = belt.docks.filter((d) => d.end === 'Head');

  const tail: PortFlow = {
    docked: tailDocks.length > 0,
    carrying: tailDocks.some((d) => feeding(d.node).carrying),
    backedUp: tailDocks.some((d) => feeding(d.node).backedUp),
  };
  // ONE upstream, and it is a BELT. See the docblock for why the machine case and
  // the fan-in case both fail closed here rather than guessing.
  //
  // NO SELF-DOCK GUARD, and its absence is measured rather than overlooked. A
  // one-belt RING (a belt's Head into its own Tail) is representable in a save
  // - `beltRun.ts`'s fact 3 - and it resolves CORRECTLY through this ordinary
  // path: the carrier is that belt, the target side is that belt, and both rows
  // emit the identical `Unlink`. A `!== belt.id` term was written here first and
  // deleted after mutation testing could not produce a case that needed it; dead
  // code no mutation can kill is exactly the shape this phase keeps finding.
  if (tailDocks.length === 1 && belts.has(tailDocks[0].node)) {
    tail.link = { kind: 'belt', belt: tailDocks[0].node, end: 'Head' };
  }

  const head: PortFlow = {
    docked: headDocks.length > 0,
    carrying: headDocks.length > 0 && own.carrying,
    backedUp: headDocks.length > 0 && own.backedUp,
  };
  // A `(node, port)` has at most ONE outgoing link, so a Head is never ambiguous
  // and this is a totality guard rather than a choice.
  if (headDocks.length === 1) {
    head.link = {
      kind: 'belt',
      belt: belt.id,
      end: 'Head',
      target: { node: headDocks[0].node, port: headDocks[0].port },
    };
  }

  return {
    ports: [tailPort, headPort],
    flow: new Map([
      [tailPort.index, tail],
      [headPort.index, head],
    ]),
  };
}

/**
 * CONNECT-01 / LINK-09: the ONE command a Disconnect press becomes.
 *
 * Extracted from `onDisconnect` below so the encode has a seam a unit case can
 * read: which four fields the press carries is the whole of T-74-33, and a spy on
 * `sendInput` proves only that SOMETHING was sent.
 *
 * @param subject The panel's own selected handle - the node or belt whose panel
 *                the row is in.
 * @param port    The row's port. Its `index` IS the spatial catalog index, used
 *                verbatim whenever the subject is the link's target side.
 * @param link    The resolved link the row carries.
 */
export function disconnectCommand(subject: number, port: PortView, link: PortLink): GridCommand {
  if (link.kind === 'wire') {
    return { kind: 'Delete', node: link.wire };
  }
  return {
    kind: 'Unlink',
    belt: link.belt,
    end: link.end,
    // 74-UI-SPEC 4.3: `node` names the LINK'S TARGET SIDE, never the panel's own
    // subject. The two coincide on every machine row and on a belt's `Inputs` row,
    // which is why closing over the subject was right until a belt could be the
    // subject; on a belt's `Outputs` row the subject is the CARRIER and the target
    // is the neighbour, which rides on the link (see `PortLink.target`).
    node: link.target?.node ?? subject,
    // The SPATIAL CATALOG index verbatim - the HOST owns the Out-routing-key /
    // FAULT_PORT translation at freeze time (D-11), the same discipline the
    // belt-handle Dock release states at `gestures.ts`. `port.index` is the row's
    // own key, already resolved through `dockPort`; a TS-side reverse map here
    // would be the Pitfall-6 keyspace bug, and it would TYPECHECK. Where the target
    // is a DIFFERENT node the number is not this row's to derive at all, so it is
    // read off the dock record that carries it.
    port: link.target?.port ?? port.index,
  };
}

export function beltRunDispatchable(
  config: MachineConfig | null,
  run: readonly BeltRunEntry[],
): boolean {
  if (config === null || config.kind !== 'Belt') return true;
  return run.length > 0 && run.length <= MAX_RUN_PACE_BELTS;
}

/** Commit a config edit. For a Factory it FIRST gates on `validate_factory_js`
 *  (the JS pre-check): on Err the Configure is NOT dispatched and the reason is
 *  returned; on Ok (or any non-Factory kind) it encodes a `GridCommand::Configure`
 *  and sends it through `sendInput` (the certified edit-log). It serialises
 *  EXACTLY the config it is given, so a discarded dirty buffer can never reach the
 *  log (the dirty-selection-change backstop rests on this).
 *
 *  See {@link CommitAttempt} for why the returned value is not a verdict.
 *
 *  A LABEL'S NEW SIZE IS CLAIMED (phase 88, plan 88-07, BELT-06, D-09). When `deps.labelBox`
 *  names the label's box as the scene shows it, its Configure goes out with a `resizeClaim`:
 *  the new box minus the label's own cells, so until the host answers it the one occupancy
 *  read counts those cells as taken (a Place ghost over them is red). Built here, from the
 *  typed config still in hand, never from the encoded bytes. */
export async function commitConfig(
  node: number,
  config: MachineConfig,
  deps: {
    invoke: ConfigInvoke;
    sendInput: (bytes: Uint8Array, opts?: { claim?: QueuedClaim }) => void;
    run: readonly BeltRunEntry[];
    labelBox?: { id: number; cx: number; cy: number; w: number; h: number } | null;
  },
): Promise<CommitAttempt> {
  if (config.kind === 'Factory') {
    try {
      await deps.invoke('validate_factory_js', { source: config.source });
    } catch (err) {
      return { dispatched: false, error: reasonOf(err) };
    }
  }
  // BELT-01/BELT-02: a belt commits ONE run-pace frame naming EVERY belt in the
  // run, never N `Configure` frames (68-UI-SPEC FINDING 2, D-68-16).
  //
  // THE N-FRAME SHAPE IS THE DEFECT, not a slower spelling of the same thing.
  // The host mints a FRESH action id per frame
  // (`input_apply.rs` -> `Host::enqueue_edit_with_new_action`, whose own comment
  // reads "one undo step per normal gesture"), so N frames are N `Ctrl+Z` steps
  // for one Apply - and every existing test in the tree stays green while that
  // happens, because a one-belt run cannot tell the two apart. One frame, one
  // `enqueue_action_group`, one action id, one undo step.
  if (config.kind === 'Belt') {
    // The two shapes the host refuses as Malformed, and the client already knows
    // both - see `beltRunDispatchable`. Dispatching them spends a gesture on a
    // sentence that names no cause. `dispatched: false` with a null error is the
    // honest report: nothing reached the send seam and there is no reason to
    // render, because the panel's Apply is disabled in exactly these states and
    // the user did not just do something that failed.
    if (!beltRunDispatchable(config, deps.run)) {
      return { dispatched: false, error: null };
    }
    deps.sendInput(
      encodeBeltRunPace(
        deps.run.map((belt) => belt.id),
        config.ticks_per_slot,
      ),
    );
    return { dispatched: true, error: null };
  }
  const box = config.kind === 'Label' ? (deps.labelBox ?? null) : null;
  if (config.kind === 'Label' && box !== null && box.id === node) {
    deps.sendInput(encodeGridCommand({ kind: 'Configure', node, config }), {
      claim: resizeClaim(box, config.w, config.h),
    });
    return { dispatched: true, error: null };
  }
  deps.sendInput(encodeGridCommand({ kind: 'Configure', node, config }));
  return { dispatched: true, error: null };
}

/**
 * Does the host's own read-back prove the `Configure` we dispatched was applied?
 *
 * This is the panel's ONLY honest route to "Applied", and it is an OBSERVATION
 * rather than an inference: `machine_config` answers out of the folded core
 * state, so a reply that encodes to the bytes we sent means the core is running
 * exactly this config. A refused `Configure` writes no record and leaves the core
 * byte-identical (`command.rs`), so the read-back keeps answering with the OLD
 * table and this stays false however many times it is asked.
 *
 * # Why bytes and not a deep object compare
 * The two sides come from different places: `sent` was built in this panel's
 * buffer, `readBack` was deserialised out of the host's `ConfigView` JSON. Their
 * key ORDER is not guaranteed to agree, so `JSON.stringify` equality would go
 * false on a config that is identical. Encoding both through the app's own
 * `encodeGridCommand` compares the only representation that actually matters:
 * the bytes the certified edit-log would carry. It is also the exact encoder the
 * dispatch used, so the comparison cannot drift away from what was sent.
 *
 * # What FALSE means, and what it does not
 * False means "not observed applied", which covers three different worlds the
 * panel cannot tell apart and must not guess between: the host refused it; the
 * host has not folded it YET (a queued gesture folds on a tick, and a PAUSED sim
 * does not tick); or the query itself failed. That is the same
 * not-folded-yet-versus-rejected ambiguity the port-edit latch refuses to guess
 * on (`ConfigPanel.tsx`, the add-output docblock). So false claims NOTHING: the
 * buffer stays dirty and uncommitted, Apply and Revert stay live, and the panel
 * renders no reason. If there IS a reason, it is already on `#fab-refusal`.
 */
export function configApplied(
  node: number,
  sent: MachineConfig,
  readBack: MachineConfig | null,
): boolean {
  if (readBack === null) return false;
  try {
    const want = encodeGridCommand({ kind: 'Configure', node, config: sent });
    const got = encodeGridCommand({ kind: 'Configure', node, config: readBack });
    return want.length === got.length && want.every((byte, i) => byte === got[i]);
  } catch {
    // An un-encodable read-back (a config variant this panel cannot commit) is
    // not evidence of anything. Claim nothing.
    return false;
  }
}

/**
 * Does the evidence prove the Apply landed on EVERY belt in the run?
 *
 * {@link configApplied} compares the sent config against a read-back for ONE
 * node. For a run of N that proves nothing at all about the other N-1: a fan-out
 * that wrote the clicked belt and dropped the rest would answer yes, show
 * `Applied`, and pass every test in this file that only exercises a one-belt run
 * (a one-belt board cannot tell the two shapes apart).
 *
 * **So for a Belt selection `applied` is true only when EVERY belt in the run
 * READS the committed pace.** That is a STRONGER observation than any other kind
 * gets, and it can fail - which is the point. It also needs no extra query: the
 * pace for every belt in the run is already on screen, arriving in the render
 * packet and carried on `BeltRunEntry.ticksPerSlot`, which is the same prop the
 * Mixed detection reads.
 *
 * DO NOT SIMPLIFY THIS BACK TO THE ONE-NODE COMPARISON. It looks redundant beside
 * `configApplied` and it is not: the read-back covers the clicked belt through the
 * certified config path, and the run check covers the other N-1 through the
 * packet. Reverting it is mutation-proved in `BeltConfigBody.test.tsx`.
 *
 * An EMPTY run claims nothing, for the {@link configApplied} reason: false means
 * "not observed applied", never "refused".
 */
export function configAppliedToRun(
  node: number,
  sent: MachineConfig,
  readBack: MachineConfig | null,
  run: readonly BeltRunEntry[],
): boolean {
  if (!configApplied(node, sent, readBack)) return false;
  if (sent.kind !== 'Belt') return true;
  if (run.length === 0) return false;
  return run.every((belt) => belt.ticksPerSlot === sent.ticks_per_slot);
}

/** How many times an Apply asks the host whether it holds the config that was
 *  just dispatched, and how long it waits between asks.
 *
 *  Exported so `e2e/router-panel.spec.ts` can wait out the whole window rather
 *  than restating a literal that would drift. The budget is a COURTESY, not a
 *  verdict: when it runs out the panel simply stops asking and goes on claiming
 *  nothing. At 60 ticks per second an accepted `Configure` folds within a tick,
 *  so this window is generous by orders of magnitude for a running sim, and a
 *  paused one is expected to run it out (the config genuinely has not been
 *  applied yet, and will be on resume). */
export const APPLY_CONFIRM_ATTEMPTS = 8;
export const APPLY_CONFIRM_INTERVAL_MS = 120;

// The heading rides the shared Sono title tier (`.fab-title` supplies family/
// uppercase/weight/tracking); the inline style keeps only size + colour + rhythm.
const HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 'var(--fab-font-size-hero)',
  color: 'var(--fab-ink)',
  lineHeight: 1.2,
};
/** The Route inspector's note under its POST URL (phase 91, D-12, CHROME-13). */
export const ROUTE_POST_NOTE = 'POST a JSON body to call its Handler.';

const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};
const HEADING_ID = 'fab-config-heading';

/** Core `Side` byte for East (N=0, E=1, S=2, W=3 - state.rs:706-719).
 *
 *  WR-04: this is what EVERY `AddPort` carries, unconditionally. The byte is
 *  SHAPE-ONLY - the fold runs `reseat_ports`, which rewrites `side` and
 *  `local_offset` for the whole port list and seats every Out on the East column
 *  regardless (state.rs:1024-1028) - so nothing downstream reads what we send.
 *
 *  It used to be `lastOut?.side ?? SIDE_EAST`, under a comment claiming the last
 *  Out's side "is already East on every seated machine". That claim is false.
 *  `PortView.side` is the WORLD side AFTER rotation: `render_packet.rs:462-472`
 *  fills it from `port_world(cell, w, h, fp.rot, port)`, so a Factory at rot 1
 *  reports its Out on South, rot 2 on West, and so on. Nothing broke, because the
 *  fold overrides it - but `command.rs:812` freezes
 *  `Port { side: Side::from(side), .. }` into the certified `EditOp::AddPort`
 *  that lands in the APPEND-ONLY log. The persisted command therefore carried a
 *  byte that depended on the machine's rotation at click time, justified by a
 *  comment saying it could not. A core that ever stopped overriding `side` on add
 *  would turn that into a real placement bug with a stale rationale sitting
 *  directly above it. A constant cannot drift. */
const SIDE_EAST = 1;

/** The inline destructive error row (WarningIcon + word - colour is never the only
 *  cue, the StatusReadout SAFE-01 rule). Shared by the Factory invalid-JS state and
 *  the machine_config/webhook_url query-failure backstop. */
function errorRow(message: string): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--fab-space-xs)',
        color: 'var(--fab-destructive)',
        fontFamily: 'var(--fab-font)',
        fontSize: 'var(--fab-font-size-base)',
        lineHeight: 1,
      }}
    >
      <WarningIcon />
      <span style={{ color: 'var(--fab-destructive)' }}>{message}</span>
    </div>
  );
}

export interface ConfigPanelViewProps {
  /** The machine-kind byte for the heading (KIND_NAMES). */
  kind: number;
  /** The selected node handle (forwarded to the Source body / WebhookUrlRow). */
  node: number;
  /** True while the machine_config round-trip is in flight. */
  loading: boolean;
  /** The current in-progress config buffer (null while loading / unconfigurable). */
  config: MachineConfig | null;
  /** True once the buffer diverges from the committed config. */
  dirty: boolean;
  /** A pre-formatted destructive-row message, or null. */
  error: string | null;
  /** True briefly after an Apply the HOST WAS OBSERVED TO HAVE TAKEN (the
   *  transient "Applied" readout). Never true merely because bytes were sent -
   *  see {@link configApplied} for why the difference is the whole of 65-REVIEW
   *  CR-02. */
  applied: boolean;
  /** PANEL-02: the selected node's LIVE render-packet ports (App polls them off
   *  `sceneState.nodes`). NOT derived from `config` - a ConfigView carries no
   *  ports, and the port-only kinds have a null config entirely. */
  ports: PortView[];
  /** 74.1-19: the host would refuse one more output on this machine because a belt
   *  is in the way (see `PortsSectionProps.addBlockedByBelt`). */
  addBlockedByBelt: boolean;
  /** SERVE-05 (72-13): the COMMITTED config, threaded for exactly one purpose -
   *  re-fetching the POST URL row when the host has folded a new Route path.
   *
   *  IT IS DELIBERATELY NOT `config`. `config` is the BUFFER, which moves on every
   *  keystroke; keying the URL fetch on it would re-query the host per character AND
   *  would make the row briefly show a URL for a path the host has not folded, which
   *  is the previewed-URL-with-a-Copy-button failure the row's own comment rules out.
   *  Optional so every existing caller and every unit case stays untouched. */
  committed?: MachineConfig | null;
  /** PANEL-04: per-port live `{docked,count}` keyed by port index, poll-derived
   *  alongside `ports`. REQUIRED (WR-01): it is the remove gate's dock-presence
   *  input, and an absent map must never be readable as "nothing is docked".
   *  A caller with no flow to offer passes an EMPTY map deliberately. */
  flow: Map<number, PortFlow>;
  /** BELT-01: the belt handles THIS Apply writes to - the run the selected belt
   *  belongs to, in flow order. Read by the Belt arm and by nothing else.
   *
   *  REQUIRED, and for the reason `flow` above is (WR-01, restated at
   *  `PortsSection.tsx:320-330`): making it non-optional "is what stops a caller
   *  reaching the unsafe default at all". The unsafe default here is unusually
   *  bad. An absent `run` would most naturally be read as a run of ONE - the
   *  clicked belt - and a run of one is EXACTLY the wrong answer this phase can
   *  produce: it silently narrows a whole-run pace edit to a single belt while
   *  every test in the tree stays green, because a one-belt board cannot tell the
   *  two apart. A caller with a genuinely single belt passes `[thatBelt]`
   *  deliberately.
   *
   *  Plan 68-05 owns `beltRun.ts`, the scene traversal that fills this with the
   *  contiguous chain, and every entry carries that belt's OWN live pace: the
   *  Mixed detection and the whole-run applied observation (68-UI-SPEC 8.1) both
   *  read the paces, and neither may re-query for them. */
  run: readonly BeltRunEntry[];
  /** SERVE-05: the OTHER Routes on the board, each with its COMMITTED path and the
   *  cell that names it. Threaded from App's poll exactly as `ports`, `flow` and
   *  `run` are, because the panel owns no scene access of its own.
   *
   *  REQUIRED, for the reason `flow` and `run` are (WR-01, restated verbatim at
   *  `PortsSection.tsx:320-330`): making it non-optional "is what stops a caller
   *  reaching the unsafe default at all". The unsafe default here is an EMPTY list,
   *  which reads as "no other Route claims this path" - so a forgotten prop turns
   *  the duplicate gate off silently and the user meets the host's typed refusal
   *  after the press instead of the panel's sentence before it. A caller with
   *  genuinely no neighbours passes `NO_ROUTES` deliberately.
   *
   *  It carries COMMITTED paths only. A neighbour's in-progress buffer is not a
   *  claim on an address: nothing is reserved until Apply. */
  otherRoutes: readonly RouteNeighbour[];
  /** PANEL-03: raise "add an output" (the stateful shell encodes the AddPort). */
  onAddOutput?: () => void;
  /** PANEL-03: raise "remove the output at this PACKET port index". */
  onRemoveOutput?: (index: number) => void;
  /** CONNECT-01: raise "disconnect this port's link" (the stateful shell encodes
   *  the command - which verb it is depends on the link's medium, D1). */
  onDisconnect?: (port: PortView, link: PortLink) => void;
  /** CR-01: a port edit is IN FLIGHT - the packet indices currently on screen are
   *  known-stale, so every add/remove control must read as busy until the poll
   *  delivers a fresh port topology. App owns the latch this reflects.
   *
   *  WR-03: REQUIRED, not `?: boolean` with a `= false` default. That shape is
   *  the one WR-01 (iteration 1) made illegal for `flow`, for the reason restated
   *  verbatim in `PortsSection.tsx:320-330`: making it non-optional "is what stops
   *  a caller reaching the unsafe default at all". The default here is "no edit in
   *  flight", i.e. the entire Outputs edit group renders LIVE - so a new mount
   *  point, a future split of this panel, or a test harness that forgets the prop
   *  gets un-latched destructive controls, and TypeScript says nothing. `playing`
   *  and `flow` on this same interface were already required; the one prop
   *  guarding a destructive action was the one left optional. */
  portEditPending: boolean;
  /** WR-01: that in-flight edit has now gone unfolded for
   *  `PORT_EDIT_STALL_TICKS` of SIMULATED time, so the panel swaps the "waiting"
   *  status for an explicit `[Try again]` escape. Never a verdict, and never zero
   *  while the sim is paused (the tick does not advance) - see portEditLatch.ts. */
  portEditStalled: boolean;
  /** 74.1-19: the pending status line may show (the grace has passed, or the sim is
   *  paused); see `PortsSectionProps.portEditPendingVisible`. */
  portEditPendingVisible: boolean;
  /** WR-01: clear the in-flight latch for this node. The USER's explicit act - it
   *  re-sends nothing and claims nothing about what the host did. */
  onPortEditReset: (node: number) => void;
  /** CR-01: whether the sim is RUNNING, used for ONE thing - wording the pending
   *  status. A paused/draining host holds gestures indefinitely
   *  (`SimLoop::step`), so "waiting for the host" and "this applies when
   *  you resume" are different truths and the panel should tell the right one.
   *  Required (not optional-defaulted) so a caller has to supply it deliberately;
   *  it never gates a send, so a stale optimistic value can only mis-word copy. */
  playing: boolean;
  /** BELT-04: the belt pace field's RAW typed text, or null while the field
   *  mirrors the buffer. It cannot live in `config`, which carries the wire's
   *  `ticks_per_slot` and has no room for the keystrokes that produced it - and
   *  the two are genuinely different: `null` means "nothing typed", `''` means
   *  "the user cleared the field", which resolves to zero. */
  beltTyped: string | null;
  /** BELT-04: a pace SEGMENT was pressed. Sets the buffer and clears the typed
   *  text, because the segment is now the answer and a stale figure beside it
   *  would be a second one. */
  onBeltPace: (ticksPerSlot: number) => void;
  /** BELT-04: raw keystrokes in the pace field, UNSANITIZED and UNCLAMPED - see
   *  `BeltConfigBody`'s `field` helper for the three measured reasons and for the
   *  disclosure rule that replaces the clamp. */
  onBeltTyped: (text: string) => void;
  /** Review WR-B-01: the timer Every field's raw typed text, or null while it shows the buffer
   *  (`SourceConfigBody`'s `typed`). Optional so a direct test caller can leave it out. */
  timerTyped?: string | null;
  onTimerTyped?: (typed: string | null) => void;
  /** Review WR-B-01: the Router At byte fields' raw typed text by rule index
   *  (`RouterConfigBody`'s `offsetTyped`). */
  offsetTyped?: ReadonlyMap<number, string>;
  onOffsetTyped?: (next: ReadonlyMap<number, string>) => void;
  onFieldChange: (config: MachineConfig) => void;
  onApply: () => void;
  onRevert: () => void;
  /** The host bridge, forwarded to WebhookUrlRow. */
  invoke: ConfigInvoke;
  /** The imperative handle slot for the Factory CodeMirror editor - the parent
   *  reads the exact bytes on Apply and pushes committed source on Revert. */
  factoryEditorRef: RefObject<FactoryEditorHandle | null>;
  /** A USER edit in the Factory editor → the parent's dirty flag (the uncontrolled
   *  editor holds its own buffer, so dirty is signalled, not state-derived). */
  onFactoryDirty: () => void;
  /** BELT-02 (phase 89, D-07, UI-SPEC 2.1): delete this belt. App passes it to the belt
   *  panel only, routed through the gesture layer's one guarded `requestBeltDelete` and only
   *  while the panel's belt is the selected one. Optional: no machine panel offers it. */
  onDeleteBelt?: () => void;
  /** Phase 91, plan 91-09 (CHROME-07, UI-SPEC 2.3): the Help panel holds the top-right slot
   *  this panel shares, so the panel is hidden by an inline `display: none` and stays mounted:
   *  its buffer, its not-applied marker, an `Applied` or error row and the selection survive,
   *  and it comes back exactly as it was. NOT the `hidden` attribute: the inline `display:
   *  flex` would beat the UA `[hidden]` rule and the panel would stay on screen. A hidden
   *  panel reports `offsetWidth` 0, so the Legend band and the status strip skip it. */
  hidden?: boolean;
}

/** The pure presentational view - told all state via props (no hooks), so it is
 *  unit-testable in the repo's node env by direct invocation (the DeleteControl
 *  discipline). The hook wrapper `ConfigPanel` below owns the state machine. */
export function ConfigPanelView({
  kind,
  node,
  loading,
  config,
  dirty,
  error,
  applied,
  ports,
  addBlockedByBelt,
  committed,
  flow,
  run,
  otherRoutes,
  onAddOutput,
  onRemoveOutput,
  onDisconnect,
  portEditPending,
  portEditStalled,
  portEditPendingVisible,
  onPortEditReset,
  playing,
  beltTyped,
  onBeltPace,
  onBeltTyped,
  timerTyped = null,
  onTimerTyped,
  offsetTyped,
  onOffsetTyped,
  onFieldChange,
  onApply,
  onRevert,
  invoke,
  factoryEditorRef,
  onFactoryDirty,
  onDeleteBelt,
  hidden = false,
}: ConfigPanelViewProps): JSX.Element {
  // ONE error row, and the HOST's sentence wins when there is one. `error` is a
  // refusal that already HAPPENED; the client gate is a statement about a buffer that
  // has not been sent, so showing the gate's sentence over a live refusal would
  // replace what the host said with what the panel guessed - and the host is the
  // authority (D-13).
  //
  // DERIVED at render from the buffer and the board, never held in state. Held state
  // would need clearing on every keystroke, every Revert and every neighbour edit,
  // and a stale destructive row is worse than none.
  //
  // 76-02: a label text over the byte bound is the third client sentence, in the same
  // derived-at-render shape (76-UI-SPEC 5.5).
  const shownError = error ?? routePathError(config, otherRoutes) ?? labelTextError(config);
  return (
    <aside
      // LAYOUT CONTRACT (phase 91, plan 91-09, CHROME-07, D-06, UI-SPEC 2.1): the panel docks
      // BELOW the Toolbar at the shared dock offset the Help panel uses (`HelpPanel.tsx`), keeps
      // its right edge and width, and has NO `bottom`: it is as tall as its content, up to a
      // `maxHeight` that ends its border box 24 px above the window's bottom edge. Past that the
      // scroll column below scrolls and the sticky Apply / Revert row stays in view.
      //
      // It used to be `top:lg / right:lg / bottom:lg` (52 CR-01) at the Toolbar's own zIndex and
      // mounted after it, so with any machine selected it painted over the Toolbar's right end
      // (Help, New, Save, Load and Examples at 1024 wide, Names too at 1280; 91-MEASURE.md) and
      // ran the full window height whatever it showed (a Source panel was about 400 px of empty
      // fill). The Legend strip reserves its width from the bottom (below) only while the panel's
      // bottom reaches the strip's top (review IN-B-04, `legendBand.ts`
      // `cornerLeftsReachingStrip`): a short panel ends far above it.
      //
      // Carrying the same attribute the CameraCluster carries folds this
      // panel into the band App already measures, and `Math.min` over every match
      // makes the reserve mean "the leftmost right-docked surface, whatever that
      // turns out to be" rather than a fixed list. The panel mounts and unmounts
      // with the selection, which is why App keys its measuring effect on the
      // selected node (a ResizeObserver cannot observe an element that does not
      // exist yet).
      data-fab-corner-dock=""
      className="fab-panel"
      aria-labelledby={HEADING_ID}
      style={{
        position: 'absolute',
        top: 'calc(var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl))',
        right: 'var(--fab-space-lg)',
        width: 'min(420px, 33vw)',
        // The CONTENT height cap (the panel is content-box): the window less the 116 px top, the
        // camera cluster's clearance (104 px: the cluster, its inset and an 8 px gap) and the
        // panel's own 22 px padding top and bottom, so the border box ends 8 px above the camera
        // cluster's top (UI-SPEC 2.2: 664 at 1024x768, 696 at 1280x800). It ended 24 px above the
        // window's bottom edge until review WR-B-06, level with the cluster's bottom, so a tall
        // panel painted over Fit and the zoom button.
        maxHeight: `calc(100% - (var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl)) - ${CAMERA_CLUSTER_CLEARANCE} - 2 * (var(--fab-space-md) + var(--fab-bezel-ring)))`,
        zIndex: 2,
        display: 'flex',
        // Hidden while Help holds the shared top-right slot (UI-SPEC 2.3), still mounted.
        ...(hidden ? { display: 'none' } : null),
        flexDirection: 'column',
        // Ring padding (plan 59-03): the 6px the retired border reserved.
        //
        // THIS DECLARATION IS UNCHANGED BY THE WR-08 FIX, AND THAT IS THE POINT. The
        // focus-ring clip is fixed on the scroll wrapper below with a bleed, not by
        // moving padding off this element. An `aside` is CONTENT-BOX (59-03 measured
        // exactly this: "Panels ARE content-box"), so `width: min(420px, 33vw)` is the
        // CONTENT width and the 22px sits outside it - taking the horizontal half away
        // from here shrinks the panel's rendered border box by 44px. Measured: that was
        // tried first and `panel-add-remove.spec.ts`'s WINDOWS-id-3 two-line note budget
        // caught it immediately at 640px, where the note went to three lines in a panel
        // 44px narrower than the one the budget was measured against.
        padding: 'calc(var(--fab-space-md) + var(--fab-bezel-ring))',
        // A real interactive aside (Palette/Help layer) - captures pointer events.
        pointerEvents: 'auto',
      }}
    >
      {/* THE SCROLL CONTAINER IS THIS INNER WRAPPER AND NOT THE PANEL, and the
          reason is a compositing one rather than a structural preference (plan
          59-03, RESEARCH Pitfall 1).

          `overflowY: 'auto'` used to sit on the .fab-panel element itself, beside
          the padding. That was harmless while the bezel was a border-image, because
          a border lives in the BORDER area, which content structurally cannot
          enter. The bezel is now an inset box-shadow: inset shadows are clipped to
          the PADDING box and paint above the background but BELOW the content, and
          in an overflowing box scrolled content passes straight through the padding
          region. The panel's top ring band would be overpainted by its own content
          the moment the panel was scrolled - with a fully green board, since the
          rect gate reads geometry, the CSS walkers read declarations, and no
          baseline captures a scrolled panel.

          The panel is already a column flex container, so this is a one-node change
          with no layout consequence: the wrapper takes the flex column, the gap and
          the scrolling, and `minHeight: 0` is what lets a flex item shrink below its
          content and actually scroll. Same shape Toolbar.tsx already uses for its
          inner overflow boxes. chromeCss.test.ts reddens if any ring carrier
          becomes a scroll container again.

          THE NEGATIVE MARGIN AND ITS MATCHING PADDING ARE A FOCUS-RING GUTTER, and
          they are the WR-08 fix (phase 59 review). They must move together.

          Moving the scroll box off the panel in 59-03 also moved it off the panel's
          22px of padding, and `overflowY: 'auto'` makes `overflow-x` compute to
          `auto` as well - so this box clipped flush against its own full-width
          children. Every focusable control inside is a stretched flex child at this
          wrapper's full width and every one declares
          `outline: 2px solid var(--fab-focus); outline-offset: 2px`
          (chromeCss.ts:363-366, :294-298), which extends 4px past the child's border
          box and straight into the clip. MEASURED on the running app before the fix:
          the close button clipped 4px on the right, `+ Add output` and Apply 4px on
          the left. Nothing gated it - the baselines capture a SCROLLED panel, never a
          FOCUSED control; the rect gate reads geometry; the CSS walkers read
          declarations; and axe has no outline-visibility rule, so a11y.spec.ts was
          correctly green throughout. `panel-io.spec.ts` now measures it directly.

          WHY A BLEED RATHER THAN MOVING THE PANEL'S PADDING IN HERE. An `aside` is
          CONTENT-BOX, so the panel's `width: min(420px, 33vw)` is its CONTENT width
          and its 22px sits outside that - moving the horizontal half off the panel
          shrinks the panel's rendered border box by 44px. That was tried first and
          `panel-add-remove.spec.ts`'s WINDOWS-id-3 note budget caught it at 640px.
          The bleed instead widens ONLY the clip box: `-16px` of margin pulls this
          element's border box out into the panel's padding, `16px` of padding puts
          the children back at exactly the same x. Panel geometry, child positions and
          content width are all byte-identical; the outline gains 16px of room where
          it needs 4.

          THE BLEED STOPS SHORT OF THE RING ON PURPOSE. It is `--fab-space-md` (16px)
          and not the full 22px, so the clip box's edge lands exactly on the
          `--fab-bezel-ring` band rather than over it. A full-width bleed would put
          the ring's own 6px inside a box that scrolled content can be painted into,
          which is the horizontal twin of the defect the wrapper exists for. */}
      <div
        data-fab-panel-scroll=""
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          margin: '0 calc(-1 * var(--fab-space-md))',
          padding: '0 var(--fab-space-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--fab-space-md)',
        }}
      >
      <h2 id={HEADING_ID} className="fab-title" style={HEADING_STYLE}>
        {KIND_NAMES[kind] ?? 'Machine'}
        {dirty && (
          // The marker is a BODY-tier surface nested inside the .fab-title h2:
          // text-transform + letter-spacing are inherited, so reset both or the
          // marker renders "• NOT APPLIED" with title tracking (Phase 47 WR-02).
          // Its words are `CONFIG_NOT_APPLIED_MARKER` (`configCopy.ts`, phase 90 D-05):
          // "unsaved" belongs to the board file, this is config not yet applied.
          <span
            style={{
              marginLeft: 'var(--fab-space-xs)',
              textTransform: 'none',
              letterSpacing: 'normal',
              ...LABEL_STYLE,
            }}
          >
            {CONFIG_NOT_APPLIED_MARKER}
          </span>
        )}
      </h2>

      {loading ? (
        // Loading: fields disabled + a "Loading config…" placeholder until the
        // host round-trip resolves. Local IPC is fast - no spinner.
        <textarea
          className="fab-field"
          disabled
          value=""
          readOnly
          placeholder="Loading config…"
          style={{ minHeight: 44, padding: 'var(--fab-space-sm)' }}
        />
      ) : (
        config && (
          <>
            {config.kind === 'Factory' && (
              // R-69: the label is chosen by the SELECTED KIND, not by the config
              // variant. A HANDLER folds to `Node::Factory` and therefore answers
              // `machine_config` with `MachineConfig::Factory { source }`, so the
              // variant cannot tell the two machines apart - only `kind` can. Using
              // the variant here would put one machine's word on the other's box,
              // which is the collision this prop exists to end.
              <FactoryConfigBody
                initialSource={config.source}
                handleRef={factoryEditorRef}
                onDirty={onFactoryDirty}
                label={
                  kind === machine_kind.HANDLER
                    ? FACTORY_EDITOR_LABELS.handler
                    : FACTORY_EDITOR_LABELS.factory
                }
              />
            )}
            {config.kind === 'Source' && (
              <SourceConfigBody
                trigger={config.trigger}
                node={node}
                invoke={invoke}
                onChange={(trigger) => onFieldChange({ kind: 'Source', trigger })}
                typed={timerTyped}
                onTyped={onTimerTyped}
                /* DEMO-08: the URL row follows the COMMITTED trigger, never `config` (the
                   buffer), so it shows only a door the host has opened. */
                committedTrigger={committed?.kind === 'Source' ? committed.trigger.kind : undefined}
              />
            )}
            {config.kind === 'Sink' && (
              <SinkConfigBody
                target={config.target}
                onChange={(target) => onFieldChange({ kind: 'Sink', target })}
              />
            )}
            {/* ROUTE-01/ROUTE-03 (65-02). The `ports` prop is already threaded
                from App's poll and is the ONLY correct source of the rules
                editor's output identity - a ConfigView carries no ports, and
                the two Routers in this app seat their Outs in opposite visual
                orders, so nothing may be restated here. Apply / Revert appear
                on their own: their guard is `!loading && config`, and a Router
                now answers `machine_config` with a config.

                `RouterConfigSection` rather than `RouterConfigBody`: the body is
                a hook-free pure function (its whole unit suite invokes it
                directly), and the section is the thin wrapper that holds the
                after-a-move focus restore. */}
            {/* BELT-01/BELT-02/BELT-04 (68-02). The FIFTH arm. `run` is a
                REQUIRED prop threaded from App exactly as `ports` and `flow`
                are, and Apply writes the whole run in ONE frame - see
                `commitConfig`'s Belt branch for why N `Configure` frames would
                be N undo steps. */}
            {config.kind === 'Belt' && (
              <BeltConfigBody
                ticksPerSlot={config.ticks_per_slot}
                run={run}
                typed={beltTyped}
                onChange={onBeltPace}
                onTyped={onBeltTyped}
              />
            )}
            {config.kind === 'Router' && (
              <RouterConfigSection
                routes={config.routes}
                fallback={config.default}
                ports={ports}
                flow={flow}
                onChange={(routes, def) =>
                  onFieldChange({ kind: 'Router', routes, default: def })
                }
                offsetTyped={offsetTyped}
                onOffsetTyped={onOffsetTyped}
              />
            )}
            {/* SERVE-05 (72-10, D-12). The SIXTH arm, and the Route's FIRST time
                inside this guard at all: until 72-07 gave the path a serialized
                field, a Route answered `machine_config` with null and rendered as a
                read-only card OUTSIDE it. It now answers with
                `MachineConfig::Endpoint { path }`, so Apply and Revert appear on it
                under the EXISTING `!loading && config` guard with NO new gate.

                FIRST POSITION AFTER THE HEADING, full content width (72-UI-SPEC 3).
                The Path field is the card's focal point: it is the one control this
                phase adds, and everything else on the card either feeds it (the hint
                under it) or reports its consequence (the POST URL row below it). */}
            {config.kind === 'Endpoint' && (
              <RouteConfigBody
                path={config.path}
                onChange={(path) => onFieldChange({ kind: 'Endpoint', path })}
              />
            )}
            {/* Phase 76 (plan 76-02, D-04, D-06). The SEVENTH arm: a label's Text field,
                first after the heading and full width (76-UI-SPEC 5.1). A label answers
                `machine_config` with `MachineConfig::Label` since this plan, so Apply and
                Revert appear under the EXISTING `!loading && config` guard with no new
                gate. The body hands back the WHOLE config (words, colour, width, depth),
                so one Apply is one Configure and one undo step. */}
            {config.kind === 'Label' && (
              <LabelConfigBody config={config} onChange={onFieldChange} />
            )}
          </>
        )
      )}

      {/* The Route's POST URL row (LEGIBLE-01, relabelled by 66-03). It renders
          OUTSIDE the `config &&` guard because it is not part of the config buffer
          at all: `webhook_url` is its own host query, answered from the bound
          listener, and it stays honest while the round trip is still in flight.

          IT SHOWS THE COMMITTED PATH AND NEVER THE TYPED ONE (72-UI-SPEC 3.1).
          The reason is the Copy button beside it: a previewed URL is a URL that
          404s, and offering Copy on it hands the user a broken string with an
          affordance saying it is ready. That property is structural rather than
          guarded - `WebhookUrlRow` fetches from the HOST, which knows only what has
          been folded - so nothing here has to remember not to preview.

          The user is already told their edit is not live: the heading carries the
          not-applied marker (`CONFIG_NOT_APPLIED_MARKER`), exactly the marker for this, and needs
          no second sentence beside it.

          The `/endpoint/` segment inside that URL STAYS (D-12a). It is the host's
          route prefix (`webhook.rs`), not a rename this phase missed, and
          72-UI-SPEC 8.5 is where a reader who takes it for one lands. */}
      {!loading && kind === machine_kind.ENDPOINT && (
        <>
          <WebhookUrlRow
            node={node}
            invoke={invoke}
            label="POST URL"
            /* 72-13: RE-FETCH WHEN THE COMMITTED PATH MOVES. Without this the row is
               keyed on the node alone, so an Apply that changed the path left the OLD
               URL on screen - with a Copy button beside it - until the panel was closed
               and reopened. `committed`, never `buffer`: the row shows what the HOST has
               folded, which is the property the comment above is about. */
            refreshKey={committed?.kind === 'Endpoint' ? committed.path : undefined}
          />
          {/* Phase 91 (D-12, CHROME-13): the Route calls its Handler, the machine at the
              far end of the wire, which is what the user drew it to. Line height 1.4
              (UI-SPEC 8.4) so the note reads as a sentence, not a label. */}
          <p style={{ margin: 0, ...LABEL_STYLE, lineHeight: 1.4 }}>{ROUTE_POST_NOTE}</p>
        </>
      )}

      {/* PANEL-02: the read-only I/O list, below the per-kind body and above the
          error row + Apply/Revert. It sits OUTSIDE the `config &&` guard on
          purpose (the Endpoint precedent just above): the port-only kinds -
          Tee / Balancer / Router / Merge - answer `machine_config` with null yet
          are exactly the machines whose whole identity IS their ports. Gated on
          `!loading` only, so it appears the moment the round-trip resolves.

          PANEL-03: `kind` + the two callbacks turn the Outputs group editable on
          a FACTORY only - every other kind gets the identical read-only list. */}
      {/* 74-UI-SPEC 4.1 (LINK-09): A BELT GETS THIS SECTION LIKE EVERY OTHER KIND,
          and the whole change was DELETING the kind-conditional term that used to
          stand here and exclude a belt. The two sentences that justified it were true
          when they were written and this phase made both false, so they are
          CORRECTED here rather than dropped (they are LINK-12 prose sites).

          The first said a belt declares no `Port` records. Since 74-02 it declares
          exactly two, Tail `Role::In` FIRST and Head `Role::Out` SECOND, both
          Mechanical, and that order is a contract the core pins by name. The second
          said a belt has ENDS rather than ports and this section has no honest
          reading of them. A belt's two ends ARE its two ports, and the honest
          reading is the two rows `beltPortRows` synthesises: `Input - Item` in
          `Inputs` from the Tail, `Output - Item` in `Outputs` from the Head, both
          through the unchanged `portRowLabel`. Neither group can render the shipped
          `None` row on a belt, because both records always exist (D-06).

          THE ESCAPE HATCH THE OLD COMMENT NAMED IS GONE, which is why this section
          had to arrive. It said disconnecting a belt end lives on the MACHINE's
          port row - true while every belt link had a machine on its other side. A
          belt-to-belt link has NO machine port row, so without the rows below
          LINK-06's shipped refusal (`That output is already connected. Disconnect
          it first.`) would name a control that exists nowhere on a belt.

          WHAT THE SECTION DOES NOT GROW ON A BELT, said here because "a belt gains
          a ports section" otherwise implies a belt can grow a third port - which
          the core forbids and trust-gate invariant 7 rejects on load. There is no
          `+ Add output` and no per-row `Remove`: `PortsSection` already gates both
          to `kind === machine_kind.FACTORY`, so this costs no new gate. And there
          is no busy signal on Disconnect: `PortsSection.tsx`'s own note records why
          (the port-edit latch releases on `portsKeyOf`, an `Unlink` removes a link
          and never a port, so the key is identical either side of the fold and the
          latch would hang forever and then offer `Try again` for a command that had
          already succeeded). That analysis is unchanged by a belt subject.

          NOT FOR A LABEL (phase 76, UI-SPEC U-6, D-07). A label is a note and never
          connects, so "Inputs: None / Outputs: None" on it would suggest it could have
          some, which is the opposite of what it is. The section is not rendered at all. */}
      {!loading && kind !== machine_kind.LABEL && (
        <PortsSection
          ports={ports}
          kind={kind}
          flow={flow}
          onAddOutput={onAddOutput}
          onRemoveOutput={onRemoveOutput}
          onDisconnect={onDisconnect}
          portEditPending={portEditPending}
          portEditStalled={portEditStalled}
          portEditPendingVisible={portEditPendingVisible}
          onPortEditReset={() => onPortEditReset(node)}
          simPaused={!playing}
          addBlockedByBelt={addBlockedByBelt}
        />
      )}

      {/* See `shownError` above for which sentence wins and why. */}
      {shownError !== null && errorRow(shownError)}

      {!loading && config && (
        // THE ACTION ROW STAYS IN VIEW (phase 89 UI review UI-06). In a short window the panel
        // column scrolls, and the Apply / Revert row used to be cut mid-button at the fold, which
        // read as a rendering fault (1024 x 640, a belt selected). It is sticky at the column's
        // bottom on the panel's own fill, so it is whole whenever it would be cut, and content
        // scrolls under it. The horizontal bleed is the scroll column's own (negative margin,
        // equal padding, so the buttons keep their x), and the xs strip above is paid back by an
        // equal negative margin, so the siblings above keep their y. The strip below is NOT paid
        // back (phase 91, plan 91-09, CHROME-07): since the panel is as tall as its content, a
        // negative bottom margin would end the column's content 4 px above the row's own bottom,
        // so every panel would overflow its column by 4 px and grow a scrollbar. The strips keep
        // the buttons' 2 px focus outline (offset 2) off the column's clip edge while stuck.
        <div
          data-fab-action-row=""
          style={{
            display: 'flex',
            gap: 'var(--fab-space-sm)',
            position: 'sticky',
            bottom: 0,
            zIndex: 1,
            backgroundColor: 'var(--fab-panel-fill)',
            margin: 'calc(-1 * var(--fab-space-xs)) calc(-1 * var(--fab-space-md)) 0',
            padding: 'var(--fab-space-xs) var(--fab-space-md)',
          }}
        >
          <button
            type="button"
            className="fab-cta"
            // WR-03: `!dirty` is the ordinary gate; the second term disables Apply
            // for a BELT whose run is empty or past the wire cap, so the control
            // states the constraint rather than the host's causeless refusal
            // stating it after the press. Revert is deliberately NOT gated on it:
            // discarding a local buffer is always available and needs no host.
            //
            // SERVE-05 adds the third term, in the SAME shape and for the same
            // recorded reason: a Route whose typed path is empty, wrongly
            // spelled, over the bound or already another Route's. It is a
            // COURTESY, not the authority - the core refuses independently and
            // plan 72-07 proved it does with no frontend in the loop.
            //
            // 76-02 adds the fourth term, same shape again: a label text the engine would
            // refuse for its length (UI-SPEC 5.5). Revert stays live, as for the others.
            disabled={
              !dirty ||
              !beltRunDispatchable(config, run) ||
              !routePathDispatchable(config, otherRoutes) ||
              !labelTextDispatchable(config)
            }
            onClick={onApply}
          >
            Apply
          </button>
          <button
            type="button"
            className="fab-tool-btn"
            disabled={!dirty}
            onClick={onRevert}
          >
            Revert
          </button>
        </div>
      )}

      {applied && (
        <div role="status" style={LABEL_STYLE}>
          Applied
        </div>
      )}

      {/* BELT-02 (phase 89, D-07, UI-SPEC 2.1, A1 to A3): the belt's delete control, the LAST
          child of this scroll column, after the Apply / Revert row and the Applied status, so a
          destructive control stays out of the reversible pair; 32px below that row (the column's
          16px gap plus this 16px margin). Here and not in `BeltConfigBody`, whose hook-free body
          and segment counts stay untouched. Not gated on `loading`, `config` or `dirty`:
          deleting needs no config and makes an unapplied pace moot. Neutral at rest and on hover
          (A2): the guard carries the red when items are at stake. The click is the same guarded
          path as the Delete key (App checks this panel's belt is the selected one). */}
      {kind === machine_kind.BELT && onDeleteBelt && (
        <button
          type="button"
          className="fab-tool-btn"
          id="fab-belt-delete"
          title="Delete belt"
          style={{ alignSelf: 'flex-start', marginTop: 'var(--fab-space-md)' }}
          onClick={onDeleteBelt}
        >
          <TrashIcon color="currentColor" />
          Delete belt
        </button>
      )}
      </div>
    </aside>
  );
}

export interface ConfigPanelProps {
  /** The selected node handle. App remounts on change via `key={node}`. */
  node: number;
  /** The machine-kind byte (KIND_NAMES heading). */
  kind: number;
  /** Commit seam - the transport `sendInput` (encoded Configure bytes). `opts.claim` (plan
   *  88-07) is what the gesture will take once it folds, registered by App's send seam. */
  sendInput: (bytes: Uint8Array, opts?: { claim?: QueuedClaim }) => void;
  /** Phase 88, plan 88-07 (D-09): the selected label's box as the scene shows it now (its
   *  anchor and committed size), or null, read at Apply so a label Configure can claim the
   *  cells it grows into. Optional so every other caller stays untouched. */
  labelBoxOf?: (node: number) => { id: number; cx: number; cy: number; w: number; h: number } | null;
  /** Host bridge; defaults to the real Tauri `invoke`. Tests inject a spy. */
  invoke?: ConfigInvoke;
  /** PANEL-02: the selected node's live packet ports, threaded down from App's
   *  poll-derived `selectedNodePorts` (the panel has no scene access of its own -
   *  this prop IS the scene-access seam). */
  ports: PortView[];
  /** 74.1-19: threaded from App's poll beside `ports`: `addOutputVerdict` answered
   *  `blocked-by-belt` for this machine (see `PortsSectionProps.addBlockedByBelt`). */
  addBlockedByBelt: boolean;
  /** PANEL-04: the selected node's live per-port flow, threaded down from App's
   *  poll-derived `selectedNodeFlow` (the same scene-access seam as `ports`).
   *  REQUIRED for the same WR-01 reason as `ConfigPanelViewProps.flow`. */
  flow: Map<number, PortFlow>;
  /** BELT-01: the belts THIS Apply writes to, in flow order - see
   *  {@link ConfigPanelViewProps.run} for why it is REQUIRED and why an absent
   *  value must never be readable as a run of one. It reaches the wire through
   *  `commitConfig`'s Belt branch, which is what makes a whole run ONE frame and
   *  therefore ONE undo step. */
  run: readonly BeltRunEntry[];
  /** CR-01: whether the sim is running. Copy-only - see
   *  {@link ConfigPanelViewProps.playing}. */
  playing: boolean;
  /** CR-01: the App-owned, node-keyed port-edit guard - the ONLY way this panel
   *  can put `AddPort`/`RemovePort` bytes on the wire. Returns false when nothing
   *  was sent (an edit is already unacknowledged, or there is no transport).
   *
   *  It lives in App rather than here because App is what SURVIVES: this
   *  component is remounted per selection (`key={node}`), and a latch that
   *  remounted with it discarded an edit still sitting in the host's unbounded
   *  gesture channel - after which the fresh instance re-offered the identical
   *  stale packet index. Passing `node` explicitly (rather than letting App close
   *  over its selection) keeps the keying honest and closure-staleness-free. */
  sendPortEdit: (
    node: number,
    kind: PortEditKind,
    portsKey: string,
    bytes: Uint8Array,
  ) => boolean;
  /** CR-01: an edit is unacknowledged - App's latch mirror. */
  portEditPending: boolean;
  /** WR-01: that edit has gone unfolded past the tick threshold. */
  portEditStalled: boolean;
  /** 74.1-19: the pending status line may show (the grace has passed, or the sim is
   *  paused); see `PortsSectionProps.portEditPendingVisible`. */
  portEditPendingVisible: boolean;
  /** WR-01: clear the latch for this node (the user pressed [Try again]). */
  onPortEditReset: (node: number) => void;
  /** SERVE-05: the OTHER Routes' committed paths and cells, from App's poll.
   *  Threaded straight through to the view - see `ConfigPanelViewProps` for why
   *  it is required rather than defaulted to an empty list. */
  otherRoutes: readonly RouteNeighbour[];
  /** Phase 76 (plan 76-02, 76-UI-SPEC 2.1): this panel opens on a label the user has
   *  JUST PLACED, so once its config has loaded the Text field takes focus with the caret
   *  at the end, and `onTextFocused` is called so App forgets the request. False for every
   *  other selection, including a plain click on an existing label: that must never steal
   *  focus from the board. Optional so every existing caller stays untouched. */
  focusTextOnLoad?: boolean;
  /** Called once, after the focus `focusTextOnLoad` asked for has been given. */
  onTextFocused?: () => void;
  /** Phase 76 (plan 76-03, 76-UI-SPEC 5.4): a label panel reports its PENDING size, the
   *  buffer's width and depth while they differ from the committed size, and `null` when
   *  they match again (Apply landed, Revert) or the panel unmounts (deselect, the panel
   *  closing on a full keyframe). App draws the outline the label would have. Optional so
   *  every other caller stays untouched; never called for a non-label. */
  onLabelResize?: (node: number, pending: { w: number; h: number } | null) => void;
  /** BELT-02 (phase 89, D-07): the belt panel's `Delete belt` intent, passed straight
   *  through to the view (`ConfigPanelViewProps.onDeleteBelt`). */
  onDeleteBelt?: () => void;
  /** Phase 91, plan 91-09 (UI-SPEC 2.3): Help holds the shared slot, so the panel is hidden
   *  and stays mounted (`ConfigPanelViewProps.hidden`). */
  hidden?: boolean;
  /** Phase 91, plan 91-09 (UI-SPEC 2.3, T-91-28): the panel's not-applied condition (the
   *  `• not applied` marker), reported on every change and as `false` when the panel unmounts.
   *  App reads it to decide whether a hidden panel holds an edit that the next Escape or board
   *  press must not drop. Optional so every other caller stays untouched. */
  onDirtyChange?: (dirty: boolean) => void;
}

/** The stateful shell App mounts. Holds the parent-held buffer + dirty/error
 *  state; pre-fills on mount; commits on Apply through `commitConfig`. */
export function ConfigPanel({
  node,
  kind,
  sendInput,
  ports,
  addBlockedByBelt,
  flow,
  run,
  otherRoutes,
  playing,
  sendPortEdit,
  portEditPending,
  portEditStalled,
  portEditPendingVisible,
  onPortEditReset,
  invoke = tauriInvoke,
  focusTextOnLoad = false,
  onTextFocused,
  onLabelResize,
  labelBoxOf,
  onDeleteBelt,
  hidden = false,
  onDirtyChange,
}: ConfigPanelProps): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [committed, setCommitted] = useState<MachineConfig | null>(null);
  const [buffer, setBuffer] = useState<MachineConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  /** BELT-04: the pace field's RAW typed text, or null while the field mirrors
   *  the buffer. It lives here rather than in `buffer` because `MachineConfig`
   *  carries the wire's `ticks_per_slot` and has no room for the keystrokes that
   *  produced it. `key={node}` App-side resets it on every selection change,
   *  exactly as it resets the buffer. */
  const [beltTyped, setBeltTyped] = useState<string | null>(null);
  /** Review WR-B-01: the timer Every field's and the Router At byte fields' raw typed text, held
   *  here for the reason `beltTyped` is: the bodies hold no hooks, and the buffer has no room for
   *  the keystrokes. Each is a view of the buffer, so Revert, Apply and its confirmation drop it,
   *  and the field drops it itself when it is left. */
  const [timerTyped, setTimerTyped] = useState<string | null>(null);
  const [offsetTyped, setOffsetTyped] = useState<ReadonlyMap<number, string>>(() => new Map());
  const appliedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The generation of the CURRENT apply-confirmation walk. Bumping it abandons
   *  any read still in flight, which is what stops a late confirmation from
   *  overwriting a buffer the user has edited since (it would otherwise call
   *  `setBuffer(toCommit)` with the OLD table and silently discard the newer
   *  edit). Every path that changes the buffer bumps it, and so does unmount. */
  const confirmGen = useRef(0);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The Factory editor is UNCONTROLLED (holds its own buffer): the parent reads
  // the exact bytes here on Apply and pushes the committed source on Revert.
  const factoryEditorRef = useRef<FactoryEditorHandle | null>(null);
  // BELT-01: the LIVE run, for the apply-confirmation walk below. The same
  // `xRef.current = x` discipline App uses for its poll closures, and for the
  // same reason: the walk outlives the render that started it.
  const runRef = useRef<readonly BeltRunEntry[]>(run);
  runRef.current = run;
  // Phase 91, plan 91-09 (UI-SPEC 2.3): report the not-applied condition up to App on every
  // change, and `false` on unmount, so App knows when a hidden panel holds an unapplied edit.
  // The callback is read through a ref so a new closure from App never re-reports.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);

  // Pre-fill on mount / node change. `key={node}` App-side means this effect runs
  // once per instance; the guard covers the pre-remount case defensively.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setApplied(false);
    setDirty(false);
    loadConfig(node, invoke)
      .then((cfg) => {
        if (!alive) return;
        setCommitted(cfg);
        setBuffer(cfg);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        // Query-failure backstop: same inline destructive row.
        setError(`Could not load config - ${reasonOf(err)}.`);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [node, invoke]);

  // Phase 76 (plan 76-02, 76-UI-SPEC 2.1): A LABEL JUST PLACED OPENS WITH ITS TEXT FIELD
  // FOCUSED, caret at the end, so the user can type straight away. It waits for the
  // config: the field does not exist until `machine_config` answers, and focusing the
  // loading placeholder would do nothing useful. ONCE per request: App's request is
  // forgotten as soon as it is honoured, so a later plain click on a label (which mounts
  // a fresh panel) never takes focus from the board.
  useEffect(() => {
    if (!focusTextOnLoad || loading || buffer?.kind !== 'Label') return;
    const field = document.getElementById(LABEL_TEXT_FIELD_ID);
    if (field instanceof HTMLTextAreaElement) {
      field.focus();
      const end = field.value.length;
      field.setSelectionRange(end, end);
    }
    onTextFocused?.();
  }, [focusTextOnLoad, loading, buffer?.kind, onTextFocused]);

  // Phase 76 (plan 76-03, 76-UI-SPEC 5.4, U-5): THE PENDING SIZE IS PREVIEWED. While the
  // buffer's width or depth differs from the committed size, App is told the pending size
  // and draws its outline; once they match (Apply confirmed, Revert) it is told `null`.
  // Nothing is sent to the host here: the outline is a courtesy and Apply stays enabled
  // on a red one, so the host's `ResizeCovers` stays reachable and is what the user reads.
  const pendingW = buffer?.kind === 'Label' ? buffer.w : null;
  const pendingH = buffer?.kind === 'Label' ? buffer.h : null;
  const committedW = committed?.kind === 'Label' ? committed.w : null;
  const committedH = committed?.kind === 'Label' ? committed.h : null;
  const onLabelResizeRef = useRef(onLabelResize);
  onLabelResizeRef.current = onLabelResize;
  useEffect(() => {
    if (pendingW === null || pendingH === null || committedW === null || committedH === null) {
      return;
    }
    const differs = pendingW !== committedW || pendingH !== committedH;
    onLabelResizeRef.current?.(node, differs ? { w: pendingW, h: pendingH } : null);
  }, [node, pendingW, pendingH, committedW, committedH]);
  // The panel closing (deselect, a full keyframe's selection clear, a selection change)
  // takes the outline with it. Only a label panel ever reported one.
  const isLabelPanel = kind === machine_kind.LABEL;
  useEffect(
    () => () => {
      if (isLabelPanel) onLabelResizeRef.current?.(node, null);
    },
    [node, isLabelPanel],
  );

  // -------------------------------------------------------------------------
  // CR-01: the IN-FLIGHT PORT EDIT LATCH - OWNED BY APP, not by this component.
  //
  // The invariant, and the mechanics that enforce it, live in `portEditLatch.ts`
  // as a pure state machine (which is what makes BOTH of its directions provable
  // in the node test env - WR-05). In one line: at most ONE port edit may be sent
  // against any ONE observed port topology, because `command.rs:855-864`
  // validates a `RemovePort` index by RANGE alone, so a duplicate splices
  // whatever slid into that slot when the first one folded.
  //
  // It used to be a `useRef` right here, and that was the iteration-3 Critical.
  // App mounts this component as `<ConfigPanel key={selectedNode} .../>`, so a
  // deselect UNMOUNTS it - discarding the in-flight record while the edit was
  // still queued in the host's unbounded gesture channel. On reselect the packet
  // indices on screen were still the pre-fold ones and every control was live
  // again, so the identical `RemovePort` was offered a second time. Three
  // ordinary clicks, and during a paused build the only route to a second port
  // edit at all: the workaround for the liveness limit WAS the stranding path.
  //
  // So the guard now lives on the node, in App, and outlives every panel
  // instance. What is left here is the ENCODING (this file owns the AddPort
  // shape and the WR-04 constant `side` byte) and the two intent callbacks. The
  // send is structurally downstream of the guard in the strongest sense
  // available: `sendPortEdit` performs the send itself, so there is no path from
  // this component to the wire that could skip the latch.
  //
  // `portsKey` is the ADDRESSING key of the topology CURRENTLY ON SCREEN, which
  // is exactly what the invariant is about - so it is derived here, from the
  // props this panel painted, and handed to the guard.
  // -------------------------------------------------------------------------
  const portsKey = portsKeyOf(ports);

  useEffect(
    () => () => {
      if (appliedTimer.current) clearTimeout(appliedTimer.current);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      // Abandon any read still in flight, so it cannot schedule a fresh timer
      // after this instance is gone.
      confirmGen.current += 1;
    },
    [],
  );

  const onFieldChange = useCallback((next: MachineConfig) => {
    // A newer edit outranks a confirmation still walking for the previous one:
    // if that one landed now it would push its OWN table into the buffer and
    // throw this keystroke away.
    confirmGen.current += 1;
    setBuffer(next);
    setDirty(true);
    setApplied(false);
    setError(null);
  }, []);

  // BELT-04: a pace SEGMENT press. It clears the typed text as well as setting
  // the buffer, because the pressed segment is now the answer and a stale figure
  // in the field beside it would be a second one.
  const onBeltPace = useCallback(
    (ticks_per_slot: number) => {
      setBeltTyped(null);
      onFieldChange({ kind: 'Belt', ticks_per_slot });
    },
    [onFieldChange],
  );

  // BELT-04: a keystroke in the pace field. The RAW text is kept verbatim - it is
  // what the field displays and it is never clamped or sanitized - and the buffer
  // takes whatever it resolves to. `paceToTicks` is total, so there is no branch
  // here for "invalid": an empty or non-numeric field resolves to zero, which the
  // host refuses in words if it is ever applied.
  const onBeltTyped = useCallback(
    (text: string) => {
      setBeltTyped(text);
      onFieldChange({ kind: 'Belt', ticks_per_slot: paceToTicks(text) });
    },
    [onFieldChange],
  );

  // A user keystroke in the uncontrolled Factory editor: mark dirty WITHOUT
  // touching the buffer (the editor owns the live source; Apply reads it).
  const onFactoryDirty = useCallback(() => {
    confirmGen.current += 1;
    setDirty(true);
    setApplied(false);
    setError(null);
  }, []);

  /**
   * Ask the host, up to {@link APPLY_CONFIRM_ATTEMPTS} times, whether it now
   * holds the config that was just dispatched - and record the Apply as
   * committed ONLY when it says yes.
   *
   * This is the whole of the 65-REVIEW CR-02 fix. What used to happen here was
   * that a true `sent` flag advanced `committed`, cleared `dirty` and lit
   * `Applied`, none of which the panel had any evidence for: `sendInput` returns
   * `void`, so a refused `Configure` produced the identical flag as an accepted
   * one. The user then read `Applied` beside a `#fab-refusal` sentence saying the
   * host had refused, lost the not-applied marker that was the only warning left, and
   * got a `Revert` that restored a table the engine never had.
   *
   * `65-UI-SPEC.md` state 6 locks the behaviour on a refusal - "the panel's
   * buffer is untouched and still dirty ... Apply / Revert: still enabled" - and
   * that is exactly what NOT confirming leaves behind, because confirming is the
   * only thing that changes any of it. Nothing new renders on a refusal, no
   * second error surface is added, and the reason is stated once, on
   * `#fab-refusal`, by the machinery that actually knows it.
   */
  const confirmApply = useCallback(
    (toCommit: MachineConfig) => {
      const gen = (confirmGen.current += 1);
      let attempt = 0;
      const ask = (): void => {
        attempt += 1;
        void loadConfig(node, invoke)
          // A failed query is not a verdict either: fall through to a retry.
          .catch(() => null)
          .then((readBack) => {
            if (confirmGen.current !== gen) return;
            // The run is read through a REF rather than closed over: this walk
            // retries for up to APPLY_CONFIRM_ATTEMPTS x APPLY_CONFIRM_INTERVAL_MS
            // and App re-derives the run on its ~10Hz poll, so a captured value
            // would answer out of a snapshot taken before the host folded
            // anything - the observation would be stale exactly when it matters.
            if (configAppliedToRun(node, toCommit, readBack, runRef.current)) {
              setCommitted(toCommit);
              setBuffer(toCommit);
              setTimerTyped(null);
              setOffsetTyped(new Map());
              setDirty(false);
              setError(null);
              setApplied(true);
              if (appliedTimer.current) clearTimeout(appliedTimer.current);
              appliedTimer.current = setTimeout(() => setApplied(false), 1500);
              return;
            }
            if (attempt >= APPLY_CONFIRM_ATTEMPTS) return;
            confirmTimer.current = setTimeout(ask, APPLY_CONFIRM_INTERVAL_MS);
          });
      };
      ask();
    },
    [node, invoke],
  );

  const onApply = useCallback(() => {
    if (!buffer) return;
    // Review WR-B-01: Apply commits the sanitized figures, so the fields show them from here on
    // (a pointer press on Apply has already left the field; a key path may not have).
    setTimerTyped(null);
    setOffsetTyped(new Map());
    // For a Factory the live source lives in the uncontrolled editor, not the
    // buffer - read the EXACT current bytes (no reformat) at Apply time. Other
    // kinds commit the controlled buffer directly.
    const toCommit: MachineConfig =
      buffer.kind === 'Factory' && factoryEditorRef.current
        ? { kind: 'Factory', source: factoryEditorRef.current.read() }
        : buffer;
    void commitConfig(node, toCommit, { invoke, sendInput, run, labelBox: labelBoxOf?.(node) ?? null }).then((res) => {
      if (res.dispatched) {
        // Dispatched, verdict unknown. Change NOTHING about the buffer here:
        // `confirmApply` is what advances it, and only on evidence.
        confirmApply(toCommit);
      } else {
        // Factory invalid-JS: inline error, nothing committed, focus stays put.
        setError(`Handler error - ${res.error}. ${CONFIG_NOT_APPLIED_SUFFIX}`);
      }
    });
  }, [buffer, node, invoke, sendInput, run, confirmApply, labelBoxOf]);

  // PANEL-03 add: one certified `AddPort` per click through the SAME `sendInput`
  // seam Apply uses - one command = one host action = one undo step
  // (`GridSession::apply` stamps exactly one action span per accepted command),
  // with no frontend batching anywhere on this path.
  //
  // The medium is Mechanical (Item): a Wire picker is deferred (51-CONTEXT
  // `:78`). The `side` byte is the CONSTANT `SIDE_EAST` - see the constant for
  // why it must not be read off the live port list (WR-04: `PortView.side` is
  // post-rotation, and this command is persisted verbatim in the edit log).
  //
  // A host reject (footprint collision / out-of-range, `validate_normalize`'s
  // `AddPort` arm) is ANSWERED since Phase 64: `sendInput` is App's `submitInput`,
  // which reads the verdict off the gesture envelope's reply seam and shows it in
  // the shared `#fab-refusal` surface. What is unchanged is this panel: there is
  // still deliberately NO error surface HERE and the latch still does not release
  // on a refusal, because the latch watches the ECHO, and from the echo alone the
  // panel cannot distinguish "not folded YET" from "rejected" - guessing between
  // them is what CR-01 was reopened for. Feeding the verdict into the latch is a
  // product decision, WINDOWS row 72, deliberately not taken this phase. Until it
  // is, the latch stays closed and the panel says it is waiting (PortsSection's
  // pending status), which is the truth.
  const onAddOutput = useCallback(() => {
    // CR-01: one edit in flight at a time, per NODE and across panel instances.
    // An Add burst would queue N appends, each one re-seating the whole port
    // list, from a single user gesture. `sendPortEdit` does the send itself, so
    // the bytes below cannot reach the wire unless the latch granted the slot -
    // and it is App's latch, so deselecting does not hand out a second one.
    sendPortEdit(
      node,
      'add',
      portsKey,
      encodeGridCommand({
        kind: 'AddPort',
        node,
        role: ROLE_OUT,
        side: SIDE_EAST,
        medium: MEDIUM_MECHANICAL,
      }),
    );
  }, [node, portsKey, sendPortEdit]);

  // PANEL-03 remove: `index` is the PACKET port index (identical to the core's
  // rot-0 list position, which is what `fold_remove_port` splices).
  //
  // 73-08: the frontend dock-safety gate that used to stand between this callback
  // and the button is DELETED. It refused to offer a removal the core could not
  // survive; since 73-06 the fold re-points every route, dock and BELT dock keyed to
  // the removed port and releases exactly the belt that was on it, with a
  // compensating `Dock` on the undo.
  //
  // 73-12 CORRECTS THE SCOPE THIS COMMENT CLAIMED. It said "every route, dock and
  // default" and covered belts only; 73-REVIEW CR-02 measured that a WIRE endpoint
  // was never re-pointed. The screens under this call are now TWO certified host
  // validate arms, not one: the out-of-range index (unreachable from here, because
  // the panel builds its rows from `outPorts`) and, since 73-12, a
  // `CommandError::PortOccupied` when a cable is attached to the port - which the
  // refusal surface already renders as "That output is already connected. Disconnect
  // it first." No gate comes back to this file: the panel still OFFERS the control
  // and the host answers.
  const onRemoveOutput = useCallback(
    (index: number) => {
      // CR-01: refuse a second removal while the first is unacknowledged - the
      // index on screen addresses the SAME list the first one was sent against,
      // so folding both would splice a port the user never looked at. That is
      // still true after 73-08 and is what this latch is for; it survives a
      // deselect/reselect, which is what makes it a property of the machine
      // rather than of this component's lifetime.
      sendPortEdit(node, 'remove', portsKey, encodeGridCommand({ kind: 'RemovePort', node, index }));
    },
    [node, portsKey, sendPortEdit],
  );

  // CONNECT-01 disconnect: one certified command per click, sent through
  // `sendInput` DIRECTLY - the same seam Apply, Undo, Redo and Delete use.
  //
  // IT MUST NOT GO THROUGH `sendPortEdit`, and this is a correctness constraint
  // rather than a style choice. `sendPortEdit` ARMS the CR-01 port-edit latch,
  // and `observePorts` (`portEditLatch.ts`) releases that latch only when the
  // node's ports key CHANGES - it returns the latch untouched on its first line
  // whenever `latch.sentPortsKey === portsKeyOf(ports)`. An `Unlink` removes a
  // LINK, never a port, so the ports key is byte-identical before and after the
  // host folds it: the latch would stay pending forever, and every single
  // Disconnect click would leave the panel showing "Waiting for the host to apply
  // this change" until the stall timer fired, over a command that had already
  // succeeded. So Disconnect reads the latch (it is `disabled` while another edit
  // is in flight, because it sends a catalog index an in-flight AddPort/RemovePort
  // makes stale) and never arms it.
  //
  // The two mediums take two verbs (decision D1), and the wire branch is not an
  // optimisation - an `Unlink` on a wire is a no-op the user cannot see. A wire's
  // SOURCE has no `links` entry at all (`state.rs:1983-1988`) and the validate arm
  // accepts it as a panic-free no-op (`command.rs:1466-1472`); unlinking a wire's
  // TARGET does remove `(wire, 0)` at core level, but `WireView` is projected from
  // the wire node's OWN `from`/`to` fields (`render_packet.rs:444-483`) and never
  // from `links`, so the cable would still draw and both ports would still read
  // `docked: true`. That is exactly the "silently accepted no-op reported as
  // success" shape `command.rs:1451-1453` says this verb exists to avoid.
  //
  // So a wire link emits `GridCommand::Delete { node: wireId }` instead - the verb
  // `compute_inverse` already uses to undo a `DrawWire` (`command.rs:2501-2509`)
  // and the one `gestures.ts:2176` already encodes. Deleting the wire node is what
  // makes the cable actually go away, which is the whole observable content of
  // "disconnect" on that medium.
  //
  // THERE IS DELIBERATELY NO `DeleteGuardDialog` ON THIS PATH, and that is not an
  // oversight. The guard exists to protect IN-FLIGHT ITEMS, and `fold_delete` on a
  // wire carries none: items ride belts. `inFlightForNode` (`gestures.ts:274`)
  // returns `{count: 0}` for a wire handle at its first line, because it looks the
  // handle up in `scene.nodes` and `applyPacket` files wires under `scene.wires`
  // (`sceneState.ts:320`) - they share the dense handle space but not the map. The
  // shipped DrawWire-undo path already deletes wires with no dialog, so this
  // matches the precedent rather than routing around a guard.
  //
  // WHICH four fields the command carries is `disconnectCommand` above, extracted
  // so a unit case can read the encode itself: a spy on `sendInput` proves only
  // that something was sent, and naming the wrong node destroys a link the user did
  // not point at (T-74-33).
  const onDisconnect = useCallback(
    (port: PortView, link: PortLink) => {
      sendInput(encodeGridCommand(disconnectCommand(node, port, link)));
    },
    [node, sendInput],
  );

  const onRevert = useCallback(() => {
    confirmGen.current += 1;
    setBuffer(committed);
    // Restore the committed source into the uncontrolled editor (a guarded,
    // dirty-suppressed dispatch - a no-op if it already matches).
    if (committed?.kind === 'Factory') {
      factoryEditorRef.current?.setSource(committed.source);
    }
    setDirty(false);
    setError(null);
    setApplied(false);
    // BELT-04: the typed text is a VIEW of the same buffer, so Revert resets it
    // together with the buffer. Leaving it behind would show a figure the panel
    // is no longer holding (68-UI-SPEC state 9: "both are views of one buffer").
    setBeltTyped(null);
    // Review WR-B-01: the same for the timer and At byte fields' typed text.
    setTimerTyped(null);
    setOffsetTyped(new Map());
  }, [committed]);

  return (
    <ConfigPanelView
      kind={kind}
      node={node}
      loading={loading}
      config={buffer}
      dirty={dirty}
      error={error}
      applied={applied}
      ports={ports}
      addBlockedByBelt={addBlockedByBelt}
      committed={committed}
      flow={flow}
      run={run}
      otherRoutes={otherRoutes}
      beltTyped={beltTyped}
      onBeltPace={onBeltPace}
      onBeltTyped={onBeltTyped}
      timerTyped={timerTyped}
      onTimerTyped={setTimerTyped}
      offsetTyped={offsetTyped}
      onOffsetTyped={setOffsetTyped}
      onAddOutput={onAddOutput}
      onRemoveOutput={onRemoveOutput}
      onDisconnect={onDisconnect}
      portEditPending={portEditPending}
      portEditStalled={portEditStalled}
      portEditPendingVisible={portEditPendingVisible}
      onPortEditReset={onPortEditReset}
      playing={playing}
      onFieldChange={onFieldChange}
      onApply={onApply}
      onRevert={onRevert}
      invoke={invoke}
      factoryEditorRef={factoryEditorRef}
      onFactoryDirty={onFactoryDirty}
      onDeleteBelt={onDeleteBelt}
      hidden={hidden}
    />
  );
}
