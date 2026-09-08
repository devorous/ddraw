/**
 * @fileoverview K6 stress test with sporadic, staggered drawing — unlike
 * medium_stress_test.js (which idles only 120-360ms between multi-stroke
 * batches, so a VU is drawing nearly all the time) or idle_users_test.js
 * (a fixed split: some VUs draw continuously for the whole run, the rest
 * never draw at all), each VU here independently alternates between a real
 * IDLE period (socket open, nothing sent — present but not drawing) and an
 * ACTIVE period (drawing continuously, reusing medium_stress_test.js's
 * tool/stroke state machine) on its own randomized, staggered schedule.
 *
 * The point: "N k6 VUs" should not mean "N people drawing at once, every
 * second of the run." Real rooms have people drawing in bursts that mostly
 * don't line up — this is for judging a fix (e.g. an adaptive remote-preview
 * interval) against THAT shape of load, not the worst-case "everyone hammers
 * simultaneously the whole time" the other scripts default to.
 *
 * Usage matches the other scripts — ROOM/TARGET_URL/TOOLS env vars, --vus,
 * --duration:
 *   k6 run -e ROOM=x -e TARGET_URL=ws://127.0.0.1:8030 --vus=6 --duration=90s \
 *     testing/sporadic_stress_test.js
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { buildMsg } from './_k6_proto.js';
import {
  T, Tool, ALL_TOOLS, TEXT_PHRASES, FONTS, BLEND_MODES,
  pick, randInt, randColor, isFillTargetTool,
  configureTool, sendMove, sendDown, sendUp,
  applyTextWithFont, applyFloodFill, setBlendMode,
  performSelectionTransform, sendUndo, parseInbound,
} from './_k6_actions.js';

const broadcastLatency = new Trend('broadcast_latency_sporadic');

export const options = {
  vus: 6,
  duration: '90s',
};

// How long a VU stays in each phase. Wide enough that overlap between VUs is
// the exception, not the rule, at typical VU counts (6-8) — with independent
// random phase lengths and a randomized starting offset into the first phase,
// bots drift in and out of sync rather than lining up.
const ACTIVE_MS = [5000, 18000];
const IDLE_MS = [8000, 30000];

const SPECIAL_ACTIONS = ['blendSwap', 'selectionTransform', 'floodFill', 'undo'];
const SPECIAL_CHANCE = 0.18;

const STROKE_LENGTH = [25, 100];
const STROKE_COUNT = [2, 7];

function isStrokeTool(tool) {
  return tool !== Tool.TEXT && tool !== Tool.SELECT &&
         tool !== Tool.FLOODFILL && tool !== Tool.INKDROPPER;
}

const TOOL_POOL = (() => {
  const raw = (__ENV.TOOLS || '').trim();
  if (!raw) return ALL_TOOLS;
  const wanted = raw.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  const picked = [];
  for (const name of wanted) {
    if (Tool[name] === undefined) throw new Error(`TOOLS: unknown tool "${name}"`);
    picked.push(Tool[name]);
  }
  return picked;
})();

function randBetween([lo, hi]) {
  return lo + Math.random() * (hi - lo);
}

export default function () {
  sleep(Math.random() * 3);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `SPORADIC_VU_${__VU}` }));

      const BOARD_WIDTH = Number(__ENV.BOARD_W || 1920);
      const BOARD_HEIGHT = Number(__ENV.BOARD_H || 1080);
      const REGION_SIZE = Number(__ENV.REGION_SIZE || 350), margin = 100;

      const homeX = Math.random() * (BOARD_WIDTH - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;
      const homeY = Math.random() * (BOARD_HEIGHT - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;

      let x = homeX, y = homeY, dx = 0, dy = 0;
      let drawState = 0; // 0=deciding next stroke, 1=configuring, 2=mid-stroke
      let stateTicks = 0, cycleLength = 0;
      let currentTool = Tool.BRUSH;
      let strokesRemaining = 0;
      const drawnPoints = [];
      function recordDrawn(px, py) {
        drawnPoints.push({ x: px, y: py });
        if (drawnPoints.length > 64) drawnPoints.shift();
      }
      function pickDrawnPoint() {
        return drawnPoints.length ? drawnPoints[Math.floor(Math.random() * drawnPoints.length)] : null;
      }

      // Independent phase schedule per VU. Starting phase and starting offset
      // are both randomized so VUs don't all flip together even though every
      // VU's script starts at roughly the same wall-clock time.
      let phase = Math.random() < 0.5 ? 'active' : 'idle';
      let phaseDurationMs = randBetween(phase === 'active' ? ACTIVE_MS : IDLE_MS);
      // Start already partway into the phase (0-90% through it), rather than
      // every VU beginning a fresh phase at t=0.
      let phaseElapsedMs = Math.random() * phaseDurationMs * 0.9;
      let lastTickAt = Date.now();

      function endStrokeIfActive() {
        if (drawState === 2) {
          try { sendUp(socket, sessionIndex); } catch (_) {}
        }
        drawState = 0;
        stateTicks = 0;
      }

      socket.setInterval(function () {
        if (sessionIndex === -1) return;

        const now = Date.now();
        phaseElapsedMs += now - lastTickAt;
        lastTickAt = now;

        if (phaseElapsedMs >= phaseDurationMs) {
          if (phase === 'active') endStrokeIfActive();
          phase = phase === 'active' ? 'idle' : 'active';
          phaseDurationMs = randBetween(phase === 'active' ? ACTIVE_MS : IDLE_MS);
          phaseElapsedMs = 0;
        }

        // Idle phase: hold the socket open, send nothing — a present-but-not-
        // drawing user, the case the other stress scripts don't model.
        if (phase === 'idle') return;

        // Below is medium_stress_test.js's per-tick drawing state machine,
        // unchanged, just gated to only run during an 'active' phase.
        if (drawState === 0) {
          if (Math.random() < SPECIAL_CHANCE) {
            const action = pick(SPECIAL_ACTIONS);
            try {
              if (action === 'blendSwap') {
                setBlendMode(socket, sessionIndex, pick(BLEND_MODES));
              } else if (action === 'selectionTransform') {
                performSelectionTransform(socket, sessionIndex, {
                  rect: {
                    x: homeX - REGION_SIZE / 4,
                    y: homeY - REGION_SIZE / 4,
                    width: REGION_SIZE / 2,
                    height: REGION_SIZE / 2,
                  },
                });
              } else if (action === 'floodFill') {
                const target = pickDrawnPoint();
                if (target) applyFloodFill(socket, sessionIndex, target.x, target.y, randColor());
              } else if (action === 'undo') {
                sendUndo(socket, sessionIndex);
              }
            } catch (_) {}
            return;
          }

          strokesRemaining = randInt(STROKE_COUNT[0], STROKE_COUNT[1]);
          currentTool = pick(TOOL_POOL);

          configureTool(socket, sessionIndex, currentTool, {
            color: randColor(),
            size: randInt(500, 3000),
          });

          const targetX = homeX + (Math.random() - 0.5) * REGION_SIZE;
          const targetY = homeY + (Math.random() - 0.5) * REGION_SIZE;
          x = Math.max(margin, Math.min(BOARD_WIDTH - margin, targetX));
          y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, targetY));

          sendMove(socket, sessionIndex, x, y);
          drawState = 1;
        }
        else if (drawState === 1) {
          if (currentTool === Tool.TEXT) {
            applyTextWithFont(socket, sessionIndex, x, y, pick(TEXT_PHRASES), pick(FONTS));
            strokesRemaining--;
            drawState = 0;
          } else if (currentTool === Tool.SELECT) {
            performSelectionTransform(socket, sessionIndex, {
              rect: { x: x - 80, y: y - 80, width: 160, height: 160 },
            });
            strokesRemaining--;
            drawState = 0;
          } else if (currentTool === Tool.FLOODFILL) {
            const target = pickDrawnPoint();
            if (target) applyFloodFill(socket, sessionIndex, target.x, target.y, randColor());
            strokesRemaining--;
            drawState = 0;
          } else if (currentTool === Tool.INKDROPPER) {
            strokesRemaining--;
            drawState = 0;
          } else if (isStrokeTool(currentTool)) {
            sendDown(socket, sessionIndex, x, y);
            cycleLength = randInt(STROKE_LENGTH[0], STROKE_LENGTH[1]);
            drawState = 2;
            stateTicks = 0;
            dx = (Math.random() - 0.5) * 8;
            dy = (Math.random() - 0.5) * 8;
          } else {
            strokesRemaining--;
            drawState = 0;
          }
        }
        else if (drawState === 2) {
          stateTicks++;
          if (stateTicks < cycleLength) {
            dx += (Math.random() - 0.5) * 3;
            dy += (Math.random() - 0.5) * 3;
            dx = Math.max(-12, Math.min(12, dx));
            dy = Math.max(-12, Math.min(12, dy));
            x += dx; y += dy;

            const distFromHome = Math.sqrt((x - homeX) ** 2 + (y - homeY) ** 2);
            if (distFromHome > REGION_SIZE / 2) {
              dx *= -0.5; dy *= -0.5;
              x += (homeX - x) * 0.1;
              y += (homeY - y) * 0.1;
            }
            x = Math.max(margin, Math.min(BOARD_WIDTH - margin, x));
            y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, y));

            sendMove(socket, sessionIndex, x, y, true);
            if (isFillTargetTool(currentTool)) recordDrawn(x, y);
          } else {
            sendUp(socket, sessionIndex);
            strokesRemaining--;
            drawState = 0;
          }
        }
      }, 12);
    });

    socket.on('binaryMessage', function (data) {
      const { t, u, ts } = parseInbound(data);
      if (t === 0 && u !== -1 && sessionIndex === -1) sessionIndex = u;
      if (ts !== -1 && u !== sessionIndex) broadcastLatency.add(Date.now() - ts);
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    socket.setTimeout(() => socket.close(), 115000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
