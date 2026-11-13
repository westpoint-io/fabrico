// answerAWebRequest.ts - the lesson that builds a Route and an HTTP Handler, wires them, and answers a
// real web request the user sends with curl.
//
// The last step finishes on the reply coming back along the return wire, read off the scene's own reply
// count, so nothing here watches the clipboard or the terminal. The card's request line is a block token:
// the layer fills it with the URL it read off the inspector's POST URL row, so the tutorial reads nothing
// from the host beyond what the panel already shows. Machine and key names are tokens; the control words
// Copy, POST URL and Wire are typed, each pinned to its control's constant by `lessonCoverage.source.test.ts`.

import { BOARD_PAUSED, HANDLER_KIND, PLACE_BY_TOP_LEFT, PLACE_ON_THE_FLOOR, ROUTE_KIND, TOOL_DOWN } from '../commonStages';
import { PORT_ZERO_WORDS } from '../request';
import type { Lesson } from '../types';

/**
 * The Copy button's resting word on the POST URL row, typed because `src/tutorial/` can't import `chrome/`.
 * `lessonCoverage.source.test.ts` pins it to `COPY_LABELS.idle` in `WebhookUrlRow.tsx`.
 */
export const COPY_WORD = 'Copy';

/**
 * The Route inspector's URL row label, typed for the same reason. `lessonCoverage.source.test.ts` pins it
 * to `ROUTE_URL_LABEL` in `controlLabels.ts`.
 */
export const ROUTE_URL_WORDS = 'POST URL';

/**
 * The palette's Wire tool word, typed for the same reason. `lessonCoverage.source.test.ts` pins it to
 * `WIRE_TOOL_LABEL` in `controlLabels.ts`.
 */
export const WIRE_WORDS = 'Wire';

/**
 * What the POST URL row reads with no bound URL, typed for the same reason. `lessonCoverage.source.test.ts`
 * pins it to `URL_NOT_READY_TEXT` in `WebhookUrlRow.tsx`.
 */
export const URL_NOT_READY_WORDS = 'Webhook not ready';

