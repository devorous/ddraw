/**
 * @fileoverview Mounts and manages Svelte UI components for the drawing app
 */

import { mount, unmount } from 'svelte';
import { deferredReplay, deferredAdminPanel } from '../../platform/deferredModules.js';
import { debug } from '../../utils/debug.js';
import BoardMenu from './BoardMenu.svelte';
import ProfileDialog from './ProfileDialog.svelte';
import GalleryItemDialog from './GalleryItemDialog.svelte';
import RoomSettings from './RoomSettings.svelte';
import AppSettings from './AppSettings.svelte';
import ColorPalette from './ColorPalette.svelte';
import DockablePanel from './DockablePanel.svelte';
import Chat from './Chat.svelte';
import Messenger from '../../messenger/Messenger.svelte';
import FeedbackWidget from './FeedbackWidget.svelte';
import FloatingArtManager from './FloatingArtManager.svelte';
import FloatingPalette from './FloatingPalette.svelte';
import TutorialOverlay from './TutorialOverlay.svelte';
import ChangelogOverlay from './ChangelogOverlay.svelte';
import RanksDialog from './RanksDialog.svelte';

import { appState, showProfile as showProfileFromState, toggleMessenger } from '../../state.svelte.js';
import { applyRoomBoardSize } from '../../config/BoardSizes.js';
import { messenger } from '../../messenger/messenger.svelte.js';
import { isTauriDesktop, updateDiscordRichPresence } from '../../platform/desktop.js';
import {
  broadcastChatPopoutState,
  closeChatPopout,
  focusChatPopout,
  getChatSharedState,
  initMainChatPopoutBridge,
  openChatPopoutWindow
} from '../../platform/chatPopoutBridge.js';

function chatNameColor(color) {
  if (!Array.isArray(color)) return color || '#8ba3c7';
  const [r = 139, g = 163, b = 199] = color;
  const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  if (luminance < 72) return 'var(--role-user)';
  return `rgb(${r}, ${g}, ${b})`;
}

function buildDiscordPresencePayload(app) {
  const roomId = appState.currentRoomId || null;
  const roomData = appState.currentRoomData || {};
  const connected = !!appState.connected && !!roomId && roomId !== '_discovery' && !app.isOfflineMode;
  const remoteUserCount = appState.users instanceof Map ? appState.users.size : 0;
  const userCount = connected ? remoteUserCount + 1 : 1;
  const maxUsers = Number.isFinite(Number(roomData.maxUsers)) ? Number(roomData.maxUsers) : 20;
  const joinPolicy = String(roomData.joinPolicy || 'open');
  const roomIsPublic = connected && !roomData.private && !roomData.locked && joinPolicy === 'open';

  return {
    connected,
    username: appState.username || app.self?.username || app.self?.name || 'Someone',
    roomId: connected ? roomId : null,
    userCount,
    maxUsers,
    roomIsPublic
  };
}

// Internal wrapper to handle conditional rendering of Messenger based on appState
const MessengerWrapper = (function() {
  return class {
    constructor({ target, props }) {
      this.target = target;
      this.app = props.app;
      
      this.effect = $effect.root(() => {
        $effect(() => {
          const visible = appState.messengerVisible;
          const targetUser = appState.messengerTargetUser;

          if (visible) {
            if (!this.instance) {
              this.instance = mount(Messenger, {
                target: this.target,
                props: {
                  initialTargetUser: targetUser || null,
                  isFloating: true
                }
              });
            }
          } else {
            if (this.instance) {
              debug('Unmounting Messenger');
              unmount(this.instance);
              this.instance = null;
            }
          }
        });
      });
    }
    
    destroy() {
      if (this.instance) unmount(this.instance);
      this.effect();
    }
  };
})();

// Internal wrapper for SnapshotMenu. The component itself is passed in rather
// than imported: it ships in the deferred replay chunk (see deferredModules.js).
const SnapshotMenuWrapper = (function() {
  return class {
    constructor({ target, props }) {
      this.target = target;
      this.app = props.app;
      this.component = props.component;

      this.effect = $effect.root(() => {
        $effect(() => {
          const visible = appState.snapshotMenuVisible;
          if (visible) {
            if (!this.instance) {
              this.instance = mount(this.component, {
                target: this.target,
                props: { app: this.app }
              });
            }
          } else {
            if (this.instance) {
              unmount(this.instance);
              this.instance = null;
            }
          }
        });
      });
    }
    destroy() {
      if (this.instance) unmount(this.instance);
      this.effect();
    }
  };
})();

