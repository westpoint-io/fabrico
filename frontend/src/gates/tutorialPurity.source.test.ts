// THE RULES THAT KEEP THE TUTORIAL A READER OF THE APP.
//
// The lesson engine under `src/tutorial/` has to run in a node test and in the walk, so it can't reach
// for React, Pixi or the DOM. The tutorial's two folders also can't send anything to the host: the one
// thing a lesson asks for is New, through a callback the app hands it, so a transport call, a network
// call or a press on the app's own controls in either folder is a lesson finishing a step for the user.
// The one thing a lesson reads from the host is the bound Source's trigger, and `triggerRead.ts` is the
// only file holding a host bridge. It hands the bridge to `loadConfig` and to nothing else, and exports
// the answer, so no other file can get hold of a value that can send any command. Lesson text must never
// be able to become HTML. `src/render/` ships in the docs embed, which has no tutorial, so it can't
// import one.
//
// Read as source and never imported. Comments are stripped first, so a comment explaining a rule isn't
// a breach of it. Names match on a word boundary, because `localStorageProgress` takes its storage as a
// parameter, which is what the rule wants. A dotted global needs an identifier after the dot, because
// a sentence in a lesson can end in "the window."
//
// NOT SEEN: a global reached through an alias or a bracket (`const w = window`, `globalThis['fetch']`),
// a browser API or HTML sink these lists don't name, a forbidden word inside a string, which reads as a
// finding, and a write made by a helper in some other folder that wraps its own bridge, because the
// scan reads only what these folders name. The parity walk counts sends on the paths it walks, under
// Vite. The first case below is the tripwire for the scan reading nothing, and the mutation cases are
// what stop it being a check that can't fail.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './walkSpecSource';

const FRONTEND = fileURLToPath(new URL('../../', import.meta.url));

interface SourceFile {
  /** Relative to `frontend/`, with forward slashes. */
  path: string;
  source: string;
}

const PURE_DIR = 'src/tutorial/';
const LAYER_DIR = 'src/chrome/tutorial/';
const RENDER_DIR = 'src/render/';
/** The one file allowed to read the camera, so a second reader can't drift from it. */
const CAMERA_READER = 'src/chrome/tutorial/cameraRead.ts';
/** The one file allowed to hold a host bridge, for the one read a lesson needs. */
const HOST_READER = 'src/chrome/tutorial/triggerRead.ts';

const PURE_GLOBALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['window.', /\bwindow\??\.[A-Za-z_$]/],
  ['document.', /\bdocument\??\.[A-Za-z_$]/],
  ['navigator.', /\bnavigator\??\.[A-Za-z_$]/],
  ['localStorage', /\blocalStorage\b/],
  ['requestAnimationFrame', /\brequestAnimationFrame\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['location.', /(?<![.$\w])location\??\.[A-Za-z_$]/],
  ['getComputedStyle', /\bgetComputedStyle\b/],
  ['matchMedia', /\bmatchMedia\b/],
];

