/**
 * @fileoverview FloodFill tool for filling regions with color.
 * Supports an optional "Advanced" interactive mode where dragging after click
 * adjusts expansion (horizontal) and edge blur (vertical) before committing.
 *
 * Heavy computation (scanline fill, dilation, erosion) runs in a dedicated
 * Web Worker so the main thread stays responsive.
 */

import { blurImageData, getStackblurSync } from '../utils/blurUtils.js';
import { FillWorkerClient } from '../workers/FillWorkerClient.js';
import { getPatternTile, getPatternDrawScale } from '../utils/patternTile.js';

/**
 * Flood fill tool using optimized scanline algorithm via Web Worker.
 */
export class FloodFillTool {
  /**
   * @param {Object} board - Board instance
   */
  constructor(board) {
    this.name = 'fill';
    this.board = board;
    this._advancedMode = true;

    // Persistent values — maintained between fills, driven by sliders
    this._expansion = 0;
    this._blurRadius = 0;

    // Interactive state (used only in advanced mode)
    this._active = false;
    this._startPos = null;
    this._clickPos = null;
    this._dragStartExpansion = 0;
    this._dragStartBlur = 0;
    this._imageData = null;
    this._fillParams = null;

    // Tracks whether onPointerDown already committed the fill (standard mode)
    this._committed = false;

    // Worker for off-thread computation
    this._fillWorker = new FillWorkerClient();

    // Debounce timer for advanced mode preview updates
    this._previewTimer = null;
    this._pendingPreview = false;
    this._lastTooLargeToast = 0;

    // Pattern mode
    this.patternMode = false;
  }

  get advancedMode() { return this._advancedMode; }

  /**
   * Whether the interactive (drag-to-adjust) fill should be used right now.
   * Disabled while mirrors are active: the interactive preview recomputes a
   * flood fill for every mirror region on each drag frame (laggy) and its
   * multi-region commit does not undo cleanly. Falling back to a single-click
   * fill keeps mirrors working while committing one undoable stroke.
   * @private
   */
  _useAdvancedMode() {
    return this._advancedMode && !this.board.hasMirrors?.();
  }

  set advancedMode(val) {
    this._advancedMode = val;
    if (!val) {
      // Reset persistent fill settings when advanced mode is disabled
      this._expansion = 0;
      this._blurRadius = 0;
      this._updateSliders();
    }
  }

  /** Sync slider DOM elements to current persistent values. */
  _updateSliders() {
    const expSlider = document.getElementById('fillExpansionSlider');
    const expValue = document.getElementById('fillExpansionValue');
    const blurSlider = document.getElementById('fillBlurSlider');
    const blurValue = document.getElementById('fillBlurValue');
    if (expSlider) expSlider.value = this._expansion;
    if (expValue) expValue.textContent = this._expansion;
    if (blurSlider) blurSlider.value = this._blurRadius;
    if (blurValue) blurValue.textContent = this._blurRadius.toFixed(1);
  }

  activate() {
    // Preload stackblur so it's available synchronously for _renderMask
    blurImageData(new ImageData(1, 1), 1, 1, 1).catch(() => {});
  }

  deactivate() {
    if (this._active && this._fillParams) {
      // Finalize the current interactive fill before deactivating
      const user = this._fillParams.user || this.board.app?.self;
      if (user) {
        this.onPointerUp(user, this.board.lastMousePos || this._clickPos);
      }
    }
    this._cancelInteractive();
  }

  compactMemory(options = {}) {
    if (this._previewTimer) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
    this._pendingPreview = false;
    this._cancelInteractive();
    this._imageData = null;
    this._fillParams = null;
    this._startPos = null;
    this._clickPos = null;
    this._committed = false;

    if (options.recycleWorker && this._fillWorker) {
      this._fillWorker.destroy();
      this._fillWorker = new FillWorkerClient();
    }
  }

  // -- helpers --

