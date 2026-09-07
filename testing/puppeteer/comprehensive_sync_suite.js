#!/usr/bin/env node

/**
 * @fileoverview Comprehensive Multi-User Sync Test Suite for Top Draw.
 *
 * Spawns N puppeteer bots in the same room, has one bot ("drawer") perform a
 * deterministic sequence of tool operations, waits for propagation, then
 * compares every bot's LayerManager *model state* (flatCanvas + strokeStack
 * composited in timestamp order) against the drawer's via a tolerance-based
 * pixel match over the union dirty bbox. Mirrors the breadth of
 * `visual_regression_suite.js` (every tool × multiple settings + special
 * cases) but the oracle is bot-to-bot convergence instead of a pinned baseline.
 *
 * Also runs concurrent-draw cases where every bot draws simultaneously, plus a
 * stroke-flood section that pushes past MAX_STROKES_PER_USER to exercise the
 * bake-to-flatCanvas path.
 *
 * Usage:
 *   node testing/puppeteer/comprehensive_sync_suite.js
 *
 * Env vars:
 *   TARGET_URL       Frontend URL              (default: http://localhost:3000/go/)
 *   NUM_USERS        Number of bots            (default: 3)
 *   HEADLESS         "false" to show browser   (default: true)
 *   PROPAGATION_MS   Wait after each test      (default: 3500)
 *   TOOLS            Comma-sep tool filter     (default: all)
 *   ONLY             Comma-sep test-name filter
 *   SKIP_CONCURRENT  "true" to skip concurrent tests
 *   SKIP_SPECIAL     "true" to skip special cases
 *   SKIP_FLOOD       "true" to skip stroke flood tests
 *   DRAWER           Index of the drawing bot  (default: 0)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PIXEL_TOLERANCE,
  NEIGHBOR_RADIUS,
  PASS_PCT,
  captureLayerSnapshotsInPage,
  diffSnapshots,
} from '../lib/layerDiff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const TARGET_URL      = process.env.TARGET_URL     || 'http://localhost:3000/go/';
const NUM_USERS       = parseInt(process.env.NUM_USERS || '3');
const HEADLESS        = process.env.HEADLESS !== 'false';
const PROPAGATION_MS  = parseInt(process.env.PROPAGATION_MS || '3500');
const DRAWER_INDEX    = parseInt(process.env.DRAWER || '0');
const SKIP_CONCURRENT = process.env.SKIP_CONCURRENT === 'true';
const SKIP_SPECIAL    = process.env.SKIP_SPECIAL === 'true';
const SKIP_FLOOD      = process.env.SKIP_FLOOD === 'true';
const TOOL_FILTER     = process.env.TOOLS ? process.env.TOOLS.split(',').map(s => s.trim()) : null;
const NAME_FILTER     = process.env.ONLY  ? process.env.ONLY.split(',').map(s => s.trim())  : null;

const RUN_ID       = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR  = path.join(__dirname, '..', 'sync_results', RUN_ID);
const REPORT_FILE  = path.join(RESULTS_DIR, 'SYNC_REPORT.md');
const SUMMARY_FILE = path.join(RESULTS_DIR, 'summary.json');

// ─── Deterministic Stroke Patterns ────────────────────────────────────────

let _seed = 12345;
function nodeRandom() {
  _seed = (_seed * 9301 + 49297) % 233280;
  return _seed / 233280;
}
function resetNodeRandom(s = 12345) { _seed = s; }

const STROKE_PATTERNS = [];
(function generatePatterns() {
  resetNodeRandom();
  for (let i = 0; i < 60; i++) {
    const path = [];
    const steps = 8 + Math.floor(nodeRandom() * 8);
    const startX = 200 + nodeRandom() * 1500;
    const startY = 100 + nodeRandom() * 800;
    path.push({ x: startX, y: startY });
    for (let s = 1; s < steps; s++) {
      path.push({
        x: startX + (nodeRandom() - 0.5) * 400,
        y: startY + (nodeRandom() - 0.5) * 400,
      });
    }
    STROKE_PATTERNS.push(path);
  }
})();

// Per-bot offset zones for concurrent draws so strokes don't fully overlap.
// (Some overlap is fine and desirable for stress; full overlap masks ordering bugs.)
const BOT_ZONES = [
  { dx:    0, dy:   0, color: [220,  60,  60, 1] }, // red
  { dx:  600, dy:   0, color: [ 50,  80, 220, 1] }, // blue
  { dx:    0, dy: 400, color: [ 40, 180,  60, 1] }, // green
  { dx:  600, dy: 400, color: [200, 140,  20, 1] }, // amber
];

// ─── Test Matrix — Tool × Settings (mirrors visual_regression_suite.js) ────

const TOOLS_TO_TEST = [
  // NOTE: hardness and smoothing are integer 0-100 (matching the UI slider).
  // The broadcast wire format also rounds to an integer, so use whole numbers
  // or you'll see drawer/observer drift from rounding.
  { name: 'ink', category: 'brush', settings: [
    { size: 10, color: [255, 0, 0, 1],     smoothing: 10 },
    { size: 20, color: [0, 255, 0, 0.8],   smoothing: 40 },
    { size: 30, color: [0, 0, 255, 0.6],   smoothing: 70 },
    { size: 50, color: [255, 255, 0, 0.4], smoothing: 20 },
    { size: 15, color: [0, 0, 0, 1],       smoothing: 90 },
  ]},
  { name: 'brush', category: 'brush', settings: [
    { size: 15, color: [255, 0, 0, 1],     hardness: 100 },
    { size: 30, color: [0, 255, 0, 0.7],   hardness: 50 },
    { size: 60, color: [0, 0, 255, 0.4],   hardness: 10 },
    { size: 10, color: [0, 0, 0, 1],       hardness: 90 },
    { size: 20, color: [255, 0, 255, 0.6], hardness: 30 },
  ]},
  { name: 'pixel', category: 'brush', settings: [
    { size: 1, color: [0, 0, 0, 1] },
    { size: 1, color: [255, 0, 0, 1] },
    { size: 1, color: [0, 255, 0, 1] },
    { size: 1, color: [0, 0, 255, 1] },
    { size: 1, color: [100, 100, 100, 1] },
  ]},
  { name: 'flowPen', category: 'brush', settings: [
    { size: 10, color: [255, 0, 0, 1] },
    { size: 20, color: [0, 255, 0, 0.8] },
    { size: 40, color: [0, 0, 255, 0.6] },
    { size: 15, color: [200, 200, 0, 0.4] },
    { size: 25, color: [0, 0, 0, 1] },
  ]},
  { name: 'rectangle', category: 'shape', settings: [
    { size: 4,  color: [255, 0, 0, 1] },
    { size: 8,  color: [0, 255, 0, 0.7] },
    { size: 12, color: [0, 0, 255, 0.5] },
    { size: 2,  color: [0, 0, 0, 1] },
    { size: 20, color: [255, 255, 0, 0.3] },
  ]},
  { name: 'circle', category: 'shape', settings: [
    { size: 4,  color: [255, 0, 0, 1] },
    { size: 8,  color: [0, 255, 0, 0.7] },
    { size: 12, color: [0, 0, 255, 0.5] },
    { size: 2,  color: [0, 0, 0, 1] },
    { size: 20, color: [255, 255, 0, 0.3] },
  ]},
  { name: 'line', category: 'shape', settings: [
    { size: 2,  color: [0, 0, 0, 1] },
    { size: 6,  color: [255, 0, 0, 0.8] },
    { size: 10, color: [0, 255, 0, 0.6] },
    { size: 4,  color: [0, 0, 255, 1] },
    { size: 20, color: [200, 0, 200, 0.4] },
  ]},
  { name: 'confetti', category: 'brush', settings: [
    { size: 30, color: [220, 60, 60, 1], confettiParticles: 4,  confettiParticleSize: 10, confettiSizeVariation: 40,  confettiOpacityRandomness: 20, confettiSpacing: 30, confettiShape: 'circle', confettiColorMode: 'active', confettiRotationMode: 'random' },
    { size: 40, color: [60, 180, 80, 1], confettiParticles: 12, confettiParticleSize: 6,  confettiSizeVariation: 20,  confettiOpacityRandomness: 10, confettiSpacing: 10, confettiShape: 'circle', confettiColorMode: 'active', confettiRotationMode: 'random' },
    { size: 25, color: [40, 100, 220, 1], confettiParticles: 6, confettiParticleSize: 14, confettiSizeVariation: 0,   confettiOpacityRandomness: 0,  confettiSpacing: 25, confettiShape: 'square', confettiColorMode: 'active', confettiRotationMode: 'fixed' },
    { size: 35, color: [255, 200, 0, 1], confettiParticles: 5,  confettiParticleSize: 12, confettiSizeVariation: 30,  confettiOpacityRandomness: 30, confettiSpacing: 45, confettiShape: 'square', confettiColorMode: 'random', confettiRotationMode: 'follow' },
    { size: 45, color: [180, 0, 200, 1], confettiParticles: 8,  confettiParticleSize: 16, confettiSizeVariation: 100, confettiOpacityRandomness: 100, confettiSpacing: 20, confettiShape: 'circle', confettiColorMode: 'active', confettiRotationMode: 'random' },
  ]},
];

// ─── Special Cases (single-drawer multi-step scenarios) ────────────────────

const SPECIAL_CASES = [
  {
    name: 'fill_variations',
    action: async (page) => {
      await selectTool(page, 'circle');
      await setToolSettings(page, { size: 2, color: [0, 0, 0, 1] });
      const centers = [];
      for (let i = 0; i < 5; i++) {
        const cx = 200 + (i * 300) + 50;
        const cy = 300 + ((i % 2) * 200);
        centers.push({ x: cx, y: cy });
        await drawPath(page, [{ x: cx - 100, y: cy - 100 }, { x: cx + 100, y: cy + 100 }]);
      }
      await selectTool(page, 'fill');
      const fillSettings = [
        { color: [255, 0, 0, 1],   expansion: 0,  blurRadius: 0 },
        { color: [0, 255, 0, 1],   expansion: 10, blurRadius: 0 },
        { color: [0, 0, 255, 1],   expansion: 0,  blurRadius: 5 },
        { color: [255, 255, 0, 1], expansion: 5,  blurRadius: 2 },
        { color: [255, 0, 255, 0.5], expansion: 2, blurRadius: 1 },
      ];
      for (let i = 0; i < 5; i++) {
        await setToolSettings(page, fillSettings[i]);
        await clickPoint(page, centers[i].x, centers[i].y);
      }
    },
  },
  {
    name: 'blur_tools_test',
    action: async (page) => {
      // Lay down background bars.
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 10, color: [0, 0, 0, 1], hardness: 100 });
      for (let i = 0; i < 8; i++) {
        const x = 200 + i * 200;
        await drawPath(page, [{ x, y: 100 }, { x, y: 900 }]);
      }
      // Blur strip
      await selectTool(page, 'blur');
      await setToolSettings(page, { size: 100 });
      await drawPath(page, [{ x: 200, y: 300 }, { x: 600, y: 300 }]);
      // Circle blur dot
      await selectTool(page, 'circleBlur');
      await setToolSettings(page, { size: 150 });
      await clickPoint(page, 960, 540);
      // Glitch blur stripe
      await selectTool(page, 'glitchBlur');
      await setToolSettings(page, { size: 120 });
      await drawPath(page, [{ x: 1300, y: 200 }, { x: 1300, y: 800 }]);
    },
  },
  {
    name: 'eraser_over_strokes',
    action: async (page) => {
      // Lay base of overlapping colored brush strokes
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 40, color: [220, 60, 60, 1], hardness: 100 });
      await drawPath(page, [{ x: 200, y: 300 }, { x: 800, y: 300 }]);
      await setToolSettings(page, { size: 40, color: [60, 180, 60, 1] });
      await drawPath(page, [{ x: 200, y: 400 }, { x: 800, y: 400 }]);
      await setToolSettings(page, { size: 40, color: [60, 80, 220, 1] });
      await drawPath(page, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
      // Now run an eraser through them
      await selectTool(page, 'erase');
      await setToolSettings(page, { size: 60 });
      await drawPath(page, [{ x: 250, y: 250 }, { x: 750, y: 550 }]);
      // Partial overlap eraser pass
      await drawPath(page, [{ x: 750, y: 250 }, { x: 250, y: 550 }]);
    },
  },
  {
    name: 'blend_modes_layered',
    action: async (page) => {
      // multiply, screen, source-over stacked
      const modes = [
        { blendMode: 'source-over', color: [255, 0, 0, 0.8] },
        { blendMode: 'multiply',    color: [0, 255, 0, 0.8] },
        { blendMode: 'screen',      color: [0, 0, 255, 0.8] },
        { blendMode: 'overlay',     color: [255, 255, 0, 0.6] },
      ];
      await selectTool(page, 'brush');
      for (let i = 0; i < modes.length; i++) {
        await setToolSettings(page, { size: 80, hardness: 100, ...modes[i] });
        const yOffset = 200 + i * 30;
        await drawPath(page, [
          { x: 300, y: yOffset },
          { x: 700, y: yOffset + 200 },
          { x: 1100, y: yOffset },
          { x: 1500, y: yOffset + 200 },
        ]);
      }
    },
  },
  {
    name: 'image_brush_set',
    action: async (page) => {
      await page.evaluate(async () => {
        const app = window.app;
        const loader = app.brushGallery;
        const gallery = loader.realGallery || loader.loadRealGallery();
        const pepper = gallery.brushes.find(b => b.fileName === 'pepper.gbr') || gallery.brushes[0];
        if (pepper) app.handleBrushSelect(pepper);
      });
      await selectTool(page, 'imageBrush');
      const placements = [
        { size:  80, color: [255, 255, 255, 1], x:  300, y: 250 },
        { size: 100, color: [255, 100, 100, 1], x:  700, y: 350 },
        { size: 140, color: [100, 255, 100, 1], x: 1100, y: 250 },
        { size: 120, color: [100, 100, 255, 1], x: 1500, y: 450 },
        { size:  60, color: [255, 255,   0, 1], x:  500, y: 700 },
      ];
      for (const p of placements) {
        await setToolSettings(page, { size: p.size, color: p.color });
        await clickPoint(page, p.x, p.y);
      }
    },
  },
  {
    name: 'gimp_brush_strokes',
    action: async (page) => {
      await page.evaluate(async () => {
        const app = window.app;
        const loader = app.brushGallery;
        const gallery = loader.realGallery || loader.loadRealGallery();
        const brush = gallery.brushes.find(b => b.fileName === 'pepper.gbr') || gallery.brushes[0];
        if (brush) app.handleBrushSelect(brush);
      });
      await selectTool(page, 'gimp');
      await setToolSettings(page, { size: 60, color: [200, 100, 50, 1] });
      await drawPath(page, [
        { x: 300, y: 300 }, { x: 600, y: 350 }, { x: 900, y: 280 },
        { x: 1200, y: 380 }, { x: 1500, y: 320 },
      ]);
      await setToolSettings(page, { size: 90, color: [50, 200, 150, 1] });
      await drawPath(page, [
        { x: 300, y: 600 }, { x: 800, y: 550 }, { x: 1300, y: 650 },
      ]);
    },
  },
  {
    name: 'text_tool_set',
    action: async (page) => {
      await selectTool(page, 'text');
      const entries = [
        { size: 40,  color: [0,   0,   0,   1], text: 'Hello' },
        { size: 60,  color: [200, 0,   0,   1], text: 'World' },
        { size: 80,  color: [0,   100, 200, 1], text: 'Sync' },
        { size: 50,  color: [50,  150, 50,  1], text: 'Test' },
        { size: 100, color: [180, 0,   180, 1], text: 'OK' },
      ];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        await setToolSettings(page, { size: e.size, color: e.color });
        const x = 300 + i * 280;
        const y = 300 + (i % 2) * 300;
        await clickPoint(page, x, y);
        await page.keyboard.type(e.text);
        await page.keyboard.press('Enter');
        await sleep(300);
      }
    },
  },
  {
    name: 'confetti_image_brush',
    action: async (page) => {
      await page.evaluate(async () => {
        const app = window.app;
        const loader = app.brushGallery;
        const gallery = loader.realGallery || loader.loadRealGallery();
        const brush = gallery.brushes.find(b => b.fileName === 'pepper.gbr') || gallery.brushes[0];
        if (brush) app.handleBrushSelect(brush);
      });
      await selectTool(page, 'confetti');
      await setToolSettings(page, {
        size: 40, color: [255, 100, 200, 1],
        confettiParticles: 5, confettiParticleSize: 22,
        confettiSizeVariation: 40, confettiOpacityRandomness: 15,
        confettiSpacing: 25, confettiShape: 'image',
        confettiColorMode: 'image', confettiRotationMode: 'random',
      });
      for (let i = 0; i < 3; i++) {
        const cy = 250 + i * 250;
        await drawPath(page, [
          { x:  250, y: cy },
          { x:  600, y: cy + 60 },
          { x:  950, y: cy - 40 },
          { x: 1300, y: cy + 80 },
          { x: 1650, y: cy },
        ]);
      }
    },
  },
  {
    name: 'confetti_options_mix',
    action: async (page) => {
      await selectTool(page, 'confetti');
      // Stroke A — circles, active color, random rotation
      await setToolSettings(page, {
        size: 30, color: [220, 50, 50, 1],
        confettiParticles: 6, confettiParticleSize: 12,
        confettiSizeVariation: 30, confettiOpacityRandomness: 10,
        confettiSpacing: 18, confettiShape: 'circle',
        confettiColorMode: 'active', confettiRotationMode: 'random',
      });
      await drawPath(page, [
        { x: 200, y: 250 }, { x: 500, y: 280 }, { x: 800, y: 220 },
        { x: 1100, y: 280 }, { x: 1400, y: 240 }, { x: 1700, y: 270 },
      ]);
      // Stroke B — squares, fixed rotation, no variation
      await setToolSettings(page, {
        size: 28, color: [50, 130, 220, 1],
        confettiParticles: 4, confettiParticleSize: 16,
        confettiSizeVariation: 0, confettiOpacityRandomness: 0,
        confettiSpacing: 30, confettiShape: 'square',
        confettiColorMode: 'active', confettiRotationMode: 'fixed',
      });
      await drawPath(page, [
        { x: 200, y: 520 }, { x: 500, y: 500 }, { x: 800, y: 540 },
        { x: 1100, y: 500 }, { x: 1400, y: 540 }, { x: 1700, y: 510 },
      ]);
      // Stroke C — random color, follow rotation, large spacing
      await setToolSettings(page, {
        size: 36, color: [0, 0, 0, 1],
        confettiParticles: 5, confettiParticleSize: 14,
        confettiSizeVariation: 50, confettiOpacityRandomness: 40,
        confettiSpacing: 42, confettiShape: 'square',
        confettiColorMode: 'random', confettiRotationMode: 'follow',
      });
      await drawPath(page, [
        { x: 200, y: 800 }, { x: 500, y: 760 }, { x: 800, y: 820 },
        { x: 1100, y: 770 }, { x: 1400, y: 810 }, { x: 1700, y: 780 },
      ]);
    },
  },
  {
    name: 'select_complex_transform',
    action: async (page) => {
      await selectTool(page, 'rectangle');
      await setToolSettings(page, { size: 8, color: [255, 0, 0, 1] });
      await drawPath(page, [{ x: 800, y: 400 }, { x: 1100, y: 700 }]);
      await selectTool(page, 'select');
      await drawPath(page, [{ x: 780, y: 380 }, { x: 1120, y: 720 }]);
      await drag(page, 950, 550, 1300, 550);
      await drag(page, 1300, 370, 1500, 370);
    },
  },
  {
    name: 'undo_after_strokes',
    action: async (page) => {
      // Draw 5 strokes, undo 2, expecting all bots to converge on 3-stroke state
      await selectTool(page, 'brush');
      const variations = [
        { color: [255,   0,   0, 1], size: 30 },
        { color: [  0, 255,   0, 1], size: 25 },
        { color: [  0,   0, 255, 1], size: 35 },
        { color: [255, 200,   0, 1], size: 20 },
        { color: [200,   0, 200, 1], size: 40 },
      ];
      for (let i = 0; i < variations.length; i++) {
        await setToolSettings(page, { ...variations[i], hardness: 100 });
        const y = 250 + i * 120;
        await drawPath(page, [{ x: 200, y }, { x: 600, y: y + 60 }, { x: 1000, y }]);
      }
      // Two undos
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => {
          window.app.handleUndo?.();
          window.app.inputBufferManager?.tick();
        });
        await sleep(250);
      }
    },
  },
  {
    name: 'mixed_tool_sequence',
    action: async (page) => {
      // Round-robin through tools to exercise the tool-switch broadcast path
      const sequence = [
        { tool: 'brush',     settings: { size: 30, color: [220, 60, 60, 1], hardness: 100 } },
        { tool: 'line',      settings: { size: 6,  color: [60, 60, 220, 1] } },
        { tool: 'circle',    settings: { size: 6,  color: [60, 180, 60, 1] } },
        { tool: 'rectangle', settings: { size: 4,  color: [200, 140, 30, 1] } },
        { tool: 'ink',       settings: { size: 20, color: [180, 0, 180, 1], smoothing: 50 } },
        { tool: 'flowPen',   settings: { size: 25, color: [0, 180, 180, 1] } },
      ];
      for (let i = 0; i < sequence.length; i++) {
        await selectTool(page, sequence[i].tool);
        await setToolSettings(page, sequence[i].settings);
        const p = STROKE_PATTERNS[(i + 3) % STROKE_PATTERNS.length];
        const isShape = ['line', 'circle', 'rectangle'].includes(sequence[i].tool);
        const pts = isShape ? [p[0], p[p.length - 1]] : p;
        await drawPath(page, pts);
      }
    },
  },
];

// ─── Concurrent Test Cases (every bot draws simultaneously) ────────────────

const CONCURRENT_CASES = [
  { name: 'brush_concurrent',     tool: 'brush',     settings: { size: 25, hardness: 100 } },
  { name: 'ink_concurrent',       tool: 'ink',       settings: { size: 20, smoothing: 50 } },
  { name: 'flowPen_concurrent',   tool: 'flowPen',   settings: { size: 30 } },
  { name: 'pixel_concurrent',     tool: 'pixel',     settings: { size: 1 } },
  { name: 'line_concurrent',      tool: 'line',      settings: { size: 6 }, isShape: true },
  { name: 'circle_concurrent',    tool: 'circle',    settings: { size: 6 }, isShape: true },
  { name: 'rectangle_concurrent', tool: 'rectangle', settings: { size: 8 }, isShape: true },
  { name: 'confetti_concurrent',  tool: 'confetti',  settings: {
      size: 30, confettiParticles: 5, confettiParticleSize: 12,
      confettiSizeVariation: 30, confettiOpacityRandomness: 20,
      confettiSpacing: 25, confettiShape: 'circle',
      confettiColorMode: 'active', confettiRotationMode: 'random',
  } },
  // Each bot uses a different tool simultaneously — the worst case for
  // tool-state broadcast: every bot's CT/CC/CS/CSP messages interleave.
  { name: 'mixed_tools_concurrent', perBotTool: ['brush', 'line', 'circle'], settings: { size: 20 } },
];

// ─── Stroke Flood Cases (force the bake path, >MAX_STROKES_PER_USER) ───────
// LayerManager bakes oldest strokes into flatCanvas once a user crosses
// MAX_STROKES_PER_USER (20). These tests push past that to make sure the
// baked state stays in sync across bots — a single-stroke regression test
// can't catch a baking divergence.

const STROKE_FLOOD_CASES = [
  {
    name: 'flood_drawer_25_brush',
    kind: 'singleDrawer',
    action: async (page) => {
      await selectTool(page, 'brush');
      for (let i = 0; i < 25; i++) {
        const hue = (i * 47) % 256;
        await setToolSettings(page, { size: 14, color: [hue, (i * 19) % 256, (i * 113) % 256, 1], hardness: 100 });
        const y = 80 + i * 36;
        await drawPath(page, [{ x: 200, y }, { x: 900, y: y + 6 }, { x: 1700, y }]);
      }
    },
  },
  {
    name: 'flood_drawer_30_mixed',
    kind: 'singleDrawer',
    action: async (page) => {
      const tools = ['brush', 'ink', 'flowPen', 'pixel'];
      for (let i = 0; i < 30; i++) {
        const tool = tools[i % tools.length];
        await selectTool(page, tool);
        const size = tool === 'pixel' ? 1 : 10 + ((i * 7) % 30);
        await setToolSettings(page, { size, color: [(i*13)%256, (i*97)%256, (i*53)%256, 1], hardness: 100, smoothing: 30 });
        const baseY = 60 + (i * 32);
        await drawPath(page, [
          { x: 200, y: baseY },
          { x: 800, y: baseY + ((i % 5) - 2) * 30 },
          { x: 1500, y: baseY },
        ]);
      }
    },
  },
  {
    name: 'flood_drawer_25_then_undo',
    kind: 'singleDrawer',
    action: async (page) => {
      await selectTool(page, 'brush');
      for (let i = 0; i < 25; i++) {
        await setToolSettings(page, { size: 14, color: [(i*61)%256, (i*131)%256, (i*7)%256, 1], hardness: 100 });
        const y = 80 + i * 36;
        await drawPath(page, [{ x: 200, y }, { x: 1500, y: y + 8 }]);
      }
      // Undo three strokes after baking has already happened
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
          window.app.handleUndo?.();
          window.app.inputBufferManager?.tick();
        });
        await sleep(250);
      }
    },
  },
  {
    name: 'flood_concurrent_25_each',
    kind: 'concurrent',
    perBotAction: async (page, botIdx) => {
      const zone = BOT_ZONES[botIdx % BOT_ZONES.length];
      await selectTool(page, 'brush');
      for (let i = 0; i < 25; i++) {
        await setToolSettings(page, {
          size: 12,
          color: [zone.color[0], (zone.color[1] + i * 5) % 256, (zone.color[2] + i * 11) % 256, 1],
          hardness: 100,
        });
        const baseY = 80 + zone.dy + i * 14;
        await drawPath(page, [
          { x: 200 + zone.dx, y: baseY },
          { x: 500 + zone.dx, y: baseY + 5 },
        ]);
      }
    },
  },
  {
    name: 'flood_concurrent_blend_modes',
    kind: 'concurrent',
    perBotAction: async (page, botIdx) => {
      const zone = BOT_ZONES[botIdx % BOT_ZONES.length];
      // group 0 (allowComplexBlendModes) is the active layer by default
      const modes = ['source-over', 'multiply', 'screen', 'overlay'];
      await selectTool(page, 'brush');
      for (let i = 0; i < 22; i++) {
        await setToolSettings(page, {
          size: 30,
          color: [(zone.color[0] + i * 7) % 256, (zone.color[1] + i * 11) % 256, (zone.color[2] + i * 13) % 256, 0.8],
          blendMode: modes[i % modes.length],
          hardness: 100,
        });
        const baseY = 100 + zone.dy + i * 30;
        await drawPath(page, [
          { x: 200 + zone.dx, y: baseY },
          { x: 500 + zone.dx, y: baseY + 20 },
        ]);
      }
    },
  },
];

// ─── Page Helpers (mirrors visual_regression_suite.js) ─────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function selectTool(page, tool) {
  await page.evaluate((t) => window.app.selectTool(t), tool);
}

async function setToolSettings(page, settings) {
  await page.evaluate((s) => {
    const app = window.app;
    if (s.size !== undefined)      app.handleSizeChange({ target: { value: s.size } });
    if (s.color !== undefined)     app.handleColorInputChange(s.color);
    if (s.blendMode !== undefined) app.handleBlendModeChange(s.blendMode);
    if (s.smoothing !== undefined) app.handleSmoothingChange({ target: { value: s.smoothing } });
    if (s.hardness !== undefined)  app.handleHardnessChange({ target: { value: s.hardness } });
    if (s.expansion !== undefined || s.blurRadius !== undefined) {
      const tool = app.toolManager.getTool('fill');
      if (tool) {
        if (s.expansion !== undefined)  tool._expansion  = s.expansion;
        if (s.blurRadius !== undefined) tool._blurRadius = s.blurRadius;
        tool._updateSliders?.();
      }
    }
    if (s.confettiParticles !== undefined)        app.self.confettiParticles        = s.confettiParticles;
    if (s.confettiParticleSize !== undefined)     app.self.confettiParticleSize     = s.confettiParticleSize;
    if (s.confettiSizeVariation !== undefined)    app.self.confettiSizeVariation    = s.confettiSizeVariation;
    if (s.confettiOpacityRandomness !== undefined) app.self.confettiOpacityRandomness = s.confettiOpacityRandomness;
    if (s.confettiSpacing !== undefined)          app.self.confettiSpacing          = s.confettiSpacing;
    if (s.confettiShape !== undefined)            app.self.confettiShape            = s.confettiShape;
    if (s.confettiColorMode !== undefined)        app.self.confettiColorMode        = s.confettiColorMode;
    if (s.confettiRotationMode !== undefined)     app.self.confettiRotationMode     = s.confettiRotationMode;
    if (s.confettiStrokeSeed !== undefined)       app.self._confettiStrokeSeed      = s.confettiStrokeSeed;
  }, settings);
}

async function getClientCoords(page, boardX, boardY) {
  return page.evaluate((bx, by) => {
    const board = window.app.board;
    const containerRect = board.container.getBoundingClientRect();
    const rad = board.rotation * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    let rx = bx * board.zoom;
    let ry = by * board.zoom;
    if (board.canvasFlipped) rx = (board.getWidth() - bx) * board.zoom;
    const rxr = rx * cos + ry * sin;
    const ryr = -rx * sin + ry * cos;
    return {
      clientX: rxr + board.panX + containerRect.left,
      clientY: ryr + board.panY + containerRect.top,
    };
  }, boardX, boardY);
}

async function drawPath(page, points) {
  const clientPoints = [];
  for (const p of points) clientPoints.push(await getClientCoords(page, p.x, p.y));
  await page.evaluate(async (pts) => {
    const app = window.app;
    const ev = (c) => ({ button: 0, pointerType: 'mouse', clientX: c.clientX, clientY: c.clientY, preventDefault: () => {} });
    app.handlePointerDown(ev(pts[0]));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const steps = 4;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const cur = {
          clientX: a.clientX + (b.clientX - a.clientX) * t,
          clientY: a.clientY + (b.clientY - a.clientY) * t,
        };
        app.handlePointerMove(ev(cur));
        app.inputBufferManager?.tick();
        await new Promise(r => setTimeout(r, 5));
      }
    }
    app.handlePointerUp(ev(pts[pts.length - 1]));
    app.inputBufferManager?.tick();
  }, clientPoints);
  await sleep(250);
  await flushBroadcasts(page);
}

/**
 * One more buffer flush after the tool has had time to finish.
 *
 * The real tick loop is stopped (see stopTickLoop) and every tick here is
 * manual, so a broadcast queued *after* the tick that follows pointerup is
 * simply never sent. Async tools do exactly that: the flood fill's FILL frame
 * lands ~300ms after the click, and in `fill_variations` the fifth and final
 * fill was therefore never broadcast at all — the drawer held 10 strokes to
 * every peer's 9. In production the 60 TPS loop flushes it a frame later and
 * nothing is lost.
 */
