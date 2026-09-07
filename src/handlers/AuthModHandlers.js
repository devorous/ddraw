/** @fileoverview Handles authentication and moderation events from the WebSocket client. */

import { appState } from '../state.svelte.js';
import { debug } from '../utils/debug.js';

const ROLE_NAMES = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];

function getRoleName(role) {
  return ROLE_NAMES[role] || 'Guest';
}

function formatPresenceName(user, fallbackName = 'User') {
  const visibleUsername = String(user?.username || fallbackName || 'User').trim() || 'User';
  const registeredUsername = String(user?.registeredName || '').trim();
  if (registeredUsername && registeredUsername !== visibleUsername) {
    return `${visibleUsername} (${registeredUsername})`;
  }
  return visibleUsername;
}

function findUserByName(users, selfUser, name) {
  const normalized = String(name || '').trim();
  if (!normalized) return null;

  if (selfUser && (selfUser.username === normalized || selfUser.registeredName === normalized)) {
    return selfUser;
  }

  for (const user of users.values()) {
    if (user.username === normalized || user.registeredName === normalized) {
      return user;
    }
  }

  return null;
}

function resolveTargetUser(users, selfUser, data) {
  if (data.targetSessionIndex !== undefined && data.targetSessionIndex !== null) {
    const bySession = users.get(data.targetSessionIndex);
    if (bySession) return bySession;
    if (Number(data.targetSessionIndex) === Number(selfUser?.id)) return selfUser;
  }

  return findUserByName(users, selfUser, data.targetName);
}

function resolveModerationDisplay(users, selfUser, data) {
  const targetUser = resolveTargetUser(users, selfUser, data);
  const issuerUser = findUserByName(users, selfUser, data.issuerName);

  return {
    targetLabel: targetUser
      ? `${getRoleName(targetUser.role ?? 0)} ${formatPresenceName(targetUser, data.targetName || 'User')}`
      : String(data.targetName || 'User').trim() || 'User',
    issuerLabel: issuerUser
      ? `${getRoleName(issuerUser.role ?? 0)} ${formatPresenceName(issuerUser, data.issuerName || 'Moderator')}`
      : String(data.issuerName || 'Moderator').trim() || 'Moderator'
  };
}

/**
 * Sets up WebSocket event handlers for authentication and moderation.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {App} app - The main application instance.
 */
