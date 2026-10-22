import { Game } from './core/Game';
import { generateRandomSeed, getSeedFromUrl } from './utils/Random';

// Deterministic world with ?seed=12345 (or any string); random otherwise.
const seed = getSeedFromUrl() ?? generateRandomSeed();
const params = new URLSearchParams(window.location.search);

if (params.has('noui')) {
  // Clean screenshot mode: no HUD, no loading screen, world straight away.
  document.getElementById('hud')!.style.display = 'none';
  document.getElementById('loading-screen')!.style.display = 'none';
  Game.create(seed).then(game => game.start());
} else {
  // Game.create yields to the main thread between heavy phases so the loading
  // animation keeps compositing while the world builds behind it.
  (async () => {
    const game = await Game.create(seed);
    game.start();
    game.runIntro();
  })();
}
