<script>
  import { onMount } from 'svelte';
  import { appState } from '../../state.svelte.js';

  const FINISHED_KEY = 'tutorial_v1_finished';
  const STOPPED_KEY = 'tutorial_v1_stopped';
  const VISIT_MARKER_KEY = 'tutorial_v1_visit_marker';

  const steps = [
    {
      section: 'Basic Tutorial',
      title: 'Tweak Your Settings',
      target: '[data-tut="perf-settings"], #appSettingsBtn',
      text: 'Before you start drawing, you can open Settings to adjust your preferences. You can change the theme and keybinds in this menu.',
      actionTarget: '[data-tut="perf-settings"], #appSettingsBtn',
      actionLabel: 'Click Settings to review your setup, or press Next'
    },
    {
      section: 'Basic Tutorial',
      title: 'Setting Settings',
      target: '[data-tut="app-settings-dialog"], .app-settings-dialog',
      text: 'Change anything you want here. When you are done, press Next',
      skipIfMissing: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Brush Modes',
      target: '#brushGroup',
      text: 'Ink tapers like a calligraphy pen. Fluid lays down a smooth, painterly line that won\'t double-darken where it overlaps itself. Pixel stamps hard-edged squares for pixel art. Classic is the plain original brush with no extra shaping.',
      beforeEnter: () => window.app?.selectTool?.('ink')
    },
    {
      section: 'Basic Tutorial',
      title: 'Room Settings',
      target: '[data-tut="room-settings"], #roomSettingsBtn',
      text: 'Room settings appear for rooms you can edit, including unowned rooms created by this browser.',
      actionTarget: '[data-tut="room-settings"], #roomSettingsBtn',
      actionLabel: 'Click Room Settings to review the room, or press Next',
      when: () => canEditRoomSettings()
    },
    {
      section: 'Basic Tutorial',
      title: 'Setting Room Settings',
      target: '[data-tut="room-settings-dialog"], .room-settings-dialog',
      text: 'Set the room description, privacy, join policy, background, board size, and moderation behavior here.',
      when: () => canEditRoomSettings(),
      skipIfMissing: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Mirror Mode',
      target: '[data-tut="mirror"], #mirrorBtn',
      text: 'Mirror mode lets you create symmetrical drawing areas for patterns, faces, and shared layouts.',
      actionTarget: '[data-tut="mirror"], #mirrorBtn',
      actionLabel: 'Click Mirror to start drawing a mirror region'
    },
    {
      section: 'Basic Tutorial',
      title: 'Draw Mirror Region',
      target: '[data-tut="mirror"], #mirrorBtn',
      text: 'Drag to draw a mirror region on the canvas.',
      allowCanvas: true,
      actionLabel: 'The canvas is unlocked. Draw a mirror region, then press Next',
      mirrorDependent: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Edit Mirror Region',
      target: '[data-tut="mirror"], #mirrorBtn',
      text: 'To edit or remove a mirror region later, press the Mirror button again. It brings back the mirror controls so you can adjust or clear the region.',
      actionTarget: '[data-tut="mirror"], #mirrorBtn',
      actionLabel: 'Click Mirror again to review editing/removal controls, or press Next',
      allowCanvas: true,
      targetControl: true,
      mirrorDependent: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Mirror Region Controls',
      target: '[data-tut="mirror-region-controls"], [data-tut="mirror-region-panel"], #mirrorRegionPanel',
      text: 'Use the region controls to edit or remove the mirror region. Click Edit to change the mirror mode and guides, or X to remove the region from the canvas.',
      allowCanvas: true,
      targetControl: true,
      skipIfMissing: true,
      mirrorDependent: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Add View',
      target: '[data-tut="add-view"], .boardViewerLaunch',
      text: 'Add View opens a second viewport. Click it to see the board viewer now, or press Next to skip.',
      actionTarget: '[data-tut="add-view"], .boardViewerLaunch',
      actionLabel: 'Click Add View to continue'
    },
    {
      section: 'Basic Tutorial',
      title: 'Board View',
      target: '[data-tut="board-view-controls"], .boardViewer',
      text: 'Board View is a separate viewport you can pan, zoom, reset, or pop out onto another monitor.',
      skipIfMissing: true
    },
    {
      section: 'Basic Tutorial',
      title: 'User List',
      target: '[data-tut="user-list"], #userList',
      text: 'The user list shows who is present, their activity, and rank colors.'
    },
    {
      section: 'Basic Tutorial',
      title: 'Right-Click Menu',
      target: '[data-tut="context-menu"], #userContextMenu, #selfContextMenu',
      fallbackTarget: '[data-tut="user-list"], #userList',
      text: 'Right-click a user to see their profile, sync, spectate, or send a DM.',
      waitForTarget: true,
      actionLabel: 'Right-click yourself or another user, then press Next'
    },
    {
      section: 'Basic Tutorial',
      title: 'Ranks',
      target: '[data-tut="ranks-dialog"]',
      text: 'Room ranks and global ranks are separate. Global ranks can stack with room ranks, so a Noble can also be a room Mod or Admin.',
      beforeEnter: () => { appState.ranksDialogVisible = true; }
    },
    {
      section: 'Basic Tutorial',
      title: 'Layers & Blending',
      target: '[data-tut="layer-1"], .layer-btn[data-tut="layer-1"]',
      text: 'There are 3 layers by default. Blend modes are active only on layer 1. Select the blend mode drop down.',
      actionTarget: '[data-tut="layer-1"], .layer-btn[data-tut="layer-1"]',
      actionLabel: 'Click Layer 1, then press Next',
      // On mobile/touch the always-expanded layer list (target above) is
      // display:none - BoardMenu swaps in a collapsed .layer-dropdown-wrap
      // instead. Open it here so the step has something to spotlight; harmless
      // on desktop since that dropdown stays display:none there regardless.
      // Deferred a tick: BoardMenu closes boardMenuOpen on any click outside
      // .board-menu, and the click that navigates to this step (Next, a dot,
      // the mini switcher) is still bubbling to that document listener when
      // beforeEnter runs - setting it synchronously would open and
      // immediately re-close it within the same click.
      beforeEnter: () => { setTimeout(() => { appState.boardMenuOpen = 'layers'; }, 0); }
    },
    {
      section: 'Basic Tutorial',
      title: 'Blend Modes',
      target: '[data-tut="blend-mode"], .blend-btn',
      fallbackTarget: '[data-tut="layer-1"], .layer-btn[data-tut="layer-1"]',
      text: 'Blend modes change how new strokes combine with colour underneath them. Multiply darkens, Screen lightens, Add brightens, and Difference inverts against existing colour.',
      actionTarget: '[data-tut="blend-mode"], .blend-btn',
      actionLabel: 'Open the blend mode dropdown'
    },
    {
      section: 'Basic Tutorial',
      title: 'Blend Mode Types',
      target: '[data-tut="blend-bake-toggle"], .blend-bake-toggle',
      fallbackTarget: '.blend-dropdown, [data-tut="blend-mode"], .blend-btn',
      text: 'BG mode blends each stroke against the room background. Existing mode blends only where pixels already exist. Try switching between BG and Existing, then draw on the canvas to compare.',
      allowCanvas: true,
      targetControl: true,
      actionLabel: 'The canvas is unlocked for testing on this step'
    },
    {
      section: 'Basic Tutorial',
      title: 'History & Snapshots',
      target: '[data-tut="history"], .history-btn',
      text: 'History covers server snapshots you can preview, restore from, or upload selected regions from.',
      actionTarget: '[data-tut="history"], .history-btn',
      actionLabel: 'Click History to review snapshots, or press Next to skip'
    },
    {
      section: 'Basic Tutorial',
      title: 'Board History',
      target: '[data-tut="history-dialog"], .snapshot-panel',
      text: 'This panel lets you preview server snapshots, restore the board, or upload selected work.',
      skipIfMissing: true
    },
    {
      section: 'Basic Tutorial',
      title: 'Tool Locks',
      target: '[data-tut="locks"], .lockBtn, #sizeLock',
      targetAll: true,
      text: 'Tool locks save values per tool. You can shift click to lock or unlock all the settings on a tool. Blend modes also have a lock and some values are locked by default. ',
      beforeEnter: () => window.app?.selectTool?.('ink')
    },
    {
      section: 'Selection',
      title: 'The Selection Tool',
      target: '#selectBtn',
      text: 'The Selection Tool lets you isolate parts of your drawing to move, transform, or use as a mask.',
      awaitTool: 'select'
    },
    {
      section: 'Selection',
      title: 'Lasso vs Rectangle',
      target: '#selectionModeOptions',
      text: 'Choose between Lasso for freehand shapes or Rectangle for precise boxes. Switch between them here.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Making a Selection',
      target: '#boardContainer',
      text: 'Click and drag on the canvas to create your selection. The moving dashed line indicates the active area.',
      allowCanvas: true,
      actionLabel: 'Draw a selection on the canvas'
    },
    {
      section: 'Selection',
      title: 'The Selection Menu',
      target: '#selectionMenu',
      text: 'Once you have a selection, this floating menu appears. It follows your selection and provides quick access to actions like Mask, Clone, Brush, and Obscure.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Moving & Transforming',
      target: '#selectionMenu',
      text: 'Move the selection by dragging it. Use the white corner handles to resize, the top handle to rotate, and the teal handles for perspective warping.',
      allowCanvas: true,
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Draw another selection',
      target: '#boardContainer',
      text: 'Draw a new selection on the canvas. Notice how the previous selection is replaced automatically. We will use this one to explore advanced actions like Clone and Obscure.',
      allowCanvas: true,
      actionLabel: 'Draw a new selection on the canvas'
    },
    {
      section: 'Selection',
      title: 'Clone Selection',
      target: '#selMenuClone',
      text: 'The Clone button creates a floating copy of your selection. You can move and stamp this copy multiple times without affecting the original pixels until you apply it.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Mask Mode',
      target: '#selMenuMask',
      text: 'Toggle Mask mode to lock the selection in place. Your strokes will only appear inside the selected area, allowing for precise coloring.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Use as Brush',
      target: '#selMenuBrush',
      text: 'The Brush button lets you turn your current selection into a custom image brush stamp.',
      skipIfMissing: true
    },
    {
      section: 'Selection',
      title: 'Obscure Content',
      target: '#selMenuObscure',
      text: 'The Obscure action hides the selected area behind a blur until other users click to reveal it. Useful for spoilers or hidden details.',
      skipIfMissing: true
    },
    {
      section: 'Advanced Tools',
      title: 'Text Tool',
      target: '#textBtn',
      text: 'The Text tool lets you place text on the canvas. Click anywhere on the board to start typing. Clicking or pressing enter with no text entered swaps you back to your previous tool.',
      beforeEnter: () => window.app?.selectTool?.('text')
    },
    {
      section: 'Advanced Tools',
      title: 'Text Shortcuts',
      target: '#textBtn',
      text: 'While typing: Enter commits the text to the board, Shift+Enter starts a new line within the same text block, and Ctrl+Backspace deletes a whole word at a time.',
      allowCanvas: true,
      actionLabel: 'Try placing text on the canvas, then press Next'
    },
    {
      section: 'Advanced Tools',
      title: 'Fonts',
      target: '#font-container',
      text: 'Have a look at the fonts available in the tool options and pick one that you like best!',
      beforeEnter: () => window.app?.selectTool?.('text'),
      allowCanvas: true,
      targetControl: true,
      skipIfMissing: true
    },
    {
      section: 'Advanced Tools',
      title: 'Flood Fill',
      target: '#fillBtn',
      text: 'Flood Fill replaces a connected region of similar colour with a single click.',
      awaitTool: 'fill'
    },
    {
      section: 'Advanced Tools',
      title: 'Draw a Circle to Fill',
      target: '#circleBtn',
      text: 'First, let\'s give the fill something to work with. The Circle tool is now active: draw a circle on the canvas, then press Next.',
      beforeEnter: () => window.app?.selectTool?.('circle'),
      allowCanvas: true,
      actionLabel: 'Draw a circle on the canvas, then press Next'
    },
    {
      section: 'Advanced Tools',
      title: 'Advanced Fill',
      target: '#fillModeOptions',
      text: 'Switching back to Fill. Enable Advanced, then click and DRAG inside your circle: move up/down to increase or decrease the blur of the fill edge, and left/right to expand or contract the fill area.',
      beforeEnter: () => window.app?.selectTool?.('fill'),
      allowCanvas: true,
      targetControl: true,
      skipIfMissing: true
    },
    {
      section: 'Advanced Tools',
      title: 'Glitch Blur',
      target: '#glitchBlurBtn',
      text: 'Glitch Blur smears and corrupts the pixels already on the canvas for a glitchy, data mosh effect.',
      awaitTool: 'glitchBlur'
    },
    {
      section: 'Advanced Tools',
      title: 'Try Glitch Blur',
      target: '#glitchBlurBtn',
      text: 'Drag across an area that already has artwork. The further you drag, the more the pixels smear and distort.',
      allowCanvas: true,
      actionLabel: 'Drag across the canvas to try it, then press Next'
    },
    {
      section: 'Advanced Tools',
      title: 'Pattern Brush',
      target: '#patternBtn',
      text: 'The Pattern Brush paints with a repeating image tile instead of a solid stroke.',
      awaitTool: 'pattern'
    },
    {
      section: 'Advanced Tools',
      title: 'Pattern Controls',
      target: '#patternModeOptions',
      text: 'Upload your own images or pick from the gallery. Tune Image Scale, Grid Rotation, and Grid Spacing for textile-like results. Switch Colour Mode to tint patterns with your current colour.',
      allowCanvas: true,
      skipIfMissing: true
    },
    {
      section: 'Replay',
      title: 'The Time Machine',
      target: '[data-tut="history"], .history-btn',
      text: 'Top Draw quietly keeps a timeline of everything drawn in the room - so you can scrub back through it, replay it, and even export it as a video. The History button opens the Time Machine: the Recent tab auto-plays the last couple of minutes, and Server history reconstructs much older states from room checkpoints.',
      actionTarget: '[data-tut="history"], .history-btn',
      actionLabel: 'Click History to open the Time Machine, or press Next'
    },
    {
      section: 'Replay',
      title: 'Scrub the Timeline',
      target: '[data-tut="replay-transport"], .rp-controls',
      fallbackTarget: '[data-tut="history-dialog"], .snapshot-panel',
      text: 'Every replay player shares these controls. Press play to watch the drawing rebuild itself, or drag the playhead to jump to any moment. The brackets at each end of the timeline trim playback to just the part you care about.',
      skipIfMissing: true
    },
    {
      section: 'Replay',
      title: 'Playback Speed',
      target: '[data-tut="replay-speed"], .rp-speed',
      fallbackTarget: '[data-tut="replay-transport"], .rp-controls',
      text: 'Speed up to 8× to skim a long session, or slow to 0.5× to study exactly how a stroke was made. Dead time between strokes is automatically compressed so replays stay watchable.',
      skipIfMissing: true
    },
    {
      section: 'Replay',
      title: 'Render a Time-lapse',
      target: '[data-tut="replay-render"]',
      fallbackTarget: '[data-tut="replay-transport"], .rp-controls',
      text: 'Render turns the replay into a shareable time-lapse. It opens a dialog where you pick the speed, frame rate, and whether to include cursors.',
      skipIfMissing: true
    },
    {
      section: 'Replay',
      title: 'Video or Frames',
      target: '[data-tut="render-dialog"], .dialog',
      text: 'Choose Video for a ready-to-post WebM clip, or Frames for an editable ZIP of PNGs (with optional transparency). The estimate shows how long the output will run before you commit to the render.',
      skipIfMissing: true
    },
    {
      section: 'Replay',
      title: 'Render Just a Region',
      target: '[data-tut="replay-region"]',
      fallbackTarget: '[data-tut="replay-transport"], .rp-controls',
      text: 'Select region lets you draw a box on the canvas and export only that part of the board.',
      skipIfMissing: true
    },
    {
      section: 'Replay',
      title: 'Save the Raw Replay',
      target: '[data-tut="replay-save"]',
      fallbackTarget: '[data-tut="replay-transport"], .rp-controls',
      text: 'Exporting the .ddraw file downloads the replay itself, not a video. Re-open a .ddraw file later to scrub, re-render, or restore from it. You can drag and drop a .ddraw file onto the app any time to view it.',
      skipIfMissing: true
    },
    {
      section: 'Replay',
      title: 'Rewind the Board',
      target: '[data-tut="replay-undo"]',
      fallbackTarget: '[data-tut="replay-transport"], .rp-controls',
      text: 'Undo to here rolls your board back to the moment you\'re viewing - and with a region selected, it rewinds only that area. On shared server replays this can restore the board for everyone, so use it carefully.',
      skipIfMissing: true
    },
    {
      section: 'Replay',
      title: 'Record a Longer Session',
      target: '#tapeRecBtn',
      text: 'Beyond the always-on timeline, you can also record a longer session by hand. The record button opens the Session Recorder.',
      actionTarget: '#tapeRecBtn',
      actionLabel: 'Click the record button to open the Session Recorder, or press Next'
    },
    {
      section: 'Replay',
      title: 'Session Recorder',
      target: '[data-tut="recorder-panel"], .rec-panel',
      text: 'The Session Recorder captures everything happening on your device into a local replay. Press Start recording, draw for a while, then Stop to open it in the player. Nothing is uploaded - the tape lives on your machine.',
      skipIfMissing: true
    },
    {
      section: 'Replay',
      title: 'Replay Settings',
      target: '[data-tut="replay-settings"]',
      text: 'In App Settings you can tune how much history is kept: the snapshot distance, the maximum manual recording length, and how long the always-on Recent tape rolls. Longer tapes use more memory.',
      beforeEnter: () => {
        appState.appSettingsVisible = true;
        appState.appSettingsTab = 'general';
        setTimeout(() => {
          document.querySelector('[data-tut="replay-settings"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 140);
      }
    }
  ];

  // Tutorial tracks. `key` matches each step's `section`; `label` is the short
  // chip text shown in the picker + mini switcher.
  const SECTIONS = [
    { key: 'Basic Tutorial', label: 'Basics', blurb: 'Settings, mirror, layers, blend modes & history.' },
    { key: 'Replay', label: 'Replay', blurb: 'Record, scrub, render time-lapses & rewind the board.' },
    { key: 'Selection', label: 'Selection', blurb: 'Lift, move, transform, mask & clone pixels.' },
    { key: 'Advanced Tools', label: 'Advanced', blurb: 'Text, flood fill, glitch blur & pattern brush.' }
  ];

  // Order tracks auto-continue in once one finishes (see `finish()`). Independent
  // of SECTIONS' display order in the picker/mini switcher.
  const FLOW_ORDER = ['Basic Tutorial', 'Selection', 'Advanced Tools', 'Replay'];

  // Friendly names for tools a step can wait on (see `awaitTool`).
  const TOOL_LABELS = {
    select: 'Selection',
    text: 'Text',
    fill: 'Fill',
    glitchBlur: 'Glitch Blur',
    pattern: 'Pattern',
    brush: 'Brush',
    pen: 'Pen',
    line: 'Line',
    rectangle: 'Rectangle',
    circle: 'Circle',
    erase: 'Eraser'
  };

  function toolLabel(tool) {
    return TOOL_LABELS[tool] || tool;
  }

  function sectionLabel(key) {
    return SECTIONS.find((section) => section.key === key)?.label || key || 'Tutorial';
  }

  let active = $state(false);
  let promptVisible = $state(false);
  // True for an `awaitTool` step only when the awaited tool was already active
  // as the step opened - suppresses the auto-advance so the user can read it.
  let awaitToolPreSatisfied = $state(false);
  let activeSection = $state(null);
  let index = $state(0);
  let rect = $state(null);
  let targetMissing = $state(false);
  let toastPosition = $state(null);
  let topbarBottom = $state(0);
  // Auto placement computed from the spotlighted target's rect (see
  // updateToastPlacement) - keeps the toast from covering whatever it's
  // pointing at, whether that's a small button or a large floating panel
  // (board viewer, mirror region panel, recorder panel, ...). null values
  // mean "no override, use the default top-of-screen position".
  let toastAutoTop = $state(null);
  let toastAutoBottom = $state(null);
  let toastAutoMaxHeight = $state(null);
  let dragState = null;
  let toastEl;
  let rafId = null;
  let mutationObserver = null;
  let preparedStep = null;
  let revealedTopbarMenu = null;
  let revealedToolGroups = new Set();
  let revealedMobileSidebar = false;

  let visibleSteps = $derived(steps.filter((step) => (!step.when || step.when()) && (!activeSection || step.section === activeSection)));
  let currentStep = $derived(visibleSteps[index] || visibleSteps[visibleSteps.length - 1]);
  let total = $derived(visibleSteps.length);
  let sections = $derived([...new Set(steps.filter(s => !s.when || s.when()).map((step) => step.section || 'Tutorial'))]);
  // The tracks that actually have at least one available step right now - used
  // to build the picker / switcher so empty tracks never show up.
  let availableSections = $derived(SECTIONS.filter((section) => sections.includes(section.key)));
  // The next track to auto-continue into once the current one finishes, or
  // null if this is the last track in FLOW_ORDER (or not part of the chain).
  let nextFlowSection = $derived.by(() => {
    const pos = FLOW_ORDER.indexOf(activeSection);
    if (pos < 0) return null;
    for (let i = pos + 1; i < FLOW_ORDER.length; i += 1) {
      if (sections.includes(FLOW_ORDER[i])) return FLOW_ORDER[i];
    }
    return null;
  });
  // An `awaitTool` step is "gated" until the user actually selects the tool it
  // teaches. Until then we spotlight the tool button and hold the lesson body.
  let awaitingTool = $derived(!!currentStep?.awaitTool && appState.currentTool !== currentStep.awaitTool);

  function canEditRoomSettings() {
    const roomData = appState.currentRoomData;
    if (!appState.connected || !appState.currentRoomId || !roomData) return false;
    if ((appState.selfGlobalRole || 0) >= 8) return true;
    return (roomData.ownerId && (appState.selfRoomRole || 0) >= 5) || (!roomData.ownerId && appState.roomCreatedByThisBrowser);
  }

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage can fail in private browsing; the tutorial should still run.
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage failures.
    }
  }

  function hasStorageKey(key) {
    return storageGet(key) !== null;
  }

  function isVisible(el) {
    if (!el) return false;
    // checkVisibility (with opacityProperty) walks ancestors, catching e.g. the
    // mobile tool options sidebar - it's laid out and `display:flex` even while
    // collapsed (opacity:0, pointer-events:none), so a plain display/visibility
    // check here would happily spotlight a control the user can't actually see.
    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
      } catch {
        // Fall through to the manual check below.
      }
    }
    const style = getComputedStyle(el);
    const bounds = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
  }

  function isToolGroupCollapsed(group) {
    const subgroup = group?.querySelector?.('.toolSubgroup');
    if (!subgroup) return false;
    // 'fixed' as well: App._positionToolFlyout re-anchors flyouts when the tool
    // rail clips. Expanded subgroups are static.
    return getComputedStyle(subgroup).position !== 'static';
  }

  function openTopbarMenuForTarget(target) {
    const menu = target?.closest?.('#collapsibleBtns');
    if (!menu || isVisible(target)) return;

    const menuButton = document.getElementById('menuBtn');
    const toolbar = menu.closest('.boardBtns');
    const canReveal = isVisible(menuButton) || toolbar?.classList.contains('force-menu-collapse');
    if (!canReveal) return;

    menu.classList.add('show');
    // On mobile the dropdown opens directly beneath the topbar - the same spot
    // the tutorial toast wants. Shrinking it (see .tutorial-shrink in
    // _toolbar.scss) leaves room so the toast (repositioned below the menu in
    // updateTopbarBottom) doesn't have to sit off-screen or on top of it.
    if (document.documentElement.dataset.mobile === 'true') {
      menu.classList.add('tutorial-shrink');
    }
    revealedTopbarMenu = menu;
  }

  function openToolGroupForTarget(target) {
    if (isVisible(target)) return;

    const subgroup = target?.closest?.('.toolSubgroup');
    const group = target?.closest?.('.toolGroup');
    if (!subgroup || !group || !isToolGroupCollapsed(group)) return;

    group.classList.remove('is-suppressed');
    group.classList.add('is-open');
    revealedToolGroups.add(group);
  }

  // On mobile the tool option controls (brush mode, sliders, locks, fill/
  // pattern/font panels, blend controls, ...) all live inside #toolOptions,
  // which MobileLayoutController keeps collapsed (opacity:0, pointer-events:
  // none - still laid out, so it isn't a no-op for isVisible without the
  // checkVisibility fix above) until the user taps the active tool again.
  // Open it for any step that targets something inside it, the same way a
  // spotlighted hamburger-menu item opens #collapsibleBtns.
  function openMobileSidebarForTarget(target) {
    const toolOptions = target?.closest?.('#toolOptions');
    if (!toolOptions || !toolOptions.classList.contains('collapsed')) return;
    window.app?.ui?.setSidebarCollapsed(false);
    revealedMobileSidebar = true;
  }

  function revealTargetContainers(step = currentStep) {
    const selectors = [step?.target, step?.fallbackTarget].filter(Boolean);
    for (const selector of selectors) {
      for (const target of document.querySelectorAll(selector)) {
        openTopbarMenuForTarget(target);
        openToolGroupForTarget(target);
        openMobileSidebarForTarget(target);
      }
    }
  }

  function cleanupRevealedContainers() {
    revealedTopbarMenu?.classList.remove('show', 'tutorial-shrink');
    revealedTopbarMenu = null;

    for (const group of revealedToolGroups) {
      group.classList.remove('is-open');
    }
    revealedToolGroups = new Set();

    if (revealedMobileSidebar) {
      window.app?.ui?.setSidebarCollapsed(true);
      revealedMobileSidebar = false;
    }
  }

  function findTargets(step = currentStep) {
    if (!step?.target) return null;
    revealTargetContainers(step);

    const matches = [];
    for (const primary of document.querySelectorAll(step.target)) {
      if (isVisible(primary)) matches.push(primary);
    }
    if (matches.length > 0) return step.targetAll ? matches : [matches[0]];
    if (step.fallbackTarget) {
      for (const fallback of document.querySelectorAll(step.fallbackTarget)) {
        if (isVisible(fallback)) return [fallback];
      }
    }
    return null;
  }

  function findTarget(step = currentStep) {
    return findTargets(step)?.[0] || null;
  }

  function cleanupStep(step) {
    cleanupRevealedContainers();

    if (step?.target?.includes('app-settings-dialog')) {
      appState.appSettingsVisible = false;
    }
    if (step?.target?.includes('room-settings-dialog')) {
      appState.roomSettingsVisible = false;
    }
    if (step?.target?.includes('history-dialog')) {
      appState.snapshotMenuVisible = false;
    }
    if (step?.target?.includes('ranks-dialog')) {
      appState.ranksDialogVisible = false;
    }
    if (step?.target?.includes('replay-settings')) {
      appState.appSettingsVisible = false;
    }
    if (step?.target?.includes('layer-1') && appState.boardMenuOpen === 'layers') {
      appState.boardMenuOpen = null;
    }
  }

  // Publishes the tutorial toast's live bottom edge as a CSS var + marks
  // <html> with data-tutorial-active, so other floating dialogs/menus (app
  // settings, room settings, ranks, history, render dialog, ...) can shrink
  // their own available space to render below the toast on mobile instead of
  // overlapping it - see the `[data-tutorial-active]` rules in each of those
  // components' styles.
  function updateTutorialCssVars() {
    const root = document.documentElement;
    if (!active || !toastEl) {
      root.style.removeProperty('--tutorial-toast-bottom');
      delete root.dataset.tutorialActive;
      return;
    }
    root.dataset.tutorialActive = 'true';
    const bottom = toastEl.getBoundingClientRect().bottom;
    root.style.setProperty('--tutorial-toast-bottom', `${Math.ceil(bottom)}px`);
  }

  function updateTopbarBottom() {
    const topbar = document.querySelector('.boardBtns');
    let bottom = topbar ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
    // If the tutorial revealed the hamburger dropdown (mirror/settings/save/
    // record/rooms), it opens in the same spot below the topbar the toast
    // wants - push the toast below the menu instead of overlapping it.
    if (revealedTopbarMenu && isVisible(revealedTopbarMenu)) {
      bottom = Math.max(bottom, revealedTopbarMenu.getBoundingClientRect().bottom);
    }
    topbarBottom = bottom;
  }

  function updateSpotlight() {
    if (!active) return;

    revealTargetContainers(currentStep);
    updateTopbarBottom();
    updateTutorialCssVars();

    // While an `awaitTool` step is still gated (tool not yet picked), keep the
    // spotlight on the tool button - not the canvas - so the user knows where
    // to click. Once they select it, the spotlight moves on like any other step.
    const gatedOnTool = !!currentStep?.awaitTool && appState.currentTool !== currentStep.awaitTool;
    const targets = currentStep?.allowCanvas && !currentStep?.targetControl && !gatedOnTool
      ? findTargets({ target: '#boardContainer, #boards, #board' })
      : findTargets();
    targetMissing = !!currentStep?.target && !targets;

    if (!targets) {
      rect = null;
    } else {
      const rects = targets.map((target) => target.getBoundingClientRect());
      const bounds = {
        top: Math.min(...rects.map((item) => item.top)),
        left: Math.min(...rects.map((item) => item.left)),
        right: Math.max(...rects.map((item) => item.right)),
        bottom: Math.max(...rects.map((item) => item.bottom))
      };
      bounds.width = bounds.right - bounds.left;
      bounds.height = bounds.bottom - bounds.top;
      const pad = 3;
      const top = Math.max(0, bounds.top - pad);
      const left = Math.max(0, bounds.left - pad);
      rect = {
        top,
        left,
        width: Math.min(window.innerWidth - left, bounds.width + pad * 2),
        height: Math.min(window.innerHeight - top, bounds.height + pad * 2)
      };
    }

    updateToastPlacement();
  }

  // Keeps the toast from covering whatever the current step is spotlighting.
  // Picks whichever side (below or above the target) has more room, docks the
  // toast there, and caps its height to that space - so a large floating
  // panel (board viewer, mirror region panel, recorder panel, a dialog that
  // isn't fully covered by the per-component overrides below, ...) always
  // has the toast sitting next to it rather than on top of it. Falls back to
  // the plain top-of-screen position when there's no target rect, or when
  // neither side has enough room to be usable (e.g. a near-fullscreen
  // dialog - those get their own space reserved via the
  // [data-tutorial-active] CSS rules instead, using --tutorial-toast-bottom).
  function updateToastPlacement() {
    toastAutoTop = null;
    toastAutoBottom = null;
    toastAutoMaxHeight = null;
    if (!rect) return;

    const gap = 10;
    const topBound = topbarBottom + 8;
    const bottomBound = window.innerHeight - 8;
    const spaceBelow = bottomBound - (rect.top + rect.height) - gap;
    const spaceAbove = rect.top - topBound - gap;
    const minUsable = 140;

    if (spaceBelow >= minUsable && spaceBelow >= spaceAbove) {
      toastAutoTop = Math.max(topBound, rect.top + rect.height + gap);
      toastAutoMaxHeight = Math.min(spaceBelow, 460);
    } else if (spaceAbove >= minUsable) {
      toastAutoBottom = Math.max(8, window.innerHeight - rect.top + gap);
      toastAutoMaxHeight = Math.min(spaceAbove, 460);
    }
    // else: neither side has room - leave all three null so the toast falls
    // back to its default top position.
  }

  function scheduleSpotlight() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateSpotlight();
    });
  }

  function stepIsAvailable(step) {
    if (!step?.skipIfMissing) return true;
    // A step with its own beforeEnter (e.g. one that switches tools to reveal
    // its target) hasn't run that setup yet when we're just scanning for the
    // next available step - checking its target here would always fail and
    // permanently skip the step. Trust beforeEnter to make it available once
    // it actually becomes current.
    if (step.beforeEnter) return true;
    return !!findTarget(step);
  }

  function isMirrorTutorialOpen() {
    return !!(
      window.app?.mirrorRegionController?.active ||
      findTarget({ target: '[data-tut="mirror-region-controls"]' }) ||
      findTarget({ target: '[data-tut="mirror-region-panel"], #mirrorRegionPanel' })
    );
  }

  function firstIndexPastMirrorSteps(startIndex = index) {
    for (let i = startIndex + 1; i < visibleSteps.length; i += 1) {
      if (!visibleSteps[i].mirrorDependent) return i;
    }
    return visibleSteps.length;
  }

  function moveToIndex(nextIndex) {
    let candidate = nextIndex;
    while (candidate < visibleSteps.length && !stepIsAvailable(visibleSteps[candidate])) {
      candidate += 1;
    }
    if (candidate >= visibleSteps.length) {
      finish();
      return;
    }
    // stepIsAvailable() above probes each skipped candidate's target via
    // findTarget(), which reveals containers (mobile sidebar, hamburger menu,
    // tool groups) as a side effect - clear those before landing on the real
    // step so a step skipped mid-scan doesn't leave e.g. the mobile tool
    // options sidebar stuck open. The real step's own reveal runs fresh via
    // scheduleSpotlight() below.
    cleanupRevealedContainers();
    index = candidate;
    scheduleSpotlight();
  }

  function next() {
    // If the user advances past an `awaitTool` step without having picked the
    // tool, select it for them so the following lesson steps (controls, canvas
    // tries) make sense. This is user-initiated, so it doesn't feel jarring.
    if (currentStep?.awaitTool && appState.currentTool !== currentStep.awaitTool) {
      window.app?.selectTool?.(currentStep.awaitTool);
    }
    cleanupStep(currentStep);
    if (index >= visibleSteps.length - 1) {
      finish();
      return;
    }
    if (currentStep?.title === 'Mirror Mode' && !isMirrorTutorialOpen()) {
      moveToIndex(firstIndexPastMirrorSteps());
      return;
    }
    moveToIndex(index + 1);
  }

  function back() {
    // Mirror next()/dot-nav: tear down anything the current step opened (e.g. the
    // App Settings dialog the Replay Settings step pops) before stepping back -
    // otherwise the dialog stays up and blocks the controls we return to.
    cleanupStep(currentStep);
    let candidate = Math.max(0, index - 1);
    while (candidate > 0 && !stepIsAvailable(visibleSteps[candidate])) {
      candidate -= 1;
    }
    // See moveToIndex() - clear any reveals left behind by probing skipped
    // candidates before landing on the real step.
    cleanupRevealedContainers();
    index = candidate;
    scheduleSpotlight();
  }

  function stop() {
    storageSet(STOPPED_KEY, 'true');
    cleanupStep(currentStep);
    cleanupRevealedContainers();
    promptVisible = false;
    active = false;
  }

  function finish() {
    if (nextFlowSection) {
      startTutorial(nextFlowSection);
      return;
    }
    storageSet(FINISHED_KEY, 'true');
    cleanupRevealedContainers();
    promptVisible = false;
    active = false;
  }

  function resetTutorial() {
    storageRemove(FINISHED_KEY);
    storageRemove(STOPPED_KEY);
    startTutorial();
  }

  function startTutorial(section = 'Basic Tutorial') {
    cleanupRevealedContainers();
    activeSection = section;
    index = 0;
    preparedStep = null;
    promptVisible = false;
    active = true;
    scheduleSpotlight();
  }

  function openPicker() {
    cleanupRevealedContainers();
    active = false;
    activeSection = null;
    promptVisible = true;
  }

  function startFromPrompt() {
    startTutorial('Basic Tutorial');
  }

  function skipFromPrompt() {
    stop();
  }

  function goToSection(section) {
    const nextIndex = visibleSteps.findIndex((step) => (step.section || 'Tutorial') === section);
    if (nextIndex < 0) return;
    index = nextIndex;
    scheduleSpotlight();
  }

  function maybeStart() {
    if (active || promptVisible || storageGet(FINISHED_KEY) || storageGet(STOPPED_KEY)) return;
    const landing = document.getElementById('landingPage');
    const board = document.getElementById('boardContainer');
    if (isVisible(board) && !isVisible(landing)) {
      storageSet(VISIT_MARKER_KEY, 'true');
      startTutorial('Basic Tutorial');
    }
  }

  function handleDocumentClick(event) {
    if (!active) return;
    const step = currentStep;
    if (!step?.actionTarget) return;
    if (event.target?.closest?.(step.actionTarget)) {
      setTimeout(next, 120);
    }
  }

  function isCanvasUnlocked() {
    return !!currentStep?.allowCanvas;
  }

  function shouldShowScrim() {
    return !currentStep?.targetControl;
  }

  function handleMirrorRegionApplied() {
    if (!active || currentStep?.title !== 'Draw Mirror Region') return;
    next();
  }

  function handleMirrorRegionRemoved() {
    if (!active || (currentStep?.section || 'Tutorial') !== 'Basic Tutorial') return;
    cleanupStep(currentStep);
    moveToIndex(firstIndexPastMirrorSteps());
  }

  function handleContextMenu() {
    if (!active || !currentStep?.waitForTarget) return;
    setTimeout(() => {
      updateSpotlight();
    }, 120);
  }

  function handleToastPointerDown(event) {
    if (event.target?.closest?.('button')) return;
    const toast = event.currentTarget;
    const bounds = toast.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top
    };
    toast.setPointerCapture(event.pointerId);
  }

  function handleToastPointerMove(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const width = Math.min(440, window.innerWidth - 24);
    const height = 210;
    toastPosition = {
      x: Math.min(Math.max(12, event.clientX - dragState.offsetX), Math.max(12, window.innerWidth - width - 12)),
      y: Math.min(Math.max(8, event.clientY - dragState.offsetY), Math.max(8, window.innerHeight - height - 8))
    };
  }

  function handleToastPointerUp(event) {
    if (dragState?.pointerId === event.pointerId) {
      dragState = null;
    }
  }

  $effect(() => {
    if (!active) {
      cleanupRevealedContainers();
      updateTutorialCssVars();
      return;
    }
    scheduleSpotlight();
  });

  $effect(() => {
    if (!active || !currentStep) return;
    const stepKey = `${index}:${currentStep.title}`;
    if (preparedStep === stepKey) return;
    preparedStep = stepKey;
    // Record whether an awaitTool step opened with its tool already active, so
    // the auto-advance below doesn't skip a lesson the user hasn't read yet.
    awaitToolPreSatisfied = !!currentStep.awaitTool && appState.currentTool === currentStep.awaitTool;
    currentStep.beforeEnter?.();
    setTimeout(scheduleSpotlight, 80);
  });

  // Auto-advance an `awaitTool` step the instant the user selects the tool it
  // teaches (unless it was already selected as the step opened). This is the
  // "tool tutorials appear when you pick the tool" flow - no forced switching.
  $effect(() => {
    if (!active) return;
    const step = currentStep;
    if (!step?.awaitTool || awaitToolPreSatisfied) return;
    if (appState.currentTool !== step.awaitTool) return;
    const timer = setTimeout(() => {
      if (active && currentStep === step && appState.currentTool === step.awaitTool) next();
    }, 450);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    visibleSteps;
    if (index >= visibleSteps.length) {
      index = Math.max(0, visibleSteps.length - 1);
    }
  });

  onMount(() => {
    window.startTopDrawTutorial = startTutorial;
    window.openTopDrawTutorialPicker = openPicker;
    const interval = setInterval(maybeStart, 1000);
    window.addEventListener('resize', scheduleSpotlight);
    window.addEventListener('scroll', scheduleSpotlight, true);
    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('topdraw:mirror-region-applied', handleMirrorRegionApplied);
    window.addEventListener('topdraw:mirror-region-removed', handleMirrorRegionRemoved);
    mutationObserver = new MutationObserver(scheduleSpotlight);
    mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'class', 'data-tut'] });
    maybeStart();

    return () => {
      clearInterval(interval);
      if (rafId) cancelAnimationFrame(rafId);
      mutationObserver?.disconnect();
      window.removeEventListener('resize', scheduleSpotlight);
      window.removeEventListener('scroll', scheduleSpotlight, true);
      document.removeEventListener('click', handleDocumentClick, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      window.removeEventListener('topdraw:mirror-region-applied', handleMirrorRegionApplied);
      window.removeEventListener('topdraw:mirror-region-removed', handleMirrorRegionRemoved);
      if (window.startTopDrawTutorial === startTutorial) {
        delete window.startTopDrawTutorial;
      }
      if (window.openTopDrawTutorialPicker === openPicker) {
        delete window.openTopDrawTutorialPicker;
      }
    };
  });
