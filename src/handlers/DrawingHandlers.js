/** @fileoverview Handles drawing-related events including tool changes, mouse interactions, and canvas operations. */

import { blurImageData } from '../utils/blurUtils.js';
import { setUserLayerContent } from '../remote/userLayerPresence.js';

/**
 * Sets up WebSocket event handlers for drawing and canvas operations.
 * @param {Function} wrapHandler - Function to wrap event handlers for sync buffering.
 * @param {App} app - The main application instance.
 */
export function setupDrawingHandlers(wrapHandler, app) {
  // Preload stackblur so remote fill blur uses the same renderer as local
  blurImageData(new ImageData(1, 1), 1, 1, 1).catch(() => {});
  const { users, ui, board, remoteUserHandler } = app;
  const pressureTools = new Set(['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur', 'imageBrush']);
  const applyImageToolData = (user, data) => {
    if (data.imageType === 'imageBrush') {
      remoteUserHandler.handleBrushLoad(user, data.imageData);
    } else if (data.imageType === 'pattern') {
      remoteUserHandler.handlePatternBrushLoad(user, data.imageData);
    } else if (data.imageType === 'confetti') {
      remoteUserHandler.handleConfettiBrushLoad(user, data.imageData);
    }
  };
  const queuePendingImageTool = (data) => {
    if (data?.sessionIndex === undefined || data?.sessionIndex === null || !data.imageType || !data.imageData) return;
    if (!app._pendingRemoteImageToolChanges) {
      app._pendingRemoteImageToolChanges = new Map();
    }
    const pending = app._pendingRemoteImageToolChanges.get(data.sessionIndex) || {};
    pending[data.imageType] = data.imageData;
    app._pendingRemoteImageToolChanges.set(data.sessionIndex, pending);
    setTimeout(() => {
      const user = users.get(data.sessionIndex);
      if (!user) return;
      const stored = app._pendingRemoteImageToolChanges?.get(data.sessionIndex);
      if (!stored?.[data.imageType]) return;
      applyImageToolData(user, data);
      delete stored[data.imageType];
      if (Object.keys(stored).length === 0) {
        app._pendingRemoteImageToolChanges.delete(data.sessionIndex);
      }
    }, 0);
  };

  wrapHandler('mm', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user || !data.ps || data.ps.length < 2) return;
    remoteUserHandler.handleMouseMove(user, data);
  });

  wrapHandler('md', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleMouseDown(user, data);
    }
  });

  wrapHandler('mu', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleMouseUp(user, data.seq || 0);
    }
  });

  // Pressure change - brush still commits per segment before updating.
  wrapHandler('cp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (!pressureTools.has(user.tool)) {
        return;
      }
      if (user.mousedown && !user._penStrokeActive && !user._inkStrokeActive) {
        if (user.tool === 'brush') {
          remoteUserHandler.commitLine(user, data.pressure, user.size, data.seq || 0);
        }
      }
      user.setPressure(data.pressure);
    }
  });

  // Size change - brush still commits per segment before updating.
  wrapHandler('cs', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (user.mousedown && !user._penStrokeActive && !user._inkStrokeActive) {
        if (user.tool === 'brush') {
          remoteUserHandler.commitLine(user, user.pressure, data.size, data.seq || 0);
        }
      }
      user.setSize(data.size);
      ui.updateRemoteSize(data.sessionIndex, data.size);
    }
  });

  wrapHandler('ct', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      const previousTool = user.tool;

      // Defensively clean up any dangling selection state when switching away from select
      if (data.tool !== 'select' && !user.isMaskMode && (user.floatingCanvas || user.pendingSelection)) {
        if (user.floatingCanvas) {
          // Floating canvas present but no commit/cancel was received — cancel it to restore
          // the erased content and clear the overlay, preventing a permanently stuck selection.
          remoteUserHandler.selectionHandler.handleSelectionCancel(user);
        } else {
          user.pendingSelection = null;
          user.context.clearRect(0, 0, board.getWidth(), board.getHeight());
          setUserLayerContent(user, false);
        }
      }

      if (previousTool === 'text' && data.tool !== 'text') {
        if (user.context) {
          user.context.clearRect(0, 0, board.getWidth(), board.getHeight());
          setUserLayerContent(user, false);
        }
        ui.setRemoteTextDomVisible(data.sessionIndex, true);
        ui.updateRemoteText(data.sessionIndex, '');
      }

      user.setTool(data.tool);
      // Track eraser mode so remote erase-all works correctly
      if (data.tool === 'erase') {
        user.eraseAllLayers = data.eraseAll || false;
      }
      remoteUserHandler.updateRemotePreviewPresentation(user);
      ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
      app.updateChatUserList?.();
    }
  });

  wrapHandler('cc', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      const nextOpacity = data.color[3];
      if (user.mousedown && user.tool === 'erase') {
        app.toolManager.getTool('erase')?.commitCurrentLine(user, user.pressure, user.size, nextOpacity);
      }
      user.setColor(data.color);
      user.setOpacity(nextOpacity); // Sync opacity from color alpha (matches local behavior)
      ui.updateRemoteColor(data.sessionIndex, data.color);

      const patternTool = app.toolManager.getTool('pattern');
      if (patternTool?._tileCache) {
        patternTool._tileCache.clear();
      }

      const fillTool = app.toolManager.getTool('fill');
      if (fillTool?._patternTileCache) {
        fillTool._patternTileCache.clear();
      }

      const selectTool = app.toolManager.getTool('select');
      if (selectTool?._patternTileCache) {
        selectTool._patternTileCache.clear();
      }

      const remoteSelectionHandler = app.remoteUserHandler?.selectionHandler;
      if (remoteSelectionHandler?._patternTileCache) {
        remoteSelectionHandler._patternTileCache.clear();
      }
    }
  });

  wrapHandler('csp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSpacing(data.spacing);
    }
  });

  wrapHandler('csm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSmoothing(data.smoothing);
    }
  });

  wrapHandler('chd', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setHardness(data.hardness);
    }
  });

  wrapHandler('cbr', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setBlurRadius(data.blurRadius);
    }
  });

  wrapHandler('cthn', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setThinning(data.thinning);
      if (data.sessionIndex === app.sessionIndex) {
        ui.updateThinningValue(Math.round(data.thinning * 100));
      }
    }
  });

  wrapHandler('csim', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSimulatePressure(data.simulatePressure);
      if (data.sessionIndex === app.sessionIndex) {
        ui.updateSimulatePressure(data.simulatePressure);
      }
    }
  });

  // Tool state for this user's next stroke; each MD also carries its own copy.
  wrapHandler('cpt', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setPressureTargets(data.pressureTargets);
    }
  });

  wrapHandler('cl', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setActiveLayer(data.layerIndex);
      app.refreshRemoteLayerVisibilityStates?.(data.sessionIndex);
    }
  });

  wrapHandler('cbm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      // Enforce layer restriction — remote users cannot use complex blend modes on restricted layers
      let blendMode = data.blendMode;
      const layerIdx = data.layerIndex ?? user.activeLayer ?? 0;
      if (!board.layerManager.getLayerAllowComplexBlendModes(layerIdx)) {
        blendMode = 'source-over';
      }
      user.setBlendMode(blendMode);
      // Absent `bbm` means "unchanged", not "existing": `bbm` is a proto3 string,
      // so an unset field arrives as '' and used to decode to 'existing' — which
      // clips every later blended stroke to the layer's existing alpha on the
      // OBSERVER only, shredding it along every old eraser path. Mirrors the MD
      // handler's guard in RemoteUserHandler.handleMouseDown.
      if (data.blendBakeMode !== undefined) user.setBlendBakeMode(data.blendBakeMode);
      remoteUserHandler.updateRemotePreviewPresentation(user);
      // If user is on text tool, switch preview mode (DOM vs canvas)
      if (user.tool === 'text') {
        const hasBlend = blendMode && blendMode !== 'source-over';
        ui.setRemoteTextDomVisible(user.id, !hasBlend);
      }
      if (data.layerIndex !== null && data.layerIndex !== undefined) {
        board.markCompositeFull();
        board.compositeAllLayers();
      }
    }
  });

  wrapHandler('kp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user && user.tool === 'text') {
      remoteUserHandler.handleKeyPress(user, data.key);
    }
  });

  wrapHandler('text_apply', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) return;

    // Self echo: the raster path already committed this text bake optimistically
    // (tagged pendingCommitEcho='text_apply'). Re-drawing it here would double it,
    // so reconcile that stroke to the authoritative seq every observer commits it
    // with and stop. Reconcile only — no canvas work. The vector path tags nothing,
    // so this is a no-op for it.
    if (app.isSelfEcho(data.sessionIndex)) {
      app.board?.layerManager?.reconcileLocalCommitStroke(user.id, data.seq || 0, 'text_apply');
      return;
    }

    remoteUserHandler.handleTextApply(user, data);
  });

  wrapHandler('text_remove', (data) => {
    if (!data?.id) return;
    board.textOverlay?.removeRemote(data.id);
  });

  wrapHandler('clr', () => {
    board.clear();
  });

  wrapHandler('mir', () => {
    const mirror = board.toggleMirror();
    ui.updateMirrorDisplay(mirror);
    // Keep an open mirror panel's "Mirror whole board" checkbox honest when a
    // different admin flips it.
    app.mirrorRegionController?.syncBoardMirrorCheckbox?.();
  });

  wrapHandler('cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleCancel(user);
    }
  });

  wrapHandler('gmp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleBrushLoad(user, data.brushData);
    }
  });

  wrapHandler('gpt', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handlePatternBrushLoad(user, data.patternData);
    }
  });

  wrapHandler('image_tool', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) {
      queuePendingImageTool(data);
      return;
    }

    applyImageToolData(user, data);
  });

  wrapHandler('cpm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.patternMode = data.patternMode || false;
    }
  });

  wrapHandler('cf', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) {
      if (!app._pendingRemoteFontChanges) {
        app._pendingRemoteFontChanges = new Map();
      }
      app._pendingRemoteFontChanges.set(data.sessionIndex, {
        font: data.font,
        textPositionMultiplier: data.textPositionMultiplier,
        textPositionOffset: data.textPositionOffset
      });
      return;
    }

    user.setFont(data.font);
    if (data.textPositionMultiplier !== undefined) {
      user.setTextPositionMultiplier(data.textPositionMultiplier);
    }
    if (data.textPositionOffset !== undefined) {
      user.setTextPositionOffset(data.textPositionOffset);
    }
    ui.updateRemoteFont(data.sessionIndex, data.font);
    ui.updateRemoteTextLayout(data.sessionIndex, user);
    app._refreshTextRenderingAfterFontLoad?.(data.font);

    if (user.tool !== 'text' || !user.text) return;

    if (user.blendMode && user.blendMode !== 'source-over') {
      remoteUserHandler._renderRemoteTextToCanvas(user);
    } else {
      ui.updateRemoteText(data.sessionIndex, user.text);
    }
  });

  wrapHandler('csdm', (data) => {
    // Shape draw mode belongs to the user who set it. This used to call
    // app.applyShapeDrawMode, which rewrote THIS client's mode, radio buttons
    // and localStorage from someone else's preference — and still left remote
    // shapes rendering with the observer's mode rather than the drawer's.
    const user = users.get(data.sessionIndex);
    if (user) user.shapeDrawMode = app.normalizeShapeDrawMode(data.shapeDrawMode);
  });

  wrapHandler('glitch_result', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user || !data.imageData) return;

    // Self echo: we already committed this glitch layer's stroke locally (tagged
    // pendingCommitEcho='glitch'). Reconcile THAT layer's stroke to this echo's
    // authoritative seq so our ordering matches observers (who commit each glitch
    // layer at this same per-layer seq). Reconcile only — no recompute/redraw.
    if (app.isSelfEcho(data.sessionIndex)) {
      board.layerManager.reconcileLocalCommitStroke(user.id, data.seq || 0, 'glitch', data.layerIndex);
      return;
    }

    const bounds = { x: data.x, y: data.y, width: data.width, height: data.height };
    const pendingGlitch = remoteUserHandler.queueRemoteGlitchImage(user, bounds, data.layerIndex, data.seq || 0, data.blendMode || null, data.blendBakeMode || null);
    if (!pendingGlitch) return;

    const img = new Image();
    img.onload = () => {
      // Convert to canvas for use as _cachedBlurResult
      const canvas = document.createElement('canvas');
      canvas.width = data.width;
      canvas.height = data.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, data.width, data.height);
      remoteUserHandler.resolveRemoteGlitchImage(pendingGlitch, canvas);
    };
    img.onerror = () => {
      pendingGlitch.canceled = true;
      remoteUserHandler.resolveRemoteGlitchImage(pendingGlitch, null);
    };
    img.src = data.imageData;
  });

  /**
   * Remote UNDO/REDO must not overtake a selection commit that is still waiting
   * on SEL_LIFT's image decode.
   *
   * `RemoteSelectionHandler._queueIfLoading` defers SEL_COMMIT (and the other
   * selection verbs) onto `user.pendingImageLoad` while the lifted PNG decodes.
   * UNDO had no such gate, so it ran BEFORE the stamp it targets existed:
   * `board.undo` found nothing (or the wrong stroke), then the queued
   * SEL_COMMIT landed afterwards and the "undone" stamp survived.
   *
   * Live clients dodge this because real time between messages lets the decode
   * finish; a JOINER replays the command tail back-to-back and loses the race —
   * which is exactly why this presented as a late-join-only failure
   * (`move_commit_then_undo`: joiner kept an extra `S0…r` commit stamp).
   *
   * Chaining onto the same promise also preserves order: SEL_COMMIT was queued
   * first, so it runs first. This is the selection-side twin of the
   * pendingGlitchSeq guard below, which handles the same hazard for the other
   * asynchronously-committed stroke type.
   *
   * @returns {boolean} true when deferred (caller should return)
   */
  const deferBehindSelectionDecode = (user, action) =>
    !!remoteUserHandler.selectionHandler?._queueIfLoading?.(user, action);

  /**
   * A remote pattern-mode FILL must not overtake the GPT payload it renders with.
   *
   * `handlePatternBrushLoad` deliberately leaves `user.patternBrush` unset until
   * the tile image has decoded, and buffers pattern STAMPS onto
   * `user._patternPendingStrokes` in the meantime. FILL had no such gate, so a
   * fill that landed inside the decode window read a null brush, fell through
   * `FloodFillTool._renderMask`'s `usePatternFill` check to the flat-colour
   * branch, and committed it — permanently, since the commit is baked.
   *
   * Live clients dodge this because seconds of real time separate a user
   * choosing a pattern from clicking to fill. A JOINER replays the tail
   * back-to-back, so a 250KB tile that takes ~30ms to decode is easily beaten by
   * the FILL sitting a millisecond behind it — which is why this presented as
   * "my pattern fills came back as solid colours after a resync" and cleared on
   * a refresh (that restores rendered pixels instead of replaying the tail).
   *
   * Buffering rather than dropping keeps the fill in wire order relative to the
   * sender's stamps, and `replayPending` runs it with this payload's brush and
   * settings swapped in.
   *
   * @returns {boolean} true when deferred (caller should return)
   */
  const deferBehindPatternDecode = (user, action) => {
    if (!user?.patternMode || !user._patternPendingStrokes) return false;
    user._patternPendingStrokes.push({ type: 'run', run: action });
    return true;
  };

  wrapHandler('undo', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (app.isSelfEcho(user.id)) return;

      const targetSeq = data.targetSeq || 0;
      if (deferBehindSelectionDecode(user, () => applyRemoteUndo(user, targetSeq))) return;
      applyRemoteUndo(user, targetSeq);
    }
  });

  /**
   * Remember whether this user's Nth remote UNDO actually removed anything here,
   * so the Nth-from-last REDO can be paired with it. LIFO, mirroring how the
   * sender pops its own redo stack.
   *
   * An undo we DECLINE (`applied` false) must consume its redo silently: the
   * sender's redo stack holds an entry ours does not, so replaying it here would
   * pop some *other* stroke we undid earlier and restore something the sender
   * never restored.
   * @param {import('../User.js').User} user
   * @param {boolean} applied
   */
  const recordUndoOutcome = (user, applied) => {
    if (!Array.isArray(user._remoteUndoLedger)) user._remoteUndoLedger = [];
    user._remoteUndoLedger.push(applied);
    // The ledger only exists to pair with redos, which are far rarer than undos.
    if (user._remoteUndoLedger.length > 256) user._remoteUndoLedger.shift();
  };

  function applyRemoteUndo(user, targetSeq = 0) {
    {
      const layerGroups = board.layerManager?.layerGroups || [];

      if (user.tool === 'glitchBlur') {
        if (user.mousedown || layerGroups.some(group => group?.activeStrokeByUser?.has(user.id))) {
          remoteUserHandler.handleCancel(user);
        }
        remoteUserHandler.cancelLatestPendingGlitchImage(user.id);
        if (remoteUserHandler.undoLatestRemoteGlitchImage(user.id)) {
          recordUndoOutcome(user, true);
          return;
        }
      } else {
        // Glitch stamps commit asynchronously (image decode), so on a fresh joiner
        // the replayed command tail can dispatch this UNDO while the target glitch
        // is still decoding (not yet in the strokeStack). The branch above only
        // runs when the user is STILL on the glitch tool; a user who switched tools
        // (e.g. to brush) after the glitch before undoing skips it, so board.undo
        // below would miss the in-flight glitch and it would commit anyway —
        // leaving a stamp on the joiner that had been undone.
        //
        // Cancel the in-flight glitch here too, but only when it outranks every
        // committed stroke for this user (by seq) — i.e. it really is the most
        // recent stroke this UNDO targets. Otherwise a later committed stroke is
        // the undo target and must fall through to board.undo (don't cancel an
        // earlier glitch that should survive).
        const pendingGlitchSeq = remoteUserHandler.getLatestPendingGlitchSeq(user.id);
        if (pendingGlitchSeq >= 0) {
          let maxCommittedSeq = -1;
          for (const group of layerGroups) {
            for (const stroke of group.strokeStack) {
              if (stroke.userId === user.id && (stroke.seq || 0) > maxCommittedSeq) {
                maxCommittedSeq = stroke.seq || 0;
              }
            }
          }
          if (pendingGlitchSeq >= maxCommittedSeq) {
            remoteUserHandler.cancelLatestPendingGlitchImage(user.id);
            recordUndoOutcome(user, true);
            return;
          }
        }
      }

      const hasActiveStroke = user.mousedown || layerGroups.some(
        group => group?.activeStrokeByUser?.has(user.id)
      );
      if (hasActiveStroke) {
        remoteUserHandler.handleCancel(user);
        recordUndoOutcome(user, true);
        return;
      }

      const undone = board.undo(user.activeLayer, user.id, targetSeq);
      if (!undone && user.tool === 'glitchBlur') {
        remoteUserHandler.markPendingGlitchUndo(user.id);
      }
      recordUndoOutcome(user, !!undone);
    }
  }

  function applyRemoteRedo(user) {
    const ledger = user._remoteUndoLedger;
    if (Array.isArray(ledger) && ledger.length > 0 && ledger.pop() === false) return;
    board.redo(user.id);
  }

  wrapHandler('redo', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      // Same ordering hazard as UNDO — a redo that overtakes a pending selection
      // commit re-applies against a stack that does not have it yet.
      if (deferBehindSelectionDecode(user, () => applyRemoteRedo(user))) return;
      applyRemoteRedo(user);
    }
  });

  wrapHandler('fill', async (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) return;

    // Self echo: we already computed and committed this fill optimistically on
    // the local path (the committed stroke is tagged pendingCommitEcho='fill').
    // Recomputing it here would double-fill. Instead, reconcile that pending
    // stroke with the authoritative FILL seq so our global ordering matches
    // every observer (who commit the fill carrying this same seq). Reconcile
    // only — no canvas work.
    if (app.isSelfEcho(data.sessionIndex)) {
      board.layerManager.reconcileLocalCommitStroke(user.id, data.seq || 0, 'fill');
      return;
    }

    if (deferBehindPatternDecode(user, () => applyRemoteFill(data, user))) return;

    await applyRemoteFill(data, user);
  });

  /**
   * Apply a remote flood fill. Split out of the `fill` handler so a pattern-mode
   * fill can be replayed verbatim once the sender's tile finishes decoding.
   * @param {Object} data - Decoded FILL message.
   * @param {import('../User.js').User} user - The filling user.
   */
  async function applyRemoteFill(data, user) {
    remoteUserHandler._invalidateFillPreview?.(user);

    const fillTool = app.toolManager.getTool('fill');
    if (!fillTool) return;

    const width = board.getWidth();
    const height = board.getHeight();
    const x = data.x;
    const y = data.y;
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    const layerIndex = data.layerIndex ?? user.activeLayer ?? 0;
    const userId = user.id;

    const fillColor = user.color ?? [0, 0, 0, 1];
    const fillR = Math.round(fillColor[0]);
    const fillG = Math.round(fillColor[1]);
    const fillB = Math.round(fillColor[2]);
    // Match local fill behavior: use the opacity slider only so alpha is not applied twice.
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    const userOpacity = opacitySlider;

    // A remote fill floods from the sender's click and can reach anywhere on
    // the board, so it reads the full raster rather than the display surface.
    const imageData = board.getFullBoardImageData(0, 0, width, height);
    if (!imageData) return;
    const imgData = imageData.data;

    // Check target vs fill color similarity (same as local)
    const startIdx = (y * width + x) * 4;
    const tR = imgData[startIdx], tG = imgData[startIdx + 1], tB = imgData[startIdx + 2], tA = imgData[startIdx + 3];
    if (tA >= 10) {
      const dr = tR - fillR, dg = tG - fillG, db = tB - fillB, da = tA - 255;
      if (dr * dr + dg * dg + db * db + da * da <= 100) return;
    }

    const expansion = data.expansion || 0;
    const blurRadius = data.blurRadius || 0;

    const result = await fillTool._fillWorker.computeFill(
      imgData, width, height, x, y, 10, expansion, null
    );
    if (!result) return;

    const fillLimit = fillTool._isFillTooLarge?.(result, width, height);
    if (fillLimit) {
      fillTool._warnFillTooLarge?.(fillLimit, false);
      return;
    }

    const blendMode = user.blendMode || 'source-over';
    // Window the active-stroke canvas to the mask instead of the whole board.
    // Only the primary fill's bounds are known here — the mirror copies below
    // are computed one at a time, against a raster that already includes
    // whatever was painted before them, so they cannot be hoisted without
    // changing what they flood. Each one grows the window instead.
    const bounds = fillTool._fillStrokeBounds(result, [], blurRadius, expansion, width, height);
    board.layerManager.beginUserStroke(layerIndex, userId, blendMode, user.blendBakeMode, bounds);
    board.applySelectionMaskClipForStroke(layerIndex, userId);
    let strokeCtx = board.layerManager.getUserStrokeContext(layerIndex, userId);
    if (!strokeCtx) return;
    let origin = board.layerManager.getActiveStroke(layerIndex, userId)?.origin ?? null;

    fillTool._renderMask(strokeCtx, result, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user, origin);

    const pad = Math.ceil(blurRadius * 3) + Math.ceil(Math.abs(expansion));
    const bx = Math.max(0, result.minX - pad);
    const by = Math.max(0, result.minY - pad);
    const bw = Math.min(width, result.maxX + pad + 1) - bx;
    const bh = Math.min(height, result.maxY + pad + 1) - by;
    board.expandDirtyRect(user, bx, by, bw, bh);

    for (const region of board.getActiveMirrorRegions()) {
      if (!region?.synthetic) continue;
      const mirrored = board.mirrorPointToRegion({ x, y }, region);
      const mx = Math.round(mirrored.x);
      const my = Math.round(mirrored.y);
      if (mx < 0 || mx >= width || my < 0 || my >= height) continue;
      const mirrorData = board.getFullBoardImageData(0, 0, width, height).data;
      const mResult = await fillTool._fillWorker.computeFill(
        mirrorData, width, height, mx, my, 10, expansion, null
      );
      if (mResult) {
        const mirrorFillLimit = fillTool._isFillTooLarge?.(mResult, width, height);
        if (mirrorFillLimit) {
          fillTool._warnFillTooLarge?.(mirrorFillLimit, false);
          continue;
        }
        // Growing reallocates the canvas (blitting the existing paint forward),
        // so both the ctx and the origin have to be re-read afterwards.
        const mBounds = fillTool._fillStrokeBounds(mResult, [], blurRadius, expansion, width, height);
        strokeCtx = board.layerManager.getUserStrokeContext(layerIndex, userId, undefined, undefined, mBounds) || strokeCtx;
        origin = board.layerManager.getActiveStroke(layerIndex, userId)?.origin ?? null;
        // withMirrorRegionClip builds its clip rect in BOARD coordinates, so a
        // windowed ctx is translated here rather than handed `origin`.
        strokeCtx.save();
        strokeCtx.translate(-(origin?.x ?? 0), -(origin?.y ?? 0));
        board.withMirrorRegionClip(strokeCtx, region, () => {
          fillTool._renderMaskComposite(strokeCtx, mResult, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user);
        });
        strokeCtx.restore();
        const mbx = Math.max(0, mResult.minX - pad);
        const mby = Math.max(0, mResult.minY - pad);
        const mbw = Math.min(width, mResult.maxX + pad + 1) - mbx;
        const mbh = Math.min(height, mResult.maxY + pad + 1) - mby;
        board.expandDirtyRect(user, mbx, mby, mbw, mbh);
      }
    }

    board.releaseSelectionMaskClipForStroke(layerIndex, userId);
    board.layerManager.commitUserStroke(layerIndex, userId, { seq: data.seq || 0 });
    board.compositeAllLayers();
  }
}
