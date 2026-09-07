#!/usr/bin/env node
/**
 * @fileoverview Live IP-moderation suite — proves the server *enforces* the
 * ranges `server/ipIdentity.js` computes, for both IPv4 and IPv6.
 *
 * Every "user" here is a `SpoofBot`: a headless protobuf client that presents
 * an arbitrary source address via `X-Forwarded-For` (see testing/lib/spoofBot.mjs
 * for why that reaches `ws.clientIp` unmodified). That is what makes these
 * tests possible at all — a browser cannot set that header, so the existing
 * Puppeteer moderation suite can only ever test moderation against one address.
 *
 * ── What is covered ────────────────────────────────────────────────────────
 *
 *   preflight        the spoof actually reaches the server (see below)
 *   ban/v4 · v6      exact / subnet / wide scope: the right neighbours are
 *                    blocked and the wrong ones are not
 *   mute/v4 · v6     a range mute silences a *different* address in-range
 *   shadowban        applies by IP range without telling the target
 *   unban            revoking clears the whole range, not just the one host
 *   evasion          reconnecting from a neighbouring range escapes a narrow
 *                    ban — and must NOT escape a wide one
 *   canonicalization a ban laid down against one spelling of an address still
 *                    catches a client presenting another (v4-mapped, etc.)
 *   display          moderator-facing IP is masked by role, and ban rows store
 *                    a CIDR range rather than the host that was acted against
 *
 * ── Why the preflight is not optional ──────────────────────────────────────
 *
 * If `X-Forwarded-For` were ignored, every bot would connect as 127.0.0.1.
 * A subnet-ban test would then pass all its "inside the range" cases and fail
 * all its "outside" ones — a result shaped like a real over-broad-ban bug, in a
 * run where no IP logic executed at all. So the suite proves the spoof lands
 * before it trusts anything else, and aborts if it does not.
 *
 * ── Requirements ───────────────────────────────────────────────────────────
 *
 * A LOCAL server + MongoDB. The suite registers accounts, promotes one to
 * DEITY, and writes moderation rows, so it refuses to run against a non-local
 * database (see `assertLocalDatabase`). Bring the stack up with:
 *
 *   npm run dev:reset      # fresh local mongo + minio
 *   npm run server:local   # server on :8030 against that stack
 *
 * Usage:
 *   node testing/moderation/ip_moderation_suite.mjs [--only=ban_v6,evasion] [--trace] [--keep]
 *
 * Env:
 *   SERVER_ORIGIN    backend HTTP origin       (default http://127.0.0.1:8030)
 *   MONGODB_URI      mongo connection string   (default mongodb://127.0.0.1:27017)
 *   MONGODB_DB_NAME  database name             (default Draw)
 *   ALLOW_REMOTE_DB  set to 'i-know-what-im-doing' to bypass the local-DB guard
 */

import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  SpoofBot, registerAccount, verifySpoofVisible, sleep,
  DEFAULT_HTTP_ORIGIN,
} from '../lib/spoofBot.mjs';
import { V4, V6, MEMBERSHIP } from '../lib/ipFixtures.mjs';
import { buildIpIdentity } from '../../server/ipIdentity.js';
import { T } from '../../shared/MessageTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const SERVER_ORIGIN   = process.env.SERVER_ORIGIN || DEFAULT_HTTP_ORIGIN;
const MONGODB_URI     = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'Draw';

const args = process.argv.slice(2);
const TRACE = args.includes('--trace');
const KEEP  = args.includes('--keep');
const ONLY  = (args.find(a => a.startsWith('--only=')) || '').slice(7)
  .split(',').map(s => s.trim()).filter(Boolean);

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const ROOM   = `ipmod_${RUN_ID}`;
// USERNAME_MAX_LENGTH is 20 server-side.
const MOD_USERNAME = `im_${RUN_ID}_m`;
const TEST_PASSWORD = 'Test_Pass_1234!';
const ROLE_DEITY = 9;

const RESULTS_DIR = path.join(__dirname, '..', 'moderation_results');

/** Address the moderator bot itself connects from — never a fixture range, so
 *  a range ban laid down in a test can never accidentally catch the mod. */
const MOD_IP = '192.0.2.200';

// ─── Mongo ─────────────────────────────────────────────────────────────────

let mongoClient = null;
let db = null;

/**
 * Refuses to run against anything but a local database.
 *
 * This suite registers accounts and writes ban rows. Pointed at the production
 * Atlas cluster the repo's `.env` defaults to, it would create real bans
 * against real (spoofed) ranges. The cost of the guard is one string check;
 * the cost of not having it is unbounded.
 */
function assertLocalDatabase(uri) {
  if (process.env.ALLOW_REMOTE_DB === 'i-know-what-im-doing') return;
  const host = uri.replace(/^mongodb(\+srv)?:\/\//, '').split('/')[0].split('@').pop();
  const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  if (!isLocal) {
    throw new Error(
      `Refusing to run against a non-local database (${host}).\n` +
      `  This suite registers users and writes moderation rows.\n` +
      `  Start the local stack with "npm run dev:reset" + "npm run server:local",\n` +
      `  or set ALLOW_REMOTE_DB=i-know-what-im-doing to override.`,
    );
  }
}

async function connectMongo() {
  assertLocalDatabase(MONGODB_URI);
  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB_NAME);
}

async function promote(username, role) {
  const res = await db.collection('users').updateOne(
    { username: { $regex: new RegExp(`^${username}$`, 'i') } },
    { $set: { role } },
  );
  if (res.matchedCount === 0) throw new Error(`cannot promote: "${username}" not found`);
}

/** Removes every moderation row this run created, plus the mod account. */
async function cleanup() {
  await db.collection('users').deleteMany({ username: MOD_USERNAME });
  await db.collection('moderation').deleteMany({
    $or: [{ issuedByUsername: MOD_USERNAME }, { roomId: ROOM }],
  });
}

/** Clears moderation state between tests so cases cannot leak into each other. */
async function clearModerationRows() {
  await db.collection('moderation').deleteMany({
    $or: [{ issuedByUsername: MOD_USERNAME }, { roomId: ROOM }],
  });
}

// ─── Bot helpers ───────────────────────────────────────────────────────────

/** All bots spawned during a test, so the runner can always tear them down. */
let liveBots = [];

/**
 * Joins a fresh guest bot from a given address.
 * @returns {Promise<{bot: SpoofBot, outcome: import('../lib/spoofBot.mjs').JoinOutcome}>}
 */
async function joinGuest(ip, label) {
  const bot = new SpoofBot({ ip, room: ROOM, name: label, label, trace: TRACE });
  liveBots.push(bot);
  const outcome = await bot.join();
  return { bot, outcome };
}

