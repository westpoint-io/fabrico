import { describe, expect, it } from 'vitest';
import { refusedModule } from './moduleGuard';

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
