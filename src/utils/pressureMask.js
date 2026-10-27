/**
 * @fileoverview Per-pixel pressure for tools that composite a whole stroke at once.
 *
 * Flow pen and ink draw a stroke's coverage into an offscreen canvas and apply
 * opacity once, when that canvas is composited. Pressure that drives opacity
 * has to vary along the stroke instead, so those tools also stamp each point's
 * pressure into a PressureMask (alpha = pressure) and composite through
 * compositePressureStroke(), which scales the coverage by the mask.
 *
 * By default a pixel takes the strongest pressure any stamp reached ('max'), so
 * a light pass crossing a dark one doesn't lighten it, and overlaps never
 * darken beyond the strongest pass, the same no-stacking rule the offscreen
 * canvas exists for. The sender and every receiver stamp the same points in the
 * same order from the same wire values, so the masks, and the committed pixels,
 * match.
 *
 * `localStorage.ddrawMaskMode` = 'replace' | 'stack' swaps that rule for
 * comparison (see PressureMask): 'replace' is the old behaviour, where the most
 * recent stamp wins; 'stack' is experimental and slow. Unset or anything else
 * gives 'max'. Each client renders strokes in its own mode, so mixed versions or
 * a set flag can make pixels differ between users; the flag is a dev tool only.
 */

import {
  DEFAULT_PRESSURE_TARGETS,
  PRESSURE_TARGET_OPACITY,
  PRESSURE_TARGET_SIZE
} from '../../shared/pressureTargets.js';
import { blurExtent, clampRectToCanvas } from './drawing.js';

/** Room a mask window keeps around its stamps, so a growing stroke doesn't reallocate every point. */
const MASK_WINDOW_SLACK = 128;

/** Draws a soft edge from the shadow alone, the same trick every stroke tool's compositeWithHardness uses. */
const SHADOW_OFFSET = 100000;

/**
 * @param {number} targets - PRESSURE_TARGET_* bits.
 * @returns {boolean} Whether a stroke with these targets needs a pressure mask.
 */
export function usesPressureMask(targets) {
  return ((targets ?? DEFAULT_PRESSURE_TARGETS) & PRESSURE_TARGET_OPACITY) !== 0;
}

/**
 * The `shadowBlur` a stroke tool softens its edge with.
 * @param {number} hardness - 0-1.
 * @param {number} size
 * @returns {number}
 */
export function hardnessBlurAmount(hardness, size) {
  return (1 - hardness) * (20 + size * 0.2);
}

/**
 * How far past its coverage a mask stamp reaches. Always zero: the mask scales
 * the solid coverage before compositePressureStroke blurs it, so the soft edge
 * needs no pad, and stamps must hug the coverage (under 'max' an oversized heavy
 * stamp would darken lighter ink near it).
 * @param {number} hardness - 0-1.
 * @param {number} size
 * @returns {number}
 */
export function pressureMaskPad(hardness, size) {
  return 0;
}

/** No slack past a circle stamp's radius: the mask matches the coverage edge exactly, so a lighter part of a stroke is never darkened by a neighbouring heavier part's rim. */
const FLOW_MASK_MARGIN = 0;

/**
 * Radius the flow pen's coverage stamp has at this pressure (before its 0.5 floor).
 * @param {number} targets
 * @param {number} pressure - 0-1.
 * @param {number} size - Stroke size at its start.
 * @returns {number}
 */
export function flowCoverageRadius(targets, pressure, size) {
  const sized = ((targets ?? DEFAULT_PRESSURE_TARGETS) & PRESSURE_TARGET_SIZE) ? pressure : 1;
  return sized * size;
}

/**
 * Mask radius for a circle-stamped stroke (flow pen) at this pressure: its
 * coverage radius plus the soft edge.
 * @param {number} targets
 * @param {number} pressure - 0-1.
 * @param {number} size - Stroke size at its start.
 * @param {number} hardness - 0-1.
 * @returns {number}
 */
export function pressureStampRadius(targets, pressure, size, hardness) {
  return Math.max(0.5, flowCoverageRadius(targets, pressure, size)) + FLOW_MASK_MARGIN + pressureMaskPad(hardness, size);
}

/** perfect-freehand's RATE_OF_PRESSURE_CHANGE. */
const INK_PRESSURE_RATE = 0.275;

