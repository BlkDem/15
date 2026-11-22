import * as THREE from 'three';
import { Puzzle } from './puzzle.js';
import { themeMaterials, getTheme, THEMES } from './materials.js';
import { store } from './storage.js';

const SIZES = [3, 4, 5];

export class Game {
  constructor({ stage, board, sound, ui }) {
    this.stage = stage;
    this.board = board;
    this.sound = sound;
    this.ui = ui;
    this.settings = store.data.settings;
    if (!SIZES.includes(this.settings.size)) this.settings.size = 4;

    this.puzzle = new Puzzle(this.settings.size);
    this.moves = 0;
    this.elapsed = 0; // мс
    this.runningSince = 0; // performance.now() старта, 0 — таймер стоит
    this.phase = 'idle'; // idle | playing | won
    this.drag = null;
    this.locked = false;

    this.haptic = (ms) => {
      if (this.settings.haptics && navigator.vibrate) navigator.vibrate(ms);
    };
  }

  // ------------------------------------------------------------------ запуск
  init() {
    const saved = store.data.game;
    if (saved && saved.size === this.settings.size && saved.cells?.length === saved.size ** 2 && Puzzle.isSolvable(saved.cells, saved.size)) {
      this.puzzle = new Puzzle(saved.size, saved.cells);
      this.moves = saved.moves || 0;
      this.elapsed = saved.elapsed || 0;
      this.phase = saved.solved || this.puzzle.isSolved() ? 'idle' : this.moves > 0 ? 'playing' : 'idle';
      this.resumed = true;
    }
    this.applyTheme(this.settings.theme, false);
    this.board.build(this.puzzle);
    this.sound.setEnabled(this.settings.sound);
    this._bindInput();
    this._updateHud();
    setInterval(() => this._updateHud(), 250);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._pauseTimer();
      this._persist();
    });
    window.addEventListener('pagehide', () => this._persist());
  }

  async intro() {
    this.locked = true;
    await this.board.animateDropIn(this.puzzle, this.sound, this.haptic);
    this.locked = false;
    if (!this.resumed || this.puzzle.isSolved()) {
      await this.stage.tweens.wait(350);
      await this.newGame();
    }
  }

  // ------------------------------------------------------------------ игра
  async newGame() {
    if (this.locked) return;
    this.locked = true;
    this.ui.hideWin();
    this.board.flush();
    const before = this.puzzle.cells.slice();
    this.puzzle.shuffle();
    this.moves = 0;
    this.elapsed = 0;
    this.runningSince = 0;
    this.phase = 'idle';
    this._updateHud();
    await this.board.animateShuffle(before, this.puzzle.cells, this.sound, this.haptic);
    this.locked = false;
    this._persist();
  }

  async setSize(n) {
    if (!SIZES.includes(n) || this.locked || n === this.puzzle.n) return;
    this.settings.size = n;
    store.save();
    this.ui.syncSettings(this.settings);
    this.locked = true;
    this.ui.hideWin();
    this.board.flush();
    this.puzzle = new Puzzle(n);
    this.moves = 0;
    this.elapsed = 0;
    this.runningSince = 0;
    this.phase = 'idle';
    this.board.build(this.puzzle);
    this._updateHud();
    await this.board.animateDropIn(this.puzzle, this.sound, this.haptic);
    this.locked = false;
    await this.stage.tweens.wait(250);
    await this.newGame();
  }

  applyTheme(id, save = true) {
    const theme = getTheme(id);
    const mats = themeMaterials(theme.id);
    this.board.applyMaterials(mats);
    this.stage.setTableMaterial(mats.table);
    this.sound.setPreset(theme.sound);
    this.settings.theme = theme.id;
    document.documentElement.style.setProperty('--accent', theme.ui.accent);
    if (save) {
      store.save();
      this.sound.click(0.8, 0);
    }
    this.ui.syncSettings(this.settings);
  }

  /** Компиляция шейдеров остальных тем в фоне, чтобы переключение было мгновенным. */
  async precompileThemes() {
    const r = this.stage.renderer;
    if (!r.compileAsync) return;
    const sample = [];
    this.board.root.traverse((o) => {
      if (o.isMesh && !sample.some((s) => s.userData.role === o.userData.role)) sample.push(o);
    });
    for (const t of THEMES) {
      if (t.id === this.settings.theme) continue;
      const mats = themeMaterials(t.id);
      const g = new THREE.Group();
      for (const m of sample) {
        const c = new THREE.Mesh(m.geometry, mats[m.userData.role]);
        c.castShadow = true;
        c.receiveShadow = true;
        g.add(c);
      }
      g.add(new THREE.Mesh(this.stage.table.geometry, mats.table));
      try {
        await r.compileAsync(g, this.stage.camera, this.stage.scene);
      } catch {
        /* не критично */
      }
    }
  }

  toggleSound() {
    this.settings.sound = !this.settings.sound;
    this.sound.unlock();
    this.sound.setEnabled(this.settings.sound);
    store.save();
    this.ui.syncSettings(this.settings);
    if (this.settings.sound) this.sound.tick(true);
  }

  setSetting(key, value) {
    this.settings[key] = value;
    store.save();
    this.ui.syncSettings(this.settings);
  }

  /** Совершить ход цепочкой (анимированно). */
  commit(chain, { from = 0, velocity = 0 } = {}) {
    const before = new Puzzle(this.puzzle.n, this.puzzle.cells);
    this.puzzle.apply(chain);
    this.moves += chain.indices.length;
    if (this.phase !== 'playing') {
      this.phase = 'playing';
    }
    if (!this.runningSince) this.runningSince = performance.now();
    const solved = this.puzzle.isSolved();
    if (solved) {
      this._pauseTimer();
      this.locked = true;
    }
    this._updateHud();
    const p = this.board.animateChain(chain, before, {
      from, to: 1, velocity, haptic: this.haptic,
      sound: this.sound,
      slideSound: from < 0.6,
    });
    this._persist();
    if (solved) p.then(() => this._win());
    return p;
  }

  async _win() {
    this.phase = 'won';
    this.board.flush();
    const n = this.puzzle.n;
    const time = Math.round(this.elapsed);
    const best = (store.data.best[n] ||= { time: 0, moves: 0, wins: 0 });
    const recordTime = !best.time || time < best.time;
    const recordMoves = !best.moves || this.moves < best.moves;
    if (recordTime) best.time = time;
    if (recordMoves) best.moves = this.moves;
    best.wins = (best.wins || 0) + 1;
    store.data.game = null;
    store.save();
    await this.stage.tweens.wait(180);
    await this.board.animateWin(this.sound, this.haptic);
    this.locked = false;
    this.ui.showWin({ time, moves: this.moves, recordTime, recordMoves, best, n });
  }

  // ------------------------------------------------------------------ таймер/HUD
  get time() {
    return this.elapsed + (this.runningSince ? performance.now() - this.runningSince : 0);
  }

  _pauseTimer() {
    if (this.runningSince) {
      this.elapsed += performance.now() - this.runningSince;
      this.runningSince = 0;
    }
  }

  _resumeTimer() {
    if (this.phase === 'playing' && !this.runningSince) this.runningSince = performance.now();
  }

  _updateHud() {
    this.ui.setStats(this.moves, this.time);
  }

  _persist() {
    if (this.phase === 'won') return;
    store.data.game = {
      size: this.puzzle.n,
      cells: this.puzzle.cells,
      moves: this.moves,
      elapsed: Math.round(this.time),
      solved: this.puzzle.isSolved(),
    };
    store.save();
  }

  // ------------------------------------------------------------------ ввод
  _bindInput() {
    const canvas = this.stage.canvas;
    const tmp = new THREE.Vector3();

    canvas.addEventListener('pointerdown', (e) => {
      this.sound.unlock();
      if (!e.isPrimary || this.locked || this.board.busy) return;
      this._resumeTimer();
      this.board.flush();
      const k = this.board.pick(e.clientX, e.clientY);
      const chain = k ? this.puzzle.chainFor(this.puzzle.indexOfTile(k)) : null;
      const start = this.board.planePoint(e.clientX, e.clientY, new THREE.Vector3());
      this.drag = {
        id: e.pointerId, k, chain, start, sx: e.clientX, sy: e.clientY,
        t: 0, vel: 0, lastT: 0, lastTime: performance.now(), moved: false, consumed: false,
      };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* */ }
      if (chain) canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) {
        if (e.pointerType === 'mouse') {
          this.stage.setParallax((e.clientX / this.stage.width) * 2 - 1, (e.clientY / this.stage.height) * 2 - 1);
          this._hover(e);
        }
        return;
      }
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 7) d.moved = true;
      if (!d.chain || d.consumed || !d.start) return;
      const p = this.board.planePoint(e.clientX, e.clientY, tmp);
      if (!p) return;
      const delta = (p.x - d.start.x) * d.chain.dc + (p.z - d.start.z) * d.chain.dr;
      const t = Math.max(0, Math.min(1, delta));
      const now = performance.now();
      const dt = Math.max(1, now - d.lastTime);
      d.vel = d.vel * 0.6 + ((t - d.lastT) / dt) * 0.4;
      d.lastT = t;
      d.lastTime = now;
      d.t = t;
      if (t >= 0.985) {
        d.consumed = true;
        this.commit(d.chain, { from: t, velocity: d.vel });
        return;
      }
      this.board.setChainOffset(d.chain, this.puzzle, t);
    });

    const end = (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      canvas.style.cursor = '';
      if (d.consumed || this.locked) return;
      if (d.chain) {
        if (!d.moved || d.t > 0.4 || d.vel > 0.0025) {
          this.commit(d.chain, { from: d.t, velocity: d.moved ? d.vel : 0 });
        } else if (d.t > 0) {
          this.board.animateChain(d.chain, this.puzzle, { from: d.t, to: 0 });
        } else if (d.moved) {
          this._swipe(e.clientX - d.sx, e.clientY - d.sy);
        }
        return;
      }
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.hypot(dx, dy) > 28) this._swipe(dx, dy);
      else if (d.k) this.board.shake(d.k, this.sound);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', (e) => {
      const d = this.drag;
      if (d && d.chain && !d.consumed && d.t > 0) this.board.animateChain(d.chain, this.puzzle, { from: d.t, to: 0 });
      this.drag = null;
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || this.ui.modalOpen) return;
      const dirs = {
        ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0],
        KeyA: [0, -1], KeyD: [0, 1], KeyW: [-1, 0], KeyS: [1, 0],
      };
      const dir = dirs[e.code];
      if (dir) {
        e.preventDefault();
        this.sound.unlock();
        if (this.locked || this.board.busy) return;
        this._resumeTimer();
        this.board.flush();
        const chain = this.puzzle.chainForDirection(dir[0], dir[1]);
        if (chain) this.commit(chain);
        else this.sound.thud(0);
      } else if (e.code === 'KeyN' && !e.ctrlKey && !e.metaKey) {
        this.sound.unlock();
        this.newGame();
      }
    });

    // наклон устройства -> параллакс
    let base = null;
    window.addEventListener('deviceorientation', (e) => {
      if (!this.settings.parallax || e.beta == null || e.gamma == null) return;
      const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      let gx = e.gamma;
      let gy = e.beta;
      if (angle === 90) [gx, gy] = [e.beta, -e.gamma];
      else if (angle === -90 || angle === 270) [gx, gy] = [-e.beta, e.gamma];
      if (!base) base = { x: gx, y: gy };
      base.x += (gx - base.x) * 0.01;
      base.y += (gy - base.y) * 0.01;
      if (!this.drag) this.stage.setParallax((gx - base.x) / 18, (gy - base.y) / 18);
    });
  }

  _swipe(dx, dy) {
    let dr = 0;
    let dc = 0;
    if (Math.abs(dx) > Math.abs(dy)) dc = Math.sign(dx);
    else dr = Math.sign(dy);
    const chain = this.puzzle.chainForDirection(dr, dc);
    if (chain) this.commit(chain);
  }

  _hover(e) {
    if (this.locked || this.board.busy) {
      this.stage.canvas.style.cursor = '';
      return;
    }
    const k = this.board.pick(e.clientX, e.clientY);
    const movable = k && this.puzzle.chainFor(this.puzzle.indexOfTile(k));
    this.stage.canvas.style.cursor = movable ? 'grab' : '';
  }
}
