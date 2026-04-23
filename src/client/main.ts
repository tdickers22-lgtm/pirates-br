import { Game } from './core/Game.js';

const game = new Game();

game.init().catch((error) => {
  console.error(error);
  const loadingText = document.getElementById('loading-text');
  if (loadingText) {
    loadingText.textContent = 'Failed to launch Pirates BR. Check the console for details.';
  }
});
