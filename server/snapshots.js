/** @fileoverview Handles board snapshot saving, listing, restoring, and deletion. */

import { getDB } from './db.js';
import { T } from '../shared/MessageTypes.js';
import { authorize, Action } from './permissions.js';
import { Role } from './SessionManager.js';
import { getRecorder } from './deltaRecorder.js';
import { uploadSnapshotFile, getSnapshotFile, deleteSnapshotFile } from './r2.js';
import { encodeSnapshotFile, decodeSnapshotFile } from './snapshotCodec.js';
import { snapshotCoversRoomBoard } from '../shared/qoi.js';

const DEFAULT_SNAPSHOT_MAX_PER_ROOM = 100;
const SNAPSHOT_LIST_PAGE_SIZE = 20;

/**
 * Truncate the room's parity/join window at a newly-minted checkpoint and move
 * the frames that retires into the room's history archive.
 *
 * The truncation itself is unchanged from what these three call sites did
 * before — `strokeLog` and `strokeTape` still collapse to the post-checkpoint
 * tail, which is what keeps the parity window in lockstep with every client's
 * own SYNC_CHECKPOINT_MINTED truncation. The only difference is that the frames
 * on their way out are handed to `room.history` instead of being freed, so a
 * later joiner can be backfilled with the last ~2 minutes of drawing they would
 * otherwise never see. Order matters: the log must be read before the tape is
 * truncated, and the anchor registered after the commits it supersedes are in.
 *
 * @param {Object} room
 * @param {number} baseSeq - The checkpoint's applied-seq watermark.
 * @param {{id: string, ts: number}} anchor - Identity of the checkpoint image,
 *   resolved against `room.snapshots` when the backfill is served.
 */
function archiveRetiredFrames(room, baseSeq, anchor) {
  const retiredCommits = room.strokeLog?.truncateBefore?.(baseSeq + 1) || [];
  const retiredPreambles = room.strokeTape?.truncateBefore?.(baseSeq + 1) || null;
  if (!room.history) return;
  room.history.archive(retiredCommits, retiredPreambles);
  room.history.addAnchor({ id: anchor?.id, seq: baseSeq, ts: anchor?.ts ?? Date.now() });
  room.history.prune();
}

function isSoloRoomOccupant(room) {
  return room?.getClientCount?.() === 1;
}

function canViewSnapshotHistory(ws, room) {
  return Number(ws?.userRole || 0) >= 1 || isSoloRoomOccupant(room);
}

function canLoadSnapshot(ws, room) {
  return authorize(ws, Action.MOD_MUTE, null) || isSoloRoomOccupant(room);
}

function canManualSaveSnapshot(ws, room) {
  return authorize(ws, Action.MOD_MUTE, null) || isSoloRoomOccupant(room);
}

function canRestoreWholeBoard(ws, room) {
  // Full-board restore is Trusted+, or a user alone in the room — with nobody
  // else's work on the shared board there is nothing to harm. Mirrors the
  // region-restore gate (canLoadSnapshot) and the client's "Undo to here"
  // visibility rule (state.svelte.js canUndoReplayHistory).
  return authorize(ws, Action.MOD_MUTE, null) || isSoloRoomOccupant(room);
}

/**
 * Who may change the room's start state (pin/unpin the snapshot an empty room
 * comes back up on). Deliberately the ROOM_UPDATE gate — owner or room ADMIN+ /
 * global HOLY+ — not the Trusted+ snapshot gate: this decides what everyone
 * walks into next time the room opens, which is a room-settings decision.
 * Mirrors getRoomAdminAuthority in server/index.js.
 */
function canManageStartState(ws, room) {
  if (room?.ownerId && room.ownerId === ws?.userId) return true;
  if (Number(ws?.roomRole || 0) >= Role.ADMIN) return true;
  return Number(ws?.globalRole || 0) >= Role.HOLY;
}

function sendRestorePermissionDenied(ws, room) {
  // The restore has no dedicated ack; a MOD_RESULT denial surfaces as a toast
  // client-side (AuthModHandlers 'mod_result'), so a refused restore is at
  // least visible instead of silently doing nothing.
  ws.send(room.Msg.encode(room.Msg.create({
    t: T.MOD_RESULT,
    a: false,
    authError: 'Only trusted users (or someone alone in the room) can restore the board'
  })).finish());
}

/**
 * Explain to one client why a "set the room start state" request could not be
 * honored, then repaint their panel with what the state actually is. Both
 * halves matter: the MOD_RESULT surfaces as a toast (AuthModHandlers
 * 'mod_result'), and the INFO reply releases the panel's pending state instead
 * of leaving the buttons disabled until their timeout.
 * @param {WebSocket} ws
 * @param {Room} room
 * @param {string} reason
 */
async function denyStartStateChange(ws, room, reason) {
  try {
    ws.send(room.Msg.encode(room.Msg.create({
      t: T.MOD_RESULT,
      a: false,
      authError: reason
    })).finish());
  } catch (err) {
    console.warn('[Snapshot] Failed to send start-state denial:', err);
  }
  await sendStartStateInfo(ws, room);
}

