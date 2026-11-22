/*
 * Процедурный звук. Ничего не скачивается — все сэмплы синтезируются при запуске:
 *  - удар костяшки: модальный синтез (затухающие резонансы материала) + шумовой транзиент
 *    + низкий «тук» корпуса;
 *  - скольжение: полосовой шум с огибающей;
 *  - маримба/колокольчики для победы;
 *  - короткая реверберация «комнаты» (сгенерированный импульсный отклик).
 */

const PRESETS = {
  // [частота, амплитуда, время затухания (с)]
  ivory: {
    modes: [[2380, 1, 0.020], [3920, 0.55, 0.013], [5480, 0.32, 0.009], [7650, 0.18, 0.006]],
    body: [[190, 0.55, 0.012], [430, 0.22, 0.05], [640, 0.12, 0.04]],
    noise: 0.45, noiseDecay: 0.0018, slideBand: 2600, slideQ: 0.7,
  },
  wood: {
    modes: [[760, 1, 0.032], [1480, 0.62, 0.024], [2330, 0.42, 0.017], [3420, 0.22, 0.011]],
    body: [[140, 0.75, 0.02], [380, 0.3, 0.06], [560, 0.18, 0.05]],
    noise: 0.32, noiseDecay: 0.0024, slideBand: 1300, slideQ: 0.6,
  },
  glass: {
    modes: [[2950, 1, 0.055], [4730, 0.55, 0.04], [7180, 0.32, 0.028], [9900, 0.14, 0.018]],
    body: [[210, 0.3, 0.008], [480, 0.15, 0.05]],
    noise: 0.28, noiseDecay: 0.0011, slideBand: 3400, slideQ: 0.9,
  },
  stone: {
    modes: [[1680, 1, 0.022], [2990, 0.7, 0.015], [4760, 0.42, 0.010], [6950, 0.24, 0.007]],
    body: [[155, 0.85, 0.014], [410, 0.3, 0.05], [700, 0.15, 0.04]],
    noise: 0.6, noiseDecay: 0.0016, slideBand: 1900, slideQ: 0.8,
  },
};

const VARIANTS = 6;
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36];

