/**
 * @fileoverview Floating art wall physics.
 *
 * The server runs this to compute the room's layout (server/floatingWall.js) and
 * sends the settled positions. Each client runs its own copy, seeded with that
 * layout, only while its user drags or throws a piece, so dragging is local and
 * costs the server nothing. Slow-mode clients only use `clampToLeash`.
 *
 * Pieces are WALL_CARD_W × WALL_CARD_H cards positioned by their CENTRE in
 * board pixels, around a board occupying (0, 0, boardWidth, boardHeight).
 *
 * Settling is guaranteed by heat, not by waiting for motion to die out: every
 * piece carries a heat in [0, 1] that only decays (COOL_TICKS from 1 to 0), and
 * a frozen piece (heat 0) neither feels forces nor gets pushed. Events only
 * raise heat up to a cap, and only near where they happen, so one dragged
 * piece warms its neighbourhood instead of the whole wall.
 */

export const WALL_CARD_W = 180;
export const WALL_CARD_H = 200;
export const WALL_TICK_MS = 100;

const GAP = 40;
const BOARD_GAP = 30;
const CELL = 240;

const PULL = 2.5;
const DAMP = 0.72;
const MAX_SPEED = 12;
const TETHER_R = 130;
const TETHER_K = 0.06;
const TETHER_MAX = 4;
const SOLVE_ITERS = 4;
const SOLVE_K = 0.6;
// Final cleanup alternates axis pushes with pushes along the centre line; axis-only pushes
// jam when a card is wedged sideways between two neighbours.
const FINAL_ITERS = 120;
// Re-run the cleanup with overlapping frozen neighbours made movable, up to this many times
const SETTLE_ROUNDS = 6;
// Cards closer than full size plus this (px) count as overlapping for that check; GAP is padding, not overlap
const OVERLAP_SLACK = GAP / 2;
const EMERGE_TICKS = 14;

// Spawning finishes within SPAWN_WINDOW_TICKS and every piece cools within COOL_TICKS of its
// last heat, so a full load settles within (SPAWN_WINDOW_TICKS + COOL_TICKS) ticks = 28 s.
const COOL_TICKS = 200;
const LOCAL_RADIUS = 650;
// DETACH cools over exactly DISTURB_TICKS, so a shelf change gets 15 s to settle
const DISTURB_TICKS = 150;
export const WALL_HEAT = { SPAWN: 1, DRAG: 0.6, HEART: 0.35, DETACH: DISTURB_TICKS / COOL_TICKS };
// A hot piece shoving a frozen one passes on half its heat, but only while it has at least this much
const HEAT_SPREAD_MIN = 0.2;
const HEAT_SPREAD = 0.5;
const CALM_TICKS = 20;
const CALM_MOVE = 0.25;
const SPAWN_WINDOW_TICKS = 80;

// The leash is elastic: free out to LEASH_SCALE × the group radius, then the piece keeps following
// with diminishing give, approaching LEASH_STRETCH × that length further out but never beyond it.
const LEASH_SCALE = 2;
const LEASH_STRETCH = 0.9;
const LEASH_K = 0.02;
const LEASH_MAX = 2.5;
const BOOST_TICKS = 20;
const BOOST_W = 3;

const SWAP_GAIN = 60;
const SWAP_TOLERANCE = 20;
const SWAP_MIN_HEAT = 0.1;
const SWAP_COOLDOWN = 10;
const SWAP_REACH = 40;
// Same artist: more-hearted piece nearer the board. Different artists: grouping dominates, rank nudges.
const RANK_SAME_K = 2;
const RANK_CROSS_K = 0.5;

export const WALL_THROW_MAX = 60;
const GLIDE_TICKS = 12;
const GLIDE_DAMP = 0.85;
const GLIDE_FORCE = 0.25;
// A held piece with no drag update for this long is dropped (holder vanished)
const HOLD_TIMEOUT_TICKS = 50;

export const WIP_SHELF = { CARD_W: 130, CARD_H: 150, GAP: 12, MARGIN: 44, MAX_ROW_FRACTION: 0.6 };

/**
 * The works-in-progress shelf: centred under the board and only as big as its pieces. Rows fill
 * up to 60% of the board width, each row centred. Returns slot `i`'s top-left (board px) and the
 * rect the floating wall keeps clear (`null` when the shelf is empty).
 */