/** The constants perfect-freehand derives from the ink options, as InkTool/RemoteInkHandler pass them. */
function inkOutlineParams(targets, size, thinning, simulatePressure, smoothing) {
  const sm = smoothing !== undefined ? smoothing / 50 : 0.5;
  return {
    sizeDriven: ((targets ?? DEFAULT_PRESSURE_TARGETS) & PRESSURE_TARGET_SIZE) !== 0,
    optionsSize: Math.max(0.1, (size * 2) / (1 + thinning)),
    effectiveThinning: simulatePressure ? Math.min(0.99, thinning * Math.max(1, size / 10)) : 0.95,
    lerp: 0.15 + (1 - (0.3 + sm * 0.7)) * 0.85, // getStrokePoints' streamline step
    simulatePressure
  };
}

const inkHalfWidth = (k, pressure) => k.optionsSize * (0.5 - k.effectiveThinning * (0.5 - pressure));

/**
 * Advances the replayed outline by one kept stroke point (getStrokeOutlinePoints'
 * pressure step) and returns that point's half-width.
 * simulatePressure: p' = p + (min(1, 1 - sp) - p) * sp * 0.275, sp = min(1, distance / options.size).
 * Its start value comes from a lookahead over the first 10 points, so it starts
 * at its upper bound 1 here and only settles at or above the real one.
 * Otherwise p is the point's own pressure (when size-driven) or 1.
 */
function inkStepRadius(st, k, distance, sized) {
  if (!k.simulatePressure) return inkHalfWidth(k, sized);
  const sp = Math.min(1, distance / k.optionsSize);
  st.v = Math.min(1, st.v + (Math.min(1, 1 - sp) - st.v) * (sp * INK_PRESSURE_RATE));
  return inkHalfWidth(k, st.v);
}

/**
 * Stamps one input point of an ink stroke into its mask, where the outline
 * really is. perfect-freehand draws the outline around streamlined points that
 * lag the input (each is a lerp from the last kept point toward the input, and
 * none is kept until the path has run `options.size`), so this replays that
 * (getStrokePoints) and stamps at the streamlined point, with the outline's
 * half-width there. State lives in `mask.inkState`, so it resets with the
 * mask, and the sender and receivers stamping the same points in the same
 * order get identical masks. Call stampInkEnd when the stroke ends.
 * @param {PressureMask} mask
 * @param {number} targets
 * @param {number} x - Raw input x.
 * @param {number} y
 * @param {number} pressure - 0-1.
 * @param {number} size - Stroke size at its start.
 * @param {number} thinning - The user's 0-1 thinning.
 * @param {boolean} simulatePressure
 * @param {number|undefined} smoothing - The user's 0-50 smoothing (undefined = the tools' default).
 */
export function stampInkPoint(mask, targets, x, y, pressure, size, thinning, simulatePressure, smoothing) {
  const p = Math.round(Math.max(0, Math.min(1, pressure)) * 255) / 255;
  const k = inkOutlineParams(targets, size, thinning, simulatePressure, smoothing);
  const sized = k.sizeDriven ? p : 1;
  let st = mask.inkState;
  if (!st) {
    // First point: the outline starts here; a lone point renders as a dot of radius size * pressure.
    st = mask.inkState = { n: 1, mx: x, my: y, run: 0, reached: false, v: 1, sizedPrev: sized, rx: x, ry: y, rp: pressure };
    mask.stampTo(x, y, Math.max(inkHalfWidth(k, simulatePressure ? 1 : sized), size * sized), pressure);
    return;
  }
  st.n++;
  st.rx = x; st.ry = y; st.rp = pressure;
  const nx = st.mx + (x - st.mx) * k.lerp;
  const ny = st.my + (y - st.my) * k.lerp;
  const distance = Math.hypot(nx - st.mx, ny - st.my);
  if (st.n === 2) {
    // Two points render as a round-capped segment between the raw points.
    mask.stampTo(x, y, size * Math.max(sized, st.sizedPrev) / 2, pressure);
  }
  if (distance === 0) return;
  st.run += distance;
  if (!st.reached) {
    if (st.run < k.optionsSize) return; // the library drops points until the path is as long as options.size
    st.reached = true;
  }
  // The library doesn't carry a corner point's pressure forward (a turn past 90 degrees), so undo it.
  const vx = (st.mx - nx) / distance;
  const vy = (st.my - ny) / distance;
  if (st.vx !== undefined && vx * st.vx + vy * st.vy < 0) st.v = st.vBefore;
  st.vx = vx; st.vy = vy; st.vBefore = st.v;
  st.mx = nx;
  st.my = ny;
  mask.stampTo(nx, ny, inkStepRadius(st, k, distance, sized), pressure);
}

