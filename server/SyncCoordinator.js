/** @fileoverview Orchestrates the synchronization of canvas state between existing users and new joiners. */

import { WebSocket } from 'ws';
import { T } from '../shared/MessageTypes.js';
import { TapeFrameFilter } from './StrokeTape.js';
import { getBoardDimensionsForSize } from '../shared/boardSizes.js';

const ROOM_OVERLAY_SESSION_INDEX = 0xffffffff;

/** Grace period after SYNC_COMPLETE before history starts streaming. */
const HISTORY_BACKFILL_START_DELAY_MS = 1500;
/** Frames per HISTORY_BACKFILL_CHUNK. */
const HISTORY_BACKFILL_CHUNK_SIZE = 250;
/** Gap between chunks, so the backfill yields to live traffic. */
const HISTORY_BACKFILL_CHUNK_INTERVAL_MS = 60;
/** Abandon the backfill if the joiner's send buffer is this far behind. */
const HISTORY_BACKFILL_BACKPRESSURE_BYTES = 2 * 1024 * 1024;
/**
 * Hard ceiling on frames in one backfill.
 *
 * A checkpointing room self-limits: the archive prunes to a 2-minute horizon
 * and the live tail is only the seconds since the last checkpoint. A room that
 * never checkpoints (unregistered — Room.canPersistSnapshots wants an ownerId)
 * has no horizon at all, and its live tail grows to the fingerprint log's 10k
 * commit cap, whose preambles can be hundreds of thousands of frames. Serving
 * that would roughly double an already-expensive join.
 *
 * Over the ceiling we serve NOTHING rather than a prefix: the base image is the
 * session origin, so dropping the oldest frames would replay later strokes onto
 * a board missing the earlier ones — a hole in the history, which is worse than
 * no history.
 */
const HISTORY_BACKFILL_MAX_FRAMES = 60_000;

/**
 * Handles the multi-step canvas synchronization flow for new users.
 */
export class SyncCoordinator {
  /**
   * @param {SessionManager} sessionManager - The session manager instance.
   * @param {Object} wss - The WebSocket server or room client set.
   * @param {function} sendToCallback - Function to send messages to a specific client.
   * @param {Object} [room=null] - The room object (for accessing tile ownership).
   */
  constructor(sessionManager, wss, sendToCallback, room = null) {
    this.sessionManager = sessionManager;
    this.wss = wss;
    this.sendTo = sendToCallback;
    this.room = room;
  }

  /**
   * Handles a sync request from a new user with the checkpoint-based join:
   * serve the latest server checkpoint image (seq S) as the base, then replay
   * the post-checkpoint tail — for each committed stroke in (S, latest], its
   * geometry preamble (MD/MM + tool-state, from `room.strokeTape`) followed by
   * the commit's original wire bytes (from `room.strokeLog`). The joiner's
   * normal receive pipeline both draws the canvas AND seeds its fingerprint log
   * from this single source, so there is no image-vs-log divergence and no
   * live-peer provider election. Finishes with SYNC_COMPLETE.
   *
   * NOTE: this replaced the legacy provider-election flow (the SYNC_PROVIDE /
   * SYNC_CANVAS / LAYER_BASE / STROKE relay path), which has since been removed.
   *
   * @param {WebSocket} ws - The WebSocket of the requesting user.
   * @param {Object} _data - The sync request message data (provider hint ignored).
   */
  handleSyncRequest(ws, _data) {
    const requesterSessionIndex = Number(ws.sessionIndex);
    console.log(`[Sync] User ${requesterSessionIndex} requested checkpoint-based sync`);
    this._serveCheckpointJoin(ws, requesterSessionIndex).catch((err) => {
      console.error(`[Sync] Checkpoint join failed for ${requesterSessionIndex}:`, err);
      // Reopen live content broadcasts and never leave the joiner hanging on
      // the client-side idle timeout.
      ws.joinSyncPendingSince = null;
      if (ws.readyState === WebSocket.OPEN) this.sendTo(ws, { t: T.SYNC_COMPLETE });
    });
  }

