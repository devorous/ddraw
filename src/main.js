/** @fileoverview Lightweight landing bootstrap that background-loads the drawing app. */

import { inject } from '@vercel/analytics';
import './css/main.scss';
import { scheduleStartupUpdateCheck } from './platform/updater.js';
import { setupServiceWorker } from './platform/registerSW.js';
import { installAppConfirmGlobal } from './ui/ConfirmDialog.js';
import { initAuthTabs } from './auth/authTabs.js';
import { applyAuthPendingUI, hasStoredAuthToken } from './auth/authPending.js';

inject();

installAppConfirmGlobal();
setupServiceWorker();

// Auto-reload once when a dynamically imported chunk fails to load (stale cache after deploy)
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason?.message?.includes('dynamically imported module') ||
      event.reason?.message?.includes('Failed to fetch')) {
    if (!sessionStorage.getItem('chunk-reload')) {
      sessionStorage.setItem('chunk-reload', '1');
      window.location.reload();
    }
  }
});
// Clear the reload flag on successful load
sessionStorage.removeItem('chunk-reload');

const isFirefox = /Firefox\//i.test(navigator.userAgent) && !/Seamonkey\//i.test(navigator.userAgent);

let app = null;
let appBootPromise = null;
let deferredActionPromise = null;
const APP_BOOT_TIMEOUT_MS = 75000;
const APP_IMPORT_TIMEOUT_MS = 30000;
const FIREFOX_WARNING_DISMISSED_KEY = 'topDrawFirefoxWarningDismissed';

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function importDrawingApp() {
  try {
    return await withTimeout(
      import('./App.js'),
      APP_IMPORT_TIMEOUT_MS,
      `DrawingApp module import exceeded ${APP_IMPORT_TIMEOUT_MS}ms`
    );
  } catch (err) {
    updateShellStatus('connecting', 'Retrying app load...');
    return withTimeout(
      import(/* @vite-ignore */ `./App.js?startupRetry=${Date.now()}`),
      APP_IMPORT_TIMEOUT_MS,
      `DrawingApp module retry exceeded ${APP_IMPORT_TIMEOUT_MS}ms`
    );
  }
}

function showFirefoxWarning() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'display:flex;justify-content:center;align-items:center;position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(3px);z-index:99999;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'padding:32px 40px;background:var(--bg-secondary, #1e1e2e);border:1px solid var(--border-subtle, #333);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);text-align:center;max-width:380px;font-family:inherit;color:var(--text-primary, #e0e0e0);';
    dialog.innerHTML = `
      <div style="font-size:36px;margin-bottom:12px;">&#9888;&#65039;</div>
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;">Firefox Performance Warning</h2>
      <p style="margin:0 0 20px;font-size:14px;color:var(--text-secondary, #aaa);line-height:1.5;">
        Firefox will lag a lot with this app!<br>
        Try using a Chromium-based browser for the best experience:<br>
        <strong style="color:var(--text-primary, #e0e0e0);">Chrome, Edge, Brave, Opera</strong>
      </p>
      <label style="display:flex;align-items:center;justify-content:center;gap:8px;margin:0 0 20px;font-size:13px;color:var(--text-secondary, #aaa);cursor:pointer;">
        <input id="firefoxDismissWarningCheckbox" type="checkbox" style="width:16px;height:16px;accent-color:var(--accent-color, #00d4aa);cursor:pointer;">
        <span>Don't warn me again</span>
      </label>
      <button id="firefoxContinueBtn" style="padding:10px 24px;font-size:14px;font-weight:500;background:var(--bg-tertiary, #2a2a3e);color:var(--text-secondary, #aaa);border:1px solid var(--border-subtle, #333);border-radius:8px;cursor:pointer;">
        Continue anyway
      </button>
    `;

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    document.getElementById('firefoxContinueBtn').addEventListener('click', () => {
      if (document.getElementById('firefoxDismissWarningCheckbox')?.checked) {
        try {
          localStorage.setItem(FIREFOX_WARNING_DISMISSED_KEY, 'true');
        } catch {
          // Ignore storage failures so the user can continue into the app.
        }
      }
      backdrop.remove();
      resolve();
    });
  });
}

