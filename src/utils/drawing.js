/**
 * @fileoverview Drawing utility functions for curve interpolation, smoothing, and geometric calculations.
 */

/** Skia paints a `shadowBlur` tail out to ~1.25x the blur value; see blurExtent(). */
const BLUR_EXTENT_FACTOR = 1.25;
const BLUR_EXTENT_PAD = 5;

/**
 * Generates quadratic curve points from a set of points.
 * @param {Array<{x: number, y: number}>} points - Input points.
 * @returns {Array<{x: number, y: number}>} - Quadratic curve points including control points.
 */
export function quadraticCurve(points) {
  const quadraticPoints = [];

  for (let i = 0; i < points.length - 2; i++) {
    const point1 = points[i];
    const point2 = points[i + 1];
    const point3 = points[i + 2];

    const controlPointX = (point1.x + point2.x * 2 + point3.x) / 4;
    const controlPointY = (point1.y + point2.y * 2 + point3.y) / 4;
    const controlPoint = { x: controlPointX, y: controlPointY };

    quadraticPoints.push(point1, controlPoint, point2);
  }

  return quadraticPoints;
}

/**
 * Draws a quadratic curve on a canvas context.
 * @param {Array<{x: number, y: number}>} points - Quadratic curve points.
 * @param {CanvasRenderingContext2D} ctx - Canvas context.
 */
export function drawQuadraticCurve(points, ctx) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 2; i += 2) {
    ctx.quadraticCurveTo(
      points[i].x, points[i].y,
      points[i + 1].x, points[i + 1].y
    );
  }

  ctx.stroke();
}

/**
 * Applies a moving average filter to a set of points for smoothing.
 * @param {Array<{x: number, y: number}>} points - Input points.
 * @param {number} windowSize - Smoothing window size.
 * @returns {Array<{x: number, y: number}>} - Smoothed points.
 */
export function movingAverage(points, windowSize) {
  const smoothedPoints = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;

    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (j >= 0 && j < points.length) {
        sumX += points[j].x;
        sumY += points[j].y;
        count++;
      }
    }

    const avgX = sumX / count;
    const avgY = sumY / count;
    smoothedPoints.push({ x: avgX, y: avgY });
  }

  smoothedPoints.push(points[points.length - 1]);
  return smoothedPoints;
}

/**
 * Calculates Catmull-Rom spline points for a set of points.
 * @param {Array<{x: number, y: number}>} points - Input points.
 * @param {number} tension - Spline tension.
 * @returns {Array<{x: number, y: number}>} - Points with Catmull-Rom control points.
 */
export function calcCatmullRomCurve(points, tension) {
  if (points.length < 2) {
    return points;
  }

  const smoothedPoints = [];
  const numPoints = points.length - 1;

  for (let i = 0; i < numPoints; i++) {
    const p0 = i > 0 ? points[i - 1] : points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i !== numPoints - 1 ? points[i + 2] : p2;

    const cp1 = {
      x: p1.x + (tension * (p2.x - p0.x)) / 6,
      y: p1.y + (tension * (p2.y - p0.y)) / 6
    };
    const cp2 = {
      x: p2.x - (tension * (p3.x - p1.x)) / 6,
      y: p2.y - (tension * (p3.y - p1.y)) / 6
    };

    smoothedPoints.push(p1, cp1, cp2);
  }

  smoothedPoints.push(points[numPoints]);
  return smoothedPoints;
}

/**
 * Calculates Manhattan distance between two points.
 * @param {{x: number, y: number}} p1 - First point.
 * @param {{x: number, y: number}} p2 - Second point.
 * @returns {number} - Manhattan distance.
 */
export function manhattanDistance(p1, p2) {
  if (p1 && p2) {
    return Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y);
  }
  return 0;
}

/**
 * Mirrors a set of points horizontally.
 * @param {Array<{x: number, y: number}>} points - Points to mirror.
 * @param {number} width - Canvas width.
 * @returns {Array<{x: number, y: number}>} - Mirrored points.
 */
export function mirrorLine(points, width) {
  return points.map(point => ({
    x: width - point.x,
    y: point.y
  }));
}