/**
 * Connects from `ip` purely to learn whether the server lets it in, then
 * disconnects. This is the primitive every enforcement assertion is built on.
 * @returns {Promise<{allowed: boolean, closeCode: number|null, error: string}>}
 */
async function probeJoin(ip, label) {
  const bot = new SpoofBot({ ip, room: ROOM, name: label, label, trace: TRACE });
  try {
    const outcome = await bot.join();
    return { allowed: outcome.joined, closeCode: outcome.closeCode, error: outcome.error };
  } finally {
    bot.close();
  }
}

/**
 * Connects from `ip` and reports whether the server treats the connection as
 * muted. Read from the roster rather than by attempting a chat: the roster's
 * `mt` flag is the server's own view, so this works even for a mute applied
 * before the bot ever spoke.
 * @returns {Promise<{joined: boolean, muted: boolean|null, detail: string}>}
 */
async function probeMute(ip, label) {
  const bot = new SpoofBot({ ip, room: ROOM, name: label, label, trace: TRACE });
  try {
    const outcome = await bot.join();
    if (!outcome.joined) {
      return { joined: false, muted: null, detail: `join refused: ${outcome.error}` };
    }
    await bot.refreshRoster();
    const entry = bot.rosterEntry();
    if (!entry) return { joined: true, muted: null, detail: 'no roster entry for self' };
    return { joined: true, muted: !!entry.mt, detail: `roster mt=${!!entry.mt}` };
  } finally {
    bot.close();
  }
}

/** Waits for the mod's MOD_RESULT ack so the DB write has definitely landed. */
async function awaitModAck(modBot, from) {
  const ack = await modBot.waitFor(m => m.t === T.MOD_RESULT, { timeoutMs: 6000, from });
  if (!ack) return { ok: false, error: 'no MOD_RESULT within 6s' };
  if (ack.a === false) return { ok: false, error: ack.authError || 'action rejected' };
  return { ok: true, error: '' };
}

/**
 * Has the moderator act against a target, and blocks until the server acks.
 * @returns {Promise<{ok: boolean, error: string}>}
 */
async function moderate(modBot, { type, target, ipScope, reason = 'ip suite', duration = 0, targetName = null }) {
  const from = modBot.mark();
  modBot.modAction({ type, target, ipScope, reason, duration, targetName });
  return awaitModAck(modBot, from);
}

// Action codes — must match MOD_ACTION_MAP in server/index.js.
const MOD = { KICK: 0, MUTE: 1, BAN: 2, UNMUTE: 3, UNBAN: 4, UPDATE: 5, SHADOWBAN: 6, UNSHADOWBAN: 7 };

// ─── Test cases ────────────────────────────────────────────────────────────

/**
 * Each case returns { pass, detail, checks: [{name, pass, detail}] }. The
 * per-check breakdown matters here: "the /64 ban worked" is far less useful
 * than "it caught 3 of 3 in-range addresses and leaked 1 of 4 out-of-range
 * ones", which points straight at over- vs under-matching.
 */

function summarize(checks) {
  const failed = checks.filter(c => !c.pass);
  return {
    pass: failed.length === 0,
    detail: failed.length
      ? `${failed.length}/${checks.length} failed — ${failed.map(f => f.name).join(', ')}`
      : `${checks.length}/${checks.length} passed`,
    checks,
  };
}

/**
 * Verifies the spoof reaches the server at all, in both families, and that two
 * bots on different addresses are seen as different addresses.
 */
async function testPreflight(ctx) {
  const checks = [];
  const { modBot } = ctx;

  for (const [family, ip] of [['ipv4', V4.base], ['ipv6', V6.base]]) {
    const { bot, outcome } = await joinGuest(ip, `pre_${family}`);
    if (!outcome.joined) {
      checks.push({ name: `${family} join`, pass: false, detail: outcome.error });
      continue;
    }
    const expected = buildIpIdentity(ip).canonicalIp;
    const seen = await verifySpoofVisible({ viewer: modBot, target: bot, expectedIp: expected });
    checks.push({ name: `${family} spoof visible`, pass: seen.ok, detail: seen.detail });
    bot.close();
    await sleep(150);
  }

  // Two bots must not collapse onto one address — the failure mode that would
  // make every later range assertion vacuous.
  const a = await joinGuest(V4.base, 'pre_a');
  const b = await joinGuest(V4.unrelated, 'pre_b');
  if (a.outcome.joined && b.outcome.joined) {
    await modBot.refreshRoster();
    const ipA = modBot.rosterEntry(a.bot.sessionIndex)?.vip || '';
    const ipB = modBot.rosterEntry(b.bot.sessionIndex)?.vip || '';
    checks.push({
      name: 'distinct bots have distinct addresses',
      pass: !!ipA && !!ipB && ipA !== ipB,
      detail: `bot A=${ipA || '(none)'} bot B=${ipB || '(none)'}`,
    });
  } else {
    checks.push({ name: 'distinct bots have distinct addresses', pass: false, detail: 'join failed' });
  }
  a.bot.close();
  b.bot.close();

  return summarize(checks);
}

/**
 * Bans a target at each scope and probes the membership table: everything
 * `inside` must be refused, everything `outside` must still get in.
 * @param {'ipv4'|'ipv6'} family
 */
function makeBanScopeTest(family) {
  return async function testBanScope(ctx) {
    const { modBot } = ctx;
    const table = MEMBERSHIP[family];
    const checks = [];

    for (const scope of ['exact', 'subnet', 'wide']) {
      await clearModerationRows();

      // The target must be present for the moderator to act on it: the ban is
      // taken against a live session's IP, exactly as a real moderator would.
      const { bot: target, outcome } = await joinGuest(table.base, `tgt_${family}_${scope}`);
      if (!outcome.joined) {
        checks.push({ name: `${scope}: target join`, pass: false, detail: outcome.error });
        continue;
      }

      const acted = await moderate(modBot, {
        type: MOD.BAN, target: target.sessionIndex, ipScope: scope,
        reason: `ip-suite ${family} ${scope}`,
      });
      if (!acted.ok) {
        checks.push({ name: `${scope}: ban issued`, pass: false, detail: acted.error });
        target.close();
        continue;
      }

      // The ban closes the target's own socket first — that is the immediate,
      // visible half of enforcement.
      const closed = await target.waitForClose(5000);
      checks.push({
        name: `${scope}: target disconnected with 4001`,
        pass: closed?.code === 4001,
        detail: closed ? `close ${closed.code} ${closed.reason}` : 'socket stayed open',
      });
      target.close();

      // The stored row must describe a range, not the host.
      const row = await db.collection('moderation').findOne({ type: 'ban', active: true });
      checks.push({
        name: `${scope}: row stores a range, not the raw ip`,
        pass: !!row && row.targetIp === null && Array.isArray(row.targetIpKeys) && row.targetIpKeys.length > 0,
        detail: row
          ? `targetIp=${row.targetIp} scope=${row.targetIpScope} display=${row.targetIpDisplay}`
          : 'no active ban row',
      });

      for (const ip of table[scope].inside) {
        const probe = await probeJoin(ip, `in_${scope}`);
        checks.push({
          name: `${scope}: blocks ${ip}`,
          pass: !probe.allowed,
          detail: probe.allowed ? 'JOINED — ban did not reach this address' : `refused (${probe.closeCode})`,
        });
      }
      for (const ip of table[scope].outside) {
        const probe = await probeJoin(ip, `out_${scope}`);
        checks.push({
          name: `${scope}: allows ${ip}`,
          pass: probe.allowed,
          detail: probe.allowed ? 'joined' : `REFUSED (${probe.closeCode}) — ban is over-broad`,
        });
      }
    }

    await clearModerationRows();
    return summarize(checks);
  };
}

