#!/usr/bin/env node
/**
 * @fileoverview End-to-end check that a windowed flood fill replicates
 * correctly to a peer.
 *
 * `DrawingHandlers.applyRemoteFill` is the second of the three copies of the
 * fill-commit sequence, and it windows its active-stroke canvas independently
 * of the local tool. Two real tabs in one room: A fills, B receives the FILL
 * message and re-runs the fill through the remote handler. If B's layer 0
 * matches A's, the remote windowed path put its pixels in the right place.
 *
 * B is brought to the front before capture: a background tab gets no animation
 * frame, and the inbound WS queue is rAF-latched, so a hidden peer would simply
 * never process the message (a known trap in this repo's suites).
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/fill_windowing_remote_parity.mjs
 */

import puppeteer from 'puppeteer';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const TOLERANCE = 2;         // per-channel, matches the repo's pixel suites
const PASS_PCT = 99.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function joinRoom(page, room, name) {
  // A hidden tab gets no animation frame, and the connect/join path is
  // rAF-driven, so it must be foregrounded to make progress.
  await page.bringToFront();
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 120000 });
  await page.evaluate((r, n) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, room, name);
  await page.waitForFunction(
    () => window.app && window.app.wsClient && window.app.wsClient.connected && window.app.sessionIndex != null,
    { timeout: 120000 }
  );
}

const captureLayer0 = () => {
  const app = window.app;
  const lm = app.board.layerManager;
  const bw = app.board.getWidth(), bh = app.board.getHeight();
  const c = document.createElement('canvas');
  c.width = bw; c.height = bh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  lm.compositeLayerRange(ctx, 0, 1, null);
  return { w: bw, h: bh, data: Array.from(ctx.getImageData(0, 0, bw, bh).data) };
};

