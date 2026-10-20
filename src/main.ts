import { Game } from './core/Game';
import { generateRandomSeed, getSeedFromUrl } from './utils/Random';

// Deterministic world with ?seed=12345 (or any string); random otherwise.
const seed = getSeedFromUrl() ?? generateRandomSeed();
const params = new URLSearchParams(window.location.search);

if (params.has('noui')) {
  // Clean screenshot mode: no HUD, no loading screen, world straight away.
  document.getElementById('hud')!.style.display = 'none';
  document.getElementById('loading-screen')!.style.display = 'none';
  const game = new Game(seed);
  game.start();
} else {
  // Let the loading screen paint a frame first, then forge the world behind it
  // (the heavy build blocks the main thread, but the loading animation is
  // composited so it keeps moving). Once ready, the loading screen lets the
  // player click into an already-loaded world.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const game = new Game(seed);
      game.start();
      game.runIntro();
    });
  });
}
