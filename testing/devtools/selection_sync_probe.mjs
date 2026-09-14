/**
 * Two-user selection SYNC probe.
 *
 * Answers one question with wire-level evidence: when user A performs a
 * lift / move / commit, do those messages actually REACH user B, and does B's
 * board end up matching A's?
 *
 * Unlike selection_parity_suite (which asserts pixel parity and can only tell
 * you THAT something diverged), this counts SEL_* messages on both sides of the
 * wire — A's sends and B's receives — so a message that is never sent is
 * distinguishable from one that is sent and dropped.
 *
 *   node testing/devtools/selection_sync_probe.mjs [--headed]
 *
 * Requires `npm run dev` (vite :3000, ws server :8030).
 *
 * SCOPE — read before trusting a number from this file:
 *
 *   TRUSTWORTHY: the SENT/RECEIVED tallies and orders. They are direct hooks on
 *   `wsClient.send` and `wsClient._processMessage`, independent of rendering.
 *
 *   NOT TRUSTWORTHY HERE: the pixel percentages. With ONE drawer and passive
 *   observers this probe cannot get the room to a comparable state — measured
 *   repeatedly, the drawer sits at strokeStack=0 while the observer holds the
 *   same strokes at strokeStack=2, with the commit log and rolling hash
 *   IDENTICAL (e.g. `2|2664450731|0` vs `2|2664450731|2`). captureLayerSnapshots
 *   composites layer groups, so the drawer's own ink is simply absent from its
 *   snapshot and every comparison reports a fake 77-88% "desync". This is a
 *   limitation of this harness, NOT a product defect — do not report those
 *   numbers as a bug. `test:selparity` owns the pixel verdict: it drives the
 *   same real pointer pipeline across 3 live clients plus a late joiner and
 *   converges properly.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  captureLayerSnapshotsInPage, diffSnapshots, generateDiffPngInPage, PIXEL_TOLERANCE,
} from '../lib/layerDiff.mjs';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const VIEWPORT = { width: 1280, height: 800 };
const HEADED = process.argv.includes('--headed');
// --checkpoint runs in the LOBBY so auto-snapshots mint a real checkpoint and the
// joiner takes the checkpoint+tail path instead of a full-history replay.
const CHECKPOINT_MODE = process.argv.includes('--checkpoint');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const ROOM = `selsync_${Math.random().toString(36).slice(2, 10)}`;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const { T } = await import(pathToFileURL(`${ROOT}/shared/MessageTypes.js`).href);
const NAMES = {};
for (const [k, v] of Object.entries(T)) if (typeof v === 'number') NAMES[v] = k;
const SEL_TYPES = Object.entries(T)
  .filter(([k, v]) => typeof v === 'number' && /^SEL_|^IMG_PASTE$/.test(k))
  .map(([, v]) => v);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function evLiteral() {
  return `((x, y, extra) => Object.assign({
    button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1,
    offsetX: x, offsetY: y, clientX: x, clientY: y, pressure: 0.5,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {}
  }, extra || {}))`;
}

async function gesture(page, points, { settle = 18 } = {}) {
  await page.evaluate(async (pts, settleMs, evSrc) => {
    const app = window.app;
    const ev = eval(evSrc);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.handlePointerDown(ev(pts[0][0], pts[0][1]));
    app.inputBufferManager.tick();
    await nap(settleMs);
    for (let i = 1; i < pts.length; i++) {
      app.handlePointerMove(ev(pts[i][0], pts[i][1]));
      app.inputBufferManager.tick();
      await nap(settleMs);
    }
    const last = pts[pts.length - 1];
    app.handlePointerUp(ev(last[0], last[1]));
    app.inputBufferManager.tick();
    await nap(settleMs * 2);
  }, points, settle, evLiteral());
}

/**
 * Count SEL_* traffic on BOTH directions.
 *
 * Inbound is hooked at `wsClient._processMessage`, not `handleMessage`: batched
 * frames bypass handleMessage entirely and undercount high-frequency types.
 * Outbound is hooked at `wsClient.send`, which is the single choke point every
 * broadcastX() helper funnels through, so it sees the real emitted order.
 */
