// twoOutputs.ts - the lesson that gives a Factory a second output and changes its code to use it.
//
// "+ Add output" comes first, before any belt or Sink: the host refuses a growth that would cover a belt,
// and each Sink's spot is worked out from the Factory's final box. The Factory's default code emits on its
// first output only, so the last step asks the user to add a second emit and press Apply, and its check
// reads both belts and never the code. Machine and key names are tokens, never typed words, and
// `auditLessonWords` fails on a typed one. Control labels (Apply, Outputs, + Add output) are typed, like
// lesson 1's Timer, and the walk reads them off the real controls.

import {
  BOARD_PAUSED,
  FACTORY_KIND,
  PLACE_ON_THE_FLOOR,
  SET_TIMER_STAGES,
  SINK_KIND,
  SOURCE_KIND,
  TOOL_DOWN,
  BELT_KIND,
  beltStages,
} from '../commonStages';
import type { Lesson } from '../types';

/**
 * The add-output button's label, typed because `src/tutorial/` can't import `chrome/`.
 * `lessonCoverage.source.test.ts` pins it to `ADD_OUTPUT_LABEL` in `PortsSection.tsx`.
 */
export const ADD_OUTPUT_WORDS = '+ Add output';

/** The emit the Factory's default code already makes, on its first output. */
const FIRST_EMIT = 'ctx.emit(0, input);';
/** The emit the user adds, on the second output. */
const SECOND_EMIT = 'ctx.emit(1, input);';

