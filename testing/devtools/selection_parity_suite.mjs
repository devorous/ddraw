#!/usr/bin/env node
/**
 * @fileoverview Selection parity suite — every board-mutating Select operation,
 * checked for live parity across 3 clients AND for late-join parity.
 *
 * The Select tool is the widest surface in the app: it is the only tool that
 * lifts pixels off a layer, transforms them, and puts them back, and it does so
 * through a dozen different verbs (delete / cut / paste / clone / stamp / fill /
 * flip / merge / commit-after-move) each with its own wire message. Several of
 * those messages carry NO geometry — SEL_DELETE is literally `{t, ly}` — so the
 * receiving client rebuilds the affected region from cached SEL_PENDING /
 * SEL_LIFT state. That makes the whole family unusually easy to desync in ways
 * a single-client test can never see.
 *
 * Determinism is the point of this suite. Rather than fuzzing with k6 (which
 * finds *a* failure but not a reproducible one), every scenario drives fixed
 * client coordinates through the real pointer/tick pipeline and the real context
 * menu handlers, so a failure reproduces byte-for-byte on the next run and can be
 * bisected. Math.random is pinned per tab by spawnTab.
 *
 * Per scenario:
 *   1. Fresh room, tabs A (actor) + B, C (observers), all synced.
 *   2. A draws a fixed content pattern (and a second layer where the scenario
 *      needs one).
 *   3. A performs the selection operation.
 *   4. LIVE PARITY — A↔B and A↔C layer pixels within tolerance.
 *   5. LATE-JOIN PARITY — a 4th tab D joins afterwards and must converge to A.
 *
 * Steps 4 and 5 fail independently on purpose: live-only failures point at the
 * remote handler, join-only failures point at the strokeLog / StrokeTape / commit
 * ordering.
 *
 * Usage:
 *   node testing/devtools/selection_parity_suite.mjs
 *   node testing/devtools/selection_parity_suite.mjs --headed --only=delete_rect,move_commit
 *   node testing/devtools/selection_parity_suite.mjs --no-join      (skip late-join phase)
 *   node testing/devtools/selection_parity_suite.mjs --list
 *
 * Requires `npm run dev` running (vite :3000, ws server :8030).
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PIXEL_TOLERANCE, PASS_PCT,
  captureLayerSnapshotsInPage,
  diffSnapshots,
  generateDiffPngInPage,
} from '../lib/layerDiff.mjs';
import { loadTape, compareTapes, formatReport, joinVerdict } from '../lib/tapeDiff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
let   HEADLESS   = process.env.HEADLESS !== 'false';
let   ONLY       = null;
let   DO_JOIN    = true;
let   LIST_ONLY  = false;

for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a === '--no-join') DO_JOIN = false;
  else if (a === '--list') LIST_ONLY = true;
  else if (a.startsWith('--only=')) ONLY = a.slice(7).split(',').map((s) => s.trim());
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

// A fixed viewport keeps client→board coordinate mapping identical between runs,
// which is what makes the scenarios reproducible rather than merely repeatable.
const VIEWPORT = { width: 1280, height: 800 };
const CODEC_URL = '/shared/ddrawCodec.js';

const RUN_ID      = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `selparity_${RUN_ID}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fixed geometry (client coords) ──────────────────────────────────────────
// Content sits well inside the viewport so no selection or move destination can
// clip against a board edge — an edge clip would look like a desync.
const CONTENT = {
  strokes: [
    { y: 200, color: [220, 40, 40, 1] },
    { y: 300, color: [40, 160, 220, 1] },
    { y: 400, color: [40, 190, 90, 1] },
  ],
  x0: 220, x1: 580, size: 18,
};
const SEL_FULL  = { x0: 200, y0: 150, x1: 600, y1: 450 };  // covers all three strokes
const SEL_LEFT  = { x0: 200, y0: 150, x1: 400, y1: 450 };  // covers their left half
const MOVE_TO   = { dx: 300, dy: 120 };
// Clear of the content strokes (x 220–580, y 200/300/400) so anything with alpha
// inside it came from the scenario itself. The fill-then-clear scenarios need
// that: their residue is measured as "any alpha at all", not as a colour.
const SEL_BLANK = { x0: 660, y0: 440, x1: 840, y1: 580 };
// Far from every content colour at countInk's tolerance, so a surviving rim of
// it cannot be mistaken for the artwork underneath.
const FILL_PROBE = { color: [255, 0, 255, 1] };

// Probe strokes for the MASK scenarios. Both run along y-bands that sit between
// the content strokes (y=200/300/400, size 18 → ±9px) so the probe's ink is the
// only thing of its colour on the board and can be counted unambiguously. Each
// starts inside SEL_LEFT and ends well outside it, so a working mask cuts the
// stroke in half at x=400 and a broken one lets the whole thing through.
const MASK_PROBE  = { y: 260, x0: 240, x1: 560, size: 22, color: [255, 140, 0, 1] };
const AFTER_PROBE = { y: 340, x0: 240, x1: 560, size: 22, color: [0, 200, 255, 1] };

// ─── In-page helpers ─────────────────────────────────────────────────────────

/** Plain object matching what App's pointer handlers read off a PointerEvent. */
function evLiteral() {
  return `((x, y, extra) => Object.assign({
    button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1,
    offsetX: x, offsetY: y, clientX: x, clientY: y, pressure: 0.5,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {}
  }, extra || {}))`;
}

/**
 * Drive a pointer gesture through the real App handlers, ticking the input
 * buffer between samples. The tick + settle at each step is deliberate: driving
 * faster than the 60 TPS loop merges or drops samples and makes the committed
 * board nondeterministic.
 */
async function gesture(page, points, { settle = 18 } = {}) {
  await page.evaluate(async (pts, settleMs, evSrc) => {
    const app = window.app;
    const ev = eval(evSrc);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.handlePointerDown(ev(pts[0][0], pts[0][1]));
    app.inputBufferManager.tick();
    await nap(settleMs);
    for (let i = 1; i < pts.length; i++) {
      app.handlePointerMove(ev(pts[i][0], pts[i][1]));
      app.inputBufferManager.tick();
      await nap(settleMs);
    }
    const last = pts[pts.length - 1];
    app.handlePointerUp(ev(last[0], last[1]));
    app.inputBufferManager.tick();
    await nap(settleMs * 2);
  }, points, settle, evLiteral());
}

/** Draw the fixed content pattern on the given layer. */
async function drawContent(page, layer = 0, strokes = CONTENT.strokes) {
  await page.evaluate(async (layerIdx, strokeDefs, x0, x1, size, evSrc) => {
    const app = window.app;
    const ev = eval(evSrc);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    if (app.self.activeLayer !== layerIdx) app.handleLayerSelect(layerIdx);
    await nap(60);
    app.selectTool('brush');
    app.handleSizeChange({ target: { value: size } });
    await nap(40);
    for (const s of strokeDefs) {
      app.handleColorInputChange(s.color);
      await nap(30);
      app.handlePointerDown(ev(x0, s.y));       app.inputBufferManager.tick(); await nap(18);
      app.handlePointerMove(ev((x0 + x1) / 2, s.y)); app.inputBufferManager.tick(); await nap(18);
      app.handlePointerMove(ev(x1, s.y));       app.inputBufferManager.tick(); await nap(18);
      app.handlePointerUp(ev(x1, s.y));         app.inputBufferManager.tick(); await nap(40);
    }
  }, layer, strokes, CONTENT.x0, CONTENT.x1, CONTENT.size, evLiteral());
}

/** Put the select tool in a known mode and clear any stale selection. */
async function armSelect(page, mode = 'rect', opts = {}) {
  await page.evaluate(async (m, o) => {
    const app = window.app;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.selectTool('select');
    await nap(400);                       // SelectToolLoader loads the real tool lazily
    const rt = app.toolManager.getTool('select').realTool;
    rt.cancelSelection?.();
    rt.setMode(m);                        // default mode is 'lasso'; be explicit
    rt.toggleCopyAllLayers(!!o.allLayers);
    if (o.fitToContent !== undefined) rt.toggleFitToContent(!!o.fitToContent);
    await nap(80);
  }, mode, opts);
}

/** Rectangle selection by dragging corner to corner. */
async function selectRect(page, r) {
  await gesture(page, [[r.x0, r.y0], [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2], [r.x1, r.y1]]);
  await sleep(250);
}

/** Lasso selection around a rectangle's outline (a real closed polygon). */
async function selectLasso(page, r) {
  const pts = [
    [r.x0, r.y0], [(r.x0 + r.x1) / 2, r.y0], [r.x1, r.y0],
    [r.x1, (r.y0 + r.y1) / 2], [r.x1, r.y1],
    [(r.x0 + r.x1) / 2, r.y1], [r.x0, r.y1],
    [r.x0, (r.y0 + r.y1) / 2], [r.x0, r.y0],
  ];
  await gesture(page, pts);
  await sleep(250);
}

/** Drag from inside the selection to move it (lifts to a floating selection). */
async function moveSelection(page, from, dx, dy) {
  await gesture(page, [
    [from[0], from[1]],
    [from[0] + dx * 0.5, from[1] + dy * 0.5],
    [from[0] + dx, from[1] + dy],
  ]);
  await sleep(300);
}

