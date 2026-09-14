/**
 * @fileoverview Ink tool using perfect-freehand library.
 * Produces filled polygon outlines from input points with taper/calligraphy effects.
 */

import { getStroke } from 'perfect-freehand';
import {
  buildPreviewStrokePoints,
  drawPreviewStrokeGuide,
  prepareStrokePreviewCanvas
} from '../ui/StrokePreviewRenderer.js';
import { Tool } from './BaseTool.js';
import { clampRectToCanvas, ensureSizedCanvas, blurExtent } from '../utils/drawing.js';
import { DEFAULT_PRESSURE_TARGETS } from '../../shared/pressureTargets.js';
import {
  PressureMask,
  compositePressureStroke,
  hardnessBlurAmount,
  inkOutlinePoints,
  inkPressureMaskRadius,
  usesPressureMask
} from '../utils/pressureMask.js';

/**
 * Convert perfect-freehand outline points to an SVG path string for Path2D.
 * Uses quadratic bezier curves through midpoints for smooth results.
 * @param {Array<number[]>} stroke - Array of points representing the stroke outline.
 * @returns {string} - SVG path string.
 */
function getSvgPathFromStroke(stroke) {
  if (!stroke.length) return '';

  const d = stroke.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ['M', ...stroke[0], 'Q']
  );

  d.push('Z');
  return d.join(' ');
}

/**
 * Ink tool using perfect-freehand library.
 * Note: Position smoothing is handled by InputBufferManager before points
 * reach this tool, ensuring parity between local preview and remote rendering.
 */
