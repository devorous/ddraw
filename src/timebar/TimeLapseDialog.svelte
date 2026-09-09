<script>
  import { TimeMachine } from './TimeMachine.svelte.js';

  /**
   * @type {{
   *   open: boolean,
   *   onClose: () => void,
   *   initialRegion?: {x:number,y:number,width:number,height:number}|null,
   *   allowRegionPick?: boolean,
   * }}
   */
  let {
    open = $bindable(false),
    onClose,
    // When the dialog is opened over the embedded Recent mini-player, region
    // selection happens on that player's canvas (not #replayCanvas, which is
    // hidden). The caller hands us the already-picked region and disables the
    // dialog's own canvas-based picker.
    initialRegion = null,
    allowRegionPick = true,
  } = $props();

  let speed = $state(30);
  let fps = $state(30);
  let output = $state('video');
  // Off by default — renders are usually about the artwork, not the cursors.
  let renderCursors = $state(false);
  // Transparent background keeps the PNG frames' alpha channel. Only meaningful
  // for the Frames output — WebM/VP8 video can't store alpha.
  let transparentBackground = $state(false);
  let useRegion = $state(false);
  /** Board-pixel coords. Null = full board. */
  let region = $state(null);
  let pickingRegion = $state(false);

  // When the host owns region selection (embedded mode), mirror the region it
  // passes in each time the dialog opens.
  $effect(() => {
    if (open && !allowRegionPick) {
      region = initialRegion;
      useRegion = !!initialRegion;
    }
  });

  // Region picker — overlays the replay canvas and converts pointer-down/move/up
  // into board pixel coordinates. We measure #replayCanvas's on-screen rect and
  // scale pointer coords by replayCanvas.width / rect.width.
  let pickerOverlay = $state(null);
  let dragStart = null;
  let dragRect = $state(null);

  function getReplayCanvas() {
    return document.getElementById('replayCanvas');
  }

  function pointerToBoardCoords(clientX, clientY) {
    const c = getReplayCanvas();
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((clientX - rect.left) / rect.width) * c.width;
    const y = ((clientY - rect.top) / rect.height) * c.height;
    return { x, y };
  }

  function startPick() {
    pickingRegion = true;
    dragRect = null;
  }

  function cancelPick() {
    pickingRegion = false;
    dragStart = null;
    dragRect = null;
  }

  function handlePickerPointerDown(ev) {
    const p = pointerToBoardCoords(ev.clientX, ev.clientY);
    if (!p) return;
    ev.preventDefault();
    dragStart = { x: p.x, y: p.y, clientX: ev.clientX, clientY: ev.clientY };
    dragRect = { x: ev.clientX, y: ev.clientY, w: 0, h: 0 };
    pickerOverlay?.setPointerCapture?.(ev.pointerId);
  }

  function handlePickerPointerMove(ev) {
    if (!dragStart) return;
    const x = Math.min(dragStart.clientX, ev.clientX);
    const y = Math.min(dragStart.clientY, ev.clientY);
    const w = Math.abs(ev.clientX - dragStart.clientX);
    const h = Math.abs(ev.clientY - dragStart.clientY);
    dragRect = { x, y, w, h };
  }

  function handlePickerPointerUp(ev) {
    if (!dragStart) return;
    const start = dragStart;
    dragStart = null;
    const end = pointerToBoardCoords(ev.clientX, ev.clientY);
    if (!end) { dragRect = null; pickingRegion = false; return; }
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    if (width < 8 || height < 8) {
      dragRect = null;
      pickingRegion = false;
      return;
    }
    region = { x, y, width, height };
    useRegion = true;
    dragRect = null;
    pickingRegion = false;
  }

  function clearRegion() {
    region = null;
    useRegion = false;
  }

  // Estimated wall-clock time for video render = output video duration.
  // Renders walk the tape on the compressed activity clock (dead air
  // collapsed), so prefer that duration over the raw session span.
  let outputSecondsEstimate = $derived.by(() => {
    const session = Math.max(0, (TimeMachine.sessionEnd || 0) - (TimeMachine.sessionStart || 0));
    const compressed = TimeMachine.getRenderTapeDurationMs();
    const tape = compressed > 0 ? compressed : session;
    if (!tape || !speed) return 0;
    return (tape / 1000) / speed;
  });

  let frameEstimate = $derived.by(() => {
    const frames = Math.ceil(outputSecondsEstimate * fps);
    return Math.max(1, Number.isFinite(frames) ? frames : 1);
  });

  function formatSeconds(s) {
    if (!s || !Number.isFinite(s)) return '0s';
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return `${m}m ${r}s`;
  }

  async function startExport() {
    const opts = {
      speed,
      fps,
      output,
      region: useRegion ? region : null,
      renderCursors,
      transparentBackground: output === 'sequence' && transparentBackground,
    };
    // Don't await — let the dialog stay open so the progress bar updates.
    TimeMachine.exportTimeLapseVideo(opts);
  }

  function close() {
    if (pickingRegion) cancelPick();
    onClose?.();
  }

  // While picking a region, drop the replay-preview blur so the canvas is
  // crisp under the picker. The Timebar effect keys `body.replay-preview-mode`
  // off TimeMachine.isPreviewMode independently — we layer a sibling class
  // that the local CSS uses to disable the blur rule.
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('region-picking', !!pickingRegion);
    return () => document.body.classList.remove('region-picking');
  });

  // After a region is picked, show its outline on the replay canvas so the
  // user can see exactly what they're about to export. The outline is a
  // position:fixed box re-measured each frame from #replayCanvas's bounding
  // rect — pan/zoom on the replay surface keeps it anchored.
  let outlineEl = $state(null);
  let outlineRect = $state(null);

  $effect(() => {
    if (typeof window === 'undefined') return;
    // Hide outline while picking (the active drag-rect is the user feedback),
    // while the dialog is closed entirely, and when no region is set. In
    // host-owned region mode the embedded player draws its own outline.
    if (!open || pickingRegion || !useRegion || !region || !allowRegionPick) {
      outlineRect = null;
      return;
    }
    let rafId = 0;
    const sync = () => {
      const c = getReplayCanvas();
      if (c && region) {
        const cr = c.getBoundingClientRect();
        const sx = cr.width / c.width;
        const sy = cr.height / c.height;
        outlineRect = {
          left: cr.left + region.x * sx,
          top: cr.top + region.y * sy,
          width: region.width * sx,
          height: region.height * sy,
        };
      } else {
        outlineRect = null;
      }
      rafId = requestAnimationFrame(sync);
    };
    sync();
    return () => cancelAnimationFrame(rafId);
  });
