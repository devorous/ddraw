/**
 * @fileoverview ReplayEngine - Accurate timeline playback using the real RemoteUserHandler.
 * Routes recorded actions through the same code path as live remote users,
 * ensuring pixel-perfect replay of all tools.
 */

import { User } from '../User.js';
import { T, ToolNames } from '../../shared/MessageTypes.js';
import { unpackColor } from '../../shared/ColorUtils.js';
import { RemoteUserHandler } from '../remote/RemoteUserHandler.js';
import { LayerManager } from '../canvas/LayerManager.js';
import { Board } from '../canvas/Board.js';
import { ToolManager } from '../tools/Tools.js';
import { getPreviewTextLayout, getUserTextLineHeight, paintTextRecord } from '../utils/textLayout.js';
import { getTextFontDefaults, getTextFontLetterSpacing } from '../config/textFonts.js';
import { drawReplayCursor } from '../replay/cursorOverlay.js';
import * as wasm from '../wasm/ddraw_wasm.js';
import { readQoiDimensions } from '../../shared/qoi.js';
import { qoiToCanvas } from '../replay/layerStateCodec.js';
import { normalizeBlendBakeMode } from '../../shared/blendBakeMode.js';
import {
  TEXT_OVERLAY_DEFAULT_LIFETIME_MS,
  TEXT_OVERLAY_DEFAULT_MIN_OPACITY,
  TEXT_OVERLAY_DEFAULT_FADE_MS
} from '../canvas/TextOverlay.js';

/** Hide a replay cursor after this much idle time relative to the playhead (ms). Mirrors live REMOTE_CURSOR_IDLE_MS. */
const REPLAY_CURSOR_IDLE_MS = 5000;

/**
 * Minimal board facade backed by a real LayerManager.
 * Provides the interface that RemoteUserHandler, RemotePenHandler,
 * RemoteInkHandler, and tool instances expect from Board.
 */
class ReplayBoard {
  constructor(width, height) {
    this.dimensions = [height, width];
    this.mirror = false;
    this.isReplay = true;
    this.backgroundColor = [255, 255, 255, 1];

    // Real offscreen canvases
    this.viewCanvas = document.createElement('canvas');
    this.viewCanvas.width = width;
    this.viewCanvas.height = height;
    this.viewCtx = this.viewCanvas.getContext('2d', { willReadFrequently: true });
    this._configureContext(this.viewCtx);

    this.topCanvas = document.createElement('canvas');
    this.topCanvas.width = width;
    this.topCanvas.height = height;
    this.topCtx = this.topCanvas.getContext('2d');
    this._configureContext(this.topCtx);

    this.upperLayersCanvas = document.createElement('canvas');
    this.upperLayersCanvas.width = width;
    this.upperLayersCanvas.height = height;
    this.upperLayersCtx = this.upperLayersCanvas.getContext('2d');
    this._configureContext(this.upperLayersCtx);

    // Real LayerManager for stroke management
    this.layerManager = new LayerManager(width, height);
    this.layerManager.onNeedsUpdate = () => {
      if (this._onLayerUpdate) this._onLayerUpdate();
    };

    // Stub tile tracking (not needed for replay)
    this.tileGrid = {
      isDirty: () => false,
      getDirtyRects: () => [],
      clear: () => {},
      markDirtyPath: () => {},
      markAllDirty: () => {}
    };
    this.tileTracker = null;

    this.activeSelectionLayer = -1;
    this.app = null;
    this.mirrorRegions = [];
    // Selection masks, mirroring the live Board's shape exactly (see
    // Board.setSelectionMask). Replay has no local user, so there is no
    // `selectionMask` overlay field here — only the per-user map that the clip
    // helpers read.
    this.selectionMasksByUser = new Map();
    this._maskClippedStrokes = new Set();
    this._needsComposite = false;
    this._dirtyRects = [];
    // Per-stroke composite dirty rects. Each endStroke() appends the freshly
    // committed stroke's bounds; compositeAllLayers() consumes + clears them.
    // When non-empty, compositeLayerRange clips to those rects instead of
    // clear+redrawing the whole canvas.
    this._compositeDirtyRects = [];
    // When true, the next compositeAllLayers() call must redraw the full
    // canvas (full rebuild path). Set by _runActionBatch on rebaseSnapshot.
    this._fullComposite = true;

    this.selectionOverlayPadding = 500;
    this.selectionOverlay = document.createElement('canvas');
    this.selectionOverlay.width = width + this.selectionOverlayPadding * 2;
    this.selectionOverlay.height = height + this.selectionOverlayPadding * 2;
    this.selectionCtx = this.selectionOverlay.getContext('2d');
    this.cursorsSvg = null;
    this.mirrorLine = null;
  }

  _configureContext(ctx) {
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  getWidth() { return this.dimensions[1]; }
  getHeight() { return this.dimensions[0]; }

  setMirror(m) { this.mirror = !!m; }

  setMirrorRegions(regions = []) {
    this.mirrorRegions = Array.isArray(regions)
      ? regions
        .map((region) => this._normalizeMirrorRegion(region))
        .filter(Boolean)
      : [];
  }

  // ── Selection mask ──────────────────────────────────────────────────────
  // RemoteUserHandler calls these on the live Board during MD/MM/MU, so replay
  // has to answer the same API or strokes never commit (a missing method throws
  // and _processAction's try/catch swallows it silently).
  //
  // These used to be no-op stubs, which meant the history/time-machine replayed
  // every masked stroke UNCLIPPED — the mask's own outline was never drawn and
  // the strokes ran straight past its edge, even though every live client had
  // clipped them. The logic below is the live Board's, verbatim apart from
  // having no local-overlay half: replay has no "self", only remote users.

  setSelectionMask(mask, userId) {
    if (!mask) {
      this.clearSelectionMask(userId);
      return;
    }
    this.selectionMasksByUser.set(userId, {
      x: mask.x, y: mask.y, width: mask.width, height: mask.height,
      lassoPath: mask.lassoPath ? [...mask.lassoPath] : null
    });
  }

  clearSelectionMask(userId) {
    this.selectionMasksByUser.delete(userId);
    // Unwind, don't just forget — same reason as Board.clearSelectionMask: the
    // stroke canvas came from LayerManager's pool and a save()+clip() with no
    // matching restore() rides it into the next stroke that acquires it.
    for (const key of [...this._maskClippedStrokes]) {
      const sep = key.lastIndexOf('_');
      if (sep < 0 || key.slice(sep + 1) !== String(userId)) continue;
      this.releaseSelectionMaskClipForStroke(Number(key.slice(0, sep)), userId);
      this._maskClippedStrokes.delete(key);
    }
  }

  /**
   * Forget which stroke contexts are mask-clipped, without touching the masks.
   * Same contract as Board.resetSelectionMaskClipTracking: call it wherever the
   * layer state those contexts live on is thrown away wholesale, or the stale
   * `${layer}_${user}` keys make applySelectionMaskClipForStroke return early
   * and the next stroke under a still-active mask goes unclipped.
   */
  resetSelectionMaskClipTracking() {
    this._maskClippedStrokes.clear();
  }

  /** Drop all mask state — used when the engine rebases onto a new baseline. */
  resetSelectionMasks() {
    for (const userId of [...this.selectionMasksByUser.keys()]) {
      this.clearSelectionMask(userId);
    }
    this.selectionMasksByUser.clear();
    this._maskClippedStrokes.clear();
  }

  _getSelectionMaskForUser(userId) {
    return this.selectionMasksByUser.get(userId) || null;
  }

  _applyMaskClipToCtx(ctx, userId) {
    const mask = this._getSelectionMaskForUser(userId);
    if (!mask || !ctx) return;
    // Shared with the live board so a masked stroke drawn inside a mirror
    // replays with the same reflected copies it had when it was drawn — see
    // Board.clipToMaskAndMirrors. `this` IS the replay board: it carries
    // mirror/mirrorRegions and the mirror helpers under the same names.
    Board.clipToMaskAndMirrors(ctx, mask, this);
  }

  // Mirrors Board.applySelectionMaskClipForStroke's windowing-aware fix
  // (docs/scope_layermanager_active_stroke_windowing_RESULT.md) — this is a
  // SEPARATE copy for the replay board (see the class-level note near
  // _getSelectionMaskForUser), so the fix has to be applied here too or a
  // windowed masked stroke replays unclipped. Confirmed via test:parity:
  // selection_mask_brush/lasso/preexisting failed (~54% replay match, ink
  // bbox ~2x too wide) before this was added here.
  applySelectionMaskClipForStroke(layerIndex, userId) {
    if (!this._getSelectionMaskForUser(userId) || !this.layerManager) return false;
    const key = `${layerIndex}_${userId}`;
    if (this._maskClippedStrokes.has(key)) return true;
    const ctx = this.layerManager.getUserStrokeContext(layerIndex, userId);
    if (!ctx) return false;
    const active = this.layerManager.getActiveStroke(layerIndex, userId);
    ctx.save();
    this._applyMaskClipAtOrigin(ctx, userId, active?.origin);
    this._maskClippedStrokes.add(key);
    this._registerMaskClipReapply(layerIndex, userId);
    return true;
  }

  _applyMaskClipAtOrigin(ctx, userId, origin) {
    const ox = origin?.x ?? 0;
    const oy = origin?.y ?? 0;
    if (ox || oy) ctx.translate(-ox, -oy);
    this._applyMaskClipToCtx(ctx, userId);
    if (ox || oy) ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  _registerMaskClipReapply(layerIndex, userId) {
    const active = this.layerManager?.getActiveStroke?.(layerIndex, userId);
    if (!active) return;
    active._reapplyMaskClip = (newCtx, newOrigin) => {
      newCtx.save();
      this._applyMaskClipAtOrigin(newCtx, userId, newOrigin);
    };
  }

  releaseSelectionMaskClipForStroke(layerIndex, userId) {
    const key = `${layerIndex}_${userId}`;
    if (!this._maskClippedStrokes.has(key) || !this.layerManager) return false;
    const ctx = this.layerManager.getActiveStroke(layerIndex, userId)?.ctx;
    if (ctx) ctx.restore();
    this._maskClippedStrokes.delete(key);
    return true;
  }

  withSelectionMaskClip(ctx, userId, drawFn) {
    if (!ctx || typeof drawFn !== 'function') return;
    if (!this._getSelectionMaskForUser(userId)) {
      drawFn();
      return;
    }
    ctx.save();
    this._applyMaskClipToCtx(ctx, userId);
    drawFn();
    ctx.restore();
  }
  getActiveMirrorRegions() {
    if (this.mirror) {
      return this._expandMirrorRegionTransforms({
        id: '__global_mirror__',
        x: 0,
        y: 0,
        width: this.getWidth(),
        height: this.getHeight(),
        mode: 'vertical',
        showLine: true,
        synthetic: true
      });
    }
    return (this.mirrorRegions || []).flatMap((region) => this._expandMirrorRegionTransforms(region));
  }
  renderMirrorRegions() {}

  // Stroke lifecycle — delegates to real LayerManager
  beginStroke(user, blendModeOverride) {
    if (user?.panning) return;
    const activeLayer = user?.activeLayer ?? 0;
    const userId = user?.id ?? 0;
    const blendMode = blendModeOverride ?? user?.blendMode ?? 'source-over';
    this.layerManager.beginUserStroke(activeLayer, userId, blendMode);
    // Bind the mask at stroke start, exactly as Board.beginStroke does.
    this.applySelectionMaskClipForStroke(activeLayer, userId);
  }

  beginStrokeAllLayers(user, blendMode) {
    if (user?.panning) return;
    const userId = user?.id ?? 0;
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      this.layerManager.beginUserStroke(i, userId, blendMode);
    }
    if (this._getSelectionMaskForUser(userId)) {
      for (let i = 0; i < count; i++) this.applySelectionMaskClipForStroke(i, userId);
    }
  }

  endStroke(user, extraProps = {}) {
    // Blur/glitch blur tools always create their stroke on layer 0
    const isBlurFilter = extraProps.filterType === 'blur' || extraProps.filterType === 'glitchBlur';
    const activeLayer = isBlurFilter ? 0 : (user?.activeLayer ?? 0);
    const userId = user?.id ?? 0;
    // Release BEFORE the commit: commitUserStroke drops the active-stroke entry,
    // after which the release can no longer reach the context to restore it.
    this.releaseSelectionMaskClipForStroke(activeLayer, userId);
    this.layerManager.commitUserStroke(activeLayer, userId, extraProps);
    this._captureCommittedDirtyRect(activeLayer, userId);
  }

  endStrokeAllLayers(user) {
    const userId = user?.id ?? 0;
    const batchTimestamp = Date.now();
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      this.releaseSelectionMaskClipForStroke(i, userId);
      this.layerManager.commitUserStroke(i, userId, { eraseAll: true, timestamp: batchTimestamp });
      this._captureCommittedDirtyRect(i, userId);
    }
  }

  /**
   * After a commit, pull the just-pushed stroke record's bounds out of the
   * LayerManager and append to the pending dirty-rect list. Safe no-op if the
   * commit produced no record (zero-area stroke, etc.).
   * @param {number} layerIndex
   * @param {number} userId
   * @private
   */
  _captureCommittedDirtyRect(layerIndex, userId) {
    if (this._fullComposite) return; // full composite already scheduled
    const group = this.layerManager?.layerGroups?.[layerIndex];
    if (!group) return;
    let record = null;
    if (group.flatStrokeRecords && group.flatStrokeRecords.length > 0) {
      const last = group.flatStrokeRecords[group.flatStrokeRecords.length - 1];
      if (last && last.userId === userId) record = last;
    }
    if (!record && group.strokeStack.length > 0) {
      const last = group.strokeStack[group.strokeStack.length - 1];
      if (last && last.userId === userId) record = last;
    }
    if (!record || !Number.isFinite(record.width) || !Number.isFinite(record.height)) return;
    if (record.width <= 0 || record.height <= 0) return;
    this._compositeDirtyRects.push({
      x: record.x,
      y: record.y,
      width: record.width,
      height: record.height,
    });
  }

