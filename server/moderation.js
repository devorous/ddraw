/** @fileoverview Provides utilities for moderation actions, including IP obfuscation, ban/mute checks, and logging. */

import { getDB } from './db.js';
import {
  obfuscateIp as obfuscateIpFromIdentity,
  fingerprintRangeKeys,
  fingerprintForScope,
  IP_SCOPE_SUBNET
} from './ipIdentity.js';
import { Role } from './SessionManager.js';

/**
 * Builds the per-target $or branches used when checking or revoking actions.
 * `targetIp` is expanded to HMAC fingerprints of every range the IP belongs to,
 * matching any stored ban whose `targetIpKeys` contains one of them. Legacy
 * rows that still carry a cleartext `targetIp` are matched by equality.
 */
function buildTargetConditions({
  targetUserId = null,
  targetIp = null,
  targetUsername = null,
  targetDeviceId = null,
  targetFingerprintId = null
} = {}) {
  const conditions = [];
  if (targetUserId) conditions.push({ targetUserId });
  if (targetIp) {
    const keys = fingerprintRangeKeys(targetIp);
    if (keys.length > 0) conditions.push({ targetIpKeys: { $in: keys } });
    conditions.push({ targetIp });
  }
  if (targetUsername) conditions.push({ targetUsername });
  if (targetDeviceId) conditions.push({ targetDeviceId });
  if (targetFingerprintId) conditions.push({ targetFingerprintId });
  return conditions;
}

function buildRoomCondition(roomId = null) {
  return roomId
    ? { $or: [{ roomId }, { roomId: null }] }
    : { roomId: null };
}

/**
 * Obfuscates an IP address for display to moderators.
 * Uses the IP identity system to ensure consistent obfuscation.
 *
 * MOD through OWNER get coarse masking, NOBLE/HOLY get one masked part,
 * and DEITY gets the canonical full IP.
 *
 * @param {string} ip - The IP address to obfuscate.
 * @param {number} [viewerRole] - Role of the viewer requesting display.
 * @returns {string} - The obfuscated IP address.
 */
export function obfuscateIp(ip, viewerRole) {
  return obfuscateIpFromIdentity(ip, viewerRole);
}

/**
 * Checks if a user is currently banned.
 * @param {string|null} userId - The unique ID of the user.
 * @param {string|null} ip - The IP address of the user.
 * @returns {Promise<Object|null>} - The ban entry if active, otherwise null.
 */
/**
 * @param {string|null} userId
 * @param {string|null} ip
 * @param {string|null} [roomId] - When set, matches room-scoped OR global bans.
 *                                  When null/omitted, matches only global bans.
 */
export async function checkBan(userId, ip, roomId = null) {
  const db = getDB();
  if (!db) return null;

  const conditions = buildTargetConditions({ targetUserId: userId, targetIp: ip });
  if (conditions.length === 0) return null;

  return db.collection('moderation').findOne({
    type: 'ban',
    active: true,
    $and: [
      { $or: conditions },
      buildRoomCondition(roomId)
    ]
  });
}

/**
 * Checks if a user is currently muted.
 * @param {string|null} userId - The unique ID of the user.
 * @param {string|null} ip - The IP address of the user.
 * @returns {Promise<Object|null>} - The mute entry if active, otherwise null.
 */
/**
 * @param {string|null} userId
 * @param {string|null} ip
 * @param {string|null} [roomId] - When set, matches room-scoped OR global mutes.
 */
export async function checkMute(userId, ip, roomId = null) {
  const db = getDB();
  if (!db) return null;

  const conditions = buildTargetConditions({ targetUserId: userId, targetIp: ip });
  if (conditions.length === 0) return null;

  return db.collection('moderation').findOne({
    type: 'mute',
    active: true,
    $and: [
      { $or: conditions },
      buildRoomCondition(roomId)
    ]
  });
}

/**
 * Checks if a user is currently silenced (chat-only mute).
 * @param {string|null} userId - The unique ID of the user.
 * @param {string|null} ip - The IP address of the user.
 * @param {string|null} [roomId] - When set, matches room-scoped OR global silences.
 * @returns {Promise<Object|null>} - The silence entry if active, otherwise null.
 */
export async function checkSilence(userId, ip, roomId = null) {
  const db = getDB();
  if (!db) return null;

  const conditions = buildTargetConditions({ targetUserId: userId, targetIp: ip });
  if (conditions.length === 0) return null;

  return db.collection('moderation').findOne({
    type: 'silence',
    active: true,
    $and: [
      { $or: conditions },
      buildRoomCondition(roomId)
    ]
  });
}

/**
 * @param {Object} opts
 * @param {string|null} [opts.userId]
 * @param {string|null} [opts.ip]
 * @param {string|null} [opts.deviceId]
 * @param {string|null} [opts.fingerprintId]
 * @param {string|null} [opts.roomId]
 * @returns {Promise<Object|null>}
 */
