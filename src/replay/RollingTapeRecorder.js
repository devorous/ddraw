/**
 * @fileoverview Rolling "DVR" tape recorder.
 *
 * Unlike the manual {@link Recorder} (toggled by the topbar tape button, records
 * an open-ended session and exports `.ddraw`), this recorder runs automatically
 * in the background once a room has synced and keeps only a bounded window of
 * recent activity — roughly the last two minutes. Opening History → "Recent"
 * freezes the current window into an immutable {@link ReplayRecording} and hands
 * it to `TimeMachine.loadFromRecording()` while the live recorder keeps going.
 *
 * It is built on the exact same `ReplayRecording` shape the manual recorder and
 * TimeMachine already consume, so the scrubber, visual-checkpoint preview grid,
 * `.ddraw` export and parity harness all work unchanged.
 *
 * Pruning is checkpoint-aware (see {@link RollingTapeRecorder._prune}): we never
 * drop deltas without keeping a base checkpoint at or before the oldest visible
 * timestamp, otherwise the frozen tape would have nothing to replay from.
 */
import { captureOpeningSnapshot } from './snapshotCapture.js';
import { shouldRecord } from './messageAllowlist.js';
import { isCommitType } from '../../shared/StrokeFingerprint.js';
import { T } from '../../shared/MessageTypes.js';

const RECORDING_VERSION = 2;

/** Visible scrub window. Two minutes of "what just happened". */
const DEFAULT_WINDOW_MS = 120_000;
const DEFAULT_ENABLED = true;
/** Anchor/intra checkpoint cadence. Checkpoints now carry full undoable layer
 * state (layerStateCodec), so each is heavier than the old flat PNG — 30s keeps
 * the capture cost down while a rebuild still replays ≤30s of deltas. */
const INTRA_CHECKPOINT_INTERVAL_MS = 30_000;
/** Low-res scrub-preview cadence (matches Recorder + TimeMachine). */
const VISUAL_CHECKPOINT_INTERVAL_MS = 2000;
// Low power: every visual checkpoint is a full-raster downscale plus a toBlob
// GPU readback, and they only feed scrub thumbnails — the replay itself seeks
// from deltas and anchor checkpoints. Coarser thumbnails, same tape.
const LOW_POWER_VISUAL_CHECKPOINT_INTERVAL_MS = 8000;
const VISUAL_CHECKPOINT_SCALE = 1 / 6;
const VISUAL_CHECKPOINT_QUALITY = 0.6;
/** How often the ring buffer is pruned back to the horizon. */
const PRUNE_INTERVAL_MS = 5000;
/**
 * Dead-air removal: events are stamped on a compressed "activity clock" rather
 * than wall-clock, so idle gaps don't consume the visible window and viewers
 * only ever scrub through moments that had activity. Real time is allowed to
 * flow for this long into any pause (a natural lead-out beat); past that the
 * clock freezes until the next input, then resumes from where it left off.
 */
const IDLE_LEADOUT_MS = 500;
/**
 * Tick spacing used to spread a backfilled commit's frames (see
 * {@link RollingTapeRecorder.seedFromBackfill}). The server archives frames
 * keyed by commit, so a stroke's MM frames all share one timestamp; 16ms is the
 * 60 TPS cadence they were actually emitted at, which turns a stroke that would
 * otherwise pop into existence back into a stroke that draws.
 */
const BACKFILL_FRAME_TICK_MS = 16;
/**
 * Safety cap on resident deltas. Two minutes of normal drawing is far below
 * this; the cap only matters during pathological floods (e.g. a script). When
 * hit we drop the oldest deltas regardless of the checkpoint anchor — a slightly
 * shorter window beats unbounded memory.
 */
const HARD_MAX_DELTAS = 200_000;

/**
 * @typedef {import('./Recorder.js').ReplayRecording} ReplayRecording
 */

