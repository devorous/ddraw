/**
 * @fileoverview Color system controller — owns the color wheel pickers, primary/secondary
 * slots, hex input, palette selection, and color-change propagation (self state, UI,
 * tool tint caches, network broadcast). Extracted from App.js.
 */

import ColorWheel from 'reinvented-color-wheel';
import 'reinvented-color-wheel/css/reinvented-color-wheel.css';
import { rgbToHex as _rgbToHex, hslToRgb as _hslToRgb } from '../../shared/ColorUtils.js';
import { appState } from '../state.svelte.js';

export class ColorController {
  constructor(app) {
    this.app = app;

    this.colorPicker = null;
    this.colorPickers = [];
    this.colorPickerResizeObservers = [];
    this.primaryColor = [0, 0, 0, 1];
    this.secondaryColor = [255, 255, 255, 1];
    this.activeColorSlot = 'primary';
    this.colorSlotElements = [];
    this.colorPickerHexInputs = [];
  }

  get self() { return this.app.self; }
  get ui() { return this.app.ui; }

  setupColorPicker() {
    try {
      const containers = [
        document.getElementById('colorPicker'),
        document.getElementById('boardColorPicker')
      ].filter(Boolean);
      if (!containers.length) {
        console.warn('[App] Color picker container #colorPicker not found');
        return;
      }

      let suppressChange = false;
      const parseColorValue = (value) => {
        if (Array.isArray(value)) {
          if (value.length === 3) {
            const rgb = this.hsvToRgb(value[0], value[1], value[2]);
            return [rgb.r, rgb.g, rgb.b, this.self?.opacity ?? 1];
          }
          return value;
        }

        if (typeof value !== 'string') {
          return null;
        }

        const rgbaMatch = value.match(/^rgba?\(([^)]+)\)$/i);
        if (rgbaMatch) {
          const parts = rgbaMatch[1].split(',').map(part => Number(part.trim()));
          if (parts.length >= 3 && parts.every(part => Number.isFinite(part))) {
            return [parts[0], parts[1], parts[2], parts[3] ?? this.self?.opacity ?? 1];
          }
        }

        const hslMatch = value.match(/^hsla?\(([^)]+)\)$/i);
        if (hslMatch) {
          const parts = hslMatch[1].split(',').map(part => part.trim());
          if (parts.length >= 3) {
            const h = Number(parts[0]);
            const s = Number(parts[1].replace('%', ''));
            const l = Number(parts[2].replace('%', ''));
            if (Number.isFinite(h) && Number.isFinite(s) && Number.isFinite(l)) {
              const [r, g, b] = _hslToRgb(h, s, l);
              return [Math.round(r), Math.round(g), Math.round(b), this.self?.opacity ?? 1];
            }
          }
        }

        return null;
      };

      const syncHexInput = (rgba) => {
        this.colorPickerHexInputs?.forEach(input => {
          input.value = _rgbToHex(rgba[0], rgba[1], rgba[2]).toUpperCase();
        });
      };

      const getWheelDiameter = (container) => {
        // clientWidth (the layout content-box) rather than
        // getBoundingClientRect() - the board picker's DockablePanel plays a
        // CSS transform: scale() genie animation when it opens/closes, and
        // getBoundingClientRect() reports the transformed (visually shrunk)
        // rect while that's still running. A ResizeObserver-triggered
        // recalculation mid-animation would otherwise measure the wheel at
        // that shrunk size and get stuck there, since nothing re-measures it
        // once the animation finishes and the box isn't actually resized.
        const styles = getComputedStyle(container);
        const horizontalPadding = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0');
        const availableWidth = Math.floor((container.clientWidth || container.getBoundingClientRect().width || 0) - horizontalPadding);
        const maxDiameter = container.classList.contains('boardColorPicker') ? 160 : 200;
        const minDiameter = container.classList.contains('boardColorPicker') ? 44 : 120;
        return Math.max(minDiameter, Math.min(maxDiameter, availableWidth));
      };

      const getWheelMetrics = (container) => {
        const diameter = getWheelDiameter(container);
        const scale = diameter / 200;
        return {
          diameter,
          thickness: Math.max(12, Math.round(20 * scale)),
          handleDiameter: Math.max(12, Math.round(16 * scale))
        };
      };

