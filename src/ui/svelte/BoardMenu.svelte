<script>
  import { appState, toggleSnapshotMenu } from '../../state.svelte.js';
  import { LayerPreview } from '../LayerPreview.js';
  import ToolPreview from './ToolPreview.svelte';
  import ImageSelectorWindow from './ImageSelectorWindow.svelte';

  let { onBlendModeChange = null, onBlendBakeModeChange = null, onBlendModeLockToggle = null, onLayerSelect = null, onLayerVisibilityToggle = null } = $props();

  let layerPreviewInstance = null;
  let hoveredLayer = null;
  let hoveredLayerBtn = null;

  let blendModeAllowed = $derived(appState.activeLayer === 0);
  let isSoloOccupant = $derived(appState.userCount <= 1);
  let canOpenHistory = $derived(appState.selfRole >= 1 || isSoloOccupant);

  const blendModes = [
    { value: 'source-over', label: 'Normal' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'screen', label: 'Screen' },
    { value: 'lighter', label: 'Add' },
    { value: 'overlay', label: 'Overlay' },
    { value: 'darken', label: 'Darken' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'difference', label: 'Difference' },
    { value: 'color-dodge', label: 'Color Dodge' },
    { value: 'color-burn', label: 'Color Burn' }
  ];

  const layers = [
    { index: 2, label: 'Layer 3' },
    { index: 1, label: 'Layer 2' },
    { index: 0, label: 'Layer 1' }
  ];

  let activeLayerLabel = $derived(layers.find(layer => layer.index === appState.activeLayer)?.label ?? 'Layer');

  $effect(() => {
    const preview = new LayerPreview();
    preview.init();
    layerPreviewInstance = preview;
    return () => { layerPreviewInstance = null; };
  });

  $effect(() => {
    function handleClickOutside(event) {
      const target = event.target;
      if (!target.closest('.board-menu') && appState.boardMenuOpen) {
        appState.boardMenuOpen = null;
      }
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  });

  function toggleMenu(menuType) {
    appState.boardMenuOpen = appState.boardMenuOpen === menuType ? null : menuType;
  }

  function selectBlendMode(mode) {
    appState.blendMode = mode;
    appState.boardMenuOpen = null;
    if (onBlendModeChange) onBlendModeChange(mode);
  }

  function handleBlendModeClick(event, mode) {
    event.stopPropagation();
    selectBlendMode(mode);
  }

  function selectBlendBakeMode(mode) {
    appState.blendBakeMode = mode === 'background' ? 'background' : 'existing';
    if (onBlendBakeModeChange) onBlendBakeModeChange(appState.blendBakeMode);
  }

  function handleBlendBakeModeClick(event, mode) {
    event.stopPropagation();
    selectBlendBakeMode(mode);
  }

  function toggleBlendModeLock(event) {
    event.stopPropagation();
    if (onBlendModeLockToggle) onBlendModeLockToggle(event);
  }

  function selectLayer(layerIdx) {
    appState.activeLayer = layerIdx;
    if (layerIdx !== 0 && appState.boardMenuOpen === 'blend') {
      appState.boardMenuOpen = null;
    } else if (appState.boardMenuOpen === 'layers') {
      appState.boardMenuOpen = null;
    }
    if (onLayerSelect) onLayerSelect(layerIdx);
  }

  function toggleLayerVis(layerIdx, event) {
    event.stopPropagation();
    if (onLayerVisibilityToggle) {
      const newVisible = onLayerVisibilityToggle(layerIdx);
      appState.layerVisibility = { ...appState.layerVisibility, [layerIdx]: newVisible };
    } else {
      appState.layerVisibility = {
        ...appState.layerVisibility,
        [layerIdx]: !appState.layerVisibility[layerIdx]
      };
    }
  }

  function handleLayerHover(layerIdx, event) {
    const liveLayerManager = appState.board?.layerManager || appState.layerManager;
    if (!liveLayerManager || !layerPreviewInstance) return;

    hoveredLayer = layerIdx;
    hoveredLayerBtn = event.currentTarget;

    const rect = event.currentTarget.getBoundingClientRect();
    layerPreviewInstance.show(layerIdx, liveLayerManager, rect.left, rect.top + rect.height / 2);
  }

  function handleLayerLeave() {
    hoveredLayer = null;
    hoveredLayerBtn = null;
    if (layerPreviewInstance) {
      layerPreviewInstance.hide();
    }
  }
</script>

<div class="board-menu">
  <!-- Tool preview (collapsible, above layers) -->
  <ToolPreview />

  <!-- Layers (always visible, no frame) -->
  <div class="layer-dropdown-wrap">
    <button
      class="layer-dropdown-btn"
      data-tut="layers"
      class:open={appState.boardMenuOpen === 'layers'}
      onclick={() => toggleMenu('layers')}
      title="Select layer"
      aria-label="Select layer"
      aria-expanded={appState.boardMenuOpen === 'layers'}
    >
      <span>{activeLayerLabel}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    {#if appState.boardMenuOpen === 'layers'}
      <div
        class="layer-dropdown"
        onclick={(e) => e.stopPropagation()}
        onpointerdown={(e) => e.stopPropagation()}
        onpointerup={(e) => e.stopPropagation()}
        role="menu"
        tabindex="0"
        onkeydown={(e) => e.key === 'Escape' && (appState.boardMenuOpen = null)}
      >
        {#each layers as layer}
          <div class="layer-row">
            <button
              class="eye-btn"
              class:faded={!appState.layerVisibility[layer.index]}
              onclick={(e) => toggleLayerVis(layer.index, e)}
              title="Toggle visibility"
            >
              {#if appState.layerVisibility[layer.index]}
                <img src="../images/eye-open.svg" alt="Visible" width="14" height="14" style="filter: invert(1) brightness(1.5);" />
              {:else}
                <img src="/images/eye-closed.svg" alt="Hidden" width="14" height="14" />
              {/if}
            </button>
            <button
              class="layer-btn"
              class:active={appState.activeLayer === layer.index}
              data-tut={layer.index === 0 ? 'layer-1' : 'layers'}
              onclick={() => selectLayer(layer.index)}
            >
              {layer.label}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="layer-list" data-tut="layers">
    {#each layers as layer}
      <div class="layer-row">
        <button
          class="eye-btn"
          class:faded={!appState.layerVisibility[layer.index]}
          onclick={(e) => toggleLayerVis(layer.index, e)}
          title="Toggle visibility"
        >
          {#if appState.layerVisibility[layer.index]}
            <img src="../images/eye-open.svg" alt="Visible" width="14" height="14" style="filter: invert(1) brightness(1.5);" />
          {:else}
            <img src="/images/eye-closed.svg" alt="Hidden" width="14" height="14" />
          {/if}
        </button>
        <button
          class="layer-btn"
          data-tut={layer.index === 0 ? 'layer-1' : 'layers'}
          class:active={appState.activeLayer === layer.index}
          onclick={() => selectLayer(layer.index)}
          onmouseenter={(e) => handleLayerHover(layer.index, e)}
          onmouseleave={handleLayerLeave}
        >
          {layer.label}
        </button>
      </div>
    {/each}
  </div>

  <!-- Blend Mode Button + Dropdown (only on Layer 1) -->
  {#if blendModeAllowed}
  <div class="blend-wrap" data-tut="layers">
    <button
      class="blend-btn"
      data-tut="blend-mode"
      class:open={appState.boardMenuOpen === 'blend'}
      onclick={() => toggleMenu('blend')}
      title="Blend Mode"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="9" cy="9" r="7" opacity="0.6" />
        <circle cx="15" cy="15" r="7" opacity="0.6" />
      </svg>
      <span>{blendModes.find(m => m.value === appState.blendMode)?.label ?? 'Normal'}</span>
    </button>

    {#if appState.boardMenuOpen === 'blend'}
      <div
        class="blend-dropdown"
        onclick={(e) => e.stopPropagation()}
        onpointerdown={(e) => e.stopPropagation()}
        onpointerup={(e) => e.stopPropagation()}
        role="menu"
        tabindex="0"
        onkeydown={(e) => e.key === 'Escape' && (appState.boardMenuOpen = null)}
      >
        <div class="blend-dropdown-header">
          <span>{blendModes.find(m => m.value === appState.blendMode)?.label ?? 'Normal'}</span>
          <button
            class="blend-lock-btn"
            class:locked={appState.blendModeLocked}
            onclick={toggleBlendModeLock}
            title={appState.blendModeLocked ? 'Unlock blend mode for current tool. Shift-click to unlock all current tool settings' : 'Lock blend mode for current tool. Shift-click to lock all current tool settings'}
            aria-label={appState.blendModeLocked ? 'Unlock blend mode for current tool' : 'Lock blend mode for current tool'}
          >
            <img src={appState.blendModeLocked ? '/images/lock-closed.svg' : '/images/lock-open.svg'} alt="" />
          </button>
        </div>
        <div class="blend-bake-toggle" data-tut="blend-bake-toggle" role="group" aria-label="Blend bake mode">
          <button
            class:active={appState.blendBakeMode === 'background'}
            onclick={(e) => handleBlendBakeModeClick(e, 'background')}
            title="Blend strokes bake against the room background"
          >
            BG
          </button>
          <button
            class:active={appState.blendBakeMode === 'existing'}
            onclick={(e) => handleBlendBakeModeClick(e, 'existing')}
            title="Blend strokes only affect existing pixels"
          >
            Existing
          </button>
        </div>
        {#each blendModes as mode}
          <button
            class="blend-option"
            class:active={appState.blendMode === mode.value}
            onclick={(e) => handleBlendModeClick(e, mode.value)}
          >
            {mode.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  {/if}

  <!-- Snapshot/History Button (Trusted+) -->
  {#if canOpenHistory}
  <div class="history-wrap">
    <button
      class="history-btn"
      data-tut="history"
      onclick={toggleSnapshotMenu}
      title="Board History / Snapshots"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 7H15C16.8692 7 17.8039 7 18.5 7.40193C18.9561 7.66523 19.3348 8.04394 19.5981 8.49999C20 9.19615 20 10.1308 20 12C20 13.8692 20 14.8038 19.5981 15.5C19.3348 15.9561 18.9561 16.3348 18.5 16.5981C17.8039 17 16.8692 17 15 17H8.00001M4 7L7 4M4 7L7 10" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>History</span>
    </button>
  </div>
  {/if}

  <!-- Image / pattern selection window (appears below History for tools that
       support image pickers: image brush, confetti, pattern, fill/select patterns) -->
  <ImageSelectorWindow />
</div>

<style>
  :global(#boardMenu) {
    position: absolute;
    inset: 0;
    z-index: 50;
    pointer-events: none;
  }

  .board-menu {
    position: absolute;
    top: 46px;
    right: 12px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    z-index: 1;
    pointer-events: all;
  }

  :global(html[data-sidebar-side='left']) .board-menu {
    left: 12px;
    right: auto;
    align-items: flex-start;
  }

  /* ── Blend mode ── */
  .blend-wrap {
    position: relative;
  }

  .blend-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--surface-glass) 78%, transparent);
    border: none;
    border-radius: 5px;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s ease, background 0.12s ease;
    white-space: nowrap;
    box-sizing: border-box;
  }
  .blend-btn:hover {
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
    color: var(--text-primary);
  }

  .blend-btn.open {
    background: color-mix(in srgb, var(--accent-primary) 15%, var(--bg-secondary));
    color: var(--accent-primary);
  }

  .blend-dropdown-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 3px 5px 8px;
    color: var(--text-primary);
    font-size: 0.78rem;
    font-weight: 600;
  }

  .blend-lock-btn {
    width: 22px;
    height: 22px;
    padding: 0;
    background: color-mix(in srgb, var(--text-primary) 6%, transparent);
    border: none;
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.58;
    transition: opacity 0.12s ease, background 0.12s ease, transform 0.12s ease;
  }

  .blend-lock-btn img {
    width: 12px;
    height: 12px;
    filter: invert(1);
    display: block;
  }

  .blend-lock-btn:hover,
  .blend-lock-btn.locked {
    background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
    opacity: 1;
  }

  .blend-lock-btn:active {
    transform: scale(0.96);
  }

  .blend-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 1;
    min-width: 130px;
    max-width: calc(100vw - 24px);
    background: color-mix(in srgb, var(--bg-secondary) 94%, transparent);
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
    backdrop-filter: blur(12px);
    box-shadow: var(--shadow-lg);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    animation: fadeDown 0.12s ease;
  }

  :global(html[data-sidebar-side='left']) .blend-dropdown {
    left: 0;
    right: auto;
  }

  @keyframes fadeDown {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .blend-option {
    padding: 6px 10px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s ease, color 0.1s ease;
  }

  .blend-option:hover {
    background: color-mix(in srgb, var(--text-primary) 7%, transparent);
    color: var(--text-primary);
  }

  .blend-option.active {
    color: var(--accent-primary);
    background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
  }

  .blend-bake-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    margin-bottom: 4px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .blend-bake-toggle button {
    height: 24px;
    padding: 0 6px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text-secondary);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }

  .blend-bake-toggle button:hover {
    background: color-mix(in srgb, var(--text-primary) 7%, transparent);
    color: var(--text-primary);
  }

  .blend-bake-toggle button.active {
    color: var(--accent-primary);
    background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
  }

  /* ── Layers ── */
  .layer-dropdown-wrap {
    display: none;
    position: relative;
  }

  .layer-dropdown-btn {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    height: 28px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--surface-glass) 78%, transparent);
    border: none;
    border-radius: 5px;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s ease, background 0.12s ease;
    white-space: nowrap;
    box-sizing: border-box;
  }

  .layer-dropdown-btn:hover {
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
    color: var(--text-primary);
  }

  .layer-dropdown-btn.open {
    background: color-mix(in srgb, var(--accent-primary) 15%, var(--bg-secondary));
    color: var(--accent-primary);
  }

  .layer-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 2;
    min-width: 112px;
    max-width: calc(100vw - 24px);
    background: color-mix(in srgb, var(--bg-secondary) 94%, transparent);
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
    backdrop-filter: blur(12px);
    box-shadow: var(--shadow-lg);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    animation: fadeDown 0.12s ease;
  }

  :global(html[data-sidebar-side='left']) .layer-dropdown {
    left: 0;
    right: auto;
  }

  .layer-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .layer-row {
    display: flex;
    align-items: center;
    gap: 0;
    background: color-mix(in srgb, var(--surface-glass) 78%, transparent);
    border-radius: 5px;
    overflow: hidden;
  }

  .eye-btn {
    width: 24px;
    height: 24px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    transition: color 0.1s ease;
    padding: 0;
    flex-shrink: 0;
  }

  .eye-btn:hover {
    color: var(--text-primary);
  }

  .eye-btn.faded {
    opacity: 0.3;
  }

  .layer-btn {
    padding: 3px 8px 3px 2px;
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: color 0.1s ease;
    white-space: nowrap;
  }

  .layer-btn:hover {
    color: var(--text-primary);
  }

  .layer-btn.active {
    color: var(--accent-primary);
  }

  @media (max-width: 700px), (hover: none) and (pointer: coarse) {
    .layer-dropdown-wrap {
      display: block;
    }

    .layer-list {
      display: none;
    }

    .layer-dropdown .layer-row {
      background: transparent;
    }

    .layer-dropdown .layer-btn {
      flex: 1;
      padding-right: 8px;
    }
  }

  /* ── History ── */
  .history-wrap {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    pointer-events: auto;
  }

  .history-btn {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    height: 24px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--surface-glass) 78%, transparent);
    border: none;
    border-radius: 5px;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s ease, background 0.12s ease;
    white-space: nowrap;
    box-sizing: border-box;
    touch-action: manipulation;
  }

  .history-btn:hover {
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
    color: var(--text-primary);
  }

</style>
