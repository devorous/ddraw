/**
 * Does cutting the weak client's RECEIVED message count actually cut its busy
 * time? Interleaved paired A/B of `WebSocketClient._debugMmKeepEveryN`, which
 * drops all but 1 in N inbound MM messages per sender — a client-side stand-in
 * for the proposed server-side per-recipient coalescer, measured before any
 * server code exists.
 *
 * The ablation is an UPPER BOUND on that idea: dropping a message discards its
 * points as well as its per-message overhead, whereas a real coalescer would
 * merge points into fewer messages and still apply every one of them. If even
 * this bound is small, the server-side design cannot pay for itself.
 *
 * Both arms run inside ONE page session against ONE continuous k6 load, and
 * the arm order flips every rep, because sequential runs on the Chromebook
 * drift downward across a session by more than the effect being measured.
 * Judged with a Wilcoxon signed-rank over per-rep deltas (a sign test throws
 * away magnitude and has called a real win a coin flip on this box before).
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/inbound_ablation_ab.mjs --keep=6 --reps=5
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
const KEEP_N = Number(flag('keep', 6));
const REPS = Number(flag('reps', 5));
const WINDOW_SEC = Number(flag('window', 10));
const ARM_SETTLE_SEC = Number(flag('armsettle', 3));
const SETTLE_SEC = Number(flag('settle', 12));
const LABEL = flag('label', 'ablate_keep' + KEEP_N);
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

// Vite does not reliably hot-swap class methods into a running page; without
// this check the "ablated" arm can silently be a second copy of the control.
const hasKnob = await page.evaluate(() => window.app.wsClient._debugMmKeepEveryN !== undefined);
if (!hasKnob) {
  console.error('!! _debugMmKeepEveryN missing — page is running stale code. Force-reload and retry.');
  process.exit(1);
}

const room = 'ablate_' + Date.now();
await page.evaluate((r) => { window.app.self.username = 'ABLATE'; window.app.handleRoomSelected(r); }, room);
await page.waitForFunction(() => window.app?.board?.dimensions?.[0] > 0, { timeout: 90000, polling: 500 });
await page.evaluate(async () => { window.__wakeLock = await navigator.wakeLock.request('screen').catch(() => null); });
console.log('joined room', room);

const totalSec = SETTLE_SEC + REPS * 2 * (WINDOW_SEC + ARM_SETTLE_SEC) + 40;
const k6 = spawn('k6', ['run', '-e', 'ROOM=' + room, '-e', 'TARGET_URL=' + WS_URL,
  '-e', 'TOOLS=' + K6_TOOLS, '-e', 'SPECIAL_CHANCE=' + SPECIAL,
  '--vus=' + VUS, '--duration=' + totalSec + 's', 'testing/medium_stress_test.js'],
{ cwd: REPO_ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
console.log('k6 spawned (' + VUS + ' VUs, ' + K6_TOOLS + ', special=' + SPECIAL + ') for ' + totalSec + 's; settling ' + SETTLE_SEC + 's...');
await sleep(SETTLE_SEC * 1000);
console.log('users in room:', await page.evaluate(() => window.app.users?.size ?? 0));

const cdp = await page.target().createCDPSession();
await cdp.send('Performance.enable');

async function measure(keepN) {
  await page.evaluate((n) => {
    window.app.wsClient._debugMmKeepEveryN = n;
    window.app.wsClient._debugMmDropped = 0;
  }, keepN);
  await sleep(ARM_SETTLE_SEC * 1000);

  const asMap = (m) => Object.fromEntries(m.map((x) => [x.name, x.value]));
  const mb = asMap((await cdp.send('Performance.getMetrics')).metrics);
  const dbgB = await page.evaluate(() => window.app.remoteUserHandler.getDebugStats());
  await page.evaluate(() => {
    window.__abFrames = [];
    window.__abRaf = true;
    (function loop(t) { window.__abFrames.push(t); if (window.__abRaf) requestAnimationFrame(loop); })(performance.now());
  });
  await sleep(WINDOW_SEC * 1000);
  const frames = await page.evaluate(() => { window.__abRaf = false; return window.__abFrames; });
  const ma = asMap((await cdp.send('Performance.getMetrics')).metrics);
  const dbgA = await page.evaluate(() => window.app.remoteUserHandler.getDebugStats());
  const dropped = await page.evaluate(() => window.app.wsClient._debugMmDropped);

  const span = (ma.Timestamp - mb.Timestamp) || 1;
  const gaps = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1]);
  const dur = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0;
  return {
    busyPct: +((((ma.TaskDuration ?? 0) - (mb.TaskDuration ?? 0)) / span) * 100).toFixed(2),
    scriptPct: +((((ma.ScriptDuration ?? 0) - (mb.ScriptDuration ?? 0)) / span) * 100).toFixed(2),
    fps: dur > 0 ? +((frames.length - 1) / (dur / 1000)).toFixed(2) : 0,
    stalls: gaps.filter((v) => v > 16).length,
    applied: (dbgA.previewCallCount || 0) - (dbgB.previewCallCount || 0),
    dropped,
    frames: frames.length,
  };
}

// Wilcoxon signed-rank with the exact small-n critical table (two-tailed, 0.05).
function wilcoxon(deltas) {
  const nz = deltas.filter((d) => d !== 0);
  const n = nz.length;
  if (n < 5) return { n, note: 'n<5, no exact critical value' };
  const ranked = nz.map((d) => ({ d, abs: Math.abs(d), rank: 0 })).sort((a, b) => a.abs - b.abs);
  let i = 0;
  while (i < ranked.length) { // average ranks across ties
    let j = i;
    while (j + 1 < ranked.length && ranked[j + 1].abs === ranked[i].abs) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranked[k].rank = avg;
    i = j + 1;
  }
  const wPlus = ranked.filter((r) => r.d > 0).reduce((a, r) => a + r.rank, 0);
  const wMinus = ranked.filter((r) => r.d < 0).reduce((a, r) => a + r.rank, 0);
  const crit = { 5: 0, 6: 2, 7: 3, 8: 5, 9: 5, 10: 8, 11: 10, 12: 13 }[n];
  const W = Math.min(wPlus, wMinus);
  return { n, wPlus, wMinus, W, crit, significant: crit !== undefined ? W <= crit : null };
}

const reps = [];
for (let r = 0; r < REPS; r++) {
  // Flip the order every rep so a monotonic within-session drift cancels
  // instead of loading entirely onto whichever arm always runs second.
  const order = r % 2 === 0 ? [1, KEEP_N] : [KEEP_N, 1];
  const out = {};
  for (const keepN of order) {
    const m = await measure(keepN);
    out[keepN === 1 ? 'control' : 'ablated'] = m;
    console.log('rep' + (r + 1) + ' keep=' + keepN + ': busy ' + m.busyPct + '% script ' + m.scriptPct
      + '% fps ' + m.fps + ' stalls ' + m.stalls + ' applied ' + m.applied + ' dropped ' + m.dropped);
  }
  reps.push(out);
}
await page.evaluate(() => { window.app.wsClient._debugMmKeepEveryN = 1; });
try { k6.kill(); } catch { /* already gone */ }

