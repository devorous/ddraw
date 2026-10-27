#!/usr/bin/env node
/**
 * @fileoverview Replay Parity Suite — verifies that the local Recorder +
 * ReplayEngine produces byte-identical pixels to the live drawing path.
 *
 * Driven via the Chrome DevTools Protocol (puppeteer wraps CDP). Three tabs:
 *
 *   Tab A — drawer  (records its own session)
 *   Tab B — observer (independent live mirror, sanity check on broadcast)
 *   Tab C — replay viewer (boots /go/ but stays out of the room;
 *           gets fed the recording bundle from A and runs ReplayEngine)
 *
 * Pass criterion (per test case):
 *   - A↔B  diff passes (live broadcast/handler path correct — same oracle as
 *     comprehensive_sync_suite.js)
 *   - A↔C  diff passes (Recorder + ReplayEngine path is pixel-identical)
 *
 * Uses the SAME pixel tolerance/diff helpers as the puppeteer sync suite via
 * the shared testing/lib/layerDiff.mjs module. A regression visible only in
 * A↔C is therefore a real replay-only bug, not a tolerance drift.
 *
 * Usage:
 *   node testing/devtools/replay_parity_suite.mjs
 *   node testing/devtools/replay_parity_suite.mjs --headed
 *   node testing/devtools/replay_parity_suite.mjs --only=brush_step_1,ink_step_1
 *
 * Env vars:
 *   TARGET_URL       http://localhost:3000/go/
 *   HEADLESS         "false" to show the browser windows
 *   PROPAGATION_MS   3500
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PIXEL_TOLERANCE,
  PASS_PCT,
  captureLayerSnapshotsInPage,
  captureReplayLayerSnapshotsInPage,
  diffSnapshots,
} from '../lib/layerDiff.mjs';
import { pressureActions } from '../lib/pressureStroke.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const TARGET_URL     = process.env.TARGET_URL    || 'http://localhost:3000/go/';
const HEADLESS       = process.env.HEADLESS !== 'false';
const PROPAGATION_MS = parseInt(process.env.PROPAGATION_MS || '3500', 10);
const REPLAY_SETTLE_MS = parseInt(process.env.REPLAY_SETTLE_MS || '1500', 10);

const args = process.argv.slice(2);
let NAME_FILTER = null;
// Diagnostic: neutralise the replay engine's eager-bake optimisation.
// TimeMachine marks every user who never undoes in the tape as "eager bake",
// which flattens each stroke straight into flatCanvas instead of keeping it in
// the live strokeStack. Baking resolves a stroke's blend against whatever is
// beneath it AT BAKE TIME and round-trips the result through 8-bit RGBA, so for
// non-source-over strokes (eraser, blend modes) and soft/stamped ones it need
// not equal a single final composite. Toggling this isolates "the ReplayEngine
// applied the wrong thing" from "the ReplayEngine baked it differently".
let NO_EAGER_BAKE = false;
for (const a of args) {
  if (a === '--headed') process.env.HEADLESS = 'false';
  else if (a === '--no-eager-bake') NO_EAGER_BAKE = true;
  else if (a.startsWith('--only=')) NAME_FILTER = a.slice('--only='.length).split(',').map((s) => s.trim());
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `parity_${RUN_ID}`);

// ─── Test matrix ───────────────────────────────────────────────────────────

const TEST_CASES = [
  {
    name: 'brush_step_1',
    action: async (page) => {
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 30, color: [220, 60, 60, 1], hardness: 100 });
      await drawPath(page, [{ x: 300, y: 300 }, { x: 700, y: 400 }, { x: 1100, y: 350 }]);
    },
  },
  {
    name: 'brush_blend_modes',
    action: async (page) => {
      const modes = [
        { blendMode: 'source-over', color: [255, 0, 0, 0.8] },
        { blendMode: 'multiply',    color: [0, 255, 0, 0.8] },
        { blendMode: 'screen',      color: [0, 0, 255, 0.8] },
      ];
      await selectTool(page, 'brush');
      for (let i = 0; i < modes.length; i++) {
        await setToolSettings(page, { size: 80, hardness: 100, ...modes[i] });
        const y = 250 + i * 60;
        await drawPath(page, [{ x: 300, y }, { x: 900, y: y + 100 }, { x: 1500, y }]);
      }
    },
  },
  // Covers LayerManager active-stroke windowing's mirror-bounds extension
  // (docs/scope_layermanager_active_stroke_windowing_RESULT.md) specifically
  // through the REPLAY path — ReplayEngine keeps its OWN separate
  // mirrorPointToRegion/mirrorPointsToRegion (not shared with Board, only
  // _mirrorRegionMatrix is), so a live-only check cannot rule out drift here.
  // A short, localized brush stroke near one edge, mirrored vertically —
  // small enough that the window actually stays smaller than full-board.
  {
    name: 'brush_mirror_windowed',
    action: async (page) => {
      await armMirrorRegion(page, 'vertical');
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 30, color: [200, 40, 160, 1], hardness: 100 });
      await drawPath(page, [{ x: 250, y: 300 }, { x: 350, y: 340 }, { x: 300, y: 400 }]);
    },
  },
  {
    name: 'ink_step_1',
    action: async (page) => {
      await selectTool(page, 'ink');
      await setToolSettings(page, { size: 20, color: [0, 0, 0, 1], smoothing: 40 });
      await drawPath(page, [{ x: 300, y: 300 }, { x: 700, y: 500 }, { x: 1100, y: 300 }]);
    },
  },
  {
    name: 'flowPen_step_1',
    action: async (page) => {
      await selectTool(page, 'flowPen');
      await setToolSettings(page, { size: 25, color: [0, 100, 200, 1] });
      await drawPath(page, [{ x: 300, y: 300 }, { x: 700, y: 400 }, { x: 1100, y: 300 }]);
    },
  },
  {
    name: 'shape_set',
    action: async (page) => {
      await selectTool(page, 'rectangle');
      await setToolSettings(page, { size: 6, color: [255, 0, 0, 1] });
      await drawPath(page, [{ x: 300, y: 300 }, { x: 700, y: 500 }]);
      await selectTool(page, 'circle');
      await setToolSettings(page, { size: 6, color: [0, 0, 255, 1] });
      await drawPath(page, [{ x: 800, y: 300 }, { x: 1200, y: 500 }]);
      await selectTool(page, 'line');
      await setToolSettings(page, { size: 4, color: [0, 200, 0, 1] });
      await drawPath(page, [{ x: 300, y: 600 }, { x: 1200, y: 700 }]);
    },
  },
  {
    name: 'eraser_over_strokes',
    action: async (page) => {
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 40, color: [220, 60, 60, 1], hardness: 100 });
      await drawPath(page, [{ x: 300, y: 400 }, { x: 1200, y: 400 }]);
      await selectTool(page, 'erase');
      await setToolSettings(page, { size: 50 });
      await drawPath(page, [{ x: 400, y: 350 }, { x: 1100, y: 450 }]);
    },
  },
  // A selection MASK is per-user drawing state that clips whatever the user
  // draws next — it owns no pixels of its own, so it leaves no trace in the
  // tape beyond a single SEL_MASK message. ReplayEngine used to stub the mask
  // clip helpers to no-ops and had no SEL_MASK case at all, so the time machine
  // redrew masked strokes running straight past the mask edge while the live
  // board had clipped them. That is a pure A↔C failure: A↔B was always fine.
  {
    name: 'selection_mask_brush',
    action: async (page) => {
      await armSelectMode(page, 'rect');
      await drawPath(page, [{ x: 300, y: 250 }, { x: 700, y: 400 }, { x: 900, y: 650 }]);
      await enableSelectionMask(page);
      await selectTool(page, 'brush');
      await sleep(250);
      await setToolSettings(page, { size: 40, color: [255, 140, 0, 1], hardness: 100 });
      // Crosses the mask's right edge at x=900 — half of this stroke must not exist.
      await drawPath(page, [{ x: 400, y: 450 }, { x: 900, y: 450 }, { x: 1400, y: 450 }]);
    },
  },
  {
    name: 'selection_mask_lasso',
    action: async (page) => {
      await armSelectMode(page, 'lasso');
      await drawPath(page, [
        { x: 300, y: 250 }, { x: 900, y: 250 }, { x: 900, y: 650 },
        { x: 300, y: 650 }, { x: 300, y: 250 },
      ]);
      await enableSelectionMask(page);
      await selectTool(page, 'brush');
      await sleep(250);
      await setToolSettings(page, { size: 40, color: [0, 200, 255, 1], hardness: 100 });
      await drawPath(page, [{ x: 400, y: 450 }, { x: 900, y: 450 }, { x: 1400, y: 450 }]);
    },
  },
  {
    name: 'selection_mask_eraser',
    action: async (page) => {
      // The eraser takes a different route to the clip (destination-out strokes
      // and the erase-all-layers branch both apply it separately), so a masked
      // erase can regress on its own.
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 60, color: [220, 60, 60, 1], hardness: 100 });
      await drawPath(page, [{ x: 300, y: 450 }, { x: 1400, y: 450 }]);
      await armSelectMode(page, 'rect');
      await drawPath(page, [{ x: 300, y: 250 }, { x: 700, y: 400 }, { x: 900, y: 650 }]);
      await enableSelectionMask(page);
      await selectTool(page, 'erase');
      await sleep(250);
      await setToolSettings(page, { size: 50 });
      // Only the part of the erase inside the mask may bite.
      await drawPath(page, [{ x: 400, y: 450 }, { x: 1400, y: 450 }]);
    },
  },
  // Covers eraser active-stroke windowing on a bakedSequences layer (groupIdx
  // 1, no flatCanvas — see docs/scope_eraser_active_stroke_windowing.md's
  // layer-1-vs-2/3 distinction). eraser_over_strokes only exercises groupIdx
  // 0 (flatCanvas); this is the other code path in `_bakeStrokeToBin`.
  {
    name: 'eraser_over_strokes_layer2',
    action: async (page) => {
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 40, color: [60, 160, 220, 1], hardness: 100 });
      await drawPath(page, [{ x: 300, y: 400 }, { x: 1200, y: 400 }]);
      await page.evaluate(() => window.app.handleLayerSelect(1));
      await sleep(200);
      await setToolSettings(page, { size: 40, color: [220, 160, 60, 1], hardness: 100 });
      await drawPath(page, [{ x: 300, y: 550 }, { x: 1200, y: 550 }]);
      await selectTool(page, 'erase');
      await setToolSettings(page, { size: 50 });
      // Segmented so the window grows more than once mid-gesture.
      await drawPath(page, [{ x: 400, y: 500 }, { x: 700, y: 600 }, { x: 1100, y: 500 }]);
    },
  },
  // The mask armed BEFORE the tape opens. No SEL_MASK ever lands on the tape,
  // so the only way the replay can learn about it is the opening snapshot —
  // making this the checkpoint-rebuild case in miniature. It is also the COMMON
  // case in the real History tab, not a corner one: a rolling-tape scrub always
  // opens at the nearest checkpoint, and the SEL_MASK that armed the mask has
  // usually scrolled well behind it.
  {
    name: 'selection_mask_preexisting',
    preAction: async (page) => {
      await armSelectMode(page, 'rect');
      await drawPath(page, [{ x: 300, y: 250 }, { x: 700, y: 400 }, { x: 900, y: 650 }]);
      await enableSelectionMask(page);
      await selectTool(page, 'brush');
      await sleep(250);
    },
    action: async (page) => {
      await setToolSettings(page, { size: 40, color: [140, 220, 60, 1], hardness: 100 });
      await drawPath(page, [{ x: 400, y: 450 }, { x: 900, y: 450 }, { x: 1400, y: 450 }]);
    },
  },
  {
    name: 'undo_after_strokes',
    action: async (page) => {
      await selectTool(page, 'brush');
      const variations = [
        { color: [255, 0, 0, 1], size: 30 },
        { color: [0, 255, 0, 1], size: 25 },
        { color: [0, 0, 255, 1], size: 35 },
      ];
      for (let i = 0; i < variations.length; i++) {
        await setToolSettings(page, { ...variations[i], hardness: 100 });
        const y = 300 + i * 100;
        await drawPath(page, [{ x: 300, y }, { x: 700, y: y + 40 }, { x: 1100, y }]);
      }
      await page.evaluate(() => {
        window.app.handleUndo?.();
        window.app.inputBufferManager?.tick();
      });
      await sleep(250);
    },
  },
];

// Variable-pressure, self-crossing strokes (pressure drives opacity, or opacity + size) for Ink and
// Fluid Brush, plus undo/redo and a mid-stroke cancel / tool switch. Shared with
// testing/pressure_opacity_sync.test.mjs via testing/lib/pressureStroke.mjs.
TEST_CASES.push(...pressureActions());

// ─── Page Helpers ──────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function selectTool(page, tool) {
  await page.evaluate((t) => window.app.selectTool(t), tool);
}

async function setToolSettings(page, settings) {
  await page.evaluate((s) => {
    const app = window.app;
    if (s.size !== undefined)      app.handleSizeChange({ target: { value: s.size } });
    if (s.color !== undefined)     app.handleColorInputChange(s.color);
    if (s.blendMode !== undefined) app.handleBlendModeChange(s.blendMode);
    if (s.smoothing !== undefined) app.handleSmoothingChange({ target: { value: s.smoothing } });
    if (s.hardness !== undefined)  app.handleHardnessChange({ target: { value: s.hardness } });
  }, settings);
}

/** Put the Select tool in a known mode with no stale selection. */
async function armSelectMode(page, mode) {
  await page.evaluate(async (m) => {
    const app = window.app;
    app.selectTool('select');
    // Await the lazy import directly instead of polling for `.realTool`.
    // SelectTool.js is large, and a COLD vite dev transform of it on the first
    // case of a run can outlast any reasonable poll timeout — which is exactly
    // how this failed: case 1 timed out at 15s and every later case, running
    // against a now-warm module, armed instantly.
    const rt = await app.toolManager.getTool('select').loadRealTool();
    rt.cancelSelection?.();
    rt.setMode(m);
  }, mode);
  await sleep(200);
}

