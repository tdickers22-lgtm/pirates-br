import { Game } from './core/Game.js';
import { ensureFillBench } from './rendering/FillBench.js';
import { readGpuRendererString } from './rendering/QualityPreference.js';

const game = new Game();

if (new URLSearchParams(window.location.search).has('debug')) {
  (window as Window & { __piratesBR?: Game }).__piratesBR = game;
}

// Characterise this GPU once the menu is up and nothing else wants the frame.
// The score is for the NEXT launch (FillBench.ts): it is what separates an M2
// Air from an M2 Ultra in Safari, where every other detector input is opaque.
// ensureFillBench aborts itself if a match starts under it.
game.init().then(() => {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  const start = () => ensureFillBench(readGpuRendererString());
  if (idle) idle(start, { timeout: 4000 });
  else window.setTimeout(start, 1500);
}).catch((error) => {
  console.error(error);
  const loadingText = document.getElementById('loading-text');
  const loadingBar = document.getElementById('loading-bar');
  if (loadingBar) loadingBar.style.width = '0%';
  if (loadingText) {
    loadingText.textContent = 'Failed to launch Pirates BR. Check the console for details.';
  }
});
