/**
 * @fileoverview Manages UI elements for remote users (cursors, boards, user list entries).
 */

import { normalizeTextFont } from '../config/textFonts.js';
import { getPreviewTextLayout, getTextLineHeight } from '../utils/textLayout.js';
import { badgesForUser, renderBadgesInto } from './Badges.js';

const REMOTE_CURSOR_IDLE_MS = 5000;
const GROUP_HEADER_REFRESH_MS = 5000;
const NOTIFY_USER_ACTIVE_THROTTLE_MS = 500;
const RECENT_ACTIVITY_HIGHLIGHT_MS = 30000;
// "Recently active" sorting buckets users into 30s activity bands rather than
// ranking by exact timestamp, and only re-sorts every 15s — otherwise the
// list reshuffles on every stroke as users trade the #1 spot.
const ACTIVITY_BUCKET_MS = 30000;
const ACTIVE_SORT_INTERVAL_MS = 15000;
const RANK_CLASSES = ['rank-guest', 'rank-user', 'rank-trusted', 'rank-helper', 'rank-mod', 'rank-admin', 'rank-noble', 'rank-holy', 'rank-deity'];

function renderRemotePreviewContent(element, text = '') {
  if (!element) return;

  element.replaceChildren();

  const lines = String(text ?? '').split('\n');
  lines.forEach((line, index) => {
    if (line.length > 0) {
      element.appendChild(document.createTextNode(line));
    }

    const isLastLine = index === lines.length - 1;
    if (!isLastLine) {
      element.appendChild(document.createElement('br'));
      return;
    }

    // Keep the caret visually on the trailing blank line.
    if (line.length === 0 && lines.length > 1) {
      element.appendChild(document.createTextNode('\u200b'));
    }
  });

  element.appendChild(document.createTextNode('|'));
}

/**
 * RemoteUserUI class
 */
export class RemoteUserUI {
  /**
   * @param {Object} elements - DOM element references
   * @param {Object} icons - Tool icons map
   */
  constructor(elements, icons) {
    this.elements = elements;
    this.icons = icons;
    this.cursors = new Map();
    this.userGroups = new Map(); // ipHash -> { element, userIds: Set }
    this._replayModeActive = false;
    this._cursorIdleTimers = new Map();
    this._cursorIdleDeadlines = new Map();
    this.userListSortMode = 'joined';
    this._joinTimestamps = new Map();
    this._recentActivity = new Map();
    this._groupUserIndex = new Map();
    this._lastNotifyActiveAt = new Map();
    this._activeHighlightTimers = new Map();
    // Muted users, so setRemoteUserMuted can act on the transition only: it is
    // called for every user on every USERS broadcast, and re-showing a cursor
    // unconditionally there would resurrect every idle-hidden cursor.
    this._mutedUsers = new Set();

    this._pendingCursorWrites = new Map(); // userId -> {x, y, size}
    this._cursorFlushScheduled = false;

    this._activeSortIntervalTimer = null;

    this._initUserListSortControl();
  }

  setRemoteUsersConnected(connected) {
    document.body?.classList.toggle('remote-users-hidden', !connected);

    if (connected) return;

    this._pendingCursorWrites.clear();
    for (const userId of this._cursorIdleTimers.keys()) {
      this._clearCursorIdleTimer(userId);
    }
  }

  _initUserListSortControl() {
    const sortSelect = document.getElementById('userListSort');
    if (!sortSelect) return;

    if ([...sortSelect.options].some((option) => option.value === this.userListSortMode)) {
      sortSelect.value = this.userListSortMode;
    }
    sortSelect.addEventListener('change', () => {
      const nextMode = sortSelect.value;
      if (nextMode === 'active' || nextMode === 'alphabetical') {
        this.userListSortMode = nextMode;
      } else {
        this.userListSortMode = 'joined';
      }
      this._syncActiveSortInterval();
      this._applyUserListSort();
    });
    this._syncActiveSortInterval();
  }

  /**
   * "Recently active" sorting only needs to reshuffle every
   * ACTIVE_SORT_INTERVAL_MS (buckets are coarser than that), so the periodic
   * re-sort only runs while that mode is selected.
   */
  _syncActiveSortInterval() {
    if (this.userListSortMode === 'active') {
      if (this._activeSortIntervalTimer) return;
      this._activeSortIntervalTimer = setInterval(() => {
        this._applyUserListSort();
      }, ACTIVE_SORT_INTERVAL_MS);
      return;
    }
    if (this._activeSortIntervalTimer) {
      clearInterval(this._activeSortIntervalTimer);
      this._activeSortIntervalTimer = null;
    }
  }

  _markUserJoined(userId, timestamp = Date.now()) {
    const key = String(userId);
    if (this._joinTimestamps.has(key)) return;
    this._joinTimestamps.set(key, timestamp);
  }

  _markUserRecentActivity(userId, timestamp = Date.now()) {
    this._recentActivity.set(String(userId), timestamp);
  }

  _refreshRecentActivityHighlight(userId) {
    const key = String(userId);
    const entry = document.querySelector(`.userEntry.u${userId}`);
    if (entry) entry.classList.add('recently-active');

    const groupInfo = this._getGroupForUser(userId);
    if (groupInfo) groupInfo.group.element.classList.add('recently-active');

    const existing = this._activeHighlightTimers.get(key);
    if (existing) clearTimeout(existing);
    this._activeHighlightTimers.set(key, setTimeout(() => {
      this._activeHighlightTimers.delete(key);
      document.querySelector(`.userEntry.u${userId}`)?.classList.remove('recently-active');
      const info = this._getGroupForUser(userId);
      if (info) {
        // Only drop the group highlight if no other member is still active.
        const anyActive = Array.from(info.group.userIds).some((id) => this._activeHighlightTimers.has(String(id)));
        if (!anyActive) info.group.element.classList.remove('recently-active');
      }
    }, RECENT_ACTIVITY_HIGHLIGHT_MS));
  }

  _setEntrySortMetadata(element, {
    name = '',
    joined = Date.now(),
    active = joined,
  } = {}) {
    if (!element) return;
    element.dataset.sortName = String(name || '').trim().toLocaleLowerCase();
    const joinedAt = Number.isFinite(joined) ? joined : Date.now();
    const activeAt = Number.isFinite(active) ? active : joinedAt;
    element.dataset.joinedAt = String(joinedAt);
    element.dataset.recentActivity = String(activeAt);
  }

  _getSortableUserListChildren() {
    if (!this.elements?.userList) return [];
    return Array.from(this.elements.userList.children).filter((child) => {
      if (!(child instanceof HTMLElement)) return false;
      if (child.classList.contains('userListControls')) return false;
      if (child.classList.contains('self')) return false;
      return true;
    });
  }

