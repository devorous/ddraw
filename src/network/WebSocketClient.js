/**
 * @fileoverview WebSocket client for real-time communication using Protocol Buffers.
 * Handles connection management, message batching, and binary serialization.
 */

import { T, Tool, ToolNames, ToolToEnum } from '../../shared/MessageTypes.js';
import { packColor, unpackColor } from '../../shared/ColorUtils.js';
import { BOARD_SIZE_PRESETS } from '../../shared/boardSizes.js';
import { normalizeTextFont } from '../config/textFonts.js';
import { normalizeBlendBakeMode, decodeBlendBakeMode } from '../../shared/blendBakeMode.js';
import { ClientIdentity } from './ClientIdentity.js';
import { StrokeFingerprintLog, isCommitType } from '../../shared/StrokeFingerprint.js';

function hasOwnField(message, key) {
  return !!message && Object.prototype.hasOwnProperty.call(message, key);
}

function normalizeRoomBoardSize(boardSize) {
  return BOARD_SIZE_PRESETS[boardSize] ? boardSize : undefined;
}

// ps wire format: quantized to 0.1px, delta-encoded within each packet.
// Keep these helpers in sync with messages.proto `repeated sint32 ps` docs.
const PS_SCALE = 10;
const ACTIVE_STROKE_REPLAY_TYPES = new Set([
  T.MD, T.MM, T.CP, T.CS, T.CT, T.CC, T.CSP, T.CSM, T.CHD, T.CBR,
  T.CTHN, T.CSIM, T.CL, T.CBM, T.GMP, T.GPT, T.IMAGE_TOOL, T.CPM, T.CF, T.CSDM
]);
const ACTIVE_STROKE_STATE_TYPES = new Set([
  T.CP, T.CS, T.CT, T.CC, T.CSP, T.CSM, T.CHD, T.CBR,
  T.CTHN, T.CSIM, T.CL, T.CBM, T.GMP, T.GPT, T.IMAGE_TOOL, T.CPM, T.CF, T.CSDM
]);

/**
 * Encode an absolute float [x0, y0, x1, y1, ...] array into quantized sint32
 * delta-encoded form. First pair absolute, rest deltas from previous pair.
 * Returns a new array — does not mutate input.
 * @param {number[]} floats
 * @returns {number[]}
 */
function encodePs(floats) {
  const n = floats.length;
  if (n < 2) return [];
  const out = new Array(n);
  let prevX = Math.round(floats[0] * PS_SCALE);
  let prevY = Math.round(floats[1] * PS_SCALE);
  out[0] = prevX;
  out[1] = prevY;
  for (let i = 2; i < n; i += 2) {
    const qx = Math.round(floats[i] * PS_SCALE);
    const qy = Math.round(floats[i + 1] * PS_SCALE);
    out[i] = qx - prevX;
    out[i + 1] = qy - prevY;
    prevX = qx;
    prevY = qy;
  }
  return out;
}

/**
 * Decode quantized delta-encoded sint32 array back to absolute float pixels.
 * @param {number[]} ints
 * @returns {number[]}
 */
function decodePs(ints) {
  const n = ints.length;
  if (n < 2) return [];
  const out = new Array(n);
  let accX = ints[0];
  let accY = ints[1];
  out[0] = accX / PS_SCALE;
  out[1] = accY / PS_SCALE;
  for (let i = 2; i < n; i += 2) {
    accX += ints[i];
    accY += ints[i + 1];
    out[i] = accX / PS_SCALE;
    out[i + 1] = accY / PS_SCALE;
  }
  return out;
}

/**
 * WebSocketClient manages the bidirectional binary communication with the server.
 * It uses Protocol Buffers for efficient serialization and handles high-frequency
 * message batching to maintain UI performance.
 */
