/** @fileoverview Main entry point for the WebSocket server, handling connections, message routing, and room management. */

import { WebSocketServer, WebSocket } from 'ws';
import { debug } from './debug.js';
import { createServer } from 'http';
import protobuf from 'protobufjs';
import { ObjectId } from 'mongodb';
import pathModule from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { connectDB, getDB, getMongoDatabase, updateUserMetrics, updateConsecutiveDays } from './db.js';
import { getIpSalt, validateProductionConfig } from './config.js';
import { metricsTracker } from './MetricsTracker.js';
import { handleGalleryList, handleGalleryUpload, handleGalleryAnimationUpload, handleGalleryAnimationDelete, handleGalleryItem, handleGalleryLike, handleGalleryFavorite, handleGalleryFavorites, handleGalleryLiked, handleGalleryFavoriteCheck, handleGalleryCommentsList, handleGalleryCommentCreate, handleGalleryCommentUpdate, handleGalleryCommentDelete, handleGalleryDelete, handleGallerySidebar, handleGalleryTagsUpdate, handleFloatingArtList, setFloatingArtBroadcaster, setGalleryDiscordPoster, setGalleryWallListener, handleGalleryLikedIds, handleFloatingWallList, handleWallMeta } from './gallery.js';
import { initDiscordBot, postGalleryItemToDiscord, setDiscordRoomManager } from './discordBot.js';
import { postReleaseUpdateToDiscord } from './discordBot.js';
import { handleAuthLogin, handleAuthRegister, handleAuthMe, handleAuthUsernameUpdate, handlePasswordResetRequest, handlePasswordResetComplete, handleEmailSet, handleEmailVerify, handleEmailDecline, handleDiscordConfig, handleDiscordOAuthStart, handleDiscordOAuthCallback, handleDiscordDdrawAccountLink } from './authRoutes.js';
import { handleUserProfile, handleUpdateProfile } from './userRoutes.js';
import { getGalleryPreviewItem, renderGalleryPreviewHtml } from './galleryPreview.js';
import { handleSnapshotSave, handleSnapshotList, handleSnapshotRestore, handleSnapshotDelete, handleSnapshotGet, handleSnapshotRegionRestore, handleFirstJoinerBase, handleStartStateGet, handleStartStateSet } from './snapshots.js';
import { getSnapshotFile } from './r2.js';
import { encodeSnapshotFile, decodeSnapshotFile } from './snapshotCodec.js';
import { handleCheckpointUpload, handleCheckpointList, handleCheckpointGet } from './checkpoints.js';
import { getRecorder, removeRecorder, getReplayData } from './deltaRecorder.js';
import { startElection, stopElection } from './uploaderElection.js';
import { handleProbeChunk, cancelProbesForSocket, startProbe as startBandwidthProbe } from './bandwidthProbe.js';
import { hashPassword, verifyPassword, generateToken, verifyToken } from './auth.js';
import { getUserFromToken } from './authUser.js';
import { isSupporterActive } from './supporter.js';
import { handleCreateCheckoutSession, handleCreatePortalSession, handleStripeWebhook, setSupporterChangeNotifier } from './stripeRoutes.js';
import { issueModAction, revokeModAction, revokeMatchingModActions, updateModActionReason, updateModActionDuration, getModActionById, getModEntries, obfuscateIp, checkBan, checkMute, checkSilence, checkShadowBan } from './moderation.js';
import { ENABLE_SERVER_REPLAY_DB } from './replayConfig.js';
import { T, Tool, ToolNames, ToolToEnum } from '../shared/MessageTypes.js';
import { isCommitType, COMMIT_KIND } from '../shared/StrokeFingerprint.js';
import { packColor, unpackColor } from '../shared/ColorUtils.js';
import { BOARD_SIZE_PRESETS, isValidBoardSize } from '../shared/boardSizes.js';
import {
  ENABLE_TILED_CANVAS_BACKING_STORE,
  roomTiledCanvasEnabled,
  roomTiledCanvasSettable
} from './tiledCanvasConfig.js';
import { SessionManager, Role, RoleNames } from './SessionManager.js';
import { SyncCoordinator } from './SyncCoordinator.js';
import { RoomManager } from './RoomManager.js';
import { sanitizeMessage, hasOwnField } from './validation.js';
import { writeJson, readRequestBody } from './httpUtils.js';
import { encryptMessageContent, decryptMessageContent } from './messageCrypto.js';
import { authorize, Action } from './permissions.js';
import { getRoomRole, setRoomRole, computeEffectiveRole, getRoomRoleRoster } from './roomRoles.js';
import {
  getClientIp, httpRateLimiter, isLocalhostRequest, messengerRateLimiter, wsRateLimiter,
  authLimiter, uploadLimiter, wsMessageLimiter, wsSyncMessageLimiter, wsConnectionLimiter, feedbackLimiter
} from './security.js';
import { getAsnCheckStatus, lookupAsnForIp, initAsnCheck, isVpnAsn } from './asnCheck.js';
import { lookupCountryForIp } from './geoCountry.js';
import { getUsernameValidationMessage, isValidUsername, normalizeUsername } from '../shared/identity.js';
import { normalizeBlendBakeMode } from '../shared/blendBakeMode.js';
import { getIpSubnet, mergeHistory, normalizeIdentityPayload, recordConnectionEvent } from './identityTracking.js';
import { generateFloatingGalleryVoronoi, getFloatingGalleryVoronoiJson } from './floatingVoronoi.js';
import { FloatingWall } from './floatingWall.js';
import { handleWipImage } from './wipArts.js';

const WS_REJECT_LOG_VALUE_LIMIT = 512;
const WS_REJECT_LOG_PAYLOAD_LIMIT = 2048;
const WS_REJECT_REDACT_KEYS = new Set(['a', 'authToken', 'token', 'password', 'currentPassword', 'newPassword']);

function summarizeRejectedMessage(data) {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(data, (key, value) => {
      if (WS_REJECT_REDACT_KEYS.has(key)) {
        return '[redacted]';
      }
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        return `[binary:${value.byteLength ?? value.length} bytes]`;
      }
      if (typeof value === 'string' && value.length > WS_REJECT_LOG_VALUE_LIMIT) {
        return `${value.slice(0, WS_REJECT_LOG_VALUE_LIMIT)}...[truncated:${value.length}]`;
      }
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      return value;
    });
    if (!json) return String(data);
    return json.length > WS_REJECT_LOG_PAYLOAD_LIMIT
      ? `${json.slice(0, WS_REJECT_LOG_PAYLOAD_LIMIT)}...[truncated:${json.length}]`
      : json;
  } catch (error) {
    return `[unserializable:${error?.message || error}]`;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);

const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const DISABLE_RATE_LIMITS = process.env.DISABLE_RATE_LIMITS === 'true';
const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = parsePositiveIntEnv('MAX_WS_BUFFERED_BYTES', 16 * 1024 * 1024);
const MAX_OUTBOX_BYTES = parsePositiveIntEnv('MAX_OUTBOX_BYTES', 4 * 1024 * 1024);
const MAX_OUTBOX_MESSAGES = parsePositiveIntEnv('MAX_OUTBOX_MESSAGES', 512);
const MESSENGER_QUERY_LIMIT = { max: 30, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const LEGACY_MESSENGER_DB_NAME = process.env.MONGODB_MESSENGER_DB_NAME || 'ddraw_messenger';
const WS_CONNECTION_LIMIT = { max: 60, windowMs: 60 * 1000, blockMs: 10 * 60 * 1000 };
const MESSENGER_CONNECTION_LIMIT = { max: 20, windowMs: 60 * 1000, blockMs: 10 * 60 * 1000 };
const MESSENGER_MESSAGE_LIMIT = { max: 120, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const WS_DRAW_LIMIT = { max: 12000, windowMs: 10 * 1000, blockMs: 15 * 1000 };
const WS_CHAT_LIMIT = { max: 20, windowMs: 10 * 1000, blockMs: 30 * 1000 };
const WS_CHAT_IMAGE_LIMIT = { max: 4, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const WS_HEAVY_IMAGE_LIMIT = { max: 180, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const WS_GLITCH_RESULT_LIMIT = { max: 360, windowMs: 60 * 1000, blockMs: 60 * 1000 };
const WS_AUTH_LIMIT = { max: 8, windowMs: 10 * 60 * 1000, blockMs: 15 * 60 * 1000 };
const WS_ADMIN_LIMIT = { max: 60, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const VALID_ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_ROOM_ID = 'lobby';
const ROOM_JOIN_POLICIES = new Set(['open', 'registered', 'trusted']);
const VALID_ROOM_BOARD_SIZES = new Set(Object.keys(BOARD_SIZE_PRESETS));
const ROOM_OVERLAY_SESSION_INDEX = 0xffffffff;
const CURSOR_IDLE_HIDE_MS = 5000;

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const ADMIN_COLLECTIONS = new Set([
  'users',
  'rooms',
  'moderation',
  'connection_events',
  'gallery',
  'favorites',
  'comments',
  'messages'
]);

const ADMIN_SORT_FIELDS = new Set([
  '_id',
  'username',
  'createdAt',
  'updatedAt',
  'lastActiveAt',
  'lastLoginAt',
  'timestamp',
  'submittedAt',
  'likesCount',
  'views',
  'role'
]);

// Per-collection field(s) the admin DB browser's search box matches against
// (case-insensitive regex, OR'd together). Collections with no plain-text
// identifying field (favorites, messages) are omitted — search is a no-op there.
const ADMIN_SEARCH_FIELDS = {
  users: ['username', 'email'],
  moderation: ['targetUsername', 'issuedByUsername'],
  rooms: ['ownerUsername'],
  gallery: ['author'],
  comments: ['author'],
  connection_events: ['username'],
};

const VERSION_JSON_PATH = pathModule.join(__dirname, '..', 'public', 'version.json');
const VERSION_POLICY_CACHE_MS = 5000;

let cachedVersionPolicy = null;
let cachedVersionPolicyAt = 0;
let versionPolicyPromise = null;

function parseSemver(versionStr) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(versionStr || ''));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  const aStable = a.prerelease === null;
  const bStable = b.prerelease === null;
  if (aStable && !bStable) return 1;
  if (!aStable && bStable) return -1;
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function isClientOutdated(clientVersion, minRequired) {
  const clientParsed = parseSemver(clientVersion);
  const minParsed = parseSemver(minRequired);
  if (!clientParsed || !minParsed) return false;
  return compareSemver(clientParsed, minParsed) < 0;
}

function isClientVersionMismatch(clientVersion, versionPolicy) {
  const latest = String(versionPolicy?.latest || '').trim();
  if (!latest) return false;
  const client = String(clientVersion || '').trim();
  if (!client) return true;
  return client !== latest;
}

async function readVersionPolicy({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedVersionPolicy && (now - cachedVersionPolicyAt) < VERSION_POLICY_CACHE_MS) {
    return cachedVersionPolicy;
  }
  if (!force && versionPolicyPromise) {
    return versionPolicyPromise;
  }

  versionPolicyPromise = (async () => {
    try {
      const fsp = await import('fs/promises');
      const parsed = JSON.parse(await fsp.readFile(VERSION_JSON_PATH, 'utf8'));
      cachedVersionPolicy = parsed;
      cachedVersionPolicyAt = Date.now();
      return parsed;
    } catch (error) {
      console.error('[Version] Failed to read policy:', error);
      return cachedVersionPolicy;
    } finally {
      versionPolicyPromise = null;
    }
  })();

  return versionPolicyPromise;
}

async function postReleaseUpdateOnce() {
  if (process.env.DISCORD_AUTO_POST_UPDATES !== 'true') return;

  const db = getDB();
  if (!db) return;

  const versionPolicy = await readVersionPolicy({ force: true });
  const version = String(versionPolicy?.latest || '').trim();
  if (!version) return;

  const existing = await db.collection('discord_release_posts').findOne({ version });
  if (existing) return;

  const posted = await postReleaseUpdateToDiscord(versionPolicy);
  if (!posted) return;

  await db.collection('discord_release_posts').insertOne({
    version,
    postedAt: new Date(),
    channelId: process.env.DISCORD_UPDATES_CHANNEL_ID || '',
  });
}

function getJoinPolicyMinRole(joinPolicy) {
  if (joinPolicy === 'trusted') return Role.TRUSTED;
  if (joinPolicy === 'registered') return Role.USER;
  return Role.GUEST;
}

function sanitizeRoomId(roomId) {
  const normalized = String(roomId || DEFAULT_ROOM_ID).trim();
  if (!VALID_ROOM_ID_RE.test(normalized)) {
    return DEFAULT_ROOM_ID;
  }
  // Legacy clients may still send "default"; normalize it to the real public lobby.
  return normalized === 'default' ? DEFAULT_ROOM_ID : normalized;
}

function rateLimitKey(prefix, ip, suffix = '') {
  return suffix ? `${prefix}:${ip}:${suffix}` : `${prefix}:${ip}`;
}

// Cosmetic badges a user may select for themselves. Keep in sync with the
// `selectable` entries in src/ui/Badges.js and SELECTABLE_BADGES in userRoutes.js.
const SELECTABLE_BADGES = new Set(['flock', 'pepper']);

function shouldAllowWsMessage(ws, data) {
  const ip = ws.clientIp || 'unknown';
  let config = WS_DRAW_LIMIT;
  let suffix = 'default';

  switch (data.t) {
    case T.MM:
    case T.MD:
    case T.MU:
    case T.CP:
    case T.CS:
    case T.CSP:
    case T.CSM:
    case T.CHD:
    case T.CBR:
    case T.CC:
    case T.CT:
    case T.CF:
    case T.CL:
    case T.CBM:
    case T.KP:
    case T.FILL:
    case T.TEXT_APPLY:
    case T.TEXT_REMOVE:
    case T.CSDM:
    case T.CPT:
      suffix = 'draw';
      config = WS_DRAW_LIMIT;
      break;

    case T.MSG:
    case T.DM:
    case T.CHAT_REACTION:
    case T.STAFF_MSG:
    case T.BOARD_SNAPSHOT_LIST_REQUEST:
    case T.BOARD_SNAPSHOT_GET:
      suffix = 'chat';
      config = WS_CHAT_LIMIT;
      break;

    case T.CHAT_IMG:
    case T.STAFF_CHAT_IMG:
      suffix = 'chatimg';
      config = WS_CHAT_IMAGE_LIMIT;
      break;

    case T.GLITCH_RESULT:
      suffix = 'glitch';
      config = WS_GLITCH_RESULT_LIMIT;
      break;

    case T.IMG_PASTE:
    case T.IMAGE_TOOL:
    case T.SEL_LIFT:
    case T.ROOM_PREVIEW:
    case T.BOARD_SNAPSHOT_SAVE:
    case T.BOARD_SNAPSHOT_RESTORE:
    case T.CHECKPOINT_UPLOAD:
      suffix = 'heavy';
      config = WS_HEAVY_IMAGE_LIMIT;
      break;

    case T.MOD_ACTION:
    case T.MOD_WIPE:
    case T.MOD_LIST:
    case T.ROOM_UPDATE:
    case T.ROOM_ROLE_SET:
    case T.ROOM_ROLE_LIST_REQUEST:
    case T.ROOM_REGISTER:
    case T.ROOM_UNREGISTER:
    case T.GLOBAL_ROLE_SET:
    case T.GLOBAL_MESSAGE:
    case T.BOARD_SNAPSHOT_DELETE:
    case T.ROOM_START_SNAPSHOT_GET:
    case T.ROOM_START_SNAPSHOT_SET:
    case T.CHECKPOINT_LIST:
    case T.CHECKPOINT_GET:
    case T.REPLAY_REQUEST:
    case T.SET_BADGE:
      suffix = 'admin';
      config = WS_ADMIN_LIMIT;
      break;
  }

  // AUTH_LOGIN / AUTH_REGISTER are rate-limited inside their dedicated handlers.
  // Avoid double-counting them here, which can disconnect the entire socket
  // before the auth flow has a chance to return a normal AUTH_RESULT error.
  if (data.t === T.AUTH_LOGIN || data.t === T.AUTH_REGISTER) {
    return true;
  }

  const limiterScope = suffix === 'auth' ? ip : (ws.rateLimitId || ip);
  return wsRateLimiter.consume(rateLimitKey('wsmsg', limiterScope, suffix), config).allowed;
}

function isValidMessengerRoomId(roomId, currentUserId, otherUserId) {
  if (!roomId || !currentUserId || !otherUserId) return false;
  const [a, b] = [String(currentUserId), String(otherUserId)].sort();
  return roomId === `${a}:${b}`;
}

function matchesMessengerIdentity(requestedIdentity, user) {
  const normalizedIdentity = normalizeUsername(requestedIdentity);
  return requestedIdentity === user._id.toString() || normalizedIdentity === user.username;
}

function getMessengerMessageCollections() {
  const primaryDb = getDB();
  if (!primaryDb) return [];

  const collections = [primaryDb.collection('messages')];
  const legacyDb = getMongoDatabase(LEGACY_MESSENGER_DB_NAME);
  if (legacyDb && legacyDb.databaseName !== primaryDb.databaseName) {
    collections.push(legacyDb.collection('messages'));
  }
  return collections;
}

function dedupeMessengerMessages(messages) {
  const seen = new Set();
  const deduped = [];
  for (const message of messages) {
    const key = [
      message.room_id || '',
      message.timestamp || 0,
      message.sender_id || '',
      message.receiver_id || '',
      message.encrypted_content || '',
      message.iv || ''
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(message);
  }
  return deduped;
}

/**
 * Maps a stored message doc to its client-facing form: replaces the at-rest
 * `encrypted_content`/`iv` with a decrypted plaintext `content` field.
 */
function decryptMessengerDoc(doc) {
  if (!doc) return doc;
  const { encrypted_content, iv, ...rest } = doc;
  const content = encrypted_content
    ? decryptMessageContent(encrypted_content, iv, doc.room_id)
    : '';
  return { ...rest, content: content == null ? '[Unable to decrypt]' : content };
}

async function getMessengerHistory(roomId, limit = 50) {
  const collections = getMessengerMessageCollections();
  const results = await Promise.all(collections.map(async (collection) => {
    try {
      return await collection
        .find({ room_id: roomId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
    } catch (err) {
      debug.warn('[Messenger] History query failed for one collection:', err.message);
      return [];
    }
  }));

  return dedupeMessengerMessages(results.flat())
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-limit)
    .map(decryptMessengerDoc);
}

async function getMessengerInbox(username) {
  const collections = getMessengerMessageCollections();
  const results = await Promise.all(collections.map(async (collection) => {
    try {
      return await collection.aggregate([
        { $match: { $or: [{ sender_id: username }, { receiver_id: username }] } },
        { $sort: { timestamp: -1 } },
        { $group: { _id: '$room_id', latestMessage: { $first: '$$ROOT' } } }
      ]).toArray();
    } catch (err) {
      debug.warn('[Messenger] Inbox query failed for one collection:', err.message);
      return [];
    }
  }));

  const latestByRoom = new Map();
  for (const row of results.flat()) {
    const message = row?.latestMessage;
    if (!message?.room_id) continue;
    const existing = latestByRoom.get(message.room_id);
    if (!existing || (message.timestamp || 0) > (existing.timestamp || 0)) {
      latestByRoom.set(message.room_id, message);
    }
  }

  return [...latestByRoom.values()]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .map(decryptMessengerDoc);
}

function json(res, status, payload) {
  writeJson(res, status, payload, { 'Access-Control-Allow-Origin': '*' });
}

function readBody(req, maxBytes = 65536) {
  return readRequestBody(req, maxBytes);
}

async function getAdminHttpUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return null;

  const decoded = verifyToken(token);
  if (!decoded?.userId || !ObjectId.isValid(decoded.userId)) return null;

  const db = getDB();
  if (!db) return null;

  const user = await db.collection('users').findOne(
    { _id: new ObjectId(decoded.userId) },
    { projection: { username: 1, role: 1 } }
  );
  if (!user || (user.role || 0) < Role.DEITY) return null;
  return user;
}

function sanitizeAdminDoc(doc) {
  if (!doc || typeof doc !== 'object') return doc;

  const seen = new WeakSet();
  const redactKeys = new Set([
    'passwordHash',
    'secretAnswerHash',
    'authToken',
    'encrypted_content',
    'iv',
    'ipHistory',
    'lastIp'
  ]);

  const walk = (value) => {
    if (value == null) return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      return `[binary ${value.length} bytes]`;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object') {
      if (typeof value.toHexString === 'function') return value.toHexString();
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      const out = {};
      for (const [key, nested] of Object.entries(value)) {
        out[key] = redactKeys.has(key) ? '[redacted]' : walk(nested);
      }
      return out;
    }
    return value;
  };

  return walk(doc);
}

function getLastWeekAchievementStats(users) {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 6);
  const startKey = start.toISOString().slice(0, 10);

  const totals = {
    distanceDrawn: 0,
    totalStrokes: 0,
    timeSpentMs: 0,
    chatMessagesSent: 0
  };
  const weekTotals = {
    distanceDrawn: 0,
    totalStrokes: 0,
    timeSpentMs: 0,
    chatMessagesSent: 0
  };
  const usersWithMetrics = [];
  const daily = new Map();

  for (let i = 0; i < 7; i += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    daily.set(day.toISOString().slice(0, 10), {
      date: day.toISOString().slice(0, 10),
      distanceDrawn: 0,
      totalStrokes: 0,
      timeSpentMs: 0,
      chatMessagesSent: 0
    });
  }

  for (const user of users) {
    const lifetime = {
      distanceDrawn: Math.max(0, Number(user.distanceDrawn) || 0),
      totalStrokes: Math.max(0, Number(user.totalStrokes) || 0),
      timeSpentMs: Math.max(0, Number(user.timeSpentMs) || 0),
      chatMessagesSent: Math.max(0, Number(user.chatMessagesSent) || 0)
    };
    const week = {
      distanceDrawn: 0,
      totalStrokes: 0,
      timeSpentMs: 0,
      chatMessagesSent: 0
    };

    totals.distanceDrawn += lifetime.distanceDrawn;
    totals.totalStrokes += lifetime.totalStrokes;
    totals.timeSpentMs += lifetime.timeSpentMs;
    totals.chatMessagesSent += lifetime.chatMessagesSent;

    for (const entry of Array.isArray(user.dailyMetrics) ? user.dailyMetrics : []) {
      const date = String(entry.date || '').slice(0, 10);
      if (date < startKey || !daily.has(date)) continue;

      const distanceDrawn = Math.max(0, Number(entry.distanceDrawn) || 0);
      const totalStrokes = Math.max(0, Number(entry.strokes) || 0);
      const timeSpentMs = Math.max(0, Number(entry.timeSpentMs) || 0);
      const chatMessagesSent = Math.max(0, Number(entry.chatMessages) || 0);
      const day = daily.get(date);

      day.distanceDrawn += distanceDrawn;
      day.totalStrokes += totalStrokes;
      day.timeSpentMs += timeSpentMs;
      day.chatMessagesSent += chatMessagesSent;
      week.distanceDrawn += distanceDrawn;
      week.totalStrokes += totalStrokes;
      week.timeSpentMs += timeSpentMs;
      week.chatMessagesSent += chatMessagesSent;
    }

    weekTotals.distanceDrawn += week.distanceDrawn;
    weekTotals.totalStrokes += week.totalStrokes;
    weekTotals.timeSpentMs += week.timeSpentMs;
    weekTotals.chatMessagesSent += week.chatMessagesSent;

    if (Object.values(lifetime).some(value => value > 0) || Object.values(week).some(value => value > 0)) {
      usersWithMetrics.push({
        username: user.username || 'Unknown',
        lifetime,
        week
      });
    }
  }

  function top(metric, period) {
    return usersWithMetrics
      .map(user => ({ username: user.username, value: user[period][metric] || 0 }))
      .filter(row => row.value > 0)
      .sort((a, b) => b.value - a.value || a.username.localeCompare(b.username))
      .slice(0, 8);
  }

  return {
    totals,
    weekTotals,
    daily: [...daily.values()],
    top: {
      lifetime: {
        distanceDrawn: top('distanceDrawn', 'lifetime'),
        totalStrokes: top('totalStrokes', 'lifetime'),
        timeSpentMs: top('timeSpentMs', 'lifetime'),
        chatMessagesSent: top('chatMessagesSent', 'lifetime')
      },
      week: {
        distanceDrawn: top('distanceDrawn', 'week'),
        totalStrokes: top('totalStrokes', 'week'),
        timeSpentMs: top('timeSpentMs', 'week'),
        chatMessagesSent: top('chatMessagesSent', 'week')
      }
    }
  };
}

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Rate limit helper
  const clientIp = getClientIp(req);
  function rateLimited(limiter) {
    if (DISABLE_RATE_LIMITS) return false;
    if (!limiter.check(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many requests, please try again later' }));
      return true;
    }
    return false;
  }

  if (path === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  if (path === '/api/version' && req.method === 'GET') {
    try {
      const versionPolicy = await readVersionPolicy();
      if (!versionPolicy) {
        json(res, 503, { error: 'Version policy unavailable' });
        return;
      }
      json(res, 200, versionPolicy);
      return;
    } catch (error) {
      console.error('[Version] Failed to read version policy:', error);
      json(res, 500, { error: 'Failed to read version' });
      return;
    }
  }

  const galleryPageMatch = path.match(/^\/gallery\/([a-f0-9]{24})$/);
  if (galleryPageMatch && req.method === 'GET') {
    const db = getDB();
    if (!db) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Database not available');
      return;
    }

    try {
      const item = await getGalleryPreviewItem(db, galleryPageMatch[1]);
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Gallery image not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      });
      res.end(renderGalleryPreviewHtml(item, req));
    } catch (err) {
      console.error('[GalleryPreview] Render error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Failed to render gallery preview');
    }
    return;
  }

  if (path === '/api/gallery/sidebar' && req.method === 'GET') {
    await handleGallerySidebar(req, res);
    return;
  }

  if (path === '/api/gallery/floating' && req.method === 'GET') {
    await handleFloatingArtList(req, res);
    return;
  }

  if (path === '/api/gallery/floating-wall' && req.method === 'GET') {
    await handleFloatingWallList(req, res);
    return;
  }

  if (path === '/api/gallery/wall-meta' && req.method === 'GET') {
    await handleWallMeta(req, res);
    return;
  }

  if (path === '/api/gallery' && req.method === 'GET') {
    await handleGalleryList(req, res);
    return;
  }

  if (path === '/api/gallery/upload' && req.method === 'POST') {
    if (rateLimited(uploadLimiter)) return;
    await handleGalleryUpload(req, res);
    return;
  }

  const likeMatch = path.match(/^\/api\/gallery\/([a-f0-9]{24})\/like$/);
  if (likeMatch && req.method === 'POST') {
    await handleGalleryLike(req, res, likeMatch[1]);
    return;
  }

  // Attach/replace or detach a gallery item's time-lapse (author or HOLY+).
  const animationMatch = path.match(/^\/api\/gallery\/([a-f0-9]{24})\/animation$/);
  if (animationMatch && req.method === 'POST') {
    if (rateLimited(uploadLimiter)) return;
    await handleGalleryAnimationUpload(req, res, animationMatch[1]);
    return;
  }
  if (animationMatch && req.method === 'DELETE') {
    await handleGalleryAnimationDelete(req, res, animationMatch[1]);
    return;
  }

  // Single item route (must be after more specific routes)
  const itemMatch = path.match(/^\/api\/gallery\/([a-f0-9]{24})$/);
  if (itemMatch && req.method === 'GET') {
    await handleGalleryItem(req, res, itemMatch[1]);
    return;
  }
  if (itemMatch && req.method === 'DELETE') {
    await handleGalleryDelete(req, res, itemMatch[1]);
    return;
  }
  if (itemMatch && req.method === 'PATCH') {
    await handleGalleryTagsUpdate(req, res, itemMatch[1]);
    return;
  }

  // Favorites routes
  if (path === '/api/gallery/favorites' && req.method === 'GET') {
    await handleGalleryFavorites(req, res);
    return;
  }

  const wipImageMatch = path.match(/^\/api\/wip\/([a-f0-9]{24})$/);
  if (wipImageMatch && req.method === 'GET') {
    await handleWipImage(req, res, wipImageMatch[1]);
    return;
  }

  if (path === '/api/gallery/liked-ids' && req.method === 'GET') {
    await handleGalleryLikedIds(req, res);
    return;
  }

  if (path === '/api/gallery/liked' && req.method === 'GET') {
    await handleGalleryLiked(req, res);
    return;
  }

  const favMatch = path.match(/^\/api\/gallery\/([a-f0-9]{24})\/favorite$/);
  if (favMatch && req.method === 'POST') {
    await handleGalleryFavorite(req, res, favMatch[1]);
    return;
  }
  if (favMatch && req.method === 'GET') {
    await handleGalleryFavoriteCheck(req, res, favMatch[1]);
    return;
  }

  // Comment routes
  const commentsMatch = path.match(/^\/api\/gallery\/([a-f0-9]{24})\/comments$/);
  if (commentsMatch && req.method === 'GET') {
    await handleGalleryCommentsList(req, res, commentsMatch[1]);
    return;
  }
  if (commentsMatch && req.method === 'POST') {
    await handleGalleryCommentCreate(req, res, commentsMatch[1]);
    return;
  }

  const commentDeleteMatch = path.match(/^\/api\/gallery\/comments\/([a-f0-9]{24})$/);
  if (commentDeleteMatch && req.method === 'DELETE') {
    await handleGalleryCommentDelete(req, res, commentDeleteMatch[1]);
    return;
  }
  if (commentDeleteMatch && req.method === 'PATCH') {
    await handleGalleryCommentUpdate(req, res, commentDeleteMatch[1]);
    return;
  }

  if (path === '/api/discord/release-update' && req.method === 'POST') {
    const expectedSecret = process.env.DISCORD_UPDATE_SECRET;
    const providedSecret = req.headers['x-discord-update-secret'];
    if (!expectedSecret || providedSecret !== expectedSecret) {
      json(res, 403, { error: 'Forbidden' });
      return;
    }

    try {
      const versionPolicy = await readVersionPolicy({ force: true });
      if (!versionPolicy) {
        json(res, 503, { error: 'Version policy unavailable' });
        return;
      }
      const posted = await postReleaseUpdateToDiscord(versionPolicy);
      json(res, posted ? 200 : 503, { posted });
    } catch (error) {
      console.error('[Discord] Failed to post release update:', error);
      json(res, 500, { error: 'Failed to post release update' });
    }
    return;
  }

  // Auth routes (HTTP for gallery/non-WebSocket clients)
  if (path === '/api/discord/config' && req.method === 'GET') {
    await handleDiscordConfig(req, res);
    return;
  }

  if (path === '/api/auth/login' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleAuthLogin(req, res);
    return;
  }

  if (path === '/api/auth/discord/start' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleDiscordOAuthStart(req, res);
    return;
  }

  if (path === '/api/auth/discord/callback' && req.method === 'GET') {
    await handleDiscordOAuthCallback(req, res);
    return;
  }

  if (path === '/api/auth/discord/link-ddraw' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleDiscordDdrawAccountLink(req, res);
    return;
  }

  if (path === '/api/auth/register' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleAuthRegister(req, res);
    return;
  }

  if (path === '/api/auth/me' && req.method === 'GET') {
    await handleAuthMe(req, res);
    return;
  }

  if (path === '/api/auth/username' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleAuthUsernameUpdate(req, res);
    return;
  }

  if (path === '/api/auth/password-reset/request' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handlePasswordResetRequest(req, res);
    return;
  }

  if (path === '/api/auth/password-reset/complete' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handlePasswordResetComplete(req, res);
    return;
  }

  if (path === '/api/auth/email/set' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleEmailSet(req, res);
    return;
  }

  if (path === '/api/auth/email/verify' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleEmailVerify(req, res);
    return;
  }

  if (path === '/api/auth/email/decline' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleEmailDecline(req, res);
    return;
  }

  if (path === '/api/feedback' && req.method === 'POST') {
    if (rateLimited(feedbackLimiter)) return;

    let body;
    try {
      const raw = await readBody(req, 8192);
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: 'Invalid request body' });
      return;
    }

    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const page = body?.page === 'landing' ? 'landing' : 'app';

    if (text.length < 1 || text.length > 2000) {
      json(res, 422, { error: 'Feedback must be between 1 and 2000 characters.' });
      return;
    }

    const db = getDB();
    if (!db) {
      json(res, 503, { error: 'Database unavailable' });
      return;
    }

    try {
      await db.collection('feedback').insertOne({
        text,
        page,
        submittedAt: new Date(),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
      });
      json(res, 201, { ok: true });
    } catch (err) {
      console.error('[Feedback] Insert error:', err);
      json(res, 500, { error: 'Failed to save feedback' });
    }
    return;
  }

  // User profile update (self only)
  if (path === '/api/users/me/profile' && req.method === 'PATCH') {
    await handleUpdateProfile(req, res);
    return;
  }

  // Stripe supporter subscriptions
  if (path === '/api/stripe/create-checkout-session' && req.method === 'POST') {
    await handleCreateCheckoutSession(req, res);
    return;
  }
  if (path === '/api/stripe/create-portal-session' && req.method === 'POST') {
    await handleCreatePortalSession(req, res);
    return;
  }
  if (path === '/api/stripe/webhook' && req.method === 'POST') {
    await handleStripeWebhook(req, res);
    return;
  }

  // User profile route
  const userMatch = path.match(/^\/api\/users\/([a-zA-Z0-9_-]+)$/);
  if (userMatch && req.method === 'GET') {
    await handleUserProfile(req, res, userMatch[1]);
    return;
  }

  // Messenger: check if a username exists
  if (path === '/api/messenger/check-user' && req.method === 'GET') {
    const clientIp = getClientIp(req);
    const lookupLimit = httpRateLimiter.consume(rateLimitKey('messenger:lookup', clientIp), MESSENGER_QUERY_LIMIT);
    const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (!lookupLimit.allowed) {
      res.writeHead(429, corsHeaders);
      res.end(JSON.stringify({ exists: false, error: 'Too many lookup requests' }));
      return;
    }

    const username = new URL(req.url, `http://${req.headers.host}`).searchParams.get('username');
    if (!username) { res.writeHead(400, corsHeaders); res.end(JSON.stringify({ exists: false })); return; }
    try {
      const db = getDB();
      const user = await db.collection('users').findOne(
        { username: String(username).trim() },
        { projection: { username: 1 }, collation: { locale: 'en', strength: 2 } }
      );
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ exists: !!user, username: user?.username || null }));
    } catch { res.writeHead(500, corsHeaders); res.end(JSON.stringify({ exists: false })); }
    return;
  }

  if (path === '/api/admin/stats' && req.method === 'GET') {
    const adminUser = await getAdminHttpUser(req);
    if (!adminUser) {
      json(res, 403, { error: 'Forbidden' });
      return;
    }

    const db = getDB();
    const activeRooms = roomManager
      ? [...roomManager.rooms.values()].filter(room => room.id !== '_discovery' && room.getClientCount() > 0)
      : [];

    const rooms = activeRooms
      .map(room => ({
        id: room.id,
        userCount: room.getClientCount(),
        ownerUsername: room.ownerUsername || '',
        locked: !!room.settings?.locked
      }))
      .sort((a, b) => b.userCount - a.userCount || a.id.localeCompare(b.id));

    const achievementUsers = db ? await db.collection('users').find({}, {
      projection: {
        username: 1,
        distanceDrawn: 1,
        totalStrokes: 1,
        timeSpentMs: 1,
        chatMessagesSent: 1,
        dailyMetrics: 1
      }
    }).toArray() : [];

    json(res, 200, {
      activeUsers: rooms.reduce((sum, room) => sum + room.userCount, 0),
      activeRooms: rooms.length,
      registeredUsers: db ? achievementUsers.length : 0,
      dbAvailable: !!db,
      achievements: getLastWeekAchievementStats(achievementUsers),
      rooms
    });
    return;
  }

  if (path === '/api/admin/live' && req.method === 'GET') {
    const adminUser = await getAdminHttpUser(req);
    if (!adminUser) {
      json(res, 403, { error: 'Forbidden' });
      return;
    }

    const activeRooms = roomManager
      ? [...roomManager.rooms.values()].filter(r => r.id !== '_discovery' && r.getClientCount() > 0)
      : [];

    const db = getDB();
    const rooms = await Promise.all(activeRooms.map(async room => {
      const candidates = (room._electionCandidates || []).map(c => ({
        username: c.username,
        ping: c.ping != null ? Math.round(c.ping) : null,
        lowPower: c.lowPower,
        hidden: !!c.hidden,
        active: c.active,
        uploadBps: c.uploadBps != null ? Math.round(c.uploadBps) : null,
        lastProbeTs: c.lastProbeTs || null,
        score: Math.round(c.score * 10) / 10
      }));

      // In-memory snapshot buffer stats
      const snaps = room.snapshots || [];
      const snapshotInfo = {
        buffered: snaps.length,
        oldest: snaps.length ? snaps[0].ts : null,
        newest: snaps.length ? snaps[snaps.length - 1].ts : null,
        lastCheckpointTs: room._lastCheckpointTs || null
      };

      // DB checkpoint count (lightweight)
      let dbCheckpoints = 0;
      if (ENABLE_SERVER_REPLAY_DB && db) {
        try {
          dbCheckpoints = await db.collection('checkpoints').countDocuments({ roomId: room.id });
        } catch (_) {}
      }

      return {
        id: room.id,
        userCount: room.getClientCount(),
        dedicatedUploader: room.settings.dedicatedReplayUser || null,
        electedUploader: room._electedUploader || null,
        candidates,
        snapshots: snapshotInfo,
        dbCheckpoints
      };
    }));

    json(res, 200, {
      rooms,
      backpressure: getBackpressureSnapshot()
    });
    return;
  }

  const adminCollectionMatch = path.match(/^\/api\/admin\/collections\/([a-zA-Z0-9_-]+)$/);
  if (adminCollectionMatch && req.method === 'GET') {
    const adminUser = await getAdminHttpUser(req);
    if (!adminUser) {
      json(res, 403, { error: 'Forbidden' });
      return;
    }

    const collectionName = adminCollectionMatch[1];
    if (!ADMIN_COLLECTIONS.has(collectionName)) {
      json(res, 404, { error: 'Collection not available' });
      return;
    }

    const db = getDB();
    if (!db) {
      json(res, 503, { error: 'Database unavailable' });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const requestedLimit = Number(url.searchParams.get('limit'));
    const requestedSkip = Number(url.searchParams.get('skip'));
    const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 25));
    const skip = Math.max(0, Math.min(100000, Number.isFinite(requestedSkip) ? requestedSkip : 0));
    const requestedSortBy = String(url.searchParams.get('sortBy') || '_id');
    const sortBy = ADMIN_SORT_FIELDS.has(requestedSortBy) ? requestedSortBy : '_id';
    const sortDir = String(url.searchParams.get('sortDir') || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const search = String(url.searchParams.get('search') || '').trim().slice(0, 100);

    const filter = {};
    const searchFields = ADMIN_SEARCH_FIELDS[collectionName];
    if (search && searchFields?.length) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = searchFields.map(field => ({ [field]: { $regex: escaped, $options: 'i' } }));
    }

    const collection = db.collection(collectionName);
    const [rawDocuments, total] = await Promise.all([
      collection.find(filter).sort({ [sortBy]: sortDir, _id: sortDir }).skip(skip).limit(limit).toArray(),
      collection.countDocuments(filter)
    ]);

    // Moderation rows only store raw ids; surface whether the mod/target were
    // logged-in accounts (vs. guests identified by IP/device) for the panel.
    const documents = collectionName === 'moderation'
      ? rawDocuments.map(doc => ({
        ...doc,
        issuedByRegistered: !!doc.issuedBy,
        targetRegistered: !!doc.targetUserId,
      }))
      : rawDocuments;

    json(res, 200, {
      collection: collectionName,
      total,
      limit,
      skip,
      sortBy,
      sortDir: sortDir === 1 ? 'asc' : 'desc',
      search,
      documents: documents.map(sanitizeAdminDoc)
    });
    return;
  }

  // Flags an account for password reset: clears its password hash and marks it
  // `isReset` so the owner can reclaim the same username through the normal
  // register form (see handleAuthRegister) without losing their gallery items,
  // badges, or achievement stats, which stay attached to the same _id.
  const adminUserResetMatch = path.match(/^\/api\/admin\/users\/([a-fA-F0-9]{24})\/reset$/);
  if (adminUserResetMatch && req.method === 'POST') {
    const adminUser = await getAdminHttpUser(req);
    if (!adminUser) {
      json(res, 403, { error: 'Forbidden' });
      return;
    }

    const db = getDB();
    if (!db) {
      json(res, 503, { error: 'Database unavailable' });
      return;
    }

    try {
      const result = await db.collection('users').findOneAndUpdate(
        { _id: new ObjectId(adminUserResetMatch[1]) },
        {
          $set: {
            passwordHash: null,
            isReset: true,
            resetAt: new Date(),
            resetBy: adminUser.username,
          }
        },
        { returnDocument: 'after', projection: { username: 1 } }
      );

      if (!result) {
        json(res, 404, { error: 'User not found' });
        return;
      }

      json(res, 200, { success: true, username: result.username });
    } catch (err) {
      console.error('[Admin] Account reset failed:', err);
      json(res, 500, { error: 'Reset failed' });
    }
    return;
  }

  // --- Admin checkpoint history (docs/ddraw_server_snapshots_plan.md Phase 3) ---
  // Cross-room, read-only browsing of the server-persisted `.ddraw` checkpoints
  // in room_snapshots + R2. DEITY-gated like every other /api/admin route; no
  // restore/delete path lives here on purpose.

  if (path === '/api/admin/snapshots/rooms' && req.method === 'GET') {
    if (!await getAdminHttpUser(req)) { json(res, 403, { error: 'Forbidden' }); return; }

    const db = getDB();
    if (!db) { json(res, 503, { error: 'Database unavailable' }); return; }

    try {
      const rooms = await db.collection('room_snapshots').aggregate([
        {
          $group: {
            _id: '$roomId',
            count: { $sum: 1 },
            newest: { $max: '$timestamp' },
            oldest: { $min: '$timestamp' },
            autoCount: { $sum: { $cond: ['$auto', 1, 0] } }
          }
        },
        { $sort: { newest: -1 } },
        { $limit: 500 }
      ]).toArray();

      json(res, 200, {
        rooms: rooms.map(r => ({
          roomId: r._id || '',
          count: r.count || 0,
          newest: r.newest || null,
          oldest: r.oldest || null,
          autoCount: r.autoCount || 0,
          manualCount: Math.max(0, (r.count || 0) - (r.autoCount || 0))
        }))
      });
    } catch (err) {
      console.error('[Admin/Snapshots] Room list failed:', err);
      json(res, 500, { error: 'Failed to list snapshot rooms' });
    }
    return;
  }

  if (path === '/api/admin/snapshots' && req.method === 'GET') {
    if (!await getAdminHttpUser(req)) { json(res, 403, { error: 'Forbidden' }); return; }

    const db = getDB();
    if (!db) { json(res, 503, { error: 'Database unavailable' }); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomId = String(url.searchParams.get('roomId') || '').trim();
    if (!roomId) { json(res, 400, { error: 'roomId is required' }); return; }

    const requestedLimit = Number(url.searchParams.get('limit'));
    const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 50));
    const before = Number(url.searchParams.get('before'));

    try {
      const filter = { roomId };
      if (Number.isFinite(before) && before > 0) filter.timestamp = { $lt: before };

      const [docs, total] = await Promise.all([
        db.collection('room_snapshots')
          .find(filter)
          .sort({ timestamp: -1 })
          .limit(limit)
          .toArray(),
        db.collection('room_snapshots').countDocuments({ roomId })
      ]);

      const snapshots = docs.map(doc => {
        const thumbBytes = doc.thumbnail ? (doc.thumbnail.buffer || doc.thumbnail) : null;
        return {
          id: doc.snapshotId,
          roomId: doc.roomId,
          ts: doc.timestamp || 0,
          issuer: doc.issuer || 'Unknown',
          auto: !!doc.auto,
          initial: !!doc.initial,
          seq: doc.seq ?? null,
          name: doc.name || '',
          // Stored container format. Absent/'bundle' = pre-migration protobuf;
          // the /file route transcodes those to `.ddraw` before serving.
          format: doc.format || 'bundle',
          hasFile: !!doc.r2Key,
          r2Key: doc.r2Key || '',
          // Inlined so the strip renders without touching R2 at all (the JPEG
          // is already in the Mongo doc — a separate route would just be an
          // extra round trip per row).
          thumb: thumbBytes ? Buffer.from(thumbBytes).toString('base64') : null
        };
      });

      json(res, 200, {
        roomId,
        total,
        limit,
        snapshots,
        nextBefore: snapshots.length === limit ? snapshots[snapshots.length - 1].ts : null
      });
    } catch (err) {
      console.error('[Admin/Snapshots] List failed:', err);
      json(res, 500, { error: 'Failed to list snapshots' });
    }
    return;
  }

  const adminSnapshotFileMatch = path.match(/^\/api\/admin\/snapshots\/([A-Za-z0-9_.-]+)\/file$/);
  if (adminSnapshotFileMatch && req.method === 'GET') {
    if (!await getAdminHttpUser(req)) { json(res, 403, { error: 'Forbidden' }); return; }

    const db = getDB();
    if (!db) { json(res, 503, { error: 'Database unavailable' }); return; }

    const snapshotId = adminSnapshotFileMatch[1];
    try {
      const doc = await db.collection('room_snapshots').findOne({ snapshotId });
      if (!doc) { json(res, 404, { error: 'Snapshot not found' }); return; }
      if (!doc.r2Key) { json(res, 404, { error: 'Snapshot has no stored file' }); return; }

      const bytes = await getSnapshotFile(doc.r2Key);
      if (!bytes) { json(res, 404, { error: 'Snapshot file missing from storage' }); return; }

      const sourceFormat = doc.format || 'bundle';
      let out = bytes;
      if (sourceFormat !== 'ddraw') {
        // Legacy protobuf `.bundle`. Decode + repack as a degenerate `.ddraw`
        // so the client only ever has to understand one container.
        const { layers, thumbnail } = await decodeSnapshotFile(bytes, doc.format);
        // protobufjs hands back Node Buffers, and JSON.stringify calls
        // Buffer#toJSON before ddrawCodec's Uint8Array replacer ever sees the
        // value — the layers would serialize as {type:'Buffer',data:[...]} and
        // decode client-side as unusable objects. Re-wrap as plain Uint8Array.
        const plainLayers = (layers || []).map(
          (l) => (l && l.length ? new Uint8Array(l.buffer ? l.buffer.slice(l.byteOffset, l.byteOffset + l.byteLength) : l) : null)
        );
        out = await encodeSnapshotFile(plainLayers, thumbnail || null, {
          issuer: doc.issuer || null,
          roomId: doc.roomId || null,
          ts: doc.timestamp || null,
        });
      }

      res.writeHead(200, {
        'Content-Type': 'application/x-ddraw-replay',
        'Content-Length': out.length,
        'Cache-Control': 'private, max-age=300',
        'X-Snapshot-Format': 'ddraw',
        'X-Snapshot-Source-Format': sourceFormat,
        'X-Snapshot-Room': encodeURIComponent(doc.roomId || ''),
        'X-Snapshot-Ts': String(doc.timestamp || 0),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Snapshot-Format, X-Snapshot-Source-Format, X-Snapshot-Room, X-Snapshot-Ts'
      });
      res.end(Buffer.from(out));
    } catch (err) {
      console.error('[Admin/Snapshots] File fetch failed:', err);
      json(res, 500, { error: 'Failed to fetch snapshot file' });
    }
    return;
  }

  // Static file serving with SPA fallback
  const distDir = pathModule.resolve(__dirname, '..', 'dist');
  let filePath = pathModule.resolve(distDir, pathModule.join('.', path));

  // Prevent path traversal
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end();
    return;
  }

  // SPA fallback: if path is /go/* without a dot, serve /go/index.html
  if (path.startsWith('/go/') && !path.includes('.')) {
    filePath = pathModule.resolve(distDir, 'go', 'index.html');
  }

  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = pathModule.join(filePath, 'index.html');
    }

    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath);
        const ext = pathModule.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.webp': 'image/webp',
          '.wasm': 'application/wasm',
          '.ttf': 'font/ttf',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return;
      } catch (err) {
        console.error('[Static] Read error:', err);
        res.writeHead(500);
        res.end();
        return;
      }
    }
  }

  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end();
});

