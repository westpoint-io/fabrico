// types.ts - the data a lesson is written in, and the plain facts the lesson engine reads.
//
// Pure: no React, no Pixi, no DOM. The engine sees the board and the chrome only through these
// shapes, so it can run in a node test and in the walk test, and it holds nothing that could send
// a command.

import type { ShortcutId } from '../input/shortcuts';
import type { MachineConfig } from '../protocol/decode';

export type LessonId = 'your-first-line' | 'delete-and-undo' | 'a-factory-with-two-outputs' | 'answer-a-web-request';
/**
 * What a step can bind. `belt`, `beltIn`, `beltOut` and `beltOut2` are belts, each found by the two
 * machines `BELT_ENDS` in `check.ts` names for it; the rest are machines, each found by its `nodeKey`.
 * No step binds a wire: a wire is found by the two machines it joins (`wireFrom` in `check.ts`).
 */
export type BindingName =
  | 'source'
  | 'sink'
  | 'belt'
  | 'factory'
  | 'sink2'
  | 'beltIn'
  | 'beltOut'
  | 'beltOut2'
  | 'route'
  | 'handler';

export interface BoardNode {
  id: number;
  kind: number;
  cells: ReadonlyArray<readonly number[]>;
  ports: ReadonlyArray<{ index: number; cell_x: number; cell_y: number; side: number; role: number }>;
}

export interface BoardBelt {
  id: number;
  items: number;
  occupiedSlots: readonly number[];
  /**
   * The cells the belt runs over, Tail first. The host refuses a Place on any of them. `kind` is the
   * tile's shape as `FabricoScene` carries it, read only by the restored check's shape.
   */
  tiles: ReadonlyArray<{ cell_x: number; cell_y: number; kind?: unknown }>;
  docks: ReadonlyArray<{ end: string; node: number; port: number }>;
}

/**
 * An electrical wire, from one machine's port to another's. One Wire drag between a Route and an HTTP
 * Handler lays two of these, the request leg and the return leg. `replyPulsesSeen` counts the packets in
 * which this wire carried a reply since the last keyframe, so it starts again from nothing after an Undo.
 */
export interface BoardWire {
  id: number;
  from: { node: number; port: number };
  to: { node: number; port: number };
  replyPulsesSeen: number;
}

/** What a frame knows about the board. `FabricoScene` satisfies this structurally. */
export interface BoardFacts {
  tick: number;
  generation: number;
  swapFloor: number;
  nodes: readonly BoardNode[];
  belts: readonly BoardBelt[];
  wires: readonly BoardWire[];
}

export type ArmedFact =
  | { kind: 'machine'; machineKind: number; presetMedium?: number | null }
  | { kind: 'belt' }
  | { kind: 'wire' }
  | null;

/** What a frame knows about the chrome and the view. */
export interface ChromeFacts {
  armed: ArmedFact;
  selectedNode: number | null;
  /** The selected belt's handle. App keeps it apart from `selectedNode`, which gates a machine's delete controls. */
  selectedBelt: number | null;
  playing: boolean;
  /**
   * Has the app sent a draw or a dock the board doesn't show yet, or does it still owe one? A good draw's
   * docks follow its belt, so a half-docked belt means something else while this is false: nothing is coming.
   */
  editsInFlight: boolean;
  /** The pressed segment in the inspector's Trigger group, read from the DOM. This is the unapplied buffer. */
  triggerPressed: 'Webhook' | 'Timer' | null;
  /** The host's last answer about a node's trigger. Only this says a trigger has been applied. */
  appliedTrigger: { node: number; kind: 'Webhook' | 'Timer' } | null;
  /**
   * The host's answers about the bound machines' applied configs, each tagged with the board generation
   * its query was sent at. The layer hands over only answers about a bound handle at this frame's
   * generation, and the reader checks the generation again, because an Undo keyframe re-mints handles.
   */
  appliedConfigs: readonly AppliedConfig[];
  /** Does the inspector's heading show the not-applied marker? Read from the DOM: the panel holds typed, unapplied config. */
  codeNotApplied: boolean;
  /** The text in the Factory's code editor, its lines joined by newlines, or null with no Factory editor showing. */
  codeText: string | null;
  /**
   * The URL read off the inspector's POST URL row while the Route with handle `node` was selected, at board
   * generation `generation`, accepted only in the strict endpoint shape. Null until one has been read. An
   * Undo keyframe re-mints handles, so a reader checks both against the board before trusting it.
   */
  routeUrl: { node: number; generation: number; url: string } | null;
  view: {
    camera: { x: number; y: number; scale: number };
    freeArea: { left: number; right: number; top: number; bottom: number };
  };
}