  /**
   * Serves a checkpoint image + post-checkpoint command tail to a joiner, then
   * SYNC_COMPLETE. See handleSyncRequest for the rationale.
   * @param {WebSocket} ws
   * @param {number} requesterSessionIndex
   * @private
   */
  async _serveCheckpointJoin(ws, requesterSessionIndex) {
    if (ws.readyState !== WebSocket.OPEN) return;

    // (Re-)arm live content suppression for the duration of the serve. Fresh
    // joiners already carry the flag from room join; RESYNCS (AFK return,
    // manual resync) don't, and without this every commit broadcast between
    // here and the barrier below would reach the client both live and via the
    // tail. The client resets its board + event buffer when it issues the
    // request, so content sent before the request arrived is already discarded.
    ws.joinSyncPendingSince = Date.now();

    const log = this.room?.strokeLog;
    const tape = this.room?.strokeTape;
    let snapshot = null;

    // This session's base-board decision (blank vs. the room's last persisted
    // snapshot) was pinned when the first client connected — Room.beginSessionBase,
    // driven by the `loadSnapshotOnFirstJoin` room setting. Await it so a joiner
    // racing the async R2/DB fetch is served the same base as everyone else,
    // rather than deciding for itself mid-flight.
    await this.room?.beginSessionBase?.();
    if (ws.readyState !== WebSocket.OPEN) return;

    // With the setting OFF a lone joiner does NOT auto-apply the persisted
    // checkpoint: they start from the live command tail only — empty for a cold
    // room, i.e. a blank canvas. With peers present the checkpoint base is
    // always required: it's the permanent content (<= watermark) the replayed
    // tail builds on, so the joiner matches what everyone else renders.
    const clientCount = this.room?.getClientCount?.() ?? 1;
    const startsBlank = clientCount <= 1
      && this.room?.settings?.loadSnapshotOnFirstJoin === false;

    // 1. Latest checkpoint image as the base (carries the applied-seq watermark
    //    S). Absent (fresh room / no persistence / blank-start lone joiner) →
    //    baseSeq 0, replay full tail.
    let baseSeq = 0;
    if (startsBlank && this.room?.canPersistSnapshots?.()) {
      // Log whether a checkpoint actually existed, so solo-join verification can
      // distinguish "correctly skipped an existing checkpoint" from "none
      // existed" (Issue 4). hasInMemoryJoinCheckpoint() is the live rolling-buffer
      // view; a DB/R2-only checkpoint won't show here.
      const hadInMemoryCheckpoint = !!this.room.hasInMemoryJoinCheckpoint?.();
      this.room.invalidateJoinCheckpoint?.();
      console.log(`[Sync] Lone joiner ${requesterSessionIndex}: skipping persisted join checkpoint (in-memory checkpoint existed=${hadInMemoryCheckpoint}); starting from live command tail only`);
    } else if (this.room?.canPersistSnapshots?.()) {
      snapshot = await this.room.getLatestSnapshotData?.({ forJoin: true });
      if (ws.readyState !== WebSocket.OPEN) return;
      if (snapshot && Array.isArray(snapshot.layers) && snapshot.layers.length > 0) {
        baseSeq = Number(snapshot.seq) || 0;
        this.sendTo(ws, {
          t: T.BOARD_SNAPSHOT_RESTORE,
          snapshotLayers: snapshot.layers,
          snapshotId: snapshot.id,
          snapshotTs: snapshot.ts,
          snapshotIssuer: snapshot.issuer,
          snapshotSeq: baseSeq,
        });
        console.log(`[Sync] Served checkpoint ${snapshot.id} @ seq ${baseSeq} to ${requesterSessionIndex}`);

        // Invariant guard (Issue 6): the served image (<= baseSeq) plus the
        // surviving log tail (>= lowest retained seq) must jointly cover every
        // seq with no gap. If the log's earliest retained entry sits above
        // baseSeq+1, the strokes in between are in neither — surface it loudly
        // rather than losing pixels silently.
        //
        // Read this off what the log has actually DROPPED, not off its first
        // retained entry. The log records only commit types, while the server
        // allocates a seq for every broadcast — MM outnumbers commits by roughly
        // 68:1 — so `entries[0].seq` sits an arbitrary distance above baseSeq
        // simply because no commit happened in between. The old check
        // (`firstRetainedSeq > baseSeq + 1`) therefore fired on essentially
        // EVERY checkpoint-served join: measured 3 of 3 in one soak, reporting
        // "unrecoverable" gaps of 29 and 86 seqs that contained no commits at
        // all. It could only have gone green if a commit happened to land on the
        // very next seq after the checkpoint, which is not a thing that has to
        // be true. `droppedThroughSeq` is the real invariant: a commit above the
        // served image's watermark is gone from the tail, which is genuine loss
        // (cap overflow, or a truncation against a higher base than the snapshot
        // actually served — Issue 6).
        const droppedThrough = log?.droppedThroughSeq || 0;
        if (droppedThrough > baseSeq) {
          console.warn(`[Sync] CHECKPOINT GAP for ${requesterSessionIndex}: served seq ${baseSeq} but the `
            + `command log has dropped commits through seq ${droppedThrough} — commits in `
            + `(${baseSeq}, ${droppedThrough}] are in neither the image nor the tail`);
        }
      }
    }

    // ── Live-broadcast barrier ──
    // From room-join until here the server suppresses room CONTENT broadcasts
    // to this ws (index.js shouldSkipJoinSyncPending) so nothing committed
    // before the tail's latestSeq read reaches the joiner twice. Everything
    // from this line through the tail + pending-bundle sends is synchronous
    // (no awaits), so no broadcast can interleave: commits ≤ latestSeq arrive
    // only via the tail, commits after it only via live broadcast, and
    // in-flight stroke preambles (pendingBundles) precede their live MM/MU
    // continuation. Clearing the flag any later (e.g. at SYNC_COMPLETE after
    // another await) would reopen the duplicate window.
    ws.joinSyncPendingSince = null;

    // The whole serve is planned before the first byte goes out, because the
    // preamble frames a stroke actually needs depend on what the joiner has
    // already been sent (TapeFrameFilter, below) — and SYNC_METADATA's
    // syncTotal has to be the count that really follows, or the progress bar
    // never reaches the end.
    //
    // Image-tool payloads (brush/pattern/confetti bitmaps) ride in EVERY
    // stroke's preamble so each stroke replays with the brush it was drawn
    // with. The filter drops the ones the joiner is already holding, so a run
    // of strokes sharing a brush costs one copy, not one per stroke.
    const frameFilter = new TapeFrameFilter(tape);
    const latestSeqForMetadata = log?.getSummary?.().latestSeq || 0;
    const entriesForMetadata = latestSeqForMetadata > baseSeq && log
      ? log.getRange(baseSeq + 1, latestSeqForMetadata)
      : [];
    const checkpointMessageCount = snapshot && Array.isArray(snapshot.layers) && snapshot.layers.length > 0 ? 1 : 0;
    const tailPlan = entriesForMetadata.map((entry) => ({
      seq: entry.seq,
      frames: frameFilter.filter(entry.userId, tape?.getBundle(entry.seq)),
      bytes: log?.getBytes(entry.seq) || null,
    }));
    const tailMessageCount = tailPlan.reduce(
      (total, step) => total + step.frames.length + (step.bytes ? 1 : 0), 0);
    const tailImageFramesSkipped = frameFilter.skipped;
    // In-flight (uncommitted) strokes have no commit seq yet, so they're absent
    // from both the checkpoint and the strokeLog tail. Replay their preambles so
    // the joiner re-begins each active stroke with the right tool state.
    const pendingBundles = (tape?.getPendingBundles?.() || [])
      .map(({ userId, frames }) => ({ userId, frames: frameFilter.filter(userId, frames) }));
    const pendingMessageCount = pendingBundles.reduce((total, b) => total + b.frames.length, 0);
    // Latest tool state per user, re-sent at the end of the serve (see 2c).
    //
    // Never the REQUESTER's own. handleJoinAfterConnect() broadcasts the local
    // user's full tool-state set (smoothing/size/color/font/tool/shape mode/
    // spacing/hardness/blend/layer/thinning/simulate-pressure — one frame per
    // state key) the instant it joins, so by the time the sync request lands the
    // tape holds ~13 frames under our own userId and step 2c echoed every one of
    // them straight back at us. The joiner is the authority on its own tool
    // state: it never left `app.self`, requestSync()'s wipe doesn't touch it,
    // and _replayBufferInner explicitly saves and restores the local
    // image-tool keys across a rebuild to undo exactly this kind of echo.
    //
    // On a lone join to a cold room with loadSnapshotOnFirstJoin off — no
    // checkpoint, empty tail, no pending strokes — that self-echo WAS the whole
    // sync: a blank board arriving as a 13-step progress bar.
    const toolStateBundles = (tape?.getToolStateBundles?.() || [])
      .filter(({ userId }) => Number(userId) !== requesterSessionIndex)
      .map(({ userId, frames }) => ({ userId, frames: frameFilter.filter(userId, frames) }));
    const toolStateMessageCount = toolStateBundles.reduce((total, b) => total + b.frames.length, 0);
    const [boardHeight, boardWidth] = getBoardDimensionsForSize(this.room?.settings?.boardSize);
    this.sendTo(ws, {
      t: T.SYNC_METADATA,
      syncTotal: checkpointMessageCount + tailMessageCount + pendingMessageCount + toolStateMessageCount,
      boardWidth,
      boardHeight
    });

    // 1b. Active selection masks, BEFORE any replay.
    //
    // A mask clips a stroke at MD time (Board.applySelectionMaskClipForStroke,
    // called from RemoteUserHandler's mouse-down path), so it has to be in
    // place before the first replayed MD, not after the last one. This used to
    // sit down in step 3 with the floating selections, which meant the whole
    // tail — and, worse, step 2b's in-flight stroke preambles — were replayed
    // with no mask in scope. An in-flight stroke never recovers: its live
    // MM/MU continuation lands on a context that was never clipped, so the
    // joiner paints it outside the mask forever while every peer clips it.
    //
    // Masks in the tail itself travel as tool state (StrokeTape), so this is
    // ONLY the floor for masks set before the checkpoint — hence the baseSeq
    // gate. Sending the current mask unconditionally was the other half of the
    // bug: a mask armed inside the tail got pre-armed here and then clipped
    // every earlier stroke the tail replayed. Floating selections stay in
    // step 3: those are pixels that must sit ABOVE all committed content.
    this._sendActiveMasksToJoiner(ws, baseSeq);

    // 2. Replay the post-checkpoint command tail in seq order. Each commit may
    //    carry a geometry preamble (brush/pen strokes); self-contained commits
    //    (fill/selection/text) replay their bytes alone.
    if (log) {
      const latestSeq = latestSeqForMetadata;
      if (latestSeq > baseSeq) {
        let served = 0, missing = 0;
        for (const step of tailPlan) {
          if (ws.readyState !== WebSocket.OPEN) return;
          for (const frame of step.frames) this.sendTo(ws, frame);
          if (step.bytes) { this.sendTo(ws, step.bytes); served++; }
          else missing++;
        }
        const deduped = tailImageFramesSkipped ? `, ${tailImageFramesSkipped} repeated image frame(s) skipped` : '';
        console.log(`[Sync] Replayed tail (${baseSeq}, ${latestSeq}] to ${requesterSessionIndex}: ${served} commits${missing ? `, ${missing} evicted` : ''}${deduped}`);
      } else {
        // The other half of "blank board after resync": if the tail is empty the
        // requester's content had to come from the checkpoint image, and if that
        // is absent too there is nothing to serve and the fault is server-side.
        console.warn(`[Sync] EMPTY TAIL for ${requesterSessionIndex}: baseSeq=${baseSeq} latestSeq=${latestSeq} `
          + `checkpointServed=${!!(snapshot && snapshot.layers?.length)} logEntries=${log.getSummary?.().count ?? '?'}`);
      }
    }

    // 2b. Replay in-flight (uncommitted) stroke preambles so a user who is
    //     mid-stroke at join time is visible to the joiner with the correct
    //     tool state (blend mode, size, color). No commit follows — the live
    //     MM/MU continuation lands on this open stroke. Sent after the tail so
    //     the active stroke sits above all committed strokes, matching peers.
    if (pendingBundles.length > 0) {
      let pendingStrokes = 0;
      for (const { frames } of pendingBundles) {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const frame of frames) this.sendTo(ws, frame);
        pendingStrokes++;
      }
      console.log(`[Sync] Replayed ${pendingStrokes} in-flight stroke(s) to ${requesterSessionIndex}`);
    }

