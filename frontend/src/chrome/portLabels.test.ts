import { describe, expect, it } from 'vitest';
import {
  MEDIUM_LABELS,
  ROLE_LABELS,
  mediumLabel,
  portRowLabel,
  roleLabel,
} from './portLabels';

// portLabels.test.ts (PANEL-02) - the single-source guard for the port row copy,
// the sibling of kindNames.test.ts. Two things are pinned here:
//
//   1. The exact 51-UI-SPEC copy contract for every DEFINED role x medium pair,
//      including the plain " - " separator (never an en/em dash - the project
//      copy rule kindNames.test.ts pins for kind names).
//   2. Totality over the OPEN byte keyspaces. `role` and `medium` are bare wire
//      bytes and decode.ts deliberately does not reject unknown values, so a
//      newer (or hostile) host byte reaches the panel. It must degrade to a
//      legible word, never throw inside render (threat T-51-01) - a throw here
//      would blank the whole config panel over one unrecognised byte.

// The exact copy contract from 51-UI-SPEC ("Copywriting Contract"). Duplicated
// here on purpose: this is the falsifiable reference the maps are gated against
// (never imported from the maps it validates).
const ROLE_COPY: Record<number, string> = { 0: 'Input', 1: 'Output', 2: 'Fault' };
const MEDIUM_COPY: Record<number, string> = { 0: 'Item', 1: 'Wire' };

/** Build the minimal port shape `portRowLabel` reads. */
const port = (role: number, medium: number): { role: number; medium: number } => ({ role, medium });

describe('portRowLabel - the "{Role} - {Medium}" copy contract (PANEL-02)', () => {
  it('maps every defined role x medium pair to its exact string', () => {
    expect(portRowLabel(port(0, 0))).toBe('Input - Item');
    expect(portRowLabel(port(1, 0))).toBe('Output - Item');
    expect(portRowLabel(port(2, 0))).toBe('Fault - Item');
    expect(portRowLabel(port(0, 1))).toBe('Input - Wire');
    expect(portRowLabel(port(1, 1))).toBe('Output - Wire');
    expect(portRowLabel(port(2, 1))).toBe('Fault - Wire');
  });

  it('joins with a PLAIN space-hyphen-space, never an en/em dash', () => {
    for (const role of [0, 1, 2, 9]) {
      for (const medium of [0, 1, 9]) {
        const label = portRowLabel(port(role, medium));
        expect(label, `"${label}" uses the plain separator`).toContain(' - ');
        expect(label.includes('—'), `"${label}" has no em dash`).toBe(false);
        expect(label.includes('–'), `"${label}" has no en dash`).toBe(false);
      }
    }
  });

  it('matches the ROLE_LABELS / MEDIUM_LABELS maps exactly (no drift)', () => {
    for (const [byte, word] of Object.entries(ROLE_COPY)) {
      expect(ROLE_LABELS[Number(byte)], `role ${byte}`).toBe(word);
    }
    for (const [byte, word] of Object.entries(MEDIUM_COPY)) {
      expect(MEDIUM_LABELS[Number(byte)], `medium ${byte}`).toBe(word);
    }
    expect(Object.keys(ROLE_LABELS).length, 'ROLE_LABELS has no extra entries').toBe(3);
    expect(Object.keys(MEDIUM_LABELS).length, 'MEDIUM_LABELS has no extra entries').toBe(2);
  });
});

describe('portRowLabel - open-byte tolerance (T-51-01)', () => {
  it('falls back to "Output" for an unknown role byte', () => {
    expect(roleLabel(9)).toBe('Output');
    expect(portRowLabel(port(9, 0))).toBe('Output - Item');
  });

  it('falls back to "Item" for an unknown medium byte', () => {
    expect(mediumLabel(9)).toBe('Item');
    expect(portRowLabel(port(1, 9))).toBe('Output - Item');
  });

  it('never throws for ANY byte value, including the hostile edges', () => {
    const edges = [-1, 0, 1, 2, 3, 9, 127, 255, 256, Number.MAX_SAFE_INTEGER, NaN];
    for (const role of edges) {
      for (const medium of edges) {
        expect(() => portRowLabel(port(role, medium)), `role ${role} / medium ${medium}`).not.toThrow();
        expect(portRowLabel(port(role, medium)).length).toBeGreaterThan(0);
      }
    }
  });
});
