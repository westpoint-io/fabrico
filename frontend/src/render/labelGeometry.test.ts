// labelGeometry.test.ts - the label and chip rules a read-only board shares with the app.
//
// `chrome/LabelWords.test.tsx` already covers `readLabelWords`, `textAreaOf`,
// `labelWordsShown` and `LABEL_WORDS_MIN_ZOOM` through the chrome re-exports. This file
// covers the rest, and checks that the module stays importable without chrome.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  CHIP_GAP_PX,
  LABEL_LINE_HEIGHT,
  LABEL_TEXT_INSET,
  LABEL_WORDS_SIZE,
  chipMatchesNode,
  chipName,
  namesChip,
  textAreaOf,
  wordsElementShowsNode,
  wordsNodeIsLabel,
  type WordsNode,
} from './labelGeometry';
import * as chromeWords from '../chrome/LabelWords';
import * as chromeChips from '../chrome/MachineLabels';
import { KIND_NAMES } from '../../shared/kindNames';
import { machine_kind } from '../protocol/kinds';
import { refusedModule } from '../embed/moduleGuard';

const labelNode = (text: string, w = 2, h = 1): WordsNode => ({
  id: 3,
  kind: machine_kind.LABEL,
  cell_x: 0,
  cell_y: 0,
  w,
  h,
  label: { text, colour: 0 },
});

/** An element-shaped record carrying only what `wordsElementShowsNode` reads. */
function painted(text: string, width: string, maxHeight: string): HTMLElement {
  return { textContent: text, style: { width, maxHeight } } as unknown as HTMLElement;
}

describe('the label constants', () => {
  it('keeps the world-px sizes the words overlay lays out with', () => {
    expect(LABEL_TEXT_INSET).toBe(8);
    expect(LABEL_LINE_HEIGHT).toBe(16);
    expect(LABEL_WORDS_SIZE).toBe(12);
    expect(CHIP_GAP_PX).toBe(4);
  });
});

describe('wordsNodeIsLabel', () => {
  it('is true for a label and false for a machine or a missing node', () => {
    expect(wordsNodeIsLabel(labelNode('hi'))).toBe(true);
    expect(wordsNodeIsLabel({ ...labelNode('hi'), kind: machine_kind.SOURCE })).toBe(false);
    expect(wordsNodeIsLabel(undefined)).toBe(false);
  });
});

describe('wordsElementShowsNode', () => {
  it("agrees only when the painted words, width and clamp are this label's", () => {
    const n = labelNode('ship it', 3, 2);
    const area = textAreaOf(3, 2);
    const width = `${area.width}px`;
    const clamp = `${area.lines * LABEL_LINE_HEIGHT}px`;
    expect(wordsElementShowsNode(painted('ship it', width, clamp), n)).toBe(true);
    expect(wordsElementShowsNode(painted('other words', width, clamp), n)).toBe(false);
    expect(wordsElementShowsNode(painted('ship it', '48px', clamp), n)).toBe(false);
    expect(wordsElementShowsNode(painted('ship it', width, '16px'), n)).toBe(false);
  });
});

describe('namesChip and chipMatchesNode', () => {
  it('names every machine and never a belt or a label', () => {
    expect(namesChip(machine_kind.SOURCE)).toBe(true);
    expect(namesChip(machine_kind.FACTORY)).toBe(true);
    expect(namesChip(machine_kind.BELT)).toBe(false);
    expect(namesChip(machine_kind.LABEL)).toBe(false);
  });

  it('matches only a present node of the same chip-bearing kind', () => {
    expect(chipMatchesNode(machine_kind.SOURCE, { kind: machine_kind.SOURCE })).toBe(true);
    expect(chipMatchesNode(machine_kind.SOURCE, { kind: machine_kind.SINK })).toBe(false);
    expect(chipMatchesNode(machine_kind.LABEL, { kind: machine_kind.LABEL })).toBe(false);
    expect(chipMatchesNode(machine_kind.SOURCE, undefined)).toBe(false);
  });
});

describe('chipName', () => {
  it('reads the one name table and falls back to Machine', () => {
    expect(chipName(machine_kind.SOURCE)).toBe(KIND_NAMES[machine_kind.SOURCE]);
    expect(chipName(machine_kind.FACTORY)).toBe(KIND_NAMES[machine_kind.FACTORY]);
    expect(chipName(machine_kind.WIRE)).toBe('Machine');
  });
});

describe('the chrome files re-export the moved names', () => {
  it('hands back the same functions, so existing imports read one copy', () => {
    expect(chromeWords.textAreaOf).toBe(textAreaOf);
    expect(chromeWords.wordsNodeIsLabel).toBe(wordsNodeIsLabel);
    expect(chromeWords.wordsElementShowsNode).toBe(wordsElementShowsNode);
    expect(chromeChips.chipMatchesNode).toBe(chipMatchesNode);
    expect(chromeChips.namesChip).toBe(namesChip);
  });
});

describe('labelGeometry.ts imports', () => {
  const here = import.meta.dirname;
  const frontend = resolve(here, '../..');
  const src = readFileSync(join(here, 'labelGeometry.ts'), 'utf8');
  const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gms)].map((m) => ({
    typeOnly: m[1] !== undefined,
    spec: m[2]!,
  }));

  it('reads at least the kind-name table and the kind bytes (so this test sees the imports)', () => {
    expect(imports.map((i) => i.spec)).toEqual(
      expect.arrayContaining(['../../shared/kindNames', '../protocol/kinds']),
    );
  });

  it('imports nothing under src/chrome/, no React and no Pixi', () => {
    for (const { spec, typeOnly } of imports) {
      const path = spec.startsWith('.') ? relative(frontend, resolve(here, spec)) : `node_modules/${spec}/`;
      expect(path.startsWith('src/chrome'), `${spec} is chrome code`).toBe(false);
      expect(refusedModule(path), `${spec} is refused in the board bundle`).toBeNull();
      expect(spec.startsWith('pixi.js'), `${spec} pulls in Pixi`).toBe(false);
      // The scene handle module boots Pixi; only its types may be read here.
      if (spec === './pixiApp') expect(typeOnly, './pixiApp must be a type-only import').toBe(true);
    }
  });
});
