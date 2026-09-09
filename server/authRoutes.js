/** @fileoverview HTTP auth endpoints for gallery and other non-WebSocket clients. */

import { ObjectId } from 'mongodb';
import { getDB } from './db.js';
import { hashPassword, verifyPassword, generateToken } from './auth.js';
import { getBearerToken, getUserFromToken } from './authUser.js';
import { getClientIp, httpRateLimiter } from './security.js';
import { getUsernameValidationMessage, isValidUsername, normalizeUsername } from '../shared/identity.js';
import { Role } from './SessionManager.js';
import { getIpSubnet, mergeHistory, normalizeIdentityPayload, recordConnectionEvent } from './identityTracking.js';
import { corsHeaders, writeJson, readRequestBody } from './httpUtils.js';
import { checkBan } from './moderation.js';
import crypto from 'crypto';

const CORS_HEADERS = corsHeaders('GET, POST, OPTIONS');

const AUTH_BODY_LIMIT = 16 * 1024;
const LOGIN_RATE_LIMIT = { max: 10, windowMs: 5 * 60 * 1000, blockMs: 15 * 60 * 1000 };
const REGISTER_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };
const RESET_REQUEST_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };
const RESET_COMPLETE_RATE_LIMIT = { max: 10, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const DISCORD_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DISCORD_OAUTH_SCOPE = 'identify';
const USERNAME_CHANGE_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;

function json(res, status, body) {
  writeJson(res, status, body, CORS_HEADERS);
}

function readBody(req, maxBytes = AUTH_BODY_LIMIT) {
  return readRequestBody(req, maxBytes);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashOAuthState(state) {
  return crypto.createHash('sha256').update(state).digest('hex');
}

function getRequestOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (host?.includes('localhost') ? 'http' : 'https');
  return host ? `${proto}://${host}` : (process.env.PUBLIC_APP_URL || 'https://ddraw.ca');
}

function buildResetLink(req, token) {
  const baseUrl = (process.env.PUBLIC_APP_URL || getRequestOrigin(req)).replace(/\/+$/, '');
  return `${baseUrl}/go/?resetToken=${encodeURIComponent(token)}`;
}

function getPublicAppBase(req) {
  return (process.env.PUBLIC_APP_URL || getRequestOrigin(req)).replace(/\/+$/, '');
}

function getDiscordRedirectUri(req) {
  const resolved = process.env.DISCORD_REDIRECT_URI || `${getPublicAppBase(req)}/api/auth/discord/callback`;
  console.log('[DiscordDebug] redirect_uri resolved to:', resolved,
    '| env DISCORD_REDIRECT_URI=', process.env.DISCORD_REDIRECT_URI,
    '| env PUBLIC_APP_URL=', process.env.PUBLIC_APP_URL);
  return resolved;
}

function getDiscordDisplayName(user) {
  return user.global_name || user.username || 'Discord user';
}

function getDiscordUsername(user) {
  return user.username || user.global_name || 'Discord user';
}

function normalizeDiscordUsername(user) {
  const base = normalizeUsername(getDiscordUsername(user));
  const safeBase = isValidUsername(base) ? base : `discord_${String(user.id || '').slice(-6)}`;
  return safeBase || `discord_${crypto.randomBytes(3).toString('hex')}`;
}

async function getAvailableDiscordUsername(db, discordUser) {
  const base = normalizeDiscordUsername(discordUser).slice(0, 24) || 'discord';

  for (let i = 0; i < 20; i++) {
    const suffix = i === 0 ? '' : `_${String(discordUser.id || crypto.randomBytes(4).toString('hex')).slice(-(4 + i)).slice(0, 8)}`;
    const candidate = `${base.slice(0, Math.max(1, 24 - suffix.length))}${suffix}`;
    const existing = await db.collection('users').findOne(
      { username: candidate },
      { projection: { _id: 1 }, collation: { locale: 'en', strength: 2 } }
    );
    if (!existing && isValidUsername(candidate)) return candidate;
  }

  return `discord_${crypto.randomBytes(5).toString('hex')}`;
}

function buildDiscordProfile(user) {
  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}`
    : null;

  return {
    id: String(user.id),
    username: user.username || '',
    globalName: user.global_name || '',
    displayName: getDiscordDisplayName(user),
    discriminator: user.discriminator || '',
    avatar,
    linkedAt: new Date(),
  };
}

async function exchangeDiscordCode(req, code) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Discord OAuth is not configured');
  }

  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: getDiscordRedirectUri(req)
    })
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text().catch(() => '');
    throw new Error(`Discord token exchange failed: ${tokenResponse.status} ${detail}`);
  }

  const tokenData = await tokenResponse.json();
  const userResponse = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });

  if (!userResponse.ok) {
    const detail = await userResponse.text().catch(() => '');
    throw new Error(`Discord user fetch failed: ${userResponse.status} ${detail}`);
  }

  return await userResponse.json();
}

function redirectDiscordResult(req, res, params) {
  const url = new URL('/go/', getPublicAppBase(req));
  url.searchParams.set('discordAuth', params.success ? 'success' : 'error');
  if (params.token) url.searchParams.set('token', params.token);
  if (params.mode) url.searchParams.set('mode', params.mode);
  if (params.username) url.searchParams.set('username', params.username);
  if (params.hasDiscord !== undefined) url.searchParams.set('hasDiscord', params.hasDiscord ? '1' : '0');
  if (params.needsUsernameSetup !== undefined) url.searchParams.set('needsUsernameSetup', params.needsUsernameSetup ? '1' : '0');
  if (params.suggestedUsername) url.searchParams.set('suggestedUsername', params.suggestedUsername);
  if (params.error) url.searchParams.set('error', params.error);
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

function getUsernameChangeAvailability(user) {
  const lastChanged = user.usernameChangedAt || user.createdAt || null;
  if (!lastChanged) return { allowed: true, nextChangeAt: null };

  const lastChangedAt = new Date(lastChanged);
  if (Number.isNaN(lastChangedAt.getTime())) return { allowed: true, nextChangeAt: null };

  const nextChangeAt = new Date(lastChangedAt.getTime() + USERNAME_CHANGE_INTERVAL_MS);
  return {
    allowed: nextChangeAt.getTime() <= Date.now(),
    nextChangeAt,
  };
}

async function usernameExists(db, username, excludeUserId = null) {
  const query = { username };
  if (excludeUserId) query._id = { $ne: excludeUserId };
  return !!(await db.collection('users').findOne(
    query,
    { projection: { _id: 1 }, collation: { locale: 'en', strength: 2 } }
  ));
}

async function createPasswordResetToken(db, user, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await db.collection('password_reset_tokens').insertOne({
    userId: user._id,
    username: user.username,
    tokenHash,
    createdAt: new Date(),
    expiresAt,
    usedAt: null,
    requestedIp: getClientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
  });

  return { token, expiresAt };
}

async function sendPasswordResetEmail({ to, username, resetLink }) {
  const from = process.env.RESET_EMAIL_FROM || 'support@ddraw.ca';
  const subject = 'Reset your DDraw password';
  const text = [
    `Hi ${username},`,
    '',
    'Use this link to reset your DDraw password:',
    resetLink,
    '',
    'This link expires in 1 hour. If you did not request it, you can ignore this email.',
    '',
    'DDraw Support'
  ].join('\n');

  if (process.env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend email failed: ${response.status} ${detail}`);
    }
    return true;
  }

  console.warn('[AuthRoutes] RESEND_API_KEY not set; password reset link:', resetLink);
  return false;
}

