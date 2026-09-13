/** @fileoverview Gallery API handlers — upload to R2, store metadata in MongoDB. */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { getDB } from './db.js';
import { getBearerToken, getRequestUser, getUserFromToken } from './authUser.js';
import { INLINE_IMAGE_MIME_TYPES, validateDataUrlImage } from './imageValidation.js';
import { getClientIp, httpRateLimiter } from './security.js';
import { corsHeaders, writeJson, readRequestBody } from './httpUtils.js';
import { ANONYMOUS_AUTHOR } from '../shared/identity.js';

// Lazy-load sharp to avoid startup issues if not installed
let sharp = null;
async function getSharp() {
  if (sharp === null) {
    try {
      sharp = (await import('sharp')).default;
    } catch {
      sharp = false; // Mark as unavailable
    }
  }
  return sharp || null;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_GALLERY_IMAGE_WIDTH = 8192;
const MAX_GALLERY_IMAGE_HEIGHT = 8192;
const MAX_GALLERY_IMAGE_PIXELS = 33_554_432;
const THUMB_MAX_DIM = 400;
const JSON_BODY_LIMIT = MAX_IMAGE_BYTES + 65536;
const GALLERY_UPLOAD_LIMIT = { max: 12, windowMs: 60 * 60 * 1000, blockMs: 15 * 60 * 1000 };
// Guests have no account to ban, so their quota is the only lever: keep it well
// under the signed-in one, and on the same key so an account can't be used to
// top up a guest burst from the same address.
const GALLERY_GUEST_UPLOAD_LIMIT = { max: 3, windowMs: 60 * 60 * 1000, blockMs: 60 * 60 * 1000 };
const GALLERY_COMMENT_LIMIT = { max: 20, windowMs: 5 * 60 * 1000, blockMs: 10 * 60 * 1000 };
const GALLERY_LIKE_LIMIT = { max: 240, windowMs: 60 * 1000, blockMs: 60 * 1000 };
const GALLERY_FAVORITE_LIMIT = { max: 60, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };

/**
 * Build a gallery thumbnail, or null when one isn't worth storing.
 *
 * Two ways a "thumbnail" ends up costing more than it saves:
 *  - The image is already thumbnail-sized, so the resize is a pure re-encode.
 *  - The downscale is marginal (e.g. 447px -> 400px) and resampling flat-colour
 *    art invents interpolated colours that lossless PNG can no longer compress,
 *    outweighing the handful of pixels removed.
 * Both are guarded here, and anything that still lands >= the original is dropped.
 */
async function buildThumbnail(sharpLib, source, mimeType) {
  let meta;
  try {
    meta = await sharpLib(source).metadata();
  } catch {
    return null;
  }
  if (!meta.width || !meta.height) return null;
  if (meta.width <= THUMB_MAX_DIM && meta.height <= THUMB_MAX_DIM) return null;

  const resized = () => sharpLib(source)
    .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: 'inside', withoutEnlargement: true });

  let thumb;
  try {
    if (mimeType === 'image/jpeg') {
      thumb = await resized().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    } else if (mimeType === 'image/webp') {
      thumb = await resized().webp({ quality: 82, alphaQuality: 90 }).toBuffer();
    } else {
      // Drawings shrink dramatically as palette PNGs; photographic uploads
      // compress better in full colour. Encode both and keep the smaller.
      const [fullColour, palette] = await Promise.all([
        resized().png({ compressionLevel: 9 }).toBuffer(),
        resized().png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer(),
      ]);
      thumb = palette.length < fullColour.length ? palette : fullColour;
    }
  } catch (err) {
    console.warn('[Gallery] Thumbnail generation failed:', err.message);
    return null;
  }

  return thumb.length < source.length ? thumb : null;
}

/** Verify that the buffer's magic bytes match the declared MIME type. */
function verifyMagicBytes(buffer, mimeType) {
  if (buffer.length < 4) return false;

  // PNG: 89 50 4E 47
  if (mimeType === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  }
  // JPEG: FF D8 FF
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  }
  // GIF: 47 49 46 38
  if (mimeType === 'image/gif') {
    return buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
  }
  // WebP: RIFF....WEBP
  if (mimeType === 'image/webp') {
    return buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
  }
  // Unknown MIME — reject
  return false;
}

const r2 = process.env.R2_ENDPOINT
  ? new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      // Path-style addressing for local S3 mocks (MinIO). Cloudflare R2 uses
      // virtual-hosted style, so this stays false in production.
      forcePathStyle: process.env.R2_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      },
    })
  : null;

const BUCKET = process.env.R2_BUCKET_NAME || 'gallery';
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://gallery.ddraw.ca').replace(/\/$/, '');

// Time-lapse clips live in their own bucket so video storage and lifecycle can
// be tuned separately from the stills. Follows the R2_SNAPSHOTS_* convention:
// the endpoint is shared, and bucket/credentials/public host fall back to the
// gallery values so an unconfigured deployment keeps writing clips alongside
// the images exactly as before.
const TIMELAPSE_PUBLIC_URL = (process.env.R2_TIMELAPSE_PUBLIC_URL || PUBLIC_URL).replace(/\/$/, '');

// A clip's public URL is stored absolutely on the gallery doc, and an R2 custom
// domain maps 1:1 to a bucket. Writing to a different bucket while still
// handing out the gallery host would 404 every clip, so that combination is
// refused: keep using the gallery bucket until the new one has its own host.
const TIMELAPSE_BUCKET = (() => {
  const configured = process.env.R2_TIMELAPSE_BUCKET;
  if (!configured || configured === BUCKET) return BUCKET;
  if (TIMELAPSE_PUBLIC_URL === PUBLIC_URL) {
    console.warn(
      `[Gallery] R2_TIMELAPSE_BUCKET=${configured} is set but R2_TIMELAPSE_PUBLIC_URL is not — `
      + `clips written there would not be reachable at ${PUBLIC_URL}. Falling back to ${BUCKET}.`
    );
    return BUCKET;
  }
  return configured;
})();
const TIMELAPSE_ACCESS_KEY_ID =
  process.env.R2_TIMELAPSE_ACCESS_KEY_ID ||
  process.env.R2_ACCESS_KEY_ID ||
  '';
const TIMELAPSE_SECRET_ACCESS_KEY =
  process.env.R2_TIMELAPSE_SECRET_ACCESS_KEY ||
  process.env.R2_TIMELAPSE_SECRET_KEY ||
  process.env.R2_SECRET_ACCESS_KEY ||
  '';

// R2 API tokens are usually scoped to one bucket, so a distinct key means a
// distinct client; an identical one just reuses the gallery connection pool.
const r2Timelapse = !process.env.R2_ENDPOINT
  ? null
  : TIMELAPSE_ACCESS_KEY_ID === (process.env.R2_ACCESS_KEY_ID || '')
      ? r2
      : new S3Client({
          region: 'auto',
          endpoint: process.env.R2_ENDPOINT,
          forcePathStyle: process.env.R2_FORCE_PATH_STYLE === 'true',
          credentials: {
            accessKeyId: TIMELAPSE_ACCESS_KEY_ID,
            secretAccessKey: TIMELAPSE_SECRET_ACCESS_KEY,
          },
        });

