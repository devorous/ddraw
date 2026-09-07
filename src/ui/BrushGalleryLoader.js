/** @fileoverview Lazy-loads BrushGallery on first use. */
import { BrushGallery } from './BrushGallery.js';

/**
 * BrushGalleryLoader class
 * Initializes BrushGallery on first access.
 */
export class BrushGalleryLoader {
  /**
   * @param {Object} options - Configuration options for BrushGallery
   */
  constructor(options = {}) {
    this.options = options;
    this.realGallery = null;
    this.galleryEl = null;
  }

  /**
   * Initializes the loader by storing a reference to the gallery element.
   */
  init() {
    this.galleryEl = document.getElementById('brushGallery');
  }

  /**
   * Initializes the real BrushGallery.
   * @returns {BrushGallery} - The BrushGallery instance
   */
  loadRealGallery() {
    if (!this.realGallery) {
      this.realGallery = new BrushGallery(this.options);
      this.realGallery.init();
    }
    return this.realGallery;
  }

  /**
   * Shows the BrushGallery.
   */
  show() {
    this.loadRealGallery();
    if (this.realGallery) {
      this.realGallery.show();
    } else if (this.galleryEl) {
      this.galleryEl.style.display = 'block';
      window.app?.ui?.refreshToolOptionsLayout?.(window.app?.self?.tool);
    }
  }

  /**
   * Hides the BrushGallery.
   */
  hide() {
    if (this.realGallery) {
      this.realGallery.hide();
    } else if (this.galleryEl) {
      this.galleryEl.style.display = 'none';
      window.app?.ui?.refreshToolOptionsLayout?.(window.app?.self?.tool);
    }
  }

  /**
   * Gets the currently selected brush from the gallery.
   * @returns {Object|null} - The selected brush or null if not loaded
   */
  getSelectedBrush() {
    return this.realGallery ? this.realGallery.getSelectedBrush() : null;
  }

  /**
   * Selects a brush by id, loading the real gallery first if needed.
   * @param {string} id - Brush id, e.g. 'builtin:imageBrush:pepper.gbr'
   * @returns {boolean} - Whether a matching brush was found and selected
   */
  selectBrushById(id) {
    return this.loadRealGallery().selectBrushById(id);
  }
}
