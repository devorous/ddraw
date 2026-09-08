/**
 * What is actually on the wire to one recipient under multi-user load, and
 * which of the two available levers shrinks it?
 *
 *   1. `perMessageDeflate` on the `ws` server — zero protocol change. Measured
 *      here both ways `ws` can run it: with context takeover (one sliding
 *      window shared across frames, the library default) and without (a fresh
 *      deflate per frame, what a memory-constrained server would pick).
 *   2. Coalescing MM points per sender into fewer, larger messages — a real
 *      protocol change, and the thing the server-side backlog idea proposes.
 *
 * Measured INDEPENDENTLY and then together, so it is clear which lever pays.
 *
 * Note what the baseline already includes: the server concatenates every
 * batchable message into one length-delimited frame per client every 16ms
 * (33ms for a client that reported `lowPowerMode`), so "one frame" here is
 * already many messages and the per-FRAME overhead is already amortised. Run
 * with --lowpower to measure the cadence a weak client actually gets.
 *
 * Usage:
 *   node testing/devtools/wire_bandwidth_probe.mjs --vus=6 --seconds=20 --lowpower
 */
import { spawn } from 'child_process';
import zlib from 'zlib';
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
const VUS = Number(flag('vus', 6));
const SECONDS = Number(flag('seconds', 20));
const K6_TOOLS = flag('k6tools', 'brush');
const SPECIAL = flag('special', '0');
const LOW_POWER = args.includes('--lowpower');
const COALESCE_MS = Number(flag('coalesce', 100));
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8030';

fs.mkdirSync(OUT_DIR, { recursive: true });
const room = 'bw_' + Date.now();
const Msg = await loadMsgType();

const bot = new SpoofBot({ ip: '203.0.113.77', room, name: 'BWPROBE', label: 'bwprobe', wsOrigin: WS_URL });
const outcome = await bot.join();
if (!outcome.joined) {
  console.error('join failed:', JSON.stringify(outcome));
  process.exit(1);
}

/** @type {Uint8Array[]} every inbound WS frame, verbatim. */
const frames = [];
bot.socket.on('message', (raw) => frames.push(new Uint8Array(raw)));
// The server flushes a lowPowerMode client's outbox on the slower cadence, so
// the flag has to be reported before the load starts or the baseline is the
// wrong one. It is carried on PONG, which means answering PING for real.
bot.socket.on('message', (raw) => {
  try {
    const m = Msg.decode(new Uint8Array(raw));
    if (m.t === T.PING) bot.send({ t: T.PONG, lowPowerMode: LOW_POWER, tabHidden: false });
  } catch { /* concatenated batch frame, not a lone PING */ }
});
bot.send({ t: T.PONG, lowPowerMode: LOW_POWER, tabHidden: false });

const k6 = spawn('k6', ['run', '-e', 'ROOM=' + room, '-e', 'TARGET_URL=' + WS_URL,
  '-e', 'TOOLS=' + K6_TOOLS, '-e', 'SPECIAL_CHANCE=' + SPECIAL,
  '--vus=' + VUS, '--duration=' + (SECONDS + 8) + 's', 'testing/medium_stress_test.js'],
{ cwd: REPO_ROOT, stdio: 'ignore', shell: process.platform === 'win32' });

console.log('room ' + room + ', ' + VUS + ' VUs, lowPowerMode=' + LOW_POWER + '; settling 5s...');
await sleep(5000);
frames.length = 0;                       // discard the join burst
const t0 = Date.now();
await sleep(SECONDS * 1000);
const elapsed = (Date.now() - t0) / 1000;
try { k6.kill(); } catch { /* already gone */ }
bot.socket.close();

/** Split one length-delimited concatenated frame into its member messages. */
function splitFrame(frame) {
  // A lone message is sent unwrapped when the outbox held exactly one, so a
  // frame that does not parse as length-delimited is one message, not an error.
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const out = [];
  let offset = 0;
  while (offset + 4 <= frame.length) {
    const len = view.getUint32(offset);
    if (len === 0 || offset + 4 + len > frame.length) return null;
    out.push(frame.subarray(offset + 4, offset + 4 + len));
    offset += 4 + len;
  }
  return offset === frame.length ? out : null;
}

