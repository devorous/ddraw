/**
 * How much does one extra user in a room cost the SERVER?
 *
 * Every message a user sends is relayed to every other user in the room, so a
 * room's relay volume is expected to grow with N*(N-1), not N. This measures
 * whether the server's actual CPU follows that, by sweeping the number of
 * concurrent drawers in a FRESH room per arm and sampling the server process's
 * own CPU time (so vite, k6 and this script's own load are excluded).
 *
 * Also attaches one passive observer that counts the messages a single
 * recipient receives, which separates the two halves of the cost: per-recipient
 * delivery volume (should rise ~linearly in N) versus total server work
 * (should rise ~quadratically if fan-out dominates).
 *
 * Usage:
 *   node testing/devtools/server_load_sweep.mjs --vus=2,4,6,8,12 --reps=2
 */
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SpoofBot, loadMsgType, sleep } from '../lib/spoofBot.mjs';
import { T } from '../../shared/MessageTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'perf-results');

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};
const VU_LIST = flag('vus', '2,4,6,8,12').split(',').map(Number);
const REPS = Number(flag('reps', 2));
const WINDOW_SEC = Number(flag('window', 15));
const SETTLE_SEC = Number(flag('settle', 8));
const K6_TOOLS = flag('k6tools', 'brush');
const SPECIAL = flag('special', '0');
const PORT = Number(flag('port', 8030));
const WS_URL = process.env.WS_URL || ('ws://127.0.0.1:' + PORT);

fs.mkdirSync(OUT_DIR, { recursive: true });
const Msg = await loadMsgType();

