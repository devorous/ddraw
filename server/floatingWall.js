/**
 * @fileoverview Server-side floating art wall, one per room.
 *
 * Loads the room's gallery pieces and computes their layout with the shared
 * FloatingWallSim, only when something changes (art added, removed or hidden,
 * hearts, the WIP shelf, board size). The sim runs straight to settled in
 * short slices, then the pieces that moved go out once and the layout is saved
 * to `room.settings.floatingWall`. Dragging is local to each client (it runs
 * its own copy of the sim), so it costs the server nothing.
 *
 * Also owns the room's works-in-progress shelf (server/wipArts.js): art
 * detached from the board, parked under it until its owner or an admin drags
 * it back.
 *
 * Wire (T.FLOATING_WALL, JSON in `floatingWallJson`, positions packed in `floatingWallPos`):
 *   server → client  { a: 'state', r, w, h, ids: [galleryId, ...], g: [group, ...] } + pos [index, x, y, ...]
 *                    { a: 'pos', r } + pos [index, x, y, ...]   (only pieces the new layout moved)
 *                    { a: 'likes', id, n }
 *                    { a: 'wip', items: [{ id, owner, w, h, canManage, claimed }] }   (per client)
 *                    { a: 'fly', id, x, y, w, h }   (art just detached from that board rect; full-mode clients except the detacher)
 *                    { a: 'res', req, ok, error?, id? }   (reply to a request with `req`; detach adds the shelf id)
 *   client → server  { a: 'hello', slow? } | { a: 'bye' }
 *                    { a: 'detach', req, owner, dataUrl, x, y, w, h }
 *                    { a: 'wipClaim' | 'wipRelease' | 'wipRestore' | 'wipDelete', req, id }
 *                    { a: 'hide', req, id }   (Mod+: adds the piece to the room's floatingGalleryExcludeIds)
 *
 * Positions are card centres in board px. `r` is the membership revision: position indexes refer
 * to the `ids` of the state with the same `r`, so a client drops stale updates. `g` is an opaque
 * per-wall group number (the leash and tether need grouping, not who the artist is). Card details
 * (author, title, thumbnail, hearts) aren't on the wire: clients fetch them in batches from
 * GET /api/gallery/wall-meta for the cards near their screen.
 *
 * Only clients that said `hello` get wall traffic (`ws.floatingWallMode`); `slow` ones (low power
 * or mobile) are skipped for cosmetic traffic like `fly`.
 */

import { FloatingWallSim, wipShelfLayout } from '../shared/floatingWallSim.js';
import { getBoardDimensionsForSize } from '../shared/boardSizes.js';
import { T } from '../shared/MessageTypes.js';
import { getDB } from './db.js';
import { loadWallGalleryItems } from './gallery.js';
import { Role } from './SessionManager.js';
import { listWipArts, createWipArt, deleteWipArt, MAX_WIP_PER_ROOM } from './wipArts.js';

const MAX_WALL_PIECES = 400;
const MAX_CLIENT_JSON = 1000;
// A detach carries the image itself
const MAX_DETACH_JSON = 6 * 1024 * 1024;
const COORD_LIMIT = 100000;
// Room settings saves keep at most this many excluded ids (server/index.js)
const MAX_HIDDEN_IDS = 200;
// A claimed shelf piece is being placed by someone; it frees itself if they never commit or cancel
const CLAIM_TTL_MS = 5 * 60 * 1000;

// Layout computation: a full 400-piece settle is ~300 ms of CPU, so it yields between slices
const COMPUTE_SLICE_MS = 8;
// The sim settles within ~300 ticks; this only guards against a layout that never does
const MAX_COMPUTE_TICKS = 3000;
// How long a change waits before the layout is recomputed, so bursts share one computation
const LAYOUT_DELAY_MS = { NOW: 0, SHELF: 300, MEMBERSHIP: 1000, HEARTS: 30000 };

const isSubscribed = client => !!client.floatingWallMode;
const isFullSubscriber = client => client.floatingWallMode === 'full';

function clampCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, n)) : null;
}

function effectiveRole(ws) {
  return Math.max(Number(ws?.userRole || 0), Number(ws?.roomRole || 0), Number(ws?.globalRole || 0));
}

// Detaching art on someone else's behalf; hiding a piece from the wall
function isModerator(ws) {
  return effectiveRole(ws) >= Role.MOD;
}

