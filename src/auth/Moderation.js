/**
 * Client-side Moderation module
 * Manages context menu, mod panel, action dialogs, and role-based visibility.
 */
export class Moderation {
  constructor() {
    // Numeric role (10-tier; see server/SessionManager.js Role):
    //   Room-scoped: GUEST(0) USER(1) TRUSTED(2) HELPER(3) MOD(4) ADMIN(5) OWNER(6)
    //   Global:      NOBLE(7) HOLY(8) DEITY(9)
    this.localRole = 0;
    this.globalRole = 0;
    this.roomRole = 0;

    // Mod panel state
    this.modEntries = [];
    // 'all' | 'bans' | 'mutes' | 'shadowbans' — chip filter on the unified list.
    this.filterType = 'all';
    this.panelVisible = false;
    this.showHistory = false;
    this.searchQuery = '';

    // Whether mod UI elements have been injected into the DOM
    this._modUIInjected = false;

    // Context menu state
    this.targetSessionIndex = null;
    this.targetUser = null;
    this.targetIpHash = null;

    // Callbacks wired by App.js
    this.onProfile = null;
    this.onSync = null;
    this.onSpectate = null;
    this.onPM = null;
    this.onModAction = null;         // (actionType, sessionIndex, reason, duration, ipScope?)
    this.onModUpdateReason = null;   // (originalActionCode, sessionIndex, reason)
    this.onModGroupUpdateReason = null; // (action, ipHash, reason)
    this.onRequestModList = null;    // ({ showHistory, search })
    this.onRevokeEntry = null;       // (entryId, type)
    this.onModUpdateDuration = null; // (entryId, minutes)
    this.onModWipe = null;           // (sessionIndex, targetName)
    this.onClear = null;             // ()
    this.onRoomRoleSet = null;       // (targetUserId, role)
    this.onGlobalRoleSet = null;     // (targetUsername, newGlobalRole)
    this._wipePromptDismiss = null;
    this._clearPromptDismiss = null;
  }

  setRole(role, globalRole = role, roomRole = 0) {
    this.localRole = role;
    this.globalRole = globalRole;
    this.roomRole = roomRole;
    this.updateModVisibility();
  }

  isMod() {
    return this.localRole >= 4;  // MOD(4)+
  }

  isAdmin() {
    return this.roomRole >= 5 || this.globalRole >= 8;  // room ADMIN(5)+ or global HOLY(8)+
  }

  /**
   * Mirrors the server's Action.CLEAR_CANVAS rule (server/permissions.js:
   * ACTION_MIN_ROLE = MOD(4), GLOBAL_ACTION_MIN_ROLE = HOLY(8)).
   *
   * Deliberately NOT isMod(): that uses localRole, the *effective* role
   * max(globalRole, roomRole), while the server only ever checks the two
   * separately. A global NOBLE(7) with no room role passes isMod() but fails
   * the server check, so the board cleared locally while the server dropped
   * the broadcast — "only they see it cleared".
   * @returns {boolean}
   */
  canClearCanvas() {
    return this.roomRole >= 4 || this.globalRole >= 8;  // room MOD(4)+ or global HOLY(8)+
  }

  isOwner() {
    return this.localRole >= 6;  // OWNER(6)+
  }

  isDeity() {
    return this.localRole >= 9;  // DEITY(9) only
  }

  isHolyOrDeity() {
    return this.localRole >= 8;  // HOLY(8)+
  }

  canManageRoomRoles() {
    return this.roomRole >= 5 || this.globalRole >= 8;  // room ADMIN(5)+ or global HOLY(8)+
  }

  canMute() {
    return this.localRole >= 2;  // TRUSTED(2)+
  }

  canSilence() {
    return this.localRole >= 2;  // TRUSTED(2)+
  }

  canKickBanOrWipe() {
    return this.localRole >= 4;  // MOD(4)+
  }

  canUseMenuAction(action, targetUser, isGroup = false) {
    // For per-user actions (not group), enforce strict rank: actor must outrank target.
    const targetRole = !isGroup && targetUser ? (targetUser.role || 0) : -1;
    const outranks = isGroup || this.localRole > targetRole;
    switch (action) {
      case 'mute':
        return this.canMute() && outranks;
      case 'silence':
        return this.canSilence() && outranks;
      case 'kick':
      case 'ban':
      case 'wipe':
        return this.canKickBanOrWipe() && outranks;
      case 'shadowban':
        return !isGroup && this.isHolyOrDeity() && outranks;
      case 'promoteNoble':
      case 'promoteHoly':
      case 'demoteGlobal':
        return !isGroup && this.isDeity();
      case 'promote':
      case 'demote':
        return !isGroup && !!targetUser && this.canManageRoomRoles();
      case 'profile':
      case 'sync':
      case 'spectate':
        return !isGroup;
      default:
        return true;
    }
  }

  static roleName(role) {
    const names = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    return names[role] || 'Guest';
  }

