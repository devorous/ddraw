/** @fileoverview Records drawing-relevant protobuf deltas for replay, linked to checkpoints. */

import { getDB } from './db.js';
import { T } from '../shared/MessageTypes.js';
import { ENABLE_SERVER_REPLAY_DB } from './replayConfig.js';

const COLLECTION = 'replay_deltas';
const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER_SIZE = 500;
const MAX_DELTAS_PER_CHECKPOINT = 100_000; // Safety cap
const NULL_RECORDER = Object.freeze({
  record() {},
  onCheckpoint() {},
  destroy() {}
});

/** Message types that are meaningful for replay */
const REPLAY_TYPES = new Set([
  T.MD, T.MM, T.MU,
  T.CT, T.CC, T.CS, T.CP, T.CSP, T.CSM, T.CHD, T.CTHN, T.CSIM, T.CPT,
  T.CBM, T.CL, T.CBR, T.CPM, T.CSDM,
  T.MIR, T.MIRROR_REGION, T.CLR, T.CANCEL,
  T.KP, T.TEXT_APPLY, T.TEXT_REMOVE, T.FILL,
  T.GMP, T.GPT, T.GLITCH_RESULT,
  T.SEL_LIFT, T.SEL_PENDING, T.SEL_MOVE, T.SEL_COMMIT,
  T.SEL_DELETE, T.SEL_FILL, T.SEL_STAMP, T.SEL_FLIP, T.SEL_CANCEL, T.SEL_TO_BRUSH,
  T.IMG_PASTE,
  T.UNDO, T.REDO
]);

/**
 * Per-room delta recorder that buffers deltas in memory and flushes to DB periodically.
 */
class RoomDeltaRecorder {
  constructor(roomId) {
    this.roomId = roomId;
    this.buffer = [];
    this.currentCheckpointId = null;
    this._flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /**
   * Record a message if it's replay-relevant.
   * @param {Object} data - The sanitized message (already includes `u` session index from broadcast).
   */
  record(data) {
    if (!REPLAY_TYPES.has(data.t)) return;

    // Strip the img field from large messages to save space — the checkpoint has the visual state.
    // Keep img for SEL_LIFT, IMG_PASTE, GLITCH_RESULT since they contain essential image data.
    const entry = { ...data, _ts: Date.now() };
    if (entry.img && data.t !== T.SEL_LIFT && data.t !== T.IMG_PASTE && data.t !== T.GLITCH_RESULT) {
      delete entry.img;
    }

    this.buffer.push(entry);

    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.flush();
    }
  }

  /**
   * Called when a new checkpoint is created — links subsequent deltas to it.
   * @param {string} checkpointId
   */
  onCheckpoint(checkpointId) {
    // Flush any remaining deltas from the previous checkpoint window
    this.flush();
    this.currentCheckpointId = checkpointId;
  }

  /**
   * Flush buffered deltas to the database.
   */
  async flush() {
    if (this.buffer.length === 0) return;

    const db = getDB();
    if (!db) {
      this.buffer = [];
      return;
    }

    const batch = this.buffer;
    this.buffer = [];

    try {
      await db.collection(COLLECTION).insertOne({
        roomId: this.roomId,
        checkpointId: this.currentCheckpointId,
        startTs: batch[0]._ts,
        endTs: batch[batch.length - 1]._ts,
        count: batch.length,
        deltas: batch
      });
    } catch (err) {
      console.error(`[DeltaRecorder] Flush error for room "${this.roomId}":`, err);
    }
  }

  destroy() {
    clearInterval(this._flushTimer);
    this.flush();
  }
}

/** Map of roomId -> RoomDeltaRecorder */
const recorders = new Map();

/**
 * Get or create a delta recorder for a room.
 * @param {string} roomId
 * @returns {RoomDeltaRecorder}
 */
export function getRecorder(roomId) {
  if (!ENABLE_SERVER_REPLAY_DB) {
    return NULL_RECORDER;
  }

  let recorder = recorders.get(roomId);
  if (!recorder) {
    recorder = new RoomDeltaRecorder(roomId);
    recorders.set(roomId, recorder);
  }
  return recorder;
}

/**
 * Remove and flush a room's recorder (e.g. when room empties).
 * @param {string} roomId
 */
export function removeRecorder(roomId) {
  if (!ENABLE_SERVER_REPLAY_DB) return;

  const recorder = recorders.get(roomId);
  if (recorder) {
    recorder.destroy();
    recorders.delete(roomId);
  }
}

/**
 * Query deltas for replay: find the nearest checkpoint before `startTs`,
 * return all deltas between that checkpoint and `endTs`.
 * @param {string} roomId
 * @param {number} startTs - Desired replay start timestamp
 * @param {number} endTs - Desired replay end timestamp
 * @returns {Promise<{checkpointId: string|null, deltas: Object[]}>}
 */
export async function getReplayData(roomId, startTs, endTs) {
  if (!ENABLE_SERVER_REPLAY_DB) {
    return { checkpointId: null, deltas: [] };
  }

  const db = getDB();
  if (!db) return { checkpointId: null, deltas: [] };

  try {
    // Find the most recent checkpoint before startTs
    const checkpoint = await db.collection('checkpoints')
      .find({ roomId, timestamp: { $lte: startTs } })
      .sort({ timestamp: -1 })
      .limit(1)
      .project({ checkpointId: 1, timestamp: 1 })
      .next();

    const checkpointId = checkpoint?.checkpointId || null;
    const checkpointTs = checkpoint?.timestamp || 0;

    // Fetch all delta batches that overlap the range [checkpointTs, endTs]
    const deltaBatches = await db.collection(COLLECTION)
      .find({
        roomId,
        endTs: { $gte: checkpointTs },
        startTs: { $lte: endTs }
      })
      .sort({ startTs: 1 })
      .toArray();

    // Flatten and filter to exact range
    const deltas = [];
    for (const batch of deltaBatches) {
      for (const delta of batch.deltas) {
        if (delta._ts >= checkpointTs && delta._ts <= endTs) {
          deltas.push(delta);
          if (deltas.length >= MAX_DELTAS_PER_CHECKPOINT) break;
        }
      }
      if (deltas.length >= MAX_DELTAS_PER_CHECKPOINT) break;
    }

    return { checkpointId, deltas };
  } catch (err) {
    console.error(`[DeltaRecorder] getReplayData error for room "${roomId}":`, err);
    return { checkpointId: null, deltas: [] };
  }
}