  /**
   * Undo the most recent stroke for userId across all layers.
   * @param {number} _layerIndex - Unused; kept for compatibility
   * @param {number} userId - User ID
   */
  undo(_layerIndex, userId) {
    if (!this.layerManager) return;
    const batch = this.layerManager.undoLastStrokeGlobal(userId);

    if (batch) {
      this.layerManager._pushToRedoStack(userId, batch);
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          const rd = record.selectionRestoreData;
          const removedLiveErase = rd.eraseTimestamp !== undefined
            ? this._takeSelectionEraseStroke(rd.eraseUserId ?? userId, rd.eraseTimestamp)
            : null;
          if (removedLiveErase) {
            rd._redoEraseRecord = removedLiveErase;
          } else {
            this._applySelectionRestore(rd.snapshots);
          }
          break;
        }
      }
    }
    if (this.tileGrid) this.tileGrid.markAllDirty();
    this.clearTop();
  }

  /**
   * Redo the most recently undone stroke batch for userId.
   * @param {number} userId - User ID
   */
  redo(userId) {
    if (!this.layerManager) return;
    const redoStack = this.layerManager.redoStackByUser.get(userId);

    if (redoStack && redoStack.length > 0) {
      const batch = redoStack[redoStack.length - 1];
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          const rd = record.selectionRestoreData;
          if (rd._redoEraseRecord) {
            this._restoreSelectionEraseStroke(rd._redoEraseRecord);
            rd._redoEraseRecord = null;
          } else {
            this._applySelectionReErase(rd);
          }
          break;
        }
      }
    }
    this.layerManager.redoLastStroke(userId);
    if (this.tileGrid) this.tileGrid.markAllDirty();
    this.clearTop();
  }

  /**
   * Apply pixel snapshots back to baseCanvas
   * @param {Array} snapshots - Array of snapshot data
   * @private
   */
  _applySelectionRestore(snapshots) {
    if (!snapshots) return;
    const lm = this.layerManager;
    for (const { groupIdx, canvas, x, y } of snapshots) {
      const group = lm.layerGroups[groupIdx];
      if (!group) continue;
      lm.addToBaseBin(groupIdx, canvas, x, y, 'source-over');
    }
  }

  _takeSelectionEraseStroke(userId, eraseTimestamp) {
    const lm = this.layerManager;
    for (let groupIdx = 0; groupIdx < lm.layerGroups.length; groupIdx++) {
      const group = lm.layerGroups[groupIdx];
      for (let i = group.strokeStack.length - 1; i >= 0; i--) {
        const s = group.strokeStack[i];
        if (s.userId === userId && s.timestamp === eraseTimestamp && s.isSelectionErase) {
          group.strokeStack.splice(i, 1);
          const cnt = group.userStrokeCounts.get(userId) || 0;
          if (cnt > 0) group.userStrokeCounts.set(userId, cnt - 1);
          return { groupIdx, record: s };
        }
      }
    }
    return null;
  }

  _restoreSelectionEraseStroke(eraseStrokeEntry) {
    const lm = this.layerManager;
    const group = lm?.layerGroups?.[eraseStrokeEntry?.groupIdx];
    const record = eraseStrokeEntry?.record;
    if (!group || !record) return false;

    let insertIdx = group.strokeStack.length;
    for (let i = 0; i < group.strokeStack.length; i++) {
      if (group.strokeStack[i].timestamp > record.timestamp) {
        insertIdx = i;
        break;
      }
    }
    group.strokeStack.splice(insertIdx, 0, record);
    const cnt = group.userStrokeCounts.get(record.userId) || 0;
    group.userStrokeCounts.set(record.userId, cnt + 1);
    return true;
  }

  /**
   * Re-apply the erase to baseCanvas
   * @param {Object} restoreData - Selection restore data
   * @private
   */
  _applySelectionReErase(restoreData) {
    const lm = this.layerManager;
    const { snapshots, eraseS: s, eraseLassoPath: lassoPath } = restoreData;
    for (const { groupIdx } of snapshots) {
      const group = lm.layerGroups[groupIdx];
      if (!group) continue;

      const eraserCanvas = document.createElement('canvas');
      eraserCanvas.width = s.width;
      eraserCanvas.height = s.height;
      const eCtx = eraserCanvas.getContext('2d');
      eCtx.fillStyle = 'white';
      eCtx.fillRect(0, 0, s.width, s.height);

      lm.eraseFromAllBaseBins(groupIdx, eraserCanvas, s.x, s.y, lassoPath);
    }
  }

  getAllLayerContexts(userId) {
    const ctxs = [];
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      const ctx = this.layerManager.getUserStrokeContext(i, userId);
      if (ctx) ctxs.push(ctx);
    }
    return ctxs;
  }

  getLayerGroup(index) {
    return this.layerManager?.getLayerGroup(index);
  }

  getLayerContext(layerIndex, userId, createBlendMode = 'source-over') {
    return this.layerManager?.getLayerContext(layerIndex, userId, createBlendMode) ?? this.viewCtx;
  }

  // Dirty rect tracking — must update active stroke bounds or commits get discarded
  expandDirtyRect(user, x, y, width, height, layerIndex) {
    // Prefer the explicit layer the stroke was begun on (selection commit/stamp/
    // fill derive it from the message's `ly`). Replay bots default to a
    // different activeLayer than the author had, so falling back to
    // user.activeLayer here would target the wrong group's active stroke and the
    // commit would bake nothing.
    const activeLayer = layerIndex ?? user?.activeLayer ?? 0;
    const userId = user?.id ?? 0;
    const group = this.layerManager.layerGroups[activeLayer];
    if (!group) return;
    const active = group.activeStrokeByUser.get(userId);
    if (!active?.dirtyRect) return;
    this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);
  }

  expandDirtyRectAllLayers(user, x, y, width, height) {
    const userId = user?.id ?? 0;
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      const group = this.layerManager.layerGroups[i];
      if (!group) continue;
      const active = group.activeStrokeByUser.get(userId);
      if (!active?.dirtyRect) continue;
      this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);
    }
  }

  markDirtyPath(user, points, radius) {
    if (!points || points.length === 0) return;
    const activeLayer = user?.activeLayer ?? 0;
    const userId = user?.id ?? 0;
    const group = this.layerManager.layerGroups[activeLayer];
    if (!group) return;
    const active = group.activeStrokeByUser.get(userId);
    if (!active?.dirtyRect) return;
    for (const pt of points) {
      this.layerManager._expandDirtyRect(active.dirtyRect, pt.x - radius, pt.y - radius, radius * 2, radius * 2);
    }
  }

  checkErasedTilesByIndices() {}
  addOccupancyForVisibleTilesInRect() {}

  markCompositeFull() {
    this._fullComposite = true;
    this._compositeDirtyRects.length = 0;
    if (this.tileGrid?.markAllDirty) this.tileGrid.markAllDirty();
  }

  /**
   * Apply a recorded BOARD_SNAPSHOT_RESTORE during replay: wholesale-replace the
   * board with the captured per-layer QOI state. Mirrors the live
   * Board.restoreSnapshot (clear all strokes, paint each decoded layer onto its
   * baked canvas) so an "undo to here" replays as a board jump.
   * @param {Uint8Array[]} layerDatas
   */
  restoreSnapshot(layerDatas) {
    const lm = this.layerManager;
    if (!lm || !Array.isArray(layerDatas) || layerDatas.length === 0) return;

    // Wholesale replacement — drop every user's stroke/redo history so the
    // decoded pixels are the sole content (matches live full-board restore).
    lm.clearAll();
    // Every active stroke context went away with it, so the clip ledger's keys
    // now point at nothing — see resetSelectionMaskClipTracking. The live
    // Board.restoreSnapshot does the same thing at the same place.
    this.resetSelectionMaskClipTracking();

    for (let i = 0; i < layerDatas.length && i < lm.layerGroups.length; i++) {
      const qoi = layerDatas[i];
      if (!qoi || qoi.length === 0) continue;

      let pixels;
      try { pixels = wasm.qoi_decode(qoi); } catch { continue; }
      if (!pixels || pixels.length === 0) continue;

      const dims = readQoiDimensions(qoi);
      if (!dims || pixels.length !== dims.width * dims.height * 4) continue;

      const imageData = new ImageData(
        new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
        dims.width,
        dims.height
      );
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = dims.width;
      sourceCanvas.height = dims.height;
      sourceCanvas.getContext('2d').putImageData(imageData, 0, 0);

      const group = lm.layerGroups[i];
      if (group?.flatCanvas) {
        lm.restoreLayerFromSnapshot(i, sourceCanvas);
      } else {
        lm.addToBaseBin(i, sourceCanvas, 0, 0);
      }
    }

    this.markCompositeFull();
  }

  /**
   * Region variant of {@link restoreSnapshot}: revert only the recorded
   * rect/lasso region to the captured per-layer pixels, leaving the rest of the
   * replay board intact. Mirrors the live applyRegionRestore (see
   * SnapshotHandlers.js) so an "undo region to here" replays as a normal
   * timeline event — history before and after it stays intact.
   * @param {Uint8Array[]} layerDatas
   * @param {{isLasso?: boolean, sx?: number, sy?: number, sw?: number, sh?: number, lassoFlat?: number[]}} opts
   */
  restoreRegion(layerDatas, { isLasso = false, sx = 0, sy = 0, sw = 0, sh = 0, lassoFlat = [] } = {}) {
    const lm = this.layerManager;
    if (!lm || !Array.isArray(layerDatas) || layerDatas.length === 0) return;
    const [height, width] = this.dimensions;
    const rx = Number(sx) || 0;
    const ry = Number(sy) || 0;
    const rw = Number(sw) || 0;
    const rh = Number(sh) || 0;
    if (!isLasso && (rw <= 0 || rh <= 0)) return;

    const lassoPoints = [];
    for (let i = 0; i + 1 < lassoFlat.length; i += 2) {
      lassoPoints.push({ x: lassoFlat[i], y: lassoFlat[i + 1] });
    }
    const buildLassoPath = (ctx) => {
      if (lassoPoints.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
      for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
      ctx.closePath();
    };

    for (let i = 0; i < layerDatas.length && i < lm.layerGroups.length; i++) {
      const qoi = layerDatas[i];
      if (!qoi || qoi.length === 0) continue;

      let pixels;
      try { pixels = wasm.qoi_decode(qoi); } catch { continue; }
      if (!pixels || pixels.length === 0) continue;

      const dims = readQoiDimensions(qoi);
      if (!dims || pixels.length !== dims.width * dims.height * 4) continue;

      const snapshotCanvas = document.createElement('canvas');
      snapshotCanvas.width = dims.width;
      snapshotCanvas.height = dims.height;
      snapshotCanvas.getContext('2d').putImageData(
        new ImageData(
          new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
          dims.width,
          dims.height
        ), 0, 0
      );

      const group = lm.layerGroups[i];
      if (!group) continue;

      // Bake pending strokes into the base so the region clear is complete —
      // strokeStack entries composite above flatCanvas, so clearing the base
      // without baking first would leave recent strokes in the region.
      for (const stroke of group.strokeStack) {
        lm.addToBaseBin(i, stroke.canvas, stroke.x, stroke.y, stroke.blendMode);
      }
      group.strokeStack = [];
      group.userStrokeCounts = new Map();

      if (group.flatCanvas) {
        // Layer 0: direct pixel manipulation on the flat canvas.
        lm.withFlatCanvasContext(i, (ctx) => {
          ctx.save();
          if (!isLasso) {
            ctx.clearRect(rx, ry, rw, rh);
            this._drawSnapshotRectRegion(ctx, snapshotCanvas, rx, ry, rw, rh);
          } else {
            buildLassoPath(ctx);
            ctx.clip();
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(snapshotCanvas, 0, 0);
          }
          ctx.restore();
        });
      } else {
        // Layers 1+: append destination-out erase then source-over fill.
        const eraseCanvas = document.createElement('canvas');
        eraseCanvas.width = width; eraseCanvas.height = height;
        const eraseCtx = eraseCanvas.getContext('2d');
        eraseCtx.fillStyle = '#000';
        if (!isLasso) {
          eraseCtx.fillRect(rx, ry, rw, rh);
        } else {
          buildLassoPath(eraseCtx);
          eraseCtx.fill();
        }
        lm.addToBaseBin(i, eraseCanvas, 0, 0, 'destination-out');

        const fillCanvas = document.createElement('canvas');
        fillCanvas.width = width; fillCanvas.height = height;
        const fillCtx = fillCanvas.getContext('2d');
        fillCtx.save();
        if (!isLasso) {
          this._drawSnapshotRectRegion(fillCtx, snapshotCanvas, rx, ry, rw, rh);
        } else {
          buildLassoPath(fillCtx);
          fillCtx.clip();
          fillCtx.drawImage(snapshotCanvas, 0, 0);
        }
        fillCtx.restore();
        lm.addToBaseBin(i, fillCanvas, 0, 0, 'source-over');
      }
    }

    this.markCompositeFull();
  }

  /** Draw the clipped source region of a snapshot canvas 1:1 (region restore). @private */
  _drawSnapshotRectRegion(ctx, snapshotCanvas, x, y, w, h) {
    const sourceX = Math.max(0, x);
    const sourceY = Math.max(0, y);
    const sourceRight = Math.min(snapshotCanvas.width, x + w);
    const sourceBottom = Math.min(snapshotCanvas.height, y + h);
    const srcW = sourceRight - sourceX;
    const srcH = sourceBottom - sourceY;
    if (srcW <= 0 || srcH <= 0) return;
    ctx.drawImage(snapshotCanvas, sourceX, sourceY, srcW, srcH, sourceX, sourceY, srcW, srcH);
  }

  maskPreviewForExistingMode(ctx, user, rect = null) {
    if (!ctx || !user) return;
    if (user.blendBakeMode !== 'existing') return;
    if (!user.blendMode || user.blendMode === 'source-over' || user.blendMode === 'destination-out') return;

    const existingContent = this.layerManager?.getLayerExistingContent?.(user.activeLayer ?? 0);
    if (!existingContent) return;

    ctx.save();
    if (rect) {
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
    }
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(existingContent, 0, 0);
    ctx.restore();
  }

  // Compositing — no-op during action processing.
  // The real composite is driven by _compositeOutput() after all actions finish,
  // which ensures the snapshot is in place so blur filters have source content.
  compositeAllLayers() {
    if (!this.layerManager) return;

    const totalLayers = this.layerManager.getLayerCount();
    const hasActiveSelection = this.activeSelectionLayer >= 0;
    const splitLayer = hasActiveSelection
      ? Math.max(0, Math.min(this.activeSelectionLayer, totalLayers - 1))
      : totalLayers - 1;
    const canSplitUpperLayers =
      hasActiveSelection &&
      splitLayer + 1 < totalLayers &&
      !this.layerManager.rangeHasBlendModeStrokes(splitLayer + 1, totalLayers);

    // Dirty-rect path: only the regions touched by strokes committed since the
    // last composite need to be repainted. Full-composite mode (snapshot
    // rebase, first frame, mode flip) skips this and clears everything.
    const useDirty =
      !this._fullComposite &&
      this._compositeDirtyRects.length > 0 &&
      !hasActiveSelection;
    const dirtyRects = useDirty ? this._compositeDirtyRects : null;

    if (!useDirty) {
      this.viewCtx.clearRect(0, 0, this.getWidth(), this.getHeight());
      this.upperLayersCtx?.clearRect(0, 0, this.getWidth(), this.getHeight());
    }

    if (canSplitUpperLayers) {
      this.layerManager.compositeLayerRange(
        this.viewCtx,
        0,
        splitLayer + 1,
        this.backgroundColor,
        dirtyRects
      );
      this.layerManager.compositeLayerRange(
        this.upperLayersCtx,
        splitLayer + 1,
        totalLayers,
        null,
        dirtyRects
      );
    } else {
      this.layerManager.compositeLayerRange(
        this.viewCtx,
        0,
        totalLayers,
        this.backgroundColor,
        dirtyRects
      );
    }

    this._compositeDirtyRects.length = 0;
    this._fullComposite = false;
    this.layerManager.needsComposite = false;
  }

  // Called by _compositeOutput when the snapshot base is ready.
  _doComposite() {
    this.compositeAllLayers();
  }

  // requestUpdate is a no-op — we composite manually at the end
  requestUpdate() {}

  // Selection overlay stubs
  clearTop() {
    this.topCtx.clearRect(0, 0, this.getWidth(), this.getHeight());
    this.clearSelectionOverlay();
  }
  clearSelectionOverlay() {
    if (!this.selectionCtx) return;
    const pad = this.selectionOverlayPadding;
    this.selectionCtx.clearRect(0, 0, this.getWidth() + pad * 2, this.getHeight() + pad * 2);
  }
  getSelectionCtx() {
    if (!this.selectionCtx) return null;
    this.selectionCtx.save();
    this.selectionCtx.translate(this.selectionOverlayPadding, this.selectionOverlayPadding);
    return this.selectionCtx;
  }
  restoreSelectionCtx() {
    if (this.selectionCtx) this.selectionCtx.restore();
  }

  getActiveLayerBlendMode() { return 'source-over'; }

  mirrorPointToRegion(point, region) {
    if (!region || !point) return point;
    const centerX = region.x + (region.width / 2);
    const centerY = region.y + (region.height / 2);
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const transform = region.transform || region.mode || region.axis;

    if (transform === 'rotateCustom') {
      const angle = Number(region.rotationAngle || 0);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return {
        x: centerX + (dx * cos) - (dy * sin),
        y: centerY + (dx * sin) + (dy * cos)
      };
    }

    if (transform === 'fibStep') {
      const invPHI = 0.6180339887;
      const step = region.fibStep || 1;
      const eyeX = region.x + region.width * invPHI;
      const eyeY = region.y + region.height * invPHI;
      const angle = step * (Math.PI / 2);
      const scale = Math.pow(invPHI, step);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const fdx = point.x - eyeX;
      const fdy = point.y - eyeY;
      return {
        x: eyeX + ((fdx * cos) - (fdy * sin)) * scale,
        y: eyeY + ((fdx * sin) + (fdy * cos)) * scale
      };
    }

    switch (transform) {
      case 'horizontal':
      case 'flipY':
        return { x: point.x, y: (centerY * 2) - point.y };
      case 'vertical':
      case 'flipX':
        return { x: (centerX * 2) - point.x, y: point.y };
      case 'flipXY':
      case 'rotate180':
        return { x: (centerX * 2) - point.x, y: (centerY * 2) - point.y };
      case 'rotate90':
        return { x: centerX - dy, y: centerY + dx };
      case 'rotate270':
        return { x: centerX + dy, y: centerY - dx };
      default:
        return { x: (centerX * 2) - point.x, y: point.y };
    }
  }

  mirrorPointsToRegion(points, region) {
    if (!Array.isArray(points)) return [];
    return points.map((point) => this.mirrorPointToRegion(point, region));
  }

  withMirrorRegionClip(ctx, region, drawFn) {
    if (!ctx || !region || typeof drawFn !== 'function') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.width, region.height);
    ctx.clip();
    drawFn();
    ctx.restore();
  }

  withMirroredRegionTransform(ctx, region, drawFn) {
    if (!ctx || !region || typeof drawFn !== 'function') return;
    this.withMirrorRegionClip(ctx, region, () => {
      ctx.save();
      const centerX = region.x + (region.width / 2);
      const centerY = region.y + (region.height / 2);
      const transform = region.transform || region.mode || region.axis;
      switch (transform) {
        case 'horizontal':
        case 'flipY':
          ctx.translate(0, centerY * 2);
          ctx.scale(1, -1);
          break;
        case 'vertical':
        case 'flipX':
          ctx.translate(centerX * 2, 0);
          ctx.scale(-1, 1);
          break;
        case 'flipXY':
        case 'rotate180':
          ctx.translate(centerX * 2, centerY * 2);
          ctx.scale(-1, -1);
          break;
        case 'rotate90':
          ctx.translate(centerX, centerY);
          ctx.rotate(Math.PI / 2);
          ctx.translate(-centerX, -centerY);
          break;
        case 'rotate270':
          ctx.translate(centerX, centerY);
          ctx.rotate(-Math.PI / 2);
          ctx.translate(-centerX, -centerY);
          break;
        case 'rotateCustom':
          ctx.translate(centerX, centerY);
          ctx.rotate(Number(region.rotationAngle || 0));
          ctx.translate(-centerX, -centerY);
          break;
        case 'fibStep': {
          const invPHI = 0.6180339887;
          const step = region.fibStep || 1;
          const eyeX = region.x + region.width * invPHI;
          const eyeY = region.y + region.height * invPHI;
          const angle = step * (Math.PI / 2);
          const scale = Math.pow(invPHI, step);
          ctx.translate(eyeX, eyeY);
          ctx.rotate(angle);
          ctx.scale(scale, scale);
          ctx.translate(-eyeX, -eyeY);
          break;
        }
        default:
          ctx.translate(centerX * 2, 0);
          ctx.scale(-1, 1);
          break;
      }
      drawFn();
      ctx.restore();
    });
  }

  drawMirroredCanvas(ctx, sourceCanvas, region, x = 0, y = 0) {
    if (!ctx || !sourceCanvas || !region) return;
    this.withMirroredRegionTransform(ctx, region, () => {
      ctx.drawImage(sourceCanvas, x, y);
    });
  }

  forEachMirrorRegion(target, callback) {
    if (typeof callback !== 'function') return;
    const bounds = this._getMirrorTargetBounds(target);
    for (const region of this.getActiveMirrorRegions()) {
      if (!bounds || this._rectIntersects(bounds, region)) {
        callback(region);
      }
    }
  }

  _normalizeMirrorRegion(region) {
    if (!region) return null;
    const x = Math.floor(Number(region.x));
    const y = Math.floor(Number(region.y));
    const width = Math.floor(Number(region.width));
    const height = Math.floor(Number(region.height));
    if (![x, y, width, height].every(Number.isFinite)) return null;

    const mode = this._normalizeMirrorMode(region.mode || region.axis);
    return {
      id: String(region.id || `mr_${x}_${y}_${width}_${height}`),
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.max(1, width),
      height: Math.max(1, height),
      mode,
      axis: mode,
      slices: this._normalizeMirrorSlices(region.slices),
      fibDepth: this._normalizeFibDepth(region.fibDepth),
      showLine: region.showLine !== false,
      owner: region.owner || region.createdBy || null
    };
  }

  _normalizeMirrorMode(mode) {
    return ['horizontal', 'quad', 'rotational', 'radial', 'fib'].includes(mode) ? mode : 'vertical';
  }

  _normalizeMirrorSlices(slices) {
    const parsed = Math.floor(Number(slices));
    if (!Number.isFinite(parsed)) return 6;
    return Math.max(3, Math.min(16, parsed));
  }

  _normalizeFibDepth(depth) {
    const parsed = Math.floor(Number(depth));
    if (!Number.isFinite(parsed)) return 4;
    return Math.max(1, Math.min(8, parsed));
  }

  _expandMirrorRegionTransforms(region) {
    if (!region) return [];
    const baseRegion = {
      ...region,
      mode: this._normalizeMirrorMode(region.mode || region.axis),
      slices: this._normalizeMirrorSlices(region.slices),
      fibDepth: this._normalizeFibDepth(region.fibDepth)
    };
    const transformsByMode = {
      vertical: ['flipX'],
      horizontal: ['flipY'],
      quad: ['flipX', 'flipY', 'flipXY'],
      rotational: ['rotate180']
    };

    if (baseRegion.mode === 'radial') {
      const transforms = [];
      for (let step = 1; step < baseRegion.slices; step += 1) {
        transforms.push({
          ...baseRegion,
          transform: 'rotateCustom',
          rotationAngle: (Math.PI * 2 * step) / baseRegion.slices,
          rotationStep: step,
          synthetic: true,
          id: `${baseRegion.id}_radial_${step}`
        });
      }
      return transforms;
    }

    if (baseRegion.mode === 'fib') {
      const transforms = [];
      for (let step = 1; step <= baseRegion.fibDepth; step += 1) {
        transforms.push({
          ...baseRegion,
          transform: 'fibStep',
          fibStep: step,
          synthetic: true,
          id: `${baseRegion.id}_fib_${step}`
        });
      }
      return transforms;
    }

    return (transformsByMode[baseRegion.mode] || transformsByMode.vertical).map((transform) => ({
      ...baseRegion,
      transform,
      synthetic: true,
      id: `${baseRegion.id}_${transform}`
    }));
  }

  _getMirrorTargetBounds(target) {
    if (!target) return null;
    if (target.rect) return target.rect;
    if (target.point) return { x: target.point.x, y: target.point.y, width: 0, height: 0 };
    if (!Array.isArray(target.points) || target.points.length === 0) return null;

    let minX = target.points[0].x;
    let minY = target.points[0].y;
    let maxX = target.points[0].x;
    let maxY = target.points[0].y;
    for (const point of target.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  _rectIntersects(a, b) {
    return (
      a.x <= b.x + b.width &&
      a.x + a.width >= b.x &&
      a.y <= b.y + b.height &&
      a.y + a.height >= b.y
    );
  }
}

// Borrowed from Board rather than re-implemented. RemoteSelectionHandler drives
// both the live board and this one, and it calls these on every mirrored
// selection verb — a ReplayBoard missing one throws inside _processAction's
// try/catch, which swallows it and silently drops the whole stroke from the
// replay. Everything here depends only on methods ReplayBoard already has
// (getWidth/getHeight, _expandMirrorRegionTransforms, mirrorPointToRegion,
// _rectIntersects), so sharing the implementation is also what stops the two
// classes drifting the way the rest of this mirror math already has.
for (const name of [
  'getActiveMirrorRegionsFor',
  'getSelectionMirrorTargets',
  'mirrorRectBounds',
  'unionWithMirrorTargets',
  '_mirrorRegionMatrix',
  // The tools call this every tick from getPreviewDirtyRect; without it replay
  // silently answers undefined and previews a partial rect while mirrors are on.
  'hasMirrors',
]) {
  ReplayBoard.prototype[name] = Board.prototype[name];
}


/**
 * ReplayEngine provides accurate playback by routing recorded actions
 * through the real RemoteUserHandler, using a real LayerManager and
 * real ToolManager instances for pixel-perfect tool rendering.
 */
export class ReplayEngine {
  constructor() {
    /** @type {Map<number, User>} Bot users keyed by session index */
    this.botUsers = new Map();

    /** @type {HTMLCanvasElement} Main composite output canvas */
    this.outputCanvas = null;
    /** @type {CanvasRenderingContext2D} */
    this.outputCtx = null;

    /** @type {HTMLCanvasElement} Preview/top canvas for active strokes */
    this.topCanvas = null;
    /** @type {CanvasRenderingContext2D} */
    this.topCtx = null;

    /** @type {number} */
    this.width = 0;
    /** @type {number} */
    this.height = 0;

    /** @type {boolean} Mirror mode */
    this.mirror = false;

    /** @type {string} Shape draw mode ('corner-to-corner' | 'center-scaling') — app-global in live play */
    this._shapeDrawMode = 'corner-to-corner';

    /** @type {boolean} Whether to draw remote user cursors over the replay */
    this.renderCursors = true;
    /**
     * @type {boolean} Whether selection UI (marching ants, pending-selection
     * rects, the select tool's overlay canvas) is baked into outputCanvas.
     * True for live replay viewing; the video/frames exporter turns it off so
     * renders only contain artwork. Floating selection CONTENT always renders.
     */
    this.renderSelectionOverlay = true;
    /** @type {number} Playhead timestamp of the most recent action batch (ms) */
    this._currentReplayTs = 0;
    /**
     * Active vector (ephemeral, fading) text records keyed by id. Each entry is
     * `{ record, bornTs, lifetimeMs, fadeMs, holdMs, minOpacity, baseOpacity }`. Faded
     * against the playhead in drawVectorText. Cleared on reset().
     * @type {Map<string, Object>}
     */
    this._vectorTextRecords = new Map();

    /** @type {Array<number>} Background color */
    this.backgroundColor = [255, 255, 255, 1];

    /** @type {Object} Reference to wsClient for decoding */
    this._wsClient = null;

    /** @type {ReplayBoard} */
    this._replayBoard = null;
    /** @type {ToolManager} */
    this._toolManager = null;
    /** @type {RemoteUserHandler} */
    this._remoteHandler = null;
    /** @type {Object} Fake app for RemoteUserHandler */
    this._fakeApp = null;

    /** @type {Map<string, Object>} Cache for pattern brush images */
    this._patternCache = new Map();
    /** @type {Map<number, {patternData: Object|null, patternMode: boolean}>} Last known pattern state by user */
    this._patternStateByUser = new Map();
    /** @type {Map<string, HTMLImageElement|null>} Cache for pasted image payloads */
    this._imagePasteCache = new Map();

    /** @type {HTMLCanvasElement} Holds loaded snapshot image */
    this._snapshotCanvas = null;
    this._snapshotCtx = null;
    /** @type {boolean} True when the snapshot restored full layer/stroke state */
    this._snapshotHasLayerState = false;
    /**
     * Users who were mid-stroke (mousedown) when the opening snapshot was
     * captured. Their in-progress preview pixels are baked into the flat
     * `topCanvasData` overlay; once every one of those strokes has ended in the
     * replay (MU/CANCEL, or a fresh MD if the MU fell off the tape), the
     * overlay is cleared — otherwise the half-stroke would sit on top of the
     * board forever, surviving even an UNDO of the committed stroke.
     * @type {Set<number>}
     */
    this._snapshotTopOverlayUsers = new Set();

    /** @type {Function|null} Called when async operations (blur worker) update the output */
    this.onOutputUpdate = null;
    /** @type {(source: any) => string|null} */
    this._assetResolver = null;
  }

  /**
   * Initialize the replay engine with canvas dimensions.
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   * @param {Object} wsClient - WebSocket client for message decoding
   */
  init(width, height, wsClient) {
    this.width = width;
    this.height = height;
    this._wsClient = wsClient;

    // Output canvas for final composite
    this.outputCanvas = document.createElement('canvas');
    this.outputCanvas.width = width;
    this.outputCanvas.height = height;
    this.outputCtx = this.outputCanvas.getContext('2d');

    // Top canvas for active stroke preview
    this.topCanvas = document.createElement('canvas');
    this.topCanvas.width = width;
    this.topCanvas.height = height;
    this.topCtx = this.topCanvas.getContext('2d');

    // Snapshot canvas (holds the loaded snapshot image as base)
    this._snapshotCanvas = document.createElement('canvas');
    this._snapshotCanvas.width = width;
    this._snapshotCanvas.height = height;
    this._snapshotCtx = this._snapshotCanvas.getContext('2d');

    this._initReplaySystem();
  }

  /**
   * Resize the replay engine's canvases + LayerManager to match a recording's
   * board dimensions. The engine is constructed with the live board's size at
   * App boot, but the board can grow (room joins with a larger boardSize)
   * before a recording is loaded. Snapshots captured at the new size would
   * otherwise blit into a too-small replay canvas and get truncated.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    if (!width || !height) return;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    for (const cvs of [this.outputCanvas, this.topCanvas, this._snapshotCanvas]) {
      if (cvs) { cvs.width = width; cvs.height = height; }
    }
    if (this._replayBoard) {
      this._replayBoard.dimensions = [height, width];
      for (const cvs of [this._replayBoard.viewCanvas, this._replayBoard.topCanvas, this._replayBoard.upperLayersCanvas]) {
        if (cvs) { cvs.width = width; cvs.height = height; }
      }
      if (this._replayBoard.selectionOverlay) {
        // Board size + padding, matching the ReplayBoard constructor — a
        // boot-time-sized overlay clips floating-selection previews near the
        // right/bottom edges of a larger board.
        const pad = this._replayBoard.selectionOverlayPadding ?? 0;
        this._replayBoard.selectionOverlay.width = width + pad * 2;
        this._replayBoard.selectionOverlay.height = height + pad * 2;
      }
      if (this._replayBoard.layerManager) {
        this._replayBoard.layerManager.width = width;
        this._replayBoard.layerManager.height = height;
        for (const group of this._replayBoard.layerManager.layerGroups ?? []) {
          for (const cvs of [group.baseCanvas, group.flatCanvas]) {
            if (cvs) { cvs.width = width; cvs.height = height; }
          }
        }
      }
    }
  }

  /**
   * Provide a resolver for deduplicated replay image assets.
   * @param {(source:any) => string|null} resolver
   */
  setAssetResolver(resolver) {
    this._assetResolver = resolver;
  }

  /**
   * Mark users whose strokes can be baked immediately during this replay (because
   * the tape contains no UNDO/REDO for them). Saves up to MAX_STROKES_PER_USER
   * worth of pending stroke canvases per layer per user from being re-composited
   * every frame.
   * @param {Set<number>|null} userIdSet
   */
  setEagerBakeUsers(userIdSet) {
    const set = userIdSet && userIdSet.size > 0 ? userIdSet : null;
    this._eagerBakeUsers = set;
    if (this._replayBoard?.layerManager) {
      this._replayBoard.layerManager.eagerBakeUsers = set;
    }
  }

  /**
   * Build the replay board, tool manager, and remote handler.
   * @private
   */
  _initReplaySystem() {
    // Real board facade with real LayerManager
    this._replayBoard = new ReplayBoard(this.width, this.height);
    this._replayBoard.layerManager.useStableReplayBlur = true;

    // Set localUserId to a non-matching value so all glitchBlur strokes are
    // treated as "remote" and wait for GLITCH_RESULT instead of computing WASM
    this._replayBoard.layerManager.localUserId = -9999;

    // Real ToolManager with all tool instances
    this._toolManager = new ToolManager(this._replayBoard);

    // Minimal fake UI that feeds live handler updates back into replay bot state.
    const noopUI = {
      updateRemoteCursor: (id, x, y, size) => {
        const user = this.botUsers.get(id);
        if (!user) return;
        user.setPosition(x, y);
        if (size !== undefined) user.setSize(size);
        this._syncReplayTextPreview(user);
      },
      updateRemoteColor: (id, color) => {
        const user = this.botUsers.get(id);
        if (user && color) {
          user.setColor(color);
          this._syncReplayTextPreview(user);
        }
      },
      updateRemoteSize: (id, size) => {
        const user = this.botUsers.get(id);
        if (user && size !== undefined) {
          user.setSize(size);
          this._syncReplayTextPreview(user);
        }
      },
      updateRemoteName: (id, name) => {
        const user = this.botUsers.get(id);
        if (user && name !== undefined) user.setUsername(name);
      },
      updateRemoteToolDisplay: (id, tool) => {
        const user = this.botUsers.get(id);
        if (user && tool) {
          user.setTool(tool);
          this._syncReplayTextPreview(user);
        }
      },
      hideRemoteCursor: () => {},
      showRemoteCursor: () => {},
      // Pure activity-tracking signal in the live UI; replay doesn't need it
      // but RemoteUserHandler calls it on every MD/MM, so a missing method
      // throws and the entire stroke gets swallowed by the try/catch.
      markRemoteCursorActivity: () => {},
      createRemoteUser: () => {},
      removeRemoteUser: (id) => {
        const user = this.botUsers.get(id);
        if (!user?.context) return;
        user.context.clearRect(0, 0, this.width, this.height);
      },
      createUserBoard: () => ({ board: document.createElement('canvas'), context: document.createElement('canvas').getContext('2d') }),
      setRemoteTextDomVisible: (id) => {
        const user = this.botUsers.get(id);
        if (!user) return;
        this._syncReplayTextPreview(user);
      },
      updateRemoteText: (id, text) => {
        const user = this.botUsers.get(id);
        if (user && text !== undefined) {
          user.text = text;
          this._syncReplayTextPreview(user);
        }
      },
      setRemoteUserAfk: (id, afk) => {
        const user = this.botUsers.get(id);
        if (user) user.setAfk(!!afk);
      },
      updateRemoteUserRank: (id, role) => {
        const user = this.botUsers.get(id);
        if (user && role !== undefined) user.role = role;
      },
    };

    // Fake app object matching what RemoteUserHandler expects
    this._fakeApp = {
      board: this._replayBoard,
      toolManager: this._toolManager,
      ui: noopUI,
      users: this.botUsers,
      sessionIndex: -9999, // Never matches any real user
      // Every tape action belongs to a bot, never to "us" — replay has no local
      // user drawing alongside it, so nothing here is ever a self echo to skip.
      // RemoteUserHandler calls this unconditionally on MD/MM/MU, so a missing
      // method throws and the switch's catch swallows every stroke in the tape.
      isSelfEcho: () => false,
      self: null,
      blendModeManager: {
        toCSSBlendMode: (bm) => bm || 'normal'
      },
      remoteUserHandler: null, // set below
      connected: false,
      wsClient: null,
      eraseAllLayers: false,
      activeTool: null,
      moderation: null,
      svelteComponents: null,
    };

    // Set board's app reference (needed for compositeAllLayers)
    this._replayBoard.app = this._fakeApp;

    // Real RemoteUserHandler — the same code path as live users
    this._remoteHandler = new RemoteUserHandler(this._fakeApp);
    this._fakeApp.remoteUserHandler = this._remoteHandler;

    // Disable the catchup loop — replay drives all drawing synchronously
    this._remoteHandler.startCatchupLoop = () => {};
    this._remoteHandler.tickCatchup = () => {};

    // Restore eager-bake set across LayerManager rebuilds (reset, seek-back).
    if (this._eagerBakeUsers && this._replayBoard?.layerManager) {
      this._replayBoard.layerManager.eagerBakeUsers = this._eagerBakeUsers;
    }
  }

  /**
   * Mirror in-progress text previews onto the bot preview canvas so replay can
   * display text typing even though it has no DOM overlay layer.
   * @param {User} user
   * @private
   */
  _syncReplayTextPreview(user) {
    if (!user?.context) return;

    if (user._replayTextPreviewActive) {
      user.context.clearRect(0, 0, this.width, this.height);
      user._replayTextPreviewActive = false;
    }

    const hasBlendMode = user.blendMode && user.blendMode !== 'source-over';
    if (user.tool !== 'text' || !user.text || !hasBlendMode) return;
    this._remoteHandler?._renderRemoteTextToCanvas?.(user);
    user._replayTextPreviewActive = true;
  }

  /**
   * Reset the engine state for a new replay session.
   */
  reset() {
    this.botUsers.clear();
    // Masks live on the board, not the User, so clearing botUsers does not take
    // them with it. A stale mask left over from a previous tape position would
    // clip strokes that were never masked — the mirror image of the bug that
    // made replay ignore masks in the first place. Load paths (checkpoint /
    // snapshot / dynamic checkpoint) all reset() first and then re-assert
    // whatever mask was live at that baseline.
    this._replayBoard?.resetSelectionMasks?.();
    this._patternStateByUser.clear();
    this._vectorTextRecords.clear();
    this._snapshotHasLayerState = false;
    this._snapshotTopOverlayUsers.clear();
    // Clear global mirror back to OFF so it agrees with the freshly-built
    // _replayBoard (mirror=false, mirrorRegions=[]). T.MIR is a relative toggle,
    // so a stale `this.mirror` left over from a previous replay would (a) desync
    // from _replayBoard.mirror and (b) make the next MIR toggle flip the wrong
    // way. Load paths normally re-assert mirror, but loadCheckpointImage only
    // sets it when the server sends `m`, so a missing flag must default to OFF
    // here rather than inheriting the previous session's state.
    this.mirror = false;
    // _initReplaySystem below rebuilds the ToolManager, whose shape tools
    // default to corner-to-corner — keep the engine flag in agreement. Load
    // paths re-assert the recorded mode afterwards.
    this._shapeDrawMode = 'corner-to-corner';
    this.outputCtx?.clearRect(0, 0, this.width, this.height);
    this.topCtx?.clearRect(0, 0, this.width, this.height);
    this._snapshotCtx?.clearRect(0, 0, this.width, this.height);

    // Reinitialize the replay system for a clean slate
    this._initReplaySystem();
    if (this._replayBoard) {
      this._replayBoard._fullComposite = true;
      this._replayBoard._compositeDirtyRects.length = 0;
    }
  }

  /**
   * Apply a shape draw mode, mirroring live play where it belongs to the user
   * who set it (the shape tools read it off the drawing user).
   * @param {string} mode - 'corner-to-corner' or 'center-scaling'
   * @param {number|null} [userId] - Owner of the mode, when the tape names one.
   * @private
   */
  _applyShapeDrawMode(mode, userId = null) {
    const normalized = mode === 'center-scaling' ? 'center-scaling' : 'corner-to-corner';

    if (userId != null) {
      this._getOrCreateBot(userId).shapeDrawMode = normalized;
      return;
    }

    // Unattributed: proto3 omits a default u=0 and the recorder's
    // structuredClone drops it, so most taped CSDMs name nobody. Apply
    // engine-wide rather than lose the mode — and to existing bots too, since
    // a bot's own value would otherwise shadow the tool-instance fallback.
    this._shapeDrawMode = normalized;
    for (const bot of this.botUsers.values()) bot.shapeDrawMode = normalized;
    this._toolManager?.getTool('rectangle')?.setDrawMode?.(normalized);
    this._toolManager?.getTool('circle')?.setDrawMode?.(normalized);
  }

  /**
   * Snapshot the current visible state so it can be reloaded later as a base
   * for incremental replay. Cheap — clones the composited viewCanvas as an
   * ImageBitmap (GPU-resident) and shallow-copies relevant bot fields.
   * Caller is responsible for closing the bitmap when evicting.
   * @returns {Promise<{bitmap: ImageBitmap, botStates: Object, mirror: boolean, mirrorRegions: Object[]}|null>}
   */
  async captureDynamicCheckpoint() {
    const viewCanvas = this._replayBoard?.viewCanvas;
    if (!viewCanvas) return null;
    // Capture the bot states SYNCHRONOUSLY, before any await. createImageBitmap
    // snapshots viewCanvas at call time and the caller reads its deltaIdx
    // synchronously too — but if we read botStates after awaiting the bitmap, a
    // scrub/seek that lands during that async gap mutates botUsers, pairing this
    // checkpoint's pixels + deltaIdx with blend/tool state from a DIFFERENT tape
    // position. A later rebuild then restores the wrong blend and replays the
    // tail from a mismatched baseline → strokes render with no blend mode.
    const botStates = {};
    for (const [id, u] of this.botUsers) {
      botStates[id] = {
        username: u.username,
        isSupporter: u.isSupporter,
        role: u.role,
        x: u.x, y: u.y,
        size: u.size,
        color: u.color ? [...u.color] : undefined,
        opacity: u.opacity,
        tool: u.tool,
        text: u.text || '',
        blendMode: u.blendMode,
        // Carry the bake mode alongside blendMode — _createBotUser restores it
        // and the 'existing' content-mask depends on it. Dropping it would make
        // a rebuild from this checkpoint render complex-blend strokes unmasked.
        blendBakeMode: u.blendBakeMode,
        activeLayer: u.activeLayer,
        spacing: u.spacing,
        smoothing: u.smoothing,
        hardness: u.hardness,
        thinning: u.thinning,
        pressure: u.pressure,
        simulatePressure: u.simulatePressure,
        patternMode: u.patternMode,
        patternScale: u.patternScale,
        patternRotation: u.patternRotation,
        patternSpacing: u.patternSpacing,
        patternOffsetX: u.patternOffsetX,
        patternOffsetY: u.patternOffsetY,
        patternColorMode: u.patternColorMode,
        font: u.font,
        textPositionMultiplier: u.textPositionMultiplier,
        textPositionOffset: u.textPositionOffset,
        // Same reasoning as blendBakeMode above: a selection mask is sticky
        // per-user state that clips every stroke drawn under it, and the
        // SEL_MASK that turned it on may sit far behind this checkpoint and
        // never be replayed. Without carrying it, a scrub that rebuilds from
        // here renders the masked tail unclipped. Read off the BOARD — masks
        // are keyed by user there, not stored on the User.
        isMaskMode: !!u.isMaskMode,
        selectionMask: this._replayBoard?._getSelectionMaskForUser?.(id) || null,
      };
    }
    // Snapshot the pixels last, from a BACKGROUND-LESS composite — matching the
    // static snapshot's getCompositedCanvas path. viewCanvas has the background
    // colour filled in, and this bitmap gets rebased into layer0.flatCanvas. An
    // opaque background there breaks the 'existing' blend mask (destination-in
    // vs flatCanvas): it sees content everywhere, so a complex-blend stroke that
    // should be masked to nothing over an empty area renders as a raw, blend-less
    // line. getCompositedCanvas leaves empty areas transparent, so the mask
    // behaves exactly as it did live. (Doing this last also keeps the bitmap
    // consistent with the bot states read above even if the await yields.)
    const compositeCanvas = this._replayBoard.layerManager?.getCompositedCanvas?.() ?? viewCanvas;
    const bitmap = await createImageBitmap(compositeCanvas);
    return {
      bitmap,
      botStates,
      // Active ephemeral vector text — not part of the composited bitmap, so it
      // must ride along or a backward scrub through this checkpoint would drop
      // any text still mid-fade. bornTs is tape-time, so it stays valid.
      vectorText: this._cloneVectorTextRecords(),
      mirror: this._replayBoard?.mirror ?? this.mirror,
      mirrorRegions: (this._replayBoard?.mirrorRegions || []).map((region) => ({ ...region })),
      shapeDrawMode: this._shapeDrawMode
    };
  }

  /**
   * Deep-clone the active vector text records for checkpoint serialization.
   * @returns {Array<[string, Object]>}
   * @private
   */
  _cloneVectorTextRecords() {
    const out = [];
    for (const [id, entry] of this._vectorTextRecords) {
      out.push([id, {
        record: { ...entry.record, color: Array.isArray(entry.record.color) ? [...entry.record.color] : entry.record.color },
        bornTs: entry.bornTs,
        lifetimeMs: entry.lifetimeMs,
        fadeMs: entry.fadeMs,
        holdMs: entry.holdMs,
        minOpacity: entry.minOpacity,
        baseOpacity: entry.baseOpacity
      }]);
    }
    return out;
  }

  /**
   * Restore serialized vector text records from a snapshot/checkpoint.
   * @param {Array<[string, Object]>} vectorText
   * @private
   */
  _restoreVectorTextRecords(vectorText) {
    if (!Array.isArray(vectorText)) return;
    for (const item of vectorText) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const [id, entry] = item;
      if (!id || !entry?.record) continue;
      const lifetimeMs = Number(entry.lifetimeMs) || TEXT_OVERLAY_DEFAULT_LIFETIME_MS;
      const fadeMs = Number.isFinite(Number(entry.fadeMs))
        ? Math.max(0, Math.min(Number(entry.fadeMs), lifetimeMs))
        : Math.max(0, Math.min(TEXT_OVERLAY_DEFAULT_FADE_MS, lifetimeMs));
      const holdMs = Number.isFinite(Number(entry.holdMs))
        ? Math.max(0, Math.min(Number(entry.holdMs), lifetimeMs))
        : Math.max(0, lifetimeMs - fadeMs);
      this._vectorTextRecords.set(String(id), {
        record: {
          ...entry.record,
          color: Array.isArray(entry.record.color) ? [...entry.record.color] : entry.record.color
        },
        bornTs: Number(entry.bornTs) || 0,
        lifetimeMs,
        fadeMs,
        holdMs,
        minOpacity: Number.isFinite(Number(entry.minOpacity)) ? Number(entry.minOpacity) : TEXT_OVERLAY_DEFAULT_MIN_OPACITY,
        baseOpacity: Number.isFinite(Number(entry.baseOpacity)) ? Number(entry.baseOpacity) : 1
      });
    }
  }

  /**
   * Load a previously captured dynamic checkpoint as the base state for
   * replay. Mirrors loadCheckpointImage but accepts an ImageBitmap and a
   * snapshot of bot user state so we don't lose tool/color/size context
   * acquired between the static checkpoint and this point in the tape.
   * @param {{bitmap: ImageBitmap, botStates: Object, mirror?: boolean, mirrorRegions?: Object[]}} cp
   * @returns {Promise<void>}
   */
  async loadDynamicCheckpoint(cp) {
    if (!cp?.bitmap) return;
    this.reset();
    this._snapshotHasLayerState = false;
    this._snapshotCtx.clearRect(0, 0, this.width, this.height);
    this._snapshotCtx.drawImage(cp.bitmap, 0, 0);
    this.mirror = !!cp.mirror;
    this._replayBoard.setMirror(this.mirror);
    this._replayBoard.setMirrorRegions(cp.mirrorRegions || []);
    this._applyShapeDrawMode(cp.shapeDrawMode);
    for (const [idStr, state] of Object.entries(cp.botStates || {})) {
      const bot = this._createBotUser(Number(idStr), state);
      this._storePatternState(bot);
    }
    // Restore floating vector text captured with the checkpoint (reset() above
    // cleared the map). Records placed after this checkpoint are re-added when
    // the caller replays the trailing deltas via appendActions.
    this._restoreVectorTextRecords(cp.vectorText);
  }

  /**
   * Load a server-side checkpoint image as the base state for replay.
   * Clears all state and draws the checkpoint onto the snapshot canvas.
   * @param {Uint8Array} imageData - PNG image bytes
   * @param {Object} [state={}] - Checkpoint room state, e.g. mirror metadata
   * @returns {Promise<void>}
   */
  async loadCheckpointImage(imageData, state = {}) {
    this.reset();
    this._snapshotHasLayerState = false;
    this._applySettingsMessage(state);

    const blob = new Blob([imageData], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    try {
      await this._loadImageToCanvas(this._snapshotCtx, url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Load a snapshot as the base state.
   * @param {Object} snapshot - Snapshot object with canvas data and user states
   * @returns {Promise<void>}
   */
  async loadSnapshot(snapshot) {
    this.reset();

    this.mirror = !!snapshot?.mirror;
    this._replayBoard.setMirror(this.mirror);
    this._replayBoard.setMirrorRegions(snapshot?.mirrorRegions || []);
    this._applyShapeDrawMode(snapshot?.shapeDrawMode);

    const hasHistory = Array.isArray(snapshot.history) && snapshot.history.some((layerHistory) => Array.isArray(layerHistory) && layerHistory.length > 0);
    const hasRedoHistory = !!snapshot.redoHistory && Object.values(snapshot.redoHistory).some((batches) => Array.isArray(batches) && batches.length > 0);
    const hasActiveStrokes = Array.isArray(snapshot.activeStrokes) && snapshot.activeStrokes.length > 0;
    const hasLayerBaked = Array.isArray(snapshot.layerBaked) && snapshot.layerBaked.some(Boolean);
    this._snapshotHasLayerState = hasHistory || hasRedoHistory || hasActiveStrokes || hasLayerBaked;

    // Load the snapshot's composited canvas image only when we are not also
    // reconstructing the canvas from stroke/layer state. Otherwise the replay
    // would draw the same historical strokes twice.
    if (snapshot.canvasData && !this._snapshotHasLayerState) {
      await this._loadImageToCanvas(this._snapshotCtx, snapshot.canvasData);
    }

    // Seed each layer's permanently-baked base (QOI from layerStateCodec) before
    // importing the live strokeStack on top of it. This is the "baked content"
    // half of a full layer-state checkpoint; the history loop below restores the
    // undoable half. Done before history so z-order is base → strokes.
    if (hasLayerBaked) {
      const lm = this._replayBoard.layerManager;
      for (let gi = 0; gi < snapshot.layerBaked.length; gi++) {
        const bakedCanvas = qoiToCanvas(snapshot.layerBaked[gi]);
        if (bakedCanvas) lm.importSequence(gi, 'source-over', bakedCanvas);
      }
    }

    // Also load the top canvas (active strokes at snapshot time). Remember
    // which users those active strokes belong to — the overlay is cleared once
    // all of them have ended (see _processAction), because the committed
    // strokes render through the layer system from then on and a permanent
    // flat overlay would survive UNDO.
    if (snapshot.topCanvasData) {
      await this._loadImageToCanvas(this.topCtx, snapshot.topCanvasData);
      const states = snapshot.appState?.userDrawingStates || {};
      for (const [idStr, state] of Object.entries(states)) {
        if (state?.mousedown) this._snapshotTopOverlayUsers.add(Number(idStr));
      }
    }

    // Import history if available
    if (snapshot.history) {
      for (let gi = 0; gi < snapshot.history.length; gi++) {
        for (const strokeData of snapshot.history[gi]) {
          await this._importStrokeData(gi, strokeData);
        }
      }
    }

    // Import redo history if available
    if (snapshot.redoHistory) {
      for (const [userIdStr, batches] of Object.entries(snapshot.redoHistory)) {
        const userId = Number(userIdStr);
        for (let bi = 0; bi < batches.length; bi++) {
          for (const item of batches[bi]) {
            await this._importRedoStrokeData(userId, bi, item.groupIdx, item.record);
          }
        }
      }
    }

    // Create bot users from snapshot's user drawing states
    const userStates = snapshot.appState?.userDrawingStates || {};
    for (const [idStr, state] of Object.entries(userStates)) {
      const bot = this._createBotUser(Number(idStr), state);
      this._storePatternState(bot);
      if (state.patternBrush) {
        const loadedPattern = await this._loadPatternData(state.patternBrush);
        this._applyPatternDataToUser(bot, loadedPattern);
      }
      await this._restoreBotTransientState(bot, state);
    }

    if (snapshot.activeStrokes) {
      await this._restoreActiveStrokes(snapshot.activeStrokes);
    }

    // Vector text is intentionally not in the composited canvas snapshot, so
    // restore it as playhead-faded overlay state.
    this._restoreVectorTextRecords(snapshot.vectorText);
  }

  /**
   * Internal helper to import a stroke from a snapshot data object.
   * @private
   */
  /**
   * Rebuild a live stroke record from serialized snapshot data. Handles both the
   * lossless QOI form (layerStateCodec — full layer-state checkpoints) and the
   * legacy dataURL form (`imageData`/`maskCanvasData`). Returns null when the
   * stroke canvas can't be decoded.
   * @param {Object} data
   * @returns {Promise<Object|null>}
   * @private
   */
  async _buildImportedStrokeRecord(data) {
    const canvasWidth = data.canvasWidth ?? data.width;
    const canvasHeight = data.canvasHeight ?? data.height;
    const canvas = data.qoi
      ? qoiToCanvas(data.qoi)
      : await this._loadImageToNewCanvas(data.imageData, canvasWidth, canvasHeight);
    if (!canvas) return null;

    let maskCanvas = null;
    if (data.maskQoi) {
      maskCanvas = qoiToCanvas(data.maskQoi);
    } else if (data.maskCanvasData) {
      const maskCanvasWidth = data.maskCanvasWidth ?? canvasWidth;
      const maskCanvasHeight = data.maskCanvasHeight ?? canvasHeight;
      maskCanvas = await this._loadImageToNewCanvas(data.maskCanvasData, maskCanvasWidth, maskCanvasHeight);
    }

    const record = {
      canvas,
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height,
      blendMode: data.blendMode,
      // Preserved so complex-blend ('existing') strokes and z-order survive a
      // checkpoint rebuild; undoLastStrokeGlobal sorts on seq + timestamp.
      blendBakeMode: data.blendBakeMode,
      seq: data.seq,
      userId: data.userId,
      timestamp: data.timestamp,
      eraseAll: data.eraseAll || false,
      filterType: data.filterType,
      blurRadius: data.blurRadius,
      affectedTiles: data.affectedTiles
    };
    if (data.selectionRestoreData) record.selectionRestoreData = data.selectionRestoreData;
    if (data.filterType) {
      record.maskCanvas = maskCanvas || canvas;
    }
    return record;
  }

  async _importStrokeData(groupIdx, data) {
    const record = await this._buildImportedStrokeRecord(data);
    if (!record) return;
    this._replayBoard.layerManager.importStroke(groupIdx, record);
  }

  /**
   * Internal helper to import a redo stroke from a snapshot data object.
   * @private
   */
  async _importRedoStrokeData(userId, batchIdx, groupIdx, data) {
    const record = await this._buildImportedStrokeRecord(data);
    if (!record) return;
    this._replayBoard.layerManager.importRedoStroke(userId, batchIdx, groupIdx, record);
  }

  /**
   * Load an image onto a canvas context.
   * @private
   */
  _loadImageToCanvas(ctx, dataUrl) {
    return new Promise((resolve) => {
      const src = this._resolveImageSource(dataUrl);
      if (!src || !ctx) {
        resolve();
        return;
      }
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = src;
    });
  }

  /**
   * Like _loadImageToCanvas, but creates the canvas sized to the loaded
   * image's own pixel dimensions instead of an already-sized one handed in.
   * For windowed per-user offscreens (ink/pen — see
   * lag_measured_1440p_realistic_load) the saved PNG's size IS the window,
   * so this is the only way to reconstruct it without also serializing width
   * /height separately.
   * @private
   */
  _loadImageAsSizedCanvas(dataUrl) {
    return new Promise((resolve) => {
      const src = this._resolveImageSource(dataUrl);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!src) {
        canvas.width = 1;
        canvas.height = 1;
        resolve({ canvas, ctx });
        return;
      }
      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth || 1;
        canvas.height = img.naturalHeight || 1;
        ctx.drawImage(img, 0, 0);
        resolve({ canvas, ctx });
      };
      img.onerror = () => {
        canvas.width = 1;
        canvas.height = 1;
        resolve({ canvas, ctx });
      };
      img.src = src;
    });
  }

  /**
   * Load an image into a new canvas and return it.
   * @private
   */
  _loadImageToNewCanvas(dataUrl, width, height) {
    return new Promise((resolve) => {
      const src = this._resolveImageSource(dataUrl);
      if (!src) {
        resolve(null);
        return;
      }
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  _resolveImageSource(source) {
    if (!source) return null;
    if (this._assetResolver) {
      return this._assetResolver(source);
    }
    return typeof source === 'string' ? source : null;
  }

  /**
   * Extract the serialized pattern payload from a GPT action.
   * Live websocket messages use `g`, while some replay code previously expected `pb`.
   * @param {Object} msg
   * @returns {string|Object|null}
   * @private
   */
  _getPatternPayload(msg) {
    return msg?.g ?? msg?.pb ?? null;
  }

  /**
   * Decode a flattened [x, y, ...] path array into point objects.
   * @param {*} values
   * @returns {Array<{x:number,y:number}>|null}
   * @private
   */
  _decodePointPath(values) {
    const points = this._ensureArray(values);
    if (!points || points.length < 2) return null;

    const path = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      path.push({ x: Number(points[i]), y: Number(points[i + 1]) });
    }
    return path.length > 0 ? path : null;
  }

  /**
   * Decode a selection rect from raw replay message fields.
   * @param {Object} msg
   * @returns {{x:number,y:number,width:number,height:number}}
   * @private
   */
  _decodeSelectionRect(msg) {
    return {
      x: Math.floor(Number(msg?.sx) || 0),
      y: Math.floor(Number(msg?.sy) || 0),
      width: Math.ceil(Number(msg?.sw) || 0),
      height: Math.ceil(Number(msg?.sh) || 0)
    };
  }

  /**
   * Decode selection transform corners from a raw SEL_MOVE payload.
   * @param {Object} msg
   * @returns {{tl:{x:number,y:number},tr:{x:number,y:number},br:{x:number,y:number},bl:{x:number,y:number}}|null}
   * @private
   */
  _decodeSelectionCorners(msg) {
    const cr = this._ensureArray(msg?.cr);
    if (!cr || cr.length < 8) return null;

    return {
      tl: { x: Number(cr[0]), y: Number(cr[1]) },
      tr: { x: Number(cr[2]), y: Number(cr[3]) },
      br: { x: Number(cr[4]), y: Number(cr[5]) },
      bl: { x: Number(cr[6]), y: Number(cr[7]) }
    };
  }

  /**
   * Decode the optional source-crop box sent with SEL_MOVE messages.
   * @param {Object} msg
   * @returns {{x:number,y:number,width:number,height:number,total?:{x:number,y:number,width:number,height:number}}|null}
   * @private
   */
  _decodeSelectionSourceCrop(msg) {
    const cb = this._ensureArray(msg?.cb);
    if (!cb || cb.length < 4) return null;

    const sourceCrop = {
      x: Number(cb[0]),
      y: Number(cb[1]),
      width: Number(cb[2]),
      height: Number(cb[3])
    };

    const cbt = this._ensureArray(msg?.cbt);
    if (cbt && cbt.length >= 4) {
      sourceCrop.total = {
        x: Number(cbt[0]),
        y: Number(cbt[1]),
        width: Number(cbt[2]),
        height: Number(cbt[3])
      };
    }

    return sourceCrop;
  }

  /**
   * Apply an IMG_PASTE payload synchronously using a preloaded image.
   * @param {User} user
   * @param {Object} msg
   * @param {HTMLImageElement|null} image
   * @private
   */
  _applyImagePaste(user, msg, image) {
    if (!user || !msg) return;

    const width = Number(msg.sw) || 0;
    const height = Number(msg.sh) || 0;
    if (width <= 0 || height <= 0) return;

    user.context?.clearRect(0, 0, this.width, this.height);
    user.pendingSelection = null;
    user.pendingLassoPath = null;

    user.floatingCanvas = document.createElement('canvas');
    user.floatingCanvas.width = width;
    user.floatingCanvas.height = height;
    user.floatingCtx = user.floatingCanvas.getContext('2d');

    user.selection = {
      x: Number(msg.sx) || 0,
      y: Number(msg.sy) || 0,
      width,
      height
    };
    user.selectionCorners = {
      tl: { x: user.selection.x, y: user.selection.y },
      tr: { x: user.selection.x + width, y: user.selection.y },
      bl: { x: user.selection.x, y: user.selection.y + height },
      br: { x: user.selection.x + width, y: user.selection.y + height }
    };
    user.originalCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: width, y: 0 },
      bl: { x: 0, y: height },
      br: { x: width, y: height }
    };
    user.originalSelectionPos = { x: -1, y: -1 };

    this._replayBoard.activeSelectionLayer = user.activeLayer ?? 0;

    if (image && user.floatingCtx) {
      user.floatingCtx.drawImage(image, 0, 0, width, height);
    }

    user._cachedPreviewCanvas = null;
    user._cachedPreviewBounds = null;
    this._remoteHandler.selectionHandler.drawFloatingSelection(user);
  }

  /**
   * Replay a flood fill using the same FillTool internals as live remote handling.
   * This preserves pattern fill behavior because the FillTool reads pattern state
   * directly from the replay bot user.
   * @param {User} user
   * @param {Object} msg
   * @returns {Promise<void>}
   * @private
   */
  async _applyFloodFill(user, msg) {
    const fillTool = this._toolManager?.getTool('fill');
    const board = this._replayBoard;
    if (!fillTool || !board || !user) return;

    const width = board.getWidth();
    const height = board.getHeight();
    const x = Math.floor(Number(msg?.sx) || 0);
    const y = Math.floor(Number(msg?.sy) || 0);
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    const layerIndex = msg?.ly ?? user.activeLayer ?? 0;
    const userId = user.id;

    const fillColor = user.color ?? [0, 0, 0, 1];
    const fillR = Math.round(fillColor[0]);
    const fillG = Math.round(fillColor[1]);
    const fillB = Math.round(fillColor[2]);
    // Match local fill behavior: use the opacity slider only so alpha is not applied twice.
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    const userOpacity = opacitySlider;

    board.ensureFullComposite?.();
    const imageData = board.viewCtx.getImageData(0, 0, width, height);
    const imgData = imageData.data;

    const startIdx = (y * width + x) * 4;
    const tR = imgData[startIdx];
    const tG = imgData[startIdx + 1];
    const tB = imgData[startIdx + 2];
    const tA = imgData[startIdx + 3];
    if (tA >= 10) {
      const dr = tR - fillR;
      const dg = tG - fillG;
      const db = tB - fillB;
      const da = tA - 255;
      if (dr * dr + dg * dg + db * db + da * da <= 100) return;
    }

    const expansion = (Number(msg?.s) || 0) / 100;
    const blurRadius = (Number(msg?.br) || 0) / 100;

    let result = await fillTool._fillWorker.computeFill(
      imgData,
      width,
      height,
      x,
      y,
      10,
      expansion,
      null
    );
    if (!result) return;

    const fillLimit = fillTool._isFillTooLarge(result, width, height);
    if (fillLimit) {
      return;
    }

    const blendMode = user.blendMode || 'source-over';
    // Window the active-stroke canvas to the mask instead of the whole board,
    // matching the live path. Only the primary fill's bounds are known here;
    // each mirror copy below grows the window (see DrawingHandlers).
    const bounds = fillTool._fillStrokeBounds(result, [], blurRadius, expansion, width, height);
    board.layerManager.beginUserStroke(layerIndex, userId, blendMode, undefined, bounds);
    let strokeCtx = board.layerManager.getUserStrokeContext(layerIndex, userId);
    if (!strokeCtx) return;
    let origin = board.layerManager.getActiveStroke(layerIndex, userId)?.origin ?? null;

    fillTool._renderMask(
      strokeCtx,
      result,
      fillR,
      fillG,
      fillB,
      userOpacity,
      blurRadius,
      width,
      height,
      user,
      origin
    );

    const pad = Math.ceil(blurRadius * 3) + Math.ceil(Math.abs(expansion));
    const bx = Math.max(0, result.minX - pad);
    const by = Math.max(0, result.minY - pad);
    const bw = Math.min(width, result.maxX + pad + 1) - bx;
    const bh = Math.min(height, result.maxY + pad + 1) - by;
    board.expandDirtyRect(user, bx, by, bw, bh);

    for (const region of board.getActiveMirrorRegions()) {
      if (!region?.synthetic) continue;
      const mirrored = board.mirrorPointToRegion({ x, y }, region);
      const mx = Math.round(mirrored.x);
      const my = Math.round(mirrored.y);
      if (mx < 0 || mx >= width || my < 0 || my >= height) continue;

      let mirrorResult = await fillTool._fillWorker.computeFill(
        board.viewCtx.getImageData(0, 0, width, height).data,
        width,
        height,
        mx,
        my,
        10,
        expansion,
        null
      );

      if (mirrorResult) {
        const mirrorFillLimit = fillTool._isFillTooLarge(mirrorResult, width, height);
        if (mirrorFillLimit) mirrorResult = null;
      }

      if (!mirrorResult) continue;
      // Growing reallocates the canvas (blitting existing paint forward), so
      // both the ctx and the origin have to be re-read afterwards.
      const mBounds = fillTool._fillStrokeBounds(mirrorResult, [], blurRadius, expansion, width, height);
      strokeCtx = board.layerManager.getUserStrokeContext(layerIndex, userId, undefined, undefined, mBounds) || strokeCtx;
      origin = board.layerManager.getActiveStroke(layerIndex, userId)?.origin ?? null;
      // withMirrorRegionClip builds its clip rect in BOARD coordinates, so a
      // windowed ctx is translated here rather than handed `origin`.
      strokeCtx.save();
      strokeCtx.translate(-(origin?.x ?? 0), -(origin?.y ?? 0));
      board.withMirrorRegionClip(strokeCtx, region, () => {
        fillTool._renderMaskComposite(
          strokeCtx,
          mirrorResult,
          fillR,
          fillG,
          fillB,
          userOpacity,
          blurRadius,
          width,
          height,
          user
        );
      });
      strokeCtx.restore();
      const mbx = Math.max(0, mirrorResult.minX - pad);
      const mby = Math.max(0, mirrorResult.minY - pad);
      const mbw = Math.min(width, mirrorResult.maxX + pad + 1) - mbx;
      const mbh = Math.min(height, mirrorResult.maxY + pad + 1) - mby;
      board.expandDirtyRect(user, mbx, mby, mbw, mbh);
    }

    board.layerManager.commitUserStroke(layerIndex, userId);
    board.compositeAllLayers();
  }

  /**
   * Load a pattern payload into a replay-ready object with images attached.
   * @param {string|Object} patternDataInput
   * @returns {Promise<Object|null>}
   * @private
   */
  _loadPatternData(patternDataInput) {
    return new Promise((resolve) => {
      if (!patternDataInput) {
        resolve(null);
        return;
      }

      let patternData;
      try {
        patternData = typeof patternDataInput === 'string'
          ? JSON.parse(patternDataInput)
          : JSON.parse(JSON.stringify(patternDataInput));
      } catch (e) {
        resolve(null);
        return;
      }

      const brushData = patternData?.brush;
      if (!brushData) {
        resolve(null);
        return;
      }

      if (brushData.image || (brushData.type === 'gih' && brushData.images?.length > 0)) {
        resolve(patternData);
        return;
      }

      if (brushData.type === 'gbr' || brushData.type === 'image' || brushData.type === 'svg') {
        this._loadSerializedBrushImage(brushData).then((loadedBrush) => {
          if (loadedBrush) {
            patternData.brush = loadedBrush;
            resolve(patternData);
            return;
          }
          resolve(null);
        });
        return;
      }

      if (brushData.type === 'gih' && brushData.gBrushes?.length > 0) {
        let loadedCount = 0;
        const totalImages = brushData.gBrushes.length;
        const images = brushData.gBrushes.map((brush) => {
          const img = new Image();
          img.onload = () => {
            loadedCount++;
            if (loadedCount === totalImages) {
              brushData.images = images;
              resolve(patternData);
            }
          };
          img.onerror = () => {
            loadedCount++;
            if (loadedCount === totalImages) resolve(null);
          };
          img.src = brush.gimpUrl;
          return img;
        });
        return;
      }

      resolve(patternData);
    });
  }

  _loadSerializedBrushImage(brushData) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        brushData.image = image;
        if (!brushData.width) brushData.width = image.naturalWidth || image.width;
        if (!brushData.height) brushData.height = image.naturalHeight || image.height;
        resolve(brushData);
      };
      image.onerror = () => resolve(null);

      if (brushData.type === 'svg' && brushData.svgContent) {
        const svgBlob = new Blob([brushData.svgContent], { type: 'image/svg+xml' });
        image.src = URL.createObjectURL(svgBlob);
        return;
      }

      if (!brushData.gimpUrl) {
        resolve(null);
        return;
      }

      image.src = brushData.gimpUrl;
    });
  }

  /**
   * Apply a loaded pattern payload to a replay bot without re-triggering async loads.
   * @param {User} user
   * @param {Object|null} patternData
   * @private
   */
  _applyPatternDataToUser(user, patternData) {
    const brushData = patternData?.brush;
    if (!user || !brushData) return;

    user.patternScale = patternData.scale ?? 100;
    user.patternRotation = patternData.rotation ?? 0;
    user.patternSpacing = patternData.spacing ?? 0;
    user.patternOffsetX = patternData.offsetX ?? 0;
    user.patternOffsetY = patternData.offsetY ?? 0;
    user.patternColorMode = patternData.colorMode ?? 'original';
    user.patternBrush = brushData;

    const patternTool = this._toolManager?.getTool('pattern');
    if (patternTool) patternTool._tileCache.clear();
    const fillTool = this._toolManager?.getTool('fill');
    if (fillTool?._patternTileCache) fillTool._patternTileCache.clear();
    const selectTool = this._toolManager?.getTool('select');
    if (selectTool?._patternTileCache) selectTool._patternTileCache.clear();
    const remoteSelectionHandler = this._remoteHandler?.selectionHandler;
    if (remoteSelectionHandler?._patternTileCache) remoteSelectionHandler._patternTileCache.clear();

    this._storePatternState(user, patternData);
  }

  /**
   * Persist the last known pattern state for a replay bot so tools that depend
   * on implicit user state (like selection fill and bucket fill) can recover it.
   * @param {User} user
   * @param {Object|null} [patternData]
   * @private
   */
  _storePatternState(user, patternData = undefined) {
    if (!user || user.id == null) return;

    const existing = this._patternStateByUser.get(user.id) || {};
    this._patternStateByUser.set(user.id, {
      patternData: patternData !== undefined ? patternData : (existing.patternData ?? null),
      patternMode: user.patternMode ?? existing.patternMode ?? false
    });
  }

  /**
   * Rehydrate implicit pattern state for replay users before fill actions.
   * Fill/select replay messages do not carry brush payloads themselves, so they
   * depend on the most recent GPT/CPM state having been restored correctly.
   * @param {User} user
   * @private
   */
  _restorePatternStateForUser(user) {
    if (!user) return;

    const stored = this._patternStateByUser.get(user.id);
    if (!stored) return;

    if (stored.patternMode !== undefined) {
      user.patternMode = !!stored.patternMode;
    }

    if (!user.patternBrush && stored.patternData?.brush) {
      this._applyPatternDataToUser(user, stored.patternData);
    }
  }

  /**
   * Create or update a bot user with the given state.
   * Creates a full User object with per-user preview canvas, just like real remote users.
   * @private
   */
  _createBotUser(id, state = {}) {
    const color = state.color || [0, 0, 0, 255];
    const botOpacity = color[3] > 1 ? color[3] / 255 : color[3];
    const normalizedColor = [
      color[0],
      color[1],
      color[2],
      botOpacity
    ];

    const bot = new User(id, {
      username: state.username || `User ${id}`,
      isSupporter: !!state.isSupporter,
      role: state.role ?? 0,
      x: state.x || 0,
      y: state.y || 0,
      color: normalizedColor,
      opacity: botOpacity,
      size: state.size || 10,
      tool: state.tool || 'brush',
      text: state.text || '',
      pressure: state.pressure ?? 1,
      thinning: state.thinning ?? 0.5,
      simulatePressure: state.simulatePressure ?? true,
      blendMode: state.blendMode || 'source-over',
      // Restore the blend BAKE mode too. Without it the User constructor falls
      // back to 'background', which disables the 'existing' content-mask in
      // commitUserStroke — so every complex-blend stroke committed in a rebuilt
      // tail (scrub / catch-up) renders unmasked/raw, unlike incremental
      // playback where the cbm handler keeps it in sync. Pre-checkpoint CBMs
      // aren't replayed, so this restore is the only way the bot learns it.
      blendBakeMode: state.blendBakeMode,
      // Seed from the engine-wide mode so a bot created after an unattributed
      // CSDM still renders its shapes with it.
      shapeDrawMode: state.shapeDrawMode ?? this._shapeDrawMode,
      activeLayer: state.activeLayer ?? 2,
      patternMode: state.patternMode ?? false,
      patternScale: state.patternScale ?? 100,
      patternRotation: state.patternRotation ?? 0,
      patternSpacing: state.patternSpacing ?? 0,
      patternOffsetX: state.patternOffsetX ?? 0,
      patternOffsetY: state.patternOffsetY ?? 0,
      patternColorMode: state.patternColorMode ?? 'original',
      spacing: state.spacing ?? 0,
      smoothing: state.smoothing ?? 15,
      hardness: state.hardness ?? 100,
      font: state.font,
      textPositionMultiplier: state.textPositionMultiplier,
      textPositionOffset: state.textPositionOffset
    });

    // Per-user preview canvas — same as what UI.createUserBoard provides
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = this.width;
    previewCanvas.height = this.height;
    bot.board = previewCanvas;
    bot.context = previewCanvas.getContext('2d');
    if (bot.context) {
      bot.context.imageSmoothingQuality = 'high';
      bot.context.lineCap = 'round';
      bot.context.lineJoin = 'round';
    }

    // Initialize smoothBuffer for handlers
    bot.smoothBuffer = { x: 0, y: 0, isFirst: true };

    // Re-arm a selection mask carried in from a dynamic checkpoint (see
    // captureDynamicCheckpoint). Must happen after the board exists and before
    // the trailing deltas replay, so the first rebuilt stroke is already
    // clipped.
    if (state.selectionMask) {
      bot.isMaskMode = !!state.isMaskMode;
      bot.maskSelection = state.selectionMask;
      bot.maskLassoPath = state.selectionMask.lassoPath || null;
      this._replayBoard?.setSelectionMask?.(state.selectionMask, id);
    }

    this.botUsers.set(id, bot);
    return bot;
  }

  /**
   * Restore transient per-user replay state from a snapshot.
   * @param {User} bot
   * @param {Object} state
   * @returns {Promise<void>}
   * @private
   */
  async _restoreBotTransientState(bot, state = {}) {
    if (!bot || !state) return;

    bot.mousedown = !!state.mousedown;
    bot.panning = !!state.panning;
    bot.text = state.text ?? bot.text ?? '';
    bot.startPos = state.startPos ? { ...state.startPos } : null;
    bot.currentLine = Array.isArray(state.currentLine) ? state.currentLine.map((pt) => ({ ...pt })) : [];
    bot.lineLength = state.lineLength ?? 0;
    bot.remoteTarget = state.remoteTarget ? { ...state.remoteTarget } : null;
    bot.lassoPoints = Array.isArray(state.lassoPoints) ? state.lassoPoints.map((pt) => ({ ...pt })) : null;
    if (state.lastx !== undefined) bot.lastx = state.lastx;
    if (state.lasty !== undefined) bot.lasty = state.lasty;
    if (state.prevpressure !== undefined) bot.prevpressure = state.prevpressure;
    if (state.smoothBuffer) {
      bot.smoothBuffer = {
        x: state.smoothBuffer.x ?? 0,
        y: state.smoothBuffer.y ?? 0,
        isFirst: state.smoothBuffer.isFirst ?? true
      };
    }

    if (bot.board?.style) {
      bot.board.style.mixBlendMode = bot.blendMode && bot.blendMode !== 'source-over' ? bot.blendMode : 'normal';
    }

    if (state.previewCanvasData && bot.context) {
      await this._loadImageToCanvas(bot.context, state.previewCanvasData);
    }

    this._syncReplayTextPreview(bot);

    if (state.penOffscreenData) {
      // Size the canvas from the SAVED image, not the board: this offscreen
      // is windowed to the stroke's bounds (lag_measured_1440p_realistic_load),
      // and a full-board allocation here would silently misplace the content
      // on drawImage(img, 0, 0) once penOffscreenOrigin isn't {0,0}. Old
      // snapshots (pre-windowing, no origin field) still round-trip: their
      // saved image IS full-board, and origin defaults to {0,0}.
      const { canvas, ctx } = await this._loadImageAsSizedCanvas(state.penOffscreenData);
      bot._penOffscreen = canvas;
      bot._penOffscreenCtx = ctx;
      bot._penOrigin = state.penOffscreenOrigin ? { ...state.penOffscreenOrigin } : { x: 0, y: 0 };
      bot._penStrokeActive = !!state.penStrokeActive;
      bot._penStrokeColor = state.penStrokeColor ?? null;
      bot._penAlpha = state.penAlpha ?? null;
      bot._penHardness = state.penHardness ?? null;
      bot._penLastStampPos = state.penLastStampPos ? { ...state.penLastStampPos } : null;
      bot.penPoints = Array.isArray(state.penPoints) ? state.penPoints.map((pt) => ({ ...pt })) : [];
    }

    if (state.inkOffscreenData) {
      // See the penOffscreenData branch above — same windowed-canvas fix.
      const { canvas, ctx } = await this._loadImageAsSizedCanvas(state.inkOffscreenData);
      bot._inkOffscreen = canvas;
      bot._inkCtx = ctx;
      bot._inkOrigin = state.inkOffscreenOrigin ? { ...state.inkOffscreenOrigin } : { x: 0, y: 0 };
      bot._inkStrokeActive = !!state.inkStrokeActive;
      bot._inkStrokeColor = state.inkStrokeColor ?? null;
      bot._inkAlpha = state.inkAlpha ?? null;
      bot._inkHardness = state.inkHardness ?? null;
      bot._inkSize = state.inkSize ?? null;
      bot._inkPoints = Array.isArray(state.inkPoints) ? state.inkPoints.map((pt) => Array.isArray(pt) ? [...pt] : pt) : [];
    }

    const toolLastStampPositions = state.toolLastStampPositions || {};
    for (const [toolName, lastStampPos] of Object.entries(toolLastStampPositions)) {
      const tool = this._toolManager?.getTool(toolName);
      if (tool?.lastStampPos) {
        tool.lastStampPos.set(bot.id, { ...lastStampPos });
      }
    }

    if (state.patternRemoteOffscreen) {
      const patternTool = this._toolManager?.getTool('pattern');
      if (patternTool) {
        const canvas = document.createElement('canvas');
        canvas.width = this.width;
        canvas.height = this.height;
        const ctx = canvas.getContext('2d');
        await this._loadImageToCanvas(ctx, state.patternRemoteOffscreen.canvasData);
        patternTool.remoteOffscreens.set(bot.id, {
          canvas,
          ctx,
          strokePoints: Array.isArray(state.patternRemoteOffscreen.strokePoints)
            ? state.patternRemoteOffscreen.strokePoints.map((pt) => ({ ...pt }))
            : []
        });
      }
    }

    if (state.selection) bot.selection = { ...state.selection };
    if (state.pendingSelection) bot.pendingSelection = { ...state.pendingSelection };
    if (Array.isArray(state.pendingLassoPath)) {
      bot.pendingLassoPath = state.pendingLassoPath.map((pt) => ({ ...pt }));
    }
    if (Array.isArray(state.lassoPath)) {
      bot.lassoPath = state.lassoPath.map((pt) => ({ ...pt }));
    }
    if (state.selectionCorners) {
      bot.selectionCorners = {
        tl: { ...state.selectionCorners.tl },
        tr: { ...state.selectionCorners.tr },
        br: { ...state.selectionCorners.br },
        bl: { ...state.selectionCorners.bl }
      };
    }
    if (state.originalCorners) {
      bot.originalCorners = {
        tl: { ...state.originalCorners.tl },
        tr: { ...state.originalCorners.tr },
        br: { ...state.originalCorners.br },
        bl: { ...state.originalCorners.bl }
      };
    }
    if (state.originalSelectionPos) {
      bot.originalSelectionPos = { ...state.originalSelectionPos };
    }
    if (state.floatingCanvasData) {
      const canvas = document.createElement('canvas');
      canvas.width = state.floatingCanvasWidth || this.width;
      canvas.height = state.floatingCanvasHeight || this.height;
      const ctx = canvas.getContext('2d');
      await this._loadImageToCanvas(ctx, state.floatingCanvasData);
      bot.floatingCanvas = canvas;
      bot.floatingCtx = ctx;
    }
    if (state.cachedSelectionPreviewData) {
      const canvas = document.createElement('canvas');
      const bounds = state.cachedSelectionPreviewBounds || {};
      canvas.width = bounds.width || this.width;
      canvas.height = bounds.height || this.height;
      const ctx = canvas.getContext('2d');
      await this._loadImageToCanvas(ctx, state.cachedSelectionPreviewData);
      bot._cachedPreviewCanvas = canvas;
      bot._cachedPreviewBounds = state.cachedSelectionPreviewBounds
        ? { ...state.cachedSelectionPreviewBounds }
        : null;
    }
    if (state.selectionRestoreData) {
      bot._selectionRestoreData = {
        eraseS: state.selectionRestoreData.eraseS ? { ...state.selectionRestoreData.eraseS } : null,
        eraseLassoPath: Array.isArray(state.selectionRestoreData.eraseLassoPath)
          ? state.selectionRestoreData.eraseLassoPath.map((pt) => ({ ...pt }))
          : null,
        eraseTimestamp: state.selectionRestoreData.eraseTimestamp,
        eraseUserId: state.selectionRestoreData.eraseUserId,
        snapshots: []
      };

      for (const snap of state.selectionRestoreData.snapshots || []) {
        if (!snap.canvasData) continue;
        const canvas = document.createElement('canvas');
        canvas.width = snap.width || this.width;
        canvas.height = snap.height || this.height;
        const ctx = canvas.getContext('2d');
        await this._loadImageToCanvas(ctx, snap.canvasData);
        bot._selectionRestoreData.snapshots.push({
          groupIdx: snap.groupIdx,
          canvas,
          x: snap.x,
          y: snap.y
        });
      }
    }

    if (bot.floatingCanvas && bot.selection) {
      this._replayBoard.activeSelectionLayer = bot.activeLayer ?? 0;
      bot.context?.clearRect(0, 0, this.width, this.height);
      this._remoteHandler.selectionHandler.drawFloatingSelection(bot);
      bot._replaySelectionPreviewActive = true;
    } else if (bot.pendingSelection) {
      bot.context?.clearRect(0, 0, this.width, this.height);
      this._remoteHandler.selectionHandler.drawPendingSelection(bot);
      bot._replaySelectionPreviewActive = true;
    } else if (bot.tool === 'select' && bot.context) {
      bot.context.clearRect(0, 0, this.width, this.height);
      bot._replaySelectionPreviewActive = false;
    }
  }

  _renderReplaySelections() {
    const selectionHandler = this._remoteHandler?.selectionHandler;
    if (!selectionHandler) return;

    let activeSelectionLayer = -1;
    for (const user of this.botUsers.values()) {
      const hasFloatingSelection = !!(user.floatingCanvas && user.selection && !user.pendingImageLoad);
      const hasPendingSelection = !!user.pendingSelection;
      // An active mask is persistent UI, unlike a pending selection: it stays
      // on screen for as long as the user keeps drawing under it. It has to be
      // redrawn from here every frame rather than painted once when SEL_MASK
      // arrives, because this loop clears user.context on any frame the user
      // has no selection — which would wipe a one-shot outline immediately.
      const hasMask = !!(user.isMaskMode && user.maskSelection);

      if (hasFloatingSelection || hasPendingSelection || hasMask) {
        const drawOutline = this.renderSelectionOverlay !== false;
        user.context?.clearRect(0, 0, this.width, this.height);
        if (hasFloatingSelection) {
          activeSelectionLayer = user.activeLayer ?? activeSelectionLayer;
          selectionHandler.drawFloatingSelection(user, drawOutline);
        } else if (hasPendingSelection && drawOutline) {
          // Pending selections are pure UI (a dashed rect, no content), so
          // there's nothing to draw when selection overlays are hidden.
          selectionHandler.drawPendingSelection(user);
        } else if (hasMask && drawOutline) {
          // clear=false: the context was just cleared above.
          selectionHandler.drawStaticMaskOutline(user, user.maskSelection, false);
        }
        user._replaySelectionPreviewActive = true;
      } else if (user._replaySelectionPreviewActive && user.context) {
        user.context.clearRect(0, 0, this.width, this.height);
        user._replaySelectionPreviewActive = false;
      }
    }

    this._replayBoard.activeSelectionLayer = activeSelectionLayer;
  }

  /**
   * Restore in-progress LayerManager strokes from a snapshot.
   * @param {Array<Array<Object>>} activeStrokeGroups
   * @returns {Promise<void>}
   * @private
   */
  async _restoreActiveStrokes(activeStrokeGroups = []) {
    for (let groupIdx = 0; groupIdx < activeStrokeGroups.length; groupIdx++) {
      const group = this._replayBoard.layerManager.layerGroups[groupIdx];
      if (!group) continue;

      for (const strokeData of activeStrokeGroups[groupIdx] || []) {
        // A checkpoint saved from a windowed active-stroke canvas (see
        // docs/scope_layermanager_active_stroke_windowing_RESULT.md) carries
        // canvasOrigin/canvasWidth/canvasHeight — allocate the SAME window
        // instead of defaulting to full-board, so a checkpoint round-trip
        // doesn't silently un-window (and re-inflate memory) every restore.
        // Undefined for a full-board stroke or an older checkpoint predating
        // this field, which keeps today's full-board allocation exactly.
        const windowed = !!strokeData.canvasOrigin;
        const canvas = document.createElement('canvas');
        canvas.width = windowed ? strokeData.canvasWidth : this.width;
        canvas.height = windowed ? strokeData.canvasHeight : this.height;
        const ctx = canvas.getContext('2d');
        const originX = windowed ? strokeData.canvasOrigin.x : 0;
        const originY = windowed ? strokeData.canvasOrigin.y : 0;
        // QOI form (layerStateCodec) is cropped to its dirty rect and drawn at
        // (x, y) onto the active canvas — board-absolute for a full-board
        // canvas, canvas-local (offset by origin) for a windowed one; the
        // legacy form is a full-size dataURL drawn at the origin.
        if (strokeData.qoi) {
          const cropped = qoiToCanvas(strokeData.qoi);
          if (cropped) ctx.drawImage(cropped, (strokeData.x ?? 0) - originX, (strokeData.y ?? 0) - originY);
        } else {
          await this._loadImageToCanvas(ctx, strokeData.canvasData);
        }

        const active = {
          canvas,
          ctx,
          origin: windowed ? { x: originX, y: originY } : null,
          x: originX,
          y: originY,
          blendMode: strokeData.blendMode ?? 'source-over',
          blendBakeMode: normalizeBlendBakeMode(strokeData.blendBakeMode),
          dirtyRect: strokeData.dirtyRect
            ? { ...strokeData.dirtyRect }
            : { minX: this.width, minY: this.height, maxX: -1, maxY: -1 },
          affectedTiles: new Set(strokeData.affectedTiles || [])
        };

        if (strokeData.filterType) {
          active.filterType = strokeData.filterType;
          active.blurRadius = strokeData.blurRadius;
          if (strokeData.maskQoi) {
            active.maskCanvas = qoiToCanvas(strokeData.maskQoi) || canvas;
          } else if (strokeData.maskCanvasData) {
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = this.width;
            maskCanvas.height = this.height;
            const maskCtx = maskCanvas.getContext('2d');
            await this._loadImageToCanvas(maskCtx, strokeData.maskCanvasData);
            active.maskCanvas = maskCanvas;
          } else {
            active.maskCanvas = canvas;
          }
        }

        group.activeStrokeByUser.set(strokeData.userId, active);
      }
    }

    this._replayBoard.layerManager.needsComposite = true;
  }

  /**
   * Get or create a bot user.
   * @private
   */
  _getOrCreateBot(id) {
    if (!this.botUsers.has(id)) {
      this._createBotUser(id);
    }
    return this.botUsers.get(id);
  }

  /**
   * Process a batch of actions.
   * @param {Array<{timestamp: number, msg: Object}>} actions - Actions to replay (JSON messages)
   * @param {number} [upToTimestamp] - Only process actions up to this timestamp
   * @param {{shouldCancel?: () => boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async processActions(actions, upToTimestamp = Infinity, options = {}) {
    return await this._runActionBatch(actions, upToTimestamp, { rebaseSnapshot: true, ...options });
  }

  /**
   * Append actions to the current replay state without rebuilding from snapshot.
   * Used for smoother forward playback once a replay state is already loaded.
   * @param {Array<{timestamp: number, msg: Object}>} actions
   * @param {number} [upToTimestamp]
   * @param {{shouldCancel?: () => boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async appendActions(actions, upToTimestamp = Infinity, options = {}) {
    return await this._runActionBatch(actions, upToTimestamp, { rebaseSnapshot: false, ...options });
  }

  /**
   * Internal helper for replay action execution.
   * `onProgress(i)` reports the index of the last fully-applied action at each
   * yield point (and once after the loop), so a caller whose batch gets
   * cancelled mid-way knows exactly how far the engine state advanced.
   * @param {Array<{timestamp: number, msg: Object}>} actions
   * @param {number} upToTimestamp
   * @param {{rebaseSnapshot: boolean, shouldCancel?: () => boolean, onProgress?: (lastAppliedIndex: number) => void}} options
   * @private
   */
  async _runActionBatch(actions, upToTimestamp, { rebaseSnapshot, shouldCancel, onProgress }) {
    if (shouldCancel?.()) return false;
    if (rebaseSnapshot) {
      // Whole canvas changes — discard any in-flight dirty rects and force a
      // full composite at the end of this batch.
      this._replayBoard._fullComposite = true;
      this._replayBoard._compositeDirtyRects.length = 0;
    }
    if (rebaseSnapshot && this._snapshotCanvas && !this._snapshotHasLayerState) {
      const layer0 = this._replayBoard.layerManager.layerGroups[0];
      if (layer0) {
        if (!layer0.flatCanvas) {
          layer0.flatCanvas = document.createElement('canvas');
          layer0.flatCanvas.width = this.width;
          layer0.flatCanvas.height = this.height;
          layer0.flatCtx = layer0.flatCanvas.getContext('2d');
        }
        layer0.flatCtx.clearRect(0, 0, this.width, this.height);
        layer0.flatCtx.drawImage(this._snapshotCanvas, 0, 0);
      }
      this._replayBoard.viewCtx.clearRect(0, 0, this.width, this.height);
      this._replayBoard.viewCtx.drawImage(this._snapshotCanvas, 0, 0);
    }
    if (shouldCancel?.()) return false;

    await Promise.all([
      this._preloadBrushImages(actions, upToTimestamp),
      this._preloadPatternImages(actions, upToTimestamp),
      this._preloadGlitchResults(actions, upToTimestamp),
      this._preloadImagePastes(actions, upToTimestamp)
    ]);
    if (shouldCancel?.()) return false;

    let lastProcessed = -1;
    for (let i = 0; i < actions.length; i++) {
      if ((i & 63) === 0) {
        if (lastProcessed >= 0) onProgress?.(lastProcessed);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (shouldCancel?.()) return false;
      }
      const action = actions[i];
      if (action.timestamp > upToTimestamp) break;

      const msg = action.msg;
      if (msg && msg.u != null && (msg.t === T.MD || msg.t === T.MM || msg.t === T.MU)) {
        const user = this._getOrCreateBot(msg.u);
        // Track cursor activity so idle cursors can be hidden during render,
        // matching the live 5s idle-hide behavior.
        user._lastCursorTs = action.timestamp;
        if (user.tool === 'circleBlur' || user.tool === 'inkdropper' || user.tool === 'fill') {
          this._replayBoard._doComposite();
        }
      }

      await this._processAction(action.msg, action.timestamp);
      lastProcessed = i;
    }
    this._currentReplayTs = upToTimestamp;
    if (lastProcessed >= 0) onProgress?.(lastProcessed);
    if (shouldCancel?.()) return false;

    this._compositeOutput();
    return true;
  }

  /**
   * Internal helper to ensure a value is a standard array of numbers.
   * Handles cases where TypedArrays might have been serialized to JSON as objects.
   * @param {*} val - Value to check
   * @returns {number[]}
   * @private
   */
  _ensureArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    
    // Check for typed array or object-like serialization: {"0": 1, "1": 2}
    if (typeof val === 'object') {
      const keys = Object.keys(val).filter(k => !isNaN(k));
      if (keys.length > 0) {
        const arr = new Array(keys.length);
        for (const k of keys) {
          arr[parseInt(k, 10)] = Number(val[k]);
        }
        return arr;
      }
      
      // Handle TypedArrays directly if they aren't standard arrays
      if (val.length !== undefined) {
        return Array.from(val);
      }
    }
    return [Number(val)];
  }

  _parseMirrorRegionsFromMessage(msg) {
    if (Array.isArray(msg?.mirrorRegions)) return msg.mirrorRegions;
    if (typeof msg?.mirrorRegionsJson !== 'string') return null;
    try {
      const parsed = JSON.parse(msg.mirrorRegionsJson);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  _applySettingsMessage(msg) {
    if (!msg) return;
    if (msg.m !== undefined || msg.mirror !== undefined) {
      this.mirror = msg.m !== undefined ? !!msg.m : !!msg.mirror;
      this._replayBoard?.setMirror(this.mirror);
    }
    const mirrorRegions = this._parseMirrorRegionsFromMessage(msg);
    if (mirrorRegions) {
      this._replayBoard?.setMirrorRegions(mirrorRegions);
    }
    if (Array.isArray(msg.roomBackgroundColor)) {
      this.backgroundColor = [...msg.roomBackgroundColor];
      if (this._replayBoard) this._replayBoard.backgroundColor = [...msg.roomBackgroundColor];
    }
  }

  _applyMirrorRegionMessage(msg) {
    if (!msg?.mirrorRegionsJson || !this._replayBoard) return;
    let payload = null;
    try {
      payload = JSON.parse(msg.mirrorRegionsJson);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object' || !payload.action) return;

    const current = this._replayBoard.mirrorRegions || [];
    if ((payload.action === 'create' || payload.action === 'update') && payload.region) {
      const id = String(payload.region.id || '');
      const existingIndex = id ? current.findIndex((region) => region.id === id) : -1;
      const next = [...current];
      if (existingIndex >= 0) {
        next[existingIndex] = payload.region;
      } else {
        next.push(payload.region);
      }
      this._replayBoard.setMirrorRegions(next);
      return;
    }

    if (payload.action === 'remove') {
      const id = payload.id || payload.region?.id;
      if (!id) return;
      this._replayBoard.setMirrorRegions(current.filter((region) => region.id !== id));
    }
  }

  /**
   * Process a single action message (already decoded JSON).
   * Routes drawing actions through the real RemoteUserHandler.
   * @param {Object} msg - Decoded action message.
   * @param {number} [actionTs] - Tape timestamp of this action (ms). Used to
   *   anchor vector text fade timing to the playhead.
   * @private
   */
  async _processAction(msg, actionTs = this._currentReplayTs) {
    if (!msg) return;

    if (msg.t === T.SETTINGS) {
      this._applySettingsMessage(msg);
      return;
    }

    if (msg.t === T.MIRROR_REGION) {
      this._applyMirrorRegionMessage(msg);
      return;
    }

    // Shape draw mode is per-user, but must still be handled before the userId
    // guard: the recorder's structuredClone drops proto3 default scalars, so a
    // CSDM from session 0 arrives with msg.u undefined and would be dropped.
    if (msg.t === T.CSDM) {
      this._applyShapeDrawMode(msg.sdm, msg.u ?? null);
      return;
    }

    // Board-level restores ("undo to here" / "undo region to here" / moderator
    // restore) carry no owning user — the wire has no `u`, and the recorder's
    // structuredClone drops proto3 default scalars, so msg.u is `undefined`
    // here for every receiver's recorded tape. Handle them BEFORE the
    // `userId == null` guard below; otherwise the restore silently no-ops in
    // replay for everyone except the initiator (whose outbound copy stamped a
    // real `u`) — which is why a late-joiner's timeline appeared frozen on the
    // pre-undo board even though their live board reverted correctly.
    if (msg.t === T.BOARD_SNAPSHOT_RESTORE) {
      if (Array.isArray(msg.snapshotLayers) && msg.snapshotLayers.length > 0) {
        this._replayBoard.restoreSnapshot(msg.snapshotLayers);
        // The opening-snapshot base no longer applies once the board has been
        // wholesale-replaced — clear it like CLR does so a later seek rebuild
        // doesn't repaint stale pixels under the restored state. Same for the
        // snapshot's top-canvas overlay: previews captured mid-stroke are
        // stale over a replaced board.
        this._snapshotCtx?.clearRect(0, 0, this.width, this.height);
        this.topCtx?.clearRect(0, 0, this.width, this.height);
        this._snapshotTopOverlayUsers.clear();
      }
      return;
    }

    // A full-board clear is board-level too, and the client sends CLR with no
    // `u` at all (the server stamps it on relay). Session 0's stamped u=0 is a
    // proto3 default, so it never reaches the wire and structuredClone drops it
    // from the recorded tape — msg.u is `undefined` on every receiver's copy.
    // Below the guard this silently no-opped for everyone except the initiator,
    // whose outbound copy stamped a real `u`, so a cleared board kept replaying
    // its pre-clear contents. Same failure as BOARD_SNAPSHOT_RESTORE above.
    if (msg.t === T.CLR) {
      this._replayBoard.layerManager.clearAll();
      // Mirrors Board.clear(): the stroke contexts the clip ledger names are
      // gone, and a stale key would make the next stroke under a still-active
      // mask skip its clip entirely.
      this._replayBoard.resetSelectionMaskClipTracking();
      this._snapshotCtx?.clearRect(0, 0, this.width, this.height);
      return;
    }

    if (msg.t === T.BOARD_SNAPSHOT_REGION_RESTORE) {
      if (Array.isArray(msg.snapshotLayers) && msg.snapshotLayers.length > 0) {
        this._replayBoard.restoreRegion(msg.snapshotLayers, {
          isLasso: !!msg.a,
          sx: msg.sx, sy: msg.sy, sw: msg.sw, sh: msg.sh,
          lassoFlat: Array.isArray(msg.cr) ? msg.cr : []
        });
        // A region restore only rewrites part of the board, so the opening
        // snapshot base still applies to the rest — don't clear _snapshotCtx.
      }
      return;
    }

    const userId = msg.u;
    if (userId == null) return;

    const user = this._getOrCreateBot(userId);

    // Snapshot top-overlay retirement: MU/CANCEL ends a stroke that was in
    // progress at snapshot time (MD counts too, in case the matching MU fell
    // off the tape). When the last such stroke ends, drop the flat overlay —
    // the stroke now lives in the layer system where UNDO can reach it.
    if (
      (msg.t === T.MU || msg.t === T.CANCEL || msg.t === T.MD) &&
      this._snapshotTopOverlayUsers.delete(userId) &&
      this._snapshotTopOverlayUsers.size === 0
    ) {
      this.topCtx?.clearRect(0, 0, this.width, this.height);
    }

    try {
      switch (msg.t) {
        case T.MD:
          this._remoteHandler.handleMouseDown(user, {
            ps: this._ensureArray(msg.ps),
            rs: this._ensureArray(msg.rs),
            confettiData: msg.g ?? null,
            layerIndex: msg.ly,
            blendMode: msg.bm,
            blendBakeMode: msg.bbm === 'background' ? 'background' : (msg.bbm === 'existing' ? 'existing' : undefined),
          });
          break;

        case T.MM:
          this._remoteHandler.handleMouseMove(user, {
            ps: this._ensureArray(msg.ps),
            rs: this._ensureArray(msg.rs),
            confettiData: msg.g ?? null,
          });
          break;

        case T.MU:
          this._remoteHandler.handleMouseUp(user);
          break;

        case T.CT:
          if (msg.l !== undefined) {
            const newTool = ToolNames[msg.l] || 'brush';

            // Mirror the live `ct` handler (DrawingHandlers.js): switching away
            // from select while a floating/pending selection is still dangling
            // (no SEL_COMMIT/SEL_CANCEL was recorded) must clean it up, exactly
            // as remote users do. Otherwise the stale selection stays stuck on
            // the replay and flickers under subsequent drawing.
            if (newTool !== 'select' && !user.isMaskMode && (user.floatingCanvas || user.pendingSelection)) {
              if (user.floatingCanvas) {
                this._remoteHandler.selectionHandler.handleSelectionCancel(user);
              } else {
                user.pendingSelection = null;
                user.pendingLassoPath = null;
                user.context?.clearRect(0, 0, this.width, this.height);
              }
            }

            user.setTool(newTool);
            if (newTool === 'blur' && user.context) {
              user.context.clearRect(0, 0, this.width, this.height);
            }
            this._syncReplayTextPreview(user);
          }
          if (msg.a !== undefined) {
            user.eraseAllLayers = msg.a;
          }
          break;

        case T.CC:
          if (msg.c !== undefined) {
            const c = msg.c;
            const opacity = (c & 0xFF) / 255;
            user.setColor([
              (c >>> 24) & 0xFF,
              (c >>> 16) & 0xFF,
              (c >>> 8) & 0xFF,
              opacity
            ]);
            user.setOpacity(opacity);
            this._syncReplayTextPreview(user);
          }
          break;

        case T.CS:
          if (msg.s !== undefined) {
            if (user.mousedown && user.tool === 'brush' && !user._penStrokeActive && !user._inkStrokeActive) {
              this._remoteHandler.commitLine(user, user.pressure, msg.s / 100);
            }
            user.setSize(msg.s / 100);
            this._syncReplayTextPreview(user);
          }
          break;

        case T.CP:
          if (msg.p !== undefined) {
            if (user.mousedown && user.tool === 'brush' && !user._penStrokeActive && !user._inkStrokeActive) {
              this._remoteHandler.commitLine(user, (msg.p ?? 100) / 100, user.size);
            }
            user.setPressure((msg.p ?? 100) / 100);
          }
          break;

        case T.CSP:
          if (msg.sp !== undefined) {
            user.setSpacing(msg.sp / 100);
          }
          break;

        case T.CSM:
          if (msg.sm !== undefined) {
            user.setSmoothing(msg.sm);
          }
          break;

        case T.CHD:
          if (msg.hd !== undefined) {
            user.setHardness(msg.hd);
          }
          break;

        case T.CTHN:
          if (msg.th !== undefined) {
            user.setThinning((msg.th - 1) / 100);
          }
          break;

        case T.CSIM:
          if (msg.sim !== undefined) {
            user.setSimulatePressure(msg.sim === 2);
          }
          break;

        case T.CBM:
          if (msg.bm !== undefined) {
            user.setBlendMode(msg.bm);
            this._syncReplayTextPreview(user);
          }
          // Match the live `cbm` handler — it sets the bake mode too. Dropping it
          // here leaves the bot on its default ('background'), so any later
          // blend stroke (notably glitch, which begins its stroke late at
          // GLITCH_RESULT) composites against nothing instead of overlaying the
          // board content.
          if (msg.bbm !== undefined) {
            user.setBlendBakeMode(normalizeBlendBakeMode(msg.bbm));
          }
          break;

        case T.CF:
          if (msg.fo) {
            user.setFont(msg.fo);
            // tm/to of 0 are proto3 defaults and get dropped from the tape —
            // fall back to the font's own layout defaults rather than keeping
            // a stale multiplier/offset from the previous font.
            const fontDefaults = getTextFontDefaults(msg.fo);
            user.setTextPositionMultiplier(msg.tm !== undefined ? msg.tm : fontDefaults.textPositionMultiplier);
            user.setTextPositionOffset(msg.to !== undefined ? msg.to : fontDefaults.textPositionOffset);
            this._syncReplayTextPreview(user);
          }
          break;

        case T.CL:
          if (msg.ly !== undefined) {
            user.setActiveLayer(msg.ly);
          }
          break;

        case T.CBR:
          if (msg.br !== undefined) {
            user.setBlurRadius(msg.br);
          }
          break;

        case T.CPM:
          user.patternMode = !!msg.pm;
          this._storePatternState(user);
          break;

        case T.MIR:
          // Prefer the absolute post-toggle state when the recorder stamped it
          // (our own outbound toggles); fall back to a relative flip for
          // inbound/legacy MIRs that carry no `m`. Re-asserting from absolute
          // means a single dropped MIR can't strand global mirror inverted.
          this.mirror = msg.m !== undefined ? !!msg.m : !this.mirror;
          this._replayBoard.mirror = this.mirror;
          break;

        case T.CANCEL:
          // Cancel current stroke — clean up user state
          if (user.mousedown) {
            user.mousedown = false;
            user.clearLine();
            user._inkStrokeActive = false;
            user._penStrokeActive = false;
            user.startPos = null;
            // Discard the active stroke for this user
            const lm = this._replayBoard.layerManager;
            if (user.eraseAllLayers) {
              const count = lm.getLayerCount();
              for (let i = 0; i < count; i++) {
                lm.cancelUserStroke?.(i, user.id);
              }
            } else {
              lm.cancelUserStroke?.(user.activeLayer, user.id);
            }
          }
          break;

        case T.KP:
          if (msg.k !== undefined) {
            if (user.tool !== 'text') {
              user.setTool('text');
            }
            this._remoteHandler.handleKeyPress(user, msg.k);
            this._syncReplayTextPreview(user);
          }
          break;

        case T.TEXT_APPLY: {
          const isPixel = !!msg.textPixel;
          const data = {
            id: msg.textId || null,
            text: msg.g || '',
            position: {
              x: Array.isArray(msg.ps) ? msg.ps[0] : user.x,
              y: Array.isArray(msg.ps) ? msg.ps[1] : user.y
            },
            size: msg.s !== undefined ? msg.s / 100 : user.size,
            color: unpackColor(msg.c),
            opacity: msg.p !== undefined ? msg.p / 100 : user.opacity,
            layerIndex: msg.ly ?? user.activeLayer ?? 0,
            blendMode: msg.bm || user.blendMode || 'source-over',
            blendBakeMode: normalizeBlendBakeMode(msg.bbm),
            font: msg.fo || user.font,
            textPositionMultiplier: msg.tm,
            textPositionOffset: msg.to,
            pixel: isPixel
          };
          if (isPixel) {
            // Pixel-mode text rasterizes as a permanent stroke on the replay layer.
            this._remoteHandler.handleTextApply(user, data);
          } else {
            // Vector-mode text is an ephemeral fading record. The replay board has
            // no textOverlay, so the engine tracks the record itself and fades it
            // against the playhead (see _addVectorTextRecord / drawVectorText).
            this._addVectorTextRecord(user, msg, data, actionTs);
            // Mirror handleTextApply's preview teardown: stop showing the
            // in-progress typing preview now that the text is committed.
            user.text = '';
            user.context?.clearRect(0, 0, this.width, this.height);
          }
          this._syncReplayTextPreview(user);
          break;
        }

        case T.TEXT_REMOVE:
          // Eraser / explicit removal of a floating vector text record.
          if (msg.textId) this._vectorTextRecords.delete(msg.textId);
          break;

        case T.FILL:
          if (msg.sx !== undefined && msg.sy !== undefined) {
            this._restorePatternStateForUser(user);
            user.setPosition(Number(msg.sx), Number(msg.sy));
            await this._applyFloodFill(user, msg);
          }
          break;

        case T.GMP:
          // Brush images were pre-loaded into _brushCache by _preloadBrushImages().
          // Apply the cached brush to the user synchronously.
          if (msg.g) {
            const brushKey = typeof msg.g === 'string' ? msg.g : JSON.stringify(msg.g);
            const cached = this._brushCache?.get(brushKey);
            if (cached) {
              user.imageBrush = cached;
            }
          }
          break;

        case T.GPT:
          // Pattern images were pre-loaded into _patternCache by _preloadPatternImages().
          {
            const patternPayload = this._getPatternPayload(msg);
            const patternKey = typeof patternPayload === 'string'
              ? patternPayload
              : (patternPayload ? JSON.stringify(patternPayload) : null);
            const cached = patternKey ? this._patternCache?.get(patternKey) : null;
            if (cached) {
              this._applyPatternDataToUser(user, cached);
            }
          }
          break;

        case T.GLITCH_RESULT:
          // Glitch result images were pre-loaded into _glitchResultCache by _preloadGlitchResults().
          if (msg.g) {
            const glitchKey = `${userId}_${msg.sx}_${msg.sy}_${msg.sw}_${msg.sh}`;
            const cached = this._glitchResultCache?.get(glitchKey);
            if (cached) {
              const bounds = { x: Number(msg.sx), y: Number(msg.sy), width: Number(msg.sw), height: Number(msg.sh) };
              // glitchBlur strokes are NOT committed on MU ("committed when
              // GLITCH_RESULT arrives") — so the result must CREATE the stroke,
              // exactly like the live 'glitch_result' handler does via
              // queue/resolve → commitRemoteGlitchImage. applyRemoteGlitchResult
              // only attaches to an already-committed glitch stroke (which never
              // exists in replay), so it would buffer the result forever and the
              // glitch would never render.
              const token = this._remoteHandler.queueRemoteGlitchImage(user, bounds, msg.ly, msg.seq, msg.bm || null, msg.bbm || null);
              if (token) this._remoteHandler.resolveRemoteGlitchImage(token, cached);
            }
          }
          break;

        case T.SEL_LIFT:
          {
            this._remoteHandler.selectionHandler.handleSelectionLift(
              user,
              this._decodeSelectionRect(msg),
              this._decodePointPath(msg.cr),
              msg.g || null,
              !!msg.a,
              undefined,
              !!msg.selExtendedWarp,
              !!msg.m
            );
            if (user.pendingImageLoad) {
              await user.pendingImageLoad;
            }
          }
          break;
        case T.SEL_PENDING:
          this._remoteHandler.selectionHandler.handleSelectionPending(
            user,
            this._decodeSelectionRect(msg),
            this._decodePointPath(msg.ps)
          );
          break;
        case T.SEL_MOVE:
          {
            const corners = this._decodeSelectionCorners(msg);
            if (corners) {
              this._remoteHandler.selectionHandler.handleSelectionMove(
                user,
                corners,
                this._decodeSelectionSourceCrop(msg),
                !!msg.selExtendedWarp
              );
            }
          }
          break;
        case T.SEL_COMMIT:
          this._remoteHandler.selectionHandler.handleSelectionCommit(user, msg.ly ?? 0, 0, !!msg.selExtendedWarp, !!msg.m);
          break;
        case T.SEL_DELETE:
          // Replay commits all strokes at seq=0 and orders by timestamp (MU is
          // replayed via handleMouseUp() with no seq). Passing the wire seq here
          // would sort the destination-out erase BELOW every seq=0 stroke, so it
          // would stop erasing them and the clear would vanish from the replay.
          // The all-layers and mirror flags still apply — they describe WHAT was
          // erased, not the ordering, so dropping them replayed an all-layers or
          // mirrored clear as a single unmirrored one.
          this._remoteHandler.selectionHandler.handleSelectionDelete(user, msg.ly ?? 0, 0, !!msg.a, !!msg.m);
          break;
        case T.SEL_FILL:
          this._restorePatternStateForUser(user);
          this._remoteHandler.selectionHandler.handleSelectionFill(
            user, unpackColor(msg.c), msg.ly ?? 0,
            msg.sw ? { x: msg.sx || 0, y: msg.sy || 0, width: msg.sw, height: msg.sh || 0 } : null,
            0,
            // Seeking replays out of order too, so the fill's own lasso shape is
            // as necessary here as it is on a sync tail.
            this._decodePointPath(msg.ps),
            !!msg.m);
          break;
        case T.SEL_STAMP:
          this._remoteHandler.selectionHandler.handleSelectionStamp(user, msg.ly ?? 0, 0, !!msg.selExtendedWarp, !!msg.m);
          break;
        case T.SEL_MERGE:
          this._remoteHandler.selectionHandler.handleSelectionMerge(user, msg.g || 'down', msg.ly ?? 0);
          break;
        case T.SEL_FLIP:
          this._remoteHandler.selectionHandler.handleSelectionFlip(user);
          break;
        case T.SEL_CANCEL:
          this._remoteHandler.selectionHandler.handleSelectionCancel(user);
          break;
        case T.SEL_MASK:
          // The mask is per-user drawing state, not a commit: it owns no pixels
          // of its own but clips every stroke the user makes while it is on.
          // Replay ignored it entirely, so the time machine drew masked strokes
          // running past the mask edge while every live client had clipped them.
          //
          // Mirrors the live 'sel_mask' handler in SelectionHandlers.js, minus
          // the local-overlay half (replay has no local user). The outline
          // itself is drawn by _renderReplaySelections off isMaskMode +
          // maskSelection, not here — see the note there.
          if (msg.mk) {
            const mask = {
              ...this._decodeSelectionRect(msg),
              lassoPath: this._decodePointPath(msg.ps)
            };
            user.isMaskMode = true;
            user.pendingSelection = null;
            user.pendingLassoPath = null;
            user._pendingSelectionUpdatedAt = null;
            user.maskSelection = mask;
            user.maskLassoPath = mask.lassoPath;
            this._replayBoard.setSelectionMask(mask, user.id);
          } else {
            user.isMaskMode = false;
            user.maskSelection = null;
            user.maskLassoPath = null;
            user._pendingSelectionUpdatedAt = null;
            this._replayBoard.clearSelectionMask(user.id);
          }
          break;
        case T.SEL_TO_BRUSH:
          this._remoteHandler.selectionHandler.handleSelectionToBrush(user, msg.g);
          break;
        case T.IMG_PASTE:
          {
            const cached = msg.g ? this._imagePasteCache?.get(msg.g) ?? null : null;
            if (cached) {
              this._applyImagePaste(user, msg, cached);
            } else {
              this._remoteHandler.selectionHandler.handleImagePaste(user, {
                x: msg.sx,
                y: msg.sy,
                width: msg.sw,
                height: msg.sh,
                imageData: msg.g
              });
            }
          }
          break;

        case T.UNDO:
          // Deliberately NOT passing msg.undoTargetSeq. Replay commits every
          // stroke at seq 0 and orders by timestamp (MU replays through
          // handleMouseUp() with no seq) — same convention SEL_DELETE documents
          // below — so a seq lookup can never match here and would only fall
          // through to this same call. Passing it would imply replay honours the
          // target, and it would quietly start undoing the wrong stroke if the
          // tape ever carried real seqs while the strokes did not.
          this._replayBoard.undo(user.activeLayer, userId);
          break;

        case T.REDO:
          this._replayBoard.redo(userId);
          break;
      }
    } catch (err) {
      console.warn(`[ReplayEngine] Error processing action t=${msg.t} for user ${userId}:`, err);
    }
  }

  /**
   * Composite the final output: snapshot + LayerManager strokes + per-user previews.
   * @private
   */
  _compositeOutput() {
    if (!this.outputCtx) return;

    //    Composite all layers (background + snapshot base + strokes + filters)
    //    into the replay board's viewCtx. Blur filters will now read from
    //    viewCtx which contains the snapshot content beneath them.
    this._replayBoard._doComposite();

    //    Render everything to the output canvas
    this._renderToOutput();

    //    Set up callback so that when async blur worker finishes,
    //    we re-composite and update the replay canvas automatically.
    //    We check needsComposite to avoid infinite loops if nothing changed.
    this._replayBoard._onLayerUpdate = () => {
      if (this._replayBoard.layerManager?.needsComposite) {
        this._replayBoard._doComposite();
        this._renderToOutput();
        // Notify TimeMachine to refresh the visible replay canvas
        if (this.onOutputUpdate) this.onOutputUpdate();
      }
    };
  }

  /**
   * Internal helper to draw the current board state and user previews to the output canvas.
   * @private
   */
  _renderToOutput() {
    const ctx = this.outputCtx;
    if (!ctx) return;

    //  Copy the fully composited result (snapshot base + strokes + filters)
    ctx.clearRect(0, 0, this.width, this.height);
    this._replayBoard.ensureFullComposite?.();
    ctx.drawImage(this._replayBoard.viewCanvas, 0, 0);

    this._renderReplaySelections();

    //  Draw the replay board's topCanvas (pixel brush preview, etc.)
    if (this._replayBoard.topCanvas) {
      ctx.drawImage(this._replayBoard.topCanvas, 0, 0);
    }

    //  Draw per-user preview canvases (in-progress strokes / shape previews)
    for (const user of this.botUsers.values()) {
      if (user.tool === 'blur') {
        continue;
      }

      if (user.board) {
        // _syncLayeredRemotePreview registers the in-progress stroke into the
        // LayerManager (so it composites with the correct blendMode at the
        // right z-order) and hides user.board via style.opacity=0 in the live
        // UI. The replay canvas is offscreen, so drawImage ignores that CSS
        // opacity and would paint the same preview a second time on top of
        // viewCanvas — doubling its opacity. Skip when the layered preview is
        // active; viewCanvas already has it.
        const cssHiddenLayeredPreview = user.tool !== 'erase'
          && (user.board.style?.opacity === '0' || user.board.style?.opacity === 0);
        const layeredActive = !!user._layeredPreviewActive || cssHiddenLayeredPreview;

        if (!layeredActive) {
          const blendMode = user.blendMode || 'source-over';
          ctx.save();

          // Glitch blur still uses a dedicated preview canvas in replay.
          if (user.tool === 'glitchBlur') {
            const radius = user.blurRadius || 5;
            ctx.filter = `blur(${radius * 0.5}px)`;
          }

          if (user.board.style?.mixBlendMode && user.board.style.mixBlendMode !== 'normal') {
            ctx.globalCompositeOperation = user.board.style.mixBlendMode;
          } else {
            ctx.globalCompositeOperation = blendMode === 'source-over' ? 'source-over' : blendMode;
          }

          ctx.drawImage(user.board, 0, 0);
          ctx.restore();
        }
      }

      if (user.tool === 'text' && user.text && (!user.blendMode || user.blendMode === 'source-over')) {
        this._drawReplayTextPreview(ctx, user);
      }
    }

    if (this._replayBoard.upperLayersCanvas) {
      ctx.drawImage(this._replayBoard.upperLayersCanvas, 0, 0);
    }

    if (this._replayBoard.selectionOverlay && this.renderSelectionOverlay !== false) {
      ctx.drawImage(
        this._replayBoard.selectionOverlay,
        -this._replayBoard.selectionOverlayPadding,
        -this._replayBoard.selectionOverlayPadding
      );
    }

    // 4. Draw the snapshot's top canvas overlay (active strokes at snapshot time)
    if (this.topCanvas) {
      ctx.drawImage(this.topCanvas, 0, 0);
    }

  }

  /**
   * Draw the recorded users' cursors (ring / crosshair / square + name label)
   * onto an arbitrary context — used by the live mini/full replay to overlay
   * cursors on the display canvas. Deliberately NOT baked into outputCanvas:
   * that canvas is copied verbatim into real board pixels by
   * TimeMachine.restoreLocalToCurrentState, so cursors must stay out of it.
   *
   * Cursors idle past REPLAY_CURSOR_IDLE_MS relative to the playhead are
   * hidden, matching the live REMOTE_CURSOR_IDLE_MS behavior.
   *
   * @param {CanvasRenderingContext2D} ctx - Destination context.
   * @param {number} [offsetX=0] - Subtracted from each cursor's x (region origin).
   * @param {number} [offsetY=0] - Subtracted from each cursor's y.
   * @returns {void}
   */
  drawCursors(ctx, offsetX = 0, offsetY = 0) {
    if (!ctx || this.renderCursors === false) return;

    for (const user of this.botUsers.values()) {
      if (!this.isCursorVisible(user)) continue;
      drawReplayCursor(ctx, user, offsetX, offsetY);
    }
  }

  /**
   * Draw the replay board's mirror-region outlines + mode guides (and a
   * centerline for global mirror) onto an arbitrary context, styled like the
   * live Board.renderMirrorRegions overlay. Regions appear/move/vanish as the
   * recorded MIRROR_REGION / MIR / SETTINGS messages replay.
   *
   * Like drawCursors, deliberately NOT baked into outputCanvas: that canvas is
   * copied verbatim into real board pixels by restore-to-live, and the video/
   * frames exporters want artwork-only output — so only the live viewer
   * (TimeMachine._paintReplayFrame) calls this.
   *
   * @param {CanvasRenderingContext2D} ctx - Destination context.
   * @param {number} [offsetX=0] - Subtracted from region coords (region origin).
   * @param {number} [offsetY=0]
   * @returns {void}
   */
  drawMirrorGuides(ctx, offsetX = 0, offsetY = 0) {
    if (!ctx || !this._replayBoard) return;
    const regions = this._replayBoard.mirrorRegions || [];
    const globalMirror = !!this._replayBoard.mirror;
    if (regions.length === 0 && !globalMirror) return;

    ctx.save();
    ctx.translate(-offsetX, -offsetY);

    if (globalMirror) {
      // The live UI shows global mirror as a DOM centerline; draw a canvas
      // equivalent so replays make it obvious why strokes are duplicating.
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = 'rgba(0, 212, 170, 0.85)';
      ctx.beginPath();
      ctx.moveTo(this.width / 2, 0);
      ctx.lineTo(this.width / 2, this.height);
      ctx.stroke();
      ctx.restore();
    }

    for (const region of regions) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0, 212, 170, 0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(region.x, region.y, region.width, region.height);

      if (region.showLine) {
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 0.75;
        ctx.strokeStyle = 'rgba(0, 212, 170, 0.85)';
        Board.drawMirrorGuide(ctx, region);
      }
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Whether a bot's cursor should be visible at the current playhead.
   * Hidden when the user has produced no pointer activity yet — e.g. a lurker
   * who was present (and so captured in the opening snapshot's
   * userDrawingStates) but never drew during the tape — or has been idle past
   * REPLAY_CURSOR_IDLE_MS. Mirrors the live remote-cursor idle-hide so a frozen
   * cursor never lingers on screen. Shared by drawCursors and the video
   * exporter's cursor overlay so the two surfaces can't drift.
   * @param {User} user
   * @returns {boolean}
   */
  isCursorVisible(user) {
    const lastTs = user?._lastCursorTs;
    if (lastTs == null) return false;
    const now = this._currentReplayTs ?? 0;
    return now - lastTs <= REPLAY_CURSOR_IDLE_MS;
  }

  /**
   * Track a committed vector (ephemeral) text record so it can be faded against
   * the playhead. Mirrors TextOverlay.add's defaulting of lifetime/hold/min
   * opacity and its ageMs → bornAt anchoring, but in tape time instead of
   * wall-clock so seeking reproduces the exact opacity.
   *
   * @param {User} user
   * @param {Object} msg - Decoded TEXT_APPLY message.
   * @param {Object} data - Normalized payload built in the TEXT_APPLY case.
   * @param {number} actionTs - Tape timestamp of the TEXT_APPLY action.
   * @private
   */
  _addVectorTextRecord(user, msg, data, actionTs) {
    if (!data.text) return;
    const id = data.id || `t_${user.id ?? 0}_${actionTs}_${this._vectorTextRecords.size}`;

    const lifetimeMs = Number.isFinite(msg.textLifetimeMs) && msg.textLifetimeMs > 0
      ? msg.textLifetimeMs
      : TEXT_OVERLAY_DEFAULT_LIFETIME_MS;
    const fadeMs = Number.isFinite(msg.textFadeMs)
      ? Math.max(0, Math.min(msg.textFadeMs, lifetimeMs))
      : Math.max(0, Math.min(TEXT_OVERLAY_DEFAULT_FADE_MS, lifetimeMs));
    const holdMs = Math.max(0, lifetimeMs - fadeMs);
    const minOpacity = TEXT_OVERLAY_DEFAULT_MIN_OPACITY;
    const ageMs = Number.isFinite(msg.textAgeMs) ? Math.max(0, msg.textAgeMs) : 0;
    if (ageMs >= lifetimeMs) return; // already expired at placement

    this._vectorTextRecords.set(id, {
      record: {
        text: data.text,
        font: data.font,
        size: data.size,
        color: data.color,
        x: data.position?.x ?? user.x,
        y: data.position?.y ?? user.y,
        textPositionMultiplier: data.textPositionMultiplier,
        textPositionOffset: data.textPositionOffset,
        layerIdx: data.layerIndex
      },
      bornTs: (actionTs ?? this._currentReplayTs) - ageMs,
      lifetimeMs,
      fadeMs,
      holdMs,
      minOpacity,
      baseOpacity: data.opacity ?? 1
    });
  }

  /**
   * Paint active vector text records onto a context, faded by their age at the
   * current playhead. Like cursors, this is a display overlay (not baked into
   * outputCanvas) since the text is ephemeral and must not become permanent
   * canvas pixels. Expired records are pruned.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} [offsetX=0] - Subtracted from each record's x (region origin).
   * @param {number} [offsetY=0]
   * @returns {void}
   */
  drawVectorText(ctx, offsetX = 0, offsetY = 0) {
    if (!ctx || this._vectorTextRecords.size === 0) return;
    const now = this._currentReplayTs ?? 0;
    const expired = [];

    for (const [id, entry] of this._vectorTextRecords) {
      const age = now - entry.bornTs;
      if (age >= entry.lifetimeMs) { expired.push(id); continue; }
      if (age < 0) continue; // not yet placed at this playhead

      let fadeAlpha = 1;
      if (age > entry.holdMs) {
        const fadeWindow = Math.max(1, entry.lifetimeMs - entry.holdMs);
        const t = Math.min(1, (age - entry.holdMs) / fadeWindow);
        fadeAlpha = 1 - t * (1 - entry.minOpacity);
      }
      const opacity = entry.baseOpacity * fadeAlpha;
      if (opacity <= 0) continue;

      ctx.save();
      if (offsetX || offsetY) ctx.translate(-offsetX, -offsetY);
      paintTextRecord(ctx, { ...entry.record, opacity });
      ctx.restore();
    }

    for (const id of expired) this._vectorTextRecords.delete(id);
  }

  /**
   * Draw the floating text preview directly into the replay output for normal
   * blend mode, matching the live remote cursor text behavior.
   * @param {CanvasRenderingContext2D} ctx
   * @param {User} user
   * @private
   */
  _drawReplayTextPreview(ctx, user) {
    const { fontSize, drawX, baselineY } = getPreviewTextLayout(user);
    const lineHeight = getUserTextLineHeight(user);
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px ${user.font}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = getTextFontLetterSpacing(user.font);
    ctx.textBaseline = 'alphabetic';
    user.text.split('\n').forEach((line, i) => {
      ctx.fillText(line, drawX, baselineY + (i * lineHeight));
    });
    ctx.restore();
  }

  /**
   * Clear cached blur results from all stroke stacks so they are
   * re-computed against the current canvas content on the next composite.
   * @private
   */
  _clearBlurCaches() {
    const lm = this._replayBoard?.layerManager;
    if (!lm) return;
    for (const group of lm.layerGroups) {
      for (const stroke of group.strokeStack) {
        if (stroke.filterType) {
          delete stroke._cachedBlurResult;
          delete stroke._cachedPreview;
          delete stroke._isBlurring;
        }
      }
    }
  }

  /**
   * Pre-load all brush images from T.GMP messages into a cache so they
   * can be applied synchronously when the T.GMP action is processed.
   * @param {Array} actions - Actions to scan
   * @param {number} upToTimestamp - Only consider actions up to this time
   * @private
   */
  async _preloadBrushImages(actions, upToTimestamp) {
    this._brushCache = new Map();
    const loadPromises = [];

    for (const action of actions) {
      if (action.timestamp > upToTimestamp) break;
      if (action.msg?.t !== T.GMP || !action.msg.g) continue;

      const raw = action.msg.g;
      const brushKey = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (this._brushCache.has(brushKey)) continue; // already queued

      const brushData = typeof raw === 'string' ? JSON.parse(raw) : { ...raw };

      if (brushData.type === 'gbr' || brushData.type === 'image' || brushData.type === 'svg') {
        // Reserve slot immediately so duplicates are skipped
        this._brushCache.set(brushKey, null);
        loadPromises.push(this._loadSerializedBrushImage(brushData).then((loadedBrush) => {
          if (loadedBrush) this._brushCache.set(brushKey, loadedBrush);
        }));
      } else if (brushData.type === 'gih' && brushData.gBrushes?.length > 0) {
        this._brushCache.set(brushKey, null);
        loadPromises.push(new Promise((resolve) => {
          let loadedCount = 0;
          const totalImages = brushData.gBrushes.length;
          const images = brushData.gBrushes.map((brush) => {
            const img = new Image();
            img.onload = () => {
              loadedCount++;
              if (loadedCount === totalImages) {
                brushData.images = images;
                brushData.index = 0;
                brushData.ncells = images.length;
                if (!brushData.cellwidth && brushData.gBrushes[0]) {
                  brushData.cellwidth = brushData.gBrushes[0].width || 32;
                  brushData.cellheight = brushData.gBrushes[0].height || 32;
                }
                if (brushData.dimensions?.length > 0) {
                  for (const dim of brushData.dimensions) {
                    dim.currentIndex = 0;
                  }
                  brushData.getNextBrush = function(context) {
                    let idx = 0;
                    for (const dim of this.dimensions) {
                      idx = dim.currentIndex;
                      dim.currentIndex = (dim.currentIndex + 1) % (dim.size || this.ncells);
                    }
                    return { brush: this.gBrushes[idx], index: idx };
                  };
                  brushData.reset = function() {
                    for (const dim of this.dimensions) dim.currentIndex = 0;
                  };
                }
                this._brushCache.set(brushKey, brushData);
                resolve();
              }
            };
            img.onerror = () => {
              loadedCount++;
              if (loadedCount === totalImages) resolve();
            };
            img.src = brush.gimpUrl;
            return img;
          });
        }));
      }
    }

    if (loadPromises.length > 0) {
      await Promise.all(loadPromises);
    }
  }

  /**
   * Pre-load all pattern images from T.GPT messages.
   * @param {Array} actions - Actions to scan
   * @param {number} upToTimestamp - Only consider actions up to this time
   * @private
   */
  async _preloadPatternImages(actions, upToTimestamp) {
    this._patternCache = new Map();
    const loadPromises = [];

    for (const action of actions) {
      if (action.timestamp > upToTimestamp) break;
      if (action.msg?.t !== T.GPT) continue;

      const patternPayload = this._getPatternPayload(action.msg);
      if (!patternPayload) continue;

      const patternKey = typeof patternPayload === 'string'
        ? patternPayload
        : JSON.stringify(patternPayload);
      if (this._patternCache.has(patternKey)) continue;

      this._patternCache.set(patternKey, null);
      loadPromises.push(
        this._loadPatternData(patternPayload).then((patternData) => {
          if (patternData) {
            this._patternCache.set(patternKey, patternData);
          }
        })
      );
    }

    if (loadPromises.length > 0) {
      await Promise.all(loadPromises);
    }
  }

  /**
   * Pre-load all glitch result images from T.GLITCH_RESULT messages into a cache
   * so they can be applied synchronously when the action is processed.
   * @param {Array} actions - Actions to scan
   * @param {number} upToTimestamp - Only consider actions up to this time
   * @private
   */
  async _preloadGlitchResults(actions, upToTimestamp) {
    this._glitchResultCache = new Map();
    const loadPromises = [];
    let glitchResultCount = 0;

    for (const action of actions) {
      if (action.timestamp > upToTimestamp) break;
      if (action.msg?.t !== T.GLITCH_RESULT || !action.msg.g) continue;

      glitchResultCount++;
      const msg = action.msg;
      const glitchKey = `${msg.u}_${msg.sx}_${msg.sy}_${msg.sw}_${msg.sh}`;
      if (this._glitchResultCache.has(glitchKey)) continue;

      // Reserve slot immediately so duplicates are skipped
      this._glitchResultCache.set(glitchKey, null);

      loadPromises.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          // Convert to canvas for use as _cachedBlurResult
          const canvas = document.createElement('canvas');
          canvas.width = msg.sw;
          canvas.height = msg.sh;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, msg.sw, msg.sh);
          this._glitchResultCache.set(glitchKey, canvas);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = msg.g;
      }));
    }

    if (loadPromises.length > 0) {
      await Promise.all(loadPromises);
    }

    console.log('[ReplayEngine] Pre-loaded glitch results:', glitchResultCount, 'unique:', this._glitchResultCache.size);
  }

  /**
   * Pre-load pasted image payloads so IMG_PASTE replay can restore
   * floating selections synchronously.
   * @param {Array} actions
   * @param {number} upToTimestamp
   * @private
   */
  async _preloadImagePastes(actions, upToTimestamp) {
    this._imagePasteCache = new Map();
    const loadPromises = [];

    for (const action of actions) {
      if (action.timestamp > upToTimestamp) break;
      if (action.msg?.t !== T.IMG_PASTE || !action.msg.g) continue;

      const imageKey = action.msg.g;
      if (this._imagePasteCache.has(imageKey)) continue;

      this._imagePasteCache.set(imageKey, null);
      loadPromises.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          this._imagePasteCache.set(imageKey, img);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = imageKey;
      }));
    }

    if (loadPromises.length > 0) {
      await Promise.all(loadPromises);
    }
  }

  /**
   * Get the current replay state as a data URL.
   * @returns {string} Data URL of composited canvas
   */
  getPreviewDataUrl() {
    return this.outputCanvas.toDataURL('image/png');
  }

  /**
   * Get width.
   * @returns {number}
   */
  getWidth() {
    return this.width;
  }

  /**
   * Get height.
   * @returns {number}
   */
  getHeight() {
    return this.height;
  }
}
