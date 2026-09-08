/**
 * @fileoverview TextOverlay - manages ephemeral SVG vector text records that fade over time.
 *
 * Text isn't a stroke. Each record lives in this overlay until it (a) ages past its
 * lifetime and is removed, or (b) the eraser hits it and `bakeToCanvas` rasterizes
 * it into a real stroke on the canvas before removing the SVG node.
 *
 * The SVG element is mounted inside the board's transformed wrapper so it inherits
 * the zoom/pan/rotate matrix automatically — text stays crisp at any zoom.
 */

import { paintTextRecord, getTextRecordGeometry } from '../utils/textLayout.js';
import { getTextFontLetterSpacing, getTextFontStack } from '../config/textFonts.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const TEXT_OVERLAY_DEFAULT_LIFETIME_MS = 30 * 1000;   // total lifetime
export const TEXT_OVERLAY_DEFAULT_HOLD_MS = 0;                // no full-opacity hold; ramp starts immediately
export const TEXT_OVERLAY_DEFAULT_MIN_OPACITY = 0;            // fade fully to transparent
export const TEXT_OVERLAY_DEFAULT_FADE_MS = TEXT_OVERLAY_DEFAULT_LIFETIME_MS - TEXT_OVERLAY_DEFAULT_HOLD_MS;
const DEFAULT_LIFETIME_MS = TEXT_OVERLAY_DEFAULT_LIFETIME_MS;
const DEFAULT_HOLD_MS = TEXT_OVERLAY_DEFAULT_HOLD_MS;
const DEFAULT_MIN_OPACITY = TEXT_OVERLAY_DEFAULT_MIN_OPACITY;
const DEFAULT_FADE_MS = TEXT_OVERLAY_DEFAULT_FADE_MS;
const BAKE_DIRTY_PADDING = 12;

function colorToCss(color) {
  if (!color) return 'rgba(0,0,0,1)';
  if (typeof color === 'string') return color;
  if (Array.isArray(color)) {
    const [r, g, b, a = 1] = color;
    return `rgba(${r},${g},${b},${a})`;
  }
  return 'rgba(0,0,0,1)';
}

export class TextOverlay {
  constructor(board) {
    this.board = board;
    this.records = new Map(); // id -> { record, node, geometry, bornAt }
    this.svg = null;
    this._rafHandle = null;
    this._onRemoveBroadcast = null; // wired by App: (id) => wsClient.broadcastTextRemove(id)
    this._roomLifetimeMs = TEXT_OVERLAY_DEFAULT_LIFETIME_MS;
  }

  /**
   * Set the per-room lifetime (in ms) used as the default for new records that
   * arrive without an explicit lifetimeMs. Called when the room's settings change.
   * @param {number} ms
   */
  setRoomLifetime(ms) {
    const next = Number(ms);
    if (Number.isFinite(next) && next > 0) {
      this._roomLifetimeMs = next;
    }
  }

  getRoomLifetime() {
    return this._roomLifetimeMs;
  }

