/** @fileoverview Manages board snapshots and server communication. */

import { T } from '../../shared/MessageTypes.js';

export class SnapshotManager {
  /**
   * @param {DrawingApp} app - The main application instance
   */
  constructor(app) {
    this.app = app;
    this.snapshots = []; // Locally cached list (metadata only)
    this.lastSnapshotHash = null; // To avoid uploading identical snapshots
    this.snapshotPageSize = 20;
    this.lastListAppend = false;
    this.hasMoreSnapshots = true;
    this._snapshotEncodeWorker = null;
    this._snapshotEncodePromises = new Map();
    this._snapshotEncodeMsgId = 1;
    this._autoSnapshotInFlight = false;
    this._autoSnapshotQueued = false;
  }

  /**
   * Called when the server requests this client to capture a snapshot.
   * Captures board + generates lossy 1/3 scale JPEG thumbnail.
   */
  async handleServerRequest() {
    if (!this.app.wsClient || !this.app.connected) return;
    if (this._autoSnapshotInFlight) {
      this._autoSnapshotQueued = true;
      return;
    }

    this._autoSnapshotInFlight = true;
    try {
      // Auto-snapshots are the room's join checkpoint: capture only the baked
      // (permanent) state and stamp the baked watermark seq. The undoable live
      // tail is left for the server to replay as commands, so joiners rebuild
      // those strokes as real records (preserving blend mode + undo/redo)
      // instead of receiving them baked-flat. Null = nothing baked yet → skip.
      const capture = await this._captureCheckpointPixels();
      if (!capture) return;

      const [encoded, thumbBytes] = await Promise.all([
        this._runWhenIdle(() => this._encodeSnapshotPixels(capture)),
        this._generateThumbnail(),
      ]);
      if (!encoded?.layers?.length) return;

      // Skip if board hasn't changed. Hashing happens in the encode worker so
      // the main thread only compares the final scalar.
      if (encoded.hash === this.lastSnapshotHash) return;
      this.lastSnapshotHash = encoded.hash;

      this._sendSnapshotSave({
        layers: encoded.layers,
        snapshotSeq: capture.snapshotSeq,
        thumbBytes,
        auto: true,
      });
    } catch (err) {
      console.warn('[SnapshotManager] Snapshot encode failed:', err);
    } finally {
      this._autoSnapshotInFlight = false;
      if (this._autoSnapshotQueued) {
        this._autoSnapshotQueued = false;
        setTimeout(() => this.handleServerRequest(), 0);
      }
    }
  }

  /**
   * Manually save a snapshot with a name.
   * @param {string} name
   */
  async saveSnapshot(name) {
    const capture = this._captureSnapshotPixels();
    if (!capture) return;

    try {
      const [encoded, thumbBytes] = await Promise.all([
        this._runWhenIdle(() => this._encodeSnapshotPixels(capture)),
        this._generateThumbnail(),
      ]);
      if (!encoded?.layers?.length) return;
      this.lastSnapshotHash = encoded.hash;

      this._sendSnapshotSave({
        layers: encoded.layers,
        snapshotSeq: capture.snapshotSeq,
        thumbBytes,
        name,
        auto: false,
      });
    } catch (err) {
      console.warn('[SnapshotManager] Manual snapshot encode failed:', err);
    }
  }

  /**
   * Capture the board exactly as it is now and pin that capture as the room's
   * start state (what an empty room comes back up on). A normal manual save
   * plus a pin flag, so the pinned image also shows up in snapshot history.
   * Owner/admin only — enforced server-side.
   * @returns {Promise<boolean>} whether a capture was sent
   */
  async saveAsRoomStartState() {
    const capture = this._captureSnapshotPixels();
    if (!capture) return false;

    try {
      const [encoded, thumbBytes] = await Promise.all([
        this._runWhenIdle(() => this._encodeSnapshotPixels(capture)),
        this._generateThumbnail(),
      ]);
      if (!encoded?.layers?.length) return false;
      this.lastSnapshotHash = encoded.hash;

      this._sendSnapshotSave({
        layers: encoded.layers,
        snapshotSeq: capture.snapshotSeq,
        thumbBytes,
        name: `Room start state ${new Date().toLocaleString()}`,
        auto: false,
        pin: true,
      });
      return true;
    } catch (err) {
      console.warn('[SnapshotManager] Start-state snapshot encode failed:', err);
      return false;
    }
  }

  /**
   * Ask the server which snapshot the room would come back up on.
   */
  requestRoomStartState() {
    this.app.wsClient?.send({ t: T.ROOM_START_SNAPSHOT_GET });
  }

  /**
   * Pin an existing snapshot as the room's start state.
   * @param {string} snapshotId
   */
  setRoomStartSnapshot(snapshotId = '') {
    this.app.wsClient?.send({ t: T.ROOM_START_SNAPSHOT_SET, snapshotId: snapshotId || '' });
  }