export const TWO_OUTPUTS: Lesson = {
  id: 'a-factory-with-two-outputs',
  title: 'A Factory with two outputs',
  steps: [
    {
      id: 'place-source',
      stages: [
        BOARD_PAUSED,
        {
          id: 'source-tool',
          when: { is: 'toolNotArmed', machineKind: SOURCE_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: SOURCE_KIND } },
          gesture: { do: 'pressHint' },
          text: ['Start with a ', { kind: SOURCE_KIND }, '. Click ', { kind: SOURCE_KIND }, ' in the palette.'],
        },
        {
          id: 'source-floor',
          when: { is: 'toolArmed', machineKind: SOURCE_KIND },
          hint: { on: 'floor', spot: 'centredSource' },
          gesture: { do: 'pressHint' },
          text: [PLACE_ON_THE_FLOOR],
        },
      ],
      done: { is: 'nodeAppeared', kind: SOURCE_KIND, bind: 'source' },
    },
    {
      id: 'set-timer',
      stages: [BOARD_PAUSED, ...SET_TIMER_STAGES],
      done: { is: 'triggerApplied', of: 'source', trigger: 'Timer' },
    },
    {
      id: 'place-factory',
      stages: [
        BOARD_PAUSED,
        {
          id: 'factory-tool',
          when: { is: 'toolNotArmed', machineKind: FACTORY_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: FACTORY_KIND } },
          gesture: { do: 'pressHint' },
          text: ['A ', { kind: FACTORY_KIND }, ' runs code on every item that comes in. Click ', { kind: FACTORY_KIND }, ' in the palette.'],
        },
        {
          id: 'factory-floor',
          when: { is: 'toolArmed', machineKind: FACTORY_KIND },
          hint: { on: 'floor', spot: 'factory' },
          gesture: { do: 'pressHint' },
          text: ['Click the floor to place it. The ring marks a free cell for its top left corner, but any free spot works.'],
        },
      ],
      done: { is: 'nodeAppeared', kind: FACTORY_KIND, bind: 'factory' },
    },
    {
      id: 'add-output',
      stages: [
        BOARD_PAUSED,
        TOOL_DOWN,
        {
          id: 'select-factory',
          when: { is: 'notSelected', of: 'factory' },
          hint: { on: 'machine', of: 'factory' },
          gesture: { do: 'pressHint' },
          text: ['Click the ', { kind: FACTORY_KIND }, ' to select it.'],
        },
        {
          id: 'press-add-output',
          when: { is: 'always' },
          hint: { on: 'panel', target: { kind: 'addOutputButton' } },
          gesture: { do: 'pressHint' },
          text: ['A new ', { kind: FACTORY_KIND }, ' has one output. Under Outputs, press ' + ADD_OUTPUT_WORDS + ' to give it a second.'],
        },
      ],
      done: { is: 'portAdded', of: 'factory', outs: 2 },
    },
    {
      id: 'place-sink',
      stages: [
        BOARD_PAUSED,
        {
          id: 'sink-tool',
          when: { is: 'toolNotArmed', machineKind: SINK_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: SINK_KIND } },
          gesture: { do: 'pressHint' },
          text: ['Each output needs somewhere to send items. Click ', { kind: SINK_KIND }, ' in the palette.'],
        },
        {
          id: 'sink-floor',
          when: { is: 'toolArmed', machineKind: SINK_KIND },
          hint: { on: 'floor', spot: 'firstOutputSink' },
          gesture: { do: 'pressHint' },
          text: [PLACE_ON_THE_FLOOR],
        },
      ],
      done: { is: 'nodeAppeared', kind: SINK_KIND, bind: 'sink' },
    },
    {
      id: 'place-second-sink',
      stages: [
        BOARD_PAUSED,
        {
          id: 'second-sink-tool',
          when: { is: 'toolNotArmed', machineKind: SINK_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: SINK_KIND } },
          gesture: { do: 'pressHint' },
          text: ['Click ', { kind: SINK_KIND }, ' in the palette again.'],
        },
        {
          id: 'second-sink-floor',
          when: { is: 'toolArmed', machineKind: SINK_KIND },
          hint: { on: 'floor', spot: 'freeOutputSink' },
          gesture: { do: 'pressHint' },
          text: ['Place a second ', { kind: SINK_KIND }, ' in the ring, for the second output.'],
          coach: {
            FootprintCollision: [
              'The ',
              { kind: FACTORY_KIND },
              ' covers that cell, so the ',
              { kind: SINK_KIND },
              " wasn't placed. Click the free cell in the ring.",
            ],
          },
        },
      ],
      done: { is: 'nodeAppeared', kind: SINK_KIND, bind: 'sink2' },
    },
    {
      id: 'belt-in',
      stages: [
        BOARD_PAUSED,
        ...beltStages(
          { bind: 'source', kind: SOURCE_KIND },
          { bind: 'factory', kind: FACTORY_KIND },
          {
            draw: ['Drag from the ', { kind: SOURCE_KIND }, "'s output dot to the ", { kind: FACTORY_KIND }, "'s input dot."],
            carryOn: ['That ', { kind: BELT_KIND }, ' stops before the ', { kind: FACTORY_KIND }, '. Drag from the ring at its end to the ', { kind: FACTORY_KIND }, "'s input dot."],
          },
        ),
      ],
      done: { is: 'beltJoins', a: 'source', b: 'factory', bind: 'beltIn' },
    },
    {
      id: 'belt-out',
      stages: [
        BOARD_PAUSED,
        ...beltStages(
          { bind: 'factory', kind: FACTORY_KIND },
          { bind: 'sink', kind: SINK_KIND },
          {
            // The ring marks the output the first Sink sits on the line of, so this belt runs along its own row.
            pick: 'facing',
            draw: ['Drag from the ', { kind: FACTORY_KIND }, "'s output dot to the first ", { kind: SINK_KIND }, "'s input dot."],
          },
        ),
      ],
      done: { is: 'beltJoins', a: 'factory', b: 'sink', bind: 'beltOut' },
    },
    {
      id: 'belt-out-2',
      stages: [
        BOARD_PAUSED,
        ...beltStages(
          { bind: 'factory', kind: FACTORY_KIND },
          { bind: 'sink2', kind: SINK_KIND },
          {
            pick: 'free',
            draw: ['The ', { kind: FACTORY_KIND }, "'s other output is still free. Drag from it to the second ", { kind: SINK_KIND }, "'s input dot."],
            // The likeliest slip: dragging from the output that already has a belt.
            drawCoach: {
              PortOccupied: ['That output already has a ', { kind: BELT_KIND }, '. Start from the ', { kind: FACTORY_KIND }, "'s other output dot, in the ring."],
            },
          },
        ),
      ],
      done: { is: 'beltJoins', a: 'factory', b: 'sink2', bind: 'beltOut2' },
    },
    {
      id: 'change-code',
      // The stages read the editor and the panel's not-applied marker: select the Factory, type the
      // second emit, press Apply, then watch. The tutorial never writes the editor; the user types.
      stages: [
        BOARD_PAUSED,
        TOOL_DOWN,
        {
          id: 'select-factory',
          when: { is: 'notSelected', of: 'factory' },
          hint: { on: 'machine', of: 'factory' },
          gesture: { do: 'pressHint' },
          text: ['Click the ', { kind: FACTORY_KIND }, ' to select it, so its code shows in the panel.'],
        },
        {
          id: 'type-code',
          when: { is: 'codeUnchanged', of: 'factory' },
          hint: { on: 'panel', target: { kind: 'codeLine', holds: FIRST_EMIT } },
          gesture: { do: 'typeCode', after: FIRST_EMIT, insert: ` ${SECOND_EMIT}` },
          text: ['The code only uses the first output. Click just after ', { code: FIRST_EMIT }, ' and type ', { code: SECOND_EMIT }, ' to use the second.'],
        },
        {
          id: 'apply-code',
          when: { is: 'codeNotApplied' },
          hint: { on: 'panel', target: { kind: 'applyButton' } },
          gesture: { do: 'pressHint' },
          text: ['Press Apply to put the new code on the board. If the panel shows an error, check the line you typed.'],
        },
        {
          id: 'watch',
          when: { is: 'always' },
          hint: { on: 'machine', of: 'sink2' },
          gesture: { do: 'watch' },
          text: ['Watch the dots ride out of both outputs into each ', { kind: SINK_KIND }, '. If one gets none, check the line you typed and press Apply again.'],
        },
      ],
      done: { is: 'itemsArriveAtBoth', at: ['sink', 'sink2'] },
    },
  ],
  closing: [
    'A ',
    { kind: FACTORY_KIND },
    "'s code decides which output each item leaves by: ",
    { code: 'ctx.emit(0, input)' },
    ' for the first, ',
    { code: 'ctx.emit(1, input)' },
    ' for the second.',
  ],
  // A Sink pressed off-centre on the Factory's body, which the host refuses as a collision.
  refused: {
    atStep: 'place-second-sink',
    atStage: 'second-sink-floor',
    press: { on: 'machine', of: 'factory' },
    tag: 'FootprintCollision',
  },
};
