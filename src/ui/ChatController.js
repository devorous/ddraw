/**
 * @fileoverview Chat controller — outbound chat/DM/staff-chat/image sends and
 * reactions (local echo + popout mirror + network broadcast), plus the chat
 * user-list store sync. Inbound chat is handled by network/handlers.
 * Extracted from App.js.
 */

import { broadcastChatPopoutEvent } from '../platform/chatPopoutBridge.js';
import { appState } from '../state.svelte.js';

export class ChatController {
  constructor(app) {
    this.app = app;
  }

  get self() { return this.app.self; }
  get chat() { return this.app.svelteComponents?.chat; }

  _selfRole() {
    return this.self.role ?? this.app.selfRole ?? 0;
  }

  _queueBroadcast(fn) {
    this.app.inputBufferManager.queueBroadcast(fn);
  }

  handleChatSend(message) {
    const messageId = this._createChatMessageId();
    const args = [
      this.self.username,
      message,
      this._chatNameColor(this.self.color),
      this.app.sessionIndex,
      messageId,
      this._selfRole()
    ];
    // Show immediately in chat (Svelte component handles its own state)
    this.chat?.addChatMessage(...args);
    broadcastChatPopoutEvent('addChatMessage', args);
    this._queueBroadcast(() => this.app.wsClient.broadcastChat(message, messageId));
  }

  handleStaffChatSend(message) {
    const messageId = this._createChatMessageId();
    const args = [
      this.self.username,
      message,
      this._chatNameColor(this.self.color),
      this.app.sessionIndex,
      messageId,
      this._selfRole()
    ];
    this.chat?.addStaffMessage(...args);
    broadcastChatPopoutEvent('addStaffMessage', args);
    this._queueBroadcast(() => this.app.wsClient.broadcastStaffChat(message, messageId));
  }

  handleStaffChatImageSend(imageData) {
    if (!this.app.connected) return;

    const messageId = this._createChatMessageId();
    this._queueBroadcast(() => {
      const result = this.app.wsClient.broadcastStaffChatImage(imageData, messageId);
      if (!result?.ok) {
        this.app.ui?.showToast(result?.error || 'Failed to send chat image', 3000, 'error');
        return;
      }

      this.chat?.addStaffImage(imageData, this.self, messageId);
      broadcastChatPopoutEvent('addStaffImage', [imageData, this._chatPopoutUser(this.self, this.app.sessionIndex), messageId]);
    });
  }

  handleDMSend(message, recipientId) {
    if (this.app.connected) {
      const messageId = this._createChatMessageId();
      this.chat?.addChatDM(message, recipientId, true, messageId, this._selfRole());
      broadcastChatPopoutEvent('addChatDM', [message, recipientId, true, messageId, this._selfRole()]);
      this._queueBroadcast(() => this.app.wsClient.broadcastDM(message, recipientId, messageId));
    }
  }

  handleChatImageSend(imageData, recipientId = null) {
    if (!this.app.connected) return;

    const messageId = this._createChatMessageId();
    this._queueBroadcast(() => {
      const result = this.app.wsClient.broadcastChatImage(imageData, recipientId, messageId);
      if (!result?.ok) {
        this.app.ui?.showToast(result?.error || 'Failed to send chat image', 3000, 'error');
        return;
      }

      if (recipientId !== null && recipientId !== undefined) {
        this.chat?.addDMImage(imageData, recipientId, true, messageId, this._selfRole());
        broadcastChatPopoutEvent('addDMImage', [imageData, recipientId, true, messageId, this._selfRole()]);
      } else {
        this.chat?.addChatImage(imageData, this.self, messageId);
        broadcastChatPopoutEvent('addChatImage', [imageData, this._chatPopoutUser(this.self, this.app.sessionIndex), messageId]);
      }
    });
  }

  handleChatReaction(payload) {
    if (this.app.connected && payload?.messageId && payload?.emoji) {
      broadcastChatPopoutEvent('applyReaction', [payload]);
      this._queueBroadcast(() => this.app.wsClient.broadcastChatReaction(payload));
    }
  }

  handleDeleteMessage(messageId, staff = false) {
    if (!this.app.connected || !messageId) return;
    this._queueBroadcast(() => this.app.wsClient.sendMsgDelete(messageId, staff));
  }

  _createChatMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  _chatNameColor(color) {
    if (!Array.isArray(color)) return color || '#8ba3c7';
    const [r = 139, g = 163, b = 199] = color;
    const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    if (luminance < 72) return 'var(--role-user)';
    return `rgb(${r}, ${g}, ${b})`;
  }

  _chatPopoutUser(user, fallbackSessionIndex = null) {
    if (!user || typeof user !== 'object') return null;
    return {
      id: user.id ?? user.sessionIndex ?? fallbackSessionIndex ?? null,
      sessionIndex: user.sessionIndex ?? user.id ?? fallbackSessionIndex ?? null,
      username: user.username || user.name || '',
      name: user.name || user.username || '',
      color: user.color,
      registeredName: user.registeredName || '',
      role: user.role || 0,
      visibleIp: user.visibleIp || '',
      tool: user.tool || 'brush',
      afk: !!user.afk
    };
  }

  updateChatUserList() {
    // Update the users store for Svelte Chat component
    const userMap = new Map();
    this.app.users.forEach((user, id) => {
      if (id !== this.app.sessionIndex) { // Exclude self
        userMap.set(id, {
          id,
          username: user.username || user.name || '',
          color: this._chatNameColor(user.color),
          registeredName: user.registeredName || '',
          role: user.role || 0,
          visibleIp: user.visibleIp || '',
          tool: user.tool || 'brush',
          afk: !!user.afk,
          isSelf: false
        });
      }
    });

    // Update the users store
    appState.users = userMap;
  }
}
