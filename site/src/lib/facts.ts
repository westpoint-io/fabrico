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

/** One port of a machine, as the catalog lists it. `local_offset` is [column, row] from the top-left cell. */
export interface MachinePort {
  role: string;
  medium: string;
  side: string;
  local_offset: [number, number];
}

/** One entry of facts.json `machines[]`: a machine kind as the code defines it. */
export interface MachineEntry {
  kind: number;
  name: string;
  catalog: boolean;
  footprint: { w: number; h: number } | null;
  ports: MachinePort[];
  config: string | null;
  configFields: string[];
}

/** The parts of facts.json this file reads. */
export interface FactsFile {
  facts: Record<string, Fact>;
  machines?: MachineEntry[];
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

/**
 * The anchor id of a fault.* or refusal.* troubleshooting entry: the prefix, a hyphen, then the
 * name with a hyphen before each capital that follows a lower-case letter or digit, all
 * lower-cased. refusal.BeltTooLong gives refusal-belt-too-long. Capitals in a row get no hyphen
 * between them (refusal.HTTPError gives refusal-httperror). frontend/e2e-docs/troubleshooting.spec.ts
 * computes the same id on its own, so a change here fails that check.
 */
export function fixAnchor(id: string): string {
  const dot = id.indexOf('.');
  const prefix = id.slice(0, dot);
  const name = id.slice(dot + 1).replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  return `${prefix}-${name}`.toLowerCase();
}

/**
 * The anchor id of a hand-written troubleshooting entry: "symptom-", then the text lower-cased,
 * with each run of characters other than a-z and 0-9 turned into one hyphen and the hyphens at
 * either end trimmed. "Items stop at the end of a belt" gives symptom-items-stop-at-the-end-of-a-belt.
 */
export function symptomAnchor(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `symptom-${slug}`;
}

/** What one <Fix> entry is about: a fact from facts.json, or a symptom written on the page. */
export type FixTarget =
  | { kind: 'fact'; id: string; anchor: string }
  | { kind: 'symptom'; text: string; anchor: string };

/** The fact id prefixes a <Fix id> takes. */
const FIX_PREFIXES = ['fault.', 'refusal.'] as const;

/**
 * Check a <Fix>'s props and say what the entry is about, or throw the line an author reads in the
 * build log. Exactly one of `id` and `symptom` is given (a symptom of only white space counts as
 * not given, since it would make an empty heading). An id must start with fault. or refusal., and
 * then must be in facts.json, which resolveFact checks with its own [Fact] line.
 */
export function fixTarget(props: { id?: string; symptom?: string }, page: string, facts: FactsFile): FixTarget {
  const hasId = props.id !== undefined;
  const symptom = props.symptom?.trim() ?? '';
  const hasSymptom = symptom !== '';
  if (hasId === hasSymptom) {
    const which = hasId ? 'both id and symptom' : 'neither id nor symptom';
    throw new Error(`[Fix] ${page} has a <Fix> with ${which}. Give it one of them.`);
  }
  if (props.id !== undefined) {
    const id = props.id;
    if (!FIX_PREFIXES.some((prefix) => id.startsWith(prefix) && id.length > prefix.length)) {
      throw new Error(
        `[Fix] ${page} gives <Fix> the id "${id}". A fix entry takes a fault.* or refusal.* fact id, ` +
          'or symptom="..." for a hand-written entry.',
      );
    }
    resolveFact(id, page, facts);
    return { kind: 'fact', id, anchor: fixAnchor(id) };
  }
  return { kind: 'symptom', text: symptom, anchor: symptomAnchor(symptom) };
}

/**
 * Is a <Fix>'s rendered text empty: nothing left once the tags and the white space are gone? An
 * entry with no children renders no slot, which arrives here as undefined and counts as empty.
 */
export function isEmptyFixText(html: string | undefined): boolean {
  return (html ?? '').replace(/<[^>]*>/g, '').trim() === '';
}

/** The line an author reads when a <Fix> has no fix text. `label` is the entry's id or symptom. */
export function emptyFixMessage(page: string, label: string): string {
  return (
    `[Fix] ${page} has a <Fix> for "${label}" with no fix text. ` +
    'Write what causes it and how to fix it between <Fix> and </Fix>.'
  );
}

/** One row of a machine's ports table, in the words a reader sees. */
export interface PortRow {
  role: string;
  takes: string;
  side: string;
  cell: string;
}

/** What <MachineFacts kind={N} /> renders for one machine kind. */
export interface MachineView {
  kind: number;
  /** The name the app shows: the app-name fact's value, or machines[].name when there is no such fact. */
  name: string;
  /** The app-name fact id (machine.Endpoint.name), or null when facts.json has none (Wire). */
  nameFact: string | null;
  /** machines[].name, the name in the code. */
  codeName: string;
  /** The kind number's fact id (machine.Router.kind). */
  kindFact: string;
  /** "2 cells wide, 3 cells tall", or the no-footprint sentence. */
  size: string;
  /** One config.<Config>.<field> fact id per config field, in data order. Empty when there are none. */
  configFacts: string[];
  /** One row per port, in data order, which is the catalog's port index order. */
  ports: PortRow[];
}

/** Where the words for port values live, named in the build error for a value with no word. */
const PORT_WORDS_FILE = 'site/src/lib/facts.ts';

function unknownPortValue(kind: number, field: string, value: string): Error {
  return new Error(
    `[MachineFacts] machine kind ${kind} has a port with ${field} "${value}", and ${PORT_WORDS_FILE} ` +
      'has no word for it. Add one there.',
  );
}

// Closed mappings: each lists every value the exporter writes today, with no default arm, and a
// value with no word falls through to the throw. A new value in the code fails the build here
// instead of showing a made-up word.

function roleWord(role: string, kind: number): string {
  switch (role) {
    case 'In':
      return 'In';
    case 'Out':
      return 'Out';
    case 'Fault':
      return 'Fault';
  }
  throw unknownPortValue(kind, 'role', role);
}

function mediumWord(medium: string, kind: number): string {
  switch (medium) {
    case 'Mechanical':
      return 'Belt';
    case 'Electrical':
      return 'Wire';
  }
  throw unknownPortValue(kind, 'medium', medium);
}

function sideWord(side: string, kind: number): string {
  switch (side) {
    case 'N':
      return 'North';
    case 'E':
      return 'East';
    case 'S':
      return 'South';
    case 'W':
      return 'West';
  }
  throw unknownPortValue(kind, 'side', side);
}

/** "1 cell" or "3 cells". */
function cells(n: number): string {
  return n === 1 ? '1 cell' : `${n} cells`;
}

/**
 * The fact table of one machine kind, or a thrown Error with the line an author reads in the build
 * log: for a kind facts.json doesn't hold, and for a port value with no word above.
 */
export function machineView(kind: number, page: string, facts: FactsFile): MachineView {
  const machines = facts.machines ?? [];
  const entry = machines.find((m) => m.kind === kind);
  if (entry === undefined) {
    const known = machines.map((m) => m.kind).join(', ');
    throw new Error(
      `[MachineFacts] ${page} asks for machine kind ${kind}, and site/src/generated/facts.json has no ` +
        `machine with that kind. Known kinds: ${known}.`,
    );
  }
  const nameId = `machine.${entry.name}.name`;
  const nameFact = Object.hasOwn(facts.facts, nameId) ? nameId : null;
  const nameValue = nameFact === null ? undefined : facts.facts[nameFact];
  const name = nameValue !== undefined && 'value' in nameValue ? String(nameValue.value) : entry.name;
  const size =
    entry.footprint === null
      ? 'None. It takes no grid cells.'
      : `${cells(entry.footprint.w)} wide, ${cells(entry.footprint.h)} tall`;
  if (entry.config === null && entry.configFields.length > 0) {
    throw new Error(
      `[MachineFacts] machine kind ${kind} lists config fields with no config name in ` +
        'site/src/generated/facts.json. Regenerate it with npm run facts from site/.',
    );
  }
  const configFacts = entry.configFields.map((field) => `config.${entry.config}.${field}`);
  const ports = entry.ports.map((port) => ({
    role: roleWord(port.role, kind),
    takes: mediumWord(port.medium, kind),
    side: sideWord(port.side, kind),
    cell: `${port.local_offset[0]}, ${port.local_offset[1]}`,
  }));
  return { kind, name, nameFact, codeName: entry.name, kindFact: `machine.${entry.name}.kind`, size, configFacts, ports };
}
