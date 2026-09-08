/**
 * Does the tiled store's blank-detection READBACK cause the long frames?
 *
 * Motivation, from `trace_long_tasks.mjs` over a 6-drawer trace: seven of the
 * eight worst main-thread tasks (62-87 ms each) were 66-79% ONE function,
 * `_readSourceAlpha (canvas/TiledLayerCanvas.js:748)` — a single synchronous
 * full-canvas `getImageData`, i.e. a GPU readback that stalls the pipeline
 * until it returns. That readback exists only to decide which tiles are blank
 * and can be skipped, so it exists only when tiling is on — and tiling
 * DEFAULTS ON for new rooms (`server/RoomManager.js:92`).
 *
 * Ablates ONLY the readback, not tiling itself. `_readSourceAlpha` returning
 * null makes `_skipTile` answer "nothing is skippable", so every touched tile
 * is allocated and drawn — per its own comment that "costs memory, never
 * pixels". Tiling stays ON in both arms and no canvas is ever reshaped.
 *
 * An earlier version of this toggled `setTiledBackingStore` per arm and was
 * discarded: that stitches the whole board to a full raster and re-slices it on
 * every switch, which injected 500-900 ms stalls into BOTH arms (the real trace's
 * worst task was 86.7 ms) and left the tiled arm with zero allocated tiles. The
 * harness was louder than the effect.
 *
 * This measures STUTTER, not throughput, because that is the distinction the
 * whole investigation turned on: a client can be 80% busy and feel fine if the
 * work is spread evenly, and feel terrible at the same 80% if it arrives in
 * 65 ms blocks. Total-time accounting hid this completely — the same cost read
 * as an unremarkable "5.0% of thread".
 *
 * Primary metrics are long-task time and the tail of the frame-gap
 * distribution (p99, max, count over 50 ms). Busy% is kept only for continuity
 * with earlier runs; it is NOT the metric to judge this on.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/tiled_stutter_ab.mjs --reps=9
 */
import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'perf-results');

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.APP_URL || 'http://localhost:3000/go/';
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8030';
const VUS = Number(flag('vus', 6));
const K6_TOOLS = flag('k6tools', 'brush');
const SPECIAL = flag('special', '0');
const REPS = Number(flag('reps', 9));
const WINDOW_SEC = Number(flag('window', 10));
const ARM_SETTLE_SEC = Number(flag('armsettle', 4));
const SETTLE_SEC = Number(flag('settle', 12));
const LABEL = flag('label', 'readback_stutter_ab');
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 180000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 300000 });
const origin = new URL(TARGET_URL).origin;
const open = (await browser.pages()).filter((p) => p.url().startsWith(origin));
for (let i = 1; i < open.length; i++) await open[i].close();
const page = open[0] || await browser.newPage();
await page.bringToFront();
if (!(await page.evaluate(() => !!window.app).catch(() => false))) {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
}
console.log('waiting for app...');
await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
  { timeout: READY_TIMEOUT, polling: 1000 });

const room = 'rback_' + Date.now();
await page.evaluate((r) => { window.app.self.username = 'TILEAB'; window.app.handleRoomSelected(r); }, room);
await page.waitForFunction(() => window.app?.board?.dimensions?.[0] > 0, { timeout: 90000, polling: 500 });
await page.evaluate(async () => { window.__wakeLock = await navigator.wakeLock.request('screen').catch(() => null); });
console.log('joined room', room);

// Long-task observer, installed once. PerformanceObserver('longtask') reports
// main-thread tasks over 50ms — precisely the frames that read as a hitch.
await page.evaluate(() => {
  window.__longTasks = [];
  window.__ltObs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push(e.duration);
  });
  try { window.__ltObs.observe({ entryTypes: ['longtask'] }); window.__ltOk = true; }
  catch { window.__ltOk = false; }
});
if (!(await page.evaluate(() => window.__ltOk))) {
  console.error('!! longtask observer unavailable — cannot measure stutter');
  process.exit(1);
}

// Patch the PROTOTYPE, not the instance: flatCanvas is rebuilt on resize, and
// an instance override would silently vanish mid-run.
const patched = await page.evaluate(() => {
  const fc = window.app.board.layerManager.layerGroups[0]?.flatCanvas;
  const proto = fc && Object.getPrototypeOf(fc);
  if (!proto || typeof proto._readSourceAlpha !== 'function') return false;
  const original = proto._readSourceAlpha;
  window.__readbackCalls = 0;
  window.__setReadback = (on) => {
    proto._readSourceAlpha = on
      ? function (...a) { window.__readbackCalls++; return original.apply(this, a); }
      : function () { window.__readbackCalls++; return null; };
  };
  window.__setReadback(true);
  return true;
});
if (!patched) { console.error('!! layer 0 is not tiled — nothing to ablate'); process.exit(1); }