server.on('error', (err) => {
  console.error('[HTTP Server] Error:', err);
});

const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD_BYTES });

wss.on('error', (err) => {
  console.error('[WebSocket Server] Error:', err);
});

let Msg;
let roomManager;
let onlineUsersLogInterval;
let isShuttingDown = false;

// Messenger: username -> WebSocket
const messengerClients = new Map();

/**
 * Generates an obfuscated hash from an IP address.
 * @param {string} ip - The IP address.
 * @returns {string} - The obfuscated hash.
 */
function getIpHash(ip) {
  const salt = getIpSalt();
  return crypto.createHash('sha256').update(ip + salt).digest('hex').substring(0, 12);
}

/**
 * Maps user objects to a format suitable for the USERS broadcast.
 * @param {Array<Object>} users - The list of user objects.
 * @returns {Array<Object>} - The mapped user objects.
 */
function getRoomClientBySessionIndex(room, sessionIndex) {
  if (!room || sessionIndex === undefined || sessionIndex === null) return null;

  for (const client of room.clients) {
    if (client.sessionIndex === sessionIndex) {
      return client;
    }
  }

  return null;
}

function isSessionPendingDisconnect(room, sessionIndex) {
  if (!room?.pendingDisconnects?.size) return false;
  const numericSessionIndex = Number(sessionIndex);
  if (!Number.isFinite(numericSessionIndex)) return false;

  for (const entry of room.pendingDisconnects.values()) {
    if (Number(entry?.sessionIndex) === numericSessionIndex) {
      return true;
    }
  }

  return false;
}

function getVisibleJoinedUsers(room) {
  if (!room) return [];
  return room.sessionManager
    .getJoinedUsers()
    .filter((user) => !isSessionPendingDisconnect(room, user.sessionIndex));
}

function getUniqueVisibleName(room, name, excludeSessionIndex = null) {
  const baseName = name || '';
  if (!baseName) return '';

  const joinedUsers = getVisibleJoinedUsers(room);
  let uniqueName = baseName;
  let suffix = 1;

  const isNameTaken = (candidate) => joinedUsers.some((user) =>
    user.sessionIndex !== excludeSessionIndex &&
    String(user.name || '').toLowerCase() === candidate.toLowerCase()
  );

  while (isNameTaken(uniqueName)) {
    uniqueName = `${baseName}-${suffix}`;
    suffix++;
  }

  return uniqueName;
}

function hasOpenClientForSession(room, sessionIndex) {
  if (!room || sessionIndex === undefined || sessionIndex === null) return false;
  const numericSessionIndex = Number(sessionIndex);

  for (const client of room.clients) {
    if (Number(client.sessionIndex) === numericSessionIndex && client.readyState === WebSocket.OPEN) {
      return true;
    }
  }

  return false;
}

function clearPendingDisconnectsForSession(room, sessionIndex) {
  if (!room?.pendingDisconnects?.size) return;
  const numericSessionIndex = Number(sessionIndex);

  for (const [resumeKey, entry] of room.pendingDisconnects) {
    if (Number(entry?.sessionIndex) !== numericSessionIndex) continue;
    clearTimeout(entry.timer);
    room.pendingDisconnects.delete(resumeKey);
  }
}

function canViewerSeeTargetIp(viewer, targetUser) {
  if (!viewer || !targetUser) return false;

  const viewerRole = viewer.userRole || Role.GUEST;
  const targetRole = targetUser.role || Role.GUEST;

  if (viewerRole >= Role.DEITY) return true;
  return viewerRole >= Role.MOD && viewerRole > targetRole;
}

function getVisibleIpForViewer(viewer, targetUser, room) {
  if (!canViewerSeeTargetIp(viewer, targetUser)) return '';

  const targetClient = getRoomClientBySessionIndex(room, targetUser.sessionIndex);
  const targetIp = targetClient?.clientIp || '';
  if (!targetIp) return '';

  const viewerRole = viewer.userRole || Role.GUEST;
  return obfuscateIp(targetIp, viewerRole);
}

function isShadowHiddenFromViewer(subjectUser, viewer) {
  if (!subjectUser?.isShadowBanned) return false;
  if (!viewer) return false;
  if (subjectUser.sessionIndex === viewer.sessionIndex) return false;
  // MOD+ can still see (and act on) a shadow-banned user; only the subject's
  // peers and the subject's own delusion of normalcy are protected.
  if ((viewer.userRole || Role.GUEST) >= Role.MOD) return false;
  return true;
}

function isCursorEffectivelyHidden(user, now = Date.now()) {
  if (!user) return true;
  if (user.cursorHidden) return true;
  // Muting broadcasts HIDE_CURSOR to the room, but that is a one-shot message:
  // anyone joining later only learns cursor state from this flag, and the muted
  // user's own SHOW_CURSOR (sent whenever their pointer crosses the board) used
  // to clear cursorHidden again. Mute means no cursor, full stop.
  if (user.isMuted) return true;
  if (user.tool === Tool.TEXT && user.text) return false;

  const lastActivity = Number(user.cursorLastActivity || 0);
  return !lastActivity || now - lastActivity >= CURSOR_IDLE_HIDE_MS;
}

function mapUsersForBroadcast(users, viewer = null, room = null) {
  const now = Date.now();
  return users
    .filter(u => !room || !isSessionPendingDisconnect(room, u.sessionIndex))
    .filter(u => !isShadowHiddenFromViewer(u, viewer))
    .map(u => {
      const client = getRoomClientBySessionIndex(room, u.sessionIndex);
      return {
        u: u.sessionIndex,
        iid: u.instanceId,
        a: u.afk,
        x: u.x,
        y: u.y,
        l: u.tool,
        c: u.color,
        s: u.size,
        sp: u.spacing,
        sm: u.smoothing,
        hd: u.hardness,
        p: u.pressure,
        n: u.name,
        tx: u.text,
        role: u.role || Role.GUEST,
        globalRole: client?.globalRole || Role.GUEST,
        roomRole: client?.roomRole || Role.GUEST,
        ch: isCursorEffectivelyHidden(u, now),
        br: u.blurRadius || 5,
        ly: u.activeLayer || 0,
        bm: u.blendMode || 'source-over',
        bbm: normalizeBlendBakeMode(u.blendBakeMode),
        ib: u.imageBrush,
        pb: u.patternBrush,
        pm: u.patternMode || false,
        ea: u.eraseAllLayers || false,
        fo: u.font || '',
        tm: u.textPositionMultiplier ?? 0,
        to: u.textPositionOffset ?? 0,
        iph: u.ipHash,
        th: u.thinning,
        sim: u.simulatePressure,
        pt: u.pressureTargets || 0,
        rn: u.registeredName || '',
        // A shadow-banned user's own row must never report `mt: true` even if
        // they're separately muted: shadowban already confines their draws
        // server-side (handleBroadcast returns before broadcastToRoom), and
        // the client-side mute gate (App.js) would otherwise block local
        // drawing and surface a "You are muted" toast, revealing the mod
        // action and defeating the silent-confinement point of shadowban.
        mt: (u.isShadowBanned && viewer && u.sessionIndex === viewer.sessionIndex) ? false : !!u.isMuted,
        sl: !!u.isSilenced,
        hdsc: !!u.hasDiscord,
        bdg: u.selectedBadge || '',
        sup: !!u.isSupporter,
        ctry: u.countryCode || '',
        vip: room ? getVisibleIpForViewer(viewer, u, room) : '',
        fpId: u.fingerprintId || '', // Include fingerprintId for persistent user tracking
        // Only reveal shadowban state to MOD+ viewers, and never on the
        // subject's own row - the subject must never learn they're banned.
        sb: (u.isShadowBanned && viewer && (viewer.userRole || Role.GUEST) >= Role.MOD
          && u.sessionIndex !== viewer.sessionIndex) || false
      };
    });
}

