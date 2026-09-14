/** @fileoverview Handles the rendering of ink tool strokes for remote users using perfect-freehand. */

import { getStroke } from 'perfect-freehand';
import { setUserLayerContent } from './userLayerPresence.js';
import { touchRemoteScratch } from './remoteScratchReclaim.js';
import { blurExtent } from '../utils/drawing.js';
import { DEFAULT_PRESSURE_TARGETS, PRESSURE_TARGET_SIZE } from '../../shared/pressureTargets.js';
import {
  PressureMask,
  compositePressureStroke,
  hardnessBlurAmount,
  inkOutlinePoints,
  inkPressureMaskRadius,
  usesPressureMask
} from '../utils/pressureMask.js';

/**
 * How often an in-progress remote ink preview is redrawn, in ms.
 *
 * 33 ms / 30 FPS, deliberately the same cadence RemoteUserHandler's catchup
 * loop already settled on (`catchupInterval`, itself lowered from 16 ms).
 */
const INK_PREVIEW_INTERVAL_MS = 33;

/**
 * Converts perfect-freehand outline points to an SVG path string for Path2D.
 * @param {Array<number[]>} stroke - Array of points representing the stroke outline.
 * @returns {string} - The SVG path data string.
 */
function getSvgPathFromStroke(stroke) {
  if (!stroke.length) return '';

  const d = stroke.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ['M', ...stroke[0], 'Q']
  );

  d.push('Z');
  return d.join(' ');
}

/**
 * Handles ink tool rendering for remote users.
 * Uses an offscreen canvas and the perfect-freehand library for smooth, tapered strokes.
 */
export class RemoteInkHandler {
  /**
   * @param {Board} board - The main board instance.
   */
  constructor(board) {
    this.board = board;
  }

  /**
   * Ensures the user has an offscreen canvas covering `rect` (board-space).
   *
   * Windowed to the stroke's own growing bounds instead of the full board —
   * see [[lag_measured_1440p_realistic_load]]. `user._inkOrigin` is the board
   * position of the canvas's local (0,0). Grow-only within a stroke: every
   * render redraws the WHOLE stroke from `user._inkPoints` (see
   * renderInkStroke), so a resize never needs to preserve old pixels, and
   * reallocating on every point would thrash the GPU texture the way blur's
   * per-stamp canvas.createElement did (see blur_per_stamp_canvas_alloc) — so
   * this only reallocates when `rect` no longer fits what's already there.
   * Reset to null at the start of every new stroke (handleInkDown) so a
   * finished stroke's window doesn't linger and outgrow what the next one
   * needs.
   *
   * @param {User} user - The remote user object.
   * @param {{x:number,y:number,width:number,height:number}|null} rect
   */
  ensureInkOffscreen(user, rect) {
    // Restart the idle-reclaim clock on every use, so a user who keeps drawing
    // never has this canvas taken away and one who stops gets it reclaimed.
    touchRemoteScratch(user);

    const need = rect || { x: 0, y: 0, width: 1, height: 1 };
    const ox = Math.floor(need.x);
    const oy = Math.floor(need.y);
    const ow = Math.max(1, Math.ceil(need.width));
    const oh = Math.max(1, Math.ceil(need.height));

    const origin = user._inkOrigin || (user._inkOrigin = { x: 0, y: 0 });
    const canvas = user._inkOffscreen;
    const fits = canvas &&
      ox >= origin.x && oy >= origin.y &&
      (ox + ow) <= (origin.x + canvas.width) &&
      (oy + oh) <= (origin.y + canvas.height);
    if (fits) return;

    origin.x = ox;
    origin.y = oy;
    user._inkOffscreen = document.createElement('canvas');
    user._inkOffscreen.width = ow;
    user._inkOffscreen.height = oh;
    user._inkCtx = user._inkOffscreen.getContext('2d');
  }

