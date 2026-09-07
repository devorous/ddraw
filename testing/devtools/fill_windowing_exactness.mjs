#!/usr/bin/env node
/**
 * @fileoverview Proves the windowed flood-fill active-stroke canvas paints
 * byte-identical pixels to the old full-board path.
 *
 * `FloodFillTool._commitFillResult` now sizes the active-stroke canvas to the
 * fill's own bounds and subtracts a board-space `origin` at every paint site.
 * `putImageData` ignores the ctx transform, so this could not use the
 * `ctx.translate` convention the rest of the windowing campaign uses — which
 * makes "the offsets are obviously right" not good enough. A canvas census
 * would not catch it either: a windowed-but-empty canvas measures exactly as
 * successful as a windowed-and-correct one.
 *
 * Oracle: `_fillStrokeBounds` returning null is passed through as "full board",
 * which reproduces the exact pre-change behaviour. So each case runs the same
 * fill twice — once windowed, once forced full-board — and diffs layer 0.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/fill_windowing_exactness.mjs
 */

import puppeteer from 'puppeteer';
import { runFillWindowingCases } from './_fill_windowing_cases.mjs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const page = (await browser.pages())[0] || (await browser.newPage());
  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 120_000 });
    const room = `fw_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'FW'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: 120_000 });
    await sleep(2500);

    const report = await page.evaluate(runFillWindowingCases);
    printReport(report);
  } finally {
    await browser.disconnect();
  }
})();

export function printReport(report) {
  console.log(`\n=== flood fill windowing exactness  ${report.board.w}x${report.board.h}`);
  const fullPx = report.board.w * report.board.h;
  let failed = 0;
  for (const c of report.cases) {
    const shrink = c.canvasPx ? (100 * (1 - c.canvasPx / fullPx)).toFixed(1) : '0.0';
    console.log(`\n  ${c.name}`);
    console.log(`    window        ${c.canvasW}x${c.canvasH} @ (${c.originX},${c.originY})   ${shrink}% smaller than full board`);
    console.log(`    filled px     ${c.filledPx}   seed=${c.seedIsFill ? 'fill' : 'NOT FILL'}  outside=${c.outsideIsClean ? 'clean' : 'BLED'}`);
    console.log(`    vs full-board differing bytes: ${c.diff} of ${c.bytes}   worst delta: ${c.worst}`);
    const problems = [];
    if (!c.windowed) problems.push('canvas was NOT windowed (test vacuous)');
    if (c.filledPx === 0) problems.push('fill deposited nothing (test vacuous)');
    if (!c.seedIsFill) problems.push('seed pixel is not the fill colour');
    if (!c.outsideIsClean) problems.push('paint landed outside the filled region');
    if (c.diff !== 0) problems.push('windowed and full-board output disagree');
    if (problems.length) { failed++; problems.forEach((p) => console.log(`    FAIL - ${p}`)); }
    else console.log('    PASS');
  }
  console.log(failed === 0
    ? `\n  ALL ${report.cases.length} CASES PASS\n`
    : `\n  ${failed} of ${report.cases.length} CASES FAILED\n`);
  if (failed) process.exitCode = 1;
}
