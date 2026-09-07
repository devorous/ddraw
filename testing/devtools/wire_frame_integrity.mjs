#!/usr/bin/env node
/**
 * @fileoverview Byte-level broadcast integrity probe — the oracle for the
 * shared-outbox / encoder-slab change.
 *
 * `Msg.encode(...).finish()` hands back a VIEW into protobufjs's pooled slab,
 * which the very next encode overwrites. `broadcastToRoom` therefore takes one
 * `.slice()` and every client's outbox now stores that single buffer BY
 * REFERENCE (it used to slice per client). That is only correct while nothing
 * downstream can mutate or re-encode into those bytes before they are flushed.
 *
 * Nothing in the pixel suites can see a violation: a torn frame either fails to
 * decode (and is dropped silently) or decodes to a *different valid message*,
 * which the compositor happily paints. Both look like "a stroke went missing",
 * which is indistinguishable from a hundred other causes.
 *
 * So this suite checks the bytes instead of the pixels. Every MM a bot sends is
 * SELF-DESCRIBING and VARIABLE-LENGTH in two independent fields:
 *
 *   g  = "b<bot>-m<seq>-" + "x" * (seq % 53)     ← variable-length string
 *   ps = [bot*1000+seq, bot*1000+seq] * (seq%7+1) ← variable-length float array
 *
 * Aliasing corruption cannot preserve that redundancy. A later, shorter encode
 * writing into the same slab truncates the padding or leaves a stale tail; a
 * cross-message overwrite breaks the g↔ps agreement. Both are caught here and
 * neither is visible anywhere else.
 *
 * Variable length is the point: a fixed-size payload can be overwritten by an
 * identically-shaped one and still look intact.
 *
 * Checks, per receiving bot:
 *   1. decode        — every inbound frame decodes (batched frames included)
 *   2. self-consistency — g's bot/seq agrees with ps's encoded identity
 *   3. exact length  — g padding == seq%53, ps length == 2*(seq%7+1)
 *   4. no duplicates — each (bot,seq) arrives at most once
 *   5. completeness  — every peer message arrives (loss is reported, not fatal)
 *
 * Usage:
 *   node testing/devtools/wire_frame_integrity.mjs
 *   node testing/devtools/wire_frame_integrity.mjs --bots=8 --msgs=100
 *
 * Requires the ws server on :8030 (`npm run dev` / `npm run server`).
 *
 * ── Known harness limit: read the INTEGRITY verdict, not the loss count ────
 * SpoofBot never completes the join-sync handshake, so every bot after the
 * first stays `joinSyncPending` and the server (correctly) withholds batchable
 * traffic from it — `shouldSkipJoinSyncPending`. In a 6-bot run only bot0 is
 * actually served, so "missing deliveries" reports ~5/6 loss BY DESIGN and
 * says nothing about the server. That is why loss exits 2 and only integrity
 * (corrupt / torn / duplicate) exits 1: bot0 still receives batched frames
 * from five interleaved senders, which is the whole aliasing danger zone.
 */

import { SpoofBot, sleep } from '../lib/spoofBot.mjs';
import { T } from '../../shared/MessageTypes.js';

let BOTS = 6, MSGS = 60, SETTLE_MS = 4000;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--bots=')) BOTS = Number(a.slice(7));
  else if (a.startsWith('--msgs=')) MSGS = Number(a.slice(7));
  else if (a.startsWith('--settle=')) SETTLE_MS = Number(a.slice(9));
}

const ROOM = `wireint_${Date.now()}`;
const pad = (seq) => 'x'.repeat(seq % 53);
const tagFor = (bot, seq) => `b${bot}-m${seq}-${pad(seq)}`;
const psLenFor = (seq) => 2 * ((seq % 7) + 1);
const idFor = (bot, seq) => bot * 1000 + seq;

function buildPs(bot, seq) {
  const v = idFor(bot, seq);
  const out = [];
  for (let k = 0; k < (seq % 7) + 1; k++) out.push(v, v);
  return out;
}

console.log('Top Draw — wire frame integrity probe');
console.log(`Room:   ${ROOM}`);
console.log(`Bots:   ${BOTS}   Messages/bot: ${MSGS}   (expect ${BOTS * (BOTS - 1) * MSGS} peer deliveries)`);
console.log('');

