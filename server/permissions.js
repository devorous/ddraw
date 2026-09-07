/**
 * Centralized permission system for server-side action authorization.
 *
 * Role tiers (see SessionManager.js):
 *   Room-scoped: GUEST(0) USER(1) TRUSTED(2) HELPER(3) MOD(4) ADMIN(5) OWNER(6)
 *   Global:      NOBLE(7) HOLY(8) DEITY(9)
 *
 * To reassign an action to a different tier, change the value in ACTION_MIN_ROLE.
 * To add a new action, add it to Action and ACTION_MIN_ROLE — no other changes needed.
 */

import { Role } from './SessionManager.js';

// ── Action identifiers ──────────────────────────────────────────────
export const Action = Object.freeze({
  // Board actions
  CLEAR_CANVAS:     'clear_canvas',
  TOGGLE_MIRROR:    'toggle_mirror',   // ADMIN+ — full-board mirror is room-wide

  // Moderation — room-scoped
  MOD_MUTE:         'mod_mute',         // TRUSTED+
  MOD_UNMUTE:       'mod_unmute',       // TRUSTED+
  MOD_UPDATE:       'mod_update_reason',// TRUSTED+
  MOD_UPDATE_DURATION: 'mod_update_duration', // TRUSTED+ (also rank-checked against the original issuer)
  MOD_KICK:         'mod_kick',         // MOD+
  MOD_BAN:          'mod_ban',          // MOD+
  MOD_UNBAN:        'mod_unban',        // MOD+
  MOD_SHADOWBAN:    'mod_shadowban',    // HOLY+
  MOD_UNSHADOWBAN:  'mod_unshadowban',  // HOLY+
  MOD_WIPE:         'mod_wipe',         // MOD+
  MOD_LIST:         'mod_list',         // MOD+

  // Room management
  ROOM_UPDATE:      'room_update',      // ADMIN+ (or room owner, checked separately)

  // Room management
  ROOM_ROLE_SET:    'room_role_set',    // Room owner, room ADMIN(5)+, or DEITY(9)

  // Deity-exclusive abilities
  VIEW_REAL_IPS:    'view_real_ips',    // DEITY only — unobfuscated IPs in mod list
  PROMOTE_USER:     'promote_user',     // DEITY only — change another user's role
});

// ── Permission map ───────────────────────────────────────────────────
// Every action maps to the minimum room role required.
const ACTION_MIN_ROLE = Object.freeze({
  [Action.CLEAR_CANVAS]:   Role.MOD,     // 4
  // Stricter than CLEAR_CANVAS on purpose: the full-board mirror reflects every
  // subsequent stroke for everyone in the room until it is turned back off.
  [Action.TOGGLE_MIRROR]:  Role.ADMIN,   // 5

  [Action.MOD_MUTE]:       Role.TRUSTED, // 2
  [Action.MOD_UNMUTE]:     Role.TRUSTED, // 2
  [Action.MOD_UPDATE]:     Role.TRUSTED, // 2
  [Action.MOD_UPDATE_DURATION]: Role.TRUSTED, // 2
  [Action.MOD_KICK]:       Role.MOD,     // 4
  [Action.MOD_BAN]:        Role.MOD,     // 4
  [Action.MOD_UNBAN]:      Role.MOD,     // 4
  [Action.MOD_SHADOWBAN]:  Role.HOLY,    // 8
  [Action.MOD_UNSHADOWBAN]:Role.HOLY,    // 8
  [Action.MOD_WIPE]:       Role.MOD,     // 4
  [Action.MOD_LIST]:       Role.MOD,     // 4

  [Action.ROOM_UPDATE]:    Role.ADMIN,   // 5
  [Action.ROOM_ROLE_SET]:  Role.ADMIN,   // 5 (also allowed for room owner, checked separately)

  [Action.VIEW_REAL_IPS]:  Role.DEITY,   // 9
  [Action.PROMOTE_USER]:   Role.DEITY,   // 9
});

const GLOBAL_ACTION_MIN_ROLE = Object.freeze({
  [Action.MOD_MUTE]:        Role.NOBLE,
  [Action.MOD_UNMUTE]:      Role.NOBLE,
  [Action.MOD_UPDATE]:      Role.NOBLE,
  [Action.MOD_UPDATE_DURATION]: Role.NOBLE,
  [Action.MOD_KICK]:        Role.NOBLE,
  [Action.MOD_WIPE]:        Role.NOBLE,

  [Action.CLEAR_CANVAS]:    Role.HOLY,
  [Action.TOGGLE_MIRROR]:   Role.HOLY,
  [Action.MOD_BAN]:         Role.HOLY,
  [Action.MOD_UNBAN]:       Role.HOLY,
  [Action.MOD_SHADOWBAN]:   Role.HOLY,
  [Action.MOD_UNSHADOWBAN]: Role.HOLY,
  [Action.MOD_LIST]:        Role.HOLY,
  [Action.ROOM_UPDATE]:     Role.HOLY,
  [Action.ROOM_ROLE_SET]:   Role.HOLY,

  [Action.VIEW_REAL_IPS]:   Role.DEITY,
  [Action.PROMOTE_USER]:    Role.DEITY,
});

// ── Public API ──────────────────────────────────────────────────────

/**
 * Check whether a role level is allowed to perform an action.
 * @param {number} role - The user's role level (0–9).
 * @param {string} action - An Action constant.
 * @returns {boolean}
 */
export function canPerform(role, action) {
  const minRole = ACTION_MIN_ROLE[action];
  if (minRole === undefined) return false;   // unknown action → deny
  return role >= minRole;
}

/**
 * Check an action against separate room and global ranks.
 *
 * Room and global authority are kept distinct on purpose: a high global role
 * does not implicitly grant per-room moderation power, and a high room role
 * does not unlock the global-only actions (those have stricter min ranks in
 * GLOBAL_ACTION_MIN_ROLE). The two checks are an OR — either path authorizes.
 *
 * @param {Object} client - WebSocket-like object with .roomRole/.globalRole.
 * @param {string} action - An Action constant.
 * @returns {boolean}
 */
export function canPerformForClient(client, action) {
  if (!client) return false;

  // Per-room check: only the room-scoped role counts. Treat 0 as "no room role"
  // (Role.GUEST). A previous version had `client.roomRole ?? client.userRole`
  // as a fallback, but `??` doesn't catch 0 so the fallback was dead, and
  // bleeding the effective role through here would silently violate the
  // room/global separation.
  const roomRole = Number(client.roomRole || Role.GUEST);
  if (canPerform(roomRole, action)) return true;

  const globalMinRole = GLOBAL_ACTION_MIN_ROLE[action];
  if (globalMinRole === undefined) return false;
  return Number(client.globalRole || Role.GUEST) >= globalMinRole;
}

/**
 * Convenience: check permission and, if denied, send a MOD_RESULT
 * error back to the client. Returns true if authorized.
 * @param {Object} ws - The WebSocket connection (must have .userRole).
 * @param {string} action - An Action constant.
 * @param {function} sendTo - sendTo(ws, payload) helper.
 * @param {number} T_MOD_RESULT - The MOD_RESULT message type constant.
 * @returns {boolean} true if the caller may proceed.
 */
export function authorize(ws, action, sendTo, T_MOD_RESULT) {
  if (canPerformForClient(ws, action)) return true;
  if (typeof sendTo === 'function') {
    sendTo(ws, { t: T_MOD_RESULT, a: false, authError: 'Insufficient permissions' });
  }
  return false;
}
