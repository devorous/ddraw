/**
 * @fileoverview Unified interface for authentication and room selection.
 */

/**
 * LandingPage class
 */
export class LandingPage {
  /**
   * @param {Object} params
   * @param {WebSocketClient} params.wsClient - WebSocket client instance
   * @param {Auth} params.auth - Auth manager instance
   * @param {Function} params.onRoomSelected - Callback when room is selected
   * @param {Function} params.onOffline - Callback for offline mode
   */
  constructor({ wsClient, auth, onRoomSelected, onOffline }) {
    this.wsClient = wsClient;
    this.auth = auth;
    this.onRoomSelected = onRoomSelected;
    this.onOffline = onOffline;
    this._errorTimeout = null;
    this.els = {};
    this.rooms = [];
    this.selectedRoom = null;
    this.isAuthenticated = false;
    this.authToken = null;
    this.username = null;
  }

  /**
   * Initializes the landing page component.
   */
  init() {
    this.els = {
      landingPage: document.getElementById('landingPage'),
      landingCloseBtn: document.getElementById('landingCloseBtn'),
      landingVersion: document.getElementById('landingVersion'),
      roomList: document.getElementById('roomList'),
      roomIdInput: document.getElementById('roomIdInput'),
      refreshRoomsBtn: document.getElementById('refreshRoomsBtn'),
      joinBtn: document.getElementById('joinBtn'),
      loginJoinBtn: document.getElementById('loginJoinBtn'),
      joinBtnLoggedIn: document.getElementById('joinBtnLoggedIn'),
      authLoggedInJoinBtn: document.getElementById('authLoggedInJoinBtn'),
      loginOfflineBtn: document.getElementById('loginOfflineBtn'),
      landingConnectionStatuses: [
        document.getElementById('landingConnectionStatus'),
        document.getElementById('landingConnectionStatusMobile')
      ].filter(Boolean),
      createRoomBtn: document.getElementById('createRoomBtn'),
      createRoomDialog: document.getElementById('createRoomDialog'),
      createRoomIdInput: document.getElementById('createRoomId'),
      createRoomRandomBtn: document.getElementById('createRoomRandomBtn'),
      createRoomDescInput: document.getElementById('createRoomDesc'),
      createRoomMaxUsersInput: document.getElementById('createRoomMaxUsers'),
      createRoomBgColorInput: document.getElementById('createRoomBgColor'),
      createRoomJoinPolicyInput: document.getElementById('createRoomJoinPolicy'),
      createRoomLockedInput: document.getElementById('createRoomLocked'),
      createRoomPrivateInput: document.getElementById('createRoomPrivate'),
      createRoomCancelBtn: document.getElementById('createRoomCancelBtn'),
      createRoomConfirmBtn: document.getElementById('createRoomConfirmBtn')
    };

    this.pendingRoomSettings = null;
    this.setVersionLabel();

    this.setupListeners();

    // Auto-trigger offline mode if URL is /go/offline
    if (this.getRoomFromURL() === 'offline') {
      if (this.onOffline) this.onOffline();
      return;
    }

    // /embed, /embed/<room> and /demo boot straight into the canvas (see
    // getEmbedTarget() in main.js) — main.js drives that flow directly, so
    // this landing page must stay hidden rather than popping over the top of it.
    if (this._isEmbedBoot()) {
      return;
    }

    this.show();
    this.updateConnectionStatus('disconnected');
  }

  /**
   * Whether the current URL is an embed-style boot (/embed, /embed/<room>, or
   * /demo) that skips the landing page. Kept in sync with getEmbedTarget() in
   * main.js and the pre-paint check in go/index.html.
   * @returns {boolean}
   */
  _isEmbedBoot() {
    const path = window.location.pathname;
    return /^\/embed(\/|$)/.test(path) || /^\/demo\/?$/.test(path);
  }

  /**
   * Checks if the landing page is currently visible.
   * @returns {boolean}
   */
  get isVisible() {
    return this.els.landingPage && this.els.landingPage.style.display !== 'none';
  }