function shouldShowFirefoxWarning() {
  try {
    return localStorage.getItem(FIREFOX_WARNING_DISMISSED_KEY) !== 'true';
  } catch {
    return true;
  }
}

function updateShellStatus(status, text) {
  const statusEls = [
    document.getElementById('landingConnectionStatus'),
    document.getElementById('landingConnectionStatusMobile')
  ].filter(Boolean);

  statusEls.forEach((statusEl) => {
    const textEl = statusEl.querySelector('.connectionText');
    if (!textEl) return;

    statusEl.classList.remove('connected', 'disconnected', 'connecting');
    statusEl.classList.add(status);
    textEl.textContent = text;
  });
}

window.updateLandingShellStatus = updateShellStatus;

/**
 * Detects embed mode from the URL: /embed or /embed/<roomName>.
 * /demo is the same boot path but always forces the offline board — it's the
 * no-login "try it now" link, not a room-join shortcut.
 * @returns {{embed: boolean, room: string|null}}
 */
function getEmbedTarget() {
  const demoMatch = window.location.pathname.match(/^\/demo\/?$/);
  if (demoMatch) return { embed: true, room: 'offline' };

  const match = window.location.pathname.match(/^\/embed(?:\/([a-zA-Z0-9_-]+))?\/?$/);
  if (!match) return { embed: false, room: null };
  return { embed: true, room: match[1] || null };
}

/**
 * Removes the loading screen and reveals the app canvas for embed mode.
 * Unlike revealLandingShell, this never shows the landing page/overlay —
 * the embed auto-joins its room (or offline) instead.
 */
function revealEmbedShell() {
  const mainContent = document.getElementById('main');
  const loadingScreen = document.getElementById('app-loading-screen');
  const styleTag = document.getElementById('initial-loading-style');

  if (mainContent) {
    mainContent.style.opacity = '1';
    mainContent.style.transition = 'opacity 0.35s ease-out';
  }
  if (loadingScreen) {
    loadingScreen.style.opacity = '0';
    setTimeout(() => {
      loadingScreen.remove();
      styleTag?.remove();
    }, 350);
  } else {
    styleTag?.remove();
  }
}

/**
 * Boots the app directly into a room (or offline) without the landing page.
 * @param {string|null} room - Room name from the URL, or null/"offline" for solo.
 */
async function initEmbed(room) {
  updateShellStatus('connecting', 'Loading app...');
  scheduleStartupUpdateCheck();

  try {
    const readyApp = await bootApp();
    if (room && room !== 'offline') {
      await readyApp.startLandingJoin(room);
    } else {
      await readyApp.handleOffline();
    }
    revealEmbedShell();
  } catch (err) {
    console.error('Failed to initialize embed app:', err);
    updateShellStatus('disconnected', 'Failed to load');
    // Fall back to offline so the embed still shows a usable canvas.
    try {
      if (app) await app.handleOffline();
      revealEmbedShell();
    } catch {
      // Nothing more we can do; loading screen stays with the error status.
    }
  }
}

