/**
 * @fileoverview Per-pixel pressure for tools that composite a whole stroke at once.
 *
 * Flow pen and ink draw a stroke's coverage into an offscreen canvas and apply
 * opacity once, when that canvas is composited. Pressure that drives opacity
 * has to vary along the stroke instead, so those tools also stamp each point's
 * pressure into a PressureMask (alpha = pressure) and composite through
 * compositePressureStroke(), which scales the coverage by the mask.
 *
 * Mask stamps replace what is under them instead of accumulating, so a pixel
 * takes the pressure of the most recent stamp that reached it — overlapping
 * stamps don't build up, the same no-stacking rule the offscreen canvas exists
 * for. The sender and every receiver stamp the same points in the same order
 * from the same wire values, so the masks — and the committed pixels — match.
 */

import {
  DEFAULT_PRESSURE_TARGETS,
  PRESSURE_TARGET_OPACITY,
  PRESSURE_TARGET_SIZE
} from '../../shared/pressureTargets.js';
import { blurExtent, clampRectToCanvas } from './drawing.js';

/** Room a mask window keeps around its stamps, so a growing stroke doesn't reallocate every point. */
const MASK_WINDOW_SLACK = 128;

/** Draws a soft edge from the shadow alone, the same trick every stroke tool's compositeWithHardness uses. */
const SHADOW_OFFSET = 100000;

/**
 * @param {number} targets - PRESSURE_TARGET_* bits.
 * @returns {boolean} Whether a stroke with these targets needs a pressure mask.
 */
export function usesPressureMask(targets) {
  return ((targets ?? DEFAULT_PRESSURE_TARGETS) & PRESSURE_TARGET_OPACITY) !== 0;
}

/**
 * The `shadowBlur` a stroke tool softens its edge with.
 * @param {number} hardness - 0-1.
 * @param {number} size
 * @returns {number}
 */
export function hardnessBlurAmount(hardness, size) {
  return (1 - hardness) * (20 + size * 0.2);
}

/**
 * How far past its coverage a mask stamp reaches, so the soft edge — which the
 * mask also scales — is covered too.
 * @param {number} hardness - 0-1.
 * @param {number} size
 * @returns {number}
 */
export function pressureMaskPad(hardness, size) {
  return blurExtent(hardnessBlurAmount(hardness, size)) + 2;
}

/**
 * Mask radius for a circle-stamped stroke (flow pen) at this pressure.
 * @param {number} targets
 * @param {number} pressure - 0-1.
 * @param {number} size - Stroke size at its start.
 * @param {number} hardness - 0-1.
 * @returns {number}
 */
export function pressureStampRadius(targets, pressure, size, hardness) {
  const sized = ((targets ?? DEFAULT_PRESSURE_TARGETS) & PRESSURE_TARGET_SIZE) ? pressure : 1;
  return sized * size + pressureMaskPad(hardness, size);
}

/**
 * Mask radius for an ink stroke. perfect-freehand's outline never reaches past
 * its `size` option, and the dot/segment fallbacks stay inside the stroke
 * size, so cover the larger of the two plus the soft edge.
 * @param {number} targets
 * @param {number} size - Stroke size at its start.
 * @param {number} thinning - 0-1.
 * @param {number} hardness - 0-1.
 * @returns {number}
 */
export function inkPressureMaskRadius(targets, size, thinning, hardness) {
  return Math.max(size, (size * 2) / (1 + thinning)) + pressureMaskPad(hardness, size);
}

/**
 * Ink points as the outline should see them: pressure shapes the outline only
 * when it drives size.
 * @param {Array<number[]>} points - [x, y, pressure] triples.
 * @param {number} targets
 * @returns {Array<number[]>}
 */
export function inkOutlinePoints(points, targets) {
  if ((targets ?? DEFAULT_PRESSURE_TARGETS) & PRESSURE_TARGET_SIZE) return points;
  return points.map(([x, y]) => [x, y, 1]);
}

/**
 * A stroke's pressure, as alpha, in a board-space canvas windowed to the
 * stroke and grown as it goes.
 */
export class PressureMask {
  constructor() {
    /** @type {HTMLCanvasElement|null} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = null;
    /** Board position of the canvas's (0, 0). */
    this.origin = { x: 0, y: 0 };
    /** @type {{x:number, y:number, radius:number, pressure:number}|null} */
    this.last = null;
  }

  /** Drops the mask for the next stroke. */
  reset() {
    this.canvas = null;
    this.ctx = null;
    this.origin = { x: 0, y: 0 };
    this.last = null;
  }

