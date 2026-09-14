import { isTauriDesktop, openDiscordOAuthWindow } from '../platform/desktop.js';
import { debug } from '../utils/debug.js';
import { resolveApiUrl } from '../config/serverEndpoints.js';
import { badgesForUser, renderBadgesInto } from '../ui/Badges.js';
import { initAuthTabs, setActiveAuthTab } from './authTabs.js';
import { AUTH_TOKEN_KEY, applyAuthPendingUI } from './authPending.js';

/**
 * Auth module — handles token storage, login/register form logic, auto-login
 */
const TOKEN_KEY = AUTH_TOKEN_KEY;
const REMEMBER_ME_KEY = 'topDrawRememberMe';
const USERNAME_KEY = 'topDrawUsername';
const USERNAME_SETUP_DISMISSED_PREFIX = 'topDrawUsernameSetupDismissed:';
const TOKEN_INVALID_ERRORS = new Set([
  'Invalid or expired token',
  'Account not found',
]);

export class Auth {
  constructor({ wsClient, onSuccess, onError, onLoggedInStateChange }) {
    this.wsClient = wsClient;
    this.onSuccess = onSuccess;
    this.onError = onError;
    this.onLoggedInStateChange = onLoggedInStateChange;

    // DOM elements (cached in init)
    this.els = {};

    // Current logged in state
    this.isLoggedIn = false;
    this.loggedInUsername = null;
    this.hasDiscord = false;
    this.selectedBadge = '';
    this.currentAuthSession = null;
    this._autoLoginInFlight = false;
    this._autoLoginToken = null;
    this._autoLoginSent = false;
    this._autoLoginSocket = null;
    this._authPendingTimeout = null;
    this._discordPopup = null;
    this.needsUsernameSetup = false;
    this.suggestedUsername = '';

  }

  isCompactHeightLayout() {
    return window.innerHeight <= 820;
  }

  resetAuthLayoutSizing() {
    const wrapper = this.els.authFormWrapper;
    if (wrapper) {
      wrapper.style.height = '';
      wrapper.style.minHeight = '';
    }

    [this.els.authNotLoggedIn, this.els.authLoggedIn, this.els.passwordResetPanel]
      .filter(Boolean)
      .forEach((el) => {
        el.style.minHeight = '';
      });
  }

  init() {
    this.els = {
      // Login state elements
      authNotLoggedIn: document.getElementById('authNotLoggedIn'),
      authLoggedIn: document.getElementById('authLoggedIn'),
      // Guest / Sign in / Register segmented control
      authTabs: document.getElementById('authTabs'),
      // Not logged in form
      loginUsername: document.getElementById('loginUsername'),
      loginAccountUsername: document.getElementById('loginAccountUsername'),
      loginPassword: document.getElementById('loginPassword'),
      loginBtn: document.getElementById('loginBtn'),
      discordLoginBtn: document.getElementById('discordLoginBtn'),
      discordInviteBtn: document.getElementById('discordInviteBtn'),
      guestJoinBtn: document.getElementById('guestJoinBtn'),
      loginJoinBtn: document.getElementById('loginJoinBtn'),
      rememberMe: document.getElementById('rememberMe'),
      // Logged in state
      authUsernameBtn: document.getElementById('authUsernameBtn'),
      authUsernameDisplay: document.getElementById('authUsernameDisplay'),
      authUserBadges: document.getElementById('authUserBadges'),
      authLoggedInJoinBtn: document.getElementById('authLoggedInJoinBtn'),
      joinBtnLoggedIn: document.getElementById('joinBtnLoggedIn'),
      discordLinkBtn: document.getElementById('discordLinkBtn'),
      // Registration (lives in the Register tab inside #authNotLoggedIn)
      registerUsername: document.getElementById('registerUsername'),
      registerPassword: document.getElementById('registerPassword'),
      registerEmail: document.getElementById('registerEmail'),
      registerSecretQuestion: document.getElementById('registerSecretQuestion'),
      registerSecretAnswer: document.getElementById('registerSecretAnswer'),
      registerSubmitBtn: document.getElementById('registerSubmitBtn'),
      forgotPasswordBtn: document.getElementById('forgotPasswordBtn'),
      passwordResetPanel: document.getElementById('authPasswordResetPanel'),
      passwordResetTitle: document.getElementById('passwordResetTitle'),
      passwordResetClose: document.getElementById('passwordResetClose'),
      passwordResetIdentifier: document.getElementById('passwordResetIdentifier'),
      passwordResetSecretWrap: document.getElementById('passwordResetSecretWrap'),
      passwordResetSecretQuestion: document.getElementById('passwordResetSecretQuestion'),
      passwordResetSecretAnswer: document.getElementById('passwordResetSecretAnswer'),
      passwordResetRequestFields: document.getElementById('passwordResetRequestFields'),
      passwordResetCompleteFields: document.getElementById('passwordResetCompleteFields'),
      passwordResetNewPassword: document.getElementById('passwordResetNewPassword'),
      passwordResetConfirmPassword: document.getElementById('passwordResetConfirmPassword'),
      passwordResetMessage: document.getElementById('passwordResetMessage'),
      passwordResetSubmitBtn: document.getElementById('passwordResetSubmitBtn'),
      // Add email modal
      addEmailStep1: document.getElementById('addEmailStep1'),
      addEmailStep2: document.getElementById('addEmailStep2'),
      addEmailInput: document.getElementById('addEmailInput'),
      addEmailCodeInput: document.getElementById('addEmailCodeInput'),
      addEmailMessage: document.getElementById('addEmailMessage'),
      addEmailCodeMessage: document.getElementById('addEmailCodeMessage'),
      addEmailTarget: document.getElementById('addEmailTarget'),
      addEmailSendBtn: document.getElementById('addEmailSendBtn'),
      addEmailVerifyBtn: document.getElementById('addEmailVerifyBtn'),
      addEmailResendBtn: document.getElementById('addEmailResendBtn'),
      addEmailSkipBtn: document.getElementById('addEmailSkipBtn'),
      usernameSetupBackdrop: null,
      usernameSetupModal: null,
      usernameSetupInput: null,
      usernameSetupMessage: null,
      usernameSetupSaveBtn: null,
      usernameSetupLinkBtn: null,
      usernameSetupDismissBtn: null,
      usernameSetupCloseBtn: null,
      usernameSetupTitle: null,
      usernameSetupText: null,
      usernameSetupFields: null,
      ddrawLinkFields: null,
      ddrawLinkUsername: null,
      ddrawLinkPassword: null,
      ddrawLinkSubmitBtn: null,
      ddrawLinkBackBtn: null,
      roomIdInput: document.getElementById('roomIdInput'),
      authFormWrapper: document.getElementById('authFormWrapper'),
      authLoadingState: document.getElementById('authLoadingState'),
      landingAuthPanel: document.getElementById('landingAuthPanel')
    };

    // Load remember me preference
    if (this.els.rememberMe) {
      this.els.rememberMe.checked = this.getRememberMe();
    }

    this.setupListeners();
    this.ensureUsernameSetupModal();
    this.loadDiscordConfig();
    this.syncAuthStateHeights();
    window.addEventListener('resize', () => this.syncAuthStateHeights());

    // Listen for auth results from WebSocket (in case it fires before AuthModHandlers sets up the main listener)
    if (this.wsClient) {
      this.wsClient.on('auth_result', (data) => this.handleAuthResult(data));
      this.wsClient.on('socket_ready', () => this.sendPendingAutoLogin());
    }
    window.addEventListener('message', (event) => this.handleDiscordPopupMessage(event));

    // Check if user has stored credentials for auto-login
    const handledDiscordAuth = this.handleDiscordAuthFromUrl();
    const openedPasswordReset = !handledDiscordAuth && this.openPasswordResetFromUrl();
    if (!openedPasswordReset && !handledDiscordAuth) {
      this.checkStoredLogin();
    }
    if (openedPasswordReset || handledDiscordAuth || !this.getStoredToken()) {
      this.setAuthPending(false);
    }
  }