    // 2c. Re-send every user's LATEST tool state. A tool-state frame broadcast
    //     during this joiner's suppression window for a stroke that has not
    //     yet begun is in neither the tail nor a pending bundle — without this
    //     the joiner draws that user's next stroke with stale color/size/tool.
    //     Sent last so it wins over older tail/pending config; frames carry
    //     their original seqs and the client applies tool-state events at
    //     every buffered position (they are exempt from replay dedup).
    if (toolStateBundles.length > 0) {
      for (const { frames } of toolStateBundles) {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const frame of frames) this.sendTo(ws, frame);
      }
    }

    // 3. Live floating selections / obscure regions, then complete.
    //    (Masks went out in step 1b — they must precede the replay.)
    if (ws.readyState !== WebSocket.OPEN) return;
    this._sendActiveImagesToJoiner(ws);
    this._sendActiveObscureRegionsToJoiner(ws);
    this.sendTo(ws, { t: T.SYNC_COMPLETE });

    // 4. History backfill, in the background. Strictly after SYNC_COMPLETE and
    //    on a later tick so it never delays the board appearing.
    this._scheduleHistoryBackfill(ws, requesterSessionIndex);
  }

  /**
   * Stream the room's archived history to a joiner so their rolling DVR tape
   * ("History → Recent") starts populated instead of blank.
   *
   * This is decoratively separate from the join serve above and must stay that
   * way: nothing here affects the board the joiner renders. The frames are the
   * same wire bytes the live tail uses, but they are wrapped in
   * HISTORY_BACKFILL_CHUNK rather than sent bare, so the client routes them to
   * the tape recorder and can never mistake two-minute-old geometry for live
   * content. Sending them bare and bracketing with BEGIN/END would be cheaper
   * on the wire but would race: a live broadcast landing between the brackets
   * would be swallowed into the tape and never drawn.
   *
   * Paced across ticks. A backfill can be a few thousand frames and the joiner
   * has just finished paying for a full sync; blocking the event loop to push
   * all of it at once would stall every other client in the room.
   *
   * @param {WebSocket} ws
   * @param {number} requesterSessionIndex
   * @private
   */
  _scheduleHistoryBackfill(ws, requesterSessionIndex) {
    const history = this.room?.history;
    if (!history) return;
    const log = this.room?.strokeLog;
    const tape = this.room?.strokeTape;

    // Prune first so the served window matches the advertised one — the last
    // checkpoint may have been a while ago on a quiet board.
    history.prune();
    const { anchor, commits: archived, cursors } = history.getBackfill();
    if (!anchor) {
      console.log(`[History] No origin anchor for room "${this.room?.id}"; skipping backfill for ${requesterSessionIndex}`);
      return;
    }

    // The archive holds only what a checkpoint has RETIRED. Everything since
    // the last checkpoint is still live in strokeLog/strokeTape, so the archive
    // alone leaves a hole between the newest checkpoint and the join — and in a
    // room that has never checkpointed at all (an UNREGISTERED room never mints
    // one: Room.canPersistSnapshots requires an ownerId, so _requestSnapshot
    // returns immediately) the archive is empty and there is no history to show
    // whatsoever, which is exactly what an unowned test room looks like.
    //
    // So the backfill is archive + live tail. The two are disjoint by
    // construction — truncation moves a commit from one to the other — but the
    // seq map below is authoritative anyway.
    const latestSeq = log?.getSummary?.().latestSeq || 0;
    const liveEntries = log && latestSeq > anchor.seq
      ? log.getRange(anchor.seq + 1, latestSeq)
      : [];

    const bySeq = new Map();
    for (const c of archived) bySeq.set(c.seq, c);
    for (const e of liveEntries) {
      if (bySeq.has(e.seq)) continue;
      const bytes = log.getBytes(e.seq);
      const bundle = tape?.getBundleWithTs?.(e.seq);
      const frames = bundle?.frames || [];
      if (!bytes && frames.length === 0) continue;
      bySeq.set(e.seq, {
        seq: e.seq,
        ts: e.timestamp || Date.now(),
        userId: e.userId | 0,
        frames,
        frameTs: bundle?.ts || [],
        bytes,
      });
    }
    if (bySeq.size === 0 && (cursors?.length || 0) === 0) {
      console.log(`[History] Nothing to backfill for ${requesterSessionIndex} `
        + `(anchor seq ${anchor.seq}${anchor.blank ? ' blank' : ''}, archived 0, live 0, cursors 0)`);
      return;
    }
    const commits = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
    console.log(`[History] Backfill for ${requesterSessionIndex}: ${archived.length} archived + `
      + `${commits.length - archived.length} live commit(s), ${cursors?.length || 0} cursor frame(s), `
      + `from anchor seq ${anchor.seq}`
      + `${anchor.blank ? ' (blank base)' : ` (image ${anchor.id})`}`);

    // The archive holds anchor METADATA; the image itself lives in the room's
    // snapshot ring. The one anchor with no image is the session ORIGIN when
    // the board started blank — an empty canvas is a real base, and it is what
    // lets history cover the room's very first checkpoint instead of only
    // everything after the second.
    //
    // Any other missing image means the ring evicted it, and serving the deltas
    // alone would draw two minutes of strokes over the wrong board — worse than
    // serving nothing.
    let baseImage = null;
    if (!anchor.blank) {
      baseImage = (this.room?.snapshots || []).find((s) => s?.id === anchor.id
        && Array.isArray(s.layers) && s.layers.length > 0);
      if (!baseImage) {
        console.log(`[History] No base image for anchor ${anchor.id}; skipping backfill for ${requesterSessionIndex}`);
        return;
      }
    }

    // Flatten to a single ordered frame list. Each commit contributes its
    // preamble frames then its own bytes, exactly as the live tail does, and
    // all of them carry the commit's timestamp so the client's tape can place
    // the stroke on its timeline. Sub-stroke timing is lost (a long stroke
    // replays at its commit instant) — the archive is keyed by commit, and
    // per-frame arrival times were never recorded.
    // Image-tool payloads (brush/pattern/confetti bitmaps) ride in EVERY
    // stroke's preamble, so a run of strokes sharing a brush would otherwise
    // ship the same multi-megabyte bitmap once per stroke. The filter keeps
    // only the frames that actually change what the receiver holds — identical
    // to the join tail's use of it, and valid across both sources because the
    // archive retains the tape's own frame objects (identity is what
    // isDedupableFrame tests).
    const frameFilter = new TapeFrameFilter(tape);
    const frames = [];
    // Cursor frames interleave with the commits by seq — the server allocates
    // one for every broadcast, MM included, so a single ordering covers both
    // and the hover between two strokes lands exactly where it happened.
    let ci = 0;
    const cursorTrack = cursors || [];
    for (const commit of commits) {
      while (ci < cursorTrack.length && cursorTrack[ci].seq < commit.seq) {
        const c = cursorTrack[ci++];
        frames.push({ ts: c.ts, seq: c.seq, data: c.bytes });
      }
      // Each preamble frame goes out with its OWN arrival time, so the stroke
      // replays as it was drawn — cursor moving, preview building — instead of
      // every frame landing on the commit's instant and the stroke popping into
      // existence fully formed. The filter returns an ordered SUBSEQUENCE of
      // commit.frames (deduped brush payloads are dropped), so walk the two
      // together by identity to recover each kept frame's timestamp.
      const kept = frameFilter.filter(commit.userId, commit.frames);
      const tsList = commit.frameTs || [];
      let src = 0;
      for (const frame of kept) {
        while (src < commit.frames.length && commit.frames[src] !== frame) src++;
        const ts = tsList[src] ?? commit.ts;
        src++;
        frames.push({ ts, seq: commit.seq, data: frame });
      }
      if (commit.bytes) frames.push({ ts: commit.ts, seq: commit.seq, data: commit.bytes });
    }
    // Hover after the last commit — the cursor drifting on an idle board.
    while (ci < cursorTrack.length) {
      const c = cursorTrack[ci++];
      frames.push({ ts: c.ts, seq: c.seq, data: c.bytes });
    }
    if (frames.length === 0) return;
    if (frames.length > HISTORY_BACKFILL_MAX_FRAMES) {
      console.log(`[History] Backfill for ${requesterSessionIndex} is ${frames.length} frames `
        + `(> ${HISTORY_BACKFILL_MAX_FRAMES}) — skipping. A room that never checkpoints has no `
        + `2-minute horizon; register the room so auto-checkpoints mint.`);
      return;
    }

    const spanMs = frames[frames.length - 1].ts - frames[0].ts;
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      this.sendTo(ws, {
        t: T.HISTORY_BACKFILL_BEGIN,
        ...(baseImage ? { snapshotLayers: baseImage.layers, snapshotId: anchor.id } : {}),
        historyBlankBase: !baseImage,
        snapshotTs: anchor.ts,
        snapshotSeq: anchor.seq,
        historyTotal: frames.length,
        historyWindowMs: Math.max(0, spanMs),
      });
      this._pumpHistoryChunks(ws, requesterSessionIndex, frames, 0);
    }, HISTORY_BACKFILL_START_DELAY_MS);
  }

  /**
   * Send one chunk of backfill frames and queue the next.
   * @private
   */
  _pumpHistoryChunks(ws, requesterSessionIndex, frames, offset) {
    if (ws.readyState !== WebSocket.OPEN) return;

    // Drop the rest if the socket is already backed up. A joiner on a slow link
    // must not have history pile into its send buffer ahead of live drawing —
    // the backfill is a nicety, the live feed is not.
    if (ws.bufferedAmount > HISTORY_BACKFILL_BACKPRESSURE_BYTES) {
      console.log(`[History] Backpressure (${ws.bufferedAmount}B) — truncating backfill for `
        + `${requesterSessionIndex} at ${offset}/${frames.length}`);
      this.sendTo(ws, { t: T.HISTORY_BACKFILL_END, historyTotal: offset });
      return;
    }

    const end = Math.min(offset + HISTORY_BACKFILL_CHUNK_SIZE, frames.length);
    this.sendTo(ws, {
      t: T.HISTORY_BACKFILL_CHUNK,
      historyFrames: frames.slice(offset, end),
    });

    if (end >= frames.length) {
      this.sendTo(ws, { t: T.HISTORY_BACKFILL_END, historyTotal: frames.length });
      console.log(`[History] Backfilled ${frames.length} frame(s) to ${requesterSessionIndex}`);
      return;
    }
    setTimeout(() => this._pumpHistoryChunks(ws, requesterSessionIndex, frames, end),
      HISTORY_BACKFILL_CHUNK_INTERVAL_MS);
  }

  /**
   * Sends active floating selection images to a newly joined user.
   * Called just before SYNC_COMPLETE so the new user's canvas is already built.
   * @param {WebSocket} joinerWs - The WebSocket of the new user.
   * @private
   */
  _sendActiveImagesToJoiner(joinerWs) {
    for (const [sessionIndex, userData] of this.sessionManager.users) {
      if (!userData.activeImage) continue;
      const { sx, sy, sw, sh, g } = userData.activeImage;
      this.sendTo(joinerWs, { t: T.IMG_PASTE, u: sessionIndex, sx, sy, sw, sh, g });
      // If the selection has been moved from its initial position, send current corners
      if (userData.activeSelectionCorners) {
        const moveMsg = { t: T.SEL_MOVE, u: sessionIndex, cr: userData.activeSelectionCorners };
        if (userData.activeSelectionSourceCrop) {
          moveMsg.cb = userData.activeSelectionSourceCrop;
        }
        this.sendTo(joinerWs, moveMsg);
      }
    }
  }

  /**
   * Arm the masks that were already in force at the checkpoint.
   *
   * ONLY those. A mask armed later travels inside the tail as tool state, at
   * the position it was actually armed, and pre-arming it here would clip
   * every stroke the tail replays BEFORE that point — the joiner ends up with
   * a mask applied retroactively to strokes the drawer never masked (measured:
   * selparity mask_brush_draw, joiner at 88.5% while live peers agreed at
   * 99.6%, with all four strokes truncated on the joiner instead of one).
   *
   * @param {WebSocket} joinerWs
   * @param {number} baseSeq - Seq of the checkpoint this joiner is being served.
   * @private
   */
  _sendActiveMasksToJoiner(joinerWs, baseSeq = 0) {
    for (const [sessionIndex, userData] of this.sessionManager.users) {
      if (!userData.activeMask) continue;
      // Masks recorded before armedAtSeq existed have no stamp; treat those as
      // pre-checkpoint so their behaviour is the old one rather than silently
      // dropping the mask entirely.
      const armedAtSeq = userData.activeMask.armedAtSeq ?? 0;
      if (armedAtSeq > baseSeq) continue;
      const { sx, sy, sw, sh, ps } = userData.activeMask;
      const msg = { t: T.SEL_MASK, u: sessionIndex, mk: true, sx, sy, sw, sh };
      if (Array.isArray(ps) && ps.length >= 6) {
        msg.ps = ps;
      }
      this.sendTo(joinerWs, msg);
    }
  }

  _sendActiveObscureRegionsToJoiner(joinerWs) {
    for (const region of this.room?.obscureRegions?.values?.() || []) {
      this.sendTo(joinerWs, { t: T.OBSCURE_REGION, u: ROOM_OVERLAY_SESSION_INDEX, g: JSON.stringify(region) });
    }
  }

  /**
   * Finds an open WebSocket client by their session index.
   * @param {number} sessionIndex - The session index to find.
   * @returns {WebSocket|null} - The client WebSocket or null.
   * @private
   */
  _findClient(sessionIndex) {
    const idx = Number(sessionIndex);
    for (const client of this.wss.clients) {
      if (Number(client.sessionIndex) === idx && client.readyState === WebSocket.OPEN) {
        return client;
      }
    }
    return null;
  }
}