export class WebSocketClient {
  /**
   * @param {Object} [options={}] - Configuration options.
   * @param {Function} [options.onConnect] - Callback for successful connection.
   * @param {Function} [options.onDisconnect] - Callback for disconnection.
   * @param {string} [options.serverUrl] - Optional explicit server URL.
   */
  constructor(options = {}) {
    /** @type {WebSocket|null} */
    this.socket = null;
    /** @type {number|null} */
    this.sessionIndex = null;
    /**
     * Per-session log of commit-class messages keyed by server-assigned seq.
     * Mirrors `room.strokeLog` on the server; the two must stay in lockstep
     * for parity checks to mean anything (Phase 1: populated only, no
     * outbound parity protocol yet).
     * @type {StrokeFingerprintLog}
     */
    this.strokeLog = new StrokeFingerprintLog();
    /** @type {string} */
    this.instanceId = '';
    /** @type {boolean} */
    this.connected = false;
    /** @type {Map<string, Function>} */
    this.messageHandlers = new Map();
    /** @type {Function|null} */
    this.onConnect = options.onConnect || null;
    /** @type {Function|null} */
    this.onConnectResumed = options.onConnectResumed || null;
    /** @type {Function|null} */
    this.onDisconnect = options.onDisconnect || null;
    /** @type {Function|null} */
    this.onConnectionInterrupted = options.onConnectionInterrupted || null;
    /** @type {string} */
    this.resumeKey = this._generateResumeKey();
    /** @type {string|null} */
    this.serverUrl = options.serverUrl || null;
    /** @type {Object|null} */
    this.Msg = null;
    /** @type {boolean} */
    this.protoLoaded = false;
    /** @type {number|null} */
    this._reconnectTimer = null;

    /**
     * @private
     * @type {Array<Object>}
     */
    this._messageQueue = [];
    /**
     * @private
     * @type {boolean}
     */
    this._processingScheduled = false;

    /**
     * Whether the currently-scheduled drain was armed on the hidden-tab
     * (microtask) path. Lets `_scheduleProcessing` notice that visibility
     * changed under a pending drain and re-arm on the right one.
     * @private
     * @type {boolean}
     */
    this._processingScheduledHidden = false;

    /**
     * Measurement-only inbound MM thinning factor; see `_processMessage`.
     * @private
     * @type {number}
     */
    this._debugMmKeepEveryN = 1;
    /** @private @type {Map<number, number>} */
    this._debugMmSeen = new Map();
    /** @private @type {number} */
    this._debugMmDropped = 0;

    /**
     * In-flight server history backfill, accumulated between
     * HISTORY_BACKFILL_BEGIN and _END. Null when none is streaming. See
     * {@link WebSocketClient._handleHistoryBackfill}.
     * @private
     * @type {{anchorTs: number, anchorLayers: Array, expected: number, frames: Array}|null}
     */
    this._historyBackfill = null;

    /**
     * @private
     * @type {Set<number>}
     */
    this._batchableMessages = new Set([
      // Drawing events — must stay in receive order relative to each other.
      // KP/TEXT_APPLY must queue with MD/MU so remote text commits can't race
      // with stale or future pointer events.
      T.MM, T.MD, T.MU, T.KP, T.TEXT_APPLY, T.TEXT_REMOVE, T.CP, T.CS, T.CT, T.CC,
      T.CSP, T.CSM, T.CHD, T.CBR, T.CL, T.CBM, T.CANCEL, T.CF,
      // Tool-parameter changes that affect how an in-progress stroke is rendered.
      // Must stay ordered with the drawing events above.
      T.CTHN, T.CSIM, T.GMP, T.GPT, T.IMAGE_TOOL, T.CPM, T.CSDM,
      // Canvas-state operations that mutate the stroke history.
      // These MUST be queued so they execute AFTER any drawing events (MD/MM/MU)
      // that preceded them in real time.  If they bypass the queue they can
      // execute on a stale stroke stack while the tab is hidden (rAF-throttled),
      // causing a different stroke history than every other client (desync).
      T.UNDO, T.REDO, T.CLR, T.FILL,
      // Selection operations — all mutate canvas state in ways that must stay
      // ordered with the surrounding drawing events.
      T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_DELETE, T.SEL_FILL,
      T.SEL_STAMP, T.SEL_CANCEL, T.SEL_TO_BRUSH, T.SEL_FLIP, T.SEL_MERGE, T.SEL_PENDING, T.SEL_MASK, T.OBSCURE_REGION,
      // Image paste and async computation results must also respect draw order.
      T.IMG_PASTE, T.GLITCH_RESULT,
      // SYNC_COMPLETE means "everything I sent you has been sent", so it must be
      // applied AFTER everything already received — the same ordering rule as the
      // canvas-state ops above, for the same reason.
      //
      // Processed on arrival it did the opposite. The join serve pushes the whole
      // tail (MD/MM/MU/tool-state — all queued here) and then SYNC_COMPLETE in one
      // synchronous pass, so SYNC_COMPLETE skipped the queue and beat the entire
      // tail to the handler: measured 5.9ms vs 7.1ms for the first tail frame.
      // SyncClient.handleSyncComplete then ran with an EMPTY eventBuffer, cleared
      // `buffering`, and replayBuffer() no-opped — after which the tail drained
      // onto the LIVE path instead of the replay path.
      //
      // For a fresh joiner that was invisible: the tail is authored by someone
      // else, so the live path draws it correctly and replayBuffer's dedup and
      // ordering work was simply never exercised. For a RESYNC it was fatal —
      // the tail is the requester's own work, and the live path exists to discard
      // self-echoes, so the client that drew everything resynced to a blank board.
      T.SYNC_COMPLETE,
    ]);

    this.clientIdentity = new ClientIdentity();
    this._activeStrokeReplay = [];
    this._trackingActiveStroke = false;
    this._latestStrokeStateMessages = new Map();

    this._boundSendClientStatus = () => {
      this._sendClientStatus();
      // Going hidden kills any pending requestAnimationFrame drain, and coming
      // back makes rAF the better path again. Either way, re-arm the drain for
      // the visibility we now have — nothing else will if no further message
      // arrives. See _scheduleProcessing.
      if (this._messageQueue.length > 0) this._scheduleProcessing();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._boundSendClientStatus);
    }
  }

  _cloneReplayMessage(data) {
    const copy = { ...data };
    if (Array.isArray(data.ps)) copy.ps = data.ps.slice();
    if (Array.isArray(data.rs)) copy.rs = data.rs.slice();
    if (data.img instanceof Uint8Array) copy.img = data.img.slice();
    return copy;
  }

  _trackActiveStrokeMessage(data) {
    if (!data || data.tu !== undefined) return;
    if (ACTIVE_STROKE_STATE_TYPES.has(data.t)) {
      this._latestStrokeStateMessages.set(data.t, this._cloneReplayMessage(data));
    }
    if (data.t === T.MD) {
      this._trackingActiveStroke = true;
      this._activeStrokeReplay = [
        ...this._latestStrokeStateMessages.values(),
        this._cloneReplayMessage(data)
      ];
      return;
    }
    if (data.t === T.MU || data.t === T.CANCEL) {
      this._trackingActiveStroke = false;
      this._activeStrokeReplay = [];
      return;
    }
    if (this._trackingActiveStroke && ACTIVE_STROKE_REPLAY_TYPES.has(data.t)) {
      this._activeStrokeReplay.push(this._cloneReplayMessage(data));
    }
  }

  _encodeChatImageDataUrl(imageData, maxBytes = 5 * 1024 * 1024) {
    if (typeof imageData !== 'string') {
      return { ok: false, error: 'Invalid chat image data' };
    }

    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(imageData);
    if (!match) {
      return { ok: false, error: 'Invalid chat image format' };
    }

    try {
      const base64Data = match[2].replace(/\s+/g, '');
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      if (bytes.length === 0) {
        return { ok: false, error: 'Chat image is empty' };
      }

      if (bytes.length > maxBytes) {
        return { ok: false, error: 'Chat image is too large' };
      }

      return { ok: true, bytes };
    } catch {
      return { ok: false, error: 'Failed to encode chat image' };
    }
  }

  /**
   * Generates a per-page-instance resume key for same-session reattach across
   * brief socket drops. Kept in memory only so a page reload always falls
   * through to a fresh sync rather than resuming into a blank canvas.
   * @private
   * @returns {string}
   */
  _generateResumeKey() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch {}
    return `rk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Lazy-loads the Protocol Buffer schema.
   * @returns {Promise<void>}
   */
  async loadProto() {
    if (this.protoLoaded) return;

    try {
      const protobuf = await import('protobufjs');
      const protoUrl = `../messages.proto?v=${Date.now()}`;
      const response = await fetch(protoUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to fetch protobuf schema: ${response.status}`);
      }
      const protoSource = await response.text();
      const root = protobuf.default.parse(protoSource).root;
      this.Msg = root.lookupType('Msg');
      this.protoLoaded = true;
    } catch (err) {
      console.error('Failed to load protobuf:', err);
      throw err;
    }
  }

  /**
   * Establishes a WebSocket connection to the server.
   *
   * @param {Object} userData - User identification data.
   * @param {string|null} [roomId=null] - The room ID to join.
   * @returns {Promise<void>}
   */
  async connect(userData, roomId = null) {
    await this.loadProto();

    this._clearReconnectTimer();

    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onopen = null;
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close();
      }
      this.socket = null;
    }
    this.connected = false;
    this.sessionIndex = null;

    this._userData = userData;
    this._roomId = roomId;
    this._identityPayload = await this.clientIdentity.getPayload({ waitForFingerprintMs: 1200 });
    this._connectAttempts = 0;
    this._cancelled = false;
    this._disconnectNotified = false;
    this._stealthRetryStartedAt = null;
    this._interruptionNotified = false;

    this._buildUrl();
    this._tryConnect();
  }

  /**
   * Internal helper to construct the WebSocket URL based on environment.
   * @private
   * @returns {void}
   */
  _buildUrl() {
    let baseUrl;
    if (this.serverUrl) {
      baseUrl = this.serverUrl;
    } else {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const currentPort = window.location.port;

      if (currentPort === '3000') {
        // In Vite dev we proxy WebSocket traffic through `/ws`, which keeps the
        // client aligned with the current origin instead of assuming the backend
        // is directly reachable at localhost:8000 from the browser.
        baseUrl = `${wsProtocol}://${window.location.host}/ws`;
      } else {
        baseUrl = import.meta.env.VITE_WS_SERVER_URL || `${wsProtocol}://${window.location.host}`;
      }
    }

    try {
      const url = new URL(baseUrl);
      if (this._roomId) {
        url.searchParams.set('room', this._roomId);
      }
      if (this._identityPayload?.clientDeviceId) {
        url.searchParams.set('deviceId', this._identityPayload.clientDeviceId);
      }
      if (this._identityPayload?.clientFingerprintId) {
        url.searchParams.set('fingerprintId', this._identityPayload.clientFingerprintId);
      }
      if (this._identityPayload?.clientIdentityJson) {
        url.searchParams.set('identity', this._identityPayload.clientIdentityJson);
      }
      const appVersion = String(window.APP_VERSION || '').trim();
      if (appVersion) {
        url.searchParams.set('v', appVersion);
      }
      this._url = url.toString();
    } catch (err) {
      this._url = baseUrl;
      if (this._roomId) {
        const separator = this._url.includes('?') ? '&' : '?';
        this._url += `${separator}room=${encodeURIComponent(this._roomId)}`;
      }
      const extraParams = [];
      if (this._identityPayload?.clientDeviceId) {
        extraParams.push(`deviceId=${encodeURIComponent(this._identityPayload.clientDeviceId)}`);
      }
      if (this._identityPayload?.clientFingerprintId) {
        extraParams.push(`fingerprintId=${encodeURIComponent(this._identityPayload.clientFingerprintId)}`);
      }
      if (this._identityPayload?.clientIdentityJson) {
        extraParams.push(`identity=${encodeURIComponent(this._identityPayload.clientIdentityJson)}`);
      }
      const appVersion = String(window.APP_VERSION || '').trim();
      if (appVersion) {
        extraParams.push(`v=${encodeURIComponent(appVersion)}`);
      }
      if (extraParams.length) {
        const separator = this._url.includes('?') ? '&' : '?';
        this._url += `${separator}${extraParams.join('&')}`;
      }
    }
  }

  /**
   * Initiates the connection attempt and sets up event listeners.
   * @private
   * @returns {void}
   */
  _tryConnect() {
    if (this._cancelled) return;
    this._clearReconnectTimer();
    if (this.socket && (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )) {
      return;
    }

    this._connectAttempts++;
    this.socket = new WebSocket(this._url);
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = async () => {
      this._clearReconnectTimer();
      this.connected = true;
      this._connectAttempts = 0;
      this._disconnectNotified = false;
      this._stealthRetryStartedAt = null;
      this._interruptionNotified = false;
      const username = this._userData.username || this._userData.name || '';
      const identityPayload = await this.clientIdentity.getPayload({ waitForFingerprintMs: 1200 });
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.send({ t: T.CONNECT, n: username, resumeKey: this.resumeKey, ...identityPayload });

      // Replay a recent bandwidth measurement so the new room/server has a
      // baseline before the next probe tick. Cached by _runProbe echo handler.
      try {
        const cached = JSON.parse(localStorage.getItem('topDrawUploadBps') || 'null');
        if (cached && typeof cached.bps === 'number' && cached.bps > 0) {
          const age = Date.now() - (cached.ts || 0);
          if (age < 10 * 60_000) {
            this.send({ t: T.BW_REPORT, uploadBps: Math.round(cached.bps) });
          }
        }
      } catch (_) {}
    };

    this.socket.onmessage = (event) => {
      try {
        const raw = new Uint8Array(event.data);

        if (raw.length > 4 && raw[0] !== 0x08) {
          this._decodeBatchedFrame(raw);
        } else {
          const data = this.Msg.decode(raw);
          // Reconstruct absolute float points from quantized deltas on the wire.
          if (Array.isArray(data.ps) && data.ps.length >= 2) {
            data.ps = decodePs(data.ps);
          }

          this.handleMessage(data, raw);
        }
      } catch (err) {
        console.error('Failed to decode message:', err);
      }
    };

    this.socket.onclose = (event) => {
      this.connected = false;

      const isRestart = event.code === 4000 || String(event.reason || '').includes('server-restarting');
      const wasInSession = this.sessionIndex !== null;

      // Mid-session drops on transient codes get a silent reconnect window
      // before we surface the loud disconnection banner. WebSocket abnormal
      // closures (1006) and going-away (1001) are the common wifi/proxy hiccups.
      const TRANSIENT_CLOSE_CODES = new Set([1001, 1005, 1006, 1011, 1012, 1013]);
      const isTransientDrop = wasInSession && TRANSIENT_CLOSE_CODES.has(event.code);

      if (isTransientDrop && this._stealthRetryStartedAt === null) {
        this._stealthRetryStartedAt = Date.now();
      }
      const STEALTH_RETRY_WINDOW_MS = 30_000;
      const withinStealthWindow = isTransientDrop
        && (Date.now() - this._stealthRetryStartedAt) < STEALTH_RETRY_WINDOW_MS;

      // During the stealth window, just flash a subtle status indicator once.
      // The loud banner is held back so a 1–3s wifi blip doesn't yank the user.
      if (withinStealthWindow && !this._interruptionNotified && this.onConnectionInterrupted) {
        this._interruptionNotified = true;
        this.onConnectionInterrupted(event.code, event.reason);
      }

      // Surface the loud disconnect UI once per cycle, but skip during stealth.
      const shouldSurfaceDisconnect = !this._disconnectNotified && !withinStealthWindow;
      if (shouldSurfaceDisconnect && this.onDisconnect) {
        this._disconnectNotified = true;
        this.onDisconnect(event.code, event.reason);
      }

      // Auto-retry while we've never connected (sessionIndex still null), when
      // the server explicitly told us it's restarting (code 4000), or during
      // the stealth window for a transient mid-session drop.
      const shouldAutoRetry = this._shouldRetryConnect(event)
        && (this.sessionIndex === null || isRestart || withinStealthWindow);

      if (shouldAutoRetry) {
        if (isRestart) {
          // Treat as a fresh connection cycle so onopen → CONNECT runs again.
          this.sessionIndex = null;
        }
        // Cap delay at 5s; retry indefinitely so prolonged server restarts
        // (e.g. slow deploys) eventually reconnect on their own.
        const delay = Math.min(1000 * Math.max(this._connectAttempts, 1), 5000);
        this._clearReconnectTimer();
        this._reconnectTimer = window.setTimeout(() => {
          this._reconnectTimer = null;
          this._tryConnect();
        }, delay);
      }
    };

    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  /**
   * Clears any pending reconnect timer.
   * @private
   * @returns {void}
   */
  _clearReconnectTimer() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Determines whether a closed connection should be retried automatically.
   * @private
   * @param {CloseEvent} event
   * @returns {boolean}
   */
  _shouldRetryConnect(event) {
    if (this._cancelled) return false;

    const nonRetryableCodes = new Set([
      1000, // Normal closure
      1008, // Policy violation / throttled before handshake
      4001, // Banned
      4002, // Kicked
      4003, // Room full
      4009, // Version mismatch
      4401, // Unauthorized
      4408  // Rate limit exceeded
    ]);

    return !nonRetryableCodes.has(event.code);
  }

  /**
   * Routes incoming messages to batching or immediate processing.
   *
   * @param {Object} data - The decoded message payload.
   * @returns {void}
   */
  handleMessage(data, raw = null) {
    if (this._batchableMessages.has(data.t)) {
      // The TimeMachine tap happens at DRAIN time, not here: the queue may
      // still hold earlier undrained messages, and tapping on arrival would
      // write this message into the replay tape ahead of messages that are
      // applied before it. (Live rendering hides that reorder because stroke
      // compositing sorts by seq; replay applies the tape order literally, so
      // order-sensitive actions like UNDO/REDO would target the wrong stroke.)
      this._messageQueue.push(raw ? { data, raw } : data);
      this._scheduleProcessing();
      return;
    }
    this._tapInbound(data, raw);
    this._processMessage(data);
  }

  /**
   * How many inbound messages are decoded but not yet applied.
   *
   * The drain runs on a time budget, so under load this is the amount by which
   * this client's board trails the server's stream. LayerManager consults it
   * before the irreversible overflow bake: baking a prefix while commits that
   * belong inside it are still queued flattens a different prefix than a client
   * that is caught up, and the two boards can never converge afterwards.
   * @returns {number}
   */
  getInboundQueueLength() {
    return this._messageQueue.length;
  }

  /**
   * Records an inbound message on the TimeMachine tap and the stroke
   * fingerprint log. Must be called in APPLICATION order — immediately before
   * the message is processed — so replay tapes are faithful to what the live
   * canvas did.
   *
   * Stroke fingerprint log gating: hash the exact wire bytes the server
   * hashed, and only for sequenced broadcasts (seq ≥ 1). Commit-type messages
   * delivered out-of-band without a seq (e.g. the private join-sync
   * BOARD_SNAPSHOT_RESTORE) must NOT be logged, or they'd appear as a phantom
   * seq:0 "extra" and desync parity permanently (the old
   * COMPRESS_USER_STROKES failure mode).
   *
   * @private
   * @param {Object} data - Decoded message.
   * @param {Uint8Array|null} raw - Exact wire bytes for this single message.
   * @returns {void}
   */
  _tapInbound(data, raw) {
    if (window.app?.TimeMachine) {
      window.app.TimeMachine.recordAction(data, 'inbound');
    }
    if (raw && isCommitType(data.t) && data.seq) {
      this.strokeLog.record({
        seq: data.seq,
        t: data.t,
        userId: data.u,
        bytes: raw,
      });
      const _sq = Number(data.seq);
      if (_sq > this.lastProcessedSeq) this.lastProcessedSeq = _sq;
    }
  }

  /**
   * Accumulate the server's post-join history backfill and hand it to the
   * rolling tape recorder.
   *
   * The server archives the ~2 minutes of drawing that a joiner missed
   * (server/RoomHistory.js) and streams it here in chunks once the board is
   * already up, so "History → Recent" is populated immediately instead of
   * staying blank until the joiner has been in the room for two minutes.
   *
   * Frames arrive as the original wire bytes and are decoded here, one chunk
   * per tick, rather than all at once at the end — a busy room's backfill can
   * be thousands of frames and the server already paces the chunks to spread
   * that cost. Nothing is applied until END: a connection that drops mid-stream
   * leaves the tape exactly as it was rather than half-extended.
   *
   * @private
   * @param {Object} data - HISTORY_BACKFILL_BEGIN / _CHUNK / _END
   */
  _handleHistoryBackfill(data) {
    if (data.t === T.HISTORY_BACKFILL_BEGIN) {
      // A blank base carries no image on purpose: the session started on an
      // empty board, which is a perfectly good thing to replay onto.
      const blank = !!data.historyBlankBase;
      const layers = data.snapshotLayers;
      if (!blank && (!Array.isArray(layers) || layers.length === 0)) {
        this._historyBackfill = null;
        return;
      }
      this._historyBackfill = {
        anchorTs: Number(data.snapshotTs) || Date.now(),
        anchorLayers: blank ? null : layers,
        anchorBlank: blank,
        expected: Number(data.historyTotal) || 0,
        frames: [],
      };
      return;
    }

    const pending = this._historyBackfill;
    if (!pending) return;

    if (data.t === T.HISTORY_BACKFILL_CHUNK) {
      for (const frame of data.historyFrames || []) {
        if (!frame?.data || frame.data.length === 0) continue;
        try {
          const msg = this.Msg.decode(frame.data);
          // Same fixup the live drain applies to batched frames: point streams
          // travel delta-encoded on the wire.
          if (Array.isArray(msg.ps) && msg.ps.length >= 2) msg.ps = decodePs(msg.ps);
          pending.frames.push({ ts: Number(frame.ts) || pending.anchorTs, msg });
        } catch (err) {
          // One unreadable frame shouldn't cost the whole window; the tape just
          // replays that stroke incompletely.
          console.warn('[History] Failed to decode backfill frame:', err);
        }
      }
      return;
    }

    // HISTORY_BACKFILL_END
    this._historyBackfill = null;
    const recorder = window.app?.rollingTapeRecorder;
    if (!recorder?.seedFromBackfill) return;
    const seeded = recorder.seedFromBackfill({
      anchorTs: pending.anchorTs,
      anchorLayers: pending.anchorLayers,
      anchorBlank: pending.anchorBlank,
      frames: pending.frames,
    });
    if (seeded) {
      console.log(`[History] Seeded rolling tape with ${pending.frames.length} backfilled frame(s)`);
    }
  }

  _parseFloatingGalleryVoronoi(rawJson) {
    if (!rawJson) return null;
    try {
      const parsed = JSON.parse(rawJson);
      if (!parsed || !Array.isArray(parsed.lines)) return null;
      return {
        ...parsed,
        lines: parsed.lines.filter(line => (
          Number.isFinite(line?.x1) &&
          Number.isFinite(line?.y1) &&
          Number.isFinite(line?.x2) &&
          Number.isFinite(line?.y2)
        )),
        siteMarkers: Array.isArray(parsed.siteMarkers)
          ? parsed.siteMarkers.filter(site => Number.isFinite(site?.x) && Number.isFinite(site?.y))
          : []
      };
    } catch (err) {
      console.warn('[WebSocketClient] Failed to parse floating gallery Voronoi payload', err);
      return null;
    }
  }

  /**
   * Schedules message queue processing on the next animation frame.
   *
   * `_processingScheduled` must be re-armed when the tab's visibility changes
   * under an already-scheduled drain. Chrome never services a pending
   * requestAnimationFrame once the tab is backgrounded, so a drain scheduled
   * while visible dies at that moment — and with the flag latched true, every
   * later `_scheduleProcessing()` call short-circuited and the hidden-tab
   * microtask path could never take over. The queue then grew unread for as
   * long as the tab stayed hidden: measured 160 undrained messages, including
   * the SYNC_COMPLETE that a joiner needs to release `syncing` (so local input
   * stayed blocked and nothing the peers drew ever landed).
   *
   * @private
   * @returns {void}
   */
  _scheduleProcessing() {
    const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    // Already scheduled on the path that matches the current visibility.
    if (this._processingScheduled && this._processingScheduledHidden === isHidden) return;

    this._processingScheduled = true;
    this._processingScheduledHidden = isHidden;
    if (isHidden) {
      const defer = typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (fn) => Promise.resolve().then(fn);
      // Hidden tabs heavily throttle timers/rAF; drain promptly to avoid
      // multi-second remote stroke stalls and segment jumps.
      defer(() => this._processMessageQueue(true));
    } else {
      requestAnimationFrame(() => this._processMessageQueue(false));
    }
  }

  /**
   * Decodes a length-delimited batched frame.
   * Instead of decoding all messages synchronously (which blocks the main
   * thread on slow devices), slices the raw bytes for each message and pushes
   * them into the queue as Uint8Arrays. They are decoded lazily under the
   * time budget in _processMessageQueue.
   * @private
   * @param {Uint8Array} raw - Raw binary data.
   * @returns {void}
   */
  _decodeBatchedFrame(raw) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let offset = 0;
    while (offset + 4 <= raw.length) {
      const len = view.getUint32(offset);
      offset += 4;
      if (offset + len > raw.length) break;
      // slice() copies the bytes so the original buffer can be GC'd after
      // the onmessage handler returns.
      this._messageQueue.push(raw.slice(offset, offset + len));
      offset += len;
    }
    this._scheduleProcessing();
  }

  /**
   * Processes queued messages within a fixed time budget per frame.
   * Items in the queue may be raw Uint8Arrays (from batched frames, decoded
   * here lazily) or pre-decoded message objects (from handleMessage).
   * @private
   * @returns {void}
   */
  _processMessageQueue(forceDrain = false) {
    this._processingScheduled = false;
    // Replay review mode pauses message *processing* — bytes/decoded items
    // continue to land in _messageQueue so nothing is dropped. TimeMachine
    // clears _reviewPaused and calls this with forceDrain=true on catchUp().
    if (this._reviewPaused && !forceDrain) return;
    const BUDGET_MS = forceDrain ? Number.POSITIVE_INFINITY : 8;
    const start = performance.now();
    let processed = 0;

    while (this._messageQueue.length > 0) {
      const item = this._messageQueue.shift();

      let data;
      if (item instanceof Uint8Array) {
        try {
          data = this.Msg.decode(item);
          if (Array.isArray(data.ps) && data.ps.length >= 2) {
            data.ps = decodePs(data.ps);
          }
          // Tap at drain time = application order (see _tapInbound). `item`
          // is the per-message slice from _decodeBatchedFrame — the exact
          // wire bytes the server produced for this single message.
          this._tapInbound(data, item);
        } catch (err) {
          console.error('Failed to decode batched message:', err);
          processed++;
          if (!forceDrain && performance.now() - start > BUDGET_MS) break;
          continue;
        }
      } else if (item && item.raw instanceof Uint8Array) {
        // Pre-decoded single-frame message deferred by handleMessage; its tap
        // was deliberately postponed to here so the tape order matches the
        // order messages are actually applied.
        data = item.data;
        this._tapInbound(data, item.raw);
      } else {
        data = item;
      }

      this._processMessage(data);
      processed++;

      if (!forceDrain && performance.now() - start > BUDGET_MS) {
        break;
      }
    }

    this._lastProcessingFrameEnd = performance.now();

    if (this._messageQueue.length > 0) {
      this._scheduleProcessing();
    }
  }

  /**
   * Internal router for processing a single message.
   * Emits application-level events based on message type.
   *
   * @private
   * @param {Object} data - Message payload.
   * @returns {void}
   */
  _processMessage(data) {
    // Measurement-only: drop all but 1 in N inbound MM messages per sender, to
    // emulate a server-side per-recipient coalescer and bound what one could
    // buy on a weak client BEFORE any server code exists. Deliberately placed
    // after _tapInbound (every caller runs the tap first), so the stroke
    // fingerprint log and replay tape still see the full stream and parity is
    // unaffected — only the live canvas thins out, which is exactly the cost
    // being measured. 1 in normal operation; see inbound_ablation_ab.mjs.
    if (this._debugMmKeepEveryN > 1 && data.t === T.MM) {
      const seen = (this._debugMmSeen.get(data.u) || 0) + 1;
      this._debugMmSeen.set(data.u, seen);
      if (seen % this._debugMmKeepEveryN !== 0) {
        this._debugMmDropped++;
        return;
      }
    }

    // Parity messages route to ParityClient outside the main switch — they
    // don't need any of the live-app side effects (cursor updates etc.).
    if (this.parityClient && this.parityClient.receive(data)) return;

    // History backfill routes outside the switch too, and for a stronger
    // reason: these frames are two-minute-old geometry that must reach the
    // rolling tape and NOTHING else. They never touch the board, the stroke
    // log or the seq watermark. (The TimeMachine tap in _tapInbound already
    // ignores them — the replay allowlist has no entry for these types.)
    if (data.t === T.HISTORY_BACKFILL_BEGIN
      || data.t === T.HISTORY_BACKFILL_CHUNK
      || data.t === T.HISTORY_BACKFILL_END) {
      this._handleHistoryBackfill(data);
      return;
    }

    // Checkpoint watermark: a checkpoint was minted at snapshot_seq. Truncate
    // our fingerprint log before it so the compared window is the post-checkpoint
    // tail — the same shared baseSeq the server and every other client adopt.
    // Idempotent and order-insensitive (only drops entries below the cutoff).
    if (data.t === T.SYNC_CHECKPOINT_MINTED) {
      const cutoff = Number(data.snapshotSeq) || 0;
      if (cutoff > 0) this.strokeLog.truncateBefore(cutoff + 1);
      this.emit('sync_checkpoint_minted', {
        snapshotId: data.snapshotId || '',
        snapshotSeq: cutoff
      });
      return;
    }

    // Checkpoint-based join: the private BOARD_SNAPSHOT_RESTORE that opens a sync
    // carries snapshotSeq (the checkpoint's applied-seq S) but no real `seq`
    // (it's unsequenced and not a logged commit). Adopt S as our base watermark
    // and drop any pre-checkpoint fingerprint entries (matters for an AFK
    // re-sync, which reuses the existing log) so our compared window is exactly
    // the (S, latest] tail the server then replays. NOT a return — the image
    // still applies via the normal board_snapshot_restore handler below.
    // Manual/sequenced restores carry `seq` instead and are skipped here.
    if (data.t === T.BOARD_SNAPSHOT_RESTORE && !data.seq && data.snapshotSeq) {
      const base = Number(data.snapshotSeq) || 0;
      if (base > 0) {
        this.strokeLog.truncateBefore(base + 1);
        if (base > this.lastProcessedSeq) this.lastProcessedSeq = base;
      }
    }

    // Commit-class self-echo: the server re-broadcasts our own commit
    // messages back to us so the strokeLog can keep parity with the server.
    // The strokeLog was already populated in the byte-decode step; the
    // draw handlers run on the local optimistic path, so applying them
    // again here would double-draw. Skip routing.
    //
    // EXCEPTION: T.MU and T.FILL. Our stroke was committed optimistically with
    // seq=0, which sorts it ABOVE every confirmed remote stroke. The self-echo
    // carries the authoritative global seq we need to reconcile that ordering —
    // drop it and our own strokes never reconcile, diverging from how other
    // clients (who received the stroke with a real seq) order and bake it.
    //
    // FILL needs its OWN echo (not just MU): the fill tool commits a stroke
    // locally, then App broadcasts MU afterward. Because the fill broadcast
    // happens from an un-awaited async onPointerUp, the server assigns the MU a
    // LOWER seq than the FILL. If the MU echo reconciled the fill stroke it'd
    // get the MU's seq, while every observer commits that same fill with the
    // FILL's seq → a per-record seq mismatch (off-by-one) that reorders the fill
    // against any stroke landing between the two seqs. So the fill stroke is
    // tagged pendingCommitEcho='fill', the MU reconciler skips it, and the FILL
    // self echo (reconcile-only, see the 'fill' handler) assigns the FILL seq.
    // BOARD_SNAPSHOT_RESTORE is exempt: it's a commit type (sequenced for parity)
    // but the requester never applies it optimistically — it only sends a request
    // and waits for the broadcast — so it MUST be applied on receipt like everyone
    // else. It also carries no `u`, which proto3 defaults to 0, so without this
    // exemption the session-0 client would self-skip and never revert (Bug A
    // regression caught in live testing).
    //
    // SEL_DELETE is exempt for the same reason as FILL: the local clear commits
    // an optimistic destination-out erase stroke at seq=0 (tagged
    // pendingCommitEcho='sel_delete'). The MU reconciler skips the tag, so the
    // SEL_DELETE self echo (reconcile-only, see the 'sel_delete' handler) must
    // reach it to assign the authoritative erase seq. Without it the erase keeps
    // seq=0 — sorting it above every confirmed stroke, where it permanently
    // erases other users' work in that region (the persistent "white spot").
    //
    // TEXT_APPLY is exempt for the same reason: the raster path commits the text
    // bake locally at seq 0 (tagged pendingCommitEcho='text_apply') while every
    // observer commits the same bake from this broadcast. Only the TEXT_APPLY
    // echo carries the seq they used, so it must reach the handler to reconcile
    // ours to it — otherwise the drawer keeps seq 0 (sorted to the top by its own
    // clock) while observers place it correctly, and the two boards diverge.
    // The vector path commits no stroke, so its echo reconciles nothing.
    //
    // SEL_COMMIT / SEL_STAMP / SEL_FILL are exempt as of 2026-08-10, together
    // with SEL_LIFT (which is not a commit type and so never reached this gate).
    //
    // These used to be excluded on purpose: the stamp sits at seq 0, and so does
    // the destination-out lift-erase before it, on the drawer and every observer
    // alike — so all of them ordered the pair identically (seq 0 →
    // MAX_SAFE_INTEGER, tie-broken by timestamp). Reconciling only the stamp
    // would have sunk it BELOW the still-seq-0 erase and wiped the placement.
    //
    // The pair is now sequenced TOGETHER, which is what that note asked for: the
    // lift-erase reconciles to SEL_LIFT's seq and the stamp to SEL_COMMIT's (or
    // SEL_STAMP's / SEL_FILL's). The server stamps every broadcast from one
    // counter and the lift is always broadcast before the commit, so
    // seq_lift < seq_commit holds by construction and the erase stays underneath.
    // Both sides now place the pair at its true position instead of on top.
    // A rebuild suspends this gate wholesale. It assumes our own commit is an
    // echo of something already on our canvas, which requestSync() falsified by
    // wiping the board — and the types NOT exempted below (IMG_PASTE, UNDO,
    // REDO, CLR, TEXT_REMOVE) are then dropped outright, so a resync loses every
    // pasted image and replays a history with the undos missing. Set by
    // SyncClient.init.
    if (
      data.u !== undefined &&
      this.sessionIndex !== null &&
      data.u === this.sessionIndex &&
      !this._isRebuilding?.() &&
      isCommitType(data.t) &&
      data.t !== T.MU &&
      data.t !== T.FILL &&
      data.t !== T.GLITCH_RESULT &&
      data.t !== T.SEL_DELETE &&
      data.t !== T.SEL_MERGE &&
      data.t !== T.SEL_COMMIT &&
      data.t !== T.SEL_STAMP &&
      data.t !== T.SEL_FILL &&
      data.t !== T.TEXT_APPLY &&
      data.t !== T.BOARD_SNAPSHOT_RESTORE
    ) {
      return;
    }

    switch (data.t) {
      case T.CONNECT:
        this.sessionIndex = data.u;
        this.instanceId = data.iid || '';
        this.role = data.authRole !== undefined ? data.authRole : 0;
        this.globalRole = data.authGlobalRole || 0;
        this.roomRole = data.authRoomRole || 0;
        // Fresh session = new room's seq counter starts at 0; the server-side
        // strokeLog is also fresh. Wipe ours to stay aligned.
        this.strokeLog.clear();
        this.lastProcessedSeq = 0;
        if (this.onConnect) {
          const connectData = {
            ...data,
            roomBoardSize: normalizeRoomBoardSize(data.roomBoardSize),
            floatingGalleryVoronoi: this._parseFloatingGalleryVoronoi(data.roomFloatingGalleryVoronoiJson)
          };
          this.onConnect(this.sessionIndex, this.role, data.authUsername, data.iph, connectData);
        }
        this.emit('socket_ready', { sessionIndex: this.sessionIndex, resumed: false });
        break;

      case T.CONNECT_RESUMED:
        this.sessionIndex = data.u;
        this.instanceId = data.iid || this.instanceId;
        this.role = data.authRole !== undefined ? data.authRole : this.role;
        this.globalRole = data.authGlobalRole !== undefined ? data.authGlobalRole : this.globalRole;
        this.roomRole = data.authRoomRole !== undefined ? data.authRoomRole : this.roomRole;
        if (this.onConnectResumed) {
          this.onConnectResumed(this.sessionIndex, this.role, data.authUsername);
        }
        this.emit('socket_ready', { sessionIndex: this.sessionIndex, resumed: true });
        break;

      case T.PING:
        this._sendClientStatus();
        break;

      case T.BW_PROBE_START:
        this._runProbe(data.probeId, data.probeTotal || 20, data.probeBlobSize || 30720);
        break;

      case T.BW_REPORT:
        // Server echoes our measured bps back so we can persist it across reconnects.
        if (data.uploadBps && data.uploadBps > 0) {
          try {
            localStorage.setItem('topDrawUploadBps', JSON.stringify({
              bps: data.uploadBps,
              ts: Date.now()
            }));
          } catch (_) {}
        }
        break;

      case T.USERS:
        const users = (data.us || []).map(u => ({
          sessionIndex: u.u,
          afk: u.a,
          x: u.x,
          y: u.y,
          tool: ToolNames[u.l] || 'brush',
          color: unpackColor(u.c),
          size: (u.s ?? 1000) / 100,
          spacing: u.sp !== undefined ? u.sp / 100 : 0,
          smoothing: u.sm ?? 15,
          hardness: (u.hd ?? 100),
          pressure: (u.p ?? 100) / 100,
          name: u.n || '',
          text: u.tx || '',
          role: u.role || 0,
          globalRole: u.globalRole || 0,
          roomRole: u.roomRole || 0,
          cursorHidden: u.ch || false,
          blurRadius: (u.br ?? 500),
          activeLayer: u.ly ?? 0,
          blendMode: u.bm || 'source-over',
          blendBakeMode: normalizeBlendBakeMode(u.bbm),
          imageBrush: u.ib,
          ipHash: u.iph,
          thinning: u.th ? (u.th - 1) / 100 : undefined,
          simulatePressure: u.sim !== undefined ? u.sim === 2 : undefined,
          patternBrush: u.pb,
          patternScale: u.patternScale,
          patternShape: u.patternShape,
          patternName: u.patternName,
          eraseAll: u.ea || false,
          font: normalizeTextFont(u.fo),
          textPositionMultiplier: u.tm,
          textPositionOffset: u.to,
          registeredName: u.rn || '',
          isMuted: !!u.mt,
          isSilenced: !!u.sl,
          hasDiscord: !!u.hdsc,
          selectedBadge: u.bdg || '',
          isSupporter: !!u.sup,
          countryCode: u.ctry || '',
          visibleIp: u.vip || '',
          isShadowBanned: !!u.sb
        }));
        this.emit('users', { users });
        break;

      case T.SETTINGS:
        let mirrorRegions = [];
        if (data.mirrorRegionsJson) {
          try {
            mirrorRegions = JSON.parse(data.mirrorRegionsJson);
          } catch (err) {
            console.warn('[WebSocketClient] Failed to parse mirror regions payload', err);
          }
        }
        this.emit('settings', {
          mirror: data.m,
          mirrorRegions,
          backgroundColor: data.roomBackgroundColor,
          locked: data.roomLocked,
          maxUsers: data.roomMaxUsers,
          modInactiveImmune: data.roomModInactiveImmune,
          joinPolicy: data.roomJoinPolicy || 'open',
          obscureRequiresRegistered: !!data.roomObscureRequiresRegistered,
          autoMuteGuests: !!data.roomAutoMuteGuests,
          autoMuteVpnUsers: !!data.roomAutoMuteVpnUsers,
          hideChatNotifications: !!data.roomHideChatNotifications,
          // Tri-state on the wire: 0/absent and 1 both mean on, 2 means off.
          loadSnapshotOnFirstJoin: Number(data.roomSnapshotOnFirstJoin) !== 2,
          textOverlayLifetimeMs: Number.isFinite(Number(data.roomTextOverlayLifetimeMs)) && Number(data.roomTextOverlayLifetimeMs) > 0
            ? Math.floor(Number(data.roomTextOverlayLifetimeMs))
            : 30 * 1000,
          dedicatedReplayUser: data.roomDedicatedReplayUser || null,
          electedUploader: data.electedUploader || null,
          private: !!data.roomPrivate,
          floatingGallerySeed: data.roomFloatingGallerySeed || 0,
          floatingGalleryIncludeIds: Array.isArray(data.roomFloatingGalleryIncludeIds)
            ? data.roomFloatingGalleryIncludeIds
            : [],
          floatingGalleryExcludeIds: Array.isArray(data.roomFloatingGalleryExcludeIds)
            ? data.roomFloatingGalleryExcludeIds
            : [],
          floatingGalleryVoronoi: this._parseFloatingGalleryVoronoi(data.roomFloatingGalleryVoronoiJson),
          ownerId: data.ownerId || null,
          ownerUsername: data.ownerUsername || null,
          boardSize: normalizeRoomBoardSize(data.roomBoardSize),
          tiledCanvas: !!data.roomTiledCanvas,
          tiledCanvasAvailable: !!data.roomTiledCanvasAvailable
        });
        break;

      case T.LEFT:
        this.emit('left', { sessionIndex: data.u });
        break;

      case T.AFK:
        this.emit('afk', { sessionIndex: data.u, afk: data.a });
        break;

      case T.COMPRESS_USER_STROKES:
        this.emit('compress_user_strokes', { sessionIndex: data.u });
        break;

      case T.MM:
        this.emit('mm', {
          sessionIndex: data.u,
          ps: data.ps || [],
          rs: data.rs || null,
          confettiData: data.g || null,
          seq: data.seq
        });
        break;

      case T.MD:
        this.emit('md', {
          sessionIndex: data.u,
          ps: data.ps || null,
          rs: data.rs || null,
          confettiData: data.g || null,
          layerIndex: data.ly,
          blendMode: data.bm,
          blendBakeMode: decodeBlendBakeMode(data.bbm),
          seq: data.seq
        });
        break;

      case T.MU:
        this.emit('mu', { sessionIndex: data.u, seq: data.seq });
        break;

      case T.CP:
        this.emit('cp', { sessionIndex: data.u, pressure: (data.p ?? 100) / 100, seq: data.seq });
        break;

      case T.CS:
        this.emit('cs', { sessionIndex: data.u, size: (data.s ?? 1000) / 100, seq: data.seq });
        break;

      case T.CT:
        this.emit('ct', { sessionIndex: data.u, tool: ToolNames[data.l] || 'brush', eraseAll: data.a || false, seq: data.seq });
        break;

      case T.CC:
        this.emit('cc', { sessionIndex: data.u, color: unpackColor(data.c), seq: data.seq });
        break;

      case T.CSP:
        this.emit('csp', { sessionIndex: data.u, spacing: data.sp !== undefined ? data.sp / 100 : 0, seq: data.seq });
        break;

      case T.CSM:
        this.emit('csm', { sessionIndex: data.u, smoothing: data.sm ?? 15, seq: data.seq });
        break;

      case T.CHD:
        this.emit('chd', { sessionIndex: data.u, hardness: (data.hd ?? 100), seq: data.seq });
        break;

      case T.CBR:
        this.emit('cbr', { sessionIndex: data.u, blurRadius: (data.br ?? 500), seq: data.seq });
        break;

      case T.CTHN:
        this.emit('cthn', { sessionIndex: data.u, thinning: (data.th ? data.th - 1 : 50) / 100, seq: data.seq });
        break;

      case T.CSIM:
        // Offset encoding: 0=not set, 1=false, 2=true
        this.emit('csim', { sessionIndex: data.u, simulatePressure: (data.sim ?? 0) === 2, seq: data.seq });
        break;

      case T.FILL:
        this.emit('fill', {
          sessionIndex: data.u,
          x: data.sx,
          y: data.sy,
          layerIndex: data.ly ?? 0,
          expansion: (data.s ?? 0) / 100,
          blurRadius: (data.br ?? 0) / 100,
          seq: data.seq
        });
        break;

      case T.CL:
        this.emit('cl', { sessionIndex: data.u, layerIndex: data.ly ?? 0, seq: data.seq });
        break;

      case T.CBM:
        this.emit('cbm', {
          sessionIndex: data.u,
          layerIndex: data.ly ?? null,
          blendMode: data.bm || 'source-over',
          blendBakeMode: decodeBlendBakeMode(data.bbm),
          seq: data.seq
        });
        break;

      case T.CN:
        this.emit('cn', {
          sessionIndex: data.u,
          name: data.n,
          message: data.g,
          size: data.s !== undefined ? data.s / 100 : undefined,
          tool: data.l !== undefined ? ToolNames[data.l] : undefined,
          color: data.c !== undefined ? unpackColor(data.c) : undefined,
          spacing: data.sp !== undefined ? data.sp / 100 : undefined,
          smoothing: data.sm !== undefined ? data.sm : undefined,
          hardness: data.hd !== undefined ? data.hd : undefined,
          blurRadius: data.br !== undefined ? data.br : undefined,
          activeLayer: data.ly !== undefined ? data.ly : undefined,
          blendMode: data.bm || undefined,
          blendBakeMode: decodeBlendBakeMode(data.bbm),
          thinning: data.th ? (data.th - 1) / 100 : undefined,
          simulatePressure: data.sim !== undefined ? data.sim === 2 : undefined,
          patternScale: data.patternScale,
          patternShape: data.patternShape,
          patternName: data.patternName
        });
        break;

      case T.KP:
        this.emit('kp', { sessionIndex: data.u, key: data.k });
        break;

      case T.TEXT_APPLY:
        this.emit('text_apply', {
          sessionIndex: data.u,
          id: data.textId || null,
          text: data.g || '',
          position: {
            x: Array.isArray(data.ps) ? data.ps[0] : 0,
            y: Array.isArray(data.ps) ? data.ps[1] : 0
          },
          size: (data.s ?? 1000) / 100,
          color: unpackColor(data.c),
          opacity: (data.p ?? 100) / 100,
          layerIndex: data.ly ?? 0,
          blendMode: data.bm || 'source-over',
          blendBakeMode: normalizeBlendBakeMode(data.bbm),
          font: normalizeTextFont(data.fo),
          textPositionMultiplier: data.tm,
          textPositionOffset: data.to,
          lifetimeMs: data.textLifetimeMs || undefined,
          fadeMs: data.textFadeMs || undefined,
          ageMs: data.textAgeMs || 0,
          pixel: !!data.textPixel,
          // The raster ("pixel") path commits a real stroke on every client, so
          // it needs the authoritative seq like any other commit — without it the
          // bake lands at seq 0, sorts to the top and is ordered by each client's
          // own clock. The vector path commits nothing and ignores this.
          seq: data.seq
        });
        break;

      case T.TEXT_REMOVE:
        this.emit('text_remove', {
          sessionIndex: data.u,
          id: data.textId || null
        });
        break;

      case T.CLR:
        this.emit('clr', { sessionIndex: data.u });
        break;

      case T.MIR:
        this.emit('mir', { sessionIndex: data.u });
        break;

      case T.MSG:
        this.emit('msg', { sessionIndex: data.u, message: data.g, messageId: data.chatMessageId });
        break;

      case T.STAFF_MSG:
        this.emit('staff_msg', { sessionIndex: data.u, message: data.g, messageId: data.chatMessageId });
        break;

      case T.MSG_DELETE:
        this.emit('msg_delete', { messageId: data.chatMessageId, staff: false });
        break;

      case T.STAFF_MSG_DELETE:
        this.emit('msg_delete', { messageId: data.chatMessageId, staff: true });
        break;

      case T.CHAT_WARNING:
        this.emit('chat_warning', {
          level: data.chatWarningLevel || 1,
          cooldownMs: data.chatCooldownMs || 0
        });
        break;

      case T.GLOBAL_MESSAGE:
        this.emit('global_message', {
          message: data.g || '',
          kind: data.k || 'notice',
          issuer: data.n || 'Server',
          persistent: !!data.a
        });
        break;

      case T.DM:
        this.emit('dm', { sessionIndex: data.u, message: data.g, messageId: data.chatMessageId });
        break;

      case T.CHAT_IMG:
      case T.STAFF_CHAT_IMG:
          const rawBytes = data.cimg;
          if (!rawBytes || rawBytes.length === 0) break;

        const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        let mimeType = 'image/png';
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) mimeType = 'image/jpeg';
        else if (bytes[0] === 0x47 && bytes[1] === 0x49) mimeType = 'image/gif';
        else if (bytes[0] === 0x52 && bytes[1] === 0x49) mimeType = 'image/webp';

        const imageDataUrl = `data:${mimeType};base64,${base64}`;
        this.emit(data.t === T.STAFF_CHAT_IMG ? 'staff_chat_img' : 'chat_img', {
          sessionIndex: data.u,
          imageData: imageDataUrl,
          recipientId: hasOwnField(data, 'r') ? data.r : null,
          messageId: data.chatMessageId
        });
        break;

      case T.CHAT_REACTION:
        this.emit('chat_reaction', {
          sessionIndex: data.u,
          messageId: data.chatMessageId,
          emoji: data.chatReaction,
          remove: !!data.chatReactionRemove,
          recipientId: hasOwnField(data, 'r') ? data.r : null
        });
        break;

      case T.FLOATING_ART_UPDATE:
        try {
          const item = JSON.parse(data.fa);
          this.emit('floating_art_update', { item });
        } catch (err) {
          console.error('[FloatingArt] Failed to parse item:', err);
        }
        break;

      case T.FLOATING_WALL: {
        const json = data.floatingWallJson || '';
        // Replies (detach, shelf claims) resolve here so callers don't depend on the wall component being mounted
        if (this._floatingWallRequests?.size && json.includes('"req":')) {
          try {
            const msg = JSON.parse(json);
            const resolve = this._floatingWallRequests.get(msg.req);
            if (resolve) {
              this._floatingWallRequests.delete(msg.req);
              resolve(msg);
            }
          } catch (err) {
            console.error('[FloatingWall] Failed to parse reply:', err);
          }
        }
        this.emit('floating_wall', { json, pos: data.floatingWallPos || [] });
        break;
      }

      case T.GMP:
        this.emit('gmp', { sessionIndex: data.u, brushData: data.g });
        break;

      case T.GPT:
        this.emit('gpt', { sessionIndex: data.u, patternData: data.g });
        break;

      case T.IMAGE_TOOL:
        this.emit('image_tool', {
          sessionIndex: data.u,
          imageType: data.imageToolType || data.image_tool_type || data.k || '',
          imageData: data.imageToolData || data.image_tool_data || data.g || ''
        });
        break;

      case T.CPM:
        this.emit('cpm', { sessionIndex: data.u, patternMode: data.pm });
        break;

      case T.CF:
        this.emit('cf', {
          sessionIndex: data.u,
          font: normalizeTextFont(data.fo),
          textPositionMultiplier: data.tm,
          textPositionOffset: data.to
        });
        break;

      case T.CSDM:
        this.emit('csdm', {
          sessionIndex: data.u,
          shapeDrawMode: data.sdm || 'corner-to-corner'
        });
        break;

      case T.PAN:
        this.emit('pan', { sessionIndex: data.u, panning: data.a });
        break;

      case T.CANCEL:
        this.emit('cancel', { sessionIndex: data.u });
        break;

      case T.HIDE_CURSOR:
        this.emit('hide_cursor', { sessionIndex: data.u });
        break;

      case T.SHOW_CURSOR:
        this.emit('show_cursor', { sessionIndex: data.u });
        break;

      case T.SEL_LIFT:
        let lassoPath = null;
        if (data.cr && data.cr.length >= 6) {
          lassoPath = [];
          for (let i = 0; i < data.cr.length; i += 2) {
            lassoPath.push({ x: data.cr[i], y: data.cr[i + 1] });
          }
        }
        this.emit('sel_lift', {
          sessionIndex: data.u,
          selection: { x: data.sx, y: data.sy, width: data.sw, height: data.sh },
          lassoPath,
          imageData: data.g || null,
          allLayers: !!data.a,
          extendedWarp: !!data.selExtendedWarp,
          mirrored: !!data.m,
          // The lift commits a destination-out erase of the source area on every
          // client. It needs its OWN seq so the later stamp (which carries
          // SEL_COMMIT's, necessarily higher) sorts above it — see the pairing
          // note on the self-echo guard above.
          seq: data.seq
        });
        break;

      case T.SEL_MOVE:
        const cr = data.cr || [];
        this.emit('sel_move', {
          sessionIndex: data.u,
          corners: {
            tl: { x: cr[0], y: cr[1] },
            tr: { x: cr[2], y: cr[3] },
            br: { x: cr[4], y: cr[5] },
            bl: { x: cr[6], y: cr[7] }
          },
          sourceCrop: data.cb && data.cb.length === 4
            ? { x: data.cb[0], y: data.cb[1], width: data.cb[2], height: data.cb[3] }
            : null,
          extendedWarp: !!data.selExtendedWarp
        });
        break;

      case T.SEL_COMMIT:
        this.emit('sel_commit', { sessionIndex: data.u, layerIndex: data.ly, seq: data.seq, extendedWarp: !!data.selExtendedWarp, mirrored: !!data.m });
        break;

      case T.SEL_PENDING: {
        let pendingLassoPath = null;
        if (data.ps && data.ps.length >= 6) {
          pendingLassoPath = [];
          for (let i = 0; i < data.ps.length; i += 2) {
            pendingLassoPath.push({ x: data.ps[i], y: data.ps[i + 1] });
          }
        }
        this.emit('sel_pending', {
          sessionIndex: data.u,
          selection: {
            x: Math.floor(data.sx),
            y: Math.floor(data.sy),
            width: Math.ceil(data.sw),
            height: Math.ceil(data.sh)
          },
          lassoPath: pendingLassoPath
        });
        break;
      }

      case T.SEL_DELETE:
        this.emit('sel_delete', {
          sessionIndex: data.u, layerIndex: data.ly ?? 0, seq: data.seq,
          allLayers: !!data.a, mirrored: !!data.m
        });
        break;

      case T.SEL_FILL: {
        let fillLassoPath = null;
        if (data.ps && data.ps.length >= 6) {
          fillLassoPath = [];
          for (let i = 0; i < data.ps.length; i += 2) {
            fillLassoPath.push({ x: data.ps[i], y: data.ps[i + 1] });
          }
        }
        this.emit('sel_fill', {
          sessionIndex: data.u,
          color: unpackColor(data.c),
          layerIndex: data.ly ?? 0,
          rect: data.sw ? { x: data.sx || 0, y: data.sy || 0, width: data.sw, height: data.sh || 0 } : null,
          lassoPath: fillLassoPath,
          seq: data.seq,
          mirrored: !!data.m
        });
        break;
      }

      case T.SEL_STAMP:
        this.emit('sel_stamp', { sessionIndex: data.u, layerIndex: data.ly, seq: data.seq, extendedWarp: !!data.selExtendedWarp, mirrored: !!data.m });
        break;

      case T.SEL_MERGE:
        this.emit('sel_merge', {
          sessionIndex: data.u,
          sourceLayer: data.ly ?? 0,
          mode: data.g || 'down',
          seq: data.seq
        });
        break;

      case T.SEL_FLIP:
        this.emit('sel_flip', { sessionIndex: data.u });
        break;

      case T.SEL_CANCEL:
        this.emit('sel_cancel', { sessionIndex: data.u });
        break;

      case T.SEL_HIDE:
        this.emit('sel_hide', { sessionIndex: data.u, hidden: !!data.a });
        break;

      case T.SEL_MASK: {
        let maskLassoPath = null;
        if (data.ps && data.ps.length >= 6) {
          maskLassoPath = [];
          for (let i = 0; i < data.ps.length; i += 2) {
            maskLassoPath.push({ x: data.ps[i], y: data.ps[i + 1] });
          }
        }
        this.emit('sel_mask', {
          sessionIndex: data.u,
          active: !!data.mk,
          selection: data.mk ? {
            x: Math.floor(data.sx),
            y: Math.floor(data.sy),
            width: Math.ceil(data.sw),
            height: Math.ceil(data.sh)
          } : null,
          lassoPath: maskLassoPath
        });
        break;
      }

      case T.SEL_TO_BRUSH:
        this.emit('sel_to_brush', { sessionIndex: data.u, brushData: data.g });
        break;

      case T.OBSCURE_REGION:
        let obscurePayload = null;
        try {
          obscurePayload = data.g ? JSON.parse(data.g) : null;
        } catch (err) {
          console.warn('[WebSocketClient] Failed to parse obscure region payload', err);
        }
        this.emit('obscure_region', {
          sessionIndex: data.u,
          payload: obscurePayload
        });
        break;

      case T.IMG_PASTE:
        this.emit('img_paste', {
          sessionIndex: data.u,
          x: data.sx,
          y: data.sy,
          width: data.sw,
          height: data.sh,
          imageData: data.g
        });
        break;

      case T.GLITCH_RESULT:
        this.emit('glitch_result', {
          sessionIndex: data.u,
          x: data.sx,
          y: data.sy,
          width: data.sw,
          height: data.sh,
          layerIndex: data.ly,
          imageData: data.g,
          // Draw-time blend of the glitch stroke (absent when source-over /
          // background). Committing with this instead of the receiver's live
          // blendMode keeps the blend correct despite the async image decode.
          blendMode: data.bm,
          blendBakeMode: data.bbm,
          // Authoritative global seq for this glitch layer's stroke. Without it,
          // observers commit the glitch at seq=0 (sorts above later strokes →
          // z-order/bake divergence). The drawer reconciles its matching local
          // glitch stroke to this same seq via the self-echo branch.
          seq: data.seq
        });
        break;

      case T.SYNC_COMPLETE:
        this.emit('sync_complete', {});
        break;

      case T.SYNC_METADATA:
        this.emit('sync_metadata', {
          providerSessionIndex: hasOwnField(data, 'u') ? data.u : null,
          totalCount: data.syncTotal || data.sync_total || 0,
          boardWidth: data.boardWidth || data.board_width || 0,
          boardHeight: data.boardHeight || data.board_height || 0
        });
        break;

      case T.SYNC_LAYER_BASE:
        this.emit('sync_layer_bin', {
          layerIdx: data.ly,
          blendMode: data.bm || 'source-over',
          imageData: data.img
        });
        break;

      case T.SYNC_STROKE:
        this.emit('sync_stroke', {
          layerIdx: data.ly,
          userId: data.u,
          x: data.sx, y: data.sy, w: data.sw, h: data.sh,
          blendMode: data.bm,
          blendBakeMode: normalizeBlendBakeMode(data.bbm),
          timestamp: data.stroke_ts ? Number(data.stroke_ts) : 0,
          seq: data.seq || 0,
          eraseAll: data.a || false,
          isRedo: data.stroke_redo || false,
          redoBatchIdx: data.stroke_redo_batch || 0,
          imageData: data.img
        });
        break;

      case T.SYNC_STROKE_BATCH:
        if (data.strokes && data.strokes.length > 0) {
          this.emit('sync_stroke_batch', {
            strokes: data.strokes.map(stroke => ({
              layerIdx: stroke.layerIdx !== undefined ? stroke.layerIdx : data.layerIdx,
              userId: stroke.userId,
              x: stroke.x,
              y: stroke.y,
              w: stroke.width,
              h: stroke.height,
              blendMode: stroke.blendMode || 'source-over',
              blendBakeMode: normalizeBlendBakeMode(stroke.blendBakeMode),
              timestamp: stroke.timestamp ? Number(stroke.timestamp) : 0,
              seq: stroke.seq || 0,
              eraseAll: stroke.eraseAll || false,
              isRedo: stroke.isRedo || false,
              activeStroke: stroke.activeStroke || false,
              redoBatchIdx: stroke.redoBatch || 0,
              imageData: stroke.img,
              affectedTiles: stroke.affectedTiles || []
            }))
          });
        }
        break;

      case T.SYNC_STROKES_DONE:
        this.emit('sync_strokes_done', {});
        break;

      case T.SYNC_TILE_OWNERSHIP:
        this.emit('sync_tile_ownership', { tiles: data.tiles || [] });
        break;

      case T.TILE_UPDATE:
        this.emit('tile_update', { userId: data.u, tiles: data.tiles || [] });
        break;

      case T.TILE_CLEAR:
        this.emit('tile_clear', { clearedTiles: data.clearedTiles || [] });
        break;

      case T.AUTH_RESULT:
        this.globalRole = data.authGlobalRole || 0;
        this.roomRole = data.authRoomRole || 0;
        this.emit('auth_result', {
          success: data.a,
          token: data.authToken || '',
          role: data.authRole || 0,
          globalRole: data.authGlobalRole || 0,
          roomRole: data.authRoomRole || 0,
          username: data.authUsername || '',
          error: data.authError || '',
          hasEmail: data.authHasEmail || false,
          emailPromptDeclined: data.authEmailPromptDeclined || false,
          hasDiscord: data.authHasDiscord || false,
          needsUsernameSetup: data.authNeedsUsernameSetup || false,
          suggestedUsername: data.authSuggestedUsername || '',
          selectedBadge: data.authBadge || '',
          isSupporter: !!data.authSupporter
        });
        break;

      case T.MOD_NOTIFY:
        this.emit('mod_notify', {
          actionType: data.modActionType ?? 0,
          targetName: data.modTargetName || '',
          issuerName: data.modIssuerName || '',
          reason: data.modReason || '',
          targetSessionIndex: data.modTarget
        });
        break;

      case T.MOD_RESULT:
        this.emit('mod_result', {
          success: data.a,
          error: data.authError || ''
        });
        break;

      case T.MOD_LIST:
        this.emit('mod_list', {
          entries: (data.modEntries || []).map(e => ({
            id: e.id,
            type: e.type,
            username: e.username,
            reason: e.reason,
            ip: e.ip,
            ipScope: e.ipScope,
            issuedBy: e.issuedBy,
            issuedByRole: e.issuedByRole,
            createdAt: e.createdAt,
            expiresAt: e.expiresAt,
            active: e.active
          }))
        });
        break;

      case T.UNDO:
        this.emit('undo', { sessionIndex: data.u, targetSeq: data.undoTargetSeq || 0 });
        break;

      case T.REDO:
        this.emit('redo', { sessionIndex: data.u });
        break;

      case T.MOD_WIPE:
        this.emit('mod_wipe', {
          targetSessionIndex: data.modTarget,
          targetName: data.modTargetName || '',
          issuerName: data.modIssuerName || ''
        });
        break;

      case T.ROOM_LIST_RESPONSE:
        this.emit('room_list_response', {
          rooms: (data.rooms || []).map(r => ({
            id: r.id,
            userCount: r.userCount || 0,
            locked: r.locked || false,
            hasPassword: r.hasPassword || false,
            description: r.description || '',
            backgroundColor: r.backgroundColor || '#ffffff',
            ownerId: r.ownerId || null,
            ownerUsername: r.ownerUsername || null,
            preview: r.preview || null
          }))
        });
        break;

      case T.ROOM_OWNERSHIP:
        this.emit('room_ownership', {
          ownerId: data.ownerId || null,
          ownerUsername: data.ownerUsername || null
        });
        break;

      case T.ROOM_ROLE_LIST_RESPONSE:
        this.emit('room_role_list', {
          entries: (data.roomRoles || []).map(entry => ({
            userId: entry.userId || '',
            username: entry.username || '',
            role: entry.role || 0,
            updatedBy: entry.updatedBy || '',
            updatedByUsername: entry.updatedByUsername || '',
            updatedAt: Number(entry.updatedAt || 0),
            previousRole: entry.previousRole || 0,
            changeType: entry.changeType || 'assigned',
            isOwner: !!entry.isOwner
          }))
        });
        break;

      case T.BOARD_SNAPSHOT_LIST_RESPONSE:
        this.emit('board_snapshot_list', { snapshotList: data.snapshotList || [] });
        break;

      case T.BOARD_SNAPSHOT_RESTORE:
        this.emit('board_snapshot_restore', {
          snapshotLayers: data.snapshotLayers,
          snapshotId: data.snapshotId,
          snapshotTs: data.snapshotTs,
          snapshotIssuer: data.snapshotIssuer,
          snapshotSeq: data.snapshotSeq,
          isSyncCheckpoint: !data.seq && !!data.snapshotSeq
        });
        break;

      case T.BOARD_SNAPSHOT_REGION_RESTORE:
        this.emit('board_snapshot_region_restore', {
          snapshotLayers: data.snapshotLayers,
          snapshotId: data.snapshotId,
          isLasso: data.a,
          sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh,
          cr: data.cr
        });
        break;

      case T.BOARD_SNAPSHOT_REQUEST:
        this.emit('board_snapshot_request');
        break;

      case T.ROOM_START_SNAPSHOT_INFO:
        this.emit('room_start_snapshot_info', {
          // 0 = blank start, 1 = follows the room's newest snapshot, 2 = pinned.
          state: Number(data.roomStartSnapshotState) || 0,
          snapshot: (data.snapshotList || [])[0] || null
        });
        break;

      case T.BOARD_SNAPSHOT_SAVE:
        // Private response to a BOARD_SNAPSHOT_GET request (not a broadcast restore)
        if (data.snapshotId && !data.a) {
          this.emit('board_snapshot_get_response', {
            snapshotId: data.snapshotId,
            snapshotTs: data.snapshotTs,
            snapshotIssuer: data.snapshotIssuer,
            snapshotLayers: data.snapshotLayers,
            snapshotSeq: data.snapshotSeq
          });
        }
        break;

      case T.REPLAY_RESPONSE:
        this.emit('replay_response', {
          checkpointId: data.checkpointId || null,
          checkpointImg: data.checkpointImg || null,
          mirror: !!data.m,
          mirrorRegions: data.mirrorRegionsJson ? JSON.parse(data.mirrorRegionsJson) : [],
          deltas: data.replayDeltasJson ? JSON.parse(data.replayDeltasJson) : []
        });
        break;

      case T.CHECKPOINT_LIST_RESPONSE:
        this.emit('checkpoint_list_response', {
          checkpoints: data.checkpointList || []
        });
        break;

    }
  }

  /**
   * Internal helper to trigger registered message handlers.
   *
   * @param {string} event - Event name.
   * @param {Object} data - Event payload.
   * @returns {void}
   */
  emit(event, data) {
    const handler = this.messageHandlers.get(event);
    if (handler) {
      handler(data);
    }
  }

  /**
   * Registers a handler for a specific message event.
   *
   * @param {string} event - Event name.
   * @param {Function} handler - Handler function.
   * @returns {void}
   */
  on(event, handler) {
    this.messageHandlers.set(event, handler);
  }

  /**
   * Encodes and sends a message via WebSocket.
   *
   * @param {Object} data - Message payload to be encoded as protobuf.
   * @returns {void}
   */
  send(data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.Msg) {
      this._trackActiveStrokeMessage(data);

      // ps is transmitted as quantized delta-encoded sint32 on the wire.
      // Encode into a cloned payload so the original (absolute floats) reaches
      // TimeMachine unchanged.
      let encData = data;
      if (Array.isArray(data.ps) && data.ps.length >= 2) {
        encData = { ...data, ps: encodePs(data.ps) };
      }
      const message = this.Msg.create(encData);
      const buffer = this.Msg.encode(message).finish();
      this.socket.send(buffer);

      // Record outgoing messages for TimeMachine (JSON with sessionIndex)
      if (window.app?.TimeMachine && this.sessionIndex != null) {
        window.app.TimeMachine.recordAction({ ...data, u: this.sessionIndex }, 'outbound');
      }
      return;
    }

    // Offline (Draw Alone) mode: there is no open socket, but the local replay
    // recorders (rolling DVR tape + manual tape) still want every action so the
    // time machine works without a server. Feed them the same outbound tap the
    // online path produces. sessionIndex is null while disconnected, so fall
    // back to the app's offline session index (0).
    if (window.app?.isOfflineMode && window.app?.TimeMachine) {
      const selfIdx = this.sessionIndex ?? window.app.sessionIndex ?? 0;
      window.app.TimeMachine.recordAction({ ...data, u: selfIdx }, 'outbound');
    }
  }

  /**
   * Sends lightweight client scheduling status to the server. The server uses
   * this to avoid applying visible-tab sync timeouts to backgrounded providers.
   * @returns {void}
   * @private
   */
  _sendClientStatus() {
    if (!this.connected) return;
    this.send({
      t: T.PONG,
      lowPowerMode: this.getLowPowerMode ? !!this.getLowPowerMode() : false,
      tabHidden: typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false
    });
  }

  /**
   * Sends the current in-progress stroke to one newly joined user.
   * The server routes these packets only to `targetSessionIndex`.
   *
   * @param {number} targetSessionIndex
   * @returns {boolean} True when a replay was sent.
   */
  sendActiveStrokeTo(targetSessionIndex) {
    if (!Number.isFinite(Number(targetSessionIndex))) return false;
    if (!this._trackingActiveStroke || this._activeStrokeReplay.length === 0) return false;

    for (const data of this._activeStrokeReplay) {
      this.send({ ...this._cloneReplayMessage(data), tu: Number(targetSessionIndex) });
    }
    return true;
  }

  /**
   * Respond to a server bandwidth probe. Generates `total` random blobs of size
   * `blobSize` and pushes them back-to-back. Server times from first chunk arrival
   * to last and derives bytes/sec.
   * @param {string} probeId
   * @param {number} total
   * @param {number} blobSize
   * @private
   */
  _runProbe(probeId, total, blobSize) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.Msg) return;
    if (!probeId || total <= 0 || blobSize <= 0) return;

    for (let seq = 0; seq < total; seq++) {
      const bytes = new Uint8Array(blobSize);
      // Random data is required: compressible/zeroed buffers would inflate
      // measured throughput on connections that use WebSocket compression.
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        // getRandomValues has a 64KB quota — chunk if needed
        const MAX = 65536;
        for (let off = 0; off < blobSize; off += MAX) {
          crypto.getRandomValues(bytes.subarray(off, Math.min(off + MAX, blobSize)));
        }
      }
      const message = this.Msg.create({
        t: T.BW_PROBE_CHUNK,
        probeId,
        probeSeq: seq,
        probeData: bytes
      });
      this.socket.send(this.Msg.encode(message).finish());
    }
  }

  /**
   * Returns the best currently-available identity payload without waiting.
   * This keeps auth messages from being dropped during reconnect races.
   * @returns {Object}
   */
  _getImmediateIdentityPayload() {
    return {
      clientDeviceId: this.clientIdentity.deviceId || '',
      clientFingerprintId: this.clientIdentity.cachedFingerprintId || '',
      clientIdentityJson: this.clientIdentity.cachedIdentityJson || '',
      client_device_id: this.clientIdentity.deviceId || '',
      client_fingerprint_id: this.clientIdentity.cachedFingerprintId || '',
      client_identity_json: this.clientIdentity.cachedIdentityJson || '',
    };
  }

  /**
   * Broadcasts freehand movement points.
   * @param {Array<number>} points - Flattened [x, y, ...] coordinates.
   * @returns {void}
   */
  broadcastMove(points) {
    this.send({ t: T.MM, ps: points });
  }

  /**
   * Broadcasts stamped movement with per-stamp metadata.
   * @param {Array<number>} points - Flattened coordinates.
   * @param {Array<number>} radii - Per-stamp radii or deterministic seeds.
   * @returns {void}
   */
  broadcastStampMove(points, radii, metadata = {}) {
    const msg = { t: T.MM, ps: points, rs: radii };
    if (metadata.confettiData) msg.g = metadata.confettiData;
    this.send(msg);
  }

  /**
   * Broadcasts a legacy single mouse movement.
   * @param {number} x - X coordinate.
   * @param {number} y - Y coordinate.
   * @returns {void}
   */
  broadcastMouseMove(x, y) {
    this.send({ t: T.MM, ps: [x, y] });
  }

  /**
   * Broadcasts a mouse down event.
   * @param {Array<number>} points - Initial points.
   * @param {Array<number>|null} radii - Initial radii.
   * @returns {void}
   */
  broadcastMouseDown(points, radii, metadata = {}) {
    const msg = { t: T.MD, ps: points, rs: radii };
    if (metadata.layerIndex !== undefined) msg.ly = metadata.layerIndex;
    if (metadata.blendMode) msg.bm = metadata.blendMode;
    if (metadata.blendBakeMode) msg.bbm = normalizeBlendBakeMode(metadata.blendBakeMode);
    if (metadata.confettiData) msg.g = metadata.confettiData;
    this.send(msg);
  }

  /**
   * Broadcasts a mouse up event.
   * @returns {void}
   */
  broadcastMouseUp() {
    this.send({ t: T.MU });
  }

  /**
   * Broadcasts a tool change.
   * @param {string} tool - Tool name.
   * @param {boolean} [eraseAll=false] - Whether to erase all layers.
   * @returns {void}
   */
  broadcastToolChange(tool, eraseAll = false) {
    this.send({ t: T.CT, l: ToolToEnum[tool] || 0, a: eraseAll || false });
  }

  /**
   * Broadcasts a color change.
   * @param {Object} color - {r, g, b, a} color object.
   * @returns {void}
   */
  broadcastColorChange(color) {
    this.send({ t: T.CC, c: packColor(color) });
  }

  /**
   * Broadcasts a brush size change.
   * @param {number} size - New size.
   * @returns {void}
   */
  broadcastSizeChange(size) {
    this.send({ t: T.CS, s: Math.round(size * 100) });
  }

  /**
   * Broadcasts a spacing change.
   * @param {number} spacing - New spacing.
   * @returns {void}
   */
  broadcastSpacingChange(spacing) {
    this.send({ t: T.CSP, sp: Math.round(spacing * 100) });
  }

  /**
   * Broadcasts a smoothing value change.
   * @param {number} smoothing - New smoothing.
   * @returns {void}
   */
  broadcastSmoothingChange(smoothing) {
    this.send({ t: T.CSM, sm: Math.round(smoothing) });
  }

  /**
   * Broadcasts a hardness value change.
   * @param {number} hardness - New hardness (0-100).
   * @returns {void}
   */
  broadcastHardnessChange(hardness) {
    this.send({ t: T.CHD, hd: Math.round(hardness) });
  }

  /**
   * Broadcasts a blur radius change.
   * @param {number} radius - New blur radius.
   * @returns {void}
   */
  broadcastBlurRadiusChange(radius) {
    this.send({ t: T.CBR, br: Math.round(radius) });
  }

  /**
   * Broadcasts an ink thinning change.
   * @param {number} thinning - New thinning value (0-1).
   * @returns {void}
   */
  broadcastThinningChange(thinning) {
    this.send({ t: T.CTHN, th: Math.round(thinning * 100) + 1 });
  }

  /**
   * Broadcasts a simulate pressure change.
   * @param {boolean} simulate - Whether to simulate pressure.
   * @returns {void}
   */
  broadcastSimulatePressureChange(simulate) {
    // Offset encoding: 0=not set, 1=false, 2=true (avoids proto3 zero-default ambiguity)
    this.send({ t: T.CSIM, sim: simulate ? 2 : 1 });
  }

  /**
   * Broadcasts eraser scope mode changes while preserving current tool state.
   * @param {boolean} eraseAll - True to erase all layers, false for active layer only.
   * @param {string} [tool='erase'] - Current local tool to preserve for peers.
   * @returns {void}
   */
  broadcastEraserModeChange(eraseAll, tool = 'erase') {
    this.send({ t: T.CT, l: ToolToEnum[tool] || 0, a: !!eraseAll });
  }

  /**
   * Broadcasts an active layer change.
   * @param {number} layerIndex - New layer index.
   * @returns {void}
   */
  broadcastLayerChange(layerIndex) {
    this.send({ t: T.CL, ly: layerIndex });
  }

  /**
   * Broadcasts a blend mode change for a specific layer.
   * @param {number} layerIndex - Layer index.
   * @param {string} blendMode - Canvas composite operation name.
   * @returns {void}
   */
  broadcastLayerBlendModeChange(layerIndex, blendMode, blendBakeMode = 'background') {
    this.send({ t: T.CBM, ly: layerIndex, bm: blendMode, bbm: normalizeBlendBakeMode(blendBakeMode) });
  }

  /**
   * Broadcasts the local user's selected cosmetic badge so it appears next to
   * their name for everyone in the room. Persistence is handled separately via
   * the profile PATCH endpoint.
   * @param {string} badgeId - Badge id, or '' to clear.
   * @returns {void}
   */
  sendBadge(badgeId) {
    this.send({ t: T.SET_BADGE, profileBadge: badgeId || '' });
  }

  /**
   * Broadcasts a pressure change.
   * @param {number} pressure - New pressure (0.0 - 1.0).
   * @returns {void}
   */
  broadcastPressureChange(pressure) {
    this.send({ t: T.CP, p: Math.round(pressure * 100) });
  }

  /**
   * Broadcasts a username change.
   * @param {string} name - New username.
   * @param {Object} [extraProperties={}] - Additional user properties.
   * @returns {void}
   */
  broadcastNameChange(name, extraProperties = {}) {
    this.send({ t: T.CN, n: name, ...extraProperties });
  }

  /**
   * Broadcasts a single key press (for text tool).
   * @param {string} key - The key pressed.
   * @returns {void}
   */
  broadcastKeyPress(key) {
    this.send({ t: T.KP, k: key });
  }

  /**
   * Broadcasts an explicit text application payload.
   * @param {Object} payload - Fully specified text draw payload.
   * @returns {void}
   */
  broadcastTextApply(payload) {
    if (!payload?.text) return;
    this.send({
      t: T.TEXT_APPLY,
      g: payload.text,
      ps: [payload.x, payload.y],
      s: Math.round((payload.size ?? 10) * 100),
      c: packColor(payload.color),
      p: Math.round((payload.opacity ?? 1) * 100),
      ly: payload.layerIndex ?? 0,
      bm: payload.blendMode || 'source-over',
      bbm: normalizeBlendBakeMode(payload.blendBakeMode),
      fo: payload.font,
      tm: payload.textPositionMultiplier ?? 0,
      to: payload.textPositionOffset ?? 0,
      textId: payload.id || '',
      textLifetimeMs: payload.lifetimeMs ?? 0,
      textFadeMs: payload.fadeMs ?? 0,
      textPixel: !!payload.pixel
    });
  }

  /**
   * Broadcasts the removal of an active SVG text record.
   * @param {string} id - The text record id.
   */
  broadcastTextRemove(id) {
    if (!id) return;
    this.send({ t: T.TEXT_REMOVE, textId: id });
  }

  /**
   * Broadcasts a pan state change.
   * @param {boolean} value - True if panning.
   * @returns {void}
   */
  broadcastPan(value) {
    this.send({ t: T.PAN, a: value });
  }

  /**
   * Broadcasts a cancellation of the current stroke.
   * @returns {void}
   */
  broadcastCancel() {
    this.send({ t: T.CANCEL });
  }

  /**
   * Broadcasts a request to hide the local cursor.
   * @returns {void}
   */
  broadcastHideCursor() {
    this.send({ t: T.HIDE_CURSOR });
  }

  /**
   * Broadcasts a request to show the local cursor.
   * @returns {void}
   */
  broadcastShowCursor() {
    this.send({ t: T.SHOW_CURSOR });
  }

  /**
   * Broadcasts a clear canvas request.
   * @returns {void}
   */
  broadcastClear() {
    this.send({ t: T.CLR });
  }

  /**
   * Broadcasts a toggle for the mirror line.
   * @returns {void}
   */
  broadcastMirror() {
    this.send({ t: T.MIR });
  }

  /**
   * Broadcasts a mirror region creation/update payload.
   * @param {Object} payload
   * @returns {void}
   */
  broadcastMirrorRegion(payload) {
    this.send({
      t: T.MIRROR_REGION,
      mirrorRegionsJson: JSON.stringify(payload)
    });
  }

  /**
   * Sends a floating art wall action to the server (never relayed to peers).
   * @param {{ a: 'hello'|'bye', slow?: number }} payload (dragging is local; requests go through requestFloatingWall)
   * @returns {void}
   */
  sendFloatingWall(payload) {
    this.send({
      t: T.FLOATING_WALL,
      floatingWallJson: JSON.stringify(payload)
    });
  }

  /**
   * Sends a floating wall action that the server answers (detach, shelf claim/restore/delete).
   * @param {Object} payload
   * @param {number} [timeoutMs]
   * @returns {Promise<{ ok: boolean, error?: string }>} never rejects
   */
  requestFloatingWall(payload, timeoutMs = 30000) {
    if (!this._floatingWallRequests) {
      this._floatingWallRequests = new Map();
      this._floatingWallRequestSeq = 0;
    }
    const req = ++this._floatingWallRequestSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._floatingWallRequests.delete(req)) resolve({ ok: false, error: 'The server did not respond' });
      }, timeoutMs);
      this._floatingWallRequests.set(req, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.sendFloatingWall({ ...payload, req });
    });
  }

  /**
   * Broadcasts an undo request.
   * @returns {void}
   */
  /**
   * @param {number} [targetSeq=0] - Seq of the stroke we actually undid. Pass 0
   *   when it had none yet; receivers then fall back to resolving the target
   *   locally, which is the pre-2026-08-10 behaviour.
   */
  broadcastUndo(targetSeq = 0) {
    this.send({ t: T.UNDO, undoTargetSeq: targetSeq > 0 ? targetSeq : 0 });
  }

  /**
   * Broadcasts a redo request.
   * @returns {void}
   */
  broadcastRedo() {
    this.send({ t: T.REDO });
  }

  /**
   * Broadcasts a flood fill event.
   * @param {number} x - Fill seed X position.
   * @param {number} y - Fill seed Y position.
   * @param {number} layerIndex - Target layer index.
   * @param {number} [expansion=0] - Mask expansion in pixels (-40 to 40).
   * @param {number} [blurRadius=0] - Edge blur radius in pixels (0-30).
   */
  broadcastFill(x, y, layerIndex, expansion = 0, blurRadius = 0) {
    this.send({
      t: T.FILL,
      sx: Math.floor(x),
      sy: Math.floor(y),
      ly: layerIndex,
      s: Math.round(expansion * 100),
      br: Math.round(blurRadius * 100)
    });
  }

  /**
   * Broadcasts a public chat message.
   * @param {string} message - Message text.
   * @returns {void}
   */
  broadcastChat(message, messageId) {
    this.send({ t: T.MSG, g: message, chatMessageId: messageId });
  }

  /**
   * Broadcasts a staff-only chat message.
   * @param {string} message
   * @param {string} messageId
   * @returns {void}
   */
  broadcastStaffChat(message, messageId) {
    this.send({ t: T.STAFF_MSG, g: message, chatMessageId: messageId });
  }

  /**
   * Mod-only: deletes a chat message for everyone by id.
   * @param {string} messageId
   * @param {boolean} [staff=false] - Whether this is a staff-channel message.
   * @returns {void}
   */
  sendMsgDelete(messageId, staff = false) {
    if (!messageId) return;
    this.send({ t: staff ? T.STAFF_MSG_DELETE : T.MSG_DELETE, chatMessageId: messageId });
  }

  /**
   * Broadcasts a staff-only image.
   * @param {string} imageData
   * @param {string} messageId
   * @returns {{ok: boolean, error?: string}}
   */
  broadcastStaffChatImage(imageData, messageId = '') {
    const encoded = this._encodeChatImageDataUrl(imageData);
    if (!encoded.ok) return encoded;
    this.send({ t: T.STAFF_CHAT_IMG, cimg: encoded.bytes, chatMessageId: messageId });
    return { ok: true };
  }

  /**
   * Broadcasts an image to the chat or a specific user.
   * @param {string} imageData - Base64 encoded image data URL.
   * @param {number|null} [recipientId=null] - Optional private recipient.
   * @returns {{ok: boolean, error?: string}}
   */
  broadcastChatImage(imageData, recipientId = null, messageId = '') {
    const encoded = this._encodeChatImageDataUrl(imageData);
    if (!encoded.ok) return encoded;

    if (recipientId !== null) {
      this.send({ t: T.CHAT_IMG, cimg: encoded.bytes, r: recipientId, chatMessageId: messageId });
    } else {
      this.send({ t: T.CHAT_IMG, cimg: encoded.bytes, chatMessageId: messageId });
    }
    return { ok: true };
  }

  /**
   * Broadcasts a private message to a specific user.
   * @param {string} message - Message text.
   * @param {number} recipientId - Recipient session index.
   * @returns {void}
   */
  broadcastDM(message, recipientId, messageId) {
    this.send({ t: T.DM, g: message, r: recipientId, chatMessageId: messageId });
  }

  /**
   * Broadcasts a chat reaction toggle.
   * @param {{messageId: string, emoji: string, remove?: boolean, recipientId?: number|null}} payload
   * @returns {void}
   */
  broadcastChatReaction({ messageId, emoji, remove = false, recipientId = null }) {
    const message = {
      t: T.CHAT_REACTION,
      chatMessageId: messageId,
      chatReaction: emoji,
      chatReactionRemove: remove
    };
    if (recipientId !== null && recipientId !== undefined) {
      message.r = recipientId;
    }
    this.send(message);
  }

  /**
   * Broadcasts a custom brush configuration.
   * @param {Object} brushData - Brush settings object.
   * @returns {void}
   */
  broadcastBrush(brushData) {
    const payload = typeof brushData === 'string' ? brushData : JSON.stringify(brushData);
    this.send({ t: T.GMP, g: payload });
  }

  broadcastPatternBrush(patternData) {
    const payload = typeof patternData === 'string' ? patternData : JSON.stringify(patternData);
    this.send({ t: T.GPT, g: payload });
  }

  broadcastConfettiBrush(confettiData) {
    this.broadcastImageTool('confetti', confettiData);
  }

  broadcastImageTool(imageType, imageData) {
    this.send({
      t: T.IMAGE_TOOL,
      imageToolType: imageType,
      imageToolData: typeof imageData === 'string' ? imageData : JSON.stringify(imageData)
    });
  }

  /**
   * Broadcasts pattern mode toggle (for fill/select pattern fills).
   * @param {boolean} enabled - Whether pattern mode is enabled.
   * @returns {void}
   */
  broadcastPatternMode(enabled) {
    this.send({ t: T.CPM, pm: enabled });
  }

  /**
   * Broadcasts shape draw mode change.
   * @param {string} mode - 'corner-to-corner' or 'center-scaling'.
   * @returns {void}
   */
  broadcastShapeDrawModeChange(mode) {
    this.send({ t: T.CSDM, sdm: mode });
  }

  /**
   * Broadcasts a font change.
   * @param {string} font - The new font family.
   * @returns {void}
   */
  broadcastFontChange(font, textPositionMultiplier, textPositionOffset) {
    this.send({
      t: T.CF,
      fo: font,
      tm: textPositionMultiplier,
      to: textPositionOffset
    });
  }

  /**
   * Broadcasts a selection lift (extraction) event.
   * @param {Object} rect - Bounding box {x, y, width, height}.
   * @param {Array<Object>|null} [lassoPath=null] - Optional freehand path.
   * @param {string|null} [imageData=null] - Flattened lifted pixels (data URL).
   * @param {boolean} [allLayers=false] - Lift spans every visible layer.
   * @param {boolean} [extendedWarp=false] - Let folded corner-warps for this
   *   selection spill beyond the corner bbox instead of clipping. Must travel
   *   with the lift so every client rasterizes the same commit pixels.
   * @param {boolean} [mirrored=false] - Full-board mirror state at lift time. The
   *   lift erases the source area AND every mirrored counterpart, so receivers
   *   need it for the same reason SEL_DELETE carries it.
   * @returns {void}
   */
  broadcastSelectionLift(rect, lassoPath = null, imageData = null, allLayers = false, extendedWarp = false, mirrored = false) {
    const msg = {
      t: T.SEL_LIFT,
      sx: Math.round(rect.x),
      sy: Math.round(rect.y),
      sw: Math.round(rect.width),
      sh: Math.round(rect.height)
    };

    if (lassoPath && lassoPath.length > 0) {
      msg.cr = lassoPath.flatMap(p => [p.x, p.y]);
    }
    // All-layers lift erases from — and later re-stamps into — every visible
    // layer group. `imageData` is the flattened composite, so a receiver has no
    // way to infer that the source spanned more than the sender's active layer.
    if (allLayers) msg.a = true;
    if (extendedWarp) msg.selExtendedWarp = true;
    if (mirrored) msg.m = true;
    if (imageData) {
      msg.g = imageData;
    }
    this.send(msg);
  }

  /**
   * Broadcasts a pending selection marquee.
   * @param {Object} rect - Bounding box.
   * @param {Array<Object>|null} [lassoPath=null] - Optional path.
   * @returns {void}
   */
  broadcastSelectionPending(rect, lassoPath = null) {
    const msg = {
      t: T.SEL_PENDING,
      sx: Math.round(rect.x),
      sy: Math.round(rect.y),
      sw: Math.round(rect.width),
      sh: Math.round(rect.height)
    };

    if (lassoPath && lassoPath.length > 0) {
      msg.ps = lassoPath.flatMap(p => [p.x, p.y]);
    }
    this.send(msg);
  }

  /**
   * Broadcasts mask mode activation/deactivation.
   * @param {boolean} active - Whether mask is being activated.
   * @param {Object|null} [rect=null] - Bounding box (required when active=true).
   * @param {Array<Object>|null} [lassoPath=null] - Optional lasso path.
   * @returns {void}
   */
  broadcastSelectionMask(active, rect = null, lassoPath = null) {
    // `mk` is a proto BOOL. Emitting 1/0 encodes to identical wire bytes, but
    // the Recorder tapes the outbound JS object as-is while receivers tape the
    // DECODED message — where a bool is `true`. That made every SEL_MASK look
    // like a sender/receiver disagreement to the tape oracle (`mk:1` vs
    // `mk:true`) even though the bytes matched. Every other bool field here
    // already emits a real boolean; this was the one holdout.
    const msg = { t: T.SEL_MASK, mk: !!active };
    if (active && rect) {
      msg.sx = Math.round(rect.x);
      msg.sy = Math.round(rect.y);
      msg.sw = Math.round(rect.width);
      msg.sh = Math.round(rect.height);
      if (lassoPath && lassoPath.length > 0) {
        msg.ps = lassoPath.flatMap(p => [p.x, p.y]);
      }
    }
    this.send(msg);
  }

  /**
   * Broadcasts a selection movement (perspective transform).
   * @param {Object} corners - {tl, tr, br, bl} corner coordinates.
   * @param {Object|null} [sourceCrop=null]
   * @param {boolean} [extendedWarp=false] - Drawer's CURRENT extendedWarp
   *   toggle, so remote preview and replay scrubbing mid-drag reflect a
   *   toggle change immediately instead of only at the eventual commit.
   * @returns {void}
   */
  broadcastSelectionMove(corners, sourceCrop = null, extendedWarp = false) {
    const msg = {
      t: T.SEL_MOVE,
      cr: [
        corners.tl.x, corners.tl.y,
        corners.tr.x, corners.tr.y,
        corners.br.x, corners.br.y,
        corners.bl.x, corners.bl.y
      ]
    };
    if (extendedWarp) msg.selExtendedWarp = true;

    if (sourceCrop) {
      msg.cb = [
        sourceCrop.x,
        sourceCrop.y,
        sourceCrop.width,
        sourceCrop.height
      ];
      const total = sourceCrop.total;
      if (total) {
        msg.cbt = [
          total.x,
          total.y,
          total.width,
          total.height
        ];
      }
    }

    this.send(msg);
  }

  /**
   * Broadcasts a selection commit (baking) event.
   * @param {boolean} [extendedWarp=false] - Drawer's CURRENT extendedWarp
   *   toggle (can differ from the value that travelled with SEL_LIFT if
   *   toggled mid-selection) — the value that actually decided this bake.
   * @returns {void}
   */
  broadcastSelectionCommit(layerIndex, extendedWarp = false, mirrored = false) {
    const msg = { t: T.SEL_COMMIT };
    if (layerIndex !== undefined) msg.ly = layerIndex;
    if (extendedWarp) msg.selExtendedWarp = true;
    // Full-board mirror state at commit time — see broadcastSelectionDelete.
    if (mirrored) msg.m = true;
    this.send(msg);
  }

  /**
   * Broadcasts a selection deletion.
   * @param {number} [layerIndex] - Target layer index.
   * @returns {void}
   */
  broadcastSelectionDelete(layerIndex, allLayers = false, mirrored = false) {
    const msg = { t: T.SEL_DELETE };
    if (layerIndex !== undefined) msg.ly = layerIndex;
    // All-layers clears span every layer group; `ly` alone cannot express that.
    if (allLayers) msg.a = true;
    // Mirror state at the time of the clear. A joiner replaying the tail has not
    // necessarily applied the room's mirror toggle yet, so it cannot be inferred.
    if (mirrored) msg.m = true;
    this.send(msg);
  }

  /**
   * Broadcasts a selection fill event.
   * @param {Object} color - {r, g, b, a} color.
   * @param {number} [layerIndex] - Target layer index.
   * @returns {void}
   */
  broadcastSelectionFill(color, layerIndex, rect = null, lassoPath = null, mirrored = false) {
    const msg = { t: T.SEL_FILL, c: packColor(color) };
    if (layerIndex !== undefined) msg.ly = layerIndex;
    // Full-board mirror state at fill time — see broadcastSelectionDelete. The
    // local fill has mirrored since long before the receiver did, so a mirrored
    // selection fill existed only on the drawer's own screen.
    if (mirrored) msg.m = true;
    // The lasso SHAPE must travel with the fill for the same reason the rect
    // does: it cannot be inferred by the receiver. It used to be read off
    // whatever `pendingLassoPath` / `lassoPath` the receiver happened to hold,
    // which is state the fill does not own — so on any rebuild where those had
    // been cleared (a lift nulls pendingLassoPath; StrokeTape empties a user's
    // selection frames after each SEL_STAMP/SEL_FILL, so a second fill or a
    // fill after a stamp ships no SEL_PENDING at all) the receiver fell through
    // to `fillRect` over the bounds and a lasso fill rebuilt as a filled
    // BOUNDING BOX. Sending it makes the fill self-contained.
    if (lassoPath && lassoPath.length >= 3) {
      msg.ps = lassoPath.flatMap((p) => [p.x, p.y]);
    }
    // The filled rect must travel. A rect selection is cropped to its content
    // for display, but Fill deliberately fills the user's ORIGINAL dragged rect
    // (SelectTool.fillSelection uses `originalSelection || selection`). The
    // receiver only ever cached the cropped one, so without this it filled a
    // smaller area than the drawer did.
    if (rect) {
      msg.sx = Math.round(rect.x);
      msg.sy = Math.round(rect.y);
      msg.sw = Math.round(rect.width);
      msg.sh = Math.round(rect.height);
    }
    this.send(msg);
  }

  /**
   * Broadcasts a selection stamp (bake without clearing) event.
   * @param {boolean} [extendedWarp=false] - See broadcastSelectionCommit.
   * @returns {void}
   */
  broadcastSelectionStamp(layerIndex, extendedWarp = false, mirrored = false) {
    const msg = { t: T.SEL_STAMP };
    if (layerIndex !== undefined) msg.ly = layerIndex;
    if (extendedWarp) msg.selExtendedWarp = true;
    // Full-board mirror state at stamp time — see broadcastSelectionDelete.
    if (mirrored) msg.m = true;
    this.send(msg);
  }

  /**
   * Broadcasts a selection merge operation between layers.
   * @param {'up'|'down'|'all'} mode - Merge direction.
   * @param {number} sourceLayer - The user's source/active layer index.
   * @returns {void}
   */
  broadcastSelectionMerge(mode, sourceLayer) {
    const msg = { t: T.SEL_MERGE, g: mode };
    if (sourceLayer !== undefined) msg.ly = sourceLayer;
    this.send(msg);
  }

  /**
   * Broadcasts a selection flip.
   * @returns {void}
   */
  broadcastSelectionFlip() {
    this.send({ t: T.SEL_FLIP });
  }

  /**
   * Broadcasts a selection cancellation.
   * @returns {void}
   */
  broadcastSelectionCancel() {
    this.send({ t: T.SEL_CANCEL });
  }

  /**
   * Hides or shows the local user's selection outline on other clients' boards,
   * e.g. while the save dialog is open so it doesn't sit there distracting others.
   * @param {boolean} hidden
   */
  broadcastSelectionVisibility(hidden) {
    this.send({ t: T.SEL_HIDE, a: !!hidden });
  }

  /**
   * Broadcasts a selection-to-brush conversion.
   * @param {Object} brushData - Brush configuration.
   * @returns {void}
   */
  broadcastSelectionToBrush(brushData) {
    this.send({ t: T.SEL_TO_BRUSH, g: JSON.stringify(brushData) });
  }

  broadcastObscureRegion(payload) {
    this.send({ t: T.OBSCURE_REGION, g: JSON.stringify(payload) });
  }

  /**
   * Broadcasts a pasted image to the canvas.
   * @param {number} x - Target X.
   * @param {number} y - Target Y.
   * @param {number} width - Display width.
   * @param {number} height - Display height.
   * @param {string} dataUrl - Base64 image data URL.
   * @returns {void}
   */
  broadcastImagePaste(x, y, width, height, dataUrl) {
    this.send({
      t: T.IMG_PASTE,
      sx: Math.round(x),
      sy: Math.round(y),
      sw: Math.round(width),
      sh: Math.round(height),
      g: dataUrl
    });
  }

  /**
   * Broadcasts a computed glitch blur result image for deterministic sync.
   * @param {number} x - Top-left X of the blur region.
   * @param {number} y - Top-left Y of the blur region.
   * @param {number} width - Width of the blur region.
   * @param {number} height - Height of the blur region.
   * @param {string} dataUrl - Base64 PNG data URL of the blur result.
   */
  broadcastGlitchResult(x, y, width, height, dataUrl, layerIndex, blendMode, blendBakeMode) {
    const msg = {
      t: T.GLITCH_RESULT,
      sx: Math.round(x),
      sy: Math.round(y),
      sw: Math.round(width),
      sh: Math.round(height),
      g: dataUrl
    };
    if (layerIndex !== undefined) msg.ly = layerIndex;
    // Carry the stroke's draw-time blend. The result commits asynchronously on
    // the receiver (after the image decodes), so its blend can't be re-derived
    // from the sender's live blend state — it must travel with the result. Sent
    // together (bm+bbm) only for non-trivial blends to keep the common case off
    // the wire.
    if (blendMode && blendMode !== 'source-over') {
      msg.bm = blendMode;
      msg.bbm = normalizeBlendBakeMode(blendBakeMode);
    }
    this.send(msg);
  }

  /**
   * Requests a canvas synchronization from the server.
   * @param {number|null} [targetUserId=null] - Specific user ID to sync from.
   * @returns {void}
   */
  requestSync(targetUserId = null) {
    // Any backfill still streaming belongs to the sync we're abandoning; its
    // frames would be spliced onto a tape that has since been re-anchored.
    this._historyBackfill = null;
    const msg = { t: T.SYNC_REQUEST };
    if (targetUserId !== null) {
      msg.tu = targetUserId;
    }
    this.send(msg);
  }

  /**
   * Broadcasts real-time tile ownership updates as user draws.
   * @param {Array<number>} tileIndices - Array of tile indices the user now owns.
   * @returns {void}
   */
  broadcastTileUpdate(tileIndices) {
    if (!tileIndices || tileIndices.length === 0) return;
    // Send tiles as array of {idx, users} where users is just [self]
    const tiles = tileIndices.map(idx => ({ idx, users: [] }));
    this.send({ t: T.TILE_UPDATE, tiles });
  }

  /**
   * Broadcasts tiles that are now empty (ownership should be cleared).
   * @param {Array<number>} tileIndices - Array of tile indices that are now empty.
   * @returns {void}
   */
  broadcastTileClear(tileIndices) {
    if (!tileIndices || tileIndices.length === 0) return;
    this.send({ t: T.TILE_CLEAR, clearedTiles: tileIndices });
  }

  /**
   * Sends a user registration request.
   * @param {string} username - Chosen username.
   * @param {string} password - Chosen password.
   * @returns {void}
   */
  sendAuthRegister(username, password, { email = '', secretQuestion = '', secretAnswer = '' } = {}) {
    const identityPayload = this._getImmediateIdentityPayload();
    const msg = { t: T.AUTH_REGISTER, authUsername: username, authPassword: password, ...identityPayload };
    if (email) msg.authEmail = email;
    if (secretQuestion) msg.authSecretQuestion = secretQuestion;
    if (secretAnswer) msg.authSecretAnswer = secretAnswer;
    this.send(msg);
  }

  /**
   * Sends a user login request.
   * @param {string} username - Username.
   * @param {string} password - Password.
   * @returns {void}
   */
  sendAuthLogin(username, password) {
    const identityPayload = this._getImmediateIdentityPayload();
    this.send({ t: T.AUTH_LOGIN, authUsername: username, authPassword: password, ...identityPayload });
  }

  /**
   * Sends an authentication token login request.
   * @param {string} token - JWT or session token.
   * @returns {void}
   */
  sendAuthTokenLogin(token) {
    const identityPayload = this._getImmediateIdentityPayload();
    this.send({ t: T.AUTH_LOGIN, authToken: token, ...identityPayload });
  }

  /**
   * Sends a moderation action request.
   * @param {number} actionType - Type of action (BAN, KICK, etc.).
   * @param {number} targetSessionIndex - Target user ID.
   * @param {string} reason - Optional reason.
   * @param {number} duration - Optional duration in seconds.
   * @returns {void}
   */
  sendModAction(actionType, targetSessionIndex, reason, duration, ipScope) {
    const payload = {
      t: T.MOD_ACTION,
      modActionType: actionType,
      modTarget: targetSessionIndex,
      modReason: reason || '',
      modDuration: duration || 0
    };
    if (ipScope) payload.modIpScope = ipScope;
    this.send(payload);
  }

  /**
   * Sends a revoke request for an existing moderation entry.
   * `modReason` is repurposed here to carry the entry id for revoke actions.
   * @param {number} actionType - 3=unmute, 4=unban, 7=unshadowban
   * @param {string} entryId - Moderation entry id to revoke
   * @param {string} [targetName] - Target username for UI notifications/fallback lookup
   * @param {number} [targetSessionIndex] - Live session index, when known, so the
   *   server can clear the target's in-memory muted/shadowbanned flag immediately
   *   instead of relying solely on the (async) DB state.
   * @returns {void}
   */
  sendModRevoke(actionType, entryId, targetName = '', targetSessionIndex) {
    const payload = {
      t: T.MOD_ACTION,
      modActionType: actionType,
      modTargetName: targetName || '',
      modReason: entryId || ''
    };
    if (targetSessionIndex !== undefined && targetSessionIndex !== null) {
      payload.modTarget = targetSessionIndex;
    }
    this.send(payload);
  }

  /**
   * Sends a request to change the duration/expiry of an existing moderation entry.
   * `modReason` is repurposed to carry the entry id; `modDuration` carries the new
   * duration in minutes (0 = permanent).
   * @param {string} entryId - Moderation entry id to update
   * @param {number} minutes - New duration in minutes (0 = permanent)
   * @returns {void}
   */
  sendModUpdateDuration(entryId, minutes) {
    this.send({
      t: T.MOD_ACTION,
      modActionType: 8,
      modReason: entryId || '',
      modDuration: minutes || 0
    });
  }

  /**
   * Requests the current moderation list (bans/warnings).
   * @param {Object} [params] - Filtering parameters.
   * @returns {void}
   */
  requestModList({ showHistory = false, search = '' } = {}) {
    this.send({ t: T.MOD_LIST, modShowHistory: showHistory, modSearch: search });
  }

  /**
   * Sends a request to wipe all drawings by a specific user.
   * @param {number} targetSessionIndex - Target user ID.
   * @param {string} [targetName] - Target username.
   * @returns {void}
   */
  sendModWipe(targetSessionIndex, targetName) {
    this.send({
      t: T.MOD_WIPE,
      modTarget: targetSessionIndex,
      modTargetName: targetName || ''
    });
  }

  /**
   * Sets a user's room-specific role.
   * @param {string} targetUserId - The target user's ID.
   * @param {number} role - The role value (0-5).
   */
  sendRoomRoleSet(targetSessionIndex, role, targetUsername = '') {
    this.send({
      t: T.ROOM_ROLE_SET,
      roomRoleTargetId: String(targetSessionIndex || ''),
      roomRoleTargetName: targetUsername || '',
      roomRoleValue: role
    });
  }

  /**
   * Sets a user's global role (User/Noble/Holy). DEITY only.
   * @param {string} targetUsername - The target user's username.
   * @param {number} newGlobalRole - The new global role (1=User, 7=Noble, 8=Holy).
   */
  sendGlobalRoleSet(targetUsername, newGlobalRole) {
    this.send({
      t: T.GLOBAL_ROLE_SET,
      targetUsername: targetUsername,
      newGlobalRole: newGlobalRole
    });
  }

  sendGlobalMessage(message, { kind = 'staff', persistent = false } = {}) {
    this.send({
      t: T.GLOBAL_MESSAGE,
      g: message,
      k: kind,
      a: !!persistent
    });
  }

  /**
   * Requests the moderation roster for the current room.
   * @returns {void}
   */
  requestRoomRoleList() {
    this.send({ t: T.ROOM_ROLE_LIST_REQUEST });
  }

  /**
   * Requests the list of active rooms from the server.
   * @returns {void}
   */
  requestRoomList() {
    this.send({ t: T.ROOM_LIST_REQUEST });
  }

  /**
   * Sends a room preview image to the server.
   * @param {Uint8Array} imageData - PNG image data at 1/4 scale
   * @returns {void}
   */
  broadcastRoomPreview(imageData) {
    this.send({ t: T.ROOM_PREVIEW, img: imageData });
  }

  broadcastCheckpoint(imageData) {
    this.send({ t: T.CHECKPOINT_UPLOAD, checkpointImg: imageData });
  }

  requestReplay(startTs, endTs) {
    this.send({ t: T.REPLAY_REQUEST, replayStartTs: startTs, replayEndTs: endTs });
  }

  requestCheckpointList() {
    this.send({ t: T.CHECKPOINT_LIST });
  }

  requestSnapshotGet(snapshotId) {
    this.send({ t: T.BOARD_SNAPSHOT_GET, snapshotId });
  }

  /**
   * Closes the WebSocket connection.
   * @returns {void}
   */
  disconnect() {
    this._cancelled = true;
    this._clearReconnectTimer();
    if (this.socket) {
      this.socket.close();
    }
  }
}

export { T, Tool, ToolNames, ToolToEnum, packColor, unpackColor };
