// types.ts - the data a lesson is written in, and the plain facts the lesson engine reads.
//
// Pure: no React, no Pixi, no DOM. The engine sees the board and the chrome only through these
// shapes, so it can run in a node test and in the walk test, and it holds nothing that could send
// a command.

import type { ShortcutId } from '../input/shortcuts';

export type LessonId = 'your-first-line';
export type BindingName = 'source' | 'sink' | 'belt';

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
  playing: boolean;
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
  | { is: 'itemArrived'; at: BindingName };

export type StageWhen =
  | { is: 'always' }
  | { is: 'paused' }
  | { is: 'toolArmed'; machineKind: number }
  | { is: 'toolNotArmed'; machineKind: number }
  | { is: 'anyToolArmed' }
  | { is: 'beltNotArmed' }
  | { is: 'beltArmed' }
  | { is: 'notSelected'; of: BindingName }
  | { is: 'triggerNotPressed'; trigger: 'Timer' }
  | { is: 'triggerNotApplied'; trigger: 'Timer' };

/** A chrome control a ring can mark. Each resolves by the control's own name or state, so a renamed control fails the walk. */
export type PanelTarget =
  | { kind: 'placeMachine'; machineKind: number }
  | { kind: 'playButton' }
  | { kind: 'armedTool' }
  | { kind: 'beltTool' }
  | { kind: 'segment'; group: 'Trigger'; label: 'Timer' }
  | { kind: 'applyButton' };

export type PortRoleName = 'out' | 'in';

export type HintAnchor =
  | { on: 'panel'; target: PanelTarget }
  | { on: 'floor'; spot: 'source' | 'sink' }
  | { on: 'machine'; of: BindingName }
  | { on: 'port'; of: BindingName; role: PortRoleName; to?: { of: BindingName; role: PortRoleName } };

export type Gesture =
  | { do: 'pressHint' }
  | { do: 'dragHint' }
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
  refused: { atStep: string; atStage: string; press: { on: 'machine'; of: BindingName } };
}