/** Invoke a context-menu verb exactly as its click handler does. */
async function menu(page, verb, arg) {
  return page.evaluate(async (v, a) => {
    const app = window.app;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const rt = app.toolManager.getTool('select').realTool;
    if (typeof rt[v] !== 'function') return { ok: false, missing: v };
    const out = a === undefined ? rt[v]() : rt[v](a);
    const res = out && typeof out.then === 'function' ? await out : out;
    app.inputBufferManager.tick();
    await nap(250);
    return { ok: true, result: res === undefined ? null : (typeof res === 'object' ? '[obj]' : res) };
  }, verb, arg);
}

/**
 * End a selection the way most users actually do: by picking another tool.
 *
 * This is a genuinely different code path from the Apply/deselect menu verbs
 * every other scenario uses. Here the commit comes from SelectTool.deactivate()
 * inside App.selectTool(), and the CT broadcast rides the same drain — so it is
 * the only scenario that exercises the CT-vs-SEL_COMMIT wire ordering. When CT
 * was queued first, remotes saw a tool change away from 'select', cancelled the
 * floating selection (DrawingHandlers 'ct' -> handleSelectionCancel) and then
 * dropped the SEL_COMMIT that followed, reverting the stamp on every peer while
 * the drawer kept it.
 */
async function switchTool(page, tool) {
  await page.evaluate(async (t) => {
    const app = window.app;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.selectTool(t);                    // the exact call the tool buttons make
    app.inputBufferManager.tick();
    await nap(300);
  }, tool);
  await sleep(250);
}

async function setColor(page, color) {
  await page.evaluate(async (c) => {
    window.app.handleColorInputChange(c);
    await new Promise((r) => setTimeout(r, 60));
  }, color);
}

async function snap(page) { return page.evaluate(captureLayerSnapshotsInPage); }

// ─── Mask helpers ────────────────────────────────────────────────────────────
// A selection MASK is the one Select feature that outlives the Select tool:
// SelectTool.deactivate() deliberately hands a non-floating mask to the Board so
// the user can pick up the brush and draw inside it. That makes it the only
// selection verb whose effect is measured on OTHER tools' strokes, which is why
// it needs its own probe rather than riding on the pixel diff alone — if masking
// broke everywhere at once, three clients would agree perfectly on an unclipped
// board and the parity diff would go green.

/** Turn on mask mode for the current selection and record its board rect. */
async function enableMask(page) {
  const rect = await page.evaluate(async () => {
    const app = window.app;
    const rt = app.toolManager.getTool('select').realTool;
    rt.toggleMaskMode(true);
    app.inputBufferManager.tick();
    await new Promise((r) => setTimeout(r, 300));
    const m = app.board.selectionMask;
    window.__maskRect = m ? { x: m.x, y: m.y, width: m.width, height: m.height } : null;
    return window.__maskRect;
  });
  await sleep(200);
  return rect;
}

/** Draw one straight brush stroke through the real pointer/tick pipeline. */
async function brushStroke(page, spec) {
  await page.evaluate(async (s, evSrc) => {
    const app = window.app;
    const ev = eval(evSrc);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.selectTool('brush');
    app.handleSizeChange({ target: { value: s.size } });
    app.handleColorInputChange(s.color);
    await nap(80);
    app.handlePointerDown(ev(s.x0, s.y));                 app.inputBufferManager.tick(); await nap(18);
    app.handlePointerMove(ev((s.x0 + s.x1) / 2, s.y));    app.inputBufferManager.tick(); await nap(18);
    app.handlePointerMove(ev(s.x1, s.y));                 app.inputBufferManager.tick(); await nap(18);
    app.handlePointerUp(ev(s.x1, s.y));                   app.inputBufferManager.tick(); await nap(60);
  }, spec, evLiteral());
  await sleep(300);
}

/**
 * Draw one stroke and turn the mask OFF while it is still open.
 *
 * This is the only way to reach the unwind path: the clip's save() has already
 * happened at MD and its restore() has not. clearSelectionMask used to drop the
 * ledger entry without restoring, which left the stroke's context clipped for
 * the rest of its life — so the mask "turned off" but the second half of the
 * stroke still hit an invisible wall at the old mask edge.
 */
async function brushStrokeClearingMaskMidway(page, spec) {
  await page.evaluate(async (s, evSrc) => {
    const app = window.app;
    const ev = eval(evSrc);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.selectTool('brush');
    app.handleSizeChange({ target: { value: s.size } });
    app.handleColorInputChange(s.color);
    await nap(80);
    app.handlePointerDown(ev(s.x0, s.y));        app.inputBufferManager.tick(); await nap(18);
    app.handlePointerMove(ev(s.x0 + 60, s.y));   app.inputBufferManager.tick(); await nap(18);
    app.toolManager.getTool('select').realTool.toggleMaskMode(false);
    app.inputBufferManager.tick();               await nap(80);
    app.handlePointerMove(ev((s.x0 + s.x1) / 2, s.y)); app.inputBufferManager.tick(); await nap(18);
    app.handlePointerMove(ev(s.x1, s.y));        app.inputBufferManager.tick(); await nap(18);
    app.handlePointerUp(ev(s.x1, s.y));          app.inputBufferManager.tick(); await nap(60);
  }, spec, evLiteral());
  await sleep(300);
}

/**
 * Count committed pixels of `color` on layer 0, split by which side of the
 * mask's right edge they fell on.
 *
 * Resolves the mask rect from `window.__maskRect` (set on the actor by
 * enableMask) or, failing that, from `board.selectionMasksByUser` — which is
 * what an OBSERVER or a late joiner holds. On those tabs an empty map is itself
 * the finding: the mask never arrived over the wire.
 */
function probeMaskInkInPage(color, tol, slack, rectOverride, limitToMirrorAxis) {
  const app = window.app;
  const lm = app?.board?.layerManager;
  if (!lm) return { error: 'no layerManager' };
  let rect = rectOverride || window.__maskRect || null;
  let source = rectOverride ? 'given' : 'local';
  if (!rect) {
    const first = app.board.selectionMasksByUser?.values?.().next?.();
    if (first && !first.done && first.value) {
      const m = first.value;
      rect = { x: m.x, y: m.y, width: m.width, height: m.height };
      source = 'synced';
    }
  }
  if (!rect) return { error: 'no mask rect — board.selectionMasksByUser is empty on this tab' };

  const cvs = document.createElement('canvas');
  cvs.width = lm.width;
  cvs.height = lm.height;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  // Same call the product's compositor makes — see layerDiff's note on why the
  // harness must never hand-roll this.
  const prevNeedsComposite = lm.needsComposite;
  lm.compositeLayerRange(ctx, 0, 1, null, null);
  lm.needsComposite = prevNeedsComposite;

  const d = ctx.getImageData(0, 0, cvs.width, cvs.height).data;
  const edge = Math.round(rect.x + rect.width) + slack;
  // With a full-board vertical mirror, EVERY masked pixel legitimately has a
  // reflection right of the axis — that is what assertMaskedStrokeMirrored
  // demands. Counting those as "leaked past the mask edge" makes the two
  // assertions contradictory and the scenario unpassable by construction, and
  // it also swept up the mirrored copies of the pre-existing content strokes
  // (same probe colour), which is why the reported rightmost ink sat at the
  // board's far edge rather than anywhere near the mask.
  //
  // A leak is ink between the mask edge and the mirror axis: unmasked
  // territory on the drawn side. Beyond the axis is reflection territory and
  // belongs to the other assertion.
  const limitX = limitToMirrorAxis ? Math.floor(cvs.width / 2) : cvs.width;
  let inside = 0, outside = 0, maxX = -1;
  for (let y = 0; y < cvs.height; y++) {
    const row = y * cvs.width * 4;
    for (let x = 0; x < cvs.width; x++) {
      const i = row + x * 4;
      if (d[i + 3] <= 24) continue;
      if (Math.abs(d[i] - color[0]) > tol) continue;
      if (Math.abs(d[i + 1] - color[1]) > tol) continue;
      if (Math.abs(d[i + 2] - color[2]) > tol) continue;
      if (x <= edge) { inside++; if (x > maxX) maxX = x; continue; }
      if (x > limitX) continue;   // reflection territory, not a leak
      if (x > maxX) maxX = x;
      outside++;
    }
  }
  return { inside, outside, edge, maxX, rect, source, limitX };
}

async function probeMaskInk(page, color, rect = null, limitToMirrorAxis = false) {
  return page.evaluate(probeMaskInkInPage, color, 40, 3, rect, limitToMirrorAxis);
}

/**
 * Assert the probe stroke was clipped at the mask edge on this tab.
 * @returns {Promise<string[]>} failure lines (empty = pass)
 */
