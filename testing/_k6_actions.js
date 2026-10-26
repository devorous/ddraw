/**
 * Shared action helpers for the all-inclusive k6 stress test suite.
 *
 * Each helper composes one or more Protobuf messages (via _k6_proto.buildMsg)
 * representing a high-level user action — drawing a stroke, performing a
 * selection + homography transform, typing text with a font, configuring
 * the confetti/pattern brushes, applying a blend mode, flood fill, etc.
 *
 * Tests pull from these helpers to build realistic, all-tools-exercised
 * traffic. The behavior tests pick actions randomly per profile; the
 * ordered tests cycle every tool through the full set sequentially.
 */

import { buildMsg as buildBaseMsg } from './_k6_proto.js';
import { encodePressureTargets, PRESSURE_TARGET_ALL } from '../shared/pressureTargets.js';

// ─── Opt-in pressure-opacity traffic ────────────────────────────────────────
// PRESSURE_OPACITY=1 makes bots send pressure targets (size + opacity, what the
// real client sends with opacity ticked) on CPT and on every MD, so receivers
// build the pressure opacity mask. Off by default: every existing feed keeps
// sending no `pt`, i.e. the size-only default.
export const PRESSURE_OPACITY =
  typeof __ENV !== 'undefined' && __ENV.PRESSURE_OPACITY === '1';

/** `pt` (proto field 215, varint) appended after the base fields; _k6_proto has no encoder for it. */
function withPressureTargets(buf, targets) {
  const value = encodePressureTargets(targets);
  const tag = (215 << 3) | 0;                       // 1720 -> two varint bytes
  const extra = [(tag & 0x7f) | 0x80, tag >> 7, value];
  const out = new Uint8Array(buf.byteLength + extra.length);
  out.set(new Uint8Array(buf), 0);
  out.set(extra, buf.byteLength);
  return out.buffer;
}

/** buildMsg, plus `pt` when `fields.pt` (raw PRESSURE_TARGET_* bits) is set. */
function buildMsg(fields) {
  if (fields.pt === undefined) return buildBaseMsg(fields);
  const rest = Object.assign({}, fields);
  delete rest.pt;
  return withPressureTargets(buildBaseMsg(rest), fields.pt);
}

// ─── Wire-level constants (mirror proto T enum) ─────────────────────────────

export const T = {
  CONNECT: 0,
  MM: 10, MD: 11, MU: 12, CP: 13, CS: 14, CT: 15, CC: 16, CSP: 17,
  KP: 19, CLR: 20, MSG: 22, GMP: 23, SHOW_CURSOR: 28, CSM: 29,
  SEL_LIFT: 30, SEL_MOVE: 31, SEL_COMMIT: 32, SEL_DELETE: 33,
  SEL_FILL: 34, SEL_STAMP: 35, SEL_CANCEL: 36, SEL_FLIP: 67,
  SEL_PENDING: 68, SEL_MASK: 93,
  CPT: 157,
  CHD: 45, CBR: 57, CL: 58, CBM: 59,
  UNDO: 60, REDO: 61,
  CTHN: 71, CSIM: 72, FILL: 73,
  GPT: 82, CPM: 84,
  CSDM: 91, TEXT_APPLY: 90, CF: 116,
  IMAGE_TOOL: 134,
  SEL_MERGE: 136,
};

// ─── Tool enum (matches proto Tool enum) ────────────────────────────────────

export const Tool = {
  BRUSH: 0, TEXT: 1, ERASE: 2, IMAGE_BRUSH: 3, SELECT: 4,
  PEN: 5, LINE: 6, RECTANGLE: 7, CIRCLE: 8, INK: 9,
  INKDROPPER: 10, BLUR: 11, CIRCLE_BLUR: 12, GLITCH_BLUR: 13,
  PIXEL: 14, FLOODFILL: 15, PATTERN: 16, CONFETTI: 17,
};

export const TOOL_NAMES = Object.fromEntries(
  Object.entries(Tool).map(([name, idx]) => [idx, name])
);

/** Every drawable tool in id order. */
export const ALL_TOOLS = Object.values(Tool);

/** Tools that offer the pressure-targets choice (shared/pressureTargets.js). */
const PRESSURE_TOOLS = new Set([Tool.BRUSH, Tool.PEN, Tool.INK, Tool.CIRCLE_BLUR, Tool.ERASE, Tool.IMAGE_BRUSH]);

export function isFillTargetTool(tool) {
  return tool === Tool.BRUSH ||
         tool === Tool.PEN ||
         tool === Tool.INK ||
         tool === Tool.PIXEL ||
         tool === Tool.IMAGE_BRUSH ||
         tool === Tool.PATTERN;
}

// ─── Common content / settings ──────────────────────────────────────────────

export const TEXT_PHRASES = [
  'hello!', 'nice', 'cool drawing', 'lol', 'hey', 'sup', ':)', 'wow', 'brb',
  'nice work', 'test', 'drawing', 'awesome', 'haha', 'cool', 'ty', 'thanks',
  'sweet', 'hi', 'yo', 'art', 'nice!', 'omg', 'epic', 'gg', 'whoa', 'neat',
];

