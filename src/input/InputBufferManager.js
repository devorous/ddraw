/**
 * @fileoverview Manages input buffering, tick loop synchronization, and point optimization.
 * Orchestrates local drawing feedback and network broadcast rates based on device performance.
 */

import { douglasPeucker } from '../utils/drawing.js';
import { applySmoothingEMA, applyDeadband, resetSmoothingBuffer } from '../utils/smoothing.js';
import { FLOWPEN_DEADBAND, flowPenDeadbandRadius } from '../config/flowPenFilter.js';
import * as wasm from '../wasm/ddraw_wasm.js';

let douglasPeuckerWasm = null;
for (const [exportName, exportValue] of Object.entries(wasm)) {
  if (exportName === 'douglas_peucker_wasm' && typeof exportValue === 'function') {
    douglasPeuckerWasm = exportValue;
    break;
  }
}

const TPS_NORMAL = 60;

/**
 * Idle tile reclamation, in ms between passes and tiles inspected per pass.
 *
 * Each inspected tile is a `getImageData`, so this is throttled twice: by the
 * idle gate in `_maybeReclaimTiles` and by this interval. 250ms/4 tiles clears
 * the handful of candidates an ordinary eraser stroke leaves behind within a
 * second of the user stopping, and bounds an erase-all's backlog to 16
 * readbacks per second spread across idle ticks — invisible next to the frame
 * budget, and only ever paid on ticks where nothing is being drawn.
 */
const RECLAIM_INTERVAL_MS = 250;
const RECLAIM_BUDGET = 4;

// Matched case-insensitively against the unmasked WebGL renderer string.
// `intel uhd graphics 6` used to be here and was too specific to be useful — it
// missed `ANGLE (Intel, Mesa Intel(R) UHD Graphics (JSL))`, a 2-core machine
// that is squarely the target of this list. Integrated Intel parts are matched
// on the family name instead.
// A GPU match alone scores +3, which is the whole threshold, so entries must be
// parts that are genuinely weak — Iris Xe is deliberately absent.
const LOW_POWER_GPU_PATTERNS = [
  'mali', 'adreno', 'powervr', 'swiftshader', 'llvmpipe',
  'intel hd graphics', 'intel uhd graphics',
  'vivante', 'videocore', 'tegra', 'exynos',
];

const REDUCE_BEFORE_RENDER_TOOLS = new Set([
  'ink',
  'erase',
  'blur',
  'glitchBlur'
]);
const BATCH_RENDER_TOOLS = new Set([
  'brush',
  'flowPen',
  'ink',
  'erase',
  'blur',
  'circleBlur',
  'glitchBlur',
  'pixel',
  'imageBrush',
  'confetti'
]);
const LATEST_POINT_ONLY_TOOLS = new Set(['select']);
// Tools that need all points for smooth remote rendering (no Douglas-Peucker reduction)
const SKIP_NETWORK_REDUCTION_TOOLS = new Set(['brush']);

/**
 * Detects if the current device is low-power to adjust the tick rate.
 * Uses hardware concurrency, device memory, and WebGL renderer hints.
 *
 * @returns {boolean} True if the device is considered low-power.
 */
/**
 * Score the device and decide whether it should run in low power mode.
 *
 * Exported because the result is now the resolution of the 'auto' preference
 * rather than a value the preference immediately overwrites. Memoized: it
 * creates a WebGL context and deliberately loses it, so it must not be called
 * repeatedly from a settings UI.
 *
 * @returns {boolean}
 */
export function detectLowPowerDevice() {
  if (_detectionResult !== null) return _detectionResult;
  _detectionResult = _runLowPowerDetection();
  return _detectionResult;
}

let _detectionResult = null;

/**
 * Synthetic draw-workload micro-benchmark, run once at boot instead of the
 * static heuristics below. Times a fixed, seeded sequence of stroke draws
 * (same shape as real brush strokes: variable width/color, ragged path,
 * round joins) on a detached canvas, so the number reflects the actual
 * per-frame cost this app pays rather than a proxy for it (core count, GPU
 * name string). Deterministic PRNG so repeated runs/machines are comparable.
 *
 * MEASUREMENT ONLY for now — recorded on window.__performanceDetection as
 * `benchmarkMs` alongside the proxy-based score, not yet folded into
 * `isLowPower`. Needs numbers from more than two machines before a cutoff is
 * trustworthy; see the score() derivation once that data exists.
 *
 * Fixed 1080p surface for every device, deliberately NOT sized from the
 * viewport/DPR: a per-device surface (tried and measured — see git history)
 * made the raw ms number viewport-relative, so any cutoff would've needed to
 * be viewport-relative too. A bigger fixed surface only widens the gap
 * between fast/slow hardware (confirmed: going from 900x700 to 1900x1200
 * roughly doubled both machines' times while keeping their ratio to each
 * other about the same) — so fix the surface large and get a bigger,
 * easier-to-threshold signal instead of a workload-accurate one.
 *
 * @returns {number|null} Elapsed ms for STROKES strokes, or null if a 2D
 *   context couldn't be created.
 */