/**
 * Stamps the last input point the way perfect-freehand's `last` option keeps
 * it, snapped to the raw point instead of lagging. Call once when the stroke
 * ends, before its final render.
 * @param {PressureMask} mask
 * @param {number} targets
 * @param {number} size
 * @param {number} thinning
 * @param {boolean} simulatePressure
 * @param {number|undefined} smoothing
 */
export function stampInkEnd(mask, targets, size, thinning, simulatePressure, smoothing) {
  const st = mask.inkState;
  if (!st || st.n < 3) return; // dots and two-point segments are stamped as they come
  const k = inkOutlineParams(targets, size, thinning, simulatePressure, smoothing);
  const p = Math.round(Math.max(0, Math.min(1, st.rp)) * 255) / 255;
  const distance = Math.hypot(st.rx - st.mx, st.ry - st.my);
  mask.stampTo(st.rx, st.ry, inkStepRadius(st, k, distance, k.sizeDriven ? p : 1), st.rp);
}

/**
 * Ink points as the outline should see them: pressure shapes the outline only
 * when it drives size.
 * @param {Array<number[]>} points - [x, y, pressure] triples.
 * @param {number} targets
 * @returns {Array<number[]>}
 */
export function inkOutlinePoints(points, targets) {
  if ((targets ?? DEFAULT_PRESSURE_TARGETS) & PRESSURE_TARGET_SIZE) return points;
  return points.map(([x, y]) => [x, y, 1]);
}

/** Accumulation modes: see PressureMask. 'max' is the default; 'replace' is the old behaviour. */
const MASK_MODES = ['replace', 'max', 'stack'];
const DEFAULT_MASK_MODE = 'max';

/**
 * Which accumulation mode a new stroke's mask uses. `globalThis.__ddrawMaskMode`
 * (bench override) wins over `localStorage.ddrawMaskMode`; anything else is 'max'.
 * @returns {'replace'|'max'|'stack'}
 */
export function pressureMaskMode() {
  let mode = globalThis.__ddrawMaskMode;
  if (!mode) {
    try { mode = globalThis.localStorage?.getItem('ddrawMaskMode'); } catch { mode = null; }
  }
  if (!MASK_MODES.includes(mode)) return DEFAULT_MASK_MODE;
  // 'stack' folds through ctx.filter; without it fall back to the old behaviour.
  return mode === 'stack' && !canvasFilterWorks() ? 'replace' : mode;
}