export async function checkShadowBan({
  userId = null,
  ip = null,
  deviceId = null,
  fingerprintId = null,
  roomId = null
} = {}) {
  const db = getDB();
  if (!db) return null;

  const conditions = buildTargetConditions({
    targetUserId: userId,
    targetIp: ip,
    targetDeviceId: deviceId,
    targetFingerprintId: fingerprintId
  });
  if (conditions.length === 0) return null;

  return db.collection('moderation').findOne({
    type: 'shadowban',
    active: true,
    $and: [
      { $or: conditions },
      buildRoomCondition(roomId)
    ]
  });
}

/**
 * Records a new moderation action in the database.
 *
 * IPs are never stored in cleartext. The caller passes the target's raw IP
 * plus an `ipScope` ('exact' | 'subnet' | 'wide'); we store only the HMAC
 * fingerprint of that range plus a masked display string.
 *
 * @param {Object} opts - Action options.
 * @param {string} opts.type - 'ban' | 'mute' | 'shadowban'
 * @param {string|null} opts.targetUserId
 * @param {string} opts.targetUsername
 * @param {string|null} opts.targetIp - Raw IP (used to derive HMAC; not stored).
 * @param {'exact'|'subnet'|'wide'} [opts.ipScope='subnet']
 * @param {string|null} [opts.targetDeviceId]
 * @param {string|null} [opts.targetFingerprintId]
 * @param {string} opts.reason
 * @param {string} opts.issuedBy
 * @param {string} opts.issuedByUsername
 * @param {number} [opts.issuedByRole=0] - Issuer's moderation authority at issue time (see
 *   getModerationAuthority in server/index.js). Stored so a later revoke/edit can be
 *   restricted to moderators who outrank (or match) whoever issued the action.
 * @param {number} opts.duration - Minutes (0 = permanent).
 * @param {string} [opts.roomId]
 * @returns {Promise<Object|null>}
 */
export async function issueModAction(opts) {
  const db = getDB();
  if (!db) return null;

  const now = new Date();
  const expiresAt = opts.duration > 0
    ? new Date(now.getTime() + opts.duration * 60 * 1000)
    : null;

  let targetIpKeys = null;
  let targetIpScope = null;
  let targetIpDisplay = null;
  if (opts.targetIp) {
    const scoped = fingerprintForScope(opts.targetIp, opts.ipScope || IP_SCOPE_SUBNET);
    if (scoped) {
      targetIpKeys = [scoped.fingerprint];
      targetIpScope = scoped.scope;
      targetIpDisplay = scoped.displayRange;
    }
  }

  const entry = {
    type: opts.type,
    targetUserId: opts.targetUserId || null,
    targetUsername: opts.targetUsername,
    targetIp: null,
    targetIpKeys,
    targetIpScope,
    targetIpDisplay,
    targetDeviceId: opts.targetDeviceId || null,
    targetFingerprintId: opts.targetFingerprintId || null,
    reason: opts.reason || '',
    issuedBy: opts.issuedBy,
    issuedByUsername: opts.issuedByUsername,
    issuedByRole: opts.issuedByRole || 0,
    roomId: opts.roomId || null,
    createdAt: now,
    expiresAt,
    duration: opts.duration || 0,
    active: true,
    revokedAt: null,
    revokedBy: null
  };

  const result = await db.collection('moderation').insertOne(entry);
  return { ...entry, _id: result.insertedId };
}

/**
 * Updates the reason on the most recent active mute or ban entry for a user.
 * @param {string|null} targetUserId
 * @param {string|null} targetIp
 * @param {'mute'|'ban'} type
 * @param {string} reason
 * @returns {Promise<boolean>}
 */
export async function updateModActionReason(targetUserId, targetIp, type, reason) {
  const db = getDB();
  if (!db) return false;

  const conditions = buildTargetConditions({ targetUserId, targetIp });
  if (conditions.length === 0) return false;

  const result = await db.collection('moderation').findOneAndUpdate(
    { type, active: true, $or: conditions },
    { $set: { reason } },
    { sort: { createdAt: -1 } }
  );
  return !!result;
}

/**
 * Fetches a single moderation entry by its DB id.
 * @param {string} actionId
 * @returns {Promise<Object|null>}
 */
export async function getModActionById(actionId) {
  const db = getDB();
  if (!db) return null;

  const { ObjectId } = await import('mongodb');
  let objectId;
  try {
    objectId = new ObjectId(actionId);
  } catch (_) {
    return null;
  }
  return db.collection('moderation').findOne({ _id: objectId });
}

/**
 * Revokes an existing moderation action.
 * @param {string} actionId - The ID of the moderation action to revoke.
 * @param {string} revokedById - The ID of the moderator revoking the action.
 * @returns {Promise<boolean>} - True if the action was successfully revoked.
 */
export async function revokeModAction(actionId, revokedById) {
  const db = getDB();
  if (!db) return false;

  const { ObjectId } = await import('mongodb');
  const result = await db.collection('moderation').updateOne(
    { _id: new ObjectId(actionId) },
    { $set: { active: false, revokedAt: new Date(), revokedBy: revokedById } }
  );

  return result.modifiedCount > 0;
}