async function assertMaskClipped(page, label, rect = null, color = MASK_PROBE.color,
                                 limitToMirrorAxis = false) {
  const p = await probeMaskInk(page, color, rect, limitToMirrorAxis);
  if (p.error) return [`[${label}] mask probe: ${p.error}`];
  const fails = [];
  // Guards against a vacuous pass: a stroke that never drew at all is clipped
  // by definition.
  if (p.inside < 300) {
    fails.push(`[${label}] mask probe: only ${p.inside}px of the probe stroke landed INSIDE `
      + `the mask — the stroke never drew, so "clipped" proves nothing`);
  }
  if (p.outside > 60) {
    fails.push(`[${label}] MASK NOT CLIPPING: ${p.outside}px of the probe stroke landed right of `
      + `the mask edge (x>${p.edge}, rightmost ink at x=${p.maxX}, rect from ${p.source})`);
  }
  return fails;
}

/** Assert the probe stroke was NOT clipped — used after the mask is turned off. */
async function assertMaskNotClipping(page, label, color, rect) {
  const p = await probeMaskInk(page, color, rect);
  if (p.error) return [`[${label}] post-mask probe: ${p.error}`];
  if (p.outside < 300) {
    return [`[${label}] STALE MASK CLIP: the mask is off, but only ${p.outside}px of this stroke `
      + `landed right of the old mask edge (x>${p.edge}, rightmost ink at x=${p.maxX}) — a clip `
      + `leaked onto the pooled stroke canvas`];
  }
  return [];
}

/** Compact per-tab state used to detect convergence and to explain failures. */
function stateInPage() {
  const app = window.app;
  const lm = app?.board?.layerManager;
  const log = app?.wsClient?.strokeLog;
  const summary = log?.getSummary?.() ?? { count: 0, latestSeq: 0, rollingHash: 0 };
  let totalStack = 0;
  const seqZero = [];
  for (const g of (lm?.layerGroups || [])) {
    totalStack += g.strokeStack.length;
    for (const s of g.strokeStack) {
      if (!s.seq) seqZero.push({ u: s.userId, bm: s.blendMode, w: s.width, h: s.height });
    }
  }
  // Per-layer ink + stroke shape. Pixel-diff percentages say two clients
  // disagree but not how; this says WHICH layer holds what, which separates
  // "content landed on the wrong layer" from "content rendered differently".
  const perLayer = (lm?.layerGroups || []).map((g, i) => {
    const stack = g.strokeStack.map((s) => ({
      u: s.userId, seq: s.seq || 0, bm: s.blendMode,
      w: s.width, h: s.height,
      // Undo batches by timestamp (undoLastStrokeGlobal picks the latest), so
      // when a tape-clean scenario still diverges on a joiner the timestamps are
      // the thing to look at: a lift-erase and its commit-stamp that tie, or
      // land in the wrong order, make one Ctrl+Z reverse the wrong half.
      ts: s.timestamp || 0,
      restore: !!s.selectionRestoreData,
      merge: !!s.isSelectionMerge, selErase: !!s.isSelectionErase,
    }));
    return { layer: i, strokes: stack.length, baked: !!g.flatCanvas, stack };
  });

  return {
    sessionIndex: app?.sessionIndex,
    mirror: !!app?.board?.mirror,
    logCount: summary.count,
    latestSeq: summary.latestSeq,
    rollingHash: summary.rollingHash >>> 0,
    totalStack,
    perLayer,
    // A committed stroke still sitting at seq 0 sorts to the TOP of the stack;
    // for a destination-out selection erase that is the "permanent white hole"
    // signature, so surface it even when the pixels happen to agree.
    seqZeroStrokes: seqZero,
  };
}
async function getState(page) { return page.evaluate(stateInPage); }

/** Wait until every tab agrees on commit history, stable across two reads. */
async function waitConverged(tabs, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const sig = (s) => `${s.logCount}|${s.rollingHash}|${s.totalStack}`;
  let prev = null, last = null;
  while (Date.now() < deadline) {
    await sleep(400);
    const states = await Promise.all(tabs.map((t) => getState(t.page)));
    last = states;
    const sigs = states.map(sig);
    const agree = sigs.every((x) => x === sigs[0]);
    if (agree && prev === sigs[0]) return { states, converged: true };
    prev = agree ? sigs[0] : null;
  }
  return { states: last, converged: false };
}

// ─── Recorder bridge ─────────────────────────────────────────────────────────
// The wire-level oracle (testing/lib/tapeDiff.mjs). For SELECTION verbs it is
// complementary to the pixel diff, not a replacement — several bugs in the
// original sweep (merge erasing nothing, expandDirtyRect on the wrong layer)
// delivered a perfectly correct message that the HANDLER then mishandled: tape
// clean, pixels red. But the reverse class — a field the sanitizer strips, a
// verb the server never relays — is invisible to pixels until it has already
// corrupted the board, and the tape names it exactly.
async function startRecording(page) {
  await page.evaluate(() => {
    if (!window.app?.recorder) return;
    // A recorder that hits its max length auto-stops and then stop() returns
    // null, losing the tape with no error.
    window.app.recorder.configure?.({ maxLengthMs: 0 });
    window.app.recorder.start(window.app);
  });
}

/** Stop the recorder and encode the bundle to .ddraw bytes (base64) in-page. */
async function stopAndEncode(page) {
  return page.evaluate(async (url) => {
    const rec = window.app?.recorder?.stop?.();
    if (!rec) return null;
    const { encodeDdraw } = await import(url);
    const blob = await encodeDdraw(rec);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return { b64: btoa(bin), size: buf.length, deltas: rec.deltas?.length ?? 0 };
  }, CODEC_URL);
}

// ─── Tab lifecycle ───────────────────────────────────────────────────────────
async function spawnTab(browser, label, room, { recordFromJoin = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on('pageerror', (err) => {
    process.stderr.write(`  [${label} PAGEERROR] ${err.message}\n`);
    pageErrors.push({ label, message: err.message });
  });
  page.on('console', (msg) => {
    const t = msg.text();
    if (/is not a function|TypeError|desync|\[ERROR\]/i.test(t)) {
      process.stdout.write(`  [${label}] ${t}\n`);
      pageErrors.push({ label, message: t });
    }
  });

  // Pin Math.random for render determinism (confetti/pattern jitter). Date.now
  // must stay real — commit timestamps order the strokeStack.
  await page.evaluateOnNewDocument(() => {
    let seed = 0x2545f491;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  // Arm BEFORE joining so the tape captures the whole sync serve — the
  // checkpoint + command tail is exactly what a join-only failure is about.
  if (recordFromJoin) await startRecording(page);

  await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, label, room);
  await page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done && app?.sessionIndex != null;
  }, { timeout: 60_000 });

  // Joining via handleRoomSelected() skips the landing page's own click handler,
  // so the overlay stays flagged visible — and KeyboardHandler.handleKeyDown
  // returns early on `app.landingPage?.isVisible`. Without this every keyboard
  // scenario silently does nothing and looks like a product bug.
  await page.evaluate(() => window.app?.landingPage?.hide?.());
  await page.waitForFunction(() => !window.app?.landingPage?.isVisible, { timeout: 10_000 });

  return { label, page };
}

let pageErrors = [];

// ─── Mirror setup helpers ────────────────────────────────────────────────────

/**
 * Creates one shared mirror region, straight through the same board + broadcast
 * pair MirrorRegionController.apply() uses.
 *
 * Regions rather than the full-board mirror on purpose. T.MIR is permission-
 * gated (server/permissions.js Action.TOGGLE_MIRROR: room ADMIN(5)+ / global
 * HOLY(8)+) and every tab here is an anonymous guest in an ad-hoc room, so a
 * `board.toggleMirror() + broadcastMirror()` fixture is REFUSED — the server
 * answers with the authoritative SETTINGS and the mirror silently stays off,
 * leaving the scenario green because all four tabs agree on an unmirrored
 * board. (That is exactly what happened to the original `delete_mirrored`
 * fixture the moment the gate landed.) MIRROR_REGION is not gated, reaches late
 * joiners through SETTINGS, and drives the identical code path: a full-board
 * `vertical` region is geometrically the same transform as the global mirror.
 *
 * Region geometry is built from CLIENT coords converted in-page — the scenarios'
 * selection rectangles are client coords too, and board coords differ by the
 * viewport's pan/zoom, so a hard-coded board rect would drift off the content.
 *
 * @param {string} mode - vertical | horizontal | quad | rotational | radial | fib
 * @param {Object} [opts]
 * @param {boolean} [opts.fullBoard] - Span the whole board (global-mirror equivalent).
 * @param {Object} [opts.extra] - Mode options, e.g. `{ slices: 5 }` for radial.
 */
async function addMirrorRegion(page, mode, { fullBoard = false, extra = {} } = {}) {
  await page.evaluate(async (mode, fullBoard, extra) => {
    const app = window.app;
    let box;
    if (fullBoard) {
      box = { x: 0, y: 0, width: app.board.getWidth(), height: app.board.getHeight() };
    } else {
      const tl = app.board.getBoardRelativePos(180, 130);
      const br = app.board.getBoardRelativePos(620, 570);
      // Square: the region editor authors every non-fib mode square, and radial
      // in particular is only symmetric about a square's centre.
      const size = Math.round(Math.min(br.x - tl.x, br.y - tl.y));
      box = { x: Math.round(tl.x), y: Math.round(tl.y), width: size, height: size };
    }
    const region = {
      id: 'mr_selparity_fixture',
      ...box,
      mode,
      axis: mode,
      showLine: true,
      owner: app.self?.id || null,
      ...extra,
    };
    app.board.setMirrorRegions([...(app.board.mirrorRegions || []), region]);
    app.wsClient.broadcastMirrorRegion({ action: 'create', region });
    await new Promise((r) => setTimeout(r, 400));
  }, mode, fullBoard, extra);
}