function revealLandingShell() {
  const mainContent = document.getElementById('main');
  const loadingScreen = document.getElementById('app-loading-screen');
  const styleTag = document.getElementById('initial-loading-style');
  const overlay = document.getElementById('overlay');
  const landingPage = document.getElementById('landingPage');
  const refreshRoomsBtn = document.getElementById('refreshRoomsBtn');
  const loginJoinBtn = document.getElementById('loginJoinBtn');
  const joinBtnLoggedIn = document.getElementById('joinBtnLoggedIn');
  const authLoggedInJoinBtn = document.getElementById('authLoggedInJoinBtn');
  const roomIdInput = document.getElementById('roomIdInput');
  const roomMatch = window.location.pathname.match(/^\/go\/([a-zA-Z0-9_-]+)$/);

  if (roomIdInput && roomMatch && roomMatch[1] !== 'offline') {
    roomIdInput.value = roomMatch[1];
  }

  if (overlay) {
    overlay.style.display = 'flex';
    overlay.style.background = 'transparent';
    overlay.style.backdropFilter = 'none';
  }
  if (landingPage) {
    landingPage.style.display = 'flex';
  }

  // Auth lives in the deferred App chunk, so set the pending state here or the
  // login form (tabs and all) renders underneath "Loading account..." until it
  // arrives. Auth takes over from this once it inits.
  applyAuthPendingUI(hasStoredAuthToken());
  if (refreshRoomsBtn) {
    refreshRoomsBtn.disabled = true;
    refreshRoomsBtn.classList.add('disabled');
  }
  [loginJoinBtn, joinBtnLoggedIn, authLoggedInJoinBtn].forEach((btn) => {
    if (!btn) return;
    btn.disabled = true;
    btn.classList.add('disabled');
  });

  updateShellStatus('connecting', 'Loading app...');

  if (mainContent) {
    mainContent.style.opacity = '1';
    mainContent.style.transition = 'opacity 0.35s ease-out';
  }
  if (loadingScreen) {
    loadingScreen.style.opacity = '0';
    setTimeout(() => {
      loadingScreen.remove();
      styleTag?.remove();
    }, 350);
  } else {
    styleTag?.remove();
  }
}

async function bootApp() {
  if (app) return app;
  if (appBootPromise) return appBootPromise;

  const wsServerUrl = import.meta.env.VITE_WS_SERVER_URL || null;

  appBootPromise = (async () => {
    const timeoutId = setTimeout(() => {
      updateShellStatus('disconnected', 'App load is taking too long');
    }, APP_BOOT_TIMEOUT_MS);

    try {
      updateShellStatus('connecting', 'Loading auth system...');
      const { initLandingPhase } = await import('./auth-landing.js');

      // Start landing phase (auth + room discovery)
      const landingPhaseResult = await initLandingPhase({
        serverUrl: wsServerUrl,
        onRoomSelected: async (roomId) => {
          // When user selects a room, ensure DrawingApp is loaded
          await appBootPromise;
        },
        onOffline: async () => {
          // When user enters offline mode, ensure DrawingApp is loaded
          await appBootPromise;
        }
      });

      const { wsClient, auth, landingPage, appPreferences } = landingPhaseResult;

      // Start loading DrawingApp in parallel
      updateShellStatus('connecting', 'Loading app code...');
      const { DrawingApp } = await importDrawingApp();

      updateShellStatus('connecting', 'Starting app...');
      const instance = new DrawingApp(wsClient, {
        dimensions: [1080, 1920],
        auth,
        landingPage,
        appPreferences
      });

      await instance.init();
      app = instance;
      window.app = app;
      return app;
    } finally {
      clearTimeout(timeoutId);
    }
  })().catch((err) => {
    appBootPromise = null;
    throw err;
  });

  return appBootPromise;
}

function startBackgroundBoot() {
  void bootApp().catch((err) => {
    console.error('Failed to initialize app:', err);
    const message = err?.message?.includes('DrawingApp module')
      ? 'App code failed to load'
      : 'Failed to load';
    updateShellStatus('disconnected', message);
  });
}

async function runDeferredAction(action) {
  if (app) {
    await action(app);
    return;
  }

  if (deferredActionPromise) return deferredActionPromise;

  updateShellStatus('connecting', 'Loading app...');

  deferredActionPromise = (async () => {
    const readyApp = await bootApp();
    await action(readyApp);
  })().finally(() => {
    deferredActionPromise = null;
  });

  return deferredActionPromise;
}

