/** @fileoverview Server-side sanitization and validation for inbound WebSocket messages. */

import { T, Tool } from '../shared/MessageTypes.js';
import { CHAT_IMAGE_MIME_TYPES, INLINE_IMAGE_MIME_TYPES, validateDataUrlImage, validateImageBytes } from './imageValidation.js';
import { normalizeBlendBakeMode } from '../shared/blendBakeMode.js';

export function hasOwnField(message, key) {
  return !!message && Object.prototype.hasOwnProperty.call(message, key);
}

const MIN_BRUSH_SIZE = 25;
const MAX_BRUSH_SIZE = 10000;
const MAX_SPACING = 5000;
const MAX_SMOOTHING = 50;
const MAX_HARDNESS = 100;
const MAX_PRESSURE = 100;
const MAX_BLUR_RADIUS = 25;
const MAX_FILL_BLUR_RADIUS = 25;
const MAX_LAYER_INDEX = 4;
const MAX_NAME_LENGTH = 20;
const MAX_CHAT_LENGTH = 500;
const MAX_GLOBAL_MESSAGE_LENGTH = 500;
const MAX_CHAT_MESSAGE_ID_LENGTH = 64;
const MAX_CHAT_REACTION_LENGTH = 16;
const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_WIDTH = 8192;
const MAX_INLINE_IMAGE_HEIGHT = 8192;
const MAX_INLINE_IMAGE_PIXELS = 16_777_216;
const MAX_ROOM_PREVIEW_BYTES = 100 * 1024;
const MAX_SYNC_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_IMAGE_PIXELS = 33_554_432;
const MAX_SYNC_BATCH_STROKES = 256;
const MAX_TILE_LIST = 4096;
const MAX_PATH_VALUES = 1024;
const MAX_SELECTION_POINTS = 2048;
const MAX_BRUSH_DATA_LENGTH = 12 * 1024 * 1024;
const MAX_MIRROR_REGION_PAYLOAD = 64 * 1024;
const MAX_AUTH_TOKEN_LENGTH = 4096;
const MAX_AUTH_STRING_LENGTH = 256;
const MAX_SECRET_QUESTION_LENGTH = 200;
const MAX_MOD_REASON_LENGTH = 200;
const MAX_ROOM_DESCRIPTION_LENGTH = 200;
const MAX_USERNAME_LOOKUP_LENGTH = 32;
const MAX_COORD = 50000;
const MIN_COORD = -50000;
// ps is transmitted as quantized (x10) delta-encoded sint32. Absolute values
// fit in ±MAX_COORD * 10; deltas can briefly exceed that after a big jump, so
// keep comfortable headroom without letting pathological values through.
const MAX_PS_VALUE = 600000;
const MIN_PS_VALUE = -600000;
const MAX_STAMP_METADATA_VALUE = 0xFFFFFF;
const MAX_DIMENSION = 10000;
const MAX_DURATION_MINUTES = 60 * 24 * 365;
const MAX_ROOM_USERS = 60;
const MOD_IP_SCOPES = new Set(['exact', 'subnet', 'wide']);
const MIN_TEXT_OVERLAY_LIFETIME_MS = 5000;
const MAX_TEXT_OVERLAY_LIFETIME_MS = 30 * 60 * 1000;

const VALID_MESSAGE_TYPES = new Set(Object.values(T));
const VALID_BLEND_MODES = new Set([
  'source-over',
  'multiply',
  'screen',
  'lighter',
  'overlay',
  'darken',
  'lighten',
  'difference',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'destination-out'
]);
const VALID_JOIN_POLICIES = new Set(['open', 'registered', 'trusted']);

const IMAGE_MESSAGE_TYPES = new Set([T.IMG_PASTE, T.SEL_LIFT, T.GLITCH_RESULT]);

const clampInt = (value, min, max, fallback = min) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
};

const sanitizeString = (value, maxLength, { trim = true } = {}) => {
  if (typeof value !== 'string') return '';
  const output = trim ? value.trim() : value;
  return output.slice(0, maxLength);
};

const sanitizeBoundedString = (value, maxLength, { trim = true } = {}) => {
  if (typeof value !== 'string') return '';
  const output = trim ? value.trim() : value;
  return output.length <= maxLength ? output : '';
};

const sanitizeBoolean = (value) => !!value;

const sanitizeFloatArray = (value, {
  min = MIN_COORD,
  max = MAX_COORD,
  maxLength = MAX_PATH_VALUES,
  requireEvenLength = false
} = {}) => {
  if (!Array.isArray(value)) return [];
  const out = [];

  for (const item of value) {
    const num = Number(item);
    if (!Number.isFinite(num)) continue;
    out.push(Math.min(Math.max(num, min), max));
    if (out.length >= maxLength) break;
  }

  if (requireEvenLength && out.length % 2 !== 0) {
    out.pop();
  }

  return out;
};

const sanitizeUintArray = (value, { max = 0xffffffff, maxLength = MAX_TILE_LIST } = {}) => {
  if (!Array.isArray(value)) return [];
  const out = [];

  for (const item of value) {
    const num = Number(item);
    if (!Number.isInteger(num) || num < 0) continue;
    out.push(Math.min(num, max));
    if (out.length >= maxLength) break;
  }

  return out;
};

const sanitizeBlendMode = (value) => {
  const blendMode = sanitizeString(value, 32);
  return VALID_BLEND_MODES.has(blendMode) ? blendMode : 'source-over';
};

// Only the explicit string 'existing' selects the destructive bake mode; an
// absent/empty `bbm` is 'background'. The inverse polarity meant the relay
// rewrote every bbm-less message to 'existing', which clips the committed
// stroke against the layer's existing alpha on receivers — shredding it along
// every old eraser path. See shared/blendBakeMode.js.
const sanitizeBlendBakeMode = (value) => normalizeBlendBakeMode(sanitizeString(value, 32));

const sanitizeImageRect = (data) => ({
  sx: clampInt(data.sx, MIN_COORD, MAX_COORD, 0),
  sy: clampInt(data.sy, MIN_COORD, MAX_COORD, 0),
  sw: clampInt(data.sw, 0, MAX_DIMENSION, 0),
  sh: clampInt(data.sh, 0, MAX_DIMENSION, 0)
});

