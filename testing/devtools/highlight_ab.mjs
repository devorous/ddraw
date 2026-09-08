/**
 * Interleaved paired A/B of the edge-triggered `_refreshRecentActivityHighlight`
 * fix in `src/ui/RemoteUserUI.js`.
 *
 * The control arm is installed at RUNTIME as an own-property override that
 * restores the previous per-sample implementation verbatim, so both arms run
 * inside one page session against one continuous k6 load. Sequential runs on
 * the Chromebook drift downward across a session by more than this effect, and
 * stashing the file between arms would cost a full page reload per arm.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/highlight_ab.mjs --reps=9
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
const ARM_SETTLE_SEC = Number(flag('armsettle', 3));
const SETTLE_SEC = Number(flag('settle', 12));
const LABEL = flag('label', 'highlight_ab');
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

// Vite does not reliably hot-swap class methods into a running page. The fixed
// version is the one that introduces _activeHighlightUntil; without it the
// "fixed" arm would silently be a second copy of the control.
// `remoteUserHandler.ui` is the UI facade; RemoteUserUI is the instance it
// delegates to, and the one that owns the highlight state.
const ready = await page.evaluate(() => {
  const ui = window.app?.remoteUserHandler?.ui?.remoteUserUI;
  return { hasUi: !!ui, ctor: ui?.constructor?.name ?? null, fixed: !!ui && ui._activeHighlightUntil !== undefined };
});
if (!ready.hasUi) { console.error('!! UI.remoteUserUI not found'); process.exit(1); }
if (!ready.fixed) { console.error('!! page is running the OLD RemoteUserUI (no _activeHighlightUntil). Force-reload and retry.'); process.exit(1); }

const room = 'hl_' + Date.now();
await page.evaluate((r) => { window.app.self.username = 'HLAB'; window.app.handleRoomSelected(r); }, room);
await page.waitForFunction(() => window.app?.board?.dimensions?.[0] > 0, { timeout: 90000, polling: 500 });
await page.evaluate(async () => { window.__wakeLock = await navigator.wakeLock.request('screen').catch(() => null); });
console.log('joined room', room);

// Install the legacy implementation as an own property so it can be added and
// removed per arm; the prototype keeps the fixed one untouched underneath.
await page.evaluate(() => {
  const ui = window.app.remoteUserHandler.ui.remoteUserUI;
  window.__installLegacyHighlight = () => {
    ui._refreshRecentActivityHighlight = function (userId) {
      const key = String(userId);
      const entry = document.querySelector('.userEntry.u' + userId);
      if (entry) entry.classList.add('recently-active');
      const groupInfo = this._getGroupForUser(userId);
      if (groupInfo) groupInfo.group.element.classList.add('recently-active');
      const existing = this._activeHighlightTimers.get(key);
      if (existing) clearTimeout(existing);
      this._activeHighlightTimers.set(key, setTimeout(() => {
        this._activeHighlightTimers.delete(key);
        document.querySelector('.userEntry.u' + userId)?.classList.remove('recently-active');
        const info = this._getGroupForUser(userId);
        if (info) {
          const anyActive = Array.from(info.group.userIds).some((id) => this._activeHighlightTimers.has(String(id)));
          if (!anyActive) info.group.element.classList.remove('recently-active');
        }
      }, 30000));
    };
  };
  window.__restoreFixedHighlight = () => { delete ui._refreshRecentActivityHighlight; };
});

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
  await page.evaluate((a) => {
    if (a === 'legacy') window.__installLegacyHighlight();
    else window.__restoreFixedHighlight();
  }, arm);
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

  const span = (ma.Timestamp - mb.Timestamp) || 1;
  const gaps = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1]);
  const dur = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0;
  return {
    busyPct: +((((ma.TaskDuration ?? 0) - (mb.TaskDuration ?? 0)) / span) * 100).toFixed(2),
    scriptPct: +((((ma.ScriptDuration ?? 0) - (mb.ScriptDuration ?? 0)) / span) * 100).toFixed(2),
    stylePct: +((((ma.RecalcStyleDuration ?? 0) - (mb.RecalcStyleDuration ?? 0)) / span) * 100).toFixed(2),
    fps: dur > 0 ? +((frames.length - 1) / (dur / 1000)).toFixed(2) : 0,
    stalls: gaps.filter((v) => v > 16).length,
    applied: (dbgA.previewCallCount || 0) - (dbgB.previewCallCount || 0),
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
  const W = Math.min(wPlus, wMinus);
  return { n, wPlus, wMinus, W, crit, significant: crit !== undefined ? W <= crit : null };
}

const reps = [];
for (let r = 0; r < REPS; r++) {
  const order = r % 2 === 0 ? ['legacy', 'fixed'] : ['fixed', 'legacy'];
  const out = {};
  for (const arm of order) {
    const m = await measure(arm);
    out[arm] = m;
    console.log('rep' + (r + 1) + ' ' + arm.padEnd(6) + ': busy ' + m.busyPct + '% script ' + m.scriptPct
      + '% style ' + m.stylePct + '% fps ' + m.fps + ' stalls ' + m.stalls + ' applied ' + m.applied);
  }
  reps.push(out);
}
await page.evaluate(() => window.__restoreFixedHighlight());
try { k6.kill(); } catch { /* already gone */ }

const dBusy = reps.map((r) => +(r.legacy.busyPct - r.fixed.busyPct).toFixed(2));  // >0 = fix helped
const dScript = reps.map((r) => +(r.legacy.scriptPct - r.fixed.scriptPct).toFixed(2));
const dFps = reps.map((r) => +(r.fixed.fps - r.legacy.fps).toFixed(2));
const dStalls = reps.map((r) => r.legacy.stalls - r.fixed.stalls);
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const summary = {
  label: LABEL, room, reps: REPS, vus: VUS, k6tools: K6_TOOLS, windowSec: WINDOW_SEC,
  medianLegacyBusyPct: med(reps.map((r) => r.legacy.busyPct)),
  medianFixedBusyPct: med(reps.map((r) => r.fixed.busyPct)),
  deltaBusyPct: dBusy, medianDeltaBusyPct: med(dBusy), wilcoxonBusy: wilcoxon(dBusy),
  deltaScriptPct: dScript, medianDeltaScriptPct: med(dScript), wilcoxonScript: wilcoxon(dScript),
  deltaFps: dFps, medianDeltaFps: med(dFps), wilcoxonFps: wilcoxon(dFps),
  deltaStalls: dStalls, medianDeltaStalls: med(dStalls), wilcoxonStalls: wilcoxon(dStalls),
  reps,
};
fs.writeFileSync(path.join(OUT_DIR, LABEL + '.json'), JSON.stringify(summary, null, 2));
console.log('\n=== HIGHLIGHT FIX A/B (positive delta = fix helped) ===');
console.log(JSON.stringify({ ...summary, reps: undefined }, null, 2));
await browser.disconnect();
