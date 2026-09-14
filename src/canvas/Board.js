import { LayerManager } from './LayerManager.js';
import { CompositeTileGrid } from './CompositeTileGrid.js';
import {
  getSurfaceWindow,
  setSurfaceWindow,
  sizeWindowedSurface,
  applyWindowTransform,
  windowCovers,
  snapRectToDevicePixels,
  boardRectToDevice,
  clampDeviceRect
} from './surfaceWindow.js';

/**
 * Viewport culling (opt-in; see Board.viewportCulling).
 *
 * VIEW_CULL_PAD_PX pads the visible box in *screen* pixels, so a small pan or a
 * momentum flick reveals already-painted board instead of a blank strip while
 * the repair composite catches up.
 *
 * VIEW_CULL_MIN_HIDDEN is the fraction of the board that has to be off-screen
 * before culling engages at all. Below it the win is a handful of skipped
 * draws while the cost — rect intersection every composite, plus a full-board
 * repair before every export, flood fill or checkpoint — is unchanged, so the
 * trade only makes sense once a real majority of the board is not being looked
 * at (zoomed in, which is when the board is largest relative to the viewport).
 */
const VIEW_CULL_PAD_PX = 128;
const VIEW_CULL_MIN_HIDDEN = 0.35;
/**
 * Longest edge of the display proxy — a low-resolution mirror of the whole
 * board for second views that want the WHOLE board rather than the viewport.
 * Fixed rather than a ratio, so the proxy costs a constant ~16 MB no matter how
 * large the board is; that constant is the point, since a full-board RGBA
 * surface on a 12k board is ~576 MB and the second view is what used to force
 * one to stay live.
 */
const DISPLAY_PROXY_MAX_DIM = 2048;
/**
 * Largest proxy-pixels-per-board-pixel worth allocating for. The proxy only
 * earns its bytes when it is genuinely a reduction: at scale 1 — any board
 * inside DISPLAY_PROXY_MAX_DIM — it is a straight duplicate of viewCanvas, for a
 * per-frame culling saving that is correspondingly small. 0.7 keeps the proxy to
 * roughly half the board's pixels or less, and below it consumers fall back to
 * suspending culling, which is the behaviour that predates the proxy.
 */
const DISPLAY_PROXY_MIN_REDUCTION = 0.7;
/**
 * Screen-space slack around the visible box when sizing the surface window.
 *
 * The window has to be bigger than what is on screen or every pan would leave
 * it immediately, and moving the window costs a repaint. Same reasoning (and
 * same value) as VIEW_CULL_PAD_PX; it costs about 40 % more backing-store
 * pixels at 1080p, which is the price of pans that mostly do not repaint.
 */
const SURFACE_PAD_PX = 128;
/**
 * Ceiling on the device-pixel ratio the surfaces are rasterised at.
 *
 * The whole win here is that the backing store is container-sized rather than
 * board-sized, and dpr squares that: a phone at dpr 3 would pay 9x per surface
 * and hand most of the saving back. Past 2x there is nothing to see on a
 * painting surface.
 */
const SURFACE_MAX_DPR = 2;
/** Floor on surface scale, so an extreme zoom-out cannot round it to nothing. */
const SURFACE_MIN_SCALE = 1 / 16;
/**
 * Device-pixel quantum for the backing store.
 *
 * Rounding the store up to a step is what lets the window MOVE without being
 * re-allocated: assigning canvas.width drops and re-creates the backing store,
 * which is the operation measured to stall (userLayerPresence: a fresh 8k
 * canvas per frame took 180 fps to 92 with JS self-time flat).
 */
const SURFACE_STORE_STEP = 64;
import { TileTracker } from './TileTracker.js';
import { TextOverlay } from './TextOverlay.js';
import * as wasm from '../wasm/ddraw_wasm.js';
import { readQoiDimensions, snapshotLayerDimensions } from '../../shared/qoi.js';

/**
 * @fileoverview Board class managing canvas elements and viewport
 */

// Must outlast the 260ms opacity transition set on mirrorGuidesLayer, so the
// fade finishes before the layer leaves the compositing tree.
const MIRROR_GUIDE_FADE_MS = 300;
/**
 * Board-space padding around mirror overlay content. Covers the antialiasing
 * of the 0.5-1.15px hairlines these layers draw, so following the content
 * bounds never clips a stroke's outer edge.
 */
const MIRROR_LAYER_PAD = 4;

/**
 * Manages the drawing boards, viewport transformations, and compositing logic.
 */
export class Board {
  static MAX_ZOOM = 10;
  static MIN_ZOOM = 0.2;
  static HIGH_ZOOM_THRESHOLD = 5;