/**
 * Route a stored clip URL back to the client and bucket that actually holds it.
 * Clips written before the time-lapse bucket existed still live in the gallery
 * bucket, so deletes have to follow the URL rather than current config.
 * @param {string} animatedUrl
 * @returns {{client: S3Client|null, bucket: string}}
 */
function animationStoreFor(animatedUrl) {
  if (TIMELAPSE_PUBLIC_URL !== PUBLIC_URL && animatedUrl.startsWith(`${TIMELAPSE_PUBLIC_URL}/`)) {
    return { client: r2Timelapse, bucket: TIMELAPSE_BUCKET };
  }
  return { client: r2, bucket: BUCKET };
}

const CORS_HEADERS = corsHeaders('GET, POST, PATCH, DELETE, OPTIONS');

const RESERVED_TAGS = ['nsfw'];
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 24;

// Callback for broadcasting floating art updates via WebSocket
let broadcastFloatingArtUpdate = null;
let galleryDiscordPoster = null;

/**
 * Set the callback for broadcasting floating art updates to WebSocket clients
 * @param {Function} callback - Function to call with (roomTags, galleryItem)
 */
export function setFloatingArtBroadcaster(callback) {
  broadcastFloatingArtUpdate = callback;
}

// Floating art wall hooks: { likes(id, likesCount), added(tags, wallItem), removed(id) }
let galleryWallListener = null;

export function setGalleryWallListener(listener) {
  galleryWallListener = listener;
}

function notifyWall(event, ...args) {
  try {
    galleryWallListener?.[event]?.(...args);
  } catch (err) {
    console.error(`[Gallery] Wall listener "${event}" failed:`, err);
  }
}

/**
 * Set the callback for posting opt-in gallery uploads to Discord.
 * @param {Function} callback - Function to call with the saved gallery item
 */
export function setGalleryDiscordPoster(callback) {
  galleryDiscordPoster = callback;
}

function json(res, status, body) {
  writeJson(res, status, body, CORS_HEADERS);
}

async function requireAuthenticatedUser(req, res, options = {}) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    json(res, 401, { error: 'Authentication required' });
    return null;
  }

  const user = await getRequestUser(req, options);
  if (!user) {
    json(res, 401, { error: 'Invalid or expired token' });
    return null;
  }

  return user;
}

function readBody(req, maxBytes = JSON_BODY_LIMIT) {
  return readRequestBody(req, maxBytes);
}