async function flushBroadcasts(page) {
  await page.evaluate(() => window.app.inputBufferManager?.tick());
}

async function clickPoint(page, x, y) {
  const c = await getClientCoords(page, x, y);
  await page.evaluate(async (c) => {
    const app = window.app;
    const ev = (c) => ({ button: 0, pointerType: 'mouse', clientX: c.clientX, clientY: c.clientY, preventDefault: () => {} });
    app.handlePointerDown(ev(c));
    app.inputBufferManager?.tick();
    app.handlePointerUp(ev(c));
    app.inputBufferManager?.tick();
  }, c);
  await sleep(250);
  await flushBroadcasts(page);
}

async function drag(page, sx, sy, ex, ey) {
  await drawPath(page, [{ x: sx, y: sy }, { x: ex, y: ey }]);
}

async function clearCanvas(page) {
  // App.handleClear() is moderator-gated; clear the board directly.
  await page.evaluate(() => {
    const app = window.app;
    app.board?.clear?.();
    app.board?.tileTracker?.clear?.();
    app.debugOverlay?.clearAll?.();
  });
}

async function reseedRandom(page, seedValue = 12345) {
  await page.evaluate((s) => {
    let seed = s;
    Math.random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  }, seedValue);
}

async function stopTickLoop(page) {
  await page.evaluate(() => window.app.inputBufferManager?.stopTickLoop?.());
}