/**
 * Updates the duration/expiry of an existing moderation action.
 * @param {string} actionId - The ID of the moderation action to update.
 * @param {number} durationMinutes - New duration in minutes (0 = permanent).
 * @param {string} updatedById - The ID of the moderator making the change.
 * @returns {Promise<boolean>} - True if the action was successfully updated.
 */
export async function updateModActionDuration(actionId, durationMinutes, updatedById) {
  const db = getDB();
  if (!db) return false;

  const { ObjectId } = await import('mongodb');
  const duration = Math.max(0, Number(durationMinutes) || 0);
  const expiresAt = duration > 0 ? new Date(Date.now() + duration * 60 * 1000) : null;

  const result = await db.collection('moderation').updateOne(
    { _id: new ObjectId(actionId) },
    { $set: { duration, expiresAt, durationUpdatedAt: new Date(), durationUpdatedBy: updatedById } }
  );

  return result.modifiedCount > 0;
}

/**
 * Revokes all active moderation actions matching the provided target filters.
 * @param {Object} opts
 * @param {'mute'|'ban'} opts.type
 * @param {string|null} [opts.targetUserId]
 * @param {string|null} [opts.targetIp]
 * @param {string|null} [opts.targetUsername]
 * @param {string|null} [opts.targetDeviceId]
 * @param {string|null} [opts.targetFingerprintId]
 * @param {string|null} [opts.roomId]
 * @param {string|null} [opts.revokedById]
 * @param {number} [opts.maxIssuedByRole] - When set, only revokes entries issued by a
 *   moderator whose authority was at or below this — a lower-ranked mod can never lift a
 *   higher-ranked mod's action just because both targeted the same user.
 * @returns {Promise<number>} - Number of actions revoked.
 */
export async function revokeMatchingModActions({
  type,
  targetUserId = null,
  targetIp = null,
  targetUsername = null,
  targetDeviceId = null,
  targetFingerprintId = null,
  roomId = null,
  revokedById = null,
  maxIssuedByRole = null
}) {
  const db = getDB();
  if (!db) return 0;

  const conditions = buildTargetConditions({
    targetUserId,
    targetIp,
    targetUsername,
    targetDeviceId,
    targetFingerprintId
  });
  if (conditions.length === 0) return 0;

  const query = {
    type,
    active: true,
    $and: [
      { $or: conditions },
      buildRoomCondition(roomId)
    ]
  };
  if (maxIssuedByRole !== null && maxIssuedByRole !== undefined) {
    // Rows predating this field carry no issuedByRole at all — treat those as
    // rank 0 (anyone may revoke) rather than silently excluding them.
    query.$and.push({ $or: [{ issuedByRole: { $lte: maxIssuedByRole } }, { issuedByRole: { $exists: false } }] });
  }

  const result = await db.collection('moderation').updateMany(
    query,
    {
      $set: {
        active: false,
        revokedAt: new Date(),
        revokedBy: revokedById
      }
    }
  );

  return result.modifiedCount || 0;
}

/**
 * Retrieves moderation entries with optional history and search filters.
 * @param {Object} [opts] - Filter options.
 * @param {boolean} [opts.showHistory=false] - Whether to include inactive entries.
 * @param {string} [opts.search=''] - A prefix to filter target usernames by.
 * @returns {Promise<Array<Object>>} - A list of moderation entries.
 */
/**
 * @param {Object} [opts]
 * @param {boolean} [opts.showHistory=false]
 * @param {string}  [opts.search='']
 * @param {string|null} [opts.roomId=null] - Filter to this room + global entries.
 */
export async function getModEntries({ showHistory = false, search = '', roomId = null, viewerRole = 0 } = {}) {
  const db = getDB();
  if (!db) return [];

  const query = {};
  if (!showHistory) {
    query.active = true;
  }
  if (search) {
    query.targetUsername = { $regex: `^${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' };
  }
  if (roomId) {
    query.$or = [{ roomId }, { roomId: null }];
  }
  // Shadowbans are only visible to HOLY+. Defense in depth — UI also hides them.
  if (viewerRole < Role.HOLY) {
    query.type = { $ne: 'shadowban' };
  }

  const entries = await db.collection('moderation')
    .find(query)
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();

  return entries.map(e => {
    // New rows store a masked display string (e.g. "2001:db8:abcd:1200::/64").
    // Legacy rows still carry a cleartext targetIp; obfuscate it by viewer role.
    const ipDisplay = e.targetIpDisplay
      ? e.targetIpDisplay
      : (e.targetIp ? obfuscateIp(e.targetIp, viewerRole) : '');

    return {
      id: e._id.toString(),
      type: e.type === 'ban' ? 0 : e.type === 'mute' ? 1 : e.type === 'shadowban' ? 2 : 3,
      username: e.targetUsername || '',
      reason: e.reason || '',
      ip: ipDisplay,
      ipScope: e.targetIpScope || null,
      issuedBy: e.issuedByUsername || '',
      issuedByRole: e.issuedByRole || 0,
      createdAt: e.createdAt ? e.createdAt.getTime() : 0,
      expiresAt: e.expiresAt ? e.expiresAt.getTime() : 0,
      active: e.active,
      roomId: e.roomId || null
    };
  });
}
