/**
 * @fileoverview Main UI Manager for handling DOM interactions, icons, and specialized sub-UI components.
 */
import { mount, unmount } from 'svelte';
import { showAppConfirm } from './ConfirmDialog.js';
import { EditableValueHandler } from './EditableValueHandler.js';
import { badgesForUser, renderBadgesInto } from './Badges.js';
import { RemoteUserUI } from './RemoteUserUI.js';
import { LayerPreview } from './LayerPreview.js';
import { ResizableSections } from './ResizableSections.js';
import { isMobile } from '../platform/mobile.js';
import { appState } from '../state.svelte.js';
import { getRightClickActionsForTool, getRightClickActionLabel } from '../config/rightClickActions.js';
import { replaceSelectWithDropdown } from './dropdownMount.svelte.js';
import { enableDragScroll } from '../utils/dragScroll.js';
import PointerSlider from './svelte/PointerSlider.svelte';
import {
  DEFAULT_TEXT_FONT,
  ensureTextFontsLoaded,
  normalizeTextFont,
  getTextFontLetterSpacing,
  getTextFontStack,
  TEXT_FONT_OPTIONS
} from '../config/textFonts.js';
import {
  DEFAULT_APPLIED_TEXT_OFFSET,
  DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER,
  getPreviewTextContent,
  getPreviewTextLayout,
  getTextLineHeight
} from '../utils/textLayout.js';

import selectIconUrl from '../assets/icons/select-icon.svg';
import brushIconUrl from '../assets/icons/brush-icon.svg';
import lineIconUrl from '../assets/icons/line-icon.svg';
import rectangleIconUrl from '../assets/icons/rectangle-icon.svg';
import circleIconUrl from '../assets/icons/circle-icon.svg';
import textIconUrl from '../assets/icons/text-icon.svg';
import eraserIconUrl from '../assets/icons/eraser-icon.svg';
import circleBlurIconUrl from '../assets/icons/circle-blur-icon.svg';
import glitchIconUrl from '../assets/icons/glitch-icon.svg';
import inkdropperIconUrl from '../assets/icons/inkdropper-icon.svg';
import moveIconUrl from '../assets/icons/move-icon.svg';
import rotateIconUrl from '../assets/icons/rotate-icon.svg';
import pepperIconUrl from '../assets/icons/pepper.png';
import patternIconUrl from '../assets/icons/pattern-icon.svg';
import confettiIconUrl from '../assets/icons/confetti-icon.svg';

const fillBucketIconUrl = '../images/fillbucket-icon.svg';
const blendIconUrl = '../images/blend-icon.svg';
const zoomIconUrl = '../images/magnifying-glass.svg';

/**
 * UI Manager class
 */
export class UI {
  // Half-length (px, board space) of the constant-size crosshair used by
  // tools like select/fill that don't scale the cursor with brush size.
  static FIXED_CROSSHAIR_HALF = 10;

  constructor() {
    this.elements = {};
    this.svgCache = new Map(); // Initialize SVG cache
    this.icons = {}; // Will store references to cached SVG data or image elements
    this.cursors = new Map();
    this._savingPopupEl = null;
    this.editableHandler = new EditableValueHandler();
    this.remoteUserUI = null;
    this.layerPreview = new LayerPreview();
    this.resizableSections = null;
    this._pendingSelfCursor = null;
    this._selfCursorFlushScheduled = false;
  }

  /**
   * Initializes the UI manager and its sub-components.
   */
  async init() { // Made init async
    this.cacheElements();
    this.initInTrackLabels();
    this.initToggleHints();
    this.initPointerSliders();
    this.initInTrackRowDrag();
    this.initDropdowns();
    await this._preloadSVGIcons(); // Await preloading of SVG icons
    this.remoteUserUI = new RemoteUserUI(this.elements, this.icons);
    this.setRemoteUsersConnected(false);
    this.layerPreview.init();
    this.setupScrollIndicator();
    this.initDragScrollPanels();
    this.initResizableSections();
    this.setupSidebarResizers();

    this.elements.pressureDualSlider?.addEventListener('input', () => this.refreshPressureTrack());
    this.refreshPressureTrack();

    // Initial application from preferences
    if (window.app?.appPreferences) {
      this.applySidebarWidths(window.app.appPreferences);
    }
  }

  /**
   * Swaps the tool-option native <select>s for the shared Dropdown so every
   * dropdown in the app shares one look and one menu.
   */
  initDropdowns() {
    const { elements } = this;

    elements.cursorStyleSelect = replaceSelectWithDropdown(elements.cursorStyleSelect, {
      ariaLabel: 'Cursor style'
    }) ?? elements.cursorStyleSelect;

    elements.rightClickActionSelect = replaceSelectWithDropdown(elements.rightClickActionSelect, {
      ariaLabel: 'Right click action'
    }) ?? elements.rightClickActionSelect;

    elements.fontSelect = replaceSelectWithDropdown(elements.fontSelect, {
      ariaLabel: 'Font selection'
    }) ?? elements.fontSelect;

    this._initializeFontSelect();
  }

  /**
   * Initializes native-range tool sliders with custom pointer sliders.
   */
  initPointerSliders() {
    const createPointerSlider = (inputOrMount, options = {}) => {
      if (!inputOrMount || inputOrMount._pointerSliderReady) return inputOrMount;

      const source = inputOrMount;
      const mountPoint = source.matches?.('input[type="range"]')
        ? document.createElement('div')
        : source;

      const sliderClass = source.className || 'slider';
      const ariaLabel = source.getAttribute?.('aria-label') || options.ariaLabel || 'Slider';
      const state = {
        value: Number(options.value ?? source.value ?? 0),
        min: Number(options.min ?? source.min ?? 0),
        max: Number(options.max ?? source.max ?? 100),
        step: Number(options.step ?? source.step ?? 1),
        scaling: options.scaling || 'linear',
        weightedStopValue: Number(options.weightedStopValue ?? 10),
        weightedStopPercent: Number(options.weightedStopPercent ?? (1 / 3)),
        snapStep: options.snapStep || null,
        component: null,
        isDragging: false
      };

      if (mountPoint !== source) {
        mountPoint.id = source.id;
        mountPoint.className = sliderClass;
        mountPoint.setAttribute('role', 'presentation');
        source.replaceWith(mountPoint);
      }

      mountPoint._pointerSliderReady = true;

      const render = (extraProps = {}) => {
        if (state.component) {
          unmount(state.component);
        }
        state.component = mount(PointerSlider, {
          target: mountPoint,
          props: {
            value: state.value,
            min: state.min,
            max: state.max,
            step: state.step,
            scaling: state.scaling,
            weightedStopValue: state.weightedStopValue,
            weightedStopPercent: state.weightedStopPercent,
            snapStep: state.snapStep,
            ariaLabel,
            onChange: (newValue) => {
              state.value = newValue;
              mountPoint.dispatchEvent(new Event('input', { bubbles: true }));
            },
            onDragStart: () => { state.isDragging = true; },
            onDragEnd: () => {
              state.isDragging = false;
              // Re-sync in case the app rounded/clamped the value during the
              // drag while remounts were suppressed (see setter above).
              render();
            },
            ...extraProps
          }
        });
      };

      for (const key of ['value', 'min', 'max', 'step', 'scaling', 'weightedStopValue', 'weightedStopPercent', 'snapStep']) {
        Object.defineProperty(mountPoint, key, {
          configurable: true,
          get: () => state[key],
          set: (val) => {
            if (key === 'scaling') {
              state[key] = val;
            } else if (key === 'snapStep') {
              state[key] = val;
            } else {
              state[key] = Number(val);
            }
            // While the user is actively dragging the thumb, the app's own
            // 'input' handlers write the (possibly rounded) value straight
            // back onto this element. Remounting the component here would
            // tear down its pointer capture mid-drag and abort the drag
            // after a single move. The component already reflects the live
            // value internally; skip the remount until the drag ends.
            if (state.isDragging && key === 'value') return;
            render();
          }
        });
      }

      render();
      return mountPoint;
    };

    this.elements.sizeSlider = createPointerSlider(document.getElementById('sizeSliderMount'), {
      value: 10,
      min: 0.25,
      max: 100,
      step: 0.25,
      scaling: 'weighted',
      weightedStopValue: 10,
      weightedStopPercent: 1 / 3,
      snapStep: (val) => val > 10 ? 1 : 0.25,
      ariaLabel: 'Size'
    });

    const sliderElements = [
      ['spacingSlider', this.elements.spacingSlider],
      ['smoothingSlider', this.elements.smoothingSlider],
      ['hardnessSlider', this.elements.hardnessSlider],
      ['opacitySlider', this.elements.opacitySlider],
      ['blurRadiusSlider', this.elements.blurRadiusSlider],
      ['patternScaleSlider', this.elements.patternScaleSlider],
      ['patternRotationSlider', this.elements.patternRotationSlider],
      ['patternSpacingSlider', this.elements.patternSpacingSlider],
      ['patternOffsetXSlider', this.elements.patternOffsetXSlider],
      ['patternOffsetYSlider', this.elements.patternOffsetYSlider],
      ['fillPatternScaleSlider', this.elements.fillPatternScaleSlider],
      ['fillPatternRotationSlider', this.elements.fillPatternRotationSlider],
      ['fillPatternSpacingSlider', this.elements.fillPatternSpacingSlider],
      ['fillPatternOffsetXSlider', this.elements.fillPatternOffsetXSlider],
      ['fillPatternOffsetYSlider', this.elements.fillPatternOffsetYSlider],
      ['selectionPatternScaleSlider', this.elements.selectionPatternScaleSlider],
      ['selectionPatternRotationSlider', this.elements.selectionPatternRotationSlider],
      ['selectionPatternSpacingSlider', this.elements.selectionPatternSpacingSlider],
      ['selectionPatternOffsetXSlider', this.elements.selectionPatternOffsetXSlider],
      ['selectionPatternOffsetYSlider', this.elements.selectionPatternOffsetYSlider],
      ['confettiParticlesSlider', this.elements.confettiParticlesSlider],
      ['confettiParticleSizeSlider', this.elements.confettiParticleSizeSlider],
      ['confettiSizeVariationSlider', this.elements.confettiSizeVariationSlider],
      ['confettiOpacityRandomnessSlider', this.elements.confettiOpacityRandomnessSlider],
      ['confettiSpacingSlider', this.elements.confettiSpacingSlider],
      ['textPositionMultiplierSlider', this.elements.textPositionMultiplierSlider],
      ['textPositionOffsetSlider', this.elements.textPositionOffsetSlider],
      // Converted so it gets the same in-track bar as every other tool option
      // instead of the bespoke gradient it used to carry in the markup.
      ['thinningSlider', this.elements.thinningSlider],
      ['fillExpansionSlider', document.getElementById('fillExpansionSlider')],
      ['fillBlurSlider', document.getElementById('fillBlurSlider')]
    ];

    for (const [elementKey, slider] of sliderElements) {
      this.elements[elementKey] = createPointerSlider(slider);
    }
  }

  /**
   * Wraps each slider label's bare text node in a span so the in-track layout
   * can ellipsise it. A text node becomes an anonymous flex item, which CSS
   * cannot target — without this the name overruns the value at narrow sidebar
   * widths instead of truncating.
   */
  initInTrackLabels() {
    const labels = document.querySelectorAll('.sliderContainer .sliderLabel');

    for (const label of labels) {
      if (label.querySelector(':scope > .sliderName')) continue;

      for (const node of Array.from(label.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        if (!node.textContent.trim()) continue;

        const span = document.createElement('span');
        span.className = 'sliderName';
        span.textContent = node.textContent.trim();
        label.replaceChild(span, node);
      }
    }
  }

  /**
   * Tap-vs-drag for everything that sits on top of an in-track slider: the
   * toggle labels (Thinning, Pressure) and the value readouts.
   *
   * These overlays have to take pointer events or they could never be clicked,
   * which handed their share of the row away from the bar underneath: a drag
   * that started on the name toggled the checkbox, and one that started on the
   * number did nothing at all. Now the gesture decides. A tap still toggles or
   * opens the editor; once the pointer moves past TOGGLE_DRAG_SLOP the gesture
   * is handed to the slider the overlay is sitting on and the click it ends
   * with is swallowed, so the checkbox and the editor are left alone.
   */
  initInTrackRowDrag() {
    const overlays = document.querySelectorAll([
      '.sliderContainer .sliderLabel > .pressureToggle',
      '.sliderContainer .sliderLabel > .sliderValue',
      // The pattern X/Y offsets put their number straight in the group rather
      // than in a label, and each group carries its own track.
      '.sliderContainer .offset-slider-group > .sliderValue'
    ].join(', '));

    for (const overlay of overlays) {
      if (overlay.classList.contains('pressureToggle')) {
        this._wireRowDragHandoff(overlay);
        continue;
      }

      // While the inline editor is open the span is a text field: dragging in
      // it is selecting text, not driving the bar.
      this._wireRowDragHandoff(overlay, (el) => !el.querySelector('.sliderValueInput'));
    }
  }

  _wireRowDragHandoff(overlay, isEnabled = null) {
    if (overlay._rowDragHandoffReady) return;
    // A pattern offset pair puts two tracks in one container, so the group is
    // the row wherever there is one.
    const container = overlay.closest('.offset-slider-group') || overlay.closest('.sliderContainer');
    if (!container) return;
    overlay._rowDragHandoffReady = true;

    const TOGGLE_DRAG_SLOP = 4;
    let start = null;
    let suppressClick = false;

    const stopTracking = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      start = null;
    };

    const onPointerMove = (event) => {
      if (!start || event.pointerId !== start.pointerId) return;
      if (Math.abs(event.clientX - start.x) < TOGGLE_DRAG_SLOP
        && Math.abs(event.clientY - start.y) < TOGGLE_DRAG_SLOP) return;

      stopTracking();
      // A row whose track is hidden (pressure off, thinning collapsed) has
      // nothing to hand the drag to, so the gesture stays a tap.
      suppressClick = this._handOffRowDrag(container, event);
    };

    const onPointerEnd = () => stopTracking();

    overlay.addEventListener('pointerdown', (event) => {
      if (isEnabled && !isEnabled(overlay)) return;
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      suppressClick = false;
      start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerEnd);
      window.addEventListener('pointercancel', onPointerEnd);
    });