/**
 * POST /api/auth/login — authenticate with username/password
 * Body: { username, password }
 * Returns: { success, token, username, role } or { success: false, error }
 */
export async function handleAuthLogin(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  const clientIp = getClientIp(req);
  const clientSubnet = getIpSubnet(clientIp);
  const loginKey = `auth:login:${clientIp}`;
  const loginLimit = httpRateLimiter.inspect(loginKey);
  if (loginLimit.blocked) {
    return json(res, 429, { success: false, error: 'Too many login attempts. Please try again later.' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const username = typeof body.username === 'string' ? normalizeUsername(body.username) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const identity = normalizeIdentityPayload(body);
  if (!username || !password) {
    return json(res, 400, { success: false, error: 'Username and password required' });
  }

  try {
    const user = await db.collection('users').findOne(
      { username },
      { collation: { locale: 'en', strength: 2 } }
    );

    if (!user) {
      httpRateLimiter.consume(loginKey, LOGIN_RATE_LIMIT);
      return json(res, 401, { success: false, error: 'Invalid username or password' });
    }

    const valid = user.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
    if (!valid) {
      httpRateLimiter.consume(loginKey, LOGIN_RATE_LIMIT);
      return json(res, 401, { success: false, error: 'Invalid username or password' });
    }

    httpRateLimiter.reset(loginKey);

    // Global ban check — matches the WS login path (room-scoped bans don't apply here,
    // there's no room; MOD+ stay exempt so admins can always recover an account).
    const banCheck = await checkBan(user._id.toString(), clientIp, null);
    if (banCheck && (user.role || Role.USER) < Role.MOD) {
      const expiry = banCheck.expiresAt ? ` until ${banCheck.expiresAt.toISOString()}` : ' permanently';
      return json(res, 403, { success: false, error: `You are banned${expiry}. Reason: ${banCheck.reason || 'No reason given'}` });
    }

    const ipHistory = mergeHistory(user.ipHistory, clientIp);
    const subnetHistory = mergeHistory(user.subnetHistory, clientSubnet);
    const deviceIds = mergeHistory(user.deviceIds, identity.deviceId);
    const fingerprintIds = mergeHistory(user.fingerprintIds, identity.fingerprintId);

    await db.collection('users').updateOne(
      { _id: user._id },
      {
        $set: {
          lastLoginAt: new Date(),
          lastIp: clientIp,
          lastSubnet: clientSubnet || null,
          lastDeviceId: identity.deviceId || null,
          lastFingerprintId: identity.fingerprintId || null,
          lastIdentitySummary: identity.identitySummary,
          ipHistory,
          subnetHistory,
          deviceIds,
          fingerprintIds
        }
      }
    );

    await recordConnectionEvent(db, {
      type: 'http_login',
      source: 'http',
      userId: user._id.toString(),
      username: user.username,
      ip: clientIp,
      subnet: clientSubnet,
      deviceId: identity.deviceId || null,
      fingerprintId: identity.fingerprintId || null,
      identitySummary: identity.identitySummary,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    });

    const token = generateToken({
      userId: user._id.toString(),
      username: user.username,
      role: user.role || 1,
    });

    json(res, 200, {
      success: true,
      token,
      userId: user._id.toString(),
      username: user.username,
      role: user.role || 1,
      likedGalleryIds: Array.isArray(user.likedGalleryIds) ? user.likedGalleryIds : [],
    });
  } catch (err) {
    console.error('[AuthRoutes] Login error:', err);
    json(res, 500, { success: false, error: 'Login failed' });
  }
}

/**
 * Reclaims an admin-reset account: sets a new password on the existing user
 * document (same _id) and clears the reset flag, rather than creating a new
 * account under the same username.
 */
async function completeAccountReclaim(req, res, db, existing, { username, password, email, secretQuestion, secretAnswer, identity, clientIp, clientSubnet }) {
  const passwordHash = await hashPassword(password);
  const secretAnswerHash = secretAnswer ? await hashPassword(secretAnswer.toLowerCase()) : (existing.secretAnswerHash || null);
  const role = existing.role ?? Role.USER;

  await db.collection('users').updateOne(
    { _id: existing._id },
    {
      $set: {
        passwordHash,
        email: email || existing.email || null,
        secretQuestion: secretQuestion || existing.secretQuestion || null,
        secretAnswerHash,
        lastLoginAt: new Date(),
        lastIp: clientIp,
        lastSubnet: clientSubnet || null,
        lastDeviceId: identity.deviceId || null,
        lastFingerprintId: identity.fingerprintId || null,
        lastIdentitySummary: identity.identitySummary,
        ipHistory: mergeHistory(existing.ipHistory, clientIp),
        subnetHistory: mergeHistory(existing.subnetHistory, clientSubnet),
        deviceIds: mergeHistory(existing.deviceIds, identity.deviceId),
        fingerprintIds: mergeHistory(existing.fingerprintIds, identity.fingerprintId),
      },
      $unset: { isReset: '', resetAt: '', resetBy: '' },
    }
  );

  await recordConnectionEvent(db, {
    type: 'http_register_reclaim',
    source: 'http',
    userId: existing._id.toString(),
    username,
    ip: clientIp,
    subnet: clientSubnet,
    deviceId: identity.deviceId || null,
    fingerprintId: identity.fingerprintId || null,
    identitySummary: identity.identitySummary,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
  });

  const token = generateToken({
    userId: existing._id.toString(),
    username,
    role,
  });

  json(res, 200, {
    success: true,
    token,
    userId: existing._id.toString(),
    username,
    role,
    likedGalleryIds: Array.isArray(existing.likedGalleryIds) ? existing.likedGalleryIds : [],
  });
}

/**
 * POST /api/auth/register — create new account
 * Body: { username, password, email?, secretQuestion?, secretAnswer? }
 * Returns: { success, token, username, role } or { success: false, error }
 */
export async function handleAuthRegister(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  const clientIp = getClientIp(req);
  const clientSubnet = getIpSubnet(clientIp);
  if (process.env.DISABLE_RATE_LIMITS !== 'true') {
    const registerLimit = httpRateLimiter.consume(`auth:register:${clientIp}`, REGISTER_RATE_LIMIT);
    if (!registerLimit.allowed) {
      return json(res, 429, { success: false, error: 'Too many registration attempts. Please try again later.' });
    }
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const username = typeof body.username === 'string' ? normalizeUsername(body.username) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const secretQuestion = typeof body.secretQuestion === 'string' ? body.secretQuestion.trim() : '';
  const secretAnswer = typeof body.secretAnswer === 'string' ? body.secretAnswer.trim() : '';
  const identity = normalizeIdentityPayload(body);

  if (!username || !password) {
    return json(res, 400, { success: false, error: 'Username and password required' });
  }

  if (!isValidUsername(username)) {
    return json(res, 400, { success: false, error: getUsernameValidationMessage() });
  }

  if (password.length < 6) {
    return json(res, 400, { success: false, error: 'Password must be at least 6 characters' });
  }

  if (secretQuestion && !secretAnswer) {
    return json(res, 400, { success: false, error: 'Secret answer is required when providing a secret question' });
  }

  try {
    // Check if username exists
    const existing = await db.collection('users').findOne(
      { username },
      { collation: { locale: 'en', strength: 2 } }
    );
    if (existing) {
      // An admin flagged this account for reset (see the admin panel's "Reset
      // Account" action) — let the owner reclaim the same username/_id instead
      // of bouncing them to a "taken" error, so their gallery items, badges,
      // and achievement stats (all keyed off the user's _id) survive.
      if (existing.isReset) {
        return completeAccountReclaim(req, res, db, existing, { username, password, email, secretQuestion, secretAnswer, identity, clientIp, clientSubnet });
      }
      return json(res, 409, { success: false, error: 'Username already taken' });
    }

    const passwordHash = await hashPassword(password);
    const secretAnswerHash = secretAnswer ? await hashPassword(secretAnswer.toLowerCase()) : null;
    const role = Role.USER;

    const doc = {
      username,
      passwordHash,
      email: email || null,
      secretQuestion: secretQuestion || null,
      secretAnswerHash,
      role,
      createdAt: new Date(),
      lastLoginAt: new Date(),
      lastIp: clientIp,
      lastSubnet: clientSubnet || null,
      lastDeviceId: identity.deviceId || null,
      lastFingerprintId: identity.fingerprintId || null,
      lastIdentitySummary: identity.identitySummary,
      ipHistory: clientIp ? [clientIp] : [],
      subnetHistory: clientSubnet ? [clientSubnet] : [],
      deviceIds: identity.deviceId ? [identity.deviceId] : [],
      fingerprintIds: identity.fingerprintId ? [identity.fingerprintId] : [],
      likedGalleryIds: []
    };

    const result = await db.collection('users').insertOne(doc);

    await recordConnectionEvent(db, {
      type: 'http_register',
      source: 'http',
      userId: result.insertedId.toString(),
      username,
      ip: clientIp,
      subnet: clientSubnet,
      deviceId: identity.deviceId || null,
      fingerprintId: identity.fingerprintId || null,
      identitySummary: identity.identitySummary,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    });

    const token = generateToken({
      userId: result.insertedId.toString(),
      username,
      role,
    });

    json(res, 201, {
      success: true,
      token,
      userId: result.insertedId.toString(),
      username,
      role,
      likedGalleryIds: [],
    });
  } catch (err) {
    console.error('[AuthRoutes] Register error:', err);
    if (err.code === 11000) {
      return json(res, 409, { success: false, error: 'Username already taken' });
    }
    json(res, 500, { success: false, error: 'Registration failed' });
  }
}

/**
 * GET /api/auth/me — validate token and return user info
 * Header: Authorization: Bearer <token>
 * Returns: { success, username, role, userId } or { success: false, error }
 */
export async function handleAuthMe(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(res, 401, { success: false, error: 'No token provided' });
  }

  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  const user = await getUserFromToken(getBearerToken(req), {
    projection: { username: 1, role: 1, likedGalleryIds: 1 }
  });
  if (!user) {
    return json(res, 401, { success: false, error: 'Invalid or expired token' });
  }

  json(res, 200, {
    success: true,
    userId: user._id.toString(),
    username: user.username,
    role: user.role ?? Role.USER,
    likedGalleryIds: Array.isArray(user.likedGalleryIds) ? user.likedGalleryIds : [],
  });
}

/**
 * POST /api/auth/username — update the current user's DDraw username.
 * Header: Authorization: Bearer <token>
 * Body: { username }
 */
export async function handleAuthUsernameUpdate(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const user = await getUserFromToken(getBearerToken(req), { projection: { _id: 1, username: 1, role: 1, discord: 1, createdAt: 1, usernameChangedAt: 1 } });
  if (!user) return json(res, 401, { success: false, error: 'Unauthorized' });

  const username = typeof body.username === 'string' ? normalizeUsername(body.username) : '';
  if (!isValidUsername(username)) {
    return json(res, 400, { success: false, error: getUsernameValidationMessage() });
  }

  try {
    const isInitialDiscordUsernameSetup = !!user.discord?.id && !user.discord?.usernameSetupCompleted;
    if (username.toLowerCase() !== user.username.toLowerCase() && !isInitialDiscordUsernameSetup) {
      const availability = getUsernameChangeAvailability(user);
      if (!availability.allowed) {
        return json(res, 429, {
          success: false,
          error: `You can only change your username once every 3 months. Try again on ${availability.nextChangeAt.toLocaleDateString('en-CA')}.`,
          nextUsernameChangeAt: availability.nextChangeAt.toISOString(),
        });
      }
    }

    const taken = await usernameExists(db, username, user._id);
    if (taken) {
      return json(res, 409, { success: false, error: 'Username already taken' });
    }

    const oldUsername = user.username;
    await db.collection('users').updateOne(
      { _id: user._id },
      {
        $set: {
          username,
          updatedAt: new Date(),
          usernameChangedAt: new Date(),
          ...(user.discord?.id ? { 'discord.usernameSetupCompleted': true } : {})
        }
      }
    );

    if (username !== oldUsername) {
      const userId = user._id.toString();
      await Promise.all([
        db.collection('gallery').updateMany({ authorId: userId }, { $set: { author: username } }),
        db.collection('comments').updateMany({ authorId: userId }, { $set: { author: username } }),
        db.collection('gallery_likes').updateMany({ userId }, { $set: { username } }),
      ]);
    }

    const token = generateToken({
      userId: user._id.toString(),
      username,
      role: user.role || Role.USER,
    });

    json(res, 200, {
      success: true,
      token,
      username,
      role: user.role || Role.USER,
      hasDiscord: !!user.discord?.id,
      needsUsernameSetup: false,
      nextUsernameChangeAt: new Date(Date.now() + USERNAME_CHANGE_INTERVAL_MS).toISOString(),
    });
  } catch (err) {
    console.error('[AuthRoutes] Username update error:', err);
    if (err.code === 11000) {
      return json(res, 409, { success: false, error: 'Username already taken' });
    }
    json(res, 500, { success: false, error: 'Username update failed' });
  }
}

/**
 * POST /api/auth/discord/link-ddraw
 * Links the current Discord-authenticated user to an existing DDraw username/password account.
 * Header: Authorization: Bearer <token>
 * Body: { username, password }
 */
export async function handleDiscordDdrawAccountLink(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const currentUser = await getUserFromToken(getBearerToken(req), {
    projection: { _id: 1, username: 1, role: 1, discord: 1, passwordHash: 1 }
  });
  if (!currentUser) return json(res, 401, { success: false, error: 'Unauthorized' });
  if (!currentUser.discord?.id) {
    return json(res, 400, { success: false, error: 'Log in with Discord before linking a DDraw account' });
  }

  const username = typeof body.username === 'string' ? normalizeUsername(body.username) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) {
    return json(res, 400, { success: false, error: 'Username and password required' });
  }

  try {
    const targetUser = await db.collection('users').findOne(
      { username },
      { collation: { locale: 'en', strength: 2 } }
    );
    if (!targetUser?.passwordHash || !(await verifyPassword(password, targetUser.passwordHash))) {
      return json(res, 401, { success: false, error: 'Invalid username or password' });
    }

    if (targetUser.discord?.id && targetUser.discord.id !== currentUser.discord.id) {
      return json(res, 409, { success: false, error: 'That DDraw account is already linked to a different Discord account' });
    }

    const discord = {
      ...currentUser.discord,
      usernameSetupCompleted: true,
      linkedAt: currentUser.discord.linkedAt || new Date(),
    };

    if (String(targetUser._id) !== String(currentUser._id)) {
      await db.collection('users').updateOne(
        { _id: currentUser._id, 'discord.id': currentUser.discord.id },
        { $unset: { discord: '' }, $set: { updatedAt: new Date() } }
      );
    }

    await db.collection('users').updateOne(
      { _id: targetUser._id },
      {
        $set: {
          discord,
          updatedAt: new Date(),
          lastLoginAt: new Date(),
          lastIp: getClientIp(req),
        }
      }
    );

    const token = generateToken({
      userId: targetUser._id.toString(),
      username: targetUser.username,
      role: targetUser.role || Role.USER,
    });

    json(res, 200, {
      success: true,
      token,
      userId: targetUser._id.toString(),
      username: targetUser.username,
      role: targetUser.role || Role.USER,
      hasDiscord: true,
      needsUsernameSetup: false,
    });
  } catch (err) {
    console.error('[AuthRoutes] Discord DDraw account link error:', err);
    json(res, 500, { success: false, error: 'Account link failed' });
  }
}

/**
 * GET /api/discord/config
 * Returns public Discord integration settings for the client.
 */
export async function handleDiscordConfig(req, res) {
  json(res, 200, {
    inviteUrl: process.env.DISCORD_INVITE_URL || '',
    oauthEnabled: !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
  });
}

/**
 * POST /api/auth/discord/start
 * Body: { mode?: "login"|"link" }
 * Header for link mode: Authorization: Bearer <token>
 */
export async function handleDiscordOAuthStart(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return json(res, 503, { success: false, error: 'Discord login is not configured' });
  }

  let body = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const mode = body.mode === 'link' ? 'link' : 'login';
  let user = null;
  if (mode === 'link') {
    user = await getUserFromToken(getBearerToken(req), { projection: { username: 1, role: 1, discord: 1 } });
    if (!user) return json(res, 401, { success: false, error: 'Log in before linking Discord' });
    if (user.discord?.id) return json(res, 409, { success: false, error: 'This DDraw account is already linked to Discord' });
  }

  const state = crypto.randomBytes(32).toString('base64url');
  await db.collection('discord_oauth_states').insertOne({
    stateHash: hashOAuthState(state),
    mode,
    userId: user?._id || null,
    username: user?.username || null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + DISCORD_OAUTH_STATE_TTL_MS),
    requestedIp: getClientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
  });

  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID);
  url.searchParams.set('scope', DISCORD_OAUTH_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', getDiscordRedirectUri(req));
  url.searchParams.set('prompt', mode === 'link' ? 'consent' : 'none');

  json(res, 200, { success: true, url: url.toString() });
}

