<script>
  import {
    appState,
    addCustomColor,
    addFloatingPalette,
    getCustomPresetKey,
    MAX_CUSTOM_COLORS,
    removeCustomColor,
    toggleFloatingPaletteVisibility
  } from '../../state.svelte.js';
  import Dropdown from './Dropdown.svelte';
  import { PRESSURE_TARGET_BITS, PRESSURE_TARGET_SIZE } from '../../../shared/pressureTargets.js';

  let { onColorSelect = null } = $props();

  const TOOL_ICON_URLS = {
    brush: '/images/brush-icon.svg',
    flowPen: '/images/brush-icon.svg',
    ink: '/images/brush-icon.svg',
    pixel: '/images/brush-icon.svg',
    line: '/images/line-icon.svg',
    rectangle: '/images/rectangle-icon.svg',
    circle: '/images/circle-icon.svg',
    text: '/images/text-icon.svg',
    erase: '/images/eraser-icon.svg',
    blur: '/images/blend-icon.svg',
    circleBlur: '/images/circle-blur-icon.svg',
    glitchBlur: '/images/glitch-icon.svg',
    fill: '/images/fillbucket-icon.svg',
    select: '/images/select-icon.svg',
    imageBrush: '/images/pepper.png',
    pattern: '/images/pattern-icon.svg',
    inkdropper: '/images/inkdropper-icon.svg',
    pan: '/images/move-icon.svg',
    zoom: '/images/magnifying-glass.svg',
    rotate: '/images/rotate-icon.svg'
  };
  const COLORLESS_TOOLS = new Set(['erase', 'blur', 'circleBlur', 'glitchBlur', 'select', 'pan', 'zoom', 'rotate', 'inkdropper']);

  const TOOL_LABELS = {
    brush: 'Brush',
    flowPen: 'Fluid Brush',
    ink: 'Ink',
    pixel: 'Pixel',
    line: 'Line',
    rectangle: 'Rectangle',
    circle: 'Circle',
    text: 'Text',
    erase: 'Eraser',
    blur: 'Blur',
    circleBlur: 'Circle Blur',
    glitchBlur: 'Glitch Blur',
    fill: 'Fill',
    select: 'Select',
    imageBrush: 'Image Brush',
    pattern: 'Pattern',
    inkdropper: 'Ink Dropper',
    pan: 'Pan',
    zoom: 'Zoom',
    rotate: 'Rotate'
  };

  const BLEND_MODE_LABELS = {
    'source-over': 'Normal',
    'destination-out': 'Erase',
    multiply: 'Multiply',
    screen: 'Screen',
    overlay: 'Overlay',
    darken: 'Darken',
    lighten: 'Lighten',
    'color-dodge': 'Colour Dodge',
    'color-burn': 'Colour Burn',
    'hard-light': 'Hard Light',
    'soft-light': 'Soft Light',
    difference: 'Difference',
    exclusion: 'Exclusion',
    hue: 'Hue',
    saturation: 'Saturation',
    color: 'Colour',
    luminosity: 'Luminosity'
  };

  /* Keys come from ToolLockManager's lockable properties (plus the three
     pressure* fields getCurrentToolPresetSettings flattens out of `pressure`).
     Anything unrecognised still renders, just with a prettified key. */
  const SETTING_LABELS = {
    size: 'Size',
    smoothing: 'Smoothing',
    hardness: 'Hardness',
    opacity: 'Opacity',
    spacing: 'Spacing',
    blurRadius: 'Blur Radius',
    thinning: 'Thinning',
    blendMode: 'Blend'
  };

  const HOVER_DELAY_MS = 450;

  let hoverPreset = $state(null);
  let hoverAnchor = $state(null);
  let hoverTimer = null;

  /* pointerup fires for every button, so right-click would otherwise trigger
     the primary action as well as the contextmenu one. Testing for "is the
     secondary/middle button" rather than "is button 0" deliberately: touch and
     pen report 0, but a synthesized pointerup can carry -1, and those must
     still activate the swatch. */
  function isSecondaryButton(event) {
    return event.button > 0;
  }

  function prettifyKey(key) {
    const spaced = key.replace(/([A-Z])/g, ' $1');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function formatSettingValue(key, value) {
    if (key === 'blendMode') return BLEND_MODE_LABELS[value] || value;
    if (key === 'opacity') {
      // Stored 0–1 by getCurrentToolPresetSettings, but older saved presets
      // and some tools hand back 0–100 already.
      const pct = Number(value) <= 1 ? Number(value) * 100 : Number(value);
      return `${Math.round(pct)}%`;
    }
    if (key === 'hardness') return `${Math.round(Number(value))}%`;
    if (typeof value === 'number') return `${Math.round(value * 100) / 100}`;
    if (typeof value === 'boolean') return value ? 'On' : 'Off';
    return String(value);
  }

  function getPresetRows(preset) {
    const rows = [];
    if (preset?.size != null) {
      rows.push({ label: 'Size', value: formatSettingValue('size', preset.size) });
    }

    const settings = preset?.settings || {};
    for (const [key, value] of Object.entries(settings)) {
      if (value == null) continue;
      // Size is already shown from the preset itself; don't print it twice.
      if (key === 'size') continue;
      if (key === 'pressureMin' || key === 'pressureMax' || key === 'pressureEnabled' || key === 'pressureTargets') continue;
      rows.push({ label: SETTING_LABELS[key] || prettifyKey(key), value: formatSettingValue(key, value) });
    }

    if ('pressureEnabled' in settings) {
      rows.push({
        label: 'Pressure',
        value: settings.pressureEnabled
          ? `${Math.round(settings.pressureMin ?? 0)}–${Math.round(settings.pressureMax ?? 100)}%${formatPressureTargets(settings.pressureTargets)}`
          : 'Off'
      });
    }

    return rows;
  }

  // Size-only is how pressure always worked (and what presets saved before
  // targets existed mean), so only mention targets when they differ.
  function formatPressureTargets(targets) {
    if (targets == null || targets === PRESSURE_TARGET_SIZE) return '';
    const names = Object.entries(PRESSURE_TARGET_BITS)
      .filter(([, bit]) => targets & bit)
      .map(([name]) => name[0].toUpperCase() + name.slice(1));
    return ` · ${names.length ? names.join(', ') : 'nothing'}`;
  }

  function getToolLabel(tool) {
    if (!tool) return 'Colour';
    return TOOL_LABELS[tool] || prettifyKey(tool);
  }

  function scheduleHover(preset, event) {
    // Touch/pen already have press-and-hold semantics elsewhere; a delayed
    // popup on those just fights the tap.
    if (event.pointerType && event.pointerType !== 'mouse') return;

    const target = event.currentTarget;
    clearHover();
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      hoverAnchor = target.getBoundingClientRect();
      hoverPreset = preset;
    }, HOVER_DELAY_MS);
  }

  function clearHover() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hoverPreset = null;
    hoverAnchor = null;
  }

  /* Fixed-position so the sidebar's stacking contexts can't clip it. The
     palette sits at the bottom-right, so anchor bottom-right-to-left of the
     swatch and grow up/left. */
  function hoverStyle(rect) {
    if (!rect) return '';
    const bottom = Math.max(8, window.innerHeight - rect.bottom);
    return `left: ${rect.left - 10}px; bottom: ${bottom}px;`;
  }

  // Kill any pending timer if the palette unmounts mid-hover.
  $effect(() => () => clearHover());

  function colorToRgba(color) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;
  }

  function colorToHex(color) {
    const r = color[0].toString(16).padStart(2, '0');
    const g = color[1].toString(16).padStart(2, '0');
    const b = color[2].toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }

  function getToolIconUrl(tool) {
    return TOOL_ICON_URLS[tool] || null;
  }

  function colorsEqual(a, b) {
    return Array.isArray(a) &&
      Array.isArray(b) &&
      a[0] === b[0] &&
      a[1] === b[1] &&
      a[2] === b[2] &&
      a[3] === b[3];
  }

  function settingsEqual(a, b) {
    const left = a || {};
    const right = b || {};
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key) => left[key] === right[key]);
  }

  function isPresetSelected(preset) {
    if (!preset?.color) {
      return false;
    }

    if (!COLORLESS_TOOLS.has(preset.tool) && !colorsEqual(preset.color, appState.currentColor)) {
      return false;
    }

    if (preset.tool && preset.tool !== appState.currentTool) {
      return false;
    }

    if (preset.size != null && preset.size !== appState.currentSize) {
      return false;
    }

    const selectedByClick = getCustomPresetKey(preset) === appState.activeCustomPresetKey;
    if (!preset.settings) {
      return selectedByClick;
    }

    return selectedByClick && settingsEqual(preset.settings, appState.currentToolSettings);
  }

  function selectColor(color) {
    appState.currentColor = [...color];
    appState.activeCustomPresetKey = null;
    if (onColorSelect) {
      onColorSelect(color);
    }
  }

  function selectPreset(preset) {
    appState.currentColor = [...preset.color];
    appState.activeCustomPresetKey = getCustomPresetKey(preset);
    if (onColorSelect) {
      onColorSelect(preset);
    }
  }

  function handleAddCustom() {
    const current = appState.currentColor;
    if (onColorSelect) {
      onColorSelect((currentColor, settings) => {
        addCustomColor(currentColor, settings);
      });
    } else {
      addCustomColor(current);
    }
  }

  function handleRemoveCustom(preset, event) {
    event.preventDefault();
    event.stopPropagation();
    removeCustomColor(preset);
  }

  function toggleRecentPalette() {
    appState.recentPaletteVisible = !appState.recentPaletteVisible;
  }

  function handleAddFloatingPalette() {
    addFloatingPalette();
  }

  function toggleFloatingPalette(paletteId) {
    toggleFloatingPaletteVisibility(paletteId);
  }

  // Positioning, portalling and outside-click now live in Dropdown.svelte.
