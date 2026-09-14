/**
 * @fileoverview TimeMachine — server-side checkpoint scrubbing.
 *
 * Local snapshot recording has been removed. All timeline data comes from
 * the server's checkpoint/delta DB. Opening the timebar triggers a
 * CHECKPOINT_LIST request; seeking triggers a REPLAY_REQUEST.
 */

import { ReplayEngine } from './ReplayEngine.js';
import { T } from '../../shared/MessageTypes.js';
import { suggestDdrawFilename } from '../../shared/ddrawCodec.js';
import { DdrawEncodeWorkerClient } from '../replay/DdrawEncodeWorkerClient.js';
import { TimeLapseExporter, compressedTapeDurationMs, suggestImageSequenceFilename, suggestVideoFilename } from '../replay/TimeLapseExporter.js';
import { isTauriDesktop, saveBytesViaNativeDialog, revealPathInDir } from '../platform/desktop.js';
import { applyRegionRestoreLayers } from '../handlers/SnapshotHandlers.js';

const SEEK_TELEMETRY_LOG_INTERVAL_MS = 1500;
const LOCAL_REVERSE_SCRUB_FRAME_MS = 500;
const LOCAL_REVERSE_SCRUB_INTERVAL_MS = 90;
/**
 * While the user holds the scrubber still on a low-res preview frame, wait this
 * long for the position to stop changing, then render the crisp full-resolution
 * frame in the background so a parked scrubber upgrades off the thumbnail.
 */
const SCRUB_SETTLE_UPGRADE_MS = 130;
const VISUAL_CHECKPOINT_INTERVAL_MS = 2000;
/** Hard cap on visual checkpoints (frame count, before stride). */
const VISUAL_CHECKPOINT_MAX_COUNT = 600;
/** Downscale source before compressing — keeps blobs tiny while staying readable when upscaled. */
const VISUAL_CHECKPOINT_MAX_EDGE = 320;
/** Lossy WebP quality. At 1/6 source size, 0.6 keeps frames around ~5–10 KB. */
const VISUAL_CHECKPOINT_QUALITY = 0.6;
/** Decoded ImageBitmap LRU size. Recent scrub frames stay hot; rest live as compressed blobs. */
const VISUAL_CHECKPOINT_DECODED_CACHE = 12;
/**
 * A forward seek rebuilds from a checkpoint (instead of incrementally replaying
 * every delta from the current position) when doing so skips at least this much
 * tape — the snapshot reload has a fixed cost, so tiny hops stay incremental.
 */
const FORWARD_SEEK_REBUILD_GAIN_MS = 5000;
/**
 * Forward scrubs farther than this from the applied position show the cached
 * low-res thumbnail (with the settle upgrade) instead of replaying live, same
 * as backward scrubs — keeps long forward drags responsive.
 */
const FORWARD_SCRUB_PREVIEW_MIN_MS = 5000;
const DYN_CHECKPOINT_DEFAULT_INTERVAL_MS = 3000;
const DYN_CHECKPOINT_SCRUB_INTERVAL_MS = 500;
const DYN_CHECKPOINT_MAX_COUNT = 24;

/**
 * Return the set of user IDs that have no UNDO or REDO message in the
 * recording. Their strokes can be baked into flatCanvas immediately during
 * replay instead of sitting in strokeStack until the per-user threshold trips.
 * @param {{ deltas: Array<{msg: { t?: number, u?: number }}> }} rec
 * @returns {Set<number>}
 */
function _collectEagerBakeUsers(rec) {
  const all = new Set();
  const undoers = new Set();
  for (const d of rec?.deltas ?? []) {
    const u = d?.msg?.u;
    if (u == null) continue;
    all.add(u);
    if (d.msg.t === T.UNDO || d.msg.t === T.REDO) undoers.add(u);
  }
  const eager = new Set();
  for (const u of all) if (!undoers.has(u)) eager.add(u);
  return eager;
}

/**
 * True if the recording's checkpoints carry full layer state (baked base +
 * undoable strokeStack + redo, from layerStateCodec) rather than just a flat
 * composite PNG. Layer-state checkpoints rebuild faithfully — correct undo and
 * complex blends — so seeks can rebuild from the nearest one instead of replaying
 * the whole tape from the opening anchor. Old flat-only recordings (pre-Phase-3
 * .ddraw files) fall back to the complex-blend safety check below.
 * @param {{ openingSnapshot?: Object, intraCheckpoints?: Array<{snapshot?: Object}> }} rec
 * @returns {boolean}
 */
function _checkpointsCarryLayerState(rec) {
  const hasState = (s) => !!(s && (Array.isArray(s.history) || Array.isArray(s.layerBaked)));
  if (hasState(rec?.openingSnapshot)) return true;
  return (rec?.intraCheckpoints ?? []).some((cp) => hasState(cp?.snapshot));
}

/**
 * Blend modes a flat checkpoint image can reproduce faithfully — they composite
 * the same with or without an opaque backdrop. Anything else ("multiply",
 * "difference", …) can bake wrong against a checkpoint's transparent backdrop.
 */
const CHECKPOINT_SAFE_BLEND_MODES = new Set(['', 'source-over', 'destination-out', 'normal']);

/**
 * True if the recording uses any complex (non-source-over) blend mode, anywhere
 * in its delta tape or its opening per-user state. Such tapes must rebuild from
 * the opening snapshot rather than the nearest checkpoint: checkpoint images are
 * flat composites captured against a transparent backdrop, which freezes an
 * unbaked complex-blend stroke as its raw colour instead of its displayed,
 * blended-against-background colour.
 * @param {{ deltas?: Array<{msg?: { bm?: string }}>, openingSnapshot?: Object }} rec
 * @returns {boolean}
 */
function _tapeHasComplexBlend(rec) {
  const isComplex = (bm) =>
    typeof bm === 'string' && bm !== '' && !CHECKPOINT_SAFE_BLEND_MODES.has(bm);
  for (const d of rec?.deltas ?? []) {
    if (isComplex(d?.msg?.bm)) return true;
  }
  const states = rec?.openingSnapshot?.appState?.userDrawingStates;
  if (states) {
    for (const id in states) {
      if (isComplex(states[id]?.blendMode)) return true;
    }
  }
  return false;
}

/**
 * TimeMachine manages server-side replay of board history.
 */
class TimeMachineState {
  // ── public reactive state ──────────────────────────────────────────────────
  /** [{id, ts, uploader, sizeBytes}] sorted ascending by ts */
  checkpoints = $state([]);
  /** timestamp of first checkpoint */
  sessionStart = $state(0);
  /** timestamp of latest known activity (ticks live when in a room) */
  sessionEnd = $state(0);
  currentTime = $state(0);
  isReviewing = $state(false);
  isPlaying = $state(false);
  /** Playback speed multiplier (1 = real time). */
  playbackRate = $state(1);
  /** true while the user is dragging the replay thumb */
  isScrubbing = $state(false);
  /** true if playback was running when the current scrub began, so we resume on release */
  _wasPlayingBeforeScrub = false;
  /** set on scrub release; playback resumes once the released-on frame has been applied */
  _resumeAfterSeek = false;
  /** true while loading checkpoint list or a replay window */
  isLoading = $state(false);
  /** true once checkpoint list has been loaded for the current room */
  isOpen = $state(false);
  /** controls whether the timebar panel is visible */
  isVisible = $state(false);
  previewData = $state(null);
  /** true when the visible replay canvas is showing a low-res cached frame rather than full replay output */
  isPreviewMode = $state(false);
  /**
   * Playback trim range (absolute timestamps). null = untrimmed edge.
   * Playback starts at the trim start and pauses at the trim end; scrubbing
   * stays free so the user can still inspect outside the trimmed window.
   */
  trimStart = $state(null);
  trimEnd = $state(null);
  /** true while a time-lapse video export is in progress */
  isExportingVideo = $state(false);
  /** 0..1 export progress */
  videoExportProgress = $state(0);
  /**
   * true while replay output is being painted into an in-panel canvas (the
   * History "Recent" mini-player) rather than the full-board #replayCanvas
   * overlay. Gates the bottom Timebar + chrome-hiding body classes off.
   */
  isEmbedded = $state(false);

  // ── backward-compat getters ────────────────────────────────────────────────
  /** @deprecated use isOpen */
  get isStarted() { return this.isOpen; }
  /** @deprecated use sessionEnd */
  get maxTime() { return this.sessionEnd; }
  /** kept so Timebar.svelte can reference it safely */
  get frozenMaxTime() { return null; }
  /** true when the scrubber is showing a finite local Recorder tape */
  get isLocalReplay() { return this._source === 'local'; }
  /** no longer relevant — always false */
  get needsResync() { return false; }
  /** no local buffer — always empty */
  get recordingBuffer() { return []; }

  // ── private ────────────────────────────────────────────────────────────────
  _board = null;
  _wsClient = null;
  _replayEngine = null;
  _replayCanvas = null;
  _replayCtx = null;
  /** 'server' = server checkpoint+delta DB, 'local' = client-side Recorder bundle */
  _source = 'server';
  /** Active local recording (set by loadFromRecording). */
  _localRecording = null;
  /** Lazily created — offloads .ddraw encode for exportCurrentRecording() to a worker. */
  _ddrawEncodeWorker = null;
  /** @type {Set<number>} negative IDs of bot cursors created in the UI */
  _botCursorIds = new Set();
  /** @type {Array<{element: HTMLElement|SVGElement, display: string}>} */
  _hiddenRealtimeCursorElements = [];
  _isSeeking = false;
  _seekGeneration = 0;
  _pendingSeekTimestamp = null;
  /** Options of the queued seek (kept alongside `_pendingSeekTimestamp`). */
  _pendingSeekOptions = null;
  _lastAppliedTimestamp = null;
  /**
   * Index into rec.deltas of the last applied delta, paired with the timestamp
   * below. Only trusted while `_lastAppliedDeltaIdxTs === _lastAppliedTimestamp`
   * — code that assigns `_lastAppliedTimestamp` directly (resets, build paths)
   * automatically invalidates it. Lets incremental seeks slice the delta array
   * exactly (no O(n) rescan, no double-apply on timestamp collisions).
   */
  _lastAppliedDeltaIdx = null;
  _lastAppliedDeltaIdxTs = null;
  _lastSeekLogAt = 0;
  _scrubLastRequestedTimestamp = null;
  _scrubLastSeekAt = 0;
  _scrubQueuedTimestamp = null;
  _scrubTimer = null;
  /** Pending "upgrade thumbnail → full-res" timer fired when the scrubber settles. */
  _scrubSettleTimer = null;
  /** True while a settle-upgrade seek is in flight (so movement can invalidate it). */
  _scrubSettleSeeking = false;
  _isPlaybackAdvancing = false;
  _pendingPlaybackTimestamp = null;
  _playbackStartPerf = 0;
  _playbackStartOffset = 0;
  _pendingServerReplay = false;
  _playbackFrameId = null;
  _tickInterval = null;
  _telemetry = { seek: null };
  /** @type {Array<{ts: number, blob: Blob, botStates: Array<Object>}>} sorted ascending */
  _visualCheckpoints = [];
  _visualCheckpointBuildGeneration = 0;
  /** ts -> ImageBitmap. LRU bounded by VISUAL_CHECKPOINT_DECODED_CACHE. */
  _decodedCheckpointCache = new Map();
  /** ts -> Promise<ImageBitmap>. Dedupes concurrent decodes when scrubbing fast. */
  _pendingCheckpointDecode = new Map();
  /** Most-recently requested cp ts (used so async decode skips drawing a stale frame). */
  _activeCheckpointTs = null;
  /** @type {Array<{ts: number, bitmap: ImageBitmap, botStates: Object}>} sorted ascending */
  _dynCheckpoints = [];
  _dynCheckpointInFlight = false;
  _lastDynCheckpointTs = null;
  /** @type {TimeLapseExporter|null} */
  _activeVideoExporter = null;
  /** @type {HTMLCanvasElement|null} in-panel canvas the replay is mirrored into */
  _embedCanvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  _embedCtx = null;