export class InkTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('ink', board);
    this.pressureSteps = 256;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.inputPoints = []; // Array of [x, y, pressure]
    this.userAlpha = 1.0;
    this.strokeColor = null;
    this._strokeSize = 10;
    this.pointBuffer = [];
    this.hardnessCanvas = null;
    this.hardnessCtx = null;
    this._lastDotEffectiveSize = null; // Track effective dot size for hardness calculation
    this.pressureTargets = DEFAULT_PRESSURE_TARGETS;
    this.pressureMask = new PressureMask();
    this._pressureScratch = {};
  }

  /**
   * Activates the tool and ensures the offscreen canvas is ready.
   */
  activate() {
    this.ensureOffscreenCanvas();
  }

  /**
   * Ensures the offscreen canvas matches the main canvas dimensions.
   */
  ensureOffscreenCanvas() {
    const { canvas, ctx } = ensureSizedCanvas(
      this.offscreenCanvas, this.board.getWidth(), this.board.getHeight());
    this.offscreenCanvas = canvas;
    this.offscreenCtx = ctx;
  }

  /**
   * Quantizes pressure to a fixed number of steps for consistency.
   * @param {number} pressure - The input pressure (0-1).
   * @returns {number} - The quantized pressure.
   */
  quantizePressure(pressure) {
    return Math.round(pressure * (this.pressureSteps - 1)) / (this.pressureSteps - 1);
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {
    this._activeUser = user;
    this.board.beginStroke(user);
    this.ensureOffscreenCanvas();

    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    const color = user.color.slice(0, 3);
    this.strokeColor = `rgb(${color.join(',')})`;
    this.offscreenCtx.fillStyle = this.strokeColor;

    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    this.userAlpha = opacitySlider;
    this.userHardness = user.hardness !== undefined ? user.hardness : 100;

    this._strokeSize = user.size;
    this.pressureTargets = user.pressureTargets ?? DEFAULT_PRESSURE_TARGETS;
    this.pressureMask.reset();

    const startX = Number.isFinite(user?.x) ? user.x : pos.x;
    const startY = Number.isFinite(user?.y) ? user.y : pos.y;

    // Don't add the pointerdown point — on tablet, the initial pressure may be unavailable
    // or inaccurate. Wait for the first pointermove with real tablet data.
    // This prevents single-tap dots from using an invalid pressure value.
    this.inputPoints = [];
    this.pointBuffer = [];

    this.dirtyBounds = { minX: startX, minY: startY, maxX: startX, maxY: startY };
    // Grows monotonically over the whole stroke, exactly like BrushTool's
    // _brushPreviewBounds, EraserTool's previewDirtyBounds and
    // RemoteInkHandler's _inkDirtyBounds. It cannot be collapsed to "what moved
    // since the last render" the way a stamping tool's can: renderStroke()
    // re-runs perfect-freehand over the ENTIRE point list every frame, and
    // streamlining makes the outline lag the raw input, so appending a point
    // rewrites geometry well BEHIND the newest one. _previewDirty carries the
    // "is there new geometry at all" signal on its own.
    this._previewBounds = { minX: startX, minY: startY, maxX: startX, maxY: startY };
    this._previewDirty = false;

    // Don't render yet - wait for real pressure data from first move
  }

  /**
   * Handles pointer move event.
   * Note: Position smoothing is handled by InputBufferManager.
   *
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {
    this.onPointerMoveNoRender(user, pos, lastPos, e);
    this.renderStroke(false, user);
    const rect = this.getPreviewDirtyRect(user);
    this.board.clearTop(rect === false ? null : rect);
    this.drawPreview(user, rect === false ? null : rect);
  }

  /**
   * Internal version of onPointerMove that skips rendering.
   * Used by InputBufferManager to batch points within a single tick.
   *
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMoveNoRender(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning) return;

    const pressure = this.quantizePressure(user.pressure);
    // Skip pressure=0 points — they indicate a liftoff sample and produce
    // artefacts (oversized blobs) when fed into the perfect-freehand pipeline.
    if (pressure === 0) return;

    // For the first move point, initialize inputPoints. Otherwise, skip points too close.
    if (this.inputPoints.length === 0) {
      this.inputPoints.push([pos.x, pos.y, pressure]);
      this.pointBuffer.push(pos.x, pos.y, Math.round(pressure * 255));
      this._stampPressure(user, pos.x, pos.y, pressure);
    } else {
      // Skip points too close to the last point to prevent velocity calculation noise
      // in perfect-freehand when simulatePressure is enabled.
      // We use a smaller threshold now that input is EMA-smoothed.
      const lastPoint = this.inputPoints[this.inputPoints.length - 1];
      const dx = pos.x - lastPoint[0];
      const dy = pos.y - lastPoint[1];
      const distSq = dx * dx + dy * dy;
      if (distSq < 1) return; // Min 1px distance (was 2px)

      this.inputPoints.push([pos.x, pos.y, pressure]);
      this.pointBuffer.push(pos.x, pos.y, Math.round(pressure * 255));
      this._stampPressure(user, pos.x, pos.y, pressure);
    }

    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, pos.x);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, pos.y);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, pos.x);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, pos.y);
    }
    this._expandPreviewBounds(pos.x, pos.y);
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {
    if (user.panning || !this.offscreenCanvas) return;

    // If no points were recorded (instant tap with no movement), skip rendering.
    // This ensures we only draw dots when we have real pressure data from at least one move.
    if (this.inputPoints.length === 0) return;

    const pressure = this.quantizePressure(user.pressure);
    // Mirror the distSq < 1 guard from onPointerMoveNoRender so local inputPoints
    // match what remote receives. Without this, a near-duplicate trailing point
    // here reads as "zero velocity" in perfect-freehand's thinning calculation,
    // making the local stroke's final taper slightly thicker than the remote's.
    const lastPoint = this.inputPoints[this.inputPoints.length - 1];
    const ddx = pos.x - lastPoint[0];
    const ddy = pos.y - lastPoint[1];
    if (ddx * ddx + ddy * ddy >= 1 && pressure > 0) {
      this.inputPoints.push([pos.x, pos.y, pressure]);
      this.pointBuffer.push(pos.x, pos.y, Math.round(pressure * 255));
      this._stampPressure(user, pos.x, pos.y, pressure);

      if (this.dirtyBounds) {
        this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, pos.x);
        this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, pos.y);
        this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, pos.x);
        this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, pos.y);
      }
      this._expandPreviewBounds(pos.x, pos.y);
    }

    this.renderStroke(true, user);
    this.board.clearTop();

    const ctx = this.board.getActiveLayerContext();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.userAlpha;

    // Use effective dot size if this was a dot, so blur amount is proportional to actual dot size
    const sizeForHardness = this._lastDotEffectiveSize !== null ? this._lastDotEffectiveSize : this._strokeSize;
    const hardnessCanvas = this._getCompositeCanvas(sizeForHardness);
    ctx.drawImage(hardnessCanvas, 0, 0);

    this.board.forEachMirrorRegion({ rect: this.dirtyBounds ? {
      x: this.dirtyBounds.minX,
      y: this.dirtyBounds.minY,
      width: this.dirtyBounds.maxX - this.dirtyBounds.minX,
      height: this.dirtyBounds.maxY - this.dirtyBounds.minY
    } : null }, (region) => {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      this.board.drawMirroredCanvas(ctx, hardnessCanvas, region, 0, 0);
      ctx.restore();
    });

    ctx.globalAlpha = 1.0;

    if (this.dirtyBounds && this.dirtyBounds.maxX !== -Infinity) {
      const strokeRadius = this._strokeSize;
      const blurAmount = hardnessBlurAmount(this.userHardness / 100, this._strokeSize);
      const safetyMargin = strokeRadius * 0.5;
      const margin = strokeRadius + blurExtent(blurAmount) + safetyMargin + 15;

      const x = Math.floor(this.dirtyBounds.minX - margin);
      const y = Math.floor(this.dirtyBounds.minY - margin);
      const width = Math.ceil(this.dirtyBounds.maxX - this.dirtyBounds.minX + margin * 2);
      const height = Math.ceil(this.dirtyBounds.maxY - this.dirtyBounds.minY + margin * 2);

      this.board.expandDirtyRect(user, x, y, width, height);

      this.board.forEachMirrorRegion({ rect: { x, y, width, height } }, (region) => {
        const p1 = this.board.mirrorPointToRegion({ x: this.dirtyBounds.minX, y: this.dirtyBounds.minY }, region);
        const p2 = this.board.mirrorPointToRegion({ x: this.dirtyBounds.maxX, y: this.dirtyBounds.maxY }, region);
        const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
        const my = Math.floor(Math.min(p1.y, p2.y) - margin);
        const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
        const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
        this.board.expandDirtyRect(user, mx, my, mw, mh);
      });
    }

    // Track tile ownership
    if (this.inputPoints.length > 0) {
      const points = this.inputPoints.map(([x, y]) => ({ x, y }));
      this.board.markDirtyPath(user, points, this._strokeSize);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), this._strokeSize);
      });
    }

    this.board.endStroke(user);
    this.clearStroke();
  }

  /**
   * Renders the stroke into the offscreen canvas.
   * @param {boolean} last - Whether this is the final segment of the stroke.
   */
  renderStroke(last, user = null) {
    if (this.inputPoints.length < 1) return;

    const ctx = this.offscreenCtx;
    ctx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    const activeUser = user || this._activeUser;
    const simulatePressure = activeUser.simulatePressure !== undefined ? activeUser.simulatePressure : true;
    const userThinning = activeUser.thinning !== undefined ? activeUser.thinning : 0.5;

    // Pressure shapes the outline only when it drives size.
    const strokeInput = inkOutlinePoints(this.inputPoints, this.pressureTargets);

    // Single point: render as a dot
    if (this.inputPoints.length === 1) {
      if (!last) return; // Don't preview single dots

      const [x, y, pressure] = strokeInput[0];
      const dotPressure = pressure !== undefined ? pressure : 1;
      const effectiveRadius = this._strokeSize * dotPressure;
      ctx.fillStyle = this.strokeColor;
      ctx.beginPath();
      ctx.arc(x, y, effectiveRadius, 0, Math.PI * 2);
      ctx.fill();
      this._lastDotEffectiveSize = effectiveRadius;
      return;
    }

    // Very short strokes are common when fast input is batched into a single frame.
    // Perfect-freehand can collapse these into an unstable preview, so draw a simple
    // round-capped segment instead of leaving the stroke blank between frames.
    if (this.inputPoints.length === 2) {
      const [x0, y0, pressure0] = strokeInput[0];
      const [x1, y1, pressure1] = strokeInput[1];
      const averagePressure = ((pressure0 ?? 1) + (pressure1 ?? 1)) / 2;
      const width = Math.max(0.5, this._strokeSize * averagePressure);
      ctx.fillStyle = this.strokeColor;
      ctx.strokeStyle = this.strokeColor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      return;
    }

    // 3+ points: normal stroke rendering
    this._lastDotEffectiveSize = null;

    // Require at least 3 points for a smooth preview stroke to avoid "dot" flashes at the start
    if (!last && this.inputPoints.length < 3) return;

    // When simulatePressure is disabled (tablet mode), use pressure directly
    const adjustedPoints = strokeInput;

    const effectiveThinning = !simulatePressure
      ? 0.95
      : Math.min(0.99, userThinning * Math.max(1, this._strokeSize / 10));

    const userSmoothing = activeUser.smoothing !== undefined ? activeUser.smoothing / 50 : 0.5;
    // We use a baseline streamline even at 0 smoothing to stabilize velocity calculation in perfect-freehand
    const streamline = 0.3 + (userSmoothing * 0.7); // Scale 0.3 to 1.0

    const options = {
      size: Math.max(0.1, (this._strokeSize * 2) / (1 + userThinning)),
      thinning: effectiveThinning,
      smoothing: userSmoothing,
      streamline: streamline,
      simulatePressure: simulatePressure,
      last
    };

    const outlinePoints = getStroke(adjustedPoints, options);
    if (outlinePoints.length < 3) return;

    const pathData = getSvgPathFromStroke(outlinePoints);
    if (!pathData) return;

    const path = new Path2D(pathData);
    ctx.fillStyle = this.strokeColor;
    ctx.fill(path);
  }

  /**
   * Draws the current stroke preview on the top canvas.
   */
  drawPreview(user = this._activeUser, rect = null) {
    if (!this.offscreenCanvas) return;
    const ctx = this.board.topCtx;
    ctx.globalAlpha = this.userAlpha;
    const hardnessCanvas = this._getCompositeCanvas(this._strokeSize, rect);
    const sourceRect = rect ? clampRectToCanvas(rect, hardnessCanvas) : null;
    this.board.withSelectionMaskClip(ctx, user.id, () => {
      if (sourceRect) {
        ctx.drawImage(
          hardnessCanvas,
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
        ctx.drawImage(hardnessCanvas, 0, 0);
      }

      this.board.forEachMirrorRegion({ rect: this.dirtyBounds ? {
        x: this.dirtyBounds.minX,
        y: this.dirtyBounds.minY,
        width: this.dirtyBounds.maxX - this.dirtyBounds.minX,
        height: this.dirtyBounds.maxY - this.dirtyBounds.minY
      } : null }, (region) => {
        this.board.drawMirroredCanvas(ctx, hardnessCanvas, region, 0, 0);
      });
    });
    ctx.globalAlpha = 1.0;
  }

  updatePreview(user) {
    const canvas = document.getElementById('toolPreviewCanvas');
    if (!canvas) return;
    if (!user) user = this.board.self || this.board.app?.self;
    if (!user) return;

    const ctx = prepareStrokePreviewCanvas(canvas, this.board);
    if (!ctx) return;

    const points = buildPreviewStrokePoints(canvas, 50);
    drawPreviewStrokeGuide(ctx, points, user.color || [0, 0, 0]);

    // The preview window always renders as if thinning is fully maxed (1.0) and
    // pressure simulation is on, so the user's thinning/pressure toggles don't change
    // the preview's tapered shape — it looks off without the taper.
    const thinning = 1;
    const simulatePressure = true;
    const smoothing = Math.max(0, Math.min(50, Number(user.smoothing ?? 15))) / 50;
    const strokePoints = points.map(point => [point.x, point.y, point.pressure]);
    const effectiveThinning = !simulatePressure
      ? 0.95
      : Math.min(0.99, thinning * Math.max(1, 17.5 / 10));
    const outlinePoints = getStroke(strokePoints, {
      size: Math.max(0.1, (17.5 * 2) / (1 + thinning)),
      thinning: effectiveThinning,
      smoothing,
      streamline: 0.3 + smoothing * 0.7,
      simulatePressure,
      last: true
    });

    if (outlinePoints.length < 3) return;
    const pathData = getSvgPathFromStroke(outlinePoints);
    if (!pathData) return;

    ctx.save();
    ctx.globalAlpha = user.opacity ?? 1;
    ctx.fillStyle = `rgb(${user.color?.[0] ?? 0}, ${user.color?.[1] ?? 0}, ${user.color?.[2] ?? 0})`;
    const hardness = Math.max(0, Math.min(100, Number(user.hardness ?? 100))) / 100;
    if (hardness < 1) {
      const blurAmount = (1 - hardness) * (8 + 25 * 0.25);
      const offset = 10000;
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowOffsetX = offset;
      ctx.shadowOffsetY = 0;
      ctx.translate(-offset, 0);
    }
    ctx.fill(new Path2D(pathData));
    ctx.restore();
  }

  /**
   * Records a point's pressure in the stroke's mask when pressure drives
   * opacity or hardness. Called for exactly the points pushed to pointBuffer,
   * which RemoteInkHandler.handleInkPoints stamps the same way.
   * @param {Object} user
   * @param {number} x
   * @param {number} y
   * @param {number} pressure - Quantized pressure, 0-1.
   * @private
   */
  _stampPressure(user, x, y, pressure) {
    if (!usesPressureMask(this.pressureTargets)) return;
    const thinning = user.thinning !== undefined ? user.thinning : 0.5;
    this.pressureMask.stampTo(x, y, inkPressureMaskRadius(this.pressureTargets, this._strokeSize, thinning, this.userHardness / 100), pressure);
  }

  /**
   * The stroke with hardness applied and, when pressure drives opacity or
   * hardness, composited through its pressure mask.
   * @param {number} size
   * @param {{x:number, y:number, width:number, height:number}|null} [rect=null]
   * @returns {HTMLCanvasElement}
   * @private
   */
  _getCompositeCanvas(size, rect = null) {
    if (!usesPressureMask(this.pressureTargets)) return this.getHardnessCanvas(this.offscreenCanvas, size, rect);
    return compositePressureStroke(this._pressureScratch, this.offscreenCanvas, { x: 0, y: 0 }, this.pressureMask, {
      targets: this.pressureTargets,
      hardness: this.userHardness / 100,
      size,
      color: this.strokeColor,
      rect
    });
  }

  getHardnessCanvas(sourceCanvas, size, rect = null) {
    if (!this.hardnessCanvas ||
        this.hardnessCanvas.width !== sourceCanvas.width ||
        this.hardnessCanvas.height !== sourceCanvas.height) {
      this.hardnessCanvas = document.createElement('canvas');
      this.hardnessCanvas.width = sourceCanvas.width;
      this.hardnessCanvas.height = sourceCanvas.height;
      this.hardnessCtx = this.hardnessCanvas.getContext('2d');
    }

    if (rect) {
      const clearRect = clampRectToCanvas(rect, this.hardnessCanvas);
      if (clearRect) {
        this.hardnessCtx.clearRect(clearRect.x, clearRect.y, clearRect.width, clearRect.height);
      }
    } else {
      this.hardnessCtx.clearRect(0, 0, this.hardnessCanvas.width, this.hardnessCanvas.height);
    }
    this.compositeWithHardness(this.hardnessCtx, sourceCanvas, size, 0, 0, rect);
    return this.hardnessCanvas;
  }

  /**
   * Composites the offscreen canvas with a hardness-based blur effect.
   * @param {CanvasRenderingContext2D} ctx - The target canvas context.
   * @param {HTMLCanvasElement} sourceCanvas - The source canvas to composite.
   * @param {number} size - The stroke size.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   */
  compositeWithHardness(ctx, sourceCanvas, size, x, y, rect = null) {
    const blurAmount = (1 - this.userHardness / 100) * (20 + size * 0.2);
    const sourceRect = rect ? clampRectToCanvas(rect, sourceCanvas) : null;

    if (blurAmount > 0) {
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = this.strokeColor;
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      if (sourceRect) {
        ctx.drawImage(
          sourceCanvas,
          sourceRect.x,
          sourceRect.y,
          sourceRect.width,
          sourceRect.height,
          x + sourceRect.x + offset,
          y + sourceRect.y,
          sourceRect.width,
          sourceRect.height
        );
      } else {
        ctx.drawImage(sourceCanvas, x + offset, y);
      }
      ctx.restore();
    } else if (sourceRect) {
      ctx.drawImage(
        sourceCanvas,
        sourceRect.x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height,
        x + sourceRect.x,
        y + sourceRect.y,
        sourceRect.width,
        sourceRect.height
      );
    } else {
      ctx.drawImage(sourceCanvas, x, y);
    }
  }

  /**
   * Grow the preview region to include a point. Mirrors the dirtyBounds
   * expansion; kept separate only so the "new geometry since the last render"
   * flag can live alongside it — see getPreviewDirtyRect().
   * @param {number} x
   * @param {number} y
   * @private
   */
  _expandPreviewBounds(x, y) {
    const b = this._previewBounds;
    if (!b) return;
    // Only reached once a point has cleared onPointerMoveNoRender's 1px
    // accept guard, so this doubles as "new geometry exists to draw".
    this._previewDirty = true;
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  }

  /**
   * Returns the region the live preview must be repainted in: the whole stroke
   * so far, plus a margin for brush size and the hardness blur.
   *
   * This deliberately covers the full stroke rather than only the newest
   * segment. perfect-freehand recomputes the entire outline on every render and
   * streamlining makes the rendered tail lag the raw input by roughly
   * spacing * (1 - t) / t px (unbounded as smoothing rises), so a new point can
   * change pixels far behind itself. Clipping the repaint to a window around the
   * newest points left that stale region unpainted, which is what produced the
   * random cut-outs and jagged edges on fast strokes.
   */
  getPreviewDirtyRect(user = this._activeUser) {
    const bounds = this._previewBounds;
    // Smoothing catch-up steps the EMA toward the target on every tick, but a
    // sub-pixel step adds no point (onPointerMoveNoRender's 1px guard), so the
    // stroke is byte-identical to the last render. Reporting "no work" here
    // skips renderStroke/clearTop/drawPreview for those ticks instead of
    // repainting an unchanged stroke.
    if (!this._previewDirty) return false;
    // Zero-width/height bounds are still valid for horizontal/vertical motion.
    // Returning false here causes the batched ink preview path to skip redraws,
    // which is most noticeable while smoothing catch-up is still converging.
    if (!bounds || bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return false;
    // A partial preview rect must cover the mirrored copies too, and they are
    // nowhere near the stroke. `hasMirrors()` — NOT `mirrorRegions.length`: that
    // missed the full-board mirror entirely, so with it on the live preview was
    // clipped to a bbox around the unmirrored stroke and the reflected half only
    // appeared at mouse-up (the commit path does not use this rect). null = redraw all.
    if (this.board.hasMirrors?.()) {
      this._previewDirty = false;
      return null;
    }

    const size = user?.size ?? this._strokeSize;
    const blurAmount = hardnessBlurAmount(this.userHardness / 100, size);
    const margin = size + blurExtent(blurAmount) + size * 0.5 + 15;
    const rect = {
      x: Math.floor(bounds.minX - margin),
      y: Math.floor(bounds.minY - margin),
      width: Math.ceil(bounds.maxX - bounds.minX + margin * 2),
      height: Math.ceil(bounds.maxY - bounds.minY + margin * 2)
    };
    this._previewDirty = false;
    return rect;
  }

  /**
   * Drains the point buffer for network synchronization.
   * @returns {Object} - An object containing ps (positions) and rs (pressures).
   */
  drainPointBuffer() {
    const buf = this.pointBuffer;
    this.pointBuffer = [];
    const ps = [];
    const rs = [];
    for (let i = 0; i < buf.length; i += 3) {
      ps.push(buf[i], buf[i + 1]);
      rs.push(buf[i + 2]);
    }
    return { ps, rs };
  }

  /**
   * Clears the current stroke state and offscreen canvas.
   */
  clearStroke() {
    if (this.offscreenCtx) this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    this.inputPoints = [];
    this.pressureMask.reset();
    // pointBuffer is NOT wiped here: onPointerUp may push a final point into it,
    // and App.js drains the buffer after onPointerUp returns so remote users
    // receive the final point. Reset is handled in onPointerDown.
    this.board.clearTop();
  }

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this.inputPoints.length > 0 && this._activeUser) {
      const lastPoint = this.inputPoints[this.inputPoints.length - 1];
      this.onPointerUp(this._activeUser, { x: lastPoint[0], y: lastPoint[1] });
    }
    this._activeUser = null;
  }
}