export const ANSWER_A_WEB_REQUEST: Lesson = {
  id: 'answer-a-web-request',
  title: 'Answer a web request',
  steps: [
    {
      id: 'place-route',
      stages: [
        BOARD_PAUSED,
        {
          id: 'route-tool',
          when: { is: 'toolNotArmed', machineKind: ROUTE_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: ROUTE_KIND } },
          gesture: { do: 'pressHint' },
          text: ['A ', { kind: ROUTE_KIND }, ' gives the board a web address that answers requests. Click ', { kind: ROUTE_KIND }, ' in the palette.'],
        },
        {
          id: 'route-floor',
          when: { is: 'toolArmed', machineKind: ROUTE_KIND },
          hint: { on: 'floor', spot: 'centredRoute' },
          gesture: { do: 'pressHint' },
          text: [PLACE_ON_THE_FLOOR],
        },
      ],
      done: { is: 'nodeAppeared', kind: ROUTE_KIND, bind: 'route' },
    },
    {
      id: 'place-handler',
      stages: [
        BOARD_PAUSED,
        {
          id: 'handler-tool',
          when: { is: 'toolNotArmed', machineKind: HANDLER_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: HANDLER_KIND } },
          gesture: { do: 'pressHint' },
          text: ['An ', { kind: HANDLER_KIND }, ' writes the reply to each request. Click ', { kind: HANDLER_KIND }, ' in the palette.'],
        },
        {
          id: 'handler-floor',
          when: { is: 'toolArmed', machineKind: HANDLER_KIND },
          hint: { on: 'floor', spot: 'handler' },
          gesture: { do: 'pressHint' },
          text: [PLACE_BY_TOP_LEFT],
        },
      ],
      done: { is: 'nodeAppeared', kind: HANDLER_KIND, bind: 'handler' },
    },
    {
      id: 'wire',
      stages: [
        BOARD_PAUSED,
        {
          id: 'wire-tool',
          when: { is: 'wireNotArmed' },
          hint: { on: 'panel', target: { kind: 'wireTool' } },
          gesture: { do: 'pressHint' },
          text: ['A wire carries a web request from one machine to another. Click ' + WIRE_WORDS + ' in the palette.'],
        },
        {
          id: 'wire-draw',
          when: { is: 'wireArmed' },
          hint: { on: 'port', of: 'route', role: 'out', to: { of: 'handler', role: 'in' } },
          gesture: { do: 'dragHint' },
          text: ['Drag from the ', { kind: ROUTE_KIND }, "'s output dot to the ", { kind: HANDLER_KIND }, "'s input dot. One drag lays the cable both ways."],
          coach: {
            // A press on the Handler's Fault, which only takes belts.
            BeltOnlyPort: ["Wires can't use that dot. Start the drag from the ", { kind: ROUTE_KIND }, "'s output dot, in the ring."],
            // A drag from the Route's output dropped on the Handler's Fault.
            MediumMismatch: ["Wires can't end on that dot. Drop the wire on the ", { kind: HANDLER_KIND }, "'s input dot, in the ring."],
          },
        },
      ],
      done: { is: 'wireJoins', a: 'route', b: 'handler' },
    },
    {
      id: 'answer',
      stages: [
        // Its own paused stage: a paused board turns a request away and queues nothing, so the shared
        // sentence about edits waiting would be wrong here.
        {
          id: 'request-paused',
          when: { is: 'paused' },
          hint: { on: 'panel', target: { kind: 'playButton' } },
          gesture: { do: 'pressHint' },
          text: ['The board is paused, so it turns requests away. Press Play in the toolbar, or press ', { key: 'playPause' }, '.'],
        },
        {
          ...TOOL_DOWN,
          // The likeliest slip: a second drag with the Wire tool still armed, where the band's own
          // sentence says to disconnect, which is the wrong advice here.
          coach: {
            PortOccupied: ['The ', { kind: ROUTE_KIND }, ' and ', { kind: HANDLER_KIND }, ' are already wired. Press ', { key: 'escape' }, ' to put the ' + WIRE_WORDS + ' tool down.'],
          },
        },
        {
          id: 'select-route',
          when: { is: 'notSelected', of: 'route' },
          hint: { on: 'machine', of: 'route' },
          gesture: { do: 'pressHint' },
          text: ['Click the ', { kind: ROUTE_KIND }, ' to show its ' + ROUTE_URL_WORDS + ' in the panel.'],
        },
        {
          id: 'url-pending',
          when: { is: 'urlNotRead', of: 'route' },
          hint: null,
          gesture: { do: 'none' },
          // Two screens land here: the row's not-ready words, and a port 0 URL from a failed bind, which
          // the card refuses. The advice names what the row shows in each.
          text: ['Waiting for the ' + ROUTE_URL_WORDS + ' to show in the panel. If it says ' + URL_NOT_READY_WORDS + ' or shows ' + PORT_ZERO_WORDS + ', restart Fabrico.'],
        },
        {
          id: 'send-request',
          when: { is: 'always' },
          hint: { on: 'panel', target: { kind: 'copyUrlButton' } },
          gesture: { do: 'request' },
          text: [
            'Press ' + COPY_WORD + ' on the ' + ROUTE_URL_WORDS + ' row. In a terminal beside the board, type this line, pasting the URL after POST, and press Enter:',
            { requestLine: 'route' },
            'If curl printed ',
            { code: 'overloaded' },
            ', the board was paused. Press Play and run it again.',
          ],
        },
      ],
      done: { is: 'replyPulseRose', from: 'handler', to: 'route' },
    },
  ],
  closing: [
    'A ',
    { kind: ROUTE_KIND },
    ' answers web requests at its URL, and the ',
    { kind: HANDLER_KIND },
    "'s code writes the reply that goes back along the wire.",
  ],
  // A press on the Handler's Fault with the Wire tool armed, which the app refuses before any command.
  refused: {
    atStep: 'wire',
    atStage: 'wire-draw',
    press: { on: 'port', of: 'handler', role: 'fault' },
    tag: 'BeltOnlyPort',
  },
};
