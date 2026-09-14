/**
 * @fileoverview Frame pacing for marching-ants selection outlines.
 *
 * An idle selection repaints its overlay every animation frame purely to shift
 * a dash pattern, and the local SelectTool's repaint starts with a full-board
 * clearTop(). Low power mode throttles that. Overlay-only: nothing paced here
 * touches committed layer pixels, so other clients see no difference.
 */

/** Minimum ms between ant repaints in low power mode (~15 Hz). */
export const ANTS_LOW_POWER_INTERVAL_MS = 66;

/**
 * Decide whether this animation frame should repaint the ants.
 *
 * @param {boolean} lowPower - board.lowPowerMode
 * @param {number} now - rAF timestamp
 * @param {number} lastDraw - rAF timestamp of the previous repaint, 0 if none
 * @returns {number} dash offset to advance by, or 0 to skip this frame
 */
export function marchingAntsStep(lowPower, now, lastDraw) {
  if (!lowPower) return 1;
  if (lastDraw && now - lastDraw < ANTS_LOW_POWER_INTERVAL_MS) return 0;
  // 2px per repaint reads as motion at 15 Hz and stays under half the 4px dash,
  // so the pattern never aliases into crawling backwards.
  return 2;
}