  /**
   * Sets up event listeners for the landing page.
   */
  setupListeners() {
    this.els.loginOfflineBtn?.addEventListener('click', () => {
      if (this.onOffline) this.onOffline();
    });

    this.els.refreshRoomsBtn?.addEventListener('click', () => this.refreshRooms());

    // In-room mode (opened via the topbar "Rooms" button): a close button and
    // a backdrop click both dismiss the overlay back to the current board.
    this.els.landingCloseBtn?.addEventListener('click', () => this.closeInRoom());
    // Clicking the scrim (the landing page itself, outside the container) in
    // in-room mode dismisses back to the board.
    this.els.landingPage?.addEventListener('click', (e) => {
      if (this._inRoom && e.target === this.els.landingPage) this.closeInRoom();
    });

    this.els.roomIdInput?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      document.getElementById('loginForm')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    this.els.createRoomBtn?.addEventListener('click', () => this.openCreateRoomDialog());
    this.els.createRoomCancelBtn?.addEventListener('click', () => this.closeCreateRoomDialog());
    this.els.createRoomRandomBtn?.addEventListener('click', () => {
      if (this.els.createRoomIdInput) {
        this.els.createRoomIdInput.value = this.generateRoomId();
      }
    });
    this.els.createRoomConfirmBtn?.addEventListener('click', () => this.handleCreateRoom());
    this.els.createRoomDialog?.addEventListener('click', (e) => {
      if (e.target === this.els.createRoomDialog) this.closeCreateRoomDialog();
    });
    this.els.createRoomIdInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleCreateRoom();
      if (e.key === 'Escape') this.closeCreateRoomDialog();
    });
  }

  /**
   * Open the create room dialog.
   */
  openCreateRoomDialog() {
    if (!this.els.createRoomDialog) return;
    if (this.els.createRoomIdInput) {
      this.els.createRoomIdInput.value = this.generateRoomId();
    }
    this.els.createRoomDialog.style.display = 'flex';
    this.els.createRoomIdInput?.focus();
  }

  /**
   * Close the create room dialog.
   */
  closeCreateRoomDialog() {
    if (this.els.createRoomDialog) {
      this.els.createRoomDialog.style.display = 'none';
    }
  }

  /**
   * Handle create room form submission.
   */
  handleCreateRoom() {
    const roomId = this.els.createRoomIdInput?.value.trim();
    if (!roomId) {
      this.els.createRoomIdInput?.focus();
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
      this.showCreateRoomError('Room name can only contain letters, numbers, dashes, and underscores');
      return;
    }
    if (roomId.length < 2 || roomId.length > 20) {
      this.showCreateRoomError('Room name must be 2–20 characters');
      return;
    }

    let maxUsers = parseInt(this.els.createRoomMaxUsersInput?.value) || 40;
    maxUsers = Math.max(2, Math.min(60, maxUsers));

    this.pendingRoomSettings = {
      roomDescription: this.els.createRoomDescInput?.value.trim() || '',
      roomBackgroundColor: this.els.createRoomBgColorInput?.value || '#ffffff',
      roomMaxUsers: maxUsers,
      roomJoinPolicy: this.els.createRoomJoinPolicyInput?.value || 'open',
      roomLocked: this.els.createRoomLockedInput?.checked || false,
      roomPrivate: this.els.createRoomPrivateInput?.checked || false
    };

    try {
      const createdRooms = JSON.parse(localStorage.getItem('topDrawCreatedRooms') || '{}');
      createdRooms[roomId] = Date.now();
      localStorage.setItem('topDrawCreatedRooms', JSON.stringify(createdRooms));
    } catch {
      // Local room creator hints are best-effort.
    }

    this.closeCreateRoomDialog();
    this.proceedToRoom(roomId, null);
  }

  /**
   * Show an error inside the create room dialog.
   * @param {string} message
   */
  showCreateRoomError(message) {
    let errEl = this.els.createRoomDialog?.querySelector('.createRoomError');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'createRoomError landingError';
      this.els.createRoomDialog?.querySelector('.createRoomActions')?.before(errEl);
    }
    errEl.textContent = message;
    errEl.style.display = 'block';
  }

  /**
   * Show the landing page and load rooms.
   * @param {Object} [opts]
   * @param {boolean} [opts.inRoom=false] - When true, the landing page is shown
   *   as an embedded overlay on top of an active room (dimmed backdrop + close
   *   button) instead of the full-screen entry experience.
   * @param {boolean} [opts.login=false] - In-room variant that shows the auth
   *   panel instead of the rooms list (self context menu → "Log in").
   */
  show({ inRoom = false, login = false } = {}) {
    this._inRoom = inRoom;

    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      // #landingPage provides its own backdrop (opaque for the entry experience,
      // a light scrim in in-room mode via .landing-in-room), so the overlay
      // itself stays transparent and unblurred in both cases.
      overlay.style.background = 'transparent';
      overlay.style.backdropFilter = 'none';
    }

    if (this.els.landingPage) {
      this.els.landingPage.style.display = 'flex';
      this.els.landingPage.classList.toggle('landing-in-room', inRoom);
      this.els.landingPage.classList.toggle('landing-in-room-login', inRoom && login);
    }

    if (this.els.landingCloseBtn) {
      this.els.landingCloseBtn.style.display = inRoom ? '' : 'none';
    }

    if (inRoom && !this._escHandler) {
      this._escHandler = (e) => {
        if (e.key === 'Escape') this.closeInRoom();
      };
      document.addEventListener('keydown', this._escHandler);
    }

    if (!inRoom) this.loadRooms();
  }

  /**
   * Dismiss the in-room room browser without leaving the current room.
   */
  closeInRoom() {
    this._inRoom = false;
    this.hide();
  }

  setVersionLabel() {
    if (!this.els.landingVersion) return;
    const version = typeof window !== 'undefined' ? window.APP_VERSION : '';
    this.els.landingVersion.textContent = version ? `Version ${version}` : 'Version unknown';
  }

  /**
   * Hide the landing page.
   */
  hide() {
    this._inRoom = false;
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
    if (this.els.landingCloseBtn) {
      this.els.landingCloseBtn.style.display = 'none';
    }
    if (this.els.landingPage) {
      this.els.landingPage.classList.remove('landing-in-room', 'landing-in-room-login');
      this.els.landingPage.style.display = 'none';
    }

    const overlay = document.getElementById('overlay');
    const login = document.getElementById('login');
    const connecting = document.getElementById('connecting');
    if (overlay &&
        (!login || login.style.display === 'none') &&
        (!connecting || connecting.style.display === 'none')) {
      overlay.style.display = 'none';
    }
  }

  /**
   * Load room list from server.
   * @returns {Promise<void>}
   */
  async loadRooms() {
    try {
      const lobbyRoom = {
        id: 'lobby',
        userCount: 0,
        locked: false,
        hasPassword: false
      };
      this.rooms = [lobbyRoom];
      this.renderRooms(this.rooms);
      if (!this.selectedRoom) {
        this.selectRoom(this.getRoomFromURL() || 'lobby');
      }
    } catch (err) {
      console.error('[LandingPage] Failed to load rooms:', err);
      this.showError('Failed to load rooms');
    }
  }

  /**
   * Refresh room list from the server.
   */
  refreshRooms() {
    if (this.wsClient && this.wsClient.connected) {
      this.wsClient.requestRoomList();
      this.renderRooms([]);
      this.els.roomList.innerHTML = '<div class="roomListEmpty">Loading rooms...</div>';
    } else {
      this.showError('Not connected to server');
    }
  }

  /**
   * Handle room list response from server.
   * @param {Array} rooms - List of room objects
   */
  handleRoomListResponse(rooms) {
    this.rooms = rooms || [];

    const lobbyRoom = this.rooms.find(r => r.id === 'lobby');
    if (lobbyRoom) {
      this.rooms = this.rooms.filter(r => r.id !== 'lobby');
      this.rooms.unshift(lobbyRoom);
    } else {
      this.rooms.unshift({
        id: 'lobby',
        userCount: 0,
        locked: false,
        hasPassword: false
      });
    }

    this.renderRooms(this.rooms);

    if (!this.selectedRoom) {
      this.selectRoom('lobby');
    }
  }

  /**
   * Converts preview bytes to a data URL.
   * @param {Uint8Array|null} preview - Preview image bytes
   * @returns {string|null} - Data URL or null
   */
  previewToDataUrl(preview) {
    if (!preview || preview.length === 0) return null;
    try {
      const blob = new Blob([preview], { type: 'image/png' });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  /**
   * Creates a plain room preview using the room background color.
   * @param {string|null|undefined} backgroundColor - Hex room background color
   * @returns {string} - SVG data URL
   */
  createFallbackPreviewUrl(backgroundColor) {
    const color = typeof backgroundColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(backgroundColor)
      ? backgroundColor
      : '#ffffff';
    const width = 1920 / 4;
    const height = 1080 / 4;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><rect width="${width}" height="${height}" fill="${color}"/></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  /**
   * Render room list in the UI.
   * @param {Array} rooms - List of room objects
   */
  renderRooms(rooms) {
    if (!this.els.roomList) return;

    // Clean up old preview URLs
    if (this._previewUrls) {
      this._previewUrls.forEach(url => URL.revokeObjectURL(url));
    }
    this._previewUrls = [];

    if (rooms.length === 0) {
      this.els.roomList.innerHTML = '<div class="roomListEmpty">No active rooms. Create one to get started!</div>';
      return;
    }

    this.els.roomList.innerHTML = rooms.map(room => {
      const previewUrl = this.previewToDataUrl(room.preview) || this.createFallbackPreviewUrl(room.backgroundColor);
      if (previewUrl.startsWith('blob:')) this._previewUrls.push(previewUrl);

      return `
      <div class="roomListItem ${this.selectedRoom === room.id ? 'selected' : ''}" data-room-id="${room.id}">
        <div class="roomPreview">
          <img src="${previewUrl}" alt="Room preview" loading="lazy" />
        </div>
        <div class="roomInfo">
          <div class="roomHeading">
            <div class="roomId">${room.id}</div>
            ${room.description ? `<div class="roomDescription">${this.escapeHtml(room.description)}</div>` : ''}
          </div>
          <div class="roomMeta">
            <span class="roomUserCount">${room.userCount || 0} ${room.userCount === 1 ? 'user' : 'users'}</span>
            ${room.id === 'lobby' ? '<span class="roomBadge default">Default</span>' : ''}
            ${room.locked ? '<span class="roomBadge locked">Locked</span>' : ''}
            ${room.hasPassword ? '<span class="roomBadge">Password</span>' : ''}
          </div>
        </div>
      </div>
    `}).join('');

    this.els.roomList.querySelectorAll('.roomListItem').forEach(item => {
      item.addEventListener('click', () => {
        const roomId = item.dataset.roomId;
        this.selectRoom(roomId);
      });
    });

    // Setup preview expansion on hover/tap
    this.setupPreviewExpansion();
  }

  /**
   * Sets up hover/tap expansion for room previews.
   */
  setupPreviewExpansion() {
    const previews = this.els.roomList.querySelectorAll('.roomPreview img');

    previews.forEach(img => {
      // Create expanded preview container (reuse existing or create new)
      let expandedPreview = document.getElementById('expandedRoomPreview');
      if (!expandedPreview) {
        expandedPreview = document.createElement('div');
        expandedPreview.id = 'expandedRoomPreview';
        expandedPreview.className = 'expandedRoomPreview';
        document.body.appendChild(expandedPreview);
      }

      const showExpanded = (e) => {
        const rect = img.getBoundingClientRect();
        expandedPreview.innerHTML = `<img src="${img.src}" alt="Expanded preview" />`;
        expandedPreview.style.display = 'block';

        // Position above or below the thumbnail depending on available space
        const previewHeight = Math.min(window.innerHeight * 0.4, 400);
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        if (spaceBelow >= previewHeight + 20 || spaceBelow > spaceAbove) {
          expandedPreview.style.top = `${rect.bottom + 8}px`;
          expandedPreview.style.bottom = 'auto';
        } else {
          expandedPreview.style.bottom = `${window.innerHeight - rect.top + 8}px`;
          expandedPreview.style.top = 'auto';
        }

        // Center horizontally relative to thumbnail
        const previewWidth = Math.min(window.innerWidth * 0.8, 600);
        let left = rect.left + rect.width / 2 - previewWidth / 2;
        left = Math.max(10, Math.min(left, window.innerWidth - previewWidth - 10));
        expandedPreview.style.left = `${left}px`;
      };

      const hideExpanded = () => {
        expandedPreview.style.display = 'none';
      };

      // Desktop: hover
      img.addEventListener('mouseenter', showExpanded);
      img.addEventListener('mouseleave', hideExpanded);

      // Mobile: tap to toggle
      img.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        if (expandedPreview.style.display === 'block') {
          hideExpanded();
        } else {
          showExpanded(e);
        }
      }, { passive: true });
    });

    // Hide expanded preview when clicking elsewhere
    document.addEventListener('click', (e) => {
      const expandedPreview = document.getElementById('expandedRoomPreview');
      if (expandedPreview && !e.target.closest('.roomPreview')) {
        expandedPreview.style.display = 'none';
      }
    });
  }

  /**
   * Join a room based on input or selection.
   */
  joinAsGuest() {
    if (!this.wsClient || !this.wsClient.connected) {
      this.showError('Not connected to server');
      return;
    }

    let roomId = this.els.roomIdInput?.value.trim() || this.selectedRoom || 'lobby';

    if (roomId !== 'lobby') {
      if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
        this.showError('Room name can only contain letters, numbers, dashes, and underscores');
        return;
      }
      if (roomId.length < 2 || roomId.length > 20) {
        this.showError('Room name must be 2-20 characters');
        return;
      }
    }

    this.selectedRoom = roomId;
    this.proceedToRoom(roomId, null);
  }

  /**
   * Select a room in the UI.
   * @param {string} roomId - Room identifier
   */
  selectRoom(roomId) {
    this.selectedRoom = roomId;

    if (this.els.roomIdInput) {
      this.els.roomIdInput.value = roomId;
    }

    this.highlightRoom(roomId);
  }

  /**
   * Highlight selected room in UI.
   * @param {string} roomId - Room identifier
   */
  highlightRoom(roomId) {
    if (!this.els.roomList) return;

    this.els.roomList.querySelectorAll('.roomListItem').forEach(item => {
      item.classList.remove('selected');
    });

    const item = this.els.roomList.querySelector(`[data-room-id="${roomId}"]`);
    if (item) {
      item.classList.add('selected');
    }
  }

  /**
   * Proceed to join a specific room.
   * @param {string} roomId - Room identifier
   * @param {string|null} password - Optional room password
   */
  proceedToRoom(roomId, password = null) {
    // Update URL to /go/roomName
    const newPath = `/go/${roomId}`;
    if (window.location.pathname !== newPath) {
      window.history.pushState({ room: roomId }, '', newPath);
    }

    this.hide();
    if (this.onRoomSelected) {
      const settings = this.pendingRoomSettings;
      this.pendingRoomSettings = null;
      this.onRoomSelected(roomId, password, settings);
    }
  }

  /**
   * Handle successful authentication.
   * @param {string} token - Auth token
   * @param {string} username - Logged-in username
   */
  handleAuthSuccess(token, username) {
    this.isAuthenticated = true;
    this.authToken = token;
    this.username = username;
  }

  /**
   * Generate a random room ID.
   * @returns {string} - Randomly generated ID
   */
  generateRoomId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  /**
   * Update connection status display.
   * @param {string} status - Connection status string
   */
  updateConnectionStatus(status) {
    if (!this.els.landingConnectionStatuses?.length) return;

    switch (status) {
      case 'connected':
        this.setConnectionStatusUI('connected', 'Connected');
        this.setRoomFeaturesEnabled(true);
        if (this.wsClient && this.wsClient.connected) {
          this.wsClient.requestRoomList();
        }
        break;

      case 'disconnected':
        this.setConnectionStatusUI('disconnected', 'Not Connected');
        this.setRoomFeaturesEnabled(false);
        break;

      case 'connecting':
      default:
        this.setConnectionStatusUI('connecting', 'Connecting...');
        this.setRoomFeaturesEnabled(false);
        break;
    }
  }

  setConnectionStatusUI(status, text) {
    this.els.landingConnectionStatuses.forEach((statusEl) => {
      const textEl = statusEl.querySelector('.connectionText');
      statusEl.classList.remove('connected', 'disconnected', 'connecting');
      statusEl.classList.add(status);
      if (textEl) textEl.textContent = text;
    });
  }

  /**
   * Enable/disable room features based on connection.
   * @param {boolean} enabled - Whether features should be enabled
   */
  setRoomFeaturesEnabled(enabled) {
    if (this.els.refreshRoomsBtn) {
      this.els.refreshRoomsBtn.disabled = !enabled;
      this.els.refreshRoomsBtn.classList.toggle('disabled', !enabled);
    }
    if (this.els.joinBtn) {
      this.els.joinBtn.disabled = !enabled;
      this.els.joinBtn.classList.toggle('disabled', !enabled);
    }
    if (this.els.loginJoinBtn) {
      this.els.loginJoinBtn.disabled = !enabled;
      this.els.loginJoinBtn.classList.toggle('disabled', !enabled);
    }
    if (this.els.joinBtnLoggedIn) {
      this.els.joinBtnLoggedIn.disabled = !enabled;
      this.els.joinBtnLoggedIn.classList.toggle('disabled', !enabled);
    }
    if (this.els.authLoggedInJoinBtn) {
      this.els.authLoggedInJoinBtn.disabled = !enabled;
      this.els.authLoggedInJoinBtn.classList.toggle('disabled', !enabled);
    }
    if (this.els.createRoomBtn) {
      this.els.createRoomBtn.disabled = !enabled;
      this.els.createRoomBtn.classList.toggle('disabled', !enabled);
    }
  }

  /**
   * Get room ID from URL path (/go/roomName).
   * @returns {string|null} - Room ID or null
   */
  getRoomFromURL() {
    const path = window.location.pathname;
    const match = path.match(/^\/go\/([a-zA-Z0-9_-]+)$/);
    if (match) {
      const room = match[1];
      if (room.startsWith('offline-')) {
        return null;
      }
      return room;
    }
    return null;
  }

  /**
   * Show error message.
   * @param {string} message - Error message
   */
  showError(message) {
    const form = document.getElementById('loginForm');
    if (form) {
      let errorEl = document.getElementById('landingError');
      if (!errorEl) {
        errorEl = document.createElement('div');
        errorEl.id = 'landingError';
        errorEl.className = 'landingError';
        form.appendChild(errorEl);
      }
      errorEl.textContent = message;
      errorEl.style.display = 'block';
      if (this._errorTimeout) clearTimeout(this._errorTimeout);
      this._errorTimeout = setTimeout(() => this.clearError(), 10000);
      return;
    }

    console.error('[LandingPage]', message);
  }

  /**
   * Clears any landing-page error message.
   */
  clearError() {
    if (this._errorTimeout) {
      clearTimeout(this._errorTimeout);
      this._errorTimeout = null;
    }
    const errorEl = document.getElementById('landingError');
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }
  }

  /**
   * Escape HTML to prevent XSS.
   * @param {string} str - Input string
   * @returns {string} - Escaped string
   */
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