const bots = [];
for (let i = 0; i < BOTS; i++) {
  const bot = new SpoofBot({
    ip: `10.44.0.${i + 1}`,
    room: ROOM,
    name: `wire_${i}`,
    label: `wire_${i}`,
  });
  const outcome = await bot.join();
  if (!outcome.joined) {
    console.error(`❌ bot ${i} failed to join: ${JSON.stringify(outcome)}`);
    process.exit(1);
  }
  bots.push(bot);
}
console.log(`All ${BOTS} bots joined (session indices: ${bots.map(b => b.sessionIndex).join(', ')})`);

// Clear the join-time roster/sync chatter so only the probe traffic is scored.
for (const b of bots) b.messages.length = 0;

// Interleave hard: every bot emits its seq-j message back-to-back, so many
// distinct encodes land inside one batch window (the aliasing danger zone).
for (let j = 0; j < MSGS; j++) {
  for (let i = 0; i < BOTS; i++) {
    bots[i].send({ t: T.MM, ps: buildPs(i, j), g: tagFor(i, j) });
  }
  if (j % 5 === 4) await sleep(12);
}

await sleep(SETTLE_MS);

// ─── Score ─────────────────────────────────────────────────────────────────
const TAG_RE = /^b(\d+)-m(\d+)-(x*)$/;
let totalMM = 0, corrupt = 0, dupes = 0, malformedTag = 0;
const problems = [];
const perBotSeen = [];

for (let r = 0; r < BOTS; r++) {
  const seen = new Set();
  for (const m of bots[r].messages) {
    if (Number(m.t) !== T.MM) continue;
    totalMM++;
    const g = String(m.g ?? '');
    const mt = TAG_RE.exec(g);
    if (!mt) {
      malformedTag++;
      if (problems.length < 12) problems.push(`bot${r}: untaggable g=${JSON.stringify(g.slice(0, 40))}`);
      continue;
    }
    const bot = Number(mt[1]), seq = Number(mt[2]), padLen = mt[3].length;
    const key = `${bot}:${seq}`;
    if (seen.has(key)) {
      dupes++;
      if (problems.length < 12) problems.push(`bot${r}: DUPLICATE ${key}`);
    }
    seen.add(key);

    const ps = Array.from(m.ps ?? []);
    const errs = [];
    if (padLen !== seq % 53) errs.push(`g pad ${padLen} != ${seq % 53}`);
    if (ps.length !== psLenFor(seq)) errs.push(`ps len ${ps.length} != ${psLenFor(seq)}`);
    const want = idFor(bot, seq);
    if (ps.some(v => Math.abs(v - want) > 0.5)) errs.push(`ps values ${ps.slice(0, 4)} != ${want}`);
    if (errs.length) {
      corrupt++;
      if (problems.length < 12) problems.push(`bot${r}: ${key} — ${errs.join('; ')}`);
    }
  }
  perBotSeen.push(seen);
}

// Completeness: each receiver should see every peer's full run.
let missing = 0;
const missDetail = [];
for (let r = 0; r < BOTS; r++) {
  for (let s = 0; s < BOTS; s++) {
    if (s === r) continue;
    let gone = 0;
    for (let j = 0; j < MSGS; j++) if (!perBotSeen[r].has(`${s}:${j}`)) gone++;
    if (gone) { missing += gone; missDetail.push(`bot${r} missing ${gone}/${MSGS} from bot${s}`); }
  }
}

const expected = BOTS * (BOTS - 1) * MSGS;
console.log('');
console.log('────────────────────────────────────────────────────────────────');
console.log(`MM frames received:     ${totalMM} / ${expected} expected`);
console.log(`Corrupt (field disagreement): ${corrupt}`);
console.log(`Malformed tag (torn bytes):   ${malformedTag}`);
console.log(`Duplicates:                   ${dupes}`);
console.log(`Missing deliveries:           ${missing}`);
if (problems.length) {
  console.log('\nFirst problems:');
  for (const p of problems) console.log('  · ' + p);
}
if (missDetail.length) {
  console.log('\nLoss detail:');
  for (const d of missDetail.slice(0, 12)) console.log('  · ' + d);
}
console.log('────────────────────────────────────────────────────────────────');

for (const b of bots) b.socket?.close();
await sleep(300);

const integrityBroken = corrupt > 0 || malformedTag > 0 || dupes > 0;
if (integrityBroken) {
  console.log('❌ FAIL — frame integrity violated (encoder-slab aliasing suspected)');
  process.exit(1);
}
if (missing > 0) {
  console.log(`⚠️  INTEGRITY OK, but ${missing} deliveries were lost (see loss detail)`);
  process.exit(2);
}
console.log('✅ PASS — every frame arrived byte-exact, once, and complete');
process.exit(0);
