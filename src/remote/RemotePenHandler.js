/** @fileoverview Handles pen and flowPen tool rendering for remote users using offscreen canvasing. */
import { setUserLayerContent } from './userLayerPresence.js';
import { touchRemoteScratch } from './remoteScratchReclaim.js';
import { blurExtent } from '../utils/drawing.js';
import { DEFAULT_PRESSURE_TARGETS, pressureSizeFactor } from '../../shared/pressureTargets.js';
import {
  PressureMask,
  compositePressureStroke,
  hardnessBlurAmount,
  pressureStampRadius,
  usesPressureMask
} from '../utils/pressureMask.js';

/**
 * How often an in-progress remote pen preview is redrawn, in ms.
 *
 * Matches RemoteInkHandler's INK_PREVIEW_INTERVAL_MS and the catchup loop's
 * cadence — see _requestPreviewRender below for why this exists.
 */
const PEN_PREVIEW_INTERVAL_MS = 33;

/**
 * Handles pen/flowPen tool rendering for remote users.
 * Uses an offscreen canvas to prevent opacity stacking during a single stroke.
 */
export class RemotePenHandler {
  /**
   * @param {Board} board - The main board instance.
   */
  constructor(board) {
    this.board = board;
  }

  /**
   * Ensures the user has an offscreen canvas covering `rect` (board-space),
   * windowed to the stroke's own growing bounds — see
   * RemoteInkHandler.ensureInkOffscreen for the full rationale
   * (lag_measured_1440p_realistic_load).
   *
   * Unlike ink, pen stamps are drawn INCREMENTALLY (each stamp interpolates
   * from `_penLastStampPos`, not replayed from full point history), so a
   * mid-stroke resize cannot just clear-and-redraw: it must carry the already
   * -drawn pixels forward into the new, bigger canvas at the shifted offset.
   *
   * @param {User} user - The remote user object.
   * @param {{x:number,y:number,width:number,height:number}|null} rect
   */
  ensurePenOffscreen(user, rect) {
    // See ensureInkOffscreen — same idle-reclaim clock, shared per user.
    touchRemoteScratch(user);

    const need = rect || { x: 0, y: 0, width: 1, height: 1 };
    const ox = Math.floor(need.x);
    const oy = Math.floor(need.y);
    const ow = Math.max(1, Math.ceil(need.width));
    const oh = Math.max(1, Math.ceil(need.height));

    const origin = user._penOrigin || (user._penOrigin = { x: 0, y: 0 });
    const oldCanvas = user._penOffscreen;
    const fits = oldCanvas &&
      ox >= origin.x && oy >= origin.y &&
      (ox + ow) <= (origin.x + oldCanvas.width) &&
      (oy + oh) <= (origin.y + oldCanvas.height);
    if (fits) return;

    const newCanvas = document.createElement('canvas');
    newCanvas.width = ow;
    newCanvas.height = oh;
    const newCtx = newCanvas.getContext('2d');
    if (oldCanvas) {
      // Carry forward what's already drawn: old canvas's local (0,0) was at
      // board position `origin` (pre-update); place it at the same board
      // position within the new, larger window.
      newCtx.drawImage(oldCanvas, origin.x - ox, origin.y - oy);
    }

    origin.x = ox;
    origin.y = oy;
    user._penOffscreen = newCanvas;
    user._penOffscreenCtx = newCtx;
  }