export class RollingTapeRecorder {
  constructor() {
    /** @type {boolean} User preference gate for automatic capture. */
    this._configuredEnabled = DEFAULT_ENABLED;
    /** @type {boolean} True while actively capturing. */
    this._enabled = false;
    /**
     * Stale = the buffer may have gaps (disconnect, AFK draw filtering) so the
     * Recent tape can't be trusted as a faithful replay. Cleared on reset/start.
     * @type {boolean}
     */
    this._stale = false;
    /** @type {string|null} Reason the tape was last marked stale (for UI/debug). */
    this._staleReason = null;
    /** @type {Object|null} live App instance */
    this._app = null;
    /** Visible window length in ms. */
    this._windowMs = DEFAULT_WINDOW_MS;

    // Ring buffers, all sorted ascending by ts.
    /** @type {Array<{ts: number, snapshot: Object}>} */
    this._checkpoints = [];
    /** @type {import('./Recorder.js').ReplayDelta[]} */
    this._deltas = [];
    /** @type {Array<{ts: number, blob: Blob}>} */
    this._visualCheckpoints = [];

    /**
     * True once the server's history backfill has been spliced onto the front
     * of this tape. One per anchoring — cleared with the buffers, so a resync
     * (which re-anchors) can accept a fresh backfill.
     * @type {boolean}
     */
    this._backfilled = false;

    this._intraTimer = null;
    this._visualTimer = null;
    this._pruneTimer = null;
    this._visualInFlight = false;
    /**
     * True when at least one input (delta) has been recorded since the last
     * visual checkpoint was captured. Gates the visual-checkpoint timer so an
     * idle canvas doesn't append duplicate "nothing changed" frames to the tape.
     * @type {boolean}
     */
    this._activitySinceVisual = false;
    /** Same idea, for the heavier intra (anchor) checkpoint cadence. @type {boolean} */
    this._activitySinceIntra = false;

    // Compressed activity clock (see IDLE_LEADOUT_MS). We track the wall time and
    // assigned virtual time of the last input; the virtual "now" is a pure
    // function of those plus the current wall clock, so it freezes IDLE_LEADOUT_MS
    // after the last input and resumes on the next one. Monotonic by construction.
    /** @type {number} Wall-clock ms of the last stamped input. */
    this._lastInputWall = 0;
    /** @type {number} Virtual ts assigned to the last stamped input. */
    this._lastInputVirtual = 0;

    /**
     * One-shot inbound filter armed around our own "undo to here" restore
     * broadcast — see {@link RollingTapeRecorder.suppressNextInbound}.
     * @type {{type: number, until: number} | null}
     */
    this._suppressInbound = null;

    /** @type {((status: ReturnType<RollingTapeRecorder['getStatus']>) => void) | null} */
    this.onStatusChange = null;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /** True while the recorder is enabled and capturing. */
  isEnabled() { return this._enabled; }

  /** True when the buffer may have gaps and shouldn't be trusted as a replay. */
  isStale() { return this._stale; }

  /**
   * Update rolling tape preferences. Disabling stops and clears the buffer.
   * @param {{ enabled?: boolean, windowMs?: number }} options
   */
  configure(options = {}) {
    if (options.windowMs != null) {
      const windowMs = Number(options.windowMs);
      if (Number.isFinite(windowMs) && windowMs > 0) {
        this._windowMs = windowMs;
        if (this._enabled) this._prune();
      }
    }

    if (options.enabled != null) {
      this._configuredEnabled = !!options.enabled;
      if (!this._configuredEnabled && this._enabled) {
        this.stop('disabled');
        return;
      }
    }

    this._notify();
  }

  /**
   * Space visual checkpoints further apart on low power devices. Applied live:
   * a running tape reschedules its next capture at the new interval.
   * @param {boolean} lowPower
   */
  setLowPower(lowPower) {
    const next = !!lowPower;
    if (next === !!this._lowPower) return;
    this._lowPower = next;
    if (this._enabled) this._scheduleVisual();
  }

  /** @returns {number} ms between visual checkpoint captures */
  getVisualCheckpointIntervalMs() {
    return this._lowPower ? LOW_POWER_VISUAL_CHECKPOINT_INTERVAL_MS : VISUAL_CHECKPOINT_INTERVAL_MS;
  }

  /**
   * Begin (or restart) capture. Captures the anchor checkpoint immediately and
   * starts the checkpoint/prune timers. Idempotent — calling start while already
   * enabled re-anchors (clears the buffer and recaptures), which is what a
   * resync/board-replace wants.
   * @param {Object} app - live App instance (window.app)
   */
  start(app) {
    if (!app) return;
    if (!this._configuredEnabled) {
      this.stop('disabled');
      return;
    }
    this._app = app;
    if (this._enabled) {
      // Already running — treat as a re-anchor.
      this.reset('restart');
      return;
    }
    this._enabled = true;
    this._stale = false;
    this._staleReason = null;
    this._clearBuffers();
    this._captureCheckpoint();
    this._scheduleIntra();
    this._scheduleVisual();
    this._schedulePrune();
    this._notify();
  }

  /**
   * Stop capture and drop the buffer entirely. Use when leaving a room — there
   * is nothing worth keeping from a room we're no longer in.
   * @param {string} [reason]
   */
  stop(reason = 'stop') {
    this._enabled = false;
    this._stale = false;
    this._staleReason = null;
    this._clearTimers();
    this._clearBuffers();
    this._suppressInbound = null;
    this._app = null;
    void reason;
    this._notify();
  }

  /**
   * Clear the buffer and re-anchor at the current board state without changing
   * the enabled flag. Use on resync / board replacement: the old deltas no
   * longer compose against the new base.
   * @param {string} [reason]
   */
  reset(reason = 'reset') {
    this._clearBuffers();
    this._stale = false;
    this._staleReason = null;
    void reason;
    if (this._enabled && this._app) {
      this._captureCheckpoint();
      // Make sure timers are running (reset may be the first call after a
      // start that was interrupted).
      if (this._intraTimer == null) this._scheduleIntra();
      if (this._visualTimer == null) this._scheduleVisual();
      if (this._pruneTimer == null) this._schedulePrune();
    }
    this._notify();
  }

  /**
   * Mark the tape stale (gaps possible). Capture continues so the tape can
   * recover after the next reset, but the UI should warn that Recent may be
   * incomplete. No-op when not enabled.
   * @param {string} reason
   */
  markStale(reason = 'stale') {
    if (!this._enabled || this._stale) return;
    this._stale = true;
    this._staleReason = reason;
    this._notify();
  }

  /**
   * App-facing convenience: called whenever room sync completes. Starts the
   * recorder the first time and re-anchors on subsequent (resync) completions.
   * @param {Object} app
   */
  onSyncComplete(app) {
    if (!this._configuredEnabled) {
      this.stop('disabled');
      return;
    }
    if (this._enabled) {
      this.reset('resync');
    } else {
      this.start(app);
    }
  }

  // ── server history backfill ─────────────────────────────────────────────────

  /**
   * Splice the server's archived history onto the FRONT of the tape.
   *
   * A joiner's tape starts at the moment they synced, so "Recent" is blank for
   * the first two minutes in every room they enter while everyone already
   * present can scrub back through what was just drawn. The server keeps that
   * window (server/RoomHistory.js) and streams it here after SYNC_COMPLETE.
   *
   * The frames are the same wire messages a live peer recorded, so they compose
   * exactly like locally-captured deltas; the only difference is where the base
   * image comes from. That base is a checkpoint IMAGE, not a captured layer
   * state, so it rides in as a synthetic BOARD_SNAPSHOT_RESTORE delta at the
   * head of the tape — ReplayEngine already applies those to its replay board
   * (`_replayBoard.restoreSnapshot`), which means no new restore path and no
   * QOI decoding here. The checkpoint entry that precedes it reuses the join
   * anchor's snapshot purely so the tape has a valid base object; the restore
   * delta immediately overwrites its pixels.
   *
   * Timing is real, with one fallback. The server stamps every frame with its
   * own arrival time (StrokeTape's parallel timestamp track), so a stroke's
   * MD/MM frames unfold at the rate they were drawn and hover moves between
   * strokes play at their true spacing; gaps go through the same
   * IDLE_LEADOUT_MS dead-air compression the live clock uses. Frames that
   * genuinely share an instant — the tool-state snapshot at mousedown,
   * selection setup before a commit — are spread at BACKFILL_FRAME_TICK_MS so
   * they cannot stack on one timestamp, capped so they never run into whatever
   * comes next.
   *
   * Frames arrive in SEQ order, which is not always TS order: another user's
   * hover during someone's stroke is sequenced before that stroke's commit but
   * happened during it. The clock below only ever moves forward, so such a
   * frame costs no time rather than rewinding the tape.
   *
   * @param {{anchorTs: number, anchorLayers: Array<Uint8Array>|null, anchorBlank?: boolean, frames: Array<{ts: number, msg: Object}>}} backfill
   * @returns {boolean} true when the tape was extended
   */
  seedFromBackfill({ anchorTs, anchorLayers, anchorBlank = false, frames } = {}) {
    if (!this._enabled || this._backfilled) return false;
    if (!Array.isArray(frames) || frames.length === 0) return false;
    if (!anchorBlank && (!Array.isArray(anchorLayers) || anchorLayers.length === 0)) return false;
    // Nothing to attach to, and nothing to trust: a tape with known gaps must
    // not be presented as a continuous history just because we lengthened it.
    if (this._checkpoints.length === 0 || this._stale) return false;

    const startVirtual = this._checkpoints[0].ts;
    const base = Number(anchorTs) || frames[0].ts;

    // Walk the frames once, assigning each a virtual offset from the anchor.
    // Frames sharing a timestamp are one commit ("a run") and are spread over
    // the ticks that produced them; the gap between runs is the compressed
    // dead air. The spread cap is computed once per RUN, not per frame: a
    // per-frame cap only clamps the run's LAST frame, so a stroke long enough
    // to hit the cap ended up with its final frame stamped earlier than its
    // second-to-last one, and the tape stopped being monotonic.
    let virtual = 0;
    let prevWall = base;
    let runOffset = 0;
    let runStart = 0;
    let runCap = IDLE_LEADOUT_MS;
    let runTs = null;
    const offsets = new Array(frames.length);

    for (let i = 0; i < frames.length; i++) {
      const wall = Number(frames[i].ts) || prevWall;
      if (wall !== runTs) {
        // New commit: advance the compressed clock across the real gap, then
        // look ahead for how much room this run has before the next one.
        virtual += Math.min(Math.max(wall - prevWall, 0), IDLE_LEADOUT_MS);
        prevWall = wall;
        runTs = wall;
        runOffset = virtual;
        runStart = i;
        let nextWall = null;
        for (let j = i + 1; j < frames.length; j++) {
          const w = Number(frames[j].ts);
          if (w !== wall) { nextWall = w; break; }
        }
        runCap = nextWall == null
          ? IDLE_LEADOUT_MS
          : Math.min(Math.max(nextWall - wall, 0), IDLE_LEADOUT_MS);
      }
      const spread = Math.min((i - runStart) * BACKFILL_FRAME_TICK_MS, runCap);
      offsets[i] = runOffset + spread;
      if (offsets[i] > virtual) virtual = offsets[i];
    }

    // Land the newest backfilled frame just before the join anchor, so history
    // runs continuously into the locally-recorded tape.
    const span = virtual;
    const originVirtual = startVirtual - 1 - span;

    // Head delta = the base the history replays onto. A blank session origin
    // rides in as CLR (ReplayEngine clears the replay board on it) rather than
    // as an image; that is what lets history cover a room's first checkpoint
    // instead of starting only after its second.
    const seeded = [
      {
        ts: originVirtual,
        wall: base,
        msg: anchorBlank
          ? { t: T.CLR }
          : { t: T.BOARD_SNAPSHOT_RESTORE, snapshotLayers: anchorLayers },
        dir: 'in',
      },
    ];
    for (let i = 0; i < frames.length; i++) {
      seeded.push({
        ts: originVirtual + offsets[i],
        wall: Number(frames[i].ts) || base,
        msg: frames[i].msg,
        dir: 'in',
      });
    }

    this._checkpoints.unshift({ ts: originVirtual, snapshot: this._checkpoints[0].snapshot });
    this._deltas.unshift(...seeded);
    this._backfilled = true;
    this._notify();
    return true;
  }

  // ── delta tap ─────────────────────────────────────────────────────────────

  /**
   * Feed a tapped message into the ring buffer. Called from
   * `TimeMachine.recordAction` for both directions, mirroring Recorder's
   * self-echo dedup so commits aren't applied twice during replay.
   * @param {Object} msg
   * @param {'in'|'out'} dir
   */
  record(msg, dir) {
    if (!this._enabled) return;
    if (!shouldRecord(msg)) return;

    // One-shot suppression (see suppressNextInbound): our own restore echoed
    // back by the server after an "undo to here" truncation must not land on
    // the freshly cut tape.
    const sup = this._suppressInbound;
    if (sup && dir === 'in' && msg?.t === sup.type) {
      this._suppressInbound = null;
      if (Date.now() <= sup.until) return;
    }

    // Drop the server's inbound echo of our own commit-class messages — we
    // already captured the outbound copy. See Recorder._append for the why.
    // SEL_LIFT echoes to its sender as well but is not a COMMIT_KIND type — see
    // the same guard in Recorder._append.
    if (dir === 'in' && msg?.t != null && (isCommitType(msg.t) || msg.t === T.SEL_LIFT)) {
      const selfIdx = this._app?.wsClient?.sessionIndex
                   ?? this._app?.sessionIndex
                   ?? null;
      if (selfIdx != null && msg.u === selfIdx) return;
    }

    let cloned;
    try {
      cloned = structuredClone(msg);
    } catch {
      cloned = JSON.parse(JSON.stringify(msg));
    }
    // Stamp on the compressed activity clock so genuine idle gaps collapse out of
    // the timeline. Any genuinely-sent message (including hover cursor moves)
    // counts as activity; messages the local user makes while reviewing a replay
    // never reach here (filtered in TimeMachine.recordAction). The wall stamp
    // rides along so "undo to here" can map cuts between this tape's activity
    // clock and the manual Recorder's wall clock (never exported in bundles).
    this._deltas.push({ ts: this._stampInput(), wall: Date.now(), msg: cloned, dir });
    this._activitySinceVisual = true;
    this._activitySinceIntra = true;

    if (this._deltas.length > HARD_MAX_DELTAS) {
      // Pathological flood — drop the oldest excess immediately rather than
      // waiting for the prune timer. May shorten the effective window.
      this._deltas.splice(0, this._deltas.length - HARD_MAX_DELTAS);
    }
  }

  // ── snapshotting ────────────────────────────────────────────────────────────

  /**
   * Freeze the current window into an immutable {@link ReplayRecording} suitable
   * for `TimeMachine.loadFromRecording()`. The live recorder keeps running.
   *
   * The anchor is the newest checkpoint at or before `now - windowMs` (so the
   * tape has a valid base for the whole visible range); if the recording is
   * younger than the window we anchor on the very first checkpoint.
   *
   * @returns {ReplayRecording | null} null when nothing has been captured yet
   */
  snapshotRecording() {
    if (this._checkpoints.length === 0) return null;
    const now = this._virtualNow();
    const horizon = now - this._windowMs;
    const anchor = this._pickAnchor(horizon);
    if (!anchor) return null;

    const deltas = this._deltas
      .filter((d) => d.ts >= anchor.ts)
      .map((d) => ({ ts: d.ts, msg: structuredCloneSafe(d.msg), dir: d.dir }));

    const intraCheckpoints = this._checkpoints
      .filter((cp) => cp.ts > anchor.ts)
      .map((cp) => ({ ts: cp.ts, snapshot: cp.snapshot }));

    const visualCheckpoints = this._visualCheckpoints
      .filter((cp) => cp.ts >= anchor.ts)
      .map((cp) => ({ ts: cp.ts, blob: cp.blob }));

    /** @type {ReplayRecording & {rolling: boolean, windowMs: number, anchorTs: number, liveEdgeTs: number, stale: boolean}} */
    const bundle = {
      version: RECORDING_VERSION,
      roomId: this._app?.currentRoomId ?? null,
      startedAt: anchor.ts,
      endedAt: now,
      openingSnapshot: anchor.snapshot,
      deltas,
      intraCheckpoints,
      visualCheckpoints,
      assets: {},
      // Rolling-specific metadata (informational; TimeMachine ignores extras).
      rolling: true,
      windowMs: this._windowMs,
      anchorTs: anchor.ts,
      liveEdgeTs: now,
      stale: this._stale,
    };
    return bundle;
  }

  // ── undo-to-here truncation ─────────────────────────────────────────────────

  /**
   * Drop everything after `virtualTs` from the tape. Used by "undo to here":
   * once the board is reverted to that moment, the undone tail must not live
   * on in history — reopening Recent would otherwise replay strokes that no
   * longer exist, and checkpoints captured after the revert would contradict
   * the buffered deltas. The live board is expected to already equal the tape
   * state at the cut; a fresh checkpoint is captured there so the remaining
   * tape has an exact anchor, and the activity clock is rewound so new inputs
   * continue seamlessly from the cut.
   * @param {number} virtualTs - cut point on the tape's activity clock
   */
  truncateAfter(virtualTs) {
    if (!this._enabled) return;
    const cut = Number(virtualTs);
    if (!Number.isFinite(cut)) return;

    this._checkpoints = this._checkpoints.filter((cp) => cp.ts <= cut);
    this._deltas = this._deltas.filter((d) => d.ts <= cut);
    this._visualCheckpoints = this._visualCheckpoints.filter((cp) => cp.ts <= cut);

    // Rewind the activity clock to the cut so the next input stamps just past
    // it (monotonic: everything newer was dropped above).
    this._lastInputWall = Date.now();
    this._lastInputVirtual = cut;
    this._activitySinceVisual = false;
    this._activitySinceIntra = false;

    // The board now equals the tape state at the cut — anchor it exactly.
    // Also covers the edge where a long review let pruning advance the anchor
    // past the cut (the filters above would then leave zero checkpoints).
    this._captureCheckpoint();
    this._notify();
  }

  /**
   * Wall-clock variant of {@link truncateAfter} for cuts made on a wall-clock
   * tape (a manual Recorder recording or a same-session .ddraw). Board state
   * only changes with messages, so the last delta at or before the wall cut
   * marks the same state on the activity clock. A cut that predates every
   * buffered delta (e.g. restoring from an old .ddraw file) means the whole
   * window was undone — the tape resets and re-anchors on the restored board.
   * @param {number} wallTs
   */
  truncateAfterWall(wallTs) {
    if (!this._enabled || this._deltas.length === 0) return;
    const cutWall = Number(wallTs);
    if (!Number.isFinite(cutWall)) return;
    if (this._deltas[this._deltas.length - 1].wall <= cutWall) return; // nothing after the cut

    let virtualCut = null;
    for (const d of this._deltas) {
      if (d.wall <= cutWall) virtualCut = d.ts;
      else break;
    }
    if (virtualCut == null) {
      this.reset('undo-truncate');
      return;
    }
    this.truncateAfter(virtualCut);
  }

  /**
   * Best-effort wall-clock time for a point on the tape's activity clock,
   * mapped through the deltas' wall stamps. Used to cut the manual Recorder
   * (a wall-clock tape) at the same moment as a rolling-tape undo.
   * @param {number} virtualTs
   * @returns {number}
   */
  wallTsForVirtual(virtualTs) {
    let lastAtOrBefore = null;
    for (const d of this._deltas) {
      if (d.ts <= virtualTs) lastAtOrBefore = d;
      else break;
    }
    if (lastAtOrBefore?.wall != null) return lastAtOrBefore.wall;
    // Cut precedes every buffered delta: anything recorded counts as "after".
    const first = this._deltas[0];
    if (first?.wall != null) return first.wall - 1;
    return Date.now();
  }

  /**
   * Arm a one-shot filter that drops the next inbound message of `type`.
   * Armed just before our own "undo to here" restore broadcast: the tape is
   * truncated at the undo point, and the server's echo of the restore carries
   * no user id (so it dodges the commit self-echo dedup) — without this it
   * would re-append a full board image the truncated tape already equals.
   * @param {number} type - T enum message type
   * @param {number} [windowMs] - how long the filter stays armed
   */
  suppressNextInbound(type, windowMs = 10_000) {
    if (type == null) return;
    this._suppressInbound = { type, until: Date.now() + windowMs };
  }

  /**
   * @returns {{ enabled: boolean, stale: boolean, staleReason: string|null,
   *   windowMs: number, deltaCount: number, checkpointCount: number,
   *   oldestTs: number|null, newestTs: number|null, hasContent: boolean }}
   */
  getStatus() {
    const now = this._virtualNow();
    const horizon = now - this._windowMs;
    const anchor = this._checkpoints.length ? this._pickAnchor(horizon) : null;
    return {
      enabled: this._enabled,
      configuredEnabled: this._configuredEnabled,
      stale: this._stale,
      staleReason: this._staleReason,
      windowMs: this._windowMs,
      deltaCount: this._deltas.length,
      checkpointCount: this._checkpoints.length,
      oldestTs: anchor ? anchor.ts : null,
      newestTs: this._enabled ? now : null,
      // True when part of this tape came from the server rather than from
      // messages we saw live (see seedFromBackfill).
      backfilled: this._backfilled,
      // "Has something worth scrubbing": at least one delta beyond the anchor.
      hasContent: !!anchor && this._deltas.some((d) => d.ts >= anchor.ts),
    };
  }

  // ── private ─────────────────────────────────────────────────────────────────

  /**
   * Current time on the compressed activity clock. Pure read — does not mutate
   * state. Equals the last input's virtual ts plus however much real time has
   * elapsed since, capped at IDLE_LEADOUT_MS (so it freezes during dead air).
   * Used for the prune horizon, status, and snapshot bounds so they stay on the
   * same timeline as the stamped deltas.
   * @private
   */
  _virtualNow() {
    const elapsed = Date.now() - this._lastInputWall;
    return this._lastInputVirtual + Math.min(Math.max(elapsed, 0), IDLE_LEADOUT_MS);
  }

  /**
   * Advance the activity clock for a newly arrived input and return its virtual
   * timestamp. Real time flows for the first IDLE_LEADOUT_MS of any preceding
   * gap, then the gap is dropped — collapsing dead air out of the timeline.
   * @private
   */
  _stampInput() {
    const vts = this._virtualNow();
    this._lastInputWall = Date.now();
    this._lastInputVirtual = vts;
    return vts;
  }

  /** Newest checkpoint with ts <= horizon, else the oldest checkpoint. @private */
  _pickAnchor(horizon) {
    let anchor = null;
    for (const cp of this._checkpoints) {
      if (cp.ts <= horizon) anchor = cp;
      else break;
    }
    return anchor ?? this._checkpoints[0] ?? null;
  }

  /** @private */
  _captureCheckpoint() {
    if (!this._enabled || !this._app) return;
    try {
      const snapshot = captureOpeningSnapshot(this._app);
      this._checkpoints.push({ ts: this._virtualNow(), snapshot });
    } catch (err) {
      console.warn('[RollingTape] checkpoint capture failed:', err);
    }
  }

  /** @private */
  _scheduleIntra() {
    if (this._intraTimer != null) clearTimeout(this._intraTimer);
    this._intraTimer = setTimeout(() => {
      // Idle-schedule the capture so a busy drawing frame doesn't stutter.
      const run = () => {
        // Skip anchor checkpoints during dead air — the board hasn't changed,
        // and the activity clock is frozen, so another one would be redundant.
        if (this._activitySinceIntra) {
          this._activitySinceIntra = false;
          this._captureCheckpoint();
        }
        if (this._enabled) this._scheduleIntra();
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 2000 });
      } else {
        run();
      }
    }, INTRA_CHECKPOINT_INTERVAL_MS);
  }

  /** @private */
  _scheduleVisual() {
    if (this._visualTimer != null) clearTimeout(this._visualTimer);
    this._visualTimer = setTimeout(() => {
      this._captureVisualCheckpoint();
      if (this._enabled) this._scheduleVisual();
    }, this.getVisualCheckpointIntervalMs());
  }

  /** @private */
  _schedulePrune() {
    if (this._pruneTimer != null) clearTimeout(this._pruneTimer);
    this._pruneTimer = setTimeout(() => {
      this._prune();
      if (this._enabled) this._schedulePrune();
    }, PRUNE_INTERVAL_MS);
  }

  /**
   * Prune the ring buffer back to the visible window. Checkpoint-aware: keep the
   * anchor (newest checkpoint <= horizon) plus everything newer, then drop
   * deltas/visuals older than the anchor and checkpoints before it.
   * @private
   */
  _prune() {
    if (this._checkpoints.length === 0) return;
    const horizon = this._virtualNow() - this._windowMs;
    const anchor = this._pickAnchor(horizon);
    if (!anchor) return;
    const cut = anchor.ts;

    // Keep the anchor checkpoint and everything after it.
    if (this._checkpoints[0].ts < cut) {
      this._checkpoints = this._checkpoints.filter((cp) => cp.ts >= cut);
    }
    if (this._deltas.length && this._deltas[0].ts < cut) {
      this._deltas = this._deltas.filter((d) => d.ts >= cut);
    }
    if (this._visualCheckpoints.length && this._visualCheckpoints[0].ts < cut) {
      this._visualCheckpoints = this._visualCheckpoints.filter((cp) => cp.ts >= cut);
    }
  }

  /**
   * Snapshot the live composited board to a small WebP blob for instant scrub
   * previews. Mirror of Recorder._captureVisualCheckpoint.
   * @private
   */
  _captureVisualCheckpoint() {
    if (!this._enabled || !this._app || this._visualInFlight) return;
    // Skip idle frames: nothing happened on the canvas since the last capture,
    // so re-snapshotting would only append an identical frame.
    if (!this._activitySinceVisual) return;
    const board = this._app.board;
    const boardW = board?.getWidth?.() ?? 0;
    const boardH = board?.getHeight?.() ?? 0;
    if (!boardW || !boardH) return;

    this._activitySinceVisual = false;

    const w = Math.max(1, Math.round(boardW * VISUAL_CHECKPOINT_SCALE));
    const h = Math.max(1, Math.round(boardH * VISUAL_CHECKPOINT_SCALE));
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    // The full raster, not viewCanvas: a visual checkpoint is read back as the
    // WHOLE board, and viewCanvas only ever holds what the viewport shows.
    const drawn = board.withFullRaster?.((raster) => {
      tctx.drawImage(raster, 0, 0, w, h);
      return true;
    });
    if (!drawn) return;

    const ts = this._virtualNow();
    this._visualInFlight = true;
    tmp.toBlob(
      (blob) => {
        this._visualInFlight = false;
        if (!blob || !this._enabled) return;
        this._visualCheckpoints.push({ ts, blob });
      },
      'image/webp',
      VISUAL_CHECKPOINT_QUALITY,
    );
  }

  /** @private */
  _clearBuffers() {
    this._checkpoints = [];
    this._deltas = [];
    this._visualCheckpoints = [];
    this._activitySinceVisual = false;
    this._activitySinceIntra = false;
    this._backfilled = false;
    // Re-anchor the activity clock to the present so the fresh tape starts at
    // real time and only diverges once dead air accumulates.
    const now = Date.now();
    this._lastInputWall = now;
    this._lastInputVirtual = now;
  }

  /** @private */
  _clearTimers() {
    if (this._intraTimer != null) { clearTimeout(this._intraTimer); this._intraTimer = null; }
    if (this._visualTimer != null) { clearTimeout(this._visualTimer); this._visualTimer = null; }
    if (this._pruneTimer != null) { clearTimeout(this._pruneTimer); this._pruneTimer = null; }
  }

  /** @private */
  _notify() {
    if (typeof this.onStatusChange === 'function') {
      try { this.onStatusChange(this.getStatus()); } catch {}
    }
  }
}

/** structuredClone with a JSON fallback for symbol/function-bearing payloads. */
function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/** Process-wide singleton. App.js wires it onto window.app.rollingTapeRecorder. */
export const rollingTapeRecorder = new RollingTapeRecorder();