  /**
   * @param {Object} [options={}] - Configuration options for the board
   */
  constructor(options = {}) {
    this.dimensions = options.dimensions || [720, 1280];
    this.zoom = 1;
    this.defaultZoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.defaultPanX = 0;
    this.defaultPanY = 0;
    this.rotation = 0;
    this.defaultRotation = 0;
    this.canvasFlipped = false;
    this.mirror = false;
    this.mirrorRegions = [];
    this.backgroundColor = options.backgroundColor || [255, 255, 255, 1];
    this.roomBackgroundColor = options.backgroundColor || [255, 255, 255, 1];
    this.displayBackgroundColorOverride = null;

    this.container = null;
    this.boardsWrapper = null;
    this.viewCanvas = null;
    this.topCanvas = null;
    this.upperLayersCanvas = null;
    this.pixelGridOverlay = null;
    this.selectionOverlay = null;
    this.selectionOverlayPadding = 500;
    this.interactionBlockOverlay = null;
    this.interactionBlockCtx = null;
    this.viewCtx = null;
    this.topCtx = null;
    this.upperLayersCtx = null;
    this._upperLayersCompositeStart = null;
    this._upperLayersCompositeEnd = null;
    this._mainCompositeEnd = null;
  this.selectionCtx = null;
    this.cursorsSvg = null;
    this.mirrorLine = null;
    this._maskStopButton = null;
    /** @type {?Function} Wired by App: turns the local selection mask off. */
    this.onStopMasking = null;
    this.mirrorRegionsLayer = null;
    this.mirrorGuidesLayer = null;
    this.onMirrorRegionsChange = null;

    // The mirror CENTRE LINES (the global mirror line and each region's axis
    // guide) fade out after a short idle so they stop sitting on top of the
    // artwork. Region border rectangles are NOT part of this — they say where a
    // region is, which stays useful when you are looking rather than drawing, so
    // they live on their own always-visible layer. Any drawing that reaches a
    // mirror region, or the local pointer moving inside one, brings the lines
    // back. Pinned while the region editor is open.
    this.mirrorGuideIdleMs = 500;
    this.mirrorGuidesPinned = false;
    this._mirrorGuidesVisible = true;
    this._mirrorGuideIdleTimer = null;
    // Set by renderMirrorRegions; with _mirrorGuidesVisible it decides whether
    // the guides layer sits in the compositing tree at all.
    this._mirrorGuidesHasContent = false;
    this._mirrorGuidesHideTimer = null;

    this.layerManager = null;
    this.app = null;

    this.activeSelectionLayer = -1;
    this.activeFillPreviewLayer = -1;
    this.interactionBlocks = [];

    this.selectionMask = null;
    this.selectionMasksByUser = new Map();
    this._maskClippedStrokes = new Set();
    this._maskManagedBySelectTool = false;
    this.obscureRegions = new Map();
    this.obscureLayer = null;
    this.interactionBlockOverlayPadding = 500;
    this.interactionBlockDashOffset = 0;
    this.interactionBlockAnimationId = null;

    this._needsComposite = false;
    /**
     * Opt-in viewport culling. Off by default and deliberately not derived from
     * the tiling flag: the two are independent (culling helps an untiled board
     * too), and culling carries a correctness obligation tiling does not — every
     * full-board read of viewCanvas must call ensureFullComposite() first.
     */
    this.viewportCulling = false;
    /**
     * Opt-in viewport-sized display surfaces. Off by default, in which case the
     * surface window is the whole board at 1:1 and everything behaves exactly
     * as it did before the window existed. See _computeSurfaceWindow.
     */
    this.windowedSurfaces = false;
    /** Called after the surface window moves or resizes, so live previews can repaint. */
    this.onSurfaceWindowChange = null;
    /** Whether a culled composite has left viewCanvas stale outside the view. */
    this._compositeStaleOutsideView = false;
    /** Reference count of live second views; culling is off while non-zero. */
    this._viewCullSuspensions = 0;
    /** Board region the most recent culled composite painted. */
    this._lastCullView = null;
    /**
     * Display proxy: a low-resolution mirror of the entire board, kept current
     * from the same dirty rects that drive the composite and never culled.
     * Allocated only while something has acquired it. See _updateDisplayProxy.
     */
    this._proxyCanvas = null;
    this._proxyCtx = null;
    this._proxyScale = 1;
    this._proxyConsumers = 0;
    this._proxyDirtyRects = null;
    this._proxyNeedsFull = true;
    /**
     * Full raster: a board-sized 1:1 composite for readers that need every
     * pixel rather than the pixels currently on screen. Allocated only while
     * something holds it, and kept for a short idle window afterwards so a
     * burst of one-shot readers does not re-allocate a board-sized canvas each
     * time. See getFullRaster.
     */
    this._fullRasterCanvas = null;
    this._fullRasterCtx = null;
    this._fullRasterHolders = 0;
    this._fullRasterFreeTimer = null;
    this._compositeScheduled = false;

    // Flush any pending composite when the tab returns to visible — rAF is
    // paused while hidden, so a requestUpdate() scheduled in the background
    // would otherwise sit stalled until the next user-initiated frame.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this._needsComposite) {
          this._performScheduledComposite();
        }
      });
    }

    /** @type {TileTracker|null} Tracks occupied tiles */
    this.tileTracker = null;

    /** @type {number} Target render FPS (0 = uncapped/on-demand) */
    this.targetFPS = 0;
    // Resolved low power flag, set by App._applyLowPowerPreference. Read by
    // overlay-only paths (marching ants) that throttle themselves on weak devices.
    this.lowPowerMode = false;
    /** @type {number} DOMHighResTimeStamp of the last completed composite */
    this._lastCompositeTime = 0;
    /** @type {number|null} RAF ID for the persistent render loop */
    this._rafLoopId = null;
    this.compositeTileGrid = null;
    this.showRawPixelsAtHighZoom = true;
    this.useDesynchronizedBoardContexts = false;
    this._boardContextsInitialized = false;
    this._desyncDiagnosticsLogged = false;
    this._contextDesyncSupport = {};
    this._lastPixelGridZoom = null;
    this._lastPixelGridVisible = null;
    this._lastPixelGridPanX = null;
    this._lastPixelGridPanY = null;
    this._lastHighZoomCrisp = null;

    this._cachedContainerRect = null;
    this._containerResizeObserver = null;
    this._invalidateContainerRect = () => { this._cachedContainerRect = null; };

    // Last known container size, used to keep the board's viewport-center point
    // anchored across window/container resizes (see preserveViewOnResize()).
    this._lastContainerWidth = null;
    this._lastContainerHeight = null;
  }

  /**
   * Keep the board's current position and scale stable across a container
   * resize. Pan is applied as the outermost translation in the CSS transform,
   * so shifting it by half the container-size delta keeps whatever board point
   * was centered in the viewport centered afterward — independent of zoom and
   * rotation. Zoom is left untouched.
   */
  preserveViewOnResize() {
    if (!this.container) return;

    const newWidth = this.container.clientWidth;
    const newHeight = this.container.clientHeight;
    const oldWidth = this._lastContainerWidth;
    const oldHeight = this._lastContainerHeight;

    this._lastContainerWidth = newWidth;
    this._lastContainerHeight = newHeight;

    // First measurement (or a degenerate 0-size container) — nothing to preserve.
    if (oldWidth == null || oldHeight == null || oldWidth === 0 || oldHeight === 0) {
      return;
    }
    if (newWidth === oldWidth && newHeight === oldHeight) return;

    this.panX += (newWidth - oldWidth) / 2;
    this.panY += (newHeight - oldHeight) / 2;

    this.applyTransform();
  }

  _getContainerRect() {
    if (!this._cachedContainerRect) {
      this._cachedContainerRect = this.container.getBoundingClientRect();
    }
    return this._cachedContainerRect;
  }

  /**
   * Set reference to the DrawingApp
   * @param {Object} app - The main application instance
   */
  setApp(app) {
    this.app = app;
  }

  /**
   * Configure whether board canvases should request low-latency 2D contexts.
   * Returns true when a refresh is required for the change to take effect.
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setUseDesynchronizedBoardContexts(enabled) {
    const next = !!enabled;
    const changed = this.useDesynchronizedBoardContexts !== next;
    this.useDesynchronizedBoardContexts = next;
    return changed && this._boardContextsInitialized;
  }

  _createBoard2DContext(canvas, role, baseOptions = null) {
    const options = {
      ...(baseOptions || {})
    };

    if (this.useDesynchronizedBoardContexts) {
      options.desynchronized = true;
    }

    const ctx = canvas.getContext('2d', options);
    const attrs = typeof ctx?.getContextAttributes === 'function'
      ? ctx.getContextAttributes()
      : null;

    this._contextDesyncSupport[role] = {
      requested: !!this.useDesynchronizedBoardContexts,
      effective: !!attrs?.desynchronized,
      reported: !!attrs && typeof attrs.desynchronized === 'boolean'
    };

    return ctx;
  }

  _logDesyncDiagnostics() {
    if (this._desyncDiagnosticsLogged) return;

    this._desyncDiagnosticsLogged = true;
  }

  /**
   * Set the canvas background color from a hex string
   * @param {string} hex - Hex color string (e.g., "#ffffff")
   */
  setBackgroundColor(hex) {
    // Convert hex to RGBA array
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    this.backgroundColor = [r, g, b, 1];
    this.roomBackgroundColor = [r, g, b, 1];
    this._syncBoardWrapperBackground();
    this.markCompositeFull();
    this.requestUpdate();
  }

  /**
   * Set a local-only background color override used for board compositing.
   * This does not change the room background color used by blur/export/network logic.
   * @param {string|null} hex - Hex color string or null to clear override
   */
  setDisplayBackgroundColorOverride(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) {
      this.displayBackgroundColorOverride = null;
    } else {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      this.displayBackgroundColorOverride = [r, g, b, 1];
    }
    this._syncBoardWrapperBackground();
    this.markCompositeFull();
    this.requestUpdate();
  }

  getCompositeBackgroundColor() {
    return this.displayBackgroundColorOverride || this.backgroundColor;
  }

  _syncBoardWrapperBackground() {
    if (!this.boardsWrapper) return;
    const [r, g, b, a = 1] = this.getCompositeBackgroundColor();
    this.boardsWrapper.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  /**
   * Initialize board elements and layer manager
   * @param {string} containerSelector - CSS selector for the container element
   */
  init(containerSelector) {
    this.container = document.querySelector(containerSelector);
    this.boardsWrapper = document.getElementById('boards');
    this.viewCanvas = document.getElementById('board');
    this.topCanvas = document.getElementById('topBoard');
    this.cursorsSvg = document.getElementById('cursorsSvg');
    this.mirrorLine = document.querySelector('.mirrorLine');
    this._syncBoardWrapperBackground();

    // No willReadFrequently: it pins the largest and most frequently redrawn
    // canvas to software rasterization, so every composite runs on the CPU and
    // the result is re-uploaded to a GPU texture to be displayed — a per-frame
    // bandwidth cost proportional to board area (14.7MB at 1440p, 4x that of
    // 720p) that is paid whether or not anything was drawn. The reads it was
    // protecting are all one-shot and user-initiated (flood fill on
    // pointerdown, the eyedropper's 1x1 sample), so they pay a readback stall
    // on a click instead of taxing every frame.
    this.viewCtx = this._createBoard2DContext(this.viewCanvas, 'main');
    this.topCtx = this._createBoard2DContext(this.topCanvas, 'top');

    // Create selection overlay canvas with padding to allow handles to extend beyond board
    this.selectionOverlay = document.createElement('canvas');
    this.selectionOverlay.id = 'selectionOverlay';
    this.selectionOverlay.style.position = 'absolute';
    this.selectionOverlay.style.pointerEvents = 'none';
    this.boardsWrapper.appendChild(this.selectionOverlay);
    this.selectionCtx = this._createBoard2DContext(this.selectionOverlay, 'selection');

    // Screen-space overlay for selection handles. Unlike selectionOverlay (which
    // lives inside the zoom-scaled #boards wrapper and therefore gets upscaled and
    // pixelated), this canvas is a child of the untransformed container and is
    // rasterized at real device pixels every frame, so handles stay crisp and a
    // constant on-screen size at any zoom. Handle positions are converted from
    // board space to container space via boardToContainerPos().
    this.handleOverlay = document.createElement('canvas');
    this.handleOverlay.id = 'handleOverlay';
    this.handleOverlay.style.position = 'absolute';
    this.handleOverlay.style.top = '0';
    this.handleOverlay.style.left = '0';
    this.handleOverlay.style.pointerEvents = 'none';
    this.handleOverlay.style.zIndex = '6';
    this.container.appendChild(this.handleOverlay);
    this.handleCtx = this.handleOverlay.getContext('2d');
    this._handleOverlayCssW = 0;
    this._handleOverlayCssH = 0;
    this._handleOverlayDpr = 0;

    this.interactionBlockOverlay = document.createElement('canvas');
    this.interactionBlockOverlay.id = 'interactionBlockOverlay';
    this.interactionBlockOverlay.style.position = 'absolute';
    this.interactionBlockOverlay.style.top = '0';
    this.interactionBlockOverlay.style.left = '0';
    this.interactionBlockOverlay.style.pointerEvents = 'none';
    this.interactionBlockOverlay.style.zIndex = '4';
    this.boardsWrapper.appendChild(this.interactionBlockOverlay);
    this.interactionBlockCtx = this._createBoard2DContext(this.interactionBlockOverlay, 'interaction');

    this.upperLayersCanvas = document.createElement('canvas');
    this.upperLayersCanvas.id = 'upperLayersBoard';
    this.upperLayersCanvas.style.position = 'absolute';
    this.upperLayersCanvas.style.top = '0';
    this.upperLayersCanvas.style.left = '0';
    this.upperLayersCanvas.style.pointerEvents = 'none';
    this.upperLayersCanvas.style.zIndex = '2';
    this.boardsWrapper.appendChild(this.upperLayersCanvas);
    this.upperLayersCtx = this._createBoard2DContext(this.upperLayersCanvas, 'upper');

    this.pixelGridOverlay = document.createElement('div');
    this.pixelGridOverlay.id = 'pixelGridBoard';
    this.pixelGridOverlay.style.position = 'absolute';
    this.pixelGridOverlay.style.top = '0';
    this.pixelGridOverlay.style.left = '0';
    this.pixelGridOverlay.style.pointerEvents = 'none';
    this.pixelGridOverlay.style.zIndex = '250';
    this.pixelGridOverlay.style.display = 'none';
    this.pixelGridOverlay.style.backgroundRepeat = 'repeat';
    this.container.appendChild(this.pixelGridOverlay);

    this.obscureLayer = document.createElement('div');
    this.obscureLayer.id = 'obscureLayer';
    this.obscureLayer.style.position = 'absolute';
    this.obscureLayer.style.top = '0';
    this.obscureLayer.style.left = '0';
    this.obscureLayer.style.width = `${this.getWidth()}px`;
    this.obscureLayer.style.height = `${this.getHeight()}px`;
    this.obscureLayer.style.pointerEvents = 'none';
    this.obscureLayer.style.zIndex = '5';
    this.boardsWrapper.appendChild(this.obscureLayer);

    this.mirrorRegionsLayer = document.createElement('canvas');
    this.mirrorRegionsLayer.id = 'mirrorRegionsLayer';
    this.mirrorRegionsLayer.style.position = 'absolute';
    this.mirrorRegionsLayer.style.top = '0';
    this.mirrorRegionsLayer.style.left = '0';
    this.mirrorRegionsLayer.style.pointerEvents = 'none';
    this.mirrorRegionsLayer.style.zIndex = '3';
    this.boardsWrapper.appendChild(this.mirrorRegionsLayer);

    this.mirrorRegionsCtx = this._createBoard2DContext(this.mirrorRegionsLayer, 'mirror');

    // Centre lines live on their own layer so they can fade independently of the
    // region borders — see mirrorGuideIdleMs.
    this.mirrorGuidesLayer = document.createElement('canvas');
    this.mirrorGuidesLayer.id = 'mirrorGuidesLayer';
    this.mirrorGuidesLayer.style.position = 'absolute';
    this.mirrorGuidesLayer.style.top = '0';
    this.mirrorGuidesLayer.style.left = '0';
    this.mirrorGuidesLayer.style.pointerEvents = 'none';
    this.mirrorGuidesLayer.style.zIndex = '3';
    this.mirrorGuidesLayer.style.transition = 'opacity 260ms ease';
    this.boardsWrapper.appendChild(this.mirrorGuidesLayer);

    this.mirrorGuidesCtx = this._createBoard2DContext(this.mirrorGuidesLayer, 'mirrorGuides');

    this.textOverlay = new TextOverlay(this);
    this.textOverlay.mount(this.boardsWrapper);

    this._boardContextsInitialized = true;
    this._logDesyncDiagnostics();

    this.setupCanvas();

    this._createLayerManager();

    const [height, width] = this.dimensions;
    this.compositeTileGrid = new CompositeTileGrid(width, height, 32);
    this.tileTracker = new TileTracker(width, height);

    this.calculateDefaultView();
    this.resetView();

    // Seed the baseline container size so the first resize has something to
    // preserve the view against.
    if (this.container) {
      this._lastContainerWidth = this.container.clientWidth;
      this._lastContainerHeight = this.container.clientHeight;
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._invalidateContainerRect, { passive: true });
      window.addEventListener('scroll', this._invalidateContainerRect, { passive: true, capture: true });
    }
    if (typeof ResizeObserver !== 'undefined' && this.container) {
      // Invalidate the cached rect and keep the board's view stable across any
      // container size change (window resize, sidebar collapse, panel docking).
      this._containerResizeObserver = new ResizeObserver(() => {
        this._invalidateContainerRect();
        this.preserveViewOnResize();
        // preserveViewOnResize only calls applyTransform when the pan actually
        // moved; the window is sized from the container, so it has to be
        // reconsidered on every container resize regardless.
        this._syncSurfaceWindow();
      });
      this._containerResizeObserver.observe(this.container);
    }
  }

  _createLayerManager(previousLayerManager = null) {
    const [height, width] = this.dimensions;
    const layerManager = new LayerManager(width, height);
    layerManager.board = this;
    layerManager.onNeedsUpdate = () => this.requestUpdate();
    layerManager.onGlitchBlurReady = (result) => this._handleGlitchBlurReady(result);
    layerManager.localUserId = this.app?.self?.id ?? null;

    if (previousLayerManager?.layerGroups?.length === layerManager.layerGroups.length) {
      for (let i = 0; i < layerManager.layerGroups.length; i++) {
        layerManager.layerGroups[i].visible = previousLayerManager.layerGroups[i].visible;
        layerManager.layerGroups[i].allowComplexBlendModes = previousLayerManager.layerGroups[i].allowComplexBlendModes;
        layerManager.layerGroups[i].name = previousLayerManager.layerGroups[i].name;
      }
    }

    // Carry the room's tiled backing-store setting across the swap. resizeBoard
    // throws the whole LayerManager away and nothing re-applies the room
    // setting afterwards (applyRoomTiledCanvas only runs on connect and on a
    // ROOM_UPDATE that carries the field), so without this a board-size change
    // — or any room update that reasserts the current size — silently drops
    // tiling for the rest of the session. Falls back to the outgoing manager
    // because resizeBoard calls this with no explicit previous.
    const prior = previousLayerManager || this.layerManager;
    if (prior?.tiledBackingStore) layerManager.setTiledBackingStore(true);

    this.layerManager = layerManager;
    return layerManager;
  }

  /**
   * Set up canvas dimensions and initial context states
   */
  setupCanvas() {
    const [height, width] = this.dimensions;

    this.boardsWrapper.style.height = `${height}px`;
    this.boardsWrapper.style.width = `${width}px`;

    // viewCanvas, topCanvas and upperLayersCanvas are sized by the surface
    // window at the end of this method, not here — with windowedSurfaces off
    // that window is the whole board at 1:1, which is what these three
    // assignments used to do directly.
    if (typeof document !== 'undefined') {
      // Collapse rather than resize. These hold nothing but transient previews,
      // and a resize invalidates those anyway — so re-allocating every board at
      // the new size here would immediately hand back the memory that
      // userLayerPresence exists to reclaim, and would do it for boards whose
      // user may never draw again. The next `setUserLayerContent(user, true)`
      // inflates the ones that are actually used, at the new dimensions.
      document.querySelectorAll('#userBoards .userBoard').forEach((canvas) => {
        canvas.height = 1;
        canvas.width = 1;
      });
    }
    this.compositeTileGrid?.resize(width, height);
    // Both overlays are sized on demand — see _sizeOverlayCanvas. A resize
    // invalidates whatever they held, so start them collapsed and let the next
    // draw inflate them at the new dimensions.
    this._selectionOverlayUsed = false;
    this._sizeOverlayCanvas(this.selectionOverlay, this.selectionOverlayPadding, false);
    this._sizeOverlayCanvas(this.interactionBlockOverlay, this.interactionBlockOverlayPadding,
      this.interactionBlocks?.length > 0);
    if (this.obscureLayer) {
      this.obscureLayer.style.width = `${width}px`;
      this.obscureLayer.style.height = `${height}px`;
    }

    if (this.mirrorLine) {
      this.mirrorLine.setAttribute('x1', width / 2);
      this.mirrorLine.setAttribute('y1', 0);
      this.mirrorLine.setAttribute('x2', width / 2);
      this.mirrorLine.setAttribute('y2', height);
      this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
    }

    if (this.textOverlay) {
      this.textOverlay.resize(width, height);
    }

    this.boardsWrapper.style.transformOrigin = 'top left';
    // Forced: the board's dimensions just changed, so even an unchanged window
    // description now means different pixels. This also (re)applies the context
    // state the assignments above used to set inline.
    this._syncSurfaceWindow({ force: true });
    // The mirror layers are sized and positioned from their own content by
    // renderMirrorRegions below, which re-clamps to the new board dimensions.
    this.renderInteractionBlocks();
    this.renderMirrorRegions();
    this.renderPixelGrid();
    this.updateHighZoomRenderingMode();
  }

  /**
   * Calculate default zoom and pan to fit the board in the container
   */
  calculateDefaultView() {
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;
    const [height, width] = this.dimensions;

    const padding = 20;
    const availableWidth = containerWidth - padding * 2;
    const availableHeight = containerHeight - padding * 2;

    const zoomX = availableWidth / width;
    const zoomY = availableHeight / height;
    const zoom = Math.min(zoomX, zoomY, 1);

    const scaledWidth = width * zoom;
    const scaledHeight = height * zoom;
    const panX = (containerWidth - scaledWidth) / 2;
    const panY = (containerHeight - scaledHeight) / 2;

    this.defaultZoom = Math.round(zoom * 1000) / 1000;
    this.defaultPanX = panX;
    this.defaultPanY = panY;
  }

  /**
   * Reset the viewport to default zoom, pan, and rotation
   */
  resetView() {
    this.calculateDefaultView();
    this.zoom = this.defaultZoom;
    this.panX = this.defaultPanX;
    this.panY = this.defaultPanY;
    this.rotation = this.defaultRotation;

    this.applyTransform();
  }

  /**
   * The board-space axis-aligned box the user can currently see, padded, or
   * null when the whole board is visible.
   *
   * Derived from the cached container rect rather than measured — see
   * board_bounds_derived_not_measured; calling getBoundingClientRect here would
   * put a forced layout on the composite path, which is the exact regression
   * that memory records fixing.
   *
   * The four container corners are mapped through the inverse of the wrapper
   * transform (the same inverse `getBoardRelativePos` uses) and the AABB of the
   * results is taken, so rotation is handled correctly — a rotated viewport
   * simply yields a larger box, never a wrong one.
   *
   * @param {number} [padPx=VIEW_CULL_PAD_PX] - Screen-space padding, so a small
   *   pan does not immediately expose unpainted board.
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  getVisibleBoardRect(padPx = VIEW_CULL_PAD_PX) {
    const rect = this._getContainerRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    if (!(this.zoom > 0)) return null;

    const rad = -this.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const boardWidth = this.getWidth();
    const boardHeight = this.getHeight();

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [cx, cy] of [[0, 0], [rect.width, 0], [0, rect.height], [rect.width, rect.height]]) {
      const bx = cx - this.panX;
      const by = cy - this.panY;
      let x = (bx * cos - by * sin) / this.zoom;
      const y = (bx * sin + by * cos) / this.zoom;
      // canvasFlipped mirrors board X about the board's own width, exactly as
      // getBoardRelativePos does; without this the visible box would be the
      // mirror image of the real one and cull the half being looked at.
      if (this.canvasFlipped) x = boardWidth - x;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const pad = padPx / this.zoom;
    const x0 = Math.max(0, Math.floor(minX - pad));
    const y0 = Math.max(0, Math.floor(minY - pad));
    const x1 = Math.min(boardWidth, Math.ceil(maxX + pad));
    const y1 = Math.min(boardHeight, Math.ceil(maxY + pad));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /**
   * The cull box for this composite, or null to composite the whole board.
   *
   * Returns null unless culling is enabled AND the view actually hides enough
   * of the board to be worth it: below VIEW_CULL_MIN_HIDDEN the intersection
   * bookkeeping and the repair composites it forces cost more than the draws
   * they skip.
   * @private
   */
  _viewCullRect() {
    // Windowing already clips every rect to the window in
    // _prepareCompositeRects, exactly and unconditionally. Culling on top of
    // that would only add its repair obligation back — and its repair has
    // nowhere to write. The two are mutually exclusive by design; windowing is
    // the successor.
    if (this.windowedSurfaces) return null;
    if (!this.viewportCulling) return null;
    if (this._viewCullSuspensions > 0) return null;
    const view = this.getVisibleBoardRect();
    if (!view) return null;
    const boardArea = this.getWidth() * this.getHeight();
    if (boardArea <= 0) return null;
    if (view.width * view.height > boardArea * (1 - VIEW_CULL_MIN_HIDDEN)) return null;
    return view;
  }

  /**
   * Clip a set of composite dirty rects to the visible board region.
   *
   * viewCanvas and upperLayersCanvas are full-board canvases shown through a
   * CSS transform, so anything outside the viewport is painted and then never
   * looked at. Clipping the dirty rects skips that work for every layer at
   * once — tiles, stroke stack and baked sequences alike — rather than only for
   * the tile grid.
   *
   * The catch, and the reason `ensureFullComposite` exists: those canvases are
   * ALSO read as full-board sources (flood fill's getImageData, save/export,
   * toDataURL, BoardViewer, checkpoint capture). Skipping a region leaves stale
   * pixels there, so every such reader has to repair first. Culling is opt-in
   * for that reason.
   *
   * @param {Array|null} rects - null means "the whole board is dirty".
   * @returns {Array|null}
   * @private
   */
  _cullToView(rects) {
    // Before anything is clipped away: this is the one funnel every rect set
    // reaching viewCanvas passes through, so it is also the only place that
    // sees the UNCULLED truth about what changed. The proxy needs exactly that,
    // whether or not culling is on for this composite.
    this._noteProxyDirty(rects);

    const view = this._viewCullRect();
    if (!view) return rects;

    this._compositeStaleOutsideView = true;
    // The freshest region of viewCanvas. Anything outside it may be stale — see
    // ensureCompositeRegion. Only the latest is kept rather than a union of
    // views, which is conservative in the safe direction: applyTransform marks
    // the composite full on every view change, so the current view is always
    // genuinely fresh, and an older view's region is simply re-repaired if
    // something asks for it.
    this._lastCullView = view;
    if (!rects) return [view];

    const out = [];
    for (const r of rects) {
      const x = Math.max(r.x, view.x);
      const y = Math.max(r.y, view.y);
      const right = Math.min(r.x + r.width, view.x + view.width);
      const bottom = Math.min(r.y + r.height, view.y + view.height);
      if (right > x && bottom > y) out.push({ x, y, width: right - x, height: bottom - y });
    }
    // Never return an empty array: compositeLayerRange reads that as "no usable
    // dirty rects" and falls back to a full-board clear and redraw — the exact
    // opposite of what an entirely-offscreen dirty set should cost. A single
    // degenerate rect keeps the dirty-rect path and clips everything away.
    return out.length > 0 ? out : [{ x: 0, y: 0, width: 0, height: 0 }];
  }

  /**
   * Repaint the whole board into viewCanvas if culling has left it stale
   * outside the viewport. Call before ANY full-board read of viewCanvas.
   *
   * A no-op when culling is off or nothing has been culled since the last
   * repair, so callers can invoke it unconditionally.
   */
  /**
   * Suspend viewport culling while a second view onto viewCanvas is live.
   *
   * A second view renders the whole board at its own zoom and pan, so the main
   * viewport's visible box no longer describes what is being looked at.
   * Repairing per frame would be worse than not culling — a culled composite
   * plus a full repair every frame — so culling switches off wholesale for as
   * long as the suspension is held.
   *
   * This is the fallback, not the normal path. BoardViewer serves itself from
   * `acquireDisplayProxy` instead and only suspends when it is zoomed in past
   * the detail the proxy carries, which is the one case a low-resolution mirror
   * genuinely cannot answer.
   *
   * Reference-counted: several viewers (panel + pop-out) can be open at once.
   * Suspending repairs immediately, so the second view never shows a stale
   * region even on its first frame.
   */
  suspendViewportCulling() {
    this._viewCullSuspensions = (this._viewCullSuspensions || 0) + 1;
    if (this._viewCullSuspensions === 1) this.ensureFullComposite();
  }

  /** Undo one `suspendViewportCulling`. */
  resumeViewportCulling() {
    this._viewCullSuspensions = Math.max(0, (this._viewCullSuspensions || 0) - 1);
  }

  /**
   * Repair only if `(x, y, width, height)` might be stale — i.e. it is not
   * wholly inside the region the last culled composite actually painted.
   *
   * For readers that sample a bounded region rather than the whole board (a
   * blur tool cropping around a stamp, say). The common case is a crop the user
   * is looking at, which is already fresh and costs nothing; a remote user's
   * stroke off-screen falls back to a full repair.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   */
  ensureCompositeRegion(x, y, width, height) {
    if (!this._compositeStaleOutsideView) return;
    const view = this._lastCullView;
    if (view &&
      x >= view.x && y >= view.y &&
      x + width <= view.x + view.width &&
      y + height <= view.y + view.height) {
      return;
    }
    this.ensureFullComposite();
  }

  ensureFullComposite() {
    // Meaningless once the surfaces are windowed: they physically cannot hold
    // the whole board, so "repair the off-screen region" has nowhere to put the
    // result. Every reader that used to depend on this now goes through
    // getFullRaster, which composites from the layer stack instead.
    if (this.windowedSurfaces) return;
    if (!this._compositeStaleOutsideView) return;
    this._compositeStaleOutsideView = false;

    const saved = this.viewportCulling;
    this.viewportCulling = false;
    try {
      this.markCompositeFull();
      this.layerManager && (this.layerManager.needsComposite = true);
      this.compositeAllLayers();
    } finally {
      this.viewportCulling = saved;
    }
  }

  /**
   * Claim the display proxy — a full-board mirror at DISPLAY_PROXY_MAX_DIM.
   *
   * For second views that want the WHOLE board rather than the main viewport's
   * slice of it. Reading viewCanvas for that forces culling off entirely, which
   * costs a full-board composite every frame the second view is live; the proxy
   * costs one bounded, board-size-independent composite per frame that actually
   * changed something, and leaves the main viewport free to keep culling.
   *
   * Reference-counted, and allocated lazily: with no consumers there is no
   * canvas, no dirty tracking and no per-composite work. Balance with
   * `releaseDisplayProxy`.
   *
   * @returns {{ canvas: HTMLCanvasElement, scale: number }|null}
   */
  acquireDisplayProxy() {
    this._proxyConsumers++;
    if (this._proxyConsumers === 1) {
      this._proxyNeedsFull = true;
      this._proxyDirtyRects = null;
      // Paint it now rather than waiting for the next composite, so the first
      // frame of the second view is never blank.
      this._updateDisplayProxy();
    }
    return this.getDisplayProxy();
  }

  /** Undo one `acquireDisplayProxy`; frees the canvas at zero consumers. */
  releaseDisplayProxy() {
    this._proxyConsumers = Math.max(0, this._proxyConsumers - 1);
    if (this._proxyConsumers > 0) return;
    this._proxyCanvas = null;
    this._proxyCtx = null;
    this._proxyDirtyRects = null;
    this._proxyNeedsFull = true;
  }

  /**
   * The proxy, or null when nothing holds one. `scale` is proxy pixels per
   * board pixel — a consumer drawing at a higher effective scale than this is
   * asking for detail the proxy does not carry and should read the real
   * surfaces instead.
   *
   * @returns {{ canvas: HTMLCanvasElement, scale: number }|null}
   */
  getDisplayProxy() {
    if (this._proxyConsumers === 0 || !this._proxyCanvas) return null;
    return { canvas: this._proxyCanvas, scale: this._proxyScale };
  }

  /**
   * Record what changed, in board coordinates, for the next proxy update.
   * `null` means the whole board. Free when nothing holds the proxy.
   * @private
   */
  _noteProxyDirty(rects) {
    if (this._proxyConsumers === 0 || this._proxyNeedsFull) return;
    if (!rects) {
      this._proxyNeedsFull = true;
      this._proxyDirtyRects = null;
      return;
    }
    (this._proxyDirtyRects ??= []).push(...rects);
  }

  /**
   * (Re)allocate the proxy canvas if the board's dimensions call for it.
   * @returns {boolean} whether a usable canvas exists
   * @private
   */
  _ensureProxyCanvas() {
    const boardW = this.getWidth();
    const boardH = this.getHeight();
    if (!(boardW > 0) || !(boardH > 0)) return false;

    const scale = Math.min(1, DISPLAY_PROXY_MAX_DIM / Math.max(boardW, boardH));
    if (scale > DISPLAY_PROXY_MIN_REDUCTION) return false;

    const w = Math.max(1, Math.round(boardW * scale));
    const h = Math.max(1, Math.round(boardH * scale));
    if (this._proxyCanvas && this._proxyCanvas.width === w && this._proxyCanvas.height === h) return true;

    this._proxyCanvas = document.createElement('canvas');
    this._proxyCanvas.width = w;
    this._proxyCanvas.height = h;
    this._proxyCtx = this._proxyCanvas.getContext('2d');
    this._proxyScale = w / boardW;
    // A fresh canvas holds nothing, so any accumulated rects are meaningless.
    this._proxyNeedsFull = true;
    this._proxyDirtyRects = null;
    return true;
  }

  /**
   * Bring the proxy up to date from the rects gathered since the last update.
   *
   * Composited straight from the layer stack rather than downscaled from
   * viewCanvas: viewCanvas is the surface that may be culled, so it is exactly
   * the wrong source for the thing whose job is to be correct everywhere.
   *
   * Always the FULL layer range, ignoring the split that `compositeAllLayers`
   * applies for live previews — the proxy is a flattened board, and consumers
   * draw the live preview surfaces over it themselves. The visible consequence
   * is narrow: while a stroke is in progress AND there is renderable content on
   * layers above it, a second view shows that preview over those upper layers
   * rather than under them.
   *
   * @private
   */
  _updateDisplayProxy() {
    if (this._proxyConsumers === 0 || !this.layerManager) return;
    if (!this._ensureProxyCanvas()) return;

    const full = this._proxyNeedsFull;
    const rects = full ? null : this._proxyDirtyRects;
    if (!full && (!rects || rects.length === 0)) return;

    this._proxyDirtyRects = null;
    this._proxyNeedsFull = false;

    const ctx = this._proxyCtx;
    // compositeLayerRange clears layerManager.needsComposite as a side effect.
    // Harmless at the end of a composite, which clears it anyway — but
    // acquireDisplayProxy calls this outside one, where swallowing a pending
    // recomposite would leave viewCanvas stale until something else dirtied it.
    const pendingComposite = this.layerManager.needsComposite;
    // Board coordinates in, proxy pixels out: compositeLayerRange clears, fills
    // and clips in board space, and its internal save/restore preserves this.
    ctx.setTransform(this._proxyScale, 0, 0, this._proxyScale, 0, 0);
    try {
      this.layerManager.compositeLayerRange(
        ctx,
        0,
        this.layerManager.getLayerCount(),
        this.getCompositeBackgroundColor(),
        rects
      );
    } finally {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.layerManager.needsComposite = pendingComposite;
    }
  }

  /**
   * Round a raw scale to the nearest half-power of two.
   *
   * Zoom is continuous enough (and `_getNextZoomStep` fine enough) that an
   * unquantised scale would re-allocate every surface on every notch. Half
   * powers of two put at most a 2^0.25 = 1.19x resample between what the screen
   * shows and what the store holds, which is invisible on a painting surface,
   * and reduce the re-allocations across the whole 0.2..10 zoom range to a
   * handful.
   * @private
   */
  static _quantiseSurfaceScale(raw) {
    if (!(raw > 0)) return 1;
    if (raw >= 1) return 1;
    const stepped = Math.pow(2, Math.round(Math.log2(raw) * 2) / 2);
    return Math.min(1, Math.max(SURFACE_MIN_SCALE, stepped));
  }

  /**
   * The window the display surfaces should currently cover.
   *
   * With `windowedSurfaces` off this is always the whole board at scale 1 —
   * byte-for-byte the pre-window behaviour, and the state the kill switch
   * returns to.
   *
   * With it on, the window tracks the padded visible box and the scale tracks
   * `zoom x dpr`, which is what makes the backing store container-sized rather
   * than board-sized at EVERY zoom: the window grows as the zoom shrinks and
   * the two cancel. Note that fit-to-screen — the default view for a large
   * board, and the case a board-resolution window would not help at all —
   * lands on "the whole board, heavily downscaled", which is exactly right.
   * @private
   */
  _computeSurfaceWindow() {
    const boardW = this.getWidth();
    const boardH = this.getHeight();
    const full = { x: 0, y: 0, width: boardW, height: boardH, scale: 1 };
    if (!this.windowedSurfaces) return full;
    if (!(boardW > 0) || !(boardH > 0) || !(this.zoom > 0)) return full;

    const rawDpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const dpr = Math.min(rawDpr, SURFACE_MAX_DPR);
    const scale = Board._quantiseSurfaceScale(this.zoom * dpr);

    const view = this.getVisibleBoardRect(SURFACE_PAD_PX);
    if (!view) return full;

    // Both terms quantised, so the store takes one of a handful of sizes for a
    // given scale. The window is deliberately NOT clamped to the board: an
    // overhanging window costs a strip of unused (transparent) surface, whereas
    // clamping it would shrink the store as the view approached an edge — and a
    // store size change is a re-allocation, which is exactly what the
    // quantisation exists to avoid.
    const quantise = (n) => Math.ceil(n / SURFACE_STORE_STEP) * SURFACE_STORE_STEP;
    const storeW = Math.min(quantise(Math.ceil(boardW * scale)), quantise(Math.ceil(view.width * scale)));
    const storeH = Math.min(quantise(Math.ceil(boardH * scale)), quantise(Math.ceil(view.height * scale)));

    const width = storeW / scale;
    const height = storeH / scale;

    // Nothing to win — the window is the whole board at full resolution, so
    // take the cheaper identity path rather than a transform that does nothing.
    if (scale >= 1 && width >= boardW && height >= boardH) return full;

    // Snapped so the window origin lands on a whole device pixel; an origin at
    // a fraction of a device pixel would resample the whole surface every time
    // the window moved.
    const snap = (n, limit) => {
      const clamped = Math.min(Math.max(0, n), Math.max(0, limit));
      return Math.round(clamped * scale) / scale;
    };
    return {
      x: snap(view.x + view.width / 2 - width / 2, boardW - width),
      y: snap(view.y + view.height / 2 - height / 2, boardH - height),
      width,
      height,
      scale
    };
  }

  /**
   * Bring the surface window up to date with the current view.
   *
   * Deliberately lazy about MOVING: while the backing store is unchanged and
   * the existing window still covers what is on screen, this does nothing at
   * all, so a pan inside the window costs a CSS transform and no repaint —
   * which is the property the CSS-transform design had and a screen-space
   * design would have thrown away.
   *
   * @param {Object} [options]
   * @param {boolean} [options.force=false] - Re-apply even if nothing changed
   *   (after a resize, where the surfaces were re-created underneath us).
   * @returns {boolean} whether the surfaces were re-pointed
   * @private
   */
  _syncSurfaceWindow({ force = false } = {}) {
    if (!this._boardContextsInitialized) return false;
    const next = this._computeSurfaceWindow();
    const cur = getSurfaceWindow();
    const sameStore = cur.scale === next.scale &&
      cur.width === next.width &&
      cur.height === next.height;

    if (!force && sameStore) {
      const view = this.getVisibleBoardRect(0);
      if (!view || windowCovers(cur, view)) return false;
    }

    const changed = setSurfaceWindow(next);
    if (!changed && !force) return false;
    this._applySurfaceWindow();
    return true;
  }

  /**
   * Point every display surface at the current window and invalidate them.
   *
   * A window change makes everything on these surfaces stale — the composite
   * ones are rebuilt from the layer stack on the next composite, but the live
   * preview surfaces hold tool-owned state that only the tool can reproduce,
   * which is what onSurfaceWindowChange is for.
   * @private
   */
  _applySurfaceWindow() {
    const win = getSurfaceWindow();

    // Assigning width/height clears the canvas and resets the context to spec
    // defaults, so anything setupCanvas configured has to be re-applied.
    const viewRealloc = sizeWindowedSurface(this.viewCanvas, win);
    if (viewRealloc) this._configureViewContext();
    const topRealloc = sizeWindowedSurface(this.topCanvas, win);
    if (topRealloc) this._configureTopContext();
    const upperRealloc = this.upperLayersCanvas
      ? sizeWindowedSurface(this.upperLayersCanvas, win)
      : false;

    applyWindowTransform(this.viewCtx, win);
    applyWindowTransform(this.topCtx, win);
    if (this.upperLayersCtx) applyWindowTransform(this.upperLayersCtx, win);

    // A surface whose store was NOT re-allocated kept its pixels, and those
    // pixels describe the window's PREVIOUS origin — so they would be shown
    // shifted. Re-allocation clears as a side effect; a move has to be explicit.
    if (!viewRealloc) this._clearWindowedSurface(this.viewCtx, this.viewCanvas);
    if (!topRealloc) this._clearWindowedSurface(this.topCtx, this.topCanvas);
    if (this.upperLayersCtx && !upperRealloc) {
      this._clearWindowedSurface(this.upperLayersCtx, this.upperLayersCanvas);
    }
    this._setLayerPresent(this.upperLayersCanvas, false);

    // The remote preview surfaces share the window — they blend against
    // viewCanvas and are drawn 1:1 alongside it, so they cannot be on a
    // different one. Only the inflated ones: a collapsed 1x1 canvas is
    // re-pointed by ensureUserLayerSized when its user next draws.
    if (typeof document !== 'undefined') {
      for (const canvas of document.querySelectorAll('#userBoards .userBoard')) {
        if (canvas.width <= 1 && canvas.height <= 1) continue;
        const ctx = canvas.getContext('2d');
        if (sizeWindowedSurface(canvas, win)) {
          if (ctx) {
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
          }
        } else if (ctx) {
          // Moved, not re-allocated: the pixels still there describe the OLD
          // window origin, so they would be drawn in the wrong place.
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        if (ctx) applyWindowTransform(ctx, win);
      }
    }

    // Everything the split-composite bookkeeping remembers described the old
    // window, so none of it is a valid basis for a dirty-rect composite now.
    this._upperLayersCompositeStart = null;
    this._upperLayersCompositeEnd = null;
    this._mainCompositeEnd = null;
    this.markCompositeFull();
    if (this.layerManager) this.layerManager.needsComposite = true;

    // Forced: a re-allocated backing store comes back with smoothing at the
    // spec default, and updateHighZoomRenderingMode short-circuits when its
    // cached state is unchanged — which it is.
    this._lastHighZoomCrisp = null;
    this.updateHighZoomRenderingMode();
    this.onSurfaceWindowChange?.(win);
    this.requestUpdate?.();
  }

  /**
   * Wipe a windowed surface in its own device pixels, leaving the window
   * transform in place for whatever draws next.
   * @private
   */
  _clearWindowedSurface(ctx, canvas) {
    if (!ctx || !canvas) return;
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } finally {
      ctx.restore();
    }
  }

  /** Context state setupCanvas gives viewCtx, re-applied after a re-allocation. */
  _configureViewContext() {
    if (!this.viewCtx) return;
    this.viewCtx.globalCompositeOperation = 'source-over';
    this.viewCtx.imageSmoothingQuality = 'high';
    this.viewCtx.lineCap = 'round';
    this.viewCtx.lineJoin = 'round';
  }

  /** Context state setupCanvas gives topCtx, re-applied after a re-allocation. */
  _configureTopContext() {
    if (!this.topCtx) return;
    this.topCtx.imageSmoothingQuality = 'high';
    this.topCtx.lineCap = 'round';
    this.topCtx.lineJoin = 'round';
  }

  /**
   * Apply current pan, zoom, and rotation to the board's DOM wrapper
   */
  applyTransform() {
    // The window is derived from the view, so it has to be reconsidered before
    // anything else here — and it is cheap when the view has not left it, which
    // is the common case for a small pan.
    this._syncSurfaceWindow();
    // The viewport moved, so a culled composite's untouched region may now be
    // on screen. Every pan/zoom/rotate/flip lands here, which makes this the
    // one place that has to invalidate — miss it and the user pans into stale
    // or blank board. Marking full is cheap next to being wrong; the repair is
    // one composite, and only when culling is actually on.
    if (this.viewportCulling) {
      this.markCompositeFull();
      if (this.layerManager) this.layerManager.needsComposite = true;
      this.requestUpdate?.();
    }
    this.boardsWrapper.style.transformOrigin = '0 0';
    const flipTransform = this.canvasFlipped
      ? ` translate(${this.getWidth()}px, 0) scaleX(-1)`
      : '';
    this.boardsWrapper.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom}) rotate(${this.rotation}deg)${flipTransform}`;
    this.boardsWrapper.style.left = '';
    this.boardsWrapper.style.top = '';

    // Counter-flip #floatingArtMount so the floating art gallery stays upright
    // while the board's drawing layers mirror horizontally.
    const floatingArtMount = document.getElementById('floatingArtMount');
    if (floatingArtMount) {
      floatingArtMount.style.transformOrigin = '0 0';
      floatingArtMount.style.transform = this.canvasFlipped
        ? `translate(${this.getWidth()}px, 0) scaleX(-1)`
        : '';
    }
    this.renderPixelGrid();
    this.updateHighZoomRenderingMode();
  }

  canRevealObscureRegions() {
    return !this.app?.currentRoomData?.obscureRequiresRegistered || (this.app?.selfRole ?? 0) >= 1;
  }

  canManageObscureRegions() {
    const roomRole = this.app?.selfRoomRole ?? 0;
    const globalRole = this.app?.selfGlobalRole ?? 0;
    const role = Math.max(this.app?.selfRole ?? 0, roomRole, globalRole);
    return role >= 2;
  }

  addObscureRegion(region) {
    if (region?.remove && region.id) {
      this.removeObscureRegion(region.id);
      return;
    }
    if (!this.obscureLayer || !region?.id) return;
    const rawX = Number(region.x);
    const rawY = Number(region.y);
    const rawWidth = Number(region.width);
    const rawHeight = Number(region.height);
    if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite) || rawWidth <= 0 || rawHeight <= 0) return;

    const boardWidth = this.getWidth();
    const boardHeight = this.getHeight();
    const x = Math.max(0, Math.min(boardWidth, rawX));
    const y = Math.max(0, Math.min(boardHeight, rawY));
    const right = Math.max(0, Math.min(boardWidth, rawX + rawWidth));
    const bottom = Math.max(0, Math.min(boardHeight, rawY + rawHeight));
    const width = right - x;
    const height = bottom - y;
    if (width <= 0 || height <= 0) return;

    const existing = this.obscureRegions.get(region.id);
    if (existing?.element) existing.element.remove();

    const el = document.createElement('div');
    el.className = 'obscureRegion';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.pointerEvents = 'auto';
    const surface = document.createElement('div');
    surface.className = 'obscureRegionSurface';
    el.appendChild(surface);

    let lassoClipPoints = null;
    const lassoPath = Array.isArray(region.lassoPath) && region.lassoPath.length >= 3
      ? region.lassoPath
        .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      : null;
    if (lassoPath?.length >= 3) {
      lassoClipPoints = lassoPath
        .map((point) => {
          const px = ((Number(point.x) - x) / width) * 100;
          const py = ((Number(point.y) - y) / height) * 100;
          return {
            x: Math.max(0, Math.min(100, px)),
            y: Math.max(0, Math.min(100, py))
          };
        });
      surface.style.clipPath = `polygon(${lassoClipPoints.map((point) => `${point.x}% ${point.y}%`).join(', ')})`;
    }

    const veil = document.createElement('div');
    veil.className = 'obscureRegionVeil';
    surface.appendChild(veil);

    const outline = document.createElement('canvas');
    outline.className = 'obscureRegionOutline';
    const outlinePad = 2;
    outline.width = Math.max(1, Math.ceil(width + outlinePad * 2));
    outline.height = Math.max(1, Math.ceil(height + outlinePad * 2));
    outline.style.left = `${-outlinePad}px`;
    outline.style.top = `${-outlinePad}px`;
    outline.style.width = `${width + outlinePad * 2}px`;
    outline.style.height = `${height + outlinePad * 2}px`;
    el.appendChild(outline);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'obscureRegionButton';
    const updateButton = () => {
      const canReveal = this.canRevealObscureRegions();
      button.textContent = canReveal ? 'Show' : 'Registered only';
      button.disabled = !canReveal;
      button.title = canReveal ? 'Reveal this obscured region' : 'Only registered users can reveal obscured regions in this room';
    };
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!this.canRevealObscureRegions()) {
        this.app?.ui?.showToast?.('Only registered users can reveal obscured regions in this room', 3000);
        updateButton();
        return;
      }
      this.revealObscureRegion(region.id);
    });
    el.appendChild(button);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'obscureRegionClose';
    closeButton.textContent = 'X';
    closeButton.title = 'Remove obscured region';
    closeButton.style.pointerEvents = 'auto';
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!this.canManageObscureRegions()) return;
      this.removeObscureRegion(region.id);
      this.app?.inputBufferManager?.queueBroadcast(
        () => this.app?.wsClient?.broadcastObscureRegion({ id: region.id, remove: true }),
        { snapshot: false }
      );
    });
    el.appendChild(closeButton);

    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'obscureRegionHide';
    hideButton.textContent = 'Hide';
    hideButton.title = 'Hide this region again';
    hideButton.style.display = 'none';
    hideButton.style.pointerEvents = 'auto';
    hideButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.hideObscureRegion(region.id);
    });
    el.appendChild(hideButton);

    this.obscureLayer.appendChild(el);
    this.obscureRegions.set(region.id, { ...region, x, y, width, height, lassoPath, outlinePad, element: el, outline, button, closeButton, hideButton });
    this.drawObscureRegionOutline(region.id);
    updateButton();
    this.refreshObscureRegionAccess();
  }

  revealObscureRegion(id) {
    const entry = this.obscureRegions.get(id);
    if (!entry) return;
    entry.revealed = true;
    entry.element?.classList.add('obscureRegion-revealed');
    if (entry.element) entry.element.style.pointerEvents = 'none';
    if (entry.button) entry.button.style.display = 'none';
    if (entry.closeButton) entry.closeButton.style.pointerEvents = 'auto';
    if (entry.hideButton) entry.hideButton.style.display = '';
    if (entry.hideButton) entry.hideButton.style.pointerEvents = 'auto';
  }

  hideObscureRegion(id) {
    const entry = this.obscureRegions.get(id);
    if (!entry) return;
    entry.revealed = false;
    entry.element?.classList.remove('obscureRegion-revealed');
    if (entry.element) entry.element.style.pointerEvents = 'auto';
    if (entry.button) entry.button.style.display = '';
    if (entry.hideButton) entry.hideButton.style.display = 'none';
    this.refreshObscureRegionAccess();
  }

  removeObscureRegion(id) {
    const entry = this.obscureRegions.get(id);
    if (entry?.element) entry.element.remove();
    this.obscureRegions.delete(id);
  }

  drawObscureRegionOutline(id) {
    const entry = this.obscureRegions.get(id);
    const canvas = entry?.outline;
    const ctx = canvas?.getContext?.('2d');
    if (!entry || !canvas || !ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    const drawPath = () => {
      ctx.beginPath();
      if (entry.lassoPath?.length >= 3) {
        ctx.moveTo(entry.lassoPath[0].x - entry.x + entry.outlinePad, entry.lassoPath[0].y - entry.y + entry.outlinePad);
        for (let i = 1; i < entry.lassoPath.length; i++) {
          ctx.lineTo(entry.lassoPath[i].x - entry.x + entry.outlinePad, entry.lassoPath[i].y - entry.y + entry.outlinePad);
        }
        ctx.closePath();
      } else {
        ctx.rect(
          entry.outlinePad + 0.5,
          entry.outlinePad + 0.5,
          Math.max(0, entry.width - 1),
          Math.max(0, entry.height - 1)
        );
      }
    };

    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = 0;
    drawPath();
    ctx.stroke();

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = 4;
    drawPath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  refreshObscureRegionAccess() {
    for (const entry of this.obscureRegions.values()) {
      const button = entry.button;
      const el = entry.element;
      if (!button || !el) continue;
      if (entry.closeButton) {
        entry.closeButton.style.display = this.canManageObscureRegions() ? '' : 'none';
      }
      const canReveal = this.canRevealObscureRegions();
      button.textContent = canReveal ? 'Show' : 'Registered only';
      button.disabled = !canReveal;
      button.title = canReveal ? 'Reveal this obscured region' : 'Only registered users can reveal obscured regions in this room';
    }
  }

  /**
   * Transforms screen (client) coordinates to board-space coordinates.
   * Accounts for zoom, pan, and rotation.
   * @param {number} clientX - Screen X coordinate
   * @param {number} clientY - Screen Y coordinate
   * @returns {{x: number, y: number}} - Board-relative coordinates
   */
  getBoardRelativePos(clientX, clientY) {
    // Cached to avoid forced style recalc on every pointermove. The container
    // element's screen rect is unaffected by zoom/pan/rotate (those transform
    // boardsWrapper inside it), so it only needs invalidating on layout
    // changes — wired up in init() via resize/scroll listeners + ResizeObserver.
    const containerRect = this._getContainerRect();
    let bx = clientX - containerRect.left;
    let by = clientY - containerRect.top;


    bx -= this.panX;
    by -= this.panY;


    const rad = -this.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = bx * cos - by * sin;
    const ry = bx * sin + by * cos;


    let boardX = rx / this.zoom;
    const boardY = ry / this.zoom;

    if (this.canvasFlipped) {
      boardX = this.getWidth() - boardX;
    }

    return {
      x: Math.round(boardX * 100) / 100,
      y: Math.round(boardY * 100) / 100
    };
  }

  /**
   * Toggle a local-only horizontal flip of the viewport, adjusting pan so the
   * point currently centered in the viewport stays centered after the flip
   * (mirroring happens around the board's own left edge otherwise, which
   * jumps the visible content whenever the view is panned or zoomed).
   * @returns {boolean} New flip state
   */
  toggleCanvasFlip() {
    const width = this.getWidth();
    const rad = this.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const pivotX = this.container.clientWidth / 2;
    const pivotY = this.container.clientHeight / 2;

    const dx = pivotX - this.panX;
    const dy = pivotY - this.panY;
    const fx = (dx * cos + dy * sin) / this.zoom;
    const fy = (-dx * sin + dy * cos) / this.zoom;

    // Toggling flip mirrors this point across the board's vertical centerline.
    const fx2 = width - fx;
    this.panX = pivotX - this.zoom * (fx2 * cos - fy * sin);
    this.panY = pivotY - this.zoom * (fx2 * sin + fy * cos);

    this.canvasFlipped = !this.canvasFlipped;
    this.applyTransform();
    return this.canvasFlipped;
  }

  /**
   * Set local-only horizontal flip of the viewport.
   * @param {boolean} enabled
   */
  setCanvasFlip(enabled) {
    this.canvasFlipped = !!enabled;
    this.applyTransform();
  }

  /**
   * Set board rotation
   * @param {number} angle - Rotation angle in degrees
   */
  setRotation(angle) {
    this.rotation = angle;
    this.applyTransform();
  }

  /**
   * Rotate to a new angle while keeping the given boardContainer-space pivot fixed on screen.
   * @param {number} newAngleDeg - New rotation in degrees
   * @param {number} pivotX - Pivot X in boardContainer coordinates
   * @param {number} pivotY - Pivot Y in boardContainer coordinates
   */
  setRotationAround(newAngleDeg, pivotX, pivotY) {
    const oldRad = this.rotation * Math.PI / 180;
    const newRad = newAngleDeg * Math.PI / 180;
    const { zoom } = this;

    const dx = pivotX - this.panX;
    const dy = pivotY - this.panY;
    const cosOld = Math.cos(oldRad);
    const sinOld = Math.sin(oldRad);
    const boardX = (dx * cosOld + dy * sinOld) / zoom;
    const boardY = (-dx * sinOld + dy * cosOld) / zoom;

    const cosNew = Math.cos(newRad);
    const sinNew = Math.sin(newRad);
    this.panX = pivotX - zoom * (boardX * cosNew - boardY * sinNew);
    this.panY = pivotY - zoom * (boardX * sinNew + boardY * cosNew);
    this.rotation = newAngleDeg;
    this.applyTransform();
  }

  /**
   * Reset rotation to default
   */
  resetRotation() {
    this.rotation = this.defaultRotation;
    this.applyTransform();
  }

  /**
   * Pan the viewport
   * @param {number} dx - Change in X
   * @param {number} dy - Change in Y
   */
  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.applyTransform();
  }

  /**
   * Set viewport zoom level
   * @param {number} zoom - Zoom level
   * @param {Object} [cursorPos=null] - Pivot point for zoom {x, y}
   * @returns {number} The applied zoom level
   */
  setZoom(zoom, cursorPos = null) {
    const oldZoom = this.zoom;
    this.zoom = this._clampZoom(zoom);

    if (cursorPos) {
      const screenX = cursorPos.x * oldZoom + this.panX;
      const screenY = cursorPos.y * oldZoom + this.panY;

      this.panX = screenX - (cursorPos.x * this.zoom);
      this.panY = screenY - (cursorPos.y * this.zoom);
    } else {
      const [height, width] = this.dimensions;
      const midX = width / 2;
      const midY = height / 2;
      
      const screenX = midX * oldZoom + this.panX;
      const screenY = midY * oldZoom + this.panY;

      this.panX = screenX - (midX * this.zoom);
      this.panY = screenY - (midY * this.zoom);
    }

    this.applyTransform();
    return this.zoom;
  }

  /**
   * Set viewport zoom level while keeping a boardContainer-space pivot fixed.
   * @param {number} newZoom - Target zoom level
   * @param {number} pivotX - Pivot X in boardContainer coordinates
   * @param {number} pivotY - Pivot Y in boardContainer coordinates
   */
  setZoomAround(newZoom, pivotX, pivotY) {
    const oldZoom = this.zoom;
    const rad = this.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    // Get pivot in board-space
    const dx = pivotX - this.panX;
    const dy = pivotY - this.panY;
    const boardX = (dx * cos + dy * sin) / oldZoom;
    const boardY = (-dx * sin + dy * cos) / oldZoom;

    // Apply new zoom
    this.zoom = this._clampZoom(newZoom);

    // Calculate new pan to keep pivot fixed
    this.panX = pivotX - this.zoom * (boardX * cos - boardY * sin);
    this.panY = pivotY - this.zoom * (boardX * sin + boardY * cos);

    this.applyTransform();
  }

  /**
   * Zoom in by a step
   * @param {number} [step=0.1] - Zoom step
   * @param {Object} [cursorPos=null] - Pivot point for zoom
   * @returns {number} The applied zoom level
   */
  zoomIn(step = 0.1, cursorPos = null) {
    return this.setZoom(this._getNextZoomStep('in', step), cursorPos);
  }

  /**
   * Zoom out by a step
   * @param {number} [step=0.1] - Zoom step
   * @param {Object} [cursorPos=null] - Pivot point for zoom
   * @returns {number} The applied zoom level
   */
  zoomOut(step = 0.1, cursorPos = null) {
    return this.setZoom(this._getNextZoomStep('out', step), cursorPos);
  }

  /**
   * Get zoom percentage string
   * @returns {string}
   */
  getZoomPercent() {
    return `${(this.zoom * 100).toFixed(1)}%`;
  }

  _clampZoom(zoom) {
    return Math.max(Board.MIN_ZOOM, Math.min(Board.MAX_ZOOM, zoom));
  }

  _getNextZoomStep(direction, requestedStep = 0.1) {
    const step = this.zoom >= Board.HIGH_ZOOM_THRESHOLD
      ? 0.25
      : requestedStep;
    const nextZoom = direction === 'out'
      ? this.zoom - step
      : this.zoom + step;
    const precision = step >= 0.25 ? 100 : 1000;
    return Math.round(nextZoom * precision) / precision;
  }

  shouldShowPixelGrid() {
    return this.zoom >= Board.HIGH_ZOOM_THRESHOLD && this.rotation === 0;
  }

  setShowRawPixelsAtHighZoom(enabled) {
    this.showRawPixelsAtHighZoom = !!enabled;
    this.updateHighZoomRenderingMode();
  }

  updateHighZoomRenderingMode() {
    const crisp = this.showRawPixelsAtHighZoom && this.zoom >= Board.HIGH_ZOOM_THRESHOLD;
    if (this._lastHighZoomCrisp === crisp) return;
    this._lastHighZoomCrisp = crisp;

    const imageRendering = crisp ? 'pixelated' : 'auto';
    const smoothingEnabled = !crisp;
    const smoothingQuality = crisp ? 'low' : 'high';
    const canvases = [
      this.viewCanvas,
      this.topCanvas,
      this.upperLayersCanvas,
      this.selectionOverlay,
      this.interactionBlockOverlay
    ].filter(Boolean);
    const contexts = [
      this.viewCtx,
      this.topCtx,
      this.upperLayersCtx,
      this.selectionCtx,
      this.interactionBlockCtx
    ].filter(Boolean);

    for (const canvas of canvases) {
      canvas.style.imageRendering = imageRendering;
    }

    for (const ctx of contexts) {
      ctx.imageSmoothingEnabled = smoothingEnabled;
      if ('imageSmoothingQuality' in ctx) {
        ctx.imageSmoothingQuality = smoothingQuality;
      }
    }
  }

  renderPixelGrid() {
    if (!this.pixelGridOverlay || !this.container) return;

    const visible = this.shouldShowPixelGrid();
    if (
      this._lastPixelGridVisible === visible &&
      this._lastPixelGridZoom === this.zoom &&
      this._lastPixelGridPanX === this.panX &&
      this._lastPixelGridPanY === this.panY
    ) {
      return;
    }
    this._lastPixelGridVisible = visible;
    this._lastPixelGridZoom = this.zoom;
    this._lastPixelGridPanX = this.panX;
    this._lastPixelGridPanY = this.panY;

    this.pixelGridOverlay.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const width = Math.round(this.getWidth() * this.zoom);
    const height = Math.round(this.getHeight() * this.zoom);
    const left = Math.round(this.panX);
    const top = Math.round(this.panY);
    const cellSize = this.zoom;

    this.pixelGridOverlay.style.left = `${left}px`;
    this.pixelGridOverlay.style.top = `${top}px`;
    this.pixelGridOverlay.style.width = `${width}px`;
    this.pixelGridOverlay.style.height = `${height}px`;
    this.pixelGridOverlay.style.backgroundSize = `${cellSize}px ${cellSize}px`;
    this.pixelGridOverlay.style.backgroundPosition = '0 0, 0 0';
    this.pixelGridOverlay.style.backgroundImage = [
      'linear-gradient(to right, rgba(150, 150, 150, 0.16) 1px, transparent 1px)',
      'linear-gradient(to bottom, rgba(150, 150, 150, 0.16) 1px, transparent 1px)'
    ].join(', ');
  }

  /**
   * Toggle vertical mirror line
   * @returns {boolean} New mirror state
   */
  toggleMirror() {
    this.setMirror(!this.mirror);
    return this.mirror;
  }

  /**
   * Set mirror state
   * @param {boolean} value - Mirror state
   */
  setMirror(value) {
    this.mirror = !!value;
    // Guarded: `.mirrorLine` lives in the app shell markup and is absent in
    // headless/replay boards, where setMirror is still called from SETTINGS.
    if (this.mirrorLine) this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
    this.renderMirrorRegions();
    // A toggle is itself activity — show the guides so the change is visible,
    // then let them fade on the normal idle timer.
    this.noteMirrorActivity();
  }

  /**
   * Records mirror-relevant activity, bringing the guides back and restarting the
   * idle fade. Called from the drawing paths (via `forEachMirrorRegion`) and from
   * local pointer movement, so guides are up exactly while a region is in use.
   * @param {Object|null} [target] - Same shape as `forEachMirrorRegion`'s target
   *   ({rect}, {point} or {points}). When given, activity that misses every
   *   active region is ignored so drawing elsewhere doesn't resurrect the guides.
   */
  noteMirrorActivity(target = null) {
    // Hot path: this runs on every local pointer move. Nothing to show or hide
    // when the room has no mirrors at all.
    if (!this.mirror && this.mirrorRegions.length === 0 && !this.mirrorGuidesPinned) return;
    if (target && !this._activityHitsAnyMirrorRegion(target)) return;
    this._setMirrorGuidesVisible(true);
    if (this._mirrorGuideIdleTimer) clearTimeout(this._mirrorGuideIdleTimer);
    if (this.mirrorGuidesPinned) return;
    this._mirrorGuideIdleTimer = setTimeout(() => {
      this._mirrorGuideIdleTimer = null;
      if (this.mirrorGuidesPinned) return;
      this._setMirrorGuidesVisible(false);
    }, this.mirrorGuideIdleMs);
  }

  /**
   * Keeps the mirror guides up regardless of idle time (region editor open).
   * @param {boolean} pinned
   */
  setMirrorGuidesPinned(pinned) {
    this.mirrorGuidesPinned = !!pinned;
    this.noteMirrorActivity();
  }

  _activityHitsAnyMirrorRegion(target) {
    const bounds = this._getMirrorTargetBounds(target);
    if (!bounds) return true;
    return this.getActiveMirrorRegions().some(region => this._rectIntersects(bounds, region));
  }

  _setMirrorGuidesVisible(visible) {
    if (this._mirrorGuidesVisible === visible) return;
    this._mirrorGuidesVisible = visible;
    // Centre lines only — the region borders on mirrorRegionsLayer stay put.
    // Display is applied separately: opacity alone leaves a full board-sized
    // layer in the compositor's blend tree, still costing its area per frame.
    if (this.mirrorGuidesLayer) {
      this._applyMirrorGuidesDisplay();
      this.mirrorGuidesLayer.style.opacity = visible ? '1' : '0';
    }
    // 0.6 is the mirror line's resting opacity in CSS; the inline value wins, so
    // restore that exact number rather than jumping the line to full strength.
    if (this.mirrorLine) this.mirrorLine.style.opacity = visible ? '0.6' : '0';
  }

  /**
   * Single owner of mirrorGuidesLayer's `display`, driven by two inputs:
   * whether renderMirrorRegions drew anything (_mirrorGuidesHasContent) and
   * whether the idle fade currently wants them shown (_mirrorGuidesVisible).
   *
   * Showing re-enters the tree and flushes layout before the caller sets
   * opacity, so the fade-in still animates from a display:none start. Hiding on
   * a fade waits out the transition; hiding because the content is gone is
   * immediate, since there is nothing left to fade.
   *
   * @returns {void}
   * @private
   */
  _applyMirrorGuidesDisplay() {
    const el = this.mirrorGuidesLayer;
    if (!el) return;

    if (this._mirrorGuidesHideTimer) {
      clearTimeout(this._mirrorGuidesHideTimer);
      this._mirrorGuidesHideTimer = null;
    }

    if (this._mirrorGuidesHasContent && this._mirrorGuidesVisible) {
      if (el.style.display === 'none') {
        el.style.display = '';
        // Force a style flush so the pending opacity write transitions rather
        // than landing in the same frame as the display change (which would
        // apply instantly).
        void el.offsetWidth;
      }
      return;
    }

    if (el.style.display === 'none') return;

    if (!this._mirrorGuidesHasContent) {
      el.style.display = 'none';
      return;
    }

    this._mirrorGuidesHideTimer = setTimeout(() => {
      this._mirrorGuidesHideTimer = null;
      if (this._mirrorGuidesHasContent && this._mirrorGuidesVisible) return;
      el.style.display = 'none';
    }, MIRROR_GUIDE_FADE_MS);
  }

  /**
   * Sets the shared mirror regions for the room.
   * @param {Array<Object>} regions
   */
  setMirrorRegions(regions = []) {
    this.mirrorRegions = Array.isArray(regions)
      ? regions
        .map(region => this._normalizeMirrorRegion(region))
        .filter(Boolean)
      : [];
    this.renderMirrorRegions();
    // A region appearing/moving/vanishing is worth seeing, so restart the fade.
    this.noteMirrorActivity();
    if (typeof this.onMirrorRegionsChange === 'function') {
      this.onMirrorRegionsChange(this.mirrorRegions);
    }
  }

  addInteractionBlock(region) {
    const normalized = this._normalizeInteractionBlock(region);
    if (!normalized) return null;
    this.interactionBlocks = [...this.interactionBlocks, normalized];
    this.renderInteractionBlocks();
    this._updateInteractionBlockAnimation();
    return normalized.id;
  }

  removeInteractionBlock(id) {
    if (!id) return;
    const nextBlocks = this.interactionBlocks.filter(block => block.id !== id);
    if (nextBlocks.length === this.interactionBlocks.length) return;
    this.interactionBlocks = nextBlocks;
    this.renderInteractionBlocks();
    this._updateInteractionBlockAnimation();
  }

  clearInteractionBlocks() {
    if (this.interactionBlocks.length === 0) return;
    this.interactionBlocks = [];
    this.renderInteractionBlocks();
    this._updateInteractionBlockAnimation();
  }

  hasInteractionBlocks() {
    return this.interactionBlocks.length > 0;
  }

  isPointInInteractionBlock(point) {
    if (!point) return false;
    return this.interactionBlocks.some(block => this._pointInInteractionBlock(point, block));
  }

  segmentIntersectsInteractionBlock(start, end) {
    if (!start || !end) return false;
    return this.interactionBlocks.some(block => this._segmentIntersectsInteractionBlock(start, end, block));
  }

  /**
   * Gets active mirror regions, with full-board mirror taking precedence.
   * @returns {Array<Object>}
   */
  getActiveMirrorRegions() {
    return this.getActiveMirrorRegionsFor(this.mirror);
  }

  /**
   * Same as `getActiveMirrorRegions`, but for an explicitly supplied full-board
   * mirror state instead of the board's live one.
   *
   * Receivers of a mirrored operation need this: the full-board mirror is a
   * room setting toggled by T.MIR, which is neither a commit nor part of the
   * stroke log, so a joiner replaying a tail has not necessarily applied the
   * toggle that was in force when the operation was drawn. Those messages carry
   * the flag instead (see `broadcastSelectionDelete`), and it must win over
   * `this.mirror` here. Named mirror *regions* need no such flag — they travel
   * in SETTINGS and every mirror-aware tool already resolves them live.
   *
   * @param {boolean} mirrored - Full-board mirror state to resolve against.
   * @returns {Array<Object>}
   */
  getActiveMirrorRegionsFor(mirrored) {
    if (mirrored) {
      return this._expandMirrorRegionTransforms({
        id: '__global_mirror__',
        x: 0,
        y: 0,
        width: this.getWidth(),
        height: this.getHeight(),
        mode: 'vertical',
        showLine: true,
        synthetic: true
      });
    }
    return this.mirrorRegions.flatMap(region => this._expandMirrorRegionTransforms(region));
  }

  /**
   * Returns true when any mirror source is active.
   * @returns {boolean}
   */
  hasMirrors() {
    // Deliberately cheap — no region expansion. This is called from the tools'
    // per-tick getPreviewDirtyRect, and expanding a 16-slice radial region every
    // frame just to ask "is anything mirrored" is pure waste. The answer is the
    // same: _expandMirrorRegionTransforms never returns an empty list for a
    // valid region, so a non-empty mirrorRegions always means active mirrors.
    return this.mirror || this.mirrorRegions.length > 0;
  }

  /**
   * Computes the affine transform that reflects/rotates content into a mirror
   * region for the region's current mode, as a canvas matrix `[a, b, c, d, e, f]`
   * (point → `a*x + c*y + e`, `b*x + d*y + f`). Single source of truth shared by
   * `mirrorPointToRegion` (point math) and `withMirroredRegionTransform` (ctx
   * matrix), so the per-mode geometry can't drift between the two paths.
   * @param {Object} region
   * @returns {number[]|null} `[a, b, c, d, e, f]`, or null for an invalid region.
   */
  _mirrorRegionMatrix(region) {
    if (!region) return null;
    const centerX = region.x + (region.width / 2);
    const centerY = region.y + (region.height / 2);
    const transform = region.transform || region.mode || region.axis;

    // Linear part [la, lb, lc, ld] applied about pivot (px, py).
    let la, lb, lc, ld, px = centerX, py = centerY;

    if (transform === 'rotateCustom') {
      const angle = Number(region.rotationAngle || 0);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      la = cos; lb = sin; lc = -sin; ld = cos;
    } else if (transform === 'fibStep') {
      const invPHI = 0.6180339887;
      const step = region.fibStep || 1;
      const angle = step * (Math.PI / 2);       // 90° clockwise per step
      const scale = Math.pow(invPHI, step);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      la = scale * cos; lb = scale * sin; lc = -scale * sin; ld = scale * cos;
      // Pivot at the golden-spiral eye, not the region center.
      px = region.x + region.width * invPHI;
      py = region.y + region.height * invPHI;
    } else {
      switch (transform) {
        case 'horizontal':
        case 'flipY':     la = 1;  lb = 0;  lc = 0;  ld = -1; break;
        case 'flipXY':
        case 'rotate180': la = -1; lb = 0;  lc = 0;  ld = -1; break;
        case 'rotate90':  la = 0;  lb = 1;  lc = -1; ld = 0;  break;
        case 'rotate270': la = 0;  lb = -1; lc = 1;  ld = 0;  break;
        case 'vertical':
        case 'flipX':
        default:          la = -1; lb = 0;  lc = 0;  ld = 1;  break;
      }
    }

    const e = px - (la * px + lc * py);
    const f = py - (lb * px + ld * py);
    return [la, lb, lc, ld, e, f];
  }

  /**
   * Mirrors a single point inside a region.
   * @param {{x:number,y:number}} point
   * @param {Object} region
   * @returns {{x:number,y:number}}
   */
  mirrorPointToRegion(point, region) {
    if (!region || !point) return point;
    const m = this._mirrorRegionMatrix(region);
    if (!m) return point;
    const [a, b, c, d, e, f] = m;
    return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
  }

  /**
   * Mirrors an array of points inside a region.
   * @param {Array<{x:number,y:number}>} points
   * @param {Object} region
   * @returns {Array<{x:number,y:number}>}
   */
  mirrorPointsToRegion(points, region) {
    if (!Array.isArray(points)) return [];
    return points.map(point => this.mirrorPointToRegion(point, region));
  }

  /**
   * The extra places a selection-shaped operation must also paint because a
   * mirror is active — one entry per active mirror region the selection reaches.
   *
   * Callers paint the mirrored copy by running their normal, *untransformed*
   * drawing code inside `withMirroredRegionTransform(ctx, region, …)`; the
   * matrix and the region clip do the geometry. That is what lets this cover
   * every mode (quad, rotational, radial, fibonacci) instead of only the
   * vertical flip a rect-and-lasso pair can express — a rotated rectangle is
   * not a rectangle, so an earlier shape-returning version of this helper had
   * to skip regions entirely.
   *
   * `bounds` is the axis-aligned board area the mirrored paint can actually
   * cover (the transformed rect, clipped to the region). Callers need it for
   * dirty rects and tile bookkeeping — and crucially for `active.dirtyRect`,
   * since `commitUserStroke` CROPS the committed stroke to that rect and would
   * otherwise throw the mirrored pixels away.
   *
   * Shared by the local ops (SelectTool) and the remote ones
   * (RemoteSelectionHandler) so the two cannot drift. They did: only the local
   * side mirrored a selection fill, so the reflected half of every mirrored
   * fill existed on the drawer's screen alone.
   *
   * @param {{x:number,y:number,width:number,height:number}} rect - Area the
   *   operation paints, in board coordinates.
   * @param {boolean} [mirrored] - Full-board mirror state for THIS operation;
   *   see `getActiveMirrorRegionsFor` for why receivers must pass the flag off
   *   the wire rather than read `this.mirror`.
   * @returns {Array<{region: Object, bounds: {x:number,y:number,width:number,height:number}}>}
   */
  getSelectionMirrorTargets(rect, mirrored = this.mirror) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return [];
    const targets = [];
    for (const region of this.getActiveMirrorRegionsFor(mirrored)) {
      if (!this._rectIntersects(rect, region)) continue;
      const bounds = this.mirrorRectBounds(rect, region);
      if (bounds) targets.push({ region, bounds });
    }
    return targets;
  }

  /**
   * Axis-aligned board bounds that `rect` covers once reflected into `region`,
   * clipped to the region itself (mirrored drawing never escapes its region).
   * @param {{x:number,y:number,width:number,height:number}} rect
   * @param {Object} region
   * @returns {{x:number,y:number,width:number,height:number}|null} null when the
   *   reflection lands entirely outside the region.
   */
  mirrorRectBounds(rect, region) {
    if (!rect || !region) return null;
    const corners = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height }
    ];

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const corner of corners) {
      const p = this.mirrorPointToRegion(corner, region);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const x = Math.max(Math.floor(minX), Math.floor(region.x));
    const y = Math.max(Math.floor(minY), Math.floor(region.y));
    const right = Math.min(Math.ceil(maxX), Math.ceil(region.x + region.width));
    const bottom = Math.min(Math.ceil(maxY), Math.ceil(region.y + region.height));
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  }

  /**
   * Union of a rect with every mirrored counterpart it produces. Callers use it
   * to size a dirty rect that survives `commitUserStroke`'s crop.
   * @param {{x:number,y:number,width:number,height:number}} rect
   * @param {Array<{bounds: Object}>} targets - From `getSelectionMirrorTargets`.
   * @returns {{x:number,y:number,width:number,height:number}}
   */
  unionWithMirrorTargets(rect, targets) {
    let minX = rect.x;
    let minY = rect.y;
    let maxX = rect.x + rect.width;
    let maxY = rect.y + rect.height;
    for (const { bounds } of targets || []) {
      if (!bounds) continue;
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Clips drawing operations to a mirror region.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} region
   * @param {Function} drawFn
   */
  // ── Selection mask ──────────────────────────────────────────────────────────

  setSelectionMask(mask, userId = this.app?.self?.id ?? 0, showLocalOverlay = true) {
    const normalized = mask ? {
      x: mask.x, y: mask.y, width: mask.width, height: mask.height,
      lassoPath: mask.lassoPath ? [...mask.lassoPath] : null
    } : null;
    if (showLocalOverlay) {
      this.selectionMask = normalized;
    }
    if (normalized) {
      this.selectionMasksByUser.set(userId, normalized);
    } else {
      this.selectionMasksByUser.delete(userId);
    }
    this._updateMaskStopButton();
  }

  clearSelectionMask(userId = this.app?.self?.id ?? 0, clearLocalOverlay = true) {
    if (clearLocalOverlay) {
      this.selectionMask = null;
    }
    this.selectionMasksByUser.delete(userId);
    if (clearLocalOverlay) {
      this._maskManagedBySelectTool = false;
    }

    // Unwind every clip this user's mask still holds open, rather than just
    // forgetting about it. Dropping the ledger key alone (the old behaviour)
    // skipped the matching ctx.restore() — and stroke canvases come from
    // LayerManager's POOL, whose _acquireCanvas resets pixels, alpha and
    // composite op but historically not the clip region or the save stack. So
    // a mask turned off mid-stroke stranded a save()+clip() on a pooled canvas
    // permanently: whichever later stroke acquired that canvas was silently
    // clipped to a mask that no longer existed, and even clearRect could not
    // scrub it, because clearRect obeys the clip too.
    for (const key of [...this._maskClippedStrokes]) {
      const sep = key.lastIndexOf('_');
      if (sep < 0 || key.slice(sep + 1) !== String(userId)) continue;
      this.releaseSelectionMaskClipForStroke(Number(key.slice(0, sep)), userId);
      this._maskClippedStrokes.delete(key); // in case release bailed early
    }

    if (clearLocalOverlay) {
      this.clearTop();
    }
    this._updateMaskStopButton();
  }

  /**
   * Forget which stroke contexts are currently mask-clipped, without touching
   * the masks themselves.
   *
   * Call this whenever the layer state those contexts live on is thrown away
   * wholesale (LayerManager.clearAll, i.e. a resync or a board clear). The
   * ledger is keyed by `${layerIndex}_${userId}` and
   * applySelectionMaskClipForStroke treats a present key as "already clipped"
   * and returns early — so a key that outlives its canvas makes the very next
   * stroke by that user skip the clip entirely while the mask is still active.
   * That read as an intermittent "the first thing I draw after syncing ignores
   * the mask", because the stroke's own MU then released the stale key and the
   * next stroke behaved.
   * @returns {void}
   */
  resetSelectionMaskClipTracking() {
    this._maskClippedStrokes.clear();
  }

  _getSelectionMaskForUser(userId) {
    return this.selectionMasksByUser.get(userId) || null;
  }

  /**
   * Shows or hides the "Stop masking" button for the local mask.
   *
   * It lives here rather than in the Select tool's context menu because that
   * menu is gone by the time it is needed: turning the mask on and then picking
   * the brush deactivates Select and hides its menu, leaving the mask on with no
   * visible way to turn it off.
   *
   * Anchored just OUTSIDE the mask (above it, or below when the mask is near the
   * top edge) so it never covers the area being painted, and parented to
   * `boardsWrapper` in board coordinates so it tracks pan, zoom and rotation for
   * free — the same trick the mirror region controls use.
   * @private
   */
  _updateMaskStopButton() {
    const mask = this.selectionMask;

    if (!mask || !this._maskManagedBySelectTool) {
      if (this._maskStopButton) this._maskStopButton.style.display = 'none';
      return;
    }
    if (!this.boardsWrapper) return;

    if (!this._maskStopButton) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'stopMaskingBtn';
      btn.dataset.tut = 'stop-masking';
      btn.textContent = 'Stop masking';
      btn.style.cssText = [
        'position:absolute', 'z-index:6', 'pointer-events:auto',
        'height:24px', 'padding:0 10px', 'white-space:nowrap',
        'border:1px solid rgba(255,255,255,0.18)', 'border-radius:999px',
        'background:rgba(17,24,39,0.92)', 'color:#f8fafc',
        'font-size:11px', 'cursor:pointer',
        'box-shadow:0 4px 12px rgba(0,0,0,0.25)',
      ].join(';');
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
      btn.addEventListener('pointerup', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.onStopMasking?.();
      });
      this.boardsWrapper.appendChild(btn);
      this._maskStopButton = btn;
    }

    const btn = this._maskStopButton;
    btn.style.display = 'block';

    // Prefer above the mask; drop below when there is no room, so it stays on
    // the board and clear of the masked area either way.
    const GAP = 8;
    const H = 24;
    const above = mask.y - GAP - H;
    btn.style.top = `${above >= 0 ? above : mask.y + mask.height + GAP}px`;
    btn.style.left = `${Math.max(0, Math.round(mask.x))}px`;
  }

  /**
   * The mask's outline as a closed polygon in board coordinates.
   * @param {Object} mask
   * @returns {Array<{x:number,y:number}>}
   */
  static maskOutlinePoints(mask) {
    if (mask.lassoPath?.length > 0) return mask.lassoPath;
    return [
      { x: mask.x, y: mask.y },
      { x: mask.x + mask.width, y: mask.y },
      { x: mask.x + mask.width, y: mask.y + mask.height },
      { x: mask.x, y: mask.y + mask.height }
    ];
  }

  /**
   * Clips `ctx` to the user's selection mask — and to every mirror image of that
   * mask.
   *
   * The mirror images are the whole point. Mask mode clips the stroke context
   * ONCE at MD time, and the mirror-aware tools then draw their reflected copies
   * into that same already-clipped context. With only the mask itself in the
   * clip, every reflected copy landed outside it and was thrown away: drawing
   * inside a mask simply stopped mirroring. Reflecting the mask along with the
   * ink is what keeps "the mask is a region of the board" true on both sides of
   * a mirror.
   *
   * Region containment is NOT applied here. The tools already wrap each
   * reflected copy in `withMirrorRegionClip`, and clips intersect, so the
   * effective area stays `(mask ∪ mirrored masks) ∩ region`.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} [userId]
   * @param {Object} [board] - Mirror source; defaults to `this`. ReplayEngine
   *   passes its own board so replays clip exactly as the live client does.
   */
  _applyMaskClipToCtx(ctx, userId = this.app?.self?.id ?? 0, board = this) {
    const mask = this._getSelectionMaskForUser(userId);
    if (!mask || !ctx) return;
    Board.clipToMaskAndMirrors(ctx, mask, board);
  }

  /**
   * Shared implementation of the mask clip, so the live board and the replay
   * board cannot drift on what a mask means.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} mask
   * @param {Board} board - Supplies the active mirror regions.
   */
  static clipToMaskAndMirrors(ctx, mask, board) {
    const base = Board.maskOutlinePoints(mask);
    const shapes = [base];

    for (const region of (board?.getActiveMirrorRegions?.() || [])) {
      const m = board._mirrorRegionMatrix(region);
      if (!m) continue;
      const mirrored = board.mirrorPointsToRegion(base, region);
      // clip() uses the nonzero fill rule, under which two overlapping subpaths
      // of OPPOSITE winding cancel to a HOLE rather than uniting. A reflection
      // (negative determinant) reverses orientation, so re-reverse those points
      // — otherwise a mask straddling a mirror axis punched a hole in itself
      // exactly where it overlapped its own reflection.
      const flipsOrientation = (m[0] * m[3] - m[1] * m[2]) < 0;
      shapes.push(flipsOrientation ? mirrored.reverse() : mirrored);
    }

    ctx.beginPath();
    for (const points of shapes) {
      if (points.length < 3) continue;
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.closePath();
    }
    ctx.clip();
  }

  /**
   * NOTE for LayerManager active-stroke windowing (see
   * docs/scope_layermanager_active_stroke_windowing_RESULT.md): mask points
   * from `_applyMaskClipToCtx` are board-absolute, so a windowed active
   * canvas (canvas-local (0,0) != board (0,0)) needs the ctx translated by
   * `-origin` before `clip()` — see `_applyMaskClipAtOrigin`. `clip()` bakes
   * the resulting region into the ctx's CURRENT device/pixel space, so the
   * translate is undone again right after: every draw call site onto this
   * canvas (RemoteUserHandler's commitLine/handleMouseUp) applies its OWN
   * `-origin` translate independently around each draw, assuming the ctx
   * starts at identity transform — leaving the mask's translate in place
   * here would double it. The clip does NOT survive
   * `_growActiveStrokeWindow`'s canvas swap on its own (a fresh ctx starts
   * unclipped) — `_registerMaskClipReapply` hands LayerManager a hook that
   * redoes this against the NEW origin when the window grows.
   */
  applySelectionMaskClipForStroke(layerIndex, userId) {
    if (!this._getSelectionMaskForUser(userId) || !this.layerManager) return false;
    const key = `${layerIndex}_${userId}`;
    if (this._maskClippedStrokes.has(key)) return true;
    const ctx = this.layerManager.getUserStrokeContext(layerIndex, userId);
    if (!ctx) return false;
    const active = this.layerManager.getActiveStroke(layerIndex, userId);
    ctx.save();
    this._applyMaskClipAtOrigin(ctx, userId, active?.origin);
    this._maskClippedStrokes.add(key);
    this._registerMaskClipReapply(layerIndex, userId);
    return true;
  }

  /**
   * Clip `ctx` to this user's selection mask, translating by `-origin` first
   * (windowed active canvas) and resetting the transform back to identity
   * afterward so the baked clip region stays fixed in this canvas's own
   * pixel space regardless of what draws onto it next.
   * @private
   */
  _applyMaskClipAtOrigin(ctx, userId, origin) {
    const ox = origin?.x ?? 0;
    const oy = origin?.y ?? 0;
    if (ox || oy) ctx.translate(-ox, -oy);
    this._applyMaskClipToCtx(ctx, userId);
    if (ox || oy) ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Give the active stroke a hook LayerManager._growActiveStrokeWindow can
   * call after swapping in a new (unclipped) canvas, so a mask clip survives
   * a windowed stroke's canvas growing mid-drag. No-op for a full-board
   * active stroke (it never grows, so the hook is simply never invoked).
   * @private
   */
  _registerMaskClipReapply(layerIndex, userId) {
    const active = this.layerManager?.getActiveStroke?.(layerIndex, userId);
    if (!active) return;
    active._reapplyMaskClip = (newCtx, newOrigin) => {
      newCtx.save();
      this._applyMaskClipAtOrigin(newCtx, userId, newOrigin);
    };
  }

  withSelectionMaskClip(ctx, userId, drawFn) {
    if (!ctx || typeof drawFn !== 'function') return;
    if (!this._getSelectionMaskForUser(userId)) {
      drawFn();
      return;
    }
    ctx.save();
    this._applyMaskClipToCtx(ctx, userId);
    drawFn();
    ctx.restore();
  }

  /**
   * Mask a preview canvas to the active layer's existing pixels for "Existing"
   * blend bake mode. Mirrors the commit-time mask in `_buildFlatContentCanvas`,
   * so the preview only appears where the bake would actually deposit pixels.
   * No-op for users not in Existing mode or with a trivial blend mode.
   * @param {CanvasRenderingContext2D} ctx - Preview canvas context (topCtx or remote user.context)
   * @param {Object} user - User whose blend settings drive the mask
   * @param {{x:number,y:number,width:number,height:number}|null} [rect=null] - Optional clip rect
   */
  maskPreviewForExistingMode(ctx, user, rect = null) {
    if (!ctx || !user) return;
    if (user.blendBakeMode !== 'existing') return;
    if (!user.blendMode || user.blendMode === 'source-over' || user.blendMode === 'destination-out') return;

    const existingContent = this.layerManager?.getLayerExistingContent?.(user.activeLayer ?? 0);
    if (!existingContent) return;

    ctx.save();
    if (rect) {
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
    }
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(existingContent, 0, 0);
    ctx.restore();
  }

  releaseSelectionMaskClipForStroke(layerIndex, userId) {
    const key = `${layerIndex}_${userId}`;
    if (!this._maskClippedStrokes.has(key) || !this.layerManager) return false;
    const ctx = this.layerManager.getActiveStroke(layerIndex, userId)?.ctx;
    if (ctx) ctx.restore();
    this._maskClippedStrokes.delete(key);
    return true;
  }

  drawMaskDarkenOverlay(marchingOffset = 0) {
    const mask = this.selectionMask;
    if (!mask) return;
    const ctx = this.getSelectionCtx();
    if (!ctx) return;

    const w = this.getWidth();
    const h = this.getHeight();

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // Darken area outside the mask
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    if (mask.lassoPath?.length > 0) {
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.moveTo(mask.lassoPath[0].x, mask.lassoPath[0].y);
      for (let i = 1; i < mask.lassoPath.length; i++) {
        ctx.lineTo(mask.lassoPath[i].x, mask.lassoPath[i].y);
      }
      ctx.closePath();
      ctx.fill('evenodd');
    } else {
      const { x, y, width, height } = mask;
      if (y > 0) ctx.fillRect(0, 0, w, y);
      if (y + height < h) ctx.fillRect(0, y + height, w, h - y - height);
      if (x > 0) ctx.fillRect(0, y, x, height);
      if (x + width < w) ctx.fillRect(x + width, y, w - x - width, height);
    }

    // Marching ants on the boundary
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    if (mask.lassoPath?.length > 0) {
      const buildPath = () => {
        ctx.beginPath();
        ctx.moveTo(mask.lassoPath[0].x, mask.lassoPath[0].y);
        for (let i = 1; i < mask.lassoPath.length; i++) {
          ctx.lineTo(mask.lassoPath[i].x, mask.lassoPath[i].y);
        }
        ctx.closePath();
      };
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -marchingOffset;
      buildPath(); ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -marchingOffset + 4;
      buildPath(); ctx.stroke();
    } else {
      const { x, y, width, height } = mask;
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -marchingOffset;
      ctx.strokeRect(x, y, width, height);
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -marchingOffset + 4;
      ctx.strokeRect(x, y, width, height);
    }
    ctx.setLineDash([]);

    ctx.restore();
    this.restoreSelectionCtx();
  }

  withMirrorRegionClip(ctx, region, drawFn) {
    if (!ctx || !region || typeof drawFn !== 'function') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.width, region.height);
    ctx.clip();
    drawFn();
    ctx.restore();
  }

  /**
   * Runs drawing code in a mirror-region-local transformed coordinate space.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} region
   * @param {Function} drawFn
   */
  withMirroredRegionTransform(ctx, region, drawFn) {
    if (!ctx || !region || typeof drawFn !== 'function') return;
    const m = this._mirrorRegionMatrix(region);
    if (!m) return;
    this.withMirrorRegionClip(ctx, region, () => {
      ctx.save();
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      drawFn();
      ctx.restore();
    });
  }

  /**
   * Draws a source canvas mirrored into a mirror region.
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} sourceCanvas
   * @param {Object} region
   * @param {number} [x=0]
   * @param {number} [y=0]
   */
  drawMirroredCanvas(ctx, sourceCanvas, region, x = 0, y = 0) {
    if (!ctx || !sourceCanvas || !region) return;
    this.withMirroredRegionTransform(ctx, region, () => {
      ctx.drawImage(sourceCanvas, x, y);
    });
  }

  /**
   * Iterates active mirror regions intersecting a target geometry.
   * @param {Object|null} target
   * @param {(region: Object) => void} callback
   */
  forEachMirrorRegion(target, callback) {
    if (typeof callback !== 'function') return;
    const bounds = this._getMirrorTargetBounds(target);
    let hit = false;
    for (const region of this.getActiveMirrorRegions()) {
      if (!bounds || this._rectIntersects(bounds, region)) {
        hit = true;
        callback(region);
      }
    }
    // Every mirror-aware tool funnels its painting through here, so this is the
    // one place that sees all drawing activity inside a region.
    if (hit) this.noteMirrorActivity();
  }

  /**
   * Board-space extent of everything drawn for one region on the GUIDES layer.
   *
   * Almost every mode draws inside the region rect — `fib` even hard-clips to
   * it. `radial` is the exception: its spokes run `max(width, height) / 2` from
   * the centre, which overflows the rect in the shorter axis whenever the region
   * is not square, and the edge handles (tm/bm/ml/mr) resize one dimension at a
   * time, so non-square radial regions are reachable.
   * @private
   */
  _mirrorGuideExtent(region) {
    const axis = region.mode || region.axis || 'vertical';
    if (axis === 'radial') {
      const r = Math.max(region.width, region.height) / 2;
      const cx = region.x + region.width / 2;
      const cy = region.y + region.height / 2;
      return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
    }
    return {
      x0: region.x,
      y0: region.y,
      x1: region.x + region.width,
      y1: region.y + region.height
    };
  }

  /**
   * Union of `regions`' extents, padded and clamped to the board, or null when
   * there is nothing to draw.
   *
   * Clamping to the board keeps the canvas bounded and loses nothing: content
   * outside the board was already cut off when these layers were board-sized.
   * @private
   */
  _mirrorUnionBounds(regions, extentOf) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const region of regions) {
      const e = extentOf(region);
      if (e.x0 < x0) x0 = e.x0;
      if (e.y0 < y0) y0 = e.y0;
      if (e.x1 > x1) x1 = e.x1;
      if (e.y1 > y1) y1 = e.y1;
    }
    if (!(x1 > -Infinity)) return null;

    const pad = MIRROR_LAYER_PAD;
    x0 = Math.max(0, Math.floor(x0 - pad));
    y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(this.getWidth(), Math.ceil(x1 + pad));
    y1 = Math.min(this.getHeight(), Math.ceil(y1 + pad));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x0, y0, x1, y1 };
  }

  /**
   * Size one mirror layer to `bounds` and position it there, or collapse it to
   * 1x1 when `bounds` is null.
   *
   * These layers used to be full board-sized canvases for the whole session —
   * ~285 MB each at the 12k preset — purely so that board coordinates equalled
   * canvas coordinates for a handful of hairline strokes. A region covers a tiny
   * fraction of the board in every realistic case, so the canvas follows the
   * content and the caller translates by the returned origin.
   *
   * @returns {{x: number, y: number}|null} board-space origin of the canvas
   * @private
   */
  _sizeMirrorLayer(layer, bounds) {
    if (!layer) return null;

    const w = bounds ? Math.max(1, bounds.x1 - bounds.x0) : 1;
    const h = bounds ? Math.max(1, bounds.y1 - bounds.y0) : 1;
    if (layer.width !== w || layer.height !== h) {
      // Resets the context to spec defaults, which is what these layers have
      // always had — updateHighZoomRenderingMode deliberately does not list
      // them, so there is no crisp/smoothing mode to re-apply here.
      layer.width = w;
      layer.height = h;
    }

    const originX = bounds ? bounds.x0 : 0;
    const originY = bounds ? bounds.y0 : 0;
    layer.style.left = `${originX}px`;
    layer.style.top = `${originY}px`;
    layer.style.width = `${w}px`;
    layer.style.height = `${h}px`;
    return bounds ? { x: originX, y: originY } : null;
  }

  /**
   * Renders the persistent mirror region overlays.
   */
  renderMirrorRegions() {
    if (!this.mirrorRegionsCtx || !this.mirrorRegionsLayer) return;

    const regions = this.mirrorRegions;
    const guideRegions = regions.filter((r) => r.showLine);

    // Each layer follows its OWN content: the borders track the region rects,
    // the guides track guide geometry (which radial can push outside them), and
    // a region with showLine off contributes nothing to the guides layer.
    const regionOrigin = this._sizeMirrorLayer(
      this.mirrorRegionsLayer,
      this._mirrorUnionBounds(regions, (r) => ({
        x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height
      }))
    );
    const guideOrigin = this._sizeMirrorLayer(
      this.mirrorGuidesLayer,
      this._mirrorUnionBounds(guideRegions, (r) => this._mirrorGuideExtent(r))
    );

    // Clear under the identity transform so the whole canvas is covered
    // whatever origin it now sits at, then shift board space onto it.
    const rCtx = this.mirrorRegionsCtx;
    rCtx.setTransform(1, 0, 0, 1, 0, 0);
    rCtx.clearRect(0, 0, this.mirrorRegionsLayer.width, this.mirrorRegionsLayer.height);
    if (regionOrigin) rCtx.setTransform(1, 0, 0, 1, -regionOrigin.x, -regionOrigin.y);

    const gCtx = this.mirrorGuidesCtx;
    if (gCtx && this.mirrorGuidesLayer) {
      gCtx.setTransform(1, 0, 0, 1, 0, 0);
      gCtx.clearRect(0, 0, this.mirrorGuidesLayer.width, this.mirrorGuidesLayer.height);
      if (guideOrigin) gCtx.setTransform(1, 0, 0, 1, -guideOrigin.x, -guideOrigin.y);
    }

    let guidesDrawn = 0;

    for (const region of regions) {
      // Border: always visible, so a region stays findable while you work.
      // Deliberately hairline — it sits on top of the artwork and should read as
      // a guide, not as ink.
      if (regionOrigin) {
        rCtx.save();
        rCtx.strokeStyle = 'rgba(0, 212, 170, 0.75)';
        rCtx.lineWidth = 0.5;
        rCtx.strokeRect(region.x, region.y, region.width, region.height);
        rCtx.restore();
      }

      // Centre line: separate layer, fades on idle (see noteMirrorActivity).
      if (region.showLine && gCtx && guideOrigin) {
        gCtx.save();
        gCtx.setLineDash([4, 4]);
        gCtx.lineWidth = 0.5;
        gCtx.strokeStyle = 'rgba(0, 212, 170, 0.7)';
        Board.drawMirrorGuide(gCtx, region);
        gCtx.restore();
        guidesDrawn++;
      }
    }

    this._setLayerPresent(this.mirrorRegionsLayer, !!regionOrigin);
    this._mirrorGuidesHasContent = guidesDrawn > 0;
    this._applyMirrorGuidesDisplay();
  }

  /**
   * Shared helper for drawing mirror mode guides.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} region
   */
  static drawMirrorGuide(ctx, region) {
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    const axis = region.mode || region.axis || 'vertical';

    ctx.save();
    if (axis === 'horizontal') {
      ctx.beginPath();
      ctx.moveTo(region.x, cy);
      ctx.lineTo(region.x + region.width, cy);
      ctx.stroke();
    } else if (axis === 'vertical') {
      ctx.beginPath();
      ctx.moveTo(cx, region.y);
      ctx.lineTo(cx, region.y + region.height);
      ctx.stroke();
    } else if (axis === 'radial') {
      const radius = Math.max(region.width, region.height) / 2;
      const slices = region.slices || 6;
      ctx.beginPath();
      for (let step = 0; step < slices; step += 1) {
        const angle = ((Math.PI * 2) / slices) * step - (Math.PI / 2);
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      }
      ctx.stroke();
    } else if (axis === 'fib') {
      const depth = region.fibDepth || 4;
      const previewDepth = 8;
      const invPHI = 0.6180339887;
      const fibAngleOffset = Math.PI;
      const eyeX = region.x + region.width * invPHI;
      const eyeY = region.y + region.height * invPHI;

      // Always draw the guide rectangle from the exact selected region bounds.
      ctx.strokeRect(region.x, region.y, region.width, region.height);

      // Keep all Fibonacci preview geometry hard-clipped to the selected region.
      ctx.save();
      ctx.beginPath();
      ctx.rect(region.x, region.y, region.width, region.height);
      ctx.clip();

      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.15;
      ctx.strokeStyle = 'rgba(0, 212, 170, 0.9)';
      ctx.beginPath();
      const startX = region.x;
      const startY = region.y + region.height;
      const startDx = startX - eyeX;
      const startDy = startY - eyeY;
      const offsetCos = Math.cos(fibAngleOffset);
      const offsetSin = Math.sin(fibAngleOffset);
      // Phase-compensate the start vector so t=0 remains anchored at bottom-left.
      const baseDx = (startDx * offsetCos) + (startDy * offsetSin);
      const baseDy = (-startDx * offsetSin) + (startDy * offsetCos);
      const steps = Math.max(20, previewDepth * 48);
      for (let i = 0; i <= steps; i += 1) {
        const t = (previewDepth * i) / steps;
        const angle = fibAngleOffset + (t * (Math.PI / 2));
        const scale = Math.pow(invPHI, t);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const x = eyeX + ((baseDx * cos) - (baseDy * sin)) * scale;
        const y = eyeY + ((baseDx * sin) + (baseDy * cos)) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    } else {
      // Quad / Rotational
      ctx.beginPath();
      ctx.moveTo(region.x, cy);
      ctx.lineTo(region.x + region.width, cy);
      ctx.moveTo(cx, region.y);
      ctx.lineTo(cx, region.y + region.height);
      ctx.stroke();
    }
    ctx.restore();
  }

  renderInteractionBlocks() {
    if (!this.interactionBlockCtx || !this.interactionBlockOverlay) return;

    const pad = this.interactionBlockOverlayPadding;
    const [height, width] = this.dimensions;

    if (this.interactionBlocks.length === 0) {
      this._sizeOverlayCanvas(this.interactionBlockOverlay, pad, false);
      return;
    }
    this._sizeOverlayCanvas(this.interactionBlockOverlay, pad, true);
    this.interactionBlockCtx.clearRect(0, 0, width + pad * 2, height + pad * 2);

    this.interactionBlockCtx.save();
    this.interactionBlockCtx.translate(pad, pad);

    for (const block of this.interactionBlocks) {
      this.interactionBlockCtx.save();
      this._traceInteractionBlockPath(this.interactionBlockCtx, block);
      this.interactionBlockCtx.fillStyle = 'rgba(34, 34, 34, 0.14)';
      this.interactionBlockCtx.fill();

      this.interactionBlockCtx.lineWidth = 1;
      this.interactionBlockCtx.setLineDash([4, 4]);
      this.interactionBlockCtx.strokeStyle = '#000';
      this.interactionBlockCtx.lineDashOffset = -this.interactionBlockDashOffset;
      this.interactionBlockCtx.stroke();

      this.interactionBlockCtx.strokeStyle = '#fff';
      this.interactionBlockCtx.lineDashOffset = -this.interactionBlockDashOffset + 4;
      this.interactionBlockCtx.stroke();
      this.interactionBlockCtx.restore();
    }

    this.interactionBlockCtx.restore();
  }

  _normalizeMirrorRegion(region) {
    if (!region) return null;
    const x = Math.floor(Number(region.x));
    const y = Math.floor(Number(region.y));
    const width = Math.floor(Number(region.width));
    const height = Math.floor(Number(region.height));

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }

    return {
      id: String(region.id || `mr_${x}_${y}_${width}_${height}`),
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.max(1, width),
      height: Math.max(1, height),
      mode: this._normalizeMirrorMode(region.mode || region.axis),
      axis: this._normalizeMirrorMode(region.mode || region.axis),
      slices: this._normalizeMirrorSlices(region.slices),
      fibDepth: this._normalizeFibDepth(region.fibDepth),
      showLine: region.showLine !== false,
      owner: region.owner || region.createdBy || null
    };
  }

  _normalizeInteractionBlock(region) {
    if (!region) return null;

    const id = String(region.id || `ib_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const type = region.type === 'lasso' ? 'lasso' : 'rect';

    if (type === 'lasso') {
      const points = Array.isArray(region.points)
        ? region.points
          .map(point => ({
            x: Math.floor(Number(point?.x)),
            y: Math.floor(Number(point?.y))
          }))
          .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        : [];

      if (points.length < 3) return null;

      let minX = points[0].x;
      let minY = points[0].y;
      let maxX = points[0].x;
      let maxY = points[0].y;
      for (const point of points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }

      return {
        id,
        type,
        points,
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY)
      };
    }

    const x = Math.floor(Number(region.x));
    const y = Math.floor(Number(region.y));
    const width = Math.floor(Number(region.width));
    const height = Math.floor(Number(region.height));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }

    return {
      id,
      type,
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.max(1, width),
      height: Math.max(1, height)
    };
  }

  _traceInteractionBlockPath(ctx, block) {
    ctx.beginPath();
    if (block.type === 'lasso' && block.points?.length >= 3) {
      ctx.moveTo(block.points[0].x, block.points[0].y);
      for (let i = 1; i < block.points.length; i++) {
        ctx.lineTo(block.points[i].x, block.points[i].y);
      }
      ctx.closePath();
      return;
    }

    ctx.rect(block.x, block.y, block.width, block.height);
  }

  _updateInteractionBlockAnimation() {
    if (this.interactionBlocks.length > 0) {
      if (this.interactionBlockAnimationId !== null) return;
      const tick = () => {
        if (this.interactionBlocks.length === 0) {
          this.interactionBlockAnimationId = null;
          return;
        }
        this.interactionBlockDashOffset = (this.interactionBlockDashOffset + 1) % 8;
        this.renderInteractionBlocks();
        this.interactionBlockAnimationId = requestAnimationFrame(tick);
      };
      this.interactionBlockAnimationId = requestAnimationFrame(tick);
      return;
    }

    if (this.interactionBlockAnimationId !== null) {
      cancelAnimationFrame(this.interactionBlockAnimationId);
      this.interactionBlockAnimationId = null;
    }
    this.interactionBlockDashOffset = 0;
  }

  _pointInInteractionBlock(point, block) {
    if (!this._rectIntersects(
      { x: point.x, y: point.y, width: 1, height: 1 },
      { x: block.x, y: block.y, width: block.width, height: block.height }
    )) {
      return false;
    }

    if (block.type !== 'lasso') {
      return point.x >= block.x
        && point.x <= block.x + block.width
        && point.y >= block.y
        && point.y <= block.y + block.height;
    }

    let inside = false;
    const points = block.points || [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x;
      const yi = points[i].y;
      const xj = points[j].x;
      const yj = points[j].y;
      const intersects = ((yi > point.y) !== (yj > point.y))
        && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  _segmentIntersectsInteractionBlock(start, end, block) {
    const minX = Math.min(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxX = Math.max(start.x, end.x);
    const maxY = Math.max(start.y, end.y);

    if (!this._rectIntersects(
      { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) },
      { x: block.x, y: block.y, width: block.width, height: block.height }
    )) {
      return false;
    }

    if (this._pointInInteractionBlock(start, block) || this._pointInInteractionBlock(end, block)) {
      return true;
    }

    if (block.type === 'lasso' && block.points?.length >= 3) {
      for (let i = 0; i < block.points.length; i++) {
        const a = block.points[i];
        const b = block.points[(i + 1) % block.points.length];
        if (this._segmentsIntersect(start, end, a, b)) return true;
      }
      return false;
    }

    const corners = [
      { x: block.x, y: block.y },
      { x: block.x + block.width, y: block.y },
      { x: block.x + block.width, y: block.y + block.height },
      { x: block.x, y: block.y + block.height }
    ];
    for (let i = 0; i < corners.length; i++) {
      if (this._segmentsIntersect(start, end, corners[i], corners[(i + 1) % corners.length])) {
        return true;
      }
    }

    return false;
  }

  _segmentsIntersect(a, b, c, d) {
    const orientation = (p, q, r) => {
      const value = ((q.y - p.y) * (r.x - q.x)) - ((q.x - p.x) * (r.y - q.y));
      if (Math.abs(value) < 0.0001) return 0;
      return value > 0 ? 1 : 2;
    };

    const onSegment = (p, q, r) => (
      q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x)
      && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y)
    );

    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);

    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(a, c, b)) return true;
    if (o2 === 0 && onSegment(a, d, b)) return true;
    if (o3 === 0 && onSegment(c, a, d)) return true;
    if (o4 === 0 && onSegment(c, b, d)) return true;
    return false;
  }

  _normalizeMirrorMode(mode) {
    return ['horizontal', 'quad', 'rotational', 'radial', 'fib'].includes(mode) ? mode : 'vertical';
  }

  _normalizeMirrorSlices(slices) {
    const parsed = Math.floor(Number(slices));
    if (!Number.isFinite(parsed)) return 6;
    return Math.max(3, Math.min(16, parsed));
  }

  _normalizeFibDepth(depth) {
    const parsed = Math.floor(Number(depth));
    if (!Number.isFinite(parsed)) return 4;
    return Math.max(1, Math.min(8, parsed));
  }

  _expandMirrorRegionTransforms(region) {
    if (!region) return [];

    const baseRegion = {
      ...region,
      mode: this._normalizeMirrorMode(region.mode || region.axis),
      slices: this._normalizeMirrorSlices(region.slices)
    };

    const transformsByMode = {
      vertical: ['flipX'],
      horizontal: ['flipY'],
      quad: ['flipX', 'flipY', 'flipXY'],
      rotational: ['rotate180']
    };

    if (baseRegion.mode === 'radial') {
      const transforms = [];
      for (let step = 1; step < baseRegion.slices; step += 1) {
        const rotationAngle = (Math.PI * 2 * step) / baseRegion.slices;
        transforms.push({
          ...baseRegion,
          transform: 'rotateCustom',
          rotationAngle,
          rotationStep: step,
          synthetic: true,
          id: `${baseRegion.id}_radial_${step}`
        });
      }
      return transforms;
    }

    if (baseRegion.mode === 'fib') {
      const transforms = [];
      const depth = baseRegion.fibDepth || 4;
      for (let step = 1; step <= depth; step += 1) {
        transforms.push({
          ...baseRegion,
          transform: 'fibStep',
          fibStep: step,
          synthetic: true,
          id: `${baseRegion.id}_fib_${step}`
        });
      }
      return transforms;
    }

    return (transformsByMode[baseRegion.mode] || transformsByMode.vertical).map(transform => ({
      ...baseRegion,
      transform,
      synthetic: true,
      id: `${baseRegion.id}_${transform}`
    }));
  }

  _appendMirrorRegionGuide(regionEl, region) {
    const addLine = (styles) => {
      const lineEl = document.createElement('div');
      lineEl.className = 'mirror-region-line';
      lineEl.style.position = 'absolute';
      Object.assign(lineEl.style, styles);
      regionEl.appendChild(lineEl);
    };

    const horizontalStyles = {
      left: '0',
      right: '0',
      top: `${region.height / 2}px`,
      height: '0',
      borderTop: '1px dashed rgba(0, 212, 170, 0.85)',
      transform: 'translateY(-0.5px) scaleY(0.8)',
      transformOrigin: 'center'
    };
    const verticalStyles = {
      top: '0',
      bottom: '0',
      left: `${region.width / 2}px`,
      width: '0',
      borderLeft: '1px dashed rgba(0, 212, 170, 0.85)',
      transform: 'translateX(-0.5px) scaleX(0.8)',
      transformOrigin: 'center'
    };

    switch (region.mode) {
      case 'horizontal':
        addLine(horizontalStyles);
        break;
      case 'radial': {
        const cx = region.width / 2;
        const cy = region.height / 2;
        const radius = Math.max(region.width, region.height) / 2;
        for (let step = 0; step < region.slices; step += 1) {
          const angle = ((Math.PI * 2) / region.slices) * step - (Math.PI / 2);
          addLine({
            left: `${cx}px`,
            top: `${cy}px`,
            width: `${radius}px`,
            height: '0',
            borderTop: '1px dashed rgba(0, 212, 170, 0.85)',
            transformOrigin: '0 0',
            transform: `rotate(${angle}rad) scaleX(0.8)`
          });
        }
        break;
      }
      case 'quad':
      case 'rotational':
        addLine(horizontalStyles);
        addLine(verticalStyles);
        break;
      default:
        addLine(verticalStyles);
        break;
    }
  }

  _getMirrorTargetBounds(target) {
    if (!target) return null;

    if (target.rect) return target.rect;

    if (target.point) {
      return { x: target.point.x, y: target.point.y, width: 0, height: 0 };
    }

    if (Array.isArray(target.points) && target.points.length > 0) {
      let minX = target.points[0].x;
      let minY = target.points[0].y;
      let maxX = target.points[0].x;
      let maxY = target.points[0].y;

      for (const point of target.points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }

      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      };
    }

    return null;
  }

  _rectIntersects(a, b) {
    return (
      a.x <= b.x + b.width &&
      a.x + a.width >= b.x &&
      a.y <= b.y + b.height &&
      a.y + a.height >= b.y
    );
  }

  /**
   * Resize the board to new dimensions, preserving existing layer content at top-left.
   * @param {[number, number]} newDimensions - [height, width]
   */
  resizeBoard(newDimensions) {
    // Capture each layer before dimensions change so we can restore at (0,0)
    const snapshots = this.layerManager ? this.getSnapshot() : null;
    const [oldH, oldW] = this.dimensions;

    this.dimensions = newDimensions;
    const [height, width] = this.dimensions;

    this._createLayerManager();
    this.compositeTileGrid = new CompositeTileGrid(width, height, 32);
    this.tileTracker = new TileTracker(width, height);
    this.setupCanvas();

    if (snapshots?.length) {
      for (let i = 0; i < snapshots.length && i < this.layerManager.layerGroups.length; i++) {
        const qoi = snapshots[i];
        if (!qoi || qoi.length === 0) continue;
        const pixels = wasm.qoi_decode(qoi);
        if (!pixels || pixels.length === 0) continue;
        // A layer that was empty before the resize must stay structurally empty
        // after it — see _snapshotLayerHasPixels.
        if (!this._snapshotLayerHasPixels(pixels)) continue;
        const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), oldW, oldH);
        this.layerManager.addToBaseBin(i, this._createCanvasFromImageData(imageData), 0, 0);
      }
      this.markCompositeFull();
      this.compositeAllLayers();
    }

    this.resetView();
  }

  /**
   * Clear all layers and reset canvases
   */
  clear() {
    const [height, width] = this.dimensions;
    this.viewCtx.beginPath();
    this.topCtx.beginPath();

    if (this.layerManager) {
      this.layerManager.clearAll();
      // Every active stroke context just went away with it — see
      // resetSelectionMaskClipTracking.
      this.resetSelectionMaskClipTracking();
      this.markCompositeFull();
      this.compositeAllLayers();
    } else {
      this.viewCtx.clearRect(0, 0, width, height);
    }

    this.textOverlay?.clear();
    this.compositeTileGrid?.clear?.();

    // Clear tile tracker when board is cleared
    if (this.tileTracker) {
      this.tileTracker.clear();
    }

    this.topCtx.clearRect(0, 0, width, height);
  }

  rebuildRenderingState(options = {}) {
    const preserveSnapshot = options.preserveSnapshot === true;
    const layerSnapshot = preserveSnapshot ? this.getSnapshot() : null;
    const previousLayerManager = this.layerManager;

    previousLayerManager?.destroy?.();
    this._createLayerManager(previousLayerManager);

    this.activeSelectionLayer = -1;
    this.viewCtx.clearRect(0, 0, this.getWidth(), this.getHeight());
    this.clearTop();
    this.clearSelectionOverlay();
    if (this.upperLayersCtx) {
      this.upperLayersCtx.clearRect(0, 0, this.getWidth(), this.getHeight());
    }
    this._upperLayersCompositeStart = null;
    this._upperLayersCompositeEnd = null;
    this._setLayerPresent(this.upperLayersCanvas, false);
    this._mainCompositeEnd = null;
    this.markCompositeFull();
    this.tileTracker?.clear?.();

    if (layerSnapshot?.length) {
      this.restoreSnapshot(layerSnapshot);
    } else {
      this.layerManager.needsComposite = true;
      this.compositeAllLayers();
    }
  }

  /**
   * Get the drawing context for the local user's active sub-layer.
   * @param {string} [createBlendMode='source-over'] - Blend mode if creating new sub-layer
   * @returns {CanvasRenderingContext2D}
   */
  getActiveLayerContext(createBlendMode = 'source-over') {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    return this.layerManager?.getLayerContext(activeLayer, userId, createBlendMode) ?? this.viewCtx;
  }

  /**
   * Get drawing context for a specific user on a specific layer.
   * @param {number} layerIndex - Layer index
   * @param {number} userId - User ID
   * @param {string} [createBlendMode='source-over'] - Blend mode if creating new sub-layer
   * @returns {CanvasRenderingContext2D}
   */
  getLayerContext(layerIndex, userId, createBlendMode = 'source-over') {
    return this.layerManager?.getLayerContext(layerIndex, userId, createBlendMode) ?? this.viewCtx;
  }

  /**
   * Get local user's current blend mode
   * @returns {string}
   */
  getActiveLayerBlendMode() {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    if (!this.layerManager?.getLayerAllowComplexBlendModes(activeLayer)) {
      return 'source-over';
    }
    return this.app?.self?.blendMode ?? 'source-over';
  }

  /**
   * Begin a new sub-layer with a specific blend mode for the local user.
   * @param {string} blendMode - Canvas composite operation
   */
  createActiveLayerBlendSubLayer(blendMode) {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    if (this.layerManager) {
      this.layerManager.beginUserStroke(activeLayer, userId, blendMode, this.app?.self?.blendBakeMode);
    }
  }

  /**
   * Begin a new stroke for a user.
   * @param {Object} user - User object
   * @param {string} [blendModeOverride] - Optional blend mode override
   */
  beginStroke(user, blendModeOverride) {
    if (user?.panning) return;
    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const blendMode = blendModeOverride ?? user?.blendMode ?? 'source-over';
    if (this.layerManager) {
      this.layerManager.beginUserStroke(activeLayer, userId, blendMode, user?.blendBakeMode);
    }
    this.applySelectionMaskClipForStroke(activeLayer, userId);
    this.requestUpdate();
  }

  /**
   * Begin a stroke on every layer simultaneously (erase-all mode).
   * @param {Object} user - User object
   * @param {string} blendMode - Blend mode (usually destination-out)
   */
  beginStrokeAllLayers(user, blendMode) {
    if (user?.panning) return;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (this.layerManager) {
      const count = this.layerManager.getLayerCount();
      for (let i = 0; i < count; i++) {
        this.layerManager.beginUserStroke(i, userId, blendMode);
      }
      if (this._getSelectionMaskForUser(userId)) {
        for (let i = 0; i < count; i++) this.applySelectionMaskClipForStroke(i, userId);
      }
    }
    this.requestUpdate();
  }

  /**
   * End stroke on every layer for a user (erase-all mode).
   * @param {Object} user - User object
   */
  endStrokeAllLayers(user, options = {}) {
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;
    if (this._getSelectionMaskForUser(userId)) {
      const count = this.layerManager.getLayerCount();
      for (let i = 0; i < count; i++) {
        this.releaseSelectionMaskClipForStroke(i, userId);
      }
    }
    const batchTimestamp = options.timestamp || Date.now();
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      this.layerManager.commitUserStroke(i, userId, { eraseAll: true, timestamp: batchTimestamp, ...options });
    }
    this._compositeCommittedStrokeNow();
  }

  /**
   * Get drawing contexts for all layers for a user.
   * @param {number} userId - User ID
   * @returns {CanvasRenderingContext2D[]}
   */
  getAllLayerContexts(userId) {
    if (!this.layerManager) return [];
    const ctxs = [];
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      const ctx = this.layerManager.getUserStrokeContext(i, userId);
      if (ctx) ctxs.push(ctx);
    }
    return ctxs;
  }

  /**
   * End the current stroke for a user.
   * @param {Object} user - User object
   * @param {Object} [extraProps={}] - Extra properties for the stroke record (e.g., filter metadata)
   */
  endStroke(user, extraProps = {}) {
    // Blur/glitch blur tools always create their stroke on layer 0
    const isBlurFilter = extraProps.filterType === 'blur' || extraProps.filterType === 'glitchBlur';
    const activeLayer = isBlurFilter ? 0 : (user?.activeLayer ?? this.app?.self?.activeLayer ?? 0);
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;

    this.releaseSelectionMaskClipForStroke(activeLayer, userId);

    // Keep localUserId current so LayerManager can distinguish local vs remote strokes
    this.layerManager.localUserId = this.app?.self?.id ?? null;

    // Get affected tiles before committing (for broadcasting local user's tiles)
    // Skip for erasers - they use TILE_CLEAR instead of TILE_UPDATE
    let tilesToBroadcast = null;
    const isLocalUser = userId === this.app?.self?.id;
    const active = this.layerManager.getActiveStroke(activeLayer, userId);
    if (isLocalUser && this.app?.wsClient && this.app?.connected) {
      if (active?.affectedTiles?.size > 0 && active.blendMode !== 'destination-out') {
        tilesToBroadcast = Array.from(active.affectedTiles);
      }
    }
    if (active?.dirtyRect && active.dirtyRect.maxX !== -1) {
      this.compositeTileGrid?.markRect(
        active.dirtyRect.minX,
        active.dirtyRect.minY,
        active.dirtyRect.maxX - active.dirtyRect.minX + 1,
        active.dirtyRect.maxY - active.dirtyRect.minY + 1
      );
    }

    if (extraProps.filterType === 'glitchBlur') {
      extraProps.mirrorRegions = this.getActiveMirrorRegions().map(region => ({ ...region }));
    }

    this.layerManager.commitUserStroke(activeLayer, userId, extraProps);
    this._compositeCommittedStrokeNow();

    // Broadcast tile ownership update for local user
    if (tilesToBroadcast && tilesToBroadcast.length > 0) {
      this.app.wsClient.broadcastTileUpdate(tilesToBroadcast);
    }
  }

  _compositeCommittedStrokeNow() {
    this._needsComposite = false;
    this._lastCompositeTime = performance.now();
    this.compositeAllLayers();
  }

  /**
   * Commits all active strokes for an AFK user with delays to avoid lag.
   * Processes one layer at a time with 50ms delays between each.
   * @param {number} userId - User ID to commit strokes for
   * @returns {Promise<void>}
   */
  async commitAllUserStrokesForAFKUser(userId) {
    if (!this.layerManager) return;

    const gen = this.layerManager.commitAllUserStrokesGenerator(userId);
    const DELAY_MS = 50;

    for (const groupIdx of gen) {
      // Composite after each layer commit
      this.compositeAllLayers();
      // Wait before processing next layer to avoid sudden lag
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  /**
   * Called when the local user's glitch blur WASM computation completes.
   * Converts the result to a data URL and broadcasts it to other clients.
   * @param {Object} result - { userId, x, y, width, height, canvas }
   * @private
   */
  _handleGlitchBlurReady(result) {
    if (!this.app?.wsClient || !this.app?.connected) return;
    const dataUrl = result.canvas.toDataURL('image/png');
    this.app.wsClient.broadcastGlitchResult(result.x, result.y, result.width, result.height, dataUrl);
  }

  markCompositeFull() {
    this.compositeTileGrid?.markFull?.();
  }

  _markBatchDirtyRects(batch) {
    const pad = 2;
    let marked = false;
    for (const { record } of batch) {
      if (record.x != null && record.y != null && record.width > 0 && record.height > 0) {
        this.compositeTileGrid?.markRect(
          record.x - pad, record.y - pad,
          record.width + pad * 2, record.height + pad * 2
        );
        marked = true;
      }
    }
    if (!marked) {
      this.markCompositeFull();
    }
  }

  _markSelectionRestoreDirtyRects(restoreData) {
    if (!restoreData) return;
    const { snapshots, eraseS } = restoreData;
    if (eraseS) {
      this.compositeTileGrid?.markRect(eraseS.x, eraseS.y, eraseS.width, eraseS.height);
    }
    if (snapshots) {
      for (const { canvas, x, y } of snapshots) {
        if (canvas) {
          this.compositeTileGrid?.markRect(x, y, canvas.width, canvas.height);
        }
      }
    }
  }

  _applyCompositeClip(ctx, dirtyRects) {
    if (!ctx || !dirtyRects || dirtyRects.length === 0) return false;
    ctx.save();
    ctx.beginPath();
    for (const rect of dirtyRects) {
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
    }
    ctx.clip();
    return true;
  }

  _clearCompositeContext(ctx, dirtyRects) {
    if (!ctx) return;
    if (dirtyRects && dirtyRects.length > 0) {
      for (const rect of dirtyRects) {
        ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
      }
      return;
    }
    ctx.clearRect(0, 0, this.getWidth(), this.getHeight());
  }

  _fillCompositeContext(ctx, dirtyRects) {
    if (!ctx) return;
    if (dirtyRects && dirtyRects.length > 0) {
      for (const rect of dirtyRects) {
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
      return;
    }
    ctx.fillRect(0, 0, this.getWidth(), this.getHeight());
  }

  /**
   * Clip composite dirty rects to the surface window and snap them out to whole
   * device pixels.
   *
   * The one place both the viewCanvas and upperLayersCanvas rect sets pass
   * through, and a no-op when the window is the whole board at 1:1 — i.e.
   * whenever `windowedSurfaces` is off.
   *
   * Clipping: a rect outside the window cannot land on any display surface, so
   * carrying it costs a clip-path segment and a `drawImage` setup per layer for
   * nothing. Unlike viewport culling this is exact rather than a heuristic —
   * the window is where the pixels physically are — and it needs no repair
   * path, because every full-board reader now goes through `getFullRaster`.
   *
   * Snapping: at a surface scale below 1 a board-space rect lands on fractional
   * device pixels, and a clear that rounds one way against a fill that rounds
   * the other leaves a one-device-pixel seam at every rect boundary. Expanding
   * outward makes the clear a superset of the fill.
   * @private
   */
  _prepareCompositeRects(rects) {
    const win = getSurfaceWindow();
    const clip = this.windowedSurfaces &&
      (win.width < this.getWidth() || win.height < this.getHeight());

    const out = [];
    for (const r of rects) {
      let rect = r;
      if (clip) {
        const x = Math.max(rect.x, win.x);
        const y = Math.max(rect.y, win.y);
        const right = Math.min(rect.x + rect.width, win.x + win.width);
        const bottom = Math.min(rect.y + rect.height, win.y + win.height);
        if (right <= x || bottom <= y) continue;
        rect = { x, y, width: right - x, height: bottom - y };
      }
      out.push(snapRectToDevicePixels(rect, win));
    }
    // Never an empty array: compositeLayerRange reads that as "no usable dirty
    // rects" and falls back to a full clear and redraw, which is the exact
    // opposite of what an entirely-off-window dirty set should cost. One
    // degenerate rect keeps the dirty-rect path and clips everything away.
    return out.length > 0 ? out : [{ x: 0, y: 0, width: 0, height: 0 }];
  }

  /**
   * Scratch surface the flattened eraser preview is assembled on.
   *
   * On the SAME window as the display surfaces, not board-sized: it is blitted
   * into viewCtx and has the preview mask (topCanvas, or a remote user's own
   * board) blitted into it, and a surface-to-surface blit is only 1:1 when both
   * sides hold the same device pixels. Following the window also takes a
   * board-sized canvas out of the census for free.
   * @private
   */
  _getEraserPreviewBuffer() {
    if (!this._eraserPreviewCanvas) {
      this._eraserPreviewCanvas = document.createElement('canvas');
      this._eraserPreviewCtx = this._eraserPreviewCanvas.getContext('2d');
    }
    const win = getSurfaceWindow();
    sizeWindowedSurface(this._eraserPreviewCanvas, win);
    // Unconditionally, not only after a re-allocation: this context is not one
    // of the ones _applySurfaceWindow re-points, so a window that merely moved
    // would leave it on the previous origin.
    applyWindowTransform(this._eraserPreviewCtx, win);
    return { canvas: this._eraserPreviewCanvas, ctx: this._eraserPreviewCtx };
  }

  _applyEraserPreviewToMain(splitLayer, dirtyRects, userId = this.app?.self?.id ?? 0, maskCanvas = this.topCanvas, opacity = 1.0) {
    const { canvas: tempCanvas, ctx: tempCtx } = this._getEraserPreviewBuffer();

    this._clearCompositeContext(tempCtx, dirtyRects);
    const layerBackground = splitLayer === 0 ? this.getCompositeBackgroundColor() : null;
    this.layerManager.compositeLayerWithoutActiveStroke(tempCtx, splitLayer, userId, layerBackground, dirtyRects);

    if (splitLayer === 0) {
      this._clearCompositeContext(this.viewCtx, dirtyRects);
      const [r, g, b, a] = this.getCompositeBackgroundColor();
      this.viewCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      this._fillCompositeContext(this.viewCtx, dirtyRects);
    } else {
      this.layerManager.compositeLayerRange(this.viewCtx, 0, splitLayer, this.getCompositeBackgroundColor(), dirtyRects);
    }

    if (maskCanvas) {
      tempCtx.save();
      tempCtx.globalCompositeOperation = 'destination-out';
      tempCtx.globalAlpha = 1.0;
      this._drawCompositeCanvas(tempCtx, maskCanvas, dirtyRects);
      tempCtx.restore();
    }

    this.viewCtx.globalCompositeOperation = 'source-over';
    this.viewCtx.globalAlpha = 1.0;
    this._drawCompositeCanvas(this.viewCtx, tempCanvas, dirtyRects);
  }

  /**
   * Blit one window-aligned surface onto another.
   *
   * Both sides are on the shared surface window, so their pixels already
   * correspond one for one and the copy belongs in DEVICE space. Drawing it
   * under the destination's board-space transform would scale the source — whose
   * pixels are device pixels already — by the window scale a second time.
   * `save`/`restore` around the identity transform puts the window transform
   * back for whatever draws next.
   * @private
   */
  _drawCompositeCanvas(ctx, canvas, dirtyRects) {
    if (!ctx || !canvas) return;
    const win = getSurfaceWindow();
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (dirtyRects && dirtyRects.length > 0) {
        for (const rect of dirtyRects) {
          const sourceRect = clampDeviceRect(boardRectToDevice(rect, win), canvas);
          if (!sourceRect) continue;
          ctx.drawImage(
            canvas,
            sourceRect.x,
            sourceRect.y,
            sourceRect.width,
            sourceRect.height,
            sourceRect.x,
            sourceRect.y,
            sourceRect.width,
            sourceRect.height
          );
        }
        return;
      }
      ctx.drawImage(canvas, 0, 0);
    } finally {
      ctx.restore();
    }
  }

  _compositeUpperLayers(startIdx, endIdx, dirtyRects) {
    if (!this.upperLayersCtx) return;

    // Nothing to draw above the split — either the range is empty (drawing on
    // the topmost layer) or every layer in it is untouched, which is the usual
    // shape of a board: content on layer 0, empty layers above it.
    //
    // This used to hand that range to compositeLayerRange regardless, which
    // full-board clearRect'd this canvas and composited nothing into it on
    // every frame of every stroke, AND kept a board-sized canvas in the
    // compositor's blend tree to show the nothing. Stubbing the whole call out
    // measured +14 % fps on the eraser, which composites every tick; clipping
    // it to dirty rects did not, because the cost was the canvas being touched
    // and present at all rather than the area covered. Once it is clear it
    // stays clear, so only the transition needs work.
    if (endIdx <= startIdx || !this.layerManager.rangeHasRenderableContent(startIdx, endIdx)) {
      if (this._upperLayersCompositeStart !== null) {
        this._clearCompositeContext(this.upperLayersCtx, null);
        this._upperLayersCompositeStart = null;
        this._upperLayersCompositeEnd = null;
      }
      this._setLayerPresent(this.upperLayersCanvas, false);
      return;
    }

    // A dirty rect is only valid if this canvas already holds a composite of
    // the SAME layer range; when the split moves, everything outside the rects
    // is stale and the whole canvas has to be rebuilt. That is exactly the rule
    // _getSplitMainDirtyRects applies to viewCanvas — this passed a hardcoded
    // null instead, so every composite during a stroke did a full-board clear
    // plus a full-board re-composite of the upper layers. The eraser made that
    // expensive by composting on every tick rather than on commit.
    const sameRange = this._upperLayersCompositeStart === startIdx &&
      this._upperLayersCompositeEnd === endIdx;

    this.layerManager.compositeLayerRange(
      this.upperLayersCtx,
      startIdx,
      endIdx,
      null,
      sameRange ? dirtyRects : null
    );
    this._upperLayersCompositeStart = startIdx;
    this._upperLayersCompositeEnd = endIdx;
    this._setLayerPresent(this.upperLayersCanvas, true);
  }

  _clearUpperLayers(dirtyRects) {
    if (!this.upperLayersCtx) return;
    if (this._upperLayersCompositeStart !== null) {
      this._clearCompositeContext(this.upperLayersCtx, null);
    } else {
      this._clearCompositeContext(this.upperLayersCtx, dirtyRects);
    }
    this._upperLayersCompositeStart = null;
    this._upperLayersCompositeEnd = null;
    this._setLayerPresent(this.upperLayersCanvas, false);
  }

  // Both helpers funnel through _cullToView because between them they produce
  // every rect set that reaches viewCanvas from compositeAllLayers — including
  // the `null` "redraw everything" they return when the composite range
  // changes, which is exactly the case culling saves the most on.
  _getSplitMainDirtyRects(endIdx, dirtyRects) {
    if (this._mainCompositeEnd !== endIdx) {
      this._mainCompositeEnd = endIdx;
      return this._cullToView(null);
    }
    return this._cullToView(dirtyRects);
  }

  _getFullMainDirtyRects(dirtyRects) {
    const needsFullRedraw = this._mainCompositeEnd !== null;
    this._mainCompositeEnd = null;
    return this._cullToView(needsFullRedraw ? null : dirtyRects);
  }

  /**
   * Whether the live preview surface (topCanvas, and each remote user's board)
   * currently sits directly above `layerIdx` in the paint order.
   *
   * While someone is drawing, `compositeAllLayers` splits the stack: viewCanvas
   * takes 0..splitLayer, the preview surfaces paint over it, and
   * upperLayersCanvas paints over them. So a preview drawn for `layerIdx` is in
   * the right place only when the split lands on that same layer — otherwise
   * viewCanvas is holding layers above `layerIdx` and the preview would cover
   * content that should occlude it. An active selection or fill preview moves
   * the split somewhere else, which is exactly when that goes wrong.
   *
   * @param {number} layerIdx - Layer the preview belongs to.
   * @returns {boolean}
   */
  previewSurfaceSitsAboveLayer(layerIdx) {
    if (this.activeSelectionLayer >= 0) return false;
    if (this.activeFillPreviewLayer >= 0) return false;
    return (this.app?.self?.activeLayer ?? 0) === layerIdx;
  }

  _findActiveEraserPreview() {
    const layerCount = this.layerManager?.getLayerCount?.() ?? 0;
    const localUserId = this.app?.self?.id;
    const eraserTool = this.app?.toolManager?.getTool?.('erase');

    for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
      const group = this.layerManager.getLayerGroup(layerIndex);
      if (!group?.activeStrokeByUser) continue;

      for (const [userId, active] of group.activeStrokeByUser.entries()) {
        if (active?.blendMode !== 'destination-out') continue;

        const user = this.app?.users?.get?.(userId);
        if (user?.tool && user.tool !== 'erase') continue;

        // Single-layer erasers now render as per-user destination-out preview
        // strokes inside the normal layer composite (so multiple simultaneous
        // erasers no longer flicker). Only erase-all-layers still needs this
        // flattened global preview pass.
        const isAllLayers = userId === localUserId
          ? (this.app?.eraseAllLayers ?? false)
          : (user?.eraseAllLayers ?? false);
        if (!isAllLayers) continue;

        const strokeState = eraserTool?._getStrokeState?.(user) ?? user?._eraserStrokeState ?? null;
        // A remote user's own board canvas is the exact analogue of topCanvas:
        // EraserTool.drawPreview paints the mask into it at the stroke opacity,
        // mirror reflections included. The raw maskCanvas is the fallback, but
        // it carries neither the opacity nor the reflections, so prefer the
        // painted surface — it used to prefer a `previewCanvas` that this tool
        // no longer keeps, since re-tinting an alpha-only mask was dead work.
        const maskCanvas = userId === localUserId
          ? this.topCanvas
          : user?.context?.canvas ?? strokeState?.maskCanvas;

        if (!maskCanvas) continue;

        return {
          layerIndex,
          userId,
          maskCanvas,
          strokeState,
          opacity: user?.opacity ?? active.opacity ?? 1.0,
          eraseAllLayers: user?.eraseAllLayers ?? false
        };
      }
    }

    return null;
  }

  /**
   * Expand the dirty rectangle for a user's active stroke so the stroke
   * bake step can crop to a tight content bound.
   */
  expandDirtyRect(user, x, y, width, height, layerIndex) {
    if (!this.layerManager) return;
    // Prefer the explicit layer the active stroke was begun on. Selection
    // commit/stamp/fill begin their stroke on a layer derived from the message
    // (`ly`), which can differ from `user.activeLayer` (e.g. replay bots whose
    // active layer was never synced via a CL message). Falling back to
    // user.activeLayer would expand the wrong layer's dirty rect and the bake
    // step would discard the stroke as empty.
    const activeLayer = layerIndex ?? user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const group = this.layerManager.layerGroups[activeLayer];
    if (!group) return;
    const active = group.activeStrokeByUser.get(userId);
    if (!active || !active.dirtyRect) return;
    this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);
    this.compositeTileGrid?.markRect(x, y, width, height);
  }

  /**
   * Expand per-stroke bounds along a path and mark occupied tiles for sync.
   */
  markDirtyPath(user, points, radius, isErase = false) {
    if (!this.layerManager || !points || points.length === 0) return;

    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const group = this.layerManager.layerGroups[activeLayer];
    if (!group) return;

    const active = group.activeStrokeByUser.get(userId);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    if (active?.dirtyRect) {
      for (const pt of points) {
        const x = pt.x - radius;
        const y = pt.y - radius;
        const size = radius * 2;
        this.layerManager._expandDirtyRect(active.dirtyRect, x, y, size, size);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + size > maxX) maxX = x + size;
        if (y + size > maxY) maxY = y + size;
      }
    }
    if (maxX > minX && maxY > minY) {
      this.compositeTileGrid?.markRect(minX, minY, maxX - minX, maxY - minY);
    }
  }

  /**
   * Expand per-stroke bounds for all layers' active strokes for a user.
   */
  expandDirtyRectAllLayers(user, x, y, width, height) {
    if (!this.layerManager) return;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      const group = this.layerManager.layerGroups[i];
      if (!group) continue;
      const active = group.activeStrokeByUser.get(userId);
      if (!active || !active.dirtyRect) continue;
      this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);
    }
    this.compositeTileGrid?.markRect(x, y, width, height);
  }

  /**
   * Cancel the current stroke for a user.
   * @param {Object} user - User object
   */
  cancelStroke(user) {
    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;
    this.layerManager.cancelUserStroke(activeLayer, userId);
    this.requestUpdate();
  }

  /**
   * Undo the most recent stroke for userId across all layers.
   * @param {number} _layerIndex - Unused; kept for compatibility
   * @param {number} userId - User ID
   * @param {number} [targetSeq=0] - Undo the stroke with this authoritative seq
   *   rather than resolving "the latest" locally. See undoLastStrokeGlobal.
   */
  undo(_layerIndex, userId, targetSeq = 0) {
    if (!this.layerManager) return null;
    const batch = this.layerManager.undoLastStrokeGlobal(userId, targetSeq);
    let tilesToRecheck = null;
    let needsFullRedraw = false;

    if (batch) {
      this.layerManager._pushToRedoStack(userId, batch);
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          const rd = record.selectionRestoreData;
          // If the paired lift erase is still live in stroke history, removing it is
          // enough to reveal the original pixels again. Only paint the saved snapshot
          // back when that erase has already been baked into base bins/sequences.
          const removedLiveErase = rd.eraseTimestamp !== undefined
            ? this._takeSelectionEraseStroke(rd.eraseUserId ?? userId, rd.eraseTimestamp)
            : null;
          if (removedLiveErase) {
            rd._redoEraseRecord = removedLiveErase;
          } else {
            this._applySelectionRestore(rd.snapshots);
          }
          this._markSelectionRestoreDirtyRects(rd);
          break;
        }
        if (record.affectedTiles) {
          if (!tilesToRecheck) tilesToRecheck = new Set();
          for (const idx of record.affectedTiles) tilesToRecheck.add(idx);
        }
      }
    }

    if (!batch) {
      return null;
    }
    this._markBatchDirtyRects(batch);
    this.compositeAllLayers();

    if (tilesToRecheck && this.tileTracker) {
      this.checkErasedTilesByIndices(tilesToRecheck, userId === this.app?.self?.id);
    }

    return batch;
  }

  /** No-op: occupancy tracking has been disabled. */
  addOccupancyForTilesInRect() {}

  /** No-op: occupancy tracking has been disabled. */
  addOccupancyForVisibleTilesInRect() {}

  /**
   * Redo the most recently undone stroke batch for userId.
   * @param {number} userId - User ID
   */
  redo(userId) {
    if (!this.layerManager) return;
    const redoStack = this.layerManager.redoStackByUser.get(userId);
    let tilesToRecheck = null;
    let needsFullRedraw = false;
    let batch = null;

    if (redoStack && redoStack.length > 0) {
      batch = redoStack[redoStack.length - 1];
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          const rd = record.selectionRestoreData;
          if (rd._redoEraseRecord) {
            this._restoreSelectionEraseStroke(rd._redoEraseRecord);
            rd._redoEraseRecord = null;
          } else {
            this._applySelectionReErase(rd);
          }
          this._markSelectionRestoreDirtyRects(rd);
          break;
        }
        if (record.affectedTiles) {
          if (!tilesToRecheck) tilesToRecheck = new Set();
          for (const idx of record.affectedTiles) tilesToRecheck.add(idx);
        }
      }
    }
    this.layerManager.redoLastStroke(userId);

    if (!batch) {
      return;
    }
    this._markBatchDirtyRects(batch);
    this.compositeAllLayers();

    if (tilesToRecheck && this.tileTracker) {
      this.checkErasedTilesByIndices(tilesToRecheck, userId === this.app?.self?.id);
    }
  }

  /**
   * Apply pixel snapshots back to baseCanvas
   * @param {Array} snapshots - Array of snapshot data
   * @private
   */
  _applySelectionRestore(snapshots) {
    if (!snapshots) return;
    const lm = this.layerManager;
    for (const { groupIdx, canvas, x, y } of snapshots) {
      const group = lm.layerGroups[groupIdx];
      if (!group) continue;
      lm.addToBaseBin(groupIdx, canvas, x, y, 'source-over');
    }
    lm._notifyHistoryPanel();
  }

  /**
   * Remove the destination-out erase stroke that was paired with a selection commit,
   * identified by userId + timestamp. Called during undo so the restored pixels aren't
   * immediately re-erased by the lingering erase stroke.
   * @param {number} userId - User ID
   * @param {number} eraseTimestamp - Timestamp of the erase stroke to remove
   * @private
   */
  _takeSelectionEraseStroke(userId, eraseTimestamp) {
    const lm = this.layerManager;
    for (let groupIdx = 0; groupIdx < lm.layerGroups.length; groupIdx++) {
      const group = lm.layerGroups[groupIdx];
      for (let i = group.strokeStack.length - 1; i >= 0; i--) {
        const s = group.strokeStack[i];
        if (s.userId === userId && s.timestamp === eraseTimestamp && s.isSelectionErase) {
          group.strokeStack.splice(i, 1);
          const cnt = group.userStrokeCounts.get(userId) || 0;
          if (cnt > 0) group.userStrokeCounts.set(userId, cnt - 1);
          return { groupIdx, record: s };
        }
      }
    }
    return null;
  }

  _restoreSelectionEraseStroke(eraseStrokeEntry) {
    const lm = this.layerManager;
    const group = lm?.layerGroups?.[eraseStrokeEntry?.groupIdx];
    const record = eraseStrokeEntry?.record;
    if (!group || !record) return false;

    let insertIdx = group.strokeStack.length;
    for (let i = 0; i < group.strokeStack.length; i++) {
      if (group.strokeStack[i].timestamp > record.timestamp) {
        insertIdx = i;
        break;
      }
    }
    group.strokeStack.splice(insertIdx, 0, record);
    const cnt = group.userStrokeCounts.get(record.userId) || 0;
    group.userStrokeCounts.set(record.userId, cnt + 1);
    return true;
  }

  /**
   * Re-apply the erase to baseCanvas
   * @param {Object} restoreData - Selection restore data
   * @private
   */
  _applySelectionReErase(restoreData) {
    const lm = this.layerManager;
    const { snapshots, eraseS: s, eraseLassoPath: lassoPath } = restoreData;
    for (const { groupIdx } of snapshots) {
      const group = lm.layerGroups[groupIdx];
      if (!group) continue;

      const eraserCanvas = document.createElement('canvas');
      eraserCanvas.width = s.width;
      eraserCanvas.height = s.height;
      const eCtx = eraserCanvas.getContext('2d');
      eCtx.fillStyle = 'white';
      eCtx.fillRect(0, 0, s.width, s.height);

      lm.eraseFromAllBaseBins(groupIdx, eraserCanvas, s.x, s.y, lassoPath);
    }
    lm._notifyHistoryPanel();
  }

  /**
   * Get the full layer group for the active layer
   * @returns {Object|undefined}
   */
  getActiveLayerGroup() {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    return this.layerManager?.getLayerGroup(activeLayer);
  }

  /**
   * Get the full layer group for a specific index
   * @param {number} index - Layer index
   * @returns {Object|undefined}
   */
  getLayerGroup(index) {
    return this.layerManager?.getLayerGroup(index);
  }

  /**
   * Composite all visible layers onto the main canvas.
   */
  compositeAllLayers() {
    if (!this.layerManager) return;

    const activeLayerIdx = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    const totalLayers = this.layerManager.getLayerCount();
    const activeGroup = this.layerManager.getLayerGroup(activeLayerIdx);
    const isDrawing = activeGroup?.activeStrokeByUser?.has(userId) ?? false;
    const activeTool = this.app?.activeTool ?? this.app?.self?.tool;
    const isEraser = activeTool === 'erase';
    const eraseAll = isEraser && (this.app?.eraseAllLayers ?? false);
    const pendingDirtyRects = this.compositeTileGrid?.consumeDirtyRects?.() ?? null;
    const activeEraserPreview = this._findActiveEraserPreview();
    const activeEraserPreviewIsAllLayers = activeEraserPreview?.eraseAllLayers ?? false;
    const previewUsesFlattenedOverlay = !!activeEraserPreview && !activeEraserPreviewIsAllLayers;

    const hasActiveSelection = this.activeSelectionLayer >= 0;
    const hasFillPreview = this.activeFillPreviewLayer >= 0;
    const splitLayer = hasActiveSelection
      ? this.activeSelectionLayer
      : (hasFillPreview ? this.activeFillPreviewLayer : ((previewUsesFlattenedOverlay ? activeEraserPreview?.layerIndex : null) ?? activeLayerIdx));
    const dirtyRects = Array.isArray(pendingDirtyRects) && pendingDirtyRects.length > 0
      ? this._prepareCompositeRects(pendingDirtyRects)
      : null;

    if (this.onCompositeDirtyRects) {
      const isFullRedraw = pendingDirtyRects === null;
      this.onCompositeDirtyRects(dirtyRects, isFullRedraw);
    }

    if (Array.isArray(pendingDirtyRects) &&
        pendingDirtyRects.length === 0 &&
        !this.layerManager.needsComposite &&
        !isDrawing &&
        !activeEraserPreview &&
        !hasActiveSelection) {
      this.layerManager.needsComposite = false;
      this.layerManager._notifyStrokeHistoryPanel();
      return;
    }

    if ((isDrawing && eraseAll) || activeEraserPreviewIsAllLayers) {
      const mainDirtyRects = this._getFullMainDirtyRects(dirtyRects);
      this._fillBackgroundLayers(mainDirtyRects);
      this.layerManager.compositeLayerRange(this.viewCtx, 0, totalLayers, this.getCompositeBackgroundColor(), mainDirtyRects);

      this.viewCtx.globalCompositeOperation = 'destination-out';
      this.viewCtx.globalAlpha = 1.0;
      this._drawCompositeCanvas(this.viewCtx, activeEraserPreview?.maskCanvas ?? this.topCanvas, mainDirtyRects);

      this.viewCtx.globalCompositeOperation = 'source-over';
      this.viewCtx.globalAlpha = 1.0;

      this._clearUpperLayers(mainDirtyRects);
    }
    else if (
      (isDrawing || previewUsesFlattenedOverlay || hasActiveSelection || hasFillPreview) &&
      splitLayer + 1 < totalLayers
    ) {
      if (previewUsesFlattenedOverlay) {
        const mainDirtyRects = this._getSplitMainDirtyRects(splitLayer + 1, dirtyRects);
        this._applyEraserPreviewToMain(
          splitLayer,
          mainDirtyRects,
          activeEraserPreview.userId,
          activeEraserPreview.maskCanvas,
          activeEraserPreview.opacity
        );
      } else {
        const mainDirtyRects = this._getSplitMainDirtyRects(splitLayer + 1, dirtyRects);
        this._fillBackgroundLayers(mainDirtyRects);
        this.layerManager.compositeLayerRange(this.viewCtx, 0, splitLayer + 1, this.getCompositeBackgroundColor(), mainDirtyRects);

        if (isDrawing) {
          // The local live preview stays on topCanvas, where CSS mix-blend-mode
          // provides the live blend preview. Copying it into viewCanvas here
          // leaves a stale blended snapshot behind until the next composite,
          // which shows up as a doubled first mark at stroke start.
          this.viewCtx.globalCompositeOperation = 'source-over';
          this.viewCtx.globalAlpha = 1.0;
        }
      }

      this._compositeUpperLayers(splitLayer + 1, totalLayers, dirtyRects);
    } else {
      const mainDirtyRects = this._getFullMainDirtyRects(dirtyRects);
      if (previewUsesFlattenedOverlay) {
        this._applyEraserPreviewToMain(
          splitLayer,
          mainDirtyRects,
          activeEraserPreview.userId,
          activeEraserPreview.maskCanvas,
          activeEraserPreview.opacity
        );
      } else {
        this._fillBackgroundLayers(mainDirtyRects);
        this.layerManager.compositeLayerRange(this.viewCtx, 0, totalLayers, this.getCompositeBackgroundColor(), mainDirtyRects);

        if (isDrawing) {
          // The local live preview stays on topCanvas, where CSS mix-blend-mode
          // provides the live blend preview. Copying it into viewCanvas here
          // leaves a stale blended snapshot behind until the next composite,
          // which shows up as a doubled first mark at stroke start.
          this.viewCtx.globalCompositeOperation = 'source-over';
          this.viewCtx.globalAlpha = 1.0;
        }
      }

      this._clearUpperLayers(mainDirtyRects);
    }

    this._updateDisplayProxy();

    this.layerManager.needsComposite = false;
    this.layerManager._notifyStrokeHistoryPanel();
  }

  /**
   * Request a composite update on the next animation frame.
   */
  /**
   * Set the target render FPS.
   * 0 = uncapped (on-demand RAF, original behaviour).
   * Any positive value starts a persistent RAF loop capped to that rate.
   * @param {number} fps
   */
  setTargetFPS(fps) {
    this.targetFPS = fps;
    if (fps > 0) {
      this._startRenderLoop();
    } else {
      this._stopRenderLoop();
    }
  }

  /**
   * Starts a persistent RAF loop that composites at most targetFPS times/sec.
   * @private
   */
  _startRenderLoop() {
    if (this._rafLoopId !== null) return;
    const loop = (time) => {
      this._rafLoopId = requestAnimationFrame(loop);
      if (!this._needsComposite) return;
      const minInterval = 1000 / this.targetFPS;
      if (time - this._lastCompositeTime < minInterval) return;
      // Skip this frame if message processing just ran — let it composite next tick.
      const lastProcEnd = this.app?.wsClient?._lastProcessingFrameEnd;
      if (lastProcEnd && performance.now() - lastProcEnd < 2) return;
      this._needsComposite = false;
      this._lastCompositeTime = time;
      this.compositeAllLayers();
    };
    this._rafLoopId = requestAnimationFrame(loop);
  }

  /**
   * Stops the persistent RAF loop.
   * @private
   */
  _stopRenderLoop() {
    if (this._rafLoopId !== null) {
      cancelAnimationFrame(this._rafLoopId);
      this._rafLoopId = null;
    }
  }

  /**
   * Request a composite on the next animation frame.
   * When a target FPS is set the persistent loop handles this automatically.
   * When uncapped, schedules a one-shot RAF as before.
   */
  requestUpdate() {
    this._needsComposite = true;
    if (this.targetFPS === 0 && !this._compositeScheduled) {
      this._compositeScheduled = true;
      requestAnimationFrame(() => this._performScheduledComposite());
    }
  }

  /**
   * One-shot RAF callback used in uncapped mode.
   * @private
   */
  _performScheduledComposite() {
    // If message processing ran in this same RAF batch, defer the composite
    // to the next frame to avoid stacking 10–20ms of work into one frame.
    const lastProcEnd = this.app?.wsClient?._lastProcessingFrameEnd;
    if (lastProcEnd && performance.now() - lastProcEnd < 2) {
      requestAnimationFrame(() => this._performScheduledComposite());
      return;
    }

    this._compositeScheduled = false;
    if (this._needsComposite) {
      this._needsComposite = false;
      this._lastCompositeTime = performance.now();
      this.compositeAllLayers();
    }
  }

  /**
   * Clear the preview (top) canvas and selection overlay
   */
  clearTop(rect = null) {
    const [height, width] = this.dimensions;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0) {
      const x = Math.max(0, Math.floor(rect.x));
      const y = Math.max(0, Math.floor(rect.y));
      const right = Math.min(width, Math.ceil(rect.x + rect.width));
      const bottom = Math.min(height, Math.ceil(rect.y + rect.height));
      if (right > x && bottom > y) {
        this.topCtx.clearRect(x, y, right - x, bottom - y);
      }
      return;
    }

    this.topCtx.clearRect(0, 0, width, height);
    if (this.topCanvas.style.opacity !== '') this.topCanvas.style.opacity = '';
    this.clearSelectionOverlay();
    if (this.selectionMask && !this._maskManagedBySelectTool) {
      this.drawMaskDarkenOverlay(0);
    }
  }

  /**
   * Clear the selection overlay canvas
   */
  clearSelectionOverlay() {
    if (this.selectionCtx) {
      const pad = this.selectionOverlayPadding;
      // One frame of hysteresis: collapse only if nothing asked for the overlay
      // since the previous clear, so an active selection that clears and
      // redraws every frame never reallocates.
      if (!this._selectionOverlayUsed && this.selectionOverlay?.width > 1) {
        this._sizeOverlayCanvas(this.selectionOverlay, pad, false);
      } else {
        this.selectionCtx.clearRect(0, 0, this.dimensions[1] + pad * 2, this.dimensions[0] + pad * 2);
      }
      this._selectionOverlayUsed = false;
    }
    this.clearHandleOverlay();
  }

  /**
   * Clear the screen-space handle overlay canvas.
   */
  clearHandleOverlay() {
    if (this.handleCtx) {
      this.handleCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.handleCtx.clearRect(0, 0, this.handleOverlay.width, this.handleOverlay.height);
    }
  }

  /**
   * Get the screen-space handle overlay context, sized to the container at the
   * current device pixel ratio and transformed so drawing happens in CSS pixels
   * using container-relative coordinates (see boardToContainerPos). Does not clear
   * — clearHandleOverlay() runs via clearSelectionOverlay() on each full clearTop.
   * @returns {CanvasRenderingContext2D|null}
   */
  getHandleCtx() {
    if (!this.handleCtx) return null;
    const rect = this._getContainerRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = rect.width;
    const cssH = rect.height;
    if (this._handleOverlayCssW !== cssW || this._handleOverlayCssH !== cssH || this._handleOverlayDpr !== dpr) {
      this.handleOverlay.style.width = `${cssW}px`;
      this.handleOverlay.style.height = `${cssH}px`;
      this.handleOverlay.width = Math.max(1, Math.round(cssW * dpr));
      this.handleOverlay.height = Math.max(1, Math.round(cssH * dpr));
      this._handleOverlayCssW = cssW;
      this._handleOverlayCssH = cssH;
      this._handleOverlayDpr = dpr;
    }
    this.handleCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return this.handleCtx;
  }

  /**
   * Transforms board-space coordinates to container-space (untransformed screen)
   * coordinates — the inverse of getBoardRelativePos. Accounts for flip, zoom,
   * rotation and pan. Used to position handles on the screen-space overlay.
   * @param {number} bx - Board X
   * @param {number} by - Board Y
   * @returns {{x: number, y: number}} Container-relative pixel coordinates
   */
  boardToContainerPos(bx, by) {
    let x = bx;
    if (this.canvasFlipped) {
      x = this.getWidth() - x;
    }
    const rx = x * this.zoom;
    const ry = by * this.zoom;
    const rad = this.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
      x: rx * cos - ry * sin + this.panX,
      y: rx * sin + ry * cos + this.panY
    };
  }

  /**
   * Add or remove a board-sized layer from the compositing tree.
   *
   * Sibling to _sizeOverlayCanvas, for layers whose dimensions must stay board-
   * sized (something else draws into them at board coordinates) but which are
   * empty most of the time. `display: none` takes the layer out of the blend
   * tree entirely; `visibility: hidden` and `opacity: 0` do not — the compositor
   * keeps the layer alive and can still pay its area per frame.
   *
   * Writes are guarded so this stays cheap enough to call from render paths.
   *
   * @param {HTMLElement} el
   * @param {boolean} present - Whether the layer currently has content to show.
   * @returns {void}
   * @private
   */
  _setLayerPresent(el, present) {
    if (!el) return;
    // `data-force-hidden` marks a layer that something else owns the hiding of
    // (the time machine swapping the live board out for the replay canvas).
    // Content-driven presence must never override that and reveal a live layer
    // over the top of it.
    const next = (present && el.dataset?.forceHidden !== '1') ? '' : 'none';
    if (el.style.display === next) return;
    el.style.display = next;
  }

  /**
   * Size an overlay canvas to the board plus its padding, or collapse it to 1x1
   * when it has nothing to show.
   *
   * These overlays are board-sized PLUS a 500px pad on every side, which more
   * than doubles their area — at 1440p that is 33MB each, and both sit in the
   * live compositing tree as `display:block` whether or not anything is drawn
   * on them. They are empty in the overwhelmingly common case (no selection,
   * no interaction blocks), so they are inflated on first use and collapsed
   * again once they go idle. Assigning width/height also clears the canvas and
   * resets context state, which is fine: every consumer clears and redraws in
   * full on each render.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {number} pad - Padding applied on every side, in board pixels.
   * @param {boolean} needed - Whether the overlay currently has content.
   * @returns {boolean} True if the canvas is now at full size.
   * @private
   */
  _sizeOverlayCanvas(canvas, pad, needed) {
    if (!canvas) return false;
    const [height, width] = this.dimensions;
    const targetW = needed ? width + pad * 2 : 1;
    const targetH = needed ? height + pad * 2 : 1;
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      // Assigning width/height resets the 2D context to spec defaults, which
      // drops the pixelated/smoothing mode updateHighZoomRenderingMode() set.
      // Re-apply it so an overlay inflated while zoomed in stays crisp.
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const crisp = this._lastHighZoomCrisp === true;
        ctx.imageSmoothingEnabled = !crisp;
        if ('imageSmoothingQuality' in ctx) {
          ctx.imageSmoothingQuality = crisp ? 'low' : 'high';
        }
      }
    }
    // The pad is applied as a negative CSS offset so board (0,0) stays put; a
    // collapsed canvas must not keep that offset or the stray 1px would sit
    // outside the board.
    const offset = needed ? -pad : 0;
    canvas.style.left = `${offset}px`;
    canvas.style.top = `${offset}px`;
    return needed;
  }

  /** Inflate the selection overlay to full size, if it is collapsed. @private */
  _ensureSelectionOverlaySized() {
    this._selectionOverlayUsed = true;
    this._sizeOverlayCanvas(this.selectionOverlay, this.selectionOverlayPadding, true);
  }

  /**
   * Get the selection overlay context with padding offset applied.
   * Call save() before and restore() after drawing.
   * @returns {CanvasRenderingContext2D|null}
   */
  getSelectionCtx() {
    if (!this.selectionCtx) return null;
    this._ensureSelectionOverlaySized();
    this.selectionCtx.save();
    this.selectionCtx.translate(this.selectionOverlayPadding, this.selectionOverlayPadding);
    return this.selectionCtx;
  }

  /**
   * Restore the selection overlay context after drawing
   */
  restoreSelectionCtx() {
    if (this.selectionCtx) {
      this.selectionCtx.restore();
    }
  }

  /**
   * Get board width
   * @returns {number}
   */
  getWidth() {
    return this.dimensions[1];
  }

  /**
   * Get board height
   * @returns {number}
   */
  getHeight() {
    return this.dimensions[0];
  }

  /**
   * How long the full raster is kept alive after the last holder releases it.
   *
   * Long enough to cover a burst — a flood fill followed by the export the user
   * came for, a checkpoint landing on top of a tape capture — because
   * allocating a board-sized canvas is the operation measured to stall (see
   * userLayerPresence: a fresh 8k canvas per frame took 180 fps to 92 with JS
   * self-time flat). Short enough that a board-sized surface does not sit
   * around for a session's worth of idling, which is the whole point of not
   * keeping viewCanvas board-sized.
   */
  static FULL_RASTER_IDLE_MS = 10000;

  /**
   * A board-sized, 1:1 raster of the entire board.
   *
   * For the readers that genuinely need every pixel — flood fill's seed scan,
   * export, blur snapshots, replay checkpoints — as opposed to the pixels
   * currently on screen. The board is bounded, so this always exists and is
   * always finite; it is simply not something to keep permanently resident.
   *
   * Composited from the LAYER STACK, never downscaled or copied from
   * viewCanvas. viewCanvas is the surface that may be culled or windowed, so it
   * is exactly the wrong source for the thing whose job is to be correct
   * everywhere — the same reasoning _updateDisplayProxy already documents.
   *
   * Re-composited on every acquire rather than cached against a dirty flag:
   * every consumer is one-shot and user-initiated (a pointerdown, a save, a
   * capture tick), so the simple thing is also the correct thing. The canvas
   * itself IS pooled across acquires — that is the part that costs.
   *
   * Balance every call with releaseFullRaster(), or use withFullRaster().
   *
   * @param {Object} [options]
   * @param {boolean} [options.background=true] - Paint the room background
   *   underneath. False yields the transparent-PNG composite.
   * @returns {HTMLCanvasElement|null}
   */
  getFullRaster({ background = true } = {}) {
    if (!this.layerManager) return null;
    const [height, width] = this.dimensions;
    if (!(width > 0) || !(height > 0)) return null;

    if (this._fullRasterFreeTimer !== null) {
      clearTimeout(this._fullRasterFreeTimer);
      this._fullRasterFreeTimer = null;
    }

    if (!this._fullRasterCanvas ||
        this._fullRasterCanvas.width !== width ||
        this._fullRasterCanvas.height !== height) {
      this._fullRasterCanvas = document.createElement('canvas');
      this._fullRasterCanvas.width = width;
      this._fullRasterCanvas.height = height;
      // Its consumers are getImageData-heavy and one-shot (three separate
      // whole-board reads in the flood fill alone), which is the opposite of
      // viewCanvas's per-frame profile — so unlike viewCanvas this one does
      // want the software path.
      this._fullRasterCtx = this._fullRasterCanvas.getContext('2d', { willReadFrequently: true });
    }

    this._fullRasterHolders++;

    // compositeLayerRange clears layerManager.needsComposite as a side effect,
    // and this runs outside a composite; swallowing a pending recomposite would
    // leave viewCanvas stale until something else dirtied it.
    const pendingComposite = this.layerManager.needsComposite;
    const ctx = this._fullRasterCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);
    try {
      this.layerManager.compositeLayerRange(
        ctx,
        0,
        this.layerManager.getLayerCount(),
        background ? this.getCompositeBackgroundColor() : null,
        null
      );
    } finally {
      this.layerManager.needsComposite = pendingComposite;
    }

    return this._fullRasterCanvas;
  }

  /** Undo one `getFullRaster`; the canvas is freed after an idle delay. */
  releaseFullRaster() {
    this._fullRasterHolders = Math.max(0, this._fullRasterHolders - 1);
    if (this._fullRasterHolders > 0) return;
    if (this._fullRasterFreeTimer !== null) clearTimeout(this._fullRasterFreeTimer);
    this._fullRasterFreeTimer = setTimeout(() => {
      this._fullRasterFreeTimer = null;
      if (this._fullRasterHolders > 0) return;
      this._fullRasterCanvas = null;
      this._fullRasterCtx = null;
    }, Board.FULL_RASTER_IDLE_MS);
  }

  /**
   * Run `fn` with the full raster, releasing it even if `fn` throws.
   * @param {(canvas: HTMLCanvasElement) => any} fn
   * @param {Object} [options] - Passed through to getFullRaster.
   * @returns {any} whatever `fn` returned, or null if no raster was available.
   */
  withFullRaster(fn, options) {
    const canvas = this.getFullRaster(options);
    if (!canvas) return null;
    try {
      return fn(canvas);
    } finally {
      this.releaseFullRaster();
    }
  }

  /**
   * The RGBA the display surface is showing at a board point, or null if that
   * point is not on the surface.
   *
   * `getImageData` ignores the context transform, so board coordinates have to
   * be mapped into the surface's own device pixels by hand. The eyedropper runs
   * this on every pointer move, which rules out the full raster — and sampling
   * what is displayed is what an eyedropper means anyway.
   *
   * @param {number} boardX
   * @param {number} boardY
   * @returns {Uint8ClampedArray|null}
   */
  sampleViewPixel(boardX, boardY) {
    if (!this.viewCtx || !this.viewCanvas) return null;
    const win = getSurfaceWindow();
    const x = Math.floor((boardX - win.x) * win.scale);
    const y = Math.floor((boardY - win.y) * win.scale);
    if (x < 0 || y < 0 || x >= this.viewCanvas.width || y >= this.viewCanvas.height) return null;
    return this.viewCtx.getImageData(x, y, 1, 1).data;
  }

  /**
   * `getImageData` over the board, taken from a fresh full-board composite.
   *
   * The replacement for the `ensureFullComposite(); viewCtx.getImageData(...)`
   * pair that flood fill and the fill handlers used: same result, but sourced
   * from the layer stack rather than from whatever the display surface happens
   * to be holding.
   *
   * @param {number} [x=0]
   * @param {number} [y=0]
   * @param {number} [width=board width]
   * @param {number} [height=board height]
   * @returns {ImageData|null}
   */
  getFullBoardImageData(x = 0, y = 0, width = this.getWidth(), height = this.getHeight()) {
    return this.withFullRaster(() => this._fullRasterCtx.getImageData(x, y, width, height));
  }

  /**
   * Returns a canvas representing the full board for export.
   * @param {boolean} transparent - If true, omits the background fill (transparent PNG).
   * @returns {HTMLCanvasElement}
   */
  getExportCanvas(transparent) {
    // Exporting: every pixel has to be current, including any the viewport was
    // not showing. Both branches now composite from the layer stack, so neither
    // depends on what viewCanvas happens to be holding — it used to hand back
    // viewCanvas itself on this path, which defeated the caller's own
    // `if (!canvas) ensureFullComposite()` guard.
    //
    // A caller-owned canvas rather than the pooled full raster: the export
    // canvas outlives this call (toBlob, toDataURL, the save dialog's preview)
    // and there is no release point to hang a refcount on.
    const [height, width] = this.dimensions;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const pendingComposite = this.layerManager.needsComposite;
    try {
      this.layerManager.compositeLayerRange(
        canvas.getContext('2d'),
        0,
        this.layerManager.getLayerCount(),
        transparent ? null : this.getCompositeBackgroundColor()
      );
    } finally {
      this.layerManager.needsComposite = pendingComposite;
    }
    return canvas;
  }

  /**
   * Save the board as a PNG image
   */
  saveAsImage() {
    const dataURL = this.getExportCanvas(false).toDataURL();
    const link = document.createElement('a');
    link.download = `${new Date().toString().slice(0, 24)}.png`;
    link.href = dataURL;
    link.click();
  }

  /**
   * TileTracker has been stubbed out — per-tile pixel scans on every
   * undo/redo/commit were dragging down low-end machines for bookkeeping
   * nothing was actually reading. Left as a no-op so callers don't need
   * to change.
   */
  checkErasedTilesByIndices() {}

  /**
   * Captures each layer as a separate QOI-encoded image.
   * @returns {Uint8Array[]|null} Array of QOI blobs, one per layer
   */
  /**
   * True if decoded RGBA pixels contain a single non-transparent texel.
   *
   * Restoring a fully transparent layer is not free and not harmless: it
   * allocates a board-sized canvas and pushes a `bakedSequences` entry, and
   * `LayerManager.rangeHasRenderableContent` — which is structural, not
   * pixel-based — then reports that layer as OCCUPIED for the rest of the
   * session. Every optimisation keyed on that predicate silently stops firing:
   * the eraser's upper-layer composite skip, the glitch tool's per-stroke layer
   * filter. Since a QOI-encoded transparent layer is small but never
   * zero-length, the existing `qoi.length === 0` guard never catches this, so
   * EVERY joiner and every board resize was defeating them.
   *
   * Scans alpha only, 32 bits at a time where alignment allows.
   *
   * @param {Uint8Array} pixels - Decoded RGBA bytes.
   * @returns {boolean}
   * @private
   */
  _snapshotLayerHasPixels(pixels) {
    if (!pixels || pixels.length === 0) return false;
    if (pixels.byteOffset % 4 === 0 && pixels.length % 4 === 0) {
      const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length >> 2);
      // Little-endian RGBA puts alpha in the high byte; every platform this
      // runs on is little-endian, and the byte fallback below is exact anyway.
      for (let i = 0; i < words.length; i++) if (words[i] & 0xff000000) return true;
      return false;
    }
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) return true;
    return false;
  }

  getSnapshot() {
    if (!this.layerManager) return null;
    const [height, width] = this.dimensions;
    const layers = [];

    for (let i = 0; i < this.layerManager.layerGroups.length; i++) {
      const { canvas, ctx } = this.layerManager._createCanvas();
      ctx.clearRect(0,0,width,height);
      this.layerManager.compositeLayerRange(ctx, i, i + 1, null);
      const imageData = ctx.getImageData(0, 0, width, height);
      if (i === 0) {
        this._stripSnapshotBackground(imageData);
      }
      layers.push(wasm.qoi_encode(new Uint8Array(imageData.data.buffer), width, height));
    }

    return layers;
  }

  /**
   * Captures each layer as raw RGBA pixels for off-main-thread snapshot encoding.
   * The returned buffers are intended to be transferred to a worker.
   * @returns {{ width: number, height: number, layers: Uint8Array[], backgroundColor: * }|null}
   */
  getSnapshotPixels() {
    if (!this.layerManager) return null;
    const [height, width] = this.dimensions;
    const layers = [];

    for (let i = 0; i < this.layerManager.layerGroups.length; i++) {
      const { ctx } = this.layerManager._createCanvas();
      ctx.clearRect(0, 0, width, height);
      this.layerManager.compositeLayerRange(ctx, i, i + 1, null);
      const imageData = ctx.getImageData(0, 0, width, height);
      layers.push(new Uint8Array(imageData.data.buffer));
    }

    return {
      width,
      height,
      layers,
      backgroundColor: this.backgroundColor,
    };
  }

  /**
   * Captures the PERMANENT (baked) board state for a checkpoint/join snapshot:
   * each layer's baked content + confirmed strokes up to the baked watermark seq,
   * excluding the still-undoable live tail. The returned `snapshotSeq` is that
   * watermark, so the server replays everything after it as commands to a joiner
   * (preserving per-stroke blend mode + undo/redo) instead of baking it away.
   * Returns null if nothing has been baked yet (caller should skip the snapshot
   * and let joiners replay the full command tail).
   * @returns {{ width: number, height: number, layers: Uint8Array[], backgroundColor: *, snapshotSeq: number }|null}
   */
  async getCheckpointSnapshotPixels() {
    if (!this.layerManager) return null;
    const watermark = this.layerManager.getBakedWatermarkSeq?.() || 0;
    if (watermark <= 0) return null;

    const [height, width] = this.dimensions;
    const layers = [];
    let capturedAny = false;
    for (let i = 0; i < this.layerManager.layerGroups.length; i++) {
      // Skip unused layers (commonly 2 & 3): a zero-length layer costs no
      // composite or readback and is treated as transparent on restore + by the
      // parity reference. Most boards only draw on layer 1, so this typically
      // cuts the capture to a single layer.
      if (this.layerManager.isLayerEmptyThroughSeq(i, watermark)) {
        layers.push(new Uint8Array(0));
        continue;
      }
      // Spread the capture one real layer per frame: each layer's composite +
      // full-frame getImageData readback is ~7ms at 1080p, so doing them all in
      // one synchronous pass drops a frame or two and stutters whoever is
      // actively drawing when the server asks them for the periodic snapshot.
      // Yielding between captures lets the browser paint in between.
      if (capturedAny) await this._nextFramePixelYield();
      // A bake landing between yields would move strokes from the live stack
      // into flatCanvas and advance the watermark, so compositeBakedThroughSeq
      // for the original watermark would mix states across layers. Detect that
      // and abort — the next 15s auto-snapshot cycle retries from a stable base.
      if ((this.layerManager.getBakedWatermarkSeq?.() || 0) !== watermark) return null;
      const { ctx } = this.layerManager._createCanvas();
      ctx.clearRect(0, 0, width, height);
      this.layerManager.compositeBakedThroughSeq(ctx, i, watermark);
      const imageData = ctx.getImageData(0, 0, width, height);
      layers.push(new Uint8Array(imageData.data.buffer));
      capturedAny = true;
    }

    // watermark > 0 means something was baked, so at least one layer should have
    // captured. If none did (degenerate state), there's nothing to snapshot.
    if (!capturedAny) return null;

    return {
      width,
      height,
      layers,
      backgroundColor: this.backgroundColor,
      snapshotSeq: watermark,
    };
  }

  /**
   * Yield to the next animation frame so a multi-layer snapshot capture can be
   * spread across frames instead of blocking one. Falls back to a short timer so
   * a hidden/throttled tab (where rAF is paused) can't stall the capture and
   * wedge the auto-snapshot in-flight guard.
   * @returns {Promise<void>}
   * @private
   */
  _nextFramePixelYield() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
      setTimeout(finish, 100);
    });
  }

  /**
   * Restores per-layer QOI snapshot data onto the board.
   * @param {Uint8Array[]} layerDatas - Array of QOI blobs, one per layer
   */
  restoreSnapshot(layerDatas) {
    if (!this.layerManager || !layerDatas || layerDatas.length === 0) return;
    const [currentHeight, currentWidth] = this.dimensions;
    const snapshotDimensions = snapshotLayerDimensions(layerDatas) || { width: currentWidth, height: currentHeight };
    // Room boardSize is authoritative — don't resize to match the snapshot's
    // dimensions. Mismatched snapshots are clipped (or leave transparent
    // margin) by the restoreWidth/restoreHeight math below.
    const [height, width] = this.dimensions;
    const restoreWidth = Math.min(width, snapshotDimensions.width);
    const restoreHeight = Math.min(height, snapshotDimensions.height);
    const replacesFullBoard = snapshotDimensions.width >= width && snapshotDimensions.height >= height;

    if (replacesFullBoard) {
      this.layerManager.clearAll();
      this.resetSelectionMaskClipTracking();
    } else if (restoreWidth > 0 && restoreHeight > 0) {
      for (let i = 0; i < this.layerManager.layerGroups.length; i++) {
        this._clearLayerRectForSnapshotRestore(i, 0, 0, restoreWidth, restoreHeight);
      }
      this.layerManager.redoStackByUser?.clear?.();
    }

    for (let i = 0; i < layerDatas.length && i < this.layerManager.layerGroups.length; i++) {
      const qoi = layerDatas[i];
      if (!qoi || qoi.length === 0) continue;

      const pixels = wasm.qoi_decode(qoi);
      if (!pixels || pixels.length === 0) continue;
      // Transparent layers are skipped rather than baked — see
      // _snapshotLayerHasPixels. This is the join/sync path, so without it every
      // joiner started with all three layers marked occupied.
      if (!this._snapshotLayerHasPixels(pixels)) continue;

      const dimensions = readQoiDimensions(qoi) || snapshotDimensions;
      if (!dimensions || pixels.length !== dimensions.width * dimensions.height * 4) continue;

      const imageData = new ImageData(
        new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
        dimensions.width,
        dimensions.height
      );
      const group = this.layerManager.layerGroups[i];
      const sourceCanvas = this._createCanvasFromImageData(imageData);

      if (group.flatCanvas) {
        this.layerManager.restoreLayerFromSnapshot(i, sourceCanvas);
      } else {
        this.layerManager.addToBaseBin(i, sourceCanvas, 0, 0);
      }
    }

    this.markCompositeFull();
    this.compositeAllLayers();
  }

  _clearLayerRectForSnapshotRestore(groupIdx, x, y, width, height) {
    const group = this.layerManager?.layerGroups?.[groupIdx];
    if (!group) return;

    for (const stroke of group.strokeStack) {
      this.layerManager.addToBaseBin(groupIdx, stroke.canvas, stroke.x, stroke.y, stroke.blendMode);
    }
    group.strokeStack = [];
    group.userStrokeCounts = new Map();
    group.activeStrokeByUser.clear();

    if (group.flatCanvas) {
      this.layerManager.clearLayerFlatRect(groupIdx, x, y, width, height);
      return;
    }

    const eraseCanvas = document.createElement('canvas');
    eraseCanvas.width = width;
    eraseCanvas.height = height;
    const eraseCtx = eraseCanvas.getContext('2d');
    eraseCtx.fillStyle = '#000';
    eraseCtx.fillRect(0, 0, width, height);
    this.layerManager.addToBaseBin(groupIdx, eraseCanvas, x, y, 'destination-out');
  }

  /**
   * Helper to create a canvas from ImageData.
   * @param {ImageData} imageData
   * @returns {HTMLCanvasElement}
   * @private
   */
  _createCanvasFromImageData(imageData) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * Fills the background layers: room background, then user background (if set).
   * This creates the z-order: room BG → user BG → drawn strokes.
   * @param {Array} dirtyRects - Dirty regions to update, or null for full canvas
   * @private
   */
  _fillBackgroundLayers(dirtyRects) {
    this.viewCtx.globalCompositeOperation = 'source-over';

    const [bgR, bgG, bgB, bgA = 1] = this.backgroundColor || [255, 255, 255, 1];
    this.viewCtx.fillStyle = `rgba(${bgR}, ${bgG}, ${bgB}, ${bgA})`;

    if (dirtyRects && Array.isArray(dirtyRects) && dirtyRects.length > 0) {
      for (const rect of dirtyRects) {
        this.viewCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
    } else {
      this.viewCtx.fillRect(0, 0, this.width, this.height);
    }

    if (this.displayBackgroundColorOverride) {
      const [r, g, b, a] = this.displayBackgroundColorOverride;
      this.viewCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;

      if (dirtyRects && Array.isArray(dirtyRects) && dirtyRects.length > 0) {
        for (const rect of dirtyRects) {
          this.viewCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
        }
      } else {
        this.viewCtx.fillRect(0, 0, this.width, this.height);
      }
    }
  }

  /**
   * Removes border-connected background pixels from the exported base layer so
   * snapshots keep a transparent backdrop even if the baked flat canvas has
   * picked up the room background color.
   * @param {ImageData} imageData
   * @private
   */
  _stripSnapshotBackground(imageData) {
    const { data, width, height } = imageData;
    if (!data || width <= 0 || height <= 0) return;

    const [bgR, bgG, bgB, bgA = 1] = this.backgroundColor || [255, 255, 255, 1];
    const bgAlpha = Math.round(bgA * 255);
    const tolerance = 3;
    const totalPixels = width * height;
    const visited = new Uint8Array(totalPixels);
    const queue = new Uint32Array(totalPixels);
    let head = 0;
    let tail = 0;

    const matchesBackground = (pixelIndex) => {
      const offset = pixelIndex * 4;
      return Math.abs(data[offset] - bgR) <= tolerance &&
        Math.abs(data[offset + 1] - bgG) <= tolerance &&
        Math.abs(data[offset + 2] - bgB) <= tolerance &&
        Math.abs(data[offset + 3] - bgAlpha) <= tolerance;
    };

    const enqueue = (pixelIndex) => {
      if (pixelIndex < 0 || pixelIndex >= totalPixels) return;
      if (visited[pixelIndex] || !matchesBackground(pixelIndex)) return;
      visited[pixelIndex] = 1;
      queue[tail++] = pixelIndex;
    };

    for (let x = 0; x < width; x++) {
      enqueue(x);
      enqueue((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
      enqueue(y * width);
      enqueue(y * width + (width - 1));
    }

    while (head < tail) {
      const pixelIndex = queue[head++];
      const offset = pixelIndex * 4;
      data[offset + 3] = 0;

      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);

      if (x > 0) enqueue(pixelIndex - 1);
      if (x + 1 < width) enqueue(pixelIndex + 1);
      if (y > 0) enqueue(pixelIndex - width);
      if (y + 1 < height) enqueue(pixelIndex + width);
    }
  }

  /**
   * Check if tile pixel data is empty (transparent or only background color).
   * @param {Uint8ClampedArray} data - RGBA pixel data
   * @returns {boolean} True if all pixels are transparent or match background
   * @private
   */
  _checkTileEmpty(data) {
    const [bgR, bgG, bgB, bgA] = this.backgroundColor;
    const bgAlpha = Math.round(bgA * 255);
    const tolerance = 5; // Handle anti-aliasing artifacts

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];

      // Transparent pixel = empty
      if (a === 0) continue;

      // Check if close to background (within tolerance)
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (Math.abs(a - bgAlpha) <= tolerance &&
          Math.abs(r - bgR) <= tolerance &&
          Math.abs(g - bgG) <= tolerance &&
          Math.abs(b - bgB) <= tolerance) {
        continue;
      }

      // Has other content
      return false;
    }
    return true;
  }
}