const messages = [];                     // { bytes, type, u, decoded }
let framedOverheadBytes = 0;
for (const frame of frames) {
  const parts = splitFrame(frame);
  if (parts) {
    framedOverheadBytes += 4 * parts.length;
    for (const p of parts) {
      try { messages.push({ bytes: p, decoded: Msg.decode(p) }); } catch { /* skip */ }
    }
  } else {
    try { messages.push({ bytes: frame, decoded: Msg.decode(frame) }); } catch { /* skip */ }
  }
}

const totalBytes = frames.reduce((a, f) => a + f.length, 0);
const byType = new Map();
for (const m of messages) {
  const k = m.decoded.t;
  const e = byType.get(k) || { count: 0, bytes: 0 };
  e.count++; e.bytes += m.bytes.length;
  byType.set(k, e);
}

/** deflateRaw the frame sequence the way permessage-deflate would. */
function deflateSequence(seq, { contextTakeover }) {
  let total = 0;
  if (contextTakeover) {
    // One stream for the whole connection, flushed per frame — the default
    // `ws` behaviour, and the reason repetitive small frames compress at all.
    const z = zlib.createDeflateRaw({ level: zlib.constants.Z_DEFAULT_COMPRESSION });
    const chunks = [];
    z.on('data', (c) => chunks.push(c));
    for (const f of seq) {
      z.write(Buffer.from(f));
      // Z_SYNC_FLUSH per frame, minus the 4-byte 00 00 FF FF tail the
      // extension strips — count it the way the wire would.
      total += 0;
    }
    return new Promise((resolve) => {
      z.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        z.end();
        z.on('end', () => {
          const len = Buffer.concat(chunks).length;
          resolve(Math.max(0, len - 4 * seq.length));
        });
        z.resume();
      });
    });
  }
  for (const f of seq) total += zlib.deflateRawSync(Buffer.from(f)).length;
  return Promise.resolve(total);
}

/**
 * Rebuild the MM stream with each sender's points merged into one message per
 * `windowMs`. Non-MM messages pass through untouched and in order, so the
 * result is a like-for-like frame sequence, not a synthetic best case.
 */
function coalesceMM(msgs, windowMs) {
  const out = [];
  const pending = new Map();               // sender -> { ps, rs, seq, t }
  const flush = (u) => {
    const p = pending.get(u);
    if (!p) return;
    pending.delete(u);
    const payload = { t: T.MM, u, ps: p.ps, seq: p.seq };
    if (p.rs.length) payload.rs = p.rs;
    out.push(Msg.encode(Msg.create(payload)).finish());
  };
  // Arrival index stands in for time: the server flushes on a fixed cadence,
  // so N messages per sender per window is the same thing measured in frames.
  let i = 0;
  for (const m of msgs) {
    const d = m.decoded;
    if (d.t !== T.MM) { out.push(m.bytes); i++; continue; }
    const u = d.u ?? 0;
    let p = pending.get(u);
    if (!p) { p = { ps: [], rs: [], seq: d.seq, startedAt: i }; pending.set(u, p); }
    // ps arrives delta-encoded per message; re-base onto the running sequence
    // so the merged message stays a single valid delta chain.
    const abs = [];
    let ax = d.ps[0] ?? 0, ay = d.ps[1] ?? 0;
    abs.push(ax, ay);
    for (let k = 2; k < d.ps.length; k += 2) { ax += d.ps[k]; ay += d.ps[k + 1]; abs.push(ax, ay); }
    if (p.ps.length === 0) {
      p.absLastX = abs[0]; p.absLastY = abs[1];
      p.ps.push(abs[0], abs[1]);
      for (let k = 2; k < abs.length; k += 2) {
        p.ps.push(abs[k] - p.absLastX, abs[k + 1] - p.absLastY);
        p.absLastX = abs[k]; p.absLastY = abs[k + 1];
      }
    } else {
      for (let k = 0; k < abs.length; k += 2) {
        p.ps.push(abs[k] - p.absLastX, abs[k + 1] - p.absLastY);
        p.absLastX = abs[k]; p.absLastY = abs[k + 1];
      }
    }
    if (d.rs?.length) p.rs.push(...d.rs);
    p.seq = d.seq;
    // windowMs is expressed in 16ms server flush ticks worth of arrivals.
    if (i - p.startedAt >= Math.max(1, Math.round(windowMs / 16)) * 8) flush(u);
    i++;
  }
  for (const u of [...pending.keys()]) flush(u);
  return out;
}