function _runSynthDrawBenchmark() {
  const BASE_WIDTH = 1920;
  const BASE_HEIGHT = 1080;

  const canvas = document.createElement('canvas');
  canvas.width = BASE_WIDTH;
  canvas.height = BASE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const STROKES = 20;
  const WARMUP_STROKES = 5;
  const POINTS_PER_STROKE = 40;

  // xorshift32, seeded — deterministic across runs/machines so the timing
  // difference reflects hardware, not which random strokes got drawn.
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13; seed |= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed |= 0;
    return ((seed >>> 0) % 100000) / 100000;
  };

  const drawStrokes = (n) => {
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.lineWidth = 4 + rand() * 20;
      ctx.strokeStyle = `rgba(${Math.floor(rand() * 255)}, ${Math.floor(rand() * 255)}, ${Math.floor(rand() * 255)}, 0.7)`;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      let x = rand() * BASE_WIDTH;
      let y = rand() * BASE_HEIGHT;
      ctx.moveTo(x, y);
      for (let p = 0; p < POINTS_PER_STROKE; p++) {
        x += (rand() - 0.5) * 40;
        y += (rand() - 0.5) * 40;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Force rasterization — browsers may otherwise defer the actual paint
    // work past the last stroke() call.
    ctx.getImageData(0, 0, 1, 1);
  };

  // Untimed warm-up: the first-ever 2D context on a page pays a one-off
  // driver/pipeline init cost (measured ~65ms on a 4070 Super vs ~2ms
  // steady-state) that has nothing to do with the device's real drawing
  // throughput. Pay that cost here, outside the clock.
  drawStrokes(WARMUP_STROKES);

  // Median of several timed passes, not one sample: measured on the weak
  // laptop this pushes the coefficient of variation from ~0.43 (single
  // boot-time sample) down toward the ~0.22 seen from repeated sampling —
  // OS/driver scheduling jitter on a contended machine doesn't average out
  // of a single reading, but the median of a few does.
  const SAMPLES = 3;
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now();
    drawStrokes(STROKES);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(SAMPLES / 2)];
}

function _runLowPowerDetection() {
  let score = 0;
  const benchmarkMs = _runSynthDrawBenchmark();

  const cores = navigator.hardwareConcurrency || 0;
  if (cores > 0 && cores <= 4) score += 2;

  const memory = navigator.deviceMemory;
  if (memory !== undefined && memory <= 4) score += 2;

  let renderer = 'unknown';
  let maxTexture = 'N/A';
  let maxVertexUnits = 'N/A';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        if (LOW_POWER_GPU_PATTERNS.some(p => renderer.toLowerCase().includes(p))) score += 3;
      }

      maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (maxTexture <= 4096) score += 2;

      maxVertexUnits = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
      if (maxVertexUnits <= 4) score += 1;

      const loseExt = gl.getExtension('WEBGL_lose_context');
      if (loseExt) loseExt.loseContext();
    }
  } catch (_) {
    score += 3;
  }

  const isLowPower = score >= 3;

  // Store for debug display
  window.__performanceDetection = {
    score,
    isLowPower,
    cores,
    memory,
    renderer,
    maxTexture,
    maxVertexUnits,
    benchmarkMs,
    dpr: window.devicePixelRatio || 1,
    viewport: `${window.innerWidth}x${window.innerHeight}`
  };

  return isLowPower;
}

/**
 * InputBufferManager handles the accumulation and processing of pointer events.
 * It ensures smooth local rendering by decoupling input from the animation frame
 * and optimizes network bandwidth through point reduction algorithms.
 */