function sendUsersToClient(ws, room, users = null) {
  if (!ws || !room) return;

  const joinedUsers = users || getVisibleJoinedUsers(room);
  sendTo(ws, {
    t: T.USERS,
    us: mapUsersForBroadcast(joinedUsers, ws, room)
  });
}

function getRoomAdminAuthority(ws) {
  return Math.max(
    Number(ws?.roomRole || Role.GUEST),
    Number(ws?.globalRole || Role.GUEST) >= Role.HOLY ? Role.OWNER : Role.GUEST
  );
}

function getModerationAuthority(ws) {
  const globalRole = Number(ws?.globalRole || Role.GUEST);
  const globalAuthority = globalRole >= Role.HOLY
    ? Role.OWNER
    : globalRole >= Role.NOBLE
      ? Role.MOD
      : Role.GUEST;
  return Math.max(Number(ws?.roomRole || Role.GUEST), globalAuthority);
}

function getTrustedFeatureAuthority(ws) {
  return Math.max(
    Number(ws?.userRole || Role.GUEST),
    Number(ws?.roomRole || Role.GUEST),
    Number(ws?.globalRole || Role.GUEST)
  );
}

function getTargetProtectionRole(targetWs, targetUser) {
  return Math.max(
    Number(targetWs?.roomRole ?? targetWs?.userRole ?? Role.GUEST),
    Number(targetUser?.role || Role.GUEST)
  );
}

function sendActiveOverlaysToClient(ws, room) {
  if (!ws || !room) return;

  // Selection masks are NOT sent here when a join sync is coming. A mask clips
  // at MD time, so arming one before the tail replays makes it clip every
  // stroke in that tail — including the ones drawn before the mask existed.
  // SyncCoordinator._sendActiveMasksToJoiner owns mask delivery for a syncing
  // client: it arms only the masks that predate the checkpoint, and the tail
  // itself carries the rest as tool state, each at the position it was armed.
  //
  // The flag is set just above room.addClient() and only when the room already
  // has peers — which is also the only way an active mask can exist — so the
  // fallback below stays correct for a lone first joiner (no sync, no peers,
  // nothing to arm).
  const joinSyncWillDeliverMasks = !!ws.joinSyncPendingSince;

  if (!joinSyncWillDeliverMasks) {
    for (const [sessionIndex, userData] of room.sessionManager.users) {
      if (!userData.activeMask) continue;
      const { sx, sy, sw, sh, ps } = userData.activeMask;
      const msg = { t: T.SEL_MASK, u: sessionIndex, mk: true, sx, sy, sw, sh };
      if (Array.isArray(ps) && ps.length >= 6) {
        msg.ps = ps;
      }
      sendTo(ws, msg);
    }
  }
  for (const region of room.obscureRegions?.values?.() || []) {
    sendTo(ws, { t: T.OBSCURE_REGION, u: ROOM_OVERLAY_SESSION_INDEX, g: JSON.stringify(region) });
  }

  // Replay live ephemeral text records, sweeping any that have already expired.
  if (Array.isArray(room.activeTexts) && room.activeTexts.length > 0) {
    const now = Date.now();
    room.activeTexts = room.activeTexts.filter(t => now - t.bornAt < t.lifetimeMs);
    for (const r of room.activeTexts) {
      sendTo(ws, {
        t: T.TEXT_APPLY,
        u: r.sessionIndex,
        g: r.text,
        ps: [r.x, r.y],
        s: r.size,
        c: r.color,
        p: r.opacity,
        ly: r.layerIndex,
        bm: r.blendMode,
        bbm: r.blendBakeMode,
        fo: r.font,
        tm: r.textPositionMultiplier,
        to: r.textPositionOffset,
        textId: r.id,
        textLifetimeMs: r.lifetimeMs,
        textFadeMs: r.fadeMs,
        textAgeMs: now - r.bornAt
      });
    }
  }
}

function clearActiveFloatingSelection(user) {
  if (!user) return;
  user.activeImage = null;
  user.activeSelectionCorners = null;
  user.activeSelectionSourceCrop = null;
}

function isVpnAutoMuteExempt(role) {
  return (role || 0) >= Role.MOD;
}

async function determineMutedStateForClient(client, room, {
  userId = client.userId || null,
  effectiveRole = client.userRole || Role.GUEST
} = {}) {
  let muteReason = '';
  let shouldMute = false;
  const vpnFlagged = isVpnAsn(client.clientAsn);
  client.isVpnNetwork = vpnFlagged;
  client.isVPN = vpnFlagged;

  if (getDB()) {
    const muteCheck = await checkMute(userId, client.clientIp, room.id);
    if (muteCheck && effectiveRole < Role.MOD) {
      shouldMute = true;
      muteReason = muteCheck.reason || '';
    }
  }

  if (!userId && room.settings.autoMuteGuests) {
    shouldMute = true;
    if (!muteReason) muteReason = 'Guests are auto-muted in this room until they log in.';
  }

  if (room.settings.autoMuteVpnUsers && vpnFlagged && !isVpnAutoMuteExempt(effectiveRole)) {
    shouldMute = true;
    if (!muteReason) muteReason = 'VPN or datacenter connections are auto-muted in this room.';
  }

  return { shouldMute, muteReason };
}

function logVpnAutoMuteContext(client, room, contextLabel) {
  if (!room.settings.autoMuteVpnUsers) return;

  const status = getAsnCheckStatus();
  if (!client.clientAsn) {
    debug.warn(`[ASN] ${contextLabel}: no ASN resolved for ${client.clientIp} in room ${room.id}; VPN auto-mute cannot evaluate this connection.`);
    return;
  }

  if (!status.ready) {
    debug.warn(`[ASN] ${contextLabel}: ASN list not ready yet for ASN ${client.clientAsn} in room ${room.id}.`);
    return;
  }

  debug(`[ASN] ${contextLabel}: ASN ${client.clientAsn} for ${client.clientIp} in room ${room.id} flagged=${isVpnAsn(client.clientAsn)}`);
}

async function applyShadowBanStateToClient(client, room, {
  userId = client.userId || null,
  effectiveRole = client.userRole || Role.GUEST
} = {}) {
  let shadowBanEntry = null;
  if (getDB() && effectiveRole < Role.MOD) {
    shadowBanEntry = await checkShadowBan({
      userId,
      ip: client.clientIp || null,
      deviceId: client.deviceId || null,
      fingerprintId: client.fingerprintId || null,
      roomId: room?.id || null
    });
  }

  client.isShadowBanned = !!shadowBanEntry;
  return shadowBanEntry;
}

function logAsnHandshakeContext(client, roomId = '') {
  const status = getAsnCheckStatus();
  const roomLabel = roomId || 'unknown-room';

  if (!client.clientAsn) {
    if (status.dbLoaded) {
      debug.warn(`[ASN] WS handshake: no ASN resolved for ${client.clientIp} (room=${roomLabel}). IP may not be in the MaxMind database.`);
    } else {
      debug.warn(`[ASN] WS handshake: MaxMind database not loaded; cannot resolve ASN for ${client.clientIp} (room=${roomLabel}).`);
    }
    return;
  }

  if (!status.ready) {
    debug.warn(`[ASN] WS handshake: ASN ${client.clientAsn} resolved for ${client.clientIp} (room=${roomLabel}) but VPN blocklist is not ready yet.`);
    return;
  }

  debug(`[ASN] WS handshake: ASN ${client.clientAsn} for ${client.clientIp} (room=${roomLabel}) flagged=${isVpnAsn(client.clientAsn)}`);
}

async function applyMuteStateToClient(client, room, options = {}) {
  const { shouldMute, muteReason } = await determineMutedStateForClient(client, room, options);
  client.isMuted = shouldMute;

  const roomUser = room.sessionManager.getUser(client.sessionIndex);
  if (roomUser) {
    roomUser.isMuted = shouldMute;
    roomUser.isVPN = !!client.isVPN;
  }

  return { shouldMute, muteReason };
}

/**
 * Re-checks a persisted silence (chat-only mute) entry for a client and syncs
 * client.isSilenced / the room's user record. Unlike mute, silence has no
 * guest/VPN auto-trigger — it is only ever mod-issued.
 */
async function applySilenceStateToClient(client, room, {
  userId = client.userId || null,
  effectiveRole = client.userRole || Role.GUEST
} = {}) {
  let shouldSilence = false;
  let silenceReason = '';

  if (getDB()) {
    const silenceCheck = await checkSilence(userId, client.clientIp, room.id);
    if (silenceCheck && effectiveRole < Role.MOD) {
      shouldSilence = true;
      silenceReason = silenceCheck.reason || '';
    }
  }

  client.isSilenced = shouldSilence;

  const roomUser = room.sessionManager.getUser(client.sessionIndex);
  if (roomUser) {
    roomUser.isSilenced = shouldSilence;
  }

  return { shouldSilence, silenceReason };
}

/**
 * Initializes the server, connects to the database, and loads protobuf definitions.
 * @returns {Promise<void>}
 */
async function init() {
  validateProductionConfig();

  const protoPath = pathModule.join(__dirname, '..', 'public', 'messages.proto');
  const root = await protobuf.load(protoPath);
  Msg = root.lookupType('Msg');
  debug('[PROTO DEBUG] room_board_size field in server Msg?',
    Object.keys(Msg.fields).filter(k => k.toLowerCase().includes('board')),
    'total fields:', Object.keys(Msg.fields).length);

  try {
    await connectDB();
  } catch (err) {
    console.warn('[Server] Starting without database — auth/moderation disabled');
    debug(err);
  }

  roomManager = new RoomManager(wss, sendTo);
  roomManager.setMsgEncoder(Msg, createRoomBroadcaster);
  setDiscordRoomManager(roomManager);
  await initDiscordBot({ roomManager });
  setGalleryDiscordPoster(postGalleryItemToDiscord);
  postReleaseUpdateOnce().catch(err => {
    console.error('[Discord] Auto release update failed:', err);
  });
  console.log('[Server] RoomManager initialized');
  initAsnCheck();

  ghostSweepInterval = setInterval(sweepOrphanedSessions, GHOST_SWEEP_INTERVAL_MS);
  ghostSweepInterval.unref?.();

  // Push supporter status changes from Stripe webhooks to live sessions so
  // gold cosmetics apply/lapse without a re-login.
  setSupporterChangeNotifier((userId, isSupporter) => {
    const roomsNeedingRefresh = new Set();
    for (const client of wss.clients) {
      if (client.userId !== String(userId)) continue;
      const clientRoom = roomManager.getRoomByClient(client);
      if (!clientRoom) continue;
      const roomUser = clientRoom.sessionManager.getUser(client.sessionIndex);
      if (roomUser && roomUser.isSupporter !== isSupporter) {
        roomUser.isSupporter = isSupporter;
        roomsNeedingRefresh.add(clientRoom);
      }
    }
    for (const refreshRoom of roomsNeedingRefresh) {
      broadcastUsersForRoom(refreshRoom);
    }
  });

  // Floating art wall: heart counts and deletions reach every wall showing the piece
  // (included ids can come from other rooms); uploads join the walls of their tagged rooms.
  setGalleryWallListener({
    likes: (id, likesCount) => {
      for (const room of roomManager.rooms.values()) room.floatingWall?.onLikes(id, likesCount);
    },
    added: (tags, item) => {
      for (const tag of tags || []) roomManager.rooms.get(tag)?.floatingWall?.onAdded(item);
    },
    removed: (id) => {
      for (const room of roomManager.rooms.values()) room.floatingWall?.onRemoved(id);
    }
  });

  // Set up floating art broadcaster for gallery likes
  setFloatingArtBroadcaster((tags, item) => {
    // Broadcast to each room matching the image tags
    tags.forEach(tag => {
      const room = roomManager.rooms.get(tag);
      if (room) {
        broadcastToRoom(room, {
          t: T.FLOATING_ART_UPDATE,
          fa: JSON.stringify(item)
        });
      }
    });
  });

  startBatchTimer();

  // Start metrics tracker
  metricsTracker.start();

  server.listen(PORT, HOST, () => {
    console.log(`WebSocket server running on ${HOST}:${PORT}`);
    if (DISABLE_RATE_LIMITS) console.warn('[SERVER] ⚠ Rate limits DISABLED (DISABLE_RATE_LIMITS=true)');
  });
}

/**
 * Broadcasts a payload to all connected clients, optionally excluding one.
 * @param {Object} payload - The message payload to broadcast.
 * @param {number|null} [excludeIndex=null] - The session index to exclude from the broadcast.
 */
function broadcast(payload, excludeIndex = null) {
  const buffer = Msg.encode(payload).finish();

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (excludeIndex != null && client.sessionIndex == excludeIndex) {
        return;
      }
      sendEncodedBuffer(client, buffer, `broadcast:${payload?.t ?? 'unknown'}`);
    }
  });
}

/**
 * Broadcasts a payload to all connected clients without exclusion.
 * @param {Object} payload - The message payload to broadcast.
 */
function broadcastToAll(payload) {
  const message = Msg.create(payload);
  const buffer = Msg.encode(message).finish();

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      sendEncodedBuffer(client, buffer, `broadcastAll:${payload?.t ?? 'unknown'}`);
    }
  });
}

function broadcastGlobalMessage({ message, kind = 'notice', issuer = 'Server', persistent = false }) {
  const text = String(message || '').trim().slice(0, 500);
  if (!text) return;
  broadcastToAll({
    t: T.GLOBAL_MESSAGE,
    g: text,
    k: String(kind || 'notice').slice(0, 32),
    n: String(issuer || 'Server').slice(0, 20),
    a: !!persistent
  });
}

/**
 * Creates a broadcaster function for a specific room.
 * @param {Object} room - The room object.
 * @returns {function(Object): void} - A function that broadcasts a payload to all clients in the room.
 */
function createRoomBroadcaster(room) {
  return (payload) => {
    if (payload?.t === T.USERS) {
      const joinedUsers = getVisibleJoinedUsers(room);
      room.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          sendUsersToClient(client, room, joinedUsers);
        }
      });
      return;
    }

    const message = Msg.create(payload);
    const buffer = Msg.encode(message).finish();

    room.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        sendEncodedBuffer(client, buffer, `roomBroadcast:${payload?.t ?? 'unknown'}`);
      }
    });
  };
}

/**
 * Broadcasts the latest USERS payload to everyone in a room.
 * @param {Object} room
 * @returns {void}
 */
function broadcastUsersForRoom(room) {
  if (!room) return;
  createRoomBroadcaster(room)({
    t: T.USERS
  });
}

/**
 * Sends a payload to a specific WebSocket client.
 * @param {WebSocket} ws - The WebSocket client.
 * @param {Object} payload - The message payload to send.
 */
// Floating art wall traffic is ephemeral: encode once and send straight to the room's sockets,
// bypassing broadcastToRoom's sequencing, stroke log and batching.
const floatingWallIo = {
  send: (ws, payload) => sendTo(ws, payload),
  // The wall edited room settings (an admin hid a piece): everyone's copy must match
  settingsChanged: (room) => createRoomBroadcaster(room)(buildSettingsPayload(room)),
  // `filter` picks the recipients (wall subscribers, or only full/slow ones); encoded only if someone gets it
  broadcast: (room, payload, filter = null) => {
    if (!room?.clients?.size) return;
    let buffer = null;
    for (const client of room.clients) {
      if (filter && !filter(client)) continue;
      buffer ||= Msg.encode(Msg.create(payload)).finish().slice();
      sendTo(client, buffer);
    }
  }
};

function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
      return sendEncodedBuffer(ws, payload, 'sendTo:encoded');
    }
    const message = Msg.create(payload);
    return sendEncodedBuffer(ws, Msg.encode(message).finish(), `sendTo:${payload?.t ?? 'unknown'}`);
  }
  return false;
}

function sendToSession(room, sessionIndex, payload) {
  if (!room || sessionIndex === undefined || sessionIndex === null) return false;
  for (const client of room.clients) {
    if (client.sessionIndex === sessionIndex && client.readyState === WebSocket.OPEN) {
      return sendTo(client, payload);
    }
  }
  return false;
}

const INACTIVE_FILTERED_TYPES = new Set([
  T.MM, T.MD, T.MU, T.CP, T.CS, T.CT, T.CC, T.CSP, T.CSM, T.CHD, T.CBR,
  T.CL, T.CBM, T.PAN, T.CANCEL, T.KP, T.TEXT_APPLY, T.CSDM, T.HIDE_CURSOR, T.SHOW_CURSOR, T.SEL_HIDE, T.GMP,
  T.GPT, T.IMAGE_TOOL, T.CPM, T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_DELETE,
  T.SEL_FILL, T.SEL_STAMP, T.SEL_CANCEL, T.SEL_TO_BRUSH, T.SEL_FLIP, T.SEL_MERGE,
  T.SEL_PENDING, T.SEL_MASK, T.OBSCURE_REGION, T.IMG_PASTE, T.CLR, T.UNDO, T.REDO, T.FILL, T.CTHN,
  T.CSIM, T.CPT, T.GLITCH_RESULT, T.TILE_UPDATE, T.TILE_CLEAR
]);

const ACTIVE_STROKE_REPLAY_TYPES = new Set([
  T.MM, T.MD, T.CP, T.CS, T.CT, T.CC, T.CSP, T.CSM, T.CHD, T.CBR,
  T.CTHN, T.CSIM, T.CPT, T.CL, T.CBM, T.GMP, T.GPT, T.IMAGE_TOOL, T.CPM, T.CF, T.CSDM
]);

function shouldSkipInactiveRecipient(room, client, messageType) {
  if (!room || !INACTIVE_FILTERED_TYPES.has(messageType)) return false;
  const user = room.sessionManager.getUser(client.sessionIndex);
  return !!user?.afk && !room.sessionManager.isUserImmuneToInactivity(client.sessionIndex, user);
}

// Room CONTENT types that the checkpoint+tail join sync fully reproduces:
// stroke geometry (MD/MM/CANCEL), tool-state changes (mirrors
// StrokeTape.buildToolStateSet), selection setup (mirrors
// buildSelectionStateSet + SEL_CANCEL), and every commit type. A client that
// is still waiting for its join sync must NOT receive these live — the tail
// will deliver them — or everything committed during the join window is
// applied twice. Presence/chat/settings traffic is NOT in this set and flows
// to the joiner immediately.
const JOIN_SYNC_SUPPRESSED_TYPES = new Set([
  T.MD, T.MM, T.CANCEL,
  T.CT, T.CC, T.CS, T.CP, T.CSP, T.CSM, T.CHD, T.CBR,
  T.CL, T.CBM, T.CF, T.CTHN, T.CSIM, T.CPT,
  // Image-tool payloads are tool state too (StrokeTape.buildImageStateSet), and
  // by far the largest frames on the wire: the tail replays the ones the
  // joiner's strokes need and the serve ends with everyone's latest, so letting
  // the live copy through as well only ships the same bitmap twice.
  T.GMP, T.GPT, T.IMAGE_TOOL, T.CPM,
  T.SEL_LIFT, T.SEL_MOVE, T.SEL_PENDING, T.SEL_MASK, T.SEL_CANCEL,
  ...Object.keys(COMMIT_KIND).map(Number),
]);

// Safety valve: if a client never completes its join sync (crashed mid-join,
// legacy client that never sends SYNC_REQUEST), stop suppressing after this
// long rather than leaving it deaf to draw traffic forever.
const JOIN_SYNC_SUPPRESS_MAX_MS = 20_000;

function shouldSkipJoinSyncPending(client, messageType) {
  if (!client.joinSyncPendingSince) return false;
  if (!JOIN_SYNC_SUPPRESSED_TYPES.has(messageType)) return false;
  if (Date.now() - client.joinSyncPendingSince > JOIN_SYNC_SUPPRESS_MAX_MS) {
    client.joinSyncPendingSince = null;
    return false;
  }
  return true;
}

// Types a muted user may not emit. This is an ALLOWLIST BY OMISSION: anything
// absent falls through handleBroadcast's default path to broadcastToRoom, so a
// board-mutating type added elsewhere and forgotten here is silently relayed
// from muted users. FILL, TEXT_REMOVE, UNDO and REDO were exactly that gap —
// a muted user could flood-fill the canvas. Add every new board-mutating type
// here, and see `mute_gating` in testing/moderation/ip_moderation_suite.mjs,
// which probes each type against a live peer and fails if one leaks.
const MUTED_BLOCKED = new Set([
  T.MM, T.MD, T.MU, T.KP, T.TEXT_APPLY, T.TEXT_REMOVE, T.CLR, T.FILL,
  T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_DELETE, T.SEL_FILL, T.SEL_STAMP, T.SEL_FLIP, T.SEL_MERGE, T.SEL_CANCEL, T.SEL_TO_BRUSH, T.SEL_MASK, T.OBSCURE_REGION,
  T.IMG_PASTE, T.GLITCH_RESULT,
  T.MIR, T.MIRROR_REGION,
  // Undo/redo mutate the board like anything else. Scoped to the sender's own
  // strokes, so blocking them also stops a muted user withdrawing their own
  // work — the deliberate reading of "muted means cannot affect the board".
  T.UNDO, T.REDO
]);

// Silence is a chat-only mute: it never touches drawing/undo, just the
// message-entry types. Kept separate from MUTED_BLOCKED so a board mute and
// a chat silence are independent moderation actions (see permissions.js
// MOD_SILENCE/MOD_UNSILENCE).
const SILENCED_BLOCKED = new Set([T.MSG, T.DM, T.CHAT_IMG]);

// ── Chat spam escalation ─────────────────────────────────────────────
// Sliding-window rate limit on chat sends (see SILENCED_BLOCKED types above).
// Tripping it escalates per-connection: warn + 10s cooldown, then warn + 30s
// cooldown, then a real (DB-persisted) silence — same mechanism a mod would
// issue by hand, so an auto-silenced user shows up in the mod panel and can
// be unsilenced the normal way. State lives on the ws connection and resets
// on reconnect; it is not meant to survive a fresh session.
const CHAT_SPAM_WINDOW_MS = 8000;
const CHAT_SPAM_THRESHOLD = 5; // messages within the window before it trips
const CHAT_SPAM_COOLDOWNS_MS = [10000, 30000]; // level 1, level 2 — level 3+ auto-silences
const CHAT_SPAM_AUTO_SILENCE_MINUTES = 30;

/**
 * @returns {null|{level:number, cooldownMs:number, silenced:boolean}} null when the send is allowed.
 */
function checkChatSpam(ws) {
  if ((ws.userRole || 0) >= Role.MOD) return null; // MOD(4)+ exempt, same as mute/silence

  const now = Date.now();
  if (ws.chatCooldownUntil && now < ws.chatCooldownUntil) {
    return { level: ws.chatSpamLevel || 1, cooldownMs: ws.chatCooldownUntil - now, silenced: false };
  }

  ws.chatMsgTimestamps = (ws.chatMsgTimestamps || []).filter((ts) => now - ts < CHAT_SPAM_WINDOW_MS);
  ws.chatMsgTimestamps.push(now);
  if (ws.chatMsgTimestamps.length <= CHAT_SPAM_THRESHOLD) return null;

  ws.chatMsgTimestamps = [];
  const level = (ws.chatSpamLevel || 0) + 1;
  ws.chatSpamLevel = level;

  if (level > CHAT_SPAM_COOLDOWNS_MS.length) {
    return { level, cooldownMs: 0, silenced: true };
  }

  const cooldownMs = CHAT_SPAM_COOLDOWNS_MS[level - 1];
  ws.chatCooldownUntil = now + cooldownMs;
  return { level, cooldownMs, silenced: false };
}

const NON_USER_ACTIVITY_TYPES = new Set([
  T.CONNECT, T.USERS, T.SETTINGS, T.LEFT, T.AFK,
  T.PING, T.PONG,
  T.SYNC_REQUEST, T.SYNC_COMPLETE,
  T.TILE_UPDATE, T.TILE_CLEAR,
  T.AUTH_RESULT, T.MOD_RESULT, T.MOD_NOTIFY,
  T.ROOM_LIST_REQUEST, T.ROOM_LIST_RESPONSE, T.ROOM_ROLE_LIST_RESPONSE,
  T.BW_PROBE_START, T.BW_PROBE_CHUNK, T.BW_REPORT,
  T.BOARD_SNAPSHOT_LIST_RESPONSE,
  T.CHECKPOINT_LIST_RESPONSE, T.REPLAY_RESPONSE,
  T.COMPRESS_USER_STROKES,
  // The sync-parity heartbeat and its follow-ups. ParityClient sends
  // SYNC_PARITY_CHECK on a plain 30s interval (DEFAULT_HEARTBEAT_MS) with no
  // user involved — well under AFK_TIMEOUT (5 min) — so while these counted as
  // deliberate activity NO connected client could ever be marked AFK. That
  // silently disabled the whole inactivity subsystem: draw-traffic filtering
  // for idle clients, the resync prompt, COMPRESS_USER_STROKES, and the
  // all-AFK BOARD_SNAPSHOT_RESTORE. ParityClient's own guard
  // (shouldPause: … || !!this.self?.afk) could not save it — it pauses the
  // heartbeat once you are AFK, but the heartbeat is what stopped you getting
  // there, so the guard was unreachable. This list was last curated 2026-04-29;
  // ParityClient arrived 2026-05-24 and was never added to it.
  T.SYNC_PARITY_CHECK, T.SYNC_PARITY_CHUNK_REQUEST,
  T.SYNC_PARITY_RESYNC_REQUEST, T.SYNC_PARITY_MISMATCH_REPORT,
  // Automatic uploads, both on their own setInterval (App.startPreviewInterval,
  // 30s) and solicited by the server's own snapshot timer — no user involved.
  T.ROOM_PREVIEW, T.CHECKPOINT_UPLOAD
]);

function isUserActivityMessage(data, user) {
  const messageType = data?.t;
  if (messageType === T.MM) {
    return !!user?.mousedown;
  }
  // BOARD_SNAPSHOT_SAVE is two different things on one wire type: `a: true` is
  // SnapshotManager's automatic checkpoint (the server's own snapshot timer
  // asked for it — no user involved), `a: false` is someone clicking save. Only
  // the latter is activity, so this cannot be a blanket entry in the set above.
  if (messageType === T.BOARD_SNAPSHOT_SAVE) {
    return !data?.a;
  }
  // Same story for BOARD_SNAPSHOT_GET: `snapshot_probe` is SnapshotManager's
  // automatic pixel-parity fetch, fired by every client each time the server
  // mints a checkpoint (15 s in a snapshot-backed room). A user opening the
  // history UI sends the same type with the flag clear, and that IS activity.
  // Note the proto field is snake_case on the wire and camelCase in JS.
  if (messageType === T.BOARD_SNAPSHOT_GET) {
    return !data?.snapshotProbe;
  }
  return !NON_USER_ACTIVITY_TYPES.has(messageType);
}

/**
 * Builds the T.SETTINGS payload for a room.
 * Single source of truth — used by join, MIRROR_REGION, and ROOM_UPDATE broadcasts.
 * @param {Room} room
 * @returns {Object}
 */
function buildSettingsPayload(room) {
  return {
    t: T.SETTINGS,
    m: room.settings.mirror,
    mirrorRegionsJson: JSON.stringify(room.settings.mirrorRegions || []),
    roomBackgroundColor: room.settings.backgroundColor,
    roomLocked: room.settings.locked,
    roomMaxUsers: room.settings.maxUsers,
    roomModInactiveImmune: room.settings.modInactiveImmune,
    roomJoinPolicy: room.settings.joinPolicy,
    roomObscureRequiresRegistered: !!room.settings.obscureRequiresRegistered,    roomAutoMuteGuests: room.settings.autoMuteGuests,
    roomAutoMuteVpnUsers: room.settings.autoMuteVpnUsers,
    roomHideChatNotifications: room.settings.hideChatNotifications,
    // Tri-state (0 unset / 1 on / 2 off), not a bool: proto3 omits `false`, so a
    // bool can only ever carry one of the two states for a default-ON setting.
    roomSnapshotOnFirstJoin: room.settings.loadSnapshotOnFirstJoin === false ? 2 : 1,
    roomTextOverlayLifetimeMs: room.settings.textOverlayLifetimeMs ?? (30 * 1000),
    roomDedicatedReplayUser: room.settings.dedicatedReplayUser,
    roomPrivate: room.settings.private,
    roomFloatingGallerySeed: room.settings.floatingGallerySeed,
    roomFloatingGalleryIncludeIds: room.settings.floatingGalleryIncludeIds || [],
    roomFloatingGalleryExcludeIds: room.settings.floatingGalleryExcludeIds || [],
    roomFloatingGalleryVoronoiJson: getFloatingGalleryVoronoiJson(
      room.settings.floatingGalleryVoronoi || generateFloatingGalleryVoronoi(room.settings.floatingGallerySeed)
    ),
    ownerId: room.ownerId || '',
    ownerUsername: room.ownerUsername || '',
    electedUploader: room._electedUploader || '',
    roomBoardSize: room.settings.boardSize,
    // Kill-switch gated: even a room with the flag set behaves as untiled if
    // the feature is globally disabled, so it can be killed instantly without
    // touching per-room state.
    roomTiledCanvas: roomTiledCanvasEnabled(room),
    // Sent separately from the setting itself so the client can tell "off for
    // this room" from "not available at all". Without it the room settings UI
    // would show a checkbox that saves happily and changes nothing, because
    // the ROOM_UPDATE handler drops roomTiledCanvas while the kill switch is
    // off — a setting that reports success and does nothing. The same is true
    // while TILED_CANVAS_FORCE_ALL is on, so that hides the checkbox too.
    roomTiledCanvasAvailable: roomTiledCanvasSettable()
  };
}