export const FONTS = [
  'Arial',
  'Comic Sans MS',
  'Courier New',
  'Georgia',
  'Impact',
  'Times New Roman',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Helvetica',
];

export const BLEND_MODES = [
  'source-over',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
];

export const SHAPE_DRAW_MODES = ['corner-to-corner', 'center-scaling'];

export const COMMON_COLORS = [
  0x000000FF, 0xFF0000FF, 0x0000FFFF, 0x00FF00FF, 0xFFFF00FF, 0xFF00FFFF,
  0x00FFFFFF, 0xFFFFFFFF, 0x808080FF, 0xFFA500FF, 0x800080FF, 0x8B4513FF,
  0xFFC0CBFF, 0x90EE90FF,
];

// Tiny 1x1 fully-transparent PNG. NOT sent by default for SEL_LIFT — the
// previous version of this helper attached this as `g` on every selection
// lift, which forced receivers' handleSelectionLift to stretch a 1x1 image
// over the entire selection rect (baking a solid rectangle on commit). Bots
// have no canvas, so the correct path is to omit `g` entirely: the server
// falls through to default broadcast (server/index.js SEL_LIFT case), and
// the receiver's _populateLiftedSelectionFromLayer captures the real pixels
// from its own copy of the user's active layer. Only kept exported because
// a handful of tests pass it explicitly via opts.imageData to exercise the
// image-load codepath specifically.
export const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

// NOTE: there is deliberately no list of shipped brush filenames here any more.
// Bots used to send `{url: 'brushes/pepper.gbr'}` for both the image and pattern
// brushes, which looks right and is not: receivers load a brush with
// `new Image(); image.src = brushData.gimpUrl`, and a .gbr is a GIMP binary no
// <img> can decode. The real client parses the .gbr itself and ships the result
// as a data URL in `gimpUrl`. Bots have no parser, so they carry their own
// ready-made bitmap instead — see PATTERN_TILE_PNG / PATTERN_TILE_SVG.

// ─── Random helpers ─────────────────────────────────────────────────────────

