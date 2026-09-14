/** @fileoverview Main entry point for the drawing application, coordinating board, tools, UI, and networking. */

import { T, ToolToEnum } from '../shared/MessageTypes.js';
import {
  packColor,
  hexToRgb as _hexToRgb,
  rgbToHsl as _rgbToHsl,
  shiftLightness as _shiftL,
  blendColors as _blend
} from '../shared/ColorUtils.js';
import { User } from './User.js';
import { Board } from './canvas/Board.js';
import { TEXT_OVERLAY_DEFAULT_LIFETIME_MS, TEXT_OVERLAY_DEFAULT_FADE_MS } from './canvas/TextOverlay.js';
import { ToolManager, BrushTool } from './tools/Tools.js';
import { UI } from './ui/index.js';
import { BrushGalleryLoader } from './ui/BrushGalleryLoader.js';
import { PatternBrushGallery } from './ui/PatternBrushGallery.js';
import { assetLibrary } from './ui/AssetLibrary.js';
import { RemoteUserHandler } from './remote/RemoteUserHandler.js';
import { TouchHandler } from './input/TouchHandler.js';
import { setupWebSocketHandlers } from './network/WebSocketHandlers.js';
import { DebugOverlay, SyncClient, createDebugSync, ParityClient, ParityPanel } from './sync/index.js';
import { logCanvasCensus } from './utils/canvasCensus.js';
import { douglasPeucker, distanceBasedCulling } from './utils/drawing.js';
import { bindPressAction } from './utils/buttonBinding.js';
import { Moderation } from './auth/Moderation.js';
import { setActiveAuthTab } from './auth/authTabs.js';
import { ColorInputMenu } from './ui/ColorInputMenu.js';
import { ColorController } from './ui/ColorController.js';
import { MobileLayoutController } from './ui/MobileLayoutController.js';
import { isMobile, MOBILE_HIDDEN_TOOLS } from './platform/mobile.js';
import { SaveController } from './ui/SaveController.js';
import { PatternOptionsController } from './ui/PatternOptionsController.js';
import { UpdateNoticeController } from './ui/UpdateNoticeController.js';
import { supporterDialog } from './ui/SupporterDialog.js';
import { ChatController } from './ui/ChatController.js';
import { ToolLockManager } from './tools/ToolLockManager.js';
import { InputBufferManager, detectLowPowerDevice } from './input/InputBufferManager.js';
import { KeyboardHandler } from './input/KeyboardHandler.js';
import { BrushModeManager } from './tools/BrushModeManager.js';
import { BlendModeManager } from './canvas/BlendModeManager.js';
// import { StrokeHistoryPanel } from './ui/StrokeHistoryPanel.js'; // Hidden - stroke history panel disabled
import { DebugPanel } from './ui/DebugPanel.js';
import { decodeDdraw, isDdrawFile } from '../shared/ddrawCodec.js';
import { highlight } from './ui/Highlight.js';
import { deferredReplay, preloadRoomModules, preloadAdminModules } from './platform/deferredModules.js';
import { SaveMode } from './ui/SaveMode.js';
import { MirrorRegionController } from './ui/MirrorRegionController.js';
import { BoardViewer } from './ui/BoardViewer.js';
import { SnapshotManager } from './remote/SnapshotManager.js';
import { readQoiDimensions } from '../shared/qoi.js';
import { loadAppPreferences, saveAppPreferences, THEME_BASE_COLORS } from './config/AppPreferences.js';
import { applyRoomBoardSize } from './config/BoardSizes.js';
import { applyRoomTiledCanvas } from './config/TiledCanvasSetting.js';
import {
  getDefaultRightClickAction,
  getRightClickActionsForTool,
  resolveRightClickAction,
  getRightClickActionLabel
} from './config/rightClickActions.js';
import { getTextFontDefaults, loadTextFont, normalizeTextFont } from './config/textFonts.js';
import {
  isTauriDesktop,
  openImageViaNativeDialog
} from './platform/desktop.js';
import { ensureClientCanConnect, getVersionStatus } from './VersionChecker.js';
import { focusChatPopout } from './platform/chatPopoutBridge.js';
import { BackgroundKeepAlive } from './platform/BackgroundKeepAlive.js';
import initWasm from './wasm/ddraw_wasm.js';
import * as wasm from './wasm/ddraw_wasm.js';

// Svelte UI Components
import { initSvelteUI, syncStoresFromApp, showProfile as showProfileDialog } from './ui/svelte/AppUI.svelte.js';
import { appState, addRecentColor, getCustomPresetKey, toggleRecorderPanel } from './state.svelte.js';
import { normalizeBlendBakeMode } from '../shared/blendBakeMode.js';
import {
  DEFAULT_PRESSURE_TARGETS,
  normalizePressureTargets,
  pressureSizeFactor
} from '../shared/pressureTargets.js';

const TEXT_FONT_SETTINGS_STORAGE_KEY = 'topDrawTextFontSettings';
const SHAPE_DRAW_MODE_STORAGE_KEY = 'topDrawShapeDrawMode';
const NORMAL_TPS = 60;
const BLUR_RADIUS_MAX = 10;
const GLITCH_BLUR_RADIUS_MAX = 25;
const WASM_INIT_TIMEOUT_MS = 15000;

// Tool rail collapse ladder, applied in order until the rail fits its height.
// Groups become flyouts first (icons stay full size), then the whole rail
// shrinks, and .is-scrollable is the final fallback in
// App.updateToolRailCollapseState.
const TOOL_RAIL_COLLAPSE_STAGES = [
  'force-move-collapse',
  'force-blur-collapse',
  'force-compact',
  'force-compact-2'
];
const COALESCED_INPUT_TOOLS = new Set([
  'brush',
  'flowPen',
  'imageBrush',
  'ink',
  'erase',
  'blur',
  'circleBlur',
  'glitchBlur',
  'pixel',
  'pattern',
  'confetti'
]);

function updateStartupStatus(text, status = 'connecting') {
  window.updateLandingShellStatus?.(status, text);
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

const DERIVED_THEME_CSS_KEYS = [
  'bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-elevated',
  'surface-glass', 'surface-overlay',
  'accent-primary', 'accent-secondary', 'accent-hover',
  'accent-glow',
  'text-primary', 'text-secondary', 'text-muted',
  'border-subtle', 'border-active'
];

function applyThemeColors(themeColors = {}) {
  if (typeof document === 'undefined') return;

  const rootStyle = document.documentElement.style;
  const customThemeColors = themeColors && typeof themeColors === 'object' ? themeColors : {};
  const hasCustomTheme = ['bg', 'accent', 'text'].some((key) => {
    const value = customThemeColors[key];
    return typeof value === 'string' && value.length > 0;
  });
  const bg = customThemeColors.bg || THEME_BASE_COLORS.bg;
  const accent = customThemeColors.accent || THEME_BASE_COLORS.accent;
  const text = customThemeColors.text || THEME_BASE_COLORS.text;

  if (hasCustomTheme) {
    // Scale the layer step with the base lightness so darker backgrounds
    // stay dark — e.g. near-black bg uses ~2pt steps instead of 5pt.
    const [, , bgL] = _rgbToHsl(..._hexToRgb(bg));
    const step = Math.min(5, Math.max(1.5, bgL * 0.44));

    const vars = {
      'bg-primary':       bg,
      'bg-secondary':     _shiftL(bg, step),
      'bg-tertiary':      _shiftL(bg, step * 2),
      'bg-elevated':      _shiftL(bg, step * 3),
      'surface-glass':    _blend(_shiftL(bg, step * 1.35), '#000000', 0.08),
      'surface-overlay':  _blend(bg, '#000000', 0.5),
      'accent-primary':   accent,
      'accent-secondary': _shiftL(accent, -6),
      'accent-hover':     _shiftL(accent, 4),
      'accent-glow':      _blend(accent, bg, 0.7),
      'text-primary':     text,
      'text-secondary':   _blend(text, bg, 0.38),
      'text-muted':       _blend(text, bg, 0.62),
      'border-subtle':    _blend(text, bg, 0.9),
      'border-active':    _blend(accent, bg, 0.5),
    };
    for (const [key, val] of Object.entries(vars)) {
      rootStyle.setProperty(`--${key}`, val);
    }
  } else {
    for (const key of DERIVED_THEME_CSS_KEYS) {
      rootStyle.removeProperty(`--${key}`);
    }
  }
}

function applySidebarSide(sidebarSide = 'right') {
  if (typeof document === 'undefined') return;

  const normalized = sidebarSide === 'left' ? 'left' : 'right';
  document.documentElement.dataset.sidebarSide = normalized;
}

function applyChatOpacity(opacity) {
  if (typeof document === 'undefined') return;

  const value = Number(opacity);
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0.3, value)) : 0.95;
  document.documentElement.style.setProperty('--chat-opacity', clamped);
}

function applyLocalBoardBackgroundOverride(board, hexColor = null, enabled = true) {
  board?.setDisplayBackgroundColorOverride?.(enabled ? hexColor : null);
}

/**
 * Main Drawing Application class.
 * @class
 */
export class DrawingApp {
  /**
   * @param {WebSocketClient} wsClient - Pre-configured WebSocket client from auth-landing phase.
   * @param {Object} options - Application configuration options.
   * @param {Array<number>} [options.dimensions=[1080, 1920]] - Board dimensions.
   * @param {Object} [options.auth] - Auth instance from auth-landing phase.
   * @param {Object} [options.appPreferences] - App preferences from auth-landing phase.
   */
  constructor(wsClient, options = {}) {
    this.wsClient = wsClient; // Use WebSocketClient from auth-landing phase
    // onConnect/onDisconnect callbacks are set up in init() after this.self is created

    this.sessionIndex = null;
    this.users = new Map();
    this.fingerprintIdUserColorCache = new Map(); // Map fingerprint ID -> color for persistent user identification
    this.connected = false;
    this.previousTool = null;
    this.intentionalDisconnect = false;

    // Use provided appPreferences or load fresh
    this.appPreferences = options.appPreferences || loadAppPreferences();
    applyThemeColors(this.appPreferences?.general?.themeColors);
    applySidebarSide(this.appPreferences?.general?.sidebarSide);
    applyChatOpacity(this.appPreferences?.general?.chatOpacity);
    this._warnOnNextUnload = false;
    this.supportedCursorStyleTools = ['brush', 'flowPen', 'ink', 'erase'];
    this.toolCursorStyles = this.loadToolCursorStyles();
    this.isOfflineMode = false;

    // Selection state for asynchronous imageData loading
    this._pendingSelLiftImageDataUrl = null;
    this._pendingSelLiftRect = null;
    this._pendingSelLiftLassoPath = null;
    this._pendingSelMoveData = null; // Stores { corners, x, y }
    this._isSelLiftDataLoading = false;

    // Deferred initialization (moved from constructor to init())
    this.board = null;
    this.toolManager = null;
    this.ui = null;
    this.brushGallery = null;
    this.patternGallery = null;
    this.colorInputMenu = null;

    // Color system (pickers, slots, palette/hex handling) — see ui/ColorController.js
    this.colorController = new ColorController(this);
    this.saveController = new SaveController(this);
    this.patternOptions = new PatternOptionsController(this);
    this.updateNotices = new UpdateNoticeController(this);
    this.chatController = new ChatController(this);
    this.mobileLayout = new MobileLayoutController(this);

    this.self = null;
    this.isOnBoard = false;

    this.remoteUserHandler = null;
    this.touchHandler = null;
    this.debugOverlay = null;
    this.regionTracker = null;
    this.syncClient = null;
    this.mirrorRegionController = null;
    this.moderation = new Moderation();
    this.auth = options.auth || null; // From auth-landing phase
    this.landingPage = options.landingPage || null; // From auth-landing phase
    this.currentRoomId = null;
    this.currentRoomData = null;
    this._pendingLandingLogin = false;
    this.selfRole = 0;
    // this.profileDialog = new ProfileDialog(); // Now Svelte component

    this.inputBufferManager = new InputBufferManager(this);
    this.wsClient.getLowPowerMode = () => this.inputBufferManager.lowPowerMode;
    // _applyLowPowerPreference() is called in init() after board is created

    this.shapeDrawMode = 'corner-to-corner';
    this.modifierKeys = {
      shift: false,
      alt: false,
      ctrl: false,
      meta: false
    };

    this.pressureEnabled = true;
    // When true, the glitch-blur tool skips the per-stamp WASM render while
    // drawing (showing only a grey placeholder) and renders the full result on
    // pointerUp. Local-only preference; reduces lag on large/long strokes.
    this.glitchFastPreview = false;
    this.tabletDetected = false;
    this.tabletThinningWarningShown = false;

    this.eraseAllLayers = false;

    this.brushModeManager = new BrushModeManager(this);

    this.blendModeManager = new BlendModeManager(this);

    this.toolLockManager = new ToolLockManager(this);

    // Keyboard handler
    this.keyboardHandler = new KeyboardHandler(this);
    this._boundSuppressButtonKeyboardActivation = (e) => this.suppressButtonKeyboardActivation(e);

    // boardContainer background pan tracking
    this._containerPanActive = false;
    this._lastPanPointerX = 0;
    this._lastPanPointerY = 0;
    this._boardDragDepth = 0;

    // True between the MD and MU we put on the wire for the current stroke.
    // Gates _queueStrokeEndBroadcast — see the note there.
    this._strokeMdBroadcast = false;

    // Right-click drag zoom state
    this._rightDragZoomActive = false;
    this._rightDragZoomPointerId = null;
    this._rightDragZoomStartClientY = 0;
    this._rightDragZoomStartZoom = 1;
    this._rightDragZoomPivotX = 0;
    this._rightDragZoomPivotY = 0;
    this._temporaryZoomPreviousTool = null;

    // Rotate tool state
    this._rotateToolActive = false;  // true while rotate-tool drag is in progress
    this._rotatePivotX = 0;          // boardContainer-relative pivot
    this._rotatePivotY = 0;
    this._rotatePivotClientX = 0;    // page-relative pivot (for angle calculation)
    this._rotatePivotClientY = 0;
    this._rotatePrevAngle = null;    // previous angle from pivot to pointer

    // Stroke history panel - DISABLED (never part of Debug mode; LayerManager,
    // SyncClient and Board all call into it, so the stub stays)
    // this.strokeHistoryPanel = new StrokeHistoryPanel();
    this.strokeHistoryPanel = {
      init: () => {},
      setLayerManager: () => {},
      setActiveLayer: () => {},
      setEnabled: () => {},
      update: () => {},
      queueUpdate: () => {}
    }; // Stub for compatibility

    // Debug mode panel (device/TPS/canvas census/tiled backing store)
    this.debugPanel = new DebugPanel(this.inputBufferManager, this);

    // Save mode (initialized in init() after board is ready)
    this.saveMode = null;

    // Room preview interval (sends 1/4 scale preview to server every 30s)
    this._previewInterval = null;
    this._previewIntervalMs = 30000;

    // Timer period (30s): snapshots save every tick; the dedicated user's
    // full-board replay checkpoint sends every other tick (60s). See startCheckpointLoop.
    this._checkpointInterval = null;
    this._checkpointIntervalMs = 30000;
    this._memoryCompactionTimer = null;
    this._memoryCompactionDelayMs = 2500;
    this._versionUpdateNoticed = false;
    this._awaitingServerRestart = false;
    this._reloadRecommended = false;
    this._offlineDismissedUpdateVersion = null;
    this._lastUpdateNoticeVersion = null;

    this.snapshotManager = new SnapshotManager(this);
  }

  loadToolCursorStyles() {
    const defaults = {
      brush: 'circle',
      flowPen: 'circle',
      ink: 'circle',
      erase: 'circle'
    };

    try {
      const saved = localStorage.getItem('topDrawToolCursorStyles');
      if (!saved) return { ...defaults };
      const parsed = JSON.parse(saved);
      for (const tool of this.supportedCursorStyleTools) {
        const style = parsed?.[tool];
        if (['circle', 'crosshair', 'dot', 'square'].includes(style)) {
          defaults[tool] = style;
        }
      }
    } catch (error) {
      console.warn('Failed to load tool cursor styles:', error);
    }

    return defaults;
  }

  saveToolCursorStyles() {
    try {
      localStorage.setItem('topDrawToolCursorStyles', JSON.stringify(this.toolCursorStyles));
    } catch (error) {
      console.warn('Failed to save tool cursor styles:', error);
    }
  }

  getCursorStyleForTool(tool) {
    if (!this.supportedCursorStyleTools.includes(tool)) return 'circle';
    return this.toolCursorStyles[tool] || 'circle';
  }

  applyCursorStyleForTool(tool) {
    this.self.setCursorStyle(this.getCursorStyleForTool(tool));
  }

  updateActiveToolPreview() {
    const toolName = this.self?.tool;
    if (!['brush', 'flowPen', 'ink', 'pixel', 'imageBrush', 'confetti'].includes(toolName)) return;
    this.toolManager.getTool(toolName)?.updatePreview?.(this.self);
  }

  updatePatternPreviewIfVisible() {
    if (appState.toolPreviewVisible && !appState.toolPreviewCollapsed && appState.toolPreviewMode === 'pattern') {
      this.toolManager.getTool('pattern')?.updatePreview?.(this.self);
    }
  }

  handleCursorStyleChange(style) {
    const tool = this.self.tool;
    if (!this.supportedCursorStyleTools.includes(tool)) return;
    const nextStyle = ['circle', 'crosshair', 'dot', 'square'].includes(style) ? style : 'circle';
    this.toolCursorStyles[tool] = nextStyle;
    this.self.setCursorStyle(nextStyle);
    this.saveToolCursorStyles();
    this.ui.updateToolDisplay(tool, this.self);
    this.ui.updateSelfCursor(this.self.x, this.self.y, this.self.size);
    this.ui.updateSquarePositions(this.self.size);
    if (nextStyle === 'circle') {
      this.ui.updatePressureCursorRadius(this.self.pressure * this.self.size, this.self.size, this.tabletDetected);
    } else if (nextStyle === 'square') {
      this.ui.updatePressureSquareSize(this.self.pressure * this.self.size, this.self.size, this.tabletDetected);
    }
    this.updateActiveToolPreview();
  }

  normalizeShapeDrawMode(mode) {
    return mode === 'center-scaling' ? 'center-scaling' : 'corner-to-corner';
  }

  isShiftModifierActive() {
    return !!this.modifierKeys.shift;
  }

  updateModifierKeysFromEvent(event) {
    if (!event) return;
    this.modifierKeys.shift = !!event.shiftKey;
    this.modifierKeys.alt = !!event.altKey;
    this.modifierKeys.ctrl = !!event.ctrlKey;
    this.modifierKeys.meta = !!event.metaKey;
  }

  clearModifierKeys() {
    this.modifierKeys.shift = false;
    this.modifierKeys.alt = false;
    this.modifierKeys.ctrl = false;
    this.modifierKeys.meta = false;
  }