/** One answer from the host's config query: about handle `node`, asked at board generation `generation`. */
export interface AppliedConfig {
  node: number;
  generation: number;
  /** Null when the host says the machine has no config. */
  config: MachineConfig | null;
}

export type Check =
  | { is: 'nodeAppeared'; kind: number; bind: BindingName }
  | { is: 'triggerApplied'; of: BindingName; trigger: 'Timer' }
  | { is: 'beltJoins'; a: BindingName; b: BindingName; bind: BindingName }
  | { is: 'tickRose' }
  | { is: 'itemArrived'; at: BindingName }
  /** The bound machine left the board while the generation stayed where it was when the step began: a Delete, not an Undo. */
  | { is: 'nodeGone'; of: BindingName }
  /** The bound belt is gone by `boundGone` (a belt the capture holds counts as back only on its own tiles), with the generation unchanged since the step began. */
  | { is: 'beltGone'; of: BindingName }
  /** The board's shape, with no handle in it, equals the shape captured when the step `since` began. */
  | { is: 'restored'; since: string }
  /** The bound machine holds at least `outs` ports with role Out. */
  | { is: 'portAdded'; of: BindingName; outs: number }
  /** Each Sink's lowest occupied slot rose at least once since the step began, each read on its own. */
  | { is: 'itemsArriveAtBoth'; at: readonly [BindingName, BindingName] }
  /** A wire from `a` to `b` and a wire from `b` to `a` are both on the board, found by their machines. */
  | { is: 'wireJoins'; a: BindingName; b: BindingName }
  /**
   * The wire from `from` to `to`, found by its machines, has carried more replies than when the step
   * began, read within one board generation.
   */
  | { is: 'replyPulseRose'; from: BindingName; to: BindingName };

export type StageWhen =
  | { is: 'always' }
  | { is: 'paused' }
  | { is: 'toolArmed'; machineKind: number }
  | { is: 'toolNotArmed'; machineKind: number }
  | { is: 'anyToolArmed' }
  | { is: 'beltNotArmed' }
  | { is: 'beltArmed' }
  /** The Wire tool is armed. */
  | { is: 'wireArmed' }
  /** The Wire tool isn't armed: nothing is, or another tool is. */
  | { is: 'wireNotArmed' }
  /** The Belt tool is armed, and the line leaving this machine stops short with an end a press can carry on from. */
  | { is: 'lineStopsShort'; from: BindingName }
  /** The Belt tool is armed, and a belt on the way from one machine to the other can only be undone, until it's gone. */
  | { is: 'lineStuck'; from: BindingName; to: BindingName }
  | { is: 'notSelected'; of: BindingName }
  /**
   * The bound thing is off the board, by `boundGone` in check.ts, the rule the delete checks read too. A
   * machine: no node holds its `nodeKey`. A belt the restored check's capture holds: no belt's tiles
   * include every tile it had there, docked or not. A belt joining its two machines on other tiles, or
   * sharing only some of the tiles, is a different belt. A belt with no capture to read: no belt joins
   * its two machines.
   */
  | { is: 'gone'; of: BindingName }
  /**
   * The board matches the capture taken when step `since` began in everything but config answers still
   * on their way: at least one read machine has no answer yet, on either side, and the two shapes are
   * equal once those machines' configs are set aside. An Undo keyframe re-mints every handle, so the
   * answers about the new ones come a poll or more after the board is back.
   */
  | { is: 'configsPending'; since: string }
  | { is: 'triggerNotPressed'; trigger: 'Timer' }
  | { is: 'triggerNotApplied'; trigger: 'Timer' }
  /**
   * The bound Factory's code is as it was when the step began: the applied source isn't known yet, the
   * editor isn't showing, or the editor holds that source with no not-applied marker.
   */
  | { is: 'codeUnchanged'; of: BindingName }
  /** The inspector shows its not-applied marker. */
  | { is: 'codeNotApplied' }
  /**
   * No URL has been read off the bound Route's POST URL row at this board generation: `routeUrl` is null,
   * names another handle, or was read before an Undo keyframe re-minted the handles.
   */
  | { is: 'urlNotRead'; of: BindingName };

/** A chrome control a ring can mark. Each resolves by the control's own name or state, so a renamed control fails the walk. */
export type PanelTarget =
  | { kind: 'placeMachine'; machineKind: number }
  | { kind: 'playButton' }
  | { kind: 'armedTool' }
  | { kind: 'beltTool' }
  | { kind: 'segment'; group: 'Trigger'; label: 'Timer' }
  | { kind: 'applyButton' }
  | { kind: 'undoButton' }
  /** The inspector's add-output button, found by its label. */
  | { kind: 'addOutputButton' }
  /** The line of the Factory's code editor whose text holds `holds`, or the whole editor with no such line. */
  | { kind: 'codeLine'; holds: string }
  /** The palette's Wire tool, found by its label. */
  | { kind: 'wireTool' }
  /**
   * The Copy button on the inspector's POST URL row, found through the row's label, so the ring stays put
   * while the button reads Copied or Copy failed.
   */
  | { kind: 'copyUrlButton' };

