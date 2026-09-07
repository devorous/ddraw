/**
 * @fileoverview K6 feed for the undo-depth memory question: what does raising
 * LayerManager.MAX_STROKES_PER_USER cost an observer's memory, given a room
 * full of many SMALL strokes and occasional large undo bursts?
 *
 * Unlike low_stress_test.js (full tool/protocol coverage), this feed is
 * narrowed on purpose: brush only, short strokes, high stroke RATE, so the
 * live strokeStack actually fills toward whatever MAX_STROKES_PER_USER is set
 * to on the observer, and bursts of undo actually drain a meaningful chunk of
 * it. MAX_STROKES_PER_USER itself is NOT set here — it's a client-side static
 * (`LayerManager.MAX_STROKES_PER_USER`), so override it on the OBSERVER via
 * console/CDP before joining: `window.app.board.layerManager.constructor.MAX_STROKES_PER_USER = N`.
 *
 * Env knobs:
 *   VUS=3                 bot count (pass via --vus, this is just the default)
 *   STROKE_PTS=4,12       point-count range per stroke (small = many bakeable
 *                         strokes fast, matching the "many smaller strokes" ask)
 *   STROKES_BETWEEN_UNDOS=20,50   idle-tick range of strokes drawn before a burst
 *   UNDO_BURST=10,60      how many undos fire back-to-back in one burst
 *   REDO_AFTER_CHANCE=0.3 chance the burst is followed by redoing it all back
 *   ROOM, TARGET_URL, BOARD_W, BOARD_H as usual
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { buildMsg } from './_k6_proto.js';
import {
  T, Tool, randColor, configureTool, sendMove, sendMoveBatch,
  sendDown, sendUp, sendUndo, sendRedo, parseInbound,
} from './_k6_actions.js';

export const options = {
  vus: Number(__ENV.VUS || 3),
  duration: __ENV.DURATION || '3m',
};

const [PTS_MIN, PTS_MAX] = String(__ENV.STROKE_PTS || '4,12').split(',').map(Number);
const [BETWEEN_MIN, BETWEEN_MAX] = String(__ENV.STROKES_BETWEEN_UNDOS || '20,50').split(',').map(Number);
const [BURST_MIN, BURST_MAX] = String(__ENV.UNDO_BURST || '10,60').split(',').map(Number);
const REDO_AFTER_CHANCE = Number(__ENV.REDO_AFTER_CHANCE ?? 0.3);
// Fraction of strokes drawn with the eraser (blendMode destination-out) instead
// of the brush — lets this feed answer "what does compositing hundreds of
// erase-blend strokes on top of paint actually cost", not just paint volume.
const ERASE_CHANCE = Number(__ENV.ERASE_CHANCE ?? 0);

function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function () {
  const BASE_SEED = Number(__ENV.SEED || 0x5eed);
  const rng = makeRng(BASE_SEED + __VU * 7919);
  const rint = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const rcolor = () => randColor(rng);

  sleep(rng() * 2);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `UNDO_VU_${__VU}` }));

      const BOARD_WIDTH = Number(__ENV.BOARD_W || 1920);
      const BOARD_HEIGHT = Number(__ENV.BOARD_H || 1080);
      const REGION_SIZE = Number(__ENV.REGION_SIZE || 400), margin = 100;

      const homeX = rng() * (BOARD_WIDTH - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;
      const homeY = rng() * (BOARD_HEIGHT - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;

      let x = homeX, y = homeY;
      let state = 0; // 0=idle, 1=ready-to-stroke, 2=drawing
      let stateTicks = 0, cycleLength = 0;
      let strokesDrawn = 0;
      let strokesUntilBurst = rint(BETWEEN_MIN, BETWEEN_MAX);
      let undoneCount = 0;      // how many strokes the current burst has undone
      let burstRemaining = 0;   // undos left to fire in the current burst
      let redoRemaining = 0;    // redos left to fire, mirroring a completed burst
      let configured = false;
      let currentTool = Tool.BRUSH;

      socket.setInterval(function () {
        if (sessionIndex === -1) return;
        if (!configured) {
          configured = true;
          configureTool(socket, sessionIndex, currentTool, {
            rng, color: rcolor(), size: rint(300, 900), activeLayer: 0,
          });
          return;
        }

        // Drain a pending undo/redo burst before doing anything else — a real
        // user mashing ctrl+Z doesn't also keep drawing mid-mash.
        if (burstRemaining > 0) {
          sendUndo(socket, sessionIndex);
          burstRemaining--;
          undoneCount++;
          if (burstRemaining === 0 && rng() < REDO_AFTER_CHANCE) {
            redoRemaining = undoneCount;
          }
          return;
        }
        if (redoRemaining > 0) {
          sendRedo(socket, sessionIndex);
          redoRemaining--;
          return;
        }

        if (state === 0) {
          if (strokesDrawn >= strokesUntilBurst) {
            strokesDrawn = 0;
            undoneCount = 0;
            strokesUntilBurst = rint(BETWEEN_MIN, BETWEEN_MAX);
            burstRemaining = rint(BURST_MIN, BURST_MAX);
            return;
          }
          const wantTool = rng() < ERASE_CHANCE ? Tool.ERASE : Tool.BRUSH;
          if (wantTool !== currentTool) {
            currentTool = wantTool;
            configureTool(socket, sessionIndex, currentTool, {
              rng, color: rcolor(), size: rint(300, 900), activeLayer: 0,
            });
          }
          const targetX = homeX + (rng() - 0.5) * REGION_SIZE;
          const targetY = homeY + (rng() - 0.5) * REGION_SIZE;
          x = Math.max(margin, Math.min(BOARD_WIDTH - margin, targetX));
          y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, targetY));
          sendMove(socket, sessionIndex, x, y);
          state = 1;
        } else if (state === 1) {
          sendDown(socket, sessionIndex, x, y, { layer: 0, blendMode: 'source-over' });
          cycleLength = rint(PTS_MIN, PTS_MAX);
          stateTicks = 0;
          state = 2;
        } else if (state === 2) {
          stateTicks++;
          if (stateTicks < cycleLength) {
            x += (rng() - 0.5) * 6;
            y += (rng() - 0.5) * 6;
            x = Math.max(margin, Math.min(BOARD_WIDTH - margin, x));
            y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, y));
            sendMoveBatch(socket, sessionIndex, [x, y], null, {});
          } else {
            sendUp(socket, sessionIndex);
            strokesDrawn++;
            state = 0;
          }
        }
      }, 16); // ~60 TPS, one small stroke commits every few ticks
    });

    socket.on('binaryMessage', function (data) {
      const { t, u } = parseInbound(data);
      if (t === 0 && u !== -1 && sessionIndex === -1) sessionIndex = u;
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    socket.setTimeout(() => socket.close(), 175000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
