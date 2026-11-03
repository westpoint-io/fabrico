import { describe, expect, it } from 'vitest';
import { moduleRel, refusedModule } from './moduleGuard';

describe('refusedModule: what the read-only board bundle may not carry', () => {
  it('refuses input code', () => {
    expect(refusedModule('src/input/gestures.ts')).toContain('src/input/');
  });

  it('refuses chrome code, the app component included', () => {
    expect(refusedModule('src/chrome/kindNames.ts')).toContain('src/chrome/');
    expect(refusedModule('src/chrome/App.tsx')).toContain('src/chrome/');
  });

  it('lets an svg directly in src/chrome/assets/ through, and nothing else in that folder', () => {
    expect(refusedModule('src/chrome/assets/play.svg')).toBeNull();
    expect(refusedModule('src/chrome/assets/registry.ts')).toContain('src/chrome/');
    expect(refusedModule('src/chrome/assets/deeper/play.svg')).toContain('src/chrome/');
  });

  it('matches a path prefix, so the renderer synth chrome folder passes', () => {
    expect(refusedModule('src/render/synth/chrome/skinToCssVars.ts')).toBeNull();
    expect(refusedModule('src/render/pixiApp.ts')).toBeNull();
    expect(refusedModule('node_modules/pixi.js/lib/index.mjs')).toBeNull();
  });

  it('refuses React, its scheduler and the Tauri packages, naming each', () => {
    expect(refusedModule('node_modules/react/index.js')).toContain('node_modules/react/');
    expect(refusedModule('node_modules/react-dom/client.js')).toContain('node_modules/react-dom/');
    expect(refusedModule('node_modules/scheduler/index.js')).toContain('node_modules/scheduler/');
    expect(refusedModule('node_modules/@tauri-apps/api/core.js')).toContain('node_modules/@tauri-apps/');
  });

  it("doesn't take a package whose name only starts like a refused one", () => {
    expect(refusedModule('node_modules/react-is/index.js')).toBeNull();
  });
});

describe('moduleRel: the path the rule reads', () => {
  const root = '/work/frontend';

  it('strips the NUL prefix and the query and takes the path under the root', () => {
    expect(moduleRel('\0/work/frontend/src/chrome/App.tsx?raw', root)).toBe('src/chrome/App.tsx');
    expect(moduleRel('/work/frontend/src/render/pixiApp.ts', root)).toBe('src/render/pixiApp.ts');
  });

  it('names a package file from its last node_modules segment, even outside the root', () => {
    expect(moduleRel('/elsewhere/frontend/node_modules/react/index.js', root)).toBe('node_modules/react/index.js');
    expect(refusedModule(moduleRel('/elsewhere/frontend/node_modules/react/index.js', root) ?? '')).toContain(
      'node_modules/react/',
    );
    expect(moduleRel('/work/frontend/node_modules/a/node_modules/scheduler/index.js', root)).toBe(
      'node_modules/scheduler/index.js',
    );
  });

  it('returns null for an id that is not a file path', () => {
    expect(moduleRel('\0virtual:fabrico-embed-data', root)).toBeNull();
    expect(moduleRel('commonjsHelpers.js', root)).toBeNull();
  });
});
