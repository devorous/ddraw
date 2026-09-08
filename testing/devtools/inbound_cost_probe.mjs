/**
 * Captures a CPU-profiled trace of the weak client under a fixed k6 load, so
 * the inbound-message cost can be attributed function-by-function offline.
 *
 * The question this exists to answer: of the renderer's busy time under
 * multi-user load, how much is spent RECEIVING other users' stroke messages
 * (decode -> dispatch -> RemoteUserHandler state update + stamp painting) vs.
 * the remote-preview RENDER that the client-side throttle already defers?
 * Only the first is what a server-side per-recipient coalescer could remove,
 * so it bounds that idea's payoff before any server code gets written.
 *
 * Captures ONE trace per run and writes it locally — analyse it as many ways
 * as you like with trace_function_report.mjs --roots=... rather than paying
 * for another run on the Chromebook.
 *
 * Usage (kyle-book, over the CDP tunnel):
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/inbound_cost_probe.mjs --label=base
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
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.APP_URL || 'http://localhost:3000/go/';
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8030';
const VUS = Number(flag('vus', process.env.VUS || 6));
const K6_TOOLS = flag('k6tools', process.env.K6_TOOLS || 'brush');
const WINDOW_SEC = Number(flag('window', process.env.WINDOW_SEC || 15));
const SETTLE_SEC = Number(flag('settle', process.env.SETTLE_SEC || 12));
const LABEL = flag('label', 'inbound');
// medium_stress_test's special actions (selection transform / flood fill /
// undo / blend swap) fire regardless of TOOLS. Set 0 to measure the pure
// stroke-relay path this probe exists to weigh.
const SPECIAL_CHANCE = flag('special', process.env.SPECIAL_CHANCE || '0.18');
// Lean categories: a long capture is the only way to see periodic stalls whose
// period exceeds a short trace window (the parity heartbeat is 30s), but a full
// category set at 60s+ produces a trace too large to parse. This keeps the CPU
// profiler and the timeline and drops the rasterizer/compositor detail.
const LEAN = process.argv.includes('--lean');
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 180000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.connect({
  browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 300000,
});

// Session restore can reopen a stale duplicate of the app tab; extras keep
// drawing/compositing and would show up in the trace as someone else's cost.
const origin = new URL(TARGET_URL).origin;
let pages = (await browser.pages()).filter((p) => p.url().startsWith(origin));
for (let i = 1; i < pages.length; i++) await pages[i].close();
let page = pages[0] || await browser.newPage();
await page.bringToFront();

if (!(await page.evaluate(() => !!window.app).catch(() => false))) {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
}
console.log('waiting for app...');
await page.waitForFunction(
  () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
  { timeout: READY_TIMEOUT, polling: 1000 },
);

const room = `inbound_${Date.now()}`;
await page.evaluate((r) => { window.app.self.username = 'PROBE'; window.app.handleRoomSelected(r); }, room);
await page.waitForFunction(() => window.app?.board?.dimensions?.[0] > 0, { timeout: 90000, polling: 500 });
// PowerDevil blanks the panel on its own timer, which kills rAF while
// visibilityState still reads "visible" — a trace of a blanked screen looks
// beautifully idle and means nothing.
await page.evaluate(async () => { window.__wakeLock = await navigator.wakeLock.request('screen').catch(() => null); });
console.log('joined room', room);

const totalSec = SETTLE_SEC + WINDOW_SEC + 20;
const k6 = spawn('k6', [
  'run', '-e', `ROOM=${room}`, '-e', `TARGET_URL=${WS_URL}`, '-e', `TOOLS=${K6_TOOLS}`,
  '-e', `SPECIAL_CHANCE=${SPECIAL_CHANCE}`,
  `--vus=${VUS}`, `--duration=${totalSec}s`, 'testing/medium_stress_test.js',
], { cwd: REPO_ROOT, stdio: 'ignore', shell: process.platform === 'win32' });

console.log(`k6 spawned (${VUS} VUs, tool=${K6_TOOLS}, special=${SPECIAL_CHANCE}), settling ${SETTLE_SEC}s...`);
await sleep(SETTLE_SEC * 1000);
console.log('users in room:', await page.evaluate(() => window.app.users?.size ?? 0));

const tracePath = path.join(OUT_DIR, `${LABEL}_trace.json`);
const cdp = await page.target().createCDPSession();
await cdp.send('Performance.enable');
const before = (await cdp.send('Performance.getMetrics')).metrics;
const dbgBefore = await page.evaluate(() => window.app.remoteUserHandler.getDebugStats());

await page.tracing.start({
  path: tracePath,
  categories: LEAN
    ? ['devtools.timeline', 'toplevel', 'disabled-by-default-v8.cpu_profiler']
    : [
      'devtools.timeline', 'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', 'gpu',
      'toplevel', 'viz', 'benchmark', 'v8',
      // Without this there are no samples and the whole run is wasted.
      'disabled-by-default-v8.cpu_profiler',
    ],
});
await page.evaluate(() => {
  window.__probeFrames = [];
  window.__probeRaf = true;
  (function loop(t) { window.__probeFrames.push(t); if (window.__probeRaf) requestAnimationFrame(loop); })(performance.now());
});
console.log(`tracing ${WINDOW_SEC}s...`);
await sleep(WINDOW_SEC * 1000);

const frames = await page.evaluate(() => { window.__probeRaf = false; return window.__probeFrames; });
// Sample metrics BEFORE tracing.stop(): the trace flush is slower than the
// measurement and dilutes every percentage to roughly a third.
const after = (await cdp.send('Performance.getMetrics')).metrics;
const dbgAfter = await page.evaluate(() => window.app.remoteUserHandler.getDebugStats());
await page.tracing.stop();
await cdp.detach().catch(() => {});
try { k6.kill(); } catch {}

const asMap = (m) => Object.fromEntries(m.map((x) => [x.name, x.value]));
const mb = asMap(before), ma = asMap(after);
const spanSec = (ma.Timestamp - mb.Timestamp) || 1;
const pct = (k) => +((((ma[k] ?? 0) - (mb[k] ?? 0)) / spanSec) * 100).toFixed(1);

const gaps = [];
for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1]);
const durMs = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0;

const summary = {
  label: LABEL, room, vus: VUS, k6tools: K6_TOOLS, specialChance: SPECIAL_CHANCE, windowSec: WINDOW_SEC,
  spanSec: +spanSec.toFixed(1),
  taskBusyPct: pct('TaskDuration'),
  scriptPct: pct('ScriptDuration'),
  layoutPct: pct('LayoutDuration'),
  recalcStylePct: pct('RecalcStyleDuration'),
  fps: durMs > 0 ? +((frames.length - 1) / (durMs / 1000)).toFixed(1) : 0,
  stallsOver16: gaps.filter((v) => v > 16).length,
  previewCalls: (dbgAfter.previewCallCount || 0) - (dbgBefore.previewCallCount || 0),
  previewFires: (dbgAfter.previewFireCount || 0) - (dbgBefore.previewFireCount || 0),
  tracePath,
};
fs.writeFileSync(path.join(OUT_DIR, `${LABEL}_summary.json`), JSON.stringify(summary, null, 2));
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));
if (frames.length === 0) console.log('\n!! ZERO FRAMES — display likely blanked; result is meaningless.');
await browser.disconnect();