async function installProbe(page, selTypes) {
  await page.evaluate((types) => {
    const ws = window.app.wsClient;
    const want = new Set(types);
    window.__probe = { in: [], out: [] };

    const origProcess = ws._processMessage.bind(ws);
    ws._processMessage = function (data, ...rest) {
      try {
        const t = data?.t;
        if (want.has(t)) window.__probe.in.push({ t, u: data.u, seq: data.seq ?? null });
      } catch (_) {}
      return origProcess(data, ...rest);
    };

    const origSend = ws.send.bind(ws);
    ws.send = function (msg, ...rest) {
      try {
        if (want.has(msg?.t)) window.__probe.out.push({ t: msg.t, ly: msg.ly ?? null });
      } catch (_) {}
      return origSend(msg, ...rest);
    };
  }, selTypes);
}

const readProbe = (page) => page.evaluate(() => window.__probe || { in: [], out: [] });

function tally(list) {
  const out = {};
  for (const e of list) out[e.t] = (out[e.t] || 0) + 1;
  return Object.fromEntries(Object.entries(out).map(([t, n]) => [NAMES[t] || t, n]));
}

async function spawnTab(browser, label, room, { probeBeforeJoin = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on('pageerror', (e) => process.stderr.write(`  [${label} PAGEERROR] ${e.message}\n`));
  page.on('console', (m) => {
    const t = m.text();
    if (/TypeError|is not a function|desync|\[ERROR\]/i.test(t)) process.stdout.write(`  [${label}] ${t}\n`);
  });
  await page.evaluateOnNewDocument(() => {
    let seed = 0x2545f491;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  // Arm BEFORE joining so the probe captures the JOIN SYNC TAIL itself — the
  // whole question for a joiner is whether the selection commits arrive at all,
  // and they arrive during the serve, long before any post-join hook could see
  // them.
  if (probeBeforeJoin) await installProbe(page, SEL_TYPES);
  await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, label, room);
  await page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done && app?.sessionIndex != null;
  }, { timeout: 60_000 });
  await page.evaluate(() => window.app?.landingPage?.hide?.());
  await page.waitForFunction(() => !window.app?.landingPage?.isVisible, { timeout: 10_000 });
  return { label, page };
}

/**
 * Scribble across the selection rect. Geometry matches selection_parity_suite's
 * CONTENT/SEL_LEFT constants, which are known to put real ink under the
 * selection and to make [300,300] land INSIDE it — a drag starting outside the
 * rect silently begins a NEW selection instead of lifting, which looks exactly
 * like "the lift was never broadcast".
 */
async function scribble(page) {
  await page.evaluate(async () => {
    const app = window.app;
    app.selectTool('brush');
    app.handleSizeChange({ target: { value: 18 } });
    await new Promise((r) => setTimeout(r, 60));
  });
  for (const y of [200, 300, 400]) {
    await gesture(page, [[220, y], [400, y], [580, y]]);
  }
  await sleep(400);
}

/**
 * Client coords that land on a given BOARD point.
 *
 * Hardcoding client coords is a trap: zoom/pan and (worse) the Select tool's
 * fit-to-content shrink mean the committed selection is nowhere near the rect
 * you dragged, so a fixed "drag from here" starts a NEW selection instead of
 * lifting — which reads exactly like "the lift was never broadcast". The map is
 * affine and axis-aligned, so two samples invert it exactly.
 */
async function clientForBoard(page, bx, by) {
  return page.evaluate((tx, ty) => {
    const b = window.app.board;
    const p0 = b.getBoardRelativePos(0, 0);
    const p1 = b.getBoardRelativePos(1000, 1000);
    const sx = (p1.x - p0.x) / 1000;
    const sy = (p1.y - p0.y) / 1000;
    return { x: (tx - p0.x) / sx, y: (ty - p0.y) / sy };
  }, bx, by);
}

/** What the local Select tool actually holds — did the lift really happen? */
const selState = (page) => page.evaluate(() => {
  const rt = window.app.toolManager.getTool('select')?.realTool;
  if (!rt) return { loaded: false };
  return {
    loaded: true,
    mode: rt.mode,
    hasSelection: !!rt.selection,
    selection: rt.selection
      ? { x: Math.round(rt.selection.x), y: Math.round(rt.selection.y),
          w: Math.round(rt.selection.width), h: Math.round(rt.selection.height) }
      : null,
    hasFloating: !!rt.floatingCanvas,
  };
});

/**
 * Board pixels via the project's calibrated oracle, NOT `board.viewCanvas`.
 *
 * viewCanvas is a presentation surface — it is recomposited on its own schedule
 * and carries transient state — so diffing it reports strokes as "missing" that
 * the layers actually hold. layerDiff composites the layer GROUPS the same way
 * the app does (compositeLayerRange), which is the only capture the suites trust.
 */