  applyShapeDrawMode(mode, { broadcast = false, persist = true } = {}) {
    const normalizedMode = this.normalizeShapeDrawMode(mode);
    this.shapeDrawMode = normalizedMode;

    // The user object is what the shape tools read when rendering, for local
    // and remote strokes alike; the tool singletons keep the mode only as a
    // fallback for callers that have no user (e.g. replay of an unattributed
    // CSDM).
    if (this.self) this.self.shapeDrawMode = normalizedMode;

    const rectangleTool = this.toolManager.getTool('rectangle');
    const circleTool = this.toolManager.getTool('circle');
    if (rectangleTool?.setDrawMode) rectangleTool.setDrawMode(normalizedMode);
    if (circleTool?.setDrawMode) circleTool.setDrawMode(normalizedMode);

    document.querySelectorAll('input[name="shapeDrawMode"]').forEach((radio) => {
      radio.checked = radio.value === normalizedMode;
    });

    if (persist) {
      localStorage.setItem(SHAPE_DRAW_MODE_STORAGE_KEY, normalizedMode);
    }

    if (broadcast && this.connected && this.wsClient) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastShapeDrawModeChange(normalizedMode));
    }
  }

  getConstrainedShapeDragPoint(rawX, rawY) {
    if (!this.self?.mousedown || this.self.panning) return { x: rawX, y: rawY };
    if (this.self.tool !== 'rectangle' && this.self.tool !== 'circle') return { x: rawX, y: rawY };

    const tool = this.toolManager?.getCurrentTool?.();
    const start = tool?.startPos;
    if (!start) return { x: rawX, y: rawY };

    const mode = this.normalizeShapeDrawMode(this.shapeDrawMode);
    const dx = rawX - start.x;
    const dy = rawY - start.y;

    // Center-scaling shapes are always perfect square/circle, so normalize the drag vector.
    if (mode === 'center-scaling') {
      if (this.self.tool === 'rectangle') {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        const sx = dx === 0 ? (dy < 0 ? -1 : 1) : Math.sign(dx);
        const sy = dy === 0 ? (dx < 0 ? -1 : 1) : Math.sign(dy);
        return {
          x: start.x + sx * side,
          y: start.y + sy * side
        };
      }
      return { x: rawX, y: rawY };
    }

    // Corner mode: only constrain when Shift is held.
    if (!this.isShiftModifierActive()) {
      return { x: rawX, y: rawY };
    }

    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx === 0 ? (dy < 0 ? -1 : 1) : Math.sign(dx);
    const sy = dy === 0 ? (dx < 0 ? -1 : 1) : Math.sign(dy);
    return {
      x: start.x + sx * side,
      y: start.y + sy * side
    };
  }

  /**
   * Initializes the application, components, and event listeners.
   * @async
   * @returns {Promise<void>}
   */
  async init() {
    window.app = this; // Set global reference early
    this.debugSync = createDebugSync(this); // window.app.debugSync.dumpParity()
    this.canvasCensus = () => logCanvasCensus(this); // window.app.canvasCensus()

    // Initialize heavy subsystems (deferred from constructor)
    updateStartupStatus('Preparing drawing engine...');
    this.board = new Board({
      dimensions: [1080, 1920]
    });
    applyLocalBoardBackgroundOverride(
      this.board,
      this.appPreferences?.general?.localBoardBackgroundColor,
      this.appPreferences?.general?.localBoardBackgroundEnabled !== false
    );

    this.toolManager = new ToolManager(this.board);
    this.ui = new UI();

    this.brushGallery = new BrushGalleryLoader({
      onSelect: (brush) => this.handleBrushSelect(brush),
      onUpload: () => this.ui.elements.brushFileInput?.click(),
      shouldShowBrush: (brush) => {
        // Confetti has its own built-in circle/square shapes, so hide the
        // pinned dot/square SVGs to avoid duplicates.
        if (this.self?.tool === 'confetti') return brush?.type !== 'gih' && !brush?.pinned;
        return brush?.type !== 'confetti-shape';
      },
      includeDefaultShapes: () => this.self?.tool === 'confetti',
      assetLibrary
    });
    this.patternGallery = new PatternBrushGallery({
      onSelect: (brush) => this.handlePatternBrushSelect(brush),
      onUpload: () => this.handlePatternImageBtnClick(),
      assetLibrary
    });

    this.colorInputMenu = new ColorInputMenu({
      onColorChange: (rgba) => this.handleColorInputChange(rgba)
    });

    updateStartupStatus('Loading WASM...');
    await withTimeout(initWasm(), WASM_INIT_TIMEOUT_MS, 'WASM failed to load in time');
    updateStartupStatus('Preparing UI...');
    this.ui.init();
    this.ui.applySidebarWidths(this.appPreferences);
    this.createSelf();

    // Wire up WebSocket callbacks now that this.self exists
    this.wsClient.onConnect = (sessionIndex, role, assignedUsername, ipHash, connectData) => this.handleWSConnect(sessionIndex, role, assignedUsername, ipHash, connectData);
    this.wsClient.onConnectResumed = (sessionIndex) => this.handleWSConnectResumed(sessionIndex);
    this.wsClient.onDisconnect = (code, reason) => this.handleWSDisconnect(code, reason);
    this.wsClient.onConnectionInterrupted = (code, reason) => this.handleWSInterrupted(code, reason);

    // Parity client — heartbeats every 30s comparing our stroke fingerprint
    // log to the server's. Pauses while AFK/disconnected. Mismatches surface
    // as a toast (Phase 2: no auto-resync — observe rate first).
    this.parityClient = new ParityClient({
      wsClient: this.wsClient,
      // Pause in _discovery: that connection is a room-browse/bandwidth probe
      // and holds no board, so its stroke log is empty and every heartbeat
      // reports a false desync. (banner/lobby are real drawing rooms — kept on.)
      shouldPause: () => !this.wsClient?.connected || !!this.self?.afk || document.hidden
        || this.currentRoomId === '_discovery' || this.isBackgroundWorkReduced(),
      onMismatch: (diff) => this._handleParityMismatch(diff),
      onOk: () => { this._lastParityOkAt = Date.now(); },
    });
    this.wsClient.parityClient = this.parityClient;
    this.parityPanel = new ParityPanel(this);
    updateStartupStatus('Preparing board...');
    this.board.setUseDesynchronizedBoardContexts(this.appPreferences?.general?.useDesynchronizedBoardContexts);
    this.board.init('#boardContainer');
    this.board.setApp(this);
    this.board.textOverlay?.setOnRemoveBroadcast((id) => {
      this.wsClient?.broadcastTextRemove?.(id);
    });
    this._applyLowPowerPreference();
    this.board.setShowRawPixelsAtHighZoom(this.appPreferences?.general?.showRawPixelsAtHighZoom);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
    this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
    this.ui.setHideOwnLabelZoom(this.appPreferences?.general?.hideOwnLabelAbove150);
    appState.board = this.board;
    appState.appPreferences = this.appPreferences;
    // The replay stack (TimeMachine, tape recorders, timelapse capturer) is the
    // largest thing App depends on and nothing needs it to paint or draw, so it
    // loads in its own chunk. Kicked off here and awaited by every room-entry
    // path via `whenReplayReady()` — see _initReplayStack.
    this._replayReady = this._initReplayStack();
    // Warm the rest of the room set (homography) now too, so it downloads during
    // landing-page idle time instead of being paid for on the join click.
    void this.whenRoomModulesReady();

    // Keeps the tick loop at full rate when the tab is backgrounded so remote
    // strokes rasterize at a consistent cadence across users (see module doc).
    this.backgroundKeepAlive = new BackgroundKeepAlive();

    this._applyReplayPreferences();

    updateStartupStatus('Preparing controls...');
    // Initialize Svelte UI components
    this.svelteComponents = initSvelteUI(this);

    // Legacy components (still vanilla JS)
    // this.chat.init(); // Now Svelte
    // this.colorPalette.init(); // Now Svelte
    this.brushGallery.init();
    this.patternGallery.init();
    this.colorInputMenu.init();

    // Wire color input menu changes to sync with color wheel
    this.colorInputMenu.onColorChange = (rgba) => {
      const hsv = this.rgbToHsv(rgba[0], rgba[1], rgba[2]);
      this._setColorPickersColor(hsv);
    };

    this.initSelfFromUI();
    this.setupColorPicker();

    this.remoteUserHandler = new RemoteUserHandler(this);
    this.touchHandler = new TouchHandler(this);
    this.touchHandler.init(this.ui.elements.boardContainer);
    this.saveMode = new SaveMode(this);
    this.mirrorRegionController = new MirrorRegionController(this);
    this.mirrorRegionController.init();

    // The board owns the mask state and renders the "Stop masking" button, but
    // turning a mask off is the Select tool's job (it also broadcasts SEL_MASK),
    // so the button calls back through here rather than clearing state directly.
    this.board.onStopMasking = () => {
      this.toolManager?.getTool('select')?.toggleMaskMode(false);
    };
    // A surface-window change clears every preview surface. The composite
    // surfaces are rebuilt from the layer stack by the composite the board
    // already scheduled; the tool-owned previews are not, so they are repainted
    // here. See Board._applySurfaceWindow.
    this.board.onSurfaceWindowChange = () => this._repaintLivePreviews();
    this.boardViewer = new BoardViewer(this);
    this.boardViewer.init();

    this.debugOverlay = new DebugOverlay();
    const debugCanvas = document.getElementById('debugOverlay');
    this.debugOverlay.init(debugCanvas, this.board.getWidth(), this.board.getHeight());
    this.debugOverlay.setApp(this);
    this.debugOverlay.setBoard(this.board);

    this.strokeHistoryPanel.init();
    this._bindLayerManagerDependencies();
    this.updateUndoRedoHud();

    this.debugPanel.init();
    this.refreshDebugButton();

    this.ui.setupLayerPreviewListeners(this.board.layerManager);
    this.ui.attachFontChangeListener(this); // Attach font change listener

    // Sync initial app state to Svelte stores
    syncStoresFromApp(this);

    this.syncClient = new SyncClient();
    this.syncClient.init({
      wsClient: this.wsClient,
      board: this.board,
      app: this
    });
    this.syncClient.onSyncComplete = () => {
      console.log('[App] Sync complete');
      this.updateRecordingButtonState();
      // Start (first sync) or re-anchor (resync) the automatic rolling DVR tape.
      // Skip offline mode — there's no shared room history to record.
      if (this.currentRoomId && !this.isOfflineMode) {
        this.rollingTapeRecorder?.onSyncComplete(this);
      }
    };

    updateStartupStatus('Loading account...');
    // Auth and LandingPage were created in auth-landing phase, wire up app callbacks
    if (this.auth) {
      this.auth.onSuccess = (token, role, username, globalRole, roomRole, hasDiscord) => this.handleAuthSuccess(token, role, username, globalRole, roomRole, hasDiscord);
      this.auth.onError = (error) => this.handleAuthError(error);
      this.auth.replayAuthSession?.();
    }

    updateStartupStatus('Loading rooms...');
    if (this.landingPage) {
      this.landingPage.onRoomSelected = (roomId, password, settings) => this.handleRoomSelected(roomId, password, settings);
      this.landingPage.onOffline = () => this.handleOffline();
    }

    // RoomSettings now Svelte component (initialized in initSvelteUI)
    // this.roomSettings = new RoomSettings({...});
    // this.roomSettings.init();

    this.moderation.onProfile = (username) => {
      showProfileDialog(username);
    };
    this.moderation.onSync = (sessionIndex) => {
      this.syncClient.requestSync(sessionIndex);
      this.ui.showToast('Sync requested');
    };
    this.moderation.onSpectate = (sessionIndex) => {
      this.boardViewer?.spectateUser(sessionIndex);
    };
    this.moderation.onPM = (sessionIndex, user) => {
      if (!this.svelteComponents?.chat) return;

      const targetUser = user || this.users.get(sessionIndex);
      if (!targetUser || (targetUser.id === undefined && sessionIndex === undefined)) {
        appState.chatVisible = true;
        return;
      }
      this.svelteComponents.chat.openDM(targetUser.id ?? sessionIndex, targetUser);
    };
    this.moderation.onModAction = (actionType, sessionIndex, reason, duration, ipScope) => {
      this.wsClient.sendModAction(actionType, sessionIndex, reason, duration, ipScope);
    };
    this.moderation.onModUpdateReason = (originalActionCode, sessionIndex, reason) => {
      // Reuse modDuration to carry the original action code so server knows which entry to update
      this.wsClient.sendModAction(5, sessionIndex, reason, originalActionCode);
    };
    this.moderation.onModGroupUpdateReason = (action, ipHash, reason) => {
      const group = this.ui.remoteUserUI.userGroups.get(ipHash);
      if (!group) return;
      const actionCodes = { kick: 0, mute: 1, ban: 2 };
      const actionCode = actionCodes[action];
      group.userIds.forEach(userId => {
        this.wsClient.sendModAction(5, userId, reason, actionCode);
      });
    };
    this.moderation.onRequestModList = ({ showHistory, search } = {}) => {
      this.wsClient.requestModList({ showHistory, search });
    };
    this.moderation.onRevokeEntry = (entryId, entryType, username) => {
      const revokeType = entryType === 'mutes' ? 3 : entryType === 'shadowbans' ? 7 : entryType === 'silences' ? 10 : 4;
      // The moderation entry has no live session index of its own — resolve one
      // from the currently connected users so the server can clear the target's
      // in-memory muted/shadowbanned flag right away, not just the DB record.
      let sessionIndex;
      for (const [idx, u] of this.users) {
        if (u.username === username || u.registeredName === username) {
          sessionIndex = idx;
          break;
        }
      }
      this.wsClient.sendModRevoke(revokeType, entryId, username, sessionIndex);
    };
    this.moderation.onModUpdateDuration = (entryId, minutes) => {
      this.wsClient.sendModUpdateDuration(entryId, minutes);
    };
    this.moderation.onModWipe = (sessionIndex, targetName) => {
      this.wsClient.sendModWipe(sessionIndex, targetName);
    };

    this.moderation.onModGroupAction = (action, ipHash, reason, duration) => {
      const group = this.ui.remoteUserUI.userGroups.get(ipHash);
      if (!group) return;

      const actionCodes = { kick: 0, mute: 1, ban: 2 };
      const actionCode = actionCodes[action];

      console.log(`[Mod] Group action "${action}" on IP group ${ipHash} (${group.userIds.size} users)`);
      
      group.userIds.forEach(userId => {
        if (action === 'wipe') {
          const user = this.users.get(userId);
          this.wsClient.sendModWipe(userId, user?.name || '');
        } else {
          this.wsClient.sendModAction(actionCode, userId, reason, duration);
        }
      });
    };

    this.moderation.onClear = () => this.handleClear();
    this.moderation.onRoomRoleSet = (targetSessionIndex, role) => {
      this.wsClient.sendRoomRoleSet(targetSessionIndex, role);
    };
    this.moderation.onGlobalRoleSet = (targetUsername, newGlobalRole) => {
      this.wsClient.sendGlobalRoleSet(targetUsername, newGlobalRole);
    };

      window.app = this;

      this.setupEventListeners();
      this.mobileLayout.init();
      this.scheduleTopbarCollapseUpdate();
      this.ui.updateTextPositionMultiplierValue(this.self.textPositionMultiplier);
      this.ui.updateTextPositionOffsetValue(this.self.textPositionOffset);
      this.updateAuthenticatedActionVisibility();
    this.updateRecordingButtonState();
    setupWebSocketHandlers(this);

    const initialTool = this.brushModeManager.getCurrentToolName();
    this.applyCursorStyleForTool(initialTool);
    this.self.setTool(initialTool);
    this.toolManager.setTool(initialTool);
    this.ui.updateToolDisplay(initialTool, this.self);
    this.ui.updateActiveLayerDisplay(this.self.activeLayer);
    this.ui.updateBlurToolState(this.self.activeLayer);
    this.ui.updateBlendModeForLayer(
      this.board.layerManager.getLayerAllowComplexBlendModes(this.self.activeLayer)
    );

    if (this.toolLockManager.toolLocks[initialTool]) {
      this.toolLockManager.restoreToolValues(initialTool);
      this.toolLockManager.updateAllLockButtons(initialTool);
    }

    this.connectForRoomDiscovery();
  }

  /**
   * Creates the local user instance.
   */
  createSelf() {
    // `board` must be the surface `context` draws onto, the way it is for every
    // remote user — not viewCanvas. Everything that reads `user.board` treats
    // it as that user's preview canvas: it sets opacity and mix-blend-mode on
    // it, hands it to userLayerPresence to hide and to collapse to 1x1, and
    // draws it as a source in replay. Pointing it at the shared display surface
    // meant any of those reaching the local user would have blanked the board.
    this.self = new User(0, {
      context: this.board.topCtx,
      board: this.board.topCanvas
    });
    this.applyCursorStyleForTool(this.self.tool);

    this._migrateLegacyTextFontSettings();
    this._migrateTextFontPresetDefaults();
    this._applyStoredTextFontSettings(this.self.font);
  }

  _getStoredTextFontSettings() {
    try {
      const rawSettings = localStorage.getItem(TEXT_FONT_SETTINGS_STORAGE_KEY);
      if (!rawSettings) return {};

      const parsedSettings = JSON.parse(rawSettings);
      return parsedSettings && typeof parsedSettings === 'object' ? parsedSettings : {};
    } catch {
      return {};
    }
  }

  _getResolvedTextFontSettings(font) {
    const normalizedFont = normalizeTextFont(font);
    const defaults = getTextFontDefaults(normalizedFont);
    const storedSettings = this._getStoredTextFontSettings()[normalizedFont];

    return {
      font: normalizedFont,
      textPositionMultiplier: Number(storedSettings?.textPositionMultiplier ?? defaults.textPositionMultiplier),
      textPositionOffset: Number(storedSettings?.textPositionOffset ?? defaults.textPositionOffset)
    };
  }

  _applyStoredTextFontSettings(font) {
    const settings = this._getResolvedTextFontSettings(font);
    this.self.setTextPositionMultiplier(settings.textPositionMultiplier);
    this.self.setTextPositionOffset(settings.textPositionOffset);
  }

  _saveTextFontSettings(font = this.self?.font) {
    if (!font || !this.self) return;

    const normalizedFont = normalizeTextFont(font);
    const settings = this._getStoredTextFontSettings();
    settings[normalizedFont] = {
      textPositionMultiplier: this.self.textPositionMultiplier,
      textPositionOffset: this.self.textPositionOffset
    };

    localStorage.setItem(TEXT_FONT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  _migrateLegacyTextFontSettings() {
    const legacyMultiplier = localStorage.getItem('topDrawTextPositionMultiplier');
    const legacyOffset = localStorage.getItem('topDrawTextPositionOffset');

    if (legacyMultiplier === null && legacyOffset === null) return;

    let textPositionMultiplier = Number(legacyMultiplier);
    let textPositionOffset = Number(legacyOffset);

    if (!Number.isFinite(textPositionMultiplier)) {
      textPositionMultiplier = getTextFontDefaults(this.self.font).textPositionMultiplier;
    }

    if (!Number.isFinite(textPositionOffset)) {
      textPositionOffset = getTextFontDefaults(this.self.font).textPositionOffset;
    }

    // Migrate the old absolute-baseline defaults to the new correction-based defaults.
    if (textPositionMultiplier === 0.66 && textPositionOffset === -3) {
      textPositionMultiplier = 0;
      textPositionOffset = 0;
    }

    const settings = this._getStoredTextFontSettings();
    const normalizedFont = normalizeTextFont(this.self.font);
    if (!settings[normalizedFont]) {
      settings[normalizedFont] = {
        textPositionMultiplier,
        textPositionOffset
      };
      localStorage.setItem(TEXT_FONT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }

    localStorage.removeItem('topDrawTextPositionMultiplier');
    localStorage.removeItem('topDrawTextPositionOffset');
  }

  _migrateTextFontPresetDefaults() {
    const settings = this._getStoredTextFontSettings();
    const tangerineSettings = settings['Tangerine, cursive'];
    if (!tangerineSettings) return;

    // Tangerine ended up sitting correctly with neutral applied correction.
    // If a user still has the old baked-in preset, update it once without
    // touching any custom tuning they may have already made.
    if (Number(tangerineSettings.textPositionMultiplier) === 0.25 && Number(tangerineSettings.textPositionOffset) === 0) {
      settings['Tangerine, cursive'] = {
        textPositionMultiplier: 0,
        textPositionOffset: 0
      };
      localStorage.setItem(TEXT_FONT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }
  }

  /**
   * Initializes self's settings from UI slider values.
   */
  initSelfFromUI() {
    const { elements } = this.ui;

    if (elements.smoothingSlider) {
      const smoothing = Number(elements.smoothingSlider.value);
      this.self.setSmoothing(smoothing);
    }

    if (elements.sizeSlider) {
      const size = Number(elements.sizeSlider.value);
      this.self.setSize(size);
    }

    if (elements.spacingSlider) {
      const spacing = Number(elements.spacingSlider.value);
      this.self.setSpacing(spacing);
    }

    if (elements.pressureMaxSlider) {
      const pressure = Number(elements.pressureMaxSlider.value) / 100;
      this.self.setPressure(pressure);
    }

    if (elements.blurRadiusSlider) {
      this.self.setBlurRadius(this.clampBlurRadiusForTool(Number(elements.blurRadiusSlider.value)));
    }

    if (elements.hardnessSlider) {
      this.self.setHardness(Number(elements.hardnessSlider.value));
    }

    // Load thinning (simulate pressure) preference from localStorage
    const savedSimulatePressure = localStorage.getItem('topDrawSimulatePressure');
    if (savedSimulatePressure !== null) {
      const simulate = savedSimulatePressure === 'true';
      this.self.setSimulatePressure(simulate);
      this.ui.updateSimulatePressure(simulate);
    }

    const savedShapeDrawMode = localStorage.getItem(SHAPE_DRAW_MODE_STORAGE_KEY);
    this.applyShapeDrawMode(savedShapeDrawMode, { broadcast: false, persist: false });
  }

  /**
   * Sets up the color picker component.
   */
  // --- Color system delegates (implementation in ui/ColorController.js) ---

  get colorPicker() { return this.colorController.colorPicker; }
  get colorPickers() { return this.colorController.colorPickers; }
  get primaryColor() { return this.colorController.primaryColor; }
  get secondaryColor() { return this.colorController.secondaryColor; }
  get activeColorSlot() { return this.colorController.activeColorSlot; }

  setupColorPicker() { this.colorController.setupColorPicker(); }
  _setColorPickersColor(value, options) { this.colorController._setColorPickersColor(value, options); }
  selectColorSlot(slot) { this.colorController.selectColorSlot(slot); }
  swapColorSlots() { this.colorController.swapColorSlots(); }
  handlePaletteColorSelect(colorOrCallback) { this.colorController.handlePaletteColorSelect(colorOrCallback); }
  handleColorInputChange(rgba) { this.colorController.handleColorInputChange(rgba); }
  hsvToRgb(h, s, v) { return this.colorController.hsvToRgb(h, s, v); }
  rgbToHsv(r, g, b) { return this.colorController.rgbToHsv(r, g, b); }

  setupToolGroupMenus() {
    const groups = Array.from(document.querySelectorAll('.toolGroup'));
    const rail = document.querySelector('.tools');
    if (!rail) return;

    const closeGroups = (except = null) => {
      for (const group of groups) {
        if (group === except) continue;
        group.classList.remove('is-open');
        group.classList.remove('is-suppressed');
      }
    };

    for (const group of groups) {
      const subgroup = group.querySelector('.toolSubgroup');
      if (!subgroup) continue;

      // The flyout is a child of the rail, so once the rail clips (mobile, or
      // the .is-scrollable last-resort stage) an absolutely positioned flyout
      // is swallowed by that clipping box. Re-anchor it as fixed whenever the
      // rail clips, right before it becomes visible.
      group.addEventListener('pointerenter', () => this._positionToolFlyout(group));

      group.addEventListener('pointerdown', (event) => {
        this._positionToolFlyout(group);
        group.dataset.wasOpenOnPress = group.classList.contains('is-open') ? 'true' : 'false';
        group.classList.remove('is-suppressed');
        closeGroups(group);
        if (event.pointerType !== 'mouse') {
          group.classList.add('is-open');
        }
      });

      group.addEventListener('click', (event) => {
        const clickedSubgroupTool = event.target.closest('.toolSubgroup .tool.btn');
        const clickedPrimaryTool = event.target.closest('.toolGroup > .tool.btn');
        if (clickedSubgroupTool || (clickedPrimaryTool && group.dataset.wasOpenOnPress === 'true')) {
          closeGroups();
          group.classList.add('is-suppressed');
        }
      });

      group.addEventListener('pointerleave', () => {
        group.classList.remove('is-suppressed');
      });
    }

    document.addEventListener('pointerdown', (event) => {
      const path = event.composedPath?.() ?? [];
      const insideToolGroup = path.some((node) => node instanceof Element && node.classList?.contains('toolGroup'));
      if (!insideToolGroup) {
        closeGroups();
      }
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeGroups();
    });

    // A scrolled rail invalidates every open flyout's fixed position, and the
    // pointer is nowhere near the group it started over.
    rail.addEventListener('scroll', () => closeGroups(), { passive: true });

    window.addEventListener('resize', () => this.scheduleToolRailCollapseUpdate());

    // The rail also changes height when the sidebar does (chat, board menu,
    // fullscreen) and changes width when the tools resizer is dragged, which
    // changes --tool-btn-size and therefore the height it needs.
    if (typeof ResizeObserver !== 'undefined') {
      this._toolRailResizeObserver = new ResizeObserver(() => {
        this.scheduleToolRailCollapseUpdate();
      });
      this._toolRailResizeObserver.observe(rail);
    }

    this.scheduleToolRailCollapseUpdate();
  }

  /**
   * Anchor a collapsed group's flyout with position: fixed while the rail is
   * clipping its overflow, so the flyout escapes the clipping box. Reverts to
   * the stylesheet's absolute positioning as soon as the rail stops clipping.
   *
   * @param {HTMLElement} group
   */
  _positionToolFlyout(group) {
    const subgroup = group?.querySelector?.('.toolSubgroup');
    if (!subgroup) return;

    const rail = group.closest('.tools');
    const railStyle = rail ? window.getComputedStyle(rail) : null;
    const clips = !!railStyle && (railStyle.overflowY !== 'visible' || railStyle.overflowX !== 'visible');

    if (!clips) {
      subgroup.style.removeProperty('position');
      subgroup.style.removeProperty('top');
      subgroup.style.removeProperty('left');
      subgroup.style.removeProperty('right');
      return;
    }

    const primary = group.querySelector(':scope > .tool.btn') || group;
    const rect = primary.getBoundingClientRect();

    // The flyout is display:none until it opens, so it can't be measured —
    // estimate from the primary button, which is the same size as every
    // button inside it.
    const count = subgroup.querySelectorAll('.tool.btn').length || 1;
    const estimatedHeight = count * rect.height + (count - 1) * 4 + 10;
    const top = Math.max(4, Math.min(rect.top - 5, window.innerHeight - estimatedHeight - 4));

    subgroup.style.position = 'fixed';
    subgroup.style.top = `${top}px`;

    if (document.documentElement.dataset.sidebarSide === 'left') {
      subgroup.style.left = `${rect.right}px`;
      subgroup.style.right = 'auto';
    } else {
      subgroup.style.right = `${window.innerWidth - rect.left}px`;
      subgroup.style.left = 'auto';
    }
  }

  scheduleToolRailCollapseUpdate() {
    if (this._toolRailCollapseFrame) return;

    this._toolRailCollapseFrame = requestAnimationFrame(() => {
      this._toolRailCollapseFrame = null;
      this.updateToolRailCollapseState();
    });
  }

  /**
   * Collapse the tool rail one stage at a time until it fits its own height.
   *
   * Replaces the old fixed max-height media queries, which keyed off the
   * viewport rather than the rail and so both over- and under-collapsed. The
   * final stage makes the rail scrollable, which is what guarantees no tool
   * can ever be cut off no matter how short the screen is.
   */
  updateToolRailCollapseState() {
    // Mobile collapses every group unconditionally via CSS and needs its 44px
    // touch targets kept — the compact stages would undo both.
    if (isMobile()) return;

    const rail = document.querySelector('.tools');
    if (!rail) return;

    const previous = TOOL_RAIL_COLLAPSE_STAGES.filter(stage => rail.classList.contains(stage));
    rail.classList.remove(...TOOL_RAIL_COLLAPSE_STAGES, 'is-scrollable');

    const isOverflowing = () => rail.scrollHeight - rail.clientHeight > 1;

    for (const stage of TOOL_RAIL_COLLAPSE_STAGES) {
      if (!isOverflowing()) break;
      rail.classList.add(stage);
    }

    if (isOverflowing()) {
      rail.classList.add('is-scrollable');
    }

    // Collapsing a group turns its subgroup into a flyout, which changes which
    // icon the primary button has to render.
    const changed = previous.length !== TOOL_RAIL_COLLAPSE_STAGES.filter(stage => rail.classList.contains(stage)).length;
    if (changed) {
      this.ui?.updateToolButton?.(this.self?.tool);
    }
  }

  getToolGroupActiveTool(groupId, fallbackTool) {
    const group = document.getElementById(groupId);
    if (!this.isToolGroupCollapsed(group)) return fallbackTool;
    return group?.dataset.activeTool || fallbackTool;
  }

  getRenderedTool(button, fallbackTool) {
    const group = button?.closest?.('.toolGroup');
    if (group && !this.isToolGroupCollapsed(group)) return fallbackTool;
    return button?.dataset.tool || fallbackTool;
  }

  isToolGroupCollapsed(group) {
    const subgroup = group?.querySelector?.('.toolSubgroup');
    if (!subgroup) return false;
    // 'fixed' as well as 'absolute': _positionToolFlyout re-anchors the flyout
    // when the rail clips. Expanded subgroups are static.
    return window.getComputedStyle(subgroup).position !== 'static';
  }

  /**
   * Sets up global event listeners for UI and board interactions.
   */
  setupEventListeners() {
    const { elements } = this.ui;
    this._ensureUserContextMenu();

    document.addEventListener('keydown', this._boundSuppressButtonKeyboardActivation, true);
    document.addEventListener('keyup', this._boundSuppressButtonKeyboardActivation, true);

    // Blur buttons/checkboxes after click so they don't capture keyboard focus (Space key, Ctrl+Z, etc)
    document.addEventListener('click', (e) => {
      const el = e.target.closest('button, [role="button"], input[type="checkbox"]');
      if (el) {
        setTimeout(() => el.blur(), 0);
      }
    }, true);

    // Also blur selects on change so keyboard-selected options don't keep focus trapped.
    document.addEventListener('change', (e) => {
      const select = e.target instanceof Element ? e.target.closest('select') : null;
      if (select) {
        setTimeout(() => select.blur(), 0);
      }
    }, true);

    // Form submit triggers join (both logged-in and not-logged-in join buttons are type="submit")
    elements.loginForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleJoin();
    });

    elements.disconnectBtn.addEventListener('click', () => this.disconnect());
    elements.roomsBtn?.addEventListener('click', () => this.openRoomsBrowser());
    if (elements.recordBtn) {
      elements.recordBtn.addEventListener('click', () => this.handleStartRecording());
    }
    if (elements.tapeRecBtn) {
      // The record button now opens the mini recorder viewer; the Start/Stop
      // control lives inside that panel (RecorderPanel.svelte) which calls
      // handleToggleTapeRecording.
      elements.tapeRecBtn.addEventListener('click', () => toggleRecorderPanel());
    }

    // Disconnection banner buttons
    if (elements.retryConnectionBtn) {
      elements.retryConnectionBtn.addEventListener('click', () => this.handleRetryConnection());
    }
    if (elements.switchToOfflineBtn) {
      elements.switchToOfflineBtn.addEventListener('click', () => this.handleSwitchToOffline());
    }

    if (elements.menuBtn) {
      bindPressAction(elements.menuBtn, (e) => {
        e.stopPropagation();
        this.ui.toggleMenu();
      });
    }

    if (elements.sidebarToggleBtn) {
      elements.sidebarToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.ui.toggleSidebar();
        // Recalculate view after the sidebar transition finishes (approx 300ms)
        setTimeout(() => this.board.calculateDefaultView(), 350);
      });
    }

    if (elements.fullscreenBtn) {
      if (isTauriDesktop()) {
        elements.fullscreenBtn.style.display = 'none';
      } else {
        elements.fullscreenBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            if (document.fullscreenElement) {
              await document.exitFullscreen();
            } else {
              await document.documentElement.requestFullscreen();
            }
          } catch (err) {
            console.warn('[App] Fullscreen toggle failed:', err);
          }
        });

        // Reflect the actual state — fullscreen can also be entered or left
        // with F11 or Esc, which never reaches the click handler.
        document.addEventListener('fullscreenchange', () => {
          const isFullscreen = !!document.fullscreenElement;
          elements.fullscreenBtn.classList.toggle('is-fullscreen', isFullscreen);
          elements.fullscreenBtn.title = isFullscreen ? 'Exit fullscreen (F11)' : 'Fullscreen (F11)';
        });
      }
    }

    this.setupToolGroupMenus();

    elements.panBtn.addEventListener('click', () => this.selectTool(this.getToolGroupActiveTool('moveGroup', 'pan')));
    elements.zoomBtn.addEventListener('click', () => this.selectTool(this.getRenderedTool(elements.zoomBtn, 'zoom')));
    elements.rotateBtn.addEventListener('click', () => this.selectTool(this.getRenderedTool(elements.rotateBtn, 'rotate')));
    elements.selectBtn.addEventListener('click', () => this.selectTool('select'));
    const setBrushMode = (tool) => this.brushModeManager.setMode(BrushModeManager._toolNameToMode(tool));
    elements.brushBtn.addEventListener('click', () => setBrushMode(this.getToolGroupActiveTool('brushGroup', 'ink')));
    elements.classicBrushBtn.addEventListener('click', () => setBrushMode(this.getRenderedTool(elements.classicBrushBtn, 'brush')));
    elements.penBtn.addEventListener('click', () => setBrushMode(this.getRenderedTool(elements.penBtn, 'flowPen')));
    elements.pixelBrushBtn.addEventListener('click', () => setBrushMode(this.getRenderedTool(elements.pixelBrushBtn, 'pixel')));
    elements.rectangleBtn.addEventListener('click', () => this.selectTool(this.getToolGroupActiveTool('shapesGroup', 'rectangle')));
    elements.lineBtn.addEventListener('click', () => this.selectTool(this.getRenderedTool(elements.lineBtn, 'line')));
    elements.circleBtn.addEventListener('click', () => this.selectTool(this.getRenderedTool(elements.circleBtn, 'circle')));
    elements.textBtn.addEventListener('click', () => this.selectTool('text'));
    elements.fillBtn.addEventListener('click', () => this.selectTool('fill'));
    elements.eraseBtn.addEventListener('click', () => this.selectTool('erase'));
    elements.blurBtn.addEventListener('click', () => this.selectTool(this.getToolGroupActiveTool('blurGroup', 'blur')));
    elements.circleBlurBtn.addEventListener('click', () => this.selectTool(this.getRenderedTool(elements.circleBlurBtn, 'circleBlur')));
    elements.glitchBlurBtn.addEventListener('click', () => this.selectTool(this.getRenderedTool(elements.glitchBlurBtn, 'glitchBlur')));
    elements.imageBrushBtn.addEventListener('click', () => this.selectTool('imageBrush'));
    if (elements.confettiBtn) {
      elements.confettiBtn.addEventListener('click', () => this.selectTool('confetti'));
    }
    if (elements.patternBtn) {
      elements.patternBtn.addEventListener('click', () => this.selectTool('pattern'));
    }
    elements.uploadBtn.addEventListener('click', async () => {
      if (!this.canUseImageFeatures(true)) return;
      if (isTauriDesktop()) {
        try {
          const selectedImage = await openImageViaNativeDialog();
          if (selectedImage?.dataUrl) {
            this.handleImageDataUrl(selectedImage.dataUrl);
          }
        } catch (error) {
          console.error('[Desktop] Native image import failed:', error);
          this.ui.showToast('Image picker failed, falling back to browser upload', 3000, 'error');
          elements.imageUploadInput.click();
        }
        return;
      }

      elements.imageUploadInput.click();
    });
    elements.imageUploadInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.handleImageFile(e.target.files[0]);
      }
    });
    elements.inkdropperBtn.addEventListener('click', () => this.selectTool('inkdropper'));

    // Clear/Dev/Perf/Mod buttons + mod panel are injected dynamically by
    // Moderation._injectModUI() when the user's role is confirmed as mod+.
    // Their event listeners are wired there, not here.

    if (elements.resetBtn) bindPressAction(elements.resetBtn, () => this.handleResetBoard());
    bindPressAction(elements.zoomResetBtn || elements.zoomPercent, () => this.handleResetBoard());
    bindPressAction(elements.flipCanvasBtn, () => this.handleToggleCanvasFlip());
    bindPressAction(elements.mirrorBtn, () => this.handleToggleMirror());
    if (elements.undoBtn) elements.undoBtn.addEventListener('click', () => this.handleUndo());
    elements.plusBtn.addEventListener('click', () => this.handleZoomIn());
    elements.minusBtn.addEventListener('click', () => this.handleZoomOut());
    elements.saveBtn.addEventListener('click', () => {
      if (appState.snapshotMenuVisible && this.snapshotPreviewCanvas) {
        this.openSaveDialogForCanvas(this.snapshotPreviewCanvas);
        return;
      }
      this.openSaveDialog();
    });
    if (elements.saveModeCloseBtn) elements.saveModeCloseBtn.addEventListener('click', () => this.closeSaveDialog());
    if (elements.saveModeCancelBtn) elements.saveModeCancelBtn.addEventListener('click', () => this.closeSaveDialog());
    if (elements.saveModeOverlay) elements.saveModeOverlay.addEventListener('click', (e) => {
      if (e.target === elements.saveModeOverlay) this.closeSaveDialog();
    });
    if (elements.saveLocallyBtn) elements.saveLocallyBtn.addEventListener('click', () => this.performSave(true));
    if (elements.saveToGalleryBtn) elements.saveToGalleryBtn.addEventListener('click', () => this.performSave(false));

    // Undo/Redo HUD buttons
    if (elements.hudUndoBtn) elements.hudUndoBtn.addEventListener('click', () => this.handleUndo());
    if (elements.hudRedoBtn) elements.hudRedoBtn.addEventListener('click', () => this.handleRedo());

    elements.chatBtn.addEventListener('click', () => {
      if (focusChatPopout()) return;
      appState.chatVisible = !appState.chatVisible;
      if (appState.chatVisible) appState.chatUnreadCount = 0;
    });
    if (elements.adminTopBtn) {
      elements.adminTopBtn.addEventListener('click', () => {
        if (this.selfRole < 9) return;
        appState.adminPanelVisible = true;
      });
    }
    elements.inboxBtn.addEventListener('click', () => {
      if (this.selfRole < 1) return;
      appState.messengerVisible = !appState.messengerVisible;
    });
    // Flip to true once Stripe is fully configured (keys, prices, webhook).
    const SUPPORTER_PURCHASES_ENABLED = false;
    const landingSupportBtn = document.getElementById('landingSupportBtn');
    if (SUPPORTER_PURCHASES_ENABLED) {
      if (elements.supportBtn) {
        elements.supportBtn.addEventListener('click', () => supporterDialog.show());
      }
      landingSupportBtn?.addEventListener('click', () => supporterDialog.show());
      supporterDialog.handleCheckoutReturn();
    } else {
      // Hide support buttons entirely until supporter purchases are ready.
      [elements.supportBtn, landingSupportBtn].forEach(btn => {
        if (!btn) return;
        btn.style.display = 'none';
      });
    }

    this.ensureAppSettingsButton();
    const appSettingsBtn = document.getElementById('appSettingsBtn');
    if (appSettingsBtn) {
      appSettingsBtn.addEventListener('click', () => this.handleAppSettings());
    }
    this.scheduleTopbarCollapseUpdate();

    // Room settings button
    const roomSettingsBtn = document.getElementById('roomSettingsBtn');
    if (roomSettingsBtn) {
      roomSettingsBtn.addEventListener('click', () => this.handleRoomSettings());
    }

    // Register room button
    const registerRoomBtn = document.getElementById('registerRoomBtn');
    if (registerRoomBtn) {
      registerRoomBtn.addEventListener('click', () => this.handleRegisterRoom());
    }

    // Context menu button clicks
    if (elements.userContextMenu) {
      elements.userContextMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('.menuItem');
        if (btn) {
          this.moderation.handleMenuAction(btn.dataset.action, btn.dataset);
        }
      });
    }

    // Right-click on user list entries for context menu
    elements.userList.addEventListener('contextmenu', (e) => {
      const entry = e.target.closest('.userEntry');
      if (!entry) return;

      // Self entry — show self context menu with role info
      if (entry.classList.contains('self')) {
        e.preventDefault();
        e.stopPropagation();
        this._showSelfContextMenu(e);
        return;
      }

      if (entry.dataset.sessionIndex) {
        const sessionIndex = Number(entry.dataset.sessionIndex);
        const user = this.users.get(sessionIndex);
        this.moderation.showContextMenu(e, sessionIndex, user);
      }
    });

    // Click-outside to close context menu and mobile menu
    document.addEventListener('click', (e) => {
      const selfMenu = document.getElementById('selfContextMenu');
      if (selfMenu && !selfMenu.contains(e.target)) {
        selfMenu.style.display = 'none';
      }
      if (elements.userContextMenu && !elements.userContextMenu.contains(e.target)) {
        this.moderation.hideContextMenu();
      }
      if (elements.collapsibleBtns && !elements.collapsibleBtns.contains(e.target) && !elements.menuBtn.contains(e.target)) {
        this.ui.closeMenu();
      }
    });

    elements.sizeSlider.addEventListener('input', (e) => this.handleSizeChange(e));

    elements.spacingSlider.addEventListener('input', (e) => this.handleSpacingChange(e));
    elements.smoothingSlider.addEventListener('input', (e) => this.handleSmoothingChange(e));
    elements.hardnessSlider.addEventListener('input', (e) => this.handleHardnessChange(e));
    elements.opacitySlider.addEventListener('input', (e) => this.handleOpacityChange(e));
    if (elements.blurRadiusSlider) {
      elements.blurRadiusSlider.addEventListener('input', (e) => this.handleBlurRadiusChange(e));
    }

    elements.brushFileInput.addEventListener('change', (e) => this.handleBrushFileLoad(e));

    if (elements.thinningSlider) {
      elements.thinningSlider.addEventListener('input', (e) => this.handleThinningChange(e));
      elements.thinningSlider.style.setProperty('--value', elements.thinningSlider.value);
    }
    if (elements.simulatePressureCheckbox) {
      elements.simulatePressureCheckbox.addEventListener('change', (e) => this.handleSimulatePressureChange(e));
    }

    // Dual pressure slider handlers
    const clampPressureSliders = () => {
      const minVal = Number(elements.pressureMinSlider.value);
      const maxVal = Number(elements.pressureMaxSlider.value);
      if (minVal > maxVal) {
        elements.pressureMinSlider.value = maxVal;
      }
      this.ui.updatePressureValue(
        Number(elements.pressureMinSlider.value),
        Number(elements.pressureMaxSlider.value)
      );
      this.clearActiveCustomPreset();
      this.updateCurrentToolPresetSettings();
    };
    elements.pressureMinSlider.addEventListener('input', clampPressureSliders);
    elements.pressureMaxSlider.addEventListener('input', clampPressureSliders);

    // Pressure enable/disable checkbox
    elements.pressureEnabled.addEventListener('change', () => {
      this.pressureEnabled = elements.pressureEnabled.checked;
      this.ui.setPressureTrackVisible(this.pressureEnabled);
      this.clearActiveCustomPreset();
      this.updateCurrentToolPresetSettings();
    });

    // What pressure drives: size / opacity / hardness checkboxes
    for (const input of elements.pressureTargetInputs || []) {
      input.addEventListener('change', () => {
        this.handlePressureTargetsChange();
        this.clearActiveCustomPreset();
        this.updateCurrentToolPresetSettings();
      });
    }

    // Glitch-blur "Fast preview" toggle — defer the heavy WASM render to release.
    if (elements.glitchFastPreview) {
      elements.glitchFastPreview.addEventListener('change', () => {
        this.glitchFastPreview = elements.glitchFastPreview.checked;
      });
    }

    // Thinning enable/disable checkbox
    if (elements.thinningEnabled) {
      elements.thinningEnabled.addEventListener('change', (e) => {
        // Update visibility
        this.ui.setThinningTrackVisible(elements.thinningEnabled.checked);
        // Update simulate pressure state
        const simulate = e.target.checked;
        this.self.setSimulatePressure(simulate);
        localStorage.setItem('topDrawSimulatePressure', simulate);
        if (this.connected) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSimulatePressureChange(simulate));
        }
        this.updateCurrentToolPresetSettings();
        this.updateActiveToolPreview();
      });
    }

    // Eraser mode radio buttons
    const eraserModeRadios = document.querySelectorAll('input[name="eraserMode"]');
    eraserModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.eraseAllLayers = (e.target.value === 'all');
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastEraserModeChange(this.eraseAllLayers, this.self.tool));
      });
    });

    // Shape draw mode radio buttons
    const shapeDrawModeRadios = document.querySelectorAll('input[name="shapeDrawMode"]');
    shapeDrawModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.applyShapeDrawMode(e.target.value, { broadcast: true, persist: true });
      });
    });


    // Fill advanced mode checkbox
    const fillAdvancedCheck = document.getElementById('fillAdvancedCheck');
    const fillAdvancedSettings = document.getElementById('fillAdvancedSettings');
    if (fillAdvancedCheck) {
      // Sync checkbox to tool's default (advanced on by default)
      const fillTool = this.toolManager.getTool('fill');
      if (fillTool) {
        fillAdvancedCheck.checked = fillTool.advancedMode;
        if (fillAdvancedSettings) fillAdvancedSettings.style.display = fillTool.advancedMode ? 'block' : 'none';
      }
      fillAdvancedCheck.addEventListener('change', (e) => {
        const fillTool = this.toolManager.getTool('fill');
        if (fillTool) fillTool.advancedMode = e.target.checked; // setter resets values when disabled
        if (fillAdvancedSettings) fillAdvancedSettings.style.display = e.target.checked ? 'block' : 'none';
      });
    }

    // Fill advanced sliders
    const fillExpansionSlider = document.getElementById('fillExpansionSlider');
    const fillExpansionValue = document.getElementById('fillExpansionValue');
    if (fillExpansionSlider) {
      fillExpansionSlider.addEventListener('input', (e) => {
        const fillTool = this.toolManager.getTool('fill');
        const val = Math.round(Number(e.target.value) * 10) / 10;
        if (fillTool) fillTool._expansion = val;
        if (fillExpansionValue) fillExpansionValue.textContent = val;
      });
    }
    const fillBlurSlider = document.getElementById('fillBlurSlider');
    const fillBlurValue = document.getElementById('fillBlurValue');
    if (fillBlurSlider) {
      fillBlurSlider.addEventListener('input', (e) => {
        const fillTool = this.toolManager.getTool('fill');
        const val = Math.round(Number(e.target.value) * 10) / 10;
        if (fillTool) fillTool._blurRadius = val;
        if (fillBlurValue) fillBlurValue.textContent = val.toFixed(1);
      });
    }

    // Fill pattern mode checkbox
    const fillPatternCheck = document.getElementById('fillPatternCheck');
    const fillPatternSettings = document.getElementById('fillPatternSettings');
    if (fillPatternCheck) {
      const fillTool = this.toolManager.getTool('fill');
      if (fillTool) {
        fillPatternCheck.checked = fillTool.patternMode || false;
        if (fillPatternSettings) fillPatternSettings.style.display = fillTool.patternMode ? 'block' : 'none';
        appState.fillPatternEnabled = !!fillTool.patternMode;
      }
      fillPatternCheck.addEventListener('change', (e) => {
        const fillTool = this.toolManager.getTool('fill');
        if (fillTool) fillTool.patternMode = e.target.checked;
        if (fillPatternSettings) fillPatternSettings.style.display = e.target.checked ? 'block' : 'none';
        appState.fillPatternEnabled = e.target.checked;

        this.self.patternMode = e.target.checked;
        if (this.connected && this.wsClient) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternMode(e.target.checked));
        }

        appState.toolPreviewVisible = e.target.checked;
        if (e.target.checked) {
          appState.toolPreviewMode = 'pattern';
          this.updatePatternPreviewIfVisible();
        }
      });
    }

    // Selection pattern mode checkbox
    const selectionPatternCheck = document.getElementById('selectionPatternCheck');
    const selectionPatternSettings = document.getElementById('selectionPatternSettings');
    if (selectionPatternCheck) {
      const selectTool = this.toolManager.getTool('select');
      if (selectTool) {
        selectionPatternCheck.checked = selectTool.patternMode || false;
        if (selectionPatternSettings) selectionPatternSettings.style.display = selectTool.patternMode ? 'block' : 'none';
        appState.selectionPatternEnabled = !!selectTool.patternMode;
      }
      selectionPatternCheck.addEventListener('change', (e) => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) selectTool.patternMode = e.target.checked;
        if (selectionPatternSettings) selectionPatternSettings.style.display = e.target.checked ? 'block' : 'none';
        appState.selectionPatternEnabled = e.target.checked;

        // Sync pattern mode to user object and broadcast
        this.self.patternMode = e.target.checked;
        if (this.connected && this.wsClient) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternMode(e.target.checked));
        }

        // Show/hide pattern preview window
        appState.toolPreviewVisible = e.target.checked;

        // Update preview if pattern tool exists
        if (e.target.checked) {
          appState.toolPreviewMode = 'pattern';
          this.updatePatternPreviewIfVisible();
        }
      });
    }

    // Blend mode select
    if (elements.blendModeSelect) {
      elements.blendModeSelect.addEventListener('change', (e) => {
        // Only handle user-initiated changes, not programmatic updates
        if (!this.ui._updatingBlendMode) {
          this.handleBlendModeChange(e.target.value);
        }
      });
    }

    // Layer selection buttons
    const layerButtons = document.querySelectorAll('.layerButton');
    layerButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const layerIndex = parseInt(btn.dataset.layer);
        this.handleLayerSelect(layerIndex);
      });
    });

    // Layer visibility toggles
    const layerVisibilityButtons = document.querySelectorAll('.layerVisibility');
    layerVisibilityButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const layerIndex = parseInt(btn.dataset.layer);
        const visible = this.handleLayerVisibilityToggle(layerIndex);
        btn.classList.toggle('is-hidden', !visible);
      });
    });

    // Editable slider values
    this.ui.makeValueEditable(elements.sizeValue, {
      min: 0.25, max: 100, step: 0.25, suffix: '',
      onCommit: (val) => {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSizeChange(val));
        if (this.self.mousedown && this.self.tool === 'brush') {
          this.commitSelfLine(this.self.pressure, val);
        }
        this.self.setSize(val);
        elements.sizeSlider.value = val;
        this.ui.updateCursorSize(val);
        this.ui.updateSelfTextStyle(val, this.self.color, this.self.font);
        this.board.viewCtx.lineWidth = val * 2;
      }
    });

    // Keeping the text tuning controls dormant for now.
    // if (elements.textPositionMultiplierSlider) {
    //   elements.textPositionMultiplierSlider.addEventListener('input', (e) => {
    //     this.handleTextPositionMultiplierChange(Number(e.target.value));
    //   });
    //   this.ui.makeValueEditable(elements.textPositionMultiplierValue, {
    //     min: -1,
    //     max: 1,
    //     step: 0.01,
    //     suffix: '',
    //     onCommit: (val) => this.handleTextPositionMultiplierChange(val)
    //   });
    // }

    // if (elements.textPositionOffsetSlider) {
    //   elements.textPositionOffsetSlider.addEventListener('input', (e) => {
    //     this.handleTextPositionOffsetChange(Number(e.target.value));
    //   });
    //   this.ui.makeValueEditable(elements.textPositionOffsetValue, {
    //     min: -20,
    //     max: 20,
    //     step: 0.25,
    //     suffix: '',
    //     onCommit: (val) => this.handleTextPositionOffsetChange(val)
    //   });
    // }

    this.ui.makeValueEditable(elements.smoothingValue, {
      min: 0, max: 50, step: 1, suffix: '',
      onCommit: (val) => {
        this.self.setSmoothing(val);
        elements.smoothingSlider.value = val;
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSmoothingChange(val));
      }
    });

    this.ui.makeValueEditable(elements.spacingValue, {
      min: 0, max: 50, step: 1, suffix: '',
      onCommit: (val) => {
        const spacing = Math.round(val);
        this.self.setSpacing(spacing);
        elements.spacingSlider.value = spacing;
        this.ui.updateSpacingValue(spacing);
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSpacingChange(spacing));
        this.updateCurrentToolPresetSettings();
        this.updateActiveToolPreview();
      }
    });

    this.ui.makeValueEditable(elements.hardnessValue, {
      min: 0, max: 100, step: 1, suffix: '',
      onCommit: (val) => {
        this.self.setHardness(val);
        elements.hardnessSlider.value = val;
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastHardnessChange(val));
      }
    });

    this.ui.makeValueEditable(elements.opacityValue, {
      min: 0, max: 100, step: 1, suffix: '%',
      onCommit: (val) => {
        const opacity = val / 100;
        this.commitSelfEraserSegment(this.self.pressure, this.self.size, opacity);
        this.self.setOpacity(opacity);
        elements.opacitySlider.value = val;
        const currentColor = [...this.self.color];
        currentColor[3] = opacity;
        this.self.setColor(currentColor);
        this._setColorPickersColor(`rgba(${currentColor.join(',')})`);
        if (this.connected) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastColorChange(currentColor));
        }
      }
    });

    if (elements.blurRadiusValue) {
      this.ui.makeValueEditable(elements.blurRadiusValue, {
        min: 1, max: () => this.getBlurRadiusMaxForTool(), step: 1, suffix: '',
        onCommit: (val) => {
          const radius = this.setSelfBlurRadiusForCurrentTool(val);
          elements.blurRadiusSlider.value = radius;
          if (this.connected) {
            this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBlurRadiusChange(radius));
          }
        }
      });
    }

    if (elements.thinningValue) {
      this.ui.makeValueEditable(elements.thinningValue, {
        min: 0, max: 100, step: 1, suffix: '',
        onCommit: (val) => {
          elements.thinningSlider.value = val;
          this.handleThinningChange({ target: { value: val } });
        }
      });
    }

    const makePatternOptionEditable = (valueEls, sliderEls, opts, handler) => {
      valueEls.filter(Boolean).forEach((valueEl) => {
        this.ui.makeValueEditable(valueEl, {
          ...opts,
          onCommit: (val) => {
            const rounded = this.roundPatternOptionValue(val);
            sliderEls.filter(Boolean).forEach((slider) => {
              slider.value = rounded;
            });
            handler.call(this, { target: { value: rounded } });
          }
        });
      });
    };

    makePatternOptionEditable(
      [elements.patternScaleValue, elements.fillPatternScaleValue, elements.selectionPatternScaleValue],
      [elements.patternScaleSlider, elements.fillPatternScaleSlider, elements.selectionPatternScaleSlider],
      { min: 5, max: 500, step: 0.1, suffix: '%' },
      this.handlePatternScaleChange
    );

    makePatternOptionEditable(
      [elements.patternRotationValue, elements.fillPatternRotationValue, elements.selectionPatternRotationValue],
      [elements.patternRotationSlider, elements.fillPatternRotationSlider, elements.selectionPatternRotationSlider],
      { min: 0, max: 360, step: 0.1, suffix: '°' },
      this.handlePatternRotationChange
    );

    makePatternOptionEditable(
      [elements.patternSpacingValue, elements.fillPatternSpacingValue, elements.selectionPatternSpacingValue],
      [elements.patternSpacingSlider, elements.fillPatternSpacingSlider, elements.selectionPatternSpacingSlider],
      { min: 0, max: 100, step: 0.1, suffix: '' },
      this.handlePatternSpacingChange
    );

    makePatternOptionEditable(
      [elements.patternOffsetXValue, elements.fillPatternOffsetXValue, elements.selectionPatternOffsetXValue],
      [elements.patternOffsetXSlider, elements.fillPatternOffsetXSlider, elements.selectionPatternOffsetXSlider],
      { min: -100, max: 100, step: 0.1, suffix: '' },
      this.handlePatternOffsetXChange
    );

    makePatternOptionEditable(
      [elements.patternOffsetYValue, elements.fillPatternOffsetYValue, elements.selectionPatternOffsetYValue],
      [elements.patternOffsetYSlider, elements.fillPatternOffsetYSlider, elements.selectionPatternOffsetYSlider],
      { min: -100, max: 100, step: 0.1, suffix: '' },
      this.handlePatternOffsetYChange
    );

    // Pressure range value: click to edit both ends. No drag-to-adjust - see
    // EditableValueHandler.makeEditable for why.
    {
      const pressureSpan = elements.pressureValue;

      const openPressureEditor = () => {
        if (pressureSpan.querySelector('.sliderValueInput')) return;

        const minVal = Number(elements.pressureMinSlider.value);
        const maxVal = Number(elements.pressureMaxSlider.value);
        const originalText = pressureSpan.textContent;

        const minInput = document.createElement('input');
        minInput.type = 'text';
        minInput.className = 'sliderValueInput';
        minInput.inputMode = 'numeric';
        minInput.autocomplete = 'off';
        minInput.spellcheck = false;
        minInput.value = minVal;
        minInput.style.width = '3ch';

        const sep = document.createTextNode('-');

        const maxInput = document.createElement('input');
        maxInput.type = 'text';
        maxInput.className = 'sliderValueInput';
        maxInput.inputMode = 'numeric';
        maxInput.autocomplete = 'off';
        maxInput.spellcheck = false;
        maxInput.value = maxVal;
        maxInput.style.width = '3ch';

        pressureSpan.textContent = '';
        pressureSpan.appendChild(minInput);
        pressureSpan.appendChild(sep);
        pressureSpan.appendChild(maxInput);
        minInput.focus();
        minInput.select();

        const commit = () => {
          let mn = Math.max(0, Math.min(100, parseInt(minInput.value) || 0));
          let mx = Math.max(0, Math.min(100, parseInt(maxInput.value) || 100));
          if (mn > mx) mn = mx;
          elements.pressureMinSlider.value = mn;
          elements.pressureMaxSlider.value = mx;
          this.ui.updatePressureValue(mn, mx);
        };

        const cancel = () => {
          pressureSpan.textContent = originalText;
        };

        const onKey = (ke) => {
          if (ke.key === 'Enter') {
            ke.preventDefault();
            minInput.removeEventListener('blur', onBlur);
            maxInput.removeEventListener('blur', onBlur);
            commit();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            minInput.removeEventListener('blur', onBlur);
            maxInput.removeEventListener('blur', onBlur);
            cancel();
          }
          ke.stopPropagation();
        };

        const onBlur = (be) => {
          setTimeout(() => {
            if (document.activeElement !== minInput && document.activeElement !== maxInput) {
              commit();
            }
          }, 0);
        };

        minInput.addEventListener('keydown', onKey);
        maxInput.addEventListener('keydown', onKey);
        minInput.addEventListener('blur', onBlur);
        maxInput.addEventListener('blur', onBlur);
      };

      pressureSpan.addEventListener('pointerdown', (e) => {
        if (pressureSpan.querySelector('.sliderValueInput')) return;
        e.stopPropagation();
      });

      pressureSpan.addEventListener('click', (e) => {
        if (pressureSpan.querySelector('.sliderValueInput')) return;
        e.stopPropagation();
        openPressureEditor();
      });
    }

    // Selection mode radio buttons
    const selectionModeRadios = document.querySelectorAll('input[name="selectionMode"]');
    selectionModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) {
          selectTool.setMode(e.target.value);
        }
      });
    });

    // Layer mode radio buttons for select tool
    document.querySelectorAll('input[name="selectionLayerMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) {
          selectTool.toggleCopyAllLayers(e.target.value === 'all');
        }
      });
    });

    // Fit to content checkbox for select tool
    const fitToContentCheckbox = document.getElementById('selectionFitToContent');
    if (fitToContentCheckbox) {
      fitToContentCheckbox.addEventListener('change', (e) => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) {
          selectTool.toggleFitToContent(e.target.checked);
        }
      });
    }

    // Extended warp checkbox for select tool
    const extendedWarpCheckbox = document.getElementById('selectionExtendedWarp');
    if (extendedWarpCheckbox) {
      extendedWarpCheckbox.addEventListener('change', (e) => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) {
          selectTool.toggleExtendedWarp(e.target.checked);
        }
      });
    }


    if (elements.cursorStyleSelect) {
      elements.cursorStyleSelect.addEventListener('change', (e) => {
        this.handleCursorStyleChange(e.target.value);
      });
    }

    if (elements.rightClickActionSelect) {
      elements.rightClickActionSelect.addEventListener('change', (e) => {
        this.setRightClickAction(this.self.tool, e.target.value);
        this.ui.showToast(`Right click: ${getRightClickActionLabel(e.target.value)}`, 1500);
      });
    }

    // Lock button event listeners
    const handleLockClick = (property, e) => {
      if (e.shiftKey) {
        this.toolLockManager.toggleAllLocksForCurrentTool(property);
      } else {
        this.toolLockManager.toggleLock(property);
      }
    };
    if (elements.sizeLock) elements.sizeLock.addEventListener('click', (e) => handleLockClick('size', e));
    if (elements.pressureLock) elements.pressureLock.addEventListener('click', (e) => handleLockClick('pressure', e));
    if (elements.pressureTargetsLock) elements.pressureTargetsLock.addEventListener('click', (e) => handleLockClick('pressureTargets', e));
    if (elements.smoothingLock) elements.smoothingLock.addEventListener('click', (e) => handleLockClick('smoothing', e));
    if (elements.spacingLock) elements.spacingLock.addEventListener('click', (e) => handleLockClick('spacing', e));
    if (elements.hardnessLock) elements.hardnessLock.addEventListener('click', (e) => handleLockClick('hardness', e));
    if (elements.opacityLock) elements.opacityLock.addEventListener('click', (e) => handleLockClick('opacity', e));
    if (elements.blurRadiusLock) elements.blurRadiusLock.addEventListener('click', (e) => handleLockClick('blurRadius', e));
    if (elements.thinningLock) elements.thinningLock.addEventListener('click', (e) => handleLockClick('thinning', e));

    elements.board.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    window.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    window.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    window.addEventListener('pointercancel', (e) => this.handlePointerUp(e));
    window.addEventListener('keydown', (e) => this.updateModifierKeysFromEvent(e), true);
    window.addEventListener('keyup', (e) => this.updateModifierKeysFromEvent(e), true);
    window.addEventListener('blur', () => this.clearModifierKeys());

    elements.board.addEventListener('pointerenter', (e) => {
      this.syncBoardHoverState(true, { forceRefresh: true, event: e });
    });
    elements.board.addEventListener('pointerleave', (e) => this.handlePointerLeave(e));

    elements.board.addEventListener('wheel', (e) => this.handleWheel(e));
    // #board sits inside #boardContainer, so a right-click on the canvas hits
    // both listeners — run the action only once per event.
    const handleBoardContextMenu = (e) => {
      e.preventDefault();
      if (e._rightClickActionHandled) return;
      e._rightClickActionHandled = true;
      this.performRightClickAction(e);
    };
    elements.board.addEventListener('contextmenu', handleBoardContextMenu);
    elements.boardContainer.addEventListener('contextmenu', handleBoardContextMenu);

    // boardContainer: middle-click to pan anywhere, and pan/rotate by dragging the background
    elements.boardContainer.addEventListener('pointerdown', (e) => this.handleBoardContainerPointerDown(e));
    elements.boardContainer.addEventListener('pointermove', (e) => this.handleBoardContainerPointerMove(e));
    elements.boardContainer.addEventListener('pointerup', (e) => this.handleBoardContainerPointerUp(e));
    elements.boardContainer.addEventListener('pointercancel', () => this._endContainerPan());
    elements.boardContainer.addEventListener('wheel', (e) => this.handleBoardContainerWheel(e));

    // Touch gestures are now handled by Hammer.js in TouchHandler.init()

    // Hidden input for touch keyboard (text tool)
    if (elements.touchInput) {
      elements.touchInput.addEventListener('beforeinput', (e) => this.touchHandler.handleTouchBeforeInput(e));
      elements.touchInput.addEventListener('blur', () => this.touchHandler.handleTouchInputBlur());
    }

    // Initialize keyboard handler
    this.keyboardHandler.init();

    // Drag and drop images
    elements.boardContainer.addEventListener('dragenter', (e) => this.handleBoardImageDragEnter(e));
    elements.boardContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.handleBoardImageDragOver(e);
      e.dataTransfer.dropEffect = 'copy';
    });
    elements.boardContainer.addEventListener('dragleave', (e) => this.handleBoardImageDragLeave(e));
    elements.boardContainer.addEventListener('drop', (e) => this.handleImageDrop(e));

    window.addEventListener('resize', () => this.handleResize());

    window.addEventListener('beforeunload', (e) => {
      if (!this._warnOnNextUnload) return;

      e.preventDefault();
      e.returnValue = '';

      // If the user stays on the page, clear the flag on the next tick so
      // normal tab close behavior is preserved until they press Ctrl/Cmd+R again.
      setTimeout(() => {
        this._warnOnNextUnload = false;
      }, 0);
    });

    // Push a sentinel state so the back button doesn't immediately leave the page.
    // On popstate (back/forward), show a confirmation dialog instead of navigating away.
    if (!window.history.state?._topDrawSentinel) {
      window.history.pushState({ _topDrawSentinel: true }, '');
    }
    window.addEventListener('popstate', async (e) => {
      if (!e.state?._topDrawSentinel) {
        // Re-push sentinel so back button is re-armed
        window.history.pushState({ _topDrawSentinel: true }, '');
        const shouldLeave = await this.ui.confirm('Are you sure you want to leave DDraw?', {
          title: 'Leave DDraw?',
          confirmLabel: 'Leave'
        });
        if (shouldLeave) {
          window.history.go(-2);
        }
      }
    });

    // Pattern options listeners
    if (elements.patternScaleSlider) {
      elements.patternScaleSlider.addEventListener('input', (e) => this.handlePatternScaleChange(e));
    }
    if (elements.patternTypeSelect) {
      elements.patternTypeSelect.addEventListener('change', (e) => this.handlePatternTypeChange(e));
    }
    if (elements.patternImageBtn) {
      elements.patternImageBtn.addEventListener('click', () => this.handlePatternImageBtnClick());
    }
    if (elements.patternImageUploadInput) {
      elements.patternImageUploadInput.addEventListener('change', (e) => this.handlePatternImageUpload(e));
    }
    if (elements.patternShapeUploadBtn) {
      elements.patternShapeUploadBtn.addEventListener('click', () => this.handlePatternShapeUploadBtnClick());
    }
    if (elements.patternShapeUploadInput) {
      elements.patternShapeUploadInput.addEventListener('change', (e) => this.handlePatternShapeUpload(e));
    }
    if (elements.patternRotationSlider) {
      elements.patternRotationSlider.addEventListener('input', (e) => this.handlePatternRotationChange(e));
    }
    if (elements.patternSpacingSlider) {
      elements.patternSpacingSlider.addEventListener('input', (e) => this.handlePatternSpacingChange(e));
    }
    if (elements.patternOffsetXSlider) {
      elements.patternOffsetXSlider.addEventListener('input', (e) => this.handlePatternOffsetXChange(e));
    }
    if (elements.patternOffsetYSlider) {
      elements.patternOffsetYSlider.addEventListener('input', (e) => this.handlePatternOffsetYChange(e));
    }
    if (elements.patternColorModeRadios) {
      elements.patternColorModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => this.handlePatternColorModeChange(e));
      });
    }

    if (elements.imageBrushColorModeRadios) {
      elements.imageBrushColorModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => this.handleImageBrushColorModeChange(e));
      });
    }

    const updateConfettiPreview = () => {
      if (this.self.tool === 'confetti') {
        this.toolManager.getTool('confetti')?.updatePreview?.(this.self);
      }
    };
    const bindConfettiOption = (element, property, parser = (value) => value, display = null) => {
      if (!element) return;
      const update = (e) => {
        const value = parser(e.target.value);
        this.self[property] = value;
        if (display) display(value);
        updateConfettiPreview();
      };
      element.addEventListener('input', update);
      element.addEventListener('change', update);
      const initialValue = parser(element.value);
      this.self[property] = initialValue;
      if (display) display(initialValue);
    };
    if (elements.confettiColorModeRadios) {
      elements.confettiColorModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
          if (!e.target.checked) return;
          this.self.confettiColorMode = e.target.value;
          updateConfettiPreview();
        });
        if (radio.checked) this.self.confettiColorMode = radio.value;
      });
    }
    if (elements.confettiRandomRotation) {
      const applyRotationMode = (checked) => {
        this.self.confettiRotationMode = checked ? 'random' : 'fixed';
      };
      elements.confettiRandomRotation.addEventListener('change', (e) => {
        applyRotationMode(e.target.checked);
        updateConfettiPreview();
      });
      applyRotationMode(elements.confettiRandomRotation.checked);
    }
    bindConfettiOption(elements.confettiParticlesSlider, 'confettiParticles', (value) => Number(value), (value) => {
      if (elements.confettiParticlesValue) elements.confettiParticlesValue.textContent = String(value);
    });
    bindConfettiOption(elements.confettiParticleSizeSlider, 'confettiParticleSize', (value) => Number(value), (value) => {
      if (elements.confettiParticleSizeValue) elements.confettiParticleSizeValue.textContent = String(value);
    });
    bindConfettiOption(elements.confettiSizeVariationSlider, 'confettiSizeVariation', (value) => Number(value), (value) => {
      if (elements.confettiSizeVariationValue) elements.confettiSizeVariationValue.textContent = `${value}%`;
    });
    bindConfettiOption(elements.confettiOpacityRandomnessSlider, 'confettiOpacityRandomness', (value) => Number(value), (value) => {
      if (elements.confettiOpacityRandomnessValue) elements.confettiOpacityRandomnessValue.textContent = `${value}%`;
    });
    bindConfettiOption(elements.confettiSpacingSlider, 'confettiSpacing', (value) => Number(value), (value) => {
      if (elements.confettiSpacingValue) elements.confettiSpacingValue.textContent = String(value);
    });

    // Fill pattern settings (reuse same handlers as pattern tool since they share user properties)
    if (elements.fillPatternScaleSlider) {
      elements.fillPatternScaleSlider.addEventListener('input', (e) => this.handlePatternScaleChange(e));
    }
    if (elements.fillPatternRotationSlider) {
      elements.fillPatternRotationSlider.addEventListener('input', (e) => this.handlePatternRotationChange(e));
    }
    if (elements.fillPatternSpacingSlider) {
      elements.fillPatternSpacingSlider.addEventListener('input', (e) => this.handlePatternSpacingChange(e));
    }
    if (elements.fillPatternOffsetXSlider) {
      elements.fillPatternOffsetXSlider.addEventListener('input', (e) => this.handlePatternOffsetXChange(e));
    }
    if (elements.fillPatternOffsetYSlider) {
      elements.fillPatternOffsetYSlider.addEventListener('input', (e) => this.handlePatternOffsetYChange(e));
    }
    if (elements.fillPatternColorModeRadios) {
      elements.fillPatternColorModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => this.handlePatternColorModeChange(e));
      });
    }

    // Selection pattern settings (reuse same handlers as pattern tool since they share user properties)
    if (elements.selectionPatternScaleSlider) {
      elements.selectionPatternScaleSlider.addEventListener('input', (e) => this.handlePatternScaleChange(e));
    }
    if (elements.selectionPatternRotationSlider) {
      elements.selectionPatternRotationSlider.addEventListener('input', (e) => this.handlePatternRotationChange(e));
    }
    if (elements.selectionPatternSpacingSlider) {
      elements.selectionPatternSpacingSlider.addEventListener('input', (e) => this.handlePatternSpacingChange(e));
    }
    if (elements.selectionPatternOffsetXSlider) {
      elements.selectionPatternOffsetXSlider.addEventListener('input', (e) => this.handlePatternOffsetXChange(e));
    }
    if (elements.selectionPatternOffsetYSlider) {
      elements.selectionPatternOffsetYSlider.addEventListener('input', (e) => this.handlePatternOffsetYChange(e));
    }
    if (elements.selectionPatternColorModeRadios) {
      elements.selectionPatternColorModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => this.handlePatternColorModeChange(e));
      });
    }
  }

  // --- Pattern/image-brush option delegates (implementation in ui/PatternOptionsController.js) ---
  roundPatternOptionValue(value) { return this.patternOptions.roundPatternOptionValue(value); }
  formatPatternOptionValue(value) { return this.patternOptions.formatPatternOptionValue(value); }
  handlePatternScaleChange(e) { this.patternOptions.handlePatternScaleChange(e); }
  handlePatternRotationChange(e) { this.patternOptions.handlePatternRotationChange(e); }
  handlePatternSpacingChange(e) { this.patternOptions.handlePatternSpacingChange(e); }
  handlePatternOffsetXChange(e) { this.patternOptions.handlePatternOffsetXChange(e); }
  handlePatternOffsetYChange(e) { this.patternOptions.handlePatternOffsetYChange(e); }
  handlePatternImageBtnClick() { this.patternOptions.handlePatternImageBtnClick(); }
  handlePatternImageUpload(e) { return this.patternOptions.handlePatternImageUpload(e); }
  handlePatternColorModeChange(e) { this.patternOptions.handlePatternColorModeChange(e); }
  handleImageBrushColorModeChange(e) { this.patternOptions.handleImageBrushColorModeChange(e); }
  handlePatternBrushSelect(brush) { this.patternOptions.handlePatternBrushSelect(brush); }
  _buildPatternPayload() { return this.patternOptions._buildPatternPayload(); }
  _buildImageBrushPayload() { return this.patternOptions._buildImageBrushPayload(); }
  _buildConfettiBrushPayload(extra) { return this.patternOptions._buildConfettiBrushPayload(extra); }

  // Room selection

  /**
   * Handles room selection and initiates connection.
   * @async
   * @param {string} roomId - The ID of the room to join.
   * @param {string} [password=null] - The room password, if any.
   * @returns {Promise<void>}
   */
  async handleRoomSelected(roomId, password = null, pendingSettings = null) {
    // Handle /go/offline as draw alone mode
    if (roomId === 'offline') {
      this.handleOffline();
      return;
    }

    this.resetRoomState({ preserveRemoteVisuals: false, clearBoard: true });
    // Joining is a user gesture — use it to unlock the silent-audio keepalive
    // that keeps the tick loop running at full rate while the tab is hidden.
    this.backgroundKeepAlive?.start();
    // Drop the rolling tape from the room we're leaving; it re-arms on sync.
    this.rollingTapeRecorder?.stop('room-change');
    // New board => new time-lapse; discard the previous room's frames.
    this.timelapseCapturer?.reset();

    this.isOfflineMode = false;
    this.currentRoomId = roomId;
    appState.currentRoomId = this.currentRoomId;
    this.currentRoomPassword = password;
    this._pendingRoomSettings = pendingSettings || null;

    const usernameInput = this.ui.elements.loginUsername;
    if (usernameInput && usernameInput.value && !this.self.username) {
      const username = usernameInput.value.trim() || 'Guest';
      this.self.setUsername(username);
    }

    this.users.clear();
    this.connected = false;
    appState.connected = false;
    this.ui.setRemoteUsersConnected(false);
    this.sessionIndex = null;
    if (this.self) this.self.id = null;

    this.syncClient.showOverlay();
    this.syncClient.updateProgress('Connecting...');

    const versionStatus = await ensureClientCanConnect({ showWarning: true });
    if (!versionStatus.allowed) {
      this.syncClient.hideOverlay();
      if (versionStatus.desktopUpdateResult?.status === 'offline') {
        return;
      }
      this.showUpdateRequiredNotice(versionStatus);
      if (this.landingPage) {
        this.landingPage.show();
        this.landingPage.updateConnectionStatus(this.wsClient?.connected ? 'connected' : 'disconnected');
      }
      return;
    }

    try {
      await this.wsClient.connect(this.self.toJSON(), roomId);
    } catch (err) {
      console.error('Failed to connect to room:', err);
      this.ui.showToast('Failed to connect to room', 3000);
      if (this.landingPage) {
        this.landingPage.show();
        this.connectForRoomDiscovery();
      }
    }
  }

  /**
   * Starts a room join from the landing page without waiting for discovery to connect.
   * @param {string|null} [roomId=null] - Explicit room to join, or current landing selection.
   * @param {string|null} [password=null] - Optional password to use for auth-on-connect.
   * @returns {Promise<void>}
   */
  async startLandingJoin(roomId = null, password = null) {
    // Warm the deferred chunks before the socket opens, so the tape recorders
    // and remote-selection warp maths exist by the time the first frame of
    // room traffic arrives.
    await this.whenRoomModulesReady();

    let resolvedRoomId = roomId || this.landingPage?.els.roomIdInput?.value.trim() || this.landingPage?.selectedRoom || 'lobby';

    if (resolvedRoomId !== 'lobby') {
      if (!/^[a-zA-Z0-9_-]+$/.test(resolvedRoomId)) {
        this.landingPage?.showError('Room name can only contain letters, numbers, dashes, and underscores');
        return;
      }
      if (resolvedRoomId.length < 2 || resolvedRoomId.length > 20) {
        this.landingPage?.showError('Room name must be 2-20 characters');
        return;
      }
    }

    let name = this.auth?.getJoinUsername();
    if (!name) {
      name = this.ui.elements.loginUsername?.value.trim();
    }
    if (!name) {
      let tabId = sessionStorage.getItem('tabId');
      if (!tabId) {
        tabId = Math.random().toString(36).substring(2, 8);
        sessionStorage.setItem('tabId', tabId);
      }
      name = `Guest-${tabId}`;
    }

    this.self.setUsername(name);

    const pendingPassword = password || '';
    this._pendingPassword = pendingPassword || null;
    this.landingPage?.clearError();

    if (this.landingPage) {
      this.landingPage.selectRoom(resolvedRoomId);
      this.landingPage.hide();
      this.mobileLayout.playToolOptionsIntro();
    }

    const embedMode = typeof document !== 'undefined' && document.documentElement?.dataset?.embed === 'true';
    const newPath = embedMode
      ? (resolvedRoomId === 'offline' ? '/embed' : `/embed/${resolvedRoomId}`)
      : (resolvedRoomId === 'offline' ? '/go/offline' : `/go/${resolvedRoomId}`);
    if (window.location.pathname !== newPath) {
      window.history.pushState({ room: resolvedRoomId }, '', newPath);
    }

    await this.handleRoomSelected(resolvedRoomId, password);
  }

  /**
   * Authenticates from the landing page without immediately joining a room.
   */
  async handleLandingLogin() {
    if (!this.auth || this.auth.isLoggedIn) return;

    const username = (this.ui.elements.loginAccountUsername || this.ui.elements.loginUsername)?.value.trim();
    const password = this.ui.elements.loginPassword?.value;

    if (!username || !password) {
      this.landingPage?.showError('Please enter username and password');
      return;
    }

    this.landingPage?.clearError();

    if (this.wsClient.connected && (!this.currentRoomId || this.currentRoomId === '_discovery')) {
      this.auth.handleLogin();
      return;
    }

    this._pendingLandingLogin = true;
    await this.connectForRoomDiscovery();
  }

  /**
   * Starts the application in offline (local-only) mode.
   * If the user has entered credentials, attempts to authenticate first.
   */
  async handleOffline() {
    if (this._reloadRecommended) {
      this._dismissCurrentUpdateForOffline();
    }
    this._enterOfflineMode();
  }

  /**
   * Attempts to connect and authenticate, then enters offline mode regardless of outcome.
   */
  async _authenticateThenGoOffline() {
    this._pendingOffline = true;

    // Safety timeout — if auth doesn't complete in 5s, go offline anyway
    this._offlineAuthTimeout = setTimeout(() => {
      if (this._pendingOffline) {
        console.log('[App] Auth timed out before offline mode');
        this._pendingOffline = false;
        this._enterOfflineMode();
      }
    }, 5000);

    try {
      // Connect to discovery room for authentication
      await this.wsClient.connect(this.self.toJSON(), '_discovery');
      // handleWSConnect will trigger login; auth result will call _enterOfflineMode
    } catch (err) {
      console.log('[App] Could not connect for auth before offline mode:', err.message);
      clearTimeout(this._offlineAuthTimeout);
      this._pendingOffline = false;
      this._enterOfflineMode();
    }
  }

  /**
   * Actually enters offline drawing mode.
   */
  _enterOfflineMode() {
    console.log('[App] Draw Alone mode - creating local room');

    // Tear down any replay state from the session we're leaving before the board
    // is wiped below. Close an open time machine (it would otherwise show the
    // old online replay against a cleared board) and drop a mid-flight manual
    // recording (its opening snapshot is the online board, so continuing across
    // the wipe yields a corrupt tape). The rolling tape is re-armed fresh at the
    // end of this method against the new offline board.
    this.TimeMachine?.stop();
    if (this.recorder?.isRecording?.()) {
      this.stopTapeRecording();
    }
    this.rollingTapeRecorder?.stop('enter-offline');

    // Preserve the current artwork: switching to offline (e.g. after a dropped
    // connection or an update prompt) exists so the user can keep drawing on
    // what's already there, not start over. Keep the board (clearBoard:false)
    // and bake departing remote users' committed strokes into it
    // (preserveRemoteVisuals:true) — only their cursors/transient state are
    // dropped. The fresh offline rolling tape (started below) then snapshots
    // this preserved board as its replay base.
    this.resetRoomState({ preserveRemoteVisuals: true, clearBoard: false });
    // Restore whatever offline-only room settings (e.g. background colour) were
    // saved from a previous Draw Alone session, before anything else touches the board.
    const offlineSettings = this.getOfflineRoomSettings();
    if (offlineSettings?.backgroundColor) {
      this.board.setBackgroundColor(offlineSettings.backgroundColor);
    }
    this.isOfflineMode = true;
    this.connected = false;
    appState.connected = false;
    this.ui.setRemoteUsersConnected(false);
    this.currentRoomId = 'offline-' + Date.now();
    appState.currentRoomId = this.currentRoomId;

    // Cancel any pending auth attempt so it doesn't interrupt offline drawing
    this.auth?.setLoading(false);

    if (this.wsClient) {
      this.wsClient.disconnect();
    }

    this.sessionIndex = 0;
    this.self.id = 0;
    const offlineUsername = this.auth?.getJoinUsername() || this.ui.elements.loginUsername?.value.trim() || '';
    this.self.setUsername(offlineUsername);
    // Offline is solo. resetRoomState removed remotes but kept self under its old
    // online session index; clear that stale key so users holds exactly {0: self}
    // — otherwise the offline rolling tape's opening snapshot captures self twice
    // and replays a phantom duplicate cursor.
    this.users.clear();
    this.users.set(0, this.self);

    if (this.landingPage) {
      this.landingPage.hide();
      this.mobileLayout.playToolOptionsIntro();
    }

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(offlineUsername);
    this.ui.showConnectionStatus('offline');
    // Register Room never applies offline; Room Settings and Clear do (both
    // are local-only in offline mode) — re-evaluate now that isOfflineMode is set.
    this.updateRoomSettingsButtonVisibility();
    this.moderation?.updateModVisibility();

    this.inputBufferManager.startTickLoop();
    if (!this._visibilityEligibilityHandler && typeof document !== 'undefined') {
      this._visibilityEligibilityHandler = () => this._updatePreviewUploadEligibility();
      document.addEventListener('visibilitychange', this._visibilityEligibilityHandler);
    }

    // The rolling DVR tape, manual recorder and time machine are entirely
    // client-side, so run them in offline mode too. Online they start on
    // sync-complete (which never fires here); start() respects the user's
    // enable/disable preference and captures the opening checkpoint now.
    void this.whenRoomModulesReady().then(() => {
      this.rollingTapeRecorder?.start(this);
      this.updateRecordingButtonState();
    });

    // Update URL to /go/offline (or /embed when running as an embed)
    const offlinePath = (typeof document !== 'undefined' && document.documentElement?.dataset?.embed === 'true')
      ? '/embed'
      : '/go/offline';
    if (window.location.pathname !== offlinePath) {
      window.history.pushState({ room: 'offline' }, '', offlinePath);
    }
  }

  /**
   * Connects to the discovery room to fetch the list of available rooms.
   * @async
   * @returns {Promise<void>}
   */
  async connectForRoomDiscovery() {
    this.currentRoomId = null;
    appState.currentRoomId = null;
    this.connected = false;
    appState.connected = false;
    this.ui.setRemoteUsersConnected(false);
    this.TimeMachine?.stop();
    this.rollingTapeRecorder?.stop('leave-room');
    this.timelapseCapturer?.reset();
    this.updateRecordingButtonState();

    if (this.landingPage) {
      this.landingPage.updateConnectionStatus('connecting');
    }

    try {
      await this.wsClient.connect(this.self.toJSON(), '_discovery');
    } catch (err) {
      console.error('[App] Discovery connection failed:', err);
      if (this.landingPage) {
        this.landingPage.updateConnectionStatus('disconnected');
      }
    }
  }

  /**
   * Loads the replay chunk and wires everything that depends on it.
   *
   * Runs once, off the critical path. Until it resolves `this.TimeMachine`,
   * `this.recorder`, `this.rollingTapeRecorder`, `this.timelapseCapturer` and
   * `this.recording` are undefined — every consumer optional-chains them, and
   * every room-entry path awaits `whenReplayReady()` first, so the undefined
   * window is only ever open while the user is still on the landing page.
   * @returns {Promise<void>}
   */
  async _initReplayStack() {
    let mod;
    try {
      mod = await deferredReplay.load();
    } catch {
      // Recording/replay stays unavailable; drawing is unaffected.
      return;
    }

    const { TimeMachine, TimelapseCapturer, recorder, rollingTapeRecorder, RecordingController } = mod;

    TimeMachine.init(this.board, this.wsClient);
    this.TimeMachine = TimeMachine; // Expose for WebSocketClient recording
    this.recorder = recorder;       // Local replay tape. TimeMachine.recordAction → here.
    this.rollingTapeRecorder = rollingTapeRecorder; // Automatic 2-min DVR tape (History → Recent).
    // _applyLowPowerPreference ran before this chunk landed.
    this.rollingTapeRecorder.setLowPower?.(this.isLowPowerModeActive());
    this.recording = new RecordingController(this);

    // Periodic full-board stills (~60s) used to build a gallery time-lapse webm
    // when the user uploads their drawing. Reset on room change (new board).
    this.timelapseCapturer = new TimelapseCapturer(this.board, {
      shouldCapture: () => this.canUseGalleryTimelapse(),
    });
    if (!this.isBackgroundWorkReduced() && !this.isLowPowerModeActive()) this.timelapseCapturer.start();

    // Preferences were applied before the chunk landed, so re-apply them onto
    // the now-real recorders, then refresh the button that reflects tape state.
    this._applyReplayPreferences();
    this.updateRecordingButtonState();
  }

  /**
   * Resolves once the replay stack is usable. Cheap after the first call.
   * @returns {Promise<void>}
   */
  whenReplayReady() {
    return this._replayReady ?? Promise.resolve();
  }

  /**
   * Resolves once every deferred chunk a live room needs has landed. Awaited by
   * the join paths so no room-entry code has to cope with a half-loaded app.
   * Never rejects — a failed chunk degrades that one feature, not the join.
   * @returns {Promise<void>}
   */
  async whenRoomModulesReady() {
    // Memoised so the join path awaits the same in-flight preload that init
    // kicked off, rather than starting a second one.
    this._roomModulesReady ??= preloadRoomModules();
    await Promise.allSettled([this.whenReplayReady(), this._roomModulesReady]);
  }

  _bindLayerManagerDependencies() {
    if (!this.board?.layerManager) return;
    this.strokeHistoryPanel.setLayerManager(this.board.layerManager);
    this.strokeHistoryPanel.setActiveLayer(this.self?.activeLayer ?? 0);
    this.board.layerManager.strokeHistoryPanel = this.strokeHistoryPanel;
    this.board.layerManager.onHistoryChange = () => this.updateUndoRedoHud();
    this.board.layerManager.localUserId = this.self?.id ?? null;
  }

  hasRemoteUsers() {
    for (const id of this.users.keys()) {
      if (Number(id) !== Number(this.sessionIndex)) {
        return true;
      }
    }
    return false;
  }

  cancelMemoryCompaction() {
    if (this._memoryCompactionTimer) {
      clearTimeout(this._memoryCompactionTimer);
      this._memoryCompactionTimer = null;
    }
  }

  scheduleMemoryCompaction(reason = 'remote-idle') {
    this.cancelMemoryCompaction();
    if (this.hasRemoteUsers()) return;

    this._memoryCompactionTimer = setTimeout(() => {
      this._memoryCompactionTimer = null;
      this.compactMemory({ reason });
    }, this._memoryCompactionDelayMs);
  }

  compactMemory(options = {}) {
    if (!this.board?.layerManager) return false;
    if (this.hasRemoteUsers()) return false;
    if (this.syncClient?.isSyncing?.()) {
      this.scheduleMemoryCompaction('sync-busy');
      return false;
    }
    if (this.self?.mousedown) {
      this.scheduleMemoryCompaction('local-active');
      return false;
    }

    const selectTool = this.toolManager.getTool('select');
    if (selectTool?.isSelecting || selectTool?.isDragging || selectTool?.floatingCanvas) {
      this.scheduleMemoryCompaction('selection-active');
      return false;
    }

    const layerStats = this.board.layerManager.getDebugStats?.();
    if ((layerStats?.activeStrokes ?? 0) > 0) {
      this.scheduleMemoryCompaction('strokes-active');
      return false;
    }

    this.remoteUserHandler?.resetTransientState?.();
    this.toolManager.getTool('fill')?.compactMemory?.({ recycleWorker: true });
    this.board.layerManager.compactTransientState?.({ recycleWorker: true, clearReplayCaches: true });
    this.board.requestUpdate();
    this.updateCleanupDebugStats();
    console.log('[Memory] Compacted renderer state:', options.reason || 'manual');
    return true;
  }

  cleanupRemoteUserState(userId, options = {}) {
    const preserveVisuals = options.preserveVisuals === true;
    const requestUpdate = options.requestUpdate !== false;
    const numericUserId = Number(userId);
    if (!Number.isFinite(numericUserId)) return;
    if (this.sessionIndex !== null && numericUserId === Number(this.sessionIndex)) return;

    const user = this.users.get(numericUserId);
    if (user) {
      this.remoteUserHandler?.cleanupUserState?.(user, { preserveVisuals });
      this.users.delete(numericUserId);
    } else {
      this.board.layerManager?.deepCleanupUserState?.(numericUserId, { preserveVisuals });
    }

    this.ui.removeRemoteUser(numericUserId);
    if (requestUpdate) {
      this.board.requestUpdate();
    }
    if (this.hasRemoteUsers()) {
      this.cancelMemoryCompaction();
    } else {
      this.scheduleMemoryCompaction('last-remote-left');
    }
    this.updateCleanupDebugStats();
  }

  /**
   * Ensures a remote User object (with board/context) exists for a session
   * index, creating a transient placeholder if not. Used during checkpoint-join
   * replay: the post-checkpoint command tail can contain strokes from a user who
   * has since LEFT, so they're absent from the joiner's USERS list — the remote
   * draw handlers `users.get(sid)` and bail without this. Their committed strokes
   * bake into the shared layer (keyed by user.id) regardless; the next
   * authoritative USERS broadcast cleans up the placeholder (preserving visuals)
   * since it won't include the departed sid. Mirrors UserHandlers' creation path.
   * @param {number} sessionIndex
   * @returns {User|null} the existing or newly created remote user
   */
  ensureRemoteUser(sessionIndex) {
    const idx = Number(sessionIndex);
    if (!Number.isFinite(idx)) return null;
    if (this.sessionIndex !== null && idx === Number(this.sessionIndex)) {
      // The local user normally draws through the tool pipeline onto board.topCtx
      // and never needs a per-user canvas layer. A resync is the exception: the
      // join tail replays our OWN commits back to us and they render through the
      // remote path, which writes previews to `user.context` unguarded
      // (RemoteUserHandler line ~85 reads user.context.canvas). Provision it once,
      // lazily. createUserBoard only appends a transparent canvas to #userBoards —
      // no cursor, no name tag — and nothing writes to it outside a rebuild.
      if (this.self && !this.self.context) {
        const selfBoard = this.ui.createUserBoard(idx);
        this.self.board = selfBoard.board;
        this.self.context = selfBoard.context;
      }
      return this.self;
    }

    let user = this.users.get(idx);
    if (user) return user;

    user = new User(idx, { username: `User ${idx}` });
    this.users.set(idx, user);

    const boardData = this.ui.createUserBoard(idx);
    user.board = boardData.board;
    user.context = boardData.context;
    this.remoteUserHandler?.updateRemotePreviewPresentation?.(user);
    return user;
  }

  /**
   * Whether a broadcast is an echo of our own work that we already applied
   * locally — the condition under which a handler should reconcile the
   * authoritative seq and draw nothing.
   *
   * It is NOT enough to compare session indices. During a sync rebuild we have
   * wiped the board and the server's tail is replaying our own commits as the
   * only surviving copy, so those frames must take the full drawing path. See
   * SyncClient.isRebuilding.
   * @param {number} sessionIndex - Author of the incoming message.
   * @returns {boolean}
   */
  isSelfEcho(sessionIndex) {
    if (sessionIndex !== this.sessionIndex) return false;
    return !this.syncClient?.isRebuilding?.();
  }

  forceCleanupResidualState(sessionIndex) {
    const numericUserId = Number(sessionIndex);
    if (!Number.isFinite(numericUserId)) return;

    this.board.layerManager?.clearUserState?.(numericUserId);
    for (const tool of Object.values(this.toolManager.tools)) {
      if (typeof tool.clearUserState === 'function') {
        tool.clearUserState(numericUserId);
      }
    }
  }

  resetRoomState(options = {}) {
    const preserveRemoteVisuals = options.preserveRemoteVisuals === true;
    const clearBoard = options.clearBoard !== false;

    this.cancelMemoryCompaction();
    this.stopPreviewInterval();
    this.stopCheckpointInterval();
    this.syncClient?.resetForRoomChange?.();
    this.remoteUserHandler?.resetTransientState?.();
    this._resetLocalTransientState();

    const remoteIds = new Set();
    this.users.forEach((_, sessionIndex) => {
      if (sessionIndex !== this.sessionIndex) {
        remoteIds.add(Number(sessionIndex));
      }
    });
    this.ui.remoteUserUI?.cursors?.forEach?.((_, userId) => {
      if (Number(userId) !== Number(this.sessionIndex)) {
        remoteIds.add(Number(userId));
      }
    });

    for (const userId of remoteIds) {
      this.cleanupRemoteUserState(userId, { preserveVisuals: preserveRemoteVisuals, requestUpdate: false });
    }

    if (clearBoard && this.board) {
      this.board.activeSelectionLayer = -1;
      this.board.setMirror(false);
      this.board.setMirrorRegions([]);
      this.board.rebuildRenderingState({ preserveSnapshot: false });
      this._bindLayerManagerDependencies();
      this.toolManager.getTool('fill')?.compactMemory?.({ recycleWorker: true });
      this.remoteUserHandler?.resetTransientState?.();
      this.board.setBackgroundColor('#ffffff');
    }

    this.currentRoomData = null;
    appState.currentRoomData = null;
    this.updateRoomSettingsButtonVisibility();
    this.updateCleanupDebugStats();
  }

  _resetLocalTransientState() {
    if (!this.self) return;

    this.self.clearLine();
    this.self.mousedown = false;
    appState.isDrawingStroke = false;
    this.self.panning = false;
    this.self.penPoints = [];
    this.self._inkPoints = [];
    this.self.remoteTarget = null;

    const penTool = this.toolManager.getTool('flowPen');
    penTool?.clearStroke?.();

    const inkTool = this.toolManager.getTool('ink');
    inkTool?.clearStroke?.();

    const pixelTool = this.toolManager.getTool('pixel');
    pixelTool?.clearStroke?.(this.self);

    const lineTool = this.toolManager.getTool('line');
    if (lineTool) lineTool.startPos = null;
    const rectangleTool = this.toolManager.getTool('rectangle');
    if (rectangleTool) rectangleTool.startPos = null;
    const circleTool = this.toolManager.getTool('circle');
    if (circleTool) circleTool.startPos = null;

    const selectTool = this.toolManager.getTool('select');
    if (selectTool) {
      selectTool.isSelecting = false;
      selectTool.isDragging = false;
      selectTool.startPos = null;
      selectTool.floatingCanvas = null;
      selectTool.floatingCtx = null;
      selectTool.selection = null;
      selectTool.corners = null;
      selectTool.originalCorners = null;
      selectTool.lassoPath = null;
      selectTool._cachedTransform = null;
      selectTool.pendingSelectionBroadcast = null;
    }

    const fillTool = this.toolManager.getTool('fill');
    fillTool?._cancelInteractive?.();

    this.board.cancelStroke(this.self);
    this.board.clearTop();
  }

  getCleanupDebugStats() {
    const remoteBoards = typeof document !== 'undefined' ? document.querySelectorAll('.userBoard').length : 0;
    const remoteCursors = typeof document !== 'undefined' ? document.querySelectorAll('.cursor').length : 0;
    return {
      remoteUsers: [...this.users.keys()].filter((id) => id !== this.sessionIndex).length,
      remoteBoards,
      remoteCursors,
      ...(this.board.layerManager?.getDebugStats?.() || {}),
      ...(this.remoteUserHandler?.getDebugStats?.() || {})
    };
  }

  updateCleanupDebugStats() {
    const stats = this.getCleanupDebugStats();
    if (typeof window !== 'undefined') {
      window.__topDrawCleanupStats = stats;
    }
    return stats;
  }

  /**
   * Handles successful WebSocket connection.
   * @param {number} sessionIndex - The session index assigned by the server.
   * @param {number} role - The user's role level.
   * @param {string} [assignedUsername] - Unique username assigned by server.
   * @param {string} [ipHash] - IP hash for grouping.
   */
  handleWSConnect(sessionIndex, role, assignedUsername, ipHash, connectData = null) {
    if (this.isOfflineMode) return;
    this.cancelMemoryCompaction();

    this.parityClient?.start();

    this.sessionIndex = sessionIndex;
    appState.sessionIndex = sessionIndex;
    this.self.id = sessionIndex;
    this.users.set(sessionIndex, this.self);
    this.board.layerManager.localUserId = sessionIndex;

    if (assignedUsername) {
      this.self.setUsername(assignedUsername);
      this.ui.updateSelfName(assignedUsername);
    }

    if (ipHash) {
      this.self.ipHash = ipHash;
    }

    const hasInitialRoomData = !!(
      connectData?.roomBoardSize ||
      connectData?.boardSize ||
      connectData?.roomFloatingGallerySeed !== undefined ||
      connectData?.roomFloatingGalleryIncludeIds !== undefined ||
      connectData?.roomFloatingGalleryExcludeIds !== undefined ||
      connectData?.floatingGalleryVoronoi !== undefined
    );
    const initialBoardSize = connectData?.roomBoardSize || connectData?.boardSize;
    if (hasInitialRoomData) {
      const nextRoomData = {
        ...(this.currentRoomData || { id: this.currentRoomId })
      };
      if (initialBoardSize) {
        nextRoomData.boardSize = initialBoardSize;
      }
      if (connectData.roomFloatingGallerySeed !== undefined) {
        nextRoomData.floatingGallerySeed = connectData.roomFloatingGallerySeed || 0;
      }
      if (connectData.roomFloatingGalleryIncludeIds !== undefined) {
        nextRoomData.floatingGalleryIncludeIds = connectData.roomFloatingGalleryIncludeIds || [];
      }
      if (connectData.roomFloatingGalleryExcludeIds !== undefined) {
        nextRoomData.floatingGalleryExcludeIds = connectData.roomFloatingGalleryExcludeIds || [];
      }
      if (connectData.floatingGalleryVoronoi !== undefined) {
        nextRoomData.floatingGalleryVoronoi = connectData.floatingGalleryVoronoi || null;
      }
      // Seeded explicitly rather than left to applyRoomTiledCanvas below, which
      // short-circuits when the value already matches and so would leave these
      // undefined for an untiled room — hiding the room-settings checkbox until
      // the first SETTINGS broadcast happened to arrive.
      nextRoomData.tiledCanvas = !!connectData.roomTiledCanvas;
      nextRoomData.tiledCanvasAvailable = !!connectData.roomTiledCanvasAvailable;
      this.currentRoomData = nextRoomData;
      if (initialBoardSize) {
        applyRoomBoardSize(this, initialBoardSize, { showToast: false });
      }
      appState.currentRoomData = { ...this.currentRoomData };
    }
    applyRoomTiledCanvas(this, connectData?.roomTiledCanvas);

    if (role !== undefined) {
      this.selfRole = role;
      this.self.role = role;
      appState.selfRole = role;
      appState.selfGlobalRole = this.wsClient?.globalRole ?? appState.selfGlobalRole ?? role;
      appState.selfRoomRole = this.wsClient?.roomRole ?? appState.selfRoomRole ?? 0;
      if (this.moderation) {
        this.moderation.setRole(role, appState.selfGlobalRole, appState.selfRoomRole);
      }
      this.ui.updateSelfRole(role);
      this.updateAuthenticatedActionVisibility(role);
    }

    if (this.landingPage) {
      this.landingPage.updateConnectionStatus('connected');
    }

    if (this._awaitingServerRestart) {
      this.checkForRuntimeUpdate({ force: true }).finally(() => {
        this._awaitingServerRestart = false;
        // If no update was surfaced, the banner is now stale — hide it.
        if (!this._reloadRecommended) {
          this.ui.hideDisconnectionBanner();
        }
      });
    } else if (this.landingPage && this.landingPage.isVisible) {
      // Generic landing-page reconnect: clear the disconnect banner if it's up.
      if (!this._reloadRecommended) {
        this.ui.hideDisconnectionBanner();
      }
    }

    this.updateRecordingButtonState();

    const isDiscoveryConnection = !this.currentRoomId || this.currentRoomId === '_discovery';
    if (isDiscoveryConnection) {
      if (this.landingPage?.isVisible) {
        void this.checkForRuntimeUpdate({ force: true });
      }

      if (this._pendingLandingLogin) {
        this._pendingLandingLogin = false;
        this.auth?.handleLogin();
      } else if (this._pendingOffline) {
        // Authenticate before entering offline mode
        const hasPassword = !this.auth?.isLoggedIn && this.ui.elements.loginPassword?.value;
        if (hasPassword) {
          this.auth?.handleLogin();
        } else if (this.auth?.attemptAutoLogin()) {
          // Auto-login with stored token; auth result will trigger _enterOfflineMode
        } else {
          // No credentials to try — go offline immediately
          this._pendingOffline = false;
          this._enterOfflineMode();
        }
      }
      return;
    }

    this.wsClient.broadcastToolChange(this.self.tool);
    this.users.set(sessionIndex, this.self);
    this.wsClient.requestRoomList();

    this.syncClient.hasCompletedSync = false;
    this.syncClient.syncing = false;
    this.syncClient.buffering = false;
    this.syncClient.eventBuffer = [];
    if (this.syncClient.syncTimeout) {
      clearTimeout(this.syncClient.syncTimeout);
      this.syncClient.syncTimeout = null;
    }

    this._needsSync = true;

    if (this._pendingPassword && this.self.username) {
      this.wsClient.sendAuthLogin(this.self.username, this._pendingPassword);
      this._pendingPassword = null;
      return;
    }
    this._pendingPassword = null;

    if (this.auth && this.auth.attemptAutoLogin()) {
      return;
    }

    if (this.landingPage && this.self.username) {
      this.handleJoinAfterConnect();
      return;
    }

    this.ui.showLogin();
    this.ui.elements.overlay.style.display = 'flex';
    if (this.self.username) {
      this.ui.elements.loginUsername.value = this.self.username;
    }
  }

  /**
   * Completes the join process after successful connection and authentication.
   */
  handleJoinAfterConnect() {
    this.connected = true;
    appState.connected = true;
    this.ui.setRemoteUsersConnected(true);
    appState.currentRoomId = this.currentRoomId || null;

    // Start the automatic rolling DVR tape the moment we're in a room — even
    // when alone (the solo-join path never fires sync-complete). onSyncComplete
    // re-anchors it to the synced board once sync finishes.
    if (this.currentRoomId && !this.isOfflineMode) {
      this.rollingTapeRecorder?.start(this);
    }
    this.ui.hideOverlay();
    // The board goes live on this line, but the first requestSync() does not
    // fire here — UserHandlers waits for a USERS payload that names another
    // user and then defers 500ms, or falls back to a 2.5s timer when we're
    // alone. Anything drawn in that window lands on a canvas requestSync() is
    // about to wipe. Hold the board behind the sync overlay until then.
    if (this.currentRoomId && !this.isOfflineMode && !this.syncClient?.hasCompletedSync) {
      this.syncClient?.beginPendingSync();
    }
    this.ui.showCursor();
    this.ui.updateSelfName(this.self.username);
    this.ui.showConnectionStatus('connected', this.currentRoomId);
    if (!this._reloadRecommended) {
      this.ui.hideDisconnectionBanner();
    }

    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastFontChange(
      this.self.font,
      this.self.textPositionMultiplier,
      this.self.textPositionOffset
    );
    this.wsClient.broadcastToolChange(this.self.tool);
    this.wsClient.broadcastShapeDrawModeChange(this.self.shapeDrawMode);
    this.wsClient.broadcastSpacingChange(this.self.spacing);
    this.wsClient.broadcastHardnessChange(this.self.hardness);
    this.wsClient.broadcastLayerBlendModeChange(this.self.activeLayer, this.self.blendMode, this.self.blendBakeMode);
    this.wsClient.broadcastLayerChange(this.self.activeLayer);
    this.wsClient.broadcastThinningChange(this.self.thinning);
    this.wsClient.broadcastSimulatePressureChange(this.self.simulatePressure);
    this.wsClient.broadcastPressureTargetsChange(this.self.pressureTargets);
    if (this.self.patternBrush) {
      this.wsClient.broadcastPatternBrush(this._buildPatternPayload());
    }
    if (this.self.imageBrush) {
      this.wsClient.broadcastBrush(this._buildImageBrushPayload());
    }
    if (this.self.confettiBrush) {
      this.wsClient.broadcastConfettiBrush(this._buildConfettiBrushPayload());
    }

    this.moderation.setRole(this.selfRole, appState.selfGlobalRole, appState.selfRoomRole);
    this.inputBufferManager.startTickLoop();

    // Apply pending room settings from "Create Room" dialog
    if (this._pendingRoomSettings) {
      const s = this._pendingRoomSettings;
      this._pendingRoomSettings = null;
      this.wsClient.send({
        t: T.ROOM_UPDATE,
        roomCreatorDeviceId: this.wsClient?.clientIdentity?.deviceId || '',
        roomDescription: s.roomDescription,
        roomBackgroundColor: s.roomBackgroundColor,
        roomLocked: s.roomLocked,
        roomMaxUsers: s.roomMaxUsers,
        roomJoinPolicy: s.roomJoinPolicy,
        roomPrivate: s.roomPrivate,
        roomBoardSize: s.roomBoardSize || s.boardSize
      });
    }

    // Eligibility determined by election or manual pin — let the handler decide
    this._updatePreviewUploadEligibility();

    // Offer the gallery time-lapse opt-in only once the user is actually in a
    // real (online) room — not at login. Role-gated to NOBLE(7)+ inside.
    if (this.currentRoomId && !this.isOfflineMode) {
      this._maybeShowTimelapsePrompt();
    }
  }

  /**
   * Handles a successful same-session resume after a brief disconnect. Skips
   * the full re-sync and broadcast-of-all-tool-state that handleJoinAfterConnect
   * runs, because the server held the user's sessionIndex and peers never saw
   * them leave. The canvas, role, and tool config are still valid locally.
   * @param {number} sessionIndex - Same sessionIndex as before the drop.
   */
  handleWSConnectResumed(sessionIndex) {
    if (this.isOfflineMode) return;
    if (sessionIndex !== this.sessionIndex) {
      console.warn(`[App] CONNECT_RESUMED sessionIndex mismatch (was ${this.sessionIndex}, got ${sessionIndex}); falling back to fresh connect`);
      this.handleWSConnect(sessionIndex);
      return;
    }
    console.log(`[App] Resumed sessionIndex=${sessionIndex} without re-sync`);
    this.connected = true;
    appState.connected = true;
    this.ui.setRemoteUsersConnected(true);
    this.ui.showConnectionStatus('connected', this.currentRoomId);
    this.ui.hideDisconnectionBanner();

    // Tear down any local in-progress stroke so we match the implicit CANCEL
    // the server just broadcast on our behalf — peers dropped their preview
    // of our half-stroke, so keeping it locally would diverge.
    this._resetLocalTransientState();
    this.board.requestUpdate();
  }

  /**
   * Handles a transient WebSocket interruption while the client is silently
   * attempting to reconnect. Flashes the connection-status pill but holds back
   * the loud disconnection banner so brief wifi/proxy blips don't disrupt the
   * user. If the stealth retry window expires, handleWSDisconnect runs instead.
   * @param {number} code
   * @param {string} reason
   */
  handleWSInterrupted(code, reason) {
    if (this.intentionalDisconnect) return;
    if (this.isOfflineMode) return;

    this.ui.setRemoteUsersConnected(false);

    const onLandingPage = this.landingPage
      && this.landingPage.els.landingPage
      && this.landingPage.els.landingPage.style.display !== 'none';

    if (onLandingPage) {
      this.landingPage.updateConnectionStatus('connecting');
    } else {
      this.ui.showConnectionStatus('connecting', this.currentRoomId);
    }
  }

  /**
   * Handles WebSocket disconnection.
   * @param {number} code - Disconnection code.
   * @param {string} reason - Disconnection reason.
   */
  /**
   * Surfaces parity mismatches via an actionable toast. The "Fix" button
   * triggers a targeted resync — the server replays the original bytes for
   * any missing seqs and the strokes apply through the normal pipeline.
   * Phase 3 is opt-in (button); a future phase may auto-fix on low-severity
   * mismatches once we've observed false-positive rates in the wild.
   * The full diff lives on app.debugSync.lastMismatch for post-hoc inspection.
   * @private
   */
  _handleParityMismatch(diff) {
    if (!diff) return;
    this._lastParityMismatch = diff;
    if (this.debugSync) this.debugSync.lastMismatch = diff;
    this.parityPanel?.refresh();

    // While the user is reviewing a replay, the live board is paused and
    // queued (see syncClient + RoomManager.replayQueue) so parity will be
    // perpetually behind. Silence the toast — it'll re-emit naturally if
    // there's still drift after catchUp drains the queue.
    if (this.TimeMachine?.isReviewing) return;

    // Don't surface a toast to the user — just log what's diverging so it can
    // be inspected from the console. Full diff also lives on app._lastParityMismatch.
    console.warn(
      `[parity] Out of sync (${Number(diff.percent || 0).toFixed(1)}%) —`,
      `missing: ${diff.missing?.length || 0},`,
      `extra: ${diff.extra?.length || 0},`,
      `mismatched: ${diff.mismatched?.length || 0}`,
      {
        missing: (diff.missing || []).map((e) => e.seq),
        extra: (diff.extra || []).map((e) => e.seq),
        mismatched: (diff.mismatched || []).map((m) => m.seq),
      }
    );

    // Auto-heal: missing/mismatched seqs are recoverable by replaying the
    // server's authoritative bytes — the resync inserts them at their correct
    // seq position (seq-canonical strokeLog), which restores both the canvas
    // and the parity hash. "Extra" entries are not replayable, so we skip
    // them. Debounced so a persistent mismatch doesn't spam resync requests.
    const recoverable = (diff.missing?.length || 0) + (diff.mismatched?.length || 0);
    if (recoverable > 0) {
      const now = Date.now();
      if (now - (this._lastAutoResyncAt || 0) > 10_000) {
        this._lastAutoResyncAt = now;
        console.warn(`[parity] Auto-resyncing ${recoverable} missing/mismatched seq(s)`);
        this._fixParityMismatch(diff);
      }
      return;
    }

    // Full-sync fallback (Bug B/C): the client is materially behind but the
    // gap is too large/contiguous to enumerate (chunk diff truncated → no
    // recoverable seqs), so targeted byte-replay can't help. Pull a whole
    // fresh canvas from a provider instead. This recovers the *pixels*; the
    // image sync does not reconcile the fingerprint log, so we must avoid
    // re-firing on the resulting static history gap — only re-trigger when the
    // deficit GROWS (a new burst was dropped), not for the constant shortfall.
    const deficit = (diff.serverCount || 0) - (diff.clientCount || 0);
    const FULL_SYNC_MIN_DEFICIT = 50;   // ignore small gaps — not worth a full sync
    const FULL_SYNC_GROWTH = 50;        // only re-sync if we fell further behind
    const FULL_SYNC_COOLDOWN_MS = 30_000;
    if (deficit >= FULL_SYNC_MIN_DEFICIT) {
      const now = Date.now();
      const grewSinceLast = deficit >= (this._lastFullSyncDeficit || 0) + FULL_SYNC_GROWTH;
      const cooledDown = now - (this._lastFullSyncAt || 0) > FULL_SYNC_COOLDOWN_MS;
      const neverSynced = this._lastFullSyncAt === undefined;
      if ((neverSynced || grewSinceLast) && cooledDown && this.syncClient) {
        this._lastFullSyncAt = now;
        this._lastFullSyncDeficit = deficit;
        console.warn(`[parity] Far behind (${deficit} commits, unenumerable) — falling back to full canvas sync`);
        this.ui?.showToast?.('Re-syncing canvas — you had fallen behind', 3000);
        // force:true bypasses the "already completed initial sync" guard.
        this.syncClient.requestSync(null, { force: true });
      }
    }
  }

  /**
   * Request the server replay missing seqs from the most recent mismatch.
   * @private
   */
  _fixParityMismatch(diff) {
    if (!this.parityClient || !diff) return;
    const seqs = [
      ...(diff.missing || []).map(e => e.seq),
      ...(diff.mismatched || []).map(m => m.seq),
    ];
    if (seqs.length === 0) {
      this.ui?.showToast?.('Nothing to replay — try reconnecting if drift persists.', 3000);
      return;
    }
    this.parityClient.requestResync(seqs);
    this.ui?.showToast?.(`Requested replay of ${seqs.length} stroke${seqs.length === 1 ? '' : 's'}`, 2500);
  }

  handleWSDisconnect(code, reason) {
    this.connected = false;
    appState.connected = false;
    this.ui.setRemoteUsersConnected(false);

    this.parityClient?.stop();

    this.stopPreviewInterval();
    this.stopCheckpointInterval();
    this.TimeMachine?.stop();
    // Socket dropped — the rolling tape may now have gaps. Mark it stale (keep
    // capturing) so the Recent view can warn; a successful resync re-anchors it.
    this.rollingTapeRecorder?.markStale('disconnect');
    this.updateRecordingButtonState();

    // Hide remote cursors so they don't sit frozen on the canvas, piled up
    // wherever each user happened to be when the socket dropped. They'll
    // reappear on the next cursor activity once we reconnect.
    this.ui?.remoteUserUI?.cursors?.forEach?.((_, userId) => {
      if (Number(userId) !== Number(this.sessionIndex)) {
        this.ui.hideRemoteCursor(userId);
      }
    });

    // Don't show disconnection UI if disconnect was intentional
    if (this.intentionalDisconnect) {
      this.intentionalDisconnect = false;
      return;
    }

    // Don't show disconnection UI if we're in offline mode
    if (this.isOfflineMode) {
      console.log('[App] Already in offline mode, ignoring disconnect');
      return;
    }

    const onLandingPage = this.landingPage
      && this.landingPage.els.landingPage
      && this.landingPage.els.landingPage.style.display !== 'none';

    if (onLandingPage) {
      this.landingPage.updateConnectionStatus('disconnected');
    } else {
      this.ui.showConnectionStatus('disconnected');
    }

    if (code === 4001 || code === 4002) {
      const label = code === 4001 ? 'Banned' : 'Kicked';
      if (this.auth) {
        this.auth.clearToken();
        this.auth.setRememberMe(false);
      }
      this.showModOverlay(label, reason || '');
    } else if (code === 4009 || String(reason || '').includes('version-mismatch')) {
      void getVersionStatus({ force: true }).then((status) => {
        this.showUpdateRequiredNotice(status?.allowed === false ? status : {
          allowed: false,
          reason: 'version-mismatch',
          clientVersion: window.APP_VERSION,
          latestVersion: String(reason || '').replace(/^version-mismatch:/, '') || 'the latest version',
          minRequired: String(reason || '').replace(/^version-mismatch:/, '') || 'the latest version'
        });
      }).catch(() => {
        this.ui.showDisconnectionBanner({
          message: 'Your app version does not match the server. Refresh before connecting online.',
          icon: '!',
          retryLabel: isTauriDesktop() ? 'Update App' : 'Refresh',
          offlineLabel: 'Continue Offline'
        });
      });
    } else if (code === 4000 || String(reason || '').includes('server-restarting')) {
      this._awaitingServerRestart = true;
      this._versionUpdateNoticed = false;
      // Server is shutting down for a restart. Don't offer a "Reload" yet —
      // the new version isn't live. Show a plain reconnection banner; the
      // reconnect handling will surface the real update prompt once the new
      // server is actually reachable.
      const offlineVisible = !onLandingPage;
      this.ui.showDisconnectionBanner({
        message: onLandingPage
          ? 'Server is restarting. Reconnecting automatically — please wait...'
          : 'Server is restarting. You can keep drawing offline while we reconnect.',
        icon: '!',
        retryVisible: false,
        offlineLabel: 'Draw Offline',
        offlineVisible
      });
    } else if (onLandingPage) {
      // Generic disconnect on landing page — show banner with retry
      this.ui.showDisconnectionBanner({
        message: 'Lost connection to the server. Reconnecting...',
        icon: '!',
        retryLabel: 'Retry Connection',
        retryVisible: true,
        offlineVisible: false
      });
    } else {
      // Show disconnection banner if we're in a room (not on landing page)
      console.log('[App] Showing disconnection banner');
      this.ui.showDisconnectionBanner();
    }
  }

  // --- Update-notice delegates (implementation in ui/UpdateNoticeController.js) ---
  checkForRuntimeUpdate(options) { return this.updateNotices.checkForRuntimeUpdate(options); }
  showUpdateAvailableNotice(versionStatus) { return this.updateNotices.showUpdateAvailableNotice(versionStatus); }
  showUpdateRequiredNotice(versionStatus) { this.updateNotices.showUpdateRequiredNotice(versionStatus); }
  handleServerUpdateNotice(data) { return this.updateNotices.handleServerUpdateNotice(data); }
  _promptDesktopUpdateFromRuntimeNotice(options) { return this.updateNotices._promptDesktopUpdateFromRuntimeNotice(options); }
  _dismissCurrentUpdateForOffline() { this.updateNotices._dismissCurrentUpdateForOffline(); }
  _isUpdateDismissedForOffline(version) { return this.updateNotices._isUpdateDismissedForOffline(version); }

  /**
   * Displays a moderation overlay for kicks or bans.
   * @param {string} title - Overlay title.
   * @param {string} reason - Reason for the moderation action.
   */
  showModOverlay(title, reason) {
    document.getElementById('modOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'modOverlay';
    overlay.className = 'modOverlay';

    const box = document.createElement('div');
    box.className = 'modOverlayBox';

    const heading = document.createElement('h3');
    heading.textContent = title;
    box.appendChild(heading);

    if (reason) {
      const reasonEl = document.createElement('p');
      reasonEl.className = 'modOverlayReason';
      reasonEl.textContent = reason;
      box.appendChild(reasonEl);
    }

    const returnBtn = document.createElement('button');
    returnBtn.className = 'btn';
    returnBtn.id = 'modOverlayReturnBtn';
    returnBtn.textContent = 'Return to Room Selection';
    box.appendChild(returnBtn);

    overlay.appendChild(box);
    document.getElementById('boardContainer')?.appendChild(overlay);

    returnBtn.addEventListener('click', () => {
      overlay.remove();
      this.disconnect();
    });
  }

  /**
   * Handles successful authentication.
   * @param {string} token - The authentication token.
   * @param {number} role - The user's role level.
   * @param {string} username - The user's verified username.
   */
  /**
   * Applies a cosmetic badge selection for the local user: updates the local
   * badge UI immediately and tells the server so it shows for everyone in the
   * room. Persistence is handled by the profile PATCH endpoint separately.
   * @param {string} badgeId - Badge id, or '' to clear.
   */
  applySelfBadge(badgeId) {
    const id = badgeId || '';
    this.self.selectedBadge = id;
    this.ui.updateSelfBadges?.(this.self);
    this.wsClient?.sendBadge?.(id);
  }

  handleAuthSuccess(token, role, username, globalRole = role, roomRole = 0, hasDiscord = false) {
    this.selfRole = role;
    this.self.role = role;
    this.self.hasDiscord = !!hasDiscord;
    appState.selfRole = role;
    appState.selfGlobalRole = globalRole;
    appState.selfRoomRole = roomRole;
    this.self.setUsername(username);
    appState.username = username;

    if (this.ui.elements.loginPassword) this.ui.elements.loginPassword.value = '';

    if (this.moderation) {
      this.moderation.setRole(role, appState.selfGlobalRole, appState.selfRoomRole);
    }

    this.ui.updateSelfRole(role);
    this.ui.updateSelfBadges?.(this.self);

    this.updateRoomSettingsButtonVisibility();
    this.updateGalleryButtonVisibility(role);
    this.updateAuthenticatedActionVisibility(role);

    if (this._pendingOffline) {
      this._pendingOffline = false;
      if (this._offlineAuthTimeout) { clearTimeout(this._offlineAuthTimeout); this._offlineAuthTimeout = null; }
      const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
      this._enterOfflineMode();
      this.ui.showToast(`Logged in as ${username} (${roleNames[role] || 'Guest'})`, 3000);
      return;
    }

    if (this.landingPage && this.landingPage.isVisible) {
      this.landingPage.isAuthenticated = true;
      this.landingPage.authToken = token;
      this.landingPage.username = username;

      // Logged in from the in-room overlay (self context menu → "Log in").
      // We're already drawing in a room, so adopt the account name in place
      // rather than waiting for a fresh join that never comes.
      if (this.connected) {
        this.ui.updateSelfName(username);
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastNameChange(username));
        this.landingPage.closeInRoom();
        const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
        this.ui.showToast(`Logged in as ${username} (${roleNames[role] || 'Guest'})`, 3000);
      }
      return;
    }

    if (this.currentRoomId && this.wsClient.connected) {
      if (this.connected) return;
      this.handleJoinAfterConnect();
      return;
    }

    this.connected = true;
    appState.connected = true;
    this.ui.setRemoteUsersConnected(true);
    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(username);
    this.ui.showConnectionStatus('connected', this.currentRoomId);
    this.ui.hideDisconnectionBanner();

    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastFontChange(
      this.self.font,
      this.self.textPositionMultiplier,
      this.self.textPositionOffset
    );
    this.wsClient.broadcastToolChange(this.self.tool);
    this.wsClient.broadcastShapeDrawModeChange(this.self.shapeDrawMode);
    const activeLayer = this.self.activeLayer;
    this.wsClient.broadcastLayerBlendModeChange(activeLayer, this.self.blendMode, this.self.blendBakeMode);
    this.wsClient.broadcastLayerChange(activeLayer);
    this.wsClient.broadcastThinningChange(this.self.thinning);
    this.wsClient.broadcastSimulatePressureChange(this.self.simulatePressure);
    this.wsClient.broadcastPressureTargetsChange(this.self.pressureTargets);
    if (this.self.patternBrush) {
      this.wsClient.broadcastPatternBrush(this._buildPatternPayload());
    }
    if (this.self.imageBrush) {
      this.wsClient.broadcastBrush(this._buildImageBrushPayload());
    }
    if (this.self.confettiBrush) {
      this.wsClient.broadcastConfettiBrush(this._buildConfettiBrushPayload());
    }

    this.moderation.setRole(role, appState.selfGlobalRole, appState.selfRoomRole);
    this.inputBufferManager.startTickLoop();
    this.syncClient.requestSync();

    const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    this.ui.showToast(`Logged in as ${username} (${roleNames[role] || 'Guest'})`, 3000);
  }

  _showSelfContextMenu(e) {
    const menu = document.getElementById('selfContextMenu');
    if (!menu) return;
    menu.dataset.tut = 'context-menu';

    const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    const role = this.selfRole || 0;
    const nameEl = document.getElementById('selfRoleName');
    if (nameEl) {
      nameEl.textContent = roleNames[role] || 'Guest';
      nameEl.className = 'selfRoleName';
      const rankClass = role >= 9 ? 'rank-deity' : role >= 8 ? 'rank-holy' : role >= 7 ? 'rank-noble'
        : role >= 5 ? 'rank-admin' : role >= 4 ? 'rank-mod' : role >= 3 ? 'rank-helper'
        : role >= 2 ? 'rank-trusted'
        : role >= 1 ? 'rank-user' : 'rank-guest';
      if (rankClass) nameEl.classList.add(rankClass);
    }

    const profileBtn = document.getElementById('selfProfileBtn');
    if (profileBtn) {
      const canShowProfile = this.selfRole >= 1 && (this.self.registeredName || this.self.username);
      profileBtn.style.display = canShowProfile ? '' : 'none';
      profileBtn.onclick = () => {
        menu.style.display = 'none';
        showProfileDialog(this.self.registeredName || this.self.username);
      };
    }

    // Guests get a way into the login form without leaving the room.
    const loginBtn = document.getElementById('selfLoginBtn');
    if (loginBtn) {
      loginBtn.style.display = this.auth?.isLoggedIn ? 'none' : '';
      loginBtn.onclick = () => {
        menu.style.display = 'none';
        this.openLoginFromRoom();
      };
    }

    menu.style.display = 'flex';
    const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 10);
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  /**
   * Handles authentication errors.
   * @param {string} error - The error message.
   */
  handleAuthError(error) {
    if (this._pendingOffline) {
      this._pendingOffline = false;
      if (this._offlineAuthTimeout) { clearTimeout(this._offlineAuthTimeout); this._offlineAuthTimeout = null; }
      console.log('[App] Auth failed before offline mode:', error);
      this._enterOfflineMode();
      return;
    }

    if (this.isOfflineMode) return;

    if (this.landingPage) {
      this.syncClient.hideOverlay();
      this.landingPage.show();
      this.landingPage.showError(error);
      this.ui.elements.overlay.style.display = 'flex';
      return;
    }

    this.ui.showToast(error, 4000, 'error');
  }

  /**
   * Handles the join request from the login dialog.
   */
  async handleJoin() {
    if (this.landingPage && this.landingPage.isVisible) {
      void this.startLandingJoin();
      return;
    }

    await this.whenRoomModulesReady();

    let name = this.auth?.getJoinUsername();
    if (!name) {
      name = this.ui.elements.loginUsername?.value.trim();
    }
    if (!name) {
      let tabId = sessionStorage.getItem('tabId');
      if (!tabId) {
        tabId = Math.random().toString(36).substring(2, 8);
        sessionStorage.setItem('tabId', tabId);
      }
      name = `Guest-${tabId}`;
    }
    this.self.setUsername(name);

    const password = (!this.auth?.isLoggedIn && this.ui.elements.loginPassword?.value) || '';
    this._pendingPassword = password || null;

    this.connected = true;
    appState.connected = true;
    this.ui.setRemoteUsersConnected(true);
    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(name);
    this.ui.showConnectionStatus('connected', this.currentRoomId);
    this.ui.hideDisconnectionBanner();

    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastFontChange(
      this.self.font,
      this.self.textPositionMultiplier,
      this.self.textPositionOffset
    );
    this.wsClient.broadcastToolChange(this.self.tool);
    this.wsClient.broadcastShapeDrawModeChange(this.self.shapeDrawMode);
    const activeLayer = this.self.activeLayer;
    this.wsClient.broadcastLayerBlendModeChange(activeLayer, this.self.blendMode, this.self.blendBakeMode);
    this.wsClient.broadcastLayerChange(activeLayer);
    this.wsClient.broadcastThinningChange(this.self.thinning);
    this.wsClient.broadcastSimulatePressureChange(this.self.simulatePressure);
    this.wsClient.broadcastPressureTargetsChange(this.self.pressureTargets);
    if (this.self.patternBrush) {
      this.wsClient.broadcastPatternBrush(this._buildPatternPayload());
    }
    if (this.self.imageBrush) {
      this.wsClient.broadcastBrush(this._buildImageBrushPayload());
    }
    if (this.self.confettiBrush) {
      this.wsClient.broadcastConfettiBrush(this._buildConfettiBrushPayload());
    }

    if (this.ui.elements.selfUserEntry) {
      this.ui.elements.selfUserEntry.dataset.sessionIndex = this.sessionIndex;
    }

    this.moderation.setRole(this.selfRole, appState.selfGlobalRole, appState.selfRoomRole);
    this.inputBufferManager.startTickLoop();
    this.syncClient.requestSync();
  }

  /**
   * Opens the login form on top of the current room. The landing overlay runs
   * in `inRoom` mode, so dismissing it returns to the board without
   * disconnecting, and a successful login is adopted in place.
   */
  openLoginFromRoom() {
    if (!this.landingPage) return;
    this.landingPage.show({ inRoom: true, login: true });
    setActiveAuthTab('signin', { focus: true });
  }

  /**
   * Starts local drawing mode without a server connection.
   */
  startOfflineMode() {
    this.connected = true;
    this.ui.setRemoteUsersConnected(false);
    this.sessionIndex = 1;
    this.self.id = 1;
    const username = this.auth?.getJoinUsername() || this.ui.elements.loginUsername?.value || '';
    this.self.setUsername(username);

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(this.self.username);
    this.ui.hideConnectionStatus();

    this.inputBufferManager.startTickLoop();

    if (this.wsClient && this.wsClient.disconnect) {
      this.wsClient.disconnect();
    }
  }

  /**
   * Attempts to reconnect to the last used room.
   * @async
   * @returns {Promise<void>}
   */
  async reconnect() {
    this.ui.showConnectionStatus('connecting');
    this.ui.setRemoteUsersConnected(false);

    if (this.wsClient) {
      this.wsClient.disconnect();
    }

    try {
      // Try to preserve the room from currentRoomId, or fall back to URL
      let reconnectRoomId = this.currentRoomId;
      if (!reconnectRoomId || reconnectRoomId === '_discovery') {
        const urlRoom = this.landingPage?.getRoomFromURL();
        reconnectRoomId = urlRoom || 'lobby';
      }
      await this.wsClient.connect(this.self.toJSON(), reconnectRoomId);
      // Connection successful - banner will be hidden by handleJoinAfterConnect
    } catch (err) {
      console.error('Reconnect failed:', err);
      this.ui.showConnectionStatus('disconnected');
      this.ui.setRetryButtonState(false);
      throw err; // Re-throw so handleRetryConnection knows it failed
    }
  }

  /**
   * Handles retry connection button click from disconnection banner.
   */
  async handleRetryConnection() {
    if (this._reloadRecommended) {
      if (isTauriDesktop()) {
        await this._promptDesktopUpdateFromRuntimeNotice({ force: true });
        return;
      }

      window.location.reload();
      return;
    }

    this.ui.setRetryButtonState(true);

    try {
      await this.checkForRuntimeUpdate({ force: true });
      if (this._reloadRecommended) {
        this.ui.setRetryButtonState(false);
        return;
      }
      await this.reconnect();
      // On success, banner will be hidden by handleJoinAfterConnect
    } catch (err) {
      // reconnect() already resets button state on error
      console.log('[App] Retry connection failed, user can try again');
    }
  }

  /**
   * Handles switch to offline mode button click from disconnection banner.
   */
  handleSwitchToOffline() {
    if (this._reloadRecommended) {
      this._dismissCurrentUpdateForOffline();
    }
    this.ui.hideDisconnectionBanner();
    this.handleOffline();
  }

  ensureAppSettingsButton() {
    const collapsible = document.getElementById('collapsibleBtns');
    if (!collapsible || document.getElementById('appSettingsBtn')) return;

    const appSettingsBtn = document.createElement('a');
    appSettingsBtn.className = 'btn';
    appSettingsBtn.id = 'appSettingsBtn';
    appSettingsBtn.dataset.tut = 'perf-settings';
    appSettingsBtn.innerHTML = `
      <span class="btnText">Settings</span>
      <span class="btnIcon" style="display: none;"><img src="../images/settings-icon.svg" alt="Settings"></span>
    `;
    collapsible.appendChild(appSettingsBtn);
    this.scheduleTopbarCollapseUpdate();
  }

  scheduleTopbarCollapseUpdate() {
    if (this._topbarCollapseFrame) {
      cancelAnimationFrame(this._topbarCollapseFrame);
    }

    this._topbarCollapseFrame = requestAnimationFrame(() => {
      this._topbarCollapseFrame = null;
      this.updateTopbarCollapseState();
    });
  }

  updateTopbarCollapseState() {
    // Mobile: the bar is permanently collapsed via CSS and buttons are
    // relocated into the hamburger — measurement would fight that layout.
    if (isMobile()) return;

    const toolbar = document.querySelector('.boardBtns');
    if (!toolbar) return;

    toolbar.classList.remove(
      'force-right-icon-collapse',
      'force-left-icon-collapse',
      'force-menu-collapse'
    );

    const isOverflowing = () => toolbar.scrollWidth - toolbar.clientWidth > 1;

    if (isOverflowing()) {
      toolbar.classList.add('force-right-icon-collapse');
    }

    if (isOverflowing()) {
      toolbar.classList.add('force-left-icon-collapse');
    }

    if (isOverflowing()) {
      toolbar.classList.add('force-menu-collapse');
    } else {
      this.ui?.closeMenu?.();
    }
  }

  handleAppSettings() {
    appState.appSettingsTab = appState.appSettingsTab || 'general';
    appState.appSettingsVisible = true;
  }

  /**
   * Resolve the tri-state low power preference to a boolean.
   *
   * 'auto' defers to device detection. This used to be a plain boolean read,
   * which silently overwrote whatever detectLowPowerDevice() had decided at
   * construction and made the detection dead code — see
   * docs/board_size_lag_plan_2026-08-23.md F2.
   *
   * @returns {boolean}
   */
  isLowPowerModeActive() {
    const pref = this.appPreferences?.general?.lowPowerMode ?? 'auto';
    if (pref === 'on' || pref === true) return true;
    if (pref === 'off' || pref === false) return false;
    return detectLowPowerDevice();
  }

  _applyLowPowerPreference() {
    const lowPowerEnabled = this.isLowPowerModeActive();
    // Input ticks and board redraws run at full rate even in low power: halving
    // either made drawing feel sluggish for too little saving. Low power instead
    // trims the local-only work below, and the flag still reaches the server via
    // inputBufferManager.lowPowerMode (keeps weak clients off uploader duty).
    if (this.inputBufferManager) {
      if (this.inputBufferManager.tickRate !== NORMAL_TPS) {
        this.inputBufferManager.setTickRate(NORMAL_TPS);
      }
      this.inputBufferManager.lowPowerMode = lowPowerEnabled;
    }

    if (this.board && this.board.targetFPS !== 0) {
      this.board.setTargetFPS(0);
    }

    // Fan the resolved flag out to the local-only paths that trim themselves on
    // weak hardware: selection ant pacing, the rolling tape's scrub thumbnails,
    // and [data-low-power] CSS. None of them changes committed pixels, so
    // clients still agree with each other.
    if (this.board) this.board.lowPowerMode = lowPowerEnabled;
    // Re-evaluate the zoom auto-show so a viewer it opened closes right away.
    if (this.board) this.boardViewer?.setMainZoom(this.board.zoom);
    this.rollingTapeRecorder?.setLowPower?.(lowPowerEnabled);
    if (typeof document !== 'undefined') {
      if (lowPowerEnabled) document.documentElement.dataset.lowPower = 'true';
      else delete document.documentElement.dataset.lowPower;
    }
  }

  /**
   * True when the user has traded the always-on background capture systems away
   * for frame-time smoothness (Settings -> Reduce Background Work). Read live
   * rather than cached: the parity client's `shouldPause` closure consults it on
   * every heartbeat, so flipping the toggle takes effect without a reconnect.
   * @returns {boolean}
   */
  isBackgroundWorkReduced() {
    return !!this.appPreferences?.general?.reduceBackgroundWork;
  }

  /**
   * Starts or stops the periodic gallery time-lapse capture to match the
   * preference. The rolling tape and parity heartbeat are handled by
   * `_applyReplayPreferences()` and the parity `shouldPause` closure.
   */
  _applyBackgroundWorkPreference() {
    if (!this.timelapseCapturer) return;
    // Low power also pauses it: each capture is a full-board still plus a WebP
    // encode every 6s, and it only exists to decorate a gallery upload.
    if (this.isBackgroundWorkReduced() || this.isLowPowerModeActive()) {
      this.timelapseCapturer.stop();
    } else {
      this.timelapseCapturer.start();
    }
  }

  _applyReplayPreferences() {
    const replay = this.appPreferences?.general?.replay ?? {};
    this.recorder?.configure?.({
      checkpointIntervalMs: replay.manualSnapshotIntervalMs,
      maxLengthMs: replay.manualMaxLengthMs
    });

    const rollingEnabled = replay.rollingEnabled !== false && !this.isBackgroundWorkReduced();
    this.rollingTapeRecorder?.configure?.({
      enabled: rollingEnabled,
      windowMs: replay.rollingWindowMs
    });

    if (
      rollingEnabled &&
      this.currentRoomId &&
      !this.isOfflineMode &&
      this.rollingTapeRecorder &&
      !this.rollingTapeRecorder.isEnabled?.()
    ) {
      this.rollingTapeRecorder?.start(this);
    }
  }

  setAppPreferences(preferences) {
    this.appPreferences = saveAppPreferences(preferences);
    applyThemeColors(this.appPreferences?.general?.themeColors);
    applySidebarSide(this.appPreferences?.general?.sidebarSide);
    applyChatOpacity(this.appPreferences?.general?.chatOpacity);
    applyLocalBoardBackgroundOverride(
      this.board,
      this.appPreferences?.general?.localBoardBackgroundColor,
      this.appPreferences?.general?.localBoardBackgroundEnabled !== false
    );
    this.ui.setHideOwnLabelZoom(this.appPreferences?.general?.hideOwnLabelAbove150);
    this.board?.setShowRawPixelsAtHighZoom?.(this.appPreferences?.general?.showRawPixelsAtHighZoom);
    const desyncChangeNeedsRefresh = this.board?.setUseDesynchronizedBoardContexts?.(this.appPreferences?.general?.useDesynchronizedBoardContexts);
    if (desyncChangeNeedsRefresh) {
      this.ui?.showToast?.('Low-latency canvas setting will apply after refresh', 3500);
    }
    this._applyLowPowerPreference();
    this._applyBackgroundWorkPreference();
    this._applyViewportCullingPreference();
    this._applyWindowedSurfacesPreference();
    this._applyReplayPreferences();
    this.refreshDebugButton();
    appState.appPreferences = this.appPreferences;
    return this.appPreferences;
  }

  /**
   * Push the viewport-culling preference onto the board.
   *
   * Turning it OFF has to repair immediately: viewCanvas may be carrying stale
   * pixels outside the last visible box, and with culling off nothing would
   * ever ask for the repair again — the board would keep a permanently wrong
   * region until the next unrelated full composite.
   * @private
   */
  _applyViewportCullingPreference() {
    const board = this.board;
    if (!board) return;
    const enabled = !!this.appPreferences?.general?.viewportCulling;
    if (board.viewportCulling === enabled) return;
    board.viewportCulling = enabled;
    if (!enabled) board.ensureFullComposite?.();
  }

  /**
   * Push the windowed-surfaces preference onto the board.
   *
   * Either direction re-points every display surface, so it goes through the
   * board's own forced sync rather than being poked in: turning it ON shrinks
   * the backing stores and installs the window transform, turning it OFF
   * restores the whole board at 1:1. Both leave the surfaces holding nothing,
   * which the forced sync's invalidation covers.
   * @private
   */
  _applyWindowedSurfacesPreference() {
    const board = this.board;
    if (!board) return;
    const enabled = !!this.appPreferences?.general?.windowedSurfaces;
    if (board.windowedSurfaces === enabled) return;
    board.windowedSurfaces = enabled;
    board._syncSurfaceWindow?.({ force: true });
  }

  requestRefreshUnloadWarning() {
    this._warnOnNextUnload = true;
  }

  /**
   * Opens the room settings dialog.
   */
  handleRoomSettings() {
    // Offline (Draw Alone): there's no server room behind this, so open a
    // synthetic local room object instead of waiting on SETTINGS that will
    // never arrive. RoomSettings.svelte reads roomData.offline to show only
    // the fields that apply locally (background colour) and Save applies
    // them straight to the board.
    if (this.isOfflineMode) {
      appState.currentRoomData = { id: this.currentRoomId, offline: true };
      appState.selfRole = this.selfRole;
      appState.username = this.self?.username || '';
      appState.roomSettingsVisible = true;
      return;
    }

    if (!this.currentRoomData) {
      this.ui.showToast('Room data not loaded yet', 3000);
      return;
    }

    const hasOwner = !!this.currentRoomData?.ownerId;
    const canEdit = this.canEditCurrentRoomSettings();

    if (!canEdit) {
      this.ui.showToast('Only room owner or moderators can edit settings', 3000);
      return;
    }

    // Update stores and show dialog
    appState.currentRoomData = this.currentRoomData;
    appState.selfRole = this.selfRole;
    appState.username = this.self?.username || '';
    appState.roomSettingsVisible = true;
  }

  canEditCurrentRoomSettings() {
    if (this.isOfflineMode) return true;
    if (!this.currentRoomData || !this.wsClient?.connected || !this.currentRoomId) return false;
    const globalish = Math.max((appState.selfGlobalRole || 0), this.selfRole || 0);
    if (globalish >= 8) return true;
    const hasOwner = !!this.currentRoomData.ownerId;
    if (hasOwner) {
      return this.currentRoomData.ownerUsername === this.self?.username
        || (appState.selfRoomRole || 0) >= 5;
    }
    return this.wasCurrentRoomCreatedByThisBrowser();
  }

  /**
   * Reads locally-persisted offline (Draw Alone) room settings.
   * Keyed by browser, not by room id — offline rooms are re-generated every
   * session (`offline-<timestamp>`), so there is no per-room id to key off.
   * @returns {object|null}
   */
  getOfflineRoomSettings() {
    try {
      const raw = localStorage.getItem('topDrawOfflineRoomSettings');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /**
   * Merges and persists offline room settings for the next Draw Alone session.
   * @param {object} settings
   */
  saveOfflineRoomSettings(settings) {
    try {
      const existing = this.getOfflineRoomSettings() || {};
      localStorage.setItem('topDrawOfflineRoomSettings', JSON.stringify({ ...existing, ...settings }));
    } catch {
      // localStorage unavailable (private mode, quota) — settings just won't persist.
    }
  }

  wasCurrentRoomCreatedByThisBrowser() {
    const roomId = this.currentRoomId || this.currentRoomData?.id;
    if (!roomId) return false;
    try {
      const createdRooms = JSON.parse(localStorage.getItem('topDrawCreatedRooms') || '{}');
      return !!createdRooms[roomId];
    } catch {
      return false;
    }
  }

  /**
   * Registers the current user as room owner.
   */
  handleRegisterRoom() {
    if (this.selfRole < 1) {
      this.ui.showToast('You must be logged in to register a room', 3000);
      return;
    }

    if (this.currentRoomData?.ownerId) {
      this.ui.showToast('This room already has an owner', 3000);
      return;
    }

    this.wsClient.send({ t: T.ROOM_REGISTER });

    // Optimistically update local room data
    if (this.self?.username) {
      if (!this.currentRoomData) {
        this.currentRoomData = { id: this.currentRoomId };
      }
      this.currentRoomData.ownerId = 'self';
      this.currentRoomData.ownerUsername = this.self.username;
      this.updateRoomSettingsButtonVisibility();
    }

    this.ui.showToast('Registering room...');
  }

  /**
   * Updates the visibility of room settings and register buttons based on user permissions.
   */
  updateRoomSettingsButtonVisibility() {
    const settingsBtn = document.getElementById('roomSettingsBtn');
    const registerBtn = document.getElementById('registerRoomBtn');

    // Use wsClient.connected instead of this.connected since this.connected
    // may not be set yet when auth completes
    // Offline (Draw Alone): there's no server room to register or own, so
    // Register Room never applies. Room Settings still opens — handleRoomSettings()
    // shows an offline-safe local subset — since there's no server round trip to wait on.
    if (this.isOfflineMode) {
      if (settingsBtn) settingsBtn.style.display = 'inline-flex';
      if (registerBtn) registerBtn.style.display = 'none';
      appState.roomCreatedByThisBrowser = false;
      this.scheduleTopbarCollapseUpdate();
      return;
    }

    const isConnected = this.wsClient?.connected && this.currentRoomId;

    if (!isConnected) {
      if (settingsBtn) settingsBtn.style.display = 'none';
      if (registerBtn) registerBtn.style.display = 'none';
      appState.roomCreatedByThisBrowser = false;
      this.scheduleTopbarCollapseUpdate();
      return;
    }

    const isLoggedIn = this.selfRole >= 1;
    const isDeity = Math.max((appState.selfGlobalRole || 0), this.selfRole || 0) >= 8;

    // Wait for SETTINGS or room-list data before exposing ownership actions.
    // Registered rooms include owner data in SETTINGS, so this avoids a stale
    // "Register Room" flash while the client is still learning room metadata.
    if (!this.currentRoomData) {
      if (settingsBtn) settingsBtn.style.display = 'none';
      if (registerBtn) registerBtn.style.display = 'none';
      appState.roomCreatedByThisBrowser = this.wasCurrentRoomCreatedByThisBrowser();
      this.scheduleTopbarCollapseUpdate();
      return;
    }

    const hasOwner = !!this.currentRoomData.ownerId;
    const createdByThisBrowser = this.wasCurrentRoomCreatedByThisBrowser();
    const canEdit = this.canEditCurrentRoomSettings();
    appState.roomCreatedByThisBrowser = createdByThisBrowser;

    // Show Register Room button if room is unregistered and user is logged in
    if (registerBtn) {
      registerBtn.style.display = (!hasOwner && isLoggedIn) ? 'inline-block' : 'none';
    }

    // Show Room Settings button for registered room editors or this browser's unowned created rooms.
    if (settingsBtn) {
      settingsBtn.style.display = canEdit ? 'inline-flex' : 'none';
    }

    this.scheduleTopbarCollapseUpdate();
  }

  /**
   * Shows or hides the "Save to Gallery" section in the save overlay based on auth role.
   * @param {number} role - The user's role level.
   */
  updateGalleryButtonVisibility(role) {
    const el = this.ui.elements.saveModeGallery;
    if (!el) return;
    el.style.display = role >= 1 ? '' : 'none';
  }

  updateAuthenticatedActionVisibility(role = this.selfRole) {
    const isAuthenticated = role >= 1;
    const { adminTopBtn, inboxBtn, uploadBtn } = this.ui.elements;

    if (adminTopBtn) {
      adminTopBtn.style.display = role >= 9 ? '' : 'none';
    }

    // Warm the admin chunk as soon as the server confirms a Deity role, so the
    // panel opens instantly. No other account ever fetches it.
    void preloadAdminModules(role);

    if (inboxBtn) {
      inboxBtn.style.display = isAuthenticated ? '' : 'none';
    }

    if (uploadBtn) {
      uploadBtn.style.display = isAuthenticated ? '' : 'none';
    }

    if (!isAuthenticated) {
      appState.messengerVisible = false;
    }

    this.scheduleTopbarCollapseUpdate();
  }

  // --- Recording/timeline delegates (implementation in ui/RecordingController.js) ---
  updateRecordingButtonState() { this.recording?.updateRecordingButtonState(); }
  startTapeRecording() { return this.recording?.startTapeRecording(); }
  stopTapeRecording() { return this.recording?.stopTapeRecording(); }
  handleToggleTapeRecording() { return this.recording?.handleToggleTapeRecording(); }
  handleStartRecording() { this.recording?.handleStartRecording(); }

  canUseImageFeatures(showToast = false) {
    const allowed = this.selfRole >= 1;
    if (!allowed && showToast) {
      this.ui?.showToast('Only registered users can upload, copy, or paste images', 3000);
    }
    return allowed;
  }

  // --- Save/export delegates (implementation in ui/SaveController.js) ---
  openSaveDialog() { this.saveController.openSaveDialog(); }
  openSaveDialogForCanvas(sourceCanvas) { this.saveController.openSaveDialogForCanvas(sourceCanvas); }
  closeSaveDialog() { this.saveController.closeSaveDialog(); }
  performSave(locally) { return this.saveController.performSave(locally); }
  handleSaveToGallery(canvas, metadata) { return this.saveController.handleSaveToGallery(canvas, metadata); }
  _maybeShowTimelapsePrompt() { this.saveController._maybeShowTimelapsePrompt(); }
  canUseGalleryTimelapse() { return this.saveController.canUseGalleryTimelapse(); }
  saveCanvasLocally(canvas, suggestedName, successMessage) { return this.saveController.saveCanvasLocally(canvas, suggestedName, successMessage); }
  copyCanvasToClipboard(canvas, options) { return this.saveController.copyCanvasToClipboard(canvas, options); }
  copyImageDataToClipboard(clipboardData, options) { return this.saveController.copyImageDataToClipboard(clipboardData, options); }

  /**
   * Handles floating art updates from the server
   * @param {Object} item - The gallery item to display as floating art
   */
  handleFloatingArtUpdate(item) {
    // Forward to the FloatingArtManager component if it exists
    if (this.components?.floatingArt?.addItem) {
      this.components.floatingArt.addItem(item);
    }
  }

  /**
   * Opens the room browser overlay on top of the current room WITHOUT
   * disconnecting. Reuses the landing page UI in an embedded "in-room" mode
   * so the user can switch rooms or dismiss to return to the current board.
   */
  openRoomsBrowser() {
    if (!this.landingPage) return;
    this.landingPage.show({ inRoom: true });
    // Request the live room list over the current room connection and preselect
    // the room we're already in.
    this.landingPage.refreshRooms();
    if (this.currentRoomId) {
      this.landingPage.selectRoom(this.currentRoomId);
    }
  }

  /**
   * Disconnects from the current room and returns to the landing page.
   * @async
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this.inputBufferManager) {
      this.inputBufferManager.stopTickLoop();
    }

    this.resetRoomState({ preserveRemoteVisuals: false, clearBoard: true });
    this.users.clear();
    if (this.self) {
      this.users.set(this.sessionIndex, this.self);
    }

    this.connected = false;
    this.isOfflineMode = false;
    appState.connected = false;
    this.ui.setRemoteUsersConnected(false);
    this.sessionIndex = null;
    appState.sessionIndex = null;
    if (this.self) this.self.id = null;
    this.currentRoomData = null;

    this.updateRoomSettingsButtonVisibility();

    this.ui.hideCursor();
    this.ui.hideConnectionStatus();
    this.ui.hideDisconnectionBanner();

    if (this.wsClient && this.wsClient.connected) {
      this.intentionalDisconnect = true;
      this.wsClient.disconnect();
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (this.landingPage) {
      this.landingPage.show();
      const urlRoom = this.landingPage.getRoomFromURL();
      this.landingPage.selectRoom(urlRoom || 'lobby');
    }

    this.connectForRoomDiscovery();
  }

  /**
   * Selects a tool and updates application state and UI.
   * @param {string} tool - The name of the tool to select.
   */
  selectTool(tool) {
    // Mobile trims these tools from the UI; block activation here too so
    // keyboard shortcuts (BT keyboards) can't reach them. Remote users
    // drawing with them still render — only local selection is gated.
    if (isMobile() && MOBILE_HIDDEN_TOOLS.includes(tool)) return;

    this.clearActiveCustomPreset();
    if (this.self.tool === 'pan') {
      this.self.panning = false;
    }
    if (this.self.tool === 'zoom') {
      this._rightDragZoomActive = false;
      this._rightDragZoomPointerId = null;
    }
    if (this.self.tool === 'rotate') {
      this._rotateToolActive = false;
      this._rotatePrevAngle = null;
    }

    if (this.self.mousedown) {
      if (this.self.tool === 'brush' && this.self.currentLine.length > 0) {
        const brushTool = this.toolManager.getTool('brush');
        brushTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
      } else if (this.self.tool === 'flowPen' && this.self.penPoints && this.self.penPoints.length > 0) {
        const penTool = this.toolManager.getTool('flowPen');
        penTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
      } else if (this.self.tool === 'ink') {
        const inkTool = this.toolManager.getTool('ink');
        if (inkTool && inkTool.inputPoints && inkTool.inputPoints.length > 0) {
          inkTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
        }
      } else if (this.self.tool === 'blur' || this.self.tool === 'circleBlur' || this.self.tool === 'glitchBlur') {
        const blurTool = this.toolManager.getTool(this.self.tool);
        if (blurTool) {
          blurTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
        }
      }
      this.self.mousedown = false;
      appState.isDrawingStroke = false;
      this._queueStrokeEndBroadcast();
    }

    const previousTool = this.self.tool;

    // Handle inkdropper and text tool previousTool logic
    if ((tool === 'inkdropper' || tool === 'text') && previousTool !== 'inkdropper' && previousTool !== 'text') {
      // Switching TO inkdropper/text - always remember the previous tool
      this.previousTool = previousTool;
    } else if ((previousTool === 'inkdropper' || previousTool === 'text') && tool !== this.previousTool) {
      // Switching FROM inkdropper/text to a different tool (not the previous one)
      this.previousTool = null;
    } else if (previousTool !== 'inkdropper' && previousTool !== 'text' && tool !== 'inkdropper' && tool !== 'text' && this.previousTool) {
      // Normal tool switching (not involving inkdropper or text)
      this.previousTool = null;
    }

    if (previousTool === 'zoom' && tool !== 'zoom' && this._temporaryZoomPreviousTool) {
      this._temporaryZoomPreviousTool = null;
    }

    if (previousTool && this.toolLockManager.toolLocks[previousTool]) {
      this.toolLockManager.saveCurrentValues(previousTool);
    }

    if (this.mirrorRegionController?.isActive()) {
      this.mirrorRegionController.cancel();
    }

    this.brushModeManager.updateModeFromTool(tool);

    if (previousTool === 'text' && tool !== 'text') {
      this.self._pendingTextPos = null;
      this.self._pendingTextPointerType = null;
      this.ui.updateSelfTextInput('');
      if (this.ui.elements.selfTextInput) {
        this.ui.elements.selfTextInput.style.visibility = '';
      }
      if (this.ui.elements.touchInput) {
        this.ui.elements.touchInput.value = ' ';
        this.ui.elements.touchInput.blur();
      }
      this.board.clearTop();
    }

    this.applyCursorStyleForTool(tool);
    this.self.setTool(tool);
    appState.currentTool = tool;
    // Keep the image-selector window's fill/select pattern triggers in sync with
    // each tool's live patternMode (covers preset restores that bypass the checkbox).
    appState.fillPatternEnabled = !!this.toolManager.getTool('fill')?.patternMode;
    appState.selectionPatternEnabled = !!this.toolManager.getTool('select')?.patternMode;

    // Restore locked tool values before activation so any activate-time preview
    // uses the new tool's resolved settings instead of the previous tool's state.
    if (this.toolLockManager.toolLocks[tool]) {
      this.toolLockManager.restoreToolValues(tool);
    }

    this.toolManager.setTool(tool);

    // Announce the tool change AFTER setTool(), not before it. setTool() runs the
    // outgoing tool's deactivate(), and SelectTool.deactivate() commits any
    // floating selection — queueing the CT first put it AHEAD of that commit in
    // the FIFO broadcast queue, so the wire order was CT then SEL_COMMIT. Remotes
    // cancel a floating selection the moment they see a CT away from 'select'
    // (DrawingHandlers 'ct' -> handleSelectionCancel, which also restores the
    // lift-erase), and the SEL_COMMIT that followed then found no floatingCanvas
    // and silently no-op'd (RemoteSelectionHandler.handleSelectionCommit). 'ct' is
    // not in wrapHandler's allowSelf list, so the drawer never cancelled its own
    // copy: ending a selection by picking another tool — the most common way there
    // is — kept the paste/move for the drawer and reverted it on every peer.
    // The settings broadcasts from restoreToolValues/activate now precede the CT;
    // that is inert because the whole sequence drains in one tick with no drawing
    // between, whereas CT-before-commit destroys content.
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastToolChange(tool, tool === 'erase' ? this.eraseAllLayers : false));
    }

    this.ui.updateToolDisplay(tool, this.self);
    this.applyBlurRadiusLimitForTool(tool, { broadcast: this.connected });
    this._updateBlurCannotDraw();

    if (tool === 'pan') {
      if (this.connected) this.broadcastCursorVisibility(false);
    } else if (previousTool === 'pan') {
      if (this.connected) this.broadcastCursorVisibility(true);
    }

    if (tool === 'text') {
      this.ui.updateSelfTextStyle(this.self.size, this.self.color, this.self.font);
      this._updateTextPreview();
    }

    if (tool === 'imageBrush') {
      if (this.self.imageBrush) {
        const brush = this.self.imageBrush;
        if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
          this.ui.setBrushPreview(brush.gBrushes[0].gimpUrl);
        } else {
          this.ui.setBrushPreview(brush.previewUrl || brush.gimpUrl);
        }
      } else {
        // First time picking Image Brush: default to pepper, same as clicking
        // its gallery tile, rather than leaving no brush selected.
        this.brushGallery.selectBrushById('builtin:imageBrush:pepper.gbr');
      }
    }

    if (tool === 'pattern') {
      // Ensure we have a default pattern (circle) if none is set
      if (!this.self.patternBrush) {
        if (this.patternGallery.selectedBrush) {
          this.self.patternBrush = this.patternGallery.selectedBrush;
        } else {
          // Fallback: create a default circle pattern
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 40;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ccc';
          ctx.beginPath();
          ctx.arc(20, 20, 18, 0, Math.PI * 2);
          ctx.fill();
          const circleImg = new Image();
          circleImg.src = canvas.toDataURL();
          this.self.patternBrush = {
            type: 'image',
            brushName: 'Circle',
            gimpUrl: canvas.toDataURL(),
            image: circleImg
          };
        }
      }
      // Broadcast pattern state when switching to pattern tool
      if (this.self.patternBrush && this.connected) {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternBrush(this._buildPatternPayload()));
      }
    }

    if (tool === 'line' || tool === 'rectangle' || tool === 'circle') {
      this.self.setSmoothing(50);
      this.ui.updateSmoothingValue(50);
    }

    this.ui.updateSelfToolIcon(tool);

    if (tool === 'erase') {
      this.board.topCanvas.style.mixBlendMode = 'normal';
      this.ui.updateTextPreviewBlendMode('normal');
    } else {
      const cssMode = this.blendModeManager.toCSSBlendMode(this.self.blendMode);
      this.board.topCanvas.style.mixBlendMode = cssMode;
      this.ui.updateTextPreviewBlendMode(cssMode);
    }

    const allowComplex = this.board.layerManager.getLayerAllowComplexBlendModes(this.self.activeLayer);
    const wasReset = this.ui.updateBlendModeForLayer(allowComplex);
    if (wasReset) {
      this.self.setBlendMode('source-over');
      this.board.topCanvas.style.mixBlendMode = 'normal';
      this.ui.updateTextPreviewBlendMode('normal');
    }

    const blendModeOptions = this.ui.elements.blendModeOptions;
    if (blendModeOptions && !this.ui.toolSupportsBlendMode(tool)) {
      blendModeOptions.style.display = 'none';
    }

    this.toolLockManager.updateAllLockButtons(tool);
    this.updateCurrentToolPresetSettings();

    // Auto-disable thinning when tablet user selects ink tool (only if using real pressure)
    // Only warn once and only when simulatePressure is false (tablet mode where thinning still applies)
    if (tool === 'ink' && this.tabletDetected && !this.tabletThinningWarningShown && !this.self.simulatePressure) {
      const elements = this.ui.elements;
      if (elements.thinningEnabled && elements.thinningEnabled.checked) {
        elements.thinningEnabled.checked = false;
        this.ui.setThinningTrackVisible(false);
        this.ui.showToast('Tablet detected - thinning disabled', 3000);
        this.tabletThinningWarningShown = true;
      }
    }

    if (tool === 'imageBrush' || tool === 'confetti') {
      this.brushGallery.show();
    } else {
      this.brushGallery.hide();
    }
  }

  /**
   * Handles brush selection from the gallery.
   * @param {Object} brush - Selected brush configuration.
   */
  handleBrushSelect(brush) {
    if (this.self.tool === 'confetti') {
      this.self.confettiBrush = brush;
      this.self.confettiShape = brush.confettiShape || 'image';
      this.toolManager.getTool('confetti')?.updatePreview?.(this.self);
      if (this.connected) {
        this.inputBufferManager.queueBroadcast(() =>
          this.wsClient.broadcastConfettiBrush(this._buildConfettiBrushPayload())
        );
      }
      return;
    }

    // Queue the brush change FIRST (snapshots pending strokes with old brush)
    // BEFORE setting the new brush locally
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBrush(brush));

    // NOW set the new brush so future strokes use it
    this.self.imageBrush = brush;

    if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
      this.ui.setBrushPreview(brush.gBrushes[0].gimpUrl);
    } else {
      this.ui.setBrushPreview(brush.previewUrl || brush.gimpUrl);
    }
  }

  /**
   * Handles font selection change from the UI dropdown.
   * @param {string} font - The selected font family string.
   */
  /**
   * Switch the local user's text render mode between 'vector' (ephemeral SVG) and 'pixel' (rasterized stroke).
   * Local-only setting; not synced or persisted (yet).
   * @param {'vector'|'pixel'} mode
   */
  setTextRenderMode(mode) {
    const next = mode === 'pixel' ? 'pixel' : 'vector';
    if (!this.self) return;
    if (this.self.textRenderMode === next) return;
    this.self.textRenderMode = next;
    this.ui.updateTextRenderMode?.(next);
  }

  handleFontChange(font) {
    const nextFont = normalizeTextFont(font);

    // Queue broadcast using current values
    if (this.connected) {
      const snapshot = {
        font: nextFont,
        mult: this.self.textPositionMultiplier,
        off: this.self.textPositionOffset
      };
      this.inputBufferManager.queueBroadcast(() => 
        this.wsClient.broadcastFontChange(snapshot.font, snapshot.mult, snapshot.off)
      );
    }

    //Local update
    this.self.setFont(font);
    this._applyStoredTextFontSettings(this.self.font);
    this.ui.updateTextPositionMultiplierValue(this.self.textPositionMultiplier);
    this.ui.updateTextPositionOffsetValue(this.self.textPositionOffset);
    this.ui.updateSelfTextStyle(this.self.size, this.self.color, font);
    this._updateTextPreview();
    this._refreshTextRenderingAfterFontLoad(nextFont);
  }

  handleTextPositionMultiplierChange(multiplier) {
    this.self.setTextPositionMultiplier(multiplier);
    this._saveTextFontSettings();
    this.ui.updateTextPositionMultiplierValue(this.self.textPositionMultiplier);
    this.ui.updateSelfTextStyle(this.self.size, this.self.color, this.self.font);
    this._updateTextPreview();
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastFontChange(
        this.self.font,
        this.self.textPositionMultiplier,
        this.self.textPositionOffset
      ));
    }
  }

  handleTextPositionOffsetChange(offset) {
    this.self.setTextPositionOffset(offset);
    this._saveTextFontSettings();
    this.ui.updateTextPositionOffsetValue(this.self.textPositionOffset);
    this.ui.updateSelfTextStyle(this.self.size, this.self.color, this.self.font);
    this._updateTextPreview();
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastFontChange(
        this.self.font,
        this.self.textPositionMultiplier,
        this.self.textPositionOffset
      ));
    }
  }

  /**
   * Handles layer selection.
   * @param {number} layerIndex - Index of the layer to select.
   */
  handleLayerSelect(layerIndex) {
    this.self.setActiveLayer(layerIndex);
    this.ui.updateActiveLayerDisplay(layerIndex);
    this.ui.updateBlurToolState(layerIndex);
    this._updateBlurCannotDraw();

    const allowComplex = this.board.layerManager.getLayerAllowComplexBlendModes(layerIndex);
    const wasReset = this.ui.updateBlendModeForLayer(allowComplex);
    if (!allowComplex || wasReset) {
      this.self.setBlendMode('source-over');
      this.board.topCanvas.style.mixBlendMode = 'normal';
      this.ui.updateTextPreviewBlendMode('normal');
    }

    if (allowComplex) {
      this.ui.updateBlendModeDisplay(this.self.blendMode);
    }

    const effectiveBlendMode = allowComplex ? this.self.blendMode : 'source-over';
    const cssMode = this.blendModeManager.toCSSBlendMode(effectiveBlendMode);
    this.board.topCanvas.style.mixBlendMode = cssMode;
    this.ui.updateTextPreviewBlendMode(cssMode);

    this.board.compositeAllLayers();

    this.strokeHistoryPanel.setActiveLayer(layerIndex);

    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastLayerChange(layerIndex));
    }

    // Selection menu options (e.g. Merge Up/Down) depend on active layer, so
    // refresh the menu if there's a live selection.
    const selectTool = this.toolManager?.tools?.select;
    const realSelect = selectTool?.realTool || selectTool;
    if (realSelect?.selection && typeof realSelect.showContextMenu === 'function') {
      realSelect.showContextMenu(true);
    }
  }

  handleLayerVisibilityToggle(layerIndex) {
    const visible = this.board.layerManager.toggleLayerVisibility(layerIndex);
    appState.layerVisibility = {
      ...appState.layerVisibility,
      [layerIndex]: visible
    };

    if (!visible && this.self.activeLayer === layerIndex) {
      if (this.self.mousedown && !this.self.panning) {
        this.cancelCurrentStroke();
      } else {
        this.board.clearTop();
      }
    }

    this.board.compositeAllLayers();
    this.refreshRemoteLayerVisibilityStates();
    this._updateBlurCannotDraw();
    return visible;
  }

  refreshRemoteLayerVisibilityStates(userId = null) {
    if (!this.ui?.remoteUserUI) return;

    const refreshUser = (user) => {
      if (!user || user.id === this.self?.id) return;
      const hiddenLayer = !this.board.layerManager.isLayerVisible(user.activeLayer);
      this.ui.remoteUserUI.updateRemoteLayerVisibility(user.id, hiddenLayer);
    };

    if (userId !== null && userId !== undefined) {
      refreshUser(this.users.get(userId));
      return;
    }

    this.users.forEach((user) => refreshUser(user));
  }

  /**
   * Show/hide the muted-style cursor indicator when blur is active on a non-zero layer.
   * @private
   */
  _updateBlurCannotDraw() {
    const cannotDraw =
      (this.self.tool === 'blur' && this.self.activeLayer !== 0) ||
      (this.self.tool === 'glitchBlur' && this.self.activeLayer !== 0);
    this._blurCannotDraw = cannotDraw;
    this._updateCursorDrawState();
  }

  _updateCursorDrawState() {
    const hiddenLayerCannotDraw =
      this.self.tool !== 'pan' &&
      this.self.tool !== 'rotate' &&
      !this.self.panning &&
      !this.board.layerManager.isLayerVisible(this.self.activeLayer);
    this._hiddenLayerCannotDraw = hiddenLayerCannotDraw;

    const cannotDraw = this._blurCannotDraw || hiddenLayerCannotDraw;

    if (!this.self.isMuted) {
      this.ui.setMutedState(cannotDraw);
    }

    if (!cannotDraw) {
      if (this.isOnBoard && this.ui?.elements?.selfCursor?.style.display !== 'none') {
        this.ui.updateToolDisplay(this.self.tool, this.self);
      }
      return;
    }

    const {
      selfCircle,
      selfPressureCircle,
      selfSquare,
      selfPressureSquare,
      selfCrosshair,
      selfHand,
      selfText
    } = this.ui.elements;

    if (selfCircle) selfCircle.style.display = 'none';
    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfSquare) selfSquare.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
    if (selfCrosshair) selfCrosshair.style.display = 'none';
    if (selfHand) selfHand.style.display = 'none';
    if (selfText) selfText.style.display = 'none';
  }

  /**
   * Handles blend mode change for the active layer.
   * @param {string} blendMode - The canvas blend mode to apply.
   */
  handleBlendModeChange(blendMode) {
    const activeLayer = this.self.activeLayer;

    if (!this.board.layerManager.getLayerAllowComplexBlendModes(activeLayer)) {
      blendMode = 'source-over';
    }

    this.self.setBlendMode(blendMode);
    appState.blendMode = blendMode;
    const blendLock = this.toolLockManager?.toolLocks?.[this.self.tool]?.blendMode;
    if (blendLock?.locked) {
      blendLock.lockedValue = blendMode;
      this.toolLockManager.saveToolLocks();
    } else if (this.toolLockManager?.globalUnlockedValues) {
      this.toolLockManager.globalUnlockedValues.blendMode = blendMode;
      this.toolLockManager.saveGlobalUnlockedValues();
    }
    this.board.createActiveLayerBlendSubLayer(blendMode);
    const cssMode = this.blendModeManager.toCSSBlendMode(blendMode);
    this.board.topCanvas.style.mixBlendMode = cssMode;
    this.ui.updateTextPreviewBlendMode(cssMode);
    this._updateTextPreview();

    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastLayerBlendModeChange(activeLayer, blendMode, this.self.blendBakeMode));
    }
  }

  handleBlendBakeModeChange(mode) {
    const blendBakeMode = normalizeBlendBakeMode(mode);
    this.self?.setBlendBakeMode?.(blendBakeMode);

    if (this.connected && this.self) {
      const activeLayer = this.self.activeLayer;
      const blendMode = this.self.blendMode || 'source-over';
      this.inputBufferManager.queueBroadcast(() =>
        this.wsClient.broadcastLayerBlendModeChange(activeLayer, blendMode, blendBakeMode)
      );
    }
  }

  /**
   * Clears the entire board.
   */
  handleClear() {
    // Must match the server's CLEAR_CANVAS rule exactly. The board is cleared
    // optimistically below, before any round trip, so a gate that is looser
    // than the server's leaves this client cleared while the server drops the
    // broadcast — the clear then shows up for nobody else.
    if (!this.moderation || !this.moderation.canClearCanvas()) {
      this.ui.showToast('Only moderators can clear the canvas', 3000, 'error');
      return;
    }
    this.board.clear();
    this.board.tileTracker?.clear();
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastClear());
    if (this.debugOverlay) {
      this.debugOverlay.clearAll();
    }
  }

  /**
   * Resets the board's view transformation (zoom and pan).
   */
  handleResetBoard() {
    this.board.resetView();
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
    this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
    this.boardViewer?.setMainZoom(this.board.zoom);
  }

  /**
   * Toggles a local-only horizontal flip of the canvas viewport.
   */
  handleToggleCanvasFlip() {
    const enabled = this.board.toggleCanvasFlip();
    this.ui.updateCanvasFlipDisplay(enabled);
  }

  _ensureUserContextMenu() {
    if (this.ui.elements.userContextMenu) return;

    const menu = document.createElement('div');
    menu.id = 'userContextMenu';
    menu.className = 'contextMenu';
    menu.dataset.tut = 'context-menu';
    menu.style.display = 'none';
    menu.innerHTML = `
      <button type="button" class="menuItem" data-action="profile">Profile</button>
      <button type="button" class="menuItem" data-action="sync">Sync</button>
      <button type="button" class="menuItem" data-action="spectate">Spectate</button>
      <button type="button" class="menuItem" data-action="pm">Message</button>
      <div class="menuDivider"></div>
      <button type="button" class="menuItem" data-action="mute">Mute</button>
      <button type="button" class="menuItem" data-action="silence">Silence</button>
      <button type="button" class="menuItem danger" data-action="kick">Kick</button>
      <button type="button" class="menuItem danger" data-action="ban">Ban</button>
      <button type="button" class="menuItem danger" data-action="wipe">Wipe Strokes</button>
      <div class="menuDivider adminOnly"></div>
      <button type="button" class="menuItem adminOnly" data-action="promote">Promote</button>
      <button type="button" class="menuItem adminOnly" data-action="demote">Demote</button>
      <button type="button" class="menuItem deityOnly" data-action="promoteNoble">Promote Noble</button>
      <button type="button" class="menuItem deityOnly" data-action="promoteHoly">Promote Holy</button>
      <button type="button" class="menuItem deityOnly" data-action="demoteGlobal">Demote Global</button>
      <button type="button" class="menuItem holyOrDeityOnly" data-action="shadowban">Shadowban</button>
    `;
    document.body.appendChild(menu);
    this.ui.elements.userContextMenu = menu;
  }


  /**
   * Disables keyboard button activation and focus navigation while the drawing UI is active.
   * This keeps focused controls from re-firing on Space/Enter and stops Tab from
   * cycling through the app chrome during drawing.
   * @param {KeyboardEvent} event
   */
  suppressButtonKeyboardActivation(event) {
    if (!event) {
      return;
    }

    if (this.landingPage?.isVisible) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const editableTarget = target?.closest('input, textarea, select, [contenteditable="true"]');

    if (event.key === 'Tab' || event.key === 'Alt') {
      if (!editableTarget) {
        event.preventDefault();
      }
      return;
    }

    if (event.key !== ' ' && event.key !== 'Spacebar' && event.key !== 'Enter') {
      return;
    }

    if (editableTarget) {
      return;
    }

    const buttonTarget = target
      ? target.closest('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]')
      : null;

    if (!buttonTarget || buttonTarget.disabled) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  /**
   * Toggles canvas mirroring.
   */
  handleToggleMirror() {
    this.mirrorRegionController?.begin();
  }

  /**
   * Toggles Debug mode: the board overlay and the diagnostics panel together.
   *
   * One switch on purpose — the panel and the overlay describe the same state
   * from two angles, and having them toggle independently produced two
   * overlapping debug UIs that could disagree. Both are inert while off: no
   * intervals, no rAF loop, no sampling.
   */
  handleToggleDebugMode() {
    const enabled = this.debugOverlay.toggle();
    this.ui.updateDebugModeDisplay(enabled);
    this.debugPanel?.setEnabled(enabled);
    return enabled;
  }

  /**
   * Whether the Debug button belongs in the toolbar.
   *
   * Moderators keep it by role, as they always have; everyone else opts in
   * through the "Show Debug Button" setting. The two are OR'd rather than the
   * setting being authoritative, so a moderator who never opens settings does
   * not silently lose a button they have always had.
   *
   * @returns {boolean}
   */
  shouldShowDebugButton() {
    return !!this.moderation?.isMod?.() || !!this.appPreferences?.general?.showDebugButton;
  }

  /**
   * Create or remove the Debug button to match `shouldShowDebugButton()`.
   *
   * Lives here rather than in Moderation._injectModUI() because it is no longer
   * a moderation control: that injector only runs for mods, and its `.modOnly`
   * class is driven by role, so a settings-enabled button could never appear
   * through it. Safe to call repeatedly — it is the single reconciler, invoked
   * on init, on a preferences change, and on a role change.
   */
  refreshDebugButton() {
    const collapsible = document.getElementById('collapsibleBtns');
    if (!collapsible) return;

    const existing = document.getElementById('debugBtn');
    if (!this.shouldShowDebugButton()) {
      // Shift+P still toggles Debug mode, so an overlay left running is never
      // stranded without the button — no need to force the mode off here.
      existing?.remove();
      if (this.ui?.elements) {
        this.ui.elements.debugBtn = null;
      }
      this.scheduleTopbarCollapseUpdate?.();
      return;
    }
    if (existing) return;

    const debugBtn = document.createElement('a');
    debugBtn.className = 'btn';
    debugBtn.id = 'debugBtn';
    debugBtn.textContent = 'Debug';
    debugBtn.addEventListener('click', () => this.handleToggleDebugMode());

    // Sit after Clear when a moderator has one, so the toolbar order is the
    // same whichever of the two injectors ran first.
    const clearWrap = collapsible.querySelector('.clearConfirmWrap');
    if (clearWrap) {
      clearWrap.after(debugBtn);
    } else {
      collapsible.insertBefore(debugBtn, collapsible.firstChild);
    }

    if (this.ui?.elements) {
      this.ui.elements.debugBtn = debugBtn;
    }
    // A button appearing mid-session changes the toolbar width.
    this.scheduleTopbarCollapseUpdate?.();
    // Keep the label honest if the mode is already on (Shift+P, or a role change
    // that re-created the button while Debug mode was running).
    this.ui?.updateDebugModeDisplay?.(this.debugOverlay?.isEnabled?.() ?? false);
  }

  /**
   * Zooms in on the canvas.
   */
  handleZoomIn() {
    const cursorPos = this.isOnBoard ? { x: this.self.x, y: this.self.y } : null;
    this.board.zoomIn(0.1, cursorPos);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
    this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
    this.boardViewer?.setMainZoom(this.board.zoom);
  }

  /**
   * Zooms out on the canvas.
   */
  handleZoomOut() {
    const cursorPos = this.isOnBoard ? { x: this.self.x, y: this.self.y } : null;
    this.board.zoomOut(0.1, cursorPos);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
    this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
    this.boardViewer?.setMainZoom(this.board.zoom);
  }

  /**
   * Resets the canvas rotation to zero.
   */
  handleResetRotation() {
    this.board.resetRotation();
  }

  // Brush/tool settings

  handleSizeChange(e) {
    this.clearActiveCustomPreset();
    let size = Number(e.target.value);
    size = size > 10 ? Math.round(size) : Math.round(size / 0.25) * 0.25;
    size = Math.max(0.25, Math.min(100, size));
    if (e.target && Number(e.target.value) !== size) {
      e.target.value = size;
    }
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSizeChange(size));
    if (this.self.mousedown && this.self.tool === 'brush') {
      this.commitSelfLine(this.self.pressure, size);
    }
    this.self.setSize(size);
    appState.currentSize = size;
    this.ui.updateCursorSize(size);
    this.ui.updateSquarePositions(size);
    const cursorStyle = this.ui.getCursorStyleForTool(this.self.tool, this.self);
    // Update pressure indicators only for tools that use pressure
    const pressureTools = ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur'];
    if (pressureTools.includes(this.self.tool) && cursorStyle === 'circle') {
      this.ui.updatePressureCursorRadius(pressureSizeFactor(this.self) * size, size, this.tabletDetected);
    }
    if ((this.self.tool === 'imageBrush' || cursorStyle === 'square') && this.self.tool !== 'glitchBlur') {
      this.ui.updatePressureSquareSize(pressureSizeFactor(this.self) * size, size, this.tabletDetected);
    }
    this.ui.updateSelfTextStyle(size, this.self.color, this.self.font);
    this.ui.updateSizeValue(size);
    this.board.viewCtx.lineWidth = size * 2;
    this.updateCurrentToolPresetSettings();
    this.updateActiveToolPreview();
  }

  handleSpacingChange(e) {
    this.clearActiveCustomPreset();
    const spacing = Math.round(Number(e.target.value));
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSpacingChange(spacing));
    this.self.setSpacing(spacing);
    this.ui.updateSpacingValue(spacing);
    this.updateCurrentToolPresetSettings();
    this.updateActiveToolPreview();
  }

  handleSmoothingChange(e) {
    this.clearActiveCustomPreset();
    const smoothing = Number(e.target.value);
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSmoothingChange(smoothing));
    this.self.setSmoothing(smoothing);
    this.ui.updateSmoothingValue(smoothing);
    this.updateCurrentToolPresetSettings();
    this.updateActiveToolPreview();
  }

  handleHardnessChange(e) {
    this.clearActiveCustomPreset();
    const hardness = Number(e.target.value);
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastHardnessChange(hardness));
    this.self.setHardness(hardness);
    this.ui.updateHardnessValue(hardness);
    this.updateCurrentToolPresetSettings();
    this.updateActiveToolPreview();
  }

  handleOpacityChange(e) {
    this.clearActiveCustomPreset();
    const opacity = Number(e.target.value) / 100; // Convert to 0-1 range
    this.commitSelfEraserSegment(this.self.pressure, this.self.size, opacity);

    // Update user opacity (same as color picker alpha)
    const currentColor = [...this.self.color];
    currentColor[3] = opacity;
    
    // Broadcast to other users
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastColorChange(currentColor));
    }

    this.self.setOpacity(opacity);
    this.ui.updateOpacityValue(opacity);

    // Update color picker to match
    this.self.setColor(currentColor);
    this._setColorPickersColor(`rgba(${currentColor.join(',')})`);
    // Refresh the text-tool DOM preview so its alpha follows the slider live
    // (instead of waiting for a tool swap or font/size touch to redraw it).
    this.ui.updateSelfTextStyle(this.self.size, currentColor, this.self.font);
    if (this.self.tool === 'text') {
      this._updateTextPreview();
    }
    appState.currentColor = [...currentColor];
    this.updateCurrentToolPresetSettings();
    this.updateActiveToolPreview();
  }

  handleBlurRadiusChange(e) {
    this.clearActiveCustomPreset();
    const radius = this.setSelfBlurRadiusForCurrentTool(Number(e.target.value));
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBlurRadiusChange(radius));
    }
    this.ui.updateBlurRadiusValue(radius);
    this.updateCurrentToolPresetSettings();
  }

  getBlurRadiusMaxForTool(toolName = this.self?.tool) {
    return toolName === 'blur' ? BLUR_RADIUS_MAX : GLITCH_BLUR_RADIUS_MAX;
  }

  clampBlurRadiusForTool(radius, toolName = this.self?.tool) {
    const value = Number(radius);
    const max = this.getBlurRadiusMaxForTool(toolName);
    return Math.max(1, Math.min(max, Number.isFinite(value) ? value : 5));
  }

  setSelfBlurRadiusForCurrentTool(radius) {
    const clamped = this.clampBlurRadiusForTool(radius);
    this.self.setBlurRadius(clamped);
    return clamped;
  }

  applyBlurRadiusLimitForTool(toolName = this.self?.tool, options = {}) {
    const max = this.getBlurRadiusMaxForTool(toolName);
    const slider = this.ui?.elements?.blurRadiusSlider;
    if (slider) {
      slider.max = String(max);
    }

    const clamped = this.clampBlurRadiusForTool(this.self.blurRadius, toolName);
    const changed = clamped !== this.self.blurRadius;
    if (changed) {
      this.self.setBlurRadius(clamped);
    }
    if (slider) {
      slider.value = clamped;
    }
    this.ui.updateBlurRadiusValue(clamped);

    if (changed && options.broadcast && this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBlurRadiusChange(clamped));
    }
  }

  handleThinningChange(e) {
    this.clearActiveCustomPreset();
    const thinning = Number(e.target.value) / 100; // Convert to 0-1 range
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastThinningChange(thinning));
    }
    this.self.setThinning(thinning);
    this.ui.updateThinningValue(Math.round(thinning * 100));
    this.updateCurrentToolPresetSettings();
    this.updateActiveToolPreview();
    // Update CSS variable for fill rendering
    if (this.ui.elements.thinningSlider) {
      this.ui.elements.thinningSlider.style.setProperty('--value', e.target.value);
    }
  }

  handleSimulatePressureChange(e) {
    const simulate = e.target.checked;
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSimulatePressureChange(simulate));
    }
    this.self.setSimulatePressure(simulate);
    this.updateActiveToolPreview();
  }

  /** A pressure target checkbox changed. */
  handlePressureTargetsChange() {
    this.setPressureTargets(this.ui.getCheckedPressureTargets());
  }

  /**
   * Sets what pressure drives for the local user, shows it in tool options and
   * tells the room.
   * @param {number} targets - PRESSURE_TARGET_* bits.
   */
  setPressureTargets(targets) {
    const next = normalizePressureTargets(targets);
    const changed = next !== this.self.pressureTargets;
    this.self.setPressureTargets(next);
    this.ui.updatePressureTargets(next, this.self.tool);
    if (changed && this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPressureTargetsChange(next));
    }
  }

  async handleBrushFileLoad(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const brushTool = this.toolManager.getTool('imageBrush');
    let lastBrushData = null;

    for (const file of files) {
      const brushData = await brushTool.loadBrush(file, this.self);

      if (brushData) {
        const lowerType = file.name.split('.').pop().toLowerCase();
        if (['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(lowerType)) {
          const customAsset = assetLibrary.addCustomAsset({
            kind: 'imageBrush',
            type: brushData.type,
            fileName: file.name,
            fileType: lowerType,
            dataUrl: brushData.previewUrl || brushData.gimpUrl,
            gimpUrl: brushData.previewUrl || brushData.gimpUrl,
            svgContent: brushData.svgContent || null,
            brushName: brushData.brushName || file.name.replace(/\.[^/.]+$/, '')
          });
          if (this.brushGallery.realGallery) {
            this.brushGallery.realGallery.registerBrush({
              ...brushData,
              ...customAsset,
              image: brushData.image,
              images: brushData.images
            });
          }
        }

        lastBrushData = brushData;
      }
    }

    // Only broadcast and select the last loaded brush
    if (lastBrushData) {
      const broadcastData = { ...lastBrushData };
      delete broadcastData.image;
      delete broadcastData.images;

      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBrush(broadcastData));

      this.self.imageBrush = lastBrushData;
      this.ui.setBrushPreview(lastBrushData.previewUrl || lastBrushData.gimpUrl || lastBrushData.gBrushes[0].gimpUrl);
    }
    e.target.value = '';
  }

  // --- Chat delegates (implementation in ui/ChatController.js) ---
  handleChatSend(message) { this.chatController.handleChatSend(message); }
  handleStaffChatSend(message) { this.chatController.handleStaffChatSend(message); }
  handleStaffChatImageSend(imageData) { this.chatController.handleStaffChatImageSend(imageData); }
  handleDMSend(message, recipientId) { this.chatController.handleDMSend(message, recipientId); }
  handleChatImageSend(imageData, recipientId) { this.chatController.handleChatImageSend(imageData, recipientId); }
  handleChatReaction(payload) { this.chatController.handleChatReaction(payload); }

  handleChatDeleteMessage(messageId, staff) { this.chatController.handleDeleteMessage(messageId, staff); }
  updateChatUserList() { this.chatController.updateChatUserList(); }

  getCurrentToolPresetSettings(toolName = this.self?.tool) {
    const lockConfig = this.toolLockManager?.toolLocks?.[toolName];
    if (!this.self || !lockConfig) return {};

    const settings = {};
    for (const property of Object.keys(lockConfig)) {
      if (property === 'pressure') {
        settings.pressureMin = Number(this.ui.elements.pressureMinSlider?.value ?? 0);
        settings.pressureMax = Number(this.ui.elements.pressureMaxSlider?.value ?? 100);
        settings.pressureEnabled = !!this.pressureEnabled;
        settings.pressureTargets = this.self.pressureTargets;
      } else if (property === 'opacity') {
        settings.opacity = this.self.opacity;
      } else {
        settings[property] = this.self[property];
      }
    }

    return settings;
  }

  updateCurrentToolPresetSettings() {
    if (!this.self) return;
    appState.currentTool = this.self.tool;
    appState.currentSize = this.self.size;
    appState.currentColor = [...this.self.color];
    appState.currentToolSettings = this.getCurrentToolPresetSettings();
  }

  clearActiveCustomPreset() {
    appState.activeCustomPresetKey = null;
  }

  applyCustomPreset(preset) {
    if (!preset?.color) return;

    if (preset.tool) {
      this.selectTool(preset.tool);
    }

    const colorlessTools = ['erase', 'blur', 'circleBlur', 'glitchBlur', 'select', 'pan', 'zoom', 'rotate', 'inkdropper'];
    if (!colorlessTools.includes(preset.tool)) {
      this.handlePaletteColorSelect(preset.color);
    }

    if (preset.size != null) {
      this.handleSizeChange({ target: { value: preset.size } });
    }

    if (preset.settings) {
      this.applyCustomPresetSettings(preset.settings);
    }

    this.updateCurrentToolPresetSettings();
    appState.activeCustomPresetKey = getCustomPresetKey(preset);
  }

  applyCustomPresetSettings(settings) {
    for (const [property, value] of Object.entries(settings)) {
      if (property === 'size') this.handleSizeChange({ target: { value } });
      else if (property === 'spacing') this.handleSpacingChange({ target: { value } });
      else if (property === 'smoothing') this.handleSmoothingChange({ target: { value } });
      else if (property === 'hardness') this.handleHardnessChange({ target: { value } });
      else if (property === 'opacity') this.handleOpacityChange({ target: { value: value * 100 } });
      else if (property === 'blurRadius') this.handleBlurRadiusChange({ target: { value } });
      else if (property === 'thinning') this.handleThinningChange({ target: { value: value * 100 } });
      else if (property === 'pressureMin' && this.ui.elements.pressureMinSlider) {
        this.ui.elements.pressureMinSlider.value = value;
        this.ui.updatePressureValue(value, Number(this.ui.elements.pressureMaxSlider?.value ?? 100));
      } else if (property === 'pressureMax' && this.ui.elements.pressureMaxSlider) {
        this.ui.elements.pressureMaxSlider.value = value;
        this.ui.updatePressureValue(Number(this.ui.elements.pressureMinSlider?.value ?? 0), value);
      } else if (property === 'pressureEnabled') {
        this.pressureEnabled = !!value;
        if (this.ui.elements.pressureEnabled) this.ui.elements.pressureEnabled.checked = !!value;
        this.ui.setPressureTrackVisible(!!value);
      } else if (property === 'pressureTargets') {
        this.setPressureTargets(value);
      }
    }
  }

  // Pointer event handlers

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {EventTarget|null} [eventTarget] - the dispatching event's `target`.
   *   When given it is used instead of a fresh hit test; see below.
   */
  isPointerOverBoard(clientX, clientY, eventTarget = null) {
    const elements = this.ui?.elements;
    const boardBoundsEl = elements?.boards || elements?.board;
    if (!boardBoundsEl || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;

    if (!this._isPointWithinBoardSurface(clientX, clientY, boardBoundsEl)) return false;

    // Treat all board-owned layers as valid hover targets while still rejecting
    // unrelated UI that overlaps the board area.
    //
    // `elementFromPoint` re-runs the hit test the browser already performed to
    // dispatch this event, and forces a style+layout flush to do it. On a
    // pointermove that fires 120-240x/sec it was the single most expensive call
    // in the input path (profiled on the N4500: 230ms self time, versus 48ms
    // for all the stroke geometry combined). The event's own target is the
    // result of that same hit test, so prefer it when the caller has one.
    //
    // Callers without a meaningful target -- notably pointerleave, where
    // `target` is the element being exited rather than the one under the
    // cursor -- omit it and get the original behaviour.
    const topEl = (eventTarget instanceof Element)
      ? eventTarget
      : document.elementFromPoint(clientX, clientY);
    if (!topEl) return false;

    const boardLayerEls = [
      elements.boards,
      elements.board,
      elements.topBoard,
      elements.userBoards
    ].filter(Boolean);

    if (boardLayerEls.some(el => el === topEl || el.contains(topEl))) {
      return true;
    }

    return topEl.closest?.('#boards, #board, #topBoard, #userBoards, .userBoard') !== null;
  }

  /**
   * Bounds half of the hover test, answered from the app's own view state
   * instead of the DOM.
   *
   * This used to be `#boards.getBoundingClientRect()`, deliberately uncached
   * because pan/zoom/rotate continuously transform that element and a stale
   * rect reports "off board" over visible canvas. The read itself is cheap;
   * what is not is that every pointermove writes to the cursor SVG *inside*
   * `#boards`, so the next move's read forces a full style+layout flush.
   * At 120-240 moves/sec that made it the largest named cost in the input
   * path (profiled on an N4500: 229ms self time, versus 48ms for all the
   * stroke geometry combined).
   *
   * `#boards` is `position:absolute; top:0; left:0` inside `#boardContainer`,
   * is sized to exactly the board dimensions (Board.applyTransform sets its
   * width/height), and carries the pan/zoom/rotate transform with
   * transform-origin 0 0. So "is this client point over the board" is the same
   * question as "does it inverse-transform into [0,W] x [0,H]" — which
   * `getBoardRelativePos` already answers for every stroke, off Board's cached
   * *container* rect. That rect is transform-independent (the transform is on
   * the child) and is invalidated on window resize, capture-phase scroll and a
   * ResizeObserver on the container, i.e. every layout change that can move it.
   * Reusing it introduces no staleness the drawing coordinates don't already
   * depend on: if this rect were stale, strokes would land in the wrong place
   * long before hover misreported.
   *
   * One behavioural difference, verified over a zoom x pan x rotation x flip
   * matrix: the old rect test was the axis-aligned *bounding box* of a rotated
   * board, so it accepted points in the corners outside the board itself. This
   * test is the exact rotated rect. Those corner points then failed the
   * board-layer check below anyway, so nothing that used to return true stops
   * doing so; the probe found zero points accepted here that the rect test
   * rejected, in any state.
   *
   * @param {number} clientX
   * @param {number} clientY
   * @param {Element} boardBoundsEl - fallback element, used only pre-init.
   * @returns {boolean}
   */
  _isPointWithinBoardSurface(clientX, clientY, boardBoundsEl) {
    const board = this.board;
    if (!board?.container) {
      const rect = boardBoundsEl.getBoundingClientRect();
      return !(clientX < rect.left || clientX > rect.right
        || clientY < rect.top || clientY > rect.bottom);
    }

    const pos = board.getBoardRelativePos(clientX, clientY);
    return pos.x >= 0 && pos.x <= board.getWidth()
      && pos.y >= 0 && pos.y <= board.getHeight();
  }

  /**
   * True while a two-finger viewport gesture (pan / zoom / rotate) is running.
   * The pointer stream behind such a gesture is fingers moving the viewport,
   * not a cursor any peer should see.
   *
   * @returns {boolean}
   */
  isTouchGestureActive() {
    const state = this.touchHandler?.state;
    return !!state && (state.isPinching || state.gestureStartedWithTwoFingers);
  }

  /**
   * Queue a cursor show/hide broadcast for peers.
   *
   * Every cursor-visibility broadcast goes through here so the gesture check
   * runs at *drain* time, not at queue time. A finger's pointerdown fires
   * before the touchstart that starts the gesture, so it queues a SHOW that
   * used to drain after the gesture's HIDE — leaving the drawer's cursor and
   * name parked on every peer's screen for the whole pan/zoom/rotate.
   *
   * @param {boolean} visible - Whether peers should see this user's cursor.
   * @returns {void}
   */
  broadcastCursorVisibility(visible) {
    if (!this.connected) return;
    if (visible && this.isTouchGestureActive()) return;
    this.inputBufferManager.queueBroadcast(() => {
      if (visible && this.isTouchGestureActive()) return;
      if (visible) this.wsClient.broadcastShowCursor();
      else this.wsClient.broadcastHideCursor();
    });
  }

  syncBoardHoverState(isOnBoard, { forceRefresh = false, event = null } = {}) {
    const cursorHidden = this.ui?.elements?.selfCursor?.style.display === 'none';
    const shouldRefresh = forceRefresh || (isOnBoard && cursorHidden);
    const inTouchGesture = this.isTouchGestureActive();
    if (this.isOnBoard === isOnBoard && !shouldRefresh) {
      return;
    }

    this.isOnBoard = isOnBoard;

    if (isOnBoard) {
      // Don't show cursor if pointer is on a UI control (slider, input, button, etc.)
      if (event && this._isPointerOnUiControl(event.target)) {
        this.ui.hideCursor();
        if (this.connected) {
          this.broadcastCursorVisibility(false);
        }
        return;
      }

      if (inTouchGesture && this.self.tool !== 'text') {
        return;
      }

      this.ui.showCursor();
      const isTextWithContent = this.self.tool === 'text' && this.self.text;
      if (this.self.panning && this.self.tool !== 'pan' && !isTextWithContent) {
        this.ui.showPanCursor();
      } else {
        this.ui.updateToolDisplay(this.self.tool, this.self);
        this._updateBlurCannotDraw();
      }
      if (this.connected) {
        if ((this.self.panning || this.self.tool === 'pan') && !isTextWithContent) {
          this.broadcastCursorVisibility(false);
        } else {
          this.broadcastCursorVisibility(true);
        }
      }
      return;
    }

    if (this.self.mousedown || this.self.tool === 'text') {
      return;
    }

    // Some stylus drivers emit leave during hover/contact transitions. If the
    // pointer is still physically over the board, keep the cursor visible.
    if (event && this.isPointerOverBoard(event.clientX, event.clientY)) {
      // But not if pointer is on a UI control
      if (this._isPointerOnUiControl(event.target)) {
        this.ui.hideCursor();
        if (this.connected) {
          this.broadcastCursorVisibility(false);
        }
        return;
      }
      this.isOnBoard = true;
      if (shouldRefresh && !(inTouchGesture && this.self.tool !== 'text')) {
        this.ui.showCursor();
        if (this.self.panning && this.self.tool !== 'pan') {
          this.ui.showPanCursor();
        } else {
          this.ui.updateToolDisplay(this.self.tool, this.self);
          this._updateBlurCannotDraw();
        }
      }
      return;
    }

    this.ui.hideCursor();
    if (this.connected) {
      this.broadcastCursorVisibility(false);
    }
  }

  _toolMutatesCanvas(toolName = this.self?.tool) {
    return !['pan', 'zoom', 'rotate', 'inkdropper'].includes(toolName);
  }

  _toolUsesPressure(toolName = this.self?.tool) {
    return ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur', 'imageBrush'].includes(toolName);
  }

  _getPointerSamplePressure(e, fallbackPressure = this.self?.pressure ?? 1, fallbackPointerType = e.pointerType) {
    if (!this._toolUsesPressure(this.self.tool) || !this.pressureEnabled) {
      return 1;
    }
    const pointerType = e.pointerType || fallbackPointerType;
    if (pointerType !== 'pen' || this.self.panning) {
      return fallbackPressure;
    }
    if (e.pressure === 0) {
      return this.self.mousedown ? fallbackPressure : 0;
    }
    const minP = Number(this.ui.elements.pressureMinSlider.value) / 100;
    const maxP = Number(this.ui.elements.pressureMaxSlider.value) / 100;
    const mappedPressure = minP + (maxP - minP) * e.pressure;
    return Math.round(mappedPressure * 100) / 100;
  }

  _bufferPointerSample(e, fallbackPointerType = e.pointerType) {
    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    const constrainedPos = this.getConstrainedShapeDragPoint(pos.x, pos.y);
    const pressure = this._getPointerSamplePressure(e, this.self?.pressure ?? 1, fallbackPointerType);
    if (!this.inputBufferManager.shouldCullSample(constrainedPos.x, constrainedPos.y, pressure)) {
      this.inputBufferManager.inputBuffer.points.push(constrainedPos.x, constrainedPos.y, pressure);
      this.inputBufferManager.inputBuffer.pointerType = e.pointerType || fallbackPointerType;
      this.inputBufferManager.inputBuffer.dirty = true;
    }
    return constrainedPos;
  }

  _isPointerOnUiControl(eventTarget) {
    if (!(eventTarget instanceof Element)) return false;
    return !!eventTarget.closest(
      'input, select, textarea, button, .slider, .sliderValue, .dual-slider, #toolSliders, #toolExtras'
    );
  }

  _blurEmbeddedChatFocus() {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return;
    if (!activeElement.closest('#chatMount')) return;
    activeElement.blur();
  }

  _isCanvasRegionLocked(pos, previousPos = null) {
    if (!this.board || !this._toolMutatesCanvas()) return false;
    if (!this.board.hasInteractionBlocks?.()) return false;
    if (previousPos && this.board.segmentIntersectsInteractionBlock(previousPos, pos)) return true;
    return this.board.isPointInInteractionBlock(pos);
  }

  _notifyCanvasRegionLocked() {
    if (this._lastInteractionBlockToast && Date.now() - this._lastInteractionBlockToast < 1500) {
      return;
    }
    this._lastInteractionBlockToast = Date.now();
    this.ui.showToast('That region is being restored right now', 2000);
  }

  _cancelBlockedCanvasInteraction() {
    this._pendingPenDown = null;
    this.inputBufferManager.inputBuffer.points = [];
    this.inputBufferManager.inputBuffer.dirty = false;
    this.cancelCurrentStroke();
  }

  handlePointerMove(e) {
    this.updateModifierKeysFromEvent(e);

    const hasActiveBoardInteraction =
      this.self.mousedown ||
      this.self.panning ||
      this._containerPanActive ||
      this._rightDragZoomActive ||
      this._rotateToolActive ||
      !!this.self._pendingTextPos;
    if (!hasActiveBoardInteraction && this._isPointerOnUiControl(e.target)) {
      return;
    }

    if (this.mirrorRegionController?.isActive()) {
      const consumed = this.mirrorRegionController.handlePointerMove(e);
      if (consumed) return;
    }

    // Block local input while syncing
    if (this.syncClient?.isSyncing() || this.syncClient?.isCanvasInputBlocked()) return;

    // Skip drawing during two-finger gestures
    if (this.touchHandler.state.isPinching || this.touchHandler.state.gestureStartedWithTwoFingers) {
      if (this.self.tool !== 'text') {
        this.ui.hideCursor();
      }
      return;
    }

    // Rotate tool: compute angle from pivot to pointer and apply delta
    if (this._rotateToolActive) {
      const currAngle = Math.atan2(
        e.clientY - this._rotatePivotClientY,
        e.clientX - this._rotatePivotClientX
      );
      if (this._rotatePrevAngle !== null) {
        let delta = currAngle - this._rotatePrevAngle;
        // Unwrap to [-π, π] to avoid jumps when crossing ±180°
        if (delta > Math.PI)  delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        const newRotation = this.board.rotation + delta * (180 / Math.PI);
        this.board.setRotationAround(newRotation, this._rotatePivotX, this._rotatePivotY);
      }
      this._rotatePrevAngle = currAngle;
      return;
    }

    if (this._rightDragZoomActive && e.pointerId === this._rightDragZoomPointerId) {
      const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
      const deltaY = e.clientY - this._rightDragZoomStartClientY;
      const zoomFactor = Math.pow(2, -deltaY / 240);
        this.board.setZoomAround(
          this._rightDragZoomStartZoom * zoomFactor,
          this._rightDragZoomPivotX,
          this._rightDragZoomPivotY
        );
        this.ui.updateZoomDisplay(this.board.getZoomPercent());
        this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
        this.boardViewer?.setMainZoom(this.board.zoom);
        return;
    }

    // Pointer moves are listened to on window so active drags can continue off-canvas.
    // When the pointer is simply hovering outside the board, suppress local buffering
    // and remote broadcasts so replay/history do not accumulate phantom cursor moves.
    this.syncBoardHoverState(this.isPointerOverBoard(e.clientX, e.clientY, e.target), { event: e });
    if (!this.isOnBoard && !hasActiveBoardInteraction) {
      return;
    }

    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    const x = pos.x;
    const y = pos.y;

    if (this.self.mousedown && !this.self.panning) {
      const previousPos = this.inputBufferManager.inputBuffer.lastPosition || { x: this.self.x, y: this.self.y };
      if (this._isCanvasRegionLocked(pos, previousPos)) {
        this._cancelBlockedCanvasInteraction();
        this._notifyCanvasRegionLocked();
        return;
      }
    }

    // Text tool: update pending position for touch drag preview
    if (this.self.tool === 'text' && this.self._pendingTextPos && e.pointerType === 'touch') {
      this.self._pendingTextPos = { x, y };
      this.self.setPosition(x, y);
      this.ui.updateSelfCursor(x, y, this.self.size);
      
      // Broadcast movement so remote users see the text cursor updating
      if (this.connected) {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseMove(x, y));
      }
      return;
    }

    // Update cursor immediately for visual responsiveness
    this.ui.updateSelfCursor(x, y, this.self.size);
    // Hovering inside a mirror region counts as activity: the guides must be up
    // while you line a stroke up, not only once you commit to drawing.
    this.board.noteMirrorActivity({ point: { x, y } });
    if (this.self.tool === 'text') this._updateTextPreview();
    if (this.self.tool === 'inkdropper') {
      const tool = this.toolManager.getCurrentTool();
      tool?.onPointerMove?.(this.self, pos, this.inputBufferManager.inputBuffer.lastPosition || pos, e);
      if (!this.self.mousedown) return;
    }

    // Handle pressure for pen input — default to current pressure so non-pen
    // events (e.g. palm touch) mid-stroke don't slam pressure to 1
    let pressure = this.self.pressure;
    const toolUsesPressure = this._toolUsesPressure(this.self.tool);
    if (!toolUsesPressure || !this.pressureEnabled) {
      pressure = 1;
    } else if (e.pointerType === 'pen' && !this.self.panning) {
      // On pen lift (e.pressure === 0), keep the last known pressure if mid-stroke.
      // The browser fires a 0-pressure pointerMove just before pointerUp; processing
      // it would cause zero-size drawing artifacts. The stroke end is handled by pointerUp.
      if (e.pressure === 0) {
        pressure = this.self.mousedown ? this.self.pressure : 0;
      } else {
        const minP = Number(this.ui.elements.pressureMinSlider.value) / 100;
        const maxP = Number(this.ui.elements.pressureMaxSlider.value) / 100;
        pressure = minP + (maxP - minP) * e.pressure;
        pressure = Math.round(pressure * 100) / 100;
      }

      // Update pressure indicators only for tools that use pressure
      const pressureTools = ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur'];
      const cursorStyle = this.ui.getCursorStyleForTool(this.self.tool, this.self);
      if (pressureTools.includes(this.self.tool) && cursorStyle === 'circle') {
        this.ui.updatePressureCursorRadius(pressureSizeFactor(this.self, pressure) * this.self.size, this.self.size, this.tabletDetected);
      }
      if ((this.self.tool === 'imageBrush' || cursorStyle === 'square') && this.self.tool !== 'glitchBlur') {
        this.ui.updatePressureSquareSize(pressureSizeFactor(this.self, pressure) * this.self.size, this.self.size, this.tabletDetected);
      }

      // If stroke start was deferred, now we have real pressure - start the stroke
      if (this._pendingPenDown) {
        const pending = this._pendingPenDown;
        this._pendingPenDown = null;
        this.self.setPressure(pressure);
        this.inputBufferManager.inputBuffer.pressure = pressure;
        const strokeMetadata = this._getStrokeStartNetworkMetadata();
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPressureChange(pressure));
        this._queueStrokeStartBroadcast([pending.pos.x, pending.pos.y], null, strokeMetadata);

        const tool = this.toolManager.getCurrentTool();
        if (tool) {
          tool.onPointerDown(this.self, pending.pos, pending.event);

          // Discard initial stamp from buffer — remote already stamps via handlePenDown (MD)
          if ((this.self.tool === 'flowPen' || this.self.tool === 'circleBlur') && tool.drainStampBuffer) {
            tool.drainStampBuffer();
          }
          if (this.self.tool === 'ink' && tool.drainPointBuffer) {
            tool.drainPointBuffer();
          }
        }
      } else if (pressure !== this.inputBufferManager.inputBuffer.pressure) {
        // Brush still commits per segment before updating pressure.
        if (pressure !== this.self.pressure && this.self.mousedown) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPressureChange(pressure));
          if (this.self.tool === 'brush') {
            this.commitSelfLine(pressure, this.self.size);
          }
        }
        this.self.setPressure(pressure);
        this.inputBufferManager.inputBuffer.pressure = pressure;
      }
    }

    const pushBufferedSample = (sampleEvent) => {
      const sampleConstrainedPos = this._bufferPointerSample(sampleEvent, e.pointerType);
      return {
        x: sampleConstrainedPos.x,
        y: sampleConstrainedPos.y,
        pointerType: sampleEvent.pointerType || e.pointerType,
      };
    };

    // Handle panning instantaneously and skip input buffering — remote cursor is hidden
    // during pan, so broadcasting pan-move samples is wasted bandwidth and pollutes telemetry.
    if (this.self.panning && this.self.mousedown) {
      const dx = e.clientX - this._lastPanPointerX;
      const dy = e.clientY - this._lastPanPointerY;
      this.board.pan(dx, dy);
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
      return;
    }

    const shouldUseCoalescedSamples =
      this.self.mousedown &&
      !this.self.panning &&
      COALESCED_INPUT_TOOLS.has(this.self.tool);
    const coalescedSamples = shouldUseCoalescedSamples ? e.getCoalescedEvents?.() : null;
    const samples = shouldUseCoalescedSamples && coalescedSamples?.length ? coalescedSamples : [e];

    let lastBufferedSample = null;
    for (const sample of samples) {
      lastBufferedSample = pushBufferedSample(sample);
    }

    this.inputBufferManager.inputBuffer.pointerType = lastBufferedSample?.pointerType || e.pointerType;
    this.inputBufferManager.requestLocalFrame();
  }

  handlePointerDown(e) {
    this.updateModifierKeysFromEvent(e);

    if (this.mirrorRegionController?.isActive()) {
      const consumed = this.mirrorRegionController.handlePointerDown(e);
      if (consumed) return;
    }

    // Reset smoothing buffer and state for new stroke immediately
    this.inputBufferManager.resetBroadcastSmoothing();
    this.self._mainCtxDrawCount = 0;
    this.self.mousedown = false;

    // Block local input while not yet connected (connecting overlay is showing)
    if (!this.connected && !this.isOfflineMode) return;

    // Block local input while syncing
    if (this.syncClient?.isSyncing() || this.syncClient?.isCanvasInputBlocked()) return;

    // Skip drawing during two-finger gestures
    if (this.touchHandler.state.isPinching || this.touchHandler.state.gestureStartedWithTwoFingers) {
      if (this.self.tool !== 'text') {
        this.ui.hideCursor();
      }
      return;
    }

    if (this.keyboardHandler?.handlePointerDown(e)) {
      return;
    }

    this._blurEmbeddedChatFocus();

    this.syncBoardHoverState(true, { forceRefresh: true, event: e });

    // Middle-click enables panning mode
    if (e.button === 1) {
      e.preventDefault();
      this.self.panning = true;
      this.self.mousedown = true;
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPan(true));

      const isTextWithContent = this.self.tool === 'text' && this.self.text;
      if (!isTextWithContent) {
        this.broadcastCursorVisibility(false);
        this.ui.showPanCursor();
      }
      return;
    }

    // Pan tool: left drag pans the canvas
    if (this.self.tool === 'pan') {
      if (e.button === 0) {
        this.self.panning = true;
        this.self.mousedown = true;
        this._lastPanPointerX = e.clientX;
        this._lastPanPointerY = e.clientY;
      }
      return;
    }

    if (this.self.tool === 'zoom') {
      if (e.button === 0) {
        const containerRect = this.ui.elements.boardContainer.getBoundingClientRect();
        const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
        this._rightDragZoomActive = true;
        this._rightDragZoomPointerId = e.pointerId;
        this._rightDragZoomStartClientY = e.clientY;
        this._rightDragZoomStartZoom = this.board.zoom;
        this._rightDragZoomPivotX = e.clientX - containerRect.left;
        this._rightDragZoomPivotY = e.clientY - containerRect.top;
        this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
        this.ui.showZoomCursor();
        this.self.mousedown = true;
        e.target.setPointerCapture?.(e.pointerId);
      }
      return;
    }

    // Rotate tool: left drag rotates around the click point
    if (this.self.tool === 'rotate') {
      if (e.button === 0) {
        const containerRect = this.ui.elements.boardContainer.getBoundingClientRect();
        this._rotatePivotX = e.clientX - containerRect.left;
        this._rotatePivotY = e.clientY - containerRect.top;
        this._rotatePivotClientX = e.clientX;
        this._rotatePivotClientY = e.clientY;
        this._rotatePrevAngle = null;
        this._rotateToolActive = true;
        this.self.mousedown = true;
        e.target.setPointerCapture(e.pointerId);
      }
      return;
    }

    // Right-click drag zooms around the clicked point, when the active tool's
    // right-click action is set to Zoom Drag. Other actions run from the
    // `contextmenu` handler instead.
    if (e.button === 2) {
      e.preventDefault();
      if (this.getRightClickAction() !== 'zoom') return;
      const containerRect = this.ui.elements.boardContainer.getBoundingClientRect();
      const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
      this._rightDragZoomActive = true;
      this._rightDragZoomPointerId = e.pointerId;
      this._rightDragZoomStartClientY = e.clientY;
      this._rightDragZoomStartZoom = this.board.zoom;
      this._rightDragZoomPivotX = e.clientX - containerRect.left;
      this._rightDragZoomPivotY = e.clientY - containerRect.top;
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
      this.ui.showZoomCursor();
      e.target.setPointerCapture?.(e.pointerId);
      return;
    }

    // Only draw with left-click (button === 0)
    if (e.button !== 0) return;

    // Block drawing on invisible layers
    if (!this.self.panning && !this.board.layerManager.isLayerVisible(this.self.activeLayer)) {
      if (!this._lastInvisibleToast || Date.now() - this._lastInvisibleToast > 3000) {
        this.ui.showToast('Selected layer is hidden', 2000);
        this._lastInvisibleToast = Date.now();
      }
      return;
    }

    // Block drawing when muted (allow panning)
    if (this.self.isMuted && !this.self.panning) {
      if (!this._lastMuteToast || Date.now() - this._lastMuteToast > 3000) {
        this.ui.showToast('You are muted', 2000);
        this._lastMuteToast = Date.now();
      }
      return;
    }

    // Block blur tool on non-base layers (allow panning)
    if (this._blurCannotDraw && !this.self.panning) {
      if (!this._lastBlurLayerToast || Date.now() - this._lastBlurLayerToast > 3000) {
        this.ui.showToast('Blur only works on Layer 1', 2000);
        this._lastBlurLayerToast = Date.now();
      }
      return;
    }

    // Detect tablet on first pen event
    if (e.pointerType === 'pen' && !this.tabletDetected) {
      this.tabletDetected = true;

      // Auto-disable thinning for tablet users
      this.self.setSimulatePressure(false);
      localStorage.setItem('topDrawSimulatePressure', 'false');
      if (this.ui.elements.thinningEnabled) {
        this.ui.elements.thinningEnabled.checked = false;
      }
      this.ui.setThinningTrackVisible(false);
      if (this.connected) {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSimulatePressureChange(false));
      }

      // Show toast - defer to not block stroke
      setTimeout(() => {
        this.ui.showToast('Tablet detected - disabling thinning', 3000);
      }, 100);
    }

    const toolUsesPressure = this._toolUsesPressure(this.self.tool);
    if (toolUsesPressure) {
      if (e.pointerType === 'mouse' || !this.pressureEnabled) {
        this.self.setPressure(1);
        this.inputBufferManager.inputBuffer.pressure = 1;
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPressureChange(1));
      } else if (e.pointerType === 'pen' && this.pressureEnabled) {
        // Start pen input at 0 pressure until real pressure data arrives
        this.self.setPressure(0);
        this.inputBufferManager.inputBuffer.pressure = 0;
      }
    } else {
      // Non-pressure tools keep pressure at full to avoid side effects.
      this.self.setPressure(1);
      this.inputBufferManager.inputBuffer.pressure = 1;
    }

    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    if (this._isCanvasRegionLocked(pos)) {
      this._notifyCanvasRegionLocked();
      return;
    }

    // Initialize input buffer for this stroke
    this.inputBufferManager.inputBuffer.position = pos;
    this.inputBufferManager.inputBuffer.lastPosition = pos;
    this.inputBufferManager.inputBuffer.movement = { x: 0, y: 0 };
    this.inputBufferManager.inputBuffer.pointerType = e.pointerType;

    // Reset broadcast smooth buffer for new stroke
    this.inputBufferManager.broadcastSmoothBuffer.isFirst = true;

    // Fully reset self position state for new stroke to prevent jumping
    this.self.resetPosition(pos.x, pos.y);
    // For pen input that will be deferred, update cursor with estimated pressure to avoid showing full-size dot
    if (e.pointerType === 'pen' && this.pressureEnabled && this.self.tool !== 'text' && toolUsesPressure) {
      const estimatedPressure = 0.5; // Reasonable default for initial pen pressure
      const pressureTools = ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur'];
      const cursorStyle = this.ui.getCursorStyleForTool(this.self.tool, this.self);
      if (pressureTools.includes(this.self.tool) && cursorStyle === 'circle') {
        this.ui.updatePressureCursorRadius(pressureSizeFactor(this.self, estimatedPressure) * this.self.size, this.self.size, this.tabletDetected);
      } else if ((this.self.tool === 'imageBrush' || cursorStyle === 'square') && this.self.tool !== 'glitchBlur') {
        this.ui.updatePressureSquareSize(pressureSizeFactor(this.self, estimatedPressure) * this.self.size, this.self.size, this.tabletDetected);
      }
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
    } else {
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
    }
    this.self.mousedown = true;
    appState.isDrawingStroke = true;
    this.self.spaceIndex = 0;
    this.self._mainCtxDrawCount = 0; // Reset draw counter for this stroke

    // If panning (e.g. via Space key), initialize pan tracking coordinates
    if (this.self.panning) {
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
    }

    // Reset smoothing buffer for new stroke
    this.inputBufferManager.resetBroadcastSmoothing();

    // Defer broadcastMouseDown for pen input — pressure isn't known yet at pointerDown,
    // so sending MD now would cause the remote side to draw the initial dot at max size.
    // It will be sent when _pendingPenDown is resolved in handlePointerMove.
    // Also don't broadcast if panning to prevent unwanted dots when space+click panning.
    // Touch and mouse should broadcast immediately to enable "dots" (single clicks/taps).
    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        // For text tool with touch, don't commit immediately - wait for pointerUp
        // to allow two-finger gestures to cancel the text placement
        if (this.self.tool === 'text' && e.pointerType === 'touch') {
          this.self.mousedown = true;
          // Store pending text position but don't call onPointerDown yet
          this.self._pendingTextPos = pos;
          this.self._pendingTextPointerType = e.pointerType;

          // Update local position so the cursor/preview follows the touch immediately
          this.self.setPosition(pos.x, pos.y);
          this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);

          // Focus hidden input for touch keyboard support
          this.ui.activateTouchInput(e.clientX, e.clientY);
          
          // DO NOT broadcastMouseDown here. We wait until pointerUp for text+touch.
        } else if (e.pointerType === 'pen' && this.pressureEnabled && this.self.tool !== 'text' && toolUsesPressure) {
          // Defer pen stroke start until first pointerMove provides real pressure
          this._pendingPenDown = { pos, event: e };
        } else {
          // Standard immediate placement/stroke start
          
          // For tools that use smoothing, send the smoothed initial point instead of raw click.
          // This ensures remote users see perfect parity with the sender.
          const smoothingTools = ['brush', 'flowPen', 'ink', 'imageBrush'];
          let broadcastPos = [pos.x, pos.y];
          if (smoothingTools.includes(this.self.tool)) {
            const smoothed = this.inputBufferManager.applyBroadcastSmoothing([pos.x, pos.y]);
            broadcastPos = [smoothed[0], smoothed[1]];
            // Update local self position to match the smoothed broadcast position
            this.self.setPosition(smoothed[0], smoothed[1]);
          }
          if (this.self.tool === 'text' && this.self.text) {
            this._broadcastExplicitTextApply({ x: this.self.x, y: this.self.y });
          }
          const strokeMetadata = this._getStrokeStartNetworkMetadata();
          this._queueStrokeStartBroadcast(broadcastPos, null, strokeMetadata);

          tool.onPointerDown(this.self, pos, e);

          // Discard initial stamp from buffer — remote already stamps via handlePenDown (MD)
          if ((this.self.tool === 'flowPen' || this.self.tool === 'circleBlur') && tool.drainStampBuffer) {
            tool.drainStampBuffer();
          }
          if (this.self.tool === 'ink' && tool.drainPointBuffer) {
            tool.drainPointBuffer();
          }

          // If text tool was used to commit text, update UI to clear the text display
          if (this.self.tool === 'text') {
            this.ui.updateSelfTextInput(this.self.text);
            this._updateTextPreview();
          }
        }
      }

      const colorlessRecentTools = new Set(['select', 'erase', 'blur', 'circleBlur', 'glitchBlur', 'pan', 'zoom', 'rotate', 'inkdropper']);
      if (Array.isArray(this.self.color) && !colorlessRecentTools.has(this.self.tool)) {
        addRecentColor(this.self.color);
      }
    }
  }

  _broadcastExplicitTextApply(position = null) {
    if (!this.self?.text) return;
    const x = position?.x ?? this.self.x;
    const y = position?.y ?? this.self.y;
    const isPixel = this.self.textRenderMode === 'pixel';

    const id = isPixel
      ? ''
      : `t_${this.self.id ?? 0}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const snapshot = {
      id,
      text: this.self.text,
      x, y,
      size: this.self.size,
      color: [...this.self.color],
      opacity: this.self.opacity,
      layerIndex: this.self.activeLayer ?? 0,
      blendMode: this.self.blendMode || 'source-over',
      blendBakeMode: this.self.blendBakeMode || 'background',
      font: this.self.font,
      textPositionMultiplier: this.self.textPositionMultiplier,
      textPositionOffset: this.self.textPositionOffset,
      pixel: isPixel,
      // Send the room's current overlay lifetime so the server records a
      // matching lifetime and remote clients fade in lockstep with the placer.
      lifetimeMs: isPixel
        ? 0
        : (this.board.textOverlay?.getRoomLifetime?.() ?? TEXT_OVERLAY_DEFAULT_LIFETIME_MS),
      fadeMs: isPixel
        ? 0
        : (this.board.textOverlay?.getRoomLifetime?.() ?? TEXT_OVERLAY_DEFAULT_FADE_MS)
    };

    if (isPixel) {
      // Legacy raster path: commit text as a stroke immediately (locally + via the
      // existing stroke-sync mechanism wrapping MD/MU). The user object's x/y is
      // updated to the placement position so drawText reads the right coords.
      const prevX = this.self.x;
      const prevY = this.self.y;
      this.self.x = x;
      this.self.y = y;
      this.board.beginStroke(this.self);
      const textTool = this.toolManager.getTool('text');
      textTool?.drawText?.(this.self);
      // Tagged so the TEXT_APPLY self echo can reconcile this optimistic stroke
      // to the authoritative seq observers commit the same bake with. Untagged it
      // stays at seq 0, which sorts to the top of the stack ordered by our own
      // clock while observers place it by seq — a permanent z-order split once
      // the overflow bake flattens it.
      this.board.endStroke(this.self, { pendingCommitEcho: 'text_apply' });
      this.self.x = prevX;
      this.self.y = prevY;
    } else {
      // Vector path: add to the local SVG overlay; expires after lifetimeMs.
      this.board.textOverlay?.add({
        id,
        userId: this.self.id ?? 0,
        text: snapshot.text,
        font: snapshot.font,
        size: snapshot.size,
        color: snapshot.color,
        opacity: snapshot.opacity,
        x: snapshot.x,
        y: snapshot.y,
        textPositionMultiplier: snapshot.textPositionMultiplier,
        textPositionOffset: snapshot.textPositionOffset,
        layerIdx: snapshot.layerIndex,
        lifetimeMs: snapshot.lifetimeMs,
        fadeMs: snapshot.fadeMs
      });
    }

    if (!this.connected || !this.wsClient) return;
    this.inputBufferManager.queueBroadcast(() => {
      this.wsClient.broadcastTextApply(snapshot);
    });
  }

  /**
   * Queue the stroke-start (MD) broadcast and mark a stroke open on the wire.
   *
   * Pairs with {@link DrawingApp#_queueStrokeEndBroadcast}. Everything that sends MD
   * must go through here so the MU guard there stays accurate — a missing MU
   * would leave the stroke open on every observer.
   * @param {number[]} points - Board-space [x, y] of the stroke start.
   * @param {number[]|null} radii
   * @param {Object} metadata - From `_getStrokeStartNetworkMetadata()`.
   * @returns {void}
   */
  _queueStrokeStartBroadcast(points, radii, metadata) {
    this._strokeMdBroadcast = true;
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseDown(points, radii, metadata));
  }

  /**
   * Queue the matching stroke-end (MU) broadcast — but only if we actually
   * opened a stroke on the wire.
   *
   * `pointerup` is bound to `window` while `pointerdown` is bound to the board,
   * so every release over the sidebar, a slider, a button or the chat used to
   * emit an MU with no MD behind it. Observers ignore those (`handleMouseUp`
   * early-returns on `!user.mousedown`), but the server still numbers them, and
   * the sender's own echo runs `reconcileOldestLocalStroke` — which stamps that
   * seq onto whatever local stroke is still optimistic. The sender's undo stack
   * then names a seq nobody else ever bound to a stroke, and its UNDO resolves
   * to a different record on every other client. One 25-minute recording
   * (docs/ddraw_replay_2026-08-12_22-00-46.ddraw) carried 231 of these from a
   * single user, and 11 undos named one.
   * @returns {void}
   */
  _queueStrokeEndBroadcast() {
    if (!this._strokeMdBroadcast) return;
    this._strokeMdBroadcast = false;
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseUp());
  }

  _getStrokeStartNetworkMetadata() {
    const metadata = {
      layerIndex: this.self?.activeLayer ?? 0,
      blendMode: this.self?.blendMode || 'source-over',
      blendBakeMode: this.self?.blendBakeMode || 'background',
      // Every stroke records the targets it was drawn with.
      pressureTargets: this.self?.pressureTargets ?? DEFAULT_PRESSURE_TARGETS
    };
    if (this.self?.tool === 'confetti') {
      const confettiTool = this.toolManager?.getTool('confetti');
      const initialSeed = confettiTool?.createSeed?.();
      if (initialSeed !== undefined) {
        this.self._confettiStrokeSeed = initialSeed;
        metadata.confettiData = JSON.stringify(confettiTool.getNetworkSettings(this.self, { initialSeed }));
      }
    }
    return metadata;
  }

  handlePointerUp(e) {
    this.updateModifierKeysFromEvent(e);

    if (this.mirrorRegionController?.isActive()) {
      const consumed = this.mirrorRegionController.handlePointerUp(e);
      if (consumed) return;
    }

    if (this.keyboardHandler?.handlePointerUp(e)) return;

    // Block local input while syncing
    if (this.syncClient?.isSyncing() || this.syncClient?.isCanvasInputBlocked()) return;
    if (this._rightDragZoomActive && e.pointerId === this._rightDragZoomPointerId) {
      this._rightDragZoomActive = false;
      this._rightDragZoomPointerId = null;
      if (this.self.tool === 'zoom') {
        this.self.mousedown = false;
      }
        this.ui.hidePanCursor(this.self.tool, this.self);
        this.ui.updateZoomDisplay(this.board.getZoomPercent());
        this.boardViewer?.setMainZoom(this.board.zoom);
        this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
        return;
    }

    // Middle-click release disables temporary panning regardless of active tool
    if (e.button === 1) {
      this.self.panning = false;
      this.self.mousedown = false;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPan(false));
      this.broadcastCursorVisibility(true);
      this.ui.hidePanCursor(this.self.tool, this.self);
      return;
    }

    // Pan tool: release clears panning
    if (this.self.tool === 'pan') {
      if (e.button === 0) {
        this.self.panning = false;
        this.self.mousedown = false;
      }
      return;
    }

    if (this.self.tool === 'zoom') {
      if (e.button === 0) {
        this.self.mousedown = false;
      }
      return;
    }

    // Rotate tool: release ends rotation
    if (this.self.tool === 'rotate') {
      if (e.button === 0) {
        this._rotateToolActive = false;
        this._rotatePrevAngle = null;
        this.self.mousedown = false;
      }
      return;
    }

    // Only handle left-click release for drawing
    if (e.button !== 0) return;

    // If a two-finger gesture occurred, cancel any pending text placement
    if (this.touchHandler.state.gestureStartedWithTwoFingers) {
      this.self._pendingTextPos = null;
      this.self._pendingTextPointerType = null;
      this.self.mousedown = false;
      this._queueStrokeEndBroadcast();
      this.inputBufferManager.inputBuffer.dirty = false;
      return;
    }

    // If pointer was lifted without moving, flush the pending stroke as a single dot.
    // This applies to pen (which deactivates MD broadcast) and any other input
    // that might have finished before the first tick occurred.
    if (this._pendingPenDown || (this.self.mousedown && this.self._mainCtxDrawCount === 0)) {
      const pending = this._pendingPenDown;
      this._pendingPenDown = null;

      // For pen deactivation, we need to manually start the stroke now.
      // For touch/mouse, the stroke already started in handlePointerDown.
      if (pending) {
        // Pen was lifted without moving - pressure starts at 0, so tap will be invisible or tiny
        // This is correct behavior: dots should only appear with intentional pen pressure
        const tool = this.toolManager.getCurrentTool();
        if (tool) {
          // Keep remote pressure state in sync for deferred pen taps. Without this,
          // remote clients reuse the previous stroke's pressure when MD arrives,
          // which can produce a large start dot for pressure-sensitive tools.
          if (this._toolUsesPressure(this.self.tool)) {
            this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPressureChange(this.self.pressure));
          }
          const strokeMetadata = this._getStrokeStartNetworkMetadata();
          this._queueStrokeStartBroadcast([pending.pos.x, pending.pos.y], null, strokeMetadata);
          tool.onPointerDown(this.self, pending.pos, pending.event);
          if (this.self.tool === 'circleBlur' && tool.drainStampBuffer) {
            tool.drainStampBuffer();
          }
        }
      }
    }

    const shouldBufferPointerUp =
      this.self.mousedown &&
      !this.self.panning &&
      COALESCED_INPUT_TOOLS.has(this.self.tool);
    if (shouldBufferPointerUp) {
      this._bufferPointerSample(e);
    }

    // Flush any locally-rendered-but-not-yet-sent points before ending the stroke.
    this.inputBufferManager.processLocalFrame();
    this.inputBufferManager.flushPendingNetwork();
    this.inputBufferManager.cancelLocalFrame();

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();

      // Handle text tool touch placement on lift
      if (this.self.tool === 'text' && this.self._pendingTextPos && e.pointerType === 'touch') {
        const textTool = this.toolManager.getTool('text');
        if (textTool) {
          // Broadcast final position before MU so remote users draw it in the right place
          if (this.connected) {
            if (this.self.text) {
              this._broadcastExplicitTextApply(this.self._pendingTextPos);
            }
            const strokeMetadata = this._getStrokeStartNetworkMetadata();
            this._queueStrokeStartBroadcast([this.self._pendingTextPos.x, this.self._pendingTextPos.y], null, strokeMetadata);
          }
          textTool.onPointerDown(this.self, this.self._pendingTextPos, e);
          this.ui.updateSelfTextInput(this.self.text);
        }
        this.self._pendingTextPos = null;
        this.self._pendingTextPointerType = null;
      } else if (tool) {
        tool.onPointerUp(this.self, { x: this.self.x, y: this.self.y }, e);

        // Flush any stamps generated by onPointerUp (e.g. final position stamps)
        if (this.self.tool === 'flowPen' && tool.stampBuffer && tool.stampBuffer.length > 0) {
          const { ps: stampPs, rs: stampRs } = tool.drainStampBuffer();
          if (stampPs.length > 0) {
            this.wsClient.broadcastStampMove(stampPs, stampRs);
          }
        }

        // Flush ink point buffer on pointer up
        if (this.self.tool === 'ink' && tool.pointBuffer && tool.pointBuffer.length > 0) {
          const { ps: fhPs, rs: fhRs } = tool.drainPointBuffer();
          if (fhPs.length > 0) {
            this.wsClient.broadcastStampMove(fhPs, fhRs);
          }
        }
      }
    }

    this.self.mousedown = false;
    appState.isDrawingStroke = false;
    this._queueStrokeEndBroadcast();

    // Reset input buffer
    this.inputBufferManager.inputBuffer.dirty = false;
  }

  handlePointerLeave(e) {
    this.syncBoardHoverState(false, { forceRefresh: true, event: e });
    if (this.self.tool === 'inkdropper') {
      this.board.clearTop();
    }
  }

  // boardContainer pointer handlers: support the same viewport controls on the background.

  handleBoardContainerPointerDown(e) {
    if (this.syncClient?.isCanvasInputBlocked()) return;

    // Replay-mode pan: left-click anywhere over the canvas drags the view, no
    // tool switch / Space hold required. Mirrors snapshot-history feel. Only
    // act on targets that represent the canvas region — replay canvas, the
    // #boards wrapper, or the bare container background.
    if (this.TimeMachine?.isReviewing && e.button === 0) {
      const t = e.target;
      const isCanvasRegion = t === this.ui.elements.boardContainer
        || t?.id === 'boards'
        || t?.id === 'replayCanvas';
      if (isCanvasRegion) {
        e.preventDefault();
        this._containerPanActive = true;
        this._lastPanPointerX = e.clientX;
        this._lastPanPointerY = e.clientY;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
        return;
      }
    }

    // Only handle events on the boardContainer background itself (not bubbled from canvas/children)
    if (e.target !== this.ui.elements.boardContainer) return;

    // A second finger landing mid-drag is the start of a pinch — hand the view
    // over to TouchHandler instead of fighting it with a one-finger pan.
    if (this._containerPanActive && e.pointerId !== this._containerPanPointerId) {
      this._endContainerPan();
      return;
    }

    if (this.keyboardHandler?.handlePointerDown(e)) return;

    this._blurEmbeddedChatFocus();

    // Check if select tool is active and has a handle at this position
    if (e.button === 0 && this.self.tool === 'select' && !this.self.panning) {
      const selectToolLoader = this.toolManager.tools.select;
      const selectTool = selectToolLoader?.realTool;
      if (selectTool && selectTool.selection) {
        const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
        const handle = selectTool.getHandleAtPoint(pos);
        if (handle) {
          // Forward to handlePointerDown - treat it as if clicked on the canvas
          this.handlePointerDown(e);
          return;
        }
        // Background (not a handle) with an active selection: dragging pans,
        // a tap commits and deselects on release.
        this._startBackgroundPan(e, { deselectOnTap: true });
        return;
      }
    }

    // Middle-click: enable panning
    if (e.button === 1) {
      e.preventDefault();
      this.self.panning = true;
      this.self.mousedown = true;
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPan(true));

      const isTextWithContent = this.self.tool === 'text' && this.self.text;
      if (!isTextWithContent) {
        this.broadcastCursorVisibility(false);
        this.ui.showPanCursor();
      }

      this._containerPanActive = true;
      this._containerPanPointerId = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if ((this.self.tool === 'zoom' && e.button === 0) || e.button === 2) {
      e.preventDefault();
      if (e.button === 2 && this.getRightClickAction() !== 'zoom') return;
      const containerRect = this.ui.elements.boardContainer.getBoundingClientRect();
      const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
      this._rightDragZoomActive = true;
      this._rightDragZoomPointerId = e.pointerId;
      this._rightDragZoomStartClientY = e.clientY;
      this._rightDragZoomStartZoom = this.board.zoom;
      this._rightDragZoomPivotX = e.clientX - containerRect.left;
      this._rightDragZoomPivotY = e.clientY - containerRect.top;
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
      this.ui.showZoomCursor();
      if (this.self.tool === 'zoom' && e.button === 0) {
        this.self.mousedown = true;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (this.self.tool === 'rotate' && e.button === 0) {
      const containerRect = this.ui.elements.boardContainer.getBoundingClientRect();
      this._rotatePivotX = e.clientX - containerRect.left;
      this._rotatePivotY = e.clientY - containerRect.top;
      this._rotatePivotClientX = e.clientX;
      this._rotatePivotClientY = e.clientY;
      this._rotatePrevAngle = null;
      this._rotateToolActive = true;
      this.self.mousedown = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;

    // Left-click on background: pan with the pan tool or while a temporary pan is active.
    if (this.self.tool === 'pan' || this.self.panning) {
      this.self.panning = true;
      this.self.mousedown = true;
      this._containerPanActive = true;
      this._containerPanPointerId = e.pointerId;
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    // Any other tool: dragging the empty area around the board pans the view.
    // Nothing draws out here, so this needs no tool switch (useful on tablets).
    this._startBackgroundPan(e);
  }

  /**
   * Starts a view-only pan from the board background. Unlike the pan tool it
   * leaves `self.panning`/`self.mousedown` alone, so the active tool never
   * sees a stroke begin or end.
   */
  _startBackgroundPan(e, { deselectOnTap = false } = {}) {
    e.preventDefault();
    this._containerPanActive = true;
    this._containerPanPointerId = e.pointerId;
    this._containerPanStartX = e.clientX;
    this._containerPanStartY = e.clientY;
    this._containerPanDeselectOnTap = deselectOnTap;
    this._lastPanPointerX = e.clientX;
    this._lastPanPointerY = e.clientY;
    this.ui.elements.boardContainer.classList.add('is-background-panning');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }

  _endContainerPan() {
    this._containerPanActive = false;
    this._containerPanPointerId = null;
    this._containerPanDeselectOnTap = false;
    this.ui.elements.boardContainer.classList.remove('is-background-panning');
  }

  handleBoardContainerPointerMove(e) {
    if (this.syncClient?.isCanvasInputBlocked()) return;
    if (this._containerPanActive && this.touchHandler?.state.isPinching) {
      this._endContainerPan();
      return;
    }
    // Update select tool cursor when hovering over handles in the gray area
    if (this.self.tool === 'select' && !this._containerPanActive) {
      const selectToolLoader = this.toolManager.tools.select;
      const selectTool = selectToolLoader?.realTool;
      if (selectTool && selectTool.selection) {
        const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
        selectTool.updateCursor(pos);
      }
    }

    if (!this._containerPanActive) return;
    if (this._containerPanPointerId != null && e.pointerId !== this._containerPanPointerId) return;
    const dx = e.clientX - this._lastPanPointerX;
    const dy = e.clientY - this._lastPanPointerY;
    this.board.pan(dx, dy);
    this._lastPanPointerX = e.clientX;
    this._lastPanPointerY = e.clientY;
  }

  handleBoardContainerPointerUp(e) {
    if (this.syncClient?.isCanvasInputBlocked()) return;
    if (this.keyboardHandler?.handlePointerUp(e)) return;
    if (!this._containerPanActive) return;
    if (this._containerPanPointerId != null && e.pointerId !== this._containerPanPointerId) return;

    if (this._containerPanDeselectOnTap && e.button === 0) {
      const moved = Math.hypot(e.clientX - this._containerPanStartX, e.clientY - this._containerPanStartY);
      if (moved < 5) this.toolManager.tools.select?.realTool?.deselect();
    }
    this._endContainerPan();

    if (e.button === 1) {
      this.self.panning = false;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPan(false));
      this.broadcastCursorVisibility(true);
      this.ui.hidePanCursor(this.self.tool, this.self);
    }

    if (this.self.tool === 'pan' && e.button === 0) {
      this.self.panning = false;
      this.self.mousedown = false;
      this.ui.hidePanCursor(this.self.tool, this.self);
    }
  }

  handleBoardContainerWheel(e) {
    // In replay mode the visible canvas is the replay overlay; treat wheel
    // events anywhere over the board area as zoom requests.
    if (e.target !== this.ui.elements.boardContainer && !this.TimeMachine?.isReviewing) return;
    this.handleWheel(e);
  }

  // Wheel/zoom handlers

  handleWheel(e) {
    if (this.syncClient?.isCanvasInputBlocked()) return;
    e.preventDefault();

    const scrollToZoom = !!this.appPreferences?.general?.scrollToZoom;
    const inPanMode = this.self.panning || this.self.tool === 'pan' || this.self.tool === 'zoom' || this.self.tool === 'rotate';
    // Force zoom-on-scroll while reviewing — brush-size scroll has no meaning
    // on a frozen historical board.
    const inReplayReview = !!this.TimeMachine?.isReviewing;

    if (inPanMode || scrollToZoom || inReplayReview) {
      const cursorPos = this.board.getBoardRelativePos(e.clientX, e.clientY);
      if (e.deltaY > 0) {
        this.board.zoomOut(0.1, cursorPos);
      } else {
        this.board.zoomIn(0.1, cursorPos);
      }
      this.ui.updateZoomDisplay(this.board.getZoomPercent());
      this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
      this.boardViewer?.setMainZoom(this.board.zoom);
    } else if (!(this.self.tool === 'ink' && this.self.mousedown)) {
      this.handleSizeScroll(e.deltaY);
    }
  }

  handleSizeScroll(deltaY) {
    let size = this.self.size;
    let step = 1;

    // Variable size changing
    if (size < 2) step = 0.25;
    else if (size < 4) step = 0.5;
    else if (size <= 30) step = 1;
    else step = 2;

    if (deltaY > 0 && size - step > 0) {
      size -= step;
    } else if (deltaY < 0 && size + step < 100) {
      size += step;
    } else {
      return;
    }

    size = Math.round(size * 100) / 100;

    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSizeChange(size));
    if (this.self.mousedown && this.self.tool === 'brush') {
      this.commitSelfLine(this.self.pressure, size);
    }
    this.self.setSize(size);
    this.ui.elements.sizeSlider.value = size;
    this.ui.updateCursorSize(size);
    this.ui.updateSquarePositions(size);
    this.ui.updateSizeValue(size);
    this.ui.updateSelfTextStyle(size, this.self.color, this.self.font);
    this.board.viewCtx.lineWidth = size * 2;
  }

  adjustToolSize(direction) {
    if (direction === 0) return;
    this.handleSizeScroll(direction > 0 ? -1 : 1);
  }

  /**
   * Repaint everything living on a preview surface, after the surface window
   * moved or was re-allocated and threw it all away.
   *
   * viewCanvas and upperLayersCanvas rebuild themselves from the layer stack on
   * the next composite, which the window change already scheduled. topCanvas
   * and the per-user preview canvases hold tool-owned state that only the tool
   * can reproduce — a floating selection, a fill preview, a shape being dragged,
   * the eyedropper swatch.
   *
   * Remote users are included: their previews sit on their own `.userBoard`,
   * which is on the same window and is re-pointed at the same moment.
   * @private
   */
  _repaintLivePreviews() {
    // Reachable before the app is fully constructed: Board.setupCanvas applies
    // the window, and resizeBoard calls it again.
    if (!this.self || !this.toolManager) return;
    const repaint = (toolName, user) => {
      if (!toolName || !user) return;
      try {
        this.toolManager?.getTool?.(toolName)?.redrawPreview?.(user);
      } catch (err) {
        console.warn('[App] preview repaint failed for', toolName, err);
      }
    };

    repaint(this.activeTool ?? this.self?.tool, this.self);
    // Text is the exception: which surface its preview lives on depends on the
    // blend mode, and _updateTextPreview owns that decision for both branches.
    this._updateTextPreview();

    for (const user of this.users?.values?.() ?? []) {
      if (user?.mousedown) repaint(user.tool, user);
    }
  }

  /**
   * Updates the text preview, using canvas rendering when a blend mode is active
   * so that the preview correctly shows the blend effect against the canvas below.
   */
  _updateTextPreview() {
    if (this.self.tool !== 'text') return;
    const useCanvas = this.self.blendMode && this.self.blendMode !== 'source-over';
    if (useCanvas) {
      // Hide DOM element, draw to topCanvas (which already has mixBlendMode CSS applied)
      this.ui.elements.selfTextInput.style.visibility = 'hidden';
      this.board.clearTop();
      const textTool = this.toolManager.getTool('text');
      if (textTool) textTool.renderPreview(this.self);
    } else if (this.ui.elements.selfTextInput.style.visibility === 'hidden') {
      // Restore DOM element when switching back to normal blend mode
      this.ui.elements.selfTextInput.style.visibility = '';
      this.board.clearTop();
    }
  }

  _refreshTextRenderingAfterFontLoad(font) {
    const targetFont = normalizeTextFont(font);
    loadTextFont(targetFont).then(() => {
      if (this.self?.font === targetFont) {
        this.ui.updateSelfTextStyle(this.self.size, this.self.color, this.self.font);
        this._updateTextPreview();
      }

      for (const [userId, user] of this.users.entries()) {
        if (!user || userId === this.sessionIndex || user.font !== targetFont) continue;

        this.ui.updateRemoteFont(userId, user.font);
        this.ui.updateRemoteTextLayout(userId, user);

        if (user.tool === 'text' && user.text) {
          if (user.blendMode && user.blendMode !== 'source-over') {
            this.remoteUserHandler?._renderRemoteTextToCanvas?.(user);
          } else {
            this.ui.updateRemoteText(userId, user.text);
          }
        }
      }
    });
  }

  // Line utilities

  commitSelfLine(newPressure, newSize) {
    const brushTool = this.toolManager.getTool('brush');
    brushTool.commitCurrentLine(this.self, newPressure, newSize);
  }

  commitSelfEraserSegment(newPressure = this.self.pressure, newSize = this.self.size, newOpacity = this.self.opacity) {
    if (!this.self?.mousedown || this.self.tool !== 'erase') return;
    const eraserTool = this.toolManager.getTool('erase');
    eraserTool?.commitCurrentLine(this.self, newPressure, newSize, newOpacity);
  }

  /**
   * Resolves the configured right-click action for a tool.
   * @param {string} [tool] - Tool name; defaults to the active tool.
   * @returns {string} Action id from rightClickActions.js.
   */
  getRightClickAction(tool = this.self?.tool) {
    return resolveRightClickAction(this.appPreferences?.general?.rightClickActions, tool);
  }

  /**
   * Persists a right-click action for a tool. Defaults are stored as absences
   * so a later change to the default follows automatically.
   * @param {string} tool - Tool name.
   * @param {string} action - Action id.
   */
  setRightClickAction(tool, action) {
    if (!tool || !getRightClickActionsForTool(tool).includes(action)) return;

    const next = { ...(this.appPreferences?.general?.rightClickActions ?? {}) };
    if (action === getDefaultRightClickAction(tool)) {
      delete next[tool];
    } else {
      next[tool] = action;
    }

    this.setAppPreferences({
      ...this.appPreferences,
      general: {
        ...(this.appPreferences?.general ?? {}),
        rightClickActions: next
      }
    });
  }

  /**
   * Runs the right-click action bound to the active tool. Called from the
   * `contextmenu` handler, so `zoom` is a no-op here — the zoom drag is started
   * from pointerdown instead.
   * @param {PointerEvent|MouseEvent} e - The originating event.
   * @returns {boolean} True if an action ran.
   */
  performRightClickAction(e) {
    switch (this.getRightClickAction()) {
      case 'cancel':
        this.cancelCurrentStroke();
        return true;
      case 'selectionMode':
        this.toggleSelectionMode();
        return true;
      case 'layerMode':
        this.toggleActiveToolLayerMode();
        return true;
      case 'eyedropper':
        this.pickColorAtClientPoint(e.clientX, e.clientY);
        return true;
      default:
        return false;
    }
  }

  /**
   * Flips the Select tool between lasso and rectangle, keeping the radio
   * buttons in the tool options in sync. Any floating selection is committed
   * by `setMode()` first, the same as clicking the radio would.
   */
  toggleSelectionMode() {
    if (this.self?.tool !== 'select') return;

    const selectTool = this.toolManager.getTool('select');
    if (!selectTool) return;

    const next = selectTool.mode === 'lasso' ? 'rectangle' : 'lasso';
    selectTool.setMode(next);
    this._syncToolOptionRadios('selectionMode', next);
    this.ui.showToast(next === 'lasso' ? 'Selection: Lasso' : 'Selection: Rectangle', 1500);
  }

  /**
   * Flips the active tool's layer mode (Select: copy scope, Eraser: erase
   * scope), keeping the radio buttons in the tool options in sync.
   */
  toggleActiveToolLayerMode() {
    const tool = this.self?.tool;

    if (tool === 'select') {
      const selectTool = this.toolManager.getTool('select');
      if (!selectTool) return;

      const next = !selectTool.copyAllLayers;
      selectTool.toggleCopyAllLayers(next);
      this._syncToolOptionRadios('selectionLayerMode', next ? 'all' : 'active');
      this.ui.showToast(next ? 'Selection: All Layers' : 'Selection: Active Layer', 1500);
      return;
    }

    if (tool === 'erase') {
      this.eraseAllLayers = !this.eraseAllLayers;
      this.inputBufferManager.queueBroadcast(
        () => this.wsClient.broadcastEraserModeChange(this.eraseAllLayers, this.self.tool)
      );
      this._syncToolOptionRadios('eraserMode', this.eraseAllLayers ? 'all' : 'layer');
      this.ui.showToast(this.eraseAllLayers ? 'Erase: All Layers' : 'Erase: Active Layer', 1500);
    }
  }

  /**
   * Checks the radio in a named group without firing its change listener.
   * @param {string} groupName - The radio group's `name` attribute.
   * @param {string} value - The value to select.
   */
  _syncToolOptionRadios(groupName, value) {
    document.querySelectorAll(`input[name="${groupName}"]`).forEach(radio => {
      radio.checked = radio.value === value;
    });
  }

  /**
   * Samples the composited color under a viewport point into the active color,
   * without switching tools the way the Inkdropper tool does.
   * @param {number} clientX
   * @param {number} clientY
   */
  pickColorAtClientPoint(clientX, clientY) {
    const dropper = this.toolManager.getTool('inkdropper');
    if (!dropper?.sampleColor) return;

    const pos = this.board.getBoardRelativePos(clientX, clientY);

    // sampleColor auto-switches back to `previousTool` when the Inkdropper is
    // the active tool; here it is not, so suppress that entirely.
    const previousTool = this.previousTool;
    this.previousTool = null;
    try {
      dropper.sampleColor(pos);
    } finally {
      this.previousTool = previousTool;
    }
  }

  cancelCurrentStroke() {
    this.inputBufferManager.discardPendingStrokeInput();
    this._pendingPenDown = null;

    // Clear brush stroke data
    this.self.clearLine();

    // Clear pen stroke data
    this.self.penPoints = [];
    const penTool = this.toolManager.getTool('flowPen');
    if (penTool && penTool.clearStroke) {
      penTool.clearStroke();
    }

    // Clear ink stroke data
    const inkTool = this.toolManager.getTool('ink');
    if (inkTool && inkTool.clearStroke) {
      inkTool.clearStroke();
    }

    // Clear pixel brush stroke data
    const pixelTool = this.toolManager.getTool('pixel');
    if (pixelTool && pixelTool.clearStroke) {
      pixelTool.clearStroke(this.self);
    }

    // Clear shape tool data
    const lineTool = this.toolManager.getTool('line');
    if (lineTool) lineTool.startPos = null;
    const rectangleTool = this.toolManager.getTool('rectangle');
    if (rectangleTool) rectangleTool.startPos = null;
    const circleTool = this.toolManager.getTool('circle');
    if (circleTool) circleTool.startPos = null;

    // Clear select tool state
    const selectTool = this.toolManager.getTool('select');
    if (selectTool) {
      selectTool.isSelecting = false;
      selectTool.isDragging = false;
      selectTool.startPos = null;
    }

    this.self.mousedown = false;
    appState.isDrawingStroke = false;

    // Cancel active stroke in LayerManager (prevent zombie strokes)
    this.board.cancelStroke(this.self);

    // Clear the top canvas AFTER all tool state is reset
    // This ensures no residual preview remains
    this.board.clearTop();

    // CANCEL closes the stroke on observers, so the paired MU must not follow it.
    this._strokeMdBroadcast = false;
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastCancel(), { snapshot: false });
  }

  hasCurrentStrokeInProgress() {
    if (this.self?.mousedown) return true;

    const userId = this.self?.id;
    if (userId === undefined || !this.board?.layerManager?.layerGroups) return false;

    // Only an active stroke with actual content counts as "in progress". Changing
    // blend mode pre-creates an EMPTY active stroke (the blend sub-layer, via
    // createActiveLayerBlendSubLayer -> beginUserStroke) whose dirtyRect is still
    // the sentinel empty rect (maxX < minX). Counting that placeholder made undo
    // dead: handleUndo early-returns to cancel an in-progress stroke, and
    // cancelCurrentStroke only clears the CURRENT layer's stroke — so after you
    // changed blend on one layer then switched to another, the placeholder on the
    // old layer permanently blocked undo until you switched back. A real in-progress
    // stroke is already caught by the mousedown check above.
    return this.board.layerManager.layerGroups.some(group => {
      const active = group?.activeStrokeByUser?.get(userId);
      if (!active) return false;
      const dr = active.dirtyRect;
      return !!dr && dr.maxX >= dr.minX && dr.maxY >= dr.minY;
    });
  }

  handleUndo() {
    if (this.hasCurrentStrokeInProgress()) {
      this.cancelCurrentStroke();
      return;
    }

    // If the select tool has a floating lifted selection, the undo will pop the
    // selection erase stroke and restore the original pixels. The floating canvas
    // becomes orphaned, so discard it afterward to prevent accidental re-placement.
    const selectTool = this.toolManager?.getTool('select');
    const selectRealTool = selectTool?.realTool ?? selectTool;
    const hadLiftedSelection = !!(selectRealTool?.floatingCanvas && selectRealTool?._restoreData);

    const undoneBatch = this.board.undo(this.self.activeLayer, this.self.id);

    if (hadLiftedSelection) {
      selectTool.clearSelection();
    }

    if (this.connected) {
      // Tell everyone WHICH stroke we undid. Receivers otherwise re-resolve "this
      // user's latest live stroke" against their own bake state, and a client that
      // has baked a different prefix than us resolves a different stroke — an
      // irreversible divergence, since baking is permanent. 0 when our target was
      // still unsequenced; receivers then fall back to local resolution.
      const targetSeq = undoneBatch?.find?.((e) => (e?.record?.seq || 0) > 0)?.record?.seq || 0;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastUndo(targetSeq));
    }
  }

  handleRedo() {
    this.board.redo(this.self.id);
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastRedo());
    }
  }

  updateUndoRedoHud() {
    const lm = this.board.layerManager;
    const { hudUndoBtn, hudRedoBtn } = this.ui.elements;
    if (!lm || !hudUndoBtn || !hudRedoBtn) return;

    const userId = this.self?.id;
    const canUndo = lm.hasUndoableStroke?.(userId) ??
      lm.layerGroups.some(g => g.strokeStack.some(r => r.userId === userId));
    const canRedo = (lm.redoStackByUser.get(userId) ?? []).length > 0;

    this._setHudButtonVisible(hudUndoBtn, canUndo);
    this._setHudButtonVisible(hudRedoBtn, canRedo);
  }

  // Toggles a HUD undo/redo button's visibility, playing a brief highlight
  // animation the moment it goes from hidden to visible (e.g. the first
  // stroke on the board making Undo available) so it doesn't just silently
  // pop into existence.
  _setHudButtonVisible(btn, visible) {
    const wasHidden = btn.style.display === 'none';
    btn.style.display = visible ? '' : 'none';
    if (visible && wasHidden) {
      btn.classList.remove('hud-btn-appear');
      void btn.offsetWidth; // restart the animation if it's still running
      btn.classList.add('hud-btn-appear');
    }
  }

  // Keyboard handlers

  handleResize() {
    // Recompute the fit-to-view defaults (used by Reset View) for the new size,
    // but keep the board's current position/scale stable so it doesn't jump.
    this.board.calculateDefaultView();
    this.board.preserveViewOnResize();
    this.scheduleTopbarCollapseUpdate();
    this.mobileLayout.handleResize();
  }

  // Image Upload/Drop handlers

  async handleImageDataUrl(dataUrl) {
    if (!dataUrl || !this.canUseImageFeatures(true)) return;

    const img = new Image();
    img.onload = () => this.pasteLoadedImage(img);
    img.src = dataUrl;
  }

  async pasteLoadedImage(img) {
    const selectTool = this.toolManager.getTool('select');
    if (!selectTool) return false;

    const [boardH, boardW] = this.board?.dimensions || [];
    const matchesBoard = img.width === boardW && img.height === boardH;
    const shouldApplyFullBoard = matchesBoard && await this.ui.confirm('This image matches the board size. Upload it as a full-board image?', {
      title: 'Full-board image',
      confirmLabel: 'Upload',
      cancelLabel: 'Place as selection'
    });
    const pasted = await selectTool.pasteImage(img);

    if (pasted && shouldApplyFullBoard) {
      const realSelectTool = selectTool.realTool || selectTool;
      realSelectTool.deselect?.();
      this.ui?.showToast?.('Full-board image uploaded', 2000);
    }

    return pasted;
  }

  isImageFilename(name = '') {
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)$/i.test(name);
  }

  isImageFile(file) {
    if (!file) return false;
    if (file.type?.startsWith('image/')) return true;
    return this.isImageFilename(file.name || '');
  }

  isImageDropPayload(dataTransfer) {
    if (!dataTransfer) return false;

    const items = [...(dataTransfer.items || [])];
    if (items.some((item) => item.type?.startsWith('image/'))) return true;

    const files = [...(dataTransfer.files || [])];
    if (files.some((file) => this.isImageFile(file))) return true;
    if (files.some((file) => isDdrawFile(file))) return true;

    // Some desktop drags expose file items with empty MIME/type until drop.
    return items.some((item) => item.kind === 'file');
  }

  async handleDdrawFile(file) {
    try {
      this.ui?.showToast?.('Loading replay…', 60_000);
      const recording = await decodeDdraw(file);
      if (!recording?.openingSnapshot || !Array.isArray(recording?.deltas)) {
        this.ui?.showToast?.('Replay file is malformed', 3000, 'error');
        return;
      }
      await this.whenReplayReady();
      await this.TimeMachine?.loadFromRecording(recording);
    } catch (err) {
      console.error('[App] .ddraw load failed:', err);
      this.ui?.showToast?.('Could not load replay file', 3000, 'error');
    }
  }

  handleImageFile(file) {
    if (!this.isImageFile(file)) return;
    if (!this.canUseImageFeatures(true)) return;

    const reader = new FileReader();
    reader.onload = (e) => this.handleImageDataUrl(e.target.result);
    reader.readAsDataURL(file);
  }

  handleImageDrop(e) {
    if (e.target?.closest?.('.chat-shell')) return;
    e.preventDefault();
    this.clearBoardImageDragState();
    const files = [...(e.dataTransfer?.files || [])];

    // .ddraw replay files first — they have their own (canvas-independent)
    // path and don't need a room or image-features permission. Skips the
    // canvas-input block too so users can review replays mid-sync.
    const ddrawFile = files.find((file) => isDdrawFile(file));
    if (ddrawFile) {
      this.handleDdrawFile(ddrawFile);
      return;
    }

    if (this.syncClient?.isCanvasInputBlocked()) return;
    if (!this.canUseImageFeatures(true)) return;
    const imageFile = files.find((file) => this.isImageFile(file));
    if (imageFile) {
      this.handleImageFile(imageFile);
    } else if (files.length > 0) {
      this.ui.showToast('Dropped file is not a supported image', 3000, 'error');
    } else {
      // Handle dropped image URLs if any
      const html = e.dataTransfer.getData('text/html');
      const match = html && html.match(/src="?([^"\s]+)"?/);
      if (match && match[1]) {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
          this.pasteLoadedImage(img);
        };
        img.src = match[1];
      }
    }
  }

  handleBoardImageDragEnter(e) {
    if (!this.isImageDropPayload(e.dataTransfer)) return;
    if (e.target?.closest?.('.chat-shell')) return;
    e.preventDefault();
    this._boardDragDepth += 1;
    this.ui.elements.boardContainer?.classList.add('image-dragover');
  }

  handleBoardImageDragOver(e) {
    if (!this.isImageDropPayload(e.dataTransfer)) return;
    if (e.target?.closest?.('.chat-shell')) return;
    e.preventDefault();
    this.ui.elements.boardContainer?.classList.add('image-dragover');
  }

  handleBoardImageDragLeave(e) {
    if (!this.isImageDropPayload(e.dataTransfer)) return;
    if (e.target?.closest?.('.chat-shell')) return;
    e.preventDefault();
    this._boardDragDepth = Math.max(0, this._boardDragDepth - 1);
    if (this._boardDragDepth === 0) {
      this.ui.elements.boardContainer?.classList.remove('image-dragover');
    }
  }

  clearBoardImageDragState() {
    this._boardDragDepth = 0;
    this.ui.elements.boardContainer?.classList.remove('image-dragover');
  }

  /**
   * Creates a multi-layer floating selection from snapshot layer data (QOI-encoded).
   * Allows the user to move/scale the snapshot before committing to the board.
   * @param {Uint8Array[]} layers - Array of QOI-encoded layer data
   * @param {Object|null} cropRect - Optional crop region { x, y, width, height }
   */
  async uploadSnapshotLayersAsSelection(layers, cropRect = null) {
    if (!Array.isArray(layers) || layers.length === 0) {
      this.ui.showToast('No snapshot layers to upload', 3000, 'error');
      return;
    }

    try {
      // Get the SelectTool loader
      const loader = this.toolManager.getTool('select');
      if (!loader) {
        this.ui.showToast('Select tool not available', 3000, 'error');
        return;
      }

      // Ensure the real SelectTool is loaded (lazy-loaded chunk)
      let realSelectTool = loader.realTool;
      if (!realSelectTool && typeof loader.loadRealTool === 'function') {
        realSelectTool = await loader.loadRealTool();
      }
      if (!realSelectTool || typeof realSelectTool.initializeCorners !== 'function') {
        this.ui.showToast('Select tool failed to load', 3000, 'error');
        return;
      }

      // Switch to select tool (activates it, sets up canvas blend modes, marching ants)
      this.selectTool('select');

      // Commit any existing floating selection
      realSelectTool.commitSelection();
      realSelectTool.clearSelection();

      const [boardH, boardW] = this.board.dimensions;

      // Decode layers and build per-layer canvases for compositing.
      const floatingLayers = [];

      for (let groupIdx = 0; groupIdx < layers.length; groupIdx++) {
        const qoiData = layers[groupIdx];
        if (!qoiData || qoiData.length === 0) continue;

        try {
          // Decode QOI
          const pixels = wasm.qoi_decode(qoiData);
          if (!pixels || pixels.length === 0) continue;

          const dims = readQoiDimensions(qoiData);
          if (!dims) continue;

          const { width: qoiW, height: qoiH } = dims;

          // Create canvas and draw layer
          let canvas = document.createElement('canvas');
          let ctx = canvas.getContext('2d');

          if (cropRect) {
            // Crop mode: extract just the selected region
            const { x: sx, y: sy, width: sw, height: sh } = cropRect;
            canvas.width = sw;
            canvas.height = sh;

            // Draw the cropped portion from the decoded layer
            const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), qoiW, qoiH);
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = qoiW;
            tempCanvas.height = qoiH;
            tempCanvas.getContext('2d').putImageData(imageData, 0, 0);

            // Clamp crop rect to layer bounds
            const x = Math.max(0, Math.min(sx, qoiW));
            const y = Math.max(0, Math.min(sy, qoiH));
            const w = Math.min(sw, qoiW - x);
            const h = Math.min(sh, qoiH - y);

            if (w > 0 && h > 0) {
              ctx.drawImage(tempCanvas, x, y, w, h, 0, 0, w, h);
            }
          } else {
            // Full board mode: use entire layer
            canvas.width = boardW;
            canvas.height = boardH;
            const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), qoiW, qoiH);
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = qoiW;
            tempCanvas.height = qoiH;
            tempCanvas.getContext('2d').putImageData(imageData, 0, 0);
            ctx.drawImage(tempCanvas, 0, 0);
          }

          floatingLayers.push({ canvas, groupIdx });
        } catch (e) {
          console.warn(`[App] Failed to decode layer ${groupIdx}:`, e);
        }
      }

      if (floatingLayers.length === 0) {
        this.ui.showToast('No valid snapshot layers to upload', 3000, 'error');
        return;
      }

      // Build composite floatingCanvas (for transform preview)
      const compositeCanvas = document.createElement('canvas');
      const isCropMode = !!cropRect;
      if (isCropMode) {
        compositeCanvas.width = cropRect.width;
        compositeCanvas.height = cropRect.height;
      } else {
        compositeCanvas.width = boardW;
        compositeCanvas.height = boardH;
      }
      const compositeCtx = compositeCanvas.getContext('2d');
      for (const { canvas: layerCanvas } of floatingLayers) {
        compositeCtx.drawImage(layerCanvas, 0, 0);
      }

      // Determine placement
      let selection;
      if (isCropMode) {
        // Cropped: center in viewport
        const container = this.board.container;
        const containerWidth = container?.clientWidth || 800;
        const containerHeight = container?.clientHeight || 600;
        const zoom = this.board.zoom || 1;
        const panX = this.board.panX || 0;
        const panY = this.board.panY || 0;
        const viewCenterX = (containerWidth / 2 - panX) / zoom;
        const viewCenterY = (containerHeight / 2 - panY) / zoom;

        selection = {
          x: viewCenterX - cropRect.width / 2,
          y: viewCenterY - cropRect.height / 2,
          width: cropRect.width,
          height: cropRect.height
        };
      } else {
        // Full board: at origin
        selection = {
          x: 0,
          y: 0,
          width: boardW,
          height: boardH
        };
      }

      // Configure SelectTool for a standard floating paste selection.
      // We intentionally flatten snapshot layers here so the behavior matches
      // IMG_PASTE sync semantics used by remote clients.
      realSelectTool.selection = selection;
      realSelectTool.floatingCanvas = compositeCanvas;
      realSelectTool.floatingCtx = compositeCanvas.getContext('2d');
      realSelectTool.floatingLayers = null;
      realSelectTool.copyAllLayers = false;
      realSelectTool.originalSelectionPos = { x: -1, y: -1 };
      realSelectTool._restoreData = null;

      // Initialize transform handles
      realSelectTool.initializeCorners();
      realSelectTool.updateHandles();

      // Render selection UI
      this.board.clearTop();
      realSelectTool.drawSelectionUI();

      // Broadcast the pasted floating selection so remote users receive the
      // same selection state and subsequent commit/cancel operations sync.
      if (this.wsClient && this.connected) {
        const dataUrl = compositeCanvas.toDataURL('image/png');
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastImagePaste(
          selection.x,
          selection.y,
          selection.width,
          selection.height,
          dataUrl
        ));
      }

      this.ui.showToast('Snapshot loaded as floating selection', 2000);
    } catch (err) {
      console.error('[App] uploadSnapshotLayersAsSelection failed:', err);
      this.ui.showToast('Failed to upload snapshot layers', 3000, 'error');
    }
  }

  // Tool Locks Management

  // Room Preview

  /**
   * Starts the periodic room preview capture and broadcast.
   * Sends a 1/4 scale canvas preview to the server every 30 seconds.
   */
  startPreviewInterval() {
    this.stopPreviewInterval();

    // Send initial preview after a short delay to ensure canvas is rendered
    setTimeout(() => this.captureAndSendPreview(), 2000);

    this._previewInterval = setInterval(() => {
      this.captureAndSendPreview();
    }, this._previewIntervalMs);
  }

  /**
   * Stops the periodic room preview capture.
   */
  stopPreviewInterval() {
    if (this._previewInterval) {
      clearInterval(this._previewInterval);
      this._previewInterval = null;
    }
  }

  /**
   * Checks whether this client is the designated preview uploader and
   * starts/stops the preview and checkpoint intervals accordingly.
   */
  _updatePreviewUploadEligibility() {
    const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const myName = this.self?.registeredName || this.self?.username;
    // Manual pin takes priority over auto-elected user
    const activeUploader = this.currentRoomData?.dedicatedReplayUser
      || this.currentRoomData?.electedUploader
      || null;

    if (isHidden) {
      this.stopPreviewInterval();
      this.stopCheckpointInterval();
      return;
    }

    // While AFK our canvas is frozen — the server filters all draws to us — so
    // uploading a preview/checkpoint would persist a STALE snapshot that every
    // future joiner restores. The server election already won't pick an AFK
    // uploader, but there's a window where an elected uploader goes AFK before
    // the next election; bail out here so we never upload stale state. Also stop
    // local capture so we don't seed recovery from a frozen canvas.
    if (this.self?.afk) {
      this.stopPreviewInterval();
      this.stopCheckpointInterval();
      return;
    }

    if (activeUploader) {
      if (myName && myName === activeUploader) {
        this.stopPreviewInterval();
        this.startCheckpointInterval();
      } else {
        this.stopPreviewInterval();
        this.stopCheckpointInterval();
      }
    } else {
      this.stopCheckpointInterval();
      if (!this._previewInterval) this.startPreviewInterval();
    }
    
  }

  startCheckpointInterval() {
    this.stopCheckpointInterval();
    // Initial snapshot after a short delay
    setTimeout(() => this.snapshotManager?.handleServerRequest(), 3000);
    
    let tickCount = 0;
    this._checkpointInterval = setInterval(() => {
      // Save snapshot every 30s (every tick)
      this.snapshotManager?.handleServerRequest();
      
      // Send replay checkpoint every 60s (every other tick)
      tickCount++;
      if (tickCount >= 2) {
        this.captureAndSendCheckpoint();
        tickCount = 0;
      }
    }, this._checkpointIntervalMs);
  }

  stopCheckpointInterval() {
    if (this._checkpointInterval) {
      clearInterval(this._checkpointInterval);
      this._checkpointInterval = null;
    }
  }

  /**
   * Captures the full board and sends it as a checkpoint for replay.
   * The server also uses this as the room preview.
   */
  captureAndSendCheckpoint() {
    if (!this.connected || !this.wsClient || this.isOfflineMode) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    try {
      // This scales the WHOLE board into the checkpoint/preview, so it reads
      // the full raster rather than viewCanvas — viewCanvas is a display
      // surface and holds only what the viewport is showing.
      // Create a half-scale canvas to balance quality and bandwidth
      const scale = 0.5;
      const cpCanvas = document.createElement('canvas');
      cpCanvas.width = Math.floor(this.board.getWidth() * scale);
      cpCanvas.height = Math.floor(this.board.getHeight() * scale);
      if (!cpCanvas.width || !cpCanvas.height) return;

      const ctx = cpCanvas.getContext('2d');

      // Fill with background color
      const [r, g, b] = this.board.backgroundColor;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, 0, cpCanvas.width, cpCanvas.height);

      const drawn = this.board.withFullRaster((raster) => {
        ctx.drawImage(raster, 0, 0, cpCanvas.width, cpCanvas.height);
        return true;
      });
      if (!drawn) return;

      // Convert to PNG and send (allow up to 4MB for checkpoint)
      cpCanvas.toBlob((blob) => {
        if (blob && blob.size <= 4 * 1024 * 1024) {
          blob.arrayBuffer().then((buffer) => {
            this.wsClient.broadcastCheckpoint(new Uint8Array(buffer));
          });
        }
      }, 'image/png');
    } catch (err) {
      console.error('[App] Checkpoint capture error:', err);
    }
  }

  /**
   * Captures the current board at 1/4 scale and sends it to the server.
   */
  captureAndSendPreview() {
    if (!this.connected || !this.wsClient || this.isOfflineMode) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    try {
      // This scales the WHOLE board into the checkpoint/preview, so it reads
      // the full raster rather than viewCanvas — viewCanvas is a display
      // surface and holds only what the viewport is showing.
      // Create a 1/4 scale canvas
      const scale = 0.25;
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = Math.floor(this.board.getWidth() * scale);
      previewCanvas.height = Math.floor(this.board.getHeight() * scale);
      if (!previewCanvas.width || !previewCanvas.height) return;

      const ctx = previewCanvas.getContext('2d');

      // Fill with background color
      const [r, g, b] = this.board.backgroundColor;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

      const drawn = this.board.withFullRaster((raster) => {
        ctx.drawImage(raster, 0, 0, previewCanvas.width, previewCanvas.height);
        return true;
      });
      if (!drawn) return;

      // Convert to PNG blob and send
      previewCanvas.toBlob((blob) => {
        if (blob && blob.size <= 100 * 1024) { // Limit to 100KB
          blob.arrayBuffer().then((buffer) => {
            this.wsClient.broadcastRoomPreview(new Uint8Array(buffer));
          });
        }
      }, 'image/png', 0.7);
    } catch (err) {
      console.error('[App] Preview capture error:', err);
    }
  }

  get usersByName() {
    const m = new Map();
    this.users.forEach((user, id) => {
      m.set(user.username || `#${id}`, user);
    });
    return m;
  }
}