/**
 * Add a mirror region and broadcast it (MIRROR_REGION on the wire), same
 * pattern as selection_parity_suite.mjs's addMirrorRegion. Needed (rather
 * than just mutating board.mirrorRegions) so the region actually lands on
 * the recorded tape and the replay side learns about it too.
 */
async function armMirrorRegion(page, mode = 'vertical') {
  await page.evaluate((m) => {
    const app = window.app;
    const region = {
      id: 'mr_parity_fixture',
      x: 0, y: 0, width: app.board.getWidth(), height: app.board.getHeight(),
      mode: m, axis: m, showLine: true, owner: app.self?.id ?? null,
    };
    app.board.setMirrorRegions([...(app.board.mirrorRegions || []), region]);
    app.wsClient.broadcastMirrorRegion({ action: 'create', region });
  }, mode);
  await sleep(250);
}

/** Turn the current selection into a mask (SEL_MASK on the wire). */
async function enableSelectionMask(page) {
  await sleep(250);
  await page.evaluate(async () => {
    window.app.toolManager.getTool('select').realTool.toggleMaskMode(true);
    window.app.inputBufferManager?.tick();
    await new Promise((r) => setTimeout(r, 250));
  });
  await sleep(250);
}

async function getClientCoords(page, boardX, boardY) {
  return page.evaluate((bx, by) => {
    const board = window.app.board;
    const containerRect = board.container.getBoundingClientRect();
    const rad = board.rotation * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    let rx = bx * board.zoom;
    let ry = by * board.zoom;
    if (board.canvasFlipped) rx = (board.getWidth() - bx) * board.zoom;
    const rxr = rx * cos + ry * sin;
    const ryr = -rx * sin + ry * cos;
    return {
      clientX: rxr + board.panX + containerRect.left,
      clientY: ryr + board.panY + containerRect.top,
    };
  }, boardX, boardY);
}

