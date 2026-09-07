/** @fileoverview Manages drawing rooms, including their metadata, connected clients, and lifecycle. */

import { SessionManager } from './SessionManager.js';
import { SyncCoordinator } from './SyncCoordinator.js';
import { ParityCoordinator } from './ParityCoordinator.js';
import { T } from '../shared/MessageTypes.js';
import { StrokeFingerprintLog } from '../shared/StrokeFingerprint.js';
import { StrokeTape } from './StrokeTape.js';
import { RoomHistory } from './RoomHistory.js';
import { WebSocket } from 'ws';
import { getDB } from './db.js';
import { scoreProvider } from './providerScoring.js';
import { getSnapshotFile } from './r2.js';
import { decodeSnapshotFile } from './snapshotCodec.js';
import { generateFloatingGalleryVoronoi } from './floatingVoronoi.js';
import { snapshotCoversRoomBoard } from '../shared/qoi.js';
import { isValidBoardSize } from '../shared/boardSizes.js';

function createFloatingGallerySeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * Represents a single drawing room.
 */
export class Room {
  /**
   * @param {string} id - The unique identifier for the room.
   * @param {Object} msgProto - The protobuf message type for encoding/decoding.
   * @param {function} sendToCallback - Callback function to send messages to a specific client.
   */
  constructor(id, msgProto, sendToCallback) {
    this.id = id;
    this.Msg = msgProto;
    this.sendTo = sendToCallback;

    this.clients = new Set();
    this.settings = {
      mirror: false,
      mirrorRegions: [],
      locked: false,
      maxUsers: 40,
      backgroundColor: '#ffffff',
      modInactiveImmune: false,
      joinPolicy: 'open',
      obscureRequiresRegistered: false,
      autoMuteGuests: false,
      autoMuteVpnUsers: false,
      hideChatNotifications: false,
      // When on (default), the first user into an empty room picks the board
      // back up from the room's last persisted snapshot instead of a blank
      // canvas. See Room.beginSessionBase / SyncCoordinator._serveCheckpointJoin.
      loadSnapshotOnFirstJoin: true,
      // Explicitly pinned start state: the id of the snapshot a re-opening room
      // adopts instead of its newest one. null = follow the newest snapshot
      // (the historical behaviour). Set from Room Settings -> Start state.
      startSnapshotId: null,
      // "Clear saved state": ignore every snapshot taken at or before this
      // timestamp, so the room opens blank without deleting anything. Any
      // snapshot taken AFTER it supersedes the clear, which is what makes the
      // blank start temporary and self-healing. 0 = not cleared.
      startSnapshotClearedTs: 0,
      dedicatedReplayUser: null,
      textOverlayLifetimeMs: 30 * 1000,
      private: false,
      floatingGallerySeed: createFloatingGallerySeed(),
      floatingGalleryIncludeIds: [],
      floatingGalleryExcludeIds: [],
      floatingGalleryVoronoi: null,
      boardSize: '1080p',
      // Opt-in perf experiment: layer 0's baked raster becomes a grid of
      // lazily-allocated tile canvases instead of one full-board canvas.
      // Hidden flag (no room-creation UI) — set directly on specific rooms to
      // hand-pick the prod trial cohort. Also gated by the
      // ENABLE_TILED_CANVAS_BACKING_STORE env var kill switch, see
      // server/replayConfig.js-style pattern in server/index.js.
      //
      // Defaults ON (opt-out via TILED_CANVAS_DEFAULT=false); see
      // server/tiledCanvasConfig.js for why nothing here may depend on an env
      // var being *set*.
      // TILED_CANVAS_DEFAULT flips the default for *newly minted* rooms, which
      // is what lets the sync suites (selparity, concurrent, k6edge, undosnap,
      // parity) exercise the tiled path at all — they each mint a fresh
      // timestamped room, so with a hard-coded false they only ever measured
      // the untiled path.
      //
      // It does NOT reach rooms already in the DB: loadFromDB below overwrites
      // this with the stored value, which saveToDB has always written
      // explicitly. To turn tiling on for EVERY room, use
      // TILED_CANVAS_FORCE_ALL (server/tiledCanvasConfig.js), which overrides
      // at read time and leaves this stored value alone.
      tiledCanvasBackingStore: process.env.TILED_CANVAS_DEFAULT !== 'false'
    };

    this.description = '';
    this.ownerId = null;
    this.ownerUsername = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.dbLoaded = false;
    this.obscureRegions = new Map();

    /** @type {Array<Object>} Ephemeral SVG text records: { id, text, font, size, color, opacity, x, y, textPositionMultiplier, textPositionOffset, layerIndex, blendMode, blendBakeMode, userId, sessionIndex, bornAt, lifetimeMs, fadeMs }. Not persisted. */
    this.activeTexts = [];

    /** @type {Buffer|null} PNG preview image at 1/4 scale */
    this.preview = null;
    /** @type {number} Timestamp of last preview update */
    this.previewUpdatedAt = 0;

    const isDiscovery = id === '_discovery';
    this.sessionManager = new SessionManager(this.broadcastToAll.bind(this), isDiscovery, {
      isImmuneToInactivity: (_sessionIndex, user) => {
        const role = user.role || 0;
        return role >= 5 || (!!this.settings.modInactiveImmune && role >= 4);
      },
      onAllUsersAfk: () => this._onAllUsersAfk()
    });
    this.syncCoordinator = new SyncCoordinator(this.sessionManager, { clients: this.clients }, this.sendTo, this);

    /** @type {Set<number>} Set of occupied tile indices */
    this.tileDirtySet = new Set();
    this.settings.floatingGalleryVoronoi = generateFloatingGalleryVoronoi(this.settings.floatingGallerySeed);

    /** @type {number} Global message sequence number for this room */
    this.messageSequence = 0;

    /**
     * Per-room commit fingerprint log for sync parity. Server-side instance
     * retains the original wire bytes so it can replay missing strokes to
     * out-of-sync clients (targeted resync, Phase 3).
     * @type {StrokeFingerprintLog}
     */
    this.strokeLog = new StrokeFingerprintLog({ storeBytes: true });

    /**
     * Per-stroke geometry tape, keyed by commit seq. Retains the MD/MM frames
     * and a tool-state preamble for each stroke so a fresh joiner can redraw
     * post-checkpoint strokes from the original commands (the fingerprint log
     * stores only commit markers, which can't reconstruct a brush line). Bounded
     * alongside strokeLog by checkpoint truncation. See server/StrokeTape.js.
     * @type {StrokeTape}
     */
    this.strokeTape = new StrokeTape(T);

    /**
     * Archive of the frames the checkpoint truncations above retire, kept for a
     * rolling ~2 minutes so a joiner can be backfilled with the history they
     * would otherwise have missed. Fed by truncation, never by extending
     * strokeLog/strokeTape retention — those two ARE the parity window.
     * See server/RoomHistory.js.
     * @type {RoomHistory}
     */
    this.history = new RoomHistory();

    /** @type {ParityCoordinator} Handles SYNC_PARITY_* messages for this room. */
    this.parityCoordinator = new ParityCoordinator(this, this.sendTo);

    /** @type {Array<Object>} Rolling buffer of board snapshots (max 24, every 10s for 4 min) */
    this.snapshots = [];
    /**
     * True after a lone joiner intentionally starts from a blank/current command
     * tail instead of auto-applying the persisted checkpoint. While this is set,
     * join-sync must not serve the old persisted base to later joiners, or that
     * stale base will be combined with the live session's new deltas.
     * Cleared by the next auto-checkpoint captured from the current live board.
     * @type {boolean}
     */
    this.joinCheckpointInvalidated = false;

    /**
     * Pins this live session's base-board decision (blank vs. adopted snapshot)
     * so every joiner in the session resolves the same one. Set on first
     * connect, cleared when the room empties. See beginSessionBase().
     * @type {Promise<Object|null>|null}
     */
    this._sessionBasePromise = null;

    /** @type {NodeJS.Timeout|null} Server-driven snapshot request interval */
    this._snapshotTimer = null;
    this._snapshotIntervalMs = 15000;

    /** @type {Set<number>} Session indices that were asked for a server-initiated snapshot */
    this._pendingSnapshotRequests = new Set();
    this._pendingSnapshotRequestTimers = new Map();
  }