    // Capture phase, and immediate: the checkbox's activation behaviour runs
    // after dispatch, and the value editor opens from a listener on this very
    // span — which UI.init() registers ahead of, so stopping the rest of the
    // chain here is what keeps the editor shut.
    overlay.addEventListener('click', (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  /**
   * Passes a drag that began on a row overlay to that row's track. Returns
   * whether a track actually took it.
   */
  _handOffRowDrag(container, event) {
    const isVisible = (el) => !!el && el.getBoundingClientRect().width > 0;

    const dualSlider = container.querySelector('.dual-slider');
    if (isVisible(dualSlider)) return this._startDualSliderDrag(dualSlider, event);

    // PointerSlider's own root — the mount div around it carries .slider too,
    // but its handlers live on the component, so dispatching at the mount
    // would go nowhere.
    const pointerSlider = container.querySelector('[role="slider"]');
    if (isVisible(pointerSlider)) {
      pointerSlider.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: event.clientX,
        clientY: event.clientY,
        bubbles: true,
        cancelable: true
      }));

      // With the capture in hand the component sees the rest of the gesture
      // itself. Without it, it still hears pointermove/pointerup on the
      // document but not pointercancel — which a touch pointer can be dealt at
      // any moment, and which would otherwise leave the bar tracking a pointer
      // that is no longer down.
      if (!pointerSlider.hasPointerCapture?.(event.pointerId)) {
        const forwardCancel = (cancelEvent) => {
          if (cancelEvent.pointerId !== event.pointerId) return;
          window.removeEventListener('pointerup', forwardCancel);
          window.removeEventListener('pointercancel', forwardCancel);
          if (cancelEvent.type !== 'pointercancel') return;
          pointerSlider.dispatchEvent(new PointerEvent('pointercancel', {
            pointerId: cancelEvent.pointerId,
            pointerType: cancelEvent.pointerType,
            isPrimary: true,
            bubbles: true
          }));
        };
        window.addEventListener('pointerup', forwardCancel);
        window.addEventListener('pointercancel', forwardCancel);
      }

      return true;
    }