// Every random helper takes an optional `rng`. k6's Math.random cannot be
// seeded, so a feed that wants reproducible runs has to thread its own
// generator all the way down — including into configureTool, which makes more
// random choices (hardness, smoothing, spacing, pattern/confetti payloads) than
// the caller does. Leaving even one of them on Math.random is enough to make a
// seeded run diverge, which is worse than an honestly unseeded one.
export function pick(arr, rng = Math.random) { return arr[Math.floor(rng() * arr.length)]; }
export function randInt(min, max, rng = Math.random) { return min + Math.floor(rng() * (max - min + 1)); }
export function randColor(rng = Math.random) {
  if (rng() < 0.7) return pick(COMMON_COLORS, rng);
  const r = randInt(0, 255, rng), g = randInt(0, 255, rng), b = randInt(0, 255, rng);
  return ((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0;
}

// ─── Tool-setting payload builders ──────────────────────────────────────────

/**
 * Build a confetti settings JSON payload for IMAGE_TOOL.
 */
export function makeConfettiPayload(rng = Math.random) {
  const shapes = ['circle', 'square', 'image'];
  const colorModes = ['active', 'random', 'image'];
  const rotationModes = ['random', 'fixed', 'follow'];
  return JSON.stringify({
    confettiParticles:         randInt(3, 12, rng),
    confettiParticleSize:      randInt(6, 22, rng),
    confettiSizeVariation:     randInt(0, 100, rng),
    confettiOpacityRandomness: randInt(0, 100, rng),
    confettiSpacing:           randInt(10, 50, rng),
    confettiShape:             pick(shapes, rng),
    confettiColorMode:         pick(colorModes, rng),
    confettiRotationMode:      pick(rotationModes, rng),
  });
}

// A self-contained 16x16 RGBA checkerboard. Pattern/image brushes are loaded on
// the receiver with `new Image(); image.src = brushData.gimpUrl`, so the payload
// has to carry a URL an Image can actually decode. A path like `brushes/x.gbr`
// is NOT one: .gbr is a GIMP binary that the real client parses to a canvas and
// re-exports as a data URL, which is what `gimpUrl` holds. A data URL keeps the
// bots independent of anything the server has to serve.
export const PATTERN_TILE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVR4nGN4FqXxHxlr2JxAwYTkGYaBAaRqQJcfDgYMfCwMvAEDHwsDbgAAxx1JH3Ak+ocAAAAASUVORK5CYII=';

// A trivial two-tone SVG, for the `type: 'svg'` branch. That branch takes a
// different route on the receiver — `_loadBrushImage` builds a Blob from
// `svgContent` instead of reading `gimpUrl`, and `_getPatternTile` renders it at
// maxDim 200 with a compensating `scale *= 0.2` — so a feed that only ever sends
// raster brushes leaves all of it untested.
export const PATTERN_TILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">'
  + '<rect width="32" height="32" fill="#1e6fd9"/>'
  + '<circle cx="16" cy="16" r="10" fill="#ffcf3f"/></svg>';

/**
 * Build a pattern brush JSON payload for GPT.
 *
 * Must mirror `PatternOptionsController._buildPatternPayload`, because
 * `RemoteUserHandler.handlePatternBrushLoad` reads `patternData.brush` FIRST and
 * returns outright when it is absent:
 *
 *     const brushData = patternData.brush;
 *     if (!brushData) return;                 // ← the old payload died here
 *
 * The previous shape was `{url, scale, rotation, blendMode}` — no `brush` key at
 * all — so `user.patternBrush` was never assigned on any receiver. Every
 * consumer is gated on it (`PatternTool.drawStamp` bails when `_getPatternTile`
 * returns null, `usePattern = user.patternMode && user.patternBrush`), which
 * means every PATTERN-tool stroke the bots have ever sent committed ZERO pixels
 * while still showing up in the coverage report as a tool that ran. A tool that
 * paints nothing can never disagree, so it also quietly inflated every pixel
 * parity number this feed has produced.
 *
 * `scale` is a PERCENT here (the client divides by 100), not a multiplier — the
 * old payload's 0.5–2.0 was a 0.5%–2% scale, off by 100x even if it had loaded.
 */
export function makePatternPayload(rng = Math.random) {
  const useSvg = rng() < 0.35;
  const brush = useSvg
    ? { type: 'svg', brushName: 'k6_svg_tile', fileName: 'k6_svg_tile.svg',
        width: 32, height: 32, svgContent: PATTERN_TILE_SVG }
    : { type: 'image', brushName: 'k6_png_tile', fileName: 'k6_png_tile.png',
        width: 16, height: 16, gimpUrl: PATTERN_TILE_PNG };
  return JSON.stringify({
    brush,
    scale:     randInt(50, 300, rng),
    rotation:  randInt(0, 359, rng),
    spacing:   randInt(0, 24, rng),
    offsetX:   randInt(0, 32, rng),
    offsetY:   randInt(0, 32, rng),
    // 'tinted' folds user.color into the tile cache key, so the same brush must
    // produce a different tile per colour — a cache-key bug shows up only here.
    colorMode: pick(['original', 'tinted'], rng),
  });
}

/**
 * Build an image-brush (GIMP) JSON payload for the GMP message.
 *
 * Mirrors `PatternOptionsController._buildImageBrushPayload`, which is FLAT —
 * no `brush` wrapper, unlike the pattern payload above. `handleBrushLoad`
 * assigns `user.imageBrush = brushData` verbatim, then only calls
 * `_loadBrushImage` when `brushData.type` is 'gbr' | 'image' | 'svg'.
 *
 * The old `{url: 'brushes/pepper.gbr'}` had no `type`, so it satisfied the
 * truthiness check in `_moveStroke` (`!user.imageBrush` passes) while never
 * loading an image: `ImageBrushTool.drawStamp` resolves `image`/`width`/`height`
 * from a `brush.type` switch, so with no type it stamps nothing. Same silent
 * no-op as the pattern brush, and the `_pendingStrokes` buffer that exists to
 * replay strokes racing the decode was never drained either.
 *
 * `width`/`height` must match the bitmap: `drawStamp` sizes 'gbr' stamps from
 * the payload's dimensions, not from the decoded image.
 */
export function makeGimpPayload(rng = Math.random) {
  return JSON.stringify({
    type: 'gbr',
    brushName: 'k6_gbr_tile',
    fileName: 'k6_gbr_tile.gbr',
    width: 16,
    height: 16,
    gimpUrl: PATTERN_TILE_PNG,
    colorDepth: 4,
    // 'tinted' drives ImageBrushTool._tintCache; 'original' skips it entirely.
    colorMode: pick(['original', 'tinted'], rng),
  });
}

// ─── Action helpers — each sends a coherent group of messages ───────────────

/**
 * Configure the user's basic tool state: tool/color/size + tool-specific
 * settings (hardness, smoothing, spacing, ink thinning/sim, blur radius,
 * shape draw mode, pattern/confetti payloads, gimp image-brush payload).
 *
 * Also sends SHOW_CURSOR so the bot is visible.
 *
 * @param {object} socket - k6 ws socket
 * @param {number} u      - session index
 * @param {number} tool   - Tool enum value
 * @param {object} [opts]
 *   color, size, hardness, smoothing, spacing, thinning, simPressure,
 *   blurRadius, shapeDrawMode, blendMode, activeLayer, patternMode,
 *   patternData, confettiData, gimpData
 */
export function configureTool(socket, u, tool, opts = {}) {
  const rng      = opts.rng      ?? Math.random;
  const color    = opts.color    ?? randColor(rng);
  const size     = opts.size     ?? randInt(500, 3500, rng);
  const hardness = opts.hardness ?? randInt(20, 100, rng);
  const smoothing= opts.smoothing?? randInt(0, 50, rng);
  const spacing  = opts.spacing  ?? randInt(100, 600, rng);

  // `a` = eraseAll. Set only for the eraser, and only when the caller asks:
  // it routes the receiver through `board.beginStrokeAllLayers`, a genuinely
  // different commit path from the single-layer eraser.
  const ct = { t: T.CT, u, l: tool };
  if (tool === Tool.ERASE && opts.eraseAll) ct.a = true;
  socket.sendBinary(buildMsg(ct));
  socket.sendBinary(buildMsg({ t: T.CC, u, c: color }));
  socket.sendBinary(buildMsg({ t: T.CS, u, s: size }));
  socket.sendBinary(buildMsg({ t: T.CHD, u, hd: hardness }));
  socket.sendBinary(buildMsg({ t: T.CSM, u, sm: smoothing }));
  socket.sendBinary(buildMsg({ t: T.CSP, u, sp: spacing }));
  if (PRESSURE_OPACITY && PRESSURE_TOOLS.has(tool)) {
    socket.sendBinary(buildMsg({ t: T.CPT, u, pt: opts.pressureTargets ?? PRESSURE_TARGET_ALL }));
  }

  if (opts.activeLayer !== undefined) {
    socket.sendBinary(buildMsg({ t: T.CL, u, ly: opts.activeLayer }));
  }
  if (opts.blendMode !== undefined) {
    setBlendMode(socket, u, opts.blendMode, {
      layer: opts.blendLayer ?? opts.activeLayer,
      bakeMode: opts.blendBakeMode,
    });
  }

  // Tool-specific extras
  if (tool === Tool.BLUR || tool === Tool.CIRCLE_BLUR || tool === Tool.GLITCH_BLUR) {
    socket.sendBinary(buildMsg({ t: T.CBR, u, br: opts.blurRadius ?? randInt(100, 2000, rng) }));
  }
  if (tool === Tool.INK) {
    // Both of these are OFFSET encodings on the wire, and sending the raw value
    // silently degrades to a default instead of erroring.
    //   th:  client reads `(data.th ? data.th - 1 : 50) / 100`, so the sender
    //        must add 1 — and a raw 0 does not mean "no thinning", it means
    //        "field absent, use 50".
    //   sim: 0 = not set, 1 = false, 2 = true. Sending `? 1 : 0` (the obvious
    //        boolean) therefore encodes false-or-unset and NEVER true, so
    //        simulate-pressure was dead in every run this feed has ever done.
    socket.sendBinary(buildMsg({ t: T.CTHN, u, th: (opts.thinning ?? randInt(0, 100, rng)) + 1 }));
    socket.sendBinary(buildMsg({ t: T.CSIM, u, sim: (opts.simPressure ?? (rng() > 0.5)) ? 2 : 1 }));
  }
  if (tool === Tool.RECTANGLE || tool === Tool.CIRCLE) {
    // `sdm`, not `g`. The client reads `data.sdm || 'corner-to-corner'`
    // (WebSocketClient case T.CSDM), so a mode sent as `g` is dropped and every
    // receiver silently falls back to corner-to-corner — which is how a feed
    // that advertised both shape modes only ever exercised one.
    socket.sendBinary(buildMsg({ t: T.CSDM, u, sdm: opts.shapeDrawMode ?? pick(SHAPE_DRAW_MODES, rng) }));
  }
  if (tool === Tool.IMAGE_BRUSH) {
    socket.sendBinary(buildMsg({ t: T.GMP, u, g: opts.gimpData ?? makeGimpPayload(rng) }));
  }
  if (tool === Tool.PATTERN) {
    const data = opts.patternData ?? makePatternPayload(rng);
    socket.sendBinary(buildMsg({ t: T.GPT, u, g: data }));
    socket.sendBinary(buildMsg({ t: T.IMAGE_TOOL, u, image_tool_type: 'pattern', image_tool_data: data }));
    if (opts.patternMode !== undefined) {
      socket.sendBinary(buildMsg({ t: T.CPM, u, pm: opts.patternMode }));
    }
  }
  // Pattern FILL — the "fill with pattern" checkbox that the fill and select
  // tools each own (App.js wires both to broadcastPatternMode). It is a
  // different consumer from the pattern BRUSH above: `FloodFillTool` and
  // `RemoteSelectionHandler._fillSelection` both gate on
  // `user.patternMode && user.patternBrush` and tile the brush across the fill
  // region instead of using the flat colour.
  //
  // Both halves have to travel. CPM alone leaves `patternBrush` undefined and
  // the receiver silently falls back to a solid fill, so a feed that sent only
  // CPM would look like it covered pattern fills while testing the plain path
  // twice. Sent for every fill-capable tool, not just PATTERN.
  //
  // OPT-IN (default false) on purpose: seven feeds share configureTool, and
  // turning pattern fills on by default would silently change what the
  // selection suites fill with. The caller that wants the coverage asks for it.
  if (tool === Tool.FLOODFILL || tool === Tool.SELECT) {
    const wantPatternFill = opts.patternFill ?? false;
    if (wantPatternFill) {
      socket.sendBinary(buildMsg({ t: T.GPT, u, g: opts.patternData ?? makePatternPayload(rng) }));
    }
    // Always sent, both ways: patternMode is sticky user state, so a bot that
    // only ever turns it ON leaves every later fill patterned and never
    // exercises the transition back to a solid fill.
    socket.sendBinary(buildMsg({ t: T.CPM, u, pm: wantPatternFill }));
  }
  if (tool === Tool.CONFETTI) {
    const data = opts.confettiData ?? makeConfettiPayload(rng);
    socket.sendBinary(buildMsg({ t: T.IMAGE_TOOL, u, image_tool_type: 'confetti', image_tool_data: data }));
  }

  socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u }));
}

