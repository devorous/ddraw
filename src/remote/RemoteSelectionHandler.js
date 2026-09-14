import { getHomography } from '../utils/homographyAccess.js';
import { paintHardenedEraseMask, needsHardenedEraseMask } from '../utils/eraseMask.js';
import { setUserLayerContent } from './userLayerPresence.js';
import { getPatternTile, getPatternDrawScale } from '../utils/patternTile.js';
import { marchingAntsStep } from '../utils/marchingAnts.js';

/**
 * RemoteSelectionHandler - Handles selection tool rendering and operations for remote users
 * Manages floating selections, perspective transforms, and animated marching ants
 */
export class RemoteSelectionHandler {
  constructor(board, getUsersMap, getSessionIndex) {
    this.board = board;
    this.getUsersMap = getUsersMap;
    this.getSessionIndex = getSessionIndex;
    this.remoteSelectionAnimationId = null;
    this.remoteSelectionOffset = 0;

    // Preview downscaling settings (same as the original remote path)
    this.previewMaxSize = 256; // Max dimension for preview warps
    this.selectionMovePreviewRate = 30;
    this.selectionMovePreviewInterval = 1000 / this.selectionMovePreviewRate;

    // Pattern tile cache for pattern fills
    this._patternTileCache = new Map();
  }

  _clearUserOverlay(user) {
    if (!user?.context) return;
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    setUserLayerContent(user, false);
  }

  _isReplayMode() {
    return this.board?.isReplay === true;
  }

