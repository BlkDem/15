const KEY = 'pyatnashki.v1';

const DEFAULTS = {
  settings: { theme: 'ivory', size: 4, sound: true, haptics: true, parallax: true },
  best: {}, // { [size]: { time, moves, wins } }
  game: null, // { size, cells, moves, elapsed, solved }
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const data = JSON.parse(raw);
    return {
      settings: { ...DEFAULTS.settings, ...(data.settings || {}) },
      best: data.best || {},
      game: data.game || null,
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const store = {
  data: read(),
  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* приватный режим / переполнение — игра работает и без сохранения */
    }
  },
};