function getSnapshotMaxPerRoom() {
  const parsed = Number.parseInt(process.env.SNAPSHOT_MAX_PER_ROOM || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SNAPSHOT_MAX_PER_ROOM;
}

async function deleteSnapshotRecord(db, room, doc) {
  if (doc.r2Key) {
    await deleteSnapshotFile(doc.r2Key);
  }

  await db.collection('room_snapshots').deleteOne({ snapshotId: doc.snapshotId });
  room.snapshots = room.snapshots.filter(s => s.id !== doc.snapshotId);
}

async function pruneSnapshotsForRoom(db, room) {
  const maxSnapshots = getSnapshotMaxPerRoom();
  // The pinned start state is exempt from retention. Auto-saves land every 15s
  // in a busy room, so an unprotected pin would silently roll off the bottom of
  // the 100-snapshot window and the room would quietly fall back to its newest
  // snapshot instead of the one the owner chose.
  const pinnedId = room.settings?.startSnapshotId || null;

  const overflow = await db.collection('room_snapshots')
    .find({ roomId: room.id })
    .sort({ timestamp: -1 })
    .skip(maxSnapshots)
    .project({ snapshotId: 1, r2Key: 1 })
    .toArray();

  for (const doc of overflow) {
    if (pinnedId && doc.snapshotId === pinnedId) continue;
    await deleteSnapshotRecord(db, room, doc);
  }
}

/**
 * Removes the legacy embedded `snapshots` array from a room document.
 * Called once per snapshot save so old bloated rooms get cleaned up during normal usage.
 */
async function unsetLegacyEmbeddedSnapshots(db, roomId) {
  try {
    await db.collection('rooms').updateOne(
      { _id: roomId, snapshots: { $exists: true } },
      { $unset: { snapshots: '' } }
    );
  } catch (err) {
    console.warn(`[Snapshot] Failed to unset legacy embedded snapshots for room ${roomId}:`, err);
  }
}


/**
 * Looks up a snapshot metadata document by its snapshotId, scoped to the room.
 * @param {string} roomId
 * @param {string} snapshotId
 * @returns {Promise<Object|null>}
 */
async function findSnapshotDoc(roomId, snapshotId) {
  const db = getDB();
  if (!db) return null;
  return db.collection('room_snapshots').findOne({ roomId, snapshotId });
}

/**
 * Insert a blank "session start" checkpoint for a room if none exists yet.
 * Called before the first auto snapshot so deltas always have an anchor.
 * @param {string} roomId
 * @param {string} bgColor - e.g. '#ffffff'
 * @param {number} ts - room creation time
 */
async function maybeCreateInitialCheckpoint(roomId, bgColor, ts) {
  const db = getDB();
  if (!db) return;

  const existing = await db.collection('room_snapshots').findOne(
    { roomId, auto: true },
    { projection: { _id: 1 } }
  );
  if (existing) return;

  const id = `snap_initial_${roomId}`;
  await db.collection('room_snapshots').insertOne({
    snapshotId: id,
    roomId,
    timestamp: ts,
    issuer: 'server',
    auto: true,
    initial: true,
    bgColor,
    thumbnail: null,
    r2Key: null,
    name: 'Initial checkpoint'
  });
  getRecorder(roomId).onCheckpoint(id);
}

/**
 * Persist a full-board restore to DB/R2 as an authoritative auto-checkpoint.
 *
 * The in-memory re-baseline (room.addSnapshot + strokeLog.truncateBefore in
 * handleSnapshotRestore) makes a refresher get the restored board WHILE the
 * room stays populated, but the rolling buffer is RAM-only. Without persisting,
 * a joiner that falls back to DB/R2 (room emptied and reloaded, in-memory
 * checkpoint evicted, late join after restart) is served the STALE pre-restore
 * checkpoint — and because the live strokeLog was truncated past that older
 * seq, the gap can't be rebuilt, so the joiner desyncs (the pre-undo board
 * reappears / strokes layer back on top). Persisting the restored image at the
 * restore's seq keeps the DB join base in lockstep with the in-memory one.
 *
 * Best-effort: mirrors the auto-snapshot persistence in handleSnapshotSave and
 * never throws (a failed persist must not abort the live restore broadcast).
 *
 * @param {Object} room
 * @param {{ id: string, ts: number, issuer: string, layers: Array }} snapshotData
 * @param {number} seq - Server seq the restore was sequenced at (the new baseSeq).
 */
async function persistRestoredCheckpoint(room, snapshotData, seq) {
  const isProd = process.env.NODE_ENV === 'production';
  const allowDevSaves = process.env.ALLOW_DEV_SNAPSHOTS === 'true';
  if (!(isProd || allowDevSaves)) return;
  if (!room?.canPersistSnapshots?.()) return;
  const db = getDB();
  if (!db) return;
  if (!snapshotData?.id || !Array.isArray(snapshotData.layers) || snapshotData.layers.length === 0) return;

  try {
    await room.saveToDB();
    await maybeCreateInitialCheckpoint(
      room.id,
      room.settings?.backgroundColor || '#ffffff',
      room.createdAt
    );

    const r2Key = `snapshots/${room.id}/${snapshotData.id}.ddraw`;
    const fileBytes = await encodeSnapshotFile(snapshotData.layers, null, {
      issuer: snapshotData.issuer,
      roomId: room.id,
      ts: snapshotData.ts,
    });
    await uploadSnapshotFile(r2Key, fileBytes);

    await db.collection('room_snapshots').insertOne({
      snapshotId: snapshotData.id,
      roomId: room.id,
      timestamp: snapshotData.ts,
      issuer: snapshotData.issuer,
      auto: true,            // a join-checkpoint base, like an auto-snapshot
      seq: seq,
      thumbnail: null,
      r2Key: r2Key,
      format: 'ddraw',
      name: `Board restore ${new Date(snapshotData.ts).toLocaleTimeString()}`
    });
    await unsetLegacyEmbeddedSnapshots(db, room.id);
    await pruneSnapshotsForRoom(db, room);
    getRecorder(room.id).onCheckpoint(snapshotData.id);
    console.log(`[Snapshot] Persisted full-board restore ${snapshotData.id} @ seq ${seq} for room "${room.id}"`);
  } catch (err) {
    console.error(`[Snapshot] Failed to persist restore checkpoint for room "${room.id}":`, err);
  }
}

export async function handleSnapshotSave(ws, data, room) {

  // Only allow saving if in production or specifically enabled for dev
  const isProd = process.env.NODE_ENV === 'production';
  const allowDevSaves = process.env.ALLOW_DEV_SNAPSHOTS === 'true';

  // Manual saves and auto-saves still go to in-memory buffer regardless of DB
  // but we skip the expensive DB/R2 part if not authorized OR the room is
  // unregistered/ephemeral (canPersistSnapshots() — see handleSnapshotSave's
  // pin gate above for why pinning alone is denied earlier and harder).
  const shouldPersist = (isProd || allowDevSaves) && !!room?.canPersistSnapshots?.();

  // Server-initiated auto-snapshots: any user who was explicitly asked may respond.
  // Manual saves require Trusted+ unless the user is alone in the room.
  const isServerRequested = room?.clearPendingSnapshotRequest
    ? room.clearPendingSnapshotRequest(ws.sessionIndex)
    : room?._pendingSnapshotRequests?.has(ws.sessionIndex);

  // A pin is a deliberate button press, not a background auto-save: every path
  // that drops the save has to say so, or "Set to current board" looks broken.
  const wantsPin = !!data.snapshotPin && !data.a;

  if (isServerRequested) {
    room._pendingSnapshotRequests?.delete(ws.sessionIndex);
  } else if (!canManualSaveSnapshot(ws, room)) {
    if (wantsPin) await denyStartStateChange(ws, room, 'You do not have permission to save a board snapshot here');
    return;
  }
  // Pinning a room start state is a DB-backed feature and stays registered-only.
  // A plain (auto or manual) save is NOT returned here for an unregistered room:
  // it still needs to reach room.addSnapshot() below so the in-memory join/
  // resync watermark advances — otherwise an ephemeral room's command-log tail
  // never gets a checkpoint to bound it. The DB/R2 block further down is what
  // actually gates on canPersistSnapshots().
  if (wantsPin && !room?.canPersistSnapshots?.()) {
    await denyStartStateChange(ws, room, 'This room is unregistered, so it cannot keep a saved board state');
    return;
  }
  if (wantsPin && !canManageStartState(ws, room)) {
    await denyStartStateChange(ws, room, 'Only the room owner or an admin can set the room start state');
    return;
  }

  const db = getDB();
  const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const snapshotTs = Date.now();
  const issuer = ws.username || 'Unknown';

  // Layers are expected as QOI bytes from client, thumb as JPEG bytes.
  const layers = data.snapshotLayers || [];
  const thumbBytes = data.snapshotThumb || null; // JPEG bytes
  const isAuto = !!data.a;
  // Whether the pin request below produced a reply; a pin that could not be
  // applied (no DB, dev without ALLOW_DEV_SNAPSHOTS) still owes the requester
  // an answer, or the Room Settings panel sits on its pending state.
  let pinAnswered = false;

  // Applied-seq the capture represents (seq-stamp for the checkpoint timeline).
  const checkpointSeq = Math.max(0, Math.round(Number(data.snapshotSeq) || 0));

  const snapshotInMemory = {
    id: snapshotId,
    ts: snapshotTs,
    issuer: issuer,
    layers: isAuto ? layers : [],
    thumb: thumbBytes,
    auto: isAuto,
    seq: checkpointSeq
  };

  // Add to in-memory rolling buffer for quick access/restore before DB/R2 operation
  room.addSnapshot(snapshotInMemory);

  // Auto-snapshots are the room's checkpoints: advance the shared baseSeq
  // watermark. The server truncates its fingerprint log before the checkpoint
  // seq, and every client does the same on SYNC_CHECKPOINT_MINTED, so the
  // compared parity window collapses to the post-checkpoint tail (bounds the log
  // and heals sub-checkpoint joiner gaps — both subsumed by the checkpoint image).
  if (isAuto && checkpointSeq > 0) {
    // Truncate only up to the seq of the snapshot a joiner would actually be
    // served — the highest-seq retained auto snapshot — and mint with THAT
    // snapshot's id/seq. Truncating to the just-received `checkpointSeq` directly
    // would, when a second client's lower-seq auto-save arrives after a higher-seq
    // one, advance the log base past the served image and lose the strokes in the
    // gap (Issue 6). The base snapshot just added above is included in the
    // selection, so `base.seq >= checkpointSeq` always.
    const base = room.getJoinCheckpointMeta?.() || { id: snapshotId, seq: checkpointSeq };
    const baseSeq = base.seq > 0 ? base.seq : checkpointSeq;
    // Truncation is also the only moment these frames are still whole, so it is
    // where the history archive is fed. Retention above is unchanged — the
    // retired frames are handed on rather than dropped. See server/RoomHistory.js.
    archiveRetiredFrames(room, baseSeq, { id: base.id || snapshotId, ts: snapshotTs });
    room.broadcastToAll({
      t: T.SYNC_CHECKPOINT_MINTED,
      snapshotId: base.id || snapshotId,
      snapshotSeq: baseSeq
    });
  }

  if (db && shouldPersist) {
    try {
      // Snapshot metadata now lives inside the room document. Ensure the room
      // exists in Mongo before we push snapshot metadata, especially for lobby.
      await room.saveToDB();

      // Handle initial checkpointing for auto snapshots
      if (isAuto) {
        await maybeCreateInitialCheckpoint(
          room.id,
          room.settings.backgroundColor || '#ffffff',
          room.createdAt
        );
      }

      // Prepare data for R2 and MongoDB
      const r2Key = `snapshots/${room.id}/${snapshotId}.ddraw`;

      // Upload snapshot file to R2
      const fileBytes = await encodeSnapshotFile(layers, thumbBytes, {
        issuer,
        roomId: room.id,
        ts: snapshotTs,
      });
      await uploadSnapshotFile(r2Key, fileBytes);

      const mongoDoc = {
        snapshotId: snapshotId,
        timestamp: snapshotTs,
        issuer: issuer,
        auto: isAuto,
        seq: checkpointSeq,
        thumbnail: thumbBytes,
        r2Key: r2Key,
        format: 'ddraw',
        name: data.n || (isAuto ? `Auto-save ${new Date(snapshotTs).toLocaleTimeString()}` : `Snapshot ${new Date(snapshotTs).toLocaleString()}`)
      };

      // Include mirror region settings with manual snapshots so full restore can match room state.
      if (!isAuto) {
        const mirrorRegions = room.settings?.mirrorRegions || [];
        if (mirrorRegions.length > 0) {
          mongoDoc.mirrorRegions = mirrorRegions;
        }
      }

      await db.collection('room_snapshots').insertOne({
        ...mongoDoc,
        roomId: room.id
      });
      await unsetLegacyEmbeddedSnapshots(db, room.id);
      await pruneSnapshotsForRoom(db, room);

      if (isAuto) {
        getRecorder(room.id).onCheckpoint(snapshotId);
      }

      // "Set to current board" in Room Settings: one manual save that also
      // becomes the room's pinned start state. Done here rather than as a
      // follow-up ROOM_START_SNAPSHOT_SET so the client never has to learn the
      // generated snapshot id, and a half-applied pin is impossible.
      if (wantsPin) {
        room.settings.startSnapshotId = snapshotId;
        room.settings.startSnapshotClearedTs = 0;
        await room.saveToDB();
        pinAnswered = true;
        await sendStartStateInfo(ws, room);
      }

    } catch (err) {
      console.error(`[Snapshot] Failed to save snapshot ${snapshotId} for room ${room.id}:`, err);
      throw err;
    }
  }

  if (wantsPin && !pinAnswered) {
    // Reached when the save never touched the DB: no Mongo, or a dev server
    // without ALLOW_DEV_SNAPSHOTS (NODE_ENV !== 'production'), where snapshot
    // persistence is off by design. The board was captured fine — there is just
    // nowhere to keep it, so the room's start state is unchanged.
    await denyStartStateChange(
      ws,
      room,
      shouldPersist
        ? 'Snapshot storage is unavailable, so the room start state was not changed'
        : 'This server has snapshot saving disabled (set ALLOW_DEV_SNAPSHOTS=true for local dev)'
    );
  }

  // If client requested an immediate restore broadcast (used when uploading a
  // local snapshot to share with the room), broadcast the restore now using
  // the layers we just received. This mirrors handleSnapshotRestore's broadcast.
  if (data.snapshotRestoreAfterSave && layers && layers.length > 0 && canRestoreWholeBoard(ws)) {
    // Sequenced broadcast (Bug A) — see handleSnapshotRestore.
    const broadcastRestore = room.broadcastSequencedRestore
      ? room.broadcastSequencedRestore.bind(room)
      : room.broadcastToAll.bind(room);
    const restoreSeq = Number(broadcastRestore({
      t: T.BOARD_SNAPSHOT_RESTORE,
      snapshotLayers: layers,
      snapshotId: snapshotId,
      snapshotTs: snapshotTs,
      snapshotIssuer: issuer
    })) || 0;

    if (snapshotCoversRoomBoard(layers, room)) {
      room.clearAllTiles();

      // Re-baseline join sync against the shared restore, identical to
      // handleSnapshotRestore. The manual snapshot pushed earlier in this
      // function carries empty layers (in-memory manual saves don't), so it is
      // NOT a usable join base — without re-baselining here, a joiner/refresher
      // re-syncs from the stale pre-restore checkpoint + the full command tail
      // and double-renders the original board. Register the restored image as
      // the in-memory join checkpoint, truncate the tail past it, and persist
      // it as the authoritative DB/R2 base (matches handleSnapshotRestore).
      if (restoreSeq > 0) {
        const restoreSnapshot = {
          id: `restore_${Date.now()}`,
          ts: snapshotTs,
          issuer: issuer,
          layers: layers,
        };
        room.addSnapshot?.({ ...restoreSnapshot, seq: restoreSeq, auto: true });
        archiveRetiredFrames(room, restoreSeq, { id: restoreSnapshot.id, ts: restoreSnapshot.ts });
        room.joinCheckpointInvalidated = false;
        await persistRestoredCheckpoint(room, restoreSnapshot, restoreSeq);
      }
    }
  }
}

/**
 * Handles requesting the list of snapshots.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotList(ws, data, room) {
  if (!canViewSnapshotHistory(ws, room)) return;
  const db = getDB();
  let dbSnapshots = [];
  const beforeTs = Number(data?.snapshotTs || 0);

  if (db) {
    try {
      const filter = { roomId: room.id };
      if (beforeTs) filter.timestamp = { $lt: beforeTs };

      dbSnapshots = await db.collection('room_snapshots')
        .find(filter)
        .sort({ timestamp: -1 })
        .limit(SNAPSHOT_LIST_PAGE_SIZE)
        .toArray();
    } catch (err) {
      console.error('[Snapshot] DB list error:', err);
    }
  }

  const list = dbSnapshots.map(s => ({
    id: s.snapshotId,
    ts: s.timestamp,
    issuer: s.issuer,
    auto: s.auto,
    thumb: s.thumbnail ? (s.thumbnail.buffer || s.thumbnail) : null,
    name: s.name || (s.auto ? `Auto-save ${new Date(s.timestamp).toLocaleTimeString()}` : `Saved ${new Date(s.timestamp).toLocaleString()}`)
  }));

  // De-dupe by ID (in-memory and DB may overlap) and sort by TS
  const uniqueList = Array.from(new Map(list.map(s => [s.id, s])).values())
    .sort((a, b) => b.ts - a.ts);

  room.sendTo(ws, {
    t: T.BOARD_SNAPSHOT_LIST_RESPONSE,
    snapshotList: uniqueList
  });
}

/**
 * Handles restoring a board snapshot.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Object} data - The message payload.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotRestore(ws, data, room) {
  if (!canRestoreWholeBoard(ws, room)) {
    sendRestorePermissionDenied(ws, room);
    return;
  }

  const snapshotId = data.snapshotId;
  let snapshotData = null;

  if (Array.isArray(data.snapshotLayers) && data.snapshotLayers.length > 0) {
    snapshotData = {
      id: snapshotId || `restore_${Date.now()}`,
      ts: Date.now(),
      issuer: ws.username || 'Unknown',
      layers: data.snapshotLayers
    };
  }

  // 1. Check in-memory buffer first for very recent/auto snapshots
  let snapshotInMemory = !snapshotData && room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotData = {
      id: snapshotInMemory.id,
      ts: snapshotInMemory.ts,
      issuer: snapshotInMemory.issuer,
      layers: snapshotInMemory.layers
    };
  } else if (!snapshotData) {
    if (!snapshotId) {
      console.warn(`[Snapshot] Restore failed: no snapshotId or direct layer payload for room "${room.id}".`);
      return;
    }
    // 2. Fetch from the room_snapshots collection and then R2
    try {
      const doc = await findSnapshotDoc(room.id, snapshotId);

      if (!doc) {
        console.warn(`[Snapshot] Restore failed: Snapshot ${snapshotId} not found in room "${room.id}".`);
        return;
      }

      if (doc.r2Key) {
        const fileBytes = await getSnapshotFile(doc.r2Key);
        if (!fileBytes) {
          console.warn(`[Snapshot] Restore failed: Snapshot file not found in R2 for key ${doc.r2Key}.`);
          return;
        }
        const bundle = await decodeSnapshotFile(fileBytes, doc.format);
        snapshotData = {
          id: doc.snapshotId,
          ts: doc.timestamp,
          issuer: doc.issuer,
          layers: bundle.layers
        };
      }
    } catch (err) {
      console.error(`[Snapshot] DB/R2 fetch error during restore for ${snapshotId}:`, err);
      return;
    }
  }

  if (!snapshotData || !snapshotData.layers) {
    console.warn(`[Snapshot] Restore failed: Snapshot ${snapshotId} data could not be loaded.`);
    return;
  }

  // Sequenced broadcast: the restore is assigned a server seq and ordered
  // against the MU stream so every client applies it at the same z-point
  // (Bug A). Fall back to the legacy immediate broadcast if the sequenced
  // broadcaster hasn't been wired (e.g. very early in a room's life).
  const broadcastRestore = room.broadcastSequencedRestore
    ? room.broadcastSequencedRestore.bind(room)
    : room.broadcastToAll.bind(room);
  const restoreSeq = Number(broadcastRestore({
    t: T.BOARD_SNAPSHOT_RESTORE,
    snapshotLayers: snapshotData.layers,
    snapshotId: snapshotData.id,
    snapshotTs: snapshotData.ts,
    snapshotIssuer: snapshotData.issuer
  })) || 0;

  if (snapshotCoversRoomBoard(snapshotData.layers, room)) {
    room.clearAllTiles();

    // Re-baseline join sync. The restore is the authoritative full board as of
    // restoreSeq, so register it as the in-memory join checkpoint and truncate
    // the command tail (incl. the restore commit itself) up to and including it.
    // Without this, the stale pre-restore auto-snapshot stays the join base AND
    // the pre-restore strokes stay in the tail — a joiner then renders the
    // original board from the checkpoint image AND the same strokes replayed
    // from the tail, double-drawing at ~2x opacity once a later checkpoint
    // advances past the restore. Mirrors the SYNC_CHECKPOINT_MINTED truncation.
    if (restoreSeq > 0) {
      room.addSnapshot?.({
        id: snapshotData.id,
        ts: snapshotData.ts,
        issuer: snapshotData.issuer,
        layers: snapshotData.layers,
        seq: restoreSeq,
        auto: true,
      });
      archiveRetiredFrames(room, restoreSeq, { id: snapshotData.id, ts: snapshotData.ts });
      // We now hold a fresh, valid in-memory base, so undo any prior "skip the
      // persisted checkpoint" invalidation from a blank/lone-join session.
      room.joinCheckpointInvalidated = false;

      // Persist the restored board as the authoritative DB/R2 checkpoint too.
      // The in-memory re-baseline above only serves refreshers while the room
      // stays populated; without this, a joiner that falls back to DB (room
      // emptied/reloaded, in-memory checkpoint evicted) gets the stale
      // pre-restore checkpoint while the truncated log can't rebuild the gap —
      // the desync after a full-board undo + refresh. Best-effort, never throws.
      await persistRestoredCheckpoint(room, snapshotData, restoreSeq);
    }
  }
}

/**
 * Handles a private request to fetch one snapshot's layer data (not broadcast).
 * Used by the HistoryPanel to show a preview and apply region-based restores.
 * @param {WebSocket} ws
 * @param {Object} data - { snapshotId: string }
 * @param {Room} room
 */
export async function handleSnapshotGet(ws, data, room) {
  const snapshotId = data.snapshotId;
  const isProbeFetch = !!data.snapshotProbe;
  let snapshotData = null;
  let snapshotIsAuto = false;

  if (!isProbeFetch && !canViewSnapshotHistory(ws, room)) return;

  // 1. Check in-memory buffer first
  let snapshotInMemory = room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotIsAuto = !!snapshotInMemory.auto;
    snapshotData = {
      id: snapshotInMemory.id,
      ts: snapshotInMemory.ts,
      issuer: snapshotInMemory.issuer,
      layers: snapshotInMemory.layers,
      thumb: snapshotInMemory.thumb,
      seq: snapshotInMemory.seq || 0
    };
  } else if (!snapshotData) {
    // 2. Fetch from the room_snapshots collection and then R2
    try {
      const doc = await findSnapshotDoc(room.id, snapshotId);

      if (!doc) {
        console.warn(`[Snapshot] Get failed: Snapshot ${snapshotId} not found in room "${room.id}".`);
        return;
      }

      if (doc.r2Key) {
        snapshotIsAuto = !!doc.auto;
        const fileBytes = await getSnapshotFile(doc.r2Key);
        if (!fileBytes) {
          console.warn(`[Snapshot] Get failed: Snapshot file not found in R2 for key ${doc.r2Key}.`);
          return;
        }
        const bundle = await decodeSnapshotFile(fileBytes, doc.format);
        snapshotData = {
          id: doc.snapshotId,
          ts: doc.timestamp,
          issuer: doc.issuer,
          layers: bundle.layers,
          thumb: bundle.thumbnail,
          seq: doc.seq || 0
        };
      }
    } catch (err) {
      console.error(`[Snapshot] DB/R2 fetch error during get for ${snapshotId}:`, err);
      return;
    }
  }

  if (isProbeFetch) {
    // Pixel-parity diagnostics may fetch only auto-checkpoints; this avoids
    // opening the full manual history surface to unregistered clients.
    if (!snapshotIsAuto) return;
  }

  if (!snapshotData || !snapshotData.layers) {
    console.warn(`[Snapshot] Get failed: Snapshot ${snapshotId} data could not be loaded.`);
    return;
  }

  room.sendTo(ws, {
    t: T.BOARD_SNAPSHOT_SAVE,
    snapshotId: snapshotData.id,
    snapshotTs: snapshotData.ts,
    snapshotIssuer: snapshotData.issuer,
    snapshotLayers: snapshotData.layers,
    snapshotThumb: snapshotData.thumb,
    snapshotSeq: snapshotData.seq || 0,
    snapshotProbe: isProbeFetch
  });
}

