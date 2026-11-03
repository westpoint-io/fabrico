// The embed bundle's entry. `pixi.js/unsafe-eval` comes first: under the strict page policy
// (`script-src 'unsafe-inline' 'wasm-unsafe-eval'`, no 'unsafe-eval') Pixi throws at boot unless
// its no-eval shader and uniform paths are installed before anything else from Pixi loads.
import 'pixi.js/unsafe-eval';
import './element';

declare global {
  interface Window {
    FabricoEmbed?: { version: number };
  }
}

window.FabricoEmbed = { version: 1 };