  _applyUserListSort() {
    const userList = this.elements?.userList;
    if (!userList) return;

    const now = Date.now();
    const items = this._getSortableUserListChildren();
    items.sort((a, b) => {
      const joinedDiff = Number(b.dataset.joinedAt || 0) - Number(a.dataset.joinedAt || 0);
      const activeDiff = Number(b.dataset.recentActivity || 0) - Number(a.dataset.recentActivity || 0);
      const nameDiff = (a.dataset.sortName || '').localeCompare(b.dataset.sortName || '');

      if (this.userListSortMode === 'active') {
        // Bucket into 30s activity bands instead of ranking by exact
        // timestamp — otherwise two users trading strokes swap places on
        // every ping. Ties within a band fall back to name so ordering stays
        // stable between re-sorts rather than drifting with stale timestamps.
        const bucketA = Math.floor((now - Number(a.dataset.recentActivity || 0)) / ACTIVITY_BUCKET_MS);
        const bucketB = Math.floor((now - Number(b.dataset.recentActivity || 0)) / ACTIVITY_BUCKET_MS);
        if (bucketA !== bucketB) return bucketA - bucketB;
        if (nameDiff !== 0) return nameDiff;
        return joinedDiff;
      }

      if (this.userListSortMode === 'alphabetical') {
        if (nameDiff !== 0) return nameDiff;
        if (joinedDiff !== 0) return joinedDiff;
        return activeDiff;
      }

      if (joinedDiff !== 0) return joinedDiff;
      if (activeDiff !== 0) return activeDiff;
      return nameDiff;
    });

    for (const item of items) {
      userList.appendChild(item);
    }
  }

  _iconToElement(iconData) {
    if (!iconData) return null;
    if (iconData.type === 'svg') {
      const wrapper = document.createElement('div');
      wrapper.className = 'toolIcon';
      wrapper.innerHTML = iconData.content;
      return wrapper;
    } else if (iconData.type === 'img') {
      return iconData.element.cloneNode(true);
    }
    // Legacy: plain DOM node
    return iconData.cloneNode ? iconData.cloneNode(true) : null;
  }

  _getUserListIcon(tool, afk = false) {
    if (afk && this.icons.afk) {
      return this.icons.afk;
    }
    return this.icons[tool] || this.icons.brush;
  }

  _isReplayBotUser(userId) {
    return Number(userId) < 0;
  }

  _shouldSuppressLiveUser(userId) {
    return this._replayModeActive && !this._isReplayBotUser(userId);
  }

  _setUserVisibility(userId, visible) {
    const cursorElements = this.cursors.get(userId);
    const display = visible ? '' : 'none';

    if (cursorElements) {
      if (cursorElements.cursor) cursorElements.cursor.style.display = display;
      if (cursorElements.circle) cursorElements.circle.style.display = display;
      if (cursorElements.square) cursorElements.square.style.display = display;
      if (cursorElements.crosshair) cursorElements.crosshair.style.display = display;
      if (cursorElements.text) cursorElements.text.style.display = display;
    }

    const entry = document.querySelector(`.userEntry.u${userId}`);
    if (entry) entry.style.display = display;
  }

  _clearCursorIdleTimer(userId) {
    const existingTimer = this._cursorIdleTimers.get(userId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this._cursorIdleTimers.delete(userId);
    }
    this._cursorIdleDeadlines.delete(userId);
  }

  /**
   * True when this user's cursor must stay retired regardless of what activity
   * arrives: they asked for it to be hidden (HIDE_CURSOR — pointer off the
   * board), or they are muted.
   *
   * Mute is included because muting broadcasts HIDE_CURSOR but does not stop
   * the *non*-board messages a muted user still emits (SHOW_CURSOR when their
   * pointer crosses the board on the way to the chat box, tool/size changes).
   * Each of those re-showed the cursor at its stale pre-mute position, so a
   * muted user typing in chat flashed a ghost cursor onto every peer's board.
   *
   * @param {string} userId - User's session ID
   * @returns {boolean}
   */
  _isCursorSuppressed(userId) {
    const user = window.app?.users?.get(Number(userId));
    return !!(user?.cursorHidden || user?.isMuted);
  }

  _isRemoteTextActive(userId) {
    const user = window.app?.users?.get(Number(userId));
    if (!user) return false;
    // An in-progress draft exempts the cursor from idle-hiding so we don't hide
    // someone mid-sentence — but the exemption had no upper bound, so a draft
    // that is never finished pins that cursor to the board permanently. AFK is
    // the bound: five minutes of silence means they are not still typing.
    if (user.afk) return false;
    return user.tool === 'text' && typeof user.text === 'string' && user.text.length > 0;
  }

  _setCursorLayerVisibility(userId, visible) {
    const cursorElements = this.cursors.get(userId);
    if (!cursorElements) return;

    if (!visible || this._isCursorSuppressed(userId)) {
      cursorElements.cursor.style.display = 'none';
      cursorElements.circle.style.display = 'none';
      cursorElements.square.style.display = 'none';
      cursorElements.crosshair.style.display = 'none';
      cursorElements.text.style.display = 'none';
      return;
    }

    cursorElements.cursor.style.display = 'block';
    const tool = window.app?.users?.get(Number(userId))?.tool ?? 'brush';
    this._applyRemoteToolDisplay(userId, tool);
  }

  _scheduleCursorIdleHide(userId) {
    if (this._shouldSuppressLiveUser(userId) || this._isRemoteTextActive(userId)) {
      this._clearCursorIdleTimer(userId);
      return;
    }

    this._cursorIdleDeadlines.set(userId, Date.now() + REMOTE_CURSOR_IDLE_MS);
    if (this._cursorIdleTimers.has(userId)) return;

    this._armCursorIdleHide(userId, REMOTE_CURSOR_IDLE_MS);
  }

  _armCursorIdleHide(userId, delayMs) {
    const safeDelay = Math.max(0, Math.ceil(delayMs));
    const timer = setTimeout(() => {
      this._cursorIdleTimers.delete(userId);

      if (this._shouldSuppressLiveUser(userId) || this._isRemoteTextActive(userId)) {
        this._cursorIdleDeadlines.delete(userId);
        return;
      }

      const deadline = this._cursorIdleDeadlines.get(userId);
      if (!deadline) return;

      const remaining = deadline - Date.now();
      if (remaining > 16) {
        this._armCursorIdleHide(userId, remaining);
        return;
      }

      this._cursorIdleDeadlines.delete(userId);
      this._setCursorLayerVisibility(userId, false);
    }, safeDelay);

    this._cursorIdleTimers.set(userId, timer);
  }

  _applyRemoteToolDisplay(userId, tool) {
    const cursorElements = this.cursors.get(userId);
    const circle = cursorElements?.circle;
    const square = cursorElements?.square;
    const crosshair = cursorElements?.crosshair;
    const text = cursorElements?.text;

    if (!circle || !square || !crosshair || !text) return;

    circle.style.display = 'none';
    square.style.display = 'none';
    crosshair.style.display = 'none';
    text.style.display = 'none';

    switch (tool) {
      case 'select':
        crosshair.style.display = 'block';
        break;
      case 'brush':
      case 'flowPen':
      case 'ink':
      case 'line':
      case 'rectangle':
      case 'circle':
      case 'erase':
      case 'circleBlur':
        circle.style.display = 'block';
        break;
      case 'text':
        text.style.display = 'block';
        break;
      case 'blur':
      case 'glitchBlur':
      case 'imageBrush':
        square.style.display = 'block';
        break;
      case 'pattern':
        circle.style.display = 'block';
        break;
    }
  }