function normalizeTags(input) {
  const source = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [];

  const seen = new Set();
  const tags = [];

  for (const rawTag of source) {
    const tag = String(rawTag || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!tag || tag.length > MAX_TAG_LENGTH || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }

  return tags;
}

/**
 * Mongo filter for "items publicly credited to this username". Items uploaded
 * with the username tag off still store their real author, so they must never
 * match — see toClientGalleryItem(), which shows them as ANONYMOUS_AUTHOR.
 * @param {string} username
 */
function authorQuery(username) {
  return { author: username, tagUsername: { $ne: false } };
}

/**
 * @param {object} item - raw gallery document
 * @param {Set<string>|null} [likedGalleryIds]
 * @param {string|null} [viewerId] - requesting user's id, for the `isAuthor`
 *   flag. An anonymised item hides its real author, so the client can no longer
 *   recognise the owner by name — it needs this to keep showing them the
 *   edit/delete controls the server would in fact allow.
 */
function toClientGalleryItem(item, likedGalleryIds = null, viewerId = null) {
  const id = item._id.toString();
  const tagUsername = item.tagUsername !== false;
  return {
    isAuthor: !!viewerId && String(item.authorId) === String(viewerId),
    id,
    url: item.url,
    thumbUrl: item.thumbUrl || item.url,
    author: tagUsername ? item.author : ANONYMOUS_AUTHOR,
    // A registered, credited author: the name opens their profile
    authorHasProfile: tagUsername && !!item.authorId && !!item.author,
    tagUsername,
    title: item.title || '',
    description: item.description || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    likesCount: item.likesCount || 0,
    liked: likedGalleryIds ? likedGalleryIds.has(id) : false,
    likedByCurrentUser: likedGalleryIds ? likedGalleryIds.has(id) : false,
    views: item.views || 0,
    animatedUrl: item.animatedUrl || null,
    createdAt: item.createdAt,
  };
}

/**
 * Resolves the (optional) signed-in viewer for a public listing: their id, and
 * which of `galleryIds` they have liked.
 * @returns {Promise<{ id: string|null, likedIds: Set<string> }>}
 */
async function getRequestViewer(req, galleryIds = []) {
  const token = getBearerToken(req);
  if (!token) return { id: null, likedIds: new Set() };

  const user = await getUserFromToken(token, { projection: { likedGalleryIds: 1 } });
  if (!user) return { id: null, likedIds: new Set() };

  const requested = new Set(galleryIds.map(String));
  const likedIds = Array.isArray(user.likedGalleryIds)
    ? new Set(user.likedGalleryIds.map(String).filter(id => requested.has(id)))
    : new Set();
  return { id: user._id.toString(), likedIds };
}

async function recordGalleryLike(db, { galleryId, userId, username }) {
  try {
    await db.collection('gallery_likes').updateOne({
      galleryId,
      userId,
    }, {
      $setOnInsert: {
        galleryId,
        userId,
        username,
        createdAt: new Date(),
      }
    }, { upsert: true });
  } catch (err) {
    if (err?.code === 11000) {
      console.warn('[Gallery] gallery_likes duplicate during like record; continuing with user like state:', err.keyValue || err.message);
      return;
    }
    throw err;
  }
}

/**
 * GET /api/gallery — list gallery items.
 * Query params:
 *   - page (default 1)
 *   - limit (default 24, max 50)
 *   - sort: newest (default), active, top, views
 *   - period: week, month, year, all (top sort only; default all)
 *   - author: filter by username
 *   - tag: filter by tag
 */
export async function handleGalleryList(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const urlObj = new URL(req.url, 'http://localhost');
  const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '24')));
  const skip = (page - 1) * limit;

  // Sorting
  const sortParam = urlObj.searchParams.get('sort') || 'newest';
  const sortOptions = {
    newest: { createdAt: -1 },
    top: { likesCount: -1, createdAt: -1 },
    views: { views: -1, createdAt: -1 },
  };
  const sort = sortOptions[sortParam] || sortOptions.newest;
  const periodParam = urlObj.searchParams.get('period') || 'all';
  const topPeriodMs = {
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };

  // Author filter
  const author = urlObj.searchParams.get('author');
  const tag = normalizeTags(urlObj.searchParams.get('tag')).at(0) || null;
  const query = {};
  // An anonymised item keeps its real author in the DB (so the uploader can
  // still manage it), so an author filter has to exclude them or the upload
  // shows up under the very name the user chose to hide.
  if (author) Object.assign(query, authorQuery(author));
  if (tag) query.tags = tag;
  if (sortParam === 'top' && topPeriodMs[periodParam]) {
    query.createdAt = { $gte: new Date(Date.now() - topPeriodMs[periodParam]) };
  }

  try {
    const isActiveSort = sortParam === 'active';
    const itemsPromise = isActiveSort
      ? db.collection('gallery').aggregate([
        { $match: query },
        {
          $lookup: {
            from: 'comments',
            let: { galleryId: { $toString: '$_id' } },
            pipeline: [
              { $match: { $expr: { $eq: ['$galleryId', '$$galleryId'] } } },
              { $sort: { createdAt: -1 } },
              { $limit: 1 },
              { $project: { _id: 0, createdAt: 1 } }
            ],
            as: 'latestComment'
          }
        },
        {
          $addFields: {
            activeAt: {
              $ifNull: [{ $arrayElemAt: ['$latestComment.createdAt', 0] }, '$createdAt']
            }
          }
        },
        { $sort: { activeAt: -1, createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: { latestComment: 0, activeAt: 0 } }
      ]).toArray()
      : db.collection('gallery').find(query).sort(sort).skip(skip).limit(limit).toArray();

    const [items, total] = await Promise.all([
      itemsPromise,
      db.collection('gallery').countDocuments(query),
    ]);

    const viewer = await getRequestViewer(req, items.map(item => item._id.toString()));

    json(res, 200, {
      items: items.map(item => toClientGalleryItem(item, viewer.likedIds, viewer.id)),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[Gallery] List error:', err);
    json(res, 500, { error: 'Failed to fetch gallery' });
  }
}

/**
 * POST /api/gallery/upload — upload canvas to R2 and save metadata.
 * Authorization: Bearer <token> is optional: without it the upload is stored as
 * a guest upload (no author, no owner), on a tighter per-IP quota. A token that
 * is present but invalid is still an error — that means a broken session, not a
 * guest, and silently stripping someone's byline would be worse than a 401.
 * Body: { imageData: "data:image/png;base64,...", title?: string, tags?: string[]|string }
 */
export async function handleGalleryUpload(req, res) {
  const clientIp = getClientIp(req);
  const isGuestUpload = !getBearerToken(req);
  const uploadLimit = httpRateLimiter.consume(
    `gallery:upload:${clientIp}`,
    isGuestUpload ? GALLERY_GUEST_UPLOAD_LIMIT : GALLERY_UPLOAD_LIMIT
  );
  if (!uploadLimit.allowed) {
    return json(res, 429, { error: 'Too many uploads. Please try again later.' });
  }

  let authUser = null;
  if (!isGuestUpload) {
    authUser = await requireAuthenticatedUser(req, res, { projection: { username: 1 } });
    if (!authUser) return;
  }

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!r2) return json(res, 503, { error: 'Storage not configured — set R2_ENDPOINT env var' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { error: 'Request body too large' });
    }
    return json(res, 400, { error: 'Invalid request body' });
  }

  const { imageData, title, description, tags, tagUsername } = body;
  // A guest has no username to credit, so the item is anonymous by definition.
  const tagUsernameFlag = !!authUser && tagUsername !== false;
  if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image/')) {
    return json(res, 400, { error: 'Missing or invalid imageData' });
  }

  const normalizedTags = normalizeTags(tags);

  const imageValidation = await validateDataUrlImage(imageData, {
    maxBytes: MAX_IMAGE_BYTES,
    maxWidth: MAX_GALLERY_IMAGE_WIDTH,
    maxHeight: MAX_GALLERY_IMAGE_HEIGHT,
    maxPixels: MAX_GALLERY_IMAGE_PIXELS,
    allowedMimeTypes: INLINE_IMAGE_MIME_TYPES,
    maxDataUrlLength: Math.ceil(MAX_IMAGE_BYTES * 1.5) + 1024
  });
  if (!imageValidation.ok) {
    return json(res, 400, { error: imageValidation.error || 'Invalid image upload' });
  }

  const { buffer, mimeType } = imageValidation;

  // Verify magic bytes match claimed MIME type
  if (!verifyMagicBytes(buffer, mimeType)) {
    return json(res, 400, { error: 'Image data does not match declared format' });
  }

  // Validate dimensions and strip EXIF metadata using sharp
  const sharpLib = await getSharp();
  if (sharpLib) {
    try {
      const metadata = await sharpLib(buffer).metadata();
      const MAX_MEGAPIXELS = 25_000_000;
      if (metadata.width && metadata.height && metadata.width * metadata.height > MAX_MEGAPIXELS) {
        return json(res, 400, { error: `Image dimensions too large (max ${MAX_MEGAPIXELS / 1_000_000}MP)` });
      }
      if (metadata.width > 20000 || metadata.height > 20000) {
        return json(res, 400, { error: 'Image dimensions too large (max 20000px per side)' });
      }
    } catch {
      return json(res, 400, { error: 'Unable to read image — file may be corrupt' });
    }
  }

  // Compute image hash for duplicate detection
  const imageHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Check for duplicate
  try {
    const existing = await db.collection('gallery').findOne({ imageHash });
    if (existing) {
      return json(res, 409, {
        error: 'This image has already been uploaded',
        duplicate: true,
        existingId: existing._id.toString(),
      });
    }
  } catch (err) {
    console.error('[Gallery] Duplicate check error:', err);
    // Continue with upload if duplicate check fails
  }

  const ext = mimeType === 'image/jpeg'
    ? 'jpg'
    : mimeType === 'image/webp'
      ? 'webp'
      : 'png';
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const thumbFilename = `${id}_thumb.${ext}`;

  // Strip EXIF/metadata from the original and generate thumbnail
  let sanitizedBuffer = buffer;
  let thumbBuffer = null;
  const sharpUpload = await getSharp();
  if (sharpUpload) {
    try {
      sanitizedBuffer = await sharpUpload(buffer)
        .rotate() // Auto-rotate based on EXIF before stripping
        .withMetadata({}) // Strip all EXIF/ICC/XMP metadata
        .toBuffer();
    } catch (err) {
      console.warn('[Gallery] EXIF strip failed, using original:', err.message);
    }

    thumbBuffer = await buildThumbnail(sharpUpload, sanitizedBuffer, mimeType);
  }

  try {
    // Upload original (with metadata stripped)
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: filename,
      Body: sanitizedBuffer,
      ContentType: mimeType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));

    // Upload thumbnail if generated
    if (thumbBuffer) {
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: thumbFilename,
        Body: thumbBuffer,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000, immutable',
      }));
    }
  } catch (err) {
    console.error('[Gallery] R2 upload error:', err);
    return json(res, 500, { error: 'Failed to upload image' });
  }

  const url = `${PUBLIC_URL}/${filename}`;
  const thumbUrl = thumbBuffer ? `${PUBLIC_URL}/${thumbFilename}` : url;
  const doc = {
    url,
    thumbUrl,
    imageHash,
    // Guest uploads are stored with no author at all rather than the
    // ANONYMOUS_AUTHOR label — a stored name would let an account that happens
    // to be called "Anonymous" collect them through any author lookup.
    author: authUser ? authUser.username : null,
    authorId: authUser ? authUser._id.toString() : null,
    guest: !authUser,
    tagUsername: tagUsernameFlag,
    title: (title || '').substring(0, 60).trim(),
    description: (description || '').substring(0, 300).trim(),
    tags: normalizedTags,
    likes: [],
    likesCount: 0,
    views: 0,
    createdAt: new Date(),
  };

  try {
    const result = await db.collection('gallery').insertOne(doc);
    const item = {
      id: result.insertedId.toString(),
      url,
      thumbUrl,
      author: tagUsernameFlag ? authUser.username : ANONYMOUS_AUTHOR,
      isAuthor: !!authUser,
      tagUsername: tagUsernameFlag,
      title: doc.title,
      description: doc.description,
      tags: doc.tags,
      likesCount: 0,
      views: 0,
      createdAt: doc.createdAt,
    };

    json(res, 201, item);

    notifyWall('added', doc.tags, toWallItem({ ...doc, _id: result.insertedId }));

    if (doc.tags.includes('discord') && galleryDiscordPoster) {
      galleryDiscordPoster(item).catch(err => {
        console.error('[Gallery] Discord post error:', err);
      });
    }
  } catch (err) {
    console.error('[Gallery] DB insert error:', err);
    json(res, 500, { error: 'Failed to save gallery item' });
  }
}

