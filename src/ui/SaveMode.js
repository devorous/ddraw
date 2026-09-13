/**
 * @fileoverview Interactive save mode with visual selection on a board snapshot.
 * Allows users to select a region (or full board) before saving locally or to gallery.
 */

// Mirrors MAX_TAG_LENGTH in server/gallery.js. The server also caps a whole
// item at 12 tags; 'discord' is appended outside the field when that toggle is
// on, so the field itself stops one short.
const MAX_TAG_LENGTH = 24;
const MAX_USER_TAGS = 11;

export class SaveMode {
  /**
   * @param {Object} app - The main application instance
   */
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.ui = app.ui;

    // DOM elements (created dynamically)
    this.overlay = null;
    this.snapshotCanvas = null;
    this.selectionCanvas = null;
    this.snapshotCtx = null;
    this.selectionCtx = null;
    this.optionsPanel = null;

    // Selection state
    this.isActive = false;
    this.isSelecting = false;
    this.activeTool = 'select'; // 'select' or 'pan'
    this.mode = 'rectangle'; // 'rectangle' or 'lasso'
    this.startPos = null;
    this.selection = null; // { x, y, width, height }
    this.lassoPoints = [];

    // Pan/zoom state
    this._isPanning = false;
    this._lastPanX = 0;
    this._lastPanY = 0;
    this._activePointers = new Map();
    this._pinch = null;
    this.viewZoom = 1;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.defaultViewZoom = 1;
    this.defaultViewPanX = 0;
    this.defaultViewPanY = 0;

    // Marching ants animation
    this.marchingAntsOffset = 0;
    this.animationId = null;

    // Options state
    this.transparent = false;
    this.shareToDiscord = false;
    this.uploadTimelapse = true;
    this.galleryTitle = '';
    this.galleryDescription = '';
    this.galleryTags = [];
    // The seeded username chip. Keeping it is what tags the upload with the
    // author name; removing it uploads as Anonymous.
    this.usernameTag = '';
    this.preExistingCanvasFixedSelection = false;
    this.step = 'main'; // 'main' or 'gallery'

    // Gallery time-lapse preview state. Two sources: 'stills' uses the sparse
    // TimelapseCapturer frames (long sessions); 'tape' renders the rolling DVR
    // tape through TimeLapseExporter (short sessions the capturer barely saw).
    // The FULL clip is encoded once (`blob`); trimming is a pure playback
    // window [playStart, playEnd] over that clip, and only at upload is the
    // trimmed range encoded — once. `timing` maps trim-slider units to clip
    // seconds; `trimMax` is the slider ceiling (stills: last frame index,
    // tape: span seconds). `gen` invalidates in-flight crop/encode work.
    this._tl = {
      source: null,
      frames: null,
      tape: null,
      region: null,
      regionKey: null,
      trimStart: 0,
      trimEnd: 0,
      trimMax: 0,
      timing: null,
      playStart: 0,
      playEnd: Infinity,
      blob: null,
      url: null,
      gen: 0,
      encodePromise: null,
      exporter: null,
    };