export function setupAuthModHandlers(wsClient, app) {
  const { users, ui } = app;

  wsClient.on('auth_result', (data) => {
    if (data.success && data.username) {
      app.self.registeredName = data.username;
      app.self.isSupporter = !!data.isSupporter;
      ui.setSelfSupporter?.(app.self.isSupporter);
    }

    // Detect a live role update (promotion/demotion) while already in a room.
    // These arrive with success=true but no username and no token, distinct from a real login.
    if (data.success && !data.username && !data.token && app.connected) {
      const role = data.role;
      app.selfRole = role;
      app.self.role = role;
      appState.selfRole = role;
      appState.selfGlobalRole = data.globalRole ?? appState.selfGlobalRole ?? 0;
      appState.selfRoomRole = data.roomRole ?? appState.selfRoomRole ?? 0;
      if (app.moderation) app.moderation.setRole(role, appState.selfGlobalRole, appState.selfRoomRole);
      app.ui.updateSelfRole(role);
      app.updateRoomSettingsButtonVisibility?.();
      app.updateGalleryButtonVisibility?.(role);
      app.updateAuthenticatedActionVisibility?.(role);
      ui.showToast(`Your role has been updated to ${ROLE_NAMES[role] || 'Unknown'}`, 4000);
      return;
    }

    if (app.auth) {
      app.auth.handleAuthResult(data);
    }
  });

  wsClient.on('mod_notify', (data) => {
    const { targetLabel, issuerLabel } = resolveModerationDisplay(users, app.self, data);

    if (data.actionType === 5) {
      if (data.reason) {
        ui.showToast(`Reason added for ${targetLabel}`, 2000);
      }
      return;
    }

    const actionNames = ['kicked', 'muted', 'banned', 'unmuted', 'unbanned', '', '', '', '', 'silenced', 'unsilenced'];
    const actionName = actionNames[data.actionType] || 'moderated';
    const message = `${targetLabel} was ${actionName} by ${issuerLabel}`;
    app.svelteComponents?.chat?.addSystemMessage(message);
    ui.showToast(message, 3000);

    // Update muted state on target user
    if (data.actionType === 1) {
      const targetUser = users.get(data.targetSessionIndex);
      if (targetUser) {
        targetUser.isMuted = true;
        ui.setRemoteUserMuted?.(data.targetSessionIndex, true);
      }

      // If we are the target, update self muted state
      if (data.targetSessionIndex === app.sessionIndex) {
        app.self.isMuted = true;
        ui.setMutedState(true);
        ui.setSelfUserMuted?.(true);
        ui.showToast(`You have been muted${data.reason ? ': ' + data.reason : ''}`, 5000);
      }
    } else if (data.actionType === 3) {
      // Unmuted - find user by name since they might not have a session index in the notify
      for (const [sessionIndex, u] of users) {
        if (u.username === data.targetName || u.registeredName === data.targetName) {
          u.isMuted = false;
          ui.setRemoteUserMuted?.(sessionIndex, false);
          break;
        }
      }

      // If we are the target, update self muted state
      if (data.targetSessionIndex === app.sessionIndex || data.targetName === app.self.username) {
        app.self.isMuted = false;
        ui.setMutedState(false);
        ui.setSelfUserMuted?.(false);
        app._updateBlurCannotDraw();
        ui.showToast('You have been unmuted', 3000);
      }
    } else if (data.actionType === 9) {
      // Silenced (chat-only)
      const targetUser = users.get(data.targetSessionIndex);
      if (targetUser) targetUser.isSilenced = true;

      if (data.targetSessionIndex === app.sessionIndex) {
        app.self.isSilenced = true;
        app.svelteComponents?.chat?.setSilenced(true);
        ui.showToast(`You have been silenced${data.reason ? ': ' + data.reason : ''}`, 5000);
      }
    } else if (data.actionType === 10) {
      // Unsilenced
      for (const [, u] of users) {
        if (u.username === data.targetName || u.registeredName === data.targetName) {
          u.isSilenced = false;
          break;
        }
      }

      if (data.targetSessionIndex === app.sessionIndex || data.targetName === app.self.username) {
        app.self.isSilenced = false;
        app.svelteComponents?.chat?.setSilenced(false);
        ui.showToast('You have been unsilenced', 3000);
      }
    }

    if (data.targetSessionIndex === app.sessionIndex && (data.actionType === 0 || data.actionType === 2)) {
      ui.showToast(`You have been ${actionName}${data.reason ? ': ' + data.reason : ''}`, 5000);
    }

    if (app.moderation?.panelVisible) {
      app.moderation._requestList();
    }
  });

  wsClient.on('mod_result', (data) => {
    if (wsClient._roomSettingsResultHandler) {
      const handler = wsClient._roomSettingsResultHandler;
      wsClient._roomSettingsResultHandler = null;
      handler(data);
      wsClient.requestRoomList();
      return;
    }
    if (wsClient._roomRoleSetResultHandler) {
      const handler = wsClient._roomRoleSetResultHandler;
      wsClient._roomRoleSetResultHandler = null;
      handler(data);
      wsClient.requestRoomRoleList?.();
      wsClient.requestRoomList();
      return;
    }
    if (!data.success && data.error) {
      ui.showToast(data.error, 3000);
    }
    // Always refresh room list to sync ownership state after any mod action
    wsClient.requestRoomList();
    if (data.success && app.moderation?.panelVisible) {
      app.moderation._requestList();
    }
  });

  wsClient.on('mod_list', (data) => {
    if (app.moderation) {
      app.moderation.updateModEntries(data.entries);
    }
  });

  wsClient.on('room_list_response', (data) => {
    if (app.landingPage) {
      app.landingPage.handleRoomListResponse(data.rooms);
    }

    if (app.currentRoomId && data.rooms) {
      const currentRoom = data.rooms.find(r => r.id === app.currentRoomId);
      if (currentRoom) {
        // Merge room list data with existing currentRoomData to preserve settings from SETTINGS message
        app.currentRoomData = {
          ...(app.currentRoomData || {}),
          ...currentRoom
        };
        appState.currentRoomData = app.currentRoomData;
        app.updateRoomSettingsButtonVisibility();
      }
    }
  });

  wsClient.on('room_ownership', (data) => {
    debug('[room_ownership] received:', data);
    // Update local room data when ownership changes
    if (app.currentRoomData) {
      app.currentRoomData.ownerId = data.ownerId || null;
      app.currentRoomData.ownerUsername = data.ownerUsername || null;
      appState.currentRoomData = {
        ...(appState.currentRoomData || {}),
        ownerId: app.currentRoomData.ownerId,
        ownerUsername: app.currentRoomData.ownerUsername
      };
    }
    app.updateRoomSettingsButtonVisibility();

    // Show notification based on current room state after update
    if (app.currentRoomData?.ownerId) {
      const ownerName = app.currentRoomData.ownerUsername || 'Someone';
      ui.showToast(`${ownerName} registered this room`, 3000);
    } else {
      ui.showToast('This room has been unregistered', 3000);
    }
  });

  wsClient.on('room_role_list', (data) => {
    if (app.currentRoomData) {
      app.currentRoomData.moderationRoster = data.entries || [];
      app.currentRoomData.moderationRosterLoadedAt = Date.now();
      appState.currentRoomData = {
        ...(appState.currentRoomData || {}),
        moderationRoster: data.entries || [],
        moderationRosterLoadedAt: app.currentRoomData.moderationRosterLoadedAt
      };
    }
  });

  wsClient.on('mod_wipe', (data) => {
    const targetIndex = data.targetSessionIndex;
    const targetName = data.targetName || `User ${targetIndex}`;
    const issuerName = data.issuerName || 'Moderator';

    if (targetIndex === app.sessionIndex && typeof app.cancelCurrentStroke === 'function') {
      app.cancelCurrentStroke();
    }

    // Wipe all strokes from this user across all layers
    if (app.board?.layerManager) {
      const removed = app.board.layerManager.wipeUserStrokes(targetIndex);
      if (removed) {
        app.board.markCompositeFull();
        app.board.compositeAllLayers();
        app.board.requestUpdate();
      }
    }

    // Clear tile ownership for wiped user
    if (app.board?.tileTracker) {
      // For a full wipe, we might just clear all tiles if the user was a major contributor,
      // but since we no longer have per-user ownership tracking, we either clear all
      // or leave it as is. Usually wipe implies clearing their specific work.
      // For now, let's keep it simple.
    }

    app.svelteComponents?.chat?.addSystemMessage(`All strokes from ${targetName} were removed by ${issuerName}`);
    ui.showToast(`${targetName}'s strokes wiped by ${issuerName}`, 3000);
  });
}