const ANIMATION_MAX_BYTES = 25 * 1024 * 1024; // 25 MB webm cap

/**
 * Storage key for a time-lapse clip. Versioned per write: clips are served
 * with an immutable cache header, so re-encoding one (a re-crop or re-trim
 * from the editor) has to land on a fresh URL or viewers keep the stale video.
 */
function timelapseKey(id) {
  return `${id}_timelapse_${Date.now().toString(36)}.webm`;
}

/** Best-effort removal of an item's stored clip. Never fatal to the caller. */
async function deleteStoredAnimation(item) {
  if (!item?.animatedUrl) return;
  const { client, bucket } = animationStoreFor(item.animatedUrl);
  if (!client) return;
  try {
    const key = item.animatedUrl.split('/').pop();
    if (key) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    console.warn('[Gallery] Animation R2 delete failed (continuing):', err.message);
  }
}

/** Author or HOLY+ (role >= 8) — same bar as deleting the item itself. */
function canEditAnimation(item, authUser) {
  return String(item.authorId) === authUser._id.toString() || (authUser.role || 0) >= 8;
}

/**
 * POST /api/gallery/:id/animation — attach (or replace) a time-lapse WebM on an
 * existing gallery item. Author or HOLY+ moderator. Body:
 * { animationData: 'data:video/webm;base64,…', region?: {x,y,width,height} }.
 */
export async function handleGalleryAnimationUpload(req, res, id) {
  const clientIp = getClientIp(req);
  const limit = httpRateLimiter.consume(`gallery:animation:${clientIp}`, GALLERY_UPLOAD_LIMIT);
  if (!limit.allowed) {
    return json(res, 429, { error: 'Too many uploads. Please try again later.' });
  }

  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!r2Timelapse) return json(res, 503, { error: 'Storage not configured' });

  let item;
  try {
    item = await db.collection('gallery').findOne({ _id: new ObjectId(id) });
  } catch {
    return json(res, 400, { error: 'Invalid id' });
  }
  if (!item) return json(res, 404, { error: 'Item not found' });
  if (!canEditAnimation(item, authUser)) {
    return json(res, 403, { error: 'Not authorized to edit this time-lapse' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req, Math.ceil(ANIMATION_MAX_BYTES * 1.5) + 1024));
  } catch (err) {
    if (err?.message === 'Payload too large') return json(res, 413, { error: 'Animation too large' });
    return json(res, 400, { error: 'Invalid request body' });
  }

  const { animationData, region } = body;
  if (typeof animationData !== 'string' || !animationData.startsWith('data:video/webm')) {
    return json(res, 400, { error: 'Missing or invalid animationData' });
  }

  const base64 = animationData.slice(animationData.indexOf(',') + 1);
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return json(res, 400, { error: 'Invalid animation encoding' });
  }
  if (buffer.length === 0 || buffer.length > ANIMATION_MAX_BYTES) {
    return json(res, 400, { error: 'Animation size out of range' });
  }
  // EBML/Matroska(WebM) magic bytes: 1A 45 DF A3
  if (!(buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3)) {
    return json(res, 400, { error: 'Animation is not a valid WebM' });
  }

  const key = timelapseKey(id);
  try {
    await r2Timelapse.send(new PutObjectCommand({
      Bucket: TIMELAPSE_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'video/webm',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  } catch (err) {
    console.error('[Gallery] Animation R2 upload error:', err);
    return json(res, 500, { error: 'Failed to upload animation' });
  }

  const animatedUrl = `${TIMELAPSE_PUBLIC_URL}/${key}`;
  const update = { animatedUrl, animatedAt: new Date() };
  // Only stamp the board region when the caller supplies one. An editor
  // re-upload sends no region — it re-crops in video space — and must not
  // wipe the board rect the original capture recorded.
  if (region && typeof region === 'object') {
    update.animatedRegion = {
      x: Math.round(Number(region.x) || 0),
      y: Math.round(Number(region.y) || 0),
      width: Math.round(Number(region.width) || 0),
      height: Math.round(Number(region.height) || 0),
    };
  }

  try {
    await db.collection('gallery').updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );
  } catch (err) {
    console.error('[Gallery] Animation DB update error:', err);
    return json(res, 500, { error: 'Failed to save animation' });
  }

  // The row now points at the new key; drop the one it replaced.
  await deleteStoredAnimation(item);

  return json(res, 200, { id, animatedUrl });
}

/**
 * DELETE /api/gallery/:id/animation — detach the time-lapse so the card falls
 * back to the static image. Author or HOLY+ moderator.
 */
export async function handleGalleryAnimationDelete(req, res, id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  let item;
  try {
    item = await db.collection('gallery').findOne({ _id: new ObjectId(id) });
  } catch {
    return json(res, 400, { error: 'Invalid id' });
  }
  if (!item) return json(res, 404, { error: 'Item not found' });
  if (!canEditAnimation(item, authUser)) {
    return json(res, 403, { error: 'Not authorized to edit this time-lapse' });
  }

  try {
    await db.collection('gallery').updateOne(
      { _id: new ObjectId(id) },
      { $unset: { animatedUrl: '', animatedRegion: '', animatedAt: '' } }
    );
  } catch (err) {
    console.error('[Gallery] Animation delete error:', err);
    return json(res, 500, { error: 'Failed to remove animation' });
  }

  await deleteStoredAnimation(item);
  return json(res, 200, { id, removed: true });
}

/**
 * GET /api/gallery/:id — fetch a single gallery item.
 */
export async function handleGalleryItem(req, res, id) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  try {
    const { ObjectId } = await import('mongodb');
    const item = await db.collection('gallery').findOne({ _id: new ObjectId(id) });

    if (!item) return json(res, 404, { error: 'Item not found' });

    const viewer = await getRequestViewer(req, [id]);
    json(res, 200, toClientGalleryItem(item, viewer.likedIds, viewer.id));
  } catch (err) {
    console.error('[Gallery] Item fetch error:', err);
    json(res, 500, { error: 'Failed to fetch item' });
  }
}

/**
 * POST /api/gallery/:id/like — toggle like (one per device, account, or IP).
 * Body: { deviceId?: string }
 * Rules: Same device/account/IP cannot vote twice. Voting again from same source removes the vote.
 */
