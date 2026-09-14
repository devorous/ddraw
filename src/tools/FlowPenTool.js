import {
  buildPreviewStrokePoints,
  drawPreviewStrokeGuide,
  drawTaperedStroke,
  prepareStrokePreviewCanvas
} from '../ui/StrokePreviewRenderer.js';
import { Tool } from './BaseTool.js';
import { ensureSizedCanvas, blurExtent } from '../utils/drawing.js';
import { DEFAULT_PRESSURE_TARGETS, pressureSizeFactor } from '../../shared/pressureTargets.js';
import {
  PressureMask,
  compositePressureStroke,
  hardnessBlurAmount,
  pressureStampRadius,
  usesPressureMask
} from '../utils/pressureMask.js';

/**
 * @fileoverview Flow Pen tool for pressure-sensitive strokes using circle stamping.
 * Uses an offscreen canvas to prevent opacity stacking when circles overlap.
 */

/**
 * Flow Pen tool for pressure-sensitive strokes using circle stamping.
 * Note: Position smoothing is handled by InputBufferManager before points
 * reach this tool, ensuring parity between local preview and remote rendering.
 */
export class FlowPenTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('flowPen', board);
    this.pressureSteps = 256;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.lastStampPos = null;
    this.userAlpha = 1.0;
    this.userHardness = 1.0;
    this.strokeColor = null;
    this.stampBuffer = [];
    this._tickDirtyBounds = null;
    this.pressureTargets = DEFAULT_PRESSURE_TARGETS;
    this.pressureMask = new PressureMask();
    this._maskSize = 10;
    this._maskHardness = 1;
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
   * Calculates the distance between two points.
   * @param {Object} p1 - First point.
   * @param {Object} p2 - Second point.
   * @returns {number} - The distance between the points.
   */
  getDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
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

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressureSizeFactor(user, pressure) * user.size;

    const color = user.color.slice(0, 3);
    this.strokeColor = `rgb(${color.join(',')})`;
    this.color = color; 
    this.offscreenCtx.fillStyle = this.strokeColor;

    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    this.userAlpha = opacitySlider;
    
    const rawHardness = user.hardness !== undefined ? user.hardness : 100;
    this.userHardness = rawHardness > 1.0 ? rawHardness / 100.0 : rawHardness;
    if (this.userHardness > 1.0) this.userHardness = 1.0;

    // Fixed for the stroke and read exactly as RemotePenHandler.handlePenDown
    // reads them, so both sides build the same pressure mask.
    this.pressureTargets = user.pressureTargets ?? DEFAULT_PRESSURE_TARGETS;
    this._maskSize = user.size;
    this._maskHardness = rawHardness / 100;
    this.pressureMask.reset();

    this.dirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    this._tickDirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

    const pressure255 = Math.round(pressure * 255);
    this.stampCircle(pos.x, pos.y, radius, pressure255);
    this.lastStampPos = { x: pos.x, y: pos.y, radius, pressure255 };

    user.penPoints = [{ x: pos.x, y: pos.y, radius }];
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning || !this.lastStampPos) return;

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressureSizeFactor(user, pressure) * user.size;

    const avgRadius = (this.lastStampPos.radius + radius) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);
    const distance = this.getDistance(this.lastStampPos, pos);

    if (distance >= spacing) {
      const pressure255End = Math.round(pressure * 255);
      const steps = Math.ceil(distance / spacing);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = this.lastStampPos.x + (pos.x - this.lastStampPos.x) * t;
        const y = this.lastStampPos.y + (pos.y - this.lastStampPos.y) * t;
        const r = this.lastStampPos.radius + (radius - this.lastStampPos.radius) * t;
        const p255 = Math.round(this.lastStampPos.pressure255 + (pressure255End - this.lastStampPos.pressure255) * t);
        this.stampCircle(x, y, r, p255);
      }
      this.lastStampPos = { x: pos.x, y: pos.y, radius, pressure255: pressure255End };
      user.penPoints.push({ x: pos.x, y: pos.y, radius });
    }

    this.board.clearTop();
    this.drawPreview(user);
  }

  /**
   * Handles pointer move without immediate rendering (for batch rendering).
   * Interpolates circles locally for smooth preview, but only sends key points.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMoveNoRender(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning || !this.lastStampPos) return;

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressureSizeFactor(user, pressure) * user.size;
    const pressure255End = Math.round(pressure * 255);

    const distance = this.getDistance(this.lastStampPos, pos);
    if (distance > 0.5) {
      // Interpolate circles locally for smooth rendering
      this.interpolateStroke(
        this.offscreenCtx,
        this.lastStampPos.x,
        this.lastStampPos.y,
        this.lastStampPos.radius,
        pos.x,
        pos.y,
        radius
      );

      // Update dirty bounds
      const minRadius = Math.min(this.lastStampPos.radius, radius);
      const maxRadius = Math.max(this.lastStampPos.radius, radius);
      if (this.dirtyBounds) {
        this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, pos.x - maxRadius);
        this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, pos.y - maxRadius);
        this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, pos.x + maxRadius);
        this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, pos.y + maxRadius);
      }
      if (this._tickDirtyBounds) {
        this._tickDirtyBounds.minX = Math.min(this._tickDirtyBounds.minX, pos.x - maxRadius);
        this._tickDirtyBounds.minY = Math.min(this._tickDirtyBounds.minY, pos.y - maxRadius);
        this._tickDirtyBounds.maxX = Math.max(this._tickDirtyBounds.maxX, pos.x + maxRadius);
        this._tickDirtyBounds.maxY = Math.max(this._tickDirtyBounds.maxY, pos.y + maxRadius);
      }

      // Only send key point to network (not interpolated points)
      this.stampBuffer.push(pos.x, pos.y, pressure255End);
      this._stampPressure(pos.x, pos.y, pressure255End);
      this.lastStampPos = { x: pos.x, y: pos.y, radius, pressure255: pressure255End };
      user.penPoints.push({ x: pos.x, y: pos.y, radius });
    }
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {
    if (user.panning || !this.offscreenCanvas) return;

    if (this.lastStampPos) {
      const pressure = this.quantizePressure(user.pressure);
      const radius = pressureSizeFactor(user, pressure) * user.size;

      const avgRadius = (this.lastStampPos.radius + radius) / 2;
      const spacing = Math.max(1, avgRadius * 0.2);
      const distance = this.getDistance(this.lastStampPos, pos);

      if (distance > 0.5) {
        const pressure255End = Math.round(pressure * 255);
        const steps = Math.max(1, Math.ceil(distance / spacing));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const x = this.lastStampPos.x + (pos.x - this.lastStampPos.x) * t;
          const y = this.lastStampPos.y + (pos.y - this.lastStampPos.y) * t;
          const r = this.lastStampPos.radius + (radius - this.lastStampPos.radius) * t;
          const p255 = Math.round(this.lastStampPos.pressure255 + (pressure255End - this.lastStampPos.pressure255) * t);
          this.stampCircle(x, y, r, p255);
        }
      }
    }

    const ctx = this.board.getActiveLayerContext();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.userAlpha;

    const pressured = this._compositePressure(user);
    if (pressured) {
      ctx.drawImage(pressured, 0, 0);
    } else {
      this.compositeWithHardness(ctx, this.offscreenCanvas, user.size, 0, 0);
    }

    this.board.forEachMirrorRegion({ rect: this.dirtyBounds ? {
      x: this.dirtyBounds.minX,
      y: this.dirtyBounds.minY,
      width: this.dirtyBounds.maxX - this.dirtyBounds.minX,
      height: this.dirtyBounds.maxY - this.dirtyBounds.minY
    } : null }, (region) => {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      this.board.drawMirroredCanvas(ctx, pressured || this.offscreenCanvas, region, 0, 0);
      ctx.restore();
    });

    ctx.globalAlpha = 1.0;

    if (this.dirtyBounds && this.dirtyBounds.maxX !== -Infinity) {
      const brushRadius = user.size;
      const blurAmount = hardnessBlurAmount(this.userHardness, user.size);
      const safetyMargin = brushRadius * 0.25;
      const margin = blurExtent(blurAmount) + safetyMargin + 2;

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
    if (user.penPoints && user.penPoints.length > 0) {
      const maxRadius = Math.max(...user.penPoints.map(p => p.radius || user.size));
      this.board.markDirtyPath(user, user.penPoints, maxRadius);
      this.board.forEachMirrorRegion({ points: user.penPoints }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(user.penPoints, region), maxRadius);
      });
    }

    this.board.endStroke(user);
    this.clearStroke();
    this.board.clearTop();
  }

  /**
   * Stamps a circle onto the offscreen canvas.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {number} radius - The radius of the circle.
   * @param {number} pressure255 - The pressure (0-255).
   */
  stampCircle(x, y, radius, pressure255) {
    const ctx = this.offscreenCtx;

    ctx.fillStyle = this.strokeColor;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();

    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, x - radius);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, y - radius);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, x + radius);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, y + radius);
    }
    if (this._tickDirtyBounds) {
      this._tickDirtyBounds.minX = Math.min(this._tickDirtyBounds.minX, x - radius);
      this._tickDirtyBounds.minY = Math.min(this._tickDirtyBounds.minY, y - radius);
      this._tickDirtyBounds.maxX = Math.max(this._tickDirtyBounds.maxX, x + radius);
      this._tickDirtyBounds.maxY = Math.max(this._tickDirtyBounds.maxY, y + radius);
    }

    this.stampBuffer.push(x, y, pressure255);
    this._stampPressure(x, y, pressure255);
  }

  /**
   * Records a stamp's pressure in the stroke's mask when pressure drives
   * opacity or hardness. Called for exactly the stamps pushed to stampBuffer —
   * the ones remote users receive — so RemotePenHandler builds the same mask.
   * @param {number} x
   * @param {number} y
   * @param {number} pressure255 - The pressure (0-255), as sent.
   * @private
   */
  _stampPressure(x, y, pressure255) {
    if (!usesPressureMask(this.pressureTargets)) return;
    const pressure = pressure255 / 255;
    this.pressureMask.stampTo(x, y, pressureStampRadius(this.pressureTargets, pressure, this._maskSize, this._maskHardness), pressure);
  }

  /**
   * The stroke composited through its pressure mask, or null when pressure only
   * drives size and compositeWithHardness does the job.
   * @param {Object} user
   * @param {{x:number, y:number, width:number, height:number}|null} [rect=null] - Region to redraw.
   * @returns {HTMLCanvasElement|null}
   * @private
   */
  _compositePressure(user, rect = null) {
    if (!usesPressureMask(this.pressureTargets) || !this.offscreenCanvas) return null;
    return compositePressureStroke(this._pressureScratch, this.offscreenCanvas, { x: 0, y: 0 }, this.pressureMask, {
      targets: this.pressureTargets,
      hardness: this.userHardness,
      size: user.size,
      color: this.strokeColor,
      rect
    });
  }

  /**
   * Interpolates and stamps circles between two positions for smooth stroke coverage.
   * @param {CanvasRenderingContext2D} ctx - Canvas context to draw on.
   * @param {number} x1 - Start x.
   * @param {number} y1 - Start y.
   * @param {number} r1 - Start radius.
   * @param {number} x2 - End x.
   * @param {number} y2 - End y.
   * @param {number} r2 - End radius.
   */
  interpolateStroke(ctx, x1, y1, r1, x2, y2, r2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const avgRadius = (r1 + r2) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);

    if (distance < spacing) {
      ctx.beginPath();
      ctx.arc(x2, y2, Math.max(0.5, r2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const steps = Math.ceil(distance / spacing);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;
      const r = r1 + (r2 - r1) * t;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Renders the stroke (no-op for FlowPenTool, stamping happens in onPointerMove).
   */
  renderStroke(last, user) {
    // No-op: stamping is handled incrementally in onPointerMove/onPointerMoveNoRender
  }

  /**
   * Gets the preview dirty rectangle.
   */
  getPreviewDirtyRect(user) {
    const b = this._tickDirtyBounds;
    if (!b || b.minX === Infinity) return false;
    // A partial preview rect must cover the mirrored copies too, and they are
    // nowhere near the stroke. `hasMirrors()` — NOT `mirrorRegions.length`: that
    // missed the full-board mirror entirely, so with it on the live preview was
    // clipped to a bbox around the unmirrored stroke and the reflected half only
    // appeared at mouse-up (the commit path does not use this rect). null = redraw all.
    if (this.board.hasMirrors?.()) return null;

    this._tickDirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

    const size = user?.size ?? 0;
    const blurAmount = hardnessBlurAmount(this.userHardness, size);
    const margin = Math.ceil(Math.max(size, 1) + blurExtent(blurAmount) + size * 0.5 + 10);
    return {
      x: Math.max(0, Math.floor(b.minX) - margin),
      y: Math.max(0, Math.floor(b.minY) - margin),
      width: Math.ceil(b.maxX - b.minX) + margin * 2,
      height: Math.ceil(b.maxY - b.minY) + margin * 2
    };
  }

  /**
   * Draws the current stroke preview on the top canvas.
   * @param {Object} user - The user performing the action.
   */
  drawPreview(user, rect = null) {
    if (!this.offscreenCanvas) return;

    const ctx = this.board.topCtx;
    ctx.globalAlpha = this.userAlpha;

    const pressured = this._compositePressure(user, rect);
    const draw = () => this.board.withSelectionMaskClip(ctx, user.id, () => {
      if (pressured) {
        ctx.drawImage(pressured, 0, 0);
      } else {
        this.compositeWithHardness(ctx, this.offscreenCanvas, user.size, 0, 0);
      }

      this.board.forEachMirrorRegion({ rect: this.dirtyBounds ? {
        x: this.dirtyBounds.minX,
        y: this.dirtyBounds.minY,
        width: this.dirtyBounds.maxX - this.dirtyBounds.minX,
        height: this.dirtyBounds.maxY - this.dirtyBounds.minY
      } : null }, (region) => {
        this.board.drawMirroredCanvas(ctx, pressured || this.offscreenCanvas, region, 0, 0);
      });
    });

    if (rect) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      draw();
      ctx.restore();
    } else {
      draw();
    }
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
    drawTaperedStroke(ctx, points, user);

    this.board.forEachMirrorRegion({ points }, (region) => {
      const mirroredPoints = this.board.mirrorPointsToRegion(points, region);
      this.board.withMirrorRegionClip(ctx, region, () => {
        drawTaperedStroke(ctx, mirroredPoints, user);
      });
    });
  }

  /**
   * Composites the offscreen canvas with a hardness-based blur effect.
   * @param {CanvasRenderingContext2D} ctx - The target canvas context.
   * @param {HTMLCanvasElement} sourceCanvas - The source canvas to composite.
   * @param {number} size - The stroke size.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   */
  compositeWithHardness(ctx, sourceCanvas, size, x, y) {
    const blurAmount = (1 - this.userHardness) * (20 + size * 0.2);

    if (blurAmount > 0) {
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = this.strokeColor;
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      ctx.drawImage(sourceCanvas, x + offset, y);
      ctx.restore();
    } else {
      ctx.drawImage(sourceCanvas, x, y);
    }
  }

  /**
   * Drains the stamp buffer for network synchronization.
   * @returns {Object} - An object containing ps (positions) and rs (pressures).
   */
  drainStampBuffer() {
    const buf = this.stampBuffer;
    this.stampBuffer = [];
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
    if (this.offscreenCtx) {
      this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    }
    this.lastStampPos = null;
    this.stampBuffer = [];
    this.dirtyBounds = null;
    this._tickDirtyBounds = null;
    this.pressureMask.reset();
  }

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this.lastStampPos && this._activeUser) {
      this.onPointerUp(this._activeUser, this.lastStampPos);
    }
    this._activeUser = null;
  }
}
