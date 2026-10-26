// Bench for PressureMask accumulation modes (replace / max / stack, plus 'default' = no flag, must act like max): correctness + perf.
// Usage: PUPPETEER_EXECUTABLE_PATH=<chrome> node testing/devtools/pressure_mask_bench.mjs
// Serves the repo on a random local port and drives pressure_mask_bench.html headless. Exits 1 on any FAIL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
if (!executablePath) {
  console.error('Set PUPPETEER_EXECUTABLE_PATH to a Chrome binary.');
  process.exit(2);
}
const browser = await puppeteer.launch({ executablePath, headless: true });
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.error('pageerror:', e.message); failed = true; });
  await page.goto(`http://127.0.0.1:${port}/testing/devtools/pressure_mask_bench.html`);
  await page.waitForFunction('window.benchReady === true', { timeout: 15000 });
  const perf = [];
  for (const mode of ['replace', 'max', 'stack', 'default', 'nofilter']) {
    const out = await page.evaluate((m) => window.runBench(m), mode);
    for (const c of out.checks) {
      console.log(`${c.ok ? 'PASS' : 'FAIL'} [${mode}] ${c.name}: ${c.detail}`);
      if (!c.ok) failed = true;
    }
    perf.push(out);
  }
  const crossOf = (m) => perf.find((o) => o.mode === m).cross;
  const same = crossOf('max') === crossOf('nofilter');
  console.log(`${same ? 'PASS' : 'FAIL'} [nofilter] crossing alpha identical to filter path: ${crossOf('nofilter')} vs ${crossOf('max')}`);
  if (!same) failed = true;
  console.log('\nmode    stampTo submit ms  spiral total ms (flushed)   composite median ms   window');
  for (const o of perf) {
    const p = o.perf;
    console.log(`${o.mode.padEnd(8)} ${p.stampMedian.toFixed(3).padStart(17)} ${p.total.toFixed(0).padStart(17)} ${p.compMedian.toFixed(2).padStart(21)}   ${p.win}`);
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
