/**
 * @fileoverview Image brush tool - supports GIMP brushes (.gbr/.gih) and standard images.
 * Uses distance-based spacing for consistent stamp intervals regardless of cursor speed.
 */

import { parseGbr, parseGih } from '../utils/parseGimp.js';
import { debug } from '../utils/debug.js';
import {
  buildPreviewStrokePoints,
  drawPreviewStrokeGuide,
  getPreviewPointAngle,
  prepareStrokePreviewCanvas
} from '../ui/StrokePreviewRenderer.js';
import { Tool } from './BaseTool.js';
import { pressureOpacityFactor, pressureSizeFactor } from '../../shared/pressureTargets.js';

function getPreviewStampSpacing(user, previewSize = 25) {
  const spacing = Math.max(0, Math.min(50, Number(user?.spacing ?? 0)));
  const spacingPercent = spacing === 0 ? 0.1 : spacing * 0.05;
  return Math.max(1, previewSize * spacingPercent);
}

function filterPreviewPointsBySpacing(points, minSpacing) {
  if (!points?.length) return [];

  const filtered = [points[0]];
  let lastPoint = points[0];
  let distanceTraveled = 0;

  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    distanceTraveled += Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
    if (distanceTraveled >= minSpacing) {
      filtered.push(point);
      distanceTraveled = 0;
    }
    lastPoint = point;
  }

  return filtered;
}

function isDrawableImageSource(image) {
  if (!image) return false;
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) {
    return image.complete && image.naturalWidth > 0;
  }
  return Number.isFinite(image.width) && image.width > 0 &&
    Number.isFinite(image.height) && image.height > 0;
}

/**
 * Image brush tool - supports GIMP brushes (.gbr/.gih) and standard images.
 */