/**
 * Send a single MM (move) message at the given coords.
 * @param {object} socket
 * @param {number} u
 * @param {number} x
 * @param {number} y
 * @param {boolean} [stamp=false] - include stroke_ts for latency tracking
 */
export function sendMove(socket, u, x, y, stamp = false) {
  const m = { t: T.MM, u, ps: [x, y] };
  if (stamp) m.stroke_ts = Date.now();
  socket.sendBinary(buildMsg(m));
}

/**
 * Send a batched MM carrying several points at once, optionally with per-point
 * stamp metadata — i.e. `broadcastMove` / `broadcastStampMove`.
 *
 * Real clients buffer pointer samples between ticks and flush them as ONE
 * multi-point MM; sending one point per message (what every k6 feed did) is a
 * different shape of traffic through the same handler: different delta-encoding
 * runs, different per-message smoothing-buffer state, and a message count that
 * over-states MM volume by roughly the tick batch factor.
 *
 * @param {object} socket
 * @param {number} u
 * @param {Array<number>} points - flat [x,y,x,y,...]
 * @param {Array<number>|null} [radii] - one entry per point pair (pen/blur radii,
 *   confetti seeds). Omit for plain freehand.
 * @param {{confettiData?: string, stamp?: boolean}} [opts]
 */
export function sendMoveBatch(socket, u, points, radii = null, opts = {}) {
  const m = { t: T.MM, u, ps: points };
  if (radii && radii.length) m.rs = radii;
  if (opts.confettiData) m.g = opts.confettiData;
  if (opts.stamp) m.stroke_ts = Date.now();
  socket.sendBinary(buildMsg(m));
}

