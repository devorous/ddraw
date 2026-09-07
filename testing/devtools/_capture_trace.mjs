import puppeteer from 'puppeteer-core';

const CDP = 'http://127.0.0.1:9222';
const OUT = process.argv[2] || 'C:/Users/Kyle/Documents/git/top-draw/testing/devtools/_eraser_trace.json';
const DURATION_MS = Number(process.argv[3] || 80000);

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
const page = pages.find((p) => p.url().includes('localhost:3000')) || pages[pages.length - 1];

const stacksBefore = await page.evaluate(() => window.app.board.layerManager.layerGroups.map((g) => g.strokeStack.length));
console.log('stacks before trace:', stacksBefore);

await page.tracing.start({
  path: OUT,
  categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', 'gpu', 'toplevel',
    'viz', 'benchmark', 'v8'],
});
console.log(`tracing started, capturing ${DURATION_MS}ms`);

await new Promise((r) => setTimeout(r, DURATION_MS));

await page.tracing.stop();
const stacksAfter = await page.evaluate(() => window.app.board.layerManager.layerGroups.map((g) => g.strokeStack.length));
console.log('stacks after trace:', stacksAfter);
console.log('trace saved to', OUT);
await browser.disconnect();
