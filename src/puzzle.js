/** Чистая логика пятнашек: состояние поля, ходы, решаемость, перемешивание. 0 — пустая клетка. */
export class Puzzle {
  constructor(n = 4, cells = null) {
    this.n = n;
    this.cells = cells && cells.length === n * n ? cells.slice() : Puzzle.solved(n);
  }

  static solved(n) {
    const a = [];
    for (let i = 1; i < n * n; i++) a.push(i);
    a.push(0);
    return a;
  }

  get blank() { return this.cells.indexOf(0); }
  rc(i) { return [Math.floor(i / this.n), i % this.n]; }
  idx(r, c) { return r * this.n + c; }
  indexOfTile(t) { return this.cells.indexOf(t); }

  isSolved() {
    const c = this.cells;
    for (let i = 0; i < c.length - 1; i++) if (c[i] !== i + 1) return false;
    return true;
  }

  /**
   * Цепочка костяшек, которые сдвинутся, если тронуть клетку index.
   * Возвращает { dr, dc, indices } (indices — от ближайшей к пустой), либо null.
   */
  chainFor(index) {
    const b = this.blank;
    if (index === b || index < 0) return null;
    const [br, bc] = this.rc(b);
    const [r, c] = this.rc(index);
    if (r !== br && c !== bc) return null;
    const dr = Math.sign(br - r);
    const dc = Math.sign(bc - c);
    const indices = [];
    let rr = br - dr;
    let cc = bc - dc;
    for (;;) {
      indices.push(this.idx(rr, cc));
      if (rr === r && cc === c) break;
      rr -= dr;
      cc -= dc;
    }
    return { dr, dc, indices, tiles: indices.map((i) => this.cells[i]) };
  }

  /** Цепочка для движения «в направлении» (dr, dc) — как стрелки клавиатуры/свайп. */
  chainForDirection(dr, dc) {
    const [br, bc] = this.rc(this.blank);
    const r = br - dr;
    const c = bc - dc;
    if (r < 0 || c < 0 || r >= this.n || c >= this.n) return null;
    return this.chainFor(this.idx(r, c));
  }

  apply(chain) {
    for (const i of chain.indices) {
      const [r, c] = this.rc(i);
      const j = this.idx(r + chain.dr, c + chain.dc);
      this.cells[j] = this.cells[i];
      this.cells[i] = 0;
    }
  }

  static isSolvable(cells, n) {
    const arr = cells.filter((x) => x !== 0);
    let inv = 0;
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) if (arr[i] > arr[j]) inv++;
    if (n % 2 === 1) return inv % 2 === 0;
    const blankRowFromBottom = n - Math.floor(cells.indexOf(0) / n);
    return (inv + blankRowFromBottom) % 2 === 1;
  }

  /** Случайная решаемая расстановка, достаточно далёкая от собранной. */
  shuffle() {
    const n = this.n;
    const total = n * n;
    for (let attempt = 0; attempt < 200; attempt++) {
      const a = Puzzle.solved(n);
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      if (!Puzzle.isSolvable(a, n)) {
        // перестановка двух непустых костяшек меняет чётность
        const i1 = a[0] !== 0 ? 0 : 2;
        const i2 = a[1] !== 0 ? 1 : 2;
        [a[i1], a[i2]] = [a[i2], a[i1]];
      }
      let misplaced = 0;
      for (let i = 0; i < total - 1; i++) if (a[i] !== i + 1) misplaced++;
      if (misplaced >= Math.floor((total - 1) * 0.75) && Puzzle.isSolvable(a, n)) {
        this.cells = a;
        return;
      }
    }
  }
}
