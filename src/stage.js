import * as THREE from 'three';
import { setSeed } from './materials.js';

/**
 * Окружение для отражений — как в предметной съёмке: тёмная комната и несколько софтбоксов,
 * расположенных там же, где реальные источники света сцены.
 */
function studioEnvironment() {
  const scene = new THREE.Scene();
  const roomGeo = new THREE.SphereGeometry(30, 48, 24);
  const colors = [];
  const pos = roomGeo.attributes.position;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 30;
    if (y < -0.05) c.setRGB(0.018, 0.014, 0.011);
    else c.setRGB(0.045, 0.038, 0.032).lerp(new THREE.Color(0.035, 0.034, 0.033), Math.max(0, y));
    colors.push(c.r, c.g, c.b);
  }
  roomGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(roomGeo, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));

  const panel = (w, h, intensity, color, position) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.copy(position);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  // ключевой тёплый софтбокс (совпадает со SpotLight)
  panel(9, 6, 5.5, '#fff0dc', new THREE.Vector3(-4.2, 11, 6.5).setLength(18));
  // верхний софтбокс за доской слева — мягкий градиентный блик на глянце части костяшек
  panel(7, 4, 1.6, '#fff6ea', new THREE.Vector3(-5, 13, -8));
  // холодный контровой
  panel(5, 9, 3.2, '#d6e4ff', new THREE.Vector3(9, 5, -9));
  // слабый отражённый свет спереди
  panel(14, 2, 0.35, '#ffe2c4', new THREE.Vector3(0, 2.5, 16));
  return scene;
}

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t) => {
    const c1 = 1.4;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  // толчок с «ударом» в конце: скорость в момент касания не нулевая
  slide: (t) => 0.55 * t + 0.45 * (1 - (1 - t) * (1 - t)),
};

/** Простая система твинов, работающая в цикле рендера. */
class Tweens {
  constructor() { this.list = new Set(); }
  get active() { return this.list.size > 0; }

  add({ duration = 300, delay = 0, update, done, easing = ease.linear }) {
    const tw = { start: performance.now() + delay, duration, update, done, easing, finished: false };
    tw.finish = () => {
      if (tw.finished) return;
      tw.finished = true;
      this.list.delete(tw);
      update?.(1, 1);
      done?.();
    };
    tw.cancel = () => {
      tw.finished = true;
      this.list.delete(tw);
    };
    this.list.add(tw);
    return tw;
  }

  wait(ms) {
    return new Promise((res) => this.add({ duration: ms, done: res }));
  }

  step(now) {
    for (const tw of [...this.list]) {
      if (now < tw.start) continue;
      const t = Math.min(1, (now - tw.start) / tw.duration);
      tw.update?.(tw.easing(t), t);
      if (t >= 1) tw.finish();
    }
  }
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.tweens = new Tweens();
    this.dirty = true;
    this.onFrame = new Set();
    this.inset = { top: 80, bottom: 110 };

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    this.maxDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = this.maxDpr;
    renderer.setPixelRatio(this.dpr);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0a0807');
    this.scene = scene;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const studio = studioEnvironment();
    scene.environment = pmrem.fromScene(studio, 0.02).texture;
    scene.environmentIntensity = 1.0;
    studio.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    pmrem.dispose();

    // ключевой свет: тёплый софтбокс сверху-слева, даёт мягкие тени и световое пятно на столе
    const key = new THREE.SpotLight('#fff1dc', 3.4, 0, 0.5, 0.95, 0);
    key.position.set(-4.2, 11, 6.5);
    key.target.position.set(0.25, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 6;
    key.shadow.camera.far = 22;
    key.shadow.bias = -0.00025;
    key.shadow.normalBias = 0.012;
    key.shadow.radius = 3.5;
    scene.add(key, key.target);
    this.key = key;

    // холодный контровой — блики на фасках
    const rim = new THREE.DirectionalLight('#cfe0ff', 0.55);
    rim.position.set(6, 5, -7);
    scene.add(rim);

    const bounce = new THREE.HemisphereLight('#ffe9cf', '#1a120c', 0.18);
    scene.add(bounce);

    // стол
    const tableGeo = new THREE.PlaneGeometry(60, 60, 1, 1);
    tableGeo.rotateX(-Math.PI / 2);
    setSeed(tableGeo, 0, 0, 0, 0);
    this.table = new THREE.Mesh(tableGeo, new THREE.MeshStandardMaterial({ color: '#222' }));
    this.table.position.y = -0.16;
    this.table.receiveShadow = true;
    scene.add(this.table);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 80);
    this.boardSize = 5;
    this.view = { tilt: 0.42, yaw: 0, ox: 0, oy: 0, tx: 0, ty: 0, dist: 14 };
    this.parallaxOn = true;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    window.visualViewport?.addEventListener('resize', this._resize);
    this._resize();

