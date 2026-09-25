// THE SHELL ENTRY (b3.1f, performance-10).
//
// This file is the only JavaScript the page runs before the game chunk arrives.
// The loading veil is static markup in index.html, so it paints before any
// script; the game (renderer, world, HUD, and today still the menu, which
// Game owns) is a dynamic import kicked on the first line below. The build
// (vite.config.ts pirates-preload-game) puts <link rel="modulepreload"> for the
// game chunk and its static deps into index.html, so the fetch starts at HTML
// parse exactly as the old single static entry did: no added round trip, and
// the entry stays a few hundred bytes. scripts/test-bundle-budget.mjs grades
// where each module lands; a static `import { Game }` here FAILS it.
type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
  __piratesBR?: unknown;
};

const gameChunk = import('./core/Game.js');

function showLaunchFailure(error: unknown): void {
  console.error(error);
  const loadingText = document.getElementById('loading-text');
  const loadingBar = document.getElementById('loading-bar');
  if (loadingBar) loadingBar.style.width = '0%';
  if (loadingText) {
    loadingText.textContent = 'Failed to launch Pirates BR. Check the console for details.';
  }
}

gameChunk.then(async ({ Game }) => {
  const game = new Game();
  // Debug hooks (window.__piratesBR: probes, free-cam, census) exist only with ?debug.
  if (new URLSearchParams(window.location.search).has('debug')) {
    (window as IdleWindow).__piratesBR = game;
  }
  await game.init();
  // Characterise this GPU once the menu is up and nothing else wants the frame.
  // The score is for the NEXT launch (FillBench.ts): it is what separates an M2
  // Air from an M2 Ultra in Safari, where every other detector input is opaque.
  // ensureFillBench aborts itself if a match starts under it. Its modules are
  // already in the game chunk's graph; the import only names them.
  const idle = (window as IdleWindow).requestIdleCallback;
  const start = () => {
    void Promise.all([import('./rendering/FillBench.js'), import('./rendering/QualityPreference.js')])
      .then(([bench, quality]) => bench.ensureFillBench(quality.readGpuRendererString()))
      .catch((error) => console.warn('fill bench skipped', error));
  };
  if (idle) idle(start, { timeout: 4000 });
  else window.setTimeout(start, 1500);
}).catch(showLaunchFailure);