const dBusy = reps.map((r) => +(r.control.busyPct - r.ablated.busyPct).toFixed(2)); // >0 = ablation helped
const dFps = reps.map((r) => +(r.ablated.fps - r.control.fps).toFixed(2));          // >0 = ablation helped
const dStalls = reps.map((r) => r.control.stalls - r.ablated.stalls);
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const summary = {
  label: LABEL, room, keepEveryN: KEEP_N, reps: REPS, vus: VUS, k6tools: K6_TOOLS,
  specialChance: SPECIAL, windowSec: WINDOW_SEC,
  medianControlBusyPct: med(reps.map((r) => r.control.busyPct)),
  medianAblatedBusyPct: med(reps.map((r) => r.ablated.busyPct)),
  medianAppliedControl: med(reps.map((r) => r.control.applied)),
  medianAppliedAblated: med(reps.map((r) => r.ablated.applied)),
  deltaBusyPct: dBusy, medianDeltaBusyPct: med(dBusy), wilcoxonBusy: wilcoxon(dBusy),
  deltaFps: dFps, medianDeltaFps: med(dFps), wilcoxonFps: wilcoxon(dFps),
  deltaStalls: dStalls, medianDeltaStalls: med(dStalls),
  reps,
};
fs.writeFileSync(path.join(OUT_DIR, LABEL + '.json'), JSON.stringify(summary, null, 2));
console.log('\n=== ABLATION SUMMARY (positive delta = dropping messages helped) ===');
console.log(JSON.stringify({ ...summary, reps: undefined }, null, 2));
await browser.disconnect();