</script>

<div class="color-palette">
  <!-- Palette Controls -->
  <div class="palette-controls">
    <div class="palette-menu-wrap">
      <Dropdown
        variant="flat"
        size="sm"
        uppercase
        label="Palettes"
        ariaLabel="Manage floating palettes"
      >
        {#snippet menu(close)}
          <button
            class="dd-option"
            class:active={appState.recentPaletteVisible}
            onclick={toggleRecentPalette}
            role="menuitemcheckbox"
            aria-checked={appState.recentPaletteVisible}
          >
            <span class="dd-option-label">Recents</span>
            <span class="dd-option-state">{appState.recentPaletteVisible ? 'On' : 'Off'}</span>
          </button>

          {#each appState.floatingPalettes as palette}
            <button
              class="dd-option"
              class:active={palette.visible !== false}
              onclick={() => toggleFloatingPalette(palette.id)}
              role="menuitemcheckbox"
              aria-checked={palette.visible !== false}
              title={palette.name}
            >
              <span class="dd-option-label">{palette.name}</span>
              <span class="dd-option-state">{palette.visible !== false ? 'On' : 'Off'}</span>
            </button>
          {/each}

          <div class="dd-menu-separator"></div>

          <button
            class="dd-option"
            onclick={() => { handleAddFloatingPalette(); close(); }}
            role="menuitem"
            title="Add floating palette"
          >
            <span class="palette-add-icon">+</span>
            <span class="dd-option-label">Add palette</span>
          </button>
        {/snippet}
      </Dropdown>
    </div>
  </div>

  <!-- Custom Colors — the + button is self-explanatory, so no header/hint row
       here: that height goes to the tool options above instead. -->
  <div class="palette-section">
    <div class="swatch-grid">
      {#each appState.customColors as preset}
        <div class="custom-swatch-wrap">
          <button
            class="swatch"
            class:selected={isPresetSelected(preset)}
            style="background-color: {colorToRgba(preset.color)}"
            aria-label="{getToolLabel(preset.tool)} preset {colorToHex(preset.color)}"
            onpointerup={(e) => { if (isSecondaryButton(e)) return; clearHover(); selectPreset(preset); }}
            oncontextmenu={(e) => { clearHover(); handleRemoveCustom(preset, e); }}
            onpointerenter={(e) => scheduleHover(preset, e)}
            onpointerleave={clearHover}
          >
            {#if preset.tool && getToolIconUrl(preset.tool)}
              <img src={getToolIconUrl(preset.tool)} alt={preset.tool} class="tool-icon-overlay" />
            {/if}
          </button>
        </div>
      {/each}
      {#if appState.customColors.length < MAX_CUSTOM_COLORS}
        <div class="custom-swatch-wrap">
          <button
            class="swatch add-swatch"
            title="Save current color"
            onpointerup={(e) => { if (isSecondaryButton(e)) return; handleAddCustom(); }}
          >+</button>
        </div>
      {/if}
    </div>
  </div>
</div>

{#if hoverPreset}
  <div class="preset-tip" style={hoverStyle(hoverAnchor)} role="tooltip">
    <div class="preset-tip-head">
      {#if getToolIconUrl(hoverPreset.tool)}
        <img src={getToolIconUrl(hoverPreset.tool)} alt="" class="preset-tip-icon" />
      {/if}
      <span class="preset-tip-title">{getToolLabel(hoverPreset.tool)}</span>
      {#if !COLORLESS_TOOLS.has(hoverPreset.tool)}
        <span class="preset-tip-chip" style="background-color: {colorToRgba(hoverPreset.color)}"></span>
        <span class="preset-tip-hex">{colorToHex(hoverPreset.color)}</span>
      {/if}
    </div>

    {#each getPresetRows(hoverPreset) as row}
      <div class="preset-tip-row">
        <span class="preset-tip-label">{row.label}</span>
        <span class="preset-tip-value">{row.value}</span>
      </div>
    {:else}
      <div class="preset-tip-empty">No tool options saved</div>
    {/each}

    <div class="preset-tip-foot">Right-click to remove</div>
  </div>
{/if}


<style>
  .color-palette {
    display: flex;
    flex-direction: column;
    border-top: 2px solid var(--bg-secondary);
    gap: 0.2rem;
    padding: 0.25rem 0.675rem;
  }

  .palette-section {
    display: flex;
    flex-direction: column;
  }

  .palette-controls {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    padding-top: 0.25rem;
  }

  .palette-menu-wrap {
    position: relative;
    flex: 1;
    z-index: 1;
  }

  .palette-add-icon {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 212, 170, 0.12);
    font-size: 1rem;
    line-height: 1;
  }

  /* Fixed 4 columns, down from 6: the swatches are 1fr of the panel width, so
     dropping two columns is what actually makes each one ~50% bigger. auto-fill
     can't do this — it re-adds columns as the sidebar widens and pins the tiles
     back to their minimum. */
  .swatch-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    /* Without this the cells stretch to the row height and that height wins
       over the wrapper's aspect-ratio, squashing the swatches. */
    align-items: start;
  }

  .swatch {
    /* The wrapper owns the square; the button just fills it. Buttons
       shrink-to-fit even as flex containers, so both axes must be stated. */
    width: 100%;
    height: 100%;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    padding: 0;
    background: none;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .swatch:not(.empty):not(.add-swatch):hover {
    transform: scale(1.1);
    border-color: rgba(255, 255, 255, 0.3);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .swatch.selected {
    border-color: var(--accent-primary);
    box-shadow:
      0 0 0 1px var(--bg-secondary),
      0 0 0 3px color-mix(in srgb, var(--accent-primary) 75%, transparent),
      0 2px 8px rgba(0, 0, 0, 0.35);
  }

  .swatch.selected:hover {
    border-color: var(--accent-primary);
  }

  .swatch:not(.empty):not(.add-swatch):active {
    transform: scale(0.95);
  }

  .swatch.add-swatch {
    background: rgba(0, 212, 170, 0.1);
    border-color: rgba(0, 212, 170, 0.2);
    color: #00d4aa;
    font-size: 1.6rem;
    font-weight: 300;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .swatch.add-swatch:hover {
    background: rgba(0, 212, 170, 0.2);
    border-color: rgba(0, 212, 170, 0.4);
    transform: scale(1.05);
  }

  /* Single source of truth for swatch shape — one knob for the whole grid.
     Still wider than tall, just less so: lower this toward 1 for squarer. */
  .custom-swatch-wrap {
    position: relative;
    aspect-ratio: 1.15 / 1;
    min-width: 0;
  }

  .tool-icon-overlay {
    width: 60%;
    height: 60%;
    object-fit: contain;
    opacity: 0.85;
    pointer-events: none;
    /* Swatch colours run light to dark, so the white glyph needs its own
       shadow to stay readable on pale presets. */
    filter: brightness(0) invert(1) drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.55));
  }

  /* Deliberately mirrors .tool-toggle-hint in _sidebar.scss — same card
     language (accent left edge, elevated bg, 11px) so the two hint styles
     in this panel don't read as two different systems. */
  .preset-tip {
    position: fixed;
    transform: translateX(-100%);
    z-index: 1200;
    width: max-content;
    min-width: 140px;
    max-width: 240px;
    padding: 8px 10px;
    border: 1px solid var(--border-subtle);
    border-left: 2px solid var(--accent-primary);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-lg);
    color: var(--text-primary);
    font-size: 11px;
    line-height: 1.45;
    letter-spacing: normal;
    text-transform: none;
    pointer-events: none;
  }

  .preset-tip-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding-bottom: 0.35rem;
    margin-bottom: 0.3rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .preset-tip-icon {
    width: 14px;
    height: 14px;
    object-fit: contain;
    filter: brightness(0) invert(1);
    opacity: 0.85;
  }

  .preset-tip-title {
    font-weight: 600;
    margin-right: auto;
  }

  .preset-tip-chip {
    width: 11px;
    height: 11px;
    border-radius: 3px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    flex: 0 0 auto;
  }

  .preset-tip-hex {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }

  .preset-tip-row {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .preset-tip-label {
    opacity: 0.65;
  }

  .preset-tip-value {
    font-variant-numeric: tabular-nums;
  }

  .preset-tip-empty {
    opacity: 0.55;
    font-style: italic;
  }

  .preset-tip-foot {
    margin-top: 0.35rem;
    padding-top: 0.3rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 10px;
    color: var(--text-muted);
  }
</style>