export async function handleGalleryLike(req, res, id) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, likedGalleryIds: 1 }
  });
  if (!authUser) return;

  const userId = authUser._id.toString();
  const likeLimit = httpRateLimiter.consume(`gallery:like:user:${userId}`, GALLERY_LIKE_LIMIT);
  if (!likeLimit.allowed) {
    return json(res, 429, { error: 'Too many like requests. Please try again later.' });
  }

  try {
    const objectId = new ObjectId(id);

    // Check if item exists
    if (!await db.collection('gallery').findOne({ _id: objectId }, { projection: { _id: 1 } })) {
      return json(res, 404, { error: 'Item not found' });
    }

    const likedGalleryIds = Array.isArray(authUser.likedGalleryIds)
      ? authUser.likedGalleryIds.map(String)
      : [];
    const alreadyLiked = likedGalleryIds.includes(id);

    if (alreadyLiked) {
      const userUnlikeUpdate = await db.collection('users').updateOne(
        { _id: authUser._id },
        { $pull: { likedGalleryIds: id } }
      );
      if (userUnlikeUpdate.modifiedCount === 0) {
        const current = await db.collection('gallery').findOne(
          { _id: objectId },
          { projection: { likesCount: 1 } }
        );
        return json(res, 200, { liked: false, likesCount: current?.likesCount || 0 });
      }
      await db.collection('gallery_likes').deleteOne({ galleryId: id, userId });
      const updated = await db.collection('gallery').findOneAndUpdate(
        { _id: objectId, likesCount: { $gt: 0 } },
        { $inc: { likesCount: -1 } },
        { returnDocument: 'after', projection: { likesCount: 1 } }
      );
      if (updated) notifyWall('likes', id, updated.likesCount || 0);
      return json(res, 200, { liked: false, likesCount: updated?.likesCount || 0 });
    }

    const userLikeUpdate = await db.collection('users').updateOne(
      { _id: authUser._id },
      { $addToSet: { likedGalleryIds: id } }
    );
    if (userLikeUpdate.modifiedCount === 0) {
      const current = await db.collection('gallery').findOne(
        { _id: objectId },
        { projection: { likesCount: 1 } }
      );
      return json(res, 200, { liked: true, likesCount: current?.likesCount || 0 });
    }
    await recordGalleryLike(db, { galleryId: id, userId, username: authUser.username });

    const updated = await db.collection('gallery').findOneAndUpdate(
      { _id: objectId },
      { $inc: { likesCount: 1 } },
      { returnDocument: 'after', projection: { likesCount: 1, tags: 1, _id: 1, url: 1, thumbUrl: 1, author: 1, authorId: 1, tagUsername: 1, title: 1, description: 1, createdAt: 1, views: 1 } }
    );

    const newLikesCount = updated?.likesCount || 1;
    notifyWall('likes', id, newLikesCount);

    // Broadcast to rooms when image first becomes eligible (1 like + room tag).
    // Only items created in the current calendar month participate in the floating
    // gallery rotation, matching the monthly reset behaviour of the list endpoint.
    if (newLikesCount === 1 && broadcastFloatingArtUpdate) {
      const createdAt = updated?.createdAt ? new Date(updated.createdAt) : null;
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      if (createdAt && createdAt >= startOfMonth) {
        const item = toClientGalleryItem(updated, new Set([id]));
        const tags = updated?.tags || [];
        broadcastFloatingArtUpdate(tags, item);
      }
    }

    json(res, 200, { liked: true, likesCount: newLikesCount });
  } catch (err) {
    console.error('[Gallery] Like error:', err);
    json(res, 500, { error: 'Failed to update likes' });
  }
}

/**
 * POST /api/gallery/:id/favorite — toggle favorite status.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryFavorite(req, res, id) {
  const clientIp = getClientIp(req);
  const favoriteLimit = httpRateLimiter.consume(`gallery:favorite:${clientIp}`, GALLERY_FAVORITE_LIMIT);
  if (!favoriteLimit.allowed) {
    return json(res, 429, { error: 'Too many favorite requests. Please try again later.' });
  }

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });
  const authUser = await requireAuthenticatedUser(req, res, { projection: { username: 1 } });
  if (!authUser) return;

  try {
    // Check if favorite exists
    const existing = await db.collection('favorites').findOne({
      userId: authUser._id.toString(),
      galleryId: id,
    });

    if (existing) {
      // Remove favorite
      await db.collection('favorites').deleteOne({ _id: existing._id });
      json(res, 200, { favorited: false });
    } else {
      // Add favorite
      await db.collection('favorites').insertOne({
        userId: authUser._id.toString(),
        galleryId: id,
        createdAt: new Date(),
      });
      json(res, 200, { favorited: true });
    }
  } catch (err) {
    console.error('[Gallery] Favorite error:', err);
    json(res, 500, { error: 'Failed to update favorite' });
  }
}

/**
 * GET /api/gallery/favorites — list user's favorited items.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryFavorites(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  const authUser = await requireAuthenticatedUser(req, res, { projection: { username: 1 } });
  if (!authUser) return;

  const urlObj = new URL(req.url, 'http://localhost');
  const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '24')));
  const skip = (page - 1) * limit;

  try {
    // Get user's favorites
    const favorites = await db.collection('favorites')
      .find({ userId: authUser._id.toString() })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await db.collection('favorites').countDocuments({ userId: authUser._id.toString() });
    const galleryIds = favorites.map(f => new ObjectId(f.galleryId));

    // Fetch gallery items
    const items = galleryIds.length > 0
      ? await db.collection('gallery').find({ _id: { $in: galleryIds } }).toArray()
      : [];

    // Maintain favorite order
    const itemMap = new Map(items.map(i => [i._id.toString(), i]));
    const orderedItems = favorites
      .map(f => itemMap.get(f.galleryId))
      .filter(Boolean);

    json(res, 200, {
      items: orderedItems.map(item => ({
        ...toClientGalleryItem(item, null, authUser._id.toString()),
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[Gallery] Favorites list error:', err);
    json(res, 500, { error: 'Failed to fetch favorites' });
  }
}

/**
 * GET /api/gallery/liked — list gallery items liked by the authenticated user.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryLiked(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, likedGalleryIds: 1 }
  });
  if (!authUser) return;

  const urlObj = new URL(req.url, 'http://localhost');
  const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '24')));
  const skip = (page - 1) * limit;
  const likedGalleryIds = Array.isArray(authUser.likedGalleryIds)
    ? authUser.likedGalleryIds.map(String).filter(id => /^[a-f0-9]{24}$/i.test(id))
    : [];

  try {
    const pageIds = likedGalleryIds.slice().reverse().slice(skip, skip + limit);
    const objectIds = pageIds.map(id => new ObjectId(id));
    const items = objectIds.length > 0
      ? await db.collection('gallery').find({ _id: { $in: objectIds } }).toArray()
      : [];
    const itemMap = new Map(items.map(item => [item._id.toString(), item]));
    const orderedItems = pageIds.map(id => itemMap.get(id)).filter(Boolean);
    const likedSet = new Set(likedGalleryIds);

    json(res, 200, {
      items: orderedItems.map(item => toClientGalleryItem(item, likedSet, authUser._id.toString())),
      total: likedGalleryIds.length,
      page,
      pages: Math.ceil(likedGalleryIds.length / limit),
    });
  } catch (err) {
    console.error('[Gallery] Liked list error:', err);
    json(res, 500, { error: 'Failed to fetch liked images' });
  }
}

/**
 * GET /api/gallery/:id/favorite — check if user has favorited an item.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryFavoriteCheck(req, res, id) {
  const token = getBearerToken(req);
  if (!token) {
    return json(res, 200, { favorited: false }); // Not logged in = not favorited
  }

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });
  const authUser = await getUserFromToken(token, { projection: { username: 1 } });
  if (!authUser) return json(res, 200, { favorited: false });

  try {
    const existing = await db.collection('favorites').findOne({
      userId: authUser._id.toString(),
      galleryId: id,
    });
    json(res, 200, { favorited: !!existing });
  } catch (err) {
    console.error('[Gallery] Favorite check error:', err);
    json(res, 500, { error: 'Failed to check favorite' });
  }
}

/**
 * GET /api/gallery/:id/comments — list comments for a gallery item.
 */