/**
 * Initialize and mount all Svelte UI components
 * @param {Object} app - Main DrawingApp instance
 */
export function initSvelteUI(app) {
  const components = {};
  const cleanupFns = [];
  const desktopClient = isTauriDesktop();

  if (desktopClient) {
    document.body.classList.add('desktop-window-chrome');
    cleanupFns.push(() => document.body.classList.remove('desktop-window-chrome'));
  }

  const chatBadgeEffect = $effect.root(() => {
    const onWindowFocus = () => { document.title = 'DDraw'; };
    window.addEventListener('focus', onWindowFocus);

    $effect(() => {
      const unread = appState.chatUnreadCount;
      const badgeEl = document.getElementById('chatBadge');
      const chatBtn = document.getElementById('chatBtn');
      if (!badgeEl || !chatBtn) return;

      if (unread > 0) {
        badgeEl.textContent = unread > 99 ? '99+' : String(unread);
        badgeEl.style.display = 'inline-flex';
        chatBtn.setAttribute('data-has-unread', 'true');
        chatBtn.setAttribute('aria-label', `Chat (${unread} unread)`);
        if (!document.hasFocus()) {
          document.title = `DDraw (${unread > 99 ? '99+' : unread})`;
        }
      } else {
        badgeEl.textContent = '';
        badgeEl.style.display = 'none';
        chatBtn.removeAttribute('data-has-unread');
        chatBtn.setAttribute('aria-label', 'Chat');
        document.title = 'DDraw';
      }
    });

    return () => window.removeEventListener('focus', onWindowFocus);
  });
  cleanupFns.push(chatBadgeEffect);

  const chatPopoutStateEffect = $effect.root(() => {
    $effect(() => {
      appState.users;
      appState.sessionIndex;
      appState.selfRole;
      appState.dmRecipient;
      appState.chatUnreadCount;
      broadcastChatPopoutState(getChatSharedState());
    });
  });
  cleanupFns.push(chatPopoutStateEffect);

  if (isTauriDesktop()) {
    let lastDiscordPresenceKey = '';
    const discordPresenceEffect = $effect.root(() => {
      $effect(() => {
        appState.connected;
        appState.currentRoomId;
        appState.currentRoomData;
        appState.users;
        appState.username;

        const payload = buildDiscordPresencePayload(app);
        const key = JSON.stringify(payload);
        if (key === lastDiscordPresenceKey) return;

        lastDiscordPresenceKey = key;
        void updateDiscordRichPresence(payload).catch((error) => {
          debug.warn('[Discord] Failed to update Rich Presence:', error);
        });
      });
    });
    cleanupFns.push(discordPresenceEffect);
  }

  const messengerConnectionEffect = $effect.root(() => {
    $effect(() => {
      const registeredName = appState.self?.registeredName || '';
      if (registeredName) {
        void messenger.init(registeredName);
      } else {
        messenger.disconnect();
      }
    });
  });
  cleanupFns.push(messengerConnectionEffect);

  const messengerBadgeEffect = $effect.root(() => {
    $effect(() => {
      const unread = appState.messengerUnreadCount;
      const badgeEl = document.getElementById('inboxBadge');
      const inboxBtn = document.getElementById('inboxBtn');
      if (!badgeEl || !inboxBtn) return;

      if (unread > 0) {
        badgeEl.textContent = unread > 99 ? '99+' : String(unread);
        badgeEl.style.display = 'inline-flex';
        inboxBtn.setAttribute('data-has-unread', 'true');
        inboxBtn.setAttribute('aria-label', `Inbox (${unread} unread)`);
      } else {
        badgeEl.textContent = '';
        badgeEl.style.display = 'none';
        inboxBtn.removeAttribute('data-has-unread');
        inboxBtn.setAttribute('aria-label', 'Inbox');
      }
    });
  });
  cleanupFns.push(messengerBadgeEffect);

  // Mount Messenger (1-1 E2EE)
  const messengerTarget = document.getElementById('messengerMount');
  if (messengerTarget) {
    components.messenger = new MessengerWrapper({
      target: messengerTarget,
      props: { app }
    });
  }

  // Mount BoardMenu (top-right of board)
  const boardMenuTarget = document.getElementById('boardMenu');
  if (boardMenuTarget) {
    components.boardMenu = mount(BoardMenu, {
      target: boardMenuTarget,
      props: {
        onBlendModeChange: (mode) => app.handleBlendModeChange(mode),
        onBlendBakeModeChange: (mode) => app.handleBlendBakeModeChange(mode),
        onBlendModeLockToggle: (event) => {
          if (event?.shiftKey) {
            app.toolLockManager?.toggleAllLocksForCurrentTool('blendMode');
          } else {
            app.toolLockManager?.toggleLock('blendMode');
          }
        },
        onLayerSelect: (layerIdx) => app.handleLayerSelect(layerIdx),
        onLayerVisibilityToggle: (layerIdx) => app.handleLayerVisibilityToggle(layerIdx),
      }
    });
  }

  // Mount ProfileDialog (modal)
  const profileDialogTarget = document.getElementById('profileDialogMount');
  if (profileDialogTarget) {
    // In Tauri, relative URLs resolve to tauri://localhost — use absolute URL instead
    const galleryBase = isTauriDesktop() ? 'https://ddraw.ca/gallery' : '/gallery';
    const apiBase = import.meta.env.VITE_API_BASE_URL || '';
    components.profileDialog = mount(ProfileDialog, {
      target: profileDialogTarget,
      props: {
        galleryBaseUrl: galleryBase,
        apiBaseUrl: apiBase,
        onViewGallery: (username) => {
          window.open(`${galleryBase}/${encodeURIComponent(username)}`, '_blank');
        },
        onImageClick: (item) => {
          appState.galleryItemDialog = {
            visible: true,
            itemId: item.id
          };
        }
      }
    });
  }

  // Mount GalleryItemDialog (modal)
  const galleryItemDialogTarget = document.getElementById('galleryItemDialogMount');
  if (galleryItemDialogTarget) {
    const apiBase = import.meta.env.VITE_API_BASE_URL || '';
    // In Tauri, relative URLs resolve to tauri://localhost — use absolute URL instead
    const galleryBase = isTauriDesktop() ? 'https://ddraw.ca/gallery' : '/gallery';
    components.galleryItemDialog = mount(GalleryItemDialog, {
      target: galleryItemDialogTarget,
      props: {
        apiBaseUrl: apiBase,
        galleryBaseUrl: galleryBase
      }
    });
  }

  // Mount RoomSettings (modal)
  const roomSettingsTarget = document.getElementById('roomSettingsMount');
  if (roomSettingsTarget) {
    components.roomSettings = mount(RoomSettings, {
      target: roomSettingsTarget,
      props: {
        wsClient: app.wsClient,
        board: app.board,
        ui: app.ui,
        onUpdate: (roomData) => {
          app.currentRoomData = roomData;
          appState.currentRoomData = roomData;
          applyRoomBoardSize(app, roomData?.boardSize, { showToast: false });
        },
        onUnregister: () => {
          if (app.currentRoomData) {
            app.currentRoomData.ownerId = null;
            app.currentRoomData.ownerUsername = null;
          }
          app.updateRoomSettingsButtonVisibility?.();
          setTimeout(() => app.wsClient.requestRoomList(), 500);
          app.ui?.showToast('Room unregistered');
        }
      }
    });
  }

  let appSettingsTarget = document.getElementById('appSettingsMount');
  if (!appSettingsTarget) {
    appSettingsTarget = document.createElement('div');
    appSettingsTarget.id = 'appSettingsMount';
    document.body.appendChild(appSettingsTarget);
  }
  components.appSettings = mount(AppSettings, {
    target: appSettingsTarget,
    props: {
      app
    }
  });

  let ranksDialogTarget = document.getElementById('ranksDialogMount');
  if (!ranksDialogTarget) {
    ranksDialogTarget = document.createElement('div');
    ranksDialogTarget.id = 'ranksDialogMount';
    document.body.appendChild(ranksDialogTarget);
  }
  components.ranksDialog = mount(RanksDialog, { target: ranksDialogTarget });

  // Admin panel ships in its own chunk and is only ever fetched by accounts that
  // can open it: App.updateAuthenticatedActionVisibility preloads it when the
  // server confirms a Deity role, and this mounts it on first open.
  let adminPanelTarget = document.getElementById('adminPanelMount');
  if (!adminPanelTarget) {
    adminPanelTarget = document.createElement('div');
    adminPanelTarget.id = 'adminPanelMount';
    document.body.appendChild(adminPanelTarget);
  }
  let adminPanelInstance = null;
  const adminPanelEffect = $effect.root(() => {
    $effect(() => {
      // The role check lives on the button that sets this flag (and the server
      // re-checks every admin action), so don't second-guess it here — an
      // effective-vs-global role mismatch would leave the panel unmountable.
      if (!appState.adminPanelVisible || adminPanelInstance) return;
      let cancelled = false;
      void deferredAdminPanel.load().then((mod) => {
        if (cancelled || adminPanelInstance) return;
        adminPanelInstance = mount(mod.default, { target: adminPanelTarget, props: {} });
      });
      return () => { cancelled = true; };
    });
  });
  components.adminPanel = {
    destroy() {
      if (adminPanelInstance) unmount(adminPanelInstance);
      adminPanelInstance = null;
      adminPanelEffect();
    }
  };

  let tutorialTarget = document.getElementById('tutorialOverlayMount');
  if (!tutorialTarget) {
    tutorialTarget = document.createElement('div');
    tutorialTarget.id = 'tutorialOverlayMount';
    document.body.appendChild(tutorialTarget);
  }
  components.tutorialOverlay = mount(TutorialOverlay, {
    target: tutorialTarget,
    props: {}
  });

  let changelogTarget = document.getElementById('changelogOverlayMount');
  if (!changelogTarget) {
    changelogTarget = document.createElement('div');
    changelogTarget.id = 'changelogOverlayMount';
    document.body.appendChild(changelogTarget);
  }
  components.changelogOverlay = mount(ChangelogOverlay, {
    target: changelogTarget,
    props: {}
  });

  // Mount ColorPalette
  const colorPaletteTarget = document.getElementById('colorPaletteMount');
  if (colorPaletteTarget) {
    components.colorPalette = mount(ColorPalette, {
      target: colorPaletteTarget,
      props: {
        onColorSelect: (colorOrCallbackOrPreset) => {
          if (typeof colorOrCallbackOrPreset === 'function') {
            colorOrCallbackOrPreset(app.self?.color || [0, 0, 0, 255], {
              tool: app.self?.tool,
              size: app.self?.size,
              settings: app.getCurrentToolPresetSettings?.() || {}
            });
          } else if (
            colorOrCallbackOrPreset !== null &&
            typeof colorOrCallbackOrPreset === 'object' &&
            'color' in colorOrCallbackOrPreset
          ) {
            app.applyCustomPreset(colorOrCallbackOrPreset);
          } else {
            app.handlePaletteColorSelect(colorOrCallbackOrPreset);
          }
        }
      }
    });
  }

  // Mount FloatingPalette
  const floatingPaletteTarget = document.getElementById('floatingPaletteMount');
  if (floatingPaletteTarget) {
    const floatingPaletteInstances = new Map();

    const floatingPaletteEffect = $effect.root(() => {
      const mountPalette = (key, props) => {
        if (floatingPaletteInstances.has(key)) {
          return;
        }

        const paletteHost = document.createElement('div');
        paletteHost.dataset.paletteKey = key;
        paletteHost.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
        floatingPaletteTarget.appendChild(paletteHost);

        const instance = mount(FloatingPalette, {
          target: paletteHost,
          props
        });

        floatingPaletteInstances.set(key, { host: paletteHost, instance });
      };

      const unmountPalette = (key) => {
        const entry = floatingPaletteInstances.get(key);
        if (!entry) {
          return;
        }

        unmount(entry.instance);
        entry.host.remove();
        floatingPaletteInstances.delete(key);
      };

      $effect(() => {
        mountPalette('recent', {
          onColorSelect: (color) => app.handlePaletteColorSelect(color)
        });

        const activeKeys = new Set(['recent']);

        appState.floatingPalettes.forEach((palette, index) => {
          activeKeys.add(palette.id);

          mountPalette(palette.id, {
            paletteId: palette.id,
            initialLeft: Math.max(6, (floatingPaletteTarget.clientWidth || 0) - 120 - (index * 20)),
            initialTop: Math.max(6, (floatingPaletteTarget.clientHeight || 0) - 306 - (index * 20)),
            onColorSelect: (color) => app.handlePaletteColorSelect(color)
          });
        });

        for (const key of floatingPaletteInstances.keys()) {
          if (!activeKeys.has(key)) {
            unmountPalette(key);
          }
        }
      });
    });

    cleanupFns.push(() => {
      floatingPaletteEffect();
      for (const entry of floatingPaletteInstances.values()) {
        unmount(entry.instance);
        entry.host.remove();
      }
      floatingPaletteInstances.clear();
    });
  }

  // Mount dockable panel shell for the board color picker
  let dockablePanelTarget = document.getElementById('dockablePanelOverlayMount');
  if (!dockablePanelTarget) {
    dockablePanelTarget = document.createElement('div');
    dockablePanelTarget.id = 'dockablePanelOverlayMount';
    dockablePanelTarget.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1490;overflow:visible;';
    document.body.appendChild(dockablePanelTarget);
  }
  if (dockablePanelTarget) {
    components.dockablePanel = mount(DockablePanel, {
      target: dockablePanelTarget,
      props: {
        panelId: 'boardColorPickerPanel',
        panelClass: 'boardColorPickerPanel',
        contentId: 'boardColorPicker',
        contentClass: 'boardColorPicker',
        visibilitySource: appState,
        visibleKey: 'boardColorPickerVisible',
        forceVisibleKey: 'boardColorPickerForceVisible',
        hideLabel: 'Minimize (reopen with the pop-out button)',
        moveLabel: 'Move color picker',
        resizeLabel: 'Resize color picker',
        genieTargetSelector: '.colorPickerPopoutButton'
      }
    });
  }

  // Mount Chat
  const chatTarget = document.getElementById('chatMount');
  if (chatTarget) {
    components.chat = mount(Chat, {
      target: chatTarget,
      props: {
        onPopout: () => {
          appState.chatVisible = false;
          openChatPopoutWindow();
        },
        onSend: (message) => app.handleChatSend?.(message),
        onStaffSend: (message) => app.handleStaffChatSend?.(message),
        onStaffSendImage: (imageData) => app.handleStaffChatImageSend?.(imageData),
        onDM: (message, recipientId) => app.handleDMSend?.(message, recipientId),
        onSendImage: (imageData, recipientId) => app.handleChatImageSend?.(imageData, recipientId),
        onReact: (payload) => app.handleChatReaction?.(payload),
        onDeleteMessage: (messageId, staff) => app.handleChatDeleteMessage?.(messageId, staff)
      }
    });
  }

  initMainChatPopoutBridge({
    getSnapshot: () => ({
      chat: components.chat?.getSnapshot?.() ?? null,
      sharedState: getChatSharedState()
    }),
    handleAction: (action) => {
      if (!action || typeof action !== 'object') return;

      switch (action.type) {
        case 'send':
          app.handleChatSend?.(action.message);
          break;
        case 'staff-send':
          app.handleStaffChatSend?.(action.message);
          break;
        case 'staff-send-image':
          app.handleStaffChatImageSend?.(action.imageData);
          break;
        case 'dm-send':
          app.handleDMSend?.(action.message, action.recipientId);
          break;
        case 'send-image':
          app.handleChatImageSend?.(action.imageData, action.recipientId);
          break;
        case 'react':
          components.chat?.applyReaction?.(action.payload);
          if (app.connected && action.payload?.messageId && action.payload?.emoji) {
            app.wsClient.broadcastChatReaction(action.payload);
          }
          break;
        default:
          break;
      }
    }
  });

  // Listen for tray "Open Chat" event; close popout when main window closes
  if (isTauriDesktop()) {
    void import('@tauri-apps/api/event').then(({ listen }) => {
      listen('open-chat', () => {
        if (!focusChatPopout()) {
          openChatPopoutWindow();
        }
      });
    });
    window.addEventListener('beforeunload', () => closeChatPopout(), { once: true });
  }

  // Mount FeedbackWidget (in landing page form)
  const feedbackTarget = document.getElementById('feedbackWidgetMount');
  if (feedbackTarget) {
    components.feedbackWidget = mount(FeedbackWidget, {
      target: feedbackTarget,
      props: { page: 'app' }
    });
  }

  // Timebar, RecorderPanel and SnapshotMenu all drive TimeMachine, so they ship
  // in the deferred replay chunk and mount once it lands. App kicks that load
  // off during init and every join path awaits it, so in practice these are up
  // well before a room is entered — but nothing here blocks the first paint.
  const timebarTarget = document.getElementById('timebarMount');
  let snapshotMenuTarget = document.getElementById('snapshotMenuMount');
  if (!snapshotMenuTarget) {
    snapshotMenuTarget = document.createElement('div');
    snapshotMenuTarget.id = 'snapshotMenuMount';
    document.body.appendChild(snapshotMenuTarget);
  }

  let replayUiTornDown = false;
  const replayUiPromise = deferredReplay.load().then((replay) => {
    if (replayUiTornDown) return;

    if (timebarTarget) {
      components.timebar = mount(replay.Timebar, {
        target: timebarTarget,
        props: { wsClient: app.wsClient }
      });
      // Mini session-recorder viewer; gated internally by
      // appState.recorderPanelVisible. Reuses the timebar mount node.
      components.recorderPanel = mount(replay.RecorderPanel, {
        target: timebarTarget
      });
    }

    components.snapshotMenu = new SnapshotMenuWrapper({
      target: snapshotMenuTarget,
      props: { app, component: replay.SnapshotMenu }
    });
  }).catch(() => {
    // Replay UI stays absent; the rest of the app is unaffected.
  });

  cleanupFns.push(() => { replayUiTornDown = true; });
  void replayUiPromise;

  // Mount FloatingArtManager
  const floatingArtTarget = document.getElementById('floatingArtMount');
  if (floatingArtTarget) {
    let mountedFloatingArtRoomId = null;
    let mountedFloatingArtConfigKey = null;
    const floatingArtEffect = $effect.root(() => {
      $effect(() => {
        const preferences = appState.appPreferences || app.appPreferences || {};
        // lowPowerMode is tri-state ('auto'|'on'|'off') — a truthiness test here
        // would read 'off' as enabled. Resolve it through the app.
        const enabled = preferences.general?.showFloatingArt !== false && !app.isLowPowerModeActive?.();
        const connected = !!appState.connected;
        const roomId = appState.currentRoomId || null;
        const roomData = appState.currentRoomData || null;
        const floatingGallerySeed = roomData?.floatingGallerySeed || 0;
        const floatingGalleryIncludeIds = roomData?.floatingGalleryIncludeIds || [];
        const floatingGalleryExcludeIds = roomData?.floatingGalleryExcludeIds || [];
        const floatingGalleryVoronoi = roomData?.floatingGalleryVoronoi || null;
        const boardWidth = app.board?.getWidth?.() || app.board?.dimensions?.[1] || 2000;
        const boardHeight = app.board?.getHeight?.() || app.board?.dimensions?.[0] || 2000;
        const floatingArtConfigKey = JSON.stringify({
          floatingGallerySeed,
          floatingGalleryIncludeIds,
          floatingGalleryExcludeIds,
          floatingGalleryVoronoiSeed: floatingGalleryVoronoi?.seed || 0,
          floatingGalleryVoronoiVersion: floatingGalleryVoronoi?.version || 0,
          boardWidth,
          boardHeight
        });
        const joinedRoom = connected && !!roomId && roomId !== '_discovery' && !app.isOfflineMode;

        if (enabled && joinedRoom) {
          if (!components.floatingArt || mountedFloatingArtRoomId !== roomId || mountedFloatingArtConfigKey !== floatingArtConfigKey) {
            if (components.floatingArt) {
              unmount(components.floatingArt);
              components.floatingArt = null;
            }

            components.floatingArt = mount(FloatingArtManager, {
              target: floatingArtTarget,
              props: {
                roomId,
                canvasBounds: {
                  x: 0,
                  y: 0,
                  width: boardWidth,
                  height: boardHeight
                },
                enabled: true,
                floatingGallerySeed,
                floatingGalleryIncludeIds,
                floatingGalleryExcludeIds,
                floatingGalleryVoronoi,
                clientDeviceId: app.wsClient?.clientIdentity?.deviceId || '',
                apiBaseUrl: import.meta.env.VITE_API_BASE_URL || '',
                onLike: async (itemOrId) => {
                  const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
                  if (!id) {
                    throw new Error('Missing gallery item id');
                  }

                  const apiBase = import.meta.env.VITE_API_BASE_URL || '';
                  const token = localStorage.getItem('topDrawAuthToken');
                  if (!token) {
                    throw new Error('Login required to like images');
                  }
                  const res = await fetch(`${apiBase}/api/gallery/${id}/like`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                  });

                  if (!res.ok) {
                    throw new Error('Failed to like image');
                  }

                  return res.json().catch(() => ({}));
                },
                onComment: (id) => {
                  // Open gallery in new tab focused on this image
                  // In Tauri, relative URLs resolve to tauri://localhost — use absolute URL instead
                  const galleryBase = isTauriDesktop() ? 'https://ddraw.ca/gallery' : '/gallery';
                  window.open(`${galleryBase}/${encodeURIComponent(id)}`, '_blank');
                }
              }
            });
            mountedFloatingArtRoomId = roomId;
            mountedFloatingArtConfigKey = floatingArtConfigKey;
          }
        } else {
          if (components.floatingArt) {
            unmount(components.floatingArt);
            components.floatingArt = null;
          }
          mountedFloatingArtRoomId = null;
          mountedFloatingArtConfigKey = null;
        }
      });
    });
    cleanupFns.push(floatingArtEffect);
  }

  components._cleanup = () => {
    cleanupFns.forEach((cleanup) => cleanup?.());
  };

  return components;
}