async function drawPath(page, points) {
  const clientPoints = [];
  for (const p of points) clientPoints.push(await getClientCoords(page, p.x, p.y));
  await page.evaluate(async (pts) => {
    const app = window.app;
    const ev = (c) => ({ button: 0, pointerType: 'mouse', clientX: c.clientX, clientY: c.clientY, preventDefault: () => {} });
    app.handlePointerDown(ev(pts[0]));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const steps = 4;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const cur = {
          clientX: a.clientX + (b.clientX - a.clientX) * t,
          clientY: a.clientY + (b.clientY - a.clientY) * t,
        };
        app.handlePointerMove(ev(cur));
        app.inputBufferManager?.tick();
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    app.handlePointerUp(ev(pts[pts.length - 1]));
    app.inputBufferManager?.tick();
  }, clientPoints);
  await sleep(250);
}

async function reseedRandom(page, seedValue = 12345) {
  await page.evaluate((s) => {
    let seed = s;
    Math.random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  }, seedValue);
}

/** Return tool state that leaks between cases to its default. */
async function resetToolState(page) {
  await page.evaluate(() => {
    const app = window.app;
    app?.handleBlendModeChange?.('source-over');
    app?.setPressureTargets?.(1);

    // A selection MASK is user state, not board state — exactly like the blend
    // mode above, and with exactly the same failure mode: board.clear() does
    // not touch it, so a mask left on by one case silently clipped every stroke
    // in the next one. Turn it off through the tool where possible, so the
    // drawer also broadcasts SEL_MASK(false) and the observer/replayer clear
    // too; then scrub the board's own maps as a backstop for tabs that never
    // owned the mask.
    const rt = app?.toolManager?.getTool?.('select')?.realTool;
    if (rt?.isMaskMode) rt.toggleMaskMode(false);
    const board = app?.board;
    if (board) {
      board.selectionMask = null;
      board.selectionMasksByUser?.clear?.();
      board.resetSelectionMaskClipTracking?.();

      // Same failure mode as the mask above, for mirror regions: board.clear()
      // does not touch board.mirrorRegions, so a region a case armed via
      // armMirrorRegion() would otherwise silently mirror every later case's
      // strokes too. Broadcast the removal so the observer/replayer clear
      // theirs as well, not just the drawer's own board.
      for (const region of (board.mirrorRegions || [])) {
        app?.wsClient?.broadcastMirrorRegion?.({ action: 'remove', region });
      }
      board.setMirrorRegions?.([]);
    }
  });
}