    this._perf = { frames: 0, acc: 0, last: performance.now() };
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  invalidate() { this.dirty = true; }

  setTableMaterial(m) {
    this.table.material = m;
    this.invalidate();
  }

  setBoardSize(outer) {
    this.boardSize = outer;
    this._fit();
  }

  setInsets(top, bottom) {
    this.inset = { top, bottom };
    this._fit();
  }

  /** Параллакс: нормализованные координаты -1..1. */
  setParallax(x, y) {
    if (!this.parallaxOn) return;
    this.view.tx = Math.max(-1, Math.min(1, x));
    this.view.ty = Math.max(-1, Math.min(1, y));
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this._fit();
  }

  _fit() {
    const cam = this.camera;
    const { width: w, height: h } = this;
    if (!w || !h) return;
    const top = this.inset.top;
    const bottom = this.inset.bottom;
    const availH = Math.max(120, h - top - bottom);
    const size = this.boardSize;
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    const half = size * 0.5;
    // по вертикали доска видна под наклоном
    const vExtent = half * Math.cos(this.view.tilt) + 0.35 * Math.sin(this.view.tilt) + 0.15;
    const distV = vExtent / Math.tan(vfov / 2) / (availH / h);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (w / h));
    // ближний край доски из-за перспективы шире — небольшой запас
    const distH = (half + 0.12) / Math.tan(hfov / 2) / 0.97;
    this.view.dist = Math.max(distV, distH) * 1.02;
    cam.setViewOffset(w, h, 0, (bottom - top) / 2, w, h);
    cam.updateProjectionMatrix();
    this._placeCamera();
    this.invalidate();
  }

  _placeCamera() {
    const v = this.view;
    const tilt = v.tilt + v.oy * 0.07;
    const yaw = v.yaw + v.ox * 0.09;
    const d = v.dist;
    const cam = this.camera;
    cam.position.set(Math.sin(yaw) * Math.sin(tilt) * d, Math.cos(tilt) * d, Math.cos(yaw) * Math.sin(tilt) * d);
    cam.lookAt(0, 0.05, 0);
  }

  /** Экранные координаты -> луч. */
  ray(clientX, clientY, raycaster) {
    const ndc = new THREE.Vector2((clientX / this.width) * 2 - 1, -(clientY / this.height) * 2 + 1);
    raycaster.setFromCamera(ndc, this.camera);
    return raycaster;
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    const v = this.view;
    const dx = v.tx - v.ox;
    const dy = v.ty - v.oy;
    if (Math.abs(dx) > 0.0005 || Math.abs(dy) > 0.0005) {
      v.ox += dx * 0.07;
      v.oy += dy * 0.07;
      this._placeCamera();
      this.dirty = true;
    }
    if (this.tweens.active) {
      this.tweens.step(now);
      this.dirty = true;
    }
    for (const fn of this.onFrame) if (fn(now)) this.dirty = true;
    if (!this.dirty) {
      this._perf.last = now;
      return;
    }
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this._adapt(now);
  }

  /** Адаптивное разрешение: если кадры тяжёлые — понемногу снижаем DPR. */
  _adapt(now) {
    const p = this._perf;
    const dt = now - p.last;
    p.last = now;
    if (dt > 200) return;
    p.frames++;
    p.acc += dt;
    if (p.frames >= 40) {
      const avg = p.acc / p.frames;
      p.frames = 0;
      p.acc = 0;
      if (avg > 24 && this.dpr > 1) {
        this.dpr = Math.max(1, this.dpr - 0.25);
        this.renderer.setPixelRatio(this.dpr);
        this._resize();
      } else if (avg < 14 && this.dpr < this.maxDpr) {
        this.dpr = Math.min(this.maxDpr, this.dpr + 0.25);
        this.renderer.setPixelRatio(this.dpr);
        this._resize();
      }
    }
  }
}
