/**
 * @fileoverview Handles synchronization of remote user drawing actions.
 * Manages remote cursors, drawing tool routing, and position interpolation.
 */

import { drawLineArray, bridgeGap, blurExtent } from '../utils/drawing.js';
import { SELECTION_MODES, getNextBrushIndex } from '../utils/parseGimp.js';
import { resetSmoothingBuffer, applySmoothingEMA } from '../utils/smoothing.js';
import { getPreviewTextLayout, getUserTextLineHeight } from '../utils/textLayout.js';
import { RemotePenHandler } from './RemotePenHandler.js';
import { RemoteInkHandler } from './RemoteInkHandler.js';
import { RemoteSelectionHandler } from './RemoteSelectionHandler.js';
import { setUserLayerContent, syncUserLayerDisplay, releaseUserLayer } from './userLayerPresence.js';
import { releaseRemoteScratch } from './remoteScratchReclaim.js';
import { normalizeBlendBakeMode } from '../../shared/blendBakeMode.js';
import { CONFETTI_STATE_KEYS } from '../tools/ConfettiTool.js';

/**
 * Above this fraction of the board, a mirror-expanded preview rect is worth less
 * than one full composite: `_applyCompositeClip` pays per rect in the clip path
 * and the tile grid saves nothing once most tiles are dirty anyway. Radial and
 * fibonacci regions are the ones that reach it — a 16-slice radial turns one
 * stroke rect into 16 rotated AABBs whose union approaches the whole region.
 */
const MIRROR_RECT_FULL_BOARD_FRACTION = 0.5;

/**
 * Most preview rects a mirrored stroke may scope to before collapsing them into
 * one bounding rect. Matches `CompositeTileGrid.consumeDirtyRects`'s own cap,
 * which collapses above 8 for the same reason: compositing cost is dominated by
 * rect count, not area.
 */
const MIRROR_MAX_PREVIEW_RECTS = 8;

/**
 * Throttle interval for brush/line/rectangle/circle/erase's remote preview
 * render, matching RemoteInkHandler.INK_PREVIEW_INTERVAL_MS /
 * RemotePenHandler.PEN_PREVIEW_INTERVAL_MS (30 FPS, the catchup loop's own
 * cadence). ink/pen/pattern already coalesce to this; renderRemotePreview did
 * not — it ran once per ARRIVING BATCH, unthrottled, and unconditionally does
 * a full-board `user.context.clearRect` before redrawing (see
 * renderRemotePreview's `needsClear` list). _syncLayeredRemotePreview's
 * composite-into-the-board step is already rect-scoped (see
 * composite_tile_grid_live_but_bypassed), but that scoping does nothing for
 * THIS full-board clear, which ran at the same per-batch cadence regardless.
 * With N concurrently drawing users each sending ~60 batches/sec, that is N
 * full-board clears/sec that no prior fix touched.
 *
 * Fallback only — `_requestRemotePreviewRender` normally uses
 * InputBufferManager.getAdaptiveRemotePreviewIntervalMs(), which widens this
 * on the local client's own measured tick congestion. This constant is what
 * a healthy client still gets at the floor, and what's used if inputBufferManager
 * is unavailable for any reason.
 */
const REMOTE_PREVIEW_INTERVAL_MS = 33;

/**
 * RemoteUserHandler coordinates the rendering of remote users' drawing events.
 * It manages tool-specific handlers and ensures visual parity between clients.
 */
export class RemoteUserHandler {
  /**
   * @param {App} app - The main application instance.
   */
  constructor(app) {
    this.app = app;

    /** @type {RemotePenHandler} */
    this.penHandler = new RemotePenHandler(app.board);
    /** @type {RemoteInkHandler} */
    this.inkHandler = new RemoteInkHandler(app.board);
    /** @type {RemoteSelectionHandler} */
    this.selectionHandler = new RemoteSelectionHandler(
      app.board,
      () => this.users,
      () => this.sessionIndex
    );

    /** @type {number} */
    this.catchupInterval = 33; // 30 FPS (was 16ms / 62.5 FPS)
    /** @type {number|null} */
    this.catchupTimer = null;
    this.pendingGlitchUndoByUser = new Map();
    this.pendingGlitchImagesByUser = new Map();
  }

  get board() { return this.app.board; }
  get toolManager() { return this.app.toolManager; }
  get ui() { return this.app.ui; }
  get users() { return this.app.users; }
  get sessionIndex() { return this.app.sessionIndex; }

  getStrokeLayer(user) {
    return user?._strokeLayer ?? user?.activeLayer ?? 0;
  }

  _usesLayeredRemotePreview(user) {
    return !!user && [
      'brush',
      'line',
      'rectangle',
      'circle',
      'flowPen',
      'ink',
      'pixel',
      'pattern'
    ].includes(user.tool);
  }

  /**
   * Resolve the board-space region a remote user's in-progress stroke occupies.
   *
   * Three sources unioned, because the tools do not agree on where preview-time
   * bounds live:
   *
   * - `user._previewDirtyBounds` — the swept cursor path, accumulated in
   *   handleMouseMove. This is the one that covers brush/pen/pixel/pattern/
   *   line/rectangle/circle, every one of which expands `active.dirtyRect`
   *   only at COMMIT (handleMouseUp / handlePenUp), not during the stroke.
   * - `user._inkDirtyBounds` — ink's own per-point bounds; `RemoteInkHandler`
   *   likewise only calls `expandDirtyRect` in `handleInkUp`.
   * - `active.dirtyRect` — populated at commit, and by paths that expand it
   *   directly (selection commit/stamp/fill).
   *
   * Reading only `active.dirtyRect` returns null for the whole of every ordinary
   * stroke, which is exactly how the first version of this silently did nothing.
   *
   * Cumulative rather than per-batch on purpose: the ink preview clears and
   * redraws the WHOLE stroke on each render, so the region that changed is the
   * whole stroke, not just the newest segment.
   *
   * This is the stroke's OWN rect only. Mirrors reflect those pixels elsewhere
   * too; `_previewDirtyRects` wraps this and adds a rect per mirror image, and
   * that is what callers should use. Returns null (meaning "fall back to a full
   * composite") when bounds are unknown — a too-large rect only costs time,
   * while a too-small one leaves a remote stroke visibly torn.
   *
   * @param {Object} user - Remote user model.
   * @param {number} layerIndex - Layer the stroke was begun on.
   * @returns {{x:number,y:number,width:number,height:number}|null}
   * @private
   */
  _activeStrokeDirtyRect(user, layerIndex) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const union = (x0, y0, x1, y1) => {
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    };

    const ink = user?._inkDirtyBounds;
    if (ink && Number.isFinite(ink.minX) && ink.maxX >= ink.minX) {
      // Same margin formula handleInkUp uses, so the preview rect and the
      // committed rect cover the same pixels.
      const size = user._inkSize || user.size || 0;
      const hardness = user._inkHardness !== undefined ? user._inkHardness : 1.0;
      const margin = (1 - hardness) * (20 + size * 0.2) + size * 0.5 + 2;
      union(ink.minX - margin, ink.minY - margin, ink.maxX + margin, ink.maxY + margin);
    }

    const pv = user?._previewDirtyBounds;
    if (pv && Number.isFinite(pv.minX) && pv.maxX >= pv.minX) {
      union(pv.minX, pv.minY, pv.maxX, pv.maxY);
    }