  // ── initialisation ─────────────────────────────────────────────────────────

  /**
   * @param {import('../canvas/Board.js').Board} board
   * @param {import('../network/WebSocketClient.js').WebSocketClient} wsClient
   */
  init(board, wsClient) {
    this._board = board;
    this._wsClient = wsClient;

    this._replayEngine = new ReplayEngine();
    this._replayEngine.init(board.getWidth(), board.getHeight(), wsClient);

    this._replayEngine.onOutputUpdate = () => {
      if (this._replayCtx && this._replayEngine.outputCanvas && this.isReviewing) {
        this._drawToReplayCanvas();
      }
    };

    this._createReplayCanvas();
  }

  _createReplayCanvas() {
    const boardsWrapper = document.getElementById('boards');
    if (!boardsWrapper) {
      console.warn('[TimeMachine] #boards wrapper not found');
      return;
    }

    this._replayCanvas = document.createElement('canvas');
    this._replayCanvas.id = 'replayCanvas';
    this._replayCanvas.width = this._board.getWidth();
    this._replayCanvas.height = this._board.getHeight();
    this._replayCanvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      display: none;
      z-index: 2;
    `;
    this._replayCtx = this._replayCanvas.getContext('2d');
    boardsWrapper.appendChild(this._replayCanvas);
  }

  /**
   * Point replay output at an in-panel canvas (the History "Recent" mini-player).
   * While attached, painting routines mirror the board-sized #replayCanvas into
   * this canvas and the board chrome is left untouched (the modal sits on top).
   * @param {HTMLCanvasElement} canvas
   */
  attachEmbedTarget(canvas) {
    if (!canvas) return;
    this._embedCanvas = canvas;
    this._embedCtx = canvas.getContext('2d');
    this.isEmbedded = true;
    if (this._replayCanvas) {
      canvas.width = this._replayCanvas.width;
      canvas.height = this._replayCanvas.height;
    }
  }

  /** Stop mirroring into the in-panel canvas. */
  detachEmbedTarget() {
    this._embedCanvas = null;
    this._embedCtx = null;
    this.isEmbedded = false;
  }

  /** Mirror the current #replayCanvas pixels into the embed canvas, 1:1. @private */
  _blitToEmbed() {
    if (!this.isEmbedded || !this._embedCtx || !this._embedCanvas || !this._replayCanvas) return;
    if (this._embedCanvas.width !== this._replayCanvas.width ||
        this._embedCanvas.height !== this._replayCanvas.height) {
      this._embedCanvas.width = this._replayCanvas.width;
      this._embedCanvas.height = this._replayCanvas.height;
    }
    this._embedCtx.clearRect(0, 0, this._embedCanvas.width, this._embedCanvas.height);
    this._embedCtx.drawImage(this._replayCanvas, 0, 0);
  }

  _drawToReplayCanvas() {
    if (!this._replayCtx || !this._replayEngine.outputCanvas) return;
    const bgColor = this._board?.backgroundColor || [255, 255, 255, 1];
    this._replayCtx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3]})`;
    this._replayCtx.fillRect(0, 0, this._replayCanvas.width, this._replayCanvas.height);
    this._replayCtx.filter = 'none';
    this._replayCtx.imageSmoothingEnabled = true;
    this._replayCtx.drawImage(this._replayEngine.outputCanvas, 0, 0);
    // Overlay mirror-region guides, then ephemeral vector text (faded by
    // playhead age), then bot cursors on top of the crisp output. Drawn here
    // (not baked into the engine's outputCanvas) so restore-to-live can't
    // stamp them into real board pixels and exports stay artwork-only.
    // Mirrored into the embed canvas by _blitToEmbed below, so the mini-player
    // gets them too.
    this._replayEngine.drawMirrorGuides(this._replayCtx);
    this._replayEngine.drawVectorText(this._replayCtx);
    this._replayEngine.drawCursors(this._replayCtx);
    // Painting from the replay engine output means we're crisp — drop the preview flag.
    // Also clear the active checkpoint ts so any in-flight WebP decode skips its
    // paint (the cached frame would otherwise slam back over this crisp output
    // and resurrect preview mode).
    this._activeCheckpointTs = null;
    this.isPreviewMode = false;
    this._blitToEmbed();
  }

  _drawVisualCheckpoint(cp) {
    if (!cp || !this._replayCtx || !this._replayCanvas) return false;
    this._activeCheckpointTs = cp.ts;

    const cached = this._decodedCheckpointCache.get(cp.ts);
    if (cached) {
      // LRU bump: re-insert so the most-recently-used moves to the end.
      this._decodedCheckpointCache.delete(cp.ts);
      this._decodedCheckpointCache.set(cp.ts, cached);
      this._paintCheckpointBitmap(cached, cp.botStates);
      return true;
    }

    if (!cp.blob) return false;
    this._decodeCheckpointBlob(cp);
    // Leave whatever frame is currently on the replay canvas in place until
    // the decode resolves. Returning true keeps the caller from falling back
    // to a full replay (which would be much slower than a 1–3ms WebP decode).
    return true;
  }