/**
 * A subnet mute must silence a *different* address inside the range — the
 * point being that the mute is carried by the range, not by the session.
 * @param {'ipv4'|'ipv6'} family
 */
function makeMuteScopeTest(family) {
  return async function testMuteScope(ctx) {
    const { modBot } = ctx;
    const fixtures = family === 'ipv4' ? V4 : V6;
    const checks = [];

    await clearModerationRows();

    const { bot: target, outcome } = await joinGuest(fixtures.base, `mute_tgt_${family}`);
    if (!outcome.joined) return summarize([{ name: 'target join', pass: false, detail: outcome.error }]);

    const acted = await moderate(modBot, {
      type: MOD.MUTE, target: target.sessionIndex, ipScope: 'subnet', reason: 'ip-suite mute',
    });
    checks.push({ name: 'mute issued', pass: acted.ok, detail: acted.error || 'ok' });

    if (acted.ok) {
      // The live session is muted immediately...
      await target.refreshRoster();
      checks.push({
        name: 'live target is muted',
        pass: !!target.rosterEntry()?.mt,
        detail: `roster mt=${!!target.rosterEntry()?.mt}`,
      });

      // ...and a neighbour inside the same range picks it up on a fresh join,
      // which is the part that can only work if the range was stored.
      const neighbour = await probeMute(fixtures.sameSubnet, `mute_near_${family}`);
      checks.push({
        name: `same-range address ${fixtures.sameSubnet} joins muted`,
        pass: neighbour.joined && neighbour.muted === true,
        detail: neighbour.detail,
      });

      // An address outside the range must be unaffected.
      const outsideIp = family === 'ipv4' ? V4.neighborSubnet : V6.sameWide;
      const outside = await probeMute(outsideIp, `mute_far_${family}`);
      checks.push({
        name: `out-of-range address ${outsideIp} joins unmuted`,
        pass: outside.joined && outside.muted === false,
        detail: outside.detail,
      });
    }

    target.close();
    await clearModerationRows();
    return summarize(checks);
  };
}

/**
 * Unbanning must revoke the whole range. A revoke that only cleared the exact
 * host would leave the rest of the subnet locked out with no visible row —
 * the worst kind of moderation bug, because the mod panel would look clean.
 */
async function testUnbanClearsRange(ctx) {
  const { modBot } = ctx;
  const checks = [];
  await clearModerationRows();

  const { bot: target, outcome } = await joinGuest(V6.base, 'unban_tgt');
  if (!outcome.joined) return summarize([{ name: 'target join', pass: false, detail: outcome.error }]);
  const targetSession = target.sessionIndex;
  const targetName = target.username;

  const banned = await moderate(modBot, {
    type: MOD.BAN, target: targetSession, ipScope: 'wide', reason: 'ip-suite unban',
  });
  checks.push({ name: 'wide ban issued', pass: banned.ok, detail: banned.error || 'ok' });
  await target.waitForClose(4000);
  target.close();

  const blocked = await probeJoin(V6.sameWide, 'unban_probe_pre');
  checks.push({
    name: 'sibling /64 is blocked while banned',
    pass: !blocked.allowed,
    detail: blocked.allowed ? 'joined despite the /48 ban' : `refused (${blocked.closeCode})`,
  });

  // Unban targets the now-departed session; the server resolves it from its
  // recent-session cache (the same path the mod panel's Unban button uses).
  const unbanned = await moderate(modBot, {
    type: MOD.UNBAN, target: targetSession, targetName, reason: '',
  });
  checks.push({ name: 'unban acked', pass: unbanned.ok, detail: unbanned.error || 'ok' });

  const remaining = await db.collection('moderation').countDocuments({ type: 'ban', active: true });
  checks.push({
    name: 'no active ban rows remain',
    pass: remaining === 0,
    detail: `${remaining} active ban row(s)`,
  });

  for (const ip of [V6.base, V6.sameSubnet, V6.sameWide]) {
    const probe = await probeJoin(ip, 'unban_probe_post');
    checks.push({
      name: `${ip} can rejoin after unban`,
      pass: probe.allowed,
      detail: probe.allowed ? 'joined' : `still refused (${probe.closeCode})`,
    });
  }

  await clearModerationRows();
  return summarize(checks);
}

/**
 * The evasion story end to end: a narrow ban is escapable by moving one subnet
 * over (that is by design, and worth stating explicitly), and widening the
 * scope closes exactly that door.
 */