  static roleClass(role) {
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

  _ensureContextMenuInfo(menu) {
    let info = menu.querySelector('.menuInfo');
    if (info) return info;

    info = document.createElement('div');
    info.className = 'menuInfo';
    menu.prepend(info);
    return info;
  }

  _renderContextMenuInfo(menu, targetUser, ipHash = null) {
    const info = this._ensureContextMenuInfo(menu);
    const rows = [];

    if (targetUser) {
      const role = targetUser.role || 0;
      const roleName = Moderation.roleName(role);
      const targetName = targetUser.username || targetUser.name || targetUser.registeredName || 'Unknown';
      rows.push({ value: `${roleName} ${targetName}`, className: `menuInfoName ${Moderation.roleClass(role)}` });
      if (targetUser.visibleIp) {
        rows.push({ label: 'IP', value: targetUser.visibleIp });
      }
    } else if (ipHash) {
      rows.push({ label: 'Group', value: ipHash });
    }

    info.innerHTML = rows.map(({ label, value, className = '' }) => (
      `<div class="menuInfoRow">${label ? `<span class="menuInfoLabel">${this.escapeHtml(label)}</span>` : ''}<span class="menuInfoValue ${this.escapeHtml(className)}">${this.escapeHtml(String(value || ''))}</span></div>`
    )).join('');
    info.style.display = rows.length > 0 ? 'flex' : 'none';
  }

  /**
   * Show/hide .modOnly elements based on current role.
   * Injects mod-only toolbar buttons and panel into the DOM on first mod+ login.
   */
  updateModVisibility() {
    const hasToolbar = !!document.getElementById('bansBtn');
    const hasPanel = !!document.getElementById('modPanel');

    if (this.isMod() && (!this._modUIInjected || !hasToolbar || !hasPanel)) {
      this._injectModUI();
      // Injected buttons change the toolbar width — re-measure collapse state.
      window.app?.scheduleTopbarCollapseUpdate?.();
    }

    const elements = document.querySelectorAll('.modOnly');
    elements.forEach(el => {
      if (this.isMod()) {
        el.classList.add('visible');
      } else {
        el.classList.remove('visible');
      }
    });

    // The Debug button is not .modOnly — a non-mod can enable it in settings —
    // so App owns it, but a role change still has to re-evaluate it.
    window.app?.refreshDebugButton?.();

    // Clearing is authorized separately from general mod powers, so keep the
    // button in step with the server rather than with isMod() — otherwise it
    // is offered to someone whose clear the server will reject.
    const clearWrap = document.querySelector('.clearConfirmWrap');
    if (clearWrap) clearWrap.classList.toggle('visible', this.canClearCanvas());

    // Admin-only elements (role assignment submenu) need ADMIN(5)+
    const adminElements = document.querySelectorAll('.adminOnly');
    adminElements.forEach(el => {
      if (this.isAdmin()) {
        el.classList.add('admin-visible');
      } else {
        el.classList.remove('admin-visible');
      }
    });

    // Gate the Shadow filter chip in the mod panel to HOLY+. The context-menu
    // visibility loop only touches .menuItem, so this needs its own handling.
    const isHolyOrDeity = this.isHolyOrDeity();
    document.querySelectorAll('.modChip.holyOrDeityOnly').forEach(el => {
      el.style.display = isHolyOrDeity ? '' : 'none';
    });
    if (!isHolyOrDeity && this.filterType === 'shadowbans') {
      this.setFilterType('all');
    }
  }

  /**
   * Dynamically create and inject mod-only toolbar buttons and mod panel.
   * Called once when user is first confirmed as mod+.
   */
  _injectModUI() {
    const hasToolbar = !!document.getElementById('bansBtn');
    const hasPanel = !!document.getElementById('modPanel');
    if (hasToolbar && hasPanel) {
      this._modUIInjected = true;
      return;
    }

    // --- Left-side toolbar buttons (Clear) ---
    const collapsible = document.getElementById('collapsibleBtns');
    if (collapsible && !document.getElementById('clearBtn')) {
      const fragment = document.createDocumentFragment();

      // Clear button (inserted at the start of collapsible)
      const clearWrap = document.createElement('div');
      clearWrap.className = 'clearConfirmWrap modOnly';

      const clearBtn = document.createElement('a');
      clearBtn.className = 'btn';
      clearBtn.id = 'clearBtn';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', (event) => {
        event.preventDefault();
        this._showClearPrompt(clearBtn);
      });
      clearWrap.appendChild(clearBtn);
      fragment.appendChild(clearWrap);

      // Insert before the first child so Clear appears first
      collapsible.insertBefore(fragment, collapsible.firstChild);
    }

    // --- Bans button, right side between Save and Room Settings ---
    const roomSettingsBtn = document.getElementById('roomSettingsBtn');
    if (roomSettingsBtn && !hasToolbar) {
      const bansBtn = document.createElement('a');
      bansBtn.className = 'btn modOnly';
      bansBtn.id = 'bansBtn';
      bansBtn.title = 'Bans & Mutes';
      bansBtn.textContent = 'Mod';
      bansBtn.addEventListener('click', () => this.togglePanel());
      roomSettingsBtn.parentNode.insertBefore(bansBtn, roomSettingsBtn);
    }

    // --- Mod panel ---
    const boardContainer = document.getElementById('boardContainer');
    if (boardContainer && !hasPanel) {
      const panel = document.createElement('div');
      panel.id = 'modPanel';
      panel.style.display = 'none';
      panel.innerHTML = `
        <div id="modPanelHeader">
          <span class="modPanelTitle">Bans &amp; Mutes</span>
          <button class="chatCloseBtn" id="modPanelCloseBtn">&times;</button>
        </div>
        <div class="modPanelControls">
          <input type="text" id="modSearchInput" class="modSearchInput" placeholder="Search username..." autocomplete="off">
          <button class="modHistoryToggle" id="modHistoryToggle">Active Only</button>
        </div>
        <div class="modFilterChips">
          <button class="modChip active" data-filter="all">All</button>
          <button class="modChip" data-filter="bans">Bans</button>
          <button class="modChip" data-filter="mutes">Mutes</button>
          <button class="modChip" data-filter="silences">Silences</button>
          <button class="modChip holyOrDeityOnly" data-filter="shadowbans">Shadow</button>
        </div>
        <div id="modEntryList" class="modEntryList">
          <div class="modNoEntries">No entries</div>
        </div>
      `;
      boardContainer.appendChild(panel);

      // Wire mod panel event listeners
      panel.querySelector('#modPanelCloseBtn')?.addEventListener('click', () => this.hidePanel());

      panel.querySelectorAll('.modChip').forEach(chip => {
        chip.addEventListener('click', () => this.setFilterType(chip.dataset.filter));
      });

      const searchInput = panel.querySelector('#modSearchInput');
      if (searchInput) {
        let searchDebounce = null;
        searchInput.addEventListener('input', () => {
          clearTimeout(searchDebounce);
          searchDebounce = setTimeout(() => this.setSearch(searchInput.value.trim()), 300);
        });
        searchInput.addEventListener('keydown', (e) => e.stopPropagation());
      }

      const historyToggle = panel.querySelector('#modHistoryToggle');
      if (historyToggle) {
        historyToggle.addEventListener('click', () => this.setShowHistory(!this.showHistory));
      }
    }