export class InputBufferManager {
  /**
   * @param {App} app - The main application instance.
   */
  constructor(app) {
    this.app = app;

    /** @type {boolean} */
    this.lowPowerMode = detectLowPowerDevice();
    /** @type {number} Always full rate; low power no longer slows input. */
    this.tickRate = TPS_NORMAL;
    /** @type {number} */
    this.tickInterval = 1000 / this.tickRate;
    /** @type {number|null} */
    this.tickTimer = null;
    /**
     * EMA of how late each tick lands vs. its expected interval — a free,
     * always-on congestion signal (no separate frame-timing instrumentation
     * needed). Drives the adaptive remote-preview render interval below:
     * on a bogged-down client, other users' strokes visibly batch and catch
     * up rather than each contributing to the pileup. Smoothed so one slow
     * tick doesn't flap the interval; recovers on its own as drift subsides.
     * @type {number}
     */
    this._tickDriftEmaMs = 0;
    /**
     * Debug/measurement-only override for getAdaptiveRemotePreviewIntervalMs.
     * null in normal operation.
     * @type {number|null}
     */
    this.debugForcedRemotePreviewIntervalMs = null;
    // Last idle tile-reclamation pass. Starts at -Infinity so the first idle
    // tick after load can run one rather than waiting out the interval.
    this._lastTileReclaim = -Infinity;
    /** @type {number|null} */
    this.lastTickTime = null;
    /** @type {number|null} */
    this.localFrameId = null;

    /** @type {Object} */
    this.inputBuffer = {
      points: [],
      pressure: 1,
      pointerType: 'mouse',
      position: null,
      lastPosition: null,
      dirty: false
    };

    /** @type {{x:number,y:number,p:number}|null} */
    this._lastBufferedSample = null;
    /** @type {Object} */
    this.subPixelCulling = {
      enabled: true,
      distSq: 1,           // skip if moved < 1 board-px (squared)
      pressureDelta: 0.01  // unless pressure changed by >= this
    };

    /** @type {Object} */
    this.pointReduction = {
      enabled: true,
      algorithm: 'douglas-peucker',
      minEpsilon: 0.1,
      maxEpsilon: 2.0,
      minDistance: 1,
      maxDistance: 5
    };

    /** @type {Object} */
    this.baselineSmoothing = {
      pointReduction: {
        minEpsilon: 0.5,
        maxEpsilon: 2.0
      }
    };

    /** @type {Object} */
    this.broadcastSmoothBuffer = { x: 0, y: 0, p: 1, isFirst: true, resultOut: { x: 0, y: 0, p: 1 } };
    /** @type {Array<number>} */
    this.pendingBroadcastPoints = [];
    this.pendingBroadcastPointsAreReduced = false;

    /** @type {Array<Function>} Ordered queue of broadcast callbacks */
    this.broadcastQueue = [];

    // Scratchpad objects for zero-allocation point processing
    this._currentPosScratch = { x: 0, y: 0 };
    this._prevPosScratch = { x: 0, y: 0 };
    this._smoothedPosScratch = { x: 0, y: 0 };

    this.pointTelemetry = {
      windowStartMs: performance.now(),
      bufferedInWindow: 0,
      outgoingInWindow: 0,
      bufferedPerSec: 0,
      outgoingPerSec: 0,
      reductionPercent: 0,
      lastUpdatedMs: performance.now()
    };
  }

  /**
   * Adjusts the tick rate at runtime.
   *
   * @param {number} tps - New ticks per second.
   * @returns {void}
   */
  setTickRate(tps) {
    this.tickRate = tps;
    this.tickInterval = 1000 / tps;
    if (this.tickTimer) {
      this.stopTickLoop();
      this.startTickLoop();
    }
  }

  /**
   * Starts the internal tick loop.
   * @returns {void}
   */
  startTickLoop() {
    if (this.tickTimer) return;

    this.lastTickTime = performance.now();
    this.tickTimer = setInterval(() => this.tick(), this.tickInterval);
  }