async function testEvasion(ctx) {
  const { modBot } = ctx;
  const checks = [];

  // ── Narrow ban, then hop to a neighbouring /64.
  await clearModerationRows();
  const first = await joinGuest(V6.base, 'evade_a');
  if (!first.outcome.joined) return summarize([{ name: 'target join', pass: false, detail: first.outcome.error }]);

  const narrow = await moderate(modBot, {
    type: MOD.BAN, target: first.bot.sessionIndex, ipScope: 'subnet', reason: 'ip-suite evasion narrow',
  });
  checks.push({ name: 'subnet ban issued', pass: narrow.ok, detail: narrow.error || 'ok' });
  await first.bot.waitForClose(4000);
  first.bot.close();

  const hopped = await probeJoin(V6.sameWide, 'evade_hop');
  checks.push({
    name: 'a /64 ban is escapable from a sibling /64 (documented behaviour)',
    pass: hopped.allowed,
    detail: hopped.allowed
      ? 'sibling /64 got in, as a /64-scoped ban implies'
      : `sibling /64 was refused (${hopped.closeCode}) — the ban is wider than /64`,
  });

  // ── Same evader, wide ban: the hop must now fail.
  await clearModerationRows();
  const second = await joinGuest(V6.base, 'evade_b');
  if (!second.outcome.joined) {
    checks.push({ name: 're-join for wide ban', pass: false, detail: second.outcome.error });
    return summarize(checks);
  }
  const wide = await moderate(modBot, {
    type: MOD.BAN, target: second.bot.sessionIndex, ipScope: 'wide', reason: 'ip-suite evasion wide',
  });
  checks.push({ name: 'wide ban issued', pass: wide.ok, detail: wide.error || 'ok' });
  await second.bot.waitForClose(4000);
  second.bot.close();

  const blockedHop = await probeJoin(V6.sameWide, 'evade_hop2');
  checks.push({
    name: 'a /48 ban closes the sibling-/64 hop',
    pass: !blockedHop.allowed,
    detail: blockedHop.allowed ? 'sibling /64 still got in — /48 scope not enforced' : `refused (${blockedHop.closeCode})`,
  });

  // A different /48 must still be reachable, or the ban is global by accident.
  const farHop = await probeJoin(V6.neighborWide, 'evade_far');
  checks.push({
    name: 'a /48 ban does not spill into the neighbouring /48',
    pass: farHop.allowed,
    detail: farHop.allowed ? 'joined' : `REFUSED (${farHop.closeCode}) — over-broad`,
  });

  await clearModerationRows();
  return summarize(checks);
}

/**
 * A ban laid down while a client presented one spelling of its address must
 * still catch that client when it reconnects presenting another. Proxies and
 * dual-stack sockets change the spelling (`203.0.113.10` vs
 * `::ffff:203.0.113.10`) without changing the host, so a mismatch here is a
 * silent expiry of every ban on a dual-stack deployment.
 */
async function testCanonicalizationEnforced(ctx) {
  const { modBot } = ctx;
  const checks = [];
  await clearModerationRows();

  const { bot: target, outcome } = await joinGuest(V4.base, 'canon_tgt');
  if (!outcome.joined) return summarize([{ name: 'target join', pass: false, detail: outcome.error }]);

  const acted = await moderate(modBot, {
    type: MOD.BAN, target: target.sessionIndex, ipScope: 'exact', reason: 'ip-suite canonical',
  });
  checks.push({ name: 'exact ban issued on plain ipv4', pass: acted.ok, detail: acted.error || 'ok' });
  await target.waitForClose(4000);
  target.close();

  for (const spelling of ['::ffff:203.0.113.10', '::FFFF:203.0.113.10']) {
    const probe = await probeJoin(spelling, 'canon_probe');
    checks.push({
      name: `ban still catches "${spelling}"`,
      pass: !probe.allowed,
      detail: probe.allowed ? 'JOINED — the ban expired on a re-spelled address' : `refused (${probe.closeCode})`,
    });
  }

  await clearModerationRows();
  return summarize(checks);
}

/**
 * Shadowban is the one action whose whole value is that the target cannot tell.
 *
 * There is no `shadowbanned` flag on the wire to assert against — by design.
 * The server enforces it by *omitting* the user from everyone else's roster
 * (`isShadowHiddenFromViewer`, which hides them from moderators too) while
 * leaving them visible to themselves. So the oracle is a third party's view:
 * an observer must stop seeing the shadowbanned session, the shadowbanned bot
 * must still see itself, and a control bot outside the banned range must stay
 * visible throughout — otherwise "invisible" would just mean "never joined".
 */
async function testShadowbanByRange(ctx) {
  const { modBot } = ctx;
  const checks = [];
  await clearModerationRows();

  // An ordinary observer on an unrelated address — the honest third-party view.
  const observer = await joinGuest(V4.unrelatedAlt, 'shadow_obs');
  if (!observer.outcome.joined) {
    return summarize([{ name: 'observer join', pass: false, detail: observer.outcome.error }]);
  }

  const { bot: target, outcome } = await joinGuest(V4.base, 'shadow_tgt');
  if (!outcome.joined) return summarize([{ name: 'target join', pass: false, detail: outcome.error }]);

  await observer.bot.refreshRoster();
  checks.push({
    name: 'observer sees the target before the shadowban',
    pass: !!observer.bot.rosterEntry(target.sessionIndex),
    detail: `roster sessions: ${(observer.bot.lastUsers?.us || []).map(u => u.u).join(', ')}`,
  });

  const acted = await moderate(modBot, {
    type: MOD.SHADOWBAN, target: target.sessionIndex, ipScope: 'subnet', reason: 'ip-suite shadow',
  });
  checks.push({ name: 'shadowban issued', pass: acted.ok, detail: acted.error || 'ok' });

  if (acted.ok) {
    const row = await db.collection('moderation').findOne({ type: 'shadowban', active: true });
    checks.push({
      name: 'shadowban row stores a hashed range',
      pass: !!row && row.targetIp === null && (row.targetIpKeys?.length || 0) > 0,
      detail: row ? `scope=${row.targetIpScope} display=${row.targetIpDisplay}` : 'no row',
    });

    // The target's socket must stay up: a disconnect would give the game away.
    await sleep(400);
    checks.push({
      name: 'target is not disconnected',
      pass: target.connected,
      detail: target.connected ? 'still connected' : `closed ${target.closeInfo?.code}`,
    });

    await observer.bot.refreshRoster();
    checks.push({
      name: 'observer stops seeing the shadowbanned target',
      pass: !observer.bot.rosterEntry(target.sessionIndex),
      detail: `roster sessions: ${(observer.bot.lastUsers?.us || []).map(u => u.u).join(', ')}`,
    });

    await target.refreshRoster();
    checks.push({
      name: 'the target still sees itself (so it cannot tell)',
      pass: !!target.rosterEntry(),
      detail: `self session ${target.sessionIndex} in own roster: ${!!target.rosterEntry()}`,
    });

    // The range half: a *different* address in the same /24 must inherit the
    // shadowban on a fresh join, which can only work if the /24 was stored.
    const neighbour = new SpoofBot({ ip: V4.sameSubnet, room: ROOM, name: 'shadow_near', label: 'shadow_near', trace: TRACE });
    liveBots.push(neighbour);
    const nOutcome = await neighbour.join();
    if (nOutcome.joined) {
      await observer.bot.refreshRoster();
      checks.push({
        name: `same-/24 address ${V4.sameSubnet} is shadowbanned on join`,
        pass: !observer.bot.rosterEntry(neighbour.sessionIndex),
        detail: observer.bot.rosterEntry(neighbour.sessionIndex)
          ? 'observer can see the neighbour — the range was not applied'
          : 'invisible to the observer',
      });
    } else {
      checks.push({
        name: `same-/24 address ${V4.sameSubnet} is shadowbanned on join`,
        pass: false,
        detail: `join refused: ${nOutcome.error} — a shadowban must never block the join`,
      });
    }
    neighbour.close();

    // Control: an address outside the /24 must stay plainly visible, or
    // "invisible" above proves nothing about the range.
    const control = new SpoofBot({ ip: V4.neighborSubnet, room: ROOM, name: 'shadow_ctl', label: 'shadow_ctl', trace: TRACE });
    liveBots.push(control);
    const cOutcome = await control.join();
    if (cOutcome.joined) {
      await observer.bot.refreshRoster();
      checks.push({
        name: `out-of-range address ${V4.neighborSubnet} stays visible`,
        pass: !!observer.bot.rosterEntry(control.sessionIndex),
        detail: observer.bot.rosterEntry(control.sessionIndex)
          ? 'visible to the observer'
          : 'invisible — the shadowban spilled outside its /24',
      });
    } else {
      checks.push({ name: `out-of-range address ${V4.neighborSubnet} stays visible`, pass: false, detail: `join refused: ${cOutcome.error}` });
    }
    control.close();
  }

  target.close();
  observer.bot.close();
  await clearModerationRows();
  return summarize(checks);
}

