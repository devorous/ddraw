import { normalizeTextFont } from './config/textFonts.js';
import {
  DEFAULT_APPLIED_TEXT_OFFSET,
  DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER
} from './utils/textLayout.js';
import { truncateUsername } from '../shared/identity.js';
import { normalizeBlendBakeMode } from '../shared/blendBakeMode.js';
import { normalizePressureTargets } from '../shared/pressureTargets.js';

/**
 * @fileoverview User model representing a participant in a drawing session.
 * Tracks user state, tool settings, and synchronization progress.
 */

/**
 * User class represents a single participant, whether local or remote.
 * It stores all visual and behavioral state required to render their
 * actions on the shared canvas.
 */
export class User {
  /**
   * @param {number|string} id - Unique session index or ID.
   * @param {Object} [options={}] - Initial user settings.
   */
  constructor(id, options = {}) {
    this.id = id;
    this.x = options.x || 0;
    this.y = options.y || 0;
    this.targetX = options.x || 0;
    this.targetY = options.y || 0;
    this.lastx = null;
    this.lasty = null;
    this.size = options.size || 10;
    this.pressure = options.pressure || 1;
    this.prevpressure = 1;
    this.spacing = options.spacing || 0;
    this.smoothing = options.smoothing !== undefined ? options.smoothing : 15;
    this.opacity = options.opacity || 1;
    this.hardness = options.hardness !== undefined ? options.hardness : 100;
    this.blurRadius = options.blurRadius !== undefined ? options.blurRadius : 5;
    this.thinning = options.thinning !== undefined ? options.thinning : 0.5;
    this.simulatePressure = options.simulatePressure !== undefined ? options.simulatePressure : true;
    // What pressure drives (PRESSURE_TARGET_* bits). Per user for the same
    // reason as shapeDrawMode: every client renders this user's strokes with it.
    this.pressureTargets = normalizePressureTargets(options.pressureTargets);
    this.patternScale = options.patternScale || 100;
    this.patternShape = options.patternShape || 'circle';
    this.patternName = options.patternName || 'dots';
    this.patternRotation = options.patternRotation || 0;
    this.patternSpacing = options.patternSpacing || 0;
    this.patternOffsetX = options.patternOffsetX || 0;
    this.patternOffsetY = options.patternOffsetY || 0;
    this.patternColorMode = options.patternColorMode || 'original';
    this.patternBrush = options.patternBrush || null;
    this.imageBrushColorMode = options.imageBrushColorMode || 'original';
    this.patternMode = options.patternMode || false;
    this.spaceIndex = 0;
    this.color = options.color || [0, 0, 0, 1];
    this.tool = options.tool || 'ink';
    this.text = options.text || '';
    this.mousedown = false;
    this.panning = false;
    this.username = options.username || '';
    this.registeredName = options.registeredName || '';
    this.context = options.context || null;
    this.board = options.board || null;
    this.imageBrush = null;
    this.cursorStyle = options.cursorStyle || 'circle';
    // Per-user, because shape geometry is reconstructed from this on every
    // client that renders the stroke. Held globally it made a remote user's
    // circle render with the *observer's* mode — center-scaling turns a drag
    // into rx=ry=hypot(dx,dy) instead of |dx|/2, so shapes came out ~2.8x
    // oversized and centred on the drag start.
    this.shapeDrawMode = options.shapeDrawMode === 'center-scaling'
      ? 'center-scaling'
      : 'corner-to-corner';
    this.blendMode = options.blendMode || 'source-over';
    this.blendBakeMode = normalizeBlendBakeMode(options.blendBakeMode);
    this.activeLayer = options.activeLayer || 0;
    this.font = normalizeTextFont(options.font);
    this.textPositionMultiplier = options.textPositionMultiplier ?? DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER;
    this.textPositionOffset = options.textPositionOffset ?? DEFAULT_APPLIED_TEXT_OFFSET;
    this.textRenderMode = options.textRenderMode === 'pixel' ? 'pixel' : 'vector';
    this.currentLine = [];
    this.lineLength = 0;
    this.smoothBuffer = { x: 0, y: 0, isFirst: true };
    this.afk = options.afk || false;
    this.role = options.role || 0;
    this.globalRole = options.globalRole || 0;
    this.roomRole = options.roomRole || 0;
    this.hasDiscord = !!options.hasDiscord;
    this.selectedBadge = options.selectedBadge || '';
    this.isSupporter = !!options.isSupporter;
    this.countryCode = options.countryCode || '';
    this.isMuted = options.isMuted || false;
    this.isSilenced = options.isSilenced || false;
    this.isShadowBanned = options.isShadowBanned || false;
    this.ipHash = options.ipHash || options.iph || '';
    this.visibleIp = options.visibleIp || '';
    this.fingerprintId = options.fingerprintId || options.fpId || ''; // Persistent device/browser fingerprint for user continuity
    this.instanceId = options.instanceId || ''; // Per-connection instance ID to detect session index reuse

    // Tile ownership tracking for griefing detection
    /** @type {Set<number>} Set of tile indices this user owns */
    this.ownedTiles = new Set();
    /** @type {Array<{timestamp: number, tileIndex: number, previousOwners: number[]}>} */
    this.eraseHistory = [];
  }

