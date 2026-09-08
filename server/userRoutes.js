/** @fileoverview User profile API endpoints. */

import { ObjectId } from 'mongodb';
import { getDB } from './db.js';
import { getRequestUser, getBearerToken, getUserFromToken } from './authUser.js';
import { corsHeaders, writeJson, readRequestBody } from './httpUtils.js';
import { isSupporterActive } from './supporter.js';

const CORS_HEADERS = corsHeaders('GET, POST, PATCH, OPTIONS');

const AVATAR_MAX_BYTES = 64 * 1024; // ~64KB after base64 encoding
const PROFILE_BODY_LIMIT = 128 * 1024;

// Cosmetic badges a user may pick for themselves. Keep in sync with the
// `selectable` entries in src/ui/Badges.js.
const SELECTABLE_BADGES = new Set(['flock', 'pepper']);

function json(res, status, body) {
  writeJson(res, status, body, CORS_HEADERS);
}

function stripSessionSuffix(username) {
  if (typeof username !== 'string') return '';
  return username.trim().replace(/-\d+$/, '');
}

function readBody(req, maxBytes = PROFILE_BODY_LIMIT) {
  return readRequestBody(req, maxBytes);
}

/**
 * GET /api/users/:username — fetch public user profile.
 */
export async function handleUserProfile(req, res, username) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  try {
    const users = db.collection('users');
    const normalizedUsername = stripSessionSuffix(username);

    let user = await users.findOne(
      { username },
      { collation: { locale: 'en', strength: 2 } }
    );

    if (!user && normalizedUsername && normalizedUsername !== username) {
      user = await users.findOne(
        { username: normalizedUsername },
        { collation: { locale: 'en', strength: 2 } }
      );
    }

    if (!user) {
      return json(res, 404, { error: 'User not found' });
    }

    // Determine if the requester is viewing their own profile
    let isOwn = false;
    const token = getBearerToken(req);
    if (token) {
      const requester = await getUserFromToken(token, { projection: { _id: 1 } });
      if (requester && String(requester._id) === String(user._id)) {
        isOwn = true;
      }
    }

    // Uploads made with the username tag off still store their real author, so
    // every public credit query has to exclude them — otherwise the profile
    // lists the very upload the user chose to publish anonymously.
    const authoredPublicly = { author: user.username, tagUsername: { $ne: false } };

    const [uploadCount, totalLikes] = await Promise.all([
      db.collection('gallery').countDocuments(authoredPublicly),
      db.collection('gallery').aggregate([
        { $match: authoredPublicly },
        { $group: { _id: null, total: { $sum: '$likesCount' } } }
      ]).toArray(),
    ]);

    const recentUploads = await db.collection('gallery')
      .find(authoredPublicly)
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    json(res, 200, {
      username: user.username,
      role: user.role || 1,
      createdAt: user.createdAt || null,
      avatar: user.avatar || null,
      status: user.status || '',
      selectedBadge: user.selectedBadge || '',
      hasDiscord: !!user.discord?.id,
      isSupporter: isSupporterActive(user),
      distanceDrawn: user.distanceDrawn || 0,
      totalStrokes: user.totalStrokes || 0,
      timeSpentMs: user.timeSpentMs || 0,
      consecutiveDaysDrawn: user.consecutiveDaysDrawn || 0,
      uploadCount,
      totalLikes: totalLikes[0]?.total || 0,
      isOwn,
      recentUploads: recentUploads.map(item => ({
        id: item._id.toString(),
        url: item.url,
        thumbUrl: item.thumbUrl || item.url,
        author: item.author,
        title: item.title || '',
        likesCount: item.likesCount || 0,
        views: item.views || 0,
        createdAt: item.createdAt,
        animatedUrl: item.animatedUrl || null,
      })),
    });
  } catch (err) {
    console.error('[Users] Profile error:', err);
    json(res, 500, { error: 'Failed to fetch profile' });
  }
}

/**
 * PATCH /api/users/me/profile — update status and/or avatar for the authenticated user.
 * Body: { status?: string, avatar?: string|null }  (avatar is a data URL)
 */
export async function handleUpdateProfile(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const me = await getRequestUser(req, { projection: { _id: 1, discord: 1, supporterUntil: 1 } });
  if (!me) return json(res, 401, { error: 'Authentication required' });

  let payload;
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return json(res, 400, { error: 'Invalid request body' });
  }

  const updates = {};

  if (payload.status !== undefined) {
    if (payload.status === null) {
      updates.status = '';
    } else if (typeof payload.status === 'string') {
      const trimmed = payload.status.replace(/\s+/g, ' ').trim().slice(0, 140);
      updates.status = trimmed;
    } else {
      return json(res, 400, { error: 'Status must be a string' });
    }
  }

  if (payload.avatar !== undefined) {
    if (payload.avatar === null || payload.avatar === '') {
      updates.avatar = null;
    } else if (typeof payload.avatar === 'string') {
      if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(payload.avatar)) {
        return json(res, 400, { error: 'Avatar must be a base64 image data URL' });
      }
      if (payload.avatar.length > AVATAR_MAX_BYTES) {
        return json(res, 413, { error: 'Avatar too large' });
      }
      updates.avatar = payload.avatar;
    } else {
      return json(res, 400, { error: 'Avatar must be a string or null' });
    }
  }

  if (payload.selectedBadge !== undefined) {
    const badge = payload.selectedBadge;
    if (badge === null || badge === '' || badge === 'none') {
      updates.selectedBadge = badge === 'none' ? 'none' : '';
    } else if (typeof badge === 'string' && SELECTABLE_BADGES.has(badge)) {
      updates.selectedBadge = badge;
    } else if (badge === 'discord' && !!me.discord?.id) {
      updates.selectedBadge = 'discord';
    } else if (badge === 'supporter' && isSupporterActive(me)) {
      updates.selectedBadge = 'supporter';
    } else {
      return json(res, 400, { error: 'Unknown badge' });
    }
  }

  if (Object.keys(updates).length === 0) {
    return json(res, 400, { error: 'Nothing to update' });
  }

  try {
    await db.collection('users').updateOne(
      { _id: new ObjectId(me._id) },
      { $set: updates }
    );
    json(res, 200, { ok: true, ...updates });
  } catch (err) {
    console.error('[Users] Update profile error:', err);
    json(res, 500, { error: 'Failed to update profile' });
  }
}
