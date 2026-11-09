// The code-block look. Expressive Code reads this file from the site root.
//
// The colour theme is src/styles/generated/code-theme.json, which frontend/scripts/build-site-assets.ts
// writes from the app's locked skin before each build, so this file types no colour. Giving Expressive
// Code a theme of our own also turns off Starlight's habit of recolouring code blocks with its own
// variables. The frame has square corners, a 1 px lit edge and no shadow.
import { defineEcConfig, ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';
import theme from './src/styles/generated/code-theme.json' with { type: 'json' };

export default defineEcConfig({
  themes: [ExpressiveCodeTheme.fromJSONString(JSON.stringify(theme))],
  styleOverrides: {
    borderRadius: '0',
    borderWidth: '1px',
    borderColor: 'var(--fab-edge-lit)',
    codeFontFamily: 'var(--__sl-font-mono)',
    codeFontSize: '1rem',
    codeLineHeight: '1.5',
    codePaddingBlock: 'var(--fab-space-md)',
    codePaddingInline: 'var(--fab-space-md)',
    uiFontFamily: 'var(--__sl-font)',
    uiFontSize: '0.75rem',
    focusBorder: 'var(--fab-focus)',
    frames: {
      frameBoxShadowCssValue: 'none',
      editorActiveTabIndicatorTopColor: 'var(--fab-focus)',
      inlineButtonForeground: 'var(--fab-ink)',
      inlineButtonBorder: 'var(--fab-edge-lit)',
    },
  },
});