</script>

{#if open && !pickingRegion}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="overlay" onclick={close} role="dialog" aria-modal="true" tabindex="-1">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div class="dialog" data-tut="render-dialog" onclick={(e) => e.stopPropagation()} role="document">
      <div class="header">
        <h3>Render time-lapse</h3>
        <button class="close-btn" onclick={close} title="Close">×</button>
      </div>

      <div class="body">
        <div class="row output-row">
          <span>Output</span>
          <div class="segmented">
            <button
              type="button"
              class:active={output === 'video'}
              onclick={() => (output = 'video')}
              disabled={TimeMachine.isExportingVideo}
            >Video</button>
            <button
              type="button"
              class:active={output === 'sequence'}
              onclick={() => (output = 'sequence')}
              disabled={TimeMachine.isExportingVideo}
            >Frames</button>
          </div>
        </div>

        <label class="row">
          <span>Speed</span>
          <input type="range" min="1" max="120" step="1" bind:value={speed} disabled={TimeMachine.isExportingVideo} />
          <span class="value">{speed}×</span>
        </label>

        <label class="row">
          <span>FPS</span>
          <select bind:value={fps} disabled={TimeMachine.isExportingVideo}>
            <option value={24}>24</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </label>

        <label class="row cursors-row">
          <span>Cursors</span>
          <span class="checkbox-wrap">
            <input type="checkbox" bind:checked={renderCursors} disabled={TimeMachine.isExportingVideo} />
            Render cursors
          </span>
        </label>

        <label class="row cursors-row">
          <span>Background</span>
          <span class="checkbox-wrap">
            <input
              type="checkbox"
              bind:checked={transparentBackground}
              disabled={TimeMachine.isExportingVideo || output !== 'sequence'}
            />
            Transparent
            {#if output !== 'sequence'}
              <span class="hint">(Frames only)</span>
            {/if}
          </span>
        </label>

        <div class="row region-row">
          <span>Region</span>
          <div class="region-controls">
            {#if allowRegionPick}
              {#if region}
                <span class="region-info">
                  {Math.round(region.width)} × {Math.round(region.height)} px
                </span>
                <button class="btn-small" onclick={startPick} disabled={TimeMachine.isExportingVideo}>Re-select</button>
                <button class="btn-small" onclick={clearRegion} disabled={TimeMachine.isExportingVideo}>Clear</button>
              {:else}
                <span class="region-info muted">Full board</span>
                <button class="btn-small" onclick={startPick} disabled={TimeMachine.isExportingVideo}>Select region…</button>
              {/if}
            {:else if region}
              <span class="region-info">
                {Math.round(region.width)} × {Math.round(region.height)} px
              </span>
            {:else}
              <span class="region-info muted">Full board</span>
            {/if}
          </div>
        </div>

        <div class="estimate">
          {#if output === 'sequence'}
            About {frameEstimate} PNG frames in a ZIP
          {:else}
            About {formatSeconds(outputSecondsEstimate)} of video
          {/if}
        </div>

        {#if TimeMachine.isExportingVideo}
          <div class="progress-wrap">
            <div class="progress-bar" style="width: {Math.round(TimeMachine.videoExportProgress * 100)}%"></div>
            <span class="progress-label">{Math.round(TimeMachine.videoExportProgress * 100)}%</span>
          </div>
        {/if}
      </div>

      <div class="footer">
        {#if TimeMachine.isExportingVideo}
          <button class="btn-secondary" onclick={() => TimeMachine.cancelVideoExport()}>Cancel</button>
        {:else}
          <button class="btn-secondary" onclick={close}>Close</button>
          <button class="btn-primary" onclick={startExport}>Render</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if pickingRegion}
  <div
    class="picker-overlay"
    bind:this={pickerOverlay}
    onpointerdown={handlePickerPointerDown}
    onpointermove={handlePickerPointerMove}
    onpointerup={handlePickerPointerUp}
    role="presentation"
  >
    <div class="picker-instructions">Drag a rectangle on the canvas — Esc to cancel</div>
    {#if dragRect}
      <div
        class="picker-rect"
        style="left: {dragRect.x}px; top: {dragRect.y}px; width: {dragRect.w}px; height: {dragRect.h}px"
      ></div>
    {/if}
  </div>
{/if}

{#if outlineRect}
  <div
    class="region-outline"
    bind:this={outlineEl}
    aria-hidden="true"
    style="left: {outlineRect.left}px; top: {outlineRect.top}px; width: {outlineRect.width}px; height: {outlineRect.height}px"
  >
    <span class="region-outline-tag">Render region</span>
  </div>
{/if}

<svelte:window onkeydown={(e) => {
  if (pickingRegion && e.key === 'Escape') cancelPick();
  else if (open && e.key === 'Escape' && !TimeMachine.isExportingVideo) close();
}} />

<style lang="scss">
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    /* Must beat #timebarMount (fixed stacking context at z 10000): the mini
       viewer / recorder are its children, and the dialog is portaled to <body>
       by ReplayControls — anything below 10000 renders under those modals. */
    z-index: 10010;
    backdrop-filter: blur(2px);
  }

  .dialog {
    background: #2a2f3a;
    color: #e6e9ef;
    border-radius: 12px;
    width: min(440px, 92vw);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    h3 { margin: 0; font-size: 16px; font-weight: 700; }
  }

  .close-btn {
    background: transparent;
    border: 0;
    color: inherit;
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 0 6px;
    &:hover { color: #fff; }
  }

  .body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .row {
    display: grid;
    grid-template-columns: 70px 1fr auto;
    align-items: center;
    gap: 10px;
    > span:first-child { font-size: 13px; opacity: 0.85; }
    .value { font-variant-numeric: tabular-nums; font-size: 13px; min-width: 40px; text-align: right; }
    input[type="range"] { width: 100%; }
    select {
      background: #1f242e;
      color: inherit;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 4px 8px;
    }
  }

  .region-row {
    grid-template-columns: 70px 1fr;
  }

  .cursors-row {
    grid-template-columns: 70px 1fr;
    cursor: pointer;
  }

  .checkbox-wrap {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    input[type="checkbox"] { accent-color: #4a90e2; margin: 0; }
    input[type="checkbox"]:disabled { opacity: 0.5; cursor: not-allowed; }
    .hint { opacity: 0.55; font-size: 11px; }
  }

  .output-row {
    grid-template-columns: 70px 1fr;
  }

  .segmented {
    display: inline-flex;
    width: fit-content;
    padding: 3px;
    gap: 2px;
    background: #1f242e;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    button {
      background: transparent;
      color: inherit;
      border: 0;
      border-radius: 5px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      opacity: 0.72;
      &:hover:not(:disabled) { background: #2d3340; opacity: 1; }
      &.active { background: #4a90e2; color: #fff; opacity: 1; }
      &:disabled { opacity: 0.5; cursor: not-allowed; }
    }
  }

  .region-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .region-info {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    &.muted { opacity: 0.65; }
  }

  .btn-small {
    background: #1f242e;
    color: inherit;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
    &:hover:not(:disabled) { background: #2d3340; }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
  }

  .estimate {
    font-size: 12px;
    opacity: 0.7;
  }

  .progress-wrap {
    position: relative;
    height: 22px;
    background: #1f242e;
    border-radius: 6px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #4a90e2, #6fa8f0);
    transition: width 120ms ease-out;
  }

  .progress-label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 18px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.15);
  }

  .btn-primary, .btn-secondary {
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn-primary {
    background: #4a90e2;
    color: #fff;
    &:hover { background: #5aa0f0; }
  }

  .btn-secondary {
    background: transparent;
    color: inherit;
    border-color: rgba(255, 255, 255, 0.18);
    &:hover { background: rgba(255, 255, 255, 0.08); }
  }

  .picker-overlay {
    position: fixed;
    inset: 0;
    z-index: 10011;
    cursor: crosshair;
    background: rgba(0, 0, 0, 0.2);
    user-select: none;
  }

  /* Counteract the replay-preview blur (Timebar.svelte) and loading overlay
     while picking, so the user sees the canvas crisp under the picker. */
  :global(body.region-picking #replayCanvas) {
    filter: none !important;
  }
  :global(body.region-picking .replay-preview-overlay) {
    display: none !important;
  }

  .picker-instructions {
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.8);
    color: #fff;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    pointer-events: none;
  }

  .picker-rect {
    position: fixed;
    border: 2px dashed #fff;
    background: rgba(74, 144, 226, 0.15);
    pointer-events: none;
  }

  /* Persistent outline shown after the user has picked a region. Lives above
     the host modals (#timebarMount context at z 10000) but below the dialog
     (10010), so the dialog stays in front when re-opened while the outline
     shows through whenever the dialog is closed for adjustment or re-select. */
  .region-outline {
    position: fixed;
    z-index: 10009;
    pointer-events: none;
    border: 2px dashed #4a90e2;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(0, 0, 0, 0.55);
    border-radius: 2px;
    background: transparent;
  }
  .region-outline-tag {
    position: absolute;
    top: -22px;
    left: -2px;
    background: #4a90e2;
    color: #fff;
    font: 600 11px system-ui, sans-serif;
    padding: 2px 6px;
    border-radius: 4px 4px 0 0;
    white-space: nowrap;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }

  /* While the mobile tutorial toast is showing (see TutorialOverlay.svelte),
     shrink this dialog's own space so it renders below the toast instead of
     under it. */
  @media (max-width: 640px), (max-height: 640px) {
    :global(html[data-tutorial-active='true']) .overlay {
      align-items: flex-start;
      padding-top: calc(var(--tutorial-toast-bottom, 0px) + 8px);
    }

    :global(html[data-tutorial-active='true']) .dialog {
      max-height: calc(100vh - var(--tutorial-toast-bottom, 0px) - 16px);
      overflow-y: auto;
    }
  }
</style>