  /**
   * Adds a snapshot to the rolling buffer.
   * @param {Object} snapshot - {id, ts, issuer, data, auto}
   */
  addSnapshot(snapshot) {
    this.snapshots.push(snapshot);
    if (this.snapshots.length > 24) {
      // Evict oldest, but never the highest-seq auto snapshot: it's the join
      // checkpoint base the stroke log is truncated against, and dropping it
      // while the log stays truncated would reopen the Issue 6 hole.
      const best = this._bestInMemoryAutoSnapshot();
      let evictIdx = 0;
      if (best && this.snapshots[0] === best) evictIdx = 1;
      this.snapshots.splice(evictIdx, 1);
    }
    if (snapshot?.auto && (Number(snapshot.seq) || 0) > 0 && Array.isArray(snapshot.layers) && snapshot.layers.length > 0) {
      this.joinCheckpointInvalidated = false;
    }
  }

  /**
   * The highest-seq in-memory auto snapshot that still carries layers — i.e. the
   * one a fresh joiner would actually be served as its checkpoint base. Selection
   * is by seq, NOT array/arrival order: a second client's auto-save can arrive
   * out of seq order, and serving the last-pushed (lower-seq) snapshot while the
   * log was already truncated to a higher seq drops the strokes in the gap
   * (Issue 6). DB/R2 is not consulted — this is the live rolling buffer only.
   * @returns {Object|null}
   * @private
   */
  _bestInMemoryAutoSnapshot() {
    let best = null;
    for (const s of this.snapshots) {
      if (s?.layers && s.layers.length > 0 && (!best || (Number(s.seq) || 0) > (Number(best.seq) || 0))) {
        best = s;
      }
    }
    return best;
  }

