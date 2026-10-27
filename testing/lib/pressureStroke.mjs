/**
 * @fileoverview Variable-pressure stroke helpers for the pressure-opacity checks
 * (testing/devtools/replay_parity_suite.mjs and testing/pressure_opacity_sync.test.mjs).
 *
 * Pressure only varies when the pointer is a pen: App.handlePointerMove reads
 * `e.pressure` for `pointerType === 'pen'` and maps it through the min/max
 * pressure sliders (0..100 by default, so pressure reaches the tool as written).
 * Puppeteer/CDP mouse events carry no pressure, so these helpers call the app's
 * pointer handlers directly, the same way the suites' plain drawPath does.
 *
 * What pressure drives is the user's pressureTargets (shared/pressureTargets.js:
 * size = 1, opacity = 2). It is set through app.setPressureTargets, which also
 * broadcasts CPT so the remote side sees it; every MD then carries `pt`.
 */

export const PRESSURE_TARGET_SIZE = 1;
export const PRESSURE_TARGET_OPACITY = 2;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getClientCoords(page, boardX, boardY) {
  return page.evaluate((bx, by) => {
    const board = window.app.board;
    const containerRect = board.container.getBoundingClientRect();
    const rad = board.rotation * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    let rx = bx * board.zoom;
    let ry = by * board.zoom;
    if (board.canvasFlipped) rx = (board.getWidth() - bx) * board.zoom;
    const rxr = rx * cos + ry * sin;
    const ryr = -rx * sin + ry * cos;
    return { clientX: rxr + board.panX + containerRect.left, clientY: ryr + board.panY + containerRect.top };
  }, boardX, boardY);
}

/**
 * One continuous figure-eight that crosses itself at (cx, cy), with smooth
 * pressure that swings between ~0.12 and ~0.95 (several full cycles per lap).
 */
export function figureEight({ cx = 700, cy = 500, rx = 450, ry = 200, n = 110, pressurePhase = 0.5 } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const p = 0.12 + 0.83 * (0.5 + 0.5 * Math.sin(3 * t + pressurePhase));
    pts.push({
      x: Math.round((cx + rx * Math.sin(t)) * 10) / 10,
      y: Math.round((cy + ry * Math.sin(2 * t)) * 10) / 10,
      p: Math.round(p * 100) / 100,
    });
  }
  return pts;
}

/**
 * Draw one stroke as a pen with per-point pressure.
 * @param {{x:number,y:number,p:number}[]} points board coords + pressure 0..1
 * @param {{abort?: null|'cancel'|'toolSwitch', abortAfter?: number}} [opts]
 *   abort 'cancel' calls app.cancelCurrentStroke() after `abortAfter` points
 *   instead of lifting; 'toolSwitch' selects another tool mid-stroke, then lifts.
 */
export async function drawPathPressure(page, points, { abort = null, abortAfter = 40 } = {}) {
  const clientPts = [];
  for (const p of points) clientPts.push({ ...(await getClientCoords(page, p.x, p.y)), p: p.p });
  await page.evaluate(async (pts, abortMode, abortIdx) => {
    const app = window.app;
    const ev = (c, pressure) => ({
      button: 0, pointerType: 'pen', pointerId: 7, pressure,
      clientX: c.clientX, clientY: c.clientY, preventDefault: () => {},
    });
    const startTool = app.self.tool;
    // A pen lands with some pressure; the app starts the stroke on the first move.
    app.handlePointerDown(ev(pts[0], pts[0].p));
    let aborted = false;
    for (let i = 1; i < pts.length; i++) {
      app.handlePointerMove(ev(pts[i], pts[i].p));
      app.inputBufferManager?.tick();
      await new Promise((r) => setTimeout(r, 5));
      if (abortMode && i === abortIdx) {
        if (abortMode === 'cancel') {
          app.cancelCurrentStroke();
          app.inputBufferManager?.tick();
          aborted = true;
          break;
        }
        if (abortMode === 'toolSwitch') {
          app.selectTool(startTool === 'ink' ? 'brush' : 'ink');
          app.inputBufferManager?.tick();
        }
      }
    }
    if (!aborted) {
      // The browser fires a pressure-0 move just before the up; the app ignores it mid-stroke.
      const last = pts[pts.length - 1];
      app.handlePointerMove(ev(last, 0));
      app.handlePointerUp(ev(last, 0));
    } else {
      app.handlePointerUp(ev(pts[abortIdx], 0));
    }
    app.inputBufferManager?.tick();
  }, clientPts, abort, abortAfter);
  await sleep(250);
}