function sanitizeStrokeRecord(record) {
  if (!record || typeof record !== 'object') return null;

  let img = record.img;
  if (img && typeof img === 'object' && !Buffer.isBuffer(img) && !(img instanceof Uint8Array)) {
    img = null;
  }
  if (img && img.length > MAX_SYNC_IMAGE_BYTES) {
    return null;
  }

  return {
    img,
    userId: clampInt(record.userId, 0, 65535, 0),
    x: clampInt(record.x, MIN_COORD, MAX_COORD, 0),
    y: clampInt(record.y, MIN_COORD, MAX_COORD, 0),
    width: clampInt(record.width, 0, MAX_DIMENSION, 0),
    height: clampInt(record.height, 0, MAX_DIMENSION, 0),
    blendMode: sanitizeBlendMode(record.blendMode),
    blendBakeMode: sanitizeBlendBakeMode(record.blendBakeMode),
    timestamp: Number.isFinite(Number(record.timestamp)) ? Number(record.timestamp) : 0,
    isRedo: sanitizeBoolean(record.isRedo),
    redoBatch: clampInt(record.redoBatch, 0, 10000, 0),
    layerIdx: clampInt(record.layerIdx, 0, MAX_LAYER_INDEX, 0),
    affectedTiles: sanitizeUintArray(record.affectedTiles, { max: 1_000_000, maxLength: MAX_TILE_LIST }),
    eraseAll: sanitizeBoolean(record.eraseAll),
    // seq is the authoritative global ordering key. Dropping it here makes every
    // synced stroke arrive at seq=0 on the joiner, which sorts ABOVE later live
    // strokes and inverts z-order — erases/blends then diverge until a full
    // re-sync. activeStroke must survive too so in-progress strokes import into
    // activeStrokeByUser rather than as committed strokes.
    seq: Number.isFinite(Number(record.seq)) ? Number(record.seq) : 0,
    activeStroke: sanitizeBoolean(record.activeStroke)
  };
}

/**
 * Validates and sanitizes a decoded protobuf/JSON message.
 * Returns `null` when the message violates server policy.
 *
 * @param {Record<string, any>} data
 * @returns {Promise<Record<string, any>|null>}
 */
