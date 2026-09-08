#!/usr/bin/env node
/**
 * @fileoverview Repeatable before/after measurement for the board-size lag work.
 *
 * Session 4 established the cost model (see "Session 4 — measured" in
 * docs/board_size_lag_plan_2026-08-23.md): the binding constraint is GPU memory
 * capacity, the cliff sits near 2 GB of `GPUTask.args.data.used_bytes`, and the
 * dominant term is USER COUNT rather than board area. Those numbers were taken
 * by hand through the DevTools MCP, which is fine for discovery and useless for
 * judging a change. This script exists so "did that help" has one answer.
 *
 * It measures four things, and all four are needed:
 *   - GPU used_bytes (peak)   the capacity headroom that actually stalls
 *   - stalls > 16 ms          how often the user feels it
 *   - worst stall             how bad it feels
 *   - canvas census MB        which holder to blame, from inside the app
 *
 * Usage:
 *   node testing/devtools/board_perf_suite.mjs --label=before
 *   node testing/devtools/board_perf_suite.mjs --label=after-stage3
 *   node testing/devtools/board_perf_suite.mjs --label=x --size=1440p --vus=6
 *   node testing/devtools/board_perf_suite.mjs --compare=before,after-stage3
 *
 * Results land in testing/devtools/perf-results/<label>.json so any two runs can
 * be diffed later with --compare.
 *
 * HEADED BY DEFAULT, DELIBERATELY. Headless Chrome falls back to SwiftShader on
 * most setups, which puts canvases in software and makes `used_bytes` either
 * absent or meaningless — the run would look clean for the wrong reason. Pass
 * --headless only if you have confirmed real GPU rasterization.
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'perf-results');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const LABEL = arg('label', null);
const COMPARE = arg('compare', null);
const SIZE = arg('size', '1440p');
const VUS = Number(arg('vus', 6));
const DURATION = arg('duration', '60s');
const STROKES = Number(arg('strokes', 14));
// Long-window mode: trace for N seconds of LIGHT, intermittent drawing instead
// of one dense burst. Everything periodic and board-proportional — the 6 s
// timelapse composite, snapshot and thumbnail encodes — is invisible to a
// 3-second window, and with 1-2 users the local client is always the elected
// uploader, so it pays all of them itself. That is the shape of the originally
// reported symptom (large board, one or two users, barely drawing) and the
// default burst workload cannot see it.
const WINDOW_SEC = Number(arg('window', 0));

// --weak emulates a low-end client on capable hardware.
//
// The reported symptom is board-size-dependent lag with 1-2 users on OTHER
// people's machines, and it is unreproducible here for a measurable reason:
// the GPU memory cliff on this box sits near 2 GB, while 1440p solo uses
// ~178 MB. A 4 GB Intel UHD sharing system memory has a budget closer to
// 256-512 MB, which puts 1440p solo AT the cliff and anything larger past it.
// Freeing memory therefore cannot show a benefit here and should show a large
// one there — so the fixes have to be judged in this regime, not the default.
//
//   --force-gpu-mem-available-mb  caps the GPU budget to a weak-device level
//   --disable-gpu-rasterization   CPU raster, how integrated graphics behaves
//                                 on large canvases
//   --cpu=N                       CDP CPU throttle for the slow-core side
//
// This is a proxy for the constraint, not for the device. Real driver
// behaviour, real memory pressure and mobile GPUs still need real hardware —
// but only worth spending once this says the fix works.
const WEAK = flag('weak');
const GPU_MEM_MB = Number(arg('gpumem', WEAK ? 256 : 0));
const CPU_THROTTLE = Number(arg('cpu', WEAK ? 4 : 1));
const HEADLESS = flag('headless');
const REPEAT = Number(arg('repeat', 1));
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8030';
// Attach to an already-running Chrome instead of launching one, e.g.
// CDP_URL=http://127.0.0.1:9222 pointing at an `ssh -L` forward of the
// Chromebook's DevTools port. The launch flags below (window size, GPU
// rasterization, --force-gpu-mem-available-mb) are start-up only, so when
// attaching they must be passed when that Chrome is launched instead.
const CDP_URL = process.env.CDP_URL || '';
// The N4500 needs well over 60s for the auth system to fall back to guest mode
// on a cold load, and window.app only exists after that.
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 60_000);
// Turn off the rolling tape (History -> Recent) for this session, to measure
// what continuous stroke recording costs. Note the gallery time-lapse capturer
// is already inert here: it needs role >= 7 and the suite joins as a guest.
const DISABLE_REPLAY = process.env.DISABLE_REPLAY === '1';
const K6_SCRIPT = arg('k6script', 'testing/medium_stress_test.js');
// Restrict the bots to specific tools, e.g. --k6tools=ink,pen. With all 18
// tools in the pool any one of them is ~5.5 % of traffic, which is below this
// suite's run-to-run noise — narrowing the pool is how a single tool's render
// path gets enough signal to judge.
const K6_TOOLS = arg('k6tools', null);
// Which tool the LOCAL driven client draws with. --k6tools only changes what the
// BOTS do; without this the local strokes are always the default brush, so a
// tool whose cost lands on the drawing client's own render path (the eraser
// composites its preview into the layer stack every tick, the brush does not)
// is invisible no matter what the bots are set to.
const LOCAL_TOOL = arg('localtool', null);
// Force layer 0 onto the tiled backing store, arm-locked against a
// ROOM_UPDATE reverting it. --content pre-paints a synthetic dense|sparse
// base before measuring, matching tiled_ab.mjs's regimes.
const TILED = flag('tiled');
const CONTENT = arg('content', null);
// Force the LOCAL driven client's Low-Power Mode preference before measuring
// ('on'|'off'|'auto'). Without this the run just inherits whatever the
// attached browser's stored preference already is.
const LOW_POWER = arg('lowpower', null);

const BOARD_SIZES = {
  '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560],
  'big': [1800, 3200], '4k': [2160, 3840], '8k': [4320, 7680], '12k': [6480, 11520],
  // 16k: not a real preset (shared/boardSizes.js tops out at 12k) — added here
  // only to see whether tiling makes an even-larger board survivable on weak
  // hardware. 15360/32=480 and 8640/18=480, so it lands on the exact 32x18
  // grid same as every other 16:9 preset, not the ragged 256px fallback.
  '16k': [8640, 15360]
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── comparison mode ────────────────────────────────────────────────────────
if (COMPARE) {
  const [a, b] = COMPARE.split(',').map((s) => s.trim());
  const load = (l) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${l}.json`), 'utf8'));
  const A = load(a); const B = load(b);
  const row = (name, get, unit = '', betterLower = true) => {
    const va = get(A); const vb = get(B);
    const d = vb - va;
    const pct = va ? ((d / va) * 100).toFixed(0) : '—';
    const good = betterLower ? d < 0 : d > 0;
    const mark = Math.abs(d) < 1e-9 ? '  ' : (good ? '✔ ' : '✘ ');
    console.log(`  ${mark}${name.padEnd(26)} ${String(va).padStart(9)}${unit} → ${String(vb).padStart(9)}${unit}   ${d >= 0 ? '+' : ''}${d.toFixed(0)}${unit} (${pct}%)`);
  };
  console.log(`\n=== ${a}  →  ${b}`);
  console.log(`    board ${A.size} vs ${B.size}, users ${A.users} vs ${B.users}, tiled ${A.tiled} vs ${B.tiled}, content ${A.content} vs ${B.content}\n`);
  row('GPU used_bytes peak', (r) => Math.round(r.gpu.peakMB), ' MB');
  row('canvas census', (r) => Math.round(r.census.totalMB), ' MB');
  row('full-board canvases', (r) => r.census.fullBoardCount, '');
  row('stalls > 16 ms', (r) => r.stalls.count, '');
  row('worst stall', (r) => Math.round(r.stalls.worstMs), ' ms');
  row('renderer main busy', (r) => Math.round(r.rendererBusyPct), ' %');
  row('frame p99', (r) => Math.round(r.frames.p99), ' ms');
  row('live strokes (confound)', (r) => r.census.liveStrokes ?? 0, '');
  row('fps', (r) => Math.round(r.frames.fps), '', false);
  console.log();
  process.exit(0);
}

if (!LABEL) {
  console.error('usage: board_perf_suite.mjs --label=<name> [--size=1440p] [--vus=6] [--headless]');
  console.error('       board_perf_suite.mjs --compare=before,after');
  process.exit(1);
}

const dims = BOARD_SIZES[SIZE];
if (!dims) { console.error(`unknown --size=${SIZE}`); process.exit(1); }

// ── in-page probe ──────────────────────────────────────────────────────────
// Kept as a source string so the whole thing is one file. Everything here was
// learned the hard way in session 4; the comments name the trap.
const PROBE = `(() => {
  const app = window.app;

  // Frame-INTERVAL recorder. Mean frame time and JS self-time both report this
  // app as healthy while it visibly stalls, because the cost lands off the
  // renderer main thread. p99/max is the only honest summary.
  window.__frames = { on: false, gaps: [], last: 0 };
  (function tick(now) {
    const f = window.__frames;
    if (f.on) { if (f.last) f.gaps.push(now - f.last); f.last = now; } else f.last = 0;
    requestAnimationFrame(tick);
  })(performance.now());

  // Board size is a ROOM setting, and any room update — including a bot joining
  // mid-run — reapplies it. Without this lock a load test silently reverts to
  // the room default partway through and measures the wrong board.
  window.__lockBoardSize = function (h, w) {
    const board = app.board;
    board.resizeBoard([h, w]);
    app._bindLayerManagerDependencies?.();
    const orig = board.resizeBoard.bind(board);
    board.resizeBoard = (d) => {
      if (!d || d[0] !== h || d[1] !== w) return;   // refuse the override
      return orig(d);
    };
    window.__lockedDims = [h, w];
  };

  // pointerdown is listened for on the board canvas, but pointermove/up on
  // window. Sending all three to one element commits nothing and reports
  // perfect frame times — the most dangerous failure mode this harness has.
  window.__drive = async function ({ strokes, pts = 30, mode = 'absolute', size = 0.25 }) {
    const [bh, bw] = app.board.dimensions;
    const el = document.getElementById('boards');
    const rect = el.getBoundingClientRect();
    const sx = rect.width / bw, sy = rect.height / bh;
    const down = document.getElementById('board');
    const span = mode === 'normalized' ? Math.min(bw, bh) * size : 400;
    const ev = (type, x, y) => {
      const e = new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true,
        cancelable: true, composed: true,
        clientX: rect.left + x * sx, clientY: rect.top + y * sy,
        buttons: type === 'pointerup' ? 0 : 1, button: 0,
        pressure: type === 'pointerup' ? 0 : 0.5
      });
      (type === 'pointerdown' ? down : window).dispatchEvent(e);
    };
    const raf = () => new Promise(r => requestAnimationFrame(r));
    for (let s = 0; s < strokes; s++) {
      const ox = 10 + Math.random() * Math.max(1, bw - span - 20);
      const oy = 10 + Math.random() * Math.max(1, bh - span - 20);
      ev('pointermove', ox, oy); ev('pointerdown', ox, oy);
      for (let p = 1; p <= pts; p++) {
        const a = (p / pts) * Math.PI * 2;
        ev('pointermove', ox + span * 0.5 * (1 + Math.cos(a)), oy + span * 0.5 * (1 + Math.sin(a)));
        await raf();
      }
      ev('pointerup', ox + span * 0.5, oy + span);
      await raf(); await raf();
    }
  };

  // Light intermittent drawing over a long window, recording frame intervals
  // throughout — including the long idle gaps, which is where a periodic
  // board-proportional hitch actually shows up.
  window.__measureWindow = async function (seconds) {
    const f = window.__frames;
    const before = app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0);
    f.gaps.length = 0; f.last = 0; f.on = true;
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      await window.__drive({ strokes: 1, pts: 20, mode: 'absolute' });
      await new Promise(r => setTimeout(r, 1500));
    }
    const ms = performance.now() - t0;
    f.on = false;
    const after = app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0);
    const g = f.gaps.slice(2);
    const sorted = [...g].sort((a, b) => a - b);
    const pct = p => sorted[Math.floor(sorted.length * p)] || 0;
    const [bh, bw] = app.board.dimensions;
    let max = 0; for (const v of g) if (v > max) max = v;
    return {
      dims: [bh, bw], users: app.users?.size ?? 0,
      strokesCommitted: after - before,
      fps: +(g.length / (ms / 1000)).toFixed(1),
      p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2),
      p99: +pct(0.99).toFixed(2), max: +max.toFixed(2),
      over20: g.filter(v => v > 20).length,
      over50: g.filter(v => v > 50).length,
      over100: g.filter(v => v > 100).length,
      frames: g.length, windowSec: +(ms / 1000).toFixed(1)
    };
  };

  window.__measure = async function (cfg) {
    const f = window.__frames;
    const before = app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0);
    f.gaps.length = 0; f.last = 0; f.on = true;
    const t0 = performance.now();
    await window.__drive(cfg);
    const ms = performance.now() - t0;
    f.on = false;
    const after = app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0);
    const g = f.gaps.slice(2);
    const sorted = [...g].sort((a, b) => a - b);
    const pct = p => sorted[Math.floor(sorted.length * p)] || 0;
    const [bh, bw] = app.board.dimensions;
    let max = 0; for (const v of g) if (v > max) max = v;
    return {
      dims: [bh, bw], users: app.users?.size ?? 0,
      strokesCommitted: after - before,
      fps: +(g.length / (ms / 1000)).toFixed(1),
      p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2),
      p99: +pct(0.99).toFixed(2), max: +max.toFixed(2),
      over20: g.filter(v => v > 20).length, frames: g.length
    };
  };
  return true;
})()`;

// ── trace analysis (shared shape with trace_gpu_report.mjs) ────────────────
function analyseTrace(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = raw.traceEvents || raw;
  const threadNames = {}; const processNames = {};
  for (const e of events) {
    if (e.name === 'thread_name' && e.args?.name) threadNames[`${e.pid}:${e.tid}`] = e.args.name;
    if (e.name === 'process_name' && e.args?.name) processNames[e.pid] = e.args.name;
  }
  const complete = events.filter((e) => e.ph === 'X' && e.dur > 0);
  let t0 = Infinity; let t1 = -Infinity;
  for (const e of complete) { if (e.ts < t0) t0 = e.ts; if (e.ts + e.dur > t1) t1 = e.ts + e.dur; }
  const spanMs = (t1 - t0) / 1000;

  let peak = 0; let samples = 0;
  for (const e of events) {
    const u = e.args?.data?.used_bytes;
    if (typeof u === 'number' && u > 0) { samples++; if (u > peak) peak = u; }
  }

  let count = 0; let worst = 0;
  let rendererBusy = 0;
  for (const e of complete) {
    const proc = processNames[e.pid] || '';
    const thread = threadNames[`${e.pid}:${e.tid}`] || '';
    if (e.dur > 16000) { count++; if (e.dur > worst) worst = e.dur; }
    if (proc === 'Renderer' && thread === 'CrRendererMain' && e.name === 'RunTask') rendererBusy += e.dur;
  }

  return {
    spanMs: +spanMs.toFixed(0),
    gpu: { peakMB: +(peak / 1048576).toFixed(1), samples },
    stalls: { count, worstMs: +(worst / 1000).toFixed(1) },
    rendererBusyPct: +((rendererBusy / 1000 / spanMs) * 100).toFixed(1)
  };
}

// ── run ────────────────────────────────────────────────────────────────────
async function runOnce(runLabel) {
  const room = `perf_${runLabel.replace(/[^a-z0-9]/gi, '')}_${Date.now()}`;
  const tracePath = path.join(RESULTS_DIR, `${runLabel}.trace.json`);

  console.log(`\n=== board_perf_suite: ${LABEL}`);
  console.log(`    board ${SIZE} (${dims[1]}x${dims[0]}), ${VUS} k6 VUs, room ${room}`);
  console.log(`    ${HEADLESS ? 'HEADLESS (GPU numbers suspect)' : 'headed'}\n`);

  const launchArgs = ['--window-size=1600,950', '--ignore-certificate-errors'];
  if (WEAK) {
    launchArgs.push('--disable-gpu-rasterization');
  } else {
    launchArgs.push('--enable-gpu-rasterization');
  }
  if (GPU_MEM_MB > 0) launchArgs.push(`--force-gpu-mem-available-mb=${GPU_MEM_MB}`);

  const browser = CDP_URL
    // protocolTimeout: a CDP-attached run against a weak remote device is far
    // slower/more variable than a local launch — big board resizes and dense
    // paints can exceed puppeteer's default 30s and abort with a misleading
    // "Runtime.callFunctionOn timed out" that looks like a hang, not a timeout.
    ? await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 240_000 })
    : await puppeteer.launch({
        headless: HEADLESS,
        args: launchArgs,
        defaultViewport: null
      });
  // On an attached (CDP_URL) browser, prefer an already-loaded app tab and
  // skip navigating it: 'networkidle2' never settles against a page that
  // already holds an open room WebSocket (it reads as ongoing traffic), which
  // either hangs until its own timeout or leaves the target in a bad state
  // for the CDP calls that follow ("Target closed"). pages()[0] is also not
  // guaranteed to BE the app tab once other targets exist.
  const existing = CDP_URL
    ? (await browser.pages()).find((p) => p.url().startsWith(new URL(TARGET_URL).origin))
    : null;
  const page = existing || (await browser.pages())[0] || (await browser.newPage());
  const alreadyLoaded = existing && await page.evaluate(() => !!window.app).catch(() => false);

  try {
    if (CPU_THROTTLE > 1) await page.emulateCPUThrottling(CPU_THROTTLE);
    if (!alreadyLoaded) {
      await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    } else {
      console.log('    reusing already-loaded app tab:', page.url());
    }
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(PROBE);

    // KDE PowerDevil blanks the panel on its own timer, which kills vsync and
    // rAF while document.visibilityState stays "visible" — two earlier runs
    // reported ~1 % CPU and zero frames and looked like a clean result. Chrome's
    // --disable-backgrounding-* flags do not cover it. Needs a secure context,
    // which the -R tunnel to the Chromebook's own localhost provides.
    const wakeLock = await page.evaluate(async () => {
      try {
        window.__wakeLock = await navigator.wakeLock.request('screen');
        return 'held';
      } catch (e) { return `unavailable: ${e.name}`; }
    });
    console.log(`    screen wake lock: ${wakeLock}`);

    // DISABLE_REPLAY=1 turns off stroke recording before the room is joined, so
    // the rolling tape never starts for this session at all. Same switch the
    // Settings UI drives (Recent replay length -> Off).
    if (DISABLE_REPLAY) {
      const applied = await page.evaluate(() => {
        const prefs = JSON.parse(JSON.stringify(window.app.appPreferences));
        prefs.general.replay.rollingEnabled = false;
        prefs.general.galleryTimelapseEnabled = false;
        window.app.setAppPreferences(prefs);
        return {
          rollingEnabled: window.app.appPreferences.general.replay.rollingEnabled,
          recorderRunning: window.app.rollingTapeRecorder?.isEnabled?.() ?? null,
        };
      });
      console.log(`    replay disabled: ${JSON.stringify(applied)}`);
    }

    await page.evaluate((r) => { window.app.self.username = 'PERF'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(
      () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT }
    );

    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    // --tiled forces layer 0's flatCanvas onto the tiled backing store and
    // arm-locks it against a ROOM_UPDATE (the server is authoritative for this
    // setting and would otherwise silently flip it back off mid-run — see
    // tiled_ab.mjs's __installArmLock, same pattern here).
    if (TILED) {
      const applied = await page.evaluate(() => {
        const board = window.app.board;
        let lm = board.layerManager;
        const patch = (m) => {
          if (!m || m.__armLocked) return m;
          m.__armLocked = true;
          const orig = m.setTiledBackingStore.bind(m);
          m.setTiledBackingStore = (v) => { if (!window.__armSetting) return; return orig(v); };
          return m;
        };
        patch(lm);
        Object.defineProperty(board, 'layerManager', {
          configurable: true, get: () => lm, set: (v) => { lm = patch(v); }
        });
        window.__armSetting = true;
        lm.setTiledBackingStore(true);
        window.__armSetting = false;
        return lm.layerGroups[0].tiled;
      });
      if (!applied) throw new Error('--tiled requested but setTiledBackingStore(true) did not take');
      console.log(`    tiled backing store: ON (arm-locked)`);
    }

    // --content pre-paints a synthetic base before any drawing is measured, so
    // the comparison isn't limited to "starts blank, strokes accumulate" —
    // dense is the case tiling must not regress, sparse is the case it targets.
    if (CONTENT) {
      await page.evaluate((mode) => {
        const lm = window.app.board.layerManager;
        const [h, w] = window.app.board.dimensions;
        window.app.board.clear();
        lm.withFlatCanvasContext(0, (ctx) => {
          if (mode === 'dense') {
            for (let i = 0; i < 400; i++) {
              const gx = i % 20, gy = Math.floor(i / 20);
              ctx.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 80% 55%)';
              ctx.fillRect(Math.round(gx * (w / 20)) + 4, Math.round(gy * (h / 20)) + 4, 40, 40);
            }
          } else {
            for (let i = 0; i < 60; i++) {
              ctx.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 80% 55%)';
              ctx.fillRect(120 + (i % 10) * 40, 120 + Math.floor(i / 10) * 40, 36, 36);
            }
          }
        });
        window.app.board.markCompositeFull();
        window.app.board.compositeAllLayers();
      }, CONTENT);
      console.log(`    pre-painted content: ${CONTENT}`);
    }

    if (LOW_POWER) {
      const lp = await page.evaluate((mode) => {
        const next = { ...window.app.appPreferences, general: { ...window.app.appPreferences.general, lowPowerMode: mode } };
        window.app.setAppPreferences(next);
        return {
          active: window.app.isLowPowerModeActive(),
          tickRate: window.app.inputBufferManager.tickRate,
          targetFPS: window.app.board.targetFPS,
        };
      }, LOW_POWER);
      console.log(`    low-power mode: ${LOW_POWER} -> active=${lp.active} tickRate=${lp.tickRate} targetFPS=${lp.targetFPS}`);
    }

    if (LOCAL_TOOL) {
      const active = await page.evaluate((t) => {
        window.app.selectTool(t);
        return { tool: window.app.self?.tool, active: window.app.activeTool };
      }, LOCAL_TOOL);
      if (active.tool !== LOCAL_TOOL) {
        throw new Error(`--localtool=${LOCAL_TOOL} did not take (self.tool=${active.tool}) — every number below would be for the wrong tool`);
      }
      console.log(`    local tool: ${active.tool}`);
    }

    // k6 bots. Started before the trace so the join storm is not what we
    // measure — the interesting state is a room already carrying N users.
    let k6 = null;
    if (VUS > 0) {
      const k6Args = ['run', '-e', `ROOM=${room}`, '-e', `TARGET_URL=${WS_URL}`];
      if (K6_TOOLS) k6Args.push('-e', `TOOLS=${K6_TOOLS}`);
      k6Args.push(`--vus=${VUS}`, `--duration=${DURATION}`, K6_SCRIPT);
      k6 = spawn('k6', k6Args,
        { cwd: path.join(__dirname, '..', '..'), stdio: 'ignore', shell: process.platform === 'win32' });
      console.log('    waiting for bots to join and settle...');
      await sleep(14_000);
    }

    const users = await page.evaluate(() => window.app.users?.size ?? 0);
    console.log(`    users in room: ${users}`);

    // DevTools Performance counters -- the same CDP domain the Performance
    // panel reads. Frame intervals say a frame was late; these say what it was
    // late doing (script vs layout vs style vs everything else).
    const cdp = await page.target().createCDPSession();
    await cdp.send('Performance.enable');
    const metricsBefore = await cdp.send('Performance.getMetrics');

    await page.tracing.start({
      path: tracePath,
      categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', 'gpu', 'toplevel',
        'viz', 'benchmark', 'v8']
    });

    const frames = WINDOW_SEC > 0
      ? await page.evaluate((sec) => window.__measureWindow(sec), WINDOW_SEC)
      : await page.evaluate((s) => window.__measure({ strokes: s, pts: 30, mode: 'absolute' }), STROKES);
    const census = await page.evaluate(async () => {
      const { collectCanvasCensus } = await import('/src/utils/canvasCensus.js');
      const c = collectCanvasCensus(window.app);
      return {
        totalMB: +c.totalMB.toFixed(1), canvasCount: c.canvasCount,
        fullBoardCount: c.fullBoardCount,
        // How much the bots happened to draw before the measurement window.
        // Composite cost is linear in live stroke count, and the bots are not
        // deterministic, so a run that accumulated twice the strokes is not
        // comparable on timing no matter what changed in between. Reported so
        // the confound is visible rather than silently moving the numbers.
        liveStrokes: window.app.board.layerManager.layerGroups
          .reduce((n, g) => n + g.strokeStack.length, 0),
        buckets: c.buckets.slice(0, 8).map((b) => ({ label: b.label, mb: +b.mb.toFixed(1), count: b.count }))
      };
    });

    // Sampled BEFORE tracing.stop(): stopping flushes the whole multi-MB trace
    // over CDP, which takes longer than the measurement itself. Sampling after
    // it put that transfer inside the span and diluted every percentage below
    // to roughly a third of its real value.
    const metricsAfter = await cdp.send('Performance.getMetrics');

    await page.tracing.stop();
    const asMap = (m) => Object.fromEntries(m.metrics.map((x) => [x.name, x.value]));
    const mBefore = asMap(metricsBefore);
    const mAfter = asMap(metricsAfter);
    // Durations are cumulative seconds of wall clock, so a delta over the
    // window's span is the share of real time spent in that phase.
    const spanSec = (mAfter.Timestamp - mBefore.Timestamp) || 1;
    const pct = (k) => +((((mAfter[k] ?? 0) - (mBefore[k] ?? 0)) / spanSec) * 100).toFixed(1);
    const devtools = {
      spanSec: +spanSec.toFixed(1),
      taskPct: pct('TaskDuration'),
      scriptPct: pct('ScriptDuration'),
      layoutPct: pct('LayoutDuration'),
      recalcStylePct: pct('RecalcStyleDuration'),
      layoutCount: (mAfter.LayoutCount ?? 0) - (mBefore.LayoutCount ?? 0),
      recalcStyleCount: (mAfter.RecalcStyleCount ?? 0) - (mBefore.RecalcStyleCount ?? 0),
      jsHeapMB: +((mAfter.JSHeapUsedSize ?? 0) / 1048576).toFixed(1),
      nodes: mAfter.Nodes ?? null,
    };
    await cdp.detach().catch(() => { /* page may already be gone */ });

    // Reclaim check. The load phase keeps every bot drawing, so idle-reclaim
    // timers never fire inside it — this measures what those timers are worth
    // by releasing now and re-censusing. It is an AT-RISK figure, not a
    // steady-state saving: it says how much a room of recently-active users is
    // holding that a genuinely idle room would give back. A real steady-state
    // test needs bots that hold their sockets open while not drawing, which
    // the current k6 scripts do not do.
    const reclaim = await page.evaluate(async () => {
      const { collectCanvasCensus } = await import('/src/utils/canvasCensus.js');
      const { releaseRemoteScratch } = await import('/src/remote/remoteScratchReclaim.js')
        .catch(() => ({ releaseRemoteScratch: null }));
      if (!releaseRemoteScratch) return null;
      const before = collectCanvasCensus(window.app).totalMB;
      for (const u of window.app.users?.values?.() || []) releaseRemoteScratch(u);
      const after = collectCanvasCensus(window.app).totalMB;
      return { beforeMB: +before.toFixed(1), afterMB: +after.toFixed(1), freedMB: +(before - after).toFixed(1) };
    });

    if (k6) { try { k6.kill(); } catch { /* already gone */ } }

    // Fail loud rather than reporting a clean-looking zero.
    if (frames.strokesCommitted <= 0) {
      throw new Error('driver committed 0 strokes — pointer events are not reaching the app; every frame number below would be meaningless');
    }
    if (frames.dims[0] !== dims[0] || frames.dims[1] !== dims[1]) {
      throw new Error(`board reverted to ${frames.dims[1]}x${frames.dims[0]} (wanted ${dims[1]}x${dims[0]}) — the room-settings override beat the lock`);
    }

    const trace = analyseTrace(tracePath);
    if (trace.gpu.samples === 0) {
      console.warn('    WARNING: no used_bytes samples — GPU process not traced (headless/SwiftShader?). GPU numbers are absent, not zero.');
    }

    const result = {
      label: runLabel, at: new Date().toISOString(), size: SIZE, dims, users,
      vus: VUS, room, localTool: LOCAL_TOOL, k6Tools: K6_TOOLS, tiled: TILED, content: CONTENT,
      lowPower: LOW_POWER,
      frames, census, reclaim, devtools, ...trace
    };

    console.log(`\n  devtools task/script  ${devtools.taskPct}% task, ${devtools.scriptPct}% script, ${devtools.layoutPct}% layout, ${devtools.recalcStylePct}% style`);
    console.log(`  devtools layout/style ${devtools.layoutCount} layouts, ${devtools.recalcStyleCount} style recalcs, JS heap ${devtools.jsHeapMB} MB`);
    console.log(`  GPU used_bytes peak   ${result.gpu.peakMB} MB  (${result.gpu.samples} samples)`);
    console.log(`  canvas census         ${census.totalMB} MB across ${census.canvasCount} canvases, ${census.fullBoardCount} full-board`);
    console.log(`  live strokes          ${census.liveStrokes}  (composite cost is linear in this; compare runs with similar counts)`);
    console.log(`  stalls > 16 ms        ${result.stalls.count}   worst ${result.stalls.worstMs} ms`);
    console.log(`  renderer main busy    ${result.rendererBusyPct} %`);
    console.log(`  frames                ${frames.fps} fps, p50 ${frames.p50} / p99 ${frames.p99} / max ${frames.max} ms, ${frames.over20} over 20 ms`);
    console.log(`  strokes committed     ${frames.strokesCommitted}`);
    if (reclaim) {
      console.log(`  scratch at risk       ${reclaim.freedMB} MB in idle-reclaimable per-user offscreens (${reclaim.beforeMB} → ${reclaim.afterMB})`);
    }
    console.log('\n  top canvas holders:');
    for (const b of census.buckets) console.log(`    ${String(b.mb).padStart(7)} MB  x${String(b.count).padEnd(3)} ${b.label}`);
    return result;
  } finally {
    // Restore 'auto' on an attached browser -- it's a shared, persistent
    // instance (not ours to close), so a forced preference from this run
    // would otherwise leak into whatever runs against it next.
    if (CDP_URL && LOW_POWER) {
      await page.evaluate(() => {
        const next = { ...window.app.appPreferences, general: { ...window.app.appPreferences.general, lowPowerMode: 'auto' } };
        window.app.setAppPreferences(next);
      }).catch(() => {});
    }
    // An attached browser is not ours to kill -- closing it would take down the
    // Chromebook's session between repeats.
    if (CDP_URL) await browser.disconnect();
    else await browser.close();
  }
}