export type PortRoleName = 'out' | 'in';

/**
 * Where a floor ring goes, worked out by `floorSpot`. `source` and `sink` are lesson 1's rule. The next four
 * build lesson 4's line: a Source placed so the whole line is centred in the free area, a Factory beside
 * it, and a Sink in front of each of the Factory's outputs. `centredRoute` and `handler` place a Route and
 * an HTTP Handler with the Handler's input facing the Route's output across three empty cells.
 */
export type FloorSpot =
  | 'source'
  | 'sink'
  | 'centredSource'
  | 'factory'
  | 'firstOutputSink'
  | 'freeOutputSink'
  | 'centredRoute'
  | 'handler';

export type HintAnchor =
  | { on: 'panel'; target: PanelTarget }
  | { on: 'floor'; spot: FloorSpot }
  | { on: 'machine'; of: BindingName }
  /** A bound belt's middle tile, `tiles[floor(n / 2)]`: a press anywhere on a belt selects it. */
  | { on: 'belt'; of: BindingName }
  /**
   * A bound machine's port: the first in its port order with this role. With `pick: 'free'` on an
   * output, the first output no belt docks (`freeOutputs` in `check.ts`), and nothing when every one has a belt.
   * With `pick: 'facing'` on an output, the Out the `to` machine sits on the line of (`outputFacing` in
   * `check.ts`), else the first Out.
   */
  | { on: 'port'; of: BindingName; role: PortRoleName; pick?: 'free' | 'facing'; to?: { of: BindingName; role: PortRoleName } };

export type Gesture =
  | { do: 'pressHint' }
  | { do: 'dragHint' }
  /** A drag into the one ring, from the end of the line already on the board, which the app rings itself. */
  | { do: 'dragToHint' }
  | { do: 'key'; shortcut: ShortcutId }
  | { do: 'watch' }
  /** Type `insert` into the code editor just after the text `after`, on the line the ring marks. */
  | { do: 'typeCode'; after: string; insert: string }
  /**
   * Send the request the card's request line shows. The app has no control for it: the user runs the line
   * in a terminal, so the walk sends it from the test process to the URL it reads off the panel.
   */
  | { do: 'request' }
  | { do: 'none' };

/**
 * Lesson words: plain text, a key named through `SHORTCUTS`, a machine named through `KIND_NAMES`, or a
 * fragment of code, shown as it is and never broken across lines.
 *
 * `requestLine` is a block token, not a word: the card splits the stage's text at it (`splitAtBlock`) and
 * sets the bound Route's request line on its own row between the two parts. At most one per text.
 */
export type PhraseToken = string | { key: ShortcutId } | { kind: number } | { code: string } | { requestLine: BindingName };

/** One thing a step asks for. A step's stages are read top to bottom, and the first that holds is shown. */
export interface Stage {
  id: string;
  when: StageWhen;
  hint: HintAnchor | null;
  gesture: Gesture;
  text: readonly PhraseToken[];
  /**
   * What the card says when the app refuses a gesture while this stage is shown, keyed by the
   * refusal's tag. The keys are plain strings because this folder can't import the transport's tag
   * type (the purity gate keeps `transport/` out of `src/tutorial/`); a source gate pins them to the
   * app's own tags.
   */
  coach?: Readonly<Record<string, readonly PhraseToken[]>>;
}

export interface Step {
  id: string;
  stages: readonly Stage[];
  done: Check;
}

export interface Lesson {
  id: LessonId;
  title: string;
  steps: readonly Step[];
  /** What the card says once the last step is done. */
  closing: readonly PhraseToken[];
  /**
   * The one gesture this lesson's walk makes that the app should refuse. It's required, so a lesson
   * can't compile without saying where its walk checks that a refusal leaves the step alone.
   */
  refused: {
    atStep: string;
    atStage: string;
    /**
     * Where the press lands: on a bound machine's body, or on one of its ports. The port form names a
     * Fault, which no hint can mark (`PortRoleName` has no Fault), so a lesson can point the walk at it
     * without ever ringing it for the user.
     */
    press: { on: 'machine'; of: BindingName } | { on: 'port'; of: BindingName; role: 'fault' };
    /** The refusal tag the press draws from the app, so the walk knows which coaching line to expect. */
    tag: string;
  };
}