function hasValidRoomBoardSize(room) {
  return VALID_ROOM_BOARD_SIZES.has(room?.settings?.boardSize);
}

function normalizeImageToolType(type) {
  const value = String(type || '').trim();
  if (value === 'imageBrush' || value === 'pattern' || value === 'confetti') return value;
  return null;
}

function getImageToolDataForUser(user, type) {
  if (!user) return null;
  if (type === 'imageBrush') return user.imageBrush || null;
  if (type === 'pattern') return user.patternBrush || null;
  if (type === 'confetti') return user.confettiBrush || null;
  return null;
}

function setImageToolDataForUser(user, type, imageData) {
  if (!user) return;
  if (type === 'imageBrush') user.imageBrush = imageData;
  if (type === 'pattern') user.patternBrush = imageData;
  if (type === 'confetti') user.confettiBrush = imageData;
}

function sendImageToolStateToClient(ws, room, users = null) {
  if (!ws || !room) return;
  const joinedUsers = users || getVisibleJoinedUsers(room);
  for (const user of joinedUsers) {
    if (isShadowHiddenFromViewer(user, ws)) continue;
    for (const type of ['imageBrush', 'pattern', 'confetti']) {
      const imageData = getImageToolDataForUser(user, type);
      if (!imageData) continue;

      // Late joiners must receive brush assets through the same live paths that
      // drawing messages already depend on. Keep IMAGE_TOOL as the unified
      // stored-state command, but also send the legacy loaders for compatibility
      // with the existing remote brush/pattern loading code.
      if (type === 'imageBrush') {
        sendTo(ws, { t: T.GMP, u: user.sessionIndex, g: imageData });
      } else if (type === 'pattern') {
        sendTo(ws, { t: T.GPT, u: user.sessionIndex, g: imageData });
      }

      sendTo(ws, {
        t: T.IMAGE_TOOL,
        u: user.sessionIndex,
        imageToolType: type,
        imageToolData: imageData
      });
    }
  }
}

/**
 * Handles incoming broadcast-type messages, updating user state and relaying to others.
 * @param {Object} data - The message data.
 * @param {number} sessionIndex - The session index of the sender.
 * @param {Object} room - The room object the sender is in.
 * @returns {Promise<void>}
 */
async function handleBroadcast(data, sessionIndex, room, ws) {
  if (!room) return;
  const user = room.sessionManager.getUser(sessionIndex);
  if (!user) return;

  if (data.tu !== undefined && ACTIVE_STROKE_REPLAY_TYPES.has(data.t)) {
    if (ws?.isShadowBanned) return;
    if (ws?.isMuted && ws.userRole < Role.MOD) return;
    sendToSession(room, data.tu, { ...data, u: sessionIndex });
    return;
  }

  switch (data.t) {
    case T.SET_BADGE: {
      // Only logged-in accounts have a persistent badge; ignore guests.
      if (!ws?.userId) return;
      const requested = typeof data.profileBadge === 'string' ? data.profileBadge : '';
      let badge = '';
      if (requested === 'none') badge = 'none';
      else if (SELECTABLE_BADGES.has(requested)) badge = requested;
      else if (requested === 'discord' && user.hasDiscord) badge = 'discord';
      else if (requested === 'supporter' && user.isSupporter) badge = 'supporter';
      if (user.selectedBadge === badge) return;
      user.selectedBadge = badge;
      // Persistence is handled by the PATCH /api/users/me/profile request the
      // client sends alongside this; here we only sync live presence.
      broadcastUsersForRoom(room);
      return;
    }

    case T.MM:
      if (data.ps && data.ps.length >= 2) {
        // ps is quantized (x10) sint32 delta-encoded on the wire. Sum all
        // deltas to recover the final absolute position without allocating a
        // decoded copy — the server only needs the last coord pair.
        let accX = 0;
        let accY = 0;
        for (let i = 0; i < data.ps.length; i += 2) {
          accX += data.ps[i];
          accY += data.ps[i + 1];
        }
        user.lastx = user.x;
        user.lasty = user.y;
        user.x = accX / 10;
        user.y = accY / 10;
        user.cursorLastActivity = Date.now();

        // Track distance for metrics
        if (ws.userId && user.mousedown) {
          metricsTracker.onStrokeMove(ws.userId, user.x, user.y);
        }
      }
      break;

    case T.MD:
      if (data.ly !== undefined) user.activeLayer = data.ly;
      if (data.bm !== undefined) user.blendMode = data.bm;
      if (data.bbm !== undefined) user.blendBakeMode = data.bbm;
      if (data.pt) user.pressureTargets = data.pt;
      user.mousedown = true;
      room.sessionManager.updateUserActivity(sessionIndex);

      // Track stroke start for metrics
      if (ws.userId) {
        const toolNames = ['brush', 'text', 'erase', 'imageBrush', 'select', 'flowPen', 'line', 'rectangle', 'circle', 'ink', 'inkdropper', 'blur', 'circleBlur', 'glitchBlur', 'pixel', 'fill', 'pattern', 'confetti'];
        const toolName = toolNames[user.tool] || 'unknown';
        metricsTracker.onStrokeStart(ws.userId, toolName);
      }
      break;

    case T.MU:
      user.mousedown = false;
      if (user.tool === Tool.TEXT) {
        user.text = '';
      }
      room.sessionManager.updateUserActivity(sessionIndex);

      // Track stroke end for metrics
      if (ws.userId) {
        metricsTracker.onStrokeEnd(ws.userId);
      }
      break;

    case T.TEXT_APPLY: {
      user.text = '';
      room.sessionManager.updateUserActivity(sessionIndex);

      // Pixel mode: skip the ephemeral activeTexts ledger, just relay so receivers rasterize as a stroke.
      if (data.textPixel) {
        break;
      }

      // Server-authoritative active-text tracking (ephemeral SVG overlay).
      const now = Date.now();
      // Lazy sweep of any expired entries before adding.
      if (Array.isArray(room.activeTexts) && room.activeTexts.length > 0) {
        room.activeTexts = room.activeTexts.filter(t => now - t.bornAt < t.lifetimeMs);
      } else {
        room.activeTexts = [];
      }

      const roomDefaultLifetime = Number(room.settings?.textOverlayLifetimeMs) || (30 * 1000);
      const lifetimeMs = Math.max(1000, Math.min(Number(data.textLifetimeMs) || roomDefaultLifetime, 30 * 60 * 1000));
      const fadeMs = Math.max(0, Math.min(Number(data.textFadeMs) || 30 * 1000, lifetimeMs));
      const id = String(data.textId || `t_${sessionIndex}_${now}_${Math.random().toString(36).slice(2, 8)}`);

      // Per-user cap: drop oldest if user has too many active records.
      const PER_USER_CAP = 20;
      const userCount = room.activeTexts.filter(t => t.sessionIndex === sessionIndex).length;
      if (userCount >= PER_USER_CAP) {
        const idx = room.activeTexts.findIndex(t => t.sessionIndex === sessionIndex);
        if (idx >= 0) room.activeTexts.splice(idx, 1);
      }
      // Per-room cap: drop oldest entry overall.
      const ROOM_CAP = 500;
      if (room.activeTexts.length >= ROOM_CAP) {
        room.activeTexts.shift();
      }

      const ps = Array.isArray(data.ps) ? data.ps : [];
      const record = {
        id,
        sessionIndex,
        userId: ws.userId || null,
        text: String(data.g || '').slice(0, 500),
        font: data.fo,
        size: data.s,
        color: data.c,
        opacity: data.p,
        layerIndex: data.ly ?? 0,
        blendMode: data.bm || 'source-over',
        blendBakeMode: normalizeBlendBakeMode(data.bbm),
        textPositionMultiplier: data.tm,
        textPositionOffset: data.to,
        x: ps[0] ?? 0,
        y: ps[1] ?? 0,
        bornAt: now,
        lifetimeMs,
        fadeMs
      };
      room.activeTexts.push(record);

      // Stamp the message so the relay forwards canonical id + age=0.
      data.textId = id;
      data.textLifetimeMs = lifetimeMs;
      data.textFadeMs = fadeMs;
      data.textAgeMs = 0;
      break;
    }

    case T.TEXT_REMOVE: {
      const id = data.textId ? String(data.textId) : null;
      if (!id || !Array.isArray(room.activeTexts)) break;
      // Owner-or-mod check: only the original placer (or MOD+) may remove.
      const target = room.activeTexts.find(t => t.id === id);
      if (!target) break;
      const isOwner = target.sessionIndex === sessionIndex;
      const isMod = (ws.userRole || 0) >= Role.MOD;
      if (!isOwner && !isMod) break;
      room.activeTexts = room.activeTexts.filter(t => t.id !== id);
      break;
    }

    case T.CS:
      user.size = data.s;
      break;

    case T.CSP:
      user.spacing = data.sp;
      break;

    case T.CSM:
      user.smoothing = data.sm;
      break;

    case T.CHD:
      user.hardness = data.hd;
      break;

    case T.CBR:
      user.blurRadius = Math.min(data.br, user.tool === Tool.BLUR ? 10 : 25);
      break;

    case T.CL:
      user.activeLayer = data.ly;
      break;

    case T.CBM:
      user.blendMode = data.bm;
      if (data.ly !== undefined) user.activeLayer = data.ly;
      if (data.bbm !== undefined) user.blendBakeMode = data.bbm;
      break;

    case T.CP:
      user.pressure = data.p;
      break;

    case T.CT:
      user.tool = data.l;
      if (data.a !== undefined) user.eraseAllLayers = !!data.a;
      user.text = '';
      break;

    case T.CC:
      user.color = data.c;
      break;

    case T.CF:
      user.font = data.fo;
      user.textPositionMultiplier = data.tm;
      user.textPositionOffset = data.to;
      break;

    case T.CSDM:
      break;

    case T.CN:
      const uniqueName = getUniqueVisibleName(room, data.n, sessionIndex);
      user.name = uniqueName;

      debug(`[CN] Session ${sessionIndex} changing name to "${data.n}" (unique: "${uniqueName}")`);

      const allUsers = getVisibleJoinedUsers(room);
      const cnBroadcaster = createRoomBroadcaster(room);
      
      if (!room.sessionManager.isDiscovery) {
        cnBroadcaster({
          t: T.USERS
        });
      } else {
        sendUsersToClient(ws, room, allUsers);
      }
      break;

    case T.KP:
      const key = data.k;
      if (key && key.length === 1) {
        user.text = (user.text || '') + key;
      }
      if (key === 'Enter') {
        user.text = '';
      } else if (key === 'Backspace' && user.text) {
        user.text = user.text.slice(0, -1);
      }
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.HIDE_CURSOR:
      user.cursorHidden = true;
      break;

    case T.SHOW_CURSOR:
      // A muted user's pointer entering the board still fires this, and
      // relaying it put their cursor back on every peer's screen at its stale
      // last-known position — visible presence from someone with no board
      // access. Their own client keeps drawing its local cursor either way.
      if (ws?.isMuted) {
        user.cursorHidden = true;
        return;
      }
      user.cursorHidden = false;
      user.cursorLastActivity = Date.now();
      break;

    case T.MIR:
      // Gated HERE, not with the other permission checks below the switch: those
      // run after this case body, and by then the room setting would already be
      // flipped for everyone. Senders toggle their own board optimistically, so
      // on denial push the authoritative settings back to put them straight.
      if (!authorize(ws, Action.TOGGLE_MIRROR, sendTo, T.MOD_RESULT)) {
        sendTo(ws, buildSettingsPayload(room));
        return;
      }
      room.settings.mirror = !room.settings.mirror;
      break;

    case T.MIRROR_REGION: {
      try {
        if (data.mirrorRegionsJson && data.mirrorRegionsJson.length > 10000) {
          debug.warn('[MirrorRegion] Payload too large');
          break;
        }
        const payload = data.mirrorRegionsJson ? JSON.parse(data.mirrorRegionsJson) : null;
        if (!payload || typeof payload !== 'object' || !payload.action) break;

        if ((payload.action === 'create' || payload.action === 'update') && payload.region) {
          const region = payload.region;
          const x = Math.max(0, Math.floor(region.x || 0));
          const y = Math.max(0, Math.floor(region.y || 0));
          const width = Math.max(1, Math.floor(region.width || 0));
          const height = Math.max(1, Math.floor(region.height || 0));
          const mode = ['horizontal', 'quad', 'rotational', 'radial', 'fib'].includes(region.mode || region.axis)
            ? (region.mode || region.axis)
            : 'vertical';
          const slices = Math.max(3, Math.min(16, Math.floor(Number(region.slices || 6)) || 6));
          const fibDepth = Math.max(1, Math.min(8, Math.floor(Number(region.fibDepth || 4)) || 4));
          const showLine = region.showLine !== false;
          const id = String(region.id || `mr_${Date.now()}`);

          const nextRegion = {
            id,
            x,
            y,
            width,
            height,
            mode,
            axis: mode,
            slices: mode === 'radial' ? slices : undefined,
            fibDepth: mode === 'fib' ? fibDepth : undefined,
            showLine,
            owner: region.owner || region.createdBy || ws.userId || null
          };

          if (payload.action === 'update') {
            room.settings.mirrorRegions = (room.settings.mirrorRegions || []).map(existing =>
              existing.id === id ? nextRegion : existing
            );
          } else {
            room.settings.mirrorRegions = [
              ...(room.settings.mirrorRegions || []),
              nextRegion
            ];
          }
        } else if (payload.action === 'remove' && payload.id) {
          room.settings.mirrorRegions = (room.settings.mirrorRegions || []).filter(region => region.id !== payload.id);
        }
      } catch (err) {
        debug.warn('[MirrorRegion] Invalid payload', err);
      }
      break;
    }

    case T.MSG:
      room.sessionManager.updateUserActivity(sessionIndex);

      // Track chat message for metrics
      if (ws.userId) {
        metricsTracker.onChatMessage(ws.userId);
      }
      break;

    case T.GMP:
      user.imageBrush = data.g;
      break;

    case T.GPT:
      user.patternBrush = data.g;
      break;

    case T.IMAGE_TOOL: {
      const imageToolType = normalizeImageToolType(data.imageToolType || data.image_tool_type || data.k);
      const imageToolData = data.imageToolData || data.image_tool_data || data.g || '';
      if (imageToolType) {
        setImageToolDataForUser(user, imageToolType, imageToolData);
      }
      break;
    }

    case T.CPM:
      user.patternMode = data.pm || false;
      break;

    case T.IMG_PASTE:
      user.activeImage = { sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh, g: data.g };
      user.activeSelectionCorners = null;
      user.activeSelectionSourceCrop = null;
      break;

    case T.SEL_LIFT:
      if (data.g) {
        user.activeImage = { sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh, g: data.g };
        user.activeSelectionCorners = null;
        user.activeSelectionSourceCrop = null;
        // Forward the lifted snapshot so remote clients reuse the sender's exact pixels
        // instead of attempting to recapture from their own canvases.
        //
        // The sender is NOT excluded. A lift commits a destination-out erase of the
        // source area on every client, including the sender's own optimistic one,
        // and that erase needs this broadcast's authoritative seq — otherwise it
        // stays at seq 0, which _sortStrokeStack floats to the TOP of the stack,
        // above the stamp that SEL_COMMIT sequences, and the erase wipes the
        // placement. The sender's handler is reconcile-only (SelectionHandlers
        // 'sel_lift'), so this does not re-run the lift. One broadcast, one seq:
        // splitting it into a second sender-only echo would assign a different seq
        // and break the pairing it exists to establish.
        if (!ws?.isShadowBanned) {
          // Rebuilt, not relayed — so every field the receiver needs has to be
          // listed here by hand. `m` is the drawer's full-board mirror state:
          // the lift erases the mirrored counterparts too, and the receiver
          // cannot infer the toggle (see broadcastSelectionLift).
          broadcastToRoom(room, { t: T.SEL_LIFT, u: sessionIndex, sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh, cr: data.cr, g: data.g, a: data.a, m: data.m, selExtendedWarp: data.selExtendedWarp });
        }
        return;
      }
      break;

    case T.SEL_MOVE:
      if (data.cr) {
        user.activeSelectionCorners = Array.from(data.cr);
        if (data.cbt) {
          user.activeSelectionSourceCrop = Array.from(data.cbt);
        } else if (data.cb && !user.activeSelectionSourceCrop) {
          user.activeSelectionSourceCrop = Array.from(data.cb);
        }
      }
      break;

    case T.SEL_MASK:
      if (data.mk) {
        user.activeMask = {
          sx: data.sx,
          sy: data.sy,
          sw: data.sw,
          sh: data.sh,
          ps: Array.isArray(data.ps) ? Array.from(data.ps) : null,
          // The seq this SEL_MASK is about to be broadcast under. The join
          // serve needs it to decide whether the mask predates the checkpoint
          // it is about to send (arm it up front) or was armed inside the tail
          // (leave it to the tail, which carries SEL_MASK as tool state at the
          // right position). Without the distinction, a mask armed late gets
          // pre-armed and clips every EARLIER stroke the tail replays — see
          // SyncCoordinator._sendActiveMasksToJoiner.
          //
          // +1 because this state update runs before the broadcastToRoom call
          // at the bottom of handleBroadcast, which is what allocates the seq.
          armedAtSeq: (room?.messageSequence ?? 0) + 1
        };
      } else {
        user.activeMask = null;
      }
      break;

    case T.OBSCURE_REGION: {
      if (ws?.isShadowBanned) return;
      if (getTrustedFeatureAuthority(ws) < Role.TRUSTED) {
        sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only trusted users can create or remove obscured regions' });
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(data.g || '{}');
      } catch (err) {
        debug.warn('[ObscureRegion] Invalid payload', err);
        return;
      }
      const id = typeof payload.id === 'string' ? payload.id.slice(0, 80) : '';
      if (!id) return;
      if (payload.remove) {
        room.obscureRegions?.delete(id);
        data.g = JSON.stringify({ id, remove: true });
      } else {
        const x = Number(payload.x);
        const y = Number(payload.y);
        const width = Number(payload.width);
        const height = Number(payload.height);
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
        const lassoPath = Array.isArray(payload.lassoPath)
          ? payload.lassoPath
              .slice(0, 2048)
              .map(point => ({ x: Number(point?.x), y: Number(point?.y) }))
              .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
          : null;
        const normalizedRegion = {
          id,
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
          ...(lassoPath && lassoPath.length >= 3 ? { lassoPath } : {})
        };
        room.obscureRegions?.set(id, normalizedRegion);
        data.g = JSON.stringify(normalizedRegion);
      }
      break;
    }

    case T.SEL_COMMIT:
      // Applying a pasted/uploaded image bakes the floating selection into the
      // canvas. Do not replay the old IMG_PASTE to future joiners.
      clearActiveFloatingSelection(user);
      break;

    // SEL_STAMP and SEL_FILL are deliberately NOT here — they keep the float
    // alive (SelectTool.stamp: "stamp to canvas without clearing it";
    // fillSelection paints into floatingCanvas and returns with the selection
    // still active), and this list is the ONLY thing that decides whether a
    // joiner is told about an in-flight floating selection at all
    // (SyncCoordinator._sendActiveImagesToJoiner bails on `!activeImage`).
    //
    // Clearing on a stamp meant: lift -> move -> stamp -> move+scale -> (still
    // floating) -> someone joins/syncs, and the float, its current corners and
    // its cumulative source crop were all gone. Everything up to the last stamp
    // rebuilt from the tail; the moves AFTER it had nothing to ride on, so the
    // selection came back at the last stamp's position and scale. This is the
    // same membership mistake StrokeTape._endsSelection had — see
    // StrokeTape._continuesSelection.
    case T.SEL_CANCEL:
    case T.SEL_DELETE:
    case T.SEL_MERGE:
    case T.SEL_TO_BRUSH:
      clearActiveFloatingSelection(user);
      break;

    case T.CTHN:
      user.thinning = data.th;
      break;

    case T.CSIM:
      user.simulatePressure = data.sim;
      break;

    case T.CPT:
      user.pressureTargets = data.pt;
      break;
  }

  // Permission-gated actions inside the broadcast path
  if (data.t === T.CLR) {
    if (!authorize(ws, Action.CLEAR_CANVAS, sendTo, T.MOD_RESULT)) return;
    // Clear all tile data when canvas is cleared
    room.clearAllTiles();
  }

  if (MUTED_BLOCKED.has(data.t)) {
    for (const client of wss.clients) {
      if (client.sessionIndex === sessionIndex && client.isMuted) {
        if (client.userRole >= Role.MOD) {  // MOD(4)+ are exempt from mute
          break;
        }
        return;
      }
    }
  }

  if (SILENCED_BLOCKED.has(data.t)) {
    for (const client of wss.clients) {
      if (client.sessionIndex === sessionIndex && client.isSilenced) {
        if (client.userRole >= Role.MOD) {  // MOD(4)+ are exempt from silence
          break;
        }
        sendTo(client, { t: T.MOD_RESULT, a: false, authError: 'You are silenced' });
        return;
      }
    }

    const spamResult = checkChatSpam(ws);
    if (spamResult) {
      if (spamResult.silenced) {
        ws.isSilenced = true;
        const roomUser = room.sessionManager.getUser(sessionIndex);
        if (roomUser) roomUser.isSilenced = true;
        if (getDB()) {
          await issueModAction({
            type: 'silence',
            targetUserId: ws.userId || null,
            targetUsername: ws.username || `User ${sessionIndex}`,
            targetIp: ws.clientIp || null,
            ipScope: 'subnet',
            reason: 'Automatic: chat spam',
            issuedBy: null,
            issuedByUsername: 'System (auto-mod)',
            issuedByRole: Role.MOD,
            duration: CHAT_SPAM_AUTO_SILENCE_MINUTES,
            roomId: room.id
          });
        }
        broadcastUsersForRoom(room);
      }
      sendTo(ws, {
        t: T.CHAT_WARNING,
        chatWarningLevel: spamResult.level,
        chatCooldownMs: spamResult.silenced ? 0 : spamResult.cooldownMs
      });
      return;
    }
  }

  if (data.t === T.MIRROR_REGION) {
    if (ENABLE_SERVER_REPLAY_DB && (room.settings.dedicatedReplayUser || room._electedUploader)) {
      getRecorder(room.id).record({ ...data, u: sessionIndex });
    }
    broadcastToRoom(room, buildSettingsPayload(room));
    return;
  }

  if (ws?.isShadowBanned) {
    return;
  }

  // Record delta for replay system
  const outgoing = { ...data, u: sessionIndex };
  if (ENABLE_SERVER_REPLAY_DB && (room.settings.dedicatedReplayUser || room._electedUploader)) {
    getRecorder(room.id).record(outgoing);
  }

  broadcastToRoom(room, outgoing, sessionIndex);
}

const BATCH_INTERVAL_MS = 16;
// Weak clients get a coarser flush cadence: fewer, larger batched frames
// instead of one every 16ms. This does not change wire ORDERING (the outbox
// is still strict FIFO, concatenated in arrival order) — only how often a
// given client's queue is flushed. Matches the client's own already-proven
// 33ms remote-preview render coalescing (see
// brush_remote_preview_unthrottled_fixed / remote_preview_render_coalescing);
// this is the same idea applied one hop earlier, at message DELIVERY rather
// than at render, so a weak client also pays fewer parse/dispatch calls, not
// just fewer renders. `ws.lowPowerMode` is an existing signal (client
// self-reports via T.PONG, see providerScoring.js's uploader-election use of
// the same field) — no new detection, no client-side change: the client
// already parses an arbitrary-size concatenated batch (WebSocketClient.js
// _processMessageQueue), so widening the interval for one client changes
// nothing it needs to know about.
const LOW_POWER_BATCH_INTERVAL_MS = 33;
const clientOutbox = new Map();
let currentOutboxQueuedBytes = 0;
let batchTimerRunning = false;
const wsBackpressureStats = {
  slowConsumerCloses: 0,
  directSendRejected: 0,
  outboxRejected: 0,
  flushSendRejected: 0,
  sendErrors: 0,
  peakQueuedBytes: 0,
  lastSlowConsumerAt: null
};

function getBufferedAmount(ws) {
  return Math.max(0, Number(ws?.bufferedAmount || 0));
}

function getOutbox(ws, create = false) {
  let outbox = clientOutbox.get(ws);
  if (!outbox && create) {
    outbox = { buffers: [], bytes: 0 };
    clientOutbox.set(ws, outbox);
  }
  return outbox || null;
}

function noteQueuedBytes(byteLength) {
  currentOutboxQueuedBytes += byteLength;
  if (currentOutboxQueuedBytes > wsBackpressureStats.peakQueuedBytes) {
    wsBackpressureStats.peakQueuedBytes = currentOutboxQueuedBytes;
  }
}

function discardClientOutbox(ws) {
  const outbox = clientOutbox.get(ws);
  if (outbox?.bytes) {
    currentOutboxQueuedBytes = Math.max(0, currentOutboxQueuedBytes - outbox.bytes);
  }
  clientOutbox.delete(ws);
}

function closeSlowConsumer(ws, source) {
  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    discardClientOutbox(ws);
    return false;
  }

  wsBackpressureStats.slowConsumerCloses++;
  wsBackpressureStats.lastSlowConsumerAt = Date.now();
  discardClientOutbox(ws);

  const label = ws.sessionIndex !== undefined ? `session ${ws.sessionIndex}` : 'unassigned session';
  debug.warn(`[WS] Closing slow consumer (${label}, source=${source}, buffered=${getBufferedAmount(ws)})`);
  try {
    ws.close(1013, 'slow-consumer');
  } catch {
    try { ws.terminate(); } catch (_) {}
  }
  return false;
}

function sendEncodedBuffer(ws, buffer, source = 'direct') {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  const byteLength = buffer?.byteLength ?? buffer?.length ?? 0;
  if (getBufferedAmount(ws) + byteLength > MAX_WS_BUFFERED_BYTES) {
    if (source === 'flush') wsBackpressureStats.flushSendRejected++;
    else wsBackpressureStats.directSendRejected++;
    return closeSlowConsumer(ws, source);
  }

  try {
    ws.send(buffer);
    return true;
  } catch (error) {
    wsBackpressureStats.sendErrors++;
    debug.warn(`[WS] Send failed (${source}):`, error?.message || error);
    return closeSlowConsumer(ws, `${source}-error`);
  }
}

function enqueueClientOutbox(ws, buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  const byteLength = buffer?.byteLength ?? buffer?.length ?? 0;
  const outbox = getOutbox(ws, true);
  const nextBytes = outbox.bytes + byteLength;
  const nextMessages = outbox.buffers.length + 1;

  if (
    nextBytes > MAX_OUTBOX_BYTES ||
    nextMessages > MAX_OUTBOX_MESSAGES ||
    getBufferedAmount(ws) + nextBytes > MAX_WS_BUFFERED_BYTES
  ) {
    wsBackpressureStats.outboxRejected++;
    return closeSlowConsumer(ws, 'outbox');
  }

  // Stored by reference. Callers must hand over a buffer that outlives this
  // call — i.e. NOT a raw `Msg.encode(...).finish()` view into protobufjs's
  // pooled slab, which the next encode overwrites. broadcastToRoom (the only
  // caller) takes that copy once per broadcast rather than once per client.
  outbox.buffers.push(buffer);
  outbox.bytes = nextBytes;
  noteQueuedBytes(byteLength);
  return true;
}

