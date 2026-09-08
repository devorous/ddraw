import { normalizeTextFont, getTextFontLetterSpacing, getTextFontStack } from '../config/textFonts.js';

export const DEFAULT_TEXT_X_OFFSET = 5;
export const DEFAULT_TEXT_BASELINE_MULTIPLIER = 0.66;
export const DEFAULT_TEXT_BASELINE_OFFSET = -3;
export const DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER = 0;
export const DEFAULT_APPLIED_TEXT_OFFSET = 0;
export const DEFAULT_TEXT_ASCENT_MULTIPLIER = 0.75;
export const DEFAULT_TEXT_DESCENT_MULTIPLIER = 0.25;
export const DEFAULT_TEXT_LINE_HEIGHT_MULTIPLIER = 1.35;
export const CURSOR_TEXT_ANCHOR = 100;

const textLineHeightCache = new Map();

export function getTextFontSize(size) {
  return size + 5;
}

export function getTextLineHeight(fontSize, font, doc = typeof document !== 'undefined' ? document : null) {
  const normalizedFont = normalizeTextFont(font);
  const cacheKey = `${normalizedFont}::${fontSize}`;
  const cached = textLineHeightCache.get(cacheKey);
  if (cached) return cached;

  let lineHeight = fontSize * DEFAULT_TEXT_LINE_HEIGHT_MULTIPLIER;

  if (doc?.body) {
    const probe = doc.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.whiteSpace = 'pre';
    probe.style.display = 'inline-block';
    probe.style.margin = '0';
    probe.style.padding = '0';
    probe.style.border = '0';
    probe.style.fontSize = `${fontSize}px`;
    probe.style.fontFamily = normalizedFont;
    probe.style.lineHeight = 'normal';
    probe.textContent = 'M';

    doc.body.appendChild(probe);
    const singleLineHeight = probe.getBoundingClientRect().height;
    probe.textContent = 'M\nM';
    const doubleLineHeight = probe.getBoundingClientRect().height;
    probe.remove();

    const measuredLineHeight = doubleLineHeight - singleLineHeight;
    if (Number.isFinite(measuredLineHeight) && measuredLineHeight > 0) {
      lineHeight = measuredLineHeight;
    }
  }

  textLineHeightCache.set(cacheKey, lineHeight);
  return lineHeight;
}

export function getUserTextLineHeight(user, doc = typeof document !== 'undefined' ? document : null) {
  return getTextLineHeight(getTextFontSize(user.size), user.font, doc);
}

export function getPreviewTextContent(text = '') {
  const previewText = text ?? '';
  return previewText.endsWith('\n') ? `${previewText}\u200b` : previewText;
}

export function getPreviewTextLayout(user, metrics = null) {
  const fontSize = getTextFontSize(user.size);
  const drawX = user.x + DEFAULT_TEXT_X_OFFSET;
  const baselineY = user.y + (fontSize * DEFAULT_TEXT_BASELINE_MULTIPLIER) + DEFAULT_TEXT_BASELINE_OFFSET;
  const ascent = metrics?.actualBoundingBoxAscent || (fontSize * DEFAULT_TEXT_ASCENT_MULTIPLIER);

  return {
    fontSize,
    drawX,
    baselineY,
    ascent,
    domLeft: CURSOR_TEXT_ANCHOR + DEFAULT_TEXT_X_OFFSET,
    domTop: CURSOR_TEXT_ANCHOR + (fontSize * DEFAULT_TEXT_BASELINE_MULTIPLIER) + DEFAULT_TEXT_BASELINE_OFFSET - ascent
  };
}

export function getAppliedTextLayout(user, metrics = null) {
  const fontSize = getTextFontSize(user.size);
  const multiplier = user.textPositionMultiplier ?? DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER;
  const offset = user.textPositionOffset ?? DEFAULT_APPLIED_TEXT_OFFSET;
  const drawX = user.x + DEFAULT_TEXT_X_OFFSET;
  const previewBaselineY = user.y + (fontSize * DEFAULT_TEXT_BASELINE_MULTIPLIER) + DEFAULT_TEXT_BASELINE_OFFSET;
  const baselineY = previewBaselineY + (fontSize * multiplier) + offset;
  const ascent = metrics?.actualBoundingBoxAscent || (fontSize * DEFAULT_TEXT_ASCENT_MULTIPLIER);
  const descent = metrics?.actualBoundingBoxDescent || (fontSize * DEFAULT_TEXT_DESCENT_MULTIPLIER);

  return {
    fontSize,
    drawX,
    baselineY,
    ascent,
    descent
  };
}

function colorToCssString(color) {
  if (!color) return 'rgba(0,0,0,1)';
  if (typeof color === 'string') return color;
  if (Array.isArray(color)) {
    const [r, g, b, a = 1] = color;
    return `rgba(${r},${g},${b},${a})`;
  }
  return 'rgba(0,0,0,1)';
}

/**
 * Compute font/baseline + per-line layout for a self-contained text record.
 * Used by both canvas rasterization and SVG overlay rendering so they stay in sync.
 *
 * @param {Object} record
 * @param {string} record.text
 * @param {string} record.font
 * @param {number} record.size
 * @param {number} record.x
 * @param {number} record.y
 * @param {number} [record.textPositionMultiplier]
 * @param {number} [record.textPositionOffset]
 * @returns {{fontSize:number, drawX:number, baselineY:number, ascent:number, descent:number, lineHeight:number, lines:string[], maxWidth:number, bbox:{x:number,y:number,width:number,height:number}}}
 */
export function getTextRecordGeometry(record) {
  const lines = (record.text ?? '').split('\n');
  const layout = getAppliedTextLayout(record);
  const lineHeight = getTextLineHeight(layout.fontSize, record.font);

  let maxWidth = 0;
  if (typeof document !== 'undefined') {
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = `${layout.fontSize}px ${getTextFontStack(record.font)}`;
    if ('letterSpacing' in probe) probe.letterSpacing = getTextFontLetterSpacing(record.font);
    for (const line of lines) {
      const w = probe.measureText(line).width;
      if (w > maxWidth) maxWidth = w;
    }
  }

  const totalHeight = (lineHeight * Math.max(lines.length - 1, 0)) + layout.ascent + layout.descent;
  const bbox = {
    x: layout.drawX,
    y: layout.baselineY - layout.ascent,
    width: maxWidth,
    height: totalHeight
  };

  return { ...layout, lineHeight, lines, maxWidth, bbox };
}

/**
 * Rasterize a text record onto a 2D canvas context using fillText.
 * Pure painter — does not touch globalCompositeOperation, does not call beginPath/clear.
 * Returns the same geometry as getTextRecordGeometry so callers can size dirty rects.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} record - { text, font, size, color, opacity, x, y, textPositionMultiplier, textPositionOffset }
 * @returns {ReturnType<typeof getTextRecordGeometry>}
 */
export function paintTextRecord(ctx, record) {
  const geometry = getTextRecordGeometry(record);
  const opacity = record.opacity !== undefined ? record.opacity : 1;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = colorToCssString(record.color);
  ctx.font = `${geometry.fontSize}px ${getTextFontStack(record.font)}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = getTextFontLetterSpacing(record.font);
  ctx.textBaseline = 'alphabetic';
  geometry.lines.forEach((line, i) => {
    ctx.fillText(line, geometry.drawX, geometry.baselineY + (i * geometry.lineHeight));
  });
  ctx.restore();
  return geometry;
}
