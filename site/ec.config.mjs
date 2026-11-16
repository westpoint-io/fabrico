// The code-block look. Expressive Code reads this file from the site root.
//
// The colour theme is src/styles/generated/code-theme.json, which frontend/scripts/build-site-assets.ts
// writes from the app's locked skin before each build, so this file types no colour. Giving Expressive
// Code a theme of our own also turns off Starlight's habit of recolouring code blocks with its own
// variables. The frame has square corners, a 1 px lit edge and no shadow.
import { defineEcConfig, ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';
import { select, setProperty } from '@astrojs/starlight/expressive-code/hast';
import theme from './src/styles/generated/code-theme.json' with { type: 'json' };

/**
 * Writes tabindex="0", role="region" and a label onto each code block's <pre> in the HTML, so a
 * keyboard user can reach and scroll a block wider than the column as soon as the page loads.
 *
 * Expressive Code's own script adds the same tabindex only after a resize observer fires, a 250 ms
 * quiet period passes and the browser grants an idle callback. On a busy machine that idle callback
 * can come late, and in the docs suite on one throttled core it once didn't come within 20 s. The
 * build can't tell how wide the column will be, so every block that can scroll starts focusable. The
 * same script still takes tabindex and role off a block that turns out to fit, the way it always
 * has, and leaves the label; it never removes them from a block that scrolls.
 */
function focusableCodeBlocks() {
  return {
    name: 'Focusable code blocks',
    hooks: {
      postprocessRenderedBlock: ({ codeBlock, renderData }) => {
        // A block with wrap on breaks its lines and never scrolls sideways, so it stays out of the tab order.
        if (codeBlock.props.wrap) return;
        const pre = select('pre', renderData.blockAst);
        if (!pre) return;
        const title = codeBlock.props.title;
        setProperty(pre, 'tabindex', '0');
        setProperty(pre, 'role', 'region');
        setProperty(pre, 'aria-label', title ? `Code block: ${title}` : 'Code block');
      },
    },
  };
}

export default defineEcConfig({
  plugins: [focusableCodeBlocks()],
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