  /**
   * Initializes a new ink stroke for a remote user.
   * @param {User} user - The remote user object.
   * @param {Object} pos - The starting coordinates {x, y}.
   */
  handleInkDown(user, pos) {
    // Release the previous stroke's window rather than growing it forever —
    // ensureInkOffscreen reallocates fresh, small, on the next real render.
    user._inkOffscreen = null;
    user._inkCtx = null;
    user._inkOrigin = null;

    // With a full-board offscreen, updateInkPreview's blank-canvas draw used
    // to double as "erase the previous stroke's preview". Windowed, the next
    // updateInkPreview only clears the NEW stroke's (much smaller) region, so
    // do the previous stroke's preview erase explicitly here instead.
    if (user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    const color = user.color.slice(0, 3);
    user._inkStrokeColor = `rgb(${color.join(',')})`;

    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    user._inkAlpha = opacitySlider;
    user._inkHardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;

    user._inkSize = user.size;
    // handleMouseDown has already applied this stroke's MD, so these are the
    // targets it was drawn with.
    user._inkTargets = user.pressureTargets ?? DEFAULT_PRESSURE_TARGETS;
    user._inkPressureMask = usesPressureMask(user._inkTargets) ? new PressureMask() : null;
    user._inkPressureScratch = null;

    // Don't add the initial point here — match local InkTool behavior where
    // inputPoints starts empty and waits for first move with real pressure data.
    // Points are added by handleInkPoints which processes all incoming points.
    user._inkPoints = [];
    user._inkStrokeActive = true;
    user._inkDirtyBounds = { minX: pos.x, minY: pos.y, maxX: pos.x, maxY: pos.y };

    this.renderInkStroke(user, false);
    this.updateInkPreview(user);
    // Stamp the throttle clock. This render bypasses _requestPreviewRender by
    // design — the first mark of a stroke should appear immediately — but
    // leaving the clock unset made the next batch render again at once,
    // doubling the cost at every stroke start.
    user._inkPreviewRenderAt = performance.now();
  }

  /**
   * Processes incoming points and pressures for an active ink stroke.
   * @param {User} user - The remote user object.
   * @param {number[]} points - Flat array of [x, y, x, y, ...] coordinates.
   * @param {number[]} pressures - Array of pressure values (0-255).
   */
  handleInkPoints(user, points, pressures) {
    if (points.length < 2) return;

    if (!user._inkStrokeActive) {
      user.clearLine();
      this.handleInkDown(user, { x: points[0], y: points[1] });
    }

    for (let i = 0, pi = 0; i < points.length; i += 2, pi++) {
      const raw = pressures[pi] !== undefined ? pressures[pi] : user.pressure * 255;
      const pressure = raw / 255;
      // Skip pressure=0 points — they indicate a liftoff sample and produce
      // artefacts (sharp blobs) when fed into the perfect-freehand pipeline.
      if (pressure === 0) continue;
      user._inkPoints.push([points[i], points[i + 1], pressure]);
      if (user._inkPressureMask) {
        // Mirrors InkTool._stampPressure point for point.
        const thinning = user.thinning !== undefined ? user.thinning : 0.5;
        const radius = inkPressureMaskRadius(user._inkTargets, user._inkSize || user.size, thinning, user._inkHardness ?? 1);
        user._inkPressureMask.stampTo(points[i], points[i + 1], radius, pressure);
      }
      this.expandInkDirtyBounds(user, points[i], points[i + 1]);
    }

    const lastIdx = points.length - 2;
    user.setPosition(points[lastIdx], points[lastIdx + 1]);
    this._requestPreviewRender(user);
  }

  /**
   * Render this user's in-progress ink preview, at most every
   * INK_PREVIEW_INTERVAL_MS.
   *
   * Previously every arriving batch rendered immediately, so N remote users
   * cost N x (sender tick rate) full preview passes per second — 6 users at
   * 60 TPS is ~360 passes/s, each issuing a pile of draw calls. A trace at
   * 1440p with 7 users put the GPU process main thread at 86 % busy, almost
   * all of it GpuChannel::ExecuteDeferredRequest and CommandBufferStub::
   * OnAsyncFlush: the bottleneck there is command submission volume, not
   * memory and not renderer JS. This is the term that produces it.
   *
   * Safe because only the RENDER is deferred. Points are still accumulated
   * from every batch above, and handleInkUp calls renderInkStroke(user, true)
   * synchronously before committing, so the committed pixels — and therefore
   * parity and every oracle built on it — are byte-for-byte unchanged. What
   * changes is only how often an in-progress remote preview is redrawn, which
   * is the one thing in this pipeline that does not need to be exact.
   *
   * The catchup loop already runs at this cadence and would have been the
   * natural place to flush from, but it stops itself once no user is
   * converging — a pending render would then sit undrawn until the next batch.
   * Hence a self-managed trailing timer, which cannot be starved.
   *
   * @param {User} user - The remote user object.
   * @returns {void}
   * @private
   */
  _requestPreviewRender(user) {
    const now = performance.now();
    const elapsed = now - (user._inkPreviewRenderAt || 0);

    if (elapsed >= INK_PREVIEW_INTERVAL_MS) {
      user._inkPreviewRenderAt = now;
      this._renderPreviewNow(user);
      return;
    }
    // Trailing edge. Without this, the last batch of a stroke that ends inside
    // the interval would never be previewed — the stroke would appear to stop
    // short until the commit at mouse-up redrew it.
    if (user._inkPreviewTimer) return;
    user._inkPreviewTimer = setTimeout(() => {
      user._inkPreviewTimer = null;
      user._inkPreviewRenderAt = performance.now();
      // The stroke may have ended (and been committed) while this was pending.
      if (!user._inkStrokeActive) return;
      this._renderPreviewNow(user);
    }, INK_PREVIEW_INTERVAL_MS - elapsed);
  }

  /** @private */
  _renderPreviewNow(user) {
    this.renderInkStroke(user, false);
    this.updateInkPreview(user);
  }

  /**
   * Cancel any pending deferred preview render for a user.
   *
   * @param {User} user - The remote user object.
   * @returns {void}
   */
  cancelPendingPreview(user) {
    if (!user?._inkPreviewTimer) return;
    clearTimeout(user._inkPreviewTimer);
    user._inkPreviewTimer = null;
  }

  /**
   * Finalizes and commits an ink stroke to the board layers.
   * @param {User} user - The remote user object.
   */
  handleInkUp(user) {
    // NOT `|| !user._inkOffscreen`: that guard was safe when handleInkDown
    // created the offscreen unconditionally, but it's now lazily allocated
    // inside renderInkStroke (called right below), sized to the stroke's own
    // bounds. Under normal (throttled, real-time) arrival that render has
    // always fired at least once before mouse-up — but under a fast/synchronous
    // driver (ReplayEngine feeding a tape with no real elapsed time between
    // messages), _requestPreviewRender's 33ms throttle can defer the FIRST
    // render past the point mouse-up already arrived, leaving _inkOffscreen
    // still null here and silently dropping the whole stroke. Found via
    // replay_parity_suite's ink_step_1: live matched 100%, replay came back
    // with zero strokes on the layer.
    if (!user._inkStrokeActive) return;

    // Drop any deferred preview first: the synchronous render below supersedes
    // it, and letting it fire afterwards would redraw a preview for a stroke
    // that has already been committed and cleared.
    this.cancelPendingPreview(user);
    this.renderInkStroke(user, true);
    const points = user._inkPoints.map(pt => ({ x: pt[0], y: pt[1] }));

    // Track dirty rect from ink points to avoid expensive getImageData on commit
    if (user._inkPoints && user._inkPoints.length > 0) {
      const size = user._inkSize || user.size;
      const hardness = user._inkHardness !== undefined ? user._inkHardness : 1.0;
      const blurAmount = hardnessBlurAmount(hardness, size);
      const sizeDriven = ((user._inkTargets ?? DEFAULT_PRESSURE_TARGETS) & PRESSURE_TARGET_SIZE) !== 0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of user._inkPoints) {
        const r = (sizeDriven ? pt[2] : 1) * size;
        if (pt[0] - r < minX) minX = pt[0] - r;
        if (pt[0] + r > maxX) maxX = pt[0] + r;
        if (pt[1] - r < minY) minY = pt[1] - r;
        if (pt[1] + r > maxY) maxY = pt[1] + r;
      }
      const margin = blurExtent(blurAmount) + size * 0.5 + 2;
      const x = Math.floor(minX - margin);
      const y = Math.floor(minY - margin);
      const w = Math.ceil(maxX - minX + margin * 2);
      const h = Math.ceil(maxY - minY + margin * 2);
      this.board.expandDirtyRect(user, x, y, w, h);
      this.board.forEachMirrorRegion({ rect: { x, y, width: w, height: h } }, (region) => {
        const p1 = this.board.mirrorPointToRegion({ x: minX, y: minY }, region);
        const p2 = this.board.mirrorPointToRegion({ x: maxX, y: maxY }, region);
        const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
        const my = Math.floor(Math.min(p1.y, p2.y) - margin);
        const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
        const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
        this.board.expandDirtyRect(user, mx, my, mw, mh);
      });

      // Track tile ownership for remote user
      this.board.markDirtyPath(user, points, size);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), size);
      });
    }

    const strokeLayer = user._strokeLayer ?? user.activeLayer;
    // Resolve the stroke blend from synced user state (respecting the layer's
    // complex-blend restriction), matching how handleMouseDown/_syncLayeredRemotePreview
    // would have begun this stroke. Passing it means that if the active stroke was
    // lazily created as source-over — e.g. a joiner that missed this stroke's
    // MD/CBM preamble in the join race — getUserStrokeContext corrects its blend
    // instead of baking the stroke flat (overlay → plain black). See
    // LayerManager.getUserStrokeContext (it overwrites a stale non-source-over blend).
    const allowComplex = this.board.layerManager.getLayerAllowComplexBlendModes(strokeLayer);
    const strokeBlend = allowComplex ? (user.blendMode || 'source-over') : 'source-over';
    const layerCtx = this.board.layerManager.getUserStrokeContext(strokeLayer, user.id, strokeBlend, { blendBakeMode: user.blendBakeMode });
    // A stroke with zero recorded points (MD immediately followed by MU, no
    // MM at all) never reaches ensureInkOffscreen — renderInkStroke's own
    // top-of-function guard returns before it gets there. Old code always had
    // an offscreen (created unconditionally at handleInkDown) so this couldn't
    // happen; skip the composite rather than crash on a null source.
    if (layerCtx && user._inkOffscreen) {
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = user._inkAlpha;

      const origin = user._inkOrigin || { x: 0, y: 0 };
      const hardnessCanvas = this._getCompositeCanvas(user);
      layerCtx.drawImage(hardnessCanvas, origin.x, origin.y);

      this.board.forEachMirrorRegion({ points }, (region) => {
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'source-over';
        this.board.drawMirroredCanvas(layerCtx, hardnessCanvas, region, origin.x, origin.y);
        layerCtx.restore();
      });

      layerCtx.globalAlpha = 1.0;
      this.board.requestUpdate();
    }

    user._inkPoints = [];
    user._inkStrokeActive = false;
    user._inkStrokeColor = null;
    user._inkAlpha = null;
    user._inkDirtyBounds = null;
    user._inkPressureMask = null;
    user._inkPressureScratch = null;
  }

  /**
   * Renders the current ink points to the user's offscreen context.
   * @param {User} user - The remote user object.
   * @param {boolean} last - Whether this is the final segment of the stroke.
   */
  renderInkStroke(user, last) {
    if (!user._inkPoints || user._inkPoints.length < 1) return;

    // Windowed to the stroke's own bounds (see ensureInkOffscreen), so every
    // render redraws the WHOLE stroke from user._inkPoints rather than
    // incrementally — there is no old content in a smaller window worth
    // preserving, and it is what makes grow-on-demand safe.
    const rect = this.getPreviewDirtyRect(user);
    this.ensureInkOffscreen(user, rect);
    const ctx = user._inkCtx;
    const origin = user._inkOrigin;
    ctx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);

    const simulatePressure = user.simulatePressure !== undefined ? user.simulatePressure : true;
    const inkSize = user._inkSize || user.size;
    const rawThinning = user.thinning !== undefined ? user.thinning : 0.5;
    const thinning = !simulatePressure ? 0.95 : Math.min(0.99, rawThinning * Math.max(1, inkSize / 10));
    // Pressure shapes the outline only when it drives size.
    const strokeInput = inkOutlinePoints(user._inkPoints, user._inkTargets);

    ctx.save();
    ctx.translate(-origin.x, -origin.y);
    try {
      // Single point: render as a dot
      if (user._inkPoints.length === 1) {
        if (!last) return;

        const [x, y, pressure] = strokeInput[0];
        const dotPressure = pressure !== undefined ? pressure : 1;
        ctx.fillStyle = user._inkStrokeColor;
        ctx.beginPath();
        ctx.arc(x, y, inkSize * dotPressure, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      // Very short strokes can arrive in tiny remote batches. Perfect-freehand
      // can collapse these into an unstable preview, so draw a simple segment
      // instead of clearing to blank between network updates.
      if (user._inkPoints.length === 2) {
        const [x0, y0, pressure0] = strokeInput[0];
        const [x1, y1, pressure1] = strokeInput[1];
        const averagePressure = ((pressure0 ?? 1) + (pressure1 ?? 1)) / 2;
        const width = Math.max(0.5, inkSize * averagePressure);
        ctx.fillStyle = user._inkStrokeColor;
        ctx.strokeStyle = user._inkStrokeColor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        return;
      }

      // Match local ink preview behavior: wait for enough points to form a real
      // stroke shape before drawing the preview, avoiding oversized start blobs.
      if (!last && user._inkPoints.length < 3) return;

      const userSmoothing = user.smoothing !== undefined ? user.smoothing / 50 : 0.5;
      // We use a baseline streamline even at 0 smoothing to stabilize velocity calculation in perfect-freehand
      const streamline = 0.3 + (userSmoothing * 0.7); // Scale 0.3 to 1.0

      const options = {
        size: Math.max(0.1, (inkSize * 2) / (1 + rawThinning)),
        thinning: thinning,
        smoothing: userSmoothing,
        streamline: streamline,
        simulatePressure: simulatePressure,
        last
      };

      // Use pressure values directly without squaring
      const strokePoints = strokeInput;

      const outlinePoints = getStroke(strokePoints, options);

      if (outlinePoints.length < 3) return;

      const pathData = getSvgPathFromStroke(outlinePoints);
      if (!pathData) return;

      const path = new Path2D(pathData);
      ctx.fillStyle = user._inkStrokeColor;
      ctx.fill(path);
    } finally {
      ctx.restore();
    }
  }

  /**
   * Updates the user's preview canvas with the current ink stroke state.
   * @param {User} user - The remote user object.
   */
  updateInkPreview(user) {
    if (!user._inkOffscreen) return;
    setUserLayerContent(user, true);

    const origin = user._inkOrigin || { x: 0, y: 0 };
    // previewRect is board-space (used to clear user.context, which stays
    // full-board); localRect is the same rect in inkOffscreen's own local
    // space, for reading out of the windowed source canvas.
    const previewRect = this.board.hasMirrors?.() ? null : this.getPreviewDirtyRect(user);
    const localRect = previewRect ? { x: previewRect.x - origin.x, y: previewRect.y - origin.y, width: previewRect.width, height: previewRect.height } : null;
    const clearRect = previewRect ? this._clampRectToCanvas(previewRect, user.context.canvas) : null;
    if (clearRect) {
      user.context.clearRect(clearRect.x, clearRect.y, clearRect.width, clearRect.height);
    } else {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    user.context.globalAlpha = user._inkAlpha;

    const hardnessCanvas = this._getCompositeCanvas(user, localRect);
    const sourceRect = localRect ? this._clampRectToCanvas(localRect, hardnessCanvas) : null;
    this.board.withSelectionMaskClip(user.context, user.id, () => {
      if (sourceRect) {
        user.context.drawImage(
          hardnessCanvas,
          sourceRect.x,
          sourceRect.y,
          sourceRect.width,
          sourceRect.height,
          sourceRect.x + origin.x,
          sourceRect.y + origin.y,
          sourceRect.width,
          sourceRect.height
        );
      } else {
        user.context.drawImage(hardnessCanvas, origin.x, origin.y);
      }

      this.board.forEachMirrorRegion({ points: user._inkPoints?.map(pt => ({ x: pt[0], y: pt[1] })) || [] }, (region) => {
        this.board.drawMirroredCanvas(user.context, hardnessCanvas, region, origin.x, origin.y);
      });
    });

    user.context.globalAlpha = 1.0;
    this.board.maskPreviewForExistingMode?.(user.context, user, previewRect);
    this.board.app?.remoteUserHandler?.selectionHandler?.drawStaticMaskOutline?.(user, user.maskSelection, false);
  }

  /**
   * Composites an offscreen canvas to a context with hardness/blur application.
   * @param {CanvasRenderingContext2D} ctx - The destination context.
   * @param {HTMLCanvasElement} sourceCanvas - The source canvas to composite.
   * @param {number} size - The stroke size.
   * @param {number} hardness - The hardness value (0.0 to 1.0).
   * @param {string} strokeColor - The RGB color string.
   * @param {number} x - Destination x-coordinate.
   * @param {number} y - Destination y-coordinate.
   */
  compositeWithHardness(ctx, sourceCanvas, size, hardness, strokeColor, x, y, rect = null) {
    const blurAmount = (1 - hardness) * (20 + size * 0.2);
    const sourceRect = rect ? this._clampRectToCanvas(rect, sourceCanvas) : null;

    if (blurAmount > 0) {
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = strokeColor;
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      if (sourceRect) {
        ctx.drawImage(
          sourceCanvas,
          sourceRect.x,
          sourceRect.y,
          sourceRect.width,
          sourceRect.height,
          x + sourceRect.x + offset,
          y + sourceRect.y,
          sourceRect.width,
          sourceRect.height
        );
      } else {
        ctx.drawImage(sourceCanvas, x + offset, y);
      }
      ctx.restore();
    } else if (sourceRect) {
      ctx.drawImage(
        sourceCanvas,
        sourceRect.x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height,
        x + sourceRect.x,
        y + sourceRect.y,
        sourceRect.width,
        sourceRect.height
      );
    } else {
      ctx.drawImage(sourceCanvas, x, y);
    }
  }

  /**
   * @param {User} user - Owns both the source (`_inkOffscreen`) and the
   *   pre-filtered result (`_inkHardnessCanvas`). Per-user, not shared on
   *   `this`: sharing one instance canvas across users made sense when it was
   *   always full-board (same size for everyone), but windowed sources differ
   *   in size per user/stroke, and a shared canvas would reallocate on every
   *   user switch — see lag_measured_1440p_realistic_load / blur_per_stamp_canvas_alloc
   *   on why per-switch reallocation is exactly the cost this change targets.
   * @param {{x:number,y:number,width:number,height:number}|null} rect - LOCAL
   *   to the (equally windowed) source/hardness canvases, not board space.
   */
  /**
   * The stroke with hardness applied and, when pressure drives opacity or
   * hardness, composited through its pressure mask.
   * @param {User} user - The remote user object.
   * @param {{x:number, y:number, width:number, height:number}|null} [rect=null] - Offscreen-local region to redraw.
   * @returns {HTMLCanvasElement}
   * @private
   */
  _getCompositeCanvas(user, rect = null) {
    const size = user._inkSize || user.size;
    if (!user._inkPressureMask) {
      return this.getHardnessCanvas(user, size, user._inkHardness, user._inkStrokeColor, rect);
    }
    if (!user._inkPressureScratch) user._inkPressureScratch = {};
    return compositePressureStroke(user._inkPressureScratch, user._inkOffscreen, user._inkOrigin || { x: 0, y: 0 }, user._inkPressureMask, {
      targets: user._inkTargets,
      hardness: user._inkHardness ?? 1,
      size,
      color: user._inkStrokeColor,
      rect
    });
  }

  getHardnessCanvas(user, size, hardness, strokeColor, rect = null) {
    const sourceCanvas = user._inkOffscreen;
    if (!user._inkHardnessCanvas ||
        user._inkHardnessCanvas.width !== sourceCanvas.width ||
        user._inkHardnessCanvas.height !== sourceCanvas.height) {
      user._inkHardnessCanvas = document.createElement('canvas');
      user._inkHardnessCanvas.width = sourceCanvas.width;
      user._inkHardnessCanvas.height = sourceCanvas.height;
      user._inkHardnessCtx = user._inkHardnessCanvas.getContext('2d');
    }
    const hctx = user._inkHardnessCtx;

    const clearRect = rect ? this._clampRectToCanvas(rect, user._inkHardnessCanvas) : null;
    if (clearRect) {
      hctx.clearRect(clearRect.x, clearRect.y, clearRect.width, clearRect.height);
    } else {
      hctx.clearRect(0, 0, user._inkHardnessCanvas.width, user._inkHardnessCanvas.height);
    }
    this.compositeWithHardness(hctx, sourceCanvas, size, hardness, strokeColor, 0, 0, rect);
    return user._inkHardnessCanvas;
  }

  expandInkDirtyBounds(user, x, y) {
    if (!user._inkDirtyBounds) {
      user._inkDirtyBounds = { minX: x, minY: y, maxX: x, maxY: y };
      return;
    }
    user._inkDirtyBounds.minX = Math.min(user._inkDirtyBounds.minX, x);
    user._inkDirtyBounds.minY = Math.min(user._inkDirtyBounds.minY, y);
    user._inkDirtyBounds.maxX = Math.max(user._inkDirtyBounds.maxX, x);
    user._inkDirtyBounds.maxY = Math.max(user._inkDirtyBounds.maxY, y);
  }

  getPreviewDirtyRect(user) {
    const bounds = user._inkDirtyBounds;
    // Only bail when there is no stroke at all. A single point (maxX===minX)
    // still needs a rect — margin below is always > 0 — and ensureInkOffscreen
    // needs SOME rect to size the window from on every real call.
    if (!bounds) return null;

    const size = user._inkSize || user.size;
    const hardness = user._inkHardness !== undefined ? user._inkHardness : 1.0;
    const blurAmount = hardnessBlurAmount(hardness, size);
    const margin = size + blurExtent(blurAmount) + size * 0.5 + 15;
    return {
      x: Math.floor(bounds.minX - margin),
      y: Math.floor(bounds.minY - margin),
      width: Math.ceil(bounds.maxX - bounds.minX + margin * 2),
      height: Math.ceil(bounds.maxY - bounds.minY + margin * 2)
    };
  }

  _clampRectToCanvas(rect, canvas) {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const right = Math.min(canvas.width, Math.ceil(rect.x + rect.width));
    const bottom = Math.min(canvas.height, Math.ceil(rect.y + rect.height));
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  }
}