/**
 * Handles restoring a region from a snapshot and broadcasting it to all clients.
 * @param {WebSocket} ws
 * @param {Object} data - { snapshotId, a (isLasso), sx, sy, sw, sh, cr }
 * @param {Room} room
 */
export async function handleSnapshotRegionRestore(ws, data, room) {
  if (!canLoadSnapshot(ws, room)) { // Trusted+ only unless user is alone in the room
    sendRestorePermissionDenied(ws, room);
    return;
  }

  const snapshotId = data.snapshotId;
  let snapshotData = null;

  if (Array.isArray(data.snapshotLayers) && data.snapshotLayers.length > 0) {
    snapshotData = {
      id: snapshotId || `region_restore_${Date.now()}`,
      layers: data.snapshotLayers
    };
  }

  // 1. Check in-memory buffer
  let snapshotInMemory = !snapshotData && room.snapshots.find(s => s.id === snapshotId);

  if (snapshotInMemory && snapshotInMemory.layers && snapshotInMemory.layers.length > 0) {
    snapshotData = {
      id: snapshotInMemory.id,
      layers: snapshotInMemory.layers
    };
  } else if (!snapshotData) {
    if (!snapshotId) {
      console.warn(`[Snapshot] Region restore failed: no snapshotId or direct layer payload for room "${room.id}".`);
      return;
    }
    // 2. Fetch from the room_snapshots collection and then R2
    try {
      const doc = await findSnapshotDoc(room.id, snapshotId);

      if (!doc) {
        console.warn(`[Snapshot] Region restore failed: Snapshot ${snapshotId} not found in room "${room.id}".`);
        return;
      }

      if (doc.r2Key) {
        const fileBytes = await getSnapshotFile(doc.r2Key);
        if (!fileBytes) {
          console.warn(`[Snapshot] Region restore failed: Snapshot file not found in R2 for key ${doc.r2Key}.`);
          return;
        }
        const bundle = await decodeSnapshotFile(fileBytes, doc.format);
        snapshotData = {
          id: doc.snapshotId,
          layers: bundle.layers
        };
      }
    } catch (err) {
      console.error(`[Snapshot] DB/R2 fetch error during region restore for ${snapshotId}:`, err);
      return;
    }
  }

  if (!snapshotData || !snapshotData.layers) {
    console.warn(`[Snapshot] Region restore failed: Snapshot ${snapshotId} data could not be loaded.`);
    return;
  }

  room.broadcastToAll({
    t: T.BOARD_SNAPSHOT_REGION_RESTORE,
    snapshotId: snapshotData.id,
    snapshotLayers: snapshotData.layers,
    a: !!data.a,
    sx: data.sx || 0,
    sy: data.sy || 0,
    sw: data.sw || 0,
    sh: data.sh || 0,
    cr: data.cr || []
  });
}