  mount(parent) {
    if (this.svg) return;
    const [height, width] = this.board.dimensions;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'textOverlay');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    // Lock the SVG viewport into the board coordinate system so text positions
    // are deterministic regardless of zoom. preserveAspectRatio="none" stops
    // the SVG from re-fitting content if width/height ever drift slightly.
    svg.setAttribute('preserveAspectRatio', 'none');
    // Disable font hinting so glyph metrics don't snap to different pixel
    // positions at different zoom levels — that's what was causing the jitter.
    svg.setAttribute('text-rendering', 'geometricPrecision');
    svg.setAttribute('shape-rendering', 'geometricPrecision');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    svg.style.transformOrigin = '0 0';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '4';
    svg.style.overflow = 'visible';
    parent.appendChild(svg);
    this.svg = svg;
  }

  resize(width, height) {
    if (!this.svg) return;
    this.svg.setAttribute('width', String(width));
    this.svg.setAttribute('height', String(height));
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.svg.style.width = `${width}px`;
    this.svg.style.height = `${height}px`;
  }

  setOnRemoveBroadcast(fn) {
    this._onRemoveBroadcast = fn;
  }

  /**
   * Insert a text record into the overlay.
   * @param {Object} record - Text record (see types in TextTool / WS layer).
   *   Required: id, text, x, y, size, font, color, opacity, layerIdx, userId
   *   Optional: lifetimeMs, fadeMs, ageMs (for backfill from server)
   */
  add(record) {
    if (!record?.id || !record.text) return;
    if (this.records.has(record.id)) return;
    if (!this.svg) return;

    // Legacy `fadeMs` is supported but reinterpreted as the trailing ramp window.
    const lifetimeMs = Number.isFinite(record.lifetimeMs) ? record.lifetimeMs : this._roomLifetimeMs;
    const fadeMs = Number.isFinite(record.fadeMs)
      ? Math.max(0, Math.min(record.fadeMs, lifetimeMs))
      : Math.max(0, Math.min(DEFAULT_FADE_MS, lifetimeMs));
    const holdMs = Number.isFinite(record.holdMs)
      ? Math.max(0, Math.min(record.holdMs, lifetimeMs))
      : Math.max(0, lifetimeMs - fadeMs);
    const minOpacity = Number.isFinite(record.minOpacity) ? Math.max(0, Math.min(1, record.minOpacity)) : DEFAULT_MIN_OPACITY;
    const ageMs = Number.isFinite(record.ageMs) ? Math.max(0, record.ageMs) : 0;
    const bornAt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - ageMs;

    if (ageMs >= lifetimeMs) return;

    const stored = {
      record: { ...record, lifetimeMs, holdMs, fadeMs, minOpacity },
      node: null,
      geometry: null,
      bornAt
    };
    stored.geometry = getTextRecordGeometry(stored.record);
    stored.node = this._buildNode(stored.record, stored.geometry);
    // Apply initial faded opacity if the record was already past its hold window
    // when added (e.g. backfilled from the server with ageMs > holdMs).
    if (ageMs > holdMs) {
      const fadeWindow = Math.max(1, lifetimeMs - holdMs);
      const t = Math.min(1, (ageMs - holdMs) / fadeWindow);
      const fadeAlpha = 1 - t * (1 - minOpacity);
      const opacity = (stored.record.opacity ?? 1) * fadeAlpha;
      stored.node.setAttribute('fill-opacity', opacity.toFixed(3));
    }
    this.svg.appendChild(stored.node);
    this.records.set(record.id, stored);
    this._ensureRafLoop();
  }

  _buildNode(record, geometry) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(geometry.drawX));
    text.setAttribute('y', String(geometry.baselineY));
    text.setAttribute('font-family', getTextFontStack(record.font));
    text.setAttribute('font-size', String(geometry.fontSize));
    text.setAttribute('fill', colorToCss(record.color));
    text.setAttribute('fill-opacity', String(record.opacity ?? 1));
    text.setAttribute('dominant-baseline', 'alphabetic');
    text.setAttribute('text-anchor', 'start');
    text.setAttribute('text-rendering', 'geometricPrecision');
    text.style.whiteSpace = 'pre';
    text.style.letterSpacing = getTextFontLetterSpacing(record.font);

    geometry.lines.forEach((line, i) => {
      const tspan = document.createElementNS(SVG_NS, 'tspan');
      tspan.setAttribute('x', String(geometry.drawX));
      tspan.setAttribute('dy', i === 0 ? '0' : String(geometry.lineHeight));
      tspan.textContent = line.length === 0 ? '​' : line; // preserve empty lines
      text.appendChild(tspan);
    });

    return text;
  }

  /**
   * Remove a record without baking — used for fade-expiry and remote TEXT_REMOVE.
   * Does NOT broadcast.
   */
  removeRemote(id) {
    const stored = this.records.get(id);
    if (!stored) return;
    stored.node?.remove();
    this.records.delete(id);
  }

  /**
   * Remove a record locally with a brief CSS opacity ramp, then broadcast TEXT_REMOVE.
   * Used by the eraser when its stamp overlaps an SVG text bbox.
   */
  eraseRemove(id) {
    const stored = this.records.get(id);
    if (!stored) return;
    // Drop from the map immediately so server echoes / hit-tests don't double-fire.
    this.records.delete(id);
    if (typeof this._onRemoveBroadcast === 'function') {
      try { this._onRemoveBroadcast(id); } catch { /* swallow */ }
    }
    const node = stored.node;
    if (node) {
      node.style.transition = 'opacity 220ms ease-out';
      node.setAttribute('opacity', '0');
      setTimeout(() => node.remove(), 240);
    }
  }

  /**
   * Hit-test: returns array of records whose bbox intersects the given rect.
   * @param {{x:number,y:number,width:number,height:number}} rect
   */
  hitTestRect(rect) {
    if (!rect || !this.records.size) return [];
    const x1 = rect.x;
    const y1 = rect.y;
    const x2 = rect.x + rect.width;
    const y2 = rect.y + rect.height;
    const hits = [];
    for (const stored of this.records.values()) {
      const b = stored.geometry.bbox;
      if (b.x < x2 && b.x + b.width > x1 && b.y < y2 && b.y + b.height > y1) {
        hits.push(stored.record);
      }
    }
    return hits;
  }

  /**
   * Hit-test against a circular eraser stamp (cx, cy, radius in board coords).
   */
  hitTestCircle(cx, cy, radius) {
    if (!this.records.size) return [];
    const hits = [];
    for (const stored of this.records.values()) {
      const b = stored.geometry.bbox;
      const closestX = Math.max(b.x, Math.min(cx, b.x + b.width));
      const closestY = Math.max(b.y, Math.min(cy, b.y + b.height));
      const dx = cx - closestX;
      const dy = cy - closestY;
      if (dx * dx + dy * dy <= radius * radius) {
        hits.push(stored.record);
      }
    }
    return hits;
  }

  /**
   * Rasterize a record into a stroke on its layer, remove the SVG node, broadcast removal.
   * Safe to call on a record that's no longer in the overlay (no-op).
   */
  bakeToCanvas(id) {
    const stored = this.records.get(id);
    if (!stored) return;
    const record = stored.record;
    const layerIdx = record.layerIdx ?? 0;
    const userId = record.userId ?? this.board.layerManager?.localUserId ?? 0;

    const lm = this.board.layerManager;
    if (!lm) {
      this.removeRemote(id);
      return;
    }

    lm.beginUserStroke(layerIdx, userId, 'source-over');
    const ctx = lm.getUserStrokeContext(layerIdx, userId, 'source-over');
    if (ctx) {
      const { drawX, baselineY, ascent, descent, lineHeight, lines, maxWidth } = paintTextRecord(ctx, record);
      const totalHeight = (lineHeight * Math.max(lines.length - 1, 0)) + ascent + descent;
      const drX = Math.floor(drawX - BAKE_DIRTY_PADDING);
      const drY = Math.floor(baselineY - ascent - BAKE_DIRTY_PADDING);
      const drW = Math.ceil(maxWidth + BAKE_DIRTY_PADDING * 2);
      const drH = Math.ceil(totalHeight + BAKE_DIRTY_PADDING * 2);
      this.board.expandDirtyRect({ activeLayer: layerIdx, id: userId }, drX, drY, drW, drH);
    }
    lm.commitUserStroke(layerIdx, userId);

    this.removeRemote(id);
    if (typeof this._onRemoveBroadcast === 'function') {
      try { this._onRemoveBroadcast(id); } catch { /* swallow */ }
    }

    this.board.requestUpdate?.();
  }

  /** Remove all records — used on board clear / room change. */
  clear() {
    for (const stored of this.records.values()) {
      stored.node?.remove();
    }
    this.records.clear();
  }

  destroy() {
    this.clear();
    if (this._rafHandle) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
    this.svg?.remove();
    this.svg = null;
  }

  _ensureRafLoop() {
    if (this._rafHandle) return;
    const tick = () => {
      this._rafHandle = null;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const expired = [];
      for (const [id, stored] of this.records) {
        const age = now - stored.bornAt;
        const { lifetimeMs, holdMs, minOpacity } = stored.record;
        if (age >= lifetimeMs) {
          expired.push(id);
          continue;
        }
        if (age > holdMs) {
          // Linear ramp from 1.0 → minOpacity across (holdMs, lifetimeMs).
          const fadeWindow = Math.max(1, lifetimeMs - holdMs);
          const t = Math.min(1, (age - holdMs) / fadeWindow);
          const fadeAlpha = 1 - t * (1 - minOpacity);
          const opacity = (stored.record.opacity ?? 1) * fadeAlpha;
          stored.node.setAttribute('fill-opacity', opacity.toFixed(3));
        }
      }
      for (const id of expired) this.removeRemote(id);
      if (this.records.size > 0) {
        this._rafHandle = requestAnimationFrame(tick);
      }
    };
    this._rafHandle = requestAnimationFrame(tick);
  }
}
