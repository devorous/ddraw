#!/usr/bin/env node
/**
 * @fileoverview Lag A/B for the pressure opacity mask accumulation modes.
 *
 * k6 bots and a DB-less server (both on this PC, server bound to the Tailscale IP,
 * built frontend served by it) feed a headless Chrome ON the weak laptop `book`,
 * which joins the same room and records its rAF frame times while they draw.
 * Book runs only that Chrome, so its CPU is not shared with anything else. Run once per mask mode, alternating (replace, max, replace,
 * max by default), each round on a fresh server and a fresh room. Prints one
 * summary table; never runs two things in parallel.
 *
 * Mask mode is forced in the viewer with localStorage.ddrawMaskMode (read by
 * src/utils/pressureMask.js).
 *
 * Usage (from the repo root, on the PC with k6 and ssh access to `book`):
 *   node testing/devtools/mask_k6_lag.mjs [--vus=6] [--seconds=60] [--rounds=2]
 *        [--modes=replace,max] [--tool=ink|pen] [--size=40] [--view=1280x720]
 *        [--skip-build] [--host=<this PC's tailscale ip>] [--port=8035]
 *
 * Needs on book: ~/mask-bench (puppeteer-core + chrome). Server files are staged
 * in %TEMP%/mask_k6_lag. k6 path: K6=... (default Program Files).
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const a = Object.fromEntries(process.argv.slice(2).map((s) => {
  const [k, ...v] = s.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const VUS = Number(a.vus || 6), SECONDS = Number(a.seconds || 60), ROUNDS = Number(a.rounds || 2);
const MODES = String(a.modes || 'replace,max').split(',');
const TOOL = a.tool || 'ink';
const TOOL_ID = { ink: 9, pen: 5 }[TOOL];
if (TOOL_ID === undefined) throw new Error('--tool must be ink or pen');
const BOT_SIZE = Number(a.size || 40);
const VIEW = String(a.view || '1280x720');
let HOST = String(a.host || '');
const PORT = Number(a.port || 8035);
const K6 = process.env.K6 || 'C:\\Program Files\\k6\\k6.exe';
// Viewer host: `book` (weak Celeron laptop, default) or `arch` (8 cores, runs live FlockBridge bots, so
// everything there is niced and only our own user-data-dir Chrome is ever killed).
const VIEWER_HOST = String(a.viewer || 'book');
if (!['book', 'arch'].includes(VIEWER_HOST)) throw new Error('--viewer must be book or arch');
const BOOK = VIEWER_HOST;
const NICE = VIEWER_HOST === 'arch' ? 'nice -n 10 ' : '';
const VIEWER_ENV = VIEWER_HOST === 'arch' ? 'PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium ' : '';
const app = path.join(os.tmpdir(), 'mask_k6_lag', 'app');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const work = path.join(os.tmpdir(), 'mask_k6_lag');
const distDir = path.join(app, 'dist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[mask-lag]', ...m);

function ssh(cmd, { input, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', BOOK, cmd],
      { timeout, maxBuffer: 1 << 24 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout)));
    if (input !== undefined) c.stdin.end(input);
  });
}

// ─── Viewer (runs on book under ~/mask-bench) ───────────────────────────────
const VIEWER = `
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import readline from 'node:readline';
const [url, room, mode, secs, view] = process.argv.slice(2);
const [vw, vh] = view.split('x').map(Number);
const exe = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.HOME + '/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome';
const cpu = () => fs.readFileSync('/proc/stat', 'utf8').split('\\n')[0].split(/\\s+/).slice(1, 9).map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 240000,
  userDataDir: process.env.HOME + '/mask-bench-prof',
  defaultViewport: { width: vw, height: vh },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGEERROR', String(e).slice(0, 200)));
  await page.evaluateOnNewDocument((m) => { localStorage.ddrawMaskMode = m; }, mode);
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 120000 });
  await page.evaluate(() => {
    const app = window.app;
    window.__frames = { on: false, gaps: [], last: 0 };
    (function tick(now) {
      const f = window.__frames;
      if (f.on) { if (f.last) f.gaps.push(now - f.last); f.last = now; } else f.last = 0;
      requestAnimationFrame(tick);
    })(performance.now());
    window.__strokeCount = () => app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0);
  });
  await page.evaluate((r) => { window.app.self.username = 'VIEWER'; window.app.handleRoomSelected(r); }, room);
  await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null, { timeout: 120000 });
  const stored = await page.evaluate(() => localStorage.ddrawMaskMode);
  console.log('VIEWER READY ' + JSON.stringify({ mode: stored }));
  await new Promise((resolve) => readline.createInterface({ input: process.stdin }).once('line', resolve));
  await page.evaluate(() => { const f = window.__frames; f.gaps.length = 0; f.last = 0; f.on = true; window.__t0 = performance.now(); window.__s0 = window.__strokeCount(); });
  const c0 = cpu();
  await sleep(Number(secs) * 1000);
  const c1 = cpu();
  const r = await page.evaluate(() => {
    const f = window.__frames; f.on = false;
    const ms = performance.now() - window.__t0;
    const g = f.gaps.slice(2).sort((x, y) => x - y);
    const pct = (p) => g[Math.floor(g.length * p)] || 0;
    const remote = [...window.app.users.values()].filter((u) => u !== window.app.self);
    return { rafCount: g.length, fps: +(g.length / (ms / 1000)).toFixed(1), p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2),
      p99: +pct(0.99).toFixed(2), max: +(g[g.length - 1] || 0).toFixed(2), over50: g.filter((v) => v > 50).length,
      remoteStrokes: window.__strokeCount() - window.__s0, remoteUsers: remote.length,
      opacityUsers: remote.filter((u) => (u.pressureTargets & 2) !== 0).length,
      board: window.app.board.dimensions ?? null };
  });
  const d = c1.map((v, i) => v - c0[i]);
  const total = d.reduce((x, y) => x + y, 0);
  r.cpuBusyPct = +(100 * (1 - (d[3] + d[4]) / total)).toFixed(1);
  r.load1 = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
  console.log('VIEWER RESULT ' + JSON.stringify(r));
} finally { await browser.close().catch(() => {}); }
process.exit(0);
`;

// ─── k6 bot script (generated, imports the repo helpers by file URL) ────────
function k6Script() {
  const actions = pathToFileURL(path.join(repo, 'testing', '_k6_actions.js')).href;
  const proto = pathToFileURL(path.join(repo, 'testing', '_k6_proto.js')).href;
  return `
import ws from 'k6/ws';
import { check } from 'k6';
import { buildMsg } from '${proto}';
import { T, configureTool, sendMove, sendDown, sendMoveBatch, sendUp, parseInbound, makeScribble, randColor } from '${actions}';

const DURATION_S = Number(__ENV.DURATION_S || 60);
export const options = { vus: Number(__ENV.VUS || 6), duration: (DURATION_S + 15) + 's' };
const W = 1920, H = 1080, TOOL = Number(__ENV.TOOL_ID);

export default function () {
  const url = __ENV.TARGET_URL + '/?room=' + __ENV.ROOM + '&v=' + __ENV.CLIENT_VERSION;
  const cols = Math.ceil(Math.sqrt(Number(__ENV.VUS || 6)));
  const col = (__VU - 1) % cols, row = Math.floor((__VU - 1) / cols);
  const rows = Math.ceil(Number(__ENV.VUS || 6) / cols);
  const homeX = (col + 0.5) * W / cols, homeY = (row + 0.5) * H / rows;
  const R = Math.min(W / cols, H / rows) * 0.3;
  let sessionIndex = -1;
  const res = ws.connect(url, {}, (socket) => {
    let started = false, stroke = null, idx = 0, idle = 0;
    const t0 = Date.now();
    socket.on('open', () => socket.sendBinary(buildMsg({ t: T.CONNECT, n: 'MASK_' + __VU })));
    socket.on('binaryMessage', (data) => {
      const { t, u } = parseInbound(data);
      if (t === 0 && u !== -1 && sessionIndex === -1) { sessionIndex = u; if (__VU === 1) console.log('bot session ' + u); }
    });
    socket.on('error', (e) => console.log('WS error: ' + e.error()));
    socket.setInterval(() => {
      if (sessionIndex === -1) return;
      if (!started) {
        started = true;
        configureTool(socket, sessionIndex, TOOL, { color: randColor(), size: Number(__ENV.BOT_SIZE || 40) * 100, activeLayer: 0, thinning: 0, simPressure: false, hardness: 100, spacing: 100 });
        return;
      }
      if (Date.now() - t0 > DURATION_S * 1000) {
        if (stroke) sendUp(socket, sessionIndex);
        socket.close();
        return;
      }
      if (!stroke) {
        if (++idle < 4) return;
        idle = 0;
        stroke = makeScribble(Math.random, homeX, homeY, R, 160);
        idx = 0;
        sendMove(socket, sessionIndex, stroke.points[0], stroke.points[1]);
        sendDown(socket, sessionIndex, stroke.points[0], stroke.points[1], { layer: 0, radii: [stroke.radii[0]] });
        idx = 1;
        return;
      }
      if (idx >= stroke.radii.length) { sendUp(socket, sessionIndex); stroke = null; return; }
      const end = Math.min(idx + 3, stroke.radii.length);
      sendMoveBatch(socket, sessionIndex, stroke.points.slice(idx * 2, end * 2), stroke.radii.slice(idx, end));
      idx = end;
    }, 16);
    socket.setTimeout(() => socket.close(), (DURATION_S + 10) * 1000);
  });
  check(res, { Connected: (r) => r && r.status === 101 });
}
`;
}

// ─── Orchestration ──────────────────────────────────────────────────────────
const children = new Set();
function killTree(c) {
  if (!c || c.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
  else c.kill('SIGKILL');
}

async function bookCleanup() {
  // [x] in the pattern keeps pkill from matching the ssh shell running this very command.
  await ssh(`pkill -f '[m]ask-bench/viewer.mjs'; pkill -f '[m]ask-bench-prof'; true`, { timeout: 30000 }).catch(() => {});
}

async function stage() {
  fs.mkdirSync(app, { recursive: true });
  if (!a['skip-build'] || !fs.existsSync(path.join(distDir, 'go', 'index.html'))) {
    log('vite build ->', distDir);
    await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [path.join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', distDir, '--emptyOutDir'],
        { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'],
          // .env points these at the live server; blank them so the page talks to the page's own host.
          env: { ...process.env, VITE_WS_SERVER_URL: '', VITE_API_BASE_URL: '' } });
      c.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('vite build failed ' + code))));
    });
  }
  // server/index.js serves ../dist and reads ../public/{messages.proto,version.json}.
  for (const d of ['server', 'shared']) fs.cpSync(path.join(repo, d), path.join(app, d), { recursive: true });
  fs.mkdirSync(path.join(app, 'public'), { recursive: true });
  for (const f of ['messages.proto', 'version.json']) fs.copyFileSync(path.join(repo, 'public', f), path.join(app, 'public', f));
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(app, 'package.json'));
  const nm = path.join(app, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(repo, 'node_modules'), nm, 'junction');
  fs.writeFileSync(path.join(work, 'bots.k6.js'), k6Script());
  await ssh(`mkdir -p ~/mask-bench && cat > ~/mask-bench/viewer.mjs`, { input: VIEWER });
  if (VIEWER_HOST === 'arch') await ssh('[ -e ~/mask-bench/node_modules ] || ln -s ~/ddraw-test/node_modules ~/mask-bench/node_modules');
}

const BLANK = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL', 'R2_SNAPSHOTS_BUCKET',
  'R2_SNAPSHOTS_ACCESS_KEY_ID', 'R2_SNAPSHOTS_SECRET_ACCESS_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET',
  'DISCORD_RELEASE_SECRET', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];

const serverLogs = [];
/** DB-less server on this PC (same env as testing/lib/dblessServer.mjs), bound to the Tailscale IP. */
async function startServer() {
  const env = { ...process.env };
  for (const k of BLANK) env[k] = '';
  Object.assign(env, {
    DOTENV_CONFIG_PATH: path.join(app, '.env.does-not-exist'),
    MONGODB_URI: 'mongodb://127.0.0.1:1/none?serverSelectionTimeoutMS=500&connectTimeoutMS=500',
    MONGODB_DB_NAME: 'none', NODE_ENV: 'test', HOST, PORT: String(PORT), DISABLE_RATE_LIMITS: 'true', JWT_SECRET: 'dbless-test-secret',
  });
  const child = spawn(process.execPath, ['server/index.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const logs = serverLogs;
  const onData = (b) => { for (const l of String(b).split(/\r?\n/)) if (l) logs.push(l); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (logs.some((l) => l.includes('server running on'))) return child;
    if (child.exitCode !== null) break;
  }
  killTree(child);
  throw new Error('server did not start:\n' + logs.slice(-15).join('\n'));
}

async function runRound(mode, label) {
  const room = `masklag_${label}_${Date.now()}`;
  await bookCleanup();
  const server = await startServer();
  const reach = await ssh(`curl -s -o /dev/null -m 10 -w '%{http_code}' http://${HOST}:${PORT}/go/`).catch(() => 'fail');
  if (reach.trim() !== '200') throw new Error(`${BOOK} cannot reach http://${HOST}:${PORT}/go/ (${reach.trim()})`);
  const load0 = (await ssh('cat /proc/loadavg')).split(' ')[0];
  const viewer = spawn('ssh', ['-o', 'BatchMode=yes', BOOK, `cd ~/mask-bench && ${VIEWER_ENV}${NICE}node viewer.mjs 'http://${HOST}:${PORT}/go/' ${room} ${mode} ${SECONDS - 14} ${VIEW}`],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(viewer);
  let vout = '';
  viewer.stdout.on('data', (b) => { vout += b; });
  viewer.stderr.on('data', (b) => { vout += b; });
  let k6 = null;
  try {
    const waitFor = (needle, ms) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (vout.includes(needle)) { clearInterval(iv); resolve(); }
        else if (viewer.exitCode !== null || Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`viewer: no "${needle}":\n${vout}`)); }
      }, 300);
    });
    await waitFor('VIEWER READY', 180000);
    let k6out = '';
    k6 = spawn(K6, ['run', '--quiet', '--summary-mode=disabled', '-e', `ROOM=${room}`, '-e', `TARGET_URL=ws://${HOST}:${PORT}`, '-e', `VUS=${VUS}`,
      '-e', `DURATION_S=${SECONDS}`, '-e', `TOOL_ID=${TOOL_ID}`, '-e', `BOT_SIZE=${BOT_SIZE}`, '-e', 'PRESSURE_OPACITY=1', '-e', `CLIENT_VERSION=${JSON.parse(fs.readFileSync(path.join(repo, 'public', 'version.json'), 'utf8')).latest}`,
      path.join(work, 'bots.k6.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(k6);
    k6.stdout.on('data', (b) => { k6out += b; });
    k6.stderr.on('data', (b) => { k6out += b; });
    await sleep(4000); // bots connect, configure and start their first strokes
    viewer.stdin.write('GO\n');
    await waitFor('VIEWER RESULT', (SECONDS + 60) * 1000);
    const line = vout.split('\n').find((l) => l.startsWith('VIEWER RESULT'));
    const r = JSON.parse(line.slice('VIEWER RESULT '.length));
    if (r.remoteUsers < 1) throw new Error('viewer saw no remote users: ' + line + '\nk6:\n' + k6out.slice(-1500));
    if (/WS error|level=error/.test(k6out)) log('k6 warnings:', k6out.trim().split('\n').slice(0, 3).join(' | '));
    r.mode = mode;
    r.load0 = Number(load0);
    r.load1After = Number((await ssh('cat /proc/loadavg')).split(' ')[0]);
    console.log(JSON.stringify(r));
    return r;
  } finally {
    killTree(k6); killTree(viewer); killTree(server);
    await bookCleanup();
  }
}

const rows = [];
let exitCode = 0;
try {
  if (!HOST) HOST = (await new Promise((res, rej) => execFile('tailscale', ['ip', '-4'], (e, o) => (e ? rej(e) : res(o))))).trim().split(/\s+/)[0];
  log('server/bots on', HOST + ':' + PORT);
  await stage();
  for (let round = 1; round <= ROUNDS; round++) {
    for (const mode of MODES) {
      log(`round ${round} mode ${mode}`);
      const r = await runRound(mode, `${mode}${round}`);
      rows.push({ round, ...r });
    }
  }
  console.log(`\nviewer on ${VIEWER_HOST} (${VIEW}), ${VUS} bots x ${SECONDS}s, tool ${TOOL}, size ${BOT_SIZE}, pressure opacity on`);
  const cols = ['mode', 'round', 'p50', 'p95', 'p99', 'max', 'over50', 'fps', 'rafCount', 'remoteStrokes', 'opacityUsers', 'cpuBusyPct', 'load0', 'load1', 'load1After'];
  console.log(cols.map((c) => c.padStart(13)).join(''));
  for (const r of rows) console.log(cols.map((c) => String(r[c] ?? '').padStart(13)).join(''));
  for (const m of MODES) {
    const rs = rows.filter((r) => r.mode === m);
    const avg = (k) => (rs.reduce((s, r) => s + r[k], 0) / rs.length).toFixed(2);
    console.log(`${m.padEnd(8)} mean: p50 ${avg('p50')} p95 ${avg('p95')} max ${avg('max')} over50 ${avg('over50')} fps ${avg('fps')} cpu ${avg('cpuBusyPct')}%`);
  }
} catch (e) {
  console.error('FAILED:', e.stack || e);
  exitCode = 1;
} finally {
  for (const c of children) killTree(c);
  await bookCleanup();
  await ssh(`rm -rf ~/mask-bench-prof`).catch(() => {});
  if (a.clean) fs.rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
