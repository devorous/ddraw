#!/usr/bin/env node
/**
 * @fileoverview Function-level breakdown of a Chrome trace's CPU profile —
 * the same data DevTools' Performance panel Bottom-Up view shows, parsed
 * from the raw `Profile`/`ProfileChunk` trace events.
 *
 * trace_gpu_report.mjs answers "which THREAD is stalling" (event-name
 * aggregates). This answers "which FUNCTION is actually running" — needs the
 * `disabled-by-default-v8.cpu_profiler` category enabled when the trace was
 * captured, or there are no samples to walk.
 *
 * Usage:
 *   node testing/devtools/trace_function_report.mjs <trace.json> [--top=25]
 *   node testing/devtools/trace_function_report.mjs <trace.json> --roots=a,b,c
 *
 * `--roots` switches to SUBTREE attribution: every sample is charged to the
 * INNERMOST ancestor (or itself) whose function name matches one of the named
 * roots, and anything matching none is charged to `(unattributed)`. Innermost
 * wins because the phases of interest nest — the remote-preview render runs
 * synchronously inside the inbound message drain, so an outermost-wins rule
 * would hide the render inside the receive cost and answer the wrong question.
 * Names match on the function name alone, case-sensitively, exact.
 */
import fs from 'fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const TOP = Number(args.find((a) => a.startsWith('--top='))?.slice(6)) || 25;
const ROOTS = (args.find((a) => a.startsWith('--roots='))?.slice(8) || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
// --under=<fn>: self-time leaders restricted to <fn>'s subtree — "where does
// that one phase's time actually go", the follow-up --roots always provokes.
const UNDER = args.find((a) => a.startsWith('--under='))?.slice(8)?.trim() || '';
// --callers=<fn>: who is paying for a hot native leaf (getImageData, drawImage
// …). Charges each of that leaf's samples to its nearest ancestor that has a
// source URL, i.e. the app function that called into the browser.
const CALLERS = args.find((a) => a.startsWith('--callers='))?.slice(10)?.trim() || '';

if (!file) {
  console.error('usage: trace_function_report.mjs <trace.json> [--top=N]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = raw.traceEvents || raw;

const threadNames = {};
const processNames = {};
for (const e of events) {
  if (e.name === 'thread_name' && e.args?.name) threadNames[`${e.pid}:${e.tid}`] = e.args.name;
  if (e.name === 'process_name' && e.args?.name) processNames[e.pid] = e.args.name;
}
const where = (pid, tid) => `${processNames[pid] || '?'} | ${threadNames[`${pid}:${tid}`] || tid}`;

// Profile events come in two parts per thread: one `Profile` (metadata,
// startTime) and a stream of `ProfileChunk` (nodes + samples + timeDeltas),
// keyed by the same `id`. Merge chunks before walking samples.
const profiles = new Map(); // id -> { pid, tid, startTime, nodes: Map<id,node>, samples: [], timeDeltas: [] }

for (const e of events) {
  if (e.name === 'Profile' && e.id) {
    const key = e.id;
    if (!profiles.has(key)) profiles.set(key, { pid: e.pid, tid: e.tid, nodes: new Map(), samples: [], timeDeltas: [] });
    const p = profiles.get(key);
    p.startTime = e.args?.data?.startTime ?? e.ts;
  }
  if (e.name === 'ProfileChunk' && e.id) {
    const key = e.id;
    if (!profiles.has(key)) profiles.set(key, { pid: e.pid, tid: e.tid, nodes: new Map(), samples: [], timeDeltas: [] });
    const p = profiles.get(key);
    const cpuProfile = e.args?.data?.cpuProfile;
    if (cpuProfile?.nodes) {
      for (const n of cpuProfile.nodes) p.nodes.set(n.id, n);
    }
    if (cpuProfile?.samples) p.samples.push(...cpuProfile.samples);
    const deltas = e.args?.data?.timeDeltas;
    if (deltas) p.timeDeltas.push(...deltas);
  }
}

if (profiles.size === 0) {
  console.log(`\n=== ${file}`);
  console.log('No CPU profile samples found — trace was not captured with');
  console.log("'disabled-by-default-v8.cpu_profiler' in its categories.\n");
  process.exit(0);
}

console.log(`\n=== ${file}`);

for (const [id, p] of profiles) {
  if (p.samples.length === 0) continue;

  // Reconstruct each sample's absolute timestamp from the cumulative deltas
  // (deltas align 1:1 with samples, first delta is startTime -> sample[0]).
  let t = p.startTime || 0;
  const sampleDurations = []; // duration this sample's node was "current"
  for (let i = 0; i < p.samples.length; i++) {
    const delta = p.timeDeltas[i] ?? 0;
    t += delta;
    // duration attributed to sample i is the gap to the NEXT sample
    const nextDelta = p.timeDeltas[i + 1] ?? 0;
    sampleDurations.push(nextDelta);
  }

  // Self time per node id (this is exactly "self time" in DevTools' Bottom-Up).
  const selfTimeByNode = new Map();
  for (let i = 0; i < p.samples.length; i++) {
    const nodeId = p.samples[i];
    const dur = sampleDurations[i] || 0;
    selfTimeByNode.set(nodeId, (selfTimeByNode.get(nodeId) || 0) + dur);
  }

  const label = where(p.pid, p.tid);
  const totalUs = [...selfTimeByNode.values()].reduce((a, b) => a + b, 0);

  if (CALLERS) {
    const parent = new Map();
    for (const n of p.nodes.values()) {
      if (n.parent != null) parent.set(n.id, n.parent);
      for (const c of n.children || []) parent.set(c, n.id);
    }
    const byCaller = new Map();
    let leafTotal = 0;
    for (const [nodeId, us] of selfTimeByNode) {
      if (p.nodes.get(nodeId)?.callFrame?.functionName !== CALLERS) continue;
      leafTotal += us;
      let cur = parent.get(nodeId);
      let key = '(no scripted caller)';
      while (cur != null) {
        const cf = p.nodes.get(cur)?.callFrame;
        if (cf?.url) {
          key = `${cf.functionName || '(anonymous)'} (${cf.url.split('/').slice(-2).join('/')}:${(cf.lineNumber ?? 0) + 1})`;
          break;
        }
        cur = parent.get(cur);
      }
      byCaller.set(key, (byCaller.get(key) || 0) + us);
    }
    console.log(`
-- ${label} :: CALLERS OF ${CALLERS} (${(leafTotal / 1000).toFixed(1)} ms = ${((leafTotal / totalUs) * 100).toFixed(1)}% of thread) --`);
    console.log('  self_ms   %ofleaf  caller (file:line)');
    for (const [k, us] of [...byCaller.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
      console.log(`  ${(us / 1000).toFixed(1).padStart(7)}  ${((us / (leafTotal || 1)) * 100).toFixed(1).padStart(7)}%  ${k}`);
    }
    continue;
  }

  if (UNDER) {
    const parent = new Map();
    for (const n of p.nodes.values()) {
      if (n.parent != null) parent.set(n.id, n.parent);
      for (const c of n.children || []) parent.set(c, n.id);
    }
    const inCache = new Map();
    const isUnder = (nodeId) => {
      if (inCache.has(nodeId)) return inCache.get(nodeId);
      const chain = [];
      let cur = nodeId;
      let res = false;
      while (cur != null) {
        if (inCache.has(cur)) { res = inCache.get(cur); break; }
        chain.push(cur);
        if (p.nodes.get(cur)?.callFrame?.functionName === UNDER) { res = true; break; }
        cur = parent.get(cur);
      }
      for (const id of chain) inCache.set(id, res);
      return res;
    };
    const rows = [...selfTimeByNode.entries()]
      .filter(([nodeId, us]) => us > 0 && isUnder(nodeId))
      .map(([nodeId, us]) => {
        const cf = p.nodes.get(nodeId)?.callFrame;
        const url = cf?.url ? cf.url.split('/').slice(-2).join('/') : '';
        const line = cf?.lineNumber != null ? cf.lineNumber + 1 : '';
        return { us, label: `${cf?.functionName || '(anonymous)'} (${url}${line ? ':' + line : ''})` };
      })
      .sort((a, b) => b.us - a.us);
    const underTotal = rows.reduce((a, r) => a + r.us, 0);
    console.log(`
-- ${label} :: SELF TIME UNDER ${UNDER} (${(underTotal / 1000).toFixed(1)} ms = ${((underTotal / totalUs) * 100).toFixed(1)}% of thread) --`);
    console.log('  self_ms   %ofsub  function (file:line)');
    for (const r of rows.slice(0, TOP)) {
      console.log(`  ${(r.us / 1000).toFixed(1).padStart(7)}  ${((r.us / underTotal) * 100).toFixed(1).padStart(6)}%  ${r.label}`);
    }
    continue;
  }

  if (ROOTS.length > 0) {
    // Chrome's INCREMENTAL ProfileChunk format gives each newly-seen node a
    // `parent` id; the one-shot Profiler.takeProfile format instead gives each
    // node a `children` array. Accept both — reading only `children` silently
    // produces a flat tree where every subtree total equals its self time.
    const parent = new Map();
    for (const n of p.nodes.values()) {
      if (n.parent != null) parent.set(n.id, n.parent);
      for (const c of n.children || []) parent.set(c, n.id);
    }
    const rootSet = new Set(ROOTS);
    // A node's owner never changes, and hot stacks repeat constantly, so the
    // upward walk is memoised — otherwise this is O(samples x depth).
    const ownerCache = new Map();
    const ownerOf = (nodeId) => {
      if (ownerCache.has(nodeId)) return ownerCache.get(nodeId);
      const chain = [];
      let cur = nodeId;
      let found = '(unattributed)';
      while (cur != null) {
        if (ownerCache.has(cur)) { found = ownerCache.get(cur); break; }
        chain.push(cur);
        const name = p.nodes.get(cur)?.callFrame?.functionName;
        if (name && rootSet.has(name)) { found = name; break; }
        cur = parent.get(cur);
      }
      for (const id of chain) ownerCache.set(id, found);
      return found;
    };

    const byRoot = new Map();
    for (const [nodeId, us] of selfTimeByNode) {
      const owner = ownerOf(nodeId);
      byRoot.set(owner, (byRoot.get(owner) || 0) + us);
    }
    console.log(`
-- ${label} :: SUBTREE ATTRIBUTION (${(totalUs / 1000).toFixed(0)} ms sampled) --`);
    console.log('  total_ms   %total  root');
    for (const [name, us] of [...byRoot.entries()].sort((a, b) => b[1] - a[1])) {
      const pc = totalUs > 0 ? ((us / totalUs) * 100).toFixed(1) : '0';
      console.log(`  ${(us / 1000).toFixed(1).padStart(8)}  ${pc.padStart(6)}%  ${name}`);
    }
    continue;
  }
  console.log(`\n-- ${label} (${p.samples.length} samples, ${(totalUs / 1000).toFixed(0)} ms sampled) --`);
  console.log('  self_ms   %total  function (file:line)');

  const rows = [...selfTimeByNode.entries()]
    .map(([nodeId, us]) => {
      const node = p.nodes.get(nodeId);
      const cf = node?.callFrame;
      const fnName = cf?.functionName || '(anonymous)';
      const url = cf?.url ? cf.url.split('/').slice(-2).join('/') : '';
      const line = cf?.lineNumber != null ? cf.lineNumber + 1 : '';
      return { us, label: `${fnName || '(anonymous)'} (${url}${line ? ':' + line : ''})` };
    })
    .filter((r) => r.us > 0)
    .sort((a, b) => b.us - a.us)
    .slice(0, TOP);

  for (const r of rows) {
    const pct = totalUs > 0 ? ((r.us / totalUs) * 100).toFixed(0) : '0';
    console.log(`  ${(r.us / 1000).toFixed(1).padStart(7)}  ${pct.padStart(5)}%  ${r.label}`);
  }
}
console.log();
