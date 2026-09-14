<script>
  import { untrack } from 'svelte';
  import { playGenieOut, playGenieIn } from './geniePanelAnimation.js';

  let {
    panelId = 'dockablePanel',
    panelClass = 'dockablePanel',
    contentId = 'dockablePanelContent',
    contentClass = 'dockablePanelContent',
    visibilitySource = null,
    visibleKey = 'visible',
    forceVisibleKey = 'forceVisible',
    compactQuery = '(max-width: 768px), (max-height: 650px)',
    ariaLabel = 'Dockable panel',
    hideLabel = 'Minimize panel',
    moveLabel = 'Move panel',
    resizeLabel = 'Resize panel',
    minSize = 96,
    maxSize = 236,
    defaultSize = 116,
    margin = 1,
    // CSS selector for the button that reopens this panel - used to aim the
    // genie minimize/restore animation. No animation plays if omitted.
    genieTargetSelector = null
  } = $props();

  let panel = $state(null);
  let left = $state(null);
  let top = $state(null);
  let size = $state(116);
  let isCompactViewport = $state(false);
  let userPositioned = $state(false);

  let visible = $derived.by(() => {
    if (!visibilitySource) {
      return true;
    }

    if (!visibilitySource[visibleKey]) {
      return false;
    }

    return !!visibilitySource[forceVisibleKey] || isCompactViewport;
  });

  $effect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia(compactQuery);
    const updateViewportState = () => {
      isCompactViewport = mediaQuery.matches;
    };

    updateViewportState();
    mediaQuery.addEventListener?.('change', updateViewportState);
    mediaQuery.addListener?.(updateViewportState);

    return () => {
      mediaQuery.removeEventListener?.('change', updateViewportState);
      mediaQuery.removeListener?.(updateViewportState);
    };
  });

  function clampValue(value, minValue, maxValue) {
    return Math.max(minValue, Math.min(value, maxValue));
  }

  $effect(() => {
    size = clampValue(defaultSize, minSize, maxSize);
  });

  function getPanelLayout(nextSize = size) {
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : nextSize + margin * 2;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : nextSize + margin * 2;
    const sideMenu = document?.getElementById?.('sideMenu');
    const topBar = document?.querySelector?.('.boardBtns');
    const sidebarRect = sideMenu?.getBoundingClientRect?.();
    const topBarRect = topBar?.getBoundingClientRect?.();
    const sidebarSide = document?.documentElement?.dataset?.sidebarSide === 'left' ? 'left' : 'right';

    let safeLeft = margin;
    let safeRight = viewportWidth - margin;
    const safeTop = Math.max(margin, topBarRect ? topBarRect.bottom + margin : margin);
    const safeBottom = viewportHeight - margin;

    if (sidebarRect) {
      if (sidebarSide === 'left') {
        safeLeft = Math.max(safeLeft, sidebarRect.right + margin);
      } else {
        safeRight = Math.min(safeRight, sidebarRect.left - margin);
      }
    }

    const availableWidth = Math.max(0, safeRight - safeLeft);
    const availableHeight = Math.max(0, safeBottom - safeTop);
    const maxAllowedSize = Math.max(
      minSize,
      Math.min(maxSize, Math.min(availableWidth || maxSize, availableHeight || maxSize))
    );
    const resolvedSize = clampValue(nextSize, minSize, maxAllowedSize);
    const maxLeft = Math.max(safeLeft, safeRight - resolvedSize);
    const maxTop = Math.max(safeTop, safeBottom - resolvedSize);

    return {
      safeLeft,
      safeRight,
      safeTop,
      safeBottom,
      size: resolvedSize,
      maxLeft,
      maxTop,
      dockLeft: Math.max(safeLeft, safeRight - resolvedSize),
      dockTop: Math.max(safeTop, safeBottom - resolvedSize)
    };
  }

  function syncPanelPosition(forceDock = false) {
    const bounds = getPanelLayout(size);
    size = bounds.size;

    if (forceDock || !userPositioned || left == null || top == null) {
      left = bounds.dockLeft;
      top = bounds.dockTop;
      return;
    }

    left = clampValue(left, bounds.safeLeft, bounds.maxLeft);
    top = clampValue(top, bounds.safeTop, bounds.maxTop);
  }

  function clampPanelPosition(nextLeft, nextTop, nextSize = size) {
    const bounds = getPanelLayout(nextSize);
    return {
      left: clampValue(nextLeft, bounds.safeLeft, bounds.maxLeft),
      top: clampValue(nextTop, bounds.safeTop, bounds.maxTop)
    };
  }

  function startDrag(event) {
    if (!visible || !panel) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const panelRect = panel.getBoundingClientRect();
    const startLeft = left ?? panelRect.left;
    const startTop = top ?? panelRect.top;
    const startX = event.clientX;
    const startY = event.clientY;

    const handleMove = (moveEvent) => {
      const next = clampPanelPosition(
        startLeft + moveEvent.clientX - startX,
        startTop + moveEvent.clientY - startY
      );

      left = next.left;
      top = next.top;
      userPositioned = true;
    };

    const handleUp = () => {
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

    const panelRect = panel.getBoundingClientRect();
    const startSize = Math.max(minSize, size || panel.offsetWidth);
    const fixedRight = panelRect.left + startSize;
    const fixedBottom = panelRect.top + startSize;
    const startX = event.clientX;
    const startY = event.clientY;

    const handleMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const bounds = getPanelLayout(startSize);
      const maxAllowedSize = Math.max(
        minSize,
        Math.min(maxSize, Math.min(fixedRight - bounds.safeLeft, fixedBottom - bounds.safeTop))
      );
      const nextSize = clampValue(startSize - ((deltaX + deltaY) / 2), minSize, maxAllowedSize);

      size = nextSize;
      left = fixedRight - nextSize;
      top = fixedBottom - nextSize;
      userPositioned = true;
    };

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }

  function getGenieTarget() {
    return genieTargetSelector ? document.querySelector(genieTargetSelector) : null;
  }

  function hidePanel() {
    if (!visibilitySource) return;
    const applyHide = () => {
      visibilitySource[visibleKey] = false;
      visibilitySource[forceVisibleKey] = false;
    };
    playGenieOut(panel, getGenieTarget(), applyHide);
  }

  let wasVisible = untrack(() => visible);
  $effect(() => {
    if (visible && !wasVisible) {
      playGenieIn(panel, getGenieTarget());
    }
    wasVisible = visible;
  });

  $effect(() => {
    if (typeof window === 'undefined' || !visible || !panel) {
      return;
    }

    const sync = () => syncPanelPosition(!userPositioned);
    sync();

    window.addEventListener('resize', sync);
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    resizeObserver?.observe?.(document.getElementById('sideMenu'));
    resizeObserver?.observe?.(document.querySelector('.boardBtns'));

    return () => {
      window.removeEventListener('resize', sync);
      resizeObserver?.disconnect?.();
    };
  });

  function panelStyle() {
    const bounds = getPanelLayout(size);
    const resolvedLeft = left != null ? clampValue(left, bounds.safeLeft, bounds.maxLeft) : bounds.dockLeft;
    const resolvedTop = top != null ? clampValue(top, bounds.safeTop, bounds.maxTop) : bounds.dockTop;
    const resolvedSize = clampValue(size, minSize, maxSize);

    return [
      `width: ${resolvedSize}px`,
      `height: ${resolvedSize}px`,
      `min-width: ${minSize}px`,
      `min-height: ${minSize}px`,
      `display: ${visible ? 'block' : 'none'}`,
      `left: ${resolvedLeft}px`,
      `top: ${resolvedTop}px`,
      'right: auto',
      'bottom: auto'
    ].join('; ');
  }
