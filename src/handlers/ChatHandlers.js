/** @fileoverview Handles chat-related WebSocket events including public messages, DMs, and images. */

import { broadcastChatPopoutEvent } from '../platform/chatPopoutBridge.js';
import { debug } from '../utils/debug.js';

function chatNameColor(color) {
  if (!Array.isArray(color)) return color || '#8ba3c7';
  const [r = 139, g = 163, b = 199] = color;
  const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  if (luminance < 72) return 'var(--role-user)';
  return `rgb(${r}, ${g}, ${b})`;
}

function chatPopoutUser(user, fallbackSessionIndex = null) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.id ?? user.sessionIndex ?? fallbackSessionIndex ?? null,
    sessionIndex: user.sessionIndex ?? user.id ?? fallbackSessionIndex ?? null,
    username: user.username || user.name || '',
    name: user.name || user.username || '',
    color: user.color,
    registeredName: user.registeredName || '',
    role: user.role || 0,
    visibleIp: user.visibleIp || ''
  };
}

/**
 * Sets up WebSocket event handlers for chat functionality.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {App} app - The main application instance.
 */
export function setupChatHandlers(wsClient, app) {
  const { users } = app;

  wsClient.on('msg', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user && app.svelteComponents?.chat) {
      app.svelteComponents.chat.addChatMessage(
        user.username,
        data.message,
        chatNameColor(user.color),
        data.sessionIndex,
        data.messageId,
        user.role
      );
      broadcastChatPopoutEvent('addChatMessage', [
        user.username,
        data.message,
        chatNameColor(user.color),
        data.sessionIndex,
        data.messageId,
        user.role
      ]);
    }
  });

  wsClient.on('dm', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user && app.svelteComponents?.chat) {
      app.svelteComponents.chat.addChatDM(data.message, data.sessionIndex, false, data.messageId, user.role);
      broadcastChatPopoutEvent('addChatDM', [data.message, data.sessionIndex, false, data.messageId, user.role]);
    }
  });

  wsClient.on('staff_msg', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user && app.svelteComponents?.chat) {
      app.svelteComponents.chat.addStaffMessage(
        user.username,
        data.message,
        chatNameColor(user.color),
        data.sessionIndex,
        data.messageId,
        user.role
      );
      broadcastChatPopoutEvent('addStaffMessage', [
        user.username,
        data.message,
        chatNameColor(user.color),
        data.sessionIndex,
        data.messageId,
        user.role
      ]);
    }
  });

  wsClient.on('staff_chat_img', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user) {
      app.svelteComponents?.chat?.addStaffImage(data.imageData, user, data.messageId);
      broadcastChatPopoutEvent('addStaffImage', [data.imageData, chatPopoutUser(user, data.sessionIndex), data.messageId]);
    }
  });

  wsClient.on('chat_img', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    debug('[CHAT_IMG] Received image from user', data.sessionIndex);

    const user = users.get(data.sessionIndex);
    if (user) {
      if (data.recipientId !== undefined && data.recipientId !== null) {
        app.svelteComponents.chat?.addDMImage(data.imageData, data.sessionIndex, false, data.messageId, user.role);
        broadcastChatPopoutEvent('addDMImage', [data.imageData, data.sessionIndex, false, data.messageId, user.role]);
      } else {
        app.svelteComponents.chat?.addChatImage(data.imageData, user, data.messageId);
        broadcastChatPopoutEvent('addChatImage', [data.imageData, chatPopoutUser(user, data.sessionIndex), data.messageId]);
      }
    } else {
      debug.warn('[CHAT_IMG] User not found for sessionIndex:', data.sessionIndex);
    }
  });

  wsClient.on('chat_reaction', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    app.svelteComponents?.chat?.applyReaction(data);
    broadcastChatPopoutEvent('applyReaction', [data]);
  });

  wsClient.on('msg_delete', (data) => {
    app.svelteComponents?.chat?.removeMessage(data.messageId);
    broadcastChatPopoutEvent('removeMessage', [data.messageId]);
  });

  wsClient.on('chat_warning', (data) => {
    app.svelteComponents?.chat?.showSpamWarning(data.level, data.cooldownMs);
  });
}
