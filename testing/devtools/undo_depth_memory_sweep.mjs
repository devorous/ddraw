/**
 * Sweep LayerManager.MAX_STROKES_PER_USER and measure a real observer's
 * renderer memory while k6 bots (testing/undo_depth_stress_test.js) hammer it
 * with many small strokes and undo bursts.
 *
 * MAX_STROKES_PER_USER is a static class field, so it's overridden at runtime
 * via `window.app.board.layerManager.constructor.MAX_STROKES_PER_USER = N` —
 * no rebuild needed. Each sweep value gets a fresh page (new room, same tab)
 * so history from the previous value doesn't carry over.
 *
 * Usage: node testing/devtools/undo_depth_memory_sweep.mjs [comma,list,of,values]
 * Env: CDP_URL (default http://127.0.0.1:9222), APP_URL (default
 *      http://localhost:3000/go/), VUS (default 3), RUN_MS (default 75000)
 */
import puppeteer from 'puppeteer-core';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const APP_URL = process.env.APP_URL || 'http://localhost:3000/go/';
const VUS = process.env.VUS || '3';
const RUN_MS = Number(process.env.RUN_MS || 15000); // floor; actual duration scales with maxStrokes
const SSH_HOST = process.env.SSH_HOST || 'book';
const K6_BIN = process.env.K6_BIN || 'C:\\Program Files\\k6\\k6.exe';
const TARGET_URL = process.env.TARGET_URL || 'ws://127.0.0.1:8030';
const VALUES = (process.argv[2] || '20,100,500,1000,2000').split(',').map(Number);

function spawnK6(room, durationMs, extraEnv) {
  const durationSec = Math.round(durationMs / 1000);
  const child = spawn(K6_BIN, [
    'run', `--vus=${VUS}`, `--duration=${durationSec}s`,
    'testing/undo_depth_stress_test.js',
  ], {
    env: { ...process.env, ROOM: room, TARGET_URL, DURATION: `${durationSec}s`, ...extraEnv },
    cwd: process.cwd(),
  });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { child, exited };
}

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1280, height: 800 } });

async function heapSnapshot(page) {
  const m = await page.metrics();
  return { jsHeap: m.JSHeapUsedSize, nodes: m.Nodes, listeners: m.JSEventListeners };
}

/** Sum RSS (KB) of every headless chrome renderer process on the remote box. */
async function rendererRssKb() {
  try {
    const { stdout } = await execFileP('ssh', [SSH_HOST,
      "ps -eo rss,cmd | grep 'type=renderer' | grep -v grep | awk '{s+=$1} END {print s+0}'"]);
    return Number(stdout.trim()) || 0;
  } catch (e) {
    return -1;
  }
}

async function strokeStackSnapshot(page) {
  return page.evaluate(() => {
    const lm = window.app?.board?.layerManager;
    if (!lm) return null;
    return lm.layerGroups.map((g) => g.strokeStack?.length ?? 0);
  });
}

/** Direct byte count of every retained per-stroke cropped canvas (RGBA, 4B/px) — the
 * actual pixel memory MAX_STROKES_PER_USER is trading off, as opposed to JS heap
 * (which only holds bookkeeping: the record object, blend mode string, etc). */
async function canvasBytesSnapshot(page) {
  return page.evaluate(() => {
    const lm = window.app?.board?.layerManager;
    if (!lm) return null;
    return lm.layerGroups.map((g) =>
      (g.strokeStack || []).reduce((sum, r) => sum + (r.width || 0) * (r.height || 0) * 4, 0)
    );
  });
}

const results = [];

