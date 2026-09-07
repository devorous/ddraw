/**
 * @fileoverview Selection tool for manipulating canvas content.
 * Provides lasso and rectangular selection, move, rotate, and homography-based transforms.
 */

import { Homography } from '../utils/homography.js';
import { debug } from '../utils/debug.js';
import { performHomographyTransform, imageDataToCanvas, calculateCornerBounds, computeWarpOutputBounds } from '../utils/homographyUtils.js';
import { pointInHull, distanceBasedCulling } from '../utils/drawing.js';
import { getPatternTile, getPatternDrawScale } from '../utils/patternTile.js';
import { paintHardenedEraseMask, needsHardenedEraseMask } from '../utils/eraseMask.js';
import { Tool } from './BaseTool.js';
import { assetLibrary } from '../ui/AssetLibrary.js';

function cloneSelectionRect(rect) {
  if (!rect) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function clonePathPoints(path) {
  if (!Array.isArray(path)) return null;
  return path.map((point) => ({ x: point.x, y: point.y }));
}

/**
 * Selection tool for selecting, moving, and transforming regions.
 * Supports both rectangular and lasso selection modes.
 */
export class SelectTool extends Tool {
  /**
   * @param {Board} board - The drawing board instance.
   */
  constructor(board) {
    super('select', board);
    this.mode = 'lasso'; // 'rectangle' or 'lasso'
    this.copyAllLayers = true; // Toggle: copy/cut all visible layers vs active layer only
    this._restoreData = null; // Snapshot of erased area
    this.floatingLayers = null; // Per-layer canvases when copyAllLayers is active
    this._sourceCropForRemote = null;
    this.isSelecting = false;
    this.isDragging = false;
    this.startPos = null;
    this.selection = null; // { x, y, width, height }
    this.selectedImageData = null;
    this.floatingCanvas = null;
    this.floatingCtx = null;
    this.dragOffset = { x: 0, y: 0 };
    this.marchingAntsOffset = 0;
    this.livePreviewDashOffset = 0;
    this.animationId = null;

    // Transform handles
    this.handles = [];
    this.activeHandle = null;
    this.handleSize = 8;
    this.handleHitArea = 20;

    // Corner positions for transform
    this.corners = null; // { tl, tr, bl, br }
    this.originalCorners = null; // Original corners relative to selection
    this.originalSelectionPos = null;

    // Rotation
    this.rotation = 0;
    this.rotationHandleDistance = 30;
    this.isRotating = false;
    this.rotationStartAngle = 0;
    this.cornersAtRotationStart = null;

    // Perspective handles
    this.perspectiveHandleDistance = 40;

    // Homography instances
    this.homography = null;
    this.previewHomography = null;
    this.isTransforming = false;

    // Preview downscaling
    this.previewMaxSize = 512;
    this.hasShownPreviewToast = false;

    // Cache for transformed preview
    this._cachedTransform = null; // { canvas, bounds, cornersKey }

    // Clipboard
    this.clipboard = null;

    // Context menu elements
    this.menuElements = null;

    // Menu positioning
    this.lastPointerUpPos = null;

    // Pattern mode
    this.patternMode = false;
    this._patternTileCache = new Map();

    // Throttling for selection move broadcasts (30 TPS)
    this.selectionMoveThrottleRate = 30;
    this.selectionMoveThrottleInterval = 1000 / this.selectionMoveThrottleRate;
    this.lastSelectionBroadcastTime = 0;
    this.pendingSelectionBroadcast = null;

    // Throttling for in-progress selection marquee broadcasts (30 TPS)
    this.selectionPendingThrottleRate = 30;
    this.selectionPendingThrottleInterval = 1000 / this.selectionPendingThrottleRate;
    this.lastSelectionPendingBroadcastTime = 0;
    this.pendingSelectionPreviewBroadcast = null;

    // Lasso-specific state
    this.lassoPoints = [];
    this.lassoSimplified = null;
    this.lassoPath = null;
    this.originalSelection = null; // Stores uncropped selection bounds before auto-fit
    this.fitToContent = true; // Toggle: auto-crop selection to content bounds
    this.exportPadding = 10; // px of transparent breathing room added around the image when saving/exporting a selection
    this.isMaskMode = false; // Mask mode: selection acts as drawing constraint, not pixel move
    this.extendedWarp = false; // Toggle: let folded (concave/crossed) warps spill beyond the selection bounds instead of clipping at the corner bbox
  }

  /**
   * Get pattern tile for selection fill (reuses PatternTool's tile generation logic).
   * @private
   */
  _getPatternTile(user) {
    if (!this._patternTileCache) this._patternTileCache = new Map();
    return getPatternTile(user, this._patternTileCache);
  }

  /**
   * Draw a canvas with pattern fill (uses canvas as alpha mask).
   * @private
   */
  _drawWithPattern(targetCtx, sourceCanvas, x, y, user) {
    const tile = this._getPatternTile(user);
    if (!tile) {
      // Fallback to normal draw if no pattern
      targetCtx.drawImage(sourceCanvas, x, y);
      return;
    }

    const scale = getPatternDrawScale(user, tile);
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;
    const rotation = user.patternRotation || 0;

    // Create temp canvas for pattern fill
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sourceCanvas.width;
    tempCanvas.height = sourceCanvas.height;
    const tempCtx = tempCanvas.getContext('2d');

    // Step 1: Draw source canvas as black mask
    tempCtx.drawImage(sourceCanvas, 0, 0);

    // Convert to black mask (preserve alpha)
    const imgData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) {
        data[i] = 0;     // R = black
        data[i + 1] = 0; // G = black
        data[i + 2] = 0; // B = black
        // Keep alpha as-is
      }
    }
    tempCtx.putImageData(imgData, 0, 0);

    // Step 2: Create pattern and fill
    const pattern = tempCtx.createPattern(tile, 'repeat');
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX, offsetY)
        .rotate(rotation)
        .scale(scale);
      pattern.setTransform(matrix);
    }

    tempCtx.globalCompositeOperation = 'source-in';
    tempCtx.fillStyle = pattern;
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // Step 3: Draw result to target
    targetCtx.drawImage(tempCanvas, x, y);
  }

  /**
   * Build the canvas path for the current selection shape (lasso polygon or rect).
   * All coordinates are in the local space of ctx: lasso points are shifted by offsetX/offsetY.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{width: number, height: number}} rect
   * @param {number} [offsetX=0] - Canvas-space X origin of this context (subtracted from lasso coords).
   * @param {number} [offsetY=0] - Canvas-space Y origin of this context.
   * @returns {boolean} true if a lasso path was built, false for a simple rect.
   * @private
   */
  _applyPath(ctx, rect, offsetX = 0, offsetY = 0) {
    if (this.mode === 'lasso' && this.lassoPath?.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(this.lassoPath[0].x - offsetX, this.lassoPath[0].y - offsetY);
      for (let i = 1; i < this.lassoPath.length; i++) {
        ctx.lineTo(this.lassoPath[i].x - offsetX, this.lassoPath[i].y - offsetY);
      }
      ctx.closePath();
      return true;
    }
    ctx.rect(0, 0, rect.width, rect.height);
    return false;
  }

  /**
   * Fill ctx with the current color or pattern, clipped to the selection shape.
   * ctx is assumed to be in local space (0,0 = top-left of the selection rect).
   * @param {CanvasRenderingContext2D} ctx
   * @param {{width: number, height: number}} rect
   * @param {Object} user - User state (color, patternBrush, etc.)
   * @param {number} opacity
   * @param {number} [offsetX=0] - Canvas-space X origin used to align lasso coords and pattern tile.
   * @param {number} [offsetY=0]
   * @private
   */
  _executeFill(ctx, rect, user, opacity, offsetX = 0, offsetY = 0) {
    ctx.save();
    const isLasso = this._applyPath(ctx, rect, offsetX, offsetY);

    if (this.patternMode) {
      const tile = this._getPatternTile(user);
      if (tile) {
        const scale = getPatternDrawScale(user, tile);
        const pattern = ctx.createPattern(tile, 'repeat');
        const matrix = new DOMMatrix()
          .translate((user.patternOffsetX || 0) - offsetX, (user.patternOffsetY || 0) - offsetY)
          .rotate(user.patternRotation || 0)
          .scale(scale);
        pattern.setTransform(matrix);

        ctx.clip();
        ctx.globalAlpha = opacity;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.restore();
        return;
      }
    }

    // Solid color (also pattern fallback when no tile is loaded)
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    if (isLasso) {
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, rect.width, rect.height);
    }
    ctx.restore();
  }

  /**
   * Activates the tool.
   */
  activate() {
    this.board.viewCtx.globalCompositeOperation = 'source-over';
    this.board.topCanvas.style.mixBlendMode = 'normal';
    // SelectTool will manage the mask overlay animation from now on
    this.board._maskManagedBySelectTool = this.isMaskMode;
    this.startMarchingAnts();
    this.setupMenuListeners();
  }

  _updateFloatingSelectionBlendPreview() {
    if (!this.board?.topCanvas) return;
    if (!this.floatingCanvas || !this.board.app) {
      this.board.topCanvas.style.mixBlendMode = 'normal';
      return;
    }

    const activeLayer = this.board.app.self?.activeLayer ?? 0;
    const allowComplex = this.board.layerManager?.getLayerAllowComplexBlendModes(activeLayer) ?? true;
    const blendMode = allowComplex ? (this.board.app.self?.blendMode || 'source-over') : 'source-over';
    this.board.topCanvas.style.mixBlendMode = this.board.app.blendModeManager?.toCSSBlendMode(blendMode) || 'normal';
  }

  /**
   * Deactivates the tool, committing any active selection.
   */
  deactivate() {
    this.stopMarchingAnts();
    if (this.isMaskMode && this.selection && !this.floatingCanvas) {
      // Hand off mask overlay to Board (static, redrawn on clearTop)
      this.board._maskManagedBySelectTool = false;
      this.board.clearTop(); // triggers static overlay redraw via clearTop hook
    } else {
      this.commitSelection();
      this.clearSelection();
    }
    this.hideContextMenu();
    this.board.container.style.cursor = '';
    // Reset topCtx line dash to prevent dotted lines bleeding into other tools
    this.board.topCtx.setLineDash([]);
    // Restore blend mode from user state
    if (this.board.app) {
      const activeLayer = this.board.app.self?.activeLayer ?? 0;
      const allowComplex = this.board.layerManager?.getLayerAllowComplexBlendModes(activeLayer) ?? true;
      const blendMode = allowComplex ? this.board.app.self.blendMode : 'source-over';
      const cssMode = this.board.app.blendModeManager.toCSSBlendMode(blendMode);
      this.board.topCanvas.style.mixBlendMode = cssMode;
    }
    if (this.board.app?.ui) {
      this.board.app.ui.setSelectCursor(false);
    }
  }

  /**
   * Throttled broadcast for selection moves to limit network/render load.
   * @param {Object} corners - { tl: {x,y}, tr: {x,y}, bl: {x,y}, br: {x,y} }
   * @param {boolean} [force=false] - If true, bypass throttle.
   */
  throttledBroadcastSelectionMove(corners, force = false) {
    if (!this.board.app || !this.board.app.wsClient) return;

    // Ensure corners data is valid and has all required numerical properties before broadcasting
    // Check if 'corners' is a valid object
    if (!corners || typeof corners !== 'object') {
      debug.warn('[SelectTool] Attempted to broadcast invalid corners: "corners" is null or not an object.');
      return;
    }

    // Check if all corner points (tl, tr, bl, br) exist and are objects
    if (!corners.tl || !corners.tr || !corners.bl || !corners.br ||
        typeof corners.tl !== 'object' || typeof corners.tr !== 'object' ||
        typeof corners.bl !== 'object' || typeof corners.br !== 'object') {
      debug.warn('[SelectTool] Attempted to broadcast invalid corners: missing or invalid corner points (tl, tr, bl, br).');
      return;
    }

    // Check if each corner point has valid numeric x and y properties
    if (typeof corners.tl.x !== 'number' || typeof corners.tl.y !== 'number' ||
        typeof corners.tr.x !== 'number' || typeof corners.tr.y !== 'number' ||
        typeof corners.bl.x !== 'number' || typeof corners.bl.y !== 'number' ||
        typeof corners.br.x !== 'number' || typeof corners.br.y !== 'number') {
      debug.warn('[SelectTool] Attempted to broadcast invalid corners: missing or non-numeric x/y coordinates on corner points.');
      return;
    }

    const now = performance.now();
    const elapsed = now - this.lastSelectionBroadcastTime;

    if (force || elapsed >= this.selectionMoveThrottleInterval) {
      // extendedWarp travels with every move so a mid-drag toggle stays correct
      // for remote preview and replay scrubbing, not just the eventual commit.
      this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionMove(corners, null, this.extendedWarp), { snapshot: false });
      this.lastSelectionBroadcastTime = now;
      this.pendingSelectionBroadcast = null;
    } else {
      this.pendingSelectionBroadcast = { ...corners };
    }
  }

  /**
   * Flush any pending selection broadcast.
   */
  flushPendingSelectionBroadcast() {
    if (this.pendingSelectionBroadcast && this.board.app && this.board.app.wsClient) {
      const corners = this.pendingSelectionBroadcast;
      // Ensure pending corners data is valid before broadcasting
      if (corners && corners.tl && corners.tr && corners.bl && corners.br &&
          typeof corners.tl.x === 'number' && typeof corners.tl.y === 'number' &&
          typeof corners.tr.x === 'number' && typeof corners.tr.y === 'number' &&
          typeof corners.bl.x === 'number' && typeof corners.bl.y === 'number' &&
          typeof corners.br.x === 'number' && typeof corners.br.y === 'number') {
        this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionMove(corners, null, this.extendedWarp), { snapshot: false });
        this.pendingSelectionBroadcast = null;
        this.lastSelectionBroadcastTime = performance.now();
      } else {
        debug.warn('[SelectTool] Attempted to flush pending broadcast with invalid corners data.');
        this.pendingSelectionBroadcast = null; // Clear invalid data
      }
    }
  }

  throttledBroadcastSelectionPending(selection, lassoPath = null, force = false) {
    if (!selection || !this.board.app?.wsClient) return;

    const now = performance.now();

    if (force || (now - this.lastSelectionPendingBroadcastTime >= this.selectionPendingThrottleInterval)) {
      this.lastSelectionPendingBroadcastTime = now;
      this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionPending(selection, lassoPath), { snapshot: false });
      this.pendingSelectionPreviewBroadcast = null;
    } else {
      this.pendingSelectionPreviewBroadcast = {
        selection: cloneSelectionRect(selection),
        lassoPath: clonePathPoints(lassoPath)
      };
    }
  }

  flushPendingSelectionPreviewBroadcast() {
    if (this.pendingSelectionPreviewBroadcast && this.board.app?.wsClient) {
      const { selection, lassoPath } = this.pendingSelectionPreviewBroadcast;
      if (selection) {
        this.lastSelectionPendingBroadcastTime = performance.now();
        this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionPending(selection, lassoPath), { snapshot: false });
      }
      this.pendingSelectionPreviewBroadcast = null;
    }
  }

  /**
   * Set selection mode.
   * @param {string} mode - 'rectangle' or 'lasso'.
   */
  setMode(mode) {
    if (this.selection) {
      this.commitSelection();
      this.clearSelection();
    }
    this.mode = mode;
  }

  /**
   * Get bounding box from array of points.
   * @param {Array<{x: number, y: number}>} points
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  getBoundsFromPoints(points) {
    if (!points || points.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    const x = Math.floor(minX);
    const y = Math.floor(minY);
    return {
      x,
      y,
      width: Math.ceil(maxX) - x,
      height: Math.ceil(maxY) - y
    };
  }

  /**
   * Draw lasso preview during selection.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array<{x: number, y: number}>} points
   */
  /**
   * Strokes a marching-ants outline: two dashed passes (black, then white offset
   * by half a dash) sharing one path, animated via `offset`. The `strokeOnce`
   * callback traces + strokes the path and is invoked once per color pass.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} offset - Animation offset (this.marchingAntsOffset / livePreviewDashOffset).
   * @param {() => void} strokeOnce
   */
  _strokeMarchingAnts(ctx, offset, strokeOnce) {
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = -offset;
    strokeOnce();
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -offset + 4;
    strokeOnce();
    ctx.setLineDash([]);
  }

  drawLassoPreview(ctx, points) {
    if (points.length < 2) return;

    this._strokeMarchingAnts(ctx, this.livePreviewDashOffset, () => {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    });

    this._strokeMirroredOutline(ctx, points, this.livePreviewDashOffset);
  }

  /**
   * Strokes a faded ghost copy of a board-space polyline into every active
   * mirror region it reaches, so the preview shows where a selection operation
   * will actually land. Shared by the lasso preview, the rectangle drag preview
   * and the floating-selection ghost.
   *
   * Uses `forEachMirrorRegion` rather than `getSelectionMirrorTargets` because
   * an outline can be degenerate (a perfectly straight drag has zero height)
   * and needs no paint bounds — only the region's clip and point transform.
   * @private
   */
  _strokeMirroredOutline(ctx, points, dashOffset, closePath = false) {
    if (!points || points.length < 2) return;

    let opened = false;
    this.board.forEachMirrorRegion({ points }, (region) => {
      if (!opened) {
        ctx.save();
        ctx.globalAlpha = 0.32;
        opened = true;
      }
      const mirrored = this.board.mirrorPointsToRegion(points, region);
      this.board.withMirrorRegionClip(ctx, region, () => {
        this._strokeMarchingAnts(ctx, dashOffset, () => {
          ctx.beginPath();
          ctx.moveTo(mirrored[0].x, mirrored[0].y);
          for (let i = 1; i < mirrored.length; i++) ctx.lineTo(mirrored[i].x, mirrored[i].y);
          if (closePath) ctx.closePath();
          ctx.stroke();
        });
      });
    });
    if (opened) ctx.restore();
  }

  /**
   * Apply lasso mask to a canvas context.
   * @param {CanvasRenderingContext2D} ctx - The context to mask.
   * @param {number} offsetX - X offset relative to canvas.
   * @param {number} offsetY - Y offset relative to canvas.
   * @param {Array<{x: number, y: number}>} lassoPath - The lasso polygon.
   */
  applyLassoMask(ctx, offsetX, offsetY, lassoPath) {
    if (!lassoPath || lassoPath.length < 3) return;

    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'white';
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
   * Sets up context menu event listeners.
   */
  setupMenuListeners() {
    if (this.menuElements) return;

    this.menuElements = {
      menu: document.getElementById('selectionMenu'),
      mask: document.getElementById('selMenuMask'),
      obscure: document.getElementById('selMenuObscure'),
      clear: document.getElementById('selMenuClear'),
      clone: document.getElementById('selMenuClone'),
      fill: document.getElementById('selMenuFill'),
      brush: document.getElementById('selMenuBrush'),
      flip: document.getElementById('selMenuFlip'),
      stamp: document.getElementById('selMenuStamp'),
      apply: document.getElementById('selMenuApply'),
      save: document.getElementById('selMenuSave'),
      cancel: document.getElementById('selMenuCancel'),
      merge: document.getElementById('selMenuMerge'),
      mergeUp: document.getElementById('selMenuMergeUp'),
      mergeDown: document.getElementById('selMenuMergeDown'),
      mergeAll: document.getElementById('selMenuMergeAll'),
    };

    if (!this.menuElements.menu) return;

    this.menuElements.mask?.addEventListener('click', () => this.toggleMaskMode());
    this.menuElements.obscure?.addEventListener('click', () => this.obscureSelection());
    this.menuElements.clear.addEventListener('click', () => this.deleteSelection());
    this.menuElements.clone?.addEventListener('click', () => this.clone());
    this.menuElements.fill.addEventListener('click', () => this.fillSelection());
    this.menuElements.brush.addEventListener('click', () => this.toImageBrush());
    this.menuElements.flip.addEventListener('click', () => this.flipHorizontal());
    this.menuElements.stamp.addEventListener('click', () => this.stamp());
    this.menuElements.apply.addEventListener('click', () => this.deselect());
    this.menuElements.save.addEventListener('click', () => this.saveSelection());
    this.menuElements.cancel.addEventListener('click', () => this.cancelSelection());
    this.menuElements.mergeUp?.addEventListener('click', () => this.mergeUp());
    this.menuElements.mergeDown?.addEventListener('click', () => this.mergeDown());
    this.menuElements.mergeAll?.addEventListener('click', () => this.mergeAll());
  }

  /**
   * Displays the selection context menu.
   * @param {boolean} skipReposition - If true, skip repositioning when menu is already visible
   */
  showContextMenu(skipReposition = false) {
    if (!this.menuElements?.menu || !this.selection) return;

    const menu = this.menuElements.menu;
    const wasVisible = menu.style.display !== 'none';
    const hasMoved = this.hasBeenMoved();

    // A floating selection without _restoreData was cloned/pasted, not lifted —
    // there is nothing to put back, so the Cancel button is removed entirely.
    const isEphemeralFloat = hasMoved && !this._restoreData;

    const activeLayer = this.board.app?.self?.activeLayer ?? 0;
    const layerCount = this.board.layerManager?.layerGroups?.length ?? 0;
    const mergeAllowed = !hasMoved && this.canCreateObscureRegions();
    const canMergeUp = mergeAllowed && activeLayer < layerCount - 1;
    const canMergeDown = mergeAllowed && activeLayer > 0;
    const canMergeAll = mergeAllowed && layerCount > 1;

    this.menuElements.mask?.classList.toggle('hidden', hasMoved);
    this.menuElements.obscure?.classList.toggle('hidden', hasMoved || !this.canCreateObscureRegions());
    this.menuElements.mask?.classList.toggle('active', this.isMaskMode);
    this.menuElements.clear.classList.toggle('hidden', false);
    this.menuElements.clone?.classList.toggle('hidden', hasMoved);
    this.menuElements.fill.classList.toggle('hidden', hasMoved);
    this.menuElements.flip.classList.toggle('hidden', false);
    this.menuElements.stamp.classList.toggle('hidden', !hasMoved);
    this.menuElements.apply.classList.toggle('hidden', !hasMoved);
    this.menuElements.save.classList.toggle('hidden', false);
    this.menuElements.cancel.classList.toggle('hidden', isEphemeralFloat);
    this.menuElements.mergeUp?.classList.toggle('hidden', !canMergeUp);
    this.menuElements.mergeDown?.classList.toggle('hidden', !canMergeDown);
    this.menuElements.mergeAll?.classList.toggle('hidden', !canMergeAll);
    this.menuElements.merge?.classList.toggle('hidden', !(canMergeUp || canMergeDown || canMergeAll));

    this.menuElements.clear.textContent = hasMoved ? 'Remove' : 'Clear';
    this.menuElements.clear.title = hasMoved ? 'Delete selection contents' : 'Clear selection contents';
    this.menuElements.cancel.textContent = hasMoved ? 'Put back' : 'Cancel';
    this.menuElements.cancel.title = hasMoved ? 'Restore the lifted selection' : 'Cancel selection';
    if (this.menuElements.mask) {
      this.menuElements.mask.textContent = this.isMaskMode ? 'Unmask' : 'Mask';
      this.menuElements.mask.title = this.isMaskMode ? 'Remove drawing mask' : 'Use selection as drawing mask';
    }

    const menuOrder = hasMoved
      ? {
          apply: 0,
          cancel: 1,
          clear: 2,
          stamp: 3,
          mask: 4,
          brush: 5,
          flip: 6,
          save: 7,
          clone: 8,
          fill: 9,
          obscure: 10,
          merge: 11
        }
      : {
          clear: 0,
          clone: 1,
          fill: 2,
          cancel: 3,
          mask: 4,
          brush: 5,
          flip: 6,
          stamp: 7,
          apply: 8,
          save: 9,
          obscure: 10,
          merge: 11
        };

    Object.entries(menuOrder).forEach(([key, order]) => {
      const el = this.menuElements[key];
      if (el) el.style.order = String(order);
    });

    menu.classList.add('grid');
    menu.style.display = '';

    // Skip repositioning if menu was already visible and we're just updating buttons
    if (skipReposition && wasVisible) return;

    let canvasX, canvasY;

    if (this.lastPointerUpPos) {
      canvasX = this.lastPointerUpPos.x;
      canvasY = this.lastPointerUpPos.y;
    } else {
      const rightX = this.corners
        ? Math.max(this.corners.tl.x, this.corners.tr.x, this.corners.bl.x, this.corners.br.x)
        : this.selection.x + this.selection.width;
      const bottomY = this.corners
        ? Math.max(this.corners.tl.y, this.corners.tr.y, this.corners.bl.y, this.corners.br.y)
        : this.selection.y + this.selection.height;

      canvasX = rightX;
      canvasY = bottomY;
    }

    const zoom = this.board.zoom || 1;
    const panX = this.board.panX || 0;
    const panY = this.board.panY || 0;

    const screenX = canvasX * zoom + panX;
    const screenY = canvasY * zoom + panY;

    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;

    const containerRect = this.board.container.getBoundingClientRect();

    let left = containerRect.left + screenX + 10;
    let top = containerRect.top + screenY + 10;

    left = Math.max(10, Math.min(left, window.innerWidth - menuWidth - 10));
    top = Math.max(10, Math.min(top, window.innerHeight - menuHeight - 10));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  /**
   * Hides the selection context menu.
   */
  hideContextMenu() {
    if (this.menuElements?.menu) {
      this.menuElements.menu.style.display = 'none';
    }
  }

  /**
   * Checks if the selection has been moved or transformed.
   * @returns {boolean}
   */
  hasBeenMoved() {
    if (!this.originalSelectionPos || !this.selection) return false;
    if (this.floatingCanvas && this.originalSelectionPos.x === -1 && this.originalSelectionPos.y === -1) {
      return true;
    }
    return (
      Math.abs(this.selection.x - this.originalSelectionPos.x) > 1 ||
      Math.abs(this.selection.y - this.originalSelectionPos.y) > 1 ||
      this.hasScaledSelection() ||
      this.hasTransformedCorners() ||
      Math.abs(this.rotation) > 0.01
    );
  }

  /**
   * Updates the cursor style based on pointer position.
   * @param {{x: number, y: number}} pos
   */
  updateCursor(pos) {
    if (!this.board.container) return;

    this.updateHandles();
    const handle = this.getHandleAtPoint(pos);
    if (handle) {
      if (handle.id === 'rotate') {
        this.board.container.style.cursor = 'grab';
        return;
      }
      const cursorMap = {
        'tl': 'nwse-resize', 'br': 'nwse-resize',
        'tr': 'nesw-resize', 'bl': 'nesw-resize',
        'tm': 'ns-resize', 'bm': 'ns-resize',
        'ml': 'ew-resize', 'mr': 'ew-resize',
        'ptl': 'grab', 'ptr': 'grab', 'pbl': 'grab', 'pbr': 'grab'
      };
      this.board.container.style.cursor = cursorMap[handle.id] || 'move';
      return;
    }

    if (this.selection && this.isInsideSelection(pos)) {
      this.board.container.style.cursor = 'move';
      if (this.board.app?.ui) {
        this.board.app.ui.setSelectCursor(true);
      }
      return;
    }

    this.board.container.style.cursor = 'crosshair';
    if (this.board.app?.ui) {
      this.board.app.ui.setSelectCursor(false);
    }
  }

  /**
   * Starts the "marching ants" selection border animation.
   */
  startMarchingAnts() {
    if (this.animationId) return;

    const animate = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 1) % 16;
      if (this.selection && !this.isDragging && !this.isTransforming && !this.activeHandle && !this.isSelecting && !this.isRotating) {
        this.board.clearTop();
        if (this.isMaskMode) {
          this.board.drawMaskDarkenOverlay(this.marchingAntsOffset);
          if (this.floatingCanvas) {
            this.drawFloatingSelection();
          }
        } else if (this.floatingCanvas) {
          this.drawFloatingSelection();
          this.drawMarchingAntsOnly();
        } else {
          this.drawMarchingAntsOnly();
        }
      }
      this.animationId = requestAnimationFrame(animate);
    };
    this.animationId = requestAnimationFrame(animate);
  }

  /**
   * Draws the animated selection border and handles.
   */
  drawMarchingAntsOnly() {
    if (!this.selection) return;

    const ctx = this.board.topCtx;
    // Use selection overlay for outline and handles (can extend beyond canvas edge)
    const overlayCtx = this.board.getSelectionCtx() || ctx;

    if (this.corners && this.hasTransformedCorners()) {
      this.drawTransformOutline(overlayCtx);
      this.drawTransformHandles(overlayCtx);
    } else if (this.mode === 'lasso' && this.lassoSimplified && this.lassoSimplified.length > 0 && !this.floatingCanvas) {
      const lasso = this.lassoSimplified;
      this._strokeMarchingAnts(overlayCtx, this.marchingAntsOffset, () => {
        overlayCtx.beginPath();
        overlayCtx.moveTo(lasso[0].x, lasso[0].y);
        for (let i = 1; i < lasso.length; i++) overlayCtx.lineTo(lasso[i].x, lasso[i].y);
        overlayCtx.closePath();
        overlayCtx.stroke();
      });

      const s = this.selection;
      overlayCtx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      overlayCtx.lineWidth = 1;
      overlayCtx.strokeRect(s.x, s.y, s.width, s.height);

      this.updateHandles();
      this._drawHandles(overlayCtx);
    } else {
      const s = this.selection;
      this._strokeMarchingAnts(overlayCtx, this.marchingAntsOffset, () => overlayCtx.strokeRect(s.x, s.y, s.width, s.height));

      this.updateHandles();
      this._drawHandles(overlayCtx);
    }

    this.board.restoreSelectionCtx();
    this._drawMirrorGhost(ctx);
  }

  /**
   * Draws all handles on the given context.
   * @param {CanvasRenderingContext2D} ctx
   */
  /**
   * Draws the selection handles. Delegates to {@link _drawSelectionUIHandles},
   * which renders the identical handle set in correct z-order (perspective
   * lines → perspective circles → corner squares → rotation handle on top).
   */
  _drawHandles() {
    this._drawSelectionUIHandles();
  }

  /**
   * Draws a ghost marching-ants outline of the selection as each active mirror
   * will reproduce it — one per region, so a radial region shows every slice.
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawMirrorGhost(ctx) {
    if (!this.selection) return;

    const s = this.selection;
    let shape;

    if (this.corners && this.hasTransformedCorners()) {
      const c = this.corners;
      shape = [c.tl, c.tr, c.br, c.bl];
    } else if (this.mode === 'lasso' && this.lassoSimplified && this.lassoSimplified.length > 0 && !this.floatingCanvas) {
      shape = this.lassoSimplified;
    } else {
      shape = [
        { x: s.x, y: s.y },
        { x: s.x + s.width, y: s.y },
        { x: s.x + s.width, y: s.y + s.height },
        { x: s.x, y: s.y + s.height }
      ];
    }

    this._strokeMirroredOutline(ctx, shape, this.marchingAntsOffset, true);
  }

  /**
   * Stops the marching ants animation.
   */
  stopMarchingAnts() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  onPointerDown(user, pos) {
    // Hide menu when starting any interaction
    this.hideContextMenu();

    // Initialize lasso points if in lasso mode and starting new selection
    if (this.mode === 'lasso' && !this.selection) {
      this.lassoPoints = [{ x: pos.x, y: pos.y }];
      this.pendingSelectionPreviewBroadcast = null;
    }

    // Check if clicking a transform handle FIRST (higher priority than dragging)
    this.updateHandles();
    const handle = this.getHandleAtPoint(pos);
    if (handle) {
      // Special handling for rotation handle
      if (handle.id === 'rotate') {
        this.isRotating = true;
        const center = this.getSelectionCenter();
        this.rotationStartAngle = Math.atan2(pos.y - center.y, pos.x - center.x);

        // Lift selection if not already lifted (skipped in mask mode)
        if (!this.floatingCanvas && !this.isMaskMode) {
          this.liftSelection();
        }

        // Store current corners at the start of rotation
        if (this.corners) {
          this.cornersAtRotationStart = {
            tl: { ...this.corners.tl },
            tr: { ...this.corners.tr },
            bl: { ...this.corners.bl },
            br: { ...this.corners.br }
          };
        }
        return;
      }

      this.activeHandle = handle;
      return;
    }

    // Check if clicking inside existing selection to drag it
    if (this.selection && this.isInsideSelection(pos)) {
      this.isDragging = true;
      this.dragOffset = {
        x: pos.x - this.selection.x,
        y: pos.y - this.selection.y
      };

      // If we haven't lifted the selection yet, do it now (skipped in mask mode)
      if (!this.floatingCanvas && !this.isMaskMode) {
        this.liftSelection();
      }
      return;
    }

    // Commit any existing selection before starting a new one
    if (this.selection) {
      if (this.isMaskMode) {
        this.board.clearSelectionMask();
        this.board.app?.wsClient?.broadcastSelectionMask(false);
        this.isMaskMode = false;
      }
      this.commitSelection();
      this.clearSelection();
    }

    // Start new selection
    this.isSelecting = true;
    this.startPos = { x: pos.x, y: pos.y };
    this.livePreviewDashOffset = 0;
  }

  onPointerMove(user, pos) {
    // Handle rotation
    if (this.isRotating && this.selection && this.cornersAtRotationStart) {
      // Calculate center from the corners at rotation start
      const startCorners = this.cornersAtRotationStart;
      const center = {
        x: (startCorners.tl.x + startCorners.tr.x + startCorners.bl.x + startCorners.br.x) / 4,
        y: (startCorners.tl.y + startCorners.tr.y + startCorners.bl.y + startCorners.br.y) / 4
      };

      const currentAngle = Math.atan2(pos.y - center.y, pos.x - center.x);
      const deltaAngle = currentAngle - this.rotationStartAngle;

      // Update corners based on rotation delta from start position
      this.updateCornersFromRotation(deltaAngle);
      // Update selection bounds from rotated corners
      this.updateSelectionFromCorners();

      // Broadcast the rotation to other users (throttled for performance)
      if (this.corners) {
        this.throttledBroadcastSelectionMove(this.corners);
      }

      this.board.clearTop();
      // Use homography-based preview (corners are now rotated)
      this.drawTransformPreview();
      return;
    }

    if (this.isDragging && this.selection) {
      // Calculate movement delta
      const newX = Math.round(pos.x - this.dragOffset.x);
      const newY = Math.round(pos.y - this.dragOffset.y);
      const dx = newX - this.selection.x;
      const dy = newY - this.selection.y;

      // Move the selection (ensure integer coordinates)
      this.selection.x = newX;
      this.selection.y = newY;

      // Also move all corners
      if (this.corners) {
        this.corners.tl.x += dx;
        this.corners.tl.y += dy;
        this.corners.tr.x += dx;
        this.corners.tr.y += dy;
        this.corners.bl.x += dx;
        this.corners.bl.y += dy;
        this.corners.br.x += dx;
        this.corners.br.y += dy;

        // Broadcast the move to other users (throttled for performance)
        this.throttledBroadcastSelectionMove(this.corners);
      }

      // Also translate lasso path points to match the new position
      if (this.lassoPath) {
        this.lassoPath = this.lassoPath.map(p => ({
          x: p.x + dx,
          y: p.y + dy
        }));
      }

      // Also translate the simplified lasso path for rendering
      if (this.lassoSimplified) {
        this.lassoSimplified = this.lassoSimplified.map(p => ({
          x: p.x + dx,
          y: p.y + dy
        }));
      }

      if (this.isMaskMode) this._applyCurrentMaskToBoard();
      this.board.clearTop();
      this.drawSelectionUI();
      return;
    }

    if (this.activeHandle && this.selection) {
      // Lift selection if not already lifted (skipped in mask mode)
      if (!this.floatingCanvas && !this.isMaskMode) {
        this.liftSelection();
      }

      // Update corner position based on which handle is being dragged
      this.updateCornerFromHandle(this.activeHandle.id, pos);
      this.isTransforming = true;

      // Broadcast the transform to other users (throttled for performance)
      if (this.corners) {
        this.throttledBroadcastSelectionMove(this.corners);
      }

      // Redraw with transform preview
      this.board.clearTop();
      this.drawTransformPreview();
      return;
    }

    if (!this.isSelecting || !this.startPos) {
      // Not doing anything - update cursor based on position
      this.updateCursor(pos);
      return;
    }

    // Mode-specific selection drawing
    if (this.mode === 'lasso') {
      this.livePreviewDashOffset = (this.livePreviewDashOffset + 0.35) % 16;
      // Collect lasso points
      this.lassoPoints.push({ x: pos.x, y: pos.y });

      // Redraw lasso preview
      this.board.clearTop();
      this.drawLassoPreview(this.board.topCtx, this.lassoPoints);

      if (this.lassoPoints.length >= 2) {
        const pendingBounds = this.getBoundsFromPoints(this.lassoPoints);
        this.throttledBroadcastSelectionPending(pendingBounds, this.lassoPoints);
      }
    } else {
      // Rectangle mode (existing code)
      this.livePreviewDashOffset = (this.livePreviewDashOffset + 0.35) % 16;
      this.board.clearTop();
      
      const minX = Math.min(this.startPos.x, pos.x);
      const minY = Math.min(this.startPos.y, pos.y);
      const maxX = Math.max(this.startPos.x, pos.x);
      const maxY = Math.max(this.startPos.y, pos.y);

      const x = Math.floor(minX);
      const y = Math.floor(minY);
      const width = Math.ceil(maxX) - x;
      const height = Math.ceil(maxY) - y;

      this.drawSelectionBox(this.board.topCtx, { x, y }, { x: x + width, y: y + height });

      this._strokeMirroredOutline(
        this.board.topCtx,
        [
          { x, y },
          { x: x + width, y },
          { x: x + width, y: y + height },
          { x, y: y + height }
        ],
        this.livePreviewDashOffset,
        true
      );

      this.throttledBroadcastSelectionPending({ x, y, width, height });
    }
  }

  onPointerUp(user, pos) {
    // Capture pointer up position for menu positioning
    this.lastPointerUpPos = { x: pos.x, y: pos.y };

    if (this.isRotating) {
      this.isRotating = false;
      this.cornersAtRotationStart = null;
      // Flush any pending broadcast to ensure final rotation state is sent
      this.flushPendingSelectionBroadcast();
      this.board.clearTop();
      // Use homography-based preview (corners are rotated)
      this.drawTransformPreview();
      this.showContextMenu();
      return;
    }

    if (this.isDragging) {
      this.isDragging = false;
      if (this.isMaskMode) this._applyCurrentMaskToBoard(true);
      // Flush any pending broadcast to ensure final drag position is sent
      this.flushPendingSelectionBroadcast();
      this.drawSelectionUI();
      this.updateCursor(pos);
      this.showContextMenu();
      return;
    }

    if (this.activeHandle) {
      const releasedHandleId = this.activeHandle.id;
      // Don't apply transform yet - keep handles in place for layered transforms
      // Transform will be applied when committing the selection
      this.activeHandle = null;
      this.isTransforming = false;
      if (this.isMaskMode) this._applyCurrentMaskToBoard(true);
      const sourceCrop = this.cropScaledSelectionToContent(releasedHandleId);
      if (sourceCrop) {
        this.pendingSelectionBroadcast = null;
        this.board.app?.inputBufferManager?.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionMove(this.corners, sourceCrop, this.extendedWarp), { snapshot: false });
        this.lastSelectionBroadcastTime = performance.now();
      }
      // Flush any pending broadcast to ensure final transform state is sent
      this.flushPendingSelectionBroadcast();
      this.showContextMenu();
      this.board.clearTop();
      // Draw the transform preview (keeps showing warped result)
      if (this.floatingCanvas && this.corners) {
        this.drawTransformPreview();
      } else {
        this.drawSelectionUI();
      }
      return;
    }

    if (!this.isSelecting || !this.startPos) return;

    this.isSelecting = false;
    this.flushPendingSelectionPreviewBroadcast();

    if (this.mode === 'lasso') {
      // Finalize lasso selection
      if (this.lassoPoints.length < 3) {
        // Too few points - cancel
        this.board.clearTop();
        this.lassoPoints = [];
        this.startPos = null;
        return;
      }

      // Simplify the path
      const threshold = 3; // pixels
      this.lassoSimplified = distanceBasedCulling(this.lassoPoints, threshold);

      // Use the simplified path directly for point-in-polygon testing
      // The pointInHull winding number algorithm works with any polygon, not just convex hulls
      this.lassoPath = this.lassoSimplified;

      // Get bounding box
      const bounds = this.getBoundsFromPoints(this.lassoSimplified);

      // Minimum selection size check
      if (bounds.width < 5 || bounds.height < 5) {
        this.board.clearTop();
        this.lassoPoints = [];
        this.lassoSimplified = null;
        this.lassoPath = null;
        this.startPos = null;
        return;
      }

      this.selection = bounds;
      this.cropNewSelectionToContent();
      this.originalSelectionPos = { x: this.selection.x, y: this.selection.y };
      this.startPos = null;

      // Initialize corners for transform
      this.initializeCorners();
      this.updateHandles();

      if (this.isMaskMode) this._applyCurrentMaskToBoard(true);
      this.board.clearTop();
      this.drawSelectionUI();
      this.updateCursor(pos);
      this.showContextMenu();

      // Broadcast the selection marquee (not yet lifted)
      if (this.board.app?.wsClient) {
        this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionPending(this.selection, this.lassoPath), { snapshot: false });
      }
    } else {
      // Rectangle mode (existing code)
      const minX = Math.min(this.startPos.x, pos.x);
      const minY = Math.min(this.startPos.y, pos.y);
      const maxX = Math.max(this.startPos.x, pos.x);
      const maxY = Math.max(this.startPos.y, pos.y);

      const x = Math.floor(minX);
      const y = Math.floor(minY);
      const width = Math.ceil(maxX) - x;
      const height = Math.ceil(maxY) - y;

      // Minimum selection size
      if (width < 5 || height < 5) {
        this.board.clearTop();
        this.startPos = null;
        return;
      }

      this.selection = { x, y, width, height };
      this.cropNewSelectionToContent();
      this.startPos = null;

      // Store original position to detect moves
      this.originalSelectionPos = { x: this.selection.x, y: this.selection.y };

      // Initialize corners for transform
      this.initializeCorners();
      this.updateHandles();

      if (this.isMaskMode) this._applyCurrentMaskToBoard(true);
      this.board.clearTop();
      this.drawSelectionUI();
      this.updateCursor(pos);
      this.showContextMenu();

      // Broadcast the selection marquee (not yet lifted)
      if (this.board.app?.wsClient) {
        this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionPending(this.selection), { snapshot: false });
      }
    }
  }

  initializeCorners() {
    if (!this.selection) return;

    const s = this.selection;
    this.corners = {
      tl: { x: s.x, y: s.y },
      tr: { x: s.x + s.width, y: s.y },
      bl: { x: s.x, y: s.y + s.height },
      br: { x: s.x + s.width, y: s.y + s.height }
    };
    // Store original corners (in image coordinates, relative to top-left of selection)
    this.originalCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: s.width, y: 0 },
      bl: { x: 0, y: s.height },
      br: { x: s.width, y: s.height }
    };
  }

  updateCornerFromHandle(handleId, pos) {
    if (!this.corners) return;

    const c = this.corners;

    // CASE 1: Perspective handles - free-form corner movement
    if (['ptl', 'ptr', 'pbl', 'pbr'].includes(handleId)) {
      const cornerMap = { ptl: 'tl', ptr: 'tr', pbl: 'bl', pbr: 'br' };
      const cornerId = cornerMap[handleId];

      // Free-form perspective control - just move the corner
      c[cornerId].x = pos.x;
      c[cornerId].y = pos.y;

      // Update selection bounds to encompass all corners
      this.updateSelectionFromCorners();
      return;
    }

    // CASE 2: Corner scale handles - scale all corners proportionally from center
    if (['tl', 'tr', 'bl', 'br'].includes(handleId)) {
      // Calculate current bounding box
      const oldMinX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const oldMaxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const oldMinY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const oldMaxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const oldWidth = oldMaxX - oldMinX;
      const oldHeight = oldMaxY - oldMinY;

      // Determine which corner of bounding box is being dragged
      const oppositeMap = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
      const oppositeId = oppositeMap[handleId];

      // Get the opposite corner position (fixed point)
      const oppositeBBoxCorner = {
        tl: { x: oldMinX, y: oldMinY },
        tr: { x: oldMaxX, y: oldMinY },
        bl: { x: oldMinX, y: oldMaxY },
        br: { x: oldMaxX, y: oldMaxY }
      }[oppositeId];

      // Calculate new bounding box
      const newMinX = Math.min(pos.x, oppositeBBoxCorner.x);
      const newMaxX = Math.max(pos.x, oppositeBBoxCorner.x);
      const newMinY = Math.min(pos.y, oppositeBBoxCorner.y);
      const newMaxY = Math.max(pos.y, oppositeBBoxCorner.y);
      const newWidth = newMaxX - newMinX;
      const newHeight = newMaxY - newMinY;

      // Calculate scale factors
      const scaleX = oldWidth > 0 ? newWidth / oldWidth : 1;
      const scaleY = oldHeight > 0 ? newHeight / oldHeight : 1;

      // Use uniform scale to maintain aspect ratio (use smaller absolute scale)
      const uniformScale = Math.abs(scaleX) < Math.abs(scaleY) ? scaleX : scaleY;

      // Scale all corners relative to the opposite corner
      const scaleCorner = (corner) => ({
        x: oppositeBBoxCorner.x + (corner.x - oppositeBBoxCorner.x) * uniformScale,
        y: oppositeBBoxCorner.y + (corner.y - oppositeBBoxCorner.y) * uniformScale
      });

      c.tl = scaleCorner(c.tl);
      c.tr = scaleCorner(c.tr);
      c.bl = scaleCorner(c.bl);
      c.br = scaleCorner(c.br);

      this.updateSelectionFromCorners();
      return;
    }

    // CASE 3: Edge handles - scale proportionally along one axis
    const oldMinX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const oldMaxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const oldMinY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    const oldMaxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);

    switch (handleId) {
      case 'tm': { // Top middle - scale vertically from bottom
        const oldHeight = oldMaxY - oldMinY;
        const newMinY = pos.y;
        const newHeight = oldMaxY - newMinY;
        const scaleY = oldHeight > 0 ? newHeight / oldHeight : 1;

        c.tl.y = oldMaxY - (oldMaxY - c.tl.y) * scaleY;
        c.tr.y = oldMaxY - (oldMaxY - c.tr.y) * scaleY;
        c.bl.y = oldMaxY - (oldMaxY - c.bl.y) * scaleY;
        c.br.y = oldMaxY - (oldMaxY - c.br.y) * scaleY;
        break;
      }
      case 'bm': { // Bottom middle - scale vertically from top
        const oldHeight = oldMaxY - oldMinY;
        const newMaxY = pos.y;
        const newHeight = newMaxY - oldMinY;
        const scaleY = oldHeight > 0 ? newHeight / oldHeight : 1;

        c.tl.y = oldMinY + (c.tl.y - oldMinY) * scaleY;
        c.tr.y = oldMinY + (c.tr.y - oldMinY) * scaleY;
        c.bl.y = oldMinY + (c.bl.y - oldMinY) * scaleY;
        c.br.y = oldMinY + (c.br.y - oldMinY) * scaleY;
        break;
      }
      case 'ml': { // Middle left - scale horizontally from right
        const oldWidth = oldMaxX - oldMinX;
        const newMinX = pos.x;
        const newWidth = oldMaxX - newMinX;
        const scaleX = oldWidth > 0 ? newWidth / oldWidth : 1;

        c.tl.x = oldMaxX - (oldMaxX - c.tl.x) * scaleX;
        c.tr.x = oldMaxX - (oldMaxX - c.tr.x) * scaleX;
        c.bl.x = oldMaxX - (oldMaxX - c.bl.x) * scaleX;
        c.br.x = oldMaxX - (oldMaxX - c.br.x) * scaleX;
        break;
      }
      case 'mr': { // Middle right - scale horizontally from left
        const oldWidth = oldMaxX - oldMinX;
        const newMaxX = pos.x;
        const newWidth = newMaxX - oldMinX;
        const scaleX = oldWidth > 0 ? newWidth / oldWidth : 1;

        c.tl.x = oldMinX + (c.tl.x - oldMinX) * scaleX;
        c.tr.x = oldMinX + (c.tr.x - oldMinX) * scaleX;
        c.bl.x = oldMinX + (c.bl.x - oldMinX) * scaleX;
        c.br.x = oldMinX + (c.br.x - oldMinX) * scaleX;
        break;
      }
    }

    // Update selection bounds based on corners
    this.updateSelectionFromCorners();
  }

  updateSelectionFromCorners() {
    if (!this.corners) return;

    const c = this.corners;
    const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);

    const x = Math.floor(minX);
    const y = Math.floor(minY);
    this.selection.x = x;
    this.selection.y = y;
    this.selection.width = Math.ceil(maxX) - x;
    this.selection.height = Math.ceil(maxY) - y;
  }

  isAxisAlignedCornerRect(corners = this.corners) {
    if (!corners) return false;

    const tolerance = 0.5;
    return (
      Math.abs(corners.tl.y - corners.tr.y) <= tolerance &&
      Math.abs(corners.bl.y - corners.br.y) <= tolerance &&
      Math.abs(corners.tl.x - corners.bl.x) <= tolerance &&
      Math.abs(corners.tr.x - corners.br.x) <= tolerance
    );
  }

  needsHomographyTransform() {
    return !!(this.corners && this.originalCorners && (this.rotation !== 0 || !this.isAxisAlignedCornerRect()));
  }

  // Output window for the warp: widened when it spills beyond the corner bbox
  // (concave/crossed quads), cropped to the board when the quad reaches outside
  // it. Null when the default corner-bbox window is already right, or when
  // extendedWarp is off (folded quads just clip at the corner bbox).
  _getWarpOutputBounds() {
    if (!this.extendedWarp) return null;
    return computeWarpOutputBounds(this.originalCorners, this.corners, {
      minX: 0,
      minY: 0,
      maxX: this.board.getWidth(),
      maxY: this.board.getHeight()
    });
  }

  getRectScaledCanvas(sourceCanvas = this.floatingCanvas) {
    if (!sourceCanvas || !this.selection) return sourceCanvas;

    const width = Math.max(1, Math.round(this.selection.width));
    const height = Math.max(1, Math.round(this.selection.height));
    if (sourceCanvas.width === width && sourceCanvas.height === height) {
      return sourceCanvas;
    }

    const scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = width;
    scaledCanvas.height = height;
    const scaledCtx = scaledCanvas.getContext('2d');
    scaledCtx.drawImage(sourceCanvas, 0, 0, width, height);
    return scaledCanvas;
  }

  _findCanvasContentBounds(canvas) {
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < canvas.height; y++) {
      const row = y * canvas.width * 4;
      for (let x = 0; x < canvas.width; x++) {
        if (data[row + x * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < minX || maxY < minY) return null;
    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1
    };
  }

  _cropCanvasToBounds(canvas, bounds) {
    if (!canvas || !bounds) return canvas;
    const cropped = document.createElement('canvas');
    cropped.width = Math.max(1, bounds.width);
    cropped.height = Math.max(1, bounds.height);
    const ctx = cropped.getContext('2d');
    ctx.drawImage(
      canvas,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      bounds.width,
      bounds.height
    );
    return cropped;
  }

  cropNewSelectionToContent() {
    if (!this.selection || this.floatingCanvas) return false;
    if (!this.fitToContent || this.isMaskMode) return false;

    const s = this.selection;
    if (s.width <= 0 || s.height <= 0) return false;

    const contentCanvas = this._flattenSelectionToCanvas(s);
    if (this.mode === 'lasso' && this.lassoPath) {
      this.applyLassoMask(contentCanvas.getContext('2d'), s.x, s.y, this.lassoPath);
    }

    const contentBounds = this._findCanvasContentBounds(contentCanvas);
    if (!contentBounds) return false;
    if (
      contentBounds.x === 0 &&
      contentBounds.y === 0 &&
      contentBounds.width === s.width &&
      contentBounds.height === s.height
    ) {
      return false;
    }

    // Store the original uncropped selection for use in fills
    if (!this.originalSelection) {
      this.originalSelection = { ...s };
    }

    this.selection = {
      x: s.x + contentBounds.x,
      y: s.y + contentBounds.y,
      width: contentBounds.width,
      height: contentBounds.height
    };
    return true;
  }

  cropScaledSelectionToContent(handleId = null) {
    if (!this.floatingCanvas || !this.selection) return false;
    if (handleId && !['tl', 'tr', 'bl', 'br', 'tm', 'bm', 'ml', 'mr'].includes(handleId)) return false;
    if (this.needsHomographyTransform()) return false;
    if (!this.hasScaledSelection()) return false;

    const sourceWidth = this.floatingCanvas.width;
    const sourceHeight = this.floatingCanvas.height;
    if (sourceWidth <= 0 || sourceHeight <= 0) return false;

    const contentBounds = this._findCanvasContentBounds(this.floatingCanvas);
    if (!contentBounds) return false;
    if (
      contentBounds.x === 0 &&
      contentBounds.y === 0 &&
      contentBounds.width === sourceWidth &&
      contentBounds.height === sourceHeight
    ) {
      return false;
    }

    const currentSelection = { ...this.selection };
    const previousTotalCrop = this._sourceCropForRemote;
    const totalCrop = previousTotalCrop
      ? {
          x: previousTotalCrop.x + contentBounds.x,
          y: previousTotalCrop.y + contentBounds.y,
          width: contentBounds.width,
          height: contentBounds.height
        }
      : { ...contentBounds };
    const nextSelection = {
      x: currentSelection.x + (contentBounds.x / sourceWidth) * currentSelection.width,
      y: currentSelection.y + (contentBounds.y / sourceHeight) * currentSelection.height,
      width: (contentBounds.width / sourceWidth) * currentSelection.width,
      height: (contentBounds.height / sourceHeight) * currentSelection.height
    };

    this.floatingCanvas = this._cropCanvasToBounds(this.floatingCanvas, contentBounds);
    this.floatingCtx = this.floatingCanvas.getContext('2d');
    if (this.floatingLayers) {
      this.floatingLayers = this.floatingLayers.map(({ canvas, groupIdx }) => ({
        canvas: this._cropCanvasToBounds(canvas, contentBounds),
        groupIdx
      }));
    }
    this.selectedImageData = this.floatingCtx.getImageData(0, 0, this.floatingCanvas.width, this.floatingCanvas.height);
    this.selection = nextSelection;
    this._sourceCropForRemote = totalCrop;
    this._cachedTransform = null;
    this.initializeCorners();
    this.updateHandles();
    return {
      x: contentBounds.x,
      y: contentBounds.y,
      width: contentBounds.width,
      height: contentBounds.height,
      total: totalCrop
    };
  }


  drawTransformPreview() {
    if (!this.floatingCanvas || !this.corners || !this.originalCorners) return;

    const ctx = this.board.topCtx;

    if (!this.needsHomographyTransform()) {
      this._cachedTransform = null;
      const s = this.selection;
      const paint = (c) => c.drawImage(this.floatingCanvas, s.x, s.y, s.width, s.height);
      paint(ctx);
      this._paintMirroredPreview(ctx, s, paint);

      const handleCtx = this.board.getSelectionCtx() || ctx;
      this.drawTransformOutline(handleCtx);
      this.drawTransformHandles(handleCtx);
      this.board.restoreSelectionCtx();
      return;
    }

    if (!this._drawWarpedFloatingSelection(ctx, 'medium')) {
      // Fallback: just draw the original floating selection
      this.drawFloatingSelection();
    }

    // Draw the quadrilateral outline and handles (on selection overlay so they can extend beyond canvas)
    const handleCtx = this.board.getSelectionCtx() || ctx;
    this.drawTransformOutline(handleCtx);
    this.drawTransformHandles(handleCtx);
    this.board.restoreSelectionCtx();
  }

  // Warp the floating canvas through the current corner homography and draw it,
  // caching the result. Folded (concave/crossed) quads get an expanded output
  // window so the warp isn't cut off at the corner bbox.
  // Returns false if the warp failed and nothing was drawn.
  _drawWarpedFloatingSelection(ctx, quality) {
    const bounds = calculateCornerBounds(this.corners);
    const outputBounds = this._getWarpOutputBounds();

    // Key from corner positions relative to bounds (translation-invariant) so a
    // pure move reuses the cache. Expanded windows are board-clamped, so the
    // key must also pin the absolute position.
    let cornersKey = `${(this.corners.tl.x - bounds.minX).toFixed(2)},${(this.corners.tl.y - bounds.minY).toFixed(2)},` +
                     `${(this.corners.tr.x - bounds.minX).toFixed(2)},${(this.corners.tr.y - bounds.minY).toFixed(2)},` +
                     `${(this.corners.bl.x - bounds.minX).toFixed(2)},${(this.corners.bl.y - bounds.minY).toFixed(2)},` +
                     `${(this.corners.br.x - bounds.minX).toFixed(2)},${(this.corners.br.y - bounds.minY).toFixed(2)}`;
    if (outputBounds) {
      cornersKey += `|${outputBounds.minX},${outputBounds.minY},${outputBounds.width},${outputBounds.height},` +
                    `${Math.round(bounds.minX)},${Math.round(bounds.minY)}`;
    }

    // Check if we can use the cached transform (corners shape hasn't changed, only position)
    if (this._cachedTransform && this._cachedTransform.cornersKey === cornersKey) {
      this._blitWarpedPreview(ctx, this._cachedTransform.canvas, this._cachedTransform.drawRect, bounds, quality);
      return true;
    }

    // Need to recalculate transform - use downsampled preview for better performance
    const srcMaxDim = Math.max(this.floatingCanvas.width, this.floatingCanvas.height);
    let previewScale = srcMaxDim > this.previewMaxSize ? this.previewMaxSize / srcMaxDim : 1;
    // The output raster is sized by the *destination* window, not the source, so
    // it can dwarf the source even after previewMaxSize. Cap its pixel count so
    // the per-frame warp stays cheap however far the corners are dragged.
    const MAX_PREVIEW_OUTPUT_PIXELS = 1.5e6;
    const outW = outputBounds ? outputBounds.width : bounds.width;
    const outH = outputBounds ? outputBounds.height : bounds.height;
    const outPixels = outW * outH * previewScale * previewScale;
    if (outPixels > MAX_PREVIEW_OUTPUT_PIXELS) {
      previewScale *= Math.sqrt(MAX_PREVIEW_OUTPUT_PIXELS / outPixels);
    }
    // Reuse or create preview homography instance
    if (!this.previewHomography) {
      this.previewHomography = new Homography('projective');
    }

    // Perform the transform using shared utility
    const result = performHomographyTransform({
      sourceCanvas: this.floatingCanvas,
      sourceCorners: this.originalCorners,
      destCorners: this.corners,
      scale: previewScale,
      homographyInstance: this.previewHomography,
      outputBounds
    });

    if (!result) {
      this._cachedTransform = null;
      return false;
    }

    // Cache the transformed canvas
    const tempCanvas = imageDataToCanvas(result.imageData);
    const drawRect = outputBounds
      ? { x: outputBounds.minX, y: outputBounds.minY, width: outputBounds.width, height: outputBounds.height }
      : null;
    this._cachedTransform = {
      canvas: tempCanvas,
      bounds: { width: bounds.width, height: bounds.height },
      cornersKey,
      drawRect
    };

    // Draw the warped result scaled up to full size
    this._blitWarpedPreview(ctx, tempCanvas, drawRect, bounds, quality);
    return true;
  }

  /**
   * Blits a warp result to the preview context and repeats it into every mirror.
   * Single place both the cache-hit and fresh-warp paths go through, so the
   * mirrored copies cannot be drawn on one path and forgotten on the other.
   * @private
   */
  _blitWarpedPreview(ctx, canvas, drawRect, bounds, quality) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = quality;
    const paint = drawRect
      ? (c) => c.drawImage(canvas, drawRect.x, drawRect.y, drawRect.width, drawRect.height)
      : (c) => c.drawImage(canvas, Math.round(bounds.minX), Math.round(bounds.minY), bounds.width, bounds.height);
    paint(ctx);
    this._paintMirroredPreview(ctx, drawRect || {
      x: Math.round(bounds.minX),
      y: Math.round(bounds.minY),
      width: bounds.width,
      height: bounds.height,
    }, paint);
  }

  drawTransformOutline(ctx) {
    if (!this.corners) return;

    const c = this.corners;
    this._strokeMarchingAnts(ctx, this.marchingAntsOffset, () => {
      ctx.beginPath();
      ctx.moveTo(c.tl.x, c.tl.y);
      ctx.lineTo(c.tr.x, c.tr.y);
      ctx.lineTo(c.br.x, c.br.y);
      ctx.lineTo(c.bl.x, c.bl.y);
      ctx.closePath();
      ctx.stroke();
    });

    // Ghost the warped quad in each mirror so the outline tracks the preview it
    // belongs to instead of stopping at the unmirrored copy.
    this._strokeMirroredOutline(ctx, [c.tl, c.tr, c.br, c.bl], this.marchingAntsOffset, true);
  }

  drawTransformHandles(ctx) {
    if (!this.corners) return;

    const { squareSize, circleRadius, perspectiveDistance } = this._getHandleMetrics();
    const hctx = this.board.getHandleCtx();
    const toC = (p) => this.board.boardToContainerPos(p.x, p.y);

    const c = this.corners;
    const center = this.getSelectionCenter();

    // Calculate bounding box
    const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);

    const bbox = {
      tl: { x: minX, y: minY },
      tr: { x: maxX, y: minY },
      bl: { x: minX, y: maxY },
      br: { x: maxX, y: maxY }
    };

    // Draw bounding box rectangle (dashed gray line) — content-aligned, stays on
    // the board overlay so it tracks the selection while panning/zooming.
    const strokeBbox = (c2) => {
      c2.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      c2.lineWidth = 1;
      c2.setLineDash([4, 4]);
      c2.strokeRect(minX, minY, maxX - minX, maxY - minY);
      c2.setLineDash([]);
    };
    strokeBbox(ctx);
    const strokeBboxGhost = (c2) => {
      c2.save();
      c2.globalAlpha = 0.4;
      strokeBbox(c2);
      c2.restore();
    };
    this._paintMirroredPreview(
      ctx, { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, strokeBboxGhost
    );

    if (!hctx) return;

    // Bounding box handles
    const tm = { x: (bbox.tl.x + bbox.tr.x) / 2, y: (bbox.tl.y + bbox.tr.y) / 2 };
    const bboxHandlePositions = [
      bbox.tl, bbox.tr, bbox.bl, bbox.br,
      tm,
      { x: (bbox.bl.x + bbox.br.x) / 2, y: (bbox.bl.y + bbox.br.y) / 2 }, // bm
      { x: (bbox.tl.x + bbox.bl.x) / 2, y: (bbox.tl.y + bbox.bl.y) / 2 }, // ml
      { x: (bbox.tr.x + bbox.br.x) / 2, y: (bbox.tr.y + bbox.br.y) / 2 }  // mr
    ];

    // Draw perspective handles (extending from actual corners)
    const getPerspectiveHandlePos = (corner) => {
      const dx = corner.x - center.x;
      const dy = corner.y - center.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist === 0) {
        return { x: corner.x, y: corner.y };
      }

      const extendDist = dist + perspectiveDistance;
      return {
        x: center.x + (dx / dist) * extendDist,
        y: center.y + (dy / dist) * extendDist
      };
    };

    const perspectiveHandles = [
      { corner: c.tl, handle: getPerspectiveHandlePos(c.tl) },
      { corner: c.tr, handle: getPerspectiveHandlePos(c.tr) },
      { corner: c.bl, handle: getPerspectiveHandlePos(c.bl) },
      { corner: c.br, handle: getPerspectiveHandlePos(c.br) }
    ];

    const rotHandle = this.getRotationHandlePosition(center, tm.x, tm.y);

    /**
     * Draws the whole handle set through a board-space point mapping. The
     * handles live on a SCREEN-space overlay at a constant on-screen size, so
     * they cannot ride a mirrored canvas transform like the preview does —
     * mapping the board positions and re-running the same glyph code is the
     * equivalent, and it is only point math on top of numbers already computed.
     */
    const drawHandleSet = (mapBoard, alpha) => {
      const P = (p) => toC(mapBoard(p));
      hctx.save();
      hctx.globalAlpha = alpha;

      // Bounding box handles as white squares
      for (const pos of bboxHandlePositions) {
        const p = P(pos);
        hctx.fillStyle = '#fff';
        hctx.strokeStyle = '#000';
        hctx.lineWidth = 1;
        hctx.fillRect(p.x - squareSize / 2, p.y - squareSize / 2, squareSize, squareSize);
        hctx.strokeRect(p.x - squareSize / 2, p.y - squareSize / 2, squareSize, squareSize);
      }

      // Perspective handle connecting lines first (dark grey, very thin)
      for (const { corner, handle } of perspectiveHandles) {
        const a = P(corner);
        const b = P(handle);
        hctx.strokeStyle = '#222';
        hctx.lineWidth = 0.75;
        hctx.beginPath();
        hctx.moveTo(a.x, a.y);
        hctx.lineTo(b.x, b.y);
        hctx.stroke();
      }

      // Perspective handle circles
      for (const { handle } of perspectiveHandles) {
        const b = P(handle);
        hctx.fillStyle = '#88CCCC';
        hctx.strokeStyle = '#000';
        hctx.lineWidth = 1;
        hctx.beginPath();
        hctx.arc(b.x, b.y, circleRadius, 0, Math.PI * 2);
        hctx.fill();
        hctx.stroke();
      }

      // Rotation handle: connecting line from top-middle, then the circle
      const tmC = P(tm);
      const rotC = P(rotHandle);
      hctx.strokeStyle = '#000';
      hctx.lineWidth = 1;
      hctx.beginPath();
      hctx.moveTo(tmC.x, tmC.y);
      hctx.lineTo(rotC.x, rotC.y);
      hctx.stroke();

      hctx.fillStyle = '#fff';
      hctx.strokeStyle = '#000';
      hctx.beginPath();
      hctx.arc(rotC.x, rotC.y, circleRadius, 0, Math.PI * 2);
      hctx.fill();
      hctx.stroke();

      hctx.restore();
    };

    drawHandleSet((p) => p, 1);

    // Mirrored handle glyphs are intentionally not drawn: on high-order modes
    // (radial with many slices, fib) the repeated glyph set gets overwhelming.
    // The faded bbox outline (drawn above via _paintMirroredPreview) is enough
    // to show where each mirrored copy lands.
  }

  applyTransform() {
    if (!this.floatingCanvas || !this.corners || !this.originalCorners) return;

    // Reuse or create homography instance for full-resolution transform
    if (!this.homography) {
      this.homography = new Homography('projective');
    }

    // Perform the transform using shared utility
    const result = performHomographyTransform({
      sourceCanvas: this.floatingCanvas,
      sourceCorners: this.originalCorners,
      destCorners: this.corners,
      scale: 1, // Full resolution
      homographyInstance: this.homography,
      outputBounds: this._getWarpOutputBounds()
    });

    if (result) {
      // Create new floating canvas with transformed result
      this.floatingCanvas = imageDataToCanvas(result.imageData);
      this.floatingCtx = this.floatingCanvas.getContext('2d');

      // Update selection to match new bounds
      this.selection.x = result.bounds.minX;
      this.selection.y = result.bounds.minY;
      this.selection.width = result.bounds.width;
      this.selection.height = result.bounds.height;

      // Reset corners to new selection bounds
      this.initializeCorners();
    }
  }

  isInsideSelection(pos) {
    if (!this.selection) return false;

    // For lasso mode with path, use point-in-polygon test ONLY if not lifted yet
    // Once lifted, use rectangle bounds for dragging
    if (this.mode === 'lasso' && this.lassoPath && !this.floatingCanvas) {
      return pointInHull(pos, this.lassoPath);
    }

    // Rectangle mode or lifted selection - use bounding box
    const s = this.selection;
    return pos.x >= s.x && pos.x <= s.x + s.width &&
           pos.y >= s.y && pos.y <= s.y + s.height;
  }

  _getSelectionBoundsForHandles() {
    if (!this.selection) {
      return { width: 0, height: 0 };
    }

    if (!this.corners) {
      return {
        width: this.selection.width,
        height: this.selection.height
      };
    }

    const c = this.corners;
    const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);

    return {
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY)
    };
  }

  _getHandleMetrics() {
    const zoom = Math.max(0.01, this.board.zoom || 1);
    const bounds = this._getSelectionBoundsForHandles();
    const minDimScreen = Math.min(bounds.width, bounds.height) * zoom;

    // Keep handles stable on-screen while shrinking hit zones for tiny selections.
    const minScreenSize = 5;
    const minScreenHit = 6;
    const sizeCapFromSelection = Math.max(minScreenSize, minDimScreen * 0.18);
    const hitCapFromSelection = Math.max(minScreenHit, minDimScreen * 0.24);

    const effectiveScreenSize = Math.min(this.handleSize, sizeCapFromSelection);
    const effectiveScreenHit = Math.min(this.handleHitArea, hitCapFromSelection);

    // Handles render on the screen-space overlay (NOT zoom-scaled), so draw sizes
    // are plain on-screen CSS pixels. Square corner/edge handles stay a constant
    // on-screen size; the circle handles (rotation + perspective) ease from full
    // size (1.0) at <=100% zoom down to MIN_SCALE (0.75) at max zoom.
    // Hit-testing and handle POSITIONING happen in board space, so those values are
    // the on-screen target divided by zoom (board px = screen px / zoom).
    const MAX_ZOOM = 10;
    const MIN_SCALE = 0.75;
    const t = Math.min(1, Math.max(0, (zoom - 1) / (MAX_ZOOM - 1)));
    const circleScale = 1 - (1 - MIN_SCALE) * t;

    return {
      // Draw sizes — on-screen CSS pixels.
      squareSize: effectiveScreenSize,
      circleRadius: (effectiveScreenSize / 2 + 2) * circleScale,
      // Hit-test extents — board pixels.
      squareHit: effectiveScreenHit / zoom,
      circleHit: (effectiveScreenHit * circleScale) / zoom,
      // Gap (board px) from a corner to its perspective handle; the on-screen gap
      // eases with the circle scale. Rotation gap is held constant on-screen.
      perspectiveDistance: (this.perspectiveHandleDistance * circleScale) / zoom,
      rotationDistance: this.rotationHandleDistance / zoom
    };
  }

  getHandleAtPoint(pos) {
    const { squareHit, circleHit } = this._getHandleMetrics();

    for (const handle of this.handles) {
      const dx = pos.x - handle.x;
      const dy = pos.y - handle.y;
      const hitArea = (handle.isRotation || handle.isPerspective) ? circleHit : squareHit;
      if (Math.abs(dx) <= hitArea && Math.abs(dy) <= hitArea) {
        return handle;
      }
    }
    return null;
  }

  updateHandles() {
    if (!this.selection) {
      this.handles = [];
      return;
    }

    // Use corners if available (for perspective transform), otherwise use selection bounds
    if (this.corners) {
      const c = this.corners;
      const center = this.getSelectionCenter();

      // Calculate bounding box from actual corners (for scaling handles)
      const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);

      const bbox = {
        tl: { x: minX, y: minY },
        tr: { x: maxX, y: minY },
        bl: { x: minX, y: maxY },
        br: { x: maxX, y: maxY }
      };

      // Calculate perspective handle positions (extend outward from ACTUAL corners)
      const { perspectiveDistance } = this._getHandleMetrics();
      const getPerspectiveHandlePos = (corner) => {
        const dx = corner.x - center.x;
        const dy = corner.y - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist === 0) {
          return { x: corner.x, y: corner.y };
        }

        // Extend outward by the zoom-scaled perspective gap
        const extendDist = dist + perspectiveDistance;
        return {
          x: center.x + (dx / dist) * extendDist,
          y: center.y + (dy / dist) * extendDist
        };
      };

      const ptlPos = getPerspectiveHandlePos(c.tl);
      const ptrPos = getPerspectiveHandlePos(c.tr);
      const pblPos = getPerspectiveHandlePos(c.bl);
      const pbrPos = getPerspectiveHandlePos(c.br);

      // Calculate rotation handle position (from bounding box top-middle)
      const tmX = (bbox.tl.x + bbox.tr.x) / 2;
      const tmY = (bbox.tl.y + bbox.tr.y) / 2;
      const rotHandlePos = this.getRotationHandlePosition(center, tmX, tmY);

      this.handles = [
        // Corner handles on BOUNDING BOX (for scaling)
        { id: 'tl', x: bbox.tl.x, y: bbox.tl.y, type: 'scale' },
        { id: 'tr', x: bbox.tr.x, y: bbox.tr.y, type: 'scale' },
        { id: 'bl', x: bbox.bl.x, y: bbox.bl.y, type: 'scale' },
        { id: 'br', x: bbox.br.x, y: bbox.br.y, type: 'scale' },
        // Edge midpoint handles on BOUNDING BOX
        { id: 'tm', x: tmX, y: tmY, type: 'edge' },
        { id: 'bm', x: (bbox.bl.x + bbox.br.x) / 2, y: (bbox.bl.y + bbox.br.y) / 2, type: 'edge' },
        { id: 'ml', x: (bbox.tl.x + bbox.bl.x) / 2, y: (bbox.tl.y + bbox.bl.y) / 2, type: 'edge' },
        { id: 'mr', x: (bbox.tr.x + bbox.br.x) / 2, y: (bbox.tr.y + bbox.br.y) / 2, type: 'edge' },
        // Perspective handles at ACTUAL corners (for warping)
        { id: 'ptl', x: ptlPos.x, y: ptlPos.y, type: 'perspective', isPerspective: true },
        { id: 'ptr', x: ptrPos.x, y: ptrPos.y, type: 'perspective', isPerspective: true },
        { id: 'pbl', x: pblPos.x, y: pblPos.y, type: 'perspective', isPerspective: true },
        { id: 'pbr', x: pbrPos.x, y: pbrPos.y, type: 'perspective', isPerspective: true },
        // Rotation handle
        { id: 'rotate', x: rotHandlePos.x, y: rotHandlePos.y, isRotation: true }
      ];
    } else {
      const s = this.selection;
      const tmX = s.x + s.width / 2;
      const tmY = s.y;

      // Calculate rotation handle position
      const center = this.getSelectionCenter();
      const rotHandlePos = this.getRotationHandlePosition(center, tmX, tmY);

      this.handles = [
        { id: 'tl', x: s.x, y: s.y, type: 'scale' },
        { id: 'tr', x: s.x + s.width, y: s.y, type: 'scale' },
        { id: 'bl', x: s.x, y: s.y + s.height, type: 'scale' },
        { id: 'br', x: s.x + s.width, y: s.y + s.height, type: 'scale' },
        { id: 'tm', x: tmX, y: tmY, type: 'edge' },
        { id: 'bm', x: s.x + s.width / 2, y: s.y + s.height, type: 'edge' },
        { id: 'ml', x: s.x, y: s.y + s.height / 2, type: 'edge' },
        { id: 'mr', x: s.x + s.width, y: s.y + s.height / 2, type: 'edge' },
        { id: 'rotate', x: rotHandlePos.x, y: rotHandlePos.y, isRotation: true }
      ];
    }
  }

  getSelectionCenter() {
    if (!this.selection) return { x: 0, y: 0 };

    if (this.corners) {
      const c = this.corners;
      return {
        x: (c.tl.x + c.tr.x + c.bl.x + c.br.x) / 4,
        y: (c.tl.y + c.tr.y + c.bl.y + c.br.y) / 4
      };
    }

    return {
      x: this.selection.x + this.selection.width / 2,
      y: this.selection.y + this.selection.height / 2
    };
  }

  getRotationHandlePosition(center, topMiddleX, topMiddleY) {
    // Position the rotation handle above the top-middle, extended outward from center.
    // The gap is a constant on-screen distance, so convert to board px (screen / zoom).
    const gap = this.rotationHandleDistance / Math.max(0.01, this.board.zoom || 1);
    const dx = topMiddleX - center.x;
    const dy = topMiddleY - center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist === 0) {
      return { x: topMiddleX, y: topMiddleY - gap };
    }

    // Extend the handle position outward from center
    const extendDist = dist + gap;
    return {
      x: center.x + (dx / dist) * extendDist,
      y: center.y + (dy / dist) * extendDist
    };
  }

  updateCornersFromRotation(deltaAngle) {
    if (!this.cornersAtRotationStart) return;

    // Calculate center from the corners at rotation start
    const startCorners = this.cornersAtRotationStart;
    const center = {
      x: (startCorners.tl.x + startCorners.tr.x + startCorners.bl.x + startCorners.br.x) / 4,
      y: (startCorners.tl.y + startCorners.tr.y + startCorners.bl.y + startCorners.br.y) / 4
    };

    const cos = Math.cos(deltaAngle);
    const sin = Math.sin(deltaAngle);

    // Rotate each corner around the center
    const rotatePoint = (p) => {
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      return {
        x: center.x + dx * cos - dy * sin,
        y: center.y + dx * sin + dy * cos
      };
    };

    this.corners = {
      tl: rotatePoint(startCorners.tl),
      tr: rotatePoint(startCorners.tr),
      bl: rotatePoint(startCorners.bl),
      br: rotatePoint(startCorners.br)
    };
  }

  drawRotatedSelection() {
    if (!this.floatingCanvas || !this.selection) return;

    const ctx = this.board.topCtx;
    const center = this.getSelectionCenter();

    ctx.save();

    // Translate to center, rotate, then draw
    ctx.translate(center.x, center.y);
    ctx.rotate(this.rotation);

    // Draw the floating canvas centered
    ctx.drawImage(
      this.floatingCanvas,
      -this.floatingCanvas.width / 2,
      -this.floatingCanvas.height / 2
    );

    ctx.restore();
  }

  drawSelectionBox(ctx, startPos, endPos) {
    const x = Math.min(startPos.x, endPos.x);
    const y = Math.min(startPos.y, endPos.y);
    const width = Math.abs(endPos.x - startPos.x);
    const height = Math.abs(endPos.y - startPos.y);
    this._strokeMarchingAnts(ctx, this.livePreviewDashOffset, () => ctx.strokeRect(x, y, width, height));
  }

  drawSelectionUI() {
    if (!this.selection) return;

    const ctx = this.board.topCtx;
    const s = this.selection;

    // Draw floating selection if exists
    if (this.floatingCanvas) {
      this.drawFloatingSelection();
    }

    // Draw marching ants border
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    if (this.corners && this.hasTransformedCorners()) {
      // Transformed selection - draw quadrilateral on selection overlay (can extend beyond canvas)
      const overlayCtx = this.board.getSelectionCtx() || ctx;
      const c = this.corners;

      this._strokeMarchingAnts(overlayCtx, this.marchingAntsOffset, () => {
        overlayCtx.beginPath();
        overlayCtx.moveTo(c.tl.x, c.tl.y);
        overlayCtx.lineTo(c.tr.x, c.tr.y);
        overlayCtx.lineTo(c.br.x, c.br.y);
        overlayCtx.lineTo(c.bl.x, c.bl.y);
        overlayCtx.closePath();
        overlayCtx.stroke();
      });

      // Draw bounding box
      const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const strokeBbox = (c2) => {
        c2.strokeStyle = 'rgba(128, 128, 128, 0.5)';
        c2.lineWidth = 1;
        c2.setLineDash([4, 4]);
        c2.strokeRect(minX, minY, maxX - minX, maxY - minY);
        c2.setLineDash([]);
      };
      strokeBbox(overlayCtx);
      this._paintMirroredPreview(
        overlayCtx, { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, strokeBbox
      );

      // Draw handles on the same overlay context
      this.updateHandles();
      this._drawSelectionUIHandles(overlayCtx);
      this.board.restoreSelectionCtx();
    } else {
      // Lasso or Rectangle mode - draw on overlay so it can extend beyond canvas
      const overlayCtx = this.board.getSelectionCtx() || ctx;

      if (this.mode === 'lasso' && this.lassoSimplified && this.lassoSimplified.length > 0 && !this.floatingCanvas) {
        // Lasso mode - draw simplified polygon (only if not lifted)
        const lasso = this.lassoSimplified;
        this._strokeMarchingAnts(overlayCtx, this.marchingAntsOffset, () => {
          overlayCtx.beginPath();
          overlayCtx.moveTo(lasso[0].x, lasso[0].y);
          for (let i = 1; i < lasso.length; i++) overlayCtx.lineTo(lasso[i].x, lasso[i].y);
          overlayCtx.closePath();
          overlayCtx.stroke();
        });
      } else {
        // Rectangle mode OR lasso after lifting - draw bounding box
        this._strokeMarchingAnts(overlayCtx, this.marchingAntsOffset, () => overlayCtx.strokeRect(s.x, s.y, s.width, s.height));
      }

      // Draw handles on the same overlay context
      this.updateHandles();
      this._drawSelectionUIHandles(overlayCtx);
      this.board.restoreSelectionCtx();
    }

    this._drawMirrorGhost(ctx);
  }

  /**
   * Draws all selection handles (perspective, corner, rotation) on the screen-space
   * handle overlay, converting board positions to container space so they stay crisp
   * and a constant on-screen size at any zoom. The passed ctx is unused (legacy).
   */
  _drawSelectionUIHandles() {
    const ctx = this.board.getHandleCtx();
    if (!ctx) return;
    const { squareSize, circleRadius } = this._getHandleMetrics();
    const toC = (p) => this.board.boardToContainerPos(p.x, p.y);

    // Same shape as drawTransformHandles: the glyphs live on a screen-space
    // overlay, so a mirrored copy is the same code run through a board-space
    // point mapping rather than a canvas transform. See the note there on why
    // the mirrored set is ghosted and never hit-tested.
    const drawSet = (mapBoard, alpha) => {
      const P = (p) => toC(mapBoard(p));
      ctx.save();
      ctx.globalAlpha = alpha;

      // PASS 1: perspective handle connecting lines first (so corner handles appear on top)
      for (const handle of this.handles) {
        if (handle.isPerspective) {
          const cornerMap = { ptl: 'tl', ptr: 'tr', pbl: 'bl', pbr: 'br' };
          const corner = this.corners[cornerMap[handle.id]];

          if (corner) {
            // Connecting line from corner to perspective handle (dark grey, very thin)
            const a = P(corner);
            const b = P(handle);
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 0.75;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // PASS 2: perspective handle circles
      for (const handle of this.handles) {
        if (handle.isPerspective) {
          const b = P(handle);
          // Desaturated cyan circle
          ctx.fillStyle = '#88CCCC';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(b.x, b.y, circleRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      // PASS 3: regular corner/edge handles (on top of the perspective lines)
      for (const handle of this.handles) {
        if (!handle.isPerspective && !handle.isRotation) {
          const p = P(handle);
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.fillRect(p.x - squareSize / 2, p.y - squareSize / 2, squareSize, squareSize);
          ctx.strokeRect(p.x - squareSize / 2, p.y - squareSize / 2, squareSize, squareSize);
        }
      }

      // PASS 4: rotation handle last
      const rotHandle = this.handles.find(h => h.isRotation);
      if (rotHandle) {
        const r = P(rotHandle);
        const tm = this.handles.find(h => h.id === 'tm');
        if (tm) {
          const t = P(tm);
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(t.x, t.y);
          ctx.lineTo(r.x, r.y);
          ctx.stroke();
        }

        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.beginPath();
        ctx.arc(r.x, r.y, circleRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.restore();
    };

    drawSet((p) => p, 1);

    // Mirrored handle glyphs are intentionally not drawn: on high-order modes
    // (radial with many slices, fib) the repeated glyph set gets overwhelming.
  }

  /**
   * Repeats an already-rendered preview draw into every active mirror region.
   *
   * `paint` closes over a canvas that has ALREADY been rasterized (the warp
   * result, or the floating canvas itself), so a mirrored preview costs one
   * extra drawImage per region — no second homography, no second raster. That is
   * what makes mirroring the live transform preview affordable at all.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number,width:number,height:number}} rect - Where the
   *   unmirrored draw lands; used to skip regions it cannot reach.
   * @param {(ctx: CanvasRenderingContext2D) => void} paint
   * @private
   */
  _paintMirroredPreview(ctx, rect, paint) {
    for (const { region } of this.board.getSelectionMirrorTargets(rect)) {
      this.board.withMirroredRegionTransform(ctx, region, () => paint(ctx));
    }
  }

  /**
   * A floating selection sits on topCanvas for as long as it is floating —
   * across gestures, not just across ticks — so it is the preview most exposed
   * to a window move.
   */
  redrawPreview() {
    if (!this.floatingCanvas || !this.selection) return;
    this.board.clearTop();
    this.drawFloatingSelection();
  }

  drawFloatingSelection() {
    if (!this.floatingCanvas || !this.selection) return;

    this._updateFloatingSelectionBlendPreview();
    const ctx = this.board.topCtx;

    // Check if corners need perspective/rotation handling - if so, use homography
    if (this.needsHomographyTransform()) {
      if (this._drawWarpedFloatingSelection(ctx, 'low')) return;
    }

    // Fallback: simple draw at current position
    const s = this.selection;
    const paint = (c) => c.drawImage(this.floatingCanvas, s.x, s.y, s.width, s.height);
    paint(ctx);
    this._paintMirroredPreview(ctx, s, paint);
  }

  liftSelection() {
    if (!this.selection) return;

    const s = this.selection;
    this._sourceCropForRemote = null;

    // Reset preview toast flag when starting a new transform session
    this.hasShownPreviewToast = false;

    // Create floating canvas with selection content
    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = s.width;
    this.floatingCanvas.height = s.height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');

    // In all-layers mode, capture each layer's content independently BEFORE erasing
    if (this.copyAllLayers) {
      const lm = this.board.layerManager;
      this.floatingLayers = [];
      const lassoPath = this.mode === 'lasso' ? this.lassoPath : null;
      for (let i = 0; i < lm.layerGroups.length; i++) {
        const group = lm.layerGroups[i];
        if (!group || !group.visible) continue;
        const layerCanvas = this._flattenLayerRangeToSelectionCanvas(i, i + 1, s);
        const layerCtx = layerCanvas.getContext('2d');
        if (lassoPath) {
          this.applyLassoMask(layerCtx, s.x, s.y, lassoPath);
        }
        this.floatingLayers.push({ canvas: layerCanvas, groupIdx: i });
      }
    }

    // Copy from flattened layer(s) with transparent background
    const flatCanvas = this._flattenSelectionToCanvas(s);

    // Apply lasso mask if in lasso mode
    if (this.mode === 'lasso' && this.lassoPath) {
      this.applyLassoMask(flatCanvas.getContext('2d'), s.x, s.y, this.lassoPath);
    }

    this.floatingCtx.drawImage(flatCanvas, 0, 0);
    const imageData = this.floatingCtx.getImageData(0, 0, s.width, s.height);
    this.selectedImageData = imageData;

    // Store original position BEFORE erasing so we can track moves
    if (!this.originalSelectionPos) {
      this.originalSelectionPos = { x: s.x, y: s.y };
    }

    // Erase source area directly from baseCanvas (no stroke record created).
    // Tagged 'sel_lift' so the SEL_LIFT self echo can assign this erase the same
    // authoritative seq every observer commits it with. It is the LOWER half of
    // the lift/stamp pair: the stamp reconciles to SEL_COMMIT's (necessarily
    // higher) seq, so the erase stays beneath it on every client.
    this._restoreData = this._eraseSelectionDirectly(s, this.mode === 'lasso' ? this.lassoPath : null, 'sel_lift');

    // Check affected tiles for emptiness and clear tracker if empty
    const tt = this.board.tileTracker;
    if (tt) {
      const affectedTiles = tt.getTileIndicesForRect(s.x, s.y, s.width, s.height);
      if (affectedTiles.length > 0) {
        this.board.checkErasedTilesByIndices(new Set(affectedTiles));
      }
    }

    // Create reusable homography instances for this selection
    this.homography = new Homography('projective');
    this.previewHomography = new Homography('projective');

    // Activate split-composite mode so upper layers render above the floating selection
    this.board.activeSelectionLayer = this.board.app?.self?.activeLayer ?? 0;
    this.board.compositeTileGrid?.markRect(s.x, s.y, s.width, s.height);
    this.board.compositeAllLayers();

    // Draw floating selection on top canvas
    this.board.clearTop();
    this.drawSelectionUI();

    // Send the data via the websocket client
    if (this.board.app?.wsClient) {
      const imageData = this.floatingCanvas ? this.floatingCanvas.toDataURL('image/png') : null;
      const selectionSnapshot = cloneSelectionRect(this.selection);
      const lassoPathSnapshot = clonePathPoints(this.lassoPath);
      const liftAllLayers = !!(this.copyAllLayers && this.floatingLayers && this.floatingLayers.length > 0);
      // The lift erased the mirrored counterparts too — see _eraseSelectionDirectly.
      const liftMirrored = !!this.board.mirror;
      this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionLift(selectionSnapshot, lassoPathSnapshot, imageData, liftAllLayers, this.extendedWarp, liftMirrored));
    }
  }

  _getSelectionCommitBlendMode(groupIdx) {
    const allowComplex = this.board.layerManager?.getLayerAllowComplexBlendModes(groupIdx) ?? true;
    return allowComplex ? (this.board.app?.self?.blendMode || 'source-over') : 'source-over';
  }

  _getSelectionCommitBlendBakeMode() {
    return this.board.app?.self?.blendBakeMode || 'background';
  }

  _broadcastSelectionCommit(layerIndex) {
    const app = this.board.app;
    if (!app?.wsClient) return;

    // extendedWarp can change mid-selection (toggled after lift, before this
    // commit) — send the CURRENT value rather than relying on the one that
    // travelled with SEL_LIFT, or remote/replay would bake with a stale flag.
    // The full-board mirror travels with the commit for the same reason it does
    // with SEL_DELETE: it is a room setting outside the stroke log, so a joiner
    // replaying a tail cannot infer what it was when this commit was made.
    const wasMirrored = !!this.board.mirror;
    app.inputBufferManager.queueBroadcast(() => app.wsClient.broadcastSelectionCommit(layerIndex, this.extendedWarp, wasMirrored));
    // Applying a pasted image transitions it from "active floating image" to
    // committed pixels. Flush that state change immediately so late joiners do
    // not receive a stale IMG_PASTE before the next input tick.
    app.inputBufferManager.flushPendingNetwork?.();
  }

  /**
   * Draws a floating selection canvas into a layer's active stroke context,
   * applying the homography (perspective) warp when the selection is transformed
   * or a plain scaled blit otherwise. Returns the warp output bounds when a
   * transform was applied (so callers can size their dirty rect), else null.
   * Shared by commitSelection (both branches) and stamp().
   *
   * When mirrors are active the identical draw is replayed once per mirror
   * target with the region's matrix and clip applied to the context. Replaying
   * the draw rather than mirroring geometry is what makes every mode work —
   * quad, rotational, radial and fibonacci included — and it reuses the single
   * warp result instead of re-running the homography per region.
   *
   * @param {Array<{region: Object}>} [mirrorTargets] - From
   *   `Board.getSelectionMirrorTargets`. Callers must have folded the targets'
   *   bounds into `active.dirtyRect` first: `commitUserStroke` crops the stroke
   *   to that rect, so mirrored pixels outside it are silently discarded.
   * @private
   */
  _drawFloatingToActiveStroke(active, sourceCanvas, hasTransform, outputBounds, mirrorTargets = []) {
    let paint = null;
    let warpBounds = null;

    // A windowed active-stroke canvas's local origin is `active.origin`, not
    // board (0,0) — every draw below uses board-absolute coordinates, so they
    // need translating into the canvas's own local space first. See
    // windowed_canvas_needs_ctx_translate memory: this must wrap every draw
    // call site here, not just the allocation in beginUserStroke.
    const ox = active.origin?.x ?? 0;
    const oy = active.origin?.y ?? 0;
    if (ox || oy) active.ctx.save();
    if (ox || oy) active.ctx.translate(-ox, -oy);

    if (hasTransform) {
      if (!this.homography) this.homography = new Homography('projective');
      const result = performHomographyTransform({
        sourceCanvas,
        sourceCorners: this.originalCorners,
        destCorners: this.corners,
        scale: 1,
        homographyInstance: this.homography,
        outputBounds
      });
      if (result) {
        const tempCanvas = imageDataToCanvas(result.imageData);
        const drawX = Math.round(result.bounds.minX);
        const drawY = Math.round(result.bounds.minY);
        paint = (ctx) => ctx.drawImage(tempCanvas, drawX, drawY);
        warpBounds = result.bounds;
      }
    }

    if (!paint) {
      const drawX = Math.round(this.selection.x);
      const drawY = Math.round(this.selection.y);
      const drawW = this.selection.width;
      const drawH = this.selection.height;
      paint = (ctx) => ctx.drawImage(sourceCanvas, drawX, drawY, drawW, drawH);
    }

    paint(active.ctx);
    for (const { region } of mirrorTargets) {
      this.board.withMirroredRegionTransform(active.ctx, region, () => paint(active.ctx));
    }
    if (ox || oy) active.ctx.restore();
    return warpBounds;
  }

  /**
   * Mirror targets for a commit/stamp of the current float, plus the dirty rect
   * that covers the original paint and every mirrored copy of it.
   * @param {{x:number,y:number,width:number,height:number}} paintRect - Area the
   *   unmirrored paint covers.
   * @returns {{targets: Array, dirty: {x:number,y:number,width:number,height:number}}}
   * @private
   */
  _getFloatingMirrorPlan(paintRect) {
    const targets = this.board.getSelectionMirrorTargets(paintRect);
    return { targets, dirty: this.board.unionWithMirrorTargets(paintRect, targets) };
  }

  /**
   * Paints the current selection shape — the lasso polygon when in lasso mode,
   * otherwise the selection rectangle — into ctx using its current fillStyle, in
   * board coordinates. Shared by the selection-erase paths.
   * @private
   */
  _fillSelectionShape(ctx, s, lassoPath) {
    if (lassoPath && lassoPath.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(lassoPath[0].x, lassoPath[0].y);
      for (let i = 1; i < lassoPath.length; i++) {
        ctx.lineTo(lassoPath[i].x, lassoPath[i].y);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(s.x, s.y, s.width, s.height);
    }
  }

  /**
   * Erases the selection region from a single layer as a destination-out stroke:
   * begins the stroke, pins its dirty rect to the selection bounds, fills the
   * shape, expands the board dirty rect, and commits with the given props.
   * Shared by _eraseSelectionDirectly (per-layer) and _eraseSingleLayerSelection.
   *
   * `mirrorTargets` (from `Board.getSelectionMirrorTargets`) makes the erase
   * clear each mirrored counterpart in the SAME stroke. One stroke, not one per
   * copy: they then share a timestamp and a commit tag, so a single SEL_DELETE
   * echo reconciles the whole erase to one authoritative seq. Erased separately
   * and untagged, the mirrored halves stayed at seq 0 and floated to the top of
   * the stroke stack as permanent holes.
   * @private
   */
  _eraseRegionStroke(layerIdx, s, lassoPath, userId, commitProps, mirrorTargets = []) {
    const lm = this.board.layerManager;
    if (!lm) return false;

    // Bounds for the erased region, including any mirrored copies — computed up
    // front so it doubles as the windowed active-stroke canvas's bounds hint.
    const dirty = this.board.unionWithMirrorTargets(s, mirrorTargets);

    lm.beginUserStroke(layerIdx, userId, 'destination-out', undefined, dirty);
    const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(userId);
    if (!active) return false;

    // Pin dirty rect to the erased bounds so commitUserStroke doesn't drop it —
    // it crops the stroke to this rect, so the mirrored copies must be inside.
    if (active.dirtyRect) {
      active.dirtyRect.minX = dirty.x;
      active.dirtyRect.minY = dirty.y;
      active.dirtyRect.maxX = dirty.x + dirty.width;
      active.dirtyRect.maxY = dirty.y + dirty.height;
    }

    const paintErase = (ctx) => {
      ctx.fillStyle = 'white';
      this._fillSelectionShape(ctx, s, lassoPath);
      for (const { region } of mirrorTargets) {
        this.board.withMirroredRegionTransform(ctx, region, () => {
          this._fillSelectionShape(ctx, s, lassoPath);
        });
      }
    };

    // Antialiased edges only subtract a·(1−a) of themselves, so a lasso (or any
    // mirrored) erase leaves up to a quarter of every edge pixel behind — the
    // faint outline left by filling a selection and clearing it. Harden the
    // mask so the erase takes the whole edge. An unmirrored rectangle is
    // pixel-aligned and antialiases nothing, so it skips the extra work.
    // RemoteSelectionHandler._eraseSelectionFromLayer must make the same call.
    if (needsHardenedEraseMask(lassoPath, mirrorTargets, s)) {
      paintHardenedEraseMask(active.ctx, dirty, paintErase, active.origin);
    } else {
      const ox = active.origin?.x ?? 0;
      const oy = active.origin?.y ?? 0;
      if (ox || oy) active.ctx.save();
      if (ox || oy) active.ctx.translate(-ox, -oy);
      paintErase(active.ctx);
      if (ox || oy) active.ctx.restore();
    }

    const user = this.board.app?.self;
    if (user) this.board.expandDirtyRect(user, dirty.x, dirty.y, dirty.width, dirty.height, layerIdx);

    lm.commitUserStroke(layerIdx, userId, commitProps);
    return true;
  }

  commitSelection() {
    if (!this.floatingCanvas || !this.selection) return;

    const lm = this.board.layerManager;
    const userId = this.board.app?.self?.id ?? 0;

    // All-layers mode: run the exact same commit logic as single-layer, once per layer
    if (this.copyAllLayers && this.floatingLayers && this.floatingLayers.length > 0) {
      // Compute actual bounds once (may differ from selection if transformed)
      let dirtyX = this.selection.x;
      let dirtyY = this.selection.y;
      let dirtyW = this.selection.width;
      let dirtyH = this.selection.height;

      let commitOutputBounds = null;
      if (this.needsHomographyTransform()) {
        commitOutputBounds = this._getWarpOutputBounds();
        const bounds = commitOutputBounds || calculateCornerBounds(this.corners);
        dirtyX = Math.round(bounds.minX);
        dirtyY = Math.round(bounds.minY);
        dirtyW = Math.ceil(bounds.width);
        dirtyH = Math.ceil(bounds.height);
      }

      // Mirrored copies land outside the selection, so every downstream extent —
      // the stroke's dirty rect, tile ownership, the composite mark — has to be
      // the union, not the selection alone.
      const { targets: mirrorTargets, dirty } = this._getFloatingMirrorPlan(
        { x: dirtyX, y: dirtyY, width: dirtyW, height: dirtyH }
      );
      dirtyX = dirty.x;
      dirtyY = dirty.y;
      dirtyW = dirty.width;
      dirtyH = dirty.height;

      // Get affected tile indices for undo tracking
      const tileOwnership = this.board.tileTracker;
      const commitTileIndices = tileOwnership
        ? tileOwnership.getTileIndicesForRect(dirtyX, dirtyY, dirtyW, dirtyH)
        : [];

      // Shared timestamp so all per-layer commit strokes get undone together in one Ctrl+Z
      const commitBatchTimestamp = typeof lm?.allocateHistoryTimestamp === 'function'
        ? lm.allocateHistoryTimestamp()
        : Date.now();

      let attachedSelectionRestoreData = false;
      const commitBounds = { x: dirtyX, y: dirtyY, width: dirtyW, height: dirtyH };
      for (const { canvas, groupIdx } of this.floatingLayers) {
        lm.beginUserStroke(
          groupIdx,
          userId,
          this._getSelectionCommitBlendMode(groupIdx),
          this._getSelectionCommitBlendBakeMode(),
          commitBounds
        );
        const active = lm.layerGroups[groupIdx]?.activeStrokeByUser.get(userId);
        if (!active) continue;

        // Expand dirty rect directly on this layer's active stroke
        if (active.dirtyRect) {
          active.dirtyRect.minX = dirtyX;
          active.dirtyRect.minY = dirtyY;
          active.dirtyRect.maxX = dirtyX + dirtyW;
          active.dirtyRect.maxY = dirtyY + dirtyH;
        }

        // Store affected tiles in the stroke record for undo
        if (active.affectedTiles) {
          for (const idx of commitTileIndices) {
            active.affectedTiles.add(idx);
          }
        }

        this._drawFloatingToActiveStroke(active, canvas, this.needsHomographyTransform(), commitOutputBounds, mirrorTargets);

        // Tagged now that the lift-erase is sequenced too (2026-08-10) — see the
        // pairing note on the single-layer commit below.
        const commitExtraProps = { timestamp: commitBatchTimestamp, pendingCommitEcho: 'sel_commit' };
        if (!attachedSelectionRestoreData && this._restoreData) {
          commitExtraProps.selectionRestoreData = this._restoreData;
          attachedSelectionRestoreData = true;
        }
        lm.commitUserStroke(groupIdx, userId, commitExtraProps);
      }

      this.board.compositeTileGrid?.markRect(dirtyX, dirtyY, dirtyW, dirtyH);
      this.board.compositeAllLayers();

      // Add tile ownership for visible tiles in the pasted region (must be after composite)
      this.board.addOccupancyForVisibleTilesInRect(userId, dirtyX, dirtyY, dirtyW, dirtyH);

      // Broadcast tile ownership update and selection commit
      if (this.board.app?.wsClient) {
        if (commitTileIndices.length > 0) {
          this.board.app.wsClient.broadcastTileUpdate(commitTileIndices);
        }
        this._broadcastSelectionCommit(this.board.app?.self?.activeLayer ?? 0);
      }

      this.floatingCanvas = null;
      this.floatingCtx = null;
      this.floatingLayers = null;
      this._sourceCropForRemote = null;
      this.selectedImageData = null;
      this._restoreData = null;
      this._updateFloatingSelectionBlendPreview();
      this.board.clearTop();
      return;
    }

    const activeLayer = this.board.app?.self?.activeLayer ?? 0;

    // Calculate dirty rect bounds for tracking
    let dirtyX, dirtyY, dirtyWidth, dirtyHeight;

    // Where the unmirrored paint will land. Resolved BEFORE beginUserStroke so both
    // the mirror targets/dirty rect AND the windowed active-stroke bounds are known
    // up front — commitUserStroke crops the stroke to the dirty rect and would drop
    // the mirrored pixels otherwise.
    const hasTransform = this.needsHomographyTransform();
    const commitOutputBounds = hasTransform ? this._getWarpOutputBounds() : null;
    const paintRect = commitOutputBounds
      ? {
        x: Math.round(commitOutputBounds.minX),
        y: Math.round(commitOutputBounds.minY),
        width: Math.ceil(commitOutputBounds.width),
        height: Math.ceil(commitOutputBounds.height)
      }
      : {
        x: Math.round(this.selection.x),
        y: Math.round(this.selection.y),
        width: this.selection.width,
        height: this.selection.height
      };
    const { targets: mirrorTargets, dirty } = this._getFloatingMirrorPlan(paintRect);

    // Begin a new stroke on the active layer so this paste is undoable
    lm.beginUserStroke(
      activeLayer,
      userId,
      this._getSelectionCommitBlendMode(activeLayer),
      this._getSelectionCommitBlendBakeMode(),
      dirty
    );
    const active = lm.layerGroups[activeLayer]?.activeStrokeByUser.get(userId);
    if (!active) {
      this.floatingCanvas = null;
      this.floatingCtx = null;
      this.selectedImageData = null;
      this._sourceCropForRemote = null;
      this._updateFloatingSelectionBlendPreview();
      this.board.clearTop();
      // Still broadcast commit to sync with other users even if stroke creation failed
      if (this.board.app?.wsClient) {
        this._broadcastSelectionCommit(activeLayer);
      }
      return;
    }

    // Draw the floating selection (with optional transform) into the stroke canvas
    const warpBounds = this._drawFloatingToActiveStroke(
      active,
      this.floatingCanvas,
      hasTransform,
      commitOutputBounds,
      mirrorTargets
    );
    if (warpBounds) {
      dirtyX = Math.round(warpBounds.minX);
      dirtyY = Math.round(warpBounds.minY);
      dirtyWidth = Math.ceil(warpBounds.width);
      dirtyHeight = Math.ceil(warpBounds.height);
    } else {
      dirtyX = Math.round(this.selection.x);
      dirtyY = Math.round(this.selection.y);
      dirtyWidth = this.selection.width;
      dirtyHeight = this.selection.height;
    }
    // `_getWarpOutputBounds` is a prediction; the homography's real output can
    // differ slightly, so union the mirror plan with the bounds actually drawn
    // rather than trusting paintRect.
    if (mirrorTargets.length > 0) {
      const minX = Math.min(dirtyX, dirty.x);
      const minY = Math.min(dirtyY, dirty.y);
      const maxX = Math.max(dirtyX + dirtyWidth, dirty.x + dirty.width);
      const maxY = Math.max(dirtyY + dirtyHeight, dirty.y + dirty.height);
      dirtyX = minX;
      dirtyY = minY;
      dirtyWidth = maxX - minX;
      dirtyHeight = maxY - minY;
    }

    // Track the dirty region so the stroke is properly saved
    this.board.expandDirtyRect(this.board.app?.self, dirtyX, dirtyY, dirtyWidth, dirtyHeight);

    // Store affected tiles in the stroke record for undo and collect for broadcast
    const tileOwnership = this.board.tileTracker;
    let tilesToBroadcast = [];
    if (tileOwnership && active.affectedTiles) {
      const tileIndices = tileOwnership.getTileIndicesForRect(dirtyX, dirtyY, dirtyWidth, dirtyHeight);
      for (const idx of tileIndices) {
        active.affectedTiles.add(idx);
      }
      tilesToBroadcast = tileIndices;
    }

    // Commit as an undoable placement stroke only. The lifted source-area erase
    // remains its own older history entry so undo peels back apply, then stamps,
    // and only later restores the original lifted pixels.
    // Both halves of the pair are sequenced (2026-08-10). The stamp reconciles to
    // the SEL_COMMIT echo's seq and the lift-erase to the SEL_LIFT echo's, so the
    // erase — broadcast first, therefore numbered lower — stays beneath it.
    //
    // Do NOT sequence the stamp on its own. _sortStrokeStack maps seq 0 →
    // MAX_SAFE_INTEGER, so a stamp with a real seq above a still-seq-0
    // destination-out lift-erase sinks BELOW it and the erase wipes the pixels it
    // just placed. If the lift tag is ever removed, remove this one too.
    const commitExtraProps = { pendingCommitEcho: 'sel_commit' };
    if (this._restoreData) {
      commitExtraProps.selectionRestoreData = this._restoreData;
    }
    lm.commitUserStroke(activeLayer, userId, commitExtraProps);
    this.board.compositeTileGrid?.markRect(dirtyX, dirtyY, dirtyWidth, dirtyHeight);
    this.board.compositeAllLayers();

    // Add tile ownership for visible tiles in the pasted region (must be after composite)
    this.board.addOccupancyForVisibleTilesInRect(userId, dirtyX, dirtyY, dirtyWidth, dirtyHeight);

    // Broadcast tile ownership update and selection commit
    if (this.board.app && this.board.app.wsClient) {
      if (tilesToBroadcast.length > 0) {
        this.board.app.wsClient.broadcastTileUpdate(tilesToBroadcast);
      }
      this._broadcastSelectionCommit(activeLayer);
    }

    this.floatingCanvas = null;
    this.floatingCtx = null;
    this.selectedImageData = null;
    this._sourceCropForRemote = null;
    this._restoreData = null;
    this._updateFloatingSelectionBlendPreview();
    this.board.clearTop();
  }

  clearSelection() {
    // Deactivate split-composite mode — no floating selection in flight
    this.board.activeSelectionLayer = -1;
    const hasFloating = !!(this.floatingCanvas || (this.floatingLayers && this.floatingLayers.length > 0));
    const hasLasso = !!(this.lassoPath || (this.lassoPoints && this.lassoPoints.length > 0));
    if (!this.selection && !hasFloating && !hasLasso && !this.corners) {
      this.hideContextMenu();
      return;
    }
    if (this.selection) {
      this.board.compositeTileGrid?.markRect(this.selection.x, this.selection.y, this.selection.width, this.selection.height);
    } else {
      this.board.markCompositeFull();
    }
    this.board.compositeAllLayers();

    this.selection = null;
    this.handles = [];
    this.corners = null;
    this.originalCorners = null;
    this.originalSelectionPos = null;
    this.floatingCanvas = null;
    this.floatingCtx = null;
    this.floatingLayers = null;
    this.selectedImageData = null;
    this._sourceCropForRemote = null;
    this._updateFloatingSelectionBlendPreview();
    this.isTransforming = false;
    this.rotation = 0;
    this.isRotating = false;
    this.cornersAtRotationStart = null;
    this.hasShownPreviewToast = false; // Reset toast flag for next selection
    this._restoreData = null;
    this.lastPointerUpPos = null; // Reset menu positioning
    // Clear homography instances
    this.homography = null;
    this.previewHomography = null;
    this._cachedTransform = null; // Clear cached transform

    // Lasso cleanup
    this.lassoPoints = [];
    this.lassoPath = null;
    this.lassoSimplified = null;
    this.originalSelection = null;
    this.pendingSelectionPreviewBroadcast = null;

    // Reset active handle to prevent glitches when switching tools mid-drag
    this.activeHandle = null;

    if (this.isMaskMode) {
      this.isMaskMode = false;
      this.board._maskManagedBySelectTool = false;
      this.board.clearSelectionMask();
      this.board.app?.wsClient?.broadcastSelectionMask(false);
    }

    this.hideContextMenu();
    this.board.clearTop();
  }

  // Toggle all-layers copy/cut mode
  toggleCopyAllLayers(value) {
    this.copyAllLayers = value !== undefined ? value : !this.copyAllLayers;
  }

  // Toggle fit-to-content mode
  toggleFitToContent(value) {
    this.fitToContent = value !== undefined ? value : !this.fitToContent;
  }

  // Toggle extended (beyond-bounds) warp for folded/concave/crossed quads
  toggleExtendedWarp(value) {
    this.extendedWarp = value !== undefined ? value : !this.extendedWarp;
    this._cachedTransform = null;

    // A mid-selection toggle doesn't ride on any dedicated message — corners
    // and extendedWarp only travel together on SEL_MOVE/SEL_COMMIT/SEL_STAMP,
    // so without an explicit nudge here, remote viewers and replay/history
    // only learn about the change whenever the NEXT one of those happens to
    // fire, and stay on the stale mode in the meantime (visible as "only
    // updates once the selection is moved" when scrubbing history). Broadcast
    // a move with the corners unchanged to create a real event at the exact
    // moment of the toggle, and redraw locally so the drawer's own preview
    // updates immediately instead of waiting on the next drag frame.
    if (this.floatingCanvas && this.corners) {
      this.board.clearTop();
      this.drawTransformPreview();

      if (this.board.app?.wsClient) {
        this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionMove(this.corners, null, this.extendedWarp), { snapshot: false });
      }
    }
  }

  toggleMaskMode(value) {
    const next = value !== undefined ? !!value : !this.isMaskMode;
    if (next === this.isMaskMode) return;
    this.isMaskMode = next;

    if (this.isMaskMode) {
      this.fitToContent = false;
      // Flag first: setSelectionMask reads it to decide whether to show the
      // "Stop masking" button, and it used to be set afterwards, so the button
      // never appeared on the toggle that created the mask.
      this.board._maskManagedBySelectTool = true;
      this._applyCurrentMaskToBoard();
      this.board.app?.ui?.showToast?.('Mask active — drawing restricted to selection');
      const sel = this.selection;
      const lasso = this.lassoPath;
      this.board.app?.wsClient?.broadcastSelectionMask(true, sel, lasso);
    } else {
      this.board.clearSelectionMask();
      this.board._maskManagedBySelectTool = false;
      this.board.app?.ui?.showToast?.('Mask cleared');
      this.board.app?.wsClient?.broadcastSelectionMask(false);
    }

    // Update button label/state
    this.showContextMenu(true);
  }

  _applyCurrentMaskToBoard(broadcast = false) {
    if (!this.selection) return;
    this.board.setSelectionMask({
      x: this.selection.x,
      y: this.selection.y,
      width: this.selection.width,
      height: this.selection.height,
      lassoPath: this.lassoPath ? [...this.lassoPath] : null
    });
    if (broadcast) {
      this.board.app?.wsClient?.broadcastSelectionMask(true, this.selection, this.lassoPath);
    }
  }

  _isComplexBlendMode(blendMode) {
    return blendMode && blendMode !== 'source-over' && blendMode !== 'destination-out';
  }

  _rectsOverlap(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  _groupHasComplexBlendInSelection(group, s) {
    if (!group?.flatCanvas) return false;

    const hasSelectedBlend = (stroke) => {
      if (!this._isComplexBlendMode(stroke?.blendMode)) return false;
      const strokeRect = {
        x: stroke.x ?? 0,
        y: stroke.y ?? 0,
        width: stroke.width ?? stroke.canvas?.width ?? 0,
        height: stroke.height ?? stroke.canvas?.height ?? 0
      };
      return this._rectsOverlap(s, strokeRect);
    };

    if (group.strokeStack?.some(hasSelectedBlend)) return true;
    for (const active of group.activeStrokeByUser?.values?.() || []) {
      if (hasSelectedBlend(active)) return true;
    }
    return false;
  }

  _rangeNeedsBackgroundBlendBake(startIdx, endIdx, s) {
    const lm = this.board.layerManager;
    const count = Math.min(endIdx, lm.layerGroups.length);
    for (let i = startIdx; i < count; i++) {
      if (this._groupHasComplexBlendInSelection(lm.layerGroups[i], s)) return true;
    }
    return false;
  }

  _flattenLayerRangeToSelectionCanvas(startIdx, endIdx, s) {
    const lm = this.board.layerManager;
    const selCanvas = document.createElement('canvas');
    selCanvas.width = Math.ceil(s.width);
    selCanvas.height = Math.ceil(s.height);
    const selCtx = selCanvas.getContext('2d');

    // Composite DIRECTLY onto the selection-sized canvas instead of a
    // full-board temp canvas cropped down afterward — compositeLayerRange's
    // `dirtyRects` param already clips + positions correctly under a
    // translated ctx (same mechanism the LayerManager active-stroke
    // windowing work uses: stroke.x/y are board-absolute, so the CTM
    // remaps them onto the smaller canvas). Avoids a `lm.width x lm.height`
    // allocation (and a second one when `needsBakeBg`) per call — this runs
    // once per target layer group for multi-layer select operations.
    const originX = Math.floor(s.x);
    const originY = Math.floor(s.y);
    const rect = { x: originX, y: originY, width: selCanvas.width, height: selCanvas.height };

    const needsBakeBg = this._rangeNeedsBackgroundBlendBake(startIdx, endIdx, s);
    const bgColor = needsBakeBg
      ? (this.board.getCompositeBackgroundColor?.() || this.board.backgroundColor || [255, 255, 255, 1])
      : null;

    selCtx.save();
    selCtx.translate(-originX, -originY);
    lm.compositeLayerRange(selCtx, startIdx, endIdx, bgColor, [rect]);
    selCtx.restore();

    if (needsBakeBg) {
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = selCanvas.width;
      maskCanvas.height = selCanvas.height;
      const maskCtx = maskCanvas.getContext('2d');
      maskCtx.save();
      maskCtx.translate(-originX, -originY);
      lm.compositeLayerRange(maskCtx, startIdx, endIdx, null, [rect]);
      maskCtx.restore();

      // selCtx/maskCtx are already selection-sized, so the "rect to process"
      // is the whole canvas at its own local (0,0), not a sub-region within
      // a bigger one as the old full-board version needed.
      this._convertBakedBackgroundToMaskedSource(selCtx, maskCtx, bgColor, { x: 0, y: 0, width: rect.width, height: rect.height });
    }

    return selCanvas;
  }

  _convertBakedBackgroundToMaskedSource(tempCtx, maskCtx, bgColor, rect) {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const width = Math.max(0, Math.min(tempCtx.canvas.width - x, Math.ceil(rect.width)));
    const height = Math.max(0, Math.min(tempCtx.canvas.height - y, Math.ceil(rect.height)));
    if (width <= 0 || height <= 0) return;

    const baked = tempCtx.getImageData(x, y, width, height);
    const mask = maskCtx.getImageData(x, y, width, height);
    const [bgR, bgG, bgB] = bgColor || [255, 255, 255, 1];

    for (let i = 0; i < baked.data.length; i += 4) {
      const alpha = mask.data[i + 3] / 255;
      if (alpha <= 0) {
        baked.data[i] = 0;
        baked.data[i + 1] = 0;
        baked.data[i + 2] = 0;
        baked.data[i + 3] = 0;
        continue;
      }

      baked.data[i] = Math.max(0, Math.min(255, Math.round((baked.data[i] - bgR * (1 - alpha)) / alpha)));
      baked.data[i + 1] = Math.max(0, Math.min(255, Math.round((baked.data[i + 1] - bgG * (1 - alpha)) / alpha)));
      baked.data[i + 2] = Math.max(0, Math.min(255, Math.round((baked.data[i + 2] - bgB * (1 - alpha)) / alpha)));
      baked.data[i + 3] = Math.round(alpha * 255);
    }

    tempCtx.clearRect(x, y, width, height);
    tempCtx.putImageData(baked, x, y);
  }

  // Flatten visible layers (all or active only) into a selection-sized canvas.
  // Complex flat-layer blend strokes are baked against the board background for
  // color math, then masked back to layer content so blank bg is not lifted.
  _flattenSelectionToCanvas(s) {
    const lm = this.board.layerManager;
    const selCanvas = document.createElement('canvas');
    selCanvas.width = s.width;
    selCanvas.height = s.height;
    const selCtx = selCanvas.getContext('2d');

    if (this.copyAllLayers) {
      selCtx.drawImage(this._flattenLayerRangeToSelectionCanvas(0, lm.layerGroups.length, s), 0, 0);
    } else {
      const activeLayer = this.board.app?.self?.activeLayer ?? 0;
      selCtx.drawImage(this._flattenLayerRangeToSelectionCanvas(activeLayer, activeLayer + 1, s), 0, 0);
    }

    return selCanvas;
  }

  // Erase the selection directly from the layer manager using a destination-out stroke.
  // This correctly handles content in both baked sequences and the stroke stack.
  // commitTag (e.g. 'sel_delete') tags a single-layer erase so the MU self-echo
  // reconciler skips it and a dedicated commit echo assigns its authoritative seq.
  _eraseSelectionDirectly(s, lassoPath, commitTag = null) {
    const lm = this.board.layerManager;
    const isMultiLayer = this.copyAllLayers;
    const userId = this.board.app?.self?.id ?? 0;
    const batchTimestamp = typeof lm?.allocateHistoryTimestamp === 'function'
      ? lm.allocateHistoryTimestamp()
      : Date.now();
    const snapshots = [];
    const mirrorTargets = this.board.getSelectionMirrorTargets(s);

    const eraseGroup = (groupIdx) => {
      const group = lm.layerGroups[groupIdx];
      if (!group || !group.visible) return;

      const snap = document.createElement('canvas');
      snap.width = s.width;
      snap.height = s.height;
      const snapCtx = snap.getContext('2d');
      snapCtx.drawImage(this._flattenLayerRangeToSelectionCanvas(groupIdx, groupIdx + 1, s), 0, 0);

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

      snapshots.push({ groupIdx, canvas: snap, x: s.x, y: s.y });

      const commitProps = {
        eraseAll: isMultiLayer,
        timestamp: batchTimestamp,
        isSelectionErase: true, // Flag to distinguish from normal erasers if needed
        // Every stroke of the batch carries the tag — reconcileLocalCommitBatch
        // assigns the echo's seq to all of them. Multi-layer batches used to be
        // excluded on the assumption they'd reconcile via MU, but a menu-driven
        // clear produces no MU, so they sat at seq 0 on top of the stack forever.
        ...(commitTag ? { pendingCommitEcho: commitTag } : {})
      };

      // The mirrored counterparts ride inside this same stroke — see
      // _eraseRegionStroke for why they must not be separate commits.
      this._eraseRegionStroke(groupIdx, s, lassoPath, userId, commitProps, mirrorTargets);
    };

    if (isMultiLayer) {
      for (let i = 0; i < lm.layerGroups.length; i++) eraseGroup(i);
    } else {
      eraseGroup(this.board.app?.self?.activeLayer ?? 0);
    }

    this.board.compositeTileGrid?.markRect(s.x, s.y, s.width, s.height);
    this.board.compositeAllLayers();

    // Return snapshots + the original erase shape so Board.undo/redo can replay it
    return {
      snapshots,
      eraseS: { ...s },
      eraseLassoPath: lassoPath ? lassoPath.map(p => ({ ...p })) : null,
      eraseTimestamp: batchTimestamp,
      eraseUserId: userId
    };
  }

  // Copy selection to clipboard
  copy() {
    if (!this.selection) return false;

    const s = this.selection;

    // Get image data from transformed canvas if lifted, otherwise from main canvas
    if (this.floatingCanvas) {
      const transformedCanvas = this.getTransformedCanvas();
      this.clipboard = {
        width: transformedCanvas.width,
        height: transformedCanvas.height,
        imageData: transformedCanvas.getContext('2d').getImageData(0, 0, transformedCanvas.width, transformedCanvas.height)
      };
    } else {
      const flatCanvas = this._flattenSelectionToCanvas(s);
      if (this.mode === 'lasso' && this.lassoPath) {
        this.applyLassoMask(flatCanvas.getContext('2d'), s.x, s.y, this.lassoPath);
      }
      this.clipboard = {
        width: s.width,
        height: s.height,
        imageData: flatCanvas.getContext('2d').getImageData(0, 0, s.width, s.height)
      };
    }

    // Show toast notification
    if (this.board.app?.ui) {
      this.board.app.ui.showToast('Copied to clipboard!');
    }

    // Only sync to the system clipboard for registered users — guests still get
    // internal copy/paste, but we don't push pixels out to the OS clipboard.
    if (this.board.app?.canUseImageFeatures?.(false)) {
      void this.board.app?.copyImageDataToClipboard?.(this.clipboard, { silent: true });
    }

    return true;
  }

  // Cut selection (copy + delete)
  cut() {
    if (!this.selection) return false;

    if (!this.copy()) return false;
    this.deleteSelection();
    return true;
  }

  // Paste from clipboard
  /**
   * Shared tail for paste/clone/pasteImage: marks the floating content as
   * "moved", builds transform handles, repaints the selection UI + context menu,
   * and broadcasts the paste to other users. Each caller sets up `this.selection`
   * and `this.floatingCanvas` first.
   * @param {number} x - Broadcast/paste X.
   * @param {number} y - Broadcast/paste Y.
   * @param {number} width
   * @param {number} height
   */
  _finalizeFloatingSelection(x, y, width, height) {
    // Pasted/cloned content is considered already "moved" (no source to erase).
    this.originalSelectionPos = { x: -1, y: -1 };

    this.initializeCorners();
    this.updateHandles();
    this.board.clearTop();
    this.drawSelectionUI();
    this.showContextMenu();

    if (this.board.app?.wsClient) {
      const dataUrl = this.floatingCanvas.toDataURL('image/png');
      this.board.app.inputBufferManager.queueBroadcast(() =>
        this.board.app.wsClient.broadcastImagePaste(x, y, width, height, dataUrl));
    }
  }

  paste() {
    if (!this.clipboard) return false;

    // Commit any existing selection
    this.commitSelection();
    this.clearSelection();

    // Paste at user's current cursor position (centered on cursor)
    const app = this.board.app;
    const x = app?.self?.x || 50;
    const y = app?.self?.y || 50;

    // Center the pasted content on cursor
    const pasteX = x - this.clipboard.width / 2;
    const pasteY = y - this.clipboard.height / 2;

    this.selection = {
      x: pasteX,
      y: pasteY,
      width: this.clipboard.width,
      height: this.clipboard.height
    };

    // Create floating canvas with clipboard content
    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = this.clipboard.width;
    this.floatingCanvas.height = this.clipboard.height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');
    this.floatingCtx.putImageData(this.clipboard.imageData, 0, 0);
    this._sourceCropForRemote = null;

    this._finalizeFloatingSelection(pasteX, pasteY, this.clipboard.width, this.clipboard.height);

    return true;
  }

  // Clone the current selection in place as a floating duplicate. The source
  // pixels stay on the layer; the clone can then be dragged/transformed like a
  // pasted selection. No-op if the selection has already been lifted/moved.
  clone() {
    if (!this.selection || this.floatingCanvas) return false;

    if (!this.copy()) return false;

    const s = this.selection;
    const cloneX = s.x;
    const cloneY = s.y;

    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = this.clipboard.width;
    this.floatingCanvas.height = this.clipboard.height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');
    this.floatingCtx.putImageData(this.clipboard.imageData, 0, 0);
    this._sourceCropForRemote = null;

    this._finalizeFloatingSelection(cloneX, cloneY, this.clipboard.width, this.clipboard.height);

    return true;
  }

  /**
   * Paste an image from an external source (clipboard, drag-drop, file upload)
   * @param {HTMLImageElement|HTMLCanvasElement|ImageData} imageSource
   */
  pasteImage(imageSource) {
    if (!this.board.app?.canUseImageFeatures?.(true)) return false;

    // Commit any existing selection
    this.commitSelection();
    this.clearSelection();

    const origWidth = imageSource.width;
    const origHeight = imageSource.height;

    // Calculate the visible viewport in canvas coordinates
    const container = this.board.container;
    const containerWidth = container?.clientWidth || 800;
    const containerHeight = container?.clientHeight || 600;
    const zoom = this.board.zoom || 1;
    const panX = this.board.panX || 0;
    const panY = this.board.panY || 0;

    // Viewport dimensions in canvas space
    const viewportWidth = containerWidth / zoom;
    const viewportHeight = containerHeight / zoom;

    // Viewport center in canvas coordinates
    const viewCenterX = (containerWidth / 2 - panX) / zoom;
    const viewCenterY = (containerHeight / 2 - panY) / zoom;

    // If the image matches the board size exactly, place it at the origin at full size
    const boardWidth = this.board.dimensions[1];
    const boardHeight = this.board.dimensions[0];
    let width, height, pasteX, pasteY;
    if (origWidth === boardWidth && origHeight === boardHeight) {
      width = origWidth;
      height = origHeight;
      pasteX = 0;
      pasteY = 0;
    } else {
      // Scale image to fit within 80% of viewport
      const maxWidth = viewportWidth * 0.8;
      const maxHeight = viewportHeight * 0.8;
      const scale = Math.min(1, maxWidth / origWidth, maxHeight / origHeight);
      width = Math.round(origWidth * scale);
      height = Math.round(origHeight * scale);

      // Center on viewport
      pasteX = viewCenterX - width / 2;
      pasteY = viewCenterY - height / 2;
    }

    this.selection = {
      x: pasteX,
      y: pasteY,
      width: width,
      height: height
    };

    // Create floating canvas with the scaled image content
    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = width;
    this.floatingCanvas.height = height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');
    this._sourceCropForRemote = null;

    if (imageSource instanceof ImageData) {
      // ImageData can't be scaled directly - draw to temp canvas first
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = origWidth;
      tempCanvas.height = origHeight;
      tempCanvas.getContext('2d').putImageData(imageSource, 0, 0);
      this.floatingCtx.drawImage(tempCanvas, 0, 0, origWidth, origHeight, 0, 0, width, height);
    } else {
      this.floatingCtx.drawImage(imageSource, 0, 0, origWidth, origHeight, 0, 0, width, height);
    }

    this._finalizeFloatingSelection(pasteX, pasteY, width, height);

    // Switch to select tool if not already active
    if (this.board.app?.self?.tool !== 'select') {
      this.board.app?.selectTool('select');
    }

    return true;
  }

  obscureSelection() {
    if (!this.selection || this.floatingCanvas) return false;
    if (!this.canCreateObscureRegions()) {
      this.board.app?.ui?.showToast?.('Only trusted users can create obscured regions', 3000);
      return false;
    }

    const app = this.board.app;
    if (!app) return false;

    const s = (this.mode === 'lasso' && this.originalSelection) ? this.originalSelection : this.selection;
    const payload = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      x: Math.round(s.x),
      y: Math.round(s.y),
      width: Math.max(1, Math.round(s.width)),
      height: Math.max(1, Math.round(s.height))
    };
    if (this.mode === 'lasso' && this.lassoPath?.length >= 3) {
      payload.lassoPath = this.lassoPath.map((point) => ({
        x: Math.round(point.x),
        y: Math.round(point.y)
      }));
    }

    this.board.addObscureRegion(payload);
    app.inputBufferManager?.queueBroadcast(
      () => app.wsClient?.broadcastObscureRegion(payload),
      { snapshot: false }
    );
    this.hideContextMenu();
    this.clearSelection();
    return true;
  }

  canCreateObscureRegions() {
    const app = this.board.app;
    const role = Math.max(
      app?.selfRole ?? 0,
      app?.selfRoomRole ?? 0,
      app?.selfGlobalRole ?? 0,
      app?.self?.role ?? 0,
      app?.self?.roomRole ?? 0,
      app?.self?.globalRole ?? 0
    );
    return role >= 2;
  }

  // Delete/clear selection content
  deleteSelection() {
    if (!this.selection) return false;

    const s = this.selection;
    const app = this.board.app;
    if (!app) return false;

    // If floating, erase already happened at lift time — just discard
    if (this.floatingCanvas) {
      this.floatingCanvas = null;
      this.floatingCtx = null;
      this._sourceCropForRemote = null;
      this._restoreData = null;
    } else {
      // Not yet lifted — erase now directly. Tag the erase so it reconciles to
      // the authoritative SEL_DELETE seq (see the 'sel_delete' self-echo handler);
      // otherwise it lingers at seq=0 atop the stack and erases later strokes.
      const lassoPath = this.mode === 'lasso' ? this.lassoPath : null;
      this._eraseSelectionDirectly(s, lassoPath, 'sel_delete');

      // Check affected tiles for emptiness and clear ownership
      const tileOwnership = this.board.tileTracker;
      if (tileOwnership) {
        const affectedTiles = tileOwnership.getTileIndicesForRect(s.x, s.y, s.width, s.height);
        if (affectedTiles.length > 0) {
          this.board.checkErasedTilesByIndices(new Set(affectedTiles));
        }
      }

      // The mirrored erase itself now rides inside _eraseSelectionDirectly's
      // stroke above (so it shares the commit tag and reconciles to the same
      // seq); only the mirrored tile bookkeeping is left to do here.
      if (tileOwnership) {
        for (const { bounds } of this.board.getSelectionMirrorTargets(s)) {
          const mirrorTiles = tileOwnership.getTileIndicesForRect(
            bounds.x, bounds.y, bounds.width, bounds.height
          );
          if (mirrorTiles.length > 0) {
            this.board.checkErasedTilesForOwnershipByIndices(new Set(mirrorTiles));
          }
        }
      }
    }

    // Broadcast delete to other users
    if (app.wsClient) {
      app.inputBufferManager.queueBroadcast(() => app.wsClient.broadcastSelectionDelete(app.self.activeLayer, !!this.copyAllLayers, !!this.board.mirror));
    }

    this.hideContextMenu();
    this.clearSelection();
    return true;
  }

  mergeUp() { return this._performMerge('up'); }
  mergeDown() { return this._performMerge('down'); }
  mergeAll() { return this._performMerge('all'); }

  /**
   * Merge the selected region between layers.
   *  - 'up'/'down': move the active layer's selection contents into the adjacent
   *    layer; the source region is erased from the active layer.
   *  - 'all': flatten the selection across every visible layer into the active
   *    layer; the same region is erased from the other layers.
   * In all modes, the user's in-flight strokes are committed first so the merge
   * captures the full visible state without weirdness from active stroke layers.
   * @param {'up'|'down'|'all'} mode
   */
  _performMerge(mode) {
    if (!this.selection || this.floatingCanvas) return false;
    const app = this.board.app;
    const lm = this.board.layerManager;
    if (!app || !lm) return false;

    const userId = app.self?.id ?? 0;
    const activeLayer = app.self?.activeLayer ?? 0;
    const layerCount = lm.layerGroups.length;
    const s = this.selection;
    const lassoPath = this.mode === 'lasso' && this.lassoPath && this.lassoPath.length >= 3
      ? this.lassoPath
      : null;

    if (mode === 'up' && activeLayer >= layerCount - 1) {
      app.ui?.showToast?.('No layer above to merge into', 2000);
      return false;
    }
    if (mode === 'down' && activeLayer <= 0) {
      app.ui?.showToast?.('No layer below to merge into', 2000);
      return false;
    }
    if (mode === 'all' && layerCount <= 1) return false;

    // flatten range = layers to composite into mergedCanvas (preserves z-order).
    // layersToErase = layers whose selection region is wiped before stamping.
    // For 'up' we MUST flatten both source+target so target's content stays on
    // top of source in the merged canvas (target had higher z-order), then erase
    // both. For 'down', source was already on top, so flattening source alone
    // and stamping source-over on the target's existing content works.
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

    // Commit this user's in-progress strokes across all layers so we operate on
    // baked state only. Other users' active strokes are untouched.
    for (let i = 0; i < layerCount; i++) {
      if (lm.layerGroups[i]?.activeStrokeByUser.has(userId)) {
        lm.commitUserStroke(i, userId);
      }
    }

    // Build the merged content (selection-sized canvas), lasso-masked.
    const mergedCanvas = this._flattenLayerRangeToSelectionCanvas(flattenStart, flattenEnd, s);

    if (lassoPath) {
      this.applyLassoMask(mergedCanvas.getContext('2d'), s.x, s.y, lassoPath);
    }

    const batchTimestamp = typeof lm.allocateHistoryTimestamp === 'function'
      ? lm.allocateHistoryTimestamp()
      : Date.now();

    // For 'up' and 'all', the merged canvas already contains the target layer's
    // content, so erase the target's region too — the stamp replaces it rather
    // than double-stacking. For 'down', the target keeps its existing pixels.
    const layersToErase = (mode === 'up' || mode === 'all')
      ? [...sourceLayers, targetLayer]
      : sourceLayers;

    for (const layerIdx of layersToErase) {
      this._eraseSingleLayerSelection(layerIdx, s, lassoPath, userId, batchTimestamp);
    }

    // Stamp the merged content onto the target layer as a single source-over
    // stroke. Visual z-order is already correct in the merged canvas (the
    // flatten range was chosen so target's content sits above source's).
    lm.beginUserStroke(targetLayer, userId, 'source-over', undefined, s);
    const active = lm.layerGroups[targetLayer]?.activeStrokeByUser.get(userId);
    if (active) {
      const ox = active.origin?.x ?? 0;
      const oy = active.origin?.y ?? 0;
      active.ctx.drawImage(mergedCanvas, s.x - ox, s.y - oy);
      if (active.dirtyRect) {
        active.dirtyRect.minX = s.x;
        active.dirtyRect.minY = s.y;
        active.dirtyRect.maxX = s.x + s.width;
        active.dirtyRect.maxY = s.y + s.height;
      }
      const tt = this.board.tileTracker;
      if (tt && active.affectedTiles) {
        const idxs = tt.getTileIndicesForRect(s.x, s.y, s.width, s.height);
        for (const i of idxs) active.affectedTiles.add(i);
      }
      this.board.expandDirtyRect(app.self, s.x, s.y, s.width, s.height, targetLayer);
      lm.commitUserStroke(targetLayer, userId, {
        timestamp: batchTimestamp,
        isSelectionMerge: true,
        pendingCommitEcho: 'sel_merge'
      });
    }

    this.board.compositeTileGrid?.markRect(s.x, s.y, s.width, s.height);
    this.board.markCompositeFull();
    this.board.compositeAllLayers();
    this.board.addOccupancyForVisibleTilesInRect(userId, s.x, s.y, s.width, s.height);

    if (app.wsClient) {
      app.inputBufferManager.queueBroadcast(() => app.wsClient.broadcastSelectionMerge(mode, activeLayer));
    }

    this.hideContextMenu();
    this.clearSelection();
    return true;
  }

  /**
   * Erase the selection region from a single layer as a destination-out stroke.
   * Shares a batch timestamp with the surrounding merge so undo treats them as one.
   * @private
   */
  _eraseSingleLayerSelection(layerIdx, s, lassoPath, userId, batchTimestamp) {
    this._eraseRegionStroke(layerIdx, s, lassoPath, userId, {
      timestamp: batchTimestamp,
      isSelectionMerge: true,
      isSelectionErase: true,
      // Reconciled to the authoritative SEL_MERGE seq by the self-echo. A merge
      // commits several destination-out strokes plus a source-over stamp; left
      // at seq 0 they sort by each client's own locally-allocated timestamp, so
      // drawer and observers ordered the same merge differently.
      pendingCommitEcho: 'sel_merge'
    });
  }

  // Select all
  selectAll() {
    this.commitSelection();
    this.clearSelection();

    this.selection = {
      x: 0,
      y: 0,
      width: this.board.getWidth(),
      height: this.board.getHeight()
    };

    // Initialize corners for transform handles
    this.initializeCorners();
    this.updateHandles();
    this.board.clearTop();
    this.drawSelectionUI();
  }

  // Deselect
  deselect() {
    this.commitSelection();
    this.clearSelection();
  }

  hasSelection() {
    return this.selection !== null;
  }

  hasClipboard() {
    return this.clipboard !== null;
  }

  // Fill selection with current color or pattern
  fillSelection() {
    if (!this.selection) return false;

    // Use original selection for fills if it was cropped to content
    const s = this.originalSelection || this.selection;
    const app = this.board.app;
    if (!app) return false;

    const opacity = app.self.opacity !== undefined ? app.self.opacity : 1;

    // Board-space rect the fill actually painted into the layer, for the
    // selection re-expansion at the end. Null while floating: the paint goes
    // into the float, not the board.
    let paintedArea = null;

    if (this.floatingCanvas) {
      // Fill directly into the floating canvas (local coords: offsetX/Y = selection origin)
      this._executeFill(this.floatingCtx, s, app.self, opacity, s.x, s.y);
      this.board.clearTop();
      this.drawSelectionUI();
    } else {
      // Fill on the active layer via a temp canvas, then blit to layer coords.
      // The temp canvas already has the lasso shape (and any pattern) baked in,
      // so each mirrored copy is the same blit under the region's transform —
      // no mirrored lasso path to derive, and every mirror mode works.
      this.board.beginStroke(app.self);
      const layerCtx = this.board.getActiveLayerContext();

      // Fill the rect we are about to BROADCAST, not the raw selection.
      // broadcastSelectionFill rounds, and a lasso selection's bounds are
      // fractional, so filling at `s` painted a sub-pixel-offset rect while
      // every receiver painted the rounded one. The seam is one pixel of edge —
      // invisible under the parity tolerance on a single copy, and enough to
      // fail it once a mirror doubles the edges (fill_lasso_mirrored).
      const area = {
        x: Math.round(s.x),
        y: Math.round(s.y),
        width: Math.round(s.width),
        height: Math.round(s.height),
      };
      paintedArea = area;

      const temp = document.createElement('canvas');
      temp.width = area.width;
      temp.height = area.height;
      this._executeFill(temp.getContext('2d'), area, app.self, opacity, area.x, area.y);

      const blit = (ctx) => ctx.drawImage(temp, area.x, area.y);
      blit(layerCtx);

      const mirrorTargets = this.board.getSelectionMirrorTargets(area);
      for (const { region } of mirrorTargets) {
        this.board.withMirroredRegionTransform(layerCtx, region, () => blit(layerCtx));
      }

      // Dirty rect + tile tracking, over the union so the committed stroke isn't
      // cropped back to the unmirrored fill.
      const userId = app.self?.id ?? 0;
      const activeLayer = app.self?.activeLayer ?? 0;
      const tileOwnership = this.board.tileTracker;
      const lm = this.board.layerManager;
      const active = lm?.layerGroups[activeLayer]?.activeStrokeByUser.get(userId);
      const paintedRects = [area, ...mirrorTargets.map(t => t.bounds)];

      for (const rect of paintedRects) {
        this.board.expandDirtyRect(app.self, rect.x, rect.y, rect.width, rect.height);
        if (tileOwnership && active?.affectedTiles) {
          for (const idx of tileOwnership.getTileIndicesForRect(rect.x, rect.y, rect.width, rect.height)) {
            active.affectedTiles.add(idx);
          }
        }
        this.board.compositeTileGrid?.markRect(rect.x, rect.y, rect.width, rect.height);
      }

      this.board.compositeAllLayers();
      // Tagged so the SEL_FILL self echo assigns the authoritative seq — same
      // pairing rule as commitSelection.
      this.board.endStroke(app.self, { pendingCommitEcho: 'sel_fill' });

      // Tile occupancy (must be after composite)
      for (const rect of paintedRects) {
        this.board.addOccupancyForVisibleTilesInRect(userId, rect.x, rect.y, rect.width, rect.height);
      }
    }

    if (this.board.app?.wsClient) {
      // Send the rect actually filled (`s` — the pre-crop original when the
      // selection was cropped to content), not the displayed selection.
      const filled = { x: s.x, y: s.y, width: s.width, height: s.height };
      // Snapshot the path: this is queued, and the lasso-bounds expansion below
      // (plus any later drag) mutates this.lassoPath in place.
      const filledLasso = (this.mode === 'lasso' && this.lassoPath && this.lassoPath.length >= 3)
        ? this.lassoPath.map((p) => ({ x: p.x, y: p.y }))
        : null;
      // Mirror state at fill time, for the same reason SEL_DELETE carries it:
      // a joiner replaying the tail has not necessarily applied the room's
      // mirror toggle yet, so the receiver cannot infer it.
      const wasMirrored = !!this.board.mirror;
      this.board.app.inputBufferManager.queueBroadcast(
        () => this.board.app.wsClient.broadcastSelectionFill(app.self.color, app.self.activeLayer, filled, filledLasso, wasMirrored));
    }

    // After filling, the selection has to cover every pixel the fill painted, or
    // the next Clear/Cut/Move only takes part of it back and leaves a rim of
    // fill behind — the operations are all pinned to `this.selection`. The
    // painted area outruns the displayed selection two ways:
    //   - lasso: the shape is the path, while `cropNewSelectionToContent` shrank
    //     the box drawn around it;
    //   - rect: the fill deliberately paints `originalSelection` (the full
    //     dragged rect) and the displayed selection is the cropped one.
    let expandedSelection = null;
    if (this.mode === 'lasso' && this.lassoPath) {
      const lassoBounds = this.getBoundsFromPoints(this.lassoPath);

      // If we had a floating selection, we need to re-lift it with the new expanded bounds
      if (this.floatingCanvas) {
        // Save the current floating data
        const oldFloatingCanvas = this.floatingCanvas;
        const oldSelection = this.selection;

        // Expand selection to lasso bounds
        this.selection = { ...lassoBounds };

        // Create new floating canvas with expanded dimensions
        const newFloatingCanvas = document.createElement('canvas');
        newFloatingCanvas.width = this.selection.width;
        newFloatingCanvas.height = this.selection.height;
        const newCtx = newFloatingCanvas.getContext('2d');

        // Draw the old floating canvas at its correct offset within the new canvas
        const offsetX = oldSelection.x - this.selection.x;
        const offsetY = oldSelection.y - this.selection.y;
        newCtx.drawImage(oldFloatingCanvas, offsetX, offsetY);

        // Replace the floating canvas
        this.floatingCanvas = newFloatingCanvas;
        this.floatingCtx = newCtx;
      } else {
        this.selection = { ...lassoBounds };
      }

      this.originalSelection = null;
      expandedSelection = this.selection;

      // Redraw the selection UI to show the expanded bounds
      this.initializeCorners();
      this.updateHandles();
      this.board.clearTop();
      this.drawSelectionUI();
    } else if (paintedArea && this.originalSelection) {
      // Rect fill of a content-cropped selection: grow back to the rect that was
      // actually painted. Same shape fit-to-content would pick now that the
      // whole dragged box is content.
      this.selection = { ...paintedArea };
      this.originalSelection = null;
      expandedSelection = this.selection;

      this.initializeCorners();
      this.updateHandles();
      this.board.clearTop();
      this.drawSelectionUI();
    }

    if (expandedSelection && !this.floatingCanvas) {
      // Growing the box is not a move; leaving the old origin behind makes
      // hasMoved() true and hides Fill from the menu for the rest of the
      // selection's life.
      this.originalSelectionPos = { x: this.selection.x, y: this.selection.y };

      // Observers erase their own `pendingSelection` (RemoteSelectionHandler
      // .handleSelectionDelete / SEL_LIFT), so the growth has to reach them:
      // otherwise the drawer's clear comes out clean and every observer keeps
      // the rim. Queued after the SEL_FILL above, which carries its own rect.
      if (this.board.app?.wsClient) {
        const rect = cloneSelectionRect(this.selection);
        const path = clonePathPoints(this.lassoPath);
        this.board.app.inputBufferManager.queueBroadcast(
          () => this.board.app.wsClient.broadcastSelectionPending(rect, path), { snapshot: false });
      }
    }

    // Keep selection active, update menu buttons only (don't reposition)
    this.showContextMenu(true);
    return true;
  }

  // Stamp current selection to canvas without clearing it (for repeated stamping)
  stamp() {
    if (!this.floatingCanvas || !this.selection) return false;

    const app = this.board.app;
    if (!app) return false;

    const lm = this.board.layerManager;
    const userId = app.self?.id ?? 0;
    const hasTransform = this.needsHomographyTransform();
    const stampBatchTimestamp = typeof lm?.allocateHistoryTimestamp === 'function'
      ? lm.allocateHistoryTimestamp()
      : Date.now();

    const layers = (this.copyAllLayers && this.floatingLayers && this.floatingLayers.length > 0)
      ? this.floatingLayers
      : [{ canvas: this.floatingCanvas, groupIdx: app.self?.activeLayer ?? 0 }];

    // Compute actual bounds once (may differ from selection if transformed)
    let dirtyX = this.selection.x;
    let dirtyY = this.selection.y;
    let dirtyW = this.selection.width;
    let dirtyH = this.selection.height;

    let stampOutputBounds = null;
    if (hasTransform && this.corners) {
      stampOutputBounds = this._getWarpOutputBounds();
      const bounds = stampOutputBounds || calculateCornerBounds(this.corners);
      dirtyX = Math.round(bounds.minX);
      dirtyY = Math.round(bounds.minY);
      dirtyW = Math.ceil(bounds.width);
      dirtyH = Math.ceil(bounds.height);
    }

    // See commitSelection: mirrored copies must be inside the dirty rect before
    // commitUserStroke crops the stroke to it.
    const { targets: mirrorTargets, dirty } = this._getFloatingMirrorPlan(
      { x: dirtyX, y: dirtyY, width: dirtyW, height: dirtyH }
    );
    dirtyX = dirty.x;
    dirtyY = dirty.y;
    dirtyW = dirty.width;
    dirtyH = dirty.height;

    // Get affected tile indices for undo tracking
    const tileOwnership = this.board.tileTracker;
    const stampTileIndices = tileOwnership
      ? tileOwnership.getTileIndicesForRect(dirtyX, dirtyY, dirtyW, dirtyH)
      : [];

    const stampBounds = { x: dirtyX, y: dirtyY, width: dirtyW, height: dirtyH };
    for (const { canvas, groupIdx } of layers) {
      lm.beginUserStroke(
        groupIdx,
        userId,
        this._getSelectionCommitBlendMode(groupIdx),
        this._getSelectionCommitBlendBakeMode(),
        stampBounds
      );
      const active = lm.layerGroups[groupIdx]?.activeStrokeByUser.get(userId);
      if (!active) continue;

      if (active.dirtyRect) {
        active.dirtyRect.minX = dirtyX;
        active.dirtyRect.minY = dirtyY;
        active.dirtyRect.maxX = dirtyX + dirtyW;
        active.dirtyRect.maxY = dirtyY + dirtyH;
      }

      // Store affected tiles in the stroke record for undo
      if (active.affectedTiles) {
        for (const idx of stampTileIndices) {
          active.affectedTiles.add(idx);
        }
      }

      this._drawFloatingToActiveStroke(active, canvas, hasTransform, stampOutputBounds, mirrorTargets);

      // Tagged so the SEL_STAMP self echo assigns the authoritative seq. Same
      // pairing rule as commitSelection: safe only because the lift-erase beneath
      // it is sequenced from SEL_LIFT.
      lm.commitUserStroke(groupIdx, userId, { timestamp: stampBatchTimestamp, pendingCommitEcho: 'sel_stamp' });
    }

    // Composite and commit the stroke
    this.board.markCompositeFull();
    this.board.compositeAllLayers();

    // Add tile ownership for visible stamped tiles (after composite)
    this.board.addOccupancyForVisibleTilesInRect(userId, dirtyX, dirtyY, dirtyW, dirtyH);

    // Broadcast tile ownership update and stamp
    if (this.board.app?.wsClient) {
      if (stampTileIndices.length > 0) {
        this.board.app.wsClient.broadcastTileUpdate(stampTileIndices);
      }
      // See _broadcastSelectionCommit: extendedWarp and the full-board mirror
      // state travel fresh with the stamp too, since either can change between
      // the lift and any given stamp.
      const wasMirrored = !!this.board.mirror;
      this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionStamp(app.self?.activeLayer ?? 0, this.extendedWarp, wasMirrored));
    }

    // Redraw the floating selection on top canvas
    this.board.clearTop();
    this.drawSelectionUI();
    this.showContextMenu(true);

    return true;
  }

  // Flip selection horizontally
  flipHorizontal() {
    if (!this.selection) return false;

    // If selection hasn't been lifted yet, lift it first
    if (!this.floatingCanvas) {
      this.liftSelection();
    }

    if (!this.floatingCanvas) return false;

    if (this.needsHomographyTransform()) {
      this._flipTransformCorners();
    } else {
      this.floatingCanvas = this._createHorizontallyFlippedCanvas(this.floatingCanvas);
      this.floatingCtx = this.floatingCanvas.getContext('2d');

      if (this.floatingLayers && this.floatingLayers.length > 0) {
        this.floatingLayers = this.floatingLayers.map(({ canvas, groupIdx }) => ({
          canvas: this._createHorizontallyFlippedCanvas(canvas),
          groupIdx
        }));
      }

      this.selectedImageData = this.floatingCtx.getImageData(
        0,
        0,
        this.floatingCanvas.width,
        this.floatingCanvas.height
      );

      // If there are original corners (for transforms), flip them horizontally
      if (this.originalCorners) {
        const width = this.floatingCanvas.width;
        // Swap left and right corners and flip their x positions
        const temp = {
          tl: { ...this.originalCorners.tl },
          tr: { ...this.originalCorners.tr },
          bl: { ...this.originalCorners.bl },
          br: { ...this.originalCorners.br }
        };

        // Flip x coordinates and swap left/right
        this.originalCorners.tl = { x: width - temp.tr.x, y: temp.tr.y };
        this.originalCorners.tr = { x: width - temp.tl.x, y: temp.tl.y };
        this.originalCorners.bl = { x: width - temp.br.x, y: temp.br.y };
        this.originalCorners.br = { x: width - temp.bl.x, y: temp.bl.y };
      }

      // Broadcast flip to other users
      if (this.board.app?.wsClient) {
        this.board.app.inputBufferManager.queueBroadcast(() => this.board.app.wsClient.broadcastSelectionFlip());
      }
    }

    // Invalidate cached transform since the flip changed the rendered output
    this._cachedTransform = null;

    // Redraw the selection with flipped content
    this.board.clearTop();
    this.drawSelectionUI();
    this.showContextMenu(true);

    return true;
  }

  // Mirror the destination corner quad about the vertical centerline of its
  // bounds. Flipping the source pixels would re-warp the mirrored image
  // through the same quad; reflecting the destination points flips the
  // rendered result in place instead.
  _flipTransformCorners() {
    const bounds = calculateCornerBounds(this.corners);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    for (const key of ['tl', 'tr', 'bl', 'br']) {
      this.corners[key].x = 2 * centerX - this.corners[key].x;
    }
    this.updateSelectionFromCorners();
    this.updateHandles();

    // Remote users pick up the flip from the corner update
    this.throttledBroadcastSelectionMove(this.corners, true);
  }

  _createHorizontallyFlippedCanvas(sourceCanvas) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sourceCanvas.width;
    tempCanvas.height = sourceCanvas.height;
    const tempCtx = tempCanvas.getContext('2d');

    tempCtx.save();
    tempCtx.translate(tempCanvas.width, 0);
    tempCtx.scale(-1, 1);
    tempCtx.drawImage(sourceCanvas, 0, 0);
    tempCtx.restore();

    return tempCanvas;
  }

  // Returns a canvas of the current selection content (transparent background).
  // Returns null if no selection is active.
  getSelectionExportCanvas() {
    if (!this.selection) return null;

    let canvas;
    if (this.floatingCanvas) {
      canvas = this.needsHomographyTransform() ? this.getTransformedCanvas() : this.floatingCanvas;
    } else {
      const s = this.selection;
      canvas = this._flattenSelectionToCanvas(s);
      if (this.mode === 'lasso' && this.lassoPath) {
        this.applyLassoMask(canvas.getContext('2d'), s.x, s.y, this.lassoPath);
      }
    }

    return this._padExportCanvas(canvas);
  }

  // Adds transparent breathing room around a selection export. Fit-to-content
  // snaps the selection flush to the exact opaque pixel bounds, so without this
  // the saved image would touch the edge of the frame with no margin.
  _padExportCanvas(canvas) {
    const padding = this.exportPadding;
    if (!canvas || !padding) return canvas;
    const out = document.createElement('canvas');
    out.width = canvas.width + padding * 2;
    out.height = canvas.height + padding * 2;
    out.getContext('2d').drawImage(canvas, padding, padding);
    return out;
  }

  /**
   * Axis-aligned board-space rect covering what getSelectionExportCanvas()
   * hands back. The gallery time-lapse crops to this, so a saved selection
   * gets a clip of that area rather than the whole board. Transformed
   * (perspective/rotated) selections use the quad's bounding box — the same
   * area the transformed export canvas covers.
   * @returns {{x: number, y: number, width: number, height: number}|null}
   */
  getSelectionBoardRegion() {
    if (!this.selection) return null;

    let { x, y, width, height } = this.selection;
    if (this.corners && this.needsHomographyTransform()) {
      const c = this.corners;
      const xs = [c.tl.x, c.tr.x, c.bl.x, c.br.x];
      const ys = [c.tl.y, c.tr.y, c.bl.y, c.br.y];
      x = Math.min(...xs);
      y = Math.min(...ys);
      width = Math.max(...xs) - x;
      height = Math.max(...ys) - y;
    }

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    };
  }

  // Save selection as image file - opens save dialog with selection highlighted
  saveSelection() {
    const canvas = this.getSelectionExportCanvas();
    if (!canvas) return false;

    const app = this.board.app;
    if (app?.saveMode) {
      // Open save dialog with the selection canvas. Hide the selection outline
      // from other users while we're in the dialog deciding what to do with
      // it — otherwise it just sits there on their board looking active.
      this.hideContextMenu();
      app.wsClient?.broadcastSelectionVisibility(true);
      app.saveMode.openWithCanvas(canvas, {
        boardRegion: this.getSelectionBoardRegion(),
        onClose: () => app.wsClient?.broadcastSelectionVisibility(false)
      });
    } else {
      // Fallback to direct download if SaveMode not available
      const dataURL = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      link.download = `selection-${timestamp}.png`;
      link.href = dataURL;
      link.click();

      if (this.board.app?.ui) {
        this.board.app.ui.showToast('Selection saved!');
      }
      this.hideContextMenu();
    }

    return true;
  }

  // Convert selection to image brush
  toImageBrush() {
    if (!this.selection) return false;

    const app = this.board.app;
    if (!app) return false;

    // Get the transformed image data
    let canvas;
    if (this.floatingCanvas) {
      // Use transformed canvas if homography was applied
      canvas = this.getTransformedCanvas();
    } else {
      const s = this.selection;
      canvas = this._flattenSelectionToCanvas(s);
      // Apply lasso mask if in lasso mode
      if (this.mode === 'lasso' && this.lassoPath) {
        this.applyLassoMask(canvas.getContext('2d'), s.x, s.y, this.lassoPath);
      }
    }

    const dataUrl = canvas.toDataURL();

    // Persist the selection as a custom image brush so it shows up in the
    // brush list and survives reloads. Giving each one a unique id/name is
    // also what makes a freshly-made selection brush actually override the
    // previous one: the image-brush tint cache keys on brushName/fileName,
    // so brushes without one all collided on a shared "brush" key.
    const uniqueTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const customAsset = assetLibrary.addCustomAsset({
      kind: 'imageBrush',
      type: 'image',
      fileType: 'png',
      fileName: `selection-${uniqueTag}.png`,
      dataUrl,
      gimpUrl: dataUrl,
      brushName: `Selection ${uniqueTag}`
    });

    // Create brush data structure similar to GIMP brush
    const brushData = {
      ...customAsset,
      type: 'image',
      width: canvas.width,
      height: canvas.height,
      gimpUrl: dataUrl,
      image: null // Will be set when loaded
    };

    // Create the image element
    const img = new Image();
    img.onload = () => {
      brushData.image = img;

      // Set as active brush and switch to imageBrush tool (this also lazy-loads
      // the gallery, which will pick the new asset up from storage on first open).
      app.self.imageBrush = brushData;
      app.selectTool('imageBrush');

      // Add to the custom brush list now if the gallery is already loaded
      // (avoid a duplicate if selectTool just loaded it from storage).
      const gallery = app.brushGallery?.realGallery;
      if (gallery && !gallery.brushes.some(b => b.id === brushData.id)) {
        gallery.registerBrush({ ...brushData, image: img });
      }

      app.ui.setBrushPreview(brushData.gimpUrl);

      // Broadcast brush to other users (strip the non-serializable image element)
      const broadcastData = { ...brushData };
      delete broadcastData.image;
      app.inputBufferManager.queueBroadcast(() => app.wsClient.broadcastBrush(broadcastData));
      app.inputBufferManager.queueBroadcast(() => app.wsClient.broadcastSelectionToBrush(broadcastData));
    };
    img.src = dataUrl;

    // Deselect after converting to brush
    this.deselect();

    return true;
  }

  // Check if corners have been transformed from their original positions
  hasTransformedCorners() {
    if (!this.corners || !this.originalCorners || !this.selection) return false;

    // Compare current corner positions with what they would be if untransformed
    const s = this.selection;
    const untransformed = {
      tl: { x: s.x, y: s.y },
      tr: { x: s.x + s.width, y: s.y },
      bl: { x: s.x, y: s.y + s.height },
      br: { x: s.x + s.width, y: s.y + s.height }
    };

    const tolerance = 0.5;
    const c = this.corners;

    return (
      Math.abs(c.tl.x - untransformed.tl.x) > tolerance ||
      Math.abs(c.tl.y - untransformed.tl.y) > tolerance ||
      Math.abs(c.tr.x - untransformed.tr.x) > tolerance ||
      Math.abs(c.tr.y - untransformed.tr.y) > tolerance ||
      Math.abs(c.bl.x - untransformed.bl.x) > tolerance ||
      Math.abs(c.bl.y - untransformed.bl.y) > tolerance ||
      Math.abs(c.br.x - untransformed.br.x) > tolerance ||
      Math.abs(c.br.y - untransformed.br.y) > tolerance
    );
  }

  // Check if selection has been scaled from its original size
  hasScaledSelection() {
    if (!this.selection || !this.originalCorners || !this.floatingCanvas) return false;
    const tolerance = 1; // Allow 1px tolerance for rounding
    return (
      Math.abs(this.selection.width - this.originalCorners.br.x) > tolerance ||
      Math.abs(this.selection.height - this.originalCorners.br.y) > tolerance
    );
  }

  // Get transformed canvas (applies homography if corners are transformed)
  getTransformedCanvas() {
    if (!this.floatingCanvas) return null;

    // If no perspective/rotation transform is needed, use a plain scaled canvas.
    if (!this.needsHomographyTransform()) {
      return this.getRectScaledCanvas();
    }

    // Perform the transform using shared utility
    const result = performHomographyTransform({
      sourceCanvas: this.floatingCanvas,
      sourceCorners: this.originalCorners,
      destCorners: this.corners,
      scale: 1 // Full resolution
    });

    if (result) {
      return imageDataToCanvas(result.imageData);
    }

    // Fallback to original
    return this.floatingCanvas;
  }

  /**
   * Cancel a lifted selection by discarding it, then undoing the lift erase.
   */
  cancelSelection() {
    if (!this.selection) return false;

    if (!this.floatingCanvas) {
      this.hideContextMenu();
      this.clearSelection();
      return true;
    }

    // Only roll back an undo step if a lift actually erased pixels from the
    // canvas. Clones and pastes never touched the canvas, so calling
    // handleUndo() would pop an unrelated prior action instead.
    const hasLiftToUndo = !!this._restoreData;

    const app = this.board.app;

    // Nothing was lifted (clone/paste): no pixels were erased, so there is
    // nothing for a peer to put back and the ordinary delete path is exactly
    // right. SEL_CANCEL would be actively wrong here — with no restore data
    // the receiver's cancel handler falls through to redrawing the float at
    // its origin, stamping the very paste the user just cancelled.
    if (!hasLiftToUndo) return this.deleteSelection();

    // A lifted float. SEL_DELETE cannot express this cancel: its receiver-side
    // floating branch RELABELS our lift-erase stroke to the SEL_DELETE seq
    // (RemoteSelectionHandler._setSelectionEraseStrokeSeq), and the UNDO we
    // used to send straight after names the seq the stroke had BEFORE that
    // relabel. The named target then matches nothing, the seq-0-only fallback
    // declines to guess, and every peer keeps the hole forever while we
    // restore locally — measured at 88.4% A<->B/C/D on selparity move_cancel.
    //
    // SEL_CANCEL is the verb that already means "put the lifted pixels back",
    // and its handler removes the erase stroke by identity rather than by seq,
    // so it cannot be desynchronised the same way. It also needs no follow-up
    // UNDO — sending one too would double-instruct the peers.
    this.floatingCanvas = null;
    this.floatingCtx = null;
    this._sourceCropForRemote = null;
    this._restoreData = null;

    if (app?.wsClient) {
      app.inputBufferManager.queueBroadcast(() => app.wsClient.broadcastSelectionCancel());
    }

    this.hideContextMenu();
    this.clearSelection();

    // Local rollback only. The peers are already handling SEL_CANCEL above.
    this.board.undo(app?.self?.activeLayer ?? 0, app?.self?.id ?? 0);

    return true;
  }
}