/**
 * Handles deleting a board snapshot.
 * @param {WebSocket} ws - The requester's WebSocket.
 * @param {Object} data - The message payload.
 * @param {Room} room - The room instance.
 */
export async function handleSnapshotDelete(ws, data, room) {
  if (!authorize(ws, Action.MOD_MUTE, null)) return; // Trusted+ only

  const snapshotId = data.snapshotId;

  const db = getDB();
  if (db) {
    try {
      const doc = await findSnapshotDoc(room.id, snapshotId);
      if (doc) {
        await deleteSnapshotRecord(db, room, doc);
      }
    } catch (err) {
      console.error(`[Snapshot Delete] Error deleting snapshot ${snapshotId}:`, err);
    }
  }

  room.snapshots = room.snapshots.filter(s => s.id !== snapshotId);

  // A pin pointing at a deleted image would silently fall back to the newest
  // snapshot on the next session; clear it so the setting reflects reality.
  if (room.settings?.startSnapshotId === snapshotId) {
    room.settings.startSnapshotId = null;
    await room.saveToDB();
  }
}

/**
 * Describe the snapshot a re-opening room would come back up on, and how it was
 * chosen. Mirrors Room._adoptPersistedBase: a pin wins, then the clear
 * watermark, then the room's newest persisted snapshot.
 *
 * @param {Room} room
 * @returns {Promise<{state: number, doc: Object|null}>}
 *   state: 0 nothing saved, 1 newest snapshot, 2 pinned, 3 cleared (opens blank)
 */