  _getFillParams(user) {
    const fillColor = user?.color ?? this.board.app?.self?.color ?? [0, 0, 0, 1];
    const opacitySlider = user?.opacity !== undefined
      ? user.opacity
      : (this.board.app?.self?.opacity !== undefined ? this.board.app.self.opacity : 1);
    // Use only the opacity slider, not color alpha (avoids double application)
    const userOpacity = opacitySlider;
    return {
      fillR: Math.round(fillColor[0]),
      fillG: Math.round(fillColor[1]),
      fillB: Math.round(fillColor[2]),
      userOpacity,
      userId: user?.id ?? this.board.app?.self?.id ?? 0,
      activeLayer: user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0,
    };
  }

  /**
   * Get pattern tile for fill (reuses PatternTool's tile generation logic).
   * @private
   */
  _getPatternTile(user) {
    if (!this._patternTileCache) this._patternTileCache = new Map();
    return getPatternTile(user, this._patternTileCache);
  }

  /**
   * Maps horizontal drag distance to expansion with finer control near zero.
   * - Outside [-2, 2]: 0.3 expansion units per pixel
   * - Inside  [-2, 2]: 0.1 expansion units per pixel
   * This keeps precision where users need it most while retaining speed at larger offsets.
   * @private
   */
  _computeExpansionFromDrag(startExpansion, dx) {
    let current = Math.max(-50, Math.min(50, startExpansion));
    let remainingPx = Math.abs(dx);
    const direction = dx >= 0 ? 1 : -1;

    const advanceToBoundary = (boundary, unitsPerPx) => {
      if (remainingPx <= 0) return;

      const distanceToBoundary = direction > 0
        ? boundary - current
        : current - boundary;

      if (distanceToBoundary <= 0) return;

      const pxNeeded = distanceToBoundary / unitsPerPx;
      const pxUsed = Math.min(remainingPx, pxNeeded);
      current += direction * pxUsed * unitsPerPx;
      remainingPx -= pxUsed;
    };

    if (direction > 0) {
      if (current < -2) advanceToBoundary(-2, 0.3);
      if (current < 2) advanceToBoundary(2, 0.1);
      if (remainingPx > 0) current += remainingPx * 0.3;
    } else {
      if (current > 2) advanceToBoundary(2, 0.3);
      if (current > -2) advanceToBoundary(-2, 0.1);
      if (remainingPx > 0) current -= remainingPx * 0.3;
    }

    current = Math.max(-50, Math.min(50, current));
    return Math.round(current * 10) / 10;
  }

