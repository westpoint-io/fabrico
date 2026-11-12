// export-docs-facts.ts - prints the TypeScript half of the docs site's generated facts as JSON.
//
// `npm run facts` in site/ runs this with plain Node, runs the Rust half
// (`cargo run -q --locked -p fabrico-host --example docs_facts`), merges the two and writes
// site/src/generated/facts.json. Pages show those values only through the site's <Fact> component,
// so a value that changes in the code changes on the page, and CI fails when the committed file is
// stale.
//
// The facts here come from the frontend's own modules, read as values, never parsed as text:
//   - the docs board's play rate, TICKS_PER_SECOND in src/embed/controller.ts;
//   - every refusal message the app shows: REFUSAL_COPY in src/chrome/RefusalMessage.tsx (the
//     host's verdicts) and CLIENT_REFUSAL_COPY beside it (the ones the app says with no host
//     verdict), both as refusal.<Tag>, failing when a client tag equals a host tag;
//   - every keyboard shortcut, from shortcutTable('Ctrl') and shortcutTable('Cmd') in
//     src/input/shortcuts.ts, so a Ctrl entry carries both spellings, with helpOmits set on the
//     entries the Help panel leaves out (HELP_OMITS).
// Each family is read from the table itself, so a new refusal or shortcut joins the file on the
// next run with no change here.
//
// It also prints KIND_NAMES from shared/kindNames.ts, the name the app shows for each machine kind,
// as `appNames` (kind number to name). This half doesn't know the Rust code names, so site/scripts/
// facts.ts joins appNames with the Rust half's machines[] and writes machine.<CodeName>.name.
//
// shortcuts.ts has no imports, so plain Node loads it as it is. The other modules are TypeScript
// that plain Node can't strip (a .tsx file, for one), so they load through Vite's module runner.
//
// OUTPUT: one JSON object on stdout, `{ "facts": { "<id>": { ... } }, "appNames": { "<kind>": "<name>" } }`.
// Source paths are repo-relative and carry no line numbers.
//
// EXIT CODES
//   0  the JSON was printed.
//   1  a module failed to load or a value had the wrong shape; one line on stderr says which.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP_OMITS, shortcutTable, type ShortcutId } from '../src/input/shortcuts.ts';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));

const CONTROLLER = 'frontend/src/embed/controller.ts';
const SHORTCUTS = 'frontend/src/input/shortcuts.ts';
const REFUSALS = 'frontend/src/chrome/RefusalMessage.tsx';

/** Load a TypeScript module through Vite's module runner, rooted at the frontend folder. */
async function load<T>(rel: string): Promise<T> {
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport<T>(path.join(FRONTEND, rel), {
    configFile: false,
    root: FRONTEND,
    logLevel: 'silent',
  });
  return module;
}

type Controller = typeof import('../src/embed/controller.ts');
type Refusals = typeof import('../src/chrome/RefusalMessage.tsx');
type KindNames = typeof import('../shared/kindNames.ts');

type Fact = Record<string, unknown>;

/** KIND_NAMES as kind number (a string key) to the name the app shows. */
async function appNames(): Promise<Record<string, string>> {
  const { KIND_NAMES } = await load<KindNames>('shared/kindNames.ts');
  const out: Record<string, string> = {};
  for (const [kind, name] of Object.entries(KIND_NAMES)) {
    if (!/^\d+$/.test(kind)) throw new Error(`KIND_NAMES has the key "${kind}", which isn't a kind number`);
    if (typeof name !== 'string' || name === '') throw new Error(`KIND_NAMES[${kind}] isn't a non-empty string`);
    out[kind] = name;
  }
  if (Object.keys(out).length === 0) throw new Error('KIND_NAMES loaded with no entries');
  return out;
}

async function collect(): Promise<Record<string, Fact>> {
  const facts: Record<string, Fact> = {};
  const controller = await load<Controller>('src/embed/controller.ts');
  facts['embed.ticks_per_second'] = {
    kind: 'quantity',
    value: controller.TICKS_PER_SECOND,
    unit: 'ticks a second',
    also: ['ticks per second'],
    source: CONTROLLER,
    symbol: 'TICKS_PER_SECOND',
  };

  const refusals = await load<Refusals>('src/chrome/RefusalMessage.tsx');
  const copy: Record<string, unknown> = refusals.REFUSAL_COPY;
  const tags = Object.keys(copy);
  if (tags.length === 0) throw new Error('REFUSAL_COPY loaded with no entries');
  for (const tag of tags) {
    const text = copy[tag];
    if (typeof text !== 'string' || text === '') throw new Error(`REFUSAL_COPY.${tag} isn't a non-empty string`);
    facts[`refusal.${tag}`] = { kind: 'text', value: text, source: REFUSALS, symbol: 'REFUSAL_COPY' };
  }
  const clientCopy: Record<string, unknown> = refusals.CLIENT_REFUSAL_COPY;
  const clientTags = Object.keys(clientCopy);
  if (clientTags.length === 0) throw new Error('CLIENT_REFUSAL_COPY loaded with no entries');
  for (const tag of clientTags) {
    if (tags.includes(tag)) throw new Error(`CLIENT_REFUSAL_COPY.${tag} has the same tag as REFUSAL_COPY.${tag}; give one of them another tag`);
    const text = clientCopy[tag];
    if (typeof text !== 'string' || text === '') throw new Error(`CLIENT_REFUSAL_COPY.${tag} isn't a non-empty string`);
    facts[`refusal.${tag}`] = { kind: 'text', value: text, source: REFUSALS, symbol: 'CLIENT_REFUSAL_COPY' };
  }

  const ctrl = shortcutTable('Ctrl');
  const cmd = shortcutTable('Cmd');
  const omitted = new Set<ShortcutId>(HELP_OMITS.map((o) => o.id));
  const ids = Object.keys(ctrl) as ShortcutId[];
  for (const id of omitted) {
    if (!ids.includes(id)) throw new Error(`HELP_OMITS names "${id}", which shortcutTable doesn't hold`);
  }
  for (const id of ids) {
    const fact: Fact = {
      kind: 'shortcut',
      label: ctrl[id].label,
      labelMac: cmd[id].label,
      source: SHORTCUTS,
      symbol: 'shortcutTable',
    };
    if (omitted.has(id)) fact.helpOmits = true;
    facts[`shortcut.${id}`] = fact;
  }
  return facts;
}

try {
  const facts = await collect();
  process.stdout.write(`${JSON.stringify({ facts, appNames: await appNames() }, null, 2)}\n`);
} catch (err) {
  console.error(`export-docs-facts: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