    const dr = this.board.layerManager?.getActiveStroke?.(layerIndex, user?.id)?.dirtyRect;
    if (dr && dr.maxX !== -1) {
      union(dr.minX, dr.minY, dr.maxX, dr.maxY);
    }

    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    const x = Math.max(0, Math.floor(minX));
    const y = Math.max(0, Math.floor(minY));
    const width = Math.ceil(maxX) - x + 1;
    const height = Math.ceil(maxY) - y + 1;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }

  /**
   * Every area of the board a remote user's live preview currently occupies:
   * the stroke's own rect, plus one per place an active mirror reflects it to.
   *
   * A mirrored stroke paints into the remote user's canvas two or more times —
   * once at the cursor, once per mirror image — so a rect covering only the
   * cursor path under-covers `setUserPreviewStroke`, and `_copyPreviewSource`
   * then clears and redraws less than the stroke occupies. That does not merely
   * leave a stale composite: it leaves the mirrored copy visibly torn. Fail
   * toward too large.
   *
   * A LIST rather than a bounding union, which is what this originally returned.
   * The union of a stroke and its reflection across a board-length centerline is
   * a band spanning nearly the whole board width, and almost all of it is the
   * empty gap between the two copies — 7% of the board where the copies
   * themselves are 0.4%. Measured on an N4500 observing one remote brush drawer
   * at 1080p, that band cost MORE than the full-board composite it replaced
   * (5-7% dropped frames against 1-2%, consistent across six ABBA pairs), while
   * the stroke rect alone matched the full-board arm. Rect count is what the
   * clip path and the per-layer drawImage pay for; empty area between rects is
   * pure waste. See `testing/devtools/grid_mirror_ab.mjs`.
   *
   * The geometry is already solved — `getSelectionMirrorTargets` expands quad
   * into 3 pseudo-regions, radial into one per slice and fib into one per depth
   * level, and models the global `board.mirror` as a board-sized vertical
   * region, so this needs no per-mode math. What it must NOT do is what the
   * pre-fix code assumed: conflate the size of the REGION with the size of the
   * REFLECTED RECT. Reflecting a 60x40 rect across a board-length centerline
   * gives another 60x40 rect on the far side, not a board-sized one.
   *
   * @param {Object} user - Remote user model.
   * @param {number} layerIndex - Layer the stroke was begun on.
   * @returns {Array<{x:number,y:number,width:number,height:number}>|null} null
   *   means "composite the whole board".
   * @private
   */
  _previewDirtyRects(user, layerIndex) {
    const base = this._activeStrokeDirtyRect(user, layerIndex);
    if (!base) return null;

    const board = this.board;
    if (!board?.hasMirrors?.()) return [base];

    const targets = board.getSelectionMirrorTargets?.(base);
    if (!targets?.length) return [base];

    // Fibonacci is the one mode whose painted area is NOT the union of the
    // per-step transforms of the stroke rect, so a rect list under-covers it and
    // the spiral tears mid-stroke. Measured with
    // `testing/devtools/mirror_rect_exactness.mjs`: global, quad, rotational and
    // radial all match a full composite exactly; fib missed up to 1130px per
    // sample in 8 of 8. Full composite until that geometry is worked out —
    // slower, but a slow board beats a broken one.
    for (const { region } of targets) {
      if ((region?.transform || region?.mode || region?.axis) === 'fibStep') return null;
    }

    let rects = [base];
    for (const { bounds } of targets) {
      if (bounds && bounds.width > 0 && bounds.height > 0) rects.push(bounds);
    }

    // Past this many, the clip path costs more than the pixels saved, and the
    // tile grid would collapse them itself (CompositeTileGrid.consumeDirtyRects
    // caps at 8). Collapse first, then let the coverage test below decide
    // whether what is left is still worth scoping — for a radial region the
    // union of its slices is the region, which can be far smaller than the board.
    if (rects.length > MIRROR_MAX_PREVIEW_RECTS) {
      rects = [board.unionWithMirrorTargets(base, targets)];
    }

    const boardWidth = board.getWidth();
    const boardHeight = board.getHeight();
    const boardArea = boardWidth * boardHeight;
    const clamped = [];
    let covered = 0;
    for (const r of rects) {
      const x = Math.max(0, Math.floor(r.x));
      const y = Math.max(0, Math.floor(r.y));
      const w = Math.min(boardWidth, Math.ceil(r.x + r.width)) - x;
      const h = Math.min(boardHeight, Math.ceil(r.y + r.height)) - y;
      if (w <= 0 || h <= 0) continue;
      covered += w * h;
      clamped.push({ x, y, width: w, height: h });
    }
    if (clamped.length === 0) return [base];
    if (boardArea > 0 && covered / boardArea > MIRROR_RECT_FULL_BOARD_FRACTION) return null;
    return clamped;
  }

  _syncLayeredRemotePreview(user, dirtyRect = null) {
    if (!this._usesLayeredRemotePreview(user) || !user?.context?.canvas) return;

    if (!user.mousedown || user.panning) {
      this._clearLayeredRemotePreview(user);
      return;
    }

    const layerIndex = this.getStrokeLayer(user);
    if (!this.board.layerManager?.isLayerVisible?.(layerIndex)) {
      this._clearLayeredRemotePreview(user);
      return;
    }

    // No caller passes an explicit rect, so derive one. Without this the null
    // path costs three full-board passes PER ARRIVING BATCH, per drawing remote
    // user: a clearRect and a drawImage inside _copyPreviewSource, plus a
    // markCompositeFull that also wipes every other subsystem's dirty tiles for
    // the frame (markRect early-returns while forceFull is set). Measured on an
    // N4500: full-board compositing drops 8.7% of frames against 3.3% for a
    // scoped rect. Falls back to the old behaviour when bounds are unknown,
    // which is the fail-safe direction — a too-large rect costs time, a
    // too-small one leaves a remote stroke visibly torn.
    const rects = dirtyRect
      ? (Array.isArray(dirtyRect) ? dirtyRect : [dirtyRect])
      : this._previewDirtyRects(user, layerIndex);

    const blendMode = this.board.layerManager.getLayerAllowComplexBlendModes(layerIndex)
      ? (user.blendMode || 'source-over')
      : 'source-over';
    this.board.layerManager.setUserPreviewStroke(layerIndex, user.id, user.context.canvas, blendMode, rects);
    user._layeredPreviewActive = true;
    if (user.board) user.board.style.opacity = '0';
    this._syncUserLayerDisplay(user);

    if (rects?.length) {
      for (const rect of rects) {
        this.board.compositeTileGrid?.markRect(rect.x, rect.y, rect.width, rect.height);
      }
      // Remember them: tearing the preview down has to repaint wherever it was,
      // and by then the active stroke (and its dirtyRect) is already gone.
      user._lastPreviewRects = rects;
    } else {
      this.board.markCompositeFull?.();
      user._lastPreviewRects = null;
    }
    this.board.requestUpdate?.();
  }

  _clearLayeredRemotePreview(user) {
    if (!user) return;
    // A pending throttled render (see _requestRemotePreviewRender) targets a
    // preview that is about to be torn down; letting it fire afterwards would
    // repaint stale points onto a canvas nothing is reading from anymore.
    this._cancelRemotePreviewRender(user);

    const hadPreview = user._layeredPreviewActive;
    this.board.layerManager?.clearUserPreviewStroke?.(user.id);
    if (user._layeredPreviewActive && user.board) {
      user.board.style.opacity = '';
    }
    user._layeredPreviewActive = false;
    this._syncUserLayerDisplay(user);

    // Removing the preview changes those pixels, so they need recompositing.
    // This used to be covered incidentally by the markCompositeFull above; now
    // that the sync path marks a scoped rect, the teardown has to mark its own.
    if (hadPreview) {
      const last = user._lastPreviewRects;
      if (last?.length) {
        for (const rect of last) {
          this.board.compositeTileGrid?.markRect(rect.x, rect.y, rect.width, rect.height);
        }
      } else {
        this.board.markCompositeFull?.();
      }
      this.board.requestUpdate?.();
    }
    user._lastPreviewRects = null;
  }

  /**
   * Throttled entry point for brush/line/rectangle/circle/erase's remote
   * preview render (`renderRemotePreview`), which full-board `clearRect`s
   * `user.context` for every tool in its `needsClear` list (erase clears only
   * its own dirty rect) — see REMOTE_PREVIEW_INTERVAL_MS.
   * Mirrors RemoteInkHandler._requestPreviewRender / RemotePenHandler's
   * equivalent: only the RENDER is deferred, never the state used to produce
   * it (`user.currentLine` etc. are already fully updated by the time this is
   * called, via renderRemoteMove earlier in the same handleMouseMove batch),
   * so a trailing-edge render always catches up and pixels committed at
   * mouse-up (read from `user.currentLine` / `activeStrokeCtx` directly, not
   * from this preview) are unaffected either way.
   *
   * @param {User} user
   * @param {{x:number,y:number}} pos
   */
  _requestRemotePreviewRender(user, pos) {
    // Debug/measurement counters — how many incoming batches asked for a
    // render vs. how many actually fired one. Not used in normal operation;
    // read via getDebugStats().
    this._debugPreviewCallCount = (this._debugPreviewCallCount || 0) + 1;
    const fire = (p) => {
      this._debugPreviewFireCount = (this._debugPreviewFireCount || 0) + 1;
      this.renderRemotePreview(user, p);
      // Previously ran unconditionally on every batch, alongside the direct
      // renderRemotePreview call this replaces — moved here so they only fire
      // on the same cadence as the render they accompany, not every batch.
      this.app.boardViewer?.requestLiveRender?.();
      if (user.tool === 'brush') this.board.requestUpdate();
    };

    // Adaptive: widens on THIS client's own measured tick congestion (see
    // InputBufferManager.getAdaptiveRemotePreviewIntervalMs), so a bogged-down
    // client visibly batches other users' strokes and catches up, rather than
    // every remote drawer piling another full-board clear onto an already
    // late render loop. Recomputed per call, so it eases back down on its own.
    const interval = this.app.inputBufferManager?.getAdaptiveRemotePreviewIntervalMs?.()
      ?? REMOTE_PREVIEW_INTERVAL_MS;

    const now = performance.now();
    const elapsed = now - (user._remotePreviewRenderAt || 0);
    if (elapsed >= interval) {
      user._remotePreviewRenderAt = now;
      fire(pos);
      return;
    }
    user._remotePreviewPendingPos = pos;
    if (user._remotePreviewTimer) return;
    user._remotePreviewTimer = setTimeout(() => {
      user._remotePreviewTimer = null;
      user._remotePreviewRenderAt = performance.now();
      // The stroke may have ended (and torn down its preview) while this was
      // pending — mousedown is the same gate renderRemotePreview's callers
      // already check before calling it directly.
      if (!user.mousedown || user.panning) return;
      fire(user._remotePreviewPendingPos ?? pos);
    }, interval - elapsed);
  }

  /** @private */
  _cancelRemotePreviewRender(user) {
    if (!user?._remotePreviewTimer) return;
    clearTimeout(user._remotePreviewTimer);
    user._remotePreviewTimer = null;
  }

  /**
   * @see setUserLayerContent in ./userLayerPresence.js
   * @param {User} user
   * @param {boolean} hasContent
   * @returns {void}
   * @private
   */
  _setUserLayerContent(user, hasContent) {
    setUserLayerContent(user, hasContent);
  }

  /**
   * @see syncUserLayerDisplay in ./userLayerPresence.js
   * @param {User} user
   * @returns {void}
   * @private
   */
  _syncUserLayerDisplay(user) {
    syncUserLayerDisplay(user);
  }

  updateRemotePreviewPresentation(user) {
    if (!user?.board) return;

    const isActiveEraser = user.tool === 'erase' && user.mousedown && !user.panning;
    // An eraser using the background-colour preview draws its finished preview
    // straight onto this surface, so hiding it would hide the preview itself.
    // Only the destination-out path wants this canvas as an invisible source.
    const eraserOwnsSurface = isActiveEraser &&
      (this.toolManager.getTool('erase')?._canUseBackgroundPreview?.(user) ?? false);
    if (!user._layeredPreviewActive) {
      user.board.style.opacity = (isActiveEraser && !eraserOwnsSurface) ? '0' : '';
    }

    const blendMode = user.tool === 'erase' ? 'source-over' : (user.blendMode || 'source-over');
    user.board.style.mixBlendMode = this.app.blendModeManager.toCSSBlendMode(blendMode);
  }

  /**
   * Processes remote mouse movement and updates drawing state.
   *
   * @param {User} user - The remote user moving their mouse.
   * @param {Object} data - Movement data payload containing points and radii.
   * @returns {void}
   */
  handleMouseMove(user, data) {
    // Not a plain identity check: during a sync rebuild our own MM frames are the
    // only surviving copy of our stroke geometry and must be drawn. See
    // App.isSelfEcho / SyncClient.isRebuilding.
    if (this.app.isSelfEcho(user.id)) return;

    const points = data.ps;
    if (!points || points.length < 2) return;

    this.ui.markRemoteCursorActivity(user.id);
    user.remoteTarget = { x: points[points.length - 2], y: points[points.length - 1] };
    this.startCatchupLoop();

    // Points arrive pre-smoothed by the sender's InputBufferManager, so we
    // use them directly.  Applying EMA again would cause double-smoothing,
    // making remote strokes visibly shorter / laggier than local ones.
    const smoothedPoints = [];
    for (let i = 0; i < points.length; i += 2) {
      smoothedPoints.push(points[i], points[i + 1]);
    }

    // Keep the smooth buffer in sync so the catchup loop starts from the
    // correct position (the last received point, not a stale EMA value).
    if (smoothedPoints.length >= 2) {
      user.smoothBuffer.x = smoothedPoints[smoothedPoints.length - 2];
      user.smoothBuffer.y = smoothedPoints[smoothedPoints.length - 1];
      user.smoothBuffer.isFirst = false;
    }

    // Every preview branch below paints inside the swept cursor path, so record
    // it once here rather than in each of them. Without this the preview rect
    // resolver has nothing to read mid-stroke for anything but ink, and every
    // arriving batch falls back to a full-board composite. See
    // _activeStrokeDirtyRect.
    if (user.mousedown && !user.panning) {
      this._expandPreviewBounds(user, smoothedPoints, this._maxBrushMargin(user));
    }

    const radii = data.rs;
    if (user.tool === 'confetti' && data.confettiData) {
      this.handleConfettiBrushLoad(user, data.confettiData);
    }

    // Pattern tool doesn't depend on radii - handle separately
    if (!user.panning && user.mousedown && user.tool === 'pattern') {
      if (user._patternPendingStrokes) {
        user._patternPendingStrokes.push({ type: 'stamps', pts: [...smoothedPoints] });
        return;
      }
      const tool = this.toolManager.getTool('pattern');
      if (tool) tool.remoteStampMask(user, smoothedPoints);
      this._syncLayeredRemotePreview(user);
      if (smoothedPoints.length >= 2) {
        this.ui.updateRemoteCursor(user.id, smoothedPoints[smoothedPoints.length - 2], smoothedPoints[smoothedPoints.length - 1], user.size);
      }
      this.app.boardViewer?.requestLiveRender?.();
      return;
    }

    // Ink: always batch-route through inkHandler so local and remote follow the
    // same perfect-freehand pipeline. When the sender sent uniform pressures it
    // omits `rs` (broadcastMove path) — synthesize a uniform radii array from
    // user.pressure as-is. Do NOT coerce a 0 to a positive value: a transient
    // pressure=0 sample must keep being filtered by handleInkPoints' skip-guard,
    // otherwise a liftoff sample renders as a full-size 100% dot.
    if (!user.panning && user.mousedown && user.tool === 'ink') {
      const inkRadii = (radii && radii.length > 0)
        ? radii
        : new Array(smoothedPoints.length / 2).fill(Math.round((user.pressure ?? 1) * 255));
      this.inkHandler.handleInkPoints(user, smoothedPoints, inkRadii);
      this._syncLayeredRemotePreview(user);
      if (smoothedPoints.length >= 2) {
        this.ui.updateRemoteCursor(user.id, smoothedPoints[smoothedPoints.length - 2], smoothedPoints[smoothedPoints.length - 1], user.size);
      }
      this.app.boardViewer?.requestLiveRender?.();
      return;
    }

    if (!user.panning && user.mousedown && radii && radii.length > 0) {
      if (user.tool === 'pixel' || user.tool === 'imageBrush' || user.tool === 'confetti') {
        if (user.tool === 'imageBrush' && user.imageBrush?._pendingStrokes) {
          user.imageBrush._pendingStrokes.push({ type: 'stamps', pts: [...smoothedPoints] });
        } else if (user.tool === 'confetti' && user._confettiPendingStrokes) {
          // Buffer until the particle sprite decodes — see handleConfettiBrushLoad.
          // The seeds ride along: they are what makes the particle scatter agree
          // across clients, and re-deriving them at replay time would only match
          // by luck.
          user._confettiPendingStrokes.push({
            type: 'stamps',
            pts: [...smoothedPoints],
            seeds: radii ? [...radii] : []
          });
        } else {
          const tool = this.toolManager.getTool(user.tool);
          if (tool) tool.applyStamps(user, smoothedPoints, radii);
          if (user.tool === 'pixel') this._syncLayeredRemotePreview(user);
        }
      } else if (user.tool === 'circleBlur') {
        const tool = this.toolManager.getTool(user.tool);
        if (tool) tool.applyStamps(user, smoothedPoints, radii);
      } else {
        this.penHandler.handlePenStamps(user, smoothedPoints, radii);
        this._syncLayeredRemotePreview(user);
      }
      if (smoothedPoints.length >= 2) {
        this.ui.updateRemoteCursor(user.id, smoothedPoints[smoothedPoints.length - 2], smoothedPoints[smoothedPoints.length - 1], user.size);
      }
      this.app.boardViewer?.requestLiveRender?.();
      return;
    }

    for (let i = 0; i < smoothedPoints.length; i += 2) {
      const x = smoothedPoints[i];
      const y = smoothedPoints[i + 1];

      if (user.lastx === null) {
        user.lastx = x;
        user.lasty = y;
      }

      const lastPos = { x: user.x, y: user.y };
      user.setPosition(x, y);
      const pos = { x: user.x, y: user.y };

      if (!user.panning && user.mousedown) {
        this.renderRemoteMove(user, pos, lastPos);
      }

      user.lastx = x;
      user.lasty = y;
    }

    const finalX = smoothedPoints[smoothedPoints.length - 2];
    const finalY = smoothedPoints[smoothedPoints.length - 1];
    this.ui.updateRemoteCursor(user.id, finalX, finalY, user.size);

    if (!user.panning && user.mousedown) {
      this._requestRemotePreviewRender(user, { x: finalX, y: finalY });
    }

    // Keep canvas text preview in sync with cursor position when blend mode is active
    if (user.tool === 'text' && user.blendMode && user.blendMode !== 'source-over' && user.text) {
      this._renderRemoteTextToCanvas(user);
    }
  }

  /**
   * Starts the global catch-up loop to converge remote cursors to their targets.
   * @returns {void}
   */
  startCatchupLoop() {
    if (this.catchupTimer) return;
    this.catchupTimer = setInterval(() => this.tickCatchup(), this.catchupInterval);
  }

  /**
   * Performs one tick of the catch-up convergence logic.
   * Stops the loop when all users have reached their targets.
   * @returns {void}
   */
  tickCatchup() {
    let anyActive = false;

    // Tools that use EMA smoothing locally — catchup must match
    const smoothingTools = new Set(['brush', 'flowPen', 'imageBrush', 'ink', 'erase']);
    // Stamp-based tools: catchup should only update cursor, not generate new stamps.
    // Stamps come exclusively from sender's broadcast messages.
    const stampTools = new Set(['flowPen', 'ink', 'pixel', 'circleBlur', 'imageBrush', 'confetti']);

    for (const user of this.users.values()) {
      if (user.mousedown && !user.panning && user.remoteTarget) {
        const dx = user.remoteTarget.x - user.smoothBuffer.x;
        const dy = user.remoteTarget.y - user.smoothBuffer.y;
        const distSq = dx * dx + dy * dy;

        if (distSq > 0.25) {
          anyActive = true;
          const lastPos = { x: user.x, y: user.y };

          let pos;
          const userSmoothing = user.smoothing !== undefined ? user.smoothing : 0;

          // Apply EMA smoothing for tools that use it locally, matching InputBufferManager behavior
          if (smoothingTools.has(user.tool) && userSmoothing > 0) {
            const smoothed = applySmoothingEMA(
              user.smoothBuffer,
              user.remoteTarget.x,
              user.remoteTarget.y,
              user.pressure || 1,
              userSmoothing,
              0.12
            );
            pos = { x: smoothed.x, y: smoothed.y };
          } else {
            // No smoothing: snap directly to target
            pos = { x: user.remoteTarget.x, y: user.remoteTarget.y };
            user.smoothBuffer.x = pos.x;
            user.smoothBuffer.y = pos.y;
          }

          user.setPosition(pos.x, pos.y);
          this.ui.updateRemoteCursor(user.id, pos.x, pos.y, user.size);

          // Skip renderRemoteMove for stamp tools - stamps come from sender's broadcasts only.
          // Calling renderRemoteMove would generate extra stamps not present in sender's output.
          if (!stampTools.has(user.tool)) {
            this.renderRemoteMove(user, pos, lastPos);
          }
          this.app.boardViewer?.requestLiveRender?.();
        }
      }
    }

    if (!anyActive) {
      clearInterval(this.catchupTimer);
      this.catchupTimer = null;
    }
  }

  /**
   * Internal router to render a single movement step based on the user's active tool.
   *
   * @param {User} user - The remote user.
   * @param {Object} pos - The current {x, y} position.
   * @param {Object} lastPos - The previous {x, y} position.
   * @returns {void}
   */
  renderRemoteMove(user, pos, lastPos) {
    switch (user.tool) {
      case 'brush':
        user.addToLine(pos);

        if (user.pressure !== user.prevpressure) {
          this.commitLine(user);
        }
        user.prevpressure = user.pressure;
        break;

      case 'erase': {
        const eraserTool = this.toolManager.getTool('erase');
        if (eraserTool) {
          eraserTool.appendBufferedPoint(user, pos);
        }
        break;
        // Skip erasing if pressure is 0 — liftoff sample, no visible effect intended.
      }

      case 'blur':
        const blurTool = this.toolManager.getTool('blur');
        if (blurTool) {
          user.lastBlurPos = pos;
          blurTool.onPointerMove(user, pos, lastPos);
        }
        break;

      case 'glitchBlur': {
        // Glitch blur is non-deterministic, so remote clients wait for the
        // sender's rendered stamp image (GLITCH_RESULT) instead of recomputing
        // the (expensive) WASM stroke. To avoid a blank canvas in the meantime,
        // paint a cheap grey-square placeholder trail onto the user's preview
        // canvas; it's cleared on mouseUp when the real result lands.
        const glitchTool = this.toolManager.getTool('glitchBlur');
        if (glitchTool && user.context) {
          this._setUserLayerContent(user, true);
          glitchTool.drawPlaceholderAlong(user, user.context, lastPos, pos);
          // Track mirror regions in realtime like the sender's live stroke
          // does (_compositeStampWithMirrors) — otherwise the mirrored halves
          // pop in all at once when GLITCH_RESULT lands.
          this.board.forEachMirrorRegion({ points: lastPos ? [lastPos, pos] : [pos] }, (region) => {
            this.board.withMirroredRegionTransform(user.context, region, () => {
              glitchTool.drawPlaceholderAlong(user, user.context, lastPos, pos);
            });
          });
        }
        break;
      }

      case 'pixel': {
        const pixelTool = this.toolManager.getTool('pixel');
        if (pixelTool) {
          pixelTool.onPointerMove(user, pos, lastPos);
        }
        break;
      }

      case 'flowPen':
        this.penHandler.handlePenMove(user, pos);
        this._syncLayeredRemotePreview(user);
        break;

      case 'ink': {
        const pressure255 = Math.round((user.pressure ?? 1) * 255);
        this.inkHandler.handleInkPoints(user, [pos.x, pos.y], [pressure255]);
        this._syncLayeredRemotePreview(user);
        break;
      }

      case 'circleBlur': {
        const circleBlurTool = this.toolManager.getTool(user.tool);
        if (circleBlurTool) {
          circleBlurTool.onPointerMove(user, pos, lastPos);
        }
        break;
      }

      case 'imageBrush':
        if (user.imageBrush) {
          if (user.imageBrush._pendingStrokes) {
            user.imageBrush._pendingStrokes.push({ type: 'stamps', pts: [pos.x, pos.y] });
            break;
          }
          const imageBrushTool = this.toolManager.getTool('imageBrush');
          if (imageBrushTool) {
            imageBrushTool.onPointerMove(user, pos);
          }
        }
        break;

      case 'confetti': {
        if (user._confettiPendingStrokes) {
          user._confettiPendingStrokes.push({ type: 'move', pos: { ...pos } });
          break;
        }
        const confettiTool = this.toolManager.getTool('confetti');
        if (confettiTool) confettiTool.onPointerMove(user, pos);
        break;
      }
    }
  }

  /**
   * Renders the transient preview of a remote user's drawing (e.g., shapes, brush line).
   *
   * @param {User} user - The remote user.
   * @param {Object} pos - The current {x, y} position.
   * @returns {void}
   */
  renderRemotePreview(user, pos) {
    this._setUserLayerContent(user, true);
    // 'erase' is deliberately absent: the eraser owns its preview surface and
    // clears only the rect it is about to repaint (EraserTool.refreshPreview).
    // Its mask is cumulative while its dirty rect covers just the newest
    // segment, so a full clear here erased everything but that segment every
    // frame — a blocky preview that flickered and kept dropping the part
    // already erased, only to come out right at mouse-up (the commit path
    // never reads the preview).
    const needsClear = ['brush', 'line', 'rectangle', 'circle', 'text'].includes(user.tool);
    if (needsClear && !(user.tool === 'select' && user.floatingCanvas)) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    switch (user.tool) {
      case 'text':
        // DOM text element handles the preview; no canvas drawing needed here
        break;

      case 'brush':
        if (user.currentLine.length >= 2) {
          this.board.withSelectionMaskClip(user.context, user.id, () => {
            drawLineArray(user.currentLine, user.context, user, this.board);
            this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
              const mirroredLine = this.board.mirrorPointsToRegion(user.currentLine, region);
              this.board.withMirrorRegionClip(user.context, region, () => {
                drawLineArray(mirroredLine, user.context, user, this.board);
              });
            });
          });
        }
        break;

      case 'line':
        this.toolManager.getTool('line').drawPreviewOnContext(user.context, user, user.startPos, pos);
        break;

      case 'rectangle':
        this.board.withSelectionMaskClip(user.context, user.id, () => {
          this.toolManager.getTool('rectangle').drawRect(user.context, user, user.startPos, pos);
          this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
            this.board.withMirrorRegionClip(user.context, region, () => {
              this.toolManager.getTool('rectangle').drawRect(
                user.context,
                user,
                this.board.mirrorPointToRegion(user.startPos, region),
                this.board.mirrorPointToRegion(pos, region)
              );
            });
          });
        });
        break;

      case 'circle':
        this.board.withSelectionMaskClip(user.context, user.id, () => {
          this.toolManager.getTool('circle').drawEllipse(user.context, user, user.startPos, pos);
          this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
            this.board.withMirrorRegionClip(user.context, region, () => {
              this.toolManager.getTool('circle').drawEllipse(
                user.context,
                user,
                this.board.mirrorPointToRegion(user.startPos, region),
                this.board.mirrorPointToRegion(pos, region)
              );
            });
          });
        });
        break;

      case 'select':
        // Selection previews are rendered from SEL_PENDING so remote viewers
        // follow the authoritative selection path/bounds instead of a second
        // local reconstruction from cursor motion.
        break;

      case 'erase':
        // Same clear-then-repaint-the-dirty-rect path the local eraser takes.
        // Going straight to drawPreview here (as this used to) also hit its
        // `rect?.drawImage` shim, which treats a bare context as "no rect" and
        // copies the whole mask canvas on every arriving MM.
        this.toolManager.getTool('erase')?.refreshPreview(user);
        break;

    }

    this.board.maskPreviewForExistingMode?.(user.context, user);

    if (user.isMaskMode && user.maskSelection) {
      this.selectionHandler?.drawStaticMaskOutline(user, user.maskSelection, false);
    }

    // The shape tools are not bounded by the cursor path handleMouseMove
    // records: they draw between startPos (which never arrives as a move point)
    // and pos, and in 'center' mode extend the same distance the other side of
    // startPos again. Take the bounds from the tools' own geometry, the way
    // handleMouseUp does when it expands the committed dirty rect.
    this._expandShapePreviewBounds(user, pos);

    this._syncLayeredRemotePreview(user);
  }

  /**
   * Handles remote mouse down events.
   *
   * @param {User} user - The remote user.
   * @param {Object} [data={}] - Event data containing starting points.
   * @returns {void}
   */
  handleMouseDown(user, data = {}) {
    // See handleMouseMove: a rebuild replays our own MD as the start of a stroke
    // we no longer have, so it must open one rather than bail.
    if (this.app.isSelfEcho(user.id)) return;

    this.ui.markRemoteCursorActivity(user.id);
    // Universal stroke start. Ink, pen and selection render into user.context
    // from their own handlers rather than through renderRemotePreview, so this
    // is the one place guaranteed to run before any of them draw — pairing with
    // the clears in handleMouseUp/commitLine/_cleanupTransientUserState below.
    this._setUserLayerContent(user, true);
    user.mousedown = true;
    user._mainCtxDrawCount = 0;
    if (data.layerIndex !== undefined) user.setActiveLayer(data.layerIndex);
    if (data.blendMode !== undefined) user.setBlendMode(data.blendMode);
    if (data.blendBakeMode !== undefined) user.setBlendBakeMode(data.blendBakeMode);
    if (user.tool === 'confetti' && data.confettiData) {
      this.handleConfettiBrushLoad(user, data.confettiData);
    }
    user.clearLine();
    // Bounds are per stroke; carrying the last one over would grow the preview
    // rect monotonically for as long as the user keeps drawing.
    user._previewDirtyBounds = null;

    resetSmoothingBuffer(user.smoothBuffer);
    user.remoteTarget = null;

    if (data.ps && data.ps.length >= 2) {
      const rx = data.ps[0];
      const ry = data.ps[1];
      user.setPosition(rx, ry);
      user.smoothBuffer.x = rx;
      user.smoothBuffer.y = ry;
      user.smoothBuffer.isFirst = false;
    }

    user.lastx = user.x;
    user.lasty = user.y;
    user.spaceIndex = 0;

    const pos = { x: user.x, y: user.y };
    user.startPos = pos;
    user.setPosition(pos.x, pos.y);
    user._strokeLayer = user.activeLayer ?? 0;
    // Seed the preview bounds with the down point. The tools that render a
    // preview from here (pen, ink) sync before any move has arrived, and empty
    // bounds there cost one full-board composite per stroke.
    if (!user.panning) this._expandPreviewBounds(user, [pos], this._maxBrushMargin(user));

    if (!user.panning) {
      if (user.tool === 'erase' && user.eraseAllLayers) {
        this.board.beginStrokeAllLayers(user, 'destination-out');
      } else if (user.tool !== 'blur' && user.tool !== 'glitchBlur' && user.tool !== 'fill' && user.tool !== 'text') {
        // Blur tool handles its own stroke creation in onPointerDown with filter metadata
        // Fill tool manages its own stroke lifecycle via the dedicated FILL message handler
        const blendMode = user.tool === 'erase' ? 'destination-out' : (user.blendMode || 'source-over');
        const strokeLayer = this.getStrokeLayer(user);
        const strokeBounds = this._canWindowActiveStroke(user) ? this._activeStrokeWindowBounds(user) : null;
        this.board.layerManager.beginUserStroke(strokeLayer, user.id, blendMode, user.blendBakeMode, strokeBounds);
        this.board.applySelectionMaskClipForStroke(strokeLayer, user.id);
      }
    }

    switch (user.tool) {
      case 'brush':
        if (!user.panning) {
          user.addToLine(pos);
          user.addToLine(pos);
        }
        break;

      case 'flowPen':
        this.penHandler.handlePenDown(user, pos);
        this._syncLayeredRemotePreview(user);
        break;

      case 'ink':
        this.inkHandler.handleInkDown(user, pos);
        this._syncLayeredRemotePreview(user);
        break;

      case 'erase':
        if (user.panning) {
          break;
        }
        {
          this.updateRemotePreviewPresentation(user);
          const eraserTool = this.toolManager.getTool('erase');
          if (eraserTool) {
            eraserTool.onPointerDown(user, pos);
          }
          break;
        }
        break;

      case 'blur':
        if (!user.panning) {
          const blurTool = this.toolManager.getTool('blur');
          if (blurTool) {
            blurTool.onPointerDown(user, pos);
          }
        }
        break;

      case 'glitchBlur': {
        // The drawing client sends the rendered glitch stamps via GLITCH_RESULT.
        // Until then, show a cheap grey-square placeholder on the user's preview
        // canvas so the in-progress stroke is visible (live remote + replay).
        const glitchTool = this.toolManager.getTool('glitchBlur');
        if (glitchTool && user.context) {
          this._setUserLayerContent(user, true);
          user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
          // Keep the preview canvas neutral + visible: the placeholder is plain
          // grey and the baked result travels source-over, so no blend here.
          if (user.board) {
            user.board.style.opacity = '';
            user.board.style.mixBlendMode = 'normal';
          }
          glitchTool.drawPlaceholderAlong(user, user.context, pos, pos);
          this.board.forEachMirrorRegion({ point: pos }, (region) => {
            this.board.withMirroredRegionTransform(user.context, region, () => {
              glitchTool.drawPlaceholderAlong(user, user.context, pos, pos);
            });
          });
        }
        break;
      }

      case 'pixel':
        if (!user.panning) {
          const pixelTool = this.toolManager.getTool('pixel');
          if (pixelTool) {
            pixelTool.onPointerDown(user, pos);
          }
        }
        break;

      case 'circleBlur':
        if (!user.panning) {
          const circleBlurTool = this.toolManager.getTool(user.tool);
          if (circleBlurTool) {
            const radius = user.pressure * user.size;
            circleBlurTool.beginSnapshot(user.id);
            circleBlurTool.strokePoints?.set?.(user.id, [{ x: pos.x, y: pos.y }]);
            circleBlurTool.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
            circleBlurTool.stampBlurredCircle(pos.x, pos.y, radius, user);
            this.board.forEachMirrorRegion({ point: pos }, (region) => {
              const mirrored = this.board.mirrorPointToRegion(pos, region);
              circleBlurTool.stampBlurredCircle(mirrored.x, mirrored.y, radius, user, region);
            });
          }
        }
        break;


    if (!user.panning && ['brush', 'line', 'rectangle', 'circle', 'erase'].includes(user.tool)) {
      this.renderRemotePreview(user, pos);
      this.app.boardViewer?.requestLiveRender?.();
    }
      case 'imageBrush':
        if (user.imageBrush && !user.panning) {
          if (user.imageBrush._pendingStrokes) {
            user.imageBrush._pendingStrokes.push({ type: 'down', pos: { ...pos } });
            return;
          }
          if (user.imageBrush.type === 'gih' && user.imageBrush.reset) {
            user.imageBrush.reset();
          }
          const imageBrushTool = this.toolManager.getTool('imageBrush');
          if (imageBrushTool) {
            user._imageBrushLastPos = { x: pos.x, y: pos.y };
            user._imageBrushLastTime = performance.now();
            user._imageBrushDirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            user._imageBrushStrokePoints = [{ x: pos.x, y: pos.y }];
            imageBrushTool.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
            imageBrushTool.drawStamp(user, pos);
          }
        }
        break;

      case 'confetti': {
        if (!user.panning) {
          if (user._confettiPendingStrokes) {
            // Buffer until the particle sprite decodes — see handleConfettiBrushLoad.
            user._confettiPendingStrokes.push({
              type: 'down',
              pos: { ...pos },
              seed: user._confettiStrokeSeed
            });
            break;
          }
          const confettiTool = this.toolManager.getTool('confetti');
          if (confettiTool) confettiTool.onPointerDown(user, pos);
        }
        break;
      }

      case 'pattern':
        if (!user.panning) {
          // Buffer until the pattern image decodes — see handlePatternBrushLoad.
          if (user._patternPendingStrokes) {
            user._patternPendingStrokes.push({ type: 'down', pos: { ...pos } });
            return;
          }
          const patternTool = this.toolManager.getTool('pattern');
          if (patternTool) {
            patternTool.remoteBeginStroke(user, pos);
          }
        }
        break;

      case 'fill':
        if (!user.panning) {
          this._invalidateFillPreview(user);
          this._drawFillPreview(user, pos);
        }
        break;

      case 'select':
        if (user.pendingSelection && !user.floatingCanvas) {
          const s = user.pendingSelection;
          const clickedInside = pos.x >= s.x && pos.x <= s.x + s.width &&
                                pos.y >= s.y && pos.y <= s.y + s.height;
          if (!clickedInside) {
            user.pendingSelection = null;
            user.pendingLassoPath = null;
            user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
          }
        }
        user.lassoPoints = [{ x: pos.x, y: pos.y }];
        break;
    }
  }

  /**
   * Handles remote mouse up events. Finalizes and commits remote strokes.
   *
   * @param {User} user - The remote user.
   * @returns {void}
   */
  handleMouseUp(user, seq = 0) {
    // Self-reconciliation: If this is the local user's own 'mu' message, it
    // contains the server-assigned sequence number for the stroke they just
    // optimistically committed. Update the record in LayerManager so global
    // ordering is consistent across all clients.
    // Reconcile-only ONLY when this really is an echo of a stroke we still hold.
    // On a sync rebuild there is no optimistic local stroke to reconcile — the
    // board was cleared and this MU is closing a stroke the replayed MD/MM just
    // opened, so it has to take the full commit path and carry `seq` itself.
    if (this.app.isSelfEcho(user.id)) {
      // Self-echo of our own MU: assign the authoritative global seq to our
      // oldest still-optimistic stroke (search all layers — we may have switched
      // layers before the echo returned). Reconcile-only; we already drew it.
      // Do NOT touch user.mousedown here: the echo is async and may land after
      // we've already begun a *new* local stroke, and clobbering it would break
      // that stroke. The local pointer handlers own mousedown.
      this.board.layerManager.reconcileOldestLocalStroke(user.id, seq);
      return;
    }

    if (!user.mousedown) return;

    if (user.tool === 'imageBrush' && user.imageBrush?._pendingStrokes) {
      user.imageBrush._pendingStrokes.push({ type: 'up', seq });
      user.mousedown = false; // Stop further mouse move processing
      return;
    }

    // Same for a pattern stroke still waiting on its image to decode. Returning
    // before the commit machinery leaves the active stroke open; replayPending
    // re-enters here once the tile can actually be built, so the commit happens
    // with real pixels and this MU's authoritative seq.
    if (user.tool === 'pattern' && user._patternPendingStrokes) {
      user._patternPendingStrokes.push({ type: 'up', seq });
      user.mousedown = false;
      return;
    }

    // Same for a confetti stroke still waiting on its particle sprite.
    if (user.tool === 'confetti' && user._confettiPendingStrokes) {
      user._confettiPendingStrokes.push({ type: 'up', seq });
      user.mousedown = false;
      return;
    }

    const pos = { x: user.x, y: user.y };
    const strokeLayer = this.getStrokeLayer(user);
    user.remoteTarget = null;
    if (user.tool === 'fill') {
      this._invalidateFillPreview(user);
    }

    const muStrokeBounds = this._canWindowActiveStroke(user) ? this._activeStrokeWindowBounds(user) : null;
    const activeStrokeCtx = this.board.layerManager.getUserStrokeContext(
      strokeLayer, user.id, undefined, undefined, muStrokeBounds
    );

    const hadPenStroke = user._penStrokeActive;
    if (hadPenStroke) {
      this.penHandler.handlePenUp(user);
    }

    const hadInkStroke = user._inkStrokeActive;
    if (hadInkStroke) {
      this.inkHandler.handleInkUp(user);
    }

    if (hadPenStroke || hadInkStroke) {
      // Handled above
    } else switch (user.tool) {
      case 'brush':
        if (activeStrokeCtx && user.currentLine.length >= 2) {
          // Same board-absolute-vs-canvas-local translation commitLine needs
          // — see the comment there. A windowed active canvas's origin is
          // non-zero here whenever this MU is closing a stroke that was
          // windowed throughout (the common case: no CP/CS happened first).
          const active = this.board.layerManager.getActiveStroke(strokeLayer, user.id);
          const ox = active?.origin?.x ?? 0;
          const oy = active?.origin?.y ?? 0;
          if (ox || oy) activeStrokeCtx.save();
          try {
            if (ox || oy) activeStrokeCtx.translate(-ox, -oy);
            drawLineArray(user.currentLine, activeStrokeCtx, user);
            this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
              const mirroredLine = this.board.mirrorPointsToRegion(user.currentLine, region);
              this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
                drawLineArray(mirroredLine, activeStrokeCtx, user);
              });
            });
          } finally {
            if (ox || oy) activeStrokeCtx.restore();
          }
          this._expandDirtyRectFromPoints(user, user.currentLine, this._brushMargin(user));
        }
        break;

      case 'line':
        if (activeStrokeCtx) {
          // Active canvas may be windowed (see docs/
          // scope_layermanager_active_stroke_windowing_RESULT.md) — same
          // translate fix shape as the 'brush' case above.
          const active = this.board.layerManager.getActiveStroke(strokeLayer, user.id);
          const ox = active?.origin?.x ?? 0;
          const oy = active?.origin?.y ?? 0;
          if (ox || oy) activeStrokeCtx.save();
          try {
            if (ox || oy) activeStrokeCtx.translate(-ox, -oy);
            // drawPreviewOnContext already draws the mirrored copies internally
            // (unlike drawRect/drawEllipse below) — wrapping it in another
            // forEachMirrorRegion pass drew every line twice on both sides of
            // the mirror (mirror-of-mirror lands back on the original).
            this.toolManager.getTool('line').drawPreviewOnContext(activeStrokeCtx, user, user.startPos, pos);
          } finally {
            if (ox || oy) activeStrokeCtx.restore();
          }
          // Mirror LineTool.onPointerUp margin so the hardness blur halo is
          // included in the dirtyRect, otherwise commitUserStroke crops the
          // halo off and observers' committed stroke disagrees with drawer's.
          const lineRadius = user.size;
          const lineHardness = (user.hardness !== undefined ? user.hardness : 100) / 100;
          const lineBlur = lineHardness < 1.0 ? (1 - lineHardness) * (20 + user.size * 0.2) : 0;
          const lineMargin = lineRadius + lineBlur + lineRadius * 0.1 + 2;
          this._expandDirtyRectFromPoints(user, [user.startPos, pos], lineMargin);
        }
        break;

      case 'rectangle':
        if (activeStrokeCtx) {
          const active = this.board.layerManager.getActiveStroke(strokeLayer, user.id);
          const ox = active?.origin?.x ?? 0;
          const oy = active?.origin?.y ?? 0;
          const rectangleTool = this.toolManager.getTool('rectangle');
          if (ox || oy) activeStrokeCtx.save();
          try {
            if (ox || oy) activeStrokeCtx.translate(-ox, -oy);
            rectangleTool.drawRect(activeStrokeCtx, user, user.startPos, pos);
            this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
              this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
                rectangleTool.drawRect(
                  activeStrokeCtx,
                  user,
                  this.board.mirrorPointToRegion(user.startPos, region),
                  this.board.mirrorPointToRegion(pos, region)
                );
              });
            });
          } finally {
            if (ox || oy) activeStrokeCtx.restore();
          }
          const rectMargin = this._brushMargin(user);
          // Same mode the paint above resolved from the user, or the dirty rect
          // crops the committed record to different bounds than were drawn.
          const rectBounds = rectangleTool.getRectBounds(
            user.startPos, pos, false, user.shapeDrawMode
          );
          this._expandDirtyRectFromRect(user, rectBounds, rectMargin);
        }
        break;

      case 'circle':
        if (activeStrokeCtx) {
          const active = this.board.layerManager.getActiveStroke(strokeLayer, user.id);
          const ox = active?.origin?.x ?? 0;
          const oy = active?.origin?.y ?? 0;
          const circleTool = this.toolManager.getTool('circle');
          if (ox || oy) activeStrokeCtx.save();
          try {
            if (ox || oy) activeStrokeCtx.translate(-ox, -oy);
            circleTool.drawEllipse(activeStrokeCtx, user, user.startPos, pos);
            this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
              this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
                circleTool.drawEllipse(
                  activeStrokeCtx,
                  user,
                  this.board.mirrorPointToRegion(user.startPos, region),
                  this.board.mirrorPointToRegion(pos, region)
                );
              });
            });
          } finally {
            if (ox || oy) activeStrokeCtx.restore();
          }
          const circleMargin = this._brushMargin(user);
          const ellipse = circleTool.getEllipseParams(
            user.startPos, pos, false, user.shapeDrawMode
          );
          this._expandDirtyRectFromRect(user, {
            x: ellipse.cx - ellipse.rx,
            y: ellipse.cy - ellipse.ry,
            w: ellipse.rx * 2,
            h: ellipse.ry * 2
          }, circleMargin);
        }
        break;

      case 'select':
        // Don't set pendingSelection or pendingLassoPath here — the authoritative
        // selection data comes via SEL_PENDING which provides the correctly simplified
        // lasso path. Setting it here from user.lassoPoints would overwrite the correct
        // path with an incomplete one (live preview only captures ~1 point per message batch).
        break;

      case 'blur':
        if (!user.panning) {
          const blurTool = this.toolManager.getTool('blur');
          if (blurTool) {
            blurTool.onPointerUp(user, pos, { seq });
          }
        }
        break;

      case 'glitchBlur':
        // Committed when GLITCH_RESULT arrives.
        break;

      case 'pixel':
        if (!user.panning) {
          const pixelTool = this.toolManager.getTool('pixel');
          if (pixelTool) {
            pixelTool.onPointerUp(user, pos, { seq });
          }
        }
        break;

      case 'erase': {
        const eraserTool = this.toolManager.getTool('erase');
        if (eraserTool) {
          eraserTool.commitCurrentLine(user, user.pressure, user.size, user.opacity, false, { seq });
        }
        break;
      }

      case 'text':
        break;

      case 'pattern':
        if (!user.panning) {
          const patternTool = this.toolManager.getTool('pattern');
          if (patternTool) patternTool.remoteEndStroke(user, seq);
        }
        break;
    }

    // Remove the transient layered preview before committing/compositing the
    // finished stroke, otherwise the final composite can keep drawing the
    // preview canvas until the next remote stroke invalidates it.
    this._clearLayeredRemotePreview(user);

    // Collect erased tiles before committing (for tile ownership check)
    let erasedTiles = null;
    if (user.tool === 'erase') {
      erasedTiles = new Set();
      if (user.eraseAllLayers) {
        const count = this.board.layerManager.getLayerCount();
        for (let i = 0; i < count; i++) {
          const group = this.board.layerManager.getLayerGroup(i);
          const active = group?.activeStrokeByUser?.get(user.id);
          if (active?.affectedTiles) {
            for (const idx of active.affectedTiles) erasedTiles.add(idx);
          }
        }
      } else {
        const group = this.board.layerManager.getLayerGroup(strokeLayer);
        const active = group?.activeStrokeByUser?.get(user.id);
        if (active?.affectedTiles) {
          for (const idx of active.affectedTiles) erasedTiles.add(idx);
        }
      }
    }

    if (user.tool === 'erase' && user.eraseAllLayers) {
      this.board.endStrokeAllLayers(user, { seq });
    } else if (user.tool !== 'fill' && user.tool !== 'text' && user.tool !== 'glitchBlur') {
      // Fill tool commits its own stroke via the dedicated FILL message handler
      this.board.releaseSelectionMaskClipForStroke(strokeLayer, user.id);
      this.board.layerManager.commitUserStroke(strokeLayer, user.id, { seq });
      if (this.board._compositeCommittedStrokeNow) {
        this.board._compositeCommittedStrokeNow();
      } else {
        this.board.compositeAllLayers();
      }
    }

    if (user.tool === 'fill' || user.tool === 'text') {
      this.board.compositeAllLayers();
    }

    if (!(user.tool === 'select' && user.floatingCanvas) && user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      this._setUserLayerContent(user, false);
      if (user.context.canvas) {
        user.context.canvas.style.opacity = '';
      }
      if (user.isMaskMode && user.maskSelection) {
        this.selectionHandler?.drawStaticMaskOutline(user, user.maskSelection, false);
      }
    }
    this._clearLayeredRemotePreview(user);

    // Check erased tiles and clear ownership for empty ones (don't broadcast - remote user handles that)
    if (erasedTiles && erasedTiles.size > 0) {
      this.board.compositeAllLayers();
      this.board.checkErasedTilesByIndices(erasedTiles, false);
    }

    user.clearLine();
    user.mousedown = false;
    user._strokeLayer = null;
    user.startPos = null;
    user.lassoPoints = null;
    this.updateRemotePreviewPresentation(user);

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) {
      circleBlurTool.lastStampPos.delete(user.id);
      circleBlurTool.clearSnapshot(user.id);
      circleBlurTool.strokePoints?.delete?.(user.id);
    }

    const glitchBlurTool = this.toolManager.getTool('glitchBlur');
    if (glitchBlurTool) glitchBlurTool.lastStampPos.delete(user.id);

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) imageBrushTool.lastStampPos.delete(user.id);
    delete user._imageBrushLastPos;
    delete user._imageBrushLastTime;
    delete user._imageBrushDirtyBounds;
    delete user._imageBrushStrokePoints;

    const confettiTool = this.toolManager.getTool('confetti');
    if (confettiTool) confettiTool.lastStampPos.delete(user.id);
    delete user._confettiDirtyBounds;
    delete user._confettiStrokePoints;

    const pixelTool = this.toolManager.getTool('pixel');
    if (pixelTool) {
      pixelTool.lastStampPos.delete(user.id);
      const tempCanvas = pixelTool.tempCanvases.get(user.id);
      this._disposeCanvasElement(tempCanvas);
      pixelTool.tempCanvases.delete(user.id);
    }
    delete user._pixelStrokePoints;
    delete user._pixelPreviewDirtyBounds;

    const eraserTool = this.toolManager.getTool('erase');
    eraserTool?.lastPos?.delete?.(user.id);

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) patternTool.lastStampPos.delete(user.id);

    if (user.floatingCanvas && user.selection) {
      this.selectionHandler.drawFloatingSelection(user);
    }
    else if (user.pendingSelection) {
      this.selectionHandler.drawPendingSelection(user);
      this.selectionHandler.startRemoteSelectionAnimation();
    }
  }

  queueRemoteGlitchImage(user, bounds, layerIndex = null, seq = 0, blendMode = null, blendBakeMode = null) {
    if (!user || !bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    const token = { user, bounds, layerIndex, seq, blendMode, blendBakeMode, resultCanvas: null, canceled: false };
    const queue = this.pendingGlitchImagesByUser.get(user.id) || [];
    queue.push(token);
    this.pendingGlitchImagesByUser.set(user.id, queue);
    return token;
  }

  resolveRemoteGlitchImage(token, resultCanvas) {
    if (!token || token.canceled) {
      this._processPendingGlitchImages(token?.user?.id);
      return;
    }
    token.resultCanvas = resultCanvas;
    this._processPendingGlitchImages(token.user.id);
  }

  cancelLatestPendingGlitchImage(userId) {
    const queue = this.pendingGlitchImagesByUser.get(userId);
    if (!queue?.length) return false;

    for (let i = queue.length - 1; i >= 0; i--) {
      const token = queue[i];
      if (!token.canceled) {
        token.canceled = true;
        this._processPendingGlitchImages(userId);
        return true;
      }
    }
    return false;
  }

  /**
   * Seq of the latest in-flight (queued, not yet committed) glitch stamp for a
   * user — i.e. the token cancelLatestPendingGlitchImage would cancel. Glitch
   * stamps commit asynchronously (image decode), so an undo can arrive before the
   * stamp lands in the strokeStack; the caller uses this seq to decide whether the
   * undo actually targets the in-flight glitch (vs a later committed stroke).
   * @param {number} userId
   * @returns {number} The latest pending glitch seq, or -1 if none is in flight.
   */
  getLatestPendingGlitchSeq(userId) {
    const queue = this.pendingGlitchImagesByUser.get(userId);
    if (!queue?.length) return -1;

    for (let i = queue.length - 1; i >= 0; i--) {
      if (!queue[i].canceled) return queue[i].seq || 0;
    }
    return -1;
  }

  _processPendingGlitchImages(userId) {
    if (userId == null) return;
    const queue = this.pendingGlitchImagesByUser.get(userId);
    if (!queue?.length) return;

    while (queue.length > 0) {
      const token = queue[0];
      if (token.canceled) {
        queue.shift();
        continue;
      }
      if (!token.resultCanvas) break;
      queue.shift();
      this.commitRemoteGlitchImage(token.user, token.resultCanvas, token.bounds, token.layerIndex, token.seq, token.blendMode, token.blendBakeMode);
    }

    if (queue.length === 0) {
      this.pendingGlitchImagesByUser.delete(userId);
    }
  }

  commitRemoteGlitchImage(user, resultCanvas, bounds, layerIndex = null, seq = 0, blendModeOverride = null, blendBakeModeOverride = null) {
    if (!user || !resultCanvas || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const pendingUndoCount = this.pendingGlitchUndoByUser.get(user.id) || 0;
    if (pendingUndoCount > 0) {
      if (pendingUndoCount === 1) {
        this.pendingGlitchUndoByUser.delete(user.id);
      } else {
        this.pendingGlitchUndoByUser.set(user.id, pendingUndoCount - 1);
      }
      return;
    }

    const targetLayer = Number.isFinite(Number(layerIndex)) ? Number(layerIndex) : this.getStrokeLayer(user);
    const group = this.board.layerManager?.getLayerGroup(targetLayer);
    // A glitch result authoritatively defines its own blend. Prefer the blend
    // that travelled with the result (draw-time) over the user's live blendMode —
    // the image decode is async, so by now the live blend may belong to a later
    // stroke.
    // Glitch results now bake their displayed (blend-resolved) appearance into
    // the image and travel as source-over (see GlitchBlurTool). So default to
    // source-over here rather than the user's LIVE blend: the broadcast omits
    // bm/bbm for source-over, and falling back to user.blendMode would re-blend
    // an already-blended image (e.g. white 'difference' over white → black).
    // An explicit override (older recordings that carried a real blend) still
    // wins for backward compatibility.
    const blendMode = blendModeOverride || 'source-over';
    const blendBakeMode = blendBakeModeOverride || 'background';

    let active = group?.activeStrokeByUser?.get(user.id);
    if (!active) {
      this.board.layerManager.beginUserStroke(targetLayer, user.id, blendMode, blendBakeMode);
      this.board.applySelectionMaskClipForStroke(targetLayer, user.id);
      active = group?.activeStrokeByUser?.get(user.id);
    } else {
      // A stale/foreign active stroke is being reused — the begin branch (which
      // sets blend) was skipped, so the glitch would inherit whatever blend that
      // stroke had (usually source-over → opaque squares). Force the glitch's
      // blend onto it so the commit composites correctly.
      active.blendMode = blendMode;
      active.blendBakeMode = normalizeBlendBakeMode(blendBakeMode);
    }
    if (!active?.ctx) return;

    active.ctx.save();
    active.ctx.globalCompositeOperation = 'source-over';
    active.ctx.globalAlpha = 1;
    active.ctx.drawImage(resultCanvas, bounds.x, bounds.y, bounds.width, bounds.height);
    active.ctx.restore();

    this.board.layerManager._expandDirtyRect(active.dirtyRect, bounds.x, bounds.y, bounds.width, bounds.height);
    this.board.compositeTileGrid?.markRect(bounds.x, bounds.y, bounds.width, bounds.height);

    this.board.releaseSelectionMaskClipForStroke(targetLayer, user.id);
    this.board.layerManager.commitUserStroke(targetLayer, user.id, {
      isRemoteGlitchImage: true,
      // Authoritative per-layer seq from GLITCH_RESULT — keeps this glitch
      // stroke ordered identically to the drawer (who reconciles its matching
      // local glitch stroke to this same seq). seq=0 would sort it to the top.
      seq: seq || 0
    });
    if (this.board._compositeCommittedStrokeNow) {
      this.board._compositeCommittedStrokeNow();
    } else {
      this.board.compositeAllLayers();
    }
  }

  markPendingGlitchUndo(userId) {
    if (userId == null) return;
    const count = this.pendingGlitchUndoByUser.get(userId) || 0;
    this.pendingGlitchUndoByUser.set(userId, count + 1);
  }

  undoLatestRemoteGlitchImage(userId) {
    const layerCount = this.board.layerManager?.getLayerCount?.() ?? 0;
    for (let layerIndex = layerCount - 1; layerIndex >= 0; layerIndex--) {
      const group = this.board.layerManager?.getLayerGroup(layerIndex);
      if (!group?.strokeStack) continue;

      for (let i = group.strokeStack.length - 1; i >= 0; i--) {
        const record = group.strokeStack[i];
        if (record.userId === userId && record.isRemoteGlitchImage) {
          const removed = group.strokeStack.splice(i, 1)[0];
          const count = group.userStrokeCounts.get(userId) || 0;
          if (count > 0) group.userStrokeCounts.set(userId, count - 1);
          const batch = [{ groupIdx: layerIndex, record: removed }];
          this.board.layerManager._pushToRedoStack(userId, batch);
          this.board._markBatchDirtyRects?.(batch);
          this.board.compositeAllLayers();
          this.board.layerManager._notifyHistoryPanel?.(true);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Updates remote text buffer based on key presses.
   *
   * @param {User} user - The remote user typing.
   * @param {string} key - The character or key name (e.g., 'Enter', 'Backspace').
   * @returns {void}
   */
  handleKeyPress(user, key) {
    this.ui.markRemoteCursorActivity(user.id);

    // Parse modifiers from key string
    const isCtrlAction = key.startsWith('Ctrl+');
    const isShiftEnter = key === 'Shift+Enter';

    let actualKey = key;
    let ctrlKey = false;
    if (isCtrlAction) {
      actualKey = key.substring(5); // Remove 'Ctrl+' prefix
      ctrlKey = true;
    } else if (isShiftEnter) {
      actualKey = 'Enter';
    }

    if (actualKey.length === 1) {
      user.text += actualKey;
    } else if (actualKey === 'Enter') {
      if (isShiftEnter) {
        user.text += '\n';
      } else {
        user.text = '';
      }
    } else if (actualKey === 'Backspace') {
      if (ctrlKey) {
        // Ctrl+Backspace: delete word backwards
        const text = user.text;
        let i = text.length - 1;
        // Skip trailing whitespace backwards
        while (i >= 0 && /\s/.test(text[i])) i--;
        // Skip word characters backwards
        while (i >= 0 && /\S/.test(text[i])) i--;
        user.text = text.slice(0, i + 1);
      } else {
        user.text = user.text.slice(0, -1);
      }
    } else if (actualKey === 'Delete') {
      if (ctrlKey) {
        // Ctrl+Delete: same as Ctrl+Backspace since cursor is at end
        const text = user.text;
        let i = text.length - 1;
        // Skip trailing whitespace backwards
        while (i >= 0 && /\s/.test(text[i])) i--;
        // Skip word characters backwards
        while (i >= 0 && /\S/.test(text[i])) i--;
        user.text = text.slice(0, i + 1);
      }
    }

    const hasBlendMode = user.blendMode && user.blendMode !== 'source-over';
    if (hasBlendMode) {
      this.ui.setRemoteTextDomVisible(user.id, false);
      this._renderRemoteTextToCanvas(user);
    } else {
      this.ui.setRemoteTextDomVisible(user.id, true);
      this.ui.updateRemoteText(user.id, user.text);
    }
  }

  handleTextApply(user, data) {
    if (!user || !data?.text) return;

    const layerIndex = data.layerIndex ?? user.activeLayer ?? 0;

    if (data.pixel) {
      // Legacy raster path — text becomes a permanent stroke on the remote layer.
      const blendMode = data.blendMode || user.blendMode || 'source-over';
      const blendBakeMode = data.blendBakeMode || user.blendBakeMode || 'background';
      const textUser = {
        ...user,
        text: data.text,
        x: data.position?.x ?? user.x,
        y: data.position?.y ?? user.y,
        size: data.size ?? user.size,
        color: data.color ?? user.color,
        opacity: data.opacity ?? user.opacity,
        activeLayer: layerIndex,
        blendMode,
        blendBakeMode,
        font: data.font ?? user.font,
        textPositionMultiplier: data.textPositionMultiplier ?? user.textPositionMultiplier,
        textPositionOffset: data.textPositionOffset ?? user.textPositionOffset,
        getColorString() {
          return `rgba(${this.color.join(',')})`;
        }
      };
      this.board.layerManager.beginUserStroke(layerIndex, user.id, blendMode, blendBakeMode);
      this.board.applySelectionMaskClipForStroke(layerIndex, user.id);
      this.toolManager.getTool('text').drawText(textUser);
      this.board.releaseSelectionMaskClipForStroke(layerIndex, user.id);
      // Authoritative per-broadcast seq from TEXT_APPLY. At seq 0 the bake sorts
      // to the top of the stack (_sortStrokeStack maps 0 to MAX_SAFE_INTEGER) and
      // ties break on this client's own clock, so text landed in a different
      // z-order on every client. The drawer reconciles its own copy to the same
      // seq on the self echo.
      this.board.layerManager.commitUserStroke(layerIndex, user.id, { seq: data.seq || 0 });
    } else {
      // Vector path — add to ephemeral SVG overlay.
      const id = data.id || `t_${user.id ?? 0}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.board.textOverlay?.add({
        id,
        userId: user.id ?? 0,
        text: data.text,
        font: data.font ?? user.font,
        size: data.size ?? user.size,
        color: data.color ?? user.color,
        opacity: data.opacity ?? user.opacity,
        x: data.position?.x ?? user.x,
        y: data.position?.y ?? user.y,
        textPositionMultiplier: data.textPositionMultiplier ?? user.textPositionMultiplier,
        textPositionOffset: data.textPositionOffset ?? user.textPositionOffset,
        layerIdx: layerIndex,
        lifetimeMs: data.lifetimeMs,
        fadeMs: data.fadeMs,
        ageMs: data.ageMs ?? 0
      });
    }

    user.text = '';
    if (user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      this._setUserLayerContent(user, false);
    }
    this.ui.setRemoteTextDomVisible(user.id, true);
    this.ui.updateRemoteText(user.id, '');
    this.board.requestUpdate();
  }

  /**
   * Draws the remote user's current text to their preview canvas.
   * Used when a non-default blend mode is active — the userBoard canvas already
   * has CSS mix-blend-mode set, so drawing here achieves the blend effect.
   *
   * @private
   * @param {User} user - The remote user.
   * @returns {void}
   */
  _renderRemoteTextToCanvas(user) {
    const ctx = user.context;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    if (!user.text) {
      this._setUserLayerContent(user, false);
      return;
    }
    this._setUserLayerContent(user, true);
    const { fontSize, drawX, baselineY } = getPreviewTextLayout(user);
    const lineHeight = getUserTextLineHeight(user);
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px ${user.font}`;
    ctx.textBaseline = 'alphabetic';
    user.text.split('\n').forEach((line, i) => {
      ctx.fillText(line, drawX, baselineY + (i * lineHeight));
    });
    ctx.restore();
  }

  /**
   * Loads a brush resource for a remote user.
   *
   * @param {User} user - The remote user.
   * @param {string|Object} brushDataStr - Serialized brush configuration.
   * @returns {void}
   */
  handleBrushLoad(user, brushDataStr) {
    let brushData;
    try {
      brushData = typeof brushDataStr === 'string' ? JSON.parse(brushDataStr) : brushDataStr;
    } catch (err) {
      console.error(`[ImageBrush] Failed to parse brush payload for remote user ${user?.id}:`, err);
      return;
    }
    if (!brushData || typeof brushData !== 'object') return;

    // Assign immediately so that MD/stamp messages arriving before the image
    // element finishes decoding still see the correct brush identity.
    // Strokes that arrive while the image is still loading are buffered in
    // brushData._pendingStrokes and replayed once the image is ready.
    user.imageBrush = brushData;
    user.imageBrushColorMode = brushData.colorMode ?? 'original';
    brushData._pendingStrokes = [];

    const replayPending = () => {
      const pending = brushData._pendingStrokes;
      delete brushData._pendingStrokes;
      if (!pending || pending.length === 0) return;
      
      const tool = this.toolManager.getTool('imageBrush');
      if (!tool) return;
      
      // Temporary swap to ensure we use the brush we JUST loaded during replay.
      // The colour mode rides along: it is part of THIS payload, and a join
      // tail now replays several brushes back to back (StrokeTape's image tool
      // state), so the mode in force when these stamps were drawn is not
      // necessarily the one the newest payload set.
      const currentBrush = user.imageBrush;
      const currentColorMode = user.imageBrushColorMode;
      user.imageBrush = brushData;
      user.imageBrushColorMode = brushData.colorMode ?? 'original';

      for (const entry of pending) {
        if (entry.type === 'down') {
          user._imageBrushLastPos = { x: entry.pos.x, y: entry.pos.y };
          user._imageBrushLastTime = performance.now();
          user._imageBrushDirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          user._imageBrushStrokePoints = [{ x: entry.pos.x, y: entry.pos.y }];
          tool.lastStampPos.set(user.id, entry.pos);
          user.mousedown = true;
          tool.drawStamp(user, entry.pos);
        } else if (entry.type === 'stamps') {
          tool.applyStamps(user, entry.pts);
        } else if (entry.type === 'up') {
          user.mousedown = true;
          // The buffered entry captured the MU's authoritative seq precisely so
          // the replayed commit could keep it; handleMouseUp(user) defaults it to
          // 0, which sorts the stroke to the top of the stack and orders it by
          // this client's clock instead of the server's.
          this.handleMouseUp(user, entry.seq);
        }
      }
      
      // Restore the current brush (it might have changed since this load started)
      user.imageBrush = currentBrush;
      user.imageBrushColorMode = currentColorMode;
      this.board.requestUpdate?.();
    };

    if (brushData.type === 'gbr' || brushData.type === 'image' || brushData.type === 'svg') {
      this._loadBrushImage(brushData, () => {
        console.log(`[ImageBrush] Remote user ${user.id} loaded ${brushData.type} brush:`, brushData.brushName || brushData.fileName);
        replayPending();
      }, () => {
        delete brushData._pendingStrokes;
        console.error(`[ImageBrush] Failed to load brush image for remote user ${user.id}`);
      });
    } else if (brushData.type === 'gih' && brushData.gBrushes && brushData.gBrushes.length > 0) {
      let loadedCount = 0;
      const totalImages = brushData.gBrushes.length;

      const images = brushData.gBrushes.map((brush, idx) => {
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

            if (brushData.dimensions && brushData.dimensions.length > 0) {
              for (const dim of brushData.dimensions) {
                dim.currentIndex = 0;
              }

              brushData.getNextBrush = function(context) {
                const idx = getNextBrushIndex(this, context);
                return {
                  brush: this.gBrushes[idx],
                  index: idx
                };
              };

              brushData.reset = function() {
                for (const dim of this.dimensions) {
                  dim.currentIndex = 0;
                }
              };
            }

            console.log(`[ImageBrush] Remote user ${user.id} loaded GIH brush with ${totalImages} cells:`, brushData.brushName);
            replayPending();
          }
        };
        img.onerror = () => {
          delete brushData._pendingStrokes;
          console.error(`[ImageBrush] Failed to load GIH image ${idx} for remote user ${user.id}`);
        };
        img.src = brush.gimpUrl;
        return img;
      });
    } else {
      // Unknown type or no async loading needed
      user._pendingBrushStrokes = null;
    }
  }

  handlePatternBrushLoad(user, patternDataStr) {
    let patternData;
    try {
      patternData = typeof patternDataStr === 'string' ? JSON.parse(patternDataStr) : patternDataStr;
    } catch (err) {
      console.error(`[PatternBrush] Failed to parse pattern payload for remote user ${user?.id}:`, err);
      return;
    }
    if (!patternData || typeof patternData !== 'object') return;
    const brushData = patternData.brush;
    if (!brushData) return;

    // Apply settings immediately so they're ready when stamps arrive
    const settings = {
      patternScale: patternData.scale ?? 100,
      patternRotation: patternData.rotation ?? 0,
      patternSpacing: patternData.spacing ?? 0,
      patternOffsetX: patternData.offsetX ?? 0,
      patternOffsetY: patternData.offsetY ?? 0,
      patternColorMode: patternData.colorMode ?? 'original',
    };
    Object.assign(user, settings);

    // Clear tile cache so it rebuilds with new brush/settings
    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) patternTool._tileCache.clear();
    // FloodFillTool keeps its OWN tile cache, and getPatternTile keys on
    // brushName/colour/spacing/mode rather than on the image — so a fresh
    // payload reusing a brush name would otherwise keep serving pattern-mode
    // fills the previous brush's tile.
    this.toolManager.getTool('fill')?._patternTileCache?.clear();

    // Strokes that arrive while the image is still decoding are buffered here and
    // replayed once it is ready — the same race the image brush already handles
    // via _pendingStrokes. Without it the whole gesture ran against a null tile
    // (_getPatternTile needs the decoded image), painted nothing, and committed an
    // empty dirtyRect that is silently discarded: the drawer had a pattern stroke
    // that simply did not exist on any observer.
    //
    // The buffer lives on the USER, not on brushData, so `user.patternBrush` stays
    // unset until the image is genuinely usable — anything else that asks whether
    // this user has a pattern (notably pattern-mode FILL) keeps reading the same
    // readiness signal it reads today.
    //
    // It is nonetheless owned by THIS load: a join tail replays a user's whole
    // pattern history back to back (StrokeTape's image tool state), so a second
    // payload routinely lands while the first is still decoding. Reading
    // `user._patternPendingStrokes` back at completion time would have let the
    // first load drain the SECOND payload's strokes — with the wrong tile — and
    // then delete a buffer the second load was still filling.
    const pending = [];
    user._patternPendingStrokes = pending;
    // Which load is the newest. Decodes finish out of order, so an older one
    // completing later must not publish its tile as the user's current pattern.
    const loadToken = (user._patternLoadToken || 0) + 1;
    user._patternLoadToken = loadToken;

    /**
     * Replays everything that arrived while the tile was decoding, with this
     * payload's brush and settings swapped in.
     *
     * Async because a buffered entry may be a pattern-mode FILL, which awaits
     * its flood-fill worker and only reads the tile afterwards. Rolling the
     * state back before it got there would hand it exactly the null/newer brush
     * the buffer exists to prevent.
     *
     * @param {boolean} usable - Whether the tile actually decoded.
     */
    const replayPending = async (usable) => {
      // Only retire the readiness flag if a newer load has not already claimed it.
      if (user._patternPendingStrokes === pending) delete user._patternPendingStrokes;
      const isLatest = user._patternLoadToken === loadToken;
      const tool = this.toolManager.getTool('pattern');

      // These stamps were drawn with this payload's tile and settings, which a
      // later payload may already have replaced. Swap them in for the replay and
      // put the newer ones back afterwards.
      const restore = {
        patternScale: user.patternScale,
        patternRotation: user.patternRotation,
        patternSpacing: user.patternSpacing,
        patternOffsetX: user.patternOffsetX,
        patternOffsetY: user.patternOffsetY,
        patternColorMode: user.patternColorMode,
      };
      const currentBrush = user.patternBrush;
      if (usable) {
        Object.assign(user, settings);
        user.patternBrush = brushData;
        tool?._tileCache?.clear();
      }

      // Drain into a local list first. The readiness flag is already retired
      // above, so anything arriving mid-drain runs immediately rather than
      // joining this buffer — iterating the live array would replay it twice.
      const entries = pending.splice(0, pending.length);
      for (const entry of entries) {
        if (entry.type === 'run') {
          // A pattern-mode FILL: it owns its whole commit, needs no pattern
          // tool, and must finish before the rollback below.
          try {
            await entry.run();
          } catch (err) {
            console.error(`[PatternBrush] Deferred fill failed for remote user ${user.id}:`, err);
          }
          continue;
        }
        if (!tool) continue;
        if (entry.type === 'down') {
          user.mousedown = true;
          tool.remoteBeginStroke(user, entry.pos);
        } else if (entry.type === 'stamps') {
          tool.remoteStampMask(user, entry.pts);
        } else if (entry.type === 'up') {
          user.mousedown = true;
          this.handleMouseUp(user, entry.seq);
        }
      }

      // A newer payload has already taken over the user's live pattern state, or
      // this one never decoded: either way it only ever existed for the replay.
      if (!usable || !isLatest) {
        Object.assign(user, restore);
        user.patternBrush = currentBrush;
        tool?._tileCache?.clear();
      }
    };

    // On failure the gesture is replayed too. It still paints nothing (there is no
    // tile), but it runs the commit path and closes the stroke out, instead of
    // leaving an active stroke open forever because its MU was swallowed.
    if (brushData.type === 'gbr' || brushData.type === 'image' || brushData.type === 'svg') {
      this._loadBrushImage(brushData, () => {
        replayPending(true);
      }, () => {
        console.error(`[PatternBrush] Failed to load brush image for remote user ${user.id}`);
        replayPending(false);
      });
    } else if (brushData.type === 'gih' && brushData.gBrushes && brushData.gBrushes.length > 0) {
      let loadedCount = 0;
      const totalImages = brushData.gBrushes.length;
      const images = brushData.gBrushes.map((brush, idx) => {
        const img = new Image();
        img.onload = () => {
          loadedCount++;
          if (loadedCount === totalImages) {
            brushData.images = images;
            replayPending(true);
          }
        };
        img.onerror = () => {
          console.error(`[PatternBrush] Failed to load GIH image ${idx} for remote user ${user.id}`);
          replayPending(false);
        };
        img.src = brush.gimpUrl;
        return img;
      });
    }
  }

  /**
   * Applies a remote confetti payload, holding that user's stamps back until the
   * particle sprite has actually decoded.
   *
   * ConfettiTool.drawParticleToContext reads the sprite straight off an <img>
   * and silently falls back to a plain circle whenever it has not decoded yet.
   * Live, that race is invisible — the payload lands seconds before the stroke.
   * A join tail is the opposite: it replays a user's whole confetti history in
   * one burst microseconds after the payload, so the decode lost every time and
   * the strokes baked as circles. A later manual resync then looked "fixed"
   * purely because the sprite was in _imageCache by then, decoded. This is the
   * same race handleBrushLoad and handlePatternBrushLoad already buffer for.
   *
   * @param {User} user - The remote user the payload belongs to.
   * @param {string|Object} confettiData - Wire payload, JSON string or object.
   * @returns {void}
   */
  handleConfettiBrushLoad(user, confettiData) {
    const tool = this.toolManager.getTool('confetti');
    if (!user || !tool) return;
    const applied = tool.applyNetworkSettings?.(user, confettiData);
    if (!applied) return;

    // Per-move payloads omit the brush entirely (getNetworkSettings'
    // `includeBrush`): they are mid-stroke tweaks, and re-arming on one would
    // strand the stroke that is already draining into the current buffer.
    if (applied.confettiBrush === undefined) return;

    // Never defer our OWN frames. A sync rebuild drives them through this
    // pipeline too, but our sprite is already decoded locally (it is the gallery
    // object we have been drawing with), and a deferral that outlived the
    // rebuild would hand our MU to handleMouseUp's self-echo gate — which
    // reconciles instead of committing, leaving the stroke open forever.
    if (user.id === this.app.sessionIndex) return;

    const pending = tool.preloadParticleImage(user.confettiBrush);
    // Nothing to wait for: a shape-only brush, or a sprite already decoded.
    if (!pending) return;

    // Settings as this payload left them. A join tail replays a user's brush
    // switches back to back, so a newer payload routinely lands while this one
    // is still decoding — the replay has to draw with the state that was in
    // force when these stamps were made, then hand the newer state back.
    const settings = {};
    for (const key of CONFETTI_STATE_KEYS) settings[key] = user[key];

    // Owned by THIS load: decodes finish out of order, and a join tail lands a
    // second payload while the first is still decoding often enough that reading
    // `user._confettiPendingStrokes` back at drain time would let the first load
    // replay the SECOND payload's stamps with the wrong sprite.
    const buffer = [];
    user._confettiPendingStrokes = buffer;

    pending.then((usable) => {
      // Retire the readiness flag first, and only if a newer load has not
      // already claimed it — anything arriving mid-drain must run live rather
      // than join a buffer nobody will drain again.
      if (user._confettiPendingStrokes === buffer) delete user._confettiPendingStrokes;

      // What is live right now — a newer payload, a mid-stroke tweak from an MM,
      // or (for our own frames on a rebuild) the rich gallery object SyncClient
      // just put back. Whatever it is, it outranks this payload once the replay
      // below is done with it.
      const restore = {};
      for (const key of CONFETTI_STATE_KEYS) restore[key] = user[key];
      if (usable) Object.assign(user, settings);

      const entries = buffer.splice(0, buffer.length);
      for (const entry of entries) {
        if (entry.type === 'down') {
          user.mousedown = true;
          // onPointerDown consumes (and deletes) the stroke seed, so it has to
          // be the one this MD carried, not whatever a later MD left behind.
          if (entry.seed !== undefined) user._confettiStrokeSeed = entry.seed;
          tool.onPointerDown(user, entry.pos);
        } else if (entry.type === 'move') {
          user.mousedown = true;
          tool.onPointerMove(user, entry.pos);
        } else if (entry.type === 'stamps') {
          user.mousedown = true;
          tool.applyStamps(user, entry.pts, entry.seeds);
        } else if (entry.type === 'up') {
          // The buffered MU kept its authoritative seq precisely so the commit
          // lands in the server's order rather than at seq 0.
          user.mousedown = true;
          this.handleMouseUp(user, entry.seq);
        }
      }

      // This payload's state only ever existed for the replay above.
      Object.assign(user, restore);
      this.board.requestUpdate?.();
    });
  }

  _loadBrushImage(brushData, onLoad, onError) {
    const image = new Image();
    image.onload = () => {
      brushData.image = image;
      if (!brushData.width) brushData.width = image.naturalWidth || image.width;
      if (!brushData.height) brushData.height = image.naturalHeight || image.height;
      onLoad();
    };
    image.onerror = onError;

    if (brushData.type === 'svg' && brushData.svgContent) {
      const svgBlob = new Blob([brushData.svgContent], { type: 'image/svg+xml' });
      image.src = URL.createObjectURL(svgBlob);
      return;
    }

    image.src = brushData.gimpUrl;
  }

  /**
   * Invalidate any in-flight async fill preview render and optionally clear
   * the user's preview canvas immediately.
   * @param {User} user
   * @param {boolean} [clearCanvas=true]
   * @returns {void}
   */
  _invalidateFillPreview(user, clearCanvas = true) {
    if (!user) return;
    user._fillPreviewToken = (user._fillPreviewToken || 0) + 1;
    if (clearCanvas && user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      this._setUserLayerContent(user, false);
    }
  }

  /**
   * Deep-clean all transient renderer state associated with a remote user.
   * Optionally bakes their visible drawing into the permanent layer state first.
   * @param {User} user
   * @param {{preserveVisuals?: boolean}} [options={}]
   */
  cleanupUserState(user, options = {}) {
    if (!user) return;
    const preserveVisuals = options.preserveVisuals === true;

    if (preserveVisuals) {
      this.board.layerManager?.deepCleanupUserState?.(user.id, { preserveVisuals: true });
    } else {
      this.board.layerManager?.deepCleanupUserState?.(user.id, { preserveVisuals: false });
    }

    this._cleanupTransientUserState(user);
    this.board.requestUpdate();
  }

  _disposeCanvasElement(canvas) {
    if (!canvas) return;
    if (typeof canvas.close === 'function') {
      try { canvas.close(); } catch (_) {}
    }
    if (canvas instanceof HTMLCanvasElement) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /**
   * Clear room-level remote caches that are not tied to a single remaining user.
   */
  resetTransientState() {
    this.selectionHandler?.stopRemoteSelectionAnimation?.();
    if (this.selectionHandler?._patternTileCache) {
      for (const tile of this.selectionHandler._patternTileCache.values()) {
        this._disposeCanvasElement(tile);
      }
      this.selectionHandler._patternTileCache.clear();
    }

    const blurTool = this.toolManager.getTool('blur');
    if (blurTool) {
      blurTool.lastStampPos?.clear?.();
      blurTool.strokePoints?.clear?.();
      blurTool._activeUser = null;
    }

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) {
      circleBlurTool.lastStampPos?.clear?.();
      circleBlurTool.strokePoints?.clear?.();
      circleBlurTool._activeUser = null;
    }

    const glitchBlurTool = this.toolManager.getTool('glitchBlur');
    if (glitchBlurTool) {
      glitchBlurTool.lastStampPos?.clear?.();
      glitchBlurTool.strokePoints?.clear?.();
      glitchBlurTool.strokeLayersByUser?.clear?.();
      glitchBlurTool._activeUser = null;
    }

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) {
      imageBrushTool.lastStampPos?.clear?.();
      imageBrushTool._activeUser = null;
      imageBrushTool.stampBuffer = [];
    }

    const confettiTool = this.toolManager.getTool('confetti');
    if (confettiTool) {
      confettiTool.lastStampPos?.clear?.();
      confettiTool._activeUser = null;
      confettiTool.stampBuffer = [];
    }

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) {
      patternTool.lastStampPos?.clear?.();
      for (const tile of patternTool._tileCache?.values?.() || []) {
        this._disposeCanvasElement(tile);
      }
      for (const offscreen of patternTool.remoteOffscreens?.values?.() || []) {
        this._disposeCanvasElement(offscreen?.canvas);
        offscreen.ctx = null;
      }
      patternTool.remoteOffscreens?.clear?.();
      patternTool._tileCache?.clear?.();
      patternTool._activeUser = null;
      patternTool.strokePoints = [];
      patternTool.stampBuffer = [];
      this._disposeCanvasElement(patternTool.offscreenCanvas);
      patternTool.offscreenCanvas = null;
      patternTool.offscreenCtx = null;
      patternTool.dirtyBounds = null;
      // Board-sized pattern composite surfaces, live and pooled. Same reason
      // the mask offscreens above are disposed: they are full-board backing
      // stores and nothing else will free them.
      for (const surface of patternTool._compositeSurfaces?.values?.() || []) {
        this._disposeCanvasElement(surface?.canvas);
      }
      patternTool._compositeSurfaces?.clear?.();
      for (const surface of patternTool._compositePool || []) {
        this._disposeCanvasElement(surface?.canvas);
      }
      if (patternTool._compositePool) patternTool._compositePool.length = 0;
    }

    const pixelTool = this.toolManager.getTool('pixel');
    if (pixelTool) {
      pixelTool.lastStampPos?.clear?.();
      for (const canvas of pixelTool.tempCanvases?.values?.() || []) {
        this._disposeCanvasElement(canvas);
      }
      pixelTool.tempCanvases?.clear?.();
      pixelTool._activeUser = null;
      pixelTool.stampBuffer = [];
    }

    const eraserTool = this.toolManager.getTool('erase');
    eraserTool?.lastPos?.clear?.();

    const fillTool = this.toolManager.getTool('fill');
    fillTool?._cancelInteractive?.();
  }

  getDebugStats() {
    let remoteSelections = 0;
    for (const [id, user] of this.users.entries()) {
      if (id === this.sessionIndex) continue;
      if (user?.floatingCanvas || user?.pendingSelection) {
        remoteSelections++;
      }
    }

    return {
      remoteSelections,
      remoteSelectionAnimationActive: !!this.selectionHandler?.remoteSelectionAnimationId,
      remotePatternPreviewCaches: this.selectionHandler?._patternTileCache?.size ?? 0,
      remotePatternOffscreens: this.toolManager.getTool('pattern')?.remoteOffscreens?.size ?? 0,
      remotePixelTempCanvases: this.toolManager.getTool('pixel')?.tempCanvases?.size ?? 0,
      remoteBlurTracks: this.toolManager.getTool('blur')?.strokePoints?.size ?? 0,
      remoteGlitchTracks: this.toolManager.getTool('glitchBlur')?.strokePoints?.size ?? 0,
      previewCallCount: this._debugPreviewCallCount || 0,
      previewFireCount: this._debugPreviewFireCount || 0
    };
  }

  _cleanupTransientUserState(user) {
    this._clearLayeredRemotePreview(user);
    this._invalidateFillPreview(user);
    this.selectionHandler?._cleanupUserSelection?.(user);

    user.clearLine();
    user.mousedown = false;
    user._strokeLayer = null;
    user.startPos = null;
    user.pendingSelection = null;
    user.pendingLassoPath = null;
    user.remoteTarget = null;
    user.selection = null;
    user.selectionCorners = null;
    user.originalCorners = null;
    user.originalSelectionPos = null;
    user.lassoPath = null;
    user.floatingCanvas = null;
    user.floatingCtx = null;
    user.homography = null;
    user.previewHomography = null;
    this._disposeCanvasElement(user._cachedPreviewCanvas);
    user._selectionRestoreData = null;
    user._cachedPreviewCanvas = null;
    user._cachedPreviewBounds = null;
    user.penPoints = [];
    user._penLastStampPos = null;
    user._penStrokeActive = false;
    user._penStrokeColor = null;
    user._penAlpha = null;
    user._penDirtyBounds = null;
    user._penPreviewDirtyBounds = null;
    if (user._penOffscreenCtx && user._penOffscreen) {
      user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);
    }
    this._disposeCanvasElement(user._penOffscreen);
    user._penOffscreen = null;
    user._penOffscreenCtx = null;
    user._penOrigin = null;

    user._previewDirtyBounds = null;

    user._inkPoints = [];
    user._inkStrokeActive = false;
    user._inkStrokeColor = null;
    user._inkAlpha = null;
    user._inkDirtyBounds = null;
    if (user._inkCtx && user._inkOffscreen) {
      user._inkCtx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);
    }
    this._disposeCanvasElement(user._inkOffscreen);
    user._inkOffscreen = null;
    user._inkCtx = null;
    this._disposeCanvasElement(user._inkHardnessCanvas);
    user._inkHardnessCanvas = null;
    user._inkHardnessCtx = null;
    user._inkOrigin = null;

    delete user.blurBounds;
    delete user.glitchStamps;
    user.lastBlurPos = null;

    // The preview canvas would collapse on its own after the idle delay, but
    // this path is departure and AFK — there is nothing to wait for, and on
    // departure the timer would otherwise keep the user object alive past the
    // point anything else references it.
    this.inkHandler?.cancelPendingPreview?.(user);
    this.penHandler?.cancelPendingPreview?.(user);
    releaseUserLayer(user);
    // Cancels the idle timer as well as freeing the canvases — a pending timer
    // would otherwise keep this user object reachable for a further minute.
    releaseRemoteScratch(user);

    const blurTool = this.toolManager.getTool('blur');
    if (blurTool) {
      blurTool.lastStampPos.delete(user.id);
      blurTool.strokePoints.delete(user.id);
    }

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) {
      circleBlurTool.lastStampPos.delete(user.id);
      circleBlurTool.strokePoints?.delete?.(user.id);
    }

    const glitchBlurTool = this.toolManager.getTool('glitchBlur');
    if (glitchBlurTool) {
      glitchBlurTool.lastStampPos.delete(user.id);
      glitchBlurTool.strokePoints.delete(user.id);
      glitchBlurTool.strokeLayersByUser?.delete?.(user.id);
    }

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) imageBrushTool.lastStampPos.delete(user.id);
    delete user._imageBrushLastPos;
    delete user._imageBrushLastTime;
    delete user._imageBrushDirtyBounds;
    delete user._imageBrushStrokePoints;

    const confettiTool = this.toolManager.getTool('confetti');
    if (confettiTool) confettiTool.lastStampPos.delete(user.id);
    delete user._confettiDirtyBounds;
    delete user._confettiStrokePoints;

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) {
      patternTool.lastStampPos.delete(user.id);
      const offscreen = patternTool.remoteOffscreens.get(user.id);
      if (offscreen) {
        this._disposeCanvasElement(offscreen.canvas);
        offscreen.ctx = null;
      }
      patternTool.remoteOffscreens.delete(user.id);
      patternTool._releaseCompositeSurface?.(user.id);
    }

    const pixelTool = this.toolManager.getTool('pixel');
    if (pixelTool) {
      pixelTool.lastStampPos.delete(user.id);
      const tempCanvas = pixelTool.tempCanvases.get(user.id);
      this._disposeCanvasElement(tempCanvas);
      pixelTool.tempCanvases.delete(user.id);
    }
    delete user._pixelStrokePoints;
    delete user._pixelPreviewDirtyBounds;

    const eraserTool = this.toolManager.getTool('erase');
    eraserTool?.lastPos?.delete?.(user.id);

    if (user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      this._setUserLayerContent(user, false);
    }
  }

  /**
   * Cancels a remote user's active stroke and cleans up state.
   *
   * @param {User} user - The remote user whose stroke is being cancelled.
   * @returns {void}
   */
  handleCancel(user) {
    this.board.layerManager.cancelUserStroke(this.getStrokeLayer(user), user.id);
    this._cleanupTransientUserState(user);
    this.board.requestUpdate();
  }

  /**
   * Internal helper to expand the dirty rect for a remote user.
   *
   * @private
   * @param {User} user - The remote user.
   * @param {Array<Object>} points - Array of {x, y} points.
   * @param {number} margin - Expansion margin around the points.
   * @returns {void}
   */
  /**
   * Draws a checkerboard fill preview on a remote user's preview canvas.
   * Shows where the user is performing an advanced fill operation.
   *
   * @private
   * @param {User} user - The remote user.
   * @param {{x: number, y: number}} pos - The fill seed position.
   */
  async _drawFillPreview(user, pos) {
    const fillTool = this.toolManager.getTool('fill');
    if (!fillTool) return;
    const previewToken = user._fillPreviewToken || 0;

    const width = this.board.getWidth();
    const height = this.board.getHeight();
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    const imageData = this.board.getFullBoardImageData(0, 0, width, height);
    if (!imageData) return;
    const result = await fillTool._fillWorker.computeFill(
      imageData.data, width, height, x, y, 10, 0, null
    );
    if (!result || previewToken !== (user._fillPreviewToken || 0) || !user.mousedown || user.tool !== 'fill') return;

    const fillLimit = fillTool._isFillTooLarge?.(result, width, height);
    if (fillLimit) {
      fillTool._warnFillTooLarge?.(fillLimit, false);
      this._invalidateFillPreview(user);
      return;
    }

    const { mask, minX, minY, maxX, maxY } = result;
    const regionW = maxX - minX + 1;
    const regionH = maxY - minY + 1;
    const imgData = new ImageData(regionW, regionH);
    const pixels = imgData.data;

    // Use the remote user's fill color with a checkerboard pattern
    const fillColor = user.color ?? [0, 0, 0, 1];
    const r = Math.round(fillColor[0]);
    const g = Math.round(fillColor[1]);
    const b = Math.round(fillColor[2]);
    const tileSize = 6;

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (mask[py * width + px]) {
          const oi = ((py - minY) * regionW + (px - minX)) * 4;
          const isLight = ((Math.floor(px / tileSize) + Math.floor(py / tileSize)) % 2 === 0);
          if (isLight) {
            pixels[oi] = r;
            pixels[oi + 1] = g;
            pixels[oi + 2] = b;
            pixels[oi + 3] = 140;
          } else {
            pixels[oi] = Math.round(r * 0.5);
            pixels[oi + 1] = Math.round(g * 0.5);
            pixels[oi + 2] = Math.round(b * 0.5);
            pixels[oi + 3] = 140;
          }
        }
      }
    }

    this._setUserLayerContent(user, true);
    user.context.clearRect(0, 0, width, height);
    this.board.withSelectionMaskClip(user.context, user.id, () => {
      if (!this._fillPreviewCanvas ||
          this._fillPreviewCanvas.width !== regionW ||
          this._fillPreviewCanvas.height !== regionH) {
        this._fillPreviewCanvas = document.createElement('canvas');
        this._fillPreviewCanvas.width = regionW;
        this._fillPreviewCanvas.height = regionH;
        this._fillPreviewCtx = this._fillPreviewCanvas.getContext('2d');
      }
      this._fillPreviewCtx.clearRect(0, 0, regionW, regionH);
      this._fillPreviewCtx.putImageData(imgData, 0, 0);
      user.context.drawImage(this._fillPreviewCanvas, minX, minY);
    });
  }

  _expandDirtyRectFromPoints(user, points, margin) {
    if (!points || points.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }

    const x = Math.floor(minX - margin);
    const y = Math.floor(minY - margin);
    const w = Math.ceil(maxX - minX + margin * 2);
    const h = Math.ceil(maxY - minY + margin * 2);

    this.board.expandDirtyRect(user, x, y, w, h);

    this.board.forEachMirrorRegion({ rect: { x, y, width: w, height: h } }, (region) => {
      const p1 = this.board.mirrorPointToRegion({ x: minX, y: minY }, region);
      const p2 = this.board.mirrorPointToRegion({ x: maxX, y: maxY }, region);
      const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
      const my = Math.floor(Math.min(p1.y, p2.y) - margin);
      const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
      const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
      this.board.expandDirtyRect(user, mx, my, mw, mh);
    });
  }

  _expandDirtyRectFromRect(user, rect, margin) {
    if (!rect) return;

    const minX = rect.x;
    const minY = rect.y;
    const maxX = rect.x + rect.w;
    const maxY = rect.y + rect.h;

    const x = Math.floor(minX - margin);
    const y = Math.floor(minY - margin);
    const w = Math.ceil(maxX - minX + margin * 2);
    const h = Math.ceil(maxY - minY + margin * 2);

    this.board.expandDirtyRect(user, x, y, w, h);

    this.board.forEachMirrorRegion({ rect: { x, y, width: w, height: h } }, (region) => {
      const p1 = this.board.mirrorPointToRegion({ x: minX, y: minY }, region);
      const p2 = this.board.mirrorPointToRegion({ x: maxX, y: maxY }, region);
      const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
      const my = Math.floor(Math.min(p1.y, p2.y) - margin);
      const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
      const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
      this.board.expandDirtyRect(user, mx, my, mw, mh);
    });
  }

  /**
   * Computes the brush margin for dirty rectangle expansion.
   *
   * @private
   * @param {User} user - The remote user.
   * @returns {number}
   */
  /**
   * Pressure-independent upper bound on _brushMargin. Preview bounds are
   * accumulated from cursor points before the per-point radii are applied, and
   * pressure only ever shrinks the radius, so assuming full pressure keeps the
   * rect conservative — the safe direction, since a too-small rect leaves a
   * remote stroke visibly torn while a too-large one only costs time.
   *
   * @private
   * @param {User} user - The remote user.
   * @returns {number}
   */
  _maxBrushMargin(user) {
    const radius = user.size || 0;
    const hardnessFloat = (user.hardness !== undefined ? user.hardness : 100) / 100;
    const blurAmount = hardnessFloat < 1 ? (1 - hardnessFloat) * (20 + (user.size || 0) * 0.2) : 0;
    return radius + blurExtent(blurAmount) + radius * 0.25 + 2;
  }

  /**
   * Accumulate the region a remote user's in-progress preview occupies.
   *
   * Cumulative for the whole stroke, not per batch: every preview path clears
   * the user's whole preview canvas and redraws from scratch (see
   * renderRemotePreview), so the region that changes on each render is
   * everything the stroke has covered so far — and for line/rectangle/circle
   * the previous frame's shape has to be repainted as well as the new one.
   *
   * @private
   * @param {User} user - The remote user.
   * @param {number[]|Array<{x:number,y:number}>} points - Flat [x,y,...] or point objects.
   * @param {number} margin - Half-extent of the paint around each point.
   * @returns {void}
   */
  _expandPreviewBounds(user, points, margin) {
    if (!user || !points || !points.length) return;
    let b = user._previewDirtyBounds;
    if (!b) {
      b = user._previewDirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    }
    const add = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x - margin < b.minX) b.minX = x - margin;
      if (y - margin < b.minY) b.minY = y - margin;
      if (x + margin > b.maxX) b.maxX = x + margin;
      if (y + margin > b.maxY) b.maxY = y + margin;
    };
    if (typeof points[0] === 'number') {
      for (let i = 0; i + 1 < points.length; i += 2) add(points[i], points[i + 1]);
    } else {
      for (const p of points) add(p?.x, p?.y);
    }
  }

  /**
   * Fold a shape tool's live preview geometry into the user's preview bounds.
   * No-op for every other tool.
   *
   * @private
   * @param {User} user - The remote user.
   * @param {{x:number,y:number}} pos - Current remote cursor position.
   * @returns {void}
   */
  _expandShapePreviewBounds(user, pos) {
    if (!user?.startPos || !pos) return;
    const margin = this._maxBrushMargin(user);
    if (user.tool === 'line') {
      this._expandPreviewBounds(user, [user.startPos, pos], margin);
      return;
    }
    if (user.tool === 'rectangle') {
      const b = this.toolManager.getTool('rectangle')
        ?.getRectBounds?.(user.startPos, pos, false, user.shapeDrawMode);
      if (b) {
        this._expandPreviewBounds(user, [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }], margin);
      }
      return;
    }
    if (user.tool === 'circle') {
      const e = this.toolManager.getTool('circle')
        ?.getEllipseParams?.(user.startPos, pos, false, user.shapeDrawMode);
      if (e) {
        this._expandPreviewBounds(
          user,
          [{ x: e.cx - e.rx, y: e.cy - e.ry }, { x: e.cx + e.rx, y: e.cy + e.ry }],
          margin
        );
      }
    }
  }

  _brushMargin(user) {
    const radius = user.pressure * user.size;
    const hardnessFloat = (user.hardness !== undefined ? user.hardness : 100) / 100;
    const blurAmount = hardnessFloat < 1 ? (1 - hardnessFloat) * (20 + user.size * 0.2) : 0;
    return radius + blurExtent(blurAmount) + radius * 0.25 + 2;
  }

  /**
   * Whether this user's in-progress stroke may use a windowed (non-full-board)
   * LayerManager active-stroke canvas — see
   * docs/scope_layermanager_active_stroke_windowing_RESULT.md. Brush plus the
   * one-shot shape tools (line/rectangle/circle, added later — see
   * [[shape_tool_active_stroke_windowing]]): ink/pen already have their own
   * windowed offscreen canvases and don't go through this path. Both of the
   * original exclusions are now handled rather than avoided:
   *   - mirror regions: `_activeStrokeWindowBounds` folds each active
   *     region's transformed bounds into the window request.
   *   - selection mask: `Board.applySelectionMaskClipForStroke` bakes the
   *     clip into the active canvas's own pixel space and registers a
   *     `_reapplyMaskClip` hook that `LayerManager._growActiveStrokeWindow`
   *     calls after any canvas swap, so the clip survives the window
   *     growing mid-drag.
   *
   * Shapes reuse this SAFELY with zero shape-specific bounds logic: MD/MM
   * already unconditionally call `_expandShapePreviewBounds` (via
   * `_expandPreviewBounds`) using `_maxBrushMargin` (worst-case, no pressure
   * factor) for every tool including shapes, feeding the same
   * `user._previewDirtyBounds` this reads. Commit's own margin (`_brushMargin`,
   * WITH pressure) is always <= `_maxBrushMargin`'s, so the window this
   * produces is always at least as large as what commit actually draws —
   * no clipping risk from reusing brush's bounds machinery unchanged.
   * @private
   * @param {User} user
   * @returns {boolean}
   */
  _canWindowActiveStroke(user) {
    return user.tool === 'brush' || user.tool === 'line' || user.tool === 'rectangle' || user.tool === 'circle';
  }

  /**
   * Board-absolute bounds hint for `beginUserStroke`/`getUserStrokeContext`'s
   * `bounds` param, derived from the same cumulative-since-last-reset dirty
   * region `_expandPreviewBounds` already tracks in `user._previewDirtyBounds`
   * (reset to null after every commit, so this naturally covers "what's new
   * since the active canvas last saw bounds" rather than the whole stroke —
   * exactly what `_growActiveStrokeWindow`'s grow-only, blit-forward window
   * needs: each call only has to cover the newest content, and the window's
   * own history keeps whatever it already covered).
   * @private
   * @param {User} user
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  _activeStrokeWindowBounds(user) {
    const b = user._previewDirtyBounds;
    if (!b || !Number.isFinite(b.minX) || !Number.isFinite(b.maxX) || b.maxX < b.minX || b.maxY < b.minY) {
      return null;
    }
    let minX = b.minX, minY = b.minY, maxX = b.maxX, maxY = b.maxY;

    // A mirrored stroke also paints into each active mirror region's
    // transformed copy (see commitLine/handleMouseUp's forEachMirrorRegion
    // blocks) — fold each region's transformed corners into the window
    // request so the mirrored copy isn't drawn outside the (windowed)
    // canvas. This is a single bounding box around every copy, not a rect
    // list (see mirror_preview_rect_list memory for why that's a separate,
    // harder problem for PREVIEWS) — for a stroke near one edge mirrored
    // across a far axis this can grow the window close to full-board, which
    // is a correct, if unexciting, degradation rather than a bug.
    const regions = this.board.getActiveMirrorRegions?.() || [];
    if (regions.length) {
      const corners = [
        { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
        { x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY }
      ];
      for (const region of regions) {
        const mirrored = this.board.mirrorPointsToRegion(corners, region);
        for (const p of mirrored) {
          if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Commits the current line segment to the history and prepares for the next.
   * Used when remote brush parameters change mid-stroke.
   *
   * @param {User} user - The remote user.
   * @param {number} [newPressure] - New pressure value.
   * @param {number} [newSize] - New brush size.
   * @returns {void}
   */
  commitLine(user, newPressure, newSize) {
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    this._setUserLayerContent(user, false);
    this._clearLayeredRemotePreview(user);

    const lastDrawnPos = user.currentLine.length > 0
      ? user.currentLine[user.currentLine.length - 1]
      : { x: user.x, y: user.y };

    const oldRadius = user.pressure * user.size;
    const newRadius = (newPressure ?? user.pressure) * (newSize ?? user.size);

    const commitLineBounds = this._canWindowActiveStroke(user) ? this._activeStrokeWindowBounds(user) : null;
    const activeStrokeCtx = this.board.layerManager.getUserStrokeContext(
      this.getStrokeLayer(user), user.id, undefined, undefined, commitLineBounds
    );
    if (activeStrokeCtx) {
      // drawLineArray/bridgeGap paint at board-absolute point coordinates.
      // That's identity for a full-board canvas (canvas-local (0,0) IS board
      // (0,0)), but a windowed active canvas (active.origin set — see
      // docs/scope_layermanager_active_stroke_windowing_RESULT.md) has its
      // local origin offset from the board, so every draw below needs the
      // canvas translated to compensate, or the path lands outside the
      // (small) canvas entirely and paints nothing.
      const active = this.board.layerManager.getActiveStroke(this.getStrokeLayer(user), user.id);
      const ox = active?.origin?.x ?? 0;
      const oy = active?.origin?.y ?? 0;
      if (ox || oy) activeStrokeCtx.save();
      try {
        if (ox || oy) activeStrokeCtx.translate(-ox, -oy);

        if (user.tool === 'brush' && user.currentLine.length >= 2) {
          drawLineArray(user.currentLine, activeStrokeCtx, user);
          this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
            const mirroredLine = this.board.mirrorPointsToRegion(user.currentLine, region);
            this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
              drawLineArray(mirroredLine, activeStrokeCtx, user);
            });
          });
          this._expandDirtyRectFromPoints(user, user.currentLine, this._brushMargin(user));
        }

        if (user.currentLine.length > 0 && oldRadius !== newRadius) {
          const from = lastDrawnPos;
          bridgeGap(activeStrokeCtx, from, lastDrawnPos, oldRadius, newRadius, user);
          this.board.forEachMirrorRegion({ points: [from, lastDrawnPos] }, (region) => {
            this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
              bridgeGap(
                activeStrokeCtx,
                this.board.mirrorPointToRegion(from, region),
                this.board.mirrorPointToRegion(lastDrawnPos, region),
                oldRadius,
                newRadius,
                user
              );
            });
          });
        }
      } finally {
        if (ox || oy) activeStrokeCtx.restore();
      }
    }

    user.clearLine();
    user._previewDirtyBounds = null;
    user.addToLine(lastDrawnPos);
    this.board.compositeAllLayers();
  }
}