/**
 * Send MD. Mirrors `broadcastMouseDown(points, radii, metadata)`.
 *
 * The metadata is the part that was missing: a real client stamps the layer and
 * blend mode onto the mousedown itself, and `RemoteUserHandler.handleMouseDown`
 * applies `data.layerIndex` / `data.blendMode` before it calls `beginUserStroke`.
 * A bot that relies on CL/CBM alone still works — the user object holds the
 * state — but it exercises a different ordering than any human client produces,
 * and it leaves the MD-carried override path untested.
 *
 * @param {object} socket
 * @param {number} u
 * @param {number} x
 * @param {number} y
 * @param {{radii?: Array<number>, layer?: number, blendMode?: string,
 *          blendBakeMode?: string, confettiData?: string}} [meta]
 */
export function sendDown(socket, u, x, y, meta = {}) {
  const msg = { t: T.MD, u, ps: [x, y] };
  if (meta.radii && meta.radii.length) msg.rs = meta.radii;
  if (meta.layer !== undefined) msg.ly = meta.layer;
  if (meta.blendMode) msg.bm = meta.blendMode;
  if (meta.blendBakeMode) msg.bbm = meta.blendBakeMode === 'background' ? 'background' : 'existing';
  if (meta.confettiData) msg.g = meta.confettiData;
  // The real client stamps the stroke's pressure targets onto every MD.
  const targets = meta.pressureTargets ?? (PRESSURE_OPACITY ? PRESSURE_TARGET_ALL : undefined);
  if (targets !== undefined) msg.pt = targets;
  socket.sendBinary(buildMsg(msg));
}

/**
 * A self-overlapping scribble for the pressure-opacity bots: a loop whose
 * radius wanders, so every lap crosses the previous ones, with pressure
 * swinging 0.2-1.0 along the stroke. Points are ~`step` px apart.
 * `radii` are per-point pressure x 255, the `rs` that ink / pen strokes carry.
 *
 * @returns {{points: number[], radii: number[]}}
 */
export function makeScribble(rng, cx, cy, R, n, step = 8) {
  const points = [], radii = [];
  const phase = rng() * Math.PI * 2, pPhase = rng() * Math.PI * 2;
  const da = step / Math.max(R * 0.7, 1);
  const pCycles = 1.5 + rng() * 2;
  for (let i = 0; i < n; i++) {
    const a = phase + i * da;
    const r = R * (0.55 + 0.45 * Math.sin(i * da * 0.37 + phase));
    points.push(cx + r * Math.cos(a) + (rng() - 0.5) * 2,
                cy + r * Math.sin(a) + (rng() - 0.5) * 2);
    const p = 0.6 + 0.4 * Math.sin(pPhase + (i / n) * pCycles * Math.PI * 2);
    radii.push(Math.round(p * 255));
  }
  return { points, radii };
}

