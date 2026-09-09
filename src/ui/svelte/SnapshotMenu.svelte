<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { appState, clearSnapshotHistoryState, toggleSnapshotMenu } from '../../state.svelte.js';
  import { T } from '../../../shared/MessageTypes.js';
  import * as wasm from '../../wasm/ddraw_wasm.js';
  import { TimeMachine } from '../../timebar/TimeMachine.svelte.js';
  import ReplayControls from '../../timebar/ReplayControls.svelte';

  let snapshots = $derived(appState.snapshots || []);
  let snapshotHasMore = $derived(appState.snapshotHasMore);
  let snapshotListVersion = $derived(appState.snapshotListVersion);
  let hasLoadedOlderSnapshots = $derived(snapshots.length > 20);
  let isSoloOccupant = $derived(appState.userCount <= 1);
  let canViewHistory = $derived(appState.selfRole >= 1 || isSoloOccupant);
  let canRestoreHistory = $derived(appState.selfRole >= 2);
  let canRestoreBoard = $derived(appState.selfRole >= 2);

  // ── History view tabs ──────────────────────────────────────────────────────
  // Recent  = local rolling DVR tape (this client's last ~2 minutes), no server.
  // Server  = longer-range room history reconstructed from server checkpoints.
  // Snapshots = saved still images for restore / region restore.
  let view = $state('recent'); // 'recent' | 'snapshots' (server replay removed)
  let snapshotsLoadedOnce = false;

  // Rolling-tape status, polled while the Recent tab is visible.
  let recentStatus = $state(null);
  let recentStatusTimer = null;

  function refreshRecentStatus() {
    recentStatus = window.app?.rollingTapeRecorder?.getStatus?.() ?? null;
  }

  function startRecentStatusPolling() {
    refreshRecentStatus();
    if (recentStatusTimer) return;
    recentStatusTimer = window.setInterval(refreshRecentStatus, 1000);
  }

  function stopRecentStatusPolling() {
    if (recentStatusTimer) {
      clearInterval(recentStatusTimer);
      recentStatusTimer = null;
    }
  }

  // ── Embedded Recent player ──────────────────────────────────────────────────
  // The Recent tape plays inside this modal: TimeMachine paints into embedCanvas
  // (embedded mode) instead of taking over the whole board.
  let embedCanvas = $state(null);
  let embedActive = $state(false);   // a tape is loaded into the in-panel player
  let embedStarting = false;         // guards against re-entrant auto-start
  let lastBundle = null;             // the frozen tape currently in the player
  let handoffToFull = false;         // true while handing the tape to the OG full-board replay

  let tmLoading = $derived(TimeMachine.isLoading);
  // True while the player is showing a low-res cached frame and crisp output is
  // still catching up in the background — surfaced as a subtle corner spinner.
  let tmPreview = $derived(TimeMachine.isPreviewMode);

  function switchView(next) {
    if (view === next) return;
    if (view === 'recent') stopEmbeddedRecent();
    view = next;
    if (next === 'recent') {
      startRecentStatusPolling();
      maybeStartEmbeddedRecent();
    } else {
      stopRecentStatusPolling();
    }
    // Lazily fetch the server snapshot list the first time the user opens the
    // Snapshots tab — Recent is local-only and Server uses its own request.
    if (next === 'snapshots' && !snapshotsLoadedOnce && canViewHistory) {
      snapshotsLoadedOnce = true;
      refresh();
    }
  }

  /** Freeze the rolling tape into the in-panel player. */
  async function startEmbeddedRecent() {
    if (embedActive || embedStarting) return;
    const rec = window.app?.rollingTapeRecorder;
    const bundle = rec?.snapshotRecording?.();
    if (!bundle || !bundle.deltas || bundle.deltas.length === 0) return;
    lastBundle = bundle;

    embedStarting = true;
    embedActive = true;
    resetRpView();
    try {
      await tick(); // ensure embedCanvas is bound in the DOM
      if (!embedCanvas) { embedActive = false; return; }
      TimeMachine.attachEmbedTarget(embedCanvas);
      await TimeMachine.loadFromRecording(bundle);
    } catch (err) {
      console.error('[SnapshotMenu] embedded recent replay failed:', err);
      embedActive = false;
      TimeMachine.detachEmbedTarget?.();
      window.app?.ui?.showToast?.('Could not load recent replay', 3000, 'error');
    } finally {
      embedStarting = false;
    }
  }

  /** Auto-start the player when Recent has content and isn't already running. */
  function maybeStartEmbeddedRecent() {
    if (view !== 'recent' || embedActive || embedStarting) return;
    // NOTE: don't gate on embedCanvas here — the <canvas> only mounts once
    // embedActive flips true (inside startEmbeddedRecent, which awaits tick
    // before using it). Requiring it up front deadlocks: canvas needs active,
    // active needs this function, this function needed canvas.
    if (recentStatus?.hasContent) startEmbeddedRecent();
  }

  /** Tear down the in-panel player (tab switch / close). */
  function stopEmbeddedRecent() {
    // When handing the tape off to the full-board replay, that replay now owns
    // TimeMachine — don't stop it out from under the handoff.
    resetRpView();
    if (handoffToFull) { embedActive = false; return; }
    if (!embedActive && !embedStarting) return;
    embedActive = false;
    try { TimeMachine.stop(); } catch {}
    TimeMachine.detachEmbedTarget?.();
  }

  // ── Pan / zoom on the mini canvas ───────────────────────────────────────────
  // The player canvas is object-fit:contain (fit-to-stage) at zoom 1. Wheel
  // zooms toward the cursor, drag pans. Layered on top of object-fit via a CSS
  // transform, so zoom 1 + no pan reproduces the plain fitted view.
  let rpZoom = $state(1);
  let rpPanX = $state(0);
  let rpPanY = $state(0);
  let rpPanning = $state(false);
  let rpPanStart = null;

  let rpCanvasTransform = $derived(`translate(${rpPanX}px, ${rpPanY}px) scale(${rpZoom})`);

  function resetRpView() {
    rpZoom = 1;
    rpPanX = 0;
    rpPanY = 0;
  }

  function onRpWheel(e) {
    if (!embedCanvas) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(1, Math.min(8, rpZoom * factor));
    if (next === rpZoom) return;
    const ratio = next / rpZoom;
    // Keep the board point under the cursor fixed: shift pan by the cursor's
    // offset from the displayed canvas center, scaled by (1 - ratio).
    const rect = embedCanvas.getBoundingClientRect();
    if (rect.width && rect.height) {
      const fx = (e.clientX - rect.left) / rect.width - 0.5;
      const fy = (e.clientY - rect.top) / rect.height - 0.5;
      rpPanX += fx * rect.width * (1 - ratio);
      rpPanY += fy * rect.height * (1 - ratio);
    }
    rpZoom = next;
    if (rpZoom === 1) { rpPanX = 0; rpPanY = 0; }
  }

  function onRpPointerDown(e) {
    if (e.button !== 0) return;
    rpPanning = true;
    rpPanStart = { x: e.clientX - rpPanX, y: e.clientY - rpPanY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onRpPointerMove(e) {
    if (!rpPanning || !rpPanStart) return;
    rpPanX = e.clientX - rpPanStart.x;
    rpPanY = e.clientY - rpPanStart.y;
  }

  function onRpPointerUp(e) {
    if (!rpPanning) return;
    rpPanning = false;
    rpPanStart = null;
    e.currentTarget?.releasePointerCapture?.(e.pointerId);
  }

  /** Hand the current recent tape off to the original full-board replay UI. */
  async function openFullscreenReplay() {
    const bundle = lastBundle ?? window.app?.rollingTapeRecorder?.snapshotRecording?.();
    if (!bundle || !bundle.deltas?.length) return;
    handoffToFull = true;
    embedActive = false;
    try { TimeMachine.stop(); } catch {}     // end the embedded session + detach embed
    close();                                 // hide the History modal
    try {
      await window.app?.TimeMachine?.loadFromRecording?.(bundle);  // OG full-board replay + Timebar
    } catch (err) {
      console.error('[SnapshotMenu] fullscreen replay handoff failed:', err);
      window.app?.ui?.showToast?.('Could not open replay', 3000, 'error');
    }
  }

  // Re-attempt auto-start once status polling reports content (e.g. the user
  // opened History a beat after joining, before any deltas accumulated).
  $effect(() => {
    if (view === 'recent' && recentStatus?.hasContent) {
      maybeStartEmbeddedRecent();
    }
  });

  function formatWindow(ms) {
    const s = Math.round((ms || 0) / 1000);
    if (s < 90) return `${s}s`;
    return `${Math.round(s / 60)} min`;
  }

  let recentHasContent = $derived(!!recentStatus?.hasContent);
  let recentEnabled = $derived(!!recentStatus?.enabled);
  let recentConfigured = $derived(recentStatus?.configuredEnabled !== false);
  let recentStale = $derived(!!recentStatus?.stale);

  let selectedId = $state(null);
  let selectedLayers = $state(null);
  let isLoadingPreview = $state(false);
  let isLoadingSnapshots = $state(false);
  let isLoadingMore = $state(false);
  let previewError = $state('');
  let lastHandledSnapshotListVersion = $state(0);
  let showBackToPresent = $state(false);
  let previewRequestTimeout = null;
  let listRequestTimeout = null;
  let listError = $state('');

  // Selection tool
  let mode = $state('rectangle'); // 'rectangle' | 'lasso'
  let activeTool = $state('select'); // 'select' | 'pan'
  let selection = $state(null);
  let lassoPoints = $state([]);
  let isSelecting = false;
  let startPos = null;

  // Pan/zoom
  let viewZoom = $state(0.5);
  let viewPanX = $state(0);
  let viewPanY = $state(0);
  let isPanning = $state(false);
  let lastPanPos = { x: 0, y: 0 };

  // Marching ants
  let marchingAntsOffset = $state(0);
  let animId = null;

  // Snap strip dragging
  let stripRef = $state(null);
  let isDraggingStrip = $state(false);
  let stripStartX = 0;
  let stripScrollLeft = 0;
  let stripMoved = $state(false);

  // Canvas refs
  let previewCanvas = $state(null);
  let selectionCanvas = $state(null);
  let previewWrap = $state(null);
  let snapshotExportCanvas = null;

  // Thumb URL cache (non-reactive Map — we mutate it freely)
  const thumbUrls = new Map();

  // Derived map: snapshot id -> blob URL. Re-computed when snapshots change.
  // Builds URLs eagerly outside of template expressions.
  let thumbUrlMap = $derived.by(() => {
    const map = new Map();
    for (const snap of snapshots) {
      let url = thumbUrls.get(snap.id);
      if (!url && snap.thumb && snap.thumb.length > 0) {
        const blob = new Blob([snap.thumb], { type: 'image/jpeg' });
        url = URL.createObjectURL(blob);
        thumbUrls.set(snap.id, url);
      }
      if (url) map.set(snap.id, url);
    }
    return map;
  });

  let canvasTransform = $derived(`translate(${viewPanX}px, ${viewPanY}px) scale(${viewZoom})`);
  let zoomLabel = $derived(`${Math.round(viewZoom * 100)}%`);

  function onStripPointerDown(e) {
    if (e.button !== 0) return;
    isDraggingStrip = true;
    stripStartX = e.pageX - stripRef.offsetLeft;
    stripScrollLeft = stripRef.scrollLeft;
    stripMoved = false;
  }

  function onStripPointerMove(e) {
    if (!isDraggingStrip) return;
    const x = e.pageX - stripRef.offsetLeft;
    const walk = (x - stripStartX);
    if (!stripMoved && Math.abs(walk) > 5) {
      stripMoved = true;
      stripRef.setPointerCapture(e.pointerId);
    }
    if (stripMoved) {
      stripRef.scrollLeft = stripScrollLeft - walk;
    }
  }

  function onStripPointerUp() {
    isDraggingStrip = false;
  }

  function handleSnapshotKeydown(event, snapshotId) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!stripMoved) selectSnapshot(snapshotId);
    }
  }

  function onStripScroll() {
    showBackToPresent = !!stripRef && hasLoadedOlderSnapshots && stripRef.scrollLeft > 40;
    if (!stripRef || isLoadingSnapshots || isLoadingMore || !snapshotHasMore) return;
    const threshold = 160;
    const remaining = stripRef.scrollWidth - (stripRef.scrollLeft + stripRef.clientWidth);
    if (remaining <= threshold) {
      loadMoreSnapshots();
    }
  }

  function scrollToPresent() {
    if (!stripRef) return;
    stripRef.scrollTo({ left: 0, behavior: 'smooth' });
    showBackToPresent = false;
  }

  function close() { toggleSnapshotMenu(); }

  async function refresh() {
    isLoadingSnapshots = true;
    isLoadingMore = false;
    showBackToPresent = false;
    listError = '';

    if (listRequestTimeout) {
      clearTimeout(listRequestTimeout);
      listRequestTimeout = null;
    }

    window.app?.snapshotManager?.requestList();
    listRequestTimeout = window.setTimeout(() => {
      listRequestTimeout = null;
      if (isLoadingSnapshots) {
        isLoadingSnapshots = false;
        listError = 'Failed to load snapshots. Check your connection and try again.';
      }
    }, 15000);
  }

  function formatDate(ts) {
    const d = new Date(Number(ts));
    return d.toLocaleDateString() === new Date().toLocaleDateString()
      ? d.toLocaleTimeString()
      : d.toLocaleString();
  }

  async function loadMoreSnapshots() {
    if (isLoadingSnapshots || isLoadingMore || !snapshotHasMore || snapshots.length === 0) return;
    const oldest = snapshots[snapshots.length - 1];
    if (!oldest?.ts) return;

    isLoadingMore = true;
    window.app?.snapshotManager?.requestList({ beforeTs: Number(oldest.ts), append: true });
  }


  function resetView() {
    if (!previewWrap || !previewCanvas) { viewZoom = 0.5; viewPanX = 0; viewPanY = 0; return; }
    const ww = previewWrap.clientWidth;
    const wh = previewWrap.clientHeight;
    const bw = previewCanvas.width;
    const bh = previewCanvas.height;
    if (!bw || !bh) { viewZoom = 0.5; viewPanX = 0; viewPanY = 0; return; }
    viewZoom = Math.min(ww / bw, wh / bh, 1);
    viewPanX = (ww - bw * viewZoom) / 2;
    viewPanY = (wh - bh * viewZoom) / 2;
  }

  async function selectSnapshot(id) {
    if (id === selectedId) return;
    window.app.snapshotPreviewCanvas = null;
    snapshotExportCanvas = null;
    selectedId = id;
    selectedLayers = null;
    selection = null;
    lassoPoints = [];
    previewError = '';
    isLoadingPreview = true;

    if (previewRequestTimeout) {
      clearTimeout(previewRequestTimeout);
      previewRequestTimeout = null;
    }

    window.app.wsClient.on('board_snapshot_get_response', async (data) => {
      if (data.snapshotId !== selectedId) return;
      window.app.wsClient.messageHandlers.delete('board_snapshot_get_response');
      if (previewRequestTimeout) {
        clearTimeout(previewRequestTimeout);
        previewRequestTimeout = null;
      }
      selectedLayers = data.snapshotLayers;
      isLoadingPreview = false;
      await tick();
      renderPreview(data.snapshotLayers);
      resetView();
    });
    window.app.wsClient.requestSnapshotGet(id);
    previewRequestTimeout = window.setTimeout(() => {
      previewRequestTimeout = null;
      if (selectedId !== id || !isLoadingPreview) return;
      window.app?.wsClient?.messageHandlers?.delete('board_snapshot_get_response');
      isLoadingPreview = false;
      previewError = 'Preview could not load. Check snapshot storage settings on the server.';
    }, 8000);
  }

  function renderPreview(layerDatas) {
    if (!previewCanvas) return;

    const [h, w] = window.app.board.dimensions;
    previewCanvas.width = w;
    previewCanvas.height = h;
    selectionCanvas.width = w;
    selectionCanvas.height = h;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = w;
    exportCanvas.height = h;
    const exportCtx = exportCanvas.getContext('2d');
    exportCtx.clearRect(0, 0, w, h);

    if (!layerDatas || layerDatas.length === 0) {
      snapshotExportCanvas = exportCanvas;
      const ctx = previewCanvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      return;
    }

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tmpCtx = tmp.getContext('2d');

    for (const qoi of layerDatas) {
      if (!qoi || qoi.length === 0) continue;
      try {
        const pixels = wasm.qoi_decode(qoi);
        if (!pixels || pixels.length === 0) continue;
        tmpCtx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), w, h), 0, 0);
        exportCtx.drawImage(tmp, 0, 0);
      } catch (e) {
        console.warn('[SnapshotMenu] QOI decode error', e);
      }
    }

    snapshotExportCanvas = exportCanvas;

    const ctx = previewCanvas.getContext('2d');
    const bg = window.app.board.backgroundColor || '#ffffff';
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = typeof bg === 'string' ? bg : `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(exportCanvas, 0, 0);

    window.app.snapshotPreviewCanvas = exportCanvas;
  }

  function openSnapshotSaveDialog() {
    if (!selectedId || !snapshotExportCanvas) return;
    window.app?.openSaveDialogForCanvas?.(snapshotExportCanvas);
  }

  async function doRestore() {
    if (!selectedId) return;
    const hasSel = hasSelection;

    // No selection → Restore Board (full replace) with confirmation
    if (!hasSel) {
      if (!canRestoreBoard) {
        window.app?.ui?.showToast?.('Restore Board requires Trusted rank or higher', 3500, 'error');
        return;
      }
      if (!await window.showAppConfirm('Replace entire board?', {
        title: 'Restore board?',
        confirmLabel: 'Replace',
        danger: true
      })) return;
      window.app.snapshotManager.restoreSnapshot(selectedId);
      close();
      return;
    }

    // Lasso region: use existing server-side region restore.
    if (mode === 'lasso') {
      applyRegionRestore();
      close();
      return;
    }

    // Rectangle region: upload as a floating multi-layer selection.
    if (!selectedLayers || selectedLayers.length === 0) {
      alert('Snapshot data is still loading. Please wait and try again.');
      return;
    }

    await window.app.uploadSnapshotLayersAsSelection(selectedLayers, selection);
    close();
  }

  function applyRegionRestore() {
    const isLasso = mode === 'lasso';
    const msg = {
      t: T.BOARD_SNAPSHOT_REGION_RESTORE,
      snapshotId: selectedId,
      a: isLasso
    };
    if (isLasso) {
      msg.cr = lassoPoints.flatMap(p => [p.x, p.y]);
    } else {
      msg.sx = Math.round(selection.x);
      msg.sy = Math.round(selection.y);
      msg.sw = Math.round(selection.width);
      msg.sh = Math.round(selection.height);
    }
    window.app.wsClient.send(msg);
  }

  async function doDelete() {
    if (!selectedId) return;
    if (!await window.showAppConfirm('Are you sure you want to delete this snapshot?', {
      title: 'Delete snapshot?',
      confirmLabel: 'Delete',
      danger: true
    })) return;
    window.app.snapshotManager.deleteSnapshot(selectedId);
    appState.snapshots = snapshots.filter(s => s.id !== selectedId);
    appState.snapshotListVersion += 1;
    selectedId = null;
    selectedLayers = null;
    if (window.app.snapshotPreviewCanvas === snapshotExportCanvas) {
      window.app.snapshotPreviewCanvas = null;
    }
    snapshotExportCanvas = null;
  }

  function clearSelection() { selection = null; lassoPoints = []; }

  function canvasPos(e) {
    const rect = selectionCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / viewZoom,
      y: (e.clientY - rect.top) / viewZoom
    };
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    selectionCanvas.setPointerCapture(e.pointerId);

    if (activeTool === 'pan') {
      isPanning = true;
      lastPanPos = { x: e.clientX, y: e.clientY };
      return;
    }

    isSelecting = true;
    startPos = canvasPos(e);
    if (mode === 'rectangle') {
      selection = { x: startPos.x, y: startPos.y, width: 0, height: 0 };
    } else {
      lassoPoints = [startPos];
    }
  }

  function onPointerMove(e) {
    if (isPanning) {
      viewPanX += e.clientX - lastPanPos.x;
      viewPanY += e.clientY - lastPanPos.y;
      lastPanPos = { x: e.clientX, y: e.clientY };
      return;
    }

    if (!isSelecting) return;
    const pos = canvasPos(e);
    if (mode === 'rectangle' && startPos) {
      selection = {
        x: Math.min(pos.x, startPos.x),
        y: Math.min(pos.y, startPos.y),
        width: Math.abs(pos.x - startPos.x),
        height: Math.abs(pos.y - startPos.y)
      };
    } else if (mode === 'lasso') {
      lassoPoints = [...lassoPoints, pos];
    }
  }

  function onPointerUp() {
    if (isPanning) { isPanning = false; return; }
    isSelecting = false;
    if (mode === 'rectangle' && selection && (selection.width < 4 || selection.height < 4)) selection = null;
    if (mode === 'lasso' && lassoPoints.length < 4) lassoPoints = [];
  }

  function onWheel(e) {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    const next = Math.max(0.1, Math.min(4, Math.round((viewZoom + step) * 10) / 10));
    if (next === viewZoom) return;

    const wrapRect = previewWrap.getBoundingClientRect();
    const px = e.clientX - wrapRect.left;
    const py = e.clientY - wrapRect.top;
    const canvasX = (px - viewPanX) / viewZoom;
    const canvasY = (py - viewPanY) / viewZoom;
    viewPanX = px - canvasX * next;
    viewPanY = py - canvasY * next;
    viewZoom = next;
  }

  function drawSelection() {
    if (!selectionCanvas || !selectionCanvas.width) return;
    const ctx = selectionCanvas.getContext('2d');
    const w = selectionCanvas.width;
    const h = selectionCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const hasRect = mode === 'rectangle' && selection && selection.width > 0 && selection.height > 0;
    const hasLasso = mode === 'lasso' && lassoPoints.length > 2;

    if (hasRect || hasLasso) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      if (hasRect) {
        ctx.fillRect(selection.x, selection.y, selection.width, selection.height);
      } else {
        ctx.beginPath();
        ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
        for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      if (hasRect) {
        const { x, y, width, height } = selection;
        ctx.save();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
        ctx.lineDashOffset = -marchingAntsOffset;
        ctx.strokeRect(x + 0.5, y + 0.5, width, height);
        ctx.strokeStyle = '#000';
        ctx.lineDashOffset = -(marchingAntsOffset + 6);
        ctx.strokeRect(x + 0.5, y + 0.5, width, height);
        ctx.restore();
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
        for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
        ctx.closePath();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
        ctx.lineDashOffset = -marchingAntsOffset; ctx.stroke();
        ctx.strokeStyle = '#000';
        ctx.lineDashOffset = -(marchingAntsOffset + 6); ctx.stroke();
        ctx.restore();
      }
    }
  }

  $effect(() => { selection; lassoPoints; drawSelection(); });
  $effect(() => {
    if (snapshotListVersion === lastHandledSnapshotListVersion) return;
    lastHandledSnapshotListVersion = snapshotListVersion;
    if (listRequestTimeout) {
      clearTimeout(listRequestTimeout);
      listRequestTimeout = null;
    }
    isLoadingSnapshots = false;
    isLoadingMore = false;
    listError = '';
  });

  onMount(() => {
    // Recent (local rolling tape) is the default view — start polling its status
    // and auto-load the in-panel player.
    startRecentStatusPolling();
    maybeStartEmbeddedRecent();
    lastHandledSnapshotListVersion = snapshotListVersion;
    if (!canViewHistory) {
      window.app.snapshotPreviewCanvas = null;
    }
    const tickFrame = () => {
      marchingAntsOffset = (marchingAntsOffset + 0.4) % 13;
      drawSelection();
      animId = requestAnimationFrame(tickFrame);
    };
    animId = requestAnimationFrame(tickFrame);
  });

  onDestroy(() => {
    stopRecentStatusPolling();
    stopEmbeddedRecent();
    if (animId) cancelAnimationFrame(animId);
    if (previewRequestTimeout) clearTimeout(previewRequestTimeout);
    if (listRequestTimeout) clearTimeout(listRequestTimeout);
    window.app?.wsClient?.messageHandlers?.delete('board_snapshot_get_response');
    window.app?.snapshotManager?.clearListCache?.();
    clearSnapshotHistoryState();
    if (window.app?.snapshotPreviewCanvas === previewCanvas || window.app?.snapshotPreviewCanvas === snapshotExportCanvas) {
      window.app.snapshotPreviewCanvas = null;
    }
    snapshotExportCanvas = null;
    for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
    thumbUrls.clear();
  });

  const hasSelection = $derived(
    (mode === 'rectangle' && selection && selection.width > 4 && selection.height > 4) ||
    (mode === 'lasso' && lassoPoints.length > 3)
  );

</script>

<div class="snapshot-overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="snapshot-panel" data-tut="history-dialog">

    <!-- Header -->
    <div class="snap-header">
      <div class="snap-header-left">
        <span class="snap-title">Time Machine</span>
      </div>
      <div class="snap-header-right">
        {#if view === 'snapshots'}
          <button class="snap-reload-btn" onclick={refresh} title="Refresh">&#8635;</button>
        {/if}
        <button class="snap-close-btn" onclick={close} title="Close">&times;</button>
      </div>
    </div>

    {#if view === 'recent'}
      <!-- Recent: local rolling DVR tape, played inside the modal -->
      <div class="snap-tab-panel snap-recent">
        {#if embedActive}
          <div class="rp-player">
            <div class="rp-stage">
              <canvas
                bind:this={embedCanvas}
                class="rp-canvas"
                class:panning={rpPanning}
                class:zoomed={rpZoom > 1}
                style="transform: {rpCanvasTransform}"
                onwheel={onRpWheel}
                onpointerdown={onRpPointerDown}
                onpointermove={onRpPointerMove}
                onpointerup={onRpPointerUp}
                onpointerleave={onRpPointerUp}
                ondblclick={resetRpView}
              ></canvas>
              {#if rpZoom > 1}
                <button class="rp-zoom-reset" onclick={resetRpView} title="Reset zoom">
                  {Math.round(rpZoom * 100)}%
                </button>
              {/if}
              {#if tmLoading}
                <div class="rp-overlay"><div class="rp-spinner"></div></div>
              {:else if tmPreview}
                <div class="rp-preview-spinner" title="Sharpening…" aria-label="Loading full-resolution frame"></div>
              {/if}
              <button
                class="rp-fullscreen"
                onclick={openFullscreenReplay}
                title="Open full-screen replay"
                aria-label="Open full-screen replay"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
              </button>
            </div>
            <ReplayControls
              getCanvas={() => embedCanvas}
              onExit={close}
              onAfterUndo={close}
            />

            {#if recentStale}
              <div class="snap-recent-warn rp-warn">This tape may be incomplete (you were disconnected or away).</div>
            {/if}
          </div>
        {:else}
          <div class="snap-recent-card">
            <div class="snap-recent-icon" aria-hidden="true">⏱</div>
            <h3 class="snap-recent-title">Recent activity</h3>
            <p class="snap-recent-sub">
              A local replay of roughly the last {formatWindow(recentStatus?.windowMs)} on this device.
            </p>
            {#if !recentConfigured}
              <div class="snap-recent-empty">Recent replay is disabled in App Settings.</div>
            {:else if !recentEnabled}
              <div class="snap-recent-empty">Recent history starts recording once you've joined and synced a room.</div>
            {:else}
              <div class="snap-recent-empty">Nothing to replay yet — draw something, or wait a few seconds for activity to accumulate.</div>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
    <!-- Snapshots: saved still images / restore -->
    <!-- Preview area -->
    <div class="snap-preview-wrap" bind:this={previewWrap} onwheel={onWheel}>
      {#if !selectedId}
        <div class="snap-preview-empty">Select a snapshot below to preview</div>
      {:else if isLoadingPreview}
        <div class="snap-preview-empty">Loading…</div>
      {:else if previewError}
        <div class="snap-preview-empty">{previewError}</div>
      {:else}
        <!-- Tool controls -->
        <div class="snap-tool-controls">
          <button
            class="snap-tool-btn"
            class:active={activeTool === 'select' && mode === 'rectangle'}
            onclick={() => { mode = 'rectangle'; activeTool = 'select'; clearSelection(); }}
            title="Rectangle Selection"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="2" width="12" height="12" rx="1"/>
            </svg>
          </button>
          <button
            class="snap-tool-btn"
            class:active={activeTool === 'select' && mode === 'lasso'}
            onclick={() => { mode = 'lasso'; activeTool = 'select'; clearSelection(); }}
            title="Lasso Selection"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M8 2C4.7 2 2 4.7 2 8C2 11.3 4.7 14 8 14C10 14 11.8 13.2 13 11.8"/>
              <circle cx="13" cy="11.8" r="1.8"/>
            </svg>
          </button>
          <button
            class="snap-tool-btn"
            class:active={activeTool === 'pan'}
            onclick={() => { activeTool = activeTool === 'pan' ? 'select' : 'pan'; }}
            title="Pan View"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M8 2V14M2 8H14M8 2L6.5 3.5M8 2L9.5 3.5M8 14L6.5 12.5M8 14L9.5 12.5M2 8L3.5 6.5M2 8L3.5 9.5M14 8L12.5 6.5M14 8L12.5 9.5"/>
            </svg>
          </button>
          <button class="snap-tool-btn snap-zoom-reset" onclick={resetView} title="Reset zoom">{zoomLabel}</button>
        </div>

        <!-- Canvas stack: preview behind, selection on top -->
        <canvas
          bind:this={previewCanvas}
          class="snap-preview-canvas"
          style="transform: {canvasTransform}"
        ></canvas>
        <canvas
          bind:this={selectionCanvas}
          class="snap-selection-canvas"
          style="transform: {canvasTransform}; cursor: {activeTool === 'pan' ? (isPanning ? 'grabbing' : 'grab') : 'crosshair'}"
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointerleave={onPointerUp}
        ></canvas>
      {/if}
    </div>

    <!-- Thumbnail strip -->
    <div
      class="snap-strip-wrap"
      bind:this={stripRef}
      role="presentation"
      onscroll={onStripScroll}
      onpointerdown={onStripPointerDown}
      onpointermove={onStripPointerMove}
      onpointerup={onStripPointerUp}
      onpointerleave={onStripPointerUp}
      style="cursor: {isDraggingStrip ? 'grabbing' : 'auto'}"
    >
      {#if isLoadingSnapshots && snapshots.length === 0}
        <span class="snap-strip-empty">Loading…</span>
      {:else if listError}
        <span class="snap-strip-empty snap-strip-error">{listError}</span>
      {:else if snapshots.length === 0}
        <span class="snap-strip-empty">
          {#if canViewHistory}
            No snapshots available yet.
          {:else}
            Only registered users can view board history unless they are alone in the room.
          {/if}
        </span>
      {:else}
        {#each snapshots as snap (snap.id)}
          <div
            class="snap-thumb-item"
            class:selected={snap.id === selectedId}
            onclick={() => { if (!stripMoved) selectSnapshot(snap.id); }}
            onkeydown={(event) => handleSnapshotKeydown(event, snap.id)}
            role="button"
            tabindex="0"
            title={snap.name}
          >
            {#if thumbUrlMap.get(snap.id)}
              <img src={thumbUrlMap.get(snap.id)} alt="snapshot" draggable="false" />
            {:else}
              <div class="snap-thumb-placeholder">{snap.auto ? 'Auto' : 'Manual'}</div>
            {/if}
            <span class="snap-thumb-time">{formatDate(snap.ts)}</span>
            <span class="snap-thumb-issuer">{snap.issuer}</span>
          </div>
        {/each}
        {#if isLoadingMore}
          <div class="snap-thumb-loading">Loading older snapshots...</div>
        {/if}
      {/if}
    </div>
    {#if showBackToPresent}
      <button class="snap-back-to-present" onclick={scrollToPresent} title="Jump back to the newest snapshots">
        <span aria-hidden="true">←</span>
        <span>Back to present</span>
      </button>
    {/if}

    <!-- Footer -->
    <div class="snap-footer">
      <span class="snap-hint">
        {#if !canRestoreHistory}
          View-only mode for registered users. Trusted users and above can restore snapshots.
        {:else if !selectedId}
          Select a snapshot below
        {:else if hasSelection && mode === 'lasso'}
          Lasso selection - restores the region (broadcast to all users)
        {:else if hasSelection && mode === 'rectangle'}
          Selection active - region uploads as a movable floating selection
        {:else}
          No selection - replaces the entire board
        {/if}
      </span>
      <div class="snap-footer-btns">
        {#if selectedId}
          <button class="btn danger" onclick={doDelete}>Delete</button>
        {/if}
        {#if hasSelection}
          <button class="btn secondary" onclick={clearSelection}>Clear Selection</button>
        {/if}
        <button class="btn secondary" disabled={!selectedId} onclick={openSnapshotSaveDialog}>
          Save Snapshot
        </button>
        <button class="btn primary" disabled={!selectedId || !canRestoreHistory} onclick={doRestore}>
          {#if !hasSelection}
            Restore Board
          {:else if mode === 'lasso'}
            Restore Region
          {:else}
            Upload
          {/if}
        </button>
      </div>
    </div>
    {/if}

  </div>
</div>

<style>
  .snapshot-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .snapshot-panel {
    background: var(--bg-secondary, #1a1a1a);
    border: 1px solid var(--border-subtle, #333);
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    position: relative;
    width: 92vw;
    max-width: 960px;
    height: 90vh;
    max-height: 720px;
    display: flex; flex-direction: column; overflow: hidden;
  }

  .snap-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; background: var(--bg-tertiary, #111);
    border-bottom: 1px solid var(--border-subtle, #333); flex-shrink: 0;
  }
  .snap-header-left { display: flex; align-items: center; gap: 20px; }

  .snap-title { font-size: 14px; font-weight: 600; color: var(--text-primary, #eee); }
  .snap-header-right { display: flex; align-items: center; gap: 8px; }

  /* Recent / Server panels */
  .snap-tab-panel { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .snap-recent-card {
    max-width: 420px; text-align: center; display: flex; flex-direction: column;
    align-items: center; gap: 12px;
  }
  .snap-recent-icon { font-size: 40px; line-height: 1; opacity: 0.9; }
  .snap-recent-title { margin: 0; font-size: 18px; font-weight: 600; color: var(--text-primary, #eee); }
  .snap-recent-sub { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-secondary, #aaa); }
  .snap-recent-empty { font-size: 12px; color: var(--text-muted, #777); }
  .snap-recent-warn {
    font-size: 12px; color: #f0b94a; background: rgba(240, 185, 74, 0.1);
    border: 1px solid rgba(240, 185, 74, 0.35); border-radius: 6px; padding: 8px 12px;
  }

  /* Embedded Recent player */
  .snap-recent { padding: 16px; }
  .rp-player { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; gap: 12px; }
  .rp-stage {
    flex: 1; min-height: 0; position: relative; display: flex; align-items: center;
    justify-content: center; background: #0a0a0a; border-radius: 8px; overflow: hidden;
  }
  .rp-canvas {
    max-width: 100%; max-height: 100%; object-fit: contain;
    transform-origin: center center;
    /* Override the global `canvas { cursor: none }` (the live board hides the
       system cursor to draw its own brush ring — meaningless in the player). */
    cursor: grab;
    /* Checkerboard so transparent boards read as transparent, not black. */
    background-image:
      linear-gradient(45deg, #1a1a1a 25%, transparent 25%),
      linear-gradient(-45deg, #1a1a1a 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #1a1a1a 75%),
      linear-gradient(-45deg, transparent 75%, #1a1a1a 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0;
    background-color: #2a2a2a;
  }
  .rp-canvas.zoomed { cursor: grab; }
  .rp-canvas.panning { cursor: grabbing; }
  .rp-zoom-reset {
    position: absolute; bottom: 10px; right: 10px; z-index: 6;
    padding: 4px 8px; min-width: 44px; font-size: 11px; font-weight: 600;
    background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px; color: #eee; cursor: pointer; font-variant-numeric: tabular-nums;
  }
  .rp-zoom-reset:hover { background: rgba(0, 0, 0, 0.8); color: #fff; }
  .rp-overlay {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.25); backdrop-filter: blur(2px);
  }
  .rp-spinner {
    width: 36px; height: 36px; border: 3px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff; border-radius: 50%; animation: rp-spin 0.9s linear infinite;
  }
  @keyframes rp-spin { to { transform: rotate(360deg); } }
  /* Subtle "still sharpening the full-res frame" hint — small, corner, no dim. */
  .rp-preview-spinner {
    position: absolute; bottom: 10px; left: 10px; z-index: 6;
    width: 16px; height: 16px; border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: rgba(255, 255, 255, 0.75); border-radius: 50%;
    animation: rp-spin 0.9s linear infinite; opacity: 0.7; pointer-events: none;
  }
  .rp-fullscreen {
    position: absolute; top: 10px; right: 10px; width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px; color: #eee; cursor: pointer;
  }
  .rp-fullscreen:hover { background: rgba(0, 0, 0, 0.8); color: #fff; }
  .rp-warn { margin: 0; }

  .snap-reload-btn {
    background: none; border: none; cursor: pointer; color: var(--text-secondary, #aaa);
    font-size: 18px; width: 28px; height: 28px; display: flex;
    align-items: center; justify-content: center; border-radius: 4px;
  }
  .snap-reload-btn:hover { background: var(--bg-elevated, #2a2a2a); color: var(--text-primary, #fff); }

  .snap-close-btn {
    background: transparent; border: none; color: #f0f2f5; font-size: 1.75rem;
    line-height: 1; cursor: pointer; padding: 0;
  }
  .snap-close-btn:hover { color: #fff; }

  .snap-preview-wrap { flex: 1; position: relative; background: #111; overflow: hidden; min-height: 0; }
  .snap-preview-empty {
    position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; color: var(--text-muted, #555); font-size: 13px;
    pointer-events: none; user-select: none;
  }

  .snap-tool-controls {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 3px; background: var(--bg-secondary, #1a1a1a);
    border: 1px solid var(--border-subtle, #333); border-radius: 8px; padding: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5); z-index: 10;
  }

  .snap-tool-btn {
    display: flex; align-items: center; justify-content: center; width: 30px; height: 30px;
    background: transparent; border: none; border-radius: 5px;
    color: var(--text-secondary, #aaa); cursor: pointer;
  }
  .snap-tool-btn:hover { background: var(--bg-elevated, #2a2a2a); color: #fff; }
  .snap-tool-btn.active { background: var(--accent-primary, #7c5cbf); color: #fff; }
  .snap-zoom-reset { width: auto; min-width: 44px; padding: 0 6px; font-size: 11px; font-weight: 600; }

  .snap-preview-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .snap-selection-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; pointer-events: auto; touch-action: none; }

  .snap-strip-wrap {
    height: 110px; flex-shrink: 0; background: var(--bg-tertiary, #111);
    border-top: 1px solid var(--border-subtle, #333); border-bottom: 1px solid var(--border-subtle, #333);
    display: flex; align-items: center; padding: 0 12px; gap: 8px;
    overflow-x: auto; overflow-y: hidden; scrollbar-width: thin;
  }
  .snap-strip-wrap::-webkit-scrollbar { height: 4px; }
  .snap-strip-wrap::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }

  .snap-strip-empty { font-size: 12px; color: var(--text-muted, #555); white-space: nowrap; }
  .snap-strip-empty.snap-strip-error { color: #ff6b6b; font-weight: 500; }

  .snap-thumb-item {
    flex-shrink: 0; width: 90px; height: 90px; border: 2px solid #333;
    border-radius: 5px; overflow: hidden; cursor: pointer; position: relative; background: #0a0a0a;
  }
  .snap-thumb-item:hover { border-color: #555; }
  .snap-thumb-item.selected { border-color: var(--accent-primary, #7c5cbf); }
  .snap-thumb-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .snap-thumb-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #555; }

  .snap-thumb-time {
    position: absolute; bottom: 0; left: 0; right: 0; font-size: 9px;
    text-align: center; background: rgba(0,0,0,0.65); color: #ccc; padding: 2px;
  }
  .snap-thumb-issuer {
    position: absolute; top: 0; left: 0; right: 0; font-size: 8px; font-weight: 600;
    text-align: center; background: rgba(0, 0, 0, 0.5); color: var(--accent-primary);
    padding: 2px; opacity: 0; transition: opacity 0.2s;
  }
  .snap-thumb-item:hover .snap-thumb-issuer, .snap-thumb-item.selected .snap-thumb-issuer { opacity: 1; }

  .snap-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; background: var(--bg-tertiary, #111); flex-shrink: 0; gap: 12px;
  }
  .snap-hint { font-size: 12px; color: var(--text-muted, #666); flex: 1; }
  .snap-footer-btns { display: flex; gap: 8px; align-items: center; }

  .btn { padding: 7px 14px; font-size: 13px; border-radius: 5px; cursor: pointer; border: none; }
  .btn.secondary { background: transparent; border: 1px solid #444; color: #aaa; }
  .btn.secondary:hover { background: #2a2a2a; color: #fff; }
  .btn.primary { background: var(--accent-primary, #7c5cbf); color: #fff; }
  .btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.danger { background: rgba(220, 53, 69, 0.2); color: #ff6b6b; border: 1px solid rgba(220, 53, 69, 0.4); }
  .btn.danger:hover { background: rgba(220, 53, 69, 0.4); }

  .snap-back-to-present {
    position: absolute; right: 18px; bottom: 128px; display: inline-flex;
    align-items: center; gap: 6px; padding: 8px 12px; border: 1px solid #333;
    border-radius: 999px; background: rgba(17, 17, 17, 0.92); color: #eee;
    font-size: 12px; cursor: pointer;
  }

  /* While the mobile tutorial toast is showing (see TutorialOverlay.svelte),
     shrink this dialog's own space so it renders below the toast instead of
     under it. */
  @media (max-width: 640px), (max-height: 640px) {
    :global(html[data-tutorial-active='true']) .snapshot-overlay {
      align-items: flex-start;
      padding-top: calc(var(--tutorial-toast-bottom, 0px) + 8px);
    }

    :global(html[data-tutorial-active='true']) .snapshot-panel {
      height: calc(90vh - var(--tutorial-toast-bottom, 0px) - 8px);
      max-height: calc(720px - var(--tutorial-toast-bottom, 0px) - 8px);
    }
  }
</style>
