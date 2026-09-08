/** @fileoverview Handles user-related events including lifecycle, AFK status, and cursor visibility. */

import { User } from '../User.js';
import { debug } from '../utils/debug.js';
import { appState } from '../state.svelte.js';
import { BOARD_SIZE_PRESETS, applyRoomBoardSize } from '../config/BoardSizes.js';
import { applyRoomTiledCanvas } from '../config/TiledCanvasSetting.js';
import { countryCodeToFlagEmoji } from '../utils/countryFlag.js';
import { setUserLayerContent } from '../remote/userLayerPresence.js';

const ROLE_NAMES = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
const ROOM_ROLE_NAMES = ['Guest', 'User', 'Trusted', 'Helper', 'Moderator', 'Admin', 'Owner'];
const JOIN_ANNOUNCE_DELAY_MS = 700;
const JOIN_RANK_GRACE_MS = 3000;

const JOIN_ANNOUNCE_RETRY_MS = 500;
const JOIN_ANNOUNCE_TIMEOUT_MS = 15000;

function getRoleName(role) {
  return ROLE_NAMES[role] || 'Guest';
}

function getRoomRoleName(role) {
  return ROOM_ROLE_NAMES[role] || 'Guest';
}

function getEffectivePayloadRole(userData) {
  return Math.max(
    Number(userData?.role || 0),
    Number(userData?.globalRole || 0),
    Number(userData?.roomRole || 0)
  );
}

function formatPresenceRank(user) {
  const globalRole = Number(user?.globalRole || 0);
  const roomRole = Number(user?.roomRole || 0);
  if (globalRole >= 7) {
    return `${getRoleName(globalRole)} ${getRoomRoleName(roomRole || 1)}`;
  }
  return getRoleName(user?.role ?? 0);
}

function formatPresenceName(user) {
  const visibleUsername = String(user?.username || '').trim() || 'User';
  const registeredUsername = String(user?.registeredName || '').trim();
  if (registeredUsername && registeredUsername !== visibleUsername) {
    return `${visibleUsername} (${registeredUsername})`;
  }
  return visibleUsername;
}

function formatRoomPresenceMessage(user, verb) {
  const flag = countryCodeToFlagEmoji(user?.countryCode);
  const namePart = flag ? `${formatPresenceName(user)} ${flag}` : formatPresenceName(user);
  return `${formatPresenceRank(user)} ${namePart} ${verb}`;
}

function formatJoinPresenceMessage(user) {
  return formatRoomPresenceMessage(user, 'has joined');
}

function hasResolvedPresenceRank(user) {
  if (!user) return false;
  return getEffectivePayloadRole(user) > 0
    || Number(user.globalRole || 0) > 0
    || Number(user.roomRole || 0) > 0
    || !!String(user.registeredName || '').trim();
}

function clearRemoteTextDraft(app, user) {
  if (!user) return;
  if (user.context) {
    user.context.clearRect(0, 0, app.board.getWidth(), app.board.getHeight());
    setUserLayerContent(user, false);
  }
  app.ui.setRemoteTextDomVisible(user.id, true);
  app.ui.updateRemoteText(user.id, '');
}

function applyPendingImageToolChanges(app, sessionIndex, user) {
  const pending = app._pendingRemoteImageToolChanges?.get(sessionIndex);
  if (!pending || !user || !app.remoteUserHandler) return;

  if (pending.imageBrush) {
    app.remoteUserHandler.handleBrushLoad(user, pending.imageBrush);
  }
  if (pending.pattern) {
    app.remoteUserHandler.handlePatternBrushLoad(user, pending.pattern);
  }
  if (pending.confetti) {
    app.remoteUserHandler.handleConfettiBrushLoad(user, pending.confetti);
  }

  app._pendingRemoteImageToolChanges.delete(sessionIndex);
}

function applyUserImageToolState(app, user, userData) {
  const brushData = userData.ib || userData.imageBrush;
  if (brushData && app.remoteUserHandler && user._lastImageBrushPayload !== brushData) {
    user._lastImageBrushPayload = brushData;
    app.remoteUserHandler.handleBrushLoad(user, brushData);
  }

  const patternData = userData.patternBrush || userData.pb;
  if (patternData && app.remoteUserHandler && user._lastPatternBrushPayload !== patternData) {
    user._lastPatternBrushPayload = patternData;
    app.remoteUserHandler.handlePatternBrushLoad(user, patternData);
  }

  applyPendingImageToolChanges(app, userData.sessionIndex, user);
}

/**
 * Sets up WebSocket event handlers for user-related actions and state changes.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {App} app - The main application instance.
 */
