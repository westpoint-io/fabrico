// portLabels.ts (PANEL-02) - the FIRST role/medium display strings in the app.
//
// The Legend / kindNames maps name machine KINDS and state cues; nothing has ever
// named a PORT. The config panel's read-only I/O list needs two tiny maps plus one
// join, and they live here (not inside the component) so the copy contract is
// unit-pinnable exactly like KIND_NAMES is (kindNames.test.ts).
//
// Copy contract (51-UI-SPEC "Copywriting Contract"): a row reads
// `{Role} - {Medium}` - e.g. "Output - Item", "Input - Item", "Fault - Item",
// "Output - Wire" - joined with a PLAIN space-hyphen-space. Never an en/em dash
// (the project copy rule; kindNames.test.ts pins the same ban on kind names).
//
// Open keyspaces: `role` and `medium` are bare bytes on the wire and decode.ts
// deliberately does NOT reject unknown values (the open-byte tolerance at
// decode.ts:280-292 - a newer host may add a role/medium the frontend predates).
// So both lookups FALL BACK rather than throw: an unknown role reads as an
// output, an unknown medium as an item. A hostile or simply newer byte must
// never blank the panel or throw inside render (threat T-51-01).

import type { PortView } from '../protocol/decode.ts';

/** Role byte -> display word. Core `Role { In=0, Out=1, Fault=2 }` (state.rs:703). */
export const ROLE_LABELS: Record<number, string> = {
  0: 'Input',
  1: 'Output',
  2: 'Fault',
};

/** Medium byte -> display word. Core `Medium { Mechanical=0, Electrical=1 }`
 *  (state.rs:731); Mechanical carries ITEMS, Electrical carries a WIRE signal. */
export const MEDIUM_LABELS: Record<number, string> = {
  0: 'Item',
  1: 'Wire',
};

/** The open-byte fallbacks: an unrecognised role is shown as an output, an
 *  unrecognised medium as an item (the conservative, never-throwing read). */
export const ROLE_FALLBACK = 'Output';
export const MEDIUM_FALLBACK = 'Item';

/** The row separator: a PLAIN hyphen with single spaces. Never U+2014/U+2013. */
export const LABEL_SEPARATOR = ' - ';

/** Role byte -> word, falling back for an unknown (newer/hostile) byte. */
export function roleLabel(role: number): string {
  return ROLE_LABELS[role] ?? ROLE_FALLBACK;
}

/** Medium byte -> word, falling back for an unknown (newer/hostile) byte. */
export function mediumLabel(medium: number): string {
  return MEDIUM_LABELS[medium] ?? MEDIUM_FALLBACK;
}

/**
 * The one port-row string: `{Role} - {Medium}`. Total over the open keyspaces -
 * it never throws, so a packet carrying a role/medium this build predates still
 * renders a legible row.
 */
export function portRowLabel(port: Pick<PortView, 'role' | 'medium'>): string {
  return `${roleLabel(port.role)}${LABEL_SEPARATOR}${mediumLabel(port.medium)}`;
}
