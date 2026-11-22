import { THEMES } from './materials.js';
import { store } from './storage.js';

const $ = (s) => document.querySelector(s);

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export class UI {
  constructor() {
    this.handlers = {};
    this.modalOpen = false;
    this.movesEl = $('#moves');
    this.timeEl = $('#time');
    this._lastMoves = -1;
    this._lastTime = '';
    this.installPrompt = null;
  }

  on(name, fn) { this.handlers[name] = fn; }
  emit(name, ...a) { this.handlers[name]?.(...a); }

  init(settings) {
    // темы
    const box = $('#themes');
    box.innerHTML = '';
    for (const t of THEMES) {
      const b = document.createElement('button');
      b.className = 'theme';
      b.dataset.theme = t.id;
      b.style.setProperty('--t-tile', t.swatch.tile);
      b.style.setProperty('--t-ink', t.swatch.ink);
      b.style.setProperty('--t-frame', t.swatch.frame);
      b.innerHTML = `<span class="theme-swatch"><span class="theme-tile">7</span></span><span class="theme-name">${t.name}</span><span class="theme-hint">${t.hint}</span>`;
      b.addEventListener('click', () => this.emit('theme', t.id));
      box.appendChild(b);
    }

    for (const seg of document.querySelectorAll('.seg')) {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-size]');
        if (btn) this.emit('size', +btn.dataset.size);
      });
    }

    $('#btn-new').addEventListener('click', () => this.emit('new'));
    $('#btn-again').addEventListener('click', () => this.emit('new'));
    $('#btn-sound').addEventListener('click', () => this.emit('sound'));
    $('#btn-menu').addEventListener('click', () => this.openSheet());
    for (const el of document.querySelectorAll('#sheet [data-close]')) el.addEventListener('click', () => this.closeSheet());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeSheet();
    });

    $('#opt-sound').addEventListener('change', (e) => this.emit('setting', 'sound', e.target.checked));
    $('#opt-haptics').addEventListener('change', (e) => this.emit('setting', 'haptics', e.target.checked));
    $('#opt-parallax').addEventListener('change', (e) => this.emit('setting', 'parallax', e.target.checked));
    if (!('vibrate' in navigator)) $('#row-haptics').hidden = true;

    // звук «щелчка» на всех кнопках интерфейса
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, .toggle')) this.emit('uitick');
    });

    // установка PWA
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e;
      $('#btn-install').hidden = false;
    });
    $('#btn-install').addEventListener('click', async () => {
      if (!this.installPrompt) return;
      this.installPrompt.prompt();
      await this.installPrompt.userChoice.catch(() => null);
      this.installPrompt = null;
      $('#btn-install').hidden = true;
    });
    window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; });

    this.syncSettings(settings);
  }

  syncSettings(s) {
    document.body.classList.toggle('muted', !s.sound);
    for (const seg of document.querySelectorAll('.seg')) {
      const btns = [...seg.querySelectorAll('[data-size]')];
      const i = btns.findIndex((b) => +b.dataset.size === s.size);
      btns.forEach((b, j) => b.setAttribute('aria-checked', String(j === i)));
      seg.style.setProperty('--i', String(Math.max(0, i)));
    }
    for (const t of document.querySelectorAll('.theme')) t.classList.toggle('active', t.dataset.theme === s.theme);
    $('#opt-sound').checked = s.sound;
    $('#opt-haptics').checked = s.haptics;
    $('#opt-parallax').checked = s.parallax;
  }

  setStats(moves, ms) {
    if (moves !== this._lastMoves) {
      this.movesEl.textContent = String(moves);
      if (moves > this._lastMoves && this._lastMoves >= 0) {
        this.movesEl.classList.remove('bump');
        void this.movesEl.offsetWidth;
        this.movesEl.classList.add('bump');
      }
      this._lastMoves = moves;
    }
    const t = fmtTime(ms);
    if (t !== this._lastTime) {
      this.timeEl.textContent = t;
      this._lastTime = t;
    }
  }

  renderRecords() {
    const box = $('#records');
    const rows = [3, 4, 5].map((n) => {
      const b = store.data.best[n];
      const t = b?.time ? fmtTime(b.time) : '—';
      const m = b?.moves ? b.moves : '—';
      const w = b?.wins || 0;
      return `<div class="rec"><span class="rec-size">${n}×${n}</span><span><b>${t}</b><small>лучшее время</small></span><span><b>${m}</b><small>меньше всего ходов</small></span><span><b>${w}</b><small>${plural(w, 'победа', 'победы', 'побед')}</small></span></div>`;
    });
    box.innerHTML = rows.join('');
  }

  openSheet() {
    this.renderRecords();
    const m = $('#sheet');
    m.hidden = false;
    requestAnimationFrame(() => m.classList.add('open'));
    this.modalOpen = true;
  }

  closeSheet() {
    const m = $('#sheet');
    if (m.hidden) return;
    m.classList.remove('open');
    this.modalOpen = false;
    setTimeout(() => { if (!m.classList.contains('open')) m.hidden = true; }, 320);
  }

  showWin({ time, moves, recordTime, recordMoves, best, n }) {
    $('#win-kicker').textContent = `Головоломка ${n}×${n}`;
    $('#win-time').textContent = fmtTime(time);
    $('#win-moves').textContent = String(moves);
    const rec = $('#win-record');
    const first = best.wins === 1;
    if (first) {
      rec.textContent = 'Первая победа на этом поле';
      rec.hidden = false;
    } else if (recordTime || recordMoves) {
      rec.textContent = recordTime && recordMoves ? 'Новый рекорд — и по времени, и по ходам!' : recordTime ? 'Новый рекорд времени!' : 'Новый рекорд по ходам!';
      rec.hidden = false;
    } else {
      rec.hidden = true;
    }
    $('#win-best').textContent = `Лучшее: ${fmtTime(best.time)} · ${best.moves} ${plural(best.moves, 'ход', 'хода', 'ходов')}`;
    const m = $('#win');
    m.hidden = false;
    requestAnimationFrame(() => m.classList.add('open'));
    this.modalOpen = true;
  }

  hideWin() {
    const m = $('#win');
    if (m.hidden) return;
    m.classList.remove('open');
    this.modalOpen = false;
    setTimeout(() => { if (!m.classList.contains('open')) m.hidden = true; }, 350);
  }

  progress(p, text) {
    $('#loader-fill').style.transform = `scaleX(${Math.max(0.02, Math.min(1, p))})`;
    if (text) $('#loader-text').textContent = text;
  }

  hideLoader() {
    const l = $('#loader');
    l.classList.add('done');
    setTimeout(() => l.remove(), 900);
  }

  showError(msg) {
    $('#loader-text').textContent = msg;
    $('#loader').classList.add('error');
  }

  /** Сколько пикселей сверху/снизу занимают панели — чтобы камера вписала доску между ними. */
  insets() {
    const hud = $('#hud').getBoundingClientRect();
    const dock = $('#dock').getBoundingClientRect();
    return { top: hud.bottom + 6, bottom: window.innerHeight - dock.top + 6 };
  }
}
