/** @fileoverview WebSocket handlers for board snapshots (saving, listing, restoring). */

import { T } from '../../shared/MessageTypes.js';
import { debug } from '../utils/debug.js';
import { appState } from '../state.svelte.js';
import * as wasm from '../wasm/ddraw_wasm.js';
import { readQoiDimensions } from '../../shared/qoi.js';

function isSnapshotHistoryOpen(app) {
  return !!appState.snapshotMenuVisible;
}

/**
 * Registers WebSocket event listeners for board snapshot messages.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {DrawingApp} app - The main application instance.
 */
export function setupSnapshotHandlers(wsClient, app) {
  // Handle snapshot list response
  wsClient.on('board_snapshot_list', (data) => {
    if (!data.snapshotList) return;
    if (!isSnapshotHistoryOpen(app)) {
      app.snapshotManager.clearListCache();
      return;
    }

    const append = !!app.snapshotManager.lastListAppend;
    const nextSnapshots = append
      ? [
          ...appState.snapshots,
          ...data.snapshotList.filter((snap) => !appState.snapshots.some((existing) => existing.id === snap.id))
        ]
      : data.snapshotList;

    app.snapshotManager.snapshots = nextSnapshots;
    app.snapshotManager.hasMoreSnapshots = data.snapshotList.length === app.snapshotManager.snapshotPageSize;
    app.snapshotManager.lastListAppend = false;

    appState.snapshots = nextSnapshots;
    appState.snapshotHasMore = app.snapshotManager.hasMoreSnapshots;
    appState.snapshotListVersion += 1;

    debug(`[Snapshot] Received ${data.snapshotList.length} snapshot(s) (${append ? 'append' : 'replace'})`);
  });

  // Room Settings -> Start state: which snapshot an empty room comes back up on.
  wsClient.on('room_start_snapshot_info', (data) => {
    appState.roomStartSnapshot = {
      state: Number(data.state) || 0,
      snapshot: data.snapshot || null
    };
  });

  // Handle server requesting us to capture a snapshot
  wsClient.on('board_snapshot_request', () => {
    app.snapshotManager.handleServerRequest();
  });

  // Handle region restoration (broadcast from server)
  wsClient.on('board_snapshot_region_restore', (data) => {
    if (!data.snapshotLayers || data.snapshotLayers.length === 0) return;
    const restorePromise = applyRegionRestore(app.board, data.snapshotLayers, data.isLasso, {
      sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh
    }, data.cr || []).catch((err) => {
      debug.warn('[Snapshot] Failed to apply region restore', err);
    });

    // Expose in-flight region restores so sync providers can wait for stable state.
    app._pendingSnapshotRegionRestorePromise = restorePromise;
    restorePromise.finally(() => {
      if (app._pendingSnapshotRegionRestorePromise === restorePromise) {
        app._pendingSnapshotRegionRestorePromise = null;
      }
      // NOTE: the rolling DVR tape is intentionally NOT reset here. Like the
      // full-board BOARD_SNAPSHOT_RESTORE below, the region restore is on the
      // replay allowlist, so the tape records it and the replay engine re-applies
      // it as a timeline event — the reverted region lands as a new event at the
      // end of the timeline, keeping all history before AND after the undo point.
    });
  });

  // Handle board restoration
  wsClient.on('board_snapshot_restore', (data) => {
    if (!data.snapshotLayers || data.snapshotLayers.length === 0) return;

    if (data.isSyncCheckpoint) {
      app.syncClient?.handleSyncCheckpointRestore?.(data);
    } else {
      const issuer = data.snapshotIssuer || 'Unknown';
      const ts = new Date(data.snapshotTs).toLocaleString();
      app.ui.showToast(`Board restored to snapshot by ${issuer} (${ts})`, 5000);
    }

    // Apply the per-layer snapshot to the board
    app.board.restoreSnapshot(data.snapshotLayers);
    app._bindLayerManagerDependencies?.();

    // Clear undo/redo stroke stacks since the board has been replaced
    for (const group of app.board.layerManager.layerGroups) {
      group.strokeStack = [];
      for (const active of group.activeStrokeByUser.values()) {
        app.board.layerManager._releaseCanvas(active);
      }
      group.activeStrokeByUser.clear();
      app.board.layerManager._clearPreviewsFromGroup(group);
    }
    app.updateUndoRedoHud();

    // NOTE: the rolling DVR tape is NOT reset/truncated here. BOARD_SNAPSHOT_RESTORE
    // is on the replay allowlist, so the tape records this restore and the replay
    // engine re-applies it — the reverted state lands as a new event at the end of
    // the timeline, keeping all history before AND after the undo point intact.

    // Re-request sync for everything else if needed
    // app.syncClient.requestSync();
  });
}

/**
 * Applies a region restore from snapshot layer data onto the board.
 * Works for both rectangle and lasso selections across all layer groups.
 * @param {Board} board
 * @param {Uint8Array[]} layerDatas
 * @param {boolean} isLasso
 * @param {{sx,sy,sw,sh}} rect - Rectangle selection coords (board space)
 * @param {number[]} lassoFlat - Flat [x0,y0,x1,y1,...] lasso points
 */
export async function applyRegionRestore(board, layerDatas, isLasso, rect, lassoFlat) {
  await applyRegionRestoreLayers(
    board,
    layerDatas.length,
    (i) => _decodeQoiLayerCanvas(layerDatas[i]),
    isLasso,
    rect,
    lassoFlat
  );
  board.app?.ui?.showToast('A region was restored from a snapshot', 3000);
}

/**
 * Decodes one QOI layer blob into a canvas, or null if it's empty/invalid.
 * @param {Uint8Array} qoi
 * @returns {HTMLCanvasElement|null}
 */