// Pixel-tolerance comparison. The diff fixture (tolerance / neighbour slack /
// pass %) lives in ../lib/layerDiff.mjs so the chrome-devtools parity suite
// uses identical numbers. See that file for rationale.

async function captureLayerSnapshots(page) {
  return page.evaluate(captureLayerSnapshotsInPage);
}

/**
 * Render a side-by-side diff PNG showing exactly where two bots disagree.
 * Uses pageHost's browser context to do the painting; pass both snapshots in.
 * Output is a 3-panel image: bot_A | bot_B | DIFF (red where mismatched).
 */
async function generateDiffPng(pageHost, snapA, snapB) {
  const dataUrl = await pageHost.evaluate((sA, sB, tolerance) => {
    const W = sA[0]?.canvasW || sB[0]?.canvasW || 1920;
    const H = sA[0]?.canvasH || sB[0]?.canvasH || 1080;

    // Rebuild full-size RGBA from per-group bbox crops
    const buildFull = (snaps) => {
      const full = new Uint8ClampedArray(W * H * 4);
      for (const s of snaps) {
        if (!s.bbox || !s.bboxPixelsB64) continue;
        const bin = atob(s.bboxPixelsB64);
        const len = bin.length;
        const tmp = new Uint8Array(len);
        for (let i = 0; i < len; i++) tmp[i] = bin.charCodeAt(i);
        const { x: bx, y: by, w: bw, h: bh } = s.bbox;
        for (let y = 0; y < bh; y++) {
          for (let x = 0; x < bw; x++) {
            const si = (y * bw + x) * 4;
            if (tmp[si + 3] === 0) continue; // transparent — skip
            const di = ((by + y) * W + (bx + x)) * 4;
            // Composite "over"
            full[di]     = tmp[si];
            full[di + 1] = tmp[si + 1];
            full[di + 2] = tmp[si + 2];
            full[di + 3] = tmp[si + 3];
          }
        }
      }
      return full;
    };

    const fullA = buildFull(sA);
    const fullB = buildFull(sB);

    // Single full-size diff canvas (no side-by-side — easier to overlay/flip)
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d');
    const img = ctx.createImageData(W, H);
    const out = img.data;

    let mismatched = 0;
    for (let i = 0; i < W * H * 4; i += 4) {
      const dr = Math.abs(fullA[i]     - fullB[i]);
      const dg = Math.abs(fullA[i + 1] - fullB[i + 1]);
      const db = Math.abs(fullA[i + 2] - fullB[i + 2]);
      const da = Math.abs(fullA[i + 3] - fullB[i + 3]);
      const d = Math.max(dr, dg, db, da);
      const anyContent = fullA[i + 3] > 0 || fullB[i + 3] > 0;

      if (!anyContent) {
        out[i] = 245; out[i + 1] = 245; out[i + 2] = 245; out[i + 3] = 255;
      } else if (d <= tolerance) {
        // Faint gray showing painted area where bots agree
        out[i] = 200; out[i + 1] = 200; out[i + 2] = 200; out[i + 3] = 255;
      } else {
        mismatched++;
        // Color-code by which side has content:
        // - red:    A has it, B doesn't (or much more)
        // - blue:   B has it, A doesn't (or much more)
        // - orange: both have content but with different color
        const aOnly = fullA[i + 3] > 0 && fullB[i + 3] === 0;
        const bOnly = fullB[i + 3] > 0 && fullA[i + 3] === 0;
        if (aOnly)      { out[i] = 255; out[i + 1] = 0;   out[i + 2] = 0;   out[i + 3] = 255; }
        else if (bOnly) { out[i] = 0;   out[i + 1] = 80;  out[i + 2] = 255; out[i + 3] = 255; }
        else            { out[i] = 255; out[i + 1] = 140; out[i + 2] = 0;   out[i + 3] = 255; }
      }
    }
    ctx.putImageData(img, 0, 0);

    // Annotate
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, W, 28);
    ctx.fillStyle = 'white';
    ctx.font = '14px monospace';
    ctx.fillText(`mismatched px: ${mismatched}   red=drawer-only   blue=other-only   orange=color diff`, 8, 19);

    return cvs.toDataURL('image/png');
  }, snapA, snapB, PIXEL_TOLERANCE);

  if (!dataUrl) return null;
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
}