export function sendUp(socket, u) {
  socket.sendBinary(buildMsg({ t: T.MU, u }));
}

/**
 * Type text on the board with an explicit font. Sends CF (font/baseline)
 * then TEXT_APPLY (text + position).
 */
export function applyTextWithFont(socket, u, x, y, text, font, opts = {}) {
  const fontFamily = font ?? pick(FONTS, opts.rng ?? Math.random);
  socket.sendBinary(buildMsg({
    t: T.CF, u,
    fo: fontFamily,
    tm: opts.tm ?? 1.0,
    to: opts.to ?? 0.0,
  }));
  socket.sendBinary(buildMsg({
    t: T.TEXT_APPLY, u,
    g: text,
    ps: [x, y],
    fo: fontFamily,
    text_id: opts.textId ?? `txt_${u}_${Date.now()}_${Math.floor((opts.rng ?? Math.random)() * 1e6)}`,
    text_pixel: opts.textPixel ? 1 : 0,
    text_lifetime_ms: opts.textLifetimeMs ?? 0,
    text_fade_ms: opts.textFadeMs ?? 0,
  }));
}

/**
 * Perform a flood fill at (x, y).
 *
 * Mirrors `broadcastFill(x, y, layerIndex, expansion, blurRadius)`. Three
 * things about this message are easy to get wrong and all three were:
 *
 * - The point travels in **sx/sy**, not `ps`. A ps-based FILL silently no-ops.
 * - **The colour does NOT travel with the fill.** `case T.FILL` reads only
 *   sx, sy, ly, s and br — never `c` — so the receiver fills with its own copy
 *   of the user's current colour. A `c` on the FILL message is inert; to fill
 *   in a specific colour you must send CC first, exactly as a human does by
 *   picking the colour before clicking. (The old helper took a `color` argument
 *   and encoded it as `c`, so every bot fill actually used whatever colour that
 *   bot last set — and the harness thought it knew the colour, which is worse
 *   than not knowing.)
 * - `s` and `br` are expansion and edge-blur, both ×100. No feed has ever set
 *   them, so non-zero fill expansion/feather has zero bot coverage.
 *
 * @param {object} socket
 * @param {number} u
 * @param {number} x
 * @param {number} y
 * @param {number} [color] - packed RGBA; sent as a preceding CC, not on the FILL
 * @param {{layer?: number, expansion?: number, blurRadius?: number}} [opts]
 */
export function applyFloodFill(socket, u, x, y, color, opts = {}) {
  if (color !== undefined) socket.sendBinary(buildMsg({ t: T.CC, u, c: color }));
  socket.sendBinary(buildMsg({
    t: T.FILL, u,
    sx: Math.floor(x), sy: Math.floor(y),
    ly: opts.layer ?? 0,
    s: Math.round((opts.expansion ?? 0) * 100),
    br: Math.round((opts.blurRadius ?? 0) * 100),
  }));
}

/**
 * Set an arbitrary blend mode (CBM).
 *
 * Mirrors `broadcastLayerBlendModeChange(layerIndex, blendMode, blendBakeMode)`,
 * which always carries all three fields. Both omissions matter:
 *
 * - Without `ly`, the receiver takes `data.layerIndex ?? user.activeLayer`, so
 *   it still applies — but it skips the `markCompositeFull()` + re-composite the
 *   real message triggers, so the bot's blend change lands a frame differently
 *   than a human's.
 * - Without `bbm`, the receiver's ternary lands on `'existing'`, while every
 *   real client defaults to `'background'`. Those bake through different paths
 *   in `_bakeStrokeToBin`, so a feed that omits it tests the branch humans
 *   never take.
 *
 * NOTE: only layer 0 has `allowComplexBlendModes` (LayerManager.initLayerGroups),
 * so a complex mode aimed at layer 1/2 is forced to source-over by the receiver.
 * That is correct behaviour, not a desync — assert against it, don't "fix" it.
 *
 * @param {object} socket
 * @param {number} u
 * @param {string} [mode]
 * @param {{layer?: number, bakeMode?: 'existing'|'background'}} [opts]
 */
export function setBlendMode(socket, u, mode, opts = {}) {
  const msg = { t: T.CBM, u, bm: mode ?? pick(BLEND_MODES, opts.rng ?? Math.random) };
  if (opts.layer !== undefined) msg.ly = opts.layer;
  msg.bbm = opts.bakeMode === 'existing' ? 'existing' : 'background';
  socket.sendBinary(buildMsg(msg));
}

/**
 * Switch the user's active layer (CL). The board has three layer groups
 * (LayerManager.initLayerGroups(3)); index 2 is the top.
 */
export function sendLayerChange(socket, u, layerIndex) {
  socket.sendBinary(buildMsg({ t: T.CL, u, ly: layerIndex }));
}

/**
 * Broadcast a pressure change (CP). Wire value is pressure*100.
 *
 * Never sent by any previous feed, so the `cp` handler — which makes the brush
 * commit the current segment mid-stroke before applying the new pressure — has
 * had no coverage at all from k6 traffic.
 */
