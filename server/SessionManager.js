/** @fileoverview Manages user sessions, state tracking, and AFK detection. */

import { T } from '../shared/MessageTypes.js';
import crypto from 'crypto';

/**
 * User role constants.
 * @enum {number}
 */
/**
 * Permission tiers — higher value = more authority.
 *
 * Room-scoped ranks (0–6): expected to exercise powers only in their assigned room.
 *   GUEST    (0) – Unauthenticated visitor
 *   USER     (1) – Registered account
 *   TRUSTED  (2) – Trusted community member
 *   HELPER   (3) – Can mute in room
 *   MOD      (4) – Full moderator in room (kick, ban, clear, wipe)
 *   ADMIN    (5) – Room administrator
 *   OWNER    (6) – Room owner (only one per room, ultimate room authority)
 *
 * Global ranks (7–9): authority extends across all rooms.
 *   NOBLE    (7) – Global mute
 *   HOLY     (8) – Global mute + ban
 *   DEITY    (9) – All powers everywhere + exclusive abilities
 */
export const Role = {
  GUEST:   0,
  USER:    1,
  TRUSTED: 2,
  HELPER:  3,
  MOD:     4,
  ADMIN:   5,
  OWNER:   6,
  NOBLE:   7,
  HOLY:    8,
  DEITY:   9,
};

export const RoleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];

const AFK_TIMEOUT = 5 * 60 * 1000;
const AFK_CHECK_INTERVAL = 30 * 1000;
const ALL_AFK_RESTORE_DELAY = 2 * 60 * 1000;
const COMPRESS_STROKES_DELAY = 5 * 60 * 1000;

/**
 * Manages user session indices, user data, and AFK tracking.
 */
export class SessionManager {
  /**
   * @param {function} broadcastCallback - Function to broadcast messages to all users.
   * @param {boolean} [isDiscovery=false] - Whether this manager is for a discovery/lobby room.
   */
  constructor(broadcastCallback, isDiscovery = false, options = {}) {
    this.sessions = new Map();
    this.users = new Map();
    this.nextSessionIndex = 0;
    this.freedIndices = [];
    this.broadcastToAll = broadcastCallback;
    this.isDiscovery = isDiscovery;
    this.isImmuneToInactivity = options.isImmuneToInactivity || (() => false);
    this.onAllUsersAfk = options.onAllUsersAfk || null;
    this._allAfkSince = null;

    this.afkCheckInterval = setInterval(() => this.checkAfkUsers(), AFK_CHECK_INTERVAL);
    /** @type {Map<number, NodeJS.Timeout>} */
    this._compressTimers = new Map();
  }

  /**
   * Returns whether a user should keep receiving live room events while inactive.
   * @param {number} sessionIndex - The user's session index.
   * @param {Object} [user=null] - Optional already-resolved user object.
   * @returns {boolean}
   */
  isUserImmuneToInactivity(sessionIndex, user = null) {
    const resolvedUser = user || this.users.get(sessionIndex);
    if (!resolvedUser) return false;
    return !!this.isImmuneToInactivity(sessionIndex, resolvedUser);
  }

  /**
   * Allocates a session index for a new user, reusing freed indices if available.
   *
   * A just-departed index is normally the most attractive to reuse (LIFO), but
   * reuse is unsafe while that departed user's post-checkpoint commits still sit
   * in the live stroke tail: a joiner handed the same index self-filters the
   * departed author's replayed frames and silently loses their work (sessionIndex
   * collision — see docs/0000Sync_Issues.md, Issue 1). The optional `isReusable`
   * predicate lets the caller veto "haunted" indices; we then pick the newest
   * reusable freed index, parking the haunted ones until a checkpoint truncates
   * their commits out of the tail (at which point they pass the predicate again).
   * If every freed index is haunted, we grow the space rather than collide.
   *
   * @param {((index: number) => boolean)|null} [isReusable=null] - Returns false
   *   for indices that must not be reused yet. When omitted, plain LIFO reuse.
   * @returns {number} - The allocated session index.
   */
  allocateSessionIndex(isReusable = null) {
    if (this.freedIndices.length > 0) {
      if (typeof isReusable !== 'function') {
        return this.freedIndices.pop();
      }
      // Scan newest-freed first so we keep LIFO behaviour among reusable indices.
      for (let i = this.freedIndices.length - 1; i >= 0; i--) {
        if (isReusable(this.freedIndices[i])) {
          return this.freedIndices.splice(i, 1)[0];
        }
      }
      // All freed indices still haunted → fall through and grow the space.
    }
    return this.nextSessionIndex++;
  }

