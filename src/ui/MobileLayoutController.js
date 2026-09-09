/**
 * @fileoverview Mobile layout behaviour: keeps the tool options panel as a
 * tap-to-open overlay on mobile, and owns the desktop narrow-window
 * auto-collapse that previously lived inline in App.handleResize().
 */
import { isMobile } from '../platform/mobile.js';

export class MobileLayoutController {
  constructor(app) {
    this.app = app;
    this._wasNarrow = undefined;
    this._pressWasSelected = false;
  }

  /**
   * Called once after App.setupEventListeners(). No-op on desktop.
   */
  init() {
    if (!isMobile()) return;
    const ui = this.app.ui;

    this.relocateTopbarForMobile();

    // #toolOptions renders open by default (shared desktop markup). App.init()
    // runs in the background while the landing page is still covering the
    // board, often seconds before the user actually joins a room, so collapse
    // it immediately here rather than on a timer - there's nothing to animate
    // yet since it's hidden behind the landing page regardless. The visible
    // reveal-then-collapse intro happens later, in playToolOptionsIntro(),
    // once the board is actually shown to the user.
    ui.setSidebarCollapsed(true);

    const tools = document.querySelector('#sideMenu .tools');
    if (tools) {
      // Whether the tapped tool was already selected must be read before the
      // button's own click handler selects it.
      tools.addEventListener('pointerdown', (event) => {
        const btn = event.target.closest('.tool.btn');
        this._pressWasSelected = !!btn?.classList.contains('selected');
      }, true);

      tools.addEventListener('click', (event) => {
        const btn = event.target.closest('.tool.btn');
        if (!btn) return;
        if (btn.classList.contains('sidebarToggleBtn') || btn.classList.contains('sidebarUtilityBtn')) return;
        // Re-tapping the active tool toggles its options overlay; switching
        // tools leaves the overlay as-is so sketching stays uninterrupted.
        if (this._pressWasSelected) {
          ui.toggleSidebar();
        }
      });
    }

    // Any interaction with the board area dismisses the overlay.
    document.getElementById('boardContainer')?.addEventListener('pointerdown', () => {
      if (!ui.elements.toolOptions?.classList.contains('collapsed')) {
        ui.setSidebarCollapsed(true);
      }
    }, true);
  }

  /**
   * Call once the board actually becomes visible to the user (landing page
   * hidden - both the room-join and offline-mode paths). Briefly shows the
   * tool options panel, then collapses it with its existing transition and
   * pulses the toggle button, so newly-arrived users see where their tool
   * options live instead of the panel just being silently gone.
   */
  playToolOptionsIntro() {
    if (!isMobile()) return;
    const ui = this.app.ui;
    ui.setSidebarCollapsed(false);
    setTimeout(() => {
      ui.setSidebarCollapsed(true);
      this._highlightSidebarToggle();
    }, 450);
  }

  /** Brief highlight pulse on the sidebar toggle button - see init(). */
  _highlightSidebarToggle() {
    const btn = this.app.ui.elements.sidebarToggleBtn;
    if (!btn) return;
    btn.classList.remove('toggle-btn-appear');
    void btn.offsetWidth; // restart the animation if it's still running
    btn.classList.add('toggle-btn-appear');
    btn.addEventListener('animationend', () => btn.classList.remove('toggle-btn-appear'), { once: true });
  }

  /**
   * Moves secondary topbar buttons into the hamburger dropdown
   * (#collapsibleBtns). IDs and event listeners survive appendChild, so all
   * existing wiring keeps working. Runs once at startup, before any
   * topbar collapse measurement could observe the bar
   * (App.updateTopbarCollapseState is also short-circuited on mobile).
   */
  relocateTopbarForMobile() {
    const menu = document.getElementById('collapsibleBtns');
    if (!menu) return;

    const moveSection = (selectors) => {
      const section = document.createElement('div');
      section.className = 'mobileMenuSection';
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) section.appendChild(el);
      }
      if (section.childElementCount > 0) menu.appendChild(section);
    };

    // Zoom +/- are covered by pinch gestures on mobile and #flipCanvasBtn
    // stays on the slim bar next to the zoom percent, so the zoom group is
    // not relocated — only the recorder moves in.
    // File / communication
    moveSection(['#uploadBtn', '#saveBtn', '#inboxBtn']);
    // Recorder
    moveSection(['#tapeRecBtn']);
    // Room / admin (mostly hidden unless relevant)
    moveSection(['#adminTopBtn', '#registerRoomBtn', '#roomSettingsBtn', '#roomsBtn']);
  }

  /**
   * Desktop-only narrow-window auto-collapse (moved from App.handleResize).
   * On mobile the overlay never auto-opens or auto-closes on resize — the
   * soft keyboard resizes the viewport constantly.
   */
  handleResize() {
    if (isMobile()) return;
    const isNarrow = window.innerWidth < 768;
    if (this._wasNarrow !== isNarrow) {
      this.app.ui.setSidebarCollapsed(isNarrow);
      this._wasNarrow = isNarrow;
    }
  }
}