export function sendPressure(socket, u, pressure01) {
  socket.sendBinary(buildMsg({ t: T.CP, u, p: Math.round(pressure01 * 100) }));
}

/**
 * Perform a complete selection → homography transform → commit sequence.
 *
 * Sends:
 *   SEL_LIFT  with a small rect + dummy image payload (server requires g)
 *   SEL_MOVE  with 8-float corner array (tl, tr, br, bl) describing a
 *             perspective transform (homography)
 *   SEL_COMMIT (bakes the selection)
 *
 * @param {object} socket
 * @param {number} u
 * @param {object} [opts] { rect, corners }
 *   rect    – {x,y,width,height} on the board
 *   corners – {tl,tr,br,bl} target corners after homography; defaults to a
 *             trapezoid offset to the right with a perspective shrink
 */
export function performSelectionTransform(socket, u, opts = {}) {
  const rng = opts.rng ?? Math.random;
  const rect = opts.rect ?? {
    x: randInt(200, 1200, rng),
    y: randInt(200, 700, rng),
    width: randInt(120, 300, rng),
    height: randInt(120, 300, rng),
  };
  const tl = { x: rect.x, y: rect.y };
  const tr = { x: rect.x + rect.width, y: rect.y };
  const br = { x: rect.x + rect.width, y: rect.y + rect.height };
  const bl = { x: rect.x, y: rect.y + rect.height };

  // A perspective warp: shift right, shrink right edge ~25% to test homography
  const dx = randInt(100, 250, rng);
  const dy = randInt(-60, 60, rng);
  const shrink = 0.6 + rng() * 0.4;
  const corners = opts.corners ?? {
    tl: { x: tl.x + dx,                 y: tl.y + dy },
    tr: { x: tr.x + dx,                 y: tr.y + dy + (rect.height * (1 - shrink) * 0.5) },
    br: { x: br.x + dx,                 y: br.y + dy - (rect.height * (1 - shrink) * 0.5) },
    bl: { x: bl.x + dx,                 y: bl.y + dy },
  };

  // No `g` (image payload): receivers populate the floating canvas from their
  // own layer pixels via _populateLiftedSelectionFromLayer, which is what a
  // real lift would produce here. Sending a placeholder image causes the
  // receiver to stretch it over the whole selection on commit.
  socket.sendBinary(buildMsg({
    t: T.SEL_LIFT, u,
    sx: Math.round(rect.x),
    sy: Math.round(rect.y),
    sw: Math.round(rect.width),
    sh: Math.round(rect.height),
  }));

  socket.sendBinary(buildMsg({
    t: T.SEL_MOVE, u,
    cr: [
      corners.tl.x, corners.tl.y,
      corners.tr.x, corners.tr.y,
      corners.br.x, corners.br.y,
      corners.bl.x, corners.bl.y,
    ],
    cb:  [rect.x, rect.y, rect.width, rect.height],
    cbt: [rect.x, rect.y, rect.width, rect.height],
  }));

  socket.sendBinary(buildMsg({ t: T.SEL_COMMIT, u, ly: opts.layer ?? 0 }));
}

/**
 * Send a SEL_LIFT only — gives the test driver explicit control over the
 * full lift / move / commit / fill / delete / cancel sequence with its own
 * pacing.
 */
export function sendSelLift(socket, u, rect, opts = {}) {
  const msg = {
    t: T.SEL_LIFT, u,
    sx: Math.round(rect.x),
    sy: Math.round(rect.y),
    sw: Math.round(rect.width),
    sh: Math.round(rect.height),
  };
  // Only attach image data when a caller explicitly opts in; otherwise the
  // receiver lifts pixels from its own copy of the active layer (matching
  // what a real local lift would do without round-tripping a PNG).
  if (opts.imageData) {
    msg.g = opts.imageData;
  }
  // Lasso lift: cr is a flat [x0,y0,x1,y1,...] polygon path (≥3 points → ≥6 floats).
  if (opts.lassoPath && opts.lassoPath.length >= 6) {
    msg.cr = opts.lassoPath;
  }
  socket.sendBinary(buildMsg(msg));
}

/**
 * Send a SEL_MOVE describing a perspective transform via 4 corner points
 * (tl, tr, br, bl). cb/cbt source crop is optional.
 */
export function sendSelMove(socket, u, corners, opts = {}) {
  const msg = {
    t: T.SEL_MOVE, u,
    cr: [
      corners.tl.x, corners.tl.y,
      corners.tr.x, corners.tr.y,
      corners.br.x, corners.br.y,
      corners.bl.x, corners.bl.y,
    ],
  };
  if (opts.sourceCrop) {
    msg.cb = [opts.sourceCrop.x, opts.sourceCrop.y, opts.sourceCrop.width, opts.sourceCrop.height];
    msg.cbt = msg.cb;
  }
  socket.sendBinary(buildMsg(msg));
}

export function sendSelCommit(socket, u, layer = 0) {
  socket.sendBinary(buildMsg({ t: T.SEL_COMMIT, u, ly: layer }));
}