async function captureLayerCompositePng(page) {
  // PNG of the same composite we diff against — saved on failure for inspection.
  const dataUrl = await page.evaluate(() => {
    const lm = window.app.board?.layerManager;
    if (!lm) return null;
    const cvs = document.createElement('canvas');
    cvs.width = lm.width;
    cvs.height = lm.height;
    const ctx = cvs.getContext('2d');

    // Delegate to the product compositor rather than re-implementing it, for
    // the same reason layerDiff.mjs does: compositeLayerRange dispatches
    // between four group paths (flatCanvas / isolated / sequential / plain)
    // and a hand-rolled loop cannot track that.
    //
    // It was not merely inexact, it threw: `group.flatCanvas` is not always an
    // HTMLCanvasElement (a tiled backing store hands back a tile-backed object),
    // so `drawImage(group.flatCanvas, 0, 0)` died with "The provided value is
    // not of type '(CSSImageValue or HTMLCanvasElement or ...)'" and, because
    // this runs from saveBotArtifacts on the FAILURE path, it aborted the whole
    // suite mid-run instead of saving the artifact for the one failing case.
    //
    // needsComposite is restored because the call clears it as a side effect,
    // and suppressing a pending composite on a live board would be a real side
    // effect of measuring it.
    const prevNeedsComposite = lm.needsComposite;
    lm.compositeLayerRange(ctx, 0, lm.layerGroups.length, null, null);
    lm.needsComposite = prevNeedsComposite;
    ctx.globalCompositeOperation = 'source-over';

    return cvs.toDataURL('image/png');
  });
  if (!dataUrl) return null;
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
}