// Placing or deleting someone else's shelf piece
function isAdmin(ws) {
  return effectiveRole(ws) >= Role.ADMIN;
}

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

export class FloatingWall {
  /**
   * @param {object} room
   * @param {{ broadcast: (room: object, payload: object, filter?: (client: object) => boolean) => void, send: (ws: object, payload: object) => void, settingsChanged?: (room: object) => void }} io
   */
  constructor(room, { broadcast, send, settingsChanged = null }) {
    this.room = room;
    this.broadcast = broadcast;
    this.send = send;
    // Pushes the room's settings to its clients after the wall changes them (hiding a piece)
    this.settingsChanged = settingsChanged;
    this.sim = new FloatingWallSim(this._boardDims());
    this.items = new Map();
    this.indexById = new Map();
    this.sentRevision = -1;
    // The positions clients have: id → [x, y]. States carry these, never a half-computed layout.
    this.sentPos = new Map();
    this.wip = [];
    this.claims = new Map();
    this.loading = null;
    this.timer = null;
    this.timerDue = 0;
    this.computing = false;
    this.recompute = false;
    this.disposed = false;
    this.shelfRect = null;
  }

  static forRoom(room, io) {
    if (!room.floatingWall) room.floatingWall = new FloatingWall(room, io);
    return room.floatingWall;
  }

  _boardDims() {
    const [height, width] = getBoardDimensionsForSize(this.room.settings?.boardSize);
    return { boardWidth: width, boardHeight: height };
  }

  // Keep the wall clear of the WIP shelf under the board. When the shelf changes size (a detach, a
  // restore, a delete), the pieces around both its old and new footprint re-pack (15 s of sim time).
  _applyBoard({ disturb = false } = {}) {
    const { boardWidth, boardHeight } = this._boardDims();
    const previous = this.sim.obstacles.length ? this.shelfRect : null;
    this.sim.setBoard(boardWidth, boardHeight);
    const shelf = wipShelfLayout(this.wip.length, boardWidth, boardHeight).rect;
    this.shelfRect = shelf;
    this.sim.setObstacles(shelf ? [shelf] : []);
    if (!disturb) return;
    const rects = [previous, shelf].filter(Boolean);
    this.sim.disturbRect(rects.length ? {
      l: Math.min(...rects.map(r => r.l)),
      t: Math.min(...rects.map(r => r.t)),
      r: Math.max(...rects.map(r => r.r)),
      b: Math.max(...rects.map(r => r.b))
    } : null);
  }

  ensureLoaded() {
    if (!this.loading) {
      this.loading = this._loadItems(true).catch(err => {
        console.error(`[FloatingWall] Load failed for "${this.room.id}":`, err);
        this.loading = null;
      });
    }
    return this.loading;
  }

  async _loadItems(useSavedLayout) {
    const settings = this.room.settings || {};
    const [items, wip] = await Promise.all([
      loadWallGalleryItems(this.room.id, {
        includeIds: settings.floatingGalleryIncludeIds || [],
        excludeIds: settings.floatingGalleryExcludeIds || [],
        limit: MAX_WALL_PIECES
      }),
      listWipArts(this.room.id)
    ]);
    if (this.disposed) return;

    const saved = useSavedLayout && Array.isArray(settings.floatingWall?.pieces)
      ? new Map(settings.floatingWall.pieces.map(p => [String(p.id), { x: Number(p.x), y: Number(p.y) }]))
      : null;

    this.wip = wip;
    this._applyBoard();
    this.items = new Map(items.map(item => [item.id, item]));
    this.sim.setPieces(items.map(item => ({ id: item.id, group: item.group, likes: item.likesCount })), saved);
    // A saved layout is already settled: clients get it straight away
    if (saved) {
      for (const p of this.sim.pieces) {
        if (p.active && saved.has(p.id)) this.sentPos.set(p.id, [Math.round(p.x), Math.round(p.y)]);
      }
    }
    this._syncState();
    this._broadcastWip();
    this._schedule(LAYOUT_DELAY_MS.NOW);
  }

  /**
   * Re-read membership and board size after room settings change. Pieces already on the wall keep
   * their spots, unless `resetLayout` ("Rearrange" in room settings) sends every piece back through
   * the spawn sequence.
   */
  refresh({ resetLayout = false } = {}) {
    if (this.disposed || !this.loading) return;
    this.loading = this.loading
      .then(() => {
        if (resetLayout) {
          this.sim.clearPieces();
          this.sentPos.clear();
        }
        return this._loadItems(false);
      })
      .catch(err => console.error(`[FloatingWall] Refresh failed for "${this.room.id}":`, err));
  }