function getCurrentQueuedBytes() {
  return currentOutboxQueuedBytes;
}

function getBackpressureSnapshot() {
  let queuedMessages = 0;
  let queuedBytes = 0;
  let maxBufferedAmount = 0;
  let openSockets = 0;

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) openSockets++;
    maxBufferedAmount = Math.max(maxBufferedAmount, getBufferedAmount(client));
  }

  for (const outbox of clientOutbox.values()) {
    queuedMessages += outbox.buffers?.length || 0;
    queuedBytes += outbox.bytes || 0;
  }

  return {
    activeSockets: wss.clients.size,
    openSockets,
    clientsWithOutbox: clientOutbox.size,
    queuedBytes,
    queuedMessages,
    maxBufferedAmount,
    limits: {
      maxWsBufferedBytes: MAX_WS_BUFFERED_BYTES,
      maxOutboxBytes: MAX_OUTBOX_BYTES,
      maxOutboxMessages: MAX_OUTBOX_MESSAGES
    },
    ...wsBackpressureStats
  };
}

/**
 * Starts the timer for flushing batched messages to clients.
 */
function startBatchTimer() {
  if (batchTimerRunning) return;
  batchTimerRunning = true;
  setInterval(flushAllOutboxes, BATCH_INTERVAL_MS);
}

/**
 * Flushes a single client's batched outbox, sending a concatenated binary
 * frame (or a lone buffer). Used both by the periodic flush and before an
 * out-of-band ordered send (e.g. a sequenced snapshot restore) so the queued
 * batchable messages reach the client *before* the ordered message.
 * @param {WebSocket} ws
 */
function flushClientOutbox(ws) {
  const outbox = clientOutbox.get(ws);
  const buffers = outbox?.buffers;
  if (!buffers || buffers.length === 0) return;

  if (ws.readyState !== WebSocket.OPEN) {
    discardClientOutbox(ws);
    return;
  }

  let sent = false;
  if (buffers.length === 1) {
    sent = sendEncodedBuffer(ws, buffers[0], 'flush');
  } else {
    let totalLen = 0;
    for (let i = 0; i < buffers.length; i++) totalLen += 4 + buffers[i].length;

    const frame = new Uint8Array(totalLen);
    const view = new DataView(frame.buffer);
    let offset = 0;
    for (let i = 0; i < buffers.length; i++) {
      view.setUint32(offset, buffers[i].length);
      frame.set(buffers[i], offset + 4);
      offset += 4 + buffers[i].length;
    }
    sent = sendEncodedBuffer(ws, frame, 'flush');
  }

  if (sent) {
    discardClientOutbox(ws);
  }
}

/**
 * Flushes all client outboxes, sending concatenated binary frames.
 *
 * Runs every BATCH_INTERVAL_MS (the scheduling granularity), but a client
 * flagged `lowPowerMode` is only actually flushed every
 * LOW_POWER_BATCH_INTERVAL_MS / BATCH_INTERVAL_MS-th tick — its messages sit
 * in the outbox a little longer and go out as fewer, larger frames. This is
 * the periodic path only; `flushClientOutbox` is still called directly
 * (bypassing this gate) wherever an ordered/sequenced send needs the outbox
 * drained immediately first — see its own call sites.
 */
function flushAllOutboxes() {
  const now = Date.now();
  for (const ws of clientOutbox.keys()) {
    if (ws.lowPowerMode) {
      const dueAt = ws._nextLowPowerFlushAt || 0;
      if (now < dueAt) continue;
      ws._nextLowPowerFlushAt = now + LOW_POWER_BATCH_INTERVAL_MS;
    } else {
      ws._nextLowPowerFlushAt = 0;
    }
    flushClientOutbox(ws);
  }
}

const BATCHABLE_TYPES = new Set([
  T.MM, T.MD, T.MU, T.CP, T.CS, T.CT, T.CC,
  T.CSP, T.CSM, T.CHD, T.CBR, T.CL, T.CBM, T.CANCEL,
  T.KP, T.TEXT_APPLY, T.TEXT_REMOVE, T.HIDE_CURSOR, T.SHOW_CURSOR, T.GMP, T.GPT, T.IMAGE_TOOL, T.AFK,
  T.CTHN, T.CSIM, T.CPT, T.FILL, T.CF
]);

/**
 * Broadcasts a payload to all clients in a room, with optional batching for high-frequency messages.
 * @param {Object} room - The room object.
 * @param {Object} payload - The message payload.
 * @param {number|null} [excludeIndex=null] - The session index to exclude.
 */
function broadcastToRoom(room, payload, excludeIndex = null) {
  const msg = { ...payload };

  if (room && room.messageSequence !== undefined) {
    msg.seq = ++room.messageSequence;
  }

  // One copy, taken once. `Msg.encode(...).finish()` hands back a view into
  // protobufjs's pooled slab, which the very next encode overwrites — so the
  // bytes must be copied before they outlive this call. Everything below
  // (strokeLog, strokeTape, history, every client's outbox) can then share
  // this one stable buffer instead of each taking its own copy; the outbox
  // used to slice per client, making a broadcast O(clients) copies.
  const buffer = Msg.encode(msg).finish().slice();
  const shouldBatch = BATCHABLE_TYPES.has(payload.t);

  // Phase 1: append commit-class messages to the room's stroke fingerprint log.
  // This is diagnostic-only for now — the actual parity protocol arrives in Phase 2.
  if (room?.strokeLog && isCommitType(payload.t)) {
    room.strokeLog.record({
      seq: msg.seq,
      t: payload.t,
      userId: payload.u | 0,
      bytes: buffer,
    });
  }

  // Retain stroke geometry (MD/MM + tool-state preamble) keyed by commit seq so
  // a fresh joiner can redraw post-checkpoint strokes from the original commands.
  // Commit bytes themselves live in strokeLog; this fills the non-committed gap.
  if (room?.strokeTape) {
    room.strokeTape.observe(payload.t, payload.u | 0, buffer, msg.seq, isCommitType(payload.t), payload);
  }

  // Between-stroke cursor movement for the history backfill. The tape only
  // retains MM frames INSIDE a stroke (they ride in that stroke's preamble and
  // ship with its commit), so a backfilled tape drew every stroke correctly and
  // then teleported each cursor straight to the start of the next one. Hover
  // moves belong to no commit and are otherwise dropped entirely.
  //
  // `buffer` is already a private copy (see above), so it can be handed over
  // directly — the tape keeps it for the life of the retention window.
  if (room?.history && payload.t === T.MM && !room.strokeTape?.isMidStroke?.(payload.u | 0)) {
    room.history.recordCursor({
      seq: msg.seq,
      ts: Date.now(),
      userId: payload.u | 0,
      bytes: buffer,
    });
  }

  // Commit-class messages echo back to the sender so their strokeLog stays
  // in lockstep with the server's. The client recognizes self-echoes by
  // sessionIndex and skips the draw handlers (it already drew locally).
  const echoCommitsToSender = isCommitType(payload.t);

  room.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (excludeIndex != null && client.sessionIndex == excludeIndex && !echoCommitsToSender) {
        return;
      }
      if (shouldSkipJoinSyncPending(client, payload.t)) {
        return;
      }
      if (shouldBatch) {
        if (shouldSkipInactiveRecipient(room, client, payload.t)) {
          return;
        }
        enqueueClientOutbox(client, buffer);
      } else {
        if (shouldSkipInactiveRecipient(room, client, payload.t)) {
          return;
        }
        // Drain anything already queued for this client first, so the wire
        // order matches the sequence order. Without it an unbatched message
        // (UNDO, SEL_DELETE, …) overtakes the MD/MM/MU still sitting in the
        // 16ms outbox — the recipient then applies an undo before the stroke it
        // targets exists, and the stroke commits afterwards and survives.
        // broadcastSequencedRestore already flushes for exactly this reason.
        // Cheap: every high-frequency type is batched, so this branch is rare
        // and the flush no-ops when the outbox is empty.
        flushClientOutbox(client);
        sendEncodedBuffer(client, buffer, `roomBroadcast:${payload?.t ?? 'unknown'}`);
      }
    }
  });
}

/**
 * Broadcasts a board-snapshot restore to every client in a room as a
 * *sequenced* commit, so it lands at a fixed point in the stroke stream and
 * every client applies it at the same z-position (fixes Bug A — silent pixel
 * divergence from the restore racing the batched MU stream; see
 * docs/000Sync_Parity_Findings.md).
 *
 * Unlike the old room.broadcastToAll (immediate, unsequenced, off the outbox),
 * this:
 *   1. assigns the next room seq so the restore is ordered against MU commits,
 *   2. records it in the room's strokeLog (parity now covers the restore), and
 *   3. flushes each client's batched outbox *before* sending the restore, so
 *      all strokes the server sequenced earlier reach the client first.
 *
 * @param {Object} room - The room (RoomManager Room instance).
 * @param {Object} payload - The BOARD_SNAPSHOT_RESTORE payload.
 */
function broadcastSequencedRestore(room, payload) {
  if (!room) return;

  const msg = { ...payload };

  if (room.messageSequence !== undefined) {
    msg.seq = ++room.messageSequence;
  }

  const buffer = Msg.encode(msg).finish();

  if (room.strokeLog && isCommitType(payload.t)) {
    room.strokeLog.record({
      seq: msg.seq,
      t: payload.t,
      userId: payload.u | 0,
      bytes: buffer,
    });
  }

  room.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    // A joiner mid-sync gets the restore via its command tail (it's a commit
    // in the strokeLog) — sending it live too would double-apply it.
    if (shouldSkipJoinSyncPending(client, payload.t)) return;
    // Drain any queued batchable messages (MM/MU/...) first so they precede
    // the restore in this client's receive order — same per-client ordering
    // the live stream already relies on.
    flushClientOutbox(client);
    sendEncodedBuffer(client, buffer, `sequencedRestore:${payload?.t ?? 'unknown'}`);
  });

  // Return the seq this restore was assigned so callers can re-baseline join
  // sync against it (truncate the command tail, register the restore image as
  // the new join checkpoint). Undefined when the room has no sequence counter.
  return msg.seq;
}

/**
 * Performs the visible part of a disconnect — broadcasts LEFT, frees the
 * sessionIndex, and runs the room-empty cleanup. Split out of the close
 * handler so it can also be triggered by the grace timer when a resumable
 * client fails to come back in time.
 */
// Grace window during which mod actions (unban/unmute) for a sessionIndex
// can still resolve back to the user that just departed under it.
const RECENT_SESSION_TTL_MS = 10 * 60 * 1000;

function recordRecentSession(room, sessionIndex, ws) {
  if (!room || sessionIndex === undefined || !ws) return;
  // A kick or an orphan sweep may have no socket left to read identity from.
  // Don't overwrite a good entry (recorded by an earlier close) with an empty
  // one — the mod-action path reads this back to resolve unban/unmute targets.
  if (!ws.userId && !ws.username && !ws.clientIp && room._recentSessions?.has(sessionIndex)) return;
  if (!room._recentSessions) room._recentSessions = new Map();
  room._recentSessions.set(sessionIndex, {
    userId: ws.userId || null,
    username: ws.username || '',
    clientIp: ws.clientIp || null,
    deviceId: ws.deviceId || null,
    fingerprintId: ws.fingerprintId || null,
    departedAt: Date.now(),
  });
}

function getRecentSession(room, sessionIndex) {
  const entry = room?._recentSessions?.get(sessionIndex);
  if (!entry) return null;
  if (Date.now() - entry.departedAt > RECENT_SESSION_TTL_MS) {
    room._recentSessions.delete(sessionIndex);
    return null;
  }
  return entry;
}

function finalizeSessionRemoval(room, sessionIndex, ws) {
  if (!room || sessionIndex === undefined) return;
  // Reachable more than once for the same index: a kick retires the session up
  // front and the socket's eventual 'close' follows, and the orphan sweep can
  // race a close. Only the visible half (the LEFT peers prune the cursor on) is
  // gated on the record still existing; the bookkeeping below is idempotent.
  const hadUser = !!room.sessionManager.getUser(sessionIndex);
  recordRecentSession(room, sessionIndex, ws);
  room.clearPendingSnapshotRequest?.(sessionIndex);
  room.sessionManager.removeUser(sessionIndex);
  room.sessionManager.freeSessionIndex(sessionIndex);
  // Discard any in-flight stroke geometry the departing user never committed.
  room.strokeTape?.dropUser?.(sessionIndex);
  if (hadUser && !ws.isShadowBanned) {
    broadcastToRoom(room, { t: T.LEFT, u: sessionIndex });
  }

  if (room.sessionManager.getUserCount() === 0) {
    room.becameEmptyAt = Date.now();
    room.settings.mirror = false;
    room.settings.mirrorRegions = [];
    room.setPreview(null);
    room.clearAllTiles();
    stopElection(room);
    removeRecorder(room.id);
    roomManager.broadcastRoomListUpdate();
  }

  if (room.getClientCount() === 0 && !(room.pendingDisconnects?.size)) {
    roomManager.cleanupEmptyRooms();
  }
}

// A user record in a room's SessionManager is only ever removed by its socket's
// 'close' handler. When that close never fires — a wedged tab whose transport
// stays half-open past the ping reaper, a socket whose room lookup came back
// null, a client that vanished mid room-switch — the record outlives the
// connection with nothing to reconcile the two. Peers keep drawing that cursor
// forever, the user never goes AFK (checkAfkUsers marks them, but there is
// no one to stop sending; they simply sit there), and a moderator's kick found
// no socket to close and did nothing.
//
// Two strikes rather than one: a sweep can land in a window where the socket is
// legitimately not yet OPEN, and 60s of ghost beats reaping a live user.
const GHOST_SWEEP_INTERVAL_MS = 30_000;
const GHOST_SWEEP_STRIKES = 2;
let ghostSweepInterval;

// How long a kicked socket gets to acknowledge its close frame before we drop
// the transport outright. Long enough for a healthy client to see code 4002 and
// show "you were kicked", short enough that a wedged one doesn't hold its slot.
const KICK_TERMINATE_GRACE_MS = 3_000;

