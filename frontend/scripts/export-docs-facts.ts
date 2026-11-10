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
//   - every keyboard shortcut, from shortcutTable('Ctrl') and shortcutTable('Cmd') in
//     src/input/shortcuts.ts, so a Ctrl entry carries both spellings.
//
// shortcuts.ts has no imports, so plain Node loads it as it is. The other modules are TypeScript
// that plain Node can't strip (a .tsx file, for one), so they load through Vite's module runner.
//
// OUTPUT: one JSON object on stdout, `{ "facts": { "<id>": { ... } } }`. Source paths are
// repo-relative and carry no line numbers.
//
// EXIT CODES
//   0  the JSON was printed.
//   1  a module failed to load or a value had the wrong shape; one line on stderr says which.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortcutTable, type ShortcutId } from '../src/input/shortcuts.ts';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));

const CONTROLLER = 'frontend/src/embed/controller.ts';
const SHORTCUTS = 'frontend/src/input/shortcuts.ts';

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

type Fact = Record<string, unknown>;

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

  const ctrl = shortcutTable('Ctrl');
  const cmd = shortcutTable('Cmd');
  const ids: ShortcutId[] = ['playPause'];
  for (const id of ids) {
    facts[`shortcut.${id}`] = {
      kind: 'shortcut',
      label: ctrl[id].label,
      labelMac: cmd[id].label,
      source: SHORTCUTS,
      symbol: 'shortcutTable',
    };
  }
  return facts;
}

try {
  const facts = await collect();
  process.stdout.write(`${JSON.stringify({ facts }, null, 2)}\n`);
} catch (err) {
  console.error(`export-docs-facts: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
