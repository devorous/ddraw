/**
 * @fileoverview Touch event handling for mobile gestures.
 * Manages pinch-to-zoom, rotation, and panning using multi-touch detection.
 */

import { isTauriDesktop } from '../platform/desktop.js';

/**
 * TouchHandler detects and processes complex touch gestures like pinch-to-zoom,
 * two-finger rotation, and panning. It uses a mode-locking mechanism to ensure
 * gestures are stable once a primary intent (zoom, rotate, or pan) is identified.
 */
export class TouchHandler {
  /**
   * @param {App} app - The main application instance.
   */
  constructor(app) {
    this.app = app;
    /** @type {HTMLElement|null} */
    this.element = null;
    
    /** @type {Object} */
    this.state = {
      active: false,
      mode: null, // 'pan', 'zoom', 'rotate', or null
      gestureStartedWithTwoFingers: false,
      isPinching: false,

      initialDistance: null,
      initialAngle: null,
      initialCenter: null,

      initialZoom: null,
      initialRotation: null,
      initialPanX: null,
      initialPanY: null,

      pivotCanvasX: null,
      pivotCanvasY: null
    };

    this.touchStartedOnBoard = false;

    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);
  }

  get board() { return this.app.board; }
  get ui() { return this.app.ui; }
  get self() { return this.app.self; }
  get wsClient() { return this.app.wsClient; }
  get toolManager() { return this.app.toolManager; }

  /**
   * Initializes the handler with a target element and attaches event listeners.
   *
   * @param {HTMLElement} element - The DOM element to listen for touches on.
   * @returns {void}
   */
  init(element) {
    this.element = element;
    element.addEventListener('touchstart', this.handleTouchStart, { passive: false });
    window.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    window.addEventListener('touchend', this.handleTouchEnd, { passive: false });
    window.addEventListener('touchcancel', this.handleTouchEnd, { passive: false });
  }

  async _focusAppWindow() {
    if (!isTauriDesktop()) return;

    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      await getCurrentWebviewWindow().setFocus();
    } catch {
      // Best-effort only; touch interaction should still work even if focus fails.
    }
  }

  /**
   * Returns true when the touch target is the board itself or the empty
   * background area around it, but not floating board UI controls.
   *
   * @param {TouchEvent} e
   * @returns {boolean}
   */
  shouldHandleTouchEvent(e) {
    if (!this.element) return false;

    const target = e.target instanceof Element ? e.target : null;
    if (!target) return false;

    // Floating palettes live inside #boards but manage their own pointer-based
    // drag/resize. Calling preventDefault() on their touches would cancel the
    // pointer-event stream those interactions rely on, so leave them alone.
    if (target.closest('#floatingPaletteMount')) return false;

    if (target === this.element) return true;

    const boards = this.app.ui?.elements?.boards;
    return Boolean(boards && (target === boards || target.closest('#boards')));
  }

  /**
   * Calculates the Euclidean distance between two touch points.
   *
   * @param {TouchList} touches - The list of active touches.
   * @returns {number} The distance in pixels.
   */
  getDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Calculates the angle of the line segment between two touch points.
   *
   * @param {TouchList} touches - The list of active touches.
   * @returns {number} The angle in degrees (-180 to 180).
   */
  getAngle(touches) {
    const dx = touches[1].clientX - touches[0].clientX;
    const dy = touches[1].clientY - touches[0].clientY;
    return Math.atan2(dy, dx) * (180 / Math.PI);
  }

  /**
   * Calculates the midpoint between two touch points.
   *
   * @param {TouchList} touches - The list of active touches.
   * @returns {Object} The {x, y} screen coordinates of the center.
   */
  getCenter(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2
    };
  }

  /**
   * Converts screen (client) coordinates to canvas-space coordinates.
   *
   * @param {number} screenX - Client X coordinate.
   * @param {number} screenY - Client Y coordinate.
   * @returns {Object} The converted {x, y} canvas coordinates.
   */
  screenToCanvas(screenX, screenY) {
    return this.board.getBoardRelativePos(screenX, screenY);
  }

  /**
   * Handles the start of a touch gesture.
   * If two fingers are detected, begins gesture tracking and suppresses drawing.
   *
   * @param {TouchEvent} e - The touch event.
   * @returns {void}
   */
  handleTouchStart(e) {
    if (!this.shouldHandleTouchEvent(e)) return;

    this.touchStartedOnBoard = true;
    void this._focusAppWindow();
    e.preventDefault();

    if (e.touches.length === 2) {
      this.state.active = true;
      this.state.mode = null;
      this.state.gestureStartedWithTwoFingers = true;
      this.state.isPinching = true;

      if (this.app.self && this.app.self.mousedown) {
        this.app.cancelCurrentStroke();
      }

      if (this.app.self.tool !== 'text') {
        this.ui.hideCursor();
        // Queued, not sent inline: a finger's pointerdown fires before this
        // touchstart and queues a SHOW, which would otherwise drain after an
        // inline HIDE and re-reveal this user's cursor/name to every peer for
        // the rest of the gesture. App.broadcastCursorVisibility re-checks the
        // gesture at drain time and drops that stale SHOW.
        this.app.broadcastCursorVisibility(false);
      }

      this.state.initialDistance = this.getDistance(e.touches);
      this.state.initialAngle = this.getAngle(e.touches);
      this.state.initialCenter = this.getCenter(e.touches);

      this.state.initialZoom = this.board.zoom;
      this.state.initialRotation = this.board.rotation;
      this.state.initialPanX = this.board.panX;
      this.state.initialPanY = this.board.panY;

      const pivot = this.screenToCanvas(
        this.state.initialCenter.x,
        this.state.initialCenter.y
      );
      this.state.pivotCanvasX = pivot.x;
      this.state.pivotCanvasY = pivot.y;
    }
  }

  /**
   * Processes touch movement. Performs gesture detection and applies transformations.
   *
   * @param {TouchEvent} e - The touch event.
   * @returns {void}
   */
  handleTouchMove(e) {
    if (this.state.active || this.touchStartedOnBoard) {
      e.preventDefault();
    }

    if (!this.state.active || e.touches.length !== 2) return;

    const currentDistance = this.getDistance(e.touches);
    const currentAngle = this.getAngle(e.touches);
    const currentCenter = this.getCenter(e.touches);

    if (this.state.mode === null) {
      const distanceChange = Math.abs(currentDistance - this.state.initialDistance);

      let angleChange = currentAngle - this.state.initialAngle;
      if (angleChange > 180) angleChange -= 360;
      if (angleChange < -180) angleChange += 360;
      angleChange = Math.abs(angleChange);

      const centerDx = currentCenter.x - this.state.initialCenter.x;
      const centerDy = currentCenter.y - this.state.initialCenter.y;
      const centerMove = Math.sqrt(centerDx * centerDx + centerDy * centerDy);

      const ZOOM_THRESHOLD = 30;
      const ROTATE_THRESHOLD = 8;
      const PAN_THRESHOLD = 20;

      const zoomStrength = distanceChange / ZOOM_THRESHOLD;
      const rotateStrength = angleChange / ROTATE_THRESHOLD;
      const panStrength = centerMove / PAN_THRESHOLD;

      if (zoomStrength >= 1 || rotateStrength >= 1 || panStrength >= 1) {
        if (zoomStrength >= rotateStrength && zoomStrength >= panStrength) {
          this.state.mode = 'zoom';
        } else if (rotateStrength >= zoomStrength && rotateStrength >= panStrength) {
          this.state.mode = 'rotate';
        } else {
          this.state.mode = 'pan';
        }

        this.state.initialDistance = currentDistance;
        this.state.initialAngle = currentAngle;
        this.state.initialCenter = currentCenter;
        this.state.initialZoom = this.board.zoom;
        this.state.initialRotation = this.board.rotation;
        this.state.initialPanX = this.board.panX;
        this.state.initialPanY = this.board.panY;

        const pivot = this.screenToCanvas(currentCenter.x, currentCenter.y);
        this.state.pivotCanvasX = pivot.x;
        this.state.pivotCanvasY = pivot.y;
      }

      return;
    }

    switch (this.state.mode) {
      case 'pan': {
        const dx = currentCenter.x - this.state.initialCenter.x;
        const dy = currentCenter.y - this.state.initialCenter.y;
        this.board.panX = this.state.initialPanX + dx;
        this.board.panY = this.state.initialPanY + dy;
        this.board.applyTransform();
        break;
      }

      case 'zoom': {
        const scale = currentDistance / this.state.initialDistance;
        const newZoom = this.state.initialZoom * scale;
        this.board.setZoomAround(newZoom, currentCenter.x, currentCenter.y);
        this.ui.updateZoomDisplay(this.board.getZoomPercent());
        break;
      }

      case 'rotate': {
        let angleDelta = currentAngle - this.state.initialAngle;
        if (angleDelta > 180) angleDelta -= 360;
        if (angleDelta < -180) angleDelta += 360;

        const newRotation = this.state.initialRotation + angleDelta;
        this.board.setRotationAround(newRotation, currentCenter.x, currentCenter.y);
        break;
      }
    }
  }

  /**
   * Finalizes touch gestures and restores UI state.
   *
   * @param {TouchEvent} e - The touch event.
   * @returns {void}
   */
  handleTouchEnd(e) {
    if (e.touches.length < 2) {
      this.state.active = false;
      this.state.mode = null;
      this.state.isPinching = false;
    }

    if (e.touches.length === 0) {
      this.state.gestureStartedWithTwoFingers = false;
      this.touchStartedOnBoard = false;
      
      if (this.app.isOnBoard || this.app.self.tool === 'text') {
        this.ui.showCursor();
        this.app.broadcastCursorVisibility(true);
      }
    }
  }

  /**
   * Cleans up event listeners.
   * @returns {void}
   */
  destroy() {
    if (this.element) {
      this.element.removeEventListener('touchstart', this.handleTouchStart);
    }
    window.removeEventListener('touchmove', this.handleTouchMove);
    window.removeEventListener('touchend', this.handleTouchEnd);
    window.removeEventListener('touchcancel', this.handleTouchEnd);
  }

  /**
   * Intercepts and processes input events for the touch keyboard.
   * Maps mobile input types (insert, delete) to text tool actions.
   *
   * @param {InputEvent} e - The beforeinput event.
   * @returns {void}
   */
  handleTouchBeforeInput(e) {
    if (this.self.tool !== 'text') return;

    const textTool = this.toolManager.getTool('text');

    switch (e.inputType) {
      case 'insertText':
        if (e.data) {
          for (const char of e.data) {
            textTool.onKeyPress(this.self, char);
            this.wsClient.broadcastKeyPress(char);
          }
        }
        break;

      case 'insertLineBreak':
      case 'insertParagraph':
        textTool.onKeyPress(this.self, 'Enter', false, true);
        this.wsClient.broadcastKeyPress('Shift+Enter');
        break;

      case 'deleteContentBackward':
      case 'deleteContentForward':
      case 'deleteWordBackward':
      case 'deleteWordForward':
        if (this.self.text.length > 0) {
            textTool.onKeyPress(this.self, 'Backspace');
            this.wsClient.broadcastKeyPress('Backspace');
        }
        break;
        
      case 'insertCompositionText':
        if (e.data) {
          for (const char of e.data) {
            textTool.onKeyPress(this.self, char);
            this.wsClient.broadcastKeyPress(char);
          }
        }
        break;
    }

    this.ui.updateSelfTextInput(this.self.text);
    this.app._updateTextPreview();
    e.preventDefault();
    e.target.value = ' ';
    
    setTimeout(() => {
      if (this.self.tool === 'text') {
        e.target.focus();
      }
    }, 0);
  }

  /**
   * Handles keyboard focus dismissal.
   * @returns {void}
   */
  handleTouchInputBlur() {
    // Optionally handle when keyboard is dismissed
  }
}