export async function handleGalleryCommentsList(req, res, id) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  try {
    const comments = await db.collection('comments')
      .find({ galleryId: id })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();

    json(res, 200, {
      comments: comments.map(c => ({
        id: c._id.toString(),
        author: c.author,
        authorId: c.authorId,
        text: c.text,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        edited: !!c.updatedAt,
      })),
    });
  } catch (err) {
    console.error('[Gallery] Comments list error:', err);
    json(res, 500, { error: 'Failed to fetch comments' });
  }
}

/**
 * GET /api/gallery/sidebar — fetch recent comments and popular tags for the sidebar.
 */
export async function handleGallerySidebar(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const urlObj = new URL(req.url, 'http://localhost');
  const author = urlObj.searchParams.get('author');
  const activeTag = normalizeTags(urlObj.searchParams.get('tag')).at(0) || null;
  const galleryMatch = {};
  if (author) Object.assign(galleryMatch, authorQuery(author));
  if (activeTag) galleryMatch.tags = activeTag;

  try {
    const recentCommentsPromise = db.collection('comments').aggregate([
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'gallery',
          let: { galleryId: '$galleryId' },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$galleryId'] }, ...galleryMatch } },
            { $project: { _id: 1, author: 1, title: 1, thumbUrl: 1, url: 1, tags: 1 } }
          ],
          as: 'galleryItem'
        }
      },
      { $unwind: '$galleryItem' },
      { $limit: 12 }
    ]).toArray();

    const tagPipeline = [];
    if (Object.keys(galleryMatch).length > 0) {
      tagPipeline.push({ $match: galleryMatch });
    }
    tagPipeline.push(
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 20 }
    );

    const [recentComments, tags] = await Promise.all([
      recentCommentsPromise,
      db.collection('gallery').aggregate(tagPipeline).toArray()
    ]);

    json(res, 200, {
      reservedTags: RESERVED_TAGS,
      recentComments: recentComments.map((comment) => ({
        id: comment._id.toString(),
        text: comment.text,
        author: comment.author,
        authorId: comment.authorId,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        edited: !!comment.updatedAt,
        galleryId: comment.galleryId,
        image: {
          id: comment.galleryItem._id.toString(),
          title: comment.galleryItem.title || '',
          author: comment.galleryItem.author,
          thumbUrl: comment.galleryItem.thumbUrl || comment.galleryItem.url,
          tags: Array.isArray(comment.galleryItem.tags) ? comment.galleryItem.tags : [],
        }
      })),
      tags: tags.map((tag) => ({
        tag: tag._id,
        count: tag.count
      }))
    });
  } catch (err) {
    console.error('[Gallery] Sidebar error:', err);
    json(res, 500, { error: 'Failed to fetch gallery sidebar' });
  }
}

/**
 * POST /api/gallery/:id/comments — add a comment.
 * Requires Authorization: Bearer <token>
 * Body: { text: string }
 */
export async function handleGalleryCommentCreate(req, res, id) {
  const clientIp = getClientIp(req);
  const commentLimit = httpRateLimiter.consume(`gallery:comment:${clientIp}`, GALLERY_COMMENT_LIMIT);
  if (!commentLimit.allowed) {
    return json(res, 429, { error: 'Too many comments. Please try again later.' });
  }

  const authUser = await requireAuthenticatedUser(req, res, { projection: { username: 1 } });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    if (err?.message === 'Payload too large') {
      return json(res, 413, { error: 'Request body too large' });
    }
    return json(res, 400, { error: 'Invalid request body' });
  }

  const text = (body.text || '').trim();
  if (!text || text.length > 500) {
    return json(res, 400, { error: 'Comment must be 1-500 characters' });
  }

  try {
    const galleryItem = await db.collection('gallery').findOne(
      { _id: new ObjectId(id) },
      { projection: { _id: 1 } }
    );
    if (!galleryItem) {
      return json(res, 404, { error: 'Item not found' });
    }

    const doc = {
      galleryId: id,
      authorId: authUser._id.toString(),
      author: authUser.username,
      text,
      createdAt: new Date(),
    };

    const result = await db.collection('comments').insertOne(doc);

    json(res, 201, {
      id: result.insertedId.toString(),
      author: authUser.username,
      authorId: authUser._id.toString(),
      text,
      createdAt: doc.createdAt,
      updatedAt: null,
      edited: false,
    });
  } catch (err) {
    console.error('[Gallery] Comment create error:', err);
    json(res, 500, { error: 'Failed to add comment' });
  }
}

/**
 * PATCH /api/gallery/comments/:commentId — edit own comment.
 * Requires Authorization: Bearer <token>
 * Body: { text: string }
 */
export async function handleGalleryCommentUpdate(req, res, commentId) {
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(commentId)) return json(res, 400, { error: 'Invalid id' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'Invalid request body' });
  }

  const text = (body.text || '').trim();
  if (!text || text.length > 500) {
    return json(res, 400, { error: 'Comment must be 1-500 characters' });
  }

  try {
    const updatedAt = new Date();
    const comment = await db.collection('comments').findOne({ _id: new ObjectId(commentId) });

    if (!comment) {
      return json(res, 404, { error: 'Comment not found' });
    }

    // Only allow the original author to edit their comment.
    if (comment.authorId !== authUser._id.toString()) {
      return json(res, 403, { error: 'Not authorized to edit this comment' });
    }

    await db.collection('comments').updateOne(
      { _id: new ObjectId(commentId) },
      { $set: { text, updatedAt } }
    );

    json(res, 200, { text, updatedAt, edited: true });
  } catch (err) {
    console.error('[Gallery] Comment update error:', err);
    json(res, 500, { error: 'Failed to update comment' });
  }
}

