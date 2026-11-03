// The rule for what the read-only board bundle may carry. The bundle is a renderer and a player;
// editor input code, the app's chrome, React and the Tauri bridge have no business in a page a
// reader opens, and a module from any of them in the bundle fails the build.
//
// `rel` is a module path relative to the frontend root with forward slashes. Matching is by path
// prefix, never by substring: `src/render/synth/chrome/skinToCssVars.ts` contains the text
// `chrome/` and is renderer code.

const REFUSED_PACKAGES = ['react', 'react-dom', 'scheduler', '@tauri-apps'] as const;

/** An svg file directly inside `src/chrome/assets/`, the one part of chrome the board may use. */
const CHROME_SVG = /^src\/chrome\/assets\/[^/]+\.svg$/;

/** Why the module may not enter the bundle, or null when it may. */
export function refusedModule(rel: string): string | null {
  if (rel.startsWith('src/input/')) return `${rel} is editor input code (src/input/)`;
  if (rel.startsWith('src/chrome/') && !CHROME_SVG.test(rel)) {
    return `${rel} is app chrome (src/chrome/; only svg files directly in src/chrome/assets/ may be used)`;
  }
  for (const pkg of REFUSED_PACKAGES) {
    const prefix = `node_modules/${pkg}/`;
    if (rel.startsWith(prefix)) return `${rel} is from ${prefix}`;
  }
  return null;
}

/**
 * A bundler module id as the path `refusedModule` reads, or null for an id that isn't a file path
 * (a virtual module, a helper). Drops a leading NUL and the query, uses forward slashes, and takes
 * the path relative to `root`. A package file is named from its last `node_modules/` segment
 * instead, because a linked or hoisted `node_modules` resolves to a real path outside the root.
 */
export function moduleRel(id: string, root: string): string | null {
  const clean = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  if (!clean.startsWith('/') && !/^[A-Za-z]:\//.test(clean)) return null;
  const pkgAt = clean.lastIndexOf('/node_modules/');
  if (pkgAt >= 0) return clean.slice(pkgAt + 1);
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (clean.startsWith(`${base}/`)) return clean.slice(base.length + 1);
  return clean;
}