async function userStateDump(page) {
  return page.evaluate(() => {
    const app = window.app;
    const dump = (u) => ({
      n: u.username, t: u.tool, sz: u.size, hd: u.hardness,
      op: u.opacity, sp: u.spacing, sm: u.smoothing,
      col: u.color, bm: u.blendMode,
      // afk gates delivery server-side: every tool-state and stroke type is in
      // INACTIVE_FILTERED_TYPES, so an AFK RECIPIENT is skipped in
      // broadcastToRoom and silently stops tracking its peers.
      afk: u.afk ?? null,
    });
    return {
      self: dump(app.self),
      remotes: Array.from(app.users.values()).filter(u => u !== app.self).map(dump),
    };
  });
}

async function strokeMetadata(page) {
  return page.evaluate(() => {
    const lm = window.app.board.layerManager;
    const groups = [];
    let total = 0;
    let baked = 0;
    lm.layerGroups?.forEach((group, groupIdx) => {
      total += group.strokeStack.length;
      // Per-user counts: track if anyone has been baking (count below stack length means bakes happened)
      const userCounts = {};
      for (const [uid, n] of group.userStrokeCounts.entries()) userCounts[uid] = n;
      const hasBaked = !!group.flatCanvas;
      if (hasBaked) baked++;
      groups.push({ groupIdx, count: group.strokeStack.length, hasBaked, userCounts });
    });
    return { total, baked, groups, maxPerUser: lm.constructor.MAX_STROKES_PER_USER };
  });
}

