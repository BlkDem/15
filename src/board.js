import * as THREE from 'three';
import { ease } from './stage.js';
import { setSeed, setBoardAO } from './materials.js';

const TILE_Y = 0.003;
const PITCH = 1.0;

function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Готовит шаблоны из glTF: роли мешей и сиды 3D-текстур. */
export function prepareAssets(gltf) {
  const tiles = new Map();
  const frames = new Map();
  gltf.scene.traverse((o) => {
    if (o.isMesh) {
      const name = o.material?.name || '';
      o.userData.role = name.includes('ink') ? 'tileInk' : name.includes('body') ? 'tileBody' : name.includes('floor') ? 'floor' : 'frame';
      o.castShadow = true;
      o.receiveShadow = true;
    }
    const m = /^tile_(\d+)$/.exec(o.name);
    if (m) tiles.set(+m[1], o);
    const f = /^frame_(\d)$/.exec(o.name);
    if (f) frames.set(+f[1], o);
  });
  for (const [n, obj] of tiles) {
    const rnd = mulberry(n * 977 + 13);
    const seed = [rnd() * 60 - 30, rnd() * 3 - 1.5, rnd() * 6 - 3, (rnd() - 0.5) * 0.12];
    obj.traverse((o) => { if (o.isMesh) setSeed(o.geometry, ...seed); });
  }
  for (const [, obj] of frames) {
    obj.traverse((o) => {
      if (o.isMesh) {
        setSeed(o.geometry, 0, 0, 0, 0);
        if (o.userData.role === 'floor') o.castShadow = false;
      }
    });
  }
  return { tiles, frames };
}