function _decodeQoiLayerCanvas(qoi) {
  if (!qoi || qoi.length === 0) return null;

  let pixels;
  try {
    pixels = wasm.qoi_decode(qoi);
    if (!pixels || pixels.length === 0) return null;
  } catch (e) { return null; }

  const dimensions = readQoiDimensions(qoi);
  if (!dimensions || pixels.length !== dimensions.width * dimensions.height * 4) return null;

  const snapshotCanvas = document.createElement('canvas');
  snapshotCanvas.width = dimensions.width; snapshotCanvas.height = dimensions.height;
  snapshotCanvas.getContext('2d').putImageData(
    new ImageData(
      new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
      dimensions.width,
      dimensions.height
    ), 0, 0
  );
  return snapshotCanvas;
}

/**
 * Restores a region on each layer independently from per-layer source canvases.
 * Layers whose source is null are left untouched.
 * @param {Board} board
 * @param {number} layerCount - Number of layer sources
 * @param {(index: number) => HTMLCanvasElement|null} getLayerCanvas - Source for layer `index`
 * @param {boolean} isLasso
 * @param {{sx,sy,sw,sh}} rect - Rectangle selection coords (board space)
 * @param {number[]} lassoFlat - Flat [x0,y0,x1,y1,...] lasso points
 */
export async function applyRegionRestoreLayers(board, layerCount, getLayerCanvas, isLasso, rect, lassoFlat) {
  const lm = board.layerManager;
  const [height, width] = board.dimensions;

  // Reconstruct lasso points array
  const lassoPoints = [];
  for (let i = 0; i + 1 < lassoFlat.length; i += 2) {
    lassoPoints.push({ x: lassoFlat[i], y: lassoFlat[i + 1] });
  }

  const interactionBlockId = board.addInteractionBlock(
    isLasso
      ? { type: 'lasso', points: lassoPoints }
      : { type: 'rect', x: rect.sx, y: rect.sy, width: rect.sw, height: rect.sh }
  );

  try {
    // setTimeout instead of rAF — rAF is paused in hidden tabs, which would
    // stall this whole restore until the tab regains focus.
    await new Promise(resolve => setTimeout(resolve, 0));

    for (let i = 0; i < layerCount; i++) {
      const snapshotCanvas = getLayerCanvas(i);
      if (!snapshotCanvas) continue;

      const group = lm?.layerGroups[i];
      if (!group) continue;

      // Bake all pending strokes into the base so the region clear is complete.
      // strokeStack entries composite on top of flatCanvas/bakedSequences, so
      // clearing the base without baking first leaves recent strokes untouched.
      for (const stroke of group.strokeStack) {
        lm.addToBaseBin(i, stroke.canvas, stroke.x, stroke.y, stroke.blendMode);
      }
      group.strokeStack = [];
      group.userStrokeCounts = new Map();

      if (group.flatCanvas) {
        // Layer 0: direct pixel manipulation on the flat canvas
        lm.withFlatCanvasContext(i, (ctx) => {
          ctx.save();
          if (!isLasso) {
            const { sx: x, sy: y, sw: w, sh: h } = rect;
            ctx.clearRect(x, y, w, h);
            _drawSnapshotRect(ctx, snapshotCanvas, x, y, w, h);
          } else {
            _buildLassoPath(ctx, lassoPoints);
            ctx.clip();
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(snapshotCanvas, 0, 0);
          }
          ctx.restore();
        });
      } else {
        // Layers 1+: append destination-out erase then source-over fill to bakedSequences
        const eraseCanvas = document.createElement('canvas');
        eraseCanvas.width = width; eraseCanvas.height = height;
        const eraseCtx = eraseCanvas.getContext('2d');
        eraseCtx.fillStyle = '#000';
        if (!isLasso) {
          eraseCtx.fillRect(rect.sx, rect.sy, rect.sw, rect.sh);
        } else {
          _buildLassoPath(eraseCtx, lassoPoints);
          eraseCtx.fill();
        }
        lm.addToBaseBin(i, eraseCanvas, 0, 0, 'destination-out');

        const fillCanvas = document.createElement('canvas');
        fillCanvas.width = width; fillCanvas.height = height;
        const fillCtx = fillCanvas.getContext('2d');
        fillCtx.save();
        if (!isLasso) {
          const { sx: x, sy: y, sw: w, sh: h } = rect;
          _drawSnapshotRect(fillCtx, snapshotCanvas, x, y, w, h);
        } else {
          _buildLassoPath(fillCtx, lassoPoints);
          fillCtx.clip();
          fillCtx.drawImage(snapshotCanvas, 0, 0);
        }
        fillCtx.restore();
        lm.addToBaseBin(i, fillCanvas, 0, 0, 'source-over');
      }

      await new Promise(resolve => setTimeout(resolve, 0));
    }

    board.markCompositeFull();
    board.compositeAllLayers();
  } finally {
    if (interactionBlockId) {
      board.removeInteractionBlock(interactionBlockId);
    }
  }
}

function _drawSnapshotRect(ctx, snapshotCanvas, x, y, width, height) {
  const sourceX = Math.max(0, x);
  const sourceY = Math.max(0, y);
  const sourceRight = Math.min(snapshotCanvas.width, x + width);
  const sourceBottom = Math.min(snapshotCanvas.height, y + height);
  const sourceWidth = sourceRight - sourceX;
  const sourceHeight = sourceBottom - sourceY;

  if (sourceWidth <= 0 || sourceHeight <= 0) return;

  ctx.drawImage(
    snapshotCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight
  );
}

function _buildLassoPath(ctx, points) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}