</script>

{#if promptVisible}
  <div class="tutorialLayer" role="presentation">
    <div
      class="tutorialToast tutorialPromptToast"
      class:dragged={!!toastPosition}
      style={toastPosition ? `left:${toastPosition.x}px;top:${toastPosition.y}px;transform:none;` : ''}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tutorialPromptTitle"
      tabindex="-1"
      onpointerdown={handleToastPointerDown}
      onpointermove={handleToastPointerMove}
      onpointerup={handleToastPointerUp}
      onpointercancel={handleToastPointerUp}
    >
      <div class="tutorialBody">
        <h2 id="tutorialPromptTitle">DDraw Fundamentals</h2>
        <div class="tutorialTrackList">
          {#each availableSections as section}
            <button type="button" class="tutorialTrack" onclick={() => startTutorial(section.key)}>
              <span class="tutorialTrackLabel">{section.label}</span>
              <span class="tutorialTrackBlurb">{section.blurb}</span>
            </button>
          {/each}
        </div>
      </div>
      <div class="tutorialActions">
        <button type="button" onclick={skipFromPrompt}>No thanks</button>
      </div>
    </div>
  </div>
{/if}

{#if active}
  <div class="tutorialLayer" aria-live="polite">
    {#if rect}
      {#if shouldShowScrim()}
        <div class="tutorialScrim top" class:passthrough={isCanvasUnlocked()} style={`height:${rect.top}px`}></div>
        <div class="tutorialScrim left" class:passthrough={isCanvasUnlocked()} style={`top:${rect.top}px;width:${rect.left}px;height:${rect.height}px`}></div>
        <div class="tutorialScrim right" class:passthrough={isCanvasUnlocked()} style={`top:${rect.top}px;left:${rect.left + rect.width}px;height:${rect.height}px`}></div>
        <div class="tutorialScrim bottom" class:passthrough={isCanvasUnlocked()} style={`top:${rect.top + rect.height}px`}></div>
      {/if}
      <div class="tutorialRing" style={`top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px`}></div>
    {:else}
      <div class="tutorialScrim full" class:passthrough={isCanvasUnlocked()}></div>
    {/if}

    <div
      class="tutorialToast"
      class:dragged={!!toastPosition}
      style={toastPosition
        ? `left:${toastPosition.x}px;top:${toastPosition.y}px;transform:none;`
        : toastAutoBottom != null
          ? `top:auto;bottom:${toastAutoBottom}px;${toastAutoMaxHeight ? `max-height:${toastAutoMaxHeight}px;` : ''}`
          : `top:${toastAutoTop ?? (topbarBottom + 8)}px;${toastAutoMaxHeight ? `max-height:${toastAutoMaxHeight}px;` : ''}`}
      role="dialog"
      tabindex="-1"
      aria-label="Tutorial"
      bind:this={toastEl}
      onpointerdown={handleToastPointerDown}
      onpointermove={handleToastPointerMove}
      onpointerup={handleToastPointerUp}
      onpointercancel={handleToastPointerUp}
    >
      <div class="tutorialSegmentedBar mini">
        {#each availableSections as section}
          <button type="button" class:active={activeSection === section.key} onclick={() => startTutorial(section.key)}>{section.label}</button>
        {/each}
      </div>
      <div class="tutorialProgress" aria-label="Tutorial progress">
        {#each visibleSteps as step, stepIndex}
          <button
            type="button"
            class:active={stepIndex === index}
            class:complete={stepIndex < index}
            title={`${step.section || 'Tutorial'}: ${step.title}`}
            aria-label={`Go to ${step.title}`}
            onclick={() => {
              cleanupStep(currentStep);
              moveToIndex(stepIndex);
            }}
          ></button>
        {/each}
      </div>
      <div class="tutorialBody">
        <span class="tutorialEyebrow">{sectionLabel(currentStep.section)} · {index + 1}/{total}</span>
        <h2>{currentStep.title}</h2>
        <p>{currentStep.text}</p>
        {#if awaitingTool}
          <div class="tutorialHint toolGate">Select the <b>{toolLabel(currentStep.awaitTool)}</b> tool to continue…</div>
        {:else if currentStep.actionLabel && !targetMissing}
          <div class="tutorialHint">{currentStep.actionLabel}</div>
        {:else if targetMissing}
          <div class="tutorialHint">This control is not visible right now. You can press Next.</div>
        {/if}
      </div>
      <div class="tutorialActions">
        <button type="button" onclick={back} disabled={index === 0}>Back</button>
        <button type="button" class="primary" onclick={next}>{index === total - 1 ? (nextFlowSection ? 'Continue' : 'Finish') : 'Next'}</button>
        <button type="button" onclick={stop}>Exit Tutorial</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tutorialLayer {
    position: fixed;
    inset: 0;
    z-index: 100000;
    pointer-events: none;
    font-family: inherit;
  }

  .tutorialPromptToast {
    height: auto;
    z-index: 100001;
  }

  .tutorialSegmentedBar {
    display: flex;
    width: 100%;
    height: 40px;
    margin-top: 12px;
    background: color-mix(in srgb, var(--text-primary, #fff) 5%, transparent);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    overflow: hidden;
    padding: 2px;
    box-sizing: border-box;
  }

  .tutorialSegmentedBar button {
    flex: 1;
    height: 100%;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary, #b7c0ce);
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }

  .tutorialSegmentedBar button:hover {
    background: color-mix(in srgb, var(--text-primary, #fff) 5%, transparent);
    color: var(--text-primary, #f5f7fb);
  }

  .tutorialSegmentedBar button.active {
    background: var(--accent-primary, #00d4aa);
    color: #06120f;
  }

  .tutorialSegmentedBar.mini {
    height: 28px;
    margin-top: -4px;
    margin-bottom: 6px;
    border-radius: 6px;
    padding: 1px;
    border-color: transparent;
    background: color-mix(in srgb, var(--text-primary, #fff) 3%, transparent);
  }

  .tutorialSegmentedBar.mini button {
    font-size: 0.68rem;
    border-radius: 4px;
  }

  .tutorialScrim {
    position: fixed;
    background: rgba(0, 0, 0, 0.56);
    pointer-events: auto;
  }

  .tutorialScrim.passthrough {
    pointer-events: none;
  }

  .tutorialScrim.full,
  .tutorialScrim.top,
  .tutorialScrim.bottom {
    left: 0;
    right: 0;
  }

  .tutorialScrim.full {
    inset: 0;
  }

  .tutorialScrim.left {
    left: 0;
  }

  .tutorialScrim.right {
    right: 0;
  }

  .tutorialScrim.bottom {
    bottom: 0;
  }

  .tutorialRing {
    position: fixed;
    border: 2px solid var(--accent-primary, #00d4aa);
    border-radius: 8px;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-primary, #00d4aa) 22%, transparent), 0 12px 32px rgba(0, 0, 0, 0.28);
    pointer-events: none;
    animation: tutorialRingPulse 1.6s ease-in-out infinite;
  }

  @keyframes tutorialRingPulse {
    0%, 100% {
      box-shadow:
        0 0 0 4px color-mix(in srgb, var(--accent-primary, #00d4aa) 22%, transparent),
        0 0 0 0 color-mix(in srgb, var(--accent-primary, #00d4aa) 0%, transparent),
        0 12px 32px rgba(0, 0, 0, 0.28);
    }
    50% {
      box-shadow:
        0 0 0 6px color-mix(in srgb, var(--accent-primary, #00d4aa) 42%, transparent),
        0 0 0 14px color-mix(in srgb, var(--accent-primary, #00d4aa) 18%, transparent),
        0 12px 32px rgba(0, 0, 0, 0.28);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tutorialRing {
      animation: none;
    }
  }

  .tutorialToast {
    position: fixed;
    top: max(14px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    width: min(440px, calc(100vw - 24px));
    height: auto;
    max-height: min(80vh, 460px);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 10px 12px;
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.16));
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg-secondary, #1f2530) 95%, transparent);
    color: var(--text-primary, #f5f7fb);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.36);
    pointer-events: auto;
    cursor: grab;
    user-select: none;
    touch-action: none;
  }

  .tutorialToast:active {
    cursor: grabbing;
  }

  .tutorialProgress {
    display: flex;
    height: 18px;
    gap: 2px;
    margin: -6px 0 2px;
    align-items: center;
  }

  .tutorialProgress button {
    flex: 1 1 0;
    min-width: 0;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
    position: relative;
  }

  .tutorialProgress button::before {
    content: '';
    position: absolute;
    inset: 6px 0;
    background: color-mix(in srgb, var(--text-primary, #fff) 15%, transparent);
  }

  .tutorialProgress button:first-child {
    border-radius: 999px 0 0 999px;
  }

  .tutorialProgress button:first-child::before {
    border-radius: 999px 0 0 999px;
  }

  .tutorialProgress button:last-child {
    border-radius: 0 999px 999px 0;
  }

  .tutorialProgress button:last-child::before {
    border-radius: 0 999px 999px 0;
  }

  .tutorialProgress button.complete::before {
    background: color-mix(in srgb, var(--accent-primary, #00d4aa) 48%, transparent);
  }

  .tutorialProgress button.active::before {
    background: var(--accent-primary, #00d4aa);
  }

  .tutorialBody {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-right: 2px;
    scrollbar-width: thin;
  }

  .tutorialEyebrow {
    display: block;
    margin-bottom: 2px;
    color: var(--accent-primary, #00d4aa);
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0 0 4px;
    font-size: 0.92rem;
    line-height: 1.2;
  }

  p {
    margin: 0;
    color: var(--text-secondary, #b7c0ce);
    font-size: 0.8rem;
    line-height: 1.28;
  }

  .tutorialHint {
    margin-top: 6px;
    color: var(--text-primary, #f5f7fb);
    font-size: 0.72rem;
    font-weight: 700;
  }

  .tutorialHint.toolGate {
    display: inline-block;
    padding: 4px 9px;
    border-radius: 999px;
    color: var(--accent-primary, #00d4aa);
    background: color-mix(in srgb, var(--accent-primary, #00d4aa) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent-primary, #00d4aa) 38%, transparent);
  }

  .tutorialHint.toolGate b {
    color: var(--text-primary, #f5f7fb);
  }

  /* Picker: vertical list of tracks, each with a blurb. */
  .tutorialTrackList {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
  }

  .tutorialTrack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    height: auto;
    padding: 9px 12px;
    text-align: left;
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.14));
    border-radius: 8px;
    background: color-mix(in srgb, var(--text-primary, #fff) 4%, transparent);
    transition: background 0.18s, border-color 0.18s, transform 0.18s;
  }

  .tutorialTrack:hover {
    background: color-mix(in srgb, var(--accent-primary, #00d4aa) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent-primary, #00d4aa) 45%, transparent);
    transform: translateY(-1px);
  }

  .tutorialTrackLabel {
    font-size: 0.86rem;
    font-weight: 800;
    color: var(--text-primary, #f5f7fb);
  }

  .tutorialTrackBlurb {
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--text-secondary, #b7c0ce);
    line-height: 1.25;
  }

  .tutorialActions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    flex-shrink: 0;
  }

  button {
    min-width: 0;
    height: 30px;
    padding: 0 9px;
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.16));
    border-radius: 6px;
    background: color-mix(in srgb, var(--text-primary, #fff) 7%, transparent);
    color: var(--text-primary, #f5f7fb);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }

  button.primary {
    background: var(--accent-primary, #00d4aa);
    border-color: transparent;
    color: #06120f;
    font-weight: 800;
  }

  .tutorialActions button {
    transition: background 0.15s, border-color 0.15s, transform 0.15s;
  }

  .tutorialActions button:not(:disabled):hover {
    background: color-mix(in srgb, var(--text-primary, #fff) 14%, transparent);
    border-color: color-mix(in srgb, var(--text-primary, #fff) 26%, transparent);
    transform: translateY(-1px);
  }

  .tutorialActions button.primary:not(:disabled):hover {
    background: color-mix(in srgb, var(--accent-primary, #00d4aa) 82%, #fff);
    border-color: transparent;
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  @media (max-width: 640px), (max-height: 640px) {
    .tutorialToast {
      top: max(8px, env(safe-area-inset-top));
      width: min(330px, calc(100vw - 18px));
      height: auto;
      max-height: 78vh;
      padding: 7px 9px;
      border-radius: 7px;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34);
    }

    .tutorialPromptToast {
      height: auto;
    }

    .tutorialSegmentedBar {
      height: 30px;
      margin-top: 8px;
      border-radius: 6px;
      padding: 1px;
    }

    .tutorialSegmentedBar button {
      border-radius: 5px;
      font-size: 0.62rem;
    }

    .tutorialSegmentedBar.mini {
      height: 21px;
      margin-top: -3px;
      margin-bottom: 4px;
      border-radius: 5px;
    }

    .tutorialSegmentedBar.mini button {
      font-size: 0.52rem;
    }

    .tutorialProgress {
      height: 12px;
      gap: 1px;
      margin: -4px 0 1px;
    }

    .tutorialProgress button {
      height: 12px;
    }

    .tutorialProgress button::before {
      inset: 4px 0;
    }

    h2 {
      margin-bottom: 3px;
      font-size: 0.72rem;
      line-height: 1.14;
    }

    p {
      font-size: 0.62rem;
      line-height: 1.2;
    }

    .tutorialHint {
      margin-top: 4px;
      font-size: 0.56rem;
    }

    .tutorialActions {
      gap: 5px;
      margin-top: 5px;
    }

    .tutorialActions button {
      flex: 1 1 0;
      height: 23px;
      padding: 0 5px;
      border-radius: 5px;
      font-size: 0.6rem;
    }

    button {
      height: 23px;
      padding: 0 6px;
      border-radius: 5px;
      font-size: 0.6rem;
    }
  }
</style>