  markRemoteCursorActivity(userId) {
    if (this._shouldSuppressLiveUser(userId)) {
      this._setUserVisibility(userId, false);
      return;
    }

    if (this._isCursorSuppressed(userId)) {
      this._clearCursorIdleTimer(userId);
      this._setCursorLayerVisibility(userId, false);
      return;
    }

    const cursorElements = this.cursors.get(userId);
    if (cursorElements?.cursor?.style.display === 'none') {
      this._setCursorLayerVisibility(userId, true);
    }
    this._scheduleCursorIdleHide(userId);
  }

  _applyMutedStateToEntry(entry, userEl, muted) {
    if (entry) entry.classList.toggle('muted', !!muted);
    if (userEl) userEl.classList.toggle('muted', !!muted);
  }

  _applyShadowBannedStateToEntry(entry, userEl, shadowBanned) {
    if (entry) entry.classList.toggle('shadow-banned', !!shadowBanned);
    if (userEl) userEl.classList.toggle('shadow-banned', !!shadowBanned);
  }

  static applyRankClasses(userEl, entryEl, role) {
    const numericRole = Number(role || 0);
    const roleClass = RemoteUserUI.roleToClass(numericRole);

    if (userEl) {
      userEl.classList.remove(...RANK_CLASSES);
      if (roleClass) userEl.classList.add(roleClass);
    }

    if (entryEl) {
      entryEl.classList.remove(...RANK_CLASSES);
      if (numericRole >= 7 && roleClass) entryEl.classList.add(roleClass);
    }
  }

  _syncGroupHeaderRankFromUser(group, userId) {
    if (!group || String(group.displayUserId) !== String(userId)) return;

    const id = `u${userId}`;
    const sourceNameEl = group.usersContainer.querySelector(`.listUser.${id}`);
    const sourceEntryEl = group.usersContainer.querySelector(`.userEntry.${id}`);
    const headerEl = group.element.querySelector('.groupHeader');

    group.headerNameEl.classList.remove(...RANK_CLASSES);
    headerEl?.classList.remove(...RANK_CLASSES);

    if (sourceNameEl) {
      const rankClass = RANK_CLASSES.find((className) => sourceNameEl.classList.contains(className));
      if (rankClass) group.headerNameEl.classList.add(rankClass);
    }

    if (sourceEntryEl && headerEl) {
      const rankClass = RANK_CLASSES.find((className) => sourceEntryEl.classList.contains(className));
      if (rankClass) headerEl.classList.add(rankClass);
    }
  }

  syncGroupHeaderRank(userId) {
    const groupInfo = this._getGroupForUser(userId);
    this._syncGroupHeaderRankFromUser(groupInfo?.group, userId);
  }

  _createBadgesContainer(userData, extraClass = '') {
    const container = document.createElement('span');
    container.className = extraClass ? `userBadges ${extraClass}` : 'userBadges';
    renderBadgesInto(container, badgesForUser(userData));
    return container;
  }

  updateRemoteBadges(userId, userData) {
    const id = `u${userId}`;
    const badgesEl = document.querySelector(`.userBadges.${id}`);
    if (badgesEl) {
      renderBadgesInto(badgesEl, badgesForUser(userData));
    }

    const groupInfo = this._getGroupForUser(userId);
    if (groupInfo?.group.displayUserId === userId && groupInfo.group.headerBadgesEl) {
      renderBadgesInto(groupInfo.group.headerBadgesEl, badgesForUser(userData));
    }
  }

  setReplayModeActive(active) {
    this._replayModeActive = !!active;

    for (const userId of this.cursors.keys()) {
      const visible = !this._shouldSuppressLiveUser(userId);
      this._setUserVisibility(userId, visible);
      // Leaving replay restores every element wholesale; a cursor that was
      // retired (pointer off the board, or muted) must not ride back in on it.
      if (visible && this._isCursorSuppressed(userId)) {
        this._setCursorLayerVisibility(userId, false);
      }
    }

    for (const group of this.userGroups.values()) {
      const hasVisibleLiveUser = Array.from(group.userIds).some((userId) => !this._shouldSuppressLiveUser(userId));
      group.element.style.display = hasVisibleLiveUser ? '' : 'none';
    }
  }

  updateRemoteLayerVisibility(userId, hiddenLayer) {
    const cursorElements = this.cursors.get(userId);
    const opacity = hiddenLayer ? '0.5' : '1';
    const board = document.querySelector(`.userBoard.u${userId}`);

    if (board) {
      // The board is also shown/hidden by content (userLayerPresence). Claim
      // ownership while the layer is hidden so an incoming preview can't reveal
      // strokes drawn on a layer this client has turned off.
      if (hiddenLayer) {
        board.dataset.forceHidden = '1';
        board.style.display = 'none';
      } else {
        delete board.dataset.forceHidden;
        const user = window.app?.users?.get(Number(userId));
        board.style.display = (user && user._userLayerHasContent && !user._layeredPreviewActive)
          ? ''
          : 'none';
      }
    }

    if (cursorElements) {
      if (cursorElements.cursor) cursorElements.cursor.style.opacity = opacity;
      if (cursorElements.circle) cursorElements.circle.style.opacity = opacity;
      if (cursorElements.square) cursorElements.square.style.opacity = opacity;
      if (cursorElements.crosshair) cursorElements.crosshair.style.opacity = opacity;
      if (cursorElements.text) cursorElements.text.style.opacity = opacity;
    }
  }