/**
 * GET /api/auth/discord/callback
 * Handles the Discord OAuth authorization code callback.
 */
export async function handleDiscordOAuthCallback(req, res) {
  const db = getDB();
  if (!db) return redirectDiscordResult(req, res, { success: false, error: 'Database not available' });

  const urlObj = new URL(req.url, getPublicAppBase(req));
  const code = urlObj.searchParams.get('code') || '';
  const state = urlObj.searchParams.get('state') || '';
  if (!code || !state) {
    return redirectDiscordResult(req, res, { success: false, error: 'Missing Discord authorization data' });
  }

  try {
    const stateHash = hashOAuthState(state);
    const stateDoc = await db.collection('discord_oauth_states').findOneAndDelete({
      stateHash,
      expiresAt: { $gt: new Date() },
    });
    if (!stateDoc) {
      return redirectDiscordResult(req, res, { success: false, error: 'Discord login expired. Please try again.' });
    }

    const discordUser = await exchangeDiscordCode(req, code);
    const discord = buildDiscordProfile(discordUser);
    const existingLinkedUser = await db.collection('users').findOne(
      { 'discord.id': discord.id },
      { projection: { username: 1, role: 1, passwordHash: 1, discord: 1 } }
    );

    if (stateDoc.mode === 'link') {
      if (existingLinkedUser && String(existingLinkedUser._id) !== String(stateDoc.userId)) {
        return redirectDiscordResult(req, res, {
          success: false,
          mode: 'link',
          error: 'Discord account already in use'
        });
      }

      const result = await db.collection('users').findOneAndUpdate(
        { _id: new ObjectId(stateDoc.userId) },
        { $set: { discord, updatedAt: new Date() } },
        { returnDocument: 'after', projection: { username: 1, role: 1 } }
      );

      if (!result) {
        return redirectDiscordResult(req, res, { success: false, mode: 'link', error: 'DDraw account not found' });
      }

      const token = generateToken({
        userId: result._id.toString(),
        username: result.username,
        role: result.role || Role.USER,
      });
      return redirectDiscordResult(req, res, {
        success: true,
        mode: 'link',
        token,
        username: result.username,
        hasDiscord: true,
      });
    }

    let user = existingLinkedUser;
    let needsUsernameSetup = false;
    if (!user) {
      const username = await getAvailableDiscordUsername(db, discordUser);
      needsUsernameSetup = true;
      const doc = {
        username,
        passwordHash: null,
        email: null,
        role: Role.USER,
        discord: {
          ...discord,
          usernameSetupCompleted: false,
        },
        createdAt: new Date(),
        lastLoginAt: new Date(),
        lastIp: getClientIp(req),
        likedGalleryIds: [],
      };
      const insert = await db.collection('users').insertOne(doc);
      user = { _id: insert.insertedId, username, role: Role.USER };
    } else {
      await db.collection('users').updateOne(
        { _id: user._id },
        {
          $set: {
            discord: {
              ...discord,
              usernameSetupCompleted: user.discord?.usernameSetupCompleted ?? !!user.passwordHash,
            },
            lastLoginAt: new Date(),
            lastIp: getClientIp(req)
          }
        }
      );
      needsUsernameSetup = !user.passwordHash && !user.discord?.usernameSetupCompleted;
    }

    const token = generateToken({
      userId: user._id.toString(),
      username: user.username,
      role: user.role || Role.USER,
    });

    return redirectDiscordResult(req, res, {
      success: true,
      mode: 'login',
      token,
      username: user.username,
      hasDiscord: true,
      needsUsernameSetup,
      suggestedUsername: normalizeUsername(getDiscordUsername(discordUser)),
    });
  } catch (err) {
    console.error('[AuthRoutes] Discord OAuth error:', err);
    return redirectDiscordResult(req, res, { success: false, error: 'Discord login failed' });
  }
}

