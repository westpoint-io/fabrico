// types.ts - the data a lesson is written in, and the plain facts the lesson engine reads.
//
// Pure: no React, no Pixi, no DOM. The engine sees the board and the chrome only through these
// shapes, so it can run in a node test and in the walk test, and it holds nothing that could send
// a command.

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
  view: {
    camera: { x: number; y: number; scale: number };
    freeArea: { left: number; right: number; top: number; bottom: number };
  };
}

export type Check = { is: 'nodeAppeared'; kind: number; bind: BindingName };

export type StageWhen =
  | { is: 'always' }
  | { is: 'toolArmed'; machineKind: number }
  | { is: 'toolNotArmed'; machineKind: number };

export type HintAnchor =
  | { on: 'panel'; target: { kind: 'placeMachine'; machineKind: number } }
  | { on: 'floor'; spot: 'source' | 'sink' };

export type Gesture = { do: 'pressHint' } | { do: 'none' };

/** One thing a step asks for. A step's stages are read top to bottom, and the first that holds is shown. */
export interface Stage {
  id: string;
  when: StageWhen;
  hint: HintAnchor | null;
  gesture: Gesture;
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
}
