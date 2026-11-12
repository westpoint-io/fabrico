// controlLabels.ts - the words two chrome controls show, kept in one place.
//
// The tutorial types these same words into its lessons, because `src/tutorial/` can't import from
// `chrome/`, and `lessonCoverage.source.test.ts` pins each typed word to the constant here. This file
// imports nothing, so the lesson layer can read it without pulling in a component that reaches the host.

/**
 * The label on the Route inspector's URL row. The tutorial types the same word, and the coverage gate
 * pins it here, so a rename reaches the lesson or fails the gate.
 */
export const ROUTE_URL_LABEL = 'POST URL';

/**
 * The word on the palette's Wire tool row, which is also its accessible name. The tutorial types the same
 * word, and the coverage gate pins it here, so a rename reaches the lesson or fails the gate.
 */
export const WIRE_TOOL_LABEL = 'Wire';