  /**
   * Sets the user's AFK (Away From Keyboard) status.
   * @param {boolean} afk - The new AFK state.
   * @returns {void}
   */
  setAfk(afk) {
    this.afk = afk;
  }

  /**
   * Resets all position trackers to a specific coordinate.
   *
   * @param {number} x - The X coordinate.
   * @param {number} y - The Y coordinate.
   * @returns {void}
   */
  resetPosition(x, y) {
    this.x = x;
    this.y = y;
    this.lastx = x;
    this.lasty = y;
    this.targetX = x;
    this.targetY = y;
  }

  /**
   * Updates the current position and stores the previous one.
   *
   * @param {number} x - The new X coordinate.
   * @param {number} y - The new Y coordinate.
   * @returns {void}
   */
  setPosition(x, y) {
    this.lastx = this.x;
    this.lasty = this.y;
    this.x = x;
    this.y = y;
  }

  /**
   * Sets the raw target position for smoothing/interpolation.
   *
   * @param {number} x - The target X coordinate.
   * @param {number} y - The target Y coordinate.
   * @returns {void}
   */
  setTarget(x, y) {
    this.targetX = x;
    this.targetY = y;
  }

  /**
   * Changes the active drawing tool.
   *
   * @param {string} tool - The tool name.
   * @returns {void}
   */
  setTool(tool) {
    this.tool = tool;
    if (tool !== 'text') {
      this.text = '';
    }
  }

  setCursorStyle(style) {
    this.cursorStyle = style || 'circle';
  }

  /**
   * Sets the active drawing color.
   *
   * @param {Array<number>} color - [r, g, b, a] color array.
   * @returns {void}
   */
  setColor(color) {
    this.color = color;
  }

  /**
   * Sets the brush size, clamped between 0.25 and 100.
   *
   * @param {number} size - The new size.
   * @returns {void}
   */
  setSize(size) {
    this.size = Math.max(0.25, Math.min(100, size));
  }

  /**
   * Sets the current pressure value, clamped between 0.0 and 1.0.
   *
   * @param {number} pressure - The new pressure.
   * @returns {void}
   */
  setPressure(pressure) {
    this.prevpressure = this.pressure;
    this.pressure = Math.max(0, Math.min(1, pressure));
  }

  /**
   * Sets the brush spacing, clamped between 0 and 50.
   *
   * @param {number} spacing - The new spacing.
   * @returns {void}
   */
  setSpacing(spacing) {
    this.spacing = Math.max(0, Math.min(50, spacing));
  }

  /**
   * Sets the smoothing factor, clamped between 0 and 50.
   *
   * @param {number} smoothing - The new smoothing value.
   * @returns {void}
   */
  setSmoothing(smoothing) {
    this.smoothing = Math.max(0, Math.min(50, smoothing));
  }

  /**
   * Sets the brush opacity, clamped between 0.0 and 1.0.
   *
   * @param {number} opacity - The new opacity.
   * @returns {void}
   */
  setOpacity(opacity) {
    this.opacity = Math.max(0, Math.min(1, opacity));
  }

  /**
   * Sets the brush hardness, clamped between 0 and 100.
   *
   * @param {number} hardness - The new hardness.
   * @returns {void}
   */
  setHardness(hardness) {
    this.hardness = Math.max(0, Math.min(100, hardness));
  }

  /**
   * Sets the blur tool radius, clamped between 0 and 100.
   *
   * @param {number} radius - The new blur radius.
   * @returns {void}
   */
  setBlurRadius(radius) {
    this.blurRadius = Math.max(0, Math.min(100, radius));
  }

  /**
   * Sets the ink tool thinning, clamped between 0 and 1.
   *
   * @param {number} thinning - The new thinning value (0-1).
   * @returns {void}
   */
  setThinning(thinning) {
    this.thinning = Math.max(0, Math.min(1, thinning));
  }

  /**
   * Sets the font family for the text tool.
   *
   * @param {string} font - The CSS font-family string.
   * @returns {void}
   */
  setFont(font) {
    this.font = normalizeTextFont(font);
  }

  setTextPositionMultiplier(multiplier) {
    this.textPositionMultiplier = Number.isFinite(Number(multiplier))
      ? Number(multiplier)
      : DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER;
  }