const grab = (page) => page.evaluate(captureLayerSnapshotsInPage);

/** Wait until every tab agrees on commit history, stable across two reads. */
async function waitConverged(pages, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let prev = null;
  let lastSigs = [];
  while (Date.now() < deadline) {
    await sleep(400);
    // Commit log (count + rolling hash) AND total stack depth — the same
    // signature selection_parity_suite converges on, and all three parts are
    // load-bearing. Dropping totalStack looks tempting (the drawer and an
    // observer legitimately differ for a moment) but it is exactly the term that
    // waits for the drawer's OWN committed strokes to land in the layer groups.
    // captureLayerSnapshotsInPage composites layer groups, so without that wait
    // the drawer's snapshot is missing its own ink and every comparison reports a
    // fake ~77-88% "desync" that is really just an early read.
    const sigs = await Promise.all(pages.map((p) => p.evaluate(() => {
      const app = window.app;
      const lm = app?.board?.layerManager;
      const s = app?.wsClient?.strokeLog?.getSummary?.() ?? { count: 0, rollingHash: 0 };
      let totalStack = 0;
      for (const g of (lm?.layerGroups || [])) totalStack += (g.strokeStack || []).length;
      return `${s.count}|${s.rollingHash}|${totalStack}`;
    })));
    const agree = sigs.every((s) => s === sigs[0]);
    if (agree && prev === sigs[0]) return true;
    prev = agree ? sigs[0] : null;
    lastSigs = sigs;
  }
  console.log(`     [no convergence] sigs (count|hash|stack): ${lastSigs.join('   ')}`);
  return false;
}

const compare = (a, b) => diffSnapshots(a, b, PIXEL_TOLERANCE);

const SEL = { x0: 200, y0: 150, x1: 400, y1: 450 };  // [300,300] is inside
const DRAG_FROM = [300, 300];
const DRAG_BY = { dx: 300, dy: 120 };

/** Invoke a Select context-menu verb exactly as its click handler does. */
async function menu(page, verb, arg) {
  return page.evaluate(async (v, a) => {
    const app = window.app;
    const rt = app.toolManager.getTool('select').realTool;
    if (typeof rt[v] !== 'function') return { ok: false, missing: v };
    const out = a === undefined ? rt[v]() : rt[v](a);
    if (out && typeof out.then === 'function') await out;
    app.inputBufferManager.tick();
    await new Promise((r) => setTimeout(r, 250));
    return { ok: true };
  }, verb, arg);
}

/** Put the Select tool in a known mode with no stale selection. */
async function armSelect(page, mode = 'rect') {
  await page.evaluate(async (m) => {
    const app = window.app;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.selectTool('select');
    await nap(400);                       // SelectToolLoader loads lazily
    const rt = app.toolManager.getTool('select').realTool;
    rt.cancelSelection?.();
    rt.setMode(m);
    await nap(80);
  }, mode);
}

/** Drag the CURRENT selection by (dx,dy) from its own centre — see clientForBoard. */
async function dragSelection(page, dx, dy) {
  const st = await selState(page);
  if (!st.selection) return false;
  const c = st.selection;
  const from = await clientForBoard(page, c.x + c.w / 2, c.y + c.h / 2);
  const to = await clientForBoard(page, c.x + c.w / 2 + dx, c.y + c.h / 2 + dy);
  await gesture(page, [[from.x, from.y], [(from.x + to.x) / 2, (from.y + to.y) / 2], [to.x, to.y]]);
  await sleep(400);
  return true;
}

const rect = (page) => gesture(page, [
  [SEL.x0, SEL.y0], [(SEL.x0 + SEL.x1) / 2, (SEL.y0 + SEL.y1) / 2], [SEL.x1, SEL.y1],
]).then(() => sleep(300));