  _drawDashedRect(ctx, rect, offset) {
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = -offset;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -offset + 4;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  _drawDashedPath(ctx, points, offset, closePath = true) {
    if (!points || points.length < 2) return;

    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = -offset;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    if (closePath) ctx.closePath();
    ctx.stroke();

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -offset + 4;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    if (closePath) ctx.closePath();
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  drawStaticMaskOutline(user, mask, clear = true) {
    if (!user?.context || !mask) return;
    setUserLayerContent(user, true);
    const ctx = user.context;
    if (clear) {
      ctx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    if (mask.lassoPath && mask.lassoPath.length >= 2) {
      this._drawDashedPath(ctx, mask.lassoPath, 0, true);
    } else {
      this._drawDashedRect(ctx, mask, 0);
    }
    ctx.restore();
  }

  /**
   * Repeats an already-rendered remote preview draw into every active mirror.
   *
   * The observer's counterpart to SelectTool._paintMirroredPreview, and cheap
   * for the same reason: `paint` closes over a canvas or path that has already
   * been rasterized, so a mirrored copy is one extra draw per region rather than
   * a second warp. Mirrors are resolved from LIVE board state here, not from a
   * wire flag — a preview is ephemeral and is never rebuilt from the stroke log,
   * so there is no "what was the mirror when this was drawn" to recover.
   * @private
   */
  _paintMirroredPreview(ctx, rect, paint) {
    if (!rect || !this.board.hasMirrors?.()) return;
    for (const { region } of this.board.getSelectionMirrorTargets(rect)) {
      this.board.withMirroredRegionTransform(ctx, region, () => paint(ctx));
    }
  }

  _drawPendingSelectionLikeLocal(user) {
    if (!user?.pendingSelection) return;

    setUserLayerContent(user, true);
    const ctx = user.context;
    const s = user.pendingSelection;
    const isLivePreview = !!(user.mousedown && user.startPos && !user.floatingCanvas);

    if (user.pendingLassoPath && user.pendingLassoPath.length >= 2) {
      const drawLasso = (c) => {
        this._drawDashedPath(c, user.pendingLassoPath, this.remoteSelectionOffset, !isLivePreview);
        if (!isLivePreview && user.pendingLassoPath.length >= 3) {
          c.strokeStyle = 'rgba(128, 128, 128, 0.5)';
          c.lineWidth = 1;
          c.strokeRect(s.x, s.y, s.width, s.height);
        }
      };
      drawLasso(ctx);
      this._paintMirroredPreview(ctx, s, drawLasso);
      return;
    }

    this._drawDashedRect(ctx, s, this.remoteSelectionOffset);
    this._paintMirroredPreview(ctx, s, (c) => this._drawDashedRect(c, s, this.remoteSelectionOffset));
  }

  _drawFloatingOutlineLikeLocal(user) {
    if (!user?.selectionCorners || !user?.selection) return;

    setUserLayerContent(user, true);
    const ctx = user.context;
    const s = user.selection;
    const c = user.selectionCorners;

    if (c && user.originalCorners && this.hasTransformedCorners(user)) {
      const quad = [c.tl, c.tr, c.br, c.bl];
      const drawQuad = (t) => this._drawDashedPath(t, quad, this.remoteSelectionOffset, true);
      drawQuad(ctx);
      // Observers get the warped box in the mirrors too — without this the
      // drawer saw their transform reflected and everyone else saw it only at
      // the original position.
      this._paintMirroredPreview(ctx, this._boundsOfPoints(quad), drawQuad);
      return;
    }

    this._drawDashedRect(ctx, s, this.remoteSelectionOffset);
    this._paintMirroredPreview(ctx, s, (t) => this._drawDashedRect(t, s, this.remoteSelectionOffset));
  }

  /** Axis-aligned bounds of a point list, for mirror-target intersection tests. */
  _boundsOfPoints(points) {
    if (!points?.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  _disposeCanvas(canvas) {
    if (!canvas) return;
    if (typeof canvas.close === 'function') {
      try { canvas.close(); } catch (_) {}
    }
    if (canvas instanceof HTMLCanvasElement) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  _cloneSelectionRestoreData(restoreData) {
    if (!restoreData) return null;

    const snapshots = Array.isArray(restoreData.snapshots)
      ? restoreData.snapshots.map((snap) => {
          const sourceCanvas = snap?.canvas;
          let clonedCanvas = null;

          if (sourceCanvas) {
            clonedCanvas = document.createElement('canvas');
            clonedCanvas.width = sourceCanvas.width;
            clonedCanvas.height = sourceCanvas.height;
            const clonedCtx = clonedCanvas.getContext('2d');
            clonedCtx.drawImage(sourceCanvas, 0, 0);
          }

          return {
            groupIdx: snap?.groupIdx ?? 0,
            canvas: clonedCanvas,
            x: snap?.x ?? 0,
            y: snap?.y ?? 0
          };
        })
      : [];

    return {
      snapshots,
      eraseS: restoreData.eraseS ? { ...restoreData.eraseS } : null,
      eraseLassoPath: Array.isArray(restoreData.eraseLassoPath)
        ? restoreData.eraseLassoPath.map((pt) => ({ ...pt }))
        : null,
      eraseTimestamp: restoreData.eraseTimestamp,
      eraseUserId: restoreData.eraseUserId
    };
  }

  _removeSelectionEraseStroke(restoreData, fallbackUserId) {
    const lm = this.board.layerManager;
    const timestamp = restoreData?.eraseTimestamp;
    if (!lm || timestamp === undefined || timestamp === null) return false;

    const userId = restoreData.eraseUserId ?? fallbackUserId;
    let removedAny = false;
    const groupIndices = new Set(
      (restoreData.snapshots || []).map((snap) => snap?.groupIdx ?? 0)
    );

    const matchesErase = (stroke) =>
      stroke &&
      stroke.userId === userId &&
      stroke.timestamp === timestamp &&
      stroke.isSelectionErase === true;

    const removeFromCollection = (collection, group) => {
      if (!Array.isArray(collection)) return false;
      let removed = false;
      for (let i = collection.length - 1; i >= 0; i--) {
        if (!matchesErase(collection[i])) continue;
        collection.splice(i, 1);
        const count = group.userStrokeCounts?.get(userId) || 0;
        if (count > 0) group.userStrokeCounts.set(userId, count - 1);
        removed = true;
      }
      return removed;
    };

    for (const groupIdx of groupIndices) {
      const group = lm.layerGroups?.[groupIdx];
      if (!group) continue;

      if (removeFromCollection(group.strokeStack, group)) {
        removedAny = true;
      }

      if (removeFromCollection(group.flatStrokeRecords, group)) {
        removedAny = true;
        lm._rebuildFlatCanvas?.(group);
      }

      for (let i = group.bakedSequences.length - 1; i >= 0; i--) {
        const seq = group.bakedSequences[i];
        if (!Array.isArray(seq?.strokes)) continue;
        const beforeLength = seq.strokes.length;
        if (!removeFromCollection(seq.strokes, group)) continue;

        removedAny = true;
        if (seq.strokes.length === 0) {
          group.bakedSequences.splice(i, 1);
        } else if (seq.canvas && seq.ctx) {
          lm._rebuildSequenceCanvas?.(seq);
        } else if (seq.type !== 'group' && seq.strokes.length !== beforeLength) {
          lm._rebuildSequenceCanvas?.(seq);
        }
      }
    }

    if (removedAny) {
      lm.needsComposite = true;
      lm._notifyHistoryPanel?.(true);
    }
    return removedAny;
  }

  /**
   * Assign an authoritative seq to a lift-time selection-erase stroke (committed
   * at seq=0) and re-sort so it settles into the confirmed stroke order instead
   * of floating on top. Used when a moved selection is removed: the erase that
   * happened at lift must adopt the SEL_DELETE seq.
   * @param {Object} restoreData - The user's _selectionRestoreData
   * @param {number} fallbackUserId - User to attribute the erase to
   * @param {number} seq - Authoritative server seq
   */
  _setSelectionEraseStrokeSeq(restoreData, fallbackUserId, seq) {
    const lm = this.board.layerManager;
    const timestamp = restoreData?.eraseTimestamp;
    if (!lm || !seq || timestamp === undefined || timestamp === null) return;

    const userId = restoreData.eraseUserId ?? fallbackUserId;
    for (const group of lm.layerGroups) {
      if (!Array.isArray(group?.strokeStack)) continue;
      let touched = false;
      for (const stroke of group.strokeStack) {
        if (stroke && stroke.userId === userId && stroke.timestamp === timestamp && stroke.isSelectionErase === true) {
          stroke.seq = seq;
          touched = true;
        }
      }
      if (touched) {
        lm._sortStrokeStack(group);
        lm.needsComposite = true;
      }
    }
  }

  _cropFloatingCanvasToSourceBounds(user, sourceCrop) {
    if (!user?.floatingCanvas || !sourceCrop) return false;

    const sx = Math.max(0, Math.floor(sourceCrop.x));
    const sy = Math.max(0, Math.floor(sourceCrop.y));
    const sw = Math.min(user.floatingCanvas.width - sx, Math.ceil(sourceCrop.width));
    const sh = Math.min(user.floatingCanvas.height - sy, Math.ceil(sourceCrop.height));
    if (sw <= 0 || sh <= 0) return false;
    if (sx === 0 && sy === 0 && sw === user.floatingCanvas.width && sh === user.floatingCanvas.height) return false;

    const cropped = document.createElement('canvas');
    cropped.width = sw;
    cropped.height = sh;
    cropped.getContext('2d').drawImage(user.floatingCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    this._disposeCanvas(user.floatingCanvas);
    user.floatingCanvas = cropped;
    user.floatingCtx = cropped.getContext('2d');
    user.originalCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: sw, y: 0 },
      bl: { x: 0, y: sh },
      br: { x: sw, y: sh }
    };
    user._cachedPreviewCanvas = null;
    user._cachedPreviewBounds = null;
    return true;
  }

  /**
   * Generate a pattern tile from a user's pattern brush settings.
   * @private
   */
  _getPatternTile(user) {
    // Must use the same builder as PatternTool/SelectTool: a locally-drawn
    // selection fill and its remote echo have to produce identical tiles (and
    // identical patternBaseDim) or the two clients diverge.
    return getPatternTile(user, this._patternTileCache);
  }

  /**
   * Start the animation loop for remote user selections
   */
  startRemoteSelectionAnimation() {
    if (this._isReplayMode()) return;
    if (this.remoteSelectionAnimationId) return;

    let lastDraw = 0;
    const animate = (now) => {
      const step = marchingAntsStep(this.board?.lowPowerMode, now, lastDraw);
      if (!step) {
        this.remoteSelectionAnimationId = requestAnimationFrame(animate);
        return;
      }
      lastDraw = now;
      this.remoteSelectionOffset = (this.remoteSelectionOffset + step) % 16;

      // Get fresh values each frame
      const users = this.getUsersMap();
      const sessionIndex = this.getSessionIndex();

      // Check if any remote user has a selection that needs animating
      let hasActiveSelection = false;
      if (users) {
        for (const [id, user] of users.entries()) {
          // Skip local user
          if (id === sessionIndex) continue;

          const isLivePendingPreview = !!(user.pendingSelection && user.mousedown && user.startPos && !user.floatingCanvas);

          if (user.floatingCanvas || (user.pendingSelection && !isLivePendingPreview)) {
            hasActiveSelection = true;

            if (user.floatingCanvas && user.selection) {
              if (user.pendingImageLoad) {
                continue;
              }
              // Skip during active movement (like local SelectTool's !isDragging guard).
              // Move previews are scheduled separately and coalesced to avoid observer lag.
              // When idle, redraw to animate marching ants.
              if (!user._selectionMoving) {
                this._clearUserOverlay(user);
                this.drawFloatingSelection(user);
              }
            } else if (user.pendingSelection) {
              this._clearUserOverlay(user);
              this.drawPendingSelection(user, false);
            }
          }
        }
      }

      // Only continue animation if there are active selections
      if (hasActiveSelection) {
        this.remoteSelectionAnimationId = requestAnimationFrame(animate);
      } else {
        this.remoteSelectionAnimationId = null;
      }
    };

    this.remoteSelectionAnimationId = requestAnimationFrame(animate);
  }

  /**
   * Stop the remote selection animation
   */
  stopRemoteSelectionAnimation() {
    if (this.remoteSelectionAnimationId) {
      cancelAnimationFrame(this.remoteSelectionAnimationId);
      this.remoteSelectionAnimationId = null;
    }
  }

  /**
   * Handle a remote user lifting a selection
   * @param {Object} user - The remote user
   * @param {Object} selection - Selection bounds {x, y, width, height}
   * @param {Array<{x: number, y: number}>|null} lassoPath - Optional lasso path for non-rectangular selections
   * @param {string|null} imageData - Sender's flattened lift snapshot (data URL)
   * @param {boolean} allLayers - Lift spans every visible layer (SelectTool.copyAllLayers)
   */
  handleSelectionLift(user, selection, lassoPath = null, imageData = null, allLayers = false, seq = 0, extendedWarp = false, mirrored = false) {
    // A lift REPLACES the entire selection state — floatingCanvas, selection,
    // selectionCorners, originalCorners, lassoPath, _selectionRestoreData — and
    // installs a fresh `pendingImageLoad`, which orphans the chain every other
    // verb queued onto. Running it ahead of that chain means a second lift's
    // state is what the FIRST selection's still-queued moves and stamps get
    // applied to. Same discipline as every reader; see handleImagePaste.
    if (this._queueIfLoading(user, () => this.handleSelectionLift(user, selection, lassoPath, imageData, allLayers, seq, extendedWarp, mirrored))) return;

    // Clear pending selection since it's now being lifted
    user.pendingSelection = null;
    user.pendingLassoPath = null;
    user._pendingSelectionUpdatedAt = null;
    user.floatingLayers = null;

    // Store selection info on user for rendering
    user.selection = selection;
    // Drawer's extendedWarp toggle for this selection session — travels with
    // the lift so this client's warp bounds match the drawer's, see
    // _getWarpOutputBounds.
    user.extendedWarp = !!extendedWarp;

    // Lift the pixels into a floating canvas for this user.
    // Prefer the sender-provided snapshot when available so moved selections
    // preserve the exact rasterized result (important for text/font parity).
    const s = selection;
    user.floatingCanvas = document.createElement('canvas');
    user.floatingCanvas.width = s.width;
    user.floatingCanvas.height = s.height;
    user.floatingCtx = user.floatingCanvas.getContext('2d');
    user.floatingCtx.setTransform(1, 0, 0, 1, 0, 0); // Ensure clean state

    const liftLasso = lassoPath && lassoPath.length >= 3 ? lassoPath : null;

    // All-layers lift: capture each visible layer's own pixels BEFORE erasing, so
    // the matching commit can re-stamp each layer's content back into that same
    // layer — exactly what SelectTool.liftSelection does with `floatingLayers`.
    // These are captured locally rather than sent: the sender only transmits the
    // flattened composite (`imageData`), and at lift time every client's layers
    // already agree, so a local capture reproduces the sender's per-layer canvases.
    if (allLayers) {
      user.floatingLayers = this._captureLiftLayers(s, liftLasso);
    }

    // Erase directly from the layer canvas so the hole persists through compositing.
    // Clearing viewCtx is insufficient because compositeAllLayers() rebuilds it from
    // the underlying layer data, restoring the erased pixels.
    // Store restore data so commitSelection can make this undoable for remote users.
    if (allLayers) {
      // The drawer erased every visible group (SelectTool._eraseSelectionDirectly's
      // isMultiLayer branch). Doing one layer here left the other layers' pixels in
      // place on observers while the drawer's board had the hole.
      let firstRestore = null;
      for (const { groupIdx } of (user.floatingLayers || [])) {
        const restore = this._eraseSelectionFromLayer(s, groupIdx, liftLasso, user.id, seq, mirrored);
        if (!firstRestore) firstRestore = restore;
      }
      user._selectionRestoreData = firstRestore;
    } else {
      // Mirrored too: the drawer's lift erases the source area AND every mirrored
      // counterpart in one step (SelectTool.liftSelection →
      // _eraseSelectionDirectly), so an observer that skipped the mirrored half
      // kept pixels the drawer no longer has.
      user._selectionRestoreData = this._eraseSelectionFromLayer(s, user.activeLayer ?? 0, liftLasso, user.id, seq, mirrored);
    }

    // Check affected tiles for emptiness and clear ownership from empty ones
    const tt = this.board.tileTracker;
    if (tt) {
      const affectedTiles = tt.getTileIndicesForRect(s.x, s.y, s.width, s.height);
      if (affectedTiles.length > 0) {
        this.board.checkErasedTilesByIndices(new Set(affectedTiles), false);
      }
    }

    // Activate split-composite mode so upper layers render above the floating selection
    this.board.activeSelectionLayer = user.activeLayer ?? 0;
    this.board.markCompositeFull();
    this.board.compositeAllLayers();

    // Initialize corners for transform
    user.selectionCorners = {
      tl: { x: s.x, y: s.y },
      tr: { x: s.x + s.width, y: s.y },
      bl: { x: s.x, y: s.y + s.height },
      br: { x: s.x + s.width, y: s.y + s.height }
    };
    user.originalCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: s.width, y: 0 },
      bl: { x: 0, y: s.height },
      br: { x: s.width, y: s.height }
    };
    user.originalSelectionPos = { x: s.x, y: s.y };

    // Homography instances are created on first warp (see the transform sites
    // below) — an unwarped selection never needs the perspective chunk at all.
    user.homography = null;
    user.previewHomography = null;

    const finalizeLiftPreview = (alreadyMasked) => {
      if (!alreadyMasked && lassoPath && lassoPath.length >= 3) {
        this.applyLassoMask(user.floatingCtx, s.x, s.y, lassoPath);
      }

      if (lassoPath && lassoPath.length >= 3) {
        user.lassoPath = lassoPath;
      }

      user._cachedPreviewCanvas = null;
      user._cachedPreviewBounds = null;
      if (this.hasTransformedCorners(user)) {
        this._regeneratePreviewCache(user);
      }

      this._clearUserOverlay(user);
      this.drawFloatingSelection(user);
      this.startRemoteSelectionAnimation();
    };

    // SYNCHRONOUS FALLBACK: Populate from layer immediately so fast commits
    // during inactive tab replay don't commit an empty canvas.
    this._populateLiftedSelectionFromLayer(user, s);
    finalizeLiftPreview(false);

    if (imageData) {
      let resolveLoad;
      user.pendingImageLoad = new Promise((r) => {
        resolveLoad = r;
      });

      const img = new Image();
      img.onload = () => {
        if (!user.floatingCtx) {
          user.pendingImageLoad = null;
          resolveLoad();
          return;
        }
        user.floatingCtx.clearRect(0, 0, s.width, s.height);
        user.floatingCtx.drawImage(img, 0, 0, s.width, s.height);
        if (user._pendingSourceCrop) {
          this._cropFloatingCanvasToSourceBounds(user, user._pendingSourceCrop);
          user._pendingSourceCrop = null;
        }

        user._cachedPreviewCanvas = null;
        user._cachedPreviewBounds = null;
        if (this.hasTransformedCorners(user)) {
          this._regeneratePreviewCache(user);
        }

        this._clearUserOverlay(user);
        this.drawFloatingSelection(user);

        user.pendingImageLoad = null;
        resolveLoad();
      };
      img.onerror = () => {
        user.pendingImageLoad = null;
        resolveLoad();
      };
      img.src = imageData;
    }
  }

  /**
   * Snapshot the selected region of every visible layer group into its own
   * selection-sized canvas — the remote mirror of SelectTool's `floatingLayers`.
   * Must be called BEFORE the lift erase, and returns entries in ascending layer
   * order so the commit re-stamps in the same order the drawer does.
   * @param {{x:number,y:number,width:number,height:number}} selection
   * @param {Array<{x:number,y:number}>|null} lassoPath
   * @returns {Array<{canvas: HTMLCanvasElement, groupIdx: number}>}
   */
  _captureLiftLayers(selection, lassoPath) {
    const lm = this.board.layerManager;
    const layers = [];
    if (!lm) return layers;

    const scratch = document.createElement('canvas');
    scratch.width = lm.width;
    scratch.height = lm.height;
    const scratchCtx = scratch.getContext('2d');

    for (let i = 0; i < lm.layerGroups.length; i++) {
      const group = lm.layerGroups[i];
      if (!group || !group.visible) continue;

      scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
      lm.compositeLayerRange(scratchCtx, i, i + 1, null);

      const layerCanvas = document.createElement('canvas');
      layerCanvas.width = selection.width;
      layerCanvas.height = selection.height;
      const layerCtx = layerCanvas.getContext('2d');
      layerCtx.drawImage(
        scratch,
        selection.x, selection.y, selection.width, selection.height,
        0, 0, selection.width, selection.height
      );

      if (lassoPath) {
        this.applyLassoMask(layerCtx, selection.x, selection.y, lassoPath);
      }

      layers.push({ canvas: layerCanvas, groupIdx: i });
    }

    return layers;
  }

  _populateLiftedSelectionFromLayer(user, selection) {
    if (!user?.floatingCtx) return;

    // Copy selected region from the remote user's active layer only (transparent background),
    // matching local SelectTool behaviour (copyAllLayers=false).
    // Reading from viewCtx would capture all layers + background, so moving the selection
    // would appear to move content from every layer instead of just the user's layer.
    const lm = this.board.layerManager;
    const layerIdx = user.activeLayer ?? 0;
    const layerFlatCanvas = document.createElement('canvas');
    layerFlatCanvas.width = lm.width;
    layerFlatCanvas.height = lm.height;
    const layerFlatCtx = layerFlatCanvas.getContext('2d');
    lm.compositeLayerRange(layerFlatCtx, layerIdx, layerIdx + 1, null);

    user.floatingCtx.clearRect(0, 0, selection.width, selection.height);
    user.floatingCtx.drawImage(
      layerFlatCanvas,
      selection.x,
      selection.y,
      selection.width,
      selection.height,
      0,
      0,
      selection.width,
      selection.height
    );
  }

  _queueIfLoading(user, action) {
    if (user.pendingImageLoad) {
      user.pendingImageLoad = user.pendingImageLoad.then(() => {
        // Isolate failures. Every deferred selection verb hangs off ONE promise
        // chain per user, so an exception here used to reject the chain and
        // silently drop every op queued behind it — one bad stamp took out all
        // the later stamps and the commit, and only ever on a rebuild (live,
        // nothing defers). That reads exactly like "some of the stamps are
        // missing, differently each time".
        try {
          action();
        } catch (e) {
          console.warn('[RemoteSelection] deferred selection op failed:', e);
        }
      });
      return true;
    }
    return false;
  }

  _drawRemoteSelectionMovePreview(user) {
    if (user) {
      user._selectionMovePreviewTimer = null;
    }
    if (!user?.floatingCanvas || !user.selection || user.pendingImageLoad) return;

    user._lastSelectionMovePreviewAt = performance.now();

    this._regeneratePreviewCache(user);
    this._clearUserOverlay(user);
    this.drawFloatingSelection(user);
    this.startRemoteSelectionAnimation();
  }

  _scheduleRemoteSelectionMovePreview(user, force = false) {
    if (!user?.floatingCanvas || !user.selection) return;

    if (this._isReplayMode()) {
      this._cancelRemoteSelectionMovePreview(user);
      this._drawRemoteSelectionMovePreview(user);
      return;
    }

    if (force) {
      this._cancelRemoteSelectionMovePreview(user);
      this._drawRemoteSelectionMovePreview(user);
      return;
    }

    if (user._selectionMovePreviewTimer) return;

    const now = performance.now();
    const lastDraw = user._lastSelectionMovePreviewAt || 0;
    const delay = Math.max(0, this.selectionMovePreviewInterval - (now - lastDraw));
    user._selectionMovePreviewTimer = setTimeout(() => {
      requestAnimationFrame(() => this._drawRemoteSelectionMovePreview(user));
    }, delay);
  }

  _cancelRemoteSelectionMovePreview(user) {
    if (user?._selectionMovePreviewTimer) {
      clearTimeout(user._selectionMovePreviewTimer);
      user._selectionMovePreviewTimer = null;
    }
  }

  /**
   * Handle a remote user creating a selection marquee (not yet moved/lifted)
   * @param {Object} user - The remote user
   * @param {Object} selection - Selection bounds {x, y, width, height}
   * @param {Array<{x: number, y: number}>|null} lassoPath - Optional lasso path
   */
  handleSelectionPending(user, selection, lassoPath = null) {
    // Queue behind a pending lift image for the same reason handleSelectionMove
    // does: this WRITES the selection state (`pendingLassoPath`) that the
    // deferred commit verbs READ.
    //
    // handleSelectionFill clips to `user.lassoPath || user.pendingLassoPath` and
    // is itself deferred by _queueIfLoading. With this one applying immediately,
    // a rebuild ran every SEL_PENDING first and the fill last, so the fill
    // clipped against whatever path happened to be current at the end instead of
    // the one recorded with it — and when that left no usable path it fell
    // through to `fillRect` over the bounds, i.e. a lasso fill rebuilt as a
    // filled BOUNDING BOX.
    //
    // The invariant: every writer of selection state must share the ordering
    // discipline of its readers, or a synchronous rebuild interleaves them.
    if (this._queueIfLoading(user, () => this.handleSelectionPending(user, selection, lassoPath))) return;

    user.pendingSelection = selection;
    user.pendingLassoPath = lassoPath;
    user._pendingSelectionUpdatedAt = performance.now();

    this._clearUserOverlay(user);
    this.drawPendingSelection(user, false);

    // Start animation loop if not running to show the marquee
    this.startRemoteSelectionAnimation();
  }

  /**
   * Apply lasso mask to a canvas context - sets alpha to 0 for pixels outside lasso path
   * Uses Canvas globalCompositeOperation for hardware-accelerated masking.
   * @param {CanvasRenderingContext2D} ctx - The context to mask
   * @param {number} offsetX - X offset of context relative to canvas
   * @param {number} offsetY - Y offset of context relative to canvas
   * @param {Array<{x: number, y: number}>} lassoPath - The lasso polygon
   */
  applyLassoMask(ctx, offsetX, offsetY, lassoPath) {
    if (!lassoPath || lassoPath.length < 3) return;

    ctx.save();
    // destination-in: Only keep pixels where the new drawing (the lasso path) overlaps existing content
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'white'; // Color doesn't matter for destination-in
    ctx.beginPath();
    ctx.moveTo(lassoPath[0].x - offsetX, lassoPath[0].y - offsetY);
    for (let i = 1; i < lassoPath.length; i++) {
      ctx.lineTo(lassoPath[i].x - offsetX, lassoPath[i].y - offsetY);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Apply a SEL_MOVE's geometry: corners, derived bounds, and the lasso offset.
   *
   * Split out because it runs from BOTH the deferred and immediate paths of
   * handleSelectionMove and the two must never drift. Idempotent for a given
   * `corners`: the lasso shift is `minX - user.selection.x`, which is zero once
   * the bounds already match, so calling it twice moves nothing.
   *
   * @param {Object} user
   * @param {{tl:Object,tr:Object,bl:Object,br:Object}} corners
   */
  _applySelectionMoveGeometry(user, corners) {
    if (!user.selection || !corners) return;

    const oldX = user.selection.x;
    const oldY = user.selection.y;

    user.selectionCorners = corners;

    const c = corners;
    const minX = Math.floor(Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x));
    const maxX = Math.ceil(Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x));
    const minY = Math.floor(Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y));
    const maxY = Math.ceil(Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y));

    user.selection.x = minX;
    user.selection.y = minY;
    user.selection.width = maxX - minX;
    user.selection.height = maxY - minY;

    // Translate lasso path to match new position (same as local SelectTool)
    if (user.lassoPath && user.lassoPath.length > 0) {
      const dx = minX - oldX;
      const dy = minY - oldY;
      if (dx !== 0 || dy !== 0) {
        user.lassoPath = user.lassoPath.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      }
    }
  }

  handleSelectionMove(user, corners, sourceCrop = null, extendedWarp = false) {
    // Moves MUST defer behind the lift image exactly like the commit verbs do,
    // or the ops execute out of order.
    //
    // handleSelectionStamp / handleSelectionCommit / handleSelectionFill all
    // call _queueIfLoading and run AFTER the SEL_LIFT PNG decodes. This one used
    // to apply immediately, which is harmless live (messages arrive milliseconds
    // apart, the decode finished long ago, nothing ever defers) but wrong on any
    // rebuild: a sync tail or a replay seek applies the whole sequence in one
    // synchronous pass while the decode is still in flight, so
    //
    //   LIFT  MOVE_a  STAMP1  MOVE_b  STAMP2  MOVE_c  STAMP3
    //
    // ran as MOVE_a,b,c first — leaving the selection at position c — and then
    // all three stamps, every one of them at position c. Three stamps across the
    // board rebuilt as a single stamp in one spot, and any op whose
    // _pendingSourceCrop landed out of order came out clipped. It also made the
    // result timing-dependent: whether the decode beat the replay changed the
    // outcome from one sync to the next.
    //
    // Queueing here puts moves on the SAME promise chain as the commits, so
    // relative order is preserved whether or not an image is pending.
    // NOTE: do NOT also apply the geometry synchronously here.
    //
    // That was tried and reverted. Setting the corners early lets
    // handleImagePaste's img.onload see the FINAL scaled corners while the
    // source crop is still deferred — so user.originalCorners is still the
    // UNCROPPED size, _getWarpOutputBounds warps from the wrong source quad, and
    // handle-scaled stamps rebuilt far too large and clipped, differently on
    // every sync. Geometry and the crop that redefines originalCorners have to
    // move together, which means both stay on this chain.
    if (this._queueIfLoading(user, () => this.handleSelectionMove(user, corners, sourceCrop, extendedWarp))) return;
    if (!user.floatingCanvas || !user.selection) return;

    // Keep the session's extendedWarp current across the drag, not just at
    // lift — a toggle mid-transform must show up in remote/replay preview
    // immediately, matching what the drawer sees locally. See _getWarpOutputBounds.
    user.extendedWarp = !!extendedWarp;

    // The `_selectionMoving` flag + wall-clock idle timer only exist to
    // coordinate with the live marching-ants rAF loop (which skips redraws while
    // moves stream in). That loop is disabled during replay, and replay draws
    // each move preview synchronously, so the timer would just do off-clock work
    // (and could clear the overlay at an arbitrary wall-clock moment mid-export).
    if (!this._isReplayMode()) {
      // Signal animation loop: skip drawing while moves are arriving
      // (mirrors local SelectTool's isDragging guard in startMarchingAnts)
      user._selectionMoving = true;

      // Reset idle timer — after 100ms of no SEL_MOVE, resume animation loop
      if (user._selectionIdleTimer) {
        clearTimeout(user._selectionIdleTimer);
      }
      user._selectionIdleTimer = setTimeout(() => {
        user._selectionMoving = false;
        user._selectionIdleTimer = null;
        this._scheduleRemoteSelectionMovePreview(user, true);
      }, 100);
    }

    if (sourceCrop) {
      if (user.pendingImageLoad) {
        user._pendingSourceCrop = sourceCrop;
      } else {
        this._cropFloatingCanvasToSourceBounds(user, sourceCrop);
      }
    }

    this._applySelectionMoveGeometry(user, corners);

    // If the authoritative lifted raster is still decoding, don't build or draw
    // transformed previews from the temporary fallback pixels. Hidden tabs are
    // especially prone to delayed image decode, which can otherwise leave the
    // selection visually wrong until the tab becomes active again.
    if (user.pendingImageLoad) {
      this.startRemoteSelectionAnimation();
      return;
    }

    this._scheduleRemoteSelectionMovePreview(user);
  }

  /**
   * Draw one lifted source canvas into an active stroke, applying the perspective
   * warp when the selection was transformed. Returns the dirty rect it painted.
   * Extracted so the all-layers commit can run the identical draw per layer.
   * @returns {{x:number,y:number,width:number,height:number}}
   */
  /**
   * @param {boolean} [mirrored=false] - Full-board mirror state off the wire. The
   *   same blit is replayed into every active mirror region, matching
   *   SelectTool._drawFloatingToActiveStroke. Returns the dirty rect INCLUDING
   *   the mirrored copies, since commitUserStroke crops the stroke to it.
   */
  _drawLiftedCanvasToActiveStroke(user, active, sourceCanvas, hasTransform, corners, rect, outputBounds, mirrored = false) {
    const { x: ix, y: iy, width: iw, height: ih } = rect;
    let paint = null;
    let dirty = null;

    // A windowed active-stroke canvas's local origin is `active.origin`, not
    // board (0,0) — every draw below uses board-absolute coordinates, so they
    // need translating into the canvas's own local space first. See
    // windowed_canvas_needs_ctx_translate memory.
    const ox = active.origin?.x ?? 0;
    const oy = active.origin?.y ?? 0;
    if (ox || oy) active.ctx.save();
    if (ox || oy) active.ctx.translate(-ox, -oy);

    if (hasTransform && user.originalCorners) {
      try {
        const warp = getHomography();
        if (!warp) throw new Error('homography chunk unavailable');
        if (!user.homography) {
          user.homography = new warp.Homography('projective');
        }

        const result = warp.performHomographyTransform({
          sourceCanvas,
          sourceCorners: user.originalCorners,
          destCorners: corners,
          scale: 1, // Full resolution for commit
          homographyInstance: user.homography,
          outputBounds
        });

        if (result) {
          const tempCanvas = warp.imageDataToCanvas(result.imageData);
          const drawX = Math.round(result.bounds.minX);
          const drawY = Math.round(result.bounds.minY);
          paint = (ctx) => ctx.drawImage(tempCanvas, drawX, drawY);
          dirty = {
            x: drawX,
            y: drawY,
            width: Math.ceil(result.bounds.width),
            height: Math.ceil(result.bounds.height)
          };
        }
      } catch (e) {
        console.warn('Remote homography failed:', e);
      }
    }

    if (!paint) {
      paint = (ctx) => ctx.drawImage(sourceCanvas, ix, iy, iw, ih);
      dirty = { x: ix, y: iy, width: iw, height: ih };
    }

    paint(active.ctx);

    const mirrorTargets = this.board.getSelectionMirrorTargets(dirty, mirrored);
    for (const { region } of mirrorTargets) {
      this.board.withMirroredRegionTransform(active.ctx, region, () => paint(active.ctx));
    }

    if (ox || oy) active.ctx.restore();
    return this.board.unionWithMirrorTargets(dirty, mirrorTargets);
  }

  /**
   * The stamp carries SEL_COMMIT's authoritative seq, and the destination-out
   * lift-erase before it carries SEL_LIFT's. Both are sequenced or neither is:
   * _sortStrokeStack maps seq 0 to MAX_SAFE_INTEGER, so a sequenced stamp above
   * an unsequenced erase sinks below it and gets wiped. The server numbers every
   * broadcast from one counter and the lift always precedes the commit, so
   * seq_lift < seq_commit and the erase stays underneath. The drawer reconciles
   * both halves to the same two seqs on the echoes.
   * @param {number} [seq=0] - Authoritative SEL_COMMIT seq.
   */
  handleSelectionCommit(user, layerIndex, seq = 0, extendedWarp = false, mirrored = false) {
    // Forward `seq` through the requeue. Dropping it here fell back to the
    // `seq = 0` default, and _sortStrokeStack floats seq 0 to the TOP of the
    // stack — so the stamp sorted above everything committed after it and no
    // longer sat with the lift-erase it pairs with. Every sibling verb already
    // passes it (delete/fill/stamp/merge); SEL_COMMIT was the one that did not,
    // and it is the verb that ends most selections.
    //
    // This lands almost exclusively on JOINERS: _queueIfLoading defers only
    // while the SEL_LIFT PNG is still decoding, and SyncClient.replayBuffer()
    // replays the join tail SYNCHRONOUSLY in a tight loop, so the decode is
    // always still in flight when SEL_COMMIT replays. A live client receives the
    // same messages spread over time, decodes first, never requeues, and keeps
    // the seq — which is exactly the split measured on a 3-client room:
    // live observer held the stamp at S89, the joiner at S0.
    if (this._queueIfLoading(user, () => this.handleSelectionCommit(user, layerIndex, seq, extendedWarp, mirrored))) return;
    if (!user.floatingCanvas || !user.selection) {
      // A commit with no float is ALWAYS a lost apply: the pixels stay wherever
      // they were before the lift, because the SEL_LIFT that should have erased
      // the source and created the float never arrived. Silent until now, which
      // is why it looked identical to "the moves didn't apply". On a rebuild it
      // means the commit's StrokeTape bundle shipped without its SEL_LIFT.
      console.warn(`[RemoteSelection] SEL_COMMIT (seq ${seq}) for user ${user.id} dropped: no floating selection`);
      return;
    }

    // extendedWarp can be toggled after the lift but before this commit — the
    // value that travelled with SEL_LIFT (see handleSelectionLift) only seeds
    // the session; the commit's own value is what actually decided this bake,
    // so it must win here. See _getWarpOutputBounds.
    user.extendedWarp = !!extendedWarp;

    const lm = this.board.layerManager;
    const layerIdx = layerIndex ?? user.activeLayer ?? 0;
    const s = user.selection;
    const c = user.selectionCorners;
    const selectionRestoreData = user._selectionRestoreData
      ? this._cloneSelectionRestoreData(user._selectionRestoreData)
      : null;

    // Ensure integer coordinates for consistent baking
    const ix = Math.floor(s.x);
    const iy = Math.floor(s.y);
    const iw = Math.ceil(s.x + s.width) - ix;
    const ih = Math.ceil(s.y + s.height) - iy;
    const rect = { x: ix, y: iy, width: iw, height: ih };

    // Check if transform was applied (corners moved from axis-aligned rectangle)
    const hasTransform = this.hasTransformedCorners(user);
    const outputBounds = hasTransform ? this._getWarpOutputBounds(user, c) : null;

    // All-layers lift: re-stamp each layer's OWN captured pixels back into that
    // layer, matching SelectTool.commitSelection's copyAllLayers branch. Without
    // this the drawer moved content on every layer while observers moved it on
    // one and flattened the rest onto the active layer.
    const targets = (user.floatingLayers && user.floatingLayers.length > 0)
      ? user.floatingLayers
      : [{ canvas: user.floatingCanvas, groupIdx: layerIdx }];

    // Predicted paint rect for the windowed active-stroke bounds hint — the real
    // dirty rect (from `_drawLiftedCanvasToActiveStroke`) isn't known until after
    // `beginUserStroke`, same as SelectTool.commitSelection's single-layer branch.
    // The warp's actual output can differ slightly from this prediction; the 32px
    // pad on `_computeWindowedBounds` covers that, same as brush's line caps.
    const predictedPaintRect = outputBounds
      ? {
        x: Math.round(outputBounds.minX),
        y: Math.round(outputBounds.minY),
        width: Math.ceil(outputBounds.width),
        height: Math.ceil(outputBounds.height)
      }
      : rect;
    const predictedMirrorTargets = this.board.getSelectionMirrorTargets(predictedPaintRect, mirrored);
    const strokeBounds = this.board.unionWithMirrorTargets(predictedPaintRect, predictedMirrorTargets);

    // One shared timestamp so a single Ctrl+Z reverses the whole multi-layer
    // stamp, exactly as it does on the drawer.
    const batchTimestamp = targets.length > 1
      ? (typeof lm?.allocateHistoryTimestamp === 'function' ? lm.allocateHistoryTimestamp() : Date.now())
      : null;

    const tt = this.board.tileTracker;
    let unionX = null, unionY = null, unionMaxX = null, unionMaxY = null;
    let attachedRestoreData = false;
    let committedAny = false;

    for (const { canvas, groupIdx } of targets) {
      // Begin a stroke on the target layer so the committed pixels enter the
      // layer system and persist through compositeAllLayers() calls.
      lm.beginUserStroke(groupIdx, user.id, 'source-over', undefined, strokeBounds);
      const active = lm.layerGroups[groupIdx]?.activeStrokeByUser.get(user.id);
      if (!active) continue;

      const dirty = this._drawLiftedCanvasToActiveStroke(
        user, active, canvas, hasTransform, c, rect, outputBounds, mirrored
      );

      // Track the dirty region so the stroke is properly saved. Pass the explicit
      // commit layer so the dirty rect lands on the stroke we just began on
      // (groupIdx may differ from user.activeLayer for replay bots and always
      // does for the non-active layers of an all-layers commit).
      this.board.expandDirtyRect(user, dirty.x, dirty.y, dirty.width, dirty.height, groupIdx);

      // Store affected tiles in the stroke record for undo
      if (tt && active.affectedTiles) {
        const tileIndices = tt.getTileIndicesForRect(dirty.x, dirty.y, dirty.width, dirty.height);
        for (const idx of tileIndices) {
          active.affectedTiles.add(idx);
        }
      }

      // Commit only the applied placement. The source-area erase from lift remains
      // as its own older undo step so remote history matches local undo ordering.
      const commitExtraProps = { seq };
      if (batchTimestamp !== null) commitExtraProps.timestamp = batchTimestamp;
      if (selectionRestoreData && !attachedRestoreData) {
        commitExtraProps.selectionRestoreData = selectionRestoreData;
        attachedRestoreData = true;
      }
      lm.commitUserStroke(groupIdx, user.id, commitExtraProps);
      committedAny = true;

      unionX = unionX === null ? dirty.x : Math.min(unionX, dirty.x);
      unionY = unionY === null ? dirty.y : Math.min(unionY, dirty.y);
      unionMaxX = unionMaxX === null ? dirty.x + dirty.width : Math.max(unionMaxX, dirty.x + dirty.width);
      unionMaxY = unionMaxY === null ? dirty.y + dirty.height : Math.max(unionMaxY, dirty.y + dirty.height);
    }

    if (!committedAny) {
      this._cleanupUserSelection(user);
      return;
    }

    this.board.activeSelectionLayer = -1;
    this.board.markCompositeFull();
    this.board.compositeAllLayers();

    // Add tile ownership for visible tiles in the pasted region (must be after composite)
    this.board.addOccupancyForVisibleTilesInRect(
      user.id, unionX, unionY, unionMaxX - unionX, unionMaxY - unionY
    );

    this._cleanupUserSelection(user);
  }

  handleSelectionDelete(user, layerIndex, seq = 0, allLayers = false, mirrored = false) {
    if (this._queueIfLoading(user, () => this.handleSelectionDelete(user, layerIndex, seq, allLayers, mirrored))) return;
    // Use selection if available, otherwise fall back to pendingSelection
    const s = user.selection || user.pendingSelection;
    if (!s) return;

    // Ensure integer coordinates for consistent erasing
    const x = Math.floor(s.x);
    const y = Math.floor(s.y);
    const width = Math.ceil(s.x + s.width) - x;
    const height = Math.ceil(s.y + s.height) - y;
    const intS = { x, y, width, height };

    if (!user.floatingCanvas) {
      const layer = layerIndex ?? user.activeLayer ?? 0;
      const lasso = user.pendingLassoPath && user.pendingLassoPath.length >= 3
        ? user.pendingLassoPath
        : null;

      // All-layers mode clears every visible layer group, matching
      // SelectTool._eraseSelectionDirectly's isMultiLayer branch. Driven by the
      // wire flag rather than inferred — the receiver has no other way to know.
      const lm = this.board.layerManager;
      const targets = allLayers
        ? lm.layerGroups.map((g, i) => (g && g.visible ? i : -1)).filter((i) => i >= 0)
        : [layer];

      // Pass the authoritative SEL_DELETE seq so the destination-out erase sorts
      // among the confirmed stroke stack. Without it the erase commits at seq=0,
      // which _sortStrokeStack pushes to the top, permanently erasing every
      // other user's strokes beneath it in this region (the persistent white spot).
      for (const li of targets) {
        // The drawer also clears every mirrored counterpart of the selection
        // (SelectTool.deleteSelection). SEL_DELETE carries no geometry, so the
        // erase reconstructs them from the same shared helper — otherwise the
        // reflected halves stayed on every observer's board after a clear.
        this._eraseSelectionFromLayer(intS, li, lasso, user.id, seq, mirrored);
      }

      // Check affected tiles for emptiness and clear ownership from empty ones
      const tt = this.board.tileTracker;
      if (tt) {
        const affectedTiles = tt.getTileIndicesForRect(s.x, s.y, s.width, s.height);
        if (affectedTiles.length > 0) {
          this.board.checkErasedTilesByIndices(new Set(affectedTiles), false);
        }
      }
    } else if (user._selectionRestoreData) {
      // Moved-then-removed: the erase already happened at lift time and was
      // committed at seq=0. Reconcile it to the authoritative SEL_DELETE seq now
      // so it stops floating above (and erasing) confirmed strokes.
      this._setSelectionEraseStrokeSeq(user._selectionRestoreData, user.id, seq);
    }

    this.board.activeSelectionLayer = -1;
    this.board.markCompositeFull();
    this.board.compositeAllLayers();
    this._cleanupUserSelection(user);
  }

  handleSelectionFill(user, color, layerIndex, rect = null, seq = 0, wireLassoPath = null, mirrored = false) {
    if (this._queueIfLoading(user, () => this.handleSelectionFill(user, color, layerIndex, rect, seq, wireLassoPath, mirrored))) return;

    // The drawer's own path at fill time, when it sent one. Authoritative: it is
    // captured with this fill instead of read out of receiver state that other
    // verbs own and clear, so it survives any replay ordering. The `user.*`
    // fallbacks stay for pre-change senders.
    const firmLassoPath = (wireLassoPath && wireLassoPath.length >= 3) ? wireLassoPath : null;
    // Prefer the rect the drawer actually filled. A rect selection is cropped to
    // its content for display but Fill uses the original dragged rect, so the
    // cached selection is the wrong (smaller) area. Fall back to the cached
    // selection for a floating fill, where the float defines the target.
    const s = (!user.floatingCanvas && rect && rect.width > 0 && rect.height > 0)
      ? rect
      : (user.selection || user.pendingSelection);
    if (!s) return;
    const colorString = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;

    // Check for pattern mode
    const usePattern = user.patternMode && user.patternBrush;
    let patternTile = null;
    if (usePattern) {
      patternTile = this._getPatternTile(user);
    }

    // Ensure integer coordinates for consistent filling
    let ix = Math.floor(s.x);
    let iy = Math.floor(s.y);
    let iw = Math.ceil(s.x + s.width) - ix;
    let ih = Math.ceil(s.y + s.height) - iy;

    const userOpacity = user.opacity !== undefined ? user.opacity : 1;

    if (user.floatingCanvas && user.floatingCtx) {
      user.floatingCtx.save();
      user.floatingCtx.setTransform(1, 0, 0, 1, 0, 0); // Ensure clean coordinate space

      // Set fill style (pattern or solid color)
      if (usePattern && patternTile) {
        const pattern = user.floatingCtx.createPattern(patternTile, 'repeat');
        if (pattern.setTransform) {
          const scale = getPatternDrawScale(user, patternTile);
          const offsetX = (user.patternOffsetX || 0) - s.x;
          const offsetY = (user.patternOffsetY || 0) - s.y;
          const rotation = user.patternRotation || 0;
          const matrix = new DOMMatrix()
            .translate(offsetX, offsetY)
            .rotate(rotation)
            .scale(scale);
          pattern.setTransform(matrix);
        }
        user.floatingCtx.fillStyle = pattern;
      } else {
        user.floatingCtx.fillStyle = colorString;
      }
      user.floatingCtx.globalCompositeOperation = 'source-over';
      user.floatingCtx.globalAlpha = userOpacity;

      const path = firmLassoPath || user.lassoPath || (user.pendingLassoPath && user.pendingLassoPath.length >= 3 ? user.pendingLassoPath : null);
      if (path) {
        user.floatingCtx.beginPath();
        user.floatingCtx.moveTo(path[0].x - s.x, path[0].y - s.y);
        for (let i = 1; i < path.length; i++) {
          user.floatingCtx.lineTo(path[i].x - s.x, path[i].y - s.y);
        }
        user.floatingCtx.closePath();
        user.floatingCtx.clip();
      }
      user.floatingCtx.fillRect(0, 0, user.floatingCanvas.width, user.floatingCanvas.height);
      user.floatingCtx.restore();

      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      this.drawFloatingSelection(user);
    } else {
      const lm = this.board.layerManager;
      const layerIdx = layerIndex ?? user.activeLayer ?? 0;

      const path = firmLassoPath || user.lassoPath || (user.pendingLassoPath && user.pendingLassoPath.length >= 3 ? user.pendingLassoPath : null);
      if (path) {
        // Recalculate bounds from path to ensure dirty rect covers the entire shape
        // (User selection bounds might be stale or not perfectly aligned with path)
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of path) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }

        // Update variables for fill and dirty rect...
        ix = Math.floor(minX);
        iy = Math.floor(minY);
        iw = Math.ceil(maxX) - ix;
        ih = Math.ceil(maxY) - iy;

        // ...then CLAMP to the filled rect, exactly as _eraseSelectionFromLayer
        // clamps the lift erase and for the same reason: the drawer renders a
        // lasso fill into a canvas sized to the SELECTION
        // (SelectTool.fillSelection), so its paint is cropped there, while the
        // transmitted path stays the full drawn loop —
        // `cropNewSelectionToContent` shrinks the selection to its content and
        // leaves the path alone. Unclamped, the receiver painted a rim of fill
        // the drawer never had. It hid inside the pixel tolerance on a single
        // copy; with a mirror doubling it, fill_lasso_mirrored fails.
        const sx0 = Math.floor(s.x);
        const sy0 = Math.floor(s.y);
        const sx1 = Math.ceil(s.x + s.width);
        const sy1 = Math.ceil(s.y + s.height);
        const cx = Math.max(sx0, ix);
        const cy = Math.max(sy0, iy);
        const cw = Math.min(sx1, ix + iw) - cx;
        const ch = Math.min(sy1, iy + ih) - cy;
        if (cw > 0 && ch > 0) { ix = cx; iy = cy; iw = cw; ih = ch; }
      }

      // The drawer fills every active mirror region too (SelectTool.fillSelection),
      // so the windowed active-stroke bounds (and the tracked dirty rect below)
      // must span the mirrored copies just as much as the unmirrored fill.
      const fillRect = { x: ix, y: iy, width: iw, height: ih };
      const mirrorTargets = this.board.getSelectionMirrorTargets(fillRect, mirrored);
      const strokeBounds = this.board.unionWithMirrorTargets(fillRect, mirrorTargets);

      lm.beginUserStroke(layerIdx, user.id, user.blendMode || 'source-over', undefined, strokeBounds);
      const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(user.id);
      if (!active) return;

      const layerCtx = active.ctx;
      layerCtx.globalAlpha = userOpacity;

      // Set fill style (pattern or solid color)
      if (usePattern && patternTile) {
        const pattern = layerCtx.createPattern(patternTile, 'repeat');
        if (pattern.setTransform) {
          const scale = getPatternDrawScale(user, patternTile);
          const offsetX = user.patternOffsetX || 0;
          const offsetY = user.patternOffsetY || 0;
          const rotation = user.patternRotation || 0;
          const matrix = new DOMMatrix()
            .translate(offsetX, offsetY)
            .rotate(rotation)
            .scale(scale);
          pattern.setTransform(matrix);
        }
        layerCtx.fillStyle = pattern;
      } else {
        layerCtx.fillStyle = colorString;
      }

      let paintFill;
      if (path) {
        paintFill = () => {
          layerCtx.save();
          layerCtx.beginPath();
          layerCtx.moveTo(path[0].x, path[0].y);
          for (let i = 1; i < path.length; i++) {
            layerCtx.lineTo(path[i].x, path[i].y);
          }
          layerCtx.closePath();
          layerCtx.clip();
          layerCtx.fillRect(ix, iy, iw, ih);
          layerCtx.restore();
        };
      } else {
        paintFill = () => layerCtx.fillRect(ix, iy, iw, ih);
      }

      // A windowed active-stroke canvas's local origin is `active.origin`, not
      // board (0,0) — `paintFill`/pattern setup above use board-absolute
      // coordinates, so translate into the canvas's own local space first. See
      // windowed_canvas_needs_ctx_translate memory.
      const ox = active.origin?.x ?? 0;
      const oy = active.origin?.y ?? 0;
      if (ox || oy) layerCtx.save();
      if (ox || oy) layerCtx.translate(-ox, -oy);

      paintFill();
      for (const { region } of mirrorTargets) {
        this.board.withMirroredRegionTransform(layerCtx, region, paintFill);
      }
      if (ox || oy) layerCtx.restore();
      layerCtx.globalAlpha = 1.0;

      const paintedRects = [fillRect, ...mirrorTargets.map(t => t.bounds)];
      const tileOwnership = this.board.tileTracker;
      for (const r of paintedRects) {
        // Dirty rect must span the mirrored copies — commitUserStroke crops to it.
        this.board.expandDirtyRect(user, r.x, r.y, r.width, r.height, layerIdx);

        // Store affected tiles in the stroke record for undo
        if (tileOwnership && active.affectedTiles) {
          for (const idx of tileOwnership.getTileIndicesForRect(r.x, r.y, r.width, r.height)) {
            active.affectedTiles.add(idx);
          }
        }
      }

      lm.commitUserStroke(layerIdx, user.id, { seq });
      this.board.markCompositeFull();
      this.board.compositeAllLayers();

      // Add tile ownership for visible filled tiles (after composite)
      for (const r of paintedRects) {
        this.board.addOccupancyForVisibleTilesInRect(user.id, r.x, r.y, r.width, r.height);
      }
    }
  }

  handleSelectionStamp(user, layerIndex, seq = 0, extendedWarp = false, mirrored = false) {
    if (this._queueIfLoading(user, () => this.handleSelectionStamp(user, layerIndex, seq, extendedWarp, mirrored))) return;
    // Same as commit but keep floating canvas active for further moves/stamps
    if (!user.floatingCanvas || !user.selection) {
      // See handleSelectionCommit: no float means the SEL_LIFT never arrived and
      // this stamp is lost outright.
      console.warn(`[RemoteSelection] SEL_STAMP (seq ${seq}) for user ${user.id} dropped: no floating selection`);
      return;
    }

    // See handleSelectionCommit: this stamp's own value wins over whatever
    // travelled with the original lift.
    user.extendedWarp = !!extendedWarp;

    const lm = this.board.layerManager;
    const layerIdx = layerIndex ?? user.activeLayer ?? 0;
    const s = user.selection;
    const c = user.selectionCorners;

    // Shares the commit's painter: same warp handling, same mirror replay, same
    // "dirty rect must cover the mirrored copies" contract. The two used to be
    // separate copies of the homography block and drifted.
    const hasTransform = this.hasTransformedCorners(user);
    const stampOutputBounds = hasTransform ? this._getWarpOutputBounds(user, c) : null;

    // Predicted paint rect for the windowed active-stroke bounds hint, same
    // approach as handleSelectionCommit — the real dirty rect isn't known until
    // after beginUserStroke. The 32px pad on _computeWindowedBounds covers any
    // small difference between this prediction and the warp's actual output.
    const predictedStampRect = stampOutputBounds
      ? {
        x: Math.round(stampOutputBounds.minX),
        y: Math.round(stampOutputBounds.minY),
        width: Math.ceil(stampOutputBounds.width),
        height: Math.ceil(stampOutputBounds.height)
      }
      : { x: s.x, y: s.y, width: s.width, height: s.height };
    const predictedStampMirrorTargets = this.board.getSelectionMirrorTargets(predictedStampRect, mirrored);
    const stampBounds = this.board.unionWithMirrorTargets(predictedStampRect, predictedStampMirrorTargets);

    lm.beginUserStroke(layerIdx, user.id, 'source-over', undefined, stampBounds);
    const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(user.id);
    if (!active) return;

    const dirtyRect = this._drawLiftedCanvasToActiveStroke(
      user,
      active,
      user.floatingCanvas,
      hasTransform,
      c,
      { x: s.x, y: s.y, width: s.width, height: s.height },
      hasTransform ? this._getWarpOutputBounds(user, c) : null,
      mirrored
    );
    const dirtyX = dirtyRect.x;
    const dirtyY = dirtyRect.y;
    const dirtyWidth = dirtyRect.width;
    const dirtyHeight = dirtyRect.height;

    // Track the dirty region so the stroke is properly saved
    this.board.expandDirtyRect(user, dirtyX, dirtyY, dirtyWidth, dirtyHeight, layerIdx);

    // Store affected tiles in the stroke record for undo
    const tt = this.board.tileTracker;
    if (tt && active.affectedTiles) {
      const tileIndices = tt.getTileIndicesForRect(dirtyX, dirtyY, dirtyWidth, dirtyHeight);
      for (const idx of tileIndices) {
        active.affectedTiles.add(idx);
      }
    }

    lm.commitUserStroke(layerIdx, user.id, { seq });
    this.board.markCompositeFull();
    this.board.compositeAllLayers();

    // Add tile ownership for visible stamped tiles (after composite)
    this.board.addOccupancyForVisibleTilesInRect(user.id, dirtyX, dirtyY, dirtyWidth, dirtyHeight);

    // Keep selection active — redraw floating selection on user's overlay layer
    this._clearUserOverlay(user);
    this.drawFloatingSelection(user);
  }

  handleSelectionMerge(user, mode, sourceLayer, seq = 0) {
    if (this._queueIfLoading(user, () => this.handleSelectionMerge(user, mode, sourceLayer, seq))) return;

    const s = user.selection || user.pendingSelection;
    if (!s || user.floatingCanvas) return;

    const lm = this.board.layerManager;
    if (!lm) return;

    const userId = user.id;
    const layerCount = lm.layerGroups.length;
    const activeLayer = Number.isInteger(sourceLayer) ? sourceLayer : (user.activeLayer ?? 0);

    if (mode === 'up' && activeLayer >= layerCount - 1) return;
    if (mode === 'down' && activeLayer <= 0) return;
    if (mode === 'all' && layerCount <= 1) return;

    const ix = Math.floor(s.x);
    const iy = Math.floor(s.y);
    const iw = Math.ceil(s.x + s.width) - ix;
    const ih = Math.ceil(s.y + s.height) - iy;
    const intS = { x: ix, y: iy, width: iw, height: ih };

    const lassoPath = user.pendingLassoPath && user.pendingLassoPath.length >= 3
      ? user.pendingLassoPath
      : (user.lassoPath && user.lassoPath.length >= 3 ? user.lassoPath : null);

    let targetLayer;
    const sourceLayers = [];
    let flattenStart, flattenEnd;
    if (mode === 'up') {
      targetLayer = activeLayer + 1;
      sourceLayers.push(activeLayer);
      flattenStart = activeLayer;
      flattenEnd = activeLayer + 2;
    } else if (mode === 'down') {
      targetLayer = activeLayer - 1;
      sourceLayers.push(activeLayer);
      flattenStart = activeLayer;
      flattenEnd = activeLayer + 1;
    } else {
      targetLayer = activeLayer;
      for (let i = 0; i < layerCount; i++) {
        if (i !== activeLayer) sourceLayers.push(i);
      }
      flattenStart = 0;
      flattenEnd = layerCount;
    }

    // Force-commit this user's in-progress strokes across all layers so the
    // merge captures full baked state.
    for (let i = 0; i < layerCount; i++) {
      if (lm.layerGroups[i]?.activeStrokeByUser.has(userId)) {
        lm.commitUserStroke(i, userId);
      }
    }

    // Build merged content (selection-sized canvas) for the chosen layer range.
    const mergedCanvas = document.createElement('canvas');
    mergedCanvas.width = intS.width;
    mergedCanvas.height = intS.height;
    const mergedCtx = mergedCanvas.getContext('2d');

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = lm.width;
    fullCanvas.height = lm.height;
    const fullCtx = fullCanvas.getContext('2d');

    lm.compositeLayerRange(fullCtx, flattenStart, flattenEnd, null);
    mergedCtx.drawImage(fullCanvas, intS.x, intS.y, intS.width, intS.height, 0, 0, intS.width, intS.height);

    if (lassoPath) {
      mergedCtx.save();
      mergedCtx.globalCompositeOperation = 'destination-in';
      mergedCtx.fillStyle = 'white';
      mergedCtx.beginPath();
      mergedCtx.moveTo(lassoPath[0].x - intS.x, lassoPath[0].y - intS.y);
      for (let i = 1; i < lassoPath.length; i++) {
        mergedCtx.lineTo(lassoPath[i].x - intS.x, lassoPath[i].y - intS.y);
      }
      mergedCtx.closePath();
      mergedCtx.fill();
      mergedCtx.restore();
    }

    const batchTimestamp = typeof lm.allocateHistoryTimestamp === 'function'
      ? lm.allocateHistoryTimestamp()
      : Date.now();

    const layersToErase = (mode === 'up' || mode === 'all')
      ? [...sourceLayers, targetLayer]
      : sourceLayers;
    for (const layerIdx of layersToErase) {
      // Same authoritative seq on every stroke of the merge, so the batch sorts
      // identically here and on the drawer (which reconciles to it on the echo).
      const stack = lm.layerGroups[layerIdx]?.strokeStack;
      const before = stack ? stack.length : 0;
      this._eraseSelectionFromLayer(intS, layerIdx, lassoPath, userId, seq);
      // Override the timestamp with the shared batch one so undo groups them.
      // Only when the erase actually pushed a record — otherwise this relabelled
      // whatever unrelated stroke happened to be on top as part of the merge.
      if (stack && stack.length > before) {
        const last = stack[stack.length - 1];
        if (last && last.userId === userId) {
          last.timestamp = batchTimestamp;
          last.isSelectionMerge = true;
        }
      }
    }

    // Stamp merged content onto target layer as source-over. Visual z-order is
    // already correct in the merged canvas (flatten range was chosen so target
    // sits above source for 'up').
    lm.beginUserStroke(targetLayer, userId, 'source-over', undefined, intS);
    const active = lm.layerGroups[targetLayer]?.activeStrokeByUser.get(userId);
    if (active) {
      const ox = active.origin?.x ?? 0;
      const oy = active.origin?.y ?? 0;
      active.ctx.drawImage(mergedCanvas, intS.x - ox, intS.y - oy);
      if (active.dirtyRect) {
        active.dirtyRect.minX = intS.x;
        active.dirtyRect.minY = intS.y;
        active.dirtyRect.maxX = intS.x + intS.width;
        active.dirtyRect.maxY = intS.y + intS.height;
      }
      const tt = this.board.tileTracker;
      if (tt && active.affectedTiles) {
        const idxs = tt.getTileIndicesForRect(intS.x, intS.y, intS.width, intS.height);
        for (const i of idxs) active.affectedTiles.add(i);
      }
      this.board.expandDirtyRect(user, intS.x, intS.y, intS.width, intS.height, targetLayer);
      lm.commitUserStroke(targetLayer, userId, {
        timestamp: batchTimestamp,
        isSelectionMerge: true,
        seq
      });
    }

    this.board.activeSelectionLayer = -1;
    this.board.markCompositeFull();
    this.board.compositeAllLayers();
    this.board.addOccupancyForVisibleTilesInRect(userId, intS.x, intS.y, intS.width, intS.height);

    this._cleanupUserSelection(user);
  }

  handleSelectionFlip(user) {
    if (this._queueIfLoading(user, () => this.handleSelectionFlip(user))) return;
    if (!user.floatingCanvas || !user.selection) return;

    // Create a temporary canvas for the flipped image
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = user.floatingCanvas.width;
    tempCanvas.height = user.floatingCanvas.height;
    const tempCtx = tempCanvas.getContext('2d');

    // Flip horizontally by scaling -1 on x-axis
    tempCtx.save();
    tempCtx.translate(tempCanvas.width, 0);
    tempCtx.scale(-1, 1);
    tempCtx.drawImage(user.floatingCanvas, 0, 0);
    tempCtx.restore();

    // Replace the floating canvas with the flipped version
    user.floatingCanvas = tempCanvas;
    user.floatingCtx = tempCtx;

    // If there are original corners (for transforms), flip them horizontally
    if (user.originalCorners) {
      const width = user.floatingCanvas.width;
      // Swap left and right corners and flip their x positions
      const temp = {
        tl: { ...user.originalCorners.tl },
        tr: { ...user.originalCorners.tr },
        bl: { ...user.originalCorners.bl },
        br: { ...user.originalCorners.br }
      };

      // Flip x coordinates and swap left/right
      user.originalCorners.tl = { x: width - temp.tr.x, y: temp.tr.y };
      user.originalCorners.tr = { x: width - temp.tl.x, y: temp.tl.y };
      user.originalCorners.bl = { x: width - temp.br.x, y: temp.br.y };
      user.originalCorners.br = { x: width - temp.bl.x, y: temp.bl.y };
    }

    // Invalidate cached preview since the source image changed
    user._cachedPreviewCanvas = null;
    user._cachedPreviewBounds = null;

    // Redraw the selection with flipped content
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    this.drawFloatingSelection(user);
  }

  handleSelectionCancel(user) {
    if (this._queueIfLoading(user, () => this.handleSelectionCancel(user))) return;
    if (!user.floatingCanvas || !user.selection || !user.originalSelectionPos) return;

    // Restore the lifted pixels back to the layer at their original position
    const lm = this.board.layerManager;
    const layerIdx = user.activeLayer ?? 0;

    // If the lift created a temporary erase stroke, remove that stroke from
    // history so cancel restores the exact pre-lift layer state.
    if (user._selectionRestoreData && this._removeSelectionEraseStroke(user._selectionRestoreData, user.id)) {
      // Restored by removing the erase stroke from layer history.
    } else if (user._selectionRestoreData) {
      for (const { groupIdx, canvas, x, y } of user._selectionRestoreData.snapshots) {
        const group = lm.layerGroups[groupIdx];
        if (group?.flatCanvas) {
          lm.writeToFlatCanvas(groupIdx, canvas, x, y);
        } else {
          const bounds = { x, y, width: canvas.width, height: canvas.height };
          lm.beginUserStroke(groupIdx, user.id, 'source-over', undefined, bounds);
          const active = lm.layerGroups[groupIdx]?.activeStrokeByUser.get(user.id);
          if (active) {
            const ox = active.origin?.x ?? 0;
            const oy = active.origin?.y ?? 0;
            active.ctx.drawImage(canvas, x - ox, y - oy);
            lm.commitUserStroke(groupIdx, user.id);
          }
        }
      }
    } else {
      const bounds = {
        x: user.originalSelectionPos.x,
        y: user.originalSelectionPos.y,
        width: user.floatingCanvas.width,
        height: user.floatingCanvas.height
      };
      lm.beginUserStroke(layerIdx, user.id, 'source-over', undefined, bounds);
      const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(user.id);
      if (active) {
        const ox = active.origin?.x ?? 0;
        const oy = active.origin?.y ?? 0;
        active.ctx.drawImage(user.floatingCanvas, user.originalSelectionPos.x - ox, user.originalSelectionPos.y - oy);
        lm.commitUserStroke(layerIdx, user.id);
      }
    }

    this.board.activeSelectionLayer = -1;
    this.board.markCompositeFull();
    this.board.compositeAllLayers();
    this._cleanupUserSelection(user);
  }

  handleSelectionToBrush(user, brushDataJson) {
    if (this._queueIfLoading(user, () => this.handleSelectionToBrush(user, brushDataJson))) return;
    // This is mostly informational - the brush data is being set on the remote user
    // The actual brush will be loaded when they receive the GMP message
    // This handler exists for consistency but may not need implementation
    console.log(`User ${user.username} converted selection to brush`);
  }

  handleImagePaste(user, data) {
    // THE join-path ordering violation. SyncCoordinator._sendActiveImagesToJoiner
    // sends IMG_PASTE (+ one SEL_MOVE) for a still-floating selection *after* the
    // whole command tail, so on a rebuild it is dispatched into the same
    // synchronous replayBuffer() pass that just queued the tail's SEL_MOVE /
    // SEL_STAMP / SEL_COMMIT behind the SEL_LIFT's PNG decode.
    //
    // Running immediately, it threw away floatingCanvas / selection /
    // selectionCorners / originalCorners and installed a SECOND pendingImageLoad,
    // orphaning the tail's chain. Those queued stamps then drained against the
    // paste's state, and the two decodes raced:
    //
    //   lift image wins  -> stamps draw the paste's still-EMPTY canvas   ("no stamps appear")
    //   paste image wins -> stamps draw the FINAL (already source-cropped) float,
    //                       and _getWarpOutputBounds warps from the paste's
    //                       originalCorners against the tail's intermediate dest
    //                       corners                                       ("cut off by a bounding box
    //                                                                       that ignores the transform")
    //
    // which is why repeated syncs of identical server state came back different
    // every time. Live this never fires: nothing is ever pending.
    //
    // Queued, the paste lands after the tail's ops, re-establishes the float from
    // the original lift image, and the trailing SEL_MOVE re-queues itself onto the
    // paste's own decode (handleSelectionMove re-enters and re-checks), so the
    // cumulative source crop and the final corners still arrive together.
    if (this._queueIfLoading(user, () => this.handleImagePaste(user, data))) return;

    const { x, y, width, height, imageData } = data;

    // Clear any existing selection state for this user
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.pendingSelection = null;
    user.pendingLassoPath = null;
    user._pendingSelectionUpdatedAt = null;

    // Create floating canvas for the pasted image
    user.floatingCanvas = document.createElement('canvas');
    user.floatingCanvas.width = width;
    user.floatingCanvas.height = height;
    user.floatingCtx = user.floatingCanvas.getContext('2d');

    // Set up selection state synchronously so that a replayed SEL_MOVE (e.g. on join)
    // can apply the current transform corners before the image finishes loading.
    user.selection = { x, y, width, height };
    user.selectionCorners = {
      tl: { x, y },
      tr: { x: x + width, y },
      bl: { x, y: y + height },
      br: { x: x + width, y: y + height }
    };
    user.originalCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: width, y: 0 },
      bl: { x: 0, y: height },
      br: { x: width, y: height }
    };
    user.originalSelectionPos = { x: -1, y: -1 }; // Pasted content is "moved"

    // Homography instances are created on first warp (see the transform sites
    // below) — an unwarped selection never needs the perspective chunk at all.
    user.homography = null;
    user.previewHomography = null;

    // Activate split-composite mode for the pasted floating selection
    this.board.activeSelectionLayer = user.activeLayer ?? 0;
    this.board.markCompositeFull();
    this.board.compositeAllLayers();

    // Load the image and draw once ready — by then SEL_MOVE may have already updated
    // selectionCorners, so drawFloatingSelection will render at the correct position.
    // Track the decode via pendingImageLoad so queued SEL_MOVE/SEL_COMMIT/SEL_STAMP
    // replays wait for the image instead of committing an empty floating canvas.
    let resolveLoad;
    user.pendingImageLoad = new Promise((r) => {
      resolveLoad = r;
    });

    const img = new Image();
    img.onload = () => {
      if (!user.floatingCtx) {
        user.pendingImageLoad = null;
        resolveLoad();
        return;
      }
      user.floatingCtx.drawImage(img, 0, 0);
      if (user._pendingSourceCrop) {
        this._cropFloatingCanvasToSourceBounds(user, user._pendingSourceCrop);
        user._pendingSourceCrop = null;
      }
      // A SEL_MOVE replay may have already run _regeneratePreviewCache on the empty
      // canvas, producing a stale (blank) cached preview. Invalidate and rebuild now
      // that the actual image data is available.
      user._cachedPreviewCanvas = null;
      user._cachedPreviewBounds = null;
      if (this.hasTransformedCorners(user)) {
        this._regeneratePreviewCache(user);
      }
      this.drawFloatingSelection(user);
      this.startRemoteSelectionAnimation();

      user.pendingImageLoad = null;
      resolveLoad();
    };
    img.onerror = () => {
      user.pendingImageLoad = null;
      resolveLoad();
    };
    img.src = imageData;
  }

  /**
   * Reset all selection-related state on a user object and clear their overlay canvas.
   */
  _cleanupUserSelection(user) {
    if (!user) return;

    this._cancelRemoteSelectionMovePreview(user);

    // Cancel idle timer
    if (user._selectionIdleTimer) {
      clearTimeout(user._selectionIdleTimer);
      user._selectionIdleTimer = null;
    }
    user._selectionMoving = false;

    if (user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      setUserLayerContent(user, false);
    }
    if (user._selectionRestoreData?.snapshots) {
      for (const snap of user._selectionRestoreData.snapshots) {
        this._disposeCanvas(snap?.canvas);
      }
    }
    this._disposeCanvas(user.floatingCanvas);
    this._disposeCanvas(user._cachedPreviewCanvas);
    if (user.floatingLayers) {
      for (const entry of user.floatingLayers) this._disposeCanvas(entry?.canvas);
    }
    user.floatingLayers = null;
    user.floatingCanvas = null;
    user.floatingCtx = null;
    user.selection = null;
    user.pendingSelection = null;
    user.pendingLassoPath = null;
    user._pendingSelectionUpdatedAt = null;
    user.selectionCorners = null;
    user.originalCorners = null;
    user.extendedWarp = false;
    user._pendingSourceCrop = null;
    user.originalSelectionPos = null;
    user.lassoPath = null;
    user.homography = null;
    user.previewHomography = null;
    user._selectionRestoreData = null;
    user._cachedPreviewCanvas = null;
    user._cachedPreviewBounds = null;
    user.pendingImageLoad = null;
    user._lastSelectionMovePreviewAt = 0;
  }

  // Output window for the warp: widened when it spills beyond the corner bbox
  // (concave/crossed quads), cropped to the board when the quad reaches outside
  // it. Null when the default corner-bbox window is already right, or when
  // the drawer had extendedWarp off (folded quads just clip at the corner bbox).
  _getWarpOutputBounds(user, destCorners) {
    if (!user.extendedWarp) return null;
    const warp = getHomography();
    if (!warp) return null;
    return warp.computeWarpOutputBounds(user.originalCorners, destCorners, {
      minX: 0,
      minY: 0,
      maxX: this.board.getWidth(),
      maxY: this.board.getHeight()
    });
  }

  hasTransformedCorners(user) {
    if (!user.selectionCorners || !user.selection) return false;

    if (this._isAxisAlignedCornerRect(user.selectionCorners)) return false;

    const s = user.selection;
    const c = user.selectionCorners;
    const tolerance = 0.5;

    return (
      Math.abs(c.tl.x - s.x) > tolerance ||
      Math.abs(c.tl.y - s.y) > tolerance ||
      Math.abs(c.tr.x - (s.x + s.width)) > tolerance ||
      Math.abs(c.tr.y - s.y) > tolerance ||
      Math.abs(c.bl.x - s.x) > tolerance ||
      Math.abs(c.bl.y - (s.y + s.height)) > tolerance ||
      Math.abs(c.br.x - (s.x + s.width)) > tolerance ||
      Math.abs(c.br.y - (s.y + s.height)) > tolerance
    );
  }

  _isAxisAlignedCornerRect(corners) {
    if (!corners) return false;

    const tolerance = 0.5;
    return (
      Math.abs(corners.tl.y - corners.tr.y) <= tolerance &&
      Math.abs(corners.bl.y - corners.br.y) <= tolerance &&
      Math.abs(corners.tl.x - corners.bl.x) <= tolerance &&
      Math.abs(corners.tr.x - corners.br.x) <= tolerance
    );
  }

  /**
   * Regenerate the cached preview canvas for transformed selections.
   * This expensive operation is only done when corners change, not every frame.
   * @private
   */
  _regeneratePreviewCache(user) {
    if (!user.floatingCanvas || !user.selection || !user.selectionCorners || !user.originalCorners) return;
    if (!this.hasTransformedCorners(user)) {
      // No transform needed, clear cache
      user._cachedPreviewCanvas = null;
      user._cachedPreviewBounds = null;
      return;
    }

    try {
      const warp = getHomography();
      if (!warp) throw new Error('homography chunk unavailable');
      // Calculate preview scale for downsampling input image (max 256px on longest side of source)
      // REMOTE USER: Stay at lower resolution to avoid hitching the observer's frame rate.
      const srcMaxDim = Math.max(user.floatingCanvas.width, user.floatingCanvas.height);
      let previewScale = srcMaxDim > this.previewMaxSize ? this.previewMaxSize / srcMaxDim : 1;
      const fullBounds = warp.calculateCornerBounds(user.selectionCorners);
      const outputBounds = this._getWarpOutputBounds(user, user.selectionCorners);
      // The output raster is sized by the *destination* window, not the source,
      // so it can dwarf the source even after previewMaxSize. Cap its pixel count
      // so the per-move warp stays cheap however far the corners are dragged.
      const MAX_PREVIEW_OUTPUT_PIXELS = 1.5e6;
      const outW = outputBounds ? outputBounds.width : fullBounds.width;
      const outH = outputBounds ? outputBounds.height : fullBounds.height;
      const outPixels = outW * outH * previewScale * previewScale;
      if (outPixels > MAX_PREVIEW_OUTPUT_PIXELS) {
        previewScale *= Math.sqrt(MAX_PREVIEW_OUTPUT_PIXELS / outPixels);
      }

      if (!user.previewHomography) {
        user.previewHomography = new warp.Homography('projective');
      }
      const result = warp.performHomographyTransform({
        sourceCanvas: user.floatingCanvas,
        sourceCorners: user.originalCorners,
        destCorners: user.selectionCorners,
        scale: previewScale,
        homographyInstance: user.previewHomography,
        outputBounds
      });

      if (result) {
        // Create/reuse cached canvas
        if (!user._cachedPreviewCanvas) {
          user._cachedPreviewCanvas = document.createElement('canvas');
        }
        user._cachedPreviewCanvas.width = result.imageData.width;
        user._cachedPreviewCanvas.height = result.imageData.height;
        const cacheCtx = user._cachedPreviewCanvas.getContext('2d');
        cacheCtx.putImageData(result.imageData, 0, 0);

        // Calculate FULL SIZE bounds for drawing the preview scaled up
        // Store bounds for drawing
        user._cachedPreviewBounds = outputBounds || {
          minX: fullBounds.minX,
          minY: fullBounds.minY,
          width: fullBounds.width,
          height: fullBounds.height
        };
      } else {
        user._cachedPreviewCanvas = null;
        user._cachedPreviewBounds = null;
      }
    } catch (e) {
      console.warn('Remote preview cache generation failed:', e);
      user._cachedPreviewCanvas = null;
      user._cachedPreviewBounds = null;
    }
  }

  drawFloatingSelection(user, drawOutline = true) {
    if (!user.floatingCanvas || !user.selection) return;
    if (user.pendingImageLoad) return;

    setUserLayerContent(user, true);
    const ctx = user.context;
    const s = user.selection;
    const c = user.selectionCorners;

    // Draw floating selection without blend mode — blend mode only applies on fill/commit,
    // not during the move preview.
    const prevBlendMode = user.board?.style.mixBlendMode;
    if (user.board && prevBlendMode && prevBlendMode !== 'normal') {
      user.board.style.mixBlendMode = 'normal';
    }

    // Blit the warped preview (cached) or the plain float, then repeat it into
    // every mirror. One helper for all three fallbacks so a mirrored copy cannot
    // be drawn on one path and forgotten on another.
    const blitCached = () => {
      const bounds = user._cachedPreviewBounds;
      const x = Math.round(bounds.minX);
      const y = Math.round(bounds.minY);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      const paint = (t) => t.drawImage(user._cachedPreviewCanvas, x, y, bounds.width, bounds.height);
      paint(ctx);
      this._paintMirroredPreview(ctx, { x, y, width: bounds.width, height: bounds.height }, paint);
    };
    const blitFloat = () => {
      const paint = (t) => t.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      paint(ctx);
      this._paintMirroredPreview(ctx, s, paint);
    };

    // Check if we need to use cached transform preview
    if (c && user.originalCorners && this.hasTransformedCorners(user)) {
      // Use cached preview canvas if available
      if (user._cachedPreviewCanvas && user._cachedPreviewBounds) {
        blitCached();
      } else {
        // Fallback: regenerate if cache missing (shouldn't happen)
        this._regeneratePreviewCache(user);
        if (user._cachedPreviewCanvas && user._cachedPreviewBounds) {
          blitCached();
        } else {
          // Final fallback
          blitFloat();
        }
      }
    } else {
      // No transform, simple draw at current position
      blitFloat();
    }

    // Draw animated marching ants border (skipped by replay renders, which
    // want the floating content without the selection UI, and while the
    // drawer has hidden their selection, e.g. their save dialog is open —
    // the lifted content itself still has to blit above so hiding it doesn't
    // punch a visible hole where the source was erased from)
    if (c && drawOutline && !user.selectionHidden) {
      this._drawFloatingOutlineLikeLocal(user);
    }

    if (user.board && prevBlendMode && prevBlendMode !== 'normal') {
      user.board.style.mixBlendMode = prevBlendMode;
    }
  }

  drawPendingSelection(user, isLivePreview = false) {
    if (!user.pendingSelection) return;
    if (user.selectionHidden) return;
    this._drawPendingSelectionLikeLocal(user);
  }

  /**
   * Forces an immediate redraw of a user's selection overlay honoring the
   * current `selectionHidden` flag, instead of waiting for the next
   * marching-ants animation frame to pick it up.
   */
  refreshSelectionVisibility(user) {
    if (!user) return;
    this._clearUserOverlay(user);
    if (user.selectionHidden) return;
    if (user.floatingCanvas && user.selection) {
      this.drawFloatingSelection(user);
    } else if (user.pendingSelection) {
      this.drawPendingSelection(user, false);
    }
  }

  /**
   * Erase a selection region directly from the layer manager using a destination-out stroke.
   * This correctly handles content in both baked sequences and the stroke stack.
   * @param {Object} s - Selection bounds {x, y, width, height}
   * @param {number} layerIdx - Layer group index
   * @param {Array<{x,y}>|null} lassoPath - Lasso polygon, or null for rectangle erase
   * @param {number} userId - ID of the user performing the erase
   * @param {number} [seq=0] - Authoritative server seq for this erase stroke. When
   *   0 (lift/merge, which carry no seq) the stroke sorts to the top until a later
   *   commit/delete reconciles it; pass the real seq for a standalone clear.
   * @param {boolean} [mirrored=false] - Full-board mirror state the DRAWER had for
   *   this operation, off the wire. Every active mirror region also gets erased,
   *   inside this same stroke — the drawer does the same in
   *   SelectTool._eraseRegionStroke, and the two must not drift.
   */
  _eraseSelectionFromLayer(s, layerIdx, lassoPath, userId, seq = 0, mirrored = false) {
    const lm = this.board.layerManager;
    if (!lm) return null;

    const group = lm.layerGroups[layerIdx];
    if (!group) return null;

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = lm.width;
    layerCanvas.height = lm.height;
    const layerCtx = layerCanvas.getContext('2d');
    lm._compositeGroupInto(layerCtx, group);

    const snap = document.createElement('canvas');
    snap.width = s.width;
    snap.height = s.height;
    const snapCtx = snap.getContext('2d');
    snapCtx.drawImage(layerCanvas, s.x, s.y, s.width, s.height, 0, 0, s.width, s.height);

    // Mask the snapshot with the lasso path if in lasso mode so restoration respects the shape
    if (lassoPath && lassoPath.length >= 3) {
      snapCtx.globalCompositeOperation = 'destination-in';
      snapCtx.fillStyle = 'white';
      snapCtx.beginPath();
      snapCtx.moveTo(lassoPath[0].x - s.x, lassoPath[0].y - s.y);
      for (let i = 1; i < lassoPath.length; i++) {
        snapCtx.lineTo(lassoPath[i].x - s.x, lassoPath[i].y - s.y);
      }
      snapCtx.closePath();
      snapCtx.fill();
      snapCtx.globalCompositeOperation = 'source-over';
    }

    const snapshots = [{ groupIdx: layerIdx, canvas: snap, x: s.x, y: s.y }];

    // Ensure integer coordinates for consistent erasing
    let ix = Math.floor(s.x);
    let iy = Math.floor(s.y);
    let iw = Math.ceil(s.x + s.width) - ix;
    let ih = Math.ceil(s.y + s.height) - iy;

    if (lassoPath && lassoPath.length >= 3) {
      // Recalculate bounds from path to ensure dirty rect covers the entire shape
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of lassoPath) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }

      // ...then CLAMP to the lifted rect. The drawer pins this erase to the
      // selection (SelectTool._eraseRegionStroke sets dirtyRect to s), and
      // commitUserStroke crops the stroke to its dirty rect — so the drawer only
      // ever erases selection ∩ lasso. The raw path bounds are much larger:
      // `cropNewSelectionToContent` shrinks the selection to its content while
      // the transmitted lassoPath stays the full drawn loop. Measured on one
      // lift: drawer committed 48x17, this committed 550x200 — i.e. observers
      // and every rebuild wiped a big region of surrounding artwork that the
      // drawer kept. Only shows on lasso selections, and only where the loop is
      // much bigger than what it caught.
      const sx0 = Math.floor(s.x);
      const sy0 = Math.floor(s.y);
      const sx1 = Math.ceil(s.x + s.width);
      const sy1 = Math.ceil(s.y + s.height);
      ix = Math.max(sx0, Math.floor(minX));
      iy = Math.max(sy0, Math.floor(minY));
      iw = Math.min(sx1, Math.ceil(maxX)) - ix;
      ih = Math.min(sy1, Math.ceil(maxY)) - iy;
      if (iw <= 0 || ih <= 0) { ix = sx0; iy = sy0; iw = sx1 - sx0; ih = sy1 - sy0; }
    }

    // Mirrored counterparts ride in THIS stroke, not their own: they then share
    // the erase's timestamp and seq, so a single reconcile orders the whole
    // erase. Committed separately they would sit at seq 0, which
    // _sortStrokeStack floats to the top of the stack as a permanent hole.
    const mirrorTargets = this.board.getSelectionMirrorTargets(s, mirrored);

    // Track the dirty region so the erase stroke is properly saved (and so it
    // doubles as the windowed active-stroke canvas's bounds hint below). Must
    // span the mirrored copies too — commitUserStroke crops the stroke to it.
    const eraseDirty = this.board.unionWithMirrorTargets(
      { x: ix, y: iy, width: iw, height: ih }, mirrorTargets
    );

    lm.beginUserStroke(layerIdx, userId, 'destination-out', undefined, eraseDirty);
    const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(userId);
    if (!active) return null;

    const ctx = active.ctx;

    const paintShape = (lassoPath && lassoPath.length >= 3)
      ? (c) => {
        c.fillStyle = 'white';
        c.beginPath();
        c.moveTo(lassoPath[0].x, lassoPath[0].y);
        for (let i = 1; i < lassoPath.length; i++) {
          c.lineTo(lassoPath[i].x, lassoPath[i].y);
        }
        c.closePath();
        c.fill();
      }
      : (c) => {
        c.fillStyle = 'white';
        c.fillRect(ix, iy, iw, ih);
      };

    const paintErase = (c) => {
      paintShape(c);
      for (const { region } of mirrorTargets) {
        this.board.withMirroredRegionTransform(c, region, () => paintShape(c));
      }
    };

    // Same hardening the drawer applies in SelectTool._eraseRegionStroke, and
    // for the same reason: an antialiased destination-out edge only subtracts
    // a·(1−a) of itself, leaving a rim of whatever was there (most visibly, of
    // a fill that traced the same shape). The two paths must not drift — an
    // erase that removes different pixels here than on the drawer is a desync.
    if (needsHardenedEraseMask(lassoPath, mirrorTargets)) {
      paintHardenedEraseMask(ctx, eraseDirty, paintErase, active.origin);
    } else {
      const ox = active.origin?.x ?? 0;
      const oy = active.origin?.y ?? 0;
      if (ox || oy) ctx.save();
      if (ox || oy) ctx.translate(-ox, -oy);
      paintErase(ctx);
      if (ox || oy) ctx.restore();
    }

    const user = this.getUsersMap().get(userId);
    // Pass the layer being erased. Without it expandDirtyRect falls back to
    // user.activeLayer, so erasing any OTHER layer (merge-all erases every
    // source layer, not just the active one) expanded the wrong group's dirty
    // rect and commitUserStroke discarded the erase as empty — merge-all wiped
    // nothing on observers.
    this.board.expandDirtyRect(user, eraseDirty.x, eraseDirty.y, eraseDirty.width, eraseDirty.height, layerIdx);

    // Commit the stroke. Use an explicit timestamp so it can be found during undo.
    const eraseTimestamp = typeof lm?.allocateHistoryTimestamp === 'function'
      ? lm.allocateHistoryTimestamp()
      : Date.now();
    lm.commitUserStroke(layerIdx, userId, {
      isSelectionErase: true,
      timestamp: eraseTimestamp,
      seq
    });

    lm.needsComposite = true;
    this.board.markCompositeFull();
    this.board.compositeAllLayers();

    return {
      snapshots,
      eraseS: { ...s },
      eraseLassoPath: lassoPath ? lassoPath.map(p => ({ ...p })) : null,
      eraseTimestamp,
      eraseUserId: userId
    };
  }
}