async function resolveStartStateDoc(room) {
  const db = getDB();
  if (!db || !room?.canPersistSnapshots?.()) return { state: 0, doc: null };

  const pinnedId = room.settings?.startSnapshotId || null;
  if (pinnedId) {
    const doc = await db.collection('room_snapshots').findOne({ roomId: room.id, snapshotId: pinnedId });
    // A pin whose image is gone is reported as no pin at all — the room would
    // fall back to its newest snapshot, so that is what the panel should show.
    if (doc && doc.r2Key) return { state: 2, doc };
  }

  const latest = await db.collection('room_snapshots').findOne(
    { roomId: room.id, r2Key: { $ne: null } },
    { sort: { timestamp: -1 } }
  );

  // Cleared, and nothing newer has been saved since: the room opens blank. The
  // snapshot itself still exists (and still shows in history) — it is just not
  // what the room comes back up on.
  const clearedTs = Number(room.settings?.startSnapshotClearedTs) || 0;
  if (clearedTs && (!latest || Number(latest.timestamp || 0) <= clearedTs)) {
    return { state: 3, doc: null };
  }

  return latest ? { state: 1, doc: latest } : { state: 0, doc: null };
}

/**
 * Sends the room's current start state to one client as ROOM_START_SNAPSHOT_INFO.
 * The snapshot itself rides in `snapshotList` (0 or 1 entries) so it reuses the
 * existing SnapshotMeta shape — id/ts/issuer/name/auto/thumb.
 * @param {WebSocket} ws
 * @param {Room} room
 */
