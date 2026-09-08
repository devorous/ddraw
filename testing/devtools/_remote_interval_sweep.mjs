/**
 * Sweeps FIXED remote-preview-render intervals (bypassing the adaptive/EMA
 * logic via InputBufferManager.debugForcedRemotePreviewIntervalMs) against a
 * SINGLE continuous k6 load, sampling each value for a fixed window. One k6
 * spawn, one room join, one Chrome session — sequential windows instead of
 * separate before/after runs, so there's no join-storm/workload-mismatch
 * confound between values, only real device state to worry about.
 *
 * Also reports the actual render mechanism (RemoteUserHandler debug
 * counters): how many incoming stroke batches asked for a render vs. how
 * many actually fired one, at each interval — the direct evidence for what
 * "throttling" is doing, not just an inferred effect from stalls/fps.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.APP_URL || 'http://localhost:3000/go/';
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8030';
const VUS = Number(process.env.VUS || 6);
const K6_TOOLS = process.env.K6_TOOLS || 'pattern';
const WINDOW_SEC = Number(process.env.WINDOW_SEC || 12);
const SETTLE_SEC = Number(process.env.SETTLE_SEC || 10);
const INTERVALS = (process.env.INTERVALS || '33,50,100,150,200,250')
  .split(',').map(Number);
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 150000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 240000 });
let pages = (await browser.pages()).filter((p) => p.url().startsWith(new URL(TARGET_URL).origin));
for (let i = 1; i < pages.length; i++) await pages[i].close();
let page = pages[0] || await browser.newPage();
await page.bringToFront();

const already = await page.evaluate(() => !!window.app).catch(() => false);
if (!already) {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
}
await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null, { timeout: READY_TIMEOUT, polling: 1000 });

const room = `sweep_${Date.now()}`;
await page.evaluate((r) => { window.app.self.username = 'SWEEP'; window.app.handleRoomSelected(r); }, room);
await page.waitForFunction(() => window.app?.board?.dimensions?.[0] > 0, { timeout: 60000, polling: 500 });
console.log('joined room', room);

await page.evaluate(async () => {
  window.__wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
});

// One k6 spawn covering the whole sweep, so the SAME continuous load runs
// under every interval value tested.
const totalSec = SETTLE_SEC + INTERVALS.length * WINDOW_SEC + 15;
const k6 = spawn('k6', [
  'run', '-e', `ROOM=${room}`, '-e', `TARGET_URL=${WS_URL}`, '-e', `TOOLS=${K6_TOOLS}`,
  `--vus=${VUS}`, `--duration=${totalSec}s`, 'testing/medium_stress_test.js',
], { cwd: REPO_ROOT, stdio: 'ignore', shell: process.platform === 'win32' });

console.log(`k6 spawned (${VUS} VUs, tool=${K6_TOOLS}), settling ${SETTLE_SEC}s...`);
await sleep(SETTLE_SEC * 1000);

const users = await page.evaluate(() => window.app.users?.size ?? 0);
console.log('users in room:', users);

async function sampleWindow(seconds) {
  const cdp = await page.target().createCDPSession();
  await cdp.send('Performance.enable');
  const before = (await cdp.send('Performance.getMetrics')).metrics;
  const debugBefore = await page.evaluate(() => window.app.remoteUserHandler.getDebugStats());

  await page.evaluate(() => {
    window.__sweepFrames = [];
    window.__sweepRaf = true;
    (function loop(t) {
      window.__sweepFrames.push(t);
      if (window.__sweepRaf) requestAnimationFrame(loop);
    })(performance.now());
  });

  await sleep(seconds * 1000);

  const frames = await page.evaluate(() => { window.__sweepRaf = false; return window.__sweepFrames; });
  const after = (await cdp.send('Performance.getMetrics')).metrics;
  const debugAfter = await page.evaluate(() => window.app.remoteUserHandler.getDebugStats());
  await cdp.detach().catch(() => {});

  const asMap = (m) => Object.fromEntries(m.map((x) => [x.name, x.value]));
  const mb = asMap(before), ma = asMap(after);
  const spanSec = (ma.Timestamp - mb.Timestamp) || 1;
  const taskPct = +((((ma.TaskDuration ?? 0) - (mb.TaskDuration ?? 0)) / spanSec) * 100).toFixed(1);

  const intervals = [];
  for (let i = 1; i < frames.length; i++) intervals.push(frames[i] - frames[i - 1]);
  const sorted = [...intervals].sort((a, b) => a - b);
  const pct = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
  const durationMs = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0;

  return {
    taskPct,
    fps: durationMs > 0 ? +((frames.length - 1) / (durationMs / 1000)).toFixed(1) : 0,
    p50: +pct(0.5).toFixed(1),
    p99: +pct(0.99).toFixed(1),
    max: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : 0,
    stallsOver16: intervals.filter((v) => v > 16).length,
    previewCalls: (debugAfter.previewCallCount || 0) - (debugBefore.previewCallCount || 0),
    previewFires: (debugAfter.previewFireCount || 0) - (debugBefore.previewFireCount || 0),
  };
}

const results = [];
for (const ms of INTERVALS) {
  await page.evaluate((v) => { window.app.inputBufferManager.debugForcedRemotePreviewIntervalMs = v; }, ms);
  console.log(`\n--- interval ${ms}ms, sampling ${WINDOW_SEC}s ---`);
  const r = await sampleWindow(WINDOW_SEC);
  const coalescePct = r.previewCalls > 0 ? +(100 * (1 - r.previewFires / r.previewCalls)).toFixed(1) : 0;
  results.push({ intervalMs: ms, ...r, coalescePct });
  console.log(JSON.stringify({ intervalMs: ms, ...r, coalescePct }));
}

try { k6.kill(); } catch {}
await page.evaluate(() => { window.app.inputBufferManager.debugForcedRemotePreviewIntervalMs = null; });

console.log('\n=== SWEEP SUMMARY ===');
console.log('interval  calls  fires  coalesce%  taskBusy%  fps  p50   p99    max    stalls>16ms');
for (const r of results) {
  console.log(
    `${String(r.intervalMs).padStart(6)}ms  ${String(r.previewCalls).padStart(5)}  ${String(r.previewFires).padStart(5)}  ` +
    `${String(r.coalescePct).padStart(8)}%  ${String(r.taskPct).padStart(8)}%  ${String(r.fps).padStart(4)}  ` +
    `${String(r.p50).padStart(5)}  ${String(r.p99).padStart(5)}  ${String(r.max).padStart(5)}  ${String(r.stallsOver16).padStart(6)}`
  );
}

await browser.disconnect();