  _paintCheckpointBitmap(bitmap, botStates) {
    const bgColor = this._board?.backgroundColor || [255, 255, 255, 1];
    this._replayCtx.filter = 'none';
    this._replayCtx.imageSmoothingEnabled = true;
    this._replayCtx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3]})`;
    this._replayCtx.fillRect(0, 0, this._replayCanvas.width, this._replayCanvas.height);
    // Bitmap may be downscaled (see VISUAL_CHECKPOINT_MAX_EDGE); upscale to fit.
    this._replayCtx.drawImage(bitmap, 0, 0, this._replayCanvas.width, this._replayCanvas.height);
    this.previewData = true;
    // The blur + "Loading..." overlay in Timebar.svelte keys off this flag.
    this.isPreviewMode = true;
    this._showReplayCanvas(true);
    this._syncBotCursorsFromStates(botStates || []);
    this._blitToEmbed();
  }

  _decodeCheckpointBlob(cp) {
    if (this._pendingCheckpointDecode.has(cp.ts)) return;
    const promise = createImageBitmap(cp.blob)
      .then((bitmap) => {
        this._pendingCheckpointDecode.delete(cp.ts);
        // The recording may have been swapped out while we were decoding.
        if (!this._localRecording || !this.isOpen) {
          bitmap.close?.();
          return;
        }
        this._decodedCheckpointCache.set(cp.ts, bitmap);
        this._evictDecodedCheckpoints();
        // Only paint if this is still the frame the user wants — fast scrubs
        // can issue many decode requests before any of them resolve.
        if (this._activeCheckpointTs === cp.ts) {
          this._paintCheckpointBitmap(bitmap, cp.botStates);
        }
      })
      .catch((err) => {
        this._pendingCheckpointDecode.delete(cp.ts);
        console.warn('[TimeMachine] visual checkpoint decode failed:', err);
      });
    this._pendingCheckpointDecode.set(cp.ts, promise);
  }

  _evictDecodedCheckpoints() {
    while (this._decodedCheckpointCache.size > VISUAL_CHECKPOINT_DECODED_CACHE) {
      // Map iteration order is insertion order, so the first entry is the LRU.
      const oldest = this._decodedCheckpointCache.keys().next().value;
      const bitmap = this._decodedCheckpointCache.get(oldest);
      this._decodedCheckpointCache.delete(oldest);
      bitmap?.close?.();
    }
  }

  /**
   * Replay engine's internal LayerManager. Exposed so the parity harness can
   * diff replayed pixels against live ones without poking at private state.
   * @returns {import('../canvas/LayerManager.js').LayerManager|null}
   */
  getReplayLayerManager() {
    return this._replayEngine?._replayBoard?.layerManager ?? null;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Load checkpoint list from server and open the timebar.
   * Safe to call multiple times — subsequent calls refresh the list.
   */
  async loadFromServer() {
    if (!this._wsClient) return;
    if (this.isLoading) return;

    this.isLoading = true;
    try {
      const data = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._wsClient.messageHandlers.delete('checkpoint_list_response');
          reject(new Error('Checkpoint list request timed out'));
        }, 10_000);

        this._wsClient.on('checkpoint_list_response', (response) => {
          clearTimeout(timeout);
          this._wsClient.messageHandlers.delete('checkpoint_list_response');
          resolve(response);
        });

        this._wsClient.requestCheckpointList();
      });

      this._onCheckpointListReceived(data.checkpoints || []);
    } catch (err) {
      console.error('[TimeMachine] Failed to load from server:', err);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Open the time machine. Online this loads the server checkpoint history;
   * offline (Draw Alone) there is no server, so open the local rolling DVR
   * tape instead. Legacy name kept for backward compat with App.js.
   */
  start() {
    const app = (typeof window !== 'undefined' ? window.app : null);
    if (app?.isOfflineMode) {
      const bundle = app.rollingTapeRecorder?.snapshotRecording?.();
      if (bundle && bundle.deltas?.length) {
        this.loadFromRecording(bundle);
      } else {
        app.ui?.showToast?.('Nothing to replay yet — draw something first', 2500);
      }
      return;
    }
    this.loadFromServer();
  }

  /**
   * Forward a tapped WebSocket message into the active local Recorder, if any.
   * Called by WebSocketClient for both inbound and outbound messages.
   *
   * @param {Object} msg - decoded JSON message
   * @param {'inbound'|'outbound'} direction
   */
  recordAction(msg, direction) {
    const app = (typeof window !== 'undefined' ? window.app : null);
    const dir = direction === 'inbound' ? 'in' : 'out';

    // MIR is a relative toggle on the wire, so replaying it depends on the
    // mirror state being correct at that point — a single dropped MIR (gappy
    // tape, AFK draw-filtering) would invert global mirror for the rest of
    // playback. Stamp the post-toggle absolute state onto our own outbound
    // toggles so the replay engine can re-assert rather than blind-flip. This is
    // reliable only outbound: the local board is toggled before broadcastMirror()
    // runs, and the outbound msg is a throwaway spread (safe to mutate). Inbound
    // MIRs stay relative but self-heal from the periodic absolute SETTINGS.
    if (msg && msg.t === T.MIR && dir === 'out' && app?.board) {
      msg.m = !!app.board.mirror;
    }

    // Automatic rolling DVR tape — always fed while enabled (independent of the
    // manual recorder toggle below). While the replay menu is open the local user
    // is navigating history, not the live board: their own outbound traffic
    // (cursor moves, etc.) must not pollute or advance the live tape. Inbound
    // (other users' real activity) keeps recording so the tape stays current.
    const rolling = app?.rollingTapeRecorder;
    if (rolling?.isEnabled?.() && !(dir === 'out' && this.isOpen)) {
      rolling.record(msg, dir);
    }

    // Manual session tape (topbar tape button).
    const rec = app?.recorder;
    if (!rec?.isRecording?.()) return;
    if (direction === 'inbound') {
      rec.recordIncoming(msg);
    } else {
      rec.recordOutgoing(msg);
    }
  }

  /**
   * Open the timebar against a local Recorder bundle (no server round trip).
   * Wires the replay engine to the recording's asset pool and seeks to the
   * end of the tape.
   *
   * @param {import('../replay/Recorder.js').ReplayRecording} rec
   */
  async loadFromRecording(rec) {
    if (!rec) return;
    if (this.isLoading) return;
    // If a server source was loaded, tear it down first.
    if (this._source === 'server' && this.isOpen) this.stop();

    this.isLoading = true;
    this._source = 'local';
    this._localRecording = rec;
    this._clearDynCheckpoints();
    this._clearVisualCheckpoints();

    // Match the replay engine to the recording's board dimensions. The engine
    // was sized to whatever the live board was at App boot, which is usually
    // the default 1920x1080 — but rooms can have larger boards (e.g. 2560x1440)
    // and the snapshot's canvasData is at the room's actual size.
    const [rh, rw] = Array.isArray(rec.openingSnapshot?.boardDimensions)
      ? rec.openingSnapshot.boardDimensions
      : [this._board?.getHeight?.() ?? 0, this._board?.getWidth?.() ?? 0];
    if (rw && rh) {
      this._replayEngine.resize(rw, rh);
      if (this._replayCanvas) {
        this._replayCanvas.width = rw;
        this._replayCanvas.height = rh;
      }
      if (this._embedCanvas) {
        this._embedCanvas.width = rw;
        this._embedCanvas.height = rh;
      }
    }

    // Build a checkpoint list out of the opening snapshot + intra-checkpoints.
    const checkpoints = [
      { id: 'opening', ts: rec.startedAt, kind: 'opening' },
      ...rec.intraCheckpoints.map((cp, idx) => ({
        id: `intra_${idx}`,
        ts: cp.ts,
        kind: 'intra',
      })),
    ];

    this.checkpoints = checkpoints;
    this.sessionStart = rec.startedAt;
    this.sessionEnd = rec.endedAt ?? Date.now();
    this.currentTime = this.sessionEnd;
    this.clearTrimRange();

    // Asset resolver wires the recording's asset pool into the replay engine.
    // ReplayEngine pipes EVERY image source through this resolver — including
    // plain dataURL strings (the snapshot's canvasData). So we must pass
    // strings through unchanged; only `{ assetRef }` objects get rewritten.
    if (this._replayEngine?.setAssetResolver) {
      this._replayEngine.setAssetResolver((source) => {
        if (!source) return null;
        if (typeof source === 'string') return source;
        if (typeof source === 'object' && source.assetRef) {
          return rec.assets?.[source.assetRef] ?? null;
        }
        return null;
      });
    }

    this.isOpen = false;
    this.isReviewing = false;
    this.isPlaying = false;
    this.isVisible = true;
    this._lastAppliedTimestamp = null;

    // Find users with no UNDO/REDO in the tape and tell the replay engine
    // their strokes can bake immediately. Cuts per-frame composite work on
    // long multi-user tapes where most strokes will never be undone.
    this._replayEngine?.setEagerBakeUsers?.(_collectEagerBakeUsers(rec));

    try {
      // Fast path: the .ddraw file already carries a baked scrub grid. Hydrate
      // `_visualCheckpoints` straight from it, paint the last frame as a
      // blurred preview, then run the replay engine to catch up in the
      // background so future seeks land on full-resolution output.
      const persistedVc = Array.isArray(rec.visualCheckpoints) ? rec.visualCheckpoints : null;
      if (persistedVc && persistedVc.length > 0 && persistedVc.some((cp) => cp?.blob)) {
        this._visualCheckpoints = persistedVc
          .filter((cp) => cp && cp.blob && Number.isFinite(cp.ts))
          .map((cp) => ({ ts: cp.ts, blob: cp.blob, botStates: cp.botStates || [] }))
          .sort((a, b) => a.ts - b.ts);

        this.isOpen = true;
        this.isReviewing = true;
        this._lastAppliedTimestamp = null;
        this.previewData = true;

        // Paint the last cached frame immediately as the initial preview.
        const lastCp = this._visualCheckpoints[this._visualCheckpoints.length - 1];
        if (lastCp) this._drawVisualCheckpoint(lastCp);
        this._showReplayCanvas(true);

        // Kick off full-resolution catch-up to the end of the tape. When it
        // resolves, `_drawToReplayCanvas` will clear isPreviewMode and the
        // overlay disappears. Errors fall back to staying in preview mode.
        //
        // Prefer rebuilding from the nearest intra-checkpoint (a few seconds of
        // deltas) over replaying the WHOLE tape from the opening snapshot —
        // after a heavy session a full replay can take many seconds, which is
        // exactly the lag the user feels on open. Layer-state checkpoints rebuild
        // faithfully (correct undo + complex blends), so they never need the full
        // replay. Only old flat-only recordings with complex blends still do: a
        // flat checkpoint freezes an unbaked complex-blend stroke as its raw
        // colour, so for those we force the opening snapshot (which predates the
        // strokes and reconstructs them through the live composite path).
        const forceFromOpening =
          !_checkpointsCarryLayerState(rec) && _tapeHasComplexBlend(rec);
        this.seek(this.sessionEnd, { forceFromOpening }).catch((err) => {
          console.warn('[TimeMachine] background catch-up failed:', err);
        });

        window.app?.ui?.showToast?.(`Replay loaded (${this._visualCheckpoints.length} preview frames)`, 1800);
      } else {
        await this._buildVisualCheckpoints(rec);
        this.isOpen = true;
        this.isReviewing = true;
        this._lastAppliedTimestamp = this.sessionEnd;
        this._drawToReplayCanvas();
        this._showReplayCanvas(true);
        this._updateBotCursors();
        this.previewData = true;
        window.app?.ui?.showToast?.(`Replay ready (${this._visualCheckpoints.length} frames cached)`, 1800);
      }
    } catch (err) {
      console.warn('[TimeMachine] visual replay cache failed, falling back to live replay:', err);
      this.isOpen = true;
      await this.seek(this.sessionEnd);
    } finally {
      this.isLoading = false;
      this._refitBoardToContainer();
    }
  }

  /**
   * Re-run the board's fit-and-center calculation after a layout change.
   * The chrome-hiding effect in Timebar.svelte applies its body class after
   * Svelte flushes, so we wait a frame before measuring the container.
   * @private
   */
  _refitBoardToContainer() {
    // Don't move the live board's view while the embedded mini-player is up —
    // the board is untouched behind the modal.
    if (this.isEmbedded) return;
    const board = this._board ?? window.app?.board;
    if (!board?.resetView) return;
    if (typeof requestAnimationFrame === 'undefined') {
      board.resetView();
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => board.resetView()));
  }

  /**
   * Clear all state when leaving a room.
   */
  stop() {
    this._seekGeneration += 1;
    this._clearScrubState();
    this.isOpen = false;
    this.isReviewing = false;
    this.isPlaying = false;
    // Reset the bar-expanded toggle so isVisible never reads "a replay is
    // showing" after the session ended. Open paths re-expand it.
    this.isVisible = false;
    this.playbackRate = 1;
    this.clearTrimRange();
    this.isLoading = false;
    this.checkpoints = [];
    this.currentTime = 0;
    this.sessionStart = 0;
    this.sessionEnd = 0;
    this.previewData = null;
    this.isPreviewMode = false;
    this._lastAppliedTimestamp = null;
    this._pendingSeekTimestamp = null;
    this._pendingSeekOptions = null;
    this._pendingPlaybackTimestamp = null;
    this._source = 'server';
    this._localRecording = null;
    this._clearVisualCheckpoints();
    this._clearDynCheckpoints();
    if (this._replayEngine?.setAssetResolver) {
      this._replayEngine.setAssetResolver(null);
    }
    this._showReplayCanvas(false);
    this._removeBotCursors();
    this.detachEmbedTarget();

    // Make sure we don't leave the live WS drain paused after teardown.
    if (this._wsClient) {
      this._wsClient._reviewPaused = false;
      this._flushLiveMessageQueue();
    }

    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    if (this._playbackFrameId) {
      cancelAnimationFrame(this._playbackFrameId);
      this._playbackFrameId = null;
    }
    this._refitBoardToContainer();
  }

  /**
   * Seek to a specific timestamp.
   * @param {number} timestamp
   * @param {{ suppressPlaybackPause?: boolean, forceFromOpening?: boolean }} [options]
   */
  async seek(timestamp, options = {}) {
    if (!this.isOpen) return;
    const { suppressPlaybackPause = false, forceFromOpening = false } = options;

    this.currentTime = this._clampTimestamp(timestamp);

    const wasReviewing = this.isReviewing;
    if (this._source === 'local') {
      // Local recordings have no live edge — the tape ended. Every position
      // shows replay pixels, including the final frame at sessionEnd.
      this.isReviewing = true;
    } else {
      // "At live" = within 60s of sessionEnd (a checkpoint may be ~60s stale)
      this.isReviewing = this.currentTime < (this.sessionEnd - 60_000);
    }

    if (this.isReviewing && !wasReviewing) {
      // Entered review mode — pause live draw-message processing so the live
      // board doesn't keep churning under the replay canvas. Bytes still
      // queue in WebSocketClient; catchUp() drains them.
      if (this._wsClient) this._wsClient._reviewPaused = true;
    } else if (!this.isReviewing && wasReviewing) {
      // Exited review mode — resume + drain.
      if (this._wsClient) {
        this._wsClient._reviewPaused = false;
        this._flushLiveMessageQueue();
      }
    }

    if (this.isReviewing) {
      if (this.isPlaying && !suppressPlaybackPause) {
        this.pause();
      }

      if (this._lastAppliedTimestamp === this.currentTime) {
        this._drawToReplayCanvas();
        this._showReplayCanvas(true);
        this._updateBotCursors();
        this._maybeResumeAfterScrub();
        return;
      }

      if (this._isSeeking) {
        this._pendingSeekTimestamp = this.currentTime;
        // Keep the seek's options with it — dropping them here would strip
        // forceFromOpening off a queued initial catch-up seek and let the
        // retry rebuild from a flat checkpoint (wrong colours for unbaked
        // complex-blend strokes on old flat-format tapes).
        this._pendingSeekOptions = { forceFromOpening };
        this._seekGeneration += 1;
        return;
      }

      this._isSeeking = true;
      const seekGeneration = ++this._seekGeneration;
      try {
        const applied = await this._applyStateAt(this.currentTime, seekGeneration, { forceFromOpening });
        if (!applied || seekGeneration !== this._seekGeneration || !this.isReviewing) return;
        this._showReplayCanvas(true);
        this._updateBotCursors();
      } finally {
        this._isSeeking = false;
        if (this.isOpen && this.isReviewing && this._pendingSeekTimestamp !== null) {
          const next = this._pendingSeekTimestamp;
          const nextOptions = this._pendingSeekOptions;
          this._pendingSeekTimestamp = null;
          this._pendingSeekOptions = null;
          // The pause-if-playing decision already ran when this position was
          // originally requested (and queued). Re-deciding here would pause a
          // playback that a scrub release just resumed.
          this.seek(next, { ...nextOptions, suppressPlaybackPause: true });
        } else {
          // Nothing queued behind this seek — the pipeline has settled on the
          // requested frame, so a scrub release waiting on it can resume now.
          this._maybeResumeAfterScrub();
        }
      }
    } else {
      this._lastAppliedTimestamp = null;
      this._pendingPlaybackTimestamp = null;
      this._showReplayCanvas(false);
      this._removeBotCursors();
      this.previewData = null;
    }
  }

  beginScrub() {
    if (!this.isOpen) return;
    this.isScrubbing = true;
    this._seekGeneration += 1;
    this._pendingSeekTimestamp = null;
    this._pendingSeekOptions = null;
    this._scrubLastRequestedTimestamp = this.currentTime;
    this._scrubLastSeekAt = 0;
    // Remember whether we were mid-playback so we can resume after the scrub
    // (clicking/dragging the timeline shouldn't stop a running replay). A
    // pending deferred resume counts too — grabbing the thumb again before the
    // previous release's frame finished loading shouldn't lose the intent.
    this._wasPlayingBeforeScrub = this.isPlaying || this._resumeAfterSeek;
    this._resumeAfterSeek = false;
    this.pause();
  }

  scrubTo(timestamp) {
    if (!this.isOpen) return;
    if (!this.isScrubbing) this.beginScrub();

    // The scrubber moved, so any pending/in-flight settle upgrade is for a
    // stale position — drop it (and invalidate its paint) before re-evaluating.
    this._cancelScrubSettle();

    const clamped = this._clampTimestamp(timestamp);
    const previous = this._scrubLastRequestedTimestamp ?? this.currentTime;
    const isReverse = clamped < previous;
    this._scrubLastRequestedTimestamp = clamped;

    // Short forward scrubs from the engine's current applied state take the
    // incremental appendActions path (no snapshot reload, no re-replay from a
    // checkpoint) — crisp and fast enough to keep up with the drag. Skip the
    // blurred cached preview so the user sees real frames as they move
    // forward. Long forward jumps fall through to the thumbnail path like
    // backward scrubs do: a live replay of a multi-minute jump can't keep up
    // with a drag, so show the cached frame and let the settle upgrade (or
    // the release seek) render the crisp frame.
    const canIncrementForward =
      this._source === 'local' &&
      !isReverse &&
      this._lastAppliedTimestamp != null &&
      clamped >= this._lastAppliedTimestamp &&
      clamped - this._lastAppliedTimestamp <= FORWARD_SCRUB_PREVIEW_MIN_MS;

    if (
      this._source === 'local' &&
      this._visualCheckpoints.length > 0 &&
      !canIncrementForward
    ) {
      this.currentTime = clamped;
      const cp = this._findVisualCheckpointNear(clamped);
      if (this._drawVisualCheckpoint(cp)) {
        // We're parked on a low-res cached frame. If the user holds here without
        // moving, render the crisp full-resolution frame in the background so
        // the preview upgrades even before the scrubber is released.
        this._scheduleScrubSettle(clamped);
        return;
      }
    }

    let target = clamped;
    if (this._source === 'local' && isReverse) {
      target = this._quantizeScrubTimestamp(clamped);
    }

    this._scrubQueuedTimestamp = target;
    const elapsed = performance.now() - this._scrubLastSeekAt;
    if (elapsed >= LOCAL_REVERSE_SCRUB_INTERVAL_MS || !isReverse) {
      this._flushScrubSeek();
      return;
    }

    if (this._scrubTimer == null) {
      this._scrubTimer = setTimeout(() => {
        this._scrubTimer = null;
        this._flushScrubSeek();
      }, LOCAL_REVERSE_SCRUB_INTERVAL_MS - elapsed);
    }
  }

  /**
   * After the scrubber settles on a thumbnail, render the crisp frame in the
   * background. Superseded by {@link _cancelScrubSettle} as soon as the user
   * moves again, so only a genuinely-held position triggers the upgrade.
   * @param {number} timestamp
   */
  _scheduleScrubSettle(timestamp) {
    if (this._source !== 'local') return;
    this._scrubSettleTimer = setTimeout(() => {
      this._scrubSettleTimer = null;
      // Bail if the user released, moved on, or it's already the crisp frame.
      if (!this.isOpen || !this.isScrubbing) return;
      if (this._scrubLastRequestedTimestamp !== timestamp) return;
      if (this._lastAppliedTimestamp === timestamp) return;

      this._scrubSettleSeeking = true;
      Promise.resolve(this.seek(timestamp)).finally(() => {
        this._scrubSettleSeeking = false;
      });
    }, SCRUB_SETTLE_UPGRADE_MS);
  }

  _cancelScrubSettle() {
    if (this._scrubSettleTimer != null) {
      clearTimeout(this._scrubSettleTimer);
      this._scrubSettleTimer = null;
    }
    // A settle-upgrade seek may already be running; bump the generation so its
    // crisp paint is treated as stale and won't land over the newer thumbnail.
    if (this._scrubSettleSeeking) {
      this._seekGeneration += 1;
      this._scrubSettleSeeking = false;
    }
  }

  endScrub(timestamp = null) {
    if (!this.isOpen) return;
    this.isScrubbing = false;
    this._cancelScrubSettle();
    if (this._scrubTimer != null) {
      clearTimeout(this._scrubTimer);
      this._scrubTimer = null;
    }
    const exact = timestamp == null
      ? (this._scrubLastRequestedTimestamp ?? this.currentTime)
      : this._clampTimestamp(timestamp);
    this._scrubQueuedTimestamp = null;
    this._scrubLastRequestedTimestamp = null;
    // Resume playback if the scrub interrupted a running replay, unless we
    // landed at the very end of the tape. The resume is deferred until the
    // released-on frame has actually been applied (_maybeResumeAfterScrub) —
    // starting the playback clock while the seek is still loading would make
    // it chase a position the engine hasn't rendered yet.
    this._resumeAfterSeek = this._wasPlayingBeforeScrub && exact < this.sessionEnd;
    this._wasPlayingBeforeScrub = false;
    this.seek(exact);
  }

  /**
   * Deferred half of endScrub's resume: called by seek() once the released-on
   * frame has actually been applied (or was already showing), so playback
   * starts from rendered pixels instead of racing a still-loading seek.
   */
  _maybeResumeAfterScrub() {
    if (!this._resumeAfterSeek) return;
    this._resumeAfterSeek = false;
    if (this.isOpen && !this.isScrubbing && this.currentTime < this.sessionEnd) {
      this.play();
    }
  }

  _flushScrubSeek() {
    if (this._scrubQueuedTimestamp == null) return;
    const target = this._scrubQueuedTimestamp;
    this._scrubQueuedTimestamp = null;
    this._scrubLastSeekAt = performance.now();
    this.seek(target);
  }

  // ── playback trim range ─────────────────────────────────────────────────────

  /** Trim start clamped into the session (sessionStart when untrimmed). */
  get effectiveTrimStart() {
    const start = this.sessionStart || 0;
    if (this.trimStart == null) return start;
    return Math.max(start, Math.min(this.trimStart, this.sessionEnd));
  }

  /** Trim end clamped into the session (sessionEnd when untrimmed). */
  get effectiveTrimEnd() {
    if (this.trimEnd == null) return this.sessionEnd;
    return Math.max(this.sessionStart || 0, Math.min(this.trimEnd, this.sessionEnd));
  }

  get hasTrimRange() {
    return this.trimStart != null || this.trimEnd != null;
  }

  /**
   * Set the playback trim range. Either edge may be null to mean "untrimmed".
   * Edges at (or past) the session bounds collapse back to null so the live
   * tick can keep extending sessionEnd without dragging a stale trim along.
   * @param {number|null} start
   * @param {number|null} end
   */
  setTrimRange(start, end) {
    const sStart = this.sessionStart || 0;
    let s = Number.isFinite(start) ? this._clampTimestamp(start) : null;
    let e = Number.isFinite(end) ? this._clampTimestamp(end) : null;
    if (s != null && e != null && s > e) [s, e] = [e, s];
    if (s != null && s <= sStart) s = null;
    if (e != null && e >= this.sessionEnd) e = null;
    this.trimStart = s;
    this.trimEnd = e;
  }

  clearTrimRange() {
    this.trimStart = null;
    this.trimEnd = null;
  }

  _clampTimestamp(timestamp) {
    return Math.max(
      this.sessionStart || 0,
      Math.min(timestamp, this.sessionEnd)
    );
  }

  _quantizeScrubTimestamp(timestamp) {
    const start = this.sessionStart || 0;
    const offset = Math.max(0, timestamp - start);
    return this._clampTimestamp(start + Math.floor(offset / LOCAL_REVERSE_SCRUB_FRAME_MS) * LOCAL_REVERSE_SCRUB_FRAME_MS);
  }

  _clearScrubState() {
    this.isScrubbing = false;
    this._wasPlayingBeforeScrub = false;
    this._resumeAfterSeek = false;
    this._cancelScrubSettle();
    if (this._scrubTimer != null) {
      clearTimeout(this._scrubTimer);
      this._scrubTimer = null;
    }
    this._scrubQueuedTimestamp = null;
    this._scrubLastRequestedTimestamp = null;
  }

  /**
   * Return to the live board state.
   */
  catchUp() {
    this.pause();
    this._seekGeneration += 1;
    this._clearScrubState();
    // Resume processing before draining — otherwise the drain bails out.
    if (this._wsClient) this._wsClient._reviewPaused = false;
    this._flushLiveMessageQueue();

    if (this._source === 'local') {
      // A local recording is a finite tape, not the server's live timeline.
      // The live board has kept processing socket messages while the replay
      // canvas was visible, so leaving the tape should reveal that board.
      this.stop();
      window.app?.updateRecordingButtonState?.();
      return;
    }

    this.sessionEnd = Math.max(this.sessionEnd || 0, Date.now());
    this.currentTime = this.sessionEnd;
    this.isReviewing = false;
    this._lastAppliedTimestamp = null;
    this._pendingSeekTimestamp = null;
    this._pendingSeekOptions = null;
    this._pendingPlaybackTimestamp = null;
    this.previewData = null;
    this._showReplayCanvas(false);
    this._removeBotCursors();
  }

  play() {
    if (!this.isOpen || this.isPlaying) return;
    const trimStart = this.effectiveTrimStart;
    const trimEnd = this.effectiveTrimEnd;
    if (this.currentTime >= trimEnd) {
      // At the true tape end with no trim there's nothing to play. With a trim,
      // pressing play again restarts the trimmed section from its start.
      if (!this.hasTrimRange) return;
      this.currentTime = trimStart;
    } else if (this.hasTrimRange && this.currentTime < trimStart) {
      this.currentTime = trimStart;
    }
    this.isPlaying = true;
    this._playbackStartPerf = performance.now();
    this._playbackStartOffset = this.currentTime;
    this._playbackFrameId = requestAnimationFrame((now) => this._playbackFrame(now));
  }

  /**
   * Change playback speed. Takes effect immediately — if playing, the clock
   * is rebased to the current playhead so the rate switch doesn't jump.
   * @param {number} rate
   */
  setPlaybackRate(rate) {
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) return;
    if (this.isPlaying) {
      this._playbackStartPerf = performance.now();
      this._playbackStartOffset = this.currentTime;
    }
    this.playbackRate = r;
  }

  pause() {
    // An explicit pause cancels any resume still waiting on a scrub-release
    // seek to finish loading. (beginScrub reads the flag before calling this.)
    this._resumeAfterSeek = false;
    this.isPlaying = false;
    if (this._playbackFrameId) {
      cancelAnimationFrame(this._playbackFrameId);
      this._playbackFrameId = null;
    }
    this._pendingPlaybackTimestamp = null;
  }

  /**
   * Request the server to revert the board to a specific timestamp.
   * @param {number} timestamp
   */
  requestUndoTo(timestamp) {
    if (!this._wsClient) return;
    this._wsClient.send({ t: T.MOD_UNDO_TO_STATE, mod_undo_ts: timestamp });
  }

  /**
   * Local-replay equivalent of requestUndoTo: paint the currently-displayed
   * replay state onto the live board and drop back to live view. Only
   * meaningful for client-side recordings (no server coordination). The
   * server is unaware — collaborators would see this as a clear+redraw on
   * any subsequent stroke, so this is really a single-user "rewind my own
   * canvas" operation.
   */
  /**
   * Serialise the active local recording to a .ddraw Blob and trigger a
   * browser download. No-op for server-source replays.
   * @returns {Promise<boolean>} true if a download was triggered
   */
  async exportCurrentRecording() {
    const rec = this._localRecording;
    if (this._source !== 'local' || !rec) {
      window.app?.ui?.showToast?.('No local replay to save', 2000);
      return false;
    }
    try {
      if (!this._ddrawEncodeWorker) this._ddrawEncodeWorker = new DdrawEncodeWorkerClient();
      const blob = await this._ddrawEncodeWorker.encode(rec);
      return await this._saveExportedFile(blob, suggestDdrawFilename(rec), 'Replay', {
        filterName: 'Ddraw Replay',
        extensions: ['ddraw'],
      });
    } catch (err) {
      console.error('[TimeMachine] export failed:', err);
      window.app?.ui?.showToast?.('Could not save replay', 3000, 'error');
      return false;
    }
  }

  /**
   * Persist an exported blob and confirm it to the user. On the Tauri desktop
   * app this routes through a native save dialog (so we learn the chosen path)
   * and the confirmation toast offers "Open file location"; in the browser it
   * falls back to an anchor download, which can't expose a path to reveal.
   * @param {Blob} blob
   * @param {string} filename - Suggested filename.
   * @param {string} label - Human label for the toast, e.g. "Time-lapse".
   * @param {{ filterName?: string, extensions?: string[] }} [opts]
   * @returns {Promise<boolean>} false only if the user cancelled the save.
   * @private
   */
  async _saveExportedFile(blob, filename, label, opts = {}) {
    const ui = window.app?.ui;
    const sizeLabel = blob.size >= 1024 * 1024
      ? `${(blob.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(blob.size / 1024))} KB`;

    if (isTauriDesktop()) {
      const result = await saveBytesViaNativeDialog(blob, {
        suggestedName: filename,
        filterName: opts.filterName,
        extensions: opts.extensions,
      });
      if (!result?.saved) return false; // user dismissed the native dialog
      const path = result.path || null;
      ui?.showSavedFileToast?.(`${label} saved (${sizeLabel})`, {
        onReveal: path ? () => revealPathInDir(path) : null,
      });
      return true;
    }

    // Browser: anchor download. The page never learns the save path, so there's
    // no "open file location" affordance.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    ui?.showSavedFileToast?.(`${label} saved (${sizeLabel})`);
    return true;
  }

  /**
   * Render the active local recording and trigger a browser
   * download. Uses a dedicated ReplayEngine instance so the user's current
   * scrub position is unaffected.
   *
   * @param {{ speed?: number, fps?: number, output?: 'video'|'sequence', region?: {x:number,y:number,width:number,height:number}|null, renderCursors?: boolean, transparentBackground?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async exportTimeLapseVideo(opts = {}) {
    const rec = this._localRecording;
    if (this._source !== 'local' || !rec) {
      window.app?.ui?.showToast?.('No local replay to export', 2000);
      return false;
    }
    if (this.isExportingVideo) return false;

    const speed = Math.max(1, Math.min(240, Number(opts.speed) || 30));
    const fps = Math.max(10, Math.min(60, Math.round(Number(opts.fps) || 30)));
    const output = opts.output === 'sequence' ? 'sequence' : 'video';
    const region = opts.region ?? null;

    this.isExportingVideo = true;
    this.videoExportProgress = 0;
    this._activeVideoExporter = new TimeLapseExporter({
      recording: rec,
      wsClient: this._wsClient,
      speed,
      fps,
      output,
      region,
      // The timeline's trim brackets bound the render too: deltas before the
      // trim start are pre-rolled into the first frame, deltas after the trim
      // end are dropped. Untrimmed passes null = full tape.
      rangeStartTs: this.hasTrimRange ? this.effectiveTrimStart : null,
      rangeEndTs: this.hasTrimRange ? this.effectiveTrimEnd : null,
      renderCursors: opts.renderCursors === true,
      transparentBackground: opts.transparentBackground === true,
      backgroundColor: this._board?.backgroundColor,
      onProgress: (p) => { this.videoExportProgress = p; },
    });

    try {
      const result = await this._activeVideoExporter.export();
      if (!result) {
        window.app?.ui?.showToast?.('Render cancelled', 2000);
        return false;
      }
      const isSequence = result.kind === 'sequence' || output === 'sequence';
      const ext = result.mimeType.includes('webm') ? 'webm' : 'mp4';
      const filename = isSequence
        ? suggestImageSequenceFilename(rec, { speed, fps })
        : suggestVideoFilename(rec, ext, { speed, fps });
      const saveOpts = isSequence
        ? { filterName: 'ZIP Archive', extensions: ['zip'] }
        : { filterName: ext === 'webm' ? 'WebM Video' : 'MP4 Video', extensions: [ext] };
      const saved = await this._saveExportedFile(
        result.blob,
        filename,
        isSequence ? 'Image sequence' : 'Time-lapse',
        saveOpts,
      );
      if (!saved) {
        window.app?.ui?.showToast?.('Render not saved', 2000);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[TimeMachine] render failed:', err);
      window.app?.ui?.showToast?.(`Could not render: ${err.message || err}`, 4000, 'error');
      return false;
    } finally {
      this.isExportingVideo = false;
      this.videoExportProgress = 0;
      this._activeVideoExporter = null;
    }
  }

  cancelVideoExport() {
    if (this._activeVideoExporter) this._activeVideoExporter.cancel();
  }

  /**
   * Tape length (ms) a render will actually cover — the local recording's
   * duration after dead-air removal, bounded by the timeline's trim range.
   * 0 when no local recording is active.
   */
  getRenderTapeDurationMs() {
    if (this._source !== 'local' || !this._localRecording) return 0;
    return compressedTapeDurationMs(
      this._localRecording,
      this.hasTrimRange ? this.effectiveTrimStart : null,
      this.hasTrimRange ? this.effectiveTrimEnd : null,
    );
  }

  async restoreLocalToCurrentState() {
    if (this._source !== 'local' || !this.isReviewing) return;
    const liveBoard = this._board;
    if (!liveBoard) return;
    // One canvas per replay layer, so each live layer is restored on its own
    // instead of the flattened replay output collapsing into layer 0.
    const layers = this._replayEngine?.captureLayerCanvases?.();
    if (!layers?.length) return;

    // Undo point in the viewed recording's time domain, captured before
    // catchUp() resets the playhead.
    const cutTs = this.currentTime;

    // The board is reverted to the replay state at the current position, and
    // the undone tail is CUT from the live history tapes (rolling DVR tape +
    // any in-progress manual recording) — see _truncateLiveTapesAfterUndo.
    // Leaving the tapes intact would keep replaying strokes that no longer
    // exist on the board, so reopening History after an undo showed the whole
    // undone segment as if the undo never happened. When connected the restore
    // still broadcasts as a BOARD_SNAPSHOT_RESTORE so collaborators follow.
    if (window.app?.connected && window.app?.snapshotManager?.broadcastReplayLayerRestore) {
      // The server echoes the sequenced restore back to us without a user id
      // (dodging the recorders' commit self-echo dedup). The truncated tapes
      // already equal the restored state, so swallow that echo instead of
      // re-appending a full board image to the freshly cut tapes.
      window.app.rollingTapeRecorder?.suppressNextInbound?.(T.BOARD_SNAPSHOT_RESTORE);
      window.app.recorder?.suppressNextInbound?.(T.BOARD_SNAPSHOT_RESTORE);
      const sent = await window.app.snapshotManager.broadcastReplayLayerRestore(layers);
      if (sent) {
        this._truncateLiveTapesAfterUndo(cutTs);
        this.catchUp();
        return true;
      }
    }

    liveBoard.clear?.();
    const lm = liveBoard.layerManager;
    const count = Math.min(layers.length, lm?.layerGroups?.length || 0);
    for (let i = 0; i < count; i++) {
      const src = layers[i];
      // Skip transparent layers rather than baking them, as Board.restoreSnapshot
      // does, so empty layers aren't marked occupied.
      const { data } = src.getContext('2d').getImageData(0, 0, src.width, src.height);
      if (!liveBoard._snapshotLayerHasPixels(new Uint8Array(data.buffer))) continue;
      if (lm.layerGroups[i].flatCanvas) lm.restoreLayerFromSnapshot(i, src);
      else lm.addToBaseBin(i, src, 0, 0);
    }
    liveBoard.markCompositeFull?.();
    liveBoard.compositeAllLayers?.();
    this._truncateLiveTapesAfterUndo(cutTs);
    this.catchUp();
    return true;
  }

  /**
   * After a full-board "undo to here", cut the undone tail out of the live
   * history tapes. Both the rolling DVR tape and an in-progress manual
   * recording still hold everything past the undo point; left alone they'd
   * replay strokes that no longer exist (and checkpoints captured after the
   * revert would contradict the buffered deltas — the "undone history stays
   * in the loop" bug). Region undos are NOT truncated: they revert only part
   * of the board, so the rest of the timeline is still valid — the recorded
   * region-restore event keeps those tapes coherent.
   *
   * `cutTs` arrives in the viewed recording's time domain: the rolling tape's
   * compressed activity clock for Recent tapes (`rolling: true`), wall clock
   * for recorder tapes and .ddraw files. Each live tape converts through the
   * rolling deltas' wall stamps as needed; a wall cut that predates the whole
   * rolling window (an old .ddraw) resets/re-bases the tape on the restored
   * board instead.
   * @param {number} cutTs - undo point in this._localRecording's ts domain
   * @private
   */
  _truncateLiveTapesAfterUndo(cutTs) {
    if (!Number.isFinite(cutTs)) return;
    const app = (typeof window !== 'undefined' ? window.app : null);
    const rolling = app?.rollingTapeRecorder;
    const recorder = app?.recorder;

    if (this._localRecording?.rolling) {
      // Map to wall clock BEFORE truncating — the mapping reads the very
      // deltas the truncation drops.
      const cutWall = rolling?.wallTsForVirtual?.(cutTs);
      rolling?.truncateAfter?.(cutTs);
      if (recorder?.isRecording?.() && Number.isFinite(cutWall)) {
        recorder.truncateAfter(cutWall);
      }
    } else {
      if (recorder?.isRecording?.()) recorder.truncateAfter(cutTs);
      rolling?.truncateAfterWall?.(cutTs);
    }
  }

  /**
   * Region variant of {@link restoreLocalToCurrentState}: revert only the given
   * rectangle to the currently-displayed replay state, keeping the rest of the
   * live board as-is. `region` is in board pixels ({x, y, width, height}); null
   * falls back to the full-board restore.
   *
   * Each layer's region is reverted independently. When connected it
   * broadcasts as a region restore; offline it only touches this board.
   * @param {{x:number,y:number,width:number,height:number}|null} region
   */
  async restoreLocalRegionToCurrentState(region) {
    if (!region) return await this.restoreLocalToCurrentState();
    if (this._source !== 'local' || !this.isReviewing) return;
    const liveBoard = this._board;
    const lm = liveBoard?.layerManager;
    if (!liveBoard || !lm) return;
    const layers = this._replayEngine?.captureLayerCanvases?.();
    if (!layers?.length) return;

    const [h, w] = liveBoard.dimensions;
    const rx = Math.max(0, Math.round(region.x));
    const ry = Math.max(0, Math.round(region.y));
    const rw = Math.min(w - rx, Math.round(region.width));
    const rh = Math.min(h - ry, Math.round(region.height));
    if (rw <= 0 || rh <= 0) return;

    if (window.app?.connected && window.app?.snapshotManager?.broadcastReplayLayerRegionRestore) {
      const sent = await window.app.snapshotManager.broadcastReplayLayerRegionRestore(layers, {
        x: rx,
        y: ry,
        width: rw,
        height: rh
      });
      if (sent) {
        this.catchUp();
        return true;
      }
    }

    // A live layer the replay lacks gets a blank source, so its region is
    // still cleared like every other layer's.
    let blank = null;
    const layerSource = (i) => layers[i] || (blank ??= Object.assign(document.createElement('canvas'), { width: w, height: h }));
    await applyRegionRestoreLayers(liveBoard, lm.layerGroups.length, layerSource, false, { sx: rx, sy: ry, sw: rw, sh: rh }, []);
    // Offline/no-broadcast path only. Like the full-board restoreLocalToCurrentState,
    // we do NOT reset the rolling tape here — resetting would discard the entire
    // replay history. When connected, the region restore is broadcast, recorded,
    // and replayed as a timeline event (history preserved); offline there is no
    // recording path, so we leave the existing tape intact.
    this.catchUp();
    return true;
  }

  // ── private helpers ────────────────────────────────────────────────────────

  _onCheckpointListReceived(rawList) {
    const sorted = [...rawList].sort((a, b) => a.ts - b.ts);

    // No server history: replay DB disabled, an empty room history, or the
    // viewer lacks read permission (the server answers all three with an
    // empty list). Opening an empty timeline pinned to "now" would show a
    // dead scrubber — surface it and stay closed instead.
    if (sorted.length === 0) {
      window.app?.ui?.showToast?.('No server history available for this room', 3000);
      console.log('[TimeMachine] Server returned no checkpoints; timeline not opened');
      return;
    }

    this.checkpoints = sorted;
    this.sessionStart = sorted[0].ts;
    this.sessionEnd = sorted[sorted.length - 1].ts;

    this.currentTime = this.sessionEnd;
    this.clearTrimRange();
    // Fresh open starts with the bar expanded; a mid-session list refresh
    // must not override the user's collapse toggle.
    if (!this.isOpen) this.isVisible = true;
    this.isOpen = true;
    this._startLiveTick();

    console.log(`[TimeMachine] Loaded ${sorted.length} server checkpoints`);
  }

  /**
   * Tick sessionEnd forward so the scrubber's live edge stays current.
   * @private
   */
  _startLiveTick() {
    if (this._tickInterval) return;
    this._tickInterval = setInterval(() => {
      if (!this.isReviewing) {
        this.sessionEnd = Date.now();
        this.currentTime = this.sessionEnd;
      }
    }, 5_000);
  }

  /**
   * Apply state at the given timestamp from whichever source is active.
   * @param {number} timestamp
   * @private
   */
  async _applyStateAt(timestamp, seekGeneration = null, options = {}) {
    if (this._source === 'local') {
      return await this._applyStateAtLocal(timestamp, seekGeneration, options);
    } else {
      return await this._fetchAndApplyServerReplay(timestamp, seekGeneration);
    }
  }

  async _buildVisualCheckpoints(rec) {
    if (!rec || !this._replayEngine) return;
    this._clearVisualCheckpoints();
    const generation = ++this._visualCheckpointBuildGeneration;

    const start = rec.startedAt;
    const end = rec.endedAt ?? Date.now();
    const duration = Math.max(1, end - start);
    // Stride out the cache for long recordings so we cap total memory. Short
    // recordings still get a frame per second; longer ones get whatever stride
    // keeps us at or below MAX_COUNT.
    const intervalMs = Math.max(
      VISUAL_CHECKPOINT_INTERVAL_MS,
      Math.ceil(duration / VISUAL_CHECKPOINT_MAX_COUNT),
    );
    const times = [];
    for (let ts = start; ts < end; ts += intervalMs) {
      times.push(ts);
    }
    if (times.length === 0 || times[times.length - 1] !== end) {
      times.push(end);
    }

    const ui = window.app?.ui;
    ui?.showToast?.(`Loading replay... 0/${times.length}`, 60_000);

    await this._replayEngine.loadSnapshot(rec.openingSnapshot);
    const initialized = await this._replayEngine.processActions([], start);
    if (!initialized || generation !== this._visualCheckpointBuildGeneration) return;

    const deltas = rec.deltas ?? [];
    let deltaIdx = 0;
    let lastTarget = start;

    for (let i = 0; i < times.length; i++) {
      const target = times[i];
      const actions = [];
      while (deltaIdx < deltas.length && deltas[deltaIdx].ts <= target) {
        if (deltas[deltaIdx].ts > lastTarget || target === start) {
          actions.push({ timestamp: deltas[deltaIdx].ts, msg: deltas[deltaIdx].msg });
        }
        deltaIdx++;
      }

      if (i > 0 || actions.length > 0) {
        const applied = await this._replayEngine.appendActions(actions, target);
        if (!applied || generation !== this._visualCheckpointBuildGeneration) return;
      }

      await this._captureVisualCheckpoint(target);
      lastTarget = target;

      if (i === 0 || i === times.length - 1 || (i + 1) % 5 === 0) {
        ui?.showToast?.(`Loading replay... ${i + 1}/${times.length}`, 60_000);
      }

      // Yield so the loading toast can paint during long recordings.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    this._setLastApplied(end, deltaIdx === deltas.length ? deltas.length - 1 : null);
  }

  async _captureVisualCheckpoint(timestamp) {
    const src = this._replayEngine?.outputCanvas;
    if (!src) return;
    // Downscale to a temp canvas, then encode as a lossy WebP Blob. WebP keeps
    // alpha so transparent regions of the board stay transparent — the bg fill
    // happens at paint time, not in the cached frame.
    const maxEdge = Math.max(src.width, src.height);
    const scale = maxEdge > VISUAL_CHECKPOINT_MAX_EDGE
      ? VISUAL_CHECKPOINT_MAX_EDGE / maxEdge
      : 1;
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(src, 0, 0, w, h);
    const blob = await new Promise((resolve) => {
      // toBlob falls back to PNG if WebP is unsupported — still smaller than
      // a resident decoded bitmap, just less compressed.
      tmp.toBlob(resolve, 'image/webp', VISUAL_CHECKPOINT_QUALITY);
    });
    if (!blob) return;

    const botStates = this._captureBotCursorStates();
    const existingIdx = this._visualCheckpoints.findIndex((cp) => cp.ts === timestamp);
    if (existingIdx >= 0) {
      // Invalidate any cached decode for the displaced frame.
      const stale = this._decodedCheckpointCache.get(timestamp);
      if (stale) {
        stale.close?.();
        this._decodedCheckpointCache.delete(timestamp);
      }
      this._visualCheckpoints[existingIdx] = { ts: timestamp, blob, botStates };
      return;
    }
    this._visualCheckpoints.push({ ts: timestamp, blob, botStates });
  }

  _captureBotCursorStates() {
    const states = [];
    for (const [id, user] of this._replayEngine?.botUsers ?? []) {
      const x = Number(user?.x);
      const y = Number(user?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      states.push({
        id,
        username: user.username || `User ${id}`,
        role: user.role ?? 0,
        color: Array.isArray(user.color) ? [...user.color] : [100, 100, 100, 1],
        size: user.size || 10,
        tool: user.tool || 'brush',
        x,
        y,
        text: user.text || '',
      });
    }
    return states;
  }

  /**
   * Apply state at `timestamp` by replaying from the nearest local checkpoint.
   *
   * Strategy: find the latest checkpoint with `ts <= timestamp`, load its
   * snapshot into the ReplayEngine, then `processActions()` every delta in
   * `(checkpoint.ts, timestamp]`. ReplayEngine routes those through the real
   * RemoteUserHandler so the output is byte-identical to a fresh live draw.
   *
   * @param {number} timestamp
   * @private
   */
  async _applyStateAtLocal(timestamp, seekGeneration = null, options = {}) {
    const rec = this._localRecording;
    if (!rec || !this._replayEngine) return false;
    // forceFromOpening: ignore all checkpoints (static intra + dynamic) and the
    // incremental fast path, and rebuild by replaying the ENTIRE tape from the
    // opening snapshot. Checkpoint images are baked via getCompositedCanvas with
    // a transparent backdrop, so any still-unbaked complex-blend stroke (e.g.
    // 'difference') is frozen as its raw colour in the checkpoint instead of its
    // displayed, blended-against-background colour. The opening snapshot is the
    // one capture that predates those strokes, so a full replay reconstructs
    // them through the live composite path (which applies the background) and
    // they render correctly. Used on initial open; normal scrubs keep the fast
    // checkpoint path.
    const forceFromOpening = options.forceFromOpening === true;
    const seekStart = performance.now();
    const deltas = rec.deltas ?? [];
    const isStale = () =>
      seekGeneration != null &&
      (seekGeneration !== this._seekGeneration || !this.isOpen || !this.isReviewing);

    // Candidate starting points for replay: the engine's current state
    // (incremental append) vs the best checkpoint at or before the target.
    // Forward seeks must consider checkpoints too — incrementally replaying a
    // +10min jump means pushing minutes of deltas through the engine even
    // though an intra-checkpoint sits ≤30s before the target.
    const staticCp = forceFromOpening ? null : this._findCheckpointBefore(timestamp);
    const dynCp = forceFromOpening ? null : this._findDynCheckpointBefore(timestamp);
    const useDyn = dynCp && (!staticCp || dynCp.ts > staticCp.ts);
    const cpTs = useDyn ? dynCp.ts : (staticCp?.ts ?? rec.startedAt);

    const canIncrement =
      !forceFromOpening &&
      this._lastAppliedTimestamp != null &&
      timestamp >= this._lastAppliedTimestamp &&
      cpTs - this._lastAppliedTimestamp <= FORWARD_SEEK_REBUILD_GAIN_MS;

    if (canIncrement) {
      const lastTs = this._lastAppliedTimestamp;
      const trustedIdx = this._trustedDeltaIdx();
      const startIdx = trustedIdx != null
        ? trustedIdx + 1
        : this._lowerBoundDelta(deltas, lastTs + 1);
      const actions = this._sliceDeltaActions(deltas, startIdx, timestamp);
      const applied = await this._replayEngine.appendActions(actions, timestamp, {
        shouldCancel: isStale,
        // On cancellation the engine keeps whatever it already applied, so
        // record progress as it lands — the retry then continues from there
        // instead of double-applying the whole batch from a stale position.
        onProgress: (k) => this._recordSeekProgress(actions, k),
      });
      if (!applied || isStale()) return false;

      this._setLastApplied(timestamp, actions.length > 0 ? actions[actions.length - 1]._idx : startIdx - 1);
      this._drawToReplayCanvas();
      this.previewData = true;

      const totalMs = (performance.now() - seekStart).toFixed(1);
      this._telemetry.seek = {
        timestamp,
        totalMs: Number(totalMs),
        actionsReplayed: actions.length,
        incremental: true,
      };
      this._maybeLogSeekTelemetry();
      this._maybeCaptureDynCheckpoint(timestamp);
      return true;
    }

    // Rebuild path. Prefer a dynamic in-engine checkpoint over the static
    // intra-checkpoint when one exists later in the tape — that's the whole
    // reason the cache exists. Falls back gracefully if none is closer.
    //
    // Invalidate the position tracker before loading: if this rebuild gets
    // cancelled the engine no longer matches the old position, and a stale
    // tracker would let a later incremental seek append onto wrong state.
    // onProgress below re-establishes it as soon as actions start landing.
    this._setLastApplied(null, null);
    let usedDyn = false;
    let startIdx;
    if (useDyn) {
      await this._replayEngine.loadDynamicCheckpoint(dynCp);
      usedDyn = true;
      // Dyn checkpoints were captured right after applying a known delta, so
      // resume exactly after it; fall back to "first delta later than cpTs"
      // (those at cpTs were applied before capture).
      startIdx = Number.isInteger(dynCp.deltaIdx)
        ? dynCp.deltaIdx + 1
        : this._lowerBoundDelta(deltas, cpTs + 1);
    } else {
      const snapshot = staticCp?.id === 'opening' || !staticCp
        ? rec.openingSnapshot
        : rec.intraCheckpoints[Number(staticCp.id.slice('intra_'.length))]?.snapshot
          ?? rec.openingSnapshot;
      await this._replayEngine.loadSnapshot(snapshot);
      // Static snapshots are captured on a wall-clock timer; a delta at
      // exactly cpTs is ambiguous, so re-apply it (matches prior behavior).
      startIdx = this._lowerBoundDelta(deltas, cpTs);
    }
    if (isStale()) return false;

    const actions = this._sliceDeltaActions(deltas, startIdx, timestamp);

    // Always call processActions — even with no actions, the rebase-snapshot
    // path inside _runActionBatch paints the loaded snapshot pixels into
    // layer 0's flatCanvas and runs _compositeOutput. Skipping this when
    // actions is empty (e.g. seeking to a position right at an intra
    // checkpoint with nothing after it) leaves the replay engine's
    // LayerManager blank.
    const applied = await this._replayEngine.processActions(actions, timestamp, {
      shouldCancel: isStale,
      onProgress: (k) => this._recordSeekProgress(actions, k),
    });
    if (!applied || isStale()) return false;

    this._setLastApplied(timestamp, actions.length > 0 ? actions[actions.length - 1]._idx : startIdx - 1);
    this._drawToReplayCanvas();
    this.previewData = true;

    const totalMs = (performance.now() - seekStart).toFixed(1);
    this._telemetry.seek = {
      timestamp,
      totalMs: Number(totalMs),
      actionsReplayed: actions.length,
      cpKind: usedDyn ? 'dyn' : 'static',
    };
    this._maybeLogSeekTelemetry();
    this._maybeCaptureDynCheckpoint(timestamp);
    return true;
  }

  /**
   * Build the engine action list for deltas[startIdx..] with ts <= timestamp.
   * Each action carries its source index (`_idx`) so progress reporting can
   * track the applied position exactly.
   * @private
   */
  _sliceDeltaActions(deltas, startIdx, timestamp) {
    const actions = [];
    for (let i = Math.max(0, startIdx); i < deltas.length; i++) {
      const d = deltas[i];
      if (d.ts > timestamp) break;
      actions.push({ timestamp: d.ts, msg: d.msg, _idx: i });
    }
    return actions;
  }

  /** First index in deltas (sorted ascending by ts) with ts >= target. @private */
  _lowerBoundDelta(deltas, target) {
    let lo = 0;
    let hi = deltas.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (deltas[mid].ts < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Record both halves of the applied-position tracker atomically. @private */
  _setLastApplied(ts, idx = null) {
    this._lastAppliedTimestamp = ts;
    this._lastAppliedDeltaIdx = idx;
    this._lastAppliedDeltaIdxTs = idx != null ? ts : null;
  }

  /** The applied delta index, or null when it can't be trusted. @private */
  _trustedDeltaIdx() {
    return this._lastAppliedDeltaIdx != null &&
      this._lastAppliedTimestamp != null &&
      this._lastAppliedDeltaIdxTs === this._lastAppliedTimestamp
      ? this._lastAppliedDeltaIdx
      : null;
  }

  /** onProgress handler: mark actions[k] as the last applied delta. @private */
  _recordSeekProgress(actions, k) {
    const a = actions[k];
    if (a) this._setLastApplied(a.timestamp, a._idx);
  }

  /**
   * Fire-and-forget: capture a dynamic checkpoint at the current state if
   * enough tape time has elapsed since the last one and no bot is mid-stroke.
   * Mid-stroke captures would be awkward to resume (active stroke canvases
   * would have to be cloned too), so we just skip and try again on the next
   * settled frame.
   * @param {number} timestamp - The tape timestamp this state represents.
   * @private
   */
  _maybeCaptureDynCheckpoint(timestamp) {
    if (!this._replayEngine || this._dynCheckpointInFlight) return;
    const minInterval = this.isScrubbing
      ? DYN_CHECKPOINT_SCRUB_INTERVAL_MS
      : DYN_CHECKPOINT_DEFAULT_INTERVAL_MS;
    if (
      this._lastDynCheckpointTs != null &&
      Math.abs(timestamp - this._lastDynCheckpointTs) < minInterval
    ) return;

    for (const u of this._replayEngine.botUsers?.values?.() ?? []) {
      if (u?.mousedown) return;
    }

    // The delta index the engine is parked on right now — read synchronously
    // so the async capture below can't pair it with a different state.
    const deltaIdx = this._lastAppliedTimestamp === timestamp ? this._trustedDeltaIdx() : null;

    this._dynCheckpointInFlight = true;
    this._replayEngine.captureDynamicCheckpoint()
      .then((cp) => {
        if (!cp) return;
        // Discard if a different recording was loaded while we were capturing.
        if (!this._localRecording || !this.isOpen) {
          cp.bitmap.close?.();
          return;
        }
        // Insert sorted by ts; replace if same ts already exists.
        const existingIdx = this._dynCheckpoints.findIndex((e) => e.ts === timestamp);
        if (existingIdx >= 0) {
          this._dynCheckpoints[existingIdx].bitmap?.close?.();
          this._dynCheckpoints[existingIdx] = { ts: timestamp, deltaIdx, ...cp };
        } else {
          this._dynCheckpoints.push({ ts: timestamp, deltaIdx, ...cp });
          this._dynCheckpoints.sort((a, b) => a.ts - b.ts);
        }
        this._evictDynCheckpointsAround(timestamp);
        this._lastDynCheckpointTs = timestamp;
      })
      .catch((err) => console.warn('[TimeMachine] dyn checkpoint capture failed:', err))
      .finally(() => { this._dynCheckpointInFlight = false; });
  }

  _evictDynCheckpointsAround(anchorTs) {
    while (this._dynCheckpoints.length > DYN_CHECKPOINT_MAX_COUNT) {
      let dropIdx = 0;
      let farthest = -1;
      for (let i = 0; i < this._dynCheckpoints.length; i++) {
        const distance = Math.abs(this._dynCheckpoints[i].ts - anchorTs);
        if (distance > farthest) {
          farthest = distance;
          dropIdx = i;
        }
      }
      const [dropped] = this._dynCheckpoints.splice(dropIdx, 1);
      dropped?.bitmap?.close?.();
    }
  }

  _findDynCheckpointBefore(ts) {
    let best = null;
    for (const cp of this._dynCheckpoints) {
      if (cp.ts <= ts && (!best || cp.ts > best.ts)) best = cp;
    }
    return best;
  }

  _findVisualCheckpointNear(ts) {
    let best = null;
    let bestDistance = Infinity;
    for (const cp of this._visualCheckpoints) {
      const distance = Math.abs(cp.ts - ts);
      if (distance < bestDistance) {
        best = cp;
        bestDistance = distance;
      }
    }
    return best;
  }

  _clearVisualCheckpoints() {
    this._visualCheckpointBuildGeneration += 1;
    this._visualCheckpoints = [];
    for (const bitmap of this._decodedCheckpointCache.values()) bitmap?.close?.();
    this._decodedCheckpointCache.clear();
    this._pendingCheckpointDecode.clear();
    this._activeCheckpointTs = null;
  }

  _clearDynCheckpoints() {
    for (const cp of this._dynCheckpoints) cp?.bitmap?.close?.();
    this._dynCheckpoints = [];
    this._lastDynCheckpointTs = null;
  }

  /**
   * Request checkpoint image + deltas from the server and play them into the
   * ReplayEngine.
   * @param {number} timestamp - Target replay timestamp
   * @private
   */
  async _fetchAndApplyServerReplay(timestamp, seekGeneration = null) {
    if (this._pendingServerReplay) return false;
    this._pendingServerReplay = true;
    const seekStart = performance.now();
    const isStale = () =>
      seekGeneration != null &&
      (seekGeneration !== this._seekGeneration || !this.isOpen || !this.isReviewing);

    try {
      const data = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._wsClient.messageHandlers.delete('replay_response');
          reject(new Error('Replay request timed out'));
        }, 15_000);

        this._wsClient.on('replay_response', (response) => {
          clearTimeout(timeout);
          this._wsClient.messageHandlers.delete('replay_response');
          resolve(response);
        });

        // Find the checkpoint just before the target and request from there
        const cp = this._findCheckpointBefore(timestamp);
        const startTs = cp ? cp.ts : timestamp - 5 * 60_000;
        this._wsClient.requestReplay(startTs, timestamp);
      });
      if (isStale()) return false;

      if (!data.checkpointImg || data.checkpointImg.length === 0) {
        console.warn('[TimeMachine] Server returned no checkpoint image');
        return false;
      }

      await this._replayEngine.loadCheckpointImage(data.checkpointImg, {
        m: data.mirror,
        mirrorRegions: data.mirrorRegions || []
      });
      if (isStale()) return false;

      const actions = data.deltas?.length
        ? data.deltas.map(d => ({ timestamp: d._ts, msg: d }))
        : [];
      const applied = await this._replayEngine.processActions(actions, timestamp, { shouldCancel: isStale });
      if (!applied || isStale()) return false;

      this._lastAppliedTimestamp = timestamp;

      const totalMs = (performance.now() - seekStart).toFixed(1);
      this._telemetry.seek = {
        timestamp,
        totalMs: Number(totalMs),
        actionsReplayed: data.deltas?.length || 0
      };
      this._maybeLogSeekTelemetry();

      this._drawToReplayCanvas();
      this.previewData = true;

      console.log(`[TimeMachine] Seek to ${new Date(timestamp).toLocaleTimeString()}: checkpoint + ${data.deltas?.length || 0} deltas in ${totalMs}ms`);
      return true;
    } catch (err) {
      console.error('[TimeMachine] Server replay failed:', err);
      return false;
    } finally {
      this._pendingServerReplay = false;
    }
  }

  /**
   * Return the most recent checkpoint with ts <= timestamp, or null.
   * @param {number} timestamp
   * @returns {{id: string, ts: number}|null}
   * @private
   */
  _findCheckpointBefore(timestamp) {
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      if (this.checkpoints[i].ts <= timestamp) {
        return this.checkpoints[i];
      }
    }
    return null;
  }

  _maybeLogSeekTelemetry() {
    const now = performance.now();
    if ((now - this._lastSeekLogAt) < SEEK_TELEMETRY_LOG_INTERVAL_MS) return;
    this._lastSeekLogAt = now;
    const s = this._telemetry.seek;
    if (!s) return;
    console.log(`[TimeMachine] Seek ${s.totalMs}ms (${s.actionsReplayed} actions replayed)`);
  }

  /**
   * Drain any decoded/batched websocket work before revealing the live board.
   * Replay mode does not pause live handling, but the WebSocket client may have
   * a frame-budgeted queue. Draining it here gives "catch up" a crisp edge
   * without doing a destructive full resync.
   * @private
   */
  _flushLiveMessageQueue() {
    const ws = this._wsClient;
    if (!ws || typeof ws._processMessageQueue !== 'function') return;
    if (!Array.isArray(ws._messageQueue) || ws._messageQueue.length === 0) return;
    try {
      ws._processMessageQueue(true);
    } catch (err) {
      console.warn('[TimeMachine] Failed to flush live message queue before catch-up:', err);
    }
  }

  async _playbackFrame(now) {
    if (!this.isPlaying) return;

    const elapsed = (now - this._playbackStartPerf) * this.playbackRate;
    // Playback is bounded by the trim range; an untrimmed tape ends at sessionEnd.
    const playEnd = this.effectiveTrimEnd;
    const targetTime = Math.min(this._playbackStartOffset + elapsed, playEnd);

    if (targetTime >= playEnd) {
      await this.seek(playEnd, { suppressPlaybackPause: true });
      this.pause();
      return;
    }

    await this.seek(targetTime, { suppressPlaybackPause: true });
    if (!this.isPlaying) return;
    this._playbackFrameId = requestAnimationFrame((frameNow) => this._playbackFrame(frameNow));
  }

  // ── canvas overlay ─────────────────────────────────────────────────────────

  _showReplayCanvas(show) {
    // Embedded mode mirrors into an in-panel canvas, so the board-overlay
    // #replayCanvas stays hidden and the live board/chrome are left alone.
    if (this.isEmbedded) {
      if (this._replayCanvas) this._replayCanvas.style.display = 'none';
      return;
    }
    if (this._replayCanvas) {
      this._replayCanvas.style.display = show ? 'block' : 'none';
    }

    window.app?.ui?.remoteUserUI?.setReplayModeActive(show);

    if (this._board) {
      const display = show ? 'none' : 'block';
      if (this._board.viewCanvas) this._board.viewCanvas.style.display = display;
      if (this._board.topCanvas) this._board.topCanvas.style.display = display;
      if (this._board.upperLayersCanvas) {
        // upperLayersCanvas is also hidden/shown by content (Board._setLayerPresent);
        // claim ownership while the replay canvas is up so a live composite can't
        // reveal it over the top, and hand it back on the way out.
        if (show) {
          this._board.upperLayersCanvas.dataset.forceHidden = '1';
        } else {
          delete this._board.upperLayersCanvas.dataset.forceHidden;
        }
        this._board.upperLayersCanvas.style.display = display;
      }

      const userBoards = document.getElementById('userBoards');
      if (userBoards) userBoards.style.display = display;
    }

    this._setRealtimeCursorVisibility(!show);
  }

  _setRealtimeCursorVisibility(visible) {
    const ui = window.app?.ui;
    if (!ui) return;

    if (visible) {
      for (const { element, display } of this._hiddenRealtimeCursorElements) {
        if (element?.style) element.style.display = display;
      }
      this._hiddenRealtimeCursorElements = [];
      return;
    }

    if (this._hiddenRealtimeCursorElements.length > 0) return;

    const hideElement = (element) => {
      if (!element?.style) return;
      this._hiddenRealtimeCursorElements.push({ element, display: element.style.display });
      element.style.display = 'none';
    };

    hideElement(ui.elements?.selfCursor);
    hideElement(ui.elements?.selfCircle);
    hideElement(ui.elements?.selfSquare);
    hideElement(ui.elements?.selfCrosshair);
    hideElement(ui.elements?.selfText);
    hideElement(ui.elements?.selfPressureCircle);
    hideElement(ui.elements?.selfPressureSquare);

    // Remote-user cursor overlays, user-list entries, and group headers are
    // owned by RemoteUserUI.setReplayModeActive(), which _showReplayCanvas()
    // invokes alongside this method. We must NOT hide/capture them here too:
    // setReplayModeActive(true) runs first on open, so the display value we'd
    // record below would already be 'none'. Restoring that stale 'none' on
    // close then re-hides live users that setReplayModeActive(false) had just
    // correctly shown — which left a still-present friend missing from the
    // user list after closing a replay. Only manage chrome that
    // setReplayModeActive does not touch: the self cursor (above) and the
    // list container itself.
    const userListEl = document.getElementById('userList') || document.querySelector('.userList');
    hideElement(userListEl);
  }

  // ── bot cursors ────────────────────────────────────────────────────────────

  _updateBotCursors() {
    const ui = window.app?.ui;
    if (!ui || !this._replayEngine) return;

    this._syncBotCursorsFromStates(this._captureBotCursorStates());
  }

  _syncBotCursorsFromStates(_states) {
    // Bot cursors are now baked directly into the replay output canvas by
    // ReplayEngine.drawCursors (see replay/cursorOverlay.js). That paints
    // them in both the embedded mini-player and the full-board replay, perfectly
    // aligned with the drawing pixels. Tear down any legacy DOM bot cursors and
    // skip creating new ones so they don't render twice.
    if (this._botCursorIds.size > 0) this._removeBotCursors();
  }

  _removeBotCursors() {
    const ui = window.app?.ui;
    if (!ui) return;
    for (const botId of this._botCursorIds) {
      ui.removeRemoteUser(botId);
    }
    this._botCursorIds.clear();
  }
}

export const TimeMachine = new TimeMachineState();