export function wipShelfLayout(count, boardWidth, boardHeight) {
  const { CARD_W, CARD_H, GAP, MARGIN, MAX_ROW_FRACTION } = WIP_SHELF;
  const perRow = Math.max(1, Math.floor((boardWidth * MAX_ROW_FRACTION + GAP) / (CARD_W + GAP)));
  const rows = Math.ceil(count / perRow);
  const top = boardHeight + MARGIN;
  const centre = boardWidth / 2;
  const rowWidth = n => n * CARD_W + Math.max(0, n - 1) * GAP;
  const widest = rowWidth(Math.min(count, perRow));
  return {
    rect: count
      ? { l: centre - widest / 2, t: top, r: centre + widest / 2, b: top + rows * CARD_H + (rows - 1) * GAP }
      : null,
    slot: i => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, count - row * perRow);
      return {
        x: centre - rowWidth(inRow) / 2 + (i - row * perRow) * (CARD_W + GAP),
        y: top + row * (CARD_H + GAP)
      };
    }
  };
}

export function leashLength(groupSize) {
  return TETHER_R * Math.sqrt(groupSize) * LEASH_SCALE;
}

/**
 * Clamp a wanted centre (tx, ty) for `piece` to its leash around the rest of its group.
 * @param {Iterable<{id: string, group: string, x: number, y: number, active?: boolean}>} pieces
 * @returns {{x: number, y: number, taut: boolean}}
 */
export function clampToLeash(pieces, piece, tx, ty) {
  let cx = 0, cy = 0, n = 0;
  for (const q of pieces) {
    if (q === piece || q.id === piece.id || q.group !== piece.group || q.active === false) continue;
    cx += q.x; cy += q.y; n++;
  }
  if (!n) return { x: tx, y: ty, taut: false };
  cx /= n; cy /= n;
  const L = leashLength(n + 1), dx = tx - cx, dy = ty - cy, d = Math.hypot(dx, dy);
  if (d <= L) return { x: tx, y: ty, taut: false };
  // Rubber band past the free length: each extra pixel of pull buys less movement
  const stretch = L * LEASH_STRETCH;
  const reach = L + stretch * (1 - Math.exp(-(d - L) / stretch));
  return { x: cx + dx / d * reach, y: cy + dy / d * reach, taut: true };
}