    this._modUIInjected = !!document.getElementById('bansBtn') && !!document.getElementById('modPanel');
  }

  /**
   * Position and show the user context menu
   */
  showContextMenu(event, targetSessionIndex, targetUser, ipHash = null) {
    event.preventDefault();
    event.stopPropagation();

    this.targetSessionIndex = targetSessionIndex;
    this.targetUser = targetUser;
    this.targetIpHash = ipHash;

    const menu = document.getElementById('userContextMenu');
    if (!menu) return;
    this._ensureSpectateMenuItem(menu);

    const isGroup = ipHash && !targetSessionIndex && targetSessionIndex !== 0;
    const isRegistered = targetUser && (targetUser.registeredName || targetUser.role >= 1);
    const isDeity = this.localRole >= 9;
    const isHolyOrDeity = this.localRole >= 8;

    this._renderContextMenuInfo(menu, targetUser, ipHash);

    // Update mute button text based on whether user is already muted
    const muteBtn = menu.querySelector('[data-action="mute"]');
    if (muteBtn && targetUser && this.canMute()) {
      muteBtn.textContent = targetUser.isMuted ? 'Unmute' : 'Mute';
    }

    const silenceBtn = menu.querySelector('[data-action="silence"]');
    if (silenceBtn && targetUser && this.canSilence()) {
      silenceBtn.textContent = targetUser.isSilenced ? 'Unsilence' : 'Silence';
    }

    menu.querySelectorAll('.menuItem').forEach(item => {
      const action = item.dataset.action;
      const visible =
        (!item.classList.contains('group-only') || isGroup) &&
        (!item.classList.contains('registered-only') || isRegistered) &&
        (!item.classList.contains('deityOnly') || isDeity) &&
        (!item.classList.contains('holyOrDeityOnly') || isHolyOrDeity) &&
        (!action || this.canUseMenuAction(action, targetUser, isGroup));

      item.style.display = visible ? '' : 'none';
    });

    menu.style.display = 'flex';

    // Position at click, clamped to viewport
    const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 10);
    const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  hideContextMenu() {
    const menu = document.getElementById('userContextMenu');
    if (menu) {
      menu.style.display = 'none';
    }
    this.targetSessionIndex = null;
    this.targetUser = null;
    this.targetIpHash = null;
  }

  _ensureSpectateMenuItem(menu) {
    if (menu.querySelector('[data-action="spectate"]')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menuItem';
    button.dataset.action = 'spectate';
    button.textContent = 'Spectate';

    const syncButton = menu.querySelector('[data-action="sync"]');
    if (syncButton?.parentElement === menu) {
      syncButton.insertAdjacentElement('afterend', button);
    } else {
      menu.appendChild(button);
    }
  }

  /**
   * Handle context menu button clicks
   */
  async handleMenuAction(action, dataset = {}) {
    const sessionIndex = this.targetSessionIndex;
    const user = this.targetUser;
    const ipHash = this.targetIpHash;
    const anchorRect = this._getWipePromptAnchorRect(sessionIndex, ipHash);
    this.hideContextMenu();

    if (!sessionIndex && sessionIndex !== 0 && !ipHash) return;

    const isGroup = !!(ipHash && !sessionIndex && sessionIndex !== 0);
    const targetName = isGroup ? `Group ${ipHash}` : (user?.username || `User ${sessionIndex}`);
    const targetUsername = user?.username || targetName;

    switch (action) {
      case 'profile':
        if (this.onProfile) {
          const profileName = user?.registeredName || user?.username;
          if (profileName) this.onProfile(profileName);
        }
        return;
      case 'promote': {
        if (user && this.onRoomRoleSet) {
          const newRole = Math.min((user.role || 0) + 1, 5);
          this.onRoomRoleSet(sessionIndex, newRole);
        }
        return;
      }
      case 'demote': {
        if (user && this.onRoomRoleSet) {
          const newRole = Math.max((user.role || 0) - 1, 0);
          this.onRoomRoleSet(sessionIndex, newRole);
        }
        return;
      }
      case 'promoteNoble': {
        if (user && this.onGlobalRoleSet) {
          const targetUsername = user.registeredName || user.username || user.name;
          if (!targetUsername) {
            alert('Could not determine username for this user');
            return;
          }
          if (await window.showAppConfirm(`Promote ${targetUsername} to Noble (global rank)?`, {
            title: 'Promote global rank',
            confirmLabel: 'Promote'
          })) {
            this.onGlobalRoleSet(targetUsername, 7); // Noble = 7
          }
        }
        return;
      }
      case 'promoteHoly': {
        if (user && this.onGlobalRoleSet) {
          const targetUsername = user.registeredName || user.username || user.name;
          if (!targetUsername) {
            alert('Could not determine username for this user');
            return;
          }
          if (await window.showAppConfirm(`Promote ${targetUsername} to Holy (global rank)?`, {
            title: 'Promote global rank',
            confirmLabel: 'Promote'
          })) {
            this.onGlobalRoleSet(targetUsername, 8); // Holy = 8
          }
        }
        return;
      }
      case 'demoteGlobal': {
        if (user && this.onGlobalRoleSet) {
          const targetUsername = user.registeredName || user.username || user.name;
          if (!targetUsername) {
            alert('Could not determine username for this user');
            return;
          }
          const currentGlobalRole = user.globalRole || user.role || 0;
          if (currentGlobalRole >= 7) {
            // Demote from Noble/Holy to USER (1)
            if (await window.showAppConfirm(`Demote ${targetUsername} from global rank ${currentGlobalRole} to User?`, {
              title: 'Demote global rank',
              confirmLabel: 'Demote',
              danger: true
            })) {
              this.onGlobalRoleSet(targetUsername, 1); // USER = 1
            }
          }
        }
        return;
      }
      case 'sync':
        if (this.onSync) this.onSync(sessionIndex);
        break;
      case 'spectate':
        if (this.onSpectate) this.onSpectate(sessionIndex);
        break;
      case 'pm':
        if (this.onPM) this.onPM(sessionIndex, user);
        break;
      case 'wipe': {
        const targetLabel = isGroup ? `all users in IP group ${ipHash}` : targetName;
        if (await window.showAppConfirm(`Wipe all strokes from ${targetLabel}?`, {
          title: 'Wipe strokes?',
          confirmLabel: 'Wipe',
          danger: true
        })) {
          if (isGroup) {
            if (this.onModGroupAction) this.onModGroupAction('wipe', ipHash);
          } else {
            if (this.onModWipe) this.onModWipe(sessionIndex, user?.username || '');
          }
        }
        break;
      }
      case 'mute':
        if (user?.isMuted && !ipHash) {
          // Unmute immediately
          if (this.onModAction) this.onModAction(3, sessionIndex, '', 0);
        } else if (isGroup) {
          // Group mutes use the legacy instant flow (no per-user duration picker for groups).
          if (this.onModGroupAction) this.onModGroupAction('mute', ipHash, '', 10);
          this.showWipePromptAfterAction('Muted', targetName, isGroup, sessionIndex, ipHash, targetUsername, anchorRect);
          this.showReasonCard('mute', sessionIndex, targetName, isGroup, ipHash);
        } else {
          // Mutes defer until the mod confirms duration + reason in the card.
          this.showReasonCard('mute', sessionIndex, targetName, false, ipHash, {
            deferred: true,
            targetUsername,
            anchorRect
          });
        }
        break;
      case 'silence':
        if (user?.isSilenced && !ipHash) {
          // Unsilence immediately
          if (this.onModAction) this.onModAction(10, sessionIndex, '', 0);
        } else if (isGroup) {
          return;
        } else {
          this.showReasonCard('silence', sessionIndex, targetName, false, ipHash, {
            deferred: true,
            targetUsername,
            anchorRect
          });
        }
        break;
      case 'kick':
        // Kick immediately, then offer reason
        console.log('[Mod] Kick clicked, sessionIndex:', sessionIndex, 'isGroup:', isGroup, 'ipHash:', ipHash, 'onModAction:', !!this.onModAction);
        if (isGroup) {
          if (this.onModGroupAction) this.onModGroupAction('kick', ipHash, '', 0);
        } else {
          if (this.onModAction) this.onModAction(0, sessionIndex, '', 0);
        }
        this.showWipePromptAfterAction('Kicked', targetName, isGroup, sessionIndex, ipHash, targetUsername, anchorRect);
        this.showReasonCard('kick', sessionIndex, targetName, isGroup, ipHash);
        break;
      case 'ban':
        // Bans defer until the mod confirms scope + reason in the card.
        // Group bans use the legacy instant flow (no per-IP scope picker for groups).
        if (isGroup) {
          if (this.onModGroupAction) this.onModGroupAction('ban', ipHash, '', 1440);
          this.showWipePromptAfterAction('Banned', targetName, isGroup, sessionIndex, ipHash, targetUsername, anchorRect);
          this.showReasonCard('ban', sessionIndex, targetName, isGroup, ipHash);
        } else {
          this.showReasonCard('ban', sessionIndex, targetName, false, ipHash, {
            deferred: true,
            targetUsername,
            anchorRect
          });
        }
        break;
      case 'shadowban':
        if (isGroup) return;
        this.showReasonCard('shadowban', sessionIndex, targetName, false, ipHash, {
          deferred: true,
          targetUsername,
          anchorRect
        });
        break;
    }
  }

  _showClearPrompt(anchor) {
    const existing = document.getElementById('clearConfirmPrompt');
    if (existing) existing.remove();
    if (this._clearPromptDismiss) {
      this._clearPromptDismiss();
      this._clearPromptDismiss = null;
    }

    const prompt = document.createElement('div');
    prompt.id = 'clearConfirmPrompt';
    prompt.className = 'clearConfirmPrompt';
    prompt.innerHTML = `
      <div class="clearConfirmText">Clear ALL layers?</div>
      <div class="clearConfirmActions">
        <button class="clearConfirmBtn clearConfirmBtn-danger" type="button">Clear</button>
        <button class="clearConfirmBtn" type="button">Cancel</button>
      </div>
    `;
    document.body.appendChild(prompt);
    this._positionClearPrompt(prompt, anchor);
    requestAnimationFrame(() => prompt.classList.add('clearConfirmPrompt-visible'));

    const clearBtn = prompt.querySelector('.clearConfirmBtn-danger');
    const cancelBtn = prompt.querySelectorAll('.clearConfirmBtn')[1];

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      prompt.classList.remove('clearConfirmPrompt-visible');
      setTimeout(() => prompt.remove(), 180);
      if (this._clearPromptDismiss === dismiss) {
        this._clearPromptDismiss = null;
      }
    };
    this._clearPromptDismiss = dismiss;

    clearBtn?.addEventListener('click', () => {
      if (this.onClear) this.onClear();
      dismiss();
    });
    cancelBtn?.addEventListener('click', dismiss);
  }

  _positionClearPrompt(prompt, anchor) {
    const margin = 8;
    const anchorRect = anchor?.getBoundingClientRect?.();
    if (!anchorRect) {
      prompt.style.left = `${margin}px`;
      prompt.style.top = `${margin}px`;
      return;
    }

    const promptRect = prompt.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + 8;

    if (left + promptRect.width > window.innerWidth - margin) {
      left = window.innerWidth - promptRect.width - margin;
    }
    if (left < margin) left = margin;

    if (top + promptRect.height > window.innerHeight - margin) {
      const aboveTop = anchorRect.top - promptRect.height - 8;
      top = aboveTop >= margin ? aboveTop : Math.max(margin, window.innerHeight - promptRect.height - margin);
    }

    prompt.style.left = `${left}px`;
    prompt.style.top = `${top}px`;
  }

  _getWipePromptAnchorRect(sessionIndex, ipHash) {
    if (ipHash) {
      const groupHeader = document.querySelector(`.userGroup[data-ip-hash="${CSS.escape(ipHash)}"] .groupHeader`);
      if (groupHeader) return groupHeader.getBoundingClientRect();
    }

    if (sessionIndex || sessionIndex === 0) {
      const userEntry = document.querySelector(`.userEntry.u${sessionIndex}`);
      if (userEntry) return userEntry.getBoundingClientRect();
    }

    const userList = document.getElementById('userList');
    return userList?.getBoundingClientRect() || null;
  }

  showWipePromptAfterAction(actionLabel, targetName, isGroup, sessionIndex, ipHash, targetUsername, anchorRect) {
    const existing = document.getElementById('modWipePrompt');
    if (existing) existing.remove();
    if (this._wipePromptDismiss) {
      this._wipePromptDismiss();
      this._wipePromptDismiss = null;
    }

    const card = document.createElement('div');
    card.id = 'modWipePrompt';
    card.className = 'modWipePrompt';
    card.innerHTML = `
      <div class="modWipePrompt-header">
        <span class="modWipePrompt-title">${this.escapeHtml(actionLabel)} <strong>${this.escapeHtml(targetName)}</strong></span>
        <button class="modWipePrompt-close" type="button" title="Dismiss">✕</button>
      </div>
      <p class="modWipePrompt-text">${isGroup ? `Wipe current strokes for ${this.escapeHtml(targetName)}?` : `Wipe ${this.escapeHtml(targetName)}'s current strokes?`}</p>
      <div class="modWipePrompt-actions">
        <button class="modWipePrompt-btn modWipePrompt-btn-danger" type="button">Wipe Now</button>
        <button class="modWipePrompt-btn" type="button">Keep</button>
      </div>
      <div class="modWipePrompt-timer"></div>
    `;
    document.body.appendChild(card);

    this._positionWipePrompt(card, anchorRect);
    requestAnimationFrame(() => card.classList.add('modWipePrompt-visible'));

    const closeBtn = card.querySelector('.modWipePrompt-close');
    const wipeBtn = card.querySelector('.modWipePrompt-btn-danger');
    const keepBtn = card.querySelectorAll('.modWipePrompt-btn')[1];
    const timerBar = card.querySelector('.modWipePrompt-timer');
    const AUTO_DISMISS_MS = 12000;

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(autoTimeout);
      card.classList.remove('modWipePrompt-visible');
      setTimeout(() => card.remove(), 250);
      if (this._wipePromptDismiss === dismiss) {
        this._wipePromptDismiss = null;
      }
    };
    this._wipePromptDismiss = dismiss;

    const wipe = () => {
      if (isGroup) {
        if (this.onModGroupAction) this.onModGroupAction('wipe', ipHash);
      } else if (this.onModWipe) {
        this.onModWipe(sessionIndex, targetUsername || targetName || '');
      }
      dismiss();
    };

    closeBtn?.addEventListener('click', dismiss);
    keepBtn?.addEventListener('click', dismiss);
    wipeBtn?.addEventListener('click', wipe);

    requestAnimationFrame(() => {
      timerBar.style.transition = `width ${AUTO_DISMISS_MS}ms linear`;
      timerBar.style.width = '0%';
    });
    const autoTimeout = setTimeout(dismiss, AUTO_DISMISS_MS);
  }

  _positionWipePrompt(card, anchorRect) {
    const margin = 10;
    const cardRect = card.getBoundingClientRect();
    const fallbackLeft = Math.max(margin, window.innerWidth - cardRect.width - margin);
    const fallbackTop = 64;

    let left, top;
    if (!anchorRect) {
      left = fallbackLeft;
      top = fallbackTop;
    } else {
      left = anchorRect.left;
      top = anchorRect.bottom + 8;

      if (left + cardRect.width > window.innerWidth - margin) {
        left = window.innerWidth - cardRect.width - margin;
      }
      if (left < margin) left = margin;

      if (top + cardRect.height > window.innerHeight - margin) {
        const aboveTop = anchorRect.top - cardRect.height - 8;
        top = aboveTop >= margin ? aboveTop : Math.max(margin, window.innerHeight - cardRect.height - margin);
      }
    }

    // The reason card (kick/mute) can be showing at the same time, fixed near
    // top-center, and this prompt renders above it (higher z-index). An
    // anchor-based position near the top of the screen would otherwise land
    // right on top of the reason card's input and silently block it — push
    // this prompt below (or, failing that, above) the reason card instead.
    const reasonCard = document.getElementById('modReasonCard');
    if (reasonCard) {
      const reasonRect = reasonCard.getBoundingClientRect();
      const overlaps = left < reasonRect.right && left + cardRect.width > reasonRect.left &&
        top < reasonRect.bottom && top + cardRect.height > reasonRect.top;
      if (overlaps) {
        const belowTop = reasonRect.bottom + 8;
        top = (belowTop + cardRect.height <= window.innerHeight - margin)
          ? belowTop
          : Math.max(margin, reasonRect.top - cardRect.height - 8);
      }
    }

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  // --- Reason Card (non-blocking, shown after instant action) ---

  /**
   * Duration choices offered for mute/ban/shadowban, in minutes (0 = permanent).
   */
  static DURATION_OPTIONS = [
    { label: '5m', minutes: 5 },
    { label: '10m', minutes: 10 },
    { label: '15m', minutes: 15 },
    { label: '30m', minutes: 30 },
    { label: '1hr', minutes: 60 },
    { label: '2hr', minutes: 120 },
    { label: '4hr', minutes: 240 },
    { label: '8hr', minutes: 480 },
    { label: '12hr', minutes: 720 },
    { label: '24hr', minutes: 1440 },
    { label: '2d', minutes: 2880 },
    { label: '5d', minutes: 7200 },
    { label: '7d', minutes: 10080 },
    { label: 'Permanent', minutes: 0 }
  ];

  static DEFAULT_DURATION_MINUTES = { mute: 10, ban: 1440, shadowban: 2880, silence: 10 };

  /**
   * Show a small non-blocking card.
   *
   * Two modes:
   *  - Default (kick or group mute/ban): the action has already fired; this
   *    card only collects an optional reason and sends a MOD_UPDATE_REASON.
   *  - Deferred (per-user mute/ban/shadowban): the action has NOT fired yet.
   *    The card includes a duration dropdown (ban/mute/shadowban) and, for
   *    ban/shadowban, an IP-scope dropdown (Subnet / Exact / Wide). Submitting
   *    issues the original MOD_ACTION with the chosen duration/scope/reason in
   *    a single payload.
   *
   * @param {string} action - 'kick' | 'mute' | 'ban' | 'shadowban'
   * @param {number|null} sessionIndex
   * @param {string} targetName
   * @param {boolean} isGroup
   * @param {string|null} ipHash
   * @param {Object} [opts]
   * @param {boolean} [opts.deferred=false] - Card issues the action on submit.
   * @param {string}  [opts.targetUsername]
   * @param {DOMRect} [opts.anchorRect]
   */
  showReasonCard(action, sessionIndex, targetName, isGroup, ipHash, opts = {}) {
    const existing = document.getElementById('modReasonCard');
    if (existing) existing.remove();

    const actionCodes = { kick: 0, mute: 1, ban: 2, shadowban: 6, silence: 9 };
    const actionCode = actionCodes[action];
    const isDanger = action === 'ban' || action === 'shadowban';
    const pastTense = { kick: 'Kicked', mute: 'Muted', ban: 'Banned', shadowban: 'Shadow Banned', silence: 'Silenced' };
    const futureTense = { mute: 'Mute', ban: 'Ban', shadowban: 'Shadow Ban', silence: 'Silence' };
    const deferred = !!opts.deferred;
    const hasDuration = action === 'mute' || action === 'ban' || action === 'shadowban' || action === 'silence';
    const hasScope = action === 'ban' || action === 'shadowban';
    const titlePrefix = deferred ? '' : '✓ ';
    const titleVerb = deferred ? (futureTense[action] || action) : (pastTense[action] || action);
    const submitLabel = deferred ? (futureTense[action] || 'Confirm') : 'Add';
    // Deferred cards give the mod more time to decide than a post-action reason.
    const AUTO_DISMISS_MS = deferred ? 20000 : 8000;

    const durationPicker = (deferred && hasDuration) ? `
      <label class="modReasonCard-scopeRow">
        <span class="modReasonCard-scopeLabel">Duration</span>
        <select id="modReasonDuration" class="modReasonCard-scope">
          ${Moderation.DURATION_OPTIONS.map(o => `<option value="${o.minutes}"${o.minutes === Moderation.DEFAULT_DURATION_MINUTES[action] ? ' selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </label>
    ` : '';

    const scopePicker = (deferred && hasScope) ? `
      <label class="modReasonCard-scopeRow">
        <span class="modReasonCard-scopeLabel">IP scope</span>
        <select id="modReasonScope" class="modReasonCard-scope">
          <option value="subnet" selected>Subnet (/24 v4, /64 v6)</option>
          <option value="exact">Exact IP only</option>
          <option value="wide">Wide (IPv6 /48)</option>
        </select>
      </label>
    ` : '';

    const card = document.createElement('div');
    card.id = 'modReasonCard';
    card.className = `modReasonCard${isDanger ? ' danger' : ''}${deferred ? ' deferred' : ''}`;
    card.innerHTML = `
      <div class="modReasonCard-header">
        <span class="modReasonCard-title">${titlePrefix}${titleVerb}: <strong>${this.escapeHtml(targetName)}</strong></span>
        <button class="modReasonCard-close" id="modReasonClose" title="Dismiss">✕</button>
      </div>
      <div class="modReasonCard-body">
        ${durationPicker}
        ${scopePicker}
        <input type="text" id="modReasonInput" class="modReasonCard-input" placeholder="${deferred ? 'Reason (optional)' : 'Add a reason... (optional)'}" maxlength="200" autocomplete="off">
        <button class="modReasonCard-submit" id="modReasonSubmit">${submitLabel}</button>
      </div>
      <div class="modReasonCard-timer" id="modReasonTimer"></div>
    `;
    document.body.appendChild(card);

    requestAnimationFrame(() => card.classList.add('modReasonCard-visible'));

    const input = card.querySelector('#modReasonInput');
    const submitBtn = card.querySelector('#modReasonSubmit');
    const closeBtn = card.querySelector('#modReasonClose');
    const timerBar = card.querySelector('#modReasonTimer');
    const scopeSelect = card.querySelector('#modReasonScope');
    const durationSelect = card.querySelector('#modReasonDuration');

    let dismissed = false;
    let autoTimeout = null;
    // Hover, and having the input/dropdowns focused (including a tablet's
    // on-screen keyboard just sitting open, not only active typing), should
    // hold the card open instead of letting it time out under the mod's cursor.
    const activeHolds = new Set();

    const clearAutoTimeout = () => {
      if (autoTimeout) {
        clearTimeout(autoTimeout);
        autoTimeout = null;
      }
    };

    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      clearAutoTimeout();
      card.classList.remove('modReasonCard-visible');
      setTimeout(() => card.remove(), 250);
    };

    const scheduleAutoDismiss = () => {
      clearAutoTimeout();
      timerBar.style.transition = 'none';
      timerBar.style.width = '100%';
      autoTimeout = setTimeout(dismiss, AUTO_DISMISS_MS);
      requestAnimationFrame(() => {
        timerBar.style.transition = `width ${AUTO_DISMISS_MS}ms linear`;
        timerBar.style.width = '0%';
      });
    };

    const hold = (reason) => {
      activeHolds.add(reason);
      clearAutoTimeout();
      timerBar.style.transition = 'none';
      timerBar.style.width = '100%';
    };

    const release = (reason) => {
      activeHolds.delete(reason);
      if (activeHolds.size === 0 && !dismissed) scheduleAutoDismiss();
    };

    const submit = () => {
      const reason = input.value.trim();
      if (deferred) {
        const scope = scopeSelect ? (scopeSelect.value || 'subnet') : undefined;
        const duration = durationSelect ? (parseInt(durationSelect.value, 10) || 0) : 0;
        if (this.onModAction) this.onModAction(actionCode, sessionIndex, reason, duration, scope);
        if (action === 'ban' || action === 'mute') {
          this.showWipePromptAfterAction(pastTense[action], targetName, false, sessionIndex, ipHash, opts.targetUsername, opts.anchorRect);
        }
      } else if (reason) {
        if (isGroup) {
          if (this.onModGroupUpdateReason) this.onModGroupUpdateReason(action, ipHash, reason);
        } else {
          if (this.onModUpdateReason) this.onModUpdateReason(actionCode, sessionIndex, reason);
        }
      }
      dismiss();
    };

    submitBtn.addEventListener('click', submit);
    closeBtn.addEventListener('click', dismiss);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') dismiss();
      e.stopPropagation();
    });
    // Changing scope/duration shouldn't bubble keys up while the select is open.
    scopeSelect?.addEventListener('keydown', (e) => e.stopPropagation());
    durationSelect?.addEventListener('keydown', (e) => e.stopPropagation());

    card.addEventListener('mouseenter', () => hold('hover'));
    card.addEventListener('mouseleave', () => release('hover'));
    [input, scopeSelect, durationSelect].forEach((el) => {
      if (!el) return;
      el.addEventListener('focus', () => hold('focus'));
      el.addEventListener('blur', () => release('focus'));
    });

    // Focus fires the listener above synchronously, which already holds the
    // timer open (and will schedule it once focus leaves) — only schedule
    // here if that somehow didn't happen.
    input.focus();
    if (activeHolds.size === 0) scheduleAutoDismiss();
  }

  // --- Mod Panel ---

  _requestList() {
    if (this.onRequestModList) {
      this.onRequestModList({ showHistory: this.showHistory, search: this.searchQuery });
    }
  }

  togglePanel() {
    this.panelVisible = !this.panelVisible;
    const panel = document.getElementById('modPanel');
    if (panel) {
      panel.style.display = this.panelVisible ? 'flex' : 'none';
    }
    if (this.panelVisible) {
      this._requestList();
    }
  }

  showPanel() {
    this.panelVisible = true;
    const panel = document.getElementById('modPanel');
    if (panel) {
      panel.style.display = 'flex';
    }
  }

  hidePanel() {
    this.panelVisible = false;
    const panel = document.getElementById('modPanel');
    if (panel) {
      panel.style.display = 'none';
    }
  }

  setShowHistory(val) {
    this.showHistory = val;
    const btn = document.getElementById('modHistoryToggle');
    if (btn) {
      btn.textContent = val ? 'All History' : 'Active Only';
      btn.classList.toggle('active', val);
    }
    this._requestList();
  }

  setSearch(query) {
    this.searchQuery = query;
    this._requestList();
  }

  setFilterType(filter) {
    this.filterType = filter;

    const chips = document.querySelectorAll('.modChip');
    chips.forEach(c => {
      c.classList.toggle('active', c.dataset.filter === filter);
    });

    this.renderEntries();
  }

  /**
   * Update mod entries from server MOD_LIST response
   */
  updateModEntries(entries) {
    this.modEntries = (entries || []).map(e => ({
      id: e.id,
      type: e.type === 0 ? 'bans' : e.type === 1 ? 'mutes' : e.type === 2 ? 'shadowbans' : 'silences',
      username: e.username || '',
      reason: e.reason || '',
      ip: e.ip || '',
      ipScope: e.ipScope || '',
      issuedBy: e.issuedBy || '',
      issuedByRole: e.issuedByRole || 0,
      createdAt: e.createdAt || 0,
      expiresAt: e.expiresAt || 0,
      active: e.active
    }));
    this.renderEntries();
  }

  renderEntries() {
    const list = document.getElementById('modEntryList');
    if (!list) return;

    const filter = this.filterType || 'all';
    const filtered = filter === 'all'
      ? this.modEntries
      : this.modEntries.filter(e => e.type === filter);

    if (filtered.length === 0) {
      const filterLabel = filter === 'all' ? 'entries' : filter;
      const label = this.searchQuery
        ? `No ${filterLabel} match "${this.escapeHtml(this.searchQuery)}"`
        : `No ${filterLabel}`;
      list.innerHTML = `
        <div class="modTableWrap">
          <table class="modTable">
            <thead>
              <tr><th>Type</th><th>User</th><th>Reason</th><th>By</th><th>Expires</th><th></th></tr>
            </thead>
            <tbody>
              <tr><td colspan="6" class="modTableEmpty">${label}</td></tr>
            </tbody>
          </table>
        </div>
      `;
      return;
    }

    const now = Date.now();
    const pillFor = { bans: 'BAN', mutes: 'MUTE', shadowbans: 'SHADOW', silences: 'SILENCE' };

    const rowsHtml = filtered.map(entry => {
      const createdDate = entry.createdAt
        ? new Date(Number(entry.createdAt)).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        : '';
      const expiresDate = entry.expiresAt
        ? new Date(Number(entry.expiresAt)).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        : 'Permanent';

      const isExpired = entry.expiresAt && Number(entry.expiresAt) < now;
      const statusLabel = !entry.active ? 'Revoked' : isExpired ? 'Expired' : 'Active';
      const statusClass = !entry.active ? 'revoked' : isExpired ? 'expired' : 'active';

      const canRemove = entry.active && !isExpired;
      // A mod can never lift or edit an action issued by someone who outranked
      // them at the time — server enforces this too; hiding the controls here
      // just avoids offering an action that will bounce.
      const canOverride = this.localRole >= (entry.issuedByRole || 0);
      const pillLabel = pillFor[entry.type] || entry.type.toUpperCase();
      const pillClass = `modEntryPill modEntryPill-${entry.type}`;
      const scopeBadge = entry.ipScope
        ? `<span class="modEntryScope" title="IP match scope">${this.escapeHtml(entry.ipScope)}</span>`
        : '';
      const reason = entry.reason ? `"${this.escapeHtml(entry.reason)}"` : '<span class="modTableMuted">—</span>';
      const ipLine = entry.ip
        ? `<div class="modTableSub modEntryIp">${this.escapeHtml(entry.ip)}${scopeBadge ? ' ' : ''}${scopeBadge}</div>`
        : '';
      const canEditDuration = canRemove && canOverride;

      return `
        <tr class="modTableRow ${statusClass}">
          <td><span class="${pillClass}">${pillLabel}</span></td>
          <td>
            <div class="modTableUser">
              <strong>${this.escapeHtml(entry.username)}</strong>
              <span class="modEntryStatus ${statusClass}">${statusLabel}</span>
            </div>
            ${ipLine}
          </td>
          <td class="modTableReason">${reason}</td>
          <td>
            <div>${this.escapeHtml(entry.issuedBy || 'Unknown')}</div>
            <div class="modTableSub">${createdDate}</div>
          </td>
          <td class="modEntryExpires" data-id="${this.escapeHtml(entry.id)}" data-expires="${entry.expiresAt || 0}">
            <span class="modEntryExpiresText">${expiresDate}</span>
            ${canEditDuration ? `<button class="modEntryEditDuration" data-id="${this.escapeHtml(entry.id)}" title="Change duration">✎</button>` : ''}
          </td>
          <td class="modTableActions">
            ${canRemove && canOverride ? `<button class="modEntryRemove" data-id="${this.escapeHtml(entry.id)}" data-type="${entry.type}" data-username="${this.escapeHtml(entry.username)}">Revoke</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');

    list.innerHTML = `
      <div class="modTableWrap">
        <table class="modTable">
          <thead>
            <tr><th>Type</th><th>User</th><th>Reason</th><th>By</th><th>Expires</th><th></th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;

    // Wire up revoke buttons
    list.querySelectorAll('.modEntryRemove').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.onRevokeEntry) {
          this.onRevokeEntry(btn.dataset.id, btn.dataset.type, btn.dataset.username);
        }
      });
    });

    // Wire up inline duration editing
    list.querySelectorAll('.modEntryEditDuration').forEach(btn => {
      btn.addEventListener('click', () => this._showDurationEditor(btn.closest('.modEntryExpires'), btn.dataset.id));
    });
  }

  /**
   * Swaps an Expires cell's text for a duration <select>, defaulting to the
   * closest existing option to the entry's current expiry. Selecting a new
   * value fires onModUpdateDuration and reverts the cell — the real value
   * comes back on the next list refresh.
   */
  _showDurationEditor(cell, entryId) {
    if (!cell || cell.querySelector('select')) return;

    const expiresAt = Number(cell.dataset.expires) || 0;
    const remainingMinutes = expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 60000)) : 0;
    let closest = Moderation.DURATION_OPTIONS[0];
    if (expiresAt) {
      closest = Moderation.DURATION_OPTIONS.reduce((best, opt) => {
        if (opt.minutes === 0) return best;
        return Math.abs(opt.minutes - remainingMinutes) < Math.abs(best.minutes - remainingMinutes) ? opt : best;
      }, Moderation.DURATION_OPTIONS[0]);
    } else {
      closest = Moderation.DURATION_OPTIONS[Moderation.DURATION_OPTIONS.length - 1]; // Permanent
    }

    const select = document.createElement('select');
    select.className = 'modEntryDurationSelect';
    select.innerHTML = Moderation.DURATION_OPTIONS.map(o =>
      `<option value="${o.minutes}"${o.minutes === closest.minutes ? ' selected' : ''}>${o.label}</option>`
    ).join('');

    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('keydown', (e) => e.stopPropagation());
    select.addEventListener('change', () => {
      const minutes = parseInt(select.value, 10) || 0;
      if (this.onModUpdateDuration) this.onModUpdateDuration(entryId, minutes);
      cell.querySelector('.modEntryExpiresText')?.style.removeProperty('display');
      select.remove();
    });
    select.addEventListener('blur', () => {
      cell.querySelector('.modEntryExpiresText')?.style.removeProperty('display');
      select.remove();
    });

    const textEl = cell.querySelector('.modEntryExpiresText');
    if (textEl) textEl.style.display = 'none';
    cell.appendChild(select);
    select.focus();
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