// ─── Bot Lifecycle ─────────────────────────────────────────────────────────

async function spawnBot(browser, index, room) {
  const name = `bot_${index}`;
  const page = await browser.newPage();

  page.on('console', msg => {
    const txt = msg.text();
    if (/\[ERROR\]|\[SYNC\]/i.test(txt)) process.stdout.write(`  [${name}] ${txt}\n`);
  });
  page.on('pageerror', err => process.stderr.write(`  [${name} ERROR] ${err.message}\n`));

  // Pin Math.random + Date.now BEFORE the document loads (matches visual regression).
  await page.evaluateOnNewDocument(() => {
    let seed = 12345;
    Math.random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const fixedDate = new Date('2026-05-05T12:00:00Z').getTime();
    Date.now = () => fixedDate;
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app !== undefined && window.app.self != null, { timeout: 60_000 });

  await page.evaluate((n, r) => {
    window.app.self.username = n;
    window.app.handleRoomSelected(r);
  }, name, room);

  await page.waitForFunction(() => {
    const app = window.app;
    if (app?.brushGallery && !app.brushGallery.realGallery) app.brushGallery.loadRealGallery();
    const brushes = app?.brushGallery?.realGallery?.brushes;
    const syncDone = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && syncDone && brushes && brushes.length > 0;
  }, { timeout: 60_000 });

  // Stop the real-time tick loop — manual inputBufferManager.tick() drives the work.
  await stopTickLoop(page);

  return { name, page };
}

async function clearAllBots(bots) {
  for (const b of bots) await clearCanvas(b.page);
  await sleep(800); // give the clear broadcast time to settle
}

async function reseedAllBots(bots, seedValue = 12345) {
  for (const b of bots) await reseedRandom(b.page, seedValue);
}

// ─── Comparison & Reporting ────────────────────────────────────────────────

async function saveBotArtifacts(bots, result, label) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const safe = label.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();

  // Per-bot composite PNGs (what was diffed)
  for (const bot of bots) {
    const png = await captureLayerCompositePng(bot.page);
    if (png) fs.writeFileSync(path.join(RESULTS_DIR, `${safe}__${bot.name}.png`), png);
  }

  // Per-bot user-state dump (helps spot state divergence at capture time)
  const states = await Promise.all(bots.map(b => userStateDump(b.page)));
  const lines = [];
  states.forEach((s, i) => {
    lines.push(`bot_${i}:`);
    lines.push(`  self:    ${JSON.stringify(s.self)}`);
    for (const r of s.remotes) lines.push(`  remote:  ${JSON.stringify(r)}`);
  });
  fs.writeFileSync(path.join(RESULTS_DIR, `${safe}__STATE.txt`), lines.join('\n'));

  // Diff PNG drawer-vs-each-observer
  const drawerSnap = result.snapshots?.[DRAWER_INDEX];
  if (!drawerSnap || !result.diffs) return;
  for (const d of result.diffs) {
    const otherSnap = result.snapshots[d.otherIdx];
    const diffPng = await generateDiffPng(bots[DRAWER_INDEX].page, drawerSnap, otherSnap);
    if (diffPng) {
      const fname = `${safe}__DIFF_drawer_vs_bot_${d.otherIdx}.png`;
      fs.writeFileSync(path.join(RESULTS_DIR, fname), diffPng);
    }
  }
}

/**
 * Compare every non-drawer bot against the drawer. Pass = every bot matches
 * within tolerance on every layer group AND stroke totals agree.
 */
async function compareBots(bots, drawerIdx = DRAWER_INDEX) {
  const snapshots = await Promise.all(bots.map(b => captureLayerSnapshots(b.page)));
  const meta      = await Promise.all(bots.map(b => strokeMetadata(b.page)));

  const refSnap = snapshots[drawerIdx];
  const diffs = [];
  for (let i = 0; i < bots.length; i++) {
    if (i === drawerIdx) continue;
    diffs.push({ otherIdx: i, ...diffSnapshots(refSnap, snapshots[i]) });
  }
  const totalsEqual = meta.every(m => m.total === meta[0].total);
  const diffsPass = diffs.every(d => d.pass);
  return {
    snapshots, meta, diffs, totalsEqual,
    pass: diffsPass && totalsEqual,
    worstMatchPct: diffs.length ? Math.min(...diffs.map(d => d.matchPct)) : 100,
    worstMaxDelta: diffs.length ? Math.max(...diffs.map(d => d.maxDelta)) : 0,
  };
}

// ─── Test Runners ──────────────────────────────────────────────────────────

function nameAllowed(testName) {
  if (NAME_FILTER && !NAME_FILTER.some(f => testName.includes(f))) return false;
  return true;
}

function toolAllowed(toolName) {
  if (TOOL_FILTER && !TOOL_FILTER.includes(toolName)) return false;
  return true;
}

