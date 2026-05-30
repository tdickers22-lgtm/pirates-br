import { Game } from './core/Game.js';

const game = new Game();

if (new URLSearchParams(window.location.search).has('debug')) {
  (window as Window & { __piratesBR?: Game }).__piratesBR = game;
}

game.init().catch((error) => {
  console.error(error);
  const loadingText = document.getElementById('loading-text');
  const loadingBar = document.getElementById('loading-bar');
  if (loadingBar) loadingBar.style.width = '0%';
  if (loadingText) {
    loadingText.textContent = 'Failed to launch Pirates BR. Check the console for details.';
  }
});