export class Board {
  constructor(stage, assets) {
    this.stage = stage;
    this.assets = assets;
    this.root = new THREE.Group();
    stage.scene.add(this.root);
    this.tiles = new Map(); // номер -> Object3D
    this.frame = null;
    this.n = 0;
    this.materials = null;
    this.slideTweens = [];
    this.busy = false; // идёт «большая» анимация (перемешивание/победа)
    this.raycaster = new THREE.Raycaster();
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3);
  }

  get outerSize() {
    return this.n + 0.03 + 2 * 0.4 + 2 * 0.07;
  }

  cellPos(index, n = this.n, out = new THREE.Vector3()) {
    const r = Math.floor(index / n);
    const c = index % n;
    return out.set((c - (n - 1) / 2) * PITCH, TILE_Y, (r - (n - 1) / 2) * PITCH);
  }

  build(puzzle) {
    const n = puzzle.n;
    for (const t of this.tiles.values()) this.root.remove(t);
    this.tiles.clear();
    if (this.frame) this.root.remove(this.frame);

    this.n = n;
    setBoardAO(n);
    this.frame = this.assets.frames.get(n).clone();
    this.root.add(this.frame);
    for (let k = 1; k < n * n; k++) {
      const t = this.assets.tiles.get(k).clone();
      t.userData.number = k;
      t.traverse((o) => { if (o.isMesh) o.userData.number = k; });
      this.tiles.set(k, t);
      this.root.add(t);
    }
    this.applyMaterials(this.materials);
    this.place(puzzle);
    this.stage.setBoardSize(this.outerSize);
  }

  applyMaterials(mats) {
    if (!mats) return;
    this.materials = mats;
    this.root.traverse((o) => {
      if (o.isMesh && mats[o.userData.role]) o.material = mats[o.userData.role];
    });
    this.stage.invalidate();
  }

  place(puzzle) {
    puzzle.cells.forEach((k, i) => {
      if (!k) return;
      const t = this.tiles.get(k);
      this.cellPos(i, this.n, t.position);
      t.rotation.set(0, 0, 0);
    });
    this.stage.invalidate();
  }

  panOf(x) {
    return (x / Math.max(1, this.n / 2)) * 0.6;
  }

  // ------------------------------------------------------------------ пикинг
  pick(clientX, clientY) {
    this.stage.ray(clientX, clientY, this.raycaster);
    const hits = this.raycaster.intersectObjects([...this.tiles.values()], true);
    for (const h of hits) {
      const k = h.object.userData.number;
      if (k) return k;
    }
    return 0;
  }

  /** Точка на плоскости верха костяшек под курсором. */
  planePoint(clientX, clientY, out = new THREE.Vector3()) {
    this.stage.ray(clientX, clientY, this.raycaster);
    return this.raycaster.ray.intersectPlane(this.dragPlane, out);
  }

  // ------------------------------------------------------------------ сдвиги
  /** Мгновенно завершить текущие сдвиги (для быстрых последовательных ходов). */
  flush() {
    for (const tw of this.slideTweens) tw.finish();
    this.slideTweens = [];
  }

  /** Сдвиг цепочки на долю шага t (0..1) — для перетаскивания пальцем. */
  setChainOffset(chain, puzzle, t) {
    for (const i of chain.indices) {
      const k = puzzle.cells[i];
      const tile = this.tiles.get(k);
      this.cellPos(i, this.n, tile.position);
      tile.position.x += chain.dc * t * PITCH;
      tile.position.z += chain.dr * t * PITCH;
    }
    this.stage.invalidate();
  }

  /**
   * Анимированный сдвиг цепочки из текущего смещения from (0..1) в to (0 или 1).
   * puzzle — состояние ДО хода. Возвращает Promise, onImpact вызывается в момент удара.
   */
  animateChain(chain, puzzle, { from = 0, to = 1, sound, haptic, velocity = 0, slideSound = true } = {}) {
    const tiles = chain.indices.map((i) => ({ tile: this.tiles.get(puzzle.cells[i]), base: this.cellPos(i, this.n) }));
    const dist = Math.abs(to - from);
    const speedBoost = Math.min(0.45, Math.abs(velocity) * 40);
    const duration = Math.max(45, (105 + 18 * (tiles.length - 1)) * Math.sqrt(dist) * (1 - speedBoost));
    const x = tiles.length ? tiles[0].tile.position.x : 0;
    if (to === 1 && sound && slideSound) sound.slide(duration / 1000, this.panOf(x), 0.6 + 0.2 * tiles.length);

    return new Promise((resolve) => {
      const set = (v) => {
        for (const { tile, base } of tiles) {
          tile.position.x = base.x + chain.dc * v * PITCH;
          tile.position.z = base.z + chain.dr * v * PITCH;
        }
      };
      const tw = this.stage.tweens.add({
        duration,
        easing: to === 1 ? ease.slide : ease.outCubic,
        update: (e) => set(from + (to - from) * e),
        done: () => {
          this.slideTweens = this.slideTweens.filter((t) => t !== tw);
          if (to === 1) {
            sound?.click(Math.min(1, 0.55 + 0.25 * tiles.length + speedBoost), this.panOf(x));
            haptic?.(tiles.length > 1 ? 14 : 9);
            this._rebound(tiles, chain);
          }
          resolve();
        },
      });
      this.slideTweens.push(tw);
    });
  }

  /** Микро-отскок после удара (визуальная «упругость» материала). */
  _rebound(tiles, chain) {
    const amp = 0.014;
    for (const { tile, base } of tiles) {
      const fx = base.x + chain.dc * PITCH;
      const fz = base.z + chain.dr * PITCH;
      this.stage.tweens.add({
        duration: 90,
        update: (e, t) => {
          const k = Math.sin(t * Math.PI) * amp * (1 - t);
          tile.position.x = fx - chain.dc * k;
          tile.position.z = fz - chain.dr * k;
        },
      });
    }
  }

  /** Костяшку нельзя сдвинуть — легонько дёргается. */
  shake(k, sound) {
    const tile = this.tiles.get(k);
    if (!tile || tile.userData.shaking) return;
    tile.userData.shaking = true;
    const x0 = tile.position.x;
    sound?.thud(this.panOf(x0));
    this.stage.tweens.add({
      duration: 260,
      update: (e, t) => {
        tile.position.x = x0 + Math.sin(t * Math.PI * 5) * 0.022 * (1 - t);
        tile.rotation.y = Math.sin(t * Math.PI * 5) * 0.012 * (1 - t);
      },
      done: () => {
        tile.position.x = x0;
        tile.rotation.y = 0;
        tile.userData.shaking = false;
      },
    });
  }

  // ------------------------------------------------------------------ большие анимации
  /** Перемешивание: костяшки взлетают, перелетают на новые места и со стуком падают. */
  async animateShuffle(fromCells, toCells, sound, haptic) {
    this.busy = true;
    this.flush();
    const n = this.n;
    const tw = this.stage.tweens;
    const from = new Map();
    const to = new Map();
    fromCells.forEach((k, i) => k && from.set(k, this.cellPos(i, n)));
    toCells.forEach((k, i) => k && to.set(k, this.cellPos(i, n)));

    sound?.whoosh(0.5, true);
    const jobs = [];
    for (const [k, tile] of this.tiles) {
      const a = from.get(k);
      const b = to.get(k);
      const lift = 0.9 + Math.random() * 0.7;
      const d0 = Math.random() * 140;
      const spin = (Math.random() - 0.5) * 1.4;
      const tiltX = (Math.random() - 0.5) * 0.5;
      const tiltZ = (Math.random() - 0.5) * 0.5;
      const flight = 520 + Math.random() * 160;
      const fall = 260 + Math.random() * 60;
      jobs.push(
        new Promise((resolve) => {
          // взлёт
          tw.add({
            delay: d0, duration: 260, easing: ease.outCubic,
            update: (e) => {
              tile.position.set(a.x, TILE_Y + lift * e, a.z);
              tile.rotation.set(tiltX * e, spin * 0.3 * e, tiltZ * e);
            },
            done: () => {
              // перелёт
              tw.add({
                duration: flight, easing: ease.inOutCubic,
                update: (e) => {
                  tile.position.x = a.x + (b.x - a.x) * e;
                  tile.position.z = a.z + (b.z - a.z) * e;
                  tile.position.y = TILE_Y + lift + Math.sin(e * Math.PI) * 0.35;
                  tile.rotation.set(tiltX * (1 - e), spin * (0.3 + 0.7 * e), tiltZ * (1 - e));
                },
                done: () => {
                  // падение
                  tw.add({
                    delay: Math.random() * 160, duration: fall, easing: ease.inQuad,
                    update: (e) => {
                      tile.position.set(b.x, TILE_Y + lift * (1 - e), b.z);
                      tile.rotation.set(0, spin * (1 - e), 0);
                    },
                    done: () => {
                      tile.position.set(b.x, TILE_Y, b.z);
                      tile.rotation.set(0, 0, 0);
                      sound?.click(0.7 + Math.random() * 0.3, this.panOf(b.x));
                      haptic?.(6);
                      this._bounce(tile, 0.045, 140).then(resolve);
                    },
                  });
                },
              });
            },
          });
        }),
      );
    }
    await Promise.all(jobs);
    this.busy = false;
  }

  _bounce(tile, h, dur) {
    return new Promise((resolve) => {
      const y0 = TILE_Y;
      this.stage.tweens.add({
        duration: dur,
        update: (e, t) => { tile.position.y = y0 + Math.sin(t * Math.PI) * h; },
        done: () => { tile.position.y = y0; resolve(); },
      });
    });
  }

  /** Появление: рамка опускается на стол, затем костяшки падают в неё. */
  async animateDropIn(puzzle, sound, haptic) {
    this.busy = true;
    const tw = this.stage.tweens;
    const frame = this.frame;
    frame.position.y = 0.9;
    for (const t of this.tiles.values()) t.visible = false;
    await new Promise((resolve) => {
      tw.add({
        duration: 380, easing: ease.inQuad,
        update: (e) => { frame.position.y = 0.9 * (1 - e); },
        done: () => {
          sound?.boom();
          haptic?.(18);
          tw.add({
            duration: 160,
            update: (e, t) => { frame.position.y = Math.sin(t * Math.PI) * 0.03; },
            done: () => { frame.position.y = 0; resolve(); },
          });
        },
      });
    });
    const order = [];
    puzzle.cells.forEach((k, i) => k && order.push([k, i]));
    const jobs = order.map(([k, i], j) => {
      const tile = this.tiles.get(k);
      const p = this.cellPos(i);
      const h = 4 + Math.random() * 1.5;
      const delay = j * 38 + Math.random() * 30;
      const rot = (Math.random() - 0.5) * 0.6;
      return new Promise((resolve) => {
        tw.add({
          delay, duration: 360, easing: ease.inQuad,
          update: (e) => {
            tile.visible = true;
            tile.position.set(p.x, TILE_Y + h * (1 - e), p.z);
            tile.rotation.set(0, rot * (1 - e), 0);
          },
          done: () => {
            sound?.click(0.75, this.panOf(p.x));
            haptic?.(5);
            this._bounce(tile, 0.06, 150).then(resolve);
          },
        });
      });
    });
    await Promise.all(jobs);
    this.busy = false;
  }

  /** Победа: волна сальто по диагонали с нотами маримбы. */
  async animateWin(sound, haptic) {
    this.busy = true;
    const tw = this.stage.tweens;
    const n = this.n;
    const jobs = [];
    for (const [k, tile] of this.tiles) {
      const i = k - 1;
      const r = Math.floor(i / n);
      const c = i % n;
      const p = this.cellPos(i);
      const delay = (r + c) * 85;
      const step = r + c;
      jobs.push(
        new Promise((resolve) => {
          tw.add({
            delay, duration: 620, easing: ease.linear,
            update: (e, t) => {
              // сальто вокруг центра костяшки (origin модели — в центре дна)
              const h = Math.sin(t * Math.PI) * 0.95;
              const a = ease.inOutCubic(t) * Math.PI * 2;
              const c = 0.15;
              tile.rotation.set(a, 0, 0);
              tile.position.set(p.x, TILE_Y + h + c - c * Math.cos(a), p.z - c * Math.sin(a));
            },
            done: () => {
              tile.position.copy(p);
              tile.rotation.set(0, 0, 0);
              sound?.click(0.5, this.panOf(p.x));
              resolve();
            },
          });
          tw.add({ delay, duration: 1, done: () => { sound?.marimba(step + (c % 2), 0, this.panOf(p.x), 0.5); haptic?.(4); } });
        }),
      );
    }
    tw.add({ delay: (2 * n - 2) * 85 + 380, duration: 1, done: () => sound?.chime() });
    await Promise.all(jobs);
    this.busy = false;
  }
}