/** Median of a numeric field across runs. Median, not mean: the failure mode
 *  here is a rare enormous stall, and one 400 ms outlier drags a mean far past
 *  anything a user experiences. */
const median = (runs, get) => {
  const v = runs.map(get).sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : +(((v[v.length / 2 - 1] + v[v.length / 2]) / 2).toFixed(1));
};

(async () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const runs = [];
  for (let i = 0; i < REPEAT; i++) {
    if (REPEAT > 1) console.log(`\n──────── run ${i + 1} / ${REPEAT} ────────`);
    runs.push(await runOnce(REPEAT > 1 ? `${LABEL}.run${i + 1}` : LABEL));
  }

  const summary = {
    label: LABEL, at: new Date().toISOString(), size: SIZE, dims,
    vus: VUS, repeat: REPEAT, k6Tools: K6_TOOLS, tiled: TILED, content: CONTENT,
    weak: WEAK, gpuMemMB: GPU_MEM_MB, cpuThrottle: CPU_THROTTLE, windowSec: WINDOW_SEC,
    users: median(runs, (r) => r.users),
    gpu: { peakMB: median(runs, (r) => r.gpu.peakMB), samples: median(runs, (r) => r.gpu.samples) },
    census: {
      totalMB: median(runs, (r) => r.census.totalMB),
      fullBoardCount: median(runs, (r) => r.census.fullBoardCount),
      canvasCount: median(runs, (r) => r.census.canvasCount),
      liveStrokes: median(runs, (r) => r.census.liveStrokes),
      buckets: runs[runs.length - 1].census.buckets
    },
    stalls: { count: median(runs, (r) => r.stalls.count), worstMs: median(runs, (r) => r.stalls.worstMs) },
    rendererBusyPct: median(runs, (r) => r.rendererBusyPct),
    frames: {
      fps: median(runs, (r) => r.frames.fps),
      p50: median(runs, (r) => r.frames.p50),
      p99: median(runs, (r) => r.frames.p99),
      max: median(runs, (r) => r.frames.max)
    },
    allRuns: runs
  };
  fs.writeFileSync(path.join(RESULTS_DIR, `${LABEL}.json`), JSON.stringify(summary, null, 2));

  if (REPEAT > 1) {
    console.log(`\n════════ ${LABEL}: median of ${REPEAT} runs ════════`);
    console.log(`  GPU used_bytes peak   ${summary.gpu.peakMB} MB      [${runs.map((r) => r.gpu.peakMB).join(', ')}]`);
    console.log(`  canvas census         ${summary.census.totalMB} MB   [${runs.map((r) => r.census.totalMB).join(', ')}]`);
    console.log(`  live strokes          ${summary.census.liveStrokes}      [${runs.map((r) => r.census.liveStrokes).join(', ')}]`);
    console.log(`  stalls > 16 ms        ${summary.stalls.count}        [${runs.map((r) => r.stalls.count).join(', ')}]`);
    console.log(`  worst stall           ${summary.stalls.worstMs} ms   [${runs.map((r) => r.stalls.worstMs).join(', ')}]`);
    console.log(`  renderer main busy    ${summary.rendererBusyPct} %    [${runs.map((r) => r.rendererBusyPct).join(', ')}]`);
    console.log(`  fps                   ${summary.frames.fps}       [${runs.map((r) => r.frames.fps).join(', ')}]`);
  }
  console.log(`\n  saved → perf-results/${LABEL}.json\n`);
})().catch((err) => { console.error('\nFAILED:', err.message, '\n'); process.exit(1); });