async function clearCanvas(page) {
  await page.evaluate(() => {
    const app = window.app;
    app.board?.clear?.();
    app.board?.tileTracker?.clear?.();
    app.debugOverlay?.clearAll?.();
  });
}

async function stopTickLoop(page) {
  await page.evaluate(() => window.app.inputBufferManager?.stopTickLoop?.());
}

// ─── Tab Lifecycle ─────────────────────────────────────────────────────────

async function spawnTab(browser, label, room, { joinRoom = true } = {}) {
  const page = await browser.newPage();

  page.on('console', (msg) => {
    const txt = msg.text();
    if (/\[ERROR\]|\[SYNC\]|\[Recorder\]|\[TimeMachine\]/i.test(txt)) {
      process.stdout.write(`  [${label}] ${txt}\n`);
    }
  });
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERROR] ${err.message}\n`));

  // Pin Math.random + Date.now BEFORE the document loads.
  await page.evaluateOnNewDocument(() => {
    let seed = 12345;
    Math.random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const fixedDate = new Date('2026-05-05T12:00:00Z').getTime();
    Date.now = () => fixedDate;
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app !== undefined && window.app.self != null, { timeout: 60_000 });

  if (joinRoom) {
    await page.evaluate((n, r) => {
      window.app.self.username = n;
      window.app.handleRoomSelected(r);
    }, label, room);

    await page.waitForFunction(() => {
      const app = window.app;
      const syncDone = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
      return app?.wsClient?.connected && syncDone;
    }, { timeout: 60_000 });

    await stopTickLoop(page);
  }

  return { label, page };
}

// ─── Recorder bridge (Tab A) ───────────────────────────────────────────────

async function startRecording(page) {
  await page.evaluate(() => {
    if (!window.app.recorder) throw new Error('app.recorder not present');
    window.app.recorder.start(window.app);
  });
}

async function stopRecording(page) {
  // Returns the JSON-safe bundle. The bundle's `assets` is a Map in the
  // Recorder; for transit we convert to a plain object (deltas + snapshots
  // are already JSON-friendly because we structuredClone'd them at capture).
  return page.evaluate(() => {
    const rec = window.app.recorder.stop();
    if (!rec) return null;
    return {
      version: rec.version,
      roomId: rec.roomId,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      openingSnapshot: rec.openingSnapshot,
      deltas: rec.deltas,
      intraCheckpoints: rec.intraCheckpoints,
      // Map → plain object so it survives evaluate's structured-clone serialiser.
      assets: rec.assets instanceof Map ? Object.fromEntries(rec.assets) : (rec.assets ?? {}),
    };
  });
}

// ─── Replay viewer (Tab C) ─────────────────────────────────────────────────

async function loadBundleIntoReplayer(page, bundle) {
  // Push the bundle in, then call TimeMachine.loadFromRecording. That call
  // seeks to sessionEnd as part of loading, so the replay engine's
  // layerManager is fully populated when we capture.
  await page.evaluate(async (b, noEager) => {
    if (!window.app?.TimeMachine?.loadFromRecording) {
      throw new Error('TimeMachine.loadFromRecording not present');
    }
    if (noEager) {
      // Patch the prototype so the set is empty however TimeMachine computes it.
      const mod = await import('/src/timebar/ReplayEngine.js');
      const Engine = mod.ReplayEngine ?? mod.default;
      if (Engine?.prototype) Engine.prototype.setEagerBakeUsers = function () {};
    }
    // Rehydrate the Map back from the plain object.
    const rec = { ...b, assets: new Map(Object.entries(b.assets || {})) };
    await window.app.TimeMachine.loadFromRecording(rec);
  }, bundle, NO_EAGER_BAKE);
}

// ─── Per-test run ──────────────────────────────────────────────────────────

async function runCase(tabs, testCase) {
  const t0 = Date.now();
  const { drawer, observer, replayer } = tabs;

  // Reset everyone to a clean board + deterministic RNG.
  //
  // Blend mode must be reset explicitly: it is user state, not board state, so
  // clearCanvas leaves it alone. `brush_blend_modes` ends on `screen`, and every
  // later case silently inherited it — ink/flowPen/shape_set/eraser were all
  // drawing in `screen` while claiming to test the default. They passed in
  // isolation and failed in a full run, which is a miserable thing to debug.
  await resetToolState(drawer.page);
  await resetToolState(observer.page);
  await clearCanvas(drawer.page);
  await clearCanvas(observer.page);
  await sleep(400);
  await reseedRandom(drawer.page);
  await reseedRandom(observer.page);
  await reseedRandom(replayer.page);
  await sleep(150);

  // Anything a case wants ALREADY TRUE when the tape opens goes here, before
  // startRecording. State armed in `preAction` leaves no message on the tape at
  // all, so it can only reach the replay through the opening snapshot — which
  // is exactly what a checkpoint rebuild has to live on.
  if (testCase.preAction) {
    await testCase.preAction(drawer.page);
    await sleep(PROPAGATION_MS);
  }

  // Start the tape and run the test action.
  await startRecording(drawer.page);
  await testCase.action(drawer.page);
  await sleep(PROPAGATION_MS);

  // Capture live state from both live tabs.
  const snapsA = await drawer.page.evaluate(captureLayerSnapshotsInPage);
  const snapsB = await observer.page.evaluate(captureLayerSnapshotsInPage);

  // Stop recording and ship the bundle to the replay viewer.
  const bundle = await stopRecording(drawer.page);
  if (!bundle) throw new Error('Recorder.stop() returned null');

  await loadBundleIntoReplayer(replayer.page, bundle);
  await sleep(REPLAY_SETTLE_MS);

  // Capture replay state from the dedicated viewer tab.
  const snapsC = await replayer.page.evaluate(captureReplayLayerSnapshotsInPage);

  const liveDiff = diffSnapshots(snapsA, snapsB);
  const replayDiff = diffSnapshots(snapsA, snapsC);

  // What each tab actually HOLDS, not just how well they agree.
  //
  // A match percentage cannot tell "both boards are correct" from "both boards
  // are empty" — and an A↔C of 100% is worth nothing if the case drew nothing
  // on either. It also cannot say WHICH side is wrong when they disagree. So
  // record the per-layer ink bbox and stroke count for all three tabs; a
  // masked stroke that was clipped has a visibly narrower bbox than one that
  // was not, which turns a bare percentage into a diagnosis.
  const inkOf = (snaps) => (snaps || [])
    .map((s) => `L${s.groupIdx}:${s.strokeStackLen}${s.hasBaked ? '*' : ''}`
      + (s.bbox ? `[${s.bbox.x},${s.bbox.y} ${s.bbox.w}x${s.bbox.h}]` : '[empty]'))
    .join(' ') || '(no layers with content)';
  const ink = { A: inkOf(snapsA), B: inkOf(snapsB), C: inkOf(snapsC) };

  // The mask each tab actually holds. An observer that renders NO ink for a
  // masked stroke has clipped it away entirely, which means its mask rect is
  // degenerate rather than merely late — and only the rect itself can say so.
  const maskProbe = () => {
    const b = window.app?.board;
    const src = b?.selectionMasksByUser;
    if (!src || src.size === 0) return 'none';
    return [...src.entries()].map(([uid, m]) =>
      `u${uid}:${m.x},${m.y} ${m.width}x${m.height}${m.lassoPath ? ` lasso[${m.lassoPath.length}]` : ''}`
    ).join(' | ');
  };
  const masks = {
    A: await drawer.page.evaluate(maskProbe),
    B: await observer.page.evaluate(maskProbe),
  };
  const drewSomething = (snapsA || []).some((s) => s.bbox && s.bbox.w > 0 && s.bbox.h > 0);

  // Always tear down the replay viewer's TimeMachine so the next case starts
  // clean. (loadFromRecording leaves the replay canvas visible until stop().)
  await replayer.page.evaluate(() => window.app.TimeMachine.stop?.());

  const elapsed = Date.now() - t0;
  return {
    name: testCase.name,
    elapsed,
    deltaCount: bundle.deltas.length,
    liveDiff,
    replayDiff,
    ink,
    masks,
    drewSomething,
    // A case whose action left the drawer's board blank proves nothing, and
    // would otherwise report a triumphant 100% replay match of nothing
    // against nothing.
    pass: liveDiff.pass && replayDiff.pass && drewSomething,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const roomName = `parity_${Date.now()}`;

  console.log(`\nTop Draw — Replay Parity Suite`);
  console.log(`Run:        ${RUN_ID}`);
  console.log(`URL:        ${TARGET_URL}`);
  console.log(`Room:       ${roomName}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const tabs = {};
  const results = [];

  try {
    process.stdout.write('Spawning tabs ');
    tabs.drawer   = await spawnTab(browser, 'drawer',   roomName, { joinRoom: true });   process.stdout.write('A ');
    tabs.observer = await spawnTab(browser, 'observer', roomName, { joinRoom: true });   process.stdout.write('B ');
    tabs.replayer = await spawnTab(browser, 'replayer', null,     { joinRoom: false });  process.stdout.write('C\n');

    // Wait for A and B to see each other before any test runs.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const a = await tabs.drawer.page.evaluate(() => window.app?.users?.size ?? 0);
      const b = await tabs.observer.page.evaluate(() => window.app?.users?.size ?? 0);
      if (a >= 2 && b >= 2) break;
      await sleep(250);
    }
    console.log('Live pair connected.\n');

    const cases = TEST_CASES.filter((tc) => !NAME_FILTER || NAME_FILTER.includes(tc.name));
    if (cases.length === 0) {
      console.log('No test cases match filter.');
      return;
    }

    for (const tc of cases) {
      process.stdout.write(`  ${tc.name.padEnd(28)} ... `);
      try {
        const r = await runCase(tabs, tc);
        results.push(r);
        const status = r.pass ? '✅ PASS' : '❌ FAIL';
        const live = `live ${r.liveDiff.matchPct.toFixed(2)}%`;
        const replay = `replay ${r.replayDiff.matchPct.toFixed(2)}%`;
        const deltas = `Δ ${r.deltaCount}`;
        console.log(`${status}  ${live}  ${replay}  ${deltas}  (${r.elapsed}ms)`);
        if (!r.pass) {
          if (!r.liveDiff.pass)   console.log(`     live↕  maxΔ ${r.liveDiff.maxDelta}  match ${r.liveDiff.matchPct.toFixed(3)}%`);
          if (!r.replayDiff.pass) console.log(`     replay maxΔ ${r.replayDiff.maxDelta}  match ${r.replayDiff.matchPct.toFixed(3)}%`);
          if (!r.drewSomething)   console.log('     ⚠ DREW NOTHING on the drawer — this case is vacuous, not passing');
          if (r.ink) {
            console.log(`     ink A: ${r.ink.A}`);
            console.log(`     ink B: ${r.ink.B}`);
            console.log(`     ink C: ${r.ink.C}`);
          }
          if (r.masks) {
            console.log(`     mask A: ${r.masks.A}`);
            console.log(`     mask B: ${r.masks.B}`);
          }
        }
      } catch (err) {
        console.log(`💥 ERROR: ${err.message}`);
        results.push({ name: tc.name, pass: false, error: err.message });
      }
    }

    const passed = results.filter((r) => r.pass).length;
    console.log('\n' + '─'.repeat(60));
    console.log(`RESULTS: ${passed}/${results.length} passed`);
    console.log('─'.repeat(60));

    fs.writeFileSync(
      path.join(RESULTS_DIR, 'summary.json'),
      JSON.stringify(
        {
          runId: RUN_ID,
          url: TARGET_URL,
          pixelTolerance: PIXEL_TOLERANCE,
          passPct: PASS_PCT,
          passed,
          total: results.length,
          results: results.map((r) => ({
            name: r.name,
            pass: r.pass,
            elapsed: r.elapsed,
            deltaCount: r.deltaCount,
            error: r.error,
            liveMatchPct: r.liveDiff?.matchPct,
            replayMatchPct: r.replayDiff?.matchPct,
            liveMaxDelta: r.liveDiff?.maxDelta,
            replayMaxDelta: r.replayDiff?.maxDelta,
          })),
        },
        null,
        2,
      ),
    );

    process.exitCode = passed === results.length ? 0 : 1;
  } catch (err) {
    console.error('\nFatal error:', err);
    process.exitCode = 1;
  } finally {
    for (const t of Object.values(tabs)) await t.page.close().catch(() => {});
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