export function sendSelCancel(socket, u) {
  socket.sendBinary(buildMsg({ t: T.SEL_CANCEL, u }));
}

export function sendSelDelete(socket, u, layer = 0) {
  socket.sendBinary(buildMsg({ t: T.SEL_DELETE, u, ly: layer }));
}

export function sendSelFill(socket, u, color, layer = 0) {
  socket.sendBinary(buildMsg({ t: T.SEL_FILL, u, c: color, ly: layer }));
}

export function sendSelStamp(socket, u, layer = 0) {
  socket.sendBinary(buildMsg({ t: T.SEL_STAMP, u, ly: layer }));
}

export function sendSelFlip(socket, u) {
  socket.sendBinary(buildMsg({ t: T.SEL_FLIP, u }));
}

/**
 * Merge a layer's contents up/down/into-all (SEL_MERGE).
 * @param {'up'|'down'|'all'} [mode='down']
 */
export function sendSelMerge(socket, u, sourceLayer = 0, mode = 'down') {
  socket.sendBinary(buildMsg({ t: T.SEL_MERGE, u, ly: sourceLayer, g: mode }));
}

/**
 * Set or clear the selection MASK (SEL_MASK) — a clip region that constrains
 * every subsequent stroke until cleared.
 *
 * `board.applySelectionMaskClipForStroke` runs on every remote mousedown, so a
 * stale or divergent mask silently changes where another user's ink lands. No
 * bot feed has ever set one.
 *
 * @param {object} socket
 * @param {number} u
 * @param {{x,y,width,height}|null} rect - null clears the mask
 * @param {Array<number>} [lassoPath] - flat [x,y,...], >= 3 points for a lasso mask
 */
export function sendSelMask(socket, u, rect, lassoPath = null) {
  if (!rect) {
    socket.sendBinary(buildMsg({ t: T.SEL_MASK, u, mk: false }));
    return;
  }
  const msg = {
    t: T.SEL_MASK, u, mk: true,
    sx: Math.round(rect.x), sy: Math.round(rect.y),
    sw: Math.round(rect.width), sh: Math.round(rect.height),
  };
  // The mask lasso travels in `ps` (not `cr` like a lift's lasso).
  if (lassoPath && lassoPath.length >= 6) msg.ps = lassoPath;
  socket.sendBinary(buildMsg(msg));
}

/**
 * A closed convex polygon inscribed in `rect`, as the flat float array the
 * lasso paths expect. Real lasso selections are never rectangles, and the
 * rect/lasso paths diverge inside the receiver (`_populateLiftedSelectionFrom
 * Layer` clips to the polygon), so a feed that only ever lifts rectangles
 * leaves half of Select untested.
 */
export function makeLassoPath(rect, points = 7, rng = Math.random) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const path = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    // Jitter the radius so the polygon is irregular but stays convex-ish.
    const r = 0.65 + rng() * 0.35;
    path.push(cx + Math.cos(a) * (rect.width / 2) * r);
    path.push(cy + Math.sin(a) * (rect.height / 2) * r);
  }
  return path;
}

/**
 * Send an UNDO message for the current user.
 */
export function sendUndo(socket, u) {
  socket.sendBinary(buildMsg({ t: T.UNDO, u }));
}

/**
 * Send a REDO message for the current user.
 *
 * No k6 feed has ever sent one. That left the whole redo half of the history
 * model unreachable from bot traffic: the redo stack only ever grew, so
 * `pending_redo` state was tested by the scripted suites alone and never under
 * concurrent load, and a redo racing another user's commit had no coverage.
 */
export function sendRedo(socket, u) {
  socket.sendBinary(buildMsg({ t: T.REDO, u }));
}

// ─── Parser for incoming binary frames (used by latency tracking) ──────────

/**
 * Minimal Protobuf parser that pulls out t/u/stroke_ts from incoming frames.
 * Mirrors the inline parser the original stress tests used.
 *
 * @returns {{ t: number, u: number, ts: number }}
 */
export function parseInbound(data) {
  const view = new Uint8Array(data);
  let t = 0; let u = -1; let ts = -1;
  let offset = 0;
  while (offset < view.length) {
    let tag = 0; let shift = 0;
    while (true) {
      if (offset >= view.length) break;
      const b = view[offset++];
      tag += (b & 0x7F) * Math.pow(2, shift);
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (fieldNum === 1) {
      let val = 0; let s = 0;
      while (true) { const b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
      t = val;
    } else if (fieldNum === 2) {
      let val = 0; let s = 0;
      while (true) { const b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
      u = val;
    } else if (fieldNum === 46) {
      let val = 0; let s = 0;
      while (true) { const b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
      ts = val;
    } else {
      if (wireType === 0) { while (view[offset++] & 0x80); }
      else if (wireType === 1) { offset += 8; }
      else if (wireType === 2) {
        let len = 0; let s = 0;
        while (true) { const b = view[offset++]; len += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
        offset += len;
      }
      else if (wireType === 5) { offset += 4; }
    }
  }
  return { t, u, ts };
}