  /**
   * Initializes a new pen stroke for a remote user.
   * @param {User} user - The remote user object.
   * @param {Object} pos - The starting coordinates {x, y}.
   */
  handlePenDown(user, pos) {
    // Release the previous stroke's window rather than growing it forever —
    // see RemoteInkHandler.handleInkDown for why (reusing a spatially
    // overlapping old window would carry that stroke's stale pixels forward).
    user._penOffscreen = null;
    user._penOffscreenCtx = null;
    user._penOrigin = null;
    user._penDirtyBounds = null;

    // Targets and size for the whole stroke. handleMouseDown has already
    // applied this stroke's MD, so these are the targets it was drawn with.
    user._penTargets = user.pressureTargets ?? DEFAULT_PRESSURE_TARGETS;
    user._penSize = user.size;
    user._penPressureMask = usesPressureMask(user._penTargets) ? new PressureMask() : null;

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressureSizeFactor(user, pressure) * user.size;

    this.expandPenWindowBounds(user, pos.x - radius, pos.y - radius, pos.x + radius, pos.y + radius);
    this.ensurePenOffscreen(user, this.getPenWindowRect(user));
    const origin = user._penOrigin;

    user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);

    const color = user.color.slice(0, 3);
    user._penStrokeColor = `rgb(${color.join(',')})`;
    user._penOffscreenCtx.fillStyle = user._penStrokeColor;

    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    user._penAlpha = opacitySlider;
    user._penHardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;

    const ctx = user._penOffscreenCtx;
    ctx.save();
    ctx.translate(-origin.x, -origin.y);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    this._stampPressure(user, pos.x, pos.y, Math.round(pressure * 255));
    user._penLastStampPos = { x: pos.x, y: pos.y, radius };
    user._penStrokeActive = true;
    // See RemoteInkHandler.handleInkDown — stamp the throttle clock so the
    // immediate render below does not get repeated by the first batch.
    user._penPreviewRenderAt = performance.now();
    user.penPoints = [{ x: pos.x, y: pos.y, radius }];