function serverPid() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess`],
  { encoding: 'utf8' }).trim();
  const pid = Number(out);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('could not find server pid on port ' + PORT);
  return pid;
}

/** Total processor-seconds and resident bytes for the server process. */
function sampleProc(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `$p=Get-Process -Id ${pid}; '{0}|{1}' -f $p.CPU, $p.WorkingSet64`], { encoding: 'utf8' }).trim();
  const [cpu, ws] = out.split('|');
  return { cpuSec: Number(cpu), rssBytes: Number(ws) };
}

const PID = serverPid();
console.log('server pid', PID, '| sweep', VU_LIST.join(','), '| reps', REPS);

async function runArm(vus) {
  const room = 'srv_' + vus + '_' + Date.now();
  // One passive observer, so per-recipient delivery volume is measured rather
  // than inferred. It is a real client to the server and counts toward the room.
  const obs = new SpoofBot({ ip: '198.51.100.9', room, name: 'OBS', label: 'obs', wsOrigin: WS_URL });
  const joined = await obs.join();
  if (!joined.joined) throw new Error('observer join failed: ' + JSON.stringify(joined));

  let framesIn = 0, bytesIn = 0, messagesIn = 0;
  obs.socket.on('message', (raw) => {
    const u8 = new Uint8Array(raw);
    framesIn++; bytesIn += u8.length;
    // Count sub-messages inside the server's concatenated batch frame.
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let off = 0, n = 0, ok = true;
    while (off + 4 <= u8.length) {
      const len = view.getUint32(off);
      if (len === 0 || off + 4 + len > u8.length) { ok = false; break; }
      off += 4 + len; n++;
    }
    messagesIn += (ok && off === u8.length) ? n : 1;
  });
  obs.socket.on('message', (raw) => {
    try {
      const m = Msg.decode(new Uint8Array(raw));
      if (m.t === T.PING) obs.send({ t: T.PONG, lowPowerMode: false, tabHidden: false });
    } catch { /* batch frame, not a lone PING */ }
  });

  const total = SETTLE_SEC + WINDOW_SEC + 10;
  const k6 = spawn('k6', ['run', '-e', 'ROOM=' + room, '-e', 'TARGET_URL=' + WS_URL,
    '-e', 'TOOLS=' + K6_TOOLS, '-e', 'SPECIAL_CHANCE=' + SPECIAL,
    '--vus=' + vus, '--duration=' + total + 's', 'testing/medium_stress_test.js'],
  { cwd: REPO_ROOT, stdio: 'ignore', shell: process.platform === 'win32' });

  await sleep(SETTLE_SEC * 1000);
  framesIn = 0; bytesIn = 0; messagesIn = 0;
  const a = sampleProc(PID);
  const t0 = Date.now();
  await sleep(WINDOW_SEC * 1000);
  const b = sampleProc(PID);
  const elapsed = (Date.now() - t0) / 1000;

  try { k6.kill(); } catch { /* already gone */ }
  obs.socket.close();
  await sleep(1500); // let the server tear the room down before the next arm

  const cpuPct = ((b.cpuSec - a.cpuSec) / elapsed) * 100;
  const clients = vus + 1; // drawers + observer
  return {
    vus, clients,
    cpuPct: +cpuPct.toFixed(2),
    cpuMsPerSec: +((b.cpuSec - a.cpuSec) / elapsed * 1000).toFixed(1),
    rssMb: +(b.rssBytes / 1048576).toFixed(1),
    rssDeltaMb: +((b.rssBytes - a.rssBytes) / 1048576).toFixed(1),
    msgsToOneRecipientPerSec: +(messagesIn / elapsed).toFixed(1),
    framesToOneRecipientPerSec: +(framesIn / elapsed).toFixed(1),
    kbToOneRecipientPerSec: +(bytesIn / elapsed / 1024).toFixed(2),
    // Total relay volume = what every client received, summed.
    estTotalRelayMsgsPerSec: +((messagesIn / elapsed) * clients).toFixed(0),
  };
}

const rows = [];
for (let r = 0; r < REPS; r++) {
  // Reverse the sweep direction on alternate reps so any monotonic drift in the
  // server process (heap growth, room accumulation) does not load onto the
  // high-N arms every time.
  const order = r % 2 === 0 ? VU_LIST : [...VU_LIST].reverse();
  for (const vus of order) {
    const row = await runArm(vus);
    rows.push({ rep: r + 1, ...row });
    console.log(`rep${r + 1} vus=${String(vus).padStart(2)} cpu ${String(row.cpuPct).padStart(6)}%  `
      + `rss ${row.rssMb}MB  recip ${row.msgsToOneRecipientPerSec} msg/s (${row.kbToOneRecipientPerSec} KB/s)  `
      + `total relay ~${row.estTotalRelayMsgsPerSec}/s`);
  }
}

const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const byVu = VU_LIST.map((v) => {
  const g = rows.filter((x) => x.vus === v);
  const clients = v + 1;
  const cpu = med(g.map((x) => x.cpuPct));
  return {
    vus: v, clients,
    cpuPct: cpu,
    cpuPerClient: +(cpu / clients).toFixed(3),
    cpuPerPair: +(cpu / (clients * (clients - 1))).toFixed(4),
    rssMb: med(g.map((x) => x.rssMb)),
    recipMsgsPerSec: med(g.map((x) => x.msgsToOneRecipientPerSec)),
    recipKbPerSec: med(g.map((x) => x.kbToOneRecipientPerSec)),
    totalRelayPerSec: med(g.map((x) => x.estTotalRelayMsgsPerSec)),
  };
});

fs.writeFileSync(path.join(OUT_DIR, 'server_load_sweep.json'), JSON.stringify({ byVu, rows }, null, 2));
console.log('\n=== SERVER LOAD vs ROOM SIZE (medians) ===');
console.log('drawers clients  cpu%   cpu/client  cpu/pair   rssMB  recip_msg/s  recip_KB/s  total_relay/s');
for (const r of byVu) {
  console.log(
    String(r.vus).padStart(7) + String(r.clients).padStart(8) + String(r.cpuPct).padStart(7)
    + String(r.cpuPerClient).padStart(12) + String(r.cpuPerPair).padStart(11)
    + String(r.rssMb).padStart(8) + String(r.recipMsgsPerSec).padStart(13)
    + String(r.recipKbPerSec).padStart(12) + String(r.totalRelayPerSec).padStart(15));
}
console.log('\nIf cpu/client rises with N the cost is super-linear (fan-out dominated);');
console.log('if cpu/pair is flat the cost tracks N*(N-1) relay operations.');
process.exit(0);
