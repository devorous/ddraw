/**
 * @fileoverview Works-in-progress shelf storage.
 *
 * Art detached from a room's board (select tool → Detach) is kept here, owned
 * by a registered user, until the owner or a moderator drags it back onto the
 * board. Images live in Mongo and are served from `/api/wip/:id` so clients
 * can draw them back into a canvas without cross-origin tainting.
 */

import { ObjectId, Binary } from 'mongodb';
import { getDB } from './db.js';
import { validateDataUrlImage, INLINE_IMAGE_MIME_TYPES } from './imageValidation.js';
import { corsHeaders } from './httpUtils.js';

const COLLECTION = 'room_wip_arts';
export const MAX_WIP_PER_ROOM = 40;
const MAX_WIP_BYTES = 4 * 1024 * 1024;
const MAX_WIP_SIDE = 4096;
const MAX_WIP_PIXELS = 16 * 1024 * 1024;

function toWipItem(doc) {
  return {
    id: doc._id.toString(),
    ownerId: doc.ownerId,
    ownerName: doc.ownerName,
    width: doc.width,
    height: doc.height,
    createdAt: doc.createdAt
  };
}

/** @returns {Promise<Array<ReturnType<typeof toWipItem>>>} oldest first */
export async function listWipArts(roomId) {
  const db = getDB();
  if (!db) return [];
  const docs = await db.collection(COLLECTION)
    .find({ roomId }, { projection: { data: 0 } })
    .sort({ createdAt: 1 })
    .limit(MAX_WIP_PER_ROOM)
    .toArray();
  return docs.map(toWipItem);
}

/**
 * @returns {Promise<{ ok: true, item: ReturnType<typeof toWipItem> } | { ok: false, error: string }>}
 */
export async function createWipArt({ roomId, ownerId, ownerName, detachedById, detachedByName, dataUrl, rect }) {
  const db = getDB();
  if (!db) return { ok: false, error: 'Database not available' };

  const image = await validateDataUrlImage(dataUrl, {
    maxBytes: MAX_WIP_BYTES,
    maxWidth: MAX_WIP_SIDE,
    maxHeight: MAX_WIP_SIDE,
    maxPixels: MAX_WIP_PIXELS,
    allowedMimeTypes: INLINE_IMAGE_MIME_TYPES
  });
  if (!image.ok) return { ok: false, error: image.error || 'Invalid image' };

  const int = value => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0);
  const doc = {
    roomId,
    ownerId,
    ownerName,
    detachedById,
    detachedByName,
    width: image.width,
    height: image.height,
    mimeType: image.mimeType,
    data: new Binary(image.buffer),
    // Where it was cut from, for reference; dragging back places it wherever it's dropped
    sourceRect: { x: int(rect?.x), y: int(rect?.y), width: int(rect?.w), height: int(rect?.h) },
    createdAt: new Date()
  };
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { ok: true, item: toWipItem({ ...doc, _id: result.insertedId }) };
}

export async function deleteWipArt(roomId, id) {
  const db = getDB();
  if (!db || !/^[a-f0-9]{24}$/i.test(id)) return false;
  const result = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id), roomId });
  return result.deletedCount > 0;
}

/** GET /api/wip/:id — the stored image bytes. */
export async function handleWipImage(req, res, id) {
  const db = getDB();
  if (!db) {
    res.writeHead(503, corsHeaders('GET'));
    res.end();
    return;
  }
  try {
    const doc = await db.collection(COLLECTION).findOne(
      { _id: new ObjectId(id) },
      { projection: { data: 1, mimeType: 1 } }
    );
    if (!doc?.data) {
      res.writeHead(404, corsHeaders('GET'));
      res.end();
      return;
    }
    const bytes = Buffer.from(doc.data.buffer ?? doc.data);
    res.writeHead(200, {
      'Content-Type': doc.mimeType || 'image/png',
      'Content-Length': bytes.length,
      // An id always names the same image (restoring deletes it; a re-detach gets a new id)
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...corsHeaders('GET')
    });
    res.end(bytes);
  } catch (err) {
    console.error('[WIP] Image fetch error:', err);
    res.writeHead(500, corsHeaders('GET'));
    res.end();
  }
}
