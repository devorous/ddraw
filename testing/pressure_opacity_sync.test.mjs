#!/usr/bin/env node
/**
 * Pressure-controlled opacity: live remote path and late-join path must match the drawer.
 *
 * Per case (a fresh room each time, so a joiner's history holds only that case):
 *   A  draws variable-pressure, self-crossing Ink / Fluid Brush strokes as a pen
 *      (pressure drives opacity, or opacity + size; undo/redo; cancel / tool switch mid-stroke)
 *   B  is already in the room: the live remote path (RemoteInkHandler / RemotePenHandler)
 *   C  joins AFTER the drawing: the sync / history rebuild path
 * Pass: B and C layer bitmaps match A (same tolerance helpers as the sync + parity suites),
 * and A drew something. A's board is also compared with testing/baselines/pressure_<case>.png.
 *
 * Checkpoint rebuild is not covered: it needs a registered room with server-minted
 * checkpoints (see testing/devtools/checkpoint_v6_verify.mjs, which needs a DB and login).
 *
 * Usage (frontend :3000 proxying to a DB-less server, see CLAUDE.md "Verifying changes"):
 *   node testing/pressure_opacity_sync.test.mjs [--only=a,b] [--generate-baselines] [--headed]
 *
 * Env: TARGET_URL (default http://localhost:3000/go/), PROPAGATION_MS (default 3000),
 *      BASELINE_MAX_DIFF_PCT (default 0.3: the same case redrawn on the same machine
 *      varies by up to ~0.2% from antialiasing; A/B/C parity above is the strict check).
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PIXEL_TOLERANCE, PASS_PCT, captureLayerSnapshotsInPage, diffSnapshots } from './lib/layerDiff.mjs';
import { pressureActions, sleep } from './lib/pressureStroke.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const PROPAGATION_MS = parseInt(process.env.PROPAGATION_MS || '3000', 10);
const BASELINE_MAX_DIFF_PCT = parseFloat(process.env.BASELINE_MAX_DIFF_PCT || '0.3');
const BASELINES_DIR = path.join(__dirname, 'baselines');
const RESULTS_DIR = path.join(__dirname, 'sync_results', `pressure_${new Date().toISOString().replace(/[:.]/g, '-')}`);

let HEADLESS = process.env.HEADLESS !== 'false';
let ONLY = null;
let GENERATE = false;
for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a === '--generate-baselines') GENERATE = true;
  else if (a.startsWith('--only=')) ONLY = a.slice(7).split(',').map((s) => s.trim());
  else { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

async function spawnTab(browser, label, room) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERROR] ${err.message}\n`));
  // Same pinning as the parity suite so soft edges are reproducible.
  await page.evaluateOnNewDocument(() => {
    let seed = 12345;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    Date.now = () => new Date('2026-05-05T12:00:00Z').getTime();
  });
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app !== undefined && window.app.self != null, { timeout: 60_000 });
  await page.evaluate((n, r) => {
    window.app.self.username = n;
    window.app.handleRoomSelected(r);
  }, label, room);
  await page.waitForFunction(() => {
    const app = window.app;
    const syncDone = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && syncDone;
  }, { timeout: 60_000 });
  await page.evaluate(() => window.app.inputBufferManager?.stopTickLoop?.());
  return page;
}

/** Percent difference between the page's view canvas and a baseline PNG (compare_images.py metric). */
async function baselineDiffPct(page, baselinePng) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${b64}`; });
    const src = window.app.board.viewCanvas;
    if (img.width !== src.width || img.height !== src.height) return 100;
    const read = (draw) => {
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      draw(ctx);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const a = read((ctx) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, src.width, src.height); ctx.drawImage(img, 0, 0); });
    const b = read((ctx) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, src.width, src.height); ctx.drawImage(src, 0, 0); });
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return (sum / (src.width * src.height * 3 * 255)) * 100;
  }, baselinePng.toString('base64'));
}

async function runCase(browser, tc) {
  const room = `pressure_${tc.name}_${Date.now()}`.slice(0, 40);
  const pages = [];
  try {
    const a = await spawnTab(browser, 'drawerA', room); pages.push(a);
    const b = await spawnTab(browser, 'observerB', room); pages.push(b);
    await a.waitForFunction(() => (window.app?.users?.size ?? 0) >= 2, { timeout: 30_000 });

    await tc.action(a);
    await sleep(PROPAGATION_MS);

    const snapsA = await a.evaluate(captureLayerSnapshotsInPage);
    const snapsB = await b.evaluate(captureLayerSnapshotsInPage);

    // Late joiner: arrives after everything was drawn.
    const c = await spawnTab(browser, 'lateC', room); pages.push(c);
    await sleep(PROPAGATION_MS);
    const snapsC = await c.evaluate(captureLayerSnapshotsInPage);

    const liveDiff = diffSnapshots(snapsA, snapsB);
    const lateDiff = diffSnapshots(snapsA, snapsC);
    const drewSomething = (snapsA || []).some((s) => s.bbox && s.bbox.w > 0 && s.bbox.h > 0);

    // Baseline: the drawer's visible board, same capture as the visual regression suite.
    const dataUrl = await a.evaluate(() => window.app.board.viewCanvas.toDataURL('image/png'));
    const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    const baselinePath = path.join(BASELINES_DIR, `${tc.name}.png`);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_DIR, `${tc.name}.png`), png);
    let baseline = 'n/a';
    let baselineOk = true;
    if (GENERATE) {
      fs.mkdirSync(BASELINES_DIR, { recursive: true });
      fs.writeFileSync(baselinePath, png);
      baseline = 'written';
    } else if (!fs.existsSync(baselinePath)) {
      baseline = 'missing';
      baselineOk = false;
    } else {
      const pct = await baselineDiffPct(a, fs.readFileSync(baselinePath));
      baseline = `${pct.toFixed(4)}%`;
      baselineOk = pct < BASELINE_MAX_DIFF_PCT;
    }

    const inkOf = (snaps) => (snaps || []).map((s) => `L${s.groupIdx}:${s.strokeStackLen}`
      + (s.bbox ? `[${s.bbox.x},${s.bbox.y} ${s.bbox.w}x${s.bbox.h}]` : '[empty]')).join(' ') || '(none)';
    return {
      name: tc.name, liveDiff, lateDiff, baseline, drewSomething,
      ink: { A: inkOf(snapsA), B: inkOf(snapsB), C: inkOf(snapsC) },
      pass: liveDiff.pass && lateDiff.pass && drewSomething && baselineOk,
    };
  } finally {
    for (const p of pages) await p.close().catch(() => {});
  }
}

async function main() {
  console.log(`\nPressure opacity sync test\nURL: ${TARGET_URL}\nTolerance: +-${PIXEL_TOLERANCE}px, >=${PASS_PCT}% match\n`);
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });
  const results = [];
  try {
    const cases = pressureActions().filter((tc) => !ONLY || ONLY.includes(tc.name));
    if (!cases.length) { console.log('No cases match filter.'); process.exitCode = 1; return; }
    for (const tc of cases) {
      process.stdout.write(`  ${tc.name.padEnd(36)} ... `);
      try {
        let r;
        try { r = await runCase(browser, tc); } catch (err) {
          process.stdout.write(`(retry: ${err.message}) `);
          r = await runCase(browser, tc);
        }
        results.push(r);
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  remote ${r.liveDiff.matchPct.toFixed(2)}%  late-join ${r.lateDiff.matchPct.toFixed(2)}%  baseline ${r.baseline}`);
        if (!r.pass) {
          if (!r.liveDiff.pass) console.log(`     remote maxDelta ${r.liveDiff.maxDelta}`);
          if (!r.lateDiff.pass) console.log(`     late-join maxDelta ${r.lateDiff.maxDelta}`);
          if (!r.drewSomething) console.log('     A drew nothing, the case is vacuous');
          console.log(`     ink A: ${r.ink.A}\n     ink B: ${r.ink.B}\n     ink C: ${r.ink.C}`);
        }
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
        results.push({ name: tc.name, pass: false });
      }
    }
    const passed = results.filter((r) => r.pass).length;
    console.log(`\nRESULTS: ${passed}/${results.length} passed`);
    process.exitCode = passed === results.length ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