const totalSec = SETTLE_SEC + REPS * 2 * (WINDOW_SEC + ARM_SETTLE_SEC) + 40;
const k6 = spawn('k6', ['run', '-e', 'ROOM=' + room, '-e', 'TARGET_URL=' + WS_URL,
  '-e', 'TOOLS=' + K6_TOOLS, '-e', 'SPECIAL_CHANCE=' + SPECIAL,
  '--vus=' + VUS, '--duration=' + totalSec + 's', 'testing/medium_stress_test.js'],
{ cwd: REPO_ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
console.log('k6 spawned (' + VUS + ' VUs, ' + K6_TOOLS + ') for ' + totalSec + 's; settling ' + SETTLE_SEC + 's...');
await sleep(SETTLE_SEC * 1000);
console.log('users in room:', await page.evaluate(() => window.app.users?.size ?? 0));

const cdp = await page.target().createCDPSession();
await cdp.send('Performance.enable');

async function measure(arm) {
  const on = arm === 'readback';
  await page.evaluate((v) => { window.__setReadback(v); window.__readbackCalls = 0; }, on);
  await sleep(ARM_SETTLE_SEC * 1000);

  const asMap = (m) => Object.fromEntries(m.map((x) => [x.name, x.value]));
  const mb = asMap((await cdp.send('Performance.getMetrics')).metrics);
  await page.evaluate(() => {
    window.__longTasks = [];
    window.__abFrames = [];
    window.__abRaf = true;
    (function loop(t) { window.__abFrames.push(t); if (window.__abRaf) requestAnimationFrame(loop); })(performance.now());
  });
  await sleep(WINDOW_SEC * 1000);
  const { frames, longTasks } = await page.evaluate(() => {
    window.__abRaf = false;
    return { frames: window.__abFrames, longTasks: window.__longTasks };
  });
  const ma = asMap((await cdp.send('Performance.getMetrics')).metrics);

  const span = (ma.Timestamp - mb.Timestamp) || 1;
  const gaps = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  const dur = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0;

  return {
    // Primary: stutter.
    longTaskCount: longTasks.length,
    longTaskMs: +longTasks.reduce((a, b) => a + b, 0).toFixed(1),
    longTaskMax: +(longTasks.length ? Math.max(...longTasks) : 0).toFixed(1),
    gapP99: +pct(0.99).toFixed(1),
    gapMax: +(sorted.length ? sorted[sorted.length - 1] : 0).toFixed(1),
    gapsOver50: gaps.filter((v) => v > 50).length,
    // Secondary, for continuity only.
    busyPct: +((((ma.TaskDuration ?? 0) - (mb.TaskDuration ?? 0)) / span) * 100).toFixed(2),
    fps: dur > 0 ? +((frames.length - 1) / (dur / 1000)).toFixed(2) : 0,
    readbackCalls: await page.evaluate(() => window.__readbackCalls),
  };
}

function wilcoxon(deltas) {
  const nz = deltas.filter((d) => d !== 0);
  const n = nz.length;
  if (n < 5) return { n, note: 'n<5' };
  const ranked = nz.map((d) => ({ d, abs: Math.abs(d), rank: 0 })).sort((a, b) => a.abs - b.abs);
  let i = 0;
  while (i < ranked.length) {
    let j = i;
    while (j + 1 < ranked.length && ranked[j + 1].abs === ranked[i].abs) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranked[k].rank = avg;
    i = j + 1;
  }
  const wPlus = ranked.filter((r) => r.d > 0).reduce((a, r) => a + r.rank, 0);
  const wMinus = ranked.filter((r) => r.d < 0).reduce((a, r) => a + r.rank, 0);
  const crit = { 5: 0, 6: 2, 7: 3, 8: 5, 9: 5, 10: 8, 11: 10, 12: 13, 13: 17, 14: 21 }[n];
  return { n, wPlus, wMinus, W: Math.min(wPlus, wMinus), crit, significant: crit !== undefined ? Math.min(wPlus, wMinus) <= crit : null };
}

const reps = [];
for (let r = 0; r < REPS; r++) {
  const order = r % 2 === 0 ? ['readback', 'noreadback'] : ['noreadback', 'readback'];
  const out = {};
  for (const arm of order) {
    const m = await measure(arm);
    out[arm] = m;
    console.log('rep' + (r + 1) + ' ' + arm.padEnd(7) + ': longTasks ' + String(m.longTaskCount).padStart(3)
      + ' (' + String(m.longTaskMs).padStart(7) + 'ms, max ' + String(m.longTaskMax).padStart(6) + ')'
      + '  gapP99 ' + String(m.gapP99).padStart(6) + '  gapMax ' + String(m.gapMax).padStart(7)
      + '  >50ms ' + String(m.gapsOver50).padStart(3) + '  busy ' + m.busyPct + '%  fps ' + m.fps
      + '  calls ' + m.readbackCalls);
  }
  reps.push(out);
}
await page.evaluate(() => window.__setReadback(true));
try { k6.kill(); } catch { /* already gone */ }

// Positive delta = removing tiling helped (tiled was worse).
const d = (f) => reps.map((r) => +(f(r.readback) - f(r.noreadback)).toFixed(2));
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const metrics = {
  longTaskMs: d((m) => m.longTaskMs),
  longTaskCount: d((m) => m.longTaskCount),
  longTaskMax: d((m) => m.longTaskMax),
  gapP99: d((m) => m.gapP99),
  gapMax: d((m) => m.gapMax),
  gapsOver50: d((m) => m.gapsOver50),
  busyPct: d((m) => m.busyPct),
};
const summary = {
  label: LABEL, room, reps: REPS, vus: VUS, k6tools: K6_TOOLS, windowSec: WINDOW_SEC,
  note: 'positive delta = the readback was WORSE (removing it helped)',
  medians: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, med(v)])),
  wilcoxon: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, wilcoxon(v)])),
  deltas: metrics,
  reps,
};
fs.writeFileSync(path.join(OUT_DIR, LABEL + '.json'), JSON.stringify(summary, null, 2));
console.log('\n=== TILED BACKING STORE vs STUTTER (positive = tiling was worse) ===');
console.log(JSON.stringify({ ...summary, reps: undefined, deltas: undefined }, null, 2));
await browser.disconnect();