  /**
   * Id + seq of the join checkpoint base (the highest-seq servable auto snapshot),
   * or null. The stroke log must never be truncated past `seq` (Issue 6 invariant),
   * and a fresh join must be served exactly this snapshot.
   * @returns {{id: string, seq: number}|null}
   */
  getJoinCheckpointMeta() {
    const best = this._bestInMemoryAutoSnapshot();
    return best ? { id: best.id, seq: Number(best.seq) || 0 } : null;
  }

  /**
   * Mark the persisted checkpoint as unusable for the current live join base.
   * This happens when the first user in a room skips the persisted checkpoint and
   * begins from blank/current command replay. Later joiners must then replay from
   * seq 0 until a fresh auto-checkpoint is minted for this live state.
   */
  invalidateJoinCheckpoint() {
    this.joinCheckpointInvalidated = true;
  }

  /**
   * Cheap, synchronous check for an in-memory join checkpoint (an auto-snapshot
   * carrying layers) a joiner could adopt. Does NOT touch DB/R2 — it reflects
   * the live rolling buffer only, which is exactly what isolated-room solo-join
   * verification needs to tell "correctly skipped an existing checkpoint" apart
   * from "none existed" (see docs/0000Sync_Issues.md, Issue 4).
   * @returns {boolean}
   */
  hasInMemoryJoinCheckpoint() {
    if (this.joinCheckpointInvalidated) return false;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const s = this.snapshots[i];
      if (s?.auto && s.layers && s.layers.length > 0) return true;
    }
    return false;
  }

  /**
   * Mark that the current live room session began without adopting the persisted
   * checkpoint. This is set as soon as the first client connects, before the
   * client's later SYNC_REQUEST, so a fast second joiner cannot race in and use
   * the stale persisted base.
   */
  beginBlankJoinSession() {
    if (this.joinCheckpointInvalidated) return;
    this.invalidateJoinCheckpoint();
    this.strokeLog?.clear?.();
    this.strokeTape?.clear?.();
    this.history?.clear?.();
    this.clearAllTiles?.();
  }

  /**
   * Register this session's ORIGIN anchor on the history archive: what the
   * board looked like at seq 0.
   *
   * Without it the commits retired by a room's FIRST checkpoint had no image
   * before them, so the archive could not serve them and history only started
   * working from the second checkpoint (~30s in). A room starts blank, and an
   * adopted snapshot is deliberately re-stamped at seq 0 (see
   * _adoptPersistedBase) — either way seq 0 is a real, servable base.
   *
   * Called from beginSessionBase, which runs exactly once per session.
   * beginBlankJoinSession is the wrong home for it: it early-returns when the
   * room is already flagged invalidated, which is precisely the state
   * resetJoinSyncState leaves behind, so a room's second session would silently
   * get no origin at all.
   *
   * @param {{id: string}|null} base - Adopted snapshot, or null for a blank start.
   * @private
   */
  _registerHistoryOrigin(base) {
    if (!this.history) return;
    // Stamped at session start rather than the snapshot's own timestamp, which
    // can be days old — the archive prunes anchors by ts.
    if (base?.id) this.history.addAnchor({ id: base.id, seq: 0, ts: Date.now() });
    else this.history.addAnchor({ seq: 0, ts: Date.now(), blank: true });
  }

  /**
   * Decide (once) what the board looks like for the session that is just
   * starting, and pin that decision before anyone can ask for it.
   *
   * Called synchronously the moment the first client connects — well before
   * their SYNC_REQUEST — so a second client racing in during the async R2/DB
   * fetch waits on the same promise and is served the same base. Without that
   * pin the two joiners could disagree about whether the room starts blank.
   *
   * `loadSnapshotOnFirstJoin` on (default): adopt the room's last persisted
   * snapshot as this session's base. Off: the historical behaviour — start
   * from a blank canvas and the live command tail only.
   *
   * @returns {Promise<Object|null>} the adopted base snapshot, or null
   */
  beginSessionBase() {
    if (this._sessionBasePromise) return this._sessionBasePromise;

    if (this.settings.loadSnapshotOnFirstJoin === false || !this.canPersistSnapshots()) {
      this.beginBlankJoinSession();
      this._registerHistoryOrigin(null);
      this._sessionBasePromise = Promise.resolve(null);
      return this._sessionBasePromise;
    }

    this._sessionBasePromise = this._adoptPersistedBase().catch((err) => {
      console.error(`[Room] Failed to adopt persisted base for "${this.id}":`, err);
      // Never leave the session in limbo: fall back to the blank start.
      this.beginBlankJoinSession();
      return null;
    }).then((base) => {
      // Covers all three outcomes — adopted, cold-room blank, failed-and-blank.
      this._registerHistoryOrigin(base);
      return base;
    });
    return this._sessionBasePromise;
  }

  /**
   * Load the last persisted snapshot and register it as this session's join
   * checkpoint.
   *
   * Re-stamped at **seq 0** on purpose. A non-lobby Room object is destroyed
   * when it empties, so `messageSequence` restarts at 0 for the new session
   * while the persisted doc still carries the old session's (much higher)
   * watermark. Serving it at its stored seq would put the base above every
   * stroke of the new session, and later joiners would get the image with an
   * empty tail — the new work invisible. At seq 0 the image is pure base and
   * the whole live tail replays on top, which is what we want.
   *
   * @returns {Promise<Object|null>}
   * @private
   */
  async _adoptPersistedBase() {
    // A pinned start state wins over the room's newest snapshot; without it (or
    // if the pinned image has since been deleted) fall back to the newest.
    // forJoin:false deliberately — `joinCheckpointInvalidated` is set when the
    // room empties, and this call is precisely the decision to un-invalidate it.
    const pinned = this.settings.startSnapshotId
      ? await this.getSnapshotDataById(this.settings.startSnapshotId)
      : null;
    const persisted = pinned || await this.getLatestSnapshotData({ forJoin: false });
    if (!persisted || !Array.isArray(persisted.layers) || persisted.layers.length === 0) {
      // Nothing to adopt (cold room) — a blank start, same as the setting off.
      this.beginBlankJoinSession();
      return null;
    }

    // Cleared start state: everything from before the clear is disregarded, so
    // the room opens blank until someone draws (the next snapshot is newer than
    // the watermark and takes over on its own). A pin outranks the clear.
    const clearedTs = Number(this.settings.startSnapshotClearedTs) || 0;
    if (!pinned && clearedTs && Number(persisted.ts || 0) <= clearedTs) {
      console.log(`[Room] "${this.id}" start state was cleared; opening blank`);
      this.beginBlankJoinSession();
      return null;
    }

    const base = {
      id: persisted.id,
      ts: persisted.ts,
      issuer: persisted.issuer,
      layers: persisted.layers,
      seq: 0,
      auto: true,
    };
    this.addSnapshot(base);
    this.joinCheckpointInvalidated = false;
    console.log(`[Room] "${this.id}" session adopted ${pinned ? 'pinned' : 'persisted'} snapshot ${base.id} as its base`);
    return base;
  }

  /**
   * Drop automatic join-sync state when the room becomes logically empty. The
   * next live session should not inherit an old checkpoint image or old command
   * tail; a lone user can still explicitly load saved snapshots from history.
   */
  resetJoinSyncState() {
    this.invalidateJoinCheckpoint();
    this.strokeLog?.clear?.();
    this.strokeTape?.clear?.();
    this.history?.clear?.();
    this.clearAllTiles?.();
    this.snapshots = this.snapshots.filter(s => !s?.auto);
    // The next session re-decides its base from scratch (the room object often
    // survives an empty spell — lobby always does).
    this._sessionBasePromise = null;
  }

  /**
   * Returns whether the room is registered and eligible for persisted snapshots.
   * @returns {boolean}
   */
  isRegistered() {
    return !!this.ownerId;
  }

  /**
   * Returns whether this room should persist and serve board snapshots.
   * The public lobby is intentionally snapshot-backed even though it has no owner.
   * @returns {boolean}
   */
  canPersistSnapshots() {
    return this.isRegistered() || this.id === 'lobby';
  }

  /**
   * Starts the periodic snapshot request timer.
   * Called when any user joins the room.
   */
  startSnapshotTimer() {
    if (this._snapshotTimer) return;
    this._snapshotTimer = setInterval(() => this._requestSnapshot(), this._snapshotIntervalMs);
  }

  /**
   * Stops the snapshot request timer.
   * Called when no users remain in the room.
   */
  stopSnapshotTimer() {
    if (!this._snapshotTimer) return;
    clearInterval(this._snapshotTimer);
    this._snapshotTimer = null;
    for (const timer of this._pendingSnapshotRequestTimers.values()) clearTimeout(timer);
    this._pendingSnapshotRequestTimers.clear();
    this._pendingSnapshotRequests.clear();
  }

  /**
   * Checks if the snapshot timer should be running based on current clients.
   *
   * Runs for every room, not just persist-eligible ones: the periodic
   * snapshot is what advances the in-memory join/resync watermark
   * (addSnapshot in handleSnapshotSave), independent of whether the result
   * ever reaches DB/R2. An unregistered room that never checkpoints has no
   * way to bound its command-log tail, so a resync after any real amount of
   * activity has to replay the whole session from seq 0.
   */
  updateSnapshotTimer() {
    const hasClients = this._getSnapshotCandidates().length > 0;
    const shouldRun = hasClients;
    if (shouldRun && !this._snapshotTimer) {
      this.startSnapshotTimer();
    } else if (!shouldRun && this._snapshotTimer) {
      this.stopSnapshotTimer();
    }
  }

  /**
   * Returns all open clients as snapshot candidates, scored and sorted best-first.
   * Any connected user can be asked for a snapshot — not just Helper+.
   * @returns {WebSocket[]}
   * @private
   */
  _getSnapshotCandidates() {
    const candidates = [];
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        candidates.push(ws);
      }
    }
    return candidates;
  }

  /**
   * Picks the best-scoring connected client and sends a snapshot request.
   *
   * Not gated on canPersistSnapshots() — see updateSnapshotTimer(). The reply
   * still lands in handleSnapshotSave, which is where DB/R2 persistence is
   * actually decided.
   * @private
   */
  _requestSnapshot() {
    // A socket joins this.clients at handshake, BEFORE its T.CONNECT allocates a
    // sessionIndex. Asking one is a wasted cycle: markSnapshotRequestPending
    // can't record a non-finite index, so the reply fails the isServerRequested
    // check in handleSnapshotSave and gets dropped by the manual-save gate.
    const candidates = this._getSnapshotCandidates()
      .filter((ws) => Number.isFinite(Number(ws.sessionIndex)));
    if (candidates.length === 0) return;

    const ranked = candidates
      .map((ws) => ({
        ws,
        score: scoreProvider(ws, this.sessionManager.getUser(ws.sessionIndex))
      }))
      .sort((a, b) => b.score - a.score);

    const chosen = ranked[0]?.ws;
    if (!chosen) return;

    this.markSnapshotRequestPending(chosen.sessionIndex);
    this.sendTo(chosen, { t: T.BOARD_SNAPSHOT_REQUEST });
  }

  markSnapshotRequestPending(sessionIndex) {
    const idx = Number(sessionIndex);
    if (!Number.isFinite(idx)) return;

    this._pendingSnapshotRequests.add(idx);
    const existing = this._pendingSnapshotRequestTimers.get(idx);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._pendingSnapshotRequests.delete(idx);
      this._pendingSnapshotRequestTimers.delete(idx);
    }, Math.max(this._snapshotIntervalMs * 2, 30000));
    this._pendingSnapshotRequestTimers.set(idx, timer);
  }

  clearPendingSnapshotRequest(sessionIndex) {
    const idx = Number(sessionIndex);
    if (!Number.isFinite(idx)) return false;

    const wasPending = this._pendingSnapshotRequests.delete(idx);
    const timer = this._pendingSnapshotRequestTimers.get(idx);
    if (timer) clearTimeout(timer);
    this._pendingSnapshotRequestTimers.delete(idx);
    return wasPending;
  }

  /**
   * Marks tiles as occupied.
   * @param {number} userId - Unused; kept for signature compatibility
   * @param {Array<number>} tileIndices - Array of tile indices.
   */
  markTilesDirty(userId, tileIndices) {
    if (!tileIndices || !Array.isArray(tileIndices)) return;
    for (const idx of tileIndices) {
      this.tileDirtySet.add(idx);
    }
  }

  /**
   * Clears tiles from the dirty set.
   * @param {Array<number>} tileIndices - Array of tile indices to clear.
   */
  clearTiles(tileIndices) {
    if (!tileIndices || !Array.isArray(tileIndices)) return;
    for (const idx of tileIndices) {
      this.tileDirtySet.delete(idx);
    }
  }

  /**
   * Gets the full list of occupied tiles for sync.
   * @returns {Array<number>}
   */
  getDirtyTilesForSync() {
    return Array.from(this.tileDirtySet);
  }

  /**
   * Reset all tile data.
   */
  clearAllTiles() {
    this.tileDirtySet.clear();
  }

  /**
   * Fetches the most recent snapshot data, checking in-memory buffer then DB/R2.
   * `seq` is the applied-seq watermark the capture represents (the checkpoint
   * seq S): the in-memory auto-snapshots carry it; the DB fallback has none
   * persisted, so it returns 0 (the joiner then replays the full retained tail,
   * which is empty after a fresh server restart anyway).
   * @param {{forJoin?: boolean}} [options]
   * @returns {Promise<{id: string, ts: number, issuer: string, layers: Array, seq: number}|null>}
   */
  async getLatestSnapshotData(options = {}) {
    if (options.forJoin && this.joinCheckpointInvalidated) {
      return null;
    }

    // Check in-memory rolling buffer first. Select by highest seq (NOT array
    // order): an out-of-order, lower-seq auto-save must not shadow a higher-seq
    // one the log was already truncated to (Issue 6).
    const best = this._bestInMemoryAutoSnapshot();
    if (best) {
      return { id: best.id, ts: best.ts, issuer: best.issuer, layers: best.layers, seq: Number(best.seq) || 0 };
    }

    // Fall back to DB/R2
    const db = getDB();
    if (!db) return null;

    try {
      const doc = await db.collection('room_snapshots').findOne(
        { roomId: this.id, r2Key: { $ne: null } },
        { sort: { timestamp: -1 } }
      );
      if (!doc || !doc.r2Key) return null;

      const fileBytes = await getSnapshotFile(doc.r2Key);
      if (!fileBytes) return null;
      const bundle = await decodeSnapshotFile(fileBytes, doc.format);
      return { id: doc.snapshotId, ts: doc.timestamp, issuer: doc.issuer, layers: bundle.layers, seq: doc.seq || 0 };
    } catch (err) {
      console.error(`[Room] Failed to fetch latest snapshot for "${this.id}":`, err);
      return null;
    }
  }

  /**
   * Loads one specific persisted snapshot's layer data by id, scoped to this
   * room. Used by the pinned start state — unlike getLatestSnapshotData it
   * never consults the in-memory rolling buffer, because a pin names a
   * persisted image and the buffer only holds this session's captures.
   * @param {string} snapshotId
   * @returns {Promise<{id: string, ts: number, issuer: string, layers: Array, seq: number}|null>}
   */
  async getSnapshotDataById(snapshotId) {
    if (!snapshotId) return null;
    const db = getDB();
    if (!db) return null;

    try {
      const doc = await db.collection('room_snapshots').findOne({ roomId: this.id, snapshotId });
      if (!doc || !doc.r2Key) return null;

      const fileBytes = await getSnapshotFile(doc.r2Key);
      if (!fileBytes) return null;
      const bundle = await decodeSnapshotFile(fileBytes, doc.format);
      if (!Array.isArray(bundle?.layers) || bundle.layers.length === 0) return null;
      return { id: doc.snapshotId, ts: doc.timestamp, issuer: doc.issuer, layers: bundle.layers, seq: doc.seq || 0 };
    } catch (err) {
      console.error(`[Room] Failed to fetch pinned snapshot ${snapshotId} for "${this.id}":`, err);
      return null;
    }
  }

  /**
   * Called when all users in the room have been AFK for the configured delay.
   * Restores the last snapshot to reset the canvas to a known good state.
   * @private
   */
  async _onAllUsersAfk() {
    if (!this.canPersistSnapshots()) return;
    console.log(`[Room] All users AFK in "${this.id}", restoring last snapshot`);

    const snapshot = await this.getLatestSnapshotData({ forJoin: true });
    if (!snapshot) {
      console.log(`[Room] No snapshot available for "${this.id}", skipping restore`);
      return;
    }

    // Sequenced broadcast (Bug A) so the AFK auto-restore lands at a fixed
    // seq for everyone. broadcastSequencedRestore is wired by index.js on join;
    // fall back to the immediate broadcast if it isn't present.
    const broadcastRestore = this.broadcastSequencedRestore
      ? this.broadcastSequencedRestore
      : this.broadcastToAll.bind(this);
    broadcastRestore({
      t: T.BOARD_SNAPSHOT_RESTORE,
      snapshotLayers: snapshot.layers,
      snapshotId: snapshot.id,
      snapshotTs: snapshot.ts,
      snapshotIssuer: 'server'
    });
    if (snapshotCoversRoomBoard(snapshot.layers, this)) {
      this.clearAllTiles();
    }
    console.log(`[Room] Restored snapshot ${snapshot.id} to all users in "${this.id}"`);
  }

  /**
   * Lazy loads the room document from the database if it exists.
   * Does not create unregistered rooms; they are only persisted when explicitly registered.
   * @returns {Promise<void>}
   */
  async ensureLoaded() {
    if (this.dbLoaded) return;

    const db = getDB();
    if (!db) {
      this.dbLoaded = true;
      return;
    }

    try {
      const doc = await db.collection('rooms').findOne(
        { _id: this.id },
        {
          projection: {
            description: 1,
            ownerId: 1,
            ownerUsername: 1,
            createdAt: 1,
            settings: 1
          }
        }
      );

      if (doc) {
        this.description = doc.description || '';
        this.ownerId = doc.ownerId || null;
        this.ownerUsername = doc.ownerUsername || null;
        this.createdAt = doc.createdAt ? doc.createdAt.getTime() : this.createdAt;
        this.settings.locked = doc.settings?.locked || false;
        this.settings.maxUsers = doc.settings?.maxUsers !== undefined ? doc.settings.maxUsers : 40;
        this.settings.backgroundColor = doc.settings?.backgroundColor || '#ffffff';
        this.settings.modInactiveImmune = !!doc.settings?.modInactiveImmune;
        this.settings.joinPolicy = doc.settings?.joinPolicy || 'open';
        this.settings.obscureRequiresRegistered = !!doc.settings?.obscureRequiresRegistered;
        this.settings.autoMuteGuests = !!doc.settings?.autoMuteGuests;
        this.settings.autoMuteVpnUsers = !!doc.settings?.autoMuteVpnUsers;
        this.settings.hideChatNotifications = !!doc.settings?.hideChatNotifications;
        // Absent in rooms saved before this setting existed — default on.
        this.settings.loadSnapshotOnFirstJoin = doc.settings?.loadSnapshotOnFirstJoin !== false;
        this.settings.startSnapshotId = typeof doc.settings?.startSnapshotId === 'string' && doc.settings.startSnapshotId
          ? doc.settings.startSnapshotId
          : null;
        this.settings.startSnapshotClearedTs = Number.isFinite(doc.settings?.startSnapshotClearedTs)
          ? Math.max(0, Math.floor(doc.settings.startSnapshotClearedTs))
          : 0;
        this.settings.mirrorRegions = Array.isArray(doc.settings?.mirrorRegions) ? doc.settings.mirrorRegions : [];
        this.settings.dedicatedReplayUser = doc.settings?.dedicatedReplayUser || null;
        this.settings.textOverlayLifetimeMs = Number.isFinite(doc.settings?.textOverlayLifetimeMs)
          ? Math.max(5000, Math.min(30 * 60 * 1000, Math.floor(doc.settings.textOverlayLifetimeMs)))
          : this.settings.textOverlayLifetimeMs;
        this.settings.private = !!doc.settings?.private;
        this.settings.floatingGallerySeed = Number.isFinite(doc.settings?.floatingGallerySeed)
          ? doc.settings.floatingGallerySeed
          : this.settings.floatingGallerySeed;
        this.settings.floatingGalleryIncludeIds = Array.isArray(doc.settings?.floatingGalleryIncludeIds)
          ? doc.settings.floatingGalleryIncludeIds.filter(id => typeof id === 'string')
          : [];
        this.settings.floatingGalleryExcludeIds = Array.isArray(doc.settings?.floatingGalleryExcludeIds)
          ? doc.settings.floatingGalleryExcludeIds.filter(id => typeof id === 'string')
          : [];
        const loadedFloatingGalleryVoronoi = doc.settings?.floatingGalleryVoronoi &&
          doc.settings.floatingGalleryVoronoi.seed === this.settings.floatingGallerySeed
          ? doc.settings.floatingGalleryVoronoi
          : null;
        this.settings.floatingGalleryVoronoi = loadedFloatingGalleryVoronoi ||
          generateFloatingGalleryVoronoi(this.settings.floatingGallerySeed);
        if (!loadedFloatingGalleryVoronoi) {
          await db.collection('rooms').updateOne(
            { _id: this.id },
            { $set: { 'settings.floatingGalleryVoronoi': this.settings.floatingGalleryVoronoi } }
          );
        }
        this.settings.boardSize = isValidBoardSize(doc.settings?.boardSize)
          ? doc.settings.boardSize
          : '1080p';
        this.settings.tiledCanvasBackingStore = !!doc.settings?.tiledCanvasBackingStore;
        console.log(`[Room] Loaded "${this.id}" from DB`);
      }

      this.dbLoaded = true;
    } catch (err) {
      console.error(`[Room] DB load error for "${this.id}":`, err);
      this.dbLoaded = true;
    }
  }

  /**
   * Saves the current room metadata and settings to the database.
   * Creates the room document if it doesn't exist (upsert mode).
   * @returns {Promise<void>}
   */
  async saveToDB() {
    const db = getDB();
    if (!db) return;

    try {
      await db.collection('rooms').updateOne(
        { _id: this.id },
        {
          $set: {
            description: this.description,
            ownerId: this.ownerId,
            ownerUsername: this.ownerUsername,
            lastActiveAt: new Date(),
            settings: {
              locked: this.settings.locked,
              maxUsers: this.settings.maxUsers,
              backgroundColor: this.settings.backgroundColor,
              modInactiveImmune: this.settings.modInactiveImmune,
              joinPolicy: this.settings.joinPolicy,
              obscureRequiresRegistered: this.settings.obscureRequiresRegistered,
              autoMuteGuests: this.settings.autoMuteGuests,
              autoMuteVpnUsers: this.settings.autoMuteVpnUsers,
              hideChatNotifications: this.settings.hideChatNotifications,
              loadSnapshotOnFirstJoin: this.settings.loadSnapshotOnFirstJoin,
              startSnapshotId: this.settings.startSnapshotId || null,
              startSnapshotClearedTs: this.settings.startSnapshotClearedTs || 0,
              textOverlayLifetimeMs: this.settings.textOverlayLifetimeMs,
              mirrorRegions: this.settings.mirrorRegions,
              dedicatedReplayUser: this.settings.dedicatedReplayUser,
              private: this.settings.private,
              floatingGallerySeed: this.settings.floatingGallerySeed,
              floatingGalleryIncludeIds: this.settings.floatingGalleryIncludeIds,
              floatingGalleryExcludeIds: this.settings.floatingGalleryExcludeIds,
              floatingGalleryVoronoi: this.settings.floatingGalleryVoronoi || generateFloatingGalleryVoronoi(this.settings.floatingGallerySeed),
              boardSize: this.settings.boardSize,
              tiledCanvasBackingStore: !!this.settings.tiledCanvasBackingStore
            }
          },
          $setOnInsert: {
            createdAt: new Date(),
            roles: []
          }
        },
        { upsert: true }
      );
    } catch (err) {
      console.error(`[Room] Save error for "${this.id}":`, err);
    }
  }

  /**
   * Updates the room preview image.
   * @param {Buffer|null} previewData - PNG image data at 1/4 scale, or null to clear
   */
  setPreview(previewData) {
    this.preview = previewData;
    this.previewUpdatedAt = Date.now();
    this.lastActivity = Date.now();
  }

  /**
   * Returns the number of clients currently in the room.
   * @returns {number} - The client count.
   */
  getClientCount() {
    return this.clients.size;
  }

  /**
   * Adds a WebSocket client to the room.
   * @param {WebSocket} ws - The WebSocket client to add.
   */
  addClient(ws) {
    this.clients.add(ws);
    ws.roomId = this.id;
  }

  /**
   * Removes a WebSocket client from the room.
   * @param {WebSocket} ws - The WebSocket client to remove.
   */
  removeClient(ws) {
    this.clients.delete(ws);
  }

  /**
   * Broadcasts a payload to all clients in the room.
   * @param {Object} payload - The message payload to broadcast.
   */
  broadcastToAll(payload) {
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        this.sendTo(client, payload);
      }
    });
  }
}