/** Tool settings for a pressure case. `targets` is a PRESSURE_TARGET_* bit set. */
export async function setPressureTool(page, { tool, targets, hardness, size = 10, color = [200, 30, 30, 1] }) {
  await page.evaluate((t, targets, hardness, size, color) => {
    const app = window.app;
    app.selectTool(t);
    app.handleSizeChange({ target: { value: size } });
    app.handleColorInputChange(color);
    app.handleHardnessChange({ target: { value: hardness } });
    app.setPressureTargets(targets);
    app.inputBufferManager?.tick();
  }, tool, targets, hardness, size, color);
  await sleep(250);
}

/** Back to the default (size only) so a later case is not drawn with leaked targets. */
export async function resetPressureTargets(page) {
  await page.evaluate(() => {
    window.app.setPressureTargets(1);
    window.app.inputBufferManager?.tick();
  });
}

async function undoRedo(page, fn) {
  await page.evaluate((f) => {
    window.app[f]();
    window.app.inputBufferManager?.tick();
  }, fn);
  await sleep(300);
}

const TOOLS = [['ink', 'ink'], ['flowPen', 'fluid']];
const TARGETS = [[PRESSURE_TARGET_OPACITY, 'opacity'], [PRESSURE_TARGET_OPACITY | PRESSURE_TARGET_SIZE, 'opacity_size']];
const HARDNESS = [100, 60];

/**
 * Every pressure case as { name, action(page) }. Plain single-stroke cases come first,
 * then undo/redo and mid-stroke cancel / tool switch.
 */
export function pressureActions() {
  const cases = [];
  for (const [tool, tname] of TOOLS) {
    for (const [targets, gname] of TARGETS) {
      for (const hardness of HARDNESS) {
        cases.push({
          name: `pressure_${tname}_${gname}_h${hardness}`,
          action: async (page) => {
            await setPressureTool(page, { tool, targets, hardness });
            await drawPathPressure(page, figureEight());
            await resetPressureTargets(page);
          },
        });
      }
    }
  }
  cases.push({
    name: 'pressure_undo_redo',
    action: async (page) => {
      await setPressureTool(page, { tool: 'ink', targets: PRESSURE_TARGET_OPACITY, hardness: 100 });
      await drawPathPressure(page, figureEight({ cy: 330 }));
      await setPressureTool(page, { tool: 'flowPen', targets: PRESSURE_TARGET_OPACITY | PRESSURE_TARGET_SIZE, hardness: 60, color: [30, 90, 200, 1] });
      await drawPathPressure(page, figureEight({ cy: 700, pressurePhase: 2 }));
      await undoRedo(page, 'handleUndo');
      await undoRedo(page, 'handleRedo');
      await undoRedo(page, 'handleUndo');
      await undoRedo(page, 'handleRedo');
      await resetPressureTargets(page);
    },
  });
  cases.push({
    name: 'pressure_cancel_then_draw',
    action: async (page) => {
      await setPressureTool(page, { tool: 'ink', targets: PRESSURE_TARGET_OPACITY, hardness: 100 });
      await drawPathPressure(page, figureEight({ cy: 330 }), { abort: 'cancel', abortAfter: 45 });
      await drawPathPressure(page, figureEight({ cy: 330, pressurePhase: 1 }));
      await setPressureTool(page, { tool: 'flowPen', targets: PRESSURE_TARGET_OPACITY, hardness: 100, color: [30, 90, 200, 1] });
      await drawPathPressure(page, figureEight({ cy: 700 }), { abort: 'toolSwitch', abortAfter: 45 });
      await setPressureTool(page, { tool: 'flowPen', targets: PRESSURE_TARGET_OPACITY, hardness: 100, color: [30, 150, 60, 1] });
      await drawPathPressure(page, figureEight({ cy: 700, pressurePhase: 2 }));
      await resetPressureTargets(page);
    },
  });
  return cases;
}
