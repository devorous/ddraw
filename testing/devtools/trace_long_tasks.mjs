/**
 * What is inside the frames that block?
 *
 * Total CPU time answers "how much work"; this answers "how badly is it
 * clumped" — which is the one that decides whether drawing feels smooth. A
 * client can be 80% busy and feel fine if the work is spread evenly, and feel
 * terrible at the same 80% if it arrives as 300ms blocks.
 *
 * Lists the longest main-thread tasks and, for each, the JS functions that
 * actually ran inside it (from the CPU profile samples that fall in its time
 * range). That names the work to defer.
 *
 * Usage:
 *   node testing/devtools/trace_long_tasks.mjs <trace.json> [--top=15] [--min=16]
 */
import fs from 'fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const TOP = Number(args.find((a) => a.startsWith('--top='))?.slice(6)) || 15;
const MIN_MS = Number(args.find((a) => a.startsWith('--min='))?.slice(6)) || 16;
// Which trace event counts as "one blocking unit". `RunTask` is the scheduler's
// top-level unit and the right default, but a lean capture may only carry
// `ThreadControllerImpl::RunTask`, and sometimes you want to open up one
// specific kind of block (e.g. `FireIdleCallback`).
const TASK = args.find((a) => a.startsWith('--task='))?.slice(7) || 'RunTask';

if (!file) {
  console.error('usage: trace_long_tasks.mjs <trace.json> [--top=N] [--min=MS]');
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
const isRendererMain = (e) => processNames[e.pid] === 'Renderer'
  && threadNames[`${e.pid}:${e.tid}`] === 'CrRendererMain';

// Complete events ('X') carry their own duration; RunTask is the top-level unit
// the scheduler ran, so its duration is what blocked the frame.
const tasks = events
  .filter((e) => e.ph === 'X' && e.name === TASK && isRendererMain(e) && (e.dur || 0) / 1000 >= MIN_MS)
  .map((e) => ({ ts: e.ts, dur: e.dur / 1000 }))
  .sort((a, b) => b.dur - a.dur);

if (tasks.length === 0) {
  console.log(`\nNo main-thread RunTask over ${MIN_MS}ms found.`);
  process.exit(0);
}

// Rebuild the CPU profile so each sample can be placed on the same clock.
const profiles = new Map();
for (const e of events) {
  if ((e.name === 'Profile' || e.name === 'ProfileChunk') && e.id) {
    if (!profiles.has(e.id)) profiles.set(e.id, { pid: e.pid, tid: e.tid, nodes: new Map(), samples: [], timeDeltas: [], startTime: 0 });
    const p = profiles.get(e.id);
    if (e.name === 'Profile') p.startTime = e.args?.data?.startTime ?? e.ts;
    const cp = e.args?.data?.cpuProfile;
    if (cp?.nodes) for (const n of cp.nodes) p.nodes.set(n.id, n);
    if (cp?.samples) p.samples.push(...cp.samples);
    if (e.args?.data?.timeDeltas) p.timeDeltas.push(...e.args.data.timeDeltas);
  }
}
const prof = [...profiles.values()].find((p) => isRendererMain(p) && p.samples.length > 0);

let stamped = [];
if (prof) {
  const parent = new Map();
  for (const n of prof.nodes.values()) {
    if (n.parent != null) parent.set(n.id, n.parent);
    for (const c of n.children || []) parent.set(c, n.id);
  }
  let t = prof.startTime || 0;
  for (let i = 0; i < prof.samples.length; i++) {
    t += prof.timeDeltas[i] ?? 0;
    stamped.push({ ts: t, node: prof.samples[i], dur: prof.timeDeltas[i + 1] ?? 0 });
  }
  stamped.sort((a, b) => a.ts - b.ts);
  // Walk to the nearest named scripted frame so leaves like drawImage are
  // reported against the code that issued them.
  prof.namedOf = (nodeId) => {
    let cur = nodeId;
    while (cur != null) {
      const cf = prof.nodes.get(cur)?.callFrame;
      if (cf?.url && cf.functionName) {
        return `${cf.functionName} (${cf.url.split('/').slice(-2).join('/')}:${(cf.lineNumber ?? 0) + 1})`;
      }
      cur = parent.get(cur);
    }
    const cf = prof.nodes.get(nodeId)?.callFrame;
    return cf?.functionName ? `${cf.functionName} (native)` : '(native)';
  };
}

const total = tasks.reduce((a, t) => a + t.dur, 0);
console.log(`\n=== ${file}`);
console.log(`${tasks.length} main-thread ${TASK} over ${MIN_MS}ms, ${total.toFixed(0)}ms of blocking in total`);

const buckets = [[16, 33], [33, 50], [50, 100], [100, 200], [200, Infinity]];
console.log('\nBlocking-time distribution');
for (const [lo, hi] of buckets) {
  const g = tasks.filter((t) => t.dur >= lo && t.dur < hi);
  if (!g.length) continue;
  const ms = g.reduce((a, t) => a + t.dur, 0);
  console.log(`  ${String(lo).padStart(3)}-${hi === Infinity ? 'inf' : String(hi).padEnd(3)} ms: `
    + `${String(g.length).padStart(4)} tasks, ${String(Math.round(ms)).padStart(6)} ms `
    + `(${((ms / total) * 100).toFixed(1)}% of blocking)`);
}

console.log(`\nLongest ${Math.min(TOP, tasks.length)} tasks and what ran inside them:`);
for (const task of tasks.slice(0, TOP)) {
  console.log(`\n  ${task.dur.toFixed(1)} ms task`);
  if (!prof) { console.log('    (no CPU profile in this trace)'); continue; }
  const lo = task.ts, hi = task.ts + task.dur * 1000;
  const inside = stamped.filter((s) => s.ts >= lo && s.ts <= hi);
  const by = new Map();
  for (const s of inside) by.set(prof.namedOf(s.node), (by.get(prof.namedOf(s.node)) || 0) + s.dur);
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const sum = rows.reduce((a, r) => a + r[1], 0) || 1;
  for (const [name, us] of rows) {
    console.log(`    ${(us / 1000).toFixed(1).padStart(7)} ms  ${((us / sum) * 100).toFixed(0).padStart(3)}%  ${name}`);
  }
}
console.log();
