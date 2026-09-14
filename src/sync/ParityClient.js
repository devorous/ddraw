/**
 * @fileoverview Client-side coordinator for stroke-log parity checks.
 *
 * Owns the heartbeat timer and the chunk-diff state machine.
 *
 *   30s timer (paused while disconnected/AFK) →
 *     send SYNC_PARITY_CHECK { seq, parityCount, parityRollingHash }
 *
 *   server replies SYNC_PARITY_OK    → clear any pending mismatch UI, done
 *   server replies SYNC_PARITY_MISMATCH (with inline manifest):
 *     1. compare server's chunkHashes to ours
 *     2. for each diverging chunk, send SYNC_PARITY_CHUNK_REQUEST { chunkIndex }
 *     3. on SYNC_PARITY_CHUNK reply, build per-seq diffs:
 *          - missing: server has seq, we don't
 *          - extra:   we have seq, server doesn't
 *          - mismatched: same seq, different fingerprint
 *     4. emit `onMismatchResolved({ percent, missing, extra, mismatched })`
 *        for the UI to render. Phase 2 does NOT auto-resync — surface only.
 */

import { T } from '../../shared/MessageTypes.js';
import { fnv1a32 } from '../../shared/StrokeFingerprint.js';

const DEFAULT_HEARTBEAT_MS = 30_000;

export class ParityClient {
  /**
   * @param {Object} opts
   * @param {Object} opts.wsClient - WebSocketClient (provides .send and .strokeLog)
   * @param {() => boolean} [opts.shouldPause] - Return true to skip a heartbeat
   *   (e.g. while disconnected, AFK, or tab hidden). Defaults to false.
   * @param {(event: Object) => void} [opts.onMismatch] - Called when a mismatch
   *   is fully diagnosed: { serverCount, clientCount, percent, missing[],
   *   extra[], mismatched[] }
   * @param {() => void} [opts.onOk] - Called on each successful heartbeat ack.
   * @param {number} [opts.intervalMs]
   */
  constructor({ wsClient, shouldPause, onMismatch, onOk, intervalMs = DEFAULT_HEARTBEAT_MS } = {}) {
    this.wsClient = wsClient;
    this.shouldPause = shouldPause || (() => false);
    this.onMismatch = onMismatch || (() => {});
    this.onOk = onOk || (() => {});
    this.intervalMs = intervalMs;

    this._timer = null;

    // Per-mismatch state. Reset on every CHECK send and on OK receipt.
    this._pending = null;

    // Suppress repeated console noise within a single mismatch episode.
    this._lastMismatchLogTs = 0;
  }