async function sendStartStateInfo(ws, room) {
  let resolved = { state: 0, doc: null };
  try {
    resolved = await resolveStartStateDoc(room);
  } catch (err) {
    console.error(`[Snapshot] Failed to resolve start state for room "${room.id}":`, err);
  }

  const doc = resolved.doc;
  room.sendTo(ws, {
    t: T.ROOM_START_SNAPSHOT_INFO,
    roomStartSnapshotState: resolved.state,
    snapshotList: doc ? [{
      id: doc.snapshotId,
      ts: doc.timestamp,
      issuer: doc.issuer || '',
      auto: !!doc.auto,
      thumb: doc.thumbnail ? (doc.thumbnail.buffer || doc.thumbnail) : null,
      name: doc.name || (doc.auto ? `Auto-save ${new Date(doc.timestamp).toLocaleTimeString()}` : `Saved ${new Date(doc.timestamp).toLocaleString()}`)
    }] : []
  });
}

/**
 * ROOM_START_SNAPSHOT_GET: report the room's start state to the requester.
 * Read-only, so it uses the same gate as snapshot history rather than the
 * room-settings gate — the dialog is only shown to owners/admins anyway.
 * @param {WebSocket} ws
 * @param {Object} data
 * @param {Room} room
 */
export async function handleStartStateGet(ws, data, room) {
  if (!canViewSnapshotHistory(ws, room)) return;
  await sendStartStateInfo(ws, room);
}

