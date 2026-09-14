/**
 * @fileoverview ToolLockManager - Manages per-tool locked property values
 */

import { appState } from '../state.svelte.js';
import {
  DEFAULT_PRESSURE_TARGETS,
  PRESSURE_TARGET_OPACITY,
  PRESSURE_TARGET_SIZE
} from '../../shared/pressureTargets.js';

/**
 * Default values for every lockable tool property. Single source of truth for
 * both the global unlocked-values seed and per-tool lock defaults.
 */
const PROPERTY_DEFAULTS = {
  size: 10,
  smoothing: 15,
  hardness: 100,
  opacity: 1.0,
  spacing: 0,
  blurRadius: 5,
  thinning: 0.5,
  blendMode: 'source-over',
  pressure: { min: 0, max: 100, enabled: true },
  pressureTargets: DEFAULT_PRESSURE_TARGETS
};

/**
 * Per-tool overrides of the default (locked, lockedValue) for a lockable
 * property, applied on top of PROPERTY_DEFAULTS in getDefaultToolLocks().
 */
const TOOL_PROPERTY_OVERRIDES = {
  ink: { smoothing: { locked: true, lockedValue: 10 } },
  flowPen: {
    // Reads 10, applies 40: the Fluid Brush adds FLOW_PEN_BASE_SMOOTHING (30).
    smoothing: { locked: true, lockedValue: 10 },
    // The Fluid Brush presses for opacity as well as size.
    pressureTargets: { locked: true, lockedValue: PRESSURE_TARGET_SIZE | PRESSURE_TARGET_OPACITY }
  }
};

/**
 * Manages tool properties (size, smoothing, opacity, etc.) and allows locking
 * values for specific tools or sharing unlocked values globally.
 */
export class ToolLockManager {
  /**
   * @param {Object} app - The main application instance
   */
  constructor(app) {
    this.app = app;
    this.toolLocks = this.loadToolLocks();
    this.globalUnlockedValues = this.loadGlobalUnlockedValues();
  }