/**
 * Calculate outer tangent points between two circles
 * @param {Object} c1 - First circle {x, y, radius}
 * @param {Object} c2 - Second circle {x, y, radius}
 * @returns {Object|null} - Tangent points {left: {t1, t2}, right: {t1, t2}} or null if circles overlap too much
 */
export function getOuterTangents(c1, c2) {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.sqrt(dx * dx + dy * dy);

  // If circles are too close or one contains the other, can't compute tangents
  if (d < Math.abs(c1.radius - c2.radius) + 0.001) {
    return null;
  }

  // Base angle from c1 to c2
  const baseAngle = Math.atan2(dy, dx);

  // Angle offset for outer tangents
  // For outer tangents: sin(alpha) = (r1 - r2) / d
  const radiusDiff = c1.radius - c2.radius;
  const sinAlpha = Math.max(-1, Math.min(1, radiusDiff / d));
  const alpha = Math.asin(sinAlpha);

  // Tangent angles (perpendicular to the line from center to tangent point)
  const leftAngle = baseAngle + Math.PI / 2 - alpha;
  const rightAngle = baseAngle - Math.PI / 2 + alpha;

  return {
    left: {
      t1: {
        x: c1.x + c1.radius * Math.cos(leftAngle),
        y: c1.y + c1.radius * Math.sin(leftAngle),
        angle: leftAngle
      },
      t2: {
        x: c2.x + c2.radius * Math.cos(leftAngle),
        y: c2.y + c2.radius * Math.sin(leftAngle),
        angle: leftAngle
      }
    },
    right: {
      t1: {
        x: c1.x + c1.radius * Math.cos(rightAngle),
        y: c1.y + c1.radius * Math.sin(rightAngle),
        angle: rightAngle
      },
      t2: {
        x: c2.x + c2.radius * Math.cos(rightAngle),
        y: c2.y + c2.radius * Math.sin(rightAngle),
        angle: rightAngle
      }
    },
    baseAngle
  };
}

/**
 * Draw a stroke as a series of connected circles with tangent lines
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Array} points - Array of {x, y, radius} objects
 * @param {string} color - Fill color
 */