/**
 * ROOM_START_SNAPSHOT_SET: choose what the room opens on. Three actions, keyed
 * off `roomStartSnapshotState` (the same tri-state field the INFO reply uses):
 *
 *   snapshotId set -> pin that snapshot
 *   state 3        -> clear: stamp the watermark so the room opens blank until
 *                     something newer is saved. Deletes nothing.
 *   anything else  -> follow the room's newest snapshot again (undoes both)
 *
 * Always answers with the resulting state so a refused or no-op change still
 * repaints the panel with the truth.
 * @param {WebSocket} ws
 * @param {Object} data - { snapshotId, roomStartSnapshotState }
 * @param {Room} room
 */
export async function handleStartStateSet(ws, data, room) {
  if (!canManageStartState(ws, room)) {
    ws.send(room.Msg.encode(room.Msg.create({
      t: T.MOD_RESULT,
      a: false,
      authError: 'Only the room owner or an admin can change the room start state'
    })).finish());
    return;
  }
  if (!room?.canPersistSnapshots?.()) {
    // Unregistered rooms keep no snapshots at all; answer anyway so the panel
    // repaints with the truth ("nothing saved") instead of hanging on pending.
    await sendStartStateInfo(ws, room);
    return;
  }

  const snapshotId = typeof data?.snapshotId === 'string' ? data.snapshotId : '';
  const requestedState = Number(data?.roomStartSnapshotState) || 0;

  if (snapshotId) {
    const doc = await findSnapshotDoc(room.id, snapshotId);
    if (!doc || !doc.r2Key) {
      await sendStartStateInfo(ws, room);
      return;
    }
    room.settings.startSnapshotId = snapshotId;
    room.settings.startSnapshotClearedTs = 0;
  } else if (requestedState === 3) {
    room.settings.startSnapshotId = null;
    room.settings.startSnapshotClearedTs = Date.now();
  } else {
    room.settings.startSnapshotId = null;
    room.settings.startSnapshotClearedTs = 0;
  }

  await room.saveToDB();
  await sendStartStateInfo(ws, room);
}