  /**
   * Load global unlocked property values from localStorage
   * @returns {Object} Unlocked values mapping
   */
  loadGlobalUnlockedValues() {
    const defaults = { ...PROPERTY_DEFAULTS, pressure: { ...PROPERTY_DEFAULTS.pressure } };

    try {
      const saved = localStorage.getItem('topDrawGlobalUnlockedValues');
      if (saved) {
        const parsed = JSON.parse(saved);

        if (parsed.opacity !== undefined && parsed.opacity > 1) {
          parsed.opacity = parsed.opacity / 100;
        }

        return { ...defaults, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load global unlocked values:', e);
    }

    return defaults;
  }

  /**
   * Save global unlocked property values to localStorage
   */
  saveGlobalUnlockedValues() {
    try {
      localStorage.setItem('topDrawGlobalUnlockedValues', JSON.stringify(this.globalUnlockedValues));
    } catch (e) {
      console.warn('Failed to save global unlocked values:', e);
    }
  }

  /**
   * Load tool-specific lock configurations from localStorage
   * @returns {Object} Tool lock configurations
   */
  loadToolLocks() {
    const defaults = this.getDefaultToolLocks();

    try {
      const saved = localStorage.getItem('topDrawToolLocks');
      if (saved) {
        const parsed = JSON.parse(saved);
        const migrated = this.migrateToolLocks(parsed);

        for (const [tool, props] of Object.entries(migrated)) {
          if (defaults[tool]) {
            for (const [prop, state] of Object.entries(props)) {
              if (defaults[tool][prop]) {
                defaults[tool][prop] = state;
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load tool locks:', e);
    }

    return defaults;
  }

  /**
   * Migrate old tool lock data formats to the current format
   * @param {Object} oldLocks - Old tool lock configuration
   * @returns {Object} Migrated configuration
   */
  migrateToolLocks(oldLocks) {
    const newLocks = {};

    for (const [tool, props] of Object.entries(oldLocks)) {
      newLocks[tool] = {};

      for (const [prop, state] of Object.entries(props)) {
        if (state.lockedValue !== undefined && state.unlockedValue === undefined) {
          if (prop === 'opacity' && state.lockedValue > 1) {
            state.lockedValue = state.lockedValue / 100;
          }
          newLocks[tool][prop] = state;
          continue;
        }

        if (prop === 'pressure') {
          newLocks[tool][prop] = {
            locked: state.locked ?? false,
            lockedValue: {
              min: state.min ?? 0,
              max: state.max ?? 100,
              enabled: state.enabled ?? true
            }
          };
        } else {
          let value = state.value ?? 0;

          if (prop === 'opacity' && value > 1) {
            value = value / 100;
          }

          newLocks[tool][prop] = {
            locked: state.locked ?? false,
            lockedValue: value
          };
        }
      }
    }

    return newLocks;
  }

  /**
   * Get default tool lock configurations for all tools
   * @returns {Object}
   */
  getDefaultToolLocks() {
    const tools = {
      brush: ['size', 'pressure', 'pressureTargets', 'smoothing', 'hardness', 'opacity', 'blendMode'],
      flowPen: ['size', 'pressure', 'pressureTargets', 'smoothing', 'hardness', 'opacity', 'blendMode'],
      ink: ['size', 'pressure', 'pressureTargets', 'smoothing', 'hardness', 'opacity', 'thinning', 'blendMode'],
      pixel: ['size', 'pressure', 'smoothing', 'spacing', 'opacity', 'blendMode'],
      line: ['size', 'hardness', 'opacity', 'blendMode'],
      rectangle: ['size', 'hardness', 'opacity', 'blendMode'],
      circle: ['size', 'hardness', 'opacity', 'blendMode'],
      erase: ['size', 'pressure', 'pressureTargets', 'smoothing', 'hardness', 'opacity'],
      blur: ['size', 'pressure', 'spacing', 'blurRadius', 'opacity', 'blendMode'],
      circleBlur: ['size', 'pressure', 'pressureTargets', 'smoothing', 'hardness', 'spacing', 'opacity', 'blendMode'],
      glitchBlur: ['size', 'pressure', 'spacing', 'blurRadius', 'opacity', 'blendMode'],
      imageBrush: ['size', 'pressure', 'pressureTargets', 'spacing', 'opacity', 'blendMode'],
      pattern: ['size', 'pressure', 'opacity', 'blendMode'],
      confetti: ['size', 'opacity', 'blendMode'],
      fill: ['opacity', 'blendMode'],
      text: ['size', 'opacity', 'blendMode'],
      select: ['opacity', 'blendMode'],
      inkdropper: [],
      pan: [],
      rotate: []
    };

    const locks = {};

    for (const [tool, props] of Object.entries(tools)) {
      locks[tool] = {};
      props.forEach(prop => {
        if (prop === 'pressure') {
          locks[tool][prop] = {
            locked: false,
            lockedValue: { min: 0, max: 100, enabled: true }
          };
        } else {
          const defaultValue = PROPERTY_DEFAULTS[prop] ?? 0;
          const override = TOOL_PROPERTY_OVERRIDES[tool]?.[prop];

          locks[tool][prop] = override ? { ...override } : {
            // Pressure targets start locked so each tool keeps its own: size
            // only, apart from the Fluid Brush's override above.
            locked: prop === 'pressureTargets'
              || (prop === 'blendMode' && ['select', 'blur', 'circleBlur', 'glitchBlur', 'text'].includes(tool)),
            lockedValue: defaultValue
          };
        }
      });
    }

    return locks;
  }

  /**
   * Save tool-specific lock configurations to localStorage
   */
  saveToolLocks() {
    try {
      localStorage.setItem('topDrawToolLocks', JSON.stringify(this.toolLocks));
    } catch (e) {
      console.warn('Failed to save tool locks:', e);
    }
  }

  /**
   * Save current property values for a tool
   * @param {string} toolName - Name of the tool
   */
  saveCurrentValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    for (const [prop, state] of Object.entries(locks)) {
      const value = this.getCurrentPropertyValue(prop);
      if (state.locked) {
        state.lockedValue = value;
      } else {
        this.globalUnlockedValues[prop] = value;
      }
    }

    this.saveToolLocks();
    this.saveGlobalUnlockedValues();
  }

  /**
   * Restore property values for a tool from its locks or global values
   * @param {string} toolName - Name of the tool
   */
  restoreToolValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { self, ui, wsClient, connected, colorPicker } = this.app;
    const { elements } = ui;

    for (const [prop, state] of Object.entries(locks)) {
      const value = state.locked ? state.lockedValue : this.globalUnlockedValues[prop];

      if (prop === 'size') {
        self.setSize(value);
        ui.updateSizeValue(value);
        ui.updateCursorSize(value);
        if (elements.sizeSlider) elements.sizeSlider.value = value;
        if (connected) {
          this.app.inputBufferManager.queueBroadcast(() => wsClient.broadcastSizeChange(value));
        }
      }
      else if (prop === 'pressure') {
        const pMin = value.min ?? 0;
        const pMax = value.max ?? 100;
        const pEnabled = value.enabled ?? true;

        if (elements.pressureMinSlider) elements.pressureMinSlider.value = pMin;
        if (elements.pressureMaxSlider) elements.pressureMaxSlider.value = pMax;
        ui.updatePressureValue(pMin, pMax);
        this.app.pressureEnabled = pEnabled;
        if (elements.pressureEnabled) elements.pressureEnabled.checked = pEnabled;
        ui.setPressureTrackVisible(pEnabled);
      }
      else if (prop === 'pressureTargets') {
        this.app.setPressureTargets?.(value ?? DEFAULT_PRESSURE_TARGETS);
      }
      else if (prop === 'smoothing') {
        self.setSmoothing(value);
        ui.updateSmoothingValue(value);
        if (elements.smoothingSlider) elements.smoothingSlider.value = value;
        if (connected) {
          this.app.inputBufferManager.queueBroadcast(() => wsClient.broadcastSmoothingChange(value));
        }
      }
      else if (prop === 'spacing') {
        self.setSpacing(value);
        ui.updateSpacingValue(value);
        if (elements.spacingSlider) elements.spacingSlider.value = value;
        if (connected) {
          this.app.inputBufferManager.queueBroadcast(() => wsClient.broadcastSpacingChange(value));
        }
      }
      else if (prop === 'hardness') {
        self.setHardness(value);
        ui.updateHardnessValue(value);
        if (elements.hardnessSlider) elements.hardnessSlider.value = value;
        if (connected) {
          this.app.inputBufferManager.queueBroadcast(() => wsClient.broadcastHardnessChange(value));
        }
      }
      else if (prop === 'opacity') {
        const currentColor = [...self.color];
        currentColor[3] = value;
        self.setColor(currentColor);
        self.setOpacity(value);
        ui.updateOpacityValue(value);
        if (elements.opacitySlider) elements.opacitySlider.value = value * 100;
        if (colorPicker) {
          colorPicker.setColor(`rgba(${currentColor.join(',')})`, true);
        }
        if (connected) {
          this.app.inputBufferManager.queueBroadcast(() => wsClient.broadcastColorChange(currentColor));
        }
      }
      else if (prop === 'blurRadius') {
        const radius = this.app.clampBlurRadiusForTool
          ? this.app.clampBlurRadiusForTool(value, self.tool)
          : value;
        self.setBlurRadius(radius);
        ui.updateBlurRadiusValue(radius);
        if (elements.blurRadiusSlider) elements.blurRadiusSlider.value = radius;
        if (connected) {
          this.app.inputBufferManager.queueBroadcast(() => wsClient.broadcastBlurRadiusChange(radius));
        }
      }
      else if (prop === 'thinning') {
        self.setThinning(value);
        ui.updateThinningValue(Math.round(value * 100));
        if (elements.thinningSlider) elements.thinningSlider.value = Math.round(value * 100);
        // Thinning is not yet broadcasted in UserHandlers/DrawingHandlers for some tools? 
        // But we update self.
      }
      else if (prop === 'blendMode') {
        this.app.handleBlendModeChange(value || 'source-over');
      }
    }
  }

  /**
   * Update visibility of lock buttons for a tool
   * @param {string} toolName - Name of the tool
   */
  updateAllLockButtons(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { ui } = this.app;
    const allProps = ['size', 'pressure', 'pressureTargets', 'smoothing', 'spacing', 'hardness', 'opacity', 'blurRadius', 'thinning', 'blendMode'];
    
    allProps.forEach(prop => {
      const lock = locks[prop];
      if (lock) {
        ui.updateLockButton(prop, lock.locked, true);
        if (prop === 'blendMode') appState.blendModeLocked = !!lock.locked;
      } else {
        ui.updateLockButton(prop, false, false);
        if (prop === 'blendMode') appState.blendModeLocked = false;
      }
    });
  }

  /**
   * Toggle the lock state for a property on the active tool
   * @param {string} property - Property name to toggle
   */
  toggleLock(property) {
    const { self, ui } = this.app;
    const tool = self.tool;

    if (!this.toolLocks[tool]) {
      console.warn(`No tool locks for tool: ${tool}`);
      return;
    }

    if (!(property in this.toolLocks[tool])) {
      console.warn(`Property ${property} is not lockable for tool ${tool}`);
      return;
    }

    const lock = this.toolLocks[tool][property];

    lock.locked = !lock.locked;

    if (lock.locked) {
      lock.lockedValue = this.getCurrentPropertyValue(property);
    } else {
      this.saveUnlockedPropertyValue(property);
    }

    ui.updateLockButton(property, lock.locked, true);
    if (property === 'blendMode') appState.blendModeLocked = !!lock.locked;
    this.saveToolLocks();
    this.saveGlobalUnlockedValues();
  }

  getCurrentPropertyValue(property) {
    const { self, ui, pressureEnabled } = this.app;

    if (property === 'pressure') {
      return {
        min: Number(ui.elements.pressureMinSlider.value),
        max: Number(ui.elements.pressureMaxSlider.value),
        enabled: pressureEnabled
      };
    }

    if (property === 'opacity') {
      return self.opacity;
    }

    if (property === 'blendMode') {
      return self.blendMode || 'source-over';
    }

    return self[property];
  }

  saveUnlockedPropertyValue(property) {
    this.globalUnlockedValues[property] = this.getCurrentPropertyValue(property);
  }

  toggleAllLocksForCurrentTool(anchorProperty) {
    const { self, ui } = this.app;
    const tool = self.tool;
    const locks = this.toolLocks[tool];

    if (!locks) {
      console.warn(`No tool locks for tool: ${tool}`);
      return;
    }

    if (!(anchorProperty in locks)) {
      console.warn(`Property ${anchorProperty} is not lockable for tool ${tool}`);
      return;
    }

    const shouldUnlock = !!locks[anchorProperty].locked;

    for (const [property, lock] of Object.entries(locks)) {
      if (shouldUnlock) {
        if (lock.locked) {
          this.saveUnlockedPropertyValue(property);
        }
        lock.locked = false;
      } else {
        lock.locked = true;
        lock.lockedValue = this.getCurrentPropertyValue(property);
      }

      ui.updateLockButton(property, lock.locked, true);
      if (property === 'blendMode') appState.blendModeLocked = !!lock.locked;
    }

    this.saveToolLocks();
    this.saveGlobalUnlockedValues();
  }
}