  /**
   * Create all UI elements for a new remote user.
   * @param {string} userId - User's session ID
   * @param {Object} userData - User initial state data
   */
  createRemoteUser(userId, userData) {
    const id = `u${userId}`;
    // ... (keep existing cursor/svg creation)

    const cursor = document.createElement('div');
    cursor.className = `cursor ${id}`;
    cursor.style.transform = `translate(${(userData.x ?? 0) - 100}px, ${(userData.y ?? 0) - 100}px)`;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', `circle ${id}`);
    circle.setAttribute('stroke', 'grey');
    circle.setAttribute('stroke-width', '1');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('cx', '0');
    circle.setAttribute('cy', '0');
    circle.setAttribute('r', '10');

    const square = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    square.setAttribute('class', `square ${id}`);
    square.setAttribute('stroke', 'grey');
    square.setAttribute('stroke-width', '1');
    square.setAttribute('fill', 'none');
    square.setAttribute('x', userData.x - userData.size);
    square.setAttribute('y', userData.y - userData.size);
    square.setAttribute('height', userData.size * 2);
    square.setAttribute('width', userData.size * 2);

    if (userData.tool !== 'imageBrush' && userData.tool !== 'blur') {
      square.style.display = 'none';
    }

    const crosshair = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    crosshair.setAttribute('class', `crosshair ${id}`);
    crosshair.style.display = userData.tool === 'select' ? 'block' : 'none';
    const chSize = 10;
    const hLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    hLine.setAttribute('x1', -chSize);
    hLine.setAttribute('y1', '0');
    hLine.setAttribute('x2', chSize);
    hLine.setAttribute('y2', '0');
    hLine.setAttribute('stroke', 'grey');
    hLine.setAttribute('stroke-width', '1');
    const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    vLine.setAttribute('x1', '0');
    vLine.setAttribute('y1', -chSize);
    vLine.setAttribute('x2', '0');
    vLine.setAttribute('y2', chSize);
    vLine.setAttribute('stroke', 'grey');
    vLine.setAttribute('stroke-width', '1');
    crosshair.appendChild(hLine);
    crosshair.appendChild(vLine);

    const name = document.createElement('text');
    name.className = `name ${id}`;
    name.textContent = userData.username || userId;

    const text = document.createElement('div');
    text.className = `text ${id}`;
    text.style.width = '400px';
    text.style.color = `rgb(${userData.color[0]}, ${userData.color[1]}, ${userData.color[2]})`;
    text.style.opacity = userData.color[3] ?? 1;
    text.style.fontSize = `${userData.size + 5}px`;
    const normalizedFont = normalizeTextFont(userData.font);
    const lineHeight = getTextLineHeight(userData.size + 5, normalizedFont);
    text.style.fontFamily = normalizedFont;
    text.style.lineHeight = `${lineHeight}px`;
    const textLayout = getPreviewTextLayout(userData);
    text.style.left = `${textLayout.domLeft}px`;
    text.style.top = `${textLayout.domTop}px`;

    if (userData.tool !== 'text') {
      text.style.display = 'none';
    }

    const textInput = document.createElement('span');
    textInput.className = `textInput ${id}`;
    textInput.style.fontFamily = normalizedFont;
    textInput.style.lineHeight = `${lineHeight}px`;
    renderRemotePreviewContent(textInput, userData.text || '');

    text.appendChild(textInput);

    this.elements.cursorsSvg.appendChild(circle);
    this.elements.cursorsSvg.appendChild(square);
    this.elements.cursorsSvg.appendChild(crosshair);
    cursor.appendChild(name);
    cursor.appendChild(text);

    document.querySelector('.cursors').appendChild(cursor);

    this.createUserListEntry(userId, userData);
    this.createUserBoard(userId);

    this.cursors.set(userId, { cursor, circle, square, crosshair, text, textInput, name });
    if (userData.isSupporter) this.setRemoteUserSupporter(userId, true);
    this.updateRemoteLayerVisibility(
      userId,
      !window.app?.board?.layerManager?.isLayerVisible?.(userData.activeLayer ?? 0)
    );
    this._scheduleCursorIdleHide(userId);

    if (userData.afk) {
      this.setRemoteUserAfk(userId, true);
    }

    if (this._shouldSuppressLiveUser(userId)) {
      this._setUserVisibility(userId, false);
    }
  }

  /**
   * Create a dedicated canvas layer for a remote user.
   * @param {string} userId - User's session ID
   * @returns {Object} - Board element and context
   */
  createUserBoard(userId) {
    const id = `u${userId}`;

    // Idempotent. Four separate paths provision a user (App.getOrCreateUser,
    // two in UserHandlers, and addRemoteUser here), none of them aware of the
    // others, and this used to append unconditionally — so a user reached by
    // two of them got two canvases with the same class. removeRemoteUser then
    // took only the first, because it uses querySelector, and the duplicate
    // leaked for the rest of the session with no user object left to collapse
    // it. Measured at 1440p: 13 boards for 7 users, 183 MB, the largest single
    // holder in the app.
    const existing = document.querySelector(`#userBoards .userBoard.${id}`);
    if (existing) {
      return { board: existing, context: existing.getContext('2d') };
    }

    const board = document.createElement('canvas');
    // Starts collapsed. The backing store is allocated by
    // userLayerPresence.ensureUserLayerSized on the first draw and released
    // again when the preview goes idle; provisioning at board size here would
    // hand every user a full-board canvas before they have drawn anything.
    board.setAttribute('height', 1);
    board.setAttribute('width', 1);
    board.className = `userBoard ${id}`;
    // Starts out of the compositing tree: a fresh board is empty, and previews
    // are transient, so RemoteUserHandler._setUserLayerContent adds it only
    // while there is something on it. Otherwise every user in the room costs a
    // full board-sized layer per composited frame for their whole session.
    board.style.display = 'none';
    this.elements.userBoards.appendChild(board);

    const context = board.getContext('2d');
    context.lineCap = 'round';
    context.lineJoin = 'round';

    return { board, context };
  }

  /**
   * Create user list entry showing tool, color, name, and role badge.
   * Groups users by IP hash only if multiple users share the same IP.
   * @param {string} userId - User's session ID
   * @param {Object} userData - User state data
   */
  createUserListEntry(userId, userData) {
    const joinedAt = Date.now();
    this._markUserJoined(userId, joinedAt);
    this._markUserRecentActivity(userId, joinedAt);
    const ipHash = userData.ipHash || userData.iph;

    // If no IP hash, just add normally to the flat list
    if (!ipHash) {
      this._createSingleUserEntry(userId, userData, this.elements.userList);
      this._applyUserListSort();
      return;
    }

    // Check if there's ALREADY another user with this IP hash
    let existingUsersWithSameIp = [];
    if (window.app && window.app.users) {
      window.app.users.forEach((u, id) => {
        if (id !== userId && u.ipHash === ipHash && u.username) {
          existingUsersWithSameIp.push(id);
        }
      });
    }

    // If no one else has this IP yet, just add as a normal entry
    if (existingUsersWithSameIp.length === 0) {
      this._createSingleUserEntry(userId, userData, this.elements.userList);
      this._applyUserListSort();
      return;
    }

    // Someone else has this IP. We need a group.
    let group = this.userGroups.get(ipHash);
    if (!group) {
      // Create the group container, using the new user as the initial display user
      group = this._createGroupContainer(ipHash, userId, userData);

      // CAPTURE the existing user(s) who were previously flat in the list
      existingUsersWithSameIp.forEach(otherId => {
        const otherEntry = document.querySelector(`.userEntry.u${otherId}`);
        if (otherEntry && otherEntry.parentElement === this.elements.userList) {
          group.usersContainer.appendChild(otherEntry);
          group.userIds.add(otherId);
          this._groupUserIndex.set(String(otherId), ipHash);
        }
      });
    }

    // Add the new user to the group
    group.userIds.add(userId);
    this._groupUserIndex.set(String(userId), ipHash);
    this._createSingleUserEntry(userId, userData, group.usersContainer);
    this._updateGroupSummary(ipHash);
    this._syncGroupSortMetadata(ipHash);
    this._applyUserListSort();
  }