/**
 * Manages the collection of active rooms.
 */
export class RoomManager {
  /**
   * @param {WebSocketServer} wss - The WebSocket server instance.
   * @param {function} sendTo - Callback function to send messages to a specific client.
   */
  constructor(wss, sendTo) {
    this.wss = wss;
    this.sendTo = sendTo;
    this.rooms = new Map();
    this.invalidatedJoinCheckpointRooms = new Set();
    this.Msg = null;
    this.createRoomBroadcaster = null;
  }

  /**
   * Configures the protobuf encoder and room broadcaster factory.
   * @param {Object} Msg - The protobuf message type.
   * @param {function} createRoomBroadcaster - Factory function for room broadcasters.
   */
  setMsgEncoder(Msg, createRoomBroadcaster) {
    this.Msg = Msg;
    this.createRoomBroadcaster = createRoomBroadcaster;
  }

  /**
   * Retrieves an existing room or creates a new one if it doesn't exist.
   * @param {string} roomId - The ID of the room.
   * @returns {Room} - The room instance.
   */
  getOrCreateRoom(roomId) {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId);
    }

    const room = new Room(roomId, this.Msg, this.sendTo);
    if (this.invalidatedJoinCheckpointRooms.has(roomId)) {
      room.joinCheckpointInvalidated = true;
    }
    this.rooms.set(roomId, room);
    console.log(`[RoomManager] Created room: ${roomId}`);
    return room;
  }

  markJoinCheckpointInvalidated(roomId) {
    if (roomId) this.invalidatedJoinCheckpointRooms.add(roomId);
  }

  /**
   * Finds the room associated with a specific WebSocket client.
   * @param {WebSocket} ws - The WebSocket client.
   * @returns {Room|null} - The room instance or null if not found.
   */
  getRoomByClient(ws) {
    const roomId = ws.roomId;
    if (!roomId) return null;
    return this.rooms.get(roomId);
  }

  /**
   * Removes a client from their current room.
   * @param {WebSocket} ws - The WebSocket client to remove.
   */
  removeClient(ws) {
    const room = this.getRoomByClient(ws);
    if (room) {
      room.removeClient(ws);
    }
  }

  /**
   * Returns a list of all active public rooms.
   * @param {boolean} [includePreview=true] - Whether to include preview images
   * @returns {Array<Object>} - A list of room summary objects.
   */
  getRoomList(includePreview = true) {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.id === '_discovery') continue;
      if (room.settings.private) continue;
      const roomInfo = {
        id: room.id,
        description: room.description || '',
        userCount: room.getClientCount(),
        locked: room.settings.locked,
        hasPassword: false,
        backgroundColor: room.settings.backgroundColor || '#ffffff',
        ownerId: room.ownerId || '',
        ownerUsername: room.ownerUsername || ''
      };
      if (includePreview && room.preview) {
        roomInfo.preview = room.preview;
      }
      list.push(roomInfo);
    }
    return list;
  }

  /**
   * Broadcasts an updated room list to discovery clients.
   */
  broadcastRoomListUpdate() {
    if (!this.Msg) return;

    const payload = {
      t: T.ROOM_LIST_RESPONSE,
      rooms: this.getRoomList().map(r => ({
        id: r.id,
        userCount: r.userCount,
        locked: r.locked,
        hasPassword: r.hasPassword,
        description: r.description || '',
        backgroundColor: r.backgroundColor || '#ffffff',
        ownerId: r.ownerId || '',
        ownerUsername: r.ownerUsername || '',
        preview: r.preview || null
      }))
    };

    const discoveryRooms = ['lobby', '_discovery'];
    for (const roomId of discoveryRooms) {
      const room = this.rooms.get(roomId);
      if (room) {
        room.broadcastToAll(payload);
      }
    }
  }

  /**
   * Cleans up empty rooms from the manager, excluding lobby and discovery rooms.
   */
  cleanupEmptyRooms() {
    for (const [id, room] of this.rooms) {
      if (id === 'lobby' || id === '_discovery') continue;
      if (room.getClientCount() !== 0) continue;
      // A room with users still inside the disconnect grace window is not
      // really empty — finalizing it would invalidate their sessionIndex
      // and prevent a clean resume.
      if (room.pendingDisconnects?.size) continue;
      room.stopSnapshotTimer();
      // Tear down sub-managers so their timers/intervals don't keep the
      // Room object alive after it's been dropped from the registry.
      room.sessionManager?.destroy?.();
      this.rooms.delete(id);
      console.log(`[RoomManager] Cleaned up empty room: ${id}`);
    }
  }
}