  /**
   * Frees a session index for future reuse.
   * @param {number} index - The session index to free.
   */
  freeSessionIndex(index) {
    // Idempotent. A session can be retired from more than one place — a kick
    // retires it immediately and the socket's own 'close' arrives afterwards
    // with the same index, and the orphan sweep can race a close the same way.
    // Pushing twice puts one index in the pool twice, and it is then handed to
    // two different users, which is the sessionIndex collision the reuse
    // predicate in allocateSessionIndex exists to avoid.
    if (this.freedIndices.includes(index)) return;
    this.freedIndices.push(index);
  }

  /**
   * Creates and stores a new user record.
   * @param {number} sessionIndex - Assigned session index.
   * @param {string} [name=''] - User's display name.
   * @param {number} tool - Initial tool ID.
   * @param {number} color - Initial packed RGBA color.
   * @param {string} [ipHash=''] - Obfuscated IP hash.
   * @returns {Object} - The created user object.
   */
  createUser(sessionIndex, name = '', tool, color, ipHash = '') {
    const newUser = {
      sessionIndex,
      instanceId: crypto.randomBytes(4).toString('hex'),
      afk: false,
      cursorHidden: true,
      cursorLastActivity: 0,
      lastActivity: Date.now(),
      x: 0, y: 0, lastx: 0, lasty: 0,
      mousedown: false,
      tool,
      color,
      size: 1000,
      spacing: 10,
      smoothing: 15,
      hardness: 100,
      pressure: 100,
      blurRadius: 5,
      thinning: 51, // 0.5 with offset (50 + 1)
      simulatePressure: 2, // true with offset
      pressureTargets: 0, // unset = size only (shared/pressureTargets.js)
      name,
      registeredName: '',
      hasDiscord: false,
      isSupporter: false,
      text: '',
      imageBrush: null,
      patternBrush: null,
      confettiBrush: null,
      activeImage: null,           // { sx, sy, sw, sh, g } — active floating selection for sync replay
      activeSelectionCorners: null, // [tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y] — latest SEL_MOVE position
      activeSelectionSourceCrop: null, // [x, y, width, height] crop applied to activeImage source
      role: Role.GUEST,
      isMuted: false,
      isShadowBanned: false,
      isVPN: false,
      countryCode: '',
      ipHash,
      uploadBps: null,        // Measured upload throughput in bytes/sec (null = never measured)
      lastProbeTs: 0,         // Timestamp of last successful bandwidth probe
    };
    this.users.set(sessionIndex, newUser);
    return newUser;
  }

  /**
   * Retrieves user data by session index.
   * @param {number} sessionIndex - The session index.
   * @returns {Object|undefined} - The user object or undefined if not found.
   */
  getUser(sessionIndex) {
    return this.users.get(sessionIndex);
  }

  /**
   * Removes a user record from the manager.
   * @param {number} sessionIndex - The session index of the user to remove.
   */
  removeUser(sessionIndex) {
    this.users.delete(sessionIndex);
  }

  /**
   * Returns all users who have joined the room (i.e., have a name).
   * For discovery rooms, this always returns an empty list to prevent ghost users.
   * @returns {Array<Object>} - A list of joined user objects.
   */
  getJoinedUsers() {
    if (this.isDiscovery) return [];
    return Array.from(this.users.values()).filter(u => u.name);
  }

  /**
   * Returns the total number of users currently tracked.
   * @returns {number} - The user count.
   */
  getUserCount() {
    return this.users.size;
  }

  /**
   * Updates a user's activity timestamp.
   * @param {number} sessionIndex - The session index of the user.
   */
  updateUserActivity(sessionIndex) {
    const user = this.users.get(sessionIndex);
    if (user) {
      user.lastActivity = Date.now();
    }
  }

  /**
   * Marks a user active again, clearing their inactive state.
   * @param {number} sessionIndex - The session index of the user.
   */
  markUserActive(sessionIndex) {
    const user = this.users.get(sessionIndex);
    if (!user) return;

    const wasAfk = user.afk;
    user.lastActivity = Date.now();
    user.afk = false;

    if (wasAfk) {
      this._cancelStrokeCompression(sessionIndex);
      this.broadcastToAll({ t: T.AFK, u: sessionIndex, a: false });
    }
  }