// Every board-mutating Select verb. Each runs in a FRESH room, then a joiner
// syncs and its stroke seqs are compared against a live observer's.
const VERBS = [
  { name: 'move_commit',   run: async (p) => { await armSelect(p); await rect(p); await dragSelection(p, DRAG_BY.dx, DRAG_BY.dy); await menu(p, 'deselect'); } },
  { name: 'move_toolswitch', run: async (p) => { await armSelect(p); await rect(p); await dragSelection(p, DRAG_BY.dx, DRAG_BY.dy); await p.evaluate(() => { window.app.selectTool('brush'); window.app.inputBufferManager.tick(); }); await sleep(500); } },
  { name: 'delete',        run: async (p) => { await armSelect(p); await rect(p); await menu(p, 'deleteSelection'); } },
  { name: 'fill',          run: async (p) => { await armSelect(p); await rect(p); await menu(p, 'fillSelection'); } },
  { name: 'stamp',         run: async (p) => { await armSelect(p); await rect(p); await dragSelection(p, DRAG_BY.dx, DRAG_BY.dy); await menu(p, 'stamp'); await menu(p, 'deselect'); } },
  { name: 'flip',          run: async (p) => { await armSelect(p); await rect(p); await dragSelection(p, DRAG_BY.dx, DRAG_BY.dy); await menu(p, 'flipHorizontal'); await menu(p, 'deselect'); } },
  { name: 'cut_paste',     run: async (p) => { await armSelect(p); await rect(p); await menu(p, 'cut'); await sleep(300); await menu(p, 'paste'); await sleep(400); await dragSelection(p, DRAG_BY.dx, DRAG_BY.dy); await menu(p, 'deselect'); } },
  { name: 'merge_down',    run: async (p) => { await armSelect(p); await rect(p); await menu(p, 'mergeDown'); } },
  // A stroke drawn AFTER the commit is what makes a seq-0 stamp visible: it
  // sorts above this stroke on a joiner and below it on a live client. Without
  // a trailing stroke the two orderings render identically and the bug hides.
  // THE reported repro: fill a selection, then move+stamp it around several
  // times. Every stamp keeps the float alive, so all of it renders live — but
  // the tape used to drop the SEL_LIFT at the first fill/stamp, leaving each
  // later stamp with no lift to rebuild from. A syncing client then no-op'd
  // every stamp and saw none of them.
  { name: 'fill_stamp_x3', run: async (p) => {
    await armSelect(p);
    await rect(p);
    await menu(p, 'fillSelection');
    await sleep(300);
    for (const [dx, dy] of [[260, 90], [260, 90], [-180, 200]]) {
      await dragSelection(p, dx, dy);
      await menu(p, 'stamp');
      await sleep(250);
    }
    await menu(p, 'deselect');
  } },
  { name: 'stamp_x3_nofill', run: async (p) => {
    await armSelect(p);
    await rect(p);
    for (const [dx, dy] of [[240, 80], [240, 80], [-160, 190]]) {
      await dragSelection(p, dx, dy);
      await menu(p, 'stamp');
      await sleep(250);
    }
    await menu(p, 'deselect');
  } },
  { name: 'move_then_draw', run: async (p) => {
    await armSelect(p); await rect(p); await dragSelection(p, DRAG_BY.dx, DRAG_BY.dy); await menu(p, 'deselect');
    await p.evaluate(async () => { window.app.selectTool('brush'); await new Promise((r) => setTimeout(r, 80)); });
    await gesture(p, [[250, 500], [450, 520], [650, 500]]);
    await sleep(400);
  } },
];

/** Stroke seq signature per layer. E = destination-out (lift-erase). */
const seqSig = (page) => page.evaluate(() => {
  const lm = window.app.board.layerManager;
  return (lm.layerGroups || []).map((g, i) => `L${i}[` + (g.strokeStack || [])
    .map((s) => `${s.blendMode === 'destination-out' ? 'E' : 'S'}${s.seq || 0}`).join(' ') + ']').join('  ');
});

const zeroSeqCount = (page) => page.evaluate(() => {
  const lm = window.app.board.layerManager;
  let n = 0;
  for (const g of (lm.layerGroups || [])) for (const s of (g.strokeStack || [])) if (!s.seq) n++;
  return n;
});