/** Single-drawer test: bot DRAWER_INDEX performs the action, others should mirror. */
async function runSingleDrawerTest(bots, testName, action) {
  const drawer = bots[DRAWER_INDEX];
  const t0 = Date.now();

  await clearAllBots(bots);
  await reseedAllBots(bots);
  await sleep(150);

  await action(drawer.page);
  await sleep(PROPAGATION_MS);

  const result = await compareBots(bots);
  const elapsed = Date.now() - t0;

  if (!result.pass) await saveBotArtifacts(bots, result, `FAIL_${testName}`);
  return { name: testName, elapsed, ...result };
}

/** Concurrent test: every bot draws its own stroke at the same time. */
async function runConcurrentTest(bots, testCase) {
  const t0 = Date.now();
  await clearAllBots(bots);
  await reseedAllBots(bots);
  await sleep(150);

  // Build per-bot tool + settings + path
  const tasks = bots.map(async (bot, i) => {
    const tool = testCase.perBotTool
      ? testCase.perBotTool[i % testCase.perBotTool.length]
      : testCase.tool;
    const zone = BOT_ZONES[i % BOT_ZONES.length];
    const settings = { ...testCase.settings, color: zone.color };

    await selectTool(bot.page, tool);
    await setToolSettings(bot.page, settings);

    const isShape = testCase.isShape || ['line', 'rectangle', 'circle'].includes(tool);
    if (isShape) {
      await drawPath(bot.page, [
        { x: 200 + zone.dx,        y: 200 + zone.dy },
        { x: 200 + zone.dx + 300,  y: 200 + zone.dy + 300 },
      ]);
    } else {
      const basePattern = STROKE_PATTERNS[i % STROKE_PATTERNS.length];
      const shifted = basePattern.map(p => ({
        x: 200 + zone.dx + (p.x % 400),
        y: 200 + zone.dy + (p.y % 300),
      }));
      await drawPath(bot.page, shifted);
    }
  });
  await Promise.all(tasks);

  await sleep(PROPAGATION_MS);
  const result = await compareBots(bots);
  const elapsed = Date.now() - t0;

  if (!result.pass) await saveBotArtifacts(bots, result, `FAIL_${testCase.name}`);
  return { name: testCase.name, elapsed, ...result };
}

/** Flood test (concurrent variant): every bot runs perBotAction in parallel. */
async function runFloodConcurrent(bots, testCase) {
  const t0 = Date.now();
  await clearAllBots(bots);
  await reseedAllBots(bots);
  await sleep(150);

  await Promise.all(bots.map((bot, i) => testCase.perBotAction(bot.page, i)));
  await sleep(PROPAGATION_MS + 1500); // floods need a bit longer to settle

  const result = await compareBots(bots);
  const elapsed = Date.now() - t0;
  if (!result.pass) await saveBotArtifacts(bots, result, `FAIL_${testCase.name}`);
  return { name: testCase.name, elapsed, ...result };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const roomName = `comp_sync_${Date.now()}`;
  console.log(`\nTop Draw — Comprehensive Sync Suite`);
  console.log(`Run:        ${RUN_ID}`);
  console.log(`URL:        ${TARGET_URL}`);
  console.log(`Room:       ${roomName}`);
  console.log(`Bots:       ${NUM_USERS}`);
  console.log(`Drawer:     bot_${DRAWER_INDEX}`);
  console.log(`Propagate:  ${PROPAGATION_MS}ms`);
  if (TOOL_FILTER) console.log(`Tools:      ${TOOL_FILTER.join(', ')}`);
  if (NAME_FILTER) console.log(`Names:      ${NAME_FILTER.join(', ')}`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const bots = [];
  const results = [];

  try {
    process.stdout.write('Spawning bots ');
    for (let i = 0; i < NUM_USERS; i++) {
      bots.push(await spawnBot(browser, i, roomName));
      process.stdout.write(`${i + 1} `);
    }
    console.log('');

    // Wait for everyone to see everyone. waitForFunction with default 'raf'
    // polling can stall in headless when the page isn't foregrounded — drive
    // the check from Node with a fixed interval instead.
    if (NUM_USERS > 1) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const sizes = await Promise.all(bots.map(b =>
          b.page.evaluate(() => window.app?.users?.size ?? 0)
        ));
        if (sizes.every(s => s >= NUM_USERS)) break;
        await sleep(250);
      }
      const finalSizes = await Promise.all(bots.map(b =>
        b.page.evaluate(() => window.app?.users?.size ?? 0)
      ));
      if (finalSizes.some(s => s < NUM_USERS)) {
        console.log('Roster sizes:', finalSizes);
        throw new Error('Bots did not see each other within 30s');
      }
    }
    console.log('All bots connected.\n');

    // ── Per-tool × per-setting matrix ──────────────────────────────────────
    console.log('── Tool × settings matrix ────────────────────────────────');
    for (const toolTest of TOOLS_TO_TEST) {
      if (!toolAllowed(toolTest.name)) continue;
      for (let i = 0; i < toolTest.settings.length; i++) {
        const testName = `${toolTest.name}_step_${i + 1}`;
        if (!nameAllowed(testName)) continue;

        const settings = toolTest.settings[i];
        const patternIdx = (TOOLS_TO_TEST.indexOf(toolTest) * 7 + i) % STROKE_PATTERNS.length;
        const pattern = STROKE_PATTERNS[patternIdx];
        const points = toolTest.category === 'shape'
          ? [pattern[0], pattern[pattern.length - 1]]
          : pattern;

        const action = async (page) => {
          await selectTool(page, toolTest.name);
          await setToolSettings(page, settings);
          await drawPath(page, points);
        };

        process.stdout.write(`  ${testName.padEnd(28)} ... `);
        const r = await runSingleDrawerTest(bots, testName, action);
        console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'} (${r.elapsed}ms)`);
        if (!r.pass) {
          const totals = r.meta.map(m => m.total).join(' | ');
          const baked  = r.meta.map(m => m.baked).join(' | ');
          console.log(`     match%: ${r.worstMatchPct.toFixed(3)}  maxΔ: ${r.worstMaxDelta}  totals: ${totals}  baked: ${baked}`);
          for (const d of r.diffs) {
            const pg = d.perGroup.map(g => `g${g.groupIdx}:${g.matchPct.toFixed(2)}%/Δ${g.maxDelta}`).join(' ');
            console.log(`       bot_${d.otherIdx} vs drawer: ${d.matchPct.toFixed(3)}% (${pg})`);
          }
        }
        results.push({ kind: 'tool', tool: toolTest.name, ...r });
      }
    }

    // ── Special cases ───────────────────────────────────────────────────────
    if (!SKIP_SPECIAL) {
      console.log('\n── Special cases ─────────────────────────────────────────');
      for (const sc of SPECIAL_CASES) {
        if (!nameAllowed(sc.name)) continue;
        process.stdout.write(`  ${sc.name.padEnd(28)} ... `);
        const r = await runSingleDrawerTest(bots, sc.name, sc.action);
        console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'} (${r.elapsed}ms)`);
        if (!r.pass) {
          const totals = r.meta.map(m => m.total).join(' | ');
          const baked  = r.meta.map(m => m.baked).join(' | ');
          console.log(`     match%: ${r.worstMatchPct.toFixed(3)}  maxΔ: ${r.worstMaxDelta}  totals: ${totals}  baked: ${baked}`);
          for (const d of r.diffs) {
            const pg = d.perGroup.map(g => `g${g.groupIdx}:${g.matchPct.toFixed(2)}%/Δ${g.maxDelta}`).join(' ');
            console.log(`       bot_${d.otherIdx} vs drawer: ${d.matchPct.toFixed(3)}% (${pg})`);
          }
        }
        results.push({ kind: 'special', ...r });
      }
    }

    // ── Concurrent cases ────────────────────────────────────────────────────
    if (!SKIP_CONCURRENT) {
      console.log('\n── Concurrent (all bots draw simultaneously) ─────────────');
      for (const cc of CONCURRENT_CASES) {
        if (!nameAllowed(cc.name)) continue;
        if (cc.tool && !toolAllowed(cc.tool)) continue;
        process.stdout.write(`  ${cc.name.padEnd(28)} ... `);
        const r = await runConcurrentTest(bots, cc);
        console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'} (${r.elapsed}ms)`);
        if (!r.pass) {
          const totals = r.meta.map(m => m.total).join(' | ');
          const baked  = r.meta.map(m => m.baked).join(' | ');
          console.log(`     match%: ${r.worstMatchPct.toFixed(3)}  maxΔ: ${r.worstMaxDelta}  totals: ${totals}  baked: ${baked}`);
          for (const d of r.diffs) {
            const pg = d.perGroup.map(g => `g${g.groupIdx}:${g.matchPct.toFixed(2)}%/Δ${g.maxDelta}`).join(' ');
            console.log(`       bot_${d.otherIdx} vs drawer: ${d.matchPct.toFixed(3)}% (${pg})`);
          }
        }
        results.push({ kind: 'concurrent', ...r });
      }
    }

    // ── Stroke flood (>MAX_STROKES_PER_USER → bake path) ────────────────────
    if (!SKIP_FLOOD) {
      console.log('\n── Stroke flood (forces bake path) ───────────────────────');
      for (const fc of STROKE_FLOOD_CASES) {
        if (!nameAllowed(fc.name)) continue;
        process.stdout.write(`  ${fc.name.padEnd(36)} ... `);
        const r = fc.kind === 'concurrent'
          ? await runFloodConcurrent(bots, fc)
          : await runSingleDrawerTest(bots, fc.name, fc.action);
        console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'} (${r.elapsed}ms)`);
        if (!r.pass) {
          const totals = r.meta.map(m => m.total).join(' | ');
          const baked  = r.meta.map(m => m.baked).join(' | ');
          console.log(`     match%: ${r.worstMatchPct.toFixed(3)}  maxΔ: ${r.worstMaxDelta}  totals: ${totals}  baked: ${baked}`);
          for (const d of r.diffs) {
            const pg = d.perGroup.map(g => `g${g.groupIdx}:${g.matchPct.toFixed(2)}%/Δ${g.maxDelta}`).join(' ');
            console.log(`       bot_${d.otherIdx} vs drawer: ${d.matchPct.toFixed(3)}% (${pg})`);
          }
        }
        results.push({ kind: 'flood', ...r });
      }
    }

    // ── Report ──────────────────────────────────────────────────────────────
    const passed = results.filter(r => r.pass).length;
    const total  = results.length;
    console.log('\n' + '─'.repeat(60));
    console.log(`RESULTS: ${passed}/${total} passed`);
    console.log('─'.repeat(60));

    writeMarkdownReport(results, { passed, total, roomName });
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify({
      runId: RUN_ID,
      url: TARGET_URL,
      bots: NUM_USERS,
      drawer: DRAWER_INDEX,
      propagationMs: PROPAGATION_MS,
      passed,
      total,
      pixelTolerance: PIXEL_TOLERANCE,
      passPct: PASS_PCT,
      results: results.map(r => ({
        kind: r.kind,
        tool: r.tool || null,
        name: r.name,
        pass: r.pass,
        elapsed: r.elapsed,
        totalsEqual: r.totalsEqual,
        totals: r.meta.map(m => m.total),
        baked:  r.meta.map(m => m.baked),
        worstMatchPct: r.worstMatchPct,
        worstMaxDelta: r.worstMaxDelta,
        diffs: r.diffs?.map(d => ({
          otherIdx: d.otherIdx,
          matchPct: d.matchPct,
          maxDelta: d.maxDelta,
          perGroup: d.perGroup,
        })),
      })),
    }, null, 2));
    console.log(`Summary: ${SUMMARY_FILE}`);
    console.log(`Report:  ${REPORT_FILE}\n`);

    process.exitCode = passed === total ? 0 : 1;
  } catch (err) {
    console.error('\nFatal error:', err);
    process.exitCode = 1;
  } finally {
    for (const bot of bots) await bot.page.close().catch(() => {});
    await browser.close();
  }
}

