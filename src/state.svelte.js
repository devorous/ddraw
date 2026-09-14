const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const FLOATING_PALETTE_STORAGE_KEY = 'topdraw_floatingPalettes';
export const FLOATING_PALETTE_SLOT_COUNT = 10;
// Two rows of four in the sidebar grid — the palette is fixed height by design,
// so this cap and the grid's column count have to stay in step.
export const MAX_CUSTOM_COLORS = 8;

class DrawingState {
  // Tool & Drawing
  currentTool = $state('brush');
  currentColor = $state([0, 0, 0, 255]);
  currentSize = $state(10);
  currentToolSettings = $state({});
  currentPressure = $state(1.0);
  pressureEnabled = $state(true);
  blendMode = $state('source-over');
  blendModeLocked = $state(false);
  blendBakeMode = $state('background');
  // True for the duration of an actual local stroke (brush/pen/eraser/etc,
  // not pan/zoom/rotate) — lets hover-driven UI (chat HUD peek) ignore the
  // pointer while it's mid-stroke instead of popping open under it.
  isDrawingStroke = $state(false);

  // Layer
  activeLayer = $state(2);
  layerVisibility = $state({ 0: true, 1: true, 2: true });
  layerManager = $state(null);

  // User
  users = $state(new Map());
  self = $state(null);
  sessionIndex = $state(null);
  selfRole = $state(0);
  selfGlobalRole = $state(0);
  selfRoomRole = $state(0);
  username = $state('');

  // Room
  currentRoomId = $state(null);
  currentRoomData = $state(null);
  roomCreatedByThisBrowser = $state(false);
  connected = $state(false);
  board = $state(null);

  // Chat
  chatUnreadCount = $state(0);
  chatVisible = $state(false);
  dmRecipient = $state(null);

  // Messenger (1-1 E2EE)
  messengerVisible = $state(false);
  messengerTargetUser = $state(null); // { id, name }
  messengerUnreadCount = $state(0);

  // Color Palette
  recentColors = $state([]);
  customColors = $state(loadCustomColors());
  activeCustomPresetKey = $state(null);
  floatingPalettes = $state(loadFloatingPalettes());

  // UI
  boardMenuOpen = $state(null); // null | 'blend' | 'layers'
  profileDialog = $state({ visible: false, username: null, data: null, loading: false, error: null });
  galleryItemDialog = $state({ visible: false, itemId: null, focusComments: false });
  roomSettingsVisible = $state(false);
  appSettingsVisible = $state(false);
  appSettingsTab = $state('general');
  appPreferences = $state(null);
  adminPanelVisible = $state(false);
  ranksDialogVisible = $state(false);
  colorPaletteVisible = $state(true);
  boardColorPickerVisible = $state(true);
  boardColorPickerForceVisible = $state(false);
  recentPaletteVisible = $state(true);
  toolPreviewVisible = $state(false);
  toolPreviewCollapsed = $state(false);
  toolPreviewMode = $state('pattern');
  // Image/pattern selection floating window (below the History button).
  imageSelectorCollapsed = $state(false);
  fillPatternEnabled = $state(false);
  selectionPatternEnabled = $state(false);
  toastState = $state({ text: '', visible: false });
  connectionState = $state({ connected: false, roomId: null, text: '' });

  // Snapshots
  snapshots = $state([]);
  snapshotHasMore = $state(true);
  snapshotListVersion = $state(0);
  snapshotMenuVisible = $state(false);
  // What an empty room comes back up on, as reported by ROOM_START_SNAPSHOT_INFO:
  // { state: 0 none / 1 newest snapshot / 2 pinned, snapshot: SnapshotMeta|null }.
  // null until Room Settings asks for it.
  roomStartSnapshot = $state(null);

  // Session recorder mini viewer
  recorderPanelVisible = $state(false);
  recorderIsRecording = $state(false);
  recorderElapsedMs = $state(0);

  // Derived
  get currentColorRgba() {
    const [r, g, b, a] = this.currentColor;
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
  }