// ─── Message-gating probes ─────────────────────────────────────────────────

/**
 * Representative, wire-accurate messages for each type a sanctioned user might
 * try to push. Payloads mirror what `WebSocketClient` actually sends, because a
 * message the server drops as malformed would look exactly like a message the
 * server deliberately blocked.
 *
 * `board` marks the ones that change what other people see on the canvas —
 * those are the ones a mute MUST stop. The rest are presence/tool state, kept
 * in the table as a control: if a mute blocked those too the gate would be
 * over-broad, and if the control types stop arriving the harness itself is
 * broken.
 */
/** A 1x1 transparent PNG — the smallest payload `validateDataUrlImage` accepts. */
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const GATING_PROBES = [
  // — board-mutating —
  { name: 'MD (stroke start)', t: T.MD, board: true, send: (b) => b.send({ t: T.MD, ps: [100, 100], ly: 0 }) },
  { name: 'MM (stroke move)',  t: T.MM, board: true, send: (b) => b.send({ t: T.MM, ps: [110, 110] }) },
  { name: 'MU (stroke end)',   t: T.MU, board: true, send: (b) => b.send({ t: T.MU, ps: [120, 120] }) },
  { name: 'FILL (flood fill)', t: T.FILL, board: true, send: (b) => b.send({ t: T.FILL, sx: 200, sy: 200, ly: 0, s: 0, br: 0 }) },
  { name: 'CLR (clear canvas)', t: T.CLR, board: true, send: (b) => b.send({ t: T.CLR }) },
  { name: 'TEXT_APPLY',        t: T.TEXT_APPLY, board: true, send: (b) => b.send({ t: T.TEXT_APPLY, g: 'x', ps: [300, 300], s: 1000, c: 255, p: 100, ly: 0 }) },
  { name: 'TEXT_REMOVE',       t: T.TEXT_REMOVE, board: true, send: (b) => b.send({ t: T.TEXT_REMOVE, textId: 'probe_text_1' }) },
  { name: 'UNDO',              t: T.UNDO, board: true, send: (b) => b.send({ t: T.UNDO, undoTargetSeq: 0 }) },
  { name: 'REDO',              t: T.REDO, board: true, send: (b) => b.send({ t: T.REDO }) },
  // IMG_PASTE is strict: validation requires a decodable data-URL in `g`, and a
  // message that fails validation does not merely get dropped — the server
  // closes the socket with 1008. A placeholder payload therefore killed the
  // sender mid-run and every later probe was measured against a dead
  // connection, silently reading as "blocked".
  { name: 'IMG_PASTE',         t: T.IMG_PASTE, board: true, send: (b) => b.send({ t: T.IMG_PASTE, g: TINY_PNG_DATA_URL, sx: 10, sy: 10, sw: 1, sh: 1, ly: 0 }) },
  { name: 'SEL_DELETE',        t: T.SEL_DELETE, board: true, send: (b) => b.send({ t: T.SEL_DELETE, sx: 0, sy: 0, sw: 10, sh: 10, ly: 0 }) },
  { name: 'SEL_FILL',          t: T.SEL_FILL, board: true, send: (b) => b.send({ t: T.SEL_FILL, sx: 0, sy: 0, sw: 10, sh: 10, c: 255, ly: 0 }) },
  { name: 'SEL_STAMP',         t: T.SEL_STAMP, board: true, send: (b) => b.send({ t: T.SEL_STAMP, sx: 0, sy: 0, sw: 10, sh: 10, ly: 0 }) },
  { name: 'MIR (mirror toggle)', t: T.MIR, board: true, send: (b) => b.send({ t: T.MIR }) },
  { name: 'KP (text keypress)', t: T.KP, board: true, send: (b) => b.send({ t: T.KP, k: 'a' }) },

  // — presence / tool state (control arm) —
  { name: 'CT (change tool)',  t: T.CT, board: false, send: (b) => b.send({ t: T.CT, l: 1 }) },
  { name: 'CC (change color)', t: T.CC, board: false, send: (b) => b.send({ t: T.CC, c: 4278190335 }) },
  { name: 'CS (change size)',  t: T.CS, board: false, send: (b) => b.send({ t: T.CS, s: 2000 }) },
  // MSG is chat, not board. Mute is board-only now (silence is the chat-only
  // gate) — so a muted-but-not-silenced user's chat must still get through.
  { name: 'MSG (chat)',        t: T.MSG, board: false, send: (b) => b.chat(`probe_${Date.now()}`) },
];

/**
 * Runs every probe from `sender` and reports which ones reached `observer`.
 *
 * Types are probed one at a time with the observer's log marked beforehand, so
 * a relay can be attributed to the probe that caused it. The wait has to be
 * generous enough to clear the server's 16ms batch flush plus scheduling.
 *
 * The match is on sender AND message type. Matching on sender alone is not
 * good enough and produced a false "a muted user can still IMG_PASTE": issuing
 * the mute makes the server broadcast `{t: HIDE_CURSOR, u: <subject>}`, which
 * is batchable and therefore lands asynchronously — inside whichever probe
 * window happens to be open, carrying the subject's session index. Any
 * server-initiated message about the subject can do this.
 *
 * @returns {Promise<Map<string, boolean>>} probe name → observed by peer
 */
async function runGatingProbes(sender, observer) {
  // The sender's own suppression window would swallow nothing (suppression is
  // per-recipient), but the observer's would swallow everything interesting.
  await observer.completeJoinSync();
  const seen = new Map();
  for (const probe of GATING_PROBES) {
    // A dead sender relays nothing, which reads identically to a perfectly
    // enforced block. Stop rather than manufacture passes.
    if (!sender.connected) {
      seen.set(probe.name, null);
      continue;
    }
    const from = observer.mark();
    probe.send(sender);
    const hit = await observer.waitFor(
      (m) => m.u === sender.sessionIndex && m.t === probe.t,
      { timeoutMs: 700, from },
    );
    seen.set(probe.name, !!hit);
    await sleep(60);
  }
  return seen;
}