const colorMatrixFilter = (values) => 'url("data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg'><filter id='f' color-interpolation-filters='sRGB'>` +
  `<feColorMatrix type='matrix' values='${values}'/></filter></svg>`) + '#f")';
/** Opaque grey whose red is the source alpha: lets 'lighten' (per-channel max) do an alpha max. */
const ALPHA_TO_GREY = colorMatrixFilter('0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1');
/** The reverse: black with alpha = red. */
const GREY_TO_ALPHA = colorMatrixFilter('0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0');

let canvasFilterOk = null;

/**
 * Whether this browser applies `ctx.filter` on canvas (Safari ignores it). Probed once by
 * drawing a grey pixel through GREY_TO_ALPHA. `globalThis.__ddrawMaskNoFilter` (bench) forces false.
 * @returns {boolean}
 */
function canvasFilterWorks() {
  if (globalThis.__ddrawMaskNoFilter) return false;
  if (canvasFilterOk !== null) return canvasFilterOk;
  try {
    const src = newEntry(1, 1);
    src.ctx.fillStyle = 'rgb(128, 128, 128)';
    src.ctx.fillRect(0, 0, 1, 1);
    const dst = newEntry(1, 1);
    copyRect(dst, src.canvas, { x: 0, y: 0, w: 1, h: 1 }, GREY_TO_ALPHA);
    canvasFilterOk = Math.abs(dst.ctx.getImageData(0, 0, 1, 1).data[3] - 128) <= 3;
  } catch {
    canvasFilterOk = false;
  }
  return canvasFilterOk;
}

/** GREY_TO_ALPHA without ctx.filter: new alpha = the grey's red, rgb 0. */
function greyToAlphaRect(entry, src, r) {
  const grey = src.getContext('2d').getImageData(r.x, r.y, r.w, r.h);
  const px = grey.data;
  for (let i = 0; i < px.length; i += 4) {
    px[i + 3] = px[i];
    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
  }
  entry.ctx.putImageData(grey, r.x, r.y);
}

/** Extra reach of the footprint/dirty boxes past a stamp's radius (the footprint is dilated so it covers the mask's antialiased rim). */
const STAMP_PAD = 2;

function newEntry(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d') };
}

/** Clears a canvas-local rect and draws the same rect of `src` over it, optionally through a filter. */
function copyRect(entry, src, r, filter) {
  const ctx = entry.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(r.x, r.y, r.w, r.h);
  if (filter) ctx.filter = filter;
  ctx.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  ctx.restore();
}

/** Draws a canvas-local rect of `src` onto `entry` with a composite operation. */
function blendRect(entry, src, r, operation) {
  const ctx = entry.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = operation;
  ctx.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  ctx.restore();
}

/**
 * A stroke's pressure, as alpha, in a board-space canvas windowed to the
 * stroke and grown as it goes.
 *
 * How overlapping stamps combine is selectable (pressureMaskMode):
 *  - 'replace': the old behaviour. A stamp overwrites what is under it, so a
 *    pixel takes the pressure of the most recent stamp that reached it.
 *  - 'max' (default): a stamp never lowers a pixel. Kept as an opaque grey canvas (grey =
 *    pressure) so 'lighten' can take the per-channel max, which 2D canvas can't
 *    do on alpha; `canvas` converts it to alpha lazily.
 *  - 'stack': self-overlap darkens (a + b(1 - a)), but not against the stroke's
 *    own neighbours. Stamps go to a max-mode grey canvas `cur` for a chunk (~2
 *    radii of path); a closed chunk folds into the settled canvas, taking the max where
 *    it overlaps the previous chunk's footprint and stacking elsewhere.
 *    `canvas` is settled plus the open chunk folded in, rebuilt lazily.
 */
export class PressureMask {
  constructor() {
    /** Board position of the canvas's (0, 0). */
    this.origin = { x: 0, y: 0 };
    /** @type {{x:number, y:number, radius:number, pressure:number}|null} */
    this.last = null;
    this._clear();
  }

  /** @returns {HTMLCanvasElement|null} The mask as alpha, ready for compositePressureStroke. */
  get canvas() {
    if (!this._main) return null;
    if (this._mode === 'replace') return this._main.canvas;
    if (!this._view || this._dirty) this._buildView();
    return this._view.canvas;
  }

  /** Drops the mask for the next stroke. */
  reset() {
    this.origin = { x: 0, y: 0 };
    this.last = null;
    this._clear();
  }

  _clear() {
    this.inkState = null; // ink: outline radius recurrence (see stampInkPoint)
    this._mode = DEFAULT_MASK_MODE;
    this._main = null;   // replace: the mask; max: grey; stack: settled
    this._cur = null;    // stack: open chunk (grey, max semantics)
    this._fcur = null;   // stack: open chunk's solid footprint
    this._fprev = null;  // stack: previous chunk's solid footprint
    this._hasPrev = false;
    this._chunkLen = 0;
    this._chunkBox = null;
    this._view = null;
    this._dirty = null;  // board box changed since the view was last built
    this._scratchSet = null;
  }

  /**
   * Stamps from the previous point to this one, interpolating radius and pressure.
   * @param {number} x - Board x.
   * @param {number} y - Board y.
   * @param {number} radius - Mask radius (coverage plus pressureMaskPad).
   * @param {number} pressure - 0-1.
   */
  stampTo(x, y, radius, pressure) {
    const r = Math.max(1, radius);
    const p = Math.max(0, Math.min(1, pressure));
    const last = this.last;
    if (!this._main) this._mode = pressureMaskMode();

    this._ensure(
      Math.min(x - r, last ? last.x - last.radius : Infinity),
      Math.min(y - r, last ? last.y - last.radius : Infinity),
      Math.max(x + r, last ? last.x + last.radius : -Infinity),
      Math.max(y + r, last ? last.y + last.radius : -Infinity)
    );

    if (!last) {
      this._put(x, y, r, p, 0);
    } else {
      const dx = x - last.x;
      const dy = y - last.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const spacing = Math.max(1, Math.min(last.radius, r) * 0.25);
      const steps = Math.max(1, Math.ceil(distance / spacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this._put(
          last.x + dx * t,
          last.y + dy * t,
          last.radius + (r - last.radius) * t,
          last.pressure + (p - last.pressure) * t,
          distance / steps
        );
      }
    }

    this.last = { x, y, radius: r, pressure: p };
  }

  /** One stamp, routed by mode. @private */
  _put(x, y, radius, pressure, stepLength) {
    const ox = this.origin.x;
    const oy = this.origin.y;
    const pad = radius + STAMP_PAD;
    const d = this._dirty;
    if (d) {
      d.x0 = Math.min(d.x0, x - pad); d.y0 = Math.min(d.y0, y - pad);
      d.x1 = Math.max(d.x1, x + pad); d.y1 = Math.max(d.y1, y + pad);
    } else if (this._view) {
      this._dirty = { x0: x - pad, y0: y - pad, x1: x + pad, y1: y + pad };
    }

    const draw = (entry, fn) => {
      const ctx = entry.ctx;
      ctx.save();
      ctx.translate(-ox, -oy);
      fn(ctx);
      ctx.restore();
    };

    if (this._mode === 'replace') {
      draw(this._main, (ctx) => this._stamp(ctx, x, y, radius, pressure));
    } else if (this._mode === 'max') {
      draw(this._main, (ctx) => this._stampMax(ctx, x, y, radius, pressure));
    } else {
      draw(this._cur, (ctx) => this._stampMax(ctx, x, y, radius, pressure));
      draw(this._fcur, (ctx) => {
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(x, y, radius + STAMP_PAD, 0, Math.PI * 2);
        ctx.fill();
      });
      const b = this._chunkBox;
      if (b) {
        b.x0 = Math.min(b.x0, x - pad); b.y0 = Math.min(b.y0, y - pad);
        b.x1 = Math.max(b.x1, x + pad); b.y1 = Math.max(b.y1, y + pad);
      } else {
        this._chunkBox = { x0: x - pad, y0: y - pad, x1: x + pad, y1: y + pad };
      }
      this._chunkLen += stepLength;
      if (this._chunkLen >= radius * 2) this._closeChunk();
    }
  }

  /**
   * 'replace' mode (the old behaviour; 'max' is the default): replaces the mask
   * under a circle with `pressure`. The refill ADDS
   * (`lighter`) rather than drawing over: an edge pixel the circle covers by c
   * keeps (1 - c) of its old value after destination-out, and adding
   * pressure * c lands exactly on the lerp between them. `source-over` would
   * shave that edge down instead — at full pressure to 75% — leaving a faint
   * ring at every stamp.
   * @private
   */
  _stamp(ctx, x, y, radius, pressure) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (pressure <= 0) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(0, 0, 0, ${pressure})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Raises the grey under a circle to `pressure` and never lowers it. On the
   * opaque grey 'lighten' blends an edge pixel as (1 - c) * old + c * max(old, grey).
   * @private
   */
  _stampMax(ctx, x, y, radius, pressure) {
    if (pressure <= 0) return;
    const v = Math.round(pressure * 255);
    ctx.globalCompositeOperation = 'lighten';
    ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Board box -> integer canvas-local rect clamped to the window, or null if empty. @private */
  _localRect(box) {
    const c = this._main.canvas;
    const x0 = Math.max(0, Math.floor(box.x0 - this.origin.x));
    const y0 = Math.max(0, Math.floor(box.y0 - this.origin.y));
    const x1 = Math.min(c.width, Math.ceil(box.x1 - this.origin.x));
    const y1 = Math.min(c.height, Math.ceil(box.y1 - this.origin.y));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** Window-sized scratch canvases for folds. @private */
  _scratch() {
    if (!this._scratchSet) {
      const { width, height } = this._main.canvas;
      this._scratchSet = { a: newEntry(width, height), b: newEntry(width, height), c: newEntry(width, height), d: newEntry(width, height), e: newEntry(width, height) };
    }
    return this._scratchSet;
  }

  /**
   * Folds the open chunk (`cur`) into `dst` over rect `r`. Where `cur` overlaps
   * the previous chunk's footprint the result is max(dst, cur); elsewhere it
   * stacks (dst over cur); the footprint's coverage lerps between the two.
   * @private
   */
  _fold(dst, r) {
    const { a, b, c, d, e } = this._scratch();
    copyRect(e, this._cur.canvas, r, GREY_TO_ALPHA);
    const cur = e.canvas;
    if (!this._hasPrev) {
      blendRect(dst, cur, r, 'source-over');
      return;
    }
    const fprev = this._fprev.canvas;
    // a = stacked result, minus the footprint
    copyRect(a, dst.canvas, r);
    blendRect(a, cur, r, 'source-over');
    blendRect(a, fprev, r, 'destination-out');
    // b = alpha max(dst, cur) via grey, inside the footprint only
    copyRect(c, dst.canvas, r, ALPHA_TO_GREY);
    copyRect(d, cur, r, ALPHA_TO_GREY);
    blendRect(c, d.canvas, r, 'lighten');
    copyRect(b, c.canvas, r, GREY_TO_ALPHA);
    blendRect(b, fprev, r, 'destination-in');
    // the two halves tile the rect
    copyRect(dst, a.canvas, r);
    blendRect(dst, b.canvas, r, 'lighter');
  }

  /** Folds the open chunk into the settled canvas and makes its footprint the "previous" one. @private */
  _closeChunk() {
    const box = this._chunkBox;
    this._chunkLen = 0;
    this._chunkBox = null;
    if (!box) return;
    const r = this._localRect(box);
    if (r) {
      this._fold(this._main, r);
      this._cur.ctx.fillStyle = '#000';
      this._cur.ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    const t = this._fprev;
    this._fprev = this._fcur;
    this._fcur = t;
    const { width, height } = t.canvas;
    t.ctx.clearRect(0, 0, width, height);
    this._hasPrev = true;
  }

  /** Rebuilds the combined alpha view over the changed region. @private */
  _buildView() {
    const { width, height } = this._main.canvas;
    let r;
    if (!this._view) {
      this._view = newEntry(width, height);
      r = { x: 0, y: 0, w: width, h: height };
    } else {
      r = this._localRect(this._dirty);
    }
    this._dirty = null;
    if (!r) return;
    if (this._mode === 'max') {
      if (canvasFilterWorks()) copyRect(this._view, this._main.canvas, r, GREY_TO_ALPHA);
      else greyToAlphaRect(this._view, this._main.canvas, r);
    } else {
      copyRect(this._view, this._main.canvas, r);
      if (this._chunkBox) this._fold(this._view, r);
    }
  }

  /**
   * Grows the window to cover a board-space box, carrying the stamped pixels over.
   * @private
   */
  _ensure(minX, minY, maxX, maxY) {
    const old = this._main?.canvas;
    const o = this.origin;
    if (old && minX >= o.x && minY >= o.y && maxX <= o.x + old.width && maxY <= o.y + old.height) return;

    let left = Math.floor(minX) - MASK_WINDOW_SLACK;
    let top = Math.floor(minY) - MASK_WINDOW_SLACK;
    let right = Math.ceil(maxX) + MASK_WINDOW_SLACK;
    let bottom = Math.ceil(maxY) + MASK_WINDOW_SLACK;
    if (old) {
      left = Math.min(left, o.x);
      top = Math.min(top, o.y);
      right = Math.max(right, o.x + old.width);
      bottom = Math.max(bottom, o.y + old.height);
    }

    const width = right - left;
    const height = bottom - top;
    const grow = (entry, opaque) => {
      const next = newEntry(width, height);
      if (opaque) {
        next.ctx.fillStyle = '#000';
        next.ctx.fillRect(0, 0, width, height);
      }
      if (entry) next.ctx.drawImage(entry.canvas, o.x - left, o.y - top);
      return next;
    };

    this._main = grow(this._main, this._mode === 'max');
    if (this._mode === 'stack') {
      this._cur = grow(this._cur, true);
      this._fcur = grow(this._fcur, false);
      this._fprev = grow(this._fprev, false);
    }
    this._view = null;
    this._dirty = null;
    this._scratchSet = null;
    this.origin = { x: left, y: top };
  }
}


/**
 * Composites a stroke's coverage with its pressure applied, into a scratch
 * canvas laid out like the coverage canvas (same size, same board origin).
 *
 * @param {Object} scratch - Holds the scratch canvases between calls; one per stroke owner.
 * @param {HTMLCanvasElement} coverage - The stroke's solid coverage.
 * @param {{x:number, y:number}} coverageOrigin - Board position of coverage's (0, 0).
 * @param {PressureMask|null} mask
 * @param {Object} opts
 * @param {number} opts.targets - PRESSURE_TARGET_* bits.
 * @param {number} opts.hardness - The stroke's hardness, 0-1.
 * @param {number} opts.size - The stroke's size (drives the blur amount).
 * @param {string} opts.color - The stroke's CSS colour, for the soft edge.
 * @param {{x:number, y:number, width:number, height:number}|null} [opts.rect] -
 *   Coverage-local region to redraw; null or omitted redraws everything.
 * @returns {HTMLCanvasElement} Draw it at coverageOrigin with the stroke's own alpha.
 */
export function compositePressureStroke(scratch, coverage, coverageOrigin, mask, opts) {
  const { targets, hardness, size, color } = opts;
  const a = sizeScratch(scratch, 'a', coverage);
  const area = opts.rect
    ? clampRectToCanvas(opts.rect, coverage)
    : { x: 0, y: 0, width: coverage.width, height: coverage.height };
  if (!area) return a.canvas;

  // Coverage just outside the area still blurs into it, so read past the area
  // by the blur's reach and let the clip trim the result.
  const blurAmount = hardnessBlurAmount(hardness, size);
  const reach = Math.ceil(blurExtent(blurAmount));
  const source = clampRectToCanvas({
    x: area.x - reach,
    y: area.y - reach,
    width: area.width + reach * 2,
    height: area.height + reach * 2
  }, coverage);

  beginArea(a.ctx, area);
  const masked = (targets & PRESSURE_TARGET_OPACITY) !== 0;
  if (masked && blurAmount > 0 && source) {
    // Mask the solid coverage first, then blur it, so the soft edge carries the
    // pressure and the mask needs no pad that could darken a lighter pass nearby.
    const b = sizeScratch(scratch, 'b', coverage);
    beginArea(b.ctx, source);
    b.ctx.drawImage(coverage, source.x, source.y, source.width, source.height, source.x, source.y, source.width, source.height);
    drawMask(b.ctx, mask, coverageOrigin, 'destination-in');
    b.ctx.restore();
    drawCoverage(a.ctx, b.canvas, source, blurAmount, color);
  } else {
    drawCoverage(a.ctx, coverage, source, blurAmount, color);
    if (masked) drawMask(a.ctx, mask, coverageOrigin, 'destination-in');
  }

  a.ctx.restore();
  return a.canvas;
}

function sizeScratch(scratch, key, like) {
  let entry = scratch[key];
  if (!entry || entry.canvas.width !== like.width || entry.canvas.height !== like.height) {
    const canvas = document.createElement('canvas');
    canvas.width = like.width;
    canvas.height = like.height;
    entry = scratch[key] = { canvas, ctx: canvas.getContext('2d') };
  }
  return entry;
}

function beginArea(ctx, area) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.width, area.height);
  ctx.clip();
  ctx.clearRect(area.x, area.y, area.width, area.height);
}

function drawCoverage(ctx, coverage, source, blurAmount, color) {
  if (!source) return;
  const { x, y, width, height } = source;
  if (blurAmount > 0) {
    ctx.save();
    ctx.shadowBlur = blurAmount;
    ctx.shadowColor = color;
    ctx.shadowOffsetX = -SHADOW_OFFSET;
    ctx.shadowOffsetY = 0;
    ctx.drawImage(coverage, x, y, width, height, x + SHADOW_OFFSET, y, width, height);
    ctx.restore();
  } else {
    ctx.drawImage(coverage, x, y, width, height, x, y, width, height);
  }
}

function drawMask(ctx, mask, coverageOrigin, operation) {
  ctx.globalCompositeOperation = operation;
  if (mask?.canvas) {
    ctx.drawImage(mask.canvas, mask.origin.x - coverageOrigin.x, mask.origin.y - coverageOrigin.y);
  } else if (operation === 'destination-in') {
    // No stamps yet means no pressure anywhere. Clipped to the area.
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  ctx.globalCompositeOperation = 'source-over';
}