  /**
   * Start the heartbeat timer. Safe to call multiple times — idempotent.
   */
  start() {
    if (this._timer != null) return;
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  /**
   * Stop the heartbeat. Drops any in-flight mismatch diagnosis too.
   */
  stop() {
    if (this._timer != null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._pending = null;
  }

  /**
   * Force a heartbeat immediately (e.g. after reconnect or for the dev command).
   */
  checkNow() {
    this._tick(true);
  }

  /**
   * Ask the server to replay specific missing seqs. Sends a single
   * SYNC_PARITY_RESYNC_REQUEST; the server writes each missing message
   * back to our socket as bit-identical bytes, which our normal
   * _processMessage pipeline applies (re-appending to the strokeLog).
   * @param {number[]} seqs
   */
  requestResync(seqs) {
    if (!Array.isArray(seqs) || seqs.length === 0) return;
    const ws = this.wsClient;
    if (!ws || !ws.connected) return;
    ws.send({
      t: T.SYNC_PARITY_RESYNC_REQUEST,
      parityResyncSeqs: seqs.map((s) => Number(s)),
    });
  }

  /** @private */
  _tick(force = false) {
    const ws = this.wsClient;
    if (!ws || !ws.connected || !ws.strokeLog) return;
    if (!force && this.shouldPause()) return;

    const summary = ws.strokeLog.getSummary();
    // Capture the snapshot the request was based on so the response handler
    // can validate it's still relevant when chunks arrive (the log may have
    // grown between send and reply).
    this._pending = {
      sentAt: Date.now(),
      clientSnapshot: { ...summary, entries: [...ws.strokeLog.entries] },
      manifest: null,
      diff: null,
      requestedChunks: new Set(),
      receivedChunks: new Map(),
    };

    const msg = {
      t: T.SYNC_PARITY_CHECK,
      seq: summary.latestSeq,
      parityCount: summary.count,
      parityRollingHash: summary.rollingHash,
    };

    ws.send(msg);
  }

  /**
   * Route an inbound parity message. Called from WebSocketClient._processMessage.
   * @param {Object} data - Decoded message (camelCase fields per protobufjs)
   * @returns {boolean} true if handled (caller can skip default routing)
   */
  receive(data) {
    switch (data.t) {
      case T.SYNC_PARITY_OK:
        this._handleOk(data);
        return true;
      case T.SYNC_PARITY_MISMATCH:
        this._handleMismatch(data);
        return true;
      case T.SYNC_PARITY_CHUNK:
        this._handleChunk(data);
        return true;
      default:
        return false;
    }
  }

  /** @private */
  _handleOk(_data) {
    this._pending = null;
    try { this.onOk(); } catch (e) { console.error('[ParityClient] onOk threw', e); }
  }

  /** @private */
  _handleMismatch(data) {
    if (!this._pending) return; // we didn't send a CHECK — server is confused or replaying
    const ws = this.wsClient;
    const log = ws?.strokeLog;
    if (!log) return;

    const serverChunkSize = Number(data.parityChunkSize || 0);
    const serverChunkHashes = Array.isArray(data.parityChunkHashes)
      ? data.parityChunkHashes.map((h) => h >>> 0)
      : [];
    const serverCount = Number(data.parityServerCount || 0);
    const percent = Number(data.parityPercentX100 || 0) / 100;

    this._pending.manifest = {
      chunkSize: serverChunkSize,
      chunkHashes: serverChunkHashes,
      serverCount,
      percent,
    };
    // Capture the server's persistence id so the post-diff report can be
    // attached to the same MongoDB document.
    this._pending.eventId = String(data.parityEventId || '');

    // Our chunk hashes — recompute fresh from the current strokeLog. If the
    // log has grown since we sent the CHECK, that's OK — we'll request only
    // chunks indexed within the server's manifest range. Strokes that
    // arrived after the manifest was built are just out of scope.
    const ours = log.getChunkHashes();

    const diverging = [];
    const maxIdx = Math.min(ours.chunkHashes.length, serverChunkHashes.length);
    for (let i = 0; i < serverChunkHashes.length; i++) {
      const oursHash = i < ours.chunkHashes.length ? ours.chunkHashes[i] : null;
      if (oursHash !== serverChunkHashes[i]) {
        diverging.push(i);
      }
    }
    // Server might have fewer chunks than we do (we have spurious extras).
    // We don't request those — we just report them in the final diff.

    // Hard cap on the request burst: 16 chunks per mismatch episode keeps
    // server load bounded even if a client is wildly out of sync.
    const REQUEST_CAP = 16;
    const toRequest = diverging.slice(0, REQUEST_CAP);

    this._pending.divergingChunks = diverging;
    this._pending.maxCommonChunkIdx = maxIdx;

    if (toRequest.length === 0) {
      // Counts/hashes differ but chunk hashes match within the common range —
      // means client has either fewer or extra entries past the server's tail.
      this._finalizeDiff();
      return;
    }

    for (const idx of toRequest) {
      this._pending.requestedChunks.add(idx);
      ws.send({
        t: T.SYNC_PARITY_CHUNK_REQUEST,
        parityChunkIndex: idx,
      });
    }
  }

  /** @private */
  _handleChunk(data) {
    if (!this._pending) return;

    const idx = Number(data.parityChunkIndex || 0);
    const entries = Array.isArray(data.parityEntries)
      ? data.parityEntries.map((e) => ({
          seq: Number(e.seq || 0),
          t: Number(e.t || 0),
          userId: Number(e.userId || 0),
          timestamp: Number(e.timestamp || 0),
          fingerprint: (e.fingerprint >>> 0),
          kind: String(e.kind || ''),
        }))
      : [];

    this._pending.receivedChunks.set(idx, entries);

    if (this._pending.receivedChunks.size >= this._pending.requestedChunks.size) {
      this._finalizeDiff();
    }
  }

  /**
   * Walk the received chunks against our local log to produce the missing /
   * extra / mismatched lists, then fire onMismatch.
   * @private
   */
  _finalizeDiff() {
    const p = this._pending;
    if (!p) return;
    this._pending = null;

    const log = this.wsClient?.strokeLog;
    if (!log) return;

    // Index our local entries by seq for fast lookup
    const ourBySeq = new Map();
    for (const e of log.entries) ourBySeq.set(e.seq, e);

    const missing = [];
    const mismatched = [];
    const serverSeqs = new Set();

    // Iterate over all received chunks; per chunk, compare to our local seqs
    for (const [, entries] of p.receivedChunks) {
      for (const se of entries) {
        serverSeqs.add(se.seq);
        const ours = ourBySeq.get(se.seq);
        if (!ours) {
          missing.push(se);
        } else if (ours.fingerprint !== se.fingerprint) {
          mismatched.push({ seq: se.seq, server: se, client: ours });
        }
      }
    }

    // Extras = local entries within the chunk range we requested that the
    // server didn't include. Approximation — if we didn't pull every chunk,
    // we can only report extras within the chunks we did pull.
    const chunkSize = p.manifest.chunkSize;
    const requestedRanges = [...p.requestedChunks].map((idx) => ({
      lo: idx * chunkSize,
      hi: idx * chunkSize + chunkSize, // exclusive end
    }));
    const extras = [];
    for (let i = 0; i < log.entries.length; i++) {
      const e = log.entries[i];
      // Is this entry's position within any requested chunk's index range?
      const within = requestedRanges.some(r => i >= r.lo && i < r.hi);
      if (within && !serverSeqs.has(e.seq)) extras.push(e);
    }

    const diff = {
      serverCount: p.manifest.serverCount,
      clientCount: log.getSummary().count,
      percent: p.manifest.percent,
      missing,
      extra: extras,
      mismatched,
      truncatedChunks: p.divergingChunks.length > p.requestedChunks.size,
    };

    // Throttle console output to once per ~5s per session — UI surface still
    // fires every time
    const now = Date.now();
    if (now - this._lastMismatchLogTs > 5000) {
      this._lastMismatchLogTs = now;
      console.warn('[ParityClient] desync detected', {
        clientCount: diff.clientCount,
        serverCount: diff.serverCount,
        percent: `${diff.percent.toFixed(2)}%`,
        missing: diff.missing.length,
        extra: diff.extra.length,
        mismatched: diff.mismatched.length,
      });
    }

    // Post the diff detail to the server so it can be persisted for
    // post-hoc debugging. Cap arrays at 200 entries to keep the report
    // size sane; flag truncation so the dashboard can tell.
    this._submitReport(p.eventId, diff);

    try { this.onMismatch(diff); } catch (e) { console.error('[ParityClient] onMismatch threw', e); }
  }

  /**
   * Send the post-diff detail back to the server for persistence.
   * @param {string} eventId
   * @param {Object} diff
   * @private
   */
  _submitReport(eventId, diff) {
    if (!eventId) return;
    const ws = this.wsClient;
    if (!ws || !ws.connected) return;

    const CAP = 200;
    const truncate = (arr) => Array.isArray(arr) ? arr.slice(0, CAP) : [];
    const truncated =
      (diff.missing?.length || 0) > CAP ||
      (diff.extra?.length || 0) > CAP ||
      (diff.mismatched?.length || 0) > CAP;

    const fpEntry = (e) => ({
      seq: e.seq,
      t: e.t,
      userId: e.userId,
      timestamp: e.timestamp,
      fingerprint: e.fingerprint,
      kind: e.kind,
    });

    ws.send({
      t: T.SYNC_PARITY_MISMATCH_REPORT,
      parityEventId: eventId,
      parityMissing: truncate(diff.missing).map(fpEntry),
      parityExtra: truncate(diff.extra).map(fpEntry),
      parityMismatchedSeqs: truncate(diff.mismatched).map((m) => m.seq),
      parityReportTruncated: truncated,
    });
  }
}