  /**
   * Clear the room's saved start state: it opens blank until something newer is
   * saved. Non-destructive — no snapshot is deleted, and the next snapshot taken
   * becomes the room's start state again.
   */
  clearRoomStartState() {
    this.app.wsClient?.send({ t: T.ROOM_START_SNAPSHOT_SET, snapshotId: '', roomStartSnapshotState: 3 });
  }

  /**
   * Go back to following the room's newest snapshot, undoing a pin or a clear.
   */
  followLatestRoomSnapshot() {
    this.app.wsClient?.send({ t: T.ROOM_START_SNAPSHOT_SET, snapshotId: '', roomStartSnapshotState: 1 });
  }

  /**
   * Request the list of snapshots from the server.
   */
  requestList({ beforeTs = 0, append = false } = {}) {
    this.lastListAppend = append;

    const msg = { t: T.BOARD_SNAPSHOT_LIST_REQUEST };
    if (beforeTs > 0) {
      msg.snapshotTs = beforeTs;
    }

    this.app.wsClient.send(msg);
  }

  clearListCache() {
    this.snapshots = [];
    this.lastListAppend = false;
    this.hasMoreSnapshots = true;
  }

  /**
   * Request restoration of a specific snapshot.
   * @param {string} id
   */
  restoreSnapshot(id) {
    this.app.wsClient.send({
      t: T.BOARD_SNAPSHOT_RESTORE,
      snapshotId: id
    });
  }

  /**
   * Broadcast a replay-rendered canvas as a room-wide board restore. The replay
   * output is flattened into layer 0 and transparent layers are sent for the
   * remaining groups, matching the existing local replay restore behavior while
   * letting the server sequence and relay the mutation to collaborators.
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<boolean>}
   */
  async broadcastReplayCanvasRestore(canvas) {
    if (!this.app.wsClient || !this.app.connected || !canvas) return false;
    const encoded = await this._encodeFlattenedCanvasLayers(canvas);
    if (!encoded?.layers?.length) return false;

    this.app.wsClient.send({
      t: T.BOARD_SNAPSHOT_RESTORE,
      snapshotLayers: encoded.layers
    });
    return true;
  }

  /**
   * Broadcast a replay-rendered canvas as a room-wide region restore. Layer 0
   * carries the flattened replay pixels and all upper layers carry transparent
   * images so receivers clear the restored region on every layer.
   * @param {HTMLCanvasElement} canvas
   * @param {{x:number,y:number,width:number,height:number}} region
   * @returns {Promise<boolean>}
   */
  async broadcastReplayRegionRestore(canvas, region) {
    if (!this.app.wsClient || !this.app.connected || !canvas || !region) return false;
    const encoded = await this._encodeFlattenedCanvasLayers(canvas);
    if (!encoded?.layers?.length) return false;

    const x = Math.max(0, Math.round(region.x));
    const y = Math.max(0, Math.round(region.y));
    const width = Math.max(0, Math.round(region.width));
    const height = Math.max(0, Math.round(region.height));
    if (width <= 0 || height <= 0) return false;

    this.app.wsClient.send({
      t: T.BOARD_SNAPSHOT_REGION_RESTORE,
      snapshotLayers: encoded.layers,
      a: false,
      sx: x,
      sy: y,
      sw: width,
      sh: height
    });
    return true;
  }

  /**
   * Request deletion of a specific snapshot.
   * @param {string} id
   */
  deleteSnapshot(id) {
    this.app.wsClient.send({
      t: T.BOARD_SNAPSHOT_DELETE,
      snapshotId: id
    });
  }

  /**
   * Generates a 1/3 scale JPEG thumbnail of the current board asynchronously.
   * @returns {Promise<Uint8Array|null>}
   * @private
   */
  async _generateThumbnail() {
    if (!this.app.board?.layerManager) return null;

    const srcCanvas = this.app.board.layerManager.getCompositedCanvas();
    const w = Math.round(srcCanvas.width / 3);
    const h = Math.round(srcCanvas.height / 3);

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = w;
    thumbCanvas.height = h;
    const ctx = thumbCanvas.getContext('2d');

    // Fill with room background color so transparency doesn't become black in JPEG
    const bg = this.app.board.backgroundColor;
    if (bg) {
      if (typeof bg === 'string') {
        ctx.fillStyle = bg;
      } else {
        ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      }
      ctx.fillRect(0, 0, w, h);
    }

    ctx.drawImage(srcCanvas, 0, 0, w, h);

    return new Promise((resolve) => {
      thumbCanvas.toBlob(async (blob) => {
        if (!blob) return resolve(null);
        const buffer = await blob.arrayBuffer();
        resolve(new Uint8Array(buffer));
      }, 'image/jpeg', 0.5);
    });
  }

  /**
   * Synchronously captures raw layer pixels and the seq watermark they represent.
   * The QOI encode is intentionally deferred to a worker.
   * @returns {{ width: number, height: number, layers: Uint8Array[], backgroundColor: *, snapshotSeq: number }|null}
   * @private
   */
  _captureSnapshotPixels() {
    const capture = this.app.board?.getSnapshotPixels?.();
    if (!capture?.layers?.length) return null;

    // getSnapshotPixels() is synchronous, so no websocket message can advance
    // lastProcessedSeq between the readback and this stamp.
    capture.snapshotSeq = this.app.wsClient?.lastProcessedSeq || 0;
    return capture;
  }