const rawSeq = frames;
const msgSeq = messages.map((m) => m.bytes);
const coalesced = coalesceMM(messages, COALESCE_MS);

const [dflCtx, dflNoCtx, dflCoalCtx] = await Promise.all([
  deflateSequence(rawSeq, { contextTakeover: true }),
  deflateSequence(rawSeq, { contextTakeover: false }),
  deflateSequence([Buffer.concat(coalesced.map(Buffer.from))], { contextTakeover: true }),
]);

const mmCount = byType.get(T.MM)?.count ?? 0;
const mmBytes = byType.get(T.MM)?.bytes ?? 0;
const coalescedBytes = coalesced.reduce((a, b) => a + b.length, 0);
const coalescedMM = coalesced.length - (messages.length - mmCount);

const kbs = (b) => +(b / elapsed / 1024).toFixed(2);
const report = {
  room, vus: VUS, seconds: +elapsed.toFixed(1), lowPowerMode: LOW_POWER,
  k6tools: K6_TOOLS, specialChance: SPECIAL, coalesceMs: COALESCE_MS,
  frames: frames.length,
  framesPerSec: +(frames.length / elapsed).toFixed(1),
  messages: messages.length,
  messagesPerSec: +(messages.length / elapsed).toFixed(1),
  mmCount, mmPerSec: +(mmCount / elapsed).toFixed(1),
  meanMessageBytes: messages.length ? +(msgSeq.reduce((a, b) => a + b.length, 0) / messages.length).toFixed(1) : 0,
  meanMmBytes: mmCount ? +(mmBytes / mmCount).toFixed(1) : 0,
  meanFrameBytes: frames.length ? +(totalBytes / frames.length).toFixed(1) : 0,
  lengthPrefixOverheadBytes: framedOverheadBytes,
  baseline: { bytes: totalBytes, kbPerSec: kbs(totalBytes) },
  deflateContextTakeover: { bytes: dflCtx, kbPerSec: kbs(dflCtx), savingPct: +((1 - dflCtx / totalBytes) * 100).toFixed(1) },
  deflateNoContextTakeover: { bytes: dflNoCtx, kbPerSec: kbs(dflNoCtx), savingPct: +((1 - dflNoCtx / totalBytes) * 100).toFixed(1) },
  coalesceOnly: {
    mmMessages: coalescedMM, bytes: coalescedBytes, kbPerSec: kbs(coalescedBytes),
    savingPct: +((1 - coalescedBytes / totalBytes) * 100).toFixed(1),
    mmMessageReduction: mmCount ? +(mmCount / Math.max(1, coalescedMM)).toFixed(2) + 'x' : 'n/a',
  },
  coalescePlusDeflate: { bytes: dflCoalCtx, kbPerSec: kbs(dflCoalCtx), savingPct: +((1 - dflCoalCtx / totalBytes) * 100).toFixed(1) },
  byType: [...byType.entries()]
    .map(([t, e]) => ({ type: t, count: e.count, bytes: e.bytes, pctBytes: +((e.bytes / totalBytes) * 100).toFixed(1) }))
    .sort((a, b) => b.bytes - a.bytes).slice(0, 12),
};
const outPath = path.join(OUT_DIR, 'wire_bandwidth' + (LOW_POWER ? '_lowpower' : '') + '.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
