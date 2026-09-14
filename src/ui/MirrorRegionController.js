/**
 * @fileoverview Interactive flow for creating and editing shared mirror regions.
 */

import { Board } from '../canvas/Board.js';

export class MirrorRegionController {
  /**
   * @param {Object} app
   */
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.ui = app.ui;
    this.wsClient = app.wsClient;

    this.active = false;
    this.stage = 'idle';
    this.startPos = null;
    this.selection = null;
    this.editingRegionId = null;
    this.marchingAntsOffset = 0;
    this.animationId = null;
    this.options = {
      axis: 'vertical',
      slices: 6,
      fibDepth: 4,
      showLine: true
    };

    this.overlayCanvas = null;
    this.overlayCtx = null;
    this.panel = null;
    this.controlsLayer = null;
    this.panelTitle = null;
    this.panelDescription = null;
    this.applyButton = null;
    this.boardMirrorToggle = null;
    this.globalMirrorInput = null;

    // Handle system for resizing/moving
    this.handles = [];
    this.activeHandle = null;
    this.handleSize = 8;
    this.handleHitArea = 20;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.originalEditingRegion = null;
    this.lastEditingPreviewSignature = '';
  }

  init() {
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.id = 'mirrorRegionOverlay';
    this.overlayCanvas.style.position = 'absolute';
    this.overlayCanvas.style.top = '0';
    this.overlayCanvas.style.left = '0';
    this.overlayCanvas.style.pointerEvents = 'none';
    this.overlayCanvas.style.zIndex = '4';
    this.overlayCanvas.width = this.board.getWidth();
    this.overlayCanvas.height = this.board.getHeight();
    this.board.boardsWrapper.appendChild(this.overlayCanvas);
    this.overlayCtx = this.overlayCanvas.getContext('2d');

    this.controlsLayer = document.createElement('div');
    this.controlsLayer.id = 'mirrorRegionControls';
    this.controlsLayer.dataset.tut = 'mirror-region-controls-layer';
    this.controlsLayer.style.position = 'absolute';
    this.controlsLayer.style.top = '0';
    this.controlsLayer.style.left = '0';
    this.controlsLayer.style.width = '100%';
    this.controlsLayer.style.height = '100%';
    this.controlsLayer.style.pointerEvents = 'none';
    this.controlsLayer.style.zIndex = '5';
    this.controlsLayer.style.display = 'none';
    this.board.boardsWrapper.appendChild(this.controlsLayer);

    this.panel = document.createElement('div');
    this.panel.id = 'mirrorRegionPanel';
    this.panel.style.position = 'absolute';
    this.panel.style.zIndex = '60';
    this.panel.style.display = 'none';
    this.panel.style.minWidth = '220px';
    this.panel.style.padding = '12px';
    this.panel.style.borderRadius = '10px';
    this.panel.style.border = '1px solid rgba(255, 255, 255, 0.08)';
    this.panel.style.background = 'rgba(19, 23, 29, 0.96)';
    this.panel.style.boxShadow = '0 10px 28px rgba(0, 0, 0, 0.35)';
    this.panel.style.backdropFilter = 'blur(12px)';
    this.panel.innerHTML = `
      <div data-role="mirror-panel-title" style="font-size:12px;font-weight:600;color:#f3f6fb;margin-bottom:8px;">Mirror Region</div>
      <div data-role="mirror-panel-description" style="font-size:11px;color:rgba(255,255,255,0.6);margin-bottom:10px;">Choose how this area reflects strokes.</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:6px;">
        <input type="radio" name="mirrorRegionAxis" value="vertical" checked />
        Vertical
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:6px;">
        <input type="radio" name="mirrorRegionAxis" value="horizontal" />
        Horizontal
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:6px;">
        <input type="radio" name="mirrorRegionAxis" value="quad" />
        Quad
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:10px;">
        <input type="radio" name="mirrorRegionAxis" value="rotational" />
        Rotational
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:10px;">
        <input type="radio" name="mirrorRegionAxis" value="radial" />
        Radial
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:10px;">
        <input type="radio" name="mirrorRegionAxis" value="fib" />
        Fibonacci
      </label>
      <label data-role="mirror-slices-row" style="display:none;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:12px;">
        <span>Slices</span>
        <input
          type="range"
          name="mirrorRegionSlices"
          min="3"
          max="16"
          step="1"
          value="6"
          style="flex:1;"
        />
        <span data-role="mirror-slices-value" style="min-width:20px;text-align:right;">6</span>
      </label>
      <label data-role="mirror-fib-depth-row" style="display:none;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:12px;">
        <span>Depth</span>
        <input
          type="range"
          name="mirrorRegionFibDepth"
          min="1"
          max="8"
          step="1"
          value="4"
          style="flex:1;"
        />
        <span data-role="mirror-fib-depth-value" style="min-width:20px;text-align:right;">4</span>
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:12px;">
        <input type="checkbox" name="mirrorRegionShowLine" checked />
        Show guides
      </label>
      <div style="display:flex;gap:8px;">
        <button type="button" data-action="cancel" class="btn" style="flex:1;">Close</button>
        <button type="button" data-action="apply" class="btn" style="flex:1;">Apply</button>
      </div>
    `;
    this.ui.elements.boardContainer.appendChild(this.panel);

    this.panelTitle = this.panel.querySelector('[data-role="mirror-panel-title"]');
    this.panelDescription = this.panel.querySelector('[data-role="mirror-panel-description"]');
    this.applyButton = this.panel.querySelector('[data-action="apply"]');
    this.slicesRow = this.panel.querySelector('[data-role="mirror-slices-row"]');
    this.slicesValue = this.panel.querySelector('[data-role="mirror-slices-value"]');
    this.fibDepthRow = this.panel.querySelector('[data-role="mirror-fib-depth-row"]');
    this.fibDepthValue = this.panel.querySelector('[data-role="mirror-fib-depth-value"]');
    this._buildBoardMirrorToggle();

    this.panel.querySelectorAll('input[name="mirrorRegionAxis"]').forEach(input => {
      input.addEventListener('change', () => {
        this.options.axis = input.value;
        this._rescaleSelectionForMode();
        this._syncSlicesVisibility();
        this._drawSelection();
        this._refreshRegionControls();
      });
    });
    this.panel.querySelector('input[name="mirrorRegionSlices"]').addEventListener('input', (e) => {
      this.options.slices = this._normalizeSlices(e.target.value);
      if (this.slicesValue) this.slicesValue.textContent = String(this.options.slices);
      this._drawSelection();
      this._refreshRegionControls();
    });
    this.panel.querySelector('input[name="mirrorRegionFibDepth"]').addEventListener('input', (e) => {
      this.options.fibDepth = this._normalizeFibDepth(e.target.value);
      if (this.fibDepthValue) this.fibDepthValue.textContent = String(this.options.fibDepth);
      this._drawSelection();
      this._refreshRegionControls();
    });
    this.panel.querySelector('input[name="mirrorRegionShowLine"]').addEventListener('change', (e) => {
      this.options.showLine = !!e.target.checked;
      this._drawSelection();
      this._refreshRegionControls();
    });
    this.panel.querySelector('[data-action="cancel"]').addEventListener('click', () => this._handlePanelCancel());
    this.panel.querySelector('[data-action="apply"]').addEventListener('click', () => this.apply());

    this.board.onMirrorRegionsChange = () => {
      this._refreshRegionControls();
      if (this.active && this.editingRegionId && !this._getRegionById(this.editingRegionId)) {
        this._resetSelectionState();
      }
    };
  }

  begin() {
    if (this.active) {
      this.cancel();
      return;
    }

    this.active = true;
    this.stage = 'selecting';
    this._syncMirrorDisplay();
    this.startPos = null;
    this.selection = null;
    this.editingRegionId = null;
    this.options = { axis: 'vertical', slices: 6, fibDepth: 4, showLine: true };
    this._showControlsLayer();
    this._refreshRegionControls();
    this._showMirrorCursor();
    this._hidePanel();
    this._showBoardMirrorToggle();
    this._clearOverlay();
    this._startMarchingAnts();
    this.ui.showToast('Drag to add a mirror region, or use the region controls to edit/remove one.', 2200);
  }

  cancel() {
    this._restoreOriginalEditingRegion();
    this.active = false;
    this.stage = 'idle';
    this._resetSelectionState();
    this._hideBoardMirrorToggle();
    this._hidePanel();
    this._clearOverlay();
    this._hideControlsLayer();
    this._stopMarchingAnts();
    this._syncMirrorDisplay();
    this.ui.updateToolDisplay(this.app.self?.tool, this.app.self);
  }

  isActive() {
    return this.active;
  }

  handlePointerDown(e) {
    if (!this.active) return false;
    if (this._shouldAllowPanGesture(e)) return false;
    if (e.button !== 0) return true;
    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    this.ui.updateSelfCursor(pos.x, pos.y, this.app.self?.size || 1);

    // Check if clicking on a handle (only in edit/config mode)
    if ((this.stage === 'configuring' || this.stage === 'editing') && this.selection) {
      const handle = this._getHandleAtPos(pos);
      if (handle) {
        this.activeHandle = handle;
        return true;
      }

      // Check if clicking inside region to drag it
      if (this._posInSelection(pos)) {
        this.isDragging = true;
        this.dragOffset.x = pos.x - this.selection.x;
        this.dragOffset.y = pos.y - this.selection.y;
        return true;
      }

      // In edit/config mode, don't start a new selection
      return true;
    }

    // Only start new selection in selecting/idle mode
    if (this.stage === 'selecting' || this.stage === 'idle') {
      this._beginSelectionAt(pos);
    }
    return true;
  }

  handlePointerMove(e) {
    if (!this.active) return false;
    if (this._shouldAllowPanGesture(e)) return false;
    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    this._showMirrorCursor();
    this.ui.updateSelfCursor(pos.x, pos.y, this.app.self?.size || 1);

    // Handle dragging selection borders/corners
    if (this.activeHandle && this.selection) {
      this._updateHandleDrag(pos);
      this._drawSelection();
      return true;
    }

    // Handle moving the entire region
    if (this.isDragging && this.selection) {
      this.selection.x = Math.round(pos.x - this.dragOffset.x);
      this.selection.y = Math.round(pos.y - this.dragOffset.y);
      this._drawSelection();
      return true;
    }

    if (this.stage !== 'selecting' || !this.startPos) {
      // Update cursor based on handle hover
      this._updateCursorForPosition(pos);
      return true;
    }

    const x = Math.min(this.startPos.x, pos.x);
    const y = Math.min(this.startPos.y, pos.y);
    const size = Math.abs(pos.x - this.startPos.x);
    const size2 = Math.abs(pos.y - this.startPos.y);
    const maxSize = Math.max(size, size2);

    if (this.options.axis === 'fib') {
      const PHI = 1.6180339887;
      this.selection = { x, y, width: maxSize, height: Math.round(maxSize / PHI) };
    } else {
      this.selection = { x, y, width: maxSize, height: maxSize };
    }
    this._drawSelection();
    return true;
  }

  handlePointerUp(e) {
    if (!this.active) return false;
    if (this._shouldAllowPanGesture(e)) return false;
    if (e.button !== 0) return true;

    // Finish handle dragging
    if (this.activeHandle) {
      this.activeHandle = null;
      this._drawSelection();
      return true;
    }

    // Finish region dragging
    if (this.isDragging) {
      this.isDragging = false;
      this._drawSelection();
      return true;
    }

    if (this.stage !== 'selecting' || !this.selection) return true;
    if (this.selection.width < 4 || this.selection.height < 4) {
      this.ui.showToast('Mirror region is too small', 1800);
      this._resetSelectionState();
      this._clearOverlay();
      return true;
    }
    this.startPos = null;
    this.stage = 'configuring';
    this._configurePanelForCreate();
    this._showPanel();
    this._drawSelection();
    return true;
  }

  apply() {
    if (!this.selection) return;

    const region = this._buildRegionFromSelection(this.editingRegionId);

    if (this.editingRegionId) {
      const nextRegions = (this.board.mirrorRegions || []).map(existing =>
        existing.id === this.editingRegionId ? { ...existing, ...region } : existing
      );
      this.board.setMirrorRegions(nextRegions);
      // Unconditional like broadcastMirror(): send() no-ops when disconnected
      // and taps the rolling tape in offline mode so replay sees the region.
      this.wsClient?.broadcastMirrorRegion({ action: 'update', region });
      this.ui.showToast('Mirror region updated', 1800);
      this.originalEditingRegion = null;
      this.lastEditingPreviewSignature = '';
    } else {
      this.board.setMirrorRegions([...(this.board.mirrorRegions || []), region]);
      this.wsClient?.broadcastMirrorRegion({ action: 'create', region });
      this.ui.showToast('Mirror region applied', 1800);
    }

    this.cancel();
    window.dispatchEvent(new CustomEvent('topdraw:mirror-region-applied'));
  }

  startEditingRegion(regionId) {
    const region = this._getRegionById(regionId);
    if (!region) return;

    this.active = true;
    this.stage = 'editing';
    this.startPos = null;
    this.selection = {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height
    };
    this.editingRegionId = region.id;
    this.options = {
      axis: region.mode || region.axis || 'vertical',
      slices: this._normalizeSlices(region.slices),
      fibDepth: this._normalizeFibDepth(region.fibDepth),
      showLine: region.showLine !== false
    };
    this.originalEditingRegion = { ...region };
    this.lastEditingPreviewSignature = '';

    this._syncMirrorDisplay();
    this._showControlsLayer();
    this._showMirrorCursor();
    this._configurePanelForEdit();
    this._showPanel();
    this._startMarchingAnts();
    this._drawSelection();
  }

  removeRegion(regionId) {
    const nextRegions = (this.board.mirrorRegions || []).filter(region => region.id !== regionId);
    this.board.setMirrorRegions(nextRegions);
    this.wsClient?.broadcastMirrorRegion({ action: 'remove', id: regionId });
    if (this.editingRegionId === regionId) {
      this.originalEditingRegion = null;
      this._resetSelectionState();
      this._hidePanel();
      this._clearOverlay();
      this.stage = 'selecting';
    }
    if (this.active) {
      this.cancel();
    } else {
      this._syncMirrorDisplay();
    }
    this.ui.showToast('Mirror region removed', 1800);
    window.dispatchEvent(new CustomEvent('topdraw:mirror-region-removed', {
      detail: { id: regionId, remainingCount: nextRegions.length }
    }));
  }

  _handlePanelCancel() {
    this._restoreOriginalEditingRegion();
    this._resetSelectionState();
    this._hidePanel();
    this._clearOverlay();
    this.stage = 'selecting';
    this._syncMirrorDisplay();
  }

  _beginSelectionAt(pos) {
    this.stage = 'selecting';
    this.startPos = pos;
    this.selection = { x: pos.x, y: pos.y, width: 0, height: 0 };
    this.editingRegionId = null;
    this._hidePanel();
    this._drawSelection();
  }

  _resetSelectionState() {
    this.stage = this.active ? 'selecting' : 'idle';
    this.startPos = null;
    this.selection = null;
    this.editingRegionId = null;
    this.originalEditingRegion = null;
    this.lastEditingPreviewSignature = '';
    this.options = { axis: 'vertical', slices: 6, fibDepth: 4, showLine: true };
  }

  /**
   * Builds the admin-only "Mirror whole board" checkbox that sits directly under
   * the Mirror toolbar button while mirror mode is open. Deliberately a bare
   * checkbox and not part of the region panel: the full-board mirror is not a
   * property of any region, and the panel only exists once a region has been
   * dragged out.
   * @private
   */
  _buildBoardMirrorToggle() {
    const btn = this.ui.elements.mirrorBtn;
    const anchor = btn?.closest('.mirrorContainer') || btn?.parentElement;
    if (!anchor) return;
    if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';

    const wrap = document.createElement('label');
    wrap.id = 'mirrorWholeBoardToggle';
    wrap.dataset.tut = 'mirror-whole-board';
    wrap.style.cssText = [
      'position:absolute', 'top:calc(100% + 6px)', 'left:0', 'z-index:60',
      'display:none', 'align-items:center', 'gap:6px', 'white-space:nowrap',
      'padding:5px 9px', 'border-radius:8px',
      'border:1px solid rgba(255,255,255,0.08)',
      'background:rgba(19,23,29,0.96)', 'backdrop-filter:blur(12px)',
      'box-shadow:0 6px 18px rgba(0,0,0,0.3)',
      'font-size:11px', 'color:rgba(255,255,255,0.85)', 'cursor:pointer',
    ].join(';');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'mirrorWholeBoard';
    input.style.cursor = 'pointer';
    input.addEventListener('change', (e) => this._setBoardMirror(!!e.target.checked));

    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode('Mirror whole board'));
    anchor.appendChild(wrap);

    this.boardMirrorToggle = wrap;
    this.globalMirrorInput = input;
  }

  _showBoardMirrorToggle() {
    if (!this.boardMirrorToggle) return;
    // Admin-only, re-checked on every open so a mid-session promotion or demotion
    // takes effect without a reload.
    this.boardMirrorToggle.style.display = this._canToggleBoardMirror() ? 'flex' : 'none';
    this.syncBoardMirrorCheckbox();
  }

  _hideBoardMirrorToggle() {
    if (this.boardMirrorToggle) this.boardMirrorToggle.style.display = 'none';
  }

  /**
   * Whether this client may flip the room-wide full-board mirror. Mirrors the
   * server rule exactly (permissions.js Action.TOGGLE_MIRROR: room ADMIN(5)+ or
   * global HOLY(8)+) — `Moderation.isAdmin()` is that same pair. Deliberately
   * NOT `isMod()`, which uses the *effective* role and would show the control to
   * someone the server then refuses.
   * @returns {boolean}
   * @private
   */
  _canToggleBoardMirror() {
    return !!this.app.moderation?.isAdmin?.();
  }

  /**
   * Turns the room-wide full-board mirror on or off. Optimistic: the local board
   * flips first and T.MIR tells the server to flip the room setting, because the
   * message is a relative toggle with no payload. If the server refuses it
   * answers with the authoritative SETTINGS, which puts this client back.
   * @private
   */
  _setBoardMirror(enabled) {
    if (!this._canToggleBoardMirror()) {
      this.syncBoardMirrorCheckbox();
      return;
    }
    if (this.board.mirror === !!enabled) return;

    this.board.setMirror(!!enabled);
    this.wsClient?.broadcastMirror();
    this._syncMirrorDisplay();
    this.ui.showToast(
      enabled ? 'Full-board mirror on for everyone in this room' : 'Full-board mirror off',
      2000
    );
  }

  /**
   * Re-reads the room's mirror state into the checkbox. Called when another
   * admin's T.MIR arrives, so an open panel does not show a stale state.
   */
  syncBoardMirrorCheckbox() {
    if (this.globalMirrorInput) this.globalMirrorInput.checked = !!this.board.mirror;
  }

  _showPanel() {
    this.panel.style.display = 'block';
    this.panel.dataset.tut = 'mirror-region-panel';
    const axisInput = this.panel.querySelector(`input[name="mirrorRegionAxis"][value="${this.options.axis}"]`);
    if (axisInput) axisInput.checked = true;
    const slicesInput = this.panel.querySelector('input[name="mirrorRegionSlices"]');
    if (slicesInput) slicesInput.value = String(this._normalizeSlices(this.options.slices));
    if (this.slicesValue) this.slicesValue.textContent = String(this._normalizeSlices(this.options.slices));
    const fibDepthInput = this.panel.querySelector('input[name="mirrorRegionFibDepth"]');
    if (fibDepthInput) fibDepthInput.value = String(this._normalizeFibDepth(this.options.fibDepth));
    if (this.fibDepthValue) this.fibDepthValue.textContent = String(this._normalizeFibDepth(this.options.fibDepth));
    const lineInput = this.panel.querySelector('input[name="mirrorRegionShowLine"]');
    if (lineInput) lineInput.checked = this.options.showLine;
    this._syncSlicesVisibility();
    this._positionPanelNearSelection();
  }

  _positionPanelNearSelection() {
    if (!this.selection) {
      this.panel.style.right = '12px';
      this.panel.style.top = '108px';
      this.panel.style.left = '';
      return;
    }

    // Convert the selection's right edge from board coords to container coords
    const board = this.board;
    const bx = this.selection.x + this.selection.width;
    const by = this.selection.y;

    // Board → container: zoom, rotate, then pan
    const sx = bx * board.zoom;
    const sy = by * board.zoom;
    const rad = board.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = sx * cos - sy * sin;
    const ry = sx * sin + sy * cos;
    let cx = rx + board.panX;
    let cy = ry + board.panY;

    const containerRect = board.container.getBoundingClientRect();
    const panelWidth = this.panel.offsetWidth || 220;
    const panelHeight = this.panel.offsetHeight || 260;
    const margin = 12;

    // Place to the right of the region edge; if it overflows, place to the left
    let left = cx + margin;
    if (left + panelWidth > containerRect.width) {
      // Try left side of the region
      const leftEdgeX = this.selection.x * board.zoom;
      const lrx = leftEdgeX * cos - sy * sin;
      const lcx = lrx + board.panX;
      left = lcx - panelWidth - margin;
    }
    // Clamp horizontal
    left = Math.max(margin, Math.min(left, containerRect.width - panelWidth - margin));

    // Clamp vertical
    let top = Math.max(margin, Math.min(cy, containerRect.height - panelHeight - margin));

    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
    this.panel.style.right = '';
  }

  _hidePanel() {
    if (this.panel) this.panel.style.display = 'none';
  }

  _showControlsLayer() {
    if (this.controlsLayer) this.controlsLayer.style.display = 'block';
  }

  _hideControlsLayer() {
    if (this.controlsLayer) {
      this.controlsLayer.style.display = 'none';
      this.controlsLayer.innerHTML = '';
    }
  }

  _clearOverlay() {
    if (this.overlayCtx) {
      this._ensureOverlaySize();
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
  }

  _ensureOverlaySize() {
    if (!this.overlayCanvas) return;
    const w = this.board.getWidth();
    const h = this.board.getHeight();
    if (this.overlayCanvas.width !== w) this.overlayCanvas.width = w;
    if (this.overlayCanvas.height !== h) this.overlayCanvas.height = h;
  }

  _startMarchingAnts() {
    if (this.animationId) return;
    const step = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 0.75) % 16;
      if (this.selection) this._drawSelection();
      this.animationId = requestAnimationFrame(step);
    };
    this.animationId = requestAnimationFrame(step);
  }

  _stopMarchingAnts() {
    if (!this.animationId) return;
    cancelAnimationFrame(this.animationId);
    this.animationId = null;
  }

  _drawSelection() {
    if (!this.overlayCtx || !this.selection) return;

    this._ensureOverlaySize();
    const ctx = this.overlayCtx;
    const s = this.selection;
    this._clearOverlay();

    ctx.save();
    ctx.fillStyle = 'rgba(8, 10, 14, 0.2)';
    ctx.fillRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    ctx.clearRect(s.x, s.y, s.width, s.height);

    ctx.setLineDash([6, 6]);
    ctx.lineDashOffset = -this.marchingAntsOffset;
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.width, s.height);

    ctx.lineDashOffset = -(this.marchingAntsOffset + 6);
    ctx.strokeStyle = '#0d0d0d';
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.width, s.height);

    if (this.options.showLine) {
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = 'rgba(0, 212, 170, 0.95)';
      this._drawModeGuides(ctx, s, this.options.axis);
    }

    // Draw handles if in edit mode
    if (this.stage === 'configuring' || this.stage === 'editing') {
      this._drawHandles(ctx, s);
    }

    ctx.restore();

    this._syncEditingRegionPreview();
  }

  _drawHandles(ctx, s) {
    ctx.save();
    ctx.fillStyle = '#4f46e5';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;

    // Build handles list
    this.handles = [];
    const h = this.handleSize;
    const corners = [
      { id: 'tl', x: s.x, y: s.y },
      { id: 'tr', x: s.x + s.width, y: s.y },
      { id: 'bl', x: s.x, y: s.y + s.height },
      { id: 'br', x: s.x + s.width, y: s.y + s.height },
      { id: 'tm', x: s.x + s.width / 2, y: s.y },
      { id: 'bm', x: s.x + s.width / 2, y: s.y + s.height },
      { id: 'ml', x: s.x, y: s.y + s.height / 2 },
      { id: 'mr', x: s.x + s.width, y: s.y + s.height / 2 }
    ];

    for (const corner of corners) {
      this.handles.push(corner);
      ctx.fillRect(corner.x - h / 2, corner.y - h / 2, h, h);
      ctx.strokeRect(corner.x - h / 2, corner.y - h / 2, h, h);
    }

    ctx.restore();
  }

  _getHandleAtPos(pos) {
    for (const handle of this.handles) {
      const dx = pos.x - handle.x;
      const dy = pos.y - handle.y;
      if (Math.hypot(dx, dy) <= this.handleHitArea) {
        return handle;
      }
    }
    return null;
  }

  _posInSelection(pos) {
    if (!this.selection) return false;
    return pos.x >= this.selection.x && pos.x <= this.selection.x + this.selection.width &&
           pos.y >= this.selection.y && pos.y <= this.selection.y + this.selection.height;
  }

  _updateHandleDrag(pos) {
    if (!this.activeHandle || !this.selection) return;

    const s = this.selection;
    const handleId = this.activeHandle.id;

    // Edge handles - just move one edge, allow non-square shapes
    switch (handleId) {
      case 'tm': { // Top - move top edge
        const bottomY = s.y + s.height;
        s.y = Math.min(pos.y, bottomY - 1);
        s.height = bottomY - s.y;
        break;
      }
      case 'bm': { // Bottom - move bottom edge
        const topY = s.y;
        const newBottomY = Math.max(pos.y, topY + 1);
        s.height = newBottomY - topY;
        break;
      }
      case 'ml': { // Left - move left edge
        const rightX = s.x + s.width;
        s.x = Math.min(pos.x, rightX - 1);
        s.width = rightX - s.x;
        break;
      }
      case 'mr': { // Right - move right edge
        const leftX = s.x;
        const newRightX = Math.max(pos.x, leftX + 1);
        s.width = newRightX - leftX;
        break;
      }

      // Corner handles - drag from corner with aspect ratio locking
      case 'tl': { // Top-left
        const newX = Math.min(pos.x, s.x + s.width - 1);
        const newY = Math.min(pos.y, s.y + s.height - 1);
        const newW = Math.max(1, s.x + s.width - newX);
        const newH = Math.max(1, s.y + s.height - newY);
        this._applyAspectRatio(s, newW, newH, 'tl');
        s.x = newX + (newW - s.width);
        s.y = newY + (newH - s.height);
        break;
      }
      case 'tr': { // Top-right
        const newY = Math.min(pos.y, s.y + s.height - 1);
        const newW = Math.max(1, pos.x - s.x);
        const newH = Math.max(1, s.y + s.height - newY);
        this._applyAspectRatio(s, newW, newH, 'tr');
        s.y = newY + (newH - s.height);
        break;
      }
      case 'bl': { // Bottom-left
        const newX = Math.min(pos.x, s.x + s.width - 1);
        const newW = Math.max(1, s.x + s.width - newX);
        const newH = Math.max(1, pos.y - s.y);
        this._applyAspectRatio(s, newW, newH, 'bl');
        s.x = newX + (newW - s.width);
        break;
      }
      case 'br': { // Bottom-right
        const newW = Math.max(1, pos.x - s.x);
        const newH = Math.max(1, pos.y - s.y);
        this._applyAspectRatio(s, newW, newH, 'br');
        break;
      }
    }
  }

  _updateCursorForPosition(pos) {
    if (this.stage !== 'configuring' && this.stage !== 'editing') return;
    if (!this.selection) {
      this.board.container.style.cursor = 'default';
      return;
    }

    const handle = this._getHandleAtPos(pos);
    if (!handle) {
      if (this._posInSelection(pos)) {
        this.board.container.style.cursor = 'grab';
      } else {
        this.board.container.style.cursor = 'default';
      }
      return;
    }

    // Cursor based on handle
    const cursorMap = {
      'tl': 'nwse-resize', 'tr': 'nesw-resize',
      'bl': 'nesw-resize', 'br': 'nwse-resize',
      'tm': 'ns-resize', 'bm': 'ns-resize',
      'ml': 'ew-resize', 'mr': 'ew-resize'
    };
    this.board.container.style.cursor = cursorMap[handle.id] || 'pointer';
  }

  _drawModeGuides(ctx, selection, axis) {
    // We use the shared static helper from Board to ensure consistency
    // with the persistent mirror guides.
    const region = {
      x: selection.x,
      y: selection.y,
      width: selection.width,
      height: selection.height,
      mode: axis,
      axis: axis,
      slices: this.options.slices,
      fibDepth: this.options.fibDepth
    };
    
    Board.drawMirrorGuide(ctx, region);
  }

  _refreshRegionControls() {
    if (!this.controlsLayer || !this.active) return;

    this.controlsLayer.innerHTML = '';
    for (const region of this.board.mirrorRegions || []) {
      this.controlsLayer.appendChild(this._createRegionControl(region));
    }
  }

  _createRegionControl(region) {
    const wrapper = document.createElement('div');
    wrapper.dataset.tut = 'mirror-region-controls';
    wrapper.style.position = 'absolute';
    wrapper.style.left = `${region.x + region.width - 120}px`;
    wrapper.style.top = `${Math.max(0, region.y - 28)}px`;
    wrapper.style.display = 'flex';
    wrapper.style.gap = '6px';
    wrapper.style.pointerEvents = 'none';

    wrapper.appendChild(this._createControlButton('Edit', () => this.startEditingRegion(region.id), 'rgba(17,24,39,0.92)'));
    wrapper.appendChild(this._createControlButton('Save', () => this.app.saveController?.openSaveDialogForRegion(region), 'rgba(30,64,175,0.92)'));
    wrapper.appendChild(this._createControlButton('X', () => this.removeRegion(region.id), 'rgba(127,29,29,0.95)'));

    return wrapper;
  }

  _createControlButton(label, onClick, background) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.pointerEvents = 'auto';
    button.style.minWidth = label === 'X' ? '24px' : '42px';
    button.style.height = '24px';
    button.style.padding = label === 'X' ? '0' : '0 8px';
    button.style.border = '1px solid rgba(255,255,255,0.18)';
    button.style.borderRadius = '999px';
    button.style.background = background;
    button.style.color = '#f8fafc';
    button.style.fontSize = '11px';
    button.style.cursor = 'pointer';
    button.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
    let lastPointerActivationAt = 0;
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      lastPointerActivationAt = performance.now();
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    button.addEventListener('click', (e) => {
      if (performance.now() - lastPointerActivationAt < 400) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return button;
  }

  _configurePanelForCreate() {
    if (this.panelTitle) this.panelTitle.textContent = 'Mirror Region';
    if (this.panelDescription) this.panelDescription.textContent = 'Choose how this area reflects strokes.';
    if (this.applyButton) this.applyButton.textContent = 'Apply';
  }

  _configurePanelForEdit() {
    if (this.panelTitle) this.panelTitle.textContent = 'Edit Mirror Region';
    if (this.panelDescription) this.panelDescription.textContent = 'Adjust how this region reflects strokes.';
    if (this.applyButton) this.applyButton.textContent = 'Save';
  }

  _syncSlicesVisibility() {
    if (!this.slicesRow) return;
    this.slicesRow.style.display = this.options.axis === 'radial' ? 'flex' : 'none';
    if (!this.fibDepthRow) return;
    this.fibDepthRow.style.display = this.options.axis === 'fib' ? 'flex' : 'none';
  }

  _normalizeSlices(value) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return 6;
    return Math.max(3, Math.min(16, parsed));
  }

  _normalizeFibDepth(value) {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return 4;
    return Math.max(1, Math.min(8, parsed));
  }

  _rescaleSelectionForMode() {
    if (!this.selection) return;
    const PHI = 1.6180339887;
    if (this.options.axis === 'fib') {
      this.selection.height = Math.round(this.selection.width / PHI);
    } else {
      const maxSize = Math.max(this.selection.width, this.selection.height);
      this.selection.width = maxSize;
      this.selection.height = maxSize;
    }
  }

  _applyAspectRatio(selection, newWidth, newHeight, corner) {
    const PHI = 1.6180339887;
    if (this.options.axis === 'fib') {
      // Fib: maintain golden ratio (width / height = 1.618)
      selection.width = newWidth;
      selection.height = Math.round(newWidth / PHI);
    } else {
      // Square: width == height, use larger dimension
      const size = Math.max(newWidth, newHeight);
      selection.width = size;
      selection.height = size;
    }
  }

  _buildRegionFromSelection(regionId = null) {
    if (!this.selection) return null;
    return {
      id: regionId || `mr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      x: Math.floor(this.selection.x),
      y: Math.floor(this.selection.y),
      width: Math.max(1, Math.floor(this.selection.width)),
      height: Math.max(1, Math.floor(this.selection.height)),
      mode: this.options.axis,
      axis: this.options.axis,
      slices: this.options.axis === 'radial' ? this._normalizeSlices(this.options.slices) : undefined,
      fibDepth: this.options.axis === 'fib' ? this._normalizeFibDepth(this.options.fibDepth) : undefined,
      showLine: this.options.showLine,
      owner: this.app.self?.id || null
    };
  }

  _syncEditingRegionPreview() {
    if (!this.active || this.stage !== 'editing' || !this.editingRegionId || !this.selection) return;
    const previewRegion = this._buildRegionFromSelection(this.editingRegionId);
    const signature = [
      previewRegion.x,
      previewRegion.y,
      previewRegion.width,
      previewRegion.height,
      previewRegion.mode,
      previewRegion.slices ?? '',
      previewRegion.fibDepth ?? '',
      previewRegion.showLine ? 1 : 0
    ].join('|');
    if (signature === this.lastEditingPreviewSignature) return;

    const nextRegions = (this.board.mirrorRegions || []).map(existing =>
      existing.id === this.editingRegionId ? { ...existing, ...previewRegion } : existing
    );
    this.lastEditingPreviewSignature = signature;
    this.board.setMirrorRegions(nextRegions);
  }

  _restoreOriginalEditingRegion() {
    if (!this.editingRegionId || !this.originalEditingRegion) return;
    const nextRegions = (this.board.mirrorRegions || []).map(existing =>
      existing.id === this.editingRegionId ? { ...existing, ...this.originalEditingRegion } : existing
    );
    this.board.setMirrorRegions(nextRegions);
    this.originalEditingRegion = null;
    this.lastEditingPreviewSignature = '';
  }

  _showMirrorCursor() {
    this.ui.showCursor();
    this.ui.showMirrorRegionCursor();
  }

  _shouldAllowPanGesture(e) {
    if (!this.active) return false;
    if (this.app.self?.tool === 'pan') return true;
    if (this.app.self?.panning) return true;
    if (e?.button === 1) return true;
    return typeof e?.buttons === 'number' && (e.buttons & 4) === 4;
  }

  _syncMirrorDisplay() {
    this.ui.updateMirrorDisplay(this.active || this.board.mirror);
    // Guides normally fade after ~1s idle; while the editor is open they are the
    // thing being edited, so hold them up.
    this.board.setMirrorGuidesPinned(this.active);
  }

  _getRegionById(regionId) {
    return (this.board.mirrorRegions || []).find(region => region.id === regionId) || null;
  }
}
