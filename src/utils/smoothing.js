/**
 * @fileoverview Smoothing utilities for position interpolation.
 * Provides Exponential Moving Average (EMA) smoothing for input positions.
 */

/**
 * Smoothing the Fluid Brush applies before its slider's own, so the slider's
 * 0 is still easy to draw with. The slider — and the value on the wire — keep
 * reading from 0; every client adds this where smoothing is applied.
 */
export const FLOW_PEN_BASE_SMOOTHING = 30;

/** Past this the linear EMA curve would reach a zero or negative factor. */
const LINEAR_SMOOTHING_MAX = 50;

/** Above LINEAR_SMOOTHING_MAX, the EMA factor halves for every this much more smoothing. */
const EXTENDED_SMOOTHING_HALVING = 30;

/**
 * The smoothing a tool applies for its slider value.
 * @param {string} tool
 * @param {number} smoothing - Slider value, 0-50.
 * @returns {number} The slider value, or 30-80 for the Fluid Brush.
 */
export function effectiveSmoothing(tool, smoothing) {
  const s = Number(smoothing) || 0;
  return tool === 'flowPen' ? FLOW_PEN_BASE_SMOOTHING + s : s;
}

/**
 * EMA interpolation factor for a smoothing value: how far the smoothed point
 * moves toward the target per sample. 1 means no smoothing.
 *
 * Linear up to 50, where it reaches 0.1. That line would hit zero just past
 * 56, so above 50 the factor halves every 30 instead — 0.05 at 80.
 * @param {number} userSmoothing
 * @param {number} baseline
 * @returns {number}
 */
function smoothingFactor(userSmoothing, baseline) {
  const s = Math.max(0, userSmoothing || 0);
  if (s <= LINEAR_SMOOTHING_MAX) {
    const totalSmoothing = baseline + (s / LINEAR_SMOOTHING_MAX) * (1 - baseline);
    return 1 - totalSmoothing * 0.9;
  }
  return 0.1 * 0.5 ** ((s - LINEAR_SMOOTHING_MAX) / EXTENDED_SMOOTHING_HALVING);
}

/**
 * Applies Exponential Moving Average (EMA) smoothing to a position and pressure.
 * Used by InputBufferManager to smooth inputs before local rendering and network broadcast.
 * @param {Object} buffer - Smoothing buffer with {x, y, p, isFirst}.
 * @param {number} targetX - Target X position (raw input).
 * @param {number} targetY - Target Y position (raw input).
 * @param {number} targetP - Target pressure (0-1).
 * @param {number} userSmoothing - Effective smoothing: 0-50, or up to 80 with the
 *   Fluid Brush's built-in base (see effectiveSmoothing).
 * @param {number} [baseline=0.12] - Baseline smoothing factor (12% default).
 * @param {Object} [out] - Optional output object to write results into.
 * @returns {Object} - Smoothed position and pressure {x, y, p}.
 */
export function applySmoothingEMA(buffer, targetX, targetY, targetP, userSmoothing, baseline = 0.12, out) {
  const factor = smoothingFactor(userSmoothing, baseline);

  // Use out object if provided, otherwise create a temporary one (for compatibility)
  const result = out || {};

  // First point, or no smoothing at all: initialize buffer with target
  if (buffer.isFirst || factor >= 1) {
    buffer.x = targetX;
    buffer.y = targetY;
    buffer.p = targetP !== undefined ? targetP : 1;
    buffer.isFirst = false;
    
    result.x = targetX;
    result.y = targetY;
    result.p = buffer.p;
    return result;
  }

  // Apply exponential moving average: new = old + (target - old) * factor
  const dx = (targetX - buffer.x) * factor;
  const dy = (targetY - buffer.y) * factor;
  const dp = ((targetP !== undefined ? targetP : 1) - (buffer.p !== undefined ? buffer.p : 1)) * factor;

  // Convergence: snap to target if the step is very small to prevent infinite approach
  if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
    buffer.x = targetX;
    buffer.y = targetY;
  } else {
    buffer.x += dx;
    buffer.y += dy;
  }

  if (Math.abs(dp) < 0.001) {
    buffer.p = targetP !== undefined ? targetP : 1;
  } else {
    buffer.p = (buffer.p !== undefined ? buffer.p : 1) + dp;
  }

  result.x = buffer.x;
  result.y = buffer.y;
  result.p = buffer.p;
  return result;
}

/**
 * Reset a smoothing buffer to initial state
 *
 * Call this when starting a new stroke or when smoothing state needs to be cleared.
 * The next call to applySmoothingEMA will treat the input as the first point.
 *
 * @param {Object} buffer - Smoothing buffer to reset
 *
 * @example
 * const buffer = { x: 100, y: 50, isFirst: false };
 * resetSmoothingBuffer(buffer);
 * console.log(buffer.isFirst); // true
 */
export function resetSmoothingBuffer(buffer) {
  buffer.isFirst = true;
}

/**
 * Create a new smoothing buffer with default values
 *
 * @returns {Object} New smoothing buffer {x: 0, y: 0, isFirst: true}
 *
 * @example
 * const buffer = createSmoothingBuffer();
 * const smoothed = applySmoothingEMA(buffer, 50, 50, 0.5);
 */
export function createSmoothingBuffer() {
  return { x: 0, y: 0, isFirst: true };
}

/**
 * Applies a deadband (hysteresis) filter to a position and pressure.
 *
 * Unlike {@link applySmoothingEMA}, this never moves a point: a sample either
 * passes through completely unchanged or is dropped. Samples closer than
 * `radius` to the last emitted point are treated as sensor jitter and
 * suppressed; the first sample beyond it is emitted verbatim and becomes the
 * new anchor. The result is jitter rejection with zero lag and no rounding of
 * corners or fine detail.
 *
 * Shares the buffer shape used by applySmoothingEMA ({x, y, p, isFirst}), so
 * resetSmoothingBuffer and createSmoothingBuffer apply unchanged.
 *
 * @param {Object} buffer - Smoothing buffer with {x, y, p, isFirst}.
 * @param {number} targetX - Target X position (raw input).
 * @param {number} targetY - Target Y position (raw input).
 * @param {number} targetP - Target pressure (0-1).
 * @param {number} radius - Deadband radius in board px. <= 0 passes everything.
 * @param {Object} [out] - Optional output object to write results into.
 * @returns {Object} - {x, y, p, emit}. When emit is false, x/y/p hold the
 *   unchanged anchor and the caller should discard the sample.
 */
export function applyDeadband(buffer, targetX, targetY, targetP, radius, out) {
  const result = out || {};
  const p = targetP !== undefined ? targetP : 1;

  if (buffer.isFirst) {
    buffer.x = targetX;
    buffer.y = targetY;
    buffer.p = p;
    buffer.isFirst = false;

    result.x = targetX;
    result.y = targetY;
    result.p = p;
    result.emit = true;
    return result;
  }

  const dx = targetX - buffer.x;
  const dy = targetY - buffer.y;

  if (radius > 0 && dx * dx + dy * dy < radius * radius) {
    // Inside the deadband: hold the anchor and tell the caller to drop this one.
    result.x = buffer.x;
    result.y = buffer.y;
    result.p = buffer.p;
    result.emit = false;
    return result;
  }

  // Outside the deadband: pass the sample through untouched.
  buffer.x = targetX;
  buffer.y = targetY;
  buffer.p = p;

  result.x = targetX;
  result.y = targetY;
  result.p = p;
  result.emit = true;
  return result;
}