/**
 * Guards a probe run against the sender having died partway through.
 * @returns {{name: string, pass: boolean, detail: string}}
 */
function senderSurvivalCheck(label, sender, seen) {
  const unprobed = [...seen.entries()].filter(([, v]) => v === null).map(([k]) => k);
  return {
    name: `${label}: sender survived every probe`,
    pass: unprobed.length === 0,
    detail: unprobed.length
      ? `socket died (${sender.closeInfo?.code} ${sender.closeInfo?.reason}); unprobed: ${unprobed.join(', ')}`
      : 'all probes sent on a live socket',
  };
}

/**
 * Does a mute actually stop a user affecting the board, or only their chat?
 *
 * `MUTED_BLOCKED` in server/index.js is a hand-maintained set, and everything
 * NOT in it falls through `handleBroadcast`'s default path to
 * `broadcastToRoom` — so a board-mutating type that was added later, and never
 * added to that set, is relayed from a muted user and paints on every peer.
 * That is a silent gap by construction, which is exactly why this is measured
 * per message type rather than assumed from the chat behaviour.
 *
 * The control arm matters as much as the test arm: an unmuted bot runs the same
 * probes first, so "the observer saw nothing" cannot be confused with "the
 * server never relays this type anyway".
 */
async function testMuteBlocksBoardAccess(ctx) {
  const { modBot } = ctx;
  const checks = [];
  await clearModerationRows();

  const observer = await joinGuest(V4.unrelatedAlt, 'gate_obs');
  if (!observer.outcome.joined) {
    return summarize([{ name: 'observer join', pass: false, detail: observer.outcome.error }]);
  }

  // ── Control: an unmoderated bot, to learn what is relayable at all.
  const control = await joinGuest(V4.unrelated, 'gate_ctl');
  if (!control.outcome.joined) {
    return summarize([{ name: 'control join', pass: false, detail: control.outcome.error }]);
  }
  const relayable = await runGatingProbes(control.bot, observer.bot);
  checks.push(senderSurvivalCheck('control', control.bot, relayable));
  control.bot.close();

  const relayableBoard = GATING_PROBES.filter(p => p.board && relayable.get(p.name));
  checks.push({
    name: 'control arm relays board-mutating messages',
    pass: relayableBoard.length > 0,
    detail: `${relayableBoard.length}/${GATING_PROBES.filter(p => p.board).length} board types relayed from an unmuted user` +
      (relayableBoard.length === 0 ? ' — harness cannot distinguish blocked from never-relayed' : ''),
  });
  if (relayableBoard.length === 0) {
    observer.bot.close();
    return summarize(checks);
  }

  // ── Test: same probes, muted sender.
  const subject = await joinGuest(V4.base, 'gate_muted');
  if (!subject.outcome.joined) {
    checks.push({ name: 'subject join', pass: false, detail: subject.outcome.error });
    observer.bot.close();
    return summarize(checks);
  }
  const muted = await moderate(modBot, {
    type: MOD.MUTE, target: subject.bot.sessionIndex, ipScope: 'exact', reason: 'ip-suite gating',
  });
  checks.push({ name: 'mute issued', pass: muted.ok, detail: muted.error || 'ok' });
  await subject.bot.refreshRoster();
  checks.push({
    name: 'subject is muted server-side',
    pass: !!subject.bot.rosterEntry()?.mt,
    detail: `roster mt=${!!subject.bot.rosterEntry()?.mt}`,
  });

  const leaked = await runGatingProbes(subject.bot, observer.bot);
  checks.push(senderSurvivalCheck('muted subject', subject.bot, leaked));

  for (const probe of GATING_PROBES) {
    if (!relayable.get(probe.name)) continue; // not relayable at all; nothing to prove
    const got = leaked.get(probe.name);
    if (probe.board) {
      checks.push({
        name: `mute blocks ${probe.name}`,
        pass: !got,
        detail: got ? 'RELAYED to peer — a muted user can still affect the board this way' : 'blocked',
      });
    } else {
      checks.push({
        name: `mute still allows ${probe.name}`,
        pass: !!got,
        detail: got ? 'relayed (presence state, expected)' : 'blocked — mute gate is over-broad',
      });
    }
  }

  subject.bot.close();
  observer.bot.close();
  await clearModerationRows();
  return summarize(checks);
}

/**
 * A shadowban must swallow *everything* the user emits, not just hide them from
 * the roster — otherwise the board still changes under peers' hands while the
 * user appears absent, which is worse than no shadowban at all.
 *
 * `handleBroadcast` returns early on `ws.isShadowBanned` before
 * `broadcastToRoom`, so the expectation is total: no probe of any kind reaches
 * a peer, control types included.
 */
async function testShadowbanBlocksEverything(ctx) {
  const { modBot } = ctx;
  const checks = [];
  await clearModerationRows();

  const observer = await joinGuest(V4.unrelatedAlt, 'sgate_obs');
  if (!observer.outcome.joined) {
    return summarize([{ name: 'observer join', pass: false, detail: observer.outcome.error }]);
  }

  const subject = await joinGuest(V4.base, 'sgate_subj');
  if (!subject.outcome.joined) {
    observer.bot.close();
    return summarize([{ name: 'subject join', pass: false, detail: subject.outcome.error }]);
  }

  // Control on the very same bot, before the shadowban — the tightest possible
  // baseline, since nothing but the sanction changes between the two arms.
  const before = await runGatingProbes(subject.bot, observer.bot);
  checks.push(senderSurvivalCheck('pre-sanction', subject.bot, before));
  const relayedBefore = GATING_PROBES.filter(p => before.get(p.name));
  checks.push({
    name: 'control arm relays before the shadowban',
    pass: relayedBefore.length > 0,
    detail: `${relayedBefore.length}/${GATING_PROBES.length} types relayed pre-sanction`,
  });

  // The shadowban handler requires a live target socket, so a subject that
  // dropped during the control arm would look like a moderation failure.
  checks.push({
    name: 'subject survives the control arm',
    pass: subject.bot.connected,
    detail: subject.bot.connected
      ? `still connected as session ${subject.bot.sessionIndex}`
      : `closed ${subject.bot.closeInfo?.code} "${subject.bot.closeInfo?.reason}" — a probe payload killed the socket`,
  });

  const acted = await moderate(modBot, {
    type: MOD.SHADOWBAN, target: subject.bot.sessionIndex, ipScope: 'exact', reason: 'ip-suite sgating',
  });
  checks.push({
    name: 'shadowban issued',
    pass: acted.ok,
    detail: acted.error ? `${acted.error} (target session ${subject.bot.sessionIndex}, connected=${subject.bot.connected})` : 'ok',
  });

  const after = await runGatingProbes(subject.bot, observer.bot);
  const stillRelayed = GATING_PROBES.filter(p => before.get(p.name) && after.get(p.name));
  checks.push({
    name: 'shadowban swallows every message type',
    pass: stillRelayed.length === 0,
    detail: stillRelayed.length
      ? `${stillRelayed.length} type(s) still reach peers: ${stillRelayed.map(p => p.name).join(', ')}`
      : `all ${relayedBefore.length} previously-relayed types are now swallowed`,
  });

  // And the giveaway check: the subject must not be told any of this happened.
  const toldOff = subject.bot.messages.some(
    m => m.t === T.MOD_RESULT && m.a === false && /muted|banned|shadow/i.test(m.authError || ''),
  );
  checks.push({
    name: 'subject is never told it is sanctioned',
    pass: !toldOff,
    detail: toldOff ? 'server sent the subject a rejection — the shadowban is detectable' : 'no rejection sent',
  });

  subject.bot.close();
  observer.bot.close();
  await clearModerationRows();
  return summarize(checks);
}