  /**
   * Captures the PERMANENT (baked) board state for the room checkpoint that
   * drives join-sync. Unlike a manual save, this excludes the still-undoable
   * live stroke tail and stamps the baked watermark seq, so the server replays
   * that tail as commands to joiners (keeping per-stroke blend mode + undo/redo).
   * Returns null when nothing is baked yet — the caller then skips the snapshot
   * and joiners replay the full command tail instead.
   * @returns {{ width: number, height: number, layers: Uint8Array[], backgroundColor: *, snapshotSeq: number }|null}
   * @private
   */
  async _captureCheckpointPixels() {
    // Async: the board spreads the per-layer pixel readback across frames to
    // avoid a capture stutter (see Board.getCheckpointSnapshotPixels). Returns
    // null if nothing is baked, or if a bake advanced the watermark mid-capture.
    const capture = await this.app.board?.getCheckpointSnapshotPixels?.();
    if (!capture?.layers?.length) return null;
    return capture; // snapshotSeq is the baked watermark, set by the board
  }

  _sendSnapshotSave({ layers, snapshotSeq, thumbBytes = null, name = null, auto = false, pin = false }) {
    if (!this.app.wsClient || !this.app.connected) return;

    const msg = {
      t: T.BOARD_SNAPSHOT_SAVE,
      snapshotLayers: layers,
      snapshotSeq,
      a: auto,
    };
    if (name) msg.n = name;
    if (pin) msg.snapshotPin = true;
    if (thumbBytes) msg.snapshotThumb = thumbBytes;

    this.app.wsClient.send(msg);
  }

  _runWhenIdle(callback) {
    return new Promise((resolve, reject) => {
      const run = () => {
        Promise.resolve()
          .then(callback)
          .then(resolve, reject);
      };

      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 2000 });
      } else {
        setTimeout(run, 0);
      }
    });
  }

  _getSnapshotEncodeWorker() {
    if (this._snapshotEncodeWorker) return this._snapshotEncodeWorker;

    const worker = new Worker(new URL('./snapshotEncodeWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, type, layers, hash, error } = event.data || {};
      const pending = this._snapshotEncodePromises.get(id);
      if (!pending) return;
      this._snapshotEncodePromises.delete(id);

      if (type === 'ENCODE_SNAPSHOT_ERROR') {
        pending.reject(new Error(error || 'Snapshot encode failed'));
      } else {
        pending.resolve({ layers, hash });
      }
    };
    worker.onerror = (event) => {
      const err = new Error(event?.message || 'Snapshot encode worker failed');
      for (const pending of this._snapshotEncodePromises.values()) pending.reject(err);
      this._snapshotEncodePromises.clear();
      this._snapshotEncodeWorker?.terminate?.();
      this._snapshotEncodeWorker = null;
    };

    this._snapshotEncodeWorker = worker;
    return worker;
  }

  _encodeSnapshotPixels(capture) {
    return new Promise((resolve, reject) => {
      const id = this._snapshotEncodeMsgId++;
      const worker = this._getSnapshotEncodeWorker();
      this._snapshotEncodePromises.set(id, { resolve, reject });

      try {
        worker.postMessage({
          id,
          type: 'ENCODE_SNAPSHOT',
          width: capture.width,
          height: capture.height,
          layers: capture.layers,
          backgroundColor: capture.backgroundColor,
          // Only transfer real layer buffers; empty (unused) layers are
          // zero-length and have nothing to hand off.
        }, capture.layers.map((layer) => layer.buffer).filter((buf) => buf.byteLength > 0));
      } catch (err) {
        this._snapshotEncodePromises.delete(id);
        reject(err);
      }
    });
  }

  async _encodeFlattenedCanvasLayers(canvas) {
    const board = this.app.board;
    const width = board?.getWidth?.() || canvas.width;
    const height = board?.getHeight?.() || canvas.height;
    if (!width || !height) return null;

    const flattened = document.createElement('canvas');
    flattened.width = width;
    flattened.height = height;
    const ctx = flattened.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(canvas, 0, 0, width, height);

    const layerCount = Math.max(1, board?.layerManager?.getLayerCount?.() || board?.layerManager?.layerGroups?.length || 1);
    const layers = [new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)];
    const transparentByteLength = width * height * 4;
    for (let i = 1; i < layerCount; i++) {
      layers.push(new Uint8Array(transparentByteLength));
    }

    return await this._runWhenIdle(() => this._encodeSnapshotPixels({
      width,
      height,
      layers,
      backgroundColor: board?.backgroundColor
    }));
  }

  /**
   * Simple hash for comparing multi-layer snapshots.
   * @param {Uint8Array[]} layers
   * @returns {number}
   * @private
   */
  _computeHashLayers(layers) {
    let hash = 0;
    for (const data of layers) {
      for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash) + data[i];
        hash |= 0;
      }
    }
    return hash;
  }
}