/**
 * Helper to show profile dialog
 * @param {string} username - Username to show profile for
 */
export function showProfile(username) {
  showProfileFromState(username);
}

/**
 * Toggle chat visibility
 */
export function toggleChat() {
  if (focusChatPopout()) return;
  appState.chatVisible = !appState.chatVisible;
}

/**
 * Sync state values from App instance
 * @param {Object} app - DrawingApp instance
 */
export function syncStoresFromApp(app) {
  if (app.board?.layerManager) {
    appState.layerManager = app.board.layerManager;
  }

  if (app.self) {
    appState.currentColor = app.self.color || [0, 0, 0, 255];
    appState.currentTool = app.self.tool || appState.currentTool;
    appState.currentSize = app.self.size ?? appState.currentSize;
    appState.currentToolSettings = app.getCurrentToolPresetSettings?.() || {};
    appState.activeLayer = app.self.activeLayer ?? 2;
    appState.username = app.self.username || app.self.name || '';
  }

  if (app.sessionIndex !== undefined) {
    appState.sessionIndex = app.sessionIndex;
  }

  if (app.currentRoomData) {
    appState.currentRoomData = app.currentRoomData;
  }

  appState.currentRoomId = app.currentRoomId || null;
  appState.connected = !!app.connected;
  appState.roomCreatedByThisBrowser = !!app.wasCurrentRoomCreatedByThisBrowser?.();

  if (app.appPreferences) {
    appState.appPreferences = app.appPreferences;
  }

  if (app.selfRole !== undefined) {
    appState.selfRole = app.selfRole;
  }

  if (app.users) {
    const userMap = new Map();
    app.users.forEach((user, id) => {
      userMap.set(id, {
        id,
        username: user.username || user.name || '',
        color: chatNameColor(user.color),
        registeredName: user.registeredName || '',
        role: user.role || 0,
        tool: user.tool || 'brush',
        afk: !!user.afk,
        isSelf: id === app.sessionIndex
      });
    });
    appState.users = userMap;
  }
}