  setTextPositionOffset(offset) {
    this.textPositionOffset = Number.isFinite(Number(offset))
      ? Number(offset)
      : DEFAULT_APPLIED_TEXT_OFFSET;
  }

  /**
   * Sets whether to simulate pressure from velocity for the ink tool.
   *
   * @param {boolean} simulate - Whether to simulate pressure.
   * @returns {void}
   */
  setSimulatePressure(simulate) {
    this.simulatePressure = Boolean(simulate);
  }

  /**
   * Sets what pressure drives: size, opacity and/or hardness.
   *
   * @param {number} targets - PRESSURE_TARGET_* bits (0 = none).
   * @returns {void}
   */
  setPressureTargets(targets) {
    this.pressureTargets = normalizePressureTargets(targets);
  }

  /**
   * Sets the canvas blend mode (composite operation).
   *
   * @param {string} blendMode - The blend mode name.
   * @returns {void}
   */
  setBlendMode(blendMode) {
    this.blendMode = blendMode || 'source-over';
  }

  setBlendBakeMode(mode) {
    this.blendBakeMode = normalizeBlendBakeMode(mode);
  }

  /**
   * Sets the active drawing layer index.
   *
   * @param {number} layerIndex - The new layer index (0-4).
   * @returns {void}
   */
  setActiveLayer(layerIndex) {
    this.activeLayer = Math.max(0, Math.min(4, layerIndex));
  }

  /**
   * Sets the username, truncated to 20 Unicode characters.
   *
   * @param {string} username - The new username.
   * @returns {void}
   */
  setUsername(username) {
    this.username = truncateUsername(username);
  }

  /**
   * Initializes a new line with a starting position.
   *
   * @param {Object} pos - The starting {x, y} coordinate.
   * @returns {void}
   */
  startLine(pos) {
    this.currentLine = [pos];
    this.lineLength = 0;
  }

  /**
   * Adds a point to the current active line.
   *
   * @param {Object} pos - The {x, y} coordinate to add.
   * @returns {void}
   */
  addToLine(pos) {
    this.currentLine.push(pos);
  }

  /**
   * Clears the current line buffer.
   * @returns {void}
   */
  clearLine() {
    this.currentLine = [];
    this.lineLength = 0;
  }

  /**
   * Returns a CSS-compatible RGBA color string.
   * @returns {string}
   */
  getColorString() {
    return `rgba(${this.color.join(',')})`;
  }

  /**
   * Serializes the user state to a plain object.
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      size: this.size,
      pressure: this.pressure,
      spacing: this.spacing,
      smoothing: this.smoothing,
      opacity: this.opacity,
      hardness: this.hardness,
      blurRadius: this.blurRadius,
      thinning: this.thinning,
      simulatePressure: this.simulatePressure,
      pressureTargets: this.pressureTargets,
      color: this.color,
      tool: this.tool,
      text: this.text,
      cursorStyle: this.cursorStyle,
      username: this.username,
      isSupporter: this.isSupporter,
      blendMode: this.blendMode,
      blendBakeMode: this.blendBakeMode,
      activeLayer: this.activeLayer,
      patternScale: this.patternScale,
      patternShape: this.patternShape,
      patternName: this.patternName,
      patternRotation: this.patternRotation,
      patternSpacing: this.patternSpacing,
        patternOffsetX: this.patternOffsetX,
        patternOffsetY: this.patternOffsetY,
        patternColorMode: this.patternColorMode,
        font: this.font,
        textPositionMultiplier: this.textPositionMultiplier,
        textPositionOffset: this.textPositionOffset
      };
    }

  /**
   * Updates multiple user fields from a data object.
   *
   * @param {Object} data - Object containing new field values.
   * @returns {void}
   */
  updateFrom(data) {
    const fields = ['x', 'y', 'size', 'pressure', 'spacing', 'smoothing', 'opacity', 'hardness', 'blurRadius', 'color', 'tool', 'text', 'cursorStyle', 'username', 'blendMode', 'blendBakeMode', 'activeLayer', 'patternScale', 'patternShape', 'patternName', 'patternRotation', 'patternSpacing', 'font', 'textPositionMultiplier', 'textPositionOffset', 'hasDiscord', 'isSupporter', 'pressureTargets'];
      fields.forEach(field => {
        if (data[field] !== undefined) {
          if (field === 'pressureTargets') {
            this.setPressureTargets(data[field]);
          } else if (field === 'font') {
            this[field] = normalizeTextFont(data[field]);
          } else if (field === 'textPositionMultiplier') {
            this.setTextPositionMultiplier(data[field]);
          } else if (field === 'textPositionOffset') {
            this.setTextPositionOffset(data[field]);
          } else if (field === 'blendBakeMode') {
            this.setBlendBakeMode(data[field]);
          } else {
            this[field] = data[field];
          }
        }
      });
  }
}