  /**
   * Render a mask to a target canvas context, optionally blurring edges.
   * Runs on main thread (needs canvas context).
   */
  _renderMask(ctx, result, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user = null, origin = null) {
    if (!result) return;
    const { mask, minX, minY, maxX, maxY } = result;

    // `ctx` may be a windowed active-stroke canvas whose local (0,0) sits at
    // board position `origin`. putImageData IGNORES the ctx transform, so the
    // `ctx.translate(-origin.x, -origin.y)` convention the rest of the
    // active-stroke windowing campaign uses cannot be applied here — the
    // offset has to be subtracted at each paint site instead.
    const ox = origin?.x ?? 0;
    const oy = origin?.y ?? 0;

    // If pattern mode is enabled and user has a pattern brush, use pattern fill.
    // Local fill mode is owned by the fill tool; remote/replay fill mode arrives
    // on the user state. Keep those separated because this tool instance is shared.
    const isLocalUser = user === this.board.app?.self;
    const usePatternFill = user?.patternBrush && (isLocalUser ? this.patternMode : user.patternMode);
    if (user && usePatternFill) {
      return this._renderMaskPattern(ctx, result, userOpacity, blurRadius, width, height, user, origin);
    }

    const a = Math.round(userOpacity * 255);

    if (blurRadius <= 0) {
      const regionW = maxX - minX + 1;
      const regionH = maxY - minY + 1;
      const imgData = new ImageData(regionW, regionH);
      const pixels = imgData.data;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          if (mask[py * width + px]) {
            const oi = ((py - minY) * regionW + (px - minX)) * 4;
            pixels[oi] = fillR;
            pixels[oi + 1] = fillG;
            pixels[oi + 2] = fillB;
            pixels[oi + 3] = a;
          }
        }
      }
      ctx.putImageData(imgData, minX - ox, minY - oy);
      return;
    }

    const br = Math.ceil(blurRadius);
    const padMinX = Math.max(0, minX - br * 3);
    const padMinY = Math.max(0, minY - br * 3);
    const padMaxX = Math.min(width - 1, maxX + br * 3);
    const padMaxY = Math.min(height - 1, maxY + br * 3);
    const padW = padMaxX - padMinX + 1;
    const padH = padMaxY - padMinY + 1;

    const padded = new ImageData(padW, padH);
    const pd = padded.data;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (mask[py * width + px]) {
          const oi = ((py - padMinY) * padW + (px - padMinX)) * 4;
          pd[oi + 3] = a;
        }
      }
    }

    const stackblur = getStackblurSync();
    if (stackblur) {
      for (let i = 0; i < pd.length; i += 4) {
        pd[i] = pd[i + 1] = pd[i + 2] = pd[i + 3];
      }
      stackblur(pd, padW, padH, br);
      for (let i = 0; i < pd.length; i += 4) {
        if (pd[i + 3] > 0) {
          pd[i] = fillR;
          pd[i + 1] = fillG;
          pd[i + 2] = fillB;
        } else {
          pd[i] = pd[i + 1] = pd[i + 2] = 0;
        }
      }
      ctx.putImageData(padded, padMinX - ox, padMinY - oy);
    } else {
      // CSS fallback: Do NOT manually premultiply - canvas handles it internally
      // Manual premultiplication + putImageData causes double premultiplication
      const tmp = document.createElement('canvas');
      tmp.width = padW;
      tmp.height = padH;
      tmp.getContext('2d').putImageData(padded, 0, 0);

      ctx.save();
      ctx.filter = `blur(${blurRadius}px)`;
      ctx.drawImage(tmp, padMinX - ox, padMinY - oy);
      ctx.restore();
    }
  }

  /**
   * Render a mask with pattern fill instead of solid color.
   * Works like pattern brush: black fill acts as mask over pattern.
   * @private
   */
  _renderMaskPattern(ctx, result, userOpacity, blurRadius, width, height, user, origin = null) {
    const { mask, minX, minY, maxX, maxY } = result;

    const tile = this._getPatternTile(user);
    if (!tile) {
      // Fallback to solid color if no pattern
      const [r, g, b] = user.color;
      return this._renderMask(ctx, result, r, g, b, userOpacity, blurRadius, width, height, null, origin);
    }

    const scale = getPatternDrawScale(user, tile);
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;
    const rotation = user.patternRotation || 0;

    const br = blurRadius > 0 ? Math.ceil(blurRadius) : 0;
    const padMinX = Math.max(0, minX - br * 3);
    const padMinY = Math.max(0, minY - br * 3);
    const padMaxX = Math.min(width - 1, maxX + br * 3);
    const padMaxY = Math.min(height - 1, maxY + br * 3);
    const padW = padMaxX - padMinX + 1;
    const padH = padMaxY - padMinY + 1;

    // Create temp canvas for the mask
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = padW;
    tmpCanvas.height = padH;
    const tmpCtx = tmpCanvas.getContext('2d');

    // Step 1: Render black mask (using regular render with black)
    const regionW = maxX - minX + 1;
    const regionH = maxY - minY + 1;
    const imgData = new ImageData(regionW, regionH);
    const pixels = imgData.data;

    // Fill mask pixels as black
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (mask[py * width + px]) {
          const oi = ((py - minY) * regionW + (px - minX)) * 4;
          pixels[oi] = 0;     // R
          pixels[oi + 1] = 0; // G
          pixels[oi + 2] = 0; // B
          pixels[oi + 3] = 255; // A (full opacity for mask)
        }
      }
    }

    tmpCtx.putImageData(imgData, minX - padMinX, minY - padMinY);

    // Apply blur to mask if needed
    if (blurRadius > 0) {
      const blurCanvas = document.createElement('canvas');
      blurCanvas.width = padW;
      blurCanvas.height = padH;
      const blurCtx = blurCanvas.getContext('2d');
      blurCtx.filter = `blur(${blurRadius}px)`;
      blurCtx.drawImage(tmpCanvas, 0, 0);
      tmpCtx.clearRect(0, 0, padW, padH);
      tmpCtx.drawImage(blurCanvas, 0, 0);
    }

    // Step 2: Fill with pattern
    const pattern = tmpCtx.createPattern(tile, 'repeat');
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX - padMinX, offsetY - padMinY)
        .rotate(rotation)
        .scale(scale);
      pattern.setTransform(matrix);
    }

    tmpCtx.globalCompositeOperation = 'source-in';
    tmpCtx.globalAlpha = userOpacity;
    tmpCtx.fillStyle = pattern;
    tmpCtx.fillRect(0, 0, padW, padH);

    // Step 3: Draw result to target context
    ctx.drawImage(tmpCanvas, padMinX - (origin?.x ?? 0), padMinY - (origin?.y ?? 0));
  }

  /**
   * The board-absolute box a rendered mask can actually paint into: its own
   * bounding box grown by the blur's reach — the same `br * 3` padding
   * `_renderMask`/`_renderMaskPattern` compute internally — clamped to the board.
   * @private
   */
  _paddedMaskRect(result, blurRadius, width, height) {
    const br = blurRadius > 0 ? Math.ceil(blurRadius) : 0;
    const x = Math.max(0, result.minX - br * 3);
    const y = Math.max(0, result.minY - br * 3);
    const right = Math.min(width - 1, result.maxX + br * 3);
    const bottom = Math.min(height - 1, result.maxY + br * 3);
    return { x, y, width: right - x + 1, height: bottom - y + 1 };
  }

  /**
   * Render a mask through a temp canvas so it composites onto `targetCtx` as a
   * single unit — the mirror copies need this so their alpha does not stack
   * against the primary fill where they overlap.
   *
   * The temp is sized to the mask's own padded bounds, not the full board.
   *
   * Only `drawImage` touches `targetCtx` here, and that DOES go through the
   * CTM, so a windowed target may either pass `origin` or pre-translate —
   * but not both.
   *
   * @param {{x:number,y:number}|null} [origin] - Board position of a windowed
   *   target canvas's local (0,0).
   */
  _renderMaskComposite(targetCtx, result, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user = null, origin = null) {
    if (!result) return;
    const rect = this._paddedMaskRect(result, blurRadius, width, height);
    const tmp = document.createElement('canvas');
    tmp.width = rect.width;
    tmp.height = rect.height;
    this._renderMask(tmp.getContext('2d'), result, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user, rect);
    targetCtx.drawImage(tmp, rect.x - (origin?.x ?? 0), rect.y - (origin?.y ?? 0));
  }

  _broadcastFill(user, x, y, layerIndex, expansion, blurRadius) {
    const wsClient = this.board.app?.wsClient;
    if (wsClient && user === this.board.app?.self) {
      this.board.app.inputBufferManager.queueBroadcast(() => wsClient.broadcastFill(x, y, layerIndex, expansion, blurRadius));
    }
  }

  _cancelInteractive() {
    if (this._active) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    this._clearPreviewLayer();
    if (this._previewTimer !== null) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
    this._fillWorker.invalidate();
    this._active = false;
    this._imageData = null;
    this._fillParams = null;
    this._pendingPreview = false;
  }

  _setPreviewLayer(layerIndex) {
    this.board.activeFillPreviewLayer = layerIndex;
    this.board.markCompositeFull?.();
    this.board.requestUpdate?.();
  }

  _clearPreviewLayer() {
    if (this.board.activeFillPreviewLayer < 0) return;
    this.board.activeFillPreviewLayer = -1;
    this.board.markCompositeFull?.();
    this.board.requestUpdate?.();
  }

  /**
   * The mask is a full-board Uint8Array, but everything set in it lies inside
   * the bounding box the worker already reported, so only that box is scanned.
   * This runs once per fill and again on every interactive preview frame.
   * @private
   */
  _countFilledPixels(result, width) {
    if (!result?.mask) return 0;
    const stride = result.width ?? width;
    if (!stride) return 0;
    const { mask, minX, minY, maxX, maxY } = result;
    let filledPixels = 0;
    for (let py = minY; py <= maxY; py++) {
      const row = py * stride;
      for (let px = minX; px <= maxX; px++) {
        if (mask[row + px]) filledPixels++;
      }
    }
    return filledPixels;
  }

  _isFillTooLarge(result, width, height) {
    const filledPixels = this._countFilledPixels(result, width);
    const maxPixels = Math.round(width * height * 0.4);
    return filledPixels > maxPixels
      ? { filledPixels, maxPixels }
      : null;
  }

  _warnFillTooLarge(fillLimit, showToast = false) {
    if (!fillLimit) return;
    console.warn(`Fill rejected: ${fillLimit.filledPixels} pixels exceeds 40% of canvas (${fillLimit.maxPixels})`);
    if (!showToast) return;
    const now = Date.now();
    if (now - this._lastTooLargeToast < 1500) return;
    this._lastTooLargeToast = now;
    this.board.app?.ui?.showToast('Fill region too large', 2000);
  }

  /**
   * Board-absolute box covering everything a fill will paint: the primary mask
   * unioned with every mirror copy, grown by the blur reach and expansion.
   * Sizes the windowed active-stroke canvas. Returns null when there is nothing
   * to bound, which callers pass through as "full board".
   * @private
   */
  _fillStrokeBounds(result, mirrors, blurRadius, expansion, width, height) {
    const pad = Math.ceil(blurRadius * 3) + Math.ceil(Math.abs(expansion));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const entry of [result, ...mirrors]) {
      const r = entry?.result || entry;
      if (!r || r.maxX == null) continue;
      if (r.minX < minX) minX = r.minX;
      if (r.minY < minY) minY = r.minY;
      if (r.maxX > maxX) maxX = r.maxX;
      if (r.maxY > maxY) maxY = r.maxY;
    }
    if (maxX < minX) return null;
    const x = Math.max(0, minX - pad);
    const y = Math.max(0, minY - pad);
    const right = Math.min(width, maxX + pad + 1);
    const bottom = Math.min(height, maxY + pad + 1);
    return { x, y, width: right - x, height: bottom - y };
  }

  /**
   * Begin this user's active stroke windowed to `bounds` rather than through
   * `Board.beginStroke` — that shared wrapper calls `beginUserStroke` with no
   * bounds, which allocates a full-board canvas AND pins `origin` to null for
   * the stroke's whole lifetime, so a later windowed `getUserStrokeContext`
   * would be silently ignored. Same trap already worked around in
   * EraserTool/BlurTool/GlitchBlurTool/ConfettiTool/ImageBrushTool/ShapeTools.
   * Replicates `beginStroke`'s other effects (mask clip, requestUpdate).
   * @private
   */
  _beginStrokeWindowed(user, params, bounds) {
    if (user?.panning) return null;
    const lm = this.board.layerManager;
    if (!lm) return null;
    lm.beginUserStroke(
      params.activeLayer,
      params.userId,
      user?.blendMode ?? 'source-over',
      user?.blendBakeMode,
      bounds
    );
    this.board.applySelectionMaskClipForStroke(params.activeLayer, params.userId);
    this.board.requestUpdate();
    return lm.getActiveStroke(params.activeLayer, params.userId)?.origin ?? null;
  }

  /**
   * Commit a fill result to the stroke canvas.
   * @private
   */
  _commitFillResult(user, result, params, width, height, mirrorResults, blurRadius = this._blurRadius, expansion = this._expansion) {
    if (!result) return;

    const mirrors = Array.isArray(mirrorResults) ? mirrorResults : (mirrorResults ? [mirrorResults] : []);

    // A fill only ever paints inside its own mask, so the active-stroke canvas
    // is windowed to that instead of the whole board.
    const bounds = this._fillStrokeBounds(result, mirrors, blurRadius, expansion, width, height);
    const origin = this._beginStrokeWindowed(user, params, bounds);
    const strokeCtx = this.board.layerManager.getUserStrokeContext(params.activeLayer, params.userId);
    if (!strokeCtx) return;

    this._renderMask(strokeCtx, result, params.fillR, params.fillG, params.fillB, params.userOpacity, blurRadius, width, height, user, origin);

    const pad = Math.ceil(blurRadius * 3) + Math.ceil(Math.abs(expansion));
    const bx = Math.max(0, result.minX - pad);
    const by = Math.max(0, result.minY - pad);
    const bw = Math.min(width, result.maxX + pad + 1) - bx;
    const bh = Math.min(height, result.maxY + pad + 1) - by;
    this.board.expandDirtyRect(user, bx, by, bw, bh);

    for (const entry of mirrors) {
      const mirrorResult = entry?.result || entry;
      const region = entry?.region || null;
      if (!mirrorResult) continue;
      if (region) {
        // withMirrorRegionClip builds its clip rect in BOARD coordinates, so a
        // windowed strokeCtx has to be translated here rather than handed
        // `origin` — clip paths go through the CTM, and so does the drawImage
        // _renderMaskComposite finishes with. Passing both would double-shift.
        strokeCtx.save();
        strokeCtx.translate(-(origin?.x ?? 0), -(origin?.y ?? 0));
        this.board.withMirrorRegionClip(strokeCtx, region, () => {
          this._renderMaskComposite(strokeCtx, mirrorResult, params.fillR, params.fillG, params.fillB, params.userOpacity, blurRadius, width, height, user);
        });
        strokeCtx.restore();
      } else {
        this._renderMaskComposite(strokeCtx, mirrorResult, params.fillR, params.fillG, params.fillB, params.userOpacity, blurRadius, width, height, user, origin);
      }
      const mpad = Math.ceil(blurRadius * 3) + Math.ceil(Math.abs(expansion));
      const mbx = Math.max(0, mirrorResult.minX - mpad);
      const mby = Math.max(0, mirrorResult.minY - mpad);
      const mbw = Math.min(width, mirrorResult.maxX + mpad + 1) - mbx;
      const mbh = Math.min(height, mirrorResult.maxY + mpad + 1) - mby;
      this.board.expandDirtyRect(user, mbx, mby, mbw, mbh);
    }
  }

  async _computeMirrorFillResults(imageData, width, height, x, y, expansion, userId) {
    const results = [];
    for (const region of this.board.getActiveMirrorRegions()) {
      if (!region?.synthetic) continue;
      const mirrored = this.board.mirrorPointToRegion({ x, y }, region);
      const mx = Math.round(mirrored.x);
      const my = Math.round(mirrored.y);
      if (mx < 0 || mx >= width || my < 0 || my >= height) continue;
      const mirrorResult = await this._fillWorker.computeFill(imageData, width, height, mx, my, 10, expansion, null);
      const fillLimit = this._isFillTooLarge(mirrorResult, width, height);
      if (fillLimit) {
        this._warnFillTooLarge(fillLimit, false);
        continue;
      }
      if (mirrorResult) results.push({ region, result: mirrorResult });
    }
    return results;
  }

  // -- pointer events --

  async onPointerDown(user, pos, e) {
    this._committed = false;
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const width = this.board.getWidth();
    const height = this.board.getHeight();
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    const params = this._getFillParams(user);

    // A fill reads the whole board — it can legitimately flood well past the
    // visible box — so it reads the full raster, not the display surface.
    const imageData = this.board.getFullBoardImageData(0, 0, width, height);
    if (!imageData) return;
    const data = imageData.data;

    // Check target vs fill color similarity
    const startIdx = (y * width + x) * 4;
    const tR = data[startIdx], tG = data[startIdx + 1], tB = data[startIdx + 2], tA = data[startIdx + 3];
    if (tA >= 10) {
      const dr = tR - params.fillR, dg = tG - params.fillG, db = tB - params.fillB, da = tA - 255;
      if (dr * dr + dg * dg + db * db + da * da <= 100) return;
    }

    if (!this._useAdvancedMode()) {
      // -- Standard mode (also used while mirrors are active) --
      const result = await this._fillWorker.computeFill(
        data, width, height, x, y, 10, 0, null
      );
      if (!result) { this._committed = true; return; }

      const fillLimit = this._isFillTooLarge(result, width, height);
      if (fillLimit) {
        this._warnFillTooLarge(fillLimit, true);
        this._committed = true;
        return;
      }

      // _computeMirrorFillResults is a no-op without synthetic mirror regions,
      // but the argument was evaluated eagerly — a full-board readback thrown
      // away on every fill in a room with no mirrors.
      const hasMirrorTargets = this.board.getActiveMirrorRegions().some(r => r?.synthetic);
      // Re-read rather than reusing `data`: the awaits above mean the board may
      // have moved on since the read at the top of this handler.
      const mirrorResults = hasMirrorTargets
        ? await this._computeMirrorFillResults(
          this.board.getFullBoardImageData(0, 0, width, height).data,
          width,
          height,
          x,
          y,
          0,
          params.userId
        )
        : [];

      this._commitFillResult(user, result, params, width, height, mirrorResults, 0, 0);
      this._broadcastFill(user, x, y, params.activeLayer, 0, 0);
      // Tag so the MU self-echo reconciler skips this stroke; the FILL self-echo
      // assigns its authoritative seq (see DrawingHandlers 'fill' self branch).
      this.board.endStroke(user, { pendingCommitEcho: 'fill' });
      this._committed = true;
      return;
    }

    // -- Advanced mode: enter interactive drag immediately so move events are captured --
    this._active = true;
    this._startPos = { x: pos.x, y: pos.y };
    this._clickPos = { x, y };
    this._dragStartExpansion = this._expansion;
    this._dragStartBlur = this._blurRadius;
    // Reuse the readback taken above rather than taking a second one:
    // computeFill copies the buffer it is handed (see FillWorkerClient), so
    // `imageData` is never detached and stays valid for the whole drag.
    this._imageData = imageData;

    this._fillParams = { ...params, width, height, user };

    const initialResult = await this._fillWorker.computeFill(
      data, width, height, x, y, 10, 0, null
    );
    if (!initialResult) { this._active = false; return; }

    const initialFillLimit = this._isFillTooLarge(initialResult, width, height);
    if (initialFillLimit) {
      this._warnFillTooLarge(initialFillLimit, true);
      this._cancelInteractive();
      this._committed = true;
      return;
    }

    // Show initial preview (move events may have already updated expansion/blur)
    if (this._expansion !== 0 || this._blurRadius !== 0) {
      this._requestPreviewUpdate();
    } else {
      this._showPreviewResult(initialResult);
    }
  }

  onPointerMove(user, pos, lastPos, e) {
    if (!this._active || !this._useAdvancedMode()) return;

    const zoom = this.board.zoom || 1;
    const dx = (pos.x - this._startPos.x) * zoom;
    const dy = (pos.y - this._startPos.y) * zoom;

    this._expansion = this._computeExpansionFromDrag(this._dragStartExpansion, dx);
    this._blurRadius = Math.round(Math.max(0, Math.min(25, this._dragStartBlur + dy * 0.12)) * 10) / 10;
    this._updateSliders();

    this._requestPreviewUpdate();
  }

  /**
   * Throttle preview updates to avoid flooding the worker during fast drags.
   * @private
   */
  _requestPreviewUpdate() {
    if (this._pendingPreview) return;
    this._pendingPreview = true;

    // ~30fps preview updates
    this._previewTimer = setTimeout(() => {
      this._previewTimer = null;
      this._pendingPreview = false;
      this._updatePreviewAsync();
    }, 33);
  }

  async _updatePreviewAsync() {
    if (!this._active || !this._fillParams) return;

    const { width, height, userId, user } = this._fillParams;
    const { fillR, fillG, fillB, userOpacity } = this._fillParams;
    const { x, y } = this._clickPos;

    const result = await this._fillWorker.computeFill(
      this._imageData.data, width, height,
      x, y, 10, this._expansion, null
    );

    // If we've been cancelled while waiting, don't render
    if (!this._active) return;

    const fillLimit = this._isFillTooLarge(result, width, height);
    if (fillLimit) {
      this._warnFillTooLarge(fillLimit, true);
      this._cancelInteractive();
      this._committed = true;
      return;
    }

    const topCtx = this.board.topCtx;
    topCtx.clearRect(0, 0, width, height);

    if (result) {
      this._renderMask(topCtx, result, fillR, fillG, fillB, userOpacity, this._blurRadius, width, height, user);

      const mirrorResults = await this._computeMirrorFillResults(
        this._imageData.data,
        width,
        height,
        x,
        y,
        this._expansion,
        userId
      );
      for (const entry of mirrorResults) {
        if (!this._active) break;
        this.board.withMirrorRegionClip(topCtx, entry.region, () => {
          this._renderMaskComposite(topCtx, entry.result, fillR, fillG, fillB, userOpacity, this._blurRadius, width, height, user);
        });
      }
      this._setPreviewLayer(this._fillParams.activeLayer);
    } else {
      this._clearPreviewLayer();
    }
  }

  /**
   * Show a fill result on the preview canvas immediately.
   * @private
   */
  _showPreviewResult(result) {
    if (!result || !this._fillParams) return;
    // Kept so redrawPreview can put it back after the surface window moves.
    this._shownPreviewResult = result;
    const { width, height, user } = this._fillParams;
    const { fillR, fillG, fillB, userOpacity } = this._fillParams;
    const topCtx = this.board.topCtx;
    topCtx.clearRect(0, 0, width, height);
    this._renderMask(topCtx, result, fillR, fillG, fillB, userOpacity, 0, width, height, user);
    this._setPreviewLayer(this._fillParams.activeLayer);
  }

  /**
   * The interactive fill preview persists between ticks — it is only redrawn
   * when the expansion/blur drag changes it — so a window move would otherwise
   * leave the user dragging against nothing.
   */
  redrawPreview() {
    if (!this._active || !this._shownPreviewResult) return;
    this._showPreviewResult(this._shownPreviewResult);
  }

  async onPointerUp(user, pos, e) {
    if (!this._active) {
      if (!this._committed) this.board.endStroke(user);
      return;
    }

    const { width, height, activeLayer, userId } = this._fillParams;
    const params = this._fillParams;
    const { x, y } = this._clickPos;

    // Cancel any pending preview
    if (this._previewTimer !== null) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
    this._pendingPreview = false;

    const result = await this._fillWorker.computeFill(
      this._imageData.data, width, height,
      x, y, 10, this._expansion, null
    );

    // Clear preview
    this.board.topCtx.clearRect(0, 0, width, height);
    this._clearPreviewLayer();

    if (result) {
      const fillLimit = this._isFillTooLarge(result, width, height);
      if (fillLimit) {
        this._warnFillTooLarge(fillLimit, true);
        this._active = false;
        this._imageData = null;
        this._fillParams = null;
        this._committed = true;
        return;
      }

      const mirrorResults = await this._computeMirrorFillResults(
        this._imageData.data,
        width,
        height,
        x,
        y,
        this._expansion,
        userId
      );

      this._commitFillResult(user, result, params, width, height, mirrorResults);
      this._broadcastFill(user, x, y, activeLayer, this._expansion, this._blurRadius);
      // Tag so the MU self-echo reconciler skips this stroke; the FILL self-echo
      // assigns its authoritative seq (see DrawingHandlers 'fill' self branch).
      this.board.endStroke(user, { pendingCommitEcho: 'fill' });
    }

    this._active = false;
    this._imageData = null;
    this._fillParams = null;
  }
}
