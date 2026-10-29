import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './chrome/App';

// React owns the DOM chrome; Pixi owns the canvas (mounted OUTSIDE the reconciler
// inside <App/>). StrictMode double-invokes effects in dev — App's pixiApp mount
// carries a `disposed` guard so only one Application/canvas survives (Pitfall 5).
const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