  onLikes(id, likesCount) {
    const item = this.items.get(id);
    if (!item) return;
    item.likesCount = likesCount;
    this.sim.setLikes(id, likesCount);
    this.broadcast(this.room, { t: T.FLOATING_WALL, floatingWallJson: JSON.stringify({ a: 'likes', id, n: likesCount }) }, isSubscribed);
    this._schedule(LAYOUT_DELAY_MS.HEARTS);
  }

  onAdded(item) {
    if (!this.loading || this.disposed || this.items.has(item.id)) return;
    if (this.items.size >= MAX_WALL_PIECES) return;
    if ((this.room.settings?.floatingGalleryExcludeIds || []).includes(item.id)) return;
    this.items.set(item.id, item);
    this.sim.addPiece({ id: item.id, group: item.group, likes: item.likesCount });
    this._syncState();
    this._schedule(LAYOUT_DELAY_MS.MEMBERSHIP);
  }

  onRemoved(id) {
    if (!this.items.delete(id)) return;
    this.sim.removePiece(id);
    this._syncState();
    this._schedule(LAYOUT_DELAY_MS.MEMBERSHIP);
  }

  _syncState() {
    if (this.sim.revision === this.sentRevision) return;
    this.sentRevision = this.sim.revision;
    this.indexById = new Map(this.sim.pieces.map((p, i) => [p.id, i]));
    for (const id of this.sentPos.keys()) {
      if (!this.indexById.has(id)) this.sentPos.delete(id);
    }
    this.broadcast(this.room, this._statePayload(), isSubscribed);
  }

  _statePayload() {
    const groups = new Map();
    const ids = [];
    const g = [];
    const pos = [];
    this.sim.pieces.forEach((p, index) => {
      if (!groups.has(p.group)) groups.set(p.group, groups.size);
      ids.push(p.id);
      g.push(groups.get(p.group));
      const at = this.sentPos.get(p.id);
      if (at) pos.push(index, at[0], at[1]);
    });
    const { boardWidth, boardHeight } = this._boardDims();
    return {
      t: T.FLOATING_WALL,
      floatingWallJson: JSON.stringify({ a: 'state', r: this.sim.revision, w: boardWidth, h: boardHeight, ids, g }),
      floatingWallPos: pos
    };
  }