export function setupUserHandlers(wsClient, app) {
  const { users, ui, board } = app;
  let hasProcessedInitialUsers = false;
  let knownRemoteSessionIds = new Set();
  const pendingJoinAnnouncements = new Map();
  const announcedJoinSessionIds = new Set();
  const vacatedSlots = new Map();
  const recentlyRemovedUsers = new Map();

  const cancelPendingJoinAnnouncement = (sessionIndex) => {
    const pending = pendingJoinAnnouncements.get(sessionIndex);
    if (pending?.timerId) {
      clearTimeout(pending.timerId);
    }
    pendingJoinAnnouncements.delete(sessionIndex);
  };

  const clearJoinTracking = (sessionIndex) => {
    cancelPendingJoinAnnouncement(sessionIndex);
    announcedJoinSessionIds.delete(sessionIndex);
  };

  const isSelfImmuneToInactiveResync = (role = app.self?.role ?? app.selfRole ?? 0) => {
    const numericRole = Number(role) || 0;
    return numericRole >= 5 || (!!app.currentRoomData?.modInactiveImmune && numericRole >= 4);
  };

  const hasOtherJoinedUsers = () => {
    for (const [sessionIndex, user] of users) {
      if (sessionIndex === app.sessionIndex) continue;
      if (user?.username) return true;
    }
    return false;
  };

  const applySelfInactiveState = (afk = app.self?.afk, role = app.self?.role ?? app.selfRole ?? 0) => {
    // The resync prompt exists because the server filters draw traffic away
    // from AFK clients — alone in the room there is nobody whose strokes we
    // could miss (and the all-AFK snapshot restore is delivered even to AFK
    // clients), so the canvas cannot go stale and the prompt would only lock
    // the board pointlessly. Re-evaluated on users/cn/left, so if someone
    // joins while we are still AFK the prompt appears at that moment.
    app.syncClient?.setInactive(!!afk && !isSelfImmuneToInactiveResync(role) && hasOtherJoinedUsers());
  };

  const rememberRemovedUser = (sessionIndex, user) => {
    if (!user) return;
    recentlyRemovedUsers.set(sessionIndex, {
      username: user.username || '',
      registeredName: user.registeredName || '',
      role: user.role || 0,
      globalRole: user.globalRole || 0,
      roomRole: user.roomRole || 0,
      instanceId: user.instanceId || '',
      countryCode: user.countryCode || ''
    });
  };

  const forgetRemovedUser = (sessionIndex) => {
    recentlyRemovedUsers.delete(sessionIndex);
  };

  const announceJoinIfReady = (sessionIndex, queuedAt = 0) => {
    if (announcedJoinSessionIds.has(sessionIndex)) return true;

    const user = users.get(sessionIndex);
    if (!user?.username || !app.svelteComponents?.chat) return false;
    if (!hasResolvedPresenceRank(user) && queuedAt && Date.now() - queuedAt < JOIN_RANK_GRACE_MS) {
      return false;
    }

    cancelPendingJoinAnnouncement(sessionIndex);
    announcedJoinSessionIds.add(sessionIndex);
    app.svelteComponents.chat.addSystemMessage(formatJoinPresenceMessage(user));
    return true;
  };

  const scheduleJoinAnnouncement = (sessionIndex, delayMs = JOIN_ANNOUNCE_DELAY_MS) => {
    if (announcedJoinSessionIds.has(sessionIndex)) return;

    const existing = pendingJoinAnnouncements.get(sessionIndex);
    const queuedAt = existing?.queuedAt ?? Date.now();
    if (announceJoinIfReady(sessionIndex, queuedAt)) return;
    if (existing?.timerId) return;

    const timerId = setTimeout(() => {
      const pending = pendingJoinAnnouncements.get(sessionIndex);
      if (pending) pending.timerId = null;

      if (announceJoinIfReady(sessionIndex, queuedAt)) return;

      const shouldRetry = users.has(sessionIndex) && Date.now() - queuedAt < JOIN_ANNOUNCE_TIMEOUT_MS;
      if (shouldRetry) {
        scheduleJoinAnnouncement(sessionIndex, JOIN_ANNOUNCE_RETRY_MS);
      }
    }, delayMs);

    pendingJoinAnnouncements.set(sessionIndex, { queuedAt, timerId });
  };

  const abortSyncIfRoomIsEmpty = () => {
    if (!app.syncClient?.isSyncing()) return;

    const hasOtherUsers = [...users.keys()].some((sessionIndex) => sessionIndex !== app.sessionIndex);
    if (!hasOtherUsers) {
      app.syncClient.abortSync('Sync stopped - no other users remain in the room');
      app.updateRecordingButtonState?.();
    }
  };

  const sendActiveStrokeToNewUser = (sessionIndex) => {
    if (sessionIndex === app.sessionIndex || !app.self?.mousedown || app.self?.panning) return;
    app.inputBufferManager?.processLocalFrame?.();
    app.inputBufferManager?.flushPendingNetwork?.();
    app.wsClient?.sendActiveStrokeTo?.(sessionIndex);
  };

  wsClient.on('users', (data) => {
    const incomingRemoteSessionIds = new Set(
      data.users
        .map((u) => Number(u.sessionIndex))
        .filter((sessionIndex) => Number.isFinite(sessionIndex) && sessionIndex !== Number(app.sessionIndex))
    );
    const joinedSessionIds = [...incomingRemoteSessionIds].filter((sessionIndex) => !knownRemoteSessionIds.has(sessionIndex));

    // Authoritative Removal: Find users we have locally who are NOT in the new list
    const remoteIndices = new Set(data.users.map(u => u.sessionIndex));
    users.forEach((user, sessionIndex) => {
      if (sessionIndex !== app.sessionIndex && !remoteIndices.has(sessionIndex)) {
        debug(`[USERS] Removing ghost user ${user.username}(${sessionIndex})`);
        rememberRemovedUser(sessionIndex, user);
        clearJoinTracking(sessionIndex);
        app.cleanupRemoteUserState(sessionIndex, { preserveVisuals: true });
      }
    });

    // Authoritative Update/Create
    data.users.forEach(userData => {
      forgetRemovedUser(userData.sessionIndex);

      const username = userData.name || userData.username || '';
      const effectiveRole = getEffectivePayloadRole(userData);

      if (userData.sessionIndex === app.sessionIndex) {
        // Authoritative update for SELF (e.g. if name was forced unique)
        app.self.instanceId = userData.iid || '';
        const selfAfk = !!userData.afk;
        app.self.setAfk?.(selfAfk);
        app.ui.setSelfUserAfk?.(selfAfk);
        if (username && username !== app.self.username) {
          app.self.setUsername(username);
          app.ui.updateSelfName(username);
        }
        if (userData.registeredName) {
          app.self.registeredName = userData.registeredName;
        }
        if (userData.countryCode !== undefined) {
          app.self.countryCode = userData.countryCode || '';
        }
        if (userData.hasDiscord !== undefined || userData.selectedBadge !== undefined) {
          if (userData.hasDiscord !== undefined) app.self.hasDiscord = !!userData.hasDiscord;
          if (userData.selectedBadge !== undefined) app.self.selectedBadge = userData.selectedBadge || '';
          app.ui.updateSelfBadges?.(app.self);
        }
        if (userData.isSupporter !== undefined && !!userData.isSupporter !== app.self.isSupporter) {
          app.self.isSupporter = !!userData.isSupporter;
          app.ui.setSelfSupporter?.(app.self.isSupporter);
        }
        if (userData.globalRole !== undefined) {
          app.self.globalRole = userData.globalRole || 0;
          appState.selfGlobalRole = app.self.globalRole;
        }
        if (userData.roomRole !== undefined) {
          app.self.roomRole = userData.roomRole || 0;
          appState.selfRoomRole = app.self.roomRole;
        }
        if (userData.isMuted !== undefined && userData.isMuted !== app.self.isMuted) {
          app.self.isMuted = !!userData.isMuted;
          ui.setMutedState(app.self.isMuted);
          app._updateBlurCannotDraw?.();
          ui.setSelfUserMuted?.(app.self.isMuted);
        }
        if (userData.isSilenced !== undefined && userData.isSilenced !== app.self.isSilenced) {
          app.self.isSilenced = !!userData.isSilenced;
          app.svelteComponents?.chat?.setSilenced(app.self.isSilenced);
        }
        if (userData.role !== undefined && effectiveRole !== app.self.role) {
          app.selfRole = effectiveRole;
          app.self.role = effectiveRole;
          appState.selfRole = effectiveRole;
          ui.updateSelfRole(effectiveRole);
        }
        if (app.moderation) app.moderation.setRole(app.self.role, app.self.globalRole, app.self.roomRole);
        board.refreshObscureRegionAccess?.();
        if (userData.thinning !== undefined) {
          app.self.setThinning(userData.thinning);
          app.ui.updateThinningValue(Math.round(userData.thinning * 100));
        }
        // Only apply server's simulatePressure if we don't have a localStorage preference
        const savedSimulatePressure = localStorage.getItem('topDrawSimulatePressure');
        if (userData.simulatePressure !== undefined && savedSimulatePressure === null) {
          app.self.setSimulatePressure(userData.simulatePressure);
          app.ui.updateSimulatePressure(userData.simulatePressure);
        }
        applySelfInactiveState(selfAfk, userData.role ?? app.self.role ?? app.selfRole);
        return;
      }

      // Detect session index reuse with different instanceId and trigger cleanup
      const previousIid = vacatedSlots.get(userData.sessionIndex);
      if (previousIid && previousIid !== userData.iid) {
        debug(`[Ghost User Prevention] Session ${userData.sessionIndex} reused: old iid=${previousIid} → new iid=${userData.iid}`);
        app.forceCleanupResidualState?.(userData.sessionIndex);
        vacatedSlots.delete(userData.sessionIndex);
      }

      let user = users.get(userData.sessionIndex);

      if (!user) {
        // New user
        const userOptions = {
          ...userData,
          username,
          afk: userData.afk || false,
          opacity: userData.color ? userData.color[3] : 1,
          role: effectiveRole,
          globalRole: userData.globalRole || 0,
          roomRole: userData.roomRole || 0,
          isMuted: !!userData.isMuted,
          isSilenced: !!userData.isSilenced,
          isShadowBanned: !!userData.isShadowBanned,
          ipHash: userData.iph || userData.ipHash || '',
          visibleIp: userData.visibleIp || '',
          patternMode: userData.pm || userData.patternMode || false,
          eraseAllLayers: userData.ea || userData.eraseAllLayers || false,
          textPositionMultiplier: userData.textPositionMultiplier,
          textPositionOffset: userData.textPositionOffset,
          instanceId: userData.iid || ''
        };

      // Use persistent color based on fingerprintId if available
      const fpId = userData.fpId || userData.fingerprintId;
      if (fpId && app.fingerprintIdUserColorCache.has(fpId)) {
        userOptions.color = app.fingerprintIdUserColorCache.get(fpId);
      } else if (fpId && userData.color) {
        // Cache the color for this fingerprintId for future rejoins
        app.fingerprintIdUserColorCache.set(fpId, userData.color);
      }
      
      userOptions.fingerprintId = fpId || '';

      const pendingFontChange = app._pendingRemoteFontChanges?.get(userData.sessionIndex);
      if (pendingFontChange) {
          userOptions.font = pendingFontChange.font ?? userOptions.font;
          if (pendingFontChange.textPositionMultiplier !== undefined) {
            userOptions.textPositionMultiplier = pendingFontChange.textPositionMultiplier;
          }
          if (pendingFontChange.textPositionOffset !== undefined) {
            userOptions.textPositionOffset = pendingFontChange.textPositionOffset;
          }
          app._pendingRemoteFontChanges.delete(userData.sessionIndex);
        }

        user = new User(userData.sessionIndex, userOptions);
        user.setTool(userData.tool);
        users.set(userData.sessionIndex, user);

        applyUserImageToolState(app, user, userData);

        const boardData = ui.createUserBoard(userData.sessionIndex);
        user.board = boardData.board;
        user.context = boardData.context;
        app.remoteUserHandler?.updateRemotePreviewPresentation?.(user);

        if (username) {
          ui.createRemoteUser(userData.sessionIndex, userOptions);
          if (userData.cursorHidden) ui.hideRemoteCursor(userData.sessionIndex);
        }
      } else {
        // Existing user - Update properties if they changed
        user.instanceId = userData.iid || '';
        const hadName = !!user.username;

        if (username && username !== user.username) {
          user.setUsername(username);
          if (!hadName) {
            // User gained a name - create UI
            ui.createRemoteUser(userData.sessionIndex, { ...userData, username });
          } else {
            ui.updateRemoteName(userData.sessionIndex, username);
          }
        }

        if (userData.tool && userData.tool !== user.tool) {
          if (user.tool === 'text' && userData.tool !== 'text') {
            clearRemoteTextDraft(app, user);
          }
          user.setTool(userData.tool);
          ui.updateRemoteToolDisplay(userData.sessionIndex, userData.tool);
        }

        if (userData.ea !== undefined || userData.eraseAllLayers !== undefined) {
          user.eraseAllLayers = userData.ea || userData.eraseAllLayers || false;
        }

        if (userData.color && (userData.color[0] !== user.color[0] || userData.color[1] !== user.color[1] || userData.color[2] !== user.color[2])) {
          user.setColor(userData.color);
          ui.updateRemoteColor(userData.sessionIndex, userData.color);
        }

        if (userData.size !== undefined && userData.size !== user.size) {
          user.setSize(userData.size);
          ui.updateRemoteSize(userData.sessionIndex, userData.size);
        }

        if (userData.font !== undefined && userData.font !== user.font) {
          user.setFont(userData.font);
          ui.updateRemoteFont(userData.sessionIndex, userData.font);
        }

        if (userData.textPositionMultiplier !== undefined) {
          user.setTextPositionMultiplier(userData.textPositionMultiplier);
        }

        if (userData.textPositionOffset !== undefined) {
          user.setTextPositionOffset(userData.textPositionOffset);
        }

        if (userData.font !== undefined || userData.textPositionMultiplier !== undefined || userData.textPositionOffset !== undefined || userData.size !== undefined) {
          ui.updateRemoteTextLayout(userData.sessionIndex, user);
        }

        if (userData.globalRole !== undefined) {
          user.globalRole = userData.globalRole || 0;
        }
        if (userData.roomRole !== undefined) {
          user.roomRole = userData.roomRole || 0;
        }
        if (userData.role !== undefined && effectiveRole !== user.role) {
          user.role = effectiveRole;
          ui.updateRemoteUserRank(userData.sessionIndex, effectiveRole);
        }

        applyUserImageToolState(app, user, userData);

        if (userData.registeredName) {
          user.registeredName = userData.registeredName;
        }
        if (userData.countryCode !== undefined) {
          user.countryCode = userData.countryCode || '';
        }
        const nextSelectedBadge = userData.selectedBadge !== undefined ? (userData.selectedBadge || '') : user.selectedBadge;
        if ((userData.hasDiscord !== undefined && user.hasDiscord !== !!userData.hasDiscord) ||
            (userData.selectedBadge !== undefined && user.selectedBadge !== nextSelectedBadge)) {
          if (userData.hasDiscord !== undefined) user.hasDiscord = !!userData.hasDiscord;
          user.selectedBadge = nextSelectedBadge;
          ui.updateRemoteBadges?.(userData.sessionIndex, user);
        }
        if (userData.isSupporter !== undefined && !!userData.isSupporter !== user.isSupporter) {
          user.isSupporter = !!userData.isSupporter;
          ui.setRemoteUserSupporter?.(userData.sessionIndex, user.isSupporter);
        }
        if (userData.visibleIp !== undefined) {
          user.visibleIp = userData.visibleIp || '';
        }
        if (userData.isMuted !== undefined && userData.isMuted !== user.isMuted) {
          user.isMuted = !!userData.isMuted;
          ui.setRemoteUserMuted?.(userData.sessionIndex, user.isMuted);
        }
        if (userData.isSilenced !== undefined && userData.isSilenced !== user.isSilenced) {
          user.isSilenced = !!userData.isSilenced;
        }
        if (userData.isShadowBanned !== undefined && userData.isShadowBanned !== user.isShadowBanned) {
          user.isShadowBanned = !!userData.isShadowBanned;
          ui.setRemoteUserShadowBanned?.(userData.sessionIndex, user.isShadowBanned);
        }
      }

      const isAfk = !!userData.afk;
      user.setAfk?.(isAfk);
      ui.setRemoteUserAfk(userData.sessionIndex, isAfk);
      ui.setRemoteUserMuted?.(userData.sessionIndex, !!userData.isMuted);
      ui.setRemoteUserShadowBanned?.(userData.sessionIndex, !!userData.isShadowBanned);
      if (pendingJoinAnnouncements.has(userData.sessionIndex)) {
        const pending = pendingJoinAnnouncements.get(userData.sessionIndex);
        announceJoinIfReady(userData.sessionIndex, pending?.queuedAt ?? 0);
      }
    });

    if (hasProcessedInitialUsers && joinedSessionIds.length > 0) {
      joinedSessionIds.forEach((sessionIndex) => {
        scheduleJoinAnnouncement(sessionIndex);
        sendActiveStrokeToNewUser(sessionIndex);
      });
    }

    hasProcessedInitialUsers = true;
    knownRemoteSessionIds = incomingRemoteSessionIds;

    app.updateChatUserList();
    abortSyncIfRoomIsEmpty();
    // Roster may have gained/lost other users — re-evaluate the AFK resync
    // prompt (runs after the empty-room abort so a resync started here when
    // the room emptied isn't immediately cancelled by this same event).
    applySelfInactiveState();

    // Trigger sync once we see another user in a USERS payload. We don't burn
    // _needsSync on the FIRST users message: it can land in a tiny window where
    // the server has added us but hasn't yet flushed the joiner's name into
    // getJoinedUsers() output for that broadcast. Wait for any USERS payload
    // that actually contains another user; a short fallback timer covers the
    // truly-alone case.
    if (app._needsSync) {
      const selfIdx = Number(app.sessionIndex);
      const otherUsers = data.users.filter(u => Number(u.sessionIndex) !== selfIdx);

      if (otherUsers.length > 0) {
        app._needsSync = false;
        if (app._needsSyncFallbackTimer) {
          clearTimeout(app._needsSyncFallbackTimer);
          app._needsSyncFallbackTimer = null;
        }
        setTimeout(() => {
          app.syncClient.requestSync();
        }, 500);
      } else if (data.users.some(u => Number(u.sessionIndex) === selfIdx)) {
        // This payload names US, so the roster has already flushed the joiner —
        // the race the fallback timer guards against (added to the room but not
        // yet in getJoinedUsers() output) is over, and "nobody else here" is a
        // real answer rather than a half-built roster. Sync now instead of
        // parking a genuinely solo joiner behind the 2.5s timer: with no peers,
        // no checkpoint and an empty tail there is nothing to wait for.
        app._needsSync = false;
        if (app._needsSyncFallbackTimer) {
          clearTimeout(app._needsSyncFallbackTimer);
          app._needsSyncFallbackTimer = null;
        }
        app.syncClient.requestSync();
      } else if (!app._needsSyncFallbackTimer) {
        app._needsSyncFallbackTimer = setTimeout(() => {
          app._needsSyncFallbackTimer = null;
          if (!app._needsSync) return;
          app._needsSync = false;
          // Alone in the room: still request sync rather than skipping it.
          // A lone joiner's session base may be the room's persisted snapshot
          // (loadSnapshotOnFirstJoin) rather than a blank canvas — only
          // requestSync() -> _serveCheckpointJoin actually pushes that image
          // to this client. Skipping it left the board blank on-screen for a
          // truly-solo joiner and, by extension, out of the rolling DVR tape
          // (whose opening checkpoint had already been captured blank at
          // join time). onSyncComplete's tape re-anchor now correctly runs
          // AFTER the checkpoint image (if any) has been applied.
          app.syncClient.requestSync();
        }, 2500);
      }
    }
  });

  wsClient.on('settings', (data) => {
    board.setMirror(data.mirror);
    board.setMirrorRegions(data.mirrorRegions || []);
    ui.updateMirrorDisplay(data.mirror);
    // SETTINGS is also how the server corrects a client whose full-board mirror
    // toggle was refused, so the checkbox has to follow it.
    app.mirrorRegionController?.syncBoardMirrorCheckbox?.();
    if (data.backgroundColor) {
      board.setBackgroundColor(data.backgroundColor);
      app.updatePatternPreviewIfVisible?.();
    }

    const currentRoomData = app.currentRoomData || { id: app.currentRoomId };
    const roomDataUpdates = {};
    if (data.backgroundColor) {
      roomDataUpdates.backgroundColor = data.backgroundColor;
    }
    if (data.locked !== undefined) {
      roomDataUpdates.locked = data.locked;
    }
    if (data.maxUsers !== undefined) {
      roomDataUpdates.maxUsers = data.maxUsers;
    }
    if (data.modInactiveImmune !== undefined) {
      roomDataUpdates.modInactiveImmune = data.modInactiveImmune;
    }
    if (data.joinPolicy !== undefined) {
      roomDataUpdates.joinPolicy = data.joinPolicy;
    }
    if (data.obscureRequiresRegistered !== undefined) {
      roomDataUpdates.obscureRequiresRegistered = data.obscureRequiresRegistered;
      board.refreshObscureRegionAccess?.();
    }
    if (data.autoMuteGuests !== undefined) {
      roomDataUpdates.autoMuteGuests = data.autoMuteGuests;
    }
    if (data.autoMuteVpnUsers !== undefined) {
      roomDataUpdates.autoMuteVpnUsers = data.autoMuteVpnUsers;
    }
    if (data.hideChatNotifications !== undefined) {
      roomDataUpdates.hideChatNotifications = data.hideChatNotifications;
    }
    if (data.loadSnapshotOnFirstJoin !== undefined) {
      roomDataUpdates.loadSnapshotOnFirstJoin = data.loadSnapshotOnFirstJoin;
    }
    if (data.textOverlayLifetimeMs !== undefined) {
      roomDataUpdates.textOverlayLifetimeMs = data.textOverlayLifetimeMs;
      board.textOverlay?.setRoomLifetime?.(data.textOverlayLifetimeMs);
    }
    if (data.dedicatedReplayUser !== undefined) {
      roomDataUpdates.dedicatedReplayUser = data.dedicatedReplayUser;
    }
    if (data.electedUploader !== undefined) {
      roomDataUpdates.electedUploader = data.electedUploader;
    }
    if (data.private !== undefined) {
      roomDataUpdates.private = data.private;
    }
    if (data.floatingGallerySeed !== undefined) {
      roomDataUpdates.floatingGallerySeed = data.floatingGallerySeed;
    }
    if (data.floatingGalleryIncludeIds !== undefined) {
      roomDataUpdates.floatingGalleryIncludeIds = data.floatingGalleryIncludeIds || [];
    }
    if (data.floatingGalleryExcludeIds !== undefined) {
      roomDataUpdates.floatingGalleryExcludeIds = data.floatingGalleryExcludeIds || [];
    }
    if (data.floatingGalleryVoronoi !== undefined) {
      roomDataUpdates.floatingGalleryVoronoi = data.floatingGalleryVoronoi || null;
    }
    if (data.ownerId !== undefined) {
      roomDataUpdates.ownerId = data.ownerId || null;
    }
    if (data.ownerUsername !== undefined) {
      roomDataUpdates.ownerUsername = data.ownerUsername || null;
    }
    if (data.boardSize && BOARD_SIZE_PRESETS[data.boardSize]) {
      roomDataUpdates.boardSize = data.boardSize;
      applyRoomBoardSize(app, data.boardSize, { showToast: !!app.connected });
    }
    if (data.tiledCanvas !== undefined) {
      roomDataUpdates.tiledCanvas = !!data.tiledCanvas;
      applyRoomTiledCanvas(app, data.tiledCanvas);
    }
    // Carried alongside the setting so the room-settings panel can still tell
    // "off for this room" from "kill switch off" after a settings broadcast —
    // without it the checkbox would disappear on the next SETTINGS message.
    if (data.tiledCanvasAvailable !== undefined) {
      roomDataUpdates.tiledCanvasAvailable = !!data.tiledCanvasAvailable;
    }

    // Mirror is not persisted to DB, but update it locally
    app.currentRoomData = {
      ...currentRoomData,
      ...roomDataUpdates,
      mirror: data.mirror,
      mirrorRegions: data.mirrorRegions || []
    };
    appState.currentRoomData = app.currentRoomData;
    // Re-evaluate after currentRoomData has the latest uploader fields.
    app._updatePreviewUploadEligibility();
    app.updateRoomSettingsButtonVisibility?.();
    board.refreshObscureRegionAccess?.();
    applySelfInactiveState();
  });

  wsClient.on('left', (data) => {
    const user = users.get(data.sessionIndex) || recentlyRemovedUsers.get(data.sessionIndex);
    if (user) {
      clearJoinTracking(data.sessionIndex);
      if (app.svelteComponents?.chat) {
        app.svelteComponents.chat.addSystemMessage(formatRoomPresenceMessage(user, 'has left the room'));
      }

      // Save vacated slot with instanceId to detect reuse
      if (user.instanceId) {
        vacatedSlots.set(data.sessionIndex, user.instanceId);
      }

      // Bake out all user strokes (preserves visuals, frees memory)
      if (users.has(data.sessionIndex)) {
        app.cleanupRemoteUserState(data.sessionIndex, { preserveVisuals: true });
      }
      forgetRemovedUser(data.sessionIndex);

      // Immediately composite to render baked strokes
      app.board?.compositeAllLayers?.();

      app.updateChatUserList();
      abortSyncIfRoomIsEmpty();
      applySelfInactiveState();
    }
  });

  wsClient.on('afk', (data) => {
    if (data.sessionIndex === app.sessionIndex) {
      app.self.setAfk?.(!!data.afk);
      if (data.afk) {
        app.self.mousedown = false;
        app.self.clearLine?.();
        app.board?.layerManager?.deepCleanupUserState?.(app.self.id, { preserveVisuals: true });
        app.board?.clearTop?.();
        app.board?.compositeAllLayers?.();
        app.board?.requestUpdate?.();
      }
      app.ui.setSelfUserAfk?.(!!data.afk);
      applySelfInactiveState(data.afk);
      // Going AFK must stop our snapshot/preview uploads immediately (our canvas
      // is about to freeze); returning re-evaluates eligibility. Without this the
      // change only takes effect on the next visibility/settings event.
      app._updatePreviewUploadEligibility?.();
      return;
    }
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setAfk(data.afk);
      if (data.afk) {
        user.mousedown = false;
        app.remoteUserHandler?.cleanupUserState?.(user, { preserveVisuals: true });
      }
      ui.setRemoteUserAfk(data.sessionIndex, data.afk);
      app.updateChatUserList();
    }
  });

  wsClient.on('compress_user_strokes', async (data) => {
    let userId;
    if (data.sessionIndex === app.sessionIndex) {
      userId = app.self?.id;
    } else {
      const user = users.get(data.sessionIndex);
      if (!user) return;
      userId = user.id;
      debug(`[AFK] Compressing strokes for ${user.username} (${data.sessionIndex})`);
    }
    if (userId !== undefined) {
      await app.board?.commitAllUserStrokesForAFKUser?.(userId);
    }
  });

  wsClient.on('cn', (data) => {
    if (data.sessionIndex === app.sessionIndex) {
      return;
    }

    let user = users.get(data.sessionIndex);
    const wasKnown = !!user;
    const hadNameBefore = !!user?.username;
    const action = !user ? 'joined (new)' : (!hadNameBefore ? 'joined (was nameless)' : 'changed name');
    debug(`[CN] User ${data.name}(${data.sessionIndex}) ${action}`);
    if (!user) {
      const userOptions = {
        username: data.name,
        size: data.size,
        tool: data.tool,
        color: data.color,
        opacity: data.color ? data.color[3] : undefined,
        spacing: data.spacing,
        smoothing: data.smoothing,
        hardness: data.hardness,
        blurRadius: data.blurRadius,
        activeLayer: data.activeLayer,
        blendMode: data.blendMode,
        blendBakeMode: data.blendBakeMode,
        font: data.font,
        textPositionMultiplier: data.textPositionMultiplier,
        textPositionOffset: data.textPositionOffset,
        thinning: data.thinning,
        simulatePressure: data.simulatePressure
      };
      user = new User(data.sessionIndex, userOptions);
      users.set(data.sessionIndex, user);

      const boardData = ui.createUserBoard(data.sessionIndex);
      user.board = boardData.board;
      user.context = boardData.context;
      app.remoteUserHandler?.updateRemotePreviewPresentation?.(user);
      ui.createRemoteUser(data.sessionIndex, user);
    } else {
      user.setUsername(data.name);

      if (data.size !== undefined) user.setSize(data.size);
      if (data.tool !== undefined) {
        if (user.tool === 'text' && data.tool !== 'text') {
          clearRemoteTextDraft(app, user);
        }
        user.setTool(data.tool);
      }
      if (data.color !== undefined) {
        user.setColor(data.color);
        user.setOpacity(data.color[3]);
      }
      if (data.spacing !== undefined) user.setSpacing(data.spacing);
      if (data.smoothing !== undefined) user.setSmoothing(data.smoothing);
      if (data.hardness !== undefined) user.setHardness(data.hardness);
      if (data.blurRadius !== undefined) user.setBlurRadius(data.blurRadius);
      if (data.activeLayer !== undefined) user.setActiveLayer(data.activeLayer);
      if (data.blendMode !== undefined) user.setBlendMode(data.blendMode);
      if (data.blendBakeMode !== undefined) user.setBlendBakeMode(data.blendBakeMode);
      app.remoteUserHandler?.updateRemotePreviewPresentation?.(user);
      if (data.font !== undefined) user.setFont(data.font);
      if (data.textPositionMultiplier !== undefined) user.setTextPositionMultiplier(data.textPositionMultiplier);
      if (data.textPositionOffset !== undefined) user.setTextPositionOffset(data.textPositionOffset);
      if (data.thinning !== undefined) user.setThinning(data.thinning);
      if (data.simulatePressure !== undefined) user.setSimulatePressure(data.simulatePressure);

      if (!hadNameBefore) {
        ui.createRemoteUser(data.sessionIndex, user);
      } else {
        ui.updateRemoteName(data.sessionIndex, data.name);
        if (data.tool !== undefined) ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
        if (data.color !== undefined) ui.updateRemoteColor(data.sessionIndex, data.color);
        if (data.size !== undefined) ui.updateRemoteSize(data.sessionIndex, data.size);
        if (data.font !== undefined) ui.updateRemoteFont(data.sessionIndex, data.font);
        if (data.font !== undefined || data.textPositionMultiplier !== undefined || data.textPositionOffset !== undefined || data.size !== undefined) {
          ui.updateRemoteTextLayout(data.sessionIndex, user);
        }
      }
    }
    if (hasProcessedInitialUsers && (!wasKnown || !hadNameBefore)) {
      scheduleJoinAnnouncement(data.sessionIndex);
    }
    if (pendingJoinAnnouncements.has(data.sessionIndex)) {
      const pending = pendingJoinAnnouncements.get(data.sessionIndex);
      announceJoinIfReady(data.sessionIndex, pending?.queuedAt ?? 0);
    }
    app.updateChatUserList();
    // A user joining (or gaining a name) while we're AFK means draw traffic
    // is now being filtered from us — surface the resync prompt.
    applySelfInactiveState();
  });

  wsClient.on('hide_cursor', (data) => {
    const user = users.get(data.sessionIndex);
    if (user && user.tool === 'text' && user.text) {
      return;
    }
    if (user) {
      user.cursorHidden = true;
    }
    ui.hideRemoteCursor(data.sessionIndex);
  });

  wsClient.on('show_cursor', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.cursorHidden = false;
      ui.showRemoteCursor(data.sessionIndex);
      ui.updateRemoteToolDisplay(data.sessionIndex, user.tool);
    }
  });

  wsClient.on('pan', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.panning = data.panning;
    }
  });
}
