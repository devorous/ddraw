/**
 * @fileoverview Eraser tool.
 * Each eraser gesture is stored as a single active stroke with blendMode 'destination-out'.
 */

import { Tool } from './BaseTool.js';
import { clampRectToCanvas } from '../utils/drawing.js';

/**
 * Eraser tool for removing content from layers.
 */
export class EraserTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('erase', board);
    this.userSize = 10;
    this.lastPos = new Map();
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this._activeUser?.currentLine?.length > 0) {
      this.onPointerUp(this._activeUser);
    }
    this._setPreviewMaskVisible(true);
    this._activeUser = null;
  }

  usesDeferredPreview() {
    return true;
  }

  /**
   * Checks if erasing should apply to all layers.
   * @private
   * @returns {boolean} - True if all layers should be erased.
   */
  _eraseAllLayers() {
    return this.board.app?.eraseAllLayers ?? false;
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    this.lastPos.set(this._getUserId(user), { x: pos.x, y: pos.y });
    user.clearLine();
    user._strokeLayer = user.activeLayer ?? 0;
    this._beginStroke(user, pos);
    this._resetStrokeState(user);

    // Decide the preview path up front so the surface starts out with the right
    // visibility: the first move tick may not produce dirty bounds, and until it
    // does drawPreview does not run to set it.
    this._setPreviewSurfaceVisible(user, this._canUseBackgroundPreview(user));

    // Ask for one composite now, whichever path we take. Starting a stroke moves
    // the composite split to this layer, which is what moves the layers above it
    // off viewCanvas and onto upperLayersCanvas — i.e. above the preview surface.
    // The background preview relies on that having happened; it does not request
    // a composite of its own thereafter.
    this.board.requestUpdate();

    this.refreshPreview(user);
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   */
  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.appendBufferedPoint(user, pos);
    this.refreshPreview(user);
    this.lastPos.set(this._getUserId(user), { x: pos.x, y: pos.y });
  }

  /**
   * Repaint this user's eraser preview from the accumulated mask.
   *
   * The mask is cumulative but the dirty rect only covers what was stamped
   * since the last preview, so the clear MUST be scoped to that same rect —
   * wiping the whole preview surface and then blitting one segment back leaves
   * only the newest segment visible, which reads as a blocky, flickering
   * stroke that keeps losing the part already erased. Local and remote strokes
   * share this for exactly that reason.
   *
   * @param {Object} user - The erasing user.
   * @returns {boolean} False when nothing new has been stamped since the last
   *   preview, in which case the existing preview is left untouched.
   */
  refreshPreview(user) {
    const rect = this.getPreviewDirtyRect(user);
    if (rect === false) return false;
    this._clearPreview(user, rect);
    this.drawPreview(user, rect, this._getPreviewContext(user));
    return true;
  }

  onPointerMoveNoRender(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.appendBufferedPoint(user, pos);
    this.lastPos.set(this._getUserId(user), { x: pos.x, y: pos.y });
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   */
  onPointerUp(user) {
    const userId = this._getUserId(user);
    const lastPos = this.lastPos.get(userId);
    if (user?.currentLine?.length === 0 && lastPos) {
      this.appendBufferedPoint(user, lastPos, user.pressure, user.size, user.opacity);
    }
    this.commitCurrentLine(user, user.pressure, user.size, user.opacity, false);

    // Drop the transient preview stroke now that the erase has committed to the
    // active stroke, so the composite doesn't double-apply it for a frame.
    this.board.layerManager?.clearUserPreviewStroke?.(userId);

    const erasedTiles = this.collectErasedTiles(user);

    if (this._shouldEraseAllLayers(user)) {
      this.board.endStrokeAllLayers(user);
    } else {
      this.board.endStroke(user);
    }

    if (erasedTiles.size > 0) {
      this.board.compositeAllLayers();
      this.board.checkErasedTilesByIndices(erasedTiles);
    }

    this.lastPos.delete(userId);
    user.clearLine();
    this._clearStrokeState(user);

    this._clearPreview(user);
    this._setPreviewSurfaceVisible(user, true);
  }

  appendBufferedPoint(user, pos, pressure = user.pressure, size = user.size, opacity = user.opacity) {
    if (!user) return;
    const point = this._createBufferedPoint(pos.x, pos.y, pressure, size, opacity);
    if (point.size <= 0 || point.opacity <= 0) return;

    user.addToLine(point);
    const state = this._ensureStrokeState(user);
    this._stampPoint(user, state, point);
    this._eraseOverlayTextHits(point, user);
  }

  /**
   * If this eraser stamp covers any active SVG text records, fade them out —
   * and, only when WE are the one erasing, broadcast the removal so other
   * clients drop the SVG node too.
   *
   * This path also runs for remote strokes (RemoteUserHandler drives
   * appendBufferedPoint), so broadcasting unconditionally meant every client in
   * the room independently announced the same removal: N clients erasing over
   * one text produced N TEXT_REMOVE broadcasts instead of one. Beyond the
   * duplicate traffic that made those clients *look busy to the server* —
   * TEXT_REMOVE counts as deliberate user activity — so a room where anyone
   * erased over text could never let anybody go AFK.
   */
  _eraseOverlayTextHits(point, user) {
    const overlay = this.board?.textOverlay;
    if (!overlay || overlay.records.size === 0) return;
    const radius = Math.max(1, point.size / 2);
    const hits = overlay.hitTestCircle(point.x, point.y, radius);
    const isLocal = this._isLocalUser(user);
    for (const r of hits) {
      if (isLocal) overlay.eraseRemove(r.id);
      else overlay.removeRemote(r.id);   // the author already told everyone
    }
  }

  drawPreview(user, rect = null, ctx = this.board.topCtx) {
    if (rect?.drawImage) {
      ctx = rect;
      rect = null;
    }

    if (!ctx || !user?.currentLine?.length) return;
    const state = this._getStrokeState(user);
    if (!state || !this._hasDirtyBounds(state)) return;

    // Two ways to show an in-progress erase, off the SAME mask pixels:
    //
    //  - background preview: show the mask on the preview surface as-is. It is
    //    already stamped in the background colour, so it reads as an erase, and
    //    it costs one blit and nothing else — no publish into the layer stack,
    //    no composite. This is the brush's cost profile.
    //  - destination-out preview: hide the preview surface, publish the mask
    //    into the layer composite as a per-user destination-out stroke, and
    //    composite every frame. Correct everywhere, and ~8.7 ms/frame on a weak
    //    client because the main canvas gets touched on every tick.
    //
    // _canUseBackgroundPreview decides, and is re-checked every tick: a remote
    // user can put content on a lower layer mid-stroke and invalidate it. Both
    // paths render the same mask, so switching between them mid-stroke needs
    // nothing more than toggling the surface's visibility.
    const useBackgroundPreview = this._canUseBackgroundPreview(user);
    if (useBackgroundPreview) this._syncMaskFillStyle(state);

    this.board.withSelectionMaskClip(ctx, user.id, () => {
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = state.opacity ?? 1;

      this._renderPreviewPath(ctx, state, rect);

      this.board.forEachMirrorRegion({ rect: this._boundsToRect(state.dirtyBounds) }, (region) => {
        this.board.drawMirroredCanvas(ctx, state.maskCanvas, region, 0, 0);
      });

      ctx.globalAlpha = prevAlpha;
    });

    if (useBackgroundPreview) {
      // Nothing else to do: the surface IS the preview. Drop any preview stroke
      // a previous tick published on the other path, which also asks for the
      // one composite needed to retire it.
      this._setPreviewSurfaceVisible(user, true);
      this.board.layerManager?.clearUserPreviewStroke?.(this._getUserId(user));
      state.previewDirtyBounds = null;
      return;
    }

    // Publish the per-user preview into the layer composite as a transient
    // destination-out preview stroke. Each user gets their own preview entry
    // (activePreviewByUser), so simultaneous erasers no longer fight over a
    // single shared flatten pass — which caused both previews to flicker.
    this._publishPreviewStroke(user, ctx, rect);

    state.previewDirtyBounds = null;
    // On this path the preview surface is only a SOURCE for the destination-out
    // stroke published above; the visible erase is composited into the main
    // canvas. Keep it hidden so it isn't also painted on top — a full
    // clearTop(null) (e.g. when mirror regions force a null preview rect) resets
    // its opacity and would otherwise double the erase strength in the preview
    // versus the committed result.
    this._setPreviewSurfaceVisible(user, false);
    this.board.requestUpdate();
  }

  commitCurrentLine(user, newPressure = user.pressure, newSize = user.size, newOpacity = user.opacity, continueStroke = true) {
    if (!user?.currentLine?.length) return false;
    const state = this._getStrokeState(user);
    if (!state || !this._hasDirtyBounds(state)) return false;

    if (user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    const bufferedPoints = user.currentLine.map((point) => ({ ...point }));
    const committed = this._commitBufferedPath(user, bufferedPoints, state);
    const lastPoint = bufferedPoints[bufferedPoints.length - 1];

    user.clearLine();
    this._clearStrokeState(user);
    if (continueStroke && lastPoint) {
      this.appendBufferedPoint(user, { x: lastPoint.x, y: lastPoint.y }, newPressure, newSize, newOpacity);
    }

    if (committed) {
      this.board.requestUpdate();
    }

    return committed;
  }

  collectErasedTiles(user) {
    const erasedTiles = new Set();
    const lm = this.board.layerManager;
    if (!lm || !user) return erasedTiles;

    if (this._shouldEraseAllLayers(user)) {
      const count = lm.getLayerCount();
      for (let i = 0; i < count; i++) {
        const active = lm.getLayerGroup(i)?.activeStrokeByUser?.get(user.id);
        if (active?.affectedTiles) {
          for (const idx of active.affectedTiles) erasedTiles.add(idx);
        }
      }
      return erasedTiles;
    }

    const group = lm.getLayerGroup(this._getStrokeLayer(user));
    const active = group?.activeStrokeByUser?.get(user.id);
    if (active?.affectedTiles) {
      for (const idx of active.affectedTiles) erasedTiles.add(idx);
    }
    return erasedTiles;
  }

  _beginStroke(user, pos = null) {
    if (!this.board.layerManager || user?.panning) return;

    if (this._shouldEraseAllLayers(user)) {
      const count = this.board.layerManager.getLayerCount();
      for (let i = 0; i < count; i++) {
        this.board.layerManager.beginUserStroke(i, user.id, 'destination-out');
        this.board.applySelectionMaskClipForStroke(i, user.id);
      }
      return;
    }

    const bounds = (this._canWindowActiveStroke(user) && pos) ? this._seedWindowBounds(user, pos) : null;
    const strokeLayer = this._getStrokeLayer(user);
    this.board.layerManager.beginUserStroke(strokeLayer, user.id, 'destination-out', undefined, bounds);
    this.board.applySelectionMaskClipForStroke(strokeLayer, user.id);
  }

  /**
   * Whether this user's eraser gesture may use a windowed (non-full-board)
   * LayerManager active-stroke canvas instead of a full-board one — see
   * docs/scope_layermanager_active_stroke_windowing_RESULT.md, extended per
   * docs/scope_eraser_active_stroke_windowing.md. Reuses the SAME mechanism
   * brush already proved out (`bounds` param, `_growActiveStrokeWindow`,
   * `Board.applySelectionMaskClipForStroke`'s origin-aware clip + reapply
   * hook, `commitUserStroke`'s origin-aware crop, `_bakeStrokeToBin`'s
   * generic `stroke.x/y` reads for BOTH the flatCanvas layer and the
   * bakedSequences bins) — none of that is eraser-specific, so eraser
   * doesn't need its own version of any of it.
   *
   * Excluded: erase-all-layers, which drives N simultaneous active strokes
   * (one per group) off one shared board region — windowing that well needs
   * its own design, out of scope here (matches brush's own first-pass
   * mirror-region caution: land the common single-layer case first).
   * @private
   * @param {Object} user
   * @returns {boolean}
   */
  _canWindowActiveStroke(user) {
    return !this._shouldEraseAllLayers(user);
  }

  /**
   * Board-absolute bounds hint for `beginUserStroke` at the very start of a
   * gesture, before any stamp has been made — seeded from the down point
   * plus its stamp radius (mirroring brush's `_expandPreviewBounds` seed at
   * MD), folded with any active mirror regions.
   * @private
   */
  _seedWindowBounds(user, pos) {
    const radius = Math.max(0.5, (user.pressure ?? 1) * (user.size ?? this.userSize));
    return this._foldMirrorBounds(pos.x - radius, pos.y - radius, pos.x + radius, pos.y + radius);
  }

  /**
   * Board-absolute bounds hint for growing an already-windowed active stroke
   * at commit time, derived from `state.dirtyBounds` — the region stamped
   * since the last commit (mirrors RemoteUserHandler's
   * `_activeStrokeWindowBounds`, which reads the analogous
   * `user._previewDirtyBounds`).
   * @private
   */
  _commitWindowBounds(state) {
    const b = state?.dirtyBounds;
    if (!b || !Number.isFinite(b.minX) || !Number.isFinite(b.maxX) || b.maxX < b.minX || b.maxY < b.minY) {
      return null;
    }
    return this._foldMirrorBounds(b.minX, b.minY, b.maxX, b.maxY);
  }

  /**
   * Expand a board-absolute box to also cover every active mirror region's
   * transformed copy — a single bounding box around every copy, not a rect
   * list (see mirror_preview_rect_list memory), matching brush's own
   * windowing scope exactly.
   * @private
   */
  _foldMirrorBounds(minX, minY, maxX, maxY) {
    const regions = this.board.getActiveMirrorRegions?.() || [];
    if (regions.length) {
      const corners = [
        { x: minX, y: minY }, { x: maxX, y: minY },
        { x: minX, y: maxY }, { x: maxX, y: maxY }
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

  _commitBufferedPath(user, points, state) {
    if (!points || points.length === 0 || !state || !this._hasDirtyBounds(state)) return false;

    let committed = false;
    const groupIndices = this._getTargetGroupIndices(user);
    if (groupIndices.length === 0) return false;
    const opacity = state.opacity ?? points[0]?.opacity ?? 1;
    if (opacity <= 0) return false;

    const windowBounds = this._canWindowActiveStroke(user) ? this._commitWindowBounds(state) : null;

    for (const groupIdx of groupIndices) {
      const group = this.board.layerManager.getLayerGroup(groupIdx);
      if (!group) continue;
      this.eraseMaskOnGroup(groupIdx, group, state, opacity, user.id, null, windowBounds);
      this.board.forEachMirrorRegion({ rect: this._boundsToRect(state.dirtyBounds) }, (region) => {
        this.eraseMaskOnGroup(groupIdx, group, state, opacity, user.id, region, windowBounds);
      });
      committed = true;
    }

    if (committed) {
      this._markDirtyBounds(user, state.dirtyBounds);
      const maxRadius = Math.max(0.5, state.maxRadius ?? 0);
      if (maxRadius > 0 && points.length > 0) {
        this._markDirtyPath(user, points, maxRadius);
      }
    }

    return committed;
  }

  _getTargetGroups(user) {
    if (!this.board.layerManager) return [];

    if (this._shouldEraseAllLayers(user)) {
      const groups = [];
      const count = this.board.layerManager.getLayerCount();
      for (let i = 0; i < count; i++) {
        const group = this.board.layerManager.getLayerGroup(i);
        if (group) groups.push(group);
      }
      return groups;
    }

    const group = this.board.layerManager.getLayerGroup(this._getStrokeLayer(user));
    return group ? [group] : [];
  }

  /**
   * Same targeting as `_getTargetGroups`, but returns group indices — needed
   * by the windowing path, which must call `LayerManager.getUserStrokeContext`
   * (to grow an already-windowed active canvas) rather than read
   * `group.activeStrokeByUser` directly, and that call takes a groupIdx, not
   * a group object.
   * @private
   */
  _getTargetGroupIndices(user) {
    if (!this.board.layerManager) return [];

    if (this._shouldEraseAllLayers(user)) {
      const count = this.board.layerManager.getLayerCount();
      const indices = [];
      for (let i = 0; i < count; i++) indices.push(i);
      return indices;
    }

    return [this._getStrokeLayer(user)];
  }

  _getStrokeLayer(user) {
    return user?._strokeLayer ?? user?.activeLayer ?? 0;
  }

  _shouldEraseAllLayers(user) {
    return user?.eraseAllLayers ?? this._eraseAllLayers();
  }

  _createBufferedPoint(x, y, pressure, size, opacity) {
    return {
      x,
      y,
      size: Math.max(0, pressure * size * 2),
      opacity: opacity !== undefined ? opacity : 1
    };
  }

  /**
   * Blit the accumulated eraser mask onto a preview surface. The caller owns
   * `ctx.globalAlpha` (set to the stroke opacity) and any clipping.
   * @param {CanvasRenderingContext2D} ctx - Preview context.
   * @param {Object} state - Per-user eraser stroke state.
   * @param {{x:number,y:number,width:number,height:number}|null} [rect=null] - Dirty region; null redraws the whole board.
   * @private
   */
  _renderPreviewPath(ctx, state, rect = null) {
    const sourceRect = rect ? clampRectToCanvas(rect, state.maskCanvas) : null;
    if (sourceRect) {
      ctx.drawImage(
        state.maskCanvas,
        sourceRect.x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height,
        sourceRect.x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height
      );
    } else {
      ctx.drawImage(state.maskCanvas, 0, 0);
    }
  }

  /**
   * Register the current eraser preview as a per-user, transient destination-out
   * preview stroke so the layer compositor renders it alongside every other
   * user's preview. Erase-all-layers still uses the flattened global preview
   * path (Board._findActiveEraserPreview), so it is skipped here.
   * @param {Object} user - The erasing user.
   * @param {CanvasRenderingContext2D} ctx - The per-user preview context (its
   *   canvas already holds the direct stroke plus any mirror reflections).
   * @param {{x:number,y:number,width:number,height:number}|null} rect - Dirty region.
   * @private
   */
  _publishPreviewStroke(user, ctx, rect) {
    const lm = this.board.layerManager;
    if (!lm || !ctx?.canvas) return;
    if (this._shouldEraseAllLayers(user)) return;

    // The local path passes the expanded composite rect; the remote path calls
    // drawPreview without one, so fall back to this stroke's pending preview
    // bounds to avoid a full-board copy/composite every frame.
    let dirtyRect = rect && Number.isFinite(rect.x) ? rect : null;
    if (!dirtyRect && !this.board.hasMirrors?.()) {
      const state = this._getStrokeState(user);
      if (state?.previewDirtyBounds) dirtyRect = this._expandBoundsForComposite(state.previewDirtyBounds);
    }
    lm.setUserPreviewStroke(this._getStrokeLayer(user), this._getUserId(user), ctx.canvas, 'destination-out', dirtyRect);

    if (dirtyRect && dirtyRect.width > 0 && dirtyRect.height > 0) {
      this.board.compositeTileGrid?.markRect(dirtyRect.x, dirtyRect.y, dirtyRect.width, dirtyRect.height);
    } else {
      this.board.markCompositeFull?.();
    }
  }

  _setPreviewMaskVisible(visible) {
    if (!this.board?.topCanvas) return;
    this.board.topCanvas.style.opacity = visible ? '' : '0';
  }

  /**
   * Show or hide the surface this user's preview is drawn on. The local user
   * draws onto topCanvas; every remote user has their own `.userBoard`, which
   * RemoteUserHandler otherwise hides for the whole of an erase gesture.
   * @param {Object} user - The erasing user.
   * @param {boolean} visible
   * @private
   */
  _setPreviewSurfaceVisible(user, visible) {
    if (this._isLocalUser(user)) {
      this._setPreviewMaskVisible(visible);
      return;
    }
    if (user?.board) user.board.style.opacity = visible ? '' : '0';
  }

  _getUserId(user) {
    return user?.id ?? this.board.app?.self?.id ?? 0;
  }

  _isLocalUser(user) {
    return user === this.board.app?.self || user?.id === this.board.app?.sessionIndex;
  }

  _getPreviewContext(user) {
    return this._isLocalUser(user) ? this.board.topCtx : user?.context;
  }

  _clearPreview(user, rect = null) {
    if (this._isLocalUser(user)) {
      this.board.clearTop(rect);
      return;
    }

    const ctx = user?.context;
    if (!ctx) return;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0) {
      ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
    } else {
      ctx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
  }

  /**
   * Draw an eraser path into a user's active stroke group.
   * @param {number} groupIdx - Index of the layer group (needed to grow an
   *   already-windowed active canvas via `getUserStrokeContext`).
   * @param {Object} group - The layer group.
   * @param {Object} state - Per-user eraser state (buffered points, size, last position).
   * @param {number} opacity - Eraser opacity.
   * @param {string} userId - ID of the user erasing.
   * @param {Object|null} [mirrorRegion=null] - Mirror region to reflect the stroke into, if any.
   * @param {{x:number,y:number,width:number,height:number}|null} [bounds=null] -
   *   Windowing bounds hint, same contract as `LayerManager.getUserStrokeContext`.
   *   Only meaningful (and only passed) when the caller has already gated via
   *   `_canWindowActiveStroke`; null takes today's unwindowed direct-lookup path.
   */
  eraseMaskOnGroup(groupIdx, group, state, opacity, userId, mirrorRegion = null, bounds = null) {
    const lm = this.board.layerManager;
    const ctx = bounds
      ? lm?.getUserStrokeContext(groupIdx, userId, undefined, undefined, bounds)
      : group.activeStrokeByUser?.get(userId)?.ctx;
    if (!ctx) return;

    const active = lm?.getActiveStroke(groupIdx, userId);
    if (active) active.opacity = opacity;
    // state.maskCanvas is always full-board (board-local (0,0) == board
    // (0,0)); when the active canvas is windowed, its own local (0,0) is
    // offset by active.origin, so every draw below needs the ctx translated
    // to compensate — same fix shape as RemoteUserHandler.commitLine's brush
    // path, see docs/scope_layermanager_active_stroke_windowing_RESULT.md.
    const ox = active?.origin?.x ?? 0;
    const oy = active?.origin?.y ?? 0;

    ctx.save();
    if (ox || oy) ctx.translate(-ox, -oy);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = opacity;
    if (mirrorRegion) {
      this.board.drawMirroredCanvas(ctx, state.maskCanvas, mirrorRegion, 0, 0);
    } else {
      ctx.drawImage(state.maskCanvas, 0, 0);
    }
    ctx.restore();
  }

  _ensureStrokeState(user) {
    const width = this.board.getWidth();
    const height = this.board.getHeight();

    if (!user._eraserStrokeState) {
      user._eraserStrokeState = this._createStrokeState(width, height);
    }

    const state = user._eraserStrokeState;
    if (state.maskCanvas.width !== width || state.maskCanvas.height !== height) {
      user._eraserStrokeState = this._createStrokeState(width, height);
      return user._eraserStrokeState;
    }

    return state;
  }

  _createStrokeState(width, height) {
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;

    return {
      maskCanvas,
      maskCtx: maskCanvas.getContext('2d'),
      lastStampPos: null,
      dirtyBounds: null,
      previewDirtyBounds: null,
      maxRadius: 0,
      opacity: 1,
      fillStyle: null
    };
  }

  _getStrokeState(user) {
    return user?._eraserStrokeState ?? null;
  }

  _resetStrokeState(user) {
    const state = this._ensureStrokeState(user);
    state.maskCtx.clearRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
    state.lastStampPos = null;
    state.dirtyBounds = null;
    state.previewDirtyBounds = null;
    state.maxRadius = 0;
    state.opacity = user?.opacity ?? 1;
    state.fillStyle = this._backgroundFillStyle();
  }

  /**
   * Keep the mask's tint matching the board background, which another user can
   * change mid-stroke. Only the already-stamped pixels are stale, so one
   * `source-in` re-fill fixes them; new stamps pick the colour up on their own.
   * @param {Object} state - Per-user eraser stroke state.
   * @private
   */
  _syncMaskFillStyle(state) {
    const fill = this._backgroundFillStyle();
    if (state.fillStyle === fill) return;
    state.fillStyle = fill;
    const ctx = state.maskCtx;
    ctx.save();
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
    ctx.restore();
  }

  /**
   * Whether this stroke's preview can be drawn as a plain background-coloured
   * stroke on the preview surface, instead of being published into the layer
   * stack as a `destination-out` preview and composited every frame.
   *
   * The two are pixel-identical when an erase on this layer reveals nothing but
   * the background. For an opaque destination pixel D over background B with
   * eraser alpha a, `destination-out` leaves alpha 1-a and composites to
   * `D(1-a) + Ba`; painting B over D at globalAlpha a gives `Ba + D(1-a)`. Same
   * result, for every a — so this is exact where it applies, not an
   * approximation.
   *
   * It applies when:
   *  - no layer BELOW this one can paint, or an erase would reveal that layer's
   *    pixels rather than the background. Vacuously true on the bottom layer,
   *    which is where most boards do all their work.
   *  - the background is opaque, or an erase reveals transparency, not a colour.
   *  - the preview surface is directly above this layer in the paint order.
   *    Content ABOVE needs no check: upperLayersCanvas paints over the preview
   *    surfaces already, exactly as it does for brush strokes.
   *  - this is a single-layer erase; erase-all-layers reveals the background
   *    everywhere and has its own flattened preview path.
   * @param {Object} user - The erasing user.
   * @returns {boolean}
   * @private
   */
  _canUseBackgroundPreview(user) {
    if (this._shouldEraseAllLayers(user)) return false;
    const lm = this.board.layerManager;
    if (!lm?.rangeHasRenderableContent) return false;

    const bg = this.board.getCompositeBackgroundColor?.() ?? this.board.backgroundColor;
    if (!bg || (bg[3] ?? 1) < 1) return false;

    const strokeLayer = this._getStrokeLayer(user);
    if (!this.board.previewSurfaceSitsAboveLayer?.(strokeLayer)) return false;
    if (lm.rangeHasRenderableContent(0, strokeLayer)) return false;

    return true;
  }

  _clearStrokeState(user) {
    const state = this._getStrokeState(user);
    if (!state) return;
    state.maskCtx.clearRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
    state.lastStampPos = null;
    state.dirtyBounds = null;
    state.previewDirtyBounds = null;
    state.maxRadius = 0;
  }

  _stampPoint(user, state, point) {
    const radius = Math.max(0.5, point.size / 2);
    state.opacity = point.opacity;

    if (!state.lastStampPos) {
      this._stampCircle(state, point.x, point.y, radius, user?.id);
      state.lastStampPos = { x: point.x, y: point.y, radius };
      state.maxRadius = Math.max(state.maxRadius, radius);
      return;
    }

    const distance = this._getDistance(state.lastStampPos, point);
    const avgRadius = (state.lastStampPos.radius + radius) / 2;
    const spacing = Math.max(0.75, avgRadius * 0.2);
    const steps = Math.max(1, Math.ceil(distance / spacing));

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = state.lastStampPos.x + (point.x - state.lastStampPos.x) * t;
      const y = state.lastStampPos.y + (point.y - state.lastStampPos.y) * t;
      const r = state.lastStampPos.radius + (radius - state.lastStampPos.radius) * t;
      this._stampCircle(state, x, y, r, user?.id);
      state.maxRadius = Math.max(state.maxRadius, r);
    }

    state.lastStampPos = { x: point.x, y: point.y, radius };
  }

  /**
   * The mask is stamped in the board's background colour rather than white.
   *
   * Nothing downstream reads the mask's RGB — every consumer draws it with
   * `destination-out`, which uses source alpha only — so the choice is free. It
   * buys the background-colour preview path: when an erase on this layer would
   * reveal nothing but the background, the same mask can be shown directly on
   * the preview surface and *is* the finished preview, with no destination-out
   * publish and no per-frame composite behind it.
   * @returns {string}
   * @private
   */
  _backgroundFillStyle() {
    const [r, g, b] = this.board.getCompositeBackgroundColor?.() ?? this.board.backgroundColor ?? [255, 255, 255];
    return `rgb(${r}, ${g}, ${b})`;
  }

  _stampCircle(state, x, y, radius, userId = null) {
    const ctx = state.maskCtx;
    ctx.save();
    if (userId != null) {
      this.board._applyMaskClipToCtx?.(ctx, userId);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = state.fillStyle || 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    this._expandBounds(state, x - radius, y - radius, x + radius, y + radius);
  }

  _expandBounds(state, minX, minY, maxX, maxY) {
    this._expandPreviewDirtyBounds(state, minX, minY, maxX, maxY);

    if (!state.dirtyBounds) {
      state.dirtyBounds = { minX, minY, maxX, maxY };
      return;
    }

    state.dirtyBounds.minX = Math.min(state.dirtyBounds.minX, minX);
    state.dirtyBounds.minY = Math.min(state.dirtyBounds.minY, minY);
    state.dirtyBounds.maxX = Math.max(state.dirtyBounds.maxX, maxX);
    state.dirtyBounds.maxY = Math.max(state.dirtyBounds.maxY, maxY);
  }

  _expandPreviewDirtyBounds(state, minX, minY, maxX, maxY) {
    if (!state) return;
    if (!state.previewDirtyBounds) {
      state.previewDirtyBounds = { minX, minY, maxX, maxY };
      return;
    }

    state.previewDirtyBounds.minX = Math.min(state.previewDirtyBounds.minX, minX);
    state.previewDirtyBounds.minY = Math.min(state.previewDirtyBounds.minY, minY);
    state.previewDirtyBounds.maxX = Math.max(state.previewDirtyBounds.maxX, maxX);
    state.previewDirtyBounds.maxY = Math.max(state.previewDirtyBounds.maxY, maxY);
  }

  getPreviewDirtyRect(user) {
    const state = this._getStrokeState(user);
    if (!state?.previewDirtyBounds) return false;
    // A partial preview rect must cover the mirrored copies too, and they are
    // nowhere near the stroke. `hasMirrors()` — NOT `mirrorRegions.length`: that
    // missed the full-board mirror entirely, so with it on the live preview was
    // clipped to a bbox around the unmirrored stroke and the reflected half only
    // appeared at mouse-up (the commit path does not use this rect). null = redraw all.
    if (this.board.hasMirrors?.()) return null;
    return this._expandBoundsForComposite(state.previewDirtyBounds) ?? false;
  }

  _markDirtyBounds(user, bounds) {
    if (!bounds) return;
    const expanded = this._expandBoundsForComposite(bounds);
    this._expandActiveDirtyRect(user, expanded);
    this.board.compositeTileGrid?.markRect(expanded.x, expanded.y, expanded.width, expanded.height);

    this.board.forEachMirrorRegion({ rect: expanded }, (region) => {
      const mirrored = this._mirrorRect(expanded, region);
      this._expandActiveDirtyRect(user, mirrored);
      this.board.compositeTileGrid?.markRect(mirrored.x, mirrored.y, mirrored.width, mirrored.height);
    });
  }

  _markDirtyPath(user, points, radius) {
    if (!points?.length || radius <= 0) return;

    const targetGroups = this._getTargetGroups(user);
    for (const group of targetGroups) {
      const active = group?.activeStrokeByUser?.get(user.id);
      if (active?.affectedTiles && this.board.tileTracker) {
        this.board.tileTracker.collectTilesFromPath(points, radius, active.affectedTiles);
      }
    }
  }

  _expandActiveDirtyRect(user, rect) {
    const count = this.board.layerManager?.getLayerCount?.() ?? 0;
    const userId = user?.id;
    const applyRect = (group) => {
      const active = group?.activeStrokeByUser?.get(userId);
      if (!active?.dirtyRect) return;
      this.board.layerManager._expandDirtyRect(active.dirtyRect, rect.x, rect.y, rect.width, rect.height);
    };

    if (this._shouldEraseAllLayers(user)) {
      for (let i = 0; i < count; i++) {
        applyRect(this.board.layerManager.getLayerGroup(i));
      }
      return;
    }

    applyRect(this.board.layerManager?.getLayerGroup(this._getStrokeLayer(user)));
  }

  _expandBoundsForComposite(bounds) {
    if (!bounds) return null;
    const margin = 2;
    const x = Math.floor(bounds.minX - margin);
    const y = Math.floor(bounds.minY - margin);
    const width = Math.ceil(bounds.maxX - bounds.minX + margin * 2);
    const height = Math.ceil(bounds.maxY - bounds.minY + margin * 2);
    return { x, y, width, height };
  }

  _mirrorRect(rect, region) {
    const corners = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x, y: rect.y + rect.height },
      { x: rect.x + rect.width, y: rect.y + rect.height }
    ];

    const mirrored = corners.map(p => this.board.mirrorPointToRegion(p, region));

    let minX = mirrored[0].x;
    let minY = mirrored[0].y;
    let maxX = mirrored[0].x;
    let maxY = mirrored[0].y;

    for (const p of mirrored) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.ceil(maxX - minX),
      height: Math.ceil(maxY - minY)
    };
  }

  _boundsToRect(bounds) {
    if (!bounds) return null;
    return {
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY
    };
  }

  _hasDirtyBounds(state) {
    return !!(state?.dirtyBounds && state.dirtyBounds.maxX > state.dirtyBounds.minX && state.dirtyBounds.maxY > state.dirtyBounds.minY);
  }

  _getDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
