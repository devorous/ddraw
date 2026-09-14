/**
 * @fileoverview What stylus pressure drives — shared by client and server.
 *
 * A pressure tool's pressure can scale its size, its opacity, both or neither.
 * The choice belongs to the user (User.pressureTargets), is broadcast as CPT,
 * rides in USERS for anyone who joins later, and is stamped onto every MD so
 * each stroke keeps the targets it was drawn with wherever it is replayed —
 * history, a joiner's rebuild, a parity resync.
 *
 * On the wire (`pt`) the bits are offset by PRESSURE_TARGETS_WIRE_SET so
 * "nothing selected" survives proto3 dropping zeros. 0 means unset — an older
 * client, or a stroke recorded before targets existed — and decodes as
 * size-only, which is how pressure always worked.
 *
 * Bit 4 once meant hardness. That target was removed; wherever the bit still
 * turns up (an older client, a recorded stroke, a saved lock) it is ignored.
 */

export const PRESSURE_TARGET_SIZE = 1;
export const PRESSURE_TARGET_OPACITY = 2;

/** Every target bit. */
export const PRESSURE_TARGET_ALL = PRESSURE_TARGET_SIZE | PRESSURE_TARGET_OPACITY;

/** Pressure has always scaled size, so that stays the default. */
export const DEFAULT_PRESSURE_TARGETS = PRESSURE_TARGET_SIZE;

/** Checkbox name (`data-pressure-target`) → bit. */
export const PRESSURE_TARGET_BITS = Object.freeze({
  size: PRESSURE_TARGET_SIZE,
  opacity: PRESSURE_TARGET_OPACITY
});

const PRESSURE_TARGETS_WIRE_SET = 8;

/** Largest value a stored or received target set may hold, retired hardness bit included. */
const PRESSURE_TARGETS_STORED_MAX = 7;

/**
 * Tools that offer the choice. Tools not listed offer none: glitch blur is a
 * pressure tool in name only (its stamps are always `user.size`).
 */
export const PRESSURE_TARGETS_BY_TOOL = Object.freeze({
  brush: PRESSURE_TARGET_ALL,
  flowPen: PRESSURE_TARGET_ALL,
  ink: PRESSURE_TARGET_ALL,
  circleBlur: PRESSURE_TARGET_ALL,
  erase: PRESSURE_TARGET_ALL,
  imageBrush: PRESSURE_TARGET_ALL
});

/**
 * @param {*} targets
 * @returns {number} A valid PRESSURE_TARGET_* combination (0 = none), or the default.
 */
export function normalizePressureTargets(targets) {
  const n = Number(targets);
  return Number.isInteger(n) && n >= 0 && n <= PRESSURE_TARGETS_STORED_MAX
    ? n & PRESSURE_TARGET_ALL
    : DEFAULT_PRESSURE_TARGETS;
}

/**
 * @param {number} targets
 * @returns {number} The `pt` wire value.
 */
export function encodePressureTargets(targets) {
  return normalizePressureTargets(targets) | PRESSURE_TARGETS_WIRE_SET;
}

/**
 * @param {number|undefined} wire - `pt` as received; absent/0 is an older sender.
 * @returns {number}
 */
export function decodePressureTargets(wire) {
  const n = Number(wire);
  if (!Number.isInteger(n) || !(n & PRESSURE_TARGETS_WIRE_SET)) return DEFAULT_PRESSURE_TARGETS;
  return n & PRESSURE_TARGET_ALL;
}

/**
 * Server-side clamp for a client-supplied `pt`.
 * @param {*} wire
 * @returns {number} A valid encoded value, or 0 (unset).
 */
export function sanitizePressureTargetsWire(wire) {
  const n = Number(wire);
  if (!Number.isInteger(n) || n < PRESSURE_TARGETS_WIRE_SET || n > (PRESSURE_TARGETS_WIRE_SET | PRESSURE_TARGETS_STORED_MAX)) {
    return 0;
  }
  return (n & PRESSURE_TARGET_ALL) | PRESSURE_TARGETS_WIRE_SET;
}

/**
 * @param {string} tool
 * @returns {number} Target bits the tool can honour; 0 when it offers no choice.
 */
export function pressureTargetsForTool(tool) {
  return PRESSURE_TARGETS_BY_TOOL[tool] ?? 0;
}

function targetsOf(user) {
  return user?.pressureTargets ?? DEFAULT_PRESSURE_TARGETS;
}

/**
 * Multiplier pressure applies to a user's size — the pressure itself when size
 * is a target, otherwise 1.
 * @param {Object} user
 * @param {number} [pressure=user.pressure]
 * @returns {number}
 */
export function pressureSizeFactor(user, pressure = user?.pressure ?? 1) {
  return (targetsOf(user) & PRESSURE_TARGET_SIZE) ? pressure : 1;
}

/**
 * @param {Object} user
 * @param {number} [pressure=user.pressure]
 * @returns {number}
 */
export function pressureOpacityFactor(user, pressure = user?.pressure ?? 1) {
  return (targetsOf(user) & PRESSURE_TARGET_OPACITY) ? pressure : 1;
}