function attachDeferredLandingHandlers() {
  const loginForm = document.getElementById('loginForm');
  const loginJoinBtn = document.getElementById('loginJoinBtn');
  const joinBtnLoggedIn = document.getElementById('joinBtnLoggedIn');
  const authLoggedInJoinBtn = document.getElementById('authLoggedInJoinBtn');
  const guestJoinBtn = document.getElementById('guestJoinBtn');
  const loginBtn = document.getElementById('loginBtn');
  const loginOfflineBtn = document.getElementById('loginOfflineBtn');
  const refreshRoomsBtn = document.getElementById('refreshRoomsBtn');
  const roomIdInput = document.getElementById('roomIdInput');

  // Guest / Sign in / Register tabs are pure DOM, so they respond immediately
  // instead of waiting on the deferred App chunk. Auth adopts this controller.
  initAuthTabs();

  const canRunDeferredJoin = () => {
    const joinButtons = [authLoggedInJoinBtn, joinBtnLoggedIn, loginJoinBtn, guestJoinBtn]
      .filter((btn) => btn?.offsetParent !== null);
    return joinButtons.some((btn) => !btn.disabled);
  };

  loginForm?.addEventListener('submit', (event) => {
    if (app) return;
    event.preventDefault();
    if (!canRunDeferredJoin()) return;
    void runDeferredAction((readyApp) => readyApp.handleJoin());
  });

  loginJoinBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    if (!canRunDeferredJoin()) return;
    void runDeferredAction((readyApp) => readyApp.handleJoin());
  });

  guestJoinBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    if (!canRunDeferredJoin()) return;
    void runDeferredAction((readyApp) => readyApp.handleJoin());
  });

  loginBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.handleLandingLogin());
  });

  joinBtnLoggedIn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    if (!canRunDeferredJoin()) return;
    void runDeferredAction((readyApp) => readyApp.handleJoin());
  });

  authLoggedInJoinBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    if (!canRunDeferredJoin()) return;
    void runDeferredAction((readyApp) => readyApp.handleJoin());
  });

  loginOfflineBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.handleOffline());
  });

  refreshRoomsBtn?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.connectForRoomDiscovery());
  });

  roomIdInput?.addEventListener('keydown', (event) => {
    if (app || event.key !== 'Enter') return;
    event.preventDefault();
    if (!canRunDeferredJoin()) return;
    void runDeferredAction((readyApp) => readyApp.handleJoin());
  });

  document.getElementById('loginPassword')?.addEventListener('keydown', (event) => {
    if (app || event.key !== 'Enter') return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.handleLandingLogin());
  });

  document.getElementById('registerSubmitBtn')?.addEventListener('click', (event) => {
    if (app) return;
    event.preventDefault();
    void runDeferredAction((readyApp) => readyApp.auth?.handleRegister());
  });
}

async function init() {
  const embedTarget = getEmbedTarget();
  if (embedTarget.embed) {
    void initEmbed(embedTarget.room);
    return;
  }

  revealLandingShell();
  attachDeferredLandingHandlers();

  // Open external links in the default browser when running in Tauri
  const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__);
  if (isTauri) {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (link && link.href) {
        // Resolve the URL to handle relative links correctly
        const url = new URL(link.href, window.location.origin);
        const isExternal = url.origin !== window.location.origin;

        if (isExternal || link.target === '_blank') {
          e.preventDefault();
          e.stopImmediatePropagation();

          import('@tauri-apps/plugin-shell').then(({ open }) => {
            open(link.href);
          }).catch(err => {
            console.error('Failed to open external link via Tauri shell:', err);
            // Fallback: only if really needed, but tauri should handle it
            window.open(link.href, '_blank');
          });
        }
      }
    }, true); // Use capture phase to intercept before other handlers
  }

  if (isFirefox && shouldShowFirefoxWarning()) {
    showFirefoxWarning().then(() => {
      requestAnimationFrame(() => setTimeout(startBackgroundBoot, 0));
    });
  } else {
    requestAnimationFrame(() => {
      setTimeout(startBackgroundBoot, 0);
    });
  }

  scheduleStartupUpdateCheck();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
