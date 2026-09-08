/**
 * @fileoverview Text tool for drawing text on the canvas
 */

import { getAppliedTextLayout, getUserTextLineHeight, paintTextRecord } from '../utils/textLayout.js';
import { getTextFontLetterSpacing, getTextFontStack } from '../config/textFonts.js';
import { Tool } from './BaseTool.js';

const TEXT_DIRTY_RECT_PADDING = 12;

/**
 * Tool for placing and drawing text
 */
export class TextTool extends Tool {
  /**
   * @param {Object} board - Board instance
   */
  constructor(board) {
    super('text', board);
  }

  activate() {
    if (this.board.app?.ui) {
      this.board.app.ui.elements.selfCrosshair.style.display = 'none';
      this.board.app.ui.elements.selfHand.style.display = 'none';
    }
  }

  /**
   * Handle pointer down. The actual placement (local overlay add + broadcast)
   * is performed by App._broadcastExplicitTextApply BEFORE this fires, so all
   * we have to do here is clear the buffer, reset the touch input, and move
   * the placement caret. If there's no buffered text and the user clicks, swap
   * back to the previously selected tool.
   * @param {Object} user - User object
   * @param {Object} pos - Pointer position {x, y}
   */
  onPointerDown(user, pos) {
    if (user.text) {
      user.text = '';
      if (this.board.app?.ui.elements.touchInput) {
        this.board.app.ui.elements.touchInput.value = ' ';
      }
    } else if (this.board.app?.previousTool) {
      this.board.app.selectTool(this.board.app.previousTool);
      return;
    }
    user.x = pos.x;
    user.y = pos.y;
  }

  /**
   * Handle key press for text input
   * @param {Object} user - User object
   * @param {string} key - Pressed key
   * @param {boolean} ctrlKey - Whether Ctrl/Cmd was held
   * @param {boolean} shiftKey - Whether Shift was held
   * @returns {string|null} Current user text, or null if tool should be swapped
   */
  onKeyPress(user, key, ctrlKey = false, shiftKey = false) {
    if (key.length === 1) {
      user.text += key;
    } else if (key === 'Enter') {
      if (shiftKey) {
        // Shift+Enter: add newline
        user.text += '\n';
      } else {
        // Enter: place text or clear if empty
        if (!user.text) return null; // Signal to swap tool
        user.text = '';
      }
    } else if (key === 'Backspace') {
      // Ctrl+Backspace deletes a word backwards; plain Backspace deletes one char.
      user.text = ctrlKey ? TextTool._deleteWordBackward(user.text) : user.text.slice(0, -1);
    } else if (key === 'Delete') {
      // Cursor is always at the end, so Ctrl+Delete matches Ctrl+Backspace.
      if (ctrlKey) user.text = TextTool._deleteWordBackward(user.text);
    } else if (key === 'a' && ctrlKey) {
      // Ctrl+A: select all (for now, just mark that all text is conceptually selected)
      return user.text; // Just return current text, visual feedback not needed
    }
    return user.text;
  }

  /**
   * Deletes the trailing word from `text` (trailing whitespace, then the word
   * characters before it) — the shared body of Ctrl+Backspace / Ctrl+Delete.
   * @param {string} text
   * @returns {string}
   */
  static _deleteWordBackward(text) {
    let i = text.length - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;   // skip trailing whitespace
    while (i >= 0 && /\S/.test(text[i])) i--;   // skip the word
    return text.slice(0, i + 1);
  }

  /**
   * Renders a canvas-based text preview to the top canvas.
   * Used when a blend mode is active, since DOM elements can't blend with canvas layers.
   * @param {Object} user - User object
   */
  renderPreview(user) {
    if (!user.text) return;
    const ctx = this.board.topCtx;
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const { fontSize, drawX, baselineY } = getAppliedTextLayout(user);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px ${getTextFontStack(user.font)}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = getTextFontLetterSpacing(user.font);
    ctx.textBaseline = 'alphabetic';

    const lines = user.text.split('\n');
    const lineHeight = getUserTextLineHeight(user);
    lines.forEach((line, i) => {
      ctx.fillText(line, drawX, baselineY + (i * lineHeight));
    });
    ctx.restore();
  }

  /**
   * Rasterize the user's text into the user's active stroke (legacy bake path).
   * Used by the eraser-bake handler when an SVG text record needs to become pixels.
   * @param {Object} user - User-like object exposing color/font/size/x/y/text/etc.
   */
  drawText(user) {
    const ctx = this.board.getLayerContext(user.activeLayer, user.id);
    ctx.globalCompositeOperation = 'source-over';

    const record = {
      text: user.text,
      font: user.font,
      size: user.size,
      color: typeof user.getColorString === 'function' ? user.getColorString() : user.color,
      opacity: user.opacity,
      x: user.x,
      y: user.y,
      textPositionMultiplier: user.textPositionMultiplier,
      textPositionOffset: user.textPositionOffset
    };

    const { drawX, baselineY, ascent, descent, lineHeight, lines, maxWidth } = paintTextRecord(ctx, record);

    const totalHeight = (lineHeight * Math.max(lines.length - 1, 0)) + ascent + descent;
    const drX = Math.floor(drawX - TEXT_DIRTY_RECT_PADDING);
    const drY = Math.floor(baselineY - ascent - TEXT_DIRTY_RECT_PADDING);
    const drW = Math.ceil(maxWidth + (TEXT_DIRTY_RECT_PADDING * 2));
    const drH = Math.ceil(totalHeight + (TEXT_DIRTY_RECT_PADDING * 2));

    this.board.expandDirtyRect(user, drX, drY, drW, drH);
  }
}