  /**
   * Stops the internal tick loop.
   * @returns {void}
   */
  stopTickLoop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.localFrameId !== null) {
      cancelAnimationFrame(this.localFrameId);
      this.localFrameId = null;
    }
  }

  requestLocalFrame() {
    if (this.localFrameId !== null) return;
    this.localFrameId = requestAnimationFrame(() => {
      this.localFrameId = null;
      this.processLocalFrame();
    });
  }

  cancelLocalFrame() {
    if (this.localFrameId === null) return;
    cancelAnimationFrame(this.localFrameId);
    this.localFrameId = null;
  }

  /**
   * Performs a single tick of input processing.
   * Prioritizes any pending local frame work, then flushes network state to peers.
   *
   * @returns {void}
   */
  tick() {
    const now = performance.now();
    if (this.lastTickTime !== null) {
      const drift = (now - this.lastTickTime) - this.tickInterval;
      // EMA over ~1s of ticks; clamp the input so one huge stall (e.g. a tab
      // coming back from background) doesn't need many ticks to decay back out.
      const sample = Math.max(0, Math.min(drift, 1000));
      const alpha = 2 / (this.tickRate + 1);
      this._tickDriftEmaMs += (sample - this._tickDriftEmaMs) * alpha;
    }
    this.lastTickTime = now;

    const { app } = this;

    if (app.syncClient?.isSyncing()) return;
    this.processLocalFrame();         // render locally, populate pendingBroadcastPoints
    this._snapshotStrokesToQueue();   // commit strokes to queue (no-op if buffer already drained)
    this.drainBroadcastQueue();       // send all queued actions in order
    this._maybeReclaimTiles(now);     // idle-only tile reclamation; never on a drawing tick
  }

  /**
   * How often THIS client should redraw other users' in-progress strokes,
   * in ms. Floor matches the long-standing fixed interval (never slower than
   * today on a healthy machine); ceiling caps how far behind a remote drawer
   * is allowed to visibly fall before catching up in one render — long enough
   * to shed real load, short enough that a remote cursor doesn't read as gone.
   * Recomputed on every call (cheap: one EMA read), so it eases back down on
   * its own as soon as tick drift subsides — no separate recovery timer.
   * @returns {number}
   */
  getAdaptiveRemotePreviewIntervalMs() {
    // Debug/measurement override — sweep a fixed interval instead of the
    // congestion-driven value, e.g. window.app.inputBufferManager
    // .debugForcedRemotePreviewIntervalMs = 100. Not used in normal operation.
    if (this.debugForcedRemotePreviewIntervalMs != null) {
      return this.debugForcedRemotePreviewIntervalMs;
    }
    const FLOOR_MS = 33;
    const CEIL_MS = 250;
    const DRIFT_TO_MS_SCALE = 2;
    return Math.min(CEIL_MS, FLOOR_MS + this._tickDriftEmaMs * DRIFT_TO_MS_SCALE);
  }

  /**
   * Give the tiled backing store a small slice of an otherwise-idle tick to
   * re-check tiles an erase may have emptied.
   *
   * Deliberately last in the tick and gated on idleness: each check is a canvas
   * readback, which is the one operation this whole subsystem is careful never
   * to put on a drawing path. A tick with buffered input, a smoothing catch-up
   * pending, or a stroke in flight does none of this work.
   *
   * Rate-limited on top of the idle gate because the tick runs at 60 TPS and
   * the queue is nearly always empty — polling it every 16ms to find nothing
   * is pure overhead. RECLAIM_INTERVAL_MS at RECLAIM_BUDGET tiles per pass
   * drains an eraser stroke's worth of candidates in well under a second while
   * capping the worst case (an erase-all queues every tile it crossed) at a few
   * readbacks per pass.
   *
   * @param {number} now
   * @private
   */
  _maybeReclaimTiles(now) {
    if (this.inputBuffer.dirty || this.needsSmoothingCatchup()) return;
    if (now - this._lastTileReclaim < RECLAIM_INTERVAL_MS) return;
    this._lastTileReclaim = now;
    this.app.board?.layerManager?.reclaimTiles?.(RECLAIM_BUDGET);
  }

  processLocalFrame() {
    const { app } = this;
    if (app.syncClient?.isSyncing()) return;

    const points = this._consumeBufferedPoints();
    if (points.length >= 3) {
      this._processBufferedPoints(points);
    }

    if (this.needsSmoothingCatchup()) {
      this.processSmoothingCatchup();
    }

    if (this.inputBuffer.dirty || this.needsSmoothingCatchup()) {
      this.requestLocalFrame();
    }
  }

  flushPendingNetwork() {
    this._snapshotStrokesToQueue();
    this.drainBroadcastQueue();
  }

  /**
   * Moves current pending strokes into the ordered broadcast queue.
   * This ensures that any strokes drawn before a discrete action (like undo)
   * are sent before that action.
   * 
   * @private
   */
  _snapshotStrokesToQueue() {
    // Process any unrendered input buffer points first
    const points = this._consumeBufferedPoints();
    if (points.length >= 3) {
      this._processBufferedPoints(points); // populates pendingBroadcastPoints
    }

    const { app } = this;

    // Commit stamp tool buffers (ink, gimp, etc.)
    const tool = app.toolManager.getCurrentTool();
    if (tool && this._isStampTool(app.self.tool)) {
      const drain = app.self.tool === 'ink' ? tool.drainPointBuffer?.() : tool.drainStampBuffer?.();
      if (drain?.ps?.length > 0) {
        const reduced = this._shouldPreserveStampPayload(app.self.tool)
          ? { ps: drain.ps, rs: Array.isArray(drain.rs) ? drain.rs : [] }
          : this._reduceStampPayload(drain.ps, drain.rs);
        if (app.self.tool === 'ink' && this._hasUniformRadii(reduced.rs)) {
          this._recordOutgoingPoints(reduced.ps.length / 2);
          this.broadcastQueue.push(() => app.wsClient.broadcastMove(reduced.ps));
        } else {
          this._recordOutgoingPoints(reduced.ps.length / 2);
          const metadata = {};
          if (app.self.tool === 'confetti') {
            const settings = tool.getNetworkSettings?.(app.self, { includeBrush: false });
            if (settings) metadata.confettiData = JSON.stringify(settings);
          }
          this.broadcastQueue.push(() => app.wsClient.broadcastStampMove(reduced.ps, reduced.rs, metadata));
        }
      }
    }

    // Commit pending move points
    if (this.pendingBroadcastPoints.length > 0) {
      // Skip reduction for tools that need all points for smooth remote rendering
      const skipReduction = SKIP_NETWORK_REDUCTION_TOOLS.has(app.self.tool);
      const reducedPoints = (this.pendingBroadcastPointsAreReduced || skipReduction)
        ? this.pendingBroadcastPoints
        : this.applyPointReduction(this.pendingBroadcastPoints);
      this.pendingBroadcastPoints = [];
      this.pendingBroadcastPointsAreReduced = false;
      if (reducedPoints.length > 0) {
        const xyPoints = [];
        for (let i = 0; i < reducedPoints.length; i += 3) {
          xyPoints.push(reducedPoints[i], reducedPoints[i + 1]);
        }
        this._recordOutgoingPoints(xyPoints.length / 2);
        this.broadcastQueue.push(() => app.wsClient.broadcastMove(xyPoints));
      }
    }
  }

  /**
   * Enqueues a broadcast action, ensuring it is sent in order relative to strokes.
   * 
   * @param {Function} fn - The broadcast callback to enqueue.
   */
  queueBroadcast(fn, options = {}) {
    if (this.app.syncClient?.isSyncing()) return; // dropped during sync; sync replay handles ordering
    if (options.snapshot !== false) {
      this._snapshotStrokesToQueue();
    }
    this.broadcastQueue.push(fn);
  }

  discardPendingStrokeInput() {
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
    this.pendingBroadcastPoints = [];
    this.pendingBroadcastPointsAreReduced = false;
    this._lastBufferedSample = null;
  }

  /**
   * Decides whether an incoming pointer sample should be discarded as a
   * sub-pixel/no-op move. Updates the last-buffered tracker when accepting.
   *
   * @param {number} x - Board-space x.
   * @param {number} y - Board-space y.
   * @param {number} p - Pressure (0..1).
   * @returns {boolean} True if caller should skip pushing this sample.
   */
  shouldCullSample(x, y, p) {
    // Count every raw sample arrival so the dev panel's in/out telemetry
    // reflects sub-pixel culling (and downstream DP reduction).
    this._recordBufferedPoints(1);

    const cull = this.subPixelCulling;
    if (!cull.enabled) {
      this._lastBufferedSample = { x, y, p };
      return false;
    }
    const last = this._lastBufferedSample;
    if (last !== null) {
      const dx = x - last.x;
      const dy = y - last.y;
      const dp = p - last.p;
      const dpAbs = dp < 0 ? -dp : dp;
      if (dx * dx + dy * dy < cull.distSq && dpAbs < cull.pressureDelta) {
        return true;
      }
    }
    this._lastBufferedSample = { x, y, p };
    return false;
  }

  /**
   * Drains the ordered broadcast queue, executing each callback.
   */
  drainBroadcastQueue() {
    if (this.broadcastQueue.length === 0) return;
    const queue = this.broadcastQueue;
    this.broadcastQueue = [];
    for (const fn of queue) {
      try {
        fn();
      } catch (e) {
        console.error('[InputBufferManager] broadcast error', e);
      }
    }
  }

  _consumeBufferedPoints() {
    if (!this.inputBuffer.dirty || this.inputBuffer.points.length === 0) return [];
    const points = this.inputBuffer.points;
    // Note: buffered-in count is recorded at the cull/intake stage
    // (shouldCullSample) so culled samples are visible in dev telemetry.
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
    return points;
  }

  _processBufferedPoints(points) {
    const { app } = this;
    const smoothingTools = ['brush', 'flowPen', 'imageBrush', 'ink', 'erase'];
    const blurTools = ['blur', 'circleBlur', 'glitchBlur'];
    const useSmoothing = app.self.mousedown && !app.self.panning && smoothingTools.includes(app.self.tool);
    const useBlur = app.self.mousedown && !app.self.panning && blurTools.includes(app.self.tool);

    let smoothedPoints;
    let localPoints;
    let networkPoints;

    if (useSmoothing) {
      smoothedPoints = this.applyBroadcastSmoothing(points);
      if (REDUCE_BEFORE_RENDER_TOOLS.has(app.self.tool)) {
        localPoints = this.applyPointReduction(smoothedPoints);
        networkPoints = localPoints;
      } else {
        localPoints = smoothedPoints;
        networkPoints = smoothedPoints;
      }
    } else if (useBlur) {
      smoothedPoints = this.applyBroadcastSmoothing(points);
      localPoints = this.applyPointReduction(smoothedPoints);
      networkPoints = localPoints;
    } else {
      smoothedPoints = points;
      localPoints = points;
      networkPoints = points;
    }

    if (LATEST_POINT_ONLY_TOOLS.has(app.self.tool) && localPoints.length > 3) {
      localPoints = localPoints.slice(-3);
      networkPoints = networkPoints.slice(-3);
    }

    const lastRawX = points[points.length - 3];
    const lastRawY = points[points.length - 2];
    app.self.setTarget(lastRawX, lastRawY);

    // The flowPen deadband drops samples rather than displacing them, so a tick
    // can legitimately yield nothing to draw or broadcast. Target tracking above
    // still runs off the raw input; everything below indexes localPoints and
    // must not see an empty list.
    if (localPoints.length < 3) return;

    const lastX = localPoints[localPoints.length - 3];
    const lastY = localPoints[localPoints.length - 2];
    const lastP = localPoints[localPoints.length - 1];
    app.self.setPosition(lastX, lastY);
    app.self.setPressure(lastP);

    if (app.self.mousedown && !app.self.panning) {
      const tool = app.toolManager.getCurrentTool();
      if (tool) {
        const isBatchRenderable = BATCH_RENDER_TOOLS.has(app.self.tool) && tool.onPointerMoveNoRender;

        for (let i = 0; i < localPoints.length; i += 3) {
          const currentX = localPoints[i];
          const currentY = localPoints[i + 1];
          const currentPressure = localPoints[i + 2];

          // Use scratchpads
          this._currentPosScratch.x = currentX;
          this._currentPosScratch.y = currentY;

          if (i === 0) {
            if (this.inputBuffer.lastPosition) {
              this._prevPosScratch.x = this.inputBuffer.lastPosition.x;
              this._prevPosScratch.y = this.inputBuffer.lastPosition.y;
            } else {
              this._prevPosScratch.x = currentX;
              this._prevPosScratch.y = currentY;
            }
          } else {
            this._prevPosScratch.x = localPoints[i - 3];
            this._prevPosScratch.y = localPoints[i - 2];
          }

          app.self.setPressure(currentPressure);

          if (isBatchRenderable) {
            tool.onPointerMoveNoRender(app.self, this._currentPosScratch, this._prevPosScratch);
          } else {
            tool.onPointerMove(app.self, this._currentPosScratch, this._prevPosScratch);
          }

          app.self._mainCtxDrawCount++;
        }

        if (isBatchRenderable) {
          this._renderBatchTool(tool, app.self, app.self.tool);
        }

        app.boardViewer?.requestLiveRender?.();
      }
    }

    const usesStampBroadcast = this._isStampTool(app.self.tool) && app.self.mousedown && !app.self.panning;
    if (!usesStampBroadcast && networkPoints.length > 0) {
      this.pendingBroadcastPoints.push(...networkPoints);
      if (localPoints === networkPoints && (REDUCE_BEFORE_RENDER_TOOLS.has(app.self.tool) || useBlur)) {
        this.pendingBroadcastPointsAreReduced = true;
      } else {
        this.pendingBroadcastPointsAreReduced = false;
      }
    }

    this.inputBuffer.lastPosition = { x: lastX, y: lastY };
  }

  _hasUniformRadii(radii) {
    if (!Array.isArray(radii) || radii.length <= 1) return true;
    const first = radii[0];
    for (let i = 1; i < radii.length; i++) {
      if (radii[i] !== first) return false;
    }
    return true;
  }

  _isStampTool(toolName) {
    return ['flowPen', 'ink', 'pixel', 'circleBlur', 'imageBrush', 'confetti'].includes(toolName);
  }

  _shouldPreserveStampPayload(toolName) {
    // Tools whose stamp payload must go out point-for-point. flowPen is here
    // because its stroke shape is defined by the stamp list itself; it is also
    // absent from REDUCE_BEFORE_RENDER_TOOLS, so no reduction runs on it
    // anywhere and the wire payload equals the locally rendered point list.
    return ['ink', 'circleBlur', 'imageBrush', 'pixel', 'flowPen', 'confetti'].includes(toolName);
  }

  _reduceStampPayload(ps, rs) {
    if (!Array.isArray(ps) || ps.length < 6) {
      return { ps: ps || [], rs: Array.isArray(rs) ? rs : [] };
    }

    const pointCount = Math.floor(ps.length / 2);
    const indexedTriples = [];
    for (let i = 0; i < pointCount; i++) {
      const pointOffset = i * 2;
      indexedTriples.push(ps[pointOffset], ps[pointOffset + 1], i);
    }

    const reducedTriples = this.applyPointReduction(indexedTriples);
    if (!Array.isArray(reducedTriples) || reducedTriples.length < 6) {
      return { ps, rs: Array.isArray(rs) ? rs : [] };
    }

    const reducedPs = [];
    const reducedRs = [];
    const hasRadii = Array.isArray(rs) && rs.length >= pointCount;
    let lastIndex = -1;

    for (let i = 0; i < reducedTriples.length; i += 3) {
      const pointIndex = Math.max(0, Math.min(pointCount - 1, Math.round(reducedTriples[i + 2])));
      if (pointIndex === lastIndex) continue;
      lastIndex = pointIndex;

      const pointOffset = pointIndex * 2;
      reducedPs.push(ps[pointOffset], ps[pointOffset + 1]);
      if (hasRadii) {
        reducedRs.push(rs[pointIndex]);
      }
    }

    if (reducedPs.length < 2) {
      return { ps, rs: Array.isArray(rs) ? rs : [] };
    }

    return { ps: reducedPs, rs: hasRadii ? reducedRs : [] };
  }

  _rollPointTelemetry(now = performance.now()) {
    const elapsed = now - this.pointTelemetry.windowStartMs;
    if (elapsed < 1000) return;

    const bufferedRate = (this.pointTelemetry.bufferedInWindow * 1000) / elapsed;
    const outgoingRate = (this.pointTelemetry.outgoingInWindow * 1000) / elapsed;
    const reduction = this.pointTelemetry.bufferedInWindow > 0
      ? (1 - this.pointTelemetry.outgoingInWindow / this.pointTelemetry.bufferedInWindow) * 100
      : 0;

    this.pointTelemetry.bufferedPerSec = Math.max(0, bufferedRate);
    this.pointTelemetry.outgoingPerSec = Math.max(0, outgoingRate);
    this.pointTelemetry.reductionPercent = Math.min(100, Math.max(-100, reduction));
    this.pointTelemetry.windowStartMs = now;
    this.pointTelemetry.bufferedInWindow = 0;
    this.pointTelemetry.outgoingInWindow = 0;
    this.pointTelemetry.lastUpdatedMs = now;
  }

  _recordBufferedPoints(count) {
    if (!Number.isFinite(count) || count <= 0) return;
    const now = performance.now();
    this._rollPointTelemetry(now);
    this.pointTelemetry.bufferedInWindow += count;
    this.pointTelemetry.lastUpdatedMs = now;
  }

  _recordOutgoingPoints(count) {
    if (!Number.isFinite(count) || count <= 0) return;
    const now = performance.now();
    this._rollPointTelemetry(now);
    this.pointTelemetry.outgoingInWindow += count;
    this.pointTelemetry.lastUpdatedMs = now;
  }

  getPointTelemetry() {
    this._rollPointTelemetry(performance.now());
    return {
      bufferedPerSec: this.pointTelemetry.bufferedPerSec,
      outgoingPerSec: this.pointTelemetry.outgoingPerSec,
      reductionPercent: this.pointTelemetry.reductionPercent,
      bufferedInWindow: this.pointTelemetry.bufferedInWindow,
      outgoingInWindow: this.pointTelemetry.outgoingInWindow,
      lastUpdatedMs: this.pointTelemetry.lastUpdatedMs
    };
  }

  /**
   * Determines if the smoothing buffer needs to catch up to the target position.
   * This is true if the user has stopped moving but the smoothed point hasn't
   * yet converged on the final input position.
   *
   * @returns {boolean} True if catch-up is needed.
   */
  needsSmoothingCatchup() {
    const { app } = this;
    if (!app.self.mousedown || app.self.panning) return false;
    const smoothingTools = ['brush', 'flowPen', 'imageBrush', 'ink', 'erase'];
    if (!smoothingTools.includes(app.self.tool)) return false;
    // The deadband never lags behind the pointer, so there is nothing to
    // converge on: any residual is inside the deadband and is jitter we chose
    // to discard. Converging on it would re-add the samples just filtered out.
    if (FLOWPEN_DEADBAND.enabled && app.self.tool === 'flowPen') return false;
    if (app.self.tool !== 'ink' && (!app.self.smoothing || app.self.smoothing === 0)) return false;
    if (this.broadcastSmoothBuffer.isFirst) return false;
    const dx = app.self.targetX - this.broadcastSmoothBuffer.x;
    const dy = app.self.targetY - this.broadcastSmoothBuffer.y;
    return Math.sqrt(dx * dx + dy * dy) > 0.5;
  }

  /**
   * Performs a single convergence step for smoothing catch-up.
   * @returns {void}
   */
  processSmoothingCatchup() {
    const { app } = this;
    const tool = app.toolManager.getCurrentTool();
    if (!tool) return;

    const targetPos = { x: app.self.targetX, y: app.self.targetY };
    const targetP = app.self.pressure;
    let prevPos = { x: this.broadcastSmoothBuffer.x, y: this.broadcastSmoothBuffer.y };

    const points = [targetPos.x, targetPos.y, targetP];
    const smoothedPoints = this.applyBroadcastSmoothing(points);
    if (smoothedPoints.length < 3) return;
    const smoothedPos = { x: smoothedPoints[0], y: smoothedPoints[1] };
    const smoothedP = smoothedPoints[2];

    app.self.setPosition(smoothedPos.x, smoothedPos.y);
    app.self.setPressure(smoothedP);
    
    const isBatchRenderable = BATCH_RENDER_TOOLS.has(app.self.tool) && tool.onPointerMoveNoRender;
    if (isBatchRenderable) {
      tool.onPointerMoveNoRender(app.self, smoothedPos, prevPos);
      this._renderBatchTool(tool, app.self, app.self.tool);
    } else {
      tool.onPointerMove(app.self, smoothedPos, prevPos);
    }
    app.boardViewer?.requestLiveRender?.();
    app.self._mainCtxDrawCount++;
    if (!this._isStampTool(app.self.tool)) {
      this.pendingBroadcastPoints.push(...smoothedPoints);
    }
  }

  /**
   * Reduces the number of points in a stroke using Douglas-Peucker.
   *
   * @param {Array<number>} points - Flattened point array (x, y, p triples).
   * @returns {Array<number>} Optimized point array.
   */
  applyPointReduction(points) {
    if (!this.pointReduction.enabled || points.length < 6) return points;
    const userSmoothing = this.app.self.smoothing !== undefined ? this.app.self.smoothing : 15;
    const baseline = this.baselineSmoothing.pointReduction;
    const epsilon = baseline.minEpsilon + (baseline.maxEpsilon - baseline.minEpsilon) * (userSmoothing / 50);

    // Prefer WASM if available (already optimized for flat arrays)
    if (typeof douglasPeuckerWasm === 'function') {
      try {
        // Rust expects a Float32Array
        const floatPoints = points instanceof Float32Array ? points : new Float32Array(points);
        return douglasPeuckerWasm(floatPoints, epsilon);
      } catch (e) {
        console.error('WASM Douglas-Peucker failed, falling back to JS:', e);
      }
    }

    // Fallback to JS (now also optimized for flat arrays)
    return douglasPeucker(points, epsilon);
  }

  _renderBatchTool(tool, user, toolName) {
    const { app } = this;
    if (!tool || !user) return;

    const usesTopPreview = toolName === 'brush' || toolName === 'erase' || toolName === 'flowPen' || toolName === 'pixel' || toolName === 'glitchBlur' || toolName === 'ink';

    // Query the preview region BEFORE rendering: every tool derives it from
    // state that onPointerMoveNoRender populates, never from renderStroke's
    // output, so `false` ("no new geometry") lets us skip the stroke re-render
    // too — not just the blit. Smoothing catch-up ticks the EMA on every frame
    // and most of those steps are sub-pixel, which previously re-rendered the
    // entire stroke to produce an identical image. The commit path calls
    // renderStroke(true) itself at pointer-up, so skipping intermediate
    // renders cannot affect what actually lands on the layer.
    const previewRect = tool.getPreviewDirtyRect?.(user) ?? null;
    const hasNoPreviewWork = previewRect === false;

    if (tool.renderStroke && !hasNoPreviewWork) {
      tool.renderStroke(false, user);
    }

    if (app.board && usesTopPreview && !hasNoPreviewWork) {
      app.board.clearTop(previewRect);
    }

    if (usesTopPreview && !hasNoPreviewWork && tool.drawPreview) {
      tool.drawPreview(user, previewRect);
      app.board?.maskPreviewForExistingMode?.(app.board.topCtx, user, previewRect);
    }

    if (toolName === 'blur' || toolName === 'circleBlur' || toolName === 'glitchBlur' || toolName === 'imageBrush' || toolName === 'confetti') {
      app.board?.requestUpdate();
    }
  }

  /**
   * Applies Exponential Moving Average (EMA) smoothing to a batch of points.
   *
   * @param {Array<number>} points - Raw input coordinates (x, y, p triples).
   * @returns {Array<number>} Smoothed coordinates.
   */
  applyBroadcastSmoothing(points) {
    if (points.length < 3) return points;
    const userSmoothing = this.app.self.smoothing || 0;
    const result = [];

    // flowPen filters with a deadband instead of the EMA: it has no lag, so it
    // rejects jitter without rounding off the fine detail the fluid brush is
    // for. Suppressed samples are dropped outright, so this can return fewer
    // triples than it was given — including none at all.
    if (FLOWPEN_DEADBAND.enabled && this.app.self.tool === 'flowPen') {
      const radius = flowPenDeadbandRadius(userSmoothing);
      for (let i = 0; i < points.length; i += 3) {
        const filtered = applyDeadband(
          this.broadcastSmoothBuffer,
          points[i],
          points[i + 1],
          points[i + 2],
          radius,
          this.broadcastSmoothBuffer.resultOut
        );
        if (filtered.emit) result.push(filtered.x, filtered.y, filtered.p);
      }
      return result;
    }

    for (let i = 0; i < points.length; i += 3) {
      const smoothed = applySmoothingEMA(
        this.broadcastSmoothBuffer, 
        points[i], 
        points[i+1], 
        points[i+2], 
        userSmoothing,
        0.12,
        this.broadcastSmoothBuffer.resultOut
      );
      result.push(smoothed.x, smoothed.y, smoothed.p);
    }
    return result;
  }

  /**
   * Resets the smoothing buffers and clears the input buffer.
   * @returns {void}
   */
  resetBroadcastSmoothing() {
    resetSmoothingBuffer(this.broadcastSmoothBuffer);
    this.inputBuffer.lastPosition = null;
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
    this.pendingBroadcastPoints = [];
    this.pendingBroadcastPointsAreReduced = false;
    this._lastBufferedSample = null;
  }

  /**
   * Get current TPS for debug/monitoring.
   * @returns {number}
   */
  getCurrentTPS() {
    return this.tickRate;
  }

  /**
   * Get performance detection info for debug display.
   * @returns {Object}
   */
  getPerformanceInfo() {
    this._rollPointTelemetry(performance.now());
    return {
      tickRate: this.tickRate,
      lowPowerMode: this.lowPowerMode,
      pointTelemetry: this.getPointTelemetry(),
      detection: window.__performanceDetection || {}
    };
  }
}