/**
 * DELETE /api/gallery/comments/:commentId — delete own comment.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryCommentDelete(req, res, commentId) {
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(commentId)) return json(res, 400, { error: 'Invalid id' });

  try {
    const comment = await db.collection('comments').findOne({ _id: new ObjectId(commentId) });

    if (!comment) {
      return json(res, 404, { error: 'Comment not found' });
    }

    // Only allow author or HOLY+ (role >= 8) to delete
    if (comment.authorId !== authUser._id.toString() && (authUser.role || 0) < 8) {
      return json(res, 403, { error: 'Not authorized to delete this comment' });
    }

    await db.collection('comments').deleteOne({ _id: new ObjectId(commentId) });
    json(res, 200, { deleted: true });
  } catch (err) {
    console.error('[Gallery] Comment delete error:', err);
    json(res, 500, { error: 'Failed to delete comment' });
  }
}

/**
 * PATCH /api/gallery/:id/tags — replace tags for a gallery item.
 * Requires Authorization: Bearer <token>
 * Body: { tags: string[]|string }
 */
export async function handleGalleryTagsUpdate(req, res, id) {
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'Invalid request body' });
  }

  const tags = normalizeTags(body.tags);

  try {
    const item = await db.collection('gallery').findOne({ _id: new ObjectId(id) });
    if (!item) return json(res, 404, { error: 'Item not found' });

    if (item.authorId !== authUser._id.toString() && (authUser.role || 0) < 8) {
      return json(res, 403, { error: 'Not authorized to edit tags for this item' });
    }

    const previousTags = Array.isArray(item.tags) ? item.tags : [];
    const shouldPostToDiscord = tags.includes('discord') && !previousTags.includes('discord');

    await db.collection('gallery').updateOne(
      { _id: new ObjectId(id) },
      { $set: { tags } }
    );

    json(res, 200, { tags });

    if (shouldPostToDiscord && galleryDiscordPoster) {
      galleryDiscordPoster({
        id,
        url: item.url,
        thumbUrl: item.thumbUrl || item.url,
        author: item.tagUsername !== false ? item.author : ANONYMOUS_AUTHOR,
        tagUsername: item.tagUsername !== false,
        title: item.title || '',
        description: item.description || '',
        tags,
        likesCount: item.likesCount || 0,
        views: item.views || 0,
        createdAt: item.createdAt,
      }).catch(err => {
        console.error('[Gallery] Discord post error:', err);
      });
    }
  } catch (err) {
    console.error('[Gallery] Tags update error:', err);
    json(res, 500, { error: 'Failed to update tags' });
  }
}

/**
 * DELETE /api/gallery/:id — delete own gallery item.
 * Requires Authorization: Bearer <token>
 */
export async function handleGalleryDelete(req, res, id) {
  const authUser = await requireAuthenticatedUser(req, res, {
    projection: { username: 1, role: 1 }
  });
  if (!authUser) return;

  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 400, { error: 'Invalid id' });

  try {
    const item = await db.collection('gallery').findOne({ _id: new ObjectId(id) });

    if (!item) {
      return json(res, 404, { error: 'Item not found' });
    }

    // Only allow author or HOLY+ (role >= 8) to delete
    if (item.authorId !== authUser._id.toString() && (authUser.role || 0) < 8) {
      return json(res, 403, { error: 'Not authorized to delete this item' });
    }

    // Delete from R2 if configured
    if (r2 && item.url) {
      try {
        const filename = item.url.split('/').pop();
        await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: filename }));
        // Also delete thumbnail if exists
        if (item.thumbUrl && item.thumbUrl !== item.url) {
          const thumbFilename = item.thumbUrl.split('/').pop();
          await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: thumbFilename }));
        }
        await deleteStoredAnimation(item);
      } catch (err) {
        console.warn('[Gallery] R2 delete failed (continuing):', err.message);
      }
    }

    // Delete associated comments and favorites
    await Promise.all([
      db.collection('gallery').deleteOne({ _id: new ObjectId(id) }),
      db.collection('comments').deleteMany({ galleryId: id }),
      db.collection('favorites').deleteMany({ galleryId: id }),
      db.collection('gallery_likes').deleteMany({ galleryId: id }),
      db.collection('users').updateMany({}, { $pull: { likedGalleryIds: id } }),
    ]);

    json(res, 200, { deleted: true });
    notifyWall('removed', id);
  } catch (err) {
    console.error('[Gallery] Delete error:', err);
    json(res, 500, { error: 'Failed to delete item' });
  }
}

/**
 * Shape a gallery doc for the floating art wall. `group` clusters an artist's
 * pieces; anonymous and guest pieces each get their own group so position
 * never reveals who posted them.
 */
export function toWallItem(item) {
  const id = item._id.toString();
  const tagUsername = item.tagUsername !== false;
  return {
    id,
    url: item.url,
    thumbUrl: item.thumbUrl || item.url,
    author: tagUsername && item.author ? item.author : ANONYMOUS_AUTHOR,
    authorHasProfile: tagUsername && !!item.authorId && !!item.author,
    title: item.title || '',
    likesCount: item.likesCount || 0,
    animatedUrl: item.animatedUrl || null,
    group: tagUsername && item.authorId ? `u:${item.authorId}` : `solo:${id}`
  };
}

/**
 * Every gallery piece tagged with the room (most-liked first, capped at
 * `limit`), plus explicitly included ids, minus excluded ids.
 * @returns {Promise<Array<ReturnType<typeof toWallItem>>>}
 */
export async function loadWallGalleryItems(roomId, { includeIds = [], excludeIds = [], limit = 400 } = {}) {
  const db = getDB();
  if (!db) return [];

  const roomTag = normalizeTags(roomId).at(0) || 'lobby';
  const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
  const exclude = new Set(excludeIds.filter(validId));
  const include = includeIds.filter(id => validId(id) && !exclude.has(id));
  const projection = { url: 1, thumbUrl: 1, author: 1, authorId: 1, tagUsername: 1, title: 1, likesCount: 1, animatedUrl: 1, createdAt: 1 };

  const [includedItems, taggedItems] = await Promise.all([
    include.length > 0
      ? db.collection('gallery').find({ _id: { $in: include.map(id => new ObjectId(id)) } }, { projection }).toArray()
      : Promise.resolve([]),
    db.collection('gallery')
      .find({
        tags: roomTag,
        ...(exclude.size > 0 ? { _id: { $nin: [...exclude].map(id => new ObjectId(id)) } } : {})
      }, { projection })
      .sort({ likesCount: -1, createdAt: -1 })
      .limit(limit)
      .toArray()
  ]);

  const seen = new Set();
  const merged = [];
  for (const item of [...includedItems, ...taggedItems]) {
    const id = item._id.toString();
    if (seen.has(id) || exclude.has(id)) continue;
    seen.add(id);
    merged.push(toWallItem(item));
  }
  return merged.slice(0, limit);
}

/**
 * GET /api/gallery/floating-wall?room=<roomId>&includeId=…&excludeId=…[&hidden=1]
 * Exactly the pieces the room's floating wall loads (loadWallGalleryItems), so room settings can
 * show what's really on the board, including a moderator's unsaved include/exclude draft.
 * With `hidden=1`, the excluded pieces themselves instead, so they can be unhidden.
 */