/** Full-board vertical region — the global mirror's geometry, without the gate. */
const mirrorWholeBoard = (page) => addMirrorRegion(page, 'vertical', { fullBoard: true });

/**
 * Board-space SEL_LEFT and its vertical reflection about the board centre.
 *
 * The reflection is computed here from first principles rather than by calling
 * Board.getSelectionMirrorTargets, so the assertion does not depend on the code
 * it exists to check.
 */
async function mirroredSelectionRects(page) {
  return page.evaluate((sel) => {
    const b = window.app.board;
    const tl = b.getBoardRelativePos(sel.x0, sel.y0);
    const br = b.getBoardRelativePos(sel.x1, sel.y1);
    const rect = {
      x: Math.round(tl.x), y: Math.round(tl.y),
      width: Math.round(br.x - tl.x), height: Math.round(br.y - tl.y),
    };
    return {
      rect,
      mirror: { x: b.getWidth() - rect.x - rect.width, y: rect.y, width: rect.width, height: rect.height },
    };
  }, SEL_LEFT);
}

/** Counts opaque pixels within `tol` of `color` inside a board-space rect. */
async function countInk(page, rect, color, tol = 48) {
  return page.evaluate((rect, color, tol) => {
    const b = window.app.board;
    const d = b.withFullRaster(
      (canvas) => canvas.getContext('2d').getImageData(rect.x, rect.y, rect.width, rect.height).data,
      { background: false }
    );
    if (!d) return -1;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      if (Math.abs(d[i] - color[0]) <= tol
        && Math.abs(d[i + 1] - color[1]) <= tol
        && Math.abs(d[i + 2] - color[2]) <= tol) n++;
    }
    return n;
  }, rect, color, tol);
}

/** Counts pixels with any meaningful alpha inside a board-space rect. */
// Both ink probes read a FRESH FULL-BOARD COMPOSITE, never `board.viewCtx`.
//
// viewCanvas is a windowed, viewport-culled surface: Board.js says outright
// "Call before ANY full-board read of viewCanvas", and once surfaces are
// windowed `ensureFullComposite()` is a no-op because the surface physically
// cannot hold the whole board. Reading it with BOARD coordinates therefore
// sampled whatever the display happened to be holding — stale content outside
// the viewport, offset by the window origin. That is what made
// fill_lasso_then_clear report ~115k pixels of leftover alpha over an area the
// fill never covered, and what made colour probes come back 0 and pass
// vacuously.
//
// `background: false` is required, not cosmetic: with the room background
// painted, every pixel is opaque and an alpha probe counts the whole rect.
async function countAnyInk(page, rect, minAlpha = 8) {
  return page.evaluate((rect, minAlpha) => {
    const b = window.app.board;
    const d = b.withFullRaster(
      (canvas) => canvas.getContext('2d').getImageData(rect.x, rect.y, rect.width, rect.height).data,
      { background: false }
    );
    if (!d) return -1;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] >= minAlpha) n++;
    return n;
  }, rect, minAlpha);
}

/** Client-space scenario rect → board space, optionally grown by `pad` board px. */
async function boardRect(page, r, pad = 0) {
  return page.evaluate((r, pad) => {
    const b = window.app.board;
    const tl = b.getBoardRelativePos(r.x0, r.y0);
    const br = b.getBoardRelativePos(r.x1, r.y1);
    const x = Math.max(0, Math.round(tl.x) - pad);
    const y = Math.max(0, Math.round(tl.y) - pad);
    return {
      x, y,
      width: Math.min(b.getWidth() - x, Math.round(br.x - tl.x) + pad * 2),
      height: Math.min(b.getHeight() - y, Math.round(br.y - tl.y) + pad * 2),
    };
  }, r, pad);
}

/**
 * Records how much of the fill actually landed, before the clear/move wipes the
 * evidence. Only the actor runs `run()`, so only the actor gets the stash — the
 * observers' asserts skip the guard and check the residue alone.
 */
async function stashFillProbe(page, clientRect, color) {
  const n = await countInk(page, await boardRect(page, clientRect), color);
  await page.evaluate((v) => { window.__fillProbe = v; }, n);
}

/**
 * Asserts a Fill followed by a Clear left none of the fill behind.
 *
 * Clear/Cut/Move are pinned to `SelectTool.selection`, and a fill can paint
 * OUTSIDE it two ways: fit-to-content crops the displayed box while Fill
 * deliberately paints the full dragged rect, and a lasso fill paints the path
 * rather than the box. Either leaves a rim of fill colour the clear never
 * reaches.
 *
 * `window.__fillProbe` (stashed by the scenario on the actor, right after the
 * fill) guards the guard: without it a fill that silently did nothing would
 * make "no fill survived" trivially true.
 */
async function assertFillFullyCleared(page, label, clientRect, color) {
  const fails = [];
  const filled = await page.evaluate(() => window.__fillProbe ?? null);
  if (filled !== null && filled < 2000) {
    fails.push(`[${label}] fill probe: only ${filled}px of the fill landed before the clear — `
      + `the fill never happened, so "nothing survived" proves nothing`);
  }
  const left = await countInk(page, await boardRect(page, clientRect, 16), color);
  if (left > 0) {
    fails.push(`[${label}] FILL SURVIVED THE CLEAR: ${left}px of the fill colour `
      + `${color.slice(0, 3)} are still on the board inside the selection`);
  }
  return fails;
}

/**
 * Asserts a fill-then-clear over EMPTY board left the board empty again.
 *
 * The strict form of the check above, for the antialiased rim specifically: a
 * `destination-out` erase of an antialiased shape only subtracts a·(1−a) of
 * each edge pixel, so up to a quarter of the fill's own edge survives. That
 * residue is far too faint for a colour probe (it reads as a light tint of
 * whatever is under it) and too thin for the pixel-diff's neighbour slack — but
 * over blank board it is the ONLY thing with alpha, so counting alpha finds it
 * exactly. See utils/eraseMask.js.
 */
async function assertBoardBlankAgain(page, label, clientRect) {
  const fails = [];
  const filled = await page.evaluate(() => window.__fillProbe ?? null);
  if (filled !== null && filled < 2000) {
    fails.push(`[${label}] fill probe: only ${filled}px of the fill landed before the clear — `
      + `the fill never happened, so "nothing survived" proves nothing`);
  }
  const left = await countAnyInk(page, await boardRect(page, clientRect, 16));
  if (left > 0) {
    fails.push(`[${label}] ERASE LEFT A RIM: ${left}px still have alpha where the board was `
      + `blank before the fill — the antialiased edge of the fill outlived the clear`);
  }
  return fails;
}

/**
 * Asserts the reflected copy of a fill actually exists on THIS tab.
 *
 * Cross-tab pixel parity alone cannot catch a mirror regression: if neither the
 * drawer nor the receivers mirror, all four tabs agree perfectly on an
 * unmirrored board and the scenario goes green. Every mirror scenario therefore
 * asserts the reflected pixels are present (or gone, for a clear) on each tab
 * independently, exactly like the MASK scenarios do for clipping.
 */
async function assertMirroredFill(page, label, ctx, color) {
  const { rect, mirror } = ctx.rects;
  const here = await countInk(page, rect, color);
  const there = await countInk(page, mirror, color);
  const fails = [];
  // Guards the guard: a fill that never happened is trivially "not mirrored".
  if (here < 2000) {
    fails.push(`[${label}] mirror probe: only ${here}px of the fill landed in the selection `
      + `itself — the fill never happened, so its reflection proves nothing`);
  } else if (there < here * 0.5) {
    fails.push(`[${label}] FILL NOT MIRRORED: ${here}px filled at the selection but only `
      + `${there}px in its reflection (${JSON.stringify(mirror)})`);
  }
  return fails;
}

/**
 * Asserts a stroke drawn under a selection MASK still produced its mirrored
 * copies on THIS tab.
 *
 * Mask mode clips the stroke context once at MD time and the mirror-aware tools
 * then draw their reflected copies into that same clipped context — so a clip
 * covering only the mask itself throws every reflection away, and drawing inside
 * a mask silently stops mirroring. See Board.clipToMaskAndMirrors.
 */
async function assertMaskedStrokeMirrored(page, label, ctx, color = MASK_PROBE.color) {
  const { rect, mirror } = ctx.rects;
  const here = await countInk(page, rect, color);
  const there = await countInk(page, mirror, color);
  const fails = [];
  if (here < 300) {
    fails.push(`[${label}] masked mirror probe: only ${here}px of the probe stroke landed inside `
      + `the mask — the stroke never drew, so its reflection proves nothing`);
  } else if (there < here * 0.5) {
    fails.push(`[${label}] MASKED STROKE NOT MIRRORED: ${here}px inside the mask but only `
      + `${there}px in its reflection (${JSON.stringify(mirror)}) — the mask clip is `
      + `swallowing the mirrored copies`);
  }
  return fails;
}

