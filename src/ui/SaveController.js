/**
 * @fileoverview Save/export controller — owns the save dialog flow, local PNG saves
 * (browser download or Tauri native dialog), gallery upload with time-lapse attachment,
 * and canvas/clipboard export helpers. Extracted from App.js.
 */

import {
  copyCanvasToSystemClipboard,
  copyImageDataToSystemClipboard,
  isTauriDesktop,
  saveCanvasViaNativeDialog
} from '../platform/desktop.js';

export class SaveController {
  constructor(app) {
    this.app = app;
  }

  get ui() { return this.app.ui; }
  get board() { return this.app.board; }

  /** Opens the interactive save mode with visual selection. */
  openSaveDialog() {
    if (this.app.saveMode) {
      this.app.saveMode.open();
    }
  }

  openSaveDialogForCanvas(sourceCanvas) {
    if (!this.app.saveMode || !sourceCanvas) {
      this.openSaveDialog();
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0);
    this.app.saveMode.openWithCanvas(canvas, { fixedSelection: false });
  }

  /** Closes the interactive save mode. */
  closeSaveDialog() {
    if (this.app.saveMode) {
      this.app.saveMode.close();
    }
  }

  /**
   * Performs the save action from the save mode overlay.
   * @param {boolean} locally - If true, downloads the file. If false, uploads to gallery.
   */
  async performSave(locally) {
    const { saveAreaSelection, saveTransparent } = this.ui.elements;
    const isSelection = saveAreaSelection?.checked;
    const transparent = saveTransparent?.checked ?? false;

    if (isSelection) {
      const selectTool = this.app.toolManager.tools.select;
      let canvas = selectTool?.getSelectionExportCanvas();
      if (!canvas) { this.ui.showToast('No active selection'); return; }

      if (!transparent) {
        const out = document.createElement('canvas');
        out.width = canvas.width;
        out.height = canvas.height;
        const ctx = out.getContext('2d');
        const [r, g, b, a] = this.board.backgroundColor;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(canvas, 0, 0);
        canvas = out;
      }

      if (locally) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const saved = await this.saveCanvasLocally(canvas, `selection-${ts}.png`, 'Selection saved!');
        if (!saved) return;
      } else {
        // Crop the time-lapse to the selection rect (board-space).
        const sel = selectTool?.selection;
        const region = sel ? { x: sel.x, y: sel.y, width: sel.width, height: sel.height } : null;
        await this.handleSaveToGallery(canvas, { timelapseRegion: region });
      }
    } else {
      const canvas = this.board.getExportCanvas(transparent);

      if (locally) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const saved = await this.saveCanvasLocally(canvas, `board-${ts}.png`, 'Image saved!');
        if (!saved) return;
      } else {
        await this.handleSaveToGallery(canvas);
      }
    }

    this.closeSaveDialog();
  }

  /**
   * Uploads a canvas to the gallery. Uses viewCanvas if no canvas is provided.
   * @param {HTMLCanvasElement} [canvas]
   * @async
   */
  async handleSaveToGallery(canvas, metadata = {}) {
    // No token is allowed: the server accepts a guest upload and stores it with
    // no author, credited to "Anonymous" in the gallery. Sending an empty
    // Authorization header instead of omitting it would read as a broken
    // session and 401, so the header only goes on when there is a token.
    const token = this.app.auth?.getStoredToken() ?? localStorage.getItem('topDrawAuthToken');

    // The app's own session flag (set on login/logout, never touched by
    // storage) can disagree with the token read above — e.g. the gallery page
    // logging in elsewhere with "Stay logged in" off clears the shared
    // topDrawAuthToken key out from under this tab. Treating that silently as
    // a guest save would misattribute the upload to "Anonymous" for someone
    // who never signed out, so bail loudly and let them re-authenticate.
    if (this.app.auth?.isLoggedIn && !token) {
      this.ui.showToast('Your session was signed out elsewhere — log in again to save to the gallery', 4000, 'error');
      return;
    }

    // Exporting the board: every pixel has to be current, including any the
    // viewport was not showing. getExportCanvas composites from the layer
    // stack, so it does not care what viewCanvas is currently holding.
    const targetCanvas = canvas ?? this.board.getExportCanvas(false);
    const btn = this.ui.elements.saveToGalleryBtn;
    const originalText = btn?.textContent;
    if (btn) btn.textContent = 'Saving...';
    this.ui.showSavingPopup('Saving to gallery...');

    try {
      const imageData = targetCanvas.toDataURL('image/png');
      const apiBase = import.meta.env.VITE_API_BASE_URL || '';

      // Auto-add room tag for floating art. The save dialog seeds the room tag
      // into its own tag field and passes autoRoomTag:false, so a user who
      // removes the chip there doesn't get it added back here.
      const tags = metadata.tags ? [...metadata.tags] : [];
      // Draw Alone has no shared room behind it — its id is a throwaway
      // `offline-<timestamp>` — so it gets no room tag, same as
      // SaveMode._resetTags().
      if (metadata.autoRoomTag !== false && !this.app.isOfflineMode) {
        // wsClient has no public `roomId` — read the room the app actually
        // tracks, same as SaveMode._resetTags().
        const roomTag = this.app.currentRoomId || this.app.currentRoomData?.id || 'lobby';
        if (!tags.includes(roomTag)) {
          tags.push(roomTag);
        }
      }

      const res = await fetch(`${apiBase}/api/gallery/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          imageData,
          title: metadata.title || '',
          description: metadata.description || '',
          tags: tags,
          tagUsername: metadata.tagUsername !== false
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.duplicate) {
          this.ui.showToast('This image is already in the gallery', 3000, 'error');
        } else {
          this.ui.showToast(`Gallery save failed: ${data.error || res.status}`, 3000, 'error');
          await this._offerLocalSave(targetCanvas);
        }
        return;
      }

      this.ui.showToast(token ? 'Saved to gallery!' : 'Saved to gallery as Anonymous');

      // Fire-and-forget: render + attach a time-lapse for entitled users. Not
      // awaited so the save UI completes immediately; the clip attaches when
      // ready. metadata.timelapse === false means the user opted out in the
      // save dialog — skip even the fallback render.
      if (token && data?.id && metadata.timelapse !== false && this.canUseGalleryTimelapse()) {
        this._uploadGalleryTimelapse(data.id, metadata.timelapseRegion ?? null, token, metadata.timelapseBlob ?? null)
          .catch(err => console.warn('[Timelapse] upload failed:', err));
      }
    } catch (err) {
      console.error('[Gallery] Save error:', err);
      this.ui.showToast(`Gallery save failed: ${err.message}`, 3000, 'error');
      await this._offerLocalSave(targetCanvas);
    } finally {
      this.ui.hideSavingPopup();
      if (btn && originalText) btn.textContent = originalText;
    }
  }

  /**
   * Show the one-time "try gallery time-lapse" prompt for eligible (NOBLE+)
   * users. Default stays on whether they accept or dismiss; this just surfaces
   * the feature once. The flag is per-device (localStorage).
   */
  _maybeShowTimelapsePrompt() {
    try {
      if (Number(this.app.self?.role || 0) < 7) return;
      const KEY = 'topDrawTimelapsePromptSeen';
      if (localStorage.getItem(KEY)) return;
      // Brief delay so it doesn't collide with the login/join toasts.
      setTimeout(() => {
        if (localStorage.getItem(KEY)) return;
        localStorage.setItem(KEY, '1');
        this.ui.showTimelapsePromptToast(
          () => this._setGalleryTimelapseEnabled(true),
          () => this._setGalleryTimelapseEnabled(false),
        );
      }, 2500);
    } catch { /* ignore */ }
  }

  _setGalleryTimelapseEnabled(enabled) {
    const next = {
      ...this.app.appPreferences,
      general: { ...(this.app.appPreferences?.general ?? {}), galleryTimelapseEnabled: enabled },
    };
    this.app.setAppPreferences(next);
    this.ui.showToast(enabled ? 'Gallery time-lapse enabled' : 'Gallery time-lapse disabled', 2500);
  }

  /**
   * Whether the local user may generate a gallery time-lapse. Gated to NOBLE(7)+
   * for now, plus the (default-on) app-settings toggle. The role check is the
   * future subscription seam.
   * @returns {boolean}
   */
  canUseGalleryTimelapse() {
    const role = Number(this.app.self?.role || 0);
    if (role < 7) return false;
    return this.app.appPreferences?.general?.galleryTimelapseEnabled !== false;
  }

  /**
   * Render the captured session stills into a WebM cropped to `region` and
   * attach it to the just-uploaded gallery item.
   * @param {string} itemId - Gallery item id from the upload response.
   * @param {{x:number,y:number,width:number,height:number}|null} region - board px, null = full board
   * @param {string} token - auth token
   * @param {Blob|null} [preRendered] - clip already rendered by the save-dialog
   *   preview (trim applied); when present it's uploaded as-is so the user gets
   *   exactly what they saw.
   */
  async _uploadGalleryTimelapse(itemId, region, token, preRendered = null) {
    let blob = preRendered;
    if (!blob) {
      const capturer = this.app.timelapseCapturer;
      if (!capturer || capturer.frameCount < 1) return;
      blob = await capturer.renderWebm(region);
      if (!blob) return; // not enough distinct frames
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

    const apiBase = import.meta.env.VITE_API_BASE_URL || '';
    const res = await fetch(`${apiBase}/api/gallery/${itemId}/animation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ animationData: dataUrl, region }),
    });
    if (res.ok) {
      this.ui.showToast('Time-lapse attached to your gallery upload', 2500);
    } else {
      console.warn('[Timelapse] server rejected animation:', res.status);
    }
  }

  /**
   * Triggers a local download of the canvas as a fallback when gallery upload fails.
   * @param {HTMLCanvasElement} canvas
   * @private
   */
  async _offerLocalSave(canvas) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    await this.saveCanvasLocally(canvas, `drawing-${ts}.png`, 'Saved locally instead');
  }

  async saveCanvasLocally(canvas, suggestedName, successMessage = 'Image saved!') {
    if (isTauriDesktop()) {
      try {
        const result = await saveCanvasViaNativeDialog(canvas, suggestedName);
        if (result?.saved) {
          this.ui.showToast(successMessage);
          return true;
        }
        return false;
      } catch (error) {
        console.error('[Desktop] Native save failed:', error);
        this.ui.showToast('Native save failed, using browser download instead', 3000, 'error');
      }
    }

    const link = document.createElement('a');
    link.download = suggestedName;
    link.href = canvas.toDataURL('image/png');
    link.click();
    this.ui.showToast(successMessage);
    return true;
  }

  async copyCanvasToClipboard(canvas, options = {}) {
    const copied = await copyCanvasToSystemClipboard(canvas);
    if (copied) {
      if (!options.silent) this.ui.showToast('Copied to clipboard!');
      return true;
    }

    if (!options.silent) {
      this.ui.showToast('Clipboard copy is not available here', 3000, 'error');
    }
    return false;
  }

  async copyImageDataToClipboard(clipboardData, options = {}) {
    if (!clipboardData?.imageData || !clipboardData?.width || !clipboardData?.height) {
      return false;
    }

    const copied = await copyImageDataToSystemClipboard(
      clipboardData.imageData,
      clipboardData.width,
      clipboardData.height
    );

    if (copied) {
      if (!options.silent) this.ui.showToast('Copied to clipboard!');
      return true;
    }

    if (!options.silent) {
      this.ui.showToast('Clipboard copy is not available here', 3000, 'error');
    }
    return false;
  }
}
