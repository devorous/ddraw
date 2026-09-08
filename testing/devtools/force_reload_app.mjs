/**
 * Force the tunnelled Chromebook's app tab onto the CURRENT source.
 *
 * Relaunching Chrome is not enough and neither is `page.reload()`: the app
 * registers a service worker that serves a cached shell, so a page can come up
 * looking healthy while running code from a previous session. Every perf
 * harness here guards against that by probing for a symbol the new code
 * introduces — this is the recovery when that guard trips.
 *
 * Unregisters every service worker, drops the Cache Storage entries, then
 * reloads with the cache bypassed and waits for the app to finish its (slow,
 * on this device) auth fallback.
 *
 * Usage: CDP_URL=http://127.0.0.1:9222 node testing/devtools/force_reload_app.mjs
 */
import puppeteer from 'puppeteer';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.APP_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 180000);

const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 300000 });
const origin = new URL(TARGET_URL).origin;
const open = (await browser.pages()).filter((p) => p.url().startsWith(origin));
for (let i = 1; i < open.length; i++) await open[i].close();
const page = open[0] || await browser.newPage();
await page.bringToFront();
if (!page.url().startsWith(origin)) {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
}

const cleared = await page.evaluate(async () => {
  const out = { workers: 0, caches: 0 };
  if (navigator.serviceWorker) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) { await r.unregister(); out.workers++; }
  }
  if (window.caches) {
    const keys = await caches.keys();
    for (const k of keys) { await caches.delete(k); out.caches++; }
  }
  return out;
}).catch((e) => ({ error: String(e) }));
console.log('cleared', JSON.stringify(cleared));

const cdp = await page.target().createCDPSession();
await cdp.send('Network.enable');
await cdp.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => {});
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
console.log('reloaded, waiting for app...');
await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
  { timeout: READY_TIMEOUT, polling: 1000 });

// Report the live values a harness would otherwise have to discover the hard way.
const state = await page.evaluate(() => ({
  hasHighlightFix: window.app?.remoteUserHandler?.ui?.remoteUserUI?._activeHighlightUntil !== undefined,
  hasMmKnob: window.app?.wsClient?._debugMmKeepEveryN !== undefined,
  lowPowerMode: window.app?.inputBufferManager?.lowPowerMode ?? null,
  tickRate: window.app?.inputBufferManager?.tickRate ?? null,
  tiledBackingStore: window.app?.board?.layerManager?.tiledBackingStore ?? null,
}));
console.log(JSON.stringify(state, null, 2));
await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
await browser.disconnect();