  /**
   * Stamps from the previous point to this one, interpolating radius and pressure.
   * @param {number} x - Board x.
   * @param {number} y - Board y.
   * @param {number} radius - Mask radius (coverage plus pressureMaskPad).
   * @param {number} pressure - 0-1.
   */
  stampTo(x, y, radius, pressure) {
    const r = Math.max(1, radius);
    const p = Math.max(0, Math.min(1, pressure));
    const last = this.last;

    this._ensure(
      Math.min(x - r, last ? last.x - last.radius : Infinity),
      Math.min(y - r, last ? last.y - last.radius : Infinity),
      Math.max(x + r, last ? last.x + last.radius : -Infinity),
      Math.max(y + r, last ? last.y + last.radius : -Infinity)
    );

    const ctx = this.ctx;
    ctx.save();
    ctx.translate(-this.origin.x, -this.origin.y);
    if (!last) {
      this._stamp(ctx, x, y, r, p);
    } else {
      const dx = x - last.x;
      const dy = y - last.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const spacing = Math.max(1, Math.min(last.radius, r) * 0.25);
      const steps = Math.max(1, Math.ceil(distance / spacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this._stamp(
          ctx,
          last.x + dx * t,
          last.y + dy * t,
          last.radius + (r - last.radius) * t,
          last.pressure + (p - last.pressure) * t
        );
      }
    }
    ctx.restore();

    this.last = { x, y, radius: r, pressure: p };
  }

  /**
   * Replaces the mask under a circle with `pressure`. The refill ADDS
   * (`lighter`) rather than drawing over: an edge pixel the circle covers by c
   * keeps (1 - c) of its old value after destination-out, and adding
   * pressure * c lands exactly on the lerp between them. `source-over` would
   * shave that edge down instead — at full pressure to 75% — leaving a faint
   * ring at every stamp.
   * @private
   */
  _stamp(ctx, x, y, radius, pressure) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (pressure <= 0) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(0, 0, 0, ${pressure})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Grows the window to cover a board-space box, carrying the stamped pixels over.
   * @private
   */
  _ensure(minX, minY, maxX, maxY) {
    const old = this.canvas;
    const o = this.origin;
    if (old && minX >= o.x && minY >= o.y && maxX <= o.x + old.width && maxY <= o.y + old.height) return;

    let left = Math.floor(minX) - MASK_WINDOW_SLACK;
    let top = Math.floor(minY) - MASK_WINDOW_SLACK;
    let right = Math.ceil(maxX) + MASK_WINDOW_SLACK;
    let bottom = Math.ceil(maxY) + MASK_WINDOW_SLACK;
    if (old) {
      left = Math.min(left, o.x);
      top = Math.min(top, o.y);
      right = Math.max(right, o.x + old.width);
      bottom = Math.max(bottom, o.y + old.height);
    }

    const canvas = document.createElement('canvas');
    canvas.width = right - left;
    canvas.height = bottom - top;
    const ctx = canvas.getContext('2d');
    if (old) ctx.drawImage(old, o.x - left, o.y - top);

    this.canvas = canvas;
    this.ctx = ctx;
    this.origin = { x: left, y: top };
  }
}

/**
 * Composites a stroke's coverage with its pressure applied, into a scratch
 * canvas laid out like the coverage canvas (same size, same board origin).
 *
 * @param {Object} scratch - Holds the scratch canvases between calls; one per stroke owner.
 * @param {HTMLCanvasElement} coverage - The stroke's solid coverage.
 * @param {{x:number, y:number}} coverageOrigin - Board position of coverage's (0, 0).
 * @param {PressureMask|null} mask
 * @param {Object} opts
 * @param {number} opts.targets - PRESSURE_TARGET_* bits.
 * @param {number} opts.hardness - The stroke's hardness, 0-1.
 * @param {number} opts.size - The stroke's size (drives the blur amount).
 * @param {string} opts.color - The stroke's CSS colour, for the soft edge.
 * @param {{x:number, y:number, width:number, height:number}|null} [opts.rect] -
 *   Coverage-local region to redraw; null or omitted redraws everything.
 * @returns {HTMLCanvasElement} Draw it at coverageOrigin with the stroke's own alpha.
 */
export function compositePressureStroke(scratch, coverage, coverageOrigin, mask, opts) {
  const { targets, hardness, size, color } = opts;
  const a = sizeScratch(scratch, 'a', coverage);
  const area = opts.rect
    ? clampRectToCanvas(opts.rect, coverage)
    : { x: 0, y: 0, width: coverage.width, height: coverage.height };
  if (!area) return a.canvas;

  // Coverage just outside the area still blurs into it, so read past the area
  // by the blur's reach and let the clip trim the result.
  const blurAmount = hardnessBlurAmount(hardness, size);
  const reach = Math.ceil(blurExtent(blurAmount));
  const source = clampRectToCanvas({
    x: area.x - reach,
    y: area.y - reach,
    width: area.width + reach * 2,
    height: area.height + reach * 2
  }, coverage);

  beginArea(a.ctx, area);
  drawCoverage(a.ctx, coverage, source, blurAmount, color);

  if (targets & PRESSURE_TARGET_OPACITY) {
    drawMask(a.ctx, mask, coverageOrigin, 'destination-in');
  }

  a.ctx.restore();
  return a.canvas;
}

function sizeScratch(scratch, key, like) {
  let entry = scratch[key];
  if (!entry || entry.canvas.width !== like.width || entry.canvas.height !== like.height) {
    const canvas = document.createElement('canvas');
    canvas.width = like.width;
    canvas.height = like.height;
    entry = scratch[key] = { canvas, ctx: canvas.getContext('2d') };
  }
  return entry;
}

function beginArea(ctx, area) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.width, area.height);
  ctx.clip();
  ctx.clearRect(area.x, area.y, area.width, area.height);
}

function drawCoverage(ctx, coverage, source, blurAmount, color) {
  if (!source) return;
  const { x, y, width, height } = source;
  if (blurAmount > 0) {
    ctx.save();
    ctx.shadowBlur = blurAmount;
    ctx.shadowColor = color;
    ctx.shadowOffsetX = -SHADOW_OFFSET;
    ctx.shadowOffsetY = 0;
    ctx.drawImage(coverage, x, y, width, height, x + SHADOW_OFFSET, y, width, height);
    ctx.restore();
  } else {
    ctx.drawImage(coverage, x, y, width, height, x, y, width, height);
  }
}

function drawMask(ctx, mask, coverageOrigin, operation) {
  ctx.globalCompositeOperation = operation;
  if (mask?.canvas) {
    ctx.drawImage(mask.canvas, mask.origin.x - coverageOrigin.x, mask.origin.y - coverageOrigin.y);
  } else if (operation === 'destination-in') {
    // No stamps yet means no pressure anywhere. Clipped to the area.
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  ctx.globalCompositeOperation = 'source-over';
}