const NO_WRITE_NAMES: ReadonlyArray<readonly [string, RegExp]> = [
  ['sendInput', /\bsendInput\b/],
  ['sendControl', /\bsendControl\b/],
  ['encodeGridCommand', /\bencodeGridCommand\b/],
  ['makeTransport', /\bmakeTransport\b/],
  ['transportRef', /\btransportRef\b/],
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['EventSource', /\bEventSource\b/],
  ['commitConfig', /\bcommitConfig\b/],
  ['.click(', /\.click\s*(?:\?\.)?\(/],
  ['.dispatchEvent(', /\.dispatchEvent\s*(?:\?\.)?\(/],
  ['invoke', /\binvoke\b/],
  ['@tauri-apps/', /@tauri-apps\//],
  ['__TAURI', /\b__TAURI/],
];

const HTML_SINKS: ReadonlyArray<readonly [string, RegExp]> = [
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['dangerouslySetInnerHTML', /\bdangerouslySetInnerHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['createContextualFragment', /\bcreateContextualFragment\b/],
  ['document.write', /\bdocument\.write(?:ln)?\b/],
  ['srcdoc', /\bsrcdoc\b/i],
];

/** Each can send any command to the host, so only `HOST_READER` may name one. */
const HOST_BRIDGES = /\b(?:tauriInvoke|devWsInvoke)\b/;
/** A module whose exports reach the host: the transport, and the inspector's bridge and its commit. */
const THROUGH_HOST_MODULE = /(?:^|\/)(?:transport(?:\/|$)|ConfigPanel(?:\.tsx?)?$)/;

const CAMERA_CALL = /\.camera\s*(?:\?\.)?\(\s*\)/;
const IMPORT_FORMS: readonly RegExp[] = [
  /^[ \t]*import\b[^'";]*['"]([^'"]+)['"]/gm,
  /^[ \t]*export\b[^'";=]*\bfrom\s*['"]([^'"]+)['"]/gm,
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g,
];
const UI_PACKAGE = /^(?:react|react-dom|pixi\.js)(?:\/|$)/;
const THROUGH_UI_FOLDER = /(?:^|\/)(?:render|chrome)(?:\/|$)/;
const THROUGH_TUTORIAL_FOLDER = /(?:^|\/)tutorial(?:\/|$)/;

function importPaths(stripped: string): Array<{ path: string; line: number }> {
  return IMPORT_FORMS.flatMap((form) =>
    [...stripped.matchAll(form)].map((m) => ({
      path: m[1] as string,
      line: stripped.slice(0, m.index).split('\n').length,
    })),
  );
}

function namesFound(stripped: string, names: ReadonlyArray<readonly [string, RegExp]>): Array<{ name: string; line: number }> {
  return names.flatMap(([name, pattern]) => {
    const hit = pattern.exec(stripped);
    return hit === null ? [] : [{ name, line: stripped.slice(0, hit.index).split('\n').length }];
  });
}

/**
 * The one way a bridge may be used: as the direct second argument of `loadConfig(`, alone or as the two
 * arms of the `transportKind()` choice. Anything else on that line, such as a wrapper or a second call,
 * is left behind when this is cut out, and the bridge it names is a breach.
 */
const BRIDGE = '(?:tauriInvoke|devWsInvoke)';
const THE_ONE_READ = new RegExp(
  `\\bloadConfig\\(\\s*(?!${BRIDGE}\\b)\\w+\\s*,\\s*(?:${BRIDGE}|transportKind\\(\\)\\s*[!=]==\\s*'\\w+'\\s*\\?\\s*${BRIDGE}\\s*:\\s*${BRIDGE})\\s*\\)`,
  'g',
);

/**
 * The reader may import a bridge and pass it to `loadConfig`. A bridge anywhere else could send a
 * command, and any export but the answer could hand a bridge out.
 */
function hostReaderBreaches(path: string, stripped: string): string[] {
  const findings: string[] = [];
  stripped.split('\n').forEach((text, i) => {
    if (!HOST_BRIDGES.test(text)) return;
    const plainImport = /^\s*import\b/.test(text) && !/\bas\b/.test(text);
    if (!plainImport && HOST_BRIDGES.test(text.replace(THE_ONE_READ, ''))) {
      findings.push(`${path}:${i + 1}: uses a host bridge outside loadConfig, and this file makes that one read`);
    }
  });
  const exported = [...stripped.matchAll(/\bexport\b[^\n]*/g)].map((m) => m[0]);
  if (exported.length !== 1 || !exported[0]?.startsWith('export async function readAppliedTrigger(')) {
    findings.push(`${path}: exports ${exported.length} things, and it must export readAppliedTrigger alone`);
  }
  if (!stripped.includes('loadConfig(')) findings.push(`${path}: makes no loadConfig read, which is all this file is for`);
  return findings;
}

/** One string per breach, so a failure names the file, the line and the rule. Empty means clean. */
export function auditTutorialSources(files: readonly SourceFile[]): string[] {
  const findings: string[] = [];
  for (const { path, source } of files) {
    const stripped = stripComments(source);
    const pure = path.startsWith(PURE_DIR);
    const layer = path.startsWith(LAYER_DIR);

    if (pure && !/\.test\.tsx?$/.test(path)) {
      for (const imported of importPaths(stripped)) {
        if (UI_PACKAGE.test(imported.path)) {
          findings.push(`${path}:${imported.line}: imports ${imported.path}, and the lesson engine has to run with no UI`);
        }
        if (THROUGH_UI_FOLDER.test(imported.path)) {
          findings.push(`${path}:${imported.line}: imports ${imported.path}, through a UI folder`);
        }
      }
      for (const hit of namesFound(stripped, PURE_GLOBALS)) {
        findings.push(`${path}:${hit.line}: names the global ${hit.name}, and the lesson engine has to run with no browser`);
      }
    }
    if (pure || layer) {
      for (const hit of namesFound(stripped, NO_WRITE_NAMES)) {
        findings.push(`${path}:${hit.line}: names ${hit.name}, and the tutorial sends nothing but a New through its callback`);
      }
      for (const hit of namesFound(stripped, HTML_SINKS)) {
        findings.push(`${path}:${hit.line}: names ${hit.name}, and lesson text must never be able to become HTML`);
      }
      if (path === HOST_READER) {
        findings.push(...hostReaderBreaches(path, stripped));
      } else {
        for (const hit of namesFound(stripped, [['a host bridge', HOST_BRIDGES]])) {
          findings.push(`${path}:${hit.line}: names ${hit.name}, and only ${HOST_READER} holds one`);
        }
        for (const imported of importPaths(stripped)) {
          if (THROUGH_HOST_MODULE.test(imported.path)) {
            findings.push(`${path}:${imported.line}: imports ${imported.path}, and only ${HOST_READER} reaches the host`);
          }
        }
      }
    }
    if (layer && path !== CAMERA_READER) {
      const hit = CAMERA_CALL.exec(stripped);
      if (hit !== null) {
        const line = stripped.slice(0, hit.index).split('\n').length;
        findings.push(`${path}:${line}: calls .camera(), and only ${CAMERA_READER} reads the camera`);
      }
    }
    if (path.startsWith(RENDER_DIR)) {
      for (const imported of importPaths(stripped)) {
        if (THROUGH_TUTORIAL_FOLDER.test(imported.path)) {
          findings.push(`${path}:${imported.line}: imports ${imported.path}, and the docs embed ships this folder with no tutorial`);
        }
      }
    }
  }
  return findings;
}

function sourcesUnder(dir: string): SourceFile[] {
  return readdirSync(join(FRONTEND, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(FRONTEND, dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(`${dir}${entry.name}/`);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ path: relative(FRONTEND, path).split('\\').join('/'), source: readFileSync(path, 'utf8') }];
  });
}

const REAL = [...sourcesUnder(PURE_DIR), ...sourcesUnder(LAYER_DIR), ...sourcesUnder(RENDER_DIR)];

const pureFile = (source: string): SourceFile => ({ path: 'src/tutorial/fixture.ts', source });
const layerFile = (source: string): SourceFile => ({ path: 'src/chrome/tutorial/TutorialLayer.tsx', source });

describe('the tutorial stays a reader of the app', () => {
  it('reads the real tree, so a clean result below is a real reading', () => {
    const paths = REAL.map((f) => f.path);
    for (const named of ['src/tutorial/machine.ts', 'src/tutorial/check.ts', 'src/chrome/tutorial/TutorialLayer.tsx', HOST_READER, 'src/render/pixiApp.ts']) {
      expect(paths, named).toContain(named);
    }
    expect(REAL.find((f) => f.path === 'src/tutorial/machine.ts')?.source).toContain('export function reduce');
  });

  it('finds nothing in the real tree', () => {
    expect(auditTutorialSources(REAL)).toEqual([]);
  });

  describe('fails on', () => {
    it('an import from react in a pure file', () => {
      expect(auditTutorialSources([pureFile("import { useState } from 'react';\n")]).join('\n')).toMatch(/fixture\.ts:1: imports react/);
    });

    it('an import from react-dom in a pure file', () => {
      expect(auditTutorialSources([pureFile("import { render } from 'react-dom/client';\n")]).join('\n')).toMatch(/imports react-dom\/client/);
    });

    it('an import from pixi.js in a pure file', () => {
      expect(auditTutorialSources([pureFile("import { Graphics } from 'pixi.js';\n")]).join('\n')).toMatch(/imports pixi\.js/);
    });

    it('an import that spans lines', () => {
      expect(auditTutorialSources([pureFile("import {\n  Graphics,\n} from 'pixi.js';\n")]).join('\n')).toMatch(/imports pixi\.js/);
    });

    it('a dynamic import in a pure file', () => {
      expect(auditTutorialSources([pureFile("const p = import('pixi.js');\n")]).join('\n')).toMatch(/imports pixi\.js/);
    });

    it('an import through render or chrome in a pure file', () => {
      expect(auditTutorialSources([pureFile("import { a } from '../render/pixiApp';\n")]).join('\n')).toMatch(/through a UI folder/);
      expect(auditTutorialSources([pureFile("import { a } from '../chrome/App';\n")]).join('\n')).toMatch(/through a UI folder/);
    });

    it('each DOM global in a pure file', () => {
      for (const [source, name] of [
        ["document.querySelector('a');", 'document.'],
        ['const w = window.innerWidth;', 'window.'],
        ['const n = navigator.language;', 'navigator.'],
        ["localStorage.getItem('x');", 'localStorage'],
        ['requestAnimationFrame(tick);', 'requestAnimationFrame'],
        ["sessionStorage.getItem('x');", 'sessionStorage'],
        ['const here = location.href;', 'location.'],
        ['const here = location?.href;', 'location.'],
        ['getComputedStyle(el);', 'getComputedStyle'],
        ["matchMedia('(prefers-reduced-motion)');", 'matchMedia'],
      ] as const) {
        expect(auditTutorialSources([pureFile(source)]).join('\n'), source).toContain(`names the global ${name}`);
      }
    });

    it('each transport and network name in either folder', () => {
      for (const [source, name] of [
        ['sendInput(frame);', 'sendInput'],
        ['sendControl(frame);', 'sendControl'],
        ['encodeGridCommand(c);', 'encodeGridCommand'],
        ['makeTransport();', 'makeTransport'],
        ['transportRef.current;', 'transportRef'],
        ["fetch('/x');", 'fetch('],
        ['new XMLHttpRequest();', 'XMLHttpRequest'],
        ['new WebSocket(url);', 'WebSocket'],
        ["navigator.sendBeacon('/x', body);", 'sendBeacon'],
        ["new EventSource('/x');", 'EventSource'],
        ['commitConfig(1, c, deps);', 'commitConfig'],
        ["document.querySelector('button').click();", '.click('],
        ['button?.click?.();', '.click('],
        ['button.dispatchEvent(new MouseEvent("click"));', '.dispatchEvent('],
        ["invoke('submit_input', {});", 'invoke'],
        ["import('@tauri-apps/api/core');", '@tauri-apps/'],
        ['window.__TAURI_INTERNALS__;', '__TAURI'],
      ] as const) {
        expect(auditTutorialSources([layerFile(source)]).join('\n'), `layer: ${source}`).toContain(`names ${name}`);
        expect(auditTutorialSources([pureFile(source)]).join('\n'), `pure: ${source}`).toContain(`names ${name}`);
      }
    });

    it('a host bridge named outside the reader, in either folder', () => {
      for (const bridge of ['tauriInvoke', 'devWsInvoke']) {
        const source = `const go = ${bridge};`;
        for (const file of [layerFile(source), pureFile(source)]) {
          expect(auditTutorialSources([file]).join('\n'), `${file.path}: ${bridge}`).toContain(`names a host bridge, and only ${HOST_READER} holds one`);
        }
      }
    });

    it('an import of the transport or the inspector outside the reader, in either folder', () => {
      for (const path of ['../../transport/transport', '../../transport/devWsInvoke', '../ConfigPanel', '../ConfigPanel.tsx']) {
        const source = `import { thing } from '${path}';\n`;
        for (const file of [layerFile(source), pureFile(source)]) {
          expect(auditTutorialSources([file]).join('\n'), `${file.path}: ${path}`).toContain(`imports ${path}, and only ${HOST_READER} reaches the host`);
        }
      }
    });

    describe('in the reader', () => {
      const FIRST_LINES = [
        "import { devWsInvoke } from '../../transport/devWsInvoke';",
        "import { loadConfig, tauriInvoke } from '../ConfigPanel';",
      ];
      const read = 'export async function readAppliedTrigger(node) { return loadConfig(node, tauriInvoke); }';
      const reader = (...lines: string[]): SourceFile => ({ path: HOST_READER, source: [...FIRST_LINES, read, ...lines].join('\n') });

      it('a bridge called directly', () => {
        expect(auditTutorialSources([reader("tauriInvoke('submit_input', {});")]).join('\n')).toContain(`${HOST_READER}:4: uses a host bridge outside loadConfig`);
        expect(auditTutorialSources([reader("devWsInvoke('step', {});")]).join('\n')).toContain(`${HOST_READER}:4: uses a host bridge outside loadConfig`);
      });

      it('a bridge held under another name', () => {
        expect(auditTutorialSources([reader('const go = tauriInvoke;')]).join('\n')).toContain('uses a host bridge outside loadConfig');
        const aliased = { path: HOST_READER, source: `import { tauriInvoke as go } from '../ConfigPanel';\n${read}` };
        expect(auditTutorialSources([aliased]).join('\n')).toContain('uses a host bridge outside loadConfig');
      });

      it('a bridge wrapped in a function on the same line as loadConfig', () => {
        const body = "export async function readAppliedTrigger(node) { return loadConfig(node, (cmd, args) => tauriInvoke('ctrl_new', args)); }";
        expect(auditTutorialSources([{ path: HOST_READER, source: [...FIRST_LINES, body].join('\n') }]).join('\n')).toContain(`${HOST_READER}:3: uses a host bridge outside loadConfig`);
      });

      it('a write after the read on the same line', () => {
        const body = "export async function readAppliedTrigger(node) { const c = await loadConfig(node, tauriInvoke); tauriInvoke('ctrl_new', {}); return c; }";
        expect(auditTutorialSources([{ path: HOST_READER, source: [...FIRST_LINES, body].join('\n') }]).join('\n')).toContain(`${HOST_READER}:3: uses a host bridge outside loadConfig`);
      });

      it('a bridge as the first argument of loadConfig', () => {
        const body = 'export async function readAppliedTrigger(node) { return loadConfig(tauriInvoke, node); }';
        expect(auditTutorialSources([{ path: HOST_READER, source: [...FIRST_LINES, body].join('\n') }]).join('\n')).toContain(`${HOST_READER}:3: uses a host bridge outside loadConfig`);
      });

      it('a transport choice with a call in one arm', () => {
        const body = "export async function readAppliedTrigger(node) { return loadConfig(node, transportKind() === 'dev' ? devWsInvoke('step', {}) : tauriInvoke); }";
        expect(auditTutorialSources([{ path: HOST_READER, source: [...FIRST_LINES, body].join('\n') }]).join('\n')).toContain(`${HOST_READER}:3: uses a host bridge outside loadConfig`);
      });

      it('a second export, or a bridge handed out', () => {
        expect(auditTutorialSources([reader('export const go = 1;')]).join('\n')).toContain('exports 2 things');
        expect(auditTutorialSources([reader('export { tauriInvoke };')]).join('\n')).toContain('uses a host bridge outside loadConfig');
      });

      it('no read at all', () => {
        expect(auditTutorialSources([{ path: HOST_READER, source: 'export async function readAppliedTrigger() { return null; }' }]).join('\n')).toContain('makes no loadConfig read');
      });

      it('a word the reader has no use for', () => {
        expect(auditTutorialSources([reader("invoke('step', {});")]).join('\n')).toContain('names invoke');
        expect(auditTutorialSources([reader("import('@tauri-apps/api/core');")]).join('\n')).toContain('names @tauri-apps/');
        expect(auditTutorialSources([reader('commitConfig(1, c, deps);')]).join('\n')).toContain('names commitConfig');
      });
    });

    it('lesson text turned into HTML, in either folder', () => {
      for (const [source, name] of [
        ['el.innerHTML = text;', 'innerHTML'],
        ['el.outerHTML = text;', 'outerHTML'],
        ['<p dangerouslySetInnerHTML={{ __html: text }} />', 'dangerouslySetInnerHTML'],
        ["el.insertAdjacentHTML('beforeend', text);", 'insertAdjacentHTML'],
        ['range.createContextualFragment(text);', 'createContextualFragment'],
        ['document.write(text);', 'document.write'],
        ['document.writeln(text);', 'document.write'],
        ['frame.srcdoc = text;', 'srcdoc'],
        ['<iframe srcDoc={text} />', 'srcdoc'],
      ] as const) {
        const want = `names ${name}, and lesson text must never be able to become HTML`;
        expect(auditTutorialSources([layerFile(source)]).join('\n'), `layer: ${source}`).toContain(want);
        expect(auditTutorialSources([pureFile(source)]).join('\n'), `pure: ${source}`).toContain(want);
      }
    });

    it('.camera() outside cameraRead.ts', () => {
      expect(auditTutorialSources([layerFile('const c = hook.camera();')]).join('\n')).toContain('calls .camera()');
      expect(auditTutorialSources([layerFile('const c = hook?.camera?.();')]).join('\n')).toContain('calls .camera()');
    });

    it('a tutorial import in a file under render/', () => {
      const file = { path: 'src/render/fixture.ts', source: "import { reduce } from '../tutorial/machine';\n" };
      expect(auditTutorialSources([file]).join('\n')).toMatch(/fixture\.ts:1: imports \.\.\/tutorial\/machine/);
      const layer = { path: 'src/render/fixture.ts', source: "import { readCamera } from '../chrome/tutorial/cameraRead';\n" };
      expect(auditTutorialSources([layer]).join('\n')).toMatch(/imports \.\.\/chrome\/tutorial\/cameraRead/);
    });
  });

  describe('stays quiet on', () => {
    it('a forbidden word inside a comment', () => {
      const source = [
        "// import { useState } from 'react';",
        '/* sendInput(frame); document.querySelector("a"); */',
        '// window.innerWidth and localStorage.getItem',
      ].join('\n');
      expect(auditTutorialSources([pureFile(source), layerFile(source)])).toEqual([]);
    });

    it('a name that only contains a forbidden word', () => {
      expect(auditTutorialSources([pureFile('export function localStorageProgress(storage) { return storage; }')])).toEqual([]);
      expect(auditTutorialSources([layerFile("import { devWebSocketThing } from '../../fixture';")])).toEqual([]);
      expect(auditTutorialSources([layerFile('const onClick = reinvoked; const a = fauxtauriInvoke;')])).toEqual([]);
      expect(auditTutorialSources([layerFile("import { thing } from '../../fixture/transportless';")])).toEqual([]);
    });

    it('a click handler on a button of its own, which only reacts to the user', () => {
      expect(auditTutorialSources([layerFile('<button onClick={onLeave}>Leave</button>')])).toEqual([]);
    });

    it('the host read in the reader', () => {
      const source = [
        "import { devWsInvoke } from '../../transport/devWsInvoke';",
        "import { transportKind } from '../../transport/transport';",
        "import { loadConfig, tauriInvoke } from '../ConfigPanel';",
        "export async function readAppliedTrigger(node) { return loadConfig(node, transportKind() === 'dev' ? devWsInvoke : tauriInvoke); }",
      ].join('\n');
      expect(auditTutorialSources([{ path: HOST_READER, source }])).toEqual([]);
    });

    it('a lesson sentence that ends in the window', () => {
      expect(auditTutorialSources([pureFile("const text = 'Drag it across the window.';")])).toEqual([]);
    });

    it('a sentence or a name that uses location as an ordinary word', () => {
      expect(auditTutorialSources([pureFile("const text = 'Pick a free location. Any will do.'; const location = 1;")])).toEqual([]);
      expect(auditTutorialSources([pureFile('const a = cell.location; const b = cell.location.x; const spotLocation = 2;')])).toEqual([]);
    });

    it('a UI import in a test beside the engine, which needs one to render', () => {
      expect(auditTutorialSources([{ path: 'src/tutorial/fixture.test.ts', source: "import { render } from 'react-dom/client';" }])).toEqual([]);
    });

    it('.camera() in cameraRead.ts, and DOM reads in the layer', () => {
      expect(auditTutorialSources([{ path: CAMERA_READER, source: 'window.__fabrico?.camera();' }])).toEqual([]);
      expect(auditTutorialSources([layerFile("import { useRef } from 'react'; document.querySelector('a');")])).toEqual([]);
      expect(auditTutorialSources([layerFile("getComputedStyle(el); matchMedia('(min-width: 1px)'); location.href;")])).toEqual([]);
    });

    it('a file in none of the three folders', () => {
      expect(auditTutorialSources([{ path: 'src/chrome/App.tsx', source: "import { useState } from 'react'; sendInput(frame);" }])).toEqual([]);
    });
  });
});