function writeMarkdownReport(results, { passed, total, roomName }) {
  let md = `# Comprehensive Sync Report\n\n`;
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Room: \`${roomName}\`\n`;
  md += `Bots: ${NUM_USERS}  |  Drawer: bot_${DRAWER_INDEX}  |  Propagation: ${PROPAGATION_MS}ms\n`;
  md += `Pixel tolerance: ±${PIXEL_TOLERANCE} per channel  |  Pass threshold: ≥${PASS_PCT}% matching pixels in union dirty bbox\n\n`;
  md += `**Result: ${passed}/${total} passed**\n\n`;
  md += `> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered viewCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.\n\n`;

  const groups = { tool: [], special: [], concurrent: [], flood: [] };
  for (const r of results) (groups[r.kind] ||= []).push(r);

  for (const [kind, rows] of Object.entries(groups)) {
    if (rows.length === 0) continue;
    md += `## ${kind[0].toUpperCase()}${kind.slice(1)} (${rows.filter(r => r.pass).length}/${rows.length})\n\n`;
    md += `| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |\n`;
    md += `| :--- | :--- | --- | --- | --- | :--- | :--- |\n`;
    for (const r of rows) {
      const icon = r.pass ? '✅' : '❌';
      const matchPct = r.worstMatchPct?.toFixed(3) ?? '—';
      const maxDelta = r.worstMaxDelta ?? '—';
      const totals = r.meta.map(m => m.total).join(' / ');
      const totalsCell = r.totalsEqual ? totals : `❌ ${totals}`;
      const baked = r.meta.map(m => m.baked).join(' / ');
      md += `| ${r.name} | ${icon} | ${r.elapsed}ms | ${matchPct}% | ${maxDelta} | ${totalsCell} | ${baked} |\n`;
    }
    md += '\n';
  }

  // Detailed failure breakdown
  const fails = results.filter(r => !r.pass);
  if (fails.length) {
    md += `## Failure detail\n\n`;
    for (const r of fails) {
      md += `### ${r.name}\n\n`;
      md += `- Worst match: **${r.worstMatchPct?.toFixed(3)}%**  Worst maxΔ: **${r.worstMaxDelta}**\n`;
      md += `- Stroke totals: ${r.meta.map(m => m.total).join(' / ')} (equal: ${r.totalsEqual ? 'yes' : 'no'})\n`;
      md += `- Baked groups per bot: ${r.meta.map(m => m.baked).join(' / ')}\n`;
      if (r.diffs?.length) {
        for (const d of r.diffs) {
          md += `- bot_${d.otherIdx} vs drawer: ${d.matchPct.toFixed(3)}% (maxΔ ${d.maxDelta})\n`;
          for (const g of d.perGroup) {
            const bbox = g.bbox ? `${g.bbox.w}×${g.bbox.h}@(${g.bbox.x},${g.bbox.y})` : 'empty';
            md += `    - group ${g.groupIdx}: ${g.matchPct.toFixed(3)}% match · maxΔ ${g.maxDelta} · bbox ${bbox} · ${g.matched}/${g.checked} px\n`;
          }
        }
      }
      md += `- Screenshots: \`FAIL_${r.name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}__bot_*.png\`\n\n`;
    }
  }

  fs.writeFileSync(REPORT_FILE, md);
}

main().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