    this.updatePenPreview(user);
  }

  /**
   * Processes incoming stamp points and radii for an active pen stroke.
   * @param {User} user - The remote user object.
   * @param {number[]} points - Flat array of [x, y, x, y, ...] coordinates.
   * @param {number[]} radii - Array of radius values (0-255).
   */
  handlePenStamps(user, points, radii) {
    if (points.length < 2) return;

    let startIndex = 0;
    let startRi = 0;

    if (!user._penStrokeActive) {
      user.clearLine();
      this.handlePenDown(user, { x: points[0], y: points[1] });
      // handlePenDown drew the first point and set user._penLastStampPos
      startIndex = 2;
      startRi = 1;
    }

    // Pre-scan the batch's bounds with no canvas writes, so the window can be
    // grown ONCE for the whole batch before any drawing. Resizing mid-loop
    // would leave a `ctx` reference captured before the loop pointing at a
    // canvas ensurePenOffscreen has already replaced.
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    let prevRadius = user._penLastStampPos?.radius;
    for (let i = startIndex, ri = startRi; i < points.length; i += 2, ri++) {
      const x = points[i];
      const y = points[i + 1];
      const r = pressureSizeFactor(user, radii[ri] / 255) * user.size;
      const maxR = Math.max(prevRadius ?? r, r);
      bMinX = Math.min(bMinX, x - maxR);
      bMinY = Math.min(bMinY, y - maxR);
      bMaxX = Math.max(bMaxX, x + maxR);
      bMaxY = Math.max(bMaxY, y + maxR);
      prevRadius = r;
    }
    if (bMinX <= bMaxX) {
      this.expandPenWindowBounds(user, bMinX, bMinY, bMaxX, bMaxY);
      this.ensurePenOffscreen(user, this.getPenWindowRect(user));
    }

    const ctx = user._penOffscreenCtx;
    const origin = user._penOrigin;
    ctx.fillStyle = user._penStrokeColor;
    ctx.save();
    ctx.translate(-origin.x, -origin.y);
    try {
      for (let i = startIndex, ri = startRi; i < points.length; i += 2, ri++) {
        const x = points[i];
        const y = points[i + 1];
        const pressure = radii[ri] / 255;
        const r = pressureSizeFactor(user, pressure) * user.size;

        if (user._penLastStampPos) {
          // Interpolate circles for smooth coverage from the last point
          this._interpolateStrokeRemote(
            ctx,
            user._penLastStampPos.x,
            user._penLastStampPos.y,
            user._penLastStampPos.radius,
            x,
            y,
            r
          );
        } else {
          // Fallback for first point if handlePenDown wasn't called (shouldn't happen)
          ctx.beginPath();
          ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
          ctx.fill();
        }

        this._stampPressure(user, x, y, radii[ri]);
        user._penLastStampPos = { x, y, radius: r };
        if (user.penPoints) {
          user.penPoints.push({ x, y, radius: r });
        }
      }
    } finally {
      ctx.restore();
    }

    const lastPtIdx = points.length - 2;
    user.setPosition(points[lastPtIdx], points[lastPtIdx + 1]);

    const batchRect = bMinX < bMaxX ? { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY } : null;
    this._requestPreviewRender(user, batchRect);
  }

  /**
   * Handles individual pen movement events and applies adaptive spacing.
   * @param {User} user - The remote user object.
   * @param {Object} pos - The new coordinates {x, y}.
   */
  handlePenMove(user, pos) {
    if (!user._penLastStampPos || !user._penOffscreenCtx) return;

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressureSizeFactor(user, pressure) * user.size;
    const dx = pos.x - user._penLastStampPos.x;
    const dy = pos.y - user._penLastStampPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 0.5) {
      const maxR = Math.max(user._penLastStampPos.radius, radius);
      const moveRect = {
        minX: Math.min(user._penLastStampPos.x, pos.x) - maxR,
        minY: Math.min(user._penLastStampPos.y, pos.y) - maxR,
        maxX: Math.max(user._penLastStampPos.x, pos.x) + maxR,
        maxY: Math.max(user._penLastStampPos.y, pos.y) + maxR
      };
      this.expandPenWindowBounds(user, moveRect.minX, moveRect.minY, moveRect.maxX, moveRect.maxY);
      this.ensurePenOffscreen(user, this.getPenWindowRect(user));

      const ctx = user._penOffscreenCtx;
      const origin = user._penOrigin;
      ctx.fillStyle = user._penStrokeColor;
      ctx.save();
      ctx.translate(-origin.x, -origin.y);
      // Interpolate circles for smooth coverage
      this._interpolateStrokeRemote(
        ctx,
        user._penLastStampPos.x,
        user._penLastStampPos.y,
        user._penLastStampPos.radius,
        pos.x,
        pos.y,
        radius
      );
      ctx.restore();

      this._stampPressure(user, pos.x, pos.y, Math.round(pressure * 255));
      user._penLastStampPos = { x: pos.x, y: pos.y, radius };
      if (user.penPoints) {
        user.penPoints.push({ x: pos.x, y: pos.y, radius });
      }

      this._requestPreviewRender(user, moveRect);
    }
  }

  /**
   * Interpolates and draws circles between two positions.
   */
  _interpolateStrokeRemote(ctx, x1, y1, r1, x2, y2, r2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const avgRadius = (r1 + r2) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);

    if (distance < spacing) {
      ctx.beginPath();
      ctx.arc(x2, y2, Math.max(0.5, r2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const steps = Math.ceil(distance / spacing);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;
      const r = r1 + (r2 - r1) * t;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Finalizes and commits a pen stroke to the board layers.
   * @param {User} user - The remote user object.
   */
  handlePenUp(user) {
    if (!user._penLastStampPos || !user._penOffscreen) return;

    // Drop any deferred preview: the commit below supersedes it, and letting it
    // fire afterwards would repaint a preview for a stroke already committed
    // and cleared.
    this.cancelPendingPreview(user);

    // Track dirty rect from pen stamp points to avoid expensive getImageData on commit
    if (user.penPoints && user.penPoints.length > 0) {
      const hardness = user._penHardness !== undefined ? user._penHardness : 1.0;
      const blurAmount = hardnessBlurAmount(hardness, user.size);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of user.penPoints) {
        const r = pt.radius || user.size;
        if (pt.x - r < minX) minX = pt.x - r;
        if (pt.x + r > maxX) maxX = pt.x + r;
        if (pt.y - r < minY) minY = pt.y - r;
        if (pt.y + r > maxY) maxY = pt.y + r;
      }
      const margin = blurExtent(blurAmount) + 2;
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
      const points = user.penPoints.map(pt => ({ x: pt.x, y: pt.y }));
      const maxRadius = Math.max(...user.penPoints.map(p => p.radius || user.size));
      this.board.markDirtyPath(user, points, maxRadius);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), maxRadius);
      });
    }

    const strokeLayer = user._strokeLayer ?? user.activeLayer;
    // Resolve the stroke blend from synced user state (respecting the layer's
    // complex-blend restriction) so a lazily-created active stroke — e.g. a joiner
    // that missed this stroke's MD/CBM preamble in the join race — gets the correct
    // blend instead of being baked flat as source-over (overlay → plain black).
    // Mirrors the RemoteInkHandler fix. See LayerManager.getUserStrokeContext.
    const allowComplex = this.board.layerManager.getLayerAllowComplexBlendModes(strokeLayer);
    const strokeBlend = allowComplex ? (user.blendMode || 'source-over') : 'source-over';
    const layerCtx = this.board.layerManager.getUserStrokeContext(strokeLayer, user.id, strokeBlend, { blendBakeMode: user.blendBakeMode });
    if (layerCtx) {
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = user._penAlpha;

      const origin = user._penOrigin || { x: 0, y: 0 };
      const pressured = this._compositePressure(user);
      if (pressured) {
        layerCtx.drawImage(pressured, origin.x, origin.y);
      } else {
        this.compositeWithHardness(layerCtx, user._penOffscreen, user.size, user._penHardness, user._penStrokeColor, origin.x, origin.y);
      }

      this.board.forEachMirrorRegion({ points: user.penPoints }, (region) => {
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'source-over';
        this.board.drawMirroredCanvas(layerCtx, pressured || user._penOffscreen, region, origin.x, origin.y);
        layerCtx.restore();
      });

      layerCtx.globalAlpha = 1.0;
      this.board.requestUpdate();
    }

    user._penLastStampPos = null;
    user._penStrokeActive = false;
    user._penStrokeColor = null;
    user._penAlpha = null;
    user._penPressureMask = null;
    user._penPressureScratch = null;
    user.penPoints = [];
  }

  /**
   * Render this user's in-progress pen preview, at most every
   * PEN_PREVIEW_INTERVAL_MS.
   *
   * Same argument as RemoteInkHandler._requestPreviewRender: previews were
   * rendered once per arriving batch, unthrottled, so N remote users cost
   * N x sender-tick-rate preview passes per second, and a trace at 1440p with
   * 7 users put the GPU process main thread at 86 % busy on command
   * submission. Coalescing ink alone cut stalls 34 % and raised fps 13 %.
   *
   * The one thing pen needs that ink does not is a UNION of the deferred dirty
   * rects. updatePenPreview clears and recomposites only the region it is
   * given, so rendering just the newest batch's rect would leave every skipped
   * batch's region showing stale pixels — the stroke would appear to advance in
   * disconnected chunks. A null rect means "full redraw" and must dominate the
   * union rather than be treated as an empty contribution.
   *
   * Only the RENDER defers. Stamps still go into `_penOffscreen` synchronously
   * in the batch loop above (they are incremental and chain through
   * `_penLastStampPos`, so they could not be deferred), and handlePenUp
   * commits from that offscreen — so committed pixels and parity are unchanged.
   *
   * @param {User} user - The remote user object.
   * @param {{minX: number, minY: number, maxX: number, maxY: number}|null} rect
   * @returns {void}
   * @private
   */
  _requestPreviewRender(user, rect) {
    if (!rect) {
      user._penPendingRect = null;
      user._penPendingFull = true;
    } else if (!user._penPendingFull) {
      const prev = user._penPendingRect;
      user._penPendingRect = prev
        ? {
            minX: Math.min(prev.minX, rect.minX),
            minY: Math.min(prev.minY, rect.minY),
            maxX: Math.max(prev.maxX, rect.maxX),
            maxY: Math.max(prev.maxY, rect.maxY)
          }
        : { ...rect };
    }

    const now = performance.now();
    const elapsed = now - (user._penPreviewRenderAt || 0);
    if (elapsed >= PEN_PREVIEW_INTERVAL_MS) {
      user._penPreviewRenderAt = now;
      this._flushPreview(user);
      return;
    }
    // Trailing edge, so the last batch of a stroke is never left unrendered.
    if (user._penPreviewTimer) return;
    user._penPreviewTimer = setTimeout(() => {
      user._penPreviewTimer = null;
      user._penPreviewRenderAt = performance.now();
      if (!user._penStrokeActive) return;
      this._flushPreview(user);
    }, PEN_PREVIEW_INTERVAL_MS - elapsed);
  }

  /** @private */
  _flushPreview(user) {
    const rect = user._penPendingFull ? null : user._penPendingRect;
    user._penPendingRect = null;
    user._penPendingFull = false;
    this.updatePenPreview(user, rect);
  }

  /**
   * Cancel any pending deferred preview render for a user.
   *
   * @param {User} user - The remote user object.
   * @returns {void}
   */
  cancelPendingPreview(user) {
    if (!user) return;
    if (user._penPreviewTimer) {
      clearTimeout(user._penPreviewTimer);
      user._penPreviewTimer = null;
    }
    user._penPendingRect = null;
    user._penPendingFull = false;
  }

  /**
   * Updates the user's preview canvas with the current pen stroke state.
   * @param {User} user - The remote user object.
   */
  updatePenPreview(user, dirtyBounds = null) {
    if (!user._penOffscreen) return;
    setUserLayerContent(user, true);

    const ctx = user.context;
    const hardness = user._penHardness ?? 1;
    const size = user.size ?? 0;
    const blurAmount = hardnessBlurAmount(hardness, size);
    const margin = Math.ceil(Math.max(size, 1) + blurExtent(blurAmount) + size * 0.5 + 10);

    let clipRect = null;
    if (dirtyBounds) {
      clipRect = {
        x: Math.max(0, Math.floor(dirtyBounds.minX) - margin),
        y: Math.max(0, Math.floor(dirtyBounds.minY) - margin),
        width: Math.ceil(dirtyBounds.maxX - dirtyBounds.minX) + margin * 2,
        height: Math.ceil(dirtyBounds.maxY - dirtyBounds.minY) + margin * 2
      };
      ctx.clearRect(clipRect.x, clipRect.y, clipRect.width, clipRect.height);
    } else {
      ctx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    ctx.globalAlpha = user._penAlpha;

    if (clipRect) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipRect.x, clipRect.y, clipRect.width, clipRect.height);
      ctx.clip();
    }

    const origin = user._penOrigin || { x: 0, y: 0 };
    const pressured = this._compositePressure(user, clipRect && {
      x: clipRect.x - origin.x,
      y: clipRect.y - origin.y,
      width: clipRect.width,
      height: clipRect.height
    });
    this.board.withSelectionMaskClip(ctx, user.id, () => {
      if (pressured) {
        ctx.drawImage(pressured, origin.x, origin.y);
      } else {
        this.compositeWithHardness(ctx, user._penOffscreen, user.size, user._penHardness, user._penStrokeColor, origin.x, origin.y);
      }

      this.board.forEachMirrorRegion({ points: user.penPoints }, (region) => {
        this.board.drawMirroredCanvas(ctx, pressured || user._penOffscreen, region, origin.x, origin.y);
      });
    });

    if (clipRect) ctx.restore();
    ctx.globalAlpha = 1.0;
    this.board.maskPreviewForExistingMode?.(ctx, user, clipRect);
    this.board.app?.remoteUserHandler?.selectionHandler?.drawStaticMaskOutline?.(user, user.maskSelection, false);
  }

  /**
   * Records a received stamp's pressure in the stroke's mask, mirroring
   * FlowPenTool._stampPressure point for point.
   * @param {User} user - The remote user object.
   * @param {number} x
   * @param {number} y
   * @param {number} pressure255 - The pressure (0-255), as received.
   * @private
   */
  _stampPressure(user, x, y, pressure255) {
    const mask = user._penPressureMask;
    if (!mask) return;
    const pressure = pressure255 / 255;
    mask.stampTo(x, y, pressureStampRadius(user._penTargets, pressure, user._penSize, user._penHardness ?? 1), pressure);
  }

  /**
   * The stroke composited through its pressure mask, or null when pressure only
   * drives size and compositeWithHardness does the job.
   * @param {User} user - The remote user object.
   * @param {{x:number, y:number, width:number, height:number}|null} [rect=null] - Offscreen-local region to redraw.
   * @returns {HTMLCanvasElement|null}
   * @private
   */
  _compositePressure(user, rect = null) {
    if (!user._penPressureMask || !user._penOffscreen) return null;
    if (!user._penPressureScratch) user._penPressureScratch = {};
    return compositePressureStroke(user._penPressureScratch, user._penOffscreen, user._penOrigin || { x: 0, y: 0 }, user._penPressureMask, {
      targets: user._penTargets,
      hardness: user._penHardness ?? 1,
      size: user.size,
      color: user._penStrokeColor,
      rect
    });
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
  compositeWithHardness(ctx, sourceCanvas, size, hardness, strokeColor, x, y) {
    const blurAmount = (1 - hardness) * (20 + size * 0.2);

    if (blurAmount > 0) {
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = strokeColor;
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      ctx.drawImage(sourceCanvas, x + offset, y);
      ctx.restore();
    } else {
      ctx.drawImage(sourceCanvas, x, y);
    }
  }

  /**
   * Cumulative bounding box (blob-inclusive: already padded by each stamp's
   * own radius) of everything drawn into the current stroke's offscreen so
   * far. Drives the windowed canvas's size — separate from the batch-local
   * dirty rect used to clip `updatePenPreview`'s redraw.
   */
  expandPenWindowBounds(user, minX, minY, maxX, maxY) {
    const b = user._penDirtyBounds;
    if (!b) {
      user._penDirtyBounds = { minX, minY, maxX, maxY };
      return;
    }
    b.minX = Math.min(b.minX, minX);
    b.minY = Math.min(b.minY, minY);
    b.maxX = Math.max(b.maxX, maxX);
    b.maxY = Math.max(b.maxY, maxY);
  }

  getPenWindowRect(user) {
    const b = user._penDirtyBounds;
    if (!b) return null;
    // Stamp radius is already folded into b (unlike ink's raw point bounds).
    // Margin still needs to cover the shadow-blur trick's spread in
    // compositeWithHardness — same formula as RemoteInkHandler.getPreviewDirtyRect,
    // which pads the same shadowBlur call by blurExtent() and +15.
    const size = user.size || 0;
    const hardness = user._penHardness !== undefined ? user._penHardness : 1.0;
    const blurAmount = hardnessBlurAmount(hardness, size);
    const margin = blurExtent(blurAmount) + size * 0.5 + 15;
    return {
      x: Math.floor(b.minX - margin),
      y: Math.floor(b.minY - margin),
      width: Math.ceil(b.maxX - b.minX + margin * 2),
      height: Math.ceil(b.maxY - b.minY + margin * 2)
    };
  }
}