export async function handleFloatingWallList(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const room = urlObj.searchParams.get('room') || 'lobby';
  const validId = id => /^[a-f0-9]{24}$/i.test(id);
  const includeIds = [...new Set(urlObj.searchParams.getAll('includeId'))].filter(validId).slice(0, 200);
  const excludeIds = [...new Set(urlObj.searchParams.getAll('excludeId'))].filter(validId).slice(0, 200);
  try {
    if (urlObj.searchParams.get('hidden') === '1') {
      const db = getDB();
      if (!db) return json(res, 503, { error: 'Database not available' });
      const docs = excludeIds.length
        ? await db.collection('gallery')
          .find({ _id: { $in: excludeIds.map(id => new ObjectId(id)) } }, {
            projection: { url: 1, thumbUrl: 1, author: 1, authorId: 1, tagUsername: 1, title: 1, likesCount: 1, animatedUrl: 1 }
          })
          .toArray()
        : [];
      return json(res, 200, { items: docs.map(doc => toWallItem(doc)).map(({ group, ...item }) => item) });
    }
    const items = await loadWallGalleryItems(room, { includeIds, excludeIds });
    // `group` is internal (it carries the author id); the settings list doesn't need it
    json(res, 200, { items: items.map(({ group, ...item }) => item) });
  } catch (err) {
    console.error('[Gallery] Floating wall list error:', err);
    json(res, 500, { error: 'Failed to fetch floating wall' });
  }
}

const WALL_META_MAX_IDS = 60;

/**
 * GET /api/gallery/wall-meta?ids=<id>,<id>,…
 * Card details for floating wall pieces: the wall's own messages carry only ids and positions,
 * and clients fetch these for the cards near their screen. Same author rules as the wall
 * (toWallItem), minus the internal `group`. Unknown or deleted ids are simply absent.
 */
export async function handleWallMeta(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });
  const urlObj = new URL(req.url, 'http://localhost');
  const ids = [...new Set((urlObj.searchParams.get('ids') || '').split(','))]
    .filter(id => /^[a-f0-9]{24}$/i.test(id))
    .slice(0, WALL_META_MAX_IDS);
  if (!ids.length) return json(res, 200, { items: [] });
  try {
    const docs = await db.collection('gallery')
      .find({ _id: { $in: ids.map(id => new ObjectId(id)) } }, {
        projection: { url: 1, thumbUrl: 1, author: 1, authorId: 1, tagUsername: 1, title: 1, likesCount: 1, animatedUrl: 1 }
      })
      .toArray();
    json(res, 200, { items: docs.map(doc => toWallItem(doc)).map(({ group, ...item }) => item) });
  } catch (err) {
    console.error('[Gallery] Wall meta error:', err);
    json(res, 500, { error: 'Failed to fetch card details' });
  }
}

/**
 * GET /api/gallery/liked-ids — the signed-in user's liked gallery ids, so the
 * floating wall can fill its hearts without a per-item lookup.
 */
export async function handleGalleryLikedIds(req, res) {
  const token = getBearerToken(req);
  if (!token) return json(res, 200, { ids: [] });
  try {
    const authUser = await getUserFromToken(token, { projection: { likedGalleryIds: 1 } });
    const ids = Array.isArray(authUser?.likedGalleryIds)
      ? authUser.likedGalleryIds.map(String).filter(id => /^[a-f0-9]{24}$/i.test(id)).slice(-5000)
      : [];
    json(res, 200, { ids });
  } catch (err) {
    console.error('[Gallery] Liked ids error:', err);
    json(res, 500, { error: 'Failed to fetch liked ids' });
  }
}

/**
 * GET /api/gallery/floating?room=<roomId>&minLikes=2&limit=20
 * Fetch gallery images suitable for floating art display (images with minimum likes, tagged with room)
 */
export async function handleFloatingArtList(req, res) {
  const db = getDB();
  if (!db) return json(res, 503, { error: 'Database not available' });

  const urlObj = new URL(req.url, 'http://localhost');
  const room = urlObj.searchParams.get('room') || 'lobby';
  const minLikes = Math.max(0, parseInt(urlObj.searchParams.get('minLikes') || '2'));
  const limit = Math.min(200, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '20')));
  const includeIds = [...new Set(urlObj.searchParams.getAll('includeId').filter(id => /^[a-f0-9]{24}$/i.test(id)))];
  const excludeIds = [...new Set(urlObj.searchParams.getAll('excludeId').filter(id => /^[a-f0-9]{24}$/i.test(id)))];

  // Normalize room tag
  const roomTag = normalizeTags(room).at(0) || 'lobby';

  try {
    const token = getBearerToken(req);
    const authUser = token ? await getUserFromToken(token, { projection: { likedGalleryIds: 1 } }) : null;

    const baseQuery = {
      _id: excludeIds.length > 0
        ? { $nin: excludeIds.map(id => new ObjectId(id)) }
        : { $exists: true }
    };

    // All-time popular art, with a freshness boost: recent pieces (last 30 days)
    // qualify at the caller's minLikes, older pieces need POPULAR_MIN_LIKES.
    // Score = likes + a boost that starts at POPULAR_MIN_LIKES and decays to 0
    // over the window, so brand-new art competes evenly with 3-like classics.
    const POPULAR_MIN_LIKES = 3;
    const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const recentCutoff = new Date(now.getTime() - RECENT_WINDOW_MS);

    const [includedItems, taggedItems] = await Promise.all([
      includeIds.length > 0
        ? db.collection('gallery')
            .find({ _id: { $in: includeIds.map(id => new ObjectId(id)) } })
            .toArray()
        : Promise.resolve([]),
      db.collection('gallery')
        .aggregate([
          {
            $match: {
              ...baseQuery,
              tags: roomTag,
              $or: [
                { createdAt: { $gte: recentCutoff }, likesCount: { $gte: minLikes } },
                { likesCount: { $gte: Math.max(minLikes, POPULAR_MIN_LIKES) } }
              ]
            }
          },
          {
            $addFields: {
              _score: {
                $add: [
                  { $ifNull: ['$likesCount', 0] },
                  {
                    $multiply: [
                      POPULAR_MIN_LIKES,
                      {
                        $max: [
                          0,
                          {
                            $subtract: [
                              1,
                              { $divide: [{ $subtract: [now, '$createdAt'] }, RECENT_WINDOW_MS] }
                            ]
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            }
          },
          { $sort: { _score: -1, createdAt: -1 } },
          { $limit: limit },
          { $unset: '_score' }
        ])
        .toArray()
    ]);

    const merged = [];
    const seen = new Set();

    for (const item of includedItems) {
      const id = item?._id?.toString?.();
      if (!id || seen.has(id) || excludeIds.includes(id)) continue;
      seen.add(id);
      merged.push(item);
    }

    for (const item of taggedItems) {
      const id = item?._id?.toString?.();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
    }

    const mergedIds = merged.map(item => item?._id?.toString?.()).filter(Boolean);
    const likedSet = new Set(
      Array.isArray(authUser?.likedGalleryIds)
        ? authUser.likedGalleryIds.map(String).filter(id => mergedIds.includes(id))
        : []
    );

    json(res, 200, {
      items: merged.slice(0, limit).map((item) => toClientGalleryItem(item, likedSet, authUser?._id ? authUser._id.toString() : null)),
      room: roomTag,
      minLikes,
      count: merged.length
    });
  } catch (err) {
    console.error('[Gallery] Floating art list error:', err);
    json(res, 500, { error: 'Failed to fetch floating art' });
  }
}