/**
 * What happens when the source address is junk.
 *
 * The security property that matters is NOT "a malformed address is rejected" —
 * falling back to the socket peer is a perfectly reasonable answer. It is that
 * **a client cannot mint an unlimited supply of distinct, unbanned identities
 * by varying a malformed header.** Every IP-based control (ban, mute,
 * shadowban, per-IP rate limits) is keyed on `ws.clientIp`, so if each junk
 * value yields its own identity, a banned client simply picks a new one.
 *
 * The test therefore bans a range, connects several times with *different*
 * junk values, and asserts the server resolves them all to the same address.
 * `::ffff:999.1.1.1` gets its own check because it is the nastiest case: it
 * looks structurally like a real address, so it passes any eyeball review.
 */
async function testMalformedSource(ctx) {
  const { modBot } = ctx;
  const checks = [];
  await clearModerationRows();

  // An active ban gives the junk values something to evade.
  const { bot: target, outcome } = await joinGuest(V4.base, 'junk_tgt');
  if (!outcome.joined) return summarize([{ name: 'target join', pass: false, detail: outcome.error }]);
  const banned = await moderate(modBot, {
    type: MOD.BAN, target: target.sessionIndex, ipScope: 'subnet', reason: 'ip-suite malformed',
  });
  checks.push({ name: 'subnet ban issued', pass: banned.ok, detail: banned.error || 'ok' });
  await target.waitForClose(4000);
  target.close();

  const JUNK = [
    '::ffff:999.1.1.1',   // structurally plausible, octets out of range
    '::ffff:888.2.2.2',   // a second one, to expose per-value identities
    'not-an-ip',
    '203.0.113.10.7',     // five octets
  ];

  const observed = [];
  for (const value of JUNK) {
    const bot = new SpoofBot({
      ip: value, room: ROOM, name: 'junk', label: `junk_${value}`,
      trace: TRACE, allowMalformed: true,
    });
    liveBots.push(bot);
    const joined = await bot.join();
    if (!joined.joined) {
      // Refusing outright is also a sound answer — record it as such.
      observed.push({ value, seen: '(refused)', joined: false });
      bot.close();
      continue;
    }
    await modBot.refreshRoster();
    observed.push({
      value,
      seen: modBot.rosterEntry(bot.sessionIndex)?.vip || '(hidden)',
      joined: true,
    });
    bot.close();
    await sleep(120);
  }

  const distinct = new Set(observed.map(o => o.seen));
  checks.push({
    name: 'junk source values do not each mint their own identity',
    pass: distinct.size <= 1,
    detail: `${distinct.size} distinct address(es) from ${JUNK.length} junk headers — ` +
      observed.map(o => `"${o.value}"→${o.seen}`).join(', '),
  });

  const mapped = observed.find(o => o.value === '::ffff:999.1.1.1');
  checks.push({
    name: '"::ffff:999.1.1.1" is not accepted as an address',
    pass: !mapped || !/^999\./.test(mapped.seen),
    detail: `server saw "${mapped?.seen}"`,
  });

  await clearModerationRows();
  return summarize(checks);
}

/**
 * The moderator-facing view: what a mod can see about an address, and what the
 * stored row reveals. Masking that leaks the full address to a low-tier mod is
 * a privacy bug, not just a cosmetic one.
 */
async function testDisplayAndStorage(ctx) {
  const { modBot } = ctx;
  const checks = [];
  await clearModerationRows();

  const { bot: target, outcome } = await joinGuest(V6.base, 'disp_tgt');
  if (!outcome.joined) return summarize([{ name: 'target join', pass: false, detail: outcome.error }]);

  // DEITY sees the canonical address (this is also what the preflight relies on).
  await modBot.refreshRoster();
  const vip = modBot.rosterEntry(target.sessionIndex)?.vip || '';
  checks.push({
    name: 'DEITY roster shows the canonical address',
    pass: vip === buildIpIdentity(V6.base).canonicalIp,
    detail: `vip="${vip}"`,
  });

  // The target itself must never see anyone's IP.
  await target.refreshRoster();
  const selfView = (target.lastUsers?.us || []).map(u => u.vip).filter(Boolean);
  checks.push({
    name: 'a guest sees no IPs in the roster',
    pass: selfView.length === 0,
    detail: selfView.length ? `guest saw ${selfView.length} address(es): ${selfView.join(', ')}` : 'none',
  });

  const acted = await moderate(modBot, {
    type: MOD.BAN, target: target.sessionIndex, ipScope: 'subnet', reason: 'ip-suite display',
  });
  checks.push({ name: 'ban issued', pass: acted.ok, detail: acted.error || 'ok' });
  await target.waitForClose(4000);
  target.close();

  // MOD_LIST is what the mod panel renders.
  const from = modBot.mark();
  modBot.requestModList();
  const list = await modBot.waitFor(m => m.t === T.MOD_LIST, { timeoutMs: 6000, from });
  const entry = (list?.modEntries || []).find(e => e.reason === 'ip-suite display');
  checks.push({
    name: 'MOD_LIST returns the ban',
    pass: !!entry,
    detail: entry ? `ip="${entry.ip}" scope="${entry.ipScope}"` : `${list?.modEntries?.length ?? 0} entries, none matching`,
  });
  if (entry) {
    const expectedRange = `${buildIpIdentity(V6.base).displayRange}`;
    checks.push({
      name: 'the listed entry shows a CIDR range, not a host',
      pass: entry.ip === expectedRange,
      detail: `listed "${entry.ip}", expected "${expectedRange}"`,
    });
    checks.push({
      name: 'the listed entry does not leak the exact host',
      pass: !entry.ip.includes(buildIpIdentity(V6.base).canonicalIp),
      detail: `listed "${entry.ip}"`,
    });
  }

  await clearModerationRows();
  return summarize(checks);
}