/** Asserts the reflected copy of a cleared area really was cleared on THIS tab. */
async function assertMirroredClear(page, label, ctx) {
  const { rect, mirror } = ctx.rects;
  const fails = [];
  for (const color of CONTENT.strokes.map((s) => s.color)) {
    const here = await countInk(page, rect, color);
    const there = await countInk(page, mirror, color);
    if (here > 200) {
      fails.push(`[${label}] clear probe: ${here}px of content colour ${color.slice(0, 3)} `
        + `survived inside the selection — the clear itself did not happen`);
    }
    if (there > 200) {
      fails.push(`[${label}] CLEAR NOT MIRRORED: ${there}px of content colour ${color.slice(0, 3)} `
        + `left in the reflection (${JSON.stringify(mirror)})`);
    }
  }
  return fails;
}

// ─── Scenarios ───────────────────────────────────────────────────────────────
// Each `run(A)` performs the operation on tab A. Content is drawn beforehand
// per `layers`. Keep every scenario's geometry fixed — no randomness.
const SCENARIOS = [
  {
    name: 'delete_rect',
    desc: 'rect-select over content, Clear',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
    },
  },
  {
    name: 'delete_lasso',
    desc: 'lasso-select over content, Clear',
    async run(page) {
      await armSelect(page, 'lasso');
      await selectLasso(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
    },
  },
  {
    name: 'delete_key',
    desc: 'rect-select, real Delete keypress (loader proxy path)',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await page.evaluate(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete', code: 'Delete', keyCode: 46, which: 46, bubbles: true, cancelable: true,
        }));
        window.app.inputBufferManager.tick();
        await new Promise((r) => setTimeout(r, 300));
      });
    },
  },
  {
    name: 'move_commit',
    desc: 'rect-select, drag to a new spot, Apply (commit)',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'move_commit_toolswitch',
    desc: 'rect-select, drag, then pick the brush — deactivate() commits, no Apply click',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await switchTool(page, 'brush');
    },
  },
  {
    name: 'paste_commit_toolswitch',
    desc: 'copy/paste, then pick the brush — the pasted stamp must survive on peers',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'cut');
      await sleep(300);
      await menu(page, 'paste');
      await sleep(400);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await switchTool(page, 'brush');
    },
  },
  {
    name: 'move_cancel',
    expectRestore: true,
    desc: 'rect-select, drag, Cancel — content must return to origin',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'cancelSelection');
    },
  },
  {
    name: 'lasso_move_commit',
    desc: 'lasso-select, drag, Apply',
    async run(page) {
      await armSelect(page, 'lasso');
      await selectLasso(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'cut_paste',
    desc: 'rect-select, Cut, Paste, move the pasted float, Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'cut');
      await sleep(300);
      await menu(page, 'paste');
      await sleep(400);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'clone_commit',
    desc: 'rect-select, Clone, move the duplicate, Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'clone');
      await sleep(400);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'fill',
    desc: 'rect-select, Fill with a solid colour',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await setColor(page, [128, 0, 200, 1]);
      await menu(page, 'fillSelection');
    },
  },
  {
    name: 'fill_lasso',
    desc: 'lasso-select, Fill (lasso-masked fill)',
    async run(page) {
      await armSelect(page, 'lasso');
      await selectLasso(page, SEL_LEFT);
      await setColor(page, [200, 120, 0, 1]);
      await menu(page, 'fillSelection');
    },
  },
  {
    name: 'fill_then_clear',
    desc: 'rect-select over content, Fill, then Clear — no fill may outlive the clear',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await setColor(page, FILL_PROBE.color);
      await menu(page, 'fillSelection');
      await sleep(300);
      await stashFillProbe(page, SEL_LEFT, FILL_PROBE.color);
      await menu(page, 'deleteSelection');
    },
    async assert(page, label) {
      return assertFillFullyCleared(page, label, SEL_LEFT, FILL_PROBE.color);
    },
  },
  {
    name: 'fill_lasso_then_clear',
    desc: 'lasso-select blank board, Fill, then Clear — the antialiased rim must go too',
    // Fill then clear over empty board is a round trip: the board owes us the
    // blank it started with, rim included.
    expectRestore: true,
    async run(page) {
      await armSelect(page, 'lasso');
      await selectLasso(page, SEL_BLANK);
      await setColor(page, FILL_PROBE.color);
      await menu(page, 'fillSelection');
      await sleep(300);
      await stashFillProbe(page, SEL_BLANK, FILL_PROBE.color);
      await menu(page, 'deleteSelection');
    },
    async assert(page, label) {
      return assertBoardBlankAgain(page, label, SEL_BLANK);
    },
  },
  {
    name: 'fill_then_move',
    desc: 'rect-select over content, Fill, drag away, Apply — the fill must move whole',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await setColor(page, FILL_PROBE.color);
      await menu(page, 'fillSelection');
      await sleep(300);
      await stashFillProbe(page, SEL_LEFT, FILL_PROBE.color);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
    // The lift erases the source, so the same rim the clear leaves behind is
    // left standing where the fill used to be — with the moved copy now
    // somewhere else, it reads as a ghost outline.
    async assert(page, label) {
      return assertFillFullyCleared(page, label, SEL_LEFT, FILL_PROBE.color);
    },
  },
  {
    name: 'flip_commit',
    desc: 'rect-select, Flip horizontal, Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'flipHorizontal');
      await sleep(300);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'stamp',
    desc: 'rect-select, move, Stamp (leaves the float live), then Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'stamp');
      await sleep(400);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'select_all_move',
    desc: 'Select All, drag, Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await menu(page, 'selectAll');
      await sleep(300);
      await moveSelection(page, [400, 300], 120, 80);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'delete_all_layers',
    desc: 'all-layers mode: rect-select, Clear (must clear every layer)',
    layers: [0, 1],
    async run(page) {
      await armSelect(page, 'rect', { allLayers: true });
      await selectRect(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
    },
  },
  {
    name: 'move_all_layers',
    desc: 'all-layers mode: rect-select, drag, Apply',
    layers: [0, 1],
    async run(page) {
      await armSelect(page, 'rect', { allLayers: true });
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'merge_down',
    desc: 'two layers, rect-select, Merge Down',
    layers: [0, 1],
    async run(page) {
      await page.evaluate(async () => {
        window.app.handleLayerSelect(1);
        await new Promise((r) => setTimeout(r, 120));
      });
      await armSelect(page, 'rect');
      await selectRect(page, SEL_FULL);
      await menu(page, 'mergeDown');
    },
  },
  {
    name: 'merge_all',
    desc: 'two layers, rect-select, Merge All',
    layers: [0, 1],
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_FULL);
      await menu(page, 'mergeAll');
    },
  },
  {
    name: 'delete_then_undo',
    expectRestore: true,
    desc: 'rect-select, Clear, then Ctrl+Z (erase must come back everywhere)',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
      await sleep(500);
      await page.evaluate(async () => {
        window.app.handleUndo();
        window.app.inputBufferManager.tick();
        await new Promise((r) => setTimeout(r, 400));
      });
    },
  },
  {
    name: 'move_commit_then_undo',
    expectRestore: true,
    desc: 'rect-select, move, Apply, then Ctrl+Z',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
      await sleep(500);
      await page.evaluate(async () => {
        window.app.handleUndo();
        window.app.inputBufferManager.tick();
        await new Promise((r) => setTimeout(r, 400));
      });
    },
  },
  // ── MIRRORS ────────────────────────────────────────────────────────────────
  // Every placement/destructive selection verb repeats itself into each active
  // mirror. The drawer and the receiver derive those copies from two different
  // code paths (SelectTool vs RemoteSelectionHandler), which is exactly how the
  // fill mirrored on the drawer's screen and nowhere else for so long. A
  // one-sided mirror is invisible to a single client, so it can only be caught
  // by cross-tab parity — these scenarios are that check.
  //
  // Mirrors go on BEFORE the content is drawn so the reflected areas actually
  // hold ink and a clear has something to remove there. Turning them on after
  // drawing instead tests MIRROR_REGION ordering in the join tail, which is a
  // separate concern from whether a selection verb mirrors at all.
  {
    name: 'delete_mirrored',
    desc: 'full-board mirror: rect-select, Clear (mirrored half must clear too)',
    beforeContent: mirrorWholeBoard,
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
    },
    async assert(page, label, ctx) { return assertMirroredClear(page, label, ctx); },
  },
  {
    name: 'fill_mirrored',
    desc: 'full-board mirror: rect-select, Fill (reflected half must fill too)',
    beforeContent: mirrorWholeBoard,
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await setColor(page, [128, 0, 200, 1]);
      await menu(page, 'fillSelection');
    },
    async assert(page, label, ctx) { return assertMirroredFill(page, label, ctx, [128, 0, 200]); },
  },
  {
    name: 'fill_lasso_mirrored',
    desc: 'full-board mirror: lasso-select, Fill (mirrored lasso shape, not its bbox)',
    // A lasso's outline is all antialiased edge and the mirror doubles it; the
    // assert below is what actually proves the reflection happened.
    passPct: 99.3,
    beforeContent: mirrorWholeBoard,
    async run(page) {
      await armSelect(page, 'lasso');
      await selectLasso(page, SEL_LEFT);
      await setColor(page, [200, 120, 0, 1]);
      await menu(page, 'fillSelection');
    },
    async assert(page, label, ctx) { return assertMirroredFill(page, label, ctx, [200, 120, 0]); },
  },
  {
    name: 'move_commit_mirrored',
    desc: 'full-board mirror: rect-select, drag, Apply (lift-erase AND stamp mirror)',
    beforeContent: mirrorWholeBoard,
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'stamp_mirrored',
    desc: 'full-board mirror: rect-select, move, Stamp, Apply (two mirrored placements)',
    beforeContent: mirrorWholeBoard,
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'stamp');
      await sleep(400);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'region_fill_quad',
    desc: 'quad mirror region: rect-select inside it, Fill (three reflected copies)',
    beforeContent: (page) => addMirrorRegion(page, 'quad'),
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await setColor(page, [0, 180, 160, 1]);
      await menu(page, 'fillSelection');
    },
  },
  {
    name: 'region_commit_radial',
    desc: 'radial mirror region: rect-select, drag, Apply (rotated copies per slice)',
    // Radial is the mode a rect-and-lasso mirror helper could never express — a
    // rotated rectangle is not a rectangle — so it is the one that proves the
    // ctx-transform approach really covers every mode.
    beforeContent: (page) => addMirrorRegion(page, 'radial', { extra: { slices: 5 } }),
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'region_delete_rotational',
    desc: 'rotational mirror region: rect-select, Clear (180° copy must clear too)',
    beforeContent: (page) => addMirrorRegion(page, 'rotational'),
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
    },
  },
  {
    name: 'mask_brush_draw_mirrored',
    desc: 'full-board mirror + Mask on: brush across the mask edge (reflection must survive the clip)',
    beforeContent: mirrorWholeBoard,
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await enableMask(page);
      await switchTool(page, 'brush');
      await brushStroke(page, MASK_PROBE);
    },
    // Two assertions in one: the mask still clips (nothing leaked past its right
    // edge) AND the mirrored copy exists. Checking only the clip would go green
    // on a mask that ate every reflection.
    async assert(page, label, ctx) {
      return [
        // Mirror on: bound the leak window at the mirror axis, or this assert
        // and the one below contradict each other. See probeMaskInkInPage.
        ...(await assertMaskClipped(page, label, null, MASK_PROBE.color, true)),
        ...(await assertMaskedStrokeMirrored(page, label, ctx)),
      ];
    },
  },

  // ── Selection MASK ─────────────────────────────────────────────────────────
  // The mask is not a commit and owns no pixels of its own; it is per-user
  // drawing state that clips whatever the user draws next, bound onto the
  // stroke's context at MD time. That makes it the one selection feature whose
  // whole failure mode is a SYNC failure: every client has to hold the same
  // mask at the same point in the stream, or the same MD/MM bytes paint
  // different pixels on different clients. Each scenario therefore asserts
  // twice — parity across tabs, and (via `assert`) that the clip actually
  // happened, since a mask that stopped working everywhere at once would leave
  // all four tabs in perfect, wrong agreement.
  {
    name: 'mask_brush_draw',
    desc: 'rect-select, Mask on, switch to brush, draw across the mask edge',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await enableMask(page);
      // Picking another tool is how the mask actually reaches the brush:
      // deactivate() keeps a non-floating mask alive and hands the overlay to
      // the Board instead of committing and clearing it.
      await switchTool(page, 'brush');
      await brushStroke(page, MASK_PROBE);
    },
    // No rect override: every tab must resolve the mask from its OWN
    // board.selectionMasksByUser, so "the mask never reached this client" is a
    // reported failure rather than something the harness papers over.
    async assert(page, label) { return assertMaskClipped(page, label); },
  },
  {
    name: 'mask_lasso_brush_draw',
    desc: 'lasso-select, Mask on, brush across the mask edge (lasso path on the wire)',
    async run(page) {
      await armSelect(page, 'lasso');
      await selectLasso(page, SEL_LEFT);
      await enableMask(page);
      await switchTool(page, 'brush');
      await brushStroke(page, MASK_PROBE);
    },
    async assert(page, label) { return assertMaskClipped(page, label); },
  },
  {
    name: 'mask_draw_then_clear',
    desc: 'mask on, draw clipped, mask off, draw again — the second stroke must be unclipped',
    // Turning the mask off is where the clip has to be UNWOUND, not merely
    // forgotten. Stroke canvases come from LayerManager's pool, and a
    // save()+clip() that never gets its restore() rides that canvas into
    // whichever stroke acquires it next — clipping a stroke to a mask that no
    // longer exists. Pixel parity is blind to this (every client leaks
    // identically), so the assert is the only thing that can see it.
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await enableMask(page);
      await switchTool(page, 'brush');
      await brushStroke(page, MASK_PROBE);
      await page.evaluate(async () => {
        const app = window.app;
        app.toolManager.getTool('select').realTool.toggleMaskMode(false);
        app.inputBufferManager.tick();
        await new Promise((r) => setTimeout(r, 300));
      });
      await sleep(300);
      await brushStroke(page, AFTER_PROBE);
    },
    // The mask is GONE by assert time, so no tab can resolve its rect from
    // board state any more — the runner carries the actor's recorded rect over
    // in ctx so observers and the joiner can be measured against the same edge.
    async assert(page, label, ctx) {
      const rect = ctx?.maskRect || null;
      if (!rect) return [`[${label}] mask_draw_then_clear: no mask rect was recorded on the actor`];
      return [
        ...await assertMaskClipped(page, label, rect),
        ...await assertMaskNotClipping(page, label, AFTER_PROBE.color, rect),
      ];
    },
  },
  {
    name: 'mask_cleared_midstroke',
    desc: 'mask off WHILE a stroke is open — the rest of that stroke must escape the mask',
    // LIVE pixel parity is deliberately skipped here, and it is not a fudge:
    // SelectTool broadcasts SEL_MASK straight down the socket while MD/MM ride
    // the input buffer, so each observer learns the mask is gone at a slightly
    // different point in the MM stream and cuts the clip at a different sample.
    // That ordering hazard is a separate (unfixed) defect from the unwind bug
    // this scenario exists to catch, and asserting on it here would just make
    // the suite flaky. The joiner is still checked: with the mask travelling as
    // tool state, its frame sits at its true position inside the stroke's
    // preamble, so D reproduces A's cut exactly.
    parityExempt: true,
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await enableMask(page);
      await switchTool(page, 'brush');
      await brushStrokeClearingMaskMidway(page, MASK_PROBE);
    },
    async assert(page, label, ctx) {
      const rect = ctx?.maskRect || null;
      if (!rect) return [`[${label}] mask_cleared_midstroke: no mask rect was recorded on the actor`];
      // Only the ACTOR is asserted: the observers' cut point is timing-dependent
      // for the reason above, and the joiner is covered by the pixel diff vs A.
      if (label !== 'A') return [];
      const p = await probeMaskInk(page, MASK_PROBE.color, rect);
      if (p.error) return [`[${label}] midstroke probe: ${p.error}`];
      const fails = [];
      if (p.inside < 200) {
        fails.push(`[${label}] midstroke probe: only ${p.inside}px landed inside the mask — the stroke never drew`);
      }
      if (p.outside < 200) {
        fails.push(`[${label}] CLIP NOT UNWOUND: the mask was cleared mid-stroke but only ${p.outside}px `
          + `of the rest of the stroke got past the old edge (x>${p.edge}, rightmost ink at x=${p.maxX}) — `
          + `the stroke context is still holding the mask's clip`);
      }
      return fails;
    },
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────
async function runScenario(browser, scenario) {
  const room = `selparity_${Date.now()}_${scenario.name}`;
  pageErrors = [];
  const tabs = [];
  const notes = [];
  let live = null, joinRes = null, effect = null, tapeRes = null, joinTapeOk = null, ok = true;
  let assertCtx = null;

  try {
    for (const label of ['A', 'B', 'C']) tabs.push(await spawnTab(browser, label, room));
    const A = tabs[0];

    if (scenario.beforeContent) {
      await scenario.beforeContent(A.page);
      await sleep(400);
    }

    for (const layer of (scenario.layers || [0])) {
      await drawContent(A.page, layer);
      await sleep(300);
    }
    // Always end on layer 0 unless the scenario re-selects, so 'activeLayer' is
    // a known quantity for the ops that read it.
    if ((scenario.layers || [0]).length > 1) {
      await A.page.evaluate(async () => {
        window.app.handleLayerSelect(0);
        await new Promise((r) => setTimeout(r, 120));
      });
    }
    const pre = await waitConverged(tabs);
    if (!pre.converged) notes.push('content did not converge before the operation');

    // Baseline of the ACTOR's own board. Without this a scenario whose operation
    // silently no-ops (a missing method, a selection that landed on blank
    // canvas) still "passes" parity — three clients agreeing on an unchanged
    // board proves nothing. Every scenario must either change A's board or, for
    // the restore scenarios, provably return it to this baseline.
    const preSnapA = await snap(A.page);

    // Arm the tapes around the OPERATION only. Scoping them this tightly is what
    // makes the diff readable: the content-drawing phase would otherwise bury one
    // selection message under hundreds of MD/MM, and the join tail served to the
    // last tab to spawn would show up as messages the others "never received".
    await Promise.all(tabs.map((t) => startRecording(t.page)));
    await sleep(200);

    await scenario.run(A.page);
    await sleep(800);

    const post = await waitConverged(tabs);
    if (!post.converged) notes.push('did not converge after the operation');

    // Live parity
    const [sA, sB, sC] = await Promise.all(tabs.map((t) => snap(t.page)));
    // Antialiased edges never match exactly between the drawer (which blits a
    // pre-rendered canvas) and a receiver (which re-renders the shape) — a known,
    // accepted difference. A mirror duplicates every edge, so a mirrored
    // scenario spends roughly twice as much of the budget on it; `passPct` lets
    // those scenarios say so instead of the suite carrying a looser bar globally.
    const passPct = scenario.passPct ?? PASS_PCT;
    const dAB = diffSnapshots(sA, sB, PIXEL_TOLERANCE, passPct);
    const dAC = diffSnapshots(sA, sC, PIXEL_TOLERANCE, passPct);
    live = { AB: dAB, AC: dAC, exempt: !!scenario.parityExempt };
    // `parityExempt` scenarios still MEASURE and report live parity — they just
    // do not fail on it, because the divergence they produce is a known,
    // separately-tracked ordering hazard rather than the thing under test. See
    // the flag's comment on the scenario for why.
    if ((!dAB.pass || !dAC.pass) && !scenario.parityExempt) ok = false;
    if ((!dAB.pass || !dAC.pass) && scenario.parityExempt) {
      notes.push(`live parity NOT enforced for this scenario: A↔B ${dAB.matchPct.toFixed(2)}% `
        + `A↔C ${dAC.matchPct.toFixed(2)}%`);
    }

    // Did the operation do anything? (see preSnapA)
    const selfDiff = diffSnapshots(preSnapA, sA, PIXEL_TOLERANCE);
    effect = { matchPct: selfDiff.matchPct, restored: scenario.expectRestore === true };
    if (scenario.expectRestore) {
      // cancel / undo scenarios: the board must come BACK to its pre-op state.
      if (!selfDiff.pass) {
        ok = false;
        notes.push(`expected restore to baseline, but A differs from pre-op by ${(100 - selfDiff.matchPct).toFixed(2)}%`);
      }
    } else if (selfDiff.matchPct > 99.99) {
      ok = false;
      notes.push('OPERATION HAD NO EFFECT on the actor\'s board — scenario is vacuous, not passing');
    }

    // Scenario-specific assertion, run on the actor AND both live observers.
    //
    // Pixel parity only says the tabs agree; for a feature like the selection
    // mask they can agree on the wrong thing (if clipping broke outright, all
    // three draw the same unclipped stroke). `assert` is where a scenario
    // states what the board must actually LOOK like, and running it per-tab
    // localises a break to "the actor never clipped" vs "the mask never
    // reached the observers".
    if (scenario.assert) {
      assertCtx = {
        maskRect: await A.page.evaluate(() => window.__maskRect || null),
        // Resolved from A and reused for every tab: board coords are identical
        // across tabs (same viewport), and a per-tab lookup would let a tab with
        // a broken board silently probe a different rect.
        rects: await mirroredSelectionRects(A.page),
      };
      for (const t of tabs) {
        const fails = await scenario.assert(t.page, t.label, assertCtx).catch(
          (e) => [`[${t.label}] assert threw: ${e.message}`]);
        if (fails?.length) { ok = false; notes.push(...fails); }
      }
    }

    // On failure, dump each tab's per-layer stroke stack side by side.
    if (!dAB.pass || !dAC.pass) {
      for (let i = 0; i < post.states.length; i++) {
        const st = post.states[i];
        const line = (st.perLayer || []).map((L) =>
          `L${L.layer}:${L.strokes}${L.baked ? '*' : ''}[${L.stack.map((x) =>
            `${x.bm === 'destination-out' ? 'E' : 'S'}${x.seq}${x.merge ? 'm' : ''}`).join(' ')}]`).join('  ');
        notes.push(`stack ${tabs[i].label}: mirror=${st.mirror} ${line}`);
      }
    }

    const zeroSeq = post.states.flatMap((s, i) =>
      s.seqZeroStrokes.map((z) => ({ tab: tabs[i].label, ...z })));
    if (zeroSeq.length) {
      notes.push(`seq-0 committed strokes present: ${JSON.stringify(zeroSeq).slice(0, 240)}`);
    }

    // Wire parity. Read WITH the pixel diff: tapes agree + pixels differ points
    // at the remote handler; tapes differ points at the sanitizer/relay and the
    // pixel result is merely downstream of it.
    const bundles = [];
    for (const t of tabs) {
      const enc = await stopAndEncode(t.page).catch(() => null);
      if (!enc) continue;
      const dir = path.join(RESULTS_DIR, 'tapes', scenario.name);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${t.label}.ddraw`);
      fs.writeFileSync(file, Buffer.from(enc.b64, 'base64'));
      bundles.push({ label: t.label, file });
    }
    if (bundles.length >= 2) {
      const loaded = [];
      for (const b of bundles) {
        const tape = await loadTape(b.file);
        tape.label = b.label;
        loaded.push(tape);
      }
      tapeRes = await compareTapes(loaded, { ignoreTypes: new Set(['MM']) });
      if (!tapeRes.ok) {
        ok = false;
        for (const st of tapeRes.streams) {
          if (st.ok) continue;
          const detail = (st.ops ?? []).slice(0, 4).map((o) =>
            `${o.op === 'missing' ? '-' + st.pair[0] : '+' + st.pair[1]} ${o.event.typeName}` +
            `${JSON.stringify(o.event.canon).slice(0, 90)}`).join('  ');
          notes.push(`TAPE ${st.pair.join('↔')} u${st.user}: ${st.countA} vs ${st.countB} — ${detail}`);
        }
        for (const sq of tapeRes.seq) {
          if (sq.ok) continue;
          notes.push(`TAPE seq ${sq.pair.join('↔')}: ${sq.mismatches.length}/${sq.shared} disagree`);
        }
      }
    }

    // Late-join parity
    if (DO_JOIN) {
      const D = await spawnTab(browser, 'D', room, { recordFromJoin: true });
      tabs.push(D);
      await sleep(1500);
      await waitConverged(tabs, { timeoutMs: 20_000 });
      const [sA2, sD] = await Promise.all([snap(A.page), snap(D.page)]);
      joinRes = diffSnapshots(sA2, sD, PIXEL_TOLERANCE, scenario.passPct ?? PASS_PCT);
      if (!joinRes.pass) {
        ok = false;
        // A join-only failure is the joiner's own rebuild, so the live trio's
        // stacks say nothing — print A against D, with timestamps.
        const [stA, stD] = await Promise.all([getState(A.page), getState(D.page)]);
        for (const [label, st] of [['A', stA], ['D', stD]]) {
          const line = (st.perLayer || []).map((L) =>
            `L${L.layer}:${L.strokes}${L.baked ? '*' : ''}[${L.stack.map((x) =>
              `${x.bm === 'destination-out' ? 'E' : 'S'}${x.seq}@${x.ts % 100000}${x.restore ? 'r' : ''}`).join(' ')}]`).join('  ');
          notes.push(`join stack ${label}: ${line}`);
        }
        notes.push(`join redo sizes: A=${JSON.stringify(stA.redoSizes ?? {})} D=${JSON.stringify(stD.redoSizes ?? {})}`);
      }

      // The joiner has to satisfy the scenario's own assertion too, not just
      // match A's pixels. For the mask scenarios this is the assertion that
      // matters most: the joiner rebuilds every stroke from the replayed
      // command tail, and the mask has to be in scope at each stroke's MD or it
      // redraws the stroke unclipped — a divergence the drawer can never see.
      if (scenario.assert) {
        const fails = await scenario.assert(D.page, 'D', assertCtx).catch(
          (e) => [`[D] assert threw: ${e.message}`]);
        if (fails?.length) { ok = false; notes.push(...fails); }
      }

      // SEQ parity for the joiner — pixels alone cannot see this.
      //
      // A commit that rebuilds at seq 0 on the joiner renders identically to one
      // at its real seq whenever it happens to be the newest stroke: both orders
      // put it on top. It only becomes visible once something is drawn AFTER it,
      // because _sortStrokeStack floats seq 0 to MAX_SAFE_INTEGER — by which
      // time the stack has usually baked and the divergence is permanent. So a
      // green pixel diff here is NOT evidence the rebuild was faithful.
      //
      // Compare against a LIVE OBSERVER (B), not the drawer: the drawer holds
      // its own strokes outside the layer stacks until they bake, so A vs D
      // differs by bookkeeping even when both are correct. B and D are both
      // observers and must agree seq-for-seq.
      //
      // This is the assertion that catches the class where a remote handler
      // drops `seq` while re-queueing itself behind an async image decode — the
      // joiner requeues every time (the sync tail replays synchronously), a live
      // client never does. Found exactly that in handleSelectionCommit.
      const [stB2, stD2] = await Promise.all([getState(tabs[1].page), getState(D.page)]);
      const seqSig = (st) => (st.perLayer || [])
        .map((L) => `L${L.layer}[${L.stack.map((x) => `${x.bm === 'destination-out' ? 'E' : 'S'}${x.seq}`).join(' ')}]`)
        .join('  ');
      const sigB = seqSig(stB2);
      const sigD = seqSig(stD2);
      if (sigB !== sigD) {
        ok = false;
        notes.push('JOIN SEQ MISMATCH — joiner rebuilt commits with different seqs than a live observer');
        notes.push(`   live B : ${sigB}`);
        notes.push(`   join D : ${sigD}`);
      }
      const joinZero = (stD2.seqZeroStrokes || []);
      if (joinZero.length) {
        ok = false;
        notes.push(`JOINER holds ${joinZero.length} seq-0 committed stroke(s) — these sort to the TOP of the `
          + `stack and will land above any later work: ${JSON.stringify(joinZero).slice(0, 200)}`);
      }

      // Compare the JOINER's rebuilt tail against A's live stream. The live
      // `tape` verdict above covers A/B/C only — their recorders stop before D
      // exists — so without this a join-only failure has no wire evidence at
      // all. Unclipped: D tapes the tail at APPLICATION time, not origin time.
      const encD = await stopAndEncode(D.page).catch(() => null);
      if (encD) {
        const dir = path.join(RESULTS_DIR, 'tapes', scenario.name);
        fs.mkdirSync(dir, { recursive: true });
        const fileD = path.join(dir, 'D.ddraw');
        fs.writeFileSync(fileD, Buffer.from(encD.b64, 'base64'));
        const incumbent = bundles.find((b) => b.label === 'A');
        if (incumbent) {
          const tA = await loadTape(incumbent.file); tA.label = 'A';
          const tD = await loadTape(fileD); tD.label = 'D';
          const jr = await compareTapes([tA, tD], {
            ignoreTypes: new Set(['MM']), clipToWindow: false,
          });
          // The verdict is SUBSEQUENCE, not equality. A's recorder is armed just
          // before the operation, while D tapes the room's whole replayed
          // history from its join — so D holding far more messages ('+D' ops) is
          // correct, not a fault. What must never happen is a 'missing' op:
          // something A sent that D's rebuilt tail does not contain.
          // Subsequence verdict from the shared oracle — extras are expected
          // (D replays the room's whole history), only a missing board-state
          // message is a fault. See tapeDiff.joinVerdict.
          const verdict = joinVerdict(jr);
          const dropped = verdict.dropped;
          if (verdict.compacted.length) {
            const byType = {};
            for (const c of verdict.compacted) byType[c.event.typeName] = (byType[c.event.typeName] || 0) + 1;
            notes.push(`join tail compacted (expected): ${JSON.stringify(byType)}`);
          }
          // Reported, not failed: the joiner holds these, just at another
          // position (selection preambles replay bundled before their commit).
          // Surfaced so a sudden change in the reorder set is still visible.
          if (verdict.reordered?.length) {
            const byType = {};
            for (const c of verdict.reordered) byType[c.event.typeName] = (byType[c.event.typeName] || 0) + 1;
            notes.push(`join tail reordered (present, bundled before commit): ${JSON.stringify(byType)}`);
          }
          joinTapeOk = verdict.ok;
          if (!joinTapeOk) {
            ok = false;
            const byType = {};
            for (const d of dropped) byType[d.event.typeName] = (byType[d.event.typeName] || 0) + 1;
            notes.push(`JOIN TAPE: ${dropped.length} message(s) A sent are ABSENT from the joiner's `
              + `rebuilt tail — ${JSON.stringify(byType)}`);
            for (const d of dropped.slice(0, 6)) {
              notes.push(`   missing u${d.user} ${d.event.typeName} ${JSON.stringify(d.event.canon).slice(0, 110)}`);
            }
          }
        }
      }
    }

    // Save a diff image for whichever comparison failed worst.
    if (!ok) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const worst = [['AB', dAB], ['AC', dAC], ['AD', joinRes]]
        .filter(([, d]) => d && !d.pass)
        .sort((a, b) => a[1].matchPct - b[1].matchPct)[0];
      if (worst) {
        const other = worst[0] === 'AB' ? tabs[1] : worst[0] === 'AC' ? tabs[2] : tabs[3];
        const png = await A.page.evaluate(
          generateDiffPngInPage, await snap(A.page), await snap(other.page), PIXEL_TOLERANCE);
        if (png) {
          fs.writeFileSync(
            path.join(RESULTS_DIR, `diff_${scenario.name}_A_vs_${worst[0].slice(1)}.png`),
            Buffer.from(png.split(',')[1], 'base64'));
        }
      }
    }
  } catch (err) {
    ok = false;
    notes.push(`threw: ${err.message}`);
  } finally {
    for (const t of tabs) { try { await t.page.close(); } catch {} }
  }

  const errs = pageErrors.slice(0, 6);
  if (errs.length) { ok = false; notes.push(`page errors: ${errs.map((e) => `${e.label}: ${e.message}`).join(' | ')}`); }

  return { scenario, ok, live, joinRes, effect, tape: tapeRes && { ok: tapeRes.ok, failures: tapeRes.failures }, joinTapeOk, notes };
}