(async () => {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const room = 'fwp_' + Date.now();
  const pageA = (await browser.pages())[0] || (await browser.newPage());
  const pageB = await browser.newPage();
  try {
    await joinRoom(pageA, room, 'A');
    await joinRoom(pageB, room, 'B');
    await pageA.bringToFront();
    await sleep(3000);

    // A paints the bounded blocks and floods one of them.
    const meta = await pageA.evaluate(async () => {
      const app = window.app;
      const board = app.board;
      const lm = board.layerManager;
      const tool = app.toolManager.getTool('fill');
      const bw = board.getWidth(), bh = board.getHeight();
      const A = { x: Math.round(bw * 0.20), y: Math.round(bh * 0.22), w: 300, h: 200 };
      // Mirror image of A about the vertical centreline, so the global mirror's
      // synthetic region has a bounded block to flood on the far side.
      const M = { x: bw - A.x - A.w, y: A.y, w: A.w, h: A.h };
      const seed = { x: A.x + 150, y: A.y + 100 };

      app.self.color = [255, 0, 0, 1];
      app.self.opacity = 1;
      app.self.activeLayer = 0;
      // Global mirror on: this is what makes getActiveMirrorRegions yield a
      // synthetic region, which is the only thing that drives the receiver's
      // window-grow path.
      board.mirror = true;
      app.selectTool('fill');
      tool.advancedMode = false;
      await new Promise((r) => setTimeout(r, 300));

      lm.withFlatCanvasContext(0, (ctx) => {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#3355aa';
        ctx.fillRect(A.x, A.y, A.w, A.h);
        ctx.fillRect(M.x, M.y, M.w, M.h);
        ctx.restore();
      });
      board.markCompositeFull();
      board.compositeAllLayers();
      return { bw, bh, A, M, seed };
    });

    // Push the same base to B directly so both start from the same raster,
    // then let the FILL message alone drive the comparison.
    await pageB.evaluate((m) => {
      const board = window.app.board;
      const lm = board.layerManager;
      board.mirror = true;
      lm.withFlatCanvasContext(0, (ctx) => {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#3355aa';
        ctx.fillRect(m.A.x, m.A.y, m.A.w, m.A.h);
        ctx.fillRect(m.M.x, m.M.y, m.M.w, m.M.h);
        ctx.restore();
      });
      board.markCompositeFull();
      board.compositeAllLayers();

      // Record what the RECEIVER windows to, and how big the canvas was by the
      // time it committed - the grow path reallocates, so a receiver that
      // silently fell back to full board must not read as a pass.
      window.__fwp = { begunWith: null, committedAt: null };
      const ob = lm.beginUserStroke.bind(lm);
      lm.beginUserStroke = (...a) => { if (a[1] !== window.app.self.id) window.__fwp.begunWith = a[4] || 'FULL_BOARD'; return ob(...a); };
      const oc = lm.commitUserStroke.bind(lm);
      lm.commitUserStroke = (...a) => {
        if (a[1] !== window.app.self.id) {
          const act = lm.getActiveStroke(a[0], a[1]);
          if (act) window.__fwp.committedAt = { w: act.canvas.width, h: act.canvas.height };
        }
        return oc(...a);
      };
    }, meta);
    await sleep(500);

    // A performs a real pointer-driven fill so a genuine FILL goes on the wire.
    const aInfo = await pageA.evaluate(async (m) => {
      const app = window.app;
      const el = document.getElementById('boards');
      const rect = el.getBoundingClientRect();
      const sx = rect.width / m.bw, sy = rect.height / m.bh;
      const down = document.getElementById('board');
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
      const lm = app.board.layerManager;
      let win = null;
      const orig = lm.beginUserStroke.bind(lm);
      lm.beginUserStroke = (...a) => { if (a[4]) win = a[4]; return orig(...a); };

      ev('pointermove', m.seed.x, m.seed.y);
      ev('pointerdown', m.seed.x, m.seed.y);
      await new Promise((r) => setTimeout(r, 60));
      ev('pointerup', m.seed.x, m.seed.y);
      await new Promise((r) => setTimeout(r, 900));
      lm.beginUserStroke = orig;
      return { senderWindow: win };
    }, meta);

    await sleep(1500);
    await pageB.bringToFront();
    await sleep(2500);

    const bInfo = await pageB.evaluate(() => window.__fwp || null);
    const a = await pageA.evaluate(captureLayer0);
    const bPix = await pageB.evaluate(captureLayer0);

    let differing = 0;
    const total = a.data.length / 4;
    for (let i = 0; i < a.data.length; i += 4) {
      if (Math.abs(a.data[i] - bPix.data[i]) > TOLERANCE ||
          Math.abs(a.data[i + 1] - bPix.data[i + 1]) > TOLERANCE ||
          Math.abs(a.data[i + 2] - bPix.data[i + 2]) > TOLERANCE ||
          Math.abs(a.data[i + 3] - bPix.data[i + 3]) > TOLERANCE) differing++;
    }
    const matchPct = 100 * (1 - differing / total);

    // Vacuity: A must actually have filled something red.
    let redA = 0, redB = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i] > 90 && a.data[i] > a.data[i + 1] * 2 && a.data[i] > a.data[i + 2] * 2) redA++;
      if (bPix.data[i] > 90 && bPix.data[i] > bPix.data[i + 1] * 2 && bPix.data[i] > bPix.data[i + 2] * 2) redB++;
    }

    console.log('\n=== remote fill parity (windowed active-stroke canvas)  ' + a.w + 'x' + a.h);
    console.log('    sender window bounds: ' + JSON.stringify(aInfo.senderWindow));
    console.log('    receiver window bounds: ' + JSON.stringify(bInfo && bInfo.begunWith));
    console.log('    receiver canvas at commit (after grow): ' + JSON.stringify(bInfo && bInfo.committedAt));
    console.log('    filled px  A=' + redA + '   B=' + redB);
    console.log('    layer 0 match: ' + matchPct.toFixed(4) + '%   (' + differing + ' of ' + total + ' px differ)');
    const problems = [];
    if (redA === 0) problems.push('A deposited no fill (test vacuous)');
    if (redB === 0) problems.push('B rendered no fill - the remote fill painted nothing');
    if (!aInfo.senderWindow) problems.push('sender canvas was not windowed (test vacuous)');
    if (!bInfo || !bInfo.begunWith || bInfo.begunWith === 'FULL_BOARD') problems.push('receiver canvas was not windowed (test vacuous)');
    if (!bInfo || !bInfo.committedAt) problems.push('receiver never committed a remote stroke');
    else if (bInfo.committedAt.w * bInfo.committedAt.h >= a.w * a.h) problems.push('receiver grew all the way to full board (no saving left)');
    if (redA < 100000) problems.push('mirror copy missing on sender - grow path not exercised');
    if (matchPct < PASS_PCT) problems.push('layer 0 disagreement above tolerance');
    if (problems.length) { problems.forEach((p) => console.log('    FAIL - ' + p)); console.log(''); process.exitCode = 1; }
    else console.log('    PASS\n');
  } finally {
    await pageB.close().catch(() => {});
    await browser.disconnect();
  }
})();
