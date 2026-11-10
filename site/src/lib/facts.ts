// How a page's <Fact id="..." /> becomes text, decided while the site builds. The values come from
// src/generated/facts.json, which `npm run facts` writes from the Rust and TypeScript sources. An
// id the file doesn't hold fails the build with a message naming the page and the id, so a page
// can never show a stale or made-up value.
//
// No Astro import here: the unit tests load this file with plain Node.

/** A number with its unit, such as 1024 tiles. `also` holds other spellings of the unit. */
export interface QuantityFact {
  kind: 'quantity';
  value: number;
  unit: string;
  also?: string[];
  source: string;
  symbol?: string;
}

/** A name from the code, such as a fault reason or a config field. */
export interface CodeFact {
  kind: 'code';
  value: string;
  source: string;
  symbol?: string;
}

/** A message the app shows, such as a refusal. */
export interface TextFact {
  kind: 'text';
  value: string;
  source: string;
  symbol?: string;
}

/** A keyboard shortcut: its label on Linux and Windows, and on macOS. */
export interface ShortcutFact {
  kind: 'shortcut';
  label: string;
  labelMac: string;
  helpOmits?: boolean;
  source: string;
  symbol?: string;
}

export type Fact = QuantityFact | CodeFact | TextFact | ShortcutFact;

/** The parts of facts.json this file reads. */
export interface FactsFile {
  facts: Record<string, Fact>;
}

/**
 * What <Fact> renders. `text` is the plain text a reader sees for quantities, code and text.
 * A shortcut is a list of key groups: `[['Ctrl', 'S']]` is Ctrl+S, `[['Delete'], ['Backspace']]`
 * is Delete or Backspace. `mac` is the macOS form, or null when it reads the same.
 */
export type FactView =
  | { kind: 'quantity'; text: string; bare: boolean }
  | { kind: 'code'; text: string }
  | { kind: 'shortcut'; groups: string[][]; mac: string[][] | null };

/** The fact a page asks for, or a thrown Error with the message an author sees in the build log. */
export function resolveFact(id: string | undefined, page: string, facts: FactsFile): Fact {
  const key = id ?? '';
  const fact = Object.hasOwn(facts.facts, key) ? facts.facts[key] : undefined;
  if (fact === undefined) {
    throw new Error(
      `[Fact] ${page} asks for fact "${key}", and site/src/generated/facts.json has no fact with that id. ` +
        'Check the id against that file, or regenerate it with npm run facts from site/.',
    );
  }
  return fact;
}

/** The render model for a fact. `bare` drops a quantity's unit, for tables that name it in a heading. */
export function formatFact(fact: Fact, options: { bare?: boolean } = {}): FactView {
  switch (fact.kind) {
    case 'quantity': {
      const bare = options.bare === true;
      const number = fact.value.toLocaleString('en-US');
      return { kind: 'quantity', text: bare ? number : `${number} ${fact.unit}`, bare };
    }
    case 'code':
    case 'text':
      return { kind: 'code', text: fact.value };
    case 'shortcut': {
      const groups = keyGroups(fact.label);
      const mac = fact.labelMac === fact.label ? null : keyGroups(fact.labelMac);
      return { kind: 'shortcut', groups, mac };
    }
  }
}

/** A shortcut label as key groups: "Ctrl+Shift+S" is one group of three keys, "Delete or Backspace" two groups. */
export function keyGroups(label: string): string[][] {
  return label.split(' or ').map((group) => group.split('+'));
}

/** A key group list back as text, the way a reader sees it: "Ctrl+S", "Delete or Backspace". */
export function groupsText(groups: readonly (readonly string[])[]): string {
  return groups.map((group) => group.join('+')).join(' or ');
}