  /**
   * Internal helper to create the group UI container.
   * The header looks like a regular user entry, showing the most recently active user.
   * @param {string} ipHash - IP hash key for the group
   * @param {string} displayUserId - User ID to show in the header initially
   * @param {Object} displayUserData - User data for the header display
   */
  _createGroupContainer(ipHash, displayUserId, displayUserData) {
    const groupEl = document.createElement('div');
    groupEl.className = 'userGroup';
    groupEl.dataset.ipHash = ipHash;

    // Header styled like a regular userEntry
    const groupHeader = document.createElement('div');
    groupHeader.className = 'userEntry groupHeader';
    groupHeader.onclick = () => this.toggleGroup(ipHash);
    groupHeader.oncontextmenu = (e) => {
      if (window.app && window.app.moderation) {
        window.app.moderation.showContextMenu(e, null, null, ipHash);
      }
    };

    const colorToolWrap = document.createElement('div');
    colorToolWrap.className = 'listColorTool groupHeaderColorTool';

    const colorEl = document.createElement('a');
    colorEl.className = 'listColor groupHeaderColor';
    const color = Array.isArray(displayUserData.color) ? displayUserData.color : [0, 0, 0, 1];
    colorEl.style.backgroundColor = `rgba(${color.join(',')})`;

    const toolEl = document.createElement('a');
    toolEl.className = 'listTool groupHeaderTool';
    const iconEl = this._iconToElement(this._getUserListIcon(displayUserData.tool, displayUserData.afk));
    if (iconEl) toolEl.appendChild(iconEl);

    colorToolWrap.appendChild(colorEl);
    colorToolWrap.appendChild(toolEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'listUser groupHeaderName';
    nameEl.textContent = displayUserData.name || displayUserData.username || displayUserId;
    RemoteUserUI.applyRankClasses(nameEl, groupHeader, displayUserData.role);
    this._applyMutedStateToEntry(groupHeader, nameEl, displayUserData.isMuted);

    const badgesEl = this._createBadgesContainer(displayUserData);

    const countBadge = document.createElement('span');
    countBadge.className = 'groupCountBadge';
    countBadge.textContent = '+1';

    groupHeader.appendChild(colorToolWrap);
    groupHeader.appendChild(badgesEl);
    groupHeader.appendChild(nameEl);
    groupHeader.appendChild(countBadge);

    groupEl.appendChild(groupHeader);

    const groupUsers = document.createElement('div');
    groupUsers.className = 'groupUsers';
    groupEl.appendChild(groupUsers);

    this.elements.userList.appendChild(groupEl);

    const group = {
      element: groupEl,
      usersContainer: groupUsers,
      userIds: new Set(),
      displayUserId,
      headerToolEl: toolEl,
      headerColorEl: colorEl,
      headerBadgesEl: badgesEl,
      headerNameEl: nameEl,
      headerCountEl: countBadge,
      pendingDisplayUpdate: null,
      pendingRefreshTimer: null,
      lastHeaderRefreshAt: 0,
    };
    this.userGroups.set(ipHash, group);
    this._groupUserIndex.set(String(displayUserId), ipHash);
    this._setEntrySortMetadata(groupEl, {
      name: displayUserData.name || displayUserData.username || displayUserId,
      joined: this._joinTimestamps.get(String(displayUserId)) || Date.now(),
      active: this._recentActivity.get(String(displayUserId)) || Date.now()
    });
    return group;
  }

  /**
   * Update the group header to reflect the given user's current data.
   * Call this when a user in the group becomes active.
   * @param {string} ipHash - Group IP hash
   * @param {string} userId - User ID to show in header
   */
  _setGroupDisplayUser(ipHash, userId) {
    const group = this.userGroups.get(ipHash);
    if (!group || group.displayUserId === userId) return;

    // Record the intended display user immediately so subsequent rapid calls
    // with the same userId short-circuit via the guard above.
    group.displayUserId = userId;

    // Throttle DOM work to ~30fps per group. If an update is already scheduled,
    // the most-recent userId is already stored on group.displayUserId above, so
    // the pending flush will use it automatically — no need to reschedule.
    if (group.pendingDisplayUpdate !== null) return;

    group.pendingDisplayUpdate = setTimeout(() => {
      group.pendingDisplayUpdate = null;
      const id = `u${group.displayUserId}`;

      const srcTool = group.usersContainer.querySelector(`.listTool.${id}`);
      if (srcTool) group.headerToolEl.innerHTML = srcTool.innerHTML;

      const srcColor = group.usersContainer.querySelector(`.listColor.${id}`);
      if (srcColor) group.headerColorEl.style.backgroundColor = srcColor.style.backgroundColor;

      const srcName = group.usersContainer.querySelector(`.listUser.${id}`);
      if (srcName) {
        group.headerNameEl.textContent = srcName.textContent;
        group.headerNameEl.className = 'listUser groupHeaderName';
        group.headerNameEl.classList.toggle('muted', srcName.classList.contains('muted'));
        group.element.querySelector('.groupHeader')?.classList.toggle('muted', srcName.classList.contains('muted'));
        this._syncGroupHeaderRankFromUser(group, group.displayUserId);
      }

      const srcBadges = group.usersContainer.querySelector(`.userBadges.${id}`);
      if (group.headerBadgesEl) {
        if (srcBadges) {
          group.headerBadgesEl.innerHTML = srcBadges.innerHTML;
          group.headerBadgesEl.style.display = srcBadges.style.display || (srcBadges.childElementCount > 0 ? '' : 'none');
        } else {
          group.headerBadgesEl.textContent = '';
          group.headerBadgesEl.style.display = 'none';
        }
      }
      // Rotating the display user is a header-only visual change — do NOT
      // re-sort here, or the list flickers as remote cursors move around.
    }, 33);
  }

  _getGroupForUser(userId) {
    const ipHash = this._groupUserIndex.get(String(userId));
    if (!ipHash) return null;
    const group = this.userGroups.get(ipHash);
    const hasUser = group?.userIds && Array.from(group.userIds).some((id) => String(id) === String(userId));
    return hasUser ? { ipHash, group } : null;
  }

  _getMostRecentGroupUser(group) {
    let nextUserId = group.displayUserId;
    let mostRecent = this._recentActivity.get(String(nextUserId)) || 0;

    for (const candidateUserId of group.userIds) {
      const candidateRecent = this._recentActivity.get(String(candidateUserId)) || 0;
      if (candidateRecent > mostRecent) {
        mostRecent = candidateRecent;
        nextUserId = candidateUserId;
      }
    }

    return nextUserId;
  }

  _refreshGroupDisplayUser(ipHash) {
    const group = this.userGroups.get(ipHash);
    if (!group) return;
    group.lastHeaderRefreshAt = Date.now();
    this._setGroupDisplayUser(ipHash, this._getMostRecentGroupUser(group));
  }

  _scheduleGroupDisplayRefresh(ipHash, delayMs = GROUP_HEADER_REFRESH_MS) {
    const group = this.userGroups.get(ipHash);
    if (!group || group.pendingRefreshTimer !== null) return;

    group.pendingRefreshTimer = setTimeout(() => {
      group.pendingRefreshTimer = null;
      this._refreshGroupDisplayUser(ipHash);
    }, Math.max(0, Math.ceil(delayMs)));
  }

  /**
   * Notify that a user was active — rotates the group header to show their
   * name. If the user selected "Recently active" sorting, this also updates
   * sort metadata and reorders rows.
   * @param {string} userId - User ID
   */
  notifyUserActive(userId) {
    const activityAt = Date.now();
    this._markUserRecentActivity(userId, activityAt);
    this._refreshRecentActivityHighlight(userId);

    // Throttle the DOM/sort work — this is called for every remote pointer
    // sample and catchup tick (hundreds/sec per user). Sort precision of
    // ~500ms is plenty for "recently active" ordering, and it avoids
    // re-sorting the entire user list on every cursor movement.
    const key = String(userId);
    const lastAt = this._lastNotifyActiveAt.get(key) || 0;
    if (activityAt - lastAt < NOTIFY_USER_ACTIVE_THROTTLE_MS) return;
    this._lastNotifyActiveAt.set(key, activityAt);

    const entry = document.querySelector(`.userEntry.u${userId}`);
    if (entry) {
      this._setEntrySortMetadata(entry, {
        name: entry.dataset.sortName || entry.querySelector('.listUser')?.textContent || userId,
        joined: this._joinTimestamps.get(String(userId)) || Number(entry.dataset.joinedAt || 0) || activityAt,
        active: activityAt
      });
    }

    const groupInfo = this._getGroupForUser(userId);
    if (groupInfo) {
      const { ipHash, group } = groupInfo;
      this._syncGroupSortMetadata(ipHash);
      const elapsedSinceRefresh = activityAt - (group.lastHeaderRefreshAt || 0);

      if (!group.lastHeaderRefreshAt || elapsedSinceRefresh >= GROUP_HEADER_REFRESH_MS) {
        this._refreshGroupDisplayUser(ipHash);
      } else {
        this._scheduleGroupDisplayRefresh(ipHash, GROUP_HEADER_REFRESH_MS - elapsedSinceRefresh);
      }
    }

    // Reordering itself is handled by the periodic interval in
    // _syncActiveSortInterval — sort metadata above is kept fresh so that
    // pass has accurate data, but resorting here too would reshuffle rows
    // on every ping.
  }

  /**
   * Internal helper to create a single user entry.
   */
  _createSingleUserEntry(userId, userData, container) {
    const id = `u${userId}`;
    const entry = document.createElement('div');
    entry.className = `userEntry ${id}`;
    entry.dataset.sessionIndex = userId;

    const colorToolWrap = document.createElement('div');
    colorToolWrap.className = `listColorTool ${id}`;

    const colorEntry = document.createElement('a');
    colorEntry.className = `listColor ${id}`;
    const color = Array.isArray(userData.color) ? userData.color : [0,0,0,1];
    colorEntry.style.backgroundColor = `rgba(${color.join(',')})`;

    const toolEntry = document.createElement('a');
    toolEntry.className = `listTool ${id}`;
    const iconEl = this._iconToElement(this._getUserListIcon(userData.tool, userData.afk));
    if (iconEl) toolEntry.appendChild(iconEl);

    colorToolWrap.appendChild(colorEntry);
    colorToolWrap.appendChild(toolEntry);

    const userEntry = document.createElement('span');
    userEntry.className = `listUser ${id}`;
    userEntry.textContent = userData.name || userData.username || userId;

    const badgesEl = this._createBadgesContainer(userData, id);

    const role = userData.role;
    RemoteUserUI.applyRankClasses(userEntry, entry, role);
    this._applyMutedStateToEntry(entry, userEntry, userData.isMuted);

    const syncBtn = document.createElement('a');
    syncBtn.className = `listSync ${id}`;
    syncBtn.title = 'Request canvas sync from this user';
    syncBtn.innerHTML = '&#8635;';
    syncBtn.style.cursor = 'pointer';
    syncBtn.style.opacity = '0.6';
    syncBtn.onclick = (e) => {
      e.stopPropagation();
      if (window.app && window.app.syncClient) {
        window.app.syncClient.requestSyncFrom(userId);
      }
    };

    entry.appendChild(colorToolWrap);
    entry.appendChild(badgesEl);
    entry.appendChild(userEntry);
    entry.appendChild(syncBtn);

    this._setEntrySortMetadata(entry, {
      name: userData.name || userData.username || userId,
      joined: this._joinTimestamps.get(String(userId)) || Date.now(),
      active: this._recentActivity.get(String(userId)) || Date.now()
    });
    container.appendChild(entry);
  }

  _updateGroupSummary(ipHash) {
    const group = this.userGroups.get(ipHash);
    if (!group) return;
    const extra = group.userIds.size - 1;
    group.headerCountEl.textContent = `+${extra}`;
  }

  _syncGroupSortMetadata(ipHash) {
    const group = this.userGroups.get(ipHash);
    if (!group) return;

    let mostRecentActivity = 0;
    let mostRecentJoin = 0;
    for (const userId of group.userIds) {
      mostRecentActivity = Math.max(mostRecentActivity, this._recentActivity.get(String(userId)) || 0);
      mostRecentJoin = Math.max(mostRecentJoin, this._joinTimestamps.get(String(userId)) || 0);
    }

    this._setEntrySortMetadata(group.element, {
      name: group.headerNameEl?.textContent || group.displayUserId,
      joined: mostRecentJoin || Date.now(),
      active: mostRecentActivity || Date.now()
    });
  }

  toggleGroup(ipHash) {
    const group = this.userGroups.get(ipHash);
    if (!group) return;
    group.element.classList.toggle('expanded');
  }

  /**
   * Update remote cursor position.
   * @param {string} userId - User's session ID
   * @param {number} x - Target X
   * @param {number} y - Target Y
   * @param {number} size - Current tool size
   */
  updateRemoteCursor(userId, x, y, size) {
    if (this._shouldSuppressLiveUser(userId)) {
      this._setUserVisibility(userId, false);
      return;
    }
    this.notifyUserActive(userId);
    this.markRemoteCursorActivity(userId);

    // Coalesce DOM writes: only the latest position per user matters
    // per frame. Writing every incoming MM message (~50/sec/user) was
    // dominating the trace via SVG attribute thrash.
    this._pendingCursorWrites.set(userId, { x, y, size });
    if (!this._cursorFlushScheduled) {
      this._cursorFlushScheduled = true;
      requestAnimationFrame(() => this._flushCursorWrites());
    }
  }

  _flushCursorWrites() {
    this._cursorFlushScheduled = false;
    const pending = this._pendingCursorWrites;
    if (pending.size === 0) return;
    for (const [userId, { x, y, size }] of pending) {
      const cursorElements = this.cursors.get(userId);
      if (!cursorElements) continue;
      const { cursor, circle, square, crosshair } = cursorElements;

      if (cursor) {
        cursor.style.transform = `translate(${x - 100}px, ${y - 100}px)`;
      }
      if (circle) {
        circle.setAttribute('cx', x);
        circle.setAttribute('cy', y);
      }
      if (square) {
        square.setAttribute('x', x - size);
        square.setAttribute('y', y - size);
      }
      if (crosshair) {
        crosshair.setAttribute('transform', `translate(${x}, ${y})`);
      }
    }
    pending.clear();
  }

  /**
   * Update remote cursor tool display based on tool type.
   * @param {string} userId - User's session ID
   * @param {string} tool - Current tool name
   */
  updateRemoteToolDisplay(userId, tool) {
    if (this._shouldSuppressLiveUser(userId)) {
      this._setUserVisibility(userId, false);
      return;
    }
    // The tool shapes (circle/square/crosshair) live in the shared cursors SVG,
    // not under the per-user `.cursor` wrapper, so painting them here would
    // show them even while that wrapper is hidden. _setCursorLayerVisibility
    // re-applies the current tool when the cursor legitimately comes back.
    if (this._isCursorSuppressed(userId)) return;
    this._applyRemoteToolDisplay(userId, tool);
    this._scheduleCursorIdleHide(userId);
  }

  /**
   * Update remote user's tool size.
   * @param {string} userId - User's session ID
   * @param {number} size - Current tool size
   */
  updateRemoteSize(userId, size) {
    if (this._shouldSuppressLiveUser(userId)) return;
    const cursorElements = this.cursors.get(userId);
    const circle = cursorElements?.circle;
    const square = cursorElements?.square;
    const text = cursorElements?.text;

    if (circle) circle.setAttribute('r', size);
    if (square) {
      square.setAttribute('width', size * 2);
      square.setAttribute('height', size * 2);
    }
    if (text) {
      text.style.fontSize = `${size + 5}px`;
    }
  }

  /**
   * Update remote user's color.
   * @param {string} userId - User's session ID
   * @param {Array} color - [r, g, b, a] color array
   */
  updateRemoteColor(userId, color) {
    if (this._shouldSuppressLiveUser(userId)) return;
    const id = `u${userId}`;
    const circle = document.querySelector(`.circle.${id}`);
    const text = document.querySelector(`.text.${id}`);
    const colorEntry = document.querySelector(`.listColor.${id}`);

    if (circle) circle.setAttribute('stroke', `rgba(${color.join(',')})`);
    if (text) {
      const [r, g, b, a] = color;
      text.style.color = `rgba(${r}, ${g}, ${b}, ${a * a})`;
    }
    if (colorEntry) colorEntry.style.backgroundColor = `rgba(${color.join(',')})`;

    // Propagate to group header if this is the display user
    for (const [ipHash, group] of this.userGroups.entries()) {
      if (group.userIds.has(userId) && group.displayUserId === userId) {
        group.headerColorEl.style.backgroundColor = `rgba(${color.join(',')})`;
        break;
      }
    }
  }

  /**
   * Toggle supporter gold styling on a remote user's cursor and name label.
   * @param {string} userId - User's session ID
   * @param {boolean} isSupporter - Whether the user is an active supporter
   */
  setRemoteUserSupporter(userId, isSupporter) {
    const cursorElements = this.cursors.get(userId);
    if (!cursorElements) return;
    const on = !!isSupporter;
    for (const el of [cursorElements.circle, cursorElements.square, cursorElements.crosshair, cursorElements.name]) {
      el?.classList.toggle('supporter', on);
    }
  }

  /**
   * Update remote user's name display.
   * @param {string} userId - User's session ID
   * @param {string} name - New username
   */
  updateRemoteName(userId, name) {
    if (this._shouldSuppressLiveUser(userId)) return;
    const id = `u${userId}`;
    const nameEl = document.querySelector(`.name.${id}`);
    const userEl = document.querySelector(`.listUser.${id}`);
    const entry = document.querySelector(`.userEntry.${id}`);

    if (nameEl) nameEl.textContent = name;
    if (userEl) userEl.textContent = name;
    if (entry) {
      this._setEntrySortMetadata(entry, {
        name,
        joined: this._joinTimestamps.get(String(userId)) || Number(entry.dataset.joinedAt || 0) || Date.now(),
        active: this._recentActivity.get(String(userId)) || Number(entry.dataset.recentActivity || 0) || Date.now()
      });
    }

    // Propagate to group header if this is the display user
    for (const [ipHash, group] of this.userGroups.entries()) {
      if (String(group.displayUserId) === String(userId) && Array.from(group.userIds).some((id) => String(id) === String(userId))) {
        group.headerNameEl.textContent = name;
        this._syncGroupSortMetadata(ipHash);
        break;
      }
    }

    this._applyUserListSort();
  }

  setRemoteUserMuted(userId, muted) {
    const id = `u${userId}`;
    const key = String(userId);
    const wasMuted = this._mutedUsers.has(key);
    if (muted) this._mutedUsers.add(key);
    else this._mutedUsers.delete(key);

    if (muted && !wasMuted) {
      this.hideRemoteCursor(userId);
    } else if (!muted && wasMuted && !this._isCursorSuppressed(userId)) {
      // The unmute's SHOW_CURSOR arrives before the USERS row that clears
      // isMuted, so it is swallowed by the suppression check above; bring the
      // cursor back here instead of waiting for their next pointer move.
      this.showRemoteCursor(userId);
    }

    const entry = document.querySelector(`.userEntry.${id}`);
    const userEl = document.querySelector(`.listUser.${id}`);
    this._applyMutedStateToEntry(entry, userEl, muted);

    for (const [ipHash, group] of this.userGroups.entries()) {
      if (String(group.displayUserId) === String(userId) && Array.from(group.userIds).some((id) => String(id) === String(userId))) {
        const header = group.element.querySelector('.groupHeader');
        this._applyMutedStateToEntry(header, group.headerNameEl, muted);
        this._updateGroupSummary(ipHash);
        break;
      }
    }
  }

  setRemoteUserShadowBanned(userId, shadowBanned) {
    const id = `u${userId}`;
    const entry = document.querySelector(`.userEntry.${id}`);
    const userEl = document.querySelector(`.listUser.${id}`);
    this._applyShadowBannedStateToEntry(entry, userEl, shadowBanned);

    for (const [ipHash, group] of this.userGroups.entries()) {
      if (String(group.displayUserId) === String(userId) && Array.from(group.userIds).some((id) => String(id) === String(userId))) {
        const header = group.element.querySelector('.groupHeader');
        this._applyShadowBannedStateToEntry(header, group.headerNameEl, shadowBanned);
        break;
      }
    }
  }

  /**
   * Update remote user's text input (for text tool).
   * @param {string} userId - User's session ID
   * @param {string} textContent - New text content
   */
  updateRemoteText(userId, textContent) {
    if (this._shouldSuppressLiveUser(userId)) return;
    const cursorElements = this.cursors.get(userId);
    if (cursorElements && cursorElements.textInput) {
      renderRemotePreviewContent(cursorElements.textInput, textContent);
    }
    if (textContent) {
      this._setCursorLayerVisibility(userId, true);
    }
    this._scheduleCursorIdleHide(userId);
  }

  updateRemoteFont(userId, font) {
    if (this._shouldSuppressLiveUser(userId)) return;
    const cursorElements = this.cursors.get(userId);
    if (cursorElements?.text) {
      cursorElements.text.style.fontFamily = normalizeTextFont(font);
      if (cursorElements.textInput) {
        cursorElements.textInput.style.fontFamily = normalizeTextFont(font);
      }
      const user = window.app?.users?.get(Number(userId));
      if (user) this.updateRemoteTextLayout(userId, user);
    }
  }

  updateRemoteTextLayout(userId, user) {
    if (this._shouldSuppressLiveUser(userId)) return;
    const cursorElements = this.cursors.get(userId);
    if (!cursorElements?.text || !user) return;

    const layout = getPreviewTextLayout(user);
    const normalizedFont = normalizeTextFont(user.font);
    const lineHeight = getTextLineHeight(layout.fontSize, normalizedFont);
    cursorElements.text.style.left = `${layout.domLeft}px`;
    cursorElements.text.style.top = `${layout.domTop}px`;
    cursorElements.text.style.fontSize = `${layout.fontSize}px`;
    cursorElements.text.style.fontFamily = normalizedFont;
    cursorElements.text.style.lineHeight = `${lineHeight}px`;
    if (cursorElements.textInput) {
      cursorElements.textInput.style.fontFamily = normalizedFont;
      cursorElements.textInput.style.lineHeight = `${lineHeight}px`;
    }
  }

  /**
   * Show or hide the DOM text element for a remote user.
   * Used to hide it when blend mode requires canvas rendering instead.
   * @param {string} userId - User's session ID
   * @param {boolean} visible - Whether to show the element
   */
  setRemoteTextDomVisible(userId, visible) {
    if (this._shouldSuppressLiveUser(userId)) return;
    const cursorElements = this.cursors.get(userId);
    if (cursorElements && cursorElements.text) {
      cursorElements.text.style.visibility = visible ? '' : 'hidden';
    }
  }

  /**
   * Set remote user's AFK state visualization.
   * @param {string} userId - User's session ID
   * @param {boolean} afk - Whether the user is AFK
   */
  setRemoteUserAfk(userId, afk) {
    if (this._shouldSuppressLiveUser(userId)) return;
    const id = `u${userId}`;
    const cursor = document.querySelector(`.cursor.${id}`);
    const userEntry = document.querySelector(`.userEntry.${id}`);
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const crosshair = document.querySelector(`.crosshair.${id}`);

    const opacity = afk ? '0.5' : '1';
    if (cursor) cursor.style.opacity = opacity;
    if (circle) circle.style.opacity = opacity;
    if (square) square.style.opacity = opacity;
    if (crosshair) crosshair.style.opacity = opacity;
    if (userEntry) userEntry.style.opacity = opacity;

    const tool = window.app?.users?.get(Number(userId))?.tool ?? 'brush';
    this.updateRemoteToolIcon(userId, tool);

    // Going AFK dims the cursor but never retired it, and an AFK user sends
    // nothing further — so no later event would ever arm the idle-hide. Arm it
    // on the transition itself; markRemoteCursorActivity brings the cursor back
    // the moment they move again.
    this._scheduleCursorIdleHide(userId);
  }

  /**
   * Remove all UI elements for a remote user.
   * @param {string} userId - User's session ID
   */
  removeRemoteUser(userId) {
    this._clearCursorIdleTimer(userId);
    this._mutedUsers.delete(String(userId));
    const id = `u${userId}`;
    document.querySelector(`.cursor.${id}`)?.remove();
    document.querySelector(`.circle.${id}`)?.remove();
    document.querySelector(`.square.${id}`)?.remove();
    document.querySelector(`.crosshair.${id}`)?.remove();
    document.querySelector(`.userEntry.${id}`)?.remove();
    // querySelectorAll, not querySelector: duplicates should no longer be
    // created, but a single-element removal is what let the old ones survive a
    // whole session, and sweeping costs nothing.
    document.querySelectorAll(`.userBoard.${id}`).forEach((el) => el.remove());
    this.cursors.delete(userId);
    this._joinTimestamps.delete(String(userId));
    this._recentActivity.delete(String(userId));
    this._lastNotifyActiveAt.delete(String(userId));
    const highlightTimer = this._activeHighlightTimers.get(String(userId));
    if (highlightTimer) {
      clearTimeout(highlightTimer);
      this._activeHighlightTimers.delete(String(userId));
    }
    this.removeRemoteUserFromGroup(userId);
    this._applyUserListSort();
  }

  removeRemoteUserFromGroup(userId) {
    for (const [ipHash, group] of this.userGroups.entries()) {
      if (group.userIds.has(userId)) {
        group.userIds.delete(userId);
        this._groupUserIndex.delete(String(userId));
        
        // If only 1 user left, dissolve the group
        if (group.userIds.size === 1) {
          const lastUserId = Array.from(group.userIds)[0];
          const lastEntry = group.usersContainer.querySelector(`.userEntry.u${lastUserId}`);
          if (lastEntry) {
            // Move back to main list (before the group element to maintain rough order)
            this.elements.userList.insertBefore(lastEntry, group.element);
          }
          if (group.pendingDisplayUpdate !== null) clearTimeout(group.pendingDisplayUpdate);
          if (group.pendingRefreshTimer !== null) clearTimeout(group.pendingRefreshTimer);
          this._groupUserIndex.delete(String(lastUserId));
          group.element.remove();
          this.userGroups.delete(ipHash);
        } else if (group.userIds.size === 0) {
          if (group.pendingDisplayUpdate !== null) clearTimeout(group.pendingDisplayUpdate);
          if (group.pendingRefreshTimer !== null) clearTimeout(group.pendingRefreshTimer);
          group.element.remove();
          this.userGroups.delete(ipHash);
        } else {
          this._updateGroupSummary(ipHash);
          // If the display user left, promote another user
          if (group.displayUserId === userId) {
            const nextId = Array.from(group.userIds)[0];
            group.displayUserId = nextId;
            this._setGroupDisplayUser(ipHash, nextId);
          }
          this._syncGroupSortMetadata(ipHash);
        }
        break;
      }
    }
  }

  /**
   * Get remote user's canvas board elements.
   * @param {string} userId - User's session ID
   * @returns {Object|null} - Board and context or null
   */
  getRemoteUserBoard(userId) {
    const id = `u${userId}`;
    const board = document.querySelector(`.userBoard.${id}`);
    if (!board) return null;
    return {
      board,
      context: board.getContext('2d')
    };
  }

  /**
   * Hide remote user's cursor elements.
   * @param {string} userId - User's session ID
   */
  hideRemoteCursor(userId) {
    if (this._shouldSuppressLiveUser(userId)) {
      this._setUserVisibility(userId, false);
      return;
    }
    this._clearCursorIdleTimer(userId);
    this._setCursorLayerVisibility(userId, false);
  }

  /**
   * Show remote user's cursor elements.
   * @param {string} userId - User's session ID
   */
  showRemoteCursor(userId) {
    if (this._shouldSuppressLiveUser(userId)) {
      this._setUserVisibility(userId, false);
      return;
    }
    this._setCursorLayerVisibility(userId, true);
    this._scheduleCursorIdleHide(userId);
  }

  /**
   * Update tool icon in user list for a remote user.
   * @param {string} userId - User's session ID
   * @param {string} tool - Tool name
   */
  updateRemoteToolIcon(userId, tool) {
    const id = `u${userId}`;
    const afk = !!window.app?.users?.get(Number(userId))?.afk;
    const toolEntry = document.querySelector(`.listTool.${id}`);
    if (toolEntry) {
      toolEntry.innerHTML = '';
      const iconEl = this._iconToElement(this._getUserListIcon(tool, afk));
      if (iconEl) toolEntry.appendChild(iconEl);
    }

    // Propagate to group header if this is the display user
    const groupInfo = this._getGroupForUser(userId);
    if (groupInfo?.group.displayUserId === userId) {
      groupInfo.group.headerToolEl.innerHTML = '';
      const iconEl = this._iconToElement(this._getUserListIcon(tool, afk));
      if (iconEl) groupInfo.group.headerToolEl.appendChild(iconEl);
    }
  }

  /**
   * Maps a numeric role (0-8) to a CSS class name.
   * @param {number} role
   * @returns {string|null}
   */
  static roleToClass(role) {
    if (role >= 9) return 'rank-deity';
    if (role >= 8) return 'rank-holy';
    if (role >= 7) return 'rank-noble';
    if (role >= 5) return 'rank-admin';
    if (role >= 4) return 'rank-mod';
    if (role >= 3) return 'rank-helper';
    if (role >= 2) return 'rank-trusted';
    if (role >= 1) return 'rank-user';
    return 'rank-guest';
  }

  /**
   * Maps a numeric role (0-8) to a display name.
   * @param {number} role
   * @returns {string}
   */
  static roleName(role) {
    const names = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    return names[role] || 'Guest';
  }
}