    this._createElements();
    this._setupEventListeners();
  }

  /**
   * Creates the save mode overlay elements.
   */
  _createElements() {
    // Main overlay container
    this.overlay = document.createElement('div');
    this.overlay.id = 'saveModeInteractive';
    this.overlay.className = 'saveModeInteractive';
    this.overlay.style.display = 'none';

    // Snapshot canvas (shows the board snapshot with dark overlay)
    this.snapshotCanvas = document.createElement('canvas');
    this.snapshotCanvas.className = 'saveModeSnapshot';

    // Selection canvas (for drawing selection UI on top)
    this.selectionCanvas = document.createElement('canvas');
    this.selectionCanvas.className = 'saveModeSelection';

    // Top controls
    const controls = document.createElement('div');
    controls.className = 'saveModeControls';
    controls.innerHTML = `
      <div class="saveModeModeToggle">
        <button class="saveModeToggleBtn active" data-tool="select" data-mode="rectangle" title="Rectangle Selection">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="2" width="14" height="14" rx="1"/>
          </svg>
        </button>
        <button class="saveModeToggleBtn" data-tool="select" data-mode="lasso" title="Lasso Selection">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 2C5 2 2 5 2 9C2 13 5 16 9 16C11 16 13 15 14 13"/>
            <circle cx="14" cy="13" r="2"/>
          </svg>
        </button>
        <button class="saveModeToggleBtn" data-tool="pan" title="Pan View">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 2.5V15.5"/>
            <path d="M2.5 9H15.5"/>
            <path d="M9 2.5L7.2 4.3"/>
            <path d="M9 2.5L10.8 4.3"/>
            <path d="M9 15.5L7.2 13.7"/>
            <path d="M9 15.5L10.8 13.7"/>
            <path d="M2.5 9L4.3 7.2"/>
            <path d="M2.5 9L4.3 10.8"/>
            <path d="M15.5 9L13.7 7.2"/>
            <path d="M15.5 9L13.7 10.8"/>
          </svg>
        </button>
      </div>
      <div class="saveModeZoomControls">
        <button class="saveModeZoomBtn" id="saveModeZoomOut" title="Zoom Out">-</button>
        <button class="saveModeZoomResetBtn" id="saveModeZoomReset" title="Reset View">100%</button>
        <button class="saveModeZoomBtn" id="saveModeZoomIn" title="Zoom In">+</button>
      </div>
    `;

    // Options panel (shown after selection or for full board)
    this.optionsPanel = document.createElement('div');
    this.optionsPanel.className = 'saveModeOptionsPanel';
    this.optionsPanel.innerHTML = `
      <div class="saveModeStep saveModeStepMain">
        <div class="saveModeOptionsInfo">
          <span class="saveModeOptionsHint">Draw a selection or save the entire canvas</span>
          <span class="saveModeSelectionInfo"></span>
        </div>
        <label class="saveModeOptionsCheckbox">
          <input type="checkbox" id="saveModeTransparent">
          <span>Transparent background</span>
        </label>
        <div class="saveModeOptionsActions">
          <button class="btn secondary" id="saveModeCancelInteractive">Cancel</button>
          <button class="btn secondary" id="saveModeCopyInteractive">Copy</button>
          <button class="btn secondary" id="saveModeGalleryInteractive">Save to Gallery</button>
          <button class="btn primary" id="saveModeLocalInteractive">Save Locally</button>
        </div>
      </div>
      <div class="saveModeStep saveModeStepGallery" hidden>
        <div class="saveModeGalleryFields">
          <label class="saveModeField">
            <span>Title</span>
            <input id="saveModeTitle" type="text" maxlength="60" />
          </label>
          <div class="saveModeGalleryToggles">
            <label class="saveModeOptionsCheckbox">
              <input type="checkbox" id="saveModeShareDiscord">
              <span>Share to Discord</span>
            </label>
            <label class="saveModeOptionsCheckbox saveModeTimelapseToggle" hidden>
              <input type="checkbox" id="saveModeUploadTimelapse" checked>
              <span>Upload Timelapse</span>
            </label>
          </div>
          <div class="saveModeField saveModeTagsField">
            <span>Tags</span>
            <div class="saveModeTagInput" id="saveModeTagInput">
              <input id="saveModeTagEntry" type="text" maxlength="24" autocomplete="off"
                     placeholder="Type something and press Enter" />
            </div>
          </div>
          <label class="saveModeField saveModeDescriptionField">
            <span>Description</span>
            <textarea id="saveModeDescription" maxlength="300" rows="2" placeholder="This thing I drew is cool because..."></textarea>
          </label>
          <p class="saveModeGuestNote" id="saveModeGuestNote" hidden>
            You're not signed in — this uploads as Anonymous, and you won't be able to edit or delete it later.
          </p>
        </div>
        <div class="saveModeOptionsActions">
          <button class="btn secondary" id="saveModeGalleryBack">Back</button>
          <button class="btn primary" id="saveModeGalleryUpload">Upload to Gallery</button>
        </div>
      </div>
    `;

    // Time-lapse preview window — floats above the options panel during the
    // gallery step. Separate from the form so the preview can be big.
    this.timelapseWindow = document.createElement('div');
    this.timelapseWindow.className = 'saveModeTimelapseWindow';
    this.timelapseWindow.hidden = true;
    this.timelapseWindow.innerHTML = `
      <div class="saveModeTimelapseHeader">
        <span>Time-lapse</span>
        <span class="saveModeTimelapseFrames"></span>
      </div>
      <div class="saveModeTimelapsePreview">
        <video class="saveModeTimelapseVideo" loop autoplay playsinline hidden></video>
        <div class="saveModeTimelapseSpinner">
          <span class="saveModeTimelapseSpinnerIcon"></span>
          <span class="saveModeTimelapseSpinnerText">Generating time-lapse…</span>
        </div>
      </div>
      <div class="saveModeTimelapseTrim">
        <label><span>Start</span><input type="range" id="saveModeTrimStart" min="0" max="1" step="1" value="0"></label>
        <label><span>End</span><input type="range" id="saveModeTrimEnd" min="0" max="1" step="1" value="1"></label>
      </div>
    `;

    // Close button (top right)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'saveModeCloseBtn';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Cancel (Escape)';

    this.overlay.appendChild(this.snapshotCanvas);
    this.overlay.appendChild(this.selectionCanvas);
    this.overlay.appendChild(controls);
    this.overlay.appendChild(this.timelapseWindow);
    this.overlay.appendChild(this.optionsPanel);
    this.overlay.appendChild(closeBtn);

    // Insert into the top-level document layer so the save UI can stack above
    // other fixed overlays such as history/snapshot modals.
    if (document.body) {
      document.body.appendChild(this.overlay);
    } else {
      console.warn('[SaveMode] document.body not found, deferring DOM insertion');
    }

    // Get contexts
    this.snapshotCtx = this.snapshotCanvas.getContext('2d');
    this.snapshotCtx.imageSmoothingEnabled = true;
    this.snapshotCtx.imageSmoothingQuality = 'high';
    this.selectionCtx = this.selectionCanvas.getContext('2d');

    // Store references
    this.controls = controls;
    this.modeToggle = controls.querySelector('.saveModeModeToggle');
    this.zoomOutBtn = controls.querySelector('#saveModeZoomOut');
    this.zoomResetBtn = controls.querySelector('#saveModeZoomReset');
    this.zoomInBtn = controls.querySelector('#saveModeZoomIn');
    this.closeBtn = closeBtn;
    this.stepMain = this.optionsPanel.querySelector('.saveModeStepMain');
    this.stepGallery = this.optionsPanel.querySelector('.saveModeStepGallery');
    this.selectionInfo = this.optionsPanel.querySelector('.saveModeSelectionInfo');
    this.timelapseBlock = this.timelapseWindow;
    this.timelapseVideo = this.timelapseWindow.querySelector('.saveModeTimelapseVideo');
    this.timelapseSpinner = this.timelapseWindow.querySelector('.saveModeTimelapseSpinner');
    this.timelapseSpinnerText = this.timelapseWindow.querySelector('.saveModeTimelapseSpinnerText');
    this.timelapseFramesLabel = this.timelapseWindow.querySelector('.saveModeTimelapseFrames');
    this.trimStartInput = this.timelapseWindow.querySelector('#saveModeTrimStart');
    this.trimEndInput = this.timelapseWindow.querySelector('#saveModeTrimEnd');
    this.uploadTimelapseCheckbox = this.optionsPanel.querySelector('#saveModeUploadTimelapse');
    this.uploadTimelapseToggle = this.optionsPanel.querySelector('.saveModeTimelapseToggle');
    // Set the property (not just the attribute) so autoplay is allowed.
    if (this.timelapseVideo) this.timelapseVideo.muted = true;

    // Keep the time-lapse window stacked just above the options panel, whose
    // height changes as the user types/resizes the description.
    if (typeof ResizeObserver === 'function') {
      this._panelResizeObserver = new ResizeObserver(() => this._positionTimelapseWindow());
      this._panelResizeObserver.observe(this.optionsPanel);
    }
  }

  /**
   * Sets up event listeners for the save mode.
   */
  _setupEventListeners() {
    // Mode toggle buttons
    this.modeToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.saveModeToggleBtn');
      if (!btn) return;
      if (btn.dataset.tool === 'pan') {
        this.setActiveTool('pan');
        return;
      }

      this.setMode(btn.dataset.mode);
      this.setActiveTool('select');
    });

    this.zoomOutBtn.addEventListener('click', () => this._zoomByStep(-0.1));
    this.zoomInBtn.addEventListener('click', () => this._zoomByStep(0.1));
    this.zoomResetBtn.addEventListener('click', () => this.resetView());

    // Selection canvas pointer events
    this.selectionCanvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.selectionCanvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.selectionCanvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.selectionCanvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));
    this.selectionCanvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));

    // Wheel events for zooming
    this.selectionCanvas.addEventListener('wheel', (e) => this._onWheel(e));

    // Close button
    this.closeBtn.addEventListener('click', () => this.close());

    // Options panel buttons
    this.optionsPanel.querySelector('#saveModeCancelInteractive').addEventListener('click', () => this.close());
    this.optionsPanel.querySelector('#saveModeCopyInteractive').addEventListener('click', () => this._performCopy());
    this.optionsPanel.querySelector('#saveModeLocalInteractive').addEventListener('click', () => this._performSave(true));
    this.optionsPanel.querySelector('#saveModeGalleryInteractive').addEventListener('click', () => this._openGalleryStep());
    this.optionsPanel.querySelector('#saveModeGalleryBack').addEventListener('click', () => this._showStep('main'));
    this.optionsPanel.querySelector('#saveModeGalleryUpload').addEventListener('click', () => this._performSave(false));

    // Transparent checkbox
    this.optionsPanel.querySelector('#saveModeTransparent').addEventListener('change', (e) => {
      this.transparent = e.target.checked;
      this._drawSnapshot();
    });

    this.optionsPanel.querySelector('#saveModeShareDiscord').addEventListener('change', (e) => {
      this.shareToDiscord = e.target.checked;
    });

    this.titleInput = this.optionsPanel.querySelector('#saveModeTitle');
    this.titleInput?.addEventListener('input', (e) => {
      this.galleryTitle = e.target.value;
    });
    this.titleInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._performSave(false);
    });

    this.descriptionInput = this.optionsPanel.querySelector('#saveModeDescription');
    this.descriptionInput?.addEventListener('input', (e) => {
      this.galleryDescription = e.target.value;
    });

    // Tag chip input. Enter/comma commits the pending text; Backspace on an
    // empty field pops the last chip, the usual chip-input muscle memory.
    this.guestNote = this.optionsPanel.querySelector('#saveModeGuestNote');
    this.tagInputWrap = this.optionsPanel.querySelector('#saveModeTagInput');
    this.tagEntryInput = this.optionsPanel.querySelector('#saveModeTagEntry');
    this.tagEntryInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        // Enter on an empty field falls through to uploading, matching the
        // title field's behaviour.
        if (!this.tagEntryInput.value.trim()) {
          if (e.key === 'Enter') this._performSave(false);
          return;
        }
        this._commitTagEntry();
      } else if (e.key === 'Backspace' && !this.tagEntryInput.value) {
        this._removeTag(this.galleryTags[this.galleryTags.length - 1]);
      }
    });
    // Commit whatever is typed when focus leaves, so a half-entered tag isn't
    // silently dropped on upload.
    this.tagEntryInput?.addEventListener('blur', () => this._commitTagEntry());
    this.tagEntryInput?.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (!text || !/[,\n]/.test(text)) return;
      e.preventDefault();
      this._addTags(text.split(/[,\n]/));
    });
    // Remove on mousedown, not click: the entry field's blur handler can commit
    // a pending tag and re-render the chips, detaching the one being clicked
    // before its click event ever lands. preventDefault also keeps focus in the
    // field so the user can keep typing.
    this.tagInputWrap?.addEventListener('mousedown', (e) => {
      const chip = e.target.closest('.saveModeTagChip');
      if (!chip) return;
      e.preventDefault();
      this._removeTag(chip.dataset.tag);
    });
    this.tagInputWrap?.addEventListener('click', (e) => {
      // The whole chip is the remove target, not just its ×. Reached only by
      // keyboard activation; a mouse chip click is already handled above.
      const chip = e.target.closest('.saveModeTagChip');
      if (chip) {
        this._removeTag(chip.dataset.tag);
        return;
      }
      this.tagEntryInput?.focus();
    });

    this.trimStartInput?.addEventListener('input', () => this._onTrimInput('start'));
    this.trimEndInput?.addEventListener('input', () => this._onTrimInput('end'));
    this.uploadTimelapseCheckbox?.addEventListener('change', (e) => this._setUploadTimelapse(e.target.checked));

    // Trim is a playback window over the fully-encoded clip — no re-encode.
    // Native `loop` wraps to t=0; both that and overshooting the trim end are
    // snapped back to the window start here.
    this.timelapseVideo?.addEventListener('timeupdate', () => {
      const v = this.timelapseVideo;
      const { playStart = 0, playEnd = Infinity } = this._tl;
      if (!v || v.hidden || !this._tl.source) return;
      if (v.currentTime < playStart - 0.05 || v.currentTime >= playEnd) {
        try { v.currentTime = playStart; } catch { /* not seekable yet */ }
      }
    });
    this.timelapseVideo?.addEventListener('loadedmetadata', () => this._updatePlaybackWindow());

    // Escape steps back out of the gallery form, then closes the overlay
    this._keyHandler = (e) => {
      if (e.key === 'Escape' && this.isActive) {
        if (this.step === 'gallery') {
          this._showStep('main');
        } else {
          this.close();
        }
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  /**
   * Switches the bottom sheet between the main and gallery steps.
   * @param {'main'|'gallery'} step
   */
  _showStep(step) {
    this.step = step;
    if (this.stepMain) this.stepMain.hidden = step !== 'main';
    if (this.stepGallery) this.stepGallery.hidden = step !== 'gallery';
    // The time-lapse window only accompanies the gallery form; its state is
    // kept so returning to the step doesn't re-render an unchanged crop.
    if (this.timelapseWindow && step !== 'gallery') this.timelapseWindow.hidden = true;
  }

  /**
   * Opens the gallery details step. Signing in is not required — a logged-out
   * user uploads as a guest, credited to "Anonymous" with no author chip.
   */
  _openGalleryStep() {
    this._showStep('gallery');
    // Guests may upload, but the item is unowned afterwards — say so up front.
    if (this.guestNote) this.guestNote.hidden = !!localStorage.getItem('topDrawAuthToken');
    // The toggle is only shown to entitled users; everyone else keeps the
    // plain form and never generates a clip.
    if (this.uploadTimelapseToggle) {
      this.uploadTimelapseToggle.hidden = !this.app.canUseGalleryTimelapse?.();
    }
    if (this.uploadTimelapseCheckbox) this.uploadTimelapseCheckbox.checked = this.uploadTimelapse;
    // Render the time-lapse preview in the background while the user types the
    // title/description, so it's usually ready before they hit Upload.
    if (this.uploadTimelapse) this._beginTimelapsePreview();
  }

  /**
   * Normalises one tag the same way the gallery API does, so the chips show
   * exactly what will be stored. See normalizeTags() in server/gallery.js.
   * @param {string} raw
   * @returns {string} normalised tag, or '' if nothing usable remains
   */
  _normalizeTag(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      // The server rejects over-long tags outright; truncating here keeps a
      // pasted tag usable rather than silently dropping it on upload.
      .slice(0, MAX_TAG_LENGTH)
      .replace(/-$/, '');
  }

  /**
   * Adds tags from raw user input, skipping blanks and duplicates.
   * @param {string[]} rawTags
   */
  _addTags(rawTags) {
    let added = false;
    let full = false;

    for (const raw of rawTags) {
      const tag = this._normalizeTag(raw);
      if (!tag || this.galleryTags.includes(tag)) continue;
      if (this.galleryTags.length >= MAX_USER_TAGS) {
        full = true;
        break;
      }
      this.galleryTags.push(tag);
      added = true;
    }

    if (full) this.ui.showToast?.(`Up to ${MAX_USER_TAGS} tags`, 2000, 'error');
    if (added) this._renderTagChips();
  }

  /**
   * Commits whatever is currently typed in the tag entry field.
   */
  _commitTagEntry() {
    if (!this.tagEntryInput) return;
    const pending = this.tagEntryInput.value;
    if (!pending.trim()) {
      this.tagEntryInput.value = '';
      return;
    }
    this._addTags(pending.split(','));
    this.tagEntryInput.value = '';
  }

  /**
   * @param {string} tag
   */
  _removeTag(tag) {
    if (!tag) return;
    const index = this.galleryTags.indexOf(tag);
    if (index === -1) return;
    this.galleryTags.splice(index, 1);
    this._renderTagChips();
  }

  /**
   * Re-renders the chip list in front of the tag entry field.
   */
  _renderTagChips() {
    if (!this.tagInputWrap || !this.tagEntryInput) return;

    for (const chip of this.tagInputWrap.querySelectorAll('.saveModeTagChip')) {
      chip.remove();
    }

    for (const tag of this.galleryTags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      // The username chip is also the attribution control, so it says so —
      // removing it is what credits the upload to "Anonymous" instead.
      const isAuthorChip = !!this.usernameTag && tag === this.usernameTag;
      chip.className = isAuthorChip ? 'saveModeTagChip saveModeTagChipAuthor' : 'saveModeTagChip';
      chip.dataset.tag = tag;
      chip.title = isAuthorChip
        ? `Remove ${tag} to upload anonymously`
        : `Remove ${tag}`;
      chip.setAttribute('aria-label', isAuthorChip
        ? `Remove tag ${tag} and upload anonymously`
        : `Remove tag ${tag}`);
      const label = document.createElement('span');
      label.className = 'saveModeTagChipLabel';
      label.textContent = tag;
      // Affordance only — the click is handled on the chip itself.
      const remove = document.createElement('span');
      remove.className = 'saveModeTagChipRemove';
      remove.textContent = '×';
      remove.setAttribute('aria-hidden', 'true');
      chip.append(label, remove);
      this.tagInputWrap.insertBefore(chip, this.tagEntryInput);
    }
  }

  /**
   * Resets the tag field to its defaults — the author's username and the
   * current room — which the user can then remove or add to. Used by both
   * open paths, so re-entering the gallery step keeps their edits.
   */
  _resetTags() {
    this.usernameTag = this._normalizeTag(
      this.app.auth?.loggedInUsername || this.app.auth?.getStoredUsername?.() || ''
    );
    // wsClient has no public `roomId` — the app tracks the joined room as
    // `currentRoomId` (falls back through currentRoomData.id for parity with
    // how the rest of the app reads the room, then 'lobby' if truly none).
    // Draw Alone has no shared room, and its id is a throwaway
    // `offline-<timestamp>`, so seed no room tag at all there.
    const roomTag = this.app.isOfflineMode
      ? ''
      : this._normalizeTag(
          this.app.currentRoomId || this.app.currentRoomData?.id || 'lobby'
        );

    this.galleryTags = [];
    for (const tag of [this.usernameTag, roomTag]) {
      if (tag && !this.galleryTags.includes(tag)) this.galleryTags.push(tag);
    }

    if (this.tagEntryInput) this.tagEntryInput.value = '';
    this._renderTagChips();
  }

  /**
   * Set whether a time-lapse is generated and attached to this upload.
   * On by default; unchecking hides the preview window and suppresses the
   * attach entirely (including SaveController's fallback render).
   */
  _setUploadTimelapse(enabled) {
    this.uploadTimelapse = !!enabled;
    if (this.uploadTimelapse) this._beginTimelapsePreview();
    else this._resetTimelapsePreview();
  }

  /**
   * Updates the selection size readout in the bottom sheet.
   */
  _updateSelectionInfo() {
    if (!this.selectionInfo) return;

    if (this.selection && this.selection.width > 0 && this.selection.height > 0) {
      const w = Math.max(1, Math.round(this.selection.width));
      const h = Math.max(1, Math.round(this.selection.height));
      this.selectionInfo.textContent = `Selection · ${w} × ${h} px`;
    } else {
      const w = this.snapshotCanvas.width;
      const h = this.snapshotCanvas.height;
      const label = this.preExistingCanvas ? 'Full image' : 'Full board';
      this.selectionInfo.textContent = `${label} · ${w} × ${h} px`;
    }
  }

  /**
   * Opens the save mode with the selection preset to a mirror region's exact
   * bounds, so it doesn't have to be traced by hand. Used by the region's
   * "Select" control in MirrorRegionController.
   * @param {{x:number,y:number,width:number,height:number}} region - board px
   */
  openWithRegion(region) {
    this.open();
    if (!region) return;

    this.mode = 'rectangle';
    this.activeTool = 'select';
    this.lassoPoints = [];
    this.selection = { x: region.x, y: region.y, width: region.width, height: region.height };

    this._drawSnapshot();
    this._drawSelection();
    this._updateSelectionInfo();
    this._syncControlState();
  }

  /**
   * Opens the save mode, taking a snapshot of the current board.
   */
  open() {
    if (this.isActive) return;
    this.isActive = true;

    // Ensure overlay is in DOM (in case document.body wasn't available at construction)
    if (!this.overlay.parentNode) {
      if (document.body) {
        document.body.appendChild(this.overlay);
      }
    }

    // Reset state
    this.selection = null;
    this.lassoPoints = [];
    this.preExistingCanvas = null;
    this.preExistingCanvasFixedSelection = false;
    this.preExistingCanvasRegion = null;
    this._onCloseCallback = null;
    this.transparent = false;
    this.shareToDiscord = false;
    this.uploadTimelapse = true;
    this.galleryTitle = '';
    this.galleryDescription = '';
    this.activeTool = 'select';
    this.optionsPanel.querySelector('#saveModeTransparent').checked = false;
    this.optionsPanel.querySelector('#saveModeShareDiscord').checked = false;
    if (this.titleInput) this.titleInput.value = '';
    if (this.descriptionInput) this.descriptionInput.value = '';
    this._resetTags();
    this._resetTimelapsePreview();
    this._showStep('main');

    // Size canvases to match board
    const [height, width] = this.board.dimensions;
    this.snapshotCanvas.width = width;
    this.snapshotCanvas.height = height;
    this.selectionCanvas.width = width;
    this.selectionCanvas.height = height;
    this._updateSelectionInfo();

    // Take snapshot and draw with overlay
    this._drawSnapshot();

    // Show overlay
    this.overlay.style.display = 'flex';

    // Start marching ants animation
    this._startMarchingAnts();

    this._setView(this.board.zoom || 1, this.board.panX || 0, this.board.panY || 0, true);
    this._syncControlState();
  }

  /**
   * Sets the selection mode.
   * @param {string} mode - 'rectangle' or 'lasso'
   */
  setMode(mode) {
    this.mode = mode;
    // Clear any existing selection when switching modes
    if (this.selection) {
      this.selection = null;
      this.lassoPoints = [];
      this._drawSnapshot();
      this._drawSelection();
      this._updateSelectionInfo();
    }
    this._syncControlState();
  }

  /**
   * Sets the active interaction tool.
   * @param {'select'|'pan'} tool
   */
  setActiveTool(tool) {
    this.activeTool = tool;
    this._updateCursor();
    this._syncControlState();
  }

  /**
   * Updates canvas transform to match board zoom/pan.
   */
  _updateCanvasTransform() {
    const transform = `translate(${this.viewPanX}px, ${this.viewPanY}px) scale(${this.viewZoom})`;
    this.snapshotCanvas.style.transform = transform;
    this.selectionCanvas.style.transform = transform;
  }

  _setView(zoom, panX, panY, updateDefault = false) {
    this.viewZoom = Math.max(0.2, Math.min(3, zoom));
    this.viewPanX = panX;
    this.viewPanY = panY;
    if (updateDefault) {
      this.defaultViewZoom = this.viewZoom;
      this.defaultViewPanX = this.viewPanX;
      this.defaultViewPanY = this.viewPanY;
    }
    this._updateCanvasTransform();
    this._syncControlState();
  }

  _zoomTo(nextZoom, pivot = null) {
    const clampedZoom = Math.max(0.2, Math.min(3, Math.round(nextZoom * 10) / 10));
    if (clampedZoom === this.viewZoom) return;

    let nextPanX = this.viewPanX;
    let nextPanY = this.viewPanY;

    if (pivot) {
      const canvasX = (pivot.x - this.viewPanX) / this.viewZoom;
      const canvasY = (pivot.y - this.viewPanY) / this.viewZoom;
      nextPanX = pivot.x - (canvasX * clampedZoom);
      nextPanY = pivot.y - (canvasY * clampedZoom);
    }

    this._setView(clampedZoom, nextPanX, nextPanY);
  }

  _zoomByStep(step) {
    const overlayRect = this.overlay.getBoundingClientRect();
    this._zoomTo(this.viewZoom + step, {
      x: overlayRect.width / 2,
      y: overlayRect.height / 2
    });
  }

  resetView() {
    this._setView(this.defaultViewZoom, this.defaultViewPanX, this.defaultViewPanY);
  }

  _syncControlState() {
    if (!this.controls) return;

    this.modeToggle.querySelectorAll('.saveModeToggleBtn').forEach((btn) => {
      const tool = btn.dataset.tool;
      const mode = btn.dataset.mode;
      const isActive = tool === 'pan'
        ? this.activeTool === 'pan'
        : this.activeTool === 'select' && mode === this.mode;
      btn.classList.toggle('active', isActive);
    });

    if (this.zoomResetBtn) {
      this.zoomResetBtn.textContent = `${Math.round(this.viewZoom * 100)}%`;
    }

    this._updateCursor();
  }

  _updateCursor() {
    if (!this.selectionCanvas) return;
    if (this._isPanning) {
      this.selectionCanvas.style.cursor = 'grabbing';
      return;
    }
    this.selectionCanvas.style.cursor = this.activeTool === 'pan' ? 'grab' : 'crosshair';
  }

  /**
   * Draws the board snapshot with dark overlay on non-selected areas.
   */
  _drawSnapshot() {
    // If we have a pre-existing canvas, use that instead
    if (this.preExistingCanvas) {
      this._drawPreExistingSnapshot();
      return;
    }

    const ctx = this.snapshotCtx;
    const [height, width] = this.board.dimensions;

    // Clear
    ctx.clearRect(0, 0, width, height);
    this._drawBoardPreview(ctx, 0, 0, width, height);

    // Only draw dark overlay if there's a selection (to highlight what's selected)
    const hasRectSelection = this.selection && this.selection.width > 0 && this.selection.height > 0;
    const hasLassoSelection = this.lassoPoints.length > 2;

    if (hasRectSelection || hasLassoSelection) {
      // Draw dark overlay
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(0, 0, width, height);

      // Cut through the overlay to show the selected area
      if (hasRectSelection) {
        this._drawSelectionCutout();
      } else if (hasLassoSelection) {
        this._drawLassoCutout();
      }
    }
  }

  /**
   * Draws a checkerboard pattern to indicate transparency.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   */
  _drawCheckerboard(ctx, x, y, w, h) {
    const size = 16;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#cccccc';

    for (let row = 0; row < Math.ceil(h / size); row++) {
      for (let col = 0; col < Math.ceil(w / size); col++) {
        if ((row + col) % 2 === 0) {
          ctx.fillRect(x + col * size, y + row * size, size, size);
        }
      }
    }
  }

  _drawRoomBackground(ctx, x, y, w, h) {
    const [r, g, b, a] = this.board.backgroundColor;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    ctx.fillRect(x, y, w, h);
  }

  _drawBoardPreview(ctx, x, y, w, h) {
    if (this.transparent) {
      this._drawCheckerboard(ctx, x, y, w, h);
      this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), null);
      return;
    }

    // Mirror the export behavior for opaque saves by previewing the board over
    // the room background color rather than a transparency checkerboard.
    // The pooled full raster rather than getExportCanvas: this runs on every
    // render of the dialog, and a board-sized allocation per frame is the
    // measured stall.
    this.board.withFullRaster((raster) => ctx.drawImage(raster, 0, 0));
  }

  _drawCanvasPreview(ctx, canvas, x, y, w, h) {
    if (this.transparent) {
      this._drawCheckerboard(ctx, x, y, w, h);
    } else {
      this._drawRoomBackground(ctx, x, y, w, h);
    }
    ctx.drawImage(canvas, 0, 0);
  }

  /**
   * Draws the selection cutout (shows the selected area without dark overlay).
   */
  _drawSelectionCutout() {
    const ctx = this.snapshotCtx;
    const s = this.selection;

    // Save the dark overlay state
    ctx.save();

    // Use destination-out to clear the overlay in the selection area
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx.fillRect(s.x, s.y, s.width, s.height);

    ctx.restore();

    // Redraw just the selection area content on top
    ctx.save();
    ctx.beginPath();
    ctx.rect(s.x, s.y, s.width, s.height);
    ctx.clip();

    // Clear and redraw this region
    ctx.clearRect(s.x, s.y, s.width, s.height);
    this._drawBoardPreview(ctx, s.x, s.y, s.width, s.height);

    ctx.restore();
  }

  /**
   * Draws the lasso cutout (shows the lasso-selected area without dark overlay).
   */
  _drawLassoCutout() {
    if (this.lassoPoints.length < 3) return;

    const ctx = this.snapshotCtx;
    const points = this.lassoPoints;

    // Get bounding box
    const bounds = this._getLassoBounds();

    ctx.save();

    // Use destination-out to clear the overlay in the lasso area
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // Redraw the lasso area content
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.clip();

    ctx.clearRect(bounds.x, bounds.y, bounds.width, bounds.height);
    this._drawBoardPreview(ctx, bounds.x, bounds.y, bounds.width, bounds.height);

    ctx.restore();
  }

  /**
   * Gets the bounding box of the lasso points.
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  _getLassoBounds() {
    if (this.lassoPoints.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const p of this.lassoPoints) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.ceil(maxX - minX),
      height: Math.ceil(maxY - minY)
    };
  }

  /**
   * Draws the selection outline (marching ants) on the selection canvas.
   */
  _drawSelection() {
    const ctx = this.selectionCtx;
    const width = this.selectionCanvas.width;
    const height = this.selectionCanvas.height;

    ctx.clearRect(0, 0, width, height);

    if (this.mode === 'rectangle' && this.selection && this.selection.width > 0 && this.selection.height > 0) {
      const s = this.selection;

      // Draw marching ants
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.width, s.height);

      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.width, s.height);

      ctx.setLineDash([]);
    } else if (this.mode === 'lasso' && this.lassoPoints.length > 1) {
      const points = this.lassoPoints;

      // Draw marching ants path
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -this.marchingAntsOffset;

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      if (!this.isSelecting && points.length > 2) {
        ctx.closePath();
      }
      ctx.stroke();

      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      if (!this.isSelecting && points.length > 2) {
        ctx.closePath();
      }
      ctx.stroke();

      ctx.setLineDash([]);
    }
  }

  /**
   * Converts screen coordinates to canvas coordinates.
   * @param {PointerEvent} e
   * @returns {{x: number, y: number}}
   */
  _getCanvasPos(e) {
    const overlayRect = this.overlay.getBoundingClientRect();

    // Get pointer position relative to overlay
    const screenX = e.clientX - overlayRect.left;
    const screenY = e.clientY - overlayRect.top;

    // Reverse the transform: remove pan then unscale
    const canvasX = (screenX - this.viewPanX) / this.viewZoom;
    const canvasY = (screenY - this.viewPanY) / this.viewZoom;

    return { x: canvasX, y: canvasY };
  }

  /**
   * Handles wheel events for zooming.
   * @param {WheelEvent} e
   */
  _onWheel(e) {
    e.preventDefault();

    // Get cursor position for zoom center
    const overlayRect = this.overlay.getBoundingClientRect();
    const cursorX = e.clientX - overlayRect.left;
    const cursorY = e.clientY - overlayRect.top;

    this._zoomTo(this.viewZoom + (e.deltaY > 0 ? -0.1 : 0.1), { x: cursorX, y: cursorY });
  }

  /**
   * Starts a two-finger pinch gesture, cancelling any in-progress selection.
   */
  _beginPinch() {
    if (this.isSelecting) {
      this.isSelecting = false;
      this.selection = null;
      this.lassoPoints = [];
      this._drawSnapshot();
      this._drawSelection();
      this._updateSelectionInfo();
    }
    this._isPanning = false;

    const pts = [...this._activePointers.values()];
    const overlayRect = this.overlay.getBoundingClientRect();
    this._pinch = {
      dist: Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
      mid: {
        x: (pts[0].x + pts[1].x) / 2 - overlayRect.left,
        y: (pts[0].y + pts[1].y) / 2 - overlayRect.top
      },
      zoom: this.viewZoom,
      panX: this.viewPanX,
      panY: this.viewPanY
    };
  }

  /**
   * Applies zoom/pan from the current two-finger pinch state.
   */
  _updatePinch() {
    const pts = [...this._activePointers.values()];
    const overlayRect = this.overlay.getBoundingClientRect();
    const dist = Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
    const mid = {
      x: (pts[0].x + pts[1].x) / 2 - overlayRect.left,
      y: (pts[0].y + pts[1].y) / 2 - overlayRect.top
    };

    const zoom = Math.max(0.2, Math.min(3, this._pinch.zoom * (dist / this._pinch.dist)));

    // Keep the board point that was under the initial midpoint pinned to the
    // current midpoint, so zoom and two-finger pan combine naturally.
    const canvasX = (this._pinch.mid.x - this._pinch.panX) / this._pinch.zoom;
    const canvasY = (this._pinch.mid.y - this._pinch.panY) / this._pinch.zoom;
    this._setView(zoom, mid.x - canvasX * zoom, mid.y - canvasY * zoom);
  }

  /**
   * Handles pointer down events on the selection canvas.
   * @param {PointerEvent} e
   */
  _onPointerDown(e) {
    // Two-finger touch: switch to pinch zoom/pan, cancelling any in-progress selection
    if (e.pointerType === 'touch') {
      this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.selectionCanvas.setPointerCapture(e.pointerId);
      if (this._activePointers.size === 2) {
        this._beginPinch();
        return;
      }
    }

    // Check if we're in pan mode (Space held or middle-click)
    const isPanning = this.activeTool === 'pan' || this.app.self.panning || e.button === 1;

    if (isPanning) {
      // Start pan mode
      this._isPanning = true;
      this._lastPanX = e.clientX;
      this._lastPanY = e.clientY;
      this._updateCursor();
      this.selectionCanvas.setPointerCapture(e.pointerId);
      return;
    }

    const pos = this._getCanvasPos(e);
    this.isSelecting = true;
    this.startPos = pos;

    if (this.mode === 'rectangle') {
      this.selection = { x: pos.x, y: pos.y, width: 0, height: 0 };
    } else {
      this.lassoPoints = [{ x: pos.x, y: pos.y }];
    }

    this.selectionCanvas.setPointerCapture(e.pointerId);
  }

  /**
   * Handles pointer move events on the selection canvas.
   * @param {PointerEvent} e
   */
  _onPointerMove(e) {
    if (this._activePointers.has(e.pointerId)) {
      this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Handle pinch zoom/pan
    if (this._pinch) {
      if (this._activePointers.size >= 2) this._updatePinch();
      return;
    }

    // Handle panning
    if (this._isPanning) {
      const dx = e.clientX - this._lastPanX;
      const dy = e.clientY - this._lastPanY;
      this.viewPanX += dx;
      this.viewPanY += dy;
      this._lastPanX = e.clientX;
      this._lastPanY = e.clientY;
      this._updateCanvasTransform();
      return;
    }

    if (!this.isSelecting) return;

    const pos = this._getCanvasPos(e);

    if (this.mode === 'rectangle') {
      const x = Math.min(this.startPos.x, pos.x);
      const y = Math.min(this.startPos.y, pos.y);
      const width = Math.abs(pos.x - this.startPos.x);
      const height = Math.abs(pos.y - this.startPos.y);

      this.selection = { x, y, width, height };
      this._updateSelectionInfo();
    } else {
      // Add point to lasso (with distance threshold to avoid too many points)
      const lastPoint = this.lassoPoints[this.lassoPoints.length - 1];
      const dist = Math.hypot(pos.x - lastPoint.x, pos.y - lastPoint.y);
      if (dist > 3) {
        this.lassoPoints.push({ x: pos.x, y: pos.y });
      }
    }

    this._drawSnapshot();
    this._drawSelection();
  }

  /**
   * Handles pointer up events on the selection canvas.
   * @param {PointerEvent} e
   */
  _onPointerUp(e) {
    if (e.pointerId !== undefined) {
      this._activePointers.delete(e.pointerId);
    }

    // End pinch once fewer than two touch points remain
    if (this._pinch) {
      if (this._activePointers.size < 2) {
        this._pinch = null;
        if (e.pointerId !== undefined && this.selectionCanvas.hasPointerCapture?.(e.pointerId)) {
          this.selectionCanvas.releasePointerCapture(e.pointerId);
        }
      }
      return;
    }

    // End panning
    if (this._isPanning) {
      this._isPanning = false;
      this._updateCursor();
      if (e.pointerId !== undefined && this.selectionCanvas.hasPointerCapture?.(e.pointerId)) {
        this.selectionCanvas.releasePointerCapture(e.pointerId);
      }
      return;
    }

    if (!this.isSelecting) return;
    this.isSelecting = false;
    if (e.pointerId !== undefined && this.selectionCanvas.hasPointerCapture?.(e.pointerId)) {
      this.selectionCanvas.releasePointerCapture(e.pointerId);
    }

    // Finalize lasso by closing the path
    if (this.mode === 'lasso' && this.lassoPoints.length > 2) {
      // Compute bounding box for the selection
      this.selection = this._getLassoBounds();
    }

    this._drawSnapshot();
    this._drawSelection();
    this._updateSelectionInfo();
  }

  /**
   * Starts the marching ants animation.
   */
  _startMarchingAnts() {
    if (this.animationId) return;

    const animate = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 0.5) % 16;
      this._drawSelection();
      this.animationId = requestAnimationFrame(animate);
    };
    this.animationId = requestAnimationFrame(animate);
  }

  /**
   * Stops the marching ants animation.
   */
  _stopMarchingAnts() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Performs the save action.
   * @param {boolean} locally - If true, downloads locally. If false, uploads to gallery.
   */
  async _performSave(locally) {
    const canvas = this._createExportCanvas();

    if (locally) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const prefix = (this.preExistingCanvas || this.selection || this.lassoPoints.length > 2) ? 'selection' : 'board';
      const saved = await this.app.saveCanvasLocally(canvas, `${prefix}-${ts}.png`, 'Image saved!');
      if (!saved) return;
    } else {
      // Prefer the previewed clip so the upload matches what the user saw.
      // If they trimmed, the trimmed range is encoded once, right here.
      this.ui.showSavingPopup?.('Preparing time-lapse…');
      const timelapseBlob = await this._currentTimelapseBlob();
      await this.app.handleSaveToGallery(canvas, {
        title: this.galleryTitle.trim(),
        description: (this.galleryDescription || '').trim(),
        tags: this.shareToDiscord ? [...this.galleryTags, 'discord'] : [...this.galleryTags],
        // The username chip doubles as the old "Tag my username" toggle:
        // drop it and the item is credited to Anonymous.
        tagUsername: !this.usernameTag || this.galleryTags.includes(this.usernameTag),
        // Tags are the user's to curate here, so don't let SaveController
        // re-add the room tag they just removed.
        autoRoomTag: false,
        // Crop the auto time-lapse to what's actually being saved, not the
        // whole board. Null = full board (also for pre-existing canvases,
        // which have no board-space mapping).
        timelapseRegion: this._getBoardSpaceSaveRegion(),
        timelapseBlob: timelapseBlob || undefined,
        // false = user turned the Upload Timelapse toggle off — also blocks
        // SaveController's fallback render, not just the previewed blob.
        timelapse: this.uploadTimelapse
      });
    }

    this.close();
  }

  /**
   * The saved area as a board-space rect for the gallery time-lapse crop.
   * Mirrors _createExportCanvas's selection precedence. Pre-existing canvases
   * use the board rect their opener handed in (SelectTool passes the selection
   * bounds); without one they have no board mapping and return null
   * (= full board), which is right for a whole-board snapshot.
   * @returns {{x: number, y: number, width: number, height: number}|null}
   */
  _getBoardSpaceSaveRegion() {
    if (this.preExistingCanvas) return this.preExistingCanvasRegion;

    let bounds = null;
    if (this.mode === 'lasso' && this.lassoPoints.length > 2) {
      bounds = this._getLassoBounds();
    } else if (this.selection && this.selection.width > 0 && this.selection.height > 0) {
      bounds = this.selection;
    }
    if (!bounds) return null;

    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height))
    };
  }

  /**
   * Show and populate the gallery-step time-lapse preview.
   *
   * Source selection: sessions long enough to have accumulated stills (≥3)
   * use the sparse capturer frames; anything shorter — the "quick doodle"
   * case where the 20s capturer saw little or nothing — falls back to the
   * rolling DVR tape, rendered through TimeLapseExporter into a smooth clip.
   * Hidden entirely when the user isn't entitled or neither source has content.
   */
  async _beginTimelapsePreview() {
    if (!this.timelapseBlock) return;
    if (!this.app.canUseGalleryTimelapse?.()) {
      this._resetTimelapsePreview();
      return;
    }

    const capturer = this.app.timelapseCapturer;
    const region = this._getBoardSpaceSaveRegion();
    const regionKey = JSON.stringify(region);
    const stillCount = capturer?.frameCount ?? 0;

    // A stale tape may have gaps (disconnect/AFK filtering) and wouldn't
    // replay faithfully — stills are trustworthy regardless.
    const tapeStatus = this.app.rollingTapeRecorder?.getStatus?.() ?? null;
    const tapeUsable = !!tapeStatus?.hasContent && !tapeStatus.stale;

    if (stillCount < 3 && tapeUsable) {
      this._beginTapePreview(regionKey, region);
      return;
    }
    await this._beginStillsPreview(capturer, regionKey, region, stillCount);
  }

  /** Stills source: crop captured frames to the region (cached per region). */
  async _beginStillsPreview(capturer, regionKey, region, stillCount) {
    if (!capturer || stillCount < 1) {
      this._resetTimelapsePreview();
      return;
    }

    this.timelapseBlock.hidden = false;
    this._positionTimelapseWindow();
    if (this._tl.source === 'stills' && this._tl.frames && this._tl.regionKey === regionKey) {
      // Same crop as last time (user went Back and returned) — keep the
      // current preview and trim; only retry if the last encode failed.
      if (!this._tl.blob) this._encodeTimelapsePreview();
      return;
    }

    this._showTimelapseSpinner();
    const gen = ++this._tl.gen;
    let cropped = null;
    try {
      cropped = await capturer.getCroppedFrames(region);
    } catch (err) {
      console.warn('[Timelapse] preview crop failed:', err);
    }
    if (gen !== this._tl.gen) return; // superseded or dialog closed
    if (!cropped || cropped.frames.length < 2) {
      // Not enough distinct moments for a clip — no preview, no upload.
      this._resetTimelapsePreview();
      return;
    }

    this._tl.source = 'stills';
    this._tl.frames = cropped.frames;
    this._tl.tape = null;
    this._tl.region = region;
    this._tl.regionKey = regionKey;
    this._tl.blob = null;
    this._configureTrimSliders(cropped.frames.length - 1);
    this._encodeTimelapsePreview();
  }

  /**
   * Tape source: freeze the rolling DVR tape once and render trim ranges of it.
   * Trim sliders are whole seconds on the tape's (dead-air-compressed) clock.
   */
  _beginTapePreview(regionKey, region) {
    this.timelapseBlock.hidden = false;
    this._positionTimelapseWindow();
    if (this._tl.source === 'tape' && this._tl.tape && this._tl.regionKey === regionKey) {
      if (!this._tl.blob) this._encodeTimelapsePreview();
      return;
    }

    const recording = this.app.rollingTapeRecorder?.snapshotRecording?.();
    if (!recording || !recording.openingSnapshot || !(recording.deltas?.length > 0)) {
      this._resetTimelapsePreview();
      return;
    }

    this._tl.source = 'tape';
    this._tl.tape = recording;
    this._tl.frames = null;
    this._tl.region = region;
    this._tl.regionKey = regionKey;
    this._tl.blob = null;
    const spanSec = Math.max(1, Math.ceil(((recording.endedAt ?? recording.startedAt) - recording.startedAt) / 1000));
    this._configureTrimSliders(spanSec);
    this._encodeTimelapsePreview();
  }

  /** Reset both trim sliders to the full [0, max] range. */
  _configureTrimSliders(max) {
    this._tl.trimStart = 0;
    this._tl.trimEnd = max;
    this._tl.trimMax = max;
    if (this.trimStartInput) {
      this.trimStartInput.max = String(max);
      this.trimStartInput.value = '0';
    }
    if (this.trimEndInput) {
      this.trimEndInput.max = String(max);
      this.trimEndInput.value = String(max);
    }
    this._updateTrimLabel();
    this._updatePlaybackWindow();
  }

  /**
   * Clamp trim sliders (always keep a non-empty range) and move the preview's
   * playback window. No re-encode — the full clip already exists; the trimmed
   * range is only encoded once, at upload.
   */
  _onTrimInput(which) {
    if (!this._tl.source || !this.trimStartInput || !this.trimEndInput) return;
    const max = this._tl.trimMax || 1;
    let start = Math.round(Number(this.trimStartInput.value)) || 0;
    let end = Math.round(Number(this.trimEndInput.value)) || 0;
    if (which === 'start') start = Math.min(start, end - 1);
    else end = Math.max(end, start + 1);
    start = Math.max(0, Math.min(start, max - 1));
    end = Math.max(1, Math.min(end, max));
    this.trimStartInput.value = String(start);
    this.trimEndInput.value = String(end);
    this._tl.trimStart = start;
    this._tl.trimEnd = end;
    this._updateTrimLabel();
    this._updatePlaybackWindow();
  }

  _updateTrimLabel() {
    if (!this.timelapseFramesLabel) return;
    if (this._tl.source === 'stills' && this._tl.frames) {
      const count = this._tl.trimEnd - this._tl.trimStart + 1;
      this.timelapseFramesLabel.textContent = `${count} of ${this._tl.frames.length} snapshots`;
    } else if (this._tl.source === 'tape') {
      this.timelapseFramesLabel.textContent = `${this._tl.trimEnd - this._tl.trimStart}s of ${this._tl.trimMax}s`;
    }
  }

  /**
   * Map the trim sliders to seconds within the full encoded clip and snap the
   * preview into that window. Trim at the far end runs into the clip's final
   * hold, so playEnd stays Infinity there (native loop handles the wrap).
   */
  _updatePlaybackWindow() {
    const t = this._tl.timing;
    if (!t) return;
    let start = 0;
    let end = Infinity;
    if (this._tl.source === 'stills') {
      start = this._tl.trimStart * t.perFrameSec;
      if (this._tl.trimEnd < this._tl.trimMax) end = (this._tl.trimEnd + 1) * t.perFrameSec;
    } else if (this._tl.source === 'tape') {
      const frac = (v) => (this._tl.trimMax > 0 ? v / this._tl.trimMax : 0);
      start = frac(this._tl.trimStart) * t.contentSec;
      if (this._tl.trimEnd < this._tl.trimMax) end = frac(this._tl.trimEnd) * t.contentSec;
    }
    this._tl.playStart = start;
    this._tl.playEnd = end;
    const v = this.timelapseVideo;
    if (v && !v.hidden && v.readyState >= 1) {
      try { v.currentTime = start; } catch { /* not seekable yet */ }
    }
  }

  /** Keep the time-lapse window sitting just above the options panel. */
  _positionTimelapseWindow() {
    if (!this.timelapseWindow || this.timelapseWindow.hidden || !this.optionsPanel) return;
    const overlayRect = this.overlay.getBoundingClientRect();
    const panelRect = this.optionsPanel.getBoundingClientRect();
    if (!overlayRect.height || !panelRect.height) return;
    this.timelapseWindow.style.bottom = `${Math.round(overlayRect.bottom - panelRect.top) + 10}px`;
  }

  _showTimelapseSpinner(progress = null) {
    if (this.timelapseSpinner) this.timelapseSpinner.hidden = false;
    if (this.timelapseSpinnerText) {
      this.timelapseSpinnerText.textContent = progress == null
        ? 'Generating time-lapse…'
        : `Generating time-lapse… ${Math.round(progress * 100)}%`;
    }
  }

  /**
   * Encode the FULL clip for the current source/region — done once per crop;
   * trimming never re-enters here. The newest call wins via the gen token.
   */
  _encodeTimelapsePreview() {
    this._tl.exporter?.cancel?.();
    this._tl.exporter = null;
    if (this._tl.source === 'tape') this._encodeTapePreview();
    else this._encodeStillsPreview();
  }

  _encodeStillsPreview() {
    const { frames } = this._tl;
    if (!frames || frames.length < 2) return;

    const gen = ++this._tl.gen;
    this._showTimelapseSpinner();
    this._tl.encodePromise = (async () => {
      const { encodeFramesToWebm, normalizedPerFrameMs } = await import('../timebar/timelapseEncoder.js');
      const perFrameMs = normalizedPerFrameMs(frames.length);
      const blob = await encodeFramesToWebm(frames, { perFrameMs });
      if (gen === this._tl.gen) this._tl.timing = { perFrameSec: perFrameMs / 1000 };
      return this._finishPreviewEncode(gen, blob);
    })().catch((err) => {
      console.warn('[Timelapse] preview encode failed:', err);
      if (gen === this._tl.gen) this._resetTimelapsePreview();
      return null;
    });
  }

  _encodeTapePreview() {
    const recording = this._tl.tape;
    if (!recording) return;

    const gen = ++this._tl.gen;
    this._showTimelapseSpinner();
    this._tl.encodePromise = (async () => {
      const { TimeLapseExporter, compressedTapeDurationMs } = await import('../replay/TimeLapseExporter.js');
      const durMs = compressedTapeDurationMs(recording);
      if (durMs < 400) {
        // Tape holds no meaningful activity.
        if (gen === this._tl.gen) this._resetTimelapsePreview();
        return null;
      }
      // Speed that lands the clip near ~6s; never slower than real time.
      const speed = Math.max(1, durMs / 6000);
      const exporter = new TimeLapseExporter({
        recording,
        wsClient: this.app.wsClient,
        speed,
        fps: 30,
        output: 'video',
        region: this._tl.region,
        onProgress: (p) => { if (gen === this._tl.gen) this._showTimelapseSpinner(p); },
      });
      if (gen !== this._tl.gen) return null;
      this._tl.exporter = exporter;
      const result = await exporter.export();
      if (this._tl.exporter === exporter) this._tl.exporter = null;
      if (gen === this._tl.gen) this._tl.timing = { contentSec: durMs / speed / 1000 };
      return this._finishPreviewEncode(gen, result?.blob ?? null);
    })().catch((err) => {
      console.warn('[Timelapse] tape preview render failed:', err);
      if (gen === this._tl.gen) this._resetTimelapsePreview();
      return null;
    });
  }

  /** Common tail of both encode paths: publish the blob into the preview UI. */
  _finishPreviewEncode(gen, blob) {
    if (gen !== this._tl.gen) return null;
    this._tl.blob = blob;
    if (blob && this.timelapseVideo) {
      if (this._tl.url) URL.revokeObjectURL(this._tl.url);
      this._tl.url = URL.createObjectURL(blob);
      this.timelapseVideo.src = this._tl.url;
      this.timelapseVideo.hidden = false;
      if (this.timelapseSpinner) this.timelapseSpinner.hidden = true;
      this._updatePlaybackWindow();
      // The `autoplay` attribute alone is unreliable here — the element sits
      // `hidden` (display:none) while the clip encodes, and some browsers
      // never start decoding a video that gained its src while undisplayed.
      // Kick it explicitly once it's actually visible.
      this.timelapseVideo.play().catch(() => {});
    } else if (!blob) {
      // Encoder unavailable/cancelled — hide the preview; upload falls back silently.
      this._resetTimelapsePreview();
    }
    return blob;
  }

  /**
   * Encode the trimmed range once, at upload time. Falls back to the full
   * clip if the trim encode fails — better a longer clip than none.
   * @returns {Promise<Blob|null>}
   */
  async _encodeTrimmedClip() {
    try {
      if (this._tl.source === 'stills') {
        const slice = this._tl.frames.slice(this._tl.trimStart, this._tl.trimEnd + 1);
        if (slice.length < 2) return this._tl.blob;
        const { encodeFramesToWebm, normalizedPerFrameMs } = await import('../timebar/timelapseEncoder.js');
        const blob = await encodeFramesToWebm(slice, { perFrameMs: normalizedPerFrameMs(slice.length) });
        return blob ?? this._tl.blob;
      }
      const recording = this._tl.tape;
      const rangeStartTs = recording.startedAt + this._tl.trimStart * 1000;
      const rangeEndTs = recording.startedAt + this._tl.trimEnd * 1000;
      const { TimeLapseExporter, compressedTapeDurationMs } = await import('../replay/TimeLapseExporter.js');
      const durMs = compressedTapeDurationMs(recording, rangeStartTs, rangeEndTs);
      if (durMs < 400) return this._tl.blob;
      const speed = Math.max(1, durMs / 6000);
      const exporter = new TimeLapseExporter({
        recording,
        wsClient: this.app.wsClient,
        speed,
        fps: 30,
        output: 'video',
        region: this._tl.region,
        rangeStartTs,
        rangeEndTs,
      });
      const result = await exporter.export();
      return result?.blob ?? this._tl.blob;
    } catch (err) {
      console.warn('[Timelapse] trim encode failed, uploading full clip:', err);
      return this._tl.blob;
    }
  }

  /**
   * The clip to upload: waits out the in-flight full encode, then — only if
   * the user actually trimmed — encodes the trimmed range once. Null when no
   * preview exists (SaveController then falls back to its own render).
   * @returns {Promise<Blob|null>}
   */
  async _currentTimelapseBlob() {
    if (!this._tl.source) return null;
    if (this._tl.encodePromise) {
      try { await this._tl.encodePromise; } catch { /* fall through */ }
    }
    if (!this._tl.blob) return null;
    const isFullRange = this._tl.trimStart <= 0 && this._tl.trimEnd >= this._tl.trimMax;
    return isFullRange ? this._tl.blob : this._encodeTrimmedClip();
  }

  /** Hide the preview block and drop all cached/derived time-lapse state. */
  _resetTimelapsePreview() {
    this._tl.gen++;
    this._tl.exporter?.cancel?.();
    this._tl.exporter = null;
    this._tl.source = null;
    this._tl.frames = null;
    this._tl.tape = null;
    this._tl.region = null;
    this._tl.regionKey = null;
    this._tl.blob = null;
    this._tl.timing = null;
    this._tl.playStart = 0;
    this._tl.playEnd = Infinity;
    this._tl.encodePromise = null;
    if (this._tl.url) {
      URL.revokeObjectURL(this._tl.url);
      this._tl.url = null;
    }
    if (this.timelapseVideo) {
      this.timelapseVideo.hidden = true;
      this.timelapseVideo.removeAttribute('src');
      this.timelapseVideo.load?.();
    }
    this._showTimelapseSpinner();
    if (this.timelapseBlock) this.timelapseBlock.hidden = true;
  }

  async _performCopy() {
    const canvas = this._createExportCanvas();
    const copied = await this.app.copyCanvasToClipboard(canvas);
    if (copied) {
      this.close();
    }
  }

  _createExportCanvas() {
    if (this.preExistingCanvas && this.preExistingCanvasFixedSelection) {
      if (this.transparent) {
        return this.preExistingCanvas;
      }

      const canvas = document.createElement('canvas');
      canvas.width = this.preExistingCanvas.width;
      canvas.height = this.preExistingCanvas.height;
      const ctx = canvas.getContext('2d');
      const [r, g, b, a] = this.board.backgroundColor;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(this.preExistingCanvas, 0, 0);
      return canvas;
    }

    if (this.mode === 'lasso' && this.lassoPoints.length > 2) {
      return this._createLassoExportCanvas();
    }

    if (this.selection && this.selection.width > 0 && this.selection.height > 0) {
      return this._createRectExportCanvas();
    }

    return this._createFullExportCanvas();
  }

  /**
   * Creates an export canvas for the full board.
   * @returns {HTMLCanvasElement}
   */
  _createFullExportCanvas() {
    const sourceCanvas = this.preExistingCanvas;
    const width = sourceCanvas ? sourceCanvas.width : this.board.dimensions[1];
    const height = sourceCanvas ? sourceCanvas.height : this.board.dimensions[0];
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    this._drawExportSource(ctx, 0, 0);
    return canvas;
  }

  /**
   * Creates an export canvas for a rectangle selection.
   * @returns {HTMLCanvasElement}
   */
  _createRectExportCanvas() {
    const s = this.selection;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(s.width));
    canvas.height = Math.max(1, Math.round(s.height));
    const ctx = canvas.getContext('2d');
    this._drawExportSource(ctx, -Math.round(s.x), -Math.round(s.y));

    return canvas;
  }

  /**
   * Creates an export canvas for a lasso selection.
   * @returns {HTMLCanvasElement}
   */
  _createLassoExportCanvas() {
    const bounds = this._getLassoBounds();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, bounds.width);
    canvas.height = Math.max(1, bounds.height);
    const ctx = canvas.getContext('2d');

    const offsetPoints = this.lassoPoints.map(p => ({
      x: p.x - bounds.x,
      y: p.y - bounds.y
    }));

    this._drawExportSource(ctx, -bounds.x, -bounds.y);

    // Apply lasso mask using destination-in (keeps content only where mask is drawn)
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.moveTo(offsetPoints[0].x, offsetPoints[0].y);
    for (let i = 1; i < offsetPoints.length; i++) {
      ctx.lineTo(offsetPoints[i].x, offsetPoints[i].y);
    }
    ctx.closePath();
    ctx.fill();

    return canvas;
  }

  _drawExportSource(ctx, offsetX = 0, offsetY = 0) {
    ctx.save();
    ctx.translate(offsetX, offsetY);

    if (this.preExistingCanvas) {
      if (!this.transparent) {
        const [r, g, b, a] = this.board.backgroundColor;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        ctx.fillRect(-offsetX, -offsetY, this.preExistingCanvas.width, this.preExistingCanvas.height);
      }
      ctx.drawImage(this.preExistingCanvas, 0, 0);
    } else {
      const bgColor = this.transparent ? null : this.board.backgroundColor;
      this.board.layerManager.compositeLayerRange(ctx, 0, this.board.layerManager.getLayerCount(), bgColor);
    }

    ctx.restore();
  }

  /**
   * Opens save mode with a pre-existing canvas (e.g., from SelectTool).
   * Shows the canvas centered with options to save locally or to gallery.
   * @param {HTMLCanvasElement} canvas - The canvas to save
   * @param {Object} [options]
   * @param {boolean} [options.fixedSelection=true]
   * @param {{x:number,y:number,width:number,height:number}|null} [options.boardRegion]
   *   Where this canvas came from in board pixels. Without it the gallery
   *   time-lapse has no crop to work from and falls back to the whole board —
   *   a full-board clip attached to a cropped still.
   * @param {Function} [options.onClose] - Called once when the dialog closes
   *   (saved, canceled, or otherwise), regardless of outcome.
   */
  openWithCanvas(canvas, options = {}) {
    if (this.isActive) return;
    this.isActive = true;
    const fixedSelection = options.fixedSelection ?? true;

    // Store the pre-existing canvas
    this.preExistingCanvas = canvas;
    this.preExistingCanvasFixedSelection = fixedSelection;
    this.preExistingCanvasRegion = options.boardRegion ?? null;
    this._onCloseCallback = options.onClose ?? null;

    // Ensure overlay is in DOM
    if (!this.overlay.parentNode) {
      if (document.body) {
        document.body.appendChild(this.overlay);
      }
    }

    // Reset state
    this.selection = null;
    this.lassoPoints = [];
    this.transparent = false;
    this.shareToDiscord = false;
    this.uploadTimelapse = true;
    this.galleryTitle = '';
    this.galleryDescription = '';
    this.activeTool = fixedSelection ? 'pan' : 'select';
    this.optionsPanel.querySelector('#saveModeTransparent').checked = false;
    this.optionsPanel.querySelector('#saveModeShareDiscord').checked = false;
    if (this.titleInput) this.titleInput.value = '';
    if (this.descriptionInput) this.descriptionInput.value = '';
    this._resetTags();
    this._resetTimelapsePreview();
    this._showStep('main');

    // Size canvases to match the pre-existing canvas
    this.snapshotCanvas.width = canvas.width;
    this.snapshotCanvas.height = canvas.height;
    this.selectionCanvas.width = canvas.width;
    this.selectionCanvas.height = canvas.height;

    // Set selection to cover the full canvas only for fixed selections.
    if (fixedSelection) {
      this.selection = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    }
    this._updateSelectionInfo();

    // Draw the canvas as the snapshot
    this._drawPreExistingSnapshot();

    // Show overlay
    this.overlay.style.display = 'flex';

    // Hide mode toggle only when the selection is fixed.
    this.modeToggle.style.display = fixedSelection ? 'none' : '';

    // Update options hint
    const hint = this.optionsPanel.querySelector('.saveModeOptionsHint');
    if (hint) {
      hint.textContent = fixedSelection
        ? 'Save selection to file or gallery'
        : 'Draw a selection or save the entire snapshot';
    }

    // Center the canvas in the viewport
    this._centerPreExistingCanvas();
    this._syncControlState();
  }

  /**
   * Draws the pre-existing canvas snapshot.
   */
  _drawPreExistingSnapshot() {
    if (!this.preExistingCanvas) return;

    const ctx = this.snapshotCtx;
    const w = this.snapshotCanvas.width;
    const h = this.snapshotCanvas.height;
    ctx.clearRect(0, 0, w, h);
    this._drawCanvasPreview(ctx, this.preExistingCanvas, 0, 0, w, h);
  }

  /**
   * Centers the pre-existing canvas in the viewport.
   */
  _centerPreExistingCanvas() {
    const overlayRect = this.overlay.getBoundingClientRect();
    const canvasWidth = this.snapshotCanvas.width;
    const canvasHeight = this.snapshotCanvas.height;

    // Calculate scale to fit in viewport with padding
    const maxWidth = overlayRect.width * 0.8;
    const maxHeight = overlayRect.height * 0.7;
    const scale = Math.min(1, maxWidth / canvasWidth, maxHeight / canvasHeight);

    // Calculate centered position
    const panX = (overlayRect.width - canvasWidth * scale) / 2;
    const panY = (overlayRect.height - canvasHeight * scale) / 2 - 30; // Offset for options panel

    this._setView(scale, panX, panY, true);
  }

  /**
   * Closes the save mode.
   */
  close() {
    if (!this.isActive) return;
    this.isActive = false;
    this.overlay.style.display = 'none';
    this._stopMarchingAnts();
    this.selection = null;
    this.lassoPoints = [];
    this.preExistingCanvas = null;
    this.preExistingCanvasFixedSelection = false;
    this.preExistingCanvasRegion = null;

    const onClose = this._onCloseCallback;
    this._onCloseCallback = null;
    if (onClose) onClose();

    // Reset pan/zoom state
    this._isPanning = false;
    this._pinch = null;
    this._activePointers.clear();
    this.activeTool = 'select';
    this._setView(1, 0, 0, true);
    this._syncControlState();
    this._resetTimelapsePreview();
    this._showStep('main');

    // Restore mode toggle visibility
    this.modeToggle.style.display = '';

    // Restore hint text
    const hint = this.optionsPanel.querySelector('.saveModeOptionsHint');
    if (hint) {
      hint.textContent = 'Draw a selection or save the entire canvas';
    }
  }

  /**
   * Cleans up event listeners.
   */
  destroy() {
    document.removeEventListener('keydown', this._keyHandler);
    this._stopMarchingAnts();
    this._panelResizeObserver?.disconnect();
    this._resetTimelapsePreview();
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
  }
}