/**
 * Settle what the board looks like for a session that is just beginning.
 *
 * Runs once, when the first client connects to an otherwise empty room. With
 * the room's `loadSnapshotOnFirstJoin` setting on (the default) the room's last
 * persisted snapshot becomes this session's base, so the first user walks into
 * the board as it was left; with it off the session starts blank.
 *
 * This replaced an opt-in BOARD_SNAPSHOT_JOIN_NOTIFY toast that offered a
 * "Load server snapshot" button. The toast could only ever be offered to a
 * lone occupant, and by the time it was clicked someone else may have joined —
 * at which point the server's own gate (canRestoreWholeBoard) refused an
 * untrusted user's restore and the prompt turned into a permission error.
 * Deciding at join time removes both the prompt and that failure mode.
 *
 * @param {WebSocket} ws - The joining user's socket.
 * @param {Room} room - The room instance.
 */
export async function handleFirstJoinerBase(ws, room) {
  if (!room || room.id === '_discovery' || room.id === 'default') {
    return;
  }

  // Only the first client of a session decides the base. With others already
  // present the board is whatever they're drawing on, and the joiner syncs to
  // it through the normal checkpoint + tail path.
  const clientCount = typeof room.getClientCount === 'function' ? room.getClientCount() : 1;
  if (clientCount !== 1) return;

  await room.beginSessionBase?.();
}
