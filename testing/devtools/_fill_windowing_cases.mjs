/**
 * @fileoverview In-page body of the flood-fill windowing exactness check.
 * Kept separate so it can be run either through puppeteer/CDP
 * (fill_windowing_exactness.mjs) or pasted into a browser console.
 *
 * Runs entirely inside the page; returns only counters, never pixel buffers.
 */
export async function runFillWindowingCases() {
  const app = window.app;
  const board = app.board;
  const lm = board.layerManager;
  const tool = app.toolManager.getTool('fill');
  const user = app.self;
  const [bh, bw] = board.dimensions;

  app.selectTool('fill');
  await new Promise((r) => setTimeout(r, 400));

  user.color = [255, 0, 0, 1];
  user.opacity = 1;
  user.activeLayer = 0;
  tool.patternMode = false;

  // Two bounded blocks: the fill floods the first, the synthetic "mirror" copy
  // floods the second. Both well under the tool's 40%-of-board cap.
  const A = { x: Math.round(bw * 0.20), y: Math.round(bh * 0.22), w: 300, h: 200 };
  const B = { x: Math.round(bw * 0.62), y: Math.round(bh * 0.55), w: 260, h: 180 };
  const seedA = { x: A.x + (A.w >> 1), y: A.y + (A.h >> 1) };
  const seedB = { x: B.x + (B.w >> 1), y: B.y + (B.h >> 1) };
  const REGION = { x: B.x - 20, y: B.y - 20, width: B.w + 40, height: B.h + 40 };

  // withFlatCanvasContext, not group.flatCtx: with the tiled backing store on
  // (the default in this build) flatCtx is null and the layer lives in tiles.
  const paintBase = () => {
    board.clear();
    lm.withFlatCanvasContext(0, (ctx) => {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#3355aa';
      ctx.fillRect(A.x, A.y, A.w, A.h);
      ctx.fillRect(B.x, B.y, B.w, B.h);
      ctx.restore();
    });
    board.markCompositeFull();
    board.compositeAllLayers();
  };

  const layerPixels = () => {
    const c = document.createElement('canvas');
    c.width = bw; c.height = bh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    lm.compositeLayerRange(ctx, 0, 1, null);
    return ctx.getImageData(0, 0, bw, bh).data;
  };

  const origBounds = tool._fillStrokeBounds.bind(tool);
  const origRender = tool._renderMask.bind(tool);

  // A pixel is "fill" if it is dominantly red — the base block is #3355aa, so
  // the two never alias even after a blur ramp.
  const isFill = (px, i) => px[i] > 90 && px[i] > px[i + 1] * 2 && px[i] > px[i + 2] * 2;

  const runOnce = async ({ windowed, blurRadius, expansion, mirror }) => {
    paintBase();
    const probe = { origin: null, canvasW: 0, canvasH: 0, seen: 0 };
    tool._fillStrokeBounds = windowed ? origBounds : () => null;
    tool._renderMask = function (ctx, res, r, g, b, op, br, w, h, u, origin) {
      if (probe.seen === 0) {
        probe.origin = origin ? { x: origin.x, y: origin.y } : null;
        probe.canvasW = ctx.canvas.width;
        probe.canvasH = ctx.canvas.height;
      }
      probe.seen++;
      return origRender(ctx, res, r, g, b, op, br, w, h, u, origin);
    };
    try {
      const img = board.getFullBoardImageData(0, 0, bw, bh);
      const result = await tool._fillWorker.computeFill(img.data, bw, bh, seedA.x, seedA.y, 10, expansion, null);
      if (!result) throw new Error('primary computeFill returned null');

      let mirrors = [];
      if (mirror) {
        const img2 = board.getFullBoardImageData(0, 0, bw, bh);
        const mres = await tool._fillWorker.computeFill(img2.data, bw, bh, seedB.x, seedB.y, 10, expansion, null);
        if (!mres) throw new Error('mirror computeFill returned null');
        mirrors = [{ region: REGION, result: mres }];
      }

      const params = tool._getFillParams(user);
      tool._commitFillResult(user, result, params, bw, bh, mirrors, blurRadius, expansion);
      board.endStroke(user);
      await new Promise((r) => setTimeout(r, 120));
      return { px: layerPixels(), probe };
    } finally {
      tool._renderMask = origRender;
      tool._fillStrokeBounds = origBounds;
    }
  };

  const cases = [
    { name: 'solid, no blur, no expansion', blurRadius: 0, expansion: 0, mirror: false },
    { name: 'blurred edge (stackblur path), r=8', blurRadius: 8, expansion: 0, mirror: false },
    { name: 'dilated, expansion=+6', blurRadius: 0, expansion: 6, mirror: false },
    { name: 'eroded, expansion=-6', blurRadius: 0, expansion: -6, mirror: false },
    { name: 'mirror copy, no blur', blurRadius: 0, expansion: 0, mirror: true },
    { name: 'mirror copy, blur r=6, expansion=+4', blurRadius: 6, expansion: 4, mirror: true }
  ];

  const out = [];
  for (const c of cases) {
    const win = await runOnce({ ...c, windowed: true });
    const full = await runOnce({ ...c, windowed: false });

    let diff = 0, worst = 0;
    for (let i = 0; i < win.px.length; i++) {
      if (win.px[i] !== full.px[i]) { diff++; const d = Math.abs(win.px[i] - full.px[i]); if (d > worst) worst = d; }
    }

    // Placement checks on the WINDOWED run: the mask has to land at its real
    // board position, and nothing may appear outside where a fill can reach.
    let filledPx = 0;
    for (let i = 0; i < win.px.length; i += 4) if (isFill(win.px, i)) filledPx++;

    const at = (x, y) => (y * bw + x) * 4;
    const seedIsFill = isFill(win.px, at(seedA.x, seedA.y))
      && (!c.mirror || isFill(win.px, at(seedB.x, seedB.y)));

    // Generous slack for blur bleed and dilation, but far outside any of it.
    const slack = Math.ceil(c.blurRadius * 3) + Math.abs(c.expansion) + 40;
    let outsideIsClean = true;
    const inBox = (x, y, r) => x >= r.x - slack && x <= r.x + r.w + slack && y >= r.y - slack && y <= r.y + r.h + slack;
    for (let y = 0; y < bh; y += 3) {
      for (let x = 0; x < bw; x += 3) {
        if (inBox(x, y, A) || inBox(x, y, B)) continue;
        if (isFill(win.px, at(x, y))) { outsideIsClean = false; break; }
      }
      if (!outsideIsClean) break;
    }

    out.push({
      name: c.name,
      diff, worst, bytes: win.px.length,
      canvasW: win.probe.canvasW, canvasH: win.probe.canvasH,
      canvasPx: win.probe.canvasW * win.probe.canvasH,
      originX: win.probe.origin ? win.probe.origin.x : 0,
      originY: win.probe.origin ? win.probe.origin.y : 0,
      windowed: win.probe.canvasW * win.probe.canvasH < bw * bh,
      fullWasFullBoard: full.probe.canvasW === bw && full.probe.canvasH === bh,
      filledPx, seedIsFill, outsideIsClean
    });
  }

  return { board: { w: bw, h: bh }, cases: out };
}