  // Recompute the layout after `delayMs`, or sooner if something else already asked for sooner
  _schedule(delayMs) {
    if (this.disposed) return;
    const due = Date.now() + delayMs;
    if (this.timer && this.timerDue <= due) return;
    clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._computeLayout();
    }, delayMs);
  }

  async _computeLayout() {
    if (this.disposed || !this.sim.awake) return;
    if (this.computing) {
      this.recompute = true;
      return;
    }
    this.computing = true;
    let settled = false;
    let ticks = 0;
    try {
      // Changes that land while this runs (a new piece, a heart) just join the running simulation
      while (this.sim.awake && !this.disposed && ticks < MAX_COMPUTE_TICKS) {
        const sliceEnd = performance.now() + COMPUTE_SLICE_MS;
        do {
          if (this.sim.step().settled) settled = true;
          ticks++;
        } while (this.sim.awake && ticks < MAX_COMPUTE_TICKS && performance.now() < sliceEnd);
        if (this.sim.awake) await yieldToEventLoop();
      }
    } catch (err) {
      console.error(`[FloatingWall] Layout failed for "${this.room.id}":`, err);
    } finally {
      this.computing = false;
    }
    if (this.disposed) return;
    if (this.sim.awake && ticks >= MAX_COMPUTE_TICKS) {
      console.warn(`[FloatingWall] Layout for "${this.room.id}" did not settle within ${MAX_COMPUTE_TICKS} ticks`);
    }

    this._syncState();
    this._broadcastPositions();
    if (settled && !this.sim.awake) this._save();
    if (this.recompute) {
      this.recompute = false;
      this._schedule(LAYOUT_DELAY_MS.NOW);
    }
  }

  // Only the pieces whose settled spot differs from what clients already have
  _broadcastPositions() {
    const pos = [];
    for (const p of this.sim.pieces) {
      if (!p.active) continue;
      const x = Math.round(p.x), y = Math.round(p.y);
      const at = this.sentPos.get(p.id);
      if (at && at[0] === x && at[1] === y) continue;
      this.sentPos.set(p.id, [x, y]);
      const index = this.indexById.get(p.id);
      if (index !== undefined) pos.push(index, x, y);
    }
    if (!pos.length) return;
    this.broadcast(this.room, {
      t: T.FLOATING_WALL,
      floatingWallJson: JSON.stringify({ a: 'pos', r: this.sim.revision }),
      floatingWallPos: pos
    }, isSubscribed);
  }

  async _save() {
    const layout = { version: 1, settledAt: Date.now(), pieces: this.sim.layout() };
    if (this.room.settings) this.room.settings.floatingWall = layout;
    const db = getDB();
    if (!db) return;
    try {
      await db.collection('rooms').updateOne({ _id: this.room.id }, { $set: { 'settings.floatingWall': layout } });
    } catch (err) {
      console.error(`[FloatingWall] Save failed for "${this.room.id}":`, err);
    }
  }

  _claimHolder(id) {
    const claim = this.claims.get(id);
    if (!claim) return null;
    if (Date.now() > claim.expires) {
      this.claims.delete(id);
      return null;
    }
    return claim.holder;
  }

  _canManageWip(ws, item) {
    return isAdmin(ws) || (!!ws.userId && ws.userId === item.ownerId);
  }

  // Per client: whether they may place or delete a piece depends on who they are
  _wipPayload(ws) {
    const holder = `s${ws.sessionIndex}`;
    return {
      t: T.FLOATING_WALL,
      floatingWallJson: JSON.stringify({
        a: 'wip',
        items: this.wip.map(item => {
          const claimHolder = this._claimHolder(item.id);
          return {
            id: item.id,
            owner: item.ownerName,
            w: item.width,
            h: item.height,
            canManage: this._canManageWip(ws, item),
            claimed: claimHolder !== null && claimHolder !== holder
          };
        })
      })
    };
  }

  _broadcastWip() {
    for (const client of this.room.clients || []) {
      if (client.sessionIndex !== undefined && isSubscribed(client)) this.send(client, this._wipPayload(client));
    }
  }

  /**
   * Handle a client T.FLOATING_WALL message. Never relayed; the server answers with state or a reply.
   */
  async handleMessage(ws, data) {
    const raw = data.floatingWallJson;
    if (typeof raw !== 'string' || !raw || raw.length > MAX_DETACH_JSON) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.a !== 'detach' && raw.length > MAX_CLIENT_JSON) return;

    await this.ensureLoaded();
    if (this.disposed) return;

    const holder = `s${ws.sessionIndex}`;
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : '';
    const req = Number.isInteger(msg.req) ? msg.req : undefined;
    const reply = (ok, error, extra = null) => {
      if (req === undefined) return;
      this.send(ws, { t: T.FLOATING_WALL, floatingWallJson: JSON.stringify({ a: 'res', req, ok, ...(error ? { error } : {}), ...extra }) });
    };

    switch (msg.a) {
      case 'hello':
        ws.floatingWallMode = msg.slow ? 'slow' : 'full';
        this.send(ws, this._statePayload());
        this.send(ws, this._wipPayload(ws));
        break;

      case 'bye':
        ws.floatingWallMode = null;
        break;

      case 'detach':
        await this._detach(ws, msg, reply);
        break;

      case 'hide': {
        if (!isModerator(ws)) return reply(false, 'Only moderators can hide gallery art');
        if (!this.items.has(id)) return reply(false, 'That piece is no longer on the wall');
        const error = await this._hide(id);
        reply(!error, error);
        break;
      }

      case 'wipClaim': {
        const item = this.wip.find(w => w.id === id);
        if (!item) return reply(false, 'That piece is no longer on the shelf');
        if (!this._canManageWip(ws, item)) return reply(false, 'Only its owner or an admin can place this piece');
        const current = this._claimHolder(id);
        if (current && current !== holder) return reply(false, 'Someone else is placing this piece');
        this.claims.set(id, { holder, expires: Date.now() + CLAIM_TTL_MS });
        reply(true);
        this._broadcastWip();
        break;
      }

      case 'wipRelease':
        if (this._claimHolder(id) === holder) {
          this.claims.delete(id);
          this._broadcastWip();
        }
        reply(true);
        break;

      case 'wipRestore':
      case 'wipDelete': {
        const item = this.wip.find(w => w.id === id);
        if (!item) return reply(false, 'That piece is no longer on the shelf');
        if (!this._canManageWip(ws, item)) return reply(false, 'Only its owner or an admin can do that');
        const current = this._claimHolder(id);
        if (current && current !== holder) return reply(false, 'Someone else is placing this piece');
        await this._removeWip(item);
        reply(true);
        break;
      }
    }
  }

  async _detach(ws, msg, reply) {
    if (!ws.userId) return reply(false, 'Only registered users can detach art');
    if (ws.isShadowBanned) return reply(false, 'Detach failed');
    if (this.wip.length >= MAX_WIP_PER_ROOM) return reply(false, `The shelf is full (${MAX_WIP_PER_ROOM} pieces)`);

    let owner = { id: ws.userId, name: ws.username };
    if (msg.owner !== null && msg.owner !== undefined && Number(msg.owner) !== ws.sessionIndex) {
      if (!isModerator(ws)) return reply(false, 'Only moderators can detach art for someone else');
      const target = [...(this.room.clients || [])].find(client => client.sessionIndex === Number(msg.owner));
      if (!target?.userId) return reply(false, 'That user is not registered or has left the room');
      owner = { id: target.userId, name: target.username };
    }

    let result;
    try {
      result = await createWipArt({
        roomId: this.room.id,
        ownerId: owner.id,
        ownerName: owner.name,
        detachedById: ws.userId,
        detachedByName: ws.username,
        dataUrl: msg.dataUrl,
        rect: { x: msg.x, y: msg.y, w: msg.w, h: msg.h }
      });
    } catch (err) {
      console.error(`[FloatingWall] Detach failed for "${this.room.id}":`, err);
      return reply(false, 'Could not save the piece');
    }
    if (!result.ok) return reply(false, result.error);

    this.wip.push(result.item);
    // The id lets the detaching client fly the art into its new shelf card
    reply(true, null, { id: result.item.id });
    // Everyone else watching at full speed sees it fly too (from /api/wip/:id). Sent before the
    // shelf update so their new card starts hidden instead of flashing in ahead of the flight.
    const [x, y, w, h] = [msg.x, msg.y, msg.w, msg.h].map(clampCoord);
    if (x !== null && y !== null && w > 0 && h > 0) {
      this.broadcast(
        this.room,
        { t: T.FLOATING_WALL, floatingWallJson: JSON.stringify({ a: 'fly', id: result.item.id, x, y, w, h }) },
        client => client !== ws && isFullSubscriber(client)
      );
    }
    this._applyBoard({ disturb: true });
    this._broadcastWip();
    this._schedule(LAYOUT_DELAY_MS.SHELF);
  }

  /**
   * Hide a piece from this room's wall: the same exclude list room settings edit, so it stays
   * hidden across reloads and can be unhidden there. Its neighbours close the gap.
   * @returns {Promise<string|null>} an error message, or null
   */
  async _hide(id) {
    const settings = this.room.settings;
    if (!settings) return 'Room settings are not loaded';
    const excluded = Array.isArray(settings.floatingGalleryExcludeIds) ? settings.floatingGalleryExcludeIds : [];
    if (!excluded.includes(id)) {
      if (excluded.length >= MAX_HIDDEN_IDS) {
        return `The hidden list is full (${MAX_HIDDEN_IDS}). Unhide some in Room Settings → Floating Gallery.`;
      }
      settings.floatingGalleryExcludeIds = [...excluded, id];
    }
    settings.floatingGalleryIncludeIds = (settings.floatingGalleryIncludeIds || []).filter(included => included !== id);
    this.onRemoved(id);
    try {
      await this.room.saveToDB?.();
    } catch (err) {
      console.error(`[FloatingWall] Saving hidden piece failed for "${this.room.id}":`, err);
    }
    // Clients' copy of the exclude list must include it, or the next room settings save would unhide it
    this.settingsChanged?.(this.room);
    return null;
  }

  async _removeWip(item) {
    await deleteWipArt(this.room.id, item.id);
    this.wip = this.wip.filter(w => w !== item);
    this.claims.delete(item.id);
    this._applyBoard({ disturb: true });
    this._broadcastWip();
    this._schedule(LAYOUT_DELAY_MS.SHELF);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
