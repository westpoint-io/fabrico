// types.ts - the data a lesson is written in, and the plain facts the lesson engine reads.
//
// Pure: no React, no Pixi, no DOM. The engine sees the board and the chrome only through these
// shapes, so it can run in a node test and in the walk test, and it holds nothing that could send
// a command.

import type { ShortcutId } from '../input/shortcuts';

export type LessonId = 'your-first-line' | 'delete-and-undo';
/**
 * What a step can bind. `belt`, `beltIn`, `beltOut` and `beltOut2` are belts, each found by the two
 * machines `BELT_ENDS` in `check.ts` names for it; the rest are machines, each found by its `nodeKey`.
 */
export type BindingName = 'source' | 'sink' | 'belt' | 'factory' | 'sink2' | 'beltIn' | 'beltOut' | 'beltOut2';

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

/** What a frame knows about the board. `FabricoScene` satisfies this structurally. */
export interface BoardFacts {
  tick: number;
  generation: number;
  swapFloor: number;
  nodes: readonly BoardNode[];
  belts: readonly BoardBelt[];
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
  view: {
    camera: { x: number; y: number; scale: number };
    freeArea: { left: number; right: number; top: number; bottom: number };
  };
}

export type Check =
  | { is: 'nodeAppeared'; kind: number; bind: BindingName }
  | { is: 'triggerApplied'; of: BindingName; trigger: 'Timer' }
  | { is: 'beltJoins'; a: BindingName; b: BindingName; bind: BindingName }
  | { is: 'tickRose' }
  | { is: 'itemArrived'; at: BindingName }
  /** The bound machine left the board while the generation stayed where it was when the step began: a Delete, not an Undo. */
  | { is: 'nodeGone'; of: BindingName }
  /** No belt joins the two machines `BELT_ENDS` names for this binding, with the generation unchanged since the step began. */
  | { is: 'beltGone'; of: BindingName }
  /** The board's shape, with no handle in it, equals the shape captured when the step `since` began. */
  | { is: 'restored'; since: string };

export type StageWhen =
  | { is: 'always' }
  | { is: 'paused' }
  | { is: 'toolArmed'; machineKind: number }
  | { is: 'toolNotArmed'; machineKind: number }
  | { is: 'anyToolArmed' }
  | { is: 'beltNotArmed' }
  | { is: 'beltArmed' }
  /** The Belt tool is armed, and the line leaving this machine stops short with an end a press can carry on from. */
  | { is: 'lineStopsShort'; from: BindingName }
  /** The Belt tool is armed, and a belt on the way from one machine to the other can only be undone, until it's gone. */
  | { is: 'lineStuck'; from: BindingName; to: BindingName }
  | { is: 'notSelected'; of: BindingName }
  /**
   * The bound thing is off the board. A machine: no node holds its `nodeKey`. A belt: no belt tile sits
   * on any tile it had in the restored check's capture, or with no capture, no belt joins its two machines.
   */
  | { is: 'gone'; of: BindingName }
  | { is: 'triggerNotPressed'; trigger: 'Timer' }
  | { is: 'triggerNotApplied'; trigger: 'Timer' };

/** A chrome control a ring can mark. Each resolves by the control's own name or state, so a renamed control fails the walk. */
export type PanelTarget =
  | { kind: 'placeMachine'; machineKind: number }
  | { kind: 'playButton' }
  | { kind: 'armedTool' }
  | { kind: 'beltTool' }
  | { kind: 'segment'; group: 'Trigger'; label: 'Timer' }
  | { kind: 'applyButton' }
  | { kind: 'undoButton' };

export type PortRoleName = 'out' | 'in';

export type HintAnchor =
  | { on: 'panel'; target: PanelTarget }
  | { on: 'floor'; spot: 'source' | 'sink' }
  | { on: 'machine'; of: BindingName }
  /** A bound belt's middle tile, `tiles[floor(n / 2)]`: a press anywhere on a belt selects it. */
  | { on: 'belt'; of: BindingName }
  | { on: 'port'; of: BindingName; role: PortRoleName; to?: { of: BindingName; role: PortRoleName } };

export type Gesture =
  | { do: 'pressHint' }
  | { do: 'dragHint' }
  /** A drag into the one ring, from the end of the line already on the board, which the app rings itself. */
  | { do: 'dragToHint' }
  | { do: 'key'; shortcut: ShortcutId }
  | { do: 'watch' }
  | { do: 'none' };

/** Lesson words: plain text, a key named through `SHORTCUTS`, or a machine named through `KIND_NAMES`. */
export type PhraseToken = string | { key: ShortcutId } | { kind: number };

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
    press: { on: 'machine'; of: BindingName };
    /** The refusal tag the press draws from the app, so the walk knows which coaching line to expect. */
    tag: string;
  };
}