    return false;
  }

  /**
   * The pressure row is still two overlapping native ranges, which cannot be
   * handed a synthetic pointerdown — a native thumb only moves for real input.
   * So the drag is driven here instead: whichever handle the pointer started
   * nearest follows it until release.
   */
  _startDualSliderDrag(dualSlider, event) {
    const inputs = dualSlider.querySelectorAll('input[type="range"]');
    if (!inputs.length) return false;

    const rect = dualSlider.getBoundingClientRect();
    const min = Number(inputs[0].min || 0);
    const max = Number(inputs[0].max || 100);
    const step = Number(inputs[0].step) || 1;

    const valueAt = (clientX) => {
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const value = min + percent * (max - min);
      return Math.max(min, Math.min(max, Math.round(value / step) * step));
    };

    let handle = inputs[0];
    let closest = Infinity;
    const grabbed = valueAt(event.clientX);
    for (const input of inputs) {
      const distance = Math.abs(Number(input.value) - grabbed);
      if (distance < closest) {
        closest = distance;
        handle = input;
      }
    }

    const apply = (clientX) => {
      handle.value = String(valueAt(clientX));
      handle.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      apply(moveEvent.clientX);
    };

    const onEnd = (endEvent) => {
      if (endEvent.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      handle.dispatchEvent(new Event('change', { bubbles: true }));
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);

    apply(event.clientX);
    return true;
  }

  /**
   * Turns every toggle's description paragraph into a "?" next to its label.
   * The panel was carrying five permanent paragraphs of muted body text, which
   * read as clutter and were the hardest thing in the sidebar to read; now the
   * text is on demand and shown in full contrast.
   *
   * Built here rather than in the markup so every existing hint is covered and
   * any hint added later gets the affordance for free.
   *
   * The hint shows as a floating card rather than opening in flow: #toolSliders
   * and #toolExtras are scroll containers, so the element is moved to <body>
   * and — where the browser has it — put in the top layer with the popover API,
   * which no ancestor can clip or out-stack. Position is set from here because
   * anchor positioning is not portable yet.
   */
  initToggleHints() {
    const hints = document.querySelectorAll('.tool-toggle-hint');
    const supportsPopover = typeof HTMLElement !== 'undefined'
      && Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover');
    let seq = 0;

    for (const hint of hints) {
      const host = hint.parentElement;
      if (!host || host.querySelector(':scope .hintBtn')) continue;

      const label = host.querySelector('.tool-toggle-label');
      if (!label) continue;

      // The button has to sit beside the label text, but .tool-toggle is a
      // column (label above the switch), so the pair needs its own row.
      const row = document.createElement('span');
      row.className = 'tool-toggle-labelRow';
      label.replaceWith(row);
      row.appendChild(label);

      if (!hint.id) hint.id = `toggleHint-${++seq}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hintBtn';
      btn.textContent = '?';
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-describedby', hint.id);
      btn.setAttribute('aria-label', `About ${label.textContent.trim()}`);
      row.appendChild(btn);

      // A <button> is a labelable element and these labels carry no `for`, so
      // the browser picked the "?" — the first labelable descendant — as the
      // label's control. Clicking the switch's text then activated the button
      // (opening the hint) and never touched the checkbox. Binding the label to
      // its checkbox explicitly fixes both halves: the text flips the switch
      // again, and the button, being interactive content, no longer triggers
      // label activation at all.
      const toggleLabel = row.closest('label');
      const input = toggleLabel?.querySelector('input[type="checkbox"], input[type="radio"]');
      if (toggleLabel && input) {
        if (!input.id) input.id = `${hint.id}-input`;
        toggleLabel.htmlFor = input.id;
      }

      if (supportsPopover) hint.setAttribute('popover', 'manual');
      document.body.appendChild(hint);
      btn._toggleHint = hint;
      this._wireToggleHint(btn, hint);
    }

    const panel = this.elements.toolOptions;
    if (!panel || panel.dataset.hintClickBound) return;
    panel.dataset.hintClickBound = 'true';

    // Clicking the button pins the card open; clicking anywhere else dismisses
    // it. Pinning is handled on click rather than pointerdown because the
    // button sits inside the <label> — only cancelling the click stops it from
    // also flipping the switch it is describing.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest?.('.hintBtn');
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      if (this._openHintBtn === btn && this._hintPinned) {
        this._closeToggleHint();
      } else {
        this._openToggleHint(btn, true);
      }
    }, true);

    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest?.('.hintBtn, .tool-toggle-hint')) return;
      this._closeToggleHint();
    }, true);

    // Scrolling the panel (or resizing) leaves the card stranded next to
    // nothing, and the button may have scrolled out of the container entirely.
    // A keypress usually means a tool shortcut, which swaps the panel out from
    // under it.
    window.addEventListener('scroll', () => this._closeToggleHint(), true);
    window.addEventListener('resize', () => this._closeToggleHint());
    document.addEventListener('keydown', () => this._closeToggleHint());
  }

  /** Hover/focus wiring for one hint button. */
  _wireToggleHint(btn, hint) {
    const scheduleClose = () => {
      if (this._hintPinned) return;
      clearTimeout(this._hintCloseTimer);
      // Long enough to cross the gap between the button and the card, so the
      // text stays selectable.
      this._hintCloseTimer = setTimeout(() => this._closeToggleHint(), 140);
    };
    const cancelClose = () => clearTimeout(this._hintCloseTimer);

    btn.addEventListener('mouseenter', () => this._openToggleHint(btn, false));
    btn.addEventListener('mouseleave', scheduleClose);
    btn.addEventListener('focus', () => this._openToggleHint(btn, false));
    btn.addEventListener('blur', scheduleClose);
    hint.addEventListener('mouseenter', cancelClose);
    hint.addEventListener('mouseleave', scheduleClose);
  }

  /**
   * Shows one hint card beside its button, closing any other. `pinned` cards
   * survive the pointer leaving — that is the only way touch can read one.
   */
  _openToggleHint(btn, pinned) {
    const hint = btn._toggleHint;
    if (!hint) return;

    clearTimeout(this._hintCloseTimer);
    if (this._openHintBtn && this._openHintBtn !== btn) this._closeToggleHint();

    hint.classList.add('is-open');
    if (hint.hasAttribute('popover')) {
      try { hint.showPopover(); } catch { /* already open */ }
    }

    // Measured after showing, so the card has a real size to place.
    const anchor = btn.getBoundingClientRect();
    const card = hint.getBoundingClientRect();
    const margin = 8;
    const gap = 6;

    let left = anchor.left + anchor.width / 2 - card.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - card.width - margin));

    // Above by preference: the switch sits directly below its label row, and a
    // card dropped under the "?" would cover the thing it is describing.
    let top = anchor.top - card.height - gap;
    if (top < margin) {
      top = Math.min(anchor.bottom + gap, window.innerHeight - card.height - margin);
      top = Math.max(margin, top);
    }

    hint.style.left = `${Math.round(left)}px`;
    hint.style.top = `${Math.round(top)}px`;

    btn.setAttribute('aria-expanded', 'true');
    this._openHintBtn = btn;
    this._hintPinned = this._hintPinned || pinned;
  }

  /** Hides whichever hint card is open. */
  _closeToggleHint() {
    clearTimeout(this._hintCloseTimer);
    const btn = this._openHintBtn;
    this._openHintBtn = null;
    this._hintPinned = false;
    if (!btn) return;

    const hint = btn._toggleHint;
    hint?.classList.remove('is-open');
    if (hint?.hasAttribute('popover')) {
      try { hint.hidePopover(); } catch { /* already hidden */ }
    }
    btn.setAttribute('aria-expanded', 'false');
  }

  /**
   * Paints the band between the two pressure handles. The dual slider is a pair
   * of overlapping native ranges rather than a PointerSlider, so its fill has
   * to be driven from here.
   */
  refreshPressureTrack() {
    const { pressureDualSlider, pressureMinSlider, pressureMaxSlider } = this.elements;
    if (!pressureDualSlider || !pressureMinSlider || !pressureMaxSlider) return;

    const span = Number(pressureMaxSlider.max) - Number(pressureMaxSlider.min);
    if (!span) return;

    const base = Number(pressureMaxSlider.min);
    const lo = (Number(pressureMinSlider.value) - base) / span;
    const hi = (Number(pressureMaxSlider.value) - base) / span;

    pressureDualSlider.style.setProperty('--pressure-min', String(Math.min(lo, hi)));
    pressureDualSlider.style.setProperty('--pressure-max', String(Math.max(lo, hi)));
  }

  /**
   * Initializes resizable sections in the tool options panel
   */
  initResizableSections() {
    // Mobile: the options panel is a fixed overlay whose height differs from
    // the desktop column — persisted section heights would overflow it, and
    // drag handles are hidden anyway. Sections fall back to plain flex sizing.
    if (isMobile()) return;
    this.resizableSections = new ResizableSections('sidebarTop', [
      { id: 'userList', minHeight: 40, defaultHeight: 150, hasPersistentContent: true },
      { id: 'toolSliders', minHeight: 50, defaultHeight: 120, contentSelector: '.sliders' },
      { id: 'toolExtras', minHeight: 50, defaultHeight: 150 }
    ], {
      getContextKey: () => window.app?.self?.tool || 'default',
      sharedSectionIds: ['userList']
    });
  }

  /**
   * Setup sidebar and toolbar drag resizers.
   */
  setupSidebarResizers() {
    const { sidebarResizeHandle, toolsResizer } = this.elements;

    const setupResizer = (handle, cssVar, prefKey, min, max, isToolbar = false) => {
      if (!handle) return;

      let startX, startWidth;

      const onMouseMove = (e) => {
        const isLeft = document.documentElement.dataset.sidebarSide === 'left';
        let delta = e.clientX - startX;
        
        // If sidebar is on the right, dragging left (negative delta) increases width
        // If sidebar is on the left, dragging right (positive delta) increases width
        if (!isLeft) {
          delta = -delta;
        }
        
        const newWidth = Math.min(Math.max(startWidth + delta, min), max);
        document.documentElement.style.setProperty(cssVar, `${newWidth}px`);

        // Update preference in memory (save on mouseup)
        if (window.app?.appPreferences) {
          window.app.appPreferences.general[prefKey] = newWidth;
        }
      };

      const onMouseUp = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.documentElement.style.cursor = '';

        if (window.app?.appPreferences) {
          if (typeof window.app.setAppPreferences === 'function') {
            window.app.setAppPreferences(window.app.appPreferences);
          }
        }
      };

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        const currentStyle = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
        startWidth = parseInt(currentStyle, 10) || (isToolbar ? 48 : 200);
        
        handle.classList.add('dragging');
        document.body.classList.add('resizing');
        document.documentElement.style.cursor = 'col-resize';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    };

    setupResizer(sidebarResizeHandle, '--sidebar-width', 'sidebarWidth', 160, 600);
    setupResizer(toolsResizer, '--tools-width', 'toolsWidth', 32, 120, true);
  }

  /**
   * Apply sidebar and toolbar widths from preferences.
   * @param {Object} preferences - App preferences object
   */
  applySidebarWidths(preferences) {
    // Mobile: fixed rail width and overlay panel — ignore persisted desktop widths.
    if (isMobile()) {
      document.documentElement.style.setProperty('--sidebar-width', '200px');
      document.documentElement.style.setProperty('--tools-width', '44px');
      return;
    }

    const sidebarWidth = preferences?.general?.sidebarWidth ?? 200;
    const toolsWidth = preferences?.general?.toolsWidth ?? 36;

    document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    document.documentElement.style.setProperty('--tools-width', `${toolsWidth}px`);
  }

  /**
   * Lets a mouse/pen drag pan the tool options panel's scrollable sections,
   * matching touch's native pan gesture (pens don't get one).
   */
  initDragScrollPanels() {
    ['userList', 'toolSliders', 'toolExtras'].forEach((id) => {
      enableDragScroll(document.getElementById(id));
    });
  }

  /**
   * Sets up the scroll indicators for resizable sections
   */
  setupScrollIndicator() {
    const sections = [
      { panel: 'toolSliders', indicator: 'toolSlidersScrollIndicator' },
      { panel: 'toolExtras', indicator: 'toolExtrasScrollIndicator' }
    ];

    sections.forEach(({ panel: panelId, indicator: indicatorId }) => {
      const panel = document.getElementById(panelId);
      const indicator = document.getElementById(indicatorId);

      if (!panel || !indicator) return;

      let scheduledUpdate = null;
      const updateScrollIndicator = () => {
        if (scheduledUpdate) return;

        scheduledUpdate = requestAnimationFrame(() => {
          scheduledUpdate = null;
          const hasScroll = panel.scrollHeight > panel.clientHeight;
          const scrollTop = panel.scrollTop;
          const isNearBottom = panel.scrollHeight - scrollTop <= panel.clientHeight + 20;

          // Show only when: has scroll, at top (not scrolled), and not at bottom
          const shouldShow = hasScroll && scrollTop < 10 && !isNearBottom;
          if (shouldShow) {
            indicator.classList.add('visible');
          } else {
            indicator.classList.remove('visible');
          }
        });
      };

      // Initial check
      updateScrollIndicator();

      // Update on scroll
      panel.addEventListener('scroll', updateScrollIndicator);

      // Update when window resizes or content changes
      const resizeObserver = new ResizeObserver(updateScrollIndicator);
      resizeObserver.observe(panel);

      // Also check after a short delay (for dynamic content)
      setTimeout(updateScrollIndicator, 500);
    });
  }

  refreshToolOptionsLayout(tool = window.app?.self?.tool) {
    this.resizableSections?.refreshLayout(tool || 'default');
  }

  /**
   * Setup hover listeners for layer buttons to show miniatures.
   * @param {LayerManager} layerManager - Reference to the layer system
   */
  setupLayerPreviewListeners(layerManager) {
    const layerButtons = document.querySelectorAll('.layerButton');
    layerButtons.forEach(btn => {
      btn.addEventListener('touchstart', () => {
        this.layerPreview._longPressTimer = setTimeout(() => {
          const layerIdx = parseInt(btn.dataset.layer);
          const rect = btn.getBoundingClientRect();
          this.layerPreview.show(layerIdx, layerManager, rect.right, rect.top + rect.height / 2);
        }, 400);
      }, { passive: true });

      btn.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse') return;
        const layerIdx = parseInt(btn.dataset.layer);
        const rect = btn.getBoundingClientRect();
        this.layerPreview.show(layerIdx, layerManager, rect.right, rect.top + rect.height / 2);
      });

      btn.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'mouse') return;
        this.layerPreview.hide();
      });
    });
  }

  /**
   * Caches commonly used DOM element references.
   */
  cacheElements() {
    this.elements = {
      overlay: document.getElementById('overlay'),
      landingPage: document.getElementById('landingPage'),
      login: document.getElementById('login'),
      connecting: document.getElementById('connecting'),
      joinBtn: document.getElementById('joinBtn'),
      joinBtnLoggedIn: document.getElementById('joinBtnLoggedIn'),
      authLoggedInJoinBtn: document.getElementById('authLoggedInJoinBtn'),
      offlineBtn: document.getElementById('offlineBtn'),
      loginOfflineBtn: document.getElementById('loginOfflineBtn'),
      loginUsername: document.getElementById('loginUsername'),
      // Sign in tab's own username field — #loginUsername is the Guest tab's.
      loginAccountUsername: document.getElementById('loginAccountUsername'),
      loginPassword: document.getElementById('loginPassword'),
      loginForm: document.getElementById('loginForm'),
      loginBtn: document.getElementById('loginBtn'),
      rememberMe: document.getElementById('rememberMe'),

      boardContainer: document.getElementById('boardContainer'),
      boards: document.getElementById('boards'),
      board: document.getElementById('board'),
      topBoard: document.getElementById('topBoard'),
      userBoards: document.getElementById('userBoards'),

      cursorsSvg: document.getElementById('cursorsSvg'),
      selfCursor: document.querySelector('.cursor.self'),
      selfCircle: document.querySelector('.circle.self'),
      selfPressureCircle: document.querySelector('.pressureCircle.self'),
      selfDot: document.querySelector('.dot.self'),
      selfSquare: document.querySelector('.square.self'),
      selfPressureSquare: document.querySelector('.pressureSquare.self'),
      selfCrosshair: document.querySelector('.crosshair.self'),
      selfHand: document.querySelector('.hand.self'),
      selfZoom: document.querySelector('.zoom.self'),
      selfMutedIndicator: document.querySelector('.mutedIndicator.self'),
      selfText: document.querySelector('.text.self'),
      selfTextInput: document.querySelector('.textInput.self'),
      selfName: document.querySelector('.name.self'),
      mirrorLine: document.querySelector('.mirrorLine'),

      panBtn: document.getElementById('panBtn'),
      zoomBtn: document.getElementById('zoomBtn'),
      rotateBtn: document.getElementById('rotateBtn'),
      selectBtn: document.getElementById('selectBtn'),
      brushBtn: document.getElementById('brushBtn'),
      lineBtn: document.getElementById('lineBtn'),
      rectangleBtn: document.getElementById('rectangleBtn'),
      circleBtn: document.getElementById('circleBtn'),
      textBtn: document.getElementById('textBtn'),
      fillBtn: document.getElementById('fillBtn'),
      eraseBtn: document.getElementById('eraseBtn'),
      blurBtn: document.getElementById('blurBtn'),
      circleBlurBtn: document.getElementById('circleBlurBtn'),
      glitchBlurBtn: document.getElementById('glitchBlurBtn'),
      imageBrushBtn: document.getElementById('imageBrushBtn'),
      confettiBtn: document.getElementById('confettiBtn'),
      patternBtn: document.getElementById('patternBtn'),
      uploadBtn: document.getElementById('uploadBtn'),
      imageUploadInput: document.getElementById('imageUploadInput'),
      inkdropperBtn: document.getElementById('inkdropperBtn'),

      clearBtn: null, // injected dynamically by Moderation._injectModUI()
      resetBtn: document.getElementById('resetBtn'),
      zoomResetBtn: document.getElementById('zoomResetBtn'),
      flipCanvasBtn: document.getElementById('flipCanvasBtn'),
      mirrorBtn: document.getElementById('mirrorBtn'),
      plusBtn: document.getElementById('plusBtn'),
      minusBtn: document.getElementById('minusBtn'),
      zoomPercent: document.querySelector('.zoomPercent'),
      hudUndoBtn: document.getElementById('hudUndoBtn'),
      hudRedoBtn: document.getElementById('hudRedoBtn'),
menuBtn: document.getElementById('menuBtn'),
      collapsibleBtns: document.getElementById('collapsibleBtns'),
      fullscreenBtn: document.getElementById('fullscreenBtn'),
      sidebarToggleBtn: document.getElementById('sidebarToggleBtn'),
      sideMenu: document.getElementById('sideMenu'),
      toolOptions: document.getElementById('toolOptions'),

      debugBtn: null, // injected dynamically by App.refreshDebugButton()
      debugOverlay: document.getElementById('debugOverlay'),
      perfSettingsBtn: null, // injected dynamically by Moderation._injectModUI(),

      chatBtn: document.getElementById('chatBtn'),
      recordBtn: document.getElementById('recordBtn'),
      tapeRecBtn: document.getElementById('tapeRecBtn'),
      tapeRecElapsed: document.getElementById('tapeRecElapsed'),
      adminTopBtn: document.getElementById('adminTopBtn'),
      inboxBtn: document.getElementById('inboxBtn'),
      supportBtn: document.getElementById('supportBtn'),
      saveBtn: document.getElementById('saveBtn'),
      historyBtn: document.getElementById('historyBtn'),

      saveModeOverlay: document.getElementById('saveModeOverlay'),
      saveModeCloseBtn: document.getElementById('saveModeCloseBtn'),
      saveModeCancelBtn: document.getElementById('saveModeCancelBtn'),
      saveAreaBoard: document.getElementById('saveAreaBoard'),
      saveAreaSelection: document.getElementById('saveAreaSelection'),
      saveAreaSelectionLabel: document.getElementById('saveAreaSelectionLabel'),
      saveTransparent: document.getElementById('saveTransparent'),
      saveModeGallery: document.getElementById('saveModeGallery'),
      saveToGalleryBtn: document.getElementById('saveToGalleryBtn'),
      saveLocallyBtn: document.getElementById('saveLocallyBtn'),

      sizeSlider: null, // Will be initialized with Svelte component
      spacingSlider: document.querySelector('.slider.spacing'),
      pressureMinSlider: document.getElementById('pressureMinSlider'),
      pressureMaxSlider: document.getElementById('pressureMaxSlider'),
      pressureEnabled: document.getElementById('pressureEnabled'),
      pressureDualSlider: document.getElementById('pressureDualSlider'),
      pressureContainer: document.getElementById('pressure-container'),
      smoothingContainer: document.getElementById('smoothing-container'),
      smoothingSlider: document.querySelector('.slider.smoothing'),
      hardnessSlider: document.querySelector('.slider.hardness'),
      opacitySlider: document.querySelector('.slider.opacity'),
      blurRadiusSlider: document.querySelector('.slider.blurRadius'),
      thinningSlider: document.querySelector('.slider.thinning'),
      patternScaleSlider: document.querySelector('.slider.patternScale'),
      patternRotationSlider: document.querySelector('.slider.patternRotation'),
      patternSpacingSlider: document.querySelector('.slider.patternSpacing'),
      patternOffsetXSlider: document.querySelector('.slider.patternOffsetX'),
      patternOffsetYSlider: document.querySelector('.slider.patternOffsetY'),
      patternColorModeRadios: document.querySelectorAll('input[name="patternColorMode"]'),
      imageBrushModeOptions: document.getElementById('imageBrushModeOptions'),
      imageBrushColorModeRadios: document.querySelectorAll('input[name="imageBrushColorMode"]'),
      confettiModeOptions: document.getElementById('confettiModeOptions'),
      confettiColorModeRadios: document.querySelectorAll('input[name="confettiColorMode"]'),
      confettiRandomRotation: document.getElementById('confettiRandomRotation'),
      confettiParticlesSlider: document.getElementById('confettiParticlesInput'),
      confettiParticleSizeSlider: document.getElementById('confettiParticleSizeInput'),
      confettiSizeVariationSlider: document.getElementById('confettiSizeVariationInput'),
      confettiOpacityRandomnessSlider: document.getElementById('confettiOpacityRandomnessInput'),
      confettiSpacingSlider: document.getElementById('confettiSpacingInput'),
      confettiParticlesValue: document.getElementById('confettiParticlesValue'),
      confettiParticleSizeValue: document.getElementById('confettiParticleSizeValue'),
      confettiSizeVariationValue: document.getElementById('confettiSizeVariationValue'),
      confettiOpacityRandomnessValue: document.getElementById('confettiOpacityRandomnessValue'),
      confettiSpacingValue: document.getElementById('confettiSpacingValue'),

      fillPatternScaleSlider: document.querySelector('.slider.fillPatternScale'),
      fillPatternRotationSlider: document.querySelector('.slider.fillPatternRotation'),
      fillPatternSpacingSlider: document.querySelector('.slider.fillPatternSpacing'),
      fillPatternOffsetXSlider: document.querySelector('.slider.fillPatternOffsetX'),
      fillPatternOffsetYSlider: document.querySelector('.slider.fillPatternOffsetY'),
      fillPatternColorModeRadios: document.querySelectorAll('input[name="fillPatternColorMode"]'),
      fillPatternScaleValue: document.getElementById('fillPatternScaleValue'),
      fillPatternRotationValue: document.getElementById('fillPatternRotationValue'),
      fillPatternSpacingValue: document.getElementById('fillPatternSpacingValue'),
      fillPatternOffsetXValue: document.getElementById('fillPatternOffsetXValue'),
      fillPatternOffsetYValue: document.getElementById('fillPatternOffsetYValue'),
      fillPatternBrushList: document.getElementById('fillPatternBrushList'),

      selectionPatternScaleSlider: document.querySelector('.slider.selectionPatternScale'),
      selectionPatternRotationSlider: document.querySelector('.slider.selectionPatternRotation'),
      selectionPatternSpacingSlider: document.querySelector('.slider.selectionPatternSpacing'),
      selectionPatternOffsetXSlider: document.querySelector('.slider.selectionPatternOffsetX'),
      selectionPatternOffsetYSlider: document.querySelector('.slider.selectionPatternOffsetY'),
      selectionPatternColorModeRadios: document.querySelectorAll('input[name="selectionPatternColorMode"]'),
      selectionPatternScaleValue: document.getElementById('selectionPatternScaleValue'),
      selectionPatternRotationValue: document.getElementById('selectionPatternRotationValue'),
      selectionPatternSpacingValue: document.getElementById('selectionPatternSpacingValue'),
      selectionPatternOffsetXValue: document.getElementById('selectionPatternOffsetXValue'),
      selectionPatternOffsetYValue: document.getElementById('selectionPatternOffsetYValue'),
      selectionPatternBrushList: document.getElementById('selectionPatternBrushList'),

      sizeValue: document.getElementById('sizeValue'),
      pressureValue: document.getElementById('pressureValue'),
      smoothingValue: document.getElementById('smoothingValue'),
      spacingValue: document.getElementById('spacingValue'),
      hardnessValue: document.getElementById('hardnessValue'),
      opacityValue: document.getElementById('opacityValue'),
      blurRadiusValue: document.getElementById('blurRadiusValue'),
      thinningValue: document.getElementById('thinningValue'),
      textPositionMultiplierValue: document.getElementById('textPositionMultiplierValue'),
      textPositionOffsetValue: document.getElementById('textPositionOffsetValue'),
      patternScaleValue: document.getElementById('patternScaleValue'),
      patternRotationValue: document.getElementById('patternRotationValue'),
      patternSpacingValue: document.getElementById('patternSpacingValue'),
      patternOffsetXValue: document.getElementById('patternOffsetXValue'),
      patternOffsetYValue: document.getElementById('patternOffsetYValue'),

      brushFileInput: document.getElementById('brush-file-input'),
      brushImage: document.getElementById('brushImage'),
      sizeContainer: document.getElementById('size-container'),
      brushSpacing: document.getElementById('brush-spacing'),
      brushHardness: document.getElementById('brush-hardness'),
      opacityContainer: document.getElementById('brush-opacity'),
      cursorStyleContainer: document.getElementById('cursor-style-container'),
      cursorStyleSelect: document.getElementById('cursorStyleSelect'),
      rightClickActionContainer: document.getElementById('right-click-action-container'),
      rightClickActionSelect: document.getElementById('rightClickActionSelect'),
      blurRadiusContainer: document.getElementById('blur-radius'),
      glitchFastPreviewContainer: document.getElementById('glitch-fast-preview'),
      glitchFastPreview: document.getElementById('glitchFastPreview'),
      confettiParticlesContainer: document.getElementById('confetti-particles'),
      confettiParticleSizeContainer: document.getElementById('confetti-particle-size'),
      confettiSizeVariationContainer: document.getElementById('confetti-size-variation'),
      confettiOpacityRandomnessContainer: document.getElementById('confetti-opacity-randomness'),
      confettiSpacingContainer: document.getElementById('confetti-spacing'),
      inkThinningContainer: document.getElementById('ink-thinning'),
      fontContainer: document.getElementById('font-container'),
      textPositionMultiplierContainer: document.getElementById('text-position-multiplier-container'),
      textPositionOffsetContainer: document.getElementById('text-position-offset-container'),
      textRenderModeContainer: document.getElementById('text-render-mode-container'),
      textTemporaryToggle: document.getElementById('textTemporaryToggle'),

      selectionModeOptions: document.getElementById('selectionModeOptions'),
      eraserModeOptions: document.getElementById('eraserModeOptions'),
      inkdropperModeOptions: document.getElementById('inkdropperModeOptions'),
      inkdropperAutoSwitch: document.getElementById('inkdropperAutoSwitch'),
      brushModeOptions: document.getElementById('brushModeOptions'),
      shapeModeOptions: document.getElementById('shapeModeOptions'),
      circleBlurModeOptions: document.getElementById('circleBlurModeOptions'),
      fillModeOptions: document.getElementById('fillModeOptions'),
      patternModeOptions: document.getElementById('patternModeOptions'),
      patternBrushList: document.getElementById('patternBrushList'),
      patternImageBtn: document.getElementById('patternImageBtn'),
      patternImageUploadInput: document.getElementById('patternImageUploadInput'),
      patternShapeSelect: document.getElementById('patternShapeSelect'),
      patternShapeUploadBtn: document.getElementById('patternShapeUploadBtn'),
      patternShapeUploadInput: document.getElementById('patternShapeUploadInput'),

      sizeLock: document.getElementById('sizeLock'),
      pressureLock: document.getElementById('pressureLock'),
      smoothingLock: document.getElementById('smoothingLock'),
      spacingLock: document.getElementById('spacingLock'),
      hardnessLock: document.getElementById('hardnessLock'),
      opacityLock: document.getElementById('opacityLock'),
      blurRadiusLock: document.getElementById('blurRadiusLock'),
      thinningLock: document.getElementById('thinningLock'),
      thinningEnabled: document.getElementById('thinningEnabled'),
      textPositionMultiplierSlider: document.querySelector('.slider.textPositionMultiplier'),
      textPositionOffsetSlider: document.querySelector('.slider.textPositionOffset'),
      thinningSliderContainer: document.getElementById('thinningSlider'),
      thinningRow: document.getElementById('ink-thinning'),
      simulatePressureCheckbox: document.getElementById('simulatePressureCheckbox'),

      fontSelect: document.getElementById('font-select'),

      colorPicker: document.getElementById('colorPicker'),
      sidebarTop: document.getElementById('sidebarTop'),
      sidebarBottom: document.getElementById('sidebarBottom'),
      sidebarResizeHandle: document.getElementById('sidebarResizeHandle'),
      toolsResizer: document.getElementById('toolsResizer'),

      touchInput: document.getElementById('touchInput'),

      bottomBar: document.getElementById('bottomBar'),
      undoBtn: document.getElementById('undoBtn'),
      timeline: document.getElementById('timeline'),

      userList: document.getElementById('userList'),
      selfUserEntry: document.querySelector('.userEntry.self'),
      selfListTool: document.querySelector('.listTool.self'),
      selfListColor: document.querySelector('.listColor.self'),
      selfUserBadges: document.querySelector('.userBadges.self'),
      selfListUser: document.querySelector('.listUser.self'),

      toast: document.getElementById('toast'),

      disconnectionBanner: document.getElementById('disconnectionBanner'),
      retryConnectionBtn: document.getElementById('retryConnectionBtn'),
      switchToOfflineBtn: document.getElementById('switchToOfflineBtn'),

      connectionStatus: document.getElementById('connectionStatus'),
      connectionDot: document.querySelector('.connectionDot'),
      connectionText: document.querySelector('.connectionText'),
      connectionRoom: document.getElementById('connectionRoom'),
      disconnectBtn: document.getElementById('disconnectBtn'),
      roomsBtn: document.getElementById('roomsBtn'),
      userContextMenu: document.getElementById('userContextMenu'),
      modPanel: null, // injected dynamically by Moderation._injectModUI()
      bansBtn: null // injected dynamically by Moderation._injectModUI()
    };

    const tutorialTargets = [
      ['perfSettingsBtn', 'perf-settings'],
      ['roomSettingsBtn', 'room-settings'],
      ['mirrorBtn', 'mirror'],
      ['userList', 'user-list'],
      ['historyBtn', 'history'],
      ['sizeLock', 'locks'],
      ['pressureLock', 'locks'],
      ['smoothingLock', 'locks'],
      ['spacingLock', 'locks'],
      ['hardnessLock', 'locks'],
      ['opacityLock', 'locks'],
      ['blurRadiusLock', 'locks'],
      ['thinningLock', 'locks']
    ];

    for (const [key, value] of tutorialTargets) {
      if (this.elements[key]) {
        this.elements[key].dataset.tut = value;
      }
    }

    // Font options are populated in initDropdowns(), once the native <select>
    // has been swapped for the shared Dropdown.
  }

  /**
   * Preloads all SVG tool icons and stores their content.
   */
  async _preloadSVGIcons() {
    const iconMap = {
      select: selectIconUrl,
      brush: brushIconUrl,
      pen: brushIconUrl, // Reuse brush icon
      flowPen: brushIconUrl, // Reuse brush icon
      ink: brushIconUrl, // Reuse brush icon
      line: lineIconUrl,
      rectangle: rectangleIconUrl,
      circle: circleIconUrl,
      text: textIconUrl,
      fill: fillBucketIconUrl,
      erase: eraserIconUrl,
      blur: blendIconUrl,
      circleBlur: circleBlurIconUrl,
      glitchBlur: glitchIconUrl,
      inkdropper: inkdropperIconUrl,
      pan: moveIconUrl,
      zoom: zoomIconUrl,
      rotate: rotateIconUrl,
      pattern: patternIconUrl,
      confetti: confettiIconUrl,
      afk: '../images/zzz-icon.svg',
      lockClosed: '../images/lock-closed.svg', // Preload from static assets
      lockOpen: '../images/lock-open.svg'
    };

    const fetchPromises = Object.entries(iconMap).map(async ([toolName, url]) => {
      if (url.endsWith('.svg')) {
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to fetch ${url}`);
          const svgContent = await response.text();
          this.svgCache.set(toolName, { type: 'svg', content: svgContent, originalUrl: url });
        } catch (error) {
          console.error(`Error preloading SVG for ${toolName} (${url}):`, error);
          // Fallback to image element if preloading fails
          const img = document.createElement('img');
          img.className = 'toolIcon';
          img.src = url;
          img.alt = '';
          this.svgCache.set(toolName, { type: 'img', element: img, originalUrl: url });
        }
      } else {
        // Handle non-SVG icons (e.g., PNG) by creating an img element directly
        const img = document.createElement('img');
        img.className = 'toolIcon';
        img.src = url;
        img.alt = '';
        this.svgCache.set(toolName, { type: 'img', element: img, originalUrl: url });
      }
    });

    // Handle pepperIconUrl separately as it's a PNG and not in the main iconMap
    const pepperImg = document.createElement('img');
    pepperImg.className = 'toolIcon';
    pepperImg.src = pepperIconUrl;
    pepperImg.alt = '';
    this.svgCache.set('imageBrush', { type: 'img', element: pepperImg, originalUrl: pepperIconUrl });


    await Promise.all(fetchPromises);

    // Populate this.icons with references to the cached data
    for (const [toolName, data] of this.svgCache.entries()) {
      this.icons[toolName] = data;
    }
  }

  /**
   * Shows the login interface on the landing page.
   */
  showLogin() {
    this.elements.landingPage.style.display = 'flex';
    this.elements.login.style.display = 'none';
    this.elements.connecting.style.display = 'none';
  }

  /**
   * Hides the global overlay.
   */
  hideOverlay() {
    this.elements.overlay.style.display = 'none';
  }

  /**
   * Shows the local user's cursor elements.
   */
  showCursor() {
    this.elements.selfCursor.style.display = 'block';
  }

  /**
   * Hides the local user's cursor elements.
   */
  hideCursor() {
    this.elements.selfCursor.style.display = 'none';
    this.elements.selfCircle.style.display = 'none';
    this.elements.selfSquare.style.display = 'none';
    this.elements.selfCrosshair.style.display = 'none';
    if (this.elements.selfDot) {
      this.elements.selfDot.style.display = 'none';
    }
    this.elements.selfText.style.display = 'none';
    if (this.elements.selfPressureCircle) {
      this.elements.selfPressureCircle.style.display = 'none';
    }
    if (this.elements.selfPressureSquare) {
      this.elements.selfPressureSquare.style.display = 'none';
    }
  }

  /**
   * Updates the position and basic scale of the local user's cursor.
   * @param {number} x - Board X
   * @param {number} y - Board Y
   * @param {number} size - Base tool size
   */
  updateSelfCursor(x, y, size) {
    this._lastCursorX = x;
    this._lastCursorY = y;

    // Coalesce DOM writes to one per RAF — avoids ~50/sec SVG attribute thrash.
    this._pendingSelfCursor = { x, y, size };
    if (!this._selfCursorFlushScheduled) {
      this._selfCursorFlushScheduled = true;
      requestAnimationFrame(() => this._flushSelfCursor());
    }
  }

  _flushSelfCursor() {
    this._selfCursorFlushScheduled = false;
    const pending = this._pendingSelfCursor;
    if (!pending) return;
    this._pendingSelfCursor = null;
    const { x, y, size } = pending;

    const cursor = this.elements.selfCursor;
    const circle = this.elements.selfCircle;
    const pressureCircle = this.elements.selfPressureCircle;
    const dot = this.elements.selfDot;
    const square = this.elements.selfSquare;
    const pressureSquare = this.elements.selfPressureSquare;
    const crosshair = this.elements.selfCrosshair;
    const hand = this.elements.selfHand;
    const zoom = this.elements.selfZoom;
    const mutedIndicator = this.elements.selfMutedIndicator;

    cursor.style.transform = `translate(${x - 100}px, ${y - 100}px)`;
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    if (pressureCircle) {
      pressureCircle.setAttribute('cx', x);
      pressureCircle.setAttribute('cy', y);
    }
    if (dot) {
      dot.setAttribute('transform', `translate(${x}, ${y})`);
    }
    square.setAttribute('x', x - size);
    square.setAttribute('y', y - size);
    if (pressureSquare && pressureSquare.style.display !== 'none') {
      const psizeAttr = pressureSquare.getAttribute('width') || 10;
      const psize = parseFloat(psizeAttr) / 2;
      pressureSquare.setAttribute('x', x - psize);
      pressureSquare.setAttribute('y', y - psize);
    }
    crosshair.setAttribute('transform', `translate(${x}, ${y})`);
    if (hand) {
      hand.setAttribute('transform', `translate(${x}, ${y})`);
    }
    if (zoom) {
      zoom.setAttribute('transform', `translate(${x}, ${y})`);
    }
    if (mutedIndicator) {
      mutedIndicator.setAttribute('transform', `translate(${x}, ${y})`);
    }
  }

  /**
   * Updates the static radius/dimensions of the local cursor.
   * @param {number} size - Base tool size
   */
  updateCursorSize(size) {
    this.elements.selfCircle.setAttribute('r', size);
    this.elements.selfSquare.setAttribute('width', size * 2);
    this.elements.selfSquare.setAttribute('height', size * 2);
    // Tools that force a crosshair regardless of brush size (select, fill, etc.)
    // keep a constant-size crosshair — it shouldn't scale with the size slider.
    const tool = window.app?.self?.tool;
    const half = this.toolUsesFixedCrosshair(tool) ? UI.FIXED_CROSSHAIR_HALF : size;
    const crosshairLines = this.elements.selfCrosshair.querySelectorAll('line');
    crosshairLines.forEach((line) => {
      const x1 = parseFloat(line.getAttribute('x1'));
      if (!isNaN(x1) && x1 !== 0) {
        line.setAttribute('x1', -half);
        line.setAttribute('x2', half);
      } else {
        line.setAttribute('y1', -half);
        line.setAttribute('y2', half);
      }
    });
  }

  /**
   * Tools that always render a crosshair cursor independent of the brush size.
   * Their crosshair stays a constant on-screen size.
   */
  toolUsesFixedCrosshair(tool) {
    return tool === 'select' || tool === 'fill' || tool === 'inkdropper' || tool === 'rotate';
  }

  getSupportedCursorStyleTools() {
    return ['brush', 'flowPen', 'ink', 'erase'];
  }

  toolSupportsCursorStyle(tool) {
    return this.getSupportedCursorStyleTools().includes(tool);
  }

  getCursorStyleForTool(tool, user = null) {
    if (!this.toolSupportsCursorStyle(tool)) {
      if (tool === 'imageBrush' || tool === 'blur' || tool === 'glitchBlur' || tool === 'pixel') return 'square';
      if (tool === 'confetti') return 'circle';
      if (tool === 'select' || tool === 'fill' || tool === 'inkdropper' || tool === 'rotate') return 'crosshair';
      if (tool === 'pan') return 'hand';
      if (tool === 'zoom') return 'zoom';
      if (tool === 'text') return 'text';
      return 'circle';
    }

    const style = user?.cursorStyle || 'circle';
    return ['circle', 'crosshair', 'dot', 'square'].includes(style) ? style : 'circle';
  }

  applyLocalCursorStyle(tool, user = null) {
    const {
      selfCircle,
      selfPressureCircle,
      selfDot,
      selfSquare,
      selfPressureSquare,
      selfCrosshair,
      selfHand,
      selfZoom,
      selfText
    } = this.elements;

    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    if (selfDot) selfDot.style.display = 'none';
    if (selfHand) selfHand.style.display = 'none';
    if (selfZoom) selfZoom.style.display = 'none';
    if (selfText) selfText.style.display = 'none';
    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';

    const style = this.getCursorStyleForTool(tool, user);
    if (style === 'square') {
      selfSquare.style.display = 'block';
    } else if (style === 'crosshair') {
      selfCrosshair.style.display = 'block';
      // Constant-size crosshair for non-brush tools; reset in case the size
      // slider previously stretched the lines while a brush tool was active.
      if (this.toolUsesFixedCrosshair(tool)) {
        const half = UI.FIXED_CROSSHAIR_HALF;
        selfCrosshair.querySelectorAll('line').forEach((line) => {
          const x1 = parseFloat(line.getAttribute('x1'));
          if (!isNaN(x1) && x1 !== 0) {
            line.setAttribute('x1', -half);
            line.setAttribute('x2', half);
          } else {
            line.setAttribute('y1', -half);
            line.setAttribute('y2', half);
          }
        });
      }
    } else if (style === 'dot') {
      if (selfDot) selfDot.style.display = 'block';
    } else if (style === 'hand') {
      if (selfHand) selfHand.style.display = 'block';
    } else if (style === 'zoom') {
      if (selfZoom) selfZoom.style.display = 'block';
    } else if (style === 'text') {
      selfText.style.display = 'block';
    } else {
      selfCircle.style.display = 'block';
    }
  }

  /**
   * Reduces SVG cursor stroke widths at high zoom so the smallest pixel-brush
   * cursors stay visually precise.
   * @param {number} zoom
   */
  updateCursorStrokeWidthsForZoom(zoom) {
    const strokeWidth = zoom >= 5 ? '0.25' : zoom >= 1.5 ? '0.5' : '1';
    const labelScale = zoom > 1 ? 1 / zoom : 1;
    const {
      selfCircle,
      selfPressureCircle,
      selfDot,
      selfSquare,
      selfPressureSquare,
      selfCrosshair
    } = this.elements;

    if (selfCircle) selfCircle.setAttribute('stroke-width', strokeWidth);
    if (selfPressureCircle) selfPressureCircle.setAttribute('stroke-width', strokeWidth);
    if (selfDot) {
      const dotCircle = selfDot.querySelector('circle');
      const dotLines = selfDot.querySelectorAll('line');
      if (dotCircle) dotCircle.setAttribute('stroke-width', strokeWidth);
      dotLines.forEach((line) => line.setAttribute('stroke-width', strokeWidth));
    }
    if (selfSquare) selfSquare.setAttribute('stroke-width', strokeWidth);
    if (selfPressureSquare) selfPressureSquare.setAttribute('stroke-width', strokeWidth);

    if (selfCrosshair) {
      const lines = selfCrosshair.querySelectorAll('line');
      lines.forEach((line) => line.setAttribute('stroke-width', strokeWidth));
    }

    if (this.elements.boardContainer) {
      this.elements.boardContainer.style.setProperty('--cursor-label-scale', `${labelScale}`);
    }
  }

  /**
   * Updates the pressure-sensitive feedback circle radius.
   * @param {number} r - Pressure-scaled radius
   * @param {number} baseSize - Unscaled base size
   * @param {boolean} tabletDetected - Whether tablet/pen input has been detected
   */
  updatePressureCursorRadius(r, baseSize, tabletDetected = false) {
    const el = this.elements.selfPressureCircle;
    if (!el) return;
    if (this.getCursorStyleForTool(window.app?.self?.tool, window.app?.self) !== 'circle') {
      el.style.display = 'none';
      return;
    }

    // Only show inner circle if tablet is detected and pressure is less than full size
    if (tabletDetected && baseSize !== undefined && r < baseSize) {
      el.style.display = 'block';
      el.setAttribute('r', Math.max(1, r));
      // Only show dashed line if size is 8 or larger
      el.setAttribute('stroke-dasharray', baseSize >= 8 ? '3,2' : '0');
    } else {
      el.style.display = 'none';
    }
  }

  /**
   * Updates the pressure-sensitive feedback square size.
   * @param {number} squareSize - Pressure-scaled half-width
   * @param {number} baseSize - Unscaled base size
   * @param {boolean} tabletDetected - Whether tablet/pen input has been detected
   */
  updatePressureSquareSize(squareSize, baseSize, tabletDetected = false) {
    const el = this.elements.selfPressureSquare;
    if (!el) return;
    if (this.getCursorStyleForTool(window.app?.self?.tool, window.app?.self) !== 'square') {
      el.style.display = 'none';
      return;
    }

    // Only show inner square if tablet is detected and pressure is less than full size
    if (tabletDetected && baseSize !== undefined && squareSize < baseSize) {
      el.style.display = 'block';
      const sizeDoubled = Math.max(2, squareSize * 2);
      el.setAttribute('width', sizeDoubled);
      el.setAttribute('height', sizeDoubled);
      // Only show dashed line if size is 8 or larger
      el.setAttribute('stroke-dasharray', baseSize >= 8 ? '3,2' : '0');
    } else {
      el.style.display = 'none';
    }
  }

  /**
   * Synchronizes square cursor shapes with the current mouse position.
   * @param {number} size - Base tool size
   */
  updateSquarePositions(size) {
    const x = this._lastCursorX || 0;
    const y = this._lastCursorY || 0;
    const square = this.elements.selfSquare;
    const pressureSquare = this.elements.selfPressureSquare;

    if (square && square.style.display !== 'none') {
      square.setAttribute('x', x - size);
      square.setAttribute('y', y - size);
    }

    if (pressureSquare && pressureSquare.style.display !== 'none') {
      const psizeAttr = parseFloat(pressureSquare.getAttribute('width') || 2);
      const psize = psizeAttr / 2;
      pressureSquare.setAttribute('x', x - psize);
      pressureSquare.setAttribute('y', y - psize);
    }
  }

  /**
   * Shows the hand cursor for temporary panning (e.g. spacebar held),
   * hiding whatever cursor shape was previously visible.
   */
  showPanCursor() {
    const { selfCircle, selfPressureCircle, selfSquare, selfPressureSquare, selfCrosshair, selfHand, selfZoom, selfText, selfName } = this.elements;
    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    selfText.style.display = 'none';
    selfName.style.display = 'none';
    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
    if (selfZoom) selfZoom.style.display = 'none';
    selfHand.style.display = 'block';
  }

  showZoomCursor() {
    const { selfCircle, selfPressureCircle, selfSquare, selfPressureSquare, selfCrosshair, selfHand, selfZoom, selfText, selfName } = this.elements;
    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    selfText.style.display = 'none';
    selfName.style.display = 'none';
    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
    if (selfHand) selfHand.style.display = 'none';
    if (selfZoom) selfZoom.style.display = 'block';
  }

  /**
   * Restores the cursor shape for the current tool after temporary panning ends.
   * @param {string} tool - The current tool name
   * @param {Object} [user=null] - The local user object
   */
  hidePanCursor(tool, user = null) {
    this.elements.selfName.style.display = '';
    this.updateToolDisplay(tool, user);
  }

  /**
   * Switches between crosshair and hand for the selection tool.
   * @param {boolean} isHand - Whether to show the hand icon
   */
  setSelectCursor(isHand) {
    if (isHand) {
      this.elements.selfCrosshair.style.display = 'none';
      this.elements.selfName.style.display = 'none';
      if (this.elements.selfZoom) this.elements.selfZoom.style.display = 'none';
      this.elements.selfHand.style.display = 'block';
    } else {
      this.elements.selfCrosshair.style.display = 'block';
      this.elements.selfName.style.display = '';
      this.elements.selfHand.style.display = 'none';
      if (this.elements.selfZoom) this.elements.selfZoom.style.display = 'none';
    }
  }

  /**
   * Temporarily force the local cursor to use the select-style crosshair.
   */
  showMirrorRegionCursor() {
    const {
      selfCircle,
      selfPressureCircle,
      selfSquare,
      selfPressureSquare,
      selfCrosshair,
      selfHand,
      selfZoom,
      selfText
    } = this.elements;

    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'block';
    selfHand.style.display = 'none';
    if (selfZoom) selfZoom.style.display = 'none';
    selfText.style.display = 'none';
    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
  }

  /**
   * Updates the muted indicator state on the local cursor.
   * @param {boolean} muted - Whether the user is muted
   */
  setMutedState(muted) {
    const indicator = this.elements.selfMutedIndicator;
    const circle = this.elements.selfCircle;
    if (indicator) {
      indicator.style.display = muted ? 'block' : 'none';
    }
    if (circle) {
      circle.setAttribute('stroke', muted ? '#ef4444' : 'grey');
    }
  }

  /**
   * Updates the position of the muted indicator.
   * @param {number} x - Board X
   * @param {number} y - Board Y
   */
  updateMutedIndicatorPosition(x, y) {
    const indicator = this.elements.selfMutedIndicator;
    if (indicator) {
      indicator.setAttribute('transform', `translate(${x}, ${y})`);
    }
  }

  /**
   * Resolves the one preview surface that belongs to the active tool.
   * @param {string} tool - Current tool name
   * @param {Object} [user=null] - Local user object
   * @returns {{visible: boolean, mode: string}}
   */
  getToolPreviewState(tool, user = null) {
    const previewUser = user || window.app?.self || null;

    switch (tool) {
      case 'brush':
      case 'flowPen':
      case 'ink':
      case 'pixel':
      case 'confetti':
      case 'pattern':
        return { visible: true, mode: tool };
      case 'imageBrush':
        return { visible: !!previewUser?.imageBrush, mode: 'imageBrush' };
      case 'select': {
        const selectTool = window.app?.toolManager?.getTool('select');
        return { visible: !!selectTool?.patternMode, mode: 'pattern' };
      }
      case 'fill': {
        const fillTool = window.app?.toolManager?.getTool('fill');
        return { visible: !!fillTool?.patternMode, mode: 'pattern' };
      }
      default:
        return { visible: false, mode: appState.toolPreviewMode || 'brush' };
    }
  }

  /**
   * Updates tool options and cursor shapes based on the current tool.
   * @param {string} tool - Current tool name
   * @param {Object} [user=null] - Local user object
   */
  updateToolDisplay(tool, user = null) {
    const {
      selfCircle, selfPressureCircle, selfDot, selfSquare, selfPressureSquare, selfCrosshair, selfHand, selfZoom, selfText, selfName,
      brushImage, brushFileInput, sizeContainer, pressureContainer, smoothingContainer,
      brushSpacing, brushHardness, opacityContainer, cursorStyleContainer, cursorStyleSelect, blurRadiusContainer,
      selectionModeOptions, eraserModeOptions, inkdropperModeOptions, brushModeOptions, shapeModeOptions, circleBlurModeOptions, fillModeOptions, patternModeOptions, imageBrushModeOptions, confettiModeOptions, fontContainer, textPositionMultiplierContainer, textPositionOffsetContainer, textRenderModeContainer
    } = this.elements;

    // Toggle a flex-order class on the .sliders container so text-tool option
    // order is size → opacity → font → mode without disturbing other tools.
    const slidersWrap = sizeContainer?.parentElement;
    if (slidersWrap?.classList) {
      slidersWrap.classList.toggle('text-tool-order', tool === 'text');
    }

    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    if (selfDot) selfDot.style.display = 'none';
    selfHand.style.display = 'none';
    if (selfZoom) selfZoom.style.display = 'none';
    selfText.style.display = 'none';
    if (brushImage) brushImage.style.display = 'none';
    if (brushFileInput) brushFileInput.style.display = 'none';
    brushSpacing.style.display = 'none';
    brushHardness.style.display = 'none';
    if (cursorStyleContainer) cursorStyleContainer.style.display = 'none';
    if (fontContainer) fontContainer.style.display = 'none'; // Hide by default
    if (textPositionMultiplierContainer) textPositionMultiplierContainer.style.display = 'none';
    if (textPositionOffsetContainer) textPositionOffsetContainer.style.display = 'none';
    if (textRenderModeContainer) textRenderModeContainer.style.display = 'none';
    if (this.elements.confettiParticlesContainer) this.elements.confettiParticlesContainer.style.display = 'none';
    if (this.elements.confettiParticleSizeContainer) this.elements.confettiParticleSizeContainer.style.display = 'none';
    if (this.elements.confettiSizeVariationContainer) this.elements.confettiSizeVariationContainer.style.display = 'none';
    if (this.elements.confettiOpacityRandomnessContainer) this.elements.confettiOpacityRandomnessContainer.style.display = 'none';
    if (this.elements.confettiSpacingContainer) this.elements.confettiSpacingContainer.style.display = 'none';

    sizeContainer.style.display = 'block';
    pressureContainer.style.display = 'block';
    smoothingContainer.style.display = 'block';
    opacityContainer.style.display = 'block';

    if (blurRadiusContainer) blurRadiusContainer.style.display = 'none';
    if (this.elements.glitchFastPreviewContainer) this.elements.glitchFastPreviewContainer.style.display = 'none';
    if (selectionModeOptions) selectionModeOptions.style.display = 'none';
    if (eraserModeOptions) eraserModeOptions.style.display = 'none';
    if (inkdropperModeOptions) inkdropperModeOptions.style.display = 'none';
    if (brushModeOptions) brushModeOptions.style.display = 'none';
    if (shapeModeOptions) shapeModeOptions.style.display = 'none';
    if (circleBlurModeOptions) circleBlurModeOptions.style.display = 'none';
    if (this.elements.fillModeOptions) this.elements.fillModeOptions.style.display = 'none';
    if (patternModeOptions) patternModeOptions.style.display = 'none';
    if (imageBrushModeOptions) imageBrushModeOptions.style.display = 'none';
    if (confettiModeOptions) confettiModeOptions.style.display = 'none';
    if (this.elements.inkThinningContainer) this.elements.inkThinningContainer.style.display = 'none';
    const nextToolPreviewState = this.getToolPreviewState(tool, user);
    appState.toolPreviewMode = nextToolPreviewState.mode;
    appState.toolPreviewVisible = nextToolPreviewState.visible;
    
    const { blendModeOptions } = this.elements;
    if (blendModeOptions) {
      const layerManager = window.app?.board?.layerManager;
      const activeLayer = window.app?.self?.activeLayer ?? 0;
      const allowComplex = layerManager ? layerManager.getLayerAllowComplexBlendModes(activeLayer) : true;
      blendModeOptions.style.display = (this.toolSupportsBlendMode(tool) && allowComplex) ? 'block' : 'none';
    }

    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
    if (selfName) selfName.style.display = (tool === 'pan' || tool === 'zoom') ? 'none' : '';

    switch (tool) {
      case 'select':
        this.applyLocalCursorStyle(tool, user);
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'block';
        if (selectionModeOptions) selectionModeOptions.style.display = 'block';
        break;

      case 'brush':
      case 'flowPen':
        this.applyLocalCursorStyle(tool, user);
        brushHardness.style.display = 'block';
        if (brushModeOptions) brushModeOptions.style.display = 'block';
        if (cursorStyleContainer) cursorStyleContainer.style.display = 'block';
        break;

      case 'ink':
        this.applyLocalCursorStyle(tool, user);
        brushHardness.style.display = 'block';
        if (brushModeOptions) brushModeOptions.style.display = 'block';
        if (cursorStyleContainer) cursorStyleContainer.style.display = 'block';
        if (this.elements.inkThinningContainer) this.elements.inkThinningContainer.style.display = 'block';
        break;

      case 'line':
      case 'rectangle':
      case 'circle':
        this.applyLocalCursorStyle(tool, user);
        brushHardness.style.display = 'block';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        if ((tool === 'rectangle' || tool === 'circle') && shapeModeOptions) {
          shapeModeOptions.style.display = 'block';
        }
        break;

      case 'text':
        this.applyLocalCursorStyle(tool, user);
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        if (fontContainer) fontContainer.style.display = 'block'; // Show font dropdown
        if (textRenderModeContainer) textRenderModeContainer.style.display = 'block';
        // Keeping the text tuning controls dormant for now.
        // if (textPositionMultiplierContainer) textPositionMultiplierContainer.style.display = 'block';
        // if (textPositionOffsetContainer) textPositionOffsetContainer.style.display = 'block';
        if (user) {
          this.updateFontSelect(user.font);
          this.updateTextPositionMultiplierValue(user.textPositionMultiplier);
          this.updateTextPositionOffsetValue(user.textPositionOffset);
          this.updateTextRenderMode(user.textRenderMode);
        }
        break;

      case 'erase':
        this.applyLocalCursorStyle(tool, user);
        brushHardness.style.display = 'none';
        if (eraserModeOptions) eraserModeOptions.style.display = 'block';
        if (cursorStyleContainer) cursorStyleContainer.style.display = 'block';
        break;

      case 'circleBlur':
        this.applyLocalCursorStyle(tool, user);
        brushSpacing.style.display = 'block';
        brushHardness.style.display = 'block';
        break;

      case 'glitchBlur':
        this.applyLocalCursorStyle(tool, user);
        brushSpacing.style.display = 'block';
        smoothingContainer.style.display = 'none';
        if (blurRadiusContainer) blurRadiusContainer.style.display = 'block';
        if (this.elements.glitchFastPreviewContainer) this.elements.glitchFastPreviewContainer.style.display = 'block';
        break;

      case 'blur':
        this.applyLocalCursorStyle(tool, user);
        brushSpacing.style.display = 'block';
        smoothingContainer.style.display = 'none';
        if (blurRadiusContainer) blurRadiusContainer.style.display = 'block';
        break;

      case 'imageBrush':
        this.applyLocalCursorStyle(tool, user);
        brushSpacing.style.display = 'block';
        if (imageBrushModeOptions) imageBrushModeOptions.style.display = 'block';
        break;

      case 'confetti':
        this.applyLocalCursorStyle(tool, user);
        brushSpacing.style.display = 'none';
        brushHardness.style.display = 'none';
        smoothingContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        if (confettiModeOptions) confettiModeOptions.style.display = 'block';
        if (this.elements.confettiParticlesContainer) this.elements.confettiParticlesContainer.style.display = 'block';
        if (this.elements.confettiParticleSizeContainer) this.elements.confettiParticleSizeContainer.style.display = 'block';
        if (this.elements.confettiSizeVariationContainer) this.elements.confettiSizeVariationContainer.style.display = 'block';
        if (this.elements.confettiOpacityRandomnessContainer) this.elements.confettiOpacityRandomnessContainer.style.display = 'block';
        if (this.elements.confettiSpacingContainer) this.elements.confettiSpacingContainer.style.display = 'block';
        break;

      case 'pattern':
        if (user && user.patternShape === 'square') {
          selfSquare.style.display = 'block';
        } else {
          selfCircle.style.display = 'block';
        }
        brushSpacing.style.display = 'none';
        smoothingContainer.style.display = 'none';
        if (patternModeOptions) patternModeOptions.style.display = 'block';
        break;

      case 'pixel':
        this.applyLocalCursorStyle(tool, user);
        brushSpacing.style.display = 'block';
        if (brushModeOptions) brushModeOptions.style.display = 'block';
        break;

      case 'fill':
        this.applyLocalCursorStyle(tool, user);
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        if (fillModeOptions) fillModeOptions.style.display = 'block';
        break;

      case 'inkdropper':
        this.applyLocalCursorStyle(tool, user);
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        if (inkdropperModeOptions) inkdropperModeOptions.style.display = 'block';
        break;

      case 'pan':
        this.applyLocalCursorStyle(tool, user);
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        break;

      case 'zoom':
        this.applyLocalCursorStyle(tool, user);
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        break;

      case 'rotate':
        this.applyLocalCursorStyle(tool, user);
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        break;
    }

    if (cursorStyleSelect) {
      cursorStyleSelect.value = this.getCursorStyleForTool(tool, user);
    }

    this.updateRightClickActionOptions(tool);
    this.updateToolButton(tool);
    this.refreshToolOptionsLayout(tool);
  }

  /**
   * Rebuilds the right-click action dropdown for the given tool and selects
   * the tool's configured action. Hidden for tools with only one option.
   * @param {string} tool - Current tool name.
   */
  updateRightClickActionOptions(tool) {
    const { rightClickActionContainer, rightClickActionSelect } = this.elements;
    if (!rightClickActionContainer || !rightClickActionSelect) return;

    const actions = getRightClickActionsForTool(tool);
    if (actions.length < 2) {
      rightClickActionContainer.style.display = 'none';
      return;
    }

    const signature = actions.join(',');
    if (rightClickActionSelect.dataset.actions !== signature) {
      rightClickActionSelect.setOptions?.(actions.map(id => ({
        value: id,
        label: getRightClickActionLabel(id)
      })));
      rightClickActionSelect.dataset.actions = signature;
    }

    rightClickActionSelect.value = window.app?.getRightClickAction?.(tool) ?? actions[0];
    rightClickActionContainer.style.display = 'block';
  }

  /**
   * Check if a tool supports blend modes.
   * @param {string} tool - Tool name
   * @returns {boolean}
   */
  toolSupportsBlendMode(tool) {
    const noBlendTools = ['erase', 'pan', 'zoom', 'rotate', 'inkdropper'];
    return !noBlendTools.includes(tool);
  }

  /**
   * Updates the selected state of tool buttons in the toolbar.
   * @param {string} tool - Selected tool name
   */
  updateToolButton(tool) {
    const buttons = {
      pan: this.elements.panBtn,
      zoom: this.elements.zoomBtn,
      rotate: this.elements.rotateBtn,
      select: this.elements.selectBtn,
      brush: this.elements.brushBtn,
      pixel: this.elements.brushBtn,
      line: this.elements.lineBtn,
      rectangle: this.elements.rectangleBtn,
      circle: this.elements.circleBtn,
      text: this.elements.textBtn,
      fill: this.elements.fillBtn,
      erase: this.elements.eraseBtn,
      blur: this.elements.blurBtn,
      circleBlur: this.elements.circleBlurBtn,
      glitchBlur: this.elements.glitchBlurBtn,
      imageBrush: this.elements.imageBrushBtn,
      confetti: this.elements.confettiBtn,
      pattern: this.elements.patternBtn,
      inkdropper: this.elements.inkdropperBtn
    };

    Object.values(buttons).forEach(btn => btn && btn.classList.remove('selected'));
    let buttonTool = tool;
    if (tool === 'flowPen' || tool === 'ink') buttonTool = 'brush';
    if (buttons[buttonTool]) {
      buttons[buttonTool].classList.add('selected');
    }
    this.updateToolGroupButtons(buttonTool, buttons);

    const toolIconData = this.icons[tool]; // Renamed to avoid confusion with the DOM element

    if (toolIconData) {
      const toolEntry = this.elements.selfListTool;
      if (toolEntry.children[0]) {
        toolEntry.children[0].remove();
      }

      if (toolIconData.type === 'svg') {
        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'toolIcon'; // Apply class for consistent styling
        svgWrapper.innerHTML = toolIconData.content;
        toolEntry.appendChild(svgWrapper);
      } else if (toolIconData.type === 'img') {
        toolEntry.appendChild(toolIconData.element.cloneNode(true)); // Clone the pre-created img element
      }
    }
  }

  updateToolGroupButtons(tool, buttons) {
    const groups = [
      { id: 'moveGroup', primary: 'pan', slots: ['pan', 'zoom', 'rotate'] },
      { id: 'shapesGroup', primary: 'line', slots: ['line', 'rectangle', 'circle'] },
      { id: 'blurGroup', primary: 'blur', slots: ['blur', 'circleBlur', 'glitchBlur'] }
    ];

    const storeDefault = (button, toolName) => {
      if (!button || button.dataset.defaultHtml) return;
      button.dataset.defaultTool = toolName;
      button.dataset.defaultHtml = button.innerHTML;
      button.dataset.defaultTitle = button.title || '';
    };

    const renderButton = (button, toolName) => {
      const sourceButton = buttons[toolName];
      if (!button || !sourceButton) return;
      storeDefault(sourceButton, toolName);

      if (button.dataset.tool === toolName) {
        button.title = sourceButton.dataset.defaultTitle || sourceButton.title || '';
        return;
      }

      button.dataset.tool = toolName;
      button.innerHTML = sourceButton.dataset.defaultHtml || sourceButton.innerHTML;
      button.title = sourceButton.dataset.defaultTitle || sourceButton.title || '';
    };

    const restoreButton = (button) => {
      if (!button?.dataset.defaultTool) return;
      if (!button.dataset.tool || button.dataset.tool === button.dataset.defaultTool) return;
      button.dataset.tool = button.dataset.defaultTool;
      button.innerHTML = button.dataset.defaultHtml || button.innerHTML;
      button.title = button.dataset.defaultTitle || '';
    };

    for (const groupConfig of groups) {
      const group = document.getElementById(groupConfig.id);
      const primaryButton = buttons[groupConfig.primary];
      if (!group || !primaryButton) continue;

      for (const toolName of groupConfig.slots) {
        storeDefault(buttons[toolName], toolName);
      }

      const subgroup = group.querySelector('.toolSubgroup');
      const subgroupStyle = subgroup ? window.getComputedStyle(subgroup) : null;
      // 'fixed' too: App._positionToolFlyout re-anchors flyouts when the
      // rail clips its own overflow. Expanded subgroups are static.
      const isCollapsedPopup = !!subgroupStyle && subgroupStyle.position !== 'static';

      if (!isCollapsedPopup) {
        delete group.dataset.activeTool;
        for (const toolName of groupConfig.slots) {
          restoreButton(buttons[toolName]);
        }
        continue;
      }

      // Promotion is unconditional while the group is collapsed — it used to
      // be gated on the flyout being open, which meant the rail showed the
      // group's default tool (pan/line/blur) even when zoom/rectangle/glitch
      // was the selected one: you couldn't see what was active without
      // hovering, and the icons shuffled under the pointer when you did.
      const activeTool = groupConfig.slots.includes(tool)
        ? tool
        : (group.dataset.activeTool || groupConfig.primary);
      const inactiveTools = groupConfig.slots.filter(toolName => toolName !== activeTool);
      const subgroupButtons = groupConfig.slots
        .filter(toolName => toolName !== groupConfig.primary)
        .map(toolName => buttons[toolName])
        .filter(Boolean);

      group.dataset.activeTool = activeTool;
      renderButton(primaryButton, activeTool);
      primaryButton.classList.toggle('selected', groupConfig.slots.includes(tool));

      for (let i = 0; i < subgroupButtons.length; i++) {
        renderButton(subgroupButtons[i], inactiveTools[i]);
        subgroupButtons[i].classList.remove('selected');
      }
    }
  }

  /**
   * Updates the zoom percentage display.
   * @param {string} percent - Zoom percentage text
   */
  updateZoomDisplay(percent) {
    this.elements.zoomPercent.textContent = percent;
    if (this._hideOwnLabelZoom) {
      const zoomValue = parseInt(percent, 10);
      this.elements.selfCursor?.classList.toggle('zoom-hide-name', zoomValue > 150);
    }
  }

  setHideOwnLabelZoom(enabled) {
    this._hideOwnLabelZoom = !!enabled;
    if (!enabled) {
      this.elements.selfCursor?.classList.remove('zoom-hide-name');
    } else {
      const zoomValue = parseInt(this.elements.zoomPercent?.textContent ?? '100', 10);
      this.elements.selfCursor?.classList.toggle('zoom-hide-name', zoomValue > 150);
    }
  }

  /**
   * Updates the mirror line toggle display.
   * @param {boolean} enabled - Whether mirror is enabled
   */
  updateMirrorDisplay(enabled) {
    const mirrorModeActive = !!window.app?.mirrorRegionController?.isActive?.();
    this.elements.mirrorBtn?.classList.toggle('selected', !!enabled || mirrorModeActive);
  }

  updateCanvasFlipDisplay(enabled) {
    this.elements.flipCanvasBtn?.classList.toggle('selected', !!enabled);
  }

  /**
   * Updates the Debug mode toggle display.
   * @param {boolean} enabled - Whether Debug mode is enabled
   */
  updateDebugModeDisplay(enabled) {
    // debugBtn is injected dynamically; re-query in case it was added after init
    const debugBtn = this.elements.debugBtn || document.getElementById('debugBtn');
    if (debugBtn) {
      this.elements.debugBtn = debugBtn;
      debugBtn.classList.toggle('selected', !!enabled);
    }
  }

  /**
   * Updates the brush mode radio buttons.
   * @param {string} mode - Selected brush mode
   */
  updateBrushModeDisplay(mode) {
    const radios = document.querySelectorAll('input[name="brushMode"]');
    radios.forEach(r => {
      r.checked = (r.value === mode);
    });
  }

  /**
   * Updates the circle blur mode radio buttons.
   * @param {string} tool - Selected circle blur tool
   * @deprecated Circle blur no longer has soft/hard modes
   */
  updateCircleBlurModeDisplay(tool) {
    // No-op: Circle blur now only has one mode (averaged color circles)
  }

  /**
   * Updates the highlighted layer button in the layers panel.
   * @param {number} layerIndex - Active layer index
   */
  updateActiveLayerDisplay(layerIndex) {
    const layerButtons = document.querySelectorAll('.layerButton');
    layerButtons.forEach(btn => {
      const btnLayer = parseInt(btn.dataset.layer);
      btn.classList.toggle('active', btnLayer === layerIndex);
    });
  }

  /**
   * Enable/disable blur tool buttons based on active layer.
   * Regular blur and glitch blur only work on layer 0 (Layer 1).
   * @param {number} layerIndex - Active layer index
   */
  updateBlurToolState(layerIndex) {
    const regularBlurDisabled = layerIndex !== 0;
    const glitchBlurDisabled = layerIndex !== 0;
    if (this.elements.blurBtn) {
      const renderedTool = this.elements.blurBtn.dataset.tool || 'blur';
      const disabled = renderedTool === 'glitchBlur' ? glitchBlurDisabled : regularBlurDisabled;
      this.elements.blurBtn.classList.toggle('tool-disabled', disabled);
    }
    if (this.elements.glitchBlurBtn) {
      this.elements.glitchBlurBtn.classList.toggle('tool-disabled', glitchBlurDisabled);
    }
  }

  /**
   * Updates the selected blend mode in the dropdown.
   * @param {string} blendMode - Selected blend mode
   */
  updateBlendModeDisplay(blendMode) {
    if (this.elements.blendModeSelect) {
      this._updatingBlendMode = true;
      this.elements.blendModeSelect.value = blendMode;
      this._updatingBlendMode = false;
    }
  }

  /**
   * Updates blend mode section visibility based on layer support.
   * @param {boolean} allowComplex - Whether the active layer allows blend modes
   * @returns {boolean} - True if a reset to Normal was performed
   */
  updateBlendModeForLayer(allowComplex) {
    const section = this.elements.blendModeOptions;
    if (!section) return false;

    const tool = window.app?.self?.tool;
    const toolSupports = tool ? this.toolSupportsBlendMode(tool) : true;

    if (allowComplex && toolSupports) {
      section.style.display = 'block';
      this.refreshToolOptionsLayout(tool);
      return false;
    }

    section.style.display = 'none';
    this.refreshToolOptionsLayout(tool);

    if (allowComplex) {
      return false;
    }

    const select = this.elements.blendModeSelect;
    if (select && select.value !== 'source-over') {
      this._updatingBlendMode = true;
      select.value = 'source-over';
      this._updatingBlendMode = false;
      return true;
    }
    return false;
  }

  /**
   * Updates the local user's color in the user list.
   * @param {Array} color - [r, g, b, a] color array
   */
  updateSelfColor(color) {
    this.elements.selfListColor.style.backgroundColor = `rgba(${color.join(',')})`;
  }

  /**
   * Updates the local text input preview.
   * @param {string} text - Current text input
   */
  updateSelfTextInput(text) {
    this.elements.selfTextInput.textContent = getPreviewTextContent(text);
  }

  /**
   * Updates the local username display.
   * @param {string} name - New username
   */
  updateSelfName(name) {
    this.elements.selfName.textContent = name;
    this.elements.selfListUser.textContent = name;
  }

  /**
   * Updates the local user's account badges in the user list.
   * @param {Object} userData - Local user/auth state.
   */
  updateSelfBadges(userData = window.app?.self) {
    const badgeEl = this.elements.selfUserBadges;
    if (!badgeEl) return;
    renderBadgesInto(badgeEl, badgesForUser(userData));
  }

  setSelfUserMuted(muted) {
    const entry = this.elements.selfUserEntry;
    const userEl = this.elements.selfListUser;
    if (entry) entry.classList.toggle('muted', !!muted);
    if (userEl) userEl.classList.toggle('muted', !!muted);
  }

  /**
   * Updates the local tool icon in the user list.
   * @param {string} tool - Current tool name
   */
  updateSelfToolIcon(tool) {
    const { selfListTool } = this.elements;
    if (selfListTool) {
      selfListTool.innerHTML = '';
      const afk = !!window.app?.self?.afk;
      const iconData = (afk && this.icons.afk) ? this.icons.afk : (this.icons[tool] || this.icons.brush);
      if (!iconData) return;

      if (iconData.type === 'svg') {
        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'toolIcon'; // Apply class for consistent styling
        svgWrapper.innerHTML = iconData.content;
        selfListTool.appendChild(svgWrapper);
      } else if (iconData.type === 'img') {
        selfListTool.appendChild(iconData.element.cloneNode(true)); // Clone the pre-created img element
      }
    }
  }

  setSelfUserAfk(afk) {
    const entry = this.elements.selfUserEntry;
    const userEl = this.elements.selfListUser;
    const opacity = afk ? '0.5' : '1';
    if (entry) entry.style.opacity = opacity;
    if (userEl) userEl.style.opacity = opacity;
    this.updateSelfToolIcon(window.app?.self?.tool || 'brush');
  }

  /**
   * Updates the local floating text cursor style.
   * @param {number} size - Font size
   * @param {Array} color - [r, g, b, a] color array
   * @param {string} font - CSS font-family string
   */
  updateSelfTextStyle(size, color, font) {
    const layout = getPreviewTextLayout({
      size,
      x: 0,
      y: 0
    });
    const normalizedFont = normalizeTextFont(font);
    const lineHeight = getTextLineHeight(layout.fontSize, normalizedFont);
    this.elements.selfText.style.fontSize = `${layout.fontSize}px`;
    this.elements.selfText.style.lineHeight = `${lineHeight}px`;
    const [r, g, b, a] = color;
    this.elements.selfText.style.color = `rgba(${r}, ${g}, ${b}, ${a * a})`;
    this.elements.selfText.style.fontFamily = getTextFontStack(normalizedFont);
    this.elements.selfText.style.letterSpacing = getTextFontLetterSpacing(normalizedFont);
    if (this.elements.selfTextInput) {
      this.elements.selfTextInput.style.fontFamily = getTextFontStack(normalizedFont);
      this.elements.selfTextInput.style.lineHeight = `${lineHeight}px`;
      this.elements.selfTextInput.style.letterSpacing = getTextFontLetterSpacing(normalizedFont);
    }
    this.elements.selfText.style.left = `${layout.domLeft}px`;
    this.elements.selfText.style.top = `${layout.domTop}px`;
  }

  /**
   * Updates the mix-blend-mode on the floating text cursor preview.
   * @param {string} cssBlendMode - CSS mix-blend-mode value
   */
  updateTextPreviewBlendMode(cssBlendMode) {
    if (this.elements.selfText) {
      this.elements.selfText.style.mixBlendMode = cssBlendMode;
    }
  }

  /**
   * Move and focus the hidden touch input to trigger virtual keyboard.
   * @param {number} x - Client X
   * @param {number} y - Client Y
   */
  activateTouchInput(x, y) {
    const input = this.elements.touchInput;
    if (!input) return;

    input.style.left = `${x}px`;
    input.style.top = `${y}px`;
    input.value = ' ';
    input.style.pointerEvents = 'auto';
    
    setTimeout(() => {
      input.focus();
      setTimeout(() => {
        input.style.pointerEvents = 'none';
      }, 500);
    }, 10);
  }

  /**
   * Sets the image brush preview source.
   * @param {string} url - Image data URL
   */
  setBrushPreview(url) {
    if (this.elements.brushImage) {
      this.elements.brushImage.src = url;
      this.elements.brushImage.style.display = 'block';
    }
    appState.toolPreviewMode = 'imageBrush';
    appState.toolPreviewVisible = !!url;
    window.app?.toolManager?.getTool('imageBrush')?.updatePreview?.(window.app?.self);
  }

  /**
   * Updates the tool size value display.
   * @param {number} size - Current size
   */
  updateSizeValue(size) {
    if (this.elements.sizeValue) {
      this.elements.sizeValue.textContent = String(Number(size.toFixed(2)));
    }
  }

  /**
   * Updates the pressure sensitivity range display.
   * @param {number} min - Minimum pressure scale
   * @param {number} [max] - Maximum pressure scale
   */
  updatePressureValue(min, max) {
    if (this.elements.pressureValue) {
      if (max === undefined) {
        this.elements.pressureValue.textContent = `0-${min}`;
      } else {
        this.elements.pressureValue.textContent = `${min}-${max}`;
      }
    }
    this.refreshPressureTrack();
  }

  /**
   * Updates the smoothing factor display.
   * @param {number} smoothing - Smoothing value
   */
  updateSmoothingValue(smoothing) {
    if (this.elements.smoothingValue) {
      this.elements.smoothingValue.textContent = Math.round(smoothing);
    }
    if (this.elements.smoothingSlider) {
      this.elements.smoothingSlider.value = smoothing;
    }
  }

  /**
   * Updates the brush spacing factor display.
   * @param {number} spacing - Spacing value
   */
  updateSpacingValue(spacing) {
    if (this.elements.spacingValue) {
      this.elements.spacingValue.textContent = Math.round(spacing);
    }
    if (this.elements.spacingSlider) {
      this.elements.spacingSlider.value = spacing;
    }
  }

  /**
   * Updates the brush hardness factor display.
   * @param {number} hardness - Hardness value
   */
  updateHardnessValue(hardness) {
    if (this.elements.hardnessValue) {
      this.elements.hardnessValue.textContent = Math.round(hardness);
    }
    if (this.elements.hardnessSlider) {
      this.elements.hardnessSlider.value = hardness;
    }
  }

  /**
   * Updates the blur radius value display.
   * @param {number} radius - Blur radius
   */
  updateBlurRadiusValue(radius) {
    if (this.elements.blurRadiusValue) {
      this.elements.blurRadiusValue.textContent = radius;
    }
    if (this.elements.blurRadiusSlider) {
      this.elements.blurRadiusSlider.value = radius;
    }
  }

  /**
   * Updates the tool opacity value display.
   * @param {number} opacity - Opacity (0-1)
   */
  updateOpacityValue(opacity) {
    if (this.elements.opacityValue) {
      this.elements.opacityValue.textContent = Math.round(opacity * 100);
    }
    if (this.elements.opacitySlider) {
      this.elements.opacitySlider.value = opacity * 100;
    }
  }

  /**
   * Updates the ink thinning value display.
   * @param {number} thinning - Thinning value (0-100)
   */
  updateThinningValue(thinning) {
    if (this.elements.thinningValue) {
      this.elements.thinningValue.textContent = thinning;
    }
    if (this.elements.thinningSlider) {
      this.elements.thinningSlider.value = thinning;
    }
  }

  /**
   * Updates the simulate pressure checkbox state.
   * @param {boolean} simulate - Whether simulate pressure is enabled.
   */
  updateSimulatePressure(simulate) {
    if (this.elements.thinningEnabled) {
      this.elements.thinningEnabled.checked = simulate;
    }
    this.setThinningTrackVisible(simulate);
  }

  /**
   * Shows or hides the Thinning track and its value.
   *
   * With thinning off there is no track left to host the in-track label, and
   * the label is absolutely positioned - so the row collapsed to zero height
   * and the toggle painted on top of Pressure. `.no-track` puts the label back
   * in flow so the row keeps a row's worth of height either way.
   *
   * @param {boolean} visible - Whether thinning is enabled.
   */
  setThinningTrackVisible(visible) {
    if (this.elements.thinningSliderContainer) {
      this.elements.thinningSliderContainer.style.display = visible ? '' : 'none';
    }
    if (this.elements.thinningValue) {
      this.elements.thinningValue.style.display = visible ? '' : 'none';
    }
    if (this.elements.thinningRow) {
      this.elements.thinningRow.classList.toggle('no-track', !visible);
    }
  }

  /**
   * Shows or hides the Pressure track and its value.
   *
   * Same collapse as Thinning: with the dual slider hidden there is no track
   * left under the absolutely positioned label, so the row collapses to zero
   * height and overlaps Smoothing below it. `.no-track` puts the label back
   * in flow so the row keeps a row's worth of height either way.
   *
   * @param {boolean} visible - Whether pressure is enabled.
   */
  setPressureTrackVisible(visible) {
    if (this.elements.pressureDualSlider) {
      this.elements.pressureDualSlider.style.display = visible ? '' : 'none';
    }
    if (this.elements.pressureValue) {
      this.elements.pressureValue.style.display = visible ? '' : 'none';
    }
    if (this.elements.pressureContainer) {
      this.elements.pressureContainer.classList.toggle('no-track', !visible);
    }
  }

  /**
   * Updates the lock/unlock state of a tool property button.
   * @param {string} property - Property name
   * @param {boolean} locked - Whether it's locked
   * @param {boolean} [visible=true] - Whether the lock button should be shown
   */
  updateLockButton(property, locked, visible = true) {
    const btn = this.elements[`${property}Lock`];
    if (!btn) return;

    btn.style.display = visible ? 'inline-block' : 'none';
    
    // Use preloaded SVG content from cache
    const cachedIcon = locked ? this.svgCache.get('lockClosed') : this.svgCache.get('lockOpen');
    if (cachedIcon && cachedIcon.type === 'svg') {
      btn.innerHTML = cachedIcon.content;
    } else {
      // Fallback
      btn.innerHTML = locked ? '<img src="../images/lock-closed.svg" alt="lock">' : '<img src="../images/lock-open.svg" alt="unlock">';
    }

    btn.classList.toggle('locked', locked);
    btn.title = locked
      ? `Unlock ${property} for current tool. Shift-click to unlock all current tool settings`
      : `Lock ${property} for current tool. Shift-click to lock all current tool settings`;
  }

  /**
   * Delegate making an element editable to EditableValueHandler.
   * @param {HTMLElement} spanEl - Element to make editable
   * @param {Object} opts - Configuration options
   */
  makeValueEditable(spanEl, opts) {
    return this.editableHandler.makeEditable(spanEl, opts);
  }

  /**
   * Attaches an event listener to the font selection dropdown.
   * @param {App} app - Reference to the main App instance
   */
  attachFontChangeListener(app) {
    this.elements.fontSelect?.addEventListener('change', (e) => {
      this._applyFontSelectStyle(e.target.value);
      app.handleFontChange(e.target.value);
    });
    this.elements.textTemporaryToggle?.addEventListener('change', (e) => {
      app.setTextRenderMode?.(e.target.checked ? 'vector' : 'pixel');
    });
  }

  /**
   * Updates the selected font in the dropdown.
   * @param {string} font - The font family string to set as selected
   */
  updateFontSelect(font) {
    if (this.elements.fontSelect) {
      const normalizedFont = normalizeTextFont(font);
      this.elements.fontSelect.value = normalizedFont;
      this._applyFontSelectStyle(normalizedFont);
    }
  }

  updateRemoteFont(userId, font) {
    return this.remoteUserUI?.updateRemoteFont(userId, font);
  }

  updateRemoteTextLayout(userId, user) {
    return this.remoteUserUI?.updateRemoteTextLayout(userId, user);
  }

  updateTextPositionMultiplierValue(multiplier) {
    if (this.elements.textPositionMultiplierValue) {
      this.elements.textPositionMultiplierValue.textContent = Number(multiplier).toFixed(2);
    }
    if (this.elements.textPositionMultiplierSlider) {
      this.elements.textPositionMultiplierSlider.value = Number(multiplier);
    }
  }

  updateTextPositionOffsetValue(offset) {
    if (this.elements.textPositionOffsetValue) {
      const rounded = Math.round(Number(offset) * 100) / 100;
      this.elements.textPositionOffsetValue.textContent = rounded;
    }
    if (this.elements.textPositionOffsetSlider) {
      this.elements.textPositionOffsetSlider.value = Number(offset);
    }
  }

  updateTextRenderMode(mode) {
    const isPixel = mode === 'pixel';
    if (this.elements.textTemporaryToggle) {
      this.elements.textTemporaryToggle.checked = !isPixel;
    }
  }

  _initializeFontSelect() {
    const select = this.elements.fontSelect;
    if (!select) return;

    ensureTextFontsLoaded(document);

    // Each row previews its own typeface, as the native <select> did. Rows get a
    // fixed, slightly taller height (rather than the dropdown default) so the
    // bigger script faces (Tangerine, Great Vibes) don't get vertically clipped
    // by their neighbors — the shared .dd-option height is too short for them.
    select.setOptions?.(TEXT_FONT_OPTIONS.map(font => ({
      value: font.family,
      label: font.label,
      style: `font-family:${font.family};font-size:${font.pickerFontSize ?? 12}px`,
      rowStyle: 'height:38px;padding:0 6px;'
    })));

    select.value = DEFAULT_TEXT_FONT;
    this._applyFontSelectStyle(DEFAULT_TEXT_FONT);
  }

  _applyFontSelectStyle(font) {
    const select = this.elements.fontSelect;
    if (!select) return;

    const normalizedFont = normalizeTextFont(font);
    const fontOption = TEXT_FONT_OPTIONS.find(option => option.family === normalizedFont);
    // .dd-trigger.s-sm hardcodes its own font-size, so setting it directly on
    // this wrapper div (plain inheritance) has no effect on the visible label —
    // go through the --dd-preview-* custom properties .dd-label reads instead.
    select.style.setProperty('--dd-preview-family', normalizedFont);
    select.style.setProperty('--dd-preview-size', `${fontOption?.pickerFontSize ?? 12}px`);
  }

  hideRemoteCursor(userId) {
    return this.remoteUserUI.hideRemoteCursor(userId);
  }

  showRemoteCursor(userId) {
    return this.remoteUserUI.showRemoteCursor(userId);
  }

  markRemoteCursorActivity(userId) {
    return this.remoteUserUI.markRemoteCursorActivity(userId);
  }

  setRemoteUsersConnected(connected) {
    return this.remoteUserUI?.setRemoteUsersConnected(connected);
  }
  
  /**
   * Toggles the collapsible toolbar menu.
   */
  toggleMenu() {
    const menu = this.elements.collapsibleBtns;
    if (menu) {
      menu.classList.toggle('show');
    }
  }

  /**
   * Closes the collapsible toolbar menu.
   */
  closeMenu() {
    const menu = this.elements.collapsibleBtns;
    if (menu) {
      menu.classList.remove('show');
    }
  }

  /**
   * Toggles the tool options sidebar.
   * @returns {boolean} - New collapsed state
   */
  toggleSidebar() {
    const toolOptions = this.elements.toolOptions;
    const btn = this.elements.sidebarToggleBtn;
    if (toolOptions) {
      const isCollapsed = toolOptions.classList.toggle('collapsed');
      if (btn) btn.classList.toggle('active', isCollapsed);
      if (btn) btn.title = isCollapsed ? 'Show tool options' : 'Hide tool options';
      return isCollapsed;
    }
    return false;
  }

  /**
   * Force sets the sidebar collapsed state.
   * @param {boolean} collapsed - Target collapsed state
   */
  setSidebarCollapsed(collapsed) {
    const toolOptions = this.elements.toolOptions;
    const btn = this.elements.sidebarToggleBtn;
    if (toolOptions) {
      toolOptions.classList.toggle('collapsed', collapsed);
      if (btn) btn.classList.toggle('active', collapsed);
      if (btn) btn.title = collapsed ? 'Show tool options' : 'Hide tool options';
    }
  }

  createRemoteUser(userId, userData) {
    return this.remoteUserUI.createRemoteUser(userId, userData);
  }

  createUserBoard(userId) {
    return this.remoteUserUI.createUserBoard(userId);
  }

  createUserListEntry(userId, userData) {
    return this.remoteUserUI.createUserListEntry(userId, userData);
  }

  updateRemoteCursor(userId, x, y, size) {
    return this.remoteUserUI.updateRemoteCursor(userId, x, y, size);
  }

  updateRemoteToolDisplay(userId, tool) {
    this.remoteUserUI.updateRemoteToolDisplay(userId, tool);
    this.remoteUserUI.updateRemoteToolIcon(userId, tool);
  }

  updateRemoteSize(userId, size) {
    return this.remoteUserUI.updateRemoteSize(userId, size);
  }

  updateRemoteColor(userId, color) {
    return this.remoteUserUI.updateRemoteColor(userId, color);
  }

  updateRemoteName(userId, name) {
    return this.remoteUserUI.updateRemoteName(userId, name);
  }

  updateRemoteBadges(userId, userData) {
    return this.remoteUserUI?.updateRemoteBadges(userId, userData);
  }

  updateRemoteText(userId, textContent) {
    return this.remoteUserUI?.updateRemoteText(userId, textContent);
  }

  setRemoteTextDomVisible(userId, visible) {
    return this.remoteUserUI?.setRemoteTextDomVisible(userId, visible);
  }

  setRemoteUserAfk(userId, afk) {
    return this.remoteUserUI?.setRemoteUserAfk(userId, afk);
  }

  setRemoteUserMuted(userId, muted) {
    return this.remoteUserUI.setRemoteUserMuted(userId, muted);
  }

  setRemoteUserShadowBanned(userId, shadowBanned) {
    return this.remoteUserUI.setRemoteUserShadowBanned(userId, shadowBanned);
  }

  setRemoteUserSupporter(userId, isSupporter) {
    return this.remoteUserUI?.setRemoteUserSupporter(userId, isSupporter);
  }

  /**
   * Toggle supporter gold styling on the local user's own cursor and name label.
   * @param {boolean} isSupporter - Whether the local user is an active supporter
   */
  setSelfSupporter(isSupporter) {
    const on = !!isSupporter;
    for (const el of [
      this.elements.selfCircle,
      this.elements.selfSquare,
      this.elements.selfCrosshair,
      this.elements.selfName
    ]) {
      el?.classList.toggle('supporter', on);
    }
  }

  removeRemoteUser(userId) {
    return this.remoteUserUI.removeRemoteUser(userId);
  }

  getRemoteUserBoard(userId) {
    return this.remoteUserUI.getRemoteUserBoard(userId);
  }

  /**
   * Shows a toast notification.
   * @param {string} message - Notification message
   * @param {number} [duration=2000] - Duration in ms
   * @param {string} [type=''] - Toast type (e.g., 'error')
   */
  showToast(message, duration = 2000, type = '') {
    const toast = this.elements.toast;
    if (!toast) return;

    if (this._toastTimeout) {
      clearTimeout(this._toastTimeout);
    }

    toast.classList.remove('error', 'global');
    if (type === 'global') {
      toast.textContent = '';
      const badge = document.createElement('span');
      badge.className = 'toast__badge';
      badge.textContent = 'GLOBAL MESSAGE';
      const text = document.createElement('span');
      text.className = 'toast__text';
      text.textContent = message;
      toast.appendChild(badge);
      toast.appendChild(text);
      toast.classList.add('global');
    } else {
      toast.textContent = message;
      if (type === 'error') toast.classList.add('error');
    }
    toast.classList.add('show');

    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('show', 'error', 'global');
    }, duration);
  }

  confirm(message, options = {}) {
    return showAppConfirm(message, options);
  }

  /**
   * Actionable toast for stroke-log parity mismatches. Mirrors the snapshot
   * join toast style so the existing .snapshotJoinToast CSS handles layout.
   * @param {{percent: number, missing: number, extra: number, mismatched: number}} info
   * @param {Function} onFix - Click handler for the "Fix" button
   */
  showParityFixToast(info, onFix) {
    this._dismissParityFixToast();

    const el = document.createElement('div');
    el.className = 'snapshotJoinToast';

    const detail = [];
    if (info.missing) detail.push(`${info.missing} missing`);
    if (info.extra) detail.push(`${info.extra} extra`);
    if (info.mismatched) detail.push(`${info.mismatched} mismatched`);
    const detailLine = detail.length ? detail.join(' · ') : 'log drift detected';

    el.innerHTML = `
      <div class="snapshotJoinToast__body">
        <div class="snapshotJoinToast__title">Out of sync (${info.percent.toFixed(1)}%)</div>
        <div class="snapshotJoinToast__meta">${detailLine}</div>
        <div class="snapshotJoinToast__actions">
          <button class="snapshotJoinToast__load btn primary small">Fix</button>
          <button class="snapshotJoinToast__dismiss btn secondary small">Dismiss</button>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    this._parityFixToastEl = el;

    const dismiss = () => this._dismissParityFixToast();
    el.querySelector('.snapshotJoinToast__load').addEventListener('click', () => {
      dismiss();
      try { onFix?.(); } catch (e) { console.error('[ParityFix] onFix threw', e); }
    });
    el.querySelector('.snapshotJoinToast__dismiss').addEventListener('click', dismiss);

    clearTimeout(this._parityFixToastTimeout);
    this._parityFixToastTimeout = setTimeout(dismiss, 8000);

    requestAnimationFrame(() => el.classList.add('show'));
  }

  _dismissParityFixToast() {
    clearTimeout(this._parityFixToastTimeout);
    const el = this._parityFixToastEl;
    if (!el) return;
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
    this._parityFixToastEl = null;
  }

  /**
   * One-time prompt inviting eligible users to try the gallery time-lapse
   * feature. Mirrors the .snapshotJoinToast styling. Persists until answered or
   * the user dismisses it (default stays on — see App._maybeShowTimelapsePrompt).
   * @param {Function} onEnable
   * @param {Function} onDecline
   */
  showTimelapsePromptToast(onEnable, onDecline) {
    if (this._timelapsePromptEl) return;

    const el = document.createElement('div');
    el.className = 'snapshotJoinToast snapshotJoinToast--wrap';
    el.innerHTML = `
      <div class="snapshotJoinToast__body">
        <div class="snapshotJoinToast__title">Try gallery time-lapse?</div>
        <div class="snapshotJoinToast__meta">Your gallery uploads can include an animated time-lapse of your drawing. It's on by default; you can change this anytime in Settings.</div>
        <div class="snapshotJoinToast__actions">
          <button class="snapshotJoinToast__load btn primary small">Sounds good</button>
          <button class="snapshotJoinToast__dismiss btn secondary small">No thanks</button>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    this._timelapsePromptEl = el;

    const dismiss = () => {
      const node = this._timelapsePromptEl;
      if (!node) return;
      node.classList.remove('show');
      setTimeout(() => node.remove(), 400);
      this._timelapsePromptEl = null;
    };

    el.querySelector('.snapshotJoinToast__load').addEventListener('click', () => {
      dismiss();
      try { onEnable?.(); } catch (e) { console.error('[Timelapse] onEnable threw', e); }
    });
    el.querySelector('.snapshotJoinToast__dismiss').addEventListener('click', () => {
      dismiss();
      try { onDecline?.(); } catch (e) { console.error('[Timelapse] onDecline threw', e); }
    });

    requestAnimationFrame(() => el.classList.add('show'));
  }

  /**
   * Actionable toast confirming a file was saved. When `onReveal` is provided
   * (desktop only — browser downloads don't expose a path to open), an "Open
   * file location" button reveals the file in the OS file manager. Reuses the
   * .snapshotJoinToast styling.
   * @param {string} message - e.g. "Time-lapse saved (12.3 MB)"
   * @param {{ onReveal?: (() => void)|null }} [opts]
   */
  showSavedFileToast(message, { onReveal = null } = {}) {
    this._dismissSavedFileToast();

    const el = document.createElement('div');
    el.className = 'snapshotJoinToast';

    const revealBtnHtml = onReveal
      ? '<button class="savedFileToast__reveal btn primary small">Open file location</button>'
      : '';
    el.innerHTML = `
      <div class="snapshotJoinToast__body">
        <div class="snapshotJoinToast__title">File saved</div>
        <div class="snapshotJoinToast__meta"></div>
        <div class="snapshotJoinToast__actions">
          ${revealBtnHtml}
          <button class="savedFileToast__dismiss btn secondary small">Dismiss</button>
        </div>
      </div>
    `;
    // Set the message via textContent so a filename/size can't inject markup.
    el.querySelector('.snapshotJoinToast__meta').textContent = message;

    document.body.appendChild(el);
    this._savedFileToastEl = el;

    const dismiss = () => this._dismissSavedFileToast();
    const revealBtn = el.querySelector('.savedFileToast__reveal');
    if (revealBtn) {
      revealBtn.addEventListener('click', () => {
        dismiss();
        try { onReveal?.(); } catch (e) { console.error('[SavedFile] onReveal threw', e); }
      });
    }
    el.querySelector('.savedFileToast__dismiss').addEventListener('click', dismiss);

    clearTimeout(this._savedFileToastTimeout);
    this._savedFileToastTimeout = setTimeout(dismiss, 6000);

    requestAnimationFrame(() => el.classList.add('show'));
  }

  _dismissSavedFileToast() {
    clearTimeout(this._savedFileToastTimeout);
    const el = this._savedFileToastEl;
    if (!el) return;
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
    this._savedFileToastEl = null;
  }

  /**
   * Shows a centered blocking popup while an operation is in progress.
   * @param {string} [message='Saving...']
   */
  showSavingPopup(message = 'Saving...') {
    let popup = this._savingPopupEl;
    if (!popup) {
      popup = document.createElement('div');
      popup.className = 'savingPopup';

      const card = document.createElement('div');
      card.className = 'savingPopup__card';

      const spinner = document.createElement('div');
      spinner.className = 'savingPopup__spinner';
      spinner.setAttribute('aria-hidden', 'true');

      const text = document.createElement('div');
      text.className = 'savingPopup__text';
      text.textContent = message;

      card.append(spinner, text);
      popup.appendChild(card);
      document.body.appendChild(popup);
      this._savingPopupEl = popup;

      requestAnimationFrame(() => popup.classList.add('show'));
      return;
    }

    const text = popup.querySelector('.savingPopup__text');
    if (text) {
      text.textContent = message;
    }
  }

  /**
   * Hides the centered saving popup.
   */
  hideSavingPopup() {
    const popup = this._savingPopupEl;
    if (!popup) return;

    popup.classList.remove('show');
    popup.addEventListener('transitionend', () => popup.remove(), { once: true });
    setTimeout(() => popup.remove(), 250); // fallback if transitionend never fires
    this._savingPopupEl = null;
  }

  /**
   * Updates the global connection status indicator.
   * @param {string} state - Connection state string
   */
  showConnectionStatus(state, roomId = null) {
    const { connectionStatus, connectionText, connectionRoom } = this.elements;
    if (!connectionStatus) return;

    connectionStatus.style.display = 'flex';
    connectionStatus.className = `connectionStatus ${state}`;

    const labels = {
      connected: 'Connected',
      disconnected: 'Disconnected',
      connecting: 'Connecting...',
      offline: 'Drawing Alone'
    };
    connectionText.textContent = labels[state] || state;

    if (connectionRoom) {
      if (roomId && state === 'connected') {
        connectionRoom.textContent = roomId;
        connectionRoom.style.display = 'inline';
      } else {
        connectionRoom.style.display = 'none';
      }
    }
  }

  /**
   * Hides the connection status indicator.
   */
  hideConnectionStatus() {
    const { connectionStatus } = this.elements;
    if (connectionStatus) {
      connectionStatus.style.display = 'none';
    }
  }

  /**
   * Shows the disconnection warning banner.
   */
  showDisconnectionBanner(options = {}) {
    const { disconnectionBanner } = this.elements;
    console.log('[UI] showDisconnectionBanner called', { exists: !!disconnectionBanner });
    if (!disconnectionBanner) {
      console.error('[UI] disconnectionBanner element not found in DOM!');
      return;
    }

    this.configureDisconnectionBanner(options);
    disconnectionBanner.classList.add('show');
    this.setRetryButtonState(false);
    console.log('[UI] Banner should now be visible');
  }

  configureDisconnectionBanner(options = {}) {
    const {
      message = 'You have lost connection to the server',
      icon = '',
      retryLabel = 'Retry Connection',
      retryVisible = true,
      offlineLabel = 'Continue Offline',
      offlineVisible = true
    } = options;
    const { disconnectionBanner, retryConnectionBtn } = this.elements;
    if (!disconnectionBanner) return;

    const textEl = disconnectionBanner.querySelector('.disconnectionText');
    const iconEl = disconnectionBanner.querySelector('.disconnectionIcon');
    const offlineBtn = this.elements.switchToOfflineBtn || document.getElementById('switchToOfflineBtn');
    if (textEl) textEl.textContent = message;
    if (iconEl && icon) iconEl.textContent = icon;
    if (retryConnectionBtn) {
      retryConnectionBtn.dataset.defaultLabel = retryLabel;
      retryConnectionBtn.textContent = retryLabel;
      retryConnectionBtn.style.display = retryVisible ? '' : 'none';
    }
    if (offlineBtn) {
      offlineBtn.textContent = offlineLabel;
      offlineBtn.style.display = offlineVisible ? '' : 'none';
    }
  }

  /**
   * Hides the disconnection warning banner.
   */
  hideDisconnectionBanner() {
    const { disconnectionBanner } = this.elements;
    if (!disconnectionBanner) return;

    disconnectionBanner.classList.remove('show');
    this.setRetryButtonState(false); // Reset state when hiding
  }

  /**
   * Sets the retry button to loading or normal state.
   * @param {boolean} isRetrying - Whether currently retrying
   */
  setRetryButtonState(isRetrying) {
    const { retryConnectionBtn } = this.elements;
    if (!retryConnectionBtn) return;

    if (isRetrying) {
      retryConnectionBtn.textContent = 'Retrying...';
      retryConnectionBtn.disabled = true;
      retryConnectionBtn.classList.add('loading');
    } else {
      retryConnectionBtn.textContent = retryConnectionBtn.dataset.defaultLabel || 'Retry Connection';
      retryConnectionBtn.disabled = false;
      retryConnectionBtn.classList.remove('loading');
    }
  }
  
  /**
   * Updates a user's role badge in the user list.
   * @param {string} userId - User identifier
   * @param {number} role - Role level
   */
  updateUserRoleBadge(userId, role) {
    const id = `u${userId}`;
    const badge = document.querySelector(`.roleBadge.${id}`);
    if (!badge) return;

    badge.classList.remove('mod', 'admin');
    if (role >= 5) {
      badge.textContent = 'admin';
      badge.classList.add('admin');
      badge.style.display = '';
    } else if (role >= 4) {
      badge.textContent = 'mod';
      badge.classList.add('mod');
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  /**
   * Updates the self user entry's role styling in the user list.
   * @param {number} role - Role level (0-9)
   */
  updateSelfRole(role) {
    const el = this.elements.selfListUser;
    if (!el) return;

    const entry = el.closest('.userEntry');
    RemoteUserUI.applyRankClasses(el, entry, role);
  }

  /**
   * Updates a remote user's rank styling in the user list.
   * @param {number} sessionIndex
   * @param {number} role - Role level (0-9)
   */
  updateRemoteUserRank(sessionIndex, role) {
    const id = `u${sessionIndex}`;
    const listUser = document.querySelector(`.listUser.${id}`);
    const entry = document.querySelector(`.userEntry.${id}`);
    RemoteUserUI.applyRankClasses(listUser, entry, role);
    this.remoteUserUI?.syncGroupHeaderRank?.(sessionIndex);
  }
}