export class ImageBrushTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('imageBrush', board);
    this.lastStampPos = new Map(); // userId -> {x, y}
    this.stampBuffer = []; // [x, y, x, y, ...] for broadcast
    this._tintCache = new Map();
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool and cleans up tracking.
   */
  deactivate() {
    if (this._activeUser && this.lastStampPos.has(this._activeUser.id)) {
      const lastPos = this.lastStampPos.get(this._activeUser.id);
      this.onPointerUp(this._activeUser, lastPos);
    }
    this.lastStampPos.clear();
    this._activeUser = null;
  }

  /**
   * Begin this user's active stroke windowed to a seed point instead of via
   * `Board.beginStroke` — that shared wrapper calls `LayerManager.beginUserStroke`
   * with no `bounds`, allocating full-board immediately; a later windowed
   * `getUserStrokeContext` call would then find `active` already exists with
   * `origin: null` and never grow. Same trap already found and fixed in
   * EraserTool/BlurTool/GlitchBlurTool/ConfettiTool. Replicates `beginStroke`'s
   * other effects (mask clip, requestUpdate) directly.
   * @private
   */
  _beginStrokeWindowed(user, pos) {
    if (user?.panning) return;
    const strokeLayer = user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.board.app?.self?.id ?? 0;
    const blendMode = user?.blendMode ?? 'source-over';
    // Stamp footprint is size-dependent (scaledSize * aspect ratio, computed
    // in drawStamp) and unknown here until a brush image loads — use a
    // generous multiple of size as the seed; drawStamp's own per-stamp
    // growth call corrects it to the exact footprint on the first real draw.
    const margin = Math.max(1, (user?.size ?? 10)) * 2;
    const bounds = this._foldMirrorBounds({
      x: pos.x - margin, y: pos.y - margin, width: margin * 2, height: margin * 2
    });
    this.board.layerManager?.beginUserStroke(strokeLayer, userId, blendMode, user?.blendBakeMode, bounds);
    this.board.applySelectionMaskClipForStroke(strokeLayer, userId);
    this.board.requestUpdate();
  }

  /**
   * Expand a board-absolute box to also cover every active mirror region's
   * transformed copy — same simplification the rest of this windowing
   * campaign uses (brush/eraser/blur/glitchBlur/confetti).
   * @private
   */
  _foldMirrorBounds(bounds) {
    const regions = this.board.getActiveMirrorRegions?.() || [];
    if (!regions.length) return bounds;
    let minX = bounds.x, minY = bounds.y;
    let maxX = bounds.x + bounds.width, maxY = bounds.y + bounds.height;
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
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    if (user.imageBrush) {
      this._activeUser = user;
      this._beginStrokeWindowed(user, pos);
      user._imageBrushLastPos = { x: pos.x, y: pos.y };
      user._imageBrushLastTime = performance.now();
      if (user.imageBrush.type === 'gih' && user.imageBrush.reset) {
        user.imageBrush.reset();
      }
      user._imageBrushDirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      user._imageBrushStrokePoints = [{ x: pos.x, y: pos.y }];
      this.drawStamp(user, pos);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerMove(user, pos) {
    this._moveStroke(user, pos, true);
  }

  onPointerMoveNoRender(user, pos) {
    this._moveStroke(user, pos, false);
  }

  _moveStroke(user, pos, shouldRequestUpdate) {
    if (!user.mousedown || user.panning || !user.imageBrush) return;

    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp) {
      this.drawStamp(user, pos);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      if (shouldRequestUpdate) this.board.requestUpdate();
      return;
    }

    const dx = pos.x - lastStamp.x;
    const dy = pos.y - lastStamp.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
    const minSpacing = Math.max(1, user.size * spacingPercent);

    if (distance >= minSpacing) {
      const steps = Math.max(1, Math.floor(distance / minSpacing));

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const interpX = lastStamp.x + dx * t;
        const interpY = lastStamp.y + dy * t;
        this.drawStamp(user, { x: interpX, y: interpY });
        this.stampBuffer.push(interpX, interpY);
        this._getStrokePoints(user).push({ x: interpX, y: interpY });
      }

      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      if (shouldRequestUpdate) this.board.requestUpdate();
    }
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {
    if (user.panning || !user.imageBrush) return;

    const dirtyBounds = user._imageBrushDirtyBounds;
    const strokePoints = this._getStrokePoints(user);
    if (dirtyBounds && dirtyBounds.maxX !== -Infinity) {
      const brushRadius = user.size;
      const safetyMargin = brushRadius * 0.25;
      const margin = safetyMargin + 2; 

      const x = Math.floor(dirtyBounds.minX - margin);
      const y = Math.floor(dirtyBounds.minY - margin);
      const width = Math.ceil(dirtyBounds.maxX - dirtyBounds.minX + margin * 2);
      const height = Math.ceil(dirtyBounds.maxY - dirtyBounds.minY + margin * 2);

      this.board.expandDirtyRect(user, x, y, width, height);

      this.board.forEachMirrorRegion({ rect: { x, y, width, height } }, (region) => {
        const p1 = this.board.mirrorPointToRegion({ x: dirtyBounds.minX, y: dirtyBounds.minY }, region);
        const p2 = this.board.mirrorPointToRegion({ x: dirtyBounds.maxX, y: dirtyBounds.maxY }, region);
        const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
        const my = Math.floor(Math.min(p1.y, p2.y) - margin);
        const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
        const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
        this.board.expandDirtyRect(user, mx, my, mw, mh);
      });
    }

    // Track tile ownership
    if (strokePoints.length > 0) {
      this.board.markDirtyPath(user, strokePoints, user.size);
      this.board.forEachMirrorRegion({ points: strokePoints }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(strokePoints, region), user.size);
      });
    }
    user._imageBrushStrokePoints = [];

    this.board.endStroke(user);
    if (this._isLocalUser(user)) this.board.clearTop();
    else user.context?.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());

    this.lastStampPos.delete(user.id);
    user._imageBrushDirtyBounds = null;
  }

  drainStampBuffer() {
    const ps = this.stampBuffer;
    this.stampBuffer = [];
    const rs = Array(ps.length / 2).fill(0);
    return { ps, rs };
  }

  applyStamps(user, ps) {
    // Check if the user object and its ID are valid (allow ID 0).
    // Changed from 'user && user.id' to 'user && user.id != null' to correctly handle user ID 0.
    const isUserValid = user && user.id != null;

    if (!isUserValid) {
        console.error(`ImageBrushTool: Skipping stroke application for invalid user/ID. User data:`, user);
        return;
    }

    // If activeLayer is not set for this user (e.g., remote user receiving stroke data),
    // initiate a new stroke to create it. This mimics behavior for local users.
    // Target the layer where the stroke actually started, fallback to activeLayer
    const strokeLayer = user._strokeLayer ?? user.activeLayer ?? 0;

    // Check if there is already an active stroke for this user on that layer.
    const hasActiveStroke = this.board.layerManager?.getActiveStroke(strokeLayer, user.id);

    if (!hasActiveStroke && ps.length >= 2) {
        debug.warn(`ImageBrushTool: User ${user.id} has no active stroke on layer ${strokeLayer}. Initiating new stroke.`);
        this._beginStrokeWindowed(user, { x: ps[0], y: ps[1] });
    }
    
    // After ensuring activeLayer is set, proceed with drawing.
    // The drawStamp method itself still checks if the context is valid.
    const points = [];
    const strokePoints = this._getStrokePoints(user);
    for (let i = 0; i < ps.length; i += 2) {
      const pos = { x: ps[i], y: ps[i + 1] };
      this.drawStamp(user, pos);
      points.push(pos);
      strokePoints.push(pos);
    }

    // Track tile ownership
    if (points.length > 0) {
      this.board.markDirtyPath(user, points, user.size);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), user.size);
      });
    }
    this.board.requestUpdate();
  }

  /**
   * Draw the mirrored live preview for the active image-brush stroke.
   * The primary stroke already exists on the active stroke layer canvas,
   * so the top canvas only needs the mirrored replay.
   * @param {Object} user
   */
  /** The mirrored preview persists between ticks while a stroke is in progress. */
  redrawPreview(user = this._activeUser) {
    if (!user?.mousedown) return;
    this.board.clearTop();
    this.drawPreview(user);
  }

  drawPreview(user = this._activeUser) {
    if (!user) return;
    const strokeCtx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
    const previewCtx = this.board.topCtx;
    if (!strokeCtx || !previewCtx || !strokeCtx.canvas) return;

    // strokeCtx.canvas may now be windowed (see docs/
    // scope_layermanager_active_stroke_windowing_RESULT.md) — its own local
    // (0,0) is board position `origin`, not board (0,0), so drawMirroredCanvas
    // must draw it there instead of at a hardcoded (0,0).
    const active = this.board.layerManager.getActiveStroke(user.activeLayer, user.id);
    const ox = active?.origin?.x ?? 0;
    const oy = active?.origin?.y ?? 0;

    previewCtx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
    this.board.withSelectionMaskClip(previewCtx, user.id, () => {
      this.board.forEachMirrorRegion({ points: this._getStrokePoints(user) }, (region) => {
        this.board.drawMirroredCanvas(previewCtx, strokeCtx.canvas, region, ox, oy);
      });
    });
    previewCtx.globalAlpha = 1.0;
  }

  updatePreview(user) {
    const canvas = document.getElementById('toolPreviewCanvas');
    if (!canvas) return;
    if (!user) user = this.board.self || this.board.app?.self;
    if (!user?.imageBrush) return;

    const ctx = prepareStrokePreviewCanvas(canvas, this.board);
    if (!ctx) return;

    const points = buildPreviewStrokePoints(canvas, 50);
    drawPreviewStrokeGuide(ctx, points, user.color || [0, 0, 0]);

    const brush = user.imageBrush;
    const originalIndex = brush.index;
    const stampPoints = filterPreviewPointsBySpacing(points, getPreviewStampSpacing(user));

    stampPoints.forEach((point, index) => {
      const imageData = this._getPreviewImage(brush, index);
      if (!imageData?.image) return;
      this._drawPreviewStamp(ctx, user, brush, imageData, point, getPreviewPointAngle(stampPoints, index));
    });

    if (originalIndex !== undefined) brush.index = originalIndex;
    ctx.globalAlpha = 1;
  }

  _getPreviewImage(brush, index) {
    if (!brush) return null;
    if (brush.type === 'gbr') return { image: brush.image, width: brush.width, height: brush.height };
    if (brush.type === 'gih') {
      const images = brush.images || [];
      const image = images.length ? images[index % images.length] : null;
      return { image, width: brush.cellwidth, height: brush.cellheight };
    }
    if (brush.type === 'image' || brush.type === 'svg') {
      return { image: brush.image, width: brush.width, height: brush.height };
    }
    return null;
  }

  _drawPreviewStamp(ctx, user, brush, imageData, point, angle) {
    let { image, width, height } = imageData;
    if (!image || !width || !height) return;

    if (brush.type !== 'gih' && (user.imageBrushColorMode || 'original') === 'tinted') {
      image = this._getTintedImage(user, image);
    }

    let ratioX = width / height;
    let ratioY = height / width;
    if (width > height) ratioX = 1;
    if (height > width) ratioY = 1;

    const baseSize = 8;
    const scaledSize = baseSize * point.pressure;
    const stampW = scaledSize * 2 * ratioX;
    const stampH = scaledSize * 2 * ratioY;

    ctx.save();
    ctx.globalAlpha = (user.opacity ?? 1) * Math.min(1, 0.35 + point.pressure * 0.65);
    ctx.translate(point.x, point.y);
    if (brush.type === 'gih') ctx.rotate(angle);
    const prevSmoothing = ctx.imageSmoothingEnabled;
    if (brush.type === 'svg') ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, -stampW / 2, -stampH / 2, stampW, stampH);
    ctx.imageSmoothingEnabled = prevSmoothing;
    ctx.restore();
  }

  _getTintedImage(user, image, frameKey = '') {
    const colorKey = user.color.slice(0, 3).join(',');
    const brush = user.imageBrush;
    const brushKey = brush?.brushName || brush?.fileName || 'brush';
    const cacheKey = `${brushKey}_${frameKey}_${colorKey}`;
    if (this._tintCache.has(cacheKey)) return this._tintCache.get(cacheKey);

    const w = image.naturalWidth || image.width || 1;
    const h = image.naturalHeight || image.height || 1;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = `rgb(${user.color[0]}, ${user.color[1]}, ${user.color[2]})`;
    ctx.fillRect(0, 0, w, h);
    this._tintCache.set(cacheKey, canvas);
    return canvas;
  }

  /**
   * Draws a single brush stamp at the given position.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The position to draw the stamp.
   */
  drawStamp(user, pos) {
    const brush = user.imageBrush;
    if (!brush) return;
    const size = user.size;
    const pressure = user.pressure ?? 1;
    const scaledSize = size * pressureSizeFactor(user, pressure);

    const strokeLayer = user._strokeLayer ?? user.activeLayer ?? 0;

    let height, width, image;

    if (brush.type === 'gbr') {
      height = brush.height;
      width = brush.width;
      image = brush.image;
    } else if (brush.type === 'gih') {
      height = brush.cellheight;
      width = brush.cellwidth;

      const context = this.calculateContext(user, pos);

      if (brush.getNextBrush) {
        const result = brush.getNextBrush(context);
        image = brush.images[result.index];
      } else {
        image = brush.images[brush.index];
        brush.index = (brush.index + 1) % brush.ncells;
      }
    } else if (brush.type === 'image' || brush.type === 'svg') {
      height = brush.height;
      width = brush.width;
      image = brush.image;
    }

    if (!width || !height || !isDrawableImageSource(image)) return;

    if (brush.type !== 'gih' && (user.imageBrushColorMode || 'original') === 'tinted' && image) {
      image = this._getTintedImage(user, image);
    }

    user._imageBrushLastPos = { x: pos.x, y: pos.y };
    user._imageBrushLastTime = performance.now();

    let ratioX = width / height;
    let ratioY = height / width;

    if (width > height) ratioX = 1;
    if (height > width) ratioY = 1;

    const stampX = pos.x - scaledSize * ratioX;
    const stampY = pos.y - scaledSize * ratioY;
    const stampW = scaledSize * 2 * ratioX;
    const stampH = scaledSize * 2 * ratioY;

    const bounds = this._foldMirrorBounds({ x: stampX, y: stampY, width: stampW, height: stampH });
    const ctx = this.board.layerManager.getUserStrokeContext(strokeLayer, user.id, undefined, undefined, bounds);
    if (!ctx) {
      console.error(`ImageBrushTool: Failed to get active layer context for user ${user.id}. Layer:`, strokeLayer);
      return;
    }

    // Active canvas may be windowed (see docs/
    // scope_layermanager_active_stroke_windowing_RESULT.md) — stampX/Y and the
    // mirror transform both operate in board-absolute coordinates, so
    // translate by -origin first, same fix shape as the other stamped tools.
    const active = this.board.layerManager.getActiveStroke(strokeLayer, user.id);
    const ox = active?.origin?.x ?? 0;
    const oy = active?.origin?.y ?? 0;

    const opacity = (user.opacity !== undefined ? user.opacity : 1) * pressureOpacityFactor(user, pressure);
    ctx.globalAlpha = opacity;
    ctx.beginPath(); // Start a new path for this stamp
    ctx.fillStyle = user.getColorString();

    const drawStampImage = (targetCtx) => {
      const prevSmoothing = targetCtx.imageSmoothingEnabled;
      if (brush.type === 'svg') {
        targetCtx.imageSmoothingEnabled = true;
      }
      targetCtx.drawImage(image, stampX, stampY, stampW, stampH);
      targetCtx.imageSmoothingEnabled = prevSmoothing;
    };

    if (ox || oy) ctx.save();
    try {
      if (ox || oy) ctx.translate(-ox, -oy);

      // Draw the main stamp
      drawStampImage(ctx);

      // Save context state before mirroring operations to ensure it's restored correctly.
      // This is a defensive measure in case board.withMirroredRegionTransform does not fully restore state.
      ctx.save();

      this.board.forEachMirrorRegion({ rect: { x: stampX, y: stampY, width: stampW, height: stampH } }, (region) => {
        this.board.withMirroredRegionTransform(ctx, region, () => {
          drawStampImage(ctx); // Draw mirrored stamp
        });
      });

      // Restore context state after mirroring operations
      ctx.restore();

      ctx.stroke(); // Apply the path (all draws since beginPath)
      ctx.globalAlpha = 1.0;
    } finally {
      if (ox || oy) ctx.restore();
    }

    if (user._imageBrushDirtyBounds) {
      user._imageBrushDirtyBounds.minX = Math.min(user._imageBrushDirtyBounds.minX, stampX);
      user._imageBrushDirtyBounds.minY = Math.min(user._imageBrushDirtyBounds.minY, stampY);
      user._imageBrushDirtyBounds.maxX = Math.max(user._imageBrushDirtyBounds.maxX, stampX + stampW);
      user._imageBrushDirtyBounds.maxY = Math.max(user._imageBrushDirtyBounds.maxY, stampY + stampH);
    }

    this.board.expandDirtyRect(user, Math.floor(stampX), Math.floor(stampY),
      Math.ceil(stampW) + 1, Math.ceil(stampH) + 1);

    this.board.forEachMirrorRegion({ rect: { x: stampX, y: stampY, width: stampW, height: stampH } }, (region) => {
      const p1 = this.board.mirrorPointToRegion({ x: stampX, y: stampY }, region);
      const p2 = this.board.mirrorPointToRegion({ x: stampX + stampW, y: stampY + stampH }, region);
      const mx = Math.floor(Math.min(p1.x, p2.x));
      const my = Math.floor(Math.min(p1.y, p2.y));
      const mw = Math.ceil(Math.max(p1.x, p2.x)) - mx + 1;
      const mh = Math.ceil(Math.max(p1.y, p2.y)) - my + 1;
      this.board.expandDirtyRect(user, mx, my, mw, mh);
    });
  }

  /**
   * Calculate context for GIH selection modes.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @returns {Object} - The context object for GIH selection.
   */
  calculateContext(user, pos) {
    const context = {
      pressure: user.pressure || 0.5,
      angle: 0,
      velocity: 0,
      tiltX: 0,
      tiltY: 0
    };

    const lastPos = user._imageBrushLastPos;
    if (lastPos) {
      const dx = pos.x - lastPos.x;
      const dy = pos.y - lastPos.y;

      if (dx !== 0 || dy !== 0) {
        let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
        context.angle = ((angle % 360) + 360) % 360;
      }

      if (user._imageBrushLastTime) {
        const dt = performance.now() - user._imageBrushLastTime;
        if (dt > 0) {
          const distance = Math.sqrt(dx * dx + dy * dy);
          context.velocity = distance / dt * 16; 
        }
      }
    }

    return context;
  }

  /**
   * Loads a brush from a file.
   * @param {File} file - The brush file to load.
   * @param {Object} user - The user associated with the brush.
   * @returns {Promise<Object>} - A promise that resolves to the loaded brush object.
   */
  loadBrush(file, user) {
    return new Promise((resolve, reject) => {
      const fileType = file.name.split('.').pop().toLowerCase();

      if (['png', 'jpg', 'jpeg', 'webp'].includes(fileType)) {
        const reader = new FileReader();
        reader.onload = () => {
          const imageUrl = reader.result;
          const image = new Image();

          image.onload = () => {
            const brushObject = {
              type: 'image',
              fileName: file.name,
              imageFormat: fileType,
              brushName: file.name.replace(/\.[^/.]+$/, ''),
              gimpUrl: imageUrl,
              width: image.width,
              height: image.height,
              image: image
            };
            user.imageBrush = brushObject;
            resolve(brushObject);
          };

          image.onerror = () => reject(new Error('Failed to load image'));
          image.src = imageUrl;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result;

        if (fileType === 'gbr') {
          const gbrObject = parseGbr(arrayBuffer);
          if (gbrObject) {
            gbrObject.type = 'gbr';
            const image = new Image();
            image.src = gbrObject.gimpUrl;
            gbrObject.image = image;
            user.imageBrush = gbrObject;
            resolve(gbrObject);
          }
        } else if (fileType === 'gih') {
          const gihObject = parseGih(arrayBuffer);
          if (gihObject) {
            const images = gihObject.gBrushes.map(brush => {
              const img = new Image();
              img.src = brush.gimpUrl;
              return img;
            });
            gihObject.type = 'gih';
            gihObject.images = images;
            user.imageBrush = gihObject;
            resolve(gihObject);
          }
        }
      };

      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }

  clearUserState(userId) {
    this.lastStampPos.delete(userId);
  }

  _getStrokePoints(user) {
    if (!user) return [];
    if (!Array.isArray(user._imageBrushStrokePoints)) user._imageBrushStrokePoints = [];
    return user._imageBrushStrokePoints;
  }

  _isLocalUser(user) {
    return user === this.board.app?.self || user?.id === this.board.app?.sessionIndex;
  }
}