// ─── Runner ────────────────────────────────────────────────────────────────

const TESTS = [
  { name: 'preflight',        fn: testPreflight,                   critical: true },
  { name: 'ban_v4',           fn: makeBanScopeTest('ipv4') },
  { name: 'ban_v6',           fn: makeBanScopeTest('ipv6') },
  { name: 'mute_v4',          fn: makeMuteScopeTest('ipv4') },
  { name: 'mute_v6',          fn: makeMuteScopeTest('ipv6') },
  { name: 'unban_range',      fn: testUnbanClearsRange },
  { name: 'evasion',          fn: testEvasion },
  { name: 'canonicalization', fn: testCanonicalizationEnforced },
  { name: 'malformed_source', fn: testMalformedSource },
  { name: 'mute_gating',      fn: testMuteBlocksBoardAccess },
  { name: 'shadowban',        fn: testShadowbanByRange },
  { name: 'shadowban_gating', fn: testShadowbanBlocksEverything },
  { name: 'display',          fn: testDisplayAndStorage },
];

function writeReport(results, meta) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const passed = results.filter(r => r.pass).length;

  let md = `# IP Moderation Report\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `- Run: \`${RUN_ID}\`\n- Room: \`${ROOM}\`\n- Server: ${SERVER_ORIGIN}\n`;
  md += `- Moderator: \`${MOD_USERNAME}\` (DEITY) from ${MOD_IP}\n\n`;
  md += `**${passed}/${results.length} cases passed**\n\n`;

  for (const r of results) {
    md += `## ${r.pass ? '✅' : '❌'} ${r.name}\n\n${r.detail}\n\n`;
    if (r.checks?.length) {
      md += `| Check | Status | Detail |\n| :--- | :---: | :--- |\n`;
      for (const c of r.checks) {
        md += `| ${c.name.replace(/\|/g, '\\|')} | ${c.pass ? '✅' : '❌'} | ${(c.detail || '').replace(/\|/g, '\\|')} |\n`;
      }
      md += `\n`;
    }
  }

  const reportFile = path.join(RESULTS_DIR, `IP_MOD_REPORT_${RUN_ID}.md`);
  fs.writeFileSync(reportFile, md);
  fs.writeFileSync(
    path.join(RESULTS_DIR, `IP_MOD_SUMMARY_${RUN_ID}.json`),
    JSON.stringify({ runId: RUN_ID, room: ROOM, meta, results }, null, 2),
  );
  return reportFile;
}

async function main() {
  console.log('');
  console.log('Top Draw — IP moderation suite (spoofed-source bots)');
  console.log(`  run:    ${RUN_ID}`);
  console.log(`  server: ${SERVER_ORIGIN}`);
  console.log(`  mongo:  ${MONGODB_URI} (${MONGODB_DB_NAME})`);
  console.log(`  room:   ${ROOM}`);
  console.log('');

  await connectMongo();
  console.log('✓ mongo connected (local)');

  const modAuth = await registerAccount(MOD_USERNAME, TEST_PASSWORD, { ip: MOD_IP, origin: SERVER_ORIGIN });
  await promote(MOD_USERNAME, ROLE_DEITY);
  console.log(`✓ moderator ${MOD_USERNAME} registered from ${MOD_IP} and promoted to DEITY`);

  const modBot = new SpoofBot({ ip: MOD_IP, room: ROOM, name: MOD_USERNAME, label: 'mod', trace: TRACE });
  const modJoin = await modBot.joinAndLogin(modAuth.token);
  if (!modJoin.joined || !modJoin.authed) {
    throw new Error(`moderator could not join/auth: ${modJoin.error || modJoin.authError}`);
  }
  console.log(`✓ moderator joined as session ${modBot.sessionIndex} (role ${modBot.authRole})`);
  console.log('');

  const ctx = { modBot };
  const results = [];

  try {
    for (const test of TESTS) {
      if (ONLY.length && !ONLY.includes(test.name)) continue;

      process.stdout.write(`  ${test.name.padEnd(18)} ... `);
      liveBots = [];
      let result;
      try {
        result = await test.fn(ctx);
      } catch (err) {
        result = { pass: false, detail: `threw: ${err.message}`, checks: [] };
      } finally {
        for (const b of liveBots) b.close();
        liveBots = [];
        await sleep(200);
      }

      console.log(`${result.pass ? '✅ PASS' : '❌ FAIL'}  ${result.detail}`);
      for (const c of result.checks || []) {
        if (!c.pass) console.log(`        ↳ ${c.name}: ${c.detail}`);
      }
      results.push({ name: test.name, ...result });

      // A failed preflight means the spoof never reached the server, so every
      // later result would describe 127.0.0.1 rather than the fixture ranges.
      // Reporting those as passes or failures would both be lies.
      if (test.critical && !result.pass) {
        console.log('');
        console.log('  ABORTING: the preflight failed, so IP spoofing is not reaching the server.');
        console.log('  Every remaining case would be testing one shared address. Check that the');
        console.log('  server is local (X-Forwarded-For is only trusted from a private peer, or');
        console.log('  with TRUST_PROXY=true) and that nothing is proxying in front of it.');
        break;
      }
    }
  } finally {
    modBot.close();
  }

  const passed = results.filter(r => r.pass).length;
  const totalChecks = results.reduce((n, r) => n + (r.checks?.length || 0), 0);
  const passedChecks = results.reduce((n, r) => n + (r.checks || []).filter(c => c.pass).length, 0);

  console.log('');
  console.log('─'.repeat(72));
  console.log(`  ${passed}/${results.length} cases · ${passedChecks}/${totalChecks} checks`);
  console.log('─'.repeat(72));

  const reportFile = writeReport(results, { serverOrigin: SERVER_ORIGIN, modIp: MOD_IP });
  console.log(`  report: ${reportFile}`);
  console.log('');

  if (!KEEP) {
    await cleanup();
    console.log('✓ cleaned up test account and moderation rows');
  } else {
    console.log(`(--keep: left ${MOD_USERNAME} and this run's moderation rows in place)`);
  }
  await mongoClient.close();

  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error('');
  console.error(`Fatal: ${err.message}`);
  try { await mongoClient?.close(); } catch { /* nothing to close */ }
  process.exit(1);
});