async function main() {
  const list = ONLY ? SCENARIOS.filter((s) => ONLY.includes(s.name)) : SCENARIOS;

  if (LIST_ONLY) {
    for (const s of SCENARIOS) console.log(`${s.name.padEnd(24)} ${s.desc}`);
    return 0;
  }
  if (!list.length) { console.error('No scenarios matched --only'); return 2; }

  console.log('\nTop Draw — Selection parity suite (3 live clients + late joiner)');
  console.log(`Run:        ${RUN_ID}`);
  console.log(`Browser:    ${TARGET_URL}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match (pixels, not hashes)`);
  console.log(`Late join:  ${DO_JOIN ? 'yes' : 'skipped'}`);
  console.log(`Scenarios:  ${list.map((s) => s.name).join(', ')}`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: VIEWPORT,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  try {
    for (const s of list) {
      process.stdout.write(`  ${s.name.padEnd(24)} … `);
      const r = await runScenario(browser, s);
      results.push(r);
      const pct = (d) => (d ? `${d.matchPct.toFixed(1)}%` : 'n/a');
      const tag = r.ok ? '✅ PASS' : '❌ FAIL';
      // `tape` is the wire verdict; the percentages are the pixel verdict. tape
      // ✗ means the clients were fed different messages, so the pixel numbers
      // are a symptom — fix the tape first.
      // `tape` is A↔B↔C (live); `jtape` is the JOINER's rebuilt tail vs A. They
      // are separate verdicts: the live recorders stop before D joins.
      const tapeTag = r.tape ? (r.tape.ok ? 'tape ✓' : 'tape ✗') : 'tape –'
        + '';
      const jtag = r.joinTapeOk == null ? '' : (r.joinTapeOk ? '  jtape ✓' : '  jtape ✗');
      console.log(`${tag}  A↔B ${pct(r.live?.AB)}  A↔C ${pct(r.live?.AC)}  A↔D ${pct(r.joinRes)}  ${tapeTag}${jtag}`);
      for (const n of r.notes) console.log(`       ${n}`);
      if (!r.ok && r.live) {
        for (const [k, d] of [['A↔B', r.live.AB], ['A↔C', r.live.AC], ['A↔D', r.joinRes]]) {
          if (d && !d.pass) {
            const bad = d.perGroup.filter((g) => !g.pass)
              .map((g) => `L${g.groupIdx} ${g.matchPct.toFixed(1)}% maxΔ${g.maxDelta}`).join(', ');
            console.log(`       ${k} failing layers: ${bad}`);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log('\n' + '─'.repeat(72));
  console.log(`RESULTS: ${passed}/${results.length} scenarios passed`);
  console.log('─'.repeat(72));
  if (passed !== results.length) {
    console.log('\nFailing scenarios:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  • ${r.scenario.name} — ${r.scenario.desc}`);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'report.json'), JSON.stringify(
    results.map((r) => ({
      name: r.scenario.name, desc: r.scenario.desc, ok: r.ok, notes: r.notes,
      AB: r.live?.AB && { matchPct: r.live.AB.matchPct, maxDelta: r.live.AB.maxDelta },
      AC: r.live?.AC && { matchPct: r.live.AC.matchPct, maxDelta: r.live.AC.maxDelta },
      AD: r.joinRes && { matchPct: r.joinRes.matchPct, maxDelta: r.joinRes.maxDelta },
      effect: r.effect,
    })), null, 2));

  return passed === results.length ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