</script>

<div
  bind:this={panel}
  id={panelId}
  class={panelClass}
  aria-label={ariaLabel}
  aria-hidden={!visible}
  role="presentation"
  style={panelStyle()}
>
  <button
    type="button"
    class="dockablePanelHideButton"
    title={hideLabel}
    aria-label={hideLabel}
    onclick={hidePanel}
    onpointerdown={(event) => event.stopPropagation()}
  >
    <!-- A minus, not an X/chevron: this minimizes the panel toward its
         reopen button rather than closing or collapsing it in place. -->
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" />
    </svg>
  </button>

  <button
    type="button"
    class="dockablePanelResizeHandle"
    title={resizeLabel}
    aria-label={resizeLabel}
    onclick={(event) => event.preventDefault()}
    onpointerdown={startResize}
  ></button>

  <button
    type="button"
    class="dockablePanelDragHandle"
    title={moveLabel}
    aria-label={moveLabel}
    onpointerdown={startDrag}
  ></button>

  <div id={contentId} class={contentClass}></div>
</div>

<style>
  .dockablePanelHideButton {
    position: absolute;
    top: 1px;
    right: 1px;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: color-mix(in srgb, var(--bg-secondary) 94%, black);
    color: color-mix(in srgb, var(--text-secondary) 78%, transparent);
    cursor: pointer;
    box-shadow: 0 1px 4px color-mix(in srgb, black 28%, transparent);
    z-index: 5;
    display: grid;
    place-items: center;
    transition: transform var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
  }

  .dockablePanelHideButton:hover {
    transform: translateY(-1px);
    color: var(--text-primary);
    background: color-mix(in srgb, var(--bg-secondary) 88%, black);
  }

  .dockablePanelHideButton:active {
    transform: translateY(0);
  }
</style>