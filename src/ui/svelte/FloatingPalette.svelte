<script>
  import {
    appState,
    addColorToFloatingPalette,
    FLOATING_PALETTE_SLOT_COUNT,
    setFloatingPaletteVisibility
  } from '../../state.svelte.js';
  import { playGenieOut, playGenieIn } from './geniePanelAnimation.js';

  let {
    onColorSelect = null,
    paletteId = null,
    initialLeft = null,
    initialTop = null
  } = $props();

  let panel = $state(null);
  let left = $state(null);
  let top = $state(null);
  let width = $state(64);
  let height = $state(178);
  let userPositioned = $state(false);
  let dragging = $state(false);
  let resizing = $state(false);

  const PANEL_MARGIN = 6;
  const MIN_WIDTH = 44;
  const MAX_WIDTH = 130;
  const DEFAULT_WIDTH = 64;
  const DEFAULT_HEIGHT = 178;
  const OUTER_PADDING = 8;
  const TITLEBAR_HEIGHT = 22;
  const TITLEBAR_GAP = 3;
  const GRID_GAP = 3;
  const COLUMN_COUNT = 2;
  const ROW_COUNT = 5;

  let palette = $derived.by(() => {
    if (paletteId) {
      return appState.floatingPalettes.find((item) => item.id === paletteId) || null;
    }

    return {
      id: 'recent-colors',
      name: 'Recents',
      colors: appState.recentColors
    };
  });

  let editable = $derived(Boolean(paletteId));
  let visible = $derived(paletteId ? palette?.visible !== false : appState.recentPaletteVisible);

  let slots = $derived.by(() => {
    const paletteColors = palette?.colors || [];

    return Array.from({ length: FLOATING_PALETTE_SLOT_COUNT }, (_, i) => ({
      color: paletteColors[i] || null
    }));
  });

  // Both the Recents palette and every custom floating palette reopen from
  // the same "Palettes" menu trigger in ColorPalette.svelte - that's the
  // genie target for all of them.
  function getGenieTarget() {
    return document.querySelector('[aria-label="Manage floating palettes"]');
  }

  function hidePanel() {
    const applyHide = () => {
      if (paletteId) {
        setFloatingPaletteVisibility(paletteId, false);
      } else {
        appState.recentPaletteVisible = false;
      }
    };
    playGenieOut(panel, getGenieTarget(), applyHide);
  }

  let wasVisible = visible;
  $effect(() => {
    if (visible && !wasVisible) {
      playGenieIn(panel, getGenieTarget());
    }
    wasVisible = visible;
  });

  function selectColor(color) {
    appState.currentColor = [...color];
    onColorSelect?.(color);
  }

  function addCurrentColor(slotIndex) {
    if (!paletteId) {
      return;
    }

    addColorToFloatingPalette(paletteId, appState.currentColor, slotIndex);
  }

  function colorStyle(color) {
    const alpha = color[3] > 1 ? color[3] / 255 : color[3];

    return `background-color: rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
  }

  function clampValue(value, minValue, maxValue) {
    return Math.max(minValue, Math.min(value, maxValue));
  }

  function getSquarePaletteHeight(nextWidth) {
    const gridWidth = Math.max(0, nextWidth - OUTER_PADDING);
    const slotSize = (gridWidth - (GRID_GAP * (COLUMN_COUNT - 1))) / COLUMN_COUNT;

    return OUTER_PADDING + TITLEBAR_HEIGHT + TITLEBAR_GAP + (slotSize * ROW_COUNT) + (GRID_GAP * (ROW_COUNT - 1));
  }

  function getBoardLayout(nextWidth = width) {
    const boards = panel?.closest?.('#floatingPaletteMount') || panel?.parentElement || (
      typeof document !== 'undefined' ? document.getElementById('boardContainer') : null
    );
    const boardWidth = boards?.clientWidth || boards?.getBoundingClientRect?.().width || nextWidth + (PANEL_MARGIN * 2);
    const boardHeight = boards?.clientHeight || boards?.getBoundingClientRect?.().height || DEFAULT_HEIGHT + (PANEL_MARGIN * 2);
    const maxWidthByHeight = (((Math.max(0, boardHeight - (PANEL_MARGIN * 2) - OUTER_PADDING - TITLEBAR_HEIGHT - TITLEBAR_GAP - (GRID_GAP * (ROW_COUNT - 1))) / ROW_COUNT) * COLUMN_COUNT) + (GRID_GAP * (COLUMN_COUNT - 1)) + OUTER_PADDING);
    const resolvedWidth = clampValue(
      nextWidth,
      MIN_WIDTH,
      Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, boardWidth - (PANEL_MARGIN * 2)), Math.max(MIN_WIDTH, maxWidthByHeight))
    );
    const resolvedHeight = getSquarePaletteHeight(resolvedWidth);
    const maxLeft = Math.max(PANEL_MARGIN, boardWidth - resolvedWidth - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, boardHeight - resolvedHeight - PANEL_MARGIN);

    return {
      safeLeft: PANEL_MARGIN,
      safeTop: PANEL_MARGIN,
      width: resolvedWidth,
      height: resolvedHeight,
      maxLeft,
      maxTop,
      dockLeft: maxLeft,
      dockTop: maxTop
    };
  }

  function syncPanelPosition(forceDock = false) {
    const bounds = getBoardLayout(width);
    width = bounds.width;
    height = bounds.height;

    if (forceDock || !userPositioned || left == null || top == null) {
      left = initialLeft != null ? clampValue(initialLeft, bounds.safeLeft, bounds.maxLeft) : bounds.dockLeft;
      top = initialTop != null ? clampValue(initialTop, bounds.safeTop, bounds.maxTop) : bounds.dockTop;
      return;
    }

    left = clampValue(left, bounds.safeLeft, bounds.maxLeft);
    top = clampValue(top, bounds.safeTop, bounds.maxTop);
  }

  function clampPanelPosition(nextLeft, nextTop, nextWidth = width) {
    const bounds = getBoardLayout(nextWidth);

    return {
      left: clampValue(nextLeft, bounds.safeLeft, bounds.maxLeft),
      top: clampValue(nextTop, bounds.safeTop, bounds.maxTop)
    };
  }

  function getBoardPointerScale() {
    const boards = panel?.closest?.('#floatingPaletteMount') || panel?.parentElement;
    const rect = boards?.getBoundingClientRect?.();
    const localWidth = boards?.clientWidth || rect?.width || 1;
    const localHeight = boards?.clientHeight || rect?.height || 1;

    return {
      x: rect?.width ? localWidth / rect.width : 1,
      y: rect?.height ? localHeight / rect.height : 1
    };
  }

  function startDrag(event) {
    if (!visible || !panel) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const panelRect = panel.getBoundingClientRect();
    const startLeft = left ?? panel.offsetLeft ?? panelRect.left;
    const startTop = top ?? panel.offsetTop ?? panelRect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerScale = getBoardPointerScale();
    dragging = true;
    document?.body?.classList?.add?.('floating-palette-dragging');

    const handleMove = (moveEvent) => {
      const next = clampPanelPosition(
        startLeft + ((moveEvent.clientX - startX) * pointerScale.x),
        startTop + ((moveEvent.clientY - startY) * pointerScale.y)
      );

      left = next.left;
      top = next.top;
      userPositioned = true;
    };

    const handleUp = () => {
      dragging = false;
      document?.body?.classList?.remove?.('floating-palette-dragging');
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }

  function startResize(event) {
    if (!visible || !panel) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const startWidth = width || panel.offsetWidth || DEFAULT_WIDTH;
    const startLeft = left ?? panel.offsetLeft ?? 0;
    const startTop = top ?? panel.offsetTop ?? 0;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerScale = getBoardPointerScale();
    resizing = true;
    document?.body?.classList?.add?.('floating-palette-resizing');

    const handleMove = (moveEvent) => {
      const nextWidth = startWidth + ((moveEvent.clientX - startX) * pointerScale.x);
      const bounds = getBoardLayout(nextWidth);
      const next = clampPanelPosition(startLeft, startTop, bounds.width);

      width = bounds.width;
      height = bounds.height;
      left = next.left;
      top = next.top;
      userPositioned = true;
    };

    const handleUp = () => {
      resizing = false;
      document?.body?.classList?.remove?.('floating-palette-resizing');
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }

  $effect(() => {
    width = DEFAULT_WIDTH;
    height = DEFAULT_HEIGHT;
  });

  $effect(() => {
    if (typeof window === 'undefined' || !panel || !visible) {
      return;
    }

    const sync = () => syncPanelPosition(!userPositioned);
    sync();

    window.addEventListener('resize', sync);
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    resizeObserver?.observe?.(panel.parentElement);

    return () => {
      window.removeEventListener('resize', sync);
      resizeObserver?.disconnect?.();
    };
  });

  function panelStyle() {
    const bounds = getBoardLayout(width);
    const resolvedLeft = left != null ? clampValue(left, bounds.safeLeft, bounds.maxLeft) : (initialLeft != null ? clampValue(initialLeft, bounds.safeLeft, bounds.maxLeft) : bounds.dockLeft);
    const resolvedTop = top != null ? clampValue(top, bounds.safeTop, bounds.maxTop) : (initialTop != null ? clampValue(initialTop, bounds.safeTop, bounds.maxTop) : bounds.dockTop);

    return [
      `width: ${bounds.width}px`,
      `height: ${bounds.height}px`,
      `left: ${resolvedLeft}px`,
      `top: ${resolvedTop}px`,
      `display: ${visible ? 'flex' : 'none'}`
    ].join('; ');
  }
</script>

<div
  bind:this={panel}
  id="floatingPalette"
  class="floating-palette"
  class:dragging
  class:resizing
  style={panelStyle()}
  role="region"
  aria-label={`${palette?.name || 'Color'} palette`}
  aria-hidden={!visible}
>
  <div class="palette-titlebar" role="button" tabindex="0" onpointerdown={startDrag} title="Drag to move" aria-label="Move palette">
    <span class="palette-title">{palette?.name || 'Palette'}</span>
    <button
      type="button"
      class="palette-close"
      title="Minimize (reopen from the Palettes menu)"
      aria-label="Minimize palette"
      onclick={hidePanel}
      onpointerdown={(event) => event.stopPropagation()}
    >
      <!-- A minus, not an X/chevron: this minimizes to the Palettes menu, it
           doesn't delete or collapse the panel in place. -->
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 12h14" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" />
      </svg>
    </button>
  </div>

  <div class="palette-grid">
    {#each slots as slot, i}
      {#if slot.color}
        <button
          class="color-slot"
          style={colorStyle(slot.color)}
          title={`Color ${i + 1}`}
          onpointerup={() => selectColor(slot.color)}
        ></button>
      {:else if editable}
        <button
          class="color-slot empty"
          title="Add current color"
          aria-label="Add current color"
          onpointerup={() => addCurrentColor(i)}
        >
          <span class="plus-icon">+</span>
        </button>
      {:else}
        <div class="color-slot empty" aria-hidden="true"></div>
      {/if}
    {/each}
  </div>

  <button
    type="button"
    class="palette-resize"
    title="Resize palette"
    aria-label="Resize palette"
    onclick={(event) => event.preventDefault()}
    onpointerdown={startResize}
  ></button>
</div>

<style>
  :global(#floatingPaletteMount) {
    position: absolute;
    inset: 0;
    z-index: 1480;
    pointer-events: none;
  }

  /* On mobile the tool options panel (incl. the colour wheel) becomes a
     fixed overlay that slides on top of the board — keep palettes underneath
     it so an open panel isn't blocked by a docked palette. */
  :global(html[data-mobile='true'] #floatingPaletteMount) {
    z-index: 50;
  }

  :global(body.floating-palette-dragging),
  :global(body.floating-palette-dragging *) {
    cursor: grabbing !important;
  }

  :global(body.floating-palette-resizing),
  :global(body.floating-palette-resizing *) {
    cursor: nwse-resize !important;
  }

  .floating-palette {
    position: absolute;
    z-index: 1480;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: color-mix(in srgb, var(--bg-secondary) 95%, black);
    border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
    border-radius: 7px;
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.34);
    pointer-events: auto;
    touch-action: none;
    user-select: none;
  }

  .palette-titlebar {
    height: 22px;
    min-height: 22px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 0 1px 3px 6px;
    cursor: grab;
  }

  .palette-titlebar:active {
    cursor: grabbing;
  }

  .palette-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: color-mix(in srgb, var(--text-secondary) 82%, transparent);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0;
  }

  .palette-close {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: color-mix(in srgb, var(--text-secondary) 78%, transparent);
    cursor: pointer;
    display: grid;
    place-items: center;
    transition: color 0.15s ease, background 0.15s ease;
  }

  .palette-close:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-primary);
  }

  .palette-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: repeat(5, minmax(0, 1fr));
    gap: 3px;
  }

  .color-slot {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    padding: 0;
    margin: 0;
    background: none;
    cursor: pointer;
    transition: transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
  }

  .color-slot:hover {
    z-index: 2;
    transform: scale(1.06);
    border-color: rgba(255, 255, 255, 0.42);
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.36);
  }

  .color-slot:active {
    transform: scale(0.96);
  }

  .color-slot.empty {
    display: grid;
    place-items: center;
    background: rgba(255, 255, 255, 0.07);
    color: rgba(255, 255, 255, 0.62);
    cursor: pointer;
    font-size: 1rem;
    font-weight: 500;
  }

  div.color-slot.empty {
    cursor: default;
  }

  .plus-icon {
    pointer-events: none;
    line-height: 1;
    transform: translateY(-1px);
  }

  .palette-resize {
    position: absolute;
    right: 1px;
    bottom: 1px;
    width: 16px;
    height: 16px;
    border: 0;
    border-radius: 4px;
    padding: 0;
    background:
      linear-gradient(135deg, transparent 46%, color-mix(in srgb, var(--text-secondary) 44%, transparent) 47%, transparent 54%),
      linear-gradient(135deg, transparent 62%, color-mix(in srgb, var(--text-secondary) 34%, transparent) 63%, transparent 70%);
    cursor: nwse-resize;
  }

  .palette-resize:hover {
    background-color: rgba(255, 255, 255, 0.08);
  }
</style>