function rand(a, b) { return a + Math.random() * (b - a); }

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.preset = 'ivory';
    this.buffers = {};
    this.lastClick = 0;
  }

  /** Создаёт AudioContext — вызывать из обработчика жеста пользователя. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    this.master.connect(comp).connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(0.9, 3.2);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.16;
    this.reverb.connect(this.wet).connect(this.master);

    this.noiseBuf = this._noise(2);
    this._build(this.preset);
    // «пустой» звук внутри жеста окончательно разблокирует вывод в iOS Safari
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.02);
  }

  setPreset(name) {
    this.preset = PRESETS[name] ? name : 'ivory';
    if (this.ctx) this._build(this.preset);
  }

  get ready() { return !!this.ctx && this.enabled; }

  // ----------------------------------------------------------- синтез буферов
  _noise(seconds) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const b = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const n = Math.random() * 2 - 1;
        lp += (n - lp) * (0.35 - 0.25 * t); // темнеет к концу хвоста
        const early = i < sr * 0.03 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 2 : 0;
        d[i] = (lp + early) * Math.pow(1 - t, decay);
      }
    }
    return b;
  }

  _impact(p, brightness = 1) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 0.22);
    const b = ctx.createBuffer(1, len, sr);
    const d = b.getChannelData(0);
    const modes = p.modes.map(([f, a, t]) => [f * rand(0.96, 1.04), a * rand(0.8, 1.15) * (f > 4000 ? brightness : 1), t * rand(0.85, 1.15), Math.random() * Math.PI * 2]);
    const body = p.body.map(([f, a, t]) => [f * rand(0.95, 1.05), a * rand(0.8, 1.1), t, Math.random() * Math.PI * 2]);
    let hp = 0;
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let s = 0;
      for (const [f, a, tau, ph] of modes) s += a * Math.sin(2 * Math.PI * f * t + ph) * Math.exp(-t / tau);
      for (const [f, a, tau, ph] of body) s += a * Math.sin(2 * Math.PI * f * t + ph) * Math.exp(-t / tau);
      const n = Math.random() * 2 - 1;
      hp = 0.82 * (hp + n - prev); // простой ФВЧ — «щелчок» контакта
      prev = n;
      s += hp * p.noise * Math.exp(-t / p.noiseDecay);
      const attack = Math.min(1, i / (sr * 0.0004));
      d[i] = s * attack;
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < len; i++) d[i] *= 0.9 / peak;
    return b;
  }

  _build(name) {
    if (this.buffers[name]) return;
    const p = PRESETS[name];
    const clicks = [];
    for (let i = 0; i < VARIANTS; i++) clicks.push(this._impact(p, rand(0.8, 1.2)));
    const soft = this._impact({ ...p, modes: p.modes.map(([f, a, t]) => [f * 0.7, a * 0.6, t * 0.7]), noise: p.noise * 0.3 }, 0.4);
    this.buffers[name] = { clicks, soft };
  }

  _out(pan = 0, wet = 1) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(panner);
      panner.connect(this.dry);
      const send = ctx.createGain();
      send.gain.value = wet;
      panner.connect(send).connect(this.reverb);
    } else {
      g.connect(this.dry);
    }
    return g;
  }

  // ----------------------------------------------------------- публичные звуки
  /** Удар костяшки. strength 0..1, pan -1..1 */
  click(strength = 1, pan = 0, when = 0) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t = Math.max(now, now + when);
    const set = this.buffers[this.preset];
    const src = ctx.createBufferSource();
    src.buffer = set.clicks[(Math.random() * set.clicks.length) | 0];
    src.playbackRate.value = rand(0.95, 1.05) * (0.92 + strength * 0.1);
    const out = this._out(pan, 1);
    out.gain.value = Math.min(1.2, 0.25 + strength * 0.85) * rand(0.85, 1);
    src.connect(out);
    src.start(t);
    this.lastClick = t;
  }

  /** Глухой удар — костяшка не может сдвинуться. */
  thud(pan = 0) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[this.preset].soft;
    src.playbackRate.value = rand(0.55, 0.62);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const out = this._out(pan, 0.6);
    out.gain.value = 0.55;
    src.connect(lp).connect(out);
    src.start();
  }

  /** Шорох скольжения длительностью dur секунд. */
  slide(dur = 0.12, pan = 0, strength = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const p = PRESETS[this.preset];
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(p.slideBand * 0.8, now);
    bp.frequency.linearRampToValueAtTime(p.slideBand * 1.15, now + dur);
    bp.Q.value = p.slideQ;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400;
    const out = this._out(pan, 0.4);
    const peak = 0.05 + 0.07 * Math.min(1, strength);
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(peak, now + Math.min(0.03, dur * 0.3));
    out.gain.setValueAtTime(peak, now + dur * 0.7);
    out.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.02);
    src.connect(bp).connect(hp).connect(out);
    src.start(now, Math.random() * 1.5);
    src.stop(now + dur + 0.05);
  }

  /** Взлёт костяшек при перемешивании — «вжух». */
  whoosh(dur = 0.45, up = true) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(up ? 350 : 1800, now);
    bp.frequency.exponentialRampToValueAtTime(up ? 1900 : 300, now + dur);
    const out = this._out(0, 1.2);
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(0.11, now + dur * 0.45);
    out.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(bp).connect(out);
    src.start(now, Math.random());
    src.stop(now + dur + 0.05);
  }

  /** Тяжёлый «бум» рамки, поставленной на стол. */
  boom() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, now);
    o.frequency.exponentialRampToValueAtTime(55, now + 0.25);
    const g = this._out(0, 1.4);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    o.connect(g);
    o.start(now);
    o.stop(now + 0.4);
    this.click(0.5, 0);
  }

  /** Нота маримбы. step — ступень пентатоники. */
  marimba(step = 0, when = 0, pan = 0, vel = 0.6) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const semis = PENTA[Math.max(0, Math.min(PENTA.length - 1, step))];
    const f = 523.25 * Math.pow(2, semis / 12); // от C5
    const out = this._out(pan, 1.6);
    out.gain.value = vel;
    const partials = [[1, 1, 0.5], [3.93, 0.3, 0.09], [9.2, 0.08, 0.03]];
    for (const [mul, a, dec] of partials) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(a * 0.32, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dec * 2.2);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dec * 2.2 + 0.05);
    }
  }

  /** Финальный аккорд-колокол. */
  chime(when = 0) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      const out = this._out((i - 2) * 0.25, 2.2);
      out.gain.value = 0.22;
      for (const [mul, a, dec] of [[1, 1, 2.4], [2.76, 0.35, 1.1], [5.4, 0.12, 0.5]]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * mul * (1 + (Math.random() - 0.5) * 0.002);
        const g = ctx.createGain();
        const s = t + i * 0.07;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(a * 0.3, s + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, s + dec);
        o.connect(g).connect(out);
        o.start(s);
        o.stop(s + dec + 0.05);
      }
    });
  }

  /** Тихий щелчок интерфейса. */
  tick(high = false) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(high ? 2200 : 1500, now);
    o.frequency.exponentialRampToValueAtTime(high ? 1400 : 900, now + 0.04);
    const g = this._out(0, 0.3);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.08, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
    o.connect(g);
    o.start(now);
    o.stop(now + 0.08);
  }
}