  get currentColorHex() {
    const [r, g, b] = this.currentColor;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  get isModerator() {
    return this.selfRole >= 4;
  }

  /**
   * Whether the user may rewind the board from a replay/history viewer
   * ("Undo to here"). A connected restore broadcasts to everyone, so it's
   * moderator-gated — except when there's no shared board to harm: offline
   * mode, or drawing alone in a room this browser created via "Create a
   * room!" (temp ownership). The solo requirement matches the server gate
   * (snapshots.js canRestoreWholeBoard: Trusted+ or solo occupant) — without
   * it the button appears, the server silently drops the restore, and the
   * replay closes as if it succeeded.
   * (Reads window.app for the non-reactive offline/ownership bits; re-evaluates
   * with selfRole since the viewer is re-mounted each time it opens.)
   */
  get canUndoReplayHistory() {
    if (this.isModerator) return true;
    const app = (typeof window !== 'undefined') ? window.app : null;
    if (!app) return false;
    if (app.isOfflineMode) return true;
    if (this.users.size > 1) return false;
    return app.wasCurrentRoomCreatedByThisBrowser?.() ?? false;
  }

  get userCount() {
    return this.users.size;
  }
}

export const appState = new DrawingState();

// ============================================================================
// Helper functions
// ============================================================================

function colorsEqual(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function normalizeColor(color) {
  if (!Array.isArray(color) || color.length < 4) {
    return null;
  }

  const normalized = color.slice(0, 4).map((value, index) => {
    if (index === 3) {
      return Number.isFinite(value) ? value : 255;
    }

    return Number.isFinite(value) ? value : 0;
  });

  return normalized;
}

function normalizeCustomPreset(item) {
  if (Array.isArray(item)) {
    return { color: [...item], tool: null, size: null, settings: null };
  }

  if (!item || !Array.isArray(item.color)) {
    return null;
  }

  return {
    color: [...item.color],
    tool: item.tool || null,
    size: item.size != null ? item.size : null,
    settings: item.settings && typeof item.settings === 'object' ? { ...item.settings } : null
  };
}

function saveCustomColors() {
  try {
    localStorage.setItem('topdraw_customColors', JSON.stringify(appState.customColors));
  } catch (e) {
    console.warn('Failed to save custom colors:', e);
  }
}

function saveFloatingPalettes() {
  try {
    localStorage.setItem(FLOATING_PALETTE_STORAGE_KEY, JSON.stringify(appState.floatingPalettes));
  } catch (e) {
    console.warn('Failed to save floating palettes:', e);
  }
}

export function getCustomPresetKey(preset) {
  const normalized = normalizeCustomPreset(preset);
  if (!normalized) return null;

  return JSON.stringify({
    color: normalized.color,
    tool: normalized.tool,
    size: normalized.size,
    settings: normalized.settings || null
  });
}

function loadCustomColors() {
  try {
    const saved = localStorage.getItem('topdraw_customColors');
    if (!saved) return [];
    // Trim on load: anyone who already saved more than the cap under the old
    // limit would otherwise keep rendering extra rows forever.
    return JSON.parse(saved)
      .map(normalizeCustomPreset)
      .filter(Boolean)
      .slice(0, MAX_CUSTOM_COLORS);
  } catch (e) {
    console.warn('Failed to load custom colors:', e);
    return [];
  }
}

function normalizeFloatingPalette(item, index = 0) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const colors = Array.isArray(item.colors)
    ? item.colors.map(normalizeColor).filter(Boolean).slice(0, FLOATING_PALETTE_SLOT_COUNT)
    : [];

  return {
    id: typeof item.id === 'string' && item.id ? item.id : `floating-palette-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Palette ${index + 1}`,
    colors,
    visible: item.visible !== false
  };
}

function loadFloatingPalettes() {
  try {
    const saved = localStorage.getItem(FLOATING_PALETTE_STORAGE_KEY);
    if (!saved) return [];

    return JSON.parse(saved).map(normalizeFloatingPalette).filter(Boolean);
  } catch (e) {
    console.warn('Failed to load floating palettes:', e);
    return [];
  }
}

export function addRecentColor(color) {
  appState.recentColors = [
    [...color],
    ...appState.recentColors.filter(c => !colorsEqual(c, color))
  ].slice(0, FLOATING_PALETTE_SLOT_COUNT);
}

export function addCustomColor(color, settings = {}) {
  const tool = settings.tool || null;
  const size = settings.size != null ? settings.size : null;
  const toolSettings = settings.settings && typeof settings.settings === 'object' ? { ...settings.settings } : null;
  const colorlessTools = ['erase', 'blur', 'circleBlur', 'glitchBlur', 'select', 'pan', 'zoom', 'rotate', 'inkdropper'];
  const normalizedColor = colorlessTools.includes(tool) ? [0, 0, 0, 0] : [...color];

  const exists = appState.customColors.some(item => {
    const preset = normalizeCustomPreset(item);
    return preset &&
      colorsEqual(preset.color, normalizedColor) &&
      preset.tool === tool &&
      preset.size === size &&
      JSON.stringify(preset.settings || null) === JSON.stringify(toolSettings || null);
  });

  if (exists || appState.customColors.length >= MAX_CUSTOM_COLORS) return;
  appState.customColors = [...appState.customColors, { color: normalizedColor, tool, size, settings: toolSettings }];
  saveCustomColors();
}

export function addFloatingPalette(name = '') {
  const nextIndex = appState.floatingPalettes.length + 1;
  const palette = {
    id: `floating-palette-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name && name.trim() ? name.trim() : `Palette ${nextIndex}`,
    colors: [],
    visible: true
  };

  appState.floatingPalettes = [...appState.floatingPalettes, palette];
  saveFloatingPalettes();
  return palette;
}

export function addColorToFloatingPalette(paletteId, color, slotIndex = null) {
  const normalizedColor = normalizeColor(color);
  if (!paletteId || !normalizedColor) {
    return null;
  }

  let updatedPalette = null;

  appState.floatingPalettes = appState.floatingPalettes.map((palette) => {
    if (palette.id !== paletteId) {
      return palette;
    }

    const nextColors = palette.colors
      .filter((existingColor) => !colorsEqual(existingColor, normalizedColor));

    if (Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < FLOATING_PALETTE_SLOT_COUNT) {
      nextColors[slotIndex] = [...normalizedColor];
    } else if (nextColors.length < FLOATING_PALETTE_SLOT_COUNT) {
      nextColors.push([...normalizedColor]);
    }

    updatedPalette = {
      ...palette,
      colors: nextColors.slice(0, FLOATING_PALETTE_SLOT_COUNT)
    };

    return updatedPalette;
  });

  if (updatedPalette) {
    saveFloatingPalettes();
  }

  return updatedPalette;
}

export function toggleFloatingPaletteVisibility(paletteId) {
  if (!paletteId) {
    return;
  }

  let didUpdate = false;

  appState.floatingPalettes = appState.floatingPalettes.map((palette) => {
    if (palette.id !== paletteId) {
      return palette;
    }

    didUpdate = true;
    return {
      ...palette,
      visible: palette.visible === false
    };
  });

  if (didUpdate) {
    saveFloatingPalettes();
  }
}

export function setFloatingPaletteVisibility(paletteId, visible) {
  if (!paletteId) {
    return;
  }

  let didUpdate = false;

  appState.floatingPalettes = appState.floatingPalettes.map((palette) => {
    if (palette.id !== paletteId || palette.visible === visible) {
      return palette;
    }

    didUpdate = true;
    return {
      ...palette,
      visible
    };
  });

  if (didUpdate) {
    saveFloatingPalettes();
  }
}

export function removeCustomColor(presetToRemove) {
  const target = normalizeCustomPreset(presetToRemove);
  if (!target) return;

  appState.customColors = appState.customColors.filter(item => {
    const preset = normalizeCustomPreset(item);
    return !preset ||
      !colorsEqual(preset.color, target.color) ||
      preset.tool !== target.tool ||
      preset.size !== target.size ||
      JSON.stringify(preset.settings || null) !== JSON.stringify(target.settings || null);
  });
  saveCustomColors();
}

export function toggleLayerVisibility(layerIndex) {
  appState.layerVisibility = {
    ...appState.layerVisibility,
    [layerIndex]: !appState.layerVisibility[layerIndex]
  };
}

export function showProfile(username) {
  appState.profileDialog = { visible: true, username, data: null, loading: true, error: null };

  const token = (() => { try { return localStorage.getItem('topDrawAuthToken'); } catch { return null; } })();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  fetch(`${API_BASE}/api/users/${encodeURIComponent(username)}`, { headers })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to load profile');
      }
      return data;
    })
    .then(data => {
      appState.profileDialog = { ...appState.profileDialog, loading: false, data };
    })
    .catch((err) => {
      appState.profileDialog = {
        ...appState.profileDialog,
        loading: false,
        error: err?.message || 'Connection error'
      };
    });
}

export function toggleMessenger() {
  appState.messengerVisible = !appState.messengerVisible;
  console.log('Messenger visible:', appState.messengerVisible);
}

export function clearSnapshotHistoryState() {
  const hadSnapshotState = appState.snapshots.length > 0 || !appState.snapshotHasMore;
  appState.snapshots = [];
  appState.snapshotHasMore = true;
  if (hadSnapshotState) {
    appState.snapshotListVersion += 1;
  }
}

export function openSnapshotMenu() {
  appState.snapshotMenuVisible = true;
}

export function closeSnapshotMenu() {
  if (!appState.snapshotMenuVisible) return;
  appState.snapshotMenuVisible = false;
  clearSnapshotHistoryState();
}

export function toggleSnapshotMenu() {
  if (appState.snapshotMenuVisible) {
    closeSnapshotMenu();
    return;
  }

  openSnapshotMenu();
}

export function openRecorderPanel() {
  appState.recorderPanelVisible = true;
}

export function closeRecorderPanel() {
  appState.recorderPanelVisible = false;
}

export function toggleRecorderPanel() {
  appState.recorderPanelVisible = !appState.recorderPanelVisible;
}

export function openMessengerWithUser(id, name) {
  appState.messengerTargetUser = { id, name };
  appState.messengerVisible = true;
}