function hashAngle(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

const cellKey = (gx, gy) => (gx + 5000) * 10007 + (gy + 5000);

export class FloatingWallSim {
  /**
   * @param {{ boardWidth?: number, boardHeight?: number, random?: () => number }} [options]
   */
  constructor({ boardWidth = 1920, boardHeight = 1080, random = Math.random } = {}) {
    this.random = random;
    /** Wire order: index in this array is the index clients use. Includes not-yet-spawned pieces. */
    this.pieces = [];
    this.byId = new Map();
    this.spawnQueue = [];
    this.spawnBatch = 1;
    this.awake = false;
    this.tick = 0;
    this.calm = 0;
    this.revision = 0;
    this.obstacles = [];
    // No calm settle before this tick: a disturbance gets its full settling window
    this.holdAwakeUntil = 0;
    this.setBoard(boardWidth, boardHeight);
  }

  setBoard(width, height) {
    this.B = { l: 0, t: 0, r: width, b: height };
    this.E = {
      l: -WALL_CARD_W / 2 - BOARD_GAP,
      t: -WALL_CARD_H / 2 - BOARD_GAP,
      r: width + WALL_CARD_W / 2 + BOARD_GAP,
      b: height + WALL_CARD_H / 2 + BOARD_GAP
    };
    // A resized board may now cover some pieces
    for (const p of this.pieces) {
      if (p.active && this._blocked(p)) this._heat(p, WALL_HEAT.SPAWN);
    }
  }

  /**
   * Fixed rects (board px) the wall keeps clear of, like the WIP shelf. Pieces don't head toward
   * them; they just can't sit inside them.
   * @param {Array<{l: number, t: number, r: number, b: number}>} rects
   */
  setObstacles(rects) {
    this.obstacles = (rects || []).map(o => ({
      l: o.l - WALL_CARD_W / 2 - BOARD_GAP,
      r: o.r + WALL_CARD_W / 2 + BOARD_GAP,
      t: o.t - WALL_CARD_H / 2 - BOARD_GAP,
      b: o.b + WALL_CARD_H / 2 + BOARD_GAP
    }));
    for (const p of this.pieces) {
      if (p.active && this._insideObstacle(p)) this._heat(p, WALL_HEAT.DRAG);
    }
  }

  /**
   * Something changed in `rect` (board px), like art detached onto the shelf: warm every piece
   * within reach of it, warm anything overlapping anywhere, and keep the wall awake for 15 s so
   * the neighbourhood re-packs instead of freezing half-shoved.
   * @param {{l: number, t: number, r: number, b: number}|null} rect
   */
  disturbRect(rect, heat = WALL_HEAT.DETACH) {
    if (rect) {
      for (const p of this.pieces) {
        if (!p.active || p.pinned) continue;
        const dx = Math.max(rect.l - p.x, 0, p.x - rect.r), dy = Math.max(rect.t - p.y, 0, p.y - rect.b);
        if (dx * dx + dy * dy <= LOCAL_RADIUS * LOCAL_RADIUS) this._heat(p, heat);
      }
    }
    this._heatConflicts();
    this.holdAwakeUntil = this.tick + DISTURB_TICKS;
    this._wake();
  }

  _insideObstacle(p) {
    return this.obstacles.some(o => p.x > o.l && p.x < o.r && p.y > o.t && p.y < o.b);
  }

  _blocked(p) {
    return this._boardDist(p.x, p.y).d < 0 || this._insideObstacle(p);
  }

  // Out of any obstacle by the shortest way
  _pushOutOfObstacles(p) {
    for (const o of this.obstacles) {
      if (p.x <= o.l || p.x >= o.r || p.y <= o.t || p.y >= o.b) continue;
      const exits = [[p.x - o.l, -1, 0], [o.r - p.x, 1, 0], [o.b - p.y, 0, 1]];
      // Up is only an exit if it clears the board's own clearance; otherwise the board push and this
      // one would trade the piece back and forth, or leave it overlapping the shelf
      if (o.t >= this.E.b) exits.push([p.y - o.t, 0, -1]);
      exits.sort((a, b) => a[0] - b[0]);
      p.x += exits[0][1] * exits[0][0];
      p.y += exits[0][2] * exits[0][0];
    }
  }

  _make(entry) {
    return {
      id: entry.id, group: entry.group, likes: entry.likes || 0,
      active: false, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, w: 0.5,
      heat: 0, touched: false, emerge: 0, glide: 0, boost: 0, swapCooldown: 0,
      pinned: false, holder: null, holdTicks: 0, dragged: false, tx: 0, ty: 0,
      phase: false, rank: 0, likeShare: 0
    };
  }

  /**
   * Replace the wall's membership. Pieces already on the wall keep their spots;
   * pieces found in `layout` are placed there frozen; the rest queue to spawn.
   * @param {Array<{id: string, group: string, likes: number}>} entries
   * @param {Map<string, {x: number, y: number}>|null} [layout]
   */
  setPieces(entries, layout = null) {
    const nextIds = new Set(entries.map(e => e.id));
    const previous = this.byId;
    this.pieces = [];
    this.byId = new Map();
    this.spawnQueue = this.spawnQueue.filter(p => nextIds.has(p.id));

    for (const entry of entries) {
      let p = previous.get(entry.id);
      if (p) {
        p.group = entry.group;
        p.likes = entry.likes || 0;
      } else {
        p = this._make(entry);
        const saved = layout?.get(entry.id);
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          p.active = true;
          p.x = p.px = saved.x;
          p.y = p.py = saved.y;
        } else {
          this.spawnQueue.push(p);
        }
      }
      this.pieces.push(p);
      this.byId.set(p.id, p);
    }

    // Least-hearted first: each new piece emerges at the board edge and pushes earlier ones
    // outward, so the most-hearted pieces, spawning last, end up nearest the board.
    this.spawnQueue.sort((a, b) => a.likes - b.likes);
    this.spawnBatch = Math.max(1, Math.ceil(this.spawnQueue.length / SPAWN_WINDOW_TICKS));
    this._heatConflicts();
    if (this.spawnQueue.length) this._wake();
    this.revision++;
  }

  /** Put a piece at rest at (x, y), e.g. where the room's layout has it. Places a queued piece too. */
  place(id, x, y) {
    const p = this.byId.get(id);
    if (!p || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    p.x = p.px = x;
    p.y = p.py = y;
    p.vx = p.vy = 0;
    p.heat = 0;
    p.touched = false;
    p.glide = 0;
    if (!p.active) {
      p.active = true;
      this.spawnQueue = this.spawnQueue.filter(q => q !== p);
    }
    return true;
  }

  /** Stop all motion without moving anything: heat, velocities and holds cleared, asleep. */
  freeze() {
    for (const p of this.pieces) {
      p.heat = 0;
      p.touched = false;
      p.vx = p.vy = 0;
      p.glide = 0;
      p.boost = 0;
      p.phase = false;
      p.emerge = 0;
      this._release(p);
    }
    this.awake = false;
    this.calm = 0;
    this.holdAwakeUntil = 0;
  }

  /** Empty the wall so the next setPieces() spawns everything afresh. Keeps the revision counting up. */
  clearPieces() {
    this.pieces = [];
    this.byId = new Map();
    this.spawnQueue = [];
    this.revision++;
  }

  addPiece(entry) {
    if (this.byId.has(entry.id)) return false;
    const p = this._make(entry);
    this.pieces.push(p);
    this.byId.set(p.id, p);
    this.spawnQueue.push(p);
    this._wake();
    this.revision++;
    return true;
  }

  removePiece(id) {
    const p = this.byId.get(id);
    if (!p) return false;
    this.byId.delete(id);
    this.pieces.splice(this.pieces.indexOf(p), 1);
    this.spawnQueue = this.spawnQueue.filter(q => q !== p);
    if (p.active) this._heatNear(p.x, p.y, WALL_HEAT.HEART);
    this.revision++;
    return true;
  }

  setLikes(id, likes) {
    const p = this.byId.get(id);
    if (!p || p.likes === likes) return false;
    p.likes = likes;
    if (p.active) this._heatNear(p.x, p.y, WALL_HEAT.HEART);
    return true;
  }

  grab(id, holder) {
    const p = this.byId.get(id);
    if (!p || !p.active) return false;
    if (p.holder !== null && p.holder !== holder) return false;
    p.holder = holder;
    p.pinned = true;
    p.holdTicks = 0;
    p.dragged = false;
    p.glide = 0;
    p.tx = p.x; p.ty = p.y;
    p.vx = p.vy = 0;
    this._heatNear(p.x, p.y, WALL_HEAT.DRAG);
    return true;
  }

  dragTo(id, holder, x, y) {
    const p = this.byId.get(id);
    if (!p || p.holder !== holder || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    p.tx = x; p.ty = y;
    p.dragged = true;
    p.holdTicks = 0;
    const r = clampToLeash(this.pieces, p, x, y);
    p.x = r.x; p.y = r.y;
    this._heatNear(p.x, p.y, WALL_HEAT.DRAG);
    return true;
  }

  drop(id, holder, vx = 0, vy = 0) {
    const p = this.byId.get(id);
    if (!p || p.holder !== holder) return false;
    this._release(p);
    vx = Number(vx) || 0; vy = Number(vy) || 0;
    const sp = Math.hypot(vx, vy);
    if (sp > WALL_THROW_MAX) { vx *= WALL_THROW_MAX / sp; vy *= WALL_THROW_MAX / sp; }
    if (sp >= 2) {
      p.vx = vx; p.vy = vy;
      p.glide = GLIDE_TICKS;
    }
    this._heatNear(p.x, p.y, WALL_HEAT.DRAG);
    return true;
  }

  releaseHolder(holder) {
    for (const p of this.pieces) if (p.holder === holder) this._release(p);
  }

  _release(p) {
    p.holder = null;
    p.pinned = false;
    p.dragged = false;
    p.vx = p.vy = 0;
  }

  _wake() {
    this.awake = true;
    this.calm = 0;
  }

  _heat(p, h) {
    if (h > p.heat) p.heat = h;
    p.touched = true;
    this._wake();
  }

  _heatNear(x, y, h) {
    const r2 = LOCAL_RADIUS * LOCAL_RADIUS;
    for (const p of this.pieces) {
      if (!p.active) continue;
      const dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy <= r2) this._heat(p, h);
    }
  }

  // Saved layouts can disagree with the current board or with each other
  _heatConflicts() {
    const active = this.pieces.filter(p => p.active);
    for (const p of active) {
      if (this._blocked(p)) this._heat(p, WALL_HEAT.SPAWN);
    }
    const grid = this._grid(active);
    for (const a of active) {
      this._eachNeighbour(grid, a, 1, b => {
        if (b.id <= a.id) return;
        if (WALL_CARD_W + GAP - Math.abs(b.x - a.x) > 0 && WALL_CARD_H + GAP - Math.abs(b.y - a.y) > 0) {
          this._heat(a, WALL_HEAT.DRAG);
          this._heat(b, WALL_HEAT.DRAG);
        }
      });
    }
  }

  _boardDist(x, y) {
    const E = this.E;
    const dx = Math.max(E.l - x, 0, x - E.r), dy = Math.max(E.t - y, 0, y - E.b);
    if (dx === 0 && dy === 0) {
      const opts = [[x - E.l, -1, 0], [E.r - x, 1, 0], [y - E.t, 0, -1], [E.b - y, 0, 1]];
      opts.sort((a, b) => a[0] - b[0]);
      return { d: -opts[0][0], nx: opts[0][1], ny: opts[0][2] };
    }
    const d = Math.hypot(dx, dy);
    return { d, nx: (x < E.l ? -dx : x > E.r ? dx : 0) / d, ny: (y < E.t ? -dy : y > E.b ? dy : 0) / d };
  }

  _grid(list) {
    const grid = new Map();
    for (const p of list) {
      const key = cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
      let c = grid.get(key);
      if (!c) grid.set(key, c = []);
      c.push(p);
    }
    return grid;
  }

  _eachNeighbour(grid, p, reach, fn) {
    const gx = Math.floor(p.x / CELL), gy = Math.floor(p.y / CELL);
    for (let ox = -reach; ox <= reach; ox++) {
      for (let oy = -reach; oy <= reach; oy++) {
        const c = grid.get(cellKey(gx + ox, gy + oy));
        if (c) for (const q of c) fn(q);
      }
    }
  }

  // Nearest point on the board edge to (x, y)
  _edgeToward(x, y) {
    const B = this.B;
    const cx = Math.min(Math.max(x, B.l), B.r), cy = Math.min(Math.max(y, B.t), B.b);
    if (cx !== x || cy !== y) return { x: cx, y: cy };
    const opts = [[x - B.l, B.l, y], [B.r - x, B.r, y], [y - B.t, x, B.t], [B.b - y, x, B.b]];
    opts.sort((a, b) => a[0] - b[0]);
    return { x: opts[0][1], y: opts[0][2] };
  }

  _edgeAtAngle(a) {
    const B = this.B;
    const hw = (B.r - B.l) / 2, hh = (B.b - B.t) / 2, c = Math.cos(a), s = Math.sin(a);
    const t = Math.min(Math.abs(c) > 1e-6 ? hw / Math.abs(c) : Infinity, Math.abs(s) > 1e-6 ? hh / Math.abs(s) : Infinity);
    return { x: B.l + hw + c * t, y: B.t + hh + s * t };
  }

  // Enter from the board edge nearest the group's pieces (or the group's home side), jittered along it
  _spawn(p) {
    const B = this.B;
    let sx = 0, sy = 0, n = 0;
    for (const q of this.pieces) {
      if (q.active && q.group === p.group) { sx += q.x; sy += q.y; n++; }
    }
    const pt = n ? this._edgeToward(sx / n, sy / n) : this._edgeAtAngle(hashAngle(p.group));
    const j = (this.random() - 0.5) * 240;
    if (pt.x === B.l || pt.x === B.r) pt.y = Math.min(Math.max(pt.y + j, B.t + 40), B.b - 40);
    else pt.x = Math.min(Math.max(pt.x + j, B.l + 40), B.r - 40);
    p.active = true;
    p.x = p.px = pt.x;
    p.y = p.py = pt.y;
    p.vx = p.vy = 0;
    p.emerge = EMERGE_TICKS;
    this._heat(p, WALL_HEAT.SPAWN);
  }

  _fixed(p) {
    return p.pinned || p.heat <= 0;
  }

  /**
   * Push overlapping pieces apart (keeping GAP padding), resolving `k` of each overlap per pass.
   * @param {(p: object) => boolean} movable
   */
  _solve(active, iters, k, movable, spreadHeat, alternateCentreLine = false) {
    for (let iter = 0; iter < iters; iter++) {
      const centreLine = alternateCentreLine && iter % 2 === 1;
      const grid = this._grid(active);
      for (const a of active) {
        this._eachNeighbour(grid, a, 1, b => {
          if (b.id <= a.id) return;
          const dx = b.x - a.x, dy = b.y - a.y;
          const ovx = WALL_CARD_W + GAP - Math.abs(dx), ovy = WALL_CARD_H + GAP - Math.abs(dy);
          if (ovx <= 0 || ovy <= 0) return;
          // A tugged group passes through other artists' pieces
          if (a.group !== b.group && (a.phase || b.phase)) return;
          if (spreadHeat) {
            if (a.heat > HEAT_SPREAD_MIN && b.heat <= 0 && !b.pinned) this._heat(b, a.heat * HEAT_SPREAD);
            else if (b.heat > HEAT_SPREAD_MIN && a.heat <= 0 && !a.pinned) this._heat(a, b.heat * HEAT_SPREAD);
          }
          const am = movable(a), bm = movable(b);
          if (!am && !bm) return;
          const sa = am && bm ? b.w / (a.w + b.w) : (am ? 1 : 0);
          const sb = am && bm ? a.w / (a.w + b.w) : (bm ? 1 : 0);
          if (centreLine) {
            // Move apart along the centre line just far enough to clear one axis
            let len = Math.hypot(dx, dy), ux = dx, uy = dy;
            if (len < 1e-3) { ux = 1; uy = 0; len = 1; }
            ux /= len; uy /= len;
            const tx = Math.abs(ux) > 1e-3 ? ovx / Math.abs(ux) : Infinity;
            const ty = Math.abs(uy) > 1e-3 ? ovy / Math.abs(uy) : Infinity;
            const t = Math.min(tx, ty, Math.max(ovx, ovy)) * k;
            a.x -= ux * t * sa; a.y -= uy * t * sa;
            b.x += ux * t * sb; b.y += uy * t * sb;
          } else if (ovx < ovy) {
            const s = (dx < 0 ? -1 : 1) * ovx * k;
            a.x -= s * sa; b.x += s * sb;
          } else {
            const s = (dy < 0 ? -1 : 1) * ovy * k;
            a.y -= s * sa; b.y += s * sb;
          }
        });
      }
      for (const p of active) {
        if (!movable(p) || p.emerge > 0) continue;
        const { d, nx, ny } = this._boardDist(p.x, p.y);
        if (d < 0) { p.x -= nx * d; p.y -= ny * d; }
        if (this.obstacles.length) this._pushOutOfObstacles(p);
      }
    }
  }

  /**
   * Advance one tick.
   * @returns {{ moved: object[], settled: boolean }} pieces whose position changed, and whether the wall just settled
   */
  step() {
    if (!this.awake) return { moved: [], settled: false };
    this.tick++;

    for (let k = 0; k < this.spawnBatch && this.spawnQueue.length; k++) {
      this._spawn(this.spawnQueue.shift());
    }
    const spawning = this.spawnQueue.length > 0;
    const active = this.pieces.filter(p => p.active);

    // Artist rank by total hearts (queued pieces count), and each piece's share of its artist's best
    const totals = new Map(), groupMax = new Map();
    let maxLikes = 1;
    for (const p of this.pieces) {
      totals.set(p.group, (totals.get(p.group) || 0) + p.likes);
      groupMax.set(p.group, Math.max(groupMax.get(p.group) || 1, p.likes));
      maxLikes = Math.max(maxLikes, p.likes);
    }
    const ranked = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a));
    const rankOf = new Map(ranked.map((g, i) => [g, ranked.length > 1 ? 1 - i / (ranked.length - 1) : 1]));

    const groups = new Map();
    let held = 0;
    for (const p of active) {
      p.px = p.x; p.py = p.y;
      p.rank = rankOf.get(p.group) || 0;
      p.likeShare = Math.sqrt(p.likes / (groupMax.get(p.group) || 1));
      const g = groups.get(p.group) || { x: 0, y: 0, n: 0 };
      g.x += p.x; g.y += p.y; g.n++;
      groups.set(p.group, g);
      if (p.swapCooldown > 0) p.swapCooldown--;
      if (p.boost > 0) p.boost--;
      if (p.pinned) {
        held++;
        if (++p.holdTicks > HOLD_TIMEOUT_TICKS) this._release(p);
      } else if (p.heat > 0) {
        p.heat = Math.max(0, p.heat - 1 / COOL_TICKS);
      }
    }

    // Leash: a held piece pulled past its limit tugs the rest of its group toward the cursor
    const tugs = new Map();
    for (const p of active) {
      if (!p.pinned || !p.dragged) continue;
      const g = groups.get(p.group);
      if (!g || g.n < 2) continue;
      const cx = (g.x - p.x) / (g.n - 1), cy = (g.y - p.y) / (g.n - 1);
      const dx = p.tx - cx, dy = p.ty - cy, dist = Math.hypot(dx, dy), L = leashLength(g.n);
      if (dist <= L) continue;
      const f = Math.min((dist - L) * LEASH_K, LEASH_MAX) / Math.sqrt(g.n / 12 + 1);
      const tug = tugs.get(p.group) || { fx: 0, fy: 0 };
      tug.fx += dx / dist * f; tug.fy += dy / dist * f;
      tugs.set(p.group, tug);
    }
    for (const p of active) {
      if (tugs.has(p.group) && !p.pinned) {
        p.phase = true;
        this._heat(p, WALL_HEAT.DRAG);
      } else if (p.phase) {
        // Solid again, with extra weight so it pushes into space rather than being shoved back out
        p.phase = false;
        p.boost = BOOST_TICKS;
      }
    }

    for (const p of active) {
      p.w = (0.25 + 0.6 * p.rank + 0.15 * Math.sqrt(p.likes / maxLikes)) * (p.boost > 0 ? BOOST_W : 1);
      if (this._fixed(p)) { p.vx = p.vy = 0; continue; }
      const gliding = p.glide > 0;
      const soft = (gliding ? GLIDE_FORCE : 1) * (0.4 + 0.6 * p.heat);
      const tug = tugs.get(p.group);

      // Always head for the board; heavier (more-hearted) pieces pull harder
      const { d, nx, ny } = this._boardDist(p.x, p.y);
      let fx, fy;
      if (d < 0) {
        const push = Math.min(-d * 0.25, 30);
        fx = nx * push; fy = ny * push;
      } else {
        const pull = (Math.min(d, 40) / 40) * PULL * p.w * soft * (tug ? 0.5 : 1);
        fx = -nx * pull; fy = -ny * pull;
      }
      if (tug) { fx += tug.fx; fy += tug.fy; }

      // Artist tether: soft inside the group radius, firm (but capped) outside it
      const g = groups.get(p.group);
      if (g.n > 1) {
        const cx = (g.x - p.x) / (g.n - 1) - p.x, cy = (g.y - p.y) / (g.n - 1) - p.y;
        const len = Math.hypot(cx, cy) || 1;
        const R = TETHER_R * Math.sqrt(g.n);
        const f = (len > R ? Math.min((len - R) * TETHER_K + R * 0.004, TETHER_MAX) : len * 0.004) * soft;
        fx += cx / len * f; fy += cy / len * f;
      }

      const damp = gliding ? GLIDE_DAMP : DAMP;
      const cap = gliding ? WALL_THROW_MAX : (p.emerge > 0 ? MAX_SPEED : MAX_SPEED * (0.25 + 0.75 * p.heat));
      let vx = (p.vx + fx) * damp, vy = (p.vy + fy) * damp;
      const sp = Math.hypot(vx, vy);
      if (sp > cap) { vx *= cap / sp; vy *= cap / sp; }
      p.x += vx; p.y += vy;
    }

    this._solve(active, SOLVE_ITERS, SOLVE_K, p => !this._fixed(p), true);

    // The group moved, so re-clamp held pieces; thrown pieces stop at the leash too
    for (const p of active) {
      if (p.pinned && p.dragged) {
        const r = clampToLeash(active, p, p.tx, p.ty);
        p.x = r.x; p.y = r.y;
      } else if (p.glide > 0) {
        // A throw past the free length stretches the leash, which quickly takes the momentum out
        const r = clampToLeash(active, p, p.x, p.y);
        if (r.taut) { p.x = r.x; p.y = r.y; p.glide = Math.min(p.glide, 3); }
      }
    }

    const swaps = this._swapPass(active, groups);

    const moved = [];
    let hotMove = 0, hotCount = 0;
    for (const p of active) {
      p.vx = p.x - p.px; p.vy = p.y - p.py;
      const m = Math.hypot(p.vx, p.vy);
      if (m > 0.5) moved.push(p);
      if (p.heat > 0 && !p.pinned) { hotMove += m; hotCount++; }
      if (p.emerge > 0) p.emerge--;
      if (p.glide > 0) {
        p.glide--;
        if (m < 2) p.glide = 0;
      }
    }

    const avgMove = hotCount ? hotMove / hotCount : 0;
    this.calm = avgMove < CALM_MOVE && !swaps && !held && !spawning && !tugs.size ? this.calm + 1 : 0;
    const holding = this.tick < this.holdAwakeUntil;
    if (!held && !spawning && (hotCount === 0 || (this.calm >= CALM_TICKS && !holding))) {
      const finalMoved = this._settle(active);
      for (const p of finalMoved) if (!moved.includes(p)) moved.push(p);
      return { moved, settled: true };
    }
    return { moved, settled: false };
  }

  // Final cleanup over everything this wake touched, then freeze. A touched piece can be wedged
  // against frozen neighbours it may not move, so any piece still overlapping after a pass joins
  // the movable set and the pass repeats: the wall never freezes with cards on top of each other.
  _settle(active) {
    const before = new Map(active.map(p => [p, { x: p.x, y: p.y }]));
    for (const p of active) { p.phase = false; p.emerge = 0; p.glide = 0; p.boost = 0; }
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      this._solve(active, FINAL_ITERS, 1, p => p.touched && !p.pinned, false, true);
      if (!this._touchOverlapping(active)) break;
    }
    const moved = [];
    for (const p of active) {
      const b = before.get(p);
      if (Math.hypot(p.x - b.x, p.y - b.y) > 0.5) moved.push(p);
      p.px = p.x; p.py = p.y; p.vx = p.vy = 0;
      p.heat = 0;
      p.touched = false;
    }
    this.awake = false;
    this.calm = 0;
    return moved;
  }

  /**
   * Finds cards still overlapping (or blocked) and makes them and everything within one cell of
   * them movable. Freeing only the overlapping pair isn't enough: a packed row wedged between the
   * shelf and a board corner needs its whole neighbourhood to shift.
   * @returns {boolean} whether any overlap was found
   */
  _touchOverlapping(active) {
    const grid = this._grid(active);
    const stuck = new Set();
    for (const a of active) {
      if (this._blocked(a)) stuck.add(a);
      this._eachNeighbour(grid, a, 1, b => {
        if (b.id <= a.id) return;
        if (Math.abs(b.x - a.x) < WALL_CARD_W + OVERLAP_SLACK && Math.abs(b.y - a.y) < WALL_CARD_H + OVERLAP_SLACK) {
          stuck.add(a);
          stuck.add(b);
        }
      });
    }
    for (const s of stuck) {
      this._eachNeighbour(grid, s, 2, q => {
        if (!q.pinned && Math.abs(q.x - s.x) <= CELL * 2 && Math.abs(q.y - s.y) <= CELL * 2) q.touched = true;
      });
    }
    return stuck.size > 0;
  }

  // Neighbours trade places when it helps: across artists only when neither gets meaningfully
  // worse; within an artist when it puts the more-hearted piece nearer the board.
  _swapPass(active, groups) {
    const eligible = p => !p.pinned && !p.phase && p.glide <= 0 && p.emerge <= 0 && p.swapCooldown <= 0 && p.heat > SWAP_MIN_HEAT;
    const homeOf = p => {
      const g = groups.get(p.group);
      return g && g.n > 1 ? { x: (g.x - p.px) / (g.n - 1), y: (g.y - p.py) / (g.n - 1) } : null;
    };
    const bd = (x, y) => Math.max(0, this._boardDist(x, y).d);
    const grid = this._grid(active);
    let count = 0;

    for (const a of active) {
      if (!eligible(a)) continue;
      const ha = homeOf(a);
      const bdA = bd(a.x, a.y);
      let best = null, bestGain = SWAP_GAIN;

      this._eachNeighbour(grid, a, 2, b => {
        if (b === a || !eligible(b)) return;
        if (Math.abs(b.x - a.x) > WALL_CARD_W + GAP + SWAP_REACH || Math.abs(b.y - a.y) > WALL_CARD_H + GAP + SWAP_REACH) return;
        const bdB = bd(b.x, b.y);
        let gain;
        if (a.group === b.group) {
          gain = RANK_SAME_K * (a.likeShare - b.likeShare) * (bdA - bdB);
        } else {
          const hb = homeOf(b);
          if (!ha && !hb) return;
          const costA0 = (ha ? Math.hypot(a.x - ha.x, a.y - ha.y) : 0) + RANK_CROSS_K * a.rank * bdA;
          const costA1 = (ha ? Math.hypot(b.x - ha.x, b.y - ha.y) : 0) + RANK_CROSS_K * a.rank * bdB;
          const costB0 = (hb ? Math.hypot(b.x - hb.x, b.y - hb.y) : 0) + RANK_CROSS_K * b.rank * bdB;
          const costB1 = (hb ? Math.hypot(a.x - hb.x, a.y - hb.y) : 0) + RANK_CROSS_K * b.rank * bdA;
          if (costA1 - costA0 > SWAP_TOLERANCE || costB1 - costB0 > SWAP_TOLERANCE) return;
          gain = costA0 + costB0 - costA1 - costB1;
        }
        if (gain > bestGain) { bestGain = gain; best = b; }
      });

      if (best) {
        const ax = a.x, ay = a.y;
        a.x = best.x; a.y = best.y;
        best.x = ax; best.y = ay;
        a.swapCooldown = best.swapCooldown = SWAP_COOLDOWN;
        count++;
      }
    }
    return count;
  }

  /** @returns {Array<{id: string, x: number, y: number}>} */
  layout() {
    return this.pieces
      .filter(p => p.active)
      .map(p => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y) }));
  }
}