async function runVerb(browser, verb) {
  // CHECKPOINTS ONLY EXIST IN A PERSISTED ROOM.
  // `Room.canPersistSnapshots()` is `isRegistered() || id === 'lobby'`, so an
  // ad-hoc room name can NEVER mint a checkpoint: `getLatestSnapshotData` returns
  // null, baseSeq stays 0, and the joiner replays the FULL command tail — the
  // path that works. Every earlier version of this probe used a random room name
  // and therefore only ever exercised that path, which is why it came back 9/9
  // green while real rooms were visibly broken. Use the lobby so the joiner takes
  // the checkpoint + partial-tail path real users get.
  const room = CHECKPOINT_MODE ? 'lobby' : `selsync_${verb.name}_${Math.random().toString(36).slice(2, 8)}`;
  const A = await spawnTab(browser, 'A', room);
  const B = await spawnTab(browser, 'B', room);
  await scribble(A.page);
  await sleep(1200);

  await installProbe(A.page, SEL_TYPES);
  await verb.run(A.page);
  await sleep(1200);

  // Wait for an auto-snapshot to mint a checkpoint (15s timer server-side), so
  // the joiner is served an IMAGE + partial tail rather than the whole history.
  // The selection ops are still live/undoable here, i.e. ABOVE the baked
  // watermark the image captures — exactly the state that is reported broken.
  if (CHECKPOINT_MODE) {
    const minted = await B.page.evaluate(() => new Promise((res) => {
      const seen = window.__ckpt;
      if (seen) return res(seen);
      const t = setTimeout(() => res(null), 40_000);
      const orig = window.app.wsClient._processMessage.bind(window.app.wsClient);
      window.app.wsClient._processMessage = function (d, ...r) {
        if (d?.t === 145) {
          window.__ckpt = { seq: d.snapshotSeq };
          clearTimeout(t); res(window.__ckpt);
        }
        return orig(d, ...r);
      };
    })).catch(() => null);
    console.log(`       checkpoint minted: ${minted ? `seq ${minted.seq}` : 'NONE within 40s'}`);
  }

  // Joiner arrives AFTER the op and rebuilds from checkpoint + tail.
  const C = await spawnTab(browser, 'C', room, { probeBeforeJoin: true });
  await sleep(3000);

  const [sent, got] = [await readProbe(A.page), await readProbe(C.page)];
  const [sigB, sigC] = [await seqSig(B.page), await seqSig(C.page)];
  const zeroC = await zeroSeqCount(C.page);
  const [ib, ic] = [await grab(B.page), await grab(C.page)];
  const pix = compare(ib, ic);

  for (const t of [A, B, C]) await t.page.close().catch(() => {});

  return {
    name: verb.name,
    sent: tally(sent.out),
    joinerGot: tally(got.in),
    sigB, sigC, zeroC, pix,
    seqOk: sigB === sigC,
    pixOk: pix.pass,
  };
}

async function main() {
  console.log(`
Top Draw — selection SYNC probe (per-verb joiner seq parity)`);
  console.log(`Browser: ${TARGET_URL}`);
  console.log(`Oracle:  a JOINER's stroke seqs must equal a LIVE OBSERVER's.`);
  console.log(`         Pixels alone cannot see a seq-0 commit until something is`);
  console.log(`         drawn after it, so seq equality is the real verdict.
`);

  const browser = await puppeteer.launch({
    headless: !HEADED, defaultViewport: VIEWPORT,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  try {
    for (const verb of (ONLY.length ? VERBS.filter((v) => ONLY.includes(v.name)) : VERBS)) {
      try {
        const r = await runVerb(browser, verb);
        results.push(r);
        const mark = r.seqOk && r.pixOk ? '✅' : '❌';
        console.log(`  ${verb.name.padEnd(17)} ${mark} seq ${r.seqOk ? 'match' : 'MISMATCH'}  pixels ${r.pix.matchPct.toFixed(2)}%  joiner seq-0 strokes: ${r.zeroC}`);
        if (!r.seqOk) {
          console.log(`       live B : ${r.sigB}`);
          console.log(`       join C : ${r.sigC}`);
          console.log(`       A sent : ${JSON.stringify(r.sent)}   joiner got: ${JSON.stringify(r.joinerGot)}`);
        }
      } catch (e) {
        console.log(`  ${verb.name.padEnd(17)} ⚠ errored: ${e.message}`);
        results.push({ name: verb.name, seqOk: false, pixOk: false, error: e.message });
      }
    }
  } finally {
    if (!HEADED) await browser.close();
  }

  const bad = results.filter((r) => !r.seqOk || !r.pixOk);
  console.log(`
${'─'.repeat(70)}`);
  console.log(`RESULT: ${results.length - bad.length}/${results.length} verbs sync faithfully to a joiner`);
  if (bad.length) console.log(`BROKEN: ${bad.map((b) => b.name).join(', ')}`);
  console.log(`${'─'.repeat(70)}`);
  process.exitCode = bad.length ? 1 : 0;
}

await main();