function sweepOrphanedSessions() {
  if (!roomManager?.rooms) return;

  for (const room of roomManager.rooms.values()) {
    if (!room.sessionManager) continue;
    const strikes = room._orphanStrikes || (room._orphanStrikes = new Map());
    const doomed = [];

    room.sessionManager.users.forEach((user, sessionIndex) => {
      if (hasOpenClientForSession(room, sessionIndex) || isSessionPendingDisconnect(room, sessionIndex)) {
        strikes.delete(sessionIndex);
        return;
      }
      const count = (strikes.get(sessionIndex) || 0) + 1;
      strikes.set(sessionIndex, count);
      if (count >= GHOST_SWEEP_STRIKES) doomed.push(sessionIndex);
    });

    // Strikes for indices that are no longer users at all (already departed).
    for (const sessionIndex of [...strikes.keys()]) {
      if (!room.sessionManager.getUser(sessionIndex)) strikes.delete(sessionIndex);
    }

    for (const sessionIndex of doomed) {
      const name = room.sessionManager.getUser(sessionIndex)?.name || '<unnamed>';
      console.warn(`[WS] Sweeping orphaned session ${sessionIndex} ("${name}") in room "${room.id}" — no open socket`);
      strikes.delete(sessionIndex);
      finalizeSessionRemoval(room, sessionIndex, getRoomClientBySessionIndex(room, sessionIndex) || {});
    }

    if (doomed.length) broadcastUsersForRoom(room);
  }
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Fork: messenger connections use /messenger path
  if (url.pathname === '/messenger') {
    const clientIp = getClientIp(req);
    const connectionLimit = messengerRateLimiter.consume(rateLimitKey('messenger:connect', clientIp), MESSENGER_CONNECTION_LIMIT);
    if (!connectionLimit.allowed) {
      ws.close(4408, 'Rate limit exceeded');
      return;
    }

    const userId = String(url.searchParams.get('userId') || '').trim();
    const token = String(url.searchParams.get('token') || '').trim();
    const db = getDB();
    if (!db) {
      ws.close(1013, 'Database unavailable');
      return;
    }

    const authUser = await getUserFromToken(token, { projection: { username: 1 } });
    if (!userId || !authUser || !matchesMessengerIdentity(userId, authUser)) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    ws.clientIp = clientIp;
    ws.userId = authUser._id.toString();
    ws.username = authUser.username;

    messengerClients.set(ws.username, ws);
    debug(`[Messenger] ${ws.username} connected`);

    ws.on('message', async (data) => {
      try {
        const envelope = JSON.parse(data.toString());
        const type = String(envelope?.type || '');
        const payload = envelope?.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
        const db = getDB();
        if (!db || !type) return;

        const actionLimit = messengerRateLimiter.consume(
          rateLimitKey('messenger:message', clientIp, type),
          MESSENGER_MESSAGE_LIMIT
        );
        if (!actionLimit.allowed) {
          ws.close(4408, 'Rate limit exceeded');
          return;
        }

        if (type === 'init_chat') {
          const roomId = String(payload.roomId || '').trim();
          const participants = roomId.split(':');
          if (participants.length !== 2 || !participants.includes(ws.username)) return;

          const history = await getMessengerHistory(roomId, 50);
          sendEncodedBuffer(ws, JSON.stringify({ type: 'history', payload: history }), 'messenger:history');

        } else if (type === 'get_inbox') {
          const inbox = await getMessengerInbox(ws.username);
          sendEncodedBuffer(ws, JSON.stringify({ type: 'inbox', payload: inbox }), 'messenger:inbox');

        } else if (type === 'send_message') {
          const receiverId = String(payload.receiver_id || '').trim();
          const roomId = String(payload.room_id || '').trim();
          const content = String(payload.content || '');

          if (!receiverId || !roomId || !content.trim()) return;
          if (receiverId.length > 32 || content.length > 8192) return;
          if (!isValidMessengerRoomId(roomId, ws.username, receiverId)) return;

          // Encrypt at rest with the server-held secret; clients exchange plaintext over TLS.
          const { encrypted_content, iv } = encryptMessageContent(content, roomId);
          const storedDoc = {
            room_id: roomId,
            sender_id: ws.username,
            receiver_id: receiverId,
            encrypted_content,
            iv,
            timestamp: Date.now()
          };
          await db.collection('messages').insertOne(storedDoc);

          const { encrypted_content: _ec, iv: _iv, ...rest } = storedDoc;
          const relayDoc = { ...rest, content };

          if (messengerClients.has(receiverId)) {
            sendEncodedBuffer(messengerClients.get(receiverId), JSON.stringify({ type: 'new_message', payload: relayDoc }), 'messenger:new_message');
          }
          sendEncodedBuffer(ws, JSON.stringify({ type: 'new_message', payload: relayDoc }), 'messenger:new_message');
        }
      } catch (err) {
        console.error('[Messenger] Message error:', err);
      }
    });

    ws.on('close', () => {
      messengerClients.delete(ws.username);
      debug(`[Messenger] ${ws.username} disconnected`);
    });

    if (ws.readyState === WebSocket.OPEN) {
      sendEncodedBuffer(ws, JSON.stringify({ type: 'ready' }), 'messenger:ready');
    }

    return;
  }

  // Drawing server connection
  try {
    // Rate limit new connections per IP
    const connIp = getClientIp(req);
    if (!DISABLE_RATE_LIMITS && !wsConnectionLimiter.check(connIp)) {
      debug.warn(`[WS] Connection rate limited: ${connIp}`);
      ws.close(1008, 'Too many connections');
      return;
    }

    debug(`[WS] New connection attempt from ${req.socket.remoteAddress}`);

    ws.clientIp = connIp;
    ws.skipUploadBps = isLocalhostRequest(req, connIp);
    if (!DISABLE_RATE_LIMITS) {
      const connectionLimit = wsRateLimiter.consume(rateLimitKey('ws:connect', ws.clientIp), WS_CONNECTION_LIMIT);
      if (!connectionLimit.allowed) {
        ws.close(4408, 'Rate limit exceeded');
        return;
      }
    }

    ws.userRole = Role.GUEST;
    ws.globalRole = Role.GUEST;
    ws.roomRole = 0;
    ws.userId = null;
    ws.username = null;
    ws.isMuted = false;
    ws.clientAsn = lookupAsnForIp(ws.clientIp);
    ws.clientCountry = lookupCountryForIp(ws.clientIp);
    ws.isVpnNetwork = isVpnAsn(ws.clientAsn);
    ws.isVPN = ws.isVpnNetwork;
    ws.rateLimitId = crypto.randomUUID();
    ws.userAgent = String(req.headers['user-agent'] || '').slice(0, 512);
    ws.clientSubnet = getIpSubnet(ws.clientIp);
    ws.deviceId = String(url.searchParams.get('deviceId') || '').trim();
    ws.fingerprintId = String(url.searchParams.get('fingerprintId') || '').trim();
    ws.clientAppVersion = String(url.searchParams.get('v') || '').trim().slice(0, 64);
    ws.identitySummary = null;
    const identityFromQuery = String(url.searchParams.get('identity') || '').trim();
    if (identityFromQuery) {
      try {
        const parsedIdentity = JSON.parse(identityFromQuery);
        if (parsedIdentity && typeof parsedIdentity === 'object' && !Array.isArray(parsedIdentity)) {
          ws.identitySummary = parsedIdentity;
        }
      } catch (error) {
        debug.warn('[IdentityDebug][server] Failed to parse identity query payload:', error.message);
      }
    }
    debug('[IdentityDebug][server] ws handshake identity', {
      roomId: sanitizeRoomId(url.searchParams.get('room')),
      deviceId: ws.deviceId || null,
      fingerprintId: ws.fingerprintId || null,
      identitySummary: ws.identitySummary
    });

    const roomId = sanitizeRoomId(url.searchParams.get('room'));
    logAsnHandshakeContext(ws, roomId);
    debug(`[Room] Parsed room ID: ${roomId}`);

    if (!isLocalhostRequest(req, connIp) && roomId !== '_discovery') {
      const versionPolicy = await readVersionPolicy();
      if (isClientVersionMismatch(ws.clientAppVersion, versionPolicy)) {
        const latest = versionPolicy?.latest || versionPolicy?.minRequired || 'current server version';
        debug.warn(`[Version] Rejecting client version "${ws.clientAppVersion || 'missing'}"; server requires "${latest}"`);
        ws.close(4009, `version-mismatch:${latest}`);
        return;
      }
    }

    const room = roomManager.getOrCreateRoom(roomId);
    // Wire the sequenced-restore broadcaster onto the room. Lives in index.js
    // because it needs the module-level outbox/seq machinery; the room (in
    // RoomManager) and snapshot handlers call it via room.broadcastSequencedRestore.
    if (!room.broadcastSequencedRestore) {
      room.broadcastSequencedRestore = (payload) => broadcastSequencedRestore(room, payload);
    }
    debug(`[Room.Connection] About to add client to room: ${roomId}, current client count: ${room.getClientCount()}`);
    // Suppress room CONTENT broadcasts (draw stream / commits — everything the
    // checkpoint+tail join sync reproduces) until SyncCoordinator serves the
    // tail. Without this, strokes committed between joining the client set and
    // the tail's latestSeq read arrive TWICE (once live, once via the tail) —
    // and strokes straddling the join commit an extra truncated copy. Cleared
    // synchronously with the tail-seq read in _serveCheckpointJoin.
    //
    // Only armed when the room already has peers: a lone first joiner never
    // sends SYNC_REQUEST (the client's truly-alone fallback just marks sync
    // complete), so an unconditional flag would leave it deaf to content
    // until the safety valve. With no peers there is no prior traffic to
    // duplicate anyway. If bots/users pour in right after and the client DOES
    // request a sync, _serveCheckpointJoin re-arms suppression itself.
    if (room.getClientCount() > 0) {
      ws.joinSyncPendingSince = Date.now();
    }
    room.addClient(ws);
    // Start the periodic auto-checkpoint timer now that the room has an
    // occupant. This pairs with the removeClient()/updateSnapshotTimer() call in
    // the disconnect handler. Without it the timer was only ever started as a
    // SIDE EFFECT of a disconnect (or a room-register / account-register /
    // account-login), so a room whose users only ever joined — the common case,
    // and every anonymous lobby session — never minted a single checkpoint and
    // served every late joiner a stale one.
    room.updateSnapshotTimer();

    debug(`[Room.Connection] Client joined room: ${roomId}, total clients after addClient: ${room.getClientCount()}`);

    ws.pingRtt = null;
    ws.lowPowerMode = false;
    ws.tabHidden = false;
    ws.missedPongs = 0;
    // 2 missed pongs (~60s of silence) indicates a half-open TCP — reap it so
    // the user doesn't linger as a ghost cursor until the OS keepalive trips.
    const MAX_MISSED_PONGS = 2;
    ws.pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(ws.pingInterval);
        return;
      }
      if (ws.pingSentAt) {
        // Previous ping never got a PONG response.
        ws.missedPongs++;
        if (ws.missedPongs >= MAX_MISSED_PONGS) {
          debug.warn(`[WS] Reaping half-open socket (session ${ws.sessionIndex ?? 'unassigned'}, ${ws.missedPongs} missed pongs)`);
          clearInterval(ws.pingInterval);
          try { ws.terminate(); } catch (_) {}
          return;
        }
      }
      ws.pingSentAt = Date.now();
      sendTo(ws, { t: T.PING });
    }, 30000);
  } catch (err) {
    console.error('[WS] Connection handler error:', err);
    ws.close(1011, 'Server error during connection');
  }

  // Per-connection serialization. This handler AWAITS (sanitizeMessage decodes
  // and validates inline images for SEL_LIFT / IMG_PASTE / GLITCH_RESULT), and
  // 'message' fires again while that promise is pending — so the next message
  // from the SAME socket ran to completion and was relayed FIRST. That breaks
  // the single-socket ordering guarantee the seq/reconcile design rests on.
  //
  // Measured: a selection drag emitted SEL_LIFT then SEL_MOVE, and every
  // observer received SEL_MOVE then SEL_LIFT — the move arrived before the
  // floating canvas existed, so handleSelectionMove early-returned and the
  // first move increment was dropped. Chaining keeps one socket's messages
  // strictly in order; sockets stay independent of each other, so a slow image
  // validation delays only its own sender.
  const handleClientMessage = async (rawData) => {
    if (isShuttingDown) {
      // Drop silently; client will see the connection close with code 4000.
      return;
    }

    const room = roomManager.getRoomByClient(ws);
    if (!room) {
      debug.warn('[WS] Message from client not in any room');
      return;
    }

    try {
      // Every client frame is protobuf and starts with field 1 (`t`), whose
      // tag byte is 0x08 — protobufjs writes explicitly-set fields even at
      // their default, so t=CONNECT(0) still emits it. Anything else is not
      // ours. (A JSON ingress branch used to sit here for `{`/`"` frames; no
      // client or test harness ever sent one, so it was only an extra
      // unvalidated parse on an unauthenticated socket.)
      if (rawData[0] !== 0x08) {
        debug.warn(`[WS] Dropping unknown message from session ${ws.sessionIndex ?? 'unassigned'}`);
        return;
      }
      let data = Msg.decode(new Uint8Array(rawData));

      const requestedType = Number(data?.t);

      // Per-connection message rate limiting (use sync limiter for sync messages)
      if (!DISABLE_RATE_LIMITS) {
        const wsKey = ws.rateLimitId || ws.clientIp || 'unknown';
        // Sync messages: 41-49, 62, 75 — use much higher rate limit to avoid disconnections during large syncs
        const isSyncMessage = (requestedType >= 41 && requestedType <= 49) || requestedType === 62 || requestedType === 75;
        const limiter = isSyncMessage ? wsSyncMessageLimiter : wsMessageLimiter;
        if (!limiter.check(wsKey)) {
          return; // Silently drop excess messages
        }
      }

      const inboundMessage = data;
      data = await sanitizeMessage(inboundMessage);
      if (!data) {
        debug.warn(
          `[WS] Rejected invalid message from session ${ws.sessionIndex ?? 'unassigned'} `
          + `(room=${room?.id || 'unknown'}, type=${Number.isFinite(requestedType) ? requestedType : 'invalid'}): `
          + summarizeRejectedMessage(inboundMessage)
        );
        if (requestedType === T.CHAT_IMG || requestedType === T.STAFF_CHAT_IMG) {
          sendTo(ws, {
            t: T.MOD_RESULT,
            a: false,
            authError: 'Chat image upload failed. Use PNG, JPEG, WebP, or GIF under 5 MB.'
          });
          return;
        }
        ws.close(1008, 'Invalid message');
        return;
      }

      if (!DISABLE_RATE_LIMITS && !shouldAllowWsMessage(ws, data)) {
        debug.warn(`[WS] Rate limited message from ${ws.clientIp} (type=${data.t})`);
        if (data.t === T.CHAT_IMG || data.t === T.STAFF_CHAT_IMG) {
          sendTo(ws, {
            t: T.MOD_RESULT,
            a: false,
            authError: 'Chat image upload is being rate limited. Please wait a moment and try again.'
          });
          return;
        }
        ws.close(4408, 'Rate limit exceeded');
        return;
      }

      // Only deliberate chat/drawing actions affect AFK state. Background traffic
      // such as bandwidth probes, sync packets, and presence pings must not.
      if (ws.sessionIndex !== undefined) {
        const activeUser = room.sessionManager.getUser(ws.sessionIndex);
        // AFK_DEBUG: remember what last counted as activity for this user, so an
        // idle age that keeps resetting can be attributed to a message type
        // instead of guessed at.
        if (process.env.AFK_DEBUG && activeUser && isUserActivityMessage(data, activeUser)) {
          activeUser.lastActivityType = data.t;
        }
        if (isUserActivityMessage(data, activeUser)) {
          if (activeUser?.afk) {
            room.sessionManager.markUserActive(ws.sessionIndex);
          } else {
            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
        }
      }

      switch (data.t) {
        case T.FLOATING_WALL:
          if (ws.sessionIndex === undefined) break;
          await FloatingWall.forRoom(room, floatingWallIo).handleMessage(ws, data);
          break;

        case T.CONNECT: {
          await room.ensureLoaded();
          if (!hasValidRoomBoardSize(room)) {
            console.error(`[Room.CONNECT] Refusing join for room "${room.id}": invalid boardSize "${room.settings?.boardSize}" after settings load`);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Room settings failed to load. Please try again.' });
            ws.close(1011, 'Room settings unavailable');
            return;
          }

          const initialSettingsPayload = buildSettingsPayload(room);

          // Same-session resume: if the client supplied a resumeKey matching a
          // pending-disconnect entry in this room, reattach to the original
          // sessionIndex instead of allocating a new one. Peers never see a
          // LEFT/USERS churn for the brief drop.
          const incomingResumeKey = data.resumeKey ? String(data.resumeKey) : '';
          if (incomingResumeKey && room.pendingDisconnects?.has(incomingResumeKey)) {
            const pending = room.pendingDisconnects.get(incomingResumeKey);
            const resumedUser = room.sessionManager.getUser(pending.sessionIndex);
            if (resumedUser) {
              clearTimeout(pending.timer);
              room.pendingDisconnects.delete(incomingResumeKey);
              ws.sessionIndex = pending.sessionIndex;
              ws.resumeKey = incomingResumeKey;
              debug(`[CONNECT] Resumed sessionIndex=${pending.sessionIndex} as "${resumedUser.name}" via resumeKey`);
              sendTo(ws, initialSettingsPayload);
              sendTo(ws, {
                t: T.CONNECT_RESUMED,
                u: pending.sessionIndex,
                iid: resumedUser.instanceId,
                authRole: ws.userRole,
                authGlobalRole: ws.globalRole || 0,
                authRoomRole: ws.roomRole || 0,
                authUsername: resumedUser.name
              });
              // Tell peers to drop any half-stroke preview that was active when
              // the socket dropped — the resumed client starts fresh.
              broadcastToRoom(room, { t: T.CANCEL, u: pending.sessionIndex });
              broadcastUsersForRoom(room);
              break;
            }
            // User got finalized after the timer fired but before we cleared
            // the map (shouldn't normally happen). Fall through to fresh CONNECT.
            room.pendingDisconnects.delete(incomingResumeKey);
          }
          if (incomingResumeKey) {
            ws.resumeKey = incomingResumeKey;
          }

          const startsBlankLiveSession = room.canPersistSnapshots?.() &&
            (room.sessionManager?.getUserCount?.() ?? 0) === 0;

          if (getDB()) {
            try {
              logVpnAutoMuteContext(ws, room, 'Guest connect');
              const ipBan = await checkBan(null, ws.clientIp, room.id);
              if (ipBan) {
                const reason = ipBan.reason || '';
                sendTo(ws, { t: T.MOD_RESULT, a: false, authError: `You are banned${reason ? ': ' + reason : ''}` });
                ws.close(4001, 'Banned');
                return;
              }

              // Check for IP-based mute (guests)
              const ipMute = await checkMute(null, ws.clientIp, room.id);
              if (ipMute) {
                ws.isMuted = true;
              }
              if (room.settings.autoMuteGuests) {
                ws.isMuted = true;
              }
              if (room.settings.autoMuteVpnUsers && isVpnAsn(ws.clientAsn)) {
                ws.isVpnNetwork = true;
                ws.isMuted = true;
                console.warn(`[Security] Auto-muted guest on VPN ASN ${ws.clientAsn || 'unknown'} in room ${room.id}`);
              }
            } catch (err) {
              console.error('[Mod] IP ban/mute check error:', err);
            }
          }

          // Check room capacity
          if (!DISABLE_RATE_LIMITS && room.settings.maxUsers > 0) {
            const currentCount = room.getClientCount();
            if (currentCount >= room.settings.maxUsers) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Room is full' });
              ws.close(4003, 'Room full');
              return;
            }
          }

          sendTo(ws, initialSettingsPayload);

          // Don't reuse a departed user's index while their post-checkpoint
          // commits are still in the live tail — the joiner would self-filter
          // the replayed frames and lose that work (see docs/0000Sync_Issues.md
          // Issue 1). The retained strokeLog entries ARE that tail.
          const reuseLog = room.strokeLog;
          const isIndexReusable = reuseLog
            ? (idx) => !reuseLog.hasLiveCommitsFrom(idx)
            : null;
          const sessionIndex = room.sessionManager.allocateSessionIndex(isIndexReusable);
          ws.sessionIndex = sessionIndex;

          debug('[IdentityDebug][server] JOIN message data fields:', {
            client_device_id: data.client_device_id,
            client_fingerprint_id: data.client_fingerprint_id,
            client_identity_json: data.client_identity_json,
            clientDeviceId: data.clientDeviceId,
            clientFingerprintId: data.clientFingerprintId,
            clientIdentityJson: data.clientIdentityJson
          });

          const identity = normalizeIdentityPayload(data);
          debug('[IdentityDebug][server] Normalized identity:', identity);
          debug('[IdentityDebug][server] Existing ws values:', {
            deviceId: ws.deviceId,
            fingerprintId: ws.fingerprintId,
            identitySummary: ws.identitySummary
          });

          // Preserve existing values if new values are empty
          ws.deviceId = identity.deviceId || ws.deviceId;
          ws.fingerprintId = identity.fingerprintId || ws.fingerprintId;
          ws.identitySummary = identity.identitySummary || ws.identitySummary;
          if (!room.ownerId && !room.creatorDeviceId && ws.deviceId && room.getClientCount() === 1) {
            room.creatorDeviceId = ws.deviceId;
          }
          const requestedUsername = normalizeUsername(data.n || '');
          const username = getUniqueVisibleName(room, requestedUsername || 'Guest');
          debug(`[CONNECT] Session ${sessionIndex} joining room ${room.id} as "${username}"`);

          room.sessionManager.createUser(
            sessionIndex,
            username,
            Tool.BRUSH,
            packColor([0, 0, 0, 1]),
            getIpHash(ws.clientIp)
          );
          if (startsBlankLiveSession) {
            room.beginBlankJoinSession?.();
          }
          const createdUser = room.sessionManager.getUser(sessionIndex);
          await applyShadowBanStateToClient(ws, room);
          if (createdUser) {
            createdUser.isMuted = !!ws.isMuted;
            createdUser.isShadowBanned = !!ws.isShadowBanned;
            createdUser.isVPN = !!ws.isVPN;
            createdUser.countryCode = ws.clientCountry || '';
          }

          await recordConnectionEvent(getDB(), {
            type: 'ws_connect',
            source: 'ws',
            roomId: room.id,
            sessionIndex,
            userId: ws.userId || null,
            username,
            ip: ws.clientIp,
            subnet: ws.clientSubnet,
            deviceId: ws.deviceId || null,
            fingerprintId: ws.fingerprintId || null,
            identitySummary: ws.identitySummary,
            userAgent: ws.userAgent,
            clientAsn: ws.clientAsn || null,
            isVpnNetwork: !!ws.isVpnNetwork
          });

          sendTo(ws, {
            t: T.CONNECT,
            u: sessionIndex,
            iid: createdUser.instanceId,
            authRole: ws.userRole,
            authGlobalRole: ws.globalRole || 0,
            authRoomRole: ws.roomRole || 0,
            authUsername: username,
            roomFloatingGallerySeed: room.settings.floatingGallerySeed,
            roomFloatingGalleryIncludeIds: room.settings.floatingGalleryIncludeIds || [],
            roomFloatingGalleryExcludeIds: room.settings.floatingGalleryExcludeIds || [],
            roomFloatingGalleryVoronoiJson: getFloatingGalleryVoronoiJson(
              room.settings.floatingGalleryVoronoi || generateFloatingGalleryVoronoi(room.settings.floatingGallerySeed)
            ),
            roomBoardSize: room.settings.boardSize,
            roomTiledCanvas: roomTiledCanvasEnabled(room),
            roomTiledCanvasAvailable: roomTiledCanvasSettable()
          });

          const allUsers = getVisibleJoinedUsers(room);
          const roomBroadcaster = createRoomBroadcaster(room);

          const requiresAuthToAppear = getJoinPolicyMinRole(room.settings.joinPolicy) > Role.GUEST;
          const shouldBroadcastJoin = !requiresAuthToAppear && !ws.isShadowBanned;

          if (!room.sessionManager.isDiscovery && shouldBroadcastJoin) {
            roomBroadcaster({
              t: T.USERS
            });
          } else {
            // In discovery, only send to self, no broadcast
            sendUsersToClient(ws, room, allUsers);
          }

          sendTo(ws, initialSettingsPayload);
          sendImageToolStateToClient(ws, room, allUsers);
          sendActiveOverlaysToClient(ws, room);

          if (ws.clientAppVersion) {
            readVersionPolicy().then((versionPolicy) => {
              if (!versionPolicy?.minRequired) return;
              if (!isClientOutdated(ws.clientAppVersion, versionPolicy.minRequired)) return;

              const latest = versionPolicy.latest || versionPolicy.minRequired;
              sendTo(ws, {
                t: T.GLOBAL_MESSAGE,
                g: `A new Ddraw server version is live (${latest}). Please refresh or update now to reconnect.`,
                k: 'update',
                n: 'Server',
                a: false
              });
            }).catch((error) => {
              console.error('[Version] Failed to evaluate client version on connect:', error);
            });
          }

          // Settle this session's base board (blank, or the room's last
          // persisted snapshot) before anyone can SYNC_REQUEST against it. Not
          // awaited: the call pins its promise synchronously and the sync path
          // awaits that same promise.
          debug(`[Room.CONNECT] Before handleFirstJoinerBase: room client count = ${room.getClientCount()}`);
          handleFirstJoinerBase(ws, room).catch(() => {});

          // Start/continue election when first user joins (auto mode only)
          if (room.getClientCount() === 1 && !room.settings.dedicatedReplayUser) {
            startElection(room, (r) => broadcastToRoom(r, buildSettingsPayload(r)), sendTo);
          }

          // Trigger an immediate bandwidth probe unless we just hydrated a fresh
          // measurement (from the DB or a BW_REPORT). This gives the _discovery
          // lobby a seed value the client can replay on room-switch, and gives
          // newly-joined real-room users a measurement before the 30s election tick.
          if (!ws.skipUploadBps && (!ws.uploadBps || !ws.lastProbeTs || (Date.now() - ws.lastProbeTs) > 60_000)) {
            startBandwidthProbe(ws, {
              sendTo,
              username,
              onPersist: (bps) => {
                const user = room.sessionManager.getUser(sessionIndex);
                if (user) {
                  user.uploadBps = bps;
                  user.lastProbeTs = Date.now();
                }
              }
            });
          }

          // If user is muted (IP-based for guests), hide their cursor for everyone
          if (ws.isMuted && !ws.isShadowBanned) {
            roomBroadcaster({ t: T.HIDE_CURSOR, u: sessionIndex });
          }
          break;
        }

        case T.SYNC_REQUEST:
          room.syncCoordinator.handleSyncRequest(ws, data);
          break;

        case T.SYNC_PARITY_CHECK:
          room.parityCoordinator.handleCheck(ws, data);
          break;

        case T.SYNC_PARITY_CHUNK_REQUEST:
          room.parityCoordinator.handleChunkRequest(ws, data);
          break;

        case T.SYNC_PARITY_RESYNC_REQUEST:
          room.parityCoordinator.handleResyncRequest(ws, data);
          break;

        case T.SYNC_PARITY_MISMATCH_REPORT:
          room.parityCoordinator.handleReport(ws, data);
          break;

        case T.TILE_UPDATE:
          if (ws.isShadowBanned) break;
          // Real-time tile update - server tracks which tiles are now occupied
          if (data.tiles && Array.isArray(data.tiles)) {
            const tileIndices = data.tiles.map(t => typeof t === 'number' ? t : t.idx);
            room.markTilesDirty(ws.sessionIndex, tileIndices);
            // Relay to other clients with sender's user ID
            broadcastToRoom(room, {
              t: T.TILE_UPDATE,
              u: ws.sessionIndex,
              tiles: data.tiles
            }, ws.sessionIndex);
          }
          break;

        case T.TILE_CLEAR:
          if (ws.isShadowBanned) break;
          // Tiles that are now empty - clear from server and relay to all clients
          if (data.clearedTiles && Array.isArray(data.clearedTiles)) {
            // Clear from server's tile dirty set
            room.clearTiles(data.clearedTiles);
            
            // Relay to other clients
            broadcastToRoom(room, {
              t: T.TILE_CLEAR,
              clearedTiles: data.clearedTiles
            }, ws.sessionIndex);
          }
          break;

        case T.DM:
          if (ws.isShadowBanned) break;
          const recipientId = data.r;
          if (recipientId !== undefined && ws.sessionIndex !== undefined) {
            for (const client of wss.clients) {
              if (client.sessionIndex === recipientId && client.readyState === WebSocket.OPEN) {
                sendTo(client, {
                  t: T.DM,
                  u: ws.sessionIndex,
                  g: data.g,
                  chatMessageId: data.chatMessageId
                });
                break;
              }
            }
            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
          break;

        case T.CHAT_IMG:
          if (ws.isShadowBanned) break;
          if (ws.sessionIndex !== undefined) {
            let imageBytes = data.cimg;
            const imageRecipientId = hasOwnField(data, 'r') ? data.r : null;

            if (!imageBytes || imageBytes.length === 0) break;

            if (Buffer.isBuffer(imageBytes)) {
              imageBytes = new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.length);
            } else if (!(imageBytes instanceof Uint8Array)) {
              imageBytes = new Uint8Array(imageBytes);
            }

            if (imageRecipientId !== null) {
              for (const client of wss.clients) {
                if (client.sessionIndex === imageRecipientId && client.readyState === WebSocket.OPEN) {
                  sendTo(client, {
                    t: T.CHAT_IMG,
                    u: ws.sessionIndex,
                    cimg: imageBytes,
                    r: imageRecipientId,
                    chatMessageId: data.chatMessageId
                  });
                  break;
                }
              }
            } else {
              broadcastToRoom(room, {
                t: T.CHAT_IMG,
                u: ws.sessionIndex,
                cimg: imageBytes,
                chatMessageId: data.chatMessageId
              }, ws.sessionIndex);
            }
            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
          break;

        case T.STAFF_MSG:
          if (ws.isShadowBanned) break;
          if ((ws.userRole || 0) < Role.MOD) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only moderators can use staff chat' });
            break;
          }
          if (ws.sessionIndex !== undefined) {
            for (const client of wss.clients) {
              if (client.readyState !== WebSocket.OPEN) continue;
              const clientRoom = roomManager.getRoomByClient(client);
              if (clientRoom !== room) continue;
              if ((client.userRole || 0) < Role.MOD) continue;
              sendTo(client, {
                t: T.STAFF_MSG,
                u: ws.sessionIndex,
                g: data.g,
                chatMessageId: data.chatMessageId
              });
            }
            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
          break;

        case T.STAFF_CHAT_IMG:
          if (ws.isShadowBanned) break;
          if ((ws.userRole || 0) < Role.MOD) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only moderators can use staff chat' });
            break;
          }
          if (ws.sessionIndex !== undefined) {
            let imageBytes = data.cimg;
            if (!imageBytes || imageBytes.length === 0) break;
            if (Buffer.isBuffer(imageBytes)) {
              imageBytes = new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.length);
            } else if (!(imageBytes instanceof Uint8Array)) {
              imageBytes = new Uint8Array(imageBytes);
            }

            for (const client of wss.clients) {
              if (client.readyState !== WebSocket.OPEN) continue;
              const clientRoom = roomManager.getRoomByClient(client);
              if (clientRoom !== room) continue;
              if ((client.userRole || 0) < Role.MOD) continue;
              sendTo(client, {
                t: T.STAFF_CHAT_IMG,
                u: ws.sessionIndex,
                cimg: imageBytes,
                chatMessageId: data.chatMessageId
              });
            }
            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
          break;

        case T.MSG_DELETE: {
          if (!authorize(ws, Action.MOD_DELETE_MSG, sendTo, T.MOD_RESULT)) break;
          const deletedMessageId = (data.chatMessageId || '').trim();
          if (!deletedMessageId) break;
          broadcastToRoom(room, { t: T.MSG_DELETE, chatMessageId: deletedMessageId });
          break;
        }

        case T.STAFF_MSG_DELETE: {
          if (!authorize(ws, Action.MOD_DELETE_MSG, sendTo, T.MOD_RESULT)) break;
          const deletedStaffMessageId = (data.chatMessageId || '').trim();
          if (!deletedStaffMessageId) break;
          for (const client of wss.clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            const clientRoom = roomManager.getRoomByClient(client);
            if (clientRoom !== room) continue;
            if ((client.userRole || 0) < Role.MOD) continue;
            sendTo(client, { t: T.STAFF_MSG_DELETE, chatMessageId: deletedStaffMessageId });
          }
          break;
        }

        case T.CHAT_REACTION:
          if (ws.isShadowBanned) break;
          if (ws.sessionIndex !== undefined) {
            const reactionPayload = {
              t: T.CHAT_REACTION,
              u: ws.sessionIndex,
              chatMessageId: data.chatMessageId,
              chatReaction: data.chatReaction,
              chatReactionRemove: !!data.chatReactionRemove
            };

            if (hasOwnField(data, 'r')) {
              reactionPayload.r = data.r;
              for (const client of wss.clients) {
                if (client.sessionIndex === data.r && client.readyState === WebSocket.OPEN) {
                  sendTo(client, reactionPayload);
                  break;
                }
              }
            } else {
              broadcastToRoom(room, reactionPayload, ws.sessionIndex);
            }

            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
          break;

        case T.MOD_ACTION: {
          const modActionType = data.modActionType ?? 0;
          const MOD_ACTION_MAP = [
            Action.MOD_KICK,
            Action.MOD_MUTE,
            Action.MOD_BAN,
            Action.MOD_UNMUTE,
            Action.MOD_UNBAN,
            Action.MOD_UPDATE,
            Action.MOD_SHADOWBAN,
            Action.MOD_UNSHADOWBAN,
            Action.MOD_UPDATE_DURATION,
            Action.MOD_SILENCE,
            Action.MOD_UNSILENCE
          ];
          const requiredAction = MOD_ACTION_MAP[modActionType];
          if (!requiredAction || !authorize(ws, requiredAction, sendTo, T.MOD_RESULT)) {
            debug(`[MOD] REJECTED - insufficient role (role=${ws.userRole}, actionType=${modActionType})`);
            break;
          }
          const modTargetIndex = data.modTarget;
          const modReason = data.modReason || '';
          const modDuration = data.modDuration || 0;
          // 'exact' | 'subnet' (default) | 'wide' — controls how broadly an IP-based
          // mod action matches (e.g. /64 vs /128 on IPv6). See server/ipIdentity.js.
          const rawIpScope = typeof data.modIpScope === 'string' ? data.modIpScope : '';
          const modIpScope = (rawIpScope === 'exact' || rawIpScope === 'wide') ? rawIpScope : 'subnet';

          let targetWs = null;
          for (const client of wss.clients) {
            if (client.sessionIndex === modTargetIndex && client.readyState === WebSocket.OPEN) {
              targetWs = client;
              break;
            }
          }

          const targetUser = room.sessionManager.getUser(modTargetIndex);
          // For post-disconnect actions (unban/unmute issued after the target's
          // WS already closed — including the close caused by the ban itself),
          // recover the target identity from the recent-session cache before
          // falling back to a synthetic "User N" label that won't match the DB.
          const recentTarget = getRecentSession(room, modTargetIndex);
          const targetName = data.modTargetName || targetWs?.username || targetUser?.name || recentTarget?.username || `User ${modTargetIndex}`;
          const targetRole = getTargetProtectionRole(targetWs, targetUser);
          const issuerAuthority = getModerationAuthority(ws);
          const targetUserId = targetWs?.userId || recentTarget?.userId || null;
          const targetIp = targetWs?.clientIp || recentTarget?.clientIp || null;
          const targetDeviceId = targetWs?.deviceId || recentTarget?.deviceId || null;
          const targetFingerprintId = targetWs?.fingerprintId || recentTarget?.fingerprintId || null;

          // Several cases below reject via rejectProtectedTarget() and `break` out of
          // the switch, which otherwise falls straight into the unconditional success
          // MOD_RESULT after it — sending a false result immediately followed by a
          // true one, with the client acting on whichever arrives (last write wins).
          let resultSent = false;
          const rejectProtectedTarget = (message) => {
            resultSent = true;
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: message });
          };

          try {
            const roomBroadcaster = createRoomBroadcaster(room);

            debug(`[Mod] MOD_ACTION received: type=${modActionType}, target=${modTargetIndex}, targetWs=${!!targetWs}`);
            switch (modActionType) {
              case 0: { // Kick
                if (targetRole > issuerAuthority) {
                  rejectProtectedTarget('Cannot kick a user with a higher role than your own');
                  break;
                }
                debug(`[MOD] KICKING sessionIndex=${modTargetIndex}, targetWs=${!!targetWs}`);
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 0,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });

                // A kick has to outlast the reconnect grace window, or the
                // target's tab replays its resumeKey and walks straight back in
                // on the same sessionIndex.
                clearPendingDisconnectsForSession(room, modTargetIndex);

                // targetWs only matches OPEN sockets. The user a moderator
                // reaches for the kick button for is often precisely the one
                // whose socket is already CLOSING, or gone entirely with just
                // the user record (and its cursor) left behind — so fall back to
                // the room's client for this index, and retire the session
                // either way instead of leaving the kick a no-op.
                const kickSocket = targetWs || getRoomClientBySessionIndex(room, modTargetIndex);
                if (kickSocket) {
                  debug(`[MOD] CLOSING ws for sessionIndex=${modTargetIndex}`);
                  kickSocket.kicked = true;
                  try { kickSocket.close(4002, 'Kicked'); } catch (_) {}
                  // close() only queues a close frame and waits for the peer to
                  // answer it. A frozen client never answers, and ws then sits
                  // on its 30s close timeout before emitting 'close'.
                  const killTimer = setTimeout(() => {
                    if (kickSocket.readyState !== WebSocket.CLOSED) {
                      try { kickSocket.terminate(); } catch (_) {}
                    }
                  }, KICK_TERMINATE_GRACE_MS);
                  killTimer.unref?.();
                } else {
                  debug(`[MOD] No socket for sessionIndex=${modTargetIndex}; retiring ghost session`);
                }
                finalizeSessionRemoval(room, modTargetIndex, kickSocket || {});
                // Detach the index from the socket: a message still in flight
                // from a wedged client must not act as the kicked user, and the
                // socket's eventual 'close' must not re-run the departure.
                if (kickSocket) kickSocket.sessionIndex = undefined;
                broadcastUsersForRoom(room);
                break;
              }

              case 1: { // Mute
                if (targetRole >= Role.MOD) {
                  rejectProtectedTarget('Users with MOD rank or higher cannot be muted');
                  break;
                }
                if (targetRole > issuerAuthority) {
                  rejectProtectedTarget('Cannot mute a user with a higher role than your own');
                  break;
                }
                const isGlobalMute = (ws.globalRole || 0) >= Role.HOLY;
                if (getDB()) {
                  await issueModAction({
                    type: 'mute',
                    targetUserId,
                    targetUsername: targetName,
                    targetIp,
                    ipScope: modIpScope,
                    reason: modReason,
                    issuedBy: ws.userId || null,
                    issuedByUsername: ws.username || '',
                    issuedByRole: issuerAuthority,
                    duration: modDuration,
                    roomId: isGlobalMute ? null : room.id
                  });
                }
                if (targetWs) {
                  targetWs.isMuted = true;
                }
                if (targetUser) {
                  targetUser.isMuted = true;
                }
                roomBroadcaster({ t: T.HIDE_CURSOR, u: modTargetIndex });
                roomBroadcaster({
                  t: T.USERS
                });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 1,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                break;
              }

              case 2: { // Ban
                if (targetRole > issuerAuthority) {
                  rejectProtectedTarget('Cannot ban a user with a higher role than your own');
                  break;
                }
                // Ban immunity: HOLY(7)+ can't be room-banned; room owner can't be banned from own room
                if (targetWs?.globalRole >= Role.HOLY) {
                  resultSent = true;
                  sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot ban users with global HOLY+ rank' });
                  break;
                }
                if (room.ownerId && targetWs?.userId === room.ownerId) {
                  resultSent = true;
                  sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot ban the room owner' });
                  break;
                }
                const isGlobalBan = (ws.globalRole || 0) >= Role.HOLY;
                if (getDB()) {
                  await issueModAction({
                    type: 'ban',
                    targetUserId,
                    targetUsername: targetName,
                    targetIp,
                    ipScope: modIpScope,
                    reason: modReason,
                    issuedBy: ws.userId || null,
                    issuedByUsername: ws.username || '',
                    issuedByRole: issuerAuthority,
                    duration: modDuration,
                    roomId: isGlobalBan ? null : room.id
                  });
                }
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 2,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                if (targetWs) {
                  targetWs.close(4001, 'Banned');
                }
                break;
              }

              case 3: { // Unmute
                let rankBlocked = false;
                if (getDB()) {
                  const revokeEntryId = (data.modReason || '').trim();
                  const hasSpecificEntryId = /^[a-f0-9]{24}$/i.test(revokeEntryId);

                  if (hasSpecificEntryId) {
                    const entry = await getModActionById(revokeEntryId);
                    if (entry && (entry.issuedByRole || 0) > issuerAuthority) {
                      rejectProtectedTarget('Cannot unmute a user muted by a higher-ranked moderator');
                      rankBlocked = true;
                    } else {
                      await revokeModAction(revokeEntryId, ws.userId);
                    }
                  } else {
                    await revokeMatchingModActions({
                      type: 'mute',
                      targetUserId,
                      targetIp,
                      targetUsername: targetName || null,
                      roomId: room.id,
                      revokedById: ws.userId,
                      maxIssuedByRole: issuerAuthority
                    });
                  }
                }
                if (rankBlocked) break;

                let stillMuted = false;
                if (targetWs) {
                  const remainingMute = await checkMute(targetWs.userId || null, targetWs.clientIp || null, room.id);
                  stillMuted = !!remainingMute && (targetWs.userRole || 0) < Role.MOD;
                  targetWs.isMuted = stillMuted;
                }
                if (targetUser) {
                  targetUser.isMuted = stillMuted;
                }
                if (!stillMuted) {
                  roomBroadcaster({ t: T.SHOW_CURSOR, u: modTargetIndex });
                }
                roomBroadcaster({
                  t: T.USERS
                });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 3,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                break;
              }

              case 9: { // Silence (chat-only mute)
                if (targetRole >= Role.MOD) {
                  rejectProtectedTarget('Users with MOD rank or higher cannot be silenced');
                  break;
                }
                if (targetRole > issuerAuthority) {
                  rejectProtectedTarget('Cannot silence a user with a higher role than your own');
                  break;
                }
                const isGlobalSilence = (ws.globalRole || 0) >= Role.HOLY;
                if (getDB()) {
                  await issueModAction({
                    type: 'silence',
                    targetUserId,
                    targetUsername: targetName,
                    targetIp,
                    ipScope: modIpScope,
                    reason: modReason,
                    issuedBy: ws.userId || null,
                    issuedByUsername: ws.username || '',
                    issuedByRole: issuerAuthority,
                    duration: modDuration,
                    roomId: isGlobalSilence ? null : room.id
                  });
                }
                if (targetWs) {
                  targetWs.isSilenced = true;
                  targetWs.chatSpamLevel = 0;
                  targetWs.chatCooldownUntil = 0;
                }
                if (targetUser) {
                  targetUser.isSilenced = true;
                }
                roomBroadcaster({
                  t: T.USERS
                });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 9,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                break;
              }

              case 10: { // Unsilence
                let rankBlocked = false;
                if (getDB()) {
                  const revokeEntryId = (data.modReason || '').trim();
                  const hasSpecificEntryId = /^[a-f0-9]{24}$/i.test(revokeEntryId);

                  if (hasSpecificEntryId) {
                    const entry = await getModActionById(revokeEntryId);
                    if (entry && (entry.issuedByRole || 0) > issuerAuthority) {
                      rejectProtectedTarget('Cannot unsilence a user silenced by a higher-ranked moderator');
                      rankBlocked = true;
                    } else {
                      await revokeModAction(revokeEntryId, ws.userId);
                    }
                  } else {
                    await revokeMatchingModActions({
                      type: 'silence',
                      targetUserId,
                      targetIp,
                      targetUsername: targetName || null,
                      roomId: room.id,
                      revokedById: ws.userId,
                      maxIssuedByRole: issuerAuthority
                    });
                  }
                }
                if (rankBlocked) break;

                let stillSilenced = false;
                if (targetWs) {
                  const remainingSilence = await checkSilence(targetWs.userId || null, targetWs.clientIp || null, room.id);
                  stillSilenced = !!remainingSilence && (targetWs.userRole || 0) < Role.MOD;
                  targetWs.isSilenced = stillSilenced;
                  if (!stillSilenced) {
                    targetWs.chatSpamLevel = 0;
                    targetWs.chatCooldownUntil = 0;
                  }
                }
                if (targetUser) {
                  targetUser.isSilenced = stillSilenced;
                }
                roomBroadcaster({
                  t: T.USERS
                });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 10,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                break;
              }

              case 5: { // Update reason for an existing kick/mute/ban/silence
                // modDuration is repurposed here to carry the original action code (0=kick,1=mute,2=ban,9=silence)
                const origActionCode = modDuration;
                if (origActionCode === 1 || origActionCode === 2 || origActionCode === 9) {
                  const type = origActionCode === 1 ? 'mute' : origActionCode === 9 ? 'silence' : 'ban';
                  if (getDB()) {
                    await updateModActionReason(
                      targetUserId,
                      targetIp,
                      type,
                      modReason
                    );
                  }
                }
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 5,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                break;
              }

              case 4: { // Unban
                let rankBlocked = false;
                if (getDB()) {
                  const revokeEntryId = (data.modReason || '').trim();
                  const hasSpecificEntryId = /^[a-f0-9]{24}$/i.test(revokeEntryId);

                  if (hasSpecificEntryId) {
                    const entry = await getModActionById(revokeEntryId);
                    if (entry && (entry.issuedByRole || 0) > issuerAuthority) {
                      rejectProtectedTarget('Cannot unban a user banned by a higher-ranked moderator');
                      rankBlocked = true;
                    } else {
                      await revokeModAction(revokeEntryId, ws.userId);
                    }
                  } else {
                    await revokeMatchingModActions({
                      type: 'ban',
                      targetUserId,
                      targetIp,
                      targetUsername: targetName || null,
                      roomId: room.id,
                      revokedById: ws.userId,
                      maxIssuedByRole: issuerAuthority
                    });
                  }
                }
                if (rankBlocked) break;
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 4,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                break;
              }

              case 6: { // Shadow ban
                if (targetRole >= Role.MOD) {
                  rejectProtectedTarget('Users with MOD rank or higher cannot be shadow banned');
                  break;
                }
                if (targetRole > issuerAuthority) {
                  rejectProtectedTarget('Cannot shadow ban a user with a higher role than your own');
                  break;
                }
                if (!targetWs) {
                  resultSent = true;
                  sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Target user is no longer connected' });
                  break;
                }
                if (getDB()) {
                  await issueModAction({
                    type: 'shadowban',
                    targetUserId,
                    targetUsername: targetName,
                    targetIp,
                    ipScope: modIpScope,
                    targetDeviceId,
                    targetFingerprintId,
                    reason: modReason,
                    issuedBy: ws.userId || null,
                    issuedByUsername: ws.username || '',
                    issuedByRole: issuerAuthority,
                    duration: modDuration,
                    roomId: null
                  });
                }
                targetWs.isShadowBanned = true;
                if (targetUser) targetUser.isShadowBanned = true;
                roomBroadcaster({ t: T.HIDE_CURSOR, u: modTargetIndex });
                broadcastUsersForRoom(room);
                break;
              }

              case 7: { // Unshadow ban
                let rankBlocked = false;
                if (getDB()) {
                  const revokeEntryId = (data.modReason || '').trim();
                  const hasSpecificEntryId = /^[a-f0-9]{24}$/i.test(revokeEntryId);

                  if (hasSpecificEntryId) {
                    const entry = await getModActionById(revokeEntryId);
                    if (entry && (entry.issuedByRole || 0) > issuerAuthority) {
                      rejectProtectedTarget('Cannot unshadowban a user shadow banned by a higher-ranked moderator');
                      rankBlocked = true;
                    } else {
                      await revokeModAction(revokeEntryId, ws.userId);
                    }
                  } else {
                    await revokeMatchingModActions({
                      type: 'shadowban',
                      targetUserId,
                      targetIp,
                      targetUsername: targetName || null,
                      targetDeviceId,
                      targetFingerprintId,
                      revokedById: ws.userId,
                      maxIssuedByRole: issuerAuthority
                    });
                  }
                }
                if (rankBlocked) break;

                let stillShadowBanned = false;
                if (targetWs) {
                  const remainingShadowBan = await checkShadowBan({
                    userId: targetWs.userId || null,
                    ip: targetWs.clientIp || null,
                    deviceId: targetWs.deviceId || null,
                    fingerprintId: targetWs.fingerprintId || null,
                    roomId: room.id
                  });
                  stillShadowBanned = !!remainingShadowBan && (targetWs.userRole || 0) < Role.MOD;
                  targetWs.isShadowBanned = stillShadowBanned;
                }
                if (targetUser) {
                  targetUser.isShadowBanned = stillShadowBanned;
                }
                broadcastUsersForRoom(room);
                if (!stillShadowBanned && targetWs && !targetWs.isMuted) {
                  roomBroadcaster({ t: T.SHOW_CURSOR, u: modTargetIndex });
                }
                break;
              }

              case 8: { // Update duration of an existing mute/ban/shadowban
                const revokeEntryId = (data.modReason || '').trim();
                if (!getDB() || !/^[a-f0-9]{24}$/i.test(revokeEntryId)) {
                  rejectProtectedTarget('Invalid moderation entry');
                  break;
                }
                const entry = await getModActionById(revokeEntryId);
                if (!entry) {
                  rejectProtectedTarget('Moderation entry not found');
                  break;
                }
                if ((entry.issuedByRole || 0) > issuerAuthority) {
                  rejectProtectedTarget('Cannot change the duration of an entry issued by a higher-ranked moderator');
                  break;
                }
                await updateModActionDuration(revokeEntryId, modDuration, ws.userId);
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 5,
                  modTarget: modTargetIndex,
                  modTargetName: entry.targetUsername || targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: ''
                });
                break;
              }
            }

            if (!resultSent) sendTo(ws, { t: T.MOD_RESULT, a: true });
          } catch (err) {
            console.error('[Mod] Action error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Moderation action failed' });
          }
          break;
        }

        case T.MOD_WIPE: {
          if (!authorize(ws, Action.MOD_WIPE, sendTo, T.MOD_RESULT)) break;

          const targetIndex = data.modTarget;
          const targetName = data.modTargetName || `User ${targetIndex}`;
          const targetWs = getRoomClientBySessionIndex(room, targetIndex);
          const targetUser = room.sessionManager.getUser(targetIndex);
          const targetRole = getTargetProtectionRole(targetWs, targetUser);
          if (targetRole > getModerationAuthority(ws)) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot wipe strokes from a user with a higher role than your own' });
            break;
          }

          createRoomBroadcaster(room)({
            t: T.MOD_WIPE,
            modTarget: targetIndex,
            modTargetName: targetName,
            modIssuerName: ws.username || `User ${ws.sessionIndex}`
          });

          // The wipe only mutates connected clients' live canvases; the room's
          // durable snapshot is otherwise on a 15s timer (RoomManager._requestSnapshot).
          // Force one now so a reload inside that window can't resurrect the
          // wiped strokes from a stale pre-wipe checkpoint. Same rationale as
          // the getClientCount()===1 snapshot request on disconnect below.
          room._requestSnapshot?.();

          sendTo(ws, { t: T.MOD_RESULT, a: true });
          break;
        }

        case T.ROOM_LIST_REQUEST: {
          try {
            const rooms = roomManager.getRoomList();
            sendTo(ws, {
              t: T.ROOM_LIST_RESPONSE,
              rooms: rooms.map(r => ({
                id: r.id,
                userCount: r.userCount,
                locked: r.locked,
                hasPassword: r.hasPassword,
                description: r.description || '',
                backgroundColor: r.backgroundColor || '#ffffff',
                ownerId: r.ownerId || '',
                ownerUsername: r.ownerUsername || '',
                preview: r.preview || null
              }))
            });
          } catch (err) {
            console.error('[Room] List error:', err);
          }
          break;
        }

        case T.ROOM_PREVIEW: {
          if (ws.isShadowBanned) break;
          // Store preview image for this room (sent by any user in the room)
          if (data.img && data.img.length > 0) {
            // Limit preview size to 100KB to prevent abuse
            if (data.img.length <= 100 * 1024) {
              room.setPreview(Buffer.from(data.img));
            }
          }
          break;
        }

        case T.ROOM_UPDATE: {
          const creatorDeviceId = String(data.roomCreatorDeviceId || '').trim();
          const isUnownedCreatorDevice = !room.ownerId
            && creatorDeviceId
            && ws.deviceId
            && creatorDeviceId === ws.deviceId
            && (!room.creatorDeviceId || room.creatorDeviceId === ws.deviceId);
          if (!ws.userId && !isUnownedCreatorDevice) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          const isOwner = room.ownerId === ws.userId;
          const isMod = getRoomAdminAuthority(ws) >= Role.ADMIN;  // room ADMIN+ or global HOLY+

          if (!isOwner && !isMod && !isUnownedCreatorDevice) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only room owner or moderators can change settings' });
            break;
          }

          try {
            const autoMuteGuestsChanged = data.roomAutoMuteGuests !== undefined;
            const autoMuteVpnUsersChanged = data.roomAutoMuteVpnUsers !== undefined;
            if (isUnownedCreatorDevice && !room.creatorDeviceId) {
              room.creatorDeviceId = ws.deviceId;
            }
            if (!room.ownerId && data.roomOwnerId === ws.userId) {
              room.ownerId = ws.userId;
              room.ownerUsername = ws.username;
            }

            if (data.roomDescription !== undefined) {
              room.description = (data.roomDescription || '').substring(0, 200);
            }
            if (data.roomLocked !== undefined) {
              room.settings.locked = !!data.roomLocked;
            }
            if (data.roomMaxUsers !== undefined) {
              room.settings.maxUsers = Math.max(2, Math.min(60, data.roomMaxUsers || 40));
            }
            if (data.roomBackgroundColor !== undefined) {
              const hex = data.roomBackgroundColor;
              if (hex && /^#[0-9A-Fa-f]{6}$/.test(hex)) {
                room.settings.backgroundColor = hex;
              }
            }
            if (data.roomModInactiveImmune !== undefined) {
              room.settings.modInactiveImmune = !!data.roomModInactiveImmune;
              room.sessionManager.checkAfkUsers();
            }
            if (data.roomJoinPolicy !== undefined) {
              const joinPolicy = String(data.roomJoinPolicy || 'open');
              room.settings.joinPolicy = ROOM_JOIN_POLICIES.has(joinPolicy) ? joinPolicy : 'open';
            }
            if (data.roomObscureRequiresRegistered !== undefined) {
              room.settings.obscureRequiresRegistered = !!data.roomObscureRequiresRegistered;
            }
            if (data.roomAutoMuteGuests !== undefined) {
              room.settings.autoMuteGuests = !!data.roomAutoMuteGuests;
            }
            if (data.roomAutoMuteVpnUsers !== undefined) {
              room.settings.autoMuteVpnUsers = !!data.roomAutoMuteVpnUsers;
            }
            if (data.roomHideChatNotifications !== undefined) {
              room.settings.hideChatNotifications = !!data.roomHideChatNotifications;
            }
            // 0/absent = client didn't touch it; 1 = on, 2 = off (see buildSettingsPayload).
            if (data.roomSnapshotOnFirstJoin) {
              room.settings.loadSnapshotOnFirstJoin = Number(data.roomSnapshotOnFirstJoin) !== 2;
            }
            if (data.roomTextOverlayLifetimeMs !== undefined) {
              const raw = Number(data.roomTextOverlayLifetimeMs);
              if (Number.isFinite(raw) && raw > 0) {
                room.settings.textOverlayLifetimeMs = Math.max(5000, Math.min(30 * 60 * 1000, Math.floor(raw)));
              }
            }
            if (data.roomDedicatedReplayUser !== undefined) {
              // null clears the dedicated user, otherwise store the username string
              room.settings.dedicatedReplayUser = data.roomDedicatedReplayUser || null;
            }
            if (data.roomPrivate !== undefined) {
              room.settings.private = !!data.roomPrivate;
            }
            let floatingWallReset = false;
            if (data.roomFloatingGallerySeed !== undefined) {
              const nextSeed = Number(data.roomFloatingGallerySeed);
              const previousSeed = room.settings.floatingGallerySeed;
              room.settings.floatingGallerySeed = Number.isFinite(nextSeed) && nextSeed > 0
                ? Math.floor(nextSeed)
                : room.settings.floatingGallerySeed;
              if (room.settings.floatingGallerySeed !== previousSeed) {
                room.settings.floatingGalleryVoronoi = generateFloatingGalleryVoronoi(room.settings.floatingGallerySeed);
                // "Rearrange" in room settings: a new seed re-spawns the floating wall from scratch
                floatingWallReset = true;
                room.settings.floatingWall = null;
              }
            }
            if (data.roomFloatingGalleryIncludeIds !== undefined) {
              room.settings.floatingGalleryIncludeIds = Array.isArray(data.roomFloatingGalleryIncludeIds)
                ? data.roomFloatingGalleryIncludeIds
                    .filter(id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id))
                    .slice(0, 200)
                : [];
            }
            if (data.roomFloatingGalleryExcludeIds !== undefined) {
              room.settings.floatingGalleryExcludeIds = Array.isArray(data.roomFloatingGalleryExcludeIds)
                ? data.roomFloatingGalleryExcludeIds
                    .filter(id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id))
                    .slice(0, 200)
                : [];
            }
            if (data.roomBoardSize !== undefined && data.roomBoardSize !== '') {
              if (isValidBoardSize(data.roomBoardSize)) {
                room.settings.boardSize = data.roomBoardSize;
              }
            }
            // Still recorded while TILED_CANVAS_FORCE_ALL is on (the client
            // stops sending it, so this is a no-op then) — the stored value is
            // what each room falls back to when the override is cleared.
            if (ENABLE_TILED_CANVAS_BACKING_STORE && data.roomTiledCanvas !== undefined) {
              room.settings.tiledCanvasBackingStore = !!data.roomTiledCanvas;
            }
            room.settings.floatingGalleryIncludeIds = [...new Set(room.settings.floatingGalleryIncludeIds)];
            room.settings.floatingGalleryExcludeIds = [...new Set(room.settings.floatingGalleryExcludeIds)];
            room.settings.floatingGalleryIncludeIds = room.settings.floatingGalleryIncludeIds
              .filter(id => !room.settings.floatingGalleryExcludeIds.includes(id));

            await room.saveToDB();
            room.floatingWall?.refresh({ resetLayout: floatingWallReset });

            if (autoMuteGuestsChanged || autoMuteVpnUsersChanged) {
              for (const client of room.clients) {
                const effectiveRole = client.userRole || Role.GUEST;
                const { shouldMute } = await applyMuteStateToClient(client, room, {
                  userId: client.userId || null,
                  effectiveRole
                });
                createRoomBroadcaster(room)({
                  t: shouldMute ? T.HIDE_CURSOR : T.SHOW_CURSOR,
                  u: client.sessionIndex
                });
              }
            }

            // If dedicatedReplayUser changed, start/stop election accordingly
            if (room.settings.dedicatedReplayUser) {
              stopElection(room);
            } else if (!room._electionTimer) {
              startElection(room, (r) => broadcastToRoom(r, buildSettingsPayload(r)), sendTo);
            }

            // Broadcast updated settings to all clients in the room
            const roomBroadcaster = createRoomBroadcaster(room);
            roomBroadcaster(buildSettingsPayload(room));
            if (autoMuteGuestsChanged || autoMuteVpnUsersChanged) {
              roomBroadcaster({
                t: T.USERS
              });
            }

            sendTo(ws, { t: T.MOD_RESULT, a: true });
          } catch (err) {
            console.error('[Room] Update error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to update room' });
          }
          break;
        }

        case T.ROOM_REGISTER: {
          // Claim ownership of an unowned room
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in to register a room' });
            break;
          }

          if (room.ownerId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'This room already has an owner' });
            break;
          }

          // Prevent registering lobby or discovery rooms
          if (room.id === 'lobby' || room.id === '_discovery' || room.id === 'default') {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot register this room' });
            break;
          }

          try {
            room.ownerId = ws.userId;
            room.ownerUsername = ws.username;
            await room.saveToDB();

            // Update the registering user's effective role to OWNER(6)
            ws.roomRole = Role.OWNER;
            ws.userRole = computeEffectiveRole(ws.globalRole || 0, Role.OWNER);

            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) user.role = ws.userRole;

            // Notify the user of their new role
            sendTo(ws, { t: T.AUTH_RESULT, a: true, authRole: ws.userRole, authGlobalRole: ws.globalRole || 0, authRoomRole: ws.roomRole || 0 });
            room.updateSnapshotTimer();

            // Broadcast updated user list so everyone sees the new role
            createRoomBroadcaster(room)({
              t: T.USERS
            });

            // Broadcast ownership change to all clients in the room
            createRoomBroadcaster(room)({
              t: T.ROOM_OWNERSHIP,
              ownerId: room.ownerId,
              ownerUsername: room.ownerUsername
            });

            sendTo(ws, { t: T.MOD_RESULT, a: true });
            debug(`[Room] ${ws.username} registered as owner of room "${room.id}"`);
          } catch (err) {
            console.error('[Room] Register error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to register room' });
          }
          break;
        }

        case T.ROOM_UNREGISTER: {
          // Release ownership of a room (owner or DEITY only)
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          if (!room.ownerId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'This room is not registered' });
            break;
          }

          // Only room owner or DEITY can unregister
          const isRoomOwner = room.ownerId === ws.userId;
          const isDeity = (ws.globalRole || 0) >= Role.DEITY;

          if (!isRoomOwner && !isDeity) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only room owner or DEITY can unregister a room' });
            break;
          }

          try {
            const previousOwnerId = room.ownerId;
            room.ownerId = null;
            room.ownerUsername = null;
            await room.saveToDB();

            // If the unregistering user was the owner, reset their room role
            if (isRoomOwner) {
              ws.roomRole = 0;
              ws.userRole = computeEffectiveRole(ws.globalRole || 0, 0);

              const user = room.sessionManager.getUser(ws.sessionIndex);
              if (user) user.role = ws.userRole;

              // Notify the user of their new role
              sendTo(ws, { t: T.AUTH_RESULT, a: true, authRole: ws.userRole, authGlobalRole: ws.globalRole || 0, authRoomRole: ws.roomRole || 0 });
            }

            // Broadcast updated user list
            createRoomBroadcaster(room)({
              t: T.USERS
            });

            // Broadcast ownership change to all clients in the room
            createRoomBroadcaster(room)({
              t: T.ROOM_OWNERSHIP,
              ownerId: null,
              ownerUsername: null
            });

            room.updateSnapshotTimer();

            sendTo(ws, { t: T.MOD_RESULT, a: true });
            debug(`[Room] ${ws.username} unregistered room "${room.id}" (previous owner: ${previousOwnerId})`);
          } catch (err) {
            console.error('[Room] Unregister error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to unregister room' });
          }
          break;
        }

        case T.MOD_LIST: {
          if (!authorize(ws, Action.MOD_LIST, sendTo, T.MOD_RESULT)) break;

          try {
            const entries = await getModEntries({
              showHistory: !!data.modShowHistory,
              search: data.modSearch || '',
              roomId: room.id,
              viewerRole: ws.userRole || Role.GUEST
            });
            sendTo(ws, {
              t: T.MOD_LIST,
              modEntries: entries
            });
          } catch (err) {
            console.error('[Mod] List error:', err);
          }
          break;
        }

        case T.PONG:
          if (ws.pingSentAt) {
            ws.pingRtt = Date.now() - ws.pingSentAt;
            ws.pingSentAt = null;
          }
          ws.missedPongs = 0;
          ws.lowPowerMode = !!data.lowPowerMode;
          ws.tabHidden = !!data.tabHidden;
          break;

        case T.BW_PROBE_CHUNK:
          handleProbeChunk(ws, data);
          break;

        case T.BW_REPORT: {
          // Client is reporting a previously measured bps (e.g. from _discovery probe).
          // Only accept if we don't already have a better/recent measurement.
          if (ws.skipUploadBps) break;
          const reported = Number(data.uploadBps) || 0;
          if (reported > 0) {
            const existing = ws.uploadBps || 0;
            const recent = ws.lastProbeTs && (Date.now() - ws.lastProbeTs) < 60_000;
            if (!recent || reported > existing) {
              ws.uploadBps = reported;
              ws.lastProbeTs = Date.now();
              const user = room.sessionManager.getUser(ws.sessionIndex);
              if (user) {
                user.uploadBps = reported;
                user.lastProbeTs = ws.lastProbeTs;
              }
              // Persist on user doc if logged-in
              if (ws.userId) {
                const db = getDB();
                if (db) {
                  db.collection('users').updateOne(
                    { _id: new ObjectId(ws.userId) },
                    { $set: { uploadBps: reported, uploadBpsAt: new Date() } }
                  ).catch(() => {});
                }
              }
            }
          }
          break;
        }

        case T.ROOM_ROLE_SET: {
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          const targetIdentifier = String(data.roomRoleTargetId || '').trim();
          const targetUsernameLookup = String(data.roomRoleTargetName || '').trim();
          const newRole = data.roomRoleValue;

          if (newRole == null || newRole < 0 || newRole > Role.ADMIN) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Invalid role value (0-5)' });
            break;
          }

          if (!targetIdentifier && !targetUsernameLookup) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Missing target user' });
            break;
          }

          // Resolve target by online session index first, then fall back to a persisted user id.
          let targetClient = null;
          let targetUserId = '';
          let targetUsername = '';
          const targetSessionIdx = Number.parseInt(targetIdentifier, 10);

          if (targetIdentifier && Number.isInteger(targetSessionIdx) && String(targetSessionIdx) === targetIdentifier) {
            for (const client of room.clients) {
              if (client.sessionIndex === targetSessionIdx && client.readyState === WebSocket.OPEN) {
                targetClient = client;
                break;
              }
            }
          }

          if (targetClient?.userId) {
            targetUserId = targetClient.userId;
            targetUsername = targetClient.username || '';
          } else {
            const db = getDB();
            if (!db) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Database not available' });
              break;
            }

            let targetUserDoc = null;
            if (targetIdentifier && ObjectId.isValid(targetIdentifier)) {
              targetUserId = targetIdentifier;
              targetUserDoc = await db.collection('users').findOne(
                { _id: new ObjectId(targetUserId) },
                { projection: { username: 1, role: 1 } }
              );
            } else if (targetUsernameLookup) {
              targetUserDoc = await db.collection('users').findOne(
                { username: targetUsernameLookup },
                { collation: { locale: 'en', strength: 2 }, projection: { username: 1, role: 1 } }
              );
              targetUserId = targetUserDoc?._id?.toString() || '';
            }

            if (!targetUserDoc || !targetUserId) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Target user not found' });
              break;
            }
            targetUsername = targetUserDoc.username || '';
          }

          // Permission: room owner, room ADMIN(5)+, or global HOLY(8)+
          const isOwner = room.ownerId === ws.userId;
          const roomAdminAuthority = getRoomAdminAuthority(ws);
          const isRoomAdmin = roomAdminAuthority >= Role.ADMIN;
          const isDeity = (ws.globalRole || 0) >= Role.DEITY;

          if (!isOwner && !isRoomAdmin && !isDeity) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          if (room.ownerId && targetUserId === room.ownerId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Room owner role is managed by room ownership' });
            break;
          }

          // Can't assign role >= your own effective role (unless DEITY)
          if (!isDeity && newRole >= roomAdminAuthority) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot assign role equal to or higher than your own' });
            break;
          }

          try {
            const existingRoleDoc = await getRoomRole(room.id, targetUserId);
            const previousRole = existingRoleDoc?.role || 0;
            if (newRole === 0) {
              const { removeRoomRole } = await import('./roomRoles.js');
              await removeRoomRole(room.id, targetUserId);
            } else {
              await setRoomRole(room.id, {
                userId: targetUserId,
                username: targetUsername,
                role: newRole,
                assignedBy: ws.userId,
                assignedByUsername: ws.username || '',
                previousRole
              });
            }

            // Update their effective role live
            if (targetClient) {
              targetClient.roomRole = newRole;
              const effective = computeEffectiveRole(targetClient.globalRole || 0, newRole);
              targetClient.userRole = effective;

              const targetUser = room.sessionManager.getUser(targetClient.sessionIndex);
              if (targetUser) targetUser.role = effective;

              const { shouldMute } = await applyMuteStateToClient(targetClient, room, {
                userId: targetClient.userId || null,
                effectiveRole: effective
              });
              await applySilenceStateToClient(targetClient, room, {
                userId: targetClient.userId || null,
                effectiveRole: effective
              });

              // Notify the target user of their new role
              sendTo(targetClient, { t: T.AUTH_RESULT, a: true, authRole: effective, authGlobalRole: targetClient.globalRole || 0, authRoomRole: targetClient.roomRole || 0 });

              createRoomBroadcaster(room)({
                t: shouldMute ? T.HIDE_CURSOR : T.SHOW_CURSOR,
                u: targetClient.sessionIndex
              });
            }

            // Re-broadcast user list so all clients see updated role badge
            createRoomBroadcaster(room)({
              t: T.USERS
            });

            sendTo(ws, { t: T.MOD_RESULT, a: true });
          } catch (err) {
            console.error('[Room] Role set error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to set room role' });
          }
          break;
        }

        case T.ROOM_ROLE_LIST_REQUEST: {
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          const isOwner = room.ownerId === ws.userId;
          const isRoomAdmin = getRoomAdminAuthority(ws) >= Role.ADMIN;
          const isDeity = (ws.globalRole || 0) >= Role.DEITY;
          if (!isOwner && !isRoomAdmin && !isDeity) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          try {
            const roster = await getRoomRoleRoster(room);
            sendTo(ws, {
              t: T.ROOM_ROLE_LIST_RESPONSE,
              roomRoles: roster.map(entry => ({
                userId: entry.userId,
                username: entry.username,
                role: entry.role,
                updatedBy: entry.updatedBy,
                updatedByUsername: entry.updatedByUsername,
                updatedAt: entry.updatedAt,
                previousRole: entry.previousRole,
                changeType: entry.changeType,
                isOwner: entry.isOwner
              }))
            });
          } catch (err) {
            console.error('[Room] Role list error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to load room moderators' });
          }
          break;
        }

        case T.GLOBAL_ROLE_SET: {
          // Only DEITY (role 9) can set global roles
          if (!ws.userId || (ws.globalRole || 0) < Role.DEITY) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only DEITY can set global roles' });
            break;
          }

          const db = getDB();
          if (!db) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Database not available' });
            break;
          }

          const targetUsername = String(data.targetUsername || '').trim();
          const newGlobalRole = data.newGlobalRole;

          if (!targetUsername) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Target username required' });
            break;
          }

          try {
            // Find the target user by username
            const targetUser = await db.collection('users').findOne({ username: targetUsername });
            if (!targetUser) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'User not found' });
              break;
            }

            const previousGlobalRole = targetUser.role || Role.GUEST;
            const allowedGlobalRoles = new Set([Role.USER, Role.NOBLE, Role.HOLY]);
            if (!allowedGlobalRoles.has(newGlobalRole)) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Can only set global role to User, Noble, or Holy' });
              break;
            }

            // Prevent setting role on other Deities
            if (previousGlobalRole >= Role.DEITY) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot modify DEITY rank' });
              break;
            }

            if (previousGlobalRole === newGlobalRole) {
              sendTo(ws, {
                t: T.MOD_RESULT,
                a: true,
                message: `${targetUsername} is already ${RoleNames[newGlobalRole] || 'role ' + newGlobalRole}`
              });
              break;
            }

            const actionLabel = newGlobalRole > previousGlobalRole
              ? 'promoted'
              : newGlobalRole < previousGlobalRole
                ? 'demoted'
                : 'updated';

            // Update the user's global role
            await db.collection('users').updateOne(
              { _id: targetUser._id },
              { $set: { role: newGlobalRole } }
            );

            // Update all active connections for this user
            const roomsNeedingRefresh = new Set();
            for (const client of wss.clients) {
              if (client.userId === String(targetUser._id)) {
                const clientRoom = roomManager.getRoomByClient(client);
                const roomRole = client.roomRole || 0;
                let effectiveRole = computeEffectiveRole(newGlobalRole, roomRole);
                if (clientRoom?.ownerId && client.userId === clientRoom.ownerId) {
                  effectiveRole = Math.max(effectiveRole, Role.OWNER);
                }

                client.globalRole = newGlobalRole;
                client.userRole = effectiveRole;

                if (clientRoom) {
                  const roomUser = clientRoom.sessionManager.getUser(client.sessionIndex);
                  if (roomUser) {
                    roomUser.role = effectiveRole;
                    roomUser.registeredName = targetUser.username || roomUser.registeredName;
                    roomUser.isMuted = !!client.isMuted;
                  }

                  const { shouldMute } = await applyMuteStateToClient(client, clientRoom, {
                    userId: client.userId || null,
                    effectiveRole
                  });
                  await applySilenceStateToClient(client, clientRoom, {
                    userId: client.userId || null,
                    effectiveRole
                  });

                  sendTo(client, { t: T.AUTH_RESULT, a: true, authRole: effectiveRole, authGlobalRole: client.globalRole || 0, authRoomRole: client.roomRole || 0 });
                  createRoomBroadcaster(clientRoom)({
                    t: shouldMute ? T.HIDE_CURSOR : T.SHOW_CURSOR,
                    u: client.sessionIndex
                  });
                  roomsNeedingRefresh.add(clientRoom);
                }
              }
            }

            // Send success to requester
            sendTo(ws, {
              t: T.MOD_RESULT,
              a: true,
              message: `${targetUsername} ${actionLabel} to ${RoleNames[newGlobalRole] || 'role ' + newGlobalRole}`
            });

            // Broadcast updated user lists so role badges refresh anywhere they're active
            for (const activeRoom of roomsNeedingRefresh) {
              broadcastUsersForRoom(activeRoom);
            }
          } catch (err) {
            console.error('[Global Role] Error setting global role:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to set global role' });
          }
          break;
        }

        case T.GLOBAL_MESSAGE: {
          if ((ws.globalRole || 0) < Role.HOLY) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only HOLY or DEITY can send global messages' });
            break;
          }

          const issuer = ws.username || ws.authUsername || ws.userId || 'Staff';
          broadcastGlobalMessage({
            message: data.g,
            kind: data.k || 'staff',
            issuer,
            persistent: !!data.a
          });
          sendTo(ws, { t: T.MOD_RESULT, a: true });
          break;
        }

        case T.AUTH_REGISTER: {
          const db = getDB();
          if (!db) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Database not available' });
            break;
          }

          const registerLimit = wsRateLimiter.consume(rateLimitKey('wsauth:register', ws.clientIp), WS_AUTH_LIMIT);
          if (!registerLimit.allowed) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Too many registration attempts. Please try again later.' });
            break;
          }

          const regUsername = normalizeUsername(data.authUsername || '');
          const regPassword = data.authPassword || '';
          const regEmail = (data.authEmail || '').trim().toLowerCase();
          const regSecretQuestion = (data.authSecretQuestion || '').trim();
          const regSecretAnswer = (data.authSecretAnswer || '').trim();
          const identity = normalizeIdentityPayload(data);

          if (!isValidUsername(regUsername)) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: getUsernameValidationMessage() });
            break;
          }
          if (regPassword.length < 6) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Password must be at least 6 characters' });
            break;
          }
          if (regSecretQuestion && !regSecretAnswer) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Secret answer is required when providing a secret question' });
            break;
          }

          try {
            const passwordHash = await hashPassword(regPassword);
            // Hash the secret answer the same way as passwords (bcrypt)
            const secretAnswerHash = regSecretAnswer ? await hashPassword(regSecretAnswer.toLowerCase()) : null;
            const role = Role.USER;

            const newUserDoc = {
              username: regUsername,
              passwordHash,
              role,
              createdAt: new Date(),
              lastLoginAt: new Date(),
              lastIp: ws.clientIp,
              lastSubnet: ws.clientSubnet || null,
              lastDeviceId: identity.deviceId || null,
              lastFingerprintId: identity.fingerprintId || null,
              lastIdentitySummary: identity.identitySummary,
              ipHistory: [ws.clientIp],
              subnetHistory: ws.clientSubnet ? [ws.clientSubnet] : [],
              deviceIds: identity.deviceId ? [identity.deviceId] : [],
              fingerprintIds: identity.fingerprintId ? [identity.fingerprintId] : [],
              // Metrics tracking (for achievements)
              distanceDrawn: 0,
              totalStrokes: 0,
              timeSpentMs: 0,
              chatMessagesSent: 0,
              consecutiveDaysDrawn: 0,
              uniqueToolsUsed: [],
              dailyMetrics: [],
              lastActiveDate: null,
              firstActivityDate: null
            };
            if (regEmail) newUserDoc.email = regEmail;
            if (regSecretQuestion) {
              newUserDoc.secretQuestion = regSecretQuestion;
              newUserDoc.secretAnswerHash = secretAnswerHash;
            }

            const result = await db.collection('users').insertOne(newUserDoc);
            const token = generateToken({ userId: result.insertedId.toString(), username: regUsername, role });

            ws.userId = result.insertedId.toString();
            ws.globalRole = role;
            ws.roomRole = 0;
            ws.userRole = role;  // No room role yet for new registration
            ws.username = regUsername;
            ws.deviceId = identity.deviceId || ws.deviceId;
            ws.fingerprintId = identity.fingerprintId || ws.fingerprintId;
            ws.identitySummary = identity.identitySummary || ws.identitySummary;
            await applyShadowBanStateToClient(ws, room, { userId: ws.userId, effectiveRole: ws.userRole });

            // Initialize metrics tracking for new user
            metricsTracker.initUser(ws.userId);

            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) {
              const uniqueName = getUniqueVisibleName(room, regUsername, ws.sessionIndex);
              user.role = role;
              user.name = uniqueName;
              user.registeredName = regUsername;
              user.hasDiscord = false;
              user.isShadowBanned = !!ws.isShadowBanned;
              // ws.username remains the original registered username for AUTH_RESULT
            }

            sendTo(ws, {
              t: T.AUTH_RESULT,
              a: true,
              authToken: token,
              authRole: role,
              authGlobalRole: role,
              authRoomRole: 0,
              authUsername: regUsername,
              authHasDiscord: false
            });

            await recordConnectionEvent(db, {
              type: 'ws_register',
              source: 'ws',
              roomId: room.id,
              sessionIndex: ws.sessionIndex,
              userId: result.insertedId.toString(),
              username: regUsername,
              ip: ws.clientIp,
              subnet: ws.clientSubnet,
              deviceId: ws.deviceId || null,
              fingerprintId: ws.fingerprintId || null,
              identitySummary: ws.identitySummary,
              userAgent: ws.userAgent,
              clientAsn: ws.clientAsn || null,
              isVpnNetwork: !!ws.isVpnNetwork
            });

            room.updateSnapshotTimer();

            broadcastUsersForRoom(room);
            if (ws.isShadowBanned) {
              createRoomBroadcaster(room)({ t: T.HIDE_CURSOR, u: ws.sessionIndex });
            }
          } catch (err) {
            if (err.code === 11000) {
              sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Username already taken' });
            } else {
              console.error('[Auth] Registration error:', err);
              sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Registration failed' });
            }
          }
          break;
        }

        case T.AUTH_LOGIN: {
          debug(`[Auth] AUTH_LOGIN from session ${ws.sessionIndex} in room ${room.id} (token: ${!!data.authToken}, user/pass: ${!!data.authUsername})`);
          const db = getDB();
          if (!db) {
            debug('[Auth] DB not available, rejecting');
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Database not available' });
            break;
          }

          const wsLoginKey = rateLimitKey('wsauth:login', ws.clientIp);

          try {
            let userDoc = null;
            const identity = normalizeIdentityPayload(data);
            ws.deviceId = identity.deviceId || ws.deviceId;
            ws.fingerprintId = identity.fingerprintId || ws.fingerprintId;
            ws.identitySummary = identity.identitySummary || ws.identitySummary;

            if (data.authToken) {
              const decoded = verifyToken(data.authToken);
              if (!decoded?.userId || !ObjectId.isValid(decoded.userId)) {
                debug('[Auth] Token invalid/expired');
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Invalid or expired token' });
                break;
              }

              userDoc = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
              if (!userDoc) {
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Account not found' });
                break;
              }
            } else if (data.authUsername && data.authPassword) {
              const loginLimit = wsRateLimiter.inspect(wsLoginKey);
              if (loginLimit.blocked) {
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Too many login attempts. Please try again later.' });
                break;
              }

              const normalizedLoginUsername = normalizeUsername(data.authUsername);
              userDoc = await db.collection('users').findOne(
                { username: normalizedLoginUsername },
                { collation: { locale: 'en', strength: 2 } }
              );
              if (!userDoc) {
                wsRateLimiter.consume(wsLoginKey, WS_AUTH_LIMIT);
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Invalid username or password' });
                break;
              }
              const passwordValid = await verifyPassword(data.authPassword, userDoc.passwordHash);
              if (!passwordValid) {
                wsRateLimiter.consume(wsLoginKey, WS_AUTH_LIMIT);
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Invalid username or password' });
                break;
              }

              wsRateLimiter.reset(wsLoginKey);
            } else {
              sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Missing credentials' });
              break;
            }

            // Room-scoped ban check (matches room bans + global bans)
            const banCheck = await checkBan(userDoc._id.toString(), ws.clientIp, room.id);

            if (banCheck) {
              const globalRole = userDoc.role;
              const isRoomBan = banCheck.roomId != null;
              // HOLY(7)+ are immune to room bans; room owner immune to own-room bans
              const isImmune = (isRoomBan && globalRole >= Role.HOLY)
                || (isRoomBan && room.ownerId === userDoc._id.toString());

              if (!isImmune && globalRole < Role.MOD) {
                const expiry = banCheck.expiresAt ? ` until ${banCheck.expiresAt.toISOString()}` : ' permanently';
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: `You are banned${expiry}. Reason: ${banCheck.reason || 'No reason given'}` });
                ws.close(4001, 'Banned');
                break;
              }
            }

            // Room-scoped mute check
            const minJoinRole = getJoinPolicyMinRole(room.settings.joinPolicy);
            if (userDoc.role < minJoinRole) {
              sendTo(ws, {
                t: T.AUTH_RESULT,
                a: false,
                authError: room.settings.joinPolicy === 'trusted'
                  ? 'This room is restricted to trusted users and above'
                  : 'This room is restricted to registered users'
              });
              break;
            }

            const ipHistory = mergeHistory(userDoc.ipHistory, ws.clientIp);
            const subnetHistory = mergeHistory(userDoc.subnetHistory, ws.clientSubnet);
            const deviceIds = mergeHistory(userDoc.deviceIds, ws.deviceId);
            const fingerprintIds = mergeHistory(userDoc.fingerprintIds, ws.fingerprintId);

            await db.collection('users').updateOne(
              { _id: userDoc._id },
              {
                $set: {
                  lastLoginAt: new Date(),
                  lastIp: ws.clientIp,
                  lastSubnet: ws.clientSubnet || null,
                  lastDeviceId: ws.deviceId || null,
                  lastFingerprintId: ws.fingerprintId || null,
                  lastIdentitySummary: ws.identitySummary,
                  ipHistory,
                  subnetHistory,
                  deviceIds,
                  fingerprintIds
                }
              }
            );

            const token = generateToken({
              userId: userDoc._id.toString(),
              username: userDoc.username,
              role: userDoc.role
            });

            // Compute effective role: max(global, room-specific, owner status)
            const roomRoleDoc = await getRoomRole(room.id, userDoc._id.toString());
            let roomRoleVal = roomRoleDoc?.role || 0;
            // Room owner automatically gets OWNER(6) role in their room
            if (room.ownerId === userDoc._id.toString()) {
              roomRoleVal = Math.max(roomRoleVal, Role.OWNER);
            }
            const effectiveRole = computeEffectiveRole(userDoc.role, roomRoleVal);

            ws.userId = userDoc._id.toString();
            ws.globalRole = userDoc.role;
            ws.roomRole = roomRoleVal;
            ws.userRole = effectiveRole;
            ws.username = userDoc.username;
            await applyShadowBanStateToClient(ws, room, {
              userId: userDoc._id.toString(),
              effectiveRole
            });

            // Initialize metrics tracking for logged-in user
            metricsTracker.initUser(ws.userId);
            logVpnAutoMuteContext(ws, room, `Auth login for ${userDoc.username}`);
            const { shouldMute, muteReason } = await applyMuteStateToClient(ws, room, {
              userId: userDoc._id.toString(),
              effectiveRole
            });
            await applySilenceStateToClient(ws, room, {
              userId: userDoc._id.toString(),
              effectiveRole
            });
            debug(`[Auth] Login success: ${userDoc.username} (global=${userDoc.role}, room=${roomRoleVal}, effective=${effectiveRole}) in room ${room.id}`);
            if (room.settings.autoMuteVpnUsers && ws.isVpnNetwork && !isVpnAutoMuteExempt(effectiveRole) && shouldMute) {
              console.warn(`[Security] Auto-muted user ${userDoc.username} on VPN ASN ${ws.clientAsn || 'unknown'} in room ${room.id}`);
            }

            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) {
              const uniqueName = getUniqueVisibleName(room, userDoc.username, ws.sessionIndex);
              user.role = effectiveRole;
              user.name = uniqueName;
              user.registeredName = userDoc.username;
              user.hasDiscord = !!userDoc.discord?.id;
              user.selectedBadge = userDoc.selectedBadge || '';
              user.isSupporter = isSupporterActive(userDoc);
              user.isMuted = !!ws.isMuted;
              user.isSilenced = !!ws.isSilenced;
              user.isShadowBanned = !!ws.isShadowBanned;
              user.isVPN = !!ws.isVPN;
              // Hydrate persisted bandwidth estimate so the first election has data
              if (!ws.skipUploadBps && typeof userDoc.uploadBps === 'number' && userDoc.uploadBps > 0) {
                user.uploadBps = userDoc.uploadBps;
                ws.uploadBps = userDoc.uploadBps;
              }
            }

            sendTo(ws, {
              t: T.AUTH_RESULT,
              a: true,
              authToken: token,
              authRole: effectiveRole,
              authGlobalRole: userDoc.role,
              authRoomRole: roomRoleVal,
              authUsername: userDoc.username,
              authHasEmail: !!userDoc.email,
              authEmailPromptDeclined: !!userDoc.emailPromptDeclined,
              authHasDiscord: !!userDoc.discord?.id,
              authNeedsUsernameSetup: !!userDoc.discord?.id && !userDoc.passwordHash && !userDoc.discord?.usernameSetupCompleted,
              authSuggestedUsername: userDoc.discord?.username || '',
              authBadge: userDoc.selectedBadge || '',
              authSupporter: isSupporterActive(userDoc)
            });

            await recordConnectionEvent(db, {
              type: 'ws_login',
              source: 'ws',
              roomId: room.id,
              sessionIndex: ws.sessionIndex,
              userId: userDoc._id.toString(),
              username: userDoc.username,
              ip: ws.clientIp,
              subnet: ws.clientSubnet,
              deviceId: ws.deviceId || null,
              fingerprintId: ws.fingerprintId || null,
              identitySummary: ws.identitySummary,
              userAgent: ws.userAgent,
              clientAsn: ws.clientAsn || null,
              isVpnNetwork: !!ws.isVpnNetwork
            });

            room.updateSnapshotTimer();

            broadcastUsersForRoom(room);
            if (ws.isShadowBanned) {
              createRoomBroadcaster(room)({ t: T.HIDE_CURSOR, u: ws.sessionIndex });
            }

            if (ws.isMuted && !ws.isShadowBanned) {
              // Hide cursor for all other users
              createRoomBroadcaster(room)({ t: T.HIDE_CURSOR, u: ws.sessionIndex });

              // Notify the muted user
              sendTo(ws, {
                t: T.MOD_NOTIFY,
                modActionType: 1,
                modTarget: ws.sessionIndex,
                modTargetName: userDoc.username,
                modIssuerName: 'System',
                modReason: muteReason || ''
              });
            }
          } catch (err) {
            console.error('[Auth] Login error:', err);
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Login failed' });
          }
          break;
        }

        case T.BOARD_SNAPSHOT_SAVE:
          if (ws.isShadowBanned) break;
          await handleSnapshotSave(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_LIST_REQUEST:
          await handleSnapshotList(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_RESTORE:
          if (ws.isShadowBanned) break;
          await handleSnapshotRestore(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_DELETE:
          if (ws.isShadowBanned) break;
          await handleSnapshotDelete(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_GET:
          await handleSnapshotGet(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_REGION_RESTORE:
          if (ws.isShadowBanned) break;
          await handleSnapshotRegionRestore(ws, data, room);
          break;

        case T.ROOM_START_SNAPSHOT_GET:
          await handleStartStateGet(ws, data, room);
          break;

        case T.ROOM_START_SNAPSHOT_SET:
          if (ws.isShadowBanned) break;
          await handleStartStateSet(ws, data, room);
          break;

        case T.CHECKPOINT_UPLOAD: {
          if (ws.isShadowBanned) break;
          const cpId = await handleCheckpointUpload(ws, data, room);
          if (ENABLE_SERVER_REPLAY_DB && cpId && (room.settings.dedicatedReplayUser || room._electedUploader)) {
            getRecorder(room.id).onCheckpoint(cpId);
          }
          break;
        }

        case T.CHECKPOINT_LIST:
          await handleCheckpointList(ws, room);
          break;

        case T.CHECKPOINT_GET:
          await handleCheckpointGet(ws, data, room);
          break;

        case T.REPLAY_REQUEST: {
          const { checkpointId: replayCpId, deltas } = await getReplayData(
            room.id, data.replayStartTs, data.replayEndTs
          );
          // Fetch checkpoint image if available
          let cpImg = null;
          let cpMirror = false;
          let cpMirrorRegions = [];
          let checkpointActiveTexts = [];
          let checkpointTs = 0;
          if (replayCpId) {
            const cpDb = getDB();
            if (cpDb) {
              const cpDoc = await cpDb.collection('checkpoints').findOne(
                { roomId: room.id, checkpointId: replayCpId },
                { projection: { img: 1, mirror: 1, mirrorRegions: 1, activeTexts: 1, timestamp: 1 } }
              );
              if (cpDoc) {
                cpImg = cpDoc.img;
                cpMirror = !!cpDoc.mirror;
                cpMirrorRegions = Array.isArray(cpDoc.mirrorRegions) ? cpDoc.mirrorRegions : [];
                checkpointActiveTexts = Array.isArray(cpDoc.activeTexts) ? cpDoc.activeTexts : [];
                checkpointTs = Number(cpDoc.timestamp) || 0;
              }
            }
          }
          const activeTextDeltas = checkpointActiveTexts
            .map((r) => {
              const lifetimeMs = Math.max(0, Number(r.lifetimeMs) || 0);
              const bornAt = Number(r.bornAt) || 0;
              const ageMs = Math.max(0, checkpointTs - bornAt);
              if (!checkpointTs || !lifetimeMs || ageMs >= lifetimeMs) return null;
              return {
                _ts: checkpointTs,
                t: T.TEXT_APPLY,
                u: r.sessionIndex,
                g: r.text || '',
                ps: [Number(r.x) || 0, Number(r.y) || 0],
                s: Number(r.size) || 1000,
                c: Number(r.color) >>> 0,
                p: Number(r.opacity) || 100,
                ly: Number(r.layerIndex) || 0,
                bm: r.blendMode || 'source-over',
                bbm: normalizeBlendBakeMode(r.blendBakeMode),
                fo: r.font || '',
                tm: Number.isFinite(Number(r.textPositionMultiplier)) ? Number(r.textPositionMultiplier) : 0,
                to: Number.isFinite(Number(r.textPositionOffset)) ? Number(r.textPositionOffset) : 0,
                textId: r.id || '',
                textLifetimeMs: lifetimeMs,
                textFadeMs: Math.max(0, Math.min(Number(r.fadeMs) || lifetimeMs, lifetimeMs)),
                textAgeMs: ageMs,
                textPixel: false
              };
            })
            .filter(Boolean);
          sendTo(ws, {
            t: T.REPLAY_RESPONSE,
            checkpointId: replayCpId || '',
            checkpointImg: cpImg || new Uint8Array(0),
            m: cpMirror,
            mirrorRegionsJson: JSON.stringify(cpMirrorRegions),
            replayDeltasJson: JSON.stringify([...activeTextDeltas, ...deltas])
          });
          break;
        }

        default:
          if (ws.sessionIndex !== undefined) {
            handleBroadcast(data, ws.sessionIndex, room, ws);
          }
          break;
      }
    } catch (err) {
      const preview = Buffer.from(rawData).subarray(0, 32);
      console.error(`[WS] Decode error (${rawData.length} bytes, session ${ws.sessionIndex ?? 'unassigned'}): ${err.message}`);
    }
  };

  ws.messageChain = Promise.resolve();
  ws.on('message', (rawData) => {
    ws.messageChain = ws.messageChain.then(() => handleClientMessage(rawData)).catch((err) => {
      console.error(`[WS] Unhandled message error (session ${ws.sessionIndex ?? 'unassigned'}): ${err.message}`);
    });
  });

  ws.on('close', (code, reason) => {
    discardClientOutbox(ws);
    cancelProbesForSocket(ws);

    // Flush metrics for disconnecting user
    if (ws.userId) {
      metricsTracker.onUserDisconnect(ws.userId).catch(err => {
        console.error('[Metrics] Error on user disconnect:', err);
      });
    }

    if (ws.pingInterval) {
      clearInterval(ws.pingInterval);
    }

    const sessionIndex = ws.sessionIndex;
    const room = roomManager.getRoomByClient(ws);

    if (!room) return;

    room.removeClient(ws);
    room.updateSnapshotTimer();

    if (room.getClientCount() === 0) {
      room.resetJoinSyncState?.();
      roomManager.markJoinCheckpointInvalidated?.(room.id);
    }

    // Going from many witnesses to one: ask the last user to upload a fresh
    // snapshot now, so if they drop next the post-empty restore matches what
    // they actually saw rather than a 15s-stale auto-save.
    if (room.getClientCount() === 1) {
      room._requestSnapshot?.();
    }

    if (sessionIndex === undefined) {
      if (room.getClientCount() === 0 && !(room.pendingDisconnects?.size)) {
        roomManager.cleanupEmptyRooms();
      }
      return;
    }

    // If another open socket already owns this session, this close belongs to
    // an older transport that lost the race during reconnect. Do not start a
    // grace timer that could later remove the active replacement.
    if (hasOpenClientForSession(room, sessionIndex)) {
      clearPendingDisconnectsForSession(room, sessionIndex);
      return;
    }

    // Hold the session open briefly for a same-tab reconnect. The client
    // generates a per-tab resumeKey and replays it on CONNECT; if it lands
    // within the grace window the user keeps their sessionIndex and peers
    // can see them reappear without allocating a new slot.
    // 4010 = the client left the room on purpose (App.disconnect).
    const INTENTIONAL_CLOSE_CODES = new Set([4000, 4001, 4002, 4003, 4009, 4010, 4401, 4408]);
    const isIntentionalClose = INTENTIONAL_CLOSE_CODES.has(Number(code));
    // A kicked socket that had to be terminated closes as 1006, not 4002, so the
    // code alone would read as an accidental drop and hold the slot open for a
    // resume — handing the kicked user their session back.
    const canResume = !!ws.resumeKey && !ws.isShadowBanned && !isIntentionalClose && !ws.kicked;

    if (canResume) {
      const user = room.sessionManager.getUser(sessionIndex);
      // Clear in-progress stroke state so a stale `mousedown` doesn't bleed
      // into AFK detection or the next stroke if the user does come back.
      if (user) user.mousedown = false;

      if (!room.pendingDisconnects) room.pendingDisconnects = new Map();
      const prior = room.pendingDisconnects.get(ws.resumeKey);
      if (prior) clearTimeout(prior.timer);

      const RESUME_GRACE_MS = 15_000;
      const timer = setTimeout(() => {
        const entry = room.pendingDisconnects?.get(ws.resumeKey);
        if (!entry || entry.timer !== timer) return;
        room.pendingDisconnects.delete(ws.resumeKey);
        debug(`[WS] Grace expired for sessionIndex=${sessionIndex}; finalizing disconnect`);
        finalizeSessionRemoval(room, sessionIndex, ws);
      }, RESUME_GRACE_MS);

      room.pendingDisconnects.set(ws.resumeKey, { sessionIndex, timer });
      broadcastUsersForRoom(room);
      debug(`[WS] Holding session ${sessionIndex} for ${RESUME_GRACE_MS}ms (resumeKey=${ws.resumeKey.slice(0, 8)}…)`);
      return;
    }

    finalizeSessionRemoval(room, sessionIndex, ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Server] ${signal} received, warning clients before shutdown`);

  // Intentionally do NOT broadcast a "please reload" notice here: the new
  // server version isn't live yet, so telling clients to refresh would race
  // the restart. Clients see the close with code 4000 instead and wait for
  // the version poller to detect the new version.
  server.close(() => {
    console.log('[Server] HTTP server closed');
  });

  setTimeout(() => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(4000, 'server-restarting');
      }
    });
  }, 2500);

  setTimeout(() => {
    metricsTracker.stop?.();
    clearInterval(onlineUsersLogInterval);
    clearInterval(ghostSweepInterval);
    process.exit(0);
  }, 8000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

init().catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});