for (const maxStrokes of VALUES) {
  const room = `undodepth_${maxStrokes}_${Date.now()}`;
  const page = await browser.newPage();
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
    { timeout: 120000, polling: 500 }
  );
  await page.evaluate((r) => {
    window.app.self.username = 'OBSERVER';
    window.app.handleRoomSelected(r);
  }, room);
  await page.waitForFunction(() => window.app?.board?.getWidth?.() > 0, { timeout: 60000, polling: 500 });

  const applied = await page.evaluate((n) => {
    window.app.board.layerManager.constructor.MAX_STROKES_PER_USER = n;
    return window.app.board.layerManager.constructor.MAX_STROKES_PER_USER;
  }, maxStrokes);

  await new Promise((r) => setTimeout(r, 1500));
  const before = await heapSnapshot(page);
  const rssBefore = await rendererRssKb();
  console.log(`[${maxStrokes}] room=${room} applied=${applied} before=`, before, 'rssKb=', rssBefore);

  // Scale traffic so each bot draws well past maxStrokes before its first undo
  // burst (forcing the live stack to actually reach the threshold and start
  // baking), then undoes most of it back off in one burst.
  const fillTarget = Math.max(30, Math.round(maxStrokes * 1.4));
  const between = `${fillTarget},${Math.round(fillTarget * 1.15)}`;
  const burst = `${Math.round(maxStrokes * 1.2)},${Math.round(maxStrokes * 1.5)}`;
  const avgStrokeMs = 4 * 16; // STROKE_PTS avg (2,6) * 16ms tick
  const runMs = Math.max(RUN_MS, Math.round(fillTarget * avgStrokeMs * 1.9) + 20000);

  console.log(`[${maxStrokes}] launching k6 (${VUS} vus, ~${Math.round(runMs / 1000)}s, fillTarget=${fillTarget}) against room ${room}`);
  const { child, exited } = spawnK6(room, runMs, {
    STROKE_PTS: '2,6',
    STROKES_BETWEEN_UNDOS: between,
    UNDO_BURST: burst,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  let peak = { jsHeap: 0, rssKb: 0, strokeStackLens: null, canvasBytes: [0] };
  let exitedFlag = false;
  exited.then(() => { exitedFlag = true; });
  while (!exitedFlag) {
    await new Promise((r) => setTimeout(r, 5000));
    if (exitedFlag) break;
    const snap = await heapSnapshot(page);
    const rssKb = await rendererRssKb();
    const strokeStackLens = await strokeStackSnapshot(page);
    const canvasBytes = await canvasBytesSnapshot(page);
    const totalCanvasBytes = canvasBytes.reduce((a, b) => a + b, 0);
    if (totalCanvasBytes > peak.canvasBytes.reduce((a, b) => a + b, 0)) {
      peak = { jsHeap: snap.jsHeap, rssKb, strokeStackLens, canvasBytes };
    }
    console.log(`[${maxStrokes}] progress jsHeap=${(snap.jsHeap / 1e6).toFixed(1)}MB rssKb=${rssKb} canvasMB=${(totalCanvasBytes / 1e6).toFixed(1)} stacks=${JSON.stringify(strokeStackLens)}`);
  }
  const code = await exited;
  console.log(`[${maxStrokes}] k6 exited code=${code}`);

  // Let composites/GC settle before reading the post-undo-burst state.
  await new Promise((r) => setTimeout(r, 4000));
  try { await page.evaluate(() => window.gc && window.gc()); } catch (_) {}
  const after = await heapSnapshot(page);
  const rssAfter = await rendererRssKb();
  const strokeStackLens = await strokeStackSnapshot(page);
  const canvasBytesAfter = await canvasBytesSnapshot(page);

  console.log(`[${maxStrokes}] peak=`, peak, 'afterBurst=', after, 'rssAfterKb=', rssAfter, 'strokeStackLens=', strokeStackLens, 'canvasBytesAfter=', canvasBytesAfter);
  results.push({ maxStrokes, room, before, peak, after, rssBefore, rssAfter, strokeStackLens, canvasBytesAfter });

  await page.close();
}

console.log('\n=== SUMMARY ===');
for (const r of results) {
  const peakCanvasMB = (r.peak.canvasBytes.reduce((a, b) => a + b, 0) / 1e6).toFixed(1);
  const afterCanvasMB = (r.canvasBytesAfter.reduce((a, b) => a + b, 0) / 1e6).toFixed(1);
  console.log(
    `MAX_STROKES_PER_USER=${r.maxStrokes}: peak retained-canvas=${peakCanvasMB}MB (stacks=${JSON.stringify(r.peak.strokeStackLens)}) ` +
    `-> after undo burst=${afterCanvasMB}MB (stacks=${JSON.stringify(r.strokeStackLens)}); ` +
    `JSHeap before=${(r.before.jsHeap / 1e6).toFixed(1)}MB peak=${(r.peak.jsHeap / 1e6).toFixed(1)}MB after=${(r.after.jsHeap / 1e6).toFixed(1)}MB; ` +
    `rendererRSS before=${(r.rssBefore / 1024).toFixed(1)}MB peak=${(r.peak.rssKb / 1024).toFixed(1)}MB after=${(r.rssAfter / 1024).toFixed(1)}MB`
  );
}

await browser.disconnect();