/**
 * POST /api/auth/password-reset/request
 * Body: { identifier, secretAnswer? }
 * Creates a reset link by email, or by secret answer when the username path is used.
 */
export async function handlePasswordResetRequest(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  const clientIp = getClientIp(req);
  const limit = httpRateLimiter.consume(`auth:reset-request:${clientIp}`, RESET_REQUEST_RATE_LIMIT);
  if (!limit.allowed) {
    return json(res, 429, { success: false, error: 'Too many reset attempts. Please try again later.' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
  if (!identifier || !identifier.includes('@')) {
    return json(res, 400, { success: false, error: 'Email address required' });
  }

  try {
    const user = await db.collection('users').findOne(
      { email: normalizeEmail(identifier) },
      {
        collation: { locale: 'en', strength: 2 },
        projection: { username: 1, email: 1 }
      }
    );

    const genericMessage = 'If that account can be reset, a reset link will be sent.';
    if (!user) {
      return json(res, 200, { success: true, message: genericMessage });
    }

    const { token } = await createPasswordResetToken(db, user, req);
    const resetLink = buildResetLink(req, token);
    const emailSent = await sendPasswordResetEmail({
      to: user.email,
      username: user.username,
      resetLink,
    });

    return json(res, 200, {
      success: true,
      message: emailSent
        ? 'Password reset link sent. Check your email.'
        : 'Email sending is not configured, so the reset link was written to the server log.',
      emailSent,
    });
  } catch (err) {
    console.error('[AuthRoutes] Password reset request error:', err);
    json(res, 500, { success: false, error: 'Password reset request failed' });
  }
}

/**
 * POST /api/auth/password-reset/complete
 * Body: { token, password }
 */
export async function handlePasswordResetComplete(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  const clientIp = getClientIp(req);
  const limit = httpRateLimiter.consume(`auth:reset-complete:${clientIp}`, RESET_COMPLETE_RATE_LIMIT);
  if (!limit.allowed) {
    return json(res, 429, { success: false, error: 'Too many reset attempts. Please try again later.' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!token || !password) {
    return json(res, 400, { success: false, error: 'Reset token and new password required' });
  }

  if (password.length < 6) {
    return json(res, 400, { success: false, error: 'Password must be at least 6 characters' });
  }

  try {
    const tokenHash = hashResetToken(token);
    const resetDoc = await db.collection('password_reset_tokens').findOne({
      tokenHash,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    });

    if (!resetDoc) {
      return json(res, 400, { success: false, error: 'Reset link is invalid or expired' });
    }

    const passwordHash = await hashPassword(password);
    await db.collection('users').updateOne(
      { _id: resetDoc.userId },
      { $set: { passwordHash, passwordChangedAt: new Date() } }
    );
    await db.collection('password_reset_tokens').updateOne(
      { _id: resetDoc._id },
      { $set: { usedAt: new Date(), completedIp: clientIp } }
    );

    json(res, 200, { success: true, message: 'Password updated. You can log in with the new password.' });
  } catch (err) {
    console.error('[AuthRoutes] Password reset complete error:', err);
    json(res, 500, { success: false, error: 'Password reset failed' });
  }
}

const EMAIL_VERIFICATION_TTL_MS = 15 * 60 * 1000;

/**
 * POST /api/auth/email/set — request email verification code
 * Header: Authorization: Bearer <token>
 * Body: { email }
 * Returns: { success, message } or { success: false, error }
 */
export async function handleEmailSet(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  if (!email || !email.includes('@')) {
    return json(res, 400, { success: false, error: 'Valid email required' });
  }

  try {
    const user = await getUserFromToken(getBearerToken(req), { projection: { _id: 1 } });
    if (!user) {
      return json(res, 401, { success: false, error: 'Unauthorized' });
    }

    const existingEmail = await db.collection('users').findOne(
      { email: normalizeEmail(email), _id: { $ne: user._id } }
    );
    if (existingEmail) {
      return json(res, 400, { success: false, error: 'Email already in use' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const tokenHash = hashResetToken(code);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

    await db.collection('email_verification_tokens').insertOne({
      userId: user._id,
      email,
      tokenHash,
      createdAt: new Date(),
      expiresAt,
      usedAt: null,
      requestedIp: getClientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    });

    const subject = 'Your DDraw verification code';
    const text = [
      `Your verification code is: ${code}`,
      '',
      'This code expires in 15 minutes. If you did not request it, you can ignore this email.',
    ].join('\n');

    if (process.env.RESEND_API_KEY) {
      const from = process.env.RESET_EMAIL_FROM || 'support@ddraw.ca';
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: email, subject, text }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Resend email failed: ${response.status} ${detail}`);
      }
    } else {
      console.warn('[AuthRoutes] RESEND_API_KEY not set; email verification code:', code);
    }

    json(res, 200, { success: true, message: 'Verification code sent to your email.' });
  } catch (err) {
    console.error('[AuthRoutes] Email set error:', err);
    json(res, 500, { success: false, error: 'Email verification failed' });
  }
}

/**
 * POST /api/auth/email/verify — verify email with code
 * Header: Authorization: Bearer <token>
 * Body: { code }
 * Returns: { success } or { success: false, error }
 */
export async function handleEmailVerify(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { success: false, error: 'Request body too large' });
    }
    return json(res, 400, { success: false, error: 'Invalid request body' });
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code || code.length !== 6 || !/^\d+$/.test(code)) {
    return json(res, 400, { success: false, error: 'Invalid code format' });
  }

  try {
    const user = await getUserFromToken(getBearerToken(req), { projection: { _id: 1 } });
    if (!user) {
      return json(res, 401, { success: false, error: 'Unauthorized' });
    }

    const tokenHash = hashResetToken(code);
    const tokenDoc = await db.collection('email_verification_tokens').findOne({
      userId: user._id,
      tokenHash,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    });

    if (!tokenDoc) {
      return json(res, 400, { success: false, error: 'Invalid or expired code' });
    }

    await db.collection('email_verification_tokens').updateOne(
      { _id: tokenDoc._id },
      { $set: { usedAt: new Date() } }
    );

    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { email: tokenDoc.email, emailVerified: true } }
    );

    json(res, 200, { success: true });
  } catch (err) {
    console.error('[AuthRoutes] Email verify error:', err);
    json(res, 500, { success: false, error: 'Email verification failed' });
  }
}

/**
 * POST /api/auth/email/decline — mark that user declined email prompt
 * Header: Authorization: Bearer <token>
 * Returns: { success } or { success: false, error }
 */
export async function handleEmailDecline(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { success: false, error: 'Database not available' });

  try {
    const user = await getUserFromToken(getBearerToken(req), { projection: { _id: 1 } });
    if (!user) {
      return json(res, 401, { success: false, error: 'Unauthorized' });
    }

    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { emailPromptDeclined: true } }
    );

    json(res, 200, { success: true });
  } catch (err) {
    console.error('[AuthRoutes] Email decline error:', err);
    json(res, 500, { success: false, error: 'Failed to save preference' });
  }
}
