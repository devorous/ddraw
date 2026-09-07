/**
 * @fileoverview tapeDiff — the wire-level parity oracle.
 *
 * Companion to layerDiff.mjs. Where layerDiff scores how closely two clients
 * *rendered*, this compares what they were *told to render*: the .ddraw tape
 * each client's Recorder captured.
 *
 * The distinction matters. Two clients never render bit-identically —
 * antialiasing, soft-brush falloff and blend rounding drift a channel or two —
 * so a pixel diff must carry a tolerance and can only ever conclude "close
 * enough". A tape holds the decoded message stream, which admits an exact
 * answer: either every client received the same messages, in the same
 * per-sender order, with the same fields, or it did not. When it did not, the
 * diff names the offending message rather than a bounding box.
 *
 * Both runners (tape_compare.mjs CLI, concurrent_draw_undo_suite.mjs) import
 * from here so they ship the same guarantee.
 *
 * WHAT IS CHECKED
 *   1. Per-sender streams — a single WebSocket preserves order, so for any user
 *      U every client must observe U's messages in identical order with
 *      identical payloads. Diffed by LCS so one drop doesn't cascade.
 *   2. Seq agreement — the server numbers commit-class messages, so two tapes
 *      must agree on what seq N was.
 *   3. Per-type coverage — a whole missing verb shows up before you read a diff.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = path.resolve(HERE, '..', '..');

// ─── Message type names ──────────────────────────────────────────────────────

let _typeNames = null;

/** Resolve T enum value → name, from the shared enum so this cannot drift. */
export async function loadTypeNames() {
  if (_typeNames) return _typeNames;
  const mod = await import(pathToFileURL(path.join(ROOT, 'shared', 'MessageTypes.js')).href);
  const T = mod.T ?? mod.default?.T ?? mod.default;
  const byValue = new Map();
  for (const [name, value] of Object.entries(T)) {
    if (typeof value === 'number' && !byValue.has(value)) byValue.set(value, name);
  }
  _typeNames = { T, byValue };
  return _typeNames;
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/**
 * Load one tape from a .ddraw file, a raw recording JSON, or an in-memory
 * recording bundle.
 * @param {string|{label: string, recording: object}} input
 */
export async function loadTape(input) {
  if (typeof input !== 'string') {
    return finaliseTape(input.label, input.file ?? null, input.recording);
  }

  const bytes = new Uint8Array(fs.readFileSync(input));
  let recording;
  if (/\.json$/i.test(input)) {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    // Accept a bare recording or an evaluate_script capture wrapping one.
    recording = parsed.deltas ? parsed : (parsed.recording ?? parsed.bundle);
  } else {
    const { decodeDdraw } = await import(
      pathToFileURL(path.join(ROOT, 'shared', 'ddrawCodec.js')).href
    );
    recording = await decodeDdraw(bytes);
  }
  const label = path.basename(input).replace(/\.(ddraw|json)$/i, '');
  return finaliseTape(label, input, recording);
}

function finaliseTape(label, file, recording) {
  if (!recording?.deltas) throw new Error(`${label}: no deltas in bundle`);
  // The tape's owner is whoever's messages were taped outbound.
  const outUsers = new Set();
  for (const d of recording.deltas) if (d.dir === 'out' && d.msg?.u != null) outUsers.add(d.msg.u);
  return {
    label,
    file,
    recording,
    self: outUsers.size === 1 ? [...outUsers][0] : null,
    startedAt: recording.startedAt ?? recording.deltas[0]?.ts ?? 0,
    endedAt: recording.endedAt ?? recording.deltas.at(-1)?.ts ?? 0
  };
}

// ─── Normalisation ───────────────────────────────────────────────────────────

/**
 * proto3 defaults are indistinguishable from "unset" after a decode, and a
 * client's own messages are taped as the sparse object it constructed while
 * every observer tapes the fully-populated protobuf decode of the same message.
 * Dropping defaults on both sides is what makes those two comparable.
 * Cost: an explicit 0 and an absent field look the same here — which is exactly
 * how the client reads them (`data.ly ?? 0`), so it gives up no real coverage.
 */
function isDefaultish(value) {
  if (value === undefined || value === null) return true;
  if (value === 0 || value === false || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * The wire applies TWO different numeric transforms, and using one rule for both
 * makes a cosmetic gap read as a desync. Each is applied to the field it governs.
 *
 * `ps` (pointer/lasso paths) is delta-encoded as sint32 x10 by WebSocketClient's
 * encodePs, and decodePs inverts it exactly, so a receiver holds
 * `Math.round(sender * 10) / 10` computed on the DOUBLE. No float32 involved.
 *
 * Every other float field is a proto `float`, i.e. float32. A sender tapes the
 * JS double it computed (`637.05`); receivers tape the float32 that was actually
 * transmitted (`637.0499877929688`). `Math.fround` puts the sender in that same
 * space — verified against a real lasso path, where `Math.fround(sender)`
 * equalled the receiver's value for all 18 coordinates exactly.
 *
 * Applying the float32 rule to `ps` breaks it and vice versa: for 637.05 the ps
 * path rounds UP to 637.1 (Math.round of 6370.5) while fround rounds DOWN to
 * 637.0. Both were observed as false "desyncs" before this was split.
 */
export const WIRE_PRECISION = 1;  // decimal places encodePs keeps (PS_SCALE = 10)
const PS_QUANTIZED_KEYS = new Set(['ps']);

function normaliseNumber(value, key, precision) {
  if (!Number.isFinite(value) || Number.isInteger(value)) return value;
  if (PS_QUANTIZED_KEYS.has(key)) {
    const f = 10 ** precision;
    return Math.round(value * f) / f;
  }
  return Math.fround(value);
}

const UNSIGNED32_KEYS = new Set(['c', 'parityRollingHash', 'fingerprint']);

const VOLATILE_KEYS = new Set([
  // Server-assigned; absent on the sender's own tape BY DESIGN — the Recorder
  // drops the inbound self-echo of a client's own commits. Checked separately.
  'seq',
  'ts',   // wall clock
  'iid',  // per-connection instance id
  'sid'   // per-connection session token
]);

/** Reduce a decoded message to its meaningful fields, in stable key order. */
export function canonicalise(msg, precision = WIRE_PRECISION) {
  const out = {};
  for (const key of Object.keys(msg).sort()) {
    if (VOLATILE_KEYS.has(key)) continue;
    let value = msg[key];
    if (isDefaultish(value)) continue;
    if (typeof value === 'number' && UNSIGNED32_KEYS.has(key) && Number.isInteger(value)) {
      value = value >>> 0;
    } else if (typeof value === 'number') {
      value = normaliseNumber(value, key, precision);
    } else if (Array.isArray(value)) {
      value = value.map((v) => (typeof v === 'number' ? normaliseNumber(v, key, precision) : v));
    } else if (value instanceof Uint8Array) {
      value = `u8[${value.length}]`;
    } else if (typeof value === 'string' && value.length > 64) {
      // Image payloads. Keyed by length + head/tail so a genuinely different
      // image still differs, without dumping megabytes into the diff.
      value = `str[${value.length}]:${value.slice(0, 16)}…${value.slice(-8)}`;
    }
    out[key] = value;
  }
  return out;
}

/** Build the comparable event list for one tape. */
export function buildEvents(tape, { precision = WIRE_PRECISION, byValue, ignoreTypes = new Set(), onlyTypes = null } = {}) {
  const events = [];
  for (let i = 0; i < tape.recording.deltas.length; i++) {
    const delta = tape.recording.deltas[i];
    const msg = delta?.msg;
    if (!msg || msg.t == null) continue;
    const typeName = byValue?.get(msg.t) ?? `T${msg.t}`;
    if (ignoreTypes.has(typeName)) continue;
    if (onlyTypes && !onlyTypes.has(typeName)) continue;

    const canon = canonicalise(msg, precision);
    events.push({
      index: i,
      ts: delta.ts,
      dir: delta.dir,
      type: msg.t,
      typeName,
      user: msg.u ?? null,
      seq: Number.isFinite(msg.seq) && msg.seq > 0 ? msg.seq : null,
      canon,
      fp: JSON.stringify(canon)
    });
  }
  return events;
}

// ─── LCS diff ────────────────────────────────────────────────────────────────

const LCS_CELL_BUDGET = 4_000_000;

/**
 * Diff two event streams. LCS rather than index-by-index so a single dropped or
 * duplicated message reports as one op instead of misaligning everything after
 * it. Returns null when the streams are too large to diff (caller falls back to
 * comparing counts).
 */
export function diffStreams(a, b) {
  if (a.length * b.length > LCS_CELL_BUDGET) return null;

  // Trim the common prefix/suffix first; in practice that removes almost
  // everything and keeps the DP table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start].fp === b[start].fp) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA].fp === b[endB].fp) { endA--; endB--; }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const p = midA.length;
  const q = midB.length;
  if (p === 0 && q === 0) return [];

  const table = Array.from({ length: p + 1 }, () => new Uint32Array(q + 1));
  for (let i = p - 1; i >= 0; i--) {
    for (let j = q - 1; j >= 0; j--) {
      table[i][j] = midA[i].fp === midB[j].fp
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < p && j < q) {
    if (midA[i].fp === midB[j].fp) { i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) ops.push({ op: 'missing', event: midA[i++] });
    else ops.push({ op: 'extra', event: midB[j++] });
  }
  while (i < p) ops.push({ op: 'missing', event: midA[i++] });
  while (j < q) ops.push({ op: 'extra', event: midB[j++] });
  return ops;
}

// ─── Comparison ──────────────────────────────────────────────────────────────

function groupByUser(events) {
  const byUser = new Map();
  for (const event of events) {
    if (event.user == null) continue;
    if (!byUser.has(event.user)) byUser.set(event.user, []);
    byUser.get(event.user).push(event);
  }
  return byUser;
}

/**
 * Compare N tapes against a baseline.
 * @param {Array<object>} tapes - from loadTape()
 * @param {object} [options]
 * @returns {Promise<object>} structured result; `.ok` is the verdict
 */
export async function compareTapes(tapes, options = {}) {
  const {
    baselineLabel = null,
    precision = WIRE_PRECISION,
    ignoreTypes = new Set(),
    onlyTypes = null,
    // Set false when comparing a LATE JOINER's tape against an incumbent's. The
    // joiner is served the room's command tail, so it tapes messages that were
    // originally sent long before its recording started — their delta `ts` is
    // application time, not origin time, and clipping to a wall-clock overlap
    // would throw the whole tail away. The tail is *supposed* to reproduce the
    // live stream, so the right comparison is the unclipped per-sender LCS.
    clipToWindow = true
  } = options;

  const { byValue } = await loadTypeNames();
  for (const tape of tapes) {
    tape.events = buildEvents(tape, { precision, byValue, ignoreTypes, onlyTypes });
    tape.byUser = groupByUser(tape.events);
  }

  const baseline = baselineLabel
    ? tapes.find((t) => t.label === baselineLabel || t.label.startsWith(baselineLabel))
    : tapes[0];
  if (!baseline) {
    throw new Error(`baseline "${baselineLabel}" not found among ${tapes.map((t) => t.label).join(', ')}`);
  }
  const others = tapes.filter((t) => t !== baseline);

  // Tapes are started and stopped independently, so the head of one and the
  // tail of another are legitimately unshared. Comparing outside the overlap
  // reports timing as desync.
  const window = clipToWindow
    ? {
      start: Math.max(...tapes.map((t) => t.startedAt)),
      end: Math.min(...tapes.map((t) => t.endedAt))
    }
    : {
      start: Math.min(...tapes.map((t) => t.startedAt)),
      end: Math.max(...tapes.map((t) => t.endedAt))
    };
  const inWindow = clipToWindow
    ? (e) => e.ts >= window.start && e.ts <= window.end
    : () => true;

  const result = {
    baseline: baseline.label,
    window,
    clipped: clipToWindow,
    overlapped: window.end > window.start,
    tapes: tapes.map((t) => ({
      label: t.label,
      self: t.self,
      events: t.events.length,
      eventsInWindow: t.events.filter(inWindow).length,
      users: [...t.byUser.keys()].sort((a, b) => a - b)
    })),
    coverage: [],
    streams: [],
    seq: [],
    failures: 0,
    ok: false
  };

  if (!result.overlapped) return result;

  // 1. Per-type coverage
  const allTypes = new Set();
  for (const tape of tapes) for (const e of tape.events) if (inWindow(e)) allTypes.add(e.typeName);
  for (const typeName of [...allTypes].sort()) {
    const counts = tapes.map((t) => t.events.filter((e) => e.typeName === typeName && inWindow(e)).length);
    result.coverage.push({ typeName, counts, agree: counts.every((v) => v === counts[0]) });
  }

  // 2. Per-sender streams
  const allUsers = new Set();
  for (const tape of tapes) for (const u of tape.byUser.keys()) allUsers.add(u);

  for (const other of others) {
    for (const user of [...allUsers].sort((a, b) => a - b)) {
      const streamA = (baseline.byUser.get(user) ?? []).filter(inWindow);
      const streamB = (other.byUser.get(user) ?? []).filter(inWindow);
      if (streamA.length === 0 && streamB.length === 0) continue;

      const ops = diffStreams(streamA, streamB);
      const entry = {
        pair: [baseline.label, other.label],
        user,
        countA: streamA.length,
        countB: streamB.length,
        ops,
        truncated: ops === null,
        ok: ops === null ? streamA.length === streamB.length : ops.length === 0
      };
      if (!entry.ok) result.failures++;
      result.streams.push(entry);
    }
  }

  // 3. Seq agreement
  const seqMaps = new Map();
  for (const tape of tapes) {
    const map = new Map();
    for (const e of tape.events) {
      if (e.seq == null) continue;
      if (!map.has(e.seq)) map.set(e.seq, e);
    }
    seqMaps.set(tape.label, map);
  }
  const baseSeqs = seqMaps.get(baseline.label);
  for (const other of others) {
    const otherSeqs = seqMaps.get(other.label);
    const shared = [...baseSeqs.keys()].filter((s) => otherSeqs.has(s)).sort((a, b) => a - b);
    const mismatches = [];
    for (const seq of shared) {
      const ea = baseSeqs.get(seq);
      const eb = otherSeqs.get(seq);
      if (ea.fp !== eb.fp) mismatches.push({ seq, a: ea, b: eb });
    }
    const entry = {
      pair: [baseline.label, other.label],
      shared: shared.length,
      mismatches,
      ok: mismatches.length === 0
    };
    if (!entry.ok) result.failures++;
    result.seq.push(entry);
  }

  result.ok = result.failures === 0;
  return result;
}

// ─── Late-join verdict ───────────────────────────────────────────────────────

/**
 * Message types whose ABSENCE from a joiner's rebuilt tail is always a bug: each
 * one mutates committed board state, so losing it leaves the joiner with a
 * different board than everyone else.
 *
 * Everything NOT in this set is compaction the join serve is entitled to do, and
 * failing on it would leave the check permanently red — which trains people to
 * ignore it. Verified-benign examples: intermediate `SEL_PENDING` marquee sizes
 * collapse to the final selection (buildSelectionStateSet keeps the latest), and
 * a selection-gesture `MU` that committed no ink is not in the stroke log at all.
 * In both cases the joiner's pixels matched live parity exactly.
 */
export const JOIN_REQUIRED_TYPES = new Set([
  'SEL_COMMIT', 'SEL_DELETE', 'SEL_FILL', 'SEL_STAMP', 'SEL_MERGE', 'SEL_FLIP',
  'SEL_LIFT', 'UNDO', 'REDO', 'FILL', 'CLR', 'GLITCH_RESULT', 'IMG_PASTE',
  'TEXT_APPLY', 'BOARD_SNAPSHOT_RESTORE',
]);

/**
 * Turn a compareTapes() result into a LATE-JOIN verdict.
 *
 * The joiner comparison is a SUBSEQUENCE check, not equality: an incumbent's
 * recorder covers some window while the joiner replays the room's whole history,
 * so the joiner holding far MORE messages is correct. The failure condition is a
 * `missing` op — something an incumbent sent that the rebuilt tail lacks — and
 * only for a type that defines board state.
 *
 * Run compareTapes with `clipToWindow: false` before calling this: the joiner
 * tapes the tail at APPLICATION time, not origin time, so a wall-clock clip
 * would discard the entire tail.
 *
 * @returns {{ok: boolean, dropped: Array, compacted: Array, droppedByType: Object}}
 */
export function joinVerdict(result, { requiredTypes = JOIN_REQUIRED_TYPES } = {}) {
  const dropped = [];
  const compacted = [];
  const reordered = [];
  for (const stream of result.streams) {
    const ops = stream.ops ?? [];

    // A REORDER is not a loss. diffStreams is an LCS diff, so a message the
    // joiner holds at a different position shows up as a `missing` paired with
    // an `extra` carrying the identical fingerprint. That pairing is exactly
    // what the join serve produces on purpose: the selection preamble
    // (SEL_LIFT + SEL_MOVEs) is stored as a bundle keyed by its commit's seq
    // (server/StrokeTape.js) and replayed immediately BEFORE that commit, so on
    // the joiner it lands after the selection gesture's MU instead of before it.
    // Live order is re-established by seq — _sortStrokeStack orders the stack by
    // the authoritative seq, so the lift-erase (SEL_LIFT's seq) still sorts
    // beneath the stamp (SEL_COMMIT's seq) regardless of arrival order.
    //
    // Without this, which message the check blames is an artifact of LCS
    // alignment: the same reorder surfaced as a benign `MU` in every Apply-based
    // scenario but as a REQUIRED `SEL_LIFT` in the tool-switch variant, whose
    // extra tool-state frames shift the alignment. A genuinely absent message
    // has no fingerprint twin and is still reported as dropped.
    const extraFps = new Set();
    for (const op of ops) if (op.op === 'extra') extraFps.add(op.event.fp);

    // A SEL_LIFT retired by a SEL_CANCEL is legitimately absent, not lost.
    // `StrokeTape.observe` discards the whole pending selection preamble on
    // SEL_CANCEL (`this._pendingSelection.delete(uid)`) — the same way T.CANCEL
    // discards a cancelled stroke's `_pending` — because lift→move→cancel is a
    // no-op and replaying it to a joiner would be strictly wrong. So the joiner
    // holds neither the lift nor the cancel, and that is the correct tail.
    //
    // Only a lift whose gesture actually COMMITTED is required. Anything else
    // would either blind this check to real lift loss (by dropping SEL_LIFT
    // from requiredTypes outright) or fail every cancel scenario.
    const cancelledLiftIdx = new Set();
    let openLiftIdx = -1;
    for (let i = 0; i < ops.length; i++) {
      const name = ops[i].event?.typeName;
      if (name === 'SEL_LIFT') openLiftIdx = i;
      else if (name === 'SEL_CANCEL') {
        if (openLiftIdx >= 0) cancelledLiftIdx.add(openLiftIdx);
        openLiftIdx = -1;
      } else if (requiredTypes.has(name) && name !== 'SEL_LIFT') {
        // A commit closed the gesture — its lift stands on its own.
        openLiftIdx = -1;
      }
    }

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.op !== 'missing') continue;
      const entry = { user: stream.user, event: op.event };
      if (extraFps.has(op.event.fp)) reordered.push(entry);
      else if (cancelledLiftIdx.has(i)) compacted.push(entry);
      else if (requiredTypes.has(op.event.typeName)) dropped.push(entry);
      else compacted.push(entry);
    }
  }
  const droppedByType = {};
  for (const d of dropped) droppedByType[d.event.typeName] = (droppedByType[d.event.typeName] || 0) + 1;
  return { ok: dropped.length === 0, dropped, compacted, reordered, droppedByType };
}

// ─── Reporting ───────────────────────────────────────────────────────────────

const C = {
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m'
};

export function describeEvent(event, verbose = false) {
  const seq = event.seq != null ? ` seq=${event.seq}` : '';
  const head = `${event.typeName}(u${event.user})${seq}`;
  if (verbose) return `${head} ${JSON.stringify(event.canon)}`;
  const keys = Object.keys(event.canon).filter((k) => k !== 't' && k !== 'u');
  return `${head} ${C.dim}{${keys.slice(0, 8).join(',')}}${C.reset}`;
}

/** Render a compareTapes() result as the console report. */
export function formatReport(result, { verbose = false, maxDiffs = 25, showCoverage = true } = {}) {
  const out = [];
  const push = (s = '') => out.push(s);

  push('Top Draw — .ddraw tape comparison (wire level, not pixels)');
  push(`Baseline:   ${result.baseline}`);
  push(`${result.clipped ? 'Overlap:  ' : 'Span:     '}  `
    + `${new Date(result.window.start).toISOString()} → ${new Date(result.window.end).toISOString()}`
    + `  (${((result.window.end - result.window.start) / 1000).toFixed(1)}s)`
    + (result.clipped ? '' : '  [unclipped — late-join mode]'));
  push('');
  push('Tapes');
  for (const t of result.tapes) {
    push(`  ${t.label.slice(0, 34).padEnd(35)} owner=${String(t.self != null ? `u${t.self}` : '?').padEnd(4)} `
      + `${String(t.events).padStart(6)} events (${t.eventsInWindow} in window)  users=[${t.users.join(',')}]`);
  }
  push('');

  if (!result.overlapped) {
    push(`${C.red}The tapes do not overlap in time — nothing to compare.${C.reset}`);
    push('Start recording in every window before drawing, and stop them after.');
    return out.join('\n');
  }

  if (showCoverage) {
    push('Message coverage (in window)');
    push(`   ${'type'.padEnd(21)}${result.tapes.map((t) => t.label.slice(-14).padStart(15)).join('')}`);
    for (const row of result.coverage) {
      const cells = row.counts.map((v) => String(v).padStart(15)).join('');
      push(`  ${row.agree ? ' ' : C.red + '!' + C.reset}${row.typeName.padEnd(21)}${cells}`);
    }
    push('');
  }

  push('Per-sender stream diffs  (a single socket preserves order, so these must match exactly)');
  let lastPair = null;
  for (const entry of result.streams) {
    const pairKey = entry.pair.join('↔');
    if (pairKey !== lastPair) { push(`\n  ${entry.pair[0]} ↔ ${entry.pair[1]}`); lastPair = pairKey; }
    if (entry.truncated) {
      push(`    ${entry.ok ? C.yellow + '~' + C.reset : C.red + '✗' + C.reset} u${entry.user}: `
        + `${entry.countA} vs ${entry.countB} ${C.dim}(too large for an LCS diff — counts only)${C.reset}`);
      continue;
    }
    if (entry.ok) {
      push(`    ${C.green}✓${C.reset} u${entry.user}: ${entry.countA} messages identical`);
      continue;
    }
    const missing = entry.ops.filter((o) => o.op === 'missing').length;
    const extra = entry.ops.filter((o) => o.op === 'extra').length;
    push(`    ${C.red}✗${C.reset} u${entry.user}: ${entry.countA} vs ${entry.countB} — `
      + `${missing} only in ${entry.pair[0]}, ${extra} only in ${entry.pair[1]}`);
    for (const op of entry.ops.slice(0, maxDiffs)) {
      const marker = op.op === 'missing'
        ? `${C.red}− ${entry.pair[0]}${C.reset}`
        : `${C.yellow}+ ${entry.pair[1]}${C.reset}`;
      push(`        ${marker}  ${describeEvent(op.event, verbose)}`);
    }
    if (entry.ops.length > maxDiffs) push(`        ${C.dim}… ${entry.ops.length - maxDiffs} more${C.reset}`);
  }

  push('\nCommit seq agreement  (the server numbers commits; every tape must agree on what seq N was)');
  let seqChecked = 0;
  for (const entry of result.seq) {
    seqChecked += entry.shared;
    if (entry.ok) {
      push(`    ${C.green}✓${C.reset} ${entry.pair[0]} ↔ ${entry.pair[1]}: ${entry.shared} shared seqs agree`);
      continue;
    }
    push(`    ${C.red}✗${C.reset} ${entry.pair[0]} ↔ ${entry.pair[1]}: `
      + `${entry.mismatches.length}/${entry.shared} shared seqs disagree`);
    for (const m of entry.mismatches.slice(0, maxDiffs)) {
      push(`        seq ${m.seq}: ${entry.pair[0]} ${describeEvent(m.a, verbose)}`);
      push(`        ${' '.repeat(4 + String(m.seq).length)} ${entry.pair[1]} ${describeEvent(m.b, verbose)}`);
    }
  }
  if (seqChecked === 0) push(`    ${C.dim}no shared sequenced commits in the overlap window${C.reset}`);

  push('\n' + '─'.repeat(72));
  if (result.ok) {
    push(`${C.green}TAPES AGREE${C.reset} — every client saw the same message stream (${seqChecked} seq checks). `
      + `Any pixel difference left is a renderer artifact.`);
  } else {
    push(`${C.red}TAPES DISAGREE${C.reset} — ${result.failures} stream/seq check(s) failed. `
      + `A client acted on different input, so the boards cannot be expected to match.`);
  }
  push('─'.repeat(72));
  return out.join('\n');
}
