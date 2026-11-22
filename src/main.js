import './style.css';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Stage } from './stage.js';
import { Board, prepareAssets } from './board.js';
import { SoundEngine } from './audio.js';
import { Game } from './game.js';
import { UI } from './ui.js';
import { store } from './storage.js';

const ui = new UI();
const stage = new Stage(document.getElementById('scene'));
const sound = new SoundEngine();

// звук можно включить только из жеста пользователя; разные браузеры считают жестами разные события
for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
  window.addEventListener(ev, () => sound.unlock(), { capture: true, passive: true });
}

function updateInsets() {
  const { top, bottom } = ui.insets();
  stage.setInsets(top, bottom);
}

async function boot() {
  ui.progress(0.05);
  const loader = new GLTFLoader();
  const url = `${import.meta.env.BASE_URL}models/puzzle.glb`;
  const gltf = await loader.loadAsync(url, (e) => {
    if (e.total) ui.progress(0.05 + 0.75 * (e.loaded / e.total));
  });
  ui.progress(0.82, 'Шлифуем фаски…');

  const assets = prepareAssets(gltf);
  const board = new Board(stage, assets);
  const game = new Game({ stage, board, sound, ui });
  if (import.meta.env.DEV) window.__game = game; // отладка из консоли и автотесты

  ui.init(store.data.settings);
  ui.on('new', () => { sound.unlock(); game.newGame(); });
  ui.on('size', (n) => { sound.unlock(); game.setSize(n); });
  ui.on('theme', (id) => { sound.unlock(); game.applyTheme(id); });
  ui.on('sound', () => game.toggleSound());
  ui.on('setting', async (key, value) => {
    if (key === 'sound') {
      if (value !== game.settings.sound) game.toggleSound();
      return;
    }
    if (key === 'parallax') {
      stage.parallaxOn = value;
      if (!value) {
        stage.view.tx = 0;
        stage.view.ty = 0;
      }
      if (value && typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        try { await DeviceOrientationEvent.requestPermission(); } catch { /* */ }
      }
    }
    game.setSetting(key, value);
  });
  ui.on('uitick', () => { sound.unlock(); sound.tick(); });

  game.init();
  stage.parallaxOn = game.settings.parallax;
  updateInsets();
  window.addEventListener('resize', updateInsets);
  new ResizeObserver(updateInsets).observe(document.getElementById('dock'));

  ui.progress(0.9, 'Полируем лак…');
  try {
    await stage.renderer.compileAsync(stage.scene, stage.camera);
  } catch {
    /* старые браузеры — скомпилируется при первом кадре */
  }
  ui.progress(1);
  stage.invalidate();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  ui.hideLoader();
  document.body.classList.add('ready');
  setTimeout(updateInsets, 1300); // панели доехали до своих мест после анимации появления
  await game.intro();
  window.__ready = true;
  // остальные наборы — в фоне
  setTimeout(() => game.precompileThemes(), 1200);
}

boot().catch((err) => {
  console.error(err);
  ui.showError('Не удалось загрузить игру. Проверьте соединение и обновите страницу.');
});