  /**
   * Adopt the shared tab controller (already wired by main.js at first paint)
   * and react to switches. The tabs themselves are DOM-only, so they work
   * before the deferred App chunk — and therefore this class — exists.
   */
  setupAuthTabs() {
    const tabs = initAuthTabs();
    if (!tabs) return;

    tabs.subscribe(() => {
      this.clearLandingError();
      this.syncAuthStateHeights();
    });
  }

  setActiveAuthTab(name, options) {
    setActiveAuthTab(name, options);
  }

  setupListeners() {
    this.setupAuthTabs();

    this.els.loginBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.handleLogin();
    });

    this.els.discordLoginBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      debug('[DiscordDebug] discordLoginBtn click fired');
      this.startDiscordOAuth('login');
    });

    this.els.discordLinkBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.hasDiscord) {
        this.showDdrawAccountLinkModal();
        return;
      }
      this.startDiscordOAuth('link');
    });

    this.els.guestJoinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    this.els.loginJoinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    this.els.joinBtnLoggedIn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    this.els.authLoggedInJoinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.triggerJoin();
    });

    // Enter key on password fields
    this.els.loginPassword?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleLogin();
      }
    });

    // Username button (logged in state) - logs out to show login menu
    this.els.authUsernameBtn?.addEventListener('click', () => {
      const currentUsername = this.loggedInUsername;
      this.logout();
      // Carry the name into both doors — the user may be swapping accounts or
      // dropping to a guest session, and we don't know which yet.
      if (this.els.loginUsername) {
        this.els.loginUsername.value = currentUsername || '';
      }
      if (this.els.loginAccountUsername) {
        this.els.loginAccountUsername.value = currentUsername || '';
      }
    });

    this.els.registerSubmitBtn?.addEventListener('click', () => this.handleRegister());
    this.els.forgotPasswordBtn?.addEventListener('click', () => this.showPasswordResetRequestPanel());
    this.els.passwordResetClose?.addEventListener('click', () => this.hidePasswordResetPanel());
    this.els.passwordResetSubmitBtn?.addEventListener('click', () => this.handlePasswordResetSubmit());
    [
      this.els.passwordResetIdentifier,
      this.els.passwordResetSecretAnswer,
      this.els.passwordResetNewPassword,
      this.els.passwordResetConfirmPassword
    ].filter(Boolean).forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handlePasswordResetSubmit();
        }
      });
    });

    // Add email modal
    this.els.addEmailSkipBtn?.addEventListener('click', () => this.hideAddEmailModal(true));
    this.els.addEmailSendBtn?.addEventListener('click', () => this.handleSendEmailCode());
    this.els.addEmailVerifyBtn?.addEventListener('click', () => this.handleVerifyEmailCode());
    this.els.addEmailResendBtn?.addEventListener('click', () => this.handleSendEmailCode());
    [this.els.addEmailInput, this.els.addEmailCodeInput].filter(Boolean).forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (this._addEmailStep === 1) this.handleSendEmailCode();
          else this.handleVerifyEmailCode();
        }
      });
    });
    // Close modal on backdrop click (counts as decline)
    document.getElementById('addEmailModalBackdrop')?.addEventListener('click', () => this.hideAddEmailModal(true));
  }

  isJoinActionEnabled() {
    const activeJoinButtons = this.isLoggedIn
      ? [this.els.authLoggedInJoinBtn, this.els.joinBtnLoggedIn]
      : [this.els.loginJoinBtn, this.els.guestJoinBtn];
    return activeJoinButtons.some((button) => button && !button.disabled);
  }

  /**
   * Manually trigger the join process via the form submit event
   */
  triggerJoin() {
    if (!this.isJoinActionEnabled()) return;

    const form = document.getElementById('loginForm');
    if (form) {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }

  async loadDiscordConfig() {
    try {
      const res = await fetch(resolveApiUrl('/api/discord/config'), { cache: 'no-store' });
      if (!res.ok) {
        debug.warn('[Auth] Discord config unavailable:', res.status);
        return;
      }
      const config = await res.json();

      [this.els.discordLoginBtn, this.els.discordLinkBtn].filter(Boolean).forEach((button) => {
        button.style.display = config.oauthEnabled ? '' : 'none';
      });

      [this.els.discordInviteBtn].filter(Boolean).forEach((link) => {
        if (config.inviteUrl) {
          link.href = config.inviteUrl;
          link.style.display = '';
        } else {
          link.style.display = 'none';
        }
      });
    } catch (err) {
      debug.warn('[Auth] Failed to load Discord config:', err);
    } finally {
      document.querySelector('.landingSecondaryActions')?.classList.add('ready');
      document.querySelector('.landingDivider')?.classList.add('ready');
    }
  }

  async startDiscordOAuth(mode = 'login') {
    debug('[DiscordDebug] startDiscordOAuth called, mode=', mode);
    const token = this.getStoredToken();
    if (mode === 'link' && !token) {
      if (this.onError) this.onError('Log in before linking Discord');
      return;
    }

    try {
      this.setLoading(true);
      const res = await fetch(resolveApiUrl('/api/auth/discord/start'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(mode === 'link' && token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ mode })
      });
      const data = await res.json().catch(() => ({}));
      debug('[DiscordDebug] /start response', { ok: res.ok, status: res.status, hasUrl: !!data.url, data });
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Discord login failed to start');
      }

      if (isTauriDesktop()) {
        this._discordPopup?.cleanup?.();
        this._discordPopup = await openDiscordOAuthWindow(data.url, {
          onResult: (resultUrl) => {
            this.setLoading(false);
            this._discordPopup?.cleanup?.();
            this._discordPopup = null;
            this.handleDiscordAuthResultUrl(resultUrl);
          },
          onClosed: () => {
            this._discordPopup?.cleanup?.();
            this._discordPopup = null;
            if (this._loading) {
              this.setLoading(false);
            }
          }
        });
        return;
      }

      const popup = window.open(
        data.url,
        'ddrawDiscordOAuth',
        'popup=yes,width=520,height=720,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes'
      );

      debug('[DiscordDebug] popup opened?', !!popup);

      if (!popup) {
        window.location.href = data.url;
        return;
      }

      // Clear stale debug entries
      try {
        localStorage.removeItem('__discordDebugPopup');
        localStorage.removeItem('__discordDebugPopupPosted');
        localStorage.removeItem('__discordDebugPopupPostError');
        localStorage.removeItem('__discordDebugPopupEntry');
      } catch {}

      this._discordPopup = popup;
      const closePoll = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(closePoll);
        debug('[DiscordDebug] popup closed, _loading=', this._loading);
        try {
          debug('[DiscordDebug] popup ENTRY (handler reached?):', localStorage.getItem('__discordDebugPopupEntry'));
          debug('[DiscordDebug] popup-side info:', localStorage.getItem('__discordDebugPopup'));
          debug('[DiscordDebug] popup posted at:', localStorage.getItem('__discordDebugPopupPosted'));
          debug('[DiscordDebug] popup post error:', localStorage.getItem('__discordDebugPopupPostError'));
          debug('[DiscordDebug] parent origin:', window.location.origin, 'parent href:', window.location.href);
        } catch {}
        if (this._loading) {
          this.setLoading(false);
        }
      }, 500);
    } catch (err) {
      debug('[DiscordDebug] startDiscordOAuth error', err);
      this.setLoading(false);
      if (this.onError) this.onError(err.message);
    }
  }

  handleDiscordPopupMessage(event) {
    if (event?.data?.type === 'ddraw:discord-auth' || event?.data?.type?.startsWith?.('ddraw:')) {
      debug('[DiscordDebug] postMessage received', { origin: event.origin, expectedOrigin: window.location.origin, data: event.data });
    }
    if (event.origin !== window.location.origin) {
      if (event?.data?.type === 'ddraw:discord-auth') {
        debug('[DiscordDebug] postMessage REJECTED on origin mismatch');
      }
      return;
    }
    const payload = event.data;
    if (!payload || payload.type !== 'ddraw:discord-auth') return;

    debug('[DiscordDebug] handleDiscordPopupMessage accepted, payload=', payload);
    this.setLoading(false);
    this.applyDiscordAuthPayload(payload);
  }

  handleDiscordAuthFromUrl() {
    return this.handleDiscordAuthResultUrl(window.location.href, { cleanCurrentUrl: true });
  }

  handleDiscordAuthResultUrl(resultUrl, { cleanCurrentUrl = false } = {}) {
    // DiscordDebug: log entry unconditionally — written from the popup window.
    try {
      localStorage.setItem('__discordDebugPopupEntry', JSON.stringify({
        at: Date.now(),
        resultUrl,
        currentHref: window.location.href,
        origin: window.location.origin,
        hasOpener: !!window.opener,
        cleanCurrentUrl,
      }));
    } catch {}

    let url;
    try {
      url = new URL(resultUrl, window.location.origin);
    } catch {
      return false;
    }

    const params = url.searchParams;
    const status = params.get('discordAuth');
    if (!status) return false;

    if (cleanCurrentUrl) {
      const cleanUrl = `${window.location.origin}${window.location.pathname}${window.location.hash || ''}`;
      window.history.replaceState({}, document.title, cleanUrl);
    }

    const payload = {
      type: 'ddraw:discord-auth',
      status,
      token: params.get('token') || '',
      username: params.get('username') || '',
      mode: params.get('mode') || 'login',
      hasDiscord: params.get('hasDiscord') !== '0',
      needsUsernameSetup: params.get('needsUsernameSetup') === '1',
      suggestedUsername: params.get('suggestedUsername') || '',
      error: params.get('error') || ''
    };

    // DiscordDebug: write what we see to localStorage so the parent can read it
    // after the popup closes (popup console is hidden).
    try {
      localStorage.setItem('__discordDebugPopup', JSON.stringify({
        at: Date.now(),
        cleanCurrentUrl,
        hasOpener: !!window.opener,
        openerIsSelf: window.opener === window,
        origin: window.location.origin,
        status,
        hasToken: !!payload.token,
        hasUsername: !!payload.username,
      }));
    } catch (e) {}

    if (cleanCurrentUrl && window.opener && window.opener !== window) {
      try {
        window.opener.postMessage(payload, window.location.origin);
        localStorage.setItem('__discordDebugPopupPosted', String(Date.now()));
      } catch (e) {
        try { localStorage.setItem('__discordDebugPopupPostError', String(e?.message || e)); } catch {}
      }
      window.close();
      return true;
    }

    this.applyDiscordAuthPayload(payload);
    return true;
  }

  applyDiscordAuthPayload(payload) {
    debug('[DiscordDebug] applyDiscordAuthPayload', payload);
    if (payload.status !== 'success') {
      debug('[DiscordDebug] payload.status !== success, bailing');
      if (this.onError) this.onError(payload.error || 'Discord login failed');
      return;
    }

    const token = payload.token || '';
    const username = payload.username || '';
    const hasDiscord = payload.hasDiscord !== false;
    const needsUsernameSetup = !!payload.needsUsernameSetup;
    const suggestedUsername = payload.suggestedUsername || username;
    if (!token || !username) {
      debug('[DiscordDebug] missing token/username, bailing');
      if (this.onError) this.onError('Discord login did not return an account');
      return;
    }
    debug('[DiscordDebug] all checks passed, applying token + showLoggedInState');

    this.storeToken(token);
    this.storeUsername(username);
    this.setRememberMe(true);
    this.currentAuthSession = {
      token,
      role: 1,
      username,
      globalRole: 1,
      roomRole: 0,
      hasDiscord,
      needsUsernameSetup,
      suggestedUsername
    };
    this.showLoggedInState(username, { hasDiscord, needsUsernameSetup, suggestedUsername });
    this.attemptAutoLogin();
  }

  /**
   * Check if user has stored login credentials
   */
  checkStoredLogin() {
    if (this.getStoredToken()) {
      this.attemptAutoLogin();
    }
  }

  /**
   * Helper to switch between elements with a fade and height animation
   */
  async _transitionTo(toEl, fromEls = []) {
    const duration = 240;
    const wrapper = this.els.authFormWrapper;
    const compactLayout = this.isCompactHeightLayout();
    const visibleFromEls = fromEls.filter((el) => el && el.style.display !== 'none');

    // Bump a per-call token so a rapid re-entry cancels cleanup from the previous run.
    const token = (this._transitionToken || 0) + 1;
    this._transitionToken = token;

    if (!toEl) {
      visibleFromEls.forEach((el) => {
        el.style.display = 'none';
        el.style.opacity = '';
        el.style.transform = '';
        el.style.position = '';
        el.style.left = '';
        el.style.right = '';
        el.style.top = '';
      });
      if (wrapper) wrapper.style.height = '';
      return;
    }

    // Measure starting height before any DOM mutations.
    const oldHeight = wrapper && !compactLayout ? wrapper.offsetHeight : 0;

    // Stage the incoming element invisibly so we can measure its target height
    // without it affecting layout (absolute positioning takes it out of flow).
    toEl.classList.remove('auth-fade-in', 'auth-fade-out');
    toEl.style.display = 'flex';
    toEl.style.opacity = '0';
    toEl.style.transform = 'translateY(6px)';
    toEl.style.position = 'absolute';
    toEl.style.left = '0';
    toEl.style.right = '0';
    toEl.style.top = '0';
    toEl.style.pointerEvents = 'none';

    // Pin the outgoing elements in place via absolute positioning so the wrapper
    // height can tween freely while both panels cross-fade in the same spot.
    visibleFromEls.forEach((el) => {
      el.classList.remove('auth-fade-in', 'auth-fade-out');
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.right = '0';
      el.style.top = '0';
      el.style.pointerEvents = 'none';
    });

    // Force a reflow so the next style changes animate from the staged values.
    if (wrapper) {
      wrapper.style.height = oldHeight ? oldHeight + 'px' : '';
      // eslint-disable-next-line no-unused-expressions
      wrapper.offsetHeight;
    }

    // Measure incoming target height now that it's in the DOM (still invisible).
    const newHeight = (toEl.scrollHeight || toEl.offsetHeight || oldHeight) || 0;

    // Kick off the parallel transitions on the next frame.
    await new Promise((r) => requestAnimationFrame(() => r()));
    if (this._transitionToken !== token) return;

    if (wrapper && !compactLayout && newHeight) {
      wrapper.style.height = newHeight + 'px';
    }

    visibleFromEls.forEach((el) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-6px)';
    });

    toEl.style.opacity = '';
    toEl.style.transform = '';

    await new Promise((r) => setTimeout(r, duration));
    if (this._transitionToken !== token) return;

    // Restore the incoming element to normal flow.
    toEl.style.position = '';
    toEl.style.left = '';
    toEl.style.right = '';
    toEl.style.top = '';
    toEl.style.pointerEvents = '';
    toEl.style.opacity = '';
    toEl.style.transform = '';

    visibleFromEls.forEach((el) => {
      el.style.display = 'none';
      el.style.position = '';
      el.style.left = '';
      el.style.right = '';
      el.style.top = '';
      el.style.pointerEvents = '';
      el.style.opacity = '';
      el.style.transform = '';
    });

    if (wrapper) wrapper.style.height = '';
  }

  /**
   * Keep login and logged-in panels at the same height to avoid UI popping.
   */
  syncAuthStateHeights() {
    const loginForm = document.getElementById('loginForm');
    const wrapper = this.els.authFormWrapper;
    if (!loginForm || !wrapper) return;

    if (this.isCompactHeightLayout()) {
      this.resetAuthLayoutSizing();
      return;
    }
  }

  /**
   * Show the logged-in UI state
   */
  async showLoggedInState(username, {
    hasDiscord = this.hasDiscord,
    needsUsernameSetup = this.needsUsernameSetup,
    suggestedUsername = this.suggestedUsername,
    selectedBadge = this.selectedBadge
  } = {}) {
    const wasLoggedIn = this.isLoggedIn;
    this.clearLandingError();
    this.isLoggedIn = true;
    this.loggedInUsername = username;
    this.hasDiscord = !!hasDiscord;
    this.needsUsernameSetup = !!needsUsernameSetup;
    this.suggestedUsername = suggestedUsername || username;
    this.selectedBadge = selectedBadge || '';

    if (this.els.authUsernameDisplay) this.els.authUsernameDisplay.textContent = username;
    this.renderAuthBadges();
    if (this.els.authUsernameBtn) {
      this.els.authUsernameBtn.classList.toggle('auth-is-discord', this.hasDiscord);
      this.els.authUsernameBtn.title = this.hasDiscord ? 'Logged in with Discord' : '';
    }
    if (this.els.discordLinkBtn) {
      const shouldShowLinkButton = !this.hasDiscord || this.needsUsernameSetup;
      this.els.discordLinkBtn.style.display = shouldShowLinkButton ? '' : 'none';
      this.els.discordLinkBtn.textContent = this.hasDiscord ? 'Link DDraw Account' : 'Link Discord';
      this.els.discordLinkBtn.classList.toggle('authLinkDdrawBtn', this.hasDiscord);
      this.els.discordLinkBtn.classList.toggle('authDiscordBtn', !this.hasDiscord);
      this.els.discordLinkBtn.classList.toggle('secondary', this.hasDiscord);
    }
    this.els.landingAuthPanel?.classList.add('auth-is-logged-in');
    this.syncAuthStateHeights();

    if (!wasLoggedIn) {
      await this._transitionTo(this.els.authLoggedIn, [this.els.authNotLoggedIn, this.els.passwordResetPanel]);
    }

    if (this.onLoggedInStateChange) {
      this.onLoggedInStateChange(true, username);
    }

    this.scrollRoomsIntoViewOnSmallScreens();

    if (this.hasDiscord && this.needsUsernameSetup && !this.isUsernameSetupDismissed()) {
      setTimeout(() => this.showUsernameSetupModal(), 50);
    }
  }

  /**
   * Render the logged-in user's badge next to their name on the landing page.
   */
  renderAuthBadges() {
    if (!this.els.authUserBadges) return;
    renderBadgesInto(
      this.els.authUserBadges,
      badgesForUser({ hasDiscord: this.hasDiscord, selectedBadge: this.selectedBadge })
    );
  }

  /**
   * Show the not-logged-in UI state
   */
  async showNotLoggedInState() {
    this.isLoggedIn = false;
    this.loggedInUsername = null;
    this.hasDiscord = false;
    this.needsUsernameSetup = false;
    this.suggestedUsername = '';
    this.selectedBadge = '';
    this.renderAuthBadges();
    if (this.els.authUsernameBtn) {
      this.els.authUsernameBtn.classList.remove('auth-is-discord');
      this.els.authUsernameBtn.title = '';
    }
    if (this.els.discordLinkBtn) {
      this.els.discordLinkBtn.style.display = '';
      this.els.discordLinkBtn.textContent = 'Link Discord';
      this.els.discordLinkBtn.classList.remove('authLinkDdrawBtn');
      this.els.discordLinkBtn.classList.add('authDiscordBtn');
      this.els.discordLinkBtn.classList.remove('secondary');
    }
    this.els.landingAuthPanel?.classList.remove('auth-is-logged-in');
    this.syncAuthStateHeights();

    await this._transitionTo(this.els.authNotLoggedIn, [this.els.authLoggedIn, this.els.passwordResetPanel]);

    if (this.onLoggedInStateChange) {
      this.onLoggedInStateChange(false, null);
    }
  }

  /**
   * Log out the current user (clear session/token)
   */
  logout() {
    this.clearToken();
    this.clearStoredUsername();
    this.setRememberMe(false);
    this.currentAuthSession = null;
    // Drop any token login still on the wire, and ignore its result if it
    // lands anyway — otherwise it would store the token again and undo this.
    this._autoLoginInFlight = false;
    this._autoLoginToken = null;
    this._autoLoginSent = false;
    this._autoLoginSocket = null;
    this._ignoreAuthSuccess = true;
    this.setAuthPending(false);
    // The server may still be holding this tab's account session for a
    // resume; a fresh key makes the next join start a new guest session.
    this.wsClient?.rotateResumeKey?.();
    void this.showNotLoggedInState();
  }

  async handleLogin() {
    if (this._loading) return;

    if (!this.wsClient?.connected) {
      if (this.onError) this.onError('Not currently connected');
      return;
    }

    // The Sign in pane has its own username field; #loginUsername belongs to
    // the Guest pane and is empty whenever the user is actually signing in.
    const username = (this.els.loginAccountUsername || this.els.loginUsername)?.value.trim();
    const password = this.els.loginPassword?.value;

    if (!username || !password) {
      if (this.onError) this.onError('Please enter username and password');
      return;
    }

    // Store username for display after login success
    this._pendingUsername = username;
    this._ignoreAuthSuccess = false;

    this.setLoading(true);
    await this.wsClient.sendAuthLogin(username, password);
  }

  /**
   * Get the username to join with (used by App.handleJoin)
   */
  getJoinUsername() {
    if (this.isLoggedIn && this.loggedInUsername) {
      return this.loggedInUsername;
    }
    return this.els.loginUsername?.value.trim() || null;
  }

  /**
   * Open the Register tab, carrying over whatever was typed on the Sign in tab.
   */
  showRegisterPanel() {
    const username = this.els.loginAccountUsername?.value.trim() || '';
    const password = this.els.loginPassword?.value || '';

    // Pre-fill username/password from the sign-in form
    if (this.els.registerUsername) {
      this.els.registerUsername.value = username;
    }
    if (this.els.registerPassword) {
      this.els.registerPassword.value = password;
    }
    // Clear optional fields
    if (this.els.registerEmail) this.els.registerEmail.value = '';
    if (this.els.registerSecretQuestion) this.els.registerSecretQuestion.value = '';
    if (this.els.registerSecretAnswer) this.els.registerSecretAnswer.value = '';

    this.setActiveAuthTab('register');
  }

  /**
   * Leave the Register tab (e.g. after a successful sign-up).
   */
  hideRegisterPanel() {
    this.setActiveAuthTab('guest');
  }

  setPasswordResetMessage(message, kind = 'neutral') {
    if (!this.els.passwordResetMessage) return;
    this.els.passwordResetMessage.textContent = message || '';
    this.els.passwordResetMessage.dataset.kind = kind;
  }

  setPasswordResetMode(mode) {
    const completeMode = mode === 'complete';
    this._passwordResetMode = mode;
    if (this.els.passwordResetTitle) {
      this.els.passwordResetTitle.textContent = completeMode ? 'Choose New Password' : 'Reset Password';
    }
    if (this.els.passwordResetRequestFields) {
      this.els.passwordResetRequestFields.style.display = completeMode ? 'none' : '';
    }
    if (this.els.passwordResetCompleteFields) {
      this.els.passwordResetCompleteFields.style.display = completeMode ? '' : 'none';
    }
    if (this.els.passwordResetSubmitBtn) {
      const label = completeMode ? 'Change Password' : 'Send Link';
      if (this._loading) this.els.passwordResetSubmitBtn._oldText = label;
      else this.els.passwordResetSubmitBtn.textContent = label;
    }
  }

  openPasswordResetFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('resetToken');
    if (!token) return false;

    this._passwordResetToken = token;
    void this.showPasswordResetCompletePanel();
    params.delete('resetToken');
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
    return true;
  }

  async showPasswordResetRequestPanel() {
    this.clearLandingError();
    if (this.els.passwordResetIdentifier) this.els.passwordResetIdentifier.value = '';
    this._passwordResetToken = null;
    this.setPasswordResetMode('request');
    this.setPasswordResetMessage('');

    const divider = document.querySelector('.landingDivider');
    const secondaryActions = document.querySelector('.landingSecondaryActions');
    if (divider) divider.style.display = 'none';
    if (secondaryActions) secondaryActions.style.display = 'none';

    await this._transitionTo(this.els.passwordResetPanel, [this.els.authNotLoggedIn, this.els.authLoggedIn]);
  }

  async showPasswordResetCompletePanel() {
    this.clearLandingError();
    if (this.els.passwordResetNewPassword) this.els.passwordResetNewPassword.value = '';
    if (this.els.passwordResetConfirmPassword) this.els.passwordResetConfirmPassword.value = '';
    this.setPasswordResetMode('complete');
    this.setPasswordResetMessage('Enter a new password for this reset link.');

    const divider = document.querySelector('.landingDivider');
    const secondaryActions = document.querySelector('.landingSecondaryActions');
    if (divider) divider.style.display = 'none';
    if (secondaryActions) secondaryActions.style.display = 'none';

    await this._transitionTo(this.els.passwordResetPanel, [this.els.authNotLoggedIn, this.els.authLoggedIn]);
  }

  async hidePasswordResetPanel() {
    this.clearLandingError();
    const divider = document.querySelector('.landingDivider');
    const secondaryActions = document.querySelector('.landingSecondaryActions');
    if (divider) divider.style.display = '';
    if (secondaryActions) secondaryActions.style.display = '';
    this._passwordResetToken = null;
    await this._transitionTo(this.els.authNotLoggedIn, [this.els.passwordResetPanel]);
  }

  async handlePasswordResetSubmit() {
    if (this._loading) return;

    if (this._passwordResetMode === 'complete') {
      await this.completePasswordReset();
    } else {
      await this.requestPasswordReset();
    }
  }

  async requestPasswordReset() {
    const identifier = this.els.passwordResetIdentifier?.value.trim();
    if (!identifier || !identifier.includes('@')) {
      this.setPasswordResetMessage('Enter your email address.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const res = await fetch(resolveApiUrl('/api/auth/password-reset/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Password reset failed');
      }

      if (data.requiresSecretAnswer) {
        if (this.els.passwordResetSecretWrap) this.els.passwordResetSecretWrap.style.display = '';
        if (this.els.passwordResetSecretQuestion) this.els.passwordResetSecretQuestion.textContent = data.secretQuestion || '';
        if (this.els.passwordResetSubmitBtn) {
          if (this._loading) this.els.passwordResetSubmitBtn._oldText = 'Verify Answer';
          else this.els.passwordResetSubmitBtn.textContent = 'Verify Answer';
        }
        this.setPasswordResetMessage('Answer your secret question to create a reset link.');
        return;
      }

      if (data.resetLink) {
        const url = new URL(data.resetLink, window.location.origin);
        this._passwordResetToken = url.searchParams.get('resetToken');
        await this.showPasswordResetCompletePanel();
        return;
      }

      this.setPasswordResetMessage(data.message || 'If that account can be reset, check your email.', 'success');
    } catch (err) {
      this.setPasswordResetMessage(err.message || 'Password reset failed', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  async completePasswordReset() {
    const password = this.els.passwordResetNewPassword?.value || '';
    const confirmPassword = this.els.passwordResetConfirmPassword?.value || '';
    if (!this._passwordResetToken) {
      this.setPasswordResetMessage('Reset link is missing. Request a new one.', 'error');
      return;
    }
    if (password.length < 6) {
      this.setPasswordResetMessage('Password must be at least 6 characters.', 'error');
      return;
    }
    if (password !== confirmPassword) {
      this.setPasswordResetMessage('Passwords do not match.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const res = await fetch(resolveApiUrl('/api/auth/password-reset/complete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this._passwordResetToken, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Password reset failed');
      }

      this.setPasswordResetMessage(data.message || 'Password updated. You can log in now.', 'success');
      if (this.els.passwordResetNewPassword) this.els.passwordResetNewPassword.value = '';
      if (this.els.passwordResetConfirmPassword) this.els.passwordResetConfirmPassword.value = '';
      this._passwordResetToken = null;
      setTimeout(() => this.hidePasswordResetPanel(), 1200);
    } catch (err) {
      this.setPasswordResetMessage(err.message || 'Password reset failed', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  showAddEmailModal() {
    this._addEmailStep = 1;
    if (this.els.addEmailInput) this.els.addEmailInput.value = '';
    if (this.els.addEmailCodeInput) this.els.addEmailCodeInput.value = '';
    if (this.els.addEmailMessage) this.els.addEmailMessage.textContent = '';
    if (this.els.addEmailCodeMessage) this.els.addEmailCodeMessage.textContent = '';
    if (this.els.addEmailStep1) this.els.addEmailStep1.style.display = '';
    if (this.els.addEmailStep2) this.els.addEmailStep2.style.display = 'none';

    const backdrop = document.getElementById('addEmailModalBackdrop');
    const modal = document.getElementById('addEmailModal');
    const landingPage = document.getElementById('landingPage');
    if (backdrop) backdrop.style.display = 'block';
    if (modal) modal.style.display = 'block';
    if (landingPage) landingPage.classList.add('blurred');
    if (this.els.addEmailInput) this.els.addEmailInput.focus();
  }

  hideAddEmailModal(declinePrompt = false) {
    const backdrop = document.getElementById('addEmailModalBackdrop');
    const modal = document.getElementById('addEmailModal');
    const landingPage = document.getElementById('landingPage');
    if (backdrop) backdrop.style.display = 'none';
    if (modal) modal.style.display = 'none';
    if (landingPage) landingPage.classList.remove('blurred');

    if (declinePrompt) {
      const token = this.getStoredToken();
      if (token) {
        fetch(resolveApiUrl('/api/auth/email/decline'), {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }).catch(() => {});
      }
    }
  }

  setAddEmailMessage(message, kind = 'neutral') {
    if (!this.els.addEmailMessage) return;
    this.els.addEmailMessage.textContent = message || '';
    this.els.addEmailMessage.dataset.kind = kind;
  }

  setAddEmailCodeMessage(message, kind = 'neutral') {
    if (!this.els.addEmailCodeMessage) return;
    this.els.addEmailCodeMessage.textContent = message || '';
    this.els.addEmailCodeMessage.dataset.kind = kind;
  }

  async handleSendEmailCode() {
    if (this._loading) return;

    const email = this.els.addEmailInput?.value.trim();
    if (!email || !email.includes('@')) {
      this.setAddEmailMessage('Please enter a valid email address.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const token = this.getStoredToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const res = await fetch(resolveApiUrl('/api/auth/email/set'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to send verification code');
      }

      this._addEmailStep = 2;
      this._addEmailForVerification = email;
      if (this.els.addEmailTarget) this.els.addEmailTarget.textContent = email;
      if (this.els.addEmailStep1) this.els.addEmailStep1.style.display = 'none';
      if (this.els.addEmailStep2) this.els.addEmailStep2.style.display = '';
      if (this.els.addEmailCodeInput) this.els.addEmailCodeInput.value = '';
      this.setAddEmailCodeMessage('');
      if (this.els.addEmailCodeInput) this.els.addEmailCodeInput.focus();
    } catch (err) {
      this.setAddEmailMessage(err.message || 'Failed to send verification code', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  async handleVerifyEmailCode() {
    if (this._loading) return;

    const code = this.els.addEmailCodeInput?.value.trim();
    if (!code || code.length !== 6 || !/^\d+$/.test(code)) {
      this.setAddEmailCodeMessage('Please enter a valid 6-digit code.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const token = this.getStoredToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const res = await fetch(resolveApiUrl('/api/auth/email/verify'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to verify email');
      }

      this.setAddEmailCodeMessage('Email verified successfully!', 'success');
      setTimeout(() => this.hideAddEmailModal(), 1200);
    } catch (err) {
      this.setAddEmailCodeMessage(err.message || 'Failed to verify email', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  ensureUsernameSetupModal() {
    if (document.getElementById('usernameSetupModal')) {
      this.els.usernameSetupBackdrop = document.getElementById('usernameSetupModalBackdrop');
      this.els.usernameSetupModal = document.getElementById('usernameSetupModal');
      this.els.usernameSetupInput = document.getElementById('usernameSetupInput');
      this.els.usernameSetupMessage = document.getElementById('usernameSetupMessage');
      this.els.usernameSetupSaveBtn = document.getElementById('usernameSetupSaveBtn');
      this.els.usernameSetupLinkBtn = document.getElementById('usernameSetupLinkBtn');
      this.els.usernameSetupDismissBtn = document.getElementById('usernameSetupDismissBtn');
      this.els.usernameSetupCloseBtn = document.getElementById('usernameSetupCloseBtn');
      this.els.usernameSetupTitle = document.getElementById('usernameSetupTitle');
      this.els.usernameSetupText = document.getElementById('usernameSetupText');
      this.els.usernameSetupFields = document.getElementById('usernameSetupFields');
      this.els.ddrawLinkFields = document.getElementById('ddrawLinkFields');
      this.els.ddrawLinkUsername = document.getElementById('ddrawLinkUsername');
      this.els.ddrawLinkPassword = document.getElementById('ddrawLinkPassword');
      this.els.ddrawLinkSubmitBtn = document.getElementById('ddrawLinkSubmitBtn');
      this.els.ddrawLinkBackBtn = document.getElementById('ddrawLinkBackBtn');
      return;
    }

    const backdrop = document.createElement('div');
    backdrop.id = 'usernameSetupModalBackdrop';
    backdrop.className = 'authModalBackdrop';
    backdrop.style.display = 'none';

    const modal = document.createElement('div');
    modal.id = 'usernameSetupModal';
    modal.className = 'authSetupModal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <button type="button" class="authSetupClose" id="usernameSetupCloseBtn" aria-label="Close">&times;</button>
      <h3 id="usernameSetupTitle">Choose DDraw Username</h3>
      <p class="authSetupText" id="usernameSetupText">Pick the name people will see in DDraw.</p>
      <div id="usernameSetupFields">
        <input autocomplete="username" class="authInput" id="usernameSetupInput" name="ddraw-username" placeholder="Username">
      </div>
      <div id="ddrawLinkFields" style="display: none;">
        <input autocomplete="username" class="authInput" id="ddrawLinkUsername" name="existing-ddraw-username" placeholder="DDraw username">
        <input autocomplete="current-password" class="authInput" id="ddrawLinkPassword" name="existing-ddraw-password" placeholder="DDraw password" type="password">
      </div>
      <p class="authResetMessage" id="usernameSetupMessage"></p>
      <div class="authSetupActions">
        <button type="button" class="btn primary large" id="usernameSetupSaveBtn">Save Username</button>
        <button type="button" class="btn secondary large" id="usernameSetupLinkBtn">Link DDraw Account</button>
        <button type="button" class="btn secondary large" id="usernameSetupDismissBtn">No Thanks</button>
        <button type="button" class="btn primary large" id="ddrawLinkSubmitBtn" style="display: none;">Link Account</button>
        <button type="button" class="btn secondary large" id="ddrawLinkBackBtn" style="display: none;">Change Username</button>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    this.els.usernameSetupBackdrop = backdrop;
    this.els.usernameSetupModal = modal;
    this.els.usernameSetupInput = modal.querySelector('#usernameSetupInput');
    this.els.usernameSetupMessage = modal.querySelector('#usernameSetupMessage');
    this.els.usernameSetupSaveBtn = modal.querySelector('#usernameSetupSaveBtn');
    this.els.usernameSetupLinkBtn = modal.querySelector('#usernameSetupLinkBtn');
    this.els.usernameSetupDismissBtn = modal.querySelector('#usernameSetupDismissBtn');
    this.els.usernameSetupCloseBtn = modal.querySelector('#usernameSetupCloseBtn');
    this.els.usernameSetupTitle = modal.querySelector('#usernameSetupTitle');
    this.els.usernameSetupText = modal.querySelector('#usernameSetupText');
    this.els.usernameSetupFields = modal.querySelector('#usernameSetupFields');
    this.els.ddrawLinkFields = modal.querySelector('#ddrawLinkFields');
    this.els.ddrawLinkUsername = modal.querySelector('#ddrawLinkUsername');
    this.els.ddrawLinkPassword = modal.querySelector('#ddrawLinkPassword');
    this.els.ddrawLinkSubmitBtn = modal.querySelector('#ddrawLinkSubmitBtn');
    this.els.ddrawLinkBackBtn = modal.querySelector('#ddrawLinkBackBtn');

    this.els.usernameSetupCloseBtn?.addEventListener('click', () => this.dismissUsernameSetupModal());
    this.els.usernameSetupBackdrop?.addEventListener('click', () => this.dismissUsernameSetupModal());
    this.els.usernameSetupSaveBtn?.addEventListener('click', () => this.handleUsernameSetupSubmit());
    this.els.usernameSetupDismissBtn?.addEventListener('click', () => this.dismissUsernameSetupModal());
    this.els.usernameSetupInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.handleUsernameSetupSubmit();
      }
    });
    this.els.usernameSetupLinkBtn?.addEventListener('click', () => this.showDdrawAccountLinkModal());
    this.els.ddrawLinkSubmitBtn?.addEventListener('click', () => this.handleDdrawAccountLinkSubmit());
    [this.els.ddrawLinkUsername, this.els.ddrawLinkPassword].filter(Boolean).forEach((el) => {
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.handleDdrawAccountLinkSubmit();
        }
      });
    });
    this.els.ddrawLinkBackBtn?.addEventListener('click', () => this.showUsernameSetupModal({ force: true }));
  }

  showUsernameSetupModal({ force = false } = {}) {
    this.ensureUsernameSetupModal();
    if (!force && !this.needsUsernameSetup) return;
    if (!force && this.isUsernameSetupDismissed()) return;

    this.setUsernameSetupMode('username', { initialSetup: !force && this.needsUsernameSetup });
    if (this.els.usernameSetupInput) {
      this.els.usernameSetupInput.value = this.suggestedUsername || this.loggedInUsername || '';
    }
    this.setUsernameSetupMessage('');
    if (this.els.usernameSetupBackdrop) this.els.usernameSetupBackdrop.style.display = 'block';
    if (this.els.usernameSetupModal) this.els.usernameSetupModal.style.display = 'block';
    this.els.usernameSetupInput?.focus();
    this.els.usernameSetupInput?.select();
  }

  showDdrawAccountLinkModal() {
    this.ensureUsernameSetupModal();
    this.setUsernameSetupMode('link');
    this.setUsernameSetupMessage('');
    if (this.els.usernameSetupBackdrop) this.els.usernameSetupBackdrop.style.display = 'block';
    if (this.els.usernameSetupModal) this.els.usernameSetupModal.style.display = 'block';
    if (this.els.ddrawLinkUsername) this.els.ddrawLinkUsername.value = '';
    if (this.els.ddrawLinkPassword) this.els.ddrawLinkPassword.value = '';
    this.els.ddrawLinkUsername?.focus();
  }

  setUsernameSetupMode(mode, { initialSetup = false } = {}) {
    const isLinkMode = mode === 'link';
    if (this.els.usernameSetupTitle) {
      this.els.usernameSetupTitle.textContent = isLinkMode
        ? 'Link DDraw Account'
        : initialSetup
          ? 'Choose DDraw Username'
          : 'Change Username';
    }
    if (this.els.usernameSetupText) {
      this.els.usernameSetupText.textContent = isLinkMode
        ? 'Log in to your existing DDraw account to connect it with Discord.'
        : initialSetup
          ? 'Pick the name people will see in DDraw.'
          : 'You can only change your username once every 3 months.';
    }
    if (this.els.usernameSetupFields) this.els.usernameSetupFields.style.display = isLinkMode ? 'none' : '';
    if (this.els.ddrawLinkFields) this.els.ddrawLinkFields.style.display = isLinkMode ? '' : 'none';
    if (this.els.usernameSetupSaveBtn) this.els.usernameSetupSaveBtn.style.display = isLinkMode ? 'none' : '';
    if (this.els.usernameSetupLinkBtn) this.els.usernameSetupLinkBtn.style.display = (isLinkMode || !initialSetup) ? 'none' : '';
    if (this.els.usernameSetupDismissBtn) this.els.usernameSetupDismissBtn.style.display = isLinkMode || !initialSetup ? 'none' : '';
    if (this.els.ddrawLinkSubmitBtn) this.els.ddrawLinkSubmitBtn.style.display = isLinkMode ? '' : 'none';
    if (this.els.ddrawLinkBackBtn) this.els.ddrawLinkBackBtn.style.display = isLinkMode ? '' : 'none';
    if (this.els.usernameSetupSaveBtn) {
      this.els.usernameSetupSaveBtn.textContent = initialSetup ? 'Save Username' : 'Change Username';
    }
  }

  hideUsernameSetupModal() {
    if (this.els.usernameSetupBackdrop) this.els.usernameSetupBackdrop.style.display = 'none';
    if (this.els.usernameSetupModal) this.els.usernameSetupModal.style.display = 'none';
  }

  dismissUsernameSetupModal() {
    if (this.needsUsernameSetup) {
      this.setUsernameSetupDismissed();
    }
    this.hideUsernameSetupModal();
  }

  getUsernameSetupDismissedKey() {
    return `${USERNAME_SETUP_DISMISSED_PREFIX}${this.loggedInUsername || 'unknown'}`;
  }

  isUsernameSetupDismissed() {
    try {
      return localStorage.getItem(this.getUsernameSetupDismissedKey()) === '1';
    } catch {
      return false;
    }
  }

  setUsernameSetupDismissed() {
    try {
      localStorage.setItem(this.getUsernameSetupDismissedKey(), '1');
    } catch {
      // Ignore storage failures; the close button should still close the modal.
    }
  }

  clearUsernameSetupDismissed(username = this.loggedInUsername) {
    try {
      localStorage.removeItem(`${USERNAME_SETUP_DISMISSED_PREFIX}${username || 'unknown'}`);
    } catch {
      // Ignore storage failures.
    }
  }

  setUsernameSetupMessage(message, kind = 'neutral') {
    if (!this.els.usernameSetupMessage) return;
    this.els.usernameSetupMessage.textContent = message || '';
    this.els.usernameSetupMessage.dataset.kind = kind;
  }

  async handleUsernameSetupSubmit() {
    if (this._loading) return;

    const username = this.els.usernameSetupInput?.value.trim() || '';
    if (!username) {
      this.setUsernameSetupMessage('Enter a username.', 'error');
      return;
    }

    const token = this.getStoredToken();
    if (!token) {
      this.setUsernameSetupMessage('Not authenticated.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const res = await fetch(resolveApiUrl('/api/auth/username'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ username })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Username update failed');
      }

      this.storeToken(data.token);
      this.storeUsername(data.username);
      this.needsUsernameSetup = false;
      this.suggestedUsername = data.username;
      this.clearUsernameSetupDismissed(this.loggedInUsername);
      this.currentAuthSession = {
        ...(this.currentAuthSession || {}),
        token: data.token,
        username: data.username,
        role: data.role ?? this.currentAuthSession?.role ?? 1,
        hasDiscord: !!data.hasDiscord,
        needsUsernameSetup: false,
      };
      await this.showLoggedInState(data.username, { hasDiscord: !!data.hasDiscord, needsUsernameSetup: false });
      this.hideUsernameSetupModal();
      this.attemptAutoLogin();
    } catch (err) {
      this.setUsernameSetupMessage(err.message || 'Username update failed', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  async handleDdrawAccountLinkSubmit() {
    if (this._loading) return;

    const username = this.els.ddrawLinkUsername?.value.trim() || '';
    const password = this.els.ddrawLinkPassword?.value || '';
    if (!username || !password) {
      this.setUsernameSetupMessage('Enter your DDraw username and password.', 'error');
      return;
    }

    const token = this.getStoredToken();
    if (!token) {
      this.setUsernameSetupMessage('Not authenticated.', 'error');
      return;
    }

    this.setLoading(true);
    try {
      const res = await fetch(resolveApiUrl('/api/auth/discord/link-ddraw'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Account link failed');
      }

      this.storeToken(data.token);
      this.storeUsername(data.username);
      this.needsUsernameSetup = false;
      this.suggestedUsername = data.username;
      this.clearUsernameSetupDismissed(this.loggedInUsername);
      this.currentAuthSession = {
        ...(this.currentAuthSession || {}),
        token: data.token,
        username: data.username,
        role: data.role ?? this.currentAuthSession?.role ?? 1,
        hasDiscord: true,
        needsUsernameSetup: false,
      };
      await this.showLoggedInState(data.username, { hasDiscord: true, needsUsernameSetup: false });
      this.hideUsernameSetupModal();
      this.attemptAutoLogin();
    } catch (err) {
      this.setUsernameSetupMessage(err.message || 'Account link failed', 'error');
    } finally {
      this.setLoading(false);
    }
  }

  async handleRegister() {
    if (this._loading) return;

    const username = this.els.registerUsername?.value.trim();
    const password = this.els.registerPassword?.value;
    const email = this.els.registerEmail?.value.trim() || '';
    const secretQuestion = this.els.registerSecretQuestion?.value.trim() || '';
    const secretAnswer = this.els.registerSecretAnswer?.value.trim() || '';

    if (!username || !password) {
      if (this.onError) this.onError('Username and password are required');
      return;
    }

    if (secretQuestion && !secretAnswer) {
      if (this.onError) this.onError('Please provide a secret answer for your question');
      return;
    }

    this._pendingUsername = username;
    this._pendingRegister = true;
    this._ignoreAuthSuccess = false;
    this.setLoading(true);
    await this.wsClient.sendAuthRegister(username, password, { email, secretQuestion, secretAnswer });
  }

  attemptAutoLogin() {
    const token = this.getStoredToken();
    if (!token) return false;

    this._ignoreAuthSuccess = false;
    this.setAuthPending(true);

    if (this._autoLoginInFlight && this._autoLoginToken === token) {
      this.sendPendingAutoLogin();
      return true;
    }

    this._autoLoginInFlight = true;
    this._autoLoginToken = token;
    this._autoLoginSent = false;
    this._autoLoginSocket = null;

    // Send token if we have one — covers room switches within a session,
    // "remember me" across page reloads, and page refreshes with a stored token.
    // Gate on sessionIndex (set when the server's CONNECT reply arrives) rather
    // than `connected`: the socket flips `connected=true` before the initial
    // CONNECT message is actually sent, so sending AUTH_LOGIN on `connected`
    // alone can race the CONNECT and arrive at the server with no room/session.
    this.sendPendingAutoLogin();
    return true;
  }

  sendPendingAutoLogin() {
    const token = this._autoLoginToken;
    const currentSocket = this.wsClient?.socket || null;
    if (!this._autoLoginInFlight || !token) return false;
    if (this._autoLoginSent && this._autoLoginSocket === currentSocket) return false;
    if (!this.wsClient?.connected || this.wsClient?.sessionIndex == null) return false;

    this._autoLoginSent = true;
    this._autoLoginSocket = currentSocket;
    void this.wsClient.sendAuthTokenLogin(token);

    if (this._authPendingTimeout) clearTimeout(this._authPendingTimeout);
    this._authPendingTimeout = setTimeout(() => {
      if (!this._autoLoginInFlight || this._autoLoginToken !== token) return;
      this._autoLoginInFlight = false;
      this._autoLoginToken = null;
      this._autoLoginSent = false;
      this._autoLoginSocket = null;
      this.setAuthPending(false);
      if (this.onError) this.onError('Account login is taking longer than expected. You can still join or try again.');
    }, 10000);
    return true;
  }

  handleAuthResult(data) {
    this.setLoading(false);
    this._autoLoginInFlight = false;
    this._autoLoginToken = null;
    this._autoLoginSent = false;
    this._autoLoginSocket = null;
    if (this._authPendingTimeout) {
      clearTimeout(this._authPendingTimeout);
      this._authPendingTimeout = null;
    }
    this.setAuthPending(false);

    if (data.success && this._ignoreAuthSuccess) {
      // A login that was already in flight when the user logged out.
      this._pendingUsername = null;
      this._pendingRegister = false;
      return;
    }

    if (data.success) {
      const username = data.username || this._pendingUsername;
      this._pendingUsername = null;

      if (data.token) {
        this.storeToken(data.token);
        // Store username for future display
        if (username) {
          this.storeUsername(username);
        }
        // Store remember me preference
        if (this.els.rememberMe?.checked) {
          this.setRememberMe(true);
        }
      }

      // Hide register panel if it was open
      if (this._pendingRegister) {
        this._pendingRegister = false;
        this.hideRegisterPanel();
      }

      // Show logged-in state on landing page
      if (username) {
        this.currentAuthSession = {
          token: data.token || this.getStoredToken() || '',
          role: data.role || 0,
          username,
          globalRole: data.globalRole ?? data.role ?? 0,
          roomRole: data.roomRole || 0,
          hasDiscord: !!data.hasDiscord,
          needsUsernameSetup: !!data.needsUsernameSetup,
          suggestedUsername: data.suggestedUsername || '',
          selectedBadge: data.selectedBadge || '',
          isSupporter: !!data.isSupporter
        };
        this.showLoggedInState(username, {
          hasDiscord: !!data.hasDiscord,
          needsUsernameSetup: !!data.needsUsernameSetup,
          suggestedUsername: data.suggestedUsername || username,
          selectedBadge: data.selectedBadge || ''
        });
      }

      // Prompt to add email if missing and user hasn't declined
      if (!data.hasDiscord && !data.hasEmail && !data.emailPromptDeclined) {
        setTimeout(() => this.showAddEmailModal(), 100);
      }

      if (this.onSuccess) {
        this.onSuccess(data.token, data.role, username, data.globalRole, data.roomRole, !!data.hasDiscord);
      }
    } else {
      this._pendingUsername = null;
      this._pendingRegister = false;
      this.currentAuthSession = null;

      const errorMessage = data.error || 'Authentication failed';
      const shouldClearStoredToken = this.getStoredToken() && TOKEN_INVALID_ERRORS.has(errorMessage);

      // Only clear saved auth when the token itself is actually invalid.
      if (shouldClearStoredToken) {
        this.clearToken();
        this.clearStoredUsername();
        this.setRememberMe(false);
        this.showNotLoggedInState();
      }

      if (this.onError) {
        this.onError(errorMessage);
      }
    }
  }

  replayAuthSession() {
    if (!this.currentAuthSession || !this.onSuccess) return false;
    const { token, role, username, globalRole, roomRole, hasDiscord } = this.currentAuthSession;
    this.onSuccess(token, role, username, globalRole, roomRole, !!hasDiscord);
    return true;
  }

  setLoading(loading) {
    this._loading = loading;
    const btns = [this.els.loginBtn, this.els.registerSubmitBtn, this.els.passwordResetSubmitBtn, this.els.usernameSetupSaveBtn, this.els.ddrawLinkSubmitBtn];

    if (loading) {
      btns.forEach(btn => {
        if (btn) {
          btn._oldText = btn.textContent;
          btn.textContent = '...';
          btn.classList.add('disabled');
        }
      });
      // Safety timeout — reset after 10s if server never responds
      this._loadingTimeout = setTimeout(() => {
        this.setLoading(false);
        if (this.onError) this.onError('No response from server');
      }, 10000);
    } else {
      if (this._loadingTimeout) { clearTimeout(this._loadingTimeout); this._loadingTimeout = null; }
      btns.forEach(btn => {
        if (btn) {
          btn.textContent = btn._oldText || this.getDefaultButtonText(btn);
          btn._oldText = null;
          btn.classList.remove('disabled');
        }
      });
    }
  }

  getDefaultButtonText(btn) {
    if (btn === this.els.loginBtn) return 'Login';
    if (btn === this.els.registerSubmitBtn) return 'Create Account';
    if (btn === this.els.passwordResetSubmitBtn) {
      return this._passwordResetMode === 'complete' ? 'Change Password' : 'Send Link';
    }
    if (btn === this.els.usernameSetupSaveBtn) return 'Save Username';
    if (btn === this.els.ddrawLinkSubmitBtn) return 'Link Account';
    return '';
  }

  setAuthPending(pending) {
    if (!pending && this._authPendingTimeout) {
      clearTimeout(this._authPendingTimeout);
      this._authPendingTimeout = null;
    }
    applyAuthPendingUI(pending);
    // Disable room list join buttons during auth pending
    const roomListJoinBtns = [this.els.loginJoinBtn, this.els.joinBtnLoggedIn];
    roomListJoinBtns.forEach(btn => {
      if (btn) btn.disabled = pending;
    });
  }

  scrollRoomsIntoViewOnSmallScreens() {
    if (!window.matchMedia('(max-width: 768px), (max-height: 720px)').matches) return;

    const roomListSection = document.querySelector('.roomListSection');
    if (!roomListSection) return;

    window.setTimeout(() => {
      roomListSection.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }, 260);
  }

  // Token storage
  storeToken(token) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch { /* ignore */ }
  }

  getStoredToken() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch { /* ignore */ }
  }

  // Remember me preference
  getRememberMe() {
    try {
      return localStorage.getItem(REMEMBER_ME_KEY) === 'true';
    } catch {
      return false;
    }
  }

  setRememberMe(value) {
    try {
      localStorage.setItem(REMEMBER_ME_KEY, value ? 'true' : 'false');
    } catch { /* ignore */ }
  }

  // Username storage (for displaying logged-in state)
  storeUsername(username) {
    try {
      localStorage.setItem(USERNAME_KEY, username);
    } catch { /* ignore */ }
  }

  getStoredUsername() {
    try {
      return localStorage.getItem(USERNAME_KEY);
    } catch {
      return null;
    }
  }

  clearStoredUsername() {
    try {
      localStorage.removeItem(USERNAME_KEY);
    } catch { /* ignore */ }
  }

  clearLandingError() {
    window.app?.landingPage?.clearError?.();
    window.landingPage?.clearError?.();
    const errorEl = document.getElementById('landingError');
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }
  }
}