export async function sanitizeMessage(data) {
  if (!data || typeof data !== 'object') return null;

  const type = Number(data.t);
  if (!Number.isInteger(type) || !VALID_MESSAGE_TYPES.has(type)) return null;

  const sanitized = { t: type };

  switch (type) {
    case T.CONNECT:
      sanitized.n = sanitizeString(data.n, MAX_NAME_LENGTH);
      if (data.resumeKey !== undefined) {
        sanitized.resumeKey = sanitizeString(data.resumeKey, 64);
      }
      return sanitized;

    case T.MM:
    case T.MD: {
      sanitized.ps = sanitizeFloatArray(data.ps, {
        requireEvenLength: true,
        min: MIN_PS_VALUE,
        max: MAX_PS_VALUE
      });
      if (!sanitized.ps.length) return null;
      if (Array.isArray(data.rs)) {
        sanitized.rs = sanitizeFloatArray(data.rs, {
          min: 0,
          max: MAX_STAMP_METADATA_VALUE,
          maxLength: Math.min(512, sanitized.ps.length / 2)
        });
      }
      if (data.g !== undefined) {
        sanitized.g = sanitizeString(data.g, MAX_BRUSH_DATA_LENGTH, { trim: false });
      }
      if (type === T.MD) {
        if (data.ly !== undefined) sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
        if (data.bm !== undefined) sanitized.bm = sanitizeBlendMode(data.bm);
        if (data.bbm !== undefined) sanitized.bbm = sanitizeBlendBakeMode(data.bbm);
      }
      return sanitized;
    }

    case T.MU:
    case T.CLR:
    case T.MIR:
    case T.CANCEL:
    case T.HIDE_CURSOR:
    case T.SHOW_CURSOR:
    case T.REDO:
    case T.ROOM_LIST_REQUEST:
    case T.ROOM_REGISTER:
    case T.ROOM_UNREGISTER:
    case T.ROOM_ROLE_LIST_REQUEST:
    case T.PING:
    case T.PONG:
      if (data.lowPowerMode !== undefined) sanitized.lowPowerMode = sanitizeBoolean(data.lowPowerMode);
      if (data.tabHidden !== undefined) sanitized.tabHidden = sanitizeBoolean(data.tabHidden);
      return sanitized;

    // Split out of the group above so undo_target_seq survives: that group keeps
    // only lowPowerMode/tabHidden, and a field absent from a type's validation
    // case is silently dropped for every receiver.
    case T.UNDO:
      if (data.lowPowerMode !== undefined) sanitized.lowPowerMode = sanitizeBoolean(data.lowPowerMode);
      if (data.tabHidden !== undefined) sanitized.tabHidden = sanitizeBoolean(data.tabHidden);
      if (data.undoTargetSeq !== undefined) {
        const n = Number(data.undoTargetSeq);
        sanitized.undoTargetSeq = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      }
      return sanitized;

    case T.CS:
      sanitized.s = clampInt(data.s, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE, 1000);
      return sanitized;

    case T.CSP:
      sanitized.sp = clampInt(data.sp, 0, MAX_SPACING, 10);
      return sanitized;

    case T.CSM:
      sanitized.sm = clampInt(data.sm, 0, MAX_SMOOTHING, 15);
      return sanitized;

    case T.CHD:
      sanitized.hd = clampInt(data.hd, 0, MAX_HARDNESS, 100);
      return sanitized;

    case T.CBR:
      sanitized.br = clampInt(data.br, 0, MAX_BLUR_RADIUS, 5);
      return sanitized;

    case T.CP:
      sanitized.p = clampInt(data.p, 0, MAX_PRESSURE, 100);
      return sanitized;

    case T.CC:
      sanitized.c = Number.isInteger(data.c) ? data.c >>> 0 : 0;
      return sanitized;

    case T.CT:
      sanitized.l = clampInt(data.l, 0, Object.keys(Tool).length - 1, Tool.BRUSH);
      if (data.a !== undefined) sanitized.a = sanitizeBoolean(data.a);
      return sanitized;

    case T.CL:
      sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      return sanitized;

    case T.CBM:
      sanitized.bm = sanitizeBlendMode(data.bm);
      if (data.ly !== undefined) sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      if (data.bbm !== undefined) sanitized.bbm = sanitizeBlendBakeMode(data.bbm);
      return sanitized;

    case T.CN:
      sanitized.n = sanitizeString(data.n, MAX_NAME_LENGTH);
      return sanitized;

    case T.AFK:
    case T.PAN:
      sanitized.a = sanitizeBoolean(data.a);
      return sanitized;

    case T.MSG:
      sanitized.g = sanitizeString(data.g, MAX_CHAT_LENGTH, { trim: true });
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      if (!sanitized.chatMessageId) return null;
      return sanitized.g ? sanitized : null;

    case T.STAFF_MSG:
      sanitized.g = sanitizeString(data.g, MAX_CHAT_LENGTH, { trim: true });
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      if (!sanitized.chatMessageId) return null;
      return sanitized.g ? sanitized : null;

    case T.GLOBAL_MESSAGE:
      sanitized.g = sanitizeString(data.g, MAX_GLOBAL_MESSAGE_LENGTH, { trim: true });
      sanitized.k = sanitizeString(data.k, 32, { trim: true });
      sanitized.n = sanitizeString(data.n, MAX_NAME_LENGTH, { trim: true });
      sanitized.a = sanitizeBoolean(data.a);
      return sanitized.g ? sanitized : null;

    case T.DM:
      sanitized.g = sanitizeString(data.g, MAX_CHAT_LENGTH, { trim: true });
      sanitized.r = clampInt(data.r, 0, 65535, 0);
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      if (!sanitized.chatMessageId) return null;
      return sanitized.g ? sanitized : null;

    case T.CHAT_REACTION:
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      sanitized.chatReaction = sanitizeString(data.chatReaction ?? data.chat_reaction, MAX_CHAT_REACTION_LENGTH);
      sanitized.chatReactionRemove = sanitizeBoolean(data.chatReactionRemove ?? data.chat_reaction_remove);
      if (hasOwnField(data, 'r')) sanitized.r = clampInt(data.r, 0, 65535, 0);
      return sanitized.chatMessageId && sanitized.chatReaction ? sanitized : null;

    case T.KP:
      sanitized.k = sanitizeString(data.k, 20, { trim: false });
      return sanitized.k ? sanitized : null;

    case T.TEXT_APPLY:
      sanitized.g = sanitizeString(data.g, 500, { trim: false });
      sanitized.ps = sanitizeFloatArray(data.ps, {
        requireEvenLength: true,
        maxLength: 2,
        min: MIN_PS_VALUE,
        max: MAX_PS_VALUE
      });
      sanitized.s = clampInt(data.s, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE, 1000);
      sanitized.c = Number.isInteger(data.c) ? data.c >>> 0 : 0;
      sanitized.p = clampInt(data.p, 0, MAX_PRESSURE, 100);
      sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      sanitized.bm = sanitizeBlendMode(data.bm);
      // Blend BAKE mode travels with the text for the same reason it travels with
      // MD/CBM: the receiver reads data.bbm directly. Without it every remote text
      // stamp bakes as 'existing' no matter what the author picked.
      sanitized.bbm = sanitizeBlendBakeMode(data.bbm);
      sanitized.fo = sanitizeString(data.fo, 120, { trim: true });
      sanitized.tm = Math.min(Math.max(Number(data.tm), -1), 1);
      sanitized.to = Math.min(Math.max(Number(data.to), -20), 20);
      if (!Number.isFinite(sanitized.tm)) sanitized.tm = 0;
      if (!Number.isFinite(sanitized.to)) sanitized.to = 0;
      sanitized.textId = sanitizeString(data.textId, 80, { trim: true });
      sanitized.textLifetimeMs = clampInt(data.textLifetimeMs, 0, 30 * 60 * 1000, 0);
      sanitized.textFadeMs = clampInt(data.textFadeMs, 0, 30 * 60 * 1000, 0);
      sanitized.textAgeMs = clampInt(data.textAgeMs, 0, 30 * 60 * 1000, 0);
      sanitized.textPixel = !!data.textPixel;
      return sanitized.g && sanitized.ps.length === 2 ? sanitized : null;

    case T.TEXT_REMOVE:
      sanitized.textId = sanitizeString(data.textId, 80, { trim: true });
      return sanitized.textId ? sanitized : null;

    case T.GMP:
    case T.GPT:
    case T.SEL_TO_BRUSH:
      sanitized.g = sanitizeBoundedString(data.g, MAX_BRUSH_DATA_LENGTH, { trim: false });
      return sanitized.g ? sanitized : null;

    case T.IMAGE_TOOL: {
      const imageToolType = sanitizeString(
        data.imageToolType ?? data.image_tool_type ?? data.k,
        24,
        { trim: true }
      );
      if (!['imageBrush', 'pattern', 'confetti'].includes(imageToolType)) return null;

      const imageToolData = sanitizeBoundedString(
        data.imageToolData ?? data.image_tool_data ?? data.g,
        MAX_BRUSH_DATA_LENGTH,
        { trim: false }
      );
      if (!imageToolData) return null;

      sanitized.imageToolType = imageToolType;
      sanitized.imageToolData = imageToolData;
      return sanitized;
    }

    case T.OBSCURE_REGION: {
      const raw = sanitizeString(data.g, MAX_BRUSH_DATA_LENGTH, { trim: false });
      if (!raw) return null;
      try {
        const payload = JSON.parse(raw);
        if (!payload || typeof payload !== 'object') return null;
        if (typeof payload.id !== 'string' || !payload.id) return null;
        if (payload.remove) {
          sanitized.g = JSON.stringify({ id: payload.id.slice(0, 80), remove: true });
          return sanitized;
        }
        const x = clampInt(payload.x, MIN_COORD, MAX_COORD, 0);
        const y = clampInt(payload.y, MIN_COORD, MAX_COORD, 0);
        const width = clampInt(payload.width, 1, MAX_DIMENSION, 0);
        const height = clampInt(payload.height, 1, MAX_DIMENSION, 0);
        if (width <= 0 || height <= 0) return null;
        const out = { id: payload.id.slice(0, 80), x, y, width, height };
        if (Array.isArray(payload.lassoPath)) {
          const points = [];
          for (const point of payload.lassoPath.slice(0, MAX_SELECTION_POINTS)) {
            const px = Number(point?.x);
            const py = Number(point?.y);
            if (Number.isFinite(px) && Number.isFinite(py)) {
              points.push({
                x: Math.min(Math.max(px, MIN_COORD), MAX_COORD),
                y: Math.min(Math.max(py, MIN_COORD), MAX_COORD)
              });
            }
          }
          if (points.length >= 3) out.lassoPath = points;
        }
        sanitized.g = JSON.stringify(out);
        return sanitized;
      } catch {
        return null;
      }
    }

    case T.CPM:
      sanitized.pm = sanitizeBoolean(data.pm);
      return sanitized;

    case T.CSDM: {
      const mode = sanitizeString(data.sdm, 24);
      sanitized.sdm = mode === 'center-scaling' ? 'center-scaling' : 'corner-to-corner';
      return sanitized;
    }

    case T.CF:
      sanitized.fo = sanitizeString(data.fo, 120, { trim: true });
      sanitized.tm = Math.min(Math.max(Number(data.tm), -1), 1);
      sanitized.to = Math.min(Math.max(Number(data.to), -20), 20);
      if (!Number.isFinite(sanitized.tm)) sanitized.tm = 0;
      if (!Number.isFinite(sanitized.to)) sanitized.to = 0;
      return sanitized.fo ? sanitized : null;

    case T.SEL_PENDING:
      Object.assign(sanitized, sanitizeImageRect(data));
      if (Array.isArray(data.ps)) {
        sanitized.ps = sanitizeFloatArray(data.ps, {
          requireEvenLength: true,
          maxLength: MAX_SELECTION_POINTS,
          min: MIN_PS_VALUE,
          max: MAX_PS_VALUE
        });
      }
      return sanitized;

    case T.SEL_MASK:
      sanitized.mk = sanitizeBoolean(data.mk);
      if (!sanitized.mk) return sanitized;
      Object.assign(sanitized, sanitizeImageRect(data));
      if (Array.isArray(data.ps)) {
        sanitized.ps = sanitizeFloatArray(data.ps, {
          requireEvenLength: true,
          maxLength: MAX_SELECTION_POINTS,
          min: MIN_PS_VALUE,
          max: MAX_PS_VALUE
        });
      }
      return sanitized.sw > 0 && sanitized.sh > 0 ? sanitized : null;

    case T.SEL_MOVE:
      sanitized.cr = sanitizeFloatArray(data.cr, {
        requireEvenLength: true,
        maxLength: 8
      });
      if (Array.isArray(data.cb)) {
        const cb = sanitizeFloatArray(data.cb, {
          requireEvenLength: true,
          maxLength: 4,
          min: 0,
          max: MAX_COORD
        });
        if (cb.length === 4 && cb[2] > 0 && cb[3] > 0) {
          sanitized.cb = cb;
        }
      }
      if (Array.isArray(data.cbt)) {
        const cbt = sanitizeFloatArray(data.cbt, {
          requireEvenLength: true,
          maxLength: 4,
          min: 0,
          max: MAX_COORD
        });
        if (cbt.length === 4 && cbt[2] > 0 && cbt[3] > 0) {
          sanitized.cbt = cbt;
        }
      }
      // Extended-warp flag seeds the receiver's warp bounds for this drag.
      if (data.selExtendedWarp !== undefined) sanitized.selExtendedWarp = sanitizeBoolean(data.selExtendedWarp);
      return sanitized.cr.length === 8 ? sanitized : null;

    case T.SEL_COMMIT:
    case T.SEL_DELETE:
    case T.SEL_STAMP:
    case T.SEL_CANCEL:
    case T.SEL_FLIP:
      if (data.ly !== undefined) sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      // All-layers flag. The op spans every layer, not just `ly`, and there is
      // no way for a receiver to infer that — without it an all-layers clear
      // wiped one layer on observers and all of them on the drawer.
      if (data.a !== undefined) sanitized.a = sanitizeBoolean(data.a);
      // Mirror state at operation time. A joiner replaying the tail has not
      // necessarily applied the room's mirror toggle yet (MIR is not a commit
      // and is not in the stroke log), so it cannot read this off its own board.
      if (data.m !== undefined) sanitized.m = sanitizeBoolean(data.m);
      // Extended-warp flag: the commit/stamp bakes with its OWN value, which can
      // differ from the one that travelled with SEL_LIFT.
      if (data.selExtendedWarp !== undefined) sanitized.selExtendedWarp = sanitizeBoolean(data.selExtendedWarp);
      return sanitized;

    case T.SEL_FILL:
      sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      sanitized.c = Number.isInteger(data.c) ? data.c >>> 0 : 0;
      // Filled rect — a rect selection is cropped for display but filled at its
      // original dragged size, so the geometry cannot be inferred by the receiver.
      sanitized.sx = clampInt(data.sx, MIN_COORD, MAX_COORD, 0);
      sanitized.sy = clampInt(data.sy, MIN_COORD, MAX_COORD, 0);
      sanitized.sw = clampInt(data.sw, 0, MAX_COORD, 0);
      sanitized.sh = clampInt(data.sh, 0, MAX_COORD, 0);
      // Lasso shape, same reasoning as the rect above: a lasso fill is clipped
      // to the path and the receiver cannot reconstruct it from the bounds.
      if (Array.isArray(data.ps)) {
        sanitized.ps = sanitizeFloatArray(data.ps, {
          requireEvenLength: true,
          maxLength: MAX_SELECTION_POINTS,
          min: MIN_PS_VALUE,
          max: MAX_PS_VALUE
        });
      }
      // Mirror state at fill time: the drawer fills every active mirror region
      // too, and the receiver cannot infer the room's mirror toggle.
      if (data.m !== undefined) sanitized.m = sanitizeBoolean(data.m);
      return sanitized;

    // Without this case the sanitizer fell through to the bare `return sanitized`
    // at the end of the switch, which keeps only `t`. Both of SEL_MERGE's fields
    // were therefore stripped: receivers read `mode = data.g || 'down'` and
    // `sourceLayer = data.ly ?? 0`, so every merge arrived as "merge down from
    // layer 0" and hit the `activeLayer <= 0` guard — merge never replicated to
    // anyone, on any layer.
    case T.SEL_MERGE: {
      const mode = sanitizeString(data.g, 8);
      sanitized.g = ['up', 'down', 'all'].includes(mode) ? mode : 'down';
      sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      return sanitized;
    }

    case T.FILL:
      sanitized.sx = clampInt(data.sx, MIN_COORD, MAX_COORD, 0);
      sanitized.sy = clampInt(data.sy, MIN_COORD, MAX_COORD, 0);
      sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      sanitized.s = clampInt(data.s, -MAX_BRUSH_SIZE, MAX_BRUSH_SIZE, 0);
      sanitized.br = clampInt(data.br, 0, MAX_FILL_BLUR_RADIUS * 100, 0);
      return sanitized;

    case T.SYNC_REQUEST:
      if (data.tu !== undefined) sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      return sanitized;

    case T.CTHN:
      sanitized.th = clampInt(data.th, 0, 100, 51);
      return sanitized;

    case T.CSIM:
      sanitized.sim = clampInt(data.sim, 0, 2, 2);
      return sanitized;

    case T.ROOM_PREVIEW: {
      const previewValidation = await validateImageBytes(data.img, {
        maxBytes: MAX_ROOM_PREVIEW_BYTES,
        maxWidth: 2048,
        maxHeight: 2048,
        maxPixels: 1_048_576,
        allowedMimeTypes: new Set(['image/png']),
        mimeTypeHint: 'image/png'
      });
      if (!previewValidation.ok) return null;
      sanitized.img = new Uint8Array(previewValidation.buffer);
      return sanitized;
    }

    case T.ROOM_UPDATE:
      if (data.roomDescription !== undefined) {
        sanitized.roomDescription = sanitizeString(data.roomDescription, MAX_ROOM_DESCRIPTION_LENGTH);
      }
      if (data.roomBackgroundColor !== undefined) {
        const color = sanitizeString(data.roomBackgroundColor, 7);
        if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
        sanitized.roomBackgroundColor = color;
      }
      if (data.roomLocked !== undefined) sanitized.roomLocked = sanitizeBoolean(data.roomLocked);
      if (data.roomModInactiveImmune !== undefined) sanitized.roomModInactiveImmune = sanitizeBoolean(data.roomModInactiveImmune);
      if (data.roomAutoMuteGuests !== undefined) sanitized.roomAutoMuteGuests = sanitizeBoolean(data.roomAutoMuteGuests);
      if (data.roomAutoMuteVpnUsers !== undefined) sanitized.roomAutoMuteVpnUsers = sanitizeBoolean(data.roomAutoMuteVpnUsers);
      if (data.roomHideChatNotifications !== undefined) sanitized.roomHideChatNotifications = sanitizeBoolean(data.roomHideChatNotifications);
      if (data.roomMaxUsers !== undefined) sanitized.roomMaxUsers = clampInt(data.roomMaxUsers, 2, MAX_ROOM_USERS, 40);
      if (data.roomJoinPolicy !== undefined) {
        const joinPolicy = sanitizeString(data.roomJoinPolicy, 16);
        sanitized.roomJoinPolicy = VALID_JOIN_POLICIES.has(joinPolicy) ? joinPolicy : 'open';
      }
      if (data.roomObscureRequiresRegistered !== undefined) sanitized.roomObscureRequiresRegistered = sanitizeBoolean(data.roomObscureRequiresRegistered);
      if (data.roomPrivate !== undefined) sanitized.roomPrivate = sanitizeBoolean(data.roomPrivate);
      // Tri-state (0 unset / 1 on / 2 off), not a bool: this setting defaults ON,
      // and proto3 omits a false bool, so "off" would be indistinguishable from
      // "client didn't touch it". Omitting it from this whitelist dropped the
      // field before ROOM_UPDATE ever saw it, so the checkbox never persisted.
      if (data.roomSnapshotOnFirstJoin !== undefined) {
        sanitized.roomSnapshotOnFirstJoin = clampInt(data.roomSnapshotOnFirstJoin, 0, 2, 0);
      }
      // 0/absent means "unchanged" here too: a decoded proto message exposes
      // prototype defaults, so an unset uint32 arrives as 0 rather than
      // undefined, and clamping that up to the minimum would silently rewrite
      // the room's fade time on any ROOM_UPDATE that omits the field.
      if (Number(data.roomTextOverlayLifetimeMs) > 0) {
        sanitized.roomTextOverlayLifetimeMs = clampInt(
          data.roomTextOverlayLifetimeMs,
          MIN_TEXT_OVERLAY_LIFETIME_MS,
          MAX_TEXT_OVERLAY_LIFETIME_MS,
          30 * 1000
        );
      }
      if (data.roomDedicatedReplayUser !== undefined) {
        // null or empty string clears, otherwise sanitize as username
        sanitized.roomDedicatedReplayUser = data.roomDedicatedReplayUser
          ? sanitizeString(data.roomDedicatedReplayUser, MAX_NAME_LENGTH)
          : null;
      }
      if (data.roomBoardSize !== undefined) {
        sanitized.roomBoardSize = sanitizeString(data.roomBoardSize, 10);
      }
      if (data.roomCreatorDeviceId !== undefined) {
        sanitized.roomCreatorDeviceId = sanitizeString(data.roomCreatorDeviceId, MAX_AUTH_STRING_LENGTH);
      }
      if (data.roomFloatingGallerySeed !== undefined) {
        sanitized.roomFloatingGallerySeed = Number(data.roomFloatingGallerySeed);
      }
      if (data.roomFloatingGalleryIncludeIds !== undefined) {
        sanitized.roomFloatingGalleryIncludeIds = Array.isArray(data.roomFloatingGalleryIncludeIds)
          ? data.roomFloatingGalleryIncludeIds.map(id => sanitizeString(id, 24)).filter(id => /^[a-f0-9]{24}$/i.test(id))
          : [];
      }
      if (data.roomFloatingGalleryExcludeIds !== undefined) {
        sanitized.roomFloatingGalleryExcludeIds = Array.isArray(data.roomFloatingGalleryExcludeIds)
          ? data.roomFloatingGalleryExcludeIds.map(id => sanitizeString(id, 24)).filter(id => /^[a-f0-9]{24}$/i.test(id))
          : [];
      }
      return sanitized;

    case T.MIRROR_REGION:
      sanitized.mirrorRegionsJson = sanitizeString(data.mirrorRegionsJson, MAX_MIRROR_REGION_PAYLOAD, { trim: false });
      return sanitized.mirrorRegionsJson ? sanitized : null;

    case T.SET_BADGE:
      // handleBroadcast validates the id against SELECTABLE_BADGES / entitlements;
      // we only bound it. With no case here the field was stripped and every badge
      // change resolved to '' — i.e. it CLEARED the sender's badge for everyone.
      sanitized.profileBadge = sanitizeString(data.profileBadge, 32);
      return sanitized;

    case T.MOD_LIST:
      // Without these the mod panel's search box and Active/History toggle sent
      // their values into the void: getModEntries always ran unfiltered + active-only.
      sanitized.modShowHistory = sanitizeBoolean(data.modShowHistory);
      sanitized.modSearch = sanitizeString(data.modSearch, MAX_NAME_LENGTH);
      return sanitized;

    case T.MOD_ACTION:
      // Upper bound must track MOD_ACTION_MAP in server/index.js, which is
      // currently 8 entries (0 kick … 5 update, 6 shadowban, 7 unshadowban).
      // It was left at 5 when shadowban/unshadowban were added, so every
      // shadowban request was clamped into 5 = MOD_UPDATE — which ran, and
      // still returned MOD_RESULT a=true. The feature was inert and the
      // moderator was told it worked. Widen this whenever an action is added.
      sanitized.modActionType = clampInt(data.modActionType, 0, 7, 0);
      sanitized.modTarget = clampInt(data.modTarget, 0, 65535, 0);
      sanitized.modReason = sanitizeString(data.modReason, MAX_MOD_REASON_LENGTH);
      sanitized.modDuration = clampInt(data.modDuration, 0, MAX_DURATION_MINUTES, 0);
      sanitized.modTargetName = sanitizeString(data.modTargetName, MAX_NAME_LENGTH);
      // IP match scope from the ban dialog's dropdown. Dropping it here made the
      // handler's `(rawIpScope === 'exact' || rawIpScope === 'wide')` test always
      // fail, so every IP ban silently fell back to 'subnet'.
      if (data.modIpScope !== undefined) {
        const ipScope = sanitizeString(data.modIpScope, 16);
        sanitized.modIpScope = MOD_IP_SCOPES.has(ipScope) ? ipScope : 'subnet';
      }
      return sanitized;

    case T.MOD_WIPE:
      sanitized.modTarget = clampInt(data.modTarget, 0, 65535, 0);
      sanitized.modTargetName = sanitizeString(data.modTargetName, MAX_NAME_LENGTH);
      return sanitized;

    case T.ROOM_ROLE_SET:
      sanitized.roomRoleTargetId = sanitizeString(data.roomRoleTargetId, MAX_AUTH_STRING_LENGTH);
      sanitized.roomRoleTargetName = sanitizeString(data.roomRoleTargetName, MAX_USERNAME_LOOKUP_LENGTH);
      sanitized.roomRoleValue = clampInt(data.roomRoleValue, 0, 5, 0);
      return sanitized;

    case T.GLOBAL_ROLE_SET:
      sanitized.targetUsername = sanitizeString(
        data.targetUsername ?? data.target_username,
        MAX_USERNAME_LOOKUP_LENGTH
      );
      sanitized.newGlobalRole = clampInt(
        data.newGlobalRole ?? data.new_global_role,
        0,
        255,
        0
      );
      return sanitized;

    case T.AUTH_LOGIN:
      if (data.authUsername !== undefined) sanitized.authUsername = sanitizeString(data.authUsername, MAX_USERNAME_LOOKUP_LENGTH);
      if (data.authPassword !== undefined) sanitized.authPassword = sanitizeString(data.authPassword, MAX_AUTH_STRING_LENGTH, { trim: false });
      if (data.authToken !== undefined) sanitized.authToken = sanitizeString(data.authToken, MAX_AUTH_TOKEN_LENGTH, { trim: false });
      if (!sanitized.authToken && !(sanitized.authUsername && sanitized.authPassword)) return null;
      return sanitized;

    case T.AUTH_REGISTER:
      sanitized.authUsername = sanitizeString(data.authUsername, MAX_USERNAME_LOOKUP_LENGTH);
      sanitized.authPassword = sanitizeString(data.authPassword, MAX_AUTH_STRING_LENGTH, { trim: false });
      sanitized.authEmail = sanitizeString(data.authEmail, MAX_AUTH_STRING_LENGTH);
      sanitized.authSecretQuestion = sanitizeString(data.authSecretQuestion, MAX_SECRET_QUESTION_LENGTH);
      sanitized.authSecretAnswer = sanitizeString(data.authSecretAnswer, MAX_AUTH_STRING_LENGTH, { trim: false });
      if (!sanitized.authUsername || !sanitized.authPassword) return null;
      return sanitized;

    case T.TILE_UPDATE:
      if (!Array.isArray(data.tiles)) return null;
      sanitized.tiles = data.tiles
        .slice(0, MAX_TILE_LIST)
        .map((entry) => {
          if (typeof entry === 'number') {
            return clampInt(entry, 0, 1_000_000, 0);
          }
          if (!entry || typeof entry !== 'object') return null;
          return {
            idx: clampInt(entry.idx, 0, 1_000_000, 0),
            users: sanitizeUintArray(entry.users, { max: 65535, maxLength: 32 })
          };
        })
        .filter((entry) => entry !== null);
      return sanitized;

    case T.TILE_CLEAR:
      sanitized.clearedTiles = sanitizeUintArray(data.clearedTiles, { max: 1_000_000, maxLength: MAX_TILE_LIST });
      return sanitized.clearedTiles.length ? sanitized : null;

    case T.SYNC_LAYER_BASE:
    case T.SYNC_STROKE: {
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      if (type === T.SYNC_LAYER_BASE || type === T.SYNC_STROKE) {
        sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
        sanitized.bm = sanitizeBlendMode(data.bm);
        if (data.bbm !== undefined) sanitized.bbm = sanitizeBlendBakeMode(data.bbm);
      }
      if (type === T.SYNC_STROKE) {
        sanitized.u = clampInt(data.u, 0, 65535, 0);
        Object.assign(sanitized, sanitizeImageRect(data));
        sanitized.strokeTs = Number.isFinite(Number(data.strokeTs ?? data.stroke_ts)) ? Number(data.strokeTs ?? data.stroke_ts) : 0;
        sanitized.strokeRedo = sanitizeBoolean(data.strokeRedo ?? data.stroke_redo);
        sanitized.strokeRedoBatch = clampInt(data.strokeRedoBatch ?? data.stroke_redo_batch, 0, 10000, 0);
        sanitized.a = sanitizeBoolean(data.a);
      }

      const syncValidation = await validateImageBytes(data.img, {
        maxBytes: MAX_SYNC_IMAGE_BYTES,
        maxWidth: MAX_INLINE_IMAGE_WIDTH,
        maxHeight: MAX_INLINE_IMAGE_HEIGHT,
        maxPixels: MAX_SYNC_IMAGE_PIXELS,
        allowedMimeTypes: new Set(['image/png']),
        mimeTypeHint: 'image/png'
      });
      if (!syncValidation.ok) return null;
      sanitized.img = new Uint8Array(syncValidation.buffer);
      return sanitized;
    }

    case T.SYNC_METADATA:
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      sanitized.syncTotal = clampInt(data.syncTotal ?? data.sync_total, 0, 50000, 0);
      sanitized.boardWidth = clampInt(data.boardWidth ?? data.board_width, 0, MAX_COORD, 0);
      sanitized.boardHeight = clampInt(data.boardHeight ?? data.board_height, 0, MAX_COORD, 0);
      return sanitized;

    case T.SYNC_STROKE_BATCH:
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      sanitized.layerIdx = clampInt(data.layerIdx, 0, MAX_LAYER_INDEX, 0);
      if (!Array.isArray(data.strokes) || data.strokes.length === 0) return null;
      sanitized.strokes = data.strokes
        .slice(0, MAX_SYNC_BATCH_STROKES)
        .map(sanitizeStrokeRecord)
        .filter(Boolean);
      return sanitized.strokes.length ? sanitized : null;

    case T.SYNC_STROKES_DONE:
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      return sanitized;

    case T.SYNC_TILE_OWNERSHIP:
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      sanitized.tiles = sanitizeUintArray(data.tiles || data.dirtyTiles, { max: 1_000_000, maxLength: MAX_TILE_LIST });
      return sanitized;

    case T.CHAT_IMG:
    case T.STAFF_CHAT_IMG: {
      const imageValidation = await validateImageBytes(data.cimg, {
        maxBytes: MAX_CHAT_IMAGE_BYTES,
        maxWidth: 4096,
        maxHeight: 4096,
        maxPixels: 8_388_608,
        allowedMimeTypes: CHAT_IMAGE_MIME_TYPES
      });
      if (!imageValidation.ok) return null;
      sanitized.cimg = new Uint8Array(imageValidation.buffer);
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      if (!sanitized.chatMessageId) return null;
      if (hasOwnField(data, 'r')) sanitized.r = clampInt(data.r, 0, 65535, 0);
      return sanitized;
    }

    case T.BOARD_SNAPSHOT_SAVE: {
      const snapshotLayers = data.snapshotLayers ?? data.snapshot_layers;
      if (Array.isArray(snapshotLayers) && snapshotLayers.length > 0) {
        sanitized.snapshotLayers = snapshotLayers;
      } else {
        return null;
      }
      if (data.snapshotThumb && data.snapshotThumb.length > 0) {
        sanitized.snapshotThumb = data.snapshotThumb;
      }
      sanitized.a = sanitizeBoolean(data.a);
      sanitized.n = sanitizeString(data.n || '', MAX_NAME_LENGTH);
      // Applied-seq the capture represents (checkpoint timeline seq-stamp).
      sanitized.snapshotSeq = Math.max(0, Math.round(Number(data.snapshotSeq) || 0));
      // Optional flag used by local snapshot uploads to trigger an immediate
      // room-wide restore broadcast after persisting.
      sanitized.snapshotRestoreAfterSave = sanitizeBoolean(
        data.snapshotRestoreAfterSave ?? data.snapshot_restore_after_save
      );
      // "Set to current board" in Room Settings: pin this save as the room's
      // start state (owner/admin only — enforced in handleSnapshotSave).
      sanitized.snapshotPin = sanitizeBoolean(data.snapshotPin ?? data.snapshot_pin);
      return sanitized;
    }

    case T.ROOM_START_SNAPSHOT_GET:
      return sanitized;

    case T.ROOM_START_SNAPSHOT_SET:
      // Empty id is meaningful: with state 3 it clears the start state, with
      // anything else it goes back to following the newest snapshot. Neither
      // may return null.
      sanitized.snapshotId = sanitizeString(data.snapshotId, 64);
      sanitized.roomStartSnapshotState = clampInt(data.roomStartSnapshotState, 0, 3, 0);
      return sanitized;

    case T.BOARD_SNAPSHOT_LIST_REQUEST:
      if (data.snapshotTs !== undefined) {
        sanitized.snapshotTs = Math.max(0, Math.round(Number(data.snapshotTs) || 0));
      }
      return sanitized;

    case T.BOARD_SNAPSHOT_RESTORE: {
      sanitized.snapshotId = sanitizeString(data.snapshotId, 64);
      const snapshotLayers = data.snapshotLayers ?? data.snapshot_layers;
      if (Array.isArray(snapshotLayers) && snapshotLayers.length > 0) {
        sanitized.snapshotLayers = snapshotLayers;
      }
      if (!sanitized.snapshotId && !sanitized.snapshotLayers) return null;
      return sanitized;
    }

    case T.BOARD_SNAPSHOT_DELETE:
      sanitized.snapshotId = sanitizeString(data.snapshotId, 64);
      if (!sanitized.snapshotId) return null;
      return sanitized;

    case T.BOARD_SNAPSHOT_GET:
      sanitized.snapshotId = sanitizeString(data.snapshotId, 64);
      if (!sanitized.snapshotId) return null;
      sanitized.snapshotProbe = !!data.snapshotProbe;
      return sanitized;

    case T.BOARD_SNAPSHOT_REGION_RESTORE: {
      sanitized.snapshotId = sanitizeString(data.snapshotId, 64);
      const snapshotLayers = data.snapshotLayers ?? data.snapshot_layers;
      if (Array.isArray(snapshotLayers) && snapshotLayers.length > 0) {
        sanitized.snapshotLayers = snapshotLayers;
      }
      if (!sanitized.snapshotId && !sanitized.snapshotLayers) return null;
      sanitized.a = !!data.a;
      sanitized.sx = Math.round(data.sx) || 0;
      sanitized.sy = Math.round(data.sy) || 0;
      sanitized.sw = Math.round(data.sw) || 0;
      sanitized.sh = Math.round(data.sh) || 0;
      sanitized.cr = Array.isArray(data.cr) ? data.cr.map(Number).filter(isFinite) : [];
      return sanitized;
    }

    case T.CHECKPOINT_UPLOAD: {
      const cpValidation = await validateImageBytes(data.checkpointImg, {
        maxBytes: MAX_SYNC_IMAGE_BYTES,
        maxWidth: MAX_INLINE_IMAGE_WIDTH,
        maxHeight: MAX_INLINE_IMAGE_HEIGHT,
        maxPixels: MAX_SYNC_IMAGE_PIXELS,
        allowedMimeTypes: new Set(['image/png']),
        mimeTypeHint: 'image/png'
      });
      if (!cpValidation.ok) return null;
      sanitized.checkpointImg = new Uint8Array(cpValidation.buffer);
      return sanitized;
    }

    case T.CHECKPOINT_LIST:
      return sanitized;

    case T.CHECKPOINT_GET:
      sanitized.checkpointId = sanitizeString(data.checkpointId, 64);
      if (!sanitized.checkpointId) return null;
      return sanitized;

    case T.BW_PROBE_CHUNK: {
      sanitized.probeId = sanitizeString(data.probeId ?? data.probe_id, 64);
      sanitized.probeSeq = clampInt(data.probeSeq ?? data.probe_seq, 0, 1000, 0);
      let buf = data.probeData ?? data.probe_data;
      if (buf && typeof buf === 'object' && !Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) {
        buf = null;
      }
      // Cap per-chunk size at 128 KB
      if (!buf || buf.length > 131072) return null;
      sanitized.probeData = buf;
      return sanitized.probeId ? sanitized : null;
    }

    case T.BW_REPORT:
      sanitized.uploadBps = clampInt(data.uploadBps ?? data.upload_bps, 0, 1_000_000_000, 0);
      return sanitized;

    case T.REPLAY_REQUEST:
      sanitized.replayStartTs = Number(data.replayStartTs);
      sanitized.replayEndTs = Number(data.replayEndTs);
      if (!Number.isFinite(sanitized.replayStartTs) || !Number.isFinite(sanitized.replayEndTs)) return null;
      if (sanitized.replayEndTs <= sanitized.replayStartTs) return null;
      // Cap replay window to 1 hour
      if (sanitized.replayEndTs - sanitized.replayStartTs > 3_600_000) return null;
      return sanitized;

    case T.SYNC_PARITY_CHECK:
      sanitized.seq = Number(data.seq || 0);
      sanitized.parityCount = clampInt(data.parityCount, 0, 1_000_000, 0);
      sanitized.parityRollingHash = (Number(data.parityRollingHash) >>> 0);
      sanitized.parityPixelSnapshotSeq = Math.max(0, Math.round(Number(data.parityPixelSnapshotSeq) || 0));
      sanitized.parityPixelSnapshotId = sanitizeString(data.parityPixelSnapshotId, 64);
      sanitized.parityPixelTiles = sanitizeUintArray(data.parityPixelTiles, { max: 1_000_000, maxLength: 5000 });
      sanitized.parityPixelTileSize = clampInt(data.parityPixelTileSize, 1, 1024, 0);
      sanitized.parityPixelMadThresholdX100 = clampInt(data.parityPixelMadThresholdX100, 0, 25500, 0);
      sanitized.parityPixelMaxMadX100 = clampInt(data.parityPixelMaxMadX100, 0, 25500, 0);
      sanitized.parityPixelMeanMadX100 = clampInt(data.parityPixelMeanMadX100, 0, 25500, 0);
      sanitized.parityPixelTileCols = clampInt(data.parityPixelTileCols, 0, 10000, 0);
      return sanitized;

    case T.SYNC_PARITY_CHUNK_REQUEST:
      sanitized.parityChunkIndex = clampInt(data.parityChunkIndex, 0, 100_000, 0);
      return sanitized;

    case T.SYNC_PARITY_RESYNC_REQUEST: {
      const seqs = Array.isArray(data.parityResyncSeqs) ? data.parityResyncSeqs : [];
      // Cap to 500 seqs per request (matches server-side MAX_RESYNC_SEQS_PER_REQUEST)
      const trimmed = seqs.slice(0, 500).map((s) => Number(typeof s === 'object' && s !== null ? s.toString() : s)).filter(Number.isFinite);
      if (trimmed.length === 0) return null;
      sanitized.parityResyncSeqs = trimmed;
      return sanitized;
    }

    case T.SYNC_PARITY_MISMATCH_REPORT: {
      const id = sanitizeString(data.parityEventId, 64);
      if (!id) return null;
      sanitized.parityEventId = id;
      // Trust the proto-level shape of the entry arrays — we only cap length.
      const capArr = (arr) => Array.isArray(arr) ? arr.slice(0, 1000) : [];
      sanitized.parityMissing = capArr(data.parityMissing);
      sanitized.parityExtra = capArr(data.parityExtra);
      sanitized.parityMismatchedSeqs = capArr(data.parityMismatchedSeqs);
      sanitized.parityReportTruncated = !!data.parityReportTruncated;
      return sanitized;
    }
  }

  if (IMAGE_MESSAGE_TYPES.has(type)) {
    Object.assign(sanitized, sanitizeImageRect(data));
    if (type === T.GLITCH_RESULT) {
      if (data.ly !== undefined) {
        sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      }
      // The glitch stroke's draw-time blend travels with the result: it commits
      // asynchronously on receivers (after the PNG decodes), so the blend can't
      // be re-read from live user state at commit time. Mirror the CBM/MD blend
      // sanitization. Without copying these here the whitelist drops them, and
      // every receiver — live observer, replay recording, join catch-up tail —
      // falls back to stale live blend (glitch renders raw over white instead of
      // overlaying only existing pixels).
      if (data.bm !== undefined) sanitized.bm = sanitizeBlendMode(data.bm);
      if (data.bbm !== undefined) sanitized.bbm = sanitizeBlendBakeMode(data.bbm);
    }
    if (Array.isArray(data.cr)) {
      sanitized.cr = sanitizeFloatArray(data.cr, {
        requireEvenLength: true,
        maxLength: MAX_SELECTION_POINTS
      });
    }
    // All-layers flag (SEL_LIFT). The lift erased every visible layer and the
    // matching SEL_COMMIT will re-stamp every visible layer; `g` is the flattened
    // composite, so a receiver cannot infer the span from the payload.
    if (data.a !== undefined) sanitized.a = sanitizeBoolean(data.a);
    // Mirror state at lift time (SEL_LIFT): the lift also erased every mirrored
    // counterpart of the source area. Same reasoning as SEL_DELETE's `m`.
    if (data.m !== undefined) sanitized.m = sanitizeBoolean(data.m);
    // Extended-warp flag (SEL_LIFT). This whitelist is exhaustive, so a field
    // missing here is dropped no matter what the sender put on the wire.
    if (data.selExtendedWarp !== undefined) sanitized.selExtendedWarp = sanitizeBoolean(data.selExtendedWarp);

    // SEL_LIFT may legitimately omit `g`: the receiver's
    // RemoteSelectionHandler.handleSelectionLift falls back to
    // _populateLiftedSelectionFromLayer (its own copy of the active layer) when
    // no image payload accompanies the message. The post-sanitize handler in
    // index.js already gates on `if (data.g)`. IMG_PASTE and GLITCH_RESULT
    // genuinely cannot reconstruct content without `g`, so they stay strict.
    // Note: proto3 string fields default to "" when unset, so we check falsy
    // rather than `=== undefined`.
    if (type === T.SEL_LIFT && !data.g) {
      return sanitized;
    }

    const imageValidation = await validateDataUrlImage(data.g, {
      maxBytes: MAX_INLINE_IMAGE_BYTES,
      maxWidth: MAX_INLINE_IMAGE_WIDTH,
      maxHeight: MAX_INLINE_IMAGE_HEIGHT,
      maxPixels: MAX_INLINE_IMAGE_PIXELS,
      allowedMimeTypes: INLINE_IMAGE_MIME_TYPES,
      maxDataUrlLength: 3 * 1024 * 1024
    });
    if (!imageValidation.ok) return null;
    sanitized.g = data.g;
    return sanitized;
  }

  return sanitized;
}