export function drawTangentStroke(ctx, points, color) {
  if (points.length === 0) return;

  ctx.fillStyle = color;

  // Single point - just draw a circle
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, points[0].radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Two points - draw circles and connecting quad
  if (points.length === 2) {
    const tangents = getOuterTangents(points[0], points[1]);
    if (!tangents) {
      // Fallback: just draw both circles
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, points[0].radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(points[1].x, points[1].y, points[1].radius, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.beginPath();
    // Start cap
    ctx.arc(points[0].x, points[0].y, points[0].radius,
      tangents.left.t1.angle, tangents.right.t1.angle, true);
    // Right edge to second circle
    ctx.lineTo(tangents.right.t2.x, tangents.right.t2.y);
    // End cap
    ctx.arc(points[1].x, points[1].y, points[1].radius,
      tangents.right.t2.angle, tangents.left.t2.angle, true);
    // Left edge back
    ctx.lineTo(tangents.left.t1.x, tangents.left.t1.y);
    ctx.closePath();
    ctx.fill();
    return;
  }

  // Multiple points - build the full stroke
  // Pre-compute all tangent data
  const tangentData = [];
  for (let i = 0; i < points.length - 1; i++) {
    const t = getOuterTangents(points[i], points[i + 1]);
    tangentData.push(t);
  }

  ctx.beginPath();

  // Start cap on first circle
  const firstTangent = tangentData[0];
  if (firstTangent) {
    ctx.arc(points[0].x, points[0].y, points[0].radius,
      firstTangent.left.t1.angle, firstTangent.right.t1.angle, true);
  } else {
    ctx.arc(points[0].x, points[0].y, points[0].radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Right edge forward (from first to last)
  for (let i = 0; i < tangentData.length; i++) {
    const t = tangentData[i];
    if (!t) continue;

    // Line to tangent point on next circle
    ctx.lineTo(t.right.t2.x, t.right.t2.y);

    // If not the last segment, draw arc to next segment's tangent
    if (i < tangentData.length - 1) {
      const nextT = tangentData[i + 1];
      if (nextT) {
        // Arc on intermediate circle from current right tangent to next right tangent
        const circle = points[i + 1];
        ctx.arc(circle.x, circle.y, circle.radius,
          t.right.t2.angle, nextT.right.t1.angle, true);
      }
    }
  }

  // End cap on last circle
  const lastTangent = tangentData[tangentData.length - 1];
  if (lastTangent) {
    const lastCircle = points[points.length - 1];
    ctx.arc(lastCircle.x, lastCircle.y, lastCircle.radius,
      lastTangent.right.t2.angle, lastTangent.left.t2.angle, true);
  }

  // Left edge backward (from last to first)
  for (let i = tangentData.length - 1; i >= 0; i--) {
    const t = tangentData[i];
    if (!t) continue;

    // Line to tangent point on previous circle
    ctx.lineTo(t.left.t1.x, t.left.t1.y);

    // If not the first segment, draw arc to previous segment's tangent
    if (i > 0) {
      const prevT = tangentData[i - 1];
      if (prevT) {
        // Arc on intermediate circle from current left tangent to previous left tangent
        const circle = points[i];
        ctx.arc(circle.x, circle.y, circle.radius,
          t.left.t1.angle, prevT.left.t2.angle, true);
      }
    }
  }

  ctx.closePath();
  ctx.fill();
}

/**
 * Calculate perpendicular distance from point to line segment
 * @param {number} px - Point X
 * @param {number} py - Point Y
 * @param {number} x1 - Line start X
 * @param {number} y1 - Line start Y
 * @param {number} x2 - Line end X
 * @param {number} y2 - Line end Y
 * @returns {number} - Perpendicular distance
 */
function perpendicularDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;

  // Handle degenerate case where line segment is a point
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    const pdx = px - x1;
    const pdy = py - y1;
    return Math.sqrt(pdx * pdx + pdy * pdy);
  }

  // Calculate perpendicular distance using cross product
  // numerator = |(y2-y1)px - (x2-x1)py + x2y1 - y2x1|
  const numerator = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1);
  const denominator = Math.sqrt(lengthSquared);

  return numerator / denominator;
}

/**
 * Douglas-Peucker point reduction algorithm
 * Recursively simplifies a polyline while preserving its shape
 * @param {Array<number>} points - Flattened array of points [x, y, p, x, y, p...]
 * @param {number} epsilon - Tolerance (larger = more reduction)
 * @returns {Array<number>} - Simplified flattened array of points
 */
export function douglasPeucker(points, epsilon) {
  const len = points.length;
  if (len < 6) {
    return points;
  }

  const kept = new Uint8Array(len / 3);
  kept[0] = 1;
  kept[(len / 3) - 1] = 1;

  simplifyStep(points, 0, (len / 3) - 1, epsilon, kept);

  const result = [];
  for (let i = 0; i < kept.length; i++) {
    if (kept[i]) {
      result.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    }
  }
  return result;
}

/**
 * Recursive step for Douglas-Peucker using indices to avoid slicing.
 * @param {Array<number>} points - Original flattened points.
 * @param {number} start - Start index of the current segment.
 * @param {number} end - End index of the current segment.
 * @param {number} epsilon - Tolerance.
 * @param {Uint8Array} kept - Mask of kept points.
 */
function simplifyStep(points, start, end, epsilon, kept) {
  if (end <= start + 1) return;

  let maxDistance = 0;
  let maxIndex = 0;

  const x1 = points[start * 3];
  const y1 = points[start * 3 + 1];
  const x2 = points[end * 3];
  const y2 = points[end * 3 + 1];

  for (let i = start + 1; i < end; i++) {
    const distance = perpendicularDistance(
      points[i * 3], points[i * 3 + 1],
      x1, y1, x2, y2
    );

    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  if (maxDistance > epsilon) {
    kept[maxIndex] = 1;
    simplifyStep(points, start, maxIndex, epsilon, kept);
    simplifyStep(points, maxIndex, end, epsilon, kept);
  }
}

/**
 * Distance-based point culling (simpler and faster than Douglas-Peucker)
 * Removes points that are closer than threshold to previous kept point
 * @param {Array} points - Array of {x, y} points
 * @param {number} threshold - Minimum distance between points
 * @returns {Array} - Simplified array of points
 */
export function distanceBasedCulling(points, threshold) {
  if (points.length <= 2) {
    return points;
  }

  const result = [points[0]]; // Always keep first point
  let lastKept = points[0];

  for (let i = 1; i < points.length - 1; i++) {
    const dx = points[i].x - lastKept.x;
    const dy = points[i].y - lastKept.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance >= threshold) {
      result.push(points[i]);
      lastKept = points[i];
    }
  }

  // Always keep last point (important for shape tools)
  result.push(points[points.length - 1]);

  return result;
}

/**
 * Bridges the gap between two points with interpolated filled circles.
 * Used for tools that need continuous stamping (Pen, Blur, etc).
 * @param {CanvasRenderingContext2D} ctx - Canvas context.
 * @param {{x: number, y: number}} from - Start position.
 * @param {{x: number, y: number}} to - End position.
 * @param {number} fromRadius - Start radius.
 * @param {number} toRadius - End radius.
 * @param {Object} user - User object with drawing settings.
 * @param {string} [blendMode='source-over'] - Canvas globalCompositeOperation.
 */
export function bridgeGap(ctx, from, to, fromRadius, toRadius, user, blendMode = 'source-over') {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Spacing: 10% of average radius (see getStampSpacing)
  const spacing = getStampSpacing(fromRadius, toRadius);
  const steps = Math.ceil(distance / spacing);

  ctx.save();
  ctx.globalCompositeOperation = blendMode;
  ctx.fillStyle = user.getColorString();

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const r = fromRadius + (toRadius - fromRadius) * t;

    ctx.beginPath();
    ctx.arc(x, y, getRenderableStampRadius(r), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Returns a stamp spacing that still works for sub-pixel brushes without
 * collapsing into obviously separated dots.
 * @param {number} fromRadius
 * @param {number} [toRadius=fromRadius]
 * @returns {number}
 */
export function getStampSpacing(fromRadius, toRadius = fromRadius) {
  const avgRadius = Math.max(0, (fromRadius + toRadius) / 2);
  return Math.max(0.05, avgRadius * 0.1);
}

/**
 * Clamps a rectangle to a canvas's bounds, snapping to integer pixels
 * (floor the top-left, ceil the bottom-right).
 * @param {{x:number, y:number, width:number, height:number}} rect
 * @param {{width:number, height:number}} canvas
 * @returns {{x:number, y:number, width:number, height:number}|null} The clamped
 *   rect, or null if it falls entirely outside the canvas.
 */
export function clampRectToCanvas(rect, canvas) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(canvas.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(canvas.height, Math.ceil(rect.y + rect.height));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Returns a canvas (and its 2D context) sized to the given dimensions, reusing
 * `existing` if it already matches and allocating a fresh one otherwise.
 * @param {HTMLCanvasElement|null} existing - The current offscreen canvas, if any.
 * @param {number} width
 * @param {number} height
 * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}}
 */
export function ensureSizedCanvas(existing, width, height) {
  if (existing && existing.width === width && existing.height === height) {
    return { canvas: existing, ctx: existing.getContext('2d') };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d') };
}

/**
 * Returns the actual radius used for a circular stamp. Keep tiny radii intact
 * so remote stamp rendering matches local sub-pixel strokes.
 * @param {number} radius
 * @returns {number}
 */
export function getRenderableStampRadius(radius) {
  return Math.max(0.01, radius);
}

/**
 * How far a stroke's soft (low-hardness) edge paints past its geometric edge.
 *
 * Soft edges are drawn with canvas `shadowBlur = blurAmount` (see
 * drawLineArray), which the spec defines as a Gaussian with sigma =
 * blurAmount / 2. Skia's blur support runs to ~2.4 sigma, i.e. ~1.2x
 * blurAmount, and the tail is fully transparent beyond that.
 *
 * Measured rather than assumed: sweeping size 1-300 x hardness 0-99.5 x
 * pressure 0.05-1 through the real renderer and reading back the exact
 * non-zero-alpha bbox put the worst case at 1.25 * blurAmount + 0.43px.
 * BLUR_EXTENT_PAD covers that plus rect rounding.
 *
 * Dirty rects used to pad by `blurAmount * 2.5` — a little over double what
 * the blur can actually reach, which at low hardness inflated every rect
 * (and so every composite and readback) for no visual gain.
 *
 * @param {number} blurAmount - The `shadowBlur` value the stroke is drawn with.
 * @returns {number} Extra margin in px, or 0 for a fully hard edge.
 */
export function blurExtent(blurAmount) {
  if (!(blurAmount > 0)) return 0;
  return blurAmount * BLUR_EXTENT_FACTOR + BLUR_EXTENT_PAD;
}

/**
 * Draws a line through an array of points.
 * Standard implementation used by BrushTool and RemoteUserHandler.
 * @param {Array<{x: number, y: number}>} points - Points to draw.
 * @param {CanvasRenderingContext2D} ctx - Canvas context.
 * @param {Object} user - User object with drawing settings.
 * @param {Object|null} [board=null] - Optional board reference.
 * @param {string} [blendMode='source-over'] - Canvas globalCompositeOperation.
 */
export function drawLineArray(points, ctx, user, board = null, blendMode = 'source-over') {
  if (!points || points.length === 0) return;

  const opacity = user.opacity !== undefined ? user.opacity : 1;
  const hardness = user.hardness !== undefined ? user.hardness / 100.0 : 1.0;

  const renderStroke = (targetCtx) => {
    targetCtx.save();
    targetCtx.globalAlpha = opacity;
    targetCtx.globalCompositeOperation = blendMode;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.lineWidth = user.pressure * user.size * 2;

    const color = user?.color ?? [0, 0, 0, 1];
    const colorString = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

    if (hardness < 1.0) {
      const size = user.size ?? 0;
      const blurAmount = (1 - hardness) * (20 + size * 0.2);
      const offset = 100000;

      targetCtx.strokeStyle = colorString;
      targetCtx.shadowBlur = blurAmount;
      targetCtx.shadowColor = colorString;
      targetCtx.shadowOffsetX = -offset;
      targetCtx.shadowOffsetY = 0;

      targetCtx.translate(offset, 0);
    } else {
      targetCtx.strokeStyle = colorString;
      targetCtx.shadowBlur = 0;
    }

    targetCtx.beginPath();
    targetCtx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
      targetCtx.lineTo(points[i].x, points[i].y);
    }
    targetCtx.stroke();
    targetCtx.restore();
  };

  renderStroke(ctx);
}

// Blur functions moved to blurUtils.js for lazy loading
// Import from './blurUtils.js' instead

/**
 * Test if a point is inside a polygon using winding number algorithm.
 * Works with any polygon (convex or concave).
 * @param {Object} point - Point to test {x, y}
 * @param {Array<Object>} polygon - Array of polygon vertices [{x, y}, ...]
 * @returns {boolean} True if point is inside polygon
 */
export function pointInHull(point, polygon) {
  if (!polygon || polygon.length < 3) return false;

  let windingNumber = 0;
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const v1 = polygon[i];
    const v2 = polygon[(i + 1) % n];

    if (v1.y <= point.y) {
      if (v2.y > point.y) {
        // Upward crossing
        if (isLeft(v1, v2, point) > 0) {
          windingNumber++;
        }
      }
    } else {
      if (v2.y <= point.y) {
        // Downward crossing
        if (isLeft(v1, v2, point) < 0) {
          windingNumber--;
        }
      }
    }
  }

  return windingNumber !== 0;
}

/**
 * Test if a point is left/on/right of an infinite line.
 * @param {Object} p0 - Line start point {x, y}
 * @param {Object} p1 - Line end point {x, y}
 * @param {Object} p2 - Point to test {x, y}
 * @returns {number} >0 for left, =0 for on, <0 for right
 * @private
 */
function isLeft(p0, p1, p2) {
  return ((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y));
}