  /**
   * Schedules a server-side broadcast to compress a user's active strokes after inactivity.
   * @param {number} sessionIndex
   * @private
   */
  _scheduleStrokeCompression(sessionIndex) {
    this._cancelStrokeCompression(sessionIndex);
    const timer = setTimeout(() => {
      this._compressTimers.delete(sessionIndex);
      const user = this.users.get(sessionIndex);
      if (user?.afk) {
        console.log(`[AFK] Broadcasting COMPRESS_USER_STROKES for user ${sessionIndex} (${user.name})`);
        this.broadcastToAll({ t: T.COMPRESS_USER_STROKES, u: sessionIndex });
      }
    }, COMPRESS_STROKES_DELAY);
    this._compressTimers.set(sessionIndex, timer);
  }

  /**
   * Cancels a pending stroke compression broadcast for a user.
   * @param {number} sessionIndex
   * @private
   */
  _cancelStrokeCompression(sessionIndex) {
    const existing = this._compressTimers.get(sessionIndex);
    if (existing) {
      clearTimeout(existing);
      this._compressTimers.delete(sessionIndex);
    }
  }

  /**
   * Periodically checks all users for AFK timeouts and broadcasts updates.
   */
  checkAfkUsers() {
    const now = Date.now();
    const joinedUsers = this.getJoinedUsers();

    // AFK_DEBUG=1 — why is (or isn't) a user going AFK? Prints each user's idle
    // age every check. An age that keeps resetting means something is touching
    // lastActivity; an age that grows past AFK_TIMEOUT without a mark means the
    // eligibility guard (name/lastActivity) is rejecting them.
    if (process.env.AFK_DEBUG && this.users.size) {
      const rows = [];
      this.users.forEach((u, idx) => {
        rows.push(`${idx}:${u.name || '<noname>'}`
          + `=${u.lastActivity ? Math.round((now - u.lastActivity) / 1000) + 's' : 'NEVER'}`
          + `${u.lastActivityType !== undefined ? `/t${u.lastActivityType}` : ''}`
          + `${u.afk ? ' AFK' : ''}`);
      });
      console.log(`[AFK_DEBUG]${this.isDiscovery ? ' [discovery]' : ''} idle ages: ${rows.join(' ')}`);
    }

    this.users.forEach((user, sessionIndex) => {
      if (!user.name) return;
      if (!user.afk && user.lastActivity && (now - user.lastActivity > AFK_TIMEOUT)) {
        user.afk = true;
        user.mousedown = false;
        this.broadcastToAll({ t: T.AFK, u: sessionIndex, a: true });
        // Name the scope: session indices are per-room, so a bare index cannot
        // be matched to a client. The discovery connection has its own indices
        // starting at 0 too, which makes an unqualified line actively misleading.
        console.log(`User ${sessionIndex} (${user.name || 'unnamed'}) marked as AFK`
          + `${this.isDiscovery ? ' [discovery]' : ''}`);
        this._scheduleStrokeCompression(sessionIndex);
      }
    });

    // Track when all joined users become AFK to trigger snapshot restore.
    // A mod/admin presence (immune user) blocks restore entirely — they're
    // the source of truth for canvas state, so wiping to a snapshot would
    // clobber their view. Restore only fires when every joined user is AFK
    // and none of them are immune (no mods to sync from).
    const anyImmune = joinedUsers.some(u => this.isUserImmuneToInactivity(u.sessionIndex, u));
    if (!anyImmune && joinedUsers.length > 0 && joinedUsers.every(u => u.afk)) {
      if (!this._allAfkSince) {
        this._allAfkSince = now;
        console.log(`[AFK] All users in room are AFK, will restore snapshot in ${ALL_AFK_RESTORE_DELAY / 1000}s`);
      } else if (this.onAllUsersAfk && (now - this._allAfkSince >= ALL_AFK_RESTORE_DELAY)) {
        this._allAfkSince = null;
        this.onAllUsersAfk();
      }
    } else {
      this._allAfkSince = null;
    }
  }

  /**
   * Cleans up resources, such as clearing the AFK check interval.
   */
  destroy() {
    if (this.afkCheckInterval) {
      clearInterval(this.afkCheckInterval);
    }
    for (const timer of this._compressTimers.values()) {
      clearTimeout(timer);
    }
    this._compressTimers.clear();
  }
}