      this.colorPickerResizeObservers?.forEach(observer => observer?.disconnect());
      this.colorPickerResizeObservers = [];
      this.colorPickers = [];
      this.colorSlotElements = [];
      this.colorPickerHexInputs = [];

      this.primaryColor = this.self?.color ? [...this.self.color] : [0, 0, 0, 1];
      this.activeColorSlot = 'primary';
      containers.forEach(container => {
        container.innerHTML = '';
        if (!container.classList.contains('boardColorPicker')) {
          this._setupColorSlotControls(container);
          this._setupColorPickerHexInput(container);
          this._setupColorPickerPopoutButton(container);
        }

        const initialMetrics = getWheelMetrics(container);
        const wheel = new ColorWheel({
          appendTo: container,
          rgb: this.self?.color ? this.self.color.slice(0, 3) : [0, 0, 0],
          wheelDiameter: initialMetrics.diameter,
          wheelThickness: initialMetrics.thickness,
          handleDiameter: initialMetrics.handleDiameter,
          wheelReflectsSaturation: false,
          onChange: (color) => {
            if (suppressChange) return;

            const rgb = this.hsvToRgb(color.hsv[0], color.hsv[1], color.hsv[2]);
            const opacity = this.ui.elements.opacitySlider?.value ? parseInt(this.ui.elements.opacitySlider.value) / 100 : 1;
            const rgba = [rgb.r, rgb.g, rgb.b, opacity];

            this.app.commitSelfEraserSegment(this.self.pressure, this.self.size, opacity);
            this.self.setColor(rgba);
            this.self.setOpacity(opacity);
            this._syncActiveColorSlot(rgba);
            syncHexInput(rgba);
            this.ui.updateSelfColor(rgba);
            this.ui.updateSelfTextStyle(this.self.size, rgba, this.self.font);
            this.ui.updateOpacityValue(opacity);

            const { elements } = this.ui;
            if (elements.opacitySlider) {
              elements.opacitySlider.value = opacity * 100;
            }

            if (this.app.colorInputMenu) {
              this.app.colorInputMenu.updateColor(rgba);
            }

            this._clearToolColorCaches({ includeImageBrush: true });

            this._setColorPickersColor(rgba, { source: wheel, silent: true });
            appState.currentColor = [...rgba];
            this.app.updateCurrentToolPresetSettings();
            this.app.updateActiveToolPreview();

            this._broadcastColor(rgba);
          }
        });

        wheel.element = wheel.rootElement;
        wheel.setColor = (value, silent = false) => {
          const rgba = parseColorValue(value);
          if (!rgba) {
            console.warn('[App] Unsupported color picker value:', value);
            return;
          }

          suppressChange = silent;
          if (Array.isArray(value) && value.length === 3) {
            wheel.hsv = value;
          } else {
            wheel.rgb = rgba.slice(0, 3);
          }
          suppressChange = false;
          this._syncActiveColorSlot(rgba);
          syncHexInput(rgba);
        };

        const resizeWheel = () => {
          const nextMetrics = getWheelMetrics(container);
          if (
            nextMetrics.diameter === wheel.wheelDiameter &&
            nextMetrics.thickness === wheel.wheelThickness &&
            nextMetrics.handleDiameter === wheel.handleDiameter
          ) return;

          wheel.wheelDiameter = nextMetrics.diameter;
          wheel.wheelThickness = nextMetrics.thickness;
          wheel.handleDiameter = nextMetrics.handleDiameter;
          wheel.redraw();
        };

        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(() => resizeWheel());
          observer.observe(container);
          this.colorPickerResizeObservers.push(observer);
        }

        this.colorPickers.push(wheel);
      });

      this.colorPicker = this.colorPickers[0] ?? null;
      this._syncActiveColorSlot(this.primaryColor);
      this._updateColorSlotUI();
      syncHexInput(this.primaryColor);
    } catch (err) {
      console.error('[App] Failed to setup color picker:', err);
    }
  }

  _setColorPickersColor(value, { source = null, silent = true } = {}) {
    this.colorPickers?.forEach(picker => {
      if (picker && picker !== source) picker.setColor(value, silent);
    });
  }

  /** Clear per-tool tint/tile caches that bake the current color into cached pixels. */
  _clearToolColorCaches({ includeImageBrush = true } = {}) {
    const { toolManager } = this.app;

    const patternTool = toolManager.getTool('pattern');
    if (patternTool) {
      patternTool._tileCache.clear();
      this.app.updatePatternPreviewIfVisible();
    }

    if (includeImageBrush) {
      const imageBrushTool = toolManager.getTool('imageBrush');
      if (imageBrushTool) imageBrushTool._tintCache.clear();
    }

    const fillTool = toolManager.getTool('fill');
    if (fillTool && fillTool._patternTileCache) {
      fillTool._patternTileCache.clear();
    }

    const selectTool = toolManager.getTool('select');
    if (selectTool && selectTool._patternTileCache) {
      selectTool._patternTileCache.clear();
    }
  }

  _broadcastColor(rgba) {
    if (this.app.connected) {
      this.app.inputBufferManager.queueBroadcast(() => this.app.wsClient.broadcastColorChange(rgba));
    }
  }

  _setupColorSlotControls(container) {
    container.querySelector('.colorSlotControls')?.remove();

    const controls = document.createElement('div');
    controls.className = 'colorSlotControls';
    controls.innerHTML = `
      <button type="button" class="colorSlotSwatch secondary" data-slot="secondary" title="Secondary color"></button>
      <button type="button" class="colorSlotSwatch primary active" data-slot="primary" title="Primary color"></button>
      <button type="button" class="colorSlotSwap" title="Swap colors" aria-label="Swap primary and secondary colors"></button>
    `;

    const [secondaryButton, primaryButton, swapButton] = controls.children;
    primaryButton.addEventListener('click', () => this.selectColorSlot('primary'));
    secondaryButton.addEventListener('click', () => this.selectColorSlot('secondary'));
    swapButton.addEventListener('click', () => this.swapColorSlots());

    container.prepend(controls);
    this.colorSlotElements.push({
      controls,
      primaryButton,
      secondaryButton,
      swapButton
    });
  }

  _setupColorPickerHexInput(container) {
    container.querySelector('.colorPickerHexField')?.remove();

    const field = document.createElement('div');
    field.className = 'colorPickerHexField';
    field.innerHTML = `
      <input class="colorPickerHexInput" type="text" inputmode="text" maxlength="6" spellcheck="false" autocomplete="off">
    `;

    const input = field.querySelector('input');
    const commitHex = () => {
      let hex = input.value.replace(/[^0-9A-Fa-f]/g, '');
      if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('');
      }
      if (hex.length === 0) {
        hex = _rgbToHex(this.self.color[0], this.self.color[1], this.self.color[2]);
      }
      while (hex.length < 6) {
        hex = `0${hex}`;
      }
      hex = hex.substring(0, 6).toUpperCase();
      input.value = hex;

      const color = [
        parseInt(hex.substring(0, 2), 16),
        parseInt(hex.substring(2, 4), 16),
        parseInt(hex.substring(4, 6), 16),
        this.self?.color?.[3] ?? 1
      ];
      this.handleColorInputChange(color);
    };

    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9A-Fa-f]/g, '').substring(0, 6).toUpperCase();
    });
    input.addEventListener('change', commitHex);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitHex();
        input.blur();
      }
    });

    container.prepend(field);
    this.colorPickerHexInputs.push(input);
  }

  _setupColorPickerPopoutButton(container) {
    container.querySelector('.colorPickerPopoutButton')?.remove();

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'colorPickerPopoutButton';
    button.title = 'Pop out picker onto the board';
    button.setAttribute('aria-label', 'Pop out picker onto the board');
    // Open-in-new-window mark. The previous two-offset-rectangles glyph is the
    // universal "duplicate/copy" mark, which is not what this button does.
    button.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M14 9.8v3.4A1.8 1.8 0 0 1 12.2 15H3A1.8 1.8 0 0 1 1.2 13.2V4A1.8 1.8 0 0 1 3 2.2h3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
        <path d="M9.8 1H15v5.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
        <path d="M15 1 8.4 7.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
      </svg>
    `;

    button.addEventListener('click', () => {
      appState.boardColorPickerVisible = true;
      appState.boardColorPickerForceVisible = true;
    });

    container.appendChild(button);
  }

  _syncActiveColorSlot(rgba) {
    const normalized = [...rgba];
    if (this.activeColorSlot === 'secondary') {
      this.secondaryColor = normalized;
    } else {
      this.primaryColor = normalized;
    }
    this._updateColorSlotUI();
  }

  _updateColorSlotUI() {
    if (!this.colorSlotElements?.length) return;

    this.colorSlotElements.forEach(elements => {
      elements.primaryButton.style.backgroundColor = `rgba(${this.primaryColor.join(',')})`;
      elements.secondaryButton.style.backgroundColor = `rgba(${this.secondaryColor.join(',')})`;
      elements.primaryButton.classList.toggle('active', this.activeColorSlot === 'primary');
      elements.secondaryButton.classList.toggle('active', this.activeColorSlot === 'secondary');
    });
  }

  selectColorSlot(slot) {
    if (slot !== 'primary' && slot !== 'secondary') return;

    this.activeColorSlot = slot;
    const color = slot === 'primary' ? [...this.primaryColor] : [...this.secondaryColor];
    this.handlePaletteColorSelect(color);
    this._updateColorSlotUI();
  }

  swapColorSlots() {
    [this.primaryColor, this.secondaryColor] = [this.secondaryColor, this.primaryColor];
    const currentSlot = this.activeColorSlot;
    this._updateColorSlotUI();
    this.selectColorSlot(currentSlot);
  }

  handlePaletteColorSelect(colorOrCallback) {
    // If it's a callback (from the add button), pass the current color
    if (typeof colorOrCallback === 'function') {
      colorOrCallback(this.self.color);
      return;
    }

    // Otherwise, select the color and update picker
    this.app.clearActiveCustomPreset();
    const color = colorOrCallback;
    this.self.setColor(color);
    this.self.setOpacity(color[3]);
    appState.currentColor = [...color];
    this._syncActiveColorSlot(color);
    this.ui.updateSelfColor(color);
    this.ui.updateSelfTextStyle(this.self.size, color, this.self.font);
    this.ui.updateOpacityValue(color[3]);

    // Update the color picker to match
    this._setColorPickersColor(`rgba(${color.join(',')})`);

    // Update pattern tools when color changes (for tinted color modes)
    this._clearToolColorCaches({ includeImageBrush: true });

    this._broadcastColor(color);

    this.app.updateCurrentToolPresetSettings();
    this.app.updateActiveToolPreview();
  }

  handleColorInputChange(rgba) {
    this.app.commitSelfEraserSegment(this.self.pressure, this.self.size, rgba[3]);
    // Update self's color
    this.self.setColor(rgba);
    this.self.setOpacity(rgba[3]);
    this.ui.updateSelfColor(rgba);
    this.ui.updateSelfTextStyle(this.self.size, rgba, this.self.font);
    this.ui.updateOpacityValue(rgba[3]);

    // Update the color picker to match
    this._setColorPickersColor(rgba);

    // Update pattern tools when color changes (for tinted color modes)
    this._clearToolColorCaches({ includeImageBrush: false });

    // Broadcast to other users if connected
    this._broadcastColor(rgba);

    appState.currentColor = [...rgba];
    this.app.updateCurrentToolPresetSettings();
    this.app.updateActiveToolPreview();
  }

  /**
   * Convert HSV to RGB.
   * @param {number} h - Hue (0-360)
   * @param {number} s - Saturation (0-100)
   * @param {number} v - Value (0-100)
   * @returns {Object} {r: 0-255, g: 0-255, b: 0-255}
   */
  hsvToRgb(h, s, v) {
    h = h / 360;
    s = s / 100;
    v = v / 100;

    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    let r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }

    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255)
    };
  }

  /**
   * Convert RGB to HSV.
   * @param {number} r - Red (0-255)
   * @param {number} g - Green (0-255)
   * @param {number} b - Blue (0-255)
   * @returns {Array} [h: 0-360, s: 0-100, v: 0-100]
   */
  rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    let s = max === 0 ? 0 : (delta / max);
    let v = max;

    if (delta !== 0) {
      if (max === r) {
        h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
      } else if (max === g) {
        h = ((b - r) / delta + 2) / 6;
      } else {
        h = ((r - g) / delta + 4) / 6;
      }
    }

    return [h * 360, s * 100, v * 100];
  }
}
