<script>
  import { appState } from '../../state.svelte.js';
  import { T } from '../../../shared/MessageTypes.js';
  import { showAppConfirm } from '../ConfirmDialog.js';
  import { dragScrollAction } from '../../utils/dragScroll.js';

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

  const TAB_GENERAL = 'general';
  const TAB_MODERATION = 'moderation';
  const TAB_FLOATING_GALLERY = 'floating-gallery';
  const ROLE_OPTIONS = [
    { value: 0, label: 'None' },
    { value: 2, label: 'Trusted' },
    { value: 3, label: 'Helper' },
    { value: 4, label: 'Moderator' },
    { value: 5, label: 'Admin' }
  ];
  const JOIN_POLICY_OPTIONS = [
    { value: 'open', label: 'Open' },
    { value: 'registered', label: 'Registered Only' },
    { value: 'trusted', label: 'Trusted Only' }
  ];
  const ROOM_VISIBILITY_OPTIONS = [
    { value: 'public', label: 'Public' },
    { value: 'private', label: 'Private (unlisted)' }
  ];
  // Stress sizes are hidden behind a flag rather than removed: server-side
  // checkpoints, snapshots and timelapse frames are all taken at board
  // resolution, so a 12k room is expensive in storage and encode time whether
  // or not anyone draws in it. Enable with
  // `localStorage.setItem('ddraw.stressBoardSizes', '1')`.
  const stressBoardSizesEnabled = (() => {
    try {
      return localStorage.getItem('ddraw.stressBoardSizes') === '1';
    } catch {
      return false;
    }
  })();
  const BOARD_SIZE_OPTIONS = [
    { value: '720p',  label: '720p  (1280 × 720)' },
    { value: '1080p', label: '1080p (1920 × 1080)' },
    { value: '1440p', label: '1440p (2560 × 1440)' },
    { value: '4k',    label: '4k    (3840 × 2160)' },
    // 'big' (3200 × 1800) is no longer offered, but stays in BOARD_SIZE_PRESETS
    // so rooms already set to it keep resolving — dropping the preset would
    // silently fall them back to 1080p and clear the canvas.
    ...(stressBoardSizesEnabled ? [
      { value: 'big', label: 'Big   (3200 × 1800) — legacy' },
      { value: '8k',  label: '8k    (7680 × 4320) — stress' },
      { value: '12k', label: '12k   (11520 × 6480) — stress' }
    ] : [])
  ];
  const ROLE_LABELS = {
    0: 'None',
    1: 'User',
    2: 'Trusted',
    3: 'Helper',
    4: 'Moderator',
    5: 'Admin',
    6: 'Owner',
    7: 'Noble',
    8: 'Holy',
    9: 'Deity'
  };

  let { wsClient = null, board = null, ui = null, onUpdate = null, onUnregister = null } = $props();

  let activeTab = $state(TAB_GENERAL);
  let roomId = $state('');
  let description = $state('');
  let ownerUsername = $state('');
  let backgroundColor = $state('#ffffff');
  let locked = $state(false);
  let maxUsers = $state(40);
  let modInactiveImmune = $state(false);
  let joinPolicy = $state('open');
  let obscureRequiresRegistered = $state(false);
  let autoMuteGuests = $state(false);
  let autoMuteVpnUsers = $state(false);
  let hideChatNotifications = $state(false);
  let loadSnapshotOnFirstJoin = $state(true);
  let textOverlayLifetimeMs = $state(30 * 1000);
  let textFadeMinutes = $state(0);
  let textFadeSeconds = $state(30);
  let roomPrivate = $state(false);
  let dedicatedReplayUser = $state('');
  let boardSize = $state('1080p');
  let tiledCanvas = $state(false);
  // Whether the server's global kill switch allows tiling at all. False hides
  // the control rather than showing one the ROOM_UPDATE handler will drop.
  let tiledCanvasAvailable = $state(false);
  let floatingGallerySeed = $state(0);
  let floatingGalleryIncludeIds = $state([]);
  let floatingGalleryExcludeIds = $state([]);
  let floatingGalleryVisibleItems = $state([]);
  let floatingGalleryVisibleLoading = $state(false);
  let floatingGalleryBrowseItems = $state([]);
  let floatingGalleryBrowseLoading = $state(false);
  let floatingGalleryBrowsePage = $state(1);
  let floatingGalleryBrowsePages = $state(1);
  let floatingGalleryBrowseSort = $state('newest');
  let floatingGalleryVisibleLoadedKey = $state('');
  let floatingGalleryBrowseLoadedKey = $state('');
  let floatingGalleryBrowseRefreshQueued = $state(false);
  let lastLoadedFloatingGalleryRoomId = $state('');
  let hydratedRoomId = $state('');
  let message = $state('');
  let messageType = $state('success');
  let showMessage = $state(false);
  let saving = $state(false);
  let unregistering = $state(false);
  let floatingGalleryLeaveConfirmOpen = $state(false);
  let rosterLoading = $state(false);
  let roleSavingTarget = $state('');
  let rosterFilter = $state('');
  let pendingRoles = $state({});
  let offlinePromotionName = $state('');
  let offlinePromotionRole = $state(4);
  let showUnregisterConfirm = $state(false);

  let startStateBusy = $state(false);
  let startStateRequestedKey = $state('');
  const startStateThumbUrls = new Map();

  let visible = $derived(appState.roomSettingsVisible);
  let roomData = $derived(appState.currentRoomData);
  // Offline (Draw Alone): there's no server room behind this dialog, so only
  // the fields that apply purely locally (background colour) are shown, and
  // Save applies them straight to the board instead of sending ROOM_UPDATE.
  let offlineMode = $derived(!!roomData?.offline);
  let userRole = $derived(appState.selfRole);
  let globalRole = $derived(appState.selfGlobalRole);
  let currentUsername = $derived(appState.username);
  let users = $derived(appState.users);
  let roomRoster = $derived(roomData?.moderationRoster || []);

  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  // Start state: which snapshot an empty room comes back up on. -1 until the
  // server has answered; then 0 = nothing saved, 1 = the room's newest snapshot
  // (automatic), 2 = an explicitly pinned one, 3 = cleared (opens blank until
  // something newer is saved).
  let startState = $derived(appState.roomStartSnapshot ? Number(appState.roomStartSnapshot.state) : -1);
  let startStateSnapshot = $derived(appState.roomStartSnapshot?.snapshot || null);

  let startStateThumbUrl = $derived.by(() => {
    const snap = startStateSnapshot;
    if (!snap?.id || !snap.thumb || snap.thumb.length === 0) return '';
    let url = startStateThumbUrls.get(snap.id);
    if (!url) {
      url = URL.createObjectURL(new Blob([snap.thumb], { type: 'image/jpeg' }));
      startStateThumbUrls.set(snap.id, url);
    }
    return url;
  });

  let startStateTitle = $derived(
    startState === 3 ? 'Cleared'
      : startState === 2 ? 'Pinned board state'
        : startState === 1 ? 'Latest snapshot (automatic)'
          : startState === 0 ? 'Nothing saved yet'
            : 'Loading...'
  );

  let startStateSubtitle = $derived.by(() => {
    if (startState < 0) return '';
    if (startState === 3) return 'Opens blank until the next snapshot is taken.';
    if (!startStateSnapshot) return 'The room will open on a blank canvas.';
    const when = new Date(Number(startStateSnapshot.ts || 0));
    const who = startStateSnapshot.issuer ? `by ${startStateSnapshot.issuer}` : '';
    return [dateFormatter.format(when), who].filter(Boolean).join(' · ');
  });

  $effect(() => {
    if (visible && roomData && hydratedRoomId !== (roomData.id || '')) {
      loadRoomData(roomData);
      hydratedRoomId = roomData.id || '';
    }
    if (!visible) {
      startStateRequestedKey = '';
      startStateBusy = false;
      activeTab = TAB_GENERAL;
      roleSavingTarget = '';
      rosterFilter = '';
      pendingRoles = {};
      offlinePromotionName = '';
      offlinePromotionRole = 4;
      showUnregisterConfirm = false;
      unregistering = false;
      hydratedRoomId = '';
    }
  });

  $effect(() => {
    if (visible && activeTab === TAB_MODERATION) {
      requestModerationRoster();
    }
  });

  $effect(() => {
    if (!visible || activeTab !== TAB_GENERAL || offlineMode) return;
    const key = roomId || '';
    if (startStateRequestedKey === key) return;
    startStateRequestedKey = key;
    // Drop the previous room's answer so the card reads "Loading..." rather
    // than briefly showing another room's saved board.
    appState.roomStartSnapshot = null;
    window.app?.snapshotManager?.requestRoomStartState();
  });

  // Any fresh answer from the server ends the pending action.
  $effect(() => {
    appState.roomStartSnapshot;
    startStateBusy = false;
  });

  // Thumbnails are object URLs; release them when the dialog is torn down.
  $effect(() => () => {
    for (const url of startStateThumbUrls.values()) URL.revokeObjectURL(url);
    startStateThumbUrls.clear();
  });

  async function setStartStateToCurrentBoard() {
    const snapshotManager = window.app?.snapshotManager;
    if (!snapshotManager || startStateBusy) return;

    startStateBusy = true;
    const sent = await snapshotManager.saveAsRoomStartState();
    if (!sent) {
      startStateBusy = false;
      displayMessage('Could not capture the board', 'error');
      return;
    }
    displayMessage('Saved the current board as this room’s start state', 'success');
    // Safety net: the busy flag normally clears on the server's reply.
    setTimeout(() => { startStateBusy = false; }, 8000);
  }

  function clearStartState() {
    const snapshotManager = window.app?.snapshotManager;
    if (!snapshotManager || startStateBusy) return;

    startStateBusy = true;
    snapshotManager.clearRoomStartState();
    displayMessage('Cleared — the room will open blank', 'success');
    setTimeout(() => { startStateBusy = false; }, 8000);
  }

  function followLatestSnapshot() {
    const snapshotManager = window.app?.snapshotManager;
    if (!snapshotManager || startStateBusy) return;

    startStateBusy = true;
    snapshotManager.followLatestRoomSnapshot();
    displayMessage('Following the room’s latest snapshot again', 'success');
    setTimeout(() => { startStateBusy = false; }, 8000);
  }

  $effect(() => {
    if (visible && activeTab === TAB_FLOATING_GALLERY) {
      fetchFloatingGalleryVisibleItems();
      fetchFloatingGalleryBrowsePage();
    }
  });

  $effect(() => {
    if (visible && activeTab === TAB_FLOATING_GALLERY && roomData) {
      roomData.id;
      roomData.floatingGalleryIncludeIds;
      fetchFloatingGalleryVisibleItems(true);
    }
  });

  function loadRoomData(data) {
    const roomChanged = lastLoadedFloatingGalleryRoomId !== (data.id || '');

    roomId = data.id || '';
    description = data.description || '';
    ownerUsername = data.ownerUsername || 'Unregistered';
    locked = !!data.locked;
    maxUsers = data.maxUsers !== undefined ? data.maxUsers : 40;
    modInactiveImmune = !!data.modInactiveImmune;
    joinPolicy = data.joinPolicy || 'open';
    obscureRequiresRegistered = !!data.obscureRequiresRegistered;
    autoMuteGuests = !!data.autoMuteGuests;
    autoMuteVpnUsers = !!data.autoMuteVpnUsers;
    hideChatNotifications = !!data.hideChatNotifications;
    // Default on: rooms saved before this setting existed have it undefined.
    loadSnapshotOnFirstJoin = data.loadSnapshotOnFirstJoin !== false;
    {
      const ms = Number(data.textOverlayLifetimeMs);
      textOverlayLifetimeMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 30 * 1000;
      const totalSeconds = Math.round(textOverlayLifetimeMs / 1000);
      textFadeMinutes = Math.floor(totalSeconds / 60);
      textFadeSeconds = totalSeconds % 60;
    }
    roomPrivate = !!data.private;
    dedicatedReplayUser = data.dedicatedReplayUser || '';
    boardSize = data.boardSize || '1080p';
    tiledCanvas = !!data.tiledCanvas;
    tiledCanvasAvailable = !!data.tiledCanvasAvailable;
    floatingGallerySeed = data.floatingGallerySeed || 0;
    floatingGalleryIncludeIds = Array.isArray(data.floatingGalleryIncludeIds) ? [...data.floatingGalleryIncludeIds] : [];
    floatingGalleryExcludeIds = Array.isArray(data.floatingGalleryExcludeIds) ? [...data.floatingGalleryExcludeIds] : [];
    if (roomChanged) {
      floatingGalleryVisibleItems = [];
      floatingGalleryBrowseItems = [];
      floatingGalleryBrowsePage = 1;
      floatingGalleryBrowsePages = 1;
      floatingGalleryVisibleLoadedKey = '';
      floatingGalleryBrowseLoadedKey = '';
      floatingGalleryBrowseRefreshQueued = false;
      lastLoadedFloatingGalleryRoomId = data.id || '';
    } else {
      floatingGalleryVisibleLoadedKey = '';
    }

    if (board) {
      const [r, g, b] = board.backgroundColor;
      backgroundColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    syncPendingRoles(data.moderationRoster || []);
  }

  function syncPendingRoles(roster) {
    const next = {};
    for (const entry of roster) {
      next[entry.userId] = entry.role;
    }
    pendingRoles = next;
  }

  function requestModerationRoster(force = false) {
    if (!visible || !wsClient || rosterLoading) return;
    const loadedAt = roomData?.moderationRosterLoadedAt || 0;
    const isFresh = loadedAt > 0 && (Date.now() - loadedAt) < 15000;
    if (!force && isFresh) return;
    rosterLoading = true;
    wsClient.requestRoomRoleList?.();
    setTimeout(() => {
      rosterLoading = false;
    }, 600);
  }

  function sortedIds(ids) {
    return Array.isArray(ids) ? [...ids].filter(Boolean).sort() : [];
  }

  function sameIds(left, right) {
    const a = sortedIds(left);
    const b = sortedIds(right);
    return a.length === b.length && a.every((id, index) => id === b[index]);
  }

  function hasUnsavedFloatingGalleryChanges() {
    if (!roomData) return false;
    const savedSeed = roomData.floatingGallerySeed || 0;
    const savedIncludeIds = Array.isArray(roomData.floatingGalleryIncludeIds) ? roomData.floatingGalleryIncludeIds : [];
    const savedExcludeIds = Array.isArray(roomData.floatingGalleryExcludeIds) ? roomData.floatingGalleryExcludeIds : [];

    return (
      floatingGallerySeed !== savedSeed ||
      !sameIds(floatingGalleryIncludeIds, savedIncludeIds) ||
      !sameIds(floatingGalleryExcludeIds, savedExcludeIds)
    );
  }

  function restoreFloatingGalleryDraft() {
    if (!roomData) return;
    floatingGallerySeed = roomData.floatingGallerySeed || 0;
    floatingGalleryIncludeIds = Array.isArray(roomData.floatingGalleryIncludeIds) ? [...roomData.floatingGalleryIncludeIds] : [];
    floatingGalleryExcludeIds = Array.isArray(roomData.floatingGalleryExcludeIds) ? [...roomData.floatingGalleryExcludeIds] : [];
    floatingGalleryVisibleLoadedKey = '';
  }

  async function confirmLeaveFloatingGallery() {
    if (activeTab !== TAB_FLOATING_GALLERY || !hasUnsavedFloatingGalleryChanges()) return true;
    if (floatingGalleryLeaveConfirmOpen) return false;

    floatingGalleryLeaveConfirmOpen = true;
    try {
      const confirm = ui?.confirm || showAppConfirm;
      return await confirm('You have unsaved floating gallery changes. Closing or leaving this tab will discard them.', {
        title: 'Discard Floating Gallery Changes?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep Editing',
        danger: true
      });
    } finally {
      floatingGalleryLeaveConfirmOpen = false;
    }
  }

  async function hide(options = {}) {
    if (!options.discardFloatingGalleryChanges && !(await confirmLeaveFloatingGallery())) return;
    if (options.discardFloatingGalleryChanges) {
      restoreFloatingGalleryDraft();
    }
    appState.roomSettingsVisible = false;
  }

  async function switchTab(nextTab) {
    if (nextTab === activeTab) return;
    if (!(await confirmLeaveFloatingGallery())) return;
    if (activeTab === TAB_FLOATING_GALLERY) {
      restoreFloatingGalleryDraft();
    }
    activeTab = nextTab;
  }

  function displayMessage(text, type = 'success') {
    message = text;
    messageType = type;
    showMessage = true;
    setTimeout(() => {
      showMessage = false;
    }, 3000);
  }

  function save() {
    if (!roomData || saving) return;

    if (offlineMode) {
      board?.setBackgroundColor(backgroundColor);
      // Persisted locally (keyed by browser, not room id — offline rooms are
      // re-generated every session) so the next Draw Alone session picks it up.
      window.app?.saveOfflineRoomSettings?.({ backgroundColor });
      displayMessage('Applied to this board', 'success');
      ui?.showToast('Board settings applied', 2000);
      return;
    }

    if (!wsClient) return;

    const trimmedDesc = description.trim();
    const clampedMaxUsers = Math.max(2, Math.min(60, maxUsers));
    maxUsers = clampedMaxUsers;

    const totalFadeSeconds = Math.max(0, Number(textFadeMinutes) || 0) * 60 + Math.max(0, Number(textFadeSeconds) || 0);
    const clampedTextOverlayLifetimeMs = Math.max(5000, Math.min(30 * 60 * 1000, Math.round(totalFadeSeconds * 1000)));
    textOverlayLifetimeMs = clampedTextOverlayLifetimeMs;
    textFadeMinutes = Math.floor(clampedTextOverlayLifetimeMs / 60000);
    textFadeSeconds = Math.round((clampedTextOverlayLifetimeMs % 60000) / 1000);

    saving = true;
    showMessage = false;

    wsClient._roomSettingsResultHandler = (result) => {
      saving = false;
      if (result.success) {
        const nextRoomData = {
          ...roomData,
          description: trimmedDesc,
          backgroundColor,
          locked,
          maxUsers: clampedMaxUsers,
          modInactiveImmune,
          joinPolicy,
          obscureRequiresRegistered,
          autoMuteGuests,
          autoMuteVpnUsers,
          hideChatNotifications,
          loadSnapshotOnFirstJoin,
          textOverlayLifetimeMs: clampedTextOverlayLifetimeMs,
          private: roomPrivate,
          boardSize,
          tiledCanvas,
          tiledCanvasAvailable,
          floatingGallerySeed,
          floatingGalleryIncludeIds: [...floatingGalleryIncludeIds],
          floatingGalleryExcludeIds: [...floatingGalleryExcludeIds],
        };
        loadRoomData(nextRoomData);
        displayMessage('Settings saved!', 'success');
        ui?.showToast('Room settings saved', 2000);
        if (onUpdate) {
          onUpdate(nextRoomData);
        }
        fetchFloatingGalleryVisibleItems(true);
      } else {
        displayMessage(result.error || 'Failed to save settings', 'error');
      }
    };

    wsClient.send({
      t: T.ROOM_UPDATE,
      roomCreatorDeviceId: wsClient?.clientIdentity?.deviceId || '',
      roomDescription: trimmedDesc,
      roomBackgroundColor: backgroundColor,
      roomLocked: locked,
      roomMaxUsers: clampedMaxUsers,
      roomModInactiveImmune: modInactiveImmune,
      roomJoinPolicy: joinPolicy,
      roomObscureRequiresRegistered: obscureRequiresRegistered,
      roomAutoMuteGuests: autoMuteGuests,
      roomAutoMuteVpnUsers: autoMuteVpnUsers,
      roomHideChatNotifications: hideChatNotifications,
      // 1 = on, 2 = off (0/absent would read as "unchanged" server-side).
      roomSnapshotOnFirstJoin: loadSnapshotOnFirstJoin ? 1 : 2,
      roomTextOverlayLifetimeMs: clampedTextOverlayLifetimeMs,
      roomPrivate: roomPrivate,
      roomDedicatedReplayUser: dedicatedReplayUser.trim() || null,
      roomBoardSize: boardSize,
      // Omitted entirely when the feature is globally off, so a save from a
      // client that somehow rendered the control cannot write the setting.
      ...(tiledCanvasAvailable ? { roomTiledCanvas: tiledCanvas } : {}),
      roomFloatingGallerySeed: floatingGallerySeed,
      roomFloatingGalleryIncludeIds: [...floatingGalleryIncludeIds],
      roomFloatingGalleryExcludeIds: [...floatingGalleryExcludeIds]
    });
  }

  async function fetchFloatingGalleryVisibleItems(force = false) {
    if (!visible || floatingGalleryVisibleLoading) return;

    const loadedKey = `${roomId}:${floatingGalleryIncludeIds.join(',')}:${floatingGalleryExcludeIds.join(',')}`;
    if (!force && loadedKey === floatingGalleryVisibleLoadedKey) return;

    floatingGalleryVisibleLoading = true;
    try {
      const params = new URLSearchParams({ room: roomId, minLikes: '1', limit: '200' });
      for (const id of floatingGalleryIncludeIds) {
        if (id) params.append('includeId', id);
      }
      for (const id of floatingGalleryExcludeIds) {
        if (id) params.append('excludeId', id);
      }
      const res = await fetch(`${API_BASE}/api/gallery/floating?${params}`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      floatingGalleryVisibleItems = data.items || [];
      floatingGalleryVisibleLoadedKey = loadedKey;
    } catch (err) {
      floatingGalleryVisibleItems = [];
      floatingGalleryVisibleLoadedKey = '';
      displayMessage('Could not load visible gallery images', 'error');
    } finally {
      floatingGalleryVisibleLoading = false;
    }
  }

  async function fetchFloatingGalleryBrowsePage(force = false) {
    if (!visible) return;
    if (floatingGalleryBrowseLoading) {
      if (force) floatingGalleryBrowseRefreshQueued = true;
      return;
    }
    const loadedKey = `${floatingGalleryBrowsePage}:${floatingGalleryBrowseSort}`;
    if (!force && loadedKey === floatingGalleryBrowseLoadedKey) return;

    floatingGalleryBrowseLoading = true;
    try {
      const params = new URLSearchParams({
        page: String(floatingGalleryBrowsePage),
        limit: '24',
        sort: floatingGalleryBrowseSort
      });
      const res = await fetch(`${API_BASE}/api/gallery?${params}`);
      if (!res.ok) throw new Error('Failed to load gallery');
      const data = await res.json();
      floatingGalleryBrowseItems = Array.isArray(data.items) ? data.items : [];
      floatingGalleryBrowsePages = Math.max(1, data.pages || 1);
      floatingGalleryBrowseLoadedKey = loadedKey;
    } catch (err) {
      floatingGalleryBrowseItems = [];
      floatingGalleryBrowsePages = 1;
      floatingGalleryBrowseLoadedKey = '';
      displayMessage('Could not load gallery browser', 'error');
    } finally {
      floatingGalleryBrowseLoading = false;
      if (floatingGalleryBrowseRefreshQueued) {
        floatingGalleryBrowseRefreshQueued = false;
        fetchFloatingGalleryBrowsePage(true);
      }
    }
  }

  function regenerateFloatingGallerySeed() {
    floatingGallerySeed = Math.floor(Math.random() * 0x7fffffff) || 1;
  }

  function floatingGalleryMode(itemId) {
    if (floatingGalleryExcludeIds.includes(itemId)) return 'exclude';
    if (floatingGalleryIncludeIds.includes(itemId)) return 'include';
    return 'default';
  }

  function setFloatingGalleryMode(itemId, mode) {
    const includeSet = new Set(floatingGalleryIncludeIds);
    const excludeSet = new Set(floatingGalleryExcludeIds);
    includeSet.delete(itemId);
    excludeSet.delete(itemId);

    if (mode === 'include') includeSet.add(itemId);
    if (mode === 'exclude') excludeSet.add(itemId);

    floatingGalleryIncludeIds = [...includeSet];
    floatingGalleryExcludeIds = [...excludeSet];
    floatingGalleryVisibleLoadedKey = '';
    fetchFloatingGalleryVisibleItems(true);
  }

  function goToFloatingGalleryPage(nextPage) {
    const clamped = Math.max(1, Math.min(floatingGalleryBrowsePages, nextPage));
    if (clamped === floatingGalleryBrowsePage) return;
    floatingGalleryBrowsePage = clamped;
    floatingGalleryBrowseItems = [];
    fetchFloatingGalleryBrowsePage(true);
  }

  function setFloatingGalleryBrowseSort(sort) {
    if (sort === floatingGalleryBrowseSort) return;
    floatingGalleryBrowseSort = sort;
    floatingGalleryBrowsePage = 1;
    floatingGalleryBrowseItems = [];
    floatingGalleryBrowseLoadedKey = '';
    fetchFloatingGalleryBrowsePage(true);
  }

  function openUnregisterConfirm() {
    if (!roomData || unregistering) return;
    showUnregisterConfirm = true;
  }

  function closeUnregisterConfirm() {
    if (unregistering) return;
    showUnregisterConfirm = false;
  }

  function unregisterRoom() {
    if (!roomData || !wsClient || unregistering) return;
    unregistering = true;
    wsClient.send({ t: T.ROOM_UNREGISTER });
    showUnregisterConfirm = false;
    hide();
    if (onUnregister) onUnregister();
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) void hide();
  }

  function canShowUnregister() {
    if (!roomData || !roomData.ownerId) return false;
    const isOwner = roomData.ownerUsername && currentUsername && roomData.ownerUsername === currentUsername;
    const isDeity = globalRole >= 9;
    return isOwner || isDeity;
  }

  function roleLabel(role) {
    return ROLE_LABELS[role] || `Role ${role}`;
  }

  function roleOptionLabel(role) {
    return ROLE_OPTIONS.find((option) => option.value === Number(role))?.label || 'None';
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown';
    return dateFormatter.format(new Date(timestamp));
  }

  function lastUpdatedBy(entry) {
    if (entry.isOwner) return 'Ownership';
    return entry.updatedByUsername || 'Unknown';
  }

  function rosterUserIds() {
    return new Set(roomRoster.map(entry => entry.userId).filter(Boolean));
  }

  function buildOnlineCandidates() {
    const candidates = [];
    const existingIds = rosterUserIds();
    const existingNames = new Set(roomRoster.map(entry => entry.username?.toLowerCase()).filter(Boolean));

    users?.forEach((user, id) => {
      const username = user.registeredName || user.username || '';
      if (!username) return;
      if (existingIds.has(String(id)) || existingNames.has(username.toLowerCase())) return;
      candidates.push({
        id: String(id),
        username,
        role: user.role || 0
      });
    });

    if (appState.sessionIndex !== null && userRole >= 1) {
      const selfId = String(appState.sessionIndex);
      const username = currentUsername || '';
      if (
        username &&
        !candidates.some(candidate => candidate.id === selfId) &&
        !existingNames.has(username.toLowerCase())
      ) {
        candidates.push({
          id: selfId,
          username,
          role: userRole
        });
      }
    }

    return candidates.sort((a, b) => a.username.localeCompare(b.username));
  }

  function filterText() {
    return rosterFilter.trim().toLowerCase();
  }

  function filteredRoster() {
    const query = filterText();
    if (!query) return roomRoster;
    return roomRoster.filter(entry =>
      (entry.username || '').toLowerCase().includes(query) ||
      roleLabel(entry.role).toLowerCase().includes(query) ||
      (entry.updatedByUsername || '').toLowerCase().includes(query)
    );
  }

  function filteredOnlineCandidates() {
    const query = filterText();
    const candidates = buildOnlineCandidates();
    if (!query) return candidates;
    return candidates.filter(candidate =>
      candidate.username.toLowerCase().includes(query) ||
      roleLabel(candidate.role).toLowerCase().includes(query)
    );
  }

  function pendingRoleValue(targetId, fallbackRole) {
    return pendingRoles[targetId] ?? fallbackRole;
  }

  function setPendingRole(targetId, role) {
    pendingRoles = {
      ...pendingRoles,
      [targetId]: role
    };
  }

  function applyRoleChange(targetId, nextRole, options = {}) {
    if (!wsClient || roleSavingTarget) return;
    if (options.isOwner) {
      displayMessage('Room ownership controls the owner rank', 'error');
      return;
    }
    if (!targetId && !options.targetUsername) return;
    if ((options.currentRole ?? 0) === nextRole) return;

    const requestKey = String(targetId || `username:${options.targetUsername}`);
    roleSavingTarget = requestKey;
    wsClient._roomRoleSetResultHandler = (result) => {
      roleSavingTarget = '';
      if (result.success) {
        displayMessage('Moderation roster updated', 'success');
        ui?.showToast('Moderator role updated', 2000);
        if (roomData) {
          appState.currentRoomData = {
            ...roomData,
            moderationRosterLoadedAt: 0
          };
        }
        requestModerationRoster(true);
      } else {
        displayMessage(result.error || 'Failed to update room role', 'error');
      }
    };
    wsClient.sendRoomRoleSet(targetId, nextRole, options.targetUsername || '');
  }

  function applyOfflinePromotion() {
    const username = offlinePromotionName.trim();
    if (!username) {
      displayMessage('Enter a username to promote', 'error');
      return;
    }
    applyRoleChange('', Number(offlinePromotionRole), {
      currentRole: 0,
      targetUsername: username
    });
    offlinePromotionName = '';
  }

  $effect(() => {
    function handleKeydown(e) {
      if (e.key === 'Escape' && appState.roomSettingsVisible) {
        void hide();
      } else if (e.key === 'Enter' && e.ctrlKey && appState.roomSettingsVisible && activeTab === TAB_GENERAL) {
        save();
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if visible}
  <div class="room-settings-overlay" onclick={handleBackdropClick} role="presentation">
    <div
      class="room-settings-dialog"
      data-tut="room-settings-dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div class="room-settings-header">
        <div class="room-settings-header-main">
          <h3>Room Settings{offlineMode ? ' (Offline)' : ''}</h3>
          {#if !offlineMode}
            <div class="room-settings-tabs" role="tablist" aria-label="Room settings sections">
              <button class:active={activeTab === TAB_GENERAL} class="room-settings-tab" onclick={() => switchTab(TAB_GENERAL)} type="button">General</button>
              <button class:active={activeTab === TAB_FLOATING_GALLERY} class="room-settings-tab" onclick={() => switchTab(TAB_FLOATING_GALLERY)} type="button">Floating Gallery</button>
              <button class:active={activeTab === TAB_MODERATION} class="room-settings-tab" onclick={() => switchTab(TAB_MODERATION)} type="button">Moderation</button>
            </div>
          {/if}
        </div>
        <button class="room-settings-close" onclick={() => hide()} title="Close">&times;</button>
      </div>

      <div class="room-settings-body" use:dragScrollAction>
        {#if showMessage}
          <div class="room-settings-message {messageType}">{message}</div>
        {/if}

        {#if activeTab === TAB_GENERAL}
          {#if !offlineMode}
            <div class="form-grid">
              <div class="form-group">
                <label for="roomId">Room ID</label>
                <input type="text" id="roomId" value={roomId} disabled class="room-input disabled" />
              </div>

              <div class="form-group">
                <label for="roomOwner">Owner</label>
                <input type="text" id="roomOwner" value={ownerUsername} disabled class="room-input disabled" />
              </div>
            </div>

            <div class="form-group">
              <label for="roomDescription">Description</label>
              <textarea id="roomDescription" bind:value={description} class="room-textarea" placeholder="Room description..." rows="3"></textarea>
            </div>
          {/if}

          <div class="form-grid">
            <div class="form-group">
              <label for="roomBgColor">Background Colour</label>
              <div class="color-input-group">
                <input type="color" id="roomBgColor" bind:value={backgroundColor} class="room-color-input" />
                <input type="text" value={backgroundColor} oninput={(e) => backgroundColor = e.target.value} class="room-input color-text" />
              </div>
            </div>

            {#if !offlineMode}
              <div class="form-group">
                <label for="roomVisibility">Visibility</label>
                <select
                  id="roomVisibility"
                  class="room-input"
                  value={roomPrivate ? 'private' : 'public'}
                  onchange={(e) => roomPrivate = e.currentTarget.value === 'private'}
                >
                  {#each ROOM_VISIBILITY_OPTIONS as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
                <span class="form-hint">Private rooms don't appear in the room browser.</span>
              </div>
            {/if}
          </div>

          {#if !offlineMode}
          <div class="form-grid">
            <div class="form-group">
              <label for="roomJoinPolicy">Join Policy</label>
              <select id="roomJoinPolicy" bind:value={joinPolicy} class="room-input">
                {#each JOIN_POLICY_OPTIONS as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </div>

            <div class="form-group">
              <label for="roomMaxUsers">Max Users (2-60)</label>
              <input type="number" id="roomMaxUsers" bind:value={maxUsers} min="2" max="60" class="room-input" />
            </div>
          </div>

          <div class="form-group">
            <label for="roomBoardSize">Board Size</label>
            <select id="roomBoardSize" bind:value={boardSize} class="room-input">
              {#each BOARD_SIZE_OPTIONS as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
            <span class="form-hint">Changing board size clears the canvas for all users.</span>
          </div>

          {#if tiledCanvasAvailable}
            <div class="form-group checkbox-group">
              <label>
                <input type="checkbox" bind:checked={tiledCanvas} />
                <span>Tiled Canvas Backing Store</span>
              </label>
              <span class="form-hint">
                Stores each layer as a grid of tiles and only allocates the ones
                holding pixels, which cuts canvas memory on a sparsely drawn
                board. Applies live for everyone in the room; no canvas is
                cleared.
              </span>
            </div>
          {/if}

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={locked} />
              <span>Lock Room (prevent new users from joining)</span>
            </label>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={modInactiveImmune} />
              <span>Moderators are immune to the inactivity timeout</span>
            </label>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={autoMuteGuests} />
              <span>Auto-mute unregistered guests</span>
            </label>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={autoMuteVpnUsers} />
              <span>Auto-mute VPN or datacenter users</span>
            </label>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={loadSnapshotOnFirstJoin} />
              <span>Load last snapshot when first user joins</span>
            </label>
            <span class="form-hint">The first person into an empty room picks the board up where it was left. Off starts them on a blank canvas.</span>
          </div>

          <div class="form-group">
            <span class="form-label">Saved board state</span>
            <div class="start-state-card">
              {#if startStateThumbUrl}
                <img class="start-state-thumb" src={startStateThumbUrl} alt="Saved board state" draggable="false" />
              {:else}
                <div class="start-state-thumb start-state-thumb-empty">
                  {startState === 0 || startState === 3 ? 'Blank' : startState < 0 ? '' : 'No preview'}
                </div>
              {/if}
              <div class="start-state-meta">
                <span class="start-state-title">{startStateTitle}</span>
                <span class="start-state-sub">{startStateSubtitle}</span>
                {#if startStateSnapshot?.name}
                  <span class="start-state-name">{startStateSnapshot.name}</span>
                {/if}
              </div>
            </div>
            <div class="start-state-actions">
              <button
                type="button"
                class="start-state-btn"
                onclick={setStartStateToCurrentBoard}
                disabled={startStateBusy}
              >Set to current board</button>
              <button
                type="button"
                class="start-state-btn"
                onclick={clearStartState}
                disabled={startStateBusy || startState === 3 || startState === 0}
              >Clear</button>
              <button
                type="button"
                class="start-state-btn"
                onclick={followLatestSnapshot}
                disabled={startStateBusy || (startState !== 2 && startState !== 3)}
              >Use latest snapshot</button>
            </div>
            <span class="form-hint">
              What this room opens on once it has been empty. Left alone it follows the room&rsquo;s newest
              snapshot. <strong>Set to current board</strong> pins this exact board until you change it.
              <strong>Clear</strong> makes it open blank without deleting anything &mdash; the next snapshot
              taken becomes the start state again, so use the checkbox above if you want it blank for good.
            </span>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={hideChatNotifications} />
              <span>Hide chat pop-up notifications in this room</span>
            </label>
          </div>

          <div class="form-group">
            <span class="form-label">Vector text fade time</span>
            <div class="text-fade-inputs">
              <input
                type="number"
                min="0"
                max="30"
                step="1"
                class="room-input text-fade-num"
                bind:value={textFadeMinutes}
                aria-label="Minutes"
              />
              <span class="text-fade-unit">min</span>
              <input
                type="number"
                min="0"
                max="59"
                step="1"
                class="room-input text-fade-num"
                bind:value={textFadeSeconds}
                aria-label="Seconds"
              />
              <span class="text-fade-unit">sec</span>
            </div>
            <span class="form-hint">How long ephemeral SVG text stays visible before fully fading away. Range: 5 seconds to 30 minutes.</span>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={obscureRequiresRegistered} />
              <span>Only registered users can reveal obscured regions</span>
            </label>
          </div>

          <div class="form-group">
            <label for="roomReplayUploader">Replay uploader and Sync Master</label>
            <input
              type="text"
              id="roomReplayUploader"
              bind:value={dedicatedReplayUser}
              class="room-input"
              placeholder={roomData?.electedUploader ? `Auto: ${roomData.electedUploader}` : 'Auto-selected by server'}
              maxlength="20"
            />
            <span class="form-hint">
              Leave blank to let the server auto-elect the best candidate.
              {#if roomData?.electedUploader && !dedicatedReplayUser}
                Currently elected: <strong>{roomData.electedUploader}</strong>
              {/if}
            </span>
          </div>
          {/if}

          {#if canShowUnregister()}
            <section class="danger-zone">
              <div class="danger-zone-copy">
                <h4>Danger Zone</h4>
                <p>Unregistering removes ownership of this room and allows someone else to claim it.</p>
              </div>
              <button class="btn danger" type="button" onclick={openUnregisterConfirm} disabled={unregistering}>
                {unregistering ? 'Unregistering...' : 'Unregister Room'}
              </button>
            </section>
          {/if}
        {:else if activeTab === TAB_FLOATING_GALLERY}
          <section class="moderation-panel">
            <div class="floating-gallery-toolbar">
              <div>
                <h4>Floating Gallery Layout</h4>
                <p>The server seed below is shared by everyone in the room, so the Voronoi layout stays synchronized.</p>
              </div>
              <div class="floating-gallery-toolbar-actions">
                <div class="floating-seed-chip">Seed: {floatingGallerySeed || 'not set'}</div>
                <button class="btn secondary small" type="button" onclick={regenerateFloatingGallerySeed}>Regenerate Layout</button>
              </div>
            </div>

            <div class="floating-gallery-summary">
              <span>{floatingGalleryIncludeIds.length} visible</span>
              <span>{floatingGalleryExcludeIds.length} excluded</span>
              <span>{floatingGalleryBrowsePages} gallery pages</span>
            </div>
          </section>

          <section class="moderation-panel">
            <div class="floating-gallery-toolbar">
              <div>
                <h4>Visible</h4>
                <p>Images currently shown in the floating gallery — either pinned explicitly or tagged with this room and liked at least once.</p>
              </div>
              <div class="moderation-toolbar-actions">
                <button class="btn secondary small" type="button" onclick={() => fetchFloatingGalleryVisibleItems(true)}>
                  {floatingGalleryVisibleLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>

            {#if floatingGalleryVisibleItems.length > 0}
              <div class="floating-gallery-grid">
                {#each floatingGalleryVisibleItems as item (item.id)}
                  <article class="floating-gallery-card">
                    <img class="floating-gallery-thumb" src={item.thumbUrl || item.url} alt={item.title || 'Gallery image'} loading="lazy" />
                    <div class="floating-gallery-card-body">
                      <div class="floating-gallery-card-meta">
                        <strong>{item.author}</strong>
                        <span>{item.likesCount || 0} hearts</span>
                      </div>
                      <div class="floating-gallery-card-actions">
                        {#if floatingGalleryIncludeIds.includes(item.id)}
                          <button
                            type="button"
                            class="btn small danger"
                            onclick={() => setFloatingGalleryMode(item.id, 'default')}
                          >
                            Unpin
                          </button>
                        {:else}
                          <button
                            type="button"
                            class="btn small secondary"
                            class:danger={true}
                            onclick={() => setFloatingGalleryMode(item.id, 'exclude')}
                          >
                            Exclude
                          </button>
                        {/if}
                      </div>
                    </div>
                  </article>
                {/each}
              </div>
            {:else}
              <div class="table-empty floating-gallery-empty">
                {floatingGalleryVisibleLoading ? 'Loading visible gallery images...' : 'No images visible yet. Tag images with this room name and give them a like, or add them below.'}
              </div>
            {/if}
          </section>

          <section class="moderation-panel">
            <div class="floating-gallery-toolbar">
              <div>
                <h4>All Gallery Images</h4>
                <p>Browse the full gallery and add any image to the room include list. Excluded ids are also saved with the room settings.</p>
              </div>
              <div class="moderation-toolbar-actions">
                <div class="floating-gallery-sort-toggle" role="group" aria-label="Gallery sort">
                  <button
                    class:active={floatingGalleryBrowseSort === 'newest'}
                    type="button"
                    onclick={() => setFloatingGalleryBrowseSort('newest')}
                  >
                    Newest
                  </button>
                  <button
                    class:active={floatingGalleryBrowseSort === 'top'}
                    type="button"
                    onclick={() => setFloatingGalleryBrowseSort('top')}
                  >
                    Likes
                  </button>
                </div>
                <button class="btn secondary small" type="button" onclick={() => fetchFloatingGalleryBrowsePage(true)}>
                  {floatingGalleryBrowseLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>

            {#if floatingGalleryBrowseItems.length > 0}
              <div class="floating-gallery-grid">
                {#each floatingGalleryBrowseItems.filter(item => !floatingGalleryVisibleItems.some(v => v.id === item.id)) as item (item.id)}
                  <article class="floating-gallery-card">
                    <img class="floating-gallery-thumb" src={item.thumbUrl || item.url} alt={item.title || 'Gallery image'} loading="lazy" />
                    <div class="floating-gallery-card-body">
                      <div class="floating-gallery-card-meta">
                        <strong>{item.author}</strong>
                        <span>{item.likesCount || 0} hearts</span>
                      </div>
                      <div class="floating-gallery-card-actions">
                        <button
                          type="button"
                          class="btn small primary"
                          onclick={() => setFloatingGalleryMode(item.id, 'include')}
                        >
                          Add
                        </button>
                        <button
                          type="button"
                          class="btn small secondary"
                          class:danger={floatingGalleryMode(item.id) === 'exclude'}
                          onclick={() => setFloatingGalleryMode(item.id, floatingGalleryMode(item.id) === 'exclude' ? 'default' : 'exclude')}
                        >
                          {floatingGalleryMode(item.id) === 'exclude' ? 'Unexclude' : 'Exclude'}
                        </button>
                      </div>
                    </div>
                  </article>
                {/each}
              </div>

              <div class="floating-gallery-pagination">
                <button class="btn secondary small" type="button" onclick={() => goToFloatingGalleryPage(floatingGalleryBrowsePage - 1)} disabled={floatingGalleryBrowsePage <= 1}>Previous</button>
                <span>Page {floatingGalleryBrowsePage} of {floatingGalleryBrowsePages}</span>
                <button class="btn secondary small" type="button" onclick={() => goToFloatingGalleryPage(floatingGalleryBrowsePage + 1)} disabled={floatingGalleryBrowsePage >= floatingGalleryBrowsePages}>Next</button>
              </div>
            {:else}
              <div class="table-empty floating-gallery-empty">
                {floatingGalleryBrowseLoading ? 'Loading gallery page...' : 'No gallery images found.'}
              </div>
            {/if}
          </section>
        {:else}
          <section class="moderation-panel">
            <div class="moderation-toolbar">
              <div>
                <h4>Room Staff</h4>
                <p>Search current moderators and apply rank changes inline.</p>
              </div>
              <div class="moderation-toolbar-actions">
                <input
                  type="text"
                  bind:value={rosterFilter}
                  class="room-input moderation-search"
                  placeholder="Search users, rank, or promoted by..."
                />
                <button class="btn secondary small" onclick={() => requestModerationRoster(true)} type="button">
                  {rosterLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>

            <div class="moderation-table-wrap">
              <table class="moderation-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Date</th>
                    <th>Promoted By</th>
                    <th>Rank</th>
                  </tr>
                </thead>
                <tbody>
                  {#if filteredRoster().length > 0}
                    {#each filteredRoster() as entry (entry.userId)}
                      <tr>
                        <td>
                          <div class="table-user-cell">
                            <strong>{entry.username}</strong>
                            {#if entry.isOwner}
                              <span class="table-subtle">Room owner</span>
                            {/if}
                          </div>
                        </td>
                        <td>{formatTimestamp(entry.updatedAt)}</td>
                        <td>{lastUpdatedBy(entry)}</td>
                        <td>
                          <div class="rank-action-cell">
                            <div class="rank-select-shell" class:disabled={entry.isOwner || roleSavingTarget === entry.userId}>
                              <span class="rank-select-value">{roleOptionLabel(pendingRoleValue(entry.userId, entry.role))}</span>
                              <select
                                class="table-rank-select"
                                aria-label={`Rank for ${entry.username}`}
                                disabled={entry.isOwner || roleSavingTarget === entry.userId}
                                onchange={(e) => setPendingRole(entry.userId, Number(e.currentTarget.value))}
                              >
                                {#each ROLE_OPTIONS as option}
                                  <option
                                    value={option.value}
                                    selected={option.value === pendingRoleValue(entry.userId, entry.role)}
                                  >
                                    {option.label}
                                  </option>
                                {/each}
                              </select>
                            </div>
                            <button
                              class="btn primary small"
                              type="button"
                              disabled={entry.isOwner || roleSavingTarget === entry.userId || pendingRoleValue(entry.userId, entry.role) === entry.role}
                              onclick={() => applyRoleChange(entry.userId, pendingRoleValue(entry.userId, entry.role), {
                                isOwner: entry.isOwner,
                                currentRole: entry.role
                              })}
                            >
                              {roleSavingTarget === entry.userId ? 'Applying...' : 'Apply'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    {/each}
                  {:else}
                    <tr>
                      <td colspan="4" class="table-empty">
                        {rosterLoading ? 'Loading moderator roster...' : 'No moderation matches found.'}
                      </td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </section>

          <section class="moderation-panel">
            <div class="moderation-split">
              <div class="subpanel">
                <h4>Online Members</h4>
                <p>Promote connected registered users directly from the room.</p>

                <div class="moderation-table-wrap">
                  <table class="moderation-table">
                    <thead>
                      <tr>
                        <th>User</th>
                        <th>Date</th>
                        <th>Promoted By</th>
                        <th>Rank</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#if filteredOnlineCandidates().length > 0}
                        {#each filteredOnlineCandidates() as candidate (candidate.id)}
                          <tr>
                            <td>
                              <div class="table-user-cell">
                                <strong>{candidate.username}</strong>
                                <span class="table-subtle">Current role: {roleLabel(candidate.role)}</span>
                              </div>
                            </td>
                            <td class="table-muted">Online now</td>
                            <td class="table-muted">Pending</td>
                            <td>
                              <div class="rank-action-cell">
                                <div class="rank-select-shell" class:disabled={roleSavingTarget === candidate.id}>
                                  <span class="rank-select-value">{roleOptionLabel(pendingRoleValue(candidate.id, 0))}</span>
                                  <select
                                    class="table-rank-select"
                                    aria-label={`Rank for ${candidate.username}`}
                                    disabled={roleSavingTarget === candidate.id}
                                    onchange={(e) => setPendingRole(candidate.id, Number(e.currentTarget.value))}
                                  >
                                    {#each ROLE_OPTIONS as option}
                                      <option
                                        value={option.value}
                                        selected={option.value === pendingRoleValue(candidate.id, 0)}
                                      >
                                        {option.label}
                                      </option>
                                    {/each}
                                  </select>
                                </div>
                                <button
                                  class="btn primary small"
                                  type="button"
                                  disabled={roleSavingTarget === candidate.id || pendingRoleValue(candidate.id, 0) === 0}
                                  onclick={() => applyRoleChange(candidate.id, pendingRoleValue(candidate.id, 0), {
                                    currentRole: 0
                                  })}
                                >
                                  {roleSavingTarget === candidate.id ? 'Applying...' : 'Apply'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        {/each}
                      {:else}
                        <tr>
                          <td colspan="4" class="table-empty">No additional registered members match this filter.</td>
                        </tr>
                      {/if}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section class="moderation-panel compact-panel">
            <div class="offline-promo-row">
              <div class="offline-promo-copy">
                <h4>Offline Promotion</h4>
                <p>Assign a room role by username even if the user is not online.</p>
              </div>

              <input
                id="offlinePromotionName"
                type="text"
                bind:value={offlinePromotionName}
                class="room-input compact-input offline-name-input"
                placeholder="Exact username"
              />

              <select id="offlinePromotionRole" bind:value={offlinePromotionRole} class="room-input compact-input offline-role-select">
                {#each ROLE_OPTIONS as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>

              <button class="btn primary small" type="button" onclick={applyOfflinePromotion} disabled={roleSavingTarget.startsWith('username:')}>
                Apply
              </button>
            </div>
          </section>
        {/if}
      </div>

      <div class="room-settings-footer">
        <button class="btn secondary" onclick={() => hide({ discardFloatingGalleryChanges: true })}>Cancel</button>
        {#if activeTab === TAB_GENERAL || activeTab === TAB_FLOATING_GALLERY}
          <button class="btn primary" onclick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        {/if}
      </div>

      {#if showUnregisterConfirm}
        <div class="dialog-confirm-backdrop" role="presentation">
          <div class="dialog-confirm" role="alertdialog" aria-modal="true" aria-labelledby="unregisterTitle">
            <h4 id="unregisterTitle">Unregister This Room?</h4>
            <p><strong>{roomId}</strong> will lose its owner and become claimable by anyone.</p>
            <p>This does not delete the room, but it does remove your ownership protection.</p>
            <div class="dialog-confirm-actions">
              <button class="btn secondary" type="button" onclick={closeUnregisterConfirm} disabled={unregistering}>Keep Registered</button>
              <button class="btn danger" type="button" onclick={unregisterRoom} disabled={unregistering}>
                {unregistering ? 'Unregistering...' : 'Yes, Unregister'}
              </button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .room-settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    backdrop-filter: blur(4px);
  }

  .room-settings-dialog {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    max-width: 920px;
    width: 100%;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
    color: var(--text-primary);
    font-family: 'Inter', -apple-system, sans-serif;
  }

  .room-settings-header {
    padding: 1.25rem 1.5rem 0;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .room-settings-header-main {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    min-width: 0;
    flex: 1;
  }

  .room-settings-header h3,
  .moderation-panel h4 {
    margin: 0;
  }

  .moderation-panel p {
    margin: 0.35rem 0 0;
    color: var(--text-secondary);
    font-size: 0.92rem;
  }

  .room-settings-close {
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
  }

  .room-settings-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: -1px;
  }

  .room-settings-tab {
    border: 1px solid var(--border-subtle);
    border-bottom: none;
    background: color-mix(in srgb, var(--bg-primary) 62%, transparent);
    color: var(--text-secondary);
    padding: 0.7rem 1rem;
    border-radius: 8px 8px 0 0;
    cursor: pointer;
    font-weight: 600;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .room-settings-tab:hover {
    background: color-mix(in srgb, var(--bg-tertiary) 86%, transparent);
    color: var(--text-primary);
  }

  .room-settings-tab.active {
    background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
    border-color: color-mix(in srgb, var(--accent-primary) 22%, var(--border-subtle));
    color: var(--text-primary);
  }

  .room-settings-body {
    padding: 1rem 1.1rem 1.1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    cursor: grab;
  }

  .room-settings-body.drag-scrolling {
    cursor: grabbing;
    user-select: none;
  }

  .room-settings-message {
    padding: 0.8rem 1rem;
    border-radius: 6px;
  }

  .room-settings-message.success {
    background: color-mix(in srgb, #50c878 14%, transparent);
    border: 1px solid color-mix(in srgb, #50c878 28%, transparent);
    color: color-mix(in srgb, #50c878 70%, white);
  }

  .room-settings-message.error {
    background: color-mix(in srgb, #dc505a 14%, transparent);
    border: 1px solid color-mix(in srgb, #dc505a 28%, transparent);
    color: color-mix(in srgb, #dc505a 52%, white);
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .form-group label,
  .form-group .form-label {
    font-size: 0.84rem;
    color: var(--text-primary);
  }

  .form-hint {
    font-size: 0.76rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .start-state-card {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.55rem;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg-primary) 84%, black);
  }

  .start-state-thumb {
    width: 96px;
    aspect-ratio: 16 / 9;
    flex: 0 0 auto;
    object-fit: cover;
    border-radius: 5px;
    background: color-mix(in srgb, var(--bg-tertiary) 85%, black);
    display: block;
  }

  .start-state-thumb-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    color: var(--text-muted);
    border: 1px dashed var(--border-subtle);
  }

  .start-state-meta {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .start-state-title {
    font-size: 0.84rem;
    color: var(--text-primary);
  }

  .start-state-sub,
  .start-state-name {
    font-size: 0.74rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .start-state-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .start-state-btn {
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: color-mix(in srgb, var(--bg-primary) 84%, black);
    color: var(--text-secondary);
    padding: 0.42rem 0.7rem;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .start-state-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-color) 24%, transparent);
    color: var(--text-primary);
  }

  .start-state-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .form-hint strong {
    color: color-mix(in srgb, var(--accent-primary) 72%, white);
  }

  .room-input,
  .room-textarea,
  .table-rank-select {
    width: 100%;
    background: color-mix(in srgb, var(--bg-primary) 82%, black);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    color: var(--text-primary);
    -webkit-text-fill-color: var(--text-primary);
    color-scheme: dark;
    padding: 0.62rem 0.72rem;
    font: inherit;
  }

  .room-input option,
  .table-rank-select option {
    background: var(--bg-secondary);
    color: var(--text-primary);
    -webkit-text-fill-color: var(--text-primary);
  }

  .compact-input {
    padding: 0.5rem 0.65rem;
    font-size: 0.92rem;
  }

  .text-fade-inputs {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .text-fade-num {
    width: 5rem;
    text-align: center;
  }
  .text-fade-unit {
    color: var(--text-secondary);
    font-size: 0.92rem;
  }

  .room-input.disabled {
    opacity: 0.75;
    cursor: not-allowed;
  }

  .room-textarea {
    resize: vertical;
    min-height: 72px;
  }

  .color-input-group {
    display: grid;
    grid-template-columns: 72px 1fr;
    gap: 0.75rem;
  }

  .room-color-input {
    width: 100%;
    height: 46px;
    border: none;
    background: transparent;
    padding: 0;
  }

  .checkbox-group label {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: 0.92rem;
  }

  .moderation-panel {
    background: color-mix(in srgb, var(--text-primary) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-primary) 6%, transparent);
    border-radius: 10px;
    padding: 0.8rem 0.9rem;
  }

  .compact-panel {
    padding: 0.7rem 0.9rem;
  }

  .danger-zone {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 1rem;
    border: 1px solid color-mix(in srgb, #dc505a 28%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, #dc505a 8%, transparent);
  }

  .danger-zone-copy h4 {
    margin: 0;
    color: color-mix(in srgb, #dc505a 25%, white);
  }

  .danger-zone-copy p {
    margin: 0.25rem 0 0;
    color: color-mix(in srgb, #dc505a 40%, white);
    font-size: 0.86rem;
  }

  .moderation-toolbar {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.65rem;
  }

  .floating-gallery-toolbar {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    margin-bottom: 0.75rem;
  }

  .floating-gallery-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .floating-seed-chip,
  .floating-gallery-summary span {
    background: color-mix(in srgb, var(--bg-primary) 84%, black);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    padding: 0.4rem 0.7rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .floating-gallery-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.55rem;
  }

  .floating-gallery-sort-toggle {
    display: inline-flex;
    overflow: hidden;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg-primary) 84%, black);
  }

  .floating-gallery-sort-toggle button {
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    padding: 0.42rem 0.7rem;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .floating-gallery-sort-toggle button:hover,
  .floating-gallery-sort-toggle button.active {
    background: color-mix(in srgb, var(--accent-color) 24%, transparent);
    color: var(--text-primary);
  }

  .floating-gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 0.85rem;
  }

  .floating-gallery-card {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-primary) 82%, black);
    border: 1px solid color-mix(in srgb, var(--text-primary) 6%, transparent);
  }

  .floating-gallery-thumb {
    width: 100%;
    aspect-ratio: 1 / 1;
    object-fit: cover;
    display: block;
    background: color-mix(in srgb, var(--bg-tertiary) 85%, black);
  }

  .floating-gallery-card-body {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    padding: 0.7rem;
  }

  .floating-gallery-card-meta {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .floating-gallery-card-meta strong,
  .floating-gallery-card-meta span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .floating-gallery-card-meta span {
    color: var(--text-secondary);
    font-size: 0.82rem;
  }

  .floating-gallery-card-actions {
    display: flex;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .floating-gallery-pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.8rem;
    margin-top: 0.95rem;
    color: var(--text-secondary);
    font-size: 0.84rem;
  }

  .floating-gallery-empty {
    padding: 1rem 0.25rem 0.15rem;
  }

  .moderation-toolbar-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .moderation-search {
    min-width: 220px;
    font-size: 0.84rem;
    padding: 0.45rem 0.6rem;
  }

  .moderation-table-wrap {
    overflow-x: auto;
    border: 1px solid color-mix(in srgb, var(--text-primary) 6%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg-primary) 88%, black);
  }

  .moderation-table {
    width: 100%;
    border-collapse: collapse;
    min-width: 680px;
    font-size: 0.92rem;
  }

  .moderation-table th,
  .moderation-table td {
    text-align: left;
    padding: 0.55rem 0.7rem;
    border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 6%, transparent);
    vertical-align: middle;
  }

  .moderation-table th {
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--text-primary) 2%, transparent);
  }

  .moderation-table tbody tr:last-child td {
    border-bottom: none;
  }

  .table-user-cell {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    line-height: 1.2;
  }

  .table-subtle,
  .table-muted {
    color: var(--text-secondary);
    font-size: 0.77rem;
  }

  .table-empty {
    text-align: center;
    color: var(--text-secondary);
  }

  .rank-action-cell {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .table-rank-select {
    position: absolute;
    inset: 0;
    min-width: 96px;
    max-width: none;
    height: 100%;
    background: transparent;
    border: 0;
    color: transparent;
    -webkit-text-fill-color: transparent;
    padding: 0.38rem 0.48rem;
    font-size: 0.88rem;
    appearance: none;
    cursor: pointer;
  }

  .rank-select-shell {
    position: relative;
    flex: 0 0 108px;
    min-width: 108px;
    height: 32px;
    background: color-mix(in srgb, var(--bg-primary) 82%, black);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    color: var(--text-primary);
  }

  .rank-select-shell::after {
    content: "";
    position: absolute;
    top: 50%;
    right: 0.56rem;
    width: 0.42rem;
    height: 0.42rem;
    border-right: 1.5px solid var(--text-secondary);
    border-bottom: 1.5px solid var(--text-secondary);
    transform: translateY(-65%) rotate(45deg);
    pointer-events: none;
  }

  .rank-select-shell:focus-within {
    border-color: var(--border-active);
  }

  .rank-select-shell.disabled {
    opacity: 0.50;
    cursor: not-allowed;
  }

  .rank-select-value {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    padding: 0 1.35rem 0 0.48rem;
    color: var(--text-primary);
    font-size: 0.88rem;
    line-height: 1;
    pointer-events: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .moderation-split {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .subpanel {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .offline-promo-row {
    display: grid;
    grid-template-columns: minmax(180px, 1.2fr) minmax(170px, 1fr) 120px auto;
    gap: 0.55rem;
    align-items: end;
  }

  .offline-promo-copy h4 {
    margin: 0;
  }

  .offline-promo-copy p {
    margin: 0.18rem 0 0;
    font-size: 0.8rem;
  }

  .offline-name-input {
    min-width: 0;
  }

  .offline-role-select {
    min-width: 0;
  }

  .room-settings-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 0.8rem 1.1rem 1rem;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
  }

  .dialog-confirm-backdrop {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--surface-overlay) 78%, black);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  .dialog-confirm {
    width: min(100%, 420px);
    background: color-mix(in srgb, var(--bg-primary) 92%, black);
    border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
    border-radius: 12px;
    padding: 1rem 1rem 0.95rem;
    box-shadow: var(--shadow-lg);
  }

  .dialog-confirm h4 {
    margin: 0 0 0.5rem;
  }

  .dialog-confirm p {
    margin: 0 0 0.55rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .dialog-confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.65rem;
    margin-top: 0.9rem;
  }

  .btn.small {
    padding: 0.42rem 0.68rem;
    font-size: 0.8rem;
  }

  @media (max-width: 860px) {
    .moderation-split,
    .form-grid,
    .moderation-toolbar,
    .floating-gallery-toolbar {
      grid-template-columns: 1fr;
      display: grid;
    }

    .moderation-toolbar-actions {
      flex-direction: column;
      align-items: stretch;
    }

    .floating-gallery-toolbar-actions {
      justify-content: flex-start;
    }

    .moderation-search {
      min-width: 0;
    }

    .offline-promo-row {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    .danger-zone {
      flex-direction: column;
      align-items: stretch;
    }
  }

  @media (max-width: 700px) {
    .room-settings-dialog {
      max-height: 95vh;
    }

    .moderation-table {
      min-width: 560px;
    }

    .rank-action-cell {
      flex-direction: column;
      align-items: stretch;
    }

    .room-settings-footer {
      flex-wrap: wrap;
    }
  }

  /* While the mobile tutorial toast is showing (see TutorialOverlay.svelte),
     shrink this dialog's own space so it renders below the toast instead of
     under it. */
  @media (max-width: 640px), (max-height: 640px) {
    :global(html[data-tutorial-active='true']) .room-settings-overlay {
      align-items: flex-start;
      padding-top: calc(var(--tutorial-toast-bottom, 0px) + 8px);
    }

    :global(html[data-tutorial-active='true']) .room-settings-dialog {
      max-height: calc(90vh - var(--tutorial-toast-bottom, 0px) - 8px);
    }
  }
</style>
